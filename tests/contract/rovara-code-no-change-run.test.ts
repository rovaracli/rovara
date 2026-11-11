// Staging 0.4.10, bug B: a read-only task started with `start_task` (the plain task flow: no workflow, no Understand, so no question-only path) answered from the repository and then ended FAILED
// "CONFIG_INVALID: the coding run left the code as it was when the task started". A plain task has no plan or approval to hold a no-change run against: the run finished, and the answer is in
// its transcript. Only a workflow task's approved build that changes nothing is a stop (rovara-code-answered.test.ts: noCodeChanged).
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { WORKFLOW_NO_CODE_CHANGE_MESSAGE } from "@rovara-code/contracts";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { loadSlackBroker } from "../support/slack-broker.js";

beforeAll(async () => {
  await loadSlackBroker();
});

const WORKER_ERROR = `CONFIG_INVALID: ${WORKFLOW_NO_CODE_CHANGE_MESSAGE}`;
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };

async function plainTask() {
  const h = await createDeveloperTaskBroker();
  const started = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Read the README and tell me what the retry flag does. Change nothing.", client: "claude-code" });
  expect(started.status, JSON.stringify(started.body)).toBeLessThan(300);
  const taskId = (started.body.task as { taskId: string }).taskId;
  const { workspaceId } = h.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
  const active = () => String((h.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  await h.finish(workspaceId, active(), "SUCCEEDED", PREPARED);
  const stored = (id: string) => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION" && item.id === id)[0] as { kind: string; workflowMode?: string; status: string; error?: string | null };
  const operation = () => stored(active());
  const view = async () => (await h.dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body.task as { status: string; failure?: { message: string } };
  return { h, taskId, workspaceId, active, operation, stored, view };
}

describe("a plain task whose run left the code as it was (bug B)", () => {
  it("runs as the first coding turn, and a no-change result ends it SUCCEEDED with no failure", async () => {
    const t = await plainTask();
    const id = t.active();
    expect(t.operation()).toMatchObject({ kind: "task", workflowMode: "IMPLEMENT" });
    await t.h.finish(t.workspaceId, id, "FAILED", { error: WORKER_ERROR });
    expect(t.stored(id).status).toBe("SUCCEEDED");
    expect(t.stored(id).error ?? undefined).toBeUndefined();
    const task = await t.view();
    expect(task.status).toBe("SUCCEEDED");
    expect(task.failure).toBeUndefined();
  });

  it("a repeat of the worker's FAILED result changes nothing and is not a conflict", async () => {
    const t = await plainTask();
    const id = t.active();
    await t.h.finish(t.workspaceId, id, "FAILED", { error: WORKER_ERROR });
    await t.h.finish(t.workspaceId, id, "FAILED", { error: WORKER_ERROR });
    expect((await t.view()).status).toBe("SUCCEEDED");
  });

  it("any other failure of a plain task is still FAILED (positive control)", async () => {
    const t = await plainTask();
    await t.h.finish(t.workspaceId, t.active(), "FAILED", { error: "RUNTIME_UNAVAILABLE: the model call failed: provider-outage attempt 4; retry the step" });
    const task = await t.view();
    expect(task.status).toBe("FAILED");
    expect(task.failure?.message).toContain("provider-outage");
  });
});
