// Task 15: monthly budgets per member and org, checked at task start, and per-task key caps that hold across re-mints.
// The broker never talks to LiteLLM (ruling R28), so every proxy call here goes through a fake ModelAccess.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMBER_MONTHLY_BUDGET_USD, DEFAULT_ORG_MONTHLY_BUDGET_USD, PER_TASK_BUDGET_USD, agentXError, budgetSyncedKey, errorStatus, orgMetaKey, orgSettingsKey, type OrgId } from "../../packages/contracts/src/index.js";
// The package the broker imports, not its source: the broker tests an error for that package's class.
import { agentXError as proxyError } from "@agentx/contracts";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { MINIMUM_REMAINING_USD, ensureSynced, keyIdOf, mintKeyHealing, readBudgets, syncBudgets } from "../../packages/broker/src/org/budget.js";
import { admitMember, nextKeyCap } from "../support/admission.js";
import { resolveOrgOnSignIn } from "../../packages/broker/src/org/sign-in.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { MAYA, OMAR, createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import { seedTaskRunLimit } from "../support/run-history.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { fakeModelAccess, type FakeModelAccess } from "../support/fake-model-access.js";
import { TEST_ORG } from "../support/orgs.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, createBroker, ensureWorkspace, loadSlackBroker, markReady, registerSlackProject, serviceCall } from "../support/slack-broker.js";

const PROXY_URL = "http://internal-proxy.example.test:4000";
const SLACK_USER = "U0123456789";
const THREAD = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
const BUDGET_EXCEEDED_TEXT = (spent: string, limit: string) => `Your monthly AI budget is used up ($${spent} of $${limit}). Ask an admin to raise it.`;
const ORG_BUDGET_MESSAGE = "Your company's monthly AI budget is used up. Ask an admin to raise it.";

/** The commands sent since `since`; setup (registering the project, signing people in) transacts too. */
const sentSince = (db: FakeDynamoDb, since: number) => db.commandNames().slice(since);

const rejection = async (action: Promise<unknown>) => {
  try { await action; } catch (error) { return error as { code: string; message: string; statusCode: number }; }
  throw new Error("expected a rejection");
};

describe("the budget error codes", () => {
  it("answer 402", () => {
    expect(errorStatus("BUDGET_EXCEEDED")).toBe(402);
    expect(errorStatus("ORG_BUDGET_EXCEEDED")).toBe(402);
    expect(agentXError("BUDGET_EXCEEDED", "x").statusCode).toBe(402);
  });
});

describe("budget settings", () => {
  function deps(access: FakeModelAccess = fakeModelAccess()) {
    const db = new FakeDynamoDb();
    for (const developerId of ["dev1", "dev2"]) seedMembership(db, developerId, { orgId: TEST_ORG, role: "member" });
    const orgs = new OrgStore({ documentClient: db, tableName: "state", now: () => Date.parse("2026-10-19T12:00:00.000Z") });
    return { db, access, deps: { documentClient: db, tableName: "state", access, orgs, cloud: true } };
  }

  it("default to the placeholder budgets, and read what an org set", async () => {
    const { db, deps: d } = deps();
    expect(await readBudgets(d, TEST_ORG)).toEqual({ orgMonthlyUsd: DEFAULT_ORG_MONTHLY_BUDGET_USD, memberDefaultMonthlyUsd: DEFAULT_MEMBER_MONTHLY_BUDGET_USD, memberOverrides: {} });
    db.set({ ...orgSettingsKey(TEST_ORG, "BUDGET"), orgMonthlyUsd: 900, memberDefaultMonthlyUsd: 40, memberOverrides: { dev1: 2000, bad: -1, worse: "x" } });
    expect(await readBudgets(d, TEST_ORG)).toEqual({ orgMonthlyUsd: 900, memberDefaultMonthlyUsd: 40, memberOverrides: { dev1: 2000 } });
  });

  it("syncBudgets tells the proxy the org's limit and each named member's, and marks what it told", async () => {
    const { db, access, deps: d } = deps();
    db.set({ ...orgSettingsKey(TEST_ORG, "BUDGET"), orgMonthlyUsd: 900, memberDefaultMonthlyUsd: 40, memberOverrides: { dev1: 2000 } });
    await syncBudgets(d, TEST_ORG, ["dev1", "dev2", "dev1"]);
    expect(access.upsertOrg.mock.calls).toEqual([[TEST_ORG, 900]]);
    expect(access.upsertMember.mock.calls).toEqual([[TEST_ORG, "dev1", 2000], [TEST_ORG, "dev2", 40]]);
    expect(db.get(budgetSyncedKey(TEST_ORG))).toMatchObject({ limitUsd: 900 });
    expect(db.get(budgetSyncedKey(TEST_ORG, "dev1"))).toMatchObject({ limitUsd: 2000 });
    await syncBudgets(d, TEST_ORG);
    expect(access.upsertMember).toHaveBeenCalledTimes(2);
  });

  it("syncBudgets writes no limit for an id that is not a member of this org (proxy users are global by id)", async () => {
    const { db, access, deps: d } = deps();
    seedMembership(db, "outsider", { orgId: "org_bbbbbbbbbbbbbbbbbbbb", role: "member" });
    await syncBudgets(d, TEST_ORG, ["outsider", "nobody", "dev1"]);
    expect(access.upsertMember.mock.calls).toEqual([[TEST_ORG, "dev1", DEFAULT_MEMBER_MONTHLY_BUDGET_USD]]);
    expect(db.get(budgetSyncedKey(TEST_ORG, "outsider"))).toBeUndefined();
  });

  it("ensureSynced upserts an org and a member once, and again only after their limit changes", async () => {
    const { db, access, deps: d } = deps();
    await ensureSynced(d, TEST_ORG, "dev1");
    await ensureSynced(d, TEST_ORG, "dev1");
    await ensureSynced(d, TEST_ORG, "dev2");
    expect(access.upsertOrg).toHaveBeenCalledTimes(1);
    expect(access.upsertMember.mock.calls).toEqual([[TEST_ORG, "dev1", DEFAULT_MEMBER_MONTHLY_BUDGET_USD], [TEST_ORG, "dev2", DEFAULT_MEMBER_MONTHLY_BUDGET_USD]]);
    db.set({ ...orgSettingsKey(TEST_ORG, "BUDGET"), orgMonthlyUsd: 100, memberDefaultMonthlyUsd: 5, memberOverrides: {} });
    await ensureSynced(d, TEST_ORG, "dev1");
    await ensureSynced(d, TEST_ORG, "dev1");
    expect(access.upsertOrg).toHaveBeenCalledTimes(2);
    expect(access.upsertOrg).toHaveBeenLastCalledWith(TEST_ORG, 100);
    expect(access.upsertMember).toHaveBeenCalledTimes(3);
    expect(access.upsertMember).toHaveBeenLastCalledWith(TEST_ORG, "dev1", 5);
  });

  it("ensureSynced leaves no marker when the proxy refuses, so the next call tries again", async () => {
    const { db, access, deps: d } = deps();
    access.goDown();
    expect((await rejection(ensureSynced(d, TEST_ORG, "dev1"))).code).toBe("MODEL_PROXY_UNAVAILABLE");
    expect(db.get(budgetSyncedKey(TEST_ORG))).toBeUndefined();
  });
});

describe("admitWork", () => {
  async function admission(spent: { member?: number; org?: number }, input: { developerId?: string | undefined; path?: "QUICK" | "FULL" | "CHAT" } = {}, limits?: { memberDefaultMonthlyUsd?: number; orgMonthlyUsd?: number; memberOverrides?: Record<string, number> }) {
    const db = new FakeDynamoDb();
    const access = fakeModelAccess();
    if (limits !== undefined) db.set({ ...orgSettingsKey(TEST_ORG, "BUDGET"), orgMonthlyUsd: DEFAULT_ORG_MONTHLY_BUDGET_USD, memberDefaultMonthlyUsd: DEFAULT_MEMBER_MONTHLY_BUDGET_USD, memberOverrides: {}, ...limits });
    access.setMemberSpent(TEST_ORG, "dev1", spent.member ?? 0);
    access.setOrgSpent(TEST_ORG, spent.org ?? 0);
    const developerId = "developerId" in input ? input.developerId : "dev1";
    return { db, access, run: () => admitMember({ documentClient: db, tableName: "state", access, cloud: true }, { orgId: TEST_ORG, ...(developerId === undefined ? {} : { developerId }), path: input.path ?? "QUICK" }) };
  }

  it("answers what is left to the member, never more than one task's budget", async () => {
    expect(await (await admission({ member: 10 })).run()).toEqual({ maxBudgetUsd: 19 });
    expect(await (await admission({}, {}, { memberOverrides: { dev1: 2000 } })).run()).toEqual({ maxBudgetUsd: PER_TASK_BUDGET_USD });
    // The org's remainder can be the smaller one.
    expect(await (await admission({ org: 497 }, {}, {})).run()).toEqual({ maxBudgetUsd: 3 });
  });

  it("refuses a member below the path's minimum with the exact message, amounts to two decimals", async () => {
    const error = await rejection((await admission({ member: 28.8 })).run());
    expect(error).toMatchObject({ code: "BUDGET_EXCEEDED", statusCode: 402, message: `BUDGET_EXCEEDED: ${BUDGET_EXCEEDED_TEXT("28.80", "29.00")}` });
  });

  it("applies each path's minimum: quick 0.50, full 2, chat 0.05", async () => {
    expect(MINIMUM_REMAINING_USD).toEqual({ QUICK: 0.5, FULL: 2, CHAT: 0.05, TASK: 0.5, AGENT: 0.1 });
    // $1.50 left: enough for QUICK and CHAT, not FULL.
    await expect((await admission({ member: 27.5 }, { path: "QUICK" })).run()).resolves.toEqual({ maxBudgetUsd: 1.5 });
    await expect((await admission({ member: 27.5 }, { path: "CHAT" })).run()).resolves.toEqual({ maxBudgetUsd: 1.5 });
    expect((await rejection((await admission({ member: 27.5 }, { path: "FULL" })).run())).code).toBe("BUDGET_EXCEEDED");
    // $0.30 left: CHAT only.
    expect((await rejection((await admission({ member: 28.7 }, { path: "QUICK" })).run())).code).toBe("BUDGET_EXCEEDED");
    await expect((await admission({ member: 28.7 }, { path: "CHAT" })).run()).resolves.toEqual({ maxBudgetUsd: 0.3 });
    expect((await rejection((await admission({ member: 28.97 }, { path: "CHAT" })).run())).code).toBe("BUDGET_EXCEEDED");
  });

  it("clamps an overspent member (a soft cap, ruling R23) at 0 and says what was spent", async () => {
    const error = await rejection((await admission({ member: 29.0617 })).run());
    expect(error).toMatchObject({ code: "BUDGET_EXCEEDED", message: `BUDGET_EXCEEDED: ${BUDGET_EXCEEDED_TEXT("29.06", "29.00")}` });
  });

  it("refuses an org below the minimum with its own message, after the member check", async () => {
    const error = await rejection((await admission({ org: 500 })).run());
    expect(error).toMatchObject({ code: "ORG_BUDGET_EXCEEDED", statusCode: 402, message: `ORG_BUDGET_EXCEEDED: ${ORG_BUDGET_MESSAGE}` });
    expect((await rejection((await admission({ org: 499.7 })).run())).code).toBe("ORG_BUDGET_EXCEEDED");
    // Both spent: the member's message wins.
    expect((await rejection((await admission({ member: 29, org: 500 })).run())).code).toBe("BUDGET_EXCEEDED");
  });

  it("answers an unlinked requester to the org alone", async () => {
    const open = await admission({ member: 500, org: 10 }, { developerId: undefined });
    expect(await open.run()).toEqual({ maxBudgetUsd: PER_TASK_BUDGET_USD });
    expect(open.access.orgSpend).toHaveBeenCalled();
    expect(open.access.spend).not.toHaveBeenCalled();
    expect(open.access.upsertMember).not.toHaveBeenCalled();
    expect((await rejection((await admission({ org: 500 }, { developerId: undefined })).run())).code).toBe("ORG_BUDGET_EXCEEDED");
  });

  it("answers MODEL_PROXY_UNAVAILABLE, with nothing of the proxy's detail, when the proxy cannot say", async () => {
    const down = await admission({});
    down.access.goDown();
    expect(await rejection(down.run())).toMatchObject({ code: "MODEL_PROXY_UNAVAILABLE", statusCode: 503 });
    const odd = await admission({});
    odd.access.spend.mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.0.0.7:4000"));
    const error = await rejection(odd.run());
    expect(error.code).toBe("MODEL_PROXY_UNAVAILABLE");
    expect(error.message).not.toContain("10.0.0.7");
  });
});

describe("the next key's cap (ruling R30)", () => {
  function setup() {
    const db = new FakeDynamoDb();
    const access = fakeModelAccess();
    access.setMemberSpent(TEST_ORG, "dev1", 0);
    access.setOrgSpent(TEST_ORG, 0);
    const mint = (budgetUsd: number, previousKeyIds: string[] = []) => nextKeyCap({ documentClient: db, tableName: "state", access, cloud: true }, { orgId: TEST_ORG, developerId: "dev1", budgetUsd, previousKeyIds });
    return { db, access, mint };
  }

  it("caps a first key at the task's budget", async () => {
    expect(await setup().mint(19)).toEqual({ maxBudgetUsd: 19 });
  });

  it("takes the spend of the task's earlier keys off the task's budget", async () => {
    const { access, mint } = setup();
    access.setKeySpent("sk-first", 10);
    access.setKeySpent("sk-second", 3.5);
    expect(await mint(25, [keyIdOf("sk-first")])).toEqual({ maxBudgetUsd: 15 });
    expect(await mint(25, [keyIdOf("sk-first"), keyIdOf("sk-second")])).toEqual({ maxBudgetUsd: 11.5 });
    expect(access.keySpend).toHaveBeenLastCalledWith([keyIdOf("sk-first"), keyIdOf("sk-second")]);
  });

  it("is limited by the member's and the org's remainder when they are smaller", async () => {
    const { access, mint } = setup();
    access.setMemberSpent(TEST_ORG, "dev1", 26);
    expect(await mint(25)).toEqual({ maxBudgetUsd: 3 });
    access.setOrgSpent(TEST_ORG, 499);
    expect(await mint(25)).toEqual({ maxBudgetUsd: 1 });
  });

  it("treats float dust as nothing left, so no key is capped at a millionth of a dollar", async () => {
    const { access, mint } = setup();
    access.setMemberSpent(TEST_ORG, "dev1", 29 - 0.0000004);
    expect((await rejection(mint(25))).code).toBe("BUDGET_EXCEEDED");
    access.setMemberSpent(TEST_ORG, "dev1", 0);
    access.setKeySpent("sk-first", 25 - 0.0000004);
    expect((await rejection(mint(25, [keyIdOf("sk-first")]))).code).toBe("BUDGET_EXCEEDED");
  });

  it("refuses a task that has spent its budget (a soft cap can leave it over), and a member or org with nothing left", async () => {
    const { access, mint } = setup();
    access.setKeySpent("sk-first", 25.4);
    const task = await rejection(mint(25, [keyIdOf("sk-first")]));
    expect(task).toMatchObject({ code: "BUDGET_EXCEEDED", statusCode: 402 });
    expect(task.message).toContain("This task has used its AI budget ($25.40 of $25.00)");
    // Ruling R38: the way on is Continue, never a new task.
    expect(task.message).toBe("BUDGET_EXCEEDED: This task has used its AI budget ($25.40 of $25.00). Choose Continue to resume this task with a fresh budget.");
    expect(task.message).not.toContain("new task");
    access.setMemberSpent(TEST_ORG, "dev1", 29);
    expect((await rejection(mint(25))).message).toBe(`BUDGET_EXCEEDED: ${BUDGET_EXCEEDED_TEXT("29.00", "29.00")}`);
    access.setMemberSpent(TEST_ORG, "dev1", 0);
    access.setOrgSpent(TEST_ORG, 500.2);
    expect((await rejection(mint(25))).code).toBe("ORG_BUDGET_EXCEEDED");
  });
});

describe("lost proxy state heals (the proxy's database restored or replaced)", () => {
  async function synced() {
    const db = new FakeDynamoDb();
    const access = fakeModelAccess();
    const deps = { documentClient: db, tableName: "state", access, cloud: true };
    await ensureSynced(deps, TEST_ORG, "dev1");
    access.setMemberSpent(TEST_ORG, "dev1", 3);
    access.setOrgSpent(TEST_ORG, 40);
    return { db, access, deps };
  }
  const mint = { orgId: TEST_ORG, developerId: "dev1", purpose: "task" as const, refId: "t-1", maxBudgetUsd: 5, ttlSeconds: 3600 };

  it("admission clears the markers, tells the proxy again and asks again, once", async () => {
    const { db, access, deps } = await synced();
    access.forgetEverything();
    expect(await admitMember(deps, { orgId: TEST_ORG, developerId: "dev1", path: "QUICK" })).toEqual({ maxBudgetUsd: 25 });
    expect(access.upsertOrg).toHaveBeenCalledTimes(2);
    expect(access.upsertMember).toHaveBeenCalledTimes(2);
    expect(db.get(budgetSyncedKey(TEST_ORG))).toMatchObject({ limitUsd: 500 });
    expect(db.get(budgetSyncedKey(TEST_ORG, "dev1"))).toMatchObject({ limitUsd: 29 });
    // Nothing is left to heal on the next call.
    await admitMember(deps, { orgId: TEST_ORG, developerId: "dev1", path: "QUICK" });
    expect(access.upsertOrg).toHaveBeenCalledTimes(2);
  });

  it("heals the org alone for work no known member started", async () => {
    const { access, deps } = await synced();
    access.forgetEverything();
    expect((await admitMember(deps, { orgId: TEST_ORG, path: "CHAT" })).maxBudgetUsd).toBeGreaterThan(0);
    expect(access.upsertOrg).toHaveBeenCalledTimes(2);
    expect(access.upsertMember).toHaveBeenCalledTimes(1);
  });

  it("asks again only once: a proxy that still does not know them is the proxy's fault", async () => {
    const { access, deps } = await synced();
    access.spend.mockRejectedValue(proxyError("NOT_FOUND", "model proxy refused the request (404): team does not exist"));
    expect((await rejection(admitMember(deps, { orgId: TEST_ORG, developerId: "dev1", path: "QUICK" }))).code).toBe("MODEL_PROXY_UNAVAILABLE");
    expect(access.spend).toHaveBeenCalledTimes(2);
  });

  it("mintKey heals on a 404 and on a 400 that says the team or user does not exist, and on nothing else", async () => {
    const { access, deps } = await synced();
    access.forgetEverything();
    expect((await mintKeyHealing(deps, mint)).key).toMatch(/^sk-fake-key-/);
    expect(access.upsertOrg).toHaveBeenCalledTimes(2);
    const real = access.mintKey.getMockImplementation()!;
    for (const message of ["model proxy refused the request (400): Team doesn't exist", "model proxy refused the request (400): User not found"]) {
      access.mintKey.mockImplementationOnce(async () => { throw proxyError("CONFIG_INVALID", message); });
      access.mintKey.mockImplementation(real);
      const before = access.upsertOrg.mock.calls.length;
      await mintKeyHealing(deps, mint);
      expect(access.upsertOrg.mock.calls.length, message).toBe(before + 1);
    }
    access.mintKey.mockImplementationOnce(async () => { throw proxyError("CONFIG_INVALID", "model proxy refused the request (400): max_budget must be a number"); });
    const upserts = access.upsertOrg.mock.calls.length;
    expect((await rejection(mintKeyHealing(deps, mint))).code).toBe("CONFIG_INVALID");
    expect(access.upsertOrg.mock.calls.length).toBe(upserts);
  });

  it("lets a running task mint again after the proxy lost its state", async () => {
    const access = fakeModelAccess();
    const h = await createDeveloperTaskBroker({ brokerExtra: { modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true } });
    access.setMemberSpent(TEST_ORG, MAYA.developerId, 0);
    access.setOrgSpent(TEST_ORG, 0);
    const started = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
    const taskId = (started.body.task as { taskId: string }).taskId;
    const task = h.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
    const operationId = String((h.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
    await h.finish(task.workspaceId, operationId, "SUCCEEDED");
    const active = String((h.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
    const capability = ((h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === active)[0]!).invocation as { callbackCapability: string }).callbackCapability;
    const ask = () => call(h.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": capability } });
    expect((await ask()).status).toBe(200);
    access.forgetEverything();
    // The key is a hit-or-miss minted again: the proxy is told again, then the key is made.
    expect((await ask()).status).toBe(200);
    expect(access.mintKey.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("a developer task start", () => {
  async function install(options: { memberSpent?: number; orgSpent?: number } = {}) {
    const access = fakeModelAccess();
    const harness = await createDeveloperTaskBroker({ brokerExtra: { modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true } });
    // A task with no workflow starts at the TASK estimate's run limit (Task 34); these tests are written for a task budget of $25.
    seedTaskRunLimit(harness.db);
    access.setMemberSpent(TEST_ORG, MAYA.developerId, options.memberSpent ?? 0);
    access.setOrgSpent(TEST_ORG, options.orgSpent ?? 0);
    const start = (extra: Record<string, unknown> = {}) => harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code", ...extra });
    const mark = harness.db.commandNames().length;
    return { ...harness, access, start, sent: () => sentSince(harness.db, mark) };
  }

  const chargeItems = (h: { db: FakeDynamoDb }) => h.db.find((item) => typeof item.pk === "string" && item.pk.includes("DEVELOPER_LIMIT"));

  it("refuses a member with $0.20 left on a quick task: 402 BUDGET_EXCEEDED with the exact message, and nothing is charged", async () => {
    const h = await install({ memberSpent: 28.8 });
    const response = await h.start();
    expect(response).toMatchObject({ status: 402, body: { error: { code: "BUDGET_EXCEEDED", message: BUDGET_EXCEEDED_TEXT("28.80", "29.00") } } });
    expect(chargeItems(h)).toEqual([]);
    expect(h.db.find((item) => item.entityType === "DEVELOPER_TASK")).toEqual([]);
    expect(h.sent()).not.toContain("TransactWriteCommand");
    // The refusal is audited like any other.
    expect(h.db.find((item) => typeof item.pk === "string" && item.pk.startsWith("TASK#") && item.phase === "refused")).toHaveLength(1);
    expect(h.access.mintKey).not.toHaveBeenCalled();
  });

  it("refuses an org at its limit with ORG_BUDGET_EXCEEDED and its exact message", async () => {
    const h = await install({ orgSpent: 500 });
    expect(await h.start()).toMatchObject({ status: 402, body: { error: { code: "ORG_BUDGET_EXCEEDED", message: ORG_BUDGET_MESSAGE } } });
    expect(chargeItems(h)).toEqual([]);
    expect(h.sent()).not.toContain("TransactWriteCommand");
  });

  it("checks a full workflow against its own, larger minimum", async () => {
    const h = await install({ memberSpent: 27.5 });
    expect((await h.start({ workflow: true, workflowPath: "FULL" })).status).toBe(402);
    expect((await h.start({ workflow: true, workflowPath: "QUICK" })).status).toBe(200);
  });

  it("starts the task with $10 spent of $29, recording the task's whole $25 budget (R38) while its key is capped at the member's $19", async () => {
    const h = await install({ memberSpent: 10 });
    const started = await h.start();
    expect(started.status).toBe(200);
    const taskId = (started.body.task as { taskId: string }).taskId;
    const task = h.db.get(`DEVTASK#${taskId}`, "META")!;
    expect(task.budgetUsd).toBe(25);
    expect(await (await worker(h, task))()).toMatchObject({ status: 200 });
    expect(h.access.mintKey).toHaveBeenCalledWith(expect.objectContaining({ orgId: TEST_ORG, developerId: MAYA.developerId, refId: taskId, maxBudgetUsd: 19 }));
    expect(JSON.stringify(started.body)).not.toContain("budgetUsd");
  });

  it("caps a member with a $2,000 override at one task's budget of $25", async () => {
    const h = await install();
    h.db.set({ ...orgSettingsKey(TEST_ORG, "BUDGET"), orgMonthlyUsd: 5000, memberDefaultMonthlyUsd: 29, memberOverrides: { [MAYA.developerId]: 2000 } });
    const started = await h.start();
    expect(started.status).toBe(200);
    const task = h.db.get(`DEVTASK#${(started.body.task as { taskId: string }).taskId}`, "META")!;
    expect(task.budgetUsd).toBe(25);
    await (await worker(h, task))();
    expect(h.access.mintKey).toHaveBeenCalledWith(expect.objectContaining({ maxBudgetUsd: 25 }));
    expect(h.access.limits().members.get(MAYA.developerId)).toBe(2000);
  });

  it("syncs the org and the member to the proxy before the first check, once", async () => {
    const h = await install();
    await h.start();
    await h.start();
    expect(h.access.upsertOrg.mock.calls).toEqual([[TEST_ORG, DEFAULT_ORG_MONTHLY_BUDGET_USD]]);
    expect(h.access.upsertMember.mock.calls).toEqual([[TEST_ORG, MAYA.developerId, DEFAULT_MEMBER_MONTHLY_BUDGET_USD]]);
  });

  it("fails fast with 503 MODEL_PROXY_UNAVAILABLE when the proxy is down, and writes no workspace, operation or charge", async () => {
    const h = await install();
    h.access.goDown();
    const response = await h.start();
    expect(response).toMatchObject({ status: 503, body: { error: { code: "MODEL_PROXY_UNAVAILABLE" } } });
    expect(h.sent()).not.toContain("TransactWriteCommand");
    expect(h.db.find((item) => ["WORKSPACE", "OPERATION", "DEVELOPER_TASK", "OUTBOX"].includes(String(item.entityType)))).toEqual([]);
    expect(chargeItems(h)).toEqual([]);
    // Nothing recorded, not even a refusal: the same request id can simply be sent again when the proxy is back.
    expect(h.db.find((item) => typeof item.pk === "string" && item.pk.startsWith("TASK#"))).toEqual([]);
  });

  it("refuses at the next start, after an admin lowers the default below what is spent, and leaves a running task's key alone", async () => {
    const h = await install({ memberSpent: 10 });
    const first = await h.start();
    expect(first.status).toBe(200);
    const task = h.db.get(`DEVTASK#${(first.body.task as { taskId: string }).taskId}`, "META")!;
    const mint = await worker(h, task);
    expect((await mint()).status).toBe(200);
    seedMembership(h.db, MAYA.developerId, { orgId: TEST_ORG, role: "admin" });
    const lowered = await h.dev(MAYA, "PUT", "/v1/dev/org/budget", { requestId: randomUUID(), memberDefaultMonthlyUsd: 5 });
    expect(lowered.status).toBe(200);
    expect(h.access.limits().orgs.get(TEST_ORG)).toBe(DEFAULT_ORG_MONTHLY_BUDGET_USD);
    const second = await h.start({ instructions: "One more" });
    expect(second).toMatchObject({ status: 402, body: { error: { code: "BUDGET_EXCEEDED", message: BUDGET_EXCEEDED_TEXT("10.00", "5.00") } } });
    expect(h.access.revokeKey).not.toHaveBeenCalled();
    // The running task keeps working on its minted key; its next key is capped by what the member has left, which is nothing.
    expect(JSON.stringify(h.db.get(`DEVTASK#${task.taskId as string}`, "META"))).toContain("modelKeyIds");
    expect((await mint()).status).toBe(402);
    expect(h.access.revokeKey).not.toHaveBeenCalled();
  });

  it("checks the budget before the workspace limit, so a member over both hears about the budget", async () => {
    const access = fakeModelAccess();
    const h = await createDeveloperTaskBroker({ memberLimit: 1, brokerExtra: { modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true } });
    access.setOrgSpent(TEST_ORG, 0);
    const start = () => h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
    expect((await start()).status).toBe(200);
    expect(await start()).toMatchObject({ status: 409, body: { error: { code: "WORKSPACE_LIMIT" } } });
    access.setMemberSpent(TEST_ORG, MAYA.developerId, 29);
    expect(await start()).toMatchObject({ status: 402, body: { error: { code: "BUDGET_EXCEEDED" } } });
  });

  it("does not check budgets on an install with no model proxy", async () => {
    const h = await createDeveloperTaskBroker();
    expect((await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" })).status).toBe(200);
  });

  /** Runs the task's preparation to completion, then answers a function that asks, with the worker's capability, for the model key. */
  async function worker(h: Awaited<ReturnType<typeof install>>, task: Record<string, unknown>) {
    const workspaceId = String(task.workspaceId);
    const active = () => String((h.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
    await h.finish(workspaceId, active(), "SUCCEEDED");
    const operationId = active();
    const outbox = h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!;
    const capability = (outbox.invocation as { callbackCapability: string }).callbackCapability;
    return () => call(h.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": capability } });
  }
});

describe("a task's keys across re-mints (ruling R30)", () => {
  async function runningTask(options: { memberSpent?: number } = {}) {
    const access = fakeModelAccess();
    const h = await createDeveloperTaskBroker({ brokerExtra: { modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true } });
    // A task with no workflow starts at the TASK estimate's run limit (Task 34); these tests are written for a task budget of $25.
    seedTaskRunLimit(h.db);
    access.setMemberSpent(TEST_ORG, MAYA.developerId, options.memberSpent ?? 0);
    access.setOrgSpent(TEST_ORG, 0);
    const started = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
    const taskId = (started.body.task as { taskId: string }).taskId;
    const task = h.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workspaceId: string };
    const active = () => String((h.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
    await h.finish(task.workspaceId, active(), "SUCCEEDED");
    const operationId = active();
    const outbox = h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!;
    const capability = (outbox.invocation as { callbackCapability: string }).callbackCapability;
    const ask = () => call(h.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": capability } });
    return { ...h, access, taskId, ask, record: () => h.db.get(`DEVTASK#${taskId}`, "META") as { budgetUsd: number; modelKeyIds?: string[] } };
  }

  it("records each key's id, never the key, and caps the next key at the budget less what the earlier ones spent", async () => {
    const h = await runningTask();
    expect((await h.ask()).status).toBe(200);
    const [first] = h.access.mintedKeys();
    expect(h.access.mintKey.mock.calls[0]![0].maxBudgetUsd).toBe(25);
    expect(h.record().modelKeyIds).toEqual([keyIdOf(first!)]);
    expect(JSON.stringify(h.db.find(() => true))).not.toContain(first);
    // What the task's owner reads back carries neither the key's id nor a budget field.
    const view = JSON.stringify((await h.dev(MAYA, "GET", `/v1/dev/tasks/${h.taskId}`)).body);
    expect(view).not.toContain(keyIdOf(first!));
    expect(view).not.toContain("modelKeyIds");
    h.access.setKeySpent(first!, 10);
    expect((await h.ask()).status).toBe(200);
    expect(h.access.mintKey.mock.calls[1]![0].maxBudgetUsd).toBe(15);
    expect(h.record().modelKeyIds).toEqual(h.access.mintedKeys().map(keyIdOf));
    expect(h.access.keySpend).toHaveBeenLastCalledWith([keyIdOf(first!)]);
  });

  it("answers 402 BUDGET_EXCEEDED once the task's keys have spent its budget, and mints nothing more", async () => {
    const h = await runningTask();
    await h.ask();
    h.access.setKeySpent(h.access.mintedKeys()[0]!, 25);
    const refused = await h.ask();
    expect(refused).toMatchObject({ status: 402, body: { error: { code: "BUDGET_EXCEEDED" } } });
    expect(h.access.mintKey).toHaveBeenCalledTimes(1);
    expect(h.record().modelKeyIds).toHaveLength(1);
  });

  it("answers 402 with the member's exact message when the member has nothing left, and ORG_BUDGET_EXCEEDED for the org", async () => {
    const h = await runningTask();
    h.access.setMemberSpent(TEST_ORG, MAYA.developerId, 29);
    expect(await h.ask()).toMatchObject({ status: 402, body: { error: { code: "BUDGET_EXCEEDED", message: BUDGET_EXCEEDED_TEXT("29.00", "29.00") } } });
    h.access.setMemberSpent(TEST_ORG, MAYA.developerId, 0);
    h.access.setOrgSpent(TEST_ORG, 500);
    expect(await h.ask()).toMatchObject({ status: 402, body: { error: { code: "ORG_BUDGET_EXCEEDED", message: ORG_BUDGET_MESSAGE } } });
    expect(h.access.mintKey).not.toHaveBeenCalled();
  });

  it("caps a key at what the member has left even when the task's budget is larger", async () => {
    const h = await runningTask();
    h.access.setMemberSpent(TEST_ORG, MAYA.developerId, 27);
    await h.ask();
    expect(h.access.mintKey.mock.calls[0]![0].maxBudgetUsd).toBe(2);
  });

  it("fails closed with 503, minting nothing, when the proxy cannot report an earlier key's spend", async () => {
    const h = await runningTask();
    expect((await h.ask()).status).toBe(200);
    h.access.keySpend.mockRejectedValueOnce(agentXError("NOT_FOUND", "key not found"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try { expect(await h.ask()).toMatchObject({ status: 503, body: { error: { code: "MODEL_PROXY_UNAVAILABLE" } } }); } finally { log.mockRestore(); }
    expect(h.access.mintKey).toHaveBeenCalledTimes(1);
    expect(h.record().modelKeyIds).toHaveLength(1);
  });

  it("two mints that race for one task cannot both take its remainder: the loser gives its key back and counts again with the winner's", async () => {
    const h = await runningTask();
    h.access.setKeySpent("sk-fake-key-0001", 10);
    const [a, b] = await Promise.all([h.ask(), h.ask()]);
    expect([a.status, b.status]).toEqual([200, 200]);
    // Three keys were minted: the winner (first), the loser, and the loser's retry.
    expect(h.access.mintedKeys()).toHaveLength(3);
    expect(h.access.mintKey.mock.calls.map(([input]) => input.maxBudgetUsd)).toEqual([25, 25, 15]);
    expect(h.access.revokeKey.mock.calls).toEqual([["sk-fake-key-0002"]]);
    expect(h.record().modelKeyIds).toEqual([keyIdOf("sk-fake-key-0001"), keyIdOf("sk-fake-key-0003")]);
    expect(new Set([a.body.apiKey, b.body.apiKey])).toEqual(new Set(["sk-fake-key-0001", "sk-fake-key-0003"]));
  });

  it("answers 503 after a second conflict, with both losing keys given back and nothing recorded for them", async () => {
    const h = await runningTask();
    const task = h.db.get(`DEVTASK#${h.taskId}`, "META")!;
    let racers = 0;
    // Every mint is overtaken by another mint of the same task, as the record shows.
    h.access.mintKey.mockImplementation(async () => {
      racers += 1;
      h.db.set({ ...(h.db.get(`DEVTASK#${h.taskId}`, "META") ?? task), modelKeyIds: [...(h.record().modelKeyIds ?? []), `racer-${String(racers)}`] });
      return { key: `sk-lost-${String(racers)}`, expiresAt: Date.now() + 3_600_000 };
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try { expect(await h.ask()).toMatchObject({ status: 503, body: { error: { code: "MODEL_PROXY_UNAVAILABLE" } } }); } finally { log.mockRestore(); }
    expect(h.access.mintKey).toHaveBeenCalledTimes(2);
    expect(h.access.revokeKey.mock.calls).toEqual([["sk-lost-1"], ["sk-lost-2"]]);
    expect(h.record().modelKeyIds).toEqual(["racer-1", "racer-2"]);
  });

  it("answers 503 and records no key when the proxy fails while minting", async () => {
    const h = await runningTask();
    h.access.mintKey.mockRejectedValueOnce(new Error("boom"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try { expect((await h.ask()).status).toBe(503); } finally { log.mockRestore(); }
    expect(h.record().modelKeyIds).toBeUndefined();
  });
});

describe("budget routes", () => {
  async function install() {
    const access = fakeModelAccess();
    const h = await createDeveloperTaskBroker({ brokerExtra: { modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true } });
    access.setMemberSpent(TEST_ORG, MAYA.developerId, 12.5);
    access.setOrgSpent(TEST_ORG, 80);
    return { ...h, access, asAdmin: () => seedMembership(h.db, MAYA.developerId, { orgId: TEST_ORG, role: "admin" }) };
  }

  it("GET /v1/dev/budget answers the caller's and the org's spend and limits", async () => {
    const h = await install();
    expect(await h.dev(MAYA, "GET", "/v1/dev/budget")).toMatchObject({
      status: 200, body: { member: { spentUsd: 12.5, limitUsd: 29 }, org: { spentUsd: 80, limitUsd: 500 } },
    });
  });

  it("GET /v1/dev/budget is 404 on an install with no model proxy", async () => {
    const h = await createDeveloperTaskBroker();
    expect((await h.dev(MAYA, "GET", "/v1/dev/budget")).status).toBe(404);
  });

  it("PUT /v1/dev/org/budget refuses a member with 403 and changes nothing", async () => {
    const h = await install();
    const refused = await h.dev(OMAR, "PUT", "/v1/dev/org/budget", { requestId: randomUUID(), orgMonthlyUsd: 10 });
    expect(refused).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN" } } });
    expect(h.db.get(orgSettingsKey(TEST_ORG, "BUDGET"))).toBeUndefined();
    expect(h.access.upsertOrg).not.toHaveBeenCalled();
  });

  it("PUT /v1/dev/org/budget refuses sub-microdollar values before any settings write or proxy sync", async () => {
    const h = await install();h.asAdmin();
    for (const amount of [12.3456789, 0.30000000000000004, 0.0000001]) for (const body of [{orgMonthlyUsd:amount},{memberDefaultMonthlyUsd:amount},{memberOverrides:{[OMAR.developerId]:amount}}]) {
      const response = await h.dev(MAYA,"PUT","/v1/dev/org/budget",{requestId:randomUUID(),...body});expect(response.status).toBe(400);expect(h.db.get(orgSettingsKey(TEST_ORG,"BUDGET"))).toBeUndefined();expect(h.access.upsertOrg).not.toHaveBeenCalled();expect(h.access.upsertMember).not.toHaveBeenCalled();
    }
  });
  it("PUT /v1/dev/org/budget retains exact whole-microdollar fractions and explicit zero",async()=>{const h=await install();h.asAdmin();for(const amount of [0,0.000001,0.29,1.000001]){const response=await h.dev(MAYA,"PUT","/v1/dev/org/budget",{requestId:randomUUID(),orgMonthlyUsd:amount,memberDefaultMonthlyUsd:amount,memberOverrides:{[OMAR.developerId]:amount}});expect(response.status).toBe(200);expect(h.db.get(orgSettingsKey(TEST_ORG,"BUDGET"))?.orgMonthlyUsd).toBe(amount);}});

  it("PUT /v1/dev/org/budget writes the settings, then tells the proxy the org and the members it named", async () => {
    const h = await install();
    h.asAdmin();
    const response = await h.dev(MAYA, "PUT", "/v1/dev/org/budget", { requestId: randomUUID(), orgMonthlyUsd: 800, memberDefaultMonthlyUsd: 40, memberOverrides: { [OMAR.developerId]: 2000 } });
    expect(response).toMatchObject({ status: 200, body: { budget: { orgMonthlyUsd: 800, memberDefaultMonthlyUsd: 40, memberOverrides: { [OMAR.developerId]: 2000 } } } });
    expect(h.db.get(orgSettingsKey(TEST_ORG, "BUDGET"))).toMatchObject({ orgMonthlyUsd: 800, memberDefaultMonthlyUsd: 40, memberOverrides: { [OMAR.developerId]: 2000 }, updatedBy: MAYA.developerId });
    expect(h.access.upsertOrg.mock.calls).toEqual([[TEST_ORG, 800]]);
    expect(h.access.upsertMember.mock.calls).toEqual([[TEST_ORG, OMAR.developerId, 2000]]);
    // What is not named stays; naming the overrides replaces them, and a member dropped from them goes back to the default.
    const next = await h.dev(MAYA, "PUT", "/v1/dev/org/budget", { requestId: randomUUID(), memberOverrides: {} });
    expect(next).toMatchObject({ status: 200, body: { budget: { orgMonthlyUsd: 800, memberDefaultMonthlyUsd: 40, memberOverrides: {} } } });
    expect(h.access.upsertMember).toHaveBeenLastCalledWith(TEST_ORG, OMAR.developerId, 40);
    // It re-syncs even when nothing changed.
    await h.dev(MAYA, "PUT", "/v1/dev/org/budget", { requestId: randomUUID(), memberOverrides: {} });
    expect(h.access.upsertOrg).toHaveBeenCalledTimes(3);
  });

  it("PUT /v1/dev/org/budget keeps a trial org within the placeholder limits (R49), and lets a team plan go higher", async () => {
    const h = await install();
    h.asAdmin();
    const meta = h.db.get(orgMetaKey(TEST_ORG).pk, orgMetaKey(TEST_ORG).sk) as Record<string, unknown>;
    h.db.set({ ...meta, plan: "trial" });
    const put = (body: Record<string, unknown>) => h.dev(MAYA, "PUT", "/v1/dev/org/budget", { requestId: randomUUID(), ...body });
    for (const body of [{ orgMonthlyUsd: DEFAULT_ORG_MONTHLY_BUDGET_USD + 1 }, { memberDefaultMonthlyUsd: DEFAULT_MEMBER_MONTHLY_BUDGET_USD + 1 }, { memberOverrides: { [OMAR.developerId]: 30 } }]) {
      expect(await put(body)).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID" } } });
    }
    expect(h.db.get(orgSettingsKey(TEST_ORG, "BUDGET"))).toBeUndefined();
    expect(h.access.upsertOrg).not.toHaveBeenCalled();
    // At or below the placeholders is fine, and lowering needs no plan.
    expect((await put({ orgMonthlyUsd: DEFAULT_ORG_MONTHLY_BUDGET_USD, memberDefaultMonthlyUsd: DEFAULT_MEMBER_MONTHLY_BUDGET_USD, memberOverrides: { [OMAR.developerId]: 10 } })).status).toBe(200);
    h.db.set({ ...meta, plan: "team" });
    expect(await put({ orgMonthlyUsd: 5000, memberDefaultMonthlyUsd: 300 })).toMatchObject({ status: 200, body: { budget: { orgMonthlyUsd: 5000, memberDefaultMonthlyUsd: 300 } } });
  });

  it("PUT /v1/dev/org/budget refuses an override for a developer of another org: 400, nothing written, the other org's cap unchanged", async () => {
    const h = await install();
    h.asAdmin();
    const orgB = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
    const other = "f".repeat(64);
    seedMembership(h.db, other, { orgId: orgB, role: "member" });
    await h.access.upsertMember(orgB, other, 50);
    h.access.upsertMember.mockClear();
    for (const overrides of [{ [other]: 100000 }, { [other]: 0 }, { [OMAR.developerId]: 40, [other]: 1 }, { nobody: 5 }]) {
      const response = await h.dev(MAYA, "PUT", "/v1/dev/org/budget", { requestId: randomUUID(), memberOverrides: overrides });
      expect(response).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID", message: "memberOverrides: every override must name a member of this organization" } } });
      expect(JSON.stringify(response.body)).not.toContain(other);
    }
    expect(h.db.get(orgSettingsKey(TEST_ORG, "BUDGET"))).toBeUndefined();
    expect(h.access.upsertOrg).not.toHaveBeenCalled();
    expect(h.access.upsertMember).not.toHaveBeenCalled();
    expect(h.access.limits().members.get(other)).toBe(50);
  });

  it("PUT /v1/dev/org/budget refuses a bad body with 400 and writes nothing", async () => {
    const h = await install();
    h.asAdmin();
    for (const body of [
      {}, { requestId: randomUUID() }, { requestId: "nope", orgMonthlyUsd: 1 }, { requestId: randomUUID(), orgMonthlyUsd: -1 },
      { requestId: randomUUID(), orgMonthlyUsd: 2_000_000 }, { requestId: randomUUID(), memberDefaultMonthlyUsd: "29" },
      { requestId: randomUUID(), memberOverrides: { dev: -5 } }, { requestId: randomUUID(), orgMonthlyUsd: 1, extra: true },
    ]) {
      expect(await h.dev(MAYA, "PUT", "/v1/dev/org/budget", body), JSON.stringify(body)).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID" } } });
    }
    expect(h.db.get(orgSettingsKey(TEST_ORG, "BUDGET"))).toBeUndefined();
    expect(h.access.upsertOrg).not.toHaveBeenCalled();
  });

  it("PUT /v1/dev/org/budget keeps the settings and answers 503 when the proxy cannot be told; the next start syncs", async () => {
    const h = await install();
    h.asAdmin();
    h.access.goDown();
    const response = await h.dev(MAYA, "PUT", "/v1/dev/org/budget", { requestId: randomUUID(), orgMonthlyUsd: 800 });
    expect(response).toMatchObject({ status: 503, body: { error: { code: "MODEL_PROXY_UNAVAILABLE" } } });
    expect(h.db.get(orgSettingsKey(TEST_ORG, "BUDGET"))).toMatchObject({ orgMonthlyUsd: 800 });
    expect(h.db.get(budgetSyncedKey(TEST_ORG))).toBeUndefined();
  });
});

describe("Slack-started work (ruling R31)", () => {
  beforeAll(loadSlackBroker);

  function install() {
    const access = fakeModelAccess();
    const { handler, db } = createBroker({ extra: { modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true } });
    let mark = 0;
    return { handler, db, access, ready: async () => { await registerSlackProject(handler); mark = db.commandNames().length; }, sent: () => sentSince(db, mark) };
  }
  const linked = developerIdForSlackUser(SLACK_USER);
  const workspaceItems = (db: FakeDynamoDb) => db.find((item) => item.entityType === "WORKSPACE" || item.entityType === "OPERATION" || item.entityType === "OUTBOX");

  it("refuses a linked member with no budget left before any charge: 402, no workspace, no limit counter", async () => {
    const h = install();
    await h.ready();
    seedMembership(h.db, linked, { orgId: TEST_ORG, role: "member" });
    h.access.setMemberSpent(TEST_ORG, linked, 29);
    h.access.setOrgSpent(TEST_ORG, 0);
    const response = await ensureWorkspace(h.handler, THREAD, SLACK_USER);
    expect(response).toMatchObject({ status: 402, body: { error: { code: "BUDGET_EXCEEDED", message: BUDGET_EXCEEDED_TEXT("29.00", "29.00") } } });
    expect(workspaceItems(h.db)).toEqual([]);
    expect(h.db.find((item) => typeof item.pk === "string" && item.pk.includes("LIMIT"))).toEqual([]);
    expect(h.sent()).not.toContain("TransactWriteCommand");
  });

  it("answers an unlinked requester to the org alone: the org's limit stops them, a member's figures do not", async () => {
    const h = install();
    await h.ready();
    h.access.setOrgSpent(TEST_ORG, 500);
    expect(await ensureWorkspace(h.handler, THREAD, SLACK_USER)).toMatchObject({ status: 402, body: { error: { code: "ORG_BUDGET_EXCEEDED", message: ORG_BUDGET_MESSAGE } } });
    expect(workspaceItems(h.db)).toEqual([]);
    h.access.setOrgSpent(TEST_ORG, 10);
    expect((await ensureWorkspace(h.handler, THREAD, SLACK_USER)).status).toBe(200);
    expect(h.access.spend).not.toHaveBeenCalled();
    expect(h.access.upsertMember).not.toHaveBeenCalled();
  });

  it("fails fast with 503 when the proxy is down, writing nothing", async () => {
    const h = install();
    await h.ready();
    h.access.goDown();
    expect(await ensureWorkspace(h.handler, THREAD, SLACK_USER)).toMatchObject({ status: 503, body: { error: { code: "MODEL_PROXY_UNAVAILABLE" } } });
    expect(workspaceItems(h.db)).toEqual([]);
    expect(h.sent()).not.toContain("TransactWriteCommand");
  });

  it("admits a lazily prepared thread when it is first charged, not when its record is made", async () => {
    const h = install();
    await h.ready();
    h.access.setOrgSpent(TEST_ORG, 500);
    const post = (path: string, body: Record<string, unknown>) => serviceCall(h.handler, THREAD, SLACK_USER, "POST", path, { requestId: randomUUID(), ...body });
    // A record with no compute and no charge needs no budget.
    expect(await post("/v1/service/threads/workspace", { lazyPreparation: true })).toMatchObject({ status: 200, body: { status: "UNPREPARED" } });
    expect(await post("/v1/service/threads/workspace/prepare", {})).toMatchObject({ status: 402, body: { error: { code: "ORG_BUDGET_EXCEEDED" } } });
    expect(h.db.find((item) => item.entityType === "SLACK_LIMIT")).toEqual([]);
    expect(h.db.find((item) => item.entityType === "OPERATION")).toEqual([]);
    h.access.setOrgSpent(TEST_ORG, 10);
    expect(await post("/v1/service/threads/workspace/prepare", {})).toMatchObject({ status: 200, body: { status: "PREPARING" } });
    expect(h.db.find((item) => item.entityType === "SLACK_LIMIT").length).toBeGreaterThan(0);
  });

  describe("the operation's key", () => {
    async function slackOperation() {
      const h = install();
      await h.ready();
      h.access.setOrgSpent(TEST_ORG, 0);
      const workspace = await ensureWorkspace(h.handler, THREAD, SLACK_USER);
      expect(workspace.status).toBe(200);
      const workspaceId = workspace.body.workspaceId as string;
      markReady(h.db, workspaceId);
      const conversation = await serviceCall(h.handler, THREAD, SLACK_USER, "POST", `/v1/service/workspaces/${workspaceId}/conversations`, {});
      const conversationId = (conversation.body.conversation as { id: string }).id;
      const task = await serviceCall(h.handler, THREAD, SLACK_USER, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, { requestId: randomUUID(), conversationId, prompt: "test it" });
      expect(task.status).toBe(202);
      const operationId = (task.body.operation as { id: string }).id;
      const capability = ((h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!.invocation) as { callbackCapability: string }).callbackCapability;
      const ask = () => call(h.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": capability } });
      return { ...h, workspaceId, operationId, ask, operation: () => h.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`) as { modelKeyIds?: string[] } };
    }

    it("goes to the org alone for an unlinked requester, capped by the org's remainder", async () => {
      const h = await slackOperation();
      h.access.setOrgSpent(TEST_ORG, 490);
      expect((await h.ask()).status).toBe(200);
      const input = h.access.mintKey.mock.calls[0]![0];
      expect(input).not.toHaveProperty("developerId");
      expect(input.maxBudgetUsd).toBe(10);
    });

    it("is capped cumulatively across the operation's re-mints, for a linked member", async () => {
      const h = await slackOperation();
      seedMembership(h.db, linked, { orgId: TEST_ORG, role: "member" });
      h.access.setMemberSpent(TEST_ORG, linked, 0);
      expect((await h.ask()).status).toBe(200);
      expect(h.access.mintKey.mock.calls[0]![0]).toMatchObject({ developerId: linked, refId: h.operationId, maxBudgetUsd: PER_TASK_BUDGET_USD });
      expect(h.operation().modelKeyIds).toEqual([keyIdOf(h.access.mintedKeys()[0]!)]);
      h.access.setKeySpent(h.access.mintedKeys()[0]!, 20);
      expect((await h.ask()).status).toBe(200);
      expect(h.access.mintKey.mock.calls[1]![0].maxBudgetUsd).toBe(5);
      h.access.setKeySpent(h.access.mintedKeys()[1]!, 5);
      expect(await h.ask()).toMatchObject({ status: 402, body: { error: { code: "BUDGET_EXCEEDED" } } });
      expect(h.access.mintKey).toHaveBeenCalledTimes(2);
    });
  });
});

describe("a Slack turn's key", () => {
  beforeAll(loadSlackBroker);

  it("syncs the org and the linked member to the proxy before a key names them, once", async () => {
    const access = fakeModelAccess();
    const { handler, db } = createBroker({ extra: { modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true } });
    await registerSlackProject(handler);
    seedMembership(db, developerIdForSlackUser(SLACK_USER), { orgId: TEST_ORG, role: "member" });
    const order: string[] = [];
    // The fake proxy keeps what it is told, which admission then reads; the order is noted on the way.
    const upsertOrg = access.upsertOrg.getMockImplementation()!;
    const upsertMember = access.upsertMember.getMockImplementation()!;
    access.upsertOrg.mockImplementation(async (...args) => { order.push("upsertOrg"); await upsertOrg(...args); });
    access.upsertMember.mockImplementation(async (...args) => { order.push("upsertMember"); await upsertMember(...args); });
    access.mintKey.mockImplementation(async () => { order.push("mintKey"); return { key: "sk-turn", expiresAt: Date.now() + 900_000 }; });
    const mint = (turnId: string) => serviceCall(handler, THREAD, SLACK_USER, "POST", "/v1/service/model-access", { turnId });
    expect((await mint("Ev1")).status).toBe(200);
    expect((await mint("Ev2")).status).toBe(200);
    expect(order).toEqual(["upsertOrg", "upsertMember", "mintKey", "mintKey"]);
  });
});

describe("sign-in", () => {
  function orgsOf(db: FakeDynamoDb) {
    return new OrgStore({ documentClient: db, tableName: "state", now: () => Date.parse("2026-10-19T12:00:00.000Z") });
  }
  const input = { method: "cloud" as const, developerId: "d".repeat(64), displayName: "Maya Chen", email: "maya@example.com", emailVerified: true };

  it("tells the proxy the new org and its owner after a first cloud sign-in creates the org", async () => {
    const db = new FakeDynamoDb();
    const access = fakeModelAccess();
    const orgs = orgsOf(db);
    const onOrgJoined = vi.fn(({ orgId, developerId }: { orgId: OrgId; developerId: string }) => syncBudgets({ documentClient: db, tableName: "state", access, orgs, cloud: true }, orgId, [developerId]));
    const org = await resolveOrgOnSignIn({ orgs, onOrgJoined }, input);
    expect(org.role).toBe("owner");
    expect(onOrgJoined).toHaveBeenCalledWith({ orgId: org.orgId, developerId: input.developerId });
    expect(access.upsertOrg).toHaveBeenCalledWith(org.orgId, DEFAULT_ORG_MONTHLY_BUDGET_USD);
    expect(access.upsertMember).toHaveBeenCalledWith(org.orgId, input.developerId, DEFAULT_MEMBER_MONTHLY_BUDGET_USD);
  });

  it("tells it when a sign-in joins the install's org, and not when the person already had one", async () => {
    const db = new FakeDynamoDb();
    const onOrgJoined = vi.fn(async () => undefined);
    const slack = { method: "slack" as const, developerId: "e".repeat(64), displayName: "Omar", emailVerified: false };
    const deps = { orgs: orgsOf(db), singleOrgId: TEST_ORG, singleOrgName: "staging", onOrgJoined };
    expect(await resolveOrgOnSignIn(deps, slack)).toEqual({ orgId: TEST_ORG, role: "member" });
    expect(onOrgJoined).toHaveBeenCalledTimes(1);
    expect(await resolveOrgOnSignIn(deps, slack)).toEqual({ orgId: TEST_ORG, role: "member" });
    expect(onOrgJoined).toHaveBeenCalledTimes(1);
  });

  it("never fails the sign-in when the proxy cannot be told, and logs only the error's name", async () => {
    const db = new FakeDynamoDb();
    const log = vi.fn();
    const onOrgJoined = vi.fn(async () => { throw agentXError("MODEL_PROXY_UNAVAILABLE", "model proxy is unreachable"); });
    const org = await resolveOrgOnSignIn({ orgs: orgsOf(db), onOrgJoined, log }, input);
    expect(org.role).toBe("owner");
    expect(log).toHaveBeenCalledWith({ event: "signin.org_hook_failed", errorName: "AgentXError" });
  });
});
