import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
// Plan 3 Task 32: run-limit, planning and max-per-run requests that resume in place, and the owner-cap requests of agent budget changes. A run that reached
// one of its own limits asks the person who may raise it (`spendApprovers`, read live); the approval raises the limit in the same transaction that ends the
// request, and the task goes on where it stopped: a plain task with a system Continue, a workflow task with its stage's retry, an agent-step run with the same
// step. An agent budget change that would take one person past the owner cap answers 202 and waits for an org admin; nothing changes until then.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { onMemberRemoved, onMembersMerged } from "../../packages/broker/src/agents/lifecycle.js";
import { startAgentRun } from "../../packages/broker/src/agents/runs.js";
import {
  createSpendRequest, decideSpendRequest, escalateOwnerRequests, getSpendRequest, routeSpendRequests, spendApprovers, spendDecideKind,
} from "../../packages/broker/src/spend/requests.js";
import { runSpendSweep, settlementBudgets, SETTLEMENT_BUDGETS_MS } from "../../packages/broker/src/spend/settlement-job.js";
import { supersedeKeys, finalizeKey } from "../../packages/broker/src/spend/ledger.js";
import { DECIDE_COOKIE, DecideStore, csrfTokenFor } from "../../packages/broker/src/developer/decide-session.js";
import { defaultSpendPolicy, ownerBudgetKey, orgSettingsKey, OWNER_ANSWER_HOURS, SPEND_RESUME_INSTRUCTIONS, WORKFLOW_BLOCK_REASONS, TRIAL_LIMITS_R49, modelKeyKey, openSpendRequestsKey, orgMemberKey, orgRemovedKey, spendCounterKey, spendRequestKey, suggestedTopUpUsd } from "@agentx/cloud-contracts";
import { DEFAULT_AGENT_GUARDRAILS, ROVARA_CODE_AGENT_ID, agentGuardrailsKey } from "@rovara-code/contracts";
import { projectMemberKey } from "@rovara-code/contracts";
import { MAYA, OMAR, seedMembership } from "../support/developer-task-broker.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { TEST_ORG } from "../support/orgs.js";
import { call } from "../support/slack-broker.js";
import { ADA, BEN, CARL, CELL, CODING, DEB, ORG_B, TRIAGE, month, person, refusal, setup, sha, type World } from "../support/spend-world.js";


afterEach(() => undefined);

// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("a run-limit pause asks for more", () => {
  it("a $14 run-limit pause asks $7 for $21, routed to the project's maintainers, with the exact words, and the task shows it", async () => {
    const t = await setup();
    const task = await t.plainTask();
    await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
    await t.pauseAndEnd(task);
    const [request] = t.requestOf(task.taskId);
    expect(request).toMatchObject({
      orgId: TEST_ORG, kind: "run_limit", scope: { kind: "task", taskId: task.taskId }, taskId: task.taskId, amountUsd: 7, newLimitUsd: 21,
      reason: "This task needs about $7 more to finish. I asked a project maintainer to approve it.",
      requestedBy: { kind: "system" }, approverRole: "project_maintainer", approverIds: [BEN.developerId], status: "PENDING", resume: "continue",
    });
    expect(request!.spendRequestId).toMatch(/^spr_[0-9a-z]{20}$/);
    expect(Date.parse(request!.expiresAt) - Date.parse(request!.createdAt)).toBe(7 * 24 * 3_600_000);
    expect(t.openItems().map((item) => item.spendRequestId)).toEqual([request!.spendRequestId]);
    const shown = await t.view(MAYA, task.taskId);
    expect(shown.paused).toMatchObject({ reason: "budget", spendRequestId: request!.spendRequestId, scope: { kind: "task", taskId: task.taskId } });
    expect(t.taskEvents(task.taskId)).toContain("This task needs about $7 more to finish. I asked a project maintainer to approve it.");
  });

  it("asks the payer when the new limit is within the lead's threshold, and an admin above the admin's", async () => {
    const t = await setup();
    const small = await t.plainTask();
    await t.set(small.taskId, "SET budgetUsd = :limit", { ":limit": 4 });
    await t.pauseAndEnd(small);
    expect(t.requestOf(small.taskId)[0]).toMatchObject({ amountUsd: 5, newLimitUsd: 9, approverRole: "payer", approverIds: [MAYA.developerId], reason: "This task needs about $5 more to finish. I asked the payer to approve it." });
    const large = await t.plainTask();
    await t.set(large.taskId, "SET budgetUsd = :limit", { ":limit": 80 });
    await t.pauseAndEnd(large);
    const asked = t.requestOf(large.taskId)[0]!;
    expect(asked).toMatchObject({ amountUsd: 40, newLimitUsd: 120, approverRole: "org_admin", reason: "This task needs about $40 more to finish. I asked an admin to approve it." });
    expect([...asked.approverIds].sort()).toEqual([ADA.developerId, DEB.developerId].sort());
  });

  it("asks org admins when the project has no maintainer of its own, between the two thresholds", async () => {
    const t = await setup();
    t.db.delete(projectMemberKey(TEST_ORG, BEN.developerId, "payments"));
    const task = await t.plainTask();
    await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
    await t.pauseAndEnd(task);
    expect(t.requestOf(task.taskId)[0]).toMatchObject({ approverRole: "org_admin", reason: "This task needs about $7 more to finish. I asked an admin to approve it." });
  });

  it("a contributor deciding gets 403 and nothing changes", async () => {
    const t = await setup();
    const task = await t.plainTask();
    await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
    await t.pauseAndEnd(task);
    const id = t.requestOf(task.taskId)[0]!.spendRequestId;
    expect(await refusal(t.decide(CARL, id))).toMatchObject({ code: "FORBIDDEN" });
    // The task's owner pays, but a raise to $21 is above what the payer may approve alone.
    expect(await refusal(t.decide(MAYA, id))).toMatchObject({ code: "FORBIDDEN" });
    expect(t.requestOf(task.taskId)[0]).toMatchObject({ status: "PENDING" });
    expect(t.meta(task.taskId)).toMatchObject({ budgetUsd: 14 });
  });

  it("a maintainer approves: budgetUsd becomes 21, the pause clears, the task continues with the system's words, and deciding twice is APPROVAL_CLOSED", async () => {
    const t = await setup();
    const task = await t.plainTask();
    await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
    await t.pauseAndEnd(task);
    const id = t.requestOf(task.taskId)[0]!.spendRequestId;
    const before = t.taskOps(task.workspaceId).length;
    const decided = await t.decide(BEN, id);
    expect(decided.spendRequest).toMatchObject({ spendRequestId: id, status: "APPROVED", approvedAmountUsd: 7 });
    expect(t.requestOf(task.taskId)[0]).toMatchObject({ status: "APPROVED", decidedBy: BEN.developerId, approvedAmountUsd: 7 });
    expect(t.openItems()).toEqual([]);
    expect(t.meta(task.taskId).budgetUsd).toBe(21);
    expect(t.meta(task.taskId).budgetPause).toBeUndefined();
    const ops = t.taskOps(task.workspaceId);
    expect(ops).toHaveLength(before + 1);
    expect(JSON.stringify(t.outboxOf(ops.at(-1)!.id)?.invocation)).toContain(SPEND_RESUME_INSTRUCTIONS);
    expect(await refusal(t.decide(BEN, id))).toMatchObject({ code: "APPROVAL_CLOSED" });
    expect(t.taskOps(task.workspaceId)).toHaveLength(before + 1);
  });

  it("a repeat of the same decision request answers what the first did and writes nothing", async () => {
    const t = await setup();
    const task = await t.plainTask();
    await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
    await t.pauseAndEnd(task);
    const id = t.requestOf(task.taskId)[0]!.spendRequestId;
    const requestId = randomUUID();
    const first = await decideSpendRequest(t.deps(), t.caller(BEN), id, { requestId, decision: "APPROVE" });
    const writes = t.db.commandNames().length;
    const again = await decideSpendRequest(t.deps(), t.caller(BEN), id, { requestId, decision: "APPROVE" });
    expect(again).toEqual(first);
    expect(t.db.commandNames().slice(writes)).not.toContain("TransactWriteCommand");
    expect(await refusal(decideSpendRequest(t.deps(), t.caller(BEN), id, { requestId, decision: "DENY" }))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("a second pause of the same task asks for nothing new", async () => {
    const t = await setup();
    const task = await t.plainTask();
    await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
    await t.pauseAndEnd(task);
    const first = t.requestOf(task.taskId)[0]!;
    const again = await createSpendRequest(t.deps(), {
      orgId: TEST_ORG, kind: "run_limit", scope: { kind: "task", taskId: task.taskId }, taskId: task.taskId, amountUsd: 7, newLimitUsd: 21,
      reason: first.reason, requestedBy: { kind: "system" }, resume: "continue",
    });
    expect(again).toMatchObject({ created: false, record: { spendRequestId: first.spendRequestId } });
    expect(t.requestOf(task.taskId)).toHaveLength(1);
  });

  it("denying leaves the task paused and the limit as it was", async () => {
    const t = await setup();
    const task = await t.plainTask();
    await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
    await t.pauseAndEnd(task);
    const id = t.requestOf(task.taskId)[0]!.spendRequestId;
    const ops = t.taskOps(task.workspaceId).length;
    await t.decide(BEN, id, "DENY");
    expect(t.requestOf(task.taskId)[0]).toMatchObject({ status: "DENIED", decidedBy: BEN.developerId });
    expect(t.meta(task.taskId)).toMatchObject({ budgetUsd: 14, budgetPause: { scope: { kind: "task" } } });
    expect(t.taskOps(task.workspaceId)).toHaveLength(ops);
  });

  it("an approver may approve a different amount: the approvers are read again for it", async () => {
    const t = await setup();
    const task = await t.plainTask();
    await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
    await t.pauseAndEnd(task);
    const id = t.requestOf(task.taskId)[0]!.spendRequestId;
    // $14 + $100 is above the admin threshold: the maintainer can't approve that much.
    expect(await refusal(t.decide(BEN, id, "APPROVE", { amountUsd: 100 }))).toMatchObject({ code: "FORBIDDEN" });
    await t.decide(DEB, id, "APPROVE", { amountUsd: 100 });
    expect(t.meta(task.taskId).budgetUsd).toBe(114);
  });

  it("derives the pause from the end when none was written (the pause write failed): a run limit used up asks for a run limit", async () => {
    const t = await setup();
    const task = await t.plainTask();
    await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
    // The task's one key has spent its whole limit; nothing wrote a pause.
    const asked = await call(t.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": (t.outboxOf(task.operationId)!.invocation as { callbackCapability: string }).callbackCapability } });
    expect(asked.status).toBe(200);
    t.access.setKeySpent(t.access.mintedKeys()[0]!, 14);
    await t.pauseAndEnd(task, "none");
    expect(t.meta(task.taskId).budgetPause).toMatchObject({ scope: { kind: "task", taskId: task.taskId } });
    expect(t.requestOf(task.taskId)[0]).toMatchObject({ kind: "run_limit", amountUsd: 7, newLimitUsd: 21 });
  });

  it("asks for nothing when a month's budget ran out (Task 33's top-ups raise those)", async () => {
    const t = await setup();
    const task = await t.plainTask();
    await t.pauseAndEnd(task, { kind: "member", developerId: MAYA.developerId });
    expect(t.requestOf(task.taskId)).toEqual([]);
    expect((await t.view(MAYA, task.taskId)).paused).toMatchObject({ reason: "budget", scope: { kind: "member" } });
  });

  it("does not close or release a paused task's workspace", async () => {
    const t = await setup();
    const task = await t.plainTask();
    await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
    await t.pauseAndEnd(task);
    expect(t.operations(task.workspaceId).some((operation) => operation.kind === "close")).toBe(false);
    expect(t.meta(task.taskId).releasedAt).toBeUndefined();
    expect((t.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { status: string }).status).toBe("READY");
  });

  it("a request of another org is not found, the same as a missing one", async () => {
    const t = await setup();
    const task = await t.plainTask();
    await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
    await t.pauseAndEnd(task);
    const record = t.requestOf(task.taskId)[0]!;
    // Read from another org, the id is not found; a record of that org with the same id would be that org's own.
    expect(await getSpendRequest(t.deps(), ORG_B, record.spendRequestId)).toBeUndefined();
    const stranger = t.caller(BEN, "member", ORG_B);
    expect(await refusal(decideSpendRequest(t.deps(), stranger, record.spendRequestId, { requestId: randomUUID(), decision: "APPROVE" }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await refusal(t.decide(BEN, "spr_zzzzzzzzzzzzzzzzzzzz"))).toMatchObject({ code: "NOT_FOUND" });
    expect((await refusal(t.decide(BEN, "spr_zzzzzzzzzzzzzzzzzzzz")))!.message).not.toContain("spr_zzzz");
  });

  it("a run started with a run limit of 0 asks for its run limit, and approving it charges the workspace and makes the first dispatch", async () => {
    const t = await setup();
    const started = await startAgentRun(t.starter(), {
      requestId: randomUUID(), orgId: TEST_ORG, project: "payments", agent: { agentId: "rovara-code" }, input: { text: "Fix the retry bug" }, origin: "app",
      owner: { developerId: MAYA.developerId }, startedBy: { developerId: MAYA.developerId }, payer: { kind: "member", developerId: MAYA.developerId }, runLimitUsd: 0,
    });
    expect(started).toMatchObject({ paused: true });
    const [request] = t.requestOf(started.taskId);
    expect(request).toMatchObject({ kind: "run_limit", amountUsd: 5, newLimitUsd: 5, approverRole: "payer", approverIds: [MAYA.developerId] });
    const { workspaceId } = t.meta(started.taskId);
    const prepare = t.operations(workspaceId).find((operation) => operation.kind === "prepare")!;
    expect(t.outboxOf(prepare.id)).toBeUndefined();
    // The member's workspace counter lists the tasks holding a slot.
    // Both forms (S2): a marker beside the member counter, or the counter's old `tasks` set.
    const charged = () => t.db.find((item) => (item.tasks instanceof Set && (item.tasks as Set<string>).has(started.taskId)) || (item.entityType === "DEVELOPER_LIMIT_TASK" && item.taskId === started.taskId)).length;
    expect(charged()).toBe(0);
    // The payer is the person who asked for the run: they may raise their own run's limit.
    await t.decide(MAYA, request!.spendRequestId);
    expect(t.meta(started.taskId)).toMatchObject({ budgetUsd: 5 });
    expect(t.meta(started.taskId).budgetPause).toBeUndefined();
    expect(t.outboxOf(prepare.id)).toBeDefined();
    expect(t.db.find((item) => item.entityType === "SETUP_WATCH" && item.operationId === prepare.id)).toHaveLength(1);
    expect(charged()).toBe(1);
  });

  it("the human Continue clears a stale mid-run pause", async () => {
    const t = await setup();
    const task = await t.plainTask();
    await t.pauseAndEnd(task);
    const continued = await t.api(MAYA, "POST", `/v1/dev/tasks/${task.taskId}/continue`, { instructions: "Go on" });
    expect(continued.status, JSON.stringify(continued.body)).toBe(200);
    expect(t.meta(task.taskId).budgetPause).toBeUndefined();
  });
});

describe("an agent-step run's pause", () => {
  it("asks for its run limit, and the approval resumes the same step", async () => {
    const t = await setup();
    const agentId = await t.agentOf(TRIAGE);
    const run = await t.runOf(agentId);
    await t.set(run.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
    await t.pauseAndEnd(run);
    expect(t.db.get(`DEVTASK#${run.taskId}`, "AGENT_RUN")).toMatchObject({ state: "PAUSED_BUDGET" });
    const [request] = t.requestOf(run.taskId);
    expect(request).toMatchObject({ kind: "run_limit", amountUsd: 7, newLimitUsd: 21, approverRole: "project_maintainer" });
    expect(t.taskOps(run.workspaceId)).toHaveLength(1);
    await t.decide(BEN, request!.spendRequestId);
    const ops = t.taskOps(run.workspaceId);
    expect(ops).toHaveLength(2);
    expect(ops[1]).toMatchObject({ programStepId: "investigate" });
    expect(t.db.get(`DEVTASK#${run.taskId}`, "AGENT_RUN")).toMatchObject({ state: "RUNNING" });
    expect(t.meta(run.taskId)).toMatchObject({ budgetUsd: 21 });
  });
});

describe("a max-per-run pause", () => {
  /**
   * A run of an agent of Maya's whose max per run is `max`, with the run's limit `limit`, paused at its max per run. Ben starts the run: the run's own
   * starter may not raise its stop (fix round 1, I-4), so the owner deciding is someone else's run.
   */
  async function maxPaused(t: World, max: number, limit: number) {
    const agentId = await t.agentOf(TRIAGE, { name: "Ticket looker" });
    expect((await t.setBudget(MAYA, agentId, { maxPerRunUsd: max })).status).toBe(200);
    await t.shareWith(agentId, BEN);
    const run = await t.runOf(agentId, { who: BEN });
    await t.set(run.taskId, "SET budgetUsd = :limit", { ":limit": limit });
    expect(t.meta(run.taskId).maxPerRunUsd).toBe(max);
    await t.pauseAndEnd(run, { kind: "max_per_run", taskId: run.taskId });
    return { agentId, ...run, request: t.requestOf(run.taskId, "max_per_run")[0]! };
  }

  it("routes to the agent's owner, and approval raises only this run's stop, never the agent's setting", async () => {
    const t = await setup();
    const { agentId, taskId, request } = await maxPaused(t, 4, 25);
    expect(request).toMatchObject({
      kind: "max_per_run", amountUsd: 5, newLimitUsd: 9, approverRole: "agent_owner", approverIds: [MAYA.developerId],
      reason: "This run reached Ticket looker's max per run ($4). I asked the agent's owner to approve $5 more for this run.",
    });
    expect(await refusal(t.decide(BEN, request.spendRequestId))).toMatchObject({ code: "FORBIDDEN" });
    await t.decide(MAYA, request.spendRequestId);
    expect(t.meta(taskId)).toMatchObject({ maxPerRunUsd: 9, budgetUsd: 25 });
    expect(t.meta(taskId).budgetPause).toBeUndefined();
    expect(t.agentItem(agentId)!.maxPerRunUsd).toBe(4);
    expect(t.requestOf(taskId, "run_limit")).toEqual([]);
  });

  it("a raise past the run limit says so in the exact words and adds a run_limit request", async () => {
    const t = await setup();
    const { taskId, request } = await maxPaused(t, 4, 8);
    await t.decide(MAYA, request.spendRequestId);
    expect(t.meta(taskId)).toMatchObject({ maxPerRunUsd: 9, budgetUsd: 8 });
    expect(t.taskEvents(taskId)).toContain("That is more than this run's $8 run limit, so I also asked a project maintainer to raise it.");
    expect(t.requestOf(taskId, "run_limit")[0]).toMatchObject({ status: "PENDING", amountUsd: 5, newLimitUsd: 13, approverRole: "project_maintainer" });
  });

  it("goes to org admins when the raised stop would pass the company's ceiling", async () => {
    const t = await setup();
    const { request } = await maxPaused(t, 98, 500);
    expect(request).toMatchObject({ amountUsd: 49, newLimitUsd: 147, approverRole: "org_admin", reason: "This run reached Ticket looker's max per run ($98). I asked an admin to approve $49 more for this run." });
    expect(await refusal(t.decide(MAYA, request.spendRequestId))).toMatchObject({ code: "FORBIDDEN" });
  });

  it("adds org owners and admins when the owner has not answered for 24 hours", async () => {
    const t = await setup();
    const { request } = await maxPaused(t, 4, 25);
    const soon = Date.now() + (OWNER_ANSWER_HOURS - 1) * 3_600_000;
    expect(await escalateOwnerRequests(t.deps(() => soon), { budgetMs: 5_000 })).toMatchObject({ escalated: 0 });
    expect(await refusal(decideSpendRequest(t.deps(() => soon), t.caller(DEB, "admin"), request.spendRequestId, { requestId: randomUUID(), decision: "APPROVE" }))).toMatchObject({ code: "FORBIDDEN" });
    const later = Date.now() + OWNER_ANSWER_HOURS * 3_600_000 + 60_000;
    expect(await escalateOwnerRequests(t.deps(() => later), { budgetMs: 5_000 })).toMatchObject({ escalated: 1 });
    const escalated = t.requests().find((record) => record.spendRequestId === request.spendRequestId)!;
    expect(escalated.escalatedAt).toBeDefined();
    expect([...escalated.approverIds].sort()).toEqual([ADA.developerId, DEB.developerId, MAYA.developerId].sort());
    // Once is enough.
    expect(await escalateOwnerRequests(t.deps(() => later + 60_000), { budgetMs: 5_000 })).toMatchObject({ escalated: 0 });
    await decideSpendRequest(t.deps(() => later), t.caller(DEB, "admin"), request.spendRequestId, { requestId: randomUUID(), decision: "APPROVE" });
    expect(t.requests().find((record) => record.spendRequestId === request.spendRequestId)).toMatchObject({ status: "APPROVED", decidedBy: DEB.developerId });
  });

  it("expires a request nobody decided within its time, and the task stays paused", async () => {
    const t = await setup();
    const { taskId, request } = await maxPaused(t, 4, 25);
    const after = Date.parse(request.expiresAt) + 1;
    expect(await escalateOwnerRequests(t.deps(() => after), { budgetMs: 5_000 })).toMatchObject({ expired: 1 });
    expect(t.requests().find((record) => record.spendRequestId === request.spendRequestId)).toMatchObject({ status: "EXPIRED" });
    expect(t.openItems()).toEqual([]);
    expect(t.meta(taskId).budgetPause).toBeDefined();
    expect(await refusal(t.decide(MAYA, request.spendRequestId))).toMatchObject({ code: "APPROVAL_CLOSED" });
  });

  it("a project's agent is decided by its owning project's maintainers", async () => {
    const t = await setup();
    const agentId = await t.agentOf(TRIAGE, { by: BEN, name: "Shared looker", owner: { kind: "project", project: "payments" }, accountable: BEN });
    expect((await t.setBudget(BEN, agentId, { maxPerRunUsd: 4 })).status).toBe(200);
    const run = await t.runOf(agentId);
    await t.pauseAndEnd(run, { kind: "max_per_run", taskId: run.taskId });
    const request = t.requestOf(run.taskId, "max_per_run")[0]!;
    expect(request).toMatchObject({ approverRole: "agent_owner", approverIds: [BEN.developerId] });
    expect(await refusal(t.decide(CARL, request.spendRequestId))).toMatchObject({ code: "FORBIDDEN" });
    await t.decide(BEN, request.spendRequestId);
  });

  it("a project process layer's task is routed like the built-in Rovara Code's: org owners and admins decide, never the owning project's maintainers (I1)", async () => {
    const t = await setup();
    const agentId = await t.agentOf(TRIAGE, { by: BEN, name: "Process layer", owner: { kind: "project", project: "payments" }, accountable: BEN });
    const run = await t.runOf(agentId);
    // The task record of a process layer carries the mark (`TaskAgentRef.process`); the layer is owned by the project, so its maintainers (Ben) would otherwise be asked.
    await t.set(run.taskId, "SET #agent = :agent, maxPerRunUsd = :max", { ":agent": { ...(t.meta(run.taskId).agent as Record<string, unknown>), process: true }, ":max": 4 }, { "#agent": "agent" });
    await t.pauseAndEnd(run, { kind: "max_per_run", taskId: run.taskId });
    const request = t.requestOf(run.taskId, "max_per_run")[0]!;
    expect(request).toMatchObject({ approverRole: "org_admin" });
    expect(request.approverIds).not.toContain(BEN.developerId);
    expect(request.approverIds).toContain(DEB.developerId);
    expect((await spendApprovers(t.deps(), request)).ids).toEqual(request.approverIds);
    expect(await refusal(t.decide(BEN, request.spendRequestId))).toMatchObject({ code: "FORBIDDEN" });
    expect(t.meta(run.taskId).budgetPause).toBeDefined();
    await t.decide(DEB, request.spendRequestId);
    expect(t.meta(run.taskId).budgetPause).toBeUndefined();
  });

  it("the built-in Rovara Code's max-per-run request still goes to org owners and admins (unchanged)", async () => {
    const t = await setup();
    const agentId = await t.agentOf(TRIAGE, { by: BEN, name: "Stand-in", owner: { kind: "project", project: "payments" }, accountable: BEN });
    const run = await t.runOf(agentId);
    await t.set(run.taskId, "SET #agent = :agent, maxPerRunUsd = :max", { ":agent": { agentId: ROVARA_CODE_AGENT_ID, name: "Rovara Code", version: 1, builtin: true }, ":max": 4 }, { "#agent": "agent" });
    await t.pauseAndEnd(run, { kind: "max_per_run", taskId: run.taskId });
    const request = t.requestOf(run.taskId, "max_per_run")[0]!;
    expect(request).toMatchObject({ approverRole: "org_admin" });
    expect(request.approverIds).not.toContain(BEN.developerId);
    expect(await refusal(t.decide(BEN, request.spendRequestId))).toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("a planning pause", () => {
  it("shows what planning found so far, and the approval resumes PLAN with a reset window", async () => {
    const t = await setup();
    const agentId = await t.agentOf(CODING, { name: "Coder" });
    const run = await t.runOf(agentId);
    await t.set(run.taskId, "SET budgetUsd = :limit", { ":limit": 6 });
    const plan = t.taskOps(run.workspaceId).at(-1)!;
    expect(plan.workflowMode).toBe("PLAN");
    const found = "The retry loop never backs off. ".repeat(200);
    await t.events(run.workspaceId, plan.id, [{ type: "progress", payload: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: found }] } } }]);
    await t.pauseAndEnd(run, { kind: "planning", taskId: run.taskId });
    expect(t.meta(run.taskId).workflow).toMatchObject({ stage: "PLAN", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.budgetPaused });
    const request = t.requestOf(run.taskId, "planning")[0]!;
    expect(request).toMatchObject({ kind: "planning", amountUsd: 5, resume: "plan", reason: "Planning reached its $6 limit. Here's what it found so far. Approve $5 more to finish the plan." });
    const shown = await t.view(MAYA, run.taskId);
    expect(shown.planningSoFar).toBe(found.trim().slice(0, 4096));
    expect(shown.workflow?.blockReason).toBe("Paused: this task needs more AI budget. I've asked for it.");
    await t.decide(MAYA, request.spendRequestId);
    const after = t.meta(run.taskId);
    expect(after.budgetPause).toBeUndefined();
    expect(after.budgetBaselineUsd).toBeDefined();
    expect(after.workflow).toMatchObject({ stage: "PLAN", state: "RUNNING" });
    expect(t.taskOps(run.workspaceId).at(-1)).toMatchObject({ workflowMode: "PLAN" });
    expect(t.taskOps(run.workspaceId).at(-1)!.id).not.toBe(plan.id);
  });
});

describe("a test run that reached its cap", () => {
  it("offers to continue as a normal task and asks for nothing; continue-as-task moves later spend to the owner's month while earlier spend stays on the testing allowance", async () => {
    const t = await setup();
    const agentId = await t.agentOf(TRIAGE, { publish: false });
    const run = await t.runOf(agentId, { version: "draft" });
    expect(t.meta(run.taskId)).toMatchObject({ origin: "test_run" });
    const step = t.taskOps(run.workspaceId).at(-1)!;
    const ask = (operationId: string) => call(t.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": (t.outboxOf(operationId)!.invocation as { callbackCapability: string }).callbackCapability } });
    expect((await ask(step.id)).status).toBe(200);
    t.access.setKeySpent(t.access.mintedKeys()[0]!, 2);
    await t.pauseAndEnd(run, { kind: "test", taskId: run.taskId });
    expect(t.requestOf(run.taskId)).toEqual([]);
    const shown = await t.view(MAYA, run.taskId);
    expect(shown.testOffer).toEqual({ capUsd: 2 });
    expect(shown.paused).toMatchObject({ reason: "budget", scope: { kind: "test", taskId: run.taskId } });
    expect(t.taskEvents(run.taskId)).toContain("This test reached its $2 cap. Continue it as a normal task? It will then count against your monthly limit and payments's budget.");
    // Only the task's owner may.
    expect((await t.api(BEN, "POST", `/v1/app/tasks/${run.taskId}/continue-as-task`, {})).status).toBe(404);
    const continued = await t.api(MAYA, "POST", `/v1/app/tasks/${run.taskId}/continue-as-task`, {});
    expect(continued.status, JSON.stringify(continued.body)).toBe(200);
    expect(t.meta(run.taskId)).toMatchObject({ origin: "app", payer: { kind: "member", developerId: MAYA.developerId } });
    expect(t.meta(run.taskId).budgetPause).toBeUndefined();
    const next = t.taskOps(run.workspaceId).at(-1)!;
    expect(next.id).not.toBe(step.id);
    expect(next.programStepId).toBe("investigate");
    expect((await ask(next.id)).status).toBe(200);
    const minted = t.access.mintKey.mock.calls.at(-1)![0];
    expect(minted.tags).toMatchObject({ origin: "app", payerKind: "member" });
    expect(t.db.get(spendCounterKey(TEST_ORG, month(), `MEMBER#${MAYA.developerId}`).pk, `MEMBER#${MAYA.developerId}`)).toMatchObject({ committedUsd: expect.any(Number) as number });
    const testing = t.db.get(spendCounterKey(TEST_ORG, month(), `TESTING#${MAYA.developerId}`).pk, `TESTING#${MAYA.developerId}`) as { committedUsd: number };
    expect(testing.committedUsd).toBeGreaterThanOrEqual(2);
  });

  it("refuses continue-as-task for a task that is not a paused test run", async () => {
    const t = await setup();
    const task = await t.plainTask();
    expect((await t.api(MAYA, "POST", `/v1/app/tasks/${task.taskId}/continue-as-task`, {})).body).toMatchObject({ error: { code: "CONFIG_INVALID" } });
  });
});

describe("an owner's cap on agent budgets", () => {
  const MESSAGE = "Maya Chen's agent budgets would total $101 a month, over the $100 limit for one person. I asked an org admin to approve it.";

  it("with agents at $50 and $50, a third at $1 answers 202 with the exact message, asks org admins and changes nothing; the same call again returns that request", async () => {
    const t = await setup();
    await t.budgeted(50);
    await t.budgeted(50);
    const third = await t.agentOf();
    const reply = await t.setBudget(MAYA, third, { monthlyUsd: 1 });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    expect(reply.body).toMatchObject({ status: "NEEDS_ADMIN_APPROVAL", message: MESSAGE, spendRequestId: expect.stringMatching(/^spr_[0-9a-z]{20}$/) as string });
    const [request] = t.requests();
    expect(request).toMatchObject({
      kind: "owner_cap", scope: { kind: "agent", agentId: third }, agentId: third, newLimitUsd: 1, amountUsd: 1, approverRole: "org_admin",
      reason: "Maya Chen's agent budgets would total $101 a month, over the $100 limit for one person.", requestedBy: { kind: "member", developerId: MAYA.developerId },
    });
    expect([...request!.approverIds].sort()).toEqual([ADA.developerId, DEB.developerId].sort());
    expect(t.agentItem(third)!.monthlyBudgetUsd).toBeUndefined();
    expect(t.ownerTotal(MAYA)).toBe(100);
    const again = await t.setBudget(MAYA, third, { monthlyUsd: 1 });
    expect(again).toMatchObject({ status: 202, body: { spendRequestId: request!.spendRequestId } });
    expect(t.requests()).toHaveLength(1);
  });

  it("a repeat of the asking request with the same request id answers the same 202 and writes nothing (R18)", async () => {
    const t = await setup();
    await t.budgeted(50);
    await t.budgeted(50);
    const third = await t.agentOf();
    const requestId = randomUUID();
    const first = await t.dev(MAYA, "PUT", `/v1/app/agents/${third}/budget`, { requestId, monthlyUsd: 1 });
    expect(first.status).toBe(202);
    const writes = t.db.commandNames().length;
    const again = await t.dev(MAYA, "PUT", `/v1/app/agents/${third}/budget`, { requestId, monthlyUsd: 1 });
    expect(again.status).toBe(202);
    expect({ ...again.body, requestId: undefined }).toEqual({ ...first.body, requestId: undefined });
    expect(t.db.commandNames().slice(writes)).not.toContain("TransactWriteCommand");
    expect((await t.dev(MAYA, "PUT", `/v1/app/agents/${third}/budget`, { requestId, monthlyUsd: 2 })).body).toMatchObject({ error: { code: "CONFIG_INVALID" } });
  });

  it("a contributor and the owner (not an admin) get 403; an admin approves, the budget applies, the total reads $101 and one budget_changed names the admin", async () => {
    const t = await setup();
    await t.budgeted(50);
    await t.budgeted(50);
    const third = await t.agentOf();
    const id = (await t.setBudget(MAYA, third, { monthlyUsd: 1 })).body.spendRequestId as string;
    expect(await refusal(t.decide(CARL, id))).toMatchObject({ code: "FORBIDDEN" });
    expect(await refusal(t.decide(MAYA, id))).toMatchObject({ code: "FORBIDDEN" });
    await t.decide(DEB, id);
    expect(t.agentItem(third)!.monthlyBudgetUsd).toBe(1);
    expect(t.ownerTotal(MAYA)).toBe(101);
    const events = t.agentEvents(third, "budget_changed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ by: DEB.developerId, overrideCap: id });
  });

  it("a denied or an expired request leaves the budget as it was", async () => {
    const t = await setup();
    await t.budgeted(50);
    await t.budgeted(50);
    const third = await t.agentOf();
    const denied = (await t.setBudget(MAYA, third, { monthlyUsd: 1 })).body.spendRequestId as string;
    await t.decide(DEB, denied, "DENY");
    expect(t.agentItem(third)!.monthlyBudgetUsd).toBeUndefined();
    expect(t.ownerTotal(MAYA)).toBe(100);
    const fourth = await t.agentOf();
    const expiring = (await t.setBudget(MAYA, fourth, { monthlyUsd: 2 })).body.spendRequestId as string;
    const record = t.requests().find((entry) => entry.spendRequestId === expiring)!;
    await escalateOwnerRequests(t.deps(() => Date.parse(record.expiresAt) + 1), { budgetMs: 5_000 });
    expect(t.requests().find((entry) => entry.spendRequestId === expiring)).toMatchObject({ status: "EXPIRED" });
    expect(t.agentItem(fourth)!.monthlyBudgetUsd).toBeUndefined();
    expect(t.ownerTotal(MAYA)).toBe(100);
  });

  it("an admin who owns the agents can't decide their own request while a second admin exists, and can when they are the only one", async () => {
    for (const secondAdmin of [true, false]) {
      const t = await setup({ secondAdmin });
      await t.budgeted(50, ADA);
      await t.budgeted(50, ADA);
      const third = await t.agentOf(TRIAGE, { by: ADA });
      const reply = await t.setBudget(ADA, third, { monthlyUsd: 1 });
      expect(reply.status).toBe(202);
      const id = reply.body.spendRequestId as string;
      if (secondAdmin) {
        expect(await refusal(t.decide(ADA, id))).toMatchObject({ code: "FORBIDDEN" });
        await t.decide(DEB, id);
      } else {
        await t.decide(ADA, id);
      }
      expect(t.ownerTotal(ADA)).toBe(101);
    }
  });

  it("the trial default cap is the member analogue, $29", async () => {
    const t = await setup({ plan: "trial" });
    expect(TRIAL_LIMITS_R49.ownerAgentBudgetCapUsd).toBe(29);
    await t.budgeted(20);
    const second = await t.agentOf();
    const reply = await t.setBudget(MAYA, second, { monthlyUsd: 10 });
    expect(reply.status).toBe(202);
    expect(reply.body.message).toBe("Maya Chen's agent budgets would total $30 a month, over the $29 limit for one person. I asked an org admin to approve it.");
  });

  describe("change of owner", () => {
    it("a transfer to someone with room moves the agent and both totals at once", async () => {
      const t = await setup();
      const agentId = await t.budgeted(30);
      const moved = await t.api(ADA, "PUT", `/v1/app/agents/${agentId}/owner`, { owner: { kind: "member", developerId: OMAR.developerId } });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      expect(t.ownerTotal(MAYA)).toBe(0);
      expect(t.ownerTotal(OMAR)).toBe(30);
    });

    it("a transfer that takes the new owner past the cap answers 202 and leaves the old owner until an admin approves, then both totals move", async () => {
      const t = await setup();
      await t.budgeted(50, OMAR);
      await t.budgeted(40, OMAR);
      const agentId = await t.budgeted(30);
      const moved = await t.api(ADA, "PUT", `/v1/app/agents/${agentId}/owner`, { owner: { kind: "member", developerId: OMAR.developerId } });
      expect(moved.status, JSON.stringify(moved.body)).toBe(202);
      expect(moved.body).toMatchObject({ status: "NEEDS_ADMIN_APPROVAL", message: "Omar Diaz's agent budgets would total $120 a month, over the $100 limit for one person. I asked an org admin to approve it." });
      expect(t.agentItem(agentId)!.owner).toEqual({ kind: "member", developerId: MAYA.developerId });
      const request = t.requests()[0]!;
      expect(request).toMatchObject({ kind: "owner_cap", newOwner: { developerId: OMAR.developerId }, amountUsd: 20 });
      // Ada asked; Deb, the other admin, decides.
      expect(await refusal(t.decide(ADA, request.spendRequestId))).toMatchObject({ code: "FORBIDDEN" });
      await t.decide(DEB, request.spendRequestId);
      expect(t.agentItem(agentId)!.owner).toEqual({ kind: "member", developerId: OMAR.developerId });
      expect(t.ownerTotal(MAYA)).toBe(0);
      expect(t.ownerTotal(OMAR)).toBe(120);
      expect(t.agentEvents(agentId, "owner_changed").at(-1)).toMatchObject({ by: DEB.developerId, overrideCap: request.spendRequestId });
    });

    it("a member-removal move counts at once and, when it leaves the new owner over the cap, opens an owner_cap request asking an admin to confirm", async () => {
      const t = await setup();
      await t.budgeted(50, ADA);
      await t.budgeted(40, ADA);
      await t.budgeted(30, OMAR);
      await onMemberRemoved(t.deps(), { orgId: TEST_ORG, developerId: OMAR.developerId, by: ADA.developerId });
      expect(t.ownerTotal(ADA)).toBe(120);
      const [request] = t.requests();
      expect(request).toMatchObject({ kind: "owner_cap", approverRole: "org_admin", requestedBy: { kind: "system" }, change: { op: "confirm_move", owner: ADA.developerId, cause: "member_removed" } });
      expect(request!.reason).toBe("Ada Owner's agent budgets would total $120 a month, over the $100 limit for one person.");
      // A repeat of the removal's moves asks once.
      await onMemberRemoved(t.deps(), { orgId: TEST_ORG, developerId: OMAR.developerId, by: ADA.developerId });
      expect(t.requests()).toHaveLength(1);
      await t.decide(DEB, request!.spendRequestId);
      expect(t.requests()[0]).toMatchObject({ status: "APPROVED" });
      expect(t.ownerTotal(ADA)).toBe(120);
    });
  });

  describe("unarchive and accountable (R2-4)", () => {
    it("an archived $30 agent raised to $60 while archived, whose owner has $50 elsewhere, answers 202 on unarchive and stays archived until an admin approves", async () => {
      const t = await setup();
      // The company lets one agent have up to $100 a month, so $60 is a budget the agent may be given.
      t.db.set({ ...agentGuardrailsKey(TEST_ORG), entityType: "AGENT_GUARDRAILS", revision: 1, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxAgentMonthlyUsd: 100 } });
      await t.budgeted(50);
      const agentId = await t.budgeted(30);
      expect((await t.api(MAYA, "POST", `/v1/app/agents/${agentId}/archive`, {})).status).toBe(200);
      expect((await t.setBudget(MAYA, agentId, { monthlyUsd: 60 })).status).toBe(200);
      expect(t.ownerTotal(MAYA)).toBe(50);
      const reply = await t.api(MAYA, "POST", `/v1/app/agents/${agentId}/unarchive`, {});
      expect(reply.status, JSON.stringify(reply.body)).toBe(202);
      expect(t.agentItem(agentId)!.status).toBe("archived");
      await t.decide(DEB, reply.body.spendRequestId as string);
      expect(t.agentItem(agentId)!.status).toBe("active");
      expect(t.ownerTotal(MAYA)).toBe(110);
    });

    it("unarchiving one that fits succeeds, and its total reads $80", async () => {
      const t = await setup();
      await t.budgeted(50);
      const agentId = await t.budgeted(30);
      await t.api(MAYA, "POST", `/v1/app/agents/${agentId}/archive`, {});
      const reply = await t.api(MAYA, "POST", `/v1/app/agents/${agentId}/unarchive`, {});
      expect(reply.status).toBe(200);
      expect(t.ownerTotal(MAYA)).toBe(80);
    });

    it("moving a project's $40 agent to a maintainer with $70 elsewhere answers 202 and keeps the old accountable until an admin approves; a change that fits moves both totals at once", async () => {
      const t = await setup();
      t.grantRole(CARL, "maintainer");
      await t.budgeted(50, BEN);
      await t.budgeted(20, BEN);
      const agentId = await t.agentOf(TRIAGE, { by: CARL, owner: { kind: "project", project: "payments" }, accountable: CARL });
      expect((await t.setBudget(CARL, agentId, { monthlyUsd: 40 })).status).toBe(200);
      expect(t.ownerTotal(CARL)).toBe(40);
      const reply = await t.api(CARL, "PUT", `/v1/app/agents/${agentId}/accountable`, { accountable: { developerId: BEN.developerId } });
      expect(reply.status, JSON.stringify(reply.body)).toBe(202);
      expect(t.agentItem(agentId)!.accountable).toEqual({ developerId: CARL.developerId });
      await t.decide(DEB, reply.body.spendRequestId as string);
      expect(t.agentItem(agentId)!.accountable).toEqual({ developerId: BEN.developerId });
      expect(t.ownerTotal(CARL)).toBe(0);
      expect(t.ownerTotal(BEN)).toBe(110);
      const back = await t.api(CARL, "PUT", `/v1/app/agents/${agentId}/accountable`, { accountable: { developerId: CARL.developerId } });
      expect(back.status).toBe(200);
      expect(t.ownerTotal(CARL)).toBe(40);
      expect(t.ownerTotal(BEN)).toBe(70);
    });
  });
});

describe("a merged member", () => {
  it("before any sweep, the survivor of a merge decides a spend request addressed to the duplicate", async () => {
    const t = await setup();
    const DUP = person("6", "Old Kit");
    const SURVIVOR = person("7", "Kit");
    for (const who of [DUP, SURVIVOR]) {
      t.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    }
    t.db.set({ ...t.db.get(`DEVELOPER#${DUP.developerId}`, "META")!, mergedInto: SURVIVOR.developerId });
    const task = await t.plainTask();
    await t.set(task.taskId, "SET budgetUsd = :limit, payer = :payer", { ":limit": 4, ":payer": { kind: "member", developerId: DUP.developerId } });
    await t.pauseAndEnd(task);
    const request = t.requestOf(task.taskId)[0]!;
    expect(request).toMatchObject({ approverRole: "payer", approverIds: [DUP.developerId] });
    await decideSpendRequest(t.deps(), t.caller(SURVIVOR), request.spendRequestId, { requestId: randomUUID(), decision: "APPROVE" });
    expect(t.meta(task.taskId).budgetUsd).toBe(9);
  });

  it("the merge's mover hands the duplicate's open requests to the survivor, and a removal's to the successor, audited as the system's", async () => {
    const t = await setup();
    t.grantRole(OMAR, "contributor");
    const task = await t.plainTask(OMAR);
    await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 4 });
    await t.pauseAndEnd(task);
    const request = t.requestOf(task.taskId)[0]!;
    expect(request.approverIds).toEqual([OMAR.developerId]);
    await onMembersMerged(t.deps(), { orgId: TEST_ORG, survivorId: CARL.developerId, duplicateId: OMAR.developerId });
    expect(t.requests()[0]!.approverIds).toEqual([CARL.developerId]);
    await onMemberRemoved(t.deps(), { orgId: TEST_ORG, developerId: CARL.developerId, by: ADA.developerId });
    expect(t.requests()[0]!.approverIds).toEqual([ADA.developerId]);
    expect(t.requests()[0]).toMatchObject({ movedBy: "system" });
  });

  // Member removal (v1.1), rule 5: the leaver's own requests stay theirs, and only the approvers move.
  it("a removal keeps requestedBy as the leaver and moves only who may decide (so the successor is never the asker)", async () => {
    const t = await setup();
    t.grantRole(OMAR, "contributor");
    const task = await t.plainTask(OMAR);
    await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 4 });
    await t.pauseAndEnd(task);
    const request = t.requests()[0]!;
    // The leaver both asked and was named to decide.
    t.db.set({ ...request, requestedBy: { kind: "member", developerId: CARL.developerId }, approverIds: [CARL.developerId] });
    await onMemberRemoved(t.deps(), { orgId: TEST_ORG, developerId: CARL.developerId, by: ADA.developerId });
    // Who may decide is read live (the task's owner and the owners), so the list is those people; the leaver is not among them, and is still the asker.
    const after = t.requests()[0]!;
    expect(after).toMatchObject({ requestedBy: { kind: "member", developerId: CARL.developerId }, status: "PENDING", movedBy: "system" });
    expect(after.approverIds).not.toContain(CARL.developerId);
    expect(after.approverIds.length).toBeGreaterThan(0);
  });

  it("a removal leaves a request the leaver asked for alone when it names someone else to decide it", async () => {
    const t = await setup();
    t.grantRole(OMAR, "contributor");
    const task = await t.plainTask(OMAR);
    await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 4 });
    await t.pauseAndEnd(task);
    const request = t.requests()[0]!;
    t.db.set({ ...request, requestedBy: { kind: "member", developerId: CARL.developerId }, approverIds: [BEN.developerId] });
    await onMemberRemoved(t.deps(), { orgId: TEST_ORG, developerId: CARL.developerId, by: ADA.developerId });
    const after = t.requests()[0]!;
    expect(after).toMatchObject({ requestedBy: { kind: "member", developerId: CARL.developerId }, approverIds: [BEN.developerId], status: "PENDING" });
    expect((after as unknown as Record<string, unknown>).movedBy).toBeUndefined();
  });

  it("a successor removed between the read and the write gets nothing: the move is refused and the next run reads the successor again", async () => {
    const t = await setup();
    t.grantRole(OMAR, "contributor");
    const task = await t.plainTask(OMAR);
    await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 4 });
    await t.pauseAndEnd(task);
    const request = t.requests()[0]!;
    t.db.set({ ...request, approverIds: [CARL.developerId] });
    // The successor ADA is removed just before the move's transaction commits.
    const realSend = t.db.send;
    let armed = true;
    t.db.send = async (command) => {
      if (armed && command.constructor.name === "TransactWriteCommand" && JSON.stringify((command as { input: unknown }).input).includes("moveRevision")) {
        armed = false;
        t.db.delete({ pk: `ORG#${TEST_ORG}`, sk: `MEMBER#${ADA.developerId}` });
      }
      return realSend(command);
    };
    await expect(onMemberRemoved(t.deps(), { orgId: TEST_ORG, developerId: CARL.developerId, by: DEB.developerId, successorId: ADA.developerId })).rejects.toBeDefined();
    expect(t.requests()[0]!.approverIds).toEqual([CARL.developerId]);
    // The next run finds ADA gone and reads the successor again: the person who removed Carl, who is a member.
    await onMemberRemoved(t.deps(), { orgId: TEST_ORG, developerId: CARL.developerId, by: DEB.developerId, successorId: ADA.developerId });
    const settled = t.requests()[0]!.approverIds;
    expect(settled.length).toBeGreaterThan(0);
    expect(settled).not.toContain(ADA.developerId);
    expect(settled).not.toContain(CARL.developerId);
  });
});

describe("the confirmation page and the routes", () => {
  it("a token's POST to the decide route gets REAUTH_REQUIRED with a ticketed confirmUrl and changes nothing; the page shows the payer, scope, amount and new limit and decides", async () => {
    const t = await setup({ decide: true });
    const task = await t.plainTask();
    await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
    await t.pauseAndEnd(task);
    const id = t.requestOf(task.taskId)[0]!.spendRequestId;
    const reply = await t.dev(BEN, "POST", `/v1/app/spend-requests/${id}/decide`, { requestId: randomUUID(), decision: "APPROVE" });
    expect(reply.status).toBe(401);
    const error = reply.body.error as { code: string; confirmUrl: string };
    expect(error.code).toBe("REAUTH_REQUIRED");
    expect(error.confirmUrl).toMatch(new RegExp(`^${CELL}/v1/app/approve/${id}\\?ticket=`));
    expect(t.requestOf(task.taskId)[0]).toMatchObject({ status: "PENDING" });
    const store = new DecideStore({ documentClient: t.db, tableName: "signin", now: Date.now });
    const cookie = `cookie-${randomUUID()}-${"x".repeat(20)}`;
    const signedInAt = Math.floor(Date.now() / 1000) - 30;
    await store.putSession(cookie, { orgId: TEST_ORG, developerId: BEN.developerId, approvalId: id, signedInAt, method: "email_code", csrfHash: sha(csrfTokenFor(cookie)), expiresAt: signedInAt + 600 });
    const raw = async (method: string, body?: string) => await t.handler({
      version: "2.0", rawPath: `/v1/app/approve/${id}`, rawQueryString: "",
      headers: { cookie: `${DECIDE_COOKIE}=${cookie}`, ...(method === "POST" ? { origin: CELL, "content-type": "application/x-www-form-urlencoded" } : {}) },
      ...(body === undefined ? {} : { body }), requestContext: { requestId: randomUUID(), http: { method } },
    });
    const shown = await raw("GET");
    expect(shown.statusCode, shown.body).toBe(200);
    for (const expected of ["Maya Chen", "$7", "$21", "payments"]) expect(shown.body, expected).toContain(expected);
    const decided = await raw("POST", new URLSearchParams({ decision: "approve", csrf: csrfTokenFor(cookie) }).toString());
    expect(decided.statusCode, decided.body).toBe(200);
    expect(t.requestOf(task.taskId)[0]).toMatchObject({ status: "APPROVED", decidedBy: BEN.developerId });
    expect(t.meta(task.taskId).budgetUsd).toBe(21);
  });

  it("the page's kind answers forbidden, decided and not found as the apr kind does", async () => {
    const t = await setup();
    const task = await t.plainTask();
    await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
    await t.pauseAndEnd(task);
    const id = t.requestOf(task.taskId)[0]!.spendRequestId;
    const kind = spendDecideKind(t.deps());
    expect(await kind.inspect({ orgId: TEST_ORG, developerId: CARL.developerId, approvalId: id })).toMatchObject({ status: "forbidden", who: "a maintainer of payments" });
    expect(await kind.inspect({ orgId: ORG_B, developerId: CARL.developerId, approvalId: id })).toEqual({ status: "not_found" });
    expect(await kind.inspect({ orgId: TEST_ORG, developerId: BEN.developerId, approvalId: id })).toMatchObject({ status: "open", view: { facts: expect.arrayContaining([{ label: "Amount", value: "$7" }, { label: "New limit", value: "$21" }]) as unknown } });
    await t.decide(BEN, id);
    expect(await kind.inspect({ orgId: TEST_ORG, developerId: BEN.developerId, approvalId: id })).toMatchObject({ status: "decided" });
  });

  it("GET shows a request to someone who may decide it or who asked, and 404 to anyone else", async () => {
    const t = await setup();
    const task = await t.plainTask();
    await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
    await t.pauseAndEnd(task);
    const id = t.requestOf(task.taskId)[0]!.spendRequestId;
    const shown = await t.api(BEN, "GET", `/v1/app/spend-requests/${id}`);
    expect(shown.status).toBe(200);
    expect(shown.body.spendRequest).toMatchObject({ spendRequestId: id, kind: "run_limit", amountUsd: 7, newLimitUsd: 21, status: "PENDING", confirmUrl: `${CELL}/v1/app/approve/${id}` });
    expect((await t.api(CARL, "GET", `/v1/app/spend-requests/${id}`)).status).toBe(404);
    const listed = await t.api(BEN, "GET", "/v1/app/spend-requests");
    expect((listed.body.spendRequests as Array<{ spendRequestId: string }>).map((entry) => entry.spendRequestId)).toEqual([id]);
    expect((await t.api(CARL, "GET", "/v1/app/spend-requests")).body.spendRequests).toEqual([]);
  });

  it("names its approvers live: an approver who lost the role can't decide, someone who gained it can", async () => {
    const t = await setup();
    const task = await t.plainTask();
    await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
    await t.pauseAndEnd(task);
    const request = t.requestOf(task.taskId)[0]!;
    t.grantRole(BEN, "contributor");
    t.grantRole(CARL, "maintainer");
    expect((await spendApprovers(t.deps(), request)).ids).toEqual([CARL.developerId]);
    expect(await refusal(t.decide(BEN, request.spendRequestId))).toMatchObject({ code: "FORBIDDEN" });
    await t.decide(CARL, request.spendRequestId);
  });
});

describe("the guards of a decision", () => {
  /** A $14 run-limit pause of Maya's task, asking Ben (a maintainer) for $7. */
  async function asked() {
    const t = await setup();
    const task = await t.plainTask();
    await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
    await t.pauseAndEnd(task);
    return { t, task, request: t.requestOf(task.taskId)[0]! };
  }

  it("refuses an approver who has left the org, even while their id is still on the list", async () => {
    const { t, request } = await asked();
    t.db.delete(orgMemberKey(TEST_ORG, BEN.developerId));
    expect(await refusal(t.decide(BEN, request.spendRequestId))).toMatchObject({ code: "FORBIDDEN" });
  });

  it("asks the org's owners and admins when the payer has left the org", async () => {
    const { t, task } = await asked();
    const small = await t.plainTask();
    await t.set(small.taskId, "SET budgetUsd = :limit", { ":limit": 4 });
    t.db.delete(orgMemberKey(TEST_ORG, MAYA.developerId));
    await t.pauseAndEnd(small);
    const request = t.requestOf(small.taskId)[0]!;
    expect(request.approverRole).toBe("org_admin");
    expect((await spendApprovers(t.deps(), request)).ids.sort()).toEqual([ADA.developerId, DEB.developerId].sort());
    void task;
  });

  it("is APPROVAL_CLOSED once its time ran out, before the sweep ends it", async () => {
    const { t, request } = await asked();
    const after = Date.parse(request.expiresAt) + 1;
    expect(await refusal(decideSpendRequest(t.deps(() => after), t.caller(BEN), request.spendRequestId, { requestId: randomUUID(), decision: "APPROVE" }))).toMatchObject({ code: "APPROVAL_CLOSED" });
    expect(t.requestOf(request.taskId!)[0]).toMatchObject({ status: "PENDING" });
  });

  it("refuses an approval when the run limit changed after it was read, and leaves the request open", async () => {
    const { t, task, request } = await asked();
    const deps = t.deps();
    let moved = false;
    const racing = { ...deps, documentClient: { send: async (command: { constructor: { name: string } }) => {
      if (!moved && command.constructor.name === "TransactWriteCommand") {
        moved = true;
        await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 30 });
      }
      return t.db.send(command as never);
    } } };
    expect(await refusal(decideSpendRequest(racing as never, t.caller(BEN), request.spendRequestId, { requestId: randomUUID(), decision: "APPROVE" }))).toMatchObject({ code: "AGENT_REVISION_CONFLICT" });
    expect(t.requestOf(task.taskId)[0]).toMatchObject({ status: "PENDING" });
    expect(t.meta(task.taskId).budgetUsd).toBe(30);
  });

  it("a member who asked for a raise can't approve it unless they pay for the task", async () => {
    const { t, task } = await asked();
    t.grantRole(CARL, "maintainer");
    const made = await createSpendRequest(t.deps(), {
      orgId: TEST_ORG, kind: "run_limit", scope: { kind: "task", taskId: task.taskId }, taskId: task.taskId, subject: `ASKED#${task.taskId}`, amountUsd: 7, newLimitUsd: 21,
      reason: "More, please.", requestedBy: { kind: "member", developerId: CARL.developerId }, resume: "continue",
    });
    expect(await refusal(t.decide(CARL, made.record.spendRequestId))).toMatchObject({ code: "FORBIDDEN" });
    await t.decide(BEN, made.record.spendRequestId);
  });

  it("never reads an item that names another org, whatever key it was found at", async () => {
    const { t, request } = await asked();
    t.db.set({ ...(t.db.get(spendRequestKey(TEST_ORG, request.spendRequestId).pk, "META")!), ...spendRequestKey(ORG_B, request.spendRequestId) });
    expect(await getSpendRequest(t.deps(), ORG_B, request.spendRequestId)).toBeUndefined();
  });

  it("an approval does not resume a task its creator was removed from (R60)", async () => {
    const { t, task, request } = await asked();
    const ops = t.taskOps(task.workspaceId).length;
    t.db.delete(orgMemberKey(TEST_ORG, MAYA.developerId));
    t.db.set({ ...orgRemovedKey(TEST_ORG, MAYA.developerId), entityType: "ORG_REMOVED", removedAt: new Date().toISOString() });
    await t.decide(BEN, request.spendRequestId);
    expect(t.requestOf(task.taskId)[0]).toMatchObject({ status: "APPROVED" });
    expect(t.taskOps(task.workspaceId)).toHaveLength(ops);
  });

  it("an approval does not resume a task that is still paused on another limit", async () => {
    const { t, task, request } = await asked();
    const ops = t.taskOps(task.workspaceId).length;
    // The month's budget ran out too, after the run limit was asked for.
    await t.set(task.taskId, "SET budgetPause = :pause", { ":pause": { scope: { kind: "member", developerId: MAYA.developerId }, at: new Date().toISOString() } });
    await t.decide(BEN, request.spendRequestId);
    expect(t.meta(task.taskId)).toMatchObject({ budgetUsd: 21, budgetPause: { scope: { kind: "member" } } });
    expect(t.taskOps(task.workspaceId)).toHaveLength(ops);
  });

  it("escalates only an owner's max-per-run request, never a run limit's", async () => {
    const { t } = await asked();
    const later = Date.now() + OWNER_ANSWER_HOURS * 3_600_000 + 60_000;
    expect(await escalateOwnerRequests(t.deps(() => later), { budgetMs: 5_000 })).toMatchObject({ escalated: 0 });
    expect(t.requests()[0]!.escalatedAt).toBeUndefined();
  });
});

describe("the settlement run", () => {
  it("escalates owner requests before the spend sweep, with a small budget of its own", () => {
    expect(SETTLEMENT_BUDGETS_MS).toMatchObject({ escalate: 2_000 });
    expect(settlementBudgets(0)).toMatchObject({ escalate: 2_000 });
    expect(settlementBudgets(26_000).escalate).toBe(1_000);
  });

  it("the broker's settlement event runs escalate-owner-requests after the approvals and before the sweep", async () => {
    const t = await setup();
    const reply = await t.handler({ source: "agentx.spend-settlement" }) as { body: string };
    const names = (JSON.parse(reply.body) as { jobs: Array<{ name: string }> }).jobs.map((job) => job.name);
    expect(names.indexOf("escalate-owner-requests")).toBeGreaterThan(names.indexOf("expire-approvals"));
    expect(names.indexOf("escalate-owner-requests")).toBeLessThan(names.indexOf("sweep-spend"));
  });
});

describe("Task 31's carried fixes: superseding a task's earlier keys", () => {
  async function ledgerWorld() {
    const t = await setup();
    const task = await t.plainTask();
    const capability = (t.outboxOf(task.operationId)!.invocation as { callbackCapability: string }).callbackCapability;
    const ask = () => call(t.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": capability } });
    expect((await ask()).status).toBe(200);
    const keyId = t.meta(task.taskId).modelKeyIds![0]!;
    const ledger = { documentClient: t.db, tableName: "state", access: t.access, now: Date.now };
    return { ...t, task, ask, keyId, ledger, record: () => t.db.get(modelKeyKey(TEST_ORG, keyId).pk, "META") as Record<string, unknown> & { finalized: boolean; finalizeAfter?: number } };
  }

  it("M-1 (documented): a superseded key of the running operation is finalized at once, and what it spends afterwards is still settled on its scopes", async () => {
    const w = await ledgerWorld();
    await supersedeKeys(w.ledger, TEST_ORG, [w.keyId]);
    expect(w.record()).toMatchObject({ finalized: true });
    const counter = () => (w.db.get(spendCounterKey(TEST_ORG, month(), `MEMBER#${MAYA.developerId}`).pk, `MEMBER#${MAYA.developerId}`) as { spentUsd?: number } | undefined)?.spentUsd ?? 0;
    const before = counter();
    // A request the proxy admitted before the block finishes and spends.
    w.access.setKeySpent(w.access.mintedKeys()[0]!, 3);
    await runSpendSweep(w.ledger, { budgetMs: 5_000 });
    expect(counter()).toBeCloseTo(before + 3, 6);
  });

  it("M-2: a key whose finalize lost every try gets its window instead of holding until it expires", async () => {
    const w = await ledgerWorld();
    let tries = 0;
    const racing = { ...w.ledger, documentClient: { send: async (command: { constructor: { name: string }; input: { TransactItems?: unknown[] } }) => {
      if (command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("finalizedAt")) {
        tries += 1;
        throw Object.assign(new Error("lost"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }] });
      }
      return w.db.send(command);
    } } };
    await supersedeKeys(racing, TEST_ORG, [w.keyId]);
    expect(tries).toBeGreaterThan(0);
    expect(w.record().finalized).toBe(false);
    expect(w.record().finalizeAfter).toBeDefined();
    void finalizeKey;
  });
});

describe("contracts", () => {
  it("suggests half the limit again, rounded up, never under $5", () => {
    expect(suggestedTopUpUsd(14)).toBe(7);
    expect(suggestedTopUpUsd(4)).toBe(5);
    expect(suggestedTopUpUsd(0)).toBe(5);
    expect(suggestedTopUpUsd(15)).toBe(8);
  });

  it("keys a request and its open index in the caller's org", () => {
    expect(spendRequestKey(TEST_ORG, "spr_aaaaaaaaaaaaaaaaaaaa").pk).toContain(TEST_ORG);
    expect(openSpendRequestsKey(TEST_ORG, "2026-10-22T00:00:00.000Z", "spr_aaaaaaaaaaaaaaaaaaaa").pk).toContain(TEST_ORG);
    void orgMemberKey;
  });
});

describe("fix round 1 (the Task 32 review)", () => {
  const dueOf = (t: World, spendRequestId: string) => t.db.find((item) => item.entityType === "SPEND_REQUEST_DUE" && item.spendRequestId === spendRequestId)
    .map((item) => Date.parse(String(item.sk).split("#")[0]!));
  const recordOf = (t: World, spendRequestId: string) => t.requests().find((record) => record.spendRequestId === spendRequestId)!;

  describe("I-1: an owner_cap change is checked again when it is decided", () => {
    /** Ada moves Maya's $30 agent to Omar, who already has $90: the move waits for an admin. */
    async function heldTransfer() {
      const t = await setup();
      await t.budgeted(50, OMAR);
      await t.budgeted(40, OMAR);
      const agentId = await t.budgeted(30);
      const moved = await t.api(ADA, "PUT", `/v1/app/agents/${agentId}/owner`, { owner: { kind: "member", developerId: OMAR.developerId } });
      expect(moved.status, JSON.stringify(moved.body)).toBe(202);
      return { t, agentId, id: moved.body.spendRequestId as string };
    }

    it("P4: the new owner's removal expires the request, and an approval after it is APPROVAL_CLOSED and moves nothing", async () => {
      const { t, agentId, id } = await heldTransfer();
      await onMemberRemoved(t.deps(), { orgId: TEST_ORG, developerId: OMAR.developerId, by: ADA.developerId });
      t.db.delete(orgMemberKey(TEST_ORG, OMAR.developerId));
      t.db.set({ ...orgRemovedKey(TEST_ORG, OMAR.developerId), entityType: "ORG_REMOVED", removedAt: new Date().toISOString() });
      expect(recordOf(t, id)).toMatchObject({ status: "EXPIRED" });
      expect(await refusal(t.decide(DEB, id))).toMatchObject({ code: "APPROVAL_CLOSED" });
      expect(t.agentItem(agentId)!.owner).toEqual({ kind: "member", developerId: MAYA.developerId });
      expect(t.ownerTotal(OMAR)).toBe(0);
    });

    it("refuses the approval when the target left before any mover ran, and ends the request", async () => {
      const { t, agentId, id } = await heldTransfer();
      t.db.delete(orgMemberKey(TEST_ORG, OMAR.developerId));
      t.db.set({ ...orgRemovedKey(TEST_ORG, OMAR.developerId), entityType: "ORG_REMOVED", removedAt: new Date().toISOString() });
      expect(await refusal(t.decide(DEB, id))).toMatchObject({ code: "APPROVAL_CLOSED" });
      expect(recordOf(t, id)).toMatchObject({ status: "EXPIRED" });
      expect(t.openItems()).toEqual([]);
      expect(t.agentItem(agentId)!.owner).toEqual({ kind: "member", developerId: MAYA.developerId });
      expect(t.ownerTotal(OMAR)).toBe(90);
    });

    // Final fix wave, money M-3: the request was summed for one owner; it applies to nobody else.
    it("M-3: a budget change held for one owner is not applied once the agent counts for another: the request ends with a clear refusal and nothing applies", async () => {
      const t = await setup();
      await t.budgeted(50);
      await t.budgeted(50);
      const third = await t.agentOf();
      const asked = await t.setBudget(MAYA, third, { monthlyUsd: 1 });
      expect(asked.status, JSON.stringify(asked.body)).toBe(202);
      const id = asked.body.spendRequestId as string;
      expect(recordOf(t, id)).toMatchObject({ forOwner: MAYA.developerId });
      // Before an admin answers, an admin gives the agent to Ben, whose total this request was never about.
      const moved = await t.api(ADA, "PUT", `/v1/app/agents/${third}/owner`, { owner: { kind: "member", developerId: BEN.developerId } });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      const refused = await refusal(t.decide(DEB, id));
      expect(refused).toMatchObject({ code: "APPROVAL_CLOSED" });
      expect(refused!.message).toMatch(/counts for someone else/);
      expect(recordOf(t, id)).toMatchObject({ status: "EXPIRED", endedBecause: "owner_moved" });
      expect(t.agentItem(third)!.monthlyBudgetUsd).toBeUndefined();
      expect(t.ownerTotal(BEN)).toBe(0);
      expect(t.openItems()).toEqual([]);
    });

    it("M-3: the same change still applies as asked while the agent counts for the owner it was summed for", async () => {
      const t = await setup();
      await t.budgeted(50);
      await t.budgeted(50);
      const third = await t.agentOf();
      const id = (await t.setBudget(MAYA, third, { monthlyUsd: 1 })).body.spendRequestId as string;
      await t.decide(DEB, id);
      expect(t.agentItem(third)!.monthlyBudgetUsd).toBe(1);
      expect(t.ownerTotal(MAYA)).toBe(101);
    });

    it("a merge rewrites routing but expires approval of the original counted owner figures", async () => {
      const { t, agentId, id } = await heldTransfer();
      await onMembersMerged(t.deps(), { orgId: TEST_ORG, survivorId: CARL.developerId, duplicateId: OMAR.developerId });
      expect(recordOf(t, id)).toMatchObject({ status: "PENDING", newOwner: { developerId: CARL.developerId }, change: { op: "set_owner", owner: { kind: "member", developerId: CARL.developerId } } });
      const before = t.agentItem(agentId), totalBefore = t.ownerTotal(CARL);
      await expect(t.decide(DEB, id)).rejects.toMatchObject({ code: "SPENDING_APPROVAL_STALE" });
      expect(recordOf(t, id)).toMatchObject({ status: "EXPIRED", endedBecause: "figures_changed" });
      expect(t.agentItem(agentId)).toEqual(before); expect(t.ownerTotal(CARL)).toBe(totalBefore);
    });
  });

  describe("I-2: a second over-cap change on the same agent", () => {
    it("P3: a different change gets 409 naming the waiting request; the same change answers 202 and keeps its own R18 mark", async () => {
      const t = await setup();
      await t.budgeted(50);
      await t.budgeted(50);
      const third = await t.agentOf();
      const first = await t.setBudget(MAYA, third, { monthlyUsd: 1 });
      expect(first.status).toBe(202);
      const id = first.body.spendRequestId as string;
      const other = await t.setBudget(ADA, third, { monthlyUsd: 25 });
      expect(other.status, JSON.stringify(other.body)).toBe(409);
      expect(other.body).toMatchObject({ error: { code: "AGENT_REVISION_CONFLICT", message: expect.stringContaining(`A change to this agent's budget is already waiting for an admin (${id}). Wait for it, or ask an admin to decline it.`) as string } });
      const requestId = randomUUID();
      const same = await t.dev(ADA, "PUT", `/v1/app/agents/${third}/budget`, { requestId, monthlyUsd: 1 });
      expect(same.status).toBe(202);
      expect(same.body).toMatchObject({ spendRequestId: id });
      // Ada's request id was remembered: the same id with another body is refused (R18).
      expect((await t.dev(ADA, "PUT", `/v1/app/agents/${third}/budget`, { requestId, monthlyUsd: 2 })).body).toMatchObject({ error: { code: "CONFIG_INVALID" } });
      expect(t.requests()).toHaveLength(1);
      await t.decide(DEB, id);
      expect(t.agentItem(third)!.monthlyBudgetUsd).toBe(1);
    });
  });

  describe("I-3: an approval after the task went on", () => {
    it("P2: the owner's Continue withdraws the open request, so a late approval is APPROVAL_CLOSED and starts no turn", async () => {
      const t = await setup();
      const task = await t.plainTask();
      await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
      await t.pauseAndEnd(task);
      const id = t.requestOf(task.taskId)[0]!.spendRequestId;
      const continued = await t.api(MAYA, "POST", `/v1/dev/tasks/${task.taskId}/continue`, { instructions: "Go on" });
      expect(continued.status, JSON.stringify(continued.body)).toBe(200);
      expect(recordOf(t, id)).toMatchObject({ status: "EXPIRED" });
      expect(t.openItems()).toEqual([]);
      expect((await t.view(MAYA, task.taskId)).paused).toBeUndefined();
      await t.finish(task.workspaceId, t.taskOps(task.workspaceId).at(-1)!.id, "SUCCEEDED", { result: {} });
      const before = t.taskOps(task.workspaceId).length;
      expect(await refusal(t.decide(BEN, id))).toMatchObject({ code: "APPROVAL_CLOSED" });
      expect(t.taskOps(task.workspaceId)).toHaveLength(before);
      expect(t.meta(task.taskId).budgetUsd).toBe(14);
    });

    it("an approval of a task whose pause went away some other way raises the limit and starts nothing", async () => {
      const t = await setup();
      const task = await t.plainTask();
      await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
      await t.pauseAndEnd(task);
      const id = t.requestOf(task.taskId)[0]!.spendRequestId;
      await t.set(task.taskId, "REMOVE budgetPause");
      const before = t.taskOps(task.workspaceId).length;
      await t.decide(BEN, id);
      expect(recordOf(t, id)).toMatchObject({ status: "APPROVED" });
      expect(t.meta(task.taskId).budgetUsd).toBe(21);
      expect(t.taskOps(task.workspaceId)).toHaveLength(before);
    });

    it("the pause the approval was for is a condition of its write: a pause removed meanwhile raises the limit and starts nothing", async () => {
      const t = await setup();
      const task = await t.plainTask();
      await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
      await t.pauseAndEnd(task);
      const id = t.requestOf(task.taskId)[0]!.spendRequestId;
      const before = t.taskOps(task.workspaceId).length;
      const deps = t.deps();
      let moved = false;
      const racing = { ...deps, documentClient: { send: async (command: { constructor: { name: string } }) => {
        if (!moved && command.constructor.name === "TransactWriteCommand") {
          moved = true;
          await t.set(task.taskId, "REMOVE budgetPause");
        }
        return t.db.send(command as never);
      } } };
      await decideSpendRequest(racing, t.caller(BEN), id, { requestId: randomUUID(), decision: "APPROVE" });
      expect(recordOf(t, id)).toMatchObject({ status: "APPROVED" });
      expect(t.meta(task.taskId).budgetUsd).toBe(21);
      expect(t.taskOps(task.workspaceId)).toHaveLength(before);
    });
  });

  describe("I-4: the run's starter", () => {
    it("P8: a project-paid run's starter, a maintainer but not the payer, can't approve their own run's raise", async () => {
      const t = await setup();
      t.grantRole(MAYA, "maintainer");
      const task = await t.plainTask();
      await t.set(task.taskId, "SET budgetUsd = :limit, payer = :payer", { ":limit": 4, ":payer": { kind: "project", project: "payments" } });
      await t.pauseAndEnd(task);
      const request = t.requestOf(task.taskId)[0]!;
      expect(request).toMatchObject({ requestedFor: { developerId: MAYA.developerId }, approverRole: "payer", approverIds: [BEN.developerId] });
      expect(await refusal(t.decide(MAYA, request.spendRequestId))).toMatchObject({ code: "FORBIDDEN" });
      expect(t.meta(task.taskId).budgetUsd).toBe(4);
      await t.decide(BEN, request.spendRequestId);
      expect(t.meta(task.taskId).budgetUsd).toBe(9);
    });

    it("P6: the agent's owner who started the run can't raise its stop; it goes to the org's admins", async () => {
      const t = await setup();
      const agentId = await t.agentOf(TRIAGE, { name: "Ticket looker" });
      await t.setBudget(MAYA, agentId, { maxPerRunUsd: 4 });
      const run = await t.runOf(agentId);
      await t.set(run.taskId, "SET budgetUsd = :limit", { ":limit": 25 });
      await t.pauseAndEnd(run, { kind: "max_per_run", taskId: run.taskId });
      const request = t.requestOf(run.taskId, "max_per_run")[0]!;
      expect(request).toMatchObject({ requestedFor: { developerId: MAYA.developerId }, approverRole: "org_admin" });
      expect([...request.approverIds].sort()).toEqual([ADA.developerId, DEB.developerId].sort());
      expect(await refusal(t.decide(MAYA, request.spendRequestId, "APPROVE", { amountUsd: 90 }))).toMatchObject({ code: "FORBIDDEN" });
      expect(t.meta(run.taskId).maxPerRunUsd).toBe(4);
      await t.decide(DEB, request.spendRequestId);
      expect(t.meta(run.taskId).maxPerRunUsd).toBe(9);
    });

    it("the unenrolled org's only owner retains legacy per-run decision", async () => {
      const t = await setup({ secondAdmin: false });
      const agentId = await t.agentOf(TRIAGE, { by: ADA, name: "Ada's looker" });
      await t.setBudget(ADA, agentId, { maxPerRunUsd: 4 });
      const run = await t.runOf(agentId, { who: ADA });
      await t.set(run.taskId, "SET budgetUsd = :limit", { ":limit": 25 });
      await t.pauseAndEnd(run, { kind: "max_per_run", taskId: run.taskId });
      const request = t.requestOf(run.taskId, "max_per_run")[0]!;
      expect((await t.decide(ADA, request.spendRequestId)).spendRequest.status).toBe("APPROVED");
      expect(t.meta(run.taskId).maxPerRunUsd).toBe(9);
    });
  });

  describe("minors", () => {
    it("M-1: a held start whose dispatch failed after the approval is retried by the settlement run", async () => {
      const t = await setup();
      const started = await startAgentRun(t.starter(), {
        requestId: randomUUID(), orgId: TEST_ORG, project: "payments", agent: { agentId: "rovara-code" }, input: { text: "Fix the retry bug" }, origin: "app",
        owner: { developerId: MAYA.developerId }, startedBy: { developerId: MAYA.developerId }, payer: { kind: "member", developerId: MAYA.developerId }, runLimitUsd: 0,
      });
      const request = t.requestOf(started.taskId)[0]!;
      const prepare = t.operations(t.meta(started.taskId).workspaceId).find((operation) => operation.kind === "prepare")!;
      const deps = t.deps();
      const failing = { ...deps, spendRequests: { ...deps.spendRequests!, resumeTask: () => Promise.reject(new Error("no free workspace")) } };
      await decideSpendRequest(failing, t.caller(MAYA), request.spendRequestId, { requestId: randomUUID(), decision: "APPROVE" });
      expect(t.meta(started.taskId)).toMatchObject({ budgetUsd: 5, budgetPause: { firstDispatch: { operationId: prepare.id } } });
      expect(t.outboxOf(prepare.id)).toBeUndefined();
      expect(t.taskEvents(started.taskId)).toContain("The budget was approved, but this run couldn't start yet. Rovara will keep trying.");
      expect(await escalateOwnerRequests(t.deps(), { budgetMs: 5_000 })).toMatchObject({ heldStarts: 1 });
      expect(t.outboxOf(prepare.id)).toBeDefined();
      expect(t.meta(started.taskId).budgetPause).toBeUndefined();
      expect(await escalateOwnerRequests(t.deps(), { budgetMs: 5_000 })).toMatchObject({ heldStarts: 0 });
    });

    it("M-2 (P5): approving a closed task's request is APPROVAL_CLOSED and ends it; declining one is a clean decline", async () => {
      const t = await setup();
      const task = await t.plainTask();
      await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
      await t.pauseAndEnd(task);
      const id = t.requestOf(task.taskId)[0]!.spendRequestId;
      await t.set(task.taskId, "SET closedAt = :closed", { ":closed": new Date().toISOString() });
      expect(await refusal(t.decide(BEN, id))).toEqual({ code: "APPROVAL_CLOSED", message: "This task was closed, so nobody can decide this now." });
      expect(recordOf(t, id)).toMatchObject({ status: "EXPIRED" });
      expect(t.openItems()).toEqual([]);
      const other = await t.plainTask();
      await t.set(other.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
      await t.pauseAndEnd(other);
      const declined = t.requestOf(other.taskId)[0]!.spendRequestId;
      await t.set(other.taskId, "SET closedAt = :closed", { ":closed": new Date().toISOString() });
      await t.decide(BEN, declined, "DENY");
      expect(recordOf(t, declined)).toMatchObject({ status: "DENIED" });
    });

    it("M-2 / M-6 (M6): a task closed between the read and the write is not raised, and the request ends as closed", async () => {
      const t = await setup();
      const task = await t.plainTask();
      await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
      await t.pauseAndEnd(task);
      const id = t.requestOf(task.taskId)[0]!.spendRequestId;
      const deps = t.deps();
      let closed = false;
      const racing = { ...deps, documentClient: { send: async (command: { constructor: { name: string } }) => {
        if (!closed && command.constructor.name === "TransactWriteCommand") {
          closed = true;
          await t.set(task.taskId, "SET closedAt = :closed", { ":closed": new Date().toISOString() });
        }
        return t.db.send(command as never);
      } } };
      expect(await refusal(decideSpendRequest(racing as never, t.caller(BEN), id, { requestId: randomUUID(), decision: "APPROVE" }))).toMatchObject({ code: "APPROVAL_CLOSED" });
      expect(t.meta(task.taskId).budgetUsd).toBe(14);
      expect(recordOf(t, id)).toMatchObject({ status: "EXPIRED" });
    });

    it("M-4: an owner_cap approval checks the guardrails and the trial limits again", async () => {
      const t = await setup();
      await t.budgeted(50);
      await t.budgeted(50);
      const third = await t.agentOf();
      const id = (await t.setBudget(MAYA, third, { monthlyUsd: 30 })).body.spendRequestId as string;
      t.db.set({ ...agentGuardrailsKey(TEST_ORG), entityType: "AGENT_GUARDRAILS", revision: 1, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxAgentMonthlyUsd: 20 } });
      expect(await refusal(t.decide(DEB, id))).toMatchObject({ code: "CONFIG_INVALID" });
      expect(t.agentItem(third)!.monthlyBudgetUsd).toBeUndefined();
      t.db.delete(agentGuardrailsKey(TEST_ORG));
      t.db.set({ ...t.db.get(`ORG#${TEST_ORG}`, "META")!, plan: "trial" });
      expect(await refusal(t.decide(DEB, id))).toMatchObject({ code: "CONFIG_INVALID" });
      expect(t.agentItem(third)!.monthlyBudgetUsd).toBeUndefined();
      expect(recordOf(t, id)).toMatchObject({ status: "PENDING" });
    });

    it("M-5: a request that never escalates is due at its expiry, and an escalated one moves there, so neither is read again before it expires", async () => {
      const t = await setup();
      const asked = await t.plainTask();
      await t.set(asked.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
      await t.pauseAndEnd(asked);
      const runLimit = t.requestOf(asked.taskId)[0]!;
      expect(dueOf(t, runLimit.spendRequestId)).toEqual([Date.parse(runLimit.expiresAt)]);
      const agentId = await t.agentOf(TRIAGE, { name: "Ticket looker" });
      await t.setBudget(MAYA, agentId, { maxPerRunUsd: 4 });
      await t.shareWith(agentId, BEN);
      const run = await t.runOf(agentId, { who: BEN });
      await t.set(run.taskId, "SET budgetUsd = :limit", { ":limit": 25 });
      await t.pauseAndEnd(run, { kind: "max_per_run", taskId: run.taskId });
      const max = t.requestOf(run.taskId, "max_per_run")[0]!;
      expect(dueOf(t, max.spendRequestId)).toEqual([Date.parse(max.createdAt) + OWNER_ANSWER_HOURS * 3_600_000]);
      const later = Date.now() + OWNER_ANSWER_HOURS * 3_600_000 + 60_000;
      expect(await escalateOwnerRequests(t.deps(() => later), { budgetMs: 5_000 })).toMatchObject({ escalated: 1, complete: true });
      expect(dueOf(t, max.spendRequestId)).toEqual([Date.parse(max.expiresAt)]);
      const deps = t.deps(() => later + 60_000);
      const read: string[] = [];
      const counting = { ...deps, documentClient: { send: (command: { constructor: { name: string }; input: { Key?: { pk?: string } } }) => {
        if (command.constructor.name === "GetCommand" && String(command.input.Key?.pk).includes("SPEND_REQUEST#")) read.push(String(command.input.Key?.pk));
        return t.db.send(command);
      } } };
      expect(await escalateOwnerRequests(counting as never, { budgetMs: 5_000 })).toMatchObject({ escalated: 0, complete: true });
      expect(read).toEqual([]);
      await t.decide(DEB, max.spendRequestId);
      expect(dueOf(t, max.spendRequestId)).toEqual([]);
    });

    it("M-6 (M8): the page's decide refuses a proof that is not a fresh sign-in", async () => {
      const t = await setup();
      const task = await t.plainTask();
      await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
      await t.pauseAndEnd(task);
      const id = t.requestOf(task.taskId)[0]!.spendRequestId;
      const kind = spendDecideKind(t.deps());
      expect(await refusal(kind.decide({ orgId: TEST_ORG, developerId: BEN.developerId, approvalId: id }, "approve", { kind: "button", via: "slack" }))).toMatchObject({ code: "FORBIDDEN" });
      expect(recordOf(t, id)).toMatchObject({ status: "PENDING" });
    });

    it("M-6 (M20): someone who may not decide learns nothing of how a request ended", async () => {
      const t = await setup();
      const task = await t.plainTask();
      await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
      await t.pauseAndEnd(task);
      const id = t.requestOf(task.taskId)[0]!.spendRequestId;
      const kind = spendDecideKind(t.deps());
      await t.decide(BEN, id);
      expect(await kind.inspect({ orgId: TEST_ORG, developerId: CARL.developerId, approvalId: id })).toMatchObject({ status: "forbidden" });
      const other = await t.plainTask();
      await t.set(other.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
      await t.pauseAndEnd(other);
      const expiring = t.requestOf(other.taskId)[0]!;
      const late = spendDecideKind(t.deps(() => Date.parse(expiring.expiresAt) + 1));
      expect(await late.inspect({ orgId: TEST_ORG, developerId: CARL.developerId, approvalId: expiring.spendRequestId })).toMatchObject({ status: "forbidden" });
    });

    it("M-6 (M21): a refused decision on the decide route gives the session back", async () => {
      const t = await setup();
      const task = await t.plainTask();
      await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
      await t.pauseAndEnd(task);
      const id = t.requestOf(task.taskId)[0]!.spendRequestId;
      const ended: string[] = [];
      const proof = { kind: "fresh_sign_in" as const, method: "email_code" as const, authTime: new Date().toISOString(), sessionRef: "a".repeat(64) };
      const deps = { ...t.deps(), requireDecide: () => Promise.resolve({ orgId: TEST_ORG, developerId: CARL.developerId, proof, finish: async () => { ended.push("finish"); }, release: async () => { ended.push("release"); } }) };
      const request = { method: "POST", body: JSON.stringify({ decision: "APPROVE" }), headers: {} };
      expect(await refusal(routeSpendRequests(deps as never, t.caller(CARL), request as never, new URL(`${CELL}/v1/app/spend-requests/${id}/decide`)))).toMatchObject({ code: "FORBIDDEN" });
      expect(ended).toEqual(["release"]);
    });

    it("M-6 (M10, M17): the mover stops at its deadline between two requests, and audits each move as the system's", async () => {
      const t = await setup();
      t.grantRole(OMAR, "contributor");
      const ids: string[] = [];
      for (let index = 0; index < 2; index += 1) {
        const task = await t.plainTask(OMAR);
        await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 4 });
        await t.pauseAndEnd(task);
        ids.push(t.requestOf(task.taskId)[0]!.spendRequestId);
      }
      const capture = capturingAuditDeps({ db: t.db });
      const deps = t.deps();
      let moved = 0;
      const deadline = Date.now() + 60_000;
      const timed = {
        ...deps, audit: capture.audit, deadline, now: () => (moved > 0 ? deadline + 1 : Date.now()),
        documentClient: { send: async (command: { constructor: { name: string }; input: unknown }) => {
          const answer = await t.db.send(command as never);
          if (command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("moveRevision")) moved += 1;
          return answer;
        } },
      };
      await expect(onMembersMerged(timed as never, { orgId: TEST_ORG, survivorId: CARL.developerId, duplicateId: OMAR.developerId })).rejects.toThrow();
      expect(moved).toBe(1);
      expect(ids.map((id) => recordOf(t, id).approverIds)).toContainEqual([OMAR.developerId]);
      expect(capture.recordedBy("spend_request.rerouted")).toHaveLength(1);
      expect(capture.recordedBy("spend_request.rerouted")[0]).toMatchObject({ actor: { kind: "system" } });
    });

    it("M-7: an owner_cap decision takes no amount and stores none", async () => {
      const t = await setup();
      await t.budgeted(50);
      await t.budgeted(50);
      const third = await t.agentOf();
      const id = (await t.setBudget(MAYA, third, { monthlyUsd: 1 })).body.spendRequestId as string;
      expect(await refusal(t.decide(DEB, id, "APPROVE", { amountUsd: 500 }))).toMatchObject({ code: "CONFIG_INVALID" });
      const decided = await t.decide(DEB, id);
      expect(decided.spendRequest).not.toHaveProperty("approvedAmountUsd");
      expect(recordOf(t, id)).not.toHaveProperty("approvedAmountUsd");
      expect(t.agentItem(third)!.monthlyBudgetUsd).toBe(1);
    });
  });
});

// Review M-5 of Plan 5 Task 21: in an org with no owner left, a request routed to the person who left is handed to the approvers who are left, or ended with a reason and the asker told. Never approved.
describe("a removal in an org with no owner left", () => {
  /** A $1 budget change that waits for an admin, asked by Maya; Ada is then made an admin (no owner is left once Deb goes). */
  async function waiting() {
    const t = await setup();
    await t.budgeted(50);
    await t.budgeted(50);
    const third = await t.agentOf();
    const asked = await t.setBudget(MAYA, third, { monthlyUsd: 1 });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    const id = asked.body.spendRequestId as string;
    t.db.set({ ...(t.db.get(orgMemberKey(TEST_ORG, ADA.developerId)) as Record<string, unknown>), role: "admin" });
    const recordOf = () => t.requests().find((record) => record.spendRequestId === id)!;
    const setApprovers = (approverIds: string[]) => {
      const stored = t.db.get(spendRequestKey(TEST_ORG, id)) as Record<string, unknown>;
      t.db.set({ ...stored, approverIds });
      t.db.set({ ...openSpendRequestsKey(TEST_ORG, String(stored["createdAt"]), id), entityType: "SPEND_REQUEST_OPEN", orgId: TEST_ORG, spendRequestId: id, approverIds });
    };
    const noticesOf = (who: string) => t.db.find((item) => item.entityType === "CHANGE_NOTICE" && String(item.pk).includes(`CHANGES#${who}`));
    return { t, id, recordOf, setApprovers, noticesOf };
  }

  it("hands the request to the approvers who are left, still PENDING", async () => {
    const { t, recordOf, setApprovers } = await waiting();
    setApprovers([DEB.developerId, ADA.developerId]);
    t.db.delete(orgMemberKey(TEST_ORG, DEB.developerId));
    await onMemberRemoved(t.deps(), { orgId: TEST_ORG, developerId: DEB.developerId, by: ADA.developerId });
    expect(recordOf()).toMatchObject({ status: "PENDING", approverIds: [ADA.developerId] });
    expect(t.openItems().map((item) => (item as { approverIds?: string[] }).approverIds)).toEqual([[ADA.developerId]]);
  });

  it("ends a request nobody else can decide, with the reason the asker reads, and tells the asker; it is never approved", async () => {
    const { t, recordOf, setApprovers, noticesOf } = await waiting();
    setApprovers([DEB.developerId]);
    // Ada, the only other admin, is a plain member now: nobody is left who could decide it.
    t.db.set({ ...(t.db.get(orgMemberKey(TEST_ORG, ADA.developerId)) as Record<string, unknown>), role: "member" });
    t.db.delete(orgMemberKey(TEST_ORG, DEB.developerId));
    await onMemberRemoved(t.deps(), { orgId: TEST_ORG, developerId: DEB.developerId, by: ADA.developerId });
    expect(recordOf()).toMatchObject({ status: "EXPIRED", endedBecause: "approver_left" });
    expect(t.openItems()).toEqual([]);
    expect(noticesOf(MAYA.developerId)).toHaveLength(1);
  });

  it("lists the approvers who can decide it now, whatever the stored list said, with an owner left too (Re-check R-1)", async () => {
    const { t, recordOf, setApprovers } = await waiting();
    // Ada is the owner again; the stored list names only Deb, who leaves. Who may decide is read live: Ada.
    t.db.set({ ...(t.db.get(orgMemberKey(TEST_ORG, ADA.developerId)) as Record<string, unknown>), role: "owner" });
    setApprovers([DEB.developerId]);
    t.db.delete(orgMemberKey(TEST_ORG, DEB.developerId));
    await onMemberRemoved(t.deps(), { orgId: TEST_ORG, developerId: DEB.developerId, by: ADA.developerId });
    expect(recordOf()).toMatchObject({ status: "PENDING", approverIds: [ADA.developerId] });
  });

  it("lists only the approvers who can decide it now: not the person who asked, nor someone who is no approver (Re-check R-1)", async () => {
    const { t, id, recordOf, setApprovers } = await waiting();
    // Ada (the owner) asked this change; Ben is made an admin; the stored list names Deb, who leaves, and Carl, who is no approver at all.
    t.db.set({ ...(t.db.get(orgMemberKey(TEST_ORG, ADA.developerId)) as Record<string, unknown>), role: "owner" });
    t.db.set({ ...(t.db.get(orgMemberKey(TEST_ORG, BEN.developerId)) as Record<string, unknown>), role: "admin" });
    t.db.set({ ...(t.db.get(spendRequestKey(TEST_ORG, id)) as Record<string, unknown>), requestedBy: { kind: "member", developerId: ADA.developerId } });
    setApprovers([DEB.developerId, CARL.developerId]);
    t.db.delete(orgMemberKey(TEST_ORG, DEB.developerId));
    await onMemberRemoved(t.deps(), { orgId: TEST_ORG, developerId: DEB.developerId, by: ADA.developerId });
    expect(recordOf()).toMatchObject({ status: "PENDING", approverIds: [BEN.developerId] });
  });

  it("leaves a request alone that does not name the person who left, and repeating changes nothing", async () => {
    const { t, recordOf, setApprovers } = await waiting();
    setApprovers([ADA.developerId]);
    const before = structuredClone(recordOf());
    t.db.delete(orgMemberKey(TEST_ORG, DEB.developerId));
    await onMemberRemoved(t.deps(), { orgId: TEST_ORG, developerId: DEB.developerId, by: ADA.developerId });
    expect(recordOf()).toEqual(before);
    await onMemberRemoved(t.deps(), { orgId: TEST_ORG, developerId: DEB.developerId, by: ADA.developerId });
    expect(recordOf()).toEqual(before);
  });
});

for (const drift of ["unchanged", "total_before", "policy_before", "counter_commit"] as const) it(`M47 existing counted-move confirmation retains original base figures: ${drift}`, async () => {
  const t = await setup();
  const first = await t.budgeted(50, ADA); await t.budgeted(40, ADA); await t.budgeted(30, OMAR);
  await onMemberRemoved(t.deps(), { orgId: TEST_ORG, developerId: OMAR.developerId, by: ADA.developerId });
  const record = t.requests().find(item => item.change?.op === "confirm_move")!;
  expect(record).toBeDefined(); expect(t.ownerTotal(ADA)).toBe(120);
  if (drift === "total_before") expect((await t.setBudget(ADA, first, { monthlyUsd: 49 })).status).toBe(200);
  if (drift === "policy_before") t.db.set({ ...orgSettingsKey(TEST_ORG, "SPEND_POLICY"), orgId: TEST_ORG, ...defaultSpendPolicy(), revision: 1, ownerAgentBudgetCapUsd: 99 });
  const key = ownerBudgetKey(TEST_ORG, ADA.developerId), send = t.db.send.bind(t.db); let raced = false;
  t.db.send = async command => {
    if (drift === "counter_commit" && !raced && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === spendRequestKey(TEST_ORG, record.spendRequestId).pk && Object.values(item.Update.ExpressionAttributeValues ?? {}).includes("APPROVED"))) {
      raced = true; const counter = t.db.get(key)!; t.db.set({ ...counter, totalUsd: 119, version: Number(counter.version) + 1 });
    }
    return send(command);
  };
  const before = t.agentItem(first), decision = t.decide(DEB, record.spendRequestId);
  if (drift === "unchanged") expect((await decision).spendRequest.status).toBe("APPROVED");
  else await expect(decision).rejects.toMatchObject({ code: "SPENDING_APPROVAL_STALE" });
  expect(t.agentItem(first)).toEqual(before); expect(t.ownerTotal(ADA)).toBe(drift === "total_before" || drift === "counter_commit" ? 119 : 120);
  if (drift === "counter_commit") expect(raced).toBe(true);
});

for (const role of ["owner", "admin"] as const) for (const kind of ["run_limit", "max_per_run"] as const) it(`an unenrolled sole ${role} retains legacy self-decision for ${kind}`, async () => {
 const t = await setup({ secondAdmin: false });seedMembership(t.db, ADA.developerId, { orgId: TEST_ORG, role });
 const agentId = await t.agentOf(TRIAGE, { by: ADA, name: `Own stop ${role} ${kind}` });await t.setBudget(ADA, agentId, { maxPerRunUsd: 4 });
 const run = kind === "run_limit" ? await t.plainTask(ADA) : await t.runOf(agentId, { who: ADA });
 await t.set(run.taskId, "SET budgetUsd = :limit", { ":limit": kind === "run_limit" ? 4 : 25 });
 await t.pauseAndEnd(run, kind === "max_per_run" ? { kind: "max_per_run", taskId: run.taskId } : undefined);
 const request = t.requestOf(run.taskId, kind)[0]!;expect(request).toBeDefined();const before = t.meta(run.taskId);
 expect((await decideSpendRequest(t.deps(), t.caller(ADA, role), request.spendRequestId, { requestId: randomUUID(), decision: "APPROVE" })).spendRequest.status).toBe("APPROVED");expect(t.meta(run.taskId)).not.toEqual(before);
});
