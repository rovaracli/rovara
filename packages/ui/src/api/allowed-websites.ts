import { z } from "zod";
import { OrgIdSchema, ProjectAllowedWebsitesMutationBodySchema, ProjectAllowedWebsitesApprovalBodySchema, ProjectAllowedWebsitesDecisionBodySchema,
 ProjectAllowedWebsitesReviewReaderSchema, ProjectAllowedWebsitesProposalReaderSchema, ProjectAllowedWebsitesResultReaderSchema,
 type ProjectAllowedWebsitesMutationBody, type ProjectAllowedWebsitesApprovalBody, type ProjectAllowedWebsitesDecisionBody } from "@agentx/contracts/web";
import type { AppHost, ApiRequest, ApiResponse } from "../host.js";
import { ApiError } from "./errors.js";
const message = "Website request could not be confirmed. Check its status before resending.";
const knownCodes = new Set(["AUTH_REQUIRED", "FORBIDDEN", "CSRF_STALE", "CHANGE_STALE", "PROJECT_REVISION_MISMATCH", "IDEMPOTENCY_CONFLICT", "CONFIG_INVALID", "NOT_FOUND", "TOO_MANY_REQUESTS", "RUNTIME_UNAVAILABLE", "AUDIT_UNAVAILABLE"]);
/** One transport request per explicit call. This bypasses retrying API helpers;
 * retry:never also disables the browser host's automatic CSRF replay. */
export function createAllowedWebsitesApi(host: AppHost, orgId: string, project: string) {
 let active = true, epoch = 0, redirected = false;
 const valid = (version: number) => active && epoch === version;
 const invalid = () => new ApiError(502, "INVALID_RESPONSE", "The website response did not match this reviewed request.");
 const input = <T>(schema: { parse(value: unknown): T }, value: unknown): T => { try { return schema.parse(value); } catch { throw new ApiError(400, "CONFIG_INVALID", "Review a valid website request."); } };
 async function call<T>(request: ApiRequest, reader: { parse(value: unknown): T }): Promise<T> {
  const version = epoch;if (!valid(version)) throw new ApiError(0, "SCOPE_ENDED", message);
  if (!OrgIdSchema.safeParse(orgId).success || !ProjectAllowedWebsitesReviewReaderSchema.shape.project.safeParse(project).success) throw new ApiError(400, "CONFIG_INVALID", "Choose a valid company and project.");
  let timer: ReturnType<typeof setTimeout> | undefined, response: ApiResponse;
  try { response = await Promise.race([host.transport.request({ ...request, retry: "never" }), new Promise<ApiResponse>((_, reject) => { timer = setTimeout(() => reject(new Error("Website request deadline")), 30000); })]); }
  catch { if (!valid(version)) throw new ApiError(0, "SCOPE_ENDED", message);throw new ApiError(0, "RUNTIME_UNAVAILABLE", message); }
  finally { clearTimeout(timer); }
  if (!valid(version)) throw new ApiError(0, "SCOPE_ENDED", message);
  if (response.status !== 200) {
   const parsed = z.object({ error: z.object({ code: z.string() }) }).safeParse(response.body);
   const code = parsed.success && knownCodes.has(parsed.data.error.code) ? parsed.data.error.code : response.status === 401 ? "AUTH_REQUIRED" : response.status === 404 ? "NOT_FOUND" : "RUNTIME_UNAVAILABLE";
   if (response.status === 401 && !redirected) { redirected = true;host.signIn(host.currentPath(), { automatic: true }); }
   throw new ApiError(response.status, code, message);
  }
  try { return reader.parse(response.body); } catch { throw invalid(); }
 }
 const root = `/v1/app/projects/${encodeURIComponent(project)}/allowed-websites`, scopeQuery = `?expectedOrgId=${encodeURIComponent(orgId)}`;
 return {
  setScopeActive(value: boolean) { if (!value) epoch += 1;active = value; },
  async review() { const value = await call({ method: "GET", path: root + scopeQuery }, ProjectAllowedWebsitesReviewReaderSchema);if (value.orgId !== orgId || value.project !== project) throw invalid();return value; },
  async proposal(proposalId: string) { input(z.string().uuid(), proposalId);const value = await call({ method: "GET", path: `${root}/proposals/${proposalId}${scopeQuery}` }, ProjectAllowedWebsitesProposalReaderSchema);if (value.proposalId !== proposalId) throw invalid();return value; },
  async request(requestId: string) { input(z.string().uuid(), requestId);const value = await call({ method: "GET", path: `${root}/requests/${requestId}${scopeQuery}` }, ProjectAllowedWebsitesResultReaderSchema);
   if (value.kind === "unchanged" || (value.kind === "receipt" ? value.receipt.requestId !== requestId : value.proposalId !== requestId)) throw invalid();return value; },
  async propose(body: Omit<ProjectAllowedWebsitesMutationBody, "expectedOrgId">) {
   const checked = input(ProjectAllowedWebsitesMutationBodySchema, { ...body, expectedOrgId: orgId });
   const value = await call({ method: "POST", path: root + "/proposals", body: checked }, ProjectAllowedWebsitesProposalReaderSchema);if (value.proposalId !== checked.requestId) throw invalid();return value;
  },
  async save(body: Omit<ProjectAllowedWebsitesMutationBody, "expectedOrgId">) {
   const checked = input(ProjectAllowedWebsitesMutationBodySchema, { ...body, expectedOrgId: orgId }), value = await call({ method: "POST", path: root, body: checked }, ProjectAllowedWebsitesResultReaderSchema);
   if (value.kind === "proposal" || (value.kind === "unchanged" ? value.resultRevision !== checked.expectedRevision : value.receipt.requestId !== checked.requestId || !("mode" in value.receipt) || value.receipt.mode !== "direct_narrowing")) throw invalid();return value;
  },
  async decide(proposalId: string, decision: "approve" | "cancel" | "reject", body: Omit<ProjectAllowedWebsitesApprovalBody, "expectedOrgId"> | Omit<ProjectAllowedWebsitesDecisionBody, "expectedOrgId">) {
   input(z.string().uuid(), proposalId);
   const checked = decision === "approve" ? input(ProjectAllowedWebsitesApprovalBodySchema, { ...body, expectedOrgId: orgId }) : input(ProjectAllowedWebsitesDecisionBodySchema, { ...body, expectedOrgId: orgId });
   const value = await call({ method: "POST", path: `${root}/proposals/${proposalId}/${decision}`, body: checked }, ProjectAllowedWebsitesResultReaderSchema);
   if (value.kind !== "receipt" || value.receipt.requestId !== checked.requestId || value.proposalId !== proposalId || value.status !== (decision === "approve" ? "applied" : decision === "cancel" ? "cancelled" : "rejected")) throw invalid();return value;
  },
 };
}
