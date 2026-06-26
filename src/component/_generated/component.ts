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
    budgets: {
      get: FunctionReference<
        "query",
        "internal",
        {
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
  };
