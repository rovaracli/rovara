// Plan 3 Task 35b (coordinator ruling 2026-10-22): after a run limit request is DENIED or EXPIRES, the task's owner can ask again. A plan blocked on its run
// limit has one way on, the run limit's approval (Task 34); a denied or expired request used to leave it blocked for good. `POST /v1/app/tasks/{id}/run-limit-request`
// makes a new `run_limit` request for the same plan and limit, once the old one has ended. It asks; it decides nothing (R66): coding starts only when the new
// request is approved on its page. The task view says whether the owner may ask (`runLimit`).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { escalateOwnerRequests } from "../../packages/broker/src/spend/requests.js";
import { runCostKey, spendRequestKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { SPEND_REQUEST_TTL_DAYS } from "../../packages/contracts/src/spend.js";
import { MAYA } from "../support/developer-task-broker.js";
import { BEN, CARL, PREPARED, setup, type World } from "../support/spend-world.js";
import { TEST_ORG } from "../support/orgs.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

/** Five QUICK runs that cost $10 each: the estimate's run limit is $20, above what a member may accept. */
function seedHistory(w: World): void {
  for (let index = 0; index < 5; index += 1) {
    const endedAt = new Date(Date.parse("2026-10-01T00:00:00.000Z") + index * 3_600_000).toISOString();
    w.db.set({ ...runCostKey(TEST_ORG, "payments", "rovara-code", "QUICK", endedAt, `task-quick-${String(index)}`), entityType: "RUN_COST", orgId: TEST_ORG, project: "payments", agentId: "rovara-code", path: "QUICK", taskId: `task-quick-${String(index)}`, endedAt, costUsd: 10 });
  }
}

/** Maya's Quick workflow task, planned and approved by Maya (a member): blocked on its $20 run limit, with its request open. */
async function blockedPlan() {
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
  const workflow = w.meta(taskId).workflow as unknown as { revision: number; artifacts: Array<{ sha256: string }> };
  const approved = await w.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, {
    requestId: randomUUID(), expectedRevision: workflow.revision, decision: "APPROVE", reason: "Approved", artifactDigest: workflow.artifacts.at(-1)!.sha256,
  });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  const implementations = () => w.operations(workspaceId).filter((item) => item.workflowMode === "IMPLEMENT");
  const requestsOfTask = () => w.requestOf(taskId, "run_limit");
  const path = `/v1/app/tasks/${taskId}/run-limit-request`;
  const ask = (who = MAYA, body: Record<string, unknown> = {}) => w.api(who, "POST", path, body);
  const later = () => Date.now() + (SPEND_REQUEST_TTL_DAYS + 1) * 86_400_000;
  return { w, taskId, workspaceId, implementations, requestsOfTask, ask, path, later };
}

const runLimitOf = async (w: World, taskId: string) => (await w.view(MAYA, taskId) as { runLimit?: { limitUsd: number; spendRequestId?: string; canAskAgain: boolean } }).runLimit;

describe("asking again for a run limit that was denied", () => {
  it("makes a new request for the same plan and limit, routed as the first was, and starts nothing", async () => {
    const { w, taskId, implementations, requestsOfTask, ask } = await blockedPlan();
    const first = requestsOfTask()[0]!;
    await w.decide(BEN, first.spendRequestId, "DENY");
    const answer = await ask();
    expect(answer.status, JSON.stringify(answer.body)).toBe(201);
    const open = requestsOfTask().filter((record) => record.status === "PENDING");
    expect(open).toHaveLength(1);
    expect(open[0]!.spendRequestId).not.toBe(first.spendRequestId);
    expect(open[0]).toMatchObject({ kind: "run_limit", resume: "implement", newLimitUsd: 20, amountUsd: 18, requestedBy: { kind: "member", developerId: MAYA.developerId }, requestedFor: { developerId: MAYA.developerId } });
    expect(open[0]!.approverIds).toContain(BEN.developerId);
    expect(requestsOfTask().find((record) => record.spendRequestId === first.spendRequestId)).toMatchObject({ status: "DENIED" });
    expect(answer.body).toMatchObject({ spendRequestId: open[0]!.spendRequestId, created: true });
    // Asking decided nothing: still blocked, no coding, the run limit not raised.
    expect(implementations()).toEqual([]);
    expect(w.meta(taskId).workflow).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED" });
    expect(w.meta(taskId).budgetUsd).not.toBe(20);
  });

  it("starts coding once, when the new request is approved", async () => {
    const { w, taskId, implementations, requestsOfTask, ask } = await blockedPlan();
    await w.decide(BEN, requestsOfTask()[0]!.spendRequestId, "DENY");
    const asked = await ask();
    expect((await w.decide(BEN, String(asked.body.spendRequestId))).spendRequest).toMatchObject({ status: "APPROVED" });
    expect(implementations()).toHaveLength(1);
    expect(w.meta(taskId)).toMatchObject({ budgetUsd: 20, workflow: { stage: "IMPLEMENT", state: "RUNNING" } });
    // Nothing is left to ask: the plan is running.
    expect(await ask()).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID" } } });
    expect(implementations()).toHaveLength(1);
  });

  it("can be asked again after the second one is denied too", async () => {
    const { w, requestsOfTask, ask } = await blockedPlan();
    await w.decide(BEN, requestsOfTask()[0]!.spendRequestId, "DENY");
    const second = await ask();
    await w.decide(BEN, String(second.body.spendRequestId), "DENY");
    const third = await ask();
    expect(third.status).toBe(201);
    expect(requestsOfTask()).toHaveLength(3);
    expect(new Set(requestsOfTask().map((record) => record.spendRequestId)).size).toBe(3);
  });
});

describe("asking again for a run limit whose request ran out", () => {
  it("makes a new request after the old one expired", async () => {
    const { w, taskId, implementations, requestsOfTask, ask, later } = await blockedPlan();
    const first = requestsOfTask()[0]!.spendRequestId;
    expect(await escalateOwnerRequests(w.deps(() => later()), { budgetMs: 5_000 })).toMatchObject({ expired: 1 });
    expect(requestsOfTask()[0]).toMatchObject({ status: "EXPIRED" });
    const answer = await ask();
    expect(answer.status, JSON.stringify(answer.body)).toBe(201);
    expect(answer.body.spendRequestId).not.toBe(first);
    expect(requestsOfTask().filter((record) => record.status === "PENDING")).toHaveLength(1);
    expect(implementations()).toEqual([]);
    expect(w.meta(taskId).workflow).toMatchObject({ state: "BLOCKED" });
  });

  it("can be asked when the request's time has run out but the sweep has not ended it yet", async () => {
    const { w, requestsOfTask, ask } = await blockedPlan();
    // The request reads EXPIRED to everyone before the sweep ends it (spendRequestView), so the owner is not told to wait for a request nobody can decide.
    const record = requestsOfTask()[0]!;
    const key = spendRequestKey(TEST_ORG, record.spendRequestId);
    w.db.set({ ...w.db.get(key.pk, key.sk)!, expiresAt: new Date(Date.now() - 1000).toISOString() });
    const view = await runLimitOf(w, record.taskId!);
    expect(view).toMatchObject({ canAskAgain: true });
    expect(view?.spendRequestId).toBeUndefined();
    expect((await ask()).status).toBe(201);
  });
});

describe("asking while a request is open, and asking twice", () => {
  it("answers the open request, makes none, and says it made none", async () => {
    const { requestsOfTask, ask } = await blockedPlan();
    const open = requestsOfTask()[0]!.spendRequestId;
    const answer = await ask();
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ spendRequestId: open, created: false });
    expect(requestsOfTask()).toHaveLength(1);
  });

  it("answers a repeat of the same request ID with what it first did, even after the request it made was denied", async () => {
    const { w, requestsOfTask, ask } = await blockedPlan();
    await w.decide(BEN, requestsOfTask()[0]!.spendRequestId, "DENY");
    const requestId = randomUUID();
    const first = await ask(MAYA, { requestId });
    expect(first.status).toBe(201);
    await w.decide(BEN, String(first.body.spendRequestId), "DENY");
    const repeat = await ask(MAYA, { requestId });
    expect(repeat.body.spendRequestId).toBe(first.body.spendRequestId);
    expect(requestsOfTask()).toHaveLength(2);
  });
});

describe("who may ask, and when", () => {
  it("is the task's owner only: anyone else gets the answer a task they can't see gets", async () => {
    const { w, requestsOfTask, ask } = await blockedPlan();
    await w.decide(BEN, requestsOfTask()[0]!.spendRequestId, "DENY");
    for (const who of [BEN, CARL]) expect(await ask(who), who.name).toMatchObject({ status: 404, body: { error: { code: "TASK_NOT_FOUND" } } });
    expect(requestsOfTask().filter((record) => record.status === "PENDING")).toEqual([]);
  });

  it("is refused for a task that is not blocked on a run limit", async () => {
    const w = await setup();
    const task = await w.plainTask();
    const refused = await w.api(MAYA, "POST", `/v1/app/tasks/${task.taskId}/run-limit-request`, {});
    expect(refused).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID", message: expect.stringContaining("not waiting for a run limit") as unknown } } });
    expect(w.requests()).toEqual([]);
  });

  it("refuses a body with anything else in it", async () => {
    const { requestsOfTask, w, ask } = await blockedPlan();
    await w.decide(BEN, requestsOfTask()[0]!.spendRequestId, "DENY");
    expect((await ask(MAYA, { amountUsd: 1 })).status).toBe(400);
    expect(requestsOfTask().filter((record) => record.status === "PENDING")).toEqual([]);
  });

  it("is a POST only", async () => {
    const { w, path } = await blockedPlan();
    expect((await w.api(MAYA, "GET", path)).status).toBe(404);
  });
});

describe("what the task view says", () => {
  it("offers asking again only while no request is open", async () => {
    const { w, taskId, requestsOfTask, ask } = await blockedPlan();
    const open = requestsOfTask()[0]!.spendRequestId;
    expect(await runLimitOf(w, taskId)).toEqual({ limitUsd: 20, spendRequestId: open, canAskAgain: false });
    await w.decide(BEN, open, "DENY");
    expect(await runLimitOf(w, taskId)).toEqual({ limitUsd: 20, canAskAgain: true });
    const asked = await ask();
    expect(await runLimitOf(w, taskId)).toEqual({ limitUsd: 20, spendRequestId: asked.body.spendRequestId, canAskAgain: false });
  });

  it("says nothing of a run limit on a task that is not blocked on one, and once coding has started", async () => {
    const w = await setup();
    const task = await w.plainTask();
    expect(await runLimitOf(w, task.taskId)).toBeUndefined();
    const { w: blocked, taskId, requestsOfTask } = await blockedPlan();
    await blocked.decide(BEN, requestsOfTask()[0]!.spendRequestId);
    expect(await runLimitOf(blocked, taskId)).toBeUndefined();
  });
});
