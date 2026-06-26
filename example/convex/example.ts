import {query} from './_generated/server.js';
import {components} from './_generated/api.js';
import {AgentBilling} from '@kinde-oss/kinde-convex-agent-billing';
import {v} from 'convex/values';

/**
 * The component client. Construct it once with the component reference from the
 * app's generated `components` object. Wrapper methods arrive in later phases.
 */
export const agentBilling = new AgentBilling(components.agentBilling);

export const health = query({
  args: {},
  returns: v.string(),
  handler: async () => 'ok'
});
