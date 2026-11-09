// Lane 7: a replay COPY of a past task, started through the real `startTask`: the mark and the memory are written with the task; nothing about it is shared, published or announced; the end of its run tells
// nobody; its stream records make no notice. Positive controls: the same start without the copy mark does all of those.
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type * as BrokerModule from "../../packages/broker/src/aws/broker.js";
import { onTaskEnded, registerTaskEndHandler, type TaskEndHandler } from "../../packages/broker/src/agents/task-end.js";
import { noticesFromStream } from "../../packages/broker/src/developer/notifications.js";
import { REPLAY_COPY_REFUSAL } from "../../packages/broker/src/developer/eval-copy.js";
import { announcePlanOutcome, registerRovaraRecordListener } from "../../packages/broker/src/lessons/record-events.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { MAYA, createSingleAnswerPlanBroker, recordStream } from "../support/developer-task-broker.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

let createAgentRunStarter: typeof BrokerModule.createAgentRunStarter;
beforeAll(async () => {
  await loadSlackBroker();
  ({ createAgentRunStarter } = await import("../../packages/broker/src/aws/broker.js"));
});
const cleanups: Array<() => void> = [];
afterEach(() => { for (const clean of cleanups.splice(0)) clean(); });

async function world() {
  const access = fakeModelAccess();
  const h = await createSingleAnswerPlanBroker({ brokerExtra: { agents: {}, cloud: true, modelAccess: { access, proxyUrl: "http://internal-proxy.example.test:4000" } } });
  access.setMemberSpent(TEST_ORG, MAYA.developerId, 0);
  access.setOrgSpent(TEST_ORG, 0);
  const starter = createAgentRunStarter(h.brokerInput as never)!;
  const caller = (await starter.callerFor(TEST_ORG, MAYA.developerId))!;
  const stream = recordStream(h.db);
  const meta = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as unknown as DeveloperTaskRecord & Record<string, unknown>;
  const copy = async (extra: Record<string, unknown> = {}, memory: { mode: "off" } | { mode: "snapshot"; snapshotId: string } = { mode: "off" }, runLimitUsd = 2) =>
    starter.startTask(caller, { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "claude-code", ...extra },
      { origin: "cli", autonomous: false, startedBy: { developerId: MAYA.developerId }, runLimitUsd, evalReplay: { memory } });
  const ordinary = async () => starter.startTask(caller, { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "claude-code", shareToChannel: true },
    { origin: "cli", autonomous: false, startedBy: { developerId: MAYA.developerId } });
  return { h, starter, caller, stream, meta, copy, ordinary };
}

describe("starting a copy", () => {
  it("writes the eval mark and the memory with the task, and holds its spend to the run's own limit", async () => {
    const w = await world();
    const started = await w.copy({}, { mode: "snapshot", snapshotId: `snp_${"c".repeat(20)}` }, 1.5);
    const record = w.meta(started.task.taskId);
    expect(record).toMatchObject({ evalRun: true, evalMemory: { mode: "snapshot", snapshotId: `snp_${"c".repeat(20)}` }, shared: false });
    expect(record.share).toBeUndefined();
    expect(started.run.runLimitUsd).toBeLessThanOrEqual(1.5);
  });
  it("the same start without the copy mark has no mark (positive control), and a copy cannot be shared, put in a channel or given a thread", async () => {
    const w = await world();
    const plain = await w.starter.startTask(w.caller, { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "claude-code" }, { origin: "cli", autonomous: false, startedBy: { developerId: MAYA.developerId } });
    expect(w.meta(plain.task.taskId).evalRun).toBeUndefined();
    expect(w.meta(plain.task.taskId).evalMemory).toBeUndefined();
    for (const extra of [{ shareToChannel: true }, { channel: "C0123456789" }, { shareMode: "continue" }]) {
      await expect(w.copy(extra), JSON.stringify(extra)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
  });
});

describe("a copy is never announced", () => {
  it("makes no Slack/DM notice from the stream, where the same kind of task does (positive control)", async () => {
    const w = await world();
    w.stream.take();
    await w.ordinary();
    expect(noticesFromStream(w.stream.take()).length).toBeGreaterThan(0);
    const started = await w.copy();
    const records = w.stream.take();
    expect(records.length, "the copy's own writes reached the stream").toBeGreaterThan(0);
    expect(noticesFromStream(records)).toEqual([]);
    expect(w.meta(started.task.taskId).evalRun).toBe(true);
  });
  it("tells no task-end handler (no session note, Team record row, tracker comment, Slack or learning); an ordinary task tells them", async () => {
    const w = await world();
    const told: string[] = [];
    const handler: TaskEndHandler = async (_deps, event) => { told.push(event.taskId); };
    cleanups.push(registerTaskEndHandler(handler));
    const deps = { documentClient: w.h.db, tableName: "state", now: Date.now };
    const ordinary = await w.ordinary();
    await onTaskEnded(deps, w.meta(ordinary.task.taskId), "merged");
    expect(told).toEqual([ordinary.task.taskId]);
    const copy = await w.copy();
    expect(await onTaskEnded(deps as never, w.meta(copy.task.taskId), "merged")).toBe("called");
    expect(told).toEqual([ordinary.task.taskId]);
  });
  it("writes no Team record row for the task (plan or review outcome, remembered note)", async () => {
    const w = await world();
    const heard = vi.fn(async () => undefined);
    cleanups.push(registerRovaraRecordListener(heard));
    const ordinary = w.meta((await w.ordinary()).task.taskId);
    await announcePlanOutcome(ordinary, { planId: "p1", outcome: "approved", claims: 0, claimsHeld: 0, at: new Date().toISOString() });
    expect(heard).toHaveBeenCalledTimes(1);
    const copy = w.meta((await w.copy()).task.taskId);
    await announcePlanOutcome(copy, { planId: "p2", outcome: "approved", claims: 0, claimsHeld: 0, at: new Date().toISOString() });
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe("a copy is never published", () => {
  it("is refused a pull request on the real repository, as its own owner", async () => {
    const w = await world();
    const copy = await w.copy();
    const refused = await w.h.dev(MAYA, "POST", `/v1/dev/tasks/${copy.task.taskId}/pull-requests`, { requestId: randomUUID(), title: "Fix the retry bug" });
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toContain(REPLAY_COPY_REFUSAL);
    const ordinary = await w.ordinary();
    const other = await w.h.dev(MAYA, "POST", `/v1/dev/tasks/${ordinary.task.taskId}/pull-requests`, { requestId: randomUUID(), title: "Fix the retry bug" });
    expect(JSON.stringify(other.body)).not.toContain(REPLAY_COPY_REFUSAL);
  });
});
