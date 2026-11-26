import { postWithTimeout } from "../safe-action.js";
import { forwardReader, TaskCloseActionSchema, TaskClosePreviewResponseSchema, SessionBoundCloseBodySchema, type TaskCloseAction, type SessionBoundCloseBody, SessionIdSchema, SessionResponseReaderSchema, SessionCloseResponseReaderSchema, SessionFollowResponseReaderSchema, MergeDoneReaderSchema, PendingConfirmationReaderSchema, PendingAdminApprovalReaderSchema } from "@agentx/contracts/web";
import { z } from "zod";
import type { AppHost } from "../host.js";
import { sessionWriteHost } from "./session-safety.js";
import { ApiError } from "./errors.js";
import { createApiClient } from "./client.js";

/** Code's answer to "may I merge this task, and would it merge now?" (DEC 254zzz94), as Cloud's server rebuilt it. */
const MergeHead = z.object({ repositoryId: z.string().min(1).max(200), number: z.number().int().positive(), headSha: z.string().regex(/^[a-f0-9]{40}$/u) }).strict();
const MergeReadinessStrict = z.object({
 mayMerge: z.boolean(), ready: z.boolean(), message: z.string().max(400).optional(), risk: z.enum(["low", "medium", "high"]).optional(), heads: z.array(MergeHead).max(32).optional(),
 pullRequests: z.array(z.object({ repositoryId: z.string().min(1).max(200), number: z.number().int().positive(), url: z.string().url().max(2048).optional() }).strict()).max(32),
}).strict();
/** T2: a forward reader. A field a newer Cloud server adds is kept and ignored, and a risk word this page does not know reads as "unknown", which offers no Merge (`pressBound`; the page falls back to GitHub). */
export const MergeReadinessReader = forwardReader(MergeReadinessStrict);
export type MergeReadiness = z.output<typeof MergeReadinessReader>;
export function createSessionActions(host: AppHost) {
 const api = createApiClient(sessionWriteHost(host)), path = (id: string) => "/v1/app/sessions/" + encodeURIComponent(SessionIdSchema.parse(id));
 // Only a structured confirmation may pass through a 202; an outcome-shaped
 // accepted body is still unknown, never a final ownership receipt.
 const ownership = createApiClient({ ...host, transport: { async request(input) {
  const response = await host.transport.request(input);
  if (response.status === 202 && !PendingConfirmationReaderSchema.safeParse(response.body).success && !PendingAdminApprovalReaderSchema.safeParse(response.body).success) throw new ApiError(202, "PENDING", "Rovara didn't confirm this yet. Check its current status before acting again.");
  return response;
 } } });
 const control = (id: string, action: "stop" | "retry", requestId: string = crypto.randomUUID()) => api.send("POST", path(id) + "/" + action, { requestId }, SessionResponseReaderSchema, { retry: "never" });
 return {
  // DEC 254zzz94: whether this person may merge the task and whether it would merge now (Code re-reads GitHub), and the press itself (one request id is one merge; the website's own client only).
  // The reader keeps unknown fields; the heads the page holds (and sends back with the press, which the engine reads strictly) are rebuilt with exactly the three fields, so a field a newer server adds never travels back.
  mergeReadiness: async (id: string): Promise<MergeReadiness> => { const read = await api.get(path(id) + "/merge", MergeReadinessReader, undefined, { retry: "never" }); return read.heads === undefined ? read : { ...read, heads: read.heads.map(({ repositoryId, number, headSha }) => ({ repositoryId, number, headSha })) }; },
  // The strict body Code reads names the heads and the risk the person saw; neither is ever dropped. With either missing nothing is sent.
  merge: (id: string, requestId: string, shown: { expectedHeads: ReadonlyArray<{ repositoryId: string; number: number; headSha: string }>; risk: NonNullable<MergeReadiness["risk"]> }) => {
   if (shown.expectedHeads.length === 0 || shown.risk === undefined || shown.risk === "unknown") throw new Error("A merge is never sent without the heads and the risk the person saw.");
   return postWithTimeout(() => api.send("POST", path(id) + "/merge", { requestId, expectedHeads: shown.expectedHeads, risk: shown.risk }, MergeDoneReaderSchema, { retry: "never" }), 120_000);
  },
  // Understand's questions: `round` and `revision` are the ones the page read, so a stale form is refused by the server (INTENT_NOT_WAITING) rather than answered late.
  answer: (id: string, body: { requestId: string; round: number; revision: number; answers: Array<{ questionId: string; optionId?: string; text?: string }> }) => api.send("POST", path(id) + "/answers", body, SessionResponseReaderSchema, { retry: "never" }),
  // The preview/bound path is available for the later dialog cutover; legacy Close below stays unchanged.
  previewClose: (id: string, action: TaskCloseAction) => api.get(path(id) + "/close?action=" + TaskCloseActionSchema.parse(action), TaskClosePreviewResponseSchema, undefined, { retry: "never" }),
  closeBound: (id: string, body: SessionBoundCloseBody) => api.send("POST", path(id) + "/close", SessionBoundCloseBodySchema.parse(body), SessionCloseResponseReaderSchema, { retry: "never" }),
  // The task's own close. The first ask never discards unpublished work; `discardUnpublished` is the person's answer to the list the first answer gave.
  close: (id: string, body: { requestId: string; discardUnpublished?: true }) => api.send("POST", path(id) + "/close", body, SessionCloseResponseReaderSchema, { retry: "never" }),
  follow: (id: string) => api.send("POST", path(id) + "/follow", undefined, SessionFollowResponseReaderSchema, { retry: "never" }),
  unfollow: (id: string) => api.send("DELETE", path(id) + "/follow", undefined, SessionFollowResponseReaderSchema, { retry: "never" }),
  // Rovara-cloud#25: a task stopped by review findings. Send it back to coding with the owner's note, or accept the findings (with a reason) so the pull request opens.
  sendBack: (id: string, body: { requestId: string; expectedRevision: number; candidateDigest: string; note?: string }) => api.send("POST", path(id) + "/send-back", body, SessionResponseReaderSchema, { retry: "never" }),
  acceptFindings: (id: string, body: { requestId: string; expectedRevision: number; candidateDigest: string; reason: string }) => api.send("POST", path(id) + "/accept-findings", body, SessionResponseReaderSchema, { retry: "never" }),
  stop: (id: string, requestId?: string) => control(id, "stop", requestId), retry: (id: string, requestId: string = crypto.randomUUID(), shown?: { expectedRevision: number; candidateDigest?: string }) => api.send("POST", path(id) + "/retry", { requestId, ...shown }, SessionResponseReaderSchema, { retry: "never" }), takeOver: (id: string, expectedPeopleRevision: number, requestId: string = crypto.randomUUID()) => {
   if (!Number.isSafeInteger(expectedPeopleRevision) || expectedPeopleRevision < 1) throw new Error("Take over needs the People revision shown on the page.");
   // Take-over proposes an ownership change; keep its validated confirmation metadata.
   return ownership.send("POST", path(id) + "/take-over", { requestId, expectedPeopleRevision }, SessionResponseReaderSchema, { retry: "never" });
  },
 };
}
