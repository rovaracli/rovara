import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppMeResponseReaderSchema } from "@agentx/contracts/web";
import type { AppHost } from "../host.js";
import { createApiClient, type SendResult } from "./client.js";
import { ApiError } from "./errors.js";
import { isCsrfFailure } from "../safe-action.js";
import { useTaskActionVersion } from "./task-action.js";

export interface SessionIdentity { companyId: string; personId: string }
export interface FrozenSessionRequest { requestId: string; action: string; body: Record<string, unknown>; startedAt: number; fence: number; confirmation?: Exclude<SendResult<unknown>, { kind: "done" }>; unknownChecks?: number }
type Fence = { issued: number; write: number; failure?: { status: number; code: string; message: string } };
type State = { identity?: SessionIdentity | undefined; identityIssue: number; listeners: Set<() => void> };
const stores = new WeakMap<AppHost, State>();
function store(host: AppHost): State { let value = stores.get(host);if (value === undefined) { value = { identityIssue: 0, listeners: new Set() };stores.set(host, value); }return value; }
const notify = (host: AppHost) => { for (const listener of store(host).listeners) listener(); };
const identityKey = (identity: SessionIdentity) => JSON.stringify([identity.companyId, identity.personId]);
export const sessionScope = (identity: SessionIdentity, subject: string) => "session:" + encodeURIComponent(identity.companyId) + ":" + encodeURIComponent(identity.personId) + ":" + encodeURIComponent(subject);
function get<T>(host: AppHost, key: string): T | undefined { const text = host.storage.get(key);return text === undefined || text === "" ? undefined : JSON.parse(text) as T; }
function put(host: AppHost, key: string, value: unknown, required: boolean) {
 const text = JSON.stringify(value);
 try { host.storage.set(key, text);if (host.storage.get(key) !== text) throw new Error("Storage did not retain the request"); }
 catch { if (required) throw new ApiError(0, "PERSISTENCE_UNAVAILABLE", "This action can't be made safely in this browser. Browser storage is unavailable."); }
 notify(host);
}
const identityReads = new WeakMap<AppHost, Promise<SessionIdentity>>();
export function readSessionIdentity(host: AppHost): Promise<SessionIdentity> {
 const pending = identityReads.get(host);if (pending !== undefined) return pending;
 const read = fetchIdentity(host).finally(() => { identityReads.delete(host); });identityReads.set(host, read);return read;
}
async function fetchIdentity(host: AppHost): Promise<SessionIdentity> {
 const state = store(host), issue = ++state.identityIssue;
 try {
  const me = await createApiClient(host).get("/v1/app/me", AppMeResponseReaderSchema, undefined, { retry: "never" });
  if (issue !== state.identityIssue) throw new ApiError(0, "IDENTITY_CHANGED", "Identity changed. Check this page again.");
  const identity = { companyId: me.org.orgId, personId: me.developer.id };
  if (!identity.companyId || !identity.personId) throw new Error("Identity unavailable");
  state.identity = identity;notify(host);return identity;
 } catch (error) { if (issue === state.identityIssue) { state.identity = undefined;notify(host); }throw error; }
}
export function assertSessionIdentity(host: AppHost, identity: SessionIdentity) {
 const current = store(host).identity;
 if (current === undefined || identityKey(current) !== identityKey(identity)) throw new ApiError(0, "IDENTITY_CHANGED", "Identity could not be confirmed. Check this page again.");
}
export function readFrozenSessionRequest(host: AppHost, scope: string): FrozenSessionRequest | undefined {
 const value = get<FrozenSessionRequest | null>(host, scope + ":request");
 if (value === undefined || value === null) return undefined;
 if (typeof value.requestId !== "string" || typeof value.action !== "string" || typeof value.startedAt !== "number" || typeof value.fence !== "number" || typeof value.body !== "object" || value.body === null) throw new ApiError(0, "PERSISTENCE_UNAVAILABLE", "The saved request could not be read. Check this task before acting again.");
 return value;
}
// The memory copy survives component/query removal. Durable fences protect reloads and other tabs.
const fences = new WeakMap<AppHost, Map<string, Fence>>();
function fence(host: AppHost, scope: string): Fence {
 let map = fences.get(host);if (map === undefined) { map = new Map();fences.set(host, map); }
 const memory = map.get(scope), saved = get<Fence>(host, scope + ":fence");
 const value = saved !== undefined && (memory === undefined || saved.issued >= memory.issued) ? saved : memory ?? { issued: 0, write: 0 };
 map.set(scope, value);return value;
}
function saveFence(host: AppHost, scope: string, value: Fence, required = false) { fences.get(host)!.set(scope, value);put(host, scope + ":fence", value, required); }
const nextIssue = (value: Fence) => Math.max(Date.now(), value.issued + 1, value.write + 1);
export function markSessionWrite(host: AppHost, scope: string) {
 const previous = fence(host, scope), issue = nextIssue(previous);
 saveFence(host, scope, { ...previous, issued: issue, write: issue }, true);
}
export function clearSessionRequest(host: AppHost, scope: string, requestId: string) {
 if (readFrozenSessionRequest(host, scope)?.requestId !== requestId) return;
 put(host, scope + ":request", null, true);
}
/** Retain recovery facts on the same pending request; never change its frozen body or release it. */
export function updateSessionRequest(host: AppHost, scope: string, requestId: string, recovery: { confirmation?: Exclude<SendResult<unknown>, { kind: "done" }>; unknownCheck?: true }) {
 const request = readFrozenSessionRequest(host, scope);
 if (request?.requestId !== requestId) return;
 put(host, scope + ":request", { ...request, ...(recovery.confirmation === undefined ? {} : { confirmation: recovery.confirmation }), ...(recovery.unknownCheck === true ? { unknownChecks: (Number.isSafeInteger(request.unknownChecks) && request.unknownChecks! > 0 ? request.unknownChecks! : 0) + 1 } : {}) }, true);
}
export function beginSessionRead(host: AppHost, scope: string): number { const previous = fence(host, scope), issued = nextIssue(previous);saveFence(host, scope, { ...previous, issued });return issued; }
export function finishSessionRead(host: AppHost, scope: string, issue: number, error?: unknown) {
 const current = fence(host, scope);
 if (issue !== current.issued || issue <= current.write) throw new ApiError(0, "READ_SUPERSEDED", "A newer task check is required.");
 if (error !== undefined) {
  const failure = error instanceof ApiError ? error : new ApiError(0, "READ_FAILED", "Couldn't read this session.");
  saveFence(host, scope, { ...current, failure: { status: failure.status, code: failure.code, message: failure.message } });throw failure;
 }
 saveFence(host, scope, { issued: current.issued, write: current.write });
}
export function sessionReadFailure(host: AppHost, scope: string) { return fence(host, scope).failure; }
export const isSessionCsrf = (error: unknown): boolean => isCsrfFailure(error);
// Only these route refusals are known to mean no request was accepted. 408/429/5xx and unknown codes remain locked.
// Code pin mismatches and Cloud nothing-to-do answers are definitive only at HTTP 409.
export const isFinalSessionRefusal = (error: unknown): boolean => error instanceof ApiError && (error.status === 409 && ["IDEMPOTENCY_CONFLICT", "CONFLICT"].includes(error.code) || ([400, 401, 403, 404, 409].includes(error.status) || (error.status === 501 && error.code === "NOT_ON_CODE_YET")) && ["AUTH_REQUIRED", "FORBIDDEN", "TASK_ACCESS_DENIED", "CHANGE_STALE", "NOT_FOUND", "CONFIG_INVALID", "INTENT_NOT_WAITING", "NOT_ON_CODE_YET", "TASK_CLOSED", "TASK_RELEASED", "APPROVAL_REQUIRED", "MODEL_NOT_ALLOWED"].includes(error.code));

export function useSessionIdentity(host: AppHost, enabled = true) {
 const read = useQuery({ queryKey: ["session-identity"], enabled, queryFn: () => readSessionIdentity(host), retry: false, staleTime: 0, refetchOnMount: "always" });
 const snapshot = () => store(host).identity === undefined ? "" : identityKey(store(host).identity!);
 const value = useSyncExternalStore(listener => { store(host).listeners.add(listener);return () => { store(host).listeners.delete(listener); }; }, snapshot, snapshot);
 return { ...read, data: read.isError || value === "" ? undefined : store(host).identity };
}
export function useSessionRequest(host: AppHost, identity: SessionIdentity | undefined, subject: string) {
 const scope = identity === undefined ? undefined : sessionScope(identity, subject);
 useTaskActionVersion(host);
 // Read-only recovery still writes the legacy record/fence through this host.
 // Keep those same-tab readers subscribed alongside the runner's notifications.
 useSyncExternalStore(listener => { store(host).listeners.add(listener);return () => { store(host).listeners.delete(listener); }; }, () => {
  if (scope === undefined) return "";
  try { return JSON.stringify([host.storage.get(scope + ":request"), host.storage.get(scope + ":fence")]); }
  catch { return "unavailable"; }
 }, () => "");
 try { return { scope, request: scope === undefined ? undefined : readFrozenSessionRequest(host, scope), failure: scope === undefined ? undefined : sessionReadFailure(host, scope), storageError: undefined }; }
 catch { return { scope, request: undefined, failure: undefined, storageError: "The saved request could not be read. Check this task before acting again." }; }
}

const acceptedSubjects = new WeakMap<AppHost, Map<string, { identity: string; issue: number; read: unknown }>>();
export function bindSessionRead(host: AppHost, identity: SessionIdentity, subject: string, read?: unknown) {
 let subjects = acceptedSubjects.get(host);if (subjects === undefined) { subjects = new Map();acceptedSubjects.set(host, subjects); }
 subjects.set(subject, { identity: identityKey(identity), issue: fence(host, sessionScope(identity, subject)).issued, read });
}
export function isCurrentSessionRead(host: AppHost, identity: SessionIdentity | undefined, subject: string, read?: unknown): boolean {
 try {
  if (identity === undefined) return false;
  const accepted = acceptedSubjects.get(host)?.get(subject), current = fence(host, sessionScope(identity, subject));
  // A sender can bind its accepted response to the issue fence. Even a newer
  // pending or successful direct read supersedes that response, outside Query.
  return accepted?.identity === identityKey(identity) && current.failure === undefined && (read === undefined || accepted.read === read && accepted.issue === current.issued);
 } catch { return false; }
}

/** Session writes require a final answer. A 202 remains unknown even if its body resembles the eventual receipt. */
export function sessionWriteHost(host: AppHost): AppHost {
 return { ...host, transport: { async request(input) {
  const response = await host.transport.request(input);
  if (input.method !== "GET" && input.method !== "HEAD" && response.status === 202) throw new ApiError(202, "PENDING", "Rovara didn't confirm this yet. Check its current status before acting again.");
  return response;
 } } };
}
