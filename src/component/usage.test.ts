import {describe, expect, test} from 'vitest';
import type {Id} from './_generated/dataModel.js';
import {api} from './_generated/api.js';
import {expectFail, initConvexTest} from './setup.test.js';

const HOUR = 60 * 60 * 1000;

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

  test('provider no-roll: an elapsed provider window is never reset', async () => {
    const t = initConvexTest();
    const now = Date.now();
    const periodStart = now - 3 * HOUR;
    const periodEnd = now - 2 * HOUR;
    // Insert a provider budget directly: it is the external source of truth.
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
        source: 'provider',
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
});
