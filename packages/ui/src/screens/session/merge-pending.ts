import { useCallback, useSyncExternalStore } from "react";
import type { MergeReadiness } from "../../api/session-actions.js";
import { pullKey, type PullRow } from "./merge-facts.js";

/**
 * The press that has been sent and not answered. It is written to localStorage BEFORE the POST goes out and is cleared only by a definitive answer for that request id, by GitHub showing the pull requests merged, or
 * by a head that moved (then the old request cannot be replayed against new heads). It is shared by every tab and survives a closed tab, so a reload, a second tab or Back can never mint a second request id for an
 * unresolved press. Keyed by session id. Storage that cannot be read or written locks Merge and says so; it never unlocks blindly.
 *
 * What Code does with the same request id (hosted-merge-routes.ts, read-only at code/next): a stored answer is returned without asking GitHub (168-173); an unanswered one is re-run through the merge core, which
 * re-reads GitHub, skips pull requests already merged and returns them as merged (merge.ts 684/909), under the per-task lock (15 min) and per-pull-request claim (120 s). Code keeps no record of an unknown end.
 */
const PREFIX = "rovara.merge.pending.v1:";
const CHANGED = "rovara-merge-pending-changed";
const UNAVAILABLE = "\u0000unavailable";
/** Code keeps no record of an unknown end, so there is no server retention to follow: after a day the page stops offering the plain retry first and points at GitHub (it never unlocks on its own). */
export const PENDING_STALE_MS = 24 * 60 * 60 * 1000;

export interface PendingHead { repositoryId: string; number: number; headSha: string }
export interface PendingPress { v: 1; sessionId: string; requestId: string; startedAt: string; heads: PendingHead[]; risk: "low" | "medium" | "high" | undefined; sent: string[] }
export type PendingState = { kind: "none" } | { kind: "unavailable" } | { kind: "unreadable" } | { kind: "pending"; entry: PendingPress; stale: boolean };

const keyOf = (sessionId: string): string => PREFIX + sessionId;
const SHA = /^[a-f0-9]{40}$/u, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function rawOf(sessionId: string): string | null {
 try { return globalThis.localStorage.getItem(keyOf(sessionId)); } catch { return UNAVAILABLE; }
}
function notify(): void { try { globalThis.dispatchEvent(new Event(CHANGED)); } catch { /* no window */ } }

/** The record, strictly checked: anything that does not read as exactly what this module wrote is "unreadable", which stays locked. */
export function parsePending(raw: string | null, sessionId: string, now = Date.now()): PendingState {
 if (raw === UNAVAILABLE) return { kind: "unavailable" };
 if (raw === null) return { kind: "none" };
 try {
  const value = JSON.parse(raw) as Partial<PendingPress> | null;
  if (value === null || typeof value !== "object" || value.v !== 1 || value.sessionId !== sessionId || typeof value.requestId !== "string" || !UUID.test(value.requestId) || typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))) return { kind: "unreadable" };
  if (!Array.isArray(value.heads) || value.heads.length > 32 || !value.heads.every(head => typeof head === "object" && head !== null && typeof head.repositoryId === "string" && head.repositoryId.length > 0 && head.repositoryId.length <= 200 && Number.isInteger(head.number) && head.number > 0 && typeof head.headSha === "string" && SHA.test(head.headSha))) return { kind: "unreadable" };
  if (value.risk !== undefined && value.risk !== "low" && value.risk !== "medium" && value.risk !== "high") return { kind: "unreadable" };
  if (!Array.isArray(value.sent) || !value.sent.every(item => typeof item === "string" && item.length <= 300) || value.sent.length > 32) return { kind: "unreadable" };
  const entry: PendingPress = { v: 1, sessionId, requestId: value.requestId, startedAt: value.startedAt, heads: value.heads, risk: value.risk, sent: value.sent };
  return { kind: "pending", entry, stale: now - Date.parse(value.startedAt) >= PENDING_STALE_MS };
 } catch { return { kind: "unreadable" }; }
}

/** The stored state for one session, live across tabs (the storage event) and across mounts in this tab. */
export function usePending(sessionId: string): PendingState {
 const subscribe = useCallback((onChange: () => void) => {
  const onStorage = (event: Event): void => { if (!(event instanceof StorageEvent) || event.key === null || event.key === keyOf(sessionId)) onChange(); };
  globalThis.addEventListener("storage", onStorage);globalThis.addEventListener(CHANGED, onChange);
  return () => { globalThis.removeEventListener("storage", onStorage);globalThis.removeEventListener(CHANGED, onChange); };
 }, [sessionId]);
 const raw = useSyncExternalStore(subscribe, () => rawOf(sessionId), () => null);
 return parsePending(raw, sessionId);
}

/** Reads the record fresh, right now (never from a render's snapshot): the check made immediately before a request id is minted or sent. */
export const readPendingNow = (sessionId: string): PendingState => parsePending(rawOf(sessionId), sessionId);

/** Writes the record and reads it back. False means it could not be saved here, so the press must not be sent. */
export function writePending(entry: PendingPress): boolean {
 try {
  globalThis.localStorage.setItem(keyOf(entry.sessionId), JSON.stringify(entry));
  const back = parsePending(globalThis.localStorage.getItem(keyOf(entry.sessionId)), entry.sessionId);
  notify();
  return back.kind === "pending" && back.entry.requestId === entry.requestId;
 } catch { return false; }
}

/** Removes the record, only if it is still the one the caller means (another tab's newer record is never removed by a stale caller). */
export function clearPending(sessionId: string, requestId: string): void {
 try {
  const now = parsePending(globalThis.localStorage.getItem(keyOf(sessionId)), sessionId);
  if (now.kind === "pending" && now.entry.requestId !== requestId) return;
  globalThis.localStorage.removeItem(keyOf(sessionId));
 } catch { /* a record that cannot be removed stays and keeps Merge locked */ }
 notify();
}

/** The heads the record sent still match what GitHub and tracking say now? A head that moved voids the record: the old request cannot be replayed against new heads. */
export function headsMoved(entry: PendingPress, rows: readonly PullRow[]): boolean {
 return entry.heads.some(head => { const row = rows.find(candidate => candidate.key === pullKey(head.repositoryId, head.number)), current = row?.githubHead ?? row?.checkedHead; return current !== undefined && current !== head.headSha; });
}

/** Every pull request the record covered is merged on GitHub (an observation, not an answer to the request). */
export function allMerged(entry: PendingPress, rows: readonly PullRow[]): boolean {
 return entry.heads.length > 0 && entry.heads.every(head => rows.find(candidate => candidate.key === pullKey(head.repositoryId, head.number))?.state === "merged");
}

export const bodyOf = (entry: PendingPress): { expectedHeads: MergeReadiness["heads"]; risk: MergeReadiness["risk"] } => ({ expectedHeads: entry.heads, risk: entry.risk });
