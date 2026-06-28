import {httpRouter} from 'convex/server';
import {registerRoutes} from '@kinde-oss/kinde-convex-agent-billing';
import {components} from './_generated/api.js';

const http = httpRouter();

// Default mount: `POST /billing/webhooks/kinde`. The webhook body is a
// Kinde-signed JWT verified against Kinde's JWKS (webhook authenticity). With no
// verifyCaller hook, no non-webhook route is exposed.
registerRoutes(http, components.agentBilling);

// A second mount demonstrating the verifyCaller seam (the separate cross-app
// auth concern): the app authenticates a direct caller (here via an
// `X-Caller-Token` header standing in for a real check) so the protected
// `POST /billing-admin/events/recent` read route can be mounted.
registerRoutes(http, components.agentBilling, {
  pathPrefix: '/billing-admin',
  verifyCaller: async (request) => {
    const token = request.headers.get('X-Caller-Token');
    if (token === null || token.length === 0) {
      throw new Error('No authenticated caller.');
    }
    return token;
  }
});

export default http;
