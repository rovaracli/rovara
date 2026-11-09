// Standing instructions (lane I1, switch `si`): leaf module (no broker imports), so the dispatch and the tests can read it.
// It is a packed broker setting (stack parameter StandingInstructionsEnabled, "0" by default) that reaches the broker as STANDING_INSTRUCTIONS_ENABLED. It is on only when it is exactly "1".
import { BROKER_SETTINGS, liveInteractionFlagOn } from "@agentx/contracts";

/**
 * Whether "How we work" moves from the user message into the system prompt block. Anything but exactly "1" is off: the project's layers reach the step as they always did.
 * (Company rules are not behind this switch: an install that has a company instructions source sends them either way.)
 */
export const standingInstructionsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => liveInteractionFlagOn(env[BROKER_SETTINGS.standingInstructions.variable]);
