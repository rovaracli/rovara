// Release 0.4.17: a Rovara Code version 2 task whose plan has an approved work breakdown must not be blocked at VERIFY with "approved work breakdown was not
// carried into this implementation" when a review's findings send it back to the build step. The system-started coding run carries the approved breakdown
// again (as the owner's Send back does); a run that really lost it is still blocked; a plan without a breakdown is untouched; and a CI or conflict fix,
// which the worker protocol forbids to carry a breakdown, is not mistaken for a run that lost it.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createCandidateManifest } from "../../packages/contracts/src/task-workflow-node.js";
import type { WorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { taskGraphDigest } from "../../packages/contracts/src/workflow-dependencies-node.js";
import { builtinSettingsKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { executeSerialWorkflowDependencies } from "../../packages/worker/src/workflow-dependencies.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { startTaskWorkflowImplementationFromSystem } from "../../packages/broker/src/aws/developer-tasks.js";
import { MAYA, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import { TEST_ORG } from "../support/orgs.js";

const now = "2026-10-27T12:00:00.000Z";
const BLOCK = "approved work breakdown was not carried into this implementation";

const passingChecks = () => ({ status: "verified", source: "project", preambleVersion: "1", preambleSha256: "c".repeat(64),
  checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 12 }],
  extraTry: "not_needed", agentClaim: "success" });
/** A version 2 plan names what changes, which files and how it is tested. */
const TESTED_CLAIMS = [
  { id: "1", text: "Payments that fail with a timeout are retried.", evidence: [{ kind: "code" as const, path: "payments/src/charge.ts", startLine: 10, endLine: 24, note: "Today a timeout throws." }] },
  { id: "2", text: "A test proves a timed-out payment is retried once and never charged twice." },
];
const FINDING = { text: "The export writes a cell that starts with =", origin: "INTRODUCED", severity: "HIGH", file: "export.ts", line: 1 };

type Record_ = Record<string, unknown> & { workspaceId: string; workflow: WorkflowSnapshot & { workflowDependenciesOperationId?: string; revision: number } };

/** A version 2 task whose first build is done and whose Security review found a problem: the program's own dispatch has started the send-back coding run. */
async function sentBackTask(withBreakdown: boolean) {
  const harness = await createSingleAnswerPlanBroker({ developerExtra: { workflowDependenciesEnabled: true },
    brokerExtra: { agents: {}, githubPullRequests: { getCommitTree: vi.fn(async () => "a".repeat(40)) } } });
  const store = new AgentStore({ documentClient: harness.db, tableName: "state", now: Date.now });
  await store.ensureBuiltinSettings(TEST_ORG, "rovara-code");
  harness.db.set({ ...builtinSettingsKey(TEST_ORG, "rovara-code"), entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 2, updatedBy: "test", updatedAt: now });
  const reply = await harness.dev(MAYA, "POST", "/v1/app/agents/rovara-code/runs", { requestId: randomUUID(), project: "payments", input: { text: "Export the log as CSV" } });
  expect(reply.status, JSON.stringify(reply.body)).toBe(202);
  const taskId = String((reply.body.task as { taskId: string }).taskId);
  const record = () => harness.db.get(`DEVTASK#${taskId}`, "META") as Record_;
  const workspaceId = record().workspaceId;
  const operations = () => harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
  const builds = () => operations().filter((item) => item.workflowMode === "IMPLEMENT");
  await harness.finish(workspaceId, String(operations().find((item) => item.kind === "prepare")?.id), "SUCCEEDED", { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } });
  const graph = { schemaVersion: 1 as const, taskId, version: 1, items: [
    { id: "11111111-1111-4111-8111-111111111111", title: "Implement first", description: "Implement the first change", repository: "demo", dependsOn: [] as string[] }] };
  const planning = operations().find((item) => item.workflowMode === "PLAN")!;
  await harness.artifact(workspaceId, String(planning.id), "plan.md", planAnswer(planDocument({ claims: TESTED_CLAIMS, ...(withBreakdown ? { workBreakdown: graph } : {}) })));
  await harness.finish(workspaceId, String(planning.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
  const check = operations().filter((item) => item.workflowMode === "PLAN_CRITIQUE").at(-1);
  expect(check, JSON.stringify([record().workflow.stage, record().workflow.state, record().workflow.blockReason])).toBeDefined();
  await harness.artifact(workspaceId, String(check!.id), "plan-critique.md", `I read the plan.\n\n\`\`\`rovara-plan-critique\n{"verdict":"ok","points":[]}\n\`\`\`\n`);
  await harness.finish(workspaceId, String(check!.id), "SUCCEEDED", { result: { workflowMode: "PLAN_CRITIQUE" } });
  const approved = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, {
    requestId: randomUUID(), expectedRevision: record().workflow.revision, decision: "APPROVE", reason: "Approved",
    artifactDigest: record().workflow.artifacts.at(-1)!.sha256, ...(withBreakdown ? { workBreakdownDigest: taskGraphDigest(graph) } : {}),
  });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  const first = builds()[0]!;
  const approval = record().workflow.workflowDependenciesApproval;
  expect(approval !== undefined, "the plan's breakdown was approved").toBe(withBreakdown);
  const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "a".repeat(40), baseCommitSha: "e".repeat(40) }]);
  const result: Record<string, unknown> = { workflowCandidateRepositories: candidate.repositories, workflowCheckCandidateRepositories: candidate.repositories, checks: passingChecks() };
  if (approval !== undefined) {
    const execution = await executeSerialWorkflowDependencies({
      graph, graphDigest: approval.graphDigest, runId: approval.runId, operationId: String(first.id), initialTreeSha: "a".repeat(40), now: () => new Date().toISOString(),
      persist: async (progress) => { await harness.events(workspaceId, String(first.id), [{ type: "progress", payload: { workItemProgress: progress } }]); },
      execute: async () => ({ treeSha: "a".repeat(40) }),
    });
    result.workflowDependenciesResult = { schemaVersion: 1, taskId, graphDigest: approval.graphDigest, runId: approval.runId, operationId: String(first.id), workflowRevision: approval.workflowRevision,
      status: "SUCCEEDED", items: execution.progress.filter((entry) => entry.state === "IMPLEMENTED"), candidateDigest: candidate.digest, at: new Date().toISOString() };
  }
  await harness.finish(workspaceId, String(first.id), "SUCCEEDED", { result });
  const review = operations().find((item) => item.workflowMode === "REVIEW");
  expect(review, JSON.stringify(record().workflow.stage)).toBeDefined();
  const report = (role: string, status: string, findings: unknown[]) => ({ operationId: String(review!.id), candidateDigest: candidate.digest, role, provider: "test", version: "1", status, findings, readOnly: true, recordedAt: new Date().toISOString() });
  await harness.finish(workspaceId, String(review!.id), "SUCCEEDED", { result: {
    workflowCandidateRepositories: candidate.repositories,
    workflowReviews: [report("CRITIC", "PASS", []), report("SECURITY", "FINDINGS", [FINDING])],
  } });
  // The broker's own dispatch has already started the program's next coding step (the send-back to the build step), as it does in production.
  expect(record().workflow, "the review's findings sent the work back to the build step").toMatchObject({ stage: "IMPLEMENT", state: "RUNNING", programStepId: "build" });
  expect(builds()).toHaveLength(2);
  const deps = { documentClient: harness.db, tableName: "state", actions: harness.actions, log: () => undefined, orgId: TEST_ORG, workflowDependenciesEnabled: true,
    checkAccess: async () => ({ revision: 1, policy: {} as never, access: "granted" as const, channelIds: [], role: "contributor" as const }), projectChannelIds: async () => [], now: () => Date.now() };
  const dispatch = () => startTaskWorkflowImplementationFromSystem(deps, taskId, { workflowRevision: record().workflow.revision });
  /** Finish the send-back's coding run the way a worker does: with the same candidate, checks and (when it was given a breakdown) the graph result. */
  const finishSendBack = async (operationId: string) => {
    const binding = await harness.actions.workflowBinding(workspaceId, operationId);
    const done: Record<string, unknown> = { workflowCandidateRepositories: candidate.repositories, workflowCheckCandidateRepositories: candidate.repositories, checks: passingChecks() };
    if (binding !== undefined) {
      const execution = await executeSerialWorkflowDependencies({
        graph, graphDigest: binding.approval.graphDigest, runId: binding.approval.runId, operationId, initialTreeSha: binding.resumeTreeSha ?? "a".repeat(40), ...(binding.sequenceStart === undefined ? {} : { sequenceStart: binding.sequenceStart }),
        ...(binding.resumeProgress === undefined ? {} : { resumeProgress: binding.resumeProgress }), now: () => new Date().toISOString(),
        persist: async (progress) => { await harness.events(workspaceId, operationId, [{ type: "progress", payload: { workItemProgress: progress } }]); },
        execute: async () => ({ treeSha: "a".repeat(40) }),
      });
      done.workflowDependenciesResult = { schemaVersion: 1, taskId, graphDigest: binding.approval.graphDigest, runId: binding.approval.runId, operationId, workflowRevision: binding.approval.workflowRevision,
        status: "SUCCEEDED", items: execution.progress.filter((entry) => entry.state === "IMPLEMENTED"), candidateDigest: candidate.digest, at: new Date().toISOString() };
    }
    await harness.finish(workspaceId, operationId, "SUCCEEDED", { result: done });
  };
  return { harness, taskId, workspaceId, record, builds, operations, dispatch, finishSendBack, first, approval, graph };
}

describe("a program send-back keeps the approved work breakdown (0.4.17)", () => {
  beforeAll(async () => { await loadSlackBroker(); });

  it("starts the send-back with the approved breakdown, binds it to the new run, and passes VERIFY", async () => {
    const task = await sentBackTask(true);
    expect(task.builds()).toHaveLength(2);
    const sendBack = task.builds()[1]!;
    expect(sendBack.workflowDependencies).toMatchObject({ approval: { graphDigest: task.approval!.graphDigest, runId: task.approval!.runId }, sequenceStart: 2, resumeProgress: [] });
    expect(task.record().workflow.workflowDependenciesOperationId).toBe(String(sendBack.id));
    await task.finishSendBack(String(sendBack.id));
    const after = task.record().workflow;
    expect(after.blockReason).toBeUndefined();
    expect(after).not.toMatchObject({ state: "BLOCKED" });
    expect(after.stage).not.toBe("IMPLEMENT");
  });

  it("carries the breakdown again through a second findings round", async () => {
    const task = await sentBackTask(true);
    const firstRound = task.builds()[1]!;
    await task.finishSendBack(String(firstRound.id));
    const reviews = task.operations().filter((item) => item.workflowMode === "REVIEW");
    expect(reviews, "the send-back's code was reviewed again").toHaveLength(2);
    const candidate = task.record().workflow.candidate!;
    const report = (role: string, status: string, findings: unknown[]) => ({ operationId: String(reviews[1]!.id), candidateDigest: candidate.digest, role, provider: "test", version: "1", status, findings, readOnly: true, recordedAt: new Date().toISOString() });
    await task.harness.finish(task.workspaceId, String(reviews[1]!.id), "SUCCEEDED", { result: {
      workflowCandidateRepositories: candidate.repositories,
      workflowReviews: [report("CRITIC", "PASS", []), report("SECURITY", "FINDINGS", [{ ...FINDING, text: "A second problem", line: 2 }])],
    } });
    expect(task.builds()).toHaveLength(3);
    const secondRound = task.builds()[2]!;
    expect(secondRound.workflowDependencies).toMatchObject({ approval: { graphDigest: task.approval!.graphDigest }, sequenceStart: 4, resumeProgress: [] });
    expect(task.record().workflow.workflowDependenciesOperationId).toBe(String(secondRound.id));
    await task.finishSendBack(String(secondRound.id));
    expect(task.record().workflow.blockReason).toBeUndefined();
    expect(task.record().workflow).not.toMatchObject({ state: "BLOCKED" });
  });

  it("still blocks a send-back run that really lost its binding while the plan has a breakdown", async () => {
    const task = await sentBackTask(true);
    const sendBack = task.builds()[1]!;
    // The run the workflow names as carrying the graph has no binding on its record: the guard must catch it.
    const { workflowDependencies: _lost, ...withoutBinding } = sendBack as Record<string, unknown>;
    void _lost;
    task.harness.db.set(withoutBinding);
    await task.finishSendBack(String(sendBack.id));
    expect(task.record().workflow).toMatchObject({ stage: "VERIFY", state: "BLOCKED", blockReason: BLOCK });
  });

  it("still blocks a run with no binding when the workflow names no graph operation at all", async () => {
    const task = await sentBackTask(true);
    const sendBack = task.builds()[1]!;
    const { workflowDependencies: _lost, ...withoutBinding } = sendBack as Record<string, unknown>;
    void _lost;
    task.harness.db.set(withoutBinding);
    const { workflowDependenciesOperationId: _named, ...unnamed } = task.record().workflow;
    void _named;
    task.harness.db.set({ ...task.record(), workflow: unnamed });
    await task.finishSendBack(String(sendBack.id));
    expect(task.record().workflow).toMatchObject({ stage: "VERIFY", state: "BLOCKED", blockReason: BLOCK });
  });

  it("still blocks an unbound run that is not a fix, even though the workflow names an earlier graph operation", async () => {
    const task = await sentBackTask(true);
    const sendBack = task.builds()[1]!;
    const { workflowDependencies: _lost, ...withoutBinding } = sendBack as Record<string, unknown>;
    void _lost;
    task.harness.db.set(withoutBinding);
    // The workflow names the first build as carrying the graph, and this run (not a CI, conflict or feedback fix) was started without one.
    task.harness.db.set({ ...task.record(), workflow: { ...task.record().workflow, workflowDependenciesOperationId: String(task.first.id) } });
    expect(task.record().workflow.fixSource).toBeUndefined();
    await task.finishSendBack(String(sendBack.id));
    expect(task.record().workflow).toMatchObject({ stage: "VERIFY", state: "BLOCKED", blockReason: BLOCK });
  });

  it("leaves a plan without a breakdown unaffected: no binding is made up, and the send-back passes VERIFY", async () => {
    const task = await sentBackTask(false);
    const sendBack = task.builds()[1]!;
    expect(sendBack).not.toHaveProperty("workflowDependencies");
    expect(task.record().workflow.workflowDependenciesOperationId).toBeUndefined();
    await task.finishSendBack(String(sendBack.id));
    expect(task.record().workflow.blockReason).toBeUndefined();
    expect(task.record().workflow).not.toMatchObject({ state: "BLOCKED" });
  });

  for (const source of ["ci", "conflict"] as const) {
    it(`does not mistake a ${source} fix for a run that lost the breakdown (the worker protocol forbids a fix to carry one)`, async () => {
      const task = await sentBackTask(true);
      // Put the task in a fix round instead: the send-back run is dropped, and a fix of the open pull request starts at the same build step.
      await task.harness.finish(task.workspaceId, String(task.builds()[1]!.id), "FAILED", { error: "dropped for the test" });
      const { blockReason: _blockReason, ...rest } = task.record().workflow;
      void _blockReason;
      task.harness.db.set({ ...task.record(), workflow: { ...rest, stage: "IMPLEMENT", state: "READY", programStepId: "build", fixSource: source, fixProblems: ["Unit tests"], reviews: [] } });
      await expect(task.dispatch()).resolves.toBe("STARTED");
      const fix = task.builds().find((item) => !([String(task.first.id), String(task.builds()[1]!.id)].includes(String(item.id))));
      expect(task.builds(), "the fix started a third coding run").toHaveLength(3);
      const invocation = task.harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === fix?.id)[0]?.invocation as { payload: Record<string, unknown> };
      expect(invocation.payload.workflowFix).toMatchObject({ source });
      expect(invocation.payload).not.toHaveProperty("workflowDependencies");
      expect(fix).not.toHaveProperty("workflowDependencies");
      await task.finishSendBack(String(fix!.id));
      expect(task.record().workflow.blockReason).not.toBe(BLOCK);
    });
  }
});
