/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    audit: {
      query: FunctionReference<
        "query",
        "internal",
        {
          endAt?: number;
          eventType?: string;
          orgCode?: string;
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
          principalId?: string;
          principalType?: "user" | "org" | "agent";
          startAt?: number;
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            _creationTime: number;
            _id: string;
            at: number;
            correlationId: string | null;
            decision: string | null;
            detail: Record<
              string,
              string | number | boolean | null | Array<string>
            >;
            eventType: string;
            orgCode: string | null;
            principalId: string | null;
            principalType: "user" | "org" | "agent" | null;
            unit: string | null;
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        },
        Name
      >;
    };
    budgets: {
      get: FunctionReference<
        "query",
        "internal",
        {
          orgCode?: string | null;
          principalId: string;
          principalType: "user" | "org" | "agent";
          unit: string;
        },
        {
          _creationTime: number;
          _id: string;
          createdAt: number;
          orgCode: string | null;
          periodCap: number | null;
          periodEnd: number | null;
          periodLengthMs: number | null;
          periodStart: number | null;
          principalId: string;
          principalType: "user" | "org" | "agent";
          remaining: number;
          source: "local" | "kinde";
          unit: string;
        } | null,
        Name
      >;
      getEffective: FunctionReference<
        "query",
        "internal",
        {
          orgCode?: string | null;
          principalId: string;
          principalType: "user" | "org" | "agent";
          unit: string;
        },
        {
          periodCap: number | null;
          periodEnd: number | null;
          periodStart: number | null;
          remaining: number;
          rolled: boolean;
          source: "local" | "kinde";
          unit: string;
        } | null,
        Name
      >;
      set: FunctionReference<
        "mutation",
        "internal",
        {
          orgCode?: string | null;
          periodCap?: number | null;
          periodEnd?: number | null;
          periodLengthMs?: number | null;
          periodStart?: number | null;
          principalId: string;
          principalType: "user" | "org" | "agent";
          remaining: number;
          unit: string;
        },
        string,
        Name
      >;
    };
    enforce: {
      check: FunctionReference<
        "mutation",
        "internal",
        {
          correlationId?: string | null;
          orgCode?: string | null;
          principalId: string;
          principalType: "user" | "org" | "agent";
          requested: number;
          unit: string;
        },
        {
          correlationId: string;
          decision: "allow" | "deny" | "degrade";
          reason: string;
          remaining: number | null;
          requested: number;
        },
        Name
      >;
    };
    kinde: {
      changePlan: FunctionReference<
        "action",
        "internal",
        {
          isInvoiceNow?: boolean;
          isProrate?: boolean;
          planCode: string;
          principalId: string;
          principalType: "user" | "org" | "agent";
        },
        { changed: boolean },
        Name
      >;
      getAccessToken: FunctionReference<"action", "internal", {}, string, Name>;
      pushUsage: FunctionReference<
        "action",
        "internal",
        {
          billingFeatureCode: string;
          idempotencyKey: string;
          meterValue: number;
          principalId: string;
          principalType: "user" | "org" | "agent";
        },
        { reported: boolean },
        Name
      >;
      setCustomerMapping: FunctionReference<
        "mutation",
        "internal",
        {
          customerAgreementId?: string | null;
          customerId: string;
          principalId: string;
          principalType: "user" | "org" | "agent";
        },
        string,
        Name
      >;
      syncEntitlements: FunctionReference<
        "action",
        "internal",
        {
          billingFeatureCode: string;
          orgCode?: string | null;
          principalId: string;
          principalType: "user" | "org" | "agent";
          unit: string;
        },
        { found: boolean; limit: number | null; remaining: number | null },
        Name
      >;
      verifyWebhook: FunctionReference<
        "action",
        "internal",
        { token: string },
        {
          customerId: string | null;
          dedupKey: string;
          payload: Record<
            string,
            string | number | boolean | null | Array<string>
          >;
          rawType: string;
        },
        Name
      >;
    };
    mandates: {
      get: FunctionReference<
        "query",
        "internal",
        { mandateId: string },
        {
          _creationTime: number;
          _id: string;
          agentSubject: string;
          budgetCap: number;
          budgetSpent: number;
          createdAt: number;
          notAfter: number;
          notBefore: number;
          orgCode: string | null;
          principalId: string;
          principalType: "user" | "org" | "agent";
          revokedAt: number | null;
          scope: Array<string>;
          signature: string;
          unit: string;
        } | null,
        Name
      >;
      listForAgent: FunctionReference<
        "query",
        "internal",
        { agentSubject: string; limit?: number },
        Array<{
          _creationTime: number;
          _id: string;
          agentSubject: string;
          budgetCap: number;
          budgetSpent: number;
          createdAt: number;
          notAfter: number;
          notBefore: number;
          orgCode: string | null;
          principalId: string;
          principalType: "user" | "org" | "agent";
          revokedAt: number | null;
          scope: Array<string>;
          signature: string;
          unit: string;
        }>,
        Name
      >;
      listForPrincipal: FunctionReference<
        "query",
        "internal",
        {
          limit?: number;
          principalId: string;
          principalType: "user" | "org" | "agent";
        },
        Array<{
          _creationTime: number;
          _id: string;
          agentSubject: string;
          budgetCap: number;
          budgetSpent: number;
          createdAt: number;
          notAfter: number;
          notBefore: number;
          orgCode: string | null;
          principalId: string;
          principalType: "user" | "org" | "agent";
          revokedAt: number | null;
          scope: Array<string>;
          signature: string;
          unit: string;
        }>,
        Name
      >;
      mint: FunctionReference<
        "mutation",
        "internal",
        {
          agentSubject: string;
          budgetCap: number;
          notAfter: number;
          notBefore?: number;
          orgCode?: string | null;
          principalId: string;
          principalType: "user" | "org" | "agent";
          scope: Array<string>;
          unit: string;
        },
        string,
        Name
      >;
      revoke: FunctionReference<
        "mutation",
        "internal",
        { mandateId: string; reason?: string },
        null,
        Name
      >;
      verify: FunctionReference<
        "query",
        "internal",
        { mandateId: string },
        { valid: true } | { code: string; reason: string; valid: false },
        Name
      >;
    };
    transact: {
      approve: FunctionReference<
        "mutation",
        "internal",
        { approverSubject: string; transactionId: string },
        null,
        Name
      >;
      execute: FunctionReference<
        "action",
        "internal",
        { transactionId: string },
        {
          status:
            | "pending"
            | "approved"
            | "executing"
            | "rejected"
            | "executed"
            | "failed"
            | "compensated";
        },
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        { transactionId: string },
        {
          _creationTime: number;
          _id: string;
          amount: number;
          approverSubject: string | null;
          compensatedAt: number | null;
          correlationId: string | null;
          createdAt: number;
          executedAt: number | null;
          failureReason: string | null;
          isInvoiceNow: boolean | null;
          isProrate: boolean | null;
          orgCode: string | null;
          planCode: string | null;
          principalId: string;
          principalType: "user" | "org" | "agent";
          resolvedAt: number | null;
          status:
            | "pending"
            | "approved"
            | "executing"
            | "rejected"
            | "executed"
            | "failed"
            | "compensated";
          type: "plan_change" | "credit" | "cancellation";
        } | null,
        Name
      >;
      listForPrincipal: FunctionReference<
        "query",
        "internal",
        {
          limit?: number;
          principalId: string;
          principalType: "user" | "org" | "agent";
          status?:
            | "pending"
            | "approved"
            | "executing"
            | "rejected"
            | "executed"
            | "failed"
            | "compensated";
        },
        Array<{
          _creationTime: number;
          _id: string;
          amount: number;
          approverSubject: string | null;
          compensatedAt: number | null;
          correlationId: string | null;
          createdAt: number;
          executedAt: number | null;
          failureReason: string | null;
          isInvoiceNow: boolean | null;
          isProrate: boolean | null;
          orgCode: string | null;
          planCode: string | null;
          principalId: string;
          principalType: "user" | "org" | "agent";
          resolvedAt: number | null;
          status:
            | "pending"
            | "approved"
            | "executing"
            | "rejected"
            | "executed"
            | "failed"
            | "compensated";
          type: "plan_change" | "credit" | "cancellation";
        }>,
        Name
      >;
      refund: FunctionReference<
        "mutation",
        "internal",
        { reason: string; transactionId: string },
        null,
        Name
      >;
      reject: FunctionReference<
        "mutation",
        "internal",
        { approverSubject: string; transactionId: string },
        null,
        Name
      >;
      request: FunctionReference<
        "mutation",
        "internal",
        {
          amount?: number;
          correlationId?: string | null;
          isInvoiceNow?: boolean;
          isProrate?: boolean;
          orgCode?: string | null;
          planCode?: string | null;
          principalId: string;
          principalType: "user" | "org" | "agent";
          type: "plan_change" | "credit" | "cancellation";
        },
        string,
        Name
      >;
      setPolicy: FunctionReference<
        "mutation",
        "internal",
        {
          perPeriodCap?: number | null;
          perTxCap?: number | null;
          periodEnd?: number | null;
          periodLengthMs?: number | null;
          periodStart?: number | null;
          principalId: string;
          principalType: "user" | "org" | "agent";
          requireApproval: boolean;
        },
        string,
        Name
      >;
    };
    usage: {
      getEvent: FunctionReference<
        "query",
        "internal",
        { usageEventId: string },
        {
          _creationTime: number;
          _id: string;
          at: number;
          correlationId: string | null;
          idempotencyKey: string;
          mandateId: string | null;
          orgCode: string | null;
          principalId: string;
          principalType: "user" | "org" | "agent";
          quantity: number;
          unit: string;
        } | null,
        Name
      >;
      listForPrincipal: FunctionReference<
        "query",
        "internal",
        {
          limit?: number;
          principalId: string;
          principalType: "user" | "org" | "agent";
        },
        Array<{
          _creationTime: number;
          _id: string;
          at: number;
          correlationId: string | null;
          idempotencyKey: string;
          mandateId: string | null;
          orgCode: string | null;
          principalId: string;
          principalType: "user" | "org" | "agent";
          quantity: number;
          unit: string;
        }>,
        Name
      >;
      record: FunctionReference<
        "mutation",
        "internal",
        {
          correlationId?: string | null;
          idempotencyKey: string;
          mandateId?: string;
          orgCode?: string | null;
          principalId: string;
          principalType: "user" | "org" | "agent";
          quantity: number;
          unit: string;
        },
        {
          remaining: number;
          status: "applied" | "deduplicated";
          usageEventId: string;
        },
        Name
      >;
    };
    webhooks: {
      get: FunctionReference<
        "query",
        "internal",
        { eventId: string },
        {
          _creationTime: number;
          _id: string;
          customerId: string | null;
          dedupKey: string;
          eventType: string;
          payload: Record<
            string,
            string | number | boolean | null | Array<string>
          >;
          principalId: string | null;
          principalType: "user" | "org" | "agent" | null;
          processedAt: number | null;
          rawType: string;
          receivedAt: number;
        } | null,
        Name
      >;
      listForPrincipal: FunctionReference<
        "query",
        "internal",
        {
          eventType?: string;
          limit?: number;
          principalId: string;
          principalType: "user" | "org" | "agent";
        },
        Array<{
          _creationTime: number;
          _id: string;
          customerId: string | null;
          dedupKey: string;
          eventType: string;
          payload: Record<
            string,
            string | number | boolean | null | Array<string>
          >;
          principalId: string | null;
          principalType: "user" | "org" | "agent" | null;
          processedAt: number | null;
          rawType: string;
          receivedAt: number;
        }>,
        Name
      >;
      listRecent: FunctionReference<
        "query",
        "internal",
        { eventType?: string; limit?: number },
        Array<{
          _creationTime: number;
          _id: string;
          customerId: string | null;
          dedupKey: string;
          eventType: string;
          payload: Record<
            string,
            string | number | boolean | null | Array<string>
          >;
          principalId: string | null;
          principalType: "user" | "org" | "agent" | null;
          processedAt: number | null;
          rawType: string;
          receivedAt: number;
        }>,
        Name
      >;
      markProcessed: FunctionReference<
        "mutation",
        "internal",
        { eventId: string },
        null,
        Name
      >;
      receive: FunctionReference<
        "action",
        "internal",
        { token: string },
        { id: string; status: "ingested" | "duplicate" },
        Name
      >;
    };
  };
