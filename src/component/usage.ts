import {v} from 'convex/values';
import {mutation, query} from './_generated/server.js';
import schema from './schema.js';
import {effectiveBudget, fail, writeAudit} from './helpers.js';
import {
  nullableString,
  principalTypeValidator,
  usageStatusValidator
} from './validators.js';

const usageEventDoc = schema.tables.usageEvents.validator.extend({
  _id: v.id('usageEvents'),
  _creationTime: v.number()
});

/**
 * THE SPINE: the atomic, idempotent check-decrement-record. Convex runs this
 * whole mutation as a single serializable transaction.
 *
 * OCC reasoning (invariant: never double-decrement, never orphan a usage
 * event): the idempotency-index read (step 3) and the budget read (step 4) both
 * enter the transaction's read set, so two concurrent calls with the same key
 * serialize. One applies and commits; the other's commit conflicts on those
 * reads, retries, now observes the idempotency row written by the winner, and
 * returns `deduplicated`. A failed guard (steps 1, 3, 4, 5, 6) writes nothing,
 * so the whole mutation rolls back atomically.
 */
export const record = mutation({
  args: {
    principalType: principalTypeValidator,
    principalId: v.string(),
    orgCode: v.optional(nullableString),
    unit: v.string(),
    quantity: v.number(),
    idempotencyKey: v.string(),
    correlationId: v.optional(nullableString)
  },
  returns: v.object({
    status: usageStatusValidator,
    usageEventId: v.id('usageEvents'),
    remaining: v.number()
  }),
  handler: async (ctx, args) => {
    // 1. Validate the amount.
    const now = Date.now();
    if (args.quantity <= 0) {
      fail('invalid_quantity', 'quantity must be greater than 0.');
    }
    const orgCode = args.orgCode ?? null;
    const correlationId = args.correlationId ?? null;

    // 2. Derive the idempotency scope and the request fingerprint.
    const scope = `${args.principalType}:${args.principalId}:${args.unit}`;
    const fingerprint = JSON.stringify([
      args.principalType,
      args.principalId,
      orgCode,
      args.unit,
      args.quantity
    ]);

    // 3. Idempotency: a matching key replays the original outcome; a key reused
    // with a different request is a conflict.
    const existingKey = await ctx.db
      .query('idempotencyKeys')
      .withIndex('by_scope_key', (q) =>
        q.eq('scope', scope).eq('idempotencyKey', args.idempotencyKey)
      )
      .unique();
    if (existingKey !== null) {
      if (existingKey.requestFingerprint !== fingerprint) {
        fail(
          'idempotency_conflict',
          'The idempotency key was reused with a different request.'
        );
      }
      return {
        status: 'deduplicated' as const,
        usageEventId: existingKey.usageEventId,
        remaining: existingKey.remainingAfter
      };
    }

    // 4. Load the budget.
    const budget = await ctx.db
      .query('budgets')
      .withIndex('by_principal', (q) =>
        q
          .eq('principalType', args.principalType)
          .eq('principalId', args.principalId)
          .eq('unit', args.unit)
      )
      .unique();
    if (budget === null) {
      fail('budget_not_found', 'No budget exists for this principal and unit.');
    }

    // 5. Tenant isolation.
    if (orgCode !== budget.orgCode) {
      fail('tenant_mismatch', 'orgCode does not match the budget tenant.');
    }

    // 6. Derive the live budget (rolling a stale local window) and check it.
    const eff = effectiveBudget(budget, now);
    if (eff.remaining < args.quantity) {
      fail('budget_exceeded', 'Insufficient remaining budget.');
    }

    // 7. Decrement, persisting any window roll from step 6.
    const newRemaining = eff.remaining - args.quantity;
    await ctx.db.patch('budgets', budget._id, {
      remaining: newRemaining,
      periodStart: eff.periodStart,
      periodEnd: eff.periodEnd
    });

    // 8. Record the usage event.
    const usageEventId = await ctx.db.insert('usageEvents', {
      principalType: args.principalType,
      principalId: args.principalId,
      orgCode,
      unit: args.unit,
      quantity: args.quantity,
      idempotencyKey: args.idempotencyKey,
      correlationId,
      at: now
    });

    // 9. Record the idempotency outcome.
    await ctx.db.insert('idempotencyKeys', {
      scope,
      idempotencyKey: args.idempotencyKey,
      requestFingerprint: fingerprint,
      usageEventId,
      remainingAfter: newRemaining,
      at: now
    });

    // 10. Audit.
    await writeAudit(ctx, {
      eventType: 'usage.recorded',
      principalType: args.principalType,
      principalId: args.principalId,
      orgCode,
      unit: args.unit,
      decision: null,
      correlationId,
      detail: {
        quantity: args.quantity,
        remaining: newRemaining,
        idempotencyKey: args.idempotencyKey,
        correlationId
      }
    });

    // 11.
    return {status: 'applied' as const, usageEventId, remaining: newRemaining};
  }
});

/** Read a recorded usage event by id, or null. */
export const getEvent = query({
  args: {usageEventId: v.id('usageEvents')},
  returns: v.union(usageEventDoc, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db.get('usageEvents', args.usageEventId);
  }
});

/**
 * The most recent usage events for a principal, newest first. The principal
 * identity already scopes the rows, so no orgCode filter is needed. `limit` is
 * clamped to [1, 200].
 */
export const listForPrincipal = query({
  args: {
    principalType: principalTypeValidator,
    principalId: v.string(),
    limit: v.optional(v.number())
  },
  returns: v.array(usageEventDoc),
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 200);
    return await ctx.db
      .query('usageEvents')
      .withIndex('by_principal', (q) =>
        q
          .eq('principalType', args.principalType)
          .eq('principalId', args.principalId)
      )
      .order('desc')
      .take(limit);
  }
});
