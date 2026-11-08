// Plan 3, merge of Tasks 32 and 34: the gate between them, end to end. Approving a coding plan whose run limit is above the approver's tier blocks the
// workflow and makes a `run_limit` spend request (Task 34's seam `agents.requestRunLimit`, wired to Task 32's `createSpendRequest`). Coding starts when that
// request is APPROVED, through `resumeAfterRunLimitApproval` and nothing else; a denial or an expiry leaves the task blocked; a replay starts nothing twice.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decideSpendRequest, escalateOwnerRequests, getSpendRequest } from "../../packages/broker/src/spend/requests.js";
import { keyIdOf } from "../../packages/broker/src/org/budget.js";
import { runCostKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { SPEND_REQUEST_TTL_DAYS } from "../../packages/contracts/src/spend.js";
import { agentXError, orgMemberKey, orgRemovedKey } from "@agentx/contracts";
import { createSpendRequest } from "../../packages/broker/src/spend/requests.js";
import { AgentRunStateSchema } from "../../packages/contracts/src/agent-run-node.js";
import { MAYA } from "../support/developer-task-broker.js";
import { ADA, BEN, DEB, PREPARED, TRIAGE, setup, type World } from "../support/spend-world.js";
import { TEST_ORG } from "../support/orgs.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { runLimitAck } from "../support/run-limit-ack.js";

const BLOCKED_WORDS = "This plan's run limit is $20, which needs a project maintainer's approval. I've asked for it.";

/** Five QUICK runs that cost $10 each: the estimate's run limit is $20, above what a member may accept. */
function seedHistory(w: World): void {
  for (let index = 0; index < 5; index += 1) {
    const endedAt = new Date(Date.parse("2026-10-01T00:00:00.000Z") + index * 3_600_000).toISOString();
    w.db.set({ ...runCostKey(TEST_ORG, "payments", "rovara-code", "QUICK", endedAt, `task-quick-${String(index)}`), entityType: "RUN_COST", orgId: TEST_ORG, project: "payments", agentId: "rovara-code", path: "QUICK", taskId: `task-quick-${String(index)}`, endedAt, costUsd: 10 });
  }
}

/** Maya's Quick workflow task, planned and approved by Maya (a member): blocked on its $20 run limit. */
async function blockedPlan(before?: (w: World, taskId: string) => Promise<void>) {
  const w = await setup();
  seedHistory(w);
  const started = await w.api(MAYA, "POST", "/v1/dev/tasks", { project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const taskId = String((started.body.task as { taskId: string }).taskId);
  const workspaceId = w.meta(taskId).workspaceId;
  const planningOperation = (): string => String(w.operations(workspaceId).filter((item) => item.workflowMode === "PLAN" && item.status !== "SUCCEEDED").at(-1)!.id);
  await w.finish(workspaceId, String(w.operations(workspaceId).find((item) => item.kind === "prepare")!.id), "SUCCEEDED", PREPARED);
  await w.artifact(workspaceId, planningOperation(), "plan.md", planAnswer(planDocument()));
  await w.finish(workspaceId, planningOperation(), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
  if (before !== undefined) await before(w, taskId);
  const workflow = w.meta(taskId).workflow as unknown as { revision: number; artifacts: Array<{ sha256: string }> };
  const approved = await w.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, {
    requestId: randomUUID(), expectedRevision: workflow.revision, decision: "APPROVE", reason: "Approved", artifactDigest: workflow.artifacts.at(-1)!.sha256, ...runLimitAck(w.db, taskId),
  });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  const implementations = () => w.operations(workspaceId).filter((item) => item.workflowMode === "IMPLEMENT");
  const requestsOfTask = () => w.requestOf(taskId, "run_limit");
  return { w, taskId, workspaceId, implementations, requestsOfTask };
}

const stillBlocked = (w: World, taskId: string) => expect(w.meta(taskId).workflow).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED", blockReason: BLOCKED_WORDS });

describe("a plan blocked on its run limit, through the real spend request", () => {
  it("makes a run_limit request that a maintainer can decide, and starts nothing yet", async () => {
    const { w, taskId, implementations, requestsOfTask } = await blockedPlan();
    stillBlocked(w, taskId);
    expect(implementations()).toEqual([]);
    const [request] = requestsOfTask();
    expect(requestsOfTask()).toHaveLength(1);
    expect(request).toMatchObject({ kind: "run_limit", status: "PENDING", resume: "implement", newLimitUsd: 20, amountUsd: 18, requestedBy: { kind: "member", developerId: MAYA.developerId } });
    expect(request!.approverIds).toContain(BEN.developerId);
  });

  it("starts coding exactly once when the request is approved, with the approved limit as a new window", async () => {
    const { w, taskId, implementations, requestsOfTask } = await blockedPlan();
    const planningKey = "sk-planning-key";
    w.db.set({ ...w.meta(taskId), modelKeyIds: [keyIdOf(planningKey)] });
    w.access.setKeySpent(planningKey, 1.5);
    const request = requestsOfTask()[0]!;
    const answer = await w.decide(BEN, request.spendRequestId);
    expect(answer.spendRequest).toMatchObject({ status: "APPROVED" });
    expect(implementations()).toHaveLength(1);
    expect(w.meta(taskId)).toMatchObject({ budgetUsd: 20, budgetBaselineUsd: 1.5, workflow: { stage: "IMPLEMENT", state: "RUNNING" } });
    expect(w.meta(taskId).workflow!.blockReason).toBeUndefined();
  });

  it("starts nothing twice when the approval is replayed, or decided again", async () => {
    const { w, taskId, implementations, requestsOfTask } = await blockedPlan();
    const id = requestsOfTask()[0]!.spendRequestId;
    const requestId = randomUUID();
    const first = await decideSpendRequest(w.deps(), w.caller(BEN), id, { requestId, decision: "APPROVE" });
    const revision = w.meta(taskId).workflow!.revision;
    expect(implementations()).toHaveLength(1);
    // The same decision again is the stored answer.
    expect(await decideSpendRequest(w.deps(), w.caller(BEN), id, { requestId, decision: "APPROVE" })).toEqual(first);
    // Another decision on a request that is decided is refused.
    await expect(decideSpendRequest(w.deps(), w.caller(BEN), id, { requestId: randomUUID(), decision: "APPROVE" })).rejects.toMatchObject({ code: "APPROVAL_CLOSED" });
    // The sweep has nothing left to start.
    await escalateOwnerRequests(w.deps(), { budgetMs: 5_000 });
    expect(implementations()).toHaveLength(1);
    expect(w.meta(taskId).workflow!.revision).toBe(revision);
  });

  it("stays blocked when the request is denied, and neither a retry nor a send-back starts coding", async () => {
    const { w, taskId, implementations, requestsOfTask } = await blockedPlan();
    const id = requestsOfTask()[0]!.spendRequestId;
    expect((await w.decide(BEN, id, "DENY")).spendRequest).toMatchObject({ status: "DENIED" });
    stillBlocked(w, taskId);
    expect(implementations()).toEqual([]);
    const before = w.meta(taskId);
    const revision = before.workflow!.revision;
    for (const path of ["retry", "send-back"]) {
      const refused = await w.api(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/${path}`, { expectedRevision: revision, instructions: "Go on." });
      expect(refused, path).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID", message: expect.stringContaining("Coding starts once the run limit is approved.") as unknown } } });
    }
    expect(implementations()).toEqual([]);
    expect(w.meta(taskId)).toEqual(before);
    await escalateOwnerRequests(w.deps(), { budgetMs: 5_000 });
    expect(implementations()).toEqual([]);
  });

  it("stays blocked when the request expires", async () => {
    const { w, taskId, implementations, requestsOfTask } = await blockedPlan();
    const id = requestsOfTask()[0]!.spendRequestId;
    const later = Date.now() + (SPEND_REQUEST_TTL_DAYS + 1) * 86_400_000;
    expect(await escalateOwnerRequests(w.deps(() => later), { budgetMs: 5_000 })).toMatchObject({ expired: 1 });
    expect((await getSpendRequest(w.deps(), TEST_ORG, id))!.status).toBe("EXPIRED");
    await expect(decideSpendRequest(w.deps(() => later), w.caller(BEN), id, { requestId: randomUUID(), decision: "APPROVE" })).rejects.toMatchObject({ code: "APPROVAL_CLOSED" });
    stillBlocked(w, taskId);
    expect(implementations()).toEqual([]);
    const refused = await w.api(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/retry`, { expectedRevision: w.meta(taskId).workflow!.revision, instructions: "Go on." });
    expect(refused).toMatchObject({ status: 400 });
    expect(implementations()).toEqual([]);
  });

  it("starts coding once, later, when the first try after the approval could not (the settlement run tries again)", async () => {
    const { w, taskId, implementations, requestsOfTask } = await blockedPlan();
    const planningKey = "sk-planning-key";
    w.db.set({ ...w.meta(taskId), modelKeyIds: [keyIdOf(planningKey)] });
    // The approval reads what planning spent once, and the resume reads it again; the proxy answers the first and loses the second.
    w.access.keySpend.mockImplementationOnce(async () => 0).mockRejectedValueOnce(new Error("proxy lost"));
    const id = requestsOfTask()[0]!.spendRequestId;
    expect((await w.decide(BEN, id)).spendRequest).toMatchObject({ status: "APPROVED" });
    expect(implementations()).toEqual([]);
    expect(await escalateOwnerRequests(w.deps(), { budgetMs: 5_000 })).toMatchObject({ heldStarts: 1 });
    expect(implementations()).toHaveLength(1);
    expect(w.meta(taskId).workflow).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
    expect(await escalateOwnerRequests(w.deps(), { budgetMs: 5_000 })).toMatchObject({ heldStarts: 0 });
    expect(implementations()).toHaveLength(1);
  });
});

describe("Task 22's run state through Task 32's resume", () => {
  const runItem = (w: World, taskId: string) => w.db.get(`DEVTASK#${taskId}`, "AGENT_RUN") as Record<string, unknown> & { state: string; steps: Array<Record<string, unknown>>; revision: number };

  it("does not start a step for a paused run whose cancel was asked for: the approval's resume ends it CANCELLED", async () => {
    const w = await setup();
    const agentId = await w.agentOf(TRIAGE);
    const run = await w.runOf(agentId);
    await w.set(run.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
    await w.pauseAndEnd(run);
    expect(runItem(w, run.taskId)).toMatchObject({ state: "PAUSED_BUDGET" });
    const paused = runItem(w, run.taskId);
    w.db.set({ ...paused, cancelRequestedAt: new Date().toISOString(), revision: paused.revision + 1 });
    const [request] = w.requestOf(run.taskId);
    await w.decide(BEN, request!.spendRequestId);
    expect(w.taskOps(run.workspaceId)).toHaveLength(1);
    expect(runItem(w, run.taskId)).toMatchObject({ state: "CANCELLED" });
  });

  it("keeps a step's pending branch on the run it resumes, and the run still reads as a run", async () => {
    const w = await setup();
    const agentId = await w.agentOf(TRIAGE);
    const run = await w.runOf(agentId);
    await w.set(run.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
    await w.pauseAndEnd(run);
    const paused = runItem(w, run.taskId);
    const steps = paused.steps.map((step, index) => (index === 1 ? { ...step, pendingBranch: "ship" } : step));
    w.db.set({ ...paused, steps, revision: paused.revision + 1 });
    const [request] = w.requestOf(run.taskId);
    await w.decide(BEN, request!.spendRequestId);
    const resumed = runItem(w, run.taskId);
    expect(AgentRunStateSchema.safeParse(Object.fromEntries(Object.entries(resumed).filter(([key]) => !["pk", "sk", "entityType"].includes(key)))).success).toBe(true);
    expect(resumed.steps[1]).toMatchObject({ pendingBranch: "ship" });
    expect(resumed.state).toBe("RUNNING");
  });
});

describe("the org's only owner or admin, who started a run and is not its payer (Task 32 concern 1)", () => {
  /** Ada (the only owner or admin when `secondAdmin` is false) runs an agent whose limit is past the admin threshold; Ben pays. */
  async function adaRun(options: { secondAdmin: boolean }) {
    const w = await setup({ secondAdmin: options.secondAdmin });
    const agentId = await w.agentOf(TRIAGE, { by: ADA, name: "Ada's looker" });
    const run = await w.runOf(agentId, { who: ADA });
    await w.set(run.taskId, "SET budgetUsd = :limit, payer = :payer", { ":limit": 300, ":payer": { kind: "member", developerId: BEN.developerId } });
    await w.pauseAndEnd(run);
    const [request] = w.requestOf(run.taskId, "run_limit");
    return { w, run, request: request! };
  }

  it("may decide the run limit of their own run: nobody else could", async () => {
    const { w, run, request } = await adaRun({ secondAdmin: false });
    expect(request).toMatchObject({ kind: "run_limit", approverRole: "org_admin", requestedFor: { developerId: ADA.developerId } });
    expect(request.approverIds).toEqual([ADA.developerId]);
    expect((await w.decide(ADA, request.spendRequestId)).spendRequest).toMatchObject({ status: "APPROVED" });
    expect(w.meta(run.taskId).budgetUsd).toBeGreaterThan(300);
  });

  it("is still kept from their own run's limit when another owner or admin exists", async () => {
    const { w, request } = await adaRun({ secondAdmin: true });
    expect(request.approverIds).toEqual([DEB.developerId]);
    await expect(w.decide(ADA, request.spendRequestId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await w.decide(DEB, request.spendRequestId)).spendRequest).toMatchObject({ status: "APPROVED" });
  });
});

// The merge review's fixes (I-1, M-1, M-2, M-4, M-5).
describe("an approved run limit's start, kept until it is made or can never be", () => {
  /** Deps whose resume fails the way `systemTaskAccess` does when the task-people proof could not be read. */
  const unverified = (w: World) => {
    const deps = w.deps();
    return { ...deps, spendRequests: { ...deps.spendRequests!, resumeTask: async () => { throw agentXError("TASK_ACCESS_DENIED", "task access could not be verified"); } } };
  };
  const heldItems = (w: World) => w.db.find((item) => item.entityType === "SPEND_HELD_START");
  /** A blocked plan whose approval committed but whose start failed: the held item is left. */
  async function approvedButNotStarted() {
    const planned = await blockedPlan();
    const id = planned.requestsOfTask()[0]!.spendRequestId;
    await decideSpendRequest(unverified(planned.w), planned.w.caller(BEN), id, { requestId: randomUUID(), decision: "APPROVE" });
    expect(heldItems(planned.w)).toHaveLength(1);
    expect(planned.implementations()).toEqual([]);
    return planned;
  }

  it("I-1: a task-access proof that could not be read keeps the item, and coding starts on a later pass", async () => {
    const { w, taskId, implementations } = await approvedButNotStarted();
    expect(await escalateOwnerRequests(unverified(w), { budgetMs: 5_000 })).toMatchObject({ heldStarts: 0 });
    expect(heldItems(w)).toHaveLength(1);
    expect(implementations()).toEqual([]);
    expect(await escalateOwnerRequests(w.deps(), { budgetMs: 5_000 })).toMatchObject({ heldStarts: 1 });
    expect(implementations()).toHaveLength(1);
    expect(w.meta(taskId).workflow).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
    expect(heldItems(w)).toEqual([]);
  });

  it("I-1: a creator who was really removed drops the item, and nothing starts", async () => {
    const { w, implementations } = await approvedButNotStarted();
    expect(w.db.get(orgMemberKey(TEST_ORG, MAYA.developerId))).toBeDefined();
    w.db.delete(orgMemberKey(TEST_ORG, MAYA.developerId));
    w.db.set({ ...orgRemovedKey(TEST_ORG, MAYA.developerId), entityType: "ORG_REMOVED", orgId: TEST_ORG, developerId: MAYA.developerId, removedAt: new Date().toISOString() });
    expect(await escalateOwnerRequests(w.deps(), { budgetMs: 5_000 })).toMatchObject({ heldStarts: 0 });
    expect(heldItems(w)).toEqual([]);
    expect(implementations()).toEqual([]);
  });

  it("M-4: a closed task drops the item and nothing starts", async () => {
    const { w, taskId, implementations } = await approvedButNotStarted();
    await w.set(taskId, "SET closedAt = :at", { ":at": new Date().toISOString() });
    expect(await escalateOwnerRequests(w.deps(), { budgetMs: 5_000 })).toMatchObject({ heldStarts: 0 });
    expect(heldItems(w)).toEqual([]);
    expect(implementations()).toEqual([]);
  });

  it("M-4 and M-5: a task whose workspace is closed (cancelled) answers STALE: the item is dropped, nothing starts, and no start is counted", async () => {
    const { w, workspaceId, implementations } = await approvedButNotStarted();
    w.db.set({ ...w.db.get(`WORKSPACE#${workspaceId}`, "META")!, status: "CLOSED", closedAt: new Date().toISOString() });
    expect(await escalateOwnerRequests(w.deps(), { budgetMs: 5_000 })).toMatchObject({ heldStarts: 0 });
    expect(heldItems(w)).toEqual([]);
    expect(implementations()).toEqual([]);
  });

  it("M-5: a plan that is no longer blocked on its run limit is not counted as a start", async () => {
    const { w, taskId, implementations } = await approvedButNotStarted();
    const meta = w.meta(taskId);
    const { blockReason: _blockReason, ...rest } = meta.workflow as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unused-vars -- the block is what goes away
    w.db.set({ ...meta, workflow: { ...rest, state: "RUNNING" } });
    expect(await escalateOwnerRequests(w.deps(), { budgetMs: 5_000 })).toMatchObject({ heldStarts: 0 });
    expect(heldItems(w)).toEqual([]);
    expect(implementations()).toEqual([]);
  });

  it("M-4: the approval and the settlement run racing start coding once", async () => {
    const { w, taskId, implementations, requestsOfTask } = await blockedPlan();
    const real = w.deps();
    const racing = { ...real, spendRequests: { ...real.spendRequests!, resumeTask: async (input: Parameters<NonNullable<typeof real.spendRequests>["resumeTask"]>[0]) => {
      // The approval's own start has not run yet; the settlement run finds the held item first.
      expect(await escalateOwnerRequests(w.deps(), { budgetMs: 5_000 })).toMatchObject({ heldStarts: 1 });
      return real.spendRequests!.resumeTask(input);
    } } };
    await decideSpendRequest(racing, w.caller(BEN), requestsOfTask()[0]!.spendRequestId, { requestId: randomUUID(), decision: "APPROVE" });
    expect(implementations()).toHaveLength(1);
    expect(w.meta(taskId).workflow).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
    expect(heldItems(w)).toEqual([]);
  });

  it("M-1: an open run_limit request that resumes nothing is not the plan's request: the plan gets its own, and approving it starts coding", async () => {
    const { w, taskId, implementations, requestsOfTask } = await blockedPlan(async (world, id) => {
      await createSpendRequest(world.deps(), {
        orgId: TEST_ORG, kind: "run_limit", scope: { kind: "task", taskId: id }, taskId: id, amountUsd: 5, newLimitUsd: 12, reason: "More for this run.",
        requestedBy: { kind: "system" }, resume: "continue",
      });
    });
    const open = requestsOfTask();
    expect(open.map((record) => record.resume).sort()).toEqual(["continue", "implement"]);
    const plans = open.find((record) => record.resume === "implement")!;
    expect(plans).toMatchObject({ status: "PENDING", newLimitUsd: 20 });
    expect((await w.decide(BEN, plans.spendRequestId)).spendRequest).toMatchObject({ status: "APPROVED" });
    expect(implementations()).toHaveLength(1);
    expect(w.meta(taskId).workflow).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
  });

  it("M-2: approving a plan's request after the plan moved on does not rewrite the run's limit or window", async () => {
    const { w, taskId, implementations, requestsOfTask } = await blockedPlan();
    const meta = w.meta(taskId);
    const { blockReason: _blockReason, ...rest } = meta.workflow as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unused-vars -- the block is what goes away
    w.db.set({ ...meta, workflow: { ...rest, state: "RUNNING" }, budgetUsd: 7, budgetBaselineUsd: 3 });
    expect((await w.decide(BEN, requestsOfTask()[0]!.spendRequestId)).spendRequest).toMatchObject({ status: "APPROVED" });
    expect(w.meta(taskId)).toMatchObject({ budgetUsd: 7, budgetBaselineUsd: 3, workflow: { state: "RUNNING" } });
    expect(implementations()).toEqual([]);
    expect(heldItems(w)).toEqual([]);
  });
});
