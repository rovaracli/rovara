// Test environment (wire-testenv): the switch. Leaf module (no broker imports), so the setup routes, the task start, the dispatch payload, the nightly schedule and the evidence line can all read it.
// It is a packed broker setting (stack parameter TestEnvironmentEnabled, "0" by default) that reaches the broker as TEST_ENVIRONMENT_ENABLED. It is on only when it is exactly "1".
import { BROKER_SETTINGS } from "@agentx/cloud-contracts";
import { liveInteractionFlagOn } from "@rovara-code/contracts";

/** Whether the project test environment (propose, prove, approve, the task's checks, the nightly run, the evidence line) exists in this environment. Anything but exactly "1" is off. */
export const testEnvironmentEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => liveInteractionFlagOn(env[BROKER_SETTINGS.testEnvironment.variable]);
