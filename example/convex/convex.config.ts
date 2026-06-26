import {defineApp} from 'convex/server';
import agentBilling from '@kinde-oss/kinde-convex-agent-billing/convex.config.js';

const app = defineApp();

app.use(agentBilling);

export default app;
