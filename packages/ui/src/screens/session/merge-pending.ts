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


/**
 * The accepted answer (H1). Code's success path only wakes the merge tracker, so for a while after Code says MERGED the page still reads the pull request as open. So the accepted answer is kept, per subject
 * (`orgId|developerId|sessionId`), in localStorage, and keeps Merge locked for those pull requests across a reload or a second tab until a read this tab issued shows them merged or contradicts it.
 * It is never a lock against anything but a second press of already-merged pull requests, and it carries no attribution beyond what Code's answer said.
 */
const ACCEPTED_PREFIX = "rovara.merge.accepted.v1:";
export interface AcceptedAnswer { v: 1; subject: string; requestId: string; acceptedAt: string; words: string; keys: string[]; heads: PendingHead[] }
const acceptedKey = (subject: string): string => ACCEPTED_PREFIX + subject;
function rawAccepted(subject: string): string | null { try { return globalThis.localStorage.getItem(acceptedKey(subject)); } catch { return null; } }
export function parseAccepted(raw: string | null, subject: string): AcceptedAnswer | undefined {
 if (raw === null) return undefined;
 try {
  const v = JSON.parse(raw) as Partial<AcceptedAnswer> | null;
  if (v === null || typeof v !== "object" || v.v !== 1 || v.subject !== subject || typeof v.requestId !== "string" || !UUID.test(v.requestId) || typeof v.acceptedAt !== "string" || typeof v.words !== "string" || v.words.length > 600) return undefined;
  if (!Array.isArray(v.keys) || v.keys.length > 32 || !v.keys.every(key => typeof key === "string" && key.length <= 260)) return undefined;
  if (!Array.isArray(v.heads) || v.heads.length > 32 || !v.heads.every(head => typeof head === "object" && head !== null && typeof head.repositoryId === "string" && head.repositoryId.length > 0 && head.repositoryId.length <= 200 && Number.isInteger(head.number) && head.number > 0 && typeof head.headSha === "string" && SHA.test(head.headSha))) return undefined;
  return { v: 1, subject, requestId: v.requestId, acceptedAt: v.acceptedAt, words: v.words, keys: v.keys, heads: v.heads };
 } catch { return undefined; }
}
/** The accepted answer stored for one subject, live across tabs and mounts. */
export function useAccepted(subject: string): AcceptedAnswer | undefined {
 const subscribe = useCallback((onChange: () => void) => {
  const onStorage = (event: Event): void => { if (!(event instanceof StorageEvent) || event.key === null || event.key === acceptedKey(subject)) onChange(); };
  globalThis.addEventListener("storage", onStorage);globalThis.addEventListener(CHANGED, onChange);
  return () => { globalThis.removeEventListener("storage", onStorage);globalThis.removeEventListener(CHANGED, onChange); };
 }, [subject]);
 const raw = useSyncExternalStore(subscribe, () => rawAccepted(subject), () => null);
 return parseAccepted(raw, subject);
}
/** Reads the accepted answer fresh from storage, right now (never from a render): the check made immediately before anything is sent. */
export const readAcceptedNow = (subject: string): AcceptedAnswer | undefined => parseAccepted(rawAccepted(subject), subject);
export function writeAccepted(answer: AcceptedAnswer): boolean {
 try { globalThis.localStorage.setItem(acceptedKey(answer.subject), JSON.stringify(answer));notify();return true; } catch { return false; }
}
/** Removes the accepted answer, only if it is the one the caller means. */
export function clearAccepted(answer: Pick<AcceptedAnswer, "subject" | "requestId">): void {
 try { const now = parseAccepted(globalThis.localStorage.getItem(acceptedKey(answer.subject)), answer.subject); if (now !== undefined && now.requestId !== answer.requestId) return;globalThis.localStorage.removeItem(acceptedKey(answer.subject)); } catch { /* stays */ }
 notify();
}

/**
 * The cross-tab claim (P1-4). Reading the stored record, writing it and reading it back are separate storage operations, so two tabs could both pass them. The claim therefore runs inside an exclusive same-origin Web Lock,
 * one per subject (`orgId|developerId|sessionId`), taken only if it is free right now (a tab that finds it taken sends nothing). Inside it the caller re-reads the saved records and writes its own. The lock is released as soon as
 * the record is saved; the saved record, not the lock, is what keeps every later press out. Without the Web Locks API, or if it fails, nothing is sent and the page points at GitHub.
 */
export type ClaimOutcome<T> = { kind: "done"; value: T } | { kind: "busy" } | { kind: "unsupported" } | { kind: "failed" };
interface LockApi { request: (name: string, options: { mode: "exclusive"; ifAvailable: true }, callback: (lock: unknown) => Promise<unknown>) => Promise<unknown> }
const lockApi = (): LockApi | undefined => { try { const locks = (globalThis as { navigator?: { locks?: LockApi } }).navigator?.locks; return typeof locks?.request === "function" ? locks : undefined; } catch { return undefined; } };
/** True when this browser can take the claim lock. When it can't, Merge is not offered in the app. */
export const claimLockSupported = (): boolean => lockApi() !== undefined;
export async function withClaim<T>(subject: string, claim: () => T): Promise<ClaimOutcome<T>> {
 const locks = lockApi();
 if (locks === undefined) return { kind: "unsupported" };
 try {
  const result = await locks.request("rovara.merge.claim:" + subject, { mode: "exclusive", ifAvailable: true }, async (lock: unknown) => lock === null ? { kind: "busy" } as const : { kind: "done", value: claim() } as const);
  return result as ClaimOutcome<T>;
 } catch { return { kind: "failed" }; }
}
/** True only if the stored accepted answer is exactly this one. */
export const acceptedStoredExactly = (answer: AcceptedAnswer): boolean => { const back = readAcceptedNow(answer.subject); return back !== undefined && JSON.stringify(back) === JSON.stringify({ v: 1, subject: answer.subject, requestId: answer.requestId, acceptedAt: answer.acceptedAt, words: answer.words, keys: answer.keys, heads: answer.heads }); };
