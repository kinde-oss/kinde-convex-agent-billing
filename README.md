# Kinde Convex Agent Billing

The Kinde agent billing component for [Convex](https://convex.dev) — agent usage metering and billing, backed by Kinde.

[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](https://makeapullrequest.com) [![Kinde Docs](https://img.shields.io/badge/Kinde-Docs-eee?style=flat-square)](https://kinde.com/docs/developer-tools) [![Kinde Community](https://img.shields.io/badge/Kinde-Community-eee?style=flat-square)](https://thekindecommunity.slack.com)

## Development

This package is a Convex component plus a thin client. Day-to-day development:

- `npm install`: install the dependencies.
- `npm run build`: compile the package to `dist/`.
- `npm run build:codegen`: regenerate the component code and build it.
- `npm test`: run the full `convex-test` + `vitest` suite (with type-checking).
- `npm run typecheck`: type-check the package and the example app.
- `npm run lint`: run ESLint.
- `npm run format`: run Prettier over the repo.

**Build before you test on a fresh clone.** The example app imports the component as a package (`@kinde-oss/kinde-convex-agent-billing`), which resolves to the built output in `dist/`. With no `dist/`, `npm test` fails in `example/convex/` with:

```
Error: Failed to resolve entry for package "@kinde-oss/kinde-convex-agent-billing".
The package may have incorrect main/module/exports specified in its package.json.
```

That message points at `package.json`, but on a fresh clone the cause is almost always the missing build. Run `npm run build` (or `npm run build:codegen`, which does both) first.

Two things make this easy to misdiagnose. **`npm run typecheck` passes cleanly with no `dist/`** — it reads source, not the built package — so a green typecheck next to a red test suite is expected here and is not a contradiction. And only the example-app suites fail (`e2e.test.ts`, `http.test.ts`); the component's own tests pass, because they import from source. A partial failure confined to `example/` is the signature. The same applies to a _stale_ `dist/`: tests then run against old code, so if a failure looks impossible — a symbol that exists but is "missing", an arg you just added being rejected — rebuild before debugging further.

The `example/` directory is a runnable reference app that installs the component via `app.use` and exercises every layer end to end; `example/convex/example.ts` shows the intended usage of each function and `example/convex/e2e.test.ts` tells the full story as one test.

### Initial set up

1. Clone the repository to your machine:

   ```bash
   git clone https://github.com/kinde-oss/kinde-convex-agent-billing.git
   ```

2. Go into the project:

   ```bash
   cd kinde-convex-agent-billing
   ```

3. Install the dependencies:

   ```bash
   npm install
   ```

4. Regenerate the component code and build:

   ```bash
   npm run build:codegen
   ```

5. Run the tests:

   ```bash
   npm test
   ```

## Usage

This component gives a Convex app a complete billing story for autonomous and supervised agents: it tracks spendable budgets, records usage atomically and idempotently, decides every spend through a single `check` gate, issues HMAC-signed spend mandates with a reactive kill switch, runs capped transactions through an approval flow, integrates with Kinde billing (usage metering, entitlement hydration, plan changes), and ingests Kinde's signed billing webhooks as reactive state. Billing is Kinde-only; the authentication of the caller is a separate, agnostic concern (see the auth seam below).

### Security model

Read this before exposing any of this component to the network. Its functions are raw machinery with **no authentication of their own** — the host app is the security boundary. This component spends money and mutates billing state, so an unwrapped function is a direct financial loss, not just a data leak.

1. **Component mutations are not authenticated.** A Convex component cannot see the host app's auth context (`ctx.auth`), so every mutation, query and action here is callable by whatever surface the host app exposes. Nothing in the component checks _who_ is calling; that is the app's job. Treat each function as machinery to wrap, not an endpoint to expose.

2. **Admin-only functions — never expose these publicly.** Wrap each in an app-layer function that authenticates a human or admin first: `budgets.set`, `mandates.mint`, `mandates.revoke`, `transact.setPolicy`, `transact.approve`, `transact.reject`, `kinde.setCustomerMapping`, `kinde.syncEntitlements`, and `kinde.changePlan`. Also admin-only and easy to miss: `transact.request` (with no policy configured a transaction is created **already approved** — see [Contracts and behavior](#contracts-and-behavior)), `transact.execute` and `transact.refund` (real money movement), and `webhooks.markProcessed`.

3. **`kinde.getAccessToken` returns your Kinde M2M bearer token.** It is a credential, not a billing result. It exists for the component's own outbound actions — never wrap it in an app function. A caller who obtains that token can call Kinde's Management API as your entire tenant, well beyond anything billing-related.

4. **Agent-facing endpoints must NEVER accept a client-supplied `principalType`, `principalId`, or `orgCode`.** These three arguments say who gets billed and which tenant they belong to. Taking any of them from the request body or a header lets a caller meter their spend against any other principal, or read across tenants. Derive the principal from `@kinde-oss/kinde-convex-agent-auth`'s `verifyCaller` and pass **the verified identity** into billing — `orgCode` in particular must come from the token's `org_code` claim, which is that component's binding tenant contract. See [Composing with agent-auth](#composing-with-agent-auth) for the wiring.

5. **A mandate-bound `usage.record` must pass the verified `callerAgentSubject`.** Every mandate is minted for one specific agent (its signed `agentSubject`), and `usage.record` re-checks that binding at spend time against the `callerAgentSubject` the call asserts: a mismatch fails with `mandate_agent_subject_mismatch`, and omitting it on a mandate-bound call fails with `caller_subject_required`. That check is only as good as its input — `callerAgentSubject` must be `verifyCaller`'s `VerifiedAgent.subject`, never an argument the caller chose. Let a caller pass its own `callerAgentSubject` and the mandate's agent binding becomes a formality: anyone holding a mandate id can claim to be the agent it was minted for.

6. **`transact.approve` / `transact.reject` take `approverSubject` as a trusted string.** The component stores it verbatim as the record of who approved the spend; it cannot tell a real approver from an attacker-chosen string. This is the same class of trusted input as the elevation approver in agent-auth, whose `POST /agent/elevation/respond` route fails closed with a **501** unless the app mounts an `authorizeApprover` hook. Hold this component's approval path to that same standard: supply `approverSubject` from a **verified human session** (e.g. a Kinde user access token), never from the request body — the body is attacker-controlled and must never be read for approver identity. An agent must not be able to approve its own transaction.

7. **Two reads are deployment-wide — `webhooks.listRecent` and `audit.query`.** Neither is scoped to a tenant, so both are operator views that are safe only behind a verified caller.

   `webhooks.listRecent` takes no principal and no `orgCode`, so it returns every tenant's billing events. `registerRoutes` mounts its reader (`POST /events/recent`) **only** when you supply a `verifyCaller`, so that route fails closed by not existing. For per-principal reads, use `webhooks.listForPrincipal` instead. (The `/webhooks/kinde` ingestion route is a separate concern: its authenticity comes from the Kinde-signed JWT verified against JWKS, not from `verifyCaller`.)

   `audit.query` is the sharper of the two and needs human/admin auth, not merely a verified caller. **Every one of its filters is optional**, so an unfiltered call returns the whole audit log across every tenant: spend amounts and balances, minted mandates and their `agentSubject`s, approver subjects, plan changes. It has no route guard to fall back on — `registerRoutes` never exposes it, so your wrapper is the only thing in front of it. Critically, **a caller-supplied filter is not tenant isolation**: passing `orgCode` through from request input scopes nothing, because a caller who omits the argument gets everything. Bind the filter to the org the caller was _verified_ to be in, and never wire either query to an unauthenticated public query.

8. **Tenant isolation is enforced on the spend path, not on list reads.** The two halves of this component treat `orgCode` differently, and the asymmetry is easy to misread in the safe direction. Spending is org-isolated: `budgets` is keyed by `[principalType, principalId, orgCode, unit]`, a budget in another org is simply not found, and a mandate from another tenant is rejected with `mandate_tenant_mismatch`. **The list queries are not.** `usage.listForPrincipal`, `mandates.listForPrincipal`, `mandates.listForAgent`, `transact.listForPrincipal` and `webhooks.listForPrincipal` are all keyed on the principal with **no `orgCode`**, so each returns that principal's rows across every org they act in. This is deliberate — one principal's own history reads as one list — but it means **an org-scoped admin view must not be built directly on them**: showing org A's admin `usage.listForPrincipal` for a principal also shows what that principal did in org B. Only `usageEvents` and `auditLog` have a `by_org_code` index to read per-org; for mandates and transactions you must filter `orgCode` in the app after reading. Related: `transact.setPolicy` caps are per-principal, not per-org, so a per-period cap sums a principal's transactions across all their orgs.

9. **The example app is deliberately insecure — do not copy it into production.** `example/convex/example.ts` resolves the caller from a raw `X-Subject` header (`resolveSubject`). That is a placeholder standing in for "verify the request and return the authenticated subject", and it lets any caller impersonate any principal. The example wrappers also take `principalType`/`principalId` as plain arguments to keep each function's intent readable. Its `recentAudit` is the sharpest instance of point 7: a public query forwarding every optional filter from client input, so an unfiltered call returns the whole deployment's audit log. None of these patterns is safe. For the real pattern, see [Composing with agent-auth](#composing-with-agent-auth) and [Composing with agent-tools](#composing-with-agent-tools).

### Install and wire up

Install the package:

```bash
npm i @kinde-oss/kinde-convex-agent-billing
```

Add the component to your app's `convex/convex.config.ts` and wire its environment variables:

```ts
import {defineApp} from 'convex/server';
import {v} from 'convex/values';
import agentBilling from '@kinde-oss/kinde-convex-agent-billing/convex.config.js';

const app = defineApp({
  env: {
    MANDATE_SIGNING_SECRET: v.string(),
    KINDE_ISSUER_URL: v.string(),
    KINDE_M2M_CLIENT_ID: v.string(),
    KINDE_M2M_CLIENT_SECRET: v.string()
  }
});

app.use(agentBilling, {
  env: {
    MANDATE_SIGNING_SECRET: app.env.MANDATE_SIGNING_SECRET,
    KINDE_ISSUER_URL: app.env.KINDE_ISSUER_URL,
    KINDE_M2M_CLIENT_ID: app.env.KINDE_M2M_CLIENT_ID,
    KINDE_M2M_CLIENT_SECRET: app.env.KINDE_M2M_CLIENT_SECRET
  }
});

export default app;
```

The component reads these environment variables:

| Variable | Required | Purpose |
| --- | --- | --- |
| `MANDATE_SIGNING_SECRET` | yes | Secret used to HMAC-sign mandates. |
| `KINDE_ISSUER_URL` | yes | Your Kinde issuer/base URL, e.g. `https://acme.kinde.com` (no trailing slash). |
| `KINDE_M2M_CLIENT_ID` | yes | Kinde M2M application client id for Management/billing API calls. |
| `KINDE_M2M_CLIENT_SECRET` | yes | Kinde M2M application client secret. |
| `MODE` | no | `test` relaxes external Kinde calls for local development; defaults to `live`. |

Set them with `npx convex env set`:

```bash
npx convex env set KINDE_ISSUER_URL https://acme.kinde.com
npx convex env set KINDE_M2M_CLIENT_ID your-m2m-client-id
npx convex env set KINDE_M2M_CLIENT_SECRET your-m2m-client-secret
npx convex env set MANDATE_SIGNING_SECRET a-long-random-secret
```

Construct the client once:

```ts
// convex/agentBilling.ts
import {AgentBilling} from '@kinde-oss/kinde-convex-agent-billing';
import {components} from './_generated/api.js';

export const agentBilling = new AgentBilling(components.agentBilling);
```

Mount the webhook route in your `convex/http.ts` (the route runs in your app's context, where it can verify the request):

```ts
import {httpRouter} from 'convex/server';
import {registerRoutes} from '@kinde-oss/kinde-convex-agent-billing';
import {components} from './_generated/api.js';

const http = httpRouter();
registerRoutes(http, components.agentBilling);
export default http;
```

This mounts `POST /billing/webhooks/kinde`. Kinde delivers each billing event as a signed JWT, which the route verifies against Kinde's JWKS. The route returns 200 on an ingested, duplicate, or unsupported (ignored) event so Kinde stops retrying; it returns 401 on a failed signature and 400 on a malformed body. See `RegisterRoutesOptions` for `pathPrefix` and the optional `verifyCaller` hook.

### The auth seam — the stable contract

Every billing call takes a `subject` (the principal: `principalType` plus `principalId`) that the APP has already authenticated. The billing component never imports an auth package and never reads `ctx.auth`: the app resolves the caller's identity and passes the resulting principal into the billing functions. This keeps authentication an agnostic axis while billing stays Kinde-only.

`registerRoutes` also accepts an optional `verifyCaller`-shaped slot on `RegisterRoutesOptions` for authenticating a direct or cross-app caller of a non-webhook route. It is app-supplied and throws to reject. It is a separate concern from webhook authenticity: the webhook route never uses `verifyCaller`, because a webhook's authenticity is the Kinde-signed JWT verified against JWKS.

Any auth can supply the subject: Kinde auth, Better Auth, or a custom scheme. Kinde auth is the documented default, via the sibling `@kinde-oss/kinde-convex-agent-auth`.

### Capabilities

| Layer | What it does |
| --- | --- |
| Observe | Read the effective (live) budget, the stored budget, and a principal's usage history (`getBudget`, `getRawBudget`, `listUsage`). |
| Meter | Atomic, idempotent usage recording that decrements the budget in one transaction (`record`). |
| Enforce | A single `check` gate that returns a machine-readable `allow` / `deny` / `degrade` decision and audits it. |
| Delegate | HMAC-signed spend mandates, verifiable without external calls, with a reactive revoke kill switch (`mintMandate`, `verifyMandate`, `revokeMandate`). |
| Transact | Transactions with per-transaction and per-period caps, a human approval flow, execution, and refund/compensation (`requestTransaction`, `approveTransaction`, `executeTransaction`, `refundTransaction`). |
| Kinde integration | Report metered usage to Kinde, hydrate local budgets from Kinde entitlements, and change a customer's plan (`pushUsageToKinde`, `syncEntitlements`, `changePlan`). |
| Webhooks | Ingest the eight `customer.*` billing events from JWKS-verified signed JWTs, dedup retries, and surface them as reactive state (`listWebhookEvents`, `getWebhookEvent`). |

### Composing with agent-auth

`@kinde-oss/kinde-convex-agent-billing` and [`@kinde-oss/kinde-convex-agent-auth`](https://github.com/kinde-oss/kinde-convex-agent-auth) are siblings in the Kinde AgentKit. They pair at the app level through the subject and `verifyCaller` seam: auth resolves who the caller is, and billing meters and bounds what that principal may spend. Neither package imports the other, so you can adopt one without the other.

**Billing trusts its caller completely.** It has no way to check a token, so whoever calls it must be the code that verified one. That makes the wiring rule simple: an agent-facing billing endpoint verifies first, then meters against the identity the verification returned — never against identity read from the request body.

The order matters as much as the pieces. Verification must happen before any billing call, in the same function, with the verified value flowing directly into it. Verifying a token and then billing a principal taken from `args` is the confused-deputy bug with extra steps.

```ts
// convex/agentUsage.ts
import {action} from './_generated/server.js';
import {components} from './_generated/api.js';
import {v} from 'convex/values';
import type {FunctionArgs} from 'convex/server';
import {AgentAuth} from '@kinde-oss/kinde-convex-agent-auth';
import {AgentBilling} from '@kinde-oss/kinde-convex-agent-billing';

const agentAuth = new AgentAuth(components.agentAuth);
const agentBilling = new AgentBilling(components.agentBilling);

type RecordArgs = FunctionArgs<typeof components.agentBilling.usage.record>;

/**
 * The canonical agent-facing metering endpoint: verify, then record. Note what
 * the args do NOT contain — no principalId, no orgCode, no callerAgentSubject.
 * The caller says what it did; it never says who pays for it.
 */
export const recordAgentUsage = action({
  args: {
    token: v.string(),
    unit: v.string(),
    quantity: v.number(),
    idempotencyKey: v.string(),
    mandateId: v.optional(v.string())
  },
  handler: async (ctx, args) => {
    // 1. Verify the caller's Kinde token. This throws on an invalid, expired,
    //    or unregistered token, so nothing below runs for an unverified caller.
    const caller = await agentAuth.verifyCaller(ctx, args.token);

    // 2. An unbound spend bills the agent itself, using only verified fields.
    if (args.mandateId === undefined) {
      return await agentBilling.record(ctx, {
        principalType: 'agent',
        principalId: caller.agentId ?? caller.subject,
        orgCode: caller.orgCode,
        unit: args.unit,
        quantity: args.quantity,
        idempotencyKey: args.idempotencyKey
      });
    }

    // 3. A mandate-bound spend bills the principal the MANDATE names, read from
    //    the stored mandate — not from the request. The caller supplies only the
    //    mandate id; the mandate itself supplies the payer, and `usage.record`
    //    re-checks that this agent is the one the mandate was minted for.
    const mandateId = args.mandateId as NonNullable<RecordArgs['mandateId']>;
    const mandate = await agentBilling.getMandate(ctx, {mandateId});
    if (mandate === null) {
      throw new Error('no such mandate');
    }
    return await agentBilling.record(ctx, {
      principalType: mandate.principalType,
      principalId: mandate.principalId,
      orgCode: mandate.orgCode,
      unit: args.unit,
      quantity: args.quantity,
      idempotencyKey: args.idempotencyKey,
      mandateId,
      // The verified subject, straight from verifyCaller. A mandate minted for
      // another agent fails here with `mandate_agent_subject_mismatch`; omitting
      // this on a mandate-bound call fails with `caller_subject_required`.
      callerAgentSubject: caller.subject
    });
  }
});
```

Three details worth copying exactly:

- **`orgCode` comes from `caller.orgCode`** (agent-auth's trusted `org_code` claim), or from the mandate. Billing scopes every budget lookup by `orgCode`, so an org taken from the request body is a cross-tenant read waiting to happen.
- **`callerAgentSubject` is `caller.subject`**, never `args`. This is the input that makes the mandate's agent binding real; see point 5 of the [Security model](#security-model). The name is deliberate: `callerAgentSubject` is the identity the caller _asserts_, checked against the `agentSubject` _signed into the mandate_ at mint time. They are two different values, and only one of them is trustworthy on its own.
- **Admin flows are the mirror image.** `mandates.mint`, `budgets.set` and `transact.approve` are wrapped behind a verified _human_ session, not `verifyCaller`. An agent's token authorizes spending within a mandate; it never authorizes minting one.

#### When the endpoint also gates an action: `authorize`

`verifyCaller` answers "who is this?". If the endpoint also has to answer "may they do this?", use agent-auth's `authorize` instead — it verifies the token **and** decides the action against an instance in one call, returning `{caller, decision}`. Its `caller` is the same `VerifiedAgent`, so it feeds billing identically.

Prefer it whenever an instance is in play. agent-auth's own guidance is that an app taking `instanceId` from request input must never call `authz.can` without the caller identity threaded in — that is the confused-deputy bug, and `authorize` always threads it. Note that a denial comes back as `decision.allowed === false`; only an invalid token throws.

This is also where the [`check` → `record` contract](#contracts-and-behavior) shows up in real code — authorize, gate, act, then meter what actually happened:

```ts
import type {AuthorizeOptions} from '@kinde-oss/kinde-convex-agent-auth';

// Instance ids surface in the app as plain strings; this recovers the branded
// type `authorize` expects, the same way `RecordArgs` does above.
type AuthorizeInstanceId = AuthorizeOptions['instanceId'];

// `runCompletion` is YOUR work — whatever the agent actually does. It reports
// what it consumed, which is what step 4 meters.
declare function runCompletion(
  prompt: string,
  maxTokens: number
): Promise<{tokensUsed: number}>;

export const runAgentTask = action({
  args: {token: v.string(), instanceId: v.string(), prompt: v.string()},
  handler: async (ctx, args) => {
    // 1. Verify the token AND authorize the action, bound to the instance.
    const {caller, decision} = await agentAuth.authorize(ctx, args.token, {
      instanceId: args.instanceId as AuthorizeInstanceId,
      action: 'llm.complete'
    });
    if (!decision.allowed) {
      return {status: 'denied' as const, reason: decision.reason};
    }

    const principal = {
      principalType: 'agent' as const,
      principalId: caller.agentId ?? caller.subject,
      orgCode: caller.orgCode
    };

    // 2. Gate on budget, using the VERIFIED principal. Advisory only — this
    //    reserves nothing, so `estimate` is a plan, not a reservation.
    const estimate = 1000;
    const gate = await agentBilling.check(ctx, {
      ...principal,
      unit: 'tokens',
      requested: estimate
    });
    if (gate.decision === 'deny') {
      return {status: 'denied' as const, reason: gate.reason};
    }

    // 3. On `degrade` the gate is offering less than we asked for. Shrink the
    //    work to fit — spending the full estimate anyway is what the advisory
    //    contract forbids.
    const ceiling =
      gate.decision === 'degrade' ? (gate.remaining ?? 0) : estimate;
    const {tokensUsed} = await runCompletion(args.prompt, ceiling);

    // 4. Meter what was ACTUALLY consumed. This is the enforcement point: if a
    //    concurrent call drained the budget since step 2, this throws
    //    `budget_exceeded` — the gate's `allow` was never a guarantee.
    return await agentBilling.record(ctx, {
      ...principal,
      unit: 'tokens',
      quantity: tokensUsed,
      idempotencyKey: `${args.instanceId}:${caller.subject}:${Date.now()}`
    });
  }
});
```

The ordering is the point. Authorization decides _whether_, the gate shapes _how much_, and `record` is the only step that moves the budget — so it is the only step that can fail on contention. Steps 2 and 4 both take their principal from `caller`, never from `args`; `args` carries the work to do, never the identity to bill.

### Composing with agent-tools

[`@kinde-oss/kinde-convex-agent-tools`](https://github.com/kinde-oss/kinde-convex-agent-tools) gates tool calls, and exposes a `billingCheck` seam so a tool call can be denied on budget. The seam is an app-supplied `FunctionReference` to a **mutation**; the tools spine invokes it in the same transaction through a `FunctionHandle`, so neither component imports the other. Billing plugs in through a small host mutation that adapts one shape to the other.

The two shapes do not line up on their own, which is the whole job of the adapter:

| agent-tools sends (`BillingCheckPayload`) | billing's `enforce.check` needs |
| --- | --- |
| `subject: string` | `principalType` + `principalId` |
| `tool: string` | `unit` |
| `argDigest: string` (redacted — never raw args) | `requested: number` |
| `correlationId: string` | `correlationId` (pass straight through) |
| — | `orgCode` |

The gaps are deliberate. The digest is redacted, so **you cannot price a call from its arguments** — the cost must come from the tool name. And the payload carries no `orgCode`, so if your budgets are org-scoped the adapter has to resolve the tenant from the subject; with null-org budgets, omit it.

```ts
// convex/toolBilling.ts
import {mutation} from './_generated/server.js';
import {components} from './_generated/api.js';
import {
  billingCheckPayloadValidator,
  billingCheckResultValidator
} from '@kinde-oss/kinde-convex-agent-tools';
import {AgentBilling} from '@kinde-oss/kinde-convex-agent-billing';

const agentBilling = new AgentBilling(components.agentBilling);

// What each tool call costs, and in which unit. The digest is redacted, so this
// is the only place a price can come from.
const PRICES: Record<string, {unit: string; quantity: number}> = {
  'search.web': {unit: 'tool_calls', quantity: 1},
  'llm.complete': {unit: 'tokens', quantity: 1000}
};

export const toolBillingCheck = mutation({
  args: billingCheckPayloadValidator.fields,
  returns: billingCheckResultValidator,
  handler: async (ctx, args) => {
    const price = PRICES[args.tool];
    // An unpriced tool is a gap in the table, not a free call — deny it.
    if (price === undefined) {
      return {allow: false, reason: 'unpriced_tool'};
    }

    const gate = await agentBilling.check(ctx, {
      principalType: 'agent',
      principalId: args.subject,
      unit: price.unit,
      requested: price.quantity,
      // THREAD THIS. The tools spine discards our `reason` (see below), so this
      // shared id is the only thing linking its `budget_exceeded` deny row to
      // the billing decision row that records the actual cause.
      correlationId: args.correlationId
    });

    // Collapse three states into the seam's boolean. `degrade` means some budget
    // remains but less than requested; a tool call is all-or-nothing at a fixed
    // price, so it cannot be afforded — deny.
    return gate.decision === 'allow'
      ? {allow: true}
      : {allow: false, reason: gate.reason};
  }
});
```

Wire it in when constructing the tools client (or per HTTP route):

```ts
const agentTools = new AgentTools(components.agentTools, {
  billingCheck: api.toolBilling.toolBillingCheck
});
```

Three contracts to keep in view:

- **The seam runtime-validates the return.** Anything other than `{allow: boolean, reason?: string}` is a typed `billing_check_malformed` failure in the tools component, never coerced into an allow. Return the shape exactly.
- **Your `reason` is validated, then discarded.** The tools spine requires it to be a string if present, but denies with its own hardcoded `budget_exceeded` regardless of what you return — your text reaches neither the tools audit row nor the HTTP response. So a denied tool call tells you only _that_ billing said no, never _why_. The cause lives in billing's own `billing.decision` audit row, and `correlationId` is the only thing that joins the two. Thread it, and expect to look in two places when debugging a denial.
- **`check` is advisory and reserves nothing** — see [Contracts and behavior](#contracts-and-behavior). This is the sharpest edge in the whole integration: **the seam is check-only, and there is no seam for recording.** The tools component asks "may they?" and never tells you what was consumed, so a `billingCheck` that returns `allow: true` and stops there decrements nothing and bills nobody. `usage.record` is the only thing that moves a budget, and calling it is entirely on you — after the tool runs, from the code that ran it, metering what it actually used. Wire the gate and forget the meter and you get a system that authorizes spend forever against a budget that never falls. With no `billingCheck` configured, the tools budget step is skipped entirely.

### Contracts and behavior

Three behaviors that are easy to assume wrongly. Each is a deliberate design choice, not an oversight.

#### `check` is advisory — `record` is the enforcement point

`enforce.check` decides and audits; it **never reserves budget**. An `allow` describes that instant and promises nothing about the next one, because nothing is held on the caller's behalf.

The practical consequences:

- **Two concurrent checks can both return `allow`** for a request only one of them can afford. Neither answer is wrong. `usage.record` is where the conflict is settled: its atomic, idempotent decrement serializes the winner and rejects the loser with `budget_exceeded`. That mutation — not the gate — is the real enforcement point.
- **On `degrade`, record no more than the returned `remaining`.** A `degrade` means "some budget is left, but less than you asked for". It is the gate offering a smaller spend, not permission for the original one.
- **An `allow` you never record bills nobody.** `check` moves no money. Every allowed spend still has to be metered with `usage.record`.
- **The gate is budget-only and mandate-blind.** `check` takes no `mandateId` and never reads the mandates table. A mandate is a _second_, independent bound that only `usage.record` enforces, so `allow` says nothing about whether a mandate-bound record will succeed: with a principal budget of 1000 and a mandate with 10 remaining, `check({requested: 500})` returns `allow` and `record` then rejects with `mandate_budget_exceeded`. An agent spending under a mandate must treat the mandate's own remaining (via `mandates.get`) as the real ceiling. This also applies to the [agent-tools seam](#composing-with-agent-tools), which wires `billingCheck` to `check`: a tool call the gate allows can still fail at record time.

So `check` is for shaping behavior before you act — degrade a response, pick a cheaper model, warn a user. It is not a lock, and treating it as one over-counts what you can afford under concurrency.

#### No transaction policy means auto-approved

`transact.request` is **not default-deny**. With no policy row for a principal, there are no caps and no approval step: the transaction is created already `approved` and is immediately executable.

A principal gets caps and human approval only once `transact.setPolicy` has run for it with `requireApproval: true`. Absence of a policy is absence of restriction. Call `setPolicy` before letting any principal request transactions — especially an agent.

#### Audit-only fields

These are stored (and, where noted, signed) but never evaluated in any decision. They mirror the audit-only fields in agent-auth (`resource` / `resources`).

| Field | On | Status |
| --- | --- | --- |
| `scope` | `mandates.mint` | **Audit metadata only.** Signed into the mandate and attenuable via `intersectMandate`, but never evaluated by `usage.record`. Do not rely on it for scope-based enforcement. |

**Limitations.** Spend decisions are budget-, mandate- and identity-based only today. **Scope binding is not implemented**: a mandate scoped to `['chat.completions']` will not reject a spend for anything else, so do not assume scope-level enforcement exists. `scope` is signed, so it cannot be _tampered_ with after minting — but an untampered value that nothing checks still gates nothing. Enforce it in the app layer if you rely on it.

The axes `usage.record` does enforce are:

| Axis | Failure code |
| --- | --- |
| Signature, revocation, validity window | `mandate_bad_signature`, `mandate_revoked`, `mandate_not_yet_valid`, `mandate_expired` |
| Bound agent (mandate's signed `agentSubject` vs the call's `callerAgentSubject`) | `mandate_agent_subject_mismatch`, `caller_subject_required` |
| Principal | `mandate_principal_mismatch` |
| Tenant (`orgCode`) | `mandate_tenant_mismatch` |
| Unit | `mandate_unit_mismatch` |
| Remaining mandate budget | `mandate_budget_exceeded` |

Every one of these fails closed: the mutation writes nothing and the budget is untouched.

## Documentation

For details, see the [Kinde docs](https://docs.kinde.com), the [Kinde billing docs](https://docs.kinde.com/billing/), and the [Convex components docs](https://docs.convex.dev/components).

## Publishing

The Kinde core team handles publishing.

## Contributing

Please refer to Kinde’s [contributing guidelines](https://github.com/kinde-oss/.github/blob/489e2ca9c3307c2b2e098a885e22f2239116394a/CONTRIBUTING.md).

## License

By contributing to Kinde, you agree that your contributions will be licensed under its MIT License.
