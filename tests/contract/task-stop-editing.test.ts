import { writeProjectAi } from "../../packages/broker/src/spend/settings.js";
import { fixtureProject } from "../support/project-ai-source.js";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { AgentXError, errorStatus, orgSettingsKey, orgMemberKey, developerOrgKey, orgMetaKey, projectAiKey, orgProjectCatalogKey, projectMetaKey } from "@agentx/contracts";
import { routeDeveloperRequest, type DeveloperCaller, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
const orgId = "org_aaaaaaaaaaaaaaaaaaaa", a = "a".repeat(64), b = "b".repeat(64);
function fixture() {
 const db = new FakeDynamoDb(), capture = capturingAuditDeps({ db });
 fixtureProject(db, orgId, "web");
 db.set({ ...orgMetaKey(orgId), orgId, entityType: "ORG" });
 for (const id of [a, b]) {
  db.set({ ...orgMemberKey(orgId, id), orgId, developerId: id, role: "owner" });
  db.set({ ...developerOrgKey(id), orgId, role: "owner" });
  db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, provider: "cloud", revoked: false });
 }
 const key = orgSettingsKey(orgId, "TASK_STOP_POLICY");
 db.set({ ...key, orgId, entityType: "ORG_TASK_STOP_POLICY", revision: 1, policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 10000000 } }, enrollment: { version: 1, state: "disabled" } });
 db.set({ ...orgProjectCatalogKey(orgId, "web"), entityType: "PROJECT_CATALOG", orgId, name: "web", latestRevision: 1 });
 db.set({ ...projectMetaKey(orgId, "web"), entityType: "PROJECT_META", orgId, name: "web", status: "active", createdAt: "2026-10-01T00:00:00Z" });
 db.set({ ...projectAiKey(orgId, "web"), entityType: "PROJECT_AI", orgId, project: "web", revision: 1, projectPays: false, monthlyBudgetUsd: 50, taskStopPolicy: { schemaVersion: 1, stopMicrousd: 10000000 } });
 const deps: DeveloperRouteDependencies = { documentClient: db, tableName: "state", now: () => Date.parse("2026-10-30T23:00:00Z"), audit: capture.audit,
  developer: { issuer: "https://cell.example", env: "test", signInTableName: "signin", methods: { cloud: true, slack: false, oidc: false }, verifyAccessToken: async () => ({}), channelMembers: async () => ({ ok: true, memberOf: [] }) } };
 async function call(method: string, path: string, body?: unknown, actor = a) {
  const caller: DeveloperCaller = { orgId, developerId: actor, orgRole: "owner", name: "Person", amr: "cloud", sessionId: "fixture" };
  try { const result = await routeDeveloperRequest(deps, { method, path, headers: {}, requestId: randomUUID(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, new URL(path, "https://cell.example"), { caller, csrf: "" });
   return { status: result === undefined ? 404 : 200, body: result as Record<string, unknown> }; }
  catch (error) { if (!(error instanceof AgentXError)) throw error; return { status: errorStatus(error.code), body: { code: error.code } }; }
 }
 return { db, deps, capture, key, call };
}
const base = "/v1/app/org/task-stop-policy";
for (const project of [false, true]) it(`Spending editing applies an exact tightening for ${project ? "project" : "company"} atomically and replays`, async () => {
 const f = fixture(), path = project ? `${base}/projects/web` : base;
 const context = await f.call("GET", `${path}/editing`); expect(context.status).toBe(200);
 const body = { requestId: randomUUID(), expectedRevision: context.body.revision, expectedPolicyDigest: context.body.sourceDigest, policy: { kind: "limited", stopMicrousd: 1234567 } };
 const result = await f.call("PUT", path, body); expect(result.status, JSON.stringify(result.body)).toBe(200); expect(result.body.state).toBe("applied");
 expect((await f.call("PUT", path, body)).body).toEqual(result.body);
 const row = f.db.get(project ? projectAiKey(orgId, "web") : f.key)!;
 expect(project ? row.taskStopPolicy : row.policy).toEqual(project ? { schemaVersion: 1, stopMicrousd: 1234567 } : { schemaVersion: 2, defaultPolicy: body.policy });
 expect(row.enrollment ?? { state: "disabled" }).toMatchObject({ state: "disabled" });
 expect(f.capture.recordedBy("spending.policy_changed")).toHaveLength(1);
});
it("Spending loosening pins original terms and uses distinct people even without membership version", async () => {
 const f = fixture(), view = await f.call("GET", `${base}/editing`), proposalId = randomUUID();
 expect((await f.call("PUT", base, { requestId: proposalId, expectedRevision: view.body.revision, expectedPolicyDigest: view.body.sourceDigest, policy: { kind: "rovara_estimate" } })).body.state).toBe("pending");
 expect(f.db.get(f.key)?.policy).toEqual({ schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 10000000 } });
 expect((await f.call("POST", `${base}/decisions`, { requestId: randomUUID(), proposalId, decision: "approve" })).status).not.toBe(200);
 const pending = (await f.call("GET", `${base}/editing`)).body.pending as { proposalDigest: string };
 const approved = await f.call("POST", `${base}/decisions`, { requestId: randomUUID(), proposalId, decision: "approve", expectedProposalDigest: pending.proposalDigest }, b);
 expect(approved.status, JSON.stringify(approved.body)).toBe(200); expect(approved.body.state).toBe("applied");
 expect(f.db.get(f.key)?.policy).toEqual({ schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" } });
});

it("monthly project edits preserve pending Spending terms and migrated identity", async () => {
 const f = fixture(), key = projectAiKey(orgId, "web"), before = f.db.get(key)!;
 const pending = { version: 1, proposalId: randomUUID(), requestedBy: a, createdAt: "2026-10-30T23:00:00.000Z", baseRevision: 1,
  beforePolicy: before.taskStopPolicy, proposedPolicy: { kind: "inherit" }, proposalDigest: "d".repeat(64), sourceDigest: "c".repeat(64), scopeKind: "project", project: "web" };
 f.db.set({ ...before, pendingTaskStopChange: pending });
 await writeProjectAi({ ...f.deps, projectAiSignInTableName: "signin" }, orgId, "web", { projectPays: false, monthlyBudgetUsd: 51 }, a, { actor: { developerId: a, role: "owner" }, expectedRevision: 1 });
 expect(f.db.get(key)).toMatchObject({ orgId, project: "web", monthlyBudgetUsd: 51, revision: 2, pendingTaskStopChange: pending, taskStopPolicy: before.taskStopPolicy });
});
