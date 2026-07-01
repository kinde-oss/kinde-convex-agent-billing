import {describe, expect, test} from 'vitest';
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

async function decisionRows(t: ConvexTest) {
  return await t.run(async (ctx) =>
    ctx.db
      .query('auditLog')
      .withIndex('by_event_type', (q) => q.eq('eventType', 'billing.decision'))
      .collect()
  );
}

describe('enforce.check', () => {
  test('allow: remaining >= requested writes one allow decision row', async () => {
    const t = initConvexTest();
    await setBudget(t, 100);

    const result = await t.mutation(api.enforce.check, {
      principalType: 'user',
      principalId: 'user_alice',
      unit: 'tokens',
      requested: 30
    });
    expect(result.decision).toBe('allow');
    expect(result.reason).toBe('within_budget');
    expect(result.remaining).toBe(100);
    expect(result.requested).toBe(30);

    const rows = await decisionRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe('allow');
    expect(rows[0].correlationId).toBe(result.correlationId);
  });

  test('degrade: 0 < remaining < requested', async () => {
    const t = initConvexTest();
    await setBudget(t, 10);

    const result = await t.mutation(api.enforce.check, {
      principalType: 'user',
      principalId: 'user_alice',
      unit: 'tokens',
      requested: 25
    });
    expect(result.decision).toBe('degrade');
    expect(result.reason).toBe('insufficient_remaining');
    expect(result.remaining).toBe(10);

    const rows = await decisionRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe('degrade');
  });

  test('deny exhausted: remaining <= 0', async () => {
    const t = initConvexTest();
    await setBudget(t, 0);

    const result = await t.mutation(api.enforce.check, {
      principalType: 'user',
      principalId: 'user_alice',
      unit: 'tokens',
      requested: 5
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toBe('budget_exhausted');
    expect(result.remaining).toBe(0);
  });

  test('deny not found: no budget, remaining null', async () => {
    const t = initConvexTest();

    const result = await t.mutation(api.enforce.check, {
      principalType: 'user',
      principalId: 'user_alice',
      unit: 'tokens',
      requested: 5
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toBe('budget_not_found');
    expect(result.remaining).toBeNull();

    const rows = await decisionRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe('deny');
  });

  test('deny tenant: a budget in another org is not found (tenant-scoped key), remaining null', async () => {
    const t = initConvexTest();
    await setBudget(t, 100, 'org_acme');

    // The budget is keyed to org_acme; a check for org_other finds no budget.
    const result = await t.mutation(api.enforce.check, {
      principalType: 'user',
      principalId: 'user_alice',
      orgCode: 'org_other',
      unit: 'tokens',
      requested: 5
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toBe('budget_not_found');
    expect(result.remaining).toBeNull();
  });

  test('invalid_requested: requested <= 0 fails and writes no decision row', async () => {
    const t = initConvexTest();
    await setBudget(t, 100);

    await expectFail(
      t.mutation(api.enforce.check, {
        principalType: 'user',
        principalId: 'user_alice',
        unit: 'tokens',
        requested: 0
      }),
      'invalid_requested'
    );
    expect(await decisionRows(t)).toHaveLength(0);
  });

  test('read-only: an elapsed local window is reported rolled but not persisted', async () => {
    const t = initConvexTest();
    const now = Date.now();
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

    // Reports against the reset cap (100), allowing the full request.
    const result = await t.mutation(api.enforce.check, {
      principalType: 'user',
      principalId: 'user_alice',
      unit: 'tokens',
      requested: 40
    });
    expect(result.decision).toBe('allow');
    expect(result.remaining).toBe(100);

    // The stored row is untouched: check never patches the budget.
    const stored = await t.query(api.budgets.get, {
      principalType: 'user',
      principalId: 'user_alice',
      unit: 'tokens'
    });
    expect(stored?.remaining).toBe(1);
    expect(stored?.periodEnd).toBe(now - 2 * HOUR);
  });

  test('gate/record agreement: allow then record applies; deny then record is budget_exceeded', async () => {
    const t = initConvexTest();
    await setBudget(t, 20);

    // check allows 20, record then applies 20 atomically.
    const allow = await t.mutation(api.enforce.check, {
      principalType: 'user',
      principalId: 'user_alice',
      unit: 'tokens',
      requested: 20
    });
    expect(allow.decision).toBe('allow');
    const applied = await t.mutation(api.usage.record, {
      principalType: 'user',
      principalId: 'user_alice',
      unit: 'tokens',
      quantity: 20,
      idempotencyKey: 'k1'
    });
    expect(applied.status).toBe('applied');
    expect(applied.remaining).toBe(0);

    // Now exhausted: check denies, and record rejects the same request.
    const deny = await t.mutation(api.enforce.check, {
      principalType: 'user',
      principalId: 'user_alice',
      unit: 'tokens',
      requested: 5
    });
    expect(deny.decision).toBe('deny');
    expect(deny.reason).toBe('budget_exhausted');
    await expectFail(
      t.mutation(api.usage.record, {
        principalType: 'user',
        principalId: 'user_alice',
        unit: 'tokens',
        quantity: 5,
        idempotencyKey: 'k2'
      }),
      'budget_exceeded'
    );
  });

  test('audit correlationId: passed-in is propagated; absent is generated', async () => {
    const t = initConvexTest();
    await setBudget(t, 100);

    const withId = await t.mutation(api.enforce.check, {
      principalType: 'user',
      principalId: 'user_alice',
      unit: 'tokens',
      requested: 10,
      correlationId: 'corr-123'
    });
    expect(withId.correlationId).toBe('corr-123');

    const withoutId = await t.mutation(api.enforce.check, {
      principalType: 'user',
      principalId: 'user_alice',
      unit: 'tokens',
      requested: 10
    });
    expect(withoutId.correlationId).not.toBe('');
    expect(withoutId.correlationId).not.toBe('corr-123');

    const rows = await decisionRows(t);
    const correlationIds = rows.map((row) => row.correlationId);
    expect(correlationIds).toContain('corr-123');
    expect(correlationIds).toContain(withoutId.correlationId);
  });
});
