// Plan 6 Task 9: a fresh machine with the project's setup. Every Rovara Code task prepares its own new workspace at the project's latest revision (the project's approved setup
// commands run on it, on the worker, in the sandbox). For a version 2 (`"1.1.0"`) task the project's setup status, which Plan 2's setup check keeps, decides what the start says:
// `ready` adds nothing; `unchecked`, `outdated` and `checking` add one first event; `failed` refuses the start before anything is charged. A version 1 task is unchanged.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { builtinSettingsKey, projectMetaKey, projectRevisionKey, type OrgId } from "@rovara-code/contracts";
import { MAYA, OMAR, createDeveloperTaskBroker, registerRevision, seedMembership } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";

const NOW = "2026-10-25T12:00:00.000Z";
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const NOT_CHECKED = "This project's setup hasn't been checked since it last changed. If the build fails to start, run a setup check.";
const failedMessage = (step: string) => `This project's setup failed its last check (${step}). Fix the setup, or ask Rovara to draft it, before starting work.`;
const command = (executable: string, args: string[]) => ({ cwd: "repo/demo", executable, args, timeoutSeconds: 600 });

type Reply = { status: number; body: Record<string, unknown> };
const errorOf = (reply: Reply) => reply.body.error as { code: string; message: string };

/** A broker with Rovara Code version 2 live (`v2`), or the version 1 an org without settings gets; the project has a setup command and a test command at revision 1. */
async function setup(options: { v2?: boolean } = { v2: true }) {
  const h = await createDeveloperTaskBroker({ brokerExtra: { agents: { ...(options.v2 === false ? {} : { rovaraCodeV2Live: true }) } } });
  const key = projectRevisionKey(TEST_ORG, "payments", 1);
  const item = h.db.get(key) as { definition: Record<string, unknown> };
  h.db.set({ ...item, ...key, definition: { ...item.definition, setup: [command("npm", ["ci"])], readiness: [command("npm", ["test"])] } });
  seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
  if (options.v2 !== false) {
    const store = new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now });
    await store.ensureBuiltinSettings(TEST_ORG, "rovara-code");
    h.db.set({ ...builtinSettingsKey(TEST_ORG, "rovara-code"), entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 2, updatedBy: "test", updatedAt: NOW });
  }
  const meta = () => h.db.get(projectMetaKey(TEST_ORG, "payments")) as { setupCheck?: { workspaceId: string } } | undefined;
  /** A maintainer's setup check, ended the way the worker would end it (or left running). */
  const runCheck = async (outcome: "SUCCEEDED" | "FAILED" | "RUNNING", error?: string) => {
    const reply = await h.dev(OMAR, "POST", "/v1/app/projects/payments/setup-check", { requestId: randomUUID() });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const workspaceId = meta()!.setupCheck!.workspaceId;
    const operationId = String((h.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
    if (outcome !== "RUNNING") await h.finish(workspaceId, operationId, outcome, error === undefined ? {} : { error });
    return workspaceId;
  };
  const prepareOf = (workspaceId: string) => {
    const operation = h.db.find((item) => item.entityType === "OPERATION" && item.workspaceId === workspaceId && item.kind === "prepare")[0] as { id: string };
    return operation.id;
  };
  const start = (body: Record<string, unknown> = {}, requestId: string = randomUUID()): Promise<Reply> =>
    h.dev(MAYA, "POST", "/v1/app/projects/payments/code", { requestId, input: { text: "Fix the retry bug" }, ...body });
  const taskOf = (reply: Reply) => (reply.body.task as { taskId: string });
  const stored = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string; ownerKey: string; startingRevision: number; workflow?: { definitionVersion: string } };
  /** Every event item of the task's prepare operation, oldest first. */
  const prepareEvents = (taskId: string) => {
    const workspaceId = stored(taskId).workspaceId;
    return h.db.find((item) => item.entityType === "EVENT" && item.workspaceId === workspaceId).sort((a, b) => Number(a.sequence) - Number(b.sequence)) as Array<{ sequence: number; type: string; payload: { message?: string }; operationId: string }>;
  };
  const eventTexts = async (taskId: string) => ((await h.dev(MAYA, "GET", `/v1/dev/tasks/${taskId}/events?limit=50`)).body.events as Array<{ text: string }>).map((event) => event.text);
  const counters = () => h.db.find((item) => item.entityType === "DEVELOPER_LIMIT" || item.entityType === "SLACK_LIMIT").map((item) => ({ ...item }));
  const workspaces = () => h.db.find((item) => item.entityType === "WORKSPACE");
  const tasks = () => h.db.find((item) => item.entityType === "DEVELOPER_TASK");
  return { ...h, meta, runCheck, prepareOf, start, taskOf, stored, prepareEvents, eventTexts, counters, workspaces, tasks };
}

describe("a version 2 task and the project's setup status", () => {
  it("ready: the start says nothing about the setup", async () => {
    const t = await setup();
    await t.runCheck("SUCCEEDED");
    const reply = await t.start();
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const taskId = t.taskOf(reply).taskId;
    expect(t.stored(taskId).workflow?.definitionVersion).toBe("1.1.0");
    expect(t.prepareEvents(taskId)).toEqual([]);
    expect(await t.eventTexts(taskId)).not.toContain(NOT_CHECKED);
  });

  it("unchecked: the first event is the exact warning, on the task's own prepare, and the task starts", async () => {
    const t = await setup();
    const reply = await t.start();
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const taskId = t.taskOf(reply).taskId;
    const events = t.prepareEvents(taskId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sequence: 1, type: "progress", payload: { message: NOT_CHECKED } });
    const workspaceId = t.stored(taskId).workspaceId;
    expect(events[0]!.operationId).toBe((t.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
    expect((await t.eventTexts(taskId))[0]).toBe(NOT_CHECKED);
  });

  it("outdated: a newer revision than the checked one gives the same warning", async () => {
    const t = await setup();
    await t.runCheck("SUCCEEDED");
    await registerRevision(t.handler, 2, {});
    const reply = await t.start();
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const taskId = t.taskOf(reply).taskId;
    expect(t.stored(taskId).startingRevision).toBe(2);
    expect(t.prepareEvents(taskId).map((event) => event.payload.message)).toEqual([NOT_CHECKED]);
  });

  it("checking: a check still running gives the same warning", async () => {
    const t = await setup();
    await t.runCheck("RUNNING");
    const reply = await t.start();
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    expect(t.prepareEvents(t.taskOf(reply).taskId).map((event) => event.payload.message)).toEqual([NOT_CHECKED]);
  });

  it("failed: refused with CONFIG_INVALID and the failing step, before anything is charged or written", async () => {
    const t = await setup();
    await t.runCheck("FAILED", "setup step 0 (npm ci in repo/demo) exited 1\nLast lines:\nnpm ERR! boom");
    const before = { counters: t.counters(), workspaces: t.workspaces().length, items: t.db.find(() => true).length };
    const reply = await t.start();
    expect(reply.status).toBe(400);
    expect(errorOf(reply)).toEqual({ code: "CONFIG_INVALID", message: failedMessage("setup: npm ci - setup step 0 (npm ci in repo/demo) exited 1 Last lines: npm ERR! boom") });
    // Nothing: no task, no session, no workspace beyond the check's own, no counter moved, no run request.
    expect(t.tasks()).toEqual([]);
    expect(t.db.find((item) => item.entityType === "AGENT_SESSION")).toEqual([]);
    expect(t.workspaces()).toHaveLength(before.workspaces);
    expect(t.counters()).toEqual(before.counters);
    expect(t.db.find((item) => item.entityType === "IDEMPOTENCY" && typeof item.taskId === "string")).toEqual([]);
    // Only the refused-turn record is new.
    expect(t.db.find(() => true).length - before.items).toBeLessThanOrEqual(1);
  });

  it("failed with no recorded reason still refuses, naming the stage", async () => {
    const t = await setup();
    const workspaceId = await t.runCheck("FAILED");
    // The worker recorded no error: the stored prepare has none.
    const operationId = t.prepareOf(workspaceId);
    const { error: _error, ...withoutError } = t.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`) as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unused-vars -- dropping the field
    t.db.set(withoutError);
    const reply = await t.start();
    expect(errorOf(reply)).toEqual({ code: "CONFIG_INVALID", message: failedMessage("setup") });
  });

  it("failed on an old revision is outdated, not a refusal: the person has already changed the setup", async () => {
    const t = await setup();
    await t.runCheck("FAILED", "setup step 0 (npm ci in repo/demo) exited 1");
    expect((await t.start()).status).toBe(400);
    await registerRevision(t.handler, 2, {});
    const reply = await t.start();
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    expect(t.prepareEvents(t.taskOf(reply).taskId).map((event) => event.payload.message)).toEqual([NOT_CHECKED]);
  });

  it("a check that never finished reads as failed after 50 minutes, and the start is refused with that step", async () => {
    const t = await setup();
    await t.runCheck("RUNNING");
    const projectMeta = t.db.get(projectMetaKey(TEST_ORG, "payments")) as { setupCheck: Record<string, unknown> };
    t.db.set({ ...projectMeta, ...projectMetaKey(TEST_ORG, "payments"), setupCheck: { ...projectMeta.setupCheck, startedAt: new Date(Date.now() - 51 * 60_000).toISOString() } });
    const reply = await t.start();
    expect(errorOf(reply)).toEqual({ code: "CONFIG_INVALID", message: failedMessage("setup: did not finish within 50 minutes") });
  });

  it("fails closed: when the status cannot be read the start does not go on, and nothing is written", async () => {
    const t = await setup();
    const checkWorkspace = await t.runCheck("SUCCEEDED");
    const before = { counters: t.counters(), workspaces: t.workspaces().length };
    t.db.injectFault({ command: "GetCommand", match: (input) => (input.Key as { pk?: string } | undefined)?.pk === `WORKSPACE#${checkWorkspace}`, times: 5, error: { name: "InternalServerError" } });
    const reply = await t.start();
    expect(reply.status).toBeGreaterThanOrEqual(500);
    expect(t.tasks()).toEqual([]);
    expect(t.workspaces()).toHaveLength(before.workspaces);
    expect(t.counters()).toEqual(before.counters);
  });

  it("retry: after a refused start, a new passing check lets the same request id start", async () => {
    const t = await setup();
    await t.runCheck("FAILED", "setup step 0 (npm ci in repo/demo) exited 1");
    const requestId = randomUUID();
    expect((await t.start({}, requestId)).status).toBe(400);
    await t.runCheck("SUCCEEDED");
    const reply = await t.start({}, requestId);
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    expect(t.prepareEvents(t.taskOf(reply).taskId)).toEqual([]);
  });

  it("a repeat of a start that was accepted answers the first task even if the setup has since failed", async () => {
    const t = await setup();
    await t.runCheck("SUCCEEDED");
    const requestId = randomUUID();
    const first = await t.start({}, requestId);
    expect(first.status).toBe(202);
    await t.runCheck("FAILED", "setup step 0 (npm ci in repo/demo) exited 1");
    const again = await t.start({}, requestId);
    expect(again.status).toBe(202);
    expect(t.taskOf(again).taskId).toBe(t.taskOf(first).taskId);
    expect(t.tasks()).toHaveLength(1);
  });

  it("two tasks get two workspaces, each its own and at the latest revision, each with its own first event", async () => {
    const t = await setup();
    const first = t.taskOf(await t.start());
    const second = t.taskOf(await t.start());
    expect(first.taskId).not.toBe(second.taskId);
    const [a, b] = [t.stored(first.taskId), t.stored(second.taskId)];
    expect(a.workspaceId).not.toBe(b.workspaceId);
    expect(a.ownerKey).not.toBe(b.ownerKey);
    expect([a.startingRevision, b.startingRevision]).toEqual([1, 1]);
    for (const workspaceId of [a.workspaceId, b.workspaceId]) {
      expect(t.db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARING", projectName: "payments", projectRevision: 1 });
      expect(t.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === workspaceId)).toHaveLength(1);
    }
    expect(t.prepareEvents(first.taskId).map((event) => event.payload.message)).toEqual([NOT_CHECKED]);
    expect(t.prepareEvents(second.taskId).map((event) => event.payload.message)).toEqual([NOT_CHECKED]);
    expect(t.prepareEvents(first.taskId)[0]!.operationId).not.toBe(t.prepareEvents(second.taskId)[0]!.operationId);
  });

  it("the project's setup check workspace is not reused by a task", async () => {
    const t = await setup();
    const checkWorkspace = await t.runCheck("SUCCEEDED");
    const task = t.taskOf(await t.start());
    expect(t.stored(task.taskId).workspaceId).not.toBe(checkWorkspace);
  });

  it("the worker's own events continue after the warning: the sequence is kept", async () => {
    const t = await setup();
    const task = t.taskOf(await t.start());
    const workspaceId = t.stored(task.taskId).workspaceId;
    const operationId = String((t.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
    await t.events(workspaceId, operationId, [{ type: "progress", payload: { message: "Cloning the repository" } }]);
    expect(t.prepareEvents(task.taskId).map((event) => [event.sequence, event.payload.message])).toEqual([[1, NOT_CHECKED], [2, "Cloning the repository"]]);
  });

  it("another organization's failed setup of a project with the same name changes nothing here", async () => {
    const t = await setup();
    t.db.set({ ...projectMetaKey(ORG_B, "payments"), entityType: "PROJECT_META", name: "payments", status: "active", createdAt: NOW, createdBy: "x", setupCheck: { workspaceId: randomUUID(), revision: 1, startedAt: NOW, startedBy: "x" } });
    const reply = await t.start();
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    expect(t.prepareEvents(t.taskOf(reply).taskId).map((event) => event.payload.message)).toEqual([NOT_CHECKED]);
  });
});

describe("a version 1 task is unchanged", () => {
  it("on an unchecked project it gets no warning, and the start records nothing new", async () => {
    const t = await setup({ v2: false });
    const reply = await t.start({ path: "QUICK" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const taskId = t.taskOf(reply).taskId;
    expect(t.stored(taskId).workflow?.definitionVersion).toBe("1.0.0");
    expect(t.prepareEvents(taskId)).toEqual([]);
    const workspaceId = t.stored(taskId).workspaceId;
    const operation = t.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${String((t.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId)}`) as { eventSequence: number };
    expect(operation.eventSequence).toBe(0);
  });

  it("on a project whose last check failed it is still started", async () => {
    const t = await setup({ v2: false });
    await t.runCheck("FAILED", "setup step 0 (npm ci in repo/demo) exited 1");
    const reply = await t.start({ path: "QUICK" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    expect(t.prepareEvents(t.taskOf(reply).taskId)).toEqual([]);
  });
});
