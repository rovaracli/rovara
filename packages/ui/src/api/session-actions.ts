import { SessionIdSchema, SessionResponseReaderSchema, SessionCloseResponseReaderSchema, SessionFollowResponseReaderSchema, MergeDoneReaderSchema } from "@agentx/contracts/web";
import { z } from "zod";
import type { AppHost } from "../host.js";
import { createApiClient } from "./client.js";

/** Code's answer to "may I merge this task, and would it merge now?" (DEC 254zzz94), as Cloud's server rebuilt it. */
const MergeHead = z.object({ repositoryId: z.string().min(1).max(200), number: z.number().int().positive(), headSha: z.string().regex(/^[a-f0-9]{40}$/u) }).strict();
export const MergeReadinessReader = z.object({
 mayMerge: z.boolean(), ready: z.boolean(), message: z.string().max(400).optional(), risk: z.enum(["low", "medium", "high"]).optional(), heads: z.array(MergeHead).max(32).optional(),
 pullRequests: z.array(z.object({ repositoryId: z.string().min(1).max(200), number: z.number().int().positive(), url: z.string().url().max(2048).optional() }).strict()).max(32),
}).strict();
export type MergeReadiness = z.infer<typeof MergeReadinessReader>;
export function createSessionActions(host: AppHost) {
 const api = createApiClient(host), path = (id: string) => "/v1/app/sessions/" + encodeURIComponent(SessionIdSchema.parse(id));
 const control = (id: string, action: "stop" | "retry" | "take-over") => api.send("POST", path(id) + "/" + action, { requestId: crypto.randomUUID() }, SessionResponseReaderSchema);
 return {
  // DEC 254zzz94: whether this person may merge the task and whether it would merge now (Code re-reads GitHub), and the press itself (one request id is one merge; the website's own client only).
  mergeReadiness: (id: string) => api.get(path(id) + "/merge", MergeReadinessReader, undefined, { retry: "never" }),
  merge: (id: string, requestId: string, shown?: { expectedHeads?: MergeReadiness["heads"]; risk?: MergeReadiness["risk"] }) => api.send("POST", path(id) + "/merge", { requestId, ...(shown?.expectedHeads === undefined || shown.expectedHeads.length === 0 ? {} : { expectedHeads: shown.expectedHeads }), ...(shown?.risk === undefined ? {} : { risk: shown.risk }) }, MergeDoneReaderSchema, { retry: "never" }),
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
