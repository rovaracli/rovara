// Browser testing in a project's setup (owner decisions 417, 420, 421): Code's `/v1/app/projects/{p}/browser-testing` read and changes, through Cloud. Nothing here takes a password, an address or an account: every body
// is one of the strict schemas of @agentx/contracts/web, every answer is read with its strict schema. A change is never retried by the client; a repeat after a lost answer is the person's, after a read.
import { useMemo } from "react";
import {
  BrowserTestingCheckBodySchema, BrowserTestingChoicesBodySchema, BrowserTestingDecisionAnswerSchema, BrowserTestingDecisionBodySchema, BrowserTestingSimpleBodySchema, BrowserTestingViewSchema, ProjectOverviewProjectSchema,
  type BrowserTestingProof,
} from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";
import { ApiError } from "./errors.js";

export type { BrowserTestingView, BrowserTestingProof } from "@agentx/contracts/web";

const base = (name: string) => "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(name)) + "/browser-testing";
const never = { retry: "never" } as const;

export function createBrowserTestingApi(host: AppHost) {
  const api = createApiClient(host);
  const simple = (project: string, tail: string, requestId: string) => api.sendAnswer("POST", base(project) + tail, BrowserTestingSimpleBodySchema.parse({ requestId }), BrowserTestingViewSchema, never);
  return {
    read: (project: string) => api.get(base(project), BrowserTestingViewSchema),
    refresh: (project: string, requestId: string) => simple(project, "/refresh", requestId),
    discard: (project: string, requestId: string) => simple(project, "/discard", requestId),
    pause: (project: string, requestId: string) => simple(project, "/pause", requestId),
    resume: (project: string, requestId: string) => simple(project, "/resume", requestId),
    choices: (project: string, requestId: string, expectedDraftRevision: number, choices: { proof?: BrowserTestingProof; runTimeoutMs?: number }) =>
      api.sendAnswer("PUT", base(project) + "/draft", BrowserTestingChoicesBodySchema.parse({ requestId, expectedDraftRevision, ...choices }), BrowserTestingViewSchema, never),
    check: (project: string, requestId: string, expectedDraftRevision: number) =>
      api.sendAnswer("POST", base(project) + "/check", BrowserTestingCheckBodySchema.parse({ requestId, expectedDraftRevision }), BrowserTestingViewSchema, never),
    /** Approve exactly what was shown: the request id, revision and digest of `candidate.approval`. */
    approve: (project: string, approval: { requestId: string; revision: number; artifactDigest: string }) =>
      api.sendAnswer("POST", base(project) + "/decision", BrowserTestingDecisionBodySchema.parse({ requestId: approval.requestId, outcome: "approve", seen: { revision: approval.revision, artifactDigest: approval.artifactDigest } }), BrowserTestingDecisionAnswerSchema, never),
  };
}
export function useBrowserTestingApi() { const host = useAppHost(); return useMemo(() => createBrowserTestingApi(host), [host]); }
export const browserTestingKey = (project: string) => ["browser-testing", project] as const;
/** Code (or Cloud) does not serve the page yet: the row is absent and the page says so. */
export const browserTestingAbsent = (error: unknown) => error instanceof ApiError && (error.code === "NOT_ON_CODE_YET" || error.status === 501);
