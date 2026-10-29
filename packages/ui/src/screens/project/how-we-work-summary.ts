// "How we work": the change a draft would make, in plain words, from the agent diff route's answer.
import type { ReadRecipeDiff } from "../builder/recipe-comparison.js";
import { comparisonRows } from "../builder/recipe-comparison.js";
import { REVIEWING_KINDS } from "./how-we-work-rows.js";
export interface ChangeSummary { changes: string[]; lessSafe: string[] }
type Step = { id: string; name: string; kind: string; settings?: { instructions?: ReadonlyArray<{ text: string }> } | undefined };
const texts = (step: Step | undefined): string => JSON.stringify((step?.settings?.instructions ?? []).map(layer => layer.text).filter(text => text !== ""));
/** What changes (the comparison's own labels, then the route's plain descriptions), and what makes the change less safe: the route's reasons, and instructions written for a stage that checks work. */
export function summariseChange(diff: ReadRecipeDiff): ChangeSummary {
 const rows = comparisonRows(diff).map(row => row.label), changes = rows.length > 0 ? rows : diff.changes.filter(change => !change.startsWith("/")), lessSafe = [...diff.lessSafe];
 const before = (diff.comparison?.before.steps ?? []) as Step[];
 for (const step of (diff.comparison?.after.steps ?? []) as Step[]) {
  if (REVIEWING_KINDS.has(step.kind) && texts(step) !== texts(before.find(other => other.id === step.id))) lessSafe.push("Changes the instructions of the " + (step.kind === "plan_critic" ? "plan check" : "review step") + ' "' + step.name + '"');
 }
 return { changes: [...new Set(changes)], lessSafe: [...new Set(lessSafe)] };
}
