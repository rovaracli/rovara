// Plan 3, M-6 (the merge 32-34 review, binding for Plans 4 and 5): a plain coding task that stops on a budget limit is PAUSED, not ended. Task 32 may resume it,
// so the end handlers (Plan 4's chains, Plan 5's sessions) must not hear a "failed" end that would block its keys and release its workspace. The pause handlers
// hear it instead, as they do for an agent-step run. The task's end is told when it really ends: the work finishes after the resume, the owner closes it
// (also after the request expired), or it is cancelled or fails for another reason. Whatever happens, an end is told once.
import { afterEach, describe, expect, it } from "vitest";
import { escalateOwnerRequests } from "../../packages/broker/src/spend/requests.js";
import { registerTaskEndHandler, registerTaskPauseHandler, type TaskEndEvent, type TaskPauseEvent } from "../../packages/broker/src/agents/task-end.js";
import { operationEndDispatchItem } from "../../packages/broker/src/aws/broker-shared.js";
import { BUDGET_EXHAUSTED_FAILURE_MESSAGE } from "../../packages/contracts/src/developer-tasks.js";
import type { BudgetScope, SpendRequestRecord } from "@agentx/contracts";
import { MAYA } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { DEB, setup, type World } from "../support/spend-world.js";

const MEMBER: BudgetScope = { kind: "member", developerId: MAYA.developerId };

const unregister: Array<() => void> = [];
afterEach(() => {
  while (unregister.length > 0) unregister.pop()!();
});

const endHandler = () => {
  const events: TaskEndEvent[] = [];
  unregister.push(registerTaskEndHandler(async (_deps, event) => { events.push(event); }));
  return events;
};
const pauseHandler = () => {
  const events: TaskPauseEvent[] = [];
  unregister.push(registerTaskPauseHandler(async (_deps, event) => { events.push(event); }));
  return events;
};
const monthRequests = (t: World): SpendRequestRecord[] => t.requests().filter((record) => record.kind === "month");
const rowsOf = (t: World, taskId: string) => t.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === taskId);
const endRecords = (t: World, taskId: string) => t.db.find((item) => item.pk === `DEVTASK#${taskId}` && item.sk === "TASK_END");
const workspaceStatus = (t: World, workspaceId: string) => (t.db.get(`WORKSPACE#${workspaceId}`, "META") as { status: string }).status;
const recover = (t: World) => t.handler({ source: "agentx.workflow-dispatch-recovery" });

/** The task has stopped on its member's budget: its budget pause is written, the running operation ended out of budget, and the request was made. */
async function stopped(t: World) {
  const task = await t.plainTask();
  const operationId = await t.pauseAndEnd(task, MEMBER);
  return { ...task, stoppedOperationId: operationId };
}

describe("M-6: a plain task stopped on a budget is paused, not ended", () => {
  it("tells the pause handlers, not the end handlers, and keeps the task's keys and workspace", async () => {
    const t = await setup();
    const ended = endHandler();
    const paused = pauseHandler();
    const task = await stopped(t);
    expect(paused).toEqual([expect.objectContaining({ orgId: TEST_ORG, taskId: task.taskId, scope: MEMBER })]);
    expect(ended).toEqual([]);
    // The request was asked for as before (Task 32/33), and the end is not recorded, so nothing was released.
    expect(monthRequests(t)).toHaveLength(1);
    expect(endRecords(t, task.taskId)).toEqual([]);
    expect(t.meta(task.taskId).releasedAt).toBeUndefined();
    expect(workspaceStatus(t, task.workspaceId)).toBe("READY");
    expect(t.meta(task.taskId).budgetPause).toMatchObject({ scope: MEMBER });
    // Nothing is left for the recovery sweep: the pause was told.
    expect(rowsOf(t, task.taskId)).toEqual([]);
  });

  it("tells the pause to a pause handler alone, and still keeps the end", async () => {
    const t = await setup();
    const paused = pauseHandler();
    const task = await stopped(t);
    expect(paused).toHaveLength(1);
    expect(endRecords(t, task.taskId)).toEqual([]);
  });

  it("after the raise is approved the task resumes and finishes: the end handlers hear one end, `succeeded`, and only then", async () => {
    const t = await setup();
    const ended = endHandler();
    const paused = pauseHandler();
    const task = await stopped(t);
    await t.decide(DEB, monthRequests(t)[0]!.spendRequestId, "APPROVE", { amountUsd: 10 });
    const operations = t.taskOps(task.workspaceId);
    expect(operations).toHaveLength(2);
    expect(ended).toEqual([]);
    await t.finish(task.workspaceId, operations[1]!.id, "SUCCEEDED");
    expect(ended).toEqual([expect.objectContaining({ orgId: TEST_ORG, taskId: task.taskId, outcome: "succeeded" })]);
    // Hearing the same result again, or the recovery sweep, tells nobody again.
    await t.finish(task.workspaceId, operations[1]!.id, "SUCCEEDED");
    await recover(t);
    expect(ended).toHaveLength(1);
    expect(paused).toHaveLength(1);
    expect(endRecords(t, task.taskId)).toHaveLength(1);
  });

  it("a resumed task that stops on its budget again is told as paused again, and still not as ended", async () => {
    const t = await setup();
    const ended = endHandler();
    const paused = pauseHandler();
    const task = await stopped(t);
    await t.decide(DEB, monthRequests(t)[0]!.spendRequestId, "APPROVE", { amountUsd: 10 });
    await t.pauseAndEnd(task, MEMBER);
    expect(paused).toHaveLength(2);
    expect(ended).toEqual([]);
  });

  it("a request that expires leaves the task paused (no end); closing the task then tells `closed` once", async () => {
    const t = await setup();
    const ended = endHandler();
    pauseHandler();
    const task = await stopped(t);
    const request = monthRequests(t)[0]!;
    expect(await escalateOwnerRequests(t.deps(() => Date.parse(request.expiresAt) + 1), { budgetMs: 5_000 })).toMatchObject({ expired: 1 });
    expect(ended).toEqual([]);
    const closing = await t.api(MAYA, "POST", `/v1/dev/tasks/${task.taskId}/close`, {});
    expect(closing.status, JSON.stringify(closing.body)).toBe(200);
    const closeOperation = t.operations(task.workspaceId).find((operation) => operation.kind === "close")!;
    await t.finish(task.workspaceId, closeOperation.id, "SUCCEEDED", { result: { safeToClose: true, repositories: [] } });
    expect(t.meta(task.taskId)).toHaveProperty("closedAt");
    expect(ended).toEqual([expect.objectContaining({ taskId: task.taskId, outcome: "closed" })]);
    // The close's own result again, and the recovery sweep.
    await t.finish(task.workspaceId, closeOperation.id, "SUCCEEDED", { result: { safeToClose: true, repositories: [] } });
    await recover(t);
    expect(ended).toHaveLength(1);
  });

  it("a budget stop with no budget pause and nothing resumed (the pause could not be worked out) is a failed task: the end is told", async () => {
    const t = await setup();
    const ended = endHandler();
    const paused = pauseHandler();
    const task = await t.plainTask();
    await t.pauseAndEnd(task, "none");
    expect(paused).toEqual([]);
    expect(ended).toEqual([expect.objectContaining({ taskId: task.taskId, outcome: "failed" })]);
  });

  it("a task that fails for another reason is told as failed, as before", async () => {
    const t = await setup();
    const ended = endHandler();
    const paused = pauseHandler();
    const task = await t.plainTask();
    await t.finish(task.workspaceId, task.operationId, "FAILED", { error: "the model gave up" });
    expect(ended).toEqual([expect.objectContaining({ taskId: task.taskId, outcome: "failed" })]);
    expect(paused).toEqual([]);
  });
});

describe("M-6: a pause is told at most once, and until it is told", () => {
  it("a replay of the stopped operation's result tells the pause once, and the recovery sweep tells nothing more", async () => {
    const t = await setup();
    const ended = endHandler();
    const paused = pauseHandler();
    const task = await stopped(t);
    await t.finish(task.workspaceId, task.stoppedOperationId, "FAILED", { error: BUDGET_EXHAUSTED_FAILURE_MESSAGE });
    expect(paused).toHaveLength(1);
    // A recovery row for the operation (the reaper or a stuck cancel leaves one) finds the pause already told: it tells neither a pause nor an end.
    t.db.set((operationEndDispatchItem("state", { taskId: task.taskId, orgId: TEST_ORG, workspaceId: task.workspaceId, operationId: task.stoppedOperationId, now: new Date().toISOString() }) as { Put: { Item: Record<string, unknown> } }).Put.Item);
    await recover(t);
    expect(paused).toHaveLength(1);
    expect(ended).toEqual([]);
    expect(rowsOf(t, task.taskId)).toEqual([]);
    expect(endRecords(t, task.taskId)).toEqual([]);
  });

  it("a pause handler that throws once leaves a recovery row; the sweep tells the pause again, then once", async () => {
    const t = await setup();
    const ended = endHandler();
    const paused: TaskPauseEvent[] = [];
    let failures = 1;
    unregister.push(registerTaskPauseHandler(async (_deps, event) => {
      if (failures > 0) { failures -= 1; throw new Error("down"); }
      paused.push(event);
    }));
    const task = await stopped(t);
    expect(paused).toEqual([]);
    const row = rowsOf(t, task.taskId)[0];
    expect(row).toMatchObject({ kind: "operation_end" });
    t.db.set({ ...row!, nextAttemptAt: "2026-01-01T00:00:00.000Z", dispatchDueSk: `2026-01-01T00:00:00.000Z#${String(row!.sk)}` });
    await recover(t);
    expect(paused).toEqual([expect.objectContaining({ taskId: task.taskId, scope: MEMBER })]);
    expect(ended).toEqual([]);
    expect(rowsOf(t, task.taskId)).toEqual([]);
    await recover(t);
    expect(paused).toHaveLength(1);
  });

  it("a stopped operation whose task was resumed before the sweep looked is told as nothing: not an end", async () => {
    const t = await setup();
    const ended = endHandler();
    const task = await stopped(t);
    await t.decide(DEB, monthRequests(t)[0]!.spendRequestId, "APPROVE", { amountUsd: 10 });
    t.db.set((operationEndDispatchItem("state", { taskId: task.taskId, orgId: TEST_ORG, workspaceId: task.workspaceId, operationId: task.stoppedOperationId, now: new Date().toISOString() }) as { Put: { Item: Record<string, unknown> } }).Put.Item);
    await recover(t);
    expect(ended).toEqual([]);
    expect(rowsOf(t, task.taskId)).toEqual([]);
  });
});
