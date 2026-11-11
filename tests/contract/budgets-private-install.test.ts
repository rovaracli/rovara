// Ruling R47: a private or single-org install's org has no monthly cap until an operator sets one; only a cloud install's orgs start
// with the placeholder limits. Per-task caps still apply; operators retain their existing private-install credential authority.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_MEMBER_MONTHLY_BUDGET_USD, DEFAULT_ORG_MONTHLY_BUDGET_USD, PER_TASK_BUDGET_USD, budgetSyncedKey, orgSettingsKey } from "@agentx/cloud-contracts";
import { singleOrgIdForEnv } from "@rovara-code/contracts";
import { MAX_BUDGET_USD, readBudgets, syncBudgets } from "../../packages/broker/src/org/budget.js";
import { admitMember, nextKeyCap } from "../support/admission.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { adminCall, createAdminBroker } from "../support/admin-broker.js";
import { MAYA, createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { TEST_ENV, TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

const PROXY_URL = "http://internal-proxy.example.test:4000";
const rejection = async (action: Promise<unknown>) => {
  try { await action; } catch (error) { return error as { code: string; message: string }; }
  throw new Error("expected a rejection");
};
const INSTALL_ORG = singleOrgIdForEnv(TEST_ENV);

describe("budget settings on a private or single-org install", () => {
  it("start with no limit at all, where a cloud install's start with the placeholders", async () => {
    const db = new FakeDynamoDb();
    const access = fakeModelAccess();
    expect(await readBudgets({ documentClient: db, tableName: "state", access }, TEST_ORG)).toEqual({ memberOverrides: {} });
    expect(await readBudgets({ documentClient: db, tableName: "state", access, cloud: true }, TEST_ORG)).toEqual({ orgMonthlyUsd: DEFAULT_ORG_MONTHLY_BUDGET_USD, memberDefaultMonthlyUsd: DEFAULT_MEMBER_MONTHLY_BUDGET_USD, memberOverrides: {} });
  });

  it("tell the proxy its largest limit, so nothing there stops a member either", async () => {
    const db = new FakeDynamoDb();
    seedMembership(db, "dev1", { orgId: TEST_ORG, role: "member" });
    const access = fakeModelAccess();
    const orgs = new OrgStore({ documentClient: db, tableName: "state", now: () => 0 });
    await syncBudgets({ documentClient: db, tableName: "state", access, orgs }, TEST_ORG, ["dev1"]);
    expect(access.upsertOrg.mock.calls).toEqual([[TEST_ORG, MAX_BUDGET_USD]]);
    expect(access.upsertMember.mock.calls).toEqual([[TEST_ORG, "dev1", MAX_BUDGET_USD]]);
    expect(db.get(budgetSyncedKey(TEST_ORG, "dev1"))).toMatchObject({ limitUsd: MAX_BUDGET_USD });
  });

  it("admit a member far above $29 and an org far above $500, capping the key by the task alone", async () => {
    const db = new FakeDynamoDb();
    const access = fakeModelAccess();
    access.setMemberSpent(TEST_ORG, "dev1", 4000);
    access.setOrgSpent(TEST_ORG, 90000);
    const deps = { documentClient: db, tableName: "state", access, cloud: false };
    for (const path of ["QUICK", "FULL", "CHAT"] as const) {
      expect(await admitMember(deps, { orgId: TEST_ORG, developerId: "dev1", path })).toEqual({ maxBudgetUsd: PER_TASK_BUDGET_USD });
    }
    expect(await nextKeyCap(deps, { orgId: TEST_ORG, developerId: "dev1", budgetUsd: PER_TASK_BUDGET_USD, previousKeyIds: [] })).toEqual({ maxBudgetUsd: PER_TASK_BUDGET_USD });
    // The per-task cap still applies, and a Continue's baseline still resets it.
    access.setKeySpent("sk-old", 25);
    const previousKeyIds = [(await import("../../packages/broker/src/org/budget.js")).keyIdOf("sk-old")];
    expect((await rejection(nextKeyCap(deps, { orgId: TEST_ORG, developerId: "dev1", budgetUsd: PER_TASK_BUDGET_USD, previousKeyIds }))).code).toBe("BUDGET_EXCEEDED");
    expect(await nextKeyCap(deps, { orgId: TEST_ORG, developerId: "dev1", budgetUsd: PER_TASK_BUDGET_USD, previousKeyIds, budgetBaselineUsd: 25 })).toEqual({ maxBudgetUsd: PER_TASK_BUDGET_USD });
  });

  it("apply once an operator has set them", async () => {
    const db = new FakeDynamoDb();
    const access = fakeModelAccess();
    access.setMemberSpent(TEST_ORG, "dev1", 120);
    access.setOrgSpent(TEST_ORG, 300);
    const deps = { documentClient: db, tableName: "state", access, cloud: false };
    expect((await admitMember(deps, { orgId: TEST_ORG, developerId: "dev1", path: "QUICK" })).maxBudgetUsd).toBe(PER_TASK_BUDGET_USD);
    db.set({ ...orgSettingsKey(TEST_ORG, "BUDGET"), orgMonthlyUsd: 1000, memberDefaultMonthlyUsd: 100, memberOverrides: {} });
    expect((await rejection(admitMember(deps, { orgId: TEST_ORG, developerId: "dev1", path: "QUICK" }))).code).toBe("BUDGET_EXCEEDED");
    db.set({ ...orgSettingsKey(TEST_ORG, "BUDGET"), orgMonthlyUsd: 310, memberOverrides: {} });
    expect(await admitMember(deps, { orgId: TEST_ORG, developerId: "dev1", path: "QUICK" })).toEqual({ maxBudgetUsd: 10 });
    db.set({ ...orgSettingsKey(TEST_ORG, "BUDGET"), orgMonthlyUsd: 300, memberOverrides: {} });
    expect((await rejection(admitMember(deps, { orgId: TEST_ORG, developerId: "dev1", path: "QUICK" }))).code).toBe("ORG_BUDGET_EXCEEDED");
  });
});

describe("a developer task start on a single-org install", () => {
  it("admits a member with $400 spent and an org with $9,000 spent", async () => {
    const access = fakeModelAccess();
    const harness = await createDeveloperTaskBroker({ brokerExtra: { modelAccess: { access, proxyUrl: PROXY_URL } } });
    access.setMemberSpent(TEST_ORG, MAYA.developerId, 400);
    access.setOrgSpent(TEST_ORG, 9000);
    const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
    expect(response.status).toBe(200);
  });

  it("GET /v1/dev/budget shows no limit for either figure", async () => {
    const access = fakeModelAccess();
    const harness = await createDeveloperTaskBroker({ brokerExtra: { modelAccess: { access, proxyUrl: PROXY_URL } } });
    access.setMemberSpent(TEST_ORG, MAYA.developerId, 400);
    access.setOrgSpent(TEST_ORG, 9000);
    await harness.dev(MAYA, "GET", "/v1/dev/budget");
    expect(await harness.dev(MAYA, "GET", "/v1/dev/budget")).toMatchObject({ status: 200, body: { member: { spentUsd: 400, limitUsd: null }, org: { spentUsd: 9000, limitUsd: null } } });
  });
});

describe("PUT /v1/admin/org/budget", () => {
  beforeAll(loadSlackBroker);

  const put = (handler: Parameters<typeof adminCall>[0], body: unknown, admin = true) => adminCall(handler, { method: "PUT", path: "/v1/admin/org/budget", body, admin });

  it("operator PUT refuses excessive decimal precision before storage or proxy changes with readable copy",async()=>{const access=fakeModelAccess();const {handler,db}=await createAdminBroker({extra:{modelAccess:{access,proxyUrl:PROXY_URL}}});for(const body of [{orgMonthlyUsd:12.3456789},{memberDefaultMonthlyUsd:0.30000000000000004},{memberOverrides:{dev1:0.0000001}}]){const response=await put(handler,{requestId:randomUUID(),...body});expect(response.status).toBe(400);expect(JSON.stringify(response.body).includes("at most 6 decimal places")).toBe(true);expect(db.get(orgSettingsKey(INSTALL_ORG,"BUDGET"))).toBeUndefined();expect(access.upsertOrg).not.toHaveBeenCalled();expect(access.upsertMember).not.toHaveBeenCalled();}});

  it("lets an operator set the single org's caps, which then apply and reach the proxy", async () => {
    const access = fakeModelAccess();
    const { handler, db } = await createAdminBroker({ extra: { modelAccess: { access, proxyUrl: PROXY_URL } } });
    const response = await put(handler, { requestId: randomUUID(), orgMonthlyUsd: 2000, memberDefaultMonthlyUsd: 150 });
    expect(response).toMatchObject({ status: 200, body: { budget: { orgMonthlyUsd: 2000, memberDefaultMonthlyUsd: 150, memberOverrides: {} } } });
    expect(db.get(orgSettingsKey(INSTALL_ORG, "BUDGET"))).toMatchObject({ orgMonthlyUsd: 2000, memberDefaultMonthlyUsd: 150 });
    expect(db.get(orgSettingsKey(INSTALL_ORG, "BUDGET"))?.updatedBy).toMatch(/^op_[0-9a-f]{24}$/);
    expect(access.upsertOrg).toHaveBeenCalledWith(INSTALL_ORG, 2000);
    // The caps now apply: a member at $149.80 has too little left for a task.
    access.setMemberSpent(INSTALL_ORG, "dev1", 149.8);
    access.setOrgSpent(INSTALL_ORG, 10);
    await access.upsertMember(INSTALL_ORG, "dev1", 150);
    const error = await rejection(admitMember({ documentClient: db, tableName: "state", access, cloud: false }, { orgId: INSTALL_ORG, developerId: "dev1", path: "QUICK" }));
    expect(error.code).toBe("BUDGET_EXCEEDED");
  });

  it("refuses a caller without the administrator claim, an install with no model proxy, and a bad body", async () => {
    const access = fakeModelAccess();
    const { handler } = await createAdminBroker({ extra: { modelAccess: { access, proxyUrl: PROXY_URL } } });
    expect((await put(handler, { requestId: randomUUID(), orgMonthlyUsd: 1 }, false)).status).toBe(403);
    expect(await put(handler, { requestId: randomUUID() })).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID" } } });
    expect(await put(handler, { requestId: randomUUID(), orgMonthlyUsd: -4 })).toMatchObject({ status: 400 });
    const bare = await createAdminBroker();
    expect(await put(bare.handler, { requestId: randomUUID(), orgMonthlyUsd: 1 })).toMatchObject({ status: 404 });
  });

  it("is refused on a cloud install, where operators belong to no org and each org sets its own", async () => {
    const access = fakeModelAccess();
    const { handler, db } = await createAdminBroker({ extra: { modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true } });
    expect(await put(handler, { requestId: randomUUID(), orgMonthlyUsd: 2000 })).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN" } } });
    expect(db.get(orgSettingsKey(INSTALL_ORG, "BUDGET"))).toBeUndefined();
    expect(access.upsertOrg).not.toHaveBeenCalled();
  });
});
