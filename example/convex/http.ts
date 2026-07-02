import {httpRouter} from 'convex/server';
import {registerRoutes} from '@kinde-oss/kinde-convex-agent-billing';
import {components} from './_generated/api.js';

const http = httpRouter();

// Default mount: `POST /billing/webhooks/kinde`. The webhook body is a
// Kinde-signed JWT verified against Kinde's JWKS (webhook authenticity). With no
// verifyCaller hook, no non-webhook route is exposed.
registerRoutes(http, components.agentBilling);

// A second mount demonstrating the verifyCaller seam (the separate cross-app
// auth concern): the app authenticates a direct caller so the protected
// `POST /billing-admin/events/recent` read route can be mounted.
//
// EXAMPLE ONLY — NOT PRODUCTION AUTH. In a real app, verifyCaller MUST validate
// the caller against your auth provider (e.g. verify a session cookie or a
// bearer JWT — the blessed default is `@kinde-oss/kinde-convex-agent-auth`'s
// `verifyCaller`), then return the authenticated subject. Here we merely compare
// a header against an example shared secret from env, so the route is closed
// unless `EXAMPLE_ADMIN_TOKEN` is set and the header matches it exactly — it is
// deliberately NOT "any non-empty token works". Never ship a shared-secret
// header check as your real authentication.
registerRoutes(http, components.agentBilling, {
  pathPrefix: '/billing-admin',
  verifyCaller: async (request) => {
    const expected = process.env.EXAMPLE_ADMIN_TOKEN;
    const token = request.headers.get('X-Caller-Token');
    if (
      expected === undefined ||
      expected.length === 0 ||
      token === null ||
      token !== expected
    ) {
      throw new Error('The caller could not be authenticated.');
    }
    return token;
  }
});

export default http;
