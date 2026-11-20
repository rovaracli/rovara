import { useCallback, useSyncExternalStore } from "react";
import { pullKey, type PullRow } from "./merge-facts.js";

/**
 * The press that has been sent and not answered. It is written to localStorage BEFORE the POST goes out. Nothing re-sends it: Code replays only a stored SUCCESS (hosted-merge-routes.ts 168-218); an unanswered id stores nothing,
 * the task lock is released on an unknown end, and the per-pull-request claim ages out after 120 s, so a second POST could cause a second provider merge while the first lost call still lands (CONTRACTS R1a 124-128 keeps an
 * uncertain call fenced with ZERO merge calls on replay). "Check again" therefore only re-reads. The record is shared by every tab and survives a closed tab, so a reload, a second tab or Back can never mint a request id
 * for an unresolved press. It is removed only by the tab that made it (request id AND startedAt must match), or by a read that resolves it under the per-tab observation rule (merge-fence.ts): a task read THIS tab issued after
 * it first observed the record, showing the pull requests merged or a different head. Storage that cannot be read or written locks Merge and says so; it never unlocks blindly.
 */
/** The `sessionId` argument and field of every function here is the SUBJECT `orgId|developerId|sessionId` (R6g): a record written for one identity is invisible to any other. */
const PREFIX = "rovara.merge.pending.v1:";
const CHANGED = "rovara-merge-pending-changed";
const UNAVAILABLE = "\u0000unavailable";
/** Code keeps no record of an unknown end, so there is no server retention to follow: after a day the page points at GitHub first (it never unlocks on its own). */
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
  // Never overwrite a record this call did not make (another tab's, or one that cannot be read).
  const existing = parsePending(globalThis.localStorage.getItem(keyOf(entry.sessionId)), entry.sessionId);
  if (existing.kind !== "none" && !(existing.kind === "pending" && existing.entry.requestId === entry.requestId && existing.entry.startedAt === entry.startedAt)) return false;
  globalThis.localStorage.setItem(keyOf(entry.sessionId), JSON.stringify(entry));
  const back = parsePending(globalThis.localStorage.getItem(keyOf(entry.sessionId)), entry.sessionId);
  notify();
  return back.kind === "pending" && back.entry.requestId === entry.requestId;
 } catch { return false; }
}

/** Removes the record, only if it is exactly the one the caller means: request id AND startedAt must match. A stale tab never removes another tab's newer record, and a record that cannot be matched stays and keeps Merge locked. */
export function clearPending(entry: Pick<PendingPress, "sessionId" | "requestId" | "startedAt">): void {
 try {
  const now = parsePending(globalThis.localStorage.getItem(keyOf(entry.sessionId)), entry.sessionId);
  if (now.kind !== "pending" || now.entry.requestId !== entry.requestId || now.entry.startedAt !== entry.startedAt) return;
  globalThis.localStorage.removeItem(keyOf(entry.sessionId));
 } catch { /* a record that cannot be removed stays and keeps Merge locked */ }
 notify();
}

/**
 * A moved head voids the record only when the rows come from a task read that this tab issued after it observed the record (merge-fence.ts decides that; these rows are those of that read and nothing else). Data of
 * unknown order, a manual cache write, a readiness answer and a failed read never reach this function.
 */
export function headsMoved(entry: PendingPress, resolvingRows: readonly PullRow[]): boolean {
 return entry.heads.some(head => { const tracked = resolvingRows.find(candidate => candidate.key === pullKey(head.repositoryId, head.number))?.tracked; return tracked !== undefined && tracked.headSha !== head.headSha; });
}

/** Every pull request the record covered shows merged in the rows of such a read (an observation, not an answer to the request). */
export function allMerged(entry: PendingPress, resolvingRows: readonly PullRow[]): boolean {
 return entry.heads.length > 0 && entry.heads.every(head => resolvingRows.find(candidate => candidate.key === pullKey(head.repositoryId, head.number))?.state === "merged");
}
