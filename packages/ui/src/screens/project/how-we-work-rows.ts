// "How we work": the six rows of a stage card, worked out from the view. Every value carries the marker the server gave it.
import type { HowWeWorkViewRead } from "@agentx/contracts/web";
/** The view as the page reads it (a newer server may send a word this page does not know: such a value reads as "unknown"). */
export type ViewRead = HowWeWorkViewRead;
export type StageRead = ViewRead["stages"][number];
export type RowId = "who" | "knows" | "may" | "checked" | "evidence" | "approves";
export const ROW_TITLES: Record<RowId, string> = { who: "Who does it", knows: "What it knows", may: "What it may do", checked: "How it's checked", evidence: "Evidence", approves: "Who approves" };
export interface Mark { source: string; locked: boolean; lockedBy?: string | undefined }
interface Entry<T> extends Mark { value: T }
export interface RowValue { label?: string; text: string; mark: Mark; block?: boolean }
export interface Row { id: RowId; title: string; values: RowValue[] }
export type Filter = "all" | "changed" | "locked";
export type MarkerKind = "locked" | "changed" | "inherited";
export const markerKind = (mark: Mark): MarkerKind => mark.locked ? "locked" : mark.source === "project" ? "changed" : "inherited";
export const markerWords = (mark: Mark): string => mark.locked ? (mark.lockedBy === "company" ? "Locked by company" : "Locked by Rovara") : mark.source === "project" ? "Changed here" : "Inherited";
const of = <T>(entry: Entry<T>, text: string, label?: string, block?: boolean): RowValue => ({ ...(label === undefined ? {} : { label }), text, mark: { source: entry.source, locked: entry.locked, ...(entry.lockedBy === undefined ? {} : { lockedBy: entry.lockedBy }) }, ...(block ? { block } : {}) });
const listed = (entries: ReadonlyArray<Entry<string>>): RowValue[] => entries.map(entry => of(entry, entry.value));
/** A fact Rovara keeps for safety: locked, and the project cannot change it. */
const SAFETY: Mark = { source: "rovara", locked: true, lockedBy: "rovara" };

export function stageRows(stage: StageRead, view: Pick<ViewRead, "stages">): Row[] {
 const names = new Map(view.stages.map(other => [other.id, other.name])), who: RowValue[] = [];
 // V3: no model or thinking value is read from this view: it decides none. The stage models come from the resolver's own read (api/stage-models.ts).
 if (stage.who.differentCompanyFrom.value.length > 0) who.push(of(stage.who.differentCompanyFrom, stage.who.differentCompanyFrom.value.map(id => names.get(id) ?? id).join(", "), "Different AI company from"));
 const may: RowValue[] = [of(stage.may.tools, stage.may.tools.value === null ? "Any tool this stage is given" : stage.may.tools.value.join(", "), "Tools")];
 if (stage.may.readOnly) may.push({ text: "Can read, can't change files", mark: SAFETY });
 return [
  { id: "who", title: ROW_TITLES.who, values: who },
  { id: "knows", title: ROW_TITLES.knows, values: stage.knows.instructions.map(layer => of(layer, layer.value, undefined, true)) },
  { id: "may", title: ROW_TITLES.may, values: may },
  { id: "checked", title: ROW_TITLES.checked, values: listed(stage.checked.items) },
  { id: "evidence", title: ROW_TITLES.evidence, values: listed(stage.evidence.items) },
  { id: "approves", title: ROW_TITLES.approves, values: listed(stage.approves.items) },
 ];
}
/** The rows a card shows. "All" shows the rows with a changed or locked value (every row with `showUnchanged`); the other filters show the rows with such a value. `forced` rows always show. */
export function visibleRows(rows: readonly Row[], filter: Filter, showUnchanged: boolean, forced: ReadonlySet<RowId>): Row[] {
 return rows.filter(row => {
  if (forced.has(row.id)) return true;
  const changed = row.values.some(value => markerKind(value.mark) === "changed"), locked = row.values.some(value => value.mark.locked);
  return filter === "changed" ? changed : filter === "locked" ? locked : showUnchanged || changed || locked;
 });
}
export const hasChanged = (stage: StageRead, view: Pick<ViewRead, "stages">): boolean => stageRows(stage, view).some(row => row.values.some(value => markerKind(value.mark) === "changed"));
/** The stages that take instructions of their own: the ones that run a model. */
export const EDITABLE_KINDS: ReadonlySet<string> = new Set(["plan", "plan_critic", "build", "review"]);
/** The stages that check work: instructions written for them are a less-safe change (a second person confirms). */
export const REVIEWING_KINDS: ReadonlySet<string> = new Set(["plan_critic", "review"]);
