// Invite mutations deliberately do not inherit generic automatic network/429 POST retries.
import type { InviteCreateReceiptSchema } from "@agentx/contracts/web";
import { ReviewedInviteCreateBodySchema, ReviewedInviteCreateResponseSchema, AgentXErrorCodeSchema, AppOrgInviteStatusSchema, OrgIdSchema, OrgInvitePublicIdSchema, RevokeOrganizationInviteBodySchema, RevokeOrganizationInviteResponseSchema } from "@agentx/contracts/web";
import type { z } from "zod";
import type { ApiRequest, ApiResponse, AppHost } from "../host.js";
import { ApiError } from "./errors.js";
export type InviteCreateReceipt = z.infer<typeof InviteCreateReceiptSchema>;
export type InviteStatus = z.infer<typeof AppOrgInviteStatusSchema>;
function unreadable() { return new ApiError(502, "INVALID_RESPONSE", "The invite response could not be verified."); }
export function createInviteAdminApi(host: AppHost, orgId: string) {
 let redirected = false, scopeActive = true;
 function path(inviteId: string) {
  if (!OrgIdSchema.safeParse(orgId).success || !OrgInvitePublicIdSchema.safeParse(inviteId).success) throw new ApiError(400, "CONFIG_INVALID", "Check a valid company invite.");
  return `/v1/app/org/invites/${inviteId}`;
 }
 async function once(request: ApiRequest) {
  let response: ApiResponse;
  try { response = await host.transport.request(request); }catch (error) {
   if (error instanceof ApiError) {
    if (error.status === 401 && scopeActive && !redirected) { redirected = true;host.signIn(host.currentPath(), { automatic: true }); }
    const code = AgentXErrorCodeSchema.safeParse(error.code);throw new ApiError(error.status, code.success ? code.data : "REQUEST_FAILED", "The invite action could not be completed.");
   }
   throw new ApiError(0, "NETWORK_ERROR", "The invite action's outcome could not be confirmed.");
  }
  if (response.status === 401 && scopeActive && !redirected) { redirected = true;host.signIn(host.currentPath(), { automatic: true }); }
  if (response.status === 202) throw new ApiError(409, "PENDING", "The invite action is pending. Check its status.");
  if (response.status < 200 || response.status >= 300) {
   const body = response.body as { error?: { code?: unknown } } | null, code = AgentXErrorCodeSchema.safeParse(body?.error?.code);
   throw new ApiError(response.status, code.success ? code.data : response.status === 429 ? "TOO_MANY_REQUESTS" : "REQUEST_FAILED", "The invite action could not be completed.");
  }
  return response.body;
 }
 function validScope() { if (!OrgIdSchema.safeParse(orgId).success) throw new ApiError(400, "CONFIG_INVALID", "Check a valid company invite."); }
 // Broker-configured cloud join sites may differ from the cookie console origin.
 function safeLink(value: string) {
  try { const url = new URL(value);return (url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost")) && url.username === "" && url.password === "" && url.pathname.endsWith("/join") && /^(?:#|\?)invite=[A-Za-z0-9_-]{43}$/.test(url.search + url.hash); } catch { return false; }
 }
 return {
  async create(body: z.input<typeof ReviewedInviteCreateBodySchema>) {
   validScope();const parsed = ReviewedInviteCreateBodySchema.safeParse(body);if (!parsed.success) throw new ApiError(400, "CONFIG_INVALID", "Review a valid invite destination and company role.");
   const value = ReviewedInviteCreateResponseSchema.safeParse(await once({ method: "POST", path: "/v1/app/org/invites/reviewed", body: parsed.data }));
   if (!value.success || value.data.receipt.orgId !== orgId || value.data.receipt.requestId !== parsed.data.requestId || value.data.receipt.role !== parsed.data.role || (value.data.inviteUrl !== undefined && !safeLink(value.data.inviteUrl))) throw unreadable();return value.data;
  },
  async creationReceipt(requestId: string) {
   validScope();if (!OrgInvitePublicIdSchema.safeParse(requestId).success) throw new ApiError(400, "CONFIG_INVALID", "Check a valid creation request.");
   const value = ReviewedInviteCreateResponseSchema.safeParse(await once({ method: "GET", path: "/v1/app/org/invites/requests/" + requestId }));
   if (!value.success || value.data.inviteUrl !== undefined || value.data.receipt.orgId !== orgId || value.data.receipt.requestId !== requestId) throw unreadable();return { receipt: value.data.receipt };
  },
  setScopeActive(active: boolean) { scopeActive = active; },
  async status(inviteId: string): Promise<InviteStatus> {
   const value = AppOrgInviteStatusSchema.safeParse(await once({ method: "GET", path: path(inviteId) }));
   if (!value.success || value.data.orgId !== orgId || value.data.inviteId !== inviteId) throw unreadable();return value.data;
  },
  async revoke(inviteId: string, body: { requestId: string; expectedRevision: number }) {
   const endpoint = path(inviteId), parsed = RevokeOrganizationInviteBodySchema.safeParse(body);
   if (!parsed.success || !Number.isSafeInteger(parsed.data.expectedRevision) || parsed.data.expectedRevision >= Number.MAX_SAFE_INTEGER) throw new ApiError(400, "CONFIG_INVALID", "Review a valid invite revision before revoking it.");
   const value = RevokeOrganizationInviteResponseSchema.safeParse(await once({ method: "POST", path: endpoint + "/revoke", body: parsed.data }));
   if (!value.success || value.data.inviteId !== inviteId || value.data.revision !== parsed.data.expectedRevision + 1 || !Number.isSafeInteger(value.data.revision)) throw unreadable();return value.data;
  },
 };
}
