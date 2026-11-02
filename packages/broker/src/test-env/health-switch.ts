// Nightly health (SH28): the `nh` switch. Leaf module (no broker imports), so the nightly listener, the task start and the project page can all read it.
// It is a packed broker setting (stack parameter NightlyHealthEnabled, "0" by default) that reaches the broker as NIGHTLY_HEALTH_ENABLED. It is on only when it is exactly "1".
// It does nothing without the test environment (`ev`): there is no nightly run to read then. Callers that start work check both (`nightlyHealthListener`).
import { BROKER_SETTINGS, liveInteractionFlagOn } from "@agentx/contracts";

/** Whether the nightly run sets the project's health (the "Setup needs repair" state, its Fix setup card, the start banner, the optional proposed fix task). Anything but exactly "1" is off. */
export const nightlyHealthEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => liveInteractionFlagOn(env[BROKER_SETTINGS.nightlyHealth.variable]);
