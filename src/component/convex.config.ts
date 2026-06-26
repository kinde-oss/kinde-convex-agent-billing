import {defineComponent} from 'convex/server';
import {v} from 'convex/values';

export default defineComponent('agentBilling', {
  env: {
    /** Secret used to HMAC-sign mandates. Required. */
    MANDATE_SIGNING_SECRET: v.string()
  }
});
