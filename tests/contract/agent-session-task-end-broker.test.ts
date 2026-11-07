// Plan 5 Task 7b through the real broker: a broker that has agents registers the session's end and pause handlers when it starts, so a run that ends (or is
// paused for money) moves its session in the same call that tells Plan 3's handlers, with no stream record processed and no sweep run. A broker with no agents
// registers nothing (it has no sessions), so Plan 3's "nobody listens" behaviour is unchanged there.
import { randomUUID } from "node:crypto";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentSessionKey, openAgentSessionKey } from "../../packages/contracts/src/index.js";
import { BUDGET_EXHAUSTED_FAILURE_MESSAGE } from "../../packages/contracts/src/developer-tasks-node.js";
import { unregisterAgentSessionTaskHandlers } from "../../packages/broker/src/agent-sessions/index.js";
import { uninstallTicketUpdates } from "../../packages/broker/src/aws/broker/ticket-updates-wiring.js";
import { hasTaskEndHandlers, hasTaskPauseHandlers, registerTaskEndHandler } from "../../packages/broker/src/agents/task-end.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
type Item = Record<string, unknown>;

beforeAll(async () => { await loadSlackBroker(); });
afterEach(() => unregisterAgentSessionTaskHandlers());

async function setup(options: { agents?: boolean } = {}) {
  const h = await createDeveloperTaskBroker({ brokerExtra: options.agents === false ? {} : { agents: {} } });
  // Slice 5: a broker with developer sign-in also registers the ticket updates end handler, with or without agents. These tests are about the sessions' pair, so it is taken off
  // (ticket-updates.test.ts covers it with the real broker).
  uninstallTicketUpdates();
  const operations = (workspaceId: string) => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION") as Array<Item & { id: string; kind: string; fence: number }>;
  const stepOps = (workspaceId: string) => operations(workspaceId).filter((operation) => operation.kind === "task").sort((a, b) => a.fence - b.fence);
  const meta = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as Item & { workspaceId: string; sessionId?: string };
  const start = async () => {
    const reply = await h.dev(MAYA, "POST", "/v1/app/agents/root-cause-analyst/runs", { requestId: randomUUID(), project: "payments", input: { text: "Why did checkout fail?" } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const taskId = (reply.body.task as { taskId: string }).taskId;
    const { workspaceId } = meta(taskId);
    const prepareId = String(operations(workspaceId).find((operation) => operation.kind === "prepare")!.id);
    return { taskId, workspaceId, finishPrepare: () => h.finish(workspaceId, prepareId, "SUCCEEDED", PREPARED) };
  };
  const finishStep = (workspaceId: string, operationId: string, report: string) =>
    h.finish(workspaceId, operationId, "SUCCEEDED", { result: { agentStepResult: { report, outcome: "SUCCEEDED" } } });
  const session = (taskId: string) => {
    const sessionId = meta(taskId).sessionId!;
    return { sessionId, record: h.db.get(agentSessionKey(TEST_ORG, sessionId, "META")) as Item & { summary: { status: string }; endedAt?: string }, open: h.db.get(openAgentSessionKey(TEST_ORG, sessionId)) !== undefined };
  };
  const sessionEvents = (sessionId: string) => h.db.find((item) => item.pk === agentSessionKey(TEST_ORG, sessionId, "META").pk && String(item.sk).startsWith("EVENT#")).map((item) => item.text);
  return { ...h, stepOps, meta, start, finishStep, session, sessionEvents };
}

describe("a broker with agents follows its runs", () => {
  it("registers both handlers when it starts", async () => {
    unregisterAgentSessionTaskHandlers();
    expect(hasTaskEndHandlers()).toBe(false);
    expect(hasTaskPauseHandlers()).toBe(false);
    await setup();
    expect(hasTaskEndHandlers()).toBe(true);
    expect(hasTaskPauseHandlers()).toBe(true);
  });

  it("a run that completes ends its session in the call that told its end, with the stream and the sweep not run", async () => {
    const t = await setup();
    const run = await t.start();
    await run.finishPrepare();
    expect(t.session(run.taskId)).toMatchObject({ open: true, record: { summary: { status: "starting" } } });
    await t.finishStep(run.workspaceId, t.stepOps(run.workspaceId)[0]!.id, "Found it.");
    expect(t.session(run.taskId).open).toBe(true);
    await t.finishStep(run.workspaceId, t.stepOps(run.workspaceId)[1]!.id, "The retry was removed.");
    const ended = t.session(run.taskId);
    expect(ended.record.summary.status).toBe("succeeded");
    expect(ended.record.endedAt).toBeDefined();
    expect(ended.open).toBe(false);
    // UX2 slice 2: the timeline says the one status model's words; a run that succeeded and ended its session reads Closed (`taskStatusFromSession`).
    expect(t.sessionEvents(ended.sessionId).filter((text) => text === "Closed")).toHaveLength(1);
    // Plan 3 told the end once, and a repeat of the worker's last callback tells nothing more.
    expect(t.db.get(`DEVTASK#${run.taskId}`, "TASK_END")).toMatchObject({ done: true });
  });

  it("a run paused for its budget shows paused, open, with no end", async () => {
    const t = await setup();
    const run = await t.start();
    await run.finishPrepare();
    await t.db.send(new UpdateCommand({
      TableName: "state", Key: { pk: `DEVTASK#${run.taskId}`, sk: "META" }, UpdateExpression: "SET budgetPause = :pause",
      ExpressionAttributeValues: { ":pause": { scope: { kind: "task", taskId: run.taskId }, at: new Date().toISOString() } },
    }));
    await t.finish(run.workspaceId, t.stepOps(run.workspaceId)[0]!.id, "FAILED", { error: BUDGET_EXHAUSTED_FAILURE_MESSAGE });
    const paused = t.session(run.taskId);
    expect(paused.record.summary.status).toBe("paused");
    expect(paused.record.endedAt).toBeUndefined();
    expect(paused.open).toBe(true);
    expect(t.sessionEvents(paused.sessionId).some((text) => String(text).includes("Paused: needs more budget"))).toBe(true);
    expect(t.db.get(`DEVTASK#${run.taskId}`, "TASK_END")).toBeUndefined();
  });

  it("a handler registered after it that fails does not undo the session's end: Plan 3 keeps retrying that handler alone", async () => {
    const t = await setup();
    let failures = 2;
    const unregister = registerTaskEndHandler(async () => { if (failures > 0) { failures -= 1; throw new Error("down"); } });
    try {
      const run = await t.start();
      await run.finishPrepare();
      await t.finishStep(run.workspaceId, t.stepOps(run.workspaceId)[0]!.id, "One.");
      await t.finishStep(run.workspaceId, t.stepOps(run.workspaceId)[1]!.id, "Two.");
      expect(t.session(run.taskId).record.summary.status).toBe("succeeded");
      expect(t.db.get(`DEVTASK#${run.taskId}`, "TASK_END")).toMatchObject({ done: false, handlersTold: 1 });
      expect(t.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === run.taskId)).toHaveLength(1);
    } finally {
      unregister();
    }
  });
});

describe("a broker with no agents", () => {
  it("registers nothing: it has no sessions to follow", async () => {
    unregisterAgentSessionTaskHandlers();
    await setup({ agents: false });
    expect(hasTaskEndHandlers()).toBe(false);
    expect(hasTaskPauseHandlers()).toBe(false);
  });
});
