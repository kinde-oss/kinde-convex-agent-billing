<!-- Ideally, this should get auto-generated via tools like [auto-changelog](https://github.com/CookPete/auto-changelog). Eventually, this will get set up as part of the repository template. -->

## 0.1.0

Initial scaffold of the Kinde agent billing Convex component.

- **Component scaffold** — `defineComponent('agentBilling')` with an empty schema, ready for billing tables in a later phase.
- **Thin client** — an `AgentBilling` client class constructed from the app's generated component reference; wrapper methods arrive in later phases.
- **Test harness** — `convex-test` + `vitest` wiring with a `register` helper exposed via the `./test` export, plus smoke tests across the component, client, and example app.
- **Example app** — a runnable reference app that installs the component via `app.use`.
