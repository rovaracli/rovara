import { AppMeResponseReaderSchema, AppOrgMembersResponseReaderSchema, AppProjectDetailSchema } from "@agentx/contracts/web";
import type { ApiRequest, ApiResponse } from "../../../../packages/ui/src/host.js";

export const identity = AppMeResponseReaderSchema.parse({ developer: { id: "a".repeat(64), name: "Ana", orgRole: "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
export const members = AppOrgMembersResponseReaderSchema.parse({ members: [
 { developerId: "a".repeat(64), name: "Ana", role: "owner" },
 { developerId: "b".repeat(64), name: "Priya", role: "admin" },
 { developerId: "c".repeat(64), name: "Sam", role: "member" },
] });
export const settings = { companyId: identity.org.orgId, version: 3, settings: { instructions: [{ text: "Review changes before merging", priority: "required" }], start: { allow: true }, websiteCeiling: { mode: "listed", hosts: ["docs.example.com"] } } };
export const pendingSettings = { ...settings, pending: { changeId: "change-1", proposedBy: "b".repeat(64), proposedAt: "2026-11-21T10:00:00Z", expiresAt: "2026-11-22T10:00:00Z", settings: { instructions: [{ text: "Review every change", priority: "required" }] } } };
export const audit = { records: [{ id: "event-1", source: "cloud", at: "2026-11-21T10:00:00Z", actor: { developerId: "a".repeat(64), name: "Ana" }, action: "Updated company rules", subject: "Company policy", outcome: "recorded" }], engine: { state: "incomplete", message: "Some engine records could not be read." } };
export const project = AppProjectDetailSchema.parse({ name: "payments", description: "Payment service", status: "active", latestRevision: 3, repositories: [{ name: "api", fullName: "acme/payments-api", defaultBranch: "main" }], myRole: "maintainer", setup: { status: "ready" }, settings: { setupCommands: [], testCommands: [], devcontainer: null, allowedDomains: [] }, createdAt: "2026-11-01T00:00:00Z", createdBy: { developerId: "a".repeat(64), name: "Ana" } });
// 401 / 403 / 404 carry an access code; any other status (503, 0 = offline) is a transient failure with a non-access code (DEC 254zzz324).
export const refused = (status = 403): ApiResponse => ({ status, body: { error: { code: [401, 403, 404].includes(status) ? "FORBIDDEN" : "RUNTIME_UNAVAILABLE", message: "Read refused" } } });
export function reply(request: ApiRequest): ApiResponse {
 if (request.method !== "GET") throw new Error("A page attempted a write the test did not expect");
 const path = request.path.split("?")[0];
 if (path === "/v1/app/me") return { status: 200, body: identity };
 if (path === "/v1/app/org/members") return { status: 200, body: members };
 if (path === "/v1/app/org/settings") return { status: 200, body: pendingSettings };
 if (path === "/v1/app/company/audit") return { status: 200, body: audit };
 if (path === "/v1/app/projects/payments") return { status: 200, body: project };
 // Everything else the real admin pages read (upkeep, knowledge switch, addresses, spending, projects' people ...) is not served here: Cloud's fixed answer.
 return { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "not connected" } } };
}

/** All fixture payloads pass the same readers as the mounted entry; no network. */
export function sceneRoute(scene: string) {
 return scene.startsWith("working-branches-") ? "/app/admin/projects/payments?tab=working-branches#working-branches"
  : scene.startsWith("company-audit-") ? "/app/admin/audit"
  : scene.startsWith("company-settings-") || scene.startsWith("company-upkeep-") ? "/app/admin/settings?tab=pending#pending-change" : "/app/admin";
}
export function sceneResponder(scene: string, phase: () => boolean = () => false) {
 const kind = scene.startsWith("working-branches-") ? "working-branches" : scene.startsWith("company-audit-") ? "company-audit" : scene.startsWith("company-settings-") ? "company-settings" : scene.startsWith("company-upkeep-") ? "company-upkeep" : "company-home";
 const state = scene.slice(kind.length + 1);
 return async (request: ApiRequest): Promise<ApiResponse> => {
  if (request.method !== "GET") throw new Error("Capture attempted a mutation");
  if (request.path === "/v1/app/me") return reply(request);
  // Upkeep has no independent read or lifecycle: it stays excluded on settings.
  if (kind === "company-upkeep") return { status: 200, body: settings };
  if (state === "loading" || state === "loading-slow") return new Promise(() => undefined);
  if (state === "stale" && phase()) return refused(503);
  if (state === "read-failed" || state === "offline") return refused(state === "offline" ? 0 : 503);
  if (state === "access-lost" || state === "restricted") return refused();
  if (state === "empty") return { status: 200, body: kind === "company-home" ? { members: [] } : kind === "company-audit" ? { records: [], engine: { state: "connected" } } : kind === "working-branches" ? { ...project } : { companyId: identity.org.orgId, version: 3, settings: { instructions: [] } } };
  if (state === "unknown" || state === "partial" || state === "missing-branch") {
   const withoutSaved = { ...project };
   return { status: 200, body: kind === "company-home" ? {} : kind === "company-settings" ? { companyId: identity.org.orgId, version: 3, settings: {} } : kind === "working-branches" ? withoutSaved : { ...audit, engine: { state: "unavailable" } } };
  }
  if (kind === "company-settings") return { status: 200, body: state === "server-pending" ? pendingSettings : settings };
  return reply(request);
 };
}
