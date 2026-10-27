import { SessionIdSchema, SessionResponseReaderSchema, SessionFollowResponseReaderSchema } from "@agentx/contracts/web";
import type { AppHost } from "../host.js";
import { createApiClient } from "./client.js";
export function createSessionActions(host: AppHost) {
 const api = createApiClient(host), path = (id: string) => "/v1/app/sessions/" + encodeURIComponent(SessionIdSchema.parse(id));
 const control = (id: string, action: "stop" | "retry" | "take-over") => api.send("POST", path(id) + "/" + action, { requestId: crypto.randomUUID() }, SessionResponseReaderSchema);
 // The press never answers 200: it answers 202 (the link where the person confirms it) or a refusal, so a 200 is an unreadable answer.
 const noOkAnswer = { parse(): never { throw new Error("Merge has no 200 answer"); } };
 return {
  merge: (id: string, requestId: string) => api.send("POST", path(id) + "/merge", { requestId }, noOkAnswer),
  follow: (id: string) => api.send("POST", path(id) + "/follow", undefined, SessionFollowResponseReaderSchema),
  unfollow: (id: string) => api.send("DELETE", path(id) + "/follow", undefined, SessionFollowResponseReaderSchema),
  stop: (id: string) => control(id, "stop"), retry: (id: string) => control(id, "retry"), takeOver: (id: string) => control(id, "take-over"),
 };
}
