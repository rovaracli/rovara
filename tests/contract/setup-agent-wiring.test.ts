// The setup run, wired (SH14), through the whole broker: the routes, the start (task purpose, pointer, limits, read-only preparation), the operation the preparation starts (mode SETUP_AGENT, its payload and
// its capability), the worker's one callback action, the end (result, cost estimates untouched), and that with the `su` switch off none of it exists. The worker's half is tested in the worker's tests.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SETUP_AGENT_LIMITS_DEFAULT, SETUP_AGENT_FEATURE, WorkerInvocationSchema, setupDraftKey,
} from "../../packages/contracts/src/index.js";
import * as runs from "../../packages/broker/src/agents/runs.js";
import { runGivesAgentTools, setupRunStepOf } from "../../packages/broker/src/aws/broker/task-operations.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { recordRunCost } from "../../packages/broker/src/spend/estimate.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { NAME, setupWizardBench, type Bench } from "../support/setup-wizard-testenv.js";
import { capturingAuditDeps } from "../support/audit-capture.js";

// The real start, watched: the setup run's start must hold to the payer the route resolved (F9).
vi.mock("../../packages/broker/src/agents/runs.js", async (original) => {
  const actual = await original<typeof runs>();
  return { ...actual, startAgentRun: vi.fn(actual.startAgentRun) };
});

afterEach(() => { delete process.env.SETUP_AGENT_ENABLED; delete process.env.DECISION_CARDS_ENABLED; });
const ROUTE = `/v1/app/projects/${NAME}/setup-agent`;
const orgId = TEST_ORG;

async function bench(): Promise<Bench> {
  const audit = capturingAuditDeps();
  const t = await setupWizardBench({ audit, modelProxy: true });
  audit.audit.documentClient = t.db as unknown as typeof audit.audit.documentClient;
  return t;
}
const tasks = (t: Bench) => t.db.find((item) => String(item.pk).startsWith("DEVTASK#") && item.purpose === "setup_agent") as Array<Record<string, unknown> & { taskId: string; workspaceId: string }>;
const ops = (t: Bench, workspaceId: string) => t.db.find((item) => item.entityType === "OPERATION" && item.workspaceId === workspaceId) as Array<{ id: string; kind: string; workflowMode?: string }>;
const outbox = (t: Bench, operationId: string) => WorkerInvocationSchema.parse((t.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0] as { invocation: unknown }).invocation);

/** Starts a run and finishes its preparation, so the setup operation exists. */
async function started(t: Bench) {
  const reply = await t.dev(OMAR, "POST", ROUTE, { requestId: randomUUID() });
  expect(reply.status, JSON.stringify(reply.body)).toBe(202);
  const [task] = tasks(t);
  const prepare = ops(t, task!.workspaceId).find((operation) => operation.kind === "prepare")!;
  await t.finish(task!.workspaceId, prepare.id, "SUCCEEDED", { result: { preparedBase: undefined } });
  const own = ops(t, task!.workspaceId).find((operation) => operation.kind === "task")!;
  // The worker's first event moves the operation to RUNNING, as it does for every task.
  await t.events(task!.workspaceId, own.id, [{ type: "lifecycle", payload: { status: "RUNNING" } }]);
  return { task: task!, own };
}

describe("with the switch off", () => {
  it("none of it exists: the routes are unknown paths and nothing is written", async () => {
    const t = await bench();
    for (const [method, path] of [["POST", ROUTE], ["GET", ROUTE], ["POST", `${ROUTE}/stop`], ["POST", `${ROUTE}/command`], ["GET", `${ROUTE}/journal`]] as const) {
      const reply = await t.dev(OMAR, method, path, method === "POST" ? { requestId: randomUUID(), command: "ls" } : undefined);
      expect(reply.status, `${method} ${path}`).toBe(404);
    }
    expect(tasks(t)).toEqual([]);
    expect(t.db.get(setupDraftKey(orgId, NAME).pk, "AGENT")).toBeUndefined();
  });

  it("the setup draft still starts as it did", async () => {
    const t = await bench();
    const reply = await t.ask();
    expect(reply.status).toBe(202);
    expect(t.db.find((item) => String(item.pk).startsWith("DEVTASK#") && item.purpose === "setup_draft")).toHaveLength(1);
    expect(tasks(t)).toEqual([]);
  });
});

describe("with the switch on", () => {
  it("starts a read-only run of its own: a setup_agent task with its limits, the project's pointer, and the SETUP_AGENT operation the preparation starts", async () => {
    process.env.SETUP_AGENT_ENABLED = "1";
    const t = await bench();
    const { task, own } = await started(t);
    expect(task).toMatchObject({ purpose: "setup_agent", setupAgentLimits: SETUP_AGENT_LIMITS_DEFAULT });
    expect(t.db.get(setupDraftKey(orgId, NAME).pk, "AGENT")).toMatchObject({ taskId: task.taskId, requestedBy: OMAR.developerId, limits: SETUP_AGENT_LIMITS_DEFAULT });
    expect(own.workflowMode).toBe("SETUP_AGENT");
    const invocation = outbox(t, own.id);
    expect(invocation).toMatchObject({ kind: "task", payload: { workflowMode: "SETUP_AGENT", setupAgent: { limits: SETUP_AGENT_LIMITS_DEFAULT } } });
    if (invocation.kind !== "task") throw new Error("not a task");
    expect(invocation.payload.prompt).toBe(`Set up the dev environment for the project ${NAME} by running its setup and test commands.`);
    const claims = JSON.parse(Buffer.from(invocation.callbackCapability.split(".")[0]!, "base64url").toString("utf8")) as { actions: string[] };
    expect(claims.actions).toContain("setup-agent");
    // The run's limit is the setup budget ($4), not the planning limit.
    expect(task["budgetUsd"] === undefined || task["budgetUsd"] === SETUP_AGENT_LIMITS_DEFAULT.budgetCents / 100).toBe(true);
  });

  it("holds the start to the payer the route resolved once (payerFromRules), so a setting that changes in between is a retryable busy answer and never a charge to another", async () => {
    process.env.SETUP_AGENT_ENABLED = "1";
    const t = await bench();
    await t.dev(OMAR, "POST", ROUTE, { requestId: randomUUID() });
    const call = vi.mocked(runs.startAgentRun).mock.calls.at(-1)![1];
    expect(call.payerFromRules).toBe(true);
    expect(call.payer).toEqual({ kind: "member", developerId: OMAR.developerId });
  });

  it("is refused with no model proxy on the install (a run is paid for by the minute), and starts nothing", async () => {
    process.env.SETUP_AGENT_ENABLED = "1";
    const audit = capturingAuditDeps();
    const t = await setupWizardBench({ audit });
    audit.audit.documentClient = t.db as unknown as typeof audit.audit.documentClient;
    expect((await t.dev(OMAR, "POST", ROUTE, { requestId: randomUUID() })).status).toBe(404);
    expect(tasks(t)).toEqual([]);
  });

  it("sends a setup run none of the plan step's settings (its time limit, skills and tools are the coding agent's), and every other mode its step", () => {
    const step = { id: "plan", timeoutSeconds: 600 };
    expect(setupRunStepOf("SETUP_AGENT", step)).toBeUndefined();
    for (const mode of ["PLAN", "IMPLEMENT", "REVIEW", "UNDERSTAND", undefined]) expect(setupRunStepOf(mode, step)).toBe(step);
  });

  it("serves a setup run no connector tools, even when an agent step grants them", () => {
    const granted = { agentStep: { kind: "agent" }, toolGrants: true } as never;
    expect(runGivesAgentTools("SETUP_AGENT", granted)).toBe(false);
    expect(runGivesAgentTools("IMPLEMENT", granted)).toBe(true);
    expect(runGivesAgentTools(undefined, granted)).toBe(true);
  });

  it("another operation of the same install does not get the action", async () => {
    process.env.SETUP_AGENT_ENABLED = "1";
    const t = await bench();
    const reply = await t.ask();
    expect(reply.status).toBe(202);
    const draft = t.db.find((item) => String(item.pk).startsWith("DEVTASK#") && item.purpose === "setup_draft")[0] as { workspaceId: string };
    const prepare = ops(t, draft.workspaceId).find((operation) => operation.kind === "prepare")!;
    const claims = JSON.parse(Buffer.from((t.db.find((item) => item.entityType === "OUTBOX" && item.operationId === prepare.id)[0] as { invocation: { callbackCapability: string } }).invocation.callbackCapability.split(".")[0]!, "base64url").toString("utf8")) as { actions: string[] };
    expect(claims.actions).not.toContain("setup-agent");
  });

  it("a plain member cannot start, command or stop a run; a maintainer can; the body is a request id and nothing else", async () => {
    process.env.SETUP_AGENT_ENABLED = "1";
    const t = await bench();
    await t.person(MAYA, "member", "viewer");
    expect((await t.dev(MAYA, "POST", ROUTE, { requestId: randomUUID() })).status).toBe(403);
    expect((await t.dev(OMAR, "POST", ROUTE, { requestId: randomUUID(), limits: { commands: 120 } })).status).toBe(400);
    expect(tasks(t)).toEqual([]);
    expect((await t.dev(OMAR, "POST", ROUTE, { requestId: randomUUID() })).status).toBe(202);
    expect((await t.dev(OMAR, "POST", ROUTE, { requestId: randomUUID() })).status).toBe(409);
    expect((await t.web(MAYA, "POST", `${ROUTE}/command`, { requestId: randomUUID(), command: "ls" })).status).toBe(403);
    expect((await t.dev(MAYA, "POST", `${ROUTE}/stop`, { requestId: randomUUID() })).status).toBe(403);
  });
});

describe("the worker's callback", () => {
  it("takes a journal entry, hands over a maintainer's command once, and reports host asks, all for the authenticated run only", async () => {
    process.env.SETUP_AGENT_ENABLED = "1";
    const t = await bench();
    const { task, own } = await started(t);
    const entry = { n: 1, source: "agent", command: "npm ci", exitCode: 0, durationMs: 4000, timedOut: false, flagged: false, blockedHosts: [], tail: "ok\n", startedAt: new Date().toISOString() };
    expect(await t.callback(task.workspaceId, own.id, "setup-agent", { kind: "journal", entries: [entry] })).toMatchObject({ stored: 1 });
    const journal = await t.dev(OMAR, "GET", `${ROUTE}/journal`);
    expect(journal.status).toBe(200);
    expect(journal.body).toMatchObject({ status: "running", entries: [{ n: 1, command: "npm ci", source: "agent" }] });
    expect(t.db.get(taskKey(task.taskId))).toMatchObject({ setupAgentProgress: { commands: 1 } });
    // A person's command: queued by the route, handed over once by poll.
    // A token is refused; a browser session with an old sign-in is refused; a fresh browser session queues it.
    const token = await t.dev(OMAR, "POST", `${ROUTE}/command`, { requestId: randomUUID(), command: "pip --version" });
    expect(token.status).toBe(403);
    t.ageSignIn(OMAR, 30);
    const stale = await t.web(OMAR, "POST", `${ROUTE}/command`, { requestId: randomUUID(), command: "pip --version" });
    expect(stale.status).toBeGreaterThanOrEqual(401);
    t.ageSignIn(OMAR, 1);
    const queued = await t.web(OMAR, "POST", `${ROUTE}/command`, { requestId: randomUUID(), command: "pip --version" });
    expect(queued.status, JSON.stringify(queued.body)).toBe(202);
    const polled = await t.callback(task.workspaceId, own.id, "setup-agent", { kind: "poll" });
    expect(polled).toMatchObject({ command: { seq: 1, command: "pip --version" }, hosts: [] });
    expect(JSON.stringify(polled)).not.toContain(OMAR.developerId);
    expect(await t.callback(task.workspaceId, own.id, "setup-agent", { kind: "poll" })).toMatchObject({ hosts: [] });
    expect(await t.callback(task.workspaceId, own.id, "setup-agent", { kind: "command_done", seq: 1, journalN: 2 })).toMatchObject({ finished: true });
    // A host ask: credited to the starter the broker recorded, never to a person named in the request.
    const asked = await t.callback(task.workspaceId, own.id, "setup-agent", { kind: "host", host: "artifactory.acme-build.io", journalN: 1, from: { path: "pip.conf", line: 2 }, viaCommandSeq: 1 });
    expect(asked).toMatchObject({ outcome: "created" });
    expect(t.db.find((item) => item.entityType === "SETUP_HOST_ASK")).toMatchObject([{ requestedBy: OMAR.developerId, typedBy: OMAR.developerId, taskId: task.taskId, state: "open" }]);
    expect(await t.callback(task.workspaceId, own.id, "setup-agent", { kind: "host", host: "pastebin.com" })).toMatchObject({ outcome: "refused", reason: "paste_site" });
    expect(await t.callback(task.workspaceId, own.id, "setup-agent", { kind: "poll" })).toMatchObject({ hosts: [{ host: "artifactory.acme-build.io", state: "open" }] });
  });

  it("refuses a body that names a person, a task or anything beyond its four shapes", async () => {
    process.env.SETUP_AGENT_ENABLED = "1";
    const t = await bench();
    const { task, own } = await started(t);
    for (const body of [{ kind: "host", host: "a.acme-build.io", requestedBy: MAYA.developerId }, { kind: "host", host: "a.acme-build.io", typedBy: MAYA.developerId }, { kind: "poll", taskId: task.taskId }, { kind: "other" }, { kind: "journal", entries: [] }]) {
      await expect(t.callback(task.workspaceId, own.id, "setup-agent", body)).rejects.toThrow();
    }
    expect(t.db.find((item) => item.entityType === "SETUP_HOST_ASK")).toEqual([]);
  });

  it("is refused for the prepare operation, for a draft's operation, and when the switch is off", async () => {
    process.env.SETUP_AGENT_ENABLED = "1";
    const t = await bench();
    const { task, own } = await started(t);
    const prepare = ops(t, task.workspaceId).find((operation) => operation.kind === "prepare")!;
    await expect(t.callback(task.workspaceId, prepare.id, "setup-agent", { kind: "poll" })).rejects.toThrow();
    delete process.env.SETUP_AGENT_ENABLED;
    await expect(t.callback(task.workspaceId, own.id, "setup-agent", { kind: "poll" })).rejects.toThrow();
  });
});

describe("the end", () => {
  it("a finished run is read again from its result, and never feeds the cost estimates", async () => {
    process.env.SETUP_AGENT_ENABLED = "1";
    const t = await bench();
    const { task, own } = await started(t);
    const summary = { stop: "attempts_used", commandsRun: 40, spendCents: 120, elapsedMs: 100000, hostAsks: 0, partial: true };
    await t.finish(task.workspaceId, own.id, "SUCCEEDED", { result: { conversationId: randomUUID(), reopened: false, workflowMode: "SETUP_AGENT", setupRunSummary: summary } });
    const state = await t.dev(OMAR, "GET", ROUTE);
    expect(state.body).toMatchObject({ status: "failed", stop: "attempts_used" });
    const record = t.db.get(taskKey(task.taskId)) as never;
    expect(await recordRunCost({ documentClient: t.db, tableName: "state", modelAccess: {} as never }, record, { path: "TASK", endedAt: new Date().toISOString() })).toBe("skipped");
    expect(t.db.get(taskKey(task.taskId))).not.toHaveProperty("runCostRecordedAt");
  });

  it("a stop by a maintainer is recorded as theirs and ends the run as a person's stop", async () => {
    process.env.SETUP_AGENT_ENABLED = "1";
    const t = await bench();
    await t.person(MAYA, "member", "maintainer");
    const { task } = await started(t);
    const stopped = await t.dev(MAYA, "POST", `${ROUTE}/stop`, { requestId: randomUUID() });
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(202);
    expect(t.db.get(taskKey(task.taskId))).toMatchObject({ setupAgentStop: { by: MAYA.developerId } });
  });
});

const taskInvocation = (payload: Record<string, unknown>) => ({
  protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "x".repeat(40),
  payload: { conversationId: randomUUID(), prompt: "p", ...payload },
});

describe("the payload on the wire", () => {
  it("a setup run carries its limits, and only a setup run does; it carries nothing else of a read-only look", () => {
    const limits = { limits: SETUP_AGENT_LIMITS_DEFAULT };
    expect(WorkerInvocationSchema.safeParse(taskInvocation({ workflowMode: "SETUP_AGENT", setupAgent: limits })).success).toBe(true);
    expect(WorkerInvocationSchema.safeParse(taskInvocation({ workflowMode: "SETUP_AGENT" })).success).toBe(false);
    expect(WorkerInvocationSchema.safeParse(taskInvocation({ workflowMode: "SETUP_DRAFT", setupAgent: limits })).success).toBe(false);
    expect(WorkerInvocationSchema.safeParse(taskInvocation({ setupAgent: limits })).success).toBe(false);
    expect(WorkerInvocationSchema.safeParse(taskInvocation({ workflowMode: "SETUP_AGENT", setupAgent: limits, testEnvDetect: true })).success).toBe(false);
    expect(WorkerInvocationSchema.safeParse(taskInvocation({ workflowMode: "SETUP_AGENT", setupAgent: { limits: { ...SETUP_AGENT_LIMITS_DEFAULT, commands: 1000 } } })).success).toBe(false);
    expect(WorkerInvocationSchema.safeParse(taskInvocation({ workflowMode: "SETUP_AGENT", setupAgent: { limits: SETUP_AGENT_LIMITS_DEFAULT, repository: "x" } })).success).toBe(false);
  });
  it("company recipes (SH30, switch sp) are offered to a detection only", () => {
    const offer = { recipeId: "node-npm", revision: 1, setupCommands: [], checks: [] };
    expect(WorkerInvocationSchema.safeParse(taskInvocation({ workflowMode: "SETUP_DRAFT", testEnvDetect: true, testEnvRecipes: [] })).success).toBe(true);
    expect(WorkerInvocationSchema.safeParse(taskInvocation({ workflowMode: "SETUP_DRAFT", testEnvRecipes: [offer] })).success).toBe(false);
    expect(WorkerInvocationSchema.safeParse(taskInvocation({ workflowMode: "PLAN", testEnvDetect: true })).success).toBe(false);
  });
  it("the worker lists both features it implements", async () => {
    const { WORKER_IMPLEMENTED_FEATURES } = await import("../../packages/worker/src/implemented-features.js");
    expect(WORKER_IMPLEMENTED_FEATURES).toContain("task.setupAgent.v1");
    expect(WORKER_IMPLEMENTED_FEATURES).toContain("task.setupRecipes.v1");
  });
});

describe("the feature", () => {
  it("is listed by the schema and required by delivery", () => {
    expect(SETUP_AGENT_FEATURE).toBe("task.setupAgent.v1");
  });
});
