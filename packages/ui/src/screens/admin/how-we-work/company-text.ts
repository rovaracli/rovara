// The company How we work page: the fixed words. Nothing here comes from the server; reasons arrive as codes and map to these sentences.
import { REFUSAL_TEXT } from "../../project/stage-model-text.js";
import { REFUSAL_CODES, type RefusalCode } from "../../../api/stage-models.js";
export const PAGE_TITLE = "How we work (company)";
export const PAGE_NOTE = "Set the default model and effort for each stage, and lock a stage so projects can't change it. A project's own choice applies only inside these limits.";
export const MODEL_NOTE = "Pick models after the model list is available.";
export const SAVED = "Saved. New tasks use these defaults; running tasks keep theirs.";
export const OTHER_ADMIN = "Another company admin must confirm this less-safe change.";
export const soleOwnerText = (time: string) => "You're the only admin. You can confirm this yourself after " + time + " (a 24-hour safety wait).";
export const STALE = REFUSAL_TEXT.POLICY_STALE;
export const INCOMPLETE_LOCK = "A locked stage needs a model, an effort (or Model default) and, for a checking stage, a vendor rule.";
export const CARD_INCOMPLETE = "To lock this stage, set its model, effort and, for a checking stage, the vendor rule first.";
export const PREVIEW_INCOMPLETE = "This list may be incomplete.";
export const PREVIEW_FAILED = "Couldn't check which projects are affected. You can still save.";
export const PREVIEW_UNAVAILABLE = "Projects couldn't be checked right now. You can still save.";
export const SAVE_FAILED = "Couldn't save the company defaults. Try again.";
export const DENIED = "You don't have permission to change the company defaults.";
export const SPLIT = "Code review and security review have different settings today. Saving a change here sets both the same.";
export const IMPACT_TEXT = { unchanged: "No change", changed: "Will change", blocked: "Will be blocked", unavailable: "Couldn't be checked" } as const;
export const UNKNOWN_REASON = "This project couldn't be checked.";
const isRefusal = (code: string): code is RefusalCode => (REFUSAL_CODES as readonly string[]).includes(code);
/** A refusal or reason code in its fixed sentence; any other code is the generic one. */
export const reasonText = (code: string): string => isRefusal(code) ? REFUSAL_TEXT[code] : UNKNOWN_REASON;
