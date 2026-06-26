import {describe, expect, test} from 'vitest';
import {api} from './_generated/api.js';
import {expectFail, initConvexTest} from './setup.test.js';

const HOUR = 60 * 60 * 1000;

describe('budgets', () => {
  test('set creates a local budget that get reads back', async () => {
    const t = initConvexTest();
    const budgetId = await t.mutation(api.budgets.set, {
      principalType: 'user',
      principalId: 'user_alice',
      unit: 'tokens',
      remaining: 100,
      orgCode: 'org_acme'
    });

    const budget = await t.query(api.budgets.get, {
      principalType: 'user',
      principalId: 'user_alice',
      unit: 'tokens'
    });
    expect(budget?._id).toBe(budgetId);
    expect(budget?.remaining).toBe(100);
    expect(budget?.source).toBe('local');
    expect(budget?.orgCode).toBe('org_acme');
    expect(budget?.periodCap).toBeNull();
  });

  test('get returns null when no budget exists', async () => {
    const t = initConvexTest();
    expect(
      await t.query(api.budgets.get, {
        principalType: 'agent',
        principalId: 'agent_x',
        unit: 'tokens'
      })
    ).toBeNull();
  });

  test('set upserts: a second set patches the row rather than duplicating', async () => {
    const t = initConvexTest();
    const first = await t.mutation(api.budgets.set, {
      principalType: 'org',
      principalId: 'org_acme',
      unit: 'tokens',
      remaining: 100
    });
    const second = await t.mutation(api.budgets.set, {
      principalType: 'org',
      principalId: 'org_acme',
      unit: 'tokens',
      remaining: 250
    });
    expect(second).toBe(first);

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query('budgets')
        .withIndex('by_principal', (q) =>
          q
            .eq('principalType', 'org')
            .eq('principalId', 'org_acme')
            .eq('unit', 'tokens')
        )
        .collect()
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].remaining).toBe(250);
  });

  test('HARDENING: a negative remaining fails invalid_amount', async () => {
    const t = initConvexTest();
    await expectFail(
      t.mutation(api.budgets.set, {
        principalType: 'user',
        principalId: 'user_alice',
        unit: 'tokens',
        remaining: -1
      }),
      'invalid_amount'
    );
  });

  test('HARDENING: a negative periodCap fails invalid_amount', async () => {
    const t = initConvexTest();
    await expectFail(
      t.mutation(api.budgets.set, {
        principalType: 'user',
        principalId: 'user_alice',
        unit: 'tokens',
        remaining: 10,
        periodCap: -5,
        periodStart: 0,
        periodEnd: HOUR,
        periodLengthMs: HOUR
      }),
      'invalid_amount'
    );
  });

  test('HARDENING: periodLengthMs without the window fails invalid_period', async () => {
    const t = initConvexTest();
    await expectFail(
      t.mutation(api.budgets.set, {
        principalType: 'user',
        principalId: 'user_alice',
        unit: 'tokens',
        remaining: 10,
        periodLengthMs: HOUR
      }),
      'invalid_period'
    );
  });

  test('HARDENING: periodEnd <= periodStart fails invalid_period', async () => {
    const t = initConvexTest();
    await expectFail(
      t.mutation(api.budgets.set, {
        principalType: 'user',
        principalId: 'user_alice',
        unit: 'tokens',
        remaining: 10,
        periodCap: 100,
        periodStart: HOUR,
        periodEnd: HOUR,
        periodLengthMs: HOUR
      }),
      'invalid_period'
    );
  });
});
