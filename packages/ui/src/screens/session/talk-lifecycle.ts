import { sessionScope } from "../../api/session-safety.js";
import { runTaskAction, useTaskActionVersion } from "../../api/task-action.js";
import { isCsrfFailure } from "../../safe-action.js";
import { useSyncExternalStore } from "react";
import { SessionMessageReaderSchema, SessionViewReaderSchema } from "@agentx/contracts/web";
import type { AppHost } from "../../host.js";
import { ApiError } from "../../api/errors.js";
import type { ReadMessage } from "../../api/sessions.js";

type Health = "current" | "failed" | "refused" | "reading";
type Frozen = { requestId: string; operation: "send" | "edit" | "delete" | "question"; body: Record<string, unknown>; startedAt: string; sequence: number };
type State = { sequence: number; reads: Record<string, { sequence: number; health: Health }>; lock?: Frozen; receipt?: ReadMessage; receiptSequence?: number; actions?: string[]; questionRefusalSequence?: number };
const hosts = new WeakMap<AppHost, { version: number; listeners: Set<() => void>; fallback: Map<string, State> }>();
function channel(host: AppHost) { let value = hosts.get(host);if (!value) { value = { version: 0, listeners: new Set(), fallback: new Map() };hosts.set(host, value); }return value; }
export const talkScope = (company: string, person: string, session: string) => "talk:" + [company, person, session].map(encodeURIComponent).join(":");
function load(host: AppHost, scope: string): State {
 const local = channel(host).fallback.get(scope);
 try { const raw = host.storage.get(scope);if (raw !== undefined) { const parsed = JSON.parse(raw) as State;if (!Number.isSafeInteger(parsed.sequence) || typeof parsed.reads !== "object" || parsed.reads === null) throw new Error("Invalid Talk recovery");if (!local) return parsed;
  const latest = local.sequence >= parsed.sequence ? local : parsed;
  const reads = { ...latest.reads };
  for (const [resource, read] of Object.entries(local.reads)) if ((reads[resource]?.sequence ?? -1) <= read.sequence) reads[resource] = read;
  return { ...latest, sequence: Math.max(local.sequence, parsed.sequence), reads };
 } }
 catch { if (!local) return { sequence: 0, reads: { unreadable: { sequence: 0, health: "failed" } } }; }
 return local ?? { sequence: 0, reads: {} };
}
function save(host: AppHost, scope: string, state: State, required = false) {
 const value = JSON.stringify(state);
 try { host.storage.set(scope, value);if (host.storage.get(scope) !== value) throw new Error("Storage unavailable"); }
 catch { if (required) throw new ApiError(0, "PERSISTENCE_FAILED", "This action can't be made safely in this browser. Your draft is still here."); }
 const c = channel(host);c.fallback.set(scope, state);c.version++;c.listeners.forEach(listener => listener());
}
// Adapt the existing conversation-health record's lock to the shared runner's
// request reader. There is one pending record, including across old reloads.
function sessionSubject(scope: string): { companyId: string; personId: string; session: string } {
 const parts = scope.split(":").slice(1).map(decodeURIComponent);
 return { companyId: parts[0]!, personId: parts[1]!, session: parts[2]! };
}
function composerKey(scope: string, body: Record<string, unknown>): string {
 const identity = sessionSubject(scope), anchor = body["anchor"] as { target?: string; targetId?: string } | undefined;
 return sessionScope(identity, identity.session + ":talk:" + (anchor === undefined ? "all" : anchor.target + ":" + anchor.targetId)) + ":request";
}
const actionHosts = new WeakMap<AppHost, AppHost>();
function actionHost(host: AppHost): AppHost {
 let adapter = actionHosts.get(host);if (adapter) return adapter;
 adapter = { ...host, storage: {
  get(key) {
   if (!key.endsWith(":request")) return host.storage.get(key);
   const lock = load(host, key.slice(0, -8)).lock;
   return lock === undefined ? undefined : JSON.stringify({ requestId: lock.requestId, action: lock.operation, body: lock.body, startedAt: Date.parse(lock.startedAt), fence: lock.sequence });
  },
  set(key, raw) {
   if (!key.endsWith(":request")) { host.storage.set(key, raw);return; }
   const scope = key.slice(0, -8), state = { ...load(host, scope) };
   const request = JSON.parse(raw) as { requestId: string; action: Frozen["operation"]; body: Record<string, unknown>; startedAt: number } | null;
   if (request === null) {
    if (state.lock?.operation === "send") {
     const alias = composerKey(scope, state.lock.body);host.storage.set(alias, "null");if (host.storage.get(alias) !== "null") throw new Error("Composer request cleanup failed");
    }
    delete state.lock;
   }
   else {
    if (request.action === "send") {
     const alias = composerKey(scope, request.body);host.storage.set(alias, raw);if (host.storage.get(alias) !== raw) throw new ApiError(0, "PERSISTENCE_FAILED", "This action can't be made safely in this browser. Your draft is still here.");
    }
    state.lock = { requestId: request.requestId, operation: request.action, body: request.body, startedAt: new Date(request.startedAt).toISOString(), sequence: Number(request.body["sequence"] ?? state.sequence) };
   }
   save(host, scope, state, true);
  },
 } };
 actionHosts.set(host, adapter);return adapter;
}
export function useTalkState(host: AppHost, scope: string | undefined) {
 useTaskActionVersion(host);
 useSyncExternalStore(listener => { const c = channel(host);c.listeners.add(listener);const changed = () => { c.version++;listener(); };window.addEventListener("storage", changed);return () => { c.listeners.delete(listener);window.removeEventListener("storage", changed); }; }, () => channel(host).version);
 return scope === undefined ? undefined : load(host, scope);
}
export function talkWritable(host: AppHost, scope: string | undefined, resources: readonly string[]): boolean {
 if (!scope) return false;
 const state = load(host, scope);
 return state.lock === undefined && resources.every(resource => state.reads[resource]?.health === "current") && !Object.values(state.reads).some(read => read.health === "refused");
}
/** Issue-order fence lives in identity-scoped host storage, including when the view unmounts. */
export async function talkRead<T>(host: AppHost, scope: string | undefined, resource: string, read: () => Promise<T>): Promise<T> {
 if (scope === undefined) return read();
 const before = load(host, scope), sequence = before.sequence + 1;
 save(host, scope, { ...before, sequence, reads: { ...before.reads, [resource]: { sequence, health: before.reads[resource]?.health === "refused" ? "refused" : "reading" } } });
 try {
  const result = await read(), current = load(host, scope);
  if (current.reads[resource]?.sequence !== sequence) throw new ApiError(0, "READ_SUPERSEDED", "A newer conversation read is in progress.");
  const next: State = { ...current, ...(resource === "session" ? { actions: SessionViewReaderSchema.parse(result).you.actions } : {}), reads: { ...current.reads, [resource]: { sequence, health: "current" } } };
  if (resource === "question-authority" && next.questionRefusalSequence !== undefined && sequence > next.questionRefusalSequence) delete next.questionRefusalSequence;
  save(host, scope, next);return result;
 } catch (failure) {
  const current = load(host, scope);
  if (current.reads[resource]?.sequence === sequence) save(host, scope, { ...current, reads: { ...current.reads, [resource]: { sequence, health: failure instanceof ApiError && (failure.status === 401 || failure.status === 403) && !csrfFailure(failure) ? "refused" : "failed" } } });
  throw failure;
 }
}
export const csrfFailure = isCsrfFailure;
// These are the session-message route's documented pre-write refusals. 408, 429, unlisted 4xx and every 5xx remain unknown.
function finalRefusal(failure: unknown): boolean { return csrfFailure(failure) || failure instanceof ApiError && ["NOT_FOUND", "SESSION_NOT_FOUND", "FORBIDDEN", "AUTH_REQUIRED", "SESSION_REVISION_CONFLICT", "CONFLICT", "BAD_REQUEST", "VALIDATION_ERROR"].includes(failure.code) && [400, 401, 403, 404, 409].includes(failure.status); }
async function talkRequest<T>(host: AppHost, scope: string | undefined, resources: readonly string[], operation: Frozen["operation"], body: Record<string, unknown>, send: (requestId: string) => Promise<T>, receipt: (value: T) => ReadMessage | undefined): Promise<T> {
 if (!scope || !talkWritable(host, scope, resources)) throw new ApiError(0, "READ_REQUIRED", "Read the current conversation before changing it.");
 if (operation === "question" && talkQuestionRefused(host, scope)) throw new ApiError(403, "FORBIDDEN", "This question is no longer available in this session.");
 const allowed = load(host, scope).actions ?? [];
 if (operation !== "question" && !allowed.includes(operation === "send" && body["kind"] === "steer" ? "steer" : "comment")) throw new ApiError(403, "FORBIDDEN", "The current session does not allow this change.");
 const current = load(host, scope), requestId = crypto.randomUUID(), sequence = current.sequence + 1;
 const lock: Frozen = { requestId, operation, body: operation === "send" || operation === "question" ? { ...body, requestId } : body, sequence, startedAt: new Date().toISOString() };

 try {
  save(host, scope, { ...current, sequence });
  const value = await runTaskAction(actionHost(host), scope, operation, { ...lock.body, requestId, sequence }, async () => {
   const value = await send(requestId), message = receipt(value);
   if (message !== undefined && (!scope.endsWith(":" + encodeURIComponent(message.sessionId)) || operation !== "send" && message.messageId !== body["messageId"])) throw new ApiError(502, "INVALID_RESPONSE", "Rovara returned a receipt for a different message.");
   return value;
  }, sessionScope(sessionSubject(scope), sessionSubject(scope).session), () => {
   if (!talkWritable(host, scope, resources)) return "Read the current conversation before changing it.";
   const actions = load(host, scope).actions ?? [];
   return operation !== "question" && !actions.includes(operation === "send" && body["kind"] === "steer" ? "steer" : "comment") ? "The current session does not allow this change." : undefined;
  }, finalRefusal), message = receipt(value);
  if (message !== undefined && (!scope.endsWith(":" + encodeURIComponent(message.sessionId)) || operation !== "send" && message.messageId !== body["messageId"])) throw new ApiError(502, "INVALID_RESPONSE", "Rovara returned a receipt for a different message.");
  const latest = load(host, scope);
  if (latest.lock === undefined || latest.lock.requestId === requestId) { const next = { ...latest, ...(message === undefined ? {} : { receipt: message, receiptSequence: sequence }) };save(host, scope, next, true); }
  return value;
 } catch (failure) {
  const latest = load(host, scope);
  if ((latest.lock === undefined || latest.lock.requestId === requestId) && finalRefusal(failure)) {
   if (operation === "question" && failure instanceof ApiError && [401, 403].includes(failure.status) && !csrfFailure(failure)) latest.questionRefusalSequence = sequence;
   save(host, scope, latest, true);
  }
  throw failure;
 }
}
export function talkWrite(host: AppHost, scope: string | undefined, resources: readonly string[], operation: "send" | "edit" | "delete", body: Record<string, unknown>, send: (requestId: string) => Promise<ReadMessage>) {
 return talkRequest(host, scope, resources, operation, body, send, value => SessionMessageReaderSchema.parse(value));
}
export function talkQuestion<T>(host: AppHost, scope: string | undefined, resources: readonly string[], body: Record<string, unknown>, send: (requestId: string) => Promise<T>) {
 return talkRequest(host, scope, resources, "question", body, send, () => undefined);
}
export function talkQuestionRefused(host: AppHost, scope: string | undefined): boolean { return scope !== undefined && load(host, scope).questionRefusalSequence !== undefined; }
/** A read cannot identify a lost send by text: the reader has no requestId. Keep that lock until a definitive receipt is available. */
export function reconcileTalkMessages(host: AppHost, scope: string | undefined, resource: string, messages: readonly ReadMessage[]) {
 if (!scope) return;
 const state = load(host, scope), read = state.reads[resource];
 if (read?.health !== "current") return;
 let changed = false;
 if (state.receipt && read.sequence > (state.receiptSequence ?? 0)) { const fresh = messages.find(message => message.messageId === state.receipt?.messageId);if (fresh) state.receipt = fresh;else delete state.receipt;state.receiptSequence = read.sequence;changed = true; }
 if (state.lock && (state.lock.operation === "edit" || state.lock.operation === "delete") && read.sequence > state.lock.sequence) {
  const message = messages.find(item => item.messageId === state.lock?.body["messageId"]);
  if (message && message.rev > Number(state.lock.body["rev"])) { state.receipt = message;delete state.lock;changed = true; }
 }
 if (changed) save(host, scope, state);
}
