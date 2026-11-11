// Four test results (setup and test health, SH20): the install switch. A task and its pull request show one of Verified, Code failed, Partially verified or Blocked by environment (with a Testing section),
// and an environment fault opens a Fix setup card, only where this is on. Off by default (owner decision 5: the four results turn on in the 0.5.0 staging release, after a replay of recent tasks shows no
// code failure labelled as environment). A packed broker setting (stack parameter VerifyResultsEnabled, "0" by default) that reaches the broker as VERIFY_RESULTS_ENABLED; on only when it is exactly "1".
// Leaf module (no broker imports), so the autofix runner, the card source, the pull request body and the task view can all read it.
import { BROKER_SETTINGS } from "@agentx/cloud-contracts";
import { liveInteractionFlagOn } from "@rovara-code/contracts";

/** Whether the four test results (and the Fix setup card and the Testing section) exist in this install. Anything but exactly "1" (unset, empty, "true", " 1") is off. */
export const verifyResultsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => liveInteractionFlagOn(env[BROKER_SETTINGS.verifyResults.variable]);
