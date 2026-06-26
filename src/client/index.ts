import type {
  FunctionArgs,
  FunctionReturnType,
  GenericActionCtx,
  GenericDataModel
} from 'convex/server';
import type {ComponentApi} from '../component/_generated/component.js';

export type {ComponentApi} from '../component/_generated/component.js';

export type RunQueryCtx = Pick<GenericActionCtx<GenericDataModel>, 'runQuery'>;
export type RunMutationCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  'runQuery' | 'runMutation'
>;
export type RunFullCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  'runQuery' | 'runMutation' | 'runAction'
>;

/** The outcome of a metered `record` call. */
export type RecordResult = FunctionReturnType<ComponentApi['usage']['record']>;

/** A budget as it behaves right now (see `budgets.getEffective`). */
export type EffectiveBudget = NonNullable<
  FunctionReturnType<ComponentApi['budgets']['getEffective']>
>;

/** A single recorded usage event. */
export type UsageEvent = FunctionReturnType<
  ComponentApi['usage']['listForPrincipal']
>[number];

/**
 * Options for the {@link AgentBilling} client. Empty for now — the provider and
 * `verifyCaller` slots arrive in later phases. Kept as an interface (rather than
 * an alias) so those options can be added without changing the public type.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AgentBillingOptions {}

/**
 * Client for the Kinde agent billing component.
 *
 * Construct it with the component reference from your app's generated
 * `components` object:
 *
 * ```ts
 * import {AgentBilling} from '@kinde-oss/kinde-convex-agent-billing';
 * import {components} from './_generated/api.js';
 *
 * export const agentBilling = new AgentBilling(components.agentBilling);
 * ```
 *
 * Every method is a thin pass-through to a component function. The Observe
 * methods are ordinary query wrappers: reactivity comes from the app calling
 * them inside `useQuery`, not from anything in this client.
 */
export class AgentBilling {
  constructor(
    public readonly component: ComponentApi,
    public readonly options: AgentBillingOptions = {}
  ) {}

  // --- Meter ---

  record(
    ctx: RunMutationCtx,
    args: FunctionArgs<ComponentApi['usage']['record']>
  ) {
    return ctx.runMutation(this.component.usage.record, args);
  }

  // --- Observe ---

  getBudget(
    ctx: RunQueryCtx,
    args: FunctionArgs<ComponentApi['budgets']['getEffective']>
  ) {
    return ctx.runQuery(this.component.budgets.getEffective, args);
  }

  getRawBudget(
    ctx: RunQueryCtx,
    args: FunctionArgs<ComponentApi['budgets']['get']>
  ) {
    return ctx.runQuery(this.component.budgets.get, args);
  }

  listUsage(
    ctx: RunQueryCtx,
    args: FunctionArgs<ComponentApi['usage']['listForPrincipal']>
  ) {
    return ctx.runQuery(this.component.usage.listForPrincipal, args);
  }

  getUsageEvent(
    ctx: RunQueryCtx,
    args: FunctionArgs<ComponentApi['usage']['getEvent']>
  ) {
    return ctx.runQuery(this.component.usage.getEvent, args);
  }

  // --- Budget administration (local mode) ---

  setBudget(
    ctx: RunMutationCtx,
    args: FunctionArgs<ComponentApi['budgets']['set']>
  ) {
    return ctx.runMutation(this.component.budgets.set, args);
  }
}
