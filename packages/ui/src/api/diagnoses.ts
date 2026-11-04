// "Fix with agent": the two calls of the task page's diagnosis panel. The server decides who may ask, which provider the diagnosis runs on and what it may say; this file only sends and reads.
// POST /v1/app/diagnoses starts a light diagnosis of the error the session shows (the same requestId is the same diagnosis); GET /v1/app/diagnoses/{id} reads where it is and, once ready, its proposals.
// A diagnosis is read-only: nothing here applies a proposal. Sent once from the browser (`retry: "never"`).
import { DiagnosisIdSchema, DiagnosisStatusReaderSchema } from "@agentx/contracts/web";
import type { AppHost } from "../host.js";
import { createApiClient } from "./client.js";

const NEVER = { retry: "never" } as const;

export function createDiagnosesApi(host: AppHost) {
 const api = createApiClient(host);
 return {
  /** `errorRef` is the session view's own, sent back as it was read. */
  start: (body: { requestId: string; errorRef: unknown }) => api.sendAnswer("POST", "/v1/app/diagnoses", body, DiagnosisStatusReaderSchema, NEVER),
  status: (diagnosisId: string) => api.get("/v1/app/diagnoses/" + encodeURIComponent(DiagnosisIdSchema.parse(diagnosisId)), DiagnosisStatusReaderSchema),
 };
}
