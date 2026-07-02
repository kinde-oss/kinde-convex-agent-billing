import {describe, expect, test} from 'vitest';
import {ConvexError} from 'convex/values';
import {effectiveBudget} from './helpers.js';

const HOUR = 60 * 60 * 1000;

describe('effectiveBudget rollover', () => {
  test('a long-elapsed local window rolls forward in one O(1) step', () => {
    const now = 1_700_000_000_000;
    const budget = {
      source: 'local' as const,
      remaining: 5,
      periodCap: 100,
      // The window ended 9 hours ago; the period length is 1 hour, so it should
      // advance straight to the window that contains `now`.
      periodStart: now - 10 * HOUR,
      periodEnd: now - 9 * HOUR,
      periodLengthMs: HOUR
    };

    const eff = effectiveBudget(budget, now);
    expect(eff.rolled).toBe(true);
    // remaining resets to the cap on a roll.
    expect(eff.remaining).toBe(100);
    // The current window contains `now`: start <= now < end.
    expect(eff.periodStart).toBe(now);
    expect(eff.periodEnd).toBe(now + HOUR);
  });

  test('a window that just ended rolls to the next single period', () => {
    const now = 1_700_000_000_000;
    const budget = {
      source: 'local' as const,
      remaining: 0,
      periodCap: 50,
      periodStart: now - HOUR,
      periodEnd: now,
      periodLengthMs: HOUR
    };

    const eff = effectiveBudget(budget, now);
    expect(eff.rolled).toBe(true);
    expect(eff.remaining).toBe(50);
    expect(eff.periodStart).toBe(now);
    expect(eff.periodEnd).toBe(now + HOUR);
  });

  test('a non-positive periodLengthMs is rejected instead of looping forever', () => {
    const now = 1_700_000_000_000;
    const base = {
      source: 'local' as const,
      remaining: 5,
      periodCap: 100,
      periodStart: now - 10 * HOUR,
      periodEnd: now - 9 * HOUR
    };

    expect(() => effectiveBudget({...base, periodLengthMs: 0}, now)).toThrow(
      ConvexError
    );
    expect(() => effectiveBudget({...base, periodLengthMs: -5}, now)).toThrow(
      ConvexError
    );
  });

  test('a non-elapsed window is returned unchanged (no roll)', () => {
    const now = 1_700_000_000_000;
    const budget = {
      source: 'local' as const,
      remaining: 42,
      periodCap: 100,
      periodStart: now - HOUR,
      periodEnd: now + HOUR,
      periodLengthMs: HOUR
    };

    const eff = effectiveBudget(budget, now);
    expect(eff.rolled).toBe(false);
    expect(eff.remaining).toBe(42);
    expect(eff.periodStart).toBe(now - HOUR);
    expect(eff.periodEnd).toBe(now + HOUR);
  });
});
