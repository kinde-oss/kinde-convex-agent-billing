import {v} from 'convex/values';
import {mutation, query} from './_generated/server.js';
import type {Id} from './_generated/dataModel.js';
import schema from './schema.js';
import {effectiveBudget, fail, writeAudit} from './helpers.js';
import {
  budgetSourceValidator,
  nullableNumber,
  nullableString,
  principalTypeValidator
} from './validators.js';

const budgetDoc = schema.tables.budgets.validator.extend({
  _id: v.id('budgets'),
  _creationTime: v.number()
});

/**
 * Upsert a LOCAL budget for (principalType, principalId, unit). `source` is
 * always forced to `local`; Kinde budgets are mirrored in by other code
 * paths, never through this mutation. HARDENING guards reject malformed inputs
 * rather than coercing them.
 */
export const set = mutation({
  args: {
    principalType: principalTypeValidator,
    principalId: v.string(),
    unit: v.string(),
    remaining: v.number(),
    orgCode: v.optional(nullableString),
    periodCap: v.optional(nullableNumber),
    periodStart: v.optional(nullableNumber),
    periodEnd: v.optional(nullableNumber),
    periodLengthMs: v.optional(nullableNumber)
  },
  returns: v.id('budgets'),
  handler: async (ctx, args) => {
    const now = Date.now();
    const orgCode = args.orgCode ?? null;
    const periodCap = args.periodCap ?? null;
    const periodStart = args.periodStart ?? null;
    const periodEnd = args.periodEnd ?? null;
    const periodLengthMs = args.periodLengthMs ?? null;

    if (args.remaining < 0) {
      fail('invalid_amount', 'remaining must be >= 0.');
    }
    if (periodCap !== null && periodCap < 0) {
      fail('invalid_amount', 'periodCap must be >= 0.');
    }
    if (
      periodLengthMs !== null &&
      (periodCap === null || periodStart === null || periodEnd === null)
    ) {
      fail(
        'invalid_period',
        'periodLengthMs requires periodCap, periodStart, and periodEnd to be set.'
      );
    }
    const anyPeriodField =
      periodCap !== null ||
      periodStart !== null ||
      periodEnd !== null ||
      periodLengthMs !== null;
    if (anyPeriodField) {
      if (periodStart === null || periodEnd === null) {
        fail(
          'invalid_period',
          'A period window requires both periodStart and periodEnd.'
        );
      }
      if (periodEnd <= periodStart) {
        fail('invalid_period', 'periodEnd must be greater than periodStart.');
      }
    }

    const existing = await ctx.db
      .query('budgets')
      .withIndex('by_principal', (q) =>
        q
          .eq('principalType', args.principalType)
          .eq('principalId', args.principalId)
          .eq('orgCode', orgCode)
          .eq('unit', args.unit)
      )
      .unique();

    let budgetId: Id<'budgets'>;
    if (existing !== null) {
      await ctx.db.patch('budgets', existing._id, {
        orgCode,
        remaining: args.remaining,
        periodCap,
        periodStart,
        periodEnd,
        periodLengthMs,
        source: 'local'
      });
      budgetId = existing._id;
    } else {
      budgetId = await ctx.db.insert('budgets', {
        principalType: args.principalType,
        principalId: args.principalId,
        orgCode,
        unit: args.unit,
        remaining: args.remaining,
        periodCap,
        periodStart,
        periodEnd,
        periodLengthMs,
        source: 'local',
        createdAt: now
      });
    }

    await writeAudit(ctx, {
      eventType: 'budget.set',
      principalType: args.principalType,
      principalId: args.principalId,
      orgCode,
      unit: args.unit,
      detail: {
        remaining: args.remaining,
        periodCap,
        source: 'local'
      }
    });
    return budgetId;
  }
});

/** Read the budget for (principalType, principalId, orgCode, unit), or null. */
export const get = query({
  args: {
    principalType: principalTypeValidator,
    principalId: v.string(),
    orgCode: v.optional(nullableString),
    unit: v.string()
  },
  returns: v.union(budgetDoc, v.null()),
  handler: async (ctx, args) => {
    const orgCode = args.orgCode ?? null;
    return await ctx.db
      .query('budgets')
      .withIndex('by_principal', (q) =>
        q
          .eq('principalType', args.principalType)
          .eq('principalId', args.principalId)
          .eq('orgCode', orgCode)
          .eq('unit', args.unit)
      )
      .unique();
  }
});

/**
 * Read-only counterpart to the spine's internal use of `effectiveBudget`:
 * report what `remaining` is RIGHT NOW. A local budget reflects a due rollover
 * (remaining reset to `periodCap`, `rolled:true`); a Kinde budget reflects
 * its stored state (`rolled:false`). This query mutates nothing — it never
 * patches the stored row, so a caller can observe a pending roll without
 * materializing it.
 */
export const getEffective = query({
  args: {
    principalType: principalTypeValidator,
    principalId: v.string(),
    orgCode: v.optional(nullableString),
    unit: v.string()
  },
  returns: v.union(
    v.object({
      remaining: v.number(),
      periodStart: nullableNumber,
      periodEnd: nullableNumber,
      periodCap: nullableNumber,
      unit: v.string(),
      source: budgetSourceValidator,
      rolled: v.boolean()
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    const orgCode = args.orgCode ?? null;
    const budget = await ctx.db
      .query('budgets')
      .withIndex('by_principal', (q) =>
        q
          .eq('principalType', args.principalType)
          .eq('principalId', args.principalId)
          .eq('orgCode', orgCode)
          .eq('unit', args.unit)
      )
      .unique();
    if (budget === null) {
      return null;
    }
    const eff = effectiveBudget(budget, Date.now());
    return {
      remaining: eff.remaining,
      periodStart: eff.periodStart,
      periodEnd: eff.periodEnd,
      periodCap: budget.periodCap,
      unit: budget.unit,
      source: budget.source,
      rolled: eff.rolled
    };
  }
});
