import {describe, expect, test} from 'vitest';
import {AgentBilling} from './index.js';
import {components} from '../../example/convex/_generated/api.js';
import {initConvexTest, makeRunCtx} from './setup.test.js';

const component = components.agentBilling;

describe('AgentBilling client', () => {
  test('Meter then Observe: record decrements what getBudget reports', async () => {
    const t = initConvexTest();
    const billing = new AgentBilling(component);
    const ctx = makeRunCtx(t);

    await billing.setBudget(ctx, {
      principalType: 'user',
      principalId: 'user_alice',
      unit: 'tokens',
      remaining: 100
    });

    const result = await billing.record(ctx, {
      principalType: 'user',
      principalId: 'user_alice',
      unit: 'tokens',
      quantity: 30,
      idempotencyKey: 'k1'
    });
    expect(result.status).toBe('applied');
    expect(result.remaining).toBe(70);

    const budget = await billing.getBudget(ctx, {
      principalType: 'user',
      principalId: 'user_alice',
      unit: 'tokens'
    });
    expect(budget?.remaining).toBe(70);
    expect(budget?.rolled).toBe(false);

    const raw = await billing.getRawBudget(ctx, {
      principalType: 'user',
      principalId: 'user_alice',
      unit: 'tokens'
    });
    expect(raw?.source).toBe('local');
  });

  test('listUsage and getUsageEvent return the recorded event', async () => {
    const t = initConvexTest();
    const billing = new AgentBilling(component);
    const ctx = makeRunCtx(t);

    await billing.setBudget(ctx, {
      principalType: 'agent',
      principalId: 'agent_x',
      unit: 'tokens',
      remaining: 50
    });
    const result = await billing.record(ctx, {
      principalType: 'agent',
      principalId: 'agent_x',
      unit: 'tokens',
      quantity: 5,
      idempotencyKey: 'k1'
    });

    const events = await billing.listUsage(ctx, {
      principalType: 'agent',
      principalId: 'agent_x'
    });
    expect(events).toHaveLength(1);
    expect(events[0]._id).toBe(result.usageEventId);

    const event = await billing.getUsageEvent(ctx, {
      usageEventId: result.usageEventId
    });
    expect(event?.quantity).toBe(5);
  });
});
