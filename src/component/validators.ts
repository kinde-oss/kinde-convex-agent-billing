import {v} from 'convex/values';

export const principalTypeValidator = v.union(
  v.literal('user'),
  v.literal('org'),
  v.literal('agent')
);

export const budgetSourceValidator = v.union(
  v.literal('local'),
  v.literal('provider')
);

export const usageStatusValidator = v.union(
  v.literal('applied'),
  v.literal('deduplicated')
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
