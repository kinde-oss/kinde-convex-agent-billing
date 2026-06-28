<!-- Ideally, this should get auto-generated via tools like [auto-changelog](https://github.com/CookPete/auto-changelog). Eventually, this will get set up as part of the repository template. -->

## 0.1.0

Initial release of the Kinde agent billing Convex component.

- **Observe** — read the effective (live) budget, the stored budget, and a principal's usage history.
- **Meter** — atomic, idempotent usage recording that decrements the budget in a single serializable transaction; a replay returns the original outcome.
- **Enforce** — a single `check` gate returning a machine-readable `allow` / `deny` / `degrade` decision, with one audit row per call.
- **Delegate** — HMAC-signed spend mandates, verifiable without external calls, with a reactive revoke kill switch; a spend must fit both the principal budget and the mandate's remaining.
- **Transact** — transactions with per-transaction and per-period caps, a human approval flow, action-based execution, and refund/compensation; status only moves forward.
- **Kinde billing integration** — M2M usage metering, entitlement hydration into local budgets, and plan changes, with untrusted responses narrowed field-by-field.
- **Webhook ingestion** — the eight `customer.*` billing events delivered as Kinde-signed JWTs, verified against Kinde's JWKS, deduped so retries are idempotent, and surfaced as reactive state.
- **App-mounted HTTP seam** — `registerRoutes` mounts the webhook endpoint in the consuming app's `convex/http.ts`, with an optional `verifyCaller` slot for non-webhook routes.
- **Auth-agnostic subject seam** — every call takes a principal the app authenticates; the component never imports an auth package, so any auth (Kinde auth, Better Auth, custom) can supply the subject.
- **Example app** — a runnable reference app and an end-to-end integration test covering the full agent billing lifecycle.
