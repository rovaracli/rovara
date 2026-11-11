// 058-stop-close (QA6-07, S3): a task the owner closed kept the state of its last step in the views: "Failed" with Retry (its last operation was INTERRUPTED), or "Finished" with "Waiting for
// a decision" (it was closed at the plan). The header, the pipeline, the actions and the merge block must all agree that it is closed.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createWorkflowSnapshot } from "../../packages/cloud-contracts/src/task-workflow-node.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import { refreshSessionSummary } from "../../packages/broker/src/agent-sessions/summary.js";
import { TEST_ORG } from "../support/orgs.js";

beforeAll(async () => { await loadSlackBroker(); });

const SAFE = { result: { safeToClose: true, repositories: [] } };

/** A task with a workflow in the given step whose last operation ended as given, closed through the real close. */
async function closedTask(input: { stage?: "PLAN" | "PLAN_REVIEW" | "IMPLEMENT" | "WAIT_FOR_MERGE"; state?: "RUNNING" | "WAITING" | "BLOCKED"; lastStatus: "SUCCEEDED" | "INTERRUPTED" | "FAILED" }) {
  const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {} } });
  const created = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
  const taskId = (created.body.task as { taskId: string }).taskId;
  const task = h.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workspaceId: string; sessionId: string };
  const { workspaceId, sessionId } = task;
  const meta = () => h.db.get(`WORKSPACE#${workspaceId}`, "META") as Record<string, unknown>;
  await h.finish(workspaceId, String(meta().activeOperationId), "SUCCEEDED");
  const operationId = String(meta().activeOperationId);
  if (input.lastStatus === "SUCCEEDED") await h.finish(workspaceId, operationId, "SUCCEEDED");
  else {
    // A stop that did not reach it, or a failed run: the operation ended and (for INTERRUPTED) still holds the workspace until the close frees it.
    (h.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`) as Record<string, unknown>).status = input.lastStatus;
    if (input.lastStatus === "FAILED") { delete meta().activeOperationId; meta().status = "READY"; }
  }
  if (input.stage !== undefined && input.state !== undefined) {
    const snapshot = createWorkflowSnapshot({ taskId, ownerId: MAYA.developerId, now: new Date().toISOString() });
    task.workflow = { ...snapshot, stage: input.stage, state: input.state };
  }
  delete (task as { agent?: unknown }).agent;
  const started = await h.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId: randomUUID() });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  await h.finish(workspaceId, String(meta().activeOperationId), "SUCCEEDED", SAFE);
  // The stream projector's refresh, which the harness does not run.
  const read = async () => { await refreshSessionSummary({ documentClient: h.db, tableName: "state", now: Date.now }, TEST_ORG, sessionId); return readSession(); };
  const readSession = async () => (await h.dev(MAYA, "GET", `/v1/app/sessions/${sessionId}`)).body.session as { status: string; step?: string; you: { actions: string[] }; body: { task: { status: string; merge?: unknown; workflow?: { state: string } } } };
  return { ...h, taskId, sessionId, read, readSession };
}

describe("a closed task reads as closed in every view", () => {
  it.each([
    ["closed at the plan after its last operation succeeded (QA T2: was Finished + Waiting for a decision)", { stage: "PLAN_REVIEW", state: "WAITING", lastStatus: "SUCCEEDED" }],
    ["closed after a stop that did not reach its build step (QA T1: was Failed + Working + Retry)", { stage: "IMPLEMENT", state: "RUNNING", lastStatus: "INTERRUPTED" }],
    ["closed after its last operation failed", { stage: "IMPLEMENT", state: "BLOCKED", lastStatus: "FAILED" }],
  ] as const)("%s", async (_name, input) => {
    const t = await closedTask(input);
    const session = await t.read();
    expect(session.body.task.status).toBe("CLOSED");
    // Neither "Finished" nor "Failed": the work did not finish and did not fail, it was closed.
    expect(session.status).toBe("cancelled");
    expect(session.body.task.merge).toBeUndefined();
    // Nothing can be started, stopped, retried or taken over on a closed task, and it cannot be closed again.
    for (const action of ["stop", "retry", "take_over", "steer", "close"]) expect(session.you.actions, action).not.toContain(action);
    expect(session.you.actions).toContain("watch");
    // Sharing a closed task starts no work, and stays for an edit-level person (review M3).
    expect(session.you.actions).toContain("share");
  });
});

it("before the projector has computed the summary, a plain task closed after a failed run reads closed, not succeeded (review M4)", async () => {
  const t = await closedTask({ lastStatus: "FAILED" });
  const session = await t.readSession();
  expect(session.body.task.status).toBe("CLOSED");
  expect(session.status).toBe("cancelled");
});
