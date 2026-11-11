import { SessionIdSchema, SessionResponseReaderSchema, SessionCloseResponseReaderSchema, SessionFollowResponseReaderSchema, MergeDoneReaderSchema } from "@agentx/cloud-contracts/web";
import type { AppHost } from "../host.js";
import { createApiClient } from "./client.js";
import { StartedCodeReader } from "./code.js";
export function createSessionActions(host: AppHost) {
 const api = createApiClient(host), path = (id: string) => "/v1/app/sessions/" + encodeURIComponent(SessionIdSchema.parse(id));
 const control = (id: string, action: "stop" | "retry" | "take-over") => api.send("POST", path(id) + "/" + action, { requestId: crypto.randomUUID() }, SessionResponseReaderSchema);
 return {
  // Owner decision 2026-10-27: from the app (a browser session) a press merges at once and answers 200; a server that still asks for a confirmation answers 202 with its link. `risk` is the level the dialog showed.
  merge: (id: string, requestId: string, risk?: "low" | "medium" | "high") => api.send("POST", path(id) + "/merge", { requestId, ...(risk === undefined ? {} : { risk }) }, MergeDoneReaderSchema),
  // Understand's questions: `round` and `revision` are the ones the page read, so a stale form is refused by the server (INTENT_NOT_WAITING) rather than answered late.
  answer: (id: string, body: { requestId: string; round: number; revision: number; answers: Array<{ questionId: string; optionId?: string; text?: string }> }) => api.send("POST", path(id) + "/answers", body, SessionResponseReaderSchema),
  // "Make a change anyway" after an Answered task: starts a new task (the route answers 202 with the new task and its session). The same request id is the same start, however often it is sent.
  changeAnyway: (id: string, requestId: string) => api.send("POST", path(id) + "/change-anyway", { requestId }, StartedCodeReader),
  // The task's own close. The first ask never discards unpublished work; `discardUnpublished` is the person's answer to the list the first answer gave.
  close: (id: string, body: { requestId: string; discardUnpublished?: true }) => api.send("POST", path(id) + "/close", body, SessionCloseResponseReaderSchema),
  follow: (id: string) => api.send("POST", path(id) + "/follow", undefined, SessionFollowResponseReaderSchema),
  unfollow: (id: string) => api.send("DELETE", path(id) + "/follow", undefined, SessionFollowResponseReaderSchema),
  stop: (id: string) => control(id, "stop"), retry: (id: string) => control(id, "retry"), takeOver: (id: string) => control(id, "take-over"),
 };
}
