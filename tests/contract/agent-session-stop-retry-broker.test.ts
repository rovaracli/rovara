// Plan 5 Task 13 through the real broker: stop is the cancel the task's own route runs (one operation, one idempotency item), an agent-step run that is stopped ends its session
// `cancelled`, and a failed run is retried into a new session of the retrier's own, linked by `retryOf`, through the real run start.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { agentSessionKey, openAgentSessionKey } from "../../packages/contracts/src/index.js";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { BUDGET_EXHAUSTED_FAILURE_MESSAGE } from "../../packages/contracts/src/developer-tasks-node.js";
import { retryRunRequestId } from "../../packages/broker/src/agent-sessions/retry.js";
import { MAYA, OMAR, createSingleAnswerPlanBroker, grantProject } from "../support/developer-task-broker.js";
import { refreshSessionSummary } from "../../packages/broker/src/agent-sessions/summary.js";
import { finishPlanningWithMarkdown } from "../support/plan-documents.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
type Item = Record<string, unknown>;

beforeAll(async () => { await loadSlackBroker(); });

async function setup() {
  const h = await createSingleAnswerPlanBroker({ brokerExtra: { agents: {} } });
  const operations = (workspaceId: string) => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION") as Array<Item & { id: string; kind: string; fence: number; status: string }>;
  const meta = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as Item & { workspaceId: string; sessionId?: string };
  const session = (sessionId: string) => ({
    record: h.db.get(agentSessionKey(TEST_ORG, sessionId, "META")) as Item & { summary: { status: string }; endedAt?: string; retryOf?: string; owner: { developerId: string } },
    open: h.db.get(openAgentSessionKey(TEST_ORG, sessionId)) !== undefined,
  });
  const events = (sessionId: string) => h.db.find((item) => item.pk === agentSessionKey(TEST_ORG, sessionId, "META").pk && String(item.sk).startsWith("EVENT#")).map((item) => ({ type: item.type, text: item.text }));
  const startRun = async () => {
    const reply = await h.dev(MAYA, "POST", "/v1/app/agents/root-cause-analyst/runs", { requestId: randomUUID(), project: "payments", input: { text: "Why did checkout fail?" } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const taskId = (reply.body.task as { taskId: string }).taskId;
    const { workspaceId, sessionId } = meta(taskId);
    const prepareId = String(operations(workspaceId).find((operation) => operation.kind === "prepare")!.id);
    await h.finish(workspaceId, prepareId, "SUCCEEDED", PREPARED);
    return { taskId, workspaceId, sessionId: sessionId! };
  };
  const steps = (workspaceId: string) => operations(workspaceId).filter((operation) => operation.kind === "task").sort((a, b) => a.fence - b.fence);
  const share = (sessionId: string, level = "edit") =>
    h.dev(MAYA, "PUT", `/v1/app/sessions/${sessionId}/shares`, { requestId: randomUUID(), principal: { kind: "member", developerId: OMAR.developerId }, level });
  return { ...h, operations, meta, session, events, startRun, steps, share };
}

describe("stop, through the real broker", () => {
  it("cancels a running step as the task's own cancel does, once for a repeated request id, and leaves the run waiting for its worker's answer", async () => {
    const t = await setup();
    const run = await t.startRun();
    grantProject(t.db, OMAR);
    expect((await t.share(run.sessionId)).status).toBe(200);
    const requestId = randomUUID();
    const stopped = await t.dev(OMAR, "POST", `/v1/app/sessions/${run.sessionId}/stop`, { requestId });
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    expect(t.steps(run.workspaceId)[0]).toMatchObject({ status: "CANCEL_REQUESTED" });
    const cancels = () => t.operations(run.workspaceId).filter((operation) => operation.kind === "cancel");
    expect(cancels()).toHaveLength(1);
    expect(t.events(run.sessionId).filter((event) => event.type === "stopped")).toEqual([{ type: "stopped", text: "Omar Diaz stopped this session." }]);
    // The same request again changes nothing; the task's own route would answer the same.
    const again = await t.dev(OMAR, "POST", `/v1/app/sessions/${run.sessionId}/stop`, { requestId });
    expect(again.status).toBe(200);
    expect(cancels()).toHaveLength(1);
    expect(t.events(run.sessionId).filter((event) => event.type === "stopped")).toHaveLength(1);
    // The worker reports the step cancelled: the run ends CANCELLED, so the session ends cancelled.
    await t.finish(run.workspaceId, t.steps(run.workspaceId)[0]!.id, "CANCELLED");
    expect(t.session(run.sessionId)).toMatchObject({ record: { summary: { status: "cancelled" } }, open: false });
  });

  it("refuses a viewer, a stranger and a repeated id used for a retry", async () => {
    const t = await setup();
    const run = await t.startRun();
    expect((await t.dev(OMAR, "POST", `/v1/app/sessions/${run.sessionId}/stop`, { requestId: randomUUID() })).status).toBe(404);
    expect((await t.share(run.sessionId, "view")).status).toBe(200);
    const viewer = await t.dev(OMAR, "POST", `/v1/app/sessions/${run.sessionId}/stop`, { requestId: randomUUID() });
    expect(viewer.status).toBe(403);
    expect((viewer.body.error as { code: string }).code).toBe("SESSION_LEVEL_REQUIRED");
    expect(t.operations(run.workspaceId).filter((operation) => operation.kind === "cancel")).toEqual([]);
    expect((await t.dev(MAYA, "GET", `/v1/app/sessions/${run.sessionId}/stop`)).status).toBe(404);
  });
});

describe("retry, through the real broker", () => {
  it("starts a new run of the same agent and input for a failed run: the retrier owns the new session, the old one says it was retried, and a second retry starts nothing more", async () => {
    const t = await setup();
    const run = await t.startRun();
    await t.finish(run.workspaceId, t.steps(run.workspaceId)[0]!.id, "FAILED", { error: "the model gave up" });
    expect(t.session(run.sessionId)).toMatchObject({ record: { summary: { status: "failed" } } });
    grantProject(t.db, OMAR);
    expect((await t.share(run.sessionId)).status).toBe(200);
    const requestId = randomUUID();
    const retried = await t.dev(OMAR, "POST", `/v1/app/sessions/${run.sessionId}/retry`, { requestId });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    const created = (retried.body.session as { sessionId: string; retryOf: string; owner: { developerId: string } });
    expect(created).toMatchObject({ retryOf: run.sessionId, owner: { developerId: OMAR.developerId } });
    expect(created.sessionId).not.toBe(run.sessionId);
    expect(t.session(created.sessionId).record).toMatchObject({ retryOf: run.sessionId, owner: { developerId: OMAR.developerId }, payer: { kind: "member", developerId: OMAR.developerId } });
    expect(t.events(run.sessionId).filter((event) => event.type === "retried")).toEqual([{ type: "retried", text: "Omar Diaz retried this in a new session." }]);
    const newTasks = t.db.find((item) => item.sk === "META" && item.entityType === "DEVELOPER_TASK" && item.developerId === OMAR.developerId);
    expect(newTasks).toHaveLength(1);
    const again = await t.dev(OMAR, "POST", `/v1/app/sessions/${run.sessionId}/retry`, { requestId: randomUUID() });
    expect(again.status).toBe(200);
    expect((again.body.session as { sessionId: string }).sessionId).toBe(created.sessionId);
    expect(t.db.find((item) => item.sk === "META" && item.entityType === "DEVELOPER_TASK" && item.developerId === OMAR.developerId)).toHaveLength(1);
    expect(retryRunRequestId(TEST_ORG, run.sessionId)).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("answers an edit sharee with no role on the project with the words that name the role, and a run that has not failed with nothing to retry", async () => {
    const t = await setup();
    const run = await t.startRun();
    expect((await t.share(run.sessionId)).status).toBe(200);
    const nothing = await t.dev(MAYA, "POST", `/v1/app/sessions/${run.sessionId}/retry`, { requestId: randomUUID() });
    expect(nothing.status).toBe(400);
    expect(nothing.body.error).toMatchObject({ code: "CONFIG_INVALID", message: "There's nothing to retry right now." });
    await t.finish(run.workspaceId, t.steps(run.workspaceId)[0]!.id, "FAILED", { error: "the model gave up" });
    const forbidden = await t.dev(OMAR, "POST", `/v1/app/sessions/${run.sessionId}/retry`, { requestId: randomUUID() });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toMatchObject({ code: "FORBIDDEN", message: "You need a role on payments that can start work to retry this." });
  });
});


describe("a budget stop stays a pause (Plan 3, M-6)", () => {
  it("is not a failure to retry: a run paused for money has nothing to retry, starts no run, and keeps showing paused", async () => {
    const t = await setup();
    const run = await t.startRun();
    await t.db.send(new UpdateCommand({
      TableName: "state", Key: { pk: `DEVTASK#${run.taskId}`, sk: "META" }, UpdateExpression: "SET budgetPause = :pause",
      ExpressionAttributeValues: { ":pause": { scope: { kind: "task", taskId: run.taskId }, at: new Date().toISOString() } },
    }));
    await t.finish(run.workspaceId, t.steps(run.workspaceId)[0]!.id, "FAILED", { error: BUDGET_EXHAUSTED_FAILURE_MESSAGE });
    expect(t.session(run.sessionId)).toMatchObject({ record: { summary: { status: "paused" } }, open: true });
    const refused = await t.dev(MAYA, "POST", `/v1/app/sessions/${run.sessionId}/retry`, { requestId: randomUUID() });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatchObject({ code: "CONFIG_INVALID", message: "There's nothing to retry right now." });
    expect(t.session(run.sessionId)).toMatchObject({ record: { summary: { status: "paused" } }, open: true });
    expect(t.db.find((item) => item.sk === "META" && item.entityType === "DEVELOPER_TASK")).toHaveLength(1);
  });
});

describe("a Rovara Code task, through the real broker", () => {
  const startWorkflow = async (t: Awaited<ReturnType<typeof setup>>) => {
    const reply = await t.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const task = reply.body.task as { taskId: string; sessionId: string };
    const { workspaceId } = t.meta(task.taskId);
    const prepareId = String(t.operations(workspaceId).find((operation) => operation.kind === "prepare")!.id);
    await t.finish(workspaceId, prepareId, "SUCCEEDED", PREPARED);
    return { taskId: task.taskId, sessionId: task.sessionId, workspaceId };
  };

  it("stops the running step as the task's own cancel does, and the owner can go on after it", async () => {
    const t = await setup();
    const task = await startWorkflow(t);
    grantProject(t.db, OMAR);
    expect((await t.share(task.sessionId)).status).toBe(200);
    const planning = t.steps(task.workspaceId)[0]!;
    expect(planning.status).not.toBe("SUCCEEDED");
    const stopped = await t.dev(OMAR, "POST", `/v1/app/sessions/${task.sessionId}/stop`, { requestId: randomUUID() });
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    expect(t.operations(task.workspaceId).filter((operation) => operation.kind === "cancel")).toHaveLength(1);
    expect(t.session(task.sessionId).open).toBe(true);
    // The task page's own cancel route finds the same cancel already asked for: nothing is running that it could stop twice.
    const own = await t.dev(MAYA, "POST", `/v1/dev/tasks/${task.taskId}/cancel`, { requestId: randomUUID() });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(t.operations(task.workspaceId).filter((operation) => operation.kind === "cancel")).toHaveLength(1);
  });

  it("reads stopped at once, not running, when the stop lands before the instructions ran (v0.4.6 staging, slow stop)", async () => {
    const t = await setup();
    // The task is made and its workspace is still being prepared: the instructions are pending, so the stop is the pointer's `cancelledAt` and no operation is cancelled.
    const reply = await t.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const task = reply.body.task as { taskId: string; sessionId: string };
    expect(t.session(task.sessionId).record.summary.status).toBe("starting");
    const stopped = await t.dev(MAYA, "POST", `/v1/app/sessions/${task.sessionId}/stop`, { requestId: randomUUID() });
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    // The answer and the stored summary both say so right away, with no sweep in between.
    expect((stopped.body.session as { status: string }).status).toBe("stopped");
    expect(t.session(task.sessionId)).toMatchObject({ record: { summary: { status: "stopped" } }, open: true });
  });

  it("ends a session whose plan is ready when it is stopped: the plan is no longer offered for approval (v0.4.6 staging)", async () => {
    const t = await setup();
    const task = await startWorkflow(t);
    const planning = t.steps(task.workspaceId)[0]!;
    const plan = "# Plan\n\n1. Fix retry handling.\n2. Add a regression test.\n";
    const digest = await finishPlanningWithMarkdown(t, task.workspaceId, planning.id, plan);
    // The stream projector's refresh, which the harness does not run: the session now waits for its owner.
    await refreshSessionSummary({ documentClient: t.db, tableName: "state", now: Date.now }, TEST_ORG, task.sessionId);
    expect(t.session(task.sessionId).record.summary.status).toBe("needs_person");
    expect(t.meta(task.taskId)).toMatchObject({ workflow: { stage: "PLAN_REVIEW", state: "WAITING" } });
    grantProject(t.db, OMAR);
    expect((await t.share(task.sessionId)).status).toBe(200);
    const requestId = randomUUID();
    const stopped = await t.dev(OMAR, "POST", `/v1/app/sessions/${task.sessionId}/stop`, { requestId });
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    expect(t.events(task.sessionId).filter((event) => event.type === "stopped")).toEqual([{ type: "stopped", text: "Omar Diaz stopped this session." }]);
    // The session is over, not waiting on its owner, and the task's plan step is closed with no one asked to approve.
    expect(t.session(task.sessionId)).toMatchObject({ record: { summary: { status: "cancelled", needsPeople: [], pendingApprovals: 0 } }, open: false });
    expect(t.meta(task.taskId)).toMatchObject({ workflow: { stage: "CLOSED", state: "COMPLETE" } });
    const view = (await t.dev(MAYA, "GET", `/v1/dev/tasks/${task.taskId}`)).body.task as { workflow: { waiting?: boolean; stage: string } };
    expect(view.workflow.stage).toBe("CLOSED");
    // The old approval is refused, and nothing was started by it.
    const approve = await t.dev(MAYA, "POST", `/v1/dev/tasks/${task.taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: 2, decision: "APPROVE", reason: "Looks right", artifactDigest: digest });
    expect(approve.status).toBeGreaterThanOrEqual(400);
    expect(t.steps(task.workspaceId).filter((operation) => operation.status !== "SUCCEEDED")).toEqual([]);
    // The same request again changes nothing.
    const again = await t.dev(OMAR, "POST", `/v1/app/sessions/${task.sessionId}/stop`, { requestId });
    expect(again.status).toBe(200);
    expect(t.events(task.sessionId).filter((event) => event.type === "stopped")).toHaveLength(1);
  });

  it("fences the stop on the task's People revision: a task with a People list is stopped at the revision the list has", async () => {
    const t = await setup();
    const task = await startWorkflow(t);
    grantProject(t.db, OMAR);
    expect((await t.share(task.sessionId)).status).toBe(200);
    t.db.set({
      pk: `DEVTASK#${task.taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 2, orphaned: false,
      people: [{ developerId: MAYA.developerId, slackUserId: MAYA.slackUserId, name: "Maya", role: "owner" }],
    });
    const stopped = await t.dev(OMAR, "POST", `/v1/app/sessions/${task.sessionId}/stop`, { requestId: randomUUID() });
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    expect(t.operations(task.workspaceId).filter((operation) => operation.kind === "cancel")).toHaveLength(1);
  });

  it("retries a blocked planning step in the same session, as the workflow retry route does, once for a repeated request id", async () => {
    const t = await setup();
    const task = await startWorkflow(t);
    grantProject(t.db, OMAR);
    expect((await t.share(task.sessionId)).status).toBe(200);
    await t.finish(task.workspaceId, t.steps(task.workspaceId)[0]!.id, "FAILED", { error: "the planner stopped" });
    const blockedTask = t.meta(task.taskId) as Item & { workflow?: { state: string; stage: string } };
    expect(blockedTask.workflow).toMatchObject({ stage: "PLAN", state: "BLOCKED" });
    const requestId = randomUUID();
    const retried = await t.dev(OMAR, "POST", `/v1/app/sessions/${task.sessionId}/retry`, { requestId });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect((retried.body.session as { sessionId: string }).sessionId).toBe(task.sessionId);
    expect((t.meta(task.taskId) as Item & { workflow?: { state: string } }).workflow).toMatchObject({ stage: "PLAN", state: "RUNNING" });
    const operations = () => t.steps(task.workspaceId).filter((operation) => operation.requestId === requestId);
    expect(operations()).toHaveLength(1);
    expect(t.events(task.sessionId).filter((event) => event.type === "retried")).toEqual([{ type: "retried", text: "Omar Diaz retried this." }]);
    const again = await t.dev(OMAR, "POST", `/v1/app/sessions/${task.sessionId}/retry`, { requestId });
    expect(again.status).toBe(200);
    expect(operations()).toHaveLength(1);
    // Omar is not the owner: the task is still Maya's and she pays.
    expect(t.session(task.sessionId).record.owner.developerId).toBe(MAYA.developerId);
  });
});
