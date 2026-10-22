// Plan 3 Task 33: monthly requests and top-ups. A task stopped by a month's budget (a member's, a project's, an agent's, the org's, a testing allowance) is
// listed under its scope (`pausedTasksKey`) and asks for a `month` top-up once per month, scope and requester. A member's, a project's, a testing allowance's
// and the org's go to the org's owners and admins; an agent's to its owner while the new limit stays within the guardrail and the owner's whole effective
// total (every budget they hold, this month's top-ups included) stays within the cap, else to the admins. The owner counter's `version` makes an owner's
// approval race-safe (R4-6). An approval adds the top-up and resumes every task paused on that scope, keeping their cap windows.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MONTH_APPROVERS, OWNER_TOTAL_CONTRIBUTORS, createSpendRequest, decideSpendRequest, escalateOwnerRequests, ownerEffectiveTotal, requestForPausedTask, routeSpendRequests, spendApprovers,
  type OwnerTotalContributor,
} from "../../packages/broker/src/spend/requests.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { effectiveLimits } from "../../packages/broker/src/spend/settings.js";
import {
  SPEND_RESUME_INSTRUCTIONS, orgSettingsKey, ownerBudgetKey, pausedTasksKey, suggestedMonthTopUpUsd, topUpKey,
  type BudgetScope, type SpendRequestRecord,
} from "@agentx/contracts";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { orgMemberKey, orgRemovedKey } from "../../packages/contracts/src/org.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { ADA, BEN, CARL, DEB, ORG_B, month, person, refusal, setup, type World } from "../support/spend-world.js";

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

  it("a 7-day-and-1-second-old request reads EXPIRED; the sweep ends it, its tasks stay paused and stay listed (fix round 1, I-2)", async () => {
    const t = await setup();
    const task = await t.plainTask();
    await t.pauseAndEnd(task, MEMBER);
    const request = monthRequests(t)[0]!;
    // A month's request also ends with its month (fix round 1, M-3), whichever is sooner.
    const later = Date.parse(request.expiresAt) + 1_000;
    expect(Date.parse(request.expiresAt)).toBeLessThanOrEqual(Date.parse(request.createdAt) + 7 * 86_400_000);
    const shown = await t.api(DEB, "GET", `/v1/app/spend-requests/${request.spendRequestId}`);
    expect(shown.body.spendRequest).toMatchObject({ status: "PENDING" });
    const deps = t.deps(() => later);
    expect(await escalateOwnerRequests(deps, { budgetMs: 5_000 })).toMatchObject({ expired: 1 });
    expect(monthRequests(t)[0]).toMatchObject({ status: "EXPIRED" });
    expect(pausedUnder(t, MEMBER).map((item) => item.sk)).toEqual([task.taskId]);
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

describe("fix round 1 (the Task 33 review)", () => {
  const openRecord = (t: World, spendRequestId: string) => monthRequests(t).find((record) => record.spendRequestId === spendRequestId)!;
  const resumeItems = (t: World) => t.db.find((item) => item.pk === "HELD_SPEND_STARTS");
  /** `deps` whose store runs `meanwhile` once, just after the first read of the owner's agents (the read that authorises an owner's approval). */
  const afterFirstOwnerRead = (t: World, meanwhile: () => Promise<unknown>) => {
    const deps = t.deps();
    const real = deps.store;
    const store = Object.create(real) as typeof real;
    let calls = 0;
    store.ownerAgents = async (orgId, owner) => {
      calls += 1;
      const found = await real.ownerAgents(orgId, owner);
      if (calls === 1) await meanwhile();
      return found;
    };
    return { ...deps, store };
  };

  it("C-1 (P1): a raise between the read that authorised the owner and the write re-routes the request; nothing applies, and the re-route is audited (M-5)", async () => {
    const t = await setup();
    const first = await t.budgeted(40);
    await t.budgeted(40);
    const request = await agentRequest(t, first, 10);
    expect(request.approverRole).toBe("agent_owner");
    const capture = capturingAuditDeps({ db: t.db });
    // The third agent's $15 fits Task 28's check ($95 with no top-ups yet), and moves the owner counter's version.
    const deps = { ...afterFirstOwnerRead(t, () => t.budgeted(15)), audit: capture.audit };
    const result = await decideSpendRequest(deps, t.caller(MAYA, "member"), request.spendRequestId, { requestId: randomUUID(), decision: "APPROVE" });
    expect(result).toMatchObject({ rerouted: true, spendRequest: { status: "PENDING", approverRole: "org_admin" } });
    expect(openRecord(t, request.spendRequestId)).toMatchObject({ status: "PENDING", approverRole: "org_admin" });
    expect(topUp(t, { kind: "agent", agentId: first })).toBe(0);
    expect(capture.flushed().filter((event) => event.action === "spend_request.rerouted").map((event) => JSON.stringify(event))).toEqual([expect.stringContaining("recounted")]);
  });

  it("M-9: an admin lowering the cap between the owner's read and the write re-routes the request", async () => {
    const t = await setup();
    const first = await t.budgeted(40);
    await t.budgeted(40);
    const request = await agentRequest(t, first, 10);
    expect(request.approverRole).toBe("agent_owner");
    const deps = afterFirstOwnerRead(t, async () => expect((await t.api(ADA, "PUT", "/v1/app/org/spend-policy", { ownerAgentBudgetCapUsd: 85 })).status).toBe(200));
    const result = await decideSpendRequest(deps, t.caller(MAYA, "member"), request.spendRequestId, { requestId: randomUUID(), decision: "APPROVE" });
    expect(result).toMatchObject({ rerouted: true, spendRequest: { status: "PENDING", approverRole: "org_admin" } });
    expect(topUp(t, { kind: "agent", agentId: first })).toBe(0);
  });

  it("I-1 (P2): Task 28's budget raise is held to the cap on the owner's effective total, this month's top-ups included", async () => {
    const t = await setup();
    const first = await t.budgeted(40);
    await t.budgeted(40);
    await t.decide(MAYA, (await agentRequest(t, first, 10)).spendRequestId);
    expect((await ownerEffectiveTotal(t.deps(), { orgId: TEST_ORG, owner: MAYA.developerId, month: month() })).totalUsd).toBe(90);
    const third = await t.agentOf();
    const raised = await t.setBudget(MAYA, third, { monthlyUsd: 15 });
    expect(raised.status, JSON.stringify(raised.body)).toBe(202);
    expect(raised.body).toMatchObject({ status: "NEEDS_ADMIN_APPROVAL" });
    expect(t.agentItem(third)!.monthlyBudgetUsd).toBeUndefined();
    // $10 still fits.
    expect((await t.setBudget(MAYA, third, { monthlyUsd: 10 })).status).toBe(200);
  });

  it("I-1: a top-up approved between the route's read and the store's write is not raced past (the counter's version is a condition)", async () => {
    const t = await setup();
    const first = await t.budgeted(40);
    await t.budgeted(40);
    const third = await t.agentOf();
    const request = await agentRequest(t, first, 10);
    // The raise reads $80; the top-up lands before it writes. $15 on top of $90 is over: it waits for an admin.
    const deps = t.deps();
    const real = deps.documentClient;
    let raced = false;
    const racing = { ...deps, documentClient: { send: async (command: { constructor: { name: string }; input: unknown }) => {
      if (!raced && command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("budget_changed")) {
        raced = true;
        await t.decide(MAYA, request.spendRequestId);
      }
      return real.send(command);
    } } };
    const store = new AgentStore({ documentClient: racing.documentClient, tableName: "state", now: Date.now });
    const { ownerBudgetRefusal } = await import("../../packages/broker/src/spend/settings.js");
    const { effectiveOwnerCap } = await import("../../packages/broker/src/spend/requests.js");
    const answer = await ownerBudgetRefusal(t.deps(), TEST_ORG, undefined, { owner: MAYA.developerId, usd: 15 }, (owner) => effectiveOwnerCap(t.deps(), TEST_ORG, owner));
    expect("ownerCap" in answer).toBe(true);
    const write = await refusal(store.setBudget(TEST_ORG, third, { monthlyUsd: 15 }, MAYA.developerId, undefined, { ownerCap: (answer as { ownerCap: never }).ownerCap }));
    expect(raced).toBe(true);
    expect(write).toMatchObject({ code: "CONFIG_INVALID" });
    expect(topUp(t, { kind: "agent", agentId: first })).toBe(10);
    expect(t.agentItem(third)!.monthlyBudgetUsd).toBeUndefined();
  });

  it("I-2 (P3): an expired request keeps the paused items, so another open request's approval still resumes the task", async () => {
    const t = await setup();
    const task = await t.plainTask();
    await t.pauseAndEnd(task, MEMBER);
    const system = monthRequests(t)[0]!;
    const created = Date.parse(system.createdAt);
    const asked = await createSpendRequest(t.deps(() => created + 3 * 86_400_000), {
      orgId: TEST_ORG, kind: "month", scope: MEMBER, subject: `MONTH#${month()}#MEMBER#${MAYA.developerId}#${MAYA.developerId}`, amountUsd: 10, newLimitUsd: 49,
      reason: "Mine.", requestedBy: { kind: "member", developerId: MAYA.developerId }, requestedFor: { developerId: MAYA.developerId },
    });
    const day7 = Math.min(created + 7 * 86_400_000, Date.parse(system.expiresAt)) + 1_000;
    await escalateOwnerRequests(t.deps(() => day7), { budgetMs: 5_000 });
    expect(openRecord(t, system.spendRequestId).status).toBe("EXPIRED");
    expect(pausedUnder(t, MEMBER).map((item) => item.sk)).toEqual([task.taskId]);
    const ops = t.taskOps(task.workspaceId).length;
    if (Date.parse(asked.record.expiresAt) > day7 + 1_000) {
      await decideSpendRequest(t.deps(() => day7 + 1_000), t.caller(DEB, "admin"), asked.record.spendRequestId, { requestId: randomUUID(), decision: "APPROVE" });
      expect(topUp(t, MEMBER)).toBe(10);
      expect(t.meta(task.taskId).budgetPause).toBeUndefined();
      expect(t.taskOps(task.workspaceId)).toHaveLength(ops + 1);
      expect(pausedUnder(t, MEMBER)).toEqual([]);
    }
  });

  it("I-2: expiry prunes only the items whose task closed or is no longer paused on the scope", async () => {
    const t = await setup();
    const kept = await t.plainTask();
    const closedTask = await t.plainTask();
    await t.pauseAndEnd(kept, MEMBER);
    await t.pauseAndEnd(closedTask, MEMBER);
    await t.set(closedTask.taskId, "SET closedAt = :at", { ":at": new Date().toISOString() });
    const request = monthRequests(t)[0]!;
    await escalateOwnerRequests(t.deps(() => Date.parse(request.expiresAt) + 1_000), { budgetMs: 5_000 });
    expect(pausedUnder(t, MEMBER).map((item) => item.sk)).toEqual([kept.taskId]);
  });

  it("I-3 (P4): an agent owner's own request for their agent's month goes to the other admins, and Deb approves", async () => {
    const t = await setup();
    const agentId = await t.budgeted(30);
    const asked = await t.api(MAYA, "POST", "/v1/app/spend-requests", { kind: "month", scope: { kind: "agent", agentId }, amountUsd: 10, reason: "Busy." });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const record = asked.body.spendRequest as SpendRequestRecord;
    expect(record).toMatchObject({ approverRole: "org_admin", requestedFor: { developerId: MAYA.developerId } });
    expect([...record.approverIds].sort()).toEqual([ADA.developerId, DEB.developerId].sort());
    expect(await refusal(t.decide(MAYA, record.spendRequestId))).toMatchObject({ code: "FORBIDDEN" });
    await t.decide(DEB, record.spendRequestId);
    expect(topUp(t, { kind: "agent", agentId })).toBe(10);
  });

  it("I-3: the org's only owner may decide their own member month (as Task 32 rules for the sole admin)", async () => {
    const t = await setup({ secondAdmin: false });
    const asked = await t.api(ADA, "POST", "/v1/app/spend-requests", { kind: "month", scope: { kind: "member", developerId: ADA.developerId }, amountUsd: 10, reason: "Mine." });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const id = (asked.body.spendRequest as { spendRequestId: string }).spendRequestId;
    await t.decide(ADA, id);
    expect(openRecord(t, id).status).toBe("APPROVED");
  });

  it("M-11: a pause's month request is for the task's starter, who may not approve it", async () => {
    const t = await setup();
    const task = await t.plainTask(DEB);
    await t.pauseAndEnd(task, { kind: "member", developerId: DEB.developerId });
    const request = monthRequests(t)[0]!;
    expect(request).toMatchObject({ requestedBy: { kind: "system" }, requestedFor: { developerId: DEB.developerId }, approverIds: [ADA.developerId] });
    expect(await refusal(t.decide(DEB, request.spendRequestId))).toMatchObject({ code: "FORBIDDEN" });
    await t.decide(ADA, request.spendRequestId);
  });

  it("I-4 (P6): the guardrail is checked on the live limit: a second $15 on a $30 agent goes to the admins, who can't approve past the guardrail", async () => {
    const t = await setup();
    const agentId = await t.budgeted(30);
    const a = await agentRequest(t, agentId, 15);
    const b = await agentRequest(t, agentId, 15);
    expect([a.approverRole, b.approverRole]).toEqual(["agent_owner", "agent_owner"]);
    await t.decide(MAYA, a.spendRequestId);
    expect(await limitOf(t, { kind: "agent", agentId })).toBe(45);
    expect((await spendApprovers(t.deps(), openRecord(t, b.spendRequestId))).role).toBe("org_admin");
    expect(await refusal(t.decide(MAYA, b.spendRequestId))).toMatchObject({ code: "FORBIDDEN" });
    expect(await refusal(t.decide(DEB, b.spendRequestId))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(openRecord(t, b.spendRequestId).status).toBe("PENDING");
    expect(topUp(t, { kind: "agent", agentId })).toBe(15);
    // $5 takes it to the guardrail exactly, which is the owner's to approve again.
    await t.decide(MAYA, b.spendRequestId, "APPROVE", { amountUsd: 5 });
    expect(await limitOf(t, { kind: "agent", agentId })).toBe(50);
  });

  it("I-5 (P7): a resume that fails is retried by the settlement run until the task goes on", async () => {
    const t = await setup();
    const one = await t.plainTask();
    const two = await t.plainTask();
    await t.pauseAndEnd(one, MEMBER);
    await t.pauseAndEnd(two, MEMBER);
    const deps = t.deps();
    const host = deps.spendRequests!;
    let failed: string | undefined;
    const patched = { ...deps, spendRequests: { ...host, resumeTask: async (input: Parameters<typeof host.resumeTask>[0]) => {
      if (failed === undefined) { failed = input.taskId; throw new Error("boom"); }
      return host.resumeTask(input);
    } } };
    const ops = new Map([one, two].map((each) => [each.taskId, t.taskOps(each.workspaceId).length]));
    await decideSpendRequest(patched, t.caller(DEB, "admin"), monthRequests(t)[0]!.spendRequestId, { requestId: randomUUID(), decision: "APPROVE" });
    const stuck = [one, two].find((each) => each.taskId === failed)!;
    const went = [one, two].find((each) => each.taskId !== failed)!;
    expect(t.taskOps(went.workspaceId)).toHaveLength(ops.get(went.taskId)! + 1);
    expect(t.taskOps(stuck.workspaceId)).toHaveLength(ops.get(stuck.taskId)!);
    expect(resumeItems(t).map((item) => item.taskId)).toEqual([stuck.taskId]);
    expect(await escalateOwnerRequests(t.deps(), { budgetMs: 5_000 })).toMatchObject({ heldStarts: 1 });
    expect(t.taskOps(stuck.workspaceId)).toHaveLength(ops.get(stuck.taskId)! + 1);
    expect(resumeItems(t)).toEqual([]);
  });

  it("M-1 (P5): a pause on a scope with no limit lists nothing and asks nothing", async () => {
    const t = await setup();
    const task = await t.plainTask();
    await t.pauseAndEnd(task, { kind: "project", project: "payments" });
    expect(monthRequests(t)).toEqual([]);
    expect(pausedUnder(t, { kind: "project", project: "payments" })).toEqual([]);
  });

  it("M-2: the resume is conditional on the pause the task was listed with", async () => {
    const t = await setup();
    const task = await t.plainTask();
    await t.pauseAndEnd(task, MEMBER);
    // The task was paused again on the same scope after it was listed, and its item still names the first pause.
    await t.set(task.taskId, "SET budgetPause = :pause", { ":pause": { scope: MEMBER, at: new Date(Date.now() + 5_000).toISOString() } });
    const ops = t.taskOps(task.workspaceId).length;
    await t.decide(DEB, monthRequests(t)[0]!.spendRequestId);
    expect(t.meta(task.taskId).budgetPause).toMatchObject({ scope: MEMBER });
    expect(t.taskOps(task.workspaceId)).toHaveLength(ops);
  });

  it("M-3: a request made on the 28th expires when its month ends; the task view finds it by the pause's month", async () => {
    const t = await setup();
    const now = new Date();
    const the28th = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 28, 12);
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const task = await t.plainTask();
    await t.set(task.taskId, "SET budgetPause = :pause", { ":pause": { scope: MEMBER, at: new Date(the28th).toISOString() } });
    const made = await requestForPausedTask(t.deps(() => the28th), task.taskId);
    expect(made).toMatchObject({ kind: "month", expiresAt: monthEnd, dueAt: monthEnd });
    expect((await t.view(MAYA, task.taskId)).paused?.spendRequestId).toBe(made!.spendRequestId);
  });

  it("M-4: the task view finds the owner's own open request for the scope it is paused on", async () => {
    const t = await setup();
    const task = await t.plainTask();
    await t.set(task.taskId, "SET budgetPause = :pause", { ":pause": { scope: MEMBER, at: new Date().toISOString() } });
    const asked = await t.api(MAYA, "POST", "/v1/app/spend-requests", { kind: "month", scope: MEMBER, amountUsd: 10, reason: "Mine." });
    expect((await t.view(MAYA, task.taskId)).paused?.spendRequestId).toBe((asked.body.spendRequest as { spendRequestId: string }).spendRequestId);
  });

  it("M-6: a task closed between the approval's read and its write is neither unpaused nor resumed", async () => {
    const t = await setup();
    const task = await t.plainTask();
    await t.pauseAndEnd(task, MEMBER);
    const deps = t.deps();
    const real = deps.documentClient;
    const closing = { ...deps, documentClient: { send: async (command: { constructor: { name: string }; input: unknown }) => {
      if (command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("REMOVE budgetPause")) {
        await t.set(task.taskId, "SET closedAt = :at", { ":at": new Date().toISOString() });
      }
      return real.send(command);
    } } };
    const ops = t.taskOps(task.workspaceId).length;
    await decideSpendRequest(closing, t.caller(DEB, "admin"), monthRequests(t)[0]!.spendRequestId, { requestId: randomUUID(), decision: "APPROVE" });
    expect(t.meta(task.taskId).budgetPause).toMatchObject({ scope: MEMBER });
    expect(t.taskOps(task.workspaceId)).toHaveLength(ops);
    expect(resumeItems(t)).toEqual([]);
  });

  it("M-7: a scope named by a merged-away id is stored as the survivor's", async () => {
    const t = await setup();
    const dup = person("9", "Maya Duplicate");
    t.db.set({ pk: `DEVELOPER#${dup.developerId}`, sk: "META", developerId: dup.developerId, provider: dup.provider, displayName: dup.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false, mergedInto: MAYA.developerId });
    const asked = await t.api(MAYA, "POST", "/v1/app/spend-requests", { kind: "month", scope: { kind: "member", developerId: dup.developerId }, amountUsd: 10, reason: "Mine." });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(monthRequests(t)[0]!.scope).toEqual(MEMBER);
  });

  it("M-8: a member's view of an org-scope request leaves out the new limit, and the no-limit refusal says nothing of the org's limit", async () => {
    const t = await setup();
    const asked = await t.api(CARL, "POST", "/v1/app/spend-requests", { kind: "month", scope: { kind: "org" }, amountUsd: 50, reason: "Busy month." });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body.spendRequest).not.toHaveProperty("newLimitUsd");
    const id = (asked.body.spendRequest as { spendRequestId: string }).spendRequestId;
    expect((await t.api(CARL, "GET", `/v1/app/spend-requests/${id}`)).body.spendRequest).not.toHaveProperty("newLimitUsd");
    expect((await t.api(DEB, "GET", `/v1/app/spend-requests/${id}`)).body.spendRequest).toHaveProperty("newLimitUsd");
    // An install without R47's placeholder limits, whose org has no monthly limit.
    t.db.set({ ...orgSettingsKey(TEST_ORG, "BUDGET"), entityType: "ORG_BUDGET", memberDefaultMonthlyUsd: 29, memberOverrides: {} });
    const legacy = { ...t.deps(), cloud: false };
    const ask = (who: typeof ADA, role: "owner" | "member") => refusal(routeSpendRequests(legacy, t.caller(who, role), { method: "POST", headers: {}, body: JSON.stringify({ requestId: randomUUID(), kind: "month", scope: { kind: "org" }, amountUsd: 5, reason: "x" }) } as never, new URL("https://x.test/v1/app/spend-requests")));
    const carl = await ask(BEN, "member");
    const ada = await ask(ADA, "owner");
    expect(carl).toMatchObject({ code: "CONFIG_INVALID" });
    expect(carl!.message).not.toMatch(/limit/);
    expect(ada!.message).toMatch(/no monthly limit/);
  });

  it("M-10: asking again with other figures answers the open request with differs: true", async () => {
    const t = await setup();
    await t.api(MAYA, "POST", "/v1/app/spend-requests", { kind: "month", scope: MEMBER, amountUsd: 15, reason: "Mine." });
    const same = await t.api(MAYA, "POST", "/v1/app/spend-requests", { kind: "month", scope: MEMBER, amountUsd: 15, reason: "Mine." });
    const other = await t.api(MAYA, "POST", "/v1/app/spend-requests", { kind: "month", scope: MEMBER, amountUsd: 20, reason: "More." });
    expect(same.status).toBe(200);
    expect(same.body).not.toHaveProperty("differs");
    expect(other.status).toBe(200);
    expect(other.body).toMatchObject({ differs: true, spendRequest: { amountUsd: 15 } });
  });
});

describe("fix round 2 (the Task 32/33 re-check)", () => {
  const effectiveOf = async (t: World, who: { developerId: string }) => (await ownerEffectiveTotal(t.deps(), { orgId: TEST_ORG, owner: who.developerId, month: month() })).totalUsd;
  const toBen = { owner: { kind: "member", developerId: BEN.developerId } };

  it("N-1 (N1): moving an agent that carries this month's top-up to an owner near the cap asks an admin; the top-up counts for the new owner", async () => {
    const t = await setup();
    await t.budgeted(45, BEN); await t.budgeted(35, BEN);
    const moving = await t.budgeted(10);
    const request = await agentRequest(t, moving, 30);
    expect(request.approverRole).toBe("agent_owner");
    await t.decide(MAYA, request.spendRequestId);
    expect(topUp(t, { kind: "agent", agentId: moving })).toBe(30);
    const moved = await t.api(ADA, "PUT", `/v1/app/agents/${moving}/owner`, toBen);
    expect(moved.status, JSON.stringify(moved.body)).toBe(202);
    expect(moved.body).toMatchObject({ status: "NEEDS_ADMIN_APPROVAL" });
    expect(t.agentItem(moving)!.owner).toEqual({ kind: "member", developerId: MAYA.developerId });
    expect(await effectiveOf(t, BEN)).toBe(80);
    // Within the cap with the top-up counted ($80 + $5 + $15 = $100, exactly the cap), the move applies.
    const small = await t.budgeted(5);
    await t.decide(MAYA, (await agentRequest(t, small, 15)).spendRequestId);
    expect((await t.api(ADA, "PUT", `/v1/app/agents/${small}/owner`, toBen)).status).toBe(200);
    expect(await effectiveOf(t, BEN)).toBe(100);
  });

  it("N-1 (N1c): the control, a move with no top-up that goes over the cap, asks an admin", async () => {
    const t = await setup();
    await t.budgeted(45, BEN); await t.budgeted(35, BEN);
    const moving = await t.budgeted(25);
    const moved = await t.api(ADA, "PUT", `/v1/app/agents/${moving}/owner`, toBen);
    expect(moved.status, JSON.stringify(moved.body)).toBe(202);
    expect(moved.body).toMatchObject({ status: "NEEDS_ADMIN_APPROVAL" });
  });

  it("N-1: unarchiving an agent brings its top-up back into its owner's total, and over the cap asks an admin", async () => {
    const t = await setup();
    const archived = await t.budgeted(10);
    await t.decide(MAYA, (await agentRequest(t, archived, 30)).spendRequestId);
    expect((await t.api(MAYA, "POST", `/v1/app/agents/${archived}/archive`, {})).status).toBe(200);
    await t.budgeted(45); await t.budgeted(35);
    expect(await effectiveOf(t, MAYA)).toBe(80);
    const back = await t.api(MAYA, "POST", `/v1/app/agents/${archived}/unarchive`, {});
    expect(back.status, JSON.stringify(back.body)).toBe(202);
    expect(back.body).toMatchObject({ status: "NEEDS_ADMIN_APPROVAL" });
    expect(t.agentItem(archived)!.status).toBe("archived");
    expect(await effectiveOf(t, MAYA)).toBe(80);
  });

  it("N-1: set_accountable on a project's agent counts its top-up for the new maintainer, and over the cap asks an admin", async () => {
    const t = await setup();
    await t.budgeted(45, BEN); await t.budgeted(35, BEN);
    t.grantRole(MAYA, "maintainer");
    const projectAgent = await t.agentOf(undefined, { owner: { kind: "project", project: "payments" }, accountable: MAYA });
    expect((await t.setBudget(MAYA, projectAgent, { monthlyUsd: 10 })).status).toBe(200);
    const request = await agentRequest(t, projectAgent, 30);
    expect(request.approverRole).toBe("agent_owner");
    await t.decide(MAYA, request.spendRequestId);
    const moved = await t.api(MAYA, "PUT", `/v1/app/agents/${projectAgent}/accountable`, { accountable: { developerId: BEN.developerId } });
    expect(moved.status, JSON.stringify(moved.body)).toBe(202);
    expect(moved.body).toMatchObject({ status: "NEEDS_ADMIN_APPROVAL" });
    expect(t.agentItem(projectAgent)!.accountable).toEqual({ developerId: MAYA.developerId });
    expect(await effectiveOf(t, BEN)).toBe(80);
  });

  const resumeItems = (t: World) => t.db.find((item) => item.pk === "HELD_SPEND_STARTS");
  /** Approves the open month request on `scope` while every resume fails, so each paused task is left with a due month resume. */
  const approveWithFailingResumes = async (t: World, scope: BudgetScope) => {
    const deps = t.deps();
    const failing = { ...deps, spendRequests: { ...deps.spendRequests!, resumeTask: async () => { throw new Error("boom"); } } };
    const request = monthRequests(t).find((record) => record.status === "PENDING" && record.scope !== undefined && scopeKeyOf(record.scope) === scopeKeyOf(scope))!;
    await decideSpendRequest(failing, t.caller(DEB, "admin"), request.spendRequestId, { requestId: randomUUID(), decision: "APPROVE" });
  };

  it("Minor 1: a month resume whose task's creator left is dropped, audited, and not tried on every sweep", async () => {
    const t = await setup();
    const CARL_SCOPE: BudgetScope = { kind: "member", developerId: CARL.developerId };
    const task = await t.plainTask(CARL);
    await t.pauseAndEnd(task, CARL_SCOPE);
    await approveWithFailingResumes(t, CARL_SCOPE);
    expect(resumeItems(t).map((item) => item.taskId)).toEqual([task.taskId]);
    await t.db.send(new DeleteCommand({ TableName: "state", Key: orgMemberKey(TEST_ORG, CARL.developerId) }));
    t.db.set({ ...orgRemovedKey(TEST_ORG, CARL.developerId), entityType: "ORG_REMOVED", removedAt: "2026-10-21T00:00:00.000Z" });
    const capture = capturingAuditDeps({ db: t.db });
    const swept = await escalateOwnerRequests({ ...t.deps(), audit: capture.audit }, { budgetMs: 5_000 });
    expect(swept).toMatchObject({ heldStarts: 0, complete: true });
    expect(resumeItems(t)).toEqual([]);
    expect(capture.recordedBy("spend_request.resume_dropped")).toEqual([
      expect.objectContaining({ actor: expect.objectContaining({ kind: "system" }), target: { kind: "task", id: task.taskId }, facts: { kind: "month", cause: "member_left" } }),
    ]);
  });

  it("Minor 1: the retries have their own small budget, so a slow list of them can't starve expiry", async () => {
    const t = await setup();
    for (let i = 0; i < 3; i += 1) await t.pauseAndEnd(await t.plainTask(), MEMBER);
    await approveWithFailingResumes(t, MEMBER);
    expect(resumeItems(t)).toHaveLength(3);
    const old = await createSpendRequest(t.deps(() => Date.now() - 6 * 86_400_000), {
      orgId: TEST_ORG, kind: "month", scope: { kind: "member", developerId: BEN.developerId }, subject: `MONTH#${month()}#MEMBER#${BEN.developerId}#${BEN.developerId}`,
      amountUsd: 10, newLimitUsd: 39, reason: "Mine.", requestedBy: { kind: "member", developerId: BEN.developerId }, requestedFor: { developerId: BEN.developerId },
    });
    let clock = Date.parse(old.record.expiresAt) + 1_000;
    const deps = t.deps(() => clock);
    // Each retry takes 2 s of a 5 s sweep.
    const slow = { ...deps, spendRequests: { ...deps.spendRequests!, resumeTask: async () => { clock += 2_000; throw new Error("still down"); } } };
    const swept = await escalateOwnerRequests(slow, { budgetMs: 5_000 });
    expect(swept).toMatchObject({ expired: 1, heldStarts: 0, complete: false });
    expect(monthRequests(t).find((record) => record.spendRequestId === old.record.spendRequestId)!.status).toBe("EXPIRED");
    expect(resumeItems(t)).toHaveLength(3);
  });
});
