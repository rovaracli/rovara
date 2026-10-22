// Plan 3 Task 30: the spend ledger and its settlement. A key's spend is read from the model proxy and counted once on every counter it belongs to, a
// key is reserved against the limited scopes before it is minted (Task 31 does that), and an ended operation's keys are blocked and finalized in two
// phases so a request the proxy admitted before the block still counts. These tests drive the ledger directly on a fake table and a fake proxy.
import { describe, expect, it } from "vitest";
import {
  FINALIZE_DELAY_MS, KEY_EXPIRY_GRACE_MS, FINALIZED_SETTLE_WINDOW_MS,
  agentRunsKey, budgetAlertKey, ledgerKey, modelKeyKey, openModelKeysKey, orgSettingsKey, spendCounterKey,
  type BudgetScope,
} from "@agentx/contracts";
import {
  ScopeFullError, blockOperationKeys, checkAlerts, finalizeKey, registerKey, reserve, settleKey, sweepSpend,
  type KeyInput, type LedgerDependencies, type ModelKeyRecord,
} from "../../packages/broker/src/spend/ledger.js";
import { agentUsageCounter, mintTagsFor } from "../../packages/broker/src/spend/payer.js";
import { keyIdOf } from "../../packages/broker/src/org/budget.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { fakeModelAccess, type FakeModelAccess } from "../support/fake-model-access.js";
import { TEST_ORG } from "../support/orgs.js";
import { singleOrgIdForEnv } from "../../packages/contracts/src/org.js";

const OTHER_ORG = singleOrgIdForEnv("other-install");
const MAYA = "1".repeat(64);
const AGENT = "agt_aaaaaaaaaaaaaaaaaaaaaaaa" as never;
const MONTH = "2026-10";
const T0 = Date.parse("2026-10-21T12:00:00.000Z");
const MODEL = "claude-sonnet-4-6";

const ORG: BudgetScope = { kind: "org" };
const WEB: BudgetScope = { kind: "project", project: "web" };
const MEMBER: BudgetScope = { kind: "member", developerId: MAYA };

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

  it("refuses a key with more scopes than one transaction can hold", async () => {
    const t = setup();
    const scopes = Array.from({ length: 40 }, (_, index) => ({ key: { kind: "project", project: `p${String(index)}` } as BudgetScope }));
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
    t.clock.now = finalizedAt + FINALIZED_SETTLE_WINDOW_MS + 1;
    t.spend(key, 0.9);
    await sweepSpend(t.deps(), t.clock.now);
    expect(t.db.get(index)).toBeUndefined();
    near(t.counter("ORG")?.spentUsd, 0.4);
  });

  it("pages the open keys by cursor, 500 at a time by default", async () => {
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
    expect(setup({ orgId: OTHER_ORG as never }).ledger()).toEqual([]);
  });
});
