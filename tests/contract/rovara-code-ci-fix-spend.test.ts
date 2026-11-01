// Rovara Code (Plan 6 Task 15): a fix round is paid work, started like any coding run. Over a real version 2 task (its payer, its frozen recipe, its run limit) and a fake model proxy: the
// round's coding run is accepted in the task's own workspace with the fix's mark, its key is minted for the task's payer and the build step and is held to the run limit, the member's budget and the
// org's, and running out pauses the round (the same round resumes at the person's retry). The owner's Retry of a CI fix that waited for them is a route of its own, checked here too.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  BUDGET_EXHAUSTED_FAILURE_MESSAGE, CI_OUTPUT_BLOCK_HEADER, WorkflowSnapshotSchema, ciFixAskMessage, ciFixStopMessage, createCandidateManifest, startWorkflowFix, type WorkflowSnapshot,
} from "@agentx/contracts";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { builtinSettingsKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { ciEvidenceItem, ciOutputBlock } from "../../packages/broker/src/rovara-code/ci-fix.js";
import { IMPLEMENT_TEST_RULE } from "../../packages/broker/src/rovara-code/verification-report.js";
import { WORKFLOW_NO_CANDIDATE_DIGEST, workflowDispatchItem } from "../../packages/broker/src/aws/broker-shared.js";
import { MAYA, OMAR, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { TEST_ORG } from "../support/orgs.js";
import { call } from "../support/slack-broker.js";
import { pullRequestDetails } from "../support/p5-world.js";

const NOW = "2026-10-25T12:00:00.000Z";
const PROXY_URL = "http://internal-proxy.example.test:4000";
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
const PR = { repositoryId: "demo", number: 7, headSha: "a".repeat(40), headTreeSha: "b".repeat(40), candidateDigest: candidate.digest, required: true, state: "OPEN" as const, url: "https://github.com/example/demo/pull/7" };

type Meta = Record<string, unknown> & { taskId: string; workspaceId: string; budgetUsd?: number; budgetPause?: unknown; workflow: WorkflowSnapshot };

async function world() {
  const access = fakeModelAccess();
  // The head GitHub shows for the task's pull request: what the round was made for, unless a test says a person pushed.
  const heads = { current: PR.headSha };
  const getPullRequest = vi.fn(async () => pullRequestDetails(42, { headCommit: heads.current }));
  const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {}, modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true,
    githubPullRequests: { reconcilePullRequest: vi.fn(), getPullRequest, updatePullRequest: vi.fn(), verifyWebhookRepository: vi.fn(async () => true) } } });
  access.setMemberSpent(TEST_ORG, MAYA.developerId, 0);
  access.setOrgSpent(TEST_ORG, 0);
  const store = new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now });
  await store.ensureBuiltinSettings(TEST_ORG, "rovara-code");
  h.db.set({ ...builtinSettingsKey(TEST_ORG, "rovara-code"), entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 2, updatedBy: "test", updatedAt: NOW });
  const meta = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as unknown as Meta;
  const operations = (workspaceId: string) => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
  const byMode = (workspaceId: string, mode: string) => operations(workspaceId).filter((item) => item.workflowMode === mode).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const invocationOf = (operationId: unknown) => h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]?.invocation as { callbackCapability: string; payload: Record<string, unknown> & { prompt: string } };
  const sweep = () => h.handler({ source: "agentx.workflow-dispatch-recovery" });
  const askForKey = (operationId: unknown) =>
    call(h.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": invocationOf(operationId).callbackCapability } });

  /** A real version 2 task whose planning was cancelled, so its workspace is free, then put where tracking leaves it when red CI starts a round: coding, ready, marked as a CI fix, with its row and block. */
  async function inFixRound(extra: Partial<WorkflowSnapshot> = {}) {
    const reply = await h.dev(MAYA, "POST", "/v1/app/projects/payments/code", { requestId: randomUUID(), input: { text: "Fix the retry bug" }, path: "QUICK" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const taskId = String((reply.body.task as { taskId: string }).taskId);
    const workspaceId = meta(taskId).workspaceId;
    await h.finish(workspaceId, String(operations(workspaceId).find((item) => item.kind === "prepare")!.id), "SUCCEEDED", PREPARED);
    await h.finish(workspaceId, String(byMode(workspaceId, "PLAN").at(-1)!.id), "CANCELLED");
    const real = meta(taskId).workflow;
    const waiting = WorkflowSnapshotSchema.parse({
      ...real, revision: 30, stage: "WAIT_FOR_MERGE", state: "WAITING", programStepId: "pull_request", candidate, reviewBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }],
      verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: "test", recordedAt: NOW, results: [] , reviewOnly: true },
      reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: randomUUID(), candidateDigest: candidate.digest, role, provider: "scripted", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: NOW })),
      pullRequests: [PR], blockReason: undefined, ...extra,
    });
    const fixing = startWorkflowFix(waiting, { source: "ci", problems: ["test"], now: NOW });
    h.db.set({ ...meta(taskId), workflow: fixing, checkPolicy: undefined });
    const block = ciOutputBlock([{ name: "test", conclusion: "failure", url: "https://github.com/example/demo/actions/runs/1", log: "Error: boom in handler" }]);
    h.db.set((ciEvidenceItem("state", { orgId: TEST_ORG, taskId, revision: fixing.revision, block, now: Date.parse(NOW) }) as { Put: { Item: Record<string, unknown> } }).Put.Item);
    h.db.set((workflowDispatchItem("state", taskId, fixing.revision, "IMPLEMENT", candidate.digest, NOW) as { Put: { Item: Record<string, unknown> } }).Put.Item);
    return { taskId, workspaceId, fixing, block };
  }
  return { h, access, meta, operations, byMode, invocationOf, sweep, askForKey, inFixRound, heads, getPullRequest };
}

describe("a CI fix round's coding run", () => {
  it("is accepted in the task's own workspace by the dispatch row the round wrote, with the fix's mark, the build step, the CI block and the test rule, and not the plan", async () => {
    const t = await world();
    const { taskId, workspaceId, fixing } = await t.inFixRound();
    expect(WORKFLOW_NO_CANDIDATE_DIGEST).toHaveLength(64);
    await t.sweep();
    const [run] = t.byMode(workspaceId, "IMPLEMENT");
    expect(run).toMatchObject({ kind: "task", workspaceId, programStepId: "build" });
    const payload = t.invocationOf(run!.id).payload;
    expect(payload).toMatchObject({ workflowMode: "IMPLEMENT", workflowFix: { source: "ci" } });
    expect(payload.prompt).toContain(CI_OUTPUT_BLOCK_HEADER);
    expect(payload.prompt).toContain("Error: boom in handler");
    expect(payload.prompt).toContain("A pull request you opened has failing CI checks");
    expect(payload.prompt).not.toContain("Approved plan (sha256");
    expect(payload.prompt.endsWith(IMPLEMENT_TEST_RULE)).toBe(true);
    // The row went with its run, and the workflow moved on from the revision the round wrote.
    expect(t.h.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === taskId)).toEqual([]);
    expect(t.meta(taskId).workflow).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING", fixSource: "ci", revision: fixing.revision + 1 });
    // A repeat of the sweep starts nothing more.
    await t.sweep();
    expect(t.byMode(workspaceId, "IMPLEMENT")).toHaveLength(1);
  });
});

describe("a person's push before the round's run starts", () => {
  it("stops the round before anything is paid for: no run, no key, the task waits for the merge as it did, and the person's commits are never touched", async () => {
    const t = await world();
    const { taskId, workspaceId } = await t.inFixRound();
    t.heads.current = "9".repeat(40);
    await t.sweep();
    expect(t.getPullRequest).toHaveBeenCalledTimes(1);
    expect(t.byMode(workspaceId, "IMPLEMENT")).toEqual([]);
    expect(t.access.mintKey).not.toHaveBeenCalled();
    const stopped = t.meta(taskId).workflow;
    expect(stopped).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", fixRounds: { ci: 1 } });
    expect(stopped.fixSource).toBeUndefined();
    expect(t.h.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === taskId)).toEqual([]);
    // The sweep does not start it later.
    await t.sweep();
    expect(t.byMode(workspaceId, "IMPLEMENT")).toEqual([]);
  });

  it("starts the run when the head is the one the round was made for", async () => {
    const t = await world();
    const { workspaceId } = await t.inFixRound();
    await t.sweep();
    expect(t.getPullRequest).toHaveBeenCalledTimes(1);
    expect(t.byMode(workspaceId, "IMPLEMENT")).toHaveLength(1);
  });

  it("does not guess when GitHub cannot say: nothing starts, and the row stays to be tried again", async () => {
    const t = await world();
    const { taskId, workspaceId } = await t.inFixRound();
    // An error, an empty answer and an answer that is not a commit are all "cannot say": none is read as a head that moved.
    const dueAgain = () => {
      const row = t.h.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === taskId)[0]!;
      t.h.db.set({ ...row, nextAttemptAt: "2000-01-01T00:00:00.000Z", dispatchDueSk: `2000-01-01T00:00:00.000Z#${String(row.sk)}` });
    };
    t.getPullRequest.mockRejectedValueOnce(new Error("GitHub is down"));
    await t.sweep();
    dueAgain();
    t.getPullRequest.mockResolvedValueOnce({} as never);
    await t.sweep();
    dueAgain();
    t.getPullRequest.mockResolvedValueOnce(pullRequestDetails(42, { headCommit: "not a commit" }));
    await t.sweep();
    expect(t.byMode(workspaceId, "IMPLEMENT")).toEqual([]);
    expect(t.meta(taskId).workflow).toMatchObject({ stage: "IMPLEMENT", state: "READY", fixSource: "ci" });
    expect(t.h.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === taskId)).toHaveLength(1);
    expect(t.getPullRequest).toHaveBeenCalledTimes(3);
  });
});

describe("a CI fix round is paid like the first build", () => {
  it("its key is minted for the task's payer, tagged with the build step, and held to what the run limit has left", async () => {
    const t = await world();
    const { taskId, workspaceId } = await t.inFixRound();
    await t.sweep();
    const [run] = t.byMode(workspaceId, "IMPLEMENT");
    t.h.db.set({ ...t.meta(taskId), budgetUsd: 8, budgetBaselineUsd: 0 });
    const reply = await t.askForKey(run!.id);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const minted = t.access.mintKey.mock.calls.at(-1)![0];
    expect(minted).toMatchObject({ orgId: TEST_ORG, developerId: MAYA.developerId, refId: taskId, purpose: "task" });
    expect(minted.maxBudgetUsd).toBeLessThanOrEqual(8);
    expect(minted.tags).toMatchObject({ taskId, stepId: "build" });
  });

  it("is refused once the run limit is spent, and the round pauses with the budget pause instead of being lost; its retry is still that fix", async () => {
    const t = await world();
    const { taskId, workspaceId } = await t.inFixRound();
    await t.sweep();
    const [run] = t.byMode(workspaceId, "IMPLEMENT");
    t.h.db.set({ ...t.meta(taskId), budgetUsd: 1, budgetBaselineUsd: 0, modelKeyIds: ["k1"] });
    t.access.keySpend.mockResolvedValue(5);
    expect((await t.askForKey(run!.id)).status).toBe(402);
    await t.h.finish(workspaceId, String(run!.id), "FAILED", { error: BUDGET_EXHAUSTED_FAILURE_MESSAGE });
    const paused = t.meta(taskId);
    expect(paused.workflow).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED", fixSource: "ci", fixRounds: { ci: 1 } });
    expect(paused.budgetPause).toBeDefined();
    // The retry (the spend approval's, or the owner's) is the same round in the same workspace, told what CI said again, and marked as a fix.
    t.access.keySpend.mockResolvedValue(0);
    t.h.db.set({ ...t.meta(taskId), budgetUsd: 20, budgetPause: undefined });
    const retried = await t.h.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/retry`, { requestId: randomUUID(), instructions: "Your AI budget was raised.", expectedRevision: paused.workflow.revision });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    const runs = t.byMode(workspaceId, "IMPLEMENT");
    expect(runs).toHaveLength(2);
    const payload = t.invocationOf(runs[1]!.id).payload;
    expect(payload).toMatchObject({ workflowMode: "IMPLEMENT", workflowFix: { source: "ci" } });
    expect(payload.prompt).toContain(CI_OUTPUT_BLOCK_HEADER);
    expect(payload.prompt).toContain("continue from the current code");
    expect(runs[1]).toMatchObject({ workspaceId, programStepId: "build" });
  });

  it("is refused when the member who pays has no budget left, before any key", async () => {
    const t = await world();
    const { workspaceId } = await t.inFixRound();
    await t.sweep();
    const [run] = t.byMode(workspaceId, "IMPLEMENT");
    t.access.setMemberSpent(TEST_ORG, MAYA.developerId, 1_000_000);
    const before = t.access.mintKey.mock.calls.length;
    expect((await t.askForKey(run!.id)).status).toBe(402);
    expect(t.access.mintKey.mock.calls.length).toBe(before);
  });

  it("spends from the run limit, not the planning limit: its key is not a planning key", async () => {
    const t = await world();
    const { taskId, workspaceId } = await t.inFixRound();
    await t.sweep();
    const [run] = t.byMode(workspaceId, "IMPLEMENT");
    t.h.db.set({ ...t.meta(taskId), budgetUsd: 12, budgetBaselineUsd: 0 });
    expect((await t.askForKey(run!.id)).status).toBe(200);
    expect(t.access.mintKey.mock.calls.at(-1)![0].maxBudgetUsd).toBeGreaterThan(0);
  });
});

describe("the owner's Retry of a CI fix that waited for them", () => {
  const blocked = async (reason: (check: string) => string) => {
    const t = await world();
    const { taskId } = await t.inFixRound();
    const task = t.meta(taskId);
    const waiting = WorkflowSnapshotSchema.parse({ ...task.workflow, stage: "WAIT_FOR_MERGE", state: "BLOCKED", blockReason: reason("test"), fixSource: undefined, fixProblems: undefined });
    t.h.db.set({ ...task, workflow: waiting });
    t.h.db.set({ pk: "WORKFLOW_MERGE_RECOVERY", sk: `TASK#${taskId}`, entityType: "WORKFLOW_MERGE_RECOVERY", taskId, kind: "tracking", attempts: 0,
      nextAttemptAt: Date.now() + 900_000, dispatchDuePk: "WORKFLOW_MERGE_TRACKING", dispatchDueSk: `${String(Date.now() + 900_000).padStart(15, "0")}#${taskId}` });
    return { ...t, taskId, waiting };
  };
  const retry = (t: Awaited<ReturnType<typeof blocked>>, who = MAYA, body: Record<string, unknown> = {}) =>
    t.h.dev(who, "POST", `/v1/dev/tasks/${t.taskId}/workflow/retry`, { requestId: randomUUID(), instructions: "Fix CI.", expectedRevision: t.waiting.revision, ...body });

  it("lets Rovara go on: the task waits for the merge again with the go-ahead, the tracking row is woken, and the retry is recorded under its request", async () => {
    const t = await blocked(ciFixAskMessage);
    const requestId = randomUUID();
    const reply = await retry(t, MAYA, { requestId });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(t.meta(t.taskId).workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", ciFixApproved: [PR.headSha], revision: t.waiting.revision + 1 });
    expect(t.meta(t.taskId).workflow.blockReason).toBeUndefined();
    expect(t.h.db.get(`DEVTASK#${t.taskId}`, `WORKFLOW_CI_FIX_RETRY#${requestId}`)).toMatchObject({ entityType: "WORKFLOW_CI_FIX_RETRY" });
    expect(t.h.db.get("WORKFLOW_MERGE_RECOVERY", `TASK#${t.taskId}`)?.wakeAt).toBeDefined();
    // The same request again is the same retry: it writes nothing, and another person's use of the id is refused.
    const again = await t.h.dev(MAYA, "POST", `/v1/dev/tasks/${t.taskId}/workflow/retry`, { requestId, instructions: "Fix CI.", expectedRevision: t.waiting.revision });
    expect(again.status).toBe(200);
    expect(t.meta(t.taskId).workflow.revision).toBe(t.waiting.revision + 1);
  });

  it("after three rounds, keeps the count: one Retry is one more round, never three", async () => {
    const t = await blocked((check) => ciFixStopMessage(check, "Error: boom"));
    t.h.db.set({ ...t.meta(t.taskId), workflow: { ...t.meta(t.taskId).workflow, fixRounds: { ci: 3, conflict: 0, feedbackAuto: 0 } } });
    expect((await retry(t)).status).toBe(200);
    expect(t.meta(t.taskId).workflow).toMatchObject({ state: "WAITING", fixRounds: { ci: 3 }, ciFixApproved: [PR.headSha] });
  });

  it("refuses a stale revision, someone who isn't the owner, and a task that is blocked for another reason", async () => {
    const t = await blocked(ciFixAskMessage);
    const stale = await retry(t, MAYA, { expectedRevision: t.waiting.revision - 1 });
    expect(stale.status).toBe(409);
    expect(t.meta(t.taskId).workflow).toMatchObject({ state: "BLOCKED", revision: t.waiting.revision });
    const stranger = await retry(t, OMAR);
    expect([403, 404]).toContain(stranger.status);
    expect(t.meta(t.taskId).workflow.state).toBe("BLOCKED");
    const other = await blocked(() => "The pull request changed on GitHub since I opened it.");
    const refused = await retry(other);
    expect(refused.status).toBe(400);
    expect(other.meta(other.taskId).workflow.state).toBe("BLOCKED");
  });
});
