import { useSyncExternalStore } from "react";
import type { AppHost } from "../host.js";
import { runActionPress, isCsrfFailure, isFinalActionRefusal, useFence, fencedRead, observeRecord, tabSeq, type Fence, type ActionRecords, type ActionPendingState, type AcceptedStorage } from "../safe-action.js";
import { ApiError, actionErrorRoutes } from "./errors.js";
import { sessionReadFailure, markSessionWrite, useSessionIdentity, useSessionRequest, readSessionIdentity, assertSessionIdentity, type FrozenSessionRequest } from "./session-safety.js";

// Route adapter for the existing identity-scoped session request records. The
// shared runner owns the claim, send-time checks, timeout and end ordering.
const EVENT = "rovara-task-action";
type Pending = { requestId: string; startedAt: string; scope: string; request: FrozenSessionRequest };
type Answer = { requestId: string; scope: string; value: unknown };
const signal = () => globalThis.dispatchEvent?.(new Event(EVENT));
const read = (host: AppHost, key: string): unknown => { const raw = host.storage.get(key);return raw === undefined || raw === "" ? undefined : JSON.parse(raw) as unknown; };
function store(host: AppHost, key: string, value: unknown): boolean {
 try { const raw = JSON.stringify(value);host.storage.set(key, raw);const saved = host.storage.get(key) === raw;signal();return saved; } catch { return false; }
}
function pendingNow(host: AppHost, scope: string): ActionPendingState<Pending> {
 try {
  const value = read(host, scope + ":request");if (value === undefined || value === null) return { kind: "none" };
  const p = value as FrozenSessionRequest;
  if (typeof p.requestId !== "string" || !p.requestId || typeof p.action !== "string" || typeof p.startedAt !== "number" || !Number.isFinite(p.startedAt) || typeof p.fence !== "number" || typeof p.body !== "object" || p.body === null) return { kind: "unreadable" };
  return { kind: "pending", stale: false, entry: { requestId: p.requestId, startedAt: new Date(p.startedAt).toISOString(), scope, request: p } };
 } catch { return { kind: "unavailable" }; }
}
/** Strict record adapter: no new server interface, record or permission. */
export function taskActionRecords(host: AppHost) {
 const answerNow = (scope: string): Answer | undefined => {
  try {
   const value = read(host, scope + ":answer") as { answer?: Answer; canonical?: string } | undefined;
   return value?.answer?.scope === scope && typeof value.answer.requestId === "string" && value.canonical === JSON.stringify(value.answer) ? value.answer : undefined;
  } catch { return undefined; }
 };
 const clearAccepted = (scope: string, requestId: string) => { if (answerNow(scope)?.requestId === requestId) store(host, scope + ":answer", null); };
 const clearPending = (scope: string, requestId: string, startedAt: string) => {
  const p = pendingNow(host, scope);if (p.kind !== "pending" || p.entry.requestId !== requestId || p.entry.startedAt !== startedAt) return;
  try { host.storage.set(scope + ":request", "null");signal();if (pendingNow(host, scope).kind === "none") return; } catch { /* keep the request */ }
  throw new ApiError(0, "PERSISTENCE_UNAVAILABLE", "The saved request could not be cleared. Check this task before acting again.");
 };
 const writePending = (p: Pending) => {
  const current = pendingNow(host, p.scope);
  return (current.kind === "none" || current.kind === "pending" && JSON.stringify(current.entry) === JSON.stringify(p)) && store(host, p.scope + ":request", p.request);
 };
 const writeAccepted = (a: Answer) => store(host, a.scope + ":answer", { answer: a, canonical: JSON.stringify(a) });
 const acceptedStoredExactly = (a: Answer) => JSON.stringify(answerNow(a.scope)) === JSON.stringify(a);
 const recordAccepted = (p: Pending, a: Answer): AcceptedStorage => {
  if (p.scope !== a.scope || p.requestId !== a.requestId || !writeAccepted(a) || !acceptedStoredExactly(a)) return "not-stored";
  try { clearPending(p.scope, p.requestId, p.startedAt); } catch { return "stored-but-pending-kept"; }
  return "durable";
 };
 // Existing task consumers use useSessionRequest. Match the helper's current
 // fence-aware hook API too, retaining this adapter's host-backed namespace.
 const watches = new Map<string, { fence: Fence; read: () => Promise<unknown>; pending: boolean; removedAt?: number }>();
 const removalReadReady = (scope: string) => {
  const watch = watches.get(scope);if (watch === undefined) return true;
  const current = pendingNow(host, scope);
  if (current.kind === "pending") { watch.pending = true;delete watch.removedAt;return true; }
  if (current.kind !== "none" || !watch.pending) return true;
  if (watch.removedAt === undefined) {
   watch.removedAt = tabSeq();watch.fence.taskFailed = { seq: watch.removedAt };watch.fence.version += 1;
   for (const listener of watch.fence.listeners) listener();
   try { void watch.read().catch(() => undefined); } catch { /* failed read keeps the fence */ }
  }
  if (watch.fence.taskFailed !== undefined || watch.fence.latestRead === undefined || watch.fence.latestRead.issued <= watch.removedAt) return false;
  watch.pending = false;delete watch.removedAt;return true;
 };
 const usePending = (scope: string | undefined): ActionPendingState<Pending> => { useTaskActionVersion(host);return scope === undefined ? { kind: "unavailable" } : pendingNow(host, scope); };
 const usePendingWithFence = (scope: string | undefined, fence: Fence, read: () => Promise<unknown>): ActionPendingState<Pending> => {
  useSyncExternalStore(listener => {
   if (scope !== undefined) {
    const previous = watches.get(scope);
    watches.set(scope, previous?.fence === fence ? { ...previous, read } : { fence, read, pending: pendingNow(host, scope).kind === "pending" });
    removalReadReady(scope);
   }
   const changed = (event: Event) => {
    if (scope !== undefined) {
     if (event instanceof StorageEvent && event.key === scope + ":request" && event.oldValue !== null) {
      const watch = watches.get(scope);if (watch !== undefined) watch.pending = true;
     }
     removalReadReady(scope);
    }
    listener();
   };
   globalThis.addEventListener?.(EVENT, changed);globalThis.addEventListener?.("storage", changed);
   return () => { globalThis.removeEventListener?.(EVENT, changed);globalThis.removeEventListener?.("storage", changed); };
  }, () => { try { return scope === undefined ? undefined : host.storage.get(scope + ":request"); } catch { return "unavailable"; } }, () => undefined);
  return scope === undefined ? { kind: "unavailable" } : pendingNow(host, scope);
 };
 const useAccepted = (scope: string | undefined) => { useTaskActionVersion(host);return scope === undefined ? undefined : answerNow(scope); };
 return {
  lockName: p => "rovara-task-action:" + p.scope, readPendingNow: (scope: string) => pendingNow(host, scope),
  parsePending: (_raw: string | null, scope: string) => pendingNow(host, scope), parseAccepted: (_raw: string | null, scope: string) => answerNow(scope),
  writePending, clearPending, readAcceptedNow: answerNow, writeAccepted, clearAccepted, acceptedStoredExactly, recordAccepted, usePending, usePendingWithFence, useAccepted,
  claimPending(p, refusalNow, storageWords) {
   if (!removalReadReady(p.scope)) return { stop: true, words: "Rovara is reading this again. Check the latest state before trying again." };
   const why = refusalNow();if (why !== undefined) return { stop: true, words: why };
   if (pendingNow(host, p.scope).kind !== "none" || answerNow(p.scope) !== undefined) return { stop: true, words: "Rovara didn't confirm the previous request. Check before acting again." };
   return writePending(p) ? { stop: false } : { stop: true, words: storageWords };
  },
 } satisfies ActionRecords<Pending, Answer>;
}
const versions = new WeakMap<AppHost, number>();
export function useTaskActionVersion(host: AppHost) {
 useSyncExternalStore(listener => {
  const changed = () => { versions.set(host, (versions.get(host) ?? 0) + 1);listener(); };
  globalThis.addEventListener?.(EVENT, changed);globalThis.addEventListener?.("storage", changed);
  return () => { globalThis.removeEventListener?.(EVENT, changed);globalThis.removeEventListener?.("storage", changed); };
 }, () => versions.get(host) ?? 0, () => 0);
}
export const isFinalTaskActionRefusal = (failure: unknown): boolean => isFinalActionRefusal(failure, { route: actionErrorRoutes.get(failure as ApiError) ?? "" });
/** Frozen body + one-shot send. A route's documented refusal alone may release it. */
export async function runTaskAction<T>(host: AppHost, scope: string, action: string, body: Record<string, unknown> & { requestId: string }, send: (request: FrozenSessionRequest) => Promise<T>, stateScope: string | null = scope, refusalNow: () => string | undefined = () => undefined, definitiveRefusal: (failure: unknown) => boolean = isFinalTaskActionRefusal): Promise<T> {
 const records = taskActionRecords(host);
 let result: T | undefined, answered = false, failure: unknown = new ApiError(0, "REQUEST_UNCONFIRMED", "Rovara didn't confirm this yet. Check before acting again.");
 await runActionPress({
  records, recover: async () => true,
  pending: () => {
   const request = { requestId: body.requestId, action, body: JSON.parse(JSON.stringify(body)) as Record<string, unknown>, startedAt: Date.now(), fence: Number(body["sequence"] ?? 0) };
   return { requestId: request.requestId, startedAt: new Date(request.startedAt).toISOString(), scope, request };
  },
  refusalNow: () => stateScope !== null && sessionReadFailure(host, stateScope) !== undefined ? "Read the current task before changing it." : refusalNow(), storageWords: "This action can't be made safely in this browser. Browser storage is unavailable.",
  claimed: claim => {
   if (claim.kind !== "done") failure = new ApiError(0, "ACTION_CLAIM_UNAVAILABLE", claim.kind === "busy" ? "Another tab is changing this task. Nothing was sent here." : "This browser can't safely claim this action. Nothing was sent.");
   else if (claim.value.stop) failure = new ApiError(0, "PERSISTENCE_UNAVAILABLE", claim.value.words ?? "Check the previous request before acting again.");
  },
  send: async p => {
   // Advance the existing shared read fence INSIDE the exclusive claim, after
   // pending readback. A concurrent older read cannot settle this request.
   if (stateScope !== null) markSessionWrite(host, stateScope);
   const value = await send(p.request);return { requestId: p.requestId, scope, value };
  },
  accepted: (answer, storage) => { answered = true;result = answer.value as T;if (storage === "durable") records.clearAccepted(scope, answer.requestId); },
  failed: (error, p) => { failure = error;if (isCsrfFailure(error) || definitiveRefusal(error)) records.clearPending(scope, p.requestId, p.startedAt); },
  finished: () => undefined,
 });
 if (!answered) throw failure;
 return result as T;
}

/** Additional task-page senders share the same durable claim as the controls. */
export function useTaskAction(host: AppHost, subject: string, enabled = true) {
 const identity = useSessionIdentity(host, enabled), saved = useSessionRequest(host, identity.data, subject);
 const fence = useFence(saved.scope ?? "unread", "task-action");
 return {
  locked: identity.data === undefined || saved.request !== undefined || saved.storageError !== undefined || saved.failure !== undefined,
  pending: saved.request !== undefined,
  recovery: { fence, entry: saved.request === undefined ? undefined : { requestId: saved.request.requestId, startedAt: new Date(saved.request.startedAt).toISOString() } },
  request: saved.request,
  pendingKey: (saved.scope ?? "unread") + ":" + (saved.request?.requestId ?? "none"),
  async check<T>(read: () => Promise<T>, observed: (body: T, request: FrozenSessionRequest) => boolean): Promise<boolean> {
   if (saved.scope === undefined || identity.data === undefined) return false;
   const records = taskActionRecords(host), pending = records.readPendingNow(saved.scope);
   if (pending.kind !== "pending") return false;
   const key = pending.entry.requestId + ":" + pending.entry.startedAt;observeRecord(fence, key);
   const result = await fencedRead(fence, read);
   assertSessionIdentity(host, identity.data);
   if (fence.taskFailed !== undefined || fence.latestRead?.issued !== result.issued || result.issued <= fence.observed.get(key)! || !observed(result.body, pending.entry.request)) return false;
   const current = records.readPendingNow(saved.scope);
   if (current.kind !== "pending" || current.entry.requestId !== pending.entry.requestId || current.entry.startedAt !== pending.entry.startedAt) return false;
   records.clearPending(saved.scope, current.entry.requestId, current.entry.startedAt);return true;
  },
  async run<T>(action: string, body: Record<string, unknown> & { requestId: string }, send: (body: Record<string, unknown> & { requestId: string }) => Promise<T>, check?: () => Promise<void>): Promise<T> {
   if (identity.data === undefined || saved.scope === undefined || saved.request !== undefined || saved.storageError !== undefined) throw new ApiError(0, "READ_REQUIRED", "Check this task before changing it.");
   await readSessionIdentity(host);assertSessionIdentity(host, identity.data);await check?.();
   let waiting: { value: T } | undefined;
   try { return await runTaskAction(host, saved.scope, action, body, async request => {
    assertSessionIdentity(host, identity.data!);const value = await send(request.body as typeof body);assertSessionIdentity(host, identity.data!);
    if (typeof value === "object" && value !== null && (("kind" in value && ["needs_confirmation", "needs_admin_approval"].includes(String(value.kind))) || ("status" in value && value.status === "PENDING"))) { waiting = { value };throw new ApiError(202, "PENDING", "This change is waiting for confirmation."); }
    return value;
   }, saved.scope, () => { try { assertSessionIdentity(host, identity.data!);return undefined; } catch { return "Identity changed. Check this page again."; } });
   } catch (error) { if (waiting !== undefined) return waiting.value;throw error; }
  },
 };
}
