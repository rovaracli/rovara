// "How we work": the fixed words of the model rows. The sentences come from lane C's refusal table (C53, relay 2) and the design's reason table (§9b); the page never writes its own reasons.
import { STAGE_MODEL_THINKING_LEVELS, isReason, isRefusalCode, type Reason, type RefusalCode, type StageCandidate, type StageId } from "../../api/stage-models.js";
import type { SelectOption } from "../../design/Select.js";
export const REFUSAL_TEXT: Readonly<Record<RefusalCode, string>> = {
 MODEL_NOT_VERIFIED: "This account has no fresh verified access to this model.",
 MODEL_STALE: "Verification for this model has expired. Check it again.",
 MODEL_FORBIDDEN: "Your company's rules do not allow this model.",
 MODEL_NOT_ALLOWED_IN_PROJECT: "This project does not allow this model.",
 STAGE_LOCKED: "Your company locked this stage's model choice.",
 DIFFERENT_FROM_UNSATISFIABLE: "No verified model meets this stage's different-model rule.",
 LOCK_UNSATISFIABLE: "The company lock cannot be met with verified models.",
 NO_VERIFIED_CANDIDATE: "No verified model can run this stage.",
 POLICY_STALE: "The model settings changed. Reload and try again.",
 NEEDS_CONFIRMATION: "Another eligible person must confirm this less-safe change.",
 DRAFT_STALE: "This draft changed. Reload and try again.",
};
export const UNKNOWN_REFUSAL_TEXT = "Rovara could not use a model for this stage.";
/** A refusal code in its fixed sentence; a code this build does not know gets the generic one. */
export const refusalText = (code: string): string => isRefusalCode(code) ? REFUSAL_TEXT[code] : UNKNOWN_REFUSAL_TEXT;
export const REASON_LINE: Readonly<Record<Reason, string>> = {
 PROJECT_CHOICE: "Set in this project",
 PROJECT_SELECTION: "Project model setting",
 PROJECT_DEFAULT: "Project default model",
 COMPANY_DEFAULT: "Company default",
 COMPANY_LOCK: "Locked by company",
 BUILTIN_DEFAULT: "Rovara's default",
 APPROVED_SAME_MODEL: "Approved: same model as Build",
};
export const UNKNOWN_REASON_LINE = "Rovara chose it";
export const reasonLine = (reason: string): string => isReason(reason) ? REASON_LINE[reason] : UNKNOWN_REASON_LINE;
export const NOT_VERIFIED_TEXT = "Not verified for your account. Ask an admin to check it in AI & connections.";
export const DRAFT_CHANGED_TEXT = "This draft changed. Reload and try again.";
export const EDITS_REMOVED_TEXT = "Some changes were removed because the company locked a stage or a model is no longer verified.";
export const COST_TEXT = "Cost unavailable";
export const COMPANY_PAGE = "/app/admin/how-we-work";
type StageThinkingLevel = (typeof STAGE_MODEL_THINKING_LEVELS)[number];
export const EFFORT_LABELS: Readonly<Record<StageThinkingLevel, string>> = { off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High" };
/** The effort choices of a stage: Rovara's default, Model default (null) and lane C's stage scale (STAGE_MODEL_THINKING_LEVELS) - nothing else. */
export const EFFORT_OPTIONS: readonly SelectOption[] = [{ value: "inherit", label: "Rovara's default" }, { value: "null", label: "Model default" }, ...STAGE_MODEL_THINKING_LEVELS.map(level => ({ value: level, label: EFFORT_LABELS[level] }))];
export const effortLabel = (level: string): string => Object.hasOwn(EFFORT_LABELS, level) ? EFFORT_LABELS[level as StageThinkingLevel] : "Model default";
/** The names above each stage's result on a card that holds several stages. */
export const STAGE_NAMES: Readonly<Partial<Record<StageId, string>>> = { understand: "Understand", plan: "Plan", code_review: "Code review", security_review: "Security review" };
/** Why a candidate cannot be chosen, in the fixed words; undefined when it is verified and not blocked (the only kind that can be chosen). */
export function candidateBlock(candidate: StageCandidate): string | undefined {
 if (candidate.blockedReason !== undefined) return refusalText(candidate.blockedReason);
 if (candidate.status === "verified") return undefined;
 return candidate.status === "unverified" ? NOT_VERIFIED_TEXT : candidate.status === "stale" ? REFUSAL_TEXT.MODEL_STALE : REFUSAL_TEXT.MODEL_FORBIDDEN;
}
/** Every stage by name, for a refusal that can name any of them. */
export const STAGE_LABELS: Readonly<Record<StageId, string>> = { understand: "Understand", plan: "Plan", plan_check: "Plan check", build: "Build", code_review: "Code review", security_review: "Security review", pull_request: "Pull request" };
