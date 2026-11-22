import { AppMeResponseReaderSchema } from "@agentx/contracts/web";
import type { QueryClient } from "@tanstack/react-query";
import { createReadClient } from "../../api/read-client.js";
import type { ApiRequest, AppHost } from "../../host.js";
import { fencedRead, fenceFor, recordUnknownActionCheck, withActionClaim } from "../../safe-action.js";
import { queueActionReads } from "./queue-action-reads.js";

type Identity = ReturnType<typeof AppMeResponseReaderSchema.parse>;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
/** Read the existing queue lock; malformed records stay held, never silently cleared. */
export function queuePending(raw: string | null) {
 try {
  const value: unknown = JSON.parse(raw ?? "null");
  if (!object(value) || !object(value["request"]) || typeof value["request"]["path"] !== "string" || !["POST", "PUT", "PATCH", "DELETE"].includes(String(value["request"]["method"])) || typeof value["startedAt"] !== "string") return undefined;
  const request = value["request"] as unknown as ApiRequest;
  return { request, startedAt: value["startedAt"], requestId: JSON.stringify(request) };
 } catch { return undefined; }
}
export function queuePendingKeys(person: Identity): string[] {
 const scope = "rovara:queue-action:" + JSON.stringify([person.org.orgId, person.developer.id]).slice(0, -1) + ",";
 try { return Object.keys(globalThis.localStorage).filter(key => key.startsWith(scope)); } catch { return []; }
}
/** A Check only reads. The exclusive claim excludes an in-flight send, even in another tab.
 * Each body is issued here after observing the saved press; cached data cannot settle it.
 */
export async function checkQueuePending(host: AppHost, query: QueryClient, person: Identity, key: string, explicit = false): Promise<void> {
 if (!queuePendingKeys(person).includes(key)) return;
 const claim = await withActionClaim(key, () => globalThis.localStorage.getItem(key));
 if (claim.kind !== "done") return;
 try {
  const entry = queuePending(claim.value);
  if (entry === undefined) return;
  const identity = () => query.getQueryState<Identity>(["queue", "identity"]);
  const samePerson = async () => {
   const current = await createReadClient(host).get("/v1/app/me", AppMeResponseReaderSchema, undefined, { retry: "never" }), active = identity();
   return active?.status === "success" && active.fetchFailureCount === 0 && active.data?.org.orgId === person.org.orgId && active.data.developer.id === person.developer.id && current.org.orgId === person.org.orgId && current.developer.id === person.developer.id;
  };
  const fence = fenceFor(query, key, "queue");
  try {
   if (!await samePerson()) throw new Error("Identity unread");
   const source = queueActionReads(host, query, entry.request)[0];
   if (source?.observed === undefined) throw new Error("Outcome unread");
   const read = await fencedRead(fence, () => source.read());
   if (fence.latestRead?.issued !== read.issued || fence.taskFailed !== undefined) return;
   if (!await samePerson()) throw new Error("Identity unread");
   if (globalThis.localStorage.getItem(key) !== claim.value) return;
   if (source.observed(read.body)) { globalThis.localStorage.removeItem(key);return; }
  } catch { /* Unknown or refused reads never release this press. */ }
  if (explicit) recordUnknownActionCheck(fence, entry);
 } finally { claim.release(); }
}
