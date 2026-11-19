import { SessionIdSchema, SessionResponseReaderSchema, SessionCloseResponseReaderSchema, SessionFollowResponseReaderSchema } from "@agentx/contracts/web";
import type { AppHost } from "../host.js";
import { createApiClient } from "./client.js";
export function createSessionActions(host: AppHost) {
 const api = createApiClient(host), path = (id: string) => "/v1/app/sessions/" + encodeURIComponent(SessionIdSchema.parse(id));
 const control = (id: string, action: "stop" | "retry" | "take-over") => api.send("POST", path(id) + "/" + action, { requestId: crypto.randomUUID() }, SessionResponseReaderSchema);
 return {
  // Understand's questions: `round` and `revision` are the ones the page read, so a stale form is refused by the server (INTENT_NOT_WAITING) rather than answered late.
  answer: (id: string, body: { requestId: string; round: number; revision: number; answers: Array<{ questionId: string; optionId?: string; text?: string }> }) => api.send("POST", path(id) + "/answers", body, SessionResponseReaderSchema),
  // The task's own close. The first ask never discards unpublished work; `discardUnpublished` is the person's answer to the list the first answer gave.
  close: (id: string, body: { requestId: string; discardUnpublished?: true }) => api.send("POST", path(id) + "/close", body, SessionCloseResponseReaderSchema),
  follow: (id: string) => api.send("POST", path(id) + "/follow", undefined, SessionFollowResponseReaderSchema),
  unfollow: (id: string) => api.send("DELETE", path(id) + "/follow", undefined, SessionFollowResponseReaderSchema),
  // Rovara-cloud#25: a task stopped by review findings. Send it back to coding with the owner's note, or accept the findings (with a reason) so the pull request opens.
  sendBack: (id: string, body: { requestId: string; note?: string }) => api.send("POST", path(id) + "/send-back", body, SessionResponseReaderSchema),
  acceptFindings: (id: string, body: { requestId: string; reason: string }) => api.send("POST", path(id) + "/accept-findings", body, SessionResponseReaderSchema),
  stop: (id: string) => control(id, "stop"), retry: (id: string) => control(id, "retry"), takeOver: (id: string) => control(id, "take-over"),
 };
}
