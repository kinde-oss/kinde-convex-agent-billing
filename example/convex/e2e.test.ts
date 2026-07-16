import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi
} from 'vitest';
import {SignJWT, exportJWK, generateKeyPair} from 'jose';
import type {JWK} from 'jose';
import {ConvexError} from 'convex/values';
import type {Value} from 'convex/values';
import {api} from './_generated/api.js';
import {initConvexTest} from './setup.test.js';

const ISSUER = 'https://acme.kinde.com';
const TOKEN_URL = `${ISSUER}/oauth2/token`;
const AGREEMENTS_URL = `${ISSUER}/api/v1/billing/agreements`;
const ENTITLEMENTS_PREFIX = `${ISSUER}/api/v1/billing/entitlements`;
const JWKS_URL = `${ISSUER}/.well-known/jwks`;
const HOUR = 60 * 60 * 1000;

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
type JwkRecord = Record<string, string | string[]>;

let mainKey: SigningKey;
let mainJwk: JwkRecord;

function toJwkRecord(jwk: JWK, kid: string): JwkRecord {
  const record: JwkRecord = {kid, alg: 'RS256', use: 'sig'};
  for (const [member, value] of Object.entries(jwk)) {
    if (typeof value === 'string') {
      record[member] = value;
    }
  }
  return record;
}

beforeAll(async () => {
  const main = await generateKeyPair('RS256', {extractable: true});
  mainKey = main.privateKey;
  mainJwk = toJwkRecord(await exportJWK(main.publicKey), 'key-main');
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json'}
  });
}

/**
 * Route every Kinde call to a local mock: the M2M token endpoint, the JWKS, a
 * single-page entitlements response, and the agreements (plan change) endpoint.
 * NO live Kinde calls.
 */
function stubKinde(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === TOKEN_URL) {
        return jsonResponse({access_token: 'tok-123', expires_in: 3600});
      }
      if (url === JWKS_URL) {
        return jsonResponse({keys: [mainJwk]});
      }
      if (url.startsWith(ENTITLEMENTS_PREFIX)) {
        return jsonResponse({
          entitlements: [
            {
              id: 'e1',
              feature_code: 'tokens',
              entitlement_limit_max: 1000,
              consumed: 0
            }
          ],
          has_more: false
        });
      }
      if (url === AGREEMENTS_URL) {
        return jsonResponse({id: 'agr-2'});
      }
      throw new Error(`Unexpected fetch: ${url}`);
    })
  );
}

async function mintWebhook(
  type: string,
  jti: string,
  customerId: string
): Promise<string> {
  return await new SignJWT({type, jti, data: {customer: {id: customerId}}})
    .setProtectedHeader({alg: 'RS256', kid: 'key-main'})
    .setIssuedAt()
    .setIssuer(ISSUER)
    .sign(mainKey);
}

async function expectFail(
  promise: Promise<unknown>,
  code: string
): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error, `expected ConvexError with code "${code}"`).toBeInstanceOf(
    ConvexError
  );
  const raw = (error as ConvexError<Value>).data;
  const data = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  expect((data as {code: string}).code).toBe(code);
}

describe('end-to-end billing lifecycle', () => {
  beforeEach(() => {
    vi.stubEnv('KINDE_ISSUER_URL', ISSUER);
    vi.stubEnv('KINDE_M2M_CLIENT_ID', 'client-id');
    vi.stubEnv('KINDE_M2M_CLIENT_SECRET', 'client-secret');
    vi.stubEnv('MANDATE_SIGNING_SECRET', 'test-mandate-secret');
    vi.stubEnv('MODE', 'live');
    stubKinde();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  test('agent spend: map → sync entitlement → mandate → meter → exceed → revoke', async () => {
    const t = initConvexTest();

    // 1. Map the org to its Kinde customer and sync the entitlement, which
    //    hydrates a kinde-source budget the spine reads.
    await t.mutation(api.example.setKindeCustomer, {
      principalType: 'org',
      principalId: 'org_acme',
      customerId: 'cust-1',
      customerAgreementId: 'agr-1'
    });
    const sync = await t.action(api.example.syncEntitlements, {
      principalType: 'org',
      principalId: 'org_acme',
      unit: 'tokens',
      billingFeatureCode: 'tokens'
    });
    expect(sync).toEqual({found: true, remaining: 1000, limit: 1000});

    const budget = await t.query(api.example.getBudget, {
      principalType: 'org',
      principalId: 'org_acme',
      unit: 'tokens'
    });
    expect(budget?.source).toBe('kinde');
    expect(budget?.remaining).toBe(1000);

    // 2. Mint a mandate capping the agent's spend at 100.
    const mandateId = await t.mutation(api.example.mintMandate, {
      principalType: 'org',
      principalId: 'org_acme',
      agentSubject: 'agent_bot',
      unit: 'tokens',
      scope: ['chat.completions'],
      budgetCap: 100,
      notAfter: Date.now() + HOUR
    });

    // 3. Meter 30 under the mandate: the budget AND the mandate both drop.
    const applied = await t.mutation(api.example.recordUsage, {
      principalType: 'org',
      principalId: 'org_acme',
      unit: 'tokens',
      quantity: 30,
      idempotencyKey: 'k1',
      mandateId,
      callerAgentSubject: 'agent_bot'
    });
    expect(applied).toMatchObject({status: 'applied', remaining: 970});

    // 4. The gate reflects the live remaining.
    const decision = await t.mutation(api.example.checkSpend, {
      principalType: 'org',
      principalId: 'org_acme',
      unit: 'tokens',
      requested: 500
    });
    expect(decision).toMatchObject({decision: 'allow', remaining: 970});

    // 5. A spend over the mandate's remaining (70) fails — even though the
    //    principal budget (970) has room.
    await expectFail(
      t.mutation(api.example.recordUsage, {
        principalType: 'org',
        principalId: 'org_acme',
        unit: 'tokens',
        quantity: 80,
        idempotencyKey: 'k2',
        mandateId,
        callerAgentSubject: 'agent_bot'
      }),
      'mandate_budget_exceeded'
    );

    // 6. Revoke the mandate; the next spend fails reactively, budget untouched.
    await t.mutation(api.example.revokeMandate, {mandateId, reason: 'leaked'});
    await expectFail(
      t.mutation(api.example.recordUsage, {
        principalType: 'org',
        principalId: 'org_acme',
        unit: 'tokens',
        quantity: 10,
        idempotencyKey: 'k3',
        mandateId,
        callerAgentSubject: 'agent_bot'
      }),
      'mandate_revoked'
    );
    const after = await t.query(api.example.getBudget, {
      principalType: 'org',
      principalId: 'org_acme',
      unit: 'tokens'
    });
    expect(after?.remaining).toBe(970);

    // 7. The audit trail records every layer's event.
    const audit = await t.query(api.example.recentAudit, {
      paginationOpts: {numItems: 50, cursor: null},
      principalType: 'org',
      principalId: 'org_acme'
    });
    const types = new Set(audit.page.map((row) => row.eventType));
    expect(types.has('kinde.customer_mapped')).toBe(true);
    expect(types.has('kinde.entitlements_synced')).toBe(true);
    expect(types.has('mandate.minted')).toBe(true);
    expect(types.has('usage.recorded')).toBe(true);
    expect(types.has('billing.decision')).toBe(true);
    expect(types.has('mandate.revoked')).toBe(true);
    expect(
      audit.page.every((row) => typeof row.correlationId === 'string')
    ).toBe(true);
  });

  test('transaction with approval: request → execute(blocked) → approve → execute → refund', async () => {
    const t = initConvexTest();
    await t.mutation(api.example.setKindeCustomer, {
      principalType: 'org',
      principalId: 'org_acme',
      customerId: 'cust-1',
      customerAgreementId: 'agr-1'
    });
    await t.mutation(api.example.setTransactionPolicy, {
      principalType: 'org',
      principalId: 'org_acme',
      requireApproval: true
    });

    const txId = await t.mutation(api.example.requestTransaction, {
      principalType: 'org',
      principalId: 'org_acme',
      type: 'plan_change',
      planCode: 'pro'
    });
    expect(
      (await t.query(api.example.getTransaction, {transactionId: txId}))?.status
    ).toBe('pending');

    // Execute before approval is blocked.
    await expectFail(
      t.action(api.example.executeTransaction, {transactionId: txId}),
      'not_approved'
    );

    await t.mutation(api.example.approveTransaction, {
      transactionId: txId,
      approverSubject: 'admin_1'
    });
    const executed = await t.action(api.example.executeTransaction, {
      transactionId: txId
    });
    expect(executed.status).toBe('executed');
    expect(
      (await t.query(api.example.getTransaction, {transactionId: txId}))?.status
    ).toBe('executed');

    // Compensate it.
    await t.mutation(api.example.refundTransaction, {
      transactionId: txId,
      reason: 'customer changed their mind'
    });
    expect(
      (await t.query(api.example.getTransaction, {transactionId: txId}))?.status
    ).toBe('compensated');
  });

  test('webhook: a signed event ingests via the mounted route and is reactive; retry is idempotent', async () => {
    const t = initConvexTest();
    await t.mutation(api.example.setKindeCustomer, {
      principalType: 'org',
      principalId: 'org_acme',
      customerId: 'cust-1',
      customerAgreementId: 'agr-1'
    });

    const token = await mintWebhook(
      'customer.payment_failed',
      'evt_1',
      'cust-1'
    );
    const res = await t.fetch('/billing/webhooks/kinde', {
      method: 'POST',
      body: token
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ok: true, status: 'ingested'});

    // The reactive read the app subscribes to surfaces the event, linked to the
    // principal via the customer mapping.
    const events = await t.query(api.example.listWebhookEvents, {
      principalType: 'org',
      principalId: 'org_acme'
    });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('customer.payment_failed');
    expect(events[0].principalId).toBe('org_acme');

    // A duplicate delivery is idempotent and still returns 200.
    const retry = await t.fetch('/billing/webhooks/kinde', {
      method: 'POST',
      body: token
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({status: 'duplicate'});

    const stillOne = await t.query(api.example.listWebhookEvents, {
      principalType: 'org',
      principalId: 'org_acme'
    });
    expect(stillOne).toHaveLength(1);
  });
});
