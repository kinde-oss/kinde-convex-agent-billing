import {v, ConvexError} from 'convex/values';
import type {Infer} from 'convex/values';
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query
} from './_generated/server.js';
import type {MutationCtx} from './_generated/server.js';
import type {Id} from './_generated/dataModel.js';
import {api, internal} from './_generated/api.js';
import schema from './schema.js';
import {fail, writeAudit} from './helpers.js';
import {
  nullableNumber,
  nullableString,
  principalTypeValidator,
  transactionStatusValidator,
  transactionTypeValidator
} from './validators.js';

const transactionDoc = schema.tables.transactions.validator.extend({
  _id: v.id('transactions'),
  _creationTime: v.number()
});

type TransactionStatus = Infer<typeof transactionStatusValidator>;

/** Statuses that count toward a per-period cap (in-flight or settled spend). */
const PERIOD_STATUSES = new Set(['pending', 'approved', 'executed']);

/**
 * Enforce the principal's transaction caps (HARDENING: reject, never coerce)
 * and report whether approval is required. No policy row → no caps and no
 * approval (the transaction is created directly `approved`).
 */
async function requestPolicyCheck(
  ctx: MutationCtx,
  principalType: 'user' | 'org' | 'agent',
  principalId: string,
  amount: number,
  now: number
): Promise<{requireApproval: boolean}> {
  const policy = await ctx.db
    .query('transactionPolicies')
    .withIndex('by_principal', (q) =>
      q.eq('principalType', principalType).eq('principalId', principalId)
    )
    .unique();
  if (policy === null) {
    return {requireApproval: false};
  }
  if (policy.perTxCap !== null && amount > policy.perTxCap) {
    fail('per_tx_cap_exceeded', 'amount exceeds the per-transaction cap.');
  }
  if (policy.perPeriodCap !== null) {
    // Compute the window read-only: roll a stale configured window forward to
    // the current one (no persistence), mirroring effectiveBudget's roll.
    let windowStart = policy.periodStart;
    let windowEnd = policy.periodEnd;
    if (
      windowStart !== null &&
      windowEnd !== null &&
      policy.periodLengthMs !== null &&
      now >= windowEnd
    ) {
      const periodLengthMs = policy.periodLengthMs;
      if (periodLengthMs <= 0) {
        fail('invalid_period', 'periodLengthMs must be greater than 0.');
      }
      // O(1) advance to the window that contains `now` (mirrors effectiveBudget).
      const elapsed = Math.floor((now - windowEnd) / periodLengthMs) + 1;
      windowStart = windowEnd + (elapsed - 1) * periodLengthMs;
      windowEnd = windowEnd + elapsed * periodLengthMs;
    }
    const rows = await ctx.db
      .query('transactions')
      .withIndex('by_principal', (q) =>
        q.eq('principalType', principalType).eq('principalId', principalId)
      )
      .collect();
    let sum = 0;
    for (const row of rows) {
      if (!PERIOD_STATUSES.has(row.status)) {
        continue;
      }
      if (
        windowStart !== null &&
        windowEnd !== null &&
        (row.createdAt < windowStart || row.createdAt >= windowEnd)
      ) {
        continue;
      }
      sum += row.amount;
    }
    if (sum + amount > policy.perPeriodCap) {
      fail('per_period_cap_exceeded', 'amount exceeds the per-period cap.');
    }
  }
  return {requireApproval: policy.requireApproval};
}

/**
 * Request a billing transaction. A `plan_change` carries a `planCode` and no
 * amount; a `credit`/`cancellation` carries a positive `amount` and no plan.
 * Caps are enforced here (request time). The transaction starts `pending` when
 * the policy requires approval, else directly `approved` (ready to execute).
 */
export const request = mutation({
  args: {
    principalType: principalTypeValidator,
    principalId: v.string(),
    orgCode: v.optional(nullableString),
    type: transactionTypeValidator,
    amount: v.optional(v.number()),
    planCode: v.optional(nullableString),
    isProrate: v.optional(v.boolean()),
    isInvoiceNow: v.optional(v.boolean()),
    correlationId: v.optional(nullableString)
  },
  returns: v.id('transactions'),
  handler: async (ctx, args) => {
    const now = Date.now();
    const orgCode = args.orgCode ?? null;
    const amount = args.amount ?? 0;
    const planCode = args.planCode ?? null;
    const correlationId = args.correlationId ?? null;

    // HARDENING: contradictory args are rejected, not coerced.
    if (args.type === 'plan_change') {
      if (planCode === null) {
        fail(
          'plan_change_requires_plan_code',
          'A plan_change transaction requires a planCode.'
        );
      }
      if (amount !== 0) {
        fail(
          'plan_change_amount_not_allowed',
          'A plan_change transaction must not carry an amount.'
        );
      }
    } else {
      if (amount <= 0) {
        fail(
          'amount_required',
          `A ${args.type} transaction requires amount > 0.`
        );
      }
      if (planCode !== null) {
        fail(
          'plan_code_not_allowed',
          `A ${args.type} transaction must not carry a planCode.`
        );
      }
    }

    const {requireApproval} = await requestPolicyCheck(
      ctx,
      args.principalType,
      args.principalId,
      amount,
      now
    );
    const status = requireApproval ? 'pending' : 'approved';
    const transactionId = await ctx.db.insert('transactions', {
      principalType: args.principalType,
      principalId: args.principalId,
      orgCode,
      type: args.type,
      amount,
      planCode,
      isProrate: args.isProrate ?? null,
      isInvoiceNow: args.isInvoiceNow ?? null,
      status,
      approverSubject: null,
      resolvedAt: null,
      executedAt: null,
      failureReason: null,
      compensatedAt: null,
      correlationId,
      createdAt: now
    });
    await writeAudit(ctx, {
      eventType: 'transaction.requested',
      principalType: args.principalType,
      principalId: args.principalId,
      orgCode,
      correlationId,
      detail: {
        type: args.type,
        amount,
        requireApproval,
        status
      }
    });
    return transactionId;
  }
});

/**
 * Approve a pending transaction. `approverSubject` is the step-up identity and
 * is required. Only a `pending` transaction can be approved; re-approving fails
 * (idempotency by rejection). A transaction created directly `approved` has no
 * pending step and so cannot be approved.
 */
export const approve = mutation({
  args: {transactionId: v.id('transactions'), approverSubject: v.string()},
  returns: v.null(),
  handler: async (ctx, args) => {
    return await resolve(ctx, args, 'approved', 'transaction.approved');
  }
});

/** Reject a pending transaction. Same pending-only and step-up rules. */
export const reject = mutation({
  args: {transactionId: v.id('transactions'), approverSubject: v.string()},
  returns: v.null(),
  handler: async (ctx, args) => {
    return await resolve(ctx, args, 'rejected', 'transaction.rejected');
  }
});

async function resolve(
  ctx: MutationCtx,
  args: {transactionId: Id<'transactions'>; approverSubject: string},
  status: 'approved' | 'rejected',
  eventType: string
): Promise<null> {
  if (args.approverSubject.length === 0) {
    fail(
      'approver_required',
      'approverSubject is required to resolve a transaction.'
    );
  }
  const tx = await ctx.db.get('transactions', args.transactionId);
  if (tx === null) {
    fail('transaction_not_found', 'No such transaction.');
  }
  if (tx.status !== 'pending') {
    fail('already_resolved', `Transaction is "${tx.status}", not "pending".`);
  }
  await ctx.db.patch('transactions', args.transactionId, {
    status,
    approverSubject: args.approverSubject,
    resolvedAt: Date.now()
  });
  await writeAudit(ctx, {
    eventType,
    principalType: tx.principalType,
    principalId: tx.principalId,
    orgCode: tx.orgCode,
    correlationId: tx.correlationId,
    detail: {approverSubject: args.approverSubject, type: tx.type}
  });
  return null;
}

export const getInternal = internalQuery({
  args: {transactionId: v.id('transactions')},
  returns: v.union(transactionDoc, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db.get('transactions', args.transactionId);
  }
});

/**
 * Atomically claim an approved transaction for execution (approved → executing).
 * Convex mutations are serializable, so of two concurrent executes only one
 * observes `approved` and wins the claim; the other observes `executing` and
 * gets `claimed:false`, so it never submits the outbound Kinde call. This is the
 * concurrency guard that makes `execute` safe against duplicate execution.
 */
export const claim = internalMutation({
  args: {transactionId: v.id('transactions')},
  returns: v.object({
    claimed: v.boolean(),
    status: transactionStatusValidator
  }),
  handler: async (ctx, args) => {
    const tx = await ctx.db.get('transactions', args.transactionId);
    if (tx === null) {
      fail('transaction_not_found', 'No such transaction.');
    }
    if (tx.status !== 'approved') {
      return {claimed: false, status: tx.status};
    }
    await ctx.db.patch('transactions', args.transactionId, {
      status: 'executing'
    });
    return {claimed: true, status: 'executing' as const};
  }
});

/** Flip a claimed (executing) transaction to executed and audit the transition. */
export const markExecuted = internalMutation({
  args: {transactionId: v.id('transactions')},
  returns: v.null(),
  handler: async (ctx, args) => {
    const tx = await ctx.db.get('transactions', args.transactionId);
    if (tx === null || tx.status !== 'executing') {
      return null;
    }
    await ctx.db.patch('transactions', args.transactionId, {
      status: 'executed',
      executedAt: Date.now()
    });
    await writeAudit(ctx, {
      eventType: 'transaction.executed',
      principalType: tx.principalType,
      principalId: tx.principalId,
      orgCode: tx.orgCode,
      correlationId: tx.correlationId,
      detail: {type: tx.type, amount: tx.amount}
    });
    return null;
  }
});

/** Flip a claimed (executing) transaction to failed and audit the transition. */
export const markFailed = internalMutation({
  args: {transactionId: v.id('transactions'), failureReason: v.string()},
  returns: v.null(),
  handler: async (ctx, args) => {
    const tx = await ctx.db.get('transactions', args.transactionId);
    if (tx === null || tx.status !== 'executing') {
      return null;
    }
    await ctx.db.patch('transactions', args.transactionId, {
      status: 'failed',
      failureReason: args.failureReason
    });
    await writeAudit(ctx, {
      eventType: 'transaction.failed',
      principalType: tx.principalType,
      principalId: tx.principalId,
      orgCode: tx.orgCode,
      correlationId: tx.correlationId,
      detail: {type: tx.type, failureReason: args.failureReason}
    });
    return null;
  }
});

/** Extract a stable, human-readable reason from a thrown error. */
function reasonOf(error: unknown): string {
  if (error instanceof ConvexError) {
    const {data} = error;
    if (typeof data === 'object' && data !== null && 'code' in data) {
      const code = (data as {code: unknown}).code;
      if (typeof code === 'string') {
        return code;
      }
    }
    if (typeof data === 'string') {
      return data;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Execute an approved transaction. This is an ACTION because Kinde I/O cannot
 * run inside a mutation: a `plan_change` calls the Phase 5 `kinde.changePlan`
 * action; `credit`/`cancellation` have no verified Kinde endpoint here, so they
 * execute locally (recorded + audited intent only — no invented Kinde call).
 *
 * Concurrency: the transaction is atomically claimed (approved → executing) via
 * an internalMutation BEFORE any outbound call, so two concurrent executes
 * cannot both submit the same plan change — the loser observes `executing` and
 * exits early without calling Kinde. Persistence of the resulting status flip
 * goes through internalMutations (the action → internalMutation split). On any
 * error the transaction flips to `failed`, never leaving partial state.
 */
export const execute = action({
  args: {transactionId: v.id('transactions')},
  returns: v.object({status: transactionStatusValidator}),
  handler: async (ctx, args): Promise<{status: TransactionStatus}> => {
    const tx = await ctx.runQuery(internal.transact.getInternal, {
      transactionId: args.transactionId
    });
    if (tx === null) {
      fail('transaction_not_found', 'No such transaction.');
    }
    if (tx.status !== 'approved') {
      fail('not_approved', `Transaction is "${tx.status}", not "approved".`);
    }
    if (tx.type === 'plan_change' && tx.planCode === null) {
      fail(
        'plan_change_requires_plan_code',
        'A plan_change transaction requires a planCode.'
      );
    }

    // Atomically claim before any outbound call. If another execute already
    // took it, exit early with the current status and do NOT call Kinde.
    const claimed = await ctx.runMutation(internal.transact.claim, {
      transactionId: args.transactionId
    });
    if (!claimed.claimed) {
      return {status: claimed.status};
    }

    if (tx.type === 'plan_change' && tx.planCode !== null) {
      try {
        await ctx.runAction(api.kinde.changePlan, {
          principalType: tx.principalType,
          principalId: tx.principalId,
          planCode: tx.planCode,
          ...(tx.isProrate === null ? {} : {isProrate: tx.isProrate}),
          ...(tx.isInvoiceNow === null ? {} : {isInvoiceNow: tx.isInvoiceNow})
        });
      } catch (error) {
        await ctx.runMutation(internal.transact.markFailed, {
          transactionId: args.transactionId,
          failureReason: reasonOf(error)
        });
        return {status: 'failed' as const};
      }
    }
    // credit / cancellation execute locally (no Kinde call).
    await ctx.runMutation(internal.transact.markExecuted, {
      transactionId: args.transactionId
    });
    return {status: 'executed' as const};
  }
});

/**
 * Compensate an executed transaction. Only an `executed` transaction can be
 * compensated; the effect here is local and audited (transactions are not
 * unit-scoped, so no budget row is touched and no Kinde refund endpoint is
 * invented — the compensation is the forward status flip plus the audited
 * reversal of `amount`). Idempotent: an already-compensated transaction is a
 * no-op.
 */
export const refund = mutation({
  args: {transactionId: v.id('transactions'), reason: v.string()},
  returns: v.null(),
  handler: async (ctx, args) => {
    const tx = await ctx.db.get('transactions', args.transactionId);
    if (tx === null) {
      fail('transaction_not_found', 'No such transaction.');
    }
    if (tx.status === 'compensated') {
      return null;
    }
    if (tx.status !== 'executed') {
      fail('not_executed', `Transaction is "${tx.status}", not "executed".`);
    }
    await ctx.db.patch('transactions', args.transactionId, {
      status: 'compensated',
      compensatedAt: Date.now()
    });
    await writeAudit(ctx, {
      eventType: 'transaction.compensated',
      principalType: tx.principalType,
      principalId: tx.principalId,
      orgCode: tx.orgCode,
      correlationId: tx.correlationId,
      detail: {
        type: tx.type,
        reason: args.reason,
        reversedAmount: tx.type === 'credit' ? tx.amount : 0
      }
    });
    return null;
  }
});

/** Upsert a principal's transaction caps + approval policy. */
export const setPolicy = mutation({
  args: {
    principalType: principalTypeValidator,
    principalId: v.string(),
    perTxCap: v.optional(nullableNumber),
    perPeriodCap: v.optional(nullableNumber),
    periodStart: v.optional(nullableNumber),
    periodEnd: v.optional(nullableNumber),
    periodLengthMs: v.optional(nullableNumber),
    requireApproval: v.boolean()
  },
  returns: v.id('transactionPolicies'),
  handler: async (ctx, args) => {
    const perTxCap = args.perTxCap ?? null;
    const perPeriodCap = args.perPeriodCap ?? null;
    const periodStart = args.periodStart ?? null;
    const periodEnd = args.periodEnd ?? null;
    const periodLengthMs = args.periodLengthMs ?? null;

    if (perTxCap !== null && perTxCap < 0) {
      fail('invalid_cap', 'perTxCap must be >= 0.');
    }
    if (perPeriodCap !== null && perPeriodCap < 0) {
      fail('invalid_cap', 'perPeriodCap must be >= 0.');
    }
    const anyPeriodField =
      periodStart !== null || periodEnd !== null || periodLengthMs !== null;
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
      if (periodLengthMs === null || periodLengthMs <= 0) {
        fail(
          'invalid_period',
          'A rolling period window requires periodLengthMs > 0.'
        );
      }
    }

    const existing = await ctx.db
      .query('transactionPolicies')
      .withIndex('by_principal', (q) =>
        q
          .eq('principalType', args.principalType)
          .eq('principalId', args.principalId)
      )
      .unique();
    let policyId: Id<'transactionPolicies'>;
    if (existing !== null) {
      await ctx.db.patch('transactionPolicies', existing._id, {
        perTxCap,
        perPeriodCap,
        periodStart,
        periodEnd,
        periodLengthMs,
        requireApproval: args.requireApproval
      });
      policyId = existing._id;
    } else {
      policyId = await ctx.db.insert('transactionPolicies', {
        principalType: args.principalType,
        principalId: args.principalId,
        perTxCap,
        perPeriodCap,
        periodStart,
        periodEnd,
        periodLengthMs,
        requireApproval: args.requireApproval
      });
    }
    await writeAudit(ctx, {
      eventType: 'transaction.policy_set',
      principalType: args.principalType,
      principalId: args.principalId,
      detail: {
        perTxCap,
        perPeriodCap,
        requireApproval: args.requireApproval
      }
    });
    return policyId;
  }
});

export const get = query({
  args: {transactionId: v.id('transactions')},
  returns: v.union(transactionDoc, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db.get('transactions', args.transactionId);
  }
});

export const listForPrincipal = query({
  args: {
    principalType: principalTypeValidator,
    principalId: v.string(),
    status: v.optional(transactionStatusValidator),
    limit: v.optional(v.number())
  },
  returns: v.array(transactionDoc),
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 200);
    const {principalType, principalId, status} = args;
    const rows = await ctx.db
      .query('transactions')
      .withIndex('by_principal', (q) =>
        q.eq('principalType', principalType).eq('principalId', principalId)
      )
      .order('desc')
      .take(limit);
    return status === undefined
      ? rows
      : rows.filter((row) => row.status === status);
  }
});
