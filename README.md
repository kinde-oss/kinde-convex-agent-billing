# Kinde Convex Agent Billing

The Kinde agent billing component for [Convex](https://convex.dev) — agent usage metering and billing, backed by Kinde.

[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](https://makeapullrequest.com) [![Kinde Docs](https://img.shields.io/badge/Kinde-Docs-eee?style=flat-square)](https://kinde.com/docs/developer-tools) [![Kinde Community](https://img.shields.io/badge/Kinde-Community-eee?style=flat-square)](https://thekindecommunity.slack.com)

## Development

This package is a Convex component plus a thin client. Day-to-day development:

- `npm install`: install the dependencies.
- `npm run build:codegen`: regenerate the component code and build it.
- `npm test`: run the full `convex-test` + `vitest` suite (with type-checking).
- `npm run typecheck`: type-check the package and the example app.
- `npm run lint`: run ESLint.
- `npm run format`: run Prettier over the repo.

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

### Composes with auth

`@kinde-oss/kinde-convex-agent-billing` and [`@kinde-oss/kinde-convex-agent-auth`](https://github.com/kinde-oss/kinde-convex-agent-auth) are siblings in the Kinde AgentKit. They pair at the app level through the subject and `verifyCaller` seam: auth resolves who the caller is, and billing meters and bounds what that principal may spend. Neither package imports the other, so you can adopt one without the other.

## Documentation

For details, see the [Kinde docs](https://docs.kinde.com), the [Kinde billing docs](https://docs.kinde.com/billing/), and the [Convex components docs](https://docs.convex.dev/components).

## Publishing

The Kinde core team handles publishing.

## Contributing

Please refer to Kinde’s [contributing guidelines](https://github.com/kinde-oss/.github/blob/489e2ca9c3307c2b2e098a885e22f2239116394a/CONTRIBUTING.md).

## License

By contributing to Kinde, you agree that your contributions will be licensed under its MIT License.
