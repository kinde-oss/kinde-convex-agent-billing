import {httpActionGeneric} from 'convex/server';
import type {HttpRouter} from 'convex/server';
import {ConvexError} from 'convex/values';
import type {ComponentApi} from '../component/_generated/component.js';

/**
 * Options for {@link registerRoutes}. ALL request authentication happens in the
 * app's HTTP context — component HTTP actions cannot read `ctx.auth` or the
 * app's environment, so the routes are defined here in client code and mounted
 * by the app (the Twilio component pattern).
 *
 * There are TWO DISTINCT auth concerns:
 * - (a) Webhook authenticity: the `/webhooks/kinde` body is a Kinde-signed JWT,
 *   verified against Kinde's JWKS (no bearer header, no verifyCaller). This is
 *   handled entirely by the component's `verifyWebhook` action.
 * - (b) {@link verifyCaller}: authenticates a direct/cross-app caller of any
 *   NON-webhook route. App-supplied; throw to reject. Mirrors the sibling's
 *   `authorizeApprover` hook shape.
 */
export interface RegisterRoutesOptions {
  /** Mount the routes under this prefix. Default `/billing`. */
  pathPrefix?: string;
  /**
   * Authenticate a direct/cross-app caller of a NON-webhook route (concern (b)
   * above). THE APP OWNS caller authentication. When provided, the read route
   * `${prefix}/events/recent` is mounted and gated by this hook — throw to
   * reject. When OMITTED, that route is NOT mounted at all, so billing events
   * are never exposed over HTTP unauthenticated. This is separate from webhook
   * authenticity, which is always the Kinde JWT verified via JWKS.
   */
  verifyCaller?: (request: Request) => Promise<unknown>;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json'}
  });
}

function errorInfo(error: unknown): {code: string; message: string} {
  if (error instanceof ConvexError) {
    const data: unknown = error.data;
    if (
      typeof data === 'object' &&
      data !== null &&
      'code' in data &&
      'message' in data
    ) {
      const {code, message} = data as {code: unknown; message: unknown};
      if (typeof code === 'string' && typeof message === 'string') {
        return {code, message};
      }
    }
  }
  return {
    code: 'internal_error',
    message: 'The request could not be processed.'
  };
}

// Verification failures that mean "the JWT is not authentic" map to 401; a
// structurally malformed body is a 400.
const UNAUTHORIZED_CODES = new Set([
  'webhook_bad_signature',
  'webhook_unknown_kid',
  'webhook_unverified'
]);
function webhookStatus(code: string): number {
  return UNAUTHORIZED_CODES.has(code) ? 401 : 400;
}

interface RecentBody {
  eventType?: string;
  limit?: number;
}

/**
 * Narrow the recent-events request body. Returns null on a non-object body, a
 * JSON parse failure (the caller passes `null`), or a wrong-typed field, so the
 * route can reject it with 400 rather than silently running an unfiltered query.
 * A valid object (including an empty one, meaning "no filter") is accepted.
 */
function parseRecentBody(value: unknown): RecentBody | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const {eventType, limit} = value as Record<string, unknown>;
  if (eventType !== undefined && typeof eventType !== 'string') {
    return null;
  }
  if (limit !== undefined && typeof limit !== 'number') {
    return null;
  }
  return {
    ...(eventType === undefined ? {} : {eventType}),
    ...(limit === undefined ? {} : {limit})
  };
}

/**
 * Mount the component's HTTP routes onto the app's router. Call this from the
 * app's `convex/http.ts`:
 *
 * ```ts
 * import {httpRouter} from 'convex/server';
 * import {registerRoutes} from '@kinde-oss/kinde-convex-agent-billing';
 * import {components} from './_generated/api.js';
 *
 * const http = httpRouter();
 * registerRoutes(http, components.agentBilling);
 * export default http;
 * ```
 *
 * Routes (under `opts.pathPrefix`, default `/billing`):
 * - `POST /webhooks/kinde` — Kinde billing webhook. The body is a Kinde-signed
 *   JWT, verified against Kinde's JWKS (concern (a)). Returns 200 on
 *   ingest/duplicate/ignored so Kinde stops retrying; 401 on a failed
 *   signature; 400 on a malformed body. (Non-200 triggers a Kinde retry, so
 *   only authenticity/parse failures are non-200.)
 * - `POST /events/recent` — a cross-app read of recent events, mounted ONLY
 *   when {@link RegisterRoutesOptions.verifyCaller} is supplied (concern (b)).
 */
export function registerRoutes(
  http: HttpRouter,
  component: ComponentApi,
  opts: RegisterRoutesOptions = {}
): void {
  const prefix = opts.pathPrefix ?? '/billing';

  http.route({
    path: `${prefix}/webhooks/kinde`,
    method: 'POST',
    handler: httpActionGeneric(async (ctx, request) => {
      const raw = await request.text().catch(() => null);
      if (raw === null || raw.trim().length === 0) {
        return json(400, {
          code: 'invalid_body',
          message: 'Expected a Kinde-signed JWT in the request body.'
        });
      }
      try {
        const result = await ctx.runAction(component.webhooks.receive, {
          token: raw.trim()
        });
        return json(200, {ok: true, status: result.status});
      } catch (error) {
        const info = errorInfo(error);
        // A verified-but-unsupported event is acknowledged (200) so Kinde does
        // not retry it forever; only authenticity/parse failures are non-200.
        if (info.code === 'webhook_unknown_event') {
          return json(200, {ok: true, status: 'ignored'});
        }
        return json(webhookStatus(info.code), info);
      }
    })
  });

  const verifyCaller = opts.verifyCaller;
  if (verifyCaller !== undefined) {
    http.route({
      path: `${prefix}/events/recent`,
      method: 'POST',
      handler: httpActionGeneric(async (ctx, request) => {
        try {
          await verifyCaller(request);
        } catch (error) {
          const info = errorInfo(error);
          return json(401, {
            code:
              info.code === 'internal_error'
                ? 'caller_unauthenticated'
                : info.code,
            message: 'The caller could not be authenticated.'
          });
        }
        const raw: unknown = await request.json().catch(() => null);
        const body = parseRecentBody(raw);
        if (body === null) {
          return json(400, {
            code: 'invalid_body',
            message:
              'Expected a JSON object with optional string eventType and numeric limit.'
          });
        }
        const events = await ctx.runQuery(component.webhooks.listRecent, body);
        return json(200, {events});
      })
    });
  }
}
