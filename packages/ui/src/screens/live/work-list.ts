import { TASK_STATUS_WORDS, statusNeedsSomeone, taskStatusFromSession, type LiveFilterSchema } from "@agentx/cloud-contracts/web";
import type { ReadLiveTile } from "../../api/live.js";
import type { ReadFinishedTile } from "../../api/work-list.js";
import { plainState, type LeadStatus, type PlainState } from "../session/task-plain-state.js";

/**
 * The Work list (experience spec 2 and 6, exp/work-list): pure functions from the rows the broker already sends to what a row shows. Nothing here reads the network or the clock
 * (`now` is passed in). Where the data cannot say something (who acts next, where a finished task ran), the row leaves it out; nothing is guessed.
 */

export const WORK_VIEWS = ["mine", "team", "attention", "finished"] as const;
export type WorkView = (typeof WORK_VIEWS)[number];
export const WORK_VIEW_LABELS: Readonly<Record<WorkView, string>> = { mine: "Mine", team: "Team", attention: "Needs attention", finished: "Finished" };
type LiveFilter = ReturnType<typeof LiveFilterSchema.parse>;

/** Today's Live filters each view reads. Needs attention is two of them: work waiting on me and work that failed. Finished reads the ended-sessions list instead (no live filter). */
export function liveFiltersFor(view: WorkView): readonly LiveFilter[] {
 return view === "mine" ? ["mine"] : view === "team" ? ["team"] : view === "attention" ? ["needs_me", "failed"] : [];
}
/** The view the page address names: `?view=` first, else an old Live link's `?filter=` (needs_me and failed are Needs attention, team is Team, anything else is Mine). */
export function workViewFor(view: string | null | undefined, filter: string | null | undefined): WorkView {
 if ((WORK_VIEWS as readonly string[]).includes(view ?? "")) return view as WorkView;
 return filter === "needs_me" || filter === "failed" ? "attention" : filter === "team" ? "team" : "mine";
}

/** "<1 min", "5 min", "3 h", "2 d". A time from the future (a clock that is a little off) reads as no time at all. */
export function formatAge(ms: number): string {
 const minutes = Math.floor(Math.max(0, ms) / 60_000);
 if (minutes < 1) return "<1 min";
 if (minutes < 60) return String(minutes) + " min";
 const hours = Math.floor(minutes / 60);
 return hours < 24 ? String(hours) + " h" : String(Math.floor(hours / 24)) + " d";
}

/** The plain state of a live tile. The tile carries the broker's one status word (`statusWords`, "Checking", "Needs you: <reason>"), so the exact state is read back from it; a word this build does not know falls back to the tile's session status. */
export function liveStatus(tile: Pick<ReadLiveTile, "status" | "statusWords" | "lastRunFailed">): LeadStatus {
 for (const [state, word] of Object.entries(TASK_STATUS_WORDS)) if (tile.statusWords === word || tile.statusWords.startsWith(word + ": ")) return { state };
 const fallback = taskStatusFromSession({ status: tile.status, ...(tile.lastRunFailed === true ? { lastRunFailed: true as const } : {}) });
 return { state: fallback.state };
}

/** States where Rovara itself is working, so Rovara is who acts next. Same five as the task page's automatic states (task-plain-state.ts keeps its set private). */
const AUTOMATIC = new Set(["understanding", "planning", "reviewing_design", "building", "checking"]);
const MAY_RETRY = new Set(["failed", "finished_run", "needs_you"]);

export interface WorkRow {
 sessionId: string;
 title: string;
 project: string | undefined;
 agent: string | undefined;
 state: PlainState;
 /** Needs a person to act and this viewer can act on it: the sort puts these first and the row is marked. */
 attention: boolean;
 /** "updated 5 min ago" on a live row, "finished 2 d ago" in Finished; undefined when the row has no usable time. The broker has no "waiting since" time, so a live row never says "waiting". */
 age: string | undefined;
 ageMs: number;
 /** The ISO time the age counts from, for a `<time>` element. */
 since: string | undefined;
 /** "You" or "Rovara", only where the row's own data says so. */
 next: string | undefined;
 /** "Cloud", or "On <machine>" (and whether that machine is offline); undefined when the row does not say. */
 place: { text: string; offline: boolean } | undefined;
 /** Present only on a live row: the controls and the approval link a tile carries. */
 live: Pick<ReadLiveTile, "actions" | "following" | "approvalUrl"> | undefined;
}

const ageOf = (iso: string | undefined, now: number): { ms: number; text: string } | undefined => {
 const at = iso === undefined ? Number.NaN : Date.parse(iso);
 return Number.isFinite(at) ? { ms: Math.max(0, now - at), text: formatAge(now - at) } : undefined;
};

/** Who acts next, from the tile and nothing else. A decision waiting on me is mine; Rovara's own working states are Rovara's (never on a session running on someone's own machine, which Rovara does not run); a stopped, failed or finished run is mine only when I am offered Retry or Close. Everything else is not known. */
export function nextActor(tile: Pick<ReadLiveTile, "needsYou" | "kind" | "actions">, state: string): string | undefined {
 if (tile.needsYou) return "You";
 if (AUTOMATIC.has(state)) return tile.kind === "local" ? undefined : "Rovara";
 if (MAY_RETRY.has(state) && (tile.actions.includes("retry") || tile.actions.includes("close"))) return "You";
 return undefined;
}

/** "Cloud", or "On <machine>" by the machine's label. A place this build does not know is left out. */
function placeOf(where: { kind: string; label?: unknown; offline?: unknown }): WorkRow["place"] {
 if (where.kind === "cloud") return { text: "Cloud", offline: false };
 return where.kind === "mac" && typeof where.label === "string" ? { text: "On " + where.label, offline: where.offline === true } : undefined;
}

export function rowFromLive(tile: ReadLiveTile, now: number): WorkRow {
 const status = liveStatus(tile), state = plainState(status, undefined), age = ageOf(tile.updatedAt, now);
 // Marked only where this viewer can do something about it: a decision waiting on them, or work that needs someone and they are offered Retry, Close or Approve (a teammate's failed task they cannot touch is not).
 const attention = tile.needsYou || (statusNeedsSomeone(status) && (tile.actions.includes("retry") || tile.actions.includes("close") || tile.approvalUrl !== undefined));
 return {
  sessionId: tile.sessionId, title: tile.title, project: tile.project, agent: tile.agent?.name, state, attention,
  age: age === undefined ? undefined : age.text === "<1 min" ? "updated just now" : "updated " + age.text + " ago",
  ageMs: age?.ms ?? 0, since: age === undefined ? undefined : tile.updatedAt, next: nextActor(tile, status.state),
  place: placeOf(tile.where),
  live: { actions: tile.actions, following: tile.following, approvalUrl: tile.approvalUrl },
 };
}

/** A finished session from the sessions list. It carries no controls and no "waiting on you" flag, so it is never marked as needing attention and names nobody who acts next. */
export function rowFromFinished(tile: ReadFinishedTile, now: number): WorkRow {
 const summary = tile.summary;
 const status: LeadStatus = { state: summary.display?.state ?? taskStatusFromSession({ status: summary.status, ...(summary.lastRunFailed === true ? { lastRunFailed: true as const } : {}) }).state };
 const endedAt = tile.endedAt ?? tile.updatedAt, age = ageOf(endedAt, now);
 return {
  sessionId: tile.sessionId, title: tile.title, project: tile.project, agent: tile.agent?.name, state: plainState(status, undefined), attention: false,
  age: age === undefined ? undefined : age.text === "<1 min" ? "finished just now" : "finished " + age.text + " ago", ageMs: age?.ms ?? 0, since: age === undefined ? undefined : endedAt,
  next: undefined, place: placeOf({ kind: tile.where.kind, label: tile.where.kind === "mac" ? tile.where.label : undefined }), live: undefined,
 };
}

/** Needs attention first, then everything else; each group with the most recently updated first. Rows that tie keep the order they came in. */
export function sortRows(rows: readonly WorkRow[]): WorkRow[] {
 return rows.map((row, index) => ({ row, index })).sort((a, b) => Number(b.row.attention) - Number(a.row.attention) || a.row.ageMs - b.row.ageMs || a.index - b.index).map(item => item.row);
}
/** Finished work, the most recently finished first. */
export const sortFinished = (rows: readonly WorkRow[]): WorkRow[] => rows.map((row, index) => ({ row, index })).sort((a, b) => a.row.ageMs - b.row.ageMs || a.index - b.index).map(item => item.row);
