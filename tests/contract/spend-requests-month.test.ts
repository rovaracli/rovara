// Plan 3 Task 33: monthly requests and top-ups. A task stopped by a month's budget (a member's, a project's, an agent's, the org's, a testing allowance) is
// listed under its scope (`pausedTasksKey`) and asks for a `month` top-up once per month, scope and requester. A member's, a project's, a testing allowance's
// and the org's go to the org's owners and admins; an agent's to its owner while the new limit stays within the guardrail and the owner's whole effective
// total (every budget they hold, this month's top-ups included) stays within the cap, else to the admins. The owner counter's `version` makes an owner's
// approval race-safe (R4-6). An approval adds the top-up and resumes every task paused on that scope, keeping their cap windows.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MONTH_APPROVERS, OWNER_TOTAL_CONTRIBUTORS, createSpendRequest, decideSpendRequest, escalateOwnerRequests, ownerEffectiveTotal, spendApprovers,
  type OwnerTotalContributor,
} from "../../packages/broker/src/spend/requests.js";
import { effectiveLimits } from "../../packages/broker/src/spend/settings.js";
import {
  SPEND_RESUME_INSTRUCTIONS, ownerBudgetKey, pausedTasksKey, suggestedMonthTopUpUsd, topUpKey,
  type BudgetScope, type SpendRequestRecord,
} from "@agentx/contracts";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { ADA, CARL, DEB, ORG_B, month, refusal, setup, type World } from "../support/spend-world.js";

const MEMBER: BudgetScope = { kind: "member", developerId: MAYA.developerId };
const monthRequests = (t: World): SpendRequestRecord[] => t.requests().filter((record) => record.kind === "month");
const pausedUnder = (t: World, scope: BudgetScope) => t.db.find((item) => item.pk === pausedTasksKey(TEST_ORG, scopeKeyOf(scope), "x").pk);
const scopeKeyOf = (scope: BudgetScope): string => (scope.kind === "member" ? `MEMBER#${scope.developerId}` : scope.kind === "agent" ? `AGENT#${scope.agentId}` : scope.kind === "project" ? `PROJECT#${scope.project}` : scope.kind === "testing" ? `TESTING#${scope.developerId}` : "ORG");
const topUp = (t: World, scope: BudgetScope) => (t.db.get(topUpKey(TEST_ORG, month(), scope).pk, topUpKey(TEST_ORG, month(), scope).sk) as { amountUsd?: number } | undefined)?.amountUsd ?? 0;
const limitOf = async (t: World, scope: BudgetScope) => (await effectiveLimits({ documentClient: t.db, tableName: "state", cloud: true }, { orgId: TEST_ORG, month: month(), scopes: [scope] })).get(scopeKeyOf(scope));
const version = (t: World, owner: string) => (t.db.get(ownerBudgetKey(TEST_ORG, owner).pk, "TOTAL") as { version?: number } | undefined)?.version ?? 0;

/** A `month` request for an agent's budget, as a pause of one of its runs asks for it (the system asks): its new limit is the limit now plus the amount. */
const agentRequest = async (t: World, agentId: string, amountUsd: number) => {
  const scope: BudgetScope = { kind: "agent", agentId: agentId };
  const limit = (await limitOf(t, scope))!;
  return (await createSpendRequest(t.deps(), {
    orgId: TEST_ORG, kind: "month", scope, subject: `MONTH#${month()}#AGENT#${agentId}#system#${randomUUID()}`, amountUsd, newLimitUsd: limit + amountUsd,
    reason: "More for this month, please.", requestedBy: { kind: "system" },
  })).record;
};

describe("a pause on a month's budget", () => {
  it("a pause on a member's monthly limit lists the task under its scope and asks the admins once, in words naming an admin", async () => {
    const t = await setup();
    const task = await t.plainTask();
    await t.pauseAndEnd(task, MEMBER);
    const [request] = monthRequests(t);
    expect(request).toMatchObject({ kind: "month", scope: MEMBER, amountUsd: 10, newLimitUsd: 39, approverRole: "org_admin", status: "PENDING", requestedBy: { kind: "system" } });
    expect([...request!.approverIds].sort()).toEqual([ADA.developerId, DEB.developerId].sort());
    expect(pausedUnder(t, MEMBER).map((item) => item.sk)).toEqual([task.taskId]);
    expect(t.taskEvents(task.taskId).some((text) => text.includes("an admin"))).toBe(true);
    const shown = await t.view(MAYA, task.taskId);
    expect(shown.paused).toMatchObject({ reason: "budget", scope: { kind: "member" }, spendRequestId: request!.spendRequestId });
    // A second task stopped by the same budget asks for nothing new, and is listed too.
    const second = await t.plainTask();
    await t.pauseAndEnd(second, MEMBER);
    expect(monthRequests(t)).toHaveLength(1);
    expect(pausedUnder(t, MEMBER).map((item) => item.sk).sort()).toEqual([task.taskId, second.taskId].sort());
  });

  it("an admin approves $10: the limit rises by 10, every paused task continues with the exact words, and its cap window is kept", async () => {
    const t = await setup();
    const task = await t.plainTask();
    const second = await t.plainTask();
    await t.set(task.taskId, "SET budgetBaselineUsd = :baseline", { ":baseline": 3 });
    await t.pauseAndEnd(task, MEMBER);
    await t.pauseAndEnd(second, MEMBER);
    const id = monthRequests(t)[0]!.spendRequestId;
    const before = await limitOf(t, MEMBER);
    const ops = [t.taskOps(task.workspaceId).length, t.taskOps(second.workspaceId).length];
    expect(await refusal(t.decide(MAYA, id))).toMatchObject({ code: "FORBIDDEN" });
    await t.decide(DEB, id, "APPROVE", { amountUsd: 10 });
    expect(topUp(t, MEMBER)).toBe(10);
    expect(await limitOf(t, MEMBER)).toBe(before! + 10);
    for (const [index, each] of [task, second].entries()) {
      const next = t.taskOps(each.workspaceId);
      expect(next).toHaveLength(ops[index]! + 1);
      expect(JSON.stringify(t.outboxOf(next.at(-1)!.id)?.invocation)).toContain(SPEND_RESUME_INSTRUCTIONS);
      expect(t.meta(each.taskId).budgetPause).toBeUndefined();
    }
    expect(t.meta(task.taskId).budgetBaselineUsd).toBe(3);
    expect(pausedUnder(t, MEMBER)).toEqual([]);
  });

  it("tops up by the amount the admin approved, not the amount asked for", async () => {
    const t = await setup();
    const task = await t.plainTask();
    await t.pauseAndEnd(task, MEMBER);
    await t.decide(DEB, monthRequests(t)[0]!.spendRequestId, "APPROVE", { amountUsd: 12 });
    expect(topUp(t, MEMBER)).toBe(12);
  });

  it("a denied request leaves the tasks paused and listed", async () => {
    const t = await setup();
    const task = await t.plainTask();
    await t.pauseAndEnd(task, MEMBER);
    await t.decide(DEB, monthRequests(t)[0]!.spendRequestId, "DENY");
    expect(topUp(t, MEMBER)).toBe(0);
    expect(t.meta(task.taskId).budgetPause).toMatchObject({ scope: MEMBER });
    expect(pausedUnder(t, MEMBER)).toHaveLength(1);
  });

  it("an approval skips a task that was closed, or is now paused on another limit, and resumes the rest", async () => {
    const t = await setup();
    const moved = await t.plainTask();
    const kept = await t.plainTask();
    await t.pauseAndEnd(moved, MEMBER);
    await t.pauseAndEnd(kept, MEMBER);
    await t.set(moved.taskId, "SET budgetPause = :pause", { ":pause": { scope: { kind: "project", project: "payments" }, at: new Date().toISOString() } });
    const ops = t.taskOps(moved.workspaceId).length;
    await t.decide(DEB, monthRequests(t)[0]!.spendRequestId);
    expect(t.taskOps(moved.workspaceId)).toHaveLength(ops);
    expect(t.meta(moved.taskId).budgetPause).toMatchObject({ scope: { kind: "project" } });
    expect(t.meta(kept.taskId).budgetPause).toBeUndefined();
  });

  it("a 7-day-and-1-second-old request reads EXPIRED; the sweep ends it, its tasks stay paused and its paused items are cleaned up", async () => {
    const t = await setup();
    const task = await t.plainTask();
    await t.pauseAndEnd(task, MEMBER);
    const request = monthRequests(t)[0]!;
    const later = Date.parse(request.createdAt) + 7 * 86_400_000 + 1_000;
    const shown = await t.api(DEB, "GET", `/v1/app/spend-requests/${request.spendRequestId}`);
    expect(shown.body.spendRequest).toMatchObject({ status: "PENDING" });
    const deps = t.deps(() => later);
    expect(await escalateOwnerRequests(deps, { budgetMs: 5_000 })).toMatchObject({ expired: 1 });
    expect(monthRequests(t)[0]).toMatchObject({ status: "EXPIRED" });
    expect(pausedUnder(t, MEMBER)).toEqual([]);
    expect(t.meta(task.taskId).budgetPause).toMatchObject({ scope: MEMBER });
    // Its owner may ask again.
    const again = await t.api(MAYA, "POST", "/v1/app/spend-requests", { kind: "month", scope: MEMBER, amountUsd: 10, reason: "Still need it." });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
  });

  it("reads EXPIRED once its time ran out, before the sweep reaches it", async () => {
    const t = await setup();
    const task = await t.plainTask();
    await t.pauseAndEnd(task, MEMBER);
    const request = monthRequests(t)[0]!;
    const later = Date.parse(request.createdAt) + 7 * 86_400_000 + 1_000;
    const { routeSpendRequests } = await import("../../packages/broker/src/spend/requests.js");
    const read = await routeSpendRequests(t.deps(() => later), t.caller(DEB, "admin"), { method: "GET", headers: {} } as never, new URL(`https://x.test/v1/app/spend-requests/${request.spendRequestId}`)) as { spendRequest: { status: string } };
    expect(read.spendRequest.status).toBe("EXPIRED");
  });
});

describe("an agent's month (MONTH_APPROVERS)", () => {
  it("routes every scope kind: an agent's to its owner or the admins, every other to the admins", () => {
    expect(Object.keys(MONTH_APPROVERS).sort()).toEqual(["agent", "member", "org", "project", "testing"]);
  });

  it("an agent-scope request for $40 on a $30 limit goes to its owner, one for $60 to the admins", async () => {
    const t = await setup();
    const agentId = await t.budgeted(30);
    expect(await agentRequest(t, agentId, 10)).toMatchObject({ newLimitUsd: 40, approverRole: "agent_owner", approverIds: [MAYA.developerId] });
    expect(await agentRequest(t, agentId, 30)).toMatchObject({ newLimitUsd: 60, approverRole: "org_admin" });
  });

  it("with the owner's agents at $50, $20 and $20, a $15 top-up on the third goes to the admins ($105) and a $10 one to the owner ($100)", async () => {
    const t = await setup();
    await t.budgeted(50);
    await t.budgeted(20);
    const third = await t.budgeted(20);
    expect((await ownerEffectiveTotal(t.deps(), { orgId: TEST_ORG, owner: MAYA.developerId, month: month() })).totalUsd).toBe(90);
    expect(await agentRequest(t, third, 15)).toMatchObject({ approverRole: "org_admin" });
    expect(await agentRequest(t, third, 10)).toMatchObject({ approverRole: "agent_owner" });
  });

  it("counts this month's top-ups in the owner's total", async () => {
    const t = await setup();
    await t.budgeted(50);
    const second = await t.budgeted(20);
    const made = await agentRequest(t, second, 10);
    await t.decide(MAYA, made.spendRequestId);
    expect(topUp(t, { kind: "agent", agentId: second })).toBe(10);
    expect((await ownerEffectiveTotal(t.deps(), { orgId: TEST_ORG, owner: MAYA.developerId, month: month() })).totalUsd).toBe(80);
    // $80 + $25 is over the cap: the admins decide.
    expect(await agentRequest(t, second, 25)).toMatchObject({ approverRole: "org_admin" });
  });

  it("with a registered contributor (chains) holding $30 and agents at $50 and $15, a $10 agent top-up goes to the admins ($105)", async () => {
    const t = await setup();
    const chains: OwnerTotalContributor = async (_deps, { owner }) => (owner === MAYA.developerId ? 30 : 0);
    OWNER_TOTAL_CONTRIBUTORS.push(chains);
    try {
      await t.budgeted(50);
      const second = await t.budgeted(15);
      expect((await ownerEffectiveTotal(t.deps(), { orgId: TEST_ORG, owner: MAYA.developerId, month: month() })).totalUsd).toBe(95);
      expect(await agentRequest(t, second, 10)).toMatchObject({ approverRole: "org_admin" });
    } finally {
      OWNER_TOTAL_CONTRIBUTORS.splice(OWNER_TOTAL_CONTRIBUTORS.indexOf(chains), 1);
    }
  });

  it("two concurrent owner approvals of $5 top-ups that fit alone but not together: one applies, the other re-routes to the admins and applies nothing", async () => {
    const t = await setup();
    // $95 in all; a $5 top-up on either of the first two fits the $100 cap (and the $50 an agent may have), both together do not.
    const first = await t.budgeted(40);
    const second = await t.budgeted(35);
    await t.budgeted(20);
    const a = await agentRequest(t, first, 5);
    const b = await agentRequest(t, second, 5);
    expect([a.approverRole, b.approverRole]).toEqual(["agent_owner", "agent_owner"]);
    const versionBefore = version(t, MAYA.developerId);
    const results = await Promise.allSettled([t.decide(MAYA, a.spendRequestId), t.decide(MAYA, b.spendRequestId)]);
    const after = monthRequests(t);
    const approved = after.filter((record) => record.status === "APPROVED");
    const rerouted = after.filter((record) => record.status === "PENDING");
    expect(approved).toHaveLength(1);
    expect(rerouted).toHaveLength(1);
    expect(rerouted[0]).toMatchObject({ approverRole: "org_admin" });
    const appliedTo = approved[0]!.spendRequestId === a.spendRequestId ? first : second;
    const notTo = appliedTo === first ? second : first;
    expect(topUp(t, { kind: "agent", agentId: appliedTo })).toBe(5);
    expect(topUp(t, { kind: "agent", agentId: notTo })).toBe(0);
    expect(version(t, MAYA.developerId)).toBe(versionBefore + 1);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    // The owner can no longer decide the re-routed one; an admin can.
    expect(await refusal(t.decide(MAYA, rerouted[0]!.spendRequestId))).toMatchObject({ code: "FORBIDDEN" });
    await t.decide(DEB, rerouted[0]!.spendRequestId);
    expect(topUp(t, { kind: "agent", agentId: notTo })).toBe(5);
  });

  it("every change to an owner's agent budgets moves the owner counter's version (Task 28's writes)", async () => {
    const t = await setup();
    const agentId = await t.budgeted(10);
    const before = version(t, MAYA.developerId);
    expect((await t.setBudget(MAYA, agentId, { monthlyUsd: 12 })).status).toBe(200);
    expect(version(t, MAYA.developerId)).toBeGreaterThan(before);
  });

  it("re-reads the approvers live: a request routed to the owner goes to the admins once the owner's other budgets fill the cap", async () => {
    const t = await setup();
    const first = await t.budgeted(50);
    const second = await t.budgeted(40);
    const request = await agentRequest(t, second, 10);
    expect(request.approverRole).toBe("agent_owner");
    void first;
    // A third agent's $5 takes the owner to $95: with the $10 asked for, $105 is over the cap.
    await t.budgeted(5);
    expect((await spendApprovers(t.deps(), request)).role).toBe("org_admin");
    expect(await refusal(t.decide(MAYA, request.spendRequestId))).toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("the routes", () => {
  it("POST /v1/app/spend-requests: a member asks for their own month, once per month and scope; asking for someone else's is refused", async () => {
    const t = await setup();
    const asked = await t.api(MAYA, "POST", "/v1/app/spend-requests", { kind: "month", scope: MEMBER, amountUsd: 15, reason: "Big refactor this month." });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body.spendRequest).toMatchObject({ kind: "month", scope: MEMBER, amountUsd: 15, approverRole: "org_admin", requestedBy: { kind: "member", developerId: MAYA.developerId }, reason: "Big refactor this month." });
    const again = await t.api(MAYA, "POST", "/v1/app/spend-requests", { kind: "month", scope: MEMBER, amountUsd: 20, reason: "And more." });
    expect((again.body.spendRequest as { spendRequestId: string }).spendRequestId).toBe((asked.body.spendRequest as { spendRequestId: string }).spendRequestId);
    expect(monthRequests(t)).toHaveLength(1);
    expect((await t.api(CARL, "POST", "/v1/app/spend-requests", { kind: "month", scope: MEMBER, amountUsd: 15, reason: "For Maya." })).body).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect((await t.api(MAYA, "POST", "/v1/app/spend-requests", { kind: "run_limit", scope: MEMBER, amountUsd: 15, reason: "x" })).body).toMatchObject({ error: { code: "CONFIG_INVALID" } });
    expect((await t.api(MAYA, "POST", "/v1/app/spend-requests", { kind: "month", scope: MEMBER, amountUsd: -1, reason: "x" })).body).toMatchObject({ error: { code: "CONFIG_INVALID" } });
  });

  it("a project's month may be asked for by someone working in it, an agent's by someone who may use it", async () => {
    const t = await setup();
    // A project with no monthly budget has nothing to top up (R47); payments gets one first.
    expect((await t.api(CARL, "POST", "/v1/app/spend-requests", { kind: "month", scope: { kind: "project", project: "payments" }, amountUsd: 20, reason: "No limit yet." })).body).toMatchObject({ error: { code: "CONFIG_INVALID" } });
    expect((await t.api(ADA, "PUT", "/v1/app/projects/payments/ai", { monthlyBudgetUsd: 100 })).status).toBe(200);
    expect((await t.api(CARL, "POST", "/v1/app/spend-requests", { kind: "month", scope: { kind: "project", project: "payments" }, amountUsd: 20, reason: "Release month." })).status).toBe(201);
    expect((await t.api(OMAR, "POST", "/v1/app/spend-requests", { kind: "month", scope: { kind: "project", project: "payments" }, amountUsd: 20, reason: "Not mine." })).body).toMatchObject({ error: { code: "PROJECT_NOT_FOUND" } });
    const agentId = await t.budgeted(30);
    expect((await t.api(MAYA, "POST", "/v1/app/spend-requests", { kind: "month", scope: { kind: "agent", agentId }, amountUsd: 10, reason: "Busy agent." })).status).toBe(201);
    expect((await t.api(OMAR, "POST", "/v1/app/spend-requests", { kind: "month", scope: { kind: "agent", agentId }, amountUsd: 10, reason: "x" })).status).toBe(404);
  });

  it("GET ?status=PENDING lists what the caller may decide plus their own", async () => {
    const t = await setup();
    const asked = await t.api(MAYA, "POST", "/v1/app/spend-requests", { kind: "month", scope: MEMBER, amountUsd: 15, reason: "Mine." });
    const id = (asked.body.spendRequest as { spendRequestId: string }).spendRequestId;
    const ids = async (who: typeof MAYA) => ((await t.api(who, "GET", "/v1/app/spend-requests?status=PENDING")).body.spendRequests as Array<{ spendRequestId: string }>).map((entry) => entry.spendRequestId);
    expect(await ids(MAYA)).toEqual([id]);
    expect(await ids(DEB)).toEqual([id]);
    expect(await ids(CARL)).toEqual([]);
    expect((await t.api(MAYA, "GET", "/v1/app/spend-requests?status=DONE")).body).toMatchObject({ error: { code: "CONFIG_INVALID" } });
  });

  it("an id from another org is not found", async () => {
    const t = await setup();
    const asked = await t.api(MAYA, "POST", "/v1/app/spend-requests", { kind: "month", scope: MEMBER, amountUsd: 15, reason: "Mine." });
    const id = (asked.body.spendRequest as { spendRequestId: string }).spendRequestId;
    expect(await refusal(decideSpendRequest(t.deps(), t.caller(DEB, "admin", ORG_B), id, { requestId: randomUUID(), decision: "APPROVE" }))).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("contracts", () => {
  it("suggests a fifth of the limit, rounded up, never under $10", () => {
    expect(suggestedMonthTopUpUsd(29)).toBe(10);
    expect(suggestedMonthTopUpUsd(100)).toBe(20);
    expect(suggestedMonthTopUpUsd(101)).toBe(21);
  });
});
