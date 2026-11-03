// The company How we work page: the fixed words. Nothing here comes from the server; reasons arrive as codes and map to these sentences.
import { REFUSAL_TEXT } from "../../project/stage-model-text.js";
import { isRefusalCode } from "../../../api/stage-models.js";
export const PAGE_TITLE = "How we work (company)";
export const PAGE_NOTE = "Set the default model and effort for each stage, and lock a stage so projects can't change it. A project's own choice applies only inside these limits.";
export const DEFAULT_VENDOR_NOTE = "Not set: this step uses the strongest model from a different company than the step it checks, when your company has one available.";
export const MODEL_NOTE = "Pick models after the model list is available.";
export const NO_VERIFIED = "No verified models are listed for this stage yet.";
export const SAVED = "Saved. New tasks use these defaults; running tasks keep theirs.";
export const MODEL_DEFAULT_OPTION = "Rovara's default";
export const OTHER_ADMIN = "Another company admin must confirm this less-safe change.";
export const OTHER_ADMIN_SHORT = "Another company admin must confirm this.";
export const soleOwnerText = (time: string) => "You're the only admin. You can confirm this yourself after " + time + " (a 24-hour safety wait).";
export const STALE = REFUSAL_TEXT.POLICY_STALE;
export const INCOMPLETE_LOCK = "A locked stage needs a model, an effort (or Model default) and, for a checking stage, a vendor rule.";
export const CARD_INCOMPLETE = "To lock this stage, set its model, effort and, for a checking stage, the vendor rule first.";
export const PREVIEW_INCOMPLETE = "This list may be incomplete.";
export const PREVIEW_FAILED = "Couldn't check which projects are affected. You can still save.";
export const SAVED_RELOAD_FAILED = "Saved, but the page couldn't reload. Reload to see the latest.";
export const SAVE_FAILED = "Couldn't save the company defaults. Try again.";
/** A 403 `MODEL_NOT_ALLOWED` (a same-model company choice, or a company model that is unavailable) is shown in the server's own fixed words, never as a permission problem. */
export const DENIED = "You don't have permission to change the company defaults.";
const SPLIT_TAIL = " have different settings today. Saving a change here sets both the same.";
/** The note on a row whose stages differ, by the row's first stage. */
export const SPLIT: Readonly<Record<string, string>> = { understand: "Plan and Understand" + SPLIT_TAIL, code_review: "Code review and security review" + SPLIT_TAIL };
export const IMPACT_TEXT = { unchanged: "No change", changed: "Will change", blocked: "Will be blocked", unavailable: "Couldn't be checked" } as const;
export const UNKNOWN_REASON = "This project couldn't be checked.";
/** A refusal or reason code in its fixed sentence; any other code is the generic one. */
export const reasonText = (code: string): string => isRefusalCode(code) ? REFUSAL_TEXT[code] : UNKNOWN_REASON;

/** The company "Rule suggestions" row (the master switch of the learning loop). */
export const SUGGESTIONS = {
 HEADING: "Rule suggestions",
 HELP: "Rovara always collects your team's corrections. When suggestions are on, it suggests a rule once the same correction comes up twice.",
 INSTALL_DEFAULT: "(Rovara's default for this install)",
 READ_ONLY: "Only a company owner or admin can change this.",
 CONFIRM: "Turning suggestions on can show suggestions built from corrections collected while they were off.",
 CHANGED: "Someone else changed this. The setting was refreshed.",
 FAILED: "Couldn't change the setting. Try again.",
 LOAD_FAILED: "Couldn't load the suggestions setting.",
 SAVED_ON: "Suggestions are on.",
 SAVED_OFF: "Suggestions are off.",
 TURN_ON: "Turn on",
 TURN_OFF: "Turn off",
 CANCEL: "Cancel",
 RETRY: "Try again",
} as const;

/** The company "Marking known-failing tests" row (the setting "always two people"). Nothing here comes from the server: the server's booleans and expiry choose among these sentences. */
export const KF_POLICY = {
 HEADING: "Marking tests as already failing",
 HELP: "When a test already failed before a change, a project maintainer can mark it as already failing, so it is not held against later changes. By default one maintainer may do that.",
 STATE_OFF: "One maintainer may mark (a second person is asked only when the maintainer owns an affected task, an owner is unknown, or more than 25 tasks are affected).",
 STATE_ON: "Always two people: every mark needs a second, different maintainer or admin.",
 LABEL_OFF: "One maintainer may mark",
 LABEL_ON: "Always two people",
 TURN_ON: "Require two people",
 TURN_ON_HELP: "Applies at once.",
 ASK_OFF: "Ask to turn off",
 ASK_OFF_HELP: "Turning this off needs a different admin to approve it. A company with one admin keeps it on until a second admin joins.",
 SAVED_ON: "Every mark now needs a second person.",
 ASKED_OFF: "Waiting for a different admin to approve turning this off.",
 PENDING_MINE: "You asked to turn this off. A different admin has to approve it.",
 PENDING_OTHER: "An admin asked to turn this off. You can approve it.",
 PENDING_HIDDEN: "A request to turn this off is waiting for a different admin.",
 APPROVE: "Approve turning it off",
 APPROVE_HELP: "You need to have signed in within the last 10 minutes.",
 APPROVED: "Done. One maintainer may mark again.",
 SIGN_IN_AGAIN: "Sign in again",
 CHANGED: "This setting changed. It was read again.",
 FAILED: "Couldn't change the setting. Try again.",
 LOAD_FAILED: "Couldn't load this setting.",
 RETRY: "Try again",
} as const;
export const kfExpiresText = (iso: string): string => `The request expires at ${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC.`;
