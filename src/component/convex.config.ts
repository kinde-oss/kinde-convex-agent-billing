import {defineComponent} from 'convex/server';
import {v} from 'convex/values';

export default defineComponent('agentBilling', {
  env: {
    /** Secret used to HMAC-sign mandates. Required. */
    MANDATE_SIGNING_SECRET: v.string(),
    /** Kinde issuer/base URL, e.g. "https://acme.kinde.com" (no trailing slash). Required for Kinde billing. */
    KINDE_ISSUER_URL: v.string(),
    /** Kinde M2M application client id used for Management/billing API calls. */
    KINDE_M2M_CLIENT_ID: v.string(),
    /** Kinde M2M application client secret. */
    KINDE_M2M_CLIENT_SECRET: v.string(),
    /** "test" relaxes external Kinde calls for local development; defaults to "live". */
    MODE: v.optional(v.union(v.literal('test'), v.literal('live')))
  }
});
