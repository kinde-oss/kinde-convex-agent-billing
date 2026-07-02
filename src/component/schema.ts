import {defineSchema, defineTable} from 'convex/server';
import {v} from 'convex/values';
import {
  budgetSourceValidator,
  metadataValidator,
  nullableNumber,
  nullableString,
  principalTypeValidator,
  transactionStatusValidator,
  transactionTypeValidator
} from './validators.js';

export default defineSchema({
  /**
   * One spendable budget per (principalType, principalId, orgCode, unit). A
   * `local` budget is owned and advanced by this component; a `kinde` budget
   * mirrors an external source of truth that the component never resets (see
   * `effectiveBudget`). `orgCode` is part of the identity so the same
   * principal/unit in two orgs are distinct, tenant-isolated budgets; a
   * null-org (single-tenant) budget is its own distinct key.
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
    .index('by_principal', ['principalType', 'principalId', 'orgCode', 'unit'])
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
   * Single-row cache for the Kinde M2M access token. `key` is always 'm2m';
   * the row is reused until shortly before `expiresAt`.
   */
  kindeTokenCache: defineTable({
    key: v.string(),
    accessToken: v.string(),
    expiresAt: v.number()
  }).index('by_key', ['key']),

  /**
   * Maps a local principal to its Kinde billing identifiers. Kinde-specific:
   * the spine never reads this — only the Kinde integration layer does.
   */
  kindeCustomers: defineTable({
    principalType: principalTypeValidator,
    principalId: v.string(),
    customerId: v.string(),
    customerAgreementId: nullableString
  })
    .index('by_principal', ['principalType', 'principalId'])
    .index('by_customer', ['customerId']),

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
    .index('by_org_event', ['orgCode', 'eventType', 'at'])
    .index('by_correlation', ['correlationId']),

  /**
   * A billing transaction with a forward-only lifecycle (see
   * `transactionStatusValidator`). `amount` carries the magnitude for
   * credit/cancellation; for a plan_change it is 0 and `planCode` carries the
   * target plan. No Kinde I/O ever happens against this row inside a mutation —
   * execution is an action.
   */
  transactions: defineTable({
    principalType: principalTypeValidator,
    principalId: v.string(),
    orgCode: nullableString,
    type: transactionTypeValidator,
    amount: v.number(),
    planCode: nullableString,
    isProrate: v.union(v.boolean(), v.null()),
    isInvoiceNow: v.union(v.boolean(), v.null()),
    status: transactionStatusValidator,
    approverSubject: nullableString,
    resolvedAt: nullableNumber,
    executedAt: nullableNumber,
    failureReason: nullableString,
    compensatedAt: nullableNumber,
    correlationId: nullableString,
    createdAt: v.number()
  })
    .index('by_principal', ['principalType', 'principalId', 'createdAt'])
    .index('by_principal_status', [
      'principalType',
      'principalId',
      'status',
      'createdAt'
    ])
    .index('by_status', ['status', 'createdAt']),

  /**
   * Per-principal transaction caps + approval policy. No policy row means no
   * caps and no approval required (a transaction is created directly approved).
   */
  transactionPolicies: defineTable({
    principalType: principalTypeValidator,
    principalId: v.string(),
    perTxCap: nullableNumber,
    perPeriodCap: nullableNumber,
    periodStart: nullableNumber,
    periodEnd: nullableNumber,
    periodLengthMs: nullableNumber,
    requireApproval: v.boolean()
  }).index('by_principal', ['principalType', 'principalId']),

  /**
   * Ingested Kinde billing webhook events (the eight `customer.*` triggers).
   * Each row is the verified, normalized claims of one signed JWT. `dedupKey`
   * (the JWT `jti`) makes a Kinde retry idempotent. The app subscribes to the
   * list/get queries to react to billing events.
   */
  webhookEvents: defineTable({
    eventType: v.string(),
    rawType: v.string(),
    dedupKey: v.string(),
    principalType: v.union(principalTypeValidator, v.null()),
    principalId: nullableString,
    customerId: nullableString,
    payload: metadataValidator,
    receivedAt: v.number(),
    processedAt: nullableNumber
  })
    .index('by_dedup', ['dedupKey'])
    .index('by_type', ['eventType', 'receivedAt'])
    .index('by_principal', ['principalType', 'principalId', 'receivedAt'])
    .index('by_principal_event', [
      'principalType',
      'principalId',
      'eventType',
      'receivedAt'
    ])
});
