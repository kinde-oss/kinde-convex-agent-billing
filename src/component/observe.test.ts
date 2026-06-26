import {describe, expect, test} from 'vitest';
import {api} from './_generated/api.js';
import {initConvexTest} from './setup.test.js';

const HOUR = 60 * 60 * 1000;

type ConvexTest = ReturnType<typeof initConvexTest>;

describe('budgets.getEffective', () => {
  test('a local budget with an elapsed window reports the reset cap without persisting the roll', async () => {
    const t: ConvexTest = initConvexTest();
    const now = Date.now();
    // Stale window: ended two hours ago, remaining ground down to 1.
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

    const eff = await t.query(api.budgets.getEffective, {
      principalType: 'user',
      principalId: 'user_alice',
      unit: 'tokens'
    });
    expect(eff?.rolled).toBe(true);
    expect(eff?.remaining).toBe(100);
    expect(eff?.periodEnd ?? 0).toBeGreaterThan(now);
    expect(eff?.source).toBe('local');

    // The read mutated nothing: the stored row still shows the pre-roll state.
    const stored = await t.query(api.budgets.get, {
      principalType: 'user',
      principalId: 'user_alice',
      unit: 'tokens'
    });
    expect(stored?.remaining).toBe(1);
    expect(stored?.periodEnd).toBe(now - 2 * HOUR);
  });

  test('a provider budget with an elapsed window reports stored state, rolled:false', async () => {
    const t: ConvexTest = initConvexTest();
    const now = Date.now();
    const periodStart = now - 3 * HOUR;
    const periodEnd = now - 2 * HOUR;
    await t.run(async (ctx) =>
      ctx.db.insert('budgets', {
        principalType: 'org',
        principalId: 'org_acme',
        orgCode: null,
        unit: 'credits',
        remaining: 50,
        periodCap: 100,
        periodStart,
        periodEnd,
        periodLengthMs: HOUR,
        source: 'provider',
        createdAt: now
      })
    );

    const eff = await t.query(api.budgets.getEffective, {
      principalType: 'org',
      principalId: 'org_acme',
      unit: 'credits'
    });
    expect(eff?.rolled).toBe(false);
    expect(eff?.remaining).toBe(50);
    expect(eff?.periodEnd).toBe(periodEnd);
    expect(eff?.source).toBe('provider');
  });

  test('returns null for a missing budget', async () => {
    const t: ConvexTest = initConvexTest();
    expect(
      await t.query(api.budgets.getEffective, {
        principalType: 'user',
        principalId: 'nobody',
        unit: 'tokens'
      })
    ).toBeNull();
  });
});

describe('usage.listForPrincipal', () => {
  async function seed(t: ConvexTest): Promise<void> {
    await t.run(async (ctx) => {
      for (const at of [1000, 2000, 3000]) {
        await ctx.db.insert('usageEvents', {
          principalType: 'user',
          principalId: 'user_alice',
          orgCode: null,
          unit: 'tokens',
          quantity: 1,
          idempotencyKey: `k${at}`,
          correlationId: null,
          at
        });
      }
      // A different principal whose events must never leak in.
      await ctx.db.insert('usageEvents', {
        principalType: 'user',
        principalId: 'user_bob',
        orgCode: null,
        unit: 'tokens',
        quantity: 1,
        idempotencyKey: 'kb',
        correlationId: null,
        at: 5000
      });
    });
  }

  test('returns the principal’s events newest-first', async () => {
    const t: ConvexTest = initConvexTest();
    await seed(t);
    const rows = await t.query(api.usage.listForPrincipal, {
      principalType: 'user',
      principalId: 'user_alice'
    });
    expect(rows.map((row) => row.at)).toEqual([3000, 2000, 1000]);
    expect(rows.every((row) => row.principalId === 'user_alice')).toBe(true);
  });

  test('respects the clamped limit', async () => {
    const t: ConvexTest = initConvexTest();
    await seed(t);
    const limited = await t.query(api.usage.listForPrincipal, {
      principalType: 'user',
      principalId: 'user_alice',
      limit: 2
    });
    expect(limited.map((row) => row.at)).toEqual([3000, 2000]);

    // limit:0 clamps up to 1.
    const clampedLow = await t.query(api.usage.listForPrincipal, {
      principalType: 'user',
      principalId: 'user_alice',
      limit: 0
    });
    expect(clampedLow.map((row) => row.at)).toEqual([3000]);
  });
});
