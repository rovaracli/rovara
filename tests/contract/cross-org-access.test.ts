// Task 5: orgId on ID-keyed records and on every caller. A token names an org, the membership behind it is checked on
// every request, every task, workspace and operation record carries its org, and another org's resource reads as not found.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { developerOrgKey, orgScoped, type OrgId } from "@agentx/contracts";
import { authorizeWorkspace } from "../../packages/broker/src/authorization.js";
import { resolveTaskAccess } from "../../packages/broker/src/developer/task-access.js";
import type { OrgResolver } from "../../packages/broker/src/org/resolve.js";
import {
  projectMemberKey, projectRevisionKey, projectSetupApprovalKey, workspaceProjectIndexAttributes,
} from "../../packages/contracts/src/org-scoped-keys.js";
import { MAYA, OMAR, bearerFor, createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import { PRIYA, pageTask } from "../support/page-tasks.js";
import { SLACK_CHANNEL, SLACK_TEAM, ensureWorkspace, prepareThread } from "../support/slack-broker.js";
import { TEST_ORG } from "../support/orgs.js";

const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
/** Maya belongs to the install's org, Omar to another; operators (owner keys) keep the install's. */
const orgResolver: OrgResolver = async (subject) => (subject.developerId === OMAR.developerId ? ORG_B : TEST_ORG);
const start = (overrides: Record<string, unknown> = {}) => ({ requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "claude-code", ...overrides });

async function twoOrgs() {
  const harness = await createDeveloperTaskBroker({ orgResolver });
  const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", start());
  expect(started.status).toBe(200);
  const taskId = (started.body.task as { taskId: string }).taskId;
  return { ...harness, taskId };
}

describe("the developer token's org (AUTH_REQUIRED)", () => {
  it("refuses a token that carries no org", async () => {
    const { handler } = await createDeveloperTaskBroker();
    const response = await handler({
      version: "2.0", rawPath: "/v1/dev/tasks", rawQueryString: "", headers: { authorization: await bearerFor(MAYA, null) },
      requestContext: { requestId: randomUUID(), http: { method: "GET" } },
    });
    expect(response.statusCode).toBe(401);
    expect((JSON.parse(response.body) as { error: unknown }).error).toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("refuses a still-valid token once the developer's membership is removed", async () => {
    const { db, dev } = await createDeveloperTaskBroker();
    expect((await dev(MAYA, "GET", "/v1/dev/tasks")).status).toBe(200);
    db.delete(developerOrgKey(MAYA.developerId));
    const refused = await dev(MAYA, "GET", "/v1/dev/tasks");
    expect(refused.status).toBe(401);
    expect(refused.body.error).toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("refuses a token naming an org the developer no longer belongs to", async () => {
    const { db, dev } = await createDeveloperTaskBroker();
    seedMembership(db, MAYA.developerId, { orgId: ORG_B, role: "member" });
    const refused = await dev(MAYA, "GET", "/v1/dev/tasks");
    expect(refused.status).toBe(401);
    expect(refused.body.error).toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("applies the role the membership has now, not the one the token was issued with", async () => {
    const { db, dev } = await createDeveloperTaskBroker();
    seedMembership(db, MAYA.developerId, { orgId: TEST_ORG, role: "admin" });
    expect((await dev(MAYA, "GET", "/v1/dev/tasks")).status).toBe(200);
  });
});

describe("another org's task reads as not found", () => {
  it("answers 404 TASK_NOT_FOUND to a developer of another org on read, cancel and continue", async () => {
    const { dev, taskId, db } = await twoOrgs();
    const before = db.find((item) => item.entityType === "OPERATION").length;
    for (const [method, path, body] of [
      ["GET", `/v1/dev/tasks/${taskId}`, undefined],
      ["POST", `/v1/dev/tasks/${taskId}/cancel`, { requestId: randomUUID() }],
      ["POST", `/v1/dev/tasks/${taskId}/continue`, { requestId: randomUUID(), instructions: "more" }],
    ] as const) {
      const refused = await dev(OMAR, method, path, body);
      expect(refused.status, path).toBe(404);
      expect(refused.body.error, path).toMatchObject({ code: "TASK_NOT_FOUND" });
    }
    expect(db.find((item) => item.entityType === "OPERATION")).toHaveLength(before);
    // The owner, in the task's own org, still reads it.
    expect((await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).status).toBe(200);
  });

  it("never lists one org's tasks to another", async () => {
    const { dev, taskId } = await twoOrgs();
    const listed = async (who: typeof MAYA) => ((await dev(who, "GET", "/v1/dev/tasks")).body.tasks as Array<{ taskId: string }>).map((task) => task.taskId);
    expect(await listed(MAYA)).toEqual([taskId]);
    expect(await listed(OMAR)).toEqual([]);
  });

  it("hides the task from its own owner's id when the caller names another org, even before any ownership check", async () => {
    const fixture = pageTask();
    await expect(resolveTaskAccess(fixture.deps, PRIYA, fixture.taskId, "read")).resolves.toMatchObject({ role: "owner" });
    const elsewhere = { ...PRIYA, orgId: ORG_B };
    await expect(resolveTaskAccess(fixture.deps, elsewhere, fixture.taskId, "read")).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    // A task record with no org is no one's: it does not leak to the caller of an org either.
    const stored = fixture.db.get(`DEVTASK#${fixture.taskId}`, "META")!;
    fixture.db.set({ ...stored, orgId: undefined });
    await expect(resolveTaskAccess(fixture.deps, PRIYA, fixture.taskId, "read")).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("answers a workspace of another org as not found, never forbidden", () => {
    const identity = { issuer: "i", subject: "s", ownerKey: "o".repeat(64), orgId: TEST_ORG, isAdministrator: false, claims: {} };
    const workspace = { ownerKey: "o".repeat(64), projectName: "payments", orgId: ORG_B };
    expect(() => authorizeWorkspace(identity, workspace)).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(() => authorizeWorkspace(identity, { ...workspace, orgId: TEST_ORG })).not.toThrow();
    expect(() => authorizeWorkspace(identity, { ...workspace, ownerKey: "p".repeat(64), orgId: TEST_ORG })).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });
});

describe("every record a task starts carries its org", () => {
  it("writes orgId on the task, its workspace, the workspace's index value and the prepare operation", async () => {
    const { db, taskId } = await twoOrgs();
    const task = db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
    expect(task).toMatchObject({ orgId: TEST_ORG });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ orgId: TEST_ORG, workspaceProject: orgScoped(TEST_ORG, "payments") });
    const operations = db.find((item) => item.entityType === "OPERATION" && item.workspaceId === task.workspaceId);
    expect(operations.length).toBeGreaterThan(0);
    for (const operation of operations) expect(operation).toMatchObject({ orgId: TEST_ORG });
  });

  it("writes orgId on the workspace and operation a Slack thread starts, from the org its team is bound to", async () => {
    const { handler, db } = await createDeveloperTaskBroker();
    const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
    const created = await ensureWorkspace(handler, thread, "U0PRATIK01");
    expect(created.status).toBe(200);
    const workspaceId = String(created.body.workspaceId);
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ orgId: TEST_ORG, workspaceProject: orgScoped(TEST_ORG, "payments") });
    const prepared = await prepareThread(handler, thread, "U0PRATIK01");
    expect(prepared.status).toBe(200);
    const operations = db.find((item) => item.entityType === "OPERATION" && item.workspaceId === workspaceId);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ kind: "prepare", orgId: TEST_ORG });
  });
});

describe("the same project name in two orgs", () => {
  const workspace = (orgId: OrgId, id: string) => ({
    pk: `WORKSPACE#${id}`, sk: "META", entityType: "WORKSPACE", ...workspaceProjectIndexAttributes({ orgId, projectName: "web", createdAt: "2026-10-18T10:00:00.000Z" }),
    id, ownerKey: "o".repeat(64), orgId, projectName: "web", projectRevision: 1, deploymentMode: "ec2-ebs", rootPath: "/mnt/workspace", status: "READY",
    activeOperationId: null, fence: 1, createdAt: "2026-10-18T10:00:00.000Z", updatedAt: "2026-10-18T10:00:00.000Z",
  });

  it("lists each org's workspaces of that project apart", async () => {
    const harness = await createDeveloperTaskBroker({ register: false, orgResolver });
    const { db, dev } = harness;
    const idA = "11111111-1111-4111-8111-111111111111";
    const idB = "22222222-2222-4222-8222-222222222222";
    for (const [who, orgId, id] of [[MAYA, TEST_ORG, idA], [OMAR, ORG_B, idB]] as const) {
      db.set({ ...projectRevisionKey(orgId, "web", 1), entityType: "PROJECT", definition: { name: "web", revision: 1 } });
      db.set({ ...projectMemberKey(orgId, who.developerId, "web"), entityType: "MEMBERSHIP", ownerKey: who.developerId, projectName: "web", role: "developer" });
      db.set(workspace(orgId, id));
    }
    const listed = async (who: typeof MAYA) => ((await dev(who, "GET", "/v1/dev/workspaces")).body.workspaces as Array<{ id: string }>).map((entry) => entry.id);
    expect(await listed(MAYA)).toEqual([idA]);
    expect(await listed(OMAR)).toEqual([idB]);
  });

  it("holds each org's setup approval of the same project and proposal under its own partition", () => {
    const sha = "e".repeat(64);
    const a = projectSetupApprovalKey(TEST_ORG, "web", sha);
    const b = projectSetupApprovalKey(ORG_B, "web", sha);
    expect(a).toEqual({ pk: `ORG#${TEST_ORG}#PROJECT_SETUP#web`, sk: `PROPOSAL#${sha}` });
    expect(b.pk).not.toBe(a.pk);
    expect(b.sk).toBe(a.sk);
  });
});
