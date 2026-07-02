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
import {api} from './_generated/api.js';
import {expectFail, initConvexTest} from './setup.test.js';

const ISSUER = 'https://acme.kinde.com';
const JWKS_URL = `${ISSUER}/.well-known/jwks`;

type ConvexTest = ReturnType<typeof initConvexTest>;
type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
type JwkRecord = Record<string, string | string[]>;

const EVENT_TYPES = [
  'customer.agreement_created',
  'customer.agreement_cancelled',
  'customer.plan_assigned',
  'customer.plan_changed',
  'customer.payment_succeeded',
  'customer.payment_failed',
  'customer.invoice_overdue',
  'customer.meter_usage_updated'
];

let mainKey: SigningKey;
let rogueKey: SigningKey;
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
  const rogue = await generateKeyPair('RS256', {extractable: true});
  mainKey = main.privateKey;
  rogueKey = rogue.privateKey;
  mainJwk = toJwkRecord(await exportJWK(main.publicKey), 'key-main');
});

function stubJwks(keys: JwkRecord[] = [mainJwk]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === JWKS_URL) {
        return new Response(JSON.stringify({keys}), {
          status: 200,
          headers: {'Content-Type': 'application/json'}
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    })
  );
}

interface MintOptions {
  type?: string;
  jti?: string;
  customerId?: string;
  key?: SigningKey;
  kid?: string;
}

async function mint(options: MintOptions = {}): Promise<string> {
  const claims: Record<string, unknown> = {
    type: options.type ?? 'customer.payment_failed',
    jti: options.jti ?? `evt_${Math.random().toString(36).slice(2)}`
  };
  if (options.customerId !== undefined) {
    claims['data'] = {customer: {id: options.customerId}};
  }
  return await new SignJWT(claims)
    .setProtectedHeader({alg: 'RS256', kid: options.kid ?? 'key-main'})
    .setIssuedAt()
    .setIssuer(ISSUER)
    .sign(options.key ?? mainKey);
}

async function countEvents(t: ConvexTest): Promise<number> {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query('webhookEvents').collect();
    return rows.length;
  });
}

describe('webhooks ingestion', () => {
  beforeEach(() => {
    vi.stubEnv('KINDE_ISSUER_URL', ISSUER);
    stubJwks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  test('happy path: a signed customer.payment_failed verifies, normalizes, ingests', async () => {
    const t = initConvexTest();
    const token = await mint({type: 'customer.payment_failed', jti: 'evt_1'});
    const result = await t.action(api.webhooks.receive, {token});
    expect(result.status).toBe('ingested');

    const event = await t.query(api.webhooks.get, {eventId: result.id});
    expect(event?.eventType).toBe('customer.payment_failed');
    expect(event?.dedupKey).toBe('evt_1');

    const audit = await t.run(async (ctx) =>
      ctx.db
        .query('auditLog')
        .withIndex('by_event_type', (q) =>
          q.eq('eventType', 'webhook.received')
        )
        .collect()
    );
    expect(audit).toHaveLength(1);
    expect(await countEvents(t)).toBe(1);
  });

  test('dedup: the same event ingests once; a retry is a duplicate no-op', async () => {
    const t = initConvexTest();
    const token = await mint({jti: 'evt_dup'});
    const first = await t.action(api.webhooks.receive, {token});
    const second = await t.action(api.webhooks.receive, {token});
    expect(first.status).toBe('ingested');
    expect(second.status).toBe('duplicate');
    expect(second.id).toBe(first.id);
    expect(await countEvents(t)).toBe(1);
  });

  test('bad signature: a JWT signed with the wrong key fails and writes nothing', async () => {
    const t = initConvexTest();
    const token = await mint({key: rogueKey});
    await expectFail(
      t.action(api.webhooks.receive, {token}),
      'webhook_bad_signature'
    );
    expect(await countEvents(t)).toBe(0);
  });

  test('unknown kid: no matching JWKS key fails webhook_unknown_kid', async () => {
    const t = initConvexTest();
    const token = await mint({kid: 'key-not-published'});
    await expectFail(
      t.action(api.webhooks.receive, {token}),
      'webhook_unknown_kid'
    );
    expect(await countEvents(t)).toBe(0);
  });

  test('unknown event type: a verified JWT outside the eight fails, no row', async () => {
    const t = initConvexTest();
    const token = await mint({type: 'customer.something_else'});
    await expectFail(
      t.action(api.webhooks.receive, {token}),
      'webhook_unknown_event'
    );
    expect(await countEvents(t)).toBe(0);
  });

  test('malformed body: a non-JWT token fails webhook_malformed, no row', async () => {
    const t = initConvexTest();
    await expectFail(
      t.action(api.webhooks.receive, {token: 'not-a-jwt'}),
      'webhook_malformed'
    );
    expect(await countEvents(t)).toBe(0);
  });

  test('all eight triggers normalize to their event type', async () => {
    const t = initConvexTest();
    for (const type of EVENT_TYPES) {
      const token = await mint({type, jti: `jti_${type}`});
      const result = await t.action(api.webhooks.receive, {token});
      expect(result.status).toBe('ingested');
      const event = await t.query(api.webhooks.get, {eventId: result.id});
      expect(event?.eventType).toBe(type);
    }
    expect(await countEvents(t)).toBe(EVENT_TYPES.length);
  });

  test('principal linkage: maps customerId to a principal when mapped, else null', async () => {
    const t = initConvexTest();
    await t.mutation(api.kinde.setCustomerMapping, {
      principalType: 'org',
      principalId: 'org_acme',
      customerId: 'cust-1'
    });

    const mapped = await t.action(api.webhooks.receive, {
      token: await mint({jti: 'evt_mapped', customerId: 'cust-1'})
    });
    const mappedEvent = await t.query(api.webhooks.get, {eventId: mapped.id});
    expect(mappedEvent?.principalType).toBe('org');
    expect(mappedEvent?.principalId).toBe('org_acme');

    const unmapped = await t.action(api.webhooks.receive, {
      token: await mint({jti: 'evt_unmapped', customerId: 'cust-unknown'})
    });
    const unmappedEvent = await t.query(api.webhooks.get, {
      eventId: unmapped.id
    });
    expect(unmappedEvent?.principalType).toBeNull();
    expect(unmappedEvent?.principalId).toBeNull();
  });

  test('reactive reads: listForPrincipal and listRecent return ingested events', async () => {
    const t = initConvexTest();
    await t.mutation(api.kinde.setCustomerMapping, {
      principalType: 'org',
      principalId: 'org_acme',
      customerId: 'cust-1'
    });
    await t.action(api.webhooks.receive, {
      token: await mint({
        type: 'customer.payment_succeeded',
        jti: 'evt_a',
        customerId: 'cust-1'
      })
    });
    await t.action(api.webhooks.receive, {
      token: await mint({
        type: 'customer.payment_failed',
        jti: 'evt_b',
        customerId: 'cust-1'
      })
    });

    const forPrincipal = await t.query(api.webhooks.listForPrincipal, {
      principalType: 'org',
      principalId: 'org_acme'
    });
    expect(forPrincipal).toHaveLength(2);
    // Newest first.
    expect(forPrincipal[0].dedupKey).toBe('evt_b');

    const filtered = await t.query(api.webhooks.listForPrincipal, {
      principalType: 'org',
      principalId: 'org_acme',
      eventType: 'customer.payment_failed'
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].dedupKey).toBe('evt_b');

    const recent = await t.query(api.webhooks.listRecent, {limit: 1});
    expect(recent).toHaveLength(1);

    const recentByType = await t.query(api.webhooks.listRecent, {
      eventType: 'customer.payment_succeeded'
    });
    expect(recentByType).toHaveLength(1);
    expect(recentByType[0].dedupKey).toBe('evt_a');
  });

  test('kinde.verifyWebhook returns the narrowed verified fields', async () => {
    const t = initConvexTest();
    const token = await mint({
      type: 'customer.plan_changed',
      jti: 'evt_v',
      customerId: 'cust-9'
    });
    const verified = await t.action(api.kinde.verifyWebhook, {token});
    expect(verified.rawType).toBe('customer.plan_changed');
    expect(verified.dedupKey).toBe('evt_v');
    expect(verified.customerId).toBe('cust-9');
  });

  test('a freshly ingested event starts unprocessed; markProcessed sets it', async () => {
    const t = initConvexTest();
    const {id} = await t.action(api.webhooks.receive, {
      token: await mint({jti: 'evt_p'})
    });
    const before = await t.query(api.webhooks.get, {eventId: id});
    expect(before?.processedAt).toBeNull();

    await t.mutation(api.webhooks.markProcessed, {eventId: id});
    const after = await t.query(api.webhooks.get, {eventId: id});
    expect(after?.processedAt).not.toBeNull();
  });

  test('listForPrincipal constrains eventType before the limit (older matches survive)', async () => {
    const t = initConvexTest();
    // Two matching 'payment_failed' events (older), then several newer
    // 'payment_succeeded' events that would fill a small page first.
    await t.run(async (ctx) => {
      const rows: Array<{eventType: string; receivedAt: number}> = [
        {eventType: 'customer.payment_failed', receivedAt: 1000},
        {eventType: 'customer.payment_failed', receivedAt: 1500},
        {eventType: 'customer.payment_succeeded', receivedAt: 2000},
        {eventType: 'customer.payment_succeeded', receivedAt: 3000},
        {eventType: 'customer.payment_succeeded', receivedAt: 4000},
        {eventType: 'customer.payment_succeeded', receivedAt: 5000}
      ];
      for (const row of rows) {
        await ctx.db.insert('webhookEvents', {
          eventType: row.eventType,
          rawType: row.eventType,
          dedupKey: `evt_${row.receivedAt}`,
          principalType: 'user',
          principalId: 'user_alice',
          customerId: null,
          payload: {},
          receivedAt: row.receivedAt,
          processedAt: null
        });
      }
    });

    // With a small limit, the older matching events must still be returned.
    const failed = await t.query(api.webhooks.listForPrincipal, {
      principalType: 'user',
      principalId: 'user_alice',
      eventType: 'customer.payment_failed',
      limit: 2
    });
    expect(failed.map((r) => r.receivedAt)).toEqual([1500, 1000]);

    const newest = await t.query(api.webhooks.listForPrincipal, {
      principalType: 'user',
      principalId: 'user_alice',
      eventType: 'customer.payment_failed',
      limit: 1
    });
    expect(newest.map((r) => r.receivedAt)).toEqual([1500]);
  });
});
