import {action, mutation, query} from './_generated/server.js';
import {components} from './_generated/api.js';
import {AgentBilling} from '@kinde-oss/kinde-convex-agent-billing';
import {paginationOptsValidator} from 'convex/server';
import type {FunctionArgs} from 'convex/server';
import {v} from 'convex/values';

/**
 * The component client. Construct it once with the component reference from the
 * app's generated `components` object, then call its thin wrapper methods (or
 * the component API directly, as the functions below show both styles).
 */
export const agentBilling = new AgentBilling(components.agentBilling);

// Component ids surface in the app as opaque strings; these aliases recover the
// exact branded id types each component function expects, so the wrappers can
// accept plain `v.string()` and pass them through type-safely.
type RecordArgs = FunctionArgs<typeof components.agentBilling.usage.record>;
type MandateVerifyArgs = FunctionArgs<
  typeof components.agentBilling.mandates.verify
>;
type MandateRevokeArgs = FunctionArgs<
  typeof components.agentBilling.mandates.revoke
>;
type TxApproveArgs = FunctionArgs<
  typeof components.agentBilling.transact.approve
>;
type TxRejectArgs = FunctionArgs<
  typeof components.agentBilling.transact.reject
>;
type TxExecuteArgs = FunctionArgs<
  typeof components.agentBilling.transact.execute
>;
type TxRefundArgs = FunctionArgs<
  typeof components.agentBilling.transact.refund
>;
type TxGetArgs = FunctionArgs<typeof components.agentBilling.transact.get>;
type WebhookGetArgs = FunctionArgs<typeof components.agentBilling.webhooks.get>;

// Local copies of the component's enums, so the app's public validators do not
// reach into the component package's internals.
const principalType = v.union(
  v.literal('user'),
  v.literal('org'),
  v.literal('agent')
);
const nullableNumber = v.union(v.number(), v.null());
const nullableString = v.union(v.string(), v.null());
const budgetSource = v.union(v.literal('local'), v.literal('kinde'));
const decision = v.union(
  v.literal('allow'),
  v.literal('deny'),
  v.literal('degrade')
);
const txType = v.union(
  v.literal('plan_change'),
  v.literal('credit'),
  v.literal('cancellation')
);
const txStatus = v.union(
  v.literal('pending'),
  v.literal('approved'),
  v.literal('executing'),
  v.literal('rejected'),
  v.literal('executed'),
  v.literal('failed'),
  v.literal('compensated')
);

/**
 * AUTH SEAM (app level). The billing component is auth-agnostic: every call
 * takes a principal the APP has already authenticated.
 *
 * EXAMPLE ONLY — INSECURE AS WRITTEN. In production this MUST resolve the
 * principal from AUTHENTICATED app context: verify a session cookie or a bearer
 * JWT against your auth provider (the blessed default is pairing with
 * `@kinde-oss/kinde-convex-agent-auth`'s `verifyCaller`) and return the subject
 * it proves. Trusting a raw header/body value like the `X-Subject` below lets a
 * caller impersonate any principal — NEVER do this. The resolved, authenticated
 * subject is what should be passed as `principalId` into the billing calls.
 */
export async function resolveSubject(request: Request): Promise<string> {
  // Placeholder for "verify the request and return the authenticated subject".
  const subject = request.headers.get('X-Subject');
  if (subject === null || subject.length === 0) {
    throw new Error('unauthenticated');
  }
  return subject;
}

export const health = query({
  args: {},
  returns: v.string(),
  handler: async () => 'ok'
});

// IMPORTANT (auth seam): the wrappers below take `principalType`/`principalId`
// as arguments because the component is auth-agnostic — the APP decides who the
// principal is. In production these MUST come from AUTHENTICATED app context
// (the subject your auth resolves; see `resolveSubject`), NOT from raw,
// unauthenticated client input. Passing a caller's chosen principal straight
// through would let them meter/spend/mutate against any tenant. Functions that
// take an explicit principal here model admin / server-side / delegated flows
// (budget seeding, mapping, plan changes) where the app has already authorized
// acting for that principal; they are not caller-facing entrypoints.

// --- Budget administration (local mode) ---

/** Set a LOCAL budget for a principal+unit (client style). */
export const setBudget = mutation({
  args: {
    principalType,
    principalId: v.string(),
    unit: v.string(),
    remaining: v.number(),
    orgCode: v.optional(nullableString),
    periodCap: v.optional(nullableNumber),
    periodStart: v.optional(nullableNumber),
    periodEnd: v.optional(nullableNumber),
    periodLengthMs: v.optional(nullableNumber)
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    return await agentBilling.setBudget(ctx, args);
  }
});

/** Read the effective (live) budget, reflecting a due local rollover. */
export const getBudget = query({
  args: {principalType, principalId: v.string(), unit: v.string()},
  returns: v.union(
    v.object({
      remaining: v.number(),
      periodStart: nullableNumber,
      periodEnd: nullableNumber,
      periodCap: nullableNumber,
      unit: v.string(),
      source: budgetSource,
      rolled: v.boolean()
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    return await agentBilling.getBudget(ctx, args);
  }
});

/** Read the stored budget row, projected to a small summary. */
export const getRawBudget = query({
  args: {principalType, principalId: v.string(), unit: v.string()},
  returns: v.union(
    v.object({
      remaining: v.number(),
      periodCap: nullableNumber,
      source: budgetSource,
      orgCode: nullableString
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    const row = await agentBilling.getRawBudget(ctx, args);
    if (row === null) {
      return null;
    }
    return {
      remaining: row.remaining,
      periodCap: row.periodCap,
      source: row.source,
      orgCode: row.orgCode
    };
  }
});

// --- Meter ---

/**
 * Record metered usage (the spine). `mandateId` optionally binds the spend to a
 * mandate; the plain string is recovered to the branded id via the alias.
 */
export const recordUsage = mutation({
  args: {
    principalType,
    principalId: v.string(),
    orgCode: v.optional(nullableString),
    unit: v.string(),
    quantity: v.number(),
    idempotencyKey: v.string(),
    correlationId: v.optional(nullableString),
    mandateId: v.optional(v.string()),
    // Required by the component whenever `mandateId` is set. In production this
    // MUST be the subject proved by `verifyCaller` (see `resolveSubject`), never
    // an arg the caller chose — that would defeat the mandate's agent binding.
    callerAgentSubject: v.optional(v.string())
  },
  returns: v.object({
    status: v.union(v.literal('applied'), v.literal('deduplicated')),
    usageEventId: v.string(),
    remaining: v.number()
  }),
  handler: async (ctx, args) => {
    return await agentBilling.record(ctx, {
      principalType: args.principalType,
      principalId: args.principalId,
      unit: args.unit,
      quantity: args.quantity,
      idempotencyKey: args.idempotencyKey,
      ...(args.orgCode === undefined ? {} : {orgCode: args.orgCode}),
      ...(args.correlationId === undefined
        ? {}
        : {correlationId: args.correlationId}),
      ...(args.mandateId === undefined
        ? {}
        : {mandateId: args.mandateId as RecordArgs['mandateId']}),
      ...(args.callerAgentSubject === undefined
        ? {}
        : {callerAgentSubject: args.callerAgentSubject})
    });
  }
});

// --- Enforce ---

/** Ask the gate whether a spend is allowed (advisory, audited, read-only). */
export const checkSpend = mutation({
  args: {
    principalType,
    principalId: v.string(),
    orgCode: v.optional(nullableString),
    unit: v.string(),
    requested: v.number(),
    correlationId: v.optional(nullableString)
  },
  returns: v.object({
    decision,
    reason: v.string(),
    remaining: nullableNumber,
    requested: v.number(),
    correlationId: v.string()
  }),
  handler: async (ctx, args) => {
    return await agentBilling.check(ctx, args);
  }
});

// --- Delegate (mandates) ---

/** Mint an HMAC-signed spend mandate (direct component-call style). */
export const mintMandate = mutation({
  args: {
    principalType,
    principalId: v.string(),
    orgCode: v.optional(nullableString),
    agentSubject: v.string(),
    unit: v.string(),
    scope: v.array(v.string()),
    budgetCap: v.number(),
    notBefore: v.optional(v.number()),
    notAfter: v.number()
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    return await ctx.runMutation(components.agentBilling.mandates.mint, args);
  }
});

/** Verify a mandate by id (recovering the branded id from a plain string). */
export const verifyMandate = query({
  args: {mandateId: v.string()},
  returns: v.union(
    v.object({valid: v.literal(true)}),
    v.object({valid: v.literal(false), code: v.string(), reason: v.string()})
  ),
  handler: async (ctx, args) => {
    return await agentBilling.verifyMandate(ctx, {
      mandateId: args.mandateId as MandateVerifyArgs['mandateId']
    });
  }
});

/** Revoke a mandate (reactive kill switch). */
export const revokeMandate = mutation({
  args: {mandateId: v.string(), reason: v.optional(v.string())},
  returns: v.null(),
  handler: async (ctx, args) => {
    await agentBilling.revokeMandate(ctx, {
      mandateId: args.mandateId as MandateRevokeArgs['mandateId'],
      ...(args.reason === undefined ? {} : {reason: args.reason})
    });
    return null;
  }
});

/** List a principal's mandates, projected to a summary. */
export const listMandatesForPrincipal = query({
  args: {principalType, principalId: v.string(), limit: v.optional(v.number())},
  returns: v.array(
    v.object({
      id: v.string(),
      agentSubject: v.string(),
      unit: v.string(),
      scope: v.array(v.string()),
      budgetCap: v.number(),
      budgetSpent: v.number(),
      revokedAt: nullableNumber
    })
  ),
  handler: async (ctx, args) => {
    const rows = await agentBilling.listMandatesForPrincipal(ctx, args);
    return rows.map((row) => ({
      id: row._id,
      agentSubject: row.agentSubject,
      unit: row.unit,
      scope: row.scope,
      budgetCap: row.budgetCap,
      budgetSpent: row.budgetSpent,
      revokedAt: row.revokedAt
    }));
  }
});

// --- Transact (with caps + approvals) ---

/** Set a principal's transaction caps + approval policy. */
export const setTransactionPolicy = mutation({
  args: {
    principalType,
    principalId: v.string(),
    perTxCap: v.optional(nullableNumber),
    perPeriodCap: v.optional(nullableNumber),
    periodStart: v.optional(nullableNumber),
    periodEnd: v.optional(nullableNumber),
    periodLengthMs: v.optional(nullableNumber),
    requireApproval: v.boolean()
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    return await agentBilling.setTransactionPolicy(ctx, args);
  }
});

/** Request a transaction (pending if the policy requires approval). */
export const requestTransaction = mutation({
  args: {
    principalType,
    principalId: v.string(),
    orgCode: v.optional(nullableString),
    type: txType,
    amount: v.optional(v.number()),
    planCode: v.optional(nullableString),
    isProrate: v.optional(v.boolean()),
    isInvoiceNow: v.optional(v.boolean()),
    correlationId: v.optional(nullableString)
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    return await agentBilling.requestTransaction(ctx, args);
  }
});

/** Approve a pending transaction (the app authenticates the approver). */
export const approveTransaction = mutation({
  args: {transactionId: v.string(), approverSubject: v.string()},
  returns: v.null(),
  handler: async (ctx, args) => {
    await agentBilling.approveTransaction(ctx, {
      transactionId: args.transactionId as TxApproveArgs['transactionId'],
      approverSubject: args.approverSubject
    });
    return null;
  }
});

/** Reject a pending transaction. */
export const rejectTransaction = mutation({
  args: {transactionId: v.string(), approverSubject: v.string()},
  returns: v.null(),
  handler: async (ctx, args) => {
    await agentBilling.rejectTransaction(ctx, {
      transactionId: args.transactionId as TxRejectArgs['transactionId'],
      approverSubject: args.approverSubject
    });
    return null;
  }
});

/** Execute an approved transaction (action — Kinde I/O for plan_change). */
export const executeTransaction = action({
  args: {transactionId: v.string()},
  returns: v.object({status: txStatus}),
  handler: async (ctx, args) => {
    return await agentBilling.executeTransaction(ctx, {
      transactionId: args.transactionId as TxExecuteArgs['transactionId']
    });
  }
});

/** Compensate an executed transaction. */
export const refundTransaction = mutation({
  args: {transactionId: v.string(), reason: v.string()},
  returns: v.null(),
  handler: async (ctx, args) => {
    await agentBilling.refundTransaction(ctx, {
      transactionId: args.transactionId as TxRefundArgs['transactionId'],
      reason: args.reason
    });
    return null;
  }
});

/** Read a transaction, projected to a summary. */
export const getTransaction = query({
  args: {transactionId: v.string()},
  returns: v.union(
    v.object({
      id: v.string(),
      type: txType,
      amount: v.number(),
      status: txStatus,
      planCode: nullableString,
      failureReason: nullableString
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    const row = await agentBilling.getTransaction(ctx, {
      transactionId: args.transactionId as TxGetArgs['transactionId']
    });
    if (row === null) {
      return null;
    }
    return {
      id: row._id,
      type: row.type,
      amount: row.amount,
      status: row.status,
      planCode: row.planCode,
      failureReason: row.failureReason
    };
  }
});

// --- Kinde billing integration ---

/** Map a principal to its Kinde billing customer/agreement. */
export const setKindeCustomer = mutation({
  args: {
    principalType,
    principalId: v.string(),
    customerId: v.string(),
    customerAgreementId: v.optional(nullableString)
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    return await agentBilling.setKindeCustomer(ctx, args);
  }
});

/** Report metered usage to Kinde (outbound; the local decrement already ran). */
export const pushUsageToKinde = action({
  args: {
    principalType,
    principalId: v.string(),
    billingFeatureCode: v.string(),
    meterValue: v.number(),
    idempotencyKey: v.string()
  },
  returns: v.object({reported: v.boolean()}),
  handler: async (ctx, args) => {
    return await agentBilling.pushUsageToKinde(ctx, args);
  }
});

/** Sync a Kinde entitlement into a local kinde-source budget. */
export const syncEntitlements = action({
  args: {
    principalType,
    principalId: v.string(),
    orgCode: v.optional(nullableString),
    unit: v.string(),
    billingFeatureCode: v.string()
  },
  returns: v.object({
    found: v.boolean(),
    remaining: nullableNumber,
    limit: nullableNumber
  }),
  handler: async (ctx, args) => {
    return await agentBilling.syncEntitlements(ctx, args);
  }
});

/** Change a customer's Kinde billing plan. */
export const changePlan = action({
  args: {
    principalType,
    principalId: v.string(),
    planCode: v.string(),
    isProrate: v.optional(v.boolean()),
    isInvoiceNow: v.optional(v.boolean())
  },
  returns: v.object({changed: v.boolean()}),
  handler: async (ctx, args) => {
    return await agentBilling.changePlan(ctx, args);
  }
});

// --- Webhooks (reactive reads the app subscribes to) ---

/** List a principal's ingested Kinde webhook events, projected to a summary. */
export const listWebhookEvents = query({
  args: {
    principalType,
    principalId: v.string(),
    eventType: v.optional(v.string()),
    limit: v.optional(v.number())
  },
  returns: v.array(
    v.object({
      id: v.string(),
      eventType: v.string(),
      dedupKey: v.string(),
      principalId: nullableString,
      customerId: nullableString,
      receivedAt: v.number()
    })
  ),
  handler: async (ctx, args) => {
    const rows = await agentBilling.listWebhookEvents(ctx, args);
    return rows.map((row) => ({
      id: row._id,
      eventType: row.eventType,
      dedupKey: row.dedupKey,
      principalId: row.principalId,
      customerId: row.customerId,
      receivedAt: row.receivedAt
    }));
  }
});

/** Read one webhook event by id, projected to a summary. */
export const getWebhookEvent = query({
  args: {eventId: v.string()},
  returns: v.union(
    v.object({
      id: v.string(),
      eventType: v.string(),
      dedupKey: v.string(),
      customerId: nullableString
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    const row = await agentBilling.getWebhookEvent(ctx, {
      eventId: args.eventId as WebhookGetArgs['eventId']
    });
    if (row === null) {
      return null;
    }
    return {
      id: row._id,
      eventType: row.eventType,
      dedupKey: row.dedupKey,
      customerId: row.customerId
    };
  }
});

// --- Audit (paginated, filterable, read-only) ---

const auditRow = v.object({
  _id: v.string(),
  _creationTime: v.number(),
  at: v.number(),
  eventType: v.string(),
  principalType: v.union(principalType, v.null()),
  principalId: nullableString,
  orgCode: nullableString,
  unit: nullableString,
  decision: nullableString,
  correlationId: nullableString,
  detail: v.record(
    v.string(),
    v.union(v.string(), v.number(), v.boolean(), v.null(), v.array(v.string()))
  )
});

/**
 * A paginated, filterable read of the audit trail (direct component-call style).
 *
 * EXAMPLE ONLY — INSECURE AS WRITTEN, AND THE WORST OFFENDER IN THIS FILE. It is
 * a PUBLIC query that forwards every filter straight from client input, and each
 * one is optional — so calling it with no filters at all returns the ENTIRE audit
 * log for EVERY tenant: spend, balances, mandate agentSubjects, approver
 * subjects. The optional filters are not tenant isolation; they are a convenience
 * a caller can simply decline. In production this MUST authenticate a human/admin
 * first and then bind `orgCode`/principal to the VERIFIED session — never accept
 * them as args like this. See the Security model section of the README.
 */
export const recentAudit = query({
  args: {
    paginationOpts: paginationOptsValidator,
    principalType: v.optional(principalType),
    principalId: v.optional(v.string()),
    orgCode: v.optional(v.string()),
    eventType: v.optional(v.string())
  },
  returns: v.object({
    page: v.array(auditRow),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(
      v.union(
        v.literal('SplitRecommended'),
        v.literal('SplitRequired'),
        v.null()
      )
    )
  }),
  handler: async (ctx, args) => {
    return await ctx.runQuery(components.agentBilling.audit.query, {
      paginationOpts: args.paginationOpts,
      ...(args.principalType === undefined
        ? {}
        : {principalType: args.principalType}),
      ...(args.principalId === undefined
        ? {}
        : {principalId: args.principalId}),
      ...(args.orgCode === undefined ? {} : {orgCode: args.orgCode}),
      ...(args.eventType === undefined ? {} : {eventType: args.eventType})
    });
  }
});
