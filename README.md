# Kinde Convex Agent Billing

The Kinde agent billing component for [Convex](https://convex.dev) — agent usage metering and billing, backed by Kinde.

[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](https://makeapullrequest.com) [![Kinde Docs](https://img.shields.io/badge/Kinde-Docs-eee?style=flat-square)](https://kinde.com/docs/developer-tools) [![Kinde Community](https://img.shields.io/badge/Kinde-Community-eee?style=flat-square)](https://thekindecommunity.slack.com)

## Development

This package is a Convex component plus a thin client. Day-to-day development:

- `npm run build:codegen` — regenerate component code and type-check the build.
- `npm test` — run the full `convex-test` + `vitest` suite (with type-checking).
- `npm run typecheck` — type-check the package and the example app.
- `npm run lint` — run ESLint.
- `npm run format` — run Prettier over the repo.

The `example/` directory is a runnable reference app that installs the component via `app.use`.

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

## Usage

> **Status:** early scaffold (`0.1.0`). The component installs and the client constructs, but billing tables and methods arrive in later phases. This section will grow as those land.

Install the package:

```bash
npm i @kinde-oss/kinde-convex-agent-billing
```

Add the component to your app's `convex/convex.config.ts`:

```ts
import {defineApp} from 'convex/server';
import agentBilling from '@kinde-oss/kinde-convex-agent-billing/convex.config.js';

const app = defineApp();

app.use(agentBilling);

export default app;
```

Construct the client once:

```ts
// convex/agentBilling.ts
import {AgentBilling} from '@kinde-oss/kinde-convex-agent-billing';
import {components} from './_generated/api.js';

export const agentBilling = new AgentBilling(components.agentBilling);
```

This component is designed to compose with the sibling [`@kinde-oss/kinde-convex-agent-auth`](https://github.com/kinde-oss/kinde-convex-agent-auth) through its stable `verifyCaller` seam.

## Documentation

For details on integrating Kinde into your project, head over to the [Kinde docs](https://kinde.com/docs/) and the [developer tools](https://kinde.com/docs/developer-tools/) section 👍🏼.

## Publishing

The core team handles publishing.

## Contributing

Please refer to Kinde’s [contributing guidelines](https://github.com/kinde-oss/.github/blob/489e2ca9c3307c2b2e098a885e22f2239116394a/CONTRIBUTING.md).

## License

By contributing to Kinde, you agree that your contributions will be licensed under its MIT License.
