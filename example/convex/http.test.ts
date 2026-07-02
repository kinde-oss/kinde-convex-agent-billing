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
import {initConvexTest} from './setup.test.js';

const ISSUER = 'https://acme.kinde.com';
const JWKS_URL = `${ISSUER}/.well-known/jwks`;

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
type JwkRecord = Record<string, string | string[]>;

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

function stubJwks(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === JWKS_URL) {
        return new Response(JSON.stringify({keys: [mainJwk]}), {
          status: 200,
          headers: {'Content-Type': 'application/json'}
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    })
  );
}

async function mint(
  options: {type?: string; jti?: string; key?: SigningKey} = {}
): Promise<string> {
  return await new SignJWT({
    type: options.type ?? 'customer.payment_failed',
    jti: options.jti ?? `evt_${Math.random().toString(36).slice(2)}`
  })
    .setProtectedHeader({alg: 'RS256', kid: 'key-main'})
    .setIssuedAt()
    .setIssuer(ISSUER)
    .sign(options.key ?? mainKey);
}

describe('registerRoutes (mounted by the example app)', () => {
  beforeEach(() => {
    vi.stubEnv('KINDE_ISSUER_URL', ISSUER);
    stubJwks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  test('POST /billing/webhooks/kinde ingests a valid event and returns 200', async () => {
    const t = initConvexTest();
    const res = await t.fetch('/billing/webhooks/kinde', {
      method: 'POST',
      body: await mint({jti: 'evt_1'})
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ok: true, status: 'ingested'});
  });

  test('a duplicate delivery still returns 200 (so Kinde stops retrying)', async () => {
    const t = initConvexTest();
    const token = await mint({jti: 'evt_dup'});
    const first = await t.fetch('/billing/webhooks/kinde', {
      method: 'POST',
      body: token
    });
    expect(first.status).toBe(200);
    const second = await t.fetch('/billing/webhooks/kinde', {
      method: 'POST',
      body: token
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({status: 'duplicate'});
  });

  test('a bad signature returns 401', async () => {
    const t = initConvexTest();
    const res = await t.fetch('/billing/webhooks/kinde', {
      method: 'POST',
      body: await mint({key: rogueKey})
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({code: 'webhook_bad_signature'});
  });

  test('a malformed body returns 400', async () => {
    const t = initConvexTest();
    const res = await t.fetch('/billing/webhooks/kinde', {
      method: 'POST',
      body: 'not-a-jwt'
    });
    expect(res.status).toBe(400);
  });

  test('an empty body returns 400', async () => {
    const t = initConvexTest();
    const res = await t.fetch('/billing/webhooks/kinde', {
      method: 'POST',
      body: ''
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({code: 'invalid_body'});
  });

  test('a verified-but-unsupported event is acknowledged with 200 (no retry)', async () => {
    const t = initConvexTest();
    const res = await t.fetch('/billing/webhooks/kinde', {
      method: 'POST',
      body: await mint({type: 'customer.not_a_billing_event'})
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({status: 'ignored'});
  });

  test('the verifyCaller-gated read route rejects an unauthenticated caller (401)', async () => {
    const t = initConvexTest();
    const res = await t.fetch('/billing-admin/events/recent', {
      method: 'POST',
      body: JSON.stringify({})
    });
    expect(res.status).toBe(401);
  });

  test('the verifyCaller-gated read route returns events for an authenticated caller', async () => {
    const t = initConvexTest();
    // Ingest one event via the webhook route first.
    await t.fetch('/billing/webhooks/kinde', {
      method: 'POST',
      body: await mint({jti: 'evt_seed'})
    });
    const res = await t.fetch('/billing-admin/events/recent', {
      method: 'POST',
      headers: {'X-Caller-Token': 'caller-ok'},
      body: JSON.stringify({limit: 10})
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBeGreaterThanOrEqual(1);
  });

  test('the default webhook mount exposes no events route (seam off by default)', async () => {
    const t = initConvexTest();
    const res = await t.fetch('/billing/events/recent', {
      method: 'POST',
      body: JSON.stringify({})
    });
    // Not mounted without a verifyCaller hook.
    expect(res.status).toBe(404);
  });

  test('events/recent rejects a malformed body with 400', async () => {
    const t = initConvexTest();

    // Non-JSON body.
    const badJson = await t.fetch('/billing-admin/events/recent', {
      method: 'POST',
      headers: {'X-Caller-Token': 'caller-ok'},
      body: 'not-json'
    });
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toMatchObject({code: 'invalid_body'});

    // Wrong-typed limit (string instead of number).
    const badLimit = await t.fetch('/billing-admin/events/recent', {
      method: 'POST',
      headers: {'X-Caller-Token': 'caller-ok'},
      body: JSON.stringify({limit: '10'})
    });
    expect(badLimit.status).toBe(400);
    expect(await badLimit.json()).toMatchObject({code: 'invalid_body'});
  });

  test('events/recent accepts a valid body (including an empty object)', async () => {
    const t = initConvexTest();
    const empty = await t.fetch('/billing-admin/events/recent', {
      method: 'POST',
      headers: {'X-Caller-Token': 'caller-ok'},
      body: JSON.stringify({})
    });
    expect(empty.status).toBe(200);

    const withFilter = await t.fetch('/billing-admin/events/recent', {
      method: 'POST',
      headers: {'X-Caller-Token': 'caller-ok'},
      body: JSON.stringify({eventType: 'customer.payment_failed', limit: 5})
    });
    expect(withFilter.status).toBe(200);
    expect(Array.isArray((await withFilter.json()).events)).toBe(true);
  });
});
