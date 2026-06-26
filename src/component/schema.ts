import {defineSchema, defineTable} from 'convex/server';
import {v} from 'convex/values';
import {
  budgetSourceValidator,
  metadataValidator,
  nullableNumber,
  nullableString,
  principalTypeValidator
} from './validators.js';

export default defineSchema({
  /**
   * One spendable budget per (principalType, principalId, unit). A `local`
   * budget is owned and advanced by this component; a `kinde` budget mirrors
   * an external source of truth that the component never resets (see
   * `effectiveBudget`).
   */
  budgets: defineTable({
    principalType: principalTypeValidator,
    principalId: v.string(),
    orgCode: nullableString,
    unit: v.string(),
    remaining: v.number(),
    periodCap: nullableNumber,
    periodStart: nullableNumber,
    periodEnd: nullableNumber,
    periodLengthMs: nullableNumber,
    source: budgetSourceValidator,
    createdAt: v.number()
  })
    .index('by_principal', ['principalType', 'principalId', 'unit'])
    .index('by_org_code', ['orgCode']),

  /** Append-only record of every applied usage deduction. */
  usageEvents: defineTable({
    principalType: principalTypeValidator,
    principalId: v.string(),
    orgCode: nullableString,
    unit: v.string(),
    quantity: v.number(),
    idempotencyKey: v.string(),
    correlationId: nullableString,
    /** The mandate this spend was bound to, or null for an unbound record. */
    mandateId: v.union(v.id('mandates'), v.null()),
    at: v.number()
  })
    .index('by_principal', ['principalType', 'principalId', 'at'])
    .index('by_org_code', ['orgCode', 'at']),

  /**
   * A spend mandate: HMAC-signed authority for an agent to spend up to
   * `budgetCap` (running `budgetSpent`) of `unit` on behalf of a principal,
   * within `[notBefore, notAfter)`. Verifiable without external calls.
   * Revocation is the mutable `revokedAt` column (reactive: verify always
   * consults it), mirroring a delegation's `revokedAt` — not a separate table.
   */
  mandates: defineTable({
    principalType: principalTypeValidator,
    principalId: v.string(),
    orgCode: nullableString,
    agentSubject: v.string(),
    unit: v.string(),
    scope: v.array(v.string()),
    budgetCap: v.number(),
    budgetSpent: v.number(),
    notBefore: v.number(),
    notAfter: v.number(),
    revokedAt: nullableNumber,
    signature: v.string(),
    createdAt: v.number()
  })
    .index('by_principal', ['principalType', 'principalId'])
    .index('by_agent', ['agentSubject']),

  /**
   * Idempotency overlay. One row per (scope, idempotencyKey) records the
   * outcome of the first `usage.record` so a replay returns the original
   * result instead of decrementing again.
   */
  idempotencyKeys: defineTable({
    scope: v.string(),
    idempotencyKey: v.string(),
    requestFingerprint: v.string(),
    usageEventId: v.id('usageEvents'),
    remainingAfter: v.number(),
    at: v.number()
  }).index('by_scope_key', ['scope', 'idempotencyKey']),

  /** Append-only audit log. Never updated or deleted. */
  auditLog: defineTable({
    at: v.number(),
    eventType: v.string(),
    principalType: v.union(principalTypeValidator, v.null()),
    principalId: nullableString,
    orgCode: nullableString,
    unit: nullableString,
    decision: nullableString,
    correlationId: nullableString,
    detail: metadataValidator
  })
    .index('by_at', ['at'])
    .index('by_principal', ['principalType', 'principalId', 'at'])
    .index('by_org_code', ['orgCode', 'at'])
    .index('by_event_type', ['eventType', 'at'])
    .index('by_correlation', ['correlationId'])
});
