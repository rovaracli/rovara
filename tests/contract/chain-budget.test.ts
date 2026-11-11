// Plan 4 Task 5: chain budgets, payers and origins. A chain is paid for the way an agent is (a payer, a monthly budget, a place), its steps count once against the
// chain and never against the agent, a run has a limit of its own that a step's raise is measured against, and a person's chain budgets and agent budgets are one
// monthly total (R65) under one cap, held to the effective total (base plus this month's top-ups, as Plan 3's round 1 ruled).
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_PERSON_CHAIN_RUN_LIMIT_USD, chainKey, agentGuardrailsKey, type Payer } from "@rovara-code/contracts";
import { ownerBudgetKey, scopeKey, spendCounterKey, topUpKey, ledgerKey, type BudgetScope, type SpendRequestRecord } from "@agentx/cloud-contracts";
import { PayerSchema } from "@rovara-code/contracts";
import { ModelAccessRequestSchema } from "../../packages/broker/src/model-proxy/protocol.js";
import { DEFAULT_AGENT_GUARDRAILS } from "@rovara-code/contracts";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { SCOPE_ERRORS, admitWork, mintOperationKey, type MintOperationKeyInput } from "../../packages/broker/src/spend/admission.js";
import { agentUsageCounter, budgetScopesFor, keyMember, mintTagsFor, payerIdOf, resolvePayer, type ResolvePayerInput } from "../../packages/broker/src/spend/payer.js";
import type { LedgerDependencies } from "../../packages/broker/src/spend/ledger.js";
import { LIMIT_READERS, effectiveLimits } from "../../packages/broker/src/spend/settings.js";
import { MONTH_APPROVERS, OWNER_TOTAL_CONTRIBUTORS, createSpendRequest, ownerEffectiveTotal, spendApprovers } from "../../packages/broker/src/spend/requests.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { fakeModelAccess, type FakeModelAccess } from "../support/fake-model-access.js";
import { MAYA } from "../support/developer-task-broker.js";
import { DECIDE_COOKIE, DecideStore, csrfTokenFor } from "../../packages/broker/src/developer/decide-session.js";
import { ADA, BEN, CARL, CELL, DEB, month, refusal, setup as setupWorld, sha, type World } from "../support/spend-world.js";
import { TEST_ORG } from "../support/orgs.js";

// What this task adds to Plan 3's modules is loaded by the tests that need it, so each of them fails on its own until it exists.
const budget = () => import("../../packages/broker/src/chains/budget.js");

const CHAIN = "chn_aaaaaaaaaaaaaaaaaaaa";
const RUN = "crn_aaaaaaaaaaaaaaaaaaaa";
const AGENT = "agt_aaaaaaaaaaaaaaaaaaaaaaaa";
const KIT = "7".repeat(64);
const MONTH = "2026-10";
const T0 = Date.parse("2026-10-21T12:00:00.000Z");
const WEB_PLACE = { project: "web" };
const near = (value: number | undefined, expected: number) => expect(value ?? 0).toBeCloseTo(expected, 6);
const rejection = async (action: Promise<unknown>) => {
  try { await action; } catch (error) { return error as { code: string; message: string; statusCode: number }; }
  throw new Error("expected a rejection");
};

beforeAll(async () => { await import("../support/slack-broker.js").then((module) => module.loadSlackBroker()); });

// ---- payers and scopes

describe("resolvePayer and the chain payer", () => {
  const base = (extra: Partial<ResolvePayerInput> = {}): ResolvePayerInput => ({ origin: "app", project: "web", projectPays: false, agentId: AGENT, startedBy: { developerId: MAYA.developerId }, ...extra });

  it("an event or a schedule that names a chain is paid by the chain, and one that names only an agent by the agent", () => {
    for (const origin of ["event", "schedule"] as const) {
      expect(resolvePayer(base({ origin, chainId: CHAIN })), origin).toEqual({ kind: "chain", chainId: CHAIN });
      expect(resolvePayer(base({ origin })), origin).toEqual({ kind: "agent", agentId: AGENT });
    }
  });

  it("a chain's step run returns the payer the run was resolved to: a member, a project or the chain", () => {
    for (const chainPayer of [{ kind: "member", developerId: MAYA.developerId }, { kind: "project", project: "web" }, { kind: "chain", chainId: CHAIN }] as Payer[]) {
      expect(resolvePayer(base({ origin: "chain", chainPayer })), chainPayer.kind).toEqual(chainPayer);
      expect(resolvePayer(base({ origin: "chain", chainPayer, projectPays: true })), chainPayer.kind).toEqual(chainPayer);
    }
  });

  it("a project that pays pays for every origin a person starts, and a chain id means nothing to them", () => {
    for (const origin of ["app", "cli", "mcp", "slack"] as const) {
      expect(resolvePayer(base({ origin, projectPays: true, chainId: CHAIN })), origin).toEqual({ kind: "project", project: "web" });
      expect(resolvePayer(base({ origin, chainId: CHAIN })), origin).toEqual({ kind: "member", developerId: MAYA.developerId });
    }
  });

  it("the payer schema knows the chain payer and its id's form", () => {
    expect(PayerSchema.safeParse({ kind: "chain", chainId: CHAIN }).success).toBe(true);
    expect(PayerSchema.safeParse({ kind: "chain", chainId: "chn_short" }).success).toBe(false);
    expect(PayerSchema.safeParse({ kind: "chain", chainId: CHAIN, extra: 1 }).success).toBe(false);
  });

  it("an event or a schedule that names neither a chain nor an agent is refused, never charged to someone by default", () => {
    for (const origin of ["event", "schedule"] as const) {
      const { agentId: _agentId, ...rest } = base({ origin }); // eslint-disable-line @typescript-eslint/no-unused-vars -- the point is that there is none
      expect(() => resolvePayer(rest)).toThrow(/needs the agent that pays/);
    }
  });

  it("the model proxy's protocol carries the chain payer and the chain tags", () => {
    const tags = mintTagsFor({ payer: { kind: "chain", chainId: CHAIN }, place: WEB_PLACE, agentId: AGENT, origin: "chain", chain: { chainId: CHAIN, chainRunId: RUN } });
    const args = { orgId: TEST_ORG, purpose: "task", refId: "task-1", maxBudgetUsd: 2, ttlSeconds: 60, tags };
    expect(ModelAccessRequestSchema.safeParse({ op: "mintKey", args }).success).toBe(true);
    expect(ModelAccessRequestSchema.safeParse({ op: "mintKey", args: { ...args, tags: { ...tags, payerKind: "robot" } } }).success).toBe(false);
  });

  it("names the chain as who pays in a key's tags and the ledger, and mints in no member's name", () => {
    const payer: Payer = { kind: "chain", chainId: CHAIN };
    expect(payerIdOf(payer)).toBe(CHAIN);
    expect(keyMember(payer)).toBeUndefined();
    const tags = mintTagsFor({ payer, place: WEB_PLACE, agentId: AGENT, origin: "chain", taskId: "task-1", operationId: "op-1", chain: { chainId: CHAIN, chainRunId: RUN } });
    expect(tags).toMatchObject({ payerKind: "chain", payerId: CHAIN, chainId: CHAIN, chainRunId: RUN, agentId: AGENT, project: "web" });
    // A step that is not a chain's carries neither tag.
    expect(mintTagsFor({ payer: { kind: "member", developerId: MAYA.developerId }, place: WEB_PLACE, agentId: AGENT, origin: "app" })).not.toHaveProperty("chainId");
  });
});

describe("budgetScopesFor with a chain payer", () => {
  it("a person-started run on a member-paid project is the org, the member and the project", () => {
    const payer: Payer = { kind: "member", developerId: MAYA.developerId };
    expect(budgetScopesFor(payer, WEB_PLACE, { agentId: AGENT })).toEqual([{ kind: "org" }, { kind: "project", project: "web" }, { kind: "member", developerId: MAYA.developerId }]);
  });

  it("an event-started run is the org, the project and the chain, and never the agent (no double counting)", () => {
    const scopes = budgetScopesFor({ kind: "chain", chainId: CHAIN }, WEB_PLACE, { agentId: AGENT });
    expect(scopes).toEqual([{ kind: "org" }, { kind: "project", project: "web" }, { kind: "chain", chainId: CHAIN }]);
    expect(scopes.map(scopeKey)).toEqual(["ORG", "PROJECT#web", `CHAIN#${CHAIN}`]);
    expect(scopes.some((scope) => scope.kind === "agent" || scope.kind === "member")).toBe(false);
    // The agent's own usage counter (visibility, no limit) still counts the step: it is not a scope.
    expect(agentUsageCounter(AGENT as never)).toBe(`AGENT_USAGE#${AGENT}`);
  });
});

// ---- the chain scope: its limit, its refusals, five concurrent steps

function setup() {
  const db = new FakeDynamoDb();
  const access: FakeModelAccess = fakeModelAccess();
  access.setMemberSpent(TEST_ORG, MAYA.developerId, 0);
  access.setMemberSpent(TEST_ORG, KIT, 0);
  access.setOrgSpent(TEST_ORG, 0);
  const deps = { documentClient: db, tableName: "state", access, now: () => T0, cloud: true };
  const ledger: LedgerDependencies = { documentClient: db, tableName: "state", access, now: () => T0, cloud: true };
  const counter = (scope: BudgetScope) => db.get(spendCounterKey(TEST_ORG, MONTH, scopeKey(scope))) as { spentUsd?: number; committedUsd?: number } | undefined;
  const limitChain = (limitUsd: number, chainId = CHAIN) => db.set({ ...chainKey(TEST_ORG, chainId, "META"), entityType: "CHAIN_META", monthlyBudgetUsd: limitUsd });
  const topUp = (usd: number, chainId = CHAIN) => db.set({ ...topUpKey(TEST_ORG, MONTH, { kind: "chain", chainId }), entityType: "TOPUP", amountUsd: usd });
  return { db, access, deps, ledger, counter, limitChain, topUp };
}

const chainPayer: Payer = { kind: "chain", chainId: CHAIN };
function stepInput(extra: Partial<MintOperationKeyInput> = {}, taskId = "task-1"): MintOperationKeyInput {
  return {
    orgId: TEST_ORG, refId: taskId, ttlSeconds: 3600, agentName: "Root-cause analyst", chainName: "Investigate",
    scopes: budgetScopesFor(chainPayer, WEB_PLACE, { agentId: "root-cause-analyst" }),
    tags: mintTagsFor({ payer: chainPayer, place: WEB_PLACE, agentId: "root-cause-analyst", origin: "chain", taskId, operationId: "op-1", chain: { chainId: CHAIN, chainRunId: RUN } }),
    runLimitUsd: 2, stopAtUsd: 2, taskKeyIds: [], pause: { taskId, key: taskKey(taskId) },
    ...extra,
  };
}
const minted = (outcome: Awaited<ReturnType<typeof mintOperationKey>>) => {
  if (outcome.outcome !== "minted") throw new Error("expected a minted key");
  return outcome;
};

describe("the chain scope", () => {
  it("has the refusals Task 5 names, and a limit that is the chain's budget plus the month's top-up, never above the guardrail", async () => {
    expect(SCOPE_ERRORS.chain).toEqual({ required: "CHAIN_BUDGET_REQUIRED", exceeded: "CHAIN_BUDGET_EXCEEDED" });
    const t = setup();
    const scope: BudgetScope = { kind: "chain", chainId: CHAIN };
    expect((await effectiveLimits(t.deps, { orgId: TEST_ORG, month: MONTH, scopes: [scope] })).get(`CHAIN#${CHAIN}`)).toBeUndefined();
    t.limitChain(12);
    expect((await effectiveLimits(t.deps, { orgId: TEST_ORG, month: MONTH, scopes: [scope] })).get(`CHAIN#${CHAIN}`)).toBe(12);
    t.topUp(10);
    expect((await effectiveLimits(t.deps, { orgId: TEST_ORG, month: MONTH, scopes: [scope] })).get(`CHAIN#${CHAIN}`)).toBe(22);
    // The guardrail holds the base and the top-up together (the default is $50 an agent or chain a month).
    t.topUp(100);
    expect((await effectiveLimits(t.deps, { orgId: TEST_ORG, month: MONTH, scopes: [scope] })).get(`CHAIN#${CHAIN}`)).toBe(DEFAULT_AGENT_GUARDRAILS.maxAgentMonthlyUsd);
    expect(typeof LIMIT_READERS.chain).toBe("function");
  });

  it("gives five concurrent $2 steps against a $5 chain budget $2, $2 and $1, and refuses two with CHAIN_BUDGET_EXCEEDED (Review Focus 3)", async () => {
    const t = setup();
    t.limitChain(5);
    let highest = 0;
    t.db.onWrite(({ after }) => {
      if (after?.pk === spendCounterKey(TEST_ORG, MONTH, `CHAIN#${CHAIN}`).pk && after.sk === `CHAIN#${CHAIN}`) highest = Math.max(highest, Number(after.committedUsd ?? 0));
    });
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => mintOperationKey({ ...t.deps, ledger: t.ledger }, stepInput({}, `task-${String(n)}`))));
    const caps = results.flatMap((result) => (result.status === "fulfilled" ? [minted(result.value).maxBudgetUsd] : [])).sort();
    const refusals = results.flatMap((result) => (result.status === "rejected" ? [(result.reason as { code: string }).code] : []));
    expect(caps).toEqual([1, 2, 2]);
    expect(refusals).toEqual(["CHAIN_BUDGET_EXCEEDED", "CHAIN_BUDGET_EXCEEDED"]);
    near(t.counter({ kind: "chain", chainId: CHAIN })?.committedUsd, 5);
    expect(highest).toBeLessThanOrEqual(5.000001);
    // The agent's own scope is not touched: a chain step counts once.
    expect(t.db.get(spendCounterKey(TEST_ORG, MONTH, `AGENT#root-cause-analyst`))).toBeUndefined();
  });

  it("refuses with the chain's own words, naming the chain and the figures", async () => {
    const t = setup();
    t.limitChain(5);
    t.db.set({ ...spendCounterKey(TEST_ORG, MONTH, `CHAIN#${CHAIN}`), entityType: "SPEND_COUNTER", spentUsd: 5, committedUsd: 5 });
    expect(await rejection(mintOperationKey({ ...t.deps, ledger: t.ledger }, stepInput()))).toMatchObject({
      code: "CHAIN_BUDGET_EXCEEDED", statusCode: 402, message: "CHAIN_BUDGET_EXCEEDED: Investigate's monthly AI budget is used up ($5.00 of $5.00). Ask its owner for more.",
    });
  });

  it("records the chain and the run on the key's tags, which the ledger lines carry", async () => {
    const t = setup();
    t.limitChain(5);
    const key = minted(await mintOperationKey({ ...t.deps, ledger: t.ledger }, stepInput()));
    const record = t.db.find((item) => item.entityType === "MODEL_KEY")[0] as { tags: Record<string, unknown> };
    expect(record.tags).toMatchObject({ payerKind: "chain", payerId: CHAIN, chainId: CHAIN, chainRunId: RUN });
    expect(t.access.mintKey.mock.calls.at(-1)![0]).toMatchObject({ tags: record.tags, maxBudgetUsd: key.maxBudgetUsd });
  });
});

// ---- the runner's side: payer, limits, admission, step settlement

describe("chainRunPayer", () => {
  it("is Plan 3's resolvePayer for the run's origin: an event or a schedule is the chain's, a person's run the member's, a paying project's the project's", async () => {
    const { chainRunPayer } = await budget();
    const input = { project: "web", projectPays: false, chainId: CHAIN as never };
    expect(chainRunPayer({ ...input, origin: "event" })).toEqual({ kind: "chain", chainId: CHAIN });
    expect(chainRunPayer({ ...input, origin: "schedule" })).toEqual({ kind: "chain", chainId: CHAIN });
    for (const origin of ["app", "cli", "mcp", "slack"] as const) {
      expect(chainRunPayer({ ...input, origin, startedBy: { developerId: MAYA.developerId } })).toEqual({ kind: "member", developerId: MAYA.developerId });
      expect(chainRunPayer({ ...input, origin, projectPays: true, startedBy: { developerId: MAYA.developerId } })).toEqual({ kind: "project", project: "web" });
    }
    expect(chainRunPayer({ ...input, origin: "linear", projectPays: true })).toEqual({ kind: "project", project: "web" });
  });

  it("a Linear-started run follows the payer table: a person who assigned it pays, a bot's assignment is paid by whoever approved it, else the project", async () => {
    const { chainRunPayer } = await budget();
    const input = { project: "web", projectPays: false, chainId: CHAIN as never, origin: "linear" as const };
    expect(chainRunPayer({ ...input, assignedBy: { developerId: MAYA.developerId, bot: false } })).toEqual({ kind: "member", developerId: MAYA.developerId });
    expect(chainRunPayer({ ...input, assignedBy: { bot: true }, approvedBy: { developerId: KIT } })).toEqual({ kind: "member", developerId: KIT });
    expect(chainRunPayer({ ...input, assignedBy: { bot: true } })).toEqual({ kind: "project", project: "web" });
    expect(chainRunPayer({ ...input, projectPays: true, assignedBy: { developerId: MAYA.developerId, bot: false } })).toEqual({ kind: "project", project: "web" });
  });

  it("refuses a person's run that names nobody who started it", async () => {
    const { chainRunPayer } = await budget();
    expect(() => chainRunPayer({ project: "web", projectPays: false, chainId: CHAIN, origin: "app" })).toThrow(/needs the person who started it/);
  });
});

describe("chainRunLimitUsd", () => {
  const pinned = (maxRunUsd?: number) => ({ limits: maxRunUsd === undefined ? {} : { maxRunUsd } }) as never;
  it("is the design's maxRunUsd when set, else the default for a person's run", async () => {
    const { chainRunLimitUsd } = await budget();
    expect(chainRunLimitUsd(pinned(7), "app")).toBe(7);
    expect(chainRunLimitUsd(pinned(7), "event")).toBe(7);
    for (const origin of ["app", "cli", "mcp", "slack", "linear"] as const) expect(chainRunLimitUsd(pinned(), origin)).toBe(DEFAULT_PERSON_CHAIN_RUN_LIMIT_USD);
  });

  it("is refused for an autonomous run without one: events and schedules need maxRunUsd (Task 18 refuses the trigger first)", async () => {
    const { chainRunLimitUsd } = await budget();
    for (const origin of ["event", "schedule"] as const) expect(() => chainRunLimitUsd(pinned(), origin)).toThrow(/maxRunUsd/);
  });
});

describe("stepRunLimitUsd and settleStepSpend", () => {
  it("the limit a step starts with is what the run has left, never below 0", async () => {
    const { stepRunLimitUsd } = await budget();
    near(stepRunLimitUsd({ runLimitUsd: 3, spentUsd: 2.8 }), 0.2);
    expect(stepRunLimitUsd({ runLimitUsd: 3, spentUsd: 3 })).toBe(0);
    expect(stepRunLimitUsd({ runLimitUsd: 3, spentUsd: 4 })).toBe(0);
  });

  it("an approved raise from $0.20 to $5.20 adds 5 to the run limit and what was spent to the run's", async () => {
    const { settleStepSpend, stepRunLimitUsd } = await budget();
    const run = { runLimitUsd: 3, spentUsd: 2.8 };
    const attempt = { remainingAtStartUsd: stepRunLimitUsd(run) };
    const settled = settleStepSpend(run, attempt, { runLimitUsd: 5.2, spentUsd: 5.2 });
    expect(settled.spentUsd).toBe(5.2);
    near(settled.raisedUsd, 5);
    near(settled.run.runLimitUsd, 8);
    near(settled.run.spentUsd, 8);
  });

  it("a raise from the estimate up to what the run had left adds nothing: that money was inside the chain's limit already (Review Focus 9)", async () => {
    const { settleStepSpend, stepRunLimitUsd } = await budget();
    // A $10 run with nothing spent starts a step at $10 remaining; Plan 3 grants it $2, it pauses and a raise to $5 is approved.
    let run = { runLimitUsd: 10, spentUsd: 0 };
    for (const spent of [5, 3, 2]) {
      const attempt = { remainingAtStartUsd: stepRunLimitUsd(run) };
      const settled = settleStepSpend(run, attempt, { runLimitUsd: Math.min(5, attempt.remainingAtStartUsd), spentUsd: spent });
      expect(settled.raisedUsd).toBe(0);
      run = settled.run;
      expect(run.runLimitUsd).toBe(10);
    }
    // Three steps, $10 spent in all, and the run limit is still $10: the run never went past it.
    expect(run).toEqual({ runLimitUsd: 10, spentUsd: 10 });
    expect(stepRunLimitUsd(run)).toBe(0);
  });

  it("a step that asks for $12 against $10 remaining is a raise of 2 once a person approved it", async () => {
    const { settleStepSpend } = await budget();
    const settled = settleStepSpend({ runLimitUsd: 10, spentUsd: 0 }, { remainingAtStartUsd: 10 }, { runLimitUsd: 12, spentUsd: 12 });
    expect(settled.raisedUsd).toBe(2);
    expect(settled.run).toEqual({ runLimitUsd: 12, spentUsd: 12 });
  });

  it("says what was approved in the run's own words", async () => {
    const { runRaiseMessage } = await budget();
    expect(runRaiseMessage("Maya", 5)).toBe("Maya approved $5 more for this run.");
    expect(runRaiseMessage("Maya", 2.5)).toBe("Maya approved $2.5 more for this run.");
  });
});

describe("admitChainRun", () => {
  const first = { agentId: "root-cause-analyst", name: "Root-cause analyst" };
  it("refuses an autonomous run of a chain with no budget with CHAIN_BUDGET_REQUIRED and its exact words", async () => {
    const { admitChainRun } = await budget();
    const t = setup();
    expect(await rejection(admitChainRun(t.deps, { orgId: TEST_ORG, chain: { chainId: CHAIN, name: "Investigate" }, project: "web", payer: chainPayer, firstAgent: first }))).toMatchObject({
      code: "CHAIN_BUDGET_REQUIRED", statusCode: 409,
      message: "CHAIN_BUDGET_REQUIRED: Investigate has no monthly budget and run limit, so events and schedules can't start it. Ask its owner to set both.",
    });
  });

  it("admits it with room, and refuses it when the chain's month is used up", async () => {
    const { admitChainRun } = await budget();
    const t = setup();
    t.limitChain(5);
    await expect(admitChainRun(t.deps, { orgId: TEST_ORG, chain: { chainId: CHAIN, name: "Investigate" }, project: "web", payer: chainPayer, firstAgent: first })).resolves.toBeUndefined();
    t.db.set({ ...spendCounterKey(TEST_ORG, MONTH, `CHAIN#${CHAIN}`), entityType: "SPEND_COUNTER", spentUsd: 4.95, committedUsd: 4.95 });
    expect(await rejection(admitChainRun(t.deps, { orgId: TEST_ORG, chain: { chainId: CHAIN, name: "Investigate" }, project: "web", payer: chainPayer, firstAgent: first }))).toMatchObject({ code: "CHAIN_BUDGET_EXCEEDED" });
  });

  it("does not ask a person's run for the chain's budget: a member-paid run is admitted on the member's and the project's", async () => {
    const { admitChainRun } = await budget();
    const t = setup();
    await expect(admitChainRun(t.deps, {
      orgId: TEST_ORG, chain: { chainId: CHAIN, name: "Investigate" }, project: "web", payer: { kind: "member", developerId: MAYA.developerId }, firstAgent: first,
    })).resolves.toBeUndefined();
    // admitWork itself answers the room, the same one.
    expect(await admitWork(t.deps, { orgId: TEST_ORG, payer: { kind: "member", developerId: MAYA.developerId }, project: "web", agentId: "root-cause-analyst", agentName: "x", path: "AGENT" })).toHaveProperty("maxBudgetUsd");
  });
});

// ---- who approves

async function chainOf(t: World, who = MAYA, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await t.api(who, "POST", "/v1/app/chains", { name: `Chain ${randomUUID().slice(0, 8)}`, ...extra });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return (created.body.chain as { chainId: string }).chainId;
}
const setChainBudget = (t: World, who: typeof MAYA, chainId: string, monthlyUsd: number | null, extra: Record<string, unknown> = {}) =>
  t.api(who, "PUT", `/v1/app/chains/${chainId}/budget`, { monthlyUsd, ...extra });
const counterOf = (t: World, who: typeof MAYA) => t.db.get(ownerBudgetKey(TEST_ORG, who.developerId).pk, "TOTAL") as { totalUsd?: number; version?: number } | undefined;
const chainRecord = (t: World, chainId: string) => t.db.get(`ORG#${TEST_ORG}#CHAIN#${chainId}`, "META") as { monthlyBudgetUsd?: number; status: string; owner: Record<string, unknown>; accountable?: { developerId: string } } | undefined;
const ownerCapRequests = (t: World) => t.requests().filter((record) => record.kind === "owner_cap");
const OVER = (name: string, total: number) => `${name}'s agent and chain budgets would total $${String(total)} a month, over the $100 limit for one person. I asked an org admin to approve it.`;

/** What a chain run says about a step: the chain it belongs to and what the run had left when the step started. */
const reader = (chainId: string, remainingAtStartUsd: number) => ({ stepLimits: async () => ({ chainId, remainingAtStartUsd }) });

/** A task of Maya's chain-paid, as a chain step's start leaves it: the chain payer and the step it belongs to. */
async function chainTask(t: World, chainId: string, run = RUN) {
  const agentId = await t.agentOf();
  const task = await t.runOf(agentId);
  await t.set(task.taskId, "SET payer = :payer, #chain = :chain, origin = :origin", { ":payer": { kind: "chain", chainId }, ":chain": { chainRunId: run, stepId: "look" }, ":origin": "chain" }, { "#chain": "chain" });
  return task;
}
/** A run-limit request for a task, for the run's starter (Carl by default, who owns nothing here). */
const runLimitRequest = (taskId: string, amountUsd: number, newLimitUsd: number, starter: { developerId: string } = CARL): SpendRequestRecord => ({
  orgId: TEST_ORG, spendRequestId: "spr_aaaaaaaaaaaaaaaaaaaa", kind: "run_limit", scope: { kind: "task", taskId }, taskId, amountUsd, newLimitUsd, reason: "x",
  requestedBy: { kind: "system" }, requestedFor: { developerId: starter.developerId }, approverRole: "org_admin", approverIds: [], status: "PENDING", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1e9).toISOString(),
});

describe("who approves a chain's run limit", () => {
  it("a raise within the lead threshold goes to the chain's owner, a raise within the admin threshold to the owning project's maintainers, above it to the admins", async () => {
    const t = await setupWorld();
    const chainId = await chainOf(t);
    const task = await chainTask(t, chainId);
    const deps = { ...t.deps(), chainRunBudgets: reader(chainId, 1000) };
    expect(await spendApprovers(deps, runLimitRequest(task.taskId, 4, 8))).toMatchObject({ role: "chain_owner", ids: [MAYA.developerId] });
    // Maya is the starter and the owner: a member-owned chain's owner is the payer tier, so she may approve her own chain's raise only as Plan 3's rule allows it.
    const project = await spendApprovers(deps, runLimitRequest(task.taskId, 4, 40));
    expect(project.role).toBe("project_maintainer");
    expect(project.ids).toEqual([BEN.developerId]);
    expect((await spendApprovers(deps, runLimitRequest(task.taskId, 4, 400))).role).toBe("org_admin");
  });

  it("a project-owned chain's owner is the project's maintainers", async () => {
    const t = await setupWorld();
    const chainId = await chainOf(t, BEN, { owner: { kind: "project", project: "payments" }, accountable: { developerId: BEN.developerId } });
    const task = await chainTask(t, chainId);
    const deps = { ...t.deps(), chainRunBudgets: reader(chainId, 1000) };
    expect(await spendApprovers(deps, runLimitRequest(task.taskId, 3, 6))).toMatchObject({ role: "chain_owner", ids: [BEN.developerId] });
  });

  it("a run-level raise (it takes the run past its own limit) skips the project-maintainer tier: the chain's owner decides up to the admin threshold, the admins above it", async () => {
    const t = await setupWorld();
    const chainId = await chainOf(t);
    const task = await chainTask(t, chainId);
    // The step started with $10 left on the run; a new limit of $40 goes past it.
    const deps = { ...t.deps(), chainRunBudgets: reader(chainId, 10) };
    const runLevel = await spendApprovers(deps, runLimitRequest(task.taskId, 4, 40));
    expect(runLevel.role).toBe("chain_owner");
    expect(runLevel.ids).toEqual([MAYA.developerId]);
    expect((await spendApprovers(deps, runLimitRequest(task.taskId, 4, 400))).role).toBe("org_admin");
    // Within what the run had left it is an ordinary raise, with the maintainer tier.
    expect((await spendApprovers(deps, runLimitRequest(task.taskId, 4, 10))).role).toBe("chain_owner");
    const within = { ...t.deps(), chainRunBudgets: reader(chainId, 100) };
    expect((await spendApprovers(within, runLimitRequest(task.taskId, 4, 40))).role).toBe("project_maintainer");
  });

  it("fails closed: a chain step whose run's limit can't be read is a run-level raise", async () => {
    const t = await setupWorld();
    const chainId = await chainOf(t);
    const task = await chainTask(t, chainId);
    for (const unreadable of [undefined, { stepLimits: async () => undefined }]) {
      const deps = { ...t.deps(), ...(unreadable === undefined ? {} : { chainRunBudgets: unreadable }) };
      expect((await spendApprovers(deps, runLimitRequest(task.taskId, 4, 40))).role).toBe("chain_owner");
    }
  });

  it("an agent's or a member's task is routed exactly as Plan 3 routes it", async () => {
    const t = await setupWorld();
    const agentId = await t.agentOf();
    const task = await t.runOf(agentId);
    const deps = { ...t.deps(), chainRunBudgets: reader("chn_cccccccccccccccccccc", 1) };
    expect((await spendApprovers(deps, runLimitRequest(task.taskId, 4, 40))).role).toBe("project_maintainer");
  });
});

describe("a run-level raise is the chain owner's, whatever the payer and the amount", () => {
  /** Ben owns the chain; Maya starts the step, and pays for it herself or the project does. Carl is who the request is for unless a test says so. */
  async function steps(t: World, payer: "member" | "project") {
    const chainId = await chainOf(t, BEN);
    const task = await chainTask(t, chainId);
    await t.set(task.taskId, "SET payer = :payer", { ":payer": payer === "member" ? { kind: "member", developerId: MAYA.developerId } : { kind: "project", project: "payments" } });
    return { chainId, task };
  }

  it.each(["member", "project"] as const)("a %s-paid step's raise past what the run had left goes to the chain's owner at 8 and 40 dollars, and above the admin threshold to the admins", async (payer) => {
    const t = await setupWorld();
    const { chainId, task } = await steps(t, payer);
    const deps = { ...t.deps(), chainRunBudgets: reader(chainId, 3) };
    expect(await spendApprovers(deps, runLimitRequest(task.taskId, 5, 8))).toMatchObject({ role: "chain_owner", ids: [BEN.developerId] });
    expect(await spendApprovers(deps, runLimitRequest(task.taskId, 5, 40))).toMatchObject({ role: "chain_owner", ids: [BEN.developerId] });
    expect((await spendApprovers(deps, runLimitRequest(task.taskId, 5, 400))).role).toBe("org_admin");
  });

  it.each(["member", "project"] as const)("a %s-paid step's run-level raise without the run's seam, or with one that can't answer, goes to the admins (fail closed)", async (payer) => {
    const t = await setupWorld();
    const { task } = await steps(t, payer);
    for (const seam of [undefined, { stepLimits: async () => undefined }, { stepLimits: async (): Promise<undefined> => { throw new Error("down"); } }]) {
      const deps = { ...t.deps(), ...(seam === undefined ? {} : { chainRunBudgets: seam }) };
      expect((await spendApprovers(deps, runLimitRequest(task.taskId, 5, 8))).role).toBe("org_admin");
    }
  });

  it("a raise within what the run had left is Plan 3's: the payer's, whoever owns the chain", async () => {
    const t = await setupWorld();
    const { chainId, task } = await steps(t, "member");
    expect(await spendApprovers({ ...t.deps(), chainRunBudgets: reader(chainId, 100) }, runLimitRequest(task.taskId, 5, 8))).toMatchObject({ role: "payer", ids: [MAYA.developerId] });
  });

  it("a payer who starts the step and owns the chain can't approve a raise past their own run's limit, and can approve one within it", async () => {
    const t = await setupWorld();
    const chainId = await chainOf(t, MAYA);
    const task = await chainTask(t, chainId);
    await t.set(task.taskId, "SET payer = :payer", { ":payer": { kind: "member", developerId: MAYA.developerId } });
    const asked = (remaining: number) => spendApprovers({ ...t.deps(), chainRunBudgets: reader(chainId, remaining) }, runLimitRequest(task.taskId, 5, 8, MAYA));
    expect((await asked(3)).role).toBe("org_admin");
    expect(await asked(100)).toMatchObject({ role: "payer", ids: [MAYA.developerId] });
  });

  it("a starter does not decide their own run's raise on a chain-paid run, even as the chain's owner (Plan 3's rule: only the sole owner or admin does)", async () => {
    const t = await setupWorld();
    const chainId = await chainOf(t, MAYA);
    const task = await chainTask(t, chainId);
    const deps = { ...t.deps(), chainRunBudgets: reader(chainId, 1000) };
    const approvers = await spendApprovers(deps, runLimitRequest(task.taskId, 4, 8, MAYA));
    expect(approvers.role).toBe("org_admin");
    expect(approvers.ids).not.toContain(MAYA.developerId);
    // The same raise asked for someone else is the owner's.
    expect(await spendApprovers(deps, runLimitRequest(task.taskId, 4, 8, CARL))).toMatchObject({ role: "chain_owner", ids: [MAYA.developerId] });
  });
});

describe("who approves a chain's month", () => {
  const monthRequest = (chainId: string, amountUsd: number, asker = CARL): SpendRequestRecord => ({
    orgId: TEST_ORG, spendRequestId: "spr_bbbbbbbbbbbbbbbbbbbb", kind: "month", scope: { kind: "chain", chainId }, amountUsd, reason: "x", requestedBy: { kind: "member", developerId: asker.developerId },
    requestedFor: { developerId: asker.developerId }, approverRole: "org_admin", approverIds: [], status: "PENDING", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1e9).toISOString(),
  });

  it("has a rule for the chain scope", () => {
    expect(typeof MONTH_APPROVERS.chain).toBe("function");
  });

  it("goes to the chain's owner while the new limit stays within the guardrail and the owner's total within the cap, and to the admins above either", async () => {
    const t = await setupWorld();
    const chainId = await chainOf(t);
    expect((await setChainBudget(t, MAYA, chainId, 20)).status).toBe(200);
    const owner = await spendApprovers(t.deps(), monthRequest(chainId, 10));
    expect(owner).toMatchObject({ role: "chain_owner", ids: [MAYA.developerId], owner: { developerId: MAYA.developerId } });
    expect(typeof owner.owner?.version).toBe("number");
    // $20 + $40 is past the $50 an agent or chain may have.
    expect((await spendApprovers(t.deps(), monthRequest(chainId, 40))).role).toBe("org_admin");
    // The owner's effective total with the top-up past $100.
    await t.budgeted(30);
    await t.budgeted(30);
    expect(await spendApprovers(t.deps(), monthRequest(chainId, 25))).toMatchObject({ role: "org_admin" });
    expect((await spendApprovers(t.deps(), monthRequest(chainId, 15))).role).toBe("chain_owner");
  });

  it("a project-owned chain's month goes to the project's maintainers", async () => {
    const t = await setupWorld();
    const chainId = await chainOf(t, BEN, { owner: { kind: "project", project: "payments" }, accountable: { developerId: BEN.developerId } });
    expect((await setChainBudget(t, BEN, chainId, 20)).status).toBe(200);
    const approvers = await spendApprovers(t.deps(), monthRequest(chainId, 10, CARL));
    expect(approvers).toMatchObject({ role: "chain_owner", ids: [BEN.developerId] });
  });

  it("a chain with no owner to answer for it, or one that is gone, goes to the admins", async () => {
    const t = await setupWorld();
    expect((await spendApprovers(t.deps(), monthRequest(CHAIN, 10))).role).toBe("org_admin");
  });

  it("applies an approval as a top-up that the limit and the owner's effective total both read, and moves the owner counter's version", async () => {
    const t = await setupWorld();
    const chainId = await chainOf(t);
    expect((await setChainBudget(t, MAYA, chainId, 20)).status).toBe(200);
    const made = await createSpendRequest(t.deps(), {
      orgId: TEST_ORG, kind: "month", scope: { kind: "chain", chainId }, subject: `MONTH#${month()}#CHAIN#${chainId}#${CARL.developerId}`, amountUsd: 10, newLimitUsd: 30,
      requestedBy: { kind: "member", developerId: CARL.developerId }, requestedFor: { developerId: CARL.developerId }, reason: "More, please.",
    });
    expect(made.record.approverRole).toBe("chain_owner");
    const before = counterOf(t, MAYA)?.version ?? 0;
    await t.decide(MAYA, made.record.spendRequestId, "APPROVE");
    expect((await effectiveLimits(t.deps(), { orgId: TEST_ORG, month: month(), scopes: [{ kind: "chain", chainId }] })).get(`CHAIN#${chainId}`)).toBe(30);
    expect((await ownerEffectiveTotal(t.deps(), { orgId: TEST_ORG, owner: MAYA.developerId, month: month() })).totalUsd).toBe(30);
    expect(counterOf(t, MAYA)?.version).toBe(before + 1);
    // The counter holds base budgets only: the top-up is the difference.
    expect(counterOf(t, MAYA)?.totalUsd).toBe(20);
  });

  it("refuses an admin's approval that would take the chain past the guardrail", async () => {
    const t = await setupWorld();
    const chainId = await chainOf(t);
    expect((await setChainBudget(t, MAYA, chainId, 40)).status).toBe(200);
    const made = await createSpendRequest(t.deps(), {
      orgId: TEST_ORG, kind: "month", scope: { kind: "chain", chainId }, subject: `MONTH#${month()}#CHAIN#${chainId}#${CARL.developerId}`, amountUsd: 20, newLimitUsd: 60,
      requestedBy: { kind: "member", developerId: CARL.developerId }, requestedFor: { developerId: CARL.developerId }, reason: "More, please.",
    });
    expect(made.record.approverRole).toBe("org_admin");
    expect(await refusal(t.decide(DEB, made.record.spendRequestId))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("is asked for by a member who may use the chain, and by no one who can't see it", async () => {
    const t = await setupWorld();
    const chainId = await chainOf(t);
    expect((await setChainBudget(t, MAYA, chainId, 20)).status).toBe(200);
    expect((await t.api(CARL, "POST", "/v1/app/spend-requests", { kind: "month", scope: { kind: "chain", chainId }, amountUsd: 10, reason: "x" })).status).toBe(404);
    const shared = await t.api(MAYA, "PUT", `/v1/app/chains/${chainId}/shares`, { shares: [{ principal: { kind: "member", developerId: CARL.developerId }, level: "use" }] });
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    const asked = await t.api(CARL, "POST", "/v1/app/spend-requests", { kind: "month", scope: { kind: "chain", chainId }, amountUsd: 10, reason: "x" });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
  });
});

// ---- the budget route and the owner's one monthly total

describe("PUT /v1/app/chains/{id}/budget", () => {
  it("sets and clears a chain's budget, and shows it", async () => {
    const t = await setupWorld();
    const chainId = await chainOf(t);
    const set = await setChainBudget(t, MAYA, chainId, 12);
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.chain).toMatchObject({ chainId, monthlyBudgetUsd: 12 });
    expect(chainRecord(t, chainId)?.monthlyBudgetUsd).toBe(12);
    expect(counterOf(t, MAYA)?.totalUsd).toBe(12);
    const cleared = await setChainBudget(t, MAYA, chainId, null);
    expect(cleared.status).toBe(200);
    expect(chainRecord(t, chainId)?.monthlyBudgetUsd).toBeUndefined();
    expect(counterOf(t, MAYA)?.totalUsd).toBe(0);
  });

  it("is for a person who manages the chain, and answers the same 404 to one who can't see it", async () => {
    const t = await setupWorld();
    const chainId = await chainOf(t);
    expect((await setChainBudget(t, CARL, chainId, 5)).status).toBe(404);
    await t.api(MAYA, "PUT", `/v1/app/chains/${chainId}/shares`, { shares: [{ principal: { kind: "member", developerId: CARL.developerId }, level: "use" }] });
    expect((await setChainBudget(t, CARL, chainId, 5)).status).toBe(403);
    expect(chainRecord(t, chainId)?.monthlyBudgetUsd).toBeUndefined();
  });

  it("is strict: a number or null, a request id, nothing else", async () => {
    const t = await setupWorld();
    const chainId = await chainOf(t);
    for (const body of [{}, { monthlyUsd: "5" }, { monthlyUsd: -1 }, { monthlyUsd: 5, maxPerRunUsd: 1 }]) {
      expect((await t.api(MAYA, "PUT", `/v1/app/chains/${chainId}/budget`, body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("refuses a budget above the guardrail's maximum, and reads the guardrail as it is now", async () => {
    const t = await setupWorld();
    const chainId = await chainOf(t);
    const refused = await setChainBudget(t, MAYA, chainId, 300);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain("guardrails allow at most $50 a month for one chain");
    expect(chainRecord(t, chainId)?.monthlyBudgetUsd).toBeUndefined();
    t.db.set({ ...agentGuardrailsKey(TEST_ORG), entityType: "AGENT_GUARDRAILS", revision: 1, updatedBy: ADA.developerId, updatedAt: "2026-10-21T00:00:00.000Z", guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxAgentMonthlyUsd: 70 } });
    expect((await setChainBudget(t, MAYA, chainId, 60)).status).toBe(200);
    const again = await setChainBudget(t, MAYA, chainId, 80);
    expect(again.status).toBe(400);
    expect(JSON.stringify(again.body)).toContain("at most $70 a month");
    expect(chainRecord(t, chainId)?.monthlyBudgetUsd).toBe(60);
  });

  it("replays a repeated request id without doing it again", async () => {
    const t = await setupWorld();
    const chainId = await chainOf(t);
    const requestId = randomUUID();
    const first = await t.api(MAYA, "PUT", `/v1/app/chains/${chainId}/budget`, { requestId, monthlyUsd: 9 });
    const again = await t.api(MAYA, "PUT", `/v1/app/chains/${chainId}/budget`, { requestId, monthlyUsd: 9 });
    expect([first.status, again.status]).toEqual([200, 200]);
    expect(counterOf(t, MAYA)?.totalUsd).toBe(9);
    expect((await t.api(MAYA, "PUT", `/v1/app/chains/${chainId}/budget`, { requestId, monthlyUsd: 10 })).status).toBe(400);
  });
});

describe("one monthly total for an owner's agent and chain budgets (R65)", () => {
  it("an owner with $80 of agent budgets setting a $30 chain budget gets 202 with the exact words, one owner_cap request for admins, and no change", async () => {
    const t = await setupWorld();
    await t.budgeted(40);
    await t.budgeted(40);
    const chainId = await chainOf(t);
    const reply = await setChainBudget(t, MAYA, chainId, 30);
    expect(reply.status).toBe(202);
    expect(reply.body).toMatchObject({ status: "NEEDS_ADMIN_APPROVAL", message: OVER("Maya Chen", 110) });
    expect(typeof reply.body.spendRequestId).toBe("string");
    expect(chainRecord(t, chainId)?.monthlyBudgetUsd).toBeUndefined();
    expect(t.ownerTotal(MAYA)).toBe(80);
    const [request] = ownerCapRequests(t);
    expect(ownerCapRequests(t)).toHaveLength(1);
    expect(request).toMatchObject({ spendRequestId: reply.body.spendRequestId, kind: "owner_cap", scope: { kind: "chain", chainId }, approverRole: "org_admin", status: "PENDING" });
    expect(request!.approverIds.sort()).toEqual([ADA.developerId, DEB.developerId].sort());
    // Asking again with the same change answers the same request.
    const again = await setChainBudget(t, MAYA, chainId, 30);
    expect(again.status).toBe(202);
    expect(again.body.spendRequestId).toBe(reply.body.spendRequestId);
    expect(ownerCapRequests(t)).toHaveLength(1);
  });

  it("an admin's approval applies the stored budget, and the owner's total reads $110", async () => {
    const t = await setupWorld();
    await t.budgeted(40);
    await t.budgeted(40);
    const chainId = await chainOf(t);
    const reply = await setChainBudget(t, MAYA, chainId, 30);
    expect(reply.status).toBe(202);
    await t.decide(DEB, String(reply.body.spendRequestId));
    expect(chainRecord(t, chainId)?.monthlyBudgetUsd).toBe(30);
    expect(t.ownerTotal(MAYA)).toBe(110);
    expect(t.requests().find((record) => record.spendRequestId === reply.body.spendRequestId)?.status).toBe("APPROVED");
    expect(t.db.find((item) => item.entityType === "CHAIN_EVENT" && item.chainId === chainId && item.kind === "budget_changed")[0]).toMatchObject({ overrideCap: reply.body.spendRequestId });
  });

  it("$20 passes at once, landing exactly on $100", async () => {
    const t = await setupWorld();
    await t.budgeted(40);
    await t.budgeted(40);
    const chainId = await chainOf(t);
    expect((await setChainBudget(t, MAYA, chainId, 20)).status).toBe(200);
    expect(t.ownerTotal(MAYA)).toBe(100);
    expect(ownerCapRequests(t)).toHaveLength(0);
  });

  it("two concurrent chain raises that together pass the cap let one apply, and the other answers 202 with an owner_cap request", async () => {
    const t = await setupWorld();
    await t.budgeted(35);
    await t.budgeted(35);
    const [x, y] = [await chainOf(t), await chainOf(t)];
    const replies = await Promise.all([setChainBudget(t, MAYA, x, 20), setChainBudget(t, MAYA, y, 20)]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 202]);
    expect(t.ownerTotal(MAYA)).toBe(90);
    expect(ownerCapRequests(t)).toHaveLength(1);
    expect([chainRecord(t, x)?.monthlyBudgetUsd, chainRecord(t, y)?.monthlyBudgetUsd].filter((usd) => usd !== undefined)).toEqual([20]);
  });

  it("a raise on a chain and a raise on an agent for one owner that together pass the cap: exactly one applies (the counter's version)", async () => {
    const t = await setupWorld();
    const agentA = await t.budgeted(40);
    await t.budgeted(40);
    const chainId = await chainOf(t);
    // $80 of agents: a chain at $15 (95) and an agent raised by $10 (90) each fit, but not together (105).
    const replies = await Promise.all([setChainBudget(t, MAYA, chainId, 15), t.setBudget(MAYA, agentA, { monthlyUsd: 50 })]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 202]);
    expect(ownerCapRequests(t)).toHaveLength(1);
    expect(t.ownerTotal(MAYA)).toBeLessThanOrEqual(100);
    const waiting = ownerCapRequests(t)[0]!;
    expect(["chain", "agent"]).toContain(waiting.scope?.kind);
  });

  it("holds a raise to the effective total, this month's top-ups included", async () => {
    const t = await setupWorld();
    const agentId = await t.budgeted(40);
    const chainId = await chainOf(t);
    // $45 of top-ups this month on the agent and on a chain: base $40, effective $85.
    t.db.set({ ...topUpKey(TEST_ORG, month(), { kind: "agent", agentId }), entityType: "TOPUP", amountUsd: 10 });
    expect((await setChainBudget(t, MAYA, chainId, 5)).status).toBe(200);
    t.db.set({ ...topUpKey(TEST_ORG, month(), { kind: "chain", chainId }), entityType: "TOPUP", amountUsd: 35 });
    // Effective: agent 50 + chain 5 + 35 = 90. A raise of the chain by $15 would make 105.
    expect((await ownerEffectiveTotal(t.deps(), { orgId: TEST_ORG, owner: MAYA.developerId, month: month() })).totalUsd).toBe(90);
    const reply = await setChainBudget(t, MAYA, chainId, 20);
    expect(reply.status).toBe(202);
    expect(reply.body.message).toBe(OVER("Maya Chen", 105));
    expect(chainRecord(t, chainId)?.monthlyBudgetUsd).toBe(5);
  });

  it("an archived chain isn't counted, and a project-owned chain counts for its accountable", async () => {
    const t = await setupWorld();
    await t.budgeted(40);
    const archived = await chainOf(t);
    expect((await setChainBudget(t, MAYA, archived, 30)).status).toBe(200);
    expect(t.ownerTotal(MAYA)).toBe(70);
    expect((await t.api(MAYA, "POST", `/v1/app/chains/${archived}/archive`, {})).status).toBe(200);
    expect(t.ownerTotal(MAYA)).toBe(40);
    const projectChain = await chainOf(t, BEN, { owner: { kind: "project", project: "payments" }, accountable: { developerId: BEN.developerId } });
    expect((await setChainBudget(t, BEN, projectChain, 25)).status).toBe(200);
    expect(t.ownerTotal(BEN)).toBe(25);
    expect(t.ownerTotal(MAYA)).toBe(40);
    expect((await ownerEffectiveTotal(t.deps(), { orgId: TEST_ORG, owner: BEN.developerId, month: month() })).totalUsd).toBe(25);
  });

  it("making an owner with no room the accountable of a project chain with a budget answers 202 and leaves the old accountable until approved", async () => {
    const t = await setupWorld();
    await t.budgeted(40, MAYA);
    await t.budgeted(40, MAYA);
    t.grantRole(MAYA, "maintainer");
    const chainId = await chainOf(t, BEN, { owner: { kind: "project", project: "payments" }, accountable: { developerId: BEN.developerId } });
    expect((await setChainBudget(t, BEN, chainId, 30)).status).toBe(200);
    expect(t.ownerTotal(BEN)).toBe(30);
    const reply = await t.api(BEN, "PUT", `/v1/app/chains/${chainId}/accountable`, { accountable: { developerId: MAYA.developerId } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    expect(reply.body.message).toBe(OVER("Maya Chen", 110));
    expect(chainRecord(t, chainId)?.accountable?.developerId).toBe(BEN.developerId);
    expect(t.ownerTotal(BEN)).toBe(30);
    expect(t.ownerTotal(MAYA)).toBe(80);
    await t.decide(DEB, String(reply.body.spendRequestId));
    expect(chainRecord(t, chainId)?.accountable?.developerId).toBe(MAYA.developerId);
    expect(t.ownerTotal(BEN)).toBe(0);
    expect(t.ownerTotal(MAYA)).toBe(110);
  });

  it("unarchiving a chain whose budget no longer fits answers 202 and leaves it archived", async () => {
    const t = await setupWorld();
    const chainId = await chainOf(t);
    expect((await setChainBudget(t, MAYA, chainId, 30)).status).toBe(200);
    expect((await t.api(MAYA, "POST", `/v1/app/chains/${chainId}/archive`, {})).status).toBe(200);
    await t.budgeted(40);
    await t.budgeted(40);
    const reply = await t.api(MAYA, "POST", `/v1/app/chains/${chainId}/unarchive`, {});
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    expect(reply.body.message).toBe(OVER("Maya Chen", 110));
    expect(chainRecord(t, chainId)?.status).toBe("archived");
    await t.decide(ADA, String(reply.body.spendRequestId));
    expect(chainRecord(t, chainId)?.status).toBe("active");
    expect(t.ownerTotal(MAYA)).toBe(110);
  });

  it("a transfer to an owner with no room answers 202 and leaves the old owner until approved", async () => {
    const t = await setupWorld();
    await t.budgeted(40, CARL);
    await t.budgeted(40, CARL);
    const chainId = await chainOf(t);
    expect((await setChainBudget(t, MAYA, chainId, 30)).status).toBe(200);
    // Handing a chain to another member is an admin's to do (as for an agent).
    const reply = await t.api(DEB, "PUT", `/v1/app/chains/${chainId}/owner`, { owner: { kind: "member", developerId: CARL.developerId } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    expect(reply.body.message).toBe(OVER("Carl Contributor", 110));
    expect(chainRecord(t, chainId)?.owner).toEqual({ kind: "member", developerId: MAYA.developerId });
    expect(t.ownerTotal(MAYA)).toBe(30);
    await t.decide(ADA, String(reply.body.spendRequestId));
    expect(chainRecord(t, chainId)?.owner).toEqual({ kind: "member", developerId: CARL.developerId });
    expect(t.ownerTotal(MAYA)).toBe(0);
    expect(t.ownerTotal(CARL)).toBe(110);
  });

  it("the chain's budget changes move the owner counter's version like an agent's do, so an approval summed at one version can't apply at another", async () => {
    const t = await setupWorld();
    const chainId = await chainOf(t);
    const start = counterOf(t, MAYA)?.version ?? 0;
    expect((await setChainBudget(t, MAYA, chainId, 10)).status).toBe(200);
    expect(counterOf(t, MAYA)?.version).toBe(start + 1);
    expect((await setChainBudget(t, MAYA, chainId, 12)).status).toBe(200);
    expect(counterOf(t, MAYA)?.version).toBe(start + 2);
  });

  it("shows the chain and the run on a ledger line", async () => {
    const t = await setupWorld();
    const at = new Date().toISOString();
    t.db.set({ ...ledgerKey(TEST_ORG, month(), at, "key1", 1), entityType: "LEDGER", orgId: TEST_ORG, month: month(), at, keyId: "key1", usd: 1, settledUsd: 1, finalized: false, agentId: AGENT, chainId: CHAIN, chainRunId: RUN, payerKind: "chain", payerId: CHAIN, source: "rovara", origin: "chain" });
    const reply = await t.api(ADA, "GET", `/v1/app/org/spend/ledger?month=${month()}`);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(JSON.stringify(reply.body)).toContain(RUN);
    expect(JSON.stringify(reply.body)).toContain(`"chainId":"${CHAIN}"`);
  });

  it("checks the guardrail again when an admin approves a chain budget over the cap, and leaves the request PENDING when it no longer holds", async () => {
    const t = await setupWorld();
    await t.budgeted(40);
    await t.budgeted(40);
    const chainId = await chainOf(t);
    const reply = await setChainBudget(t, MAYA, chainId, 30);
    expect(reply.status).toBe(202);
    t.db.set({ ...agentGuardrailsKey(TEST_ORG), entityType: "AGENT_GUARDRAILS", revision: 1, updatedBy: ADA.developerId, updatedAt: "2026-10-21T00:00:00.000Z", guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxAgentMonthlyUsd: 20 } });
    expect(await refusal(t.decide(DEB, String(reply.body.spendRequestId)))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(t.requests().find((record) => record.spendRequestId === reply.body.spendRequestId)?.status).toBe("PENDING");
    expect(chainRecord(t, chainId)?.monthlyBudgetUsd).toBeUndefined();
  });

  it("this month's top-up of a chain goes with it to the owner it moves to, and counts there", async () => {
    const t = await setupWorld();
    await t.budgeted(40, CARL);
    await t.budgeted(40, CARL);
    const chainId = await chainOf(t);
    expect((await setChainBudget(t, MAYA, chainId, 10)).status).toBe(200);
    t.db.set({ ...topUpKey(TEST_ORG, month(), { kind: "chain", chainId }), entityType: "TOPUP", amountUsd: 12 });
    // Carl has $80: with the chain's $10 base he would be at $90, but its $12 top-up goes with it ($102).
    const reply = await t.api(DEB, "PUT", `/v1/app/chains/${chainId}/owner`, { owner: { kind: "member", developerId: CARL.developerId } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    expect(reply.body.message).toBe(OVER("Carl Contributor", 102));
  });

  /** An owner at $95 of the $100 cap, with a chain whose base is $0 (the route allows it), and a month top-up asked for by Carl. */
  async function zeroBaseWorld() {
    const t = await setupWorld();
    await t.budgeted(40);
    await t.budgeted(40);
    await t.budgeted(15);
    const chainId = await chainOf(t);
    expect((await setChainBudget(t, MAYA, chainId, 0)).status).toBe(200);
    const topUp = (amountUsd: number) => createSpendRequest(t.deps(), {
      orgId: TEST_ORG, kind: "month", scope: { kind: "chain", chainId }, subject: `MONTH#${month()}#CHAIN#${chainId}#${CARL.developerId}`, amountUsd, newLimitUsd: amountUsd,
      requestedBy: { kind: "member", developerId: CARL.developerId }, requestedFor: { developerId: CARL.developerId }, reason: "More, please.",
    });
    return { t, chainId, topUp };
  }

  it("two successive owner-approved top-ups of a $0-base chain near the cap: the first applies, the second goes to the admins (review I-2)", async () => {
    const { t, chainId, topUp } = await zeroBaseWorld();
    const first = await topUp(5);
    expect(first.record.approverRole).toBe("chain_owner");
    await t.decide(MAYA, first.record.spendRequestId);
    expect((await effectiveLimits(t.deps(), { orgId: TEST_ORG, month: month(), scopes: [{ kind: "chain", chainId }] })).get(`CHAIN#${chainId}`)).toBe(5);
    // The $5 is in the owner's effective total now: $95 + $5 = $100.
    expect((await ownerEffectiveTotal(t.deps(), { orgId: TEST_ORG, owner: MAYA.developerId, month: month() })).totalUsd).toBe(100);
    const second = await topUp(5);
    expect(second.record.approverRole).toBe("org_admin");
    expect(second.record.approverIds.sort()).toEqual([ADA.developerId, DEB.developerId].sort());
    // The owner can't approve it; an admin can, and it applies.
    expect(await refusal(t.decide(MAYA, second.record.spendRequestId))).toMatchObject({ code: "FORBIDDEN" });
    await t.decide(DEB, second.record.spendRequestId);
    expect((await effectiveLimits(t.deps(), { orgId: TEST_ORG, month: month(), scopes: [{ kind: "chain", chainId }] })).get(`CHAIN#${chainId}`)).toBe(10);
  });

  it("a $0-base chain's month top-up goes with it to the owner it moves to, and counts there", async () => {
    const { t, chainId } = await zeroBaseWorld();
    t.db.set({ ...topUpKey(TEST_ORG, month(), { kind: "chain", chainId }), entityType: "TOPUP", amountUsd: 12 });
    await t.budgeted(40, CARL);
    await t.budgeted(40, CARL);
    await t.budgeted(15, CARL);
    // Carl has $95; the chain adds no base but its $12 top-up goes with it: $107.
    const reply = await t.api(DEB, "PUT", `/v1/app/chains/${chainId}/owner`, { owner: { kind: "member", developerId: CARL.developerId } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    expect(reply.body.message).toBe(OVER("Carl Contributor", 107));
    expect(chainRecord(t, chainId)?.owner).toEqual({ kind: "member", developerId: MAYA.developerId });
  });

  it("unarchiving a $0-base chain brings its month top-up back into the owner's total, held to the cap", async () => {
    const { t, chainId } = await zeroBaseWorld();
    t.db.set({ ...topUpKey(TEST_ORG, month(), { kind: "chain", chainId }), entityType: "TOPUP", amountUsd: 12 });
    expect((await t.api(MAYA, "POST", `/v1/app/chains/${chainId}/archive`, {})).status).toBe(200);
    const reply = await t.api(MAYA, "POST", `/v1/app/chains/${chainId}/unarchive`, {});
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    expect(reply.body.message).toBe(OVER("Maya Chen", 107));
    expect(chainRecord(t, chainId)?.status).toBe("archived");
  });

  it("registers chains as a contributor to the owner's effective total beside agents", () => {
    expect(OWNER_TOTAL_CONTRIBUTORS.length).toBeGreaterThanOrEqual(2);
  });
});

describe("R66 for a chain's owner_cap request", () => {
  it("deciding it with a CLI token is refused and leaves it PENDING; the confirmation page's fresh admin session applies it", async () => {
    const t = await setupWorld({ decide: true });
    await t.budgeted(40);
    await t.budgeted(40);
    const chainId = await chainOf(t);
    const reply = await setChainBudget(t, MAYA, chainId, 30);
    expect(reply.status).toBe(202);
    const id = String(reply.body.spendRequestId);
    const viaToken = await t.dev(DEB, "POST", `/v1/app/spend-requests/${id}/decide`, { requestId: randomUUID(), decision: "APPROVE" });
    expect(viaToken.status).toBe(401);
    const error = viaToken.body.error as { code: string; confirmUrl: string };
    expect(error.code).toBe("REAUTH_REQUIRED");
    expect(error.confirmUrl).toMatch(new RegExp(`^${CELL}/v1/app/approve/${id}\\?ticket=`));
    expect(t.requests().find((record) => record.spendRequestId === id)?.status).toBe("PENDING");
    expect(chainRecord(t, chainId)?.monthlyBudgetUsd).toBeUndefined();
    // A fresh browser session of an admin decides it on the page.
    const store = new DecideStore({ documentClient: t.db, tableName: "signin", now: Date.now });
    const cookie = `cookie-${randomUUID()}-${"x".repeat(20)}`;
    const signedInAt = Math.floor(Date.now() / 1000) - 30;
    await store.putSession(cookie, { orgId: TEST_ORG, developerId: DEB.developerId, approvalId: id, signedInAt, method: "email_code", csrfHash: sha(csrfTokenFor(cookie)), expiresAt: signedInAt + 600 });
    const raw = async (method: string, body?: string) => await t.handler({
      version: "2.0", rawPath: `/v1/app/approve/${id}`, rawQueryString: "",
      headers: { cookie: `${DECIDE_COOKIE}=${cookie}`, ...(method === "POST" ? { origin: CELL, "content-type": "application/x-www-form-urlencoded" } : {}) },
      ...(body === undefined ? {} : { body }), requestContext: { requestId: randomUUID(), http: { method } },
    });
    const shown = await raw("GET");
    expect(shown.statusCode, shown.body).toBe(200);
    for (const expected of ["$110", "$100"]) expect(shown.body, expected).toContain(expected);
    const decided = await raw("POST", new URLSearchParams({ decision: "approve", csrf: csrfTokenFor(cookie) }).toString());
    expect(decided.statusCode, decided.body).toBe(200);
    expect(chainRecord(t, chainId)?.monthlyBudgetUsd).toBe(30);
    expect(t.ownerTotal(MAYA)).toBe(110);
  });
});
