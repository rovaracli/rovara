// Track record (v1.2 slice 1): publication records the claims about its candidate, and closing the task settles the open ones.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCandidateManifest, type WorkflowSnapshot } from "@agentx/contracts";
import { TEST_ORG } from "../support/orgs.js";
import { finishTaskClose, startTaskWorkflowPublicationFromSystem, taskPageUrl } from "../../packages/broker/src/aws/developer-tasks.js";
import { DEV_ISSUER, MAYA, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { finishPlanningWithMarkdown } from "../support/plan-documents.js";

type Harness = Awaited<ReturnType<typeof createSingleAnswerPlanBroker>>;
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const REQUIRED_CHECK = { id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } };
const operations = (harness: Harness, workspaceId: string) => harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
const publications = (harness: Harness, workspaceId: string) => operations(harness, workspaceId).filter((item) => item.kind === "publish");
const taskWorkflow = (harness: Harness, taskId: string) => (harness.db.get(`DEVTASK#${taskId}`, "META") as { workflow: WorkflowSnapshot }).workflow;
const passingChecks = () => ({ status: "verified", source: "project", preambleVersion: "1", preambleSha256: "c".repeat(64), checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 12 }], extraTry: "not_needed", agentClaim: "success" });
const passReviews = async (harness: Harness, workspaceId: string, candidate: ReturnType<typeof createCandidateManifest>) => {
  const id = String(operations(harness, workspaceId).find((item) => item.workflowMode === "REVIEW")!.id);
  const now = new Date().toISOString();
  await harness.finish(workspaceId, id, "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories,
    workflowReviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: id, candidateDigest: candidate.digest, role, provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now })) } });
};
async function workflowAtVerification(harness: Harness) {
  const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
  const taskId = String((started.body.task as { taskId: string }).taskId);
  const record = harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workspaceId: string; workflow: Record<string, unknown> };
  const workspaceId = record.workspaceId;
  harness.db.set({ ...record, workflow: { ...record.workflow, checkPolicy: { required: [REQUIRED_CHECK], optional: [], selectedOptionalIds: [] } } });
  await harness.finish(workspaceId, String(operations(harness, workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", PREPARED);
  const planning = operations(harness, workspaceId).find((item) => item.workflowMode === "PLAN")!;
  const plan = "# Plan\n\n1. Fix retry handling.\n2. Add a regression test.\n";
  await finishPlanningWithMarkdown(harness, workspaceId, String(planning.id), plan);
  await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: taskWorkflow(harness, taskId).revision, decision: "APPROVE", reason: "Approved", artifactDigest: createHash("sha256").update(plan).digest("hex") });
  const implementation = operations(harness, workspaceId).find((item) => item.workflowMode === "IMPLEMENT")!;
  const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
  const finishImplementation = () => harness.finish(workspaceId, String(implementation.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories, workflowCheckCandidateRepositories: candidate.repositories, checks: passingChecks() } });
  return { taskId, workspaceId, candidate, finishImplementation };
}
/**
 * The task is ready to publish and its first automatic start failed (a busy workspace's cancellation without reasons),
 * so nothing was published yet and the dispatch row waits. The caller then breaks the catalog and starts it itself.
 */
async function readyToPublish(harness: Harness) {
  const flow = await workflowAtVerification(harness);
  await flow.finishImplementation();
  harness.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes('"kind":"publish"'), error: { name: "TransactionCanceledException" } });
  await passReviews(harness, flow.workspaceId, flow.candidate);
  expect(publications(harness, flow.workspaceId)).toHaveLength(0);
  expect(taskWorkflow(harness, flow.taskId)).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
  const routeDeps = { documentClient: harness.db, tableName: "state", actions: harness.actions, now: () => Date.now(), orgId: TEST_ORG };
  const expected = { workflowRevision: taskWorkflow(harness, flow.taskId).revision, candidateDigest: flow.candidate.digest };
  const origin = { taskPageUrl: taskPageUrl(DEV_ISSUER, flow.taskId) };
  const start = () => startTaskWorkflowPublicationFromSystem(routeDeps as never, flow.taskId, expected, origin);
  return { ...flow, start };
}
const outcomeSamples = (harness: Harness) => harness.db.find((item) => item.entityType === "OUTCOME_SAMPLE");

describe("publication records the claims about its candidate", () => {
  it("a version 1 task's publication writes none", async () => {
    const harness = await createSingleAnswerPlanBroker();
    const flow = await readyToPublish(harness);
    expect(await flow.start()).toBe("STARTED");
    expect(outcomeSamples(harness)).toEqual([]);
  });

  it("a version 2 task's publication writes pending samples for its passing reviews, once, keyed by the candidate", async () => {
    const harness = await createSingleAnswerPlanBroker();
    const flow = await readyToPublish(harness);
    const record = harness.db.get(`DEVTASK#${flow.taskId}`, "META") as Record<string, unknown> & { workflow: WorkflowSnapshot };
    harness.db.set({ ...record, workflow: { ...record.workflow, definitionVersion: "1.1.0" } });
    const expected = { workflowRevision: taskWorkflow(harness, flow.taskId).revision, candidateDigest: flow.candidate.digest };
    const routeDeps = { documentClient: harness.db, tableName: "state", actions: harness.actions, now: () => Date.now(), orgId: TEST_ORG };
    const start = () => startTaskWorkflowPublicationFromSystem(routeDeps as never, flow.taskId, expected, { taskPageUrl: taskPageUrl(DEV_ISSUER, flow.taskId) });
    expect(await start()).toBe("STARTED");
    const round = flow.candidate.digest.slice(0, 16);
    expect(outcomeSamples(harness).map((item) => `${String(item.claim)}:${String(item.state)}:${String(item.round)}`).sort()).toEqual(
      expect.arrayContaining([`review_pass:CRITIC:pending:${round}`, `review_pass:SECURITY:pending:${round}`]));
    expect(outcomeSamples(harness).filter((item) => item.claim === "proves_change")).toEqual([]);
    expect(harness.db.get(`DEVTASK#${flow.taskId}`, `OUTCOME_KEYS#${round}`)).toMatchObject({ round, taskId: flow.taskId });
    const count = outcomeSamples(harness).length;
    await start().catch(() => undefined);
    expect(outcomeSamples(harness)).toHaveLength(count);
  });

  it("closing the task turns its open samples into no_outcome", async () => {
    const harness = await createSingleAnswerPlanBroker();
    const flow = await readyToPublish(harness);
    const record = harness.db.get(`DEVTASK#${flow.taskId}`, "META") as Record<string, unknown> & { workflow: WorkflowSnapshot };
    harness.db.set({ ...record, workflow: { ...record.workflow, definitionVersion: "1.1.0" } });
    const expected = { workflowRevision: taskWorkflow(harness, flow.taskId).revision, candidateDigest: flow.candidate.digest };
    const routeDeps = { documentClient: harness.db, tableName: "state", actions: harness.actions, now: () => Date.now(), orgId: TEST_ORG };
    await startTaskWorkflowPublicationFromSystem(routeDeps as never, flow.taskId, expected, { taskPageUrl: taskPageUrl(DEV_ISSUER, flow.taskId) });
    expect(outcomeSamples(harness).filter((item) => item.state === "pending").length).toBeGreaterThan(0);
    // The workspace is already released, as a close of an unpublished workspace leaves it.
    const workspace = harness.db.get(`WORKSPACE#${flow.workspaceId}`, "META") as Record<string, unknown>;
    const rest = Object.fromEntries(Object.entries(workspace).filter(([name]) => name !== "activeOperationId"));
    harness.db.set({ ...rest, status: "CLOSED", closedAt: new Date().toISOString() });
    const current = harness.db.get(`DEVTASK#${flow.taskId}`, "META") as never;
    await finishTaskClose({ tableName: "state", actions: harness.actions, documentClient: harness.db }, current, undefined);
    expect(outcomeSamples(harness).filter((item) => item.state === "pending")).toEqual([]);
    expect(outcomeSamples(harness).filter((item) => item.reason === "task_closed").length).toBeGreaterThan(0);
  });
});
