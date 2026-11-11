// Stop & redirect never resets the person's cap window (owner decision 2026-11-01, Q3): a manual Retry starts a new window of the task's cap (`budgetBaselineUsd`), a redirect's restart keeps it.
// The window's baseline is read from the model proxy, which the test broker does not have, so it is stood in for here: every call to `capWindowBaseline` answers 25. A plain Retry that sets it
// to 25 is the positive control; the redirect's restarts, in every mode, leave it unset.
import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { OWNER_REDIRECT_FEATURE, workspaceSessionKey } from "@rovara-code/contracts";
import type * as TaskWindow from "../../packages/broker/src/aws/developer-tasks/task-window.js";
import { MAYA, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { finishPlanningWithMarkdown } from "../support/plan-documents.js";
import { loadSlackBroker } from "../support/slack-broker.js";

vi.mock("../../packages/broker/src/aws/developer-tasks/task-window.js", async (importOriginal) => ({ ...(await importOriginal<typeof TaskWindow>()), capWindowBaseline: vi.fn(async () => 25) }));

const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
type Item = Record<string, unknown>;

beforeAll(async () => { process.env["LIVE_REDIRECT_ENABLED"] = "1"; await loadSlackBroker(); });
afterAll(() => { delete process.env["LIVE_REDIRECT_ENABLED"]; });
afterEach(() => { vi.unstubAllGlobals(); });

async function setup() {
  const h = await createSingleAnswerPlanBroker({ brokerExtra: { agents: {} } });
  const operations = (workspaceId: string) => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION") as Array<Item & { id: string; workflowMode?: string; kind: string }>;
  const task = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as Item & { workspaceId: string; workflow: { revision: number } & Item; budgetBaselineUsd?: number };
  const running = async () => {
    const started = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
    const { taskId, sessionId } = started.body.task as { taskId: string; sessionId: string };
    const workspaceId = task(taskId).workspaceId;
    await h.finish(workspaceId, String(operations(workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", PREPARED);
    const plan = "# Plan\n\n1. Fix retry handling.\n";
    await finishPlanningWithMarkdown(h, workspaceId, String(operations(workspaceId).find((item) => item.workflowMode === "PLAN")!.id), plan);
    await h.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: task(taskId).workflow.revision, decision: "APPROVE", reason: "Approved", artifactDigest: createHash("sha256").update(plan).digest("hex") });
    h.db.set({ ...workspaceSessionKey(workspaceId), entityType: "WORKSPACE_SESSION", state: "READY", privateIp: "10.0.0.9", generation: 1, workerFeatures: [OWNER_REDIRECT_FEATURE] });
    return { taskId, sessionId, workspaceId };
  };
  const redirect = async (sessionId: string, workspaceId: string, mode: "keep_plan" | "change_plan") => {
    const answer = await h.dev(MAYA, "POST", `/v1/app/sessions/${sessionId}/redirect`, { requestId: randomUUID(), text: "do it another way", mode });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    await h.finish(workspaceId, operations(workspaceId).find((operation) => operation.kind === "cancel")!.id, "SUCCEEDED");
  };
  return { ...h, operations, task, running, redirect };
}

describe("a redirect does not start a new cap window", () => {
  it("positive control: a manual Retry of coding that stopped starts a new window (the baseline is set)", async () => {
    const t = await setup();
    const { taskId, workspaceId } = await t.running();
    await t.finish(workspaceId, t.operations(workspaceId).find((operation) => operation.workflowMode === "IMPLEMENT")!.id, "FAILED", { error: "the model stopped" });
    expect(t.task(taskId).budgetBaselineUsd).toBeUndefined();
    const retried = await t.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/retry`, { requestId: randomUUID(), instructions: "Carry on.", expectedRevision: t.task(taskId).workflow.revision });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(t.task(taskId).budgetBaselineUsd).toBe(25);
  });

  it("keeps the window when it restarts coding (keep the plan)", async () => {
    const t = await setup();
    const { taskId, sessionId, workspaceId } = await t.running();
    await t.redirect(sessionId, workspaceId, "keep_plan");
    expect(t.operations(workspaceId).filter((operation) => operation.workflowMode === "IMPLEMENT")).toHaveLength(2);
    expect(t.task(taskId).budgetBaselineUsd).toBeUndefined();
  });

  it("keeps the window when it starts the revised plan (this changes the plan)", async () => {
    const t = await setup();
    const { taskId, sessionId, workspaceId } = await t.running();
    await t.redirect(sessionId, workspaceId, "change_plan");
    expect(t.operations(workspaceId).filter((operation) => operation.workflowMode === "PLAN")).toHaveLength(2);
    expect(t.task(taskId).budgetBaselineUsd).toBeUndefined();
  });
});
