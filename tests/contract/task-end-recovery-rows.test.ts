// Plan 3 Task 22 hand-off (binding for Plan 5 Task 7b): a workflow task that merged or closed, and a task whose creator was removed, are told to the end handlers
// at most once AND have a durable recovery row when the telling is not finished, as a plain task's operation end has. Before this, a handler that threw (or a
// call that met another one telling) left only the TASK_END record, and nothing came back to finish it once the task's workspace was released or the
// creator's next call hit the already-recorded outcome. The row is the `operation_end` row with `endOf: "workflow"` or `"creator_removed"`; the broker's recovery
// sweep tells the task's end from the task itself (never from the row), once.
import { randomUUID } from "node:crypto";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { orgMemberKey, orgRemovedKey } from "../../packages/contracts/src/org.js";
import { registerTaskEndHandler, type TaskEndEvent, taskEndKey } from "../../packages/broker/src/agents/task-end.js";
import { requireCreatorStillMember } from "../../packages/broker/src/developer/creator-member.js";
import { releaseFinishedTaskQuietly } from "../../packages/broker/src/aws/developer-tasks.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

type Item = Record<string, unknown>;
beforeAll(async () => { await loadSlackBroker(); });
const unregister: Array<() => void> = [];
afterEach(() => { while (unregister.length > 0) unregister.pop()!(); });

/** A handler that is down until `up.now` is true; it records the ends it heard. */
function flakyHandler() {
  const up = { now: false };
  const heard: TaskEndEvent[] = [];
  unregister.push(registerTaskEndHandler(async (_deps, event) => {
    if (!up.now) throw new Error("down");
    heard.push(event);
  }));
  return { up, heard };
}

async function setup() {
  const h = await createDeveloperTaskBroker({ brokerExtra: {} });
  const plainTask = async () => {
    const started = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
    const taskId = (started.body.task as { taskId: string }).taskId;
    return taskId;
  };
  const meta = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as Item & { workflow?: Item };
  const rows = (taskId: string) => h.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.kind === "operation_end" && item.taskId === taskId);
  const finishWorkflow = (taskId: string, stage: "MERGED" | "CLOSED") => {
    const record = meta(taskId);
    h.db.set({ ...record, workflow: { ...record.workflow, stage, state: "COMPLETE", outcome: stage === "MERGED" ? "MERGED" : "REJECTED" } });
  };
  const release = (taskId: string) => releaseFinishedTaskQuietly({ tableName: "state", actions: h.actions, documentClient: h.db }, taskId);
  const recover = async (taskId: string) => {
    const row = rows(taskId)[0]!;
    h.db.set({ ...row, nextAttemptAt: "2026-01-01T00:00:00.000Z", dispatchDueSk: `2026-01-01T00:00:00.000Z#${String(row.sk)}` });
    await h.handler({ source: "agentx.workflow-dispatch-recovery" });
  };
  return { ...h, plainTask, meta, rows, finishWorkflow, release, recover };
}

describe("a workflow task that merged or closed", () => {
  it.each([["MERGED", "merged"], ["CLOSED", "closed"]] as const)("leaves a recovery row when its %s end could not be told, and the sweep tells it once", async (stage, outcome) => {
    const t = await setup();
    const { up, heard } = flakyHandler();
    const taskId = await t.plainTask();
    t.finishWorkflow(taskId, stage);
    await t.release(taskId);
    expect(heard).toEqual([]);
    expect(t.rows(taskId)).toEqual([expect.objectContaining({ endOf: "workflow", orgId: TEST_ORG })]);
    expect(t.db.get(taskEndKey(taskId))).toMatchObject({ done: false });
    up.now = true;
    await t.recover(taskId);
    expect(heard).toEqual([expect.objectContaining({ taskId, orgId: TEST_ORG, outcome })]);
    expect(t.rows(taskId)).toEqual([]);
    expect(t.db.get(taskEndKey(taskId))).toMatchObject({ done: true });
    // A second pass of the sweep, and the release run again, tell nothing more.
    await t.release(taskId);
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(heard).toHaveLength(1);
  });

  it("keeps the row (due again when the other call's lease runs out) while another call is telling the end", async () => {
    const t = await setup();
    const heard: TaskEndEvent[] = [];
    unregister.push(registerTaskEndHandler(async (_deps, event) => { heard.push(event); }));
    const taskId = await t.plainTask();
    t.finishWorkflow(taskId, "MERGED");
    // Another call has claimed the end and has not finished: the TASK_END record holds its lease.
    t.db.set({ ...taskEndKey(taskId), entityType: "TASK_END", orgId: TEST_ORG, outcome: "merged", handlersTold: 0, done: false, leaseUntil: Date.now() + 60_000 });
    await t.release(taskId);
    expect(heard).toEqual([]);
    const [row] = t.rows(taskId);
    expect(row).toMatchObject({ endOf: "workflow" });
    expect(Date.parse(String(row!.nextAttemptAt))).toBeGreaterThan(Date.now());
  });

  it("leaves no row when every handler heard the end, or nobody listens", async () => {
    const t = await setup();
    const quiet = await t.plainTask();
    t.finishWorkflow(quiet, "MERGED");
    await t.release(quiet);
    expect(t.rows(quiet)).toEqual([]);
    expect(t.db.get(taskEndKey(quiet))).toBeUndefined();
    const heard: TaskEndEvent[] = [];
    unregister.push(registerTaskEndHandler(async (_deps, event) => { heard.push(event); }));
    const told = await t.plainTask();
    t.finishWorkflow(told, "MERGED");
    await t.release(told);
    expect(heard).toHaveLength(1);
    expect(t.rows(told)).toEqual([]);
  });

  it("drops a row whose task is not at a workflow end any more (nothing is told)", async () => {
    const t = await setup();
    const { up, heard } = flakyHandler();
    const taskId = await t.plainTask();
    t.finishWorkflow(taskId, "MERGED");
    await t.release(taskId);
    expect(t.rows(taskId)).toHaveLength(1);
    // The workflow is not complete any more (a send-back): the end is not owed.
    const record = t.meta(taskId);
    t.db.set({ ...record, workflow: { ...record.workflow, stage: "IMPLEMENT", state: "RUNNING", outcome: undefined } });
    up.now = true;
    await t.recover(taskId);
    expect(heard).toEqual([]);
    expect(t.rows(taskId)).toEqual([]);
  });

  it("drops a row that names another org than the task's, and tells nothing", async () => {
    const t = await setup();
    const { up, heard } = flakyHandler();
    const taskId = await t.plainTask();
    t.finishWorkflow(taskId, "MERGED");
    await t.release(taskId);
    t.db.set({ ...t.rows(taskId)[0]!, orgId: "org_bbbbbbbbbbbbbbbbbbbb" });
    up.now = true;
    await t.recover(taskId);
    expect(heard).toEqual([]);
    expect(t.rows(taskId)).toEqual([]);
  });

  it("is retried with the row's backoff while a handler stays down, and tells nothing early", async () => {
    const t = await setup();
    const { up, heard } = flakyHandler();
    const taskId = await t.plainTask();
    t.finishWorkflow(taskId, "MERGED");
    await t.release(taskId);
    await t.recover(taskId);
    expect(heard).toEqual([]);
    expect(t.rows(taskId)).toHaveLength(1);
    up.now = true;
    await t.recover(taskId);
    expect(heard).toHaveLength(1);
    expect(t.rows(taskId)).toEqual([]);
  });
});

describe("a task whose creator was removed", () => {
  const removeCreator = (t: Awaited<ReturnType<typeof setup>>) => {
    return Promise.all([
      t.db.send(new DeleteCommand({ TableName: "state", Key: orgMemberKey(TEST_ORG, MAYA.developerId) })),
      Promise.resolve(t.db.set({ ...orgRemovedKey(TEST_ORG, MAYA.developerId), entityType: "ORG_REMOVED", removedAt: "2026-10-21T00:00:00.000Z" })),
    ]);
  };
  const check = (t: Awaited<ReturnType<typeof setup>>, taskId: string) =>
    requireCreatorStillMember({ documentClient: t.db, tableName: "state", orgId: TEST_ORG }, t.meta(taskId) as never);

  it("leaves a recovery row when the end could not be told, however often the check refuses after that, and the sweep tells it once", async () => {
    const t = await setup();
    const { up, heard } = flakyHandler();
    const taskId = await t.plainTask();
    await removeCreator(t);
    await expect(check(t, taskId)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
    await expect(check(t, taskId)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
    expect(heard).toEqual([]);
    expect(t.rows(taskId)).toEqual([expect.objectContaining({ endOf: "creator_removed", orgId: TEST_ORG })]);
    up.now = true;
    await t.recover(taskId);
    expect(heard).toEqual([expect.objectContaining({ taskId, outcome: "creator_removed" })]);
    expect(t.rows(taskId)).toEqual([]);
    await expect(check(t, taskId)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(heard).toHaveLength(1);
  });

  it("leaves no row when the end was told", async () => {
    const t = await setup();
    const heard: TaskEndEvent[] = [];
    unregister.push(registerTaskEndHandler(async (_deps, event) => { heard.push(event); }));
    const taskId = await t.plainTask();
    await removeCreator(t);
    await expect(check(t, taskId)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
    expect(heard).toHaveLength(1);
    expect(t.rows(taskId)).toEqual([]);
  });

  it("a row whose task's creator was not removed tells nothing and goes", async () => {
    const t = await setup();
    const { up, heard } = flakyHandler();
    const taskId = await t.plainTask();
    await removeCreator(t);
    await expect(check(t, taskId)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
    expect(t.rows(taskId)).toHaveLength(1);
    // The outcome is gone from the task (it was never creator_removed after all).
    const { outcome: _outcome, outcomeReason: _reason, outcomeAt: _at, ...rest } = t.meta(taskId); // eslint-disable-line @typescript-eslint/no-unused-vars -- the outcome fields are dropped
    t.db.set(rest);
    up.now = true;
    await t.recover(taskId);
    expect(heard).toEqual([]);
    expect(t.rows(taskId)).toEqual([]);
  });
});
