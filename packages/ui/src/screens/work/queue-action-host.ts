import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { AppMeResponseReaderSchema } from "@agentx/contracts/web";
import { createReadClient } from "../../api/read-client.js";
import { accessEndedCode } from "../../api/served-read.js";
import { apiError, ApiError } from "../../api/errors.js";
import { isCsrfFailure, isFinalActionRefusal, postWithTimeout, withActionClaim } from "../../safe-action.js";
import type { ApiRequest, ApiResponse, AppHost } from "../../host.js";

type Identity = ReturnType<typeof AppMeResponseReaderSchema.parse>;
export interface QueueActionRead {
 subject?: string;
 basis?(value: unknown): unknown;
 key: QueryKey; shown: unknown; read(): Promise<unknown>; permitted(): boolean;
 /** Route's existing reader must accept the definitive answer before unlocking. */
 answer?(response: ApiResponse): boolean;
 /** Only the operation’s own later read may resolve its saved press. */
 observed?(value: unknown): boolean;
 pending?(response: ApiResponse): boolean;
}
const UNKNOWN = "Rovara didn't confirm this yet. Check its outcome before another change.";
const STALE = "The information or your access changed. Load again before making a change.";
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** G2's action-host ordering, with the exact live Work/Inbox handlers underneath.
 * No replay: uncertain non-idempotent lesson sends remain held in this browser.
 */
export function queueActionHost(host: AppHost, query: QueryClient, identity: () => Identity | undefined, sources: (input: ApiRequest) => QueueActionRead[], changed: () => void): AppHost {
 const api = createReadClient(host);
 const snapshot = (source: QueueActionRead, value: unknown) => JSON.stringify(source.basis?.(value) ?? value);
 const fresh = (source: QueueActionRead) => { const state = query.getQueryState(source.key);return state?.status === "success" && state.fetchFailureCount === 0 && snapshot(source, state.data) === snapshot(source, source.shown) && source.permitted(); };
 const samePerson = async (shown: Identity) => {
  const current = await api.get("/v1/app/me", AppMeResponseReaderSchema, undefined, { retry: "never" });
  const active = identity();
  if (active === undefined || current.org.orgId !== shown.org.orgId || current.developer.id !== shown.developer.id || active.org.orgId !== shown.org.orgId || active.developer.id !== shown.developer.id) throw new ApiError(403, "IDENTITY_CHANGED", STALE);
 };
 return { ...host, transport: { async request(input) {
  if (input.method === "GET" || input.method === "HEAD") return host.transport.request(input);
  const person = identity(), reads = sources(input);
  if (person === undefined || reads.length === 0 || !reads.every(fresh)) throw new ApiError(409, "CHANGE_STALE", STALE);
  const key = "rovara:queue-action:" + JSON.stringify([person.org.orgId, person.developer.id, reads[0]!.subject ?? input.path.split("?")[0]]);
  const entry = JSON.stringify({ request: input, startedAt: new Date().toISOString() });
  const claim = await withActionClaim(key, () => {
   if (globalThis.localStorage.getItem(key) !== null) throw new Error(UNKNOWN);
   globalThis.localStorage.setItem(key, entry);
   if (globalThis.localStorage.getItem(key) !== entry) throw new Error("Storage unavailable");
  });
  if (claim.kind !== "done") throw new ApiError(409, "ACTION_LOCKED", "This action can't be made safely in this browser, or another request is still unresolved. Nothing was sent here. " + UNKNOWN);
  let sent = false;
  try {
   await samePerson(person);
   for (const source of reads) {
    const current = await source.read();
    if (!fresh(source) || snapshot(source, current) !== snapshot(source, source.shown)) throw new ApiError(409, "CHANGE_STALE", STALE);
   }
   await samePerson(person);
   if (!reads.every(fresh) || globalThis.localStorage.getItem(key) !== entry) throw new ApiError(409, "CHANGE_STALE", STALE);
   sent = true;
   const response = await postWithTimeout(() => host.transport.request({ ...input, retry: "never" }));
   // Cloud rejects stale CSRF before forwarding: refresh identity without treating it as an authority refusal.
   if (isCsrfFailure(apiError(response.status, response.body, host.origin))) {
    globalThis.localStorage.removeItem(key);
    void query.invalidateQueries({ queryKey: ["queue", "identity"] });
    return response;
   }
   const refusal = isFinalActionRefusal(apiError(response.status, response.body, host.origin), { route: input.path });
   const pending = response.status === 202 && reads.some(source => source.pending?.(response) === true);
   const success = response.status >= 200 && response.status < 300 && response.status !== 202 && object(response.body) && Object.keys(response.body).length > 0 && !("error" in response.body) && accessEndedCode(response.body) === undefined && reads.every(source => source.answer?.(response) ?? true);
   if (!refusal && !success && !pending) throw new ApiError(502, "ACTION_UNCONFIRMED", UNKNOWN);
   if (!pending) globalThis.localStorage.removeItem(key);
   return response;
  } finally {
   try { if (!sent) globalThis.localStorage.removeItem(key); } finally { claim.release();changed(); }
  }
 } } };
}
