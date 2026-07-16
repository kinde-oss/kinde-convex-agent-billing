import {v} from 'convex/values';
import type {Infer} from 'convex/values';
import {mutation} from './_generated/server.js';
import {effectiveBudget, fail, writeAudit} from './helpers.js';
import {
  decisionValidator,
  nullableNumber,
  nullableString,
  principalTypeValidator
} from './validators.js';

const gateResultValidator = v.object({
  decision: decisionValidator,
  reason: v.string(),
  remaining: nullableNumber,
  requested: v.number(),
  correlationId: v.string()
});

type Decision = Infer<typeof decisionValidator>;

/**
 * The Enforce gate: an advisory, read-only billing decision. Gates run in
 * precedence order and the first conclusive one short-circuits through the
 * single `decide` helper, which writes exactly one `billing.decision` audit row
 * carrying the correlationId returned to the caller (mirrors the auth
 * component's I4: one decision row per call). The `reason` is always a stable,
 * machine-readable code.
 *
 * gate.check NEVER mutates the budget — it reports a decision and audits it, but
 * only `usage.record` decrements. Both read the same `effectiveBudget`, so they
 * agree at a single instant ON THE PRINCIPAL BUDGET (invariant): a request
 * `check` calls `allow` will not be rejected by `record`'s budget check at that
 * instant (record then enforces the decrement atomically), and a request `check`
 * calls `deny` (exhausted) is the same request `record` rejects with
 * `budget_exceeded`.
 *
 * THE GATE IS BUDGET-ONLY AND MANDATE-BLIND. It takes no `mandateId` and never
 * reads the mandates table, so it sees only the principal budget. A mandate is a
 * SECOND, independent bound (`budgetCap - budgetSpent`) that only `usage.record`
 * enforces. So `allow` here does NOT imply a mandate-bound record will succeed:
 * with a principal budget of 1000 and a mandate with 10 left, `check` allows 500
 * and `record` then rejects it with `mandate_budget_exceeded`. An agent spending
 * under a mandate must treat the
 * mandate's own remaining as the real ceiling — read it via `mandates.get` — and
 * not infer authority from this gate alone.
 *
 * THE CONTRACT WITH `usage.record` — check is ADVISORY and RESERVES NOTHING.
 * It holds no budget for the caller, so an `allow` is a statement about that
 * instant, not a promise about the next one. Two concurrent checks against the
 * same budget can both return `allow` for a request only one of them can afford;
 * neither is wrong, because `usage.record` is the real enforcement point — its
 * atomic, idempotent decrement is what serializes the winner and rejects the
 * loser with `budget_exceeded`. So: never treat `allow` as authority to spend
 * without recording, and on `degrade` record NO MORE than the returned
 * `remaining` (a `degrade` is "you can have this much, not what you asked for").
 * Calling check without ever calling record bills nobody.
 */
export const check = mutation({
  args: {
    principalType: principalTypeValidator,
    principalId: v.string(),
    orgCode: v.optional(nullableString),
    unit: v.string(),
    requested: v.number(),
    correlationId: v.optional(nullableString)
  },
  returns: gateResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const orgCode = args.orgCode ?? null;
    const incomingCorrelationId = args.correlationId ?? null;

    // One audit row per decision. All conclusive exits funnel through here.
    const decide = async (
      decision: Decision,
      reason: string,
      fields: {remaining: number | null}
    ) => {
      const correlationId = await writeAudit(ctx, {
        eventType: 'billing.decision',
        principalType: args.principalType,
        principalId: args.principalId,
        orgCode,
        unit: args.unit,
        decision,
        correlationId: incomingCorrelationId,
        detail: {
          requested: args.requested,
          remaining: fields.remaining,
          reason
        }
      });
      return {
        decision,
        reason,
        remaining: fields.remaining,
        requested: args.requested,
        correlationId
      };
    };

    // 1. A non-positive request is a contradictory argument, not a denial —
    // reject it like the spine's invalid_quantity (HARDENING: do not coerce).
    if (args.requested <= 0) {
      fail('invalid_requested', 'requested must be greater than 0.');
    }

    // 2. The budget must exist. The lookup is tenant-scoped by orgCode, so a
    // budget belonging to a different org is not found (budget_not_found).
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
      return await decide('deny', 'budget_not_found', {remaining: null});
    }

    // 3. Derive the live budget (read-only — a due local roll is reflected but
    // never persisted, exactly like budgets.getEffective).
    const eff = effectiveBudget(budget, now);

    // 4. Enough headroom for the whole request → allow.
    if (eff.remaining >= args.requested) {
      return await decide('allow', 'within_budget', {
        remaining: eff.remaining
      });
    }

    // 5. Some budget remains, but less than requested → degrade. Not a hard
    // deny: the caller may proceed at reduced scope or request less.
    if (eff.remaining > 0) {
      return await decide('degrade', 'insufficient_remaining', {
        remaining: eff.remaining
      });
    }

    // 6. Nothing left → deny.
    return await decide('deny', 'budget_exhausted', {
      remaining: eff.remaining
    });
  }
});
