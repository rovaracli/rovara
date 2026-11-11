import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectDefinitionSchema, orgProjectCatalogKey, projectRevisionKey, projectMetaKey, projectMemberKey } from "@rovara-code/contracts";
import { orgMetaKey, orgMemberKey } from "@agentx/cloud-contracts";
import type { DeveloperApiConfiguration } from "../../packages/broker/src/aws/developer-routes.js";
import { APP_CSRF_HEADER, appCsrfTokenFor } from "../../packages/broker/src/developer/app-csrf.js";
import { createAdminBroker } from "../support/admin-broker.js";
import { seedMembership } from "../support/developer-task-broker.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { TEST_ORG } from "../support/orgs.js";
const CELL = "https://cell.example", WHO = "a".repeat(64), SID = "11111111-1111-4111-8111-111111111111", COOKIE = `__Host-agentx_review_session=${SID}`, NOW = Date.parse("2026-10-29T21:00:00Z"), project = "payments";
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] });vi.setSystemTime(NOW); });afterEach(() => vi.useRealTimers());
async function fixture() {
 const developer: DeveloperApiConfiguration = { issuer: `${CELL}/v1/auth`, env: "staging", signInTableName: "signin", methods: { slack: false, oidc: false, cloud: true }, verifyAccessToken: async () => ({}), channelMembers: async () => ({ ok: true, memberOf: [] }) };
 const audit = capturingAuditDeps(), h = await createAdminBroker({ developer, extra: { cloud: true, audit: audit.audit } });audit.attach(h.db);audit.audit.documentClient = h.db as never;
 function person(role: "owner" | "admin" | "member" = "owner") {
  seedMembership(h.db, WHO, { orgId: TEST_ORG, role });h.db.set({ ...orgMetaKey(TEST_ORG), orgId: TEST_ORG, name: "Company", plan: "team", createdAt: "2026-10-01T00:00:00.000Z", approvalMembershipVersion: 1, approvalTrackingSince: "2026-10-01T00:00:00.000Z" });
  h.db.set({ pk: `DEVELOPER#${WHO}`, sk: "META", developerId: WHO, displayName: "Fixture owner", provider: "cloud" });
  h.db.set({ pk: `SESSION#${SID}`, sk: "META", sessionId: SID, developerId: WHO, amr: "cloud", startedAt: new Date(NOW - 60000).toISOString(), endsAt: NOW / 1000 + 3600, reviewExpiresAt: NOW / 1000 + 3600 });
 }
 person();const definition = ProjectDefinitionSchema.parse({ name: project, revision: 1, repositories: [{ name: "main", url: "https://github.com/acme/web.git", path: "repo/main", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate." });
 h.db.set({ ...orgProjectCatalogKey(TEST_ORG, project), entityType: "PROJECT_CATALOG", name: project, latestRevision: 1 });h.db.set({ ...projectMetaKey(TEST_ORG, project), name: project, status: "active", createdAt: "2026-10-01T00:00:00.000Z", createdBy: WHO });
 h.db.set({ ...projectRevisionKey(TEST_ORG, project, 1), entityType: "PROJECT", definition, registeredBy: WHO, registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-west-2a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" } });
 const headers = { cookie: COOKIE, origin: CELL, [APP_CSRF_HEADER]: appCsrfTokenFor(SID) }, body = { expectedContextDigest: "", expectedOrgId: TEST_ORG, expectedRevision: 1, requestId: randomUUID(), allowedDomains: ["artifacts.acme.dev"] };
 const path = `/v1/web/projects/${project}/allowed-websites`;
 async function call(suffix = "/proposals", method = "POST", payload: unknown = body, override: Record<string, string | undefined> = {}) {
  const url = new URL(path + suffix, CELL), response = await h.handler({ rawPath: url.pathname, rawQueryString: url.search.slice(1), routeKey: "ANY /v1/web/{proxy+}", headers: { ...headers, ...override }, ...(method === "GET" ? {} : { body: JSON.stringify(payload) }), requestContext: { requestId: "cookie-http-transport", http: { method } } });
  return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
 }
 const review = await call(`?expectedOrgId=${TEST_ORG}`, "GET");expect(review.status, JSON.stringify(review.body)).toBe(200);body.expectedContextDigest = String(review.body.contextDigest);
 return { ...h, audit, person, call, body };
}
it("real cookie proposals and approval use the reviewed registrar with separate staff approval", async () => {
 const f = await fixture(), created = await f.call();expect(created.status, JSON.stringify(created.body)).toBe(200);
 const approved = await f.call(`/proposals/${f.body.requestId}/approve`, "POST", { expectedOrgId: TEST_ORG, requestId: randomUUID(), soleOwnerAcknowledged: true });
 expect(approved.status, JSON.stringify(approved.body)).toBe(200);expect(approved.body.status).toBe("applied");expect(f.audit.recordedBy("project.allowed_domains_changed")).toHaveLength(1);
});
it("business request UUID remains nested separately from the gateway tracing requestId", async () => {
 const f = await fixture();expect((await f.call()).status).toBe(200);const requestId = randomUUID();
 const cancelled = await f.call(`/proposals/${f.body.requestId}/cancel`, "POST", { expectedOrgId: TEST_ORG, requestId });expect(cancelled.status).toBe(200);
 expect(cancelled.body.requestId).toBe("cookie-http-transport");expect(cancelled.body.receipt).toMatchObject({ requestId, proposalId: f.body.requestId, state: "cancelled" });
});
for (const override of [{ origin: undefined }, { origin: "https://foreign.example" }, { [APP_CSRF_HEADER]: undefined }, { [APP_CSRF_HEADER]: "wrong" }, { "sec-fetch-site": "cross-site" }, { authorization: "Bearer fixture" }]) it(`real cookie boundary refuses ${JSON.stringify(override)}`, async () => {
 const f = await fixture(), response = await f.call("/proposals", "POST", f.body, override);expect([401, 403]).toContain(response.status);expect(f.db.find(row => row.entityType === "EGRESS_PROPOSAL")).toEqual([]);
});
for (const role of ["admin", "maintainer", "contributor", "viewer", "member", "revoked"] as const) it(`checks the live cookie ${role} for website writes`, async () => {
 const f = await fixture();f.person(role === "admin" ? "admin" : "member");
 if (["maintainer", "contributor", "viewer"].includes(role)) f.db.set({ ...projectMemberKey(TEST_ORG, WHO, project), role: role === "viewer" ? "viewer" : "developer", projectRole: role, ownerKey: WHO, projectName: project, grantId: randomUUID() });
 if (role === "revoked") f.db.delete(orgMemberKey(TEST_ORG, WHO));
 const result = await f.call();expect(result.status, JSON.stringify(result.body)).toBe(role === "admin" || role === "maintainer" ? 200 : 403);
});

it("real cookie status hides foreign-company receipts exactly like missing receipts", async () => {
 const f = await fixture(), requestId = randomUUID(), { projectPk } = await import("@rovara-code/contracts");
 f.db.set({ pk: projectPk(TEST_ORG, project), sk: `EGRESS_PROPOSAL#${requestId}`, orgId: "org_bbbbbbbbbbbbbbbbbbbb", project, by: WHO, entityType: "EGRESS_PROPOSAL", kind: "approval_receipt" });
 const outcomes = [];
 for (const id of [requestId, randomUUID()]) { const response = await f.call(`/requests/${id}?expectedOrgId=${TEST_ORG}`, "GET");expect(response.status).toBe(404);outcomes.push(response.body.error); }
 expect(outcomes[0]).toEqual(outcomes[1]);
});
it("a role removed after proposal creation is rechecked through the same live cookie", async () => {
 const f = await fixture();expect((await f.call()).status).toBe(200);f.db.delete(orgMemberKey(TEST_ORG, WHO));
 const before = f.db.commandNames().filter(name => name === "UpdateCommand").length;
 expect((await f.call(`/proposals/${f.body.requestId}?expectedOrgId=${TEST_ORG}`, "GET")).status).toBe(403);
 expect(f.db.commandNames().filter(name => name === "UpdateCommand")).toHaveLength(before);
});
it("the same cookie cannot submit an old-company review after a live company switch", async () => {
 const f = await fixture(), other = "org_bbbbbbbbbbbbbbbbbbbb" as typeof TEST_ORG;
 seedMembership(f.db, WHO, { orgId: other, role: "owner" });f.db.set({ ...orgMetaKey(other), orgId: other, name: "Other", plan: "team" });
 const result = await f.call();expect(result.status, JSON.stringify(result.body)).toBe(409);expect(f.db.find(row => row.entityType === "EGRESS_PROPOSAL")).toEqual([]);
});

it("real cookie root save narrows the reviewed list and preserves its business receipt UUID", async () => {
 const f = await fixture(), key = projectRevisionKey(TEST_ORG, project, 1), row = f.db.get(key)!;f.db.set({ ...row, definition: { ...(row.definition as Record<string, unknown>), network: { allowedDomains: ["old.acme.dev"] } } });
 const review = await f.call(`?expectedOrgId=${TEST_ORG}`, "GET");expect(review.status).toBe(200);const requestId = randomUUID();
 const result = await f.call("", "POST", { expectedOrgId: TEST_ORG, requestId, expectedRevision: 1, expectedContextDigest: review.body.contextDigest, allowedDomains: [] });
 expect(result.status, JSON.stringify(result.body)).toBe(200);expect(result.body.receipt).toMatchObject({ requestId, mode: "direct_narrowing", resultRevision: 2 });
 expect(f.audit.recordedBy("project.allowed_domains_changed")).toMatchObject([{ facts: { mode: "direct_narrowing" } }]);
});

it("actual cookie responses satisfy the browser-safe review, proposal and receipt readers", async () => {
 const { ProjectAllowedWebsitesReviewReaderSchema, ProjectAllowedWebsitesResultReaderSchema } = await import("@rovara-code/contracts");
 const f = await fixture(), review = await f.call(`?expectedOrgId=${TEST_ORG}`, "GET");
 expect(ProjectAllowedWebsitesReviewReaderSchema.parse(review.body)).toMatchObject({ kind: "review", liveProposal: null });
 const created = await f.call();expect(ProjectAllowedWebsitesResultReaderSchema.parse(created.body)).toMatchObject({ kind: "proposal", proposalId: f.body.requestId });
 const pending = await f.call(`?expectedOrgId=${TEST_ORG}`, "GET");expect(ProjectAllowedWebsitesReviewReaderSchema.parse(pending.body).liveProposal?.proposalId).toBe(f.body.requestId);
 const requestId = randomUUID(), applied = await f.call(`/proposals/${f.body.requestId}/approve`, "POST", { expectedOrgId: TEST_ORG, requestId, soleOwnerAcknowledged: true });
 const receipt = ProjectAllowedWebsitesResultReaderSchema.parse(applied.body);expect(receipt).toMatchObject({ kind: "receipt", status: "applied", receipt: { requestId, mode: "sole_owner_exception" } });expect(receipt).not.toHaveProperty("requestId");
});
it("B33 admin registration cannot widen a Cloud project or write an unaudited revision", async () => {
 const { adminCall } = await import("../support/admin-broker.js");
 const f = await fixture(), key = projectRevisionKey(TEST_ORG, project, 1), record = f.db.get(key) as { definition: Record<string, unknown>; runtimeBinding: unknown };
 const { ownerKeyForSubject } = await import("../../packages/broker/src/aws/lambda.js");
 const operator = ownerKeyForSubject("https://identity.example.test", "admin-subject");
 f.db.set({ ...projectMemberKey(TEST_ORG, operator, project), entityType: "MEMBERSHIP", ownerKey: operator, projectName: project, role: "administrator" });
 const before = structuredClone(f.db.find(item => item.pk === key.pk));
 const reply = await adminCall(f.handler, { method: "POST", path: "/v1/admin/projects", body: { definition: { ...record.definition, revision: 2, network: { allowedDomains: ["bypass.acme.dev"] } }, runtimeBinding: record.runtimeBinding } });
 expect(reply.status, JSON.stringify(reply.body)).toBe(403);expect(reply.body.error).toMatchObject({ code: "FORBIDDEN" });expect(reply.body.error).toHaveProperty("message", expect.stringContaining("proposal"));
 expect(f.db.find(item => item.pk === key.pk)).toEqual(before);expect(f.db.get(orgProjectCatalogKey(TEST_ORG, project))?.latestRevision).toBe(1);expect(f.audit.recordedBy("project.allowed_domains_changed")).toHaveLength(0);
});
