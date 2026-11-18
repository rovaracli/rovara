// L4-EVC: the setup flow's ONE eval card (Code's hosted routes through Cloud). Readers project the answers; Code decides everything (who may approve, the dollars held against its own figures, the
// fresh sign-in), so this client only asks. A body is checked against its strict schema first; the dollars a person saw (`seen`) are passed in from the read, never worked out here. The gateway puts its own
// `requestId` in every answer and the contracts are strict, so it is set aside first.
import { useMemo } from "react";
import {
  EvalApproveReplySchema, EvalApproveRequestSchema, EvalCardViewSchema, EvalDecideReplySchema, EvalDecideRequestSchema, EvalHealthReplySchema, EvalHealthRequestSchema, EvalWrapperActionReplySchema, EvalWrapperActionRequestSchema, ProjectOverviewProjectSchema,
} from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";

function exactAnswer<T>(schema: { parse(value: unknown): T }): { parse(value: unknown): T } {
  return { parse(value: unknown): T { if (typeof value !== "object" || value === null || Array.isArray(value)) return schema.parse(value); const own = { ...value } as Record<string, unknown>; delete own["requestId"]; return schema.parse(own); } };
}

export function createEvalCardApi(host: AppHost) {
  const api = createApiClient(host);
  const base = (name: string) => "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(name)) + "/setup-agent";
  return {
    read: (name: string) => api.get(base(name) + "/eval", exactAnswer(EvalCardViewSchema)),
    /** ONE act: confirm the eval and approve its spend. Needs a fresh sign-in; never sent twice by the client. */
    approve: (name: string, body: ReturnType<typeof EvalApproveRequestSchema.parse>) => api.sendAnswer("POST", base(name) + "/eval-approve", EvalApproveRequestSchema.parse(body), exactAnswer(EvalApproveReplySchema), { retry: "never" }),
    /** Approve or reject the waiting spend item, bound to the offer the read carried. */
    decide: (name: string, body: ReturnType<typeof EvalDecideRequestSchema.parse>) => api.sendAnswer("POST", base(name) + "/eval-decide", EvalDecideRequestSchema.parse(body), exactAnswer(EvalDecideReplySchema), { retry: "never" }),
    /** The opt-in health check: a person's yes. Only ever called from a click. */
    health: (name: string, body: ReturnType<typeof EvalHealthRequestSchema.parse>) => api.sendAnswer("POST", base(name) + "/eval-health", EvalHealthRequestSchema.parse(body), exactAnswer(EvalHealthReplySchema), { retry: "never" }),
    /** L4-EVW4: a person's act on the wrapper card (open a pull request for the file, Not now, Set up now, Check now). It needs no fresh sign-in: it writes at most one new file as a pull request, spends nothing, and Code re-checks the person's role live. */
    wrapperAct: (name: string, body: ReturnType<typeof EvalWrapperActionRequestSchema.parse>) => api.sendAnswer("POST", base(name) + "/eval-wrapper", EvalWrapperActionRequestSchema.parse(body), exactAnswer(EvalWrapperActionReplySchema), { retry: "never" }),
  };
}
export function useEvalCardApi() { const host = useAppHost(); return useMemo(() => createEvalCardApi(host), [host]); }
export const evalCardKey = (project: string) => ["eval-card", project] as const;
