import type { StageId } from "@agentx/contracts/web";
/** One stage that ran on a model other than the one wanted (an entry of the task view's `modelFallbacks`). A stage a newer server added reads as "unknown". */
export type ModelFallbackNote = { stage: StageId | "unknown"; used: string; wanted: string | null };
export const STAGE_NAMES: Readonly<Record<StageId, string>> = { understand: "Understand", plan: "Plan", plan_check: "Plan check", build: "Build", code_review: "Code review", security_review: "Security review", pull_request: "Pull request" };
export const UNKNOWN_STAGE_NAME = "A stage";
export const stageName = (stage: StageId | "unknown"): string => stage === "unknown" ? UNKNOWN_STAGE_NAME : STAGE_NAMES[stage];
/** The sentence for one fallback. The model ids are plain text for the caller to make inert; the reason code is never shown. A note that names the used model as the unavailable one (recorded before QA-06 was fixed) says "the preferred model". */
export const fallbackSentence = (note: ModelFallbackNote): string => "Used " + note.used + " because " + (note.wanted === null || note.wanted === note.used ? "the preferred model" : note.wanted) + " was unavailable.";
