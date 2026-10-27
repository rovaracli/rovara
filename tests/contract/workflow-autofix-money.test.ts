// Mainline #408 sync, MONEY choices (owner ruling pending, see MERGE-REPORT.md Round 11): Rovara's own moves (AUTOFIX) are not a person's retry or send-back.
//  1. an automatic send-back to coding does NOT start a new run-limit window (rulings R38 and R39 are a person's); the window the owner accepted binds every automatic round;
//  2. a task that waits for an approval of more spend is not gone on with by Rovara itself: it asks the owner instead;
//  3. Rovara's caller is scoped to the task's org with the plain member role, and acts as the task's effective owner.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WORKFLOW_BLOCK_REASONS, createCandidateManifest, wholeTaskSpendUsd, type WorkflowSnapshot } from "@agentx/contracts";
import { AutoFixAskSchema } from "../../packages/broker/src/developer/autofix-messages.js";
import { automaticCaller, autoRetryChecksFromSystem, autoSendBackToCodingFromSystem } from "../../packages/broker/src/aws/developer-tasks.js";
import { developerTaskRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { call } from "../support/slack-broker.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { finishPlanningWithMarkdown } from "../support/plan-documents.js";

const PROXY = "http://internal-proxy.example.test:4000";
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const REQUIRED_CHECK = { id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } };
const SPENT = 4;

type Config = { enabled: boolean; capUsd: number; roundEstimateUsd: number };
const ON: Config = { enabled: true, capUsd: 15, roundEstimateUsd: 3 };

async function install(autofix: Config | null) {
  const access = fakeModelAccess();
  const harness = await createDeveloperTaskBroker({ brokerExtra: { planSelfCheck: false, ...(autofix === null ? {} : { autofix }), modelAccess: { access, proxyUrl: PROXY }, cloud: true } });
  access.setMemberSpent(TEST_ORG, MAYA.developerId, 0);
  access.setOrgSpent(TEST_ORG, 0);
  return { harness, access, config: autofix };
}
type Installed = Awaited<ReturnType<typeof install>>;
type Harness = Installed["harness"];

const operations = (harness: Harness, workspaceId: string) => harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
const taskOf = (harness: Harness, taskId: string) => harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workflow: WorkflowSnapshot; workspaceId: string; budgetBaselineUsd?: number; autofixAsk?: unknown };
const codingRuns = (harness: Harness, workspaceId: string) => operations(harness, workspaceId).filter((item) => item.workflowMode === "IMPLEMENT");
const reviewRuns = (harness: Harness, workspaceId: string) => operations(harness, workspaceId).filter((item) => item.workflowMode === "REVIEW");
const candidateOf = (n: number) => createCandidateManifest([{ repositoryId: "demo", commitSha: n.toString(16).padStart(40, "d"), treeSha: n.toString(16).padStart(40, "b"), baseCommitSha: "e".repeat(40) }]);
const passingChecks = () => ({ status: "verified", source: "project", preambleVersion: "1", preambleSha256: "c".repeat(64), checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 12 }], extraTry: "not_needed", agentClaim: "success" });
const findingsReview = (operationId: string, candidate: ReturnType<typeof candidateOf>) => {
  const now = new Date().toISOString();
  return { result: { workflowCandidateRepositories: candidate.repositories, workflowReviews: [
    { operationId, candidateDigest: candidate.digest, role: "CRITIC", provider: "t", version: "1", status: "FINDINGS", findings: [{ text: "The new parser drops the last line.", origin: "INTRODUCED", severity: "HIGH", file: "src/parse.ts", line: 40 }], readOnly: true, recordedAt: now },
    { operationId, candidateDigest: candidate.digest, role: "SECURITY", provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now },
  ] } };
};

/** A Quick task approved and in coding; the coding run has spent `SPENT` on its key by the time it ends, and its reviews find an introduced problem (REVIEW blocks). */
async function blockedOnFindings(installed: Installed, options: { fixSource?: "ci" } = {}) {
  const { harness, access } = installed;
  const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
  const taskId = String((started.body.task as { taskId: string }).taskId);
  const record = taskOf(harness, taskId);
  const workspaceId = record.workspaceId;
  harness.db.set({ ...record, workflow: { ...record.workflow, checkPolicy: { required: [REQUIRED_CHECK], optional: [], selectedOptionalIds: [] } } });
  await harness.finish(workspaceId, String(operations(harness, workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", PREPARED);
  const plan = "# Plan\n\n1. Fix retry handling.\n2. Add a regression test.\n";
  const planning = operations(harness, workspaceId).find((item) => item.workflowMode === "PLAN")!;
  await finishPlanningWithMarkdown(harness, workspaceId, String(planning.id), plan);
  const digest = createHash("sha256").update(plan).digest("hex");
  await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: taskOf(harness, taskId).workflow.revision, decision: "APPROVE", reason: "Approved", artifactDigest: digest });
  const approvedWindow = taskOf(harness, taskId).budgetBaselineUsd;
  // Plan 6's own fix rounds carry their source (the pull request already exists); #408 must stay out of them.
  if (options.fixSource !== undefined) harness.db.set({ ...taskOf(harness, taskId), workflow: { ...taskOf(harness, taskId).workflow, fixSource: options.fixSource } });
  // The coding run asks for its model key as the worker does, and spends SPENT on it.
  const coding = codingRuns(harness, workspaceId).at(-1)!;
  const outbox = harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === coding.id)[0]!;
  const capability = (outbox.invocation as { callbackCapability: string }).callbackCapability;
  expect((await call(harness.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": capability } })).status).toBe(200);
  access.setKeySpent(access.mintedKeys().at(-1)!, SPENT);
  const candidate = candidateOf(1);
  await harness.finish(workspaceId, String(coding.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories, workflowCheckCandidateRepositories: candidate.repositories, checks: passingChecks() } });
  const review = reviewRuns(harness, workspaceId).at(-1)!;
  await harness.finish(workspaceId, String(review.id), "SUCCEEDED", findingsReview(String(review.id), candidate));
  return { taskId, workspaceId, approvedWindow };
}

describe("automatic fixing and the run limit's window (MONEY, owner ruling pending)", () => {
  it("a person's send-back starts a new window at what the task's keys spent (rulings R38 and R39), as before", async () => {
    const installed = await install(null);
    const { harness } = installed;
    const { taskId, approvedWindow } = await blockedOnFindings(installed);
    expect(approvedWindow).toBe(0);
    const blocked = taskOf(harness, taskId).workflow;
    expect(blocked).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
    const sentBack = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/send-back`, { requestId: randomUUID(), expectedRevision: blocked.revision, instructions: "Fix it." });
    expect(sentBack.status).toBe(200);
    expect(taskOf(harness, taskId).budgetBaselineUsd).toBe(SPENT);
  });

  it("Rovara's own send-back to coding does NOT start a new window: the baseline stays where the owner's approval put it", async () => {
    const installed = await install({ ...ON });
    const { harness } = installed;
    const { taskId, workspaceId, approvedWindow } = await blockedOnFindings(installed);
    expect(approvedWindow).toBe(0);
    // Rovara sent it back by itself (an AGENTX decision, a second coding run) ...
    expect(taskOf(harness, taskId).workflow).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
    expect(taskOf(harness, taskId).workflow.decisions.filter((decision) => decision.source === "AUTO_FIX")).toHaveLength(1);
    expect(codingRuns(harness, workspaceId)).toHaveLength(2);
    // ... and the window did not move: what the first run spent still counts against the run limit.
    expect(taskOf(harness, taskId).budgetBaselineUsd).toBe(approvedWindow);
  });

  it("even where the route has model access (a proxy), Rovara's send-back leaves the window alone (the person-driven send-back is the first test)", async () => {
    const installed = await install(null);
    const { harness, access } = installed;
    const { taskId } = await blockedOnFindings(installed);
    const blocked = taskOf(harness, taskId);
    const input = harness.brokerInput as unknown as { documentClient: never; tableName: string; developer: never };
    const owner = { developerId: MAYA.developerId, sessionId: "s", amr: MAYA.provider, name: MAYA.name, orgId: TEST_ORG, orgRole: "member" as const };
    const base = { documentClient: input.documentClient, tableName: input.tableName, developer: input.developer, now: Date.now, tasks: harness.actions, modelAccess: access, cloud: true } as unknown as Parameters<typeof developerTaskRouteDependencies>[0];
    const deps = developerTaskRouteDependencies(base, owner);
    const outcome = await autoSendBackToCodingFromSystem(deps, taskId, { expectedRevision: blocked.workflow.revision, reason: "Sent back by itself.", spend: { spentUsd: wholeTaskSpendUsd(1), roundEstimateUsd: 3, capUsd: 15 } });
    expect(outcome).toBe("STARTED");
    expect(taskOf(harness, taskId).workflow.decisions.filter((decision) => decision.source === "AUTO_FIX")).toHaveLength(1);
    expect(taskOf(harness, taskId).budgetBaselineUsd).toBe(0);
  });

  // Round 11, I2: the retry path's own "keeps the window" guard (developer-tasks.ts, `automatic === undefined ? capWindowUpdate(...) : AUTOMATIC_KEEPS_WINDOW`), proven where the route HAS model
  // access (production's autofix route has none today, which would hide a missing guard). The task's key spent SPENT before the block, so a retry that opened a window would set the baseline to SPENT.
  it("even where the route has model access, Rovara's automatic Retry checks leaves the window alone (R38 is a person's retry only)", async () => {
    const installed = await install(null);
    const { harness, access } = installed;
    const { taskId, approvedWindow } = await blockedOnFindings(installed);
    expect(approvedWindow).toBe(0);
    const reviewed = taskOf(harness, taskId);
    // Checks that could not run on Rovara's side block the VERIFY step of the same candidate.
    harness.db.set({ ...reviewed, workflow: { ...reviewed.workflow, stage: "VERIFY", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.checkRunnerFailed, revision: reviewed.workflow.revision + 1 } });
    const blocked = taskOf(harness, taskId);
    const input = harness.brokerInput as unknown as { documentClient: never; tableName: string; developer: never };
    const owner = { developerId: MAYA.developerId, sessionId: "s", amr: MAYA.provider, name: MAYA.name, orgId: TEST_ORG, orgRole: "member" as const };
    const base = { documentClient: input.documentClient, tableName: input.tableName, developer: input.developer, now: Date.now, tasks: harness.actions, modelAccess: access, cloud: true } as unknown as Parameters<typeof developerTaskRouteDependencies>[0];
    const deps = developerTaskRouteDependencies(base, owner);
    const outcome = await autoRetryChecksFromSystem(deps, taskId, { expectedRevision: blocked.workflow.revision, reason: "Retried by itself.", spend: { spentUsd: wholeTaskSpendUsd(1), roundEstimateUsd: 3, capUsd: 15 } });
    expect(outcome).toBe("STARTED");
    expect(taskOf(harness, taskId).workflow.decisions.filter((decision) => decision.source === "AUTO_RETRY")).toHaveLength(1);
    expect(taskOf(harness, taskId).workflow).toMatchObject({ stage: "VERIFY", state: "RUNNING" });
    expect(taskOf(harness, taskId).budgetBaselineUsd).toBe(0);
  });

  it("a task that waits for an approval of more spend is not gone on with by Rovara: it asks the owner, and nothing starts", async () => {
    const installed = await install({ ...ON, enabled: false });
    const { harness, config } = installed;
    const { taskId, workspaceId } = await blockedOnFindings(installed);
    const blocked = taskOf(harness, taskId);
    expect(blocked.workflow).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
    harness.db.set({ ...blocked, budgetPause: { scope: "task", at: new Date().toISOString() } });
    // Rovara is switched on after the block was committed: the recovery sweep looks at it once.
    config!.enabled = true;
    harness.db.set({ pk: "WORKFLOW_DISPATCH", sk: `${taskId}#${blocked.workflow.revision}`, entityType: "WORKFLOW_DISPATCH", taskId, workflowRevision: blocked.workflow.revision, kind: "AUTOFIX",
      candidateDigest: blocked.workflow.candidate?.digest ?? "0".repeat(64), createdAt: new Date().toISOString(), attempts: 0, nextAttemptAt: new Date(0).toISOString(), dispatchDuePk: "WORKFLOW_DISPATCH",
      dispatchDueSk: `${new Date(0).toISOString()}#${taskId}#${blocked.workflow.revision}`, indexExpiresAt: Math.floor(Date.now() / 1000) + 86_400 });
    await harness.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(codingRuns(harness, workspaceId)).toHaveLength(1);
    expect(taskOf(harness, taskId).workflow).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
    expect(taskOf(harness, taskId).workflow.decisions.filter((decision) => decision.actorRole === "AGENTX")).toEqual([]);
    expect(taskOf(harness, taskId).budgetBaselineUsd).toBe(0);
    expect(AutoFixAskSchema.safeParse(taskOf(harness, taskId).autofixAsk).success).toBe(true);
  });

  it("Rovara's caller is the task's effective owner, in the task's own org, with the plain member role", async () => {
    const installed = await install(null);
    const { harness } = installed;
    const { taskId } = await blockedOnFindings(installed);
    const task = taskOf(harness, taskId) as never;
    const caller = automaticCaller({ orgId: TEST_ORG }, task);
    expect(caller).toMatchObject({ sessionId: "workflow-autofix", orgId: TEST_ORG, orgRole: "member", developerId: MAYA.developerId });
  });
});

describe("the two automatic fixers stay in their own phases (before a pull request: #408; after it: Plan 6)", () => {
  it("a block inside one of Plan 6's fix rounds (fixSource set) is not looked at by #408's automatic fixing: no row, no decision, no ask", async () => {
    const installed = await install({ ...ON });
    const { harness } = installed;
    const { taskId, workspaceId } = await blockedOnFindings(installed, { fixSource: "ci" });
    expect(taskOf(harness, taskId).workflow).toMatchObject({ stage: "REVIEW", state: "BLOCKED", fixSource: "ci" });
    expect(harness.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.kind === "AUTOFIX")).toEqual([]);
    expect(taskOf(harness, taskId).workflow.decisions.filter((decision) => decision.actorRole === "AGENTX")).toEqual([]);
    expect(taskOf(harness, taskId).autofixAsk).toBeUndefined();
    expect(codingRuns(harness, workspaceId)).toHaveLength(1);
  });
});
