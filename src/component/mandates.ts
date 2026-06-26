import {v} from 'convex/values';
import type {Infer} from 'convex/values';
import {env, mutation, query} from './_generated/server.js';
import schema from './schema.js';
import {fail, writeAudit} from './helpers.js';
import {nullableString, principalTypeValidator} from './validators.js';

const mandateDoc = schema.tables.mandates.validator.extend({
  _id: v.id('mandates'),
  _creationTime: v.number()
});

const mandateVerifyResultValidator = v.union(
  v.object({valid: v.literal(true)}),
  v.object({
    valid: v.literal(false),
    code: v.string(),
    reason: v.string()
  })
);

export type MandateVerifyResult = Infer<typeof mandateVerifyResultValidator>;

type PrincipalType = Infer<typeof principalTypeValidator>;

/** The canonical, signature-bearing fields of a mandate. */
export interface SignedMandateCore {
  principalType: PrincipalType;
  principalId: string;
  orgCode: string | null;
  agentSubject: string;
  unit: string;
  scope: string[];
  budgetCap: number;
  notBefore: number;
  notAfter: number;
}

const encoder = new TextEncoder();

/**
 * The exact bytes that get signed. A leading version tag and an ordered array
 * (rather than an object) make the encoding unambiguous and stable, so a
 * mandate signed by `mint` re-hashes identically in `verify`. `revokedAt` and
 * `budgetSpent` are deliberately excluded: they are mutable, separately-checked
 * state, not part of the immutable signed grant.
 */
function canonicalPayload(core: SignedMandateCore): string {
  return JSON.stringify([
    'kinde.mandate.v1',
    core.principalType,
    core.principalId,
    core.orgCode,
    core.agentSubject,
    core.unit,
    core.scope,
    core.budgetCap,
    core.notBefore,
    core.notAfter
  ]);
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/** Length-independent equality so signature checks leak no timing signal. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * HMAC-SHA256 the canonical payload with the component's signing secret and
 * return it hex-encoded. Pure given the secret and core fields — no database
 * or network access — so the same call is used by `mint` and `verify`.
 */
export async function signMandate(
  secret: string,
  core: SignedMandateCore
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    {name: 'HMAC', hash: 'SHA-256'},
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(canonicalPayload(core))
  );
  return toHex(new Uint8Array(signature));
}

/**
 * Validate a stored mandate against the signing secret. Pure given the secret:
 * it recomputes the HMAC and rejects a mismatch, then treats a revoked,
 * not-yet-valid, or expired mandate as invalid. Order matters — integrity is
 * checked before state so a tampered row can never read as merely expired.
 * Exported for reuse by `usage.record` when binding a spend to a mandate.
 */
export async function verifyMandate(
  secret: string,
  mandate: SignedMandateCore & {
    signature: string;
    revokedAt: number | null;
  },
  now: number
): Promise<MandateVerifyResult> {
  const expected = await signMandate(secret, mandate);
  if (!constantTimeEqual(expected, mandate.signature)) {
    return {
      valid: false,
      code: 'bad_signature',
      reason: 'The mandate signature does not match its contents.'
    };
  }
  if (mandate.revokedAt !== null) {
    return {
      valid: false,
      code: 'revoked',
      reason: 'The mandate has been revoked.'
    };
  }
  if (now < mandate.notBefore) {
    return {
      valid: false,
      code: 'not_yet_valid',
      reason: 'The mandate is not yet valid.'
    };
  }
  if (now >= mandate.notAfter) {
    return {
      valid: false,
      code: 'expired',
      reason: 'The mandate has expired.'
    };
  }
  return {valid: true};
}

/**
 * Pure, Convex-free, attenuation-only intersection of a parent mandate with a
 * child request. The result NARROWS both axes and can never widen either:
 * `scope` is a subset of `parentScope` (and of `childScope` when present), and
 * `budget` is the min of the bounds. A `null` child input means "no constraint
 * from the child" and is skipped — it never widens the result. The scope output
 * is de-duplicated and sorted for a stable shape.
 */
export function intersectMandate(
  parentScope: readonly string[],
  parentBudgetRemaining: number,
  childScope: readonly string[] | null,
  childBudgetRequested: number | null
): {scope: string[]; budget: number} {
  const childSet = childScope === null ? null : new Set(childScope);
  const scope = new Set<string>();
  for (const code of parentScope) {
    if (childSet === null || childSet.has(code)) {
      scope.add(code);
    }
  }
  const budget =
    childBudgetRequested === null
      ? parentBudgetRemaining
      : Math.min(parentBudgetRemaining, childBudgetRequested);
  return {scope: [...scope].sort(), budget};
}

export function requireSigningSecret(): string {
  const secret = env.MANDATE_SIGNING_SECRET;
  if (!secret) {
    fail(
      'mandate_secret_unset',
      'The MANDATE_SIGNING_SECRET environment variable is not set for the agentBilling component.'
    );
  }
  return secret;
}

/**
 * Mint an HMAC-signed spend mandate. The signature is computed over the
 * canonical fields with MANDATE_SIGNING_SECRET, so the mandate is later
 * verifiable without any external call.
 */
export const mint = mutation({
  args: {
    principalType: principalTypeValidator,
    principalId: v.string(),
    orgCode: v.optional(nullableString),
    agentSubject: v.string(),
    unit: v.string(),
    scope: v.array(v.string()),
    budgetCap: v.number(),
    notBefore: v.optional(v.number()),
    notAfter: v.number()
  },
  returns: v.id('mandates'),
  handler: async (ctx, args) => {
    const now = Date.now();
    const secret = requireSigningSecret();
    const orgCode = args.orgCode ?? null;
    const notBefore = args.notBefore ?? now;
    if (args.budgetCap <= 0) {
      fail('invalid_budget', 'budgetCap must be greater than 0.');
    }
    if (args.notAfter <= notBefore) {
      fail('invalid_window', 'notAfter must be after notBefore.');
    }
    if (args.scope.length === 0) {
      fail('empty_scope', 'scope must list at least one code.');
    }
    const signature = await signMandate(secret, {
      principalType: args.principalType,
      principalId: args.principalId,
      orgCode,
      agentSubject: args.agentSubject,
      unit: args.unit,
      scope: args.scope,
      budgetCap: args.budgetCap,
      notBefore,
      notAfter: args.notAfter
    });
    const mandateId = await ctx.db.insert('mandates', {
      principalType: args.principalType,
      principalId: args.principalId,
      orgCode,
      agentSubject: args.agentSubject,
      unit: args.unit,
      scope: args.scope,
      budgetCap: args.budgetCap,
      budgetSpent: 0,
      notBefore,
      notAfter: args.notAfter,
      revokedAt: null,
      signature,
      createdAt: now
    });
    await writeAudit(ctx, {
      eventType: 'mandate.minted',
      principalType: args.principalType,
      principalId: args.principalId,
      orgCode,
      unit: args.unit,
      detail: {
        agentSubject: args.agentSubject,
        budgetCap: args.budgetCap,
        scope: args.scope,
        notBefore,
        notAfter: args.notAfter
      }
    });
    return mandateId;
  }
});

/**
 * Verify a stored mandate: recompute its HMAC and check
 * revocation/window. A missing mandate reports `not_found` rather than throwing
 * so callers can branch uniformly on the result.
 */
export const verify = query({
  args: {mandateId: v.id('mandates')},
  returns: mandateVerifyResultValidator,
  handler: async (ctx, args) => {
    const secret = requireSigningSecret();
    const mandate = await ctx.db.get('mandates', args.mandateId);
    if (mandate === null) {
      return {
        valid: false as const,
        code: 'not_found',
        reason: 'No such mandate.'
      };
    }
    return await verifyMandate(secret, mandate, Date.now());
  }
});

/** Revoke a mandate. Idempotent: an already-revoked mandate is a no-op. */
export const revoke = mutation({
  args: {mandateId: v.id('mandates'), reason: v.optional(v.string())},
  returns: v.null(),
  handler: async (ctx, args) => {
    const mandate = await ctx.db.get('mandates', args.mandateId);
    if (mandate === null) {
      fail('mandate_not_found', 'No such mandate.');
    }
    if (mandate.revokedAt !== null) {
      return null;
    }
    await ctx.db.patch('mandates', args.mandateId, {revokedAt: Date.now()});
    await writeAudit(ctx, {
      eventType: 'mandate.revoked',
      principalType: mandate.principalType,
      principalId: mandate.principalId,
      orgCode: mandate.orgCode,
      unit: mandate.unit,
      detail: {
        agentSubject: mandate.agentSubject,
        reason: args.reason ?? null
      }
    });
    return null;
  }
});

export const get = query({
  args: {mandateId: v.id('mandates')},
  returns: v.union(mandateDoc, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db.get('mandates', args.mandateId);
  }
});

export const listForPrincipal = query({
  args: {
    principalType: principalTypeValidator,
    principalId: v.string(),
    limit: v.optional(v.number())
  },
  returns: v.array(mandateDoc),
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 200);
    return await ctx.db
      .query('mandates')
      .withIndex('by_principal', (q) =>
        q
          .eq('principalType', args.principalType)
          .eq('principalId', args.principalId)
      )
      .take(limit);
  }
});

export const listForAgent = query({
  args: {agentSubject: v.string(), limit: v.optional(v.number())},
  returns: v.array(mandateDoc),
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 200);
    return await ctx.db
      .query('mandates')
      .withIndex('by_agent', (q) => q.eq('agentSubject', args.agentSubject))
      .take(limit);
  }
});
