import { fixtureProject } from "../support/project-ai-source.js";
import { projectMemberKey } from "@agentx/contracts";
import { fixtureActor } from "../support/money-authority.js";
// Plan 3 Task 28: budget settings. The keys and scopes the spend engine reads, what a scope's limit is once the month's top-up and the
// guardrails are counted (`effectiveLimits`), the project AI settings, the agent budget and spend-policy routes, and the one monthly
// total each person's agent budgets count against.
import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { writeGuardrails } from "../../packages/broker/src/agents/guardrails.js";
import type { ApprovalDependencies } from "../../packages/broker/src/agents/approvals.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import { ensureSynced, syncBudgets } from "../../packages/broker/src/org/budget.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import {
  budgetOwnerOf, checkOwnerBudget, effectiveLimits, effectiveMaxPerRun, planningLimit, readProjectAi, readSpendPolicy, readSpendPolicyWithRevision, writeSpendPolicy,
} from "../../packages/broker/src/spend/settings.js";
import {
  DEFAULT_MAX_AGENT_MONTHLY_USD, DEFAULT_OWNER_AGENT_BUDGET_CAP_USD, DEFAULT_PLANNING_LIMIT_USD, PER_TEST_CAP_USD, RUN_LIMIT_MULTIPLIER, TESTING_ALLOWANCE_USD,
  TRIAL_LIMITS_R49, defaultSpendPolicy, scopeKey, type BudgetScope,
} from "../../packages/contracts/src/spend.js";
import { DEFAULT_AGENT_GUARDRAILS } from "../../packages/contracts/src/agent-guardrails.js";
import type { AgentId } from "../../packages/contracts/src/agent-node.js";
import { orgMetaKey, type OrgId, type OrgRole } from "../../packages/contracts/src/org-node.js";
import {
  agentRequestKey, budgetAlertKey, modelKeyKey, openSpendRequestsKey, orgProjectCatalogKey, ownerBudgetKey, pausedTasksKey,
  projectAiKey, runCostKey, spendCounterKey, spendRequestKey, topUpKey,
} from "../../packages/contracts/src/org-scoped-keys.js";
import { DEFAULT_MEMBER_MONTHLY_BUDGET_USD, DEFAULT_ORG_MONTHLY_BUDGET_USD } from "../../packages/contracts/src/org-budget-node.js";
import { addToCounter } from "../../packages/broker/src/agents/table-writes.js";
import { OMAR, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import type { OrgResolver } from "../../packages/broker/src/org/resolve.js";

const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const person = (digit: string, name: string): Developer => ({ developerId: digit.repeat(64), name, provider: "oidc", sessionId: `s-${name.toLowerCase()}` });
const DANA = person("1", "Dana"); // org admin
const MAX = person("2", "Max"); // maintainer of web
const CARL = person("3", "Carl"); // contributor on web
const EVE = person("4", "Eve"); // a member with no role anywhere
const VIV = person("5", "Viv"); // viewer on web
const orgResolver: OrgResolver = async (subject) => (subject.developerId === OMAR.developerId ? ORG_B : TEST_ORG);

beforeAll(async () => { await loadSlackBroker(); });

describe("keys and scopes", () => {
  it("names a scope by its kind and id", () => {
    const scopes: Array<[BudgetScope, string]> = [
      [{ kind: "org" }, "ORG"],
      [{ kind: "member", developerId: "dev1" }, "MEMBER#dev1"],
      [{ kind: "project", project: "web" }, "PROJECT#web"],
      [{ kind: "agent", agentId: "agt_aaaaaaaaaaaaaaaaaaaa" }, "AGENT#agt_aaaaaaaaaaaaaaaaaaaa"],
      [{ kind: "testing", developerId: "dev1" }, "TESTING#dev1"],
    ];
    for (const [scope, key] of scopes) expect(scopeKey(scope)).toBe(key);
  });

  it("builds every spend key under the org", () => {
    const org = TEST_ORG;
    expect(projectAiKey(org, "web")).toEqual({ pk: `ORG#${org}#PROJECT_AI#web`, sk: "SETTINGS" });
    expect(topUpKey(org, "2026-10", { kind: "member", developerId: "dev1" })).toEqual({ pk: `ORG#${org}#TOPUP#2026-10`, sk: "MEMBER#dev1" });
    expect(spendCounterKey(org, "2026-10", "AGENT_USAGE#agt_x")).toEqual({ pk: `ORG#${org}#SPEND#2026-10`, sk: "AGENT_USAGE#agt_x" });
    expect(budgetAlertKey(org, "2026-10", "ORG", "WARNING")).toEqual({ pk: `ORG#${org}#BUDGET_ALERT#2026-10`, sk: "ORG#WARNING" });
    expect(modelKeyKey(org, "key1")).toEqual({ pk: `ORG#${org}#MODEL_KEY#key1`, sk: "META" });
    expect(spendRequestKey(org, "sr_1")).toEqual({ pk: `ORG#${org}#SPEND_REQUEST#sr_1`, sk: "META" });
    expect(openSpendRequestsKey(org, "2026-10-20T09:00:00.000Z", "sr_1")).toEqual({ pk: `ORG#${org}#SPEND_REQUESTS#OPEN`, sk: "2026-10-20T09:00:00.000Z#sr_1" });
    expect(pausedTasksKey(org, "pause-1", "task_1")).toEqual({ pk: `ORG#${org}#PAUSED_TASKS#pause-1`, sk: "task_1" });
    expect(runCostKey(org, "web", "agt_x", "FULL", "2026-10-20T09:00:00.000Z", "task_1")).toEqual({ pk: `ORG#${org}#RUN_COST#web#agt_x#FULL`, sk: "2026-10-20T09:00:00.000Z#task_1" });
    expect(ownerBudgetKey(org, "dev1")).toEqual({ pk: `ORG#${org}#OWNER_AGENT_BUDGET#dev1`, sk: "TOTAL" });
  });

  it("defaults the spend policy to the placeholder constants", () => {
    expect(defaultSpendPolicy()).toEqual({
      leadApprovalThresholdUsd: 10, adminApprovalThresholdUsd: 100, runLimitMultiplier: RUN_LIMIT_MULTIPLIER,
      testingAllowanceUsd: TESTING_ALLOWANCE_USD, perTestCapUsd: PER_TEST_CAP_USD, ownerAgentBudgetCapUsd: DEFAULT_OWNER_AGENT_BUDGET_CAP_USD,
    });
  });
});

const DEV1 = "dev1";
const NOW_OCTOBER = Date.parse("2026-10-15T12:00:00.000Z");
const NOW_NOVEMBER = Date.parse("2026-11-02T12:00:00.000Z");

function limitsSetup() {
  const db = new FakeDynamoDb();
  seedMembership(db, DEV1, { orgId: TEST_ORG, role: "member" });
  const access = fakeModelAccess();
  const orgs = new OrgStore({ documentClient: db, tableName: "state", now: () => NOW_OCTOBER });
  /** Developers merged into another (R2-4): the store counts a merged duplicate's agents for the survivor. */
  const merged = new Map<string, string>();
  const store = new AgentStore({ documentClient: db, tableName: "state", now: () => NOW_OCTOBER, resolveOwner: async (_orgId, developerId) => merged.get(developerId) ?? developerId });
  const deps = { documentClient: db, tableName: "state", cloud: true };
  const budgetDeps = (now: number) => ({ ...deps, access, orgs, now: () => now });
  const topUp = (month: string, scope: BudgetScope, amountUsd: number) => db.set({ ...topUpKey(TEST_ORG, month, scope), amountUsd });
  const agent = async (monthlyUsd?: number) => {
    const created = await store.create({ orgId: TEST_ORG, name: `Agent ${randomUUID().slice(0, 6)}`, owner: { kind: "member", developerId: DEV1 }, createdBy: DEV1 });
    if (monthlyUsd !== undefined) await store.setBudget(TEST_ORG, created.agentId, { monthlyUsd }, fixtureActor(store, TEST_ORG, DEV1).developerId, undefined, { ...({}), actor: fixtureActor(store, TEST_ORG, DEV1) });
    return created;
  };
  return { db, access, store, deps, budgetDeps, topUp, agent, merged };
}

describe("a top-up on the proxy's limits", () => {
  it("adds the month's top-up to a member's limit, and the proxy is told again when the month changes", async () => {
    const { db, access, budgetDeps, topUp } = limitsSetup();
    topUp("2026-10", { kind: "member", developerId: DEV1 }, 10);
    await ensureSynced(budgetDeps(NOW_OCTOBER), TEST_ORG, DEV1);
    expect(access.upsertMember).toHaveBeenLastCalledWith(TEST_ORG, DEV1, DEFAULT_MEMBER_MONTHLY_BUDGET_USD + 10);
    await ensureSynced(budgetDeps(NOW_OCTOBER), TEST_ORG, DEV1);
    expect(access.upsertMember).toHaveBeenCalledTimes(1);
    await ensureSynced(budgetDeps(NOW_NOVEMBER), TEST_ORG, DEV1);
    expect(access.upsertMember).toHaveBeenCalledTimes(2);
    expect(access.upsertMember).toHaveBeenLastCalledWith(TEST_ORG, DEV1, DEFAULT_MEMBER_MONTHLY_BUDGET_USD);
    expect(db.get({ pk: `ORG#${TEST_ORG}#SETTINGS`, sk: `BUDGET_SYNCED#${DEV1}` })).toMatchObject({ limitUsd: DEFAULT_MEMBER_MONTHLY_BUDGET_USD });
  });

  it("adds the org's top-up to the org's limit, in ensureSynced and in syncBudgets", async () => {
    const { access, budgetDeps, topUp } = limitsSetup();
    topUp("2026-10", { kind: "org" }, 100);
    await ensureSynced(budgetDeps(NOW_OCTOBER), TEST_ORG);
    expect(access.upsertOrg).toHaveBeenLastCalledWith(TEST_ORG, 600);
    topUp("2026-10", { kind: "org" }, 150);
    await syncBudgets(budgetDeps(NOW_OCTOBER), TEST_ORG, [DEV1]);
    expect(access.upsertOrg).toHaveBeenLastCalledWith(TEST_ORG, 650);
  });

  it("leaves an unset limit unset: a top-up on no limit changes nothing the proxy is told", async () => {
    const { access, db, topUp } = limitsSetup();
    topUp("2026-10", { kind: "member", developerId: DEV1 }, 10);
    await ensureSynced({ documentClient: db, tableName: "state", access, now: () => NOW_OCTOBER }, TEST_ORG, DEV1); // a private install: no limits
    expect(access.upsertMember.mock.calls[0]?.[2]).toBeGreaterThan(100_000);
    expect(access.upsertMember.mock.calls[0]?.[2]).toBe(1_000_000);
  });
});

describe("effectiveLimits", () => {
  it("is the base plus the month's top-up for the org, a member, a project and an agent", async () => {
    const { db, deps, topUp, agent } = limitsSetup();
    const one = await agent(30);
    db.set({ ...projectAiKey(TEST_ORG, "web"), entityType: "PROJECT_AI", projectPays: true, monthlyBudgetUsd: 200, revision: 1 });
    topUp("2026-10", { kind: "org" }, 25);
    topUp("2026-10", { kind: "member", developerId: DEV1 }, 10);
    topUp("2026-10", { kind: "project", project: "web" }, 50);
    topUp("2026-10", { kind: "agent", agentId: one.agentId }, 5);
    topUp("2026-09", { kind: "org" }, 999); // another month's top-up is not counted
    const scopes: BudgetScope[] = [{ kind: "org" }, { kind: "member", developerId: DEV1 }, { kind: "project", project: "web" }, { kind: "agent", agentId: one.agentId }];
    const limits = await effectiveLimits(deps, { orgId: TEST_ORG, month: "2026-10", scopes });
    expect(limits.get("ORG")).toBe(525);
    expect(limits.get(`MEMBER#${DEV1}`)).toBe(39);
    expect(limits.get("PROJECT#web")).toBe(250);
    expect(limits.get(`AGENT#${one.agentId}`)).toBe(35);
  });

  it("caps an agent at the guardrail, so a $30 base and a $40 top-up make 50", async () => {
    const { deps, topUp, agent } = limitsSetup();
    const one = await agent(30);
    topUp("2026-10", { kind: "agent", agentId: one.agentId }, 40);
    const limits = await effectiveLimits(deps, { orgId: TEST_ORG, month: "2026-10", scopes: [{ kind: "agent", agentId: one.agentId }] });
    expect(limits.get(`AGENT#${one.agentId}`)).toBe(DEFAULT_MAX_AGENT_MONTHLY_USD);
  });

  it("follows the guardrail the org set", async () => {
    const { db, deps, topUp, agent } = limitsSetup();
    const one = await agent(30);
    topUp("2026-10", { kind: "agent", agentId: one.agentId }, 40);
    const store = new AgentStore({ documentClient: db, tableName: "state", now: () => NOW_OCTOBER });
    await writeGuardrails({ ...deps, store }, TEST_ORG, { ...structuredClone(DEFAULT_AGENT_GUARDRAILS), maxAgentMonthlyUsd: 80 }, fixtureActor({ ...deps, store }, TEST_ORG, DEV1, true).developerId, { ...({ expectedRevision: 0 }), actor: fixtureActor({ ...deps, store }, TEST_ORG, DEV1, true) });
    const limits = await effectiveLimits(deps, { orgId: TEST_ORG, month: "2026-10", scopes: [{ kind: "agent", agentId: one.agentId }] });
    expect(limits.get(`AGENT#${one.agentId}`)).toBe(70);
  });

  it("is the testing allowance plus the top-up for a member's test runs", async () => {
    const { deps, topUp } = limitsSetup();
    const scope: BudgetScope = { kind: "testing", developerId: DEV1 };
    expect((await effectiveLimits(deps, { orgId: TEST_ORG, month: "2026-10", scopes: [scope] })).get(`TESTING#${DEV1}`)).toBe(TESTING_ALLOWANCE_USD);
    topUp("2026-10", scope, 5);
    expect((await effectiveLimits(deps, { orgId: TEST_ORG, month: "2026-10", scopes: [scope] })).get(`TESTING#${DEV1}`)).toBe(TESTING_ALLOWANCE_USD + 5);
  });

  it("uses the allowance the org's spend policy sets", async () => {
    const { deps } = limitsSetup();
    await writeSpendPolicy(deps, TEST_ORG, { ...defaultSpendPolicy(), testingAllowanceUsd: 25 }, fixtureActor(deps, TEST_ORG, DEV1).developerId, { ...({}), actor: fixtureActor(deps, TEST_ORG, DEV1) });
    expect((await effectiveLimits(deps, { orgId: TEST_ORG, month: "2026-10", scopes: [{ kind: "testing", developerId: DEV1 }] })).get(`TESTING#${DEV1}`)).toBe(25);
  });

  it("leaves a limit that was never set unset, a top-up or not (R47)", async () => {
    const { db, topUp, agent } = limitsSetup();
    const none = await agent();
    topUp("2026-10", { kind: "agent", agentId: none.agentId }, 40);
    topUp("2026-10", { kind: "project", project: "web" }, 40);
    topUp("2026-10", { kind: "org" }, 40);
    const privateInstall = { documentClient: db, tableName: "state" };
    const limits = await effectiveLimits(privateInstall, {
      orgId: TEST_ORG, month: "2026-10",
      scopes: [{ kind: "org" }, { kind: "member", developerId: DEV1 }, { kind: "project", project: "web" }, { kind: "agent", agentId: none.agentId }],
    });
    for (const key of ["ORG", `MEMBER#${DEV1}`, "PROJECT#web", `AGENT#${none.agentId}`]) {
      expect(limits.has(key), key).toBe(true);
      expect(limits.get(key), key).toBeUndefined();
    }
  });

  it("reads a built-in's budget from the org's settings for it", async () => {
    const { deps, store } = limitsSetup();
    await store.setBudget(TEST_ORG, "ticket-triage", { monthlyUsd: 12 }, fixtureActor(store, TEST_ORG, DEV1).developerId, undefined, { ...({}), actor: fixtureActor(store, TEST_ORG, DEV1) });
    const limits = await effectiveLimits(deps, { orgId: TEST_ORG, month: "2026-10", scopes: [{ kind: "agent", agentId: "ticket-triage" }] });
    expect(limits.get("AGENT#ticket-triage")).toBe(12);
  });
});

describe("a run's own limit and a project's planning limit", () => {
  it("has no per-run cap when the agent sets none, and the guardrail ceiling never raises one", async () => {
    const { store, agent } = limitsSetup();
    const none = await agent();
    expect(effectiveMaxPerRun((await store.get(TEST_ORG, none.agentId))!, DEFAULT_AGENT_GUARDRAILS)).toBeUndefined();
    await store.setBudget(TEST_ORG, none.agentId, { maxPerRunUsd: 20 }, fixtureActor(store, TEST_ORG, DEV1).developerId, undefined, { ...({}), actor: fixtureActor(store, TEST_ORG, DEV1) });
    expect(effectiveMaxPerRun((await store.get(TEST_ORG, none.agentId))!, DEFAULT_AGENT_GUARDRAILS)).toBe(20);
    expect(effectiveMaxPerRun((await store.get(TEST_ORG, none.agentId))!, { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 15 })).toBe(15);
  });

  it("reads a built-in's per-run cap from its settings", async () => {
    const { store } = limitsSetup();
    await store.setBudget(TEST_ORG, "ticket-triage", { maxPerRunUsd: 7 }, fixtureActor(store, TEST_ORG, DEV1).developerId, undefined, { ...({}), actor: fixtureActor(store, TEST_ORG, DEV1) });
    expect(effectiveMaxPerRun((await store.getBuiltinSettings(TEST_ORG, "ticket-triage"))!, DEFAULT_AGENT_GUARDRAILS)).toBe(7);
  });

  it("is the project's own planning limit, else the default", () => {
    expect(planningLimit({ projectPays: false, planningLimitUsd: { QUICK: 4 } }, "QUICK")).toBe(4);
    expect(planningLimit({ projectPays: false, planningLimitUsd: { QUICK: 4 } }, "FULL")).toBe(DEFAULT_PLANNING_LIMIT_USD.FULL);
    expect(planningLimit({ projectPays: false }, "QUICK")).toBe(DEFAULT_PLANNING_LIMIT_USD.QUICK);
  });

  it("reads a project with no AI settings as the defaults", async () => {
    const { deps } = limitsSetup();
    expect(await readProjectAi(deps, TEST_ORG, "web")).toEqual({ projectPays: false });
  });
});

describe("who an agent budget counts for", () => {
  const record = (fields: Record<string, unknown>) => ({ agentId: "agt_aaaaaaaaaaaaaaaaaaaa", status: "active", ...fields }) as never;
  it("is the member owner, else the accountable maintainer, else no one", () => {
    expect(budgetOwnerOf(record({ owner: { kind: "member", developerId: "a" } }))).toBe("a");
    expect(budgetOwnerOf(record({ owner: { kind: "project", project: "web" }, accountable: { developerId: "m" } }))).toBe("m");
    expect(budgetOwnerOf({ pinnedVersion: 1, accountable: { developerId: "admin" }, updatedBy: "x", updatedAt: "y" })).toBe("admin");
    expect(budgetOwnerOf({ pinnedVersion: 1, updatedBy: "x", updatedAt: "y" })).toBeUndefined();
  });
});

describe("the spend policy", () => {
  it("reads as the defaults until it is written, then as written", async () => {
    const { deps } = limitsSetup();
    expect(await readSpendPolicy(deps, TEST_ORG)).toEqual(defaultSpendPolicy());
    await writeSpendPolicy(deps, TEST_ORG, { ...defaultSpendPolicy(), ownerAgentBudgetCapUsd: 150 }, fixtureActor(deps, TEST_ORG, DEV1).developerId, { ...({}), actor: fixtureActor(deps, TEST_ORG, DEV1) });
    expect((await readSpendPolicy(deps, TEST_ORG)).ownerAgentBudgetCapUsd).toBe(150);
  });
});

// ---- one total per owner

/** What a write that the cap held back says; a stale read says something else. */
/** `expect.stringContaining` typed as the string a matcher object expects. */
const containing = (text: string): string => expect.stringContaining(text) as string;
const OVER_CAP_TEXT = "past the limit for one person";
const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

function ownerSetup() {
  const base = limitsSetup();
  const ownerAgents = async (...budgets: number[]) => {
    const made: AgentId[] = [];
    for (const [index, monthlyUsd] of budgets.entries()) {
      const created = await base.store.create({ orgId: TEST_ORG, name: `A${String(index)}-${randomUUID().slice(0, 6)}`, owner: { kind: "member", developerId: ALICE }, createdBy: ALICE });
      await base.store.setBudget(TEST_ORG, created.agentId, { monthlyUsd }, fixtureActor(base.store, TEST_ORG, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(base.store, TEST_ORG, ALICE) });
      made.push(created.agentId);
    }
    return made;
  };
  const totalOf = (owner: string) => (base.db.get(ownerBudgetKey(TEST_ORG, owner)) as { totalUsd?: number } | undefined)?.totalUsd ?? 0;
  /** The cap and the policy revision a write is held to, as the route reads them. */
  const capOf = async () => { const { policy, revision } = await readSpendPolicyWithRevision(base.deps, TEST_ORG); return { usd: policy.ownerAgentBudgetCapUsd, policyRevision: revision }; };
  /** A raise as the route makes it: checked, then written with the cap that was read, so the write holds the check too. */
  const raise = async (agentId: AgentId, monthlyUsd: number) => {
    const before = (await base.store.get(TEST_ORG, agentId))!;
    const check = await checkOwnerBudget(base.deps, { orgId: TEST_ORG, owner: ALICE, deltaUsd: monthlyUsd - (before.monthlyBudgetUsd ?? 0) });
    if (!check.ok) return check;
    await base.store.setBudget(TEST_ORG, agentId, { monthlyUsd }, fixtureActor(base.store, TEST_ORG, ALICE).developerId, undefined, { ...({ ownerCap: await capOf() }), actor: fixtureActor(base.store, TEST_ORG, ALICE) });
    return check;
  };
  return { ...base, ownerAgents, totalOf, raise, capOf };
}

describe("the one monthly total of a person's agent budgets", () => {
  it("adds up the budgets of every agent a person owns, as each is set, changed or cleared", async () => {
    const { store, ownerAgents, totalOf } = ownerSetup();
    const [first, second] = await ownerAgents(30, 40);
    expect(totalOf(ALICE)).toBe(70);
    await store.setBudget(TEST_ORG, first!, { monthlyUsd: 10 }, fixtureActor(store, TEST_ORG, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(store, TEST_ORG, ALICE) });
    expect(totalOf(ALICE)).toBe(50);
    await store.setBudget(TEST_ORG, second!, { monthlyUsd: null }, fixtureActor(store, TEST_ORG, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(store, TEST_ORG, ALICE) });
    expect(totalOf(ALICE)).toBe(10);
    await store.setBudget(TEST_ORG, second!, { maxPerRunUsd: 5 }, fixtureActor(store, TEST_ORG, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(store, TEST_ORG, ALICE) }); // a per-run cap is not a monthly budget
    expect(totalOf(ALICE)).toBe(10);
  });

  it("lets a third agent of $25 through when the others have $30 and $40 (a total of $95)", async () => {
    const base = ownerSetup();
    const { ownerAgents, raise, totalOf } = base;
    await ownerAgents(30, 40);
    const third = await base.store.create({ orgId: TEST_ORG, name: "Third", owner: { kind: "member", developerId: ALICE }, createdBy: ALICE });
    const check = await raise(third.agentId, 25);
    expect(check).toMatchObject({ ok: true, totalUsd: 70, wouldBeUsd: 95, capUsd: DEFAULT_OWNER_AGENT_BUDGET_CAP_USD });
    expect(totalOf(ALICE)).toBe(95);
  });

  it("passes a change that lowers the total, and one that lands exactly on the cap", async () => {
    const { ownerAgents, raise, totalOf, store } = ownerSetup();
    const [first, second] = await ownerAgents(50, 50);
    expect(totalOf(ALICE)).toBe(100);
    expect(await raise(first!, 45)).toMatchObject({ ok: true });
    expect(totalOf(ALICE)).toBe(95);
    expect(await raise(first!, 50)).toMatchObject({ ok: true, wouldBeUsd: 100 }); // exactly on the cap
    expect(totalOf(ALICE)).toBe(100);
    expect(await raise(second!, 50)).toMatchObject({ ok: true }); // no change at all
    expect((await store.get(TEST_ORG, second!))?.monthlyBudgetUsd).toBe(50);
  });

  it("refuses a raise past the cap in the check, and in the write when the check was skipped", async () => {
    const { ownerAgents, raise, totalOf, store, deps, capOf } = ownerSetup();
    const [first] = await ownerAgents(50, 45);
    expect(await raise(first!, 56)).toMatchObject({ ok: false, totalUsd: 95, wouldBeUsd: 101, capUsd: 100 });
    expect((await store.get(TEST_ORG, first!))?.monthlyBudgetUsd).toBe(50);
    // The check was passed over (or the total moved since): the write itself holds the cap.
    await expect(store.setBudget(TEST_ORG, first!, { monthlyUsd: 56 }, fixtureActor(store, TEST_ORG, ALICE).developerId, undefined, { ...({ ownerCap: await capOf() }), actor: fixtureActor(store, TEST_ORG, ALICE) })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: containing(OVER_CAP_TEXT) });
    expect((await store.get(TEST_ORG, first!))?.monthlyBudgetUsd).toBe(50);
    expect(totalOf(ALICE)).toBe(95);
    expect(await checkOwnerBudget(deps, { orgId: TEST_ORG, owner: ALICE, deltaUsd: 5 })).toMatchObject({ ok: true });
  });

  it("lets an admin's higher cap through, and leaves existing budgets alone when the cap is lowered", async () => {
    const { ownerAgents, raise, totalOf, deps } = ownerSetup();
    const [first] = await ownerAgents(50, 50);
    expect(await raise(first!, 60)).toMatchObject({ ok: false });
    await writeSpendPolicy(deps, TEST_ORG, { ...defaultSpendPolicy(), ownerAgentBudgetCapUsd: 150 }, fixtureActor(deps, TEST_ORG, DANA.developerId).developerId, { ...({}), actor: fixtureActor(deps, TEST_ORG, DANA.developerId) });
    expect(await raise(first!, 60)).toMatchObject({ ok: true, capUsd: 150 });
    expect(totalOf(ALICE)).toBe(110);
    await writeSpendPolicy(deps, TEST_ORG, { ...defaultSpendPolicy(), ownerAgentBudgetCapUsd: 20 }, fixtureActor(deps, TEST_ORG, DANA.developerId).developerId, { ...({}), actor: fixtureActor(deps, TEST_ORG, DANA.developerId) });
    expect(totalOf(ALICE)).toBe(110); // nothing was changed by lowering the cap
    expect(await raise(first!, 61)).toMatchObject({ ok: false });
    expect(await raise(first!, 40)).toMatchObject({ ok: true }); // lowering still passes, though the total is over the cap
    expect(totalOf(ALICE)).toBe(90);
  });

  it("does not count an archived agent, and counts it again when it is unarchived", async () => {
    const { ownerAgents, totalOf, store } = ownerSetup();
    const [first, second] = await ownerAgents(30, 40);
    await store.archive(TEST_ORG, first!, ALICE);
    expect(totalOf(ALICE)).toBe(40);
    await store.setBudget(TEST_ORG, first!, { monthlyUsd: 90 }, fixtureActor(store, TEST_ORG, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(store, TEST_ORG, ALICE) }); // raised while archived: counts for no one
    expect(totalOf(ALICE)).toBe(40);
    await store.unarchive(TEST_ORG, first!, ALICE);
    expect(totalOf(ALICE)).toBe(130);
    await store.archive(TEST_ORG, second!, ALICE);
    await store.archive(TEST_ORG, second!, ALICE); // already archived: nothing is taken off twice
    expect(totalOf(ALICE)).toBe(90);
  });

  it("refuses an unarchive that would take the owner past the cap, and leaves the agent archived", async () => {
    const { ownerAgents, totalOf, store, capOf } = ownerSetup();
    const [first] = await ownerAgents(60, 30);
    await store.archive(TEST_ORG, first!, ALICE);
    await ownerAgents(50);
    expect(totalOf(ALICE)).toBe(80);
    await expect(store.unarchive(TEST_ORG, first!, ALICE, undefined, { ownerCap: await capOf() })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: containing(OVER_CAP_TEXT) });
    expect((await store.get(TEST_ORG, first!))?.status).toBe("archived");
    expect(totalOf(ALICE)).toBe(80);
  });

  it("lets only one of two raises through that together pass the cap", async () => {
    const { ownerAgents, totalOf, store, capOf } = ownerSetup();
    const [first, second] = await ownerAgents(45, 45);
    const cap = await capOf();
    // Each raise alone lands on $100 or less; together they would make $110.
    const results = await Promise.allSettled([
      store.setBudget(TEST_ORG, first!, { monthlyUsd: 55 }, fixtureActor(store, TEST_ORG, ALICE).developerId, undefined, { ...({ ownerCap: cap }), actor: fixtureActor(store, TEST_ORG, ALICE) }),
      store.setBudget(TEST_ORG, second!, { monthlyUsd: 55 }, fixtureActor(store, TEST_ORG, ALICE).developerId, undefined, { ...({ ownerCap: cap }), actor: fixtureActor(store, TEST_ORG, ALICE) }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: "CONFIG_INVALID", message: containing(OVER_CAP_TEXT) });
    expect(totalOf(ALICE)).toBe(100);
    expect([(await store.get(TEST_ORG, first!))?.monthlyBudgetUsd, (await store.get(TEST_ORG, second!))?.monthlyBudgetUsd].sort()).toEqual([45, 55]);
  });

  it("moves an agent's budget to the new owner's total, and holds the new owner to the cap", async () => {
    const { ownerAgents, totalOf, store, capOf } = ownerSetup();
    const [small, big] = await ownerAgents(30, 80);
    await store.setOwner(TEST_ORG, small!, { kind: "member", developerId: BOB }, ALICE, undefined, undefined, { actor: fixtureActor(store, TEST_ORG, ALICE) });
    expect(totalOf(ALICE)).toBe(80);
    expect(totalOf(BOB)).toBe(30);
    const bobs = await store.create({ orgId: TEST_ORG, name: "Bob's own", owner: { kind: "member", developerId: BOB }, createdBy: BOB });
    await store.setBudget(TEST_ORG, bobs.agentId, { monthlyUsd: 60 }, fixtureActor(store, TEST_ORG, BOB).developerId, undefined, { ...({}), actor: fixtureActor(store, TEST_ORG, BOB) });
    expect(totalOf(BOB)).toBe(90);
    // Alice's $80 agent would take Bob to $170: it stays Alice's, and both totals stay as they were.
    await expect(store.setOwner(TEST_ORG, big!, { kind: "member", developerId: BOB }, ALICE, undefined, undefined, { ownerCap: await capOf(), actor: fixtureActor(store, TEST_ORG, ALICE) })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: containing(OVER_CAP_TEXT) });
    expect((await store.get(TEST_ORG, big!))?.owner).toEqual({ kind: "member", developerId: ALICE });
    expect(totalOf(ALICE)).toBe(80);
    expect(totalOf(BOB)).toBe(90);
    // Bob's $30 agent can go back to Alice (80 + 30 = 110 is over, so only without the cap, as Rovara's own moves are made).
    await store.setOwner(TEST_ORG, small!, { kind: "member", developerId: ALICE }, BOB, undefined, undefined, { actor: fixtureActor(store, TEST_ORG, BOB) });
    expect(totalOf(ALICE)).toBe(110);
    expect(totalOf(BOB)).toBe(60);
  });

  it("counts a project's agent for its accountable maintainer, and moves it when the maintainer changes", async () => {
    const { totalOf, store, capOf } = ownerSetup();
    const project = await store.create({ orgId: TEST_ORG, name: "Project agent", owner: { kind: "project", project: "web" }, accountable: { developerId: ALICE }, createdBy: ALICE });
    await store.setBudget(TEST_ORG, project.agentId, { monthlyUsd: 35 }, fixtureActor(store, TEST_ORG, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(store, TEST_ORG, ALICE) });
    expect(totalOf(ALICE)).toBe(35);
    await store.setAccountable(TEST_ORG, project.agentId, { developerId: BOB }, ALICE, undefined, { ...({ ownerCap: await capOf() }), actor: fixtureActor(store, TEST_ORG, ALICE) });
    expect(totalOf(ALICE)).toBe(0);
    expect(totalOf(BOB)).toBe(35);
    // A member-owned agent moved to the project counts for the maintainer who is accountable for it.
    const member = await store.create({ orgId: TEST_ORG, name: "Member agent", owner: { kind: "member", developerId: ALICE }, createdBy: ALICE });
    await store.setBudget(TEST_ORG, member.agentId, { monthlyUsd: 20 }, fixtureActor(store, TEST_ORG, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(store, TEST_ORG, ALICE) });
    await store.setOwner(TEST_ORG, member.agentId, { kind: "project", project: "web" }, ALICE, { developerId: BOB }, undefined, { actor: fixtureActor(store, TEST_ORG, ALICE) });
    expect(totalOf(ALICE)).toBe(0);
    expect(totalOf(BOB)).toBe(55);
  });

  it("counts a built-in's budget for its accountable person, and for no one while it has none", async () => {
    const { totalOf, store, capOf } = ownerSetup();
    await store.setBudget(TEST_ORG, "ticket-triage", { monthlyUsd: 15 }, fixtureActor(store, TEST_ORG, DANA.developerId).developerId, undefined, { ...({}), actor: fixtureActor(store, TEST_ORG, DANA.developerId) });
    expect(totalOf(DANA.developerId)).toBe(0);
    await store.setAccountable(TEST_ORG, "ticket-triage", { developerId: DANA.developerId }, DANA.developerId);
    expect(totalOf(DANA.developerId)).toBe(15);
    await store.setBudget(TEST_ORG, "ticket-triage", { monthlyUsd: 25 }, fixtureActor(store, TEST_ORG, DANA.developerId).developerId, undefined, { ...({ ownerCap: await capOf() }), actor: fixtureActor(store, TEST_ORG, DANA.developerId) });
    expect(totalOf(DANA.developerId)).toBe(25);
    await store.setAccountable(TEST_ORG, "ticket-triage", { developerId: BOB }, DANA.developerId);
    expect(totalOf(DANA.developerId)).toBe(0);
    expect(totalOf(BOB)).toBe(25);
  });

  it("writes the request's own item in the same transaction as the budget and the total", async () => {
    const { ownerAgents, store, db, totalOf } = ownerSetup();
    const [first] = await ownerAgents(10);
    const request = { orgId: TEST_ORG, developerId: ALICE, requestId: randomUUID(), fingerprint: "budget" };
    seedMembership(db, ALICE);
    const options = { actor: { developerId: ALICE, role: "member" as const } };
    await expect(store.setBudget(TEST_ORG, first!, { monthlyUsd: 20 }, ALICE, request)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(totalOf(ALICE)).toBe(10);
    expect(db.get(agentRequestKey(TEST_ORG, ALICE, request.requestId))).toBeUndefined();
    await store.setBudget(TEST_ORG, first!, { monthlyUsd: 20 }, ALICE, request, options);
    expect(db.get(agentRequestKey(TEST_ORG, ALICE, request.requestId))).toMatchObject({ fingerprint: "budget" });
    expect(totalOf(ALICE)).toBe(20);
    // The same request id again is refused whole: nothing about the budget or the total changes.
    await expect(store.setBudget(TEST_ORG, first!, { monthlyUsd: 30 }, ALICE, { ...request, fingerprint: "other" }, options)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(totalOf(ALICE)).toBe(20);
  });
});

// ---- the routes

type Reply = { status: number; body: Record<string, unknown> };
const errorOf = (reply: Reply) => reply.body.error as { code: string; message: string };
const SAFE_OVERLAY = { instructions: "Summarise the open tickets.", sequence: [{ id: "work", name: "work", kind: "agent" as const, workspace: "none" as const }] };

async function routeSetup(options: { orgSourceOrder?: string[]; trial?: boolean } = {}) {
  const members = new FakeProjectMembers();
  const h = await createDeveloperTaskBroker({
    orgResolver, register: false,
    brokerExtra: { agents: { projectMembers: members, ...(options.orgSourceOrder === undefined ? {} : { orgSourceOrder: async () => options.orgSourceOrder! }) } },
  });
  const enroll = async (who: Developer, role: OrgRole) => {
    h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    await h.orgOf(who);
    seedMembership(h.db, who.developerId, { orgId: TEST_ORG, role });
  };
  await enroll(DANA, "admin");
  for (const who of [MAX, CARL, EVE, VIV]) await enroll(who, "member");
  if (options.trial === true) h.db.set({ ...orgMetaKey(TEST_ORG), entityType: "ORG", orgId: TEST_ORG, name: "test", createdAt: new Date().toISOString(), createdBy: "system", plan: "trial" });
  members.grant(TEST_ORG, "web", MAX.developerId, "maintainer");
  h.db.set({ ...projectMemberKey(TEST_ORG, MAX.developerId, "web"), entityType: "MEMBERSHIP", ownerKey: MAX.developerId, projectName: "web", grantId: randomUUID(), role: "developer", projectRole: "maintainer" });
  members.grant(TEST_ORG, "web", CARL.developerId, "contributor");
  h.db.set({ ...projectMemberKey(TEST_ORG, CARL.developerId, "web"), entityType: "MEMBERSHIP", ownerKey: CARL.developerId, projectName: "web", grantId: randomUUID(), role: "developer", projectRole: "contributor" });
  members.grant(TEST_ORG, "web", VIV.developerId, "viewer");
  h.db.set({ ...projectMemberKey(TEST_ORG, VIV.developerId, "web"), entityType: "MEMBERSHIP", ownerKey: VIV.developerId, projectName: "web", grantId: randomUUID(), role: "developer", projectRole: "viewer" });
  h.db.set({ ...orgProjectCatalogKey(TEST_ORG, "web"), entityType: "PROJECT_CATALOG", name: "web" });
  fixtureProject(h.db, TEST_ORG, "web");
  const store = new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now });
  const deps: ApprovalDependencies = {
    store, projectMembers: members, documentClient: h.db, tableName: "state", now: Date.now, confirmOrigin: "https://cell.example.com",
    signInStore: new DeveloperSignInStore({ documentClient: h.db, tableName: "signin", now: Date.now }),
  };
  const call = async (who: Developer, method: string, path: string, body?: Record<string, unknown>, requestId: string = randomUUID()): Promise<Reply> => {
    const reply = await h.dev(who, method, path, body === undefined ? undefined : { requestId, ...body });
    const { requestId: _requestId, ...rest } = reply.body; // eslint-disable-line @typescript-eslint/no-unused-vars -- the envelope's id is not part of an answer
    return { status: reply.status, body: rest };
  };
  const create = async (who: Developer, name = `Agent ${randomUUID().slice(0, 8)}`): Promise<AgentId> => {
    const created = await call(who, "POST", "/v1/app/agents", { name, overlay: SAFE_OVERLAY });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return (created.body.agent as { agentId: AgentId }).agentId;
  };
  const totalOf = (owner: string) => (h.db.get(ownerBudgetKey(TEST_ORG, owner)) as { totalUsd?: number } | undefined)?.totalUsd ?? 0;
  const putBudget = (who: Developer, agentId: string, body: Record<string, unknown>, requestId?: string) => call(who, "PUT", `/v1/app/agents/${agentId}/budget`, body, requestId);
  return { ...h, members, store, deps, call, create, totalOf, putBudget };
}

describe("a project's AI settings", () => {
  it("can be read by anyone with a role on the project, and changed only by an org owner or admin", async () => {
    const { call } = await routeSetup();
    const initial = await call(VIV, "GET", "/v1/app/projects/web/ai");
    expect(initial.status, JSON.stringify(initial.body)).toBe(200);
    expect(initial.body).toMatchObject({ settings: { projectPays: false }, revision: 0, effective: { planningLimitUsd: { QUICK: 2, FULL: 6 } } });
    const refused = await call(MAX, "PUT", "/v1/app/projects/web/ai", { projectPays: true });
    expect(refused.status).toBe(403);
    expect(errorOf(refused).code).toBe("FORBIDDEN");
    const saved = await call(DANA, "PUT", "/v1/app/projects/web/ai", { monthlyBudgetUsd: 200, projectPays: true });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ settings: { monthlyBudgetUsd: 200, projectPays: true }, revision: 1 });
    expect((await call(MAX, "GET", "/v1/app/projects/web/ai")).body).toMatchObject({ settings: { monthlyBudgetUsd: 200, projectPays: true }, revision: 1 });
  });

  describe("what a member may accept as a run limit when the project pays (owner decision 3, option E)", () => {
    it("defaults to $10, and a maintainer, an org admin or an owner may change it, anyone else may not", async () => {
      const { call } = await routeSetup();
      expect((await call(VIV, "GET", "/v1/app/projects/web/ai")).body).toMatchObject({ settings: { projectPays: false }, effective: { memberAcceptRunLimitUpToUsd: 10 } });
      const byMaintainer = await call(MAX, "PUT", "/v1/app/projects/web/ai", { memberAcceptRunLimitUpToUsd: 25 });
      expect(byMaintainer.status, JSON.stringify(byMaintainer.body)).toBe(200);
      expect(byMaintainer.body).toMatchObject({ settings: { memberAcceptRunLimitUpToUsd: 25 }, effective: { memberAcceptRunLimitUpToUsd: 25 }, revision: 1 });
      expect((await call(DANA, "PUT", "/v1/app/projects/web/ai", { memberAcceptRunLimitUpToUsd: 40 })).status).toBe(200);
      for (const who of [CARL, VIV]) {
        const refused = await call(who, "PUT", "/v1/app/projects/web/ai", { memberAcceptRunLimitUpToUsd: 5 });
        expect(refused.status, who.name).toBe(403);
        expect(errorOf(refused).code).toBe("FORBIDDEN");
      }
      expect(errorOf(await call(EVE, "PUT", "/v1/app/projects/web/ai", { memberAcceptRunLimitUpToUsd: 5 })).code).toBe("PROJECT_NOT_FOUND");
      expect((await call(VIV, "GET", "/v1/app/projects/web/ai")).body).toMatchObject({ settings: { memberAcceptRunLimitUpToUsd: 40 } });
    });

    it("lets a maintainer change this setting and nothing else", async () => {
      const { call } = await routeSetup();
      const mixed = await call(MAX, "PUT", "/v1/app/projects/web/ai", { memberAcceptRunLimitUpToUsd: 25, projectPays: true });
      expect(mixed.status, JSON.stringify(mixed.body)).toBe(403);
      expect((await call(MAX, "PUT", "/v1/app/projects/web/ai", { monthlyBudgetUsd: 5 })).status).toBe(403);
      expect((await call(VIV, "GET", "/v1/app/projects/web/ai")).body).toMatchObject({ revision: 0 });
    });

    it("holds it from 0 to the admin threshold in a strict schema, and null puts the default back", async () => {
      const { call } = await routeSetup();
      expect((await call(DANA, "PUT", "/v1/app/projects/web/ai", { memberAcceptRunLimitUpToUsd: 0 })).status).toBe(200);
      // DELIBERATE TEST CHANGE (fix wave re-check N-1): 1000 used to be accepted; the setting is now capped at the org's admin threshold ($100 by default).
      expect((await call(DANA, "PUT", "/v1/app/projects/web/ai", { memberAcceptRunLimitUpToUsd: 100 })).status).toBe(200);
      for (const bad of [-1, 1000.01, "10"]) {
        const refused = await call(DANA, "PUT", "/v1/app/projects/web/ai", { memberAcceptRunLimitUpToUsd: bad });
        expect(refused.status, String(bad)).toBe(400);
      }
      expect((await call(DANA, "PUT", "/v1/app/projects/web/ai", { memberAcceptRunLimitUpTo: 5 })).status).toBe(400);
      const cleared = await call(DANA, "PUT", "/v1/app/projects/web/ai", { memberAcceptRunLimitUpToUsd: null });
      expect(cleared.body).toMatchObject({ effective: { memberAcceptRunLimitUpToUsd: 10 } });
      expect((cleared.body.settings as Record<string, unknown>).memberAcceptRunLimitUpToUsd).toBeUndefined();
    });

    it("refuses a setting above the org's admin threshold, from a maintainer and from an admin, in words that say why, and writes nothing", async () => {
      const { call } = await routeSetup();
      for (const who of [MAX, DANA]) {
        const refused = await call(who, "PUT", "/v1/app/projects/web/ai", { memberAcceptRunLimitUpToUsd: 100.01 });
        expect(refused.status, who.name).toBe(400);
        expect(errorOf(refused)).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("can't be more than $100, the amount above which your company needs an org admin's approval") as string });
      }
      expect((await call(VIV, "GET", "/v1/app/projects/web/ai")).body).toMatchObject({ revision: 0 });
      expect((await call(MAX, "PUT", "/v1/app/projects/web/ai", { memberAcceptRunLimitUpToUsd: 100 })).status).toBe(200);
      // The limit is the org's admin threshold now: lowered, it is the lower amount, and raised, the higher.
      expect((await call(DANA, "PUT", "/v1/app/org/spend-policy", { leadApprovalThresholdUsd: 20, adminApprovalThresholdUsd: 30 })).status).toBe(200);
      const lowered = await call(MAX, "PUT", "/v1/app/projects/web/ai", { memberAcceptRunLimitUpToUsd: 31 });
      expect(lowered.status).toBe(400);
      expect(errorOf(lowered).message).toContain("can't be more than $30");
      expect((await call(MAX, "PUT", "/v1/app/projects/web/ai", { memberAcceptRunLimitUpToUsd: 30 })).status).toBe(200);
      expect((await call(DANA, "PUT", "/v1/app/org/spend-policy", { adminApprovalThresholdUsd: 500 })).status).toBe(200);
      expect((await call(MAX, "PUT", "/v1/app/projects/web/ai", { memberAcceptRunLimitUpToUsd: 500 })).status).toBe(200);
    });

    it("shows what a member can accept now: the setting or the lead threshold, never above the admin threshold", async () => {
      const { call } = await routeSetup();
      const accepts = async () => ((await call(VIV, "GET", "/v1/app/projects/web/ai")).body.effective as { memberAcceptRunLimitUpToUsd: number }).memberAcceptRunLimitUpToUsd;
      expect(await accepts()).toBe(10);
      // Minor 4: the default follows the org's lead threshold.
      expect((await call(DANA, "PUT", "/v1/app/org/spend-policy", { leadApprovalThresholdUsd: 25 })).status).toBe(200);
      expect(await accepts()).toBe(25);
      expect((await call(MAX, "PUT", "/v1/app/projects/web/ai", { memberAcceptRunLimitUpToUsd: 80 })).status).toBe(200);
      expect(await accepts()).toBe(80);
      // A setting saved above a threshold that was lowered later is shown as the lower amount, as it is applied.
      expect((await call(DANA, "PUT", "/v1/app/org/spend-policy", { leadApprovalThresholdUsd: 25, adminApprovalThresholdUsd: 40 })).status).toBe(200);
      expect(await accepts()).toBe(40);
      expect((await call(MAX, "PUT", "/v1/app/projects/web/ai", { memberAcceptRunLimitUpToUsd: null })).status).toBe(200);
      expect(await accepts()).toBe(25);
    });

    it("uses an R18 mark: a repeat of the request id answers the first, and another body with it is refused", async () => {
      const { call } = await routeSetup();
      const requestId = randomUUID();
      const first = await call(MAX, "PUT", "/v1/app/projects/web/ai", { memberAcceptRunLimitUpToUsd: 25 }, requestId);
      const again = await call(MAX, "PUT", "/v1/app/projects/web/ai", { memberAcceptRunLimitUpToUsd: 25 }, requestId);
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ revision: first.body.revision });
      expect((await call(MAX, "PUT", "/v1/app/projects/web/ai", { memberAcceptRunLimitUpToUsd: 30 }, requestId)).status).toBe(400);
    });
  });

  it("tells nobody about a project they have no role on, or one that is not there", async () => {
    const { call } = await routeSetup();
    expect(errorOf(await call(EVE, "GET", "/v1/app/projects/web/ai")).code).toBe("PROJECT_NOT_FOUND");
    expect(errorOf(await call(DANA, "GET", "/v1/app/projects/nowhere/ai")).code).toBe("PROJECT_NOT_FOUND");
    expect(errorOf(await call(DANA, "PUT", "/v1/app/projects/nowhere/ai", { projectPays: true })).code).toBe("PROJECT_NOT_FOUND");
  });

  it("refuses a source the org does not have, and follows the org's order when a project sets none", async () => {
    const { call, deps } = await routeSetup({ orgSourceOrder: ["personal-chatgpt", "rovara"] });
    const unknown = await call(DANA, "PUT", "/v1/app/projects/web/ai", { sourceOrder: ["rovara", "src_aaaaaaaaaaaaaaaaaaaa"] });
    expect(unknown.status).toBe(400);
    expect(errorOf(unknown).code).toBe("CONFIG_INVALID");
    expect(errorOf(unknown).message).toContain("src_aaaaaaaaaaaaaaaaaaaa");
    expect((await call(DANA, "GET", "/v1/app/projects/web/ai")).body).toMatchObject({ effective: { sourceOrder: ["personal-chatgpt", "rovara"] } });
    const saved = await call(DANA, "PUT", "/v1/app/projects/web/ai", { sourceOrder: ["rovara"] });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ effective: { sourceOrder: ["rovara"] } });
    expect((await readProjectAi(deps, TEST_ORG, "web")).sourceOrder).toEqual(["rovara"]);
    const cleared = await call(DANA, "PUT", "/v1/app/projects/web/ai", { sourceOrder: null });
    expect(cleared.body).toMatchObject({ effective: { sourceOrder: ["personal-chatgpt", "rovara"] } });
    expect((await readProjectAi(deps, TEST_ORG, "web")).sourceOrder).toBeUndefined();
  });

  it("holds planning limits to $0.50 to $50 and uses a project's own over the default", async () => {
    const { call, deps } = await routeSetup();
    for (const bad of [0.4, 51, -1]) expect((await call(DANA, "PUT", "/v1/app/projects/web/ai", { planningLimitUsd: { QUICK: bad } })).status, String(bad)).toBe(400);
    const saved = await call(DANA, "PUT", "/v1/app/projects/web/ai", { planningLimitUsd: { QUICK: 4 } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(planningLimit(await readProjectAi(deps, TEST_ORG, "web"), "QUICK")).toBe(4);
    expect(saved.body).toMatchObject({ effective: { planningLimitUsd: { QUICK: 4, FULL: 6 } } });
    await call(DANA, "PUT", "/v1/app/projects/web/ai", { planningLimitUsd: { FULL: 9 } }); // a path left out stays as it was
    expect((await readProjectAi(deps, TEST_ORG, "web")).planningLimitUsd).toEqual({ QUICK: 4, FULL: 9 });
    await call(DANA, "PUT", "/v1/app/projects/web/ai", { planningLimitUsd: { QUICK: null } });
    expect((await readProjectAi(deps, TEST_ORG, "web")).planningLimitUsd).toEqual({ FULL: 9 });
  });

  it("refuses an empty change, an unknown field and a negative budget", async () => {
    const { call } = await routeSetup();
    expect((await call(DANA, "PUT", "/v1/app/projects/web/ai", {})).status).toBe(400);
    expect((await call(DANA, "PUT", "/v1/app/projects/web/ai", { projectPays: true, bonus: 1 })).status).toBe(400);
    expect((await call(DANA, "PUT", "/v1/app/projects/web/ai", { monthlyBudgetUsd: -5 })).status).toBe(400);
  });

  it("answers a repeat of the same request with the first answer and writes it once", async () => {
    const { call, db } = await routeSetup();
    const requestId = randomUUID();
    const first = await call(DANA, "PUT", "/v1/app/projects/web/ai", { monthlyBudgetUsd: 50 }, requestId);
    await call(DANA, "PUT", "/v1/app/projects/web/ai", { monthlyBudgetUsd: 75 });
    const again = await call(DANA, "PUT", "/v1/app/projects/web/ai", { monthlyBudgetUsd: 50 }, requestId);
    expect(again).toEqual(first);
    expect((await call(DANA, "GET", "/v1/app/projects/web/ai")).body).toMatchObject({ settings: { monthlyBudgetUsd: 75 }, revision: 2 });
    expect(db.get(agentRequestKey(TEST_ORG, DANA.developerId, requestId))).toBeDefined();
    expect(errorOf(await call(DANA, "PUT", "/v1/app/projects/web/ai", { monthlyBudgetUsd: 51 }, requestId)).code).toBe("CONFIG_INVALID");
  });

  it("keeps a trial org to the placeholder limits", async () => {
    const { call } = await routeSetup({ trial: true });
    const refused = await call(DANA, "PUT", "/v1/app/projects/web/ai", { monthlyBudgetUsd: 600 });
    expect(errorOf(refused).code).toBe("CONFIG_INVALID");
    expect(errorOf(refused).message).toContain("trial");
    expect((await call(DANA, "PUT", "/v1/app/projects/web/ai", { monthlyBudgetUsd: 500 })).status).toBe(200);
  });
});

describe("an agent's budget", () => {
  it("is refused above the guardrails' ceilings, and set within them", async () => {
    const { create, putBudget, store } = await routeSetup();
    const agentId = await create(MAX);
    const tooMuch = await putBudget(MAX, agentId, { monthlyUsd: 60 });
    expect(tooMuch.status).toBe(400);
    expect(errorOf(tooMuch).code).toBe("CONFIG_INVALID");
    expect(errorOf(tooMuch).message).toContain("$50");
    const tooMuchPerRun = await putBudget(MAX, agentId, { maxPerRunUsd: 150 });
    expect(tooMuchPerRun.status).toBe(400);
    expect(errorOf(tooMuchPerRun).message).toContain("$100");
    expect((await store.get(TEST_ORG, agentId))?.monthlyBudgetUsd).toBeUndefined();
    const saved = await putBudget(MAX, agentId, { monthlyUsd: 50, maxPerRunUsd: 100 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect((saved.body.agent as Record<string, unknown>)).toMatchObject({ agentId, monthlyBudgetUsd: 50, maxPerRunUsd: 100 });
    const cleared = await putBudget(MAX, agentId, { monthlyUsd: null });
    expect(cleared.body.agent).not.toHaveProperty("monthlyBudgetUsd");
    expect(cleared.body.agent).toMatchObject({ maxPerRunUsd: 100 });
  });

  it("follows the ceilings the org set", async () => {
    const { create, putBudget, deps } = await routeSetup();
    await writeGuardrails(deps, TEST_ORG, { ...structuredClone(DEFAULT_AGENT_GUARDRAILS), maxAgentMonthlyUsd: 20, maxPerRunCeilingUsd: 8 }, fixtureActor(deps, TEST_ORG, DANA.developerId, true).developerId, { ...({ expectedRevision: 0 }), actor: fixtureActor(deps, TEST_ORG, DANA.developerId, true) });
    const agentId = await create(MAX);
    expect((await putBudget(MAX, agentId, { monthlyUsd: 25 })).status).toBe(400);
    expect((await putBudget(MAX, agentId, { maxPerRunUsd: 9 })).status).toBe(400);
    expect((await putBudget(MAX, agentId, { monthlyUsd: 20, maxPerRunUsd: 8 })).status).toBe(200);
  });

  it("needs a change, a number or null, and no other field", async () => {
    const { create, putBudget } = await routeSetup();
    const agentId = await create(MAX);
    for (const body of [{}, { monthlyUsd: "5" }, { monthlyUsd: -1 }, { monthlyUsd: 5, bonus: true }]) expect((await putBudget(MAX, agentId, body)).status, JSON.stringify(body)).toBe(400);
  });

  it("is changed by those who manage the agent only", async () => {
    const { create, putBudget, call } = await routeSetup();
    const agentId = await create(MAX);
    expect((await call(MAX, "PUT", `/v1/app/agents/${agentId}/shares`, { shares: [{ principal: { kind: "member", developerId: CARL.developerId }, level: "edit" }] })).status).toBe(200);
    expect(errorOf(await putBudget(CARL, agentId, { monthlyUsd: 5 })).code).toBe("FORBIDDEN");
    expect(errorOf(await putBudget(EVE, agentId, { monthlyUsd: 5 })).code).toBe("NOT_FOUND");
    expect((await putBudget(DANA, agentId, { monthlyUsd: 5 })).status).toBe(200);
  });

  it("is set on a built-in by org owners and admins only, and counts for its accountable person", async () => {
    const { putBudget, call, totalOf } = await routeSetup();
    expect(errorOf(await putBudget(MAX, "ticket-triage", { monthlyUsd: 10 })).code).toBe("FORBIDDEN");
    const saved = await putBudget(DANA, "ticket-triage", { monthlyUsd: 10, maxPerRunUsd: 4 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.agent).toMatchObject({ agentId: "ticket-triage", builtin: true, monthlyBudgetUsd: 10, maxPerRunUsd: 4 });
    expect(totalOf(DANA.developerId)).toBe(0); // no accountable person yet: it counts for no one
    expect((await call(DANA, "PUT", "/v1/app/agents/ticket-triage/accountable", { accountable: { developerId: DANA.developerId } })).status).toBe(200);
    expect(totalOf(DANA.developerId)).toBe(10);
  });

  it("counts toward its owner's total, and an over-the-cap raise waits for an org admin (202) with the budget unchanged (Task 32)", async () => {
    const { create, putBudget, store, totalOf } = await routeSetup();
    const first = await create(MAX);
    const second = await create(MAX);
    expect((await putBudget(MAX, first, { monthlyUsd: 50 })).status).toBe(200);
    expect((await putBudget(MAX, second, { monthlyUsd: 40 })).status).toBe(200);
    expect(totalOf(MAX.developerId)).toBe(90);
    const third = await create(MAX);
    const refused = await putBudget(MAX, third, { monthlyUsd: 11 });
    expect(refused.status).toBe(202);
    expect(refused.body).toMatchObject({ status: "NEEDS_ADMIN_APPROVAL", message: "Max's agent budgets would total $101 a month, over the $100 limit for one person. I asked an org admin to approve it." });
    expect((await store.get(TEST_ORG, third))?.monthlyBudgetUsd).toBeUndefined();
    expect(totalOf(MAX.developerId)).toBe(90);
    expect((await putBudget(MAX, third, { monthlyUsd: 10 })).status).toBe(200); // exactly on the cap
    expect(totalOf(MAX.developerId)).toBe(100);
    expect((await putBudget(MAX, first, { monthlyUsd: 40 })).status).toBe(200); // lowering always passes
    expect(totalOf(MAX.developerId)).toBe(90);
  });

  it("is answered from the first request when it is sent again, and writes the request's item with the budget", async () => {
    const { create, putBudget, db, totalOf } = await routeSetup();
    const agentId = await create(MAX);
    const requestId = randomUUID();
    const first = await putBudget(MAX, agentId, { monthlyUsd: 20 }, requestId);
    expect(db.get(agentRequestKey(TEST_ORG, MAX.developerId, requestId))).toBeDefined();
    expect((await putBudget(MAX, agentId, { monthlyUsd: 30 })).status).toBe(200);
    const again = await putBudget(MAX, agentId, { monthlyUsd: 20 }, requestId);
    expect(again).toEqual(first);
    expect(totalOf(MAX.developerId)).toBe(30);
    expect(errorOf(await putBudget(MAX, agentId, { monthlyUsd: 21 }, requestId)).code).toBe("CONFIG_INVALID");
  });

  it("keeps a trial org's agents to a member's placeholder limit", async () => {
    const { create, putBudget } = await routeSetup({ trial: true });
    const agentId = await create(MAX);
    const refused = await putBudget(MAX, agentId, { monthlyUsd: 30 });
    expect(errorOf(refused).code).toBe("CONFIG_INVALID");
    expect(errorOf(refused).message).toContain("trial");
    expect((await putBudget(MAX, agentId, { monthlyUsd: 29 })).status).toBe(200);
  });
});

describe("the owner total on archive, owner and accountable changes", () => {
  it("keeps an agent archived (202, an admin asked) when putting its budget back would pass the cap", async () => {
    const { create, putBudget, call, store, totalOf } = await routeSetup();
    const big = await create(MAX);
    expect((await putBudget(MAX, big, { monthlyUsd: 50 })).status).toBe(200);
    expect((await call(MAX, "POST", `/v1/app/agents/${big}/archive`, {})).status).toBe(200);
    expect(totalOf(MAX.developerId)).toBe(0);
    const others = [await create(MAX), await create(MAX)];
    for (const other of others) expect((await putBudget(MAX, other, { monthlyUsd: 40 })).status).toBe(200);
    const refused = await call(MAX, "POST", `/v1/app/agents/${big}/unarchive`, {});
    expect(refused.status).toBe(202);
    expect(String(refused.body.message)).toContain("$130");
    expect((await store.get(TEST_ORG, big))?.status).toBe("archived");
    expect((await putBudget(MAX, others[0]!, { monthlyUsd: 10 })).status).toBe(200);
    expect((await call(MAX, "POST", `/v1/app/agents/${big}/unarchive`, {})).status).toBe(200);
    expect(totalOf(MAX.developerId)).toBe(100);
  });

  it("leaves the owner as it was when the new owner would pass the cap", async () => {
    const { create, putBudget, call, store, totalOf } = await routeSetup();
    const mine = await create(MAX);
    expect((await putBudget(MAX, mine, { monthlyUsd: 40 })).status).toBe(200);
    const carls = await create(CARL);
    expect((await putBudget(CARL, carls, { monthlyUsd: 50 })).status).toBe(200);
    const carls2 = await create(CARL);
    expect((await putBudget(CARL, carls2, { monthlyUsd: 50 })).status).toBe(200);
    const refused = await call(DANA, "PUT", `/v1/app/agents/${mine}/owner`, { owner: { kind: "member", developerId: CARL.developerId } });
    expect(refused.status).toBe(202);
    expect(String(refused.body.message)).toContain("Carl's agent budgets would total $140 a month, over the $100 limit");
    expect((await store.get(TEST_ORG, mine))?.owner).toEqual({ kind: "member", developerId: MAX.developerId });
    expect(totalOf(MAX.developerId)).toBe(40);
    expect(totalOf(CARL.developerId)).toBe(100);
    const moved = await call(DANA, "PUT", `/v1/app/agents/${mine}/owner`, { owner: { kind: "member", developerId: EVE.developerId } });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(totalOf(MAX.developerId)).toBe(0);
    expect(totalOf(EVE.developerId)).toBe(40);
  });

  it("keeps the old accountable maintainer when the new one would pass the cap", async () => {
    const { create, putBudget, call, store, totalOf, members } = await routeSetup();
    members.grant(TEST_ORG, "web", DANA.developerId, "maintainer");
    const created = await call(MAX, "POST", "/v1/app/agents", { name: "Web helper", overlay: SAFE_OVERLAY, owner: { kind: "project", project: "web" }, accountable: { developerId: MAX.developerId } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const projectAgent = (created.body.agent as { agentId: AgentId }).agentId;
    expect((await putBudget(MAX, projectAgent, { monthlyUsd: 30 })).status).toBe(200);
    expect(totalOf(MAX.developerId)).toBe(30);
    const carls = [await create(CARL), await create(CARL)];
    for (const agentId of carls) expect((await putBudget(CARL, agentId, { monthlyUsd: 50 })).status).toBe(200);
    members.grant(TEST_ORG, "web", CARL.developerId, "maintainer");
    const refused = await call(MAX, "PUT", `/v1/app/agents/${projectAgent}/accountable`, { accountable: { developerId: CARL.developerId } });
    expect(refused.status).toBe(202);
    expect(String(refused.body.message)).toContain("Carl's agent budgets would total $130 a month");
    expect((await store.get(TEST_ORG, projectAgent))?.accountable).toEqual({ developerId: MAX.developerId });
    expect(totalOf(MAX.developerId)).toBe(30);
    expect(totalOf(CARL.developerId)).toBe(100);
  });
});

describe("the org's spend policy", () => {
  it("starts as the defaults and is read and changed by org owners and admins only", async () => {
    const { call } = await routeSetup();
    expect(errorOf(await call(MAX, "GET", "/v1/app/org/spend-policy")).code).toBe("FORBIDDEN");
    expect(errorOf(await call(MAX, "PUT", "/v1/app/org/spend-policy", { ownerAgentBudgetCapUsd: 150 })).code).toBe("FORBIDDEN");
    const initial = await call(DANA, "GET", "/v1/app/org/spend-policy");
    expect(initial.status, JSON.stringify(initial.body)).toBe(200);
    expect(initial.body).toEqual({ policy: defaultSpendPolicy(), revision: 0 });
    const saved = await call(DANA, "PUT", "/v1/app/org/spend-policy", { ownerAgentBudgetCapUsd: 150, runLimitMultiplier: 3 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toEqual({ policy: { ...defaultSpendPolicy(), ownerAgentBudgetCapUsd: 150, runLimitMultiplier: 3 }, revision: 1 });
    expect((await call(DANA, "GET", "/v1/app/org/spend-policy")).body).toEqual(saved.body);
  });

  it("keeps the lead's threshold at or below the admin's, the multiplier from 1 to 5 and the cap at $1 or more", async () => {
    const { call } = await routeSetup();
    const bad: Array<Record<string, unknown>> = [
      { leadApprovalThresholdUsd: 200 }, // above the admin threshold of 100
      { adminApprovalThresholdUsd: 5 }, // below the lead threshold of 10
      { runLimitMultiplier: 0.5 }, { runLimitMultiplier: 6 }, { ownerAgentBudgetCapUsd: 0.5 }, { perTestCapUsd: -1 }, { bonus: 1 }, {},
    ];
    for (const body of bad) expect((await call(DANA, "PUT", "/v1/app/org/spend-policy", body)).status, JSON.stringify(body)).toBe(400);
    expect((await call(DANA, "PUT", "/v1/app/org/spend-policy", { leadApprovalThresholdUsd: 40, adminApprovalThresholdUsd: 40, ownerAgentBudgetCapUsd: 1, runLimitMultiplier: 5 })).status).toBe(200);
    expect((await call(DANA, "PUT", "/v1/app/org/spend-policy", { leadApprovalThresholdUsd: 41 })).status).toBe(400);
  });

  it("lets a raised cap through for a raise that was over, and answers a repeat from the first request", async () => {
    const { call, create, putBudget } = await routeSetup();
    const first = await create(MAX);
    const second = await create(MAX);
    expect((await putBudget(MAX, first, { monthlyUsd: 50 })).status).toBe(200);
    expect((await putBudget(MAX, second, { monthlyUsd: 50 })).status).toBe(200);
    expect((await putBudget(MAX, second, { monthlyUsd: 51 })).status).toBe(400); // the guardrail's ceiling is $50 anyway
    const requestId = randomUUID();
    const raised = await call(DANA, "PUT", "/v1/app/org/spend-policy", { ownerAgentBudgetCapUsd: 150 }, requestId);
    const third = await create(MAX);
    expect((await putBudget(MAX, third, { monthlyUsd: 40 })).status).toBe(200);
    expect(await call(DANA, "PUT", "/v1/app/org/spend-policy", { ownerAgentBudgetCapUsd: 150 }, requestId)).toEqual(raised);
    expect(errorOf(await call(DANA, "PUT", "/v1/app/org/spend-policy", { ownerAgentBudgetCapUsd: 151 }, requestId)).code).toBe("CONFIG_INVALID");
  });

  it("keeps a trial org's cap at a member's placeholder limit (R49), and lets it change other settings", async () => {
    const { call } = await routeSetup({ trial: true });
    // The default cap ($100) is above the trial limit; naming another setting does not trip over it.
    expect((await call(DANA, "PUT", "/v1/app/org/spend-policy", { runLimitMultiplier: 3 })).status).toBe(200);
    const refused = await call(DANA, "PUT", "/v1/app/org/spend-policy", { ownerAgentBudgetCapUsd: 30 });
    expect(errorOf(refused).code).toBe("CONFIG_INVALID");
    expect(errorOf(refused).message).toContain("trial");
    expect((await call(DANA, "PUT", "/v1/app/org/spend-policy", { ownerAgentBudgetCapUsd: 29 })).status).toBe(200);
  });
});

// ---- fix round 1

describe("trial limits (R49)", () => {
  it("are one named set: a project up to the org's placeholder, an agent and an owner's cap up to a member's", () => {
    expect(TRIAL_LIMITS_R49).toEqual({ projectMonthlyUsd: DEFAULT_ORG_MONTHLY_BUDGET_USD, agentMonthlyUsd: DEFAULT_MEMBER_MONTHLY_BUDGET_USD, ownerAgentBudgetCapUsd: DEFAULT_MEMBER_MONTHLY_BUDGET_USD });
  });
});

describe("a counter change is conditioned on the counter alone", () => {
  const table = { documentClient: new FakeDynamoDb(), tableName: "state", now: () => NOW_OCTOBER };
  const key = ownerBudgetKey(TEST_ORG, ALICE);
  const condition = (delta: number, cap?: number) => (addToCounter(table, key, "totalUsd", delta, cap).Update!).ConditionExpression!;

  it("never compares two values with each other", () => {
    for (const expression of [condition(10), condition(10, 100), condition(-10), condition(500, 100)]) {
      expect(expression).toMatch(/^attribute_exists\(#n\d+\)( AND #n\d+ (<=|>=) :v\d+)?$/);
    }
    expect(condition(10)).not.toContain("<=");
    expect(condition(10, 100)).toContain("<=");
    expect(condition(-10)).toContain(">=");
  });

  it("refuses a raise past the limit, a decrease below zero, and a counter that is not there", async () => {
    const { db } = limitsSetup();
    const send = (item: ReturnType<typeof addToCounter>) => (db as unknown as { send(command: unknown): Promise<unknown> }).send(new TransactWriteCommand({ TransactItems: [item] }));
    const add = (delta: number, cap?: number) => addToCounter({ documentClient: db, tableName: "state", now: () => NOW_OCTOBER }, key, "totalUsd", delta, cap);
    await expect(send(add(5))).rejects.toMatchObject({ name: "TransactionCanceledException" }); // no counter to add to
    db.set({ ...key, entityType: "OWNER_AGENT_BUDGET", totalUsd: 5 });
    await expect(send(add(-6))).rejects.toMatchObject({ name: "TransactionCanceledException" });
    await expect(send(add(96, 100))).rejects.toMatchObject({ name: "TransactionCanceledException" });
    await send(add(95, 100)); // exactly on the cap
    await send(add(-100));
    expect((db.get(key) as { totalUsd: number }).totalUsd).toBe(0);
  });
});

describe("an owner merged into another counts for the survivor", () => {
  const GHOST = "9".repeat(64);
  const newAgent = (base: ReturnType<typeof ownerSetup>, owner: string, name = `G-${randomUUID().slice(0, 6)}`) => base.store.create({ orgId: TEST_ORG, name, owner: { kind: "member", developerId: owner }, createdBy: owner });

  it("puts a duplicate's raise in the survivor's total, so the survivor can't pass the cap", async () => {
    const base = ownerSetup();
    const { store, totalOf, merged, ownerAgents } = base;
    await ownerAgents(50, 50); // Alice is at the cap
    merged.set(GHOST, ALICE);
    const dup = await newAgent(base, GHOST);
    expect(await checkOwnerBudget(base.deps, { orgId: TEST_ORG, owner: ALICE, deltaUsd: 50 })).toMatchObject({ ok: false });
    await expect(store.setBudget(TEST_ORG, dup.agentId, { monthlyUsd: 50 }, fixtureActor(store, TEST_ORG, GHOST).developerId, undefined, { ...({ ownerCap: await base.capOf() }), actor: fixtureActor(store, TEST_ORG, GHOST) })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: containing(OVER_CAP_TEXT) });
    expect(totalOf(ALICE)).toBe(100);
    await store.setBudget(TEST_ORG, dup.agentId, { monthlyUsd: 0 }, fixtureActor(store, TEST_ORG, GHOST).developerId, undefined, { ...({ ownerCap: await base.capOf() }), actor: fixtureActor(store, TEST_ORG, GHOST) });
    expect(totalOf(GHOST)).toBe(0);
  });

  it("counts a duplicate's agent under the survivor, and takes it off again from there", async () => {
    const base = ownerSetup();
    const { store, totalOf, merged, ownerAgents } = base;
    await ownerAgents(40);
    merged.set(GHOST, ALICE);
    const dup = await newAgent(base, GHOST);
    await store.setBudget(TEST_ORG, dup.agentId, { monthlyUsd: 30 }, fixtureActor(store, TEST_ORG, GHOST).developerId, undefined, { ...({ ownerCap: await base.capOf() }), actor: fixtureActor(store, TEST_ORG, GHOST) });
    expect(totalOf(ALICE)).toBe(70);
    expect(base.db.get(ownerBudgetKey(TEST_ORG, GHOST))).toBeUndefined();
    await store.archive(TEST_ORG, dup.agentId, GHOST);
    expect(totalOf(ALICE)).toBe(40);
  });

  it("heals the survivor's total from the agents when a duplicate's agent, already counted before the merge, changes", async () => {
    const base = ownerSetup();
    const { store, totalOf, merged, ownerAgents } = base;
    const dup = await newAgent(base, GHOST);
    await store.setBudget(TEST_ORG, dup.agentId, { monthlyUsd: 30 }, fixtureActor(store, TEST_ORG, GHOST).developerId, undefined, { ...({}), actor: fixtureActor(store, TEST_ORG, GHOST) }); // counted for the duplicate while it was one person
    await ownerAgents(40);
    expect(totalOf(GHOST)).toBe(30);
    merged.set(GHOST, ALICE); // the merge happens; nothing has moved the counters yet
    await store.setBudget(TEST_ORG, dup.agentId, { monthlyUsd: 10 }, fixtureActor(store, TEST_ORG, GHOST).developerId, undefined, { ...({}), actor: fixtureActor(store, TEST_ORG, GHOST) });
    expect(totalOf(ALICE)).toBe(50); // 40 + 10, not 40 - 20
  });

  it("can be rebuilt exactly from the agents, as a merge does", async () => {
    const base = ownerSetup();
    const { store, totalOf, merged, ownerAgents } = base;
    const dup = await newAgent(base, GHOST);
    await store.setBudget(TEST_ORG, dup.agentId, { monthlyUsd: 30 }, fixtureActor(store, TEST_ORG, GHOST).developerId, undefined, { ...({}), actor: fixtureActor(store, TEST_ORG, GHOST) });
    await ownerAgents(40);
    merged.set(GHOST, ALICE);
    expect(await store.rebuildOwnerTotal(TEST_ORG, ALICE)).toBe(70);
    expect(totalOf(ALICE)).toBe(70);
  });

  it("is held by the route against the survivor's total, in the survivor's name", async () => {
    const { create, putBudget, store, db, totalOf } = await routeSetup();
    for (const agentId of [await create(MAX), await create(MAX)]) expect((await putBudget(MAX, agentId, { monthlyUsd: 50 })).status).toBe(200);
    db.set({ pk: `DEVELOPER#${GHOST}`, sk: "META", developerId: GHOST, provider: "oidc", displayName: "Ghost", firstSignInAt: "x", lastSignInAt: "x", revoked: false, mergedInto: MAX.developerId });
    const dup = await store.create({ orgId: TEST_ORG, name: "Duplicate's agent", owner: { kind: "member", developerId: GHOST }, createdBy: GHOST });
    const refused = await putBudget(DANA, dup.agentId, { monthlyUsd: 10 });
    expect(refused.status).toBe(202);
    expect(String(refused.body.message)).toContain("Max's agent budgets would total $110");
    expect(totalOf(MAX.developerId)).toBe(100);
    expect((await store.get(TEST_ORG, dup.agentId))?.monthlyBudgetUsd).toBeUndefined();
  });
});

describe("the write holds the spend policy it read", () => {
  it("is refused whole when the policy changed since it was read", async () => {
    const { ownerAgents, store, deps, totalOf, capOf } = ownerSetup();
    const [first] = await ownerAgents(10);
    const read = await capOf();
    await writeSpendPolicy(deps, TEST_ORG, { ...defaultSpendPolicy(), ownerAgentBudgetCapUsd: 20 }, fixtureActor(deps, TEST_ORG, DANA.developerId).developerId, { ...({}), actor: fixtureActor(deps, TEST_ORG, DANA.developerId) });
    await expect(store.setBudget(TEST_ORG, first!, { monthlyUsd: 50 }, fixtureActor(store, TEST_ORG, ALICE).developerId, undefined, { ...({ ownerCap: read }), actor: fixtureActor(store, TEST_ORG, ALICE) })).rejects.toMatchObject({ code: "AGENT_REVISION_CONFLICT", message: containing("spend policy changed") });
    expect((await store.get(TEST_ORG, first!))?.monthlyBudgetUsd).toBe(10);
    expect(totalOf(ALICE)).toBe(10);
    await store.setBudget(TEST_ORG, first!, { monthlyUsd: 20 }, fixtureActor(store, TEST_ORG, ALICE).developerId, undefined, { ...({ ownerCap: await capOf() }), actor: fixtureActor(store, TEST_ORG, ALICE) }); // the policy as it is now
    expect(totalOf(ALICE)).toBe(20);
  });
});

describe("a stale read of the agent says so, and is not mistaken for the cap", () => {
  it("answers a budget-specific conflict when the owner, status or budget moved", async () => {
    const { ownerAgents, store } = ownerSetup();
    const [first] = await ownerAgents(10);
    const results = await Promise.allSettled([
      store.setBudget(TEST_ORG, first!, { monthlyUsd: 20 }, fixtureActor(store, TEST_ORG, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(store, TEST_ORG, ALICE) }),
      store.setBudget(TEST_ORG, first!, { monthlyUsd: 30 }, fixtureActor(store, TEST_ORG, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(store, TEST_ORG, ALICE) }),
    ]);
    const refused = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: "AGENT_REVISION_CONFLICT" });
    expect((refused.reason as Error).message).toContain("agent's owner, status or budget");
    expect((refused.reason as Error).message).not.toContain("draft");
  });
});

describe("two changes racing on one agent", () => {
  const sumOfAgents = async (store: AgentStore, owner: string) => (await store.list(TEST_ORG)).filter((agent) => agent.status === "active" && agent.owner.kind === "member" && agent.owner.developerId === owner).reduce((sum, agent) => sum + (agent.monthlyBudgetUsd ?? 0), 0);

  // Both orders: whichever is sent first commits first, and the other must find what it read has moved.
  for (const budgetFirst of [true, false]) {
    it(`lets one of a budget change and an owner change apply, and the totals match the agents (budget ${budgetFirst ? "first" : "second"})`, async () => {
      const { ownerAgents, store, totalOf } = ownerSetup();
      const [agent] = await ownerAgents(30);
      const budget = () => store.setBudget(TEST_ORG, agent!, { monthlyUsd: 45 }, fixtureActor(store, TEST_ORG, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(store, TEST_ORG, ALICE) });
      const owner = () => store.setOwner(TEST_ORG, agent!, { kind: "member", developerId: BOB }, ALICE, undefined, undefined, { actor: fixtureActor(store, TEST_ORG, ALICE) });
      const results = await Promise.allSettled(budgetFirst ? [budget(), owner()] : [owner(), budget()]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(totalOf(ALICE)).toBe(await sumOfAgents(store, ALICE));
      expect(totalOf(BOB)).toBe(await sumOfAgents(store, BOB));
    });

    it(`lets one of a budget change and an archive apply, and the totals match the agents (budget ${budgetFirst ? "first" : "second"})`, async () => {
      const { ownerAgents, store, totalOf } = ownerSetup();
      const [agent] = await ownerAgents(30);
      const budget = () => store.setBudget(TEST_ORG, agent!, { monthlyUsd: 45 }, fixtureActor(store, TEST_ORG, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(store, TEST_ORG, ALICE) });
      const archive = () => store.archive(TEST_ORG, agent!, ALICE);
      const results = await Promise.allSettled(budgetFirst ? [budget(), archive()] : [archive(), budget()]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(totalOf(ALICE)).toBe(await sumOfAgents(store, ALICE));
    });
  }
});

describe("a change worked out from a stale read of the agent", () => {
  const sumOfAgents = async (store: AgentStore, owner: string) => (await store.list(TEST_ORG)).filter((agent) => agent.status === "active" && agent.owner.kind === "member" && agent.owner.developerId === owner).reduce((sum, agent) => sum + (agent.monthlyBudgetUsd ?? 0), 0);
  type Change = (store: AgentStore, agentId: AgentId) => Promise<unknown>;
  const budget: Change = (store, agentId) => store.setBudget(TEST_ORG, agentId, { monthlyUsd: 45 }, fixtureActor(store, TEST_ORG, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(store, TEST_ORG, ALICE) });
  const owner: Change = (store, agentId) => store.setOwner(TEST_ORG, agentId, { kind: "member", developerId: BOB }, ALICE, undefined, undefined, { actor: fixtureActor(store, TEST_ORG, ALICE) });
  const archive: Change = (store, agentId) => store.archive(TEST_ORG, agentId, ALICE);
  const cases: Array<[string, Change, Change]> = [
    ["a budget change after the owner moved", owner, budget], ["a budget change after the agent was archived", archive, budget],
    ["an owner change after the budget changed", budget, owner], ["an archive after the budget changed", budget, archive],
    ["an archive after the owner moved", owner, archive], ["an owner change after the agent was archived", archive, owner],
  ];
  for (const [name, first, stale] of cases) {
    it(`refuses ${name} and leaves the totals right`, async () => {
      const { ownerAgents, store, totalOf } = ownerSetup();
      const [agent] = await ownerAgents(30);
      const before = (await store.get(TEST_ORG, agent!))!;
      await first(store, agent!);
      const get = vi.spyOn(store, "get").mockResolvedValueOnce(before); // what the second writer read, before the first committed
      await expect(stale(store, agent!)).rejects.toMatchObject({ code: "AGENT_REVISION_CONFLICT", message: containing("owner, status or budget") });
      get.mockRestore();
      expect(totalOf(ALICE)).toBe(await sumOfAgents(store, ALICE));
      expect(totalOf(BOB)).toBe(await sumOfAgents(store, BOB));
    });
  }
});

describe("a total that was never counted", () => {
  it("is built from the agents first, so a later change is exact and never goes below zero", async () => {
    const { store, db, totalOf, ownerAgents } = ownerSetup();
    const [first, second] = await ownerAgents(30, 20);
    // As if the budgets had been set before the totals were kept: no counter at all.
    db.delete(ownerBudgetKey(TEST_ORG, ALICE));
    expect(db.get(ownerBudgetKey(TEST_ORG, ALICE))).toBeUndefined();
    await store.setBudget(TEST_ORG, first!, { monthlyUsd: 5 }, fixtureActor(store, TEST_ORG, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(store, TEST_ORG, ALICE) });
    expect(totalOf(ALICE)).toBe(25);
    db.delete(ownerBudgetKey(TEST_ORG, ALICE));
    await store.setBudget(TEST_ORG, second!, { monthlyUsd: null }, fixtureActor(store, TEST_ORG, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(store, TEST_ORG, ALICE) });
    expect(totalOf(ALICE)).toBe(5);
    db.delete(ownerBudgetKey(TEST_ORG, ALICE));
    await store.archive(TEST_ORG, first!, ALICE);
    expect(totalOf(ALICE)).toBe(0);
  });

  it("is built for a built-in's accountable person too", async () => {
    const { store, db, totalOf } = ownerSetup();
    await store.setAccountable(TEST_ORG, "ticket-triage", { developerId: DANA.developerId }, DANA.developerId);
    await store.setBudget(TEST_ORG, "ticket-triage", { monthlyUsd: 15 }, fixtureActor(store, TEST_ORG, DANA.developerId).developerId, undefined, { ...({}), actor: fixtureActor(store, TEST_ORG, DANA.developerId) });
    db.delete(ownerBudgetKey(TEST_ORG, DANA.developerId));
    await store.setBudget(TEST_ORG, "ticket-triage", { monthlyUsd: 4 }, fixtureActor(store, TEST_ORG, DANA.developerId).developerId, undefined, { ...({}), actor: fixtureActor(store, TEST_ORG, DANA.developerId) });
    expect(totalOf(DANA.developerId)).toBe(4);
  });
});

describe("another company", () => {
  it("is never touched: its agent is 404 to this org's admin, and its totals and projects are separate", async () => {
    const { store, putBudget, call, db } = await routeSetup();
    const other = await store.create({ orgId: ORG_B, name: "Other company agent", owner: { kind: "member", developerId: OMAR.developerId }, createdBy: OMAR.developerId });
    const refused = await putBudget(DANA, other.agentId, { monthlyUsd: 10 });
    expect(refused.status).toBe(404);
    expect(errorOf(refused).code).toBe("NOT_FOUND");
    expect((await store.get(ORG_B, other.agentId))?.monthlyBudgetUsd).toBeUndefined();
    expect(db.get(ownerBudgetKey(ORG_B, OMAR.developerId))).toBeUndefined();
    // A project of this org is not found under the other's name, and the other org's policy is its own.
    db.set({ ...orgProjectCatalogKey(ORG_B, "secret"), entityType: "PROJECT_CATALOG", name: "secret" });
    expect(errorOf(await call(DANA, "GET", "/v1/app/projects/secret/ai")).code).toBe("PROJECT_NOT_FOUND");
    await call(DANA, "PUT", "/v1/app/org/spend-policy", { ownerAgentBudgetCapUsd: 150 });
    expect((await readSpendPolicy({ documentClient: db, tableName: "state" }, ORG_B)).ownerAgentBudgetCapUsd).toBe(DEFAULT_OWNER_AGENT_BUDGET_CAP_USD);
  });
});

describe("a built-in's budget answer", () => {
  it("carries who set it, as stored", async () => {
    const { store } = ownerSetup();
    await store.ensureBuiltinSettings(TEST_ORG, "ticket-triage", BOB); // someone else made the settings
    const written = await store.setBudget(TEST_ORG, "ticket-triage", { monthlyUsd: 8 }, fixtureActor(store, TEST_ORG, DANA.developerId).developerId, undefined, { ...({}), actor: fixtureActor(store, TEST_ORG, DANA.developerId) });
    expect(written).toMatchObject({ monthlyBudgetUsd: 8, updatedBy: DANA.developerId });
    expect(await store.getBuiltinSettings(TEST_ORG, "ticket-triage")).toMatchObject({ updatedBy: DANA.developerId });
  });

  it("is the first answer when the same request is sent again", async () => {
    const { putBudget } = await routeSetup();
    const requestId = randomUUID();
    const first = await putBudget(DANA, "ticket-triage", { monthlyUsd: 10 }, requestId);
    expect(first.status).toBe(200);
    expect((await putBudget(DANA, "ticket-triage", { monthlyUsd: 12 })).status).toBe(200);
    const again = await putBudget(DANA, "ticket-triage", { monthlyUsd: 10 }, requestId);
    expect(again).toEqual(first);
    expect(again.body.agent).toMatchObject({ monthlyBudgetUsd: 10 });
  });
});


it("preserves future task-stop intent during an ordinary project AI PUT and exposes no setter", async () => {
  const { db, call } = await routeSetup();
  const policy = { schemaVersion: 1, stopMicrousd: 20_000_000 };
  db.set({ ...projectAiKey(TEST_ORG, "web"), entityType: "PROJECT_AI", projectPays: false, monthlyBudgetUsd: 200, taskStopPolicy: policy, revision: 1 });
  const changed = await call(DANA, "PUT", "/v1/app/projects/web/ai", { monthlyBudgetUsd: 300 });
  expect(changed.status).toBe(200);
  expect(db.get(projectAiKey(TEST_ORG, "web"))?.taskStopPolicy).toEqual(policy);
  const visible = await call(VIV, "GET", "/v1/app/projects/web/ai");
  expect(visible.status).toBe(200);
  expect(visible.body).toMatchObject({ settings: { taskStopPolicy: policy } });
  const forbidden = await call(DANA, "PUT", "/v1/app/projects/web/ai", { taskStopPolicy: { schemaVersion: 1, stopMicrousd: 0 } });
  expect(forbidden.status).toBe(400);
  expect(db.get(projectAiKey(TEST_ORG, "web"))?.taskStopPolicy).toEqual(policy);
  const member = await call(MAX, "PUT", "/v1/app/projects/web/ai", { taskStopPolicy: { schemaVersion: 1, stopMicrousd: 0 } });
  expect(member.status).toBe(400);
  expect(db.get(projectAiKey(TEST_ORG, "web"))?.taskStopPolicy).toEqual(policy);
});


it("keeps unset task-stop intent absent in the stored row and real project AI PUT reply", async () => {
  const { db, call } = await routeSetup();
  db.set({ ...projectAiKey(TEST_ORG, "web"), entityType: "PROJECT_AI", projectPays: false, monthlyBudgetUsd: 200, revision: 1 });
  const result = await call(DANA, "PUT", "/v1/app/projects/web/ai", { monthlyBudgetUsd: 300 });
  expect(result.status).toBe(200);
  expect(Object.hasOwn(db.get(projectAiKey(TEST_ORG, "web"))!, "taskStopPolicy")).toBe(false);
  expect(Object.hasOwn(result.body.settings as Record<string, unknown>, "taskStopPolicy")).toBe(false);
});
