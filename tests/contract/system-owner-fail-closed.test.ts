// The system owner of automatic runs (owner decision 2026-11-02): everything that assumes an owner is a person FAILS CLOSED for a system owner, and the two things that must keep working for it (the dispatch of its operation and
// the liveness check of its task) are judged by the system owner's own standing: the company is open and the project is active.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { agentXError, isSystemOwnerId, orgMetaKey, projectMetaKey, projectRevisionKey, systemOwnerIdOf, systemOwnerName } from "../../packages/contracts/src/index.js";
import type { Ec2OutboxRecord } from "../../packages/broker/src/aws/lambda.js";
import { guardTaskDispatch } from "../../packages/broker/src/aws/task-dispatch-access.js";
import { checkProjectAccess } from "../../packages/broker/src/aws/developer-routes/project-access.js";
import { requestForPausedTask } from "../../packages/broker/src/spend/requests.js";
import { requireCreatorStillMember } from "../../packages/broker/src/developer/creator-member.js";
import { isSystemOwned, personOwnerOf, requirePerson, systemOwnerCaller, systemOwnerStands } from "../../packages/broker/src/developer/system-owner.js";
import { effectiveTaskOwner, tryEffectiveTaskOwner, type DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { ownerCallerOf } from "../../packages/broker/src/aws/broker/feedback-and-codebuild.js";
import { requesterOf } from "../../packages/broker/src/aws/broker/thread-workspaces.js";
import { developerTaskIdentity } from "../../packages/broker/src/developer/task-records.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

const ORG = TEST_ORG;
const PROJECT = "payments";
const SYSTEM = systemOwnerIdOf(ORG, PROJECT);
const PERSON = "a".repeat(64);
const TASK_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

function systemTask(): DeveloperTaskRecord {
  return {
    pk: `DEVTASK#${TASK_ID}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK_ID, orgId: ORG,
    developerId: SYSTEM, provider: "system", developerName: systemOwnerName(PROJECT), automatic: { job: "nightly", purpose: "nightly_run", approvedBy: PERSON },
    client: "api", project: PROJECT, title: "Nightly", workspaceId: WORKSPACE_ID, ownerKey: "f".repeat(64), conversationId: randomUUID(), startingRevision: 1,
    charge: { member: { pk: "member", sk: "counter" }, organization: { pk: "organization", sk: "counter" } }, shared: false,
    createdAt: "2026-11-02T10:00:00.000Z", updatedAt: "2026-11-02T10:00:00.000Z", purpose: "nightly_run",
  };
}

function outbox(): Ec2OutboxRecord {
  const operationId = randomUUID();
  return {
    id: randomUUID(), entityType: "OUTBOX", status: "QUEUED", operationId, workspaceId: WORKSPACE_ID, deploymentMode: "ec2-ebs",
    invocation: { protocolVersion: 1, kind: "task", operationId, workspaceId: WORKSPACE_ID, fence: 4, projectRevision: 1, callbackCapability: "c".repeat(64), payload: { conversationId: randomUUID(), prompt: "x", conversationStarted: true } },
  };
}

function world(options: { project?: "active" | "archived" | "missing"; orgClosed?: boolean } = {}) {
  const db = new FakeDynamoDb();
  const task = systemTask();
  const record = outbox();
  db.set(task as unknown as Record<string, unknown>);
  db.set({ pk: `WORKSPACE#${WORKSPACE_ID}`, sk: "DEVELOPER_TASK", entityType: "DEVELOPER_TASK_POINTER", taskId: TASK_ID, developerId: SYSTEM });
  db.set({ pk: `OUTBOX#${record.id}`, sk: "OUTBOX", ...record });
  db.set({ pk: `WORKSPACE#${WORKSPACE_ID}`, sk: `OPERATION#${record.operationId}`, status: "DISPATCHING", fence: 4 });
  db.set({ pk: `WORKSPACE#${WORKSPACE_ID}`, sk: "META", status: "BUSY", activeOperationId: record.operationId, fence: 4 });
  db.set({ ...orgMetaKey(ORG), entityType: "ORG", orgId: ORG, name: "Acme", ...(options.orgClosed === true ? { closedAt: "2026-11-01T00:00:00.000Z" } : {}) });
  if (options.project !== "missing") db.set({ ...projectMetaKey(ORG, PROJECT), entityType: "PROJECT_META", orgId: ORG, name: PROJECT, status: options.project === "archived" ? "archived" : "active", ...(options.project === "archived" ? { archivedAt: "2026-11-01T00:00:00.000Z" } : {}) });
  return { db, task, record, deps: { documentClient: db, tableName: "state", orgId: ORG } };
}

const codeOf = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string }) => error.code);

describe("the system owner is not a person", () => {
  it("its id has a shape no developer id has, and is the project's own", () => {
    expect(SYSTEM).toMatch(/^sysowner_[a-f0-9]{64}$/u);
    expect(SYSTEM).not.toMatch(/^[a-f0-9]{64}$/u);
    expect(isSystemOwnerId(SYSTEM)).toBe(true);
    expect(isSystemOwnerId(PERSON)).toBe(false);
    expect(isSystemOwnerId(undefined)).toBe(false);
    expect(isSystemOwnerId(`${SYSTEM}x`)).toBe(false);
    expect(systemOwnerIdOf(ORG, "other")).not.toBe(SYSTEM);
    expect(systemOwnerIdOf("org_bbbbbbbbbbbbbbbbbbbb", PROJECT)).not.toBe(SYSTEM);
  });

  it("a task it owns reads as system-owned; a person's task does not; the owner reads as 'Rovara (project: X)'", () => {
    expect(isSystemOwned(systemTask())).toBe(true);
    expect(isSystemOwned({ ...systemTask(), developerId: PERSON, provider: "oidc" })).toBe(false);
    expect(effectiveTaskOwner(systemTask())).toMatchObject({ developerId: SYSTEM, name: "Rovara (project: payments)", provider: "system" });
  });

  it("nothing can act AS it: no person-shaped caller is made from it", async () => {
    expect(() => personOwnerOf(effectiveTaskOwner(systemTask()))).toThrow(/automatic runs/u);
    expect(() => requirePerson(SYSTEM, "act")).toThrow(/automatic runs/u);
    expect(() => requirePerson(PERSON)).not.toThrow();
    // the broker's own steps (a webhook, a dispatch, a worker start) build the owner's caller through here
    expect(await codeOf(ownerCallerOf({} as never, systemTask(), "workflow-dispatch"))).toBe("TASK_ACCESS_DENIED");
  });

  it("a take-over cannot make it the owner: a stored taker with the system sign-in method is unreadable, and the owner then refuses", () => {
    const forged = { ...systemTask(), developerId: PERSON, provider: "oidc" as const, developerName: "Avery", currentOwner: { developerId: SYSTEM, name: "Rovara", provider: "system", since: "2026-11-02T10:00:00.000Z" } } as unknown as DeveloperTaskRecord;
    expect(tryEffectiveTaskOwner(forged)).toBeUndefined();
  });

  it("its operations name no requester, and its workspace identity names the system provider", () => {
    const identity = developerTaskIdentity({ taskId: TASK_ID, developerId: SYSTEM, provider: "system", developerName: systemOwnerName(PROJECT), client: "api" }, ORG);
    expect(identity.developer?.provider).toBe("system");
    expect(requesterOf(identity)).toEqual({});
    const person = developerTaskIdentity({ taskId: TASK_ID, developerId: PERSON, provider: "oidc", developerName: "Avery", client: "api" }, ORG);
    expect(requesterOf(person)).toEqual({ requestedBy: { kind: "developer", developerId: PERSON, provider: "oidc" } });
  });

  it("its in-memory caller is built for its own project and carries no Slack link or elevated role", () => {
    const caller = systemOwnerCaller(ORG, PROJECT);
    expect(caller).toMatchObject({ developerId: SYSTEM, orgId: ORG, orgRole: "member", name: "Rovara (project: payments)" });
    expect(caller.slackUserId).toBeUndefined();
  });
});

describe("the standing of a system owner replaces a person's membership", () => {
  it("stands while the company is open and the project is active", async () => {
    const w = world();
    expect(await systemOwnerStands(w.deps, ORG, PROJECT)).toBe(true);
  });

  it.each([["archived project", { project: "archived" as const }], ["closed company", { orgClosed: true }]])("does not stand for an %s", async (_label, options) => {
    const w = world(options);
    expect(await systemOwnerStands(w.deps, ORG, PROJECT)).toBe(false);
  });

  it("stands the way new work does: a project with no meta row of its own is not archived, and one marked archived by archivedAt alone is", async () => {
    expect(await systemOwnerStands(world({ project: "missing" }).deps, ORG, PROJECT)).toBe(true);
    const w = world();
    w.db.set({ ...projectMetaKey(ORG, PROJECT), entityType: "PROJECT_META", orgId: ORG, name: PROJECT, archivedAt: "2026-11-01T00:00:00.000Z" });
    expect(await systemOwnerStands(w.deps, ORG, PROJECT)).toBe(false);
    // a row that is not a project's meta row says nothing
    w.db.set({ ...projectMetaKey(ORG, PROJECT), entityType: "SOMETHING_ELSE", status: "archived" });
    expect(await systemOwnerStands(w.deps, ORG, PROJECT)).toBe(true);
  });

  it("the removed-creator check passes for a standing system owner and records nothing on the task", async () => {
    const w = world();
    await requireCreatorStillMember({ documentClient: w.db, tableName: "state", orgId: ORG }, w.task);
    expect((w.db.get(`DEVTASK#${TASK_ID}`, "META") as Record<string, unknown>).outcome).toBeUndefined();
  });

  it("the removed-creator check refuses a system owner whose project was archived, and never marks the task creator_removed", async () => {
    const w = world({ project: "archived" });
    expect(await codeOf(requireCreatorStillMember({ documentClient: w.db, tableName: "state", orgId: ORG }, w.task))).toBe("TASK_ACCESS_DENIED");
    expect((w.db.get(`DEVTASK#${TASK_ID}`, "META") as Record<string, unknown>).outcome).toBeUndefined();
  });

  it("dispatches the operation of a standing system-owned task with no People sidecar", async () => {
    const w = world();
    expect(await guardTaskDispatch(w.deps, w.record)).toBe("ALLOWED");
  });

  it.each([["archived project", { project: "archived" as const }], ["closed company", { orgClosed: true }]])("ends the run instead of parking it for an %s: the operation fails for good, the task is ended and queued for release, and nothing is dispatched", async (_label, options) => {
    const w = world(options);
    expect(await guardTaskDispatch(w.deps, w.record)).toBe("PARKED");
    // not parked waiting for a person who can never come: failed
    expect((w.db.get(`OUTBOX#${w.record.id}`, "OUTBOX") as { status?: string }).status).toBe("FAILED");
    expect((w.db.get(`WORKSPACE#${WORKSPACE_ID}`, `OPERATION#${w.record.operationId}`) as { status?: string }).status).toBe("FAILED");
    expect((w.db.get(`WORKSPACE#${WORKSPACE_ID}`, "META") as { activeOperationId?: string; status?: string })).toMatchObject({ status: "READY" });
    expect((w.db.get(`WORKSPACE#${WORKSPACE_ID}`, "META") as { activeOperationId?: string }).activeOperationId).toBeUndefined();
    const task = w.db.get(`DEVTASK#${TASK_ID}`, "META") as { agentRunEnd?: { state: string }; automaticEnd?: { reason: string }; outcome?: string };
    expect(task.agentRunEnd).toMatchObject({ state: "CANCELLED" });
    expect(task.automaticEnd).toMatchObject({ reason: "project_stopped" });
    expect(task.outcome).toBeUndefined();
    // the slot goes back through the release mark the recovery sweep reads
    expect(w.db.get("FINISHED_RELEASE", `TASK#${TASK_ID}`)).toMatchObject({ taskId: TASK_ID });
  });

  it("writes the end again once if its first write fails after the operation was failed, so the cause stays project_stopped", async () => {
    const w = world({ project: "archived" });
    w.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("automaticEnd"), error: { name: "InternalServerError" }, times: 1 });
    expect(await guardTaskDispatch(w.deps, w.record)).toBe("PARKED");
    expect((w.db.get(`DEVTASK#${TASK_ID}`, "META") as { automaticEnd?: { reason: string } }).automaticEnd).toMatchObject({ reason: "project_stopped" });
  });

  it("refuses a system-owned task that somehow has a People sidecar (no person is ever added to it): nothing dispatches", async () => {
    const w = world();
    w.db.set({ pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people: [] });
    expect(await codeOf(guardTaskDispatch(w.deps, w.record))).toBeDefined();
    expect((w.db.get(`OUTBOX#${w.record.id}`, "OUTBOX") as { status?: string }).status).toBe("QUEUED");
  });

  it("an unreadable standing is not standing: the guard fails rather than dispatch", async () => {
    const w = world();
    const broken = { ...w.deps, documentClient: { send: (command: unknown) => (JSON.stringify((command as { input?: unknown }).input ?? {}).includes("META") && JSON.stringify((command as { input?: unknown }).input).includes("PROJECT") ? Promise.reject(agentXError("RUNTIME_UNAVAILABLE", "boom")) : w.db.send(command as never)) } };
    expect(await codeOf(guardTaskDispatch(broken, w.record))).toBeDefined();
  });
});

describe("an automatic run asks nobody for more money", () => {
  it("a system-owned task that is paused at a limit makes no spend request: there is no person to ask for", async () => {
    const w = world();
    w.db.set({ ...systemTask(), budgetPause: { scope: { kind: "task", taskId: TASK_ID }, at: "2026-11-02T10:30:00.000Z" } });
    expect(await requestForPausedTask({ documentClient: w.db, tableName: "state", now: Date.now } as never, TASK_ID)).toBeUndefined();
    expect(w.db.find((item) => String(item.entityType).includes("SPEND_REQUEST"))).toHaveLength(0);
  });
});

describe("a system owner's access to its project", () => {
  const seed = () => {
    const db = new FakeDynamoDb();
    db.set({ ...projectRevisionKey(ORG, PROJECT, 1), entityType: "PROJECT", definition: { name: PROJECT, revision: 1, developerTasks: { enabled: false, share: "optional", shareMode: { default: "view", allowContinue: true }, channelMembersMayUse: false } } });
    return { documentClient: db, tableName: "state", developer: {}, now: () => Date.now() } as never;
  };
  const caller = (developerId: string, sessionId: string) => ({ orgId: ORG, orgRole: "member" as const, developerId, sessionId, amr: "cloud" as const, name: "x" });

  it("is its own project's, as a contributor, whatever the tasks-off switch says (that switch is for people's tasks)", async () => {
    expect(await checkProjectAccess(seed(), systemOwnerCaller(ORG, PROJECT), PROJECT)).toMatchObject({ role: "contributor", access: "granted" });
    // a person meets the switch
    expect(await codeOf(checkProjectAccess(seed(), caller(PERSON, "s-1"), PROJECT))).toBeDefined();
  });

  it("needs the system owner's own session as well as its id: the id alone, with a person's session, is refused", async () => {
    expect(await codeOf(checkProjectAccess(seed(), caller(SYSTEM, "s-1"), PROJECT))).toBe("PROJECT_ACCESS_DENIED");
    expect(await codeOf(checkProjectAccess(seed(), caller(systemOwnerIdOf(ORG, "other"), "system-owner"), PROJECT))).toBe("PROJECT_ACCESS_DENIED");
  });
});
