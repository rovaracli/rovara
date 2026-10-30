// Plan 3 Task 31: work is admitted, and its model keys are capped, at every budget level: the org, the member, the project, the agent and a
// member's test allowance, then the run's own limits. A key's cap is held (reserved) on every limited scope before the key is handed out, so
// concurrent work cannot spend the same dollars twice. These tests drive `admitWork` and `mintOperationKey` on a fake table and a fake proxy, and
// the broker's start, key and Slack routes through the developer-task harness.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_MEMBER_MONTHLY_BUDGET_USD, PER_TASK_BUDGET_USD, PER_TEST_CAP_USD, TASK_BUDGET_EXCEEDED_PREFIX,
  agentKey, errorStatus, modelKeyKey, orgMemberKey, orgMetaKey, orgRemovedKey, orgSettingsKey, pauseKey, scopeKey, spendCounterKey, topUpKey,
  builtinRecipe, builtinDefaultPin, currentBuiltinVersion, BUILTIN_AGENTS, type ResolvedRecipe, type BudgetScope, type OrgId, type PauseScope,
} from "@agentx/contracts";
import { singleOrgIdForEnv } from "../../packages/contracts/src/org-node.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { MINIMUM_REMAINING_USD, keyIdOf } from "../../packages/broker/src/org/budget.js";
import { SCOPE_ERRORS, admitWork, mintOperationKey, type AdmitWorkInput, type MintOperationKeyInput } from "../../packages/broker/src/spend/admission.js";
import { abandonKey, finalizeKey, readScopeCounters, registerKey, reserve, settleKey, type KeyInput, type LedgerDependencies, type ModelKeyRecord } from "../../packages/broker/src/spend/ledger.js";
import { budgetScopesFor, mintTagsFor } from "../../packages/broker/src/spend/payer.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { MAYA as DEV_MAYA, createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import { seedTaskRunLimit } from "../support/run-history.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, createBroker, ensureWorkspace, loadSlackBroker, markReady, registerSlackProject, serviceCall } from "../support/slack-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { fakeModelAccess, type FakeModelAccess } from "../support/fake-model-access.js";
import { TEST_ORG } from "../support/orgs.js";

const MONTH = "2026-10";
const T0 = Date.parse("2026-10-21T12:00:00.000Z");
const MAYA = "1".repeat(64);
const KIT = "2".repeat(64);
const AGENT = "agt_aaaaaaaaaaaaaaaaaaaaaaaa" as never;

const ORG: BudgetScope = { kind: "org" };
const WEB: BudgetScope = { kind: "project", project: "web" };

const rejection = async (action: Promise<unknown>) => {
  try { await action; } catch (error) { return error as { code: string; message: string; statusCode: number }; }
  throw new Error("expected a rejection");
};
const near = (value: number | undefined, expected: number) => expect(value ?? 0).toBeCloseTo(expected, 6);

/** A fake table and proxy for one org whose org and member limits are the placeholders, with the clock fixed. */
function setup(options: { cloud?: boolean } = {}) {
  const db = new FakeDynamoDb();
  const access: FakeModelAccess = fakeModelAccess();
  access.setMemberSpent(TEST_ORG, MAYA, 0);
  access.setMemberSpent(TEST_ORG, KIT, 0);
  access.setOrgSpent(TEST_ORG, 0);
  const deps = { documentClient: db, tableName: "state", access, now: () => T0, cloud: options.cloud ?? true };
  const ledger: LedgerDependencies = { documentClient: db, tableName: "state", access, now: () => T0, ...(deps.cloud ? { cloud: true } : {}) };
  const counter = (scope: BudgetScope | string, org: OrgId = TEST_ORG) => db.get(spendCounterKey(org, MONTH, typeof scope === "string" ? scope : scopeKey(scope))) as { spentUsd?: number; committedUsd?: number } | undefined;
  const seedCounter = (scope: BudgetScope, counts: { spentUsd?: number; committedUsd?: number }) => db.set({ ...spendCounterKey(TEST_ORG, MONTH, scopeKey(scope)), entityType: "SPEND_COUNTER", ...counts });
  const limitProject = (limitUsd: number, project = "web") => db.set({ pk: `ORG#${TEST_ORG}#PROJECT_AI#${project}`, sk: "SETTINGS", entityType: "PROJECT_AI", projectPays: false, monthlyBudgetUsd: limitUsd, revision: 1 });
  const limitAgent = (limitUsd: number) => db.set({ ...agentKey(TEST_ORG, AGENT, "META"), entityType: "AGENT_META", monthlyBudgetUsd: limitUsd });
  const limitOrg = (limitUsd: number) => db.set({ ...orgSettingsKey(TEST_ORG, "BUDGET"), entityType: "ORG_BUDGET", orgMonthlyUsd: limitUsd, memberDefaultMonthlyUsd: DEFAULT_MEMBER_MONTHLY_BUDGET_USD, memberOverrides: {} });
  return { db, access, deps, ledger, counter, seedCounter, limitProject, limitAgent, limitOrg };
}

const memberWork = (extra: Partial<AdmitWorkInput> = {}): AdmitWorkInput => ({
  orgId: TEST_ORG, payer: { kind: "member", developerId: MAYA }, project: "web", agentId: "rovara-code", agentName: "Rovara Code", path: "QUICK", ...extra,
});
const projectWork = (extra: Partial<AdmitWorkInput> = {}): AdmitWorkInput => memberWork({ payer: { kind: "project", project: "web" }, ...extra });
const agentWork = (extra: Partial<AdmitWorkInput> = {}): AdmitWorkInput => memberWork({ payer: { kind: "agent", agentId: AGENT }, agentId: AGENT, agentName: "Ticket Triage", ...extra });

describe("the levels' names", () => {
  it("minimums keep QUICK, FULL and CHAT and gain TASK and AGENT", () => {
    expect(MINIMUM_REMAINING_USD).toEqual({ QUICK: 0.5, FULL: 2, CHAT: 0.05, TASK: 0.5, AGENT: 0.1 });
  });

  it("each scope kind has the error it refuses with, and only the agent and the chain (Plan 4) have a required one", () => {
    expect(SCOPE_ERRORS).toEqual({
      org: { exceeded: "ORG_BUDGET_EXCEEDED" },
      member: { exceeded: "BUDGET_EXCEEDED" },
      project: { exceeded: "PROJECT_BUDGET_EXCEEDED" },
      agent: { required: "AGENT_BUDGET_REQUIRED", exceeded: "AGENT_BUDGET_EXCEEDED" },
      chain: { required: "CHAIN_BUDGET_REQUIRED", exceeded: "CHAIN_BUDGET_EXCEEDED" },
      testing: { exceeded: "TEST_ALLOWANCE_USED" },
    });
    expect([errorStatus("PROJECT_BUDGET_EXCEEDED"), errorStatus("AGENT_BUDGET_EXCEEDED"), errorStatus("TEST_ALLOWANCE_USED"), errorStatus("AGENT_BUDGET_REQUIRED")]).toEqual([402, 402, 402, 409]);
  });

  it("a pause names its scope: a budget scope by its scope key, a run's limits by the task", () => {
    const scopes: Array<[PauseScope, string]> = [
      [ORG, "ORG"], [{ kind: "member", developerId: MAYA }, `MEMBER#${MAYA}`], [WEB, "PROJECT#web"], [{ kind: "agent", agentId: AGENT }, `AGENT#${String(AGENT)}`],
      [{ kind: "testing", developerId: MAYA }, `TESTING#${MAYA}`],
      [{ kind: "task", taskId: "t-1" }, "TASK#t-1"], [{ kind: "max_per_run", taskId: "t-1" }, "MAX_PER_RUN#t-1"],
      [{ kind: "test", taskId: "t-1" }, "TEST#t-1"], [{ kind: "planning", taskId: "t-1" }, "PLANNING#t-1"],
    ];
    for (const [scope, key] of scopes) expect(pauseKey(scope)).toBe(key);
    expect(new Set(scopes.map(([scope]) => pauseKey(scope))).size).toBe(scopes.length);
  });
});

describe("admitWork", () => {
  it("answers what is left at the smallest level, never more than one task's budget", async () => {
    const t = setup();
    expect(await admitWork(t.deps, memberWork())).toEqual({ maxBudgetUsd: PER_TASK_BUDGET_USD });
    t.limitProject(3.5);
    expect(await admitWork(t.deps, memberWork())).toEqual({ maxBudgetUsd: 3.5 });
    t.access.setMemberSpent(TEST_ORG, MAYA, 27);
    expect(await admitWork(t.deps, memberWork())).toEqual({ maxBudgetUsd: 2 });
  });

  it("refuses a project below the path's minimum with the exact message, counting what keys hold as used", async () => {
    const t = setup();
    t.limitProject(5);
    t.seedCounter(WEB, { spentUsd: 1, committedUsd: 4.7 });
    const error = await rejection(admitWork(t.deps, memberWork()));
    expect(error).toMatchObject({ code: "PROJECT_BUDGET_EXCEEDED", statusCode: 402, message: "PROJECT_BUDGET_EXCEEDED: The web project's monthly AI budget is used up ($4.70 of $5.00). Ask for more from the project's page." });
    // The same room is enough for a path that needs less.
    expect(await admitWork(t.deps, memberWork({ path: "CHAT" }))).toEqual({ maxBudgetUsd: 0.3 });
  });

  it("admits work with exactly the path's minimum left, and refuses it with a cent less", async () => {
    const t = setup();
    t.limitProject(5);
    t.seedCounter(WEB, { committedUsd: 4.5 });
    expect(await admitWork(t.deps, memberWork({ path: "QUICK" }))).toEqual({ maxBudgetUsd: 0.5 });
    t.seedCounter(WEB, { committedUsd: 4.51 });
    expect((await rejection(admitWork(t.deps, memberWork({ path: "QUICK" })))).code).toBe("PROJECT_BUDGET_EXCEEDED");
  });

  it("holds a project's top-up for the month to its limit", async () => {
    const t = setup();
    t.limitProject(5);
    t.db.set({ ...topUpKey(TEST_ORG, MONTH, WEB), entityType: "TOPUP", amountUsd: 5 });
    t.seedCounter(WEB, { committedUsd: 8 });
    expect(await admitWork(t.deps, memberWork())).toEqual({ maxBudgetUsd: 2 });
  });

  it("lets a project with no limit through, and refuses nothing for a project whose limit is not set", async () => {
    const t = setup();
    t.seedCounter(WEB, { committedUsd: 900 });
    expect(await admitWork(t.deps, memberWork())).toEqual({ maxBudgetUsd: PER_TASK_BUDGET_USD });
  });

  it("counts what running keys hold against the member's and the org's limit as well as the proxy's figure", async () => {
    const t = setup();
    t.seedCounter({ kind: "member", developerId: MAYA }, { committedUsd: 28.8 });
    expect((await rejection(admitWork(t.deps, memberWork()))).code).toBe("BUDGET_EXCEEDED");
    const o = setup();
    o.limitOrg(10);
    o.seedCounter(ORG, { committedUsd: 9.8 });
    expect((await rejection(admitWork(o.deps, memberWork()))).code).toBe("ORG_BUDGET_EXCEEDED");
  });

  it("says the money is held by running work, not spent, when that is what is short", async () => {
    const t = setup();
    t.access.setMemberSpent(TEST_ORG, MAYA, 3);
    t.seedCounter({ kind: "member", developerId: MAYA }, { spentUsd: 3, committedUsd: 28.8 });
    const member = await rejection(admitWork(t.deps, memberWork()));
    expect(member).toMatchObject({ code: "BUDGET_EXCEEDED", statusCode: 402 });
    expect(member.message).toBe("BUDGET_EXCEEDED: Your monthly AI budget is used or held for work that is running ($28.80 of $29.00). Try again when it finishes, or ask an admin to raise it.");
    expect(member.message).not.toContain("$3.00");
    const o = setup();
    o.limitOrg(10);
    o.seedCounter(ORG, { spentUsd: 1, committedUsd: 9.8 });
    const org = await rejection(admitWork(o.deps, memberWork()));
    expect(org).toMatchObject({ code: "ORG_BUDGET_EXCEEDED", message: "ORG_BUDGET_EXCEEDED: Your company's monthly AI budget is committed to work that is running. Try again when it finishes, or ask an admin to raise it." });
    // What the proxy says is spent keeps the older words.
    const spent = setup();
    spent.access.setMemberSpent(TEST_ORG, MAYA, 28.8);
    spent.seedCounter({ kind: "member", developerId: MAYA }, { spentUsd: 28.8, committedUsd: 28.8 });
    expect((await rejection(admitWork(spent.deps, memberWork()))).message).toBe("BUDGET_EXCEEDED: Your monthly AI budget is used up ($28.80 of $29.00). Ask an admin to raise it.");
  });

  it("starts a project-paid run whose member is over their own limit", async () => {
    const t = setup();
    t.access.setMemberSpent(TEST_ORG, MAYA, 29.4);
    expect(await admitWork(t.deps, projectWork())).toEqual({ maxBudgetUsd: PER_TASK_BUDGET_USD });
    expect(t.access.spend).not.toHaveBeenCalled();
    expect(t.access.upsertMember).not.toHaveBeenCalled();
    expect((await rejection(admitWork(t.deps, memberWork()))).code).toBe("BUDGET_EXCEEDED");
  });

  it("refuses an agent payer with no effective budget, whatever the path, with the exact message and a 409", async () => {
    const t = setup();
    const error = await rejection(admitWork(t.deps, agentWork()));
    expect(error).toMatchObject({ code: "AGENT_BUDGET_REQUIRED", statusCode: 409, message: "AGENT_BUDGET_REQUIRED: Ticket Triage has no monthly budget, so it can't run work that no person started. Ask its owner to set one." });
    // Work a person started is not an agent payer's: the agent's budget, set or not, does not limit it.
    expect(await admitWork(t.deps, memberWork({ agentId: AGENT, agentName: "Ticket Triage" }))).toEqual({ maxBudgetUsd: PER_TASK_BUDGET_USD });
  });

  it("refuses an agent below the agent path's minimum, and answers its remainder", async () => {
    const t = setup();
    t.limitAgent(20);
    t.seedCounter({ kind: "agent", agentId: AGENT }, { committedUsd: 19.95 });
    const error = await rejection(admitWork(t.deps, agentWork({ path: "AGENT" })));
    expect(error).toMatchObject({ code: "AGENT_BUDGET_EXCEEDED", statusCode: 402, message: "AGENT_BUDGET_EXCEEDED: Ticket Triage's monthly AI budget is used up ($19.95 of $20.00). Ask its owner for more." });
    t.seedCounter({ kind: "agent", agentId: AGENT }, { committedUsd: 19.7 });
    expect(await admitWork(t.deps, agentWork({ path: "AGENT" }))).toEqual({ maxBudgetUsd: 0.3 });
  });

  it("counts a test run on the starter's testing allowance, not on the project's payer or the member", async () => {
    const t = setup();
    t.seedCounter({ kind: "testing", developerId: KIT }, { committedUsd: 9.8 });
    const error = await rejection(admitWork(t.deps, projectWork({ testRunBy: KIT })));
    expect(error).toMatchObject({ code: "TEST_ALLOWANCE_USED", statusCode: 402, message: "TEST_ALLOWANCE_USED: Your testing allowance for this month is used up ($9.80 of $10.00). Run the agent as a normal task instead." });
    t.seedCounter({ kind: "testing", developerId: KIT }, { committedUsd: 8 });
    expect(await admitWork(t.deps, projectWork({ testRunBy: KIT }))).toEqual({ maxBudgetUsd: 2 });
    expect(t.access.spend).not.toHaveBeenCalled();
  });

  it("asks nothing of the proxy about a member whose own budget the work does not count against", async () => {
    const t = setup();
    // A test run is the starter's testing allowance and no member's, whoever the payer is named.
    await admitWork(t.deps, memberWork({ testRunBy: KIT }));
    expect(t.access.spend).not.toHaveBeenCalled();
    expect(t.access.upsertMember).not.toHaveBeenCalled();
    expect(t.access.orgSpend).toHaveBeenCalled();
  });

  it("answers the member's message before the org's, and a project's before the agent's", async () => {
    const t = setup();
    t.access.setMemberSpent(TEST_ORG, MAYA, 29);
    t.access.setOrgSpent(TEST_ORG, 500);
    expect((await rejection(admitWork(t.deps, memberWork()))).code).toBe("BUDGET_EXCEEDED");
    const a = setup();
    a.limitProject(1);
    a.limitAgent(1);
    a.seedCounter(WEB, { committedUsd: 1 });
    a.seedCounter({ kind: "agent", agentId: AGENT }, { committedUsd: 1 });
    expect((await rejection(admitWork(a.deps, agentWork()))).code).toBe("PROJECT_BUDGET_EXCEEDED");
  });

  it("checks the trial and the month's machine time first, on a cloud install, before the proxy is asked anything", async () => {
    const t = setup();
    t.db.set({ ...orgMetaKey(TEST_ORG), entityType: "ORG_META", plan: "trial", createdBy: "someone" });
    expect((await rejection(admitWork(t.deps, memberWork()))).code).toBe("TRIAL_LOCKED");
    expect(t.access.upsertOrg).not.toHaveBeenCalled();
    expect(t.access.orgSpend).not.toHaveBeenCalled();
  });

  it("answers MODEL_PROXY_UNAVAILABLE, with nothing of the proxy's detail, when the proxy cannot say", async () => {
    const t = setup();
    t.access.goDown();
    expect(await rejection(admitWork(t.deps, memberWork()))).toMatchObject({ code: "MODEL_PROXY_UNAVAILABLE", statusCode: 503 });
  });

  it("writes nothing when it refuses, apart from telling the proxy the limits", async () => {
    const t = setup();
    t.limitProject(1);
    t.seedCounter(WEB, { committedUsd: 1 });
    const writes: string[] = [];
    const stop = t.db.onWrite(({ before, after }) => writes.push(String((after ?? before)?.entityType)));
    await rejection(admitWork(t.deps, memberWork()));
    stop();
    expect(writes.filter((entityType) => entityType !== "BUDGET_SYNCED")).toEqual([]);
    expect(t.db.commandNames()).not.toContain("TransactWriteCommand");
  });
});


// ---- the key's cap ----

const WEB_PLACE = { project: "web" };
const OPERATION_KEY = { pk: "WORKSPACE#ws-1", sk: "OPERATION#op-1" };
type MintOutcome = Awaited<ReturnType<typeof mintOperationKey>>;

/** A member's task in the web project: the budgets it counts against and the tags it is minted with (the key reserves only when both are given). */
function taskInput(extra: Partial<MintOperationKeyInput> = {}, taskId = "task-1"): MintOperationKeyInput {
  const payer = { kind: "member", developerId: MAYA } as const;
  return {
    orgId: TEST_ORG, developerId: MAYA, refId: taskId, ttlSeconds: 3600, agentName: "Rovara Code",
    scopes: budgetScopesFor(payer, WEB_PLACE, { agentId: "rovara-code" }),
    tags: mintTagsFor({ payer, place: WEB_PLACE, agentId: "rovara-code", origin: "app", taskId, operationId: "op-1" }),
    runLimitUsd: 25, stopAtUsd: 25, taskKeyIds: [], pause: { taskId, key: taskKey(taskId) },
    ...extra,
  };
}
/** A test run of a draft agent, started by Kit: the project pays and Kit's testing allowance is counted. */
function testRunInput(extra: Partial<MintOperationKeyInput> = {}, taskId = "test-1"): MintOperationKeyInput {
  const payer = { kind: "project", project: "web" } as const;
  const { developerId: _developerId, ...rest } = taskInput({}, taskId); // eslint-disable-line @typescript-eslint/no-unused-vars -- a test run is minted in no member's name
  return {
    ...rest, scopes: budgetScopesFor(payer, WEB_PLACE, { agentId: AGENT, testRunBy: KIT }),
    tags: mintTagsFor({ payer, place: WEB_PLACE, agentId: AGENT, origin: "test_run", taskId, operationId: "op-1" }),
    testCapUsd: PER_TEST_CAP_USD, ...extra,
  };
}
/** A mint that reserves (the ledger is given) and one that only works out the cap (no tags, so no reservation, and no ledger). */
const reserving = (t: ReturnType<typeof setup>, input: MintOperationKeyInput) => mintOperationKey({ ...t.deps, ledger: t.ledger }, input);
const capping = (t: ReturnType<typeof setup>, input: MintOperationKeyInput) => {
  const { tags: _tags, ...rest } = input; // eslint-disable-line @typescript-eslint/no-unused-vars -- no tags, so no reservation
  return mintOperationKey(t.deps, rest);
};
const minted = (outcome: MintOutcome) => {
  if (outcome.outcome !== "minted") throw new Error("expected a minted key");
  return outcome;
};
const seedTask = (t: ReturnType<typeof setup>, taskId = "task-1", extra: Record<string, unknown> = {}) => {
  t.db.set({ ...taskKey(taskId), entityType: "DEVELOPER_TASK", taskId, orgId: TEST_ORG, ...extra });
  t.db.set({ ...OPERATION_KEY, entityType: "OPERATION" });
};
const pauseOf = (t: ReturnType<typeof setup>, taskId = "task-1") => (t.db.get(taskKey(taskId)) as { budgetPause?: { scope: PauseScope; at: string } } | undefined)?.budgetPause;

describe("mintOperationKey: the cap", () => {
  it("is the run limit less what the task's keys spent in this window", async () => {
    const t = setup();
    expect(minted(await capping(t, taskInput())).maxBudgetUsd).toBe(25);
    t.access.setKeySpent("sk-first", 10);
    expect(minted(await capping(t, taskInput({ taskKeyIds: [keyIdOf("sk-first")] }))).maxBudgetUsd).toBe(15);
    // Ruling R38: a Continue starts a new window at what had been spent.
    expect(minted(await capping(t, taskInput({ taskKeyIds: [keyIdOf("sk-first")], budgetBaselineUsd: 10 }))).maxBudgetUsd).toBe(25);
    expect(t.access.mintKey.mock.calls.at(-1)![0]).toMatchObject({ maxBudgetUsd: 25, purpose: "task", refId: "task-1", developerId: MAYA });
  });

  it("is held to the least room at any level: the project, the member and the org", async () => {
    const t = setup();
    t.limitProject(5);
    t.seedCounter(WEB, { committedUsd: 3.5 });
    expect(minted(await capping(t, taskInput())).maxBudgetUsd).toBe(1.5);
    const m = setup();
    m.access.setMemberSpent(TEST_ORG, MAYA, 27);
    expect(minted(await capping(m, taskInput())).maxBudgetUsd).toBe(2);
    const o = setup();
    o.access.setOrgSpent(TEST_ORG, 499);
    expect(minted(await capping(o, taskInput())).maxBudgetUsd).toBe(1);
    // What other keys hold on the member counts as well as the proxy's figure.
    const h = setup();
    h.seedCounter({ kind: "member", developerId: MAYA }, { committedUsd: 25 });
    expect(minted(await capping(h, taskInput())).maxBudgetUsd).toBe(4);
  });

  it("stops at the agent's max per run when that is lower than the run limit, and pauses with max_per_run", async () => {
    const t = setup();
    seedTask(t);
    t.access.setKeySpent("sk-first", 1);
    expect(minted(await capping(t, taskInput({ runLimitUsd: 20, stopAtUsd: 3, taskKeyIds: [keyIdOf("sk-first")] }))).maxBudgetUsd).toBe(2);
    t.access.setKeySpent("sk-first", 3);
    const error = await rejection(capping(t, taskInput({ runLimitUsd: 20, stopAtUsd: 3, taskKeyIds: [keyIdOf("sk-first")] })));
    expect(error).toMatchObject({ code: "BUDGET_EXCEEDED", statusCode: 402, message: `BUDGET_EXCEEDED: ${TASK_BUDGET_EXCEEDED_PREFIX} ($3.00 of $3.00). Choose Continue to resume this task with a fresh budget.` });
    expect(pauseOf(t)).toMatchObject({ scope: { kind: "max_per_run", taskId: "task-1" } });
  });

  it("stops an agent with no max per run only at the run limit, with a task pause", async () => {
    const t = setup();
    seedTask(t);
    t.access.setKeySpent("sk-first", 19.5);
    expect(minted(await capping(t, taskInput({ runLimitUsd: 20, stopAtUsd: 20, taskKeyIds: [keyIdOf("sk-first")] }))).maxBudgetUsd).toBe(0.5);
    t.access.setKeySpent("sk-first", 20);
    const error = await rejection(capping(t, taskInput({ runLimitUsd: 20, stopAtUsd: 20, taskKeyIds: [keyIdOf("sk-first")] })));
    expect(error.message).toBe(`BUDGET_EXCEEDED: ${TASK_BUDGET_EXCEEDED_PREFIX} ($20.00 of $20.00). Choose Continue to resume this task with a fresh budget.`);
    expect(pauseOf(t)).toMatchObject({ scope: { kind: "task", taskId: "task-1" } });
  });

  it("pauses with planning while the plan is being made, when the run limit is the planning limit", async () => {
    const t = setup();
    seedTask(t);
    t.access.setKeySpent("sk-first", 6);
    await rejection(capping(t, taskInput({ runLimitUsd: 6, stopAtUsd: 6, planning: true, taskKeyIds: [keyIdOf("sk-first")] })));
    expect(pauseOf(t)).toMatchObject({ scope: { kind: "planning", taskId: "task-1" } });
  });

  it("holds a test run to the per-test cap, and pauses with test when that is used", async () => {
    const t = setup();
    seedTask(t, "test-1");
    expect(minted(await capping(t, testRunInput())).maxBudgetUsd).toBe(PER_TEST_CAP_USD);
    t.access.setKeySpent("sk-first", PER_TEST_CAP_USD);
    const error = await rejection(capping(t, testRunInput({ taskKeyIds: [keyIdOf("sk-first")] })));
    expect(error.message).toBe(`BUDGET_EXCEEDED: ${TASK_BUDGET_EXCEEDED_PREFIX} ($2.00 of $2.00). Choose Continue to resume this task with a fresh budget.`);
    expect(pauseOf(t, "test-1")).toMatchObject({ scope: { kind: "test", taskId: "test-1" } });
    // The testing allowance is Kit's; the key is minted in no member's name.
    expect(t.access.mintKey.mock.calls.at(-1)![0].developerId).toBeUndefined();
  });

  it("measures a test run's cap across the whole run: a Continue does not give it a fresh one", async () => {
    const t = setup();
    seedTask(t, "test-1");
    t.access.setKeySpent("sk-first", PER_TEST_CAP_USD);
    const input = testRunInput({ taskKeyIds: [keyIdOf("sk-first")], budgetBaselineUsd: PER_TEST_CAP_USD });
    const error = await rejection(capping(t, input));
    expect(error.message).toBe(`BUDGET_EXCEEDED: ${TASK_BUDGET_EXCEEDED_PREFIX} ($2.00 of $2.00). Choose Continue to resume this task with a fresh budget.`);
    expect(pauseOf(t, "test-1")).toMatchObject({ scope: { kind: "test", taskId: "test-1" } });
    // Half of it spent before the Continue leaves half, and the run limit still counts from the new window.
    t.access.setKeySpent("sk-first", 0.5);
    expect(minted(await capping(t, testRunInput({ taskKeyIds: [keyIdOf("sk-first")], budgetBaselineUsd: 0.5 }))).maxBudgetUsd).toBe(1.5);
  });

  it("holds a step to its own budget, less what the operation's keys spent, without pausing the task", async () => {
    const t = setup();
    seedTask(t);
    t.access.setKeySpent("sk-step", 1);
    expect(minted(await capping(t, taskInput({ stepBudgetUsd: 1.5, operationKeyIds: [keyIdOf("sk-step")] }))).maxBudgetUsd).toBe(0.5);
    t.access.setKeySpent("sk-step", 1.5);
    const error = await rejection(capping(t, taskInput({ stepBudgetUsd: 1.5, operationKeyIds: [keyIdOf("sk-step")] })));
    expect(error).toMatchObject({ code: "BUDGET_EXCEEDED", statusCode: 402 });
    expect(error.message).toContain(`${TASK_BUDGET_EXCEEDED_PREFIX} ($1.50 of $1.50)`);
    expect(pauseOf(t)).toBeUndefined();
  });

  it("refuses at a full budget with that level's error, and pauses the task with that scope", async () => {
    const p = setup();
    seedTask(p);
    p.limitProject(5);
    p.seedCounter(WEB, { committedUsd: 5 });
    expect(await rejection(capping(p, taskInput()))).toMatchObject({ code: "PROJECT_BUDGET_EXCEEDED", statusCode: 402, message: "PROJECT_BUDGET_EXCEEDED: The web project's monthly AI budget is used up ($5.00 of $5.00). Ask for more from the project's page." });
    expect(pauseOf(p)).toMatchObject({ scope: { kind: "project", project: "web" } });
    expect(p.access.mintKey).not.toHaveBeenCalled();
    const m = setup();
    seedTask(m);
    m.access.setMemberSpent(TEST_ORG, MAYA, 29);
    expect((await rejection(capping(m, taskInput()))).message).toBe("BUDGET_EXCEEDED: Your monthly AI budget is used up ($29.00 of $29.00). Ask an admin to raise it.");
    expect(pauseOf(m)).toMatchObject({ scope: { kind: "member", developerId: MAYA } });
    const o = setup();
    seedTask(o);
    o.access.setOrgSpent(TEST_ORG, 500.2);
    expect((await rejection(capping(o, taskInput()))).code).toBe("ORG_BUDGET_EXCEEDED");
    expect(pauseOf(o)).toMatchObject({ scope: { kind: "org" } });
  });

  it("refuses an agent that pays with no budget, or none left, and pauses the task with the agent", async () => {
    const payer = { kind: "agent", agentId: AGENT } as const;
    const agentInput = (): MintOperationKeyInput => {
      const { developerId: _developerId, ...rest } = taskInput(); // eslint-disable-line @typescript-eslint/no-unused-vars -- an agent pays, so no member
      return { ...rest, agentName: "Ticket Triage", scopes: budgetScopesFor(payer, WEB_PLACE, { agentId: AGENT }), tags: mintTagsFor({ payer, place: WEB_PLACE, agentId: AGENT, origin: "schedule", taskId: "task-1", operationId: "op-1" }) };
    };
    const none = setup();
    seedTask(none);
    expect(await rejection(capping(none, agentInput()))).toMatchObject({ code: "AGENT_BUDGET_REQUIRED", statusCode: 409 });
    expect(pauseOf(none)).toMatchObject({ scope: { kind: "agent", agentId: AGENT } });
    expect(none.access.mintKey).not.toHaveBeenCalled();
    const used = setup();
    seedTask(used);
    used.limitAgent(20);
    used.seedCounter({ kind: "agent", agentId: AGENT }, { committedUsd: 20 });
    expect(await rejection(capping(used, agentInput()))).toMatchObject({ code: "AGENT_BUDGET_EXCEEDED", message: "AGENT_BUDGET_EXCEEDED: Ticket Triage's monthly AI budget is used up ($20.00 of $20.00). Ask its owner for more." });
    const room = setup();
    room.limitAgent(20);
    room.seedCounter({ kind: "agent", agentId: AGENT }, { committedUsd: 18.5 });
    expect(minted(await capping(room, agentInput())).maxBudgetUsd).toBe(1.5);
  });

  it("keeps the first pause a task was given, and writes none for work with no task", async () => {
    const t = setup();
    seedTask(t, "task-1", { budgetPause: { scope: { kind: "project", project: "web" }, at: "2026-10-21T11:00:00.000Z" } });
    t.access.setMemberSpent(TEST_ORG, MAYA, 29);
    await rejection(capping(t, taskInput()));
    expect(pauseOf(t)).toEqual({ scope: { kind: "project", project: "web" }, at: "2026-10-21T11:00:00.000Z" });
    const { pause: _pause, ...noTask } = taskInput(); // eslint-disable-line @typescript-eslint/no-unused-vars -- work with no task
    expect((await rejection(capping(t, noTask))).code).toBe("BUDGET_EXCEEDED");
    const writes: string[] = [];
    const stop = t.db.onWrite(({ before, after }) => writes.push(String((after ?? before)?.entityType)));
    await rejection(capping(t, noTask));
    stop();
    expect(writes).toEqual([]);
  });

  it("still refuses with its own error when the pause cannot be written", async () => {
    const t = setup();
    seedTask(t);
    t.access.setMemberSpent(TEST_ORG, MAYA, 29);
    t.db.injectFault({ command: "UpdateCommand", match: (input) => JSON.stringify(input).includes("budgetPause"), error: { name: "InternalServerError" } });
    expect((await rejection(capping(t, taskInput()))).code).toBe("BUDGET_EXCEEDED");
  });

  it("answers MODEL_PROXY_UNAVAILABLE, naming nothing of the proxy, when it cannot say what the task's keys spent", async () => {
    const t = setup();
    t.access.keySpend.mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.0.0.7:4000"));
    const error = await rejection(capping(t, taskInput({ taskKeyIds: [keyIdOf("sk-first")] })));
    expect(error.code).toBe("MODEL_PROXY_UNAVAILABLE");
    expect(error.message).not.toContain("10.0.0.7");
    expect(t.access.mintKey).not.toHaveBeenCalled();
  });
});

describe("mintOperationKey: reserving before the key is handed out", () => {
  it("holds the key's cap on every limited scope and records the key with its tags, scopes and model", async () => {
    const t = setup();
    seedTask(t);
    t.limitProject(10);
    const key = minted(await reserving(t, taskInput({ route: { alias: "claude-sonnet-4-6", sourceId: "src_aaaaaaaaaaaaaaaaaaaa" } })));
    expect(key.maxBudgetUsd).toBe(10);
    const record = t.db.get(modelKeyKey(TEST_ORG, key.keyId)) as unknown as ModelKeyRecord;
    expect(record).toMatchObject({ reserved: true, finalized: false, capUsd: 10, settledUsd: 0, model: "claude-sonnet-4-6", month: MONTH });
    expect(record.scopes).toEqual(budgetScopesFor({ kind: "member", developerId: MAYA }, WEB_PLACE, { agentId: "rovara-code" }));
    expect(record.tags).toMatchObject({ taskId: "task-1", operationId: "op-1", payerKind: "member", payerId: MAYA, source: "src_aaaaaaaaaaaaaaaaaaaa" });
    for (const scope of [ORG, WEB, { kind: "member", developerId: MAYA } as const]) near(t.counter(scope)?.committedUsd, 10);
    expect(t.access.mintKey.mock.calls.at(-1)![0]).toMatchObject({ models: ["claude-sonnet-4-6"], tags: record.tags, maxBudgetUsd: 10 });
    expect(keyIdOf(key.key)).toBe(key.keyId);
  });

  it("records the key on the task and the operation, in one write", async () => {
    const t = setup();
    seedTask(t);
    const key = minted(await reserving(t, taskInput({ recordOn: [{ key: taskKey("task-1"), knownCount: 0 }, { key: OPERATION_KEY }] })));
    expect((t.db.get(taskKey("task-1")) as { modelKeyIds?: string[] }).modelKeyIds).toEqual([key.keyId]);
    expect((t.db.get(OPERATION_KEY) as { modelKeyIds?: string[] }).modelKeyIds).toEqual([key.keyId]);
    // The next key follows it on both.
    const second = minted(await reserving(t, taskInput({ taskKeyIds: [key.keyId], recordOn: [{ key: taskKey("task-1"), knownCount: 1 }, { key: OPERATION_KEY }] })));
    expect((t.db.get(taskKey("task-1")) as { modelKeyIds?: string[] }).modelKeyIds).toEqual([key.keyId, second.keyId]);
    expect((t.db.get(OPERATION_KEY) as { modelKeyIds?: string[] }).modelKeyIds).toEqual([key.keyId, second.keyId]);
  });

  it("gives five concurrent $2 mints against a $5 project $2, $2 and $1, and refuses two, never holding more than $5", async () => {
    const t = setup();
    t.limitProject(5);
    let highest = 0;
    t.db.onWrite(({ after }) => {
      if (after?.pk === spendCounterKey(TEST_ORG, MONTH, "PROJECT#web").pk && after.sk === "PROJECT#web") highest = Math.max(highest, Number(after.committedUsd ?? 0));
    });
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => reserving(t, taskInput({ runLimitUsd: 2, stopAtUsd: 2 }, `task-${String(n)}`))));
    const caps = results.flatMap((result) => (result.status === "fulfilled" ? [minted(result.value).maxBudgetUsd] : [])).sort();
    const refusals = results.flatMap((result) => (result.status === "rejected" ? [(result.reason as { code: string }).code] : []));
    expect(caps).toEqual([1, 2, 2]);
    expect(refusals).toEqual(["PROJECT_BUDGET_EXCEEDED", "PROJECT_BUDGET_EXCEEDED"]);
    near(t.counter(WEB)?.committedUsd, 5);
    expect(highest).toBeLessThanOrEqual(5.000001);
    // A key that did not fit was given back at the proxy, and only those.
    expect(t.access.revokeKey).toHaveBeenCalledTimes(t.access.mintKey.mock.calls.length - 3);
    expect(t.db.find((item) => item.entityType === "MODEL_KEY")).toHaveLength(3);
  });

  it("makes released money reusable: $1.50 of a $2 key that spent $0.50 is free once it is finalized", async () => {
    const t = setup();
    t.limitProject(5);
    const first = minted(await reserving(t, taskInput({ runLimitUsd: 2, stopAtUsd: 2 }, "task-1")));
    minted(await reserving(t, taskInput({ runLimitUsd: 2, stopAtUsd: 2 }, "task-2")));
    minted(await reserving(t, taskInput({ runLimitUsd: 1, stopAtUsd: 1 }, "task-3")));
    expect(await rejection(reserving(t, taskInput({ runLimitUsd: 1.5, stopAtUsd: 1.5 }, "task-4")))).toMatchObject({ code: "PROJECT_BUDGET_EXCEEDED" });
    t.access.setKeySpent(first.key, 0.5);
    await settleKey(t.ledger, TEST_ORG, first.keyId);
    expect(await finalizeKey(t.ledger, TEST_ORG, first.keyId)).toBe(true);
    near(t.counter(WEB)?.committedUsd, 3.5);
    expect(minted(await reserving(t, taskInput({ runLimitUsd: 1.5, stopAtUsd: 1.5 }, "task-5"))).maxBudgetUsd).toBe(1.5);
    near(t.counter(WEB)?.committedUsd, 5);
  });

  it("gives three test runs against a $10 allowance with $9 used one $1 cap and two TEST_ALLOWANCE_USED", async () => {
    const t = setup();
    t.seedCounter({ kind: "testing", developerId: KIT }, { spentUsd: 9, committedUsd: 9 });
    const results = await Promise.allSettled([1, 2, 3].map((n) => reserving(t, testRunInput({}, `test-${String(n)}`))));
    expect(results.flatMap((result) => (result.status === "fulfilled" ? [minted(result.value).maxBudgetUsd] : []))).toEqual([1]);
    expect(results.flatMap((result) => (result.status === "rejected" ? [(result.reason as { code: string }).code] : []))).toEqual(["TEST_ALLOWANCE_USED", "TEST_ALLOWANCE_USED"]);
    near(t.counter({ kind: "testing", developerId: KIT })?.committedUsd, 10);
  });

  it("never caps a test run above the per-test cap", async () => {
    const t = setup();
    const key = minted(await reserving(t, testRunInput()));
    expect(key.maxBudgetUsd).toBeLessThanOrEqual(PER_TEST_CAP_USD);
    near(t.counter({ kind: "testing", developerId: KIT })?.committedUsd, PER_TEST_CAP_USD);
  });

  it("refuses with the scope's error after one more read, using the figures as they are then, and pauses the task with it", async () => {
    const t = setup();
    seedTask(t);
    t.limitProject(5);
    // Another mint takes the room between this one's read and its reservation, both times.
    let taken = 0;
    const real = t.access.mintKey.getMockImplementation()!;
    t.access.mintKey.mockImplementation(async (input) => {
      const answer = await real(input);
      taken += 1;
      t.seedCounter(WEB, { committedUsd: 3 + taken });
      return answer;
    });
    const error = await rejection(reserving(t, taskInput({ runLimitUsd: 2, stopAtUsd: 2 })));
    expect(error.code).toBe("PROJECT_BUDGET_EXCEEDED");
    expect(error.message).toContain("($5.00 of $5.00)");
    expect(taken).toBe(2);
    expect(t.access.revokeKey).toHaveBeenCalledTimes(2);
    expect(pauseOf(t)).toMatchObject({ scope: { kind: "project", project: "web" } });
  });

  it("reads once more after a miss and no more: room that appears after the second miss is not waited for", async () => {
    const t = setup();
    t.limitProject(5);
    let taken = 0;
    const real = t.access.mintKey.getMockImplementation()!;
    t.access.mintKey.mockImplementation(async (input) => {
      const answer = await real(input);
      taken += 1;
      t.seedCounter(WEB, { committedUsd: 3 + taken });
      return answer;
    });
    // The room comes back as soon as the second key is given back; a third try would find it.
    const revoke = t.access.revokeKey.getMockImplementation()!;
    t.access.revokeKey.mockImplementation(async (key) => {
      await revoke(key);
      if (t.access.revokeKey.mock.calls.length === 2) t.seedCounter(WEB, { committedUsd: 0 });
    });
    expect((await rejection(reserving(t, taskInput({ runLimitUsd: 2, stopAtUsd: 2 })))).code).toBe("PROJECT_BUDGET_EXCEEDED");
    expect(t.access.mintKey).toHaveBeenCalledTimes(2);
  });
});

describe("mintOperationKey: a task's earlier keys", () => {
  it("blocks, settles and finalizes the task's earlier keys before it reserves, so the next key gets the room left and not the room less its own hold", async () => {
    const t = setup();
    const first = minted(await reserving(t, taskInput()));
    expect(first.maxBudgetUsd).toBe(25);
    t.access.setKeySpent(first.key, 3);
    const second = minted(await reserving(t, taskInput({ taskKeyIds: [first.keyId] })));
    // $25 less the $3 the task spent; without the first key's hold given back it would be $29 - $25 = $4.
    expect(second.maxBudgetUsd).toBe(22);
    expect(t.db.get(modelKeyKey(TEST_ORG, first.keyId))).toMatchObject({ finalized: true, settledUsd: 3 });
    for (const scope of [ORG, WEB, { kind: "member", developerId: MAYA } as const]) {
      near(t.counter(scope)?.spentUsd, 3);
      near(t.counter(scope)?.committedUsd, 3 + 22);
    }
    // The order never has two keys live with their caps both held: blocked, then (after the spend is counted) released, then the next key made.
    const blockedAt = t.access.blockKey.mock.invocationCallOrder[0]!;
    expect(blockedAt).toBeLessThan(t.access.mintKey.mock.invocationCallOrder[1]!);
    expect(t.access.blockKey).toHaveBeenCalledWith(first.keyId);
  });

  it("leaves a key that is already finalized alone, and a retry after a lost race does not block the winner's key", async () => {
    const t = setup();
    const first = minted(await reserving(t, taskInput()));
    const second = minted(await reserving(t, taskInput({ taskKeyIds: [first.keyId] })));
    expect(t.access.blockKey.mock.calls).toEqual([[first.keyId]]);
    // The first is finalized already: only the second is blocked now.
    const third = minted(await reserving(t, taskInput({ taskKeyIds: [first.keyId, second.keyId] })));
    expect(t.access.blockKey.mock.calls).toEqual([[first.keyId], [second.keyId]]);
    // The retry of a lost race touches none, so it competes with the winner's hold ($29 less its $25).
    const retry = minted(await reserving(t, taskInput({ taskKeyIds: [first.keyId, second.keyId, third.keyId], keepEarlierKeys: true })));
    expect(t.access.blockKey).toHaveBeenCalledTimes(2);
    expect(retry.maxBudgetUsd).toBe(4);
    expect(t.db.get(modelKeyKey(TEST_ORG, third.keyId))).toMatchObject({ finalized: false });
  });

  it("refuses the mint, with the earlier key still held, when the proxy cannot block it", async () => {
    const t = setup();
    const first = minted(await reserving(t, taskInput()));
    t.access.blockKey.mockRejectedValueOnce(new Error("boom"));
    await rejection(reserving(t, taskInput({ taskKeyIds: [first.keyId] })));
    expect(t.access.mintKey).toHaveBeenCalledTimes(1);
    expect(t.db.get(modelKeyKey(TEST_ORG, first.keyId))).toMatchObject({ finalized: false });
    // The next try finishes the job: block again, release, mint.
    expect(minted(await reserving(t, taskInput({ taskKeyIds: [first.keyId] }))).maxBudgetUsd).toBe(25);
  });

  it("does not touch keys that held nothing, and takes no other org's key", async () => {
    const t = setup();
    const turn = taskInput();
    await registerKey(t.ledger, { orgId: TEST_ORG, month: MONTH, keyId: keyIdOf("sk-turn"), capUsd: 2, scopes: [{ key: ORG }], tags: turn.tags!, expiresAt: T0 + 900_000 });
    minted(await reserving(t, taskInput({ taskKeyIds: [keyIdOf("sk-turn"), "f".repeat(64)] })));
    expect(t.access.blockKey).not.toHaveBeenCalled();
    expect(t.db.get(modelKeyKey(TEST_ORG, keyIdOf("sk-turn")))).toMatchObject({ finalized: false });
  });
});

describe("mintOperationKey: when a step fails", () => {
  it("holds nothing when the proxy cannot mint, and records nothing", async () => {
    const t = setup();
    seedTask(t);
    t.access.mintKey.mockRejectedValueOnce(new Error("boom"));
    await rejection(reserving(t, taskInput({ recordOn: [{ key: taskKey("task-1"), knownCount: 0 }] })));
    expect(t.counter(WEB)).toBeUndefined();
    expect(t.db.find((item) => item.entityType === "MODEL_KEY")).toEqual([]);
  });

  it("gives the key back and holds nothing when the reservation cannot be written", async () => {
    const t = setup();
    t.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("MODEL_KEY"), error: { name: "InternalServerError" } });
    await rejection(reserving(t, taskInput()));
    expect(t.access.revokeKey).toHaveBeenCalledWith(t.access.mintedKeys()[0]);
    expect(t.db.find((item) => item.entityType === "MODEL_KEY")).toEqual([]);
    expect(t.counter(WEB)?.committedUsd ?? 0).toBe(0);
  });

  it("takes the reservation back when it was written and its answer was lost", async () => {
    const t = setup();
    const send = t.db.send;
    let lost = false;
    t.db.send = async (command) => {
      const answer = await send(command);
      if (!lost && command.constructor.name === "TransactWriteCommand" && JSON.stringify((command as { input: unknown }).input).includes("MODEL_KEY")) { lost = true; throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); }
      return answer;
    };
    await rejection(reserving(t, taskInput()));
    expect(lost).toBe(true);
    expect(t.access.revokeKey).toHaveBeenCalledWith(t.access.mintedKeys()[0]);
    expect(t.db.find((item) => item.entityType === "MODEL_KEY" || item.entityType === "OPEN_MODEL_KEY")).toEqual([]);
    for (const scope of [ORG, WEB, { kind: "member", developerId: MAYA } as const]) expect(t.counter(scope)?.committedUsd ?? 0).toBe(0);
  });

  it("blocks and finalizes the key, releasing its cap, when it cannot be recorded on the task", async () => {
    const t = setup();
    seedTask(t);
    t.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("modelKeyIds"), error: { name: "InternalServerError" } });
    await rejection(reserving(t, taskInput({ recordOn: [{ key: taskKey("task-1"), knownCount: 0 }, { key: OPERATION_KEY }] })));
    const keyId = keyIdOf(t.access.mintedKeys()[0]!);
    expect(t.access.blockKey).toHaveBeenCalledWith(keyId);
    expect(t.db.get(modelKeyKey(TEST_ORG, keyId))).toMatchObject({ finalized: true, reserved: true });
    expect(t.counter(WEB)?.committedUsd ?? 0).toBe(0);
    expect((t.db.get(taskKey("task-1")) as { modelKeyIds?: string[] }).modelKeyIds).toBeUndefined();
  });

  it("answers raced, with the key blocked and finalized and nothing recorded, when another mint recorded first", async () => {
    const t = setup();
    seedTask(t, "task-1", { modelKeyIds: ["f".repeat(64)] });
    const outcome = await reserving(t, taskInput({ recordOn: [{ key: taskKey("task-1"), knownCount: 0 }, { key: OPERATION_KEY }] }));
    expect(outcome).toEqual({ outcome: "raced" });
    const keyId = keyIdOf(t.access.mintedKeys()[0]!);
    expect(t.access.blockKey).toHaveBeenCalledWith(keyId);
    expect(t.db.get(modelKeyKey(TEST_ORG, keyId))).toMatchObject({ finalized: true });
    expect(t.counter(WEB)?.committedUsd ?? 0).toBe(0);
    expect((t.db.get(taskKey("task-1")) as { modelKeyIds?: string[] }).modelKeyIds).toEqual(["f".repeat(64)]);
    expect((t.db.get(OPERATION_KEY) as { modelKeyIds?: string[] }).modelKeyIds).toBeUndefined();
  });

  it("revokes a key that no ledger is keeping when it cannot be recorded", async () => {
    const t = setup();
    seedTask(t, "task-1", { modelKeyIds: ["f".repeat(64)] });
    const outcome = await capping(t, taskInput({ recordOn: [{ key: taskKey("task-1"), knownCount: 0 }] }));
    expect(outcome).toEqual({ outcome: "raced" });
    expect(t.access.revokeKey).toHaveBeenCalledWith(t.access.mintedKeys()[0]);
    expect(t.access.blockKey).not.toHaveBeenCalled();
  });
});


// ---- the ledger's two additions ----

describe("abandonKey and readScopeCounters", () => {
  const OTHER = singleOrgIdForEnv("other-install");
  const keyInput = (t: ReturnType<typeof setup>, n: number, extra: Partial<KeyInput> = {}): KeyInput => ({
    orgId: TEST_ORG, month: MONTH, keyId: keyIdOf(`sk-abandon-${String(n)}`), capUsd: 3, scopes: [{ key: ORG, limitUsd: 500 }, { key: WEB, limitUsd: 10 }],
    tags: mintTagsFor({ payer: { kind: "member", developerId: MAYA }, place: WEB_PLACE, agentId: "rovara-code", origin: "app", taskId: `task-${String(n)}`, operationId: "op-1" }),
    expiresAt: T0 + 3_600_000, ...extra,
  });

  it("takes a reservation back whole, deleting the key's record and its place in the sweep's list", async () => {
    const t = setup();
    const input = keyInput(t, 1);
    await reserve(t.ledger, input);
    near(t.counter(WEB)?.committedUsd, 3);
    expect(await abandonKey(t.ledger, TEST_ORG, input.keyId)).toBe(true);
    expect(t.db.get(modelKeyKey(TEST_ORG, input.keyId))).toBeUndefined();
    expect(t.db.find((item) => item.pk === "OPEN_MODEL_KEYS")).toEqual([]);
    for (const scope of [ORG, WEB]) near(t.counter(scope)?.committedUsd, 0);
    // Again: nothing is there to take back, and nothing is released twice.
    expect(await abandonKey(t.ledger, TEST_ORG, input.keyId)).toBe(false);
    near(t.counter(WEB)?.committedUsd, 0);
  });

  it("leaves a key that counted spend, one that is finalized, one that reserved nothing and another org's key alone", async () => {
    const t = setup();
    const settled = keyInput(t, 2);
    await reserve(t.ledger, settled);
    t.access.setKeySpent("sk-abandon-2", 0.4);
    await settleKey(t.ledger, TEST_ORG, settled.keyId);
    const finalized = keyInput(t, 3);
    await reserve(t.ledger, finalized);
    await finalizeKey(t.ledger, TEST_ORG, finalized.keyId);
    const unreserved = keyInput(t, 4);
    await registerKey(t.ledger, unreserved);
    const theirs = keyInput(t, 5);
    await reserve(t.ledger, theirs);
    for (const id of [settled.keyId, finalized.keyId, unreserved.keyId]) expect(await abandonKey(t.ledger, TEST_ORG, id), id).toBe(false);
    expect(await abandonKey(t.ledger, OTHER, theirs.keyId)).toBe(false);
    for (const id of [settled.keyId, finalized.keyId, unreserved.keyId, theirs.keyId]) expect(t.db.get(modelKeyKey(TEST_ORG, id)), id).toBeDefined();
    // The settled key still holds its $3, the finalized one gave its $3 back, the unreserved one held none, and the key asked for under another org's name still holds its $3.
    near(t.counter(WEB)?.committedUsd, 6);
  });

  it("takes back nothing from a key that counted spend, or was finalized, between its read and its write", async () => {
    for (const change of ["settled", "finalized"] as const) {
      const t = setup();
      const input = keyInput(t, 6);
      await reserve(t.ledger, input);
      t.access.setKeySpent("sk-abandon-6", 0.4);
      const send = t.db.send;
      let changed = false;
      t.db.send = async (command) => {
        const next = command as { constructor: { name: string }; input?: { TransactItems?: Array<{ Delete?: unknown }> } };
        if (!changed && next.constructor.name === "TransactWriteCommand" && next.input?.TransactItems?.some((item) => item.Delete !== undefined) === true) {
          changed = true;
          if (change === "settled") await settleKey(t.ledger, TEST_ORG, input.keyId);
          else await finalizeKey(t.ledger, TEST_ORG, input.keyId);
        }
        return send(command);
      };
      expect(await abandonKey(t.ledger, TEST_ORG, input.keyId), change).toBe(false);
      expect(changed).toBe(true);
      expect(t.db.get(modelKeyKey(TEST_ORG, input.keyId)), change).toBeDefined();
      // Nothing was released twice: a settled key holds its cap, a finalized one gave back what it did not spend.
      near(t.counter(WEB)?.committedUsd, change === "settled" ? 3 : 0);
    }
  });

  it("reads the counters of one org only, and zero where nothing was counted", async () => {
    const t = setup();
    t.seedCounter(WEB, { spentUsd: 1, committedUsd: 2 });
    t.db.set({ ...spendCounterKey(OTHER, MONTH, "PROJECT#web"), entityType: "SPEND_COUNTER", spentUsd: 50, committedUsd: 60 });
    const mine = await readScopeCounters(t.ledger, TEST_ORG, MONTH, [WEB, ORG]);
    expect(mine.get("PROJECT#web")).toEqual({ spentUsd: 1, committedUsd: 2 });
    expect(mine.get("ORG")).toEqual({ spentUsd: 0, committedUsd: 0 });
    expect((await readScopeCounters(t.ledger, OTHER, MONTH, [WEB])).get("PROJECT#web")).toEqual({ spentUsd: 50, committedUsd: 60 });
    expect((await readScopeCounters(t.ledger, TEST_ORG, "2026-09", [WEB])).get("PROJECT#web")).toEqual({ spentUsd: 0, committedUsd: 0 });
  });
});

// ---- the broker's routes ----

const PROXY_URL = "http://internal-proxy.example.test:4000";
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const NOW_MONTH = new Date().toISOString().slice(0, 7);

async function brokerSetup(options: { stepBudgetUsd?: number; agents?: boolean; env?: (h: Awaited<ReturnType<typeof createDeveloperTaskBroker>>) => void } = {}) {
  const access = fakeModelAccess();
  const h = await createDeveloperTaskBroker({ brokerExtra: { ...(options.agents === false ? {} : { agents: { ...(options.stepBudgetUsd === undefined ? {} : { builtins: {
    currentVersion: (id: string) => currentBuiltinVersion(id as Parameters<typeof currentBuiltinVersion>[0]),
    defaultPin: (id: string) => builtinDefaultPin(id as Parameters<typeof builtinDefaultPin>[0]),
    name: (id: string) => BUILTIN_AGENTS[id as keyof typeof BUILTIN_AGENTS].name,
    recipe: (id: string, version: number) => {
      const recipe = builtinRecipe(id as Parameters<typeof builtinRecipe>[0], version);
      return id !== "rovara-code" ? recipe : { ...recipe, steps: recipe.steps.map(step => step.kind === "build" ? { ...step, settings: { ...step.settings, stepBudgetUsd: options.stepBudgetUsd } } : step) } as ResolvedRecipe;
    },
  } }) } }), modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true } });
  access.setMemberSpent(TEST_ORG, DEV_MAYA.developerId, 0);
  access.setOrgSpent(TEST_ORG, 0);
  // A task with no workflow starts at the TASK estimate's run limit (Task 34); these tests are written for a task budget of $25.
  seedTaskRunLimit(h.db);
  const limitProject = (limitUsd: number) => h.db.set({ pk: `ORG#${TEST_ORG}#PROJECT_AI#payments`, sk: "SETTINGS", entityType: "PROJECT_AI", projectPays: false, monthlyBudgetUsd: limitUsd, revision: 1 });
  const projectPays = () => h.db.set({ pk: `ORG#${TEST_ORG}#PROJECT_AI#payments`, sk: "SETTINGS", entityType: "PROJECT_AI", projectPays: true, revision: 1 });
  const seed = (scope: BudgetScope, counts: { spentUsd?: number; committedUsd?: number }) => h.db.set({ ...spendCounterKey(TEST_ORG, NOW_MONTH, scopeKey(scope)), entityType: "SPEND_COUNTER", ...counts });
  const counter = (scope: BudgetScope) => h.db.get(spendCounterKey(TEST_ORG, NOW_MONTH, scopeKey(scope))) as { spentUsd?: number; committedUsd?: number } | undefined;
  const start = (extra: Record<string, unknown> = {}) => h.dev(DEV_MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code", ...extra });
  const startTask = async (extra: Record<string, unknown> = {}) => {
    const reply = await start(extra);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const taskId = (reply.body.task as { taskId: string }).taskId;
    return { taskId, workspaceId: (h.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string }).workspaceId };
  };
  const active = (workspaceId: string) => String((h.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  /** Finishes preparation, then asks for a key as the task's worker does; `ask` asks again. */
  const running = async (extra: Record<string, unknown> = {}) => {
    const { taskId, workspaceId } = await startTask(extra);
    await h.finish(workspaceId, active(workspaceId), "SUCCEEDED", PREPARED);
    const operationId = active(workspaceId);
    const capability = ((h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!.invocation) as { callbackCapability: string }).callbackCapability;
    const ask = () => call(h.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": capability } });
    const task = () => h.db.get(`DEVTASK#${taskId}`, "META") as { modelKeyIds?: string[]; budgetPause?: { scope: PauseScope; at: string }; budgetUsd?: number };
    const operation = () => h.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`) as { modelKeyIds?: string[] };
    return { taskId, workspaceId, operationId, ask, task, operation };
  };
  return { ...h, access, limitProject, projectPays, seed, counter, start, startTask, active, running };
}

describe("a task's key at the broker", () => {
  it("is reserved on every budget the task counts against, and recorded on the task and the operation", async () => {
    const t = await brokerSetup();
    t.limitProject(10);
    const r = await t.running();
    const reply = await r.ask();
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const [key] = t.access.mintedKeys();
    const record = t.db.get(modelKeyKey(TEST_ORG, keyIdOf(key!))) as unknown as ModelKeyRecord;
    expect(record).toMatchObject({ reserved: true, capUsd: 10, finalized: false });
    for (const scope of [ORG, { kind: "project", project: "payments" } as const, { kind: "member", developerId: DEV_MAYA.developerId } as const]) near(t.counter(scope)?.committedUsd, 10);
    expect(r.task().modelKeyIds).toEqual([keyIdOf(key!)]);
    expect(r.operation().modelKeyIds).toEqual([keyIdOf(key!)]);
  });

  it("counts a payer who was merged into another member against the member they are now, in the key's scopes, tags and name (Review M-3 of Task 21)", async () => {
    const t = await brokerSetup();
    const DUPLICATE = "9".repeat(64);
    t.db.set({ pk: `DEVELOPER#${DUPLICATE}`, sk: "META", developerId: DUPLICATE, provider: "oidc", displayName: "Duplicate", firstSignInAt: "x", lastSignInAt: "x", revoked: false, mergedInto: DEV_MAYA.developerId });
    const r = await t.running();
    t.db.set({ ...(t.db.get(taskKey(r.taskId)) as Record<string, unknown>), payer: { kind: "member", developerId: DUPLICATE } });
    const reply = await r.ask();
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const [key] = t.access.mintedKeys();
    const record = t.db.get(modelKeyKey(TEST_ORG, keyIdOf(key!))) as unknown as ModelKeyRecord;
    expect(record.tags).toMatchObject({ payerKind: "member", payerId: DEV_MAYA.developerId });
    expect(record.scopes).toContainEqual({ kind: "member", developerId: DEV_MAYA.developerId });
    expect(record.scopes).not.toContainEqual({ kind: "member", developerId: DUPLICATE });
    expect(t.access.mintKey.mock.calls[0]![0]).toMatchObject({ tags: { payerId: DEV_MAYA.developerId } });
  });

  it("mints no key once the org is closed, whatever the task: fail closed (Re-check R-2 of Task 21)", async () => {
    const t = await brokerSetup();
    const r = await t.running();
    expect((await r.ask()).status).toBe(200);
    expect(t.access.mintedKeys()).toHaveLength(1);
    t.db.set({ ...(t.db.get(orgMetaKey(TEST_ORG)) as Record<string, unknown>), closedAt: "2026-10-24T12:00:00.000Z" });
    const refused = await r.ask();
    expect(refused.status).toBe(403);
    expect((refused.body.error as { code: string }).code).toBe("TASK_ACCESS_DENIED");
    expect(t.access.mintedKeys()).toHaveLength(1);
  });

  it("mints no key when the org's state can't be read, or the task's owner can't be told (Re-check R-2 of Task 21)", async () => {
    const t = await brokerSetup();
    const r = await t.running();
    t.db.injectFault({ command: "GetCommand", match: (input) => JSON.stringify((input as { Key?: unknown }).Key) === JSON.stringify(orgMetaKey(TEST_ORG)), error: { name: "InternalServerError" }, times: 1 });
    const unread = await r.ask();
    expect(unread.status).toBeGreaterThanOrEqual(500);
    expect(t.access.mintedKeys()).toHaveLength(0);
    t.db.set({ ...(t.db.get(taskKey(r.taskId)) as Record<string, unknown>), currentOwner: { developerId: "", name: "?", provider: "nope", since: "x" } });
    const unknown = await r.ask();
    expect(unknown.status).toBeGreaterThanOrEqual(400);
    expect(t.access.mintedKeys()).toHaveLength(0);
  });

  it("mints no key for a task whose owner is no longer a member of the org (Re-check R-2 of Task 21)", async () => {
    const t = await brokerSetup();
    const r = await t.running();
    t.db.delete(orgMemberKey(TEST_ORG, DEV_MAYA.developerId));
    t.db.set({ ...orgRemovedKey(TEST_ORG, DEV_MAYA.developerId), entityType: "ORG_REMOVED", removedAt: "2026-10-24T12:00:00.000Z" });
    const refused = await r.ask();
    expect(refused.status).toBe(403);
    expect(t.access.mintedKeys()).toHaveLength(0);
  });

  it("gives a task's second operation the room that is left, not the room less its own first key's hold", async () => {
    const t = await brokerSetup();
    const r = await t.running();
    expect((await r.ask()).status).toBe(200);
    const [first] = t.access.mintedKeys();
    expect(t.access.mintKey.mock.calls[0]![0].maxBudgetUsd).toBe(25);
    t.access.setKeySpent(first!, 2);
    await t.finish(r.workspaceId, r.operationId, "SUCCEEDED", {});
    const continued = await t.dev(DEV_MAYA, "POST", `/v1/dev/tasks/${r.taskId}/continue`, { requestId: randomUUID(), instructions: "more" });
    expect(continued.status, JSON.stringify(continued.body)).toBe(200);
    const operationId = t.active(r.workspaceId);
    expect(operationId).not.toBe(r.operationId);
    const capability = ((t.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!.invocation) as { callbackCapability: string }).callbackCapability;
    const reply = await call(t.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": capability } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    // $29 for the member less the $2 spent: the full run limit of $25, and not the $4 the first key's hold left.
    expect(t.access.mintKey.mock.calls[1]![0].maxBudgetUsd).toBe(25);
    expect(t.db.get(modelKeyKey(TEST_ORG, keyIdOf(first!)))).toMatchObject({ finalized: true, settledUsd: 2 });
    near(t.counter({ kind: "member", developerId: DEV_MAYA.developerId })?.committedUsd, 2 + 25);
  });

  it("gives the key of a mint that lost a race back, blocked and finalized with its cap released, and reserves the retry", async () => {
    const t = await brokerSetup();
    // The member has room for several keys at once.
    t.db.set({ ...orgSettingsKey(TEST_ORG, "BUDGET"), entityType: "ORG_BUDGET", orgMonthlyUsd: 500, memberDefaultMonthlyUsd: 100, memberOverrides: {} });
    const r = await t.running();
    expect((await r.ask()).status).toBe(200);
    t.access.setKeySpent(t.access.mintedKeys()[0]!, 2);
    const [a, b] = await Promise.all([r.ask(), r.ask()]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(new Set([a.body.apiKey, b.body.apiKey]).size).toBe(2);
    const keys = t.db.find((item) => item.entityType === "MODEL_KEY");
    // The first key (superseded by the asks) and the loser's first key are finalized; the winner's and the loser's retry stand.
    expect(keys.filter((item) => item.finalized === true)).toHaveLength(2);
    expect(keys.filter((item) => item.finalized === false)).toHaveLength(2);
    // The first key's $2 spent, and $23 for each of the two keys that stand: its unspent hold and the loser's first cap went back.
    near(t.counter({ kind: "member", developerId: DEV_MAYA.developerId })?.committedUsd, 2 + 23 + 23);
    expect(r.task().modelKeyIds).toHaveLength(3);
  });

  it("is refused with the project's error, and the task paused with the project, when the project's budget is used up", async () => {
    const t = await brokerSetup();
    const r = await t.running();
    t.limitProject(5);
    t.seed({ kind: "project", project: "payments" }, { committedUsd: 5 });
    expect(await r.ask()).toMatchObject({ status: 402, body: { error: { code: "PROJECT_BUDGET_EXCEEDED" } } });
    expect(t.access.mintKey).not.toHaveBeenCalled();
    expect(r.task().budgetPause).toMatchObject({ scope: { kind: "project", project: "payments" } });
  });

  it("pauses the task with its run limit when its keys have spent it, and with the member when the member is out", async () => {
    const t = await brokerSetup();
    const r = await t.running();
    expect((await r.ask()).status).toBe(200);
    t.access.setKeySpent(t.access.mintedKeys()[0]!, 25);
    expect(await r.ask()).toMatchObject({ status: 402, body: { error: { code: "BUDGET_EXCEEDED" } } });
    expect(r.task().budgetPause).toMatchObject({ scope: { kind: "task", taskId: r.taskId } });
    const m = await brokerSetup();
    const q = await m.running();
    m.access.setMemberSpent(TEST_ORG, DEV_MAYA.developerId, 29);
    expect((await q.ask()).status).toBe(402);
    expect(q.task().budgetPause).toMatchObject({ scope: { kind: "member", developerId: DEV_MAYA.developerId } });
  });

  it("counts only what the task's keys spent since its last Continue against its run limit", async () => {
    const t = await brokerSetup();
    t.db.set({ ...orgSettingsKey(TEST_ORG, "BUDGET"), entityType: "ORG_BUDGET", orgMonthlyUsd: 500, memberDefaultMonthlyUsd: 100, memberOverrides: {} });
    const r = await t.running();
    expect((await r.ask()).status).toBe(200);
    t.access.setKeySpent(t.access.mintedKeys()[0]!, 10);
    expect((await r.ask()).status).toBe(200);
    expect(t.access.mintKey.mock.calls[1]![0].maxBudgetUsd).toBe(15);
    t.db.set({ ...r.task(), budgetBaselineUsd: 10 });
    expect((await r.ask()).status).toBe(200);
    expect(t.access.mintKey.mock.calls[2]![0].maxBudgetUsd).toBe(25);
  });

  it("stops at the agent's max per run when it is lower than the run limit, and pauses with max_per_run", async () => {
    const t = await brokerSetup();
    const r = await t.running();
    t.db.set({ ...r.task(), maxPerRunUsd: 3 });
    expect((await r.ask()).status).toBe(200);
    expect(t.access.mintKey.mock.calls[0]![0].maxBudgetUsd).toBe(3);
    t.access.setKeySpent(t.access.mintedKeys()[0]!, 3);
    expect(await r.ask()).toMatchObject({ status: 402, body: { error: { code: "BUDGET_EXCEEDED" } } });
    expect(r.task().budgetPause).toMatchObject({ scope: { kind: "max_per_run", taskId: r.taskId } });
  });

  it("pauses with planning when a workflow task's planning limit is used up", async () => {
    const t = await brokerSetup();
    const r = await t.running({ workflow: true, workflowPath: "QUICK" });
    t.db.set({ ...r.task(), budgetUsd: 6 });
    expect((await r.ask()).status).toBe(200);
    expect(t.access.mintKey.mock.calls[0]![0].maxBudgetUsd).toBe(6);
    t.access.setKeySpent(t.access.mintedKeys()[0]!, 6);
    expect((await r.ask()).status).toBe(402);
    expect(r.task().budgetPause).toMatchObject({ scope: { kind: "planning", taskId: r.taskId } });
  });

  it("answers the retryable 503 on the first ask when the task's recipe snapshot can't be read, and mints nothing", async () => {
    const t = await brokerSetup();
    const r = await t.running();
    t.db.set({ ...r.task(), agent: { ...(r.task() as unknown as { agent: object }).agent, digest: "0".repeat(64) } });
    expect(await r.ask()).toMatchObject({ status: 503, body: { error: { code: "MODEL_PROXY_UNAVAILABLE" } } });
    expect(t.access.mintKey).not.toHaveBeenCalled();
  });

  it("writes no pause and keeps no ledger on an install without agents", async () => {
    const t = await brokerSetup({ agents: false });
    const r = await t.running();
    t.access.setMemberSpent(TEST_ORG, DEV_MAYA.developerId, 29);
    expect((await r.ask()).status).toBe(402);
    expect(r.task().budgetPause).toBeUndefined();
    t.access.setMemberSpent(TEST_ORG, DEV_MAYA.developerId, 0);
    expect((await r.ask()).status).toBe(200);
    expect(t.db.find((item) => item.entityType === "MODEL_KEY")).toEqual([]);
    expect(r.operation().modelKeyIds).toBeUndefined();
  });

  it("is held to the recipe step's budget, less what the operation's keys spent", async () => {
    const t = await brokerSetup({ stepBudgetUsd: 1.5 });
    const r = await t.running();
    expect((await r.ask()).status).toBe(200);
    expect(t.access.mintKey.mock.calls[0]![0].maxBudgetUsd).toBe(1.5);
    t.access.setKeySpent(t.access.mintedKeys()[0]!, 1.25);
    expect((await r.ask()).status).toBe(200);
    expect(t.access.mintKey.mock.calls[1]![0].maxBudgetUsd).toBe(0.25);
  });
});

describe("a start at the broker", () => {
  it("is refused with the project's error before any write when the project's budget is used up", async () => {
    const t = await brokerSetup();
    t.limitProject(5);
    t.seed({ kind: "project", project: "payments" }, { committedUsd: 4.8 });
    const mark = t.db.commandNames().length;
    const reply = await t.start();
    expect(reply).toMatchObject({ status: 402, body: { error: { code: "PROJECT_BUDGET_EXCEEDED" } } });
    expect(t.db.commandNames().slice(mark)).not.toContain("TransactWriteCommand");
    expect(t.db.find((item) => item.entityType === "DEVELOPER_TASK")).toEqual([]);
    // The refusal is audited like any other.
    expect(t.db.find((item) => typeof item.pk === "string" && item.pk.startsWith("TASK#") && item.phase === "refused").map((item) => (item.error as { code: string }).code)).toEqual(["PROJECT_BUDGET_EXCEEDED"]);
  });

  it("starts a project-paid run whose member is over their limit, and refuses the member's own run", async () => {
    const t = await brokerSetup();
    t.access.setMemberSpent(TEST_ORG, DEV_MAYA.developerId, 29.5);
    expect((await t.start()).status).toBe(402);
    t.projectPays();
    expect((await t.start()).status).toBe(200);
  });
});

describe("Slack work at the broker", () => {
  const SLACK_USER = "U0123456789";
  const THREAD = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
  beforeAll(loadSlackBroker);

  async function install(options: { agents?: boolean } = {}) {
    const access = fakeModelAccess();
    const { handler, db } = createBroker({ extra: { ...(options.agents === false ? {} : { agents: {} }), modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true } });
    await registerSlackProject(handler);
    access.setOrgSpent(TEST_ORG, 0);
    const limitProject = (limitUsd: number) => db.set({ pk: `ORG#${TEST_ORG}#PROJECT_AI#payments`, sk: "SETTINGS", entityType: "PROJECT_AI", projectPays: false, monthlyBudgetUsd: limitUsd, revision: 1 });
    const seed = (scope: BudgetScope, counts: { spentUsd?: number; committedUsd?: number }) => db.set({ ...spendCounterKey(TEST_ORG, NOW_MONTH, scopeKey(scope)), entityType: "SPEND_COUNTER", ...counts });
    return { handler, db, access, limitProject, seed };
  }

  it("refuses a new thread with the project's error before any workspace or charge", async () => {
    const h = await install();
    h.limitProject(2);
    h.seed({ kind: "project", project: "payments" }, { committedUsd: 2 });
    const mark = h.db.commandNames().length;
    expect(await ensureWorkspace(h.handler, THREAD, SLACK_USER)).toMatchObject({ status: 402, body: { error: { code: "PROJECT_BUDGET_EXCEEDED" } } });
    expect(h.db.commandNames().slice(mark)).not.toContain("TransactWriteCommand");
  });

  it("admits a turn against the project too, caps its key at what is left there, and keeps it on the unreserved path", async () => {
    const h = await install();
    const linked = developerIdForSlackUser(SLACK_USER);
    seedMembership(h.db, linked, { orgId: TEST_ORG, role: "member" });
    h.access.setMemberSpent(TEST_ORG, linked, 0);
    h.limitProject(2.5);
    h.seed({ kind: "project", project: "payments" }, { committedUsd: 1.5 });
    const reply = await serviceCall(h.handler, THREAD, SLACK_USER, "POST", "/v1/service/model-access", { turnId: "Ev1" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(h.access.mintKey.mock.calls[0]![0].maxBudgetUsd).toBe(1);
    expect(h.db.get(modelKeyKey(TEST_ORG, keyIdOf(reply.body.apiKey as string)))).toMatchObject({ reserved: false });
    h.seed({ kind: "project", project: "payments" }, { committedUsd: 2.5 });
    expect(await serviceCall(h.handler, THREAD, SLACK_USER, "POST", "/v1/service/model-access", { turnId: "Ev2" })).toMatchObject({ status: 402, body: { error: { code: "PROJECT_BUDGET_EXCEEDED" } } });
  });

  it("reserves an operation's key in the thread, and caps it at what the project has left", async () => {
    const h = await install();
    h.limitProject(8);
    const workspace = await ensureWorkspace(h.handler, THREAD, SLACK_USER);
    expect(workspace.status).toBe(200);
    const workspaceId = workspace.body.workspaceId as string;
    markReady(h.db, workspaceId);
    const conversation = await serviceCall(h.handler, THREAD, SLACK_USER, "POST", `/v1/service/workspaces/${workspaceId}/conversations`, {});
    const conversationId = (conversation.body.conversation as { id: string }).id;
    const task = await serviceCall(h.handler, THREAD, SLACK_USER, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, { requestId: randomUUID(), conversationId, prompt: "test it" });
    const operationId = (task.body.operation as { id: string }).id;
    const capability = ((h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!.invocation) as { callbackCapability: string }).callbackCapability;
    const reply = await call(h.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": capability } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(h.access.mintKey.mock.calls[0]![0].maxBudgetUsd).toBe(8);
    expect(h.db.get(modelKeyKey(TEST_ORG, keyIdOf(reply.body.apiKey as string)))).toMatchObject({ reserved: true, capUsd: 8 });
    near((h.db.get(spendCounterKey(TEST_ORG, NOW_MONTH, "PROJECT#payments")) as { committedUsd?: number }).committedUsd, 8);
    expect((h.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`) as { modelKeyIds?: string[] }).modelKeyIds).toHaveLength(1);
  });

  it("mints no key for a thread's operation once the org is closed (Re-check R-2 of Task 21)", async () => {
    const h = await install();
    const workspace = await ensureWorkspace(h.handler, THREAD, SLACK_USER);
    const workspaceId = workspace.body.workspaceId as string;
    markReady(h.db, workspaceId);
    const conversation = await serviceCall(h.handler, THREAD, SLACK_USER, "POST", `/v1/service/workspaces/${workspaceId}/conversations`, {});
    const conversationId = (conversation.body.conversation as { id: string }).id;
    const task = await serviceCall(h.handler, THREAD, SLACK_USER, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, { requestId: randomUUID(), conversationId, prompt: "test it" });
    const operationId = (task.body.operation as { id: string }).id;
    const capability = ((h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!.invocation) as { callbackCapability: string }).callbackCapability;
    h.db.set({ ...(h.db.get(orgMetaKey(TEST_ORG)) as Record<string, unknown>), pk: orgMetaKey(TEST_ORG).pk, sk: orgMetaKey(TEST_ORG).sk, closedAt: "2026-10-24T12:00:00.000Z" });
    const reply = await call(h.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": capability } });
    expect(reply.status).toBe(403);
    expect(h.access.mintKey).not.toHaveBeenCalled();
  });
});
