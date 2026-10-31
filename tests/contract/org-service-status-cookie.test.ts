import { expect, it } from "vitest";
import { WEB_API_RUNTIME_PROFILE_ID, orgMetaKey } from "@agentx/contracts";
import { createAdminBroker } from "../support/admin-broker.js";
import { seedMembership } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { e2eRegisteredRuntimeKey } from "../../packages/broker/src/aws/e2e-runtime-readiness.js";
const person = "a".repeat(64), sid = "11111111-1111-4111-8111-111111111111", cell = "https://cell.example", catalog = "private-catalog";
async function fixture() {
 const h = await createAdminBroker({ developer: { issuer: `${cell}/v1/auth`, env: "test", signInTableName: "signin", methods: { slack: false, oidc: false, cloud: true }, verifyAccessToken: async () => ({}), channelMembers: async () => { throw new Error("No Slack calls"); } }, extra: { cloud: true, e2eFeatureRuntimeCatalogId: catalog } });
 seedMembership(h.db, person, { orgId: TEST_ORG, role: "owner" });h.db.set({ ...orgMetaKey(TEST_ORG), orgId: TEST_ORG, name: "Company", plan: "team" });h.db.set({ pk: `DEVELOPER#${person}`, sk: "META", developerId: person, provider: "cloud", revoked: false });h.db.set({ pk: `SESSION#${sid}`, sk: "META", sessionId: sid, developerId: person, amr: "cloud", startedAt: new Date(Date.now() - 60000).toISOString(), endsAt: Date.now() / 1000 + 3600, reviewExpiresAt: Date.now() / 1000 + 3600 });
 const call = async () => { const path = "/v1/web/org/service-status", response = await h.handler({ version: "2.0", routeKey: "ANY /v1/web/{proxy+}", rawPath: path, rawQueryString: `expectedOrgId=${TEST_ORG}`, headers: { cookie: `__Host-agentx_review_session=${sid}`, "sec-fetch-site": "same-origin" }, requestContext: { requestId: "trace", http: { method: "GET" } } });expect(response).toHaveProperty("headers.cache-control", "no-store");return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> }; };
 return { ...h, call };
}
it("B35 real cookie reads only coarse stored runtime evidence", async () => {
 const f = await fixture();f.db.set({ ...e2eRegisteredRuntimeKey(catalog, WEB_API_RUNTIME_PROFILE_ID, "web"), state: "READY", qualifiedAt: new Date(Date.now() - 86400000).toISOString(), expiresAt: new Date(Date.now() + 72 * 3600000).toISOString(), endpoint: "https://secret.invalid", secret: "private-value" });
 const result = await f.call();expect(result.status, JSON.stringify(result.body)).toBe(200);expect(result.body).toMatchObject({ orgId: TEST_ORG, checks: [{ kind: "web", state: "ready", observation: "qualified" }, { kind: "api", observation: "unknown", reason: "not_observed" }] });expect(JSON.stringify(result.body)).not.toMatch(/private-catalog|private-value|secret.invalid|qualifiedAt|profileId|renewCommand/);
});
it("B35 real reader distinguishes a malformed stored row from an absent runtime", async () => {
 const f = await fixture();f.db.set({ ...e2eRegisteredRuntimeKey(catalog, WEB_API_RUNTIME_PROFILE_ID, "web"), state: "READY", qualifiedAt: 123, expiresAt: "poison" });
 const result = await f.call();expect(result.status).toBe(200);expect(result.body).toMatchObject({ checks: [{ kind: "web", observation: "unknown", reason: "invalid_evidence" }, { kind: "api", observation: "unknown", reason: "not_observed" }] });
});
