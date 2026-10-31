import { writeProjectAi } from "../../packages/broker/src/spend/settings.js";
import { fixtureProject } from "../support/project-ai-source.js";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
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

async function proposal(f: ReturnType<typeof fixture>, project = false) {
 const path = project ? `${base}/projects/web` : base, view = await f.call("GET", `${path}/editing`), proposalId = randomUUID();
 const response = await f.call("PUT", path, { requestId: proposalId, expectedRevision: view.body.revision, expectedPolicyDigest: view.body.sourceDigest, policy: project ? { kind: "inherit" } : { kind: "rovara_estimate" } });
 expect(response.body.state).toBe("pending");
 const pending = (await f.call("GET", `${path}/editing`)).body.pending as { proposalDigest: string };
 return { path, body: { requestId: randomUUID(), proposalId, decision: "approve", expectedProposalDigest: pending.proposalDigest } };
}
for (const loss of ["proposer-role", "approver-role", "pointer", "identity", "closing", "generation", "proposal", "source", "archive"])
it(`Spending approval refuses native ${loss} loss at commit without policy or audit`, async () => {
 const f = fixture(), project = loss === "archive", p = await proposal(f, project), send = f.db.send.bind(f.db);let raced = false;
 const key = project ? projectAiKey(orgId, "web") : f.key, original = f.db.get(key)!;
 f.db.send = async command => {
  if (!raced && command instanceof TransactWriteCommand) {
   raced = true;
   if (loss.endsWith("role")) { const id = loss === "proposer-role" ? a : b, k = orgMemberKey(orgId, id); f.db.set({ ...f.db.get(k)!, role: "member" }); }
   else if (loss === "pointer") { const k = developerOrgKey(b);f.db.set({ ...f.db.get(k)!, orgId: "org_bbbbbbbbbbbbbbbbbbbb" }); }
   else if (loss === "identity") f.db.set({ pk: `DEVELOPER#${b}`, sk: "META", developerId: b, provider: "cloud", revoked: true });
   else if (loss === "closing" || loss === "generation") { const k = orgMetaKey(orgId);f.db.set({ ...f.db.get(k)!, ...(loss === "closing" ? { closingAt: "now" } : { approvalMembershipVersion: 1 }) }); }
   else if (loss === "proposal") f.db.set({ ...original, pendingTaskStopChange: { ...(original.pendingTaskStopChange as object), proposedPolicy: { kind: "limited", stopMicrousd: 999999999 } } });
   else if (loss === "source") f.db.set({ ...original, revision: 2 });
   else { const k = projectMetaKey(orgId, "web");f.db.set({ ...f.db.get(k)!, archivedAt: "now" }); }
  }
  return send(command);
 };
 expect((await f.call("POST", `${p.path}/decisions`, p.body, b)).status).not.toBe(200);
 expect(f.db.get(key)?.[project ? "taskStopPolicy" : "policy"]).toEqual(original[project ? "taskStopPolicy" : "policy"]);
 expect(f.capture.recordedBy("spending.policy_change_decided")).toHaveLength(0);
});
it("Spending approval refuses a proposal changed after the displayed digest", async () => {
 const f = fixture(), p = await proposal(f), row = f.db.get(f.key)!;
 f.db.set({ ...row, pendingTaskStopChange: { ...(row.pendingTaskStopChange as object), proposedPolicy: { kind: "limited", stopMicrousd: 100000000 } } });
 expect((await f.call("POST", `${base}/decisions`, p.body, b)).status).not.toBe(200);
});
for (const decision of ["reject", "cancel"]) it(`Spending ${decision} ends only the pending change and replays`, async () => {
 const f = fixture(), p = await proposal(f), body = { ...p.body, decision }, actor = decision === "cancel" ? a : b;
 if (decision === "cancel") expect((await f.call("POST", `${base}/decisions`, body, b)).status).not.toBe(200);
 const answer = await f.call("POST", `${base}/decisions`, body, actor);expect(answer.status).toBe(200);
 expect((await f.call("POST", `${base}/decisions`, body, actor)).body).toEqual(answer.body);
 expect(f.db.get(f.key)?.pendingTaskStopChange).toBeUndefined();expect(f.db.get(f.key)?.revision).toBe(1);
 expect(f.capture.recordedBy("spending.policy_change_decided")).toHaveLength(1);
});
it("Spending zero is exact and an identical policy is a no-op", async () => {
 const f = fixture(), view = await f.call("GET", `${base}/editing`);
 const body = { requestId: randomUUID(), expectedRevision: 1, expectedPolicyDigest: view.body.sourceDigest, policy: { kind: "limited", stopMicrousd: 0 } };
 expect((await f.call("PUT", base, body)).body.state).toBe("applied");
 const next = await f.call("GET", `${base}/editing`);
 expect((await f.call("PUT", base, { ...body, requestId: randomUUID(), expectedRevision: 2, expectedPolicyDigest: next.body.sourceDigest })).body.state).toBe("unchanged");
 expect(f.db.get(f.key)?.revision).toBe(2);expect(f.capture.recordedBy("spending.policy_changed")).toHaveLength(1);
});
it("monthly writes fence a proposal inserted after their read", async () => {
 const f = fixture(), send = f.db.send.bind(f.db), key = projectAiKey(orgId, "web");let raced = false;
 f.db.send = async command => { if (!raced && command instanceof TransactWriteCommand) { raced = true;f.db.set({ ...f.db.get(key)!, pendingTaskStopChange: { unexpected: "concurrent proposal" } }); }return send(command); };
 await expect(writeProjectAi({ ...f.deps, projectAiSignInTableName: "signin" }, orgId, "web", { projectPays: false, monthlyBudgetUsd: 51 }, a, { actor: { developerId: a, role: "owner" }, expectedRevision: 1 })).rejects.toThrow();
 expect(f.db.get(key)?.monthlyBudgetUsd).toBe(50);expect(f.db.get(key)?.pendingTaskStopChange).toEqual({ unexpected: "concurrent proposal" });
});
