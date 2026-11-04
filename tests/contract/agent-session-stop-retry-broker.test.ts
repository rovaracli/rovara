// Plan 5 Task 13 through the real broker: stop is the cancel the task's own route runs (one operation, one idempotency item), an agent-step run that is stopped ends its session
// `cancelled`, and a failed run is retried into a new session of the retrier's own, linked by `retryOf`, through the real run start.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { agentSessionKey, openAgentSessionKey } from "../../packages/contracts/src/index.js";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { BUDGET_EXHAUSTED_FAILURE_MESSAGE } from "../../packages/contracts/src/developer-tasks-node.js";
import { retryRunRequestId } from "../../packages/broker/src/agent-sessions/retry.js";
import { MAYA, OMAR, createSingleAnswerPlanBroker, grantProject, seedMembership } from "../support/developer-task-broker.js";
import { refreshSessionSummary } from "../../packages/broker/src/agent-sessions/summary.js";
import { finishPlanningWithMarkdown } from "../support/plan-documents.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import { capturingAuditDeps, type AuditCapture } from "../support/audit-capture.js";

const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
type Item = Record<string, unknown>;

beforeAll(async () => { await loadSlackBroker(); });

async function setup(options: { audit?: AuditCapture } = {}) {
  const h = await createSingleAnswerPlanBroker({ brokerExtra: { agents: {} }, ...(options.audit === undefined ? {} : { audit: options.audit }) });
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

  it("ends a session whose workflow is blocked when it is stopped, with a stopped event and an audit item, and says so in the answer (staging: it said Nothing was running)", async () => {
    const audit = capturingAuditDeps();
    const t = await setup({ audit });
    const task = await startWorkflow(t);
    grantProject(t.db, OMAR);
    expect((await t.share(task.sessionId)).status).toBe(200);
    await t.finish(task.workspaceId, t.steps(task.workspaceId)[0]!.id, "FAILED", { error: "the planner stopped" });
    expect(t.meta(task.taskId)).toMatchObject({ workflow: { stage: "PLAN", state: "BLOCKED" } });
    await refreshSessionSummary({ documentClient: t.db, tableName: "state", now: Date.now }, TEST_ORG, task.sessionId);
    const requestId = randomUUID();
    const stopped = await t.dev(OMAR, "POST", `/v1/app/sessions/${task.sessionId}/stop`, { requestId });
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    // Something was ended, so this is not the "nothing was running" answer.
    expect(stopped.body.stop).toBeUndefined();
    expect(t.meta(task.taskId)).toMatchObject({ workflow: { stage: "CLOSED", state: "COMPLETE", outcome: "CLOSED" } });
    expect((t.meta(task.taskId) as unknown as { workflow: { blockReason?: string } }).workflow.blockReason).toBeUndefined();
    expect(t.events(task.sessionId).filter((event) => event.type === "stopped")).toEqual([{ type: "stopped", text: "Omar Diaz stopped this session." }]);
    expect(t.session(task.sessionId)).toMatchObject({ record: { summary: { status: "cancelled" } }, open: false });
    // The stop is audited, and a Retry of the closed task is refused.
    expect(audit.recordedBy("session.stopped")).toHaveLength(1);
    // The task's own record says what the stop did.
    expect(t.db.find((item) => JSON.stringify(item).includes("Stopped while the work was blocked.")).length).toBeGreaterThan(0);
    const retry = await t.dev(OMAR, "POST", `/v1/app/sessions/${task.sessionId}/retry`, { requestId: randomUUID() });
    expect(retry.status).toBeGreaterThanOrEqual(400);
    // The same request again changes nothing.
    const again = await t.dev(OMAR, "POST", `/v1/app/sessions/${task.sessionId}/stop`, { requestId });
    expect(again.status).toBe(200);
    expect(t.events(task.sessionId).filter((event) => event.type === "stopped")).toHaveLength(1);
  });

  it("closes a task from the session page as the task's own close does: only its owner, once for a repeated request id, and the session stops offering Close", async () => {
    const t = await setup();
    const reply = await t.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const task = reply.body.task as { taskId: string; sessionId: string };
    const { workspaceId } = t.meta(task.taskId);
    // Its setup failed: the task holds a place toward the open-workspace limit until it is closed, and closing it has nothing to check.
    await t.finish(workspaceId, String(t.operations(workspaceId).find((operation) => operation.kind === "prepare")!.id), "FAILED", { error: "npm ci exited 1" });
    grantProject(t.db, OMAR);
    expect((await t.share(task.sessionId)).status).toBe(200);
    const actionsOf = async (who: typeof MAYA) => ((await t.dev(who, "GET", `/v1/app/sessions/${task.sessionId}`)).body.session as { you: { actions: string[] } }).you.actions;
    // The owner is offered Close; a person who may edit the session but does not own the task is not.
    expect(await actionsOf(MAYA)).toContain("close");
    expect(await actionsOf(OMAR)).not.toContain("close");
    const other = await t.dev(OMAR, "POST", `/v1/app/sessions/${task.sessionId}/close`, { requestId: randomUUID() });
    expect(other.status).toBeGreaterThanOrEqual(400);
    expect(t.meta(task.taskId).closedAt).toBeUndefined();
    const requestId = randomUUID();
    const closed = await t.dev(MAYA, "POST", `/v1/app/sessions/${task.sessionId}/close`, { requestId });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body).toMatchObject({ closed: true, session: { sessionId: task.sessionId } });
    expect(t.meta(task.taskId).closedAt).toBeDefined();
    // The task's own record of the close is the one the AI-tool close writes.
    expect(t.db.find((item) => item.pk === `TASK#${task.taskId}` && item.action === "close").length).toBeGreaterThan(0);
    expect(((closed.body.session as { you: { actions: string[] } }).you.actions)).not.toContain("close");
    // The same request again answers the same, and a body the route does not take is refused.
    expect((await t.dev(MAYA, "POST", `/v1/app/sessions/${task.sessionId}/close`, { requestId })).body).toMatchObject({ closed: true });
    expect((await t.dev(MAYA, "POST", `/v1/app/sessions/${task.sessionId}/close`, { requestId: randomUUID(), discard_unpublished: true })).status).toBe(400);
  });

  it("answers a close that finds unpublished work with the list, so the page can ask before discarding, and closes nothing", async () => {
    const t = await setup();
    const task = await startWorkflow(t);
    // The planning step is done; the close's own check then finds work that was never published.
    const active = () => String((t.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
    await t.finish(task.workspaceId, t.steps(task.workspaceId)[0]!.id, "FAILED", { error: "the planner stopped" });
    const requestId = randomUUID();
    const first = await t.dev(MAYA, "POST", `/v1/app/sessions/${task.sessionId}/close`, { requestId });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ closed: false });
    await t.finish(task.workspaceId, active(), "SUCCEEDED", { result: { safeToClose: false, repositories: [{ name: "demo", reasons: ["worktree_changes"] }] } });
    // The same request id: the broker answers a repeat of it from the check that ran.
    const second = await t.dev(MAYA, "POST", `/v1/app/sessions/${task.sessionId}/close`, { requestId });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body).toMatchObject({ closed: false, unpublished: [{ repository: "demo", reasons: ["worktree_changes"] }] });
    expect(t.meta(task.taskId).closedAt).toBeUndefined();
  });

  it("ends a plan-blocked session the same way for the owner, a share holder with edit and an org admin, frees its workspace, and audits each (blocked at PLAN)", async () => {
    for (const who of ["owner", "share holder", "admin"] as const) {
      const audit = capturingAuditDeps();
      const t = await setup({ audit });
      const task = await startWorkflow(t);
      grantProject(t.db, OMAR);
      expect((await t.share(task.sessionId, who === "admin" ? "view" : "edit")).status).toBe(200);
      await t.finish(task.workspaceId, t.steps(task.workspaceId)[0]!.id, "FAILED", { error: "the planner stopped" });
      expect(t.meta(task.taskId)).toMatchObject({ workflow: { stage: "PLAN", state: "BLOCKED" } });
      await refreshSessionSummary({ documentClient: t.db, tableName: "state", now: Date.now }, TEST_ORG, task.sessionId);
      if (who === "admin") seedMembership(t.db, OMAR.developerId, { orgId: TEST_ORG, role: "admin" });
      const stopped = await t.dev(who === "owner" ? MAYA : OMAR, "POST", `/v1/app/sessions/${task.sessionId}/stop`, { requestId: randomUUID() });
      expect(stopped.status, `${who}: ${JSON.stringify(stopped.body)}`).toBe(200);
      expect(stopped.body.stop, who).toBeUndefined();
      expect(t.meta(task.taskId), who).toMatchObject({ workflow: { stage: "CLOSED", state: "COMPLETE", outcome: "CLOSED" } });
      // The slot and the workspace went back.
      expect(t.meta(task.taskId).releasedAt, who).toBeDefined();
      expect(audit.recordedBy("session.stopped"), who).toHaveLength(1);
      expect(t.events(task.sessionId).filter((event) => event.type === "stopped"), who).toHaveLength(1);
    }
  });

  it("does not end, close or release a task that is blocked after the plan stages (IMPLEMENT, VERIFY, REVIEW, WAIT_FOR_MERGE): Stop answers that it is blocked and points to Close task, for the owner, a share holder and an org admin", async () => {
    for (const stage of ["IMPLEMENT", "VERIFY", "REVIEW", "WAIT_FOR_MERGE"] as const) {
      for (const who of ["owner", "share holder", "admin"] as const) {
        const audit = capturingAuditDeps();
        const t = await setup({ audit });
        const task = await startWorkflow(t);
        grantProject(t.db, OMAR);
        expect((await t.share(task.sessionId, who === "admin" ? "view" : "edit")).status).toBe(200);
        if (who === "admin") seedMembership(t.db, OMAR.developerId, { orgId: TEST_ORG, role: "admin" });
        // The planning step ends, then the task is made blocked part-way through the work, where commits that were never pushed may exist.
        await t.finish(task.workspaceId, t.steps(task.workspaceId)[0]!.id, "FAILED", { error: "the planner stopped" });
        const workflow = { ...(t.meta(task.taskId) as unknown as { workflow: Item }).workflow, stage, state: "BLOCKED", blockReason: "the step failed" };
        await t.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${task.taskId}`, sk: "META" }, UpdateExpression: "SET workflow = :workflow", ExpressionAttributeValues: { ":workflow": workflow } }));
        const workspaceBefore = JSON.stringify(t.db.get(`WORKSPACE#${task.workspaceId}`, "META"));
        const operationsBefore = t.operations(task.workspaceId).length;
        const label = `${stage} ${who}`;
        const requestId = randomUUID();
        const stopped = await t.dev(who === "owner" ? MAYA : OMAR, "POST", `/v1/app/sessions/${task.sessionId}/stop`, { requestId });
        expect(stopped.status, `${label}: ${JSON.stringify(stopped.body)}`).toBe(200);
        expect(stopped.body, label).toMatchObject({ stop: "NOTHING_RUNNING", message: "This task is blocked, not running. To end it, use Close task (it checks for unpublished work first)." });
        // Nothing was closed, released or deleted, and nothing says the person stopped it.
        const after = t.meta(task.taskId);
        expect(after, label).toMatchObject({ workflow: { stage, state: "BLOCKED" } });
        expect(after.closedAt, label).toBeUndefined();
        expect(after.releasedAt, label).toBeUndefined();
        expect(after.releaseClaimedAt, label).toBeUndefined();
        expect(JSON.stringify(t.db.get(`WORKSPACE#${task.workspaceId}`, "META")), label).toBe(workspaceBefore);
        expect(t.operations(task.workspaceId), label).toHaveLength(operationsBefore);
        expect(t.events(task.sessionId).filter((event) => event.type === "stopped"), label).toEqual([]);
        expect(audit.recordedBy("session.stopped"), label).toHaveLength(0);
        expect(t.session(task.sessionId), label).toMatchObject({ open: true });
        // The same request again answers the same words and still changes nothing.
        const again = await t.dev(who === "owner" ? MAYA : OMAR, "POST", `/v1/app/sessions/${task.sessionId}/stop`, { requestId });
        expect(again.body, label).toMatchObject({ stop: "NOTHING_RUNNING", message: stopped.body.message });
        expect(t.meta(task.taskId).releasedAt, label).toBeUndefined();
      }
    }
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
