// The company How we work page: its edit state. Pure; it holds no model logic (no ranking, no safety, no independence): it only shapes the overrides the person set and checks that a lock is complete, as the contract requires.
import { modelOf, type CompanyOverride, type CompanyOverrides, type StageId } from "../../../api/stage-models.js";
import { COMPANY_ROWS, type CompanyRow } from "../../../api/stage-cards.js";
export type { CompanyRow };
export type EffortChoice = "inherit" | "null" | NonNullable<CompanyOverride["thinkingLevel"]>;

const isEmpty = (entry: CompanyOverride) => !entry.locked && entry.model === undefined && entry.thinkingLevel === undefined && entry.fallbackModel === undefined && entry.differentFrom === undefined;
const tidy = (entry: CompanyOverride): CompanyOverride => ({ ...(entry.model === undefined ? {} : { model: { provider: entry.model.provider, modelId: entry.model.modelId } }), ...(entry.thinkingLevel === undefined ? {} : { thinkingLevel: entry.thinkingLevel }), ...(entry.fallbackModel === undefined ? {} : { fallbackModel: { provider: entry.fallbackModel.provider, modelId: entry.fallbackModel.modelId } }), ...(entry.differentFrom === undefined ? {} : { differentFrom: { stage: entry.differentFrom.stage, level: entry.differentFrom.level } }), locked: entry.locked });
/** The same overrides in one fixed key order, without entries that say nothing: the form a PUT and a comparison use. */
export function normalize(overrides: CompanyOverrides): CompanyOverrides {
 const out: CompanyOverrides = {};
 for (const id of (Object.keys(overrides) as StageId[]).sort()) { const entry = overrides[id];if (entry !== undefined && !isEmpty(entry)) out[id] = tidy(entry); }
 return out;
}
export const sameOverrides = (a: CompanyOverrides, b: CompanyOverrides) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
const entryOf = (overrides: CompanyOverrides, id: StageId): CompanyOverride | undefined => { const entry = overrides[id];return entry === undefined || isEmpty(entry) ? undefined : tidy(entry); };
/** What a row shows: the entry of the stage that names its edit group (Plan, for Plan and Understand), else of its first stage. */
export const rowEntry = (overrides: CompanyOverrides, row: CompanyRow): CompanyOverride | undefined => entryOf(overrides, row.base);
/** A row can host several stages (two reviewers; Plan and Understand); when the saved settings differ between them the row says so, and a change to the row sets all of them the same. */
export const rowSplit = (overrides: CompanyOverrides, row: CompanyRow): boolean => row.stages.some(id => JSON.stringify(entryOf(overrides, id) ?? null) !== JSON.stringify(rowEntry(overrides, row) ?? null));

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** Whether the server's "default applies" answer still holds for the draft of this row: the server said the saved row has nothing set (`reviewDefaults` of the policy read), and the draft has not set a model or a rule since. The rule itself is the server's; this only tells whether the person has changed it. */
export const defaultStillApplies = (entry: CompanyOverride | undefined, saved: CompanyOverride | undefined, serverDefault: boolean): boolean => serverDefault && same(entry?.model, saved?.model) && same(entry?.differentFrom, saved?.differentFrom);
/** The state of a row's "Different vendor" switch: a vendor rule somebody set, or the default the server says applies. */
export const vendorOn = (entry: CompanyOverride | undefined, saved: CompanyOverride | undefined, serverDefault: boolean): boolean => entry?.differentFrom?.level === "vendor" || defaultStillApplies(entry, saved, serverDefault);

export interface RowPatch { model?: string; effort?: EffortChoice; vendor?: boolean; locked?: boolean }
/** Applies one change to every stage of the row. A change to a split row starts from its base stage's settings. */
export function patchRow(overrides: CompanyOverrides, row: CompanyRow, patch: RowPatch): CompanyOverrides {
 const base = rowEntry(overrides, row), next: CompanyOverrides = { ...overrides };
 let entry: CompanyOverride = base ?? { locked: false };
 if (patch.model !== undefined) { const rest = { ...entry };delete rest.model;entry = patch.model === "" ? rest : { ...rest, model: modelOf(patch.model) }; }
 if (patch.effort !== undefined) { const rest = { ...entry };delete rest.thinkingLevel;entry = patch.effort === "inherit" ? rest : { ...rest, thinkingLevel: patch.effort === "null" ? null : patch.effort }; }
 if (patch.vendor !== undefined && row.reference !== undefined) {
  // Owner decision 2026-11-02: an unset checking step defaults to "a different company" (shown as on). Off writes the explicit different-model rule (the way back to today's behaviour). On again removes the rule and returns to the default;
  // the vendor rule is written only where the default cannot hold: the row has a model or is locked (a lock is a complete tuple).
  const rest = { ...entry };delete rest.differentFrom;
  entry = patch.vendor && entry.model === undefined && !entry.locked ? rest : { ...rest, differentFrom: { stage: row.reference, level: patch.vendor ? "vendor" : "model" } };
 }
 if (patch.locked !== undefined) entry = { ...entry, locked: patch.locked };
 for (const id of row.stages) { if (isEmpty(entry)) delete next[id];else next[id] = tidy(entry); }
 return next;
}
/** A locked entry must hold a complete tuple: a model, an effort (null counts) and, for a checking stage, the different-from rule. */
export const lockIncomplete = (entry: CompanyOverride | undefined, row: CompanyRow): boolean => entry !== undefined && entry.locked && (entry.model === undefined || entry.thinkingLevel === undefined || (row.reference !== undefined && entry.differentFrom === undefined));
/** The titles of the rows whose lock is incomplete (checked on every stage a row writes). */
export const incompleteLocks = (overrides: CompanyOverrides): string[] => COMPANY_ROWS.filter(row => row.stages.some(id => lockIncomplete(overrides[id], row))).map(row => row.title);
