import { STAGE_IDS, type StageId } from "@agentx/contracts/web";
/** One stage that ran on a model other than the one wanted. `stage` is lane C's StageId when this build knows it; a stage a newer server added reads as undefined. */
export type ModelFallbackNote = { stage: StageId | undefined; used: string; wanted: string | null };
const MAX_NOTES = 64;
export const STAGE_NAMES: Readonly<Record<StageId, string>> = { understand: "Understand", plan: "Plan", plan_check: "Plan check", build: "Build", code_review: "Code review", security_review: "Security review", pull_request: "Pull request" };
export const UNKNOWN_STAGE_NAME = "A stage";
const isStage = (value: unknown): value is StageId => typeof value === "string" && (STAGE_IDS as readonly string[]).includes(value);
export const stageName = (stage: StageId | undefined): string => stage === undefined ? UNKNOWN_STAGE_NAME : STAGE_NAMES[stage];
/** The sentence for one fallback. The model ids are plain text for the caller to make inert; the reason code is never shown. */
export const fallbackSentence = (note: ModelFallbackNote): string => "Used " + note.used + " because " + (note.wanted === null ? "the preferred model" : note.wanted) + " was unavailable.";
// Until lane C's view field lands: `modelFallbacks` is not in this branch's task view type, so it is read from the loose task object. Missing, malformed or empty gives [] (nothing shown); a bad entry is skipped, never the whole list.
export function readModelFallbacks(task: object | undefined): ModelFallbackNote[] {
 const raw = (task as { modelFallbacks?: unknown } | undefined)?.modelFallbacks;
 if (!Array.isArray(raw)) return [];
 const notes: ModelFallbackNote[] = [];
 for (const entry of raw.slice(0, MAX_NOTES) as unknown[]) {
  if (typeof entry !== "object" || entry === null) continue;
  const { stage, used, wanted } = entry as Record<string, unknown>;
  if (typeof used !== "string" || used.length === 0 || !(wanted === null || wanted === undefined || (typeof wanted === "string" && wanted.length > 0))) continue;
  notes.push({ stage: isStage(stage) ? stage : undefined, used, wanted: typeof wanted === "string" ? wanted : null });
 }
 return notes;
}
