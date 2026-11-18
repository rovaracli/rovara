// L4-EVCI2: the setup checklist's "Eval check from your CI" (Code's `/v1/app/projects/{p}/ci-eval-check` read and confirm, through Cloud). Code decides who may; this client only asks. Every answer is read with a
// strict schema; no dollar figure, run or log is in any of them.
import { useMemo } from "react";
import { EvalCheckSetBodySchema, EvalCheckViewSchema, ProjectOverviewProjectSchema, type EvalCheck } from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";
import { ApiError } from "./errors.js";

export type { EvalCheck, EvalCheckProposal, EvalCheckView } from "@agentx/contracts/web";

const base = (name: string) => "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(name)) + "/ci-eval-check";

export function createEvalCheckApi(host: AppHost) {
  const api = createApiClient(host);
  return {
    read: (project: string) => api.get(base(project), EvalCheckViewSchema),
    /** One check from the proposals, or null for none. Never retried by the client: the same request id is what makes a repeat safe. */
    set: (project: string, requestId: string, check: EvalCheck | null) => api.sendAnswer("PUT", base(project), EvalCheckSetBodySchema.parse({ requestId, check }), EvalCheckViewSchema, { retry: "never" }),
  };
}
export function useEvalCheckApi() { const host = useAppHost(); return useMemo(() => createEvalCheckApi(host), [host]); }
export const evalCheckKey = (project: string) => ["eval-check", project] as const;
/** Code (or Cloud) does not serve the card yet: the row is absent. */
export const evalCheckAbsent = (error: unknown) => error instanceof ApiError && (error.code === "NOT_ON_CODE_YET" || error.status === 501 || error.status === 404);
