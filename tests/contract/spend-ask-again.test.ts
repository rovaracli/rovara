// Plan 3 final fix wave (money I-3): a task-level pause whose request ended (denied, expired, or never made) can be asked for again by the task's owner, on the
// route a plan's run limit already has (`POST /v1/app/tasks/{id}/run-limit-request`, its ten-minute cooldown, R18). A task paused on a month's budget is resumed by
// the settlement job when a new month brings room back, with no person to press anything (event and schedule runs).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RUN_LIMIT_ASK_COOLDOWN_MS, scopeKey, spendCounterKey, type BudgetScope } from "@agentx/cloud-contracts";
import { startAgentRun } from "../../packages/broker/src/agents/runs.js";
import { escalateOwnerRequests } from "../../packages/broker/src/spend/requests.js";
import { MAYA } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { BEN, DEB, TRIAGE, month, setup, type World } from "../support/spend-world.js";

const ask = (t: World, who: typeof MAYA, taskId: string, requestId = randomUUID()) => t.api(who, "POST", `/v1/app/tasks/${taskId}/run-limit-request`, { requestId });

/** Ben's run of Maya's agent, paused at its max per run of $4: Maya's to decide. */
async function maxPaused(t: World) {
  const agentId = await t.agentOf(TRIAGE, { name: "Ticket looker" });
  expect((await t.setBudget(MAYA, agentId, { maxPerRunUsd: 4 })).status).toBe(200);
  await t.shareWith(agentId, BEN);
  const run = await t.runOf(agentId, { who: BEN });
  await t.set(run.taskId, "SET budgetUsd = :limit", { ":limit": 25 });
  await t.pauseAndEnd(run, { kind: "max_per_run", taskId: run.taskId });
  return { agentId, ...run, request: t.requestOf(run.taskId, "max_per_run")[0]! };
}

describe("an owner asks again for a task-level pause", () => {
  it("an agent-step run paused at its max per run, whose request was denied, is asked for again: a new request to the same approver, once per ten minutes, and R18", async () => {
    const t = await setup();
    const { taskId, request } = await maxPaused(t);
    await t.decide(MAYA, request.spendRequestId, "DENY");
    expect(t.openItems()).toEqual([]);
    const requestId = randomUUID();
    const asked = await ask(t, BEN, taskId, requestId);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body).toMatchObject({ created: true, spendRequestId: expect.stringMatching(/^spr_/u) as string });
    const fresh = t.requestOf(taskId, "max_per_run").find((record) => record.status === "PENDING")!;
    expect(fresh.spendRequestId).not.toBe(request.spendRequestId);
    expect(fresh).toMatchObject({ kind: "max_per_run", taskId, approverIds: [MAYA.developerId], requestedBy: { kind: "system" } });
    expect(asked.body.spendRequestId).toBe(fresh.spendRequestId);
    // R18: the same request id answers what it first did, and asks nothing more.
    const replay = await ask(t, BEN, taskId, requestId);
    expect(replay).toMatchObject({ status: 201, body: { created: true, spendRequestId: fresh.spendRequestId } });
    // While it is open, another id is answered with the open one.
    const open = await ask(t, BEN, taskId);
    expect(open).toMatchObject({ status: 200, body: { created: false, spendRequestId: fresh.spendRequestId } });
    expect(t.requestOf(taskId, "max_per_run")).toHaveLength(2);
    // Deny that one too: the ten-minute cooldown holds the next ask.
    await t.decide(MAYA, fresh.spendRequestId, "DENY");
    const soon = await ask(t, BEN, taskId);
    expect(soon.status).toBe(400);
    expect(JSON.stringify(soon.body)).toContain("You asked for this run limit a few minutes ago");
    expect(RUN_LIMIT_ASK_COOLDOWN_MS).toBe(10 * 60_000);
  });

  it("and the owner's approval then resumes the run", async () => {
    const t = await setup();
    const { taskId, workspaceId, request } = await maxPaused(t);
    await t.decide(MAYA, request.spendRequestId, "DENY");
    await ask(t, BEN, taskId);
    const fresh = t.requestOf(taskId, "max_per_run").find((record) => record.status === "PENDING")!;
    const before = t.taskOps(workspaceId).length;
    await t.decide(MAYA, fresh.spendRequestId);
    expect(t.meta(taskId).budgetPause).toBeUndefined();
    expect(t.taskOps(workspaceId)).toHaveLength(before + 1);
  });

  it("a request past its expiry that the sweep has not ended yet is ended first, and the owner's ask makes a new one at once", async () => {
    const t = await setup();
    const { taskId, request } = await maxPaused(t);
    // Its time is up but nothing has swept it: it is still the open request.
    t.db.set({ ...t.requests().find((record) => record.spendRequestId === request.spendRequestId)!, expiresAt: new Date(Date.now() - 60_000).toISOString() });
    expect(t.openItems()).toHaveLength(1);
    const asked = await ask(t, BEN, taskId);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body).toMatchObject({ created: true });
    expect(asked.body.spendRequestId).not.toBe(request.spendRequestId);
    expect(t.requestOf(taskId, "max_per_run").find((record) => record.spendRequestId === request.spendRequestId)).toMatchObject({ status: "EXPIRED" });
    expect(t.requestOf(taskId, "max_per_run").filter((record) => record.status === "PENDING")).toHaveLength(1);
  });

  it("an agent-step run paused on its run limit, whose request ran out, is asked for again by its owner", async () => {
    const t = await setup();
    const agentId = await t.agentOf(TRIAGE);
    const run = await t.runOf(agentId);
    await t.set(run.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
    await t.pauseAndEnd(run);
    const [first] = t.requestOf(run.taskId, "run_limit");
    const after = Date.parse(first!.expiresAt) + 1;
    await escalateOwnerRequests(t.deps(() => after), { budgetMs: 5_000 });
    expect(t.requestOf(run.taskId, "run_limit")[0]).toMatchObject({ status: "EXPIRED" });
    const asked = await ask(t, MAYA, run.taskId);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(t.requestOf(run.taskId, "run_limit").filter((record) => record.status === "PENDING")).toHaveLength(1);
  });

  it("a run held at its start whose request was denied is asked for again, and approving it makes the first dispatch", async () => {
    const t = await setup();
    const started = await startAgentRun(t.starter(), {
      requestId: randomUUID(), orgId: TEST_ORG, project: "payments", agent: { agentId: "rovara-code" }, input: { text: "Fix the retry bug" }, origin: "app",
      owner: { developerId: MAYA.developerId }, startedBy: { developerId: MAYA.developerId }, payer: { kind: "member", developerId: MAYA.developerId }, runLimitUsd: 0,
    });
    const [first] = t.requestOf(started.taskId);
    await t.decide(MAYA, first!.spendRequestId, "DENY");
    const asked = await ask(t, MAYA, started.taskId);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const fresh = t.requestOf(started.taskId).find((record) => record.status === "PENDING")!;
    const { workspaceId } = t.meta(started.taskId);
    const prepare = t.operations(workspaceId).find((operation) => operation.kind === "prepare")!;
    expect(t.outboxOf(prepare.id)).toBeUndefined();
    await t.decide(MAYA, fresh.spendRequestId);
    expect(t.outboxOf(prepare.id)).toBeDefined();
  });

  it("and one whose first ask failed (no request exists at all) is asked for by the owner", async () => {
    const t = await setup();
    const started = await startAgentRun(t.starter(), {
      requestId: randomUUID(), orgId: TEST_ORG, project: "payments", agent: { agentId: "rovara-code" }, input: { text: "Fix the retry bug" }, origin: "app",
      owner: { developerId: MAYA.developerId }, startedBy: { developerId: MAYA.developerId }, payer: { kind: "member", developerId: MAYA.developerId }, runLimitUsd: 0,
    });
    for (const record of t.requestOf(started.taskId)) t.db.delete({ pk: `ORG#${TEST_ORG}#SPEND_REQUEST#${record.spendRequestId}`, sk: "META" } as never);
    for (const item of t.openItems()) t.db.delete({ pk: String(item.pk), sk: String(item.sk) } as never);
    for (const item of t.db.find((entry) => String(entry.pk).includes("SPEND_REQUEST_FOR#"))) t.db.delete({ pk: String(item.pk), sk: String(item.sk) } as never);
    expect(t.requestOf(started.taskId)).toEqual([]);
    const asked = await ask(t, MAYA, started.taskId);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(t.requests().filter((record) => record.taskId === started.taskId && record.status === "PENDING")).toHaveLength(1);
  });

  it("is for the task's owner only, and for a task that is paused on a limit: anyone else gets the answer a task they can't see gets", async () => {
    const t = await setup();
    const { taskId } = await maxPaused(t);
    expect((await ask(t, MAYA, taskId)).status).toBe(404);
    expect((await ask(t, DEB, taskId)).status).toBe(404);
    const plain = await t.plainTask();
    const refused = await ask(t, MAYA, plain.taskId);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain("not waiting");
  });
});

describe("a new month resumes the tasks the last month stopped", () => {
  const MEMBER: BudgetScope = { kind: "member", developerId: MAYA.developerId };
  const nextMonthStart = () => {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 10);
  };
  const monthOf = (at: number) => new Date(at).toISOString().slice(0, 7);

  it("resumes a task listed under a month's scope once the new month has room, keeping its window, with nobody pressing anything", async () => {
    const t = await setup();
    const task = await t.plainTask();
    await t.set(task.taskId, "SET budgetBaselineUsd = :baseline", { ":baseline": 3 });
    await t.pauseAndEnd(task, MEMBER);
    expect(t.meta(task.taskId).budgetPause).toMatchObject({ scope: MEMBER });
    const before = t.taskOps(task.workspaceId).length;
    // The same month brings no room.
    await escalateOwnerRequests(t.deps(), { budgetMs: 5_000 });
    expect(t.meta(task.taskId).budgetPause).toBeDefined();
    const next = nextMonthStart();
    const result = await escalateOwnerRequests(t.deps(() => next), { budgetMs: 5_000 });
    expect(result).toMatchObject({ monthResumes: 1 });
    expect(t.meta(task.taskId).budgetPause).toBeUndefined();
    expect(t.meta(task.taskId).budgetBaselineUsd).toBe(3);
    expect(t.taskOps(task.workspaceId)).toHaveLength(before + 1);
    // Told once: the job finds nothing more.
    expect(await escalateOwnerRequests(t.deps(() => next + 60_000), { budgetMs: 5_000 })).toMatchObject({ monthResumes: 0 });
    expect(t.taskOps(task.workspaceId)).toHaveLength(before + 1);
  });

  it("resumes an agent-step run the same way", async () => {
    const t = await setup();
    const agentId = await t.agentOf(TRIAGE);
    const run = await t.runOf(agentId);
    await t.pauseAndEnd(run, MEMBER);
    expect(t.db.get(`DEVTASK#${run.taskId}`, "AGENT_RUN")).toMatchObject({ state: "PAUSED_BUDGET" });
    await escalateOwnerRequests(t.deps(() => nextMonthStart()), { budgetMs: 5_000 });
    expect(t.db.get(`DEVTASK#${run.taskId}`, "AGENT_RUN")).toMatchObject({ state: "RUNNING" });
    expect(t.taskOps(run.workspaceId)).toHaveLength(2);
  });

  it("does not resume a task whose scope has no room in the new month, and keeps it listed", async () => {
    const t = await setup();
    const task = await t.plainTask();
    await t.pauseAndEnd(task, MEMBER);
    const next = nextMonthStart();
    const counter = spendCounterKey(TEST_ORG, monthOf(next), scopeKey(MEMBER));
    t.db.set({ ...counter, entityType: "SPEND_COUNTER", spentUsd: 1000, committedUsd: 1000 });
    const before = t.taskOps(task.workspaceId).length;
    await escalateOwnerRequests(t.deps(() => next), { budgetMs: 5_000 });
    expect(t.meta(task.taskId).budgetPause).toMatchObject({ scope: MEMBER });
    expect(t.taskOps(task.workspaceId)).toHaveLength(before);
    expect(month()).not.toBe(monthOf(next));
  });

  it("leaves a task that closed or went on, and drops its listing", async () => {
    const t = await setup();
    const task = await t.plainTask();
    await t.pauseAndEnd(task, MEMBER);
    await t.set(task.taskId, "SET closedAt = :now", { ":now": new Date().toISOString() });
    const before = t.taskOps(task.workspaceId).length;
    await escalateOwnerRequests(t.deps(() => nextMonthStart()), { budgetMs: 5_000 });
    expect(t.taskOps(task.workspaceId)).toHaveLength(before);
    expect(t.db.find((item) => item.pk === "MONTH_PAUSED_TASKS")).toEqual([]);
  });

  it("drops the scope's own listing too, when no request is left to settle that scope (the month's request ended with the month)", async () => {
    const t = await setup();
    const task = await t.plainTask();
    await t.pauseAndEnd(task, MEMBER);
    await t.set(task.taskId, "SET closedAt = :now", { ":now": new Date().toISOString() });
    // Nothing is open any more, as when the request was swept in the month it was made.
    for (const record of t.requests()) t.db.delete({ pk: `ORG#${TEST_ORG}#SPEND_REQUEST#${record.spendRequestId}`, sk: "META" } as never);
    for (const item of t.openItems()) t.db.delete({ pk: String(item.pk), sk: String(item.sk) } as never);
    expect(t.db.find((item) => item.entityType === "PAUSED_TASK")).toHaveLength(1);
    await escalateOwnerRequests(t.deps(() => nextMonthStart()), { budgetMs: 5_000 });
    expect(t.db.find((item) => item.entityType === "MONTH_PAUSED_TASK")).toEqual([]);
    expect(t.db.find((item) => item.entityType === "PAUSED_TASK")).toEqual([]);
  });
});
