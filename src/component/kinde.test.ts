import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {api} from './_generated/api.js';
import {expectFail, initConvexTest} from './setup.test.js';

const ISSUER = 'https://acme.kinde.com';
const TOKEN_URL = `${ISSUER}/oauth2/token`;
const METER_URL = `${ISSUER}/api/v1/billing/meter_usage`;
const AGREEMENTS_URL = `${ISSUER}/api/v1/billing/agreements`;
const ENTITLEMENTS_PREFIX = `${ISSUER}/api/v1/billing/entitlements`;

type ConvexTest = ReturnType<typeof initConvexTest>;

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json'}
  });
}

/**
 * Install a fetch mock that routes by URL and records every call. The token
 * endpoint always succeeds unless `routes` overrides it.
 */
function mockFetch(
  routes: (url: string, init: RequestInit | undefined) => Response | undefined
): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({url, init});
      const override = routes(url, init);
      if (override !== undefined) {
        return override;
      }
      if (url === TOKEN_URL) {
        return jsonResponse({access_token: 'tok-123', expires_in: 3600});
      }
      throw new Error(`Unexpected fetch: ${url}`);
    })
  );
  return calls;
}

function stubEnv(mode?: 'test' | 'live'): void {
  vi.stubEnv('MANDATE_SIGNING_SECRET', 'test-mandate-secret');
  vi.stubEnv('KINDE_ISSUER_URL', ISSUER);
  vi.stubEnv('KINDE_M2M_CLIENT_ID', 'client-id');
  vi.stubEnv('KINDE_M2M_CLIENT_SECRET', 'client-secret');
  if (mode !== undefined) {
    vi.stubEnv('MODE', mode);
  }
}

async function mapCustomer(
  t: ConvexTest,
  agreementId: string | null = 'agr-1'
): Promise<void> {
  await t.mutation(api.kinde.setCustomerMapping, {
    principalType: 'org',
    principalId: 'org_acme',
    customerId: 'cust-1',
    customerAgreementId: agreementId
  });
}

describe('kinde integration', () => {
  beforeEach(() => {
    // HARDENING: stub every required env var.
    stubEnv('live');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  test('getAccessToken caches, reuses before expiry, and refetches after', async () => {
    const calls = mockFetch(() => undefined);
    const t = initConvexTest();

    const first = await t.action(api.kinde.getAccessToken, {});
    expect(first).toBe('tok-123');
    const tokenCalls = () => calls.filter((c) => c.url === TOKEN_URL).length;
    expect(tokenCalls()).toBe(1);

    // Second call reuses the cache — no new token fetch.
    await t.action(api.kinde.getAccessToken, {});
    expect(tokenCalls()).toBe(1);

    // Expire the cached token; the next call refetches.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('kindeTokenCache')
        .withIndex('by_key', (q) => q.eq('key', 'm2m'))
        .unique();
      if (row !== null) {
        await ctx.db.patch('kindeTokenCache', row._id, {expiresAt: Date.now()});
      }
    });
    await t.action(api.kinde.getAccessToken, {});
    expect(tokenCalls()).toBe(2);
  });

  test('test mode returns a stub token without any fetch', async () => {
    stubEnv('test');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const t = initConvexTest();
    const token = await t.action(api.kinde.getAccessToken, {});
    expect(token).toBe('test-mode-stub-token');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('a non-JSON token body yields a typed kinde_response_malformed fail', async () => {
    mockFetch((url) =>
      url === TOKEN_URL
        ? new Response('<html>error</html>', {
            status: 200,
            headers: {'Content-Type': 'text/html'}
          })
        : undefined
    );
    const t = initConvexTest();
    await expectFail(
      t.action(api.kinde.getAccessToken, {}),
      'kinde_response_malformed'
    );
  });

  test('a not-ok token response yields a typed fail carrying the status', async () => {
    mockFetch((url) =>
      url === TOKEN_URL ? jsonResponse({error: 'nope'}, 503) : undefined
    );
    const t = initConvexTest();
    await expectFail(
      t.action(api.kinde.getAccessToken, {}),
      'kinde_token_fetch_failed'
    );
  });

  test('resolveMode: an invalid MODE fails; unset defaults to live (fetches)', async () => {
    vi.stubEnv('MODE', 'staging');
    const t = initConvexTest();
    await expectFail(t.action(api.kinde.getAccessToken, {}), 'invalid_mode');

    // Unset MODE -> defaults to live, so the token endpoint is called.
    vi.stubEnv('MODE', undefined);
    const calls = mockFetch(() => undefined);
    expect(await t.action(api.kinde.getAccessToken, {})).toBe('tok-123');
    expect(calls.some((c) => c.url === TOKEN_URL)).toBe(true);
  });

  test('pushUsage posts meter_usage with delta type, Idempotency-Key, and the agreement id', async () => {
    const calls = mockFetch((url) =>
      url === METER_URL ? jsonResponse({ok: true}) : undefined
    );
    const t = initConvexTest();
    await mapCustomer(t);

    const result = await t.action(api.kinde.pushUsage, {
      principalType: 'org',
      principalId: 'org_acme',
      billingFeatureCode: 'tokens',
      meterValue: 42,
      idempotencyKey: 'idem-1'
    });
    expect(result.reported).toBe(true);

    const meterCall = calls.find((c) => c.url === METER_URL);
    expect(meterCall).toBeDefined();
    const headers = meterCall?.init?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('idem-1');
    expect(headers['Authorization']).toBe('Bearer tok-123');
    const body = JSON.parse(String(meterCall?.init?.body)) as Record<
      string,
      unknown
    >;
    expect(body['meter_type_code']).toBe('delta');
    expect(body['meter_value']).toBe('42');
    expect(body['customer_agreement_id']).toBe('agr-1');
    expect(body['billing_feature_code']).toBe('tokens');
  });

  test('pushUsage fails customer_mapping_missing when unmapped', async () => {
    mockFetch(() => undefined);
    const t = initConvexTest();
    await expectFail(
      t.action(api.kinde.pushUsage, {
        principalType: 'org',
        principalId: 'org_acme',
        billingFeatureCode: 'tokens',
        meterValue: 1,
        idempotencyKey: 'idem-1'
      }),
      'customer_mapping_missing'
    );
  });

  test('pushUsage fails agreement_missing when the mapping has no agreement', async () => {
    mockFetch(() => undefined);
    const t = initConvexTest();
    await mapCustomer(t, null);
    await expectFail(
      t.action(api.kinde.pushUsage, {
        principalType: 'org',
        principalId: 'org_acme',
        billingFeatureCode: 'tokens',
        meterValue: 1,
        idempotencyKey: 'idem-1'
      }),
      'agreement_missing'
    );
  });

  test('syncEntitlements hydrates a kinde-source budget that gate.check then reads', async () => {
    mockFetch((url) =>
      url.startsWith(ENTITLEMENTS_PREFIX)
        ? jsonResponse({
            entitlements: [
              {id: 'e1', feature_code: 'images', entitlement_limit_max: 5},
              {
                id: 'e2',
                feature_code: 'tokens',
                entitlement_limit_max: 1000,
                consumed: 200
              }
            ],
            has_more: false
          })
        : undefined
    );
    const t = initConvexTest();
    await mapCustomer(t);

    const result = await t.action(api.kinde.syncEntitlements, {
      principalType: 'org',
      principalId: 'org_acme',
      unit: 'tokens',
      billingFeatureCode: 'tokens'
    });
    expect(result).toEqual({found: true, remaining: 800, limit: 1000});

    // The hydrated budget is source 'kinde' and readable by the spine.
    const budget = await t.query(api.budgets.get, {
      principalType: 'org',
      principalId: 'org_acme',
      unit: 'tokens'
    });
    expect(budget?.source).toBe('kinde');
    expect(budget?.remaining).toBe(800);

    // gate.check reads the hydrated budget.
    const decision = await t.mutation(api.enforce.check, {
      principalType: 'org',
      principalId: 'org_acme',
      unit: 'tokens',
      requested: 500
    });
    expect(decision.decision).toBe('allow');
  });

  test('syncEntitlements maps a null limit to the unlimited sentinel', async () => {
    mockFetch((url) =>
      url.startsWith(ENTITLEMENTS_PREFIX)
        ? jsonResponse({
            entitlements: [
              {
                id: 'e1',
                feature_code: 'tokens',
                entitlement_limit_max: null,
                consumed: 10
              }
            ],
            has_more: false
          })
        : undefined
    );
    const t = initConvexTest();
    await mapCustomer(t);

    const result = await t.action(api.kinde.syncEntitlements, {
      principalType: 'org',
      principalId: 'org_acme',
      unit: 'tokens',
      billingFeatureCode: 'tokens'
    });
    expect(result.limit).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.remaining).toBe(Number.MAX_SAFE_INTEGER - 10);
  });

  test('syncEntitlements paginates until the feature is found', async () => {
    let call = 0;
    mockFetch((url) => {
      if (!url.startsWith(ENTITLEMENTS_PREFIX)) {
        return undefined;
      }
      call++;
      if (call === 1) {
        return jsonResponse({
          entitlements: [
            {id: 'e1', feature_code: 'images', entitlement_limit_max: 5}
          ],
          has_more: true
        });
      }
      return jsonResponse({
        entitlements: [
          {id: 'e2', feature_code: 'tokens', entitlement_limit_max: 50}
        ],
        has_more: false
      });
    });
    const t = initConvexTest();
    await mapCustomer(t);

    const result = await t.action(api.kinde.syncEntitlements, {
      principalType: 'org',
      principalId: 'org_acme',
      unit: 'tokens',
      billingFeatureCode: 'tokens'
    });
    expect(result).toEqual({found: true, remaining: 50, limit: 50});
  });

  test('field narrowing: extra/missing fields are tolerated without throwing', async () => {
    mockFetch((url) =>
      url.startsWith(ENTITLEMENTS_PREFIX)
        ? jsonResponse({
            entitlements: [
              {
                id: 'e2',
                feature_code: 'tokens',
                entitlement_limit_max: 30,
                surprise_field: {nested: true},
                consumed: 'not-a-number'
              }
            ],
            has_more: false,
            unexpected: 'ignored'
          })
        : undefined
    );
    const t = initConvexTest();
    await mapCustomer(t);

    // consumed is non-numeric -> treated as 0; remaining = limit.
    const result = await t.action(api.kinde.syncEntitlements, {
      principalType: 'org',
      principalId: 'org_acme',
      unit: 'tokens',
      billingFeatureCode: 'tokens'
    });
    expect(result).toEqual({found: true, remaining: 30, limit: 30});
  });

  test('changePlan posts customer_id + plan_code with flags and audits', async () => {
    const calls = mockFetch((url) =>
      url === AGREEMENTS_URL ? jsonResponse({id: 'agr-2'}) : undefined
    );
    const t = initConvexTest();
    await mapCustomer(t);

    const result = await t.action(api.kinde.changePlan, {
      principalType: 'org',
      principalId: 'org_acme',
      planCode: 'pro',
      isProrate: true,
      isInvoiceNow: false
    });
    expect(result.changed).toBe(true);

    const planCall = calls.find((c) => c.url === AGREEMENTS_URL);
    const body = JSON.parse(String(planCall?.init?.body)) as Record<
      string,
      unknown
    >;
    expect(body['customer_id']).toBe('cust-1');
    expect(body['plan_code']).toBe('pro');
    expect(body['is_prorate']).toBe(true);
    expect(body['is_invoice_now']).toBe(false);

    const audit = await t.run(async (ctx) =>
      ctx.db
        .query('auditLog')
        .withIndex('by_event_type', (q) =>
          q.eq('eventType', 'kinde.plan_changed')
        )
        .collect()
    );
    expect(audit).toHaveLength(1);
  });

  test('test mode skips the network for pushUsage and changePlan', async () => {
    stubEnv('test');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const t = initConvexTest();
    await mapCustomer(t);

    expect(
      await t.action(api.kinde.pushUsage, {
        principalType: 'org',
        principalId: 'org_acme',
        billingFeatureCode: 'tokens',
        meterValue: 1,
        idempotencyKey: 'idem-1'
      })
    ).toEqual({reported: false});
    expect(
      await t.action(api.kinde.changePlan, {
        principalType: 'org',
        principalId: 'org_acme',
        planCode: 'pro'
      })
    ).toEqual({changed: false});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('setCustomerMapping upserts and audits', async () => {
    mockFetch(() => undefined);
    const t = initConvexTest();
    const first = await t.mutation(api.kinde.setCustomerMapping, {
      principalType: 'org',
      principalId: 'org_acme',
      customerId: 'cust-1'
    });
    const second = await t.mutation(api.kinde.setCustomerMapping, {
      principalType: 'org',
      principalId: 'org_acme',
      customerId: 'cust-2',
      customerAgreementId: 'agr-9'
    });
    expect(second).toBe(first);

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query('kindeCustomers')
        .withIndex('by_principal', (q) =>
          q.eq('principalType', 'org').eq('principalId', 'org_acme')
        )
        .collect()
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].customerId).toBe('cust-2');
    expect(rows[0].customerAgreementId).toBe('agr-9');
  });
});
