import {v} from 'convex/values';

export const principalTypeValidator = v.union(
  v.literal('user'),
  v.literal('org'),
  v.literal('agent')
);

export const budgetSourceValidator = v.union(
  v.literal('local'),
  v.literal('kinde')
);

export const usageStatusValidator = v.union(
  v.literal('applied'),
  v.literal('deduplicated')
);

/**
 * A gate decision. Three-valued: `degrade` means some budget remains but less
 * than requested, so the caller may proceed at reduced scope rather than being
 * hard-denied.
 */
export const decisionValidator = v.union(
  v.literal('allow'),
  v.literal('deny'),
  v.literal('degrade')
);

export const transactionTypeValidator = v.union(
  v.literal('plan_change'),
  v.literal('credit'),
  v.literal('cancellation')
);

/**
 * A transaction's lifecycle status. Status only ever moves forward:
 * pending → approved → executed → compensated, or pending → rejected, or
 * approved → failed.
 */
export const transactionStatusValidator = v.union(
  v.literal('pending'),
  v.literal('approved'),
  v.literal('rejected'),
  v.literal('executed'),
  v.literal('failed'),
  v.literal('compensated')
);

/**
 * Flat string-keyed metadata. Values are limited to primitives and string
 * arrays so the whole document stays fully typed (no `any` anywhere in the
 * generated types).
 */
export const metadataValidator = v.record(
  v.string(),
  v.union(v.string(), v.number(), v.boolean(), v.null(), v.array(v.string()))
);

export const nullableString = v.union(v.string(), v.null());
export const nullableNumber = v.union(v.number(), v.null());
export const nullableStringArray = v.union(v.array(v.string()), v.null());
