import { readProjectAllowedDomainsReview } from "../../packages/broker/src/org/project-allowed-domains.js";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { orgProjectCatalogKey, projectMetaKey, projectRevisionKey, type OrgId } from "@rovara-code/contracts";
import { ProjectDefinitionSchema } from "@agentx/cloud-contracts";
import { developerOrgKey, orgMemberKey, orgMetaKey } from "@agentx/cloud-contracts";
import { projectAllowedDomainsHttp } from "../../packages/broker/src/org/project-allowed-domains-http.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
const orgId = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId, by = "a".repeat(64), project = "payments";
async function fixture() {
 const db = new FakeDynamoDb(), audit = capturingAuditDeps({ db });audit.audit.documentClient = db as unknown as typeof audit.audit.documentClient;
 db.set({ ...orgMetaKey(orgId), orgId, createdAt: "2026-10-01T00:00:00.000Z", approvalMembershipVersion: 1, approvalTrackingSince: "2026-10-01T00:00:00.000Z" });db.set({ ...orgMemberKey(orgId, by), orgId, developerId: by, role: "owner" });db.set({ ...developerOrgKey(by), orgId, role: "owner" });db.set({ pk: `DEVELOPER#${by}`, sk: "META", developerId: by, revoked: false });
 db.set({ ...projectMetaKey(orgId, project), name: project, status: "active", createdAt: "2026-10-01T00:00:00.000Z", createdBy: by });
 const definition = ProjectDefinitionSchema.parse({ name: project, revision: 1, repositories: [{ name: "main", url: "https://github.com/acme/web.git", path: "repo/main", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate." });
 db.set({ ...projectRevisionKey(orgId, project, 1), definition, runtimeBinding: { deploymentMode: "ec2-ebs", launchTemplateId: "lt-test" }, registeredBy: by, registeredAt: "2026-10-01T00:00:00.000Z" });db.set({ ...orgProjectCatalogKey(orgId, project), name: project, latestRevision: 1 });
 const deps = { documentClient: db, tableName: "state", signInTableName: "signin", now: () => Date.parse("2026-10-29T21:00:00.000Z"), audit: audit.audit }, caller = { developerId: by, orgId, browserSession: true as const };
 const review = await readProjectAllowedDomainsReview(deps, { orgId, project, by });
 const body = { expectedContextDigest: review.contextDigest, expectedOrgId: orgId, requestId: randomUUID(), expectedRevision: 1, allowedDomains: ["xn--bcher-kva.de"] };
 const propose = (input: unknown = body) => projectAllowedDomainsHttp(deps, caller, project, { operation: "propose", body: input });
 return { db, deps, caller, body, propose };
}
it("refuses non-browser callers and stale company binding before any existence read", async () => {
 const f = await fixture(), before = f.db.commandNames().length;
 await expect(projectAllowedDomainsHttp(f.deps, { developerId: by, orgId }, project, { operation: "propose", body: f.body })).rejects.toMatchObject({ code: "FORBIDDEN" });
 await expect(f.propose({ ...f.body, expectedOrgId: "org_bbbbbbbbbbbbbbbbbbbb" })).rejects.toMatchObject({ code: "CHANGE_STALE" });expect(f.db.commandNames()).toHaveLength(before);
});
it("returns a bounded browser projection with raw punycode and no storage fields", async () => {
 const f = await fixture(), result = await f.propose();expect(result).toMatchObject({ proposalId: f.body.requestId, status: "pending", beforeDomains: [], afterDomains: ["xn--bcher-kva.de"] });
 expect(result).not.toHaveProperty("pk");expect(result).not.toHaveProperty("bodyHash");expect(result).not.toHaveProperty("baseDefinitionDigest");
});
it("mutation attempts stop at ten while an owned valid UUID replay stays status-only", async () => {
 const f = await fixture();await f.propose();
 for (let i = 1; i < 10; i += 1) await expect(f.propose({ ...f.body, requestId: randomUUID() })).rejects.toMatchObject({ code: "CHANGE_STALE" });
 await expect(f.propose({ ...f.body, requestId: randomUUID() })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
 const count = f.db.transactions().length;expect((await f.propose()).status).toBe("pending");expect(f.db.transactions()).toHaveLength(count);
});
it("DB-only status reads stop at thirty per person per minute", async () => {
 const f = await fixture();await f.propose();const request = { operation: "status" as const, proposalId: f.body.requestId, expectedOrgId: orgId };
 for (let i = 0; i < 30; i += 1) expect((await projectAllowedDomainsHttp(f.deps, f.caller, project, request)).status).toBe("pending");
 await expect(projectAllowedDomainsHttp(f.deps, f.caller, project, request)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
});
it("a member without a maintainer grant cannot consume mutation budget or inspect proposal existence", async () => {
 const f = await fixture();f.db.set({ ...orgMemberKey(orgId, by), orgId, developerId: by, role: "member" });f.db.set({ ...developerOrgKey(by), orgId, role: "member" });
 await expect(f.propose()).rejects.toMatchObject({ code: "FORBIDDEN" });expect(f.db.commandNames()).not.toContain("UpdateCommand");
});

it("the real dispatcher refuses bearer website routes before authentication or existence reads", async () => {
 const { loadSlackBroker } = await import("../support/slack-broker.js");await loadSlackBroker();
 const { routeDeveloperRequest } = await import("../../packages/broker/src/aws/developer-routes.js");
 const f = await fixture(), before = f.db.commandNames().length;
 for (const [method, path] of [["POST", `/v1/app/projects/${project}/allowed-websites/proposals`], ["GET", `/v1/app/projects/${project}/allowed-websites/proposals/${randomUUID()}`]]) {
  const request = { method, headers: { authorization: "Bearer never-authenticate-this" }, body: JSON.stringify(f.body) };
  await expect(routeDeveloperRequest({ documentClient: f.db } as never, request as never, new URL(path!, "https://app.example.test"))).rejects.toMatchObject({ code: "FORBIDDEN" });
 }
 expect(f.db.commandNames()).toHaveLength(before);
});

it("browser cancellation and owned request status are audited and status-only on replay", async () => {
 const f = await fixture();await f.propose();const body = { expectedOrgId: orgId, requestId: randomUUID(), reason: "Not needed" };
 const request = { operation: "cancel" as const, proposalId: f.body.requestId, body };
 expect((await projectAllowedDomainsHttp(f.deps, f.caller, project, request)).status).toBe("cancelled");
 const count = f.db.transactions().length;await projectAllowedDomainsHttp(f.deps, f.caller, project, request);expect(f.db.transactions()).toHaveLength(count);
 const result = await projectAllowedDomainsHttp(f.deps, f.caller, project, { operation: "request-status", expectedOrgId: orgId, requestId: body.requestId });
 expect(result).toMatchObject({ proposalId: f.body.requestId, status: "cancelled", receipt: { requestId: body.requestId, state: "cancelled" } });expect(result).not.toHaveProperty("bodyHash");
});
it("approval constructs the exact registration and proof on the server and rejects client definition edits", async () => {
 const f = await fixture();await f.propose();const { commitRegisteredProjectAllowedDomains } = await import("../../packages/broker/src/org/project-allowed-domains.js");
 let calls = 0;
 const deps = { ...f.deps, registerApproved: async (actor: { orgId: OrgId; ownerKey: string }, value: { definition: unknown; runtimeBinding: unknown }, proof: unknown) => {
  calls += 1;return commitRegisteredProjectAllowedDomains(f.deps, { orgId: actor.orgId, project, by: actor.ownerKey, definition: value.definition, runtimeBinding: value.runtimeBinding, proof });
 } };
 const body = { expectedOrgId: orgId, requestId: randomUUID(), soleOwnerAcknowledged: true };
 await expect(projectAllowedDomainsHttp(deps, f.caller, project, { operation: "approve", proposalId: f.body.requestId, body: { ...body, definition: { network: { allowedDomains: ["unreviewed.acme.dev"] } } } })).rejects.toMatchObject({ code: "CONFIG_INVALID" });expect(calls).toBe(0);
 expect((await projectAllowedDomainsHttp(deps, f.caller, project, { operation: "approve", proposalId: f.body.requestId, body })).status).toBe("applied");expect(calls).toBe(1);
 const count = f.db.transactions().length;await projectAllowedDomainsHttp(deps, f.caller, project, { operation: "approve", proposalId: f.body.requestId, body });expect(f.db.transactions()).toHaveLength(count);
});
it("owned request status hides a different actor's receipt exactly like absence", async () => {
 const f = await fixture();await f.propose();const requestId = randomUUID();
 const { projectPk } = await import("@rovara-code/contracts");f.db.set({ pk: projectPk(orgId, project), sk: `EGRESS_PROPOSAL#${requestId}`, entityType: "EGRESS_PROPOSAL", kind: "decision_receipt", orgId, project, by: "b".repeat(64) });
 for (const id of [requestId, randomUUID()]) await expect(projectAllowedDomainsHttp(f.deps, f.caller, project, { operation: "request-status", expectedOrgId: orgId, requestId: id })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("the trusted cookie dispatcher serves audited cancellation and owned request status", async () => {
 const { loadSlackBroker } = await import("../support/slack-broker.js");await loadSlackBroker();const { routeDeveloperRequest } = await import("../../packages/broker/src/aws/developer-routes.js");
 const f = await fixture();await f.propose();const requestId = randomUUID(), deps = { ...f.deps, developer: { signInTableName: "signin", issuer: "https://app.example.test" } };
 // The dispatcher holds a caller with no company role to the Auditor allow-list (I2); a real caller always has one.
 const auth = { caller: { ...f.caller, orgRole: "owner" as const }, csrf: "trusted-cookie-fixture" };
 const result = await routeDeveloperRequest(deps as never, { method: "POST", headers: {}, body: JSON.stringify({ requestId, expectedOrgId: orgId }) } as never, new URL(`/v1/app/projects/${project}/allowed-websites/proposals/${f.body.requestId}/cancel`, "https://app.example.test"), auth as never);
 expect(result).toMatchObject({ status: "cancelled", receipt: { requestId } });
 const status = await routeDeveloperRequest(deps as never, { method: "GET", headers: {} } as never, new URL(`/v1/app/projects/${project}/allowed-websites/requests/${requestId}?expectedOrgId=${orgId}`, "https://app.example.test"), auth as never);
 expect(status).toMatchObject({ status: "cancelled", receipt: { requestId } });
});
it("the shared company mutation budget caps attempts across different live people", async () => {
 const f = await fixture(), actors = Array.from({ length: 7 }, (_, i) => (i + 2).toString(16).repeat(64));
 for (const id of actors) { f.db.set({ ...orgMemberKey(orgId, id), orgId, developerId: id, role: "admin" });f.db.set({ ...developerOrgKey(id), orgId, role: "admin" });f.db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, revoked: false }); }
 for (let i = 0; i < 60; i += 1) {
  const request = projectAllowedDomainsHttp(f.deps, { ...f.caller, developerId: actors[i % 6]! }, project, { operation: "propose", body: { ...f.body, requestId: randomUUID() } });
  if (i === 0) await request;else await expect(request).rejects.toMatchObject({ code: "CHANGE_STALE" });
 }
 await expect(projectAllowedDomainsHttp(f.deps, { ...f.caller, developerId: actors[6]! }, project, { operation: "propose", body: { ...f.body, requestId: randomUUID() } })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
});

it("browser review returns canonical context without private storage fields", async () => {
 const f = await fixture(), result = await projectAllowedDomainsHttp(f.deps, f.caller, project, { operation: "review", expectedOrgId: orgId });
 expect(result).toMatchObject({ kind: "review", orgId, project, baseRevision: 1, allowedDomains: [], liveProposal: null });expect(result).not.toHaveProperty("projectIdentity");expect(result).not.toHaveProperty("runtimeBinding");
});
it("browser proposal creation requires a fresh reviewed context digest", async () => {
 const f = await fixture();const { expectedContextDigest: ignored, ...body } = f.body;void ignored;await expect(f.propose(body)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
});

it("owned status recognizes the existing direct-narrowing receipt without resending it", async () => {
 const f = await fixture(), requestId = randomUUID(), { projectPk } = await import("@rovara-code/contracts");
 f.db.set({ pk: projectPk(orgId, project), sk: `EGRESS_PROPOSAL#${requestId}`, entityType: "EGRESS_PROPOSAL", orgId, project, by, requestId, bodyHash: "a".repeat(64), state: "applied", mode: "direct_narrowing", baseRevision: 1, resultRevision: 2, createdAt: "2026-10-29T21:00:00.000Z" });
 const before = f.db.transactions().length, result = await projectAllowedDomainsHttp(f.deps, f.caller, project, { operation: "request-status", expectedOrgId: orgId, requestId });
 expect(result).toMatchObject({ kind: "receipt", status: "applied", receipt: { requestId, mode: "direct_narrowing", resultRevision: 2 } });expect(f.db.transactions()).toHaveLength(before);
});

it("browser direct save uses its reviewed context and returns a nested owned narrowing receipt", async () => {
 const f = await fixture(), key = projectRevisionKey(orgId, project, 1), row = f.db.get(key)!;
 f.db.set({ ...row, definition: { ...(row.definition as Record<string, unknown>), network: { allowedDomains: ["old.acme.dev"] } } });
 const review = await readProjectAllowedDomainsReview(f.deps, { orgId, project, by }), requestId = randomUUID();
 const result = await projectAllowedDomainsHttp(f.deps, f.caller, project, { operation: "save", body: { expectedOrgId: orgId, requestId, expectedRevision: 1, expectedContextDigest: review.contextDigest, allowedDomains: [] } });
 expect(result).toMatchObject({ status: "applied", receipt: { requestId, mode: "direct_narrowing", resultRevision: 2 } });
});
it("browser direct save treats an identical reviewed list as a write-free no-op", async () => {
 const f = await fixture(), before = f.db.transactions().length;
 const result = await projectAllowedDomainsHttp(f.deps, f.caller, project, { operation: "save", body: { ...f.body, allowedDomains: [] } });
 expect(result).toMatchObject({ kind: "unchanged", status: "unchanged", resultRevision: 1 });expect(f.db.transactions()).toHaveLength(before);
});
