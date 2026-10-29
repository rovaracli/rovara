// The company How we work page: its edit state. Pure; it holds no model logic (no ranking, no safety, no independence): it only shapes the overrides the person set and checks that a lock is complete, as the contract requires.
import { COMPANY_ROWS, type CompanyOverride, type CompanyOverrides, type StageId } from "../../../api/stage-models.js";
export type CompanyRow = (typeof COMPANY_ROWS)[number];
export type EffortChoice = "inherit" | "null" | NonNullable<CompanyOverride["effort"]>;

const isEmpty = (entry: CompanyOverride) => !entry.locked && entry.model === undefined && entry.effort === undefined && entry.differentFrom === undefined;
const tidy = (entry: CompanyOverride): CompanyOverride => ({ ...(entry.model === undefined ? {} : { model: entry.model }), ...(entry.effort === undefined ? {} : { effort: entry.effort }), ...(entry.differentFrom === undefined ? {} : { differentFrom: { stage: entry.differentFrom.stage, level: entry.differentFrom.level } }), locked: entry.locked });
/** The same overrides in one fixed key order, without entries that say nothing: the form a PUT and a comparison use. */
export function normalize(overrides: CompanyOverrides): CompanyOverrides {
 const out: CompanyOverrides = {};
 for (const id of (Object.keys(overrides) as StageId[]).sort()) { const entry = overrides[id];if (entry !== undefined && !isEmpty(entry)) out[id] = tidy(entry); }
 return out;
}
export const sameOverrides = (a: CompanyOverrides, b: CompanyOverrides) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
const entryOf = (overrides: CompanyOverrides, id: StageId): CompanyOverride | undefined => { const entry = overrides[id];return entry === undefined || isEmpty(entry) ? undefined : tidy(entry); };
/** What a row shows: its first stage's entry. */
export const rowEntry = (overrides: CompanyOverrides, row: CompanyRow): CompanyOverride | undefined => entryOf(overrides, row.stages[0]);
/** A review row hosts two reviewers; when the saved settings differ between them the row says so, and a change to the row sets both the same. */
export const rowSplit = (overrides: CompanyOverrides, row: CompanyRow): boolean => row.stages.length > 1 && JSON.stringify(entryOf(overrides, row.stages[0]) ?? null) !== JSON.stringify(entryOf(overrides, row.stages[1]!) ?? null);

export interface RowPatch { effort?: EffortChoice; vendor?: boolean; locked?: boolean }
/** Applies one change to every stage of the row. A change to a split review row starts from its first reviewer's settings. */
export function patchRow(overrides: CompanyOverrides, row: CompanyRow, patch: RowPatch): CompanyOverrides {
 const base = rowEntry(overrides, row), next: CompanyOverrides = { ...overrides };
 let entry: CompanyOverride = base ?? { locked: false };
 if (patch.effort !== undefined) { const rest = { ...entry };delete rest.effort;entry = patch.effort === "inherit" ? rest : { ...rest, effort: patch.effort === "null" ? null : patch.effort }; }
 if (patch.vendor !== undefined && row.reference !== undefined) { const rest = { ...entry };delete rest.differentFrom;entry = patch.vendor ? { ...rest, differentFrom: { stage: row.reference, level: "vendor" } } : rest; }
 if (patch.locked !== undefined) entry = { ...entry, locked: patch.locked };
 for (const id of row.stages) { if (isEmpty(entry)) delete next[id];else next[id] = tidy(entry); }
 return next;
}
/** A locked entry must hold a complete tuple: a model, an effort (null counts) and, for a checking stage, the different-from rule. */
export const lockIncomplete = (entry: CompanyOverride | undefined, row: CompanyRow): boolean => entry !== undefined && entry.locked && (entry.model === undefined || entry.effort === undefined || (row.reference !== undefined && entry.differentFrom === undefined));
/** The titles of the rows whose lock is incomplete (checked on every stage a row writes). */
export const incompleteLocks = (overrides: CompanyOverrides): string[] => COMPANY_ROWS.filter(row => row.stages.some(id => lockIncomplete(overrides[id], row))).map(row => row.title);
