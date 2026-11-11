// Second review by a different AI company: the install switch `cr`. Leaf module (no broker imports), so the review dispatch, the task view and the pull request body can all read it. It is a packed
// broker setting (stack parameter SecondReviewEnabled, "0" by default) that reaches the broker as SECOND_REVIEW_ENABLED, and it is on only when it is exactly "1". Off is today's flow: no second
// review is planned, run, recorded or shown, whatever a project or company set.
import { BROKER_SETTINGS } from "@agentx/cloud-contracts";
import { liveInteractionFlagOn } from "@rovara-code/contracts";

/** Whether the second review by another AI company exists in this environment. Anything but exactly "1" (unset, empty, "true", " 1") is off. */
export const secondReviewEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => liveInteractionFlagOn(env[BROKER_SETTINGS.secondReview.variable]);
