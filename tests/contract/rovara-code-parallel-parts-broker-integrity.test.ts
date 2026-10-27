import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PARALLEL_PARTS_MAX } from "../../packages/contracts/src/rovara-code.js";
import { taskGraphDigest } from "../../packages/contracts/src/workflow-dependencies-node.js";
import { workspaceLimitsKey } from "../../packages/broker/src/developer/limits.js";
import { MAYA, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

// The broker's side of a Rovara Code v2 task's parts: what it records when the plan is approved, what progress it accepts from a worker that builds parts side by side, and what it
// does with parts that were still running when the operation ended. A worker's callbacks are forged here, which is what a faulty or hostile worker would send.

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const BASE = "a".repeat(40);
const t = (digit: string) => digit.repeat(40);

async function approvedParts(options: { version?: "1.0.0" | "1.1.0"; switchOn?: boolean; room?: number } = {}) {
  const harness = await createSingleAnswerPlanBroker({
    ...(options.switchOn === true ? { developerExtra: { workflowDependenciesEnabled: true } } : {}),
    brokerExtra: { githubPullRequests: { getCommitTree: vi.fn(async () => BASE) } },
  });
  // `room`: the most open workspaces the person and the org may have (the task holds one of them).
  if (options.room !== undefined) harness.db.set({ ...workspaceLimitsKey(TEST_ORG), entityType: "SETTING", perPerson: options.room, perOrganization: options.room, updatedBy: "test", updatedAt: "2026-10-26T12:00:00.000Z" });
  const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Implement the parts", client: "test-client", workflow: true, workflowPath: "QUICK" });
  const taskId = String((started.body.task as { taskId: string }).taskId);
  type Workflow = { revision: number; artifacts: Array<{ sha256: string }>; workflowDependenciesApproval?: { runId: string; graphDigest: string }; workflowDependenciesProgress?: unknown[] };
  const meta = () => harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string; workflow: Workflow } & Record<string, unknown>;
  const workspaceId = meta().workspaceId;
  const operations = () => harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
  await harness.finish(workspaceId, String(operations().find((item) => item.kind === "prepare")?.id), "SUCCEEDED", { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } });
  const graph = { schemaVersion: 1 as const, taskId, version: 1, items: [
    { id: A, title: "Part A", description: "Build part A.", repository: "demo", dependsOn: [] as string[] },
    { id: B, title: "Part B", description: "Build part B.", repository: "demo", dependsOn: [] as string[] },
    { id: C, title: "Part C", description: "Build part C on A and B.", repository: "demo", dependsOn: [A, B] },
  ] };
  const planning = operations().find((item) => item.workflowMode === "PLAN");
  await harness.artifact(workspaceId, String(planning!.id), "plan.md", planAnswer(planDocument({ workBreakdown: graph })));
  await harness.finish(workspaceId, String(planning!.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
  const record = meta();
  if (options.version === "1.1.0") harness.db.set({ ...record, workflow: { ...record.workflow, definitionVersion: "1.1.0" } });
  const current = meta();
  const approved = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, {
    requestId: randomUUID(), expectedRevision: current.workflow.revision, decision: "APPROVE", reason: "Approved",
    artifactDigest: current.workflow.artifacts.at(-1)!.sha256, workBreakdownDigest: taskGraphDigest(graph),
  });
  const implementation = operations().find((item) => item.workflowMode === "IMPLEMENT");
  const operationId = implementation === undefined ? undefined : String(implementation.id);
  const approval = meta().workflow.workflowDependenciesApproval;
  const progress = (itemId: string, sequence: number, state: string, baseTreeSha: string, extra: Record<string, unknown> = {}) => ({
    type: "progress", payload: { workItemProgress: { schemaVersion: 1, graphDigest: approval!.graphDigest, runId: approval!.runId, itemId, sequence, state, operationId, baseTreeSha,
      at: new Date(Date.UTC(2026, 9, 26, 12, 0, sequence)).toISOString(), producer: "agentx-worker", ...extra } },
  });
  const send = (...events: Array<ReturnType<typeof progress>>) => harness.events(workspaceId, operationId!, events);
  const stored = () => (meta().workflow.workflowDependenciesProgress ?? []) as Array<{ itemId: string; sequence: number; state: string; baseTreeSha: string; candidateTreeSha?: string; integratedTreeSha?: string; producer: string }>;
  const binding = async () => harness.actions.workflowBinding(workspaceId, operationId!);
  return { harness, approved, operationId, progress, send, stored, binding, meta, workspaceId };
}

describe("a Rovara Code v2 task's approved plan", () => {
  it("records the parts setting on its one operation, within the plan's cap", async () => {
    const setup = await approvedParts({ version: "1.1.0" });
    expect(setup.approved.status).toBe(200);
    expect(setup.operationId).toBeDefined();
    expect((await setup.binding())?.parallel).toEqual({ max: PARALLEL_PARTS_MAX });
    expect((setup.harness.db.find((item) => item.entityType === "OPERATION" && item.workflowMode === "IMPLEMENT"))).toHaveLength(1);
  });

  it("starts without the install's ordered-work switch, while a version 1 task still needs it and gets no parts setting", async () => {
    const v1Off = await approvedParts({ version: "1.0.0" });
    expect(v1Off.approved.status).toBe(400);
    expect(v1Off.operationId).toBeUndefined();
    const v1On = await approvedParts({ version: "1.0.0", switchOn: true });
    expect(v1On.approved.status).toBe(200);
    expect((await v1On.binding())?.parallel).toBeUndefined();
  });
});

describe("progress from a worker that builds parts side by side", () => {
  it("accepts two starts before any finish, then a part that starts on the tree both were merged into", async () => {
    const s = await approvedParts({ version: "1.1.0" });
    await expect(s.send(s.progress(A, 1, "STARTED", BASE), s.progress(B, 2, "STARTED", BASE))).resolves.toMatchObject({ accepted: 2 });
    await expect(s.send(s.progress(B, 3, "IMPLEMENTED", BASE, { candidateTreeSha: t("1"), integratedTreeSha: t("1") }))).resolves.toMatchObject({ accepted: 1 });
    await expect(s.send(s.progress(A, 4, "IMPLEMENTED", BASE, { candidateTreeSha: t("2"), integratedTreeSha: t("3") }))).resolves.toMatchObject({ accepted: 1 });
    await expect(s.send(s.progress(C, 5, "STARTED", t("3")))).resolves.toMatchObject({ accepted: 1 });
    expect(s.stored().map((entry) => `${entry.itemId.slice(0, 2)}:${entry.state}`)).toEqual(["11:STARTED", "22:STARTED", "22:IMPLEMENTED", "11:IMPLEMENTED", "33:STARTED"]);
  });

  it("refuses a start from a tree that is neither the run's start nor one a finished part was merged into", async () => {
    const s = await approvedParts({ version: "1.1.0" });
    await s.send(s.progress(A, 1, "STARTED", BASE));
    await expect(s.send(s.progress(B, 2, "STARTED", t("9")))).rejects.toThrow(/trees and order/);
    // A part's own, unmerged tree is not a tree to build on either.
    await s.send(s.progress(B, 2, "STARTED", BASE));
    await s.send(s.progress(B, 3, "IMPLEMENTED", BASE, { candidateTreeSha: t("1"), integratedTreeSha: t("2") }));
    await expect(s.send(s.progress(A, 4, "STARTED", t("1")))).rejects.toThrow(/trees and order/);
    expect(s.stored()).toHaveLength(3);
  });

  it("refuses a part that needs another before that one is finished, and more parts at once than the cap allows", async () => {
    const s = await approvedParts({ version: "1.1.0" });
    await expect(s.send(s.progress(C, 1, "STARTED", BASE))).rejects.toThrow(/trees and order/);
    expect(s.stored()).toEqual([]);
  });

  it("refuses a second part running at once when the org's room left one", async () => {
    const tight = await approvedParts({ version: "1.1.0", room: 1 });
    expect((await tight.binding())?.parallel).toEqual({ max: 1 });
    await tight.send(tight.progress(A, 1, "STARTED", BASE));
    await expect(tight.send(tight.progress(B, 2, "STARTED", BASE))).rejects.toThrow(/trees and order/);
    const roomy = await approvedParts({ version: "1.1.0", room: 2 });
    expect((await roomy.binding())?.parallel).toEqual({ max: 2 });
    await roomy.send(roomy.progress(A, 1, "STARTED", BASE), roomy.progress(B, 2, "STARTED", BASE));
    expect(roomy.stored()).toHaveLength(2);
  });

  it("refuses a finish with no start, or that names another base tree than its start", async () => {
    const s = await approvedParts({ version: "1.1.0" });
    await expect(s.send(s.progress(A, 1, "IMPLEMENTED", BASE, { candidateTreeSha: t("1"), integratedTreeSha: t("1") }))).rejects.toThrow();
    await s.send(s.progress(A, 1, "STARTED", BASE));
    await expect(s.send(s.progress(A, 2, "IMPLEMENTED", t("4"), { candidateTreeSha: t("1"), integratedTreeSha: t("1") }))).rejects.toThrow();
  });

  it("marks every part that was still running when the operation failed as unknown, in the order they started", async () => {
    const s = await approvedParts({ version: "1.1.0" });
    await s.send(s.progress(A, 1, "STARTED", BASE), s.progress(B, 2, "STARTED", BASE));
    await s.harness.finish(s.workspaceId, s.operationId!, "FAILED", { error: "RUNTIME_UNAVAILABLE: compute was lost" });
    const rows = s.stored();
    expect(rows.map((entry) => `${entry.itemId.slice(0, 2)}:${entry.state}:${entry.sequence}`)).toEqual(["11:STARTED:1", "22:STARTED:2", "11:UNKNOWN:3", "22:UNKNOWN:4"]);
    expect(rows.slice(2).every((entry) => entry.producer === "agentx-broker-terminal" && entry.candidateTreeSha === undefined && entry.integratedTreeSha === undefined)).toBe(true);
    expect(s.meta().workflow).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED" });
  });

  it("leaves a part that finished before the failure as it was, and marks only the one that did not", async () => {
    const s = await approvedParts({ version: "1.1.0" });
    await s.send(s.progress(A, 1, "STARTED", BASE), s.progress(B, 2, "STARTED", BASE), s.progress(B, 3, "IMPLEMENTED", BASE, { candidateTreeSha: t("1"), integratedTreeSha: t("1") }));
    await s.harness.finish(s.workspaceId, s.operationId!, "FAILED", { error: "RUNTIME_UNAVAILABLE: compute was lost" });
    expect(s.stored().map((entry) => `${entry.itemId.slice(0, 2)}:${entry.state}:${entry.sequence}`)).toEqual(["11:STARTED:1", "22:STARTED:2", "22:IMPLEMENTED:3", "11:UNKNOWN:4"]);
  });
});
