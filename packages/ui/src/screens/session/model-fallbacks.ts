import type { StageId } from "@agentx/contracts/web";
/** One stage that ran on a model other than the one wanted (an entry of the task view's `modelFallbacks`). A stage a newer server added reads as "unknown". */
export type ModelFallbackNote = { stage: StageId | "unknown"; used: string; wanted: string | null };
export const STAGE_NAMES: Readonly<Record<StageId, string>> = { understand: "Understand", plan: "Plan", plan_check: "Plan check", build: "Build", code_review: "Code review", security_review: "Security review", pull_request: "Pull request" };
export const UNKNOWN_STAGE_NAME = "A stage";
export const stageName = (stage: StageId | "unknown"): string => stage === "unknown" ? UNKNOWN_STAGE_NAME : STAGE_NAMES[stage];
/** The sentence for one fallback. The model ids are plain text for the caller to make inert; the reason code is never shown. A note that names the used model as the unavailable one (recorded before QA-06 was fixed) says "the preferred model". */
export const fallbackSentence = (note: ModelFallbackNote): string => "Used " + note.used + " because " + (note.wanted === null || note.wanted === note.used ? "the preferred model" : note.wanted) + " was unavailable.";

/**
 * Experience lane (task page): the repeats of one fallback collapse into one plain line; the raw model ids and the repeats stay behind a "Details" disclosure.
 * No size or order is claimed (a newer Sonnet can be the stronger model): the line says "a different model". A friendly model name is read only from the id's own family word (opus, sonnet, haiku, gpt); any other id is never guessed at ("the preferred model").
 */
const FAMILY_NAME: Readonly<Record<string, string>> = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", gpt: "GPT" };
export const modelFamily = (id: string | null): string | undefined => id === null ? undefined : /(?:^|[^a-z])(opus|sonnet|haiku|gpt)(?![a-z])/iu.exec(id)?.[1]?.toLowerCase();
export const friendlyModel = (id: string | null): string | undefined => { const family = modelFamily(id); return family === undefined ? undefined : FAMILY_NAME[family]; };
const stageLower = (stage: StageId | "unknown"): string => stage === "unknown" ? "a step" : stageName(stage).toLowerCase();

export interface CollapsedFallbacks {
 /** The one plain line, with no model id. */
 line: string;
 /** One row per distinct fallback, with its raw ids and how many times it was recorded. */
 details: Array<{ stage: StageId | "unknown"; sentence: string; count: number }>;
}
/** One plain line for all of a task's fallbacks (nothing for none). One distinct fallback names its stage and the model that was unavailable; several name their stages. */
export function collapseFallbacks(notes: readonly ModelFallbackNote[]): CollapsedFallbacks | undefined {
 if (notes.length === 0) return undefined;
 const distinct = new Map<string, { note: ModelFallbackNote; count: number }>();
 for (const note of notes) { const key = [note.stage, note.used, note.wanted ?? ""].join("\u0000"), seen = distinct.get(key);if (seen === undefined) distinct.set(key, { note, count: 1 });else seen.count += 1; }
 const rows = [...distinct.values()], stages = [...new Set(rows.map(row => row.note.stage))].map(stageLower);
 const first = rows[0]!.note, wantedName = friendlyModel(first.wanted === first.used ? null : first.wanted);
 const why = rows.length === 1 ? (wantedName === undefined ? "the preferred model was unavailable" : wantedName + " unavailable") : "the preferred models were unavailable";
 return { line: "Used a different model for " + stages.join(" and ") + ": " + why, details: rows.map(row => ({ stage: row.note.stage, sentence: fallbackSentence(row.note), count: row.count })) };
}
