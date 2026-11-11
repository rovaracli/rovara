import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { E2E_MODEL_ROUTE_DEFAULT_BUDGETS, OrgIdSchema, projectPk, type OrgId } from "@rovara-code/contracts";
import {
  e2eAccountDefinitionKey, e2eAccountLatestKey, e2eAccountRevisionPrefix,
} from "../../packages/broker/src/e2e/application-account-registry.js";
import { accountRegistryFences, planSetupAccountWrites, readAccountRegistryEntries } from "../../packages/broker/src/aws/e2e-account-registry.js";
import { handleE2EModelBudgetCallback, type E2EModelBudgetDependencies, type E2EModelBudgetOperation } from "../../packages/broker/src/e2e/model-budget-endpoint.js";
import { createBrokerE2EDayBudget, e2eDayBudgetRoom, e2eModelBudgetKey, e2eModelBudgetReservationKey } from "../../packages/broker/src/e2e/model-route-registry.js";
import { FakeDynamoDb, assumeDrivingTestsPassed } from "../support/fake-dynamodb.js";
import { apiApplicationsSnapshot } from "../support/e2e-application-round-harness.js";

assumeDrivingTestsPassed();

// Cross-org isolation of the two stores that the public mainline keyed by the bare project name: the E2E account registry and the AI navigation day budget. Two orgs can
// each have a project called "payments", and neither may see, count against or change the other's rows.

const ORG_A = OrgIdSchema.parse("org_aaaaaaaaaaaaaaaaaaaa");
const ORG_B = OrgIdSchema.parse("org_bbbbbbbbbbbbbbbbbbbb");
const TABLE = "state";
const NOW = Date.parse("2026-10-21T10:00:00.000Z");
const DAY = "2026-10-21";
const CAPS = { tokens: E2E_MODEL_ROUTE_DEFAULT_BUDGETS.maxInputTokensPerProjectDay, calls: E2E_MODEL_ROUTE_DEFAULT_BUDGETS.maxCallsPerProjectDay };
const LIMITS = { maxInputTokens: CAPS.tokens, maxCalls: CAPS.calls };
const store = (db: FakeDynamoDb) => ({ documentClient: { send: db.send } as unknown as DynamoDBDocumentClient, tableName: TABLE });

describe("the account registry is scoped by org", () => {
  const APP = "@acme/a";

  it("keys every row under the org's own project partition", () => {
    for (const org of [ORG_A, ORG_B]) {
      expect(e2eAccountDefinitionKey(org, "payments", APP, "orders-viewer", 3)).toEqual({ pk: projectPk(org, "payments"), sk: `E2E_ACCOUNT#${APP}#orders-viewer#REV#3` });
      expect(e2eAccountLatestKey(org, "payments", APP, "orders-viewer")).toEqual({ pk: projectPk(org, "payments"), sk: `E2E_ACCOUNT_LATEST#${APP}#orders-viewer` });
      expect(e2eAccountRevisionPrefix(org, "payments", APP, "orders-viewer").pk).toBe(projectPk(org, "payments"));
    }
    expect(e2eAccountLatestKey(ORG_A, "payments", APP, "p").pk).not.toBe(e2eAccountLatestKey(ORG_B, "payments", APP, "p").pk);
  });

  it("registers org A's accounts without registering, reading or fencing anything for org B's same-named project", async () => {
    const { snapshot } = apiApplicationsSnapshot(1);
    const db = new FakeDynamoDb();
    const setup = { approvedAt: "2026-10-20T00:00:00.000Z", proposalSha256: "a".repeat(64) };
    const apply = async (orgId: OrgId) => {
      const plan = await planSetupAccountWrites(store(db), { orgId, projectId: "payments", snapshot, setup, now: NOW });
      if (plan.items.length > 0) await db.send(new TransactWriteCommand({ TransactItems: plan.items }));
      return plan;
    };
    const planA = await apply(ORG_A);
    expect(planA.written).toBeGreaterThan(0);
    // Org B's plan is the whole registration again: org A's rows are no "prior" accounts of its project.
    const planB = await apply(ORG_B);
    expect(planB.written).toBe(planA.written);
    expect(planB.items).toHaveLength(planA.items.length);
    // Every row lives under one org's partition; none is under the bare name.
    const rows = db.find((row) => String(row.sk).startsWith("E2E_ACCOUNT"));
    expect(rows.length).toBe(planA.items.length + planB.items.length);
    expect(new Set(rows.map((row) => row.pk))).toEqual(new Set([projectPk(ORG_A, "payments"), projectPk(ORG_B, "payments")]));
    // Each org reads exactly its own accounts, and only they are fenced.
    const latest = db.find((row) => row.pk === projectPk(ORG_A, "payments") && String(row.sk).startsWith("E2E_ACCOUNT_LATEST#"));
    const pairs = latest.map((row) => { const [applicationId, profileId] = String(row.sk).slice("E2E_ACCOUNT_LATEST#".length).split("#"); return { applicationId: applicationId!, profileId: profileId! }; });
    const readA = await readAccountRegistryEntries(store(db), ORG_A, "payments", pairs);
    const readB = await readAccountRegistryEntries(store(db), ORG_B, "payments", pairs);
    expect(readA.entries).toHaveLength(pairs.length);
    expect(readB.entries).toHaveLength(pairs.length);
    expect(readA.corrupt).toEqual([]);
    expect(readB.corrupt).toEqual([]);
    const refs = readB.entries.map((entry) => ({ applicationId: entry.definition.applicationId, profileId: entry.definition.profileId })) as never;
    const fences = accountRegistryFences({ orgId: ORG_B, tableName: TABLE, projectId: "payments", refs, entries: readB.entries });
    expect(fences.length).toBeGreaterThan(0);
    for (const fence of fences) expect((fence as unknown as { ConditionCheck: { Key: { pk: string } } }).ConditionCheck.Key.pk).toBe(projectPk(ORG_B, "payments"));
  });

  it("finds nothing for an org that registered nothing, however many accounts another org's project of that name has", async () => {
    const { snapshot } = apiApplicationsSnapshot(1);
    const db = new FakeDynamoDb();
    const plan = await planSetupAccountWrites(store(db), { orgId: ORG_A, projectId: "payments", snapshot, setup: { approvedAt: "2026-10-20T00:00:00.000Z", proposalSha256: "b".repeat(64) }, now: NOW });
    await db.send(new TransactWriteCommand({ TransactItems: plan.items }));
    const one = db.find((row) => String(row.sk).startsWith("E2E_ACCOUNT_LATEST#"))[0]!;
    const [applicationId, profileId] = String(one.sk).slice("E2E_ACCOUNT_LATEST#".length).split("#");
    const other = await readAccountRegistryEntries(store(db), ORG_B, "payments", [{ applicationId: applicationId!, profileId: profileId! }]);
    expect(other).toEqual({ entries: [], corrupt: [] });
  });
});

describe("the AI navigation day budget is scoped by org", () => {
  it("keys the day and its reservations under the org's own project partition", () => {
    expect(e2eModelBudgetKey(ORG_A, "payments", DAY)).toEqual({ pk: projectPk(ORG_A, "payments"), sk: `E2E_MODEL_BUDGET#${DAY}` });
    expect(e2eModelBudgetReservationKey(ORG_B, "payments", "r-1")).toEqual({ pk: projectPk(ORG_B, "payments"), sk: "E2E_MODEL_BUDGET_RESERVATION#r-1" });
    expect(e2eModelBudgetKey(ORG_A, "payments", DAY).pk).not.toBe(e2eModelBudgetKey(ORG_B, "payments", DAY).pk);
  });

  it("the worker callback: the counter running out in org A leaves org B's same-named project untouched", async () => {
    const db = new FakeDynamoDb();
    const taskA = "11111111-aaaa-4bbb-8ccc-111111111111";
    const taskB = "11111111-bbbb-4bbb-8ccc-111111111111";
    const groupA = "22222222-aaaa-4bbb-8ccc-222222222222";
    const groupB = "22222222-bbbb-4bbb-8ccc-222222222222";
    db.set({ pk: `DEVTASK#${taskA}`, sk: "META", entityType: "DEVTASK", workspaceId: "ws-a", project: "payments", orgId: ORG_A });
    db.set({ pk: `DEVTASK#${taskB}`, sk: "META", entityType: "DEVTASK", workspaceId: "ws-b", project: "payments", orgId: ORG_B });
    const operation = (id: string, workspaceId: string, taskId: string, groupRunId: string): E2EModelBudgetOperation => ({ id, workspaceId, kind: "task", workflowMode: "CHECKS", status: "RUNNING",
      workflowE2EAdmission: { taskId, groupRunIds: [groupRunId], agentSteps: true } });
    const opA = operation("op-a", "ws-a", taskA, groupA);
    const opB = operation("op-b", "ws-b", taskB, groupB);
    const dependencies: E2EModelBudgetDependencies = { documentClient: { send: db.send }, tableName: TABLE, now: () => NOW,
      orgOf: async (record) => OrgIdSchema.parse(record.orgId) };
    const reserve = (op: E2EModelBudgetOperation, groupRunId: string, inputTokens: number) => handleE2EModelBudgetCallback(dependencies, op,
      { schemaVersion: "rovara-e2e-model-budget/v1", reservationId: randomUUID(), stage: "reserve", groupRunId, inputTokens });

    // Org A spends its whole day, one call at a time, until the broker answers exhausted.
    let reservedInA = 0;
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const answer = await reserve(opA, groupA, 64_000);
      if (answer.status === "exhausted") break;
      reservedInA += 1;
    }
    expect(reservedInA).toBeGreaterThan(0);
    expect((await reserve(opA, groupA, 64_000)).status).toBe("exhausted");
    // Org B's project of the same name still has its whole day, and its counter is its own.
    expect((await reserve(opB, groupB, 64_000)).status).toBe("reserved");
    expect(db.get(projectPk(ORG_B, "payments"), `E2E_MODEL_BUDGET#${DAY}`)).toMatchObject({ inputTokens: 64_000, calls: 1 });
    expect(db.get(projectPk(ORG_A, "payments"), `E2E_MODEL_BUDGET#${DAY}`)).toMatchObject({ calls: reservedInA });
    // Nothing is under the bare name.
    expect(db.find((row) => String(row.pk).startsWith("PROJECT#"))).toEqual([]);
  });

  it("the dispatch precheck reads the org's own day", async () => {
    const db = new FakeDynamoDb();
    db.set({ pk: projectPk(ORG_A, "payments"), sk: `E2E_MODEL_BUDGET#${DAY}`, inputTokens: CAPS.tokens - 1_000, calls: 10 });
    const need = { inputTokens: 400_000, calls: 12 };
    expect(await e2eDayBudgetRoom({ ...store(db), orgId: ORG_A, projectName: "payments", now: NOW }, need, LIMITS)).toBe(false);
    expect(await e2eDayBudgetRoom({ ...store(db), orgId: ORG_B, projectName: "payments", now: NOW }, need, LIMITS)).toBe(true);
  });

  it("the broker-backed day budget: org A's reservations, settles and releases never move org B's counter", async () => {
    const db = new FakeDynamoDb();
    const budgetA = createBrokerE2EDayBudget({ ...store(db), orgId: ORG_A, projectName: "payments", now: () => NOW });
    const budgetB = createBrokerE2EDayBudget({ ...store(db), orgId: ORG_B, projectName: "payments", now: () => NOW });
    const limits = { maxInputTokens: 1_000, maxCalls: 2 };
    const first = await budgetA.reserve(600, limits);
    expect(first).not.toBeNull();
    expect(await budgetA.reserve(600, limits)).toBeNull();
    // A's day is full for a second 600; B's is not.
    const inB = await budgetB.reserve(600, limits);
    expect(inB).not.toBeNull();
    await first!.release();
    expect(db.get(projectPk(ORG_A, "payments"), `E2E_MODEL_BUDGET#${DAY}`)).toMatchObject({ inputTokens: 0, calls: 0 });
    expect(db.get(projectPk(ORG_B, "payments"), `E2E_MODEL_BUDGET#${DAY}`)).toMatchObject({ inputTokens: 600, calls: 1 });
    await inB!.settle(100);
    expect(db.get(projectPk(ORG_B, "payments"), `E2E_MODEL_BUDGET#${DAY}`)).toMatchObject({ inputTokens: 100, calls: 1 });
    expect(db.get(projectPk(ORG_A, "payments"), `E2E_MODEL_BUDGET#${DAY}`)).toMatchObject({ inputTokens: 0, calls: 0 });
  });
});
