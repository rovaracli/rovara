import { z } from "zod";
import { OrgIdSchema, ReviewedSlackUnbindBodySchema, ReviewedSlackProposeBodySchema, ReviewedSlackApproveBodySchema, ProjectSlackProposalReaderSchema, ProjectSlackInventoryReaderSchema, ProjectSlackTargetReaderSchema, ProjectSlackReceiptReaderSchema, type ReviewedSlackUnbindBody } from "@agentx/contracts/web";
import type { AppHost, ApiRequest, ApiResponse } from "../host.js";
import { ApiError } from "./errors.js";
const message = "Slack request could not be confirmed. Check its status before resending.";
const codes = new Set(["AUTH_REQUIRED", "FORBIDDEN", "CSRF_STALE", "CHANGE_STALE", "IDEMPOTENCY_CONFLICT", "CONFIG_INVALID", "NOT_FOUND", "TOO_MANY_REQUESTS", "RUNTIME_UNAVAILABLE", "AUDIT_UNAVAILABLE", "SLACK_TEAM_NOT_BOUND"]);
export function createProjectSlackApi(host: AppHost, orgId: string, project: string) {
 let active = true, epoch = 0, redirected = false;
 const valid = (version: number) => active && epoch === version;
 const invalid = () => new ApiError(502, "INVALID_RESPONSE", "Slack evidence did not match this project or request.");
 function checked<T>(schema: { parse(value: unknown): T }, value: unknown): T { try { return schema.parse(value); } catch { throw new ApiError(400, "CONFIG_INVALID", "Review a valid Slack request."); } }
 async function call<T extends { orgId: string; project: string }>(request: ApiRequest, schema: { parse(value: unknown): T }): Promise<T> {
  const version = epoch;if (!valid(version)) throw new ApiError(0, "SCOPE_ENDED", message);
  checked(OrgIdSchema, orgId);checked(ProjectSlackTargetReaderSchema.shape.project, project);
  let response: ApiResponse, timer: ReturnType<typeof setTimeout> | undefined;
  try { response = await Promise.race([host.transport.request({ ...request, retry: "never" }), new Promise<ApiResponse>((_, reject) => { timer = setTimeout(() => reject(new Error("Slack request deadline")), 30000); })]); }
  catch { throw new ApiError(0, valid(version) ? "RUNTIME_UNAVAILABLE" : "SCOPE_ENDED", message); }
  finally { clearTimeout(timer); }
  if (!valid(version)) throw new ApiError(0, "SCOPE_ENDED", message);
  if (response.status < 200 || response.status >= 300) {
   const error = response.body as { error?: { code?: unknown } } | undefined, raw = error?.error?.code;
   const code = typeof raw === "string" && codes.has(raw) ? raw : response.status === 404 ? "NOT_FOUND" : "RUNTIME_UNAVAILABLE";
   if (response.status === 401 && !redirected) { redirected = true;host.signIn(host.currentPath(), { automatic: true }); }
   throw new ApiError(response.status, code, message);
  }
  let value: T;try { value = schema.parse(response.body); } catch { throw invalid(); }
  if (value.orgId !== orgId || value.project !== project) throw invalid();return value;
 }
 const root = `/v1/app/projects/${encodeURIComponent(project)}/slack-channel`, query = `expectedOrgId=${encodeURIComponent(orgId)}`;
 return {
  setScopeActive(value: boolean) { if (!value) epoch++;active = value; },
  list(cursor?: string) { if (cursor !== undefined) checked(z.string().min(1).max(1024), cursor);return call({ method: "GET", path: `${root}/links?${query}${cursor === undefined ? "" : "&cursor=" + encodeURIComponent(cursor)}` }, ProjectSlackInventoryReaderSchema); },
  async review(teamId: string, channelId: string) {
   checked(ProjectSlackTargetReaderSchema.shape.teamId, teamId);checked(ProjectSlackTargetReaderSchema.shape.channelId, channelId);
   const value = await call({ method: "GET", path: `${root}/review?${query}&teamId=${encodeURIComponent(teamId)}&channelId=${encodeURIComponent(channelId)}` }, ProjectSlackTargetReaderSchema);
   if (value.teamId !== teamId || value.channelId !== channelId) throw invalid();return value;
  },
  async status(requestId: string) { checked(z.string().uuid(), requestId);const value = await call({ method: "GET", path: `${root}/requests/${requestId}?${query}` }, ProjectSlackReceiptReaderSchema);if (value.receipt.requestId !== requestId) throw invalid();return value; },
  async proposal(proposalId?: string) {
   if (proposalId !== undefined) checked(z.string().uuid(), proposalId);
   const value = await call({ method: "GET", path: `${root}/proposals/${proposalId ?? "current"}?${query}` }, ProjectSlackProposalReaderSchema);
   if (proposalId !== undefined && value.proposal?.proposalId !== proposalId) throw invalid();return value;
  },
  async propose(body: Omit<ReviewedSlackUnbindBody, "expectedOrgId">) {
   const input = checked(ReviewedSlackProposeBodySchema, { ...body, expectedOrgId: orgId });
   const value = await call({ method: "POST", path: `${root}/proposals`, body: input }, ProjectSlackProposalReaderSchema);
   if (value.proposal === null || value.proposal.proposalId !== input.requestId || value.proposal.teamId !== input.teamId || value.proposal.channelId !== input.channelId) throw invalid();return value;
  },
  async approve(body: { requestId: string; proposalId: string; teamId: string; channelId: string }) {
   checked(z.string().uuid(), body.proposalId);checked(ProjectSlackTargetReaderSchema.shape.teamId, body.teamId);checked(ProjectSlackTargetReaderSchema.shape.channelId, body.channelId);
   const input = checked(ReviewedSlackApproveBodySchema, { expectedOrgId: orgId, requestId: body.requestId });
   const value = await call({ method: "POST", path: `${root}/proposals/${body.proposalId}/approve`, body: input }, ProjectSlackReceiptReaderSchema);
   if (value.receipt.requestId !== input.requestId || value.receipt.operation !== "bind" || value.receipt.outcome.binding.teamId !== body.teamId || value.receipt.outcome.binding.channelId !== body.channelId) throw invalid();return value;
  },
  async unbind(body: Omit<ReviewedSlackUnbindBody, "expectedOrgId">) {
   const input = checked(ReviewedSlackUnbindBodySchema, { ...body, expectedOrgId: orgId }), value = await call({ method: "POST", path: `${root}/unbind`, body: input }, ProjectSlackReceiptReaderSchema);
   if (value.receipt.requestId !== input.requestId || value.receipt.operation !== "unbind" || value.receipt.outcome.teamId !== input.teamId || value.receipt.outcome.channelId !== input.channelId) throw invalid();return value;
  },
 };
}
