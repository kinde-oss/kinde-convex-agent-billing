import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import type {Id} from './_generated/dataModel.js';
import {api} from './_generated/api.js';
import {intersectMandate, signMandate} from './mandates.js';
import {expectFail, initConvexTest} from './setup.test.js';

const SECRET = 'test-mandate-secret';
const HOUR = 60 * 60 * 1000;

type ConvexTest = ReturnType<typeof initConvexTest>;

async function mintMandate(t: ConvexTest): Promise<Id<'mandates'>> {
  return await t.mutation(api.mandates.mint, {
    principalType: 'user',
    principalId: 'user_alice',
    agentSubject: 'agent_bot',
    unit: 'tokens',
    scope: ['chat.completions'],
    budgetCap: 100,
    notAfter: Date.now() + HOUR
  });
}

describe('mandates', () => {
  beforeEach(() => {
    // HARDENING: stub every required env var in each test setup.
    vi.stubEnv('MANDATE_SIGNING_SECRET', SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('mint signs a mandate that verify and get read back', async () => {
    const t = initConvexTest();
    const mandateId = await mintMandate(t);

    const stored = await t.query(api.mandates.get, {mandateId});
    expect(stored?.agentSubject).toBe('agent_bot');
    expect(stored?.budgetSpent).toBe(0);
    expect(stored?.revokedAt).toBeNull();
    expect(stored?.signature).toMatch(/^[0-9a-f]{64}$/);

    expect(await t.query(api.mandates.verify, {mandateId})).toEqual({
      valid: true
    });
  });

  test('a tampered field fails signature verification before any state check', async () => {
    const t = initConvexTest();
    const mandateId = await mintMandate(t);
    // Widen the budget cap without re-signing — the integrity check must catch
    // it before expiry/revocation logic runs.
    await t.run(async (ctx) =>
      ctx.db.patch('mandates', mandateId, {budgetCap: 1000})
    );

    expect(await t.query(api.mandates.verify, {mandateId})).toEqual({
      valid: false,
      code: 'bad_signature',
      reason: 'The mandate signature does not match its contents.'
    });
  });

  test('not_yet_valid: notBefore in the future', async () => {
    const t = initConvexTest();
    const now = Date.now();
    const core = {
      principalType: 'user' as const,
      principalId: 'user_alice',
      orgCode: null,
      agentSubject: 'agent_bot',
      unit: 'tokens',
      scope: ['chat.completions'],
      budgetCap: 100,
      notBefore: now + HOUR,
      notAfter: now + 2 * HOUR
    };
    const signature = await signMandate(SECRET, core);
    const mandateId = await t.run(
      async (ctx) =>
        await ctx.db.insert('mandates', {
          ...core,
          budgetSpent: 0,
          revokedAt: null,
          signature,
          createdAt: now
        })
    );

    expect(await t.query(api.mandates.verify, {mandateId})).toEqual({
      valid: false,
      code: 'not_yet_valid',
      reason: 'The mandate is not yet valid.'
    });
  });

  test('expired: notAfter in the past', async () => {
    const t = initConvexTest();
    const now = Date.now();
    const core = {
      principalType: 'user' as const,
      principalId: 'user_alice',
      orgCode: null,
      agentSubject: 'agent_bot',
      unit: 'tokens',
      scope: ['chat.completions'],
      budgetCap: 100,
      notBefore: now - 2 * HOUR,
      notAfter: now - HOUR
    };
    const signature = await signMandate(SECRET, core);
    const mandateId = await t.run(
      async (ctx) =>
        await ctx.db.insert('mandates', {
          ...core,
          budgetSpent: 0,
          revokedAt: null,
          signature,
          createdAt: now
        })
    );

    expect(await t.query(api.mandates.verify, {mandateId})).toEqual({
      valid: false,
      code: 'expired',
      reason: 'The mandate has expired.'
    });
  });

  test('revoke makes verify report revoked and is idempotent', async () => {
    const t = initConvexTest();
    const mandateId = await mintMandate(t);

    await t.mutation(api.mandates.revoke, {mandateId, reason: 'leaked'});
    expect(await t.query(api.mandates.verify, {mandateId})).toEqual({
      valid: false,
      code: 'revoked',
      reason: 'The mandate has been revoked.'
    });

    const first = await t.run(async (ctx) => {
      const row = await ctx.db.get('mandates', mandateId);
      return row?.revokedAt ?? null;
    });
    // A second revoke is a no-op and does not move the timestamp.
    await t.mutation(api.mandates.revoke, {mandateId});
    const second = await t.run(async (ctx) => {
      const row = await ctx.db.get('mandates', mandateId);
      return row?.revokedAt ?? null;
    });
    expect(second).toBe(first);
  });

  test('verify reports not_found for a dangling id', async () => {
    const t = initConvexTest();
    const mandateId = await mintMandate(t);
    await t.run(async (ctx) => ctx.db.delete('mandates', mandateId));
    expect(await t.query(api.mandates.verify, {mandateId})).toEqual({
      valid: false,
      code: 'not_found',
      reason: 'No such mandate.'
    });
  });

  test('listForPrincipal and listForAgent scope to their key', async () => {
    const t = initConvexTest();
    await mintMandate(t);
    await t.mutation(api.mandates.mint, {
      principalType: 'org',
      principalId: 'org_acme',
      agentSubject: 'agent_other',
      unit: 'tokens',
      scope: ['chat.completions'],
      budgetCap: 10,
      notAfter: Date.now() + HOUR
    });

    const forPrincipal = await t.query(api.mandates.listForPrincipal, {
      principalType: 'user',
      principalId: 'user_alice'
    });
    expect(forPrincipal).toHaveLength(1);
    expect(forPrincipal[0].principalId).toBe('user_alice');

    const forAgent = await t.query(api.mandates.listForAgent, {
      agentSubject: 'agent_bot'
    });
    expect(forAgent).toHaveLength(1);
    expect(forAgent[0].agentSubject).toBe('agent_bot');
  });

  test('mint guards: invalid_budget, invalid_window, empty_scope', async () => {
    const t = initConvexTest();
    const now = Date.now();
    await expectFail(
      t.mutation(api.mandates.mint, {
        principalType: 'user',
        principalId: 'user_alice',
        agentSubject: 'agent_bot',
        unit: 'tokens',
        scope: ['chat.completions'],
        budgetCap: 0,
        notAfter: now + HOUR
      }),
      'invalid_budget'
    );
    await expectFail(
      t.mutation(api.mandates.mint, {
        principalType: 'user',
        principalId: 'user_alice',
        agentSubject: 'agent_bot',
        unit: 'tokens',
        scope: ['chat.completions'],
        budgetCap: 100,
        notBefore: now + HOUR,
        notAfter: now + HOUR
      }),
      'invalid_window'
    );
    await expectFail(
      t.mutation(api.mandates.mint, {
        principalType: 'user',
        principalId: 'user_alice',
        agentSubject: 'agent_bot',
        unit: 'tokens',
        scope: [],
        budgetCap: 100,
        notAfter: now + HOUR
      }),
      'empty_scope'
    );
  });

  test('a mandate signed with a different secret fails verification', async () => {
    const t = initConvexTest();
    const now = Date.now();
    const core = {
      principalType: 'user' as const,
      principalId: 'user_alice',
      orgCode: null,
      agentSubject: 'agent_bot',
      unit: 'tokens',
      scope: ['chat.completions'],
      budgetCap: 100,
      notBefore: now,
      notAfter: now + HOUR
    };
    const signature = await signMandate('the-wrong-secret', core);
    const mandateId = await t.run(
      async (ctx) =>
        await ctx.db.insert('mandates', {
          ...core,
          budgetSpent: 0,
          revokedAt: null,
          signature,
          createdAt: now
        })
    );

    expect(await t.query(api.mandates.verify, {mandateId})).toMatchObject({
      valid: false,
      code: 'bad_signature'
    });
  });
});

describe('intersectMandate (pure attenuation)', () => {
  test('narrows scope to the intersection and budget to the min', () => {
    const result = intersectMandate(['a', 'b', 'c'], 100, ['b', 'c', 'd'], 40);
    expect(result.scope).toEqual(['b', 'c']);
    expect(result.budget).toBe(40);
  });

  test('cannot widen scope or budget beyond the parent', () => {
    const result = intersectMandate(['a', 'b'], 30, ['a', 'b', 'x', 'y'], 999);
    // Child lists more scopes and a bigger budget; the result stays within the
    // parent on both axes.
    expect(result.scope).toEqual(['a', 'b']);
    expect(result.budget).toBe(30);
  });

  test('null child inputs are skipped, never widening', () => {
    const result = intersectMandate(['a', 'b'], 50, null, null);
    expect(result.scope).toEqual(['a', 'b']);
    expect(result.budget).toBe(50);
  });
});
