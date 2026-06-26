import {defineComponent} from 'convex/server';

// No env vars are declared yet. Billing environment variables (declared as
// string or string-union types only) arrive in a later phase.
export default defineComponent('agentBilling');
