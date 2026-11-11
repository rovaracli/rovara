// "Ask about this task": the two calls of the session page's question box. The server decides who may ask, how often and what the answer may say; this file only sends and reads.
// POST /v1/app/sessions/{id}/ask queues the question (the same requestId is the same Ask); GET .../asks/{askId} reads where it is and, once answered, its text. Sent once from the browser (`retry: "never"`).
import { AskStatusReaderSchema, SessionIdSchema } from "@agentx/cloud-contracts/web";
import type { AppHost } from "../host.js";
import { createApiClient } from "./client.js";

const NEVER = { retry: "never" } as const;

export function createSessionAskApi(host: AppHost) {
 const api = createApiClient(host), path = (id: string) => "/v1/app/sessions/" + encodeURIComponent(SessionIdSchema.parse(id));
 return {
  ask: (id: string, body: { requestId: string; question: string }) => api.sendAnswer("POST", path(id) + "/ask", body, AskStatusReaderSchema, NEVER),
  status: (id: string, askId: string) => api.get(path(id) + "/asks/" + encodeURIComponent(askId), AskStatusReaderSchema),
 };
}
