// Plan 3 Task 30: the spend ledger and its settlement. A key's spend is read from the model proxy and counted once on every counter it belongs to, a
// key is reserved against the limited scopes before it is minted (Task 31 does that), and an ended operation's keys are blocked and finalized in two
// phases so a request the proxy admitted before the block still counts. These tests drive the ledger directly on a fake table and a fake proxy.
import { randomUUID } from "node:crypto";
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { marshall } from "@aws-sdk/util-dynamodb";
import { describe, expect, it, vi } from "vitest";
import {
  FINALIZE_DELAY_MS, KEY_EXPIRY_GRACE_MS, FINALIZED_SETTLE_WINDOW_MS,
  agentRunsKey, budgetAlertKey, builtinSettingsKey, ledgerKey, modelKeyKey, openModelKeysKey, orgSettingsKey, personalCounter, projectMemberKey, projectRevisionKey, spendCounterKey,
  type BudgetScope,
} from "@agentx/contracts";
import {
  ScopeFullError, blockOperationKeys, checkAlerts, finalizeKey, forgetKey, registerKey, reserve, settleKey, sweepSpend,
  type KeyInput, type LedgerDependencies, type ModelKeyRecord,
} from "../../packages/broker/src/spend/ledger.js";
import { learningFirstTick, runSettlementJobs, runSpendSweep } from "../../packages/broker/src/spend/settlement-job.js";
import { agentUsageCounter, mintTagsFor, paymentOfTask } from "../../packages/broker/src/spend/payer.js";
import { indexActivity, putCountedUsage, type IndexStore } from "../../packages/broker/src/aws/activity-index.js";
import type { StreamRecord } from "../../packages/broker/src/developer/notifications.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { keyIdOf } from "../../packages/broker/src/org/budget.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { fakeModelAccess, type FakeModelAccess } from "../support/fake-model-access.js";
import { MAYA as DEV_MAYA, OMAR as DEV_OMAR, createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, createBroker, registerSlackProject, serviceCall } from "../support/slack-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { singleOrgIdForEnv } from "../../packages/contracts/src/org-node.js";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { taskSpendKey } from "../../packages/contracts/src/org-scoped-keys.js";

skipLambdaBundling();

const OTHER_ORG = singleOrgIdForEnv("other-install");
const MAYA = "1".repeat(64);
const AGENT = "agt_aaaaaaaaaaaaaaaaaaaaaaaa" as never;
const MONTH = "2026-10";
const T0 = Date.parse("2026-10-21T12:00:00.000Z");
const MODEL = "claude-sonnet-4-6";

const ORG: BudgetScope = { kind: "org" };
const WEB: BudgetScope = { kind: "project", project: "web" };
const MEMBER: BudgetScope = { kind: "member", developerId: MAYA };

const SETTLEMENT_TICK_MS = 300_000;
/** Fakes Date only (it still advances) from the start of a coming 5-minute tick where `learningFirstTick` is `first`; when `first` is false the tick after it is not one either. */
function pinSettlementTick(first: boolean): void {
  let tick = Math.floor(Date.now() / SETTLEMENT_TICK_MS) + 1;
  while (learningFirstTick(tick * SETTLEMENT_TICK_MS) !== first || (!first && learningFirstTick((tick + 1) * SETTLEMENT_TICK_MS))) tick += 1;
  vi.useFakeTimers({ toFake: ["Date"], now: tick * SETTLEMENT_TICK_MS, shouldAdvanceTime: true });
}

/** A fake table and proxy with a clock the test moves; `key(n)` is the secret of the nth key and its id is what the ledger holds. */
function setup(options: { orgId?: typeof TEST_ORG; pageSize?: number } = {}) {
  const db = new FakeDynamoDb();
  const access: FakeModelAccess = fakeModelAccess();
  const clock = { now: T0 };
  const deps = (overrides: Partial<LedgerDependencies> = {}): LedgerDependencies => ({
    documentClient: db, tableName: "state", access, now: () => clock.now, ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }), ...overrides,
  });
  const orgId = options.orgId ?? TEST_ORG;
  let count = 0;
  /** A key that has not been minted at the proxy: the ledger knows only its id. */
  const input = (extra: Partial<KeyInput> = {}): KeyInput => {
    count += 1;
    const secret = `sk-ledger-key-${String(count).padStart(4, "0")}`;
    return {
      orgId, month: MONTH, keyId: keyIdOf(secret), capUsd: 5, scopes: [{ key: ORG }, { key: WEB }, { key: MEMBER }],
      tags: mintTagsFor({ payer: { kind: "member", developerId: MAYA }, place: { project: "web" }, agentId: AGENT, origin: "app", taskId: `task-${String(count)}`, operationId: `op-${String(count)}` }),
      model: MODEL, expiresAt: T0 + 3_600_000, ...extra,
    };
  };
  const spend = (key: KeyInput, usd: number) => { access.setKeySpent(secretOf(key), usd); };
  const secretOf = (key: KeyInput): string => {
    for (let n = 1; n <= count; n += 1) {
      const secret = `sk-ledger-key-${String(n).padStart(4, "0")}`;
      if (keyIdOf(secret) === key.keyId) return secret;
    }
    throw new Error("unknown key");
  };
  const counter = (sk: string, org = orgId) => db.get(spendCounterKey(org, MONTH, sk)) as { spentUsd?: number; committedUsd?: number; tokens?: number } | undefined;
  const record = (keyId: string, org = orgId) => db.get(modelKeyKey(org, keyId)) as (ModelKeyRecord & Record<string, unknown>) | undefined;
  const ledger = (org = orgId) => db.find((item) => typeof item.pk === "string" && item.pk.startsWith(`ORG#${org}#LEDGER#`));
  /** The writes a block of work did, by item key. */
  const writesDuring = async (work: () => Promise<unknown>): Promise<string[]> => {
    const writes: string[] = [];
    const stop = db.onWrite(({ before, after }) => { const item = after ?? before; writes.push(`${String(item?.pk)}|${String(item?.sk)}`); });
    try { await work(); } finally { stop(); }
    return writes;
  };
  return { db, access, clock, deps, input, spend, counter, record, ledger, writesDuring, orgId };
}

const limitProject = (db: FakeDynamoDb, orgId: typeof TEST_ORG, limitUsd: number) =>
  db.set({ pk: `ORG#${orgId}#PROJECT_AI#web`, sk: "SETTINGS", entityType: "PROJECT_AI", projectPays: false, monthlyBudgetUsd: limitUsd, revision: 1 });
const limitOrg = (db: FakeDynamoDb, orgId: typeof TEST_ORG, limitUsd: number) =>
  db.set({ ...orgSettingsKey(orgId, "BUDGET"), entityType: "ORG_BUDGET", orgMonthlyUsd: limitUsd, memberOverrides: {} });
const near = (value: number | undefined, expected: number) => expect(value ?? 0).toBeCloseTo(expected, 6);

describe("reserve", () => {
  it("holds the cap on every scope, and refuses a key that would not fit the project's limit, naming the scope and writing nothing", async () => {
    const t = setup();
    const first = t.input({ scopes: [{ key: ORG }, { key: WEB, limitUsd: 10 }], capUsd: 5 });
    await reserve(t.deps(), first);
    near(t.counter("PROJECT#web")?.committedUsd, 5);
    near(t.counter("ORG")?.committedUsd, 5);
    const second = t.input({ scopes: [{ key: ORG }, { key: WEB, limitUsd: 10 }], capUsd: 6 });
    const refused = await reserve(t.deps(), second).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ScopeFullError);
    expect((refused as ScopeFullError).scope).toBe("PROJECT#web");
    // The org counter was in the same transaction, so it did not move, and the refused key left no record or index item.
    near(t.counter("ORG")?.committedUsd, 5);
    near(t.counter("PROJECT#web")?.committedUsd, 5);
    expect(t.record(second.keyId)).toBeUndefined();
    expect(t.db.get(openModelKeysKey(new Date(T0).toISOString(), t.orgId, second.keyId))).toBeUndefined();
  });

  it("lets keys fill a limit exactly and refuses the next cent, and fits a key whose cap is the whole limit", async () => {
    const t = setup();
    await reserve(t.deps(), t.input({ scopes: [{ key: WEB, limitUsd: 10 }], capUsd: 5 }));
    await reserve(t.deps(), t.input({ scopes: [{ key: WEB, limitUsd: 10 }], capUsd: 5 }));
    near(t.counter("PROJECT#web")?.committedUsd, 10);
    const over = await reserve(t.deps(), t.input({ scopes: [{ key: WEB, limitUsd: 10 }], capUsd: 0.01 })).catch((error: unknown) => error);
    expect((over as ScopeFullError).scope).toBe("PROJECT#web");
    const fresh = setup();
    await expect(reserve(fresh.deps(), fresh.input({ scopes: [{ key: WEB, limitUsd: 5 }], capUsd: 5 }))).resolves.toBeDefined();
  });

  it("refuses a cap above the limit even when nothing is committed yet", async () => {
    const t = setup();
    const refused = await reserve(t.deps(), t.input({ scopes: [{ key: WEB, limitUsd: 3 }], capUsd: 4 })).catch((error: unknown) => error);
    expect((refused as ScopeFullError).scope).toBe("PROJECT#web");
    expect(t.counter("PROJECT#web")).toBeUndefined();
  });

  it("names the scope that is full when several are limited", async () => {
    const t = setup();
    await reserve(t.deps(), t.input({ scopes: [{ key: ORG, limitUsd: 100 }, { key: WEB, limitUsd: 100 }, { key: MEMBER, limitUsd: 4 }], capUsd: 3 }));
    const refused = await reserve(t.deps(), t.input({ scopes: [{ key: ORG, limitUsd: 100 }, { key: WEB, limitUsd: 100 }, { key: MEMBER, limitUsd: 4 }], capUsd: 3 })).catch((error: unknown) => error);
    expect((refused as ScopeFullError).scope).toBe(`MEMBER#${MAYA}`);
  });

  it("answers a repeat of the same key with the record it already made, adding nothing", async () => {
    const t = setup();
    const key = t.input({ scopes: [{ key: WEB, limitUsd: 10 }], capUsd: 5 });
    const first = await reserve(t.deps(), key);
    const writes = await t.writesDuring(async () => { expect(await reserve(t.deps(), key)).toMatchObject({ keyId: first.keyId, capUsd: 5 }); });
    expect(writes).toEqual([]);
    near(t.counter("PROJECT#web")?.committedUsd, 5);
  });

  it("refuses a key with a month, expiry or id that is not one", async () => {
    const t = setup();
    for (const bad of [{ month: "2026-13" }, { month: "October" }, { expiresAt: Number.NaN }, { keyId: "sk-the-key-itself" }, { capUsd: -1 }]) {
      await expect(registerKey(t.deps(), t.input(bad)), JSON.stringify(bad)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      await expect(reserve(t.deps(), t.input(bad)), JSON.stringify(bad)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(t.db.find((item) => item.pk === "OPEN_MODEL_KEYS")).toEqual([]);
  });

  it("refuses a key with more scopes than one transaction can hold", async () => {
    const t = setup();
    const scopes = Array.from({ length: 40 }, (_, index): { key: BudgetScope } => ({ key: { kind: "project", project: `p${String(index)}` } }));
    await expect(reserve(t.deps(), t.input({ scopes }))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("settleKey", () => {
  it("adds a key's spend to every counter it belongs to, with one tagged ledger line, and a second settle writes nothing", async () => {
    const t = setup();
    const key = t.input();
    await registerKey(t.deps(), key);
    t.spend(key, 1.2);
    expect(await settleKey(t.deps(), t.orgId, key.keyId)).toMatchObject({ deltaUsd: 1.2, settledUsd: 1.2 });
    for (const sk of ["ORG", "PROJECT#web", `MEMBER#${MAYA}`, agentUsageCounter(AGENT), "SOURCE#rovara", `MODEL#${MODEL}`]) near(t.counter(sk)?.spentUsd, 1.2);
    expect(t.ledger()).toHaveLength(1);
    expect(t.ledger()[0]).toMatchObject({ keyId: key.keyId, usd: 1.2, month: MONTH, payerKind: "member", payerId: MAYA, agentId: AGENT, project: "web", origin: "app", source: "rovara", model: MODEL, taskId: key.tags.taskId, operationId: key.tags.operationId });
    near(t.record(key.keyId)?.settledUsd, 1.2);
    const writes = await t.writesDuring(async () => { expect(await settleKey(t.deps(), t.orgId, key.keyId)).toMatchObject({ deltaUsd: 0 }); });
    expect(writes).toEqual([]);
    expect(t.ledger()).toHaveLength(1);
  });

  it("counts only the new spend each time the proxy reports more", async () => {
    const t = setup();
    const key = t.input();
    await registerKey(t.deps(), key);
    t.spend(key, 1.2);
    await settleKey(t.deps(), t.orgId, key.keyId);
    t.spend(key, 2);
    expect(await settleKey(t.deps(), t.orgId, key.keyId)).toMatchObject({ deltaUsd: 0.8, settledUsd: 2 });
    near(t.counter("ORG")?.spentUsd, 2);
    expect(t.ledger().map((line) => line.usd)).toEqual([1.2, 0.8]);
  });

  it("adds each settle's spend to the task's own counter in the same transaction, once, and nothing for a key with no task (Plan 5 Task 7a)", async () => {
    const t = setup();
    const key = t.input();
    await registerKey(t.deps(), key);
    t.spend(key, 1.2);
    await settleKey(t.deps(), t.orgId, key.keyId);
    const counter = () => t.db.get(taskSpendKey(t.orgId, String(key.tags.taskId))) as { settledUsd?: number; orgId?: string } | undefined;
    near(counter()?.settledUsd, 1.2);
    expect(counter()?.orgId).toBe(t.orgId);
    t.spend(key, 2);
    await settleKey(t.deps(), t.orgId, key.keyId);
    near(counter()?.settledUsd, 2);
    // A second settle, and two at once, add nothing more.
    await settleKey(t.deps(), t.orgId, key.keyId);
    await Promise.all([settleKey(t.deps(), t.orgId, key.keyId), settleKey(t.deps(), t.orgId, key.keyId)]);
    near(counter()?.settledUsd, 2);
    // A key of Slack-thread work has no task and counts on no task counter.
    const bare = t.input({ tags: { ...key.tags, taskId: undefined } });
    await registerKey(t.deps(), bare);
    t.spend(bare, 1);
    await settleKey(t.deps(), t.orgId, bare.keyId);
    expect(t.db.find((item) => String(item.pk).includes("TASK_SPENT#"))).toHaveLength(1);
    // Another org's key counts on its own org's counter only.
    expect(t.db.get(taskSpendKey(OTHER_ORG, String(key.tags.taskId)))).toBeUndefined();
  });

  it("adds once when two settles of one key run at the same time", async () => {
    const t = setup();
    const key = t.input();
    await registerKey(t.deps(), key);
    t.spend(key, 1.2);
    const [one, two] = await Promise.all([settleKey(t.deps(), t.orgId, key.keyId), settleKey(t.deps(), t.orgId, key.keyId)]);
    expect([one.deltaUsd, two.deltaUsd].sort()).toEqual([0, 1.2]);
    near(t.counter("ORG")?.spentUsd, 1.2);
    near(t.counter("PROJECT#web")?.spentUsd, 1.2);
    expect(t.ledger()).toHaveLength(1);
  });

  it("does not move when the proxy's figure goes down", async () => {
    const t = setup();
    const key = t.input();
    await registerKey(t.deps(), key);
    t.spend(key, 2);
    await settleKey(t.deps(), t.orgId, key.keyId);
    t.spend(key, 1);
    expect(await settleKey(t.deps(), t.orgId, key.keyId)).toMatchObject({ deltaUsd: 0, settledUsd: 2 });
    near(t.counter("ORG")?.spentUsd, 2);
  });

  it("adds the overshoot over the cap to committed: $5.40 on a $5 cap adds 0.40", async () => {
    const t = setup();
    const key = t.input({ scopes: [{ key: WEB, limitUsd: 20 }], capUsd: 5 });
    await reserve(t.deps(), key);
    near(t.counter("PROJECT#web")?.committedUsd, 5);
    t.spend(key, 4);
    await settleKey(t.deps(), t.orgId, key.keyId);
    near(t.counter("PROJECT#web")?.committedUsd, 5);
    t.spend(key, 5.4);
    await settleKey(t.deps(), t.orgId, key.keyId);
    near(t.counter("PROJECT#web")?.committedUsd, 5.4);
    near(t.counter("PROJECT#web")?.spentUsd, 5.4);
    // A further settle of the same figure adds nothing.
    await settleKey(t.deps(), t.orgId, key.keyId);
    near(t.counter("PROJECT#web")?.committedUsd, 5.4);
  });

  it("counts a key that held no reservation into committed as it settles", async () => {
    const t = setup();
    const key = t.input({ scopes: [{ key: ORG }, { key: WEB }] });
    await registerKey(t.deps(), key);
    t.spend(key, 0.7);
    await settleKey(t.deps(), t.orgId, key.keyId);
    near(t.counter("ORG")?.committedUsd, 0.7);
    near(t.counter("PROJECT#web")?.committedUsd, 0.7);
  });

  it("adds work a person started to the agent's usage and not to the agent's own budget counter", async () => {
    const t = setup();
    const key = t.input();
    await registerKey(t.deps(), key);
    t.spend(key, 1);
    await settleKey(t.deps(), t.orgId, key.keyId);
    near(t.counter(agentUsageCounter(AGENT))?.spentUsd, 1);
    expect(t.counter(`AGENT#${String(AGENT)}`)).toBeUndefined();
    near(t.counter(`AGENT_ORIGIN#${String(AGENT)}#person`)?.spentUsd, 1);
  });

  it("counts an agent payer's work on the agent's own counter too, and a test run on the testing counter and the test split", async () => {
    const t = setup();
    const agentKey = t.input({
      scopes: [{ key: ORG }, { key: WEB }, { key: { kind: "agent", agentId: AGENT } }],
      tags: mintTagsFor({ payer: { kind: "agent", agentId: AGENT }, place: { project: "web" }, agentId: AGENT, origin: "schedule", operationId: "op-x" }),
    });
    await registerKey(t.deps(), agentKey);
    t.spend(agentKey, 0.5);
    await settleKey(t.deps(), t.orgId, agentKey.keyId);
    near(t.counter(`AGENT#${String(AGENT)}`)?.spentUsd, 0.5);
    near(t.counter(`AGENT_ORIGIN#${String(AGENT)}#autonomous`)?.spentUsd, 0.5);
    const test = t.input({
      scopes: [{ key: ORG }, { key: WEB }, { key: { kind: "testing", developerId: MAYA } }],
      tags: mintTagsFor({ payer: { kind: "project", project: "web" }, place: { project: "web" }, agentId: AGENT, origin: "test_run", operationId: "op-t" }),
    });
    await registerKey(t.deps(), test);
    t.spend(test, 0.25);
    await settleKey(t.deps(), t.orgId, test.keyId);
    near(t.counter(`TESTING#${MAYA}`)?.spentUsd, 0.25);
    near(t.counter(`AGENT_ORIGIN#${String(AGENT)}#test`)?.spentUsd, 0.25);
    expect(t.counter(`MEMBER#${MAYA}`)).toBeUndefined();
  });

  it("keeps a per-run total for the agent's recent runs", async () => {
    const t = setup();
    const key = t.input();
    await registerKey(t.deps(), key);
    t.spend(key, 1);
    await settleKey(t.deps(), t.orgId, key.keyId);
    t.spend(key, 1.5);
    await settleKey(t.deps(), t.orgId, key.keyId);
    const run = t.db.get(agentRunsKey(t.orgId, MONTH, AGENT, key.tags.taskId!)) as { usd: number; project: string; origin: string; lastAt: string } | undefined;
    near(run?.usd, 1.5);
    expect(run).toMatchObject({ project: "web", origin: "app" });
  });

  it("settles into the month the key was minted in", async () => {
    const t = setup();
    const key = t.input({ month: "2026-09" });
    await registerKey(t.deps(), key);
    t.spend(key, 1);
    await settleKey(t.deps(), t.orgId, key.keyId);
    expect(t.db.get(spendCounterKey(t.orgId, "2026-09", "ORG"))).toMatchObject({ spentUsd: 1 });
    expect(t.counter("ORG")).toBeUndefined();
  });

  it("settles nothing for a key the ledger does not know, or one of another org", async () => {
    const mine = setup();
    const key = mine.input();
    await registerKey(mine.deps(), key);
    mine.spend(key, 1);
    expect(await settleKey(mine.deps(), OTHER_ORG, key.keyId)).toMatchObject({ deltaUsd: 0 });
    expect(await settleKey(mine.deps(), mine.orgId, keyIdOf("sk-never-registered"))).toMatchObject({ deltaUsd: 0 });
    expect(mine.counter("ORG")).toBeUndefined();
    expect(mine.ledger()).toEqual([]);
  });

  // Staging 0.4.6, 2026-10-26T13:48:05Z: two keys of one chain run were settled by one sweep batch at once. They share every scope counter, the agent counters and
  // the run total, so DynamoDB cancelled the transactions with a TransactionConflict (no condition failed). The spend waited five minutes for the next sweep.
  const conflict = { name: "TransactionCanceledException", cancellationReasons: [{ Code: "None" }, { Code: "TransactionConflict" }, { Code: "TransactionConflict" }] };

  it("settles a key whose transaction was cancelled by a conflict with another settle, counting it once", async () => {
    const t = setup();
    const key = t.input();
    await registerKey(t.deps(), key);
    t.spend(key, 1.2);
    t.db.injectFault({ command: "TransactWriteCommand", error: conflict, times: 2 });
    expect(await settleKey(t.deps(), t.orgId, key.keyId)).toMatchObject({ deltaUsd: 1.2, settledUsd: 1.2 });
    for (const sk of ["ORG", "PROJECT#web", `MEMBER#${MAYA}`, agentUsageCounter(AGENT)]) near(t.counter(sk)?.spentUsd, 1.2);
    expect(t.ledger()).toHaveLength(1);
    near(t.record(key.keyId)?.settledUsd, 1.2);
  });

  it("gives a conflict that does not clear up to the caller with nothing counted, and the next settle counts it once", async () => {
    const t = setup();
    const key = t.input();
    await registerKey(t.deps(), key);
    t.spend(key, 1.2);
    let busy = true;
    t.db.injectFault({ command: "TransactWriteCommand", match: () => busy, error: conflict, times: 1000 });
    await expect(settleKey(t.deps(), t.orgId, key.keyId)).rejects.toMatchObject({ name: "TransactionCanceledException" });
    expect(t.counter("ORG")).toBeUndefined();
    expect(t.ledger()).toEqual([]);
    busy = false;
    expect(await settleKey(t.deps(), t.orgId, key.keyId)).toMatchObject({ deltaUsd: 1.2 });
    expect(await settleKey(t.deps(), t.orgId, key.keyId)).toMatchObject({ deltaUsd: 0 });
    near(t.counter("ORG")?.spentUsd, 1.2);
    expect(t.ledger()).toHaveLength(1);
  });

  it("names the reasons DynamoDB gave when the sweep cannot settle a key, and settles it on the next sweep", async () => {
    const t = setup();
    const key = t.input({ scopes: [{ key: ORG }] });
    await reserve(t.deps(), key);
    t.spend(key, 1.2);
    let busy = true;
    t.db.injectFault({ command: "TransactWriteCommand", match: () => busy, error: conflict, times: 1000 });
    const lines: Array<Record<string, unknown>> = [];
    expect(await sweepSpend(t.deps({ log: (entry) => lines.push(entry) }), t.clock.now)).toMatchObject({ failed: 1, settled: 0 });
    expect(lines).toContainEqual({ event: "spend.settle_failed", keyId: key.keyId, error: "TransactionCanceledException", reasons: ["None", "TransactionConflict", "TransactionConflict"] });
    busy = false;
    expect(await sweepSpend(t.deps(), t.clock.now)).toMatchObject({ failed: 0, settled: 1 });
    near(t.counter("ORG")?.spentUsd, 1.2);
  });

  it("leaves everything as it was when the proxy cannot be asked", async () => {
    const t = setup();
    const key = t.input();
    await registerKey(t.deps(), key);
    t.access.goDown();
    await expect(settleKey(t.deps(), t.orgId, key.keyId)).rejects.toMatchObject({ code: "MODEL_PROXY_UNAVAILABLE" });
    expect(t.counter("ORG")).toBeUndefined();
  });
});

describe("finalizeKey", () => {
  it("releases what the key did not spend: a $5 key that spent $1.20 gives back 3.80", async () => {
    const t = setup();
    const key = t.input({ scopes: [{ key: ORG }, { key: WEB, limitUsd: 20 }], capUsd: 5 });
    await reserve(t.deps(), key);
    t.spend(key, 1.2);
    await settleKey(t.deps(), t.orgId, key.keyId);
    near(t.counter("PROJECT#web")?.committedUsd, 5);
    expect(await finalizeKey(t.deps(), t.orgId, key.keyId)).toBe(true);
    near(t.counter("PROJECT#web")?.committedUsd, 1.2);
    near(t.counter("ORG")?.committedUsd, 1.2);
    near(t.counter("PROJECT#web")?.spentUsd, 1.2);
    expect(t.record(key.keyId)).toMatchObject({ finalized: true });
    // Finalizing again releases nothing more.
    const writes = await t.writesDuring(async () => { expect(await finalizeKey(t.deps(), t.orgId, key.keyId)).toBe(false); });
    expect(writes).toEqual([]);
    near(t.counter("PROJECT#web")?.committedUsd, 1.2);
  });

  it("releases nothing for a key that spent its whole cap or more, and the release frees room for another key", async () => {
    const t = setup();
    const key = t.input({ scopes: [{ key: WEB, limitUsd: 5 }], capUsd: 5 });
    await reserve(t.deps(), key);
    const blocked = await reserve(t.deps(), t.input({ scopes: [{ key: WEB, limitUsd: 5 }], capUsd: 1.5 })).catch((error: unknown) => error);
    expect(blocked).toBeInstanceOf(ScopeFullError);
    t.spend(key, 0.5);
    await settleKey(t.deps(), t.orgId, key.keyId);
    await finalizeKey(t.deps(), t.orgId, key.keyId);
    near(t.counter("PROJECT#web")?.committedUsd, 0.5);
    await expect(reserve(t.deps(), t.input({ scopes: [{ key: WEB, limitUsd: 5 }], capUsd: 1.5 }))).resolves.toBeDefined();
  });

  it("changes no counter for a key that held no reservation", async () => {
    const t = setup();
    const key = t.input({ scopes: [{ key: ORG }] });
    await registerKey(t.deps(), key);
    t.spend(key, 0.4);
    await settleKey(t.deps(), t.orgId, key.keyId);
    await finalizeKey(t.deps(), t.orgId, key.keyId);
    near(t.counter("ORG")?.committedUsd, 0.4);
  });

  it("counts spend that arrives after the finalize on both counters, once", async () => {
    const t = setup();
    const key = t.input({ scopes: [{ key: ORG }, { key: WEB, limitUsd: 20 }], capUsd: 5 });
    await reserve(t.deps(), key);
    t.spend(key, 1.2);
    await settleKey(t.deps(), t.orgId, key.keyId);
    await finalizeKey(t.deps(), t.orgId, key.keyId);
    near(t.counter("PROJECT#web")?.committedUsd, 1.2);
    t.spend(key, 1.5);
    expect(await settleKey(t.deps(), t.orgId, key.keyId)).toMatchObject({ deltaUsd: 0.3 });
    near(t.counter("PROJECT#web")?.spentUsd, 1.5);
    near(t.counter("PROJECT#web")?.committedUsd, 1.5);
    near(t.counter("ORG")?.committedUsd, 1.5);
    const writes = await t.writesDuring(async () => { await settleKey(t.deps(), t.orgId, key.keyId); });
    expect(writes).toEqual([]);
    near(t.counter("PROJECT#web")?.committedUsd, 1.5);
  });

  it("does not release twice when a finalize races a settle", async () => {
    const t = setup();
    const key = t.input({ scopes: [{ key: WEB, limitUsd: 20 }], capUsd: 5 });
    await reserve(t.deps(), key);
    t.spend(key, 1);
    await Promise.all([settleKey(t.deps(), t.orgId, key.keyId), finalizeKey(t.deps(), t.orgId, key.keyId), finalizeKey(t.deps(), t.orgId, key.keyId)]);
    await finalizeKey(t.deps(), t.orgId, key.keyId);
    near(t.counter("PROJECT#web")?.committedUsd, 1);
    near(t.counter("PROJECT#web")?.spentUsd, 1);
  });
});

describe("alerts", () => {
  it("writes the 80% alert once when a counter first passes it", async () => {
    const t = setup();
    limitOrg(t.db, t.orgId, 10);
    const first = t.input({ scopes: [{ key: ORG }] });
    await registerKey(t.deps(), first);
    t.spend(first, 7);
    await settleKey(t.deps(), t.orgId, first.keyId);
    expect(t.db.get(budgetAlertKey(t.orgId, MONTH, "ORG", "80"))).toBeUndefined();
    t.spend(first, 8.5);
    await settleKey(t.deps(), t.orgId, first.keyId);
    const alert = t.db.get(budgetAlertKey(t.orgId, MONTH, "ORG", "80")) as { spentUsd: number; limitUsd: number } | undefined;
    expect(alert).toMatchObject({ limitUsd: 10 });
    expect(t.db.get(budgetAlertKey(t.orgId, MONTH, "ORG", "100"))).toBeUndefined();
    // More spend over 80% writes no second item for the level.
    t.spend(first, 9);
    const writes = await t.writesDuring(async () => { await settleKey(t.deps(), t.orgId, first.keyId); });
    expect(writes.filter((write) => write.includes("BUDGET_ALERT"))).toEqual([]);
    t.spend(first, 10.5);
    await settleKey(t.deps(), t.orgId, first.keyId);
    expect(t.db.get(budgetAlertKey(t.orgId, MONTH, "ORG", "100"))).toBeDefined();
    expect(t.db.find((item) => String(item.pk).includes("BUDGET_ALERT"))).toHaveLength(2);
  });

  it("writes no alert for a scope without a limit", async () => {
    const t = setup();
    const key = t.input({ scopes: [{ key: ORG }] });
    await registerKey(t.deps(), key);
    t.spend(key, 500);
    await settleKey(t.deps(), t.orgId, key.keyId);
    expect(t.db.find((item) => String(item.pk).includes("BUDGET_ALERT"))).toEqual([]);
  });

  it("checkAlerts is idempotent, and a failure to write an alert never fails a settle", async () => {
    const t = setup();
    limitProject(t.db, t.orgId, 10);
    t.db.set({ ...spendCounterKey(t.orgId, MONTH, "PROJECT#web"), entityType: "SPEND_COUNTER", spentUsd: 9 });
    await checkAlerts(t.deps(), t.orgId, MONTH, [WEB]);
    await checkAlerts(t.deps(), t.orgId, MONTH, [WEB]);
    expect(t.db.find((item) => String(item.pk).includes("BUDGET_ALERT"))).toHaveLength(1);
    const broken = setup();
    limitOrg(broken.db, broken.orgId, 10);
    const key = broken.input({ scopes: [{ key: ORG }] });
    await registerKey(broken.deps(), key);
    broken.spend(key, 9);
    broken.db.injectFault({ command: "PutCommand", error: { name: "InternalServerError" }, times: 5 });
    await expect(settleKey(broken.deps(), broken.orgId, key.keyId)).resolves.toMatchObject({ deltaUsd: 9 });
    near(broken.counter("ORG")?.spentUsd, 9);
  });
});

describe("blockOperationKeys and sweepSpend", () => {
  it("blocks an ended operation's keys at the proxy, once, and starts the finalize clock", async () => {
    const t = setup();
    const mine = t.input();
    const other = t.input();
    await reserve(t.deps(), mine);
    await reserve(t.deps(), other);
    const operationId = mine.tags.operationId!;
    expect(await blockOperationKeys(t.deps(), { orgId: t.orgId, operationId, keyIds: [mine.keyId, other.keyId] })).toBe(1);
    expect(t.access.blockKey.mock.calls).toEqual([[mine.keyId]]);
    expect(t.record(mine.keyId)).toMatchObject({ finalized: false, finalizeAfter: T0 + FINALIZE_DELAY_MS });
    expect(t.record(other.keyId)?.finalizeAfter).toBeUndefined();
    // The same end reported again blocks nothing and moves nothing.
    t.clock.now += 5000;
    expect(await blockOperationKeys(t.deps(), { orgId: t.orgId, operationId, keyIds: [mine.keyId] })).toBe(0);
    expect(t.access.blockKey).toHaveBeenCalledTimes(1);
    expect(t.record(mine.keyId)).toMatchObject({ finalizeAfter: T0 + FINALIZE_DELAY_MS });
  });

  it("leaves the clock unstarted when the proxy cannot block the key, so a later end tries again", async () => {
    const t = setup();
    const key = t.input();
    await reserve(t.deps(), key);
    t.access.blockKey.mockRejectedValueOnce(Object.assign(new Error("down"), { code: "MODEL_PROXY_UNAVAILABLE" }));
    await expect(blockOperationKeys(t.deps(), { orgId: t.orgId, operationId: key.tags.operationId!, keyIds: [key.keyId] })).rejects.toThrow();
    expect(t.record(key.keyId)?.finalizeAfter).toBeUndefined();
    expect(await blockOperationKeys(t.deps(), { orgId: t.orgId, operationId: key.tags.operationId!, keyIds: [key.keyId] })).toBe(1);
  });

  it("settles a late request after the block, finalizes once, and a second sweep writes nothing", async () => {
    const t = setup();
    const key = t.input({ scopes: [{ key: ORG }, { key: WEB, limitUsd: 20 }], capUsd: 5 });
    await reserve(t.deps(), key);
    t.spend(key, 1.2);
    // The operation ends, the key is blocked.
    await sweepSpend(t.deps(), t.clock.now);
    near(t.counter("PROJECT#web")?.spentUsd, 1.2);
    await blockOperationKeys(t.deps(), { orgId: t.orgId, operationId: key.tags.operationId!, keyIds: [key.keyId] });
    // 90 seconds later a request the proxy had admitted before the block is billed.
    t.clock.now += 90_000;
    t.spend(key, 1.5);
    const early = await sweepSpend(t.deps(), t.clock.now);
    expect(early).toMatchObject({ settled: 1, finalized: 0 });
    near(t.counter("PROJECT#web")?.spentUsd, 1.5);
    near(t.counter("PROJECT#web")?.committedUsd, 5);
    // At the 2-minute mark the sweep finalizes it, releasing what it did not spend.
    t.clock.now += 31_000;
    const done = await sweepSpend(t.deps(), t.clock.now);
    expect(done).toMatchObject({ finalized: 1 });
    near(t.counter("PROJECT#web")?.committedUsd, 1.5);
    expect(t.record(key.keyId)).toMatchObject({ finalized: true });
    expect(t.ledger().map((line) => line.usd)).toEqual([1.2, 0.3]);
    // Another sweep finds nothing to write.
    t.clock.now += 60_000;
    const writes = await t.writesDuring(async () => { await sweepSpend(t.deps(), t.clock.now); });
    expect(writes).toEqual([]);
  });

  it("finalizes a key nobody blocked ten minutes after it expired", async () => {
    const t = setup();
    const key = t.input({ scopes: [{ key: WEB, limitUsd: 20 }], capUsd: 5, expiresAt: T0 + 60_000 });
    await reserve(t.deps(), key);
    t.spend(key, 2);
    t.clock.now = T0 + 60_000 + KEY_EXPIRY_GRACE_MS - 1;
    expect(await sweepSpend(t.deps(), t.clock.now)).toMatchObject({ finalized: 0 });
    near(t.counter("PROJECT#web")?.committedUsd, 5);
    t.clock.now += 1;
    expect(await sweepSpend(t.deps(), t.clock.now)).toMatchObject({ finalized: 1 });
    near(t.counter("PROJECT#web")?.committedUsd, 2);
  });

  it("keeps settling a finalized key for a day, then drops it from the index", async () => {
    const t = setup();
    const key = t.input({ scopes: [{ key: ORG }], capUsd: 5, expiresAt: T0 + 1000 });
    await reserve(t.deps(), key);
    t.clock.now = T0 + 1000 + KEY_EXPIRY_GRACE_MS;
    await sweepSpend(t.deps(), t.clock.now);
    expect(t.record(key.keyId)).toMatchObject({ finalized: true });
    const finalizedAt = t.clock.now;
    t.clock.now = finalizedAt + FINALIZED_SETTLE_WINDOW_MS - 1;
    t.spend(key, 0.4);
    expect(await sweepSpend(t.deps(), t.clock.now)).toMatchObject({ settled: 1 });
    near(t.counter("ORG")?.spentUsd, 0.4);
    near(t.counter("ORG")?.committedUsd, 0.4);
    const index = openModelKeysKey(new Date(T0).toISOString(), t.orgId, key.keyId);
    expect(t.db.get(index)).toBeDefined();
    // Past the day the sweep settles the key one last time (spend since the last sweep is not lost) and drops it; later spend is no longer followed.
    t.clock.now = finalizedAt + FINALIZED_SETTLE_WINDOW_MS + 1;
    t.spend(key, 0.9);
    await sweepSpend(t.deps(), t.clock.now);
    expect(t.db.get(index)).toBeUndefined();
    near(t.counter("ORG")?.spentUsd, 0.9);
    t.spend(key, 1.5);
    await sweepSpend(t.deps(), t.clock.now + 1000);
    near(t.counter("ORG")?.spentUsd, 0.9);
  });

  it("keeps a key past its day whose last settle failed, and drops it after a second day", async () => {
    const t = setup();
    const key = t.input({ scopes: [{ key: ORG }], expiresAt: T0 + 1000 });
    await reserve(t.deps(), key);
    t.clock.now = T0 + 1000 + KEY_EXPIRY_GRACE_MS;
    await sweepSpend(t.deps(), t.clock.now);
    const finalizedAt = t.clock.now;
    const index = openModelKeysKey(new Date(T0).toISOString(), t.orgId, key.keyId);
    t.access.goDown();
    t.clock.now = finalizedAt + FINALIZED_SETTLE_WINDOW_MS + 1;
    expect(await sweepSpend(t.deps(), t.clock.now)).toMatchObject({ failed: 1 });
    expect(t.db.get(index)).toBeDefined();
    t.clock.now = finalizedAt + 2 * FINALIZED_SETTLE_WINDOW_MS + 1;
    await sweepSpend(t.deps(), t.clock.now);
    expect(t.db.get(index)).toBeUndefined();
  });

  it("settles nothing for a finalized key once its day is over, even when asked directly", async () => {
    const t = setup();
    const key = t.input({ scopes: [{ key: ORG }], expiresAt: T0 + 1000 });
    await reserve(t.deps(), key);
    t.clock.now = T0 + 1000 + KEY_EXPIRY_GRACE_MS;
    await sweepSpend(t.deps(), t.clock.now);
    t.clock.now += FINALIZED_SETTLE_WINDOW_MS + 1;
    t.spend(key, 0.9);
    expect(await settleKey(t.deps(), t.orgId, key.keyId)).toMatchObject({ deltaUsd: 0 });
    expect(t.counter("ORG")?.spentUsd).toBeUndefined();
  });

  it("stops a page at the deadline, before the next batch, and resumes after the last key it did", async () => {
    const t = setup();
    const keys: KeyInput[] = [];
    for (let index = 0; index < 20; index += 1) {
      t.clock.now = T0 + index * 1000;
      const key = t.input({ scopes: [{ key: ORG }] });
      keys.push(key);
      await registerKey(t.deps(), key);
      t.spend(key, 1);
    }
    const start = T0 + 100_000;
    t.clock.now = start;
    // Every call to the proxy takes a second of the clock.
    t.access.keySpend.mockImplementation(async (ids) => { t.clock.now += 1000; return ids.length > 0 ? 1 : 0; });
    const first = await sweepSpend(t.deps(), start, undefined, { deadline: start + 5000 });
    expect(first).toMatchObject({ examined: 8, settled: 8, stopped: true });
    // The cursor is the last key the page did, so the next call starts exactly after it.
    expect(first.next).toBe(openModelKeysKey(new Date(T0 + 7000).toISOString(), t.orgId, keys[7]!.keyId).sk);
    near(t.counter("ORG")?.spentUsd, 8);
    const second = await sweepSpend(t.deps(), t.clock.now, first.next, { deadline: t.clock.now + 5000 });
    expect(second).toMatchObject({ examined: 8, stopped: true });
    const third = await sweepSpend(t.deps(), t.clock.now, second.next, { deadline: t.clock.now + 5000 });
    expect(third).toMatchObject({ examined: 4, settled: 4 });
    expect(third.stopped).toBeUndefined();
    expect(third.next).toBeUndefined();
    near(t.counter("ORG")?.spentUsd, 20);
    expect(t.ledger()).toHaveLength(20);
  });

  it("keeps a sweep within its budget when one page is slow: it saves where it stopped and the next run settles the rest, skipping none", async () => {
    const t = setup();
    for (let index = 0; index < 20; index += 1) {
      t.clock.now = T0 + index * 1000;
      const key = t.input({ scopes: [{ key: ORG }] });
      await registerKey(t.deps(), key);
      t.spend(key, 1);
    }
    t.clock.now = T0 + 100_000;
    t.access.keySpend.mockImplementation(async () => { t.clock.now += 1000; return 1; });
    const runs: Array<{ settled: number; complete: boolean; spent: number }> = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const before = t.clock.now;
      const run = await runSpendSweep(t.deps(), { budgetMs: 5000 });
      // The run never goes on past its budget by more than the one batch it was in.
      expect(t.clock.now - before).toBeLessThanOrEqual(5000 + 8 * 1000);
      runs.push({ settled: run.settled, complete: run.complete, spent: t.counter("ORG")?.spentUsd ?? 0 });
      if (run.complete) break;
    }
    expect(runs.map((run) => run.settled)).toEqual([8, 8, 4]);
    expect(runs.map((run) => run.complete)).toEqual([false, false, true]);
    near(t.counter("ORG")?.spentUsd, 20);
    expect(t.db.get({ pk: "SPEND_SWEEP", sk: "CURSOR" })).toBeUndefined();
  });

  it("writes an alert whose write was lost on a later sweep, though the key spends nothing more", async () => {
    const t = setup();
    limitOrg(t.db, t.orgId, 10);
    const key = t.input({ scopes: [{ key: ORG }] });
    await registerKey(t.deps(), key);
    t.spend(key, 9);
    t.db.injectFault({ command: "PutCommand", error: { name: "InternalServerError" }, times: 1 });
    await settleKey(t.deps(), t.orgId, key.keyId);
    expect(t.db.get(budgetAlertKey(t.orgId, MONTH, "ORG", "80"))).toBeUndefined();
    expect(t.record(key.keyId)?.alertsDue).toBe(true);
    await sweepSpend(t.deps(), T0);
    expect(t.db.get(budgetAlertKey(t.orgId, MONTH, "ORG", "80"))).toBeDefined();
    expect(t.record(key.keyId)?.alertsDue).toBeUndefined();
    // Nothing is left to do on the sweep after.
    const writes = await t.writesDuring(async () => { await sweepSpend(t.deps(), T0); });
    expect(writes).toEqual([]);
  });

  it("leaves no alert owed after a settle whose alerts were written", async () => {
    const t = setup();
    limitOrg(t.db, t.orgId, 10);
    const key = t.input({ scopes: [{ key: ORG }] });
    await registerKey(t.deps(), key);
    t.spend(key, 9);
    await settleKey(t.deps(), t.orgId, key.keyId);
    expect(t.db.get(budgetAlertKey(t.orgId, MONTH, "ORG", "80"))).toBeDefined();
    expect(t.record(key.keyId)?.alertsDue).toBeUndefined();
    // A newer settle's flag is not cleared by an older settle's alert check.
    t.spend(key, 9.5);
    t.db.injectFault({ command: "PutCommand", error: { name: "InternalServerError" }, times: 1 });
    await settleKey(t.deps(), t.orgId, key.keyId);
    expect(t.db.get(budgetAlertKey(t.orgId, MONTH, "ORG", "100"))).toBeUndefined();
  });

  it("pages the open keys by cursor, 50 at a time by default", async () => {
    const t = setup({ pageSize: 2 });
    const keys = [t.input({ scopes: [{ key: ORG }] }), t.input({ scopes: [{ key: ORG }] }), t.input({ scopes: [{ key: ORG }] }), t.input({ scopes: [{ key: ORG }] }), t.input({ scopes: [{ key: ORG }] })];
    for (const [index, key] of keys.entries()) {
      t.clock.now = T0 + index * 1000;
      await registerKey(t.deps(), key);
      t.spend(key, 1);
    }
    const pages: number[] = [];
    let cursor: string | undefined;
    do {
      const page = await sweepSpend(t.deps(), T0 + 10_000, cursor);
      pages.push(page.examined);
      cursor = page.next;
    } while (cursor !== undefined);
    expect(pages).toEqual([2, 2, 1]);
    near(t.counter("ORG")?.spentUsd, 5);
  });

  it("goes on past a key whose spend cannot be read and counts it as failed", async () => {
    const t = setup();
    const first = t.input({ scopes: [{ key: ORG }] });
    const second = t.input({ scopes: [{ key: ORG }] });
    t.clock.now = T0;
    await registerKey(t.deps(), first);
    t.clock.now = T0 + 1000;
    await registerKey(t.deps(), second);
    t.spend(first, 1);
    t.spend(second, 1);
    t.access.keySpend.mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "MODEL_PROXY_UNAVAILABLE" }));
    const page = await sweepSpend(t.deps(), T0 + 2000);
    expect(page).toMatchObject({ examined: 2, failed: 1, settled: 1 });
    near(t.counter("ORG")?.spentUsd, 1);
  });

  it("drops an index item whose record is gone", async () => {
    const t = setup();
    const key = t.input();
    await registerKey(t.deps(), key);
    t.db.delete(modelKeyKey(t.orgId, key.keyId));
    await sweepSpend(t.deps(), T0);
    expect(t.db.find((item) => item.pk === "OPEN_MODEL_KEYS")).toEqual([]);
  });

  it("never settles a key against another org's counters", async () => {
    const a = setup();
    const key = a.input({ scopes: [{ key: ORG }] });
    await registerKey(a.deps(), key);
    a.spend(key, 1);
    // An index item that names the wrong org for a key it points at is dropped and counts nothing.
    const index = openModelKeysKey(new Date(T0).toISOString(), a.orgId, key.keyId);
    a.db.delete(index);
    const forged = openModelKeysKey(new Date(T0).toISOString(), OTHER_ORG, key.keyId);
    a.db.set({ ...forged, entityType: "OPEN_MODEL_KEY", orgId: OTHER_ORG, keyId: key.keyId });
    await sweepSpend(a.deps(), T0);
    expect(a.db.get(forged)).toBeUndefined();
    expect(a.counter("ORG")).toBeUndefined();
    expect(a.db.get(spendCounterKey(OTHER_ORG, MONTH, "ORG"))).toBeUndefined();
  });
});

describe("the ledger lines", () => {
  it("are kept in the key's org and month, newest settle last in the sort key", async () => {
    const t = setup();
    const key = t.input({ scopes: [{ key: ORG }] });
    await registerKey(t.deps(), key);
    t.spend(key, 1);
    await settleKey(t.deps(), t.orgId, key.keyId);
    t.clock.now += 1000;
    t.spend(key, 3);
    await settleKey(t.deps(), t.orgId, key.keyId);
    const lines = t.ledger();
    expect(lines.map((line) => line.sk)).toEqual([
      ledgerKey(t.orgId, MONTH, new Date(T0).toISOString(), key.keyId, 1).sk,
      ledgerKey(t.orgId, MONTH, new Date(T0 + 1000).toISOString(), key.keyId, 2).sk,
    ]);
    for (const line of lines) expect(String(line.pk)).toBe(`ORG#${t.orgId}#LEDGER#${MONTH}`);
    expect(setup({ orgId: OTHER_ORG }).ledger()).toEqual([]);
  });
});

describe("forgetKey", () => {
  it("takes back a key nothing was counted for, with its index item", async () => {
    const t = setup();
    const key = t.input();
    await registerKey(t.deps(), key);
    expect(await forgetKey(t.deps(), t.orgId, key.keyId)).toBe(true);
    expect(t.record(key.keyId)).toBeUndefined();
    expect(t.db.find((item) => item.pk === "OPEN_MODEL_KEYS")).toEqual([]);
  });

  it("keeps a key that reserved or was settled, for the sweep to finalize", async () => {
    const t = setup();
    const reserved = t.input({ scopes: [{ key: WEB, limitUsd: 20 }] });
    await reserve(t.deps(), reserved);
    expect(await forgetKey(t.deps(), t.orgId, reserved.keyId)).toBe(false);
    const settled = t.input({ scopes: [{ key: ORG }] });
    await registerKey(t.deps(), settled);
    t.spend(settled, 0.5);
    await settleKey(t.deps(), t.orgId, settled.keyId);
    expect(await forgetKey(t.deps(), t.orgId, settled.keyId)).toBe(false);
    expect(t.record(settled.keyId)).toBeDefined();
  });
});

describe("the scheduled settlement run", () => {
  it("runs every job, in order, and reports a job that failed without stopping the rest", async () => {
    const order: string[] = [];
    const log = vi.fn();
    const reports = await runSettlementJobs([
      { name: "one", run: async () => { order.push("one"); return { done: 1 }; } },
      { name: "two", run: async () => { order.push("two"); throw Object.assign(new Error("secret detail"), { name: "BoomError" }); } },
      { name: "three", run: async () => { order.push("three"); return null; } },
    ], log);
    expect(order).toEqual(["one", "two", "three"]);
    expect(reports).toEqual([{ name: "one", ok: true, result: { done: 1 } }, { name: "two", ok: false, error: "BoomError" }, { name: "three", ok: true, result: null }]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret detail");
  });

  it("resumes a sweep that ran out of time from where it stopped, and clears its place at the end", async () => {
    const t = setup({ pageSize: 2 });
    for (let index = 0; index < 5; index += 1) {
      t.clock.now = T0 + index * 1000;
      const key = t.input({ scopes: [{ key: ORG }] });
      await registerKey(t.deps(), key);
      t.spend(key, 1);
    }
    t.clock.now = T0 + 10_000;
    const first = await runSpendSweep(t.deps(), { budgetMs: 0 });
    expect(first).toMatchObject({ pages: 1, settled: 2, complete: false });
    expect(t.db.get({ pk: "SPEND_SWEEP", sk: "CURSOR" })).toBeDefined();
    const second = await runSpendSweep(t.deps(), { budgetMs: 0 });
    expect(second).toMatchObject({ pages: 1, settled: 2, complete: false });
    const third = await runSpendSweep(t.deps(), { budgetMs: 0 });
    expect(third).toMatchObject({ pages: 1, settled: 1, complete: true });
    expect(t.db.get({ pk: "SPEND_SWEEP", sk: "CURSOR" })).toBeUndefined();
    near(t.counter("ORG")?.spentUsd, 5);
    // With time to spare a run goes through every page.
    const again = await runSpendSweep(t.deps(), { budgetMs: 60_000 });
    expect(again).toMatchObject({ pages: 3, settled: 0, complete: true });
  });
});

// ---- the ChatGPT plan's tokens ----

describe("a ChatGPT-plan task's tokens", () => {
  const WORKSPACE = "22222222-2222-4222-8222-222222222222";
  const OPERATION = "11111111-1111-4111-8111-111111111111";
  const usage = { schemaVersion: 1, outcome: "SUCCEEDED", provider: "openai", modelId: "gpt-6.1-sol", cacheRetention: "short", tokens: { input: 1200, output: 300, cacheRead: 400, cacheWrite: 100, total: 2000 }, cacheReadRatio: 0.25, costUsd: 0.0421 };
  const event: StreamRecord = { eventID: "e1", eventName: "INSERT", dynamodb: { NewImage: marshall({
    pk: `OPERATION#${OPERATION}`, sk: "EVENT#000000000001", entityType: "EVENT", workspaceId: WORKSPACE, operationId: OPERATION, type: "usage", timestamp: "2026-10-21T08:10:00.000Z", payload: usage,
  }) } };
  const operation = (extra: Record<string, unknown>) => ({ pk: `WORKSPACE#${WORKSPACE}`, sk: `OPERATION#${OPERATION}`, entityType: "OPERATION", id: OPERATION, workspaceId: WORKSPACE, kind: "task", status: "RUNNING", createdAt: "2026-10-21T08:00:00.000Z", ...extra });
  const workspace = { pk: `WORKSPACE#${WORKSPACE}`, sk: "META", projectName: "payments", ownerKey: "a".repeat(64) };

  function store(items: Array<Record<string, unknown>>, counting = true) {
    const puts: Array<Record<string, unknown>> = [];
    const counted: Array<{ item: Record<string, unknown>; counter: { key: { pk: string; sk: string }; tokens: number } }> = [];
    const index: IndexStore = {
      get: async (key) => items.find((item) => item.pk === key.pk && item.sk === key.sk),
      put: async (item) => { puts.push(item); },
      ...(counting ? { putCounting: async (item, counter) => { counted.push({ item, counter }); } } : {}),
    };
    return { index, puts, counted };
  }

  it("are added to the person's counter for the month, in the same write as the usage row", async () => {
    const s = store([workspace, operation({ chatgptDeveloperId: MAYA })]);
    expect(await indexActivity([event], s.index, vi.fn(), undefined, TEST_ORG)).toEqual({ failures: 0, usage: 1, failed: 0 });
    expect(s.puts).toEqual([]);
    expect(s.counted).toHaveLength(1);
    expect(s.counted[0]!.item).toMatchObject({ entityType: "USAGE_INDEX", operationId: OPERATION });
    // Input, cache reads and writes, and output, as the usage row counts them.
    expect(s.counted[0]!.counter).toEqual({ key: spendCounterKey(TEST_ORG, "2026-10", personalCounter(MAYA)), tokens: 1200 + 400 + 100 + 300 });
  });

  it("are not counted for a task on the company's models, or one that fell back to them", async () => {
    const plain = store([workspace, operation({})]);
    await indexActivity([event], plain.index, vi.fn(), undefined, TEST_ORG);
    expect(plain.counted).toEqual([]);
    expect(plain.puts).toHaveLength(1);
    const fell = store([workspace, operation({ chatgptDeveloperId: MAYA, chatgptFallback: "limit" })]);
    await indexActivity([event], fell.index, vi.fn(), undefined, TEST_ORG);
    expect(fell.counted).toEqual([]);
    expect(fell.puts).toHaveLength(1);
  });

  it("are not counted for a usage record that carries no timestamp, whose row key could change on a replay", async () => {
    const s = store([workspace, operation({ chatgptDeveloperId: MAYA })]);
    const bare: StreamRecord = { eventID: "e2", eventName: "INSERT", dynamodb: { NewImage: marshall({
      pk: `OPERATION#${OPERATION}`, sk: "EVENT#000000000002", entityType: "EVENT", workspaceId: WORKSPACE, operationId: OPERATION, type: "usage", payload: usage,
    }) } };
    expect(await indexActivity([bare], s.index, vi.fn(), undefined, TEST_ORG)).toEqual({ failures: 0, usage: 1, failed: 0 });
    expect(s.counted).toEqual([]);
    expect(s.puts).toHaveLength(1);
  });

  it("leave the usage row written as before for a store that cannot count", async () => {
    const s = store([workspace, operation({ chatgptDeveloperId: MAYA })], false);
    expect(await indexActivity([event], s.index, vi.fn(), undefined, TEST_ORG)).toEqual({ failures: 0, usage: 1, failed: 0 });
    expect(s.puts).toHaveLength(1);
  });

  it("are counted once when the stream delivers the record again", async () => {
    const db = new FakeDynamoDb();
    const item = { pk: "ORG#x#USAGE#2026-10-21", sk: "2026-10-21T08:10:00.000Z#op", entityType: "USAGE_INDEX" };
    const counter = { key: spendCounterKey(TEST_ORG, "2026-10", personalCounter(MAYA)), tokens: 2000 };
    await putCountedUsage(db, "state", item, counter);
    await putCountedUsage(db, "state", item, counter);
    expect(db.get(counter.key)).toMatchObject({ tokens: 2000 });
    await putCountedUsage(db, "state", { ...item, sk: "2026-10-21T09:00:00.000Z#other" }, { ...counter, tokens: 500 });
    expect(db.get(counter.key)).toMatchObject({ tokens: 2500 });
    // A failure that is not a replay is the caller's.
    db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" } });
    await expect(putCountedUsage(db, "state", { ...item, sk: "x" }, counter)).rejects.toMatchObject({ name: "InternalServerError" });
  });
});

// ---- the broker: keys recorded at the mint, blocked at the end of the operation, settled on the schedule ----

const PROXY_URL = "http://internal-proxy.example.test:4000";
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const NOW_MONTH = new Date().toISOString().slice(0, 7);

async function brokerSetup(options: { agents?: boolean } = {}) {
  const access = fakeModelAccess();
  const h = await createDeveloperTaskBroker({ brokerExtra: { ...(options.agents === false ? {} : { agents: {} }), modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true } });
  access.setMemberSpent(TEST_ORG, DEV_MAYA.developerId, 0);
  access.setOrgSpent(TEST_ORG, 0);
  const startTask = async () => {
    const reply = await h.dev(DEV_MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const taskId = (reply.body.task as { taskId: string }).taskId;
    return { taskId, workspaceId: (h.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string }).workspaceId };
  };
  const active = (workspaceId: string) => String((h.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  /** Finishes preparation, then asks for a key as the task's worker does. */
  const mint = async (workspaceId: string) => {
    await h.finish(workspaceId, active(workspaceId), "SUCCEEDED", PREPARED);
    const operationId = active(workspaceId);
    const outbox = h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!;
    const capability = (outbox.invocation as { callbackCapability: string }).callbackCapability;
    const ask = () => call(h.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": capability } });
    const reply = await ask();
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return { operationId, key: reply.body.apiKey as string, ask };
  };
  const record = (key: string) => h.db.get(modelKeyKey(TEST_ORG, keyIdOf(key))) as (ModelKeyRecord & Record<string, unknown>) | undefined;
  const keyRecords = () => h.db.find((item) => item.entityType === "MODEL_KEY");
  const counter = (sk: string) => h.db.get(spendCounterKey(TEST_ORG, NOW_MONTH, sk)) as { spentUsd?: number; committedUsd?: number } | undefined;
  const sweep = () => h.handler({ source: "agentx.spend-settlement" });
  return { ...h, access, startTask, mint, active, record, keyRecords, counter, sweep };
}

describe("a key the broker mints", () => {
  it("is recorded with who pays, what ran and the budgets it counts against", async () => {
    const t = await brokerSetup();
    const { taskId, workspaceId } = await t.startTask();
    const { key, operationId } = await t.mint(workspaceId);
    const stored = t.record(key)!;
    const input = t.access.mintKey.mock.calls.at(-1)![0];
    expect(stored).toMatchObject({ orgId: TEST_ORG, keyId: keyIdOf(key), month: NOW_MONTH, capUsd: input.maxBudgetUsd, settledUsd: 0, reserved: true, finalized: false, expiresAt: Date.parse("2026-10-19T13:00:00.000Z") });
    expect(stored.tags).toEqual(input.tags);
    expect(stored.tags).toMatchObject({ taskId, operationId, payerKind: "member", payerId: DEV_MAYA.developerId, project: "payments" });
    const task = t.db.get(`DEVTASK#${taskId}`, "META") as Parameters<typeof paymentOfTask>[0];
    expect(stored.scopes).toEqual(paymentOfTask(task).scopes);
    expect(t.db.find((item) => item.pk === "OPEN_MODEL_KEYS").map((item) => item.keyId)).toEqual([keyIdOf(key)]);
  });

  it("is not recorded on an install without agents", async () => {
    const t = await brokerSetup({ agents: false });
    const { workspaceId } = await t.startTask();
    await t.mint(workspaceId);
    expect(t.keyRecords()).toEqual([]);
    expect(t.db.find((item) => item.pk === "OPEN_MODEL_KEYS")).toEqual([]);
  });

  it("is given back, and nothing is minted for the task, when the broker cannot record it", async () => {
    const t = await brokerSetup();
    const { taskId, workspaceId } = await t.startTask();
    await t.finish(workspaceId, t.active(workspaceId), "SUCCEEDED", PREPARED);
    const operationId = t.active(workspaceId);
    const capability = ((t.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!.invocation) as { callbackCapability: string }).callbackCapability;
    t.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("MODEL_KEY"), error: { name: "InternalServerError" } });
    const reply = await call(t.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": capability } });
    expect(reply).toMatchObject({ status: 503, body: { error: { code: "MODEL_PROXY_UNAVAILABLE" } } });
    expect(t.access.revokeKey).toHaveBeenCalledWith(t.access.mintedKeys()[0]);
    expect((t.db.get(`DEVTASK#${taskId}`, "META") as { modelKeyIds?: string[] }).modelKeyIds).toBeUndefined();
  });

  it("leaves no record for the sweep to retry when it is recorded but the answer is lost, and the key is given back", async () => {
    const t = await brokerSetup();
    await t.startTask().then(async ({ workspaceId }) => {
      await t.finish(workspaceId, t.active(workspaceId), "SUCCEEDED", PREPARED);
      const operationId = t.active(workspaceId);
      const capability = ((t.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!.invocation) as { callbackCapability: string }).callbackCapability;
      // The write commits, then the answer is lost.
      const send = t.db.send;
      let lost = false;
      t.db.send = async (command) => {
        const answer = await send(command);
        if (!lost && command.constructor.name === "TransactWriteCommand" && JSON.stringify((command as { input: unknown }).input).includes("MODEL_KEY")) { lost = true; throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); }
        return answer;
      };
      const reply = await call(t.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": capability } });
      expect(reply.status).toBe(503);
      expect(lost).toBe(true);
    });
    expect(t.access.revokeKey).toHaveBeenCalledWith(t.access.mintedKeys()[0]);
    expect(t.keyRecords()).toEqual([]);
    expect(t.db.find((item) => item.pk === "OPEN_MODEL_KEYS")).toEqual([]);
  });

  it("is blocked at the proxy once, and starts its finalize clock, when its operation ends", async () => {
    const t = await brokerSetup();
    const { workspaceId } = await t.startTask();
    const { key, operationId } = await t.mint(workspaceId);
    expect(t.access.blockKey).not.toHaveBeenCalled();
    await t.finish(workspaceId, operationId, "FAILED", { error: "boom" });
    expect(t.access.blockKey.mock.calls).toEqual([[keyIdOf(key)]]);
    const started = t.record(key)!.finalizeAfter;
    expect(started).toBeGreaterThan(Date.now() + FINALIZE_DELAY_MS - 10_000);
    // The same end reported again blocks nothing more.
    await t.finish(workspaceId, operationId, "FAILED", { error: "boom" });
    expect(t.access.blockKey).toHaveBeenCalledTimes(1);
    expect(t.record(key)!.finalizeAfter).toBe(started);
  });

  it("does not fail the worker's result when the proxy cannot block it; the repeat of the result tries again", async () => {
    const t = await brokerSetup();
    const { workspaceId } = await t.startTask();
    const { key, operationId } = await t.mint(workspaceId);
    t.access.blockKey.mockRejectedValueOnce(Object.assign(new Error("down"), { code: "MODEL_PROXY_UNAVAILABLE" }));
    await t.finish(workspaceId, operationId, "SUCCEEDED", {});
    expect(t.record(key)!.finalizeAfter).toBeUndefined();
    await t.finish(workspaceId, operationId, "SUCCEEDED", {});
    expect(t.record(key)!.finalizeAfter).toBeDefined();
  });

  it("is settled by the scheduled run, finalized once its clock runs out, and leaves nothing to write after", async () => {
    const t = await brokerSetup();
    const { workspaceId } = await t.startTask();
    const { key, operationId } = await t.mint(workspaceId);
    // The fake proxy's keys expire in the past; this one is alive for the next hour.
    t.db.set({ ...t.record(key)!, expiresAt: Date.now() + 3_600_000 });
    t.access.setKeySpent(key, 1.2);
    const run = await t.sweep();
    expect(run.statusCode).toBe(200);
    // The run's jobs, in order (Task 11's drain, Task 21's approvals, Task 32's escalation, Task 24b's source sweep, the spend sweep, Task 26's key audit): none has anything to do with this one.
    expect((JSON.parse(run.body) as { jobs: unknown }).jobs).toEqual([
      expect.objectContaining({ name: "drain-member-merges", ok: true }),
      expect.objectContaining({ name: "expire-approvals", ok: true }),
      expect.objectContaining({ name: "escalate-owner-requests", ok: true }),
      expect.objectContaining({ name: "sweep-model-sources", ok: true }),
      expect.objectContaining({ name: "sweep-spend", ok: true, result: expect.objectContaining({ settled: 1, complete: true }) as unknown }),
      expect.objectContaining({ name: "audit-model-keys", ok: true }),
      // v1.2 learning loop: after every settlement job.
      expect.objectContaining({ name: "resume-learning-walks", ok: true }),
    ]);
    for (const sk of ["ORG", "PROJECT#payments", `MEMBER#${DEV_MAYA.developerId}`, "SOURCE#rovara", agentUsageCounter("rovara-code")]) near(t.counter(sk)?.spentUsd, 1.2);
    await t.finish(workspaceId, operationId, "SUCCEEDED", {});
    t.access.setKeySpent(key, 1.5);
    // Its clock has not run out: settled, not finalized.
    await t.sweep();
    near(t.counter("ORG")?.spentUsd, 1.5);
    expect(t.record(key)!.finalized).toBe(false);
    t.db.set({ ...t.record(key)!, finalizeAfter: Date.now() - 1 });
    await t.sweep();
    expect(t.record(key)).toMatchObject({ finalized: true, settledUsd: 1.5 });
    const writes: string[] = [];
    const stop = t.db.onWrite(({ before, after }) => writes.push(String((after ?? before)?.pk)));
    await t.sweep();
    stop();
    expect(writes).toEqual([]);
  });

  it("runs the key audit last, with a time budget, and says when it stopped short (Task 26 review I2)", async () => {
    // Every third tick the learning job takes the audit's share (`learningFirstTick`): pin a tick, and the one after it, where the audit runs.
    pinSettlementTick(false);
    const t = await brokerSetup();
    t.access.auditKeys.mockResolvedValueOnce({ checked: 7, blocked: 1, truncated: true });
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const run = await t.sweep();
      expect(t.access.auditKeys).toHaveBeenCalledWith({ budgetMs: 4_000 });
      const jobs = (JSON.parse(run.body) as { jobs: Array<{ name: string; ok: boolean; result?: unknown }> }).jobs;
      expect(jobs.map((job) => job.name)).toEqual(["drain-member-merges", "expire-approvals", "escalate-owner-requests", "sweep-model-sources", "sweep-spend", "audit-model-keys", "resume-learning-walks"]);
      expect(jobs.at(-2)).toMatchObject({ ok: true, result: { checked: 7, blocked: 1, truncated: true } });
      expect(logged.mock.calls.map((call) => String(call[0])).some((line) => line.includes("model_keys.audit_truncated"))).toBe(true);
      // An audit that fails does not stop the sweeps that ran before it, and is reported by its error's name alone.
      t.access.auditKeys.mockRejectedValueOnce(Object.assign(new Error("secret detail"), { name: "BlockFailed" }));
      const failed = await t.sweep();
      expect(JSON.parse(failed.body)).toMatchObject({ jobs: [{ ok: true }, { ok: true }, { ok: true }, { ok: true }, { name: "sweep-spend", ok: true }, { name: "audit-model-keys", ok: false, error: "BlockFailed" }, { name: "resume-learning-walks", ok: true }] });
      expect(failed.body).not.toContain("secret detail");
      // What an audit that threw had done is logged: the counts travel in its error's words.
      t.access.auditKeys.mockRejectedValueOnce(Object.assign(new Error("MODEL_PROXY_UNAVAILABLE: the audit could not block 1 of 3 drifted keys (checked 9, blocked 2)"), { name: "AgentXError" }));
      await t.sweep();
      expect(logged.mock.calls.map((call) => String(call[0])).some((line) => line.includes("model_keys.audit_failed") && line.includes("checked 9, blocked 2"))).toBe(true);
    } finally { logged.mockRestore(); vi.useRealTimers(); }
  });

  it("skips the key audit on a learning-first tick: the learning job takes its share, and the audit is reported as skipped", async () => {
    pinSettlementTick(true);
    try {
      const t = await brokerSetup();
      const run = await t.sweep();
      const jobs = (JSON.parse(run.body) as { jobs: Array<{ name: string; ok: boolean; result?: unknown }> }).jobs;
      expect(t.access.auditKeys).not.toHaveBeenCalled();
      expect(jobs.at(-2)).toMatchObject({ name: "audit-model-keys", ok: true, result: { skipped: "no time left in this run" } });
      expect(jobs.at(-1)).toMatchObject({ name: "resume-learning-walks", ok: true });
      expect(jobs.at(-1)?.result).not.toMatchObject({ skipped: expect.anything() as unknown });
    } finally { vi.useRealTimers(); }
  });

  it("is left alone by the scheduled run on an install without agents or a model proxy", async () => {
    const t = await brokerSetup({ agents: false });
    const run = await t.sweep();
    expect(run.statusCode).toBe(200);
    // Only the learning walk-resume job runs there (it needs neither agents nor a proxy); the spend jobs are not run.
    expect((JSON.parse(run.body) as { jobs: Array<{ name: string }> }).jobs.map((job) => job.name)).toEqual(["resume-learning-walks"]);
    const bare = createBroker({ extra: {} });
    expect((JSON.parse((await bare.handler({ source: "agentx.spend-settlement" })).body) as { jobs: Array<{ name: string }> }).jobs.map((job) => job.name)).toEqual(["resume-learning-walks"]);
  });

  it("reports a job that cannot run at all by its error's name, without its detail", async () => {
    const t = await brokerSetup();
    t.db.injectFault({ command: "GetCommand", match: (input) => JSON.stringify(input).includes("SPEND_SWEEP"), error: { name: "InternalServerError", message: "secret detail" } });
    const run = await t.sweep();
    expect(run.statusCode).toBe(200);
    // The sweep failing never stops the jobs before or after it, and they never hide the sweep's failure.
    expect((JSON.parse(run.body) as { jobs: unknown }).jobs).toEqual([
      expect.objectContaining({ name: "drain-member-merges", ok: true }),
      expect.objectContaining({ name: "expire-approvals", ok: true }),
      expect.objectContaining({ name: "escalate-owner-requests", ok: true }),
      expect.objectContaining({ name: "sweep-model-sources", ok: true }),
      { name: "sweep-spend", ok: false, error: "InternalServerError" },
      expect.objectContaining({ name: "audit-model-keys", ok: true }),
      // v1.2 learning loop: after every settlement job.
      expect.objectContaining({ name: "resume-learning-walks", ok: true }),
    ]);
    expect(run.body).not.toContain("secret detail");
  });
});

describe("a Slack turn's key", () => {
  const SLACK_USER = "U0123456789";
  const THREAD = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;

  async function install() {
    const access = fakeModelAccess();
    const { handler, db } = createBroker({ extra: { agents: {}, modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true } });
    await registerSlackProject(handler);
    access.setOrgSpent(TEST_ORG, 0);
    return { handler, db, access };
  }

  it("is recorded without a reservation, settles into the counters, and expires into a finalize", async () => {
    const h = await install();
    const linked = developerIdForSlackUser(SLACK_USER);
    seedMembership(h.db, linked, { orgId: TEST_ORG, role: "member" });
    h.access.setMemberSpent(TEST_ORG, linked, 0);
    const reply = await serviceCall(h.handler, THREAD, SLACK_USER, "POST", "/v1/service/model-access", { turnId: "Ev1" });
    expect(reply.status).toBe(200);
    const key = reply.body.apiKey as string;
    const stored = h.db.get(modelKeyKey(TEST_ORG, keyIdOf(key))) as ModelKeyRecord & Record<string, unknown>;
    expect(stored).toMatchObject({ reserved: false, finalized: false, capUsd: 2 });
    expect(stored.scopes).toEqual([{ kind: "org" }, { kind: "project", project: "payments" }, { kind: "member", developerId: linked }]);
    expect(stored.tags).toMatchObject({ origin: "slack", payerKind: "member", payerId: linked, project: "payments" });
    expect(stored.tags.operationId).toBeUndefined();
    h.access.setKeySpent(key, 0.4);
    const deps: LedgerDependencies = { documentClient: h.db, tableName: "state", access: h.access, now: Date.now, cloud: true };
    expect(await settleKey(deps, TEST_ORG, keyIdOf(key))).toMatchObject({ deltaUsd: 0.4 });
    const counter = (sk: string) => h.db.get(spendCounterKey(TEST_ORG, NOW_MONTH, sk)) as { spentUsd: number; committedUsd: number };
    near(counter(`MEMBER#${linked}`).spentUsd, 0.4);
    near(counter("PROJECT#payments").committedUsd, 0.4);
  });

  it("leaves no record for the sweep to retry when it is recorded but the answer is lost", async () => {
    const h = await install();
    const send = h.db.send;
    let lost = false;
    h.db.send = async (command) => {
      const answer = await send(command);
      if (!lost && command.constructor.name === "TransactWriteCommand" && JSON.stringify((command as { input: unknown }).input).includes("MODEL_KEY")) { lost = true; throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); }
      return answer;
    };
    const reply = await serviceCall(h.handler, THREAD, SLACK_USER, "POST", "/v1/service/model-access", { turnId: "Ev3" });
    expect(reply.status).toBe(503);
    expect(lost).toBe(true);
    expect(h.access.revokeKey).toHaveBeenCalledWith(h.access.mintedKeys()[0]);
    expect(h.db.find((item) => item.entityType === "MODEL_KEY")).toEqual([]);
    expect(h.db.find((item) => item.pk === "OPEN_MODEL_KEYS")).toEqual([]);
  });

  it("is given back when it cannot be recorded", async () => {
    const h = await install();
    h.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("MODEL_KEY"), error: { name: "InternalServerError" } });
    const reply = await serviceCall(h.handler, THREAD, SLACK_USER, "POST", "/v1/service/model-access", { turnId: "Ev2" });
    expect(reply).toMatchObject({ status: 503, body: { error: { code: "MODEL_PROXY_UNAVAILABLE" } } });
    expect(h.access.revokeKey).toHaveBeenCalledWith(h.access.mintedKeys()[0]);
  });
});

// ---- the routes ----

describe("the spend routes", () => {
  const OTHER = singleOrgIdForEnv("another-company");

  /** Settled spend for the broker's own org, in October 2026: a person's run, a draft's test run, a scheduled run, and a project Maya has no role in. */
  async function seeded() {
    const t = await brokerSetup();
    seedMembership(t.db, DEV_OMAR.developerId, { orgId: TEST_ORG, role: "admin" });
    // Maya may start tasks on payments; she holds no role on "secret".
    t.db.set({ ...projectMemberKey(TEST_ORG, DEV_MAYA.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: DEV_MAYA.developerId, projectName: "payments", role: "developer", projectRole: "contributor" });
    t.db.set({ ...projectRevisionKey(TEST_ORG, "secret", 1), entityType: "PROJECT_REVISION", name: "secret" });
    const access = fakeModelAccess();
    const clock = { now: Date.parse("2026-10-21T12:00:00.000Z") };
    const deps: LedgerDependencies = { documentClient: t.db, tableName: "state", access, now: () => clock.now, cloud: true };
    const RUN_AGENT = "rovara-code" as never;
    let count = 0;
    const settle = async (extra: { scopes: BudgetScope[]; tags: ReturnType<typeof mintTagsFor>; usd: number; model?: string }) => {
      count += 1;
      const secret = `sk-route-key-${String(count)}`;
      const keyId = keyIdOf(secret);
      clock.now += 60_000;
      await registerKey(deps, { orgId: TEST_ORG, month: "2026-10", keyId, capUsd: 5, scopes: extra.scopes.map((key) => ({ key })), tags: extra.tags, model: extra.model ?? MODEL, expiresAt: clock.now + 3_600_000 });
      access.setKeySpent(secret, extra.usd);
      await settleKey(deps, TEST_ORG, keyId);
    };
    const maya = DEV_MAYA.developerId;
    await settle({ scopes: [{ kind: "org" }, { kind: "project", project: "payments" }, { kind: "member", developerId: maya }], usd: 1.2,
      tags: mintTagsFor({ payer: { kind: "member", developerId: maya }, place: { project: "payments" }, agentId: RUN_AGENT, origin: "app", taskId: "task-a", operationId: "op-a" }) });
    await settle({ scopes: [{ kind: "org" }, { kind: "project", project: "payments" }, { kind: "testing", developerId: maya }], usd: 0.3,
      tags: mintTagsFor({ payer: { kind: "project", project: "payments" }, place: { project: "payments" }, agentId: RUN_AGENT, origin: "test_run", taskId: "task-b", operationId: "op-b" }) });
    await settle({ scopes: [{ kind: "org" }, { kind: "project", project: "payments" }, { kind: "agent", agentId: RUN_AGENT }], usd: 0.5, model: "claude-haiku-4-5",
      tags: mintTagsFor({ payer: { kind: "agent", agentId: RUN_AGENT }, place: { project: "payments" }, agentId: RUN_AGENT, origin: "schedule", operationId: "op-c" }) });
    await settle({ scopes: [{ kind: "org" }, { kind: "project", project: "secret" }, { kind: "member", developerId: DEV_OMAR.developerId }], usd: 0.7,
      tags: mintTagsFor({ payer: { kind: "member", developerId: DEV_OMAR.developerId }, place: { project: "secret" }, agentId: RUN_AGENT, origin: "app", taskId: "task-d", operationId: "op-d" }) });
    return { ...t, settle, deps };
  }
  const get = (t: Awaited<ReturnType<typeof seeded>>, who: typeof DEV_MAYA, path: string) => t.dev(who, "GET", path);

  it("shows a member their own figures, the org's, the testing allowance, the plan's tokens and their alerts only", async () => {
    const t = await seeded();
    t.db.set({ ...spendCounterKey(TEST_ORG, "2026-10", personalCounter(DEV_MAYA.developerId)), entityType: "SPEND_COUNTER", tokens: 5000 });
    t.db.set({ ...budgetAlertKey(TEST_ORG, "2026-10", `MEMBER#${DEV_MAYA.developerId}`, "80"), entityType: "BUDGET_ALERT", scope: `MEMBER#${DEV_MAYA.developerId}`, level: "80", spentUsd: 24, limitUsd: 29, at: "2026-10-21T12:00:00.000Z" });
    t.db.set({ ...budgetAlertKey(TEST_ORG, "2026-10", `MEMBER#${DEV_OMAR.developerId}`, "80"), entityType: "BUDGET_ALERT", scope: `MEMBER#${DEV_OMAR.developerId}`, level: "80", spentUsd: 24, limitUsd: 29, at: "2026-10-21T12:00:00.000Z" });
    const reply = await get(t, DEV_MAYA, "/v1/app/budget?month=2026-10");
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body).toMatchObject({
      month: "2026-10",
      member: { spentUsd: 1.2, limitUsd: 29 },
      org: { spentUsd: 2.7, limitUsd: 500 },
      testing: { spentUsd: 0.3, limitUsd: 10 },
      personalPlan: { tokens: 5000 },
    });
    expect(reply.body.alerts).toEqual([{ scope: `MEMBER#${DEV_MAYA.developerId}`, level: "80", spentUsd: 24, limitUsd: 29, at: "2026-10-21T12:00:00.000Z" }]);
  });

  it("shows zeros for a person with no spend, and the current month without ?month", async () => {
    const t = await seeded();
    const reply = await get(t, DEV_OMAR, "/v1/app/budget?month=2026-09");
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ month: "2026-09", member: { spentUsd: 0, committedUsd: 0, limitUsd: 29 }, org: { spentUsd: 0 }, testing: { spentUsd: 0, limitUsd: 10 }, personalPlan: { tokens: 0 }, alerts: [] });
    expect((await get(t, DEV_OMAR, "/v1/app/budget")).body).toMatchObject({ month: NOW_MONTH });
  });

  it("refuses a month that is not YYYY-MM", async () => {
    const t = await seeded();
    for (const month of ["2026-13", "26-10", "2026-10-01", "last", ""]) {
      const reply = await get(t, DEV_MAYA, `/v1/app/budget?month=${month}`);
      expect(reply.status, month).toBe(400);
    }
  });

  it("gives an owner or admin the org's spend by project, member, agent, source and model", async () => {
    const t = await seeded();
    const reply = await get(t, DEV_OMAR, "/v1/app/org/spend?month=2026-10");
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body).toMatchObject({ month: "2026-10", totalUsd: 2.7, limitUsd: 500 });
    expect(reply.body.byProject).toEqual([{ project: "payments", spentUsd: 2, committedUsd: 2 }, { project: "secret", spentUsd: 0.7, committedUsd: 0.7 }]);
    expect(reply.body.byMember).toEqual([{ developerId: DEV_MAYA.developerId, spentUsd: 1.2 }, { developerId: DEV_OMAR.developerId, spentUsd: 0.7 }]);
    expect(reply.body.byAgent).toEqual([{ agentId: "rovara-code", spentUsd: 2.7 }]);
    expect(reply.body.bySource).toEqual([{ source: "rovara", spentUsd: 2.7 }]);
    expect(reply.body.byModel).toEqual([{ model: MODEL, spentUsd: 2.2 }, { model: "claude-haiku-4-5", spentUsd: 0.5 }]);
  });

  it("refuses the org's spend and ledger to a member", async () => {
    const t = await seeded();
    for (const path of ["/v1/app/org/spend?month=2026-10", "/v1/app/org/spend/ledger?month=2026-10"]) {
      expect((await get(t, DEV_MAYA, path)).status, path).toBe(403);
    }
  });

  it("pages the ledger newest first, with a cursor that cannot reach another org's lines", async () => {
    const t = await seeded();
    for (let index = 0; index < 55; index += 1) {
      await t.settle({ scopes: [{ kind: "org" }], usd: 0.01, tags: mintTagsFor({ payer: { kind: "member", developerId: DEV_MAYA.developerId }, place: { project: "payments" }, agentId: "rovara-code", origin: "app", taskId: `task-${String(index)}`, operationId: `op-${String(index)}` }) });
    }
    const first = await get(t, DEV_OMAR, "/v1/app/org/spend/ledger?month=2026-10");
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const lines = first.body.lines as Array<{ at: string; usd: number; project: string; taskId?: string }>;
    expect(lines).toHaveLength(50);
    expect([...lines].sort((a, b) => b.at.localeCompare(a.at))).toEqual(lines);
    expect(lines[0]).toMatchObject({ project: "payments", payerKind: "member", origin: "app", usd: 0.01 });
    expect(lines[0]).not.toHaveProperty("keyId");
    const cursor = first.body.next as string;
    expect(typeof cursor).toBe("string");
    const second = await get(t, DEV_OMAR, `/v1/app/org/spend/ledger?month=2026-10&cursor=${encodeURIComponent(cursor)}`);
    const rest = second.body.lines as Array<{ at: string }>;
    expect(rest).toHaveLength(9);
    expect(second.body.next).toBeUndefined();
    expect(new Set([...lines, ...rest].map((line) => JSON.stringify(line))).size).toBe(59);
    // A cursor that is not one of ours is refused, not followed.
    expect((await get(t, DEV_OMAR, "/v1/app/org/spend/ledger?month=2026-10&cursor=not-a-cursor")).status).toBe(400);
    for (const sk of ["x", "2026-10-21T12:00:00.000Z", `2026-10-21T12:00:00.000Z#${"a".repeat(64)}`, "ORG#other#LEDGER#2026-10"]) {
      const odd = Buffer.from(JSON.stringify({ sk })).toString("base64url");
      expect((await get(t, DEV_OMAR, `/v1/app/org/spend/ledger?month=2026-10&cursor=${odd}`)).status, sk).toBe(400);
    }
  });

  it("does not show one org's spend or ledger to another org's admin", async () => {
    const t = await seeded();
    const other = await createDeveloperTaskBroker({
      brokerExtra: { agents: {}, modelAccess: { access: fakeModelAccess(), proxyUrl: PROXY_URL }, cloud: true },
      orgResolver: async ({ developerId }) => (developerId === DEV_OMAR.developerId ? OTHER : TEST_ORG),
    });
    seedMembership(other.db, DEV_OMAR.developerId, { orgId: OTHER, role: "admin" });
    // The same table content as the first org's, read as the other org's admin: only the other org's own partition is read.
    for (const item of t.db.find((candidate) => String(candidate.pk).startsWith(`ORG#${TEST_ORG}#`))) other.db.set(item);
    const spend = await other.dev(DEV_OMAR, "GET", "/v1/app/org/spend?month=2026-10");
    expect(spend.status, JSON.stringify(spend.body)).toBe(200);
    expect(spend.body).toMatchObject({ totalUsd: 0, byProject: [], byMember: [] });
    const ledger = await other.dev(DEV_OMAR, "GET", "/v1/app/org/spend/ledger?month=2026-10");
    expect(ledger.body).toMatchObject({ month: "2026-10", lines: [] });
    expect(ledger.body).not.toHaveProperty("next");
    // Nor can a cursor taken from the first org's ledger reach into its partition.
    const mine = await t.dev(DEV_OMAR, "GET", "/v1/app/org/spend/ledger?month=2026-10");
    const sk = (mine.body.lines as Array<{ at: string }>)[0]!.at;
    const forged = Buffer.from(JSON.stringify({ sk: `${new Date(sk).toISOString()}#${"a".repeat(64)}#000001` })).toString("base64url");
    const crossed = await other.dev(DEV_OMAR, "GET", `/v1/app/org/spend/ledger?month=2026-10&cursor=${forged}`);
    expect(crossed.body.lines).toEqual([]);
  });

  it("shows a project's spend to a maintainer or an org admin, not to a contributor, and says nothing of a project the caller has no role in", async () => {
    const t = await seeded();
    const admin = await get(t, DEV_OMAR, "/v1/app/projects/payments/spend?month=2026-10");
    expect(admin.status, JSON.stringify(admin.body)).toBe(200);
    expect(admin.body).toMatchObject({ month: "2026-10", project: "payments", spentUsd: 2, committedUsd: 2 });
    expect((await get(t, DEV_MAYA, "/v1/app/projects/payments/spend?month=2026-10")).status).toBe(403);
    const hidden = await get(t, DEV_MAYA, "/v1/app/projects/secret/spend?month=2026-10");
    const missing = await get(t, DEV_MAYA, "/v1/app/projects/no-such-project/spend?month=2026-10");
    expect(hidden.status).toBe(404);
    expect(hidden.body.error).toMatchObject({ code: "PROJECT_NOT_FOUND" });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatchObject({ code: "PROJECT_NOT_FOUND" });
    t.db.set({ pk: `ORG#${TEST_ORG}#PROJECT_AI#payments`, sk: "SETTINGS", entityType: "PROJECT_AI", projectPays: false, monthlyBudgetUsd: 10, revision: 1 });
    expect((await get(t, DEV_OMAR, "/v1/app/projects/payments/spend?month=2026-10")).body).toMatchObject({ limitUsd: 10 });
  });

  it("splits an agent's spend by where the run came from, lists its recent runs, and shows its budget", async () => {
    const t = await seeded();
    t.db.set({ ...builtinSettingsKey(TEST_ORG, "rovara-code"), entityType: "BUILTIN_AGENT_SETTINGS", monthlyBudgetUsd: 20, maxPerRunUsd: 3 });
    const reply = await get(t, DEV_OMAR, "/v1/app/agents/rovara-code/spend?month=2026-10");
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body).toMatchObject({ month: "2026-10", totalUsd: 2.7, byOrigin: { person: 1.9, autonomous: 0.5, test: 0.3 }, budget: { limitUsd: 20, spentUsd: 0.5 }, maxPerRunUsd: 3 });
    const runs = reply.body.recentRuns as Array<{ project: string; usd: number; origin: string }>;
    expect(runs.map((run) => [run.project, run.usd, run.origin]).sort()).toEqual([["payments", 0.3, "test_run"], ["payments", 0.5, "schedule"], ["payments", 1.2, "app"], ["secret", 0.7, "app"]].sort());
  });

  it("shows no key id: a Slack turn's run, which has no task or operation, is listed without an identifier", async () => {
    const t = await seeded();
    const turnKey = keyIdOf("sk-a-slack-turn");
    const clock = { now: Date.parse("2026-10-21T13:00:00.000Z") };
    const access = fakeModelAccess();
    const deps: LedgerDependencies = { documentClient: t.db, tableName: "state", access, now: () => clock.now, cloud: true };
    await registerKey(deps, { orgId: TEST_ORG, month: "2026-10", keyId: turnKey, capUsd: 2, scopes: [{ key: { kind: "org" } }], tags: mintTagsFor({ payer: { kind: "project", project: "payments" }, place: { project: "payments" }, agentId: "rovara-code", origin: "slack" }), expiresAt: clock.now + 900_000 });
    access.setKeySpent("sk-a-slack-turn", 0.2);
    await settleKey(deps, TEST_ORG, turnKey);
    const reply = await get(t, DEV_OMAR, "/v1/app/agents/rovara-code/spend?month=2026-10");
    expect(JSON.stringify(reply.body)).not.toContain(turnKey);
    expect((reply.body.recentRuns as Array<{ origin: string; usd: number }>).some((run) => run.origin === "slack" && run.usd === 0.2)).toBe(true);
  });

  it("leaves out the runs of a project the caller has no role in", async () => {
    const t = await seeded();
    const reply = await get(t, DEV_MAYA, "/v1/app/agents/rovara-code/spend?month=2026-10");
    const runs = reply.body.recentRuns as Array<{ project: string; usd: number }>;
    expect(runs.map((run) => run.project)).toEqual(["payments", "payments", "payments"]);
    expect(runs.map((run) => run.usd).sort()).toEqual([0.3, 0.5, 1.2]);
  });

  it("shows at most 20 runs, newest first", async () => {
    const t = await seeded();
    for (let index = 0; index < 25; index += 1) {
      await t.settle({ scopes: [{ kind: "org" }], usd: 0.01, tags: mintTagsFor({ payer: { kind: "member", developerId: DEV_MAYA.developerId }, place: { project: "payments" }, agentId: "rovara-code", origin: "app", taskId: `many-${String(index)}`, operationId: `many-op-${String(index)}` }) });
    }
    const reply = await get(t, DEV_MAYA, "/v1/app/agents/rovara-code/spend?month=2026-10");
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const runs = reply.body.recentRuns as Array<{ project: string; lastAt: string }>;
    expect(runs).toHaveLength(20);
    expect([...runs].sort((a, b) => b.lastAt.localeCompare(a.lastAt))).toEqual(runs);
    // The budget and max-per-run are absent when the agent has none.
    expect(reply.body).not.toHaveProperty("budget");
    expect(reply.body).not.toHaveProperty("maxPerRunUsd");
  });

  it("answers an agent the caller cannot see, or that does not exist, with the same 404", async () => {
    const t = await seeded();
    const unknown = await get(t, DEV_MAYA, "/v1/app/agents/agt_zzzzzzzzzzzzzzzzzzzzzzzz/spend?month=2026-10");
    expect(unknown.status).toBe(404);
    const malformed = await get(t, DEV_MAYA, "/v1/app/agents/not-an-agent/spend?month=2026-10");
    expect(malformed.status).toBe(404);
    expect((malformed.body.error as { message: string }).message).toBe((unknown.body.error as { message: string }).message);
  });
});

// ---- the schedule ----

describe("the spend settlement schedule", () => {
  type Schedule = { Type: string; Properties: { ScheduleExpression: string; State: string; FlexibleTimeWindow: unknown; Target: { Arn: unknown; RoleArn: unknown; Input: string; RetryPolicy: unknown } } };
  const schedules = (context: Record<string, unknown>): Array<[string, Schedule]> => {
    const stack = buildAgentXApp(context).node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane");
    return Object.entries(Template.fromStack(stack!).toJSON().Resources as Record<string, Schedule>).filter(([, resource]) => resource.Type === "AWS::Scheduler::Schedule");
  };

  it("runs every 5 minutes through the same role as the other recovery schedules, with the event the broker answers", () => {
    const found = schedules({ agentxEnv: "staging" });
    const spend = found.filter(([id]) => id.startsWith("SpendSettlementSchedule"));
    expect(spend).toHaveLength(1);
    const [, schedule] = spend[0]!;
    expect(schedule.Properties).toMatchObject({ ScheduleExpression: "rate(5 minutes)", State: "ENABLED", FlexibleTimeWindow: { Mode: "OFF" } });
    expect(JSON.parse(schedule.Properties.Target.Input)).toStrictEqual({ source: "agentx.spend-settlement" });
    expect(schedule.Properties.Target.RetryPolicy).toStrictEqual({ MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 300 });
    const recovery = found.find(([id]) => id.startsWith("GithubWebhookRecoverySchedule"))![1];
    expect(schedule.Properties.Target.Arn).toStrictEqual(recovery.Properties.Target.Arn);
    expect(schedule.Properties.Target.RoleArn).toStrictEqual(recovery.Properties.Target.RoleArn);
  });

  it("is not in the legacy template", () => {
    expect(schedules({}).map(([id]) => id).filter((id) => id.startsWith("SpendSettlement"))).toStrictEqual([]);
  });
});

describe("the scheduled run's time", () => {
  it("gives the short jobs their caps, the spend sweep what is left, and the audit what it needs, all inside one deadline of 27 seconds", async () => {
    const { SETTLEMENT_BUDGETS_MS, SETTLEMENT_TOTAL_LIMIT_MS, settlementBudgets } = await import("../../packages/broker/src/spend/settlement-job.js");
    expect(SETTLEMENT_TOTAL_LIMIT_MS).toBe(27_000);
    // The caps of Tasks 11, 21, 32, 24b and 26.
    expect(SETTLEMENT_BUDGETS_MS).toStrictEqual({ drain: 5_000, approvals: 4_000, escalate: 2_000, sources: 5_000, learning: 3_000, audit: 4_000 });
    expect(settlementBudgets(0)).toStrictEqual({ drain: 5_000, approvals: 4_000, escalate: 2_000, sources: 5_000, learning: 3_000, spend: 23_000, audit: 4_000 });
    // Each later job gets what remains: spend keeps the audit's reserve, and nothing is ever negative or past the deadline.
    expect(settlementBudgets(2_000)).toMatchObject({ spend: 21_000, audit: 4_000 });
    expect(settlementBudgets(12_000)).toMatchObject({ drain: 5_000, spend: 11_000, audit: 4_000 });
    expect(settlementBudgets(24_000)).toStrictEqual({ drain: 3_000, approvals: 3_000, escalate: 2_000, sources: 3_000, learning: 0, spend: 0, audit: 3_000 });
    expect(settlementBudgets(26_500)).toMatchObject({ drain: 500, spend: 0, audit: 500 });
    expect(settlementBudgets(40_000)).toStrictEqual({ drain: 0, approvals: 0, escalate: 0, sources: 0, learning: 0, spend: 0, audit: 0 });
    // Run one after another, each taking all it is given, the jobs end at the deadline and not after it.
    let elapsed = 0;
    for (const name of ["drain", "approvals", "escalate", "sources", "spend", "audit", "learning"] as const) elapsed += settlementBudgets(elapsed)[name];
    expect(elapsed).toBeLessThanOrEqual(SETTLEMENT_TOTAL_LIMIT_MS);
  });

  it("starts a stuck write's re-drive only while more than the connector timeout and a margin remain", async () => {
    const { SETTLEMENT_TOTAL_LIMIT_MS, REDRIVE_MIN_REMAINING_MS, redriveUntil } = await import("../../packages/broker/src/spend/settlement-job.js");
    expect(REDRIVE_MIN_REMAINING_MS).toBe(22_000);
    expect(redriveUntil(1_000)).toBe(1_000 + SETTLEMENT_TOTAL_LIMIT_MS - REDRIVE_MIN_REMAINING_MS);
  });

  it("skips a job that has no time left, and reports that it was skipped, without running it (the 'timed' job)", async () => {
    const { timedSettlementJob } = await import("../../packages/broker/src/spend/settlement-job.js");
    let now = 1_000;
    const ran: number[] = [];
    const job = (pick: "drain" | "spend" | "audit") => timedSettlementJob({ name: pick, pick, startedAt: 1_000, now: () => now, run: async (budgetMs) => { ran.push(budgetMs); return { done: true }; } });
    expect(await job("spend").run()).toEqual({ done: true });
    expect(ran).toEqual([23_000]);
    now = 1_000 + 25_000;
    expect(await job("audit").run()).toEqual({ done: true });
    expect(ran).toEqual([23_000, 2_000]);
    // Nothing is left: spend gets nothing at 23 s, and everything is over at 27 s.
    now = 1_000 + 24_000;
    expect(await job("spend").run()).toEqual({ skipped: "no time left in this run" });
    now = 1_000 + 27_000;
    expect(await job("drain").run()).toEqual({ skipped: "no time left in this run" });
    expect(await job("audit").run()).toEqual({ skipped: "no time left in this run" });
    expect(ran).toEqual([23_000, 2_000]);
  });
});


// Lessons in production (fix round 1): a key can hold its cap on counters that are not budget scopes (the Public company's learning month). They reserve, settle, finalize and abandon exactly as a scope does.
describe("holds beyond the budget scopes", () => {
  const LEARNING = "LEARNING";
  const holdInput = (t: ReturnType<typeof setup>, limitUsd: number | undefined, capUsd = 0.25) =>
    t.input({ scopes: [{ key: ORG }, { key: WEB }], capUsd, holds: [{ counter: LEARNING, ...(limitUsd === undefined ? {} : { limitUsd }) }] });

  it("holds the cap on the hold counter in the same transaction as the scopes, and refuses a key that does not fit its limit without writing anything", async () => {
    const t = setup();
    await reserve(t.deps(), holdInput(t, 0.5));
    near(t.counter(LEARNING)?.committedUsd, 0.25);
    near(t.counter("ORG")?.committedUsd, 0.25);
    const second = holdInput(t, 0.5, 0.3);
    const refused = await reserve(t.deps(), second).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ScopeFullError);
    expect((refused as ScopeFullError).scope).toBe(LEARNING);
    near(t.counter("ORG")?.committedUsd, 0.25);
    near(t.counter(LEARNING)?.committedUsd, 0.25);
    expect(t.record(second.keyId)).toBeUndefined();
    // A hold without a limit never refuses (an Enterprise company has no learning cap of its own).
    await expect(reserve(t.deps(), holdInput(t, undefined, 0.4))).resolves.toBeDefined();
    near(t.counter(LEARNING)?.committedUsd, 0.65);
  });

  it("a repeat of the same key holds nothing more", async () => {
    const t = setup();
    const input = holdInput(t, 1);
    await reserve(t.deps(), input);
    await reserve(t.deps(), input);
    near(t.counter(LEARNING)?.committedUsd, 0.25);
  });

  it("settles spend onto the hold counter and, at finalize, releases only what the key did not spend", async () => {
    const t = setup();
    const input = holdInput(t, 20);
    await reserve(t.deps(), input);
    t.spend(input, 0.04);
    await settleKey(t.deps(), t.orgId, input.keyId);
    near(t.counter(LEARNING)?.spentUsd, 0.04);
    near(t.counter(LEARNING)?.committedUsd, 0.25);
    expect(await finalizeKey(t.deps(), t.orgId, input.keyId)).toBe(true);
    near(t.counter(LEARNING)?.committedUsd, 0.04);
    near(t.counter("ORG")?.committedUsd, 0.04);
  });

  it("spend the proxy reports late (after the call, before the finalize) is still counted, and the cap stays held until then", async () => {
    const t = setup();
    const input = holdInput(t, 20);
    await reserve(t.deps(), input);
    // The call is over but the proxy has not flushed its figure: a settle now sees 0 and the whole cap stays held.
    await settleKey(t.deps(), t.orgId, input.keyId);
    near(t.counter(LEARNING)?.committedUsd, 0.25);
    near(t.counter(LEARNING)?.spentUsd, 0);
    // The proxy flushes; the sweep after the finalize delay settles first and then releases.
    t.spend(input, 0.11);
    t.clock.now += 2 * FINALIZE_DELAY_MS;
    await blockOperationKeys(t.deps(), { orgId: t.orgId, operationId: input.tags.operationId!, keyIds: [input.keyId] }).catch(() => undefined);
    await sweepSpend(t.deps(), t.clock.now + 2 * FINALIZE_DELAY_MS);
    near(t.counter(LEARNING)?.spentUsd, 0.11);
    near(t.counter(LEARNING)?.committedUsd, 0.11);
  });

  it("a key abandoned before it was used gives the whole hold back", async () => {
    const t = setup();
    const input = holdInput(t, 20);
    await reserve(t.deps(), input);
    const { abandonKey } = await import("../../packages/broker/src/spend/ledger.js");
    expect(await abandonKey(t.deps(), t.orgId, input.keyId)).toBe(true);
    near(t.counter(LEARNING)?.committedUsd, 0);
  });

  it("a key nobody blocked is finalized by the sweep after it expired, which releases the hold (a crashed caller never leaks a month's cap)", async () => {
    const t = setup();
    const input = holdInput(t, 20);
    await reserve(t.deps(), input);
    t.clock.now = input.expiresAt + KEY_EXPIRY_GRACE_MS + 1;
    await sweepSpend(t.deps(), t.clock.now);
    near(t.counter(LEARNING)?.committedUsd, 0);
    expect(t.record(input.keyId)?.finalized).toBe(true);
  });
});

describe("the ledger lines of keys that do not belong to a task", () => {
  it("a page boundary falling on a learning line pages on without error (M3)", async () => {
    // Every ledger line is keyed by a 64-hex key id, so the admin view's cursor check accepts it. The cursor is the sort key of the last line of a page.
    const t = setup();
    const input = t.input({ tags: { ...mintTagsFor({ payer: { kind: "project", project: "web" }, place: { project: "web" }, agentId: "learning", origin: "learning", operationId: "learning-op-1" }) } });
    await reserve(t.deps(), input);
    t.spend(input, 0.05);
    await settleKey(t.deps(), t.orgId, input.keyId);
    const line = t.ledger()[0]!;
    expect(String(line.sk)).toMatch(/#[0-9a-f]{64}#\d{6}$/u);
  });
});
