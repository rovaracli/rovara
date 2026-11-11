// Setup agent (sh-setup-wire, SH14): the switch `su`. Leaf module (no broker imports), so the routes, the task start, the dispatch payload and the decision cards can all read it.
// It is a packed broker setting (stack parameter SetupAgentEnabled, "0" by default) that reaches the broker as SETUP_AGENT_ENABLED. It is on only when it is exactly "1".
import { BROKER_SETTINGS } from "@agentx/cloud-contracts";
import { liveInteractionFlagOn } from "@rovara-code/contracts";

/** Whether a setup run that runs commands (and the host-ask cards and routes around it) exists in this environment. Anything but exactly "1" is off: setup is then today's draft, prove and confirm. */
export const setupAgentEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => liveInteractionFlagOn(env[BROKER_SETTINGS.setupAgent.variable]);
