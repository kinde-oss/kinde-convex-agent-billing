import {v} from 'convex/values';
import {
  action,
  env,
  internalMutation,
  internalQuery,
  mutation
} from './_generated/server.js';
import type {ActionCtx} from './_generated/server.js';
import type {Id} from './_generated/dataModel.js';
import {internal} from './_generated/api.js';
import schema from './schema.js';
import {fail, writeAudit} from './helpers.js';
import {
  nullableNumber,
  nullableString,
  principalTypeValidator
} from './validators.js';

const kindeCustomerDoc = schema.tables.kindeCustomers.validator.extend({
  _id: v.id('kindeCustomers'),
  _creationTime: v.number()
});

const kindeTokenCacheDoc = schema.tables.kindeTokenCache.validator.extend({
  _id: v.id('kindeTokenCache'),
  _creationTime: v.number()
});

/**
 * Sentinel used to represent an unlimited Kinde entitlement as a concrete
 * budget figure. Kinde reports an unlimited feature with a null limit/max; we
 * hydrate the local budget with this value so the same `gate.check` /
 * `usage.record` code path (which compares against `remaining`) keeps working
 * without special-casing infinity.
 */
const UNLIMITED = Number.MAX_SAFE_INTEGER;

/** Refresh the cached token this many ms before it actually expires. */
const TOKEN_SKEW_MS = 60_000;

/** The stub token returned in MODE=test so no live Kinde call is made. */
const TEST_MODE_TOKEN = 'test-mode-stub-token';

// --- env helpers (mirror requireDomain) ---

function requireIssuerUrl(): string {
  const url = env.KINDE_ISSUER_URL;
  if (!url) {
    fail(
      'kinde_issuer_url_unset',
      'The KINDE_ISSUER_URL environment variable is not set for the agentBilling component.'
    );
  }
  return url;
}

function requireM2MClientId(): string {
  const clientId = env.KINDE_M2M_CLIENT_ID;
  if (!clientId) {
    fail(
      'kinde_m2m_client_id_unset',
      'The KINDE_M2M_CLIENT_ID environment variable is not set for the agentBilling component.'
    );
  }
  return clientId;
}

function requireM2MClientSecret(): string {
  const secret = env.KINDE_M2M_CLIENT_SECRET;
  if (!secret) {
    fail(
      'kinde_m2m_client_secret_unset',
      'The KINDE_M2M_CLIENT_SECRET environment variable is not set for the agentBilling component.'
    );
  }
  return secret;
}

/**
 * Validate the component's MODE env var, defaulting to "live". Any value other
 * than "test" or "live" is a configuration error and fails with a typed code
 * rather than silently proceeding (HARDENING).
 */
function resolveMode(): 'test' | 'live' {
  const mode = env.MODE;
  if (mode === undefined || mode === 'live') {
    return 'live';
  }
  if (mode === 'test') {
    return 'test';
  }
  fail('invalid_mode', 'MODE must be either "test" or "live".');
}

/**
 * Parse a response body as JSON, mapping a non-JSON body (e.g. an HTML error
 * page) to a typed failure rather than letting a raw SyntaxError escape and
 * break the machine-readable error contract.
 */
async function readJson(
  response: Response,
  url: string,
  code: string
): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    fail(code, `The response from ${url} is not valid JSON.`);
  }
}

/** Read a property of an already-narrowed object without a blind cast. */
function field(obj: object, key: string): unknown {
  return key in obj ? (obj as Record<string, unknown>)[key] : undefined;
}

/** Narrow an untrusted token response to its two fields, or null. */
function narrowToken(
  value: unknown
): {accessToken: string; expiresIn: number} | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const accessToken = field(value, 'access_token');
  const expiresIn = field(value, 'expires_in');
  if (typeof accessToken !== 'string' || typeof expiresIn !== 'number') {
    return null;
  }
  return {accessToken, expiresIn};
}

interface Entitlement {
  id: string | null;
  featureCode: string;
  /** UNLIMITED sentinel when Kinde reports no cap. */
  limit: number;
  consumed: number;
}

/** Narrow one untrusted entitlement record field-by-field, or null. */
function narrowEntitlement(value: unknown): Entitlement | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const featureCode = field(value, 'feature_code');
  if (typeof featureCode !== 'string') {
    return null;
  }
  const rawMax = field(value, 'entitlement_limit_max');
  const rawMaxValue = field(value, 'max_value');
  let limit: number;
  if (typeof rawMax === 'number') {
    limit = rawMax;
  } else if (typeof rawMaxValue === 'number') {
    // Kinde returns the requested max_value as the limit when the real max is
    // null (unlimited).
    limit = rawMaxValue;
  } else {
    limit = UNLIMITED;
  }
  const rawConsumed = field(value, 'consumed');
  const consumed = typeof rawConsumed === 'number' ? rawConsumed : 0;
  const id = field(value, 'id');
  return {
    id: typeof id === 'string' ? id : null,
    featureCode,
    limit,
    consumed
  };
}

/** Narrow one page of the paginated entitlements response, or null. */
function narrowEntitlementsPage(
  value: unknown
): {entitlements: Entitlement[]; hasMore: boolean} | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const list = field(value, 'entitlements');
  if (!Array.isArray(list)) {
    return null;
  }
  const entitlements: Entitlement[] = [];
  for (const entry of list) {
    const entitlement = narrowEntitlement(entry);
    if (entitlement === null) {
      return null;
    }
    entitlements.push(entitlement);
  }
  const hasMore = field(value, 'has_more');
  return {
    entitlements,
    hasMore: typeof hasMore === 'boolean' ? hasMore : false
  };
}

// --- internal persistence (the action -> internalMutation split) ---

export const getCachedToken = internalQuery({
  args: {},
  returns: v.union(kindeTokenCacheDoc, v.null()),
  handler: async (ctx) => {
    return await ctx.db
      .query('kindeTokenCache')
      .withIndex('by_key', (q) => q.eq('key', 'm2m'))
      .unique();
  }
});

export const storeToken = internalMutation({
  args: {accessToken: v.string(), expiresAt: v.number()},
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('kindeTokenCache')
      .withIndex('by_key', (q) => q.eq('key', 'm2m'))
      .unique();
    if (existing !== null) {
      await ctx.db.patch('kindeTokenCache', existing._id, {
        accessToken: args.accessToken,
        expiresAt: args.expiresAt
      });
    } else {
      await ctx.db.insert('kindeTokenCache', {
        key: 'm2m',
        accessToken: args.accessToken,
        expiresAt: args.expiresAt
      });
    }
    return null;
  }
});

export const getMapping = internalQuery({
  args: {principalType: principalTypeValidator, principalId: v.string()},
  returns: v.union(kindeCustomerDoc, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db
      .query('kindeCustomers')
      .withIndex('by_principal', (q) =>
        q
          .eq('principalType', args.principalType)
          .eq('principalId', args.principalId)
      )
      .unique();
  }
});

/**
 * Upsert a Kinde-sourced budget from synced entitlement data and audit it.
 * Writes into the same `budgets` table that `gate.check`/`usage.record` read,
 * with `source: 'kinde'` so `effectiveBudget` never rolls it (Kinde is the
 * source of truth).
 */
export const hydrateBudget = internalMutation({
  args: {
    principalType: principalTypeValidator,
    principalId: v.string(),
    orgCode: nullableString,
    unit: v.string(),
    billingFeatureCode: v.string(),
    remaining: v.number(),
    periodCap: v.number()
  },
  returns: v.id('budgets'),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query('budgets')
      .withIndex('by_principal', (q) =>
        q
          .eq('principalType', args.principalType)
          .eq('principalId', args.principalId)
          .eq('unit', args.unit)
      )
      .unique();
    let budgetId: Id<'budgets'>;
    if (existing !== null) {
      await ctx.db.patch('budgets', existing._id, {
        orgCode: args.orgCode,
        remaining: args.remaining,
        periodCap: args.periodCap,
        periodStart: null,
        periodEnd: null,
        periodLengthMs: null,
        source: 'kinde'
      });
      budgetId = existing._id;
    } else {
      budgetId = await ctx.db.insert('budgets', {
        principalType: args.principalType,
        principalId: args.principalId,
        orgCode: args.orgCode,
        unit: args.unit,
        remaining: args.remaining,
        periodCap: args.periodCap,
        periodStart: null,
        periodEnd: null,
        periodLengthMs: null,
        source: 'kinde',
        createdAt: now
      });
    }
    await writeAudit(ctx, {
      eventType: 'kinde.entitlements_synced',
      principalType: args.principalType,
      principalId: args.principalId,
      orgCode: args.orgCode,
      unit: args.unit,
      detail: {
        billingFeatureCode: args.billingFeatureCode,
        remaining: args.remaining,
        periodCap: args.periodCap
      }
    });
    return budgetId;
  }
});

export const recordPlanChanged = internalMutation({
  args: {
    principalType: principalTypeValidator,
    principalId: v.string(),
    planCode: v.string(),
    customerId: v.string()
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await writeAudit(ctx, {
      eventType: 'kinde.plan_changed',
      principalType: args.principalType,
      principalId: args.principalId,
      detail: {planCode: args.planCode, customerId: args.customerId}
    });
    return null;
  }
});

// --- public mutation: wire a principal to its Kinde customer ---

/** Upsert the Kinde customer mapping for a principal. */
export const setCustomerMapping = mutation({
  args: {
    principalType: principalTypeValidator,
    principalId: v.string(),
    customerId: v.string(),
    customerAgreementId: v.optional(nullableString)
  },
  returns: v.id('kindeCustomers'),
  handler: async (ctx, args) => {
    const customerAgreementId = args.customerAgreementId ?? null;
    const existing = await ctx.db
      .query('kindeCustomers')
      .withIndex('by_principal', (q) =>
        q
          .eq('principalType', args.principalType)
          .eq('principalId', args.principalId)
      )
      .unique();
    let mappingId: Id<'kindeCustomers'>;
    if (existing !== null) {
      await ctx.db.patch('kindeCustomers', existing._id, {
        customerId: args.customerId,
        customerAgreementId
      });
      mappingId = existing._id;
    } else {
      mappingId = await ctx.db.insert('kindeCustomers', {
        principalType: args.principalType,
        principalId: args.principalId,
        customerId: args.customerId,
        customerAgreementId
      });
    }
    await writeAudit(ctx, {
      eventType: 'kinde.customer_mapped',
      principalType: args.principalType,
      principalId: args.principalId,
      detail: {
        customerId: args.customerId,
        customerAgreementId
      }
    });
    return mappingId;
  }
});

// --- token acquisition (secrets + fetch in actions) ---

/**
 * Resolve a usable M2M access token: a stub in MODE=test (no network), else the
 * cached token if it is comfortably unexpired, else a freshly fetched and
 * cached one.
 */
async function ensureToken(ctx: ActionCtx): Promise<string> {
  if (resolveMode() === 'test') {
    return TEST_MODE_TOKEN;
  }
  const issuerUrl = requireIssuerUrl();
  const clientId = requireM2MClientId();
  const clientSecret = requireM2MClientSecret();
  const now = Date.now();
  const cached = await ctx.runQuery(internal.kinde.getCachedToken, {});
  if (cached !== null && cached.expiresAt > now + TOKEN_SKEW_MS) {
    return cached.accessToken;
  }
  const tokenUrl = `${issuerUrl}/oauth2/token`;
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      audience: `${issuerUrl}/api`
    })
  });
  if (!response.ok) {
    fail(
      'kinde_token_fetch_failed',
      `Fetching ${tokenUrl} failed with status ${response.status}.`
    );
  }
  const json = await readJson(response, tokenUrl, 'kinde_response_malformed');
  const token = narrowToken(json);
  if (token === null) {
    fail(
      'kinde_token_malformed',
      `The token response from ${tokenUrl} is missing access_token/expires_in.`
    );
  }
  const expiresAt = now + token.expiresIn * 1000;
  await ctx.runMutation(internal.kinde.storeToken, {
    accessToken: token.accessToken,
    expiresAt
  });
  return token.accessToken;
}

/** Acquire (and cache) the Kinde M2M access token. */
export const getAccessToken = action({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    return await ensureToken(ctx);
  }
});

// --- outbound billing actions ---

/**
 * Report metered usage to Kinde. This is an OUTBOUND report only: the local
 * budget decrement already happened in `usage.record`. The component
 * idempotency key is forwarded as the `Idempotency-Key` header so a retry is
 * not double-counted by Kinde.
 */
export const pushUsage = action({
  args: {
    principalType: principalTypeValidator,
    principalId: v.string(),
    billingFeatureCode: v.string(),
    meterValue: v.number(),
    idempotencyKey: v.string()
  },
  returns: v.object({reported: v.boolean()}),
  handler: async (ctx, args) => {
    const mapping = await ctx.runQuery(internal.kinde.getMapping, {
      principalType: args.principalType,
      principalId: args.principalId
    });
    if (mapping === null) {
      fail(
        'customer_mapping_missing',
        'No Kinde customer mapping exists for this principal.'
      );
    }
    if (mapping.customerAgreementId === null) {
      fail(
        'agreement_missing',
        'The Kinde customer mapping has no customer_agreement_id.'
      );
    }
    if (resolveMode() === 'test') {
      return {reported: false};
    }
    const issuerUrl = requireIssuerUrl();
    const token = await ensureToken(ctx);
    const url = `${issuerUrl}/api/v1/billing/meter_usage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': args.idempotencyKey
      },
      body: JSON.stringify({
        customer_agreement_id: mapping.customerAgreementId,
        billing_feature_code: args.billingFeatureCode,
        meter_value: String(args.meterValue),
        meter_type_code: 'delta'
      })
    });
    if (!response.ok) {
      fail(
        'kinde_meter_usage_failed',
        `Posting to ${url} failed with status ${response.status}.`
      );
    }
    await readJson(response, url, 'kinde_response_malformed');
    return {reported: true};
  }
});

/**
 * Sync a Kinde billing entitlement into the local `budgets` table (source
 * 'kinde'). Kinde is the source of truth; this writes the budget that
 * `gate.check`/`usage.record` already read.
 */
export const syncEntitlements = action({
  args: {
    principalType: principalTypeValidator,
    principalId: v.string(),
    orgCode: v.optional(nullableString),
    unit: v.string(),
    billingFeatureCode: v.string()
  },
  returns: v.object({
    found: v.boolean(),
    remaining: nullableNumber,
    limit: nullableNumber
  }),
  handler: async (ctx, args) => {
    const mapping = await ctx.runQuery(internal.kinde.getMapping, {
      principalType: args.principalType,
      principalId: args.principalId
    });
    if (mapping === null) {
      fail(
        'customer_mapping_missing',
        'No Kinde customer mapping exists for this principal.'
      );
    }
    if (resolveMode() === 'test') {
      return {found: false, remaining: null, limit: null};
    }
    const issuerUrl = requireIssuerUrl();
    const token = await ensureToken(ctx);

    // Walk the paginated entitlements until the feature is found or exhausted.
    let match: Entitlement | null = null;
    let startingAfter: string | null = null;
    for (let page = 0; page < 100 && match === null; page++) {
      const params = new URLSearchParams({
        customer_id: mapping.customerId,
        expand: 'plans',
        max_value: String(UNLIMITED)
      });
      if (startingAfter !== null) {
        params.set('starting_after', startingAfter);
      }
      const url = `${issuerUrl}/api/v1/billing/entitlements?${params.toString()}`;
      const response = await fetch(url, {
        headers: {Authorization: `Bearer ${token}`}
      });
      if (!response.ok) {
        fail(
          'kinde_entitlements_failed',
          `Fetching ${url} failed with status ${response.status}.`
        );
      }
      const json = await readJson(response, url, 'kinde_response_malformed');
      const parsed = narrowEntitlementsPage(json);
      if (parsed === null) {
        fail(
          'kinde_response_malformed',
          `The entitlements response from ${url} is not a valid page.`
        );
      }
      for (const entitlement of parsed.entitlements) {
        if (entitlement.featureCode === args.billingFeatureCode) {
          match = entitlement;
          break;
        }
      }
      const last = parsed.entitlements[parsed.entitlements.length - 1];
      if (!parsed.hasMore || last === undefined || last.id === null) {
        break;
      }
      startingAfter = last.id;
    }

    if (match === null) {
      return {found: false, remaining: null, limit: null};
    }
    const remaining = Math.max(match.limit - match.consumed, 0);
    await ctx.runMutation(internal.kinde.hydrateBudget, {
      principalType: args.principalType,
      principalId: args.principalId,
      orgCode: args.orgCode ?? null,
      unit: args.unit,
      billingFeatureCode: args.billingFeatureCode,
      remaining,
      periodCap: match.limit
    });
    return {found: true, remaining, limit: match.limit};
  }
});

/** Change a customer's Kinde billing plan (creates/modifies an agreement). */
export const changePlan = action({
  args: {
    principalType: principalTypeValidator,
    principalId: v.string(),
    planCode: v.string(),
    isProrate: v.optional(v.boolean()),
    isInvoiceNow: v.optional(v.boolean())
  },
  returns: v.object({changed: v.boolean()}),
  handler: async (ctx, args) => {
    const mapping = await ctx.runQuery(internal.kinde.getMapping, {
      principalType: args.principalType,
      principalId: args.principalId
    });
    if (mapping === null) {
      fail(
        'customer_mapping_missing',
        'No Kinde customer mapping exists for this principal.'
      );
    }
    if (resolveMode() === 'test') {
      return {changed: false};
    }
    const issuerUrl = requireIssuerUrl();
    const token = await ensureToken(ctx);
    const url = `${issuerUrl}/api/v1/billing/agreements`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        customer_id: mapping.customerId,
        plan_code: args.planCode,
        ...(args.isProrate === undefined ? {} : {is_prorate: args.isProrate}),
        ...(args.isInvoiceNow === undefined
          ? {}
          : {is_invoice_now: args.isInvoiceNow})
      })
    });
    if (!response.ok) {
      fail(
        'kinde_agreement_failed',
        `Posting to ${url} failed with status ${response.status}.`
      );
    }
    await readJson(response, url, 'kinde_response_malformed');
    await ctx.runMutation(internal.kinde.recordPlanChanged, {
      principalType: args.principalType,
      principalId: args.principalId,
      planCode: args.planCode,
      customerId: mapping.customerId
    });
    return {changed: true};
  }
});
