import {ConvexError} from 'convex/values';
import type {Infer} from 'convex/values';
import type {MutationCtx} from './_generated/server.js';
import type {Doc} from './_generated/dataModel.js';
import type {metadataValidator, principalTypeValidator} from './validators.js';

export type Metadata = Infer<typeof metadataValidator>;
export type PrincipalType = Infer<typeof principalTypeValidator>;

/**
 * Throw a machine-readable error. `code` is a stable identifier callers can
 * branch on via `ConvexError.data.code`; `message` is for humans.
 */
export function fail(code: string, message: string): never {
  throw new ConvexError({code, message});
}

export interface AuditEvent {
  eventType: string;
  principalType?: PrincipalType | null;
  principalId?: string | null;
  orgCode?: string | null;
  unit?: string | null;
  decision?: string | null;
  correlationId?: string | null;
  detail?: Metadata;
}

/**
 * Append one row to the audit log. Returns the correlationId (generated if
 * not supplied) so related events can share one.
 */
export async function writeAudit(
  ctx: MutationCtx,
  event: AuditEvent
): Promise<string> {
  const correlationId = event.correlationId ?? crypto.randomUUID();
  await ctx.db.insert('auditLog', {
    at: Date.now(),
    eventType: event.eventType,
    principalType: event.principalType ?? null,
    principalId: event.principalId ?? null,
    orgCode: event.orgCode ?? null,
    unit: event.unit ?? null,
    decision: event.decision ?? null,
    correlationId,
    detail: event.detail ?? {}
  });
  return correlationId;
}

export interface EffectiveBudget {
  remaining: number;
  periodStart: number | null;
  periodEnd: number | null;
  rolled: boolean;
}

/**
 * The budget as it behaves right now, derived on read without mutating the
 * stored row (invariant: a stale local window resets exactly when it elapses,
 * and a Kinde budget is never advanced by this component).
 *
 * A `kinde` budget is the external source of truth, so its stored
 * `{remaining, periodStart, periodEnd}` are returned unchanged with
 * `rolled:false`. A `local` budget with a complete, recurring window
 * (`periodCap`, `periodLengthMs`, `periodStart`, `periodEnd` all set) whose
 * `periodEnd` is at or before `now` rolls forward in whole periods — `start`
 * becomes the old `end`, `end` advances by `periodLengthMs` — until `now` falls
 * inside the window, and `remaining` resets to `periodCap` (`rolled:true`).
 * Anything else returns the stored values with `rolled:false`.
 */
export function effectiveBudget(
  budget: Pick<
    Doc<'budgets'>,
    | 'source'
    | 'remaining'
    | 'periodCap'
    | 'periodStart'
    | 'periodEnd'
    | 'periodLengthMs'
  >,
  now: number
): EffectiveBudget {
  if (budget.source !== 'local') {
    return {
      remaining: budget.remaining,
      periodStart: budget.periodStart,
      periodEnd: budget.periodEnd,
      rolled: false
    };
  }
  if (
    budget.periodCap !== null &&
    budget.periodLengthMs !== null &&
    budget.periodStart !== null &&
    budget.periodEnd !== null &&
    now >= budget.periodEnd
  ) {
    let start = budget.periodStart;
    let end = budget.periodEnd;
    while (now >= end) {
      start = end;
      end += budget.periodLengthMs;
    }
    return {
      remaining: budget.periodCap,
      periodStart: start,
      periodEnd: end,
      rolled: true
    };
  }
  return {
    remaining: budget.remaining,
    periodStart: budget.periodStart,
    periodEnd: budget.periodEnd,
    rolled: false
  };
}
