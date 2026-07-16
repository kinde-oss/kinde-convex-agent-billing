import {v} from 'convex/values';
import {mutation, query} from './_generated/server.js';
import type {Doc} from './_generated/dataModel.js';
import schema from './schema.js';
import {effectiveBudget, fail, writeAudit} from './helpers.js';
import {requireSigningSecret, verifyMandate} from './mandates.js';
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
 * returns `deduplicated`. A failed guard (steps 1, 3, 3a, 4, 5) writes nothing,
 * so the whole mutation rolls back atomically.
 *
 * A `mandateId` binds the spend to a mandate (invariant: a mandate is a second,
 * independently-bounded budget — the spend must fit BOTH the principal budget
 * AND the mandate's remaining `budgetCap - budgetSpent`). The mandate check, the
 * budget decrement, and the mandate's `budgetSpent` bump all commit together in
 * this one serializable mutation, so revoking the mandate kills its authority on
 * the next call (reactive). With no `mandateId` the path is exactly Phases 1–3.
 *
 * A mandate-bound call MUST also pass `callerAgentSubject` (the verified
 * caller's subject); it is checked against the mandate's bound `agentSubject` so
 * a mandate cannot be replayed by an agent it was not minted for — the two names
 * are deliberately distinct: one is claimed by the caller, the other is signed
 * into the mandate at mint time. Note this check sits after the
 * idempotency early-return by design: a replay of an already-authorized spend
 * returns the original outcome and re-decides nothing. Mandate `scope` is signed
 * and stored but NOT enforced here — it is audit/metadata today.
 */
export const record = mutation({
  args: {
    principalType: principalTypeValidator,
    principalId: v.string(),
    orgCode: v.optional(nullableString),
    unit: v.string(),
    quantity: v.number(),
    idempotencyKey: v.string(),
    correlationId: v.optional(nullableString),
    mandateId: v.optional(v.id('mandates')),
    /**
     * The verified subject of the agent making this call — agent-auth's
     * `VerifiedAgent.subject`. REQUIRED whenever `mandateId` is passed, so the
     * mandate's bound `agentSubject` can be re-checked at spend time; ignored
     * otherwise. Named for the CALLER, not the mandate: this is the identity
     * being asserted, and it is only trustworthy if it came from `verifyCaller`.
     * Never accept it from client input.
     */
    callerAgentSubject: v.optional(v.string())
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

    // 2. Derive the idempotency scope and the request fingerprint. The scope is
    // a structured JSON encoding that INCLUDES orgCode, so it is tenant-safe and
    // immune to `:`-in-id aliasing.
    const scope = JSON.stringify([
      args.principalType,
      args.principalId,
      orgCode,
      args.unit
    ]);
    const fingerprint = JSON.stringify([
      args.principalType,
      args.principalId,
      orgCode,
      args.unit,
      args.quantity,
      args.mandateId ?? null
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

    // 3a. Mandate binding (additive). Runs after the idempotency early-return —
    // a replay must return the original outcome, not re-evaluate the mandate —
    // but before any budget mutation, so an invalid mandate writes nothing.
    let mandate: Doc<'mandates'> | null = null;
    if (args.mandateId !== undefined) {
      const secret = requireSigningSecret();
      // A mandate names the agent it was minted for, so a mandate-bound spend
      // must say who is spending. Fail closed rather than skip the check: an
      // omitted subject is a caller that has not been through verifyCaller.
      if (args.callerAgentSubject === undefined) {
        fail(
          'caller_subject_required',
          'A mandate-bound record must supply callerAgentSubject: the verified subject of the calling agent.'
        );
      }
      mandate = await ctx.db.get('mandates', args.mandateId);
      if (mandate === null) {
        fail('mandate_not_found', 'No such mandate.');
      }
      const verdict = await verifyMandate(secret, mandate, now);
      if (!verdict.valid) {
        fail(`mandate_${verdict.code}`, verdict.reason);
      }
      // The mandate is bound to a specific agent subject at mint time and
      // re-checked here at spend time, so a leaked mandate id cannot be replayed
      // by another agent to bill usage against this principal. This is a
      // distinct axis from the principal checks below: the principal is who gets
      // billed, the mandate's agentSubject is who is allowed to do the billing.
      if (mandate.agentSubject !== args.callerAgentSubject) {
        fail(
          'mandate_agent_subject_mismatch',
          'The mandate authorizes a different agent.'
        );
      }
      if (
        mandate.principalType !== args.principalType ||
        mandate.principalId !== args.principalId
      ) {
        fail(
          'mandate_principal_mismatch',
          'The mandate authorizes a different principal.'
        );
      }
      if (mandate.orgCode !== orgCode) {
        fail(
          'mandate_tenant_mismatch',
          'The mandate authorizes a different tenant.'
        );
      }
      if (mandate.unit !== args.unit) {
        fail(
          'mandate_unit_mismatch',
          'The mandate authorizes a different unit.'
        );
      }
      if (args.quantity > mandate.budgetCap - mandate.budgetSpent) {
        fail(
          'mandate_budget_exceeded',
          'The request exceeds the mandate’s remaining budget.'
        );
      }
    }

    // 4. Load the budget. The lookup is tenant-scoped by orgCode, so a budget
    // belonging to a different org is simply not found (budget_not_found) rather
    // than aliasing across tenants.
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
      fail('budget_not_found', 'No budget exists for this principal and unit.');
    }

    // 5. Derive the live budget (rolling a stale local window) and check it.
    const eff = effectiveBudget(budget, now);
    if (eff.remaining < args.quantity) {
      fail('budget_exceeded', 'Insufficient remaining budget.');
    }

    // 6. Decrement, persisting any window roll from step 5.
    const newRemaining = eff.remaining - args.quantity;
    await ctx.db.patch('budgets', budget._id, {
      remaining: newRemaining,
      periodStart: eff.periodStart,
      periodEnd: eff.periodEnd
    });

    // 6a. Bump the bound mandate's running spend in the same transaction.
    if (mandate !== null) {
      await ctx.db.patch('mandates', mandate._id, {
        budgetSpent: mandate.budgetSpent + args.quantity
      });
    }

    // 7. Record the usage event.
    const usageEventId = await ctx.db.insert('usageEvents', {
      principalType: args.principalType,
      principalId: args.principalId,
      orgCode,
      unit: args.unit,
      quantity: args.quantity,
      idempotencyKey: args.idempotencyKey,
      correlationId,
      mandateId: args.mandateId ?? null,
      at: now
    });

    // 8. Record the idempotency outcome.
    await ctx.db.insert('idempotencyKeys', {
      scope,
      idempotencyKey: args.idempotencyKey,
      requestFingerprint: fingerprint,
      usageEventId,
      remainingAfter: newRemaining,
      at: now
    });

    // 9. Audit.
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
        correlationId,
        mandateId: args.mandateId ?? null
      }
    });

    // 10.
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
 * The most recent usage events for a principal, newest first. `limit` is clamped
 * to [1, 200].
 *
 * PRINCIPAL-SCOPED, NOT ORG-SCOPED. `by_principal` is
 * ['principalType','principalId','at'] — no orgCode — so this returns the
 * principal's events across EVERY org they act in. That is deliberate (one
 * principal's own history is one list), and it is the opposite of the spend
 * path, where budgets are org-keyed and `usage.record` rejects a cross-tenant
 * mandate. Do NOT build an org-scoped admin view on this: showing org A's admin
 * this list leaks what the same principal did in org B. For a per-org read, use
 * the `by_org_code` index (['orgCode','at']) instead.
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
