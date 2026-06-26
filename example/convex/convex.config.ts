import {defineApp} from 'convex/server';
import {v} from 'convex/values';
import agentBilling from '@kinde-oss/kinde-convex-agent-billing/convex.config.js';

const app = defineApp({
  env: {
    MANDATE_SIGNING_SECRET: v.string()
  }
});

app.use(agentBilling, {
  env: {
    MANDATE_SIGNING_SECRET: app.env.MANDATE_SIGNING_SECRET
  }
});

export default app;
