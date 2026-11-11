import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { orgMetaKey, orgSlackTeamKey, slackTeamOrgKey } from "@agentx/cloud-contracts";
import { projectMetaKey, slackBindingKey } from "@rovara-code/contracts";
import type { DeveloperApiConfiguration } from "../../packages/broker/src/aws/developer-routes.js";
import { APP_CSRF_HEADER, appCsrfTokenFor } from "../../packages/broker/src/developer/app-csrf.js";
import { createAdminBroker } from "../support/admin-broker.js";
import { seedMembership } from "../support/developer-task-broker.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { TEST_ORG } from "../support/orgs.js";
const CELL = "https://cell.example", WHO = "a".repeat(64), SID = "11111111-1111-4111-8111-111111111111", teamId = "T0123456789", channelId = "C0123456789", root = "/v1/web/projects/payments/slack-channel";
async function fixture() {
 let tokenChecks = 0;const developer: DeveloperApiConfiguration = { issuer: `${CELL}/v1/auth`, env: "staging", signInTableName: "signin", methods: { slack: false, oidc: false, cloud: true }, verifyAccessToken: async () => { tokenChecks++;return {}; }, channelMembers: async () => { throw new Error("No Slack API calls"); } };
 const audit = capturingAuditDeps(), h = await createAdminBroker({ developer, extra: { cloud: true, audit: audit.audit } });audit.attach(h.db);audit.audit.documentClient = h.db as never;
 seedMembership(h.db, WHO, { orgId: TEST_ORG, role: "owner" });h.db.set({ ...orgMetaKey(TEST_ORG), orgId: TEST_ORG, name: "Company", plan: "team" });
 h.db.set({ pk: `DEVELOPER#${WHO}`, sk: "META", developerId: WHO, provider: "cloud", revoked: false });h.db.set({ pk: `SESSION#${SID}`, sk: "META", sessionId: SID, developerId: WHO, amr: "cloud", startedAt: new Date(Date.now() - 60000).toISOString(), endsAt: Date.now() / 1000 + 3600, reviewExpiresAt: Date.now() / 1000 + 3600 });
 h.db.set({ ...projectMetaKey(TEST_ORG, "payments"), name: "payments", status: "active", createdAt: "2026-10-01T00:00:00Z", createdBy: WHO, archiveRevision: 0 });h.db.set({ ...orgSlackTeamKey(TEST_ORG, teamId), teamId });h.db.set({ ...slackTeamOrgKey(teamId), orgId: TEST_ORG, teamId });h.db.set({ ...slackBindingKey(TEST_ORG, teamId, channelId), teamId, channelId, projectName: "payments", updatedAt: "2026-10-01T00:00:00Z" });
 async function call(path: string, method = "GET", body?: unknown, override: Record<string, string | undefined> = {}) {
  const url = new URL(root + path, CELL), headers = { cookie: `__Host-agentx_review_session=${SID}`, origin: CELL, [APP_CSRF_HEADER]: appCsrfTokenFor(SID), ...override };
  const response = await h.handler({ version: "2.0", rawPath: url.pathname, rawQueryString: url.search.slice(1), routeKey: "ANY /v1/web/{proxy+}", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), requestContext: { requestId: "gateway-trace", http: { method } } });return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
 }
 return { ...h, audit, call, tokenChecks: () => tokenChecks };
}
it("reads stored links then reviews and atomically unlinks through the real cookie path", async () => {
 const f = await fixture();const listed = await f.call(`/links?expectedOrgId=${TEST_ORG}`);expect(listed.status, JSON.stringify(listed.body)).toBe(200);expect(listed.body.bindings).toMatchObject([{ teamId, channelId }]);
 const review = await f.call(`/review?expectedOrgId=${TEST_ORG}&teamId=${teamId}&channelId=${channelId}`);expect(review.status).toBe(200);
 const requestId = randomUUID(), body = { expectedOrgId: TEST_ORG, requestId, teamId, channelId, expectedContextDigest: review.body.contextDigest };
 const unlinked = await f.call("/unbind", "POST", body);expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(200);expect(unlinked.body.receipt).toMatchObject({ requestId, operation: "unbind", outcome: { removed: true } });expect(unlinked.body.requestId).toBe("gateway-trace");
 const status = await f.call(`/requests/${requestId}?expectedOrgId=${TEST_ORG}`);expect(status.status).toBe(200);expect(status.body.receipt).toMatchObject({ requestId });expect(f.audit.recordedBy("slack_channel.unbound")).toHaveLength(1);
});
it("refuses cookie unbind without CSRF and bearer reads before token verification", async () => {
 const f = await fixture();expect((await f.call("/unbind", "POST", {}, { [APP_CSRF_HEADER]: undefined })).status).toBe(403);
 const response = await f.handler({ version: "2.0", rawPath: "/v1/app/projects/payments/slack-channel/links", headers: { authorization: "Bearer synthetic" }, requestContext: { http: { method: "GET" } } });expect(response.statusCode).toBe(403);expect(f.tokenChecks()).toBe(0);
 expect(f.db.get(slackBindingKey(TEST_ORG, teamId, channelId))).toBeDefined();
});
it("B34 real cookie proposes then explicitly approves a sole-owner bind with CSRF and no bearer alias", async () => {
 const f = await fixture();f.db.delete(slackBindingKey(TEST_ORG, teamId, channelId));
 f.db.set({ ...orgMetaKey(TEST_ORG), orgId: TEST_ORG, name: "Company", plan: "team", createdAt: "2026-10-01T00:00:00Z", approvalMembershipVersion: 1, approvalTrackingSince: "2026-10-01T00:00:00Z" });
 const review = await f.call(`/review?expectedOrgId=${TEST_ORG}&teamId=${teamId}&channelId=${channelId}`), proposalId = randomUUID();
 const body = { expectedOrgId: TEST_ORG, requestId: proposalId, teamId, channelId, expectedContextDigest: review.body.contextDigest };
 expect((await f.call("/proposals", "POST", body, { [APP_CSRF_HEADER]: undefined })).status).toBe(403);
 const proposed = await f.call("/proposals", "POST", body);expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);expect(proposed.body.proposal).toMatchObject({ proposalId, state: "pending" });expect(f.db.get(slackBindingKey(TEST_ORG, teamId, channelId))).toBeUndefined();
 const live = await f.call(`/proposals/current?expectedOrgId=${TEST_ORG}`);expect(live.status).toBe(200);expect(live.body.proposal).toMatchObject({ proposalId });
 const response = await f.handler({ version: "2.0", rawPath: `/v1/app/projects/payments/slack-channel/proposals/${proposalId}/approve`, headers: { authorization: "Bearer synthetic" }, requestContext: { http: { method: "POST" } } });expect(response.statusCode).toBe(403);expect(f.tokenChecks()).toBe(0);
 const requestId = randomUUID(), approved = await f.call(`/proposals/${proposalId}/approve`, "POST", { expectedOrgId: TEST_ORG, requestId });expect(approved.status, JSON.stringify(approved.body)).toBe(200);expect(approved.body.receipt).toMatchObject({ requestId, operation: "bind", outcome: { changed: true } });
 expect(f.audit.recordedBy("slack_channel.bound")).toMatchObject([{ facts: { mode: "sole_owner_exception", proposalId } }]);
});

it("B35 real cookie cancels a pending proposal with CSRF and exposes only a safe decision receipt", async () => {
 const f = await fixture();f.db.delete(slackBindingKey(TEST_ORG, teamId, channelId));
 const review = await f.call(`/review?expectedOrgId=${TEST_ORG}&teamId=${teamId}&channelId=${channelId}`), proposalId = randomUUID();
 expect((await f.call("/proposals", "POST", { expectedOrgId: TEST_ORG, requestId: proposalId, teamId, channelId, expectedContextDigest: review.body.contextDigest })).status).toBe(200);
 const requestId = randomUUID(), body = { expectedOrgId: TEST_ORG, requestId };
 expect((await f.call(`/proposals/${proposalId}/cancel`, "POST", body, { [APP_CSRF_HEADER]: undefined })).status).toBe(403);
 const response = await f.handler({ version: "2.0", rawPath: `/v1/app/projects/payments/slack-channel/proposals/${proposalId}/cancel`, headers: { authorization: "Bearer synthetic" }, requestContext: { http: { method: "POST" } } });expect(response.statusCode).toBe(403);expect(f.tokenChecks()).toBe(0);
 const cancelled = await f.call(`/proposals/${proposalId}/cancel`, "POST", body);expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
 expect(cancelled.body).toMatchObject({ kind: "decision", orgId: TEST_ORG, project: "payments", decision: { requestId, proposalId, state: "cancelled" } });
 expect(JSON.stringify(cancelled.body)).not.toMatch(/bodyHash|indexExpiresAt|SLACK_BINDING_PROPOSAL/);
 expect((await f.call(`/proposals/current?expectedOrgId=${TEST_ORG}`)).body.proposal).toBeNull();
 const status = await f.call(`/decisions/${requestId}?expectedOrgId=${TEST_ORG}`);expect(status.status).toBe(200);expect(status.body.decision).toEqual(cancelled.body.decision);
 expect((await f.call(`/proposals/${proposalId}?expectedOrgId=${TEST_ORG}`)).body.proposal).toMatchObject({ state: "cancelled", decidedBy: WHO });
 expect(f.audit.recordedBy("slack_channel.cancelled")).toHaveLength(1);expect(f.db.get(slackBindingKey(TEST_ORG, teamId, channelId))).toBeUndefined();
});

it("B35 another live admin rejects through the real cookie path and the requester cannot reject", async () => {
 const f = await fixture();f.db.delete(slackBindingKey(TEST_ORG, teamId, channelId));
 const review = await f.call(`/review?expectedOrgId=${TEST_ORG}&teamId=${teamId}&channelId=${channelId}`), proposalId = randomUUID();
 expect((await f.call("/proposals", "POST", { expectedOrgId: TEST_ORG, requestId: proposalId, teamId, channelId, expectedContextDigest: review.body.contextDigest })).status).toBe(200);
 expect((await f.call(`/proposals/${proposalId}/reject`, "POST", { expectedOrgId: TEST_ORG, requestId: randomUUID() })).status).toBe(403);
 const other = "b".repeat(64), sid = randomUUID();seedMembership(f.db, other, { orgId: TEST_ORG, role: "admin" });
 f.db.set({ pk: `DEVELOPER#${other}`, sk: "META", developerId: other, provider: "cloud", revoked: false });f.db.set({ pk: `SESSION#${sid}`, sk: "META", sessionId: sid, developerId: other, amr: "cloud", startedAt: new Date(Date.now() - 60000).toISOString(), endsAt: Date.now() / 1000 + 3600, reviewExpiresAt: Date.now() / 1000 + 3600 });
 const requestId = randomUUID(), headers = { cookie: `__Host-agentx_review_session=${sid}`, [APP_CSRF_HEADER]: appCsrfTokenFor(sid) };
 const rejected = await f.call(`/proposals/${proposalId}/reject`, "POST", { expectedOrgId: TEST_ORG, requestId }, headers);expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);expect(rejected.body.decision).toMatchObject({ requestId, proposalId, state: "rejected" });
 expect((await f.call(`/decisions/${requestId}?expectedOrgId=${TEST_ORG}`)).status).toBe(404);expect((await f.call(`/decisions/${requestId}?expectedOrgId=${TEST_ORG}`, "GET", undefined, headers)).status).toBe(200);
 expect(f.audit.recordedBy("slack_channel.rejected")).toMatchObject([{ actor: { kind: "member", id: other } }]);expect(f.db.get(slackBindingKey(TEST_ORG, teamId, channelId))).toBeUndefined();
});
