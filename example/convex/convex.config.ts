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
