import type {GenericActionCtx, GenericDataModel} from 'convex/server';
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
 * Methods arrive in later phases.
 */
export class AgentBilling {
  constructor(public readonly component: ComponentApi) {}
}
