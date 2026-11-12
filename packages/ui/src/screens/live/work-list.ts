import { TASK_STATUS_WORDS, type FinishedAs, taskStatusFromSession, type LiveFilterSchema } from "@agentx/cloud-contracts/web";
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
/** States where a person who may close the task is who acts next (a run that finished and waits for its owner's word). Retry is not a reason: whether someone must act is the server's `needsYou`. */
const MAY_CLOSE = new Set(["failed", "finished_run", "needs_you"]);

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
 /** Only on a live row of a session that has ended (a failed one in Needs attention): it offers Open and Dismiss, and none of the controls an open session has. `dismiss` is present when the owner may dismiss it. */
 ended: { endedAt: string; canDismiss: boolean } | undefined;
}

const ageOf = (iso: string | undefined, now: number): { ms: number; text: string } | undefined => {
 const at = iso === undefined ? Number.NaN : Date.parse(iso);
 return Number.isFinite(at) ? { ms: Math.max(0, now - at), text: formatAge(now - at) } : undefined;
};

/** Who acts next, from the tile and nothing else. A decision waiting on me (`needsYou`) is mine; Rovara's own working states are Rovara's (never on a session running on someone's own machine, which Rovara does not run); a stopped, failed or finished run is mine only when I am offered Close. An ended session has no next step. Everything else is not known. Being offered Retry says nothing about who must act. */
export function nextActor(tile: Pick<ReadLiveTile, "needsYou" | "kind" | "actions"> & { endedAt?: string | undefined }, state: string): string | undefined {
 if (tile.endedAt !== undefined) return undefined;
 if (tile.needsYou) return "You";
 if (AUTOMATIC.has(state)) return tile.kind === "local" ? undefined : "Rovara";
 if (MAY_CLOSE.has(state) && tile.actions.includes("close")) return "You";
 return undefined;
}

/** "Cloud", or "On <machine>" by the machine's label. A place this build does not know is left out. */
function placeOf(where: { kind: string; label?: unknown; offline?: unknown }): WorkRow["place"] {
 if (where.kind === "cloud") return { text: "Cloud", offline: false };
 return where.kind === "mac" && typeof where.label === "string" ? { text: "On " + where.label, offline: where.offline === true } : undefined;
}

export function rowFromLive(tile: ReadLiveTile, now: number): WorkRow {
 const status = liveStatus(tile), age = ageOf(tile.updatedAt, now), plain = plainState(status, undefined);
 // An ended failed session says so: it is over, and what is left to do is open it or dismiss it.
 const ended = tile.endedAt === undefined ? undefined : { endedAt: tile.endedAt, canDismiss: tile.canDismiss === true };
 const state = ended !== undefined && status.state === "failed" ? { ...plain, label: plain.label + " (ended)" } : plain;
 // Marked only where this viewer is the one to act: a decision waiting on them (`needsYou`), a failure they may dismiss (`canDismiss`: theirs, ended, still in Needs attention), or a decision they may approve. Being offered Retry or Close is not a reason (a teammate's failed task they can touch is not theirs to act on).
 const attention = tile.needsYou || ended?.canDismiss === true || tile.approvalUrl !== undefined;
 return {
  sessionId: tile.sessionId, title: tile.title, project: tile.project, agent: tile.agent?.name, state, attention,
  age: age === undefined ? undefined : age.text === "<1 min" ? "updated just now" : "updated " + age.text + " ago",
  ageMs: age?.ms ?? 0, since: age === undefined ? undefined : tile.updatedAt, next: nextActor(tile, status.state),
  place: placeOf(tile.where),
  live: { actions: tile.actions, following: tile.following, approvalUrl: tile.approvalUrl },
  ended,
 };
}

/** How an ended session ended, in words (`finishedAs` on its tile). */
export const FINISHED_AS_WORDS: Readonly<Record<FinishedAs, PlainState>> = { merged: { label: "Merged", tone: "success" }, closed: { label: "Closed", tone: "neutral" }, finished_no_code: { label: "Finished (no code)", tone: "success" }, finished: { label: "Finished", tone: "neutral" } };
/**
 * The state a finished row says: the server's `finishedAs` where the tile has one that this version knows. The server's "finished" is its word for everything else, and a run that failed keeps its own state ("Failed", the danger tone) for every word but "merged": a merged pull request is the outcome that stands, but "Closed", "Finished (no code)" or
 * "Finished" must never hide a failure. A tile without `finishedAs` (an older server) says what it said before.
 */
export function finishedState(finishedAs: string | undefined, own: PlainState): PlainState {
 // A word a newer server adds (the reader keeps it as "unknown") is not guessed at: the row says what it said before.
 const words = finishedAs === undefined || !Object.hasOwn(FINISHED_AS_WORDS, finishedAs) ? undefined : FINISHED_AS_WORDS[finishedAs as FinishedAs];
 return words === undefined || (finishedAs !== "merged" && own.tone === "danger") ? own : words;
}

/** A finished session from the sessions list. It carries no controls and no "waiting on you" flag, so it is never marked as needing attention and names nobody who acts next. */
export function rowFromFinished(tile: ReadFinishedTile, now: number): WorkRow {
 const summary = tile.summary;
 const status: LeadStatus = { state: summary.display?.state ?? taskStatusFromSession({ status: summary.status, ...(summary.lastRunFailed === true ? { lastRunFailed: true as const } : {}) }).state };
 const endedAt = tile.endedAt ?? tile.updatedAt, age = ageOf(endedAt, now);
 return {
  sessionId: tile.sessionId, title: tile.title, project: tile.project, agent: tile.agent?.name, state: finishedState(tile.finishedAs, plainState(status, undefined)), attention: false,
  age: age === undefined ? undefined : age.text === "<1 min" ? "finished just now" : "finished " + age.text + " ago", ageMs: age?.ms ?? 0, since: age === undefined ? undefined : endedAt,
  next: undefined, place: placeOf({ kind: tile.where.kind, label: tile.where.kind === "mac" ? tile.where.label : undefined }), live: undefined, ended: undefined,
 };
}

/** Needs attention first, then everything else; each group with the most recently updated first. Rows that tie keep the order they came in. */
export function sortRows(rows: readonly WorkRow[]): WorkRow[] {
 return rows.map((row, index) => ({ row, index })).sort((a, b) => Number(b.row.attention) - Number(a.row.attention) || a.row.ageMs - b.row.ageMs || a.index - b.index).map(item => item.row);
}
/** Finished work, the most recently finished first. */
export const sortFinished = (rows: readonly WorkRow[]): WorkRow[] => rows.map((row, index) => ({ row, index })).sort((a, b) => a.row.ageMs - b.row.ageMs || a.index - b.index).map(item => item.row);
