import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import type {Id} from './_generated/dataModel.js';
import {api} from './_generated/api.js';
import {expectFail, initConvexTest} from './setup.test.js';

const HOUR = 60 * 60 * 1000;
const MANDATE_SECRET = 'test-mandate-secret';

type ConvexTest = ReturnType<typeof initConvexTest>;

async function setBudget(
  t: ConvexTest,
  remaining: number,
  orgCode: string | null = null
): Promise<void> {
  await t.mutation(api.budgets.set, {
    principalType: 'user',
    principalId: 'user_alice',
    unit: 'tokens',
    remaining,
    orgCode
  });
}

async function counts(t: ConvexTest) {
  return await t.run(async (ctx) => {
    const usageEvents = await ctx.db.query('usageEvents').collect();
    const idempotencyKeys = await ctx.db.query('idempotencyKeys').collect();
    const recorded = await ctx.db
      .query('auditLog')
      .withIndex('by_event_type', (q) => q.eq('eventType', 'usage.recorded'))
      .collect();
    return {
      usageEvents: usageEvents.length,
      idempotencyKeys: idempotencyKeys.length,
      recorded: recorded.length
    };
  });
}

async function remainingOf(t: ConvexTest): Promise<number | undefined> {
  const budget = await t.query(api.budgets.get, {
    principalType: 'user',
    principalId: 'user_alice',
    unit: 'tokens'
  });
  return budget?.remaining;
}

describe('usage.record — the spine', () => {
  beforeEach(() => {
    // HARDENING: stub every required env var, so the mandate-bound tests below
    // can sign/verify. The no-mandate path never reads it.
    vi.stubEnv('MANDATE_SIGNING_SECRET', MANDATE_SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('applied: decrements once and writes exactly one of each row', async () => {
    const t = initConvexTest();
    await setBudget(t, 100);

    const result = await t.mutation(api.usage.record, {
      principalType: 'user',
      principalId: 'user_alice',
      unit: 'tokens',
      quantity: 30,
      idempotencyKey: 'k1'
    });

    expect(result.status).toBe('applied');
    expect(result.remaining).toBe(70);
    expect(await remainingOf(t)).toBe(70);
    expect(await counts(t)).toEqual({
      usageEvents: 1,
      idempotencyKeys: 1,
      recorded: 1
    });

    const event = await t.query(api.usage.getEvent, {
      usageEventId: result.usageEventId
    });
    expect(event?.quantity).toBe(30);
  });

  test('idempotent replay: same key+payload applies once then deduplicates', async () => {
    const t = initConvexTest();
    await setBudget(t, 100);

    const first = await t.mutation(api.usage.record, {
      principalType: 'user',
      principalId: 'user_alice',
      unit: 'tokens',
      quantity: 30,
      idempotencyKey: 'k1'
    });
    const second = await t.mutation(api.usage.record, {
      principalType: 'user',
      principalId: 'user_alice',
      unit: 'tokens',
      quantity: 30,
      idempotencyKey: 'k1'
    });

    expect(first.status).toBe('applied');
    expect(second.status).toBe('deduplicated');
    expect(second.usageEventId).toBe(first.usageEventId);
    expect(second.remaining).toBe(70);
    expect(await remainingOf(t)).toBe(70);
    expect(await counts(t)).toEqual({
      usageEvents: 1,
      idempotencyKeys: 1,
      recorded: 1
    });
  });

  test('idempotency_conflict: same key, different quantity, no second decrement', async () => {
    const t = initConvexTest();
    await setBudget(t, 100);

    await t.mutation(api.usage.record, {
      principalType: 'user',
      principalId: 'user_alice',
      unit: 'tokens',
      quantity: 30,
      idempotencyKey: 'k1'
    });
    await expectFail(
      t.mutation(api.usage.record, {
        principalType: 'user',
        principalId: 'user_alice',
        unit: 'tokens',
        quantity: 40,
        idempotencyKey: 'k1'
      }),
      'idempotency_conflict'
    );

    expect(await remainingOf(t)).toBe(70);
    expect(await counts(t)).toEqual({
      usageEvents: 1,
      idempotencyKeys: 1,
      recorded: 1
    });
  });

  test('budget_exceeded: fails atomically and writes nothing', async () => {
    const t = initConvexTest();
    await setBudget(t, 5);

    await expectFail(
      t.mutation(api.usage.record, {
        principalType: 'user',
        principalId: 'user_alice',
        unit: 'tokens',
        quantity: 10,
        idempotencyKey: 'k1'
      }),
      'budget_exceeded'
    );

    expect(await remainingOf(t)).toBe(5);
    expect(await counts(t)).toEqual({
      usageEvents: 0,
      idempotencyKeys: 0,
      recorded: 0
    });
  });

  test('invalid_quantity: a non-positive quantity fails and writes nothing', async () => {
    const t = initConvexTest();
    await setBudget(t, 100);
    await expectFail(
      t.mutation(api.usage.record, {
        principalType: 'user',
        principalId: 'user_alice',
        unit: 'tokens',
        quantity: 0,
        idempotencyKey: 'k1'
      }),
      'invalid_quantity'
    );
    expect(await counts(t)).toEqual({
      usageEvents: 0,
      idempotencyKeys: 0,
      recorded: 0
    });
  });

  test('budget_not_found: fails and writes nothing', async () => {
    const t = initConvexTest();
    await expectFail(
      t.mutation(api.usage.record, {
        principalType: 'user',
        principalId: 'user_alice',
        unit: 'tokens',
        quantity: 10,
        idempotencyKey: 'k1'
      }),
      'budget_not_found'
    );
    expect(await counts(t)).toEqual({
      usageEvents: 0,
      idempotencyKeys: 0,
      recorded: 0
    });
  });

  test('tenant_mismatch: a wrong orgCode fails and writes nothing', async () => {
    const t = initConvexTest();
    await setBudget(t, 100, 'org_acme');

    await expectFail(
      t.mutation(api.usage.record, {
        principalType: 'user',
        principalId: 'user_alice',
        orgCode: 'org_other',
        unit: 'tokens',
        quantity: 10,
        idempotencyKey: 'k1'
      }),
      'tenant_mismatch'
    );

    expect(await remainingOf(t)).toBe(100);
    expect(await counts(t)).toEqual({
      usageEvents: 0,
      idempotencyKeys: 0,
      recorded: 0
    });
  });

  test('local period rollover: a stale window resets to the cap before deducting', async () => {
    const t = initConvexTest();
    const now = Date.now();
    // A local budget whose window already elapsed and whose stored remaining is
    // stale (1), below the quantity we are about to record.
    await t.mutation(api.budgets.set, {
      principalType: 'user',
      principalId: 'user_alice',
      unit: 'tokens',
      remaining: 1,
      periodCap: 100,
      periodStart: now - 3 * HOUR,
      periodEnd: now - 2 * HOUR,
      periodLengthMs: HOUR
    });

    const result = await t.mutation(api.usage.record, {
      principalType: 'user',
      principalId: 'user_alice',
      unit: 'tokens',
      quantity: 40,
      idempotencyKey: 'k1'
    });

    // Succeeds against the reset cap (100), not the stale remaining (1).
    expect(result.status).toBe('applied');
    expect(result.remaining).toBe(60);

    const budget = await t.query(api.budgets.get, {
      principalType: 'user',
      principalId: 'user_alice',
      unit: 'tokens'
    });
    expect(budget?.remaining).toBe(60);
    // The persisted window advanced past now.
    expect(budget?.periodEnd ?? 0).toBeGreaterThan(now);
    expect(budget?.periodStart ?? 0).toBeGreaterThan(now - 2 * HOUR);
  });

  test('kinde no-roll: an elapsed Kinde window is never reset', async () => {
    const t = initConvexTest();
    const now = Date.now();
    const periodStart = now - 3 * HOUR;
    const periodEnd = now - 2 * HOUR;
    // Insert a Kinde budget directly: it is the external source of truth.
    const budgetId: Id<'budgets'> = await t.run(async (ctx) =>
      ctx.db.insert('budgets', {
        principalType: 'user',
        principalId: 'user_alice',
        orgCode: null,
        unit: 'tokens',
        remaining: 50,
        periodCap: 100,
        periodStart,
        periodEnd,
        periodLengthMs: HOUR,
        source: 'kinde',
        createdAt: now
      })
    );

    const result = await t.mutation(api.usage.record, {
      principalType: 'user',
      principalId: 'user_alice',
      unit: 'tokens',
      quantity: 10,
      idempotencyKey: 'k1'
    });

    // Decrements the stored remaining; the window is left untouched.
    expect(result.status).toBe('applied');
    expect(result.remaining).toBe(40);

    const budget = await t.run(async (ctx) => ctx.db.get('budgets', budgetId));
    expect(budget?.remaining).toBe(40);
    expect(budget?.periodStart).toBe(periodStart);
    expect(budget?.periodEnd).toBe(periodEnd);
  });

  // --- Mandate binding (Phase 4) ---

  async function mintMandate(
    t: ConvexTest,
    budgetCap: number,
    overrides: {principalId?: string; unit?: string} = {}
  ): Promise<Id<'mandates'>> {
    return await t.mutation(api.mandates.mint, {
      principalType: 'user',
      principalId: overrides.principalId ?? 'user_alice',
      agentSubject: 'agent_bot',
      unit: overrides.unit ?? 'tokens',
      scope: ['chat.completions'],
      budgetCap,
      notAfter: Date.now() + HOUR
    });
  }

  test('record under a mandate decrements both the budget and the mandate', async () => {
    const t = initConvexTest();
    await setBudget(t, 100);
    const mandateId = await mintMandate(t, 50);

    const result = await t.mutation(api.usage.record, {
      principalType: 'user',
      principalId: 'user_alice',
      unit: 'tokens',
      quantity: 20,
      idempotencyKey: 'k1',
      mandateId
    });
    expect(result.status).toBe('applied');
    expect(result.remaining).toBe(80);

    const mandate = await t.query(api.mandates.get, {mandateId});
    expect(mandate?.budgetSpent).toBe(20);

    const event = await t.query(api.usage.getEvent, {
      usageEventId: result.usageEventId
    });
    expect(event?.mandateId).toBe(mandateId);
  });

  test('a record over the mandate remaining (within the principal budget) fails mandate_budget_exceeded and writes nothing', async () => {
    const t = initConvexTest();
    await setBudget(t, 1000); // principal budget has plenty
    const mandateId = await mintMandate(t, 30); // mandate caps spend at 30

    await t.mutation(api.usage.record, {
      principalType: 'user',
      principalId: 'user_alice',
      unit: 'tokens',
      quantity: 20,
      idempotencyKey: 'k1',
      mandateId
    });
    // 20 more would exceed the mandate's remaining (30 - 20 = 10), even though
    // the principal budget still has 980.
    await expectFail(
      t.mutation(api.usage.record, {
        principalType: 'user',
        principalId: 'user_alice',
        unit: 'tokens',
        quantity: 20,
        idempotencyKey: 'k2',
        mandateId
      }),
      'mandate_budget_exceeded'
    );

    expect(await remainingOf(t)).toBe(980);
    const mandate = await t.query(api.mandates.get, {mandateId});
    expect(mandate?.budgetSpent).toBe(20);
    expect(await counts(t)).toEqual({
      usageEvents: 1,
      idempotencyKeys: 1,
      recorded: 1
    });
  });

  test('revoking the mandate makes the next record fail mandate_revoked (reactive), budget untouched', async () => {
    const t = initConvexTest();
    await setBudget(t, 1000);
    const mandateId = await mintMandate(t, 100);

    await t.mutation(api.usage.record, {
      principalType: 'user',
      principalId: 'user_alice',
      unit: 'tokens',
      quantity: 10,
      idempotencyKey: 'k1',
      mandateId
    });
    await t.mutation(api.mandates.revoke, {mandateId});

    await expectFail(
      t.mutation(api.usage.record, {
        principalType: 'user',
        principalId: 'user_alice',
        unit: 'tokens',
        quantity: 10,
        idempotencyKey: 'k2',
        mandateId
      }),
      'mandate_revoked'
    );
    // Only the first spend went through.
    expect(await remainingOf(t)).toBe(990);
  });

  test('mandate principal mismatch fails', async () => {
    const t = initConvexTest();
    await setBudget(t, 100);
    const mandateId = await mintMandate(t, 50, {principalId: 'user_bob'});

    await expectFail(
      t.mutation(api.usage.record, {
        principalType: 'user',
        principalId: 'user_alice',
        unit: 'tokens',
        quantity: 10,
        idempotencyKey: 'k1',
        mandateId
      }),
      'mandate_principal_mismatch'
    );
  });

  test('mandate unit mismatch fails', async () => {
    const t = initConvexTest();
    await setBudget(t, 100);
    const mandateId = await mintMandate(t, 50, {unit: 'images'});

    await expectFail(
      t.mutation(api.usage.record, {
        principalType: 'user',
        principalId: 'user_alice',
        unit: 'tokens',
        quantity: 10,
        idempotencyKey: 'k1',
        mandateId
      }),
      'mandate_unit_mismatch'
    );
  });

  test('regression: record without a mandateId behaves as before and stores null mandateId', async () => {
    const t = initConvexTest();
    await setBudget(t, 100);

    const result = await t.mutation(api.usage.record, {
      principalType: 'user',
      principalId: 'user_alice',
      unit: 'tokens',
      quantity: 10,
      idempotencyKey: 'k1'
    });
    expect(result.status).toBe('applied');
    expect(result.remaining).toBe(90);

    const event = await t.query(api.usage.getEvent, {
      usageEventId: result.usageEventId
    });
    expect(event?.mandateId).toBeNull();
  });
});
