// Saved environments (setup-test-health SH25): the install switch `sv`. Leaf module (no broker imports), so the registry, the push and pull routes, the task start and the dispatch payload can all read it. It is a
// packed broker setting (stack parameter SavedEnvEnabled, "0" by default) that reaches the broker as SAVED_ENV_ENABLED, and it is on only when it is exactly "1". Off is today's flow: no image is built, pushed, pulled,
// listed, deleted or sent to a worker, whatever a project set.
import { BROKER_SETTINGS, liveInteractionFlagOn } from "@agentx/contracts";

/** Whether saved environments exist in this environment. Anything but exactly "1" (unset, empty, "true", " 1") is off. */
export const savedEnvEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => liveInteractionFlagOn(env[BROKER_SETTINGS.savedEnv.variable]);
