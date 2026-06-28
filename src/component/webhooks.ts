import {v} from 'convex/values';
import type {Infer} from 'convex/values';
import {
  action,
  internalMutation,
  mutation,
  query
} from './_generated/server.js';
import {api, internal} from './_generated/api.js';
import schema from './schema.js';
import {fail, writeAudit} from './helpers.js';
import {
  metadataValidator,
  nullableString,
  principalTypeValidator
} from './validators.js';

const webhookEventDoc = schema.tables.webhookEvents.validator.extend({
  _id: v.id('webhookEvents'),
  _creationTime: v.number()
});

/** The eight Kinde `customer.*` billing triggers we accept. */
const BILLING_EVENT_TYPES = new Set([
  'customer.agreement_created',
  'customer.agreement_cancelled',
  'customer.plan_assigned',
  'customer.plan_changed',
  'customer.payment_succeeded',
  'customer.payment_failed',
  'customer.invoice_overdue',
  'customer.meter_usage_updated'
]);

const ingestResultValidator = v.object({
  status: v.union(v.literal('ingested'), v.literal('duplicate')),
  id: v.id('webhookEvents')
});

type IngestResult = Infer<typeof ingestResultValidator>;

/**
 * Ingest one verified, normalized webhook event. Dedup by `dedupKey` makes a
 * Kinde retry an idempotent no-op (returns `duplicate`). The customerId is
 * mapped back to a local principal via `kindeCustomers` when a mapping exists.
 * Internal: only `webhooks.receive` (after verification) calls this.
 */
export const ingest = internalMutation({
  args: {
    eventType: v.string(),
    rawType: v.string(),
    dedupKey: v.string(),
    customerId: nullableString,
    payload: metadataValidator
  },
  returns: ingestResultValidator,
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('webhookEvents')
      .withIndex('by_dedup', (q) => q.eq('dedupKey', args.dedupKey))
      .unique();
    if (existing !== null) {
      return {status: 'duplicate' as const, id: existing._id};
    }
    const now = Date.now();
    const customerId = args.customerId;
    let principalType: 'user' | 'org' | 'agent' | null = null;
    let principalId: string | null = null;
    if (customerId !== null) {
      const mapping = await ctx.db
        .query('kindeCustomers')
        .withIndex('by_customer', (q) => q.eq('customerId', customerId))
        .unique();
      if (mapping !== null) {
        principalType = mapping.principalType;
        principalId = mapping.principalId;
      }
    }
    const id = await ctx.db.insert('webhookEvents', {
      eventType: args.eventType,
      rawType: args.rawType,
      dedupKey: args.dedupKey,
      principalType,
      principalId,
      customerId: args.customerId,
      payload: args.payload,
      receivedAt: now,
      processedAt: now
    });
    await writeAudit(ctx, {
      eventType: 'webhook.received',
      principalType,
      principalId,
      detail: {
        webhookEventType: args.eventType,
        dedupKey: args.dedupKey,
        customerId: args.customerId
      }
    });
    return {status: 'ingested' as const, id};
  }
});

/**
 * Verify a Kinde webhook JWT, normalize it, and ingest it. Public so the
 * app-mounted HTTP route (client code) can call it via `component.webhooks
 * .receive`. Verification (webhook authenticity, concern (a)) is delegated to
 * `kinde.verifyWebhook`; an event whose type is not one of the eight billing
 * triggers fails `webhook_unknown_event` and writes nothing.
 */
export const receive = action({
  args: {token: v.string()},
  returns: ingestResultValidator,
  handler: async (ctx, args): Promise<IngestResult> => {
    const verified = await ctx.runAction(api.kinde.verifyWebhook, {
      token: args.token
    });
    if (!BILLING_EVENT_TYPES.has(verified.rawType)) {
      fail(
        'webhook_unknown_event',
        `"${verified.rawType}" is not a supported billing event.`
      );
    }
    return await ctx.runMutation(internal.webhooks.ingest, {
      eventType: verified.rawType,
      rawType: verified.rawType,
      dedupKey: verified.dedupKey,
      customerId: verified.customerId,
      payload: verified.payload
    });
  }
});

export const get = query({
  args: {eventId: v.id('webhookEvents')},
  returns: v.union(webhookEventDoc, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db.get('webhookEvents', args.eventId);
  }
});

export const listForPrincipal = query({
  args: {
    principalType: principalTypeValidator,
    principalId: v.string(),
    eventType: v.optional(v.string()),
    limit: v.optional(v.number())
  },
  returns: v.array(webhookEventDoc),
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 200);
    const {principalType, principalId, eventType} = args;
    const rows = await ctx.db
      .query('webhookEvents')
      .withIndex('by_principal', (q) =>
        q.eq('principalType', principalType).eq('principalId', principalId)
      )
      .order('desc')
      .take(limit);
    return eventType === undefined
      ? rows
      : rows.filter((row) => row.eventType === eventType);
  }
});

export const listRecent = query({
  args: {
    eventType: v.optional(v.string()),
    limit: v.optional(v.number())
  },
  returns: v.array(webhookEventDoc),
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 200);
    const {eventType} = args;
    if (eventType === undefined) {
      return await ctx.db.query('webhookEvents').order('desc').take(limit);
    }
    return await ctx.db
      .query('webhookEvents')
      .withIndex('by_type', (q) => q.eq('eventType', eventType))
      .order('desc')
      .take(limit);
  }
});

/** Flip `processedAt` after the app has reacted to an event. */
export const markProcessed = mutation({
  args: {eventId: v.id('webhookEvents')},
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get('webhookEvents', args.eventId);
    if (row === null) {
      fail('webhook_event_not_found', 'No such webhook event.');
    }
    await ctx.db.patch('webhookEvents', args.eventId, {
      processedAt: Date.now()
    });
    return null;
  }
});
