// Plan 3, M-6 (the merge 32-34 review, binding for Plans 4 and 5): a plain coding task that stops on a budget limit is PAUSED, not ended. Task 32 may resume it,
// so the end handlers (Plan 4's chains, Plan 5's sessions) must not hear a "failed" end that would block its keys and release its workspace. The pause handlers
// hear it instead, as they do for an agent-step run. The task's end is told when it really ends: the work finishes after the resume, the owner closes it
// (also after the request expired), or it is cancelled or fails for another reason. Whatever happens, an end is told once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { escalateOwnerRequests } from "../../packages/broker/src/spend/requests.js";
import { registerTaskEndHandler, registerTaskPauseHandler, type TaskEndEvent, type TaskPauseEvent } from "../../packages/broker/src/agents/task-end.js";
import { operationEndDispatchItem } from "../../packages/broker/src/aws/broker-shared.js";
import { BUDGET_EXHAUSTED_FAILURE_MESSAGE } from "@rovara-code/contracts";
import type { BudgetScope, SpendRequestRecord } from "@agentx/cloud-contracts";
import { MAYA } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { call } from "../support/slack-broker.js";
import { DEB, setup, type World } from "../support/spend-world.js";


// These tests expire requests 7 days on. Run late in a month, that crosses the month end, the month's budget resets and the paused task resumes, which is the
// product working and not what they check: so they run on a clock that is mid-month.
describe("the clock these tests run on", () => {
  it("is mid-month, far enough from the month end for a 7-day expiry to stay inside it", () => {
    const now = new Date();
    const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    expect(monthEnd - now.getTime()).toBeGreaterThan(10 * 86_400_000);
  });
});

const MEMBER: BudgetScope = { kind: "member", developerId: MAYA.developerId };

// Only `Date` is pinned (to the 10th of a month), so timers and promises run as they do.
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-10T12:00:00.000Z")); });

const unregister: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
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

  it("a pause that was never written is worked out by the ask first, so the stop is told as a pause, with its request", async () => {
    const t = await setup();
    const ended = endHandler();
    const paused = pauseHandler();
    const task = await t.plainTask();
    await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
    const asked = await call(t.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": (t.outboxOf(task.operationId)!.invocation as { callbackCapability: string }).callbackCapability } });
    expect(asked.status).toBe(200);
    t.access.setKeySpent(t.access.mintedKeys()[0]!, 14);
    await t.pauseAndEnd(task, "none");
    expect(t.requestOf(task.taskId)[0]).toMatchObject({ kind: "run_limit" });
    // The ask that worked the pause out recorded the operation it stopped (M-6 I-1).
    expect(t.meta(task.taskId).budgetStopOf).toBe(task.operationId);
    expect(paused).toEqual([expect.objectContaining({ taskId: task.taskId, scope: { kind: "task", taskId: task.taskId } })]);
    expect(ended).toEqual([]);
    expect(endRecords(t, task.taskId)).toEqual([]);
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
    // No handler listened at the stop, so nothing was told then: the row finds a task that went on since.
    const task = await stopped(t);
    await t.decide(DEB, monthRequests(t)[0]!.spendRequestId, "APPROVE", { amountUsd: 10 });
    expect(t.taskOps(task.workspaceId)).toHaveLength(2);
    const ended = endHandler();
    t.db.set((operationEndDispatchItem("state", { taskId: task.taskId, orgId: TEST_ORG, workspaceId: task.workspaceId, operationId: task.stoppedOperationId, now: new Date().toISOString() }) as { Put: { Item: Record<string, unknown> } }).Put.Item);
    await recover(t);
    expect(ended).toEqual([]);
    expect(rowsOf(t, task.taskId)).toEqual([]);
  });

  it("a budget stop that reaches a task already closed is told as its `closed` end, not as a pause", async () => {
    const t = await setup();
    const ended = endHandler();
    const paused = pauseHandler();
    const task = await t.plainTask();
    await t.set(task.taskId, "SET closedAt = :now", { ":now": new Date().toISOString() });
    await t.pauseAndEnd(task, MEMBER);
    expect(paused).toEqual([]);
    expect(ended).toEqual([expect.objectContaining({ taskId: task.taskId, outcome: "closed" })]);
  });

  it("closing a plain task that never stopped on a budget tells nothing, as before", async () => {
    const t = await setup();
    const task = await t.plainTask();
    await t.finish(task.workspaceId, task.operationId, "SUCCEEDED");
    // Nobody listened when its operation ended; a close tells nothing it was not owed (only a stop on a budget owes the end).
    const ended = endHandler();
    const closing = await t.api(MAYA, "POST", `/v1/dev/tasks/${task.taskId}/close`, {});
    expect(closing.status, JSON.stringify(closing.body)).toBe(200);
    const closeOperation = t.operations(task.workspaceId).find((operation) => operation.kind === "close")!;
    await t.finish(task.workspaceId, closeOperation.id, "SUCCEEDED", { result: { safeToClose: true, repositories: [] } });
    expect(t.meta(task.taskId)).toHaveProperty("closedAt");
    expect(ended).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The M-6 review (I-1, m-1, m-2, m-3)
// ---------------------------------------------------------------------------------------------------------------------------------------------

const dueNow = (t: World, taskId: string) => {
  const row = rowsOf(t, taskId)[0]!;
  t.db.set({ ...row, nextAttemptAt: "2026-01-01T00:00:00.000Z", dispatchDueSk: `2026-01-01T00:00:00.000Z#${String(row.sk)}` });
};
const failingOnce = <T>(register: (handler: (deps: unknown, event: T) => Promise<void>) => () => void) => {
  const events: T[] = [];
  let failures = 1;
  unregister.push(register(async (_deps, event) => {
    if (failures > 0) { failures -= 1; throw new Error("down"); }
    events.push(event);
  }));
  return events;
};
/** The task's next model key is refused for a used-up run limit: the mint writes the pause (and the operation it stopped), as the worker's key request does. */
async function refusedKey(t: World, task: { taskId: string; operationId: string }) {
  await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
  const headers = { "x-agentx-callback-capability": (t.outboxOf(task.operationId)!.invocation as { callbackCapability: string }).callbackCapability };
  expect((await call(t.handler, { method: "GET", path: "/v1/internal/model-access", headers })).status).toBe(200);
  t.access.setKeySpent(t.access.mintedKeys()[0]!, 14);
  expect((await call(t.handler, { method: "GET", path: "/v1/internal/model-access", headers })).status).toBe(402);
}

describe("M-6 review I-1: a stop that was a pause stays a pause once the pause is removed", () => {
  it("the pause handler throws, the approval removes the pause before the resume runs, the sweep tells nothing, and the end told later is `succeeded`, once", async () => {
    const t = await setup();
    const ended = endHandler();
    const paused = failingOnce<TaskPauseEvent>(registerTaskPauseHandler);
    const task = await t.plainTask();
    await refusedKey(t, task);
    await t.pauseAndEnd(task, "none");
    expect(paused).toEqual([]);
    expect(rowsOf(t, task.taskId)[0]).toMatchObject({ kind: "operation_end" });
    // The approval's transaction removed the pause; its resume has not run (it failed, and is logged).
    await t.set(task.taskId, "REMOVE budgetPause");
    dueNow(t, task.taskId);
    await recover(t);
    expect(ended).toEqual([]);
    expect(endRecords(t, task.taskId)).toEqual([]);
    expect(rowsOf(t, task.taskId)).toEqual([]);
    // The owner's Continue goes on and the task finishes: the first end it has is told, once.
    const continued = await t.api(MAYA, "POST", `/v1/dev/tasks/${task.taskId}/continue`, { instructions: "Go on" });
    expect(continued.status, JSON.stringify(continued.body)).toBe(200);
    const next = t.taskOps(task.workspaceId).at(-1)!;
    await t.finish(task.workspaceId, next.id, "SUCCEEDED");
    await t.finish(task.workspaceId, next.id, "SUCCEEDED");
    await recover(t);
    expect(ended).toEqual([expect.objectContaining({ taskId: task.taskId, outcome: "succeeded" })]);
  });

  it("a refusal records the operation it stopped, and a raise that removed the pause before the result came leaves the stop a pause, not a failure", async () => {
    const t = await setup();
    const ended = endHandler();
    const paused = pauseHandler();
    const task = await t.plainTask();
    await refusedKey(t, task);
    expect(t.meta(task.taskId)).toMatchObject({ budgetPause: { scope: { kind: "task" } }, budgetStopOf: task.operationId });
    // A month raise removed the pause while the stopped operation was still winding down.
    await t.set(task.taskId, "REMOVE budgetPause");
    await t.finish(task.workspaceId, task.operationId, "FAILED", { error: BUDGET_EXHAUSTED_FAILURE_MESSAGE });
    expect(ended).toEqual([]);
    expect(paused).toEqual([]);
    expect(endRecords(t, task.taskId)).toEqual([]);
  });
});

describe("M-6 review m-1: a stale stop is not told as a later operation's pause", () => {
  it("op1's pause tell failed and left a row; the task resumed and op2 stopped and was told; the sweep for op1 tells nothing more", async () => {
    const t = await setup();
    const ended = endHandler();
    const paused = failingOnce<TaskPauseEvent>(registerTaskPauseHandler);
    const task = await stopped(t);
    expect(paused).toEqual([]);
    await t.decide(DEB, monthRequests(t)[0]!.spendRequestId, "APPROVE", { amountUsd: 10 });
    const second = await t.pauseAndEnd(task, MEMBER);
    expect(second).not.toBe(task.stoppedOperationId);
    expect(paused).toEqual([expect.objectContaining({ taskId: task.taskId })]);
    expect(t.meta(task.taskId).budgetPauseToldFor).toBe(second);
    // The row of op1 (still due later) is looked at with op2's result, or by the sweep: either way it tells nothing.
    if (rowsOf(t, task.taskId).length > 0) dueNow(t, task.taskId);
    await recover(t);
    expect(paused).toHaveLength(1);
    expect(t.meta(task.taskId).budgetPauseToldFor).toBe(second);
    expect(rowsOf(t, task.taskId)).toEqual([]);
    expect(ended).toEqual([]);
  });
});

describe("M-6 review m-2: a `closed` end that could not be told is left to the recovery sweep", () => {
  it("a handler that throws leaves a row; the sweep tells `closed` once the handler can, then never again", async () => {
    const t = await setup();
    const ended: TaskEndEvent[] = [];
    let down = true;
    unregister.push(registerTaskEndHandler(async (_deps, event) => {
      if (down) throw new Error("down");
      ended.push(event);
    }));
    pauseHandler();
    const task = await stopped(t);
    const closing = await t.api(MAYA, "POST", `/v1/dev/tasks/${task.taskId}/close`, {});
    expect(closing.status, JSON.stringify(closing.body)).toBe(200);
    const closeOperation = t.operations(task.workspaceId).find((operation) => operation.kind === "close")!;
    await t.finish(task.workspaceId, closeOperation.id, "SUCCEEDED", { result: { safeToClose: true, repositories: [] } });
    expect(t.meta(task.taskId)).toHaveProperty("closedAt");
    expect(ended).toEqual([]);
    expect(rowsOf(t, task.taskId)[0]).toMatchObject({ kind: "operation_end", endOf: "closed" });
    down = false;
    // Another call holds the end: the row stays, still a `closed` row, due after the lease.
    const record = t.db.get(`DEVTASK#${task.taskId}`, "TASK_END")!;
    t.db.set({ ...record, leaseUntil: Date.now() + 120_000 });
    dueNow(t, task.taskId);
    await recover(t);
    expect(ended).toEqual([]);
    expect(rowsOf(t, task.taskId)[0]).toMatchObject({ kind: "operation_end", endOf: "closed" });
    expect(Date.parse(String(rowsOf(t, task.taskId)[0]!.nextAttemptAt))).toBeGreaterThan(Date.now());
    t.db.set({ ...record, leaseUntil: 1 });
    dueNow(t, task.taskId);
    await recover(t);
    expect(ended).toEqual([expect.objectContaining({ taskId: task.taskId, outcome: "closed" })]);
    expect(rowsOf(t, task.taskId)).toEqual([]);
    await recover(t);
    expect(ended).toHaveLength(1);
  });
});

describe("M-6 review m-3: a pause that could not be worked out is not told as a failure", () => {
  it("the ask fails on a transient error: nothing is told and a row is left; once it can run, the pause is told, not an end", async () => {
    const t = await setup();
    const ended = endHandler();
    const paused = pauseHandler();
    const task = await t.plainTask();
    await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
    const headers = { "x-agentx-callback-capability": (t.outboxOf(task.operationId)!.invocation as { callbackCapability: string }).callbackCapability };
    expect((await call(t.handler, { method: "GET", path: "/v1/internal/model-access", headers })).status).toBe(200);
    t.access.setKeySpent(t.access.mintedKeys()[0]!, 14);
    // The write of the worked-out pause fails (a transient DynamoDB error).
    const original = t.db.send.bind(t.db);
    let down = true;
    t.db.send = async (command: { input?: { UpdateExpression?: string } }) => {
      if (down && command.input?.UpdateExpression?.startsWith("SET #pause = :pause")) throw new Error("ProvisionedThroughputExceededException");
      return original(command as never);
    };
    await t.pauseAndEnd(task, "none");
    expect(ended).toEqual([]);
    expect(paused).toEqual([]);
    expect(endRecords(t, task.taskId)).toEqual([]);
    expect(rowsOf(t, task.taskId)[0]).toMatchObject({ kind: "operation_end" });
    down = false;
    dueNow(t, task.taskId);
    await recover(t);
    expect(paused).toEqual([expect.objectContaining({ taskId: task.taskId, scope: { kind: "task", taskId: task.taskId } })]);
    expect(ended).toEqual([]);
    expect(rowsOf(t, task.taskId)).toEqual([]);
  });
});
