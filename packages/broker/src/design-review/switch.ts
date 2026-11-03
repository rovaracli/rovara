// Design review stage, DR7: the `dr` switch. It is a packed broker setting (BROKER_SETTINGS.designReview, AGENTX_SETTINGS code `dr`) that reaches the broker as DESIGN_REVIEW_ENABLED; it is on only when it is exactly "1". No Lambda variable is added
// and no stack parameter exists yet, so no install turns it on. OFF is the whole of today's behaviour: nothing reads the project's setting, `resolveDesignMode` is never called, and no task ever carries a `designReview`.
import { BROKER_SETTINGS, liveInteractionFlagOn } from "@agentx/contracts";

/** Whether the design review stage exists in this environment. Anything but exactly "1" is off. */
export const designReviewEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => liveInteractionFlagOn(env[BROKER_SETTINGS.designReview.variable]);
