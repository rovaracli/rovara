import { ApiError } from "./api/errors.js";
import { useCallback, useSyncExternalStore } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

/**
 * The action section's read fence (SCREEN-STATE-RULES R6b/R6e/R6g), kept in the QueryClient, keyed by the SUBJECT `orgId|developerId|subjectId`, so it outlives the component and is never shared between people or companies:
 * unmounting, navigating away and coming back, or a request still in flight while the view is gone, all meet the same fence; another identity gets another fence.
 *
 * ONE RULE, per tab: a tab may void, settle or retire an unresolved press ONLY with a subject read that THIS TAB issued AFTER THIS TAB first observed that press (when it wrote it, or when it first saw it in storage or in a
 * storage event). Order is only ever compared inside one tab, by `tabSeq()`, a plain increasing counter in this page's memory. Nothing is compared across tabs, no clock is used, nothing is persisted: after a reload the tab
 * observes the record again and needs a NEW read issued after that.
 *
 * The read is bound to ITS OWN RESPONSE BODY. The section calls the API itself (`fencedRead`): the issue number is taken when the call STARTS and is stored together with the body that call returned, an immutable value held in
 * this closure, never read back from the query cache or from a prop. A cache write of any kind (presence, an Understand answer, the shared session adapter keeping an older projection) cannot supply, change or stamp a fact.
 * The same fence holds the readiness refusal: a failed or refused readiness read is recorded here and only a readiness read issued after it that succeeds clears it (`fencedReadiness`).
 */
let counter = 0;
/** This tab's issue sequence. Strictly increasing within the page; never compared with another tab's. */
export const tabSeq = (): number => { counter += 1; return counter; };

export interface TaskRead { /** The body of that very call. */ data: unknown; /** tabSeq() when the call started. */ issued: number }
export interface Fence {
 latestRead: TaskRead | undefined;
 /** The latest FAILED or REFUSED subject read this section made (by issue number). A response issued before it is dropped; resolution waits for a read issued after it that succeeds (R6b/R6e). */
 taskFailed: { seq: number } | undefined;
 /** A readiness read failed or was refused; cleared only by a readiness read issued after it that succeeds. */
 readinessDenied: { seq: number } | undefined;
 /** The issue number of the latest SUCCESSFUL readiness read: a failure issued before it never supersedes it (R6b). */
 readinessLatest: number | undefined;
 /** Records this tab has observed, by `requestId|startedAt`, with tabSeq() at first observation. */
 observed: Map<string, number>;
 version: number;
 listeners: Set<() => void>;
}
const fences = new WeakMap<QueryClient, Map<string, Fence>>();

function make(): Fence { return { latestRead: undefined, taskFailed: undefined, readinessDenied: undefined, readinessLatest: undefined, observed: new Map(), version: 0, listeners: new Set() }; }
function changed(fence: Fence): void { fence.version += 1;for (const listener of fence.listeners) listener(); }

/** The fence for one subject (`orgId|developerId|subjectId`) in this QueryClient. */
export function fenceFor(client: QueryClient, subject: string, action: string): Fence {
 let map = fences.get(client);
 if (map === undefined) { map = new Map();fences.set(client, map); }
 const key = JSON.stringify([action, subject]);
 let fence = map.get(key);
 if (fence === undefined) { fence = make();map.set(key, fence); }
 return fence;
}

/**
 * A subject read made BY THE SECTION: the issue number is taken at the start of the call and kept with the body that same call returned. A later-issued read supersedes an earlier one, never the reverse. A failed or refused
 * attempt is recorded by its issue number too (like `fencedReadiness`): any response issued before it is dropped, and nothing resolves until a read issued after it succeeds; a failure issued before the latest successful read is ignored. The fence survives remounts.
 */
export async function fencedRead<T>(fence: Fence, call: () => Promise<T>): Promise<{ issued: number; body: T }> {
 const issued = tabSeq();
 let body: T;
 try { body = await call(); } catch (failure) {
  // A failure supersedes only what was issued BEFORE it: a failed read older than the latest successful read must never override that newer success (R6b). The caller still sees its own failure.
  const newerSuccess = fence.latestRead !== undefined && fence.latestRead.issued > issued;
  if (!newerSuccess && (fence.taskFailed === undefined || issued > fence.taskFailed.seq)) { fence.taskFailed = { seq: issued };changed(fence); }
  throw failure;
 }
 // Issued before a newer failed or refused read: an older response must not apply after it.
 if (fence.taskFailed !== undefined && issued < fence.taskFailed.seq) return { issued, body };
 if (fence.latestRead === undefined || issued > fence.latestRead.issued) fence.latestRead = { data: body, issued };
 if (fence.taskFailed !== undefined && issued > fence.taskFailed.seq) fence.taskFailed = undefined;
 changed(fence);
 return { issued, body };
}

/**
 * A readiness read made by the section: a failure or refusal is recorded in the fence; only a read issued after it that succeeds clears it. The same rule as subject reads (R6b): a failure issued BEFORE the latest successful
 * readiness read is ignored (the caller still sees its own failure), so an older failed read landing late can never supersede a newer success.
 */
export async function fencedReadiness<T>(fence: Fence, call: () => Promise<T>): Promise<T> {
 const issued = tabSeq();
 try {
  const body = await call();
  if (fence.readinessLatest === undefined || issued > fence.readinessLatest) fence.readinessLatest = issued;
  if (fence.readinessDenied !== undefined && issued > fence.readinessDenied.seq) { fence.readinessDenied = undefined;changed(fence); }
  return body;
 } catch (failure) {
  const newerSuccess = fence.readinessLatest !== undefined && fence.readinessLatest > issued;
  if (!newerSuccess && (fence.readinessDenied === undefined || issued > fence.readinessDenied.seq)) { fence.readinessDenied = { seq: issued };changed(fence); }
  throw failure;
 }
}

/** This tab first observes a record: when it wrote it, or when it first read it from storage. Later observations keep the first. */
export function observeRecord(fence: Fence, recordKey: string): void {
 if (!fence.observed.has(recordKey)) { fence.observed.set(recordKey, tabSeq());changed(fence); }
}

/** Re-renders the caller whenever the fence changes. */
export function useFence(subject: string, action: string): Fence {
 const client = useQueryClient(), fence = fenceFor(client, subject, action);
 useSyncExternalStore(listener => { fence.listeners.add(listener); return () => { fence.listeners.delete(listener); }; }, () => fence.version, () => 0);
 return fence;
}

/** Frozen DEC 254zzz268 rules. Caller projections cannot relax these guarantees. */
export const SAFE_ACTION_RULES = Object.freeze({
 R1: "Cached data is not a fresh read.", R2: "Say only what the server answered.",
 R2c: "An accepted answer holds through same-version tracking lag.",
 R3: "Unknown outcomes persist by subject in localStorage.", R4: "Facts, not inference.",
 R5: "Failing-first proof; fixtures parse with real readers.",
 R6a: "Only definitive answers resolve an unknown.", R6b: "Order all reads by issue sequence.",
 R6c: "Recheck authority and shown/sent values at send.", R6d: "No send without a persisted pending record.",
 R6e: "Fences and failure state outlive the component.", R6f: "Wording states the observed state.",
 R6g: "Keys include company and person from identity, plus subject; unread identity forbids writes.",
 R6h: "CSRF_STALE and CSRF_INVALID are not authority refusals; reread identity.",
 fence: "R1 cached data is not a read; R6b issue order, own body; R6e survives remount; R6g company/person/subject scope.",
 records: "R3 unknown survives reload/tabs; R6a only definitive answers resolve; R6d persist before send; R6g identity scope.",
 facts: "R2 answer only; R2c accepted holds through tracking lag; R4 observed facts; R6f observed wording, never attribution.",
 press: "R6c authority and shown/sent binding at send; R6h CSRF_INVALID/CSRF_STALE means nothing sent, reread identity.",
 proof: "R5 failing-first new behavior; fixtures use real readers. No retry of an uncertain one-shot write.",
});
export const PENDING_STALE_MS = 24 * 60 * 60 * 1000;
const UNAVAILABLE = "\u0000unavailable";
export type ActionPendingState<P> = { kind: "none" } | { kind: "unavailable" } | { kind: "unreadable" } | { kind: "pending"; entry: P; stale: boolean };
export interface RecordConfig<P extends { requestId: string; startedAt: string }, A extends { requestId: string }> {
 pendingPrefix: string; acceptedPrefix: string; changedEvent: string;
 parsePending(raw: string | null, subject: string, now?: number): ActionPendingState<P>;
 parseAccepted(this: void, raw: string | null, subject: string): A | undefined;
 pendingSubject(entry: P): string; acceptedSubject(answer: A): string;
 /** Existing reader's canonical field order, for exact read-back comparison. */
 canonicalAccepted(answer: A): A;
}
/** Lifted storage mechanics; strict route-owned readers and existing namespaces stay at the caller. */
export function createActionRecords<P extends { requestId: string; startedAt: string }, A extends { requestId: string }>(config: RecordConfig<P, A>) {
 const keyOf = (subject: string): string => config.pendingPrefix + subject;
 const acceptedKey = (subject: string): string => config.acceptedPrefix + subject;
 function notify(): void { try { globalThis.dispatchEvent(new Event(config.changedEvent)); } catch { /* no window */ } }
 function rawOf(subject: string): string | null { try { return globalThis.localStorage.getItem(keyOf(subject)); } catch { return UNAVAILABLE; } }
 function rawAccepted(subject: string): string | null { try { return globalThis.localStorage.getItem(acceptedKey(subject)); } catch { return null; } }
 function parsePending(raw: string | null, subject: string, now = Date.now()): ActionPendingState<P> {
  return raw === UNAVAILABLE ? { kind: "unavailable" } : config.parsePending(raw, subject, now);
 }
 const readPendingNow = (subject: string): ActionPendingState<P> => parsePending(rawOf(subject), subject);
 // While the pending record remains, an answer for that same press is not a
 // durable resolution: the exact readback/clear sequence may have failed.
 const visibleAccepted = (subject: string, raw: string | null): A | undefined => {
  const answer = config.parseAccepted(raw, subject), pending = readPendingNow(subject);
  return answer !== undefined && pending.kind === "pending" && pending.entry.requestId === answer.requestId ? undefined : answer;
 };
 const readAcceptedNow = (subject: string): A | undefined => visibleAccepted(subject, rawAccepted(subject));
 function useRaw(subject: string, accepted: boolean): string | null {
  const key = accepted ? acceptedKey(subject) : keyOf(subject);
  const subscribe = useCallback((onChange: () => void) => {
   const onStorage = (event: Event): void => { if (!(event instanceof StorageEvent) || event.key === null || event.key === key) onChange(); };
   globalThis.addEventListener("storage", onStorage);globalThis.addEventListener(config.changedEvent, onChange);
   return () => { globalThis.removeEventListener("storage", onStorage);globalThis.removeEventListener(config.changedEvent, onChange); };
  }, [key]);
  return useSyncExternalStore(subscribe, () => {
   if (!accepted) return rawOf(subject);
   const raw = rawAccepted(subject);
   return visibleAccepted(subject, raw) === undefined ? null : raw;
  }, () => null);
 }
 function usePending(subject: string): ActionPendingState<P> { return parsePending(useRaw(subject, false), subject); }
 function useAccepted(subject: string): A | undefined { return visibleAccepted(subject, useRaw(subject, true)); }
 function writePending(entry: P): boolean {
  try {
   const subject = config.pendingSubject(entry), key = keyOf(subject);
   const existing = parsePending(globalThis.localStorage.getItem(key), subject);
   if (existing.kind !== "none" && !(existing.kind === "pending" && existing.entry.requestId === entry.requestId && existing.entry.startedAt === entry.startedAt)) return false;
   globalThis.localStorage.setItem(key, JSON.stringify(entry));
   const back = parsePending(globalThis.localStorage.getItem(key), subject);
   notify();
   return back.kind === "pending" && JSON.stringify(back.entry) === JSON.stringify(entry);
  } catch { return false; }
 }
 function removePending(subject: string, requestId: string, startedAt: string, verifiedAnswer: boolean): boolean {
  try {
   const now = parsePending(globalThis.localStorage.getItem(keyOf(subject)), subject);
   if (verifiedAnswer && now.kind === "none") return true;
   if (now.kind !== "pending" || now.entry.requestId !== requestId || now.entry.startedAt !== startedAt) return false;
   if (!verifiedAnswer) {
    // Observed resolution must never unmask an unverified accepted candidate.
    const raw = globalThis.localStorage.getItem(acceptedKey(subject)), answer = config.parseAccepted(raw, subject);
    if (raw !== null && (answer === undefined || answer.requestId === requestId)) {
     globalThis.localStorage.removeItem(acceptedKey(subject));
     if (globalThis.localStorage.getItem(acceptedKey(subject)) !== null) return false;
    }
   }
   globalThis.localStorage.removeItem(keyOf(subject));
   const removed = globalThis.localStorage.getItem(keyOf(subject)) === null;
   notify();return removed;
  } catch { return false; /* storage failure retains the lock */ }
 }
 const clearPending = (subject: string, requestId: string, startedAt: string): void => { removePending(subject, requestId, startedAt, false); };
 function writeAccepted(answer: A): boolean {
  try { globalThis.localStorage.setItem(acceptedKey(config.acceptedSubject(answer)), JSON.stringify(answer));notify();return true; } catch { return false; }
 }
 function clearAccepted(subject: string, requestId: string): void {
  try { const now = config.parseAccepted(globalThis.localStorage.getItem(acceptedKey(subject)), subject); if (now !== undefined && now.requestId !== requestId) return;globalThis.localStorage.removeItem(acceptedKey(subject)); } catch { /* stays */ }
  notify();
 }
 function claimPending(entry: P, refusalNow: () => string | undefined, storageWords: string): { stop: true; words: string | undefined } | { stop: false } {
  const why = refusalNow();
  if (why !== undefined) return { stop: true, words: why };
  const subject = config.pendingSubject(entry);
  if (readAcceptedNow(subject) !== undefined || readPendingNow(subject).kind !== "none") return { stop: true, words: undefined };
  if (!writePending(entry)) return { stop: true, words: storageWords };
  return { stop: false };
 }
 const acceptedStoredExactly = (answer: A): boolean => { const back = config.parseAccepted(rawAccepted(config.acceptedSubject(answer)), config.acceptedSubject(answer)); return back !== undefined && JSON.stringify(back) === JSON.stringify(config.canonicalAccepted(answer)); };
 function recordAccepted(entry: P, answer: A): boolean {
  if (answer.requestId !== entry.requestId || config.acceptedSubject(answer) !== config.pendingSubject(entry)) return false;
  if (!writeAccepted(answer) || !acceptedStoredExactly(answer)) {
   // Best-effort discard now; if storage refuses, pending masks this candidate
   // and observed resolution must discard it before removing pending.
   clearAccepted(config.acceptedSubject(answer), answer.requestId);
   return false;
  }
  return removePending(config.pendingSubject(entry), entry.requestId, entry.startedAt, true);
 }
 return { recordAccepted, claimPending, parsePending, parseAccepted: config.parseAccepted, usePending, readPendingNow, writePending, clearPending, useAccepted, readAcceptedNow, writeAccepted, clearAccepted, acceptedStoredExactly };
}

export type ClaimOutcome<T> = { kind: "done"; value: T; release: () => void } | { kind: "busy" } | { kind: "unsupported" } | { kind: "failed" };
interface LockApi { request: (name: string, options: { mode: "exclusive"; ifAvailable: true }, callback: (lock: unknown) => Promise<unknown>) => Promise<unknown> }
const lockApi = (): LockApi | undefined => { try { const locks = (globalThis as { navigator?: { locks?: LockApi } }).navigator?.locks; return typeof locks?.request === "function" ? locks : undefined; } catch { return undefined; } };
/** True when this browser can take the claim lock. When it can't, the action is not offered in the app. */
export const claimLockSupported = (): boolean => lockApi() !== undefined;
/**
 * Takes the lock, runs `claim` inside it, and KEEPS HOLDING the lock until the caller calls `release()` (M-2): the press holds it until its request has settled and the answer, refusal or unknown end is recorded, so no other
 * tab can claim while this one's request is in flight, and by the time it is released the writes have long reached other tabs. The caller must call `release()` in a `finally`; a claim that throws releases at once.
 */
export async function withActionClaim<T>(name: string, claim: () => T): Promise<ClaimOutcome<T>> {
 const locks = lockApi();
 if (locks === undefined) return { kind: "unsupported" };
 let release!: () => void;
 const held = new Promise<void>(resolve => { release = resolve; });
 return new Promise<ClaimOutcome<T>>(resolve => {
  // A synchronous throw from the lock API (a non-conforming implementation) falls back closed too: nothing is sent.
  try {
   locks.request(name, { mode: "exclusive", ifAvailable: true }, async (lock: unknown) => {
    if (lock === null) { resolve({ kind: "busy" });return; }
    try { resolve({ kind: "done", value: claim(), release }); } catch { resolve({ kind: "failed" });release(); }
    await held;
   }).catch(() => { resolve({ kind: "failed" });release(); });
  } catch { resolve({ kind: "failed" });release(); }
 });
}

/** Shown-basis mechanics extracted from the caller's meaningful-facts projection. */
export const basisOf = (parts: readonly string[]): string => JSON.stringify(parts);
export function sameItems<T>(a: readonly T[], b: readonly T[], key: (value: T) => string): boolean {
 const left = a.map(key).sort(), right = b.map(key).sort();
 return left.length === right.length && left.every((value, index) => value === right[index]);
}
/** Empty/partly observed coverage is never resolved. */
export const everyCovered = <T>(items: readonly T[], observed: (item: T) => boolean): boolean => items.length > 0 && items.every(observed);
export type LockKind = "unresolved" | "storage" | "identity" | "drift" | "not_ready";
export interface LockInput { unresolved: boolean; identityUnread?: boolean; storage?: "unavailable" | "unreadable"; drift: boolean; ready: boolean }
export function actionLock(input: LockInput): LockKind | undefined {
 if (input.identityUnread === true) return "identity";
 if (input.storage !== undefined) return "storage";
 if (input.unresolved) return "unresolved";
 if (input.drift) return "drift";
 if (!input.ready) return "not_ready";
 return undefined;
}
export type ClaimDecision = { stop: true; words: string | undefined } | { stop: false };
export type ActionRecords<P extends { requestId: string; startedAt: string }, A extends { requestId: string }> = ReturnType<typeof createActionRecords<P, A>>;
export interface PressInput<P extends { requestId: string; startedAt: string }, A extends { requestId: string }> {
 /** Recovery compares the new response BODY with the shown basis before claiming. */
 recover(): Promise<boolean>;
 lockName: string; records: ActionRecords<P, A>;
 pending(): P; refusalNow(): string | undefined; storageWords: string;
 /** Only presentation: the runner itself decides whether it may dispatch. */
 claimed(claim: ClaimOutcome<ClaimDecision>): void;
 send(entry: P): Promise<A>;
 accepted(answer: A, durable: boolean): void;
 failed(failure: unknown, entry: P): void;
 finished(): void;
}
/** The reviewed ordering: recover -> exclusive claim -> fresh checks/persist -> send/record -> finally.
 * Record answers through records.recordAccepted; route-owned definitive refusal handling may clear pending.
 * All refreshes invoked by adapters MUST be fire-and-forget (step 7).
 */
export async function runActionPress<P extends { requestId: string; startedAt: string }, A extends { requestId: string }>(input: PressInput<P, A>): Promise<void> {
 let release: (() => void) | undefined;
 try {
  if (!await input.recover()) return;
  const entry = input.pending();
  const claim = await withActionClaim(input.lockName, () => input.records.claimPending(entry, () => input.refusalNow(), input.storageWords));
  if (claim.kind === "done") release = claim.release;
  input.claimed(claim);
  if (claim.kind !== "done" || claim.value.stop) return;
  // Only dispatch/end recording failures reach route-specific refusal policy.
  let answer: A;
  try { answer = await input.send(entry); } catch (failure) { input.failed(failure, entry);return; }
  const durable = input.records.recordAccepted(entry, answer);
  input.accepted(answer, durable);
 } finally { try { input.finished(); } finally { release?.(); } }
}
/** Always on. Expiry is uncertainty, not a refusal, cancellation or permission to retry. */
export const ACTION_POST_TIMEOUT_MS = 30_000;
export function postWithTimeout<T>(send: () => Promise<T>, timeoutMs = ACTION_POST_TIMEOUT_MS): Promise<T> {
 return new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => { reject(new ApiError(0, "UNKNOWN_OUTCOME", "Rovara hasn't confirmed the result. Check its state before doing anything else.")); }, timeoutMs);
  // Both handlers consume late settlement. The server operation remains alive.
  // Start synchronously: there is no new dispatch gap after send-time checks.
  try { send().then(value => { clearTimeout(timer);resolve(value); }, (failure: unknown) => { clearTimeout(timer);reject(failure instanceof Error ? failure : new Error("Action outcome is unknown.")); }); }
  catch (failure) { clearTimeout(timer);reject(failure instanceof Error ? failure : new Error("Action outcome is unknown.")); }
 });
}

/** Exact, nonempty, unique coverage: missing, duplicate or extra targets bind nothing. */
export function itemsBound(covered: readonly string[], targets: readonly string[]): boolean {
 return covered.length > 0 && targets.length > 0 && new Set(covered).size === covered.length && new Set(targets).size === targets.length && covered.length === targets.length && targets.every(key => covered.includes(key));
}
export type BasisRecovery = { kind: "unchanged"; validated: number } | { kind: "read_failed" } | { kind: "changed" };
/** Recovery must inspect that read's BODY, never a success boolean or cached projection. */
export async function recoverActionBasis(fence: Fence, shown: string, project: (body: unknown) => string | undefined, read: () => Promise<{ issued: number; body: unknown } | undefined>): Promise<BasisRecovery> {
 const held = fence.latestRead;
 if (fence.taskFailed !== undefined || (held !== undefined && project(held.data) !== shown)) {
  const fresh = await read();
  if (fresh === undefined) return { kind: "read_failed" };
  if (project(fresh.body) !== shown) return { kind: "changed" };
  return { kind: "unchanged", validated: fresh.issued };
 }
 return { kind: "unchanged", validated: 0 };
}

/** A retired memory-only answer must not refuse an otherwise valid new confirmation. */
export const answerHeld = (answer: { requestId: string } | undefined, retiredId: string | undefined): boolean => answer !== undefined && retiredId !== answer.requestId;

/** Cloud checks these before dispatch (R6h); they never imply an authority refusal. */
export const isCsrfFailure = (failure: unknown): boolean => failure instanceof ApiError && failure.status === 403 && (failure.code === "CSRF_INVALID" || failure.code === "CSRF_STALE");
