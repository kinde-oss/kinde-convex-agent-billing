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

/** The outcome of a `check` gate decision. */
export type GateResult = FunctionReturnType<ComponentApi['enforce']['check']>;

/** The result of verifying a mandate. */
export type MandateVerifyResult = FunctionReturnType<
  ComponentApi['mandates']['verify']
>;

/** The result of reporting metered usage to Kinde. */
export type PushUsageResult = FunctionReturnType<
  ComponentApi['kinde']['pushUsage']
>;

/** The result of syncing a Kinde entitlement into a local budget. */
export type SyncEntitlementsResult = FunctionReturnType<
  ComponentApi['kinde']['syncEntitlements']
>;

/** The result of a Kinde plan change. */
export type ChangePlanResult = FunctionReturnType<
  ComponentApi['kinde']['changePlan']
>;

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

  // --- Enforce ---

  check(
    ctx: RunMutationCtx,
    args: FunctionArgs<ComponentApi['enforce']['check']>
  ) {
    return ctx.runMutation(this.component.enforce.check, args);
  }

  // --- Delegate (mandates) ---

  mintMandate(
    ctx: RunMutationCtx,
    args: FunctionArgs<ComponentApi['mandates']['mint']>
  ) {
    return ctx.runMutation(this.component.mandates.mint, args);
  }

  verifyMandate(
    ctx: RunQueryCtx,
    args: FunctionArgs<ComponentApi['mandates']['verify']>
  ) {
    return ctx.runQuery(this.component.mandates.verify, args);
  }

  revokeMandate(
    ctx: RunMutationCtx,
    args: FunctionArgs<ComponentApi['mandates']['revoke']>
  ) {
    return ctx.runMutation(this.component.mandates.revoke, args);
  }

  getMandate(
    ctx: RunQueryCtx,
    args: FunctionArgs<ComponentApi['mandates']['get']>
  ) {
    return ctx.runQuery(this.component.mandates.get, args);
  }

  listMandatesForPrincipal(
    ctx: RunQueryCtx,
    args: FunctionArgs<ComponentApi['mandates']['listForPrincipal']>
  ) {
    return ctx.runQuery(this.component.mandates.listForPrincipal, args);
  }

  listMandatesForAgent(
    ctx: RunQueryCtx,
    args: FunctionArgs<ComponentApi['mandates']['listForAgent']>
  ) {
    return ctx.runQuery(this.component.mandates.listForAgent, args);
  }

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

  // --- Kinde billing integration ---

  setKindeCustomer(
    ctx: RunMutationCtx,
    args: FunctionArgs<ComponentApi['kinde']['setCustomerMapping']>
  ) {
    return ctx.runMutation(this.component.kinde.setCustomerMapping, args);
  }

  pushUsageToKinde(
    ctx: RunFullCtx,
    args: FunctionArgs<ComponentApi['kinde']['pushUsage']>
  ) {
    return ctx.runAction(this.component.kinde.pushUsage, args);
  }

  syncEntitlements(
    ctx: RunFullCtx,
    args: FunctionArgs<ComponentApi['kinde']['syncEntitlements']>
  ) {
    return ctx.runAction(this.component.kinde.syncEntitlements, args);
  }

  changePlan(
    ctx: RunFullCtx,
    args: FunctionArgs<ComponentApi['kinde']['changePlan']>
  ) {
    return ctx.runAction(this.component.kinde.changePlan, args);
  }
}
