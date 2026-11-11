// Script tokens (UX5b): the install switch `pt`. Leaf module (no broker imports). A packed broker setting (stack parameter ScriptTokensEnabled, "0" by default) that reaches the broker as
// SCRIPT_TOKENS_ENABLED, on only when it is exactly "1". Off: the settings routes are not found and every script token is refused, whatever is stored.
import { BROKER_SETTINGS } from "@agentx/cloud-contracts";
import { liveInteractionFlagOn } from "@rovara-code/contracts";

/** Whether script tokens exist in this environment. Anything but exactly "1" is off. */
export const scriptTokensEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => liveInteractionFlagOn(env[BROKER_SETTINGS.scriptTokens.variable]);
