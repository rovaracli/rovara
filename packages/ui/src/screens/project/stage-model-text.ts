// "How we work": the fixed words of the model rows. The sentences come from lane C's refusal table (C53, relay 2) and the design's reason table (§9b); the page never writes its own reasons.
import type { Reason, RefusalCode, StageCandidate, StageId, ThinkingLevel } from "../../api/stage-models.js";
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
};
export const REASON_LINE: Readonly<Record<Reason, string>> = {
 PROJECT_CHOICE: "Set in this project",
 PROJECT_SELECTION: "Project model setting",
 PROJECT_DEFAULT: "Project default model",
 COMPANY_DEFAULT: "Company default",
 COMPANY_LOCK: "Locked by company",
 BUILTIN_DEFAULT: "Rovara's default",
 APPROVED_SAME_MODEL: "Approved: same model as Build",
};
export const NOT_VERIFIED_TEXT = "Not verified for your account. Ask an admin to check it in AI & connections.";
export const DRAFT_CHANGED_TEXT = "This draft changed. Reload and try again.";
export const COST_TEXT = "Cost unavailable";
export const COMPANY_PAGE = "/app/admin/how-we-work";
export const EFFORT_LABELS: Readonly<Record<ThinkingLevel, string>> = { off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high" };
export const REVIEWER_NAMES: Readonly<Partial<Record<StageId, string>>> = { code_review: "Code review", security_review: "Security review" };
/** Why a candidate cannot be chosen, in the fixed words; undefined when it is verified and not blocked (the only kind that can be chosen). */
export function candidateBlock(candidate: StageCandidate): string | undefined {
 if (candidate.blockedReason !== undefined) return REFUSAL_TEXT[candidate.blockedReason];
 if (candidate.status === "verified") return undefined;
 return candidate.status === "unverified" ? NOT_VERIFIED_TEXT : candidate.status === "stale" ? REFUSAL_TEXT.MODEL_STALE : REFUSAL_TEXT.MODEL_FORBIDDEN;
}
