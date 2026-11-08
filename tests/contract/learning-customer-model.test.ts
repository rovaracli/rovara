// Lessons in production, lane 1 (fix round 1): the learning pipeline's model runs on the COMPANY's own provider and the company pays; there is no Rovara-paid route. Its money goes through the product's ordinary key
// lifecycle: the key's cap is RESERVED in the spend ledger (org, project and the Public learning month) before the call, the key is BLOCKED after it, and the sweep settles the proxy's own figure once the proxy
// has flushed it. These tests drive the model on a fake table, a fake proxy that reports spend late, and the real mint, ledger and sweep.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AGENT_GUARDRAILS, FINALIZE_DELAY_MS, KEY_EXPIRY_GRACE_MS, ModelSourceSchema, agentGuardrailsKey, editionPolicy, modelKeyKey, modelCounter, originCounter, scopeKey, sourceAlias, sourceCounter, spendCounterKey,
  type Edition, type ModelIdentifier, type ModelSource,
} from "../../packages/contracts/src/index.js";
import { ModelSourceStore } from "../../packages/broker/src/model-sources/store.js";
import type { RoutingDependencies } from "../../packages/broker/src/model-sources/routing.js";
import { keyIdOf } from "../../packages/broker/src/org/budget.js";
import { sweepSpend } from "../../packages/broker/src/spend/ledger.js";
import { routeSpendRequest } from "../../packages/broker/src/spend/routes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { TEST_ORG } from "../support/orgs.js";
import {
  LEARNING_CALL_BUDGET_USD, LEARNING_MONTH_FULL, LEARNING_NO_BUDGET, LEARNING_NO_PROVIDER, LEARNING_TOO_DEAR, customerLearningModel,
} from "../../packages/broker/src/aws/broker/learning-model.js";
import { LEARNING_COUNTER } from "../../packages/broker/src/aws/broker/learning-spend.js";
import { ledgerOf } from "../../packages/broker/src/aws/broker/sweeps-and-readiness.js";
import type { AwsBrokerDependencies } from "../../packages/broker/src/aws/broker/definitions.js";

const SRC_ANTHROPIC = "src_aaaaaaaaaaaaaaaaaaaa";
const SRC_CHATGPT = "personal-chatgpt";
const SONNET = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
const ALIAS = sourceAlias(TEST_ORG, SRC_ANTHROPIC, SONNET);
const MONTH = new Date().toISOString().slice(0, 7);
const anthropic = (): ModelSource => ModelSourceSchema.parse({ kind: "anthropic", sourceId: SRC_ANTHROPIC, label: "Anthropic", models: [{ catalog: SONNET }] });
const near = (value: number | undefined, expected: number) => expect(value ?? 0).toBeCloseTo(expected, 6);

afterEach(() => { vi.restoreAllMocks(); });

function install(options: { forbidden?: ModelIdentifier[]; edition?: Edition; withOp?: boolean; projectOrder?: string[]; monthlyCapUsd?: number; withAgents?: boolean } = {}) {
  const db = new FakeDynamoDb();
  // The company's forbidden models are read now from its guardrails document.
  if (options.forbidden !== undefined) db.set({ ...agentGuardrailsKey(TEST_ORG), guardrails: { ...DEFAULT_AGENT_GUARDRAILS, forbiddenModels: options.forbidden }, revision: 1 });
  const store = new ModelSourceStore({ documentClient: db, tableName: "state", now: Date.now, chatgptSwitch: async () => true });
  const routing: RoutingDependencies = {
    sources: store, egress: { documentClient: db, tableName: "state" }, launch: { kinds: ["anthropic", "openai", "openrouter", "bedrock", "endpoint"] }, edition: editionPolicy(options.edition ?? "public"),
    forbiddenModels: async () => options.forbidden ?? [],
    ...(options.projectOrder === undefined ? {} : { projectSourceOrder: async () => options.projectOrder }), chatgpt: { serves: async () => "gpt-5.4" },
  };
  const proxy = fakeModelAccess();
  proxy.setOrgSpent(TEST_ORG, 0);
  // A key lives as long as it was asked to (the fake's fixed expiry is in the past).
  const baseMint = proxy.mintKey.getMockImplementation()!;
  proxy.mintKey.mockImplementation(async (mint) => ({ ...(await baseMint(mint)), expiresAt: Date.now() + mint.ttlSeconds * 1000 }));
  const calls: Array<Record<string, unknown>> = [];
  const learningCompletion = vi.fn(async (input: Record<string, unknown>) => { calls.push(input); return { text: "{\"candidates\":[]}", model: String(input.model) }; });
  const access = Object.assign(proxy, options.withOp === false ? {} : { learningCompletion });
  const dependencies = {
    documentClient: db, tableName: "state", cloud: true, ...(options.withAgents === false ? {} : { agents: {} }),
    modelAccess: { access, proxyUrl: "http://proxy" },
  } as unknown as AwsBrokerDependencies;
  const model = customerLearningModel(dependencies, { routing: () => routing, edition: options.edition ?? "public", ...(options.monthlyCapUsd === undefined ? {} : { monthlyCapUsd: options.monthlyCapUsd }), log: () => undefined });
  const request = { purpose: "reflect" as const, system: "sys", user: "usr", maxOutputTokens: 1800, workspaceId: TEST_ORG, project: "web", budgetUsd: 0.15 };
  const counter = (sk: string) => db.get(spendCounterKey(TEST_ORG, MONTH, sk)) as { spentUsd?: number; committedUsd?: number } | undefined;
  const seedCounter = (sk: string, counts: { spentUsd?: number; committedUsd?: number }) => db.set({ ...spendCounterKey(TEST_ORG, MONTH, sk), entityType: "SPEND_COUNTER", ...counts });
  const limitProject = (limitUsd: number) => db.set({ pk: `ORG#${TEST_ORG}#PROJECT_AI#web`, sk: "SETTINGS", entityType: "PROJECT_AI", projectPays: false, monthlyBudgetUsd: limitUsd, revision: 1 });
  const ready = async () => {
    await store.save({ orgId: TEST_ORG, source: anthropic(), mode: "create", by: "dev-owner" });
    await store.setOrder({ orgId: TEST_ORG, order: [SRC_ANTHROPIC], by: "dev-owner" });
  };
  /** The sweep, as it runs `ms` after now. */
  const sweepLater = async (ms: number) => {
    const at = Date.now() + ms;
    return sweepSpend({ ...ledgerOf(dependencies)!, now: () => at }, at);
  };
  const keyIds = () => proxy.mintedKeys().map(keyIdOf);
  const record = (keyId: string) => db.get(modelKeyKey(TEST_ORG, keyId)) as { settledUsd: number; finalized: boolean; finalizeAfter?: number; capUsd: number; reserved: boolean; tags: Record<string, string> } | undefined;
  return { db, store, model, request, calls, learningCompletion, dependencies, proxy, counter, seedCounter, limitProject, ready, sweepLater, keyIds, record };
}

describe("the learning model runs on the company's own provider", () => {
  it("routes to the company's source: its alias and transport go to the function with the broker's key, and the key is for that one alias, tagged with the source, the model and the origin", async () => {
    const t = install();
    await t.ready();
    const answer = await t.model.complete(t.request);
    expect(answer).toMatchObject({ text: "{\"candidates\":[]}", model: ALIAS });
    expect(t.proxy.mintKey).toHaveBeenCalledTimes(1);
    const minted = t.proxy.mintKey.mock.calls[0]![0];
    expect(minted).toMatchObject({ orgId: TEST_ORG, models: [ALIAS], maxBudgetUsd: 0.15, ttlSeconds: 300 });
    // The org alone: no member is named, and the tags say the source, the project that pays and where the spend came from.
    expect(minted).not.toHaveProperty("developerId");
    expect(minted.tags).toMatchObject({ agentId: "learning", project: "web", payerKind: "project", payerId: "web", source: SRC_ANTHROPIC, origin: "learning" });
    expect(t.calls[0]).toMatchObject({ key: t.proxy.mintedKeys()[0], purpose: "reflect", system: "sys", user: "usr", maxOutputTokens: 1800, model: ALIAS, api: "anthropic-messages" });
    expect(Object.keys(t.calls[0]!).sort()).toEqual(["api", "key", "maxOutputTokens", "model", "purpose", "system", "user"]);
  });

  it("the answer's cost is the cap the key held (an upper bound), not a figure read before the proxy has flushed it", async () => {
    const t = install();
    await t.ready();
    // The proxy has not recorded anything yet (a fake that reports spend late): a read now would say 0.
    const answer = await t.model.complete(t.request);
    expect(t.proxy.keySpend).not.toHaveBeenCalledWith([t.keyIds()[0]]);
    expect(answer.costUsd).toBe(0.15);
  });
});

describe("the money: reserved before the call, blocked after it, settled when the proxy has flushed (C1, H2, M1)", () => {
  it("holds the key's cap on the org, the project and the learning month in one reservation, never above the amount the caller asked about", async () => {
    const t = install();
    await t.ready();
    await t.model.complete({ ...t.request, budgetUsd: 0.12 });
    const [keyId] = t.keyIds();
    expect(t.record(keyId!)).toMatchObject({ capUsd: 0.12, reserved: true, finalized: false, tags: { origin: "learning", source: SRC_ANTHROPIC } });
    for (const sk of ["ORG", "PROJECT#web", LEARNING_COUNTER]) near(t.counter(sk)?.committedUsd, 0.12);
    // No budget named: the default call budget.
    const t2 = install();
    await t2.ready();
    const { budgetUsd: _omitted, ...bare } = t2.request;
    void _omitted;
    await t2.model.complete(bare);
    expect(t2.record(t2.keyIds()[0]!)?.capUsd).toBe(LEARNING_CALL_BUDGET_USD);
  });

  it("after the call the key is BLOCKED (not deleted) and given a finalize clock; nothing is charged yet", async () => {
    const t = install();
    await t.ready();
    await t.model.complete(t.request);
    const [keyId] = t.keyIds();
    expect(t.proxy.blockKey).toHaveBeenCalledWith(keyId);
    expect(t.proxy.revokeKey).not.toHaveBeenCalled();
    expect(t.record(keyId!)?.finalizeAfter).toBeGreaterThan(Date.now());
    near(t.counter("ORG")?.spentUsd, 0);
    near(t.counter(LEARNING_COUNTER)?.spentUsd, 0);
  });

  it("a proxy that reports the spend LATE is still charged: the settle after the finalize delay books it on every counter, and the unspent hold is released", async () => {
    const t = install();
    await t.ready();
    await t.model.complete(t.request);
    // Right after the call the proxy says 0 (its batch write has not happened): a sweep now sees nothing, and the whole cap stays held on every counter.
    await t.sweepLater(1_000);
    for (const sk of ["ORG", "PROJECT#web", LEARNING_COUNTER]) { near(t.counter(sk)?.committedUsd, 0.15); near(t.counter(sk)?.spentUsd, 0); }
    // The proxy flushes. The sweep after FINALIZE_DELAY_MS settles the real figure and releases what was not spent.
    t.proxy.setKeySpent(t.proxy.mintedKeys()[0]!, 0.07);
    await t.sweepLater(FINALIZE_DELAY_MS + 1_000);
    const scopes = ["ORG", "PROJECT#web", LEARNING_COUNTER, sourceCounter(SRC_ANTHROPIC), modelCounter(ALIAS), originCounter("learning", "person")];
    for (const sk of scopes) near(t.counter(sk)?.spentUsd, 0.07);
    for (const sk of ["ORG", "PROJECT#web", LEARNING_COUNTER]) near(t.counter(sk)?.committedUsd, 0.07);
    expect(t.record(t.keyIds()[0]!)?.finalized).toBe(true);
  });

  it("a call that FAILED may have cost money: its key holds the cap until the proxy's figure is settled, and what it spent is charged", async () => {
    const t = install();
    await t.ready();
    t.learningCompletion.mockRejectedValueOnce(new Error("MODEL_PROXY_UNAVAILABLE"));
    await expect(t.model.complete(t.request)).rejects.toThrow();
    const [keyId] = t.keyIds();
    expect(t.proxy.blockKey).toHaveBeenCalledWith(keyId);
    for (const sk of ["ORG", "PROJECT#web", LEARNING_COUNTER]) near(t.counter(sk)?.committedUsd, 0.15);
    t.proxy.setKeySpent(t.proxy.mintedKeys()[0]!, 0.09);
    await t.sweepLater(FINALIZE_DELAY_MS + 1_000);
    for (const sk of ["ORG", "PROJECT#web", LEARNING_COUNTER]) { near(t.counter(sk)?.spentUsd, 0.09); near(t.counter(sk)?.committedUsd, 0.09); }
  });

  it("a caller that dies before it can block the key never leaks the month's cap: the sweep finalizes the expired key", async () => {
    const t = install();
    await t.ready();
    t.proxy.blockKey.mockRejectedValue(new Error("proxy down"));
    await t.model.complete(t.request);
    expect(t.record(t.keyIds()[0]!)?.finalizeAfter).toBeUndefined();
    near(t.counter(LEARNING_COUNTER)?.committedUsd, 0.15);
    // Not yet expired: the hold stays. Past the key's expiry and the grace: released.
    await t.sweepLater(60_000);
    near(t.counter(LEARNING_COUNTER)?.committedUsd, 0.15);
    t.proxy.blockKey.mockResolvedValue(undefined);
    await t.sweepLater(300_000 + KEY_EXPIRY_GRACE_MS + 60_000);
    near(t.counter(LEARNING_COUNTER)?.committedUsd, 0);
    expect(t.record(t.keyIds()[0]!)?.finalized).toBe(true);
  });

  it("the worst-case price of one call on a model with a list price must fit what the key holds; a call that could pass it is refused before any key is made", async () => {
    const t = install();
    await t.ready();
    await expect(t.model.complete({ ...t.request, user: "x".repeat(40_000), budgetUsd: 0.05 })).rejects.toThrow(LEARNING_TOO_DEAR);
    expect(t.proxy.mintKey).not.toHaveBeenCalled();
    // The same prompt is fine when the key holds enough for it.
    await expect(t.model.complete({ ...t.request, user: "x".repeat(40_000), budgetUsd: 0.2 })).resolves.toBeDefined();
  });
});

describe("the company's budgets bind learning, project budgets included (H1)", () => {
  it("a project with less left than the call needs refuses it before any key; a project with room is charged on its own counter", async () => {
    const t = install();
    await t.ready();
    t.limitProject(1);
    t.seedCounter("PROJECT#web", { spentUsd: 0.9, committedUsd: 0.9 });
    await expect(t.model.complete(t.request)).rejects.toThrow();
    expect(t.proxy.mintKey).not.toHaveBeenCalled();
    expect(t.learningCompletion).not.toHaveBeenCalled();
    t.seedCounter("PROJECT#web", { spentUsd: 0.5, committedUsd: 0.5 });
    await t.model.complete(t.request);
    near(t.counter("PROJECT#web")?.committedUsd, 0.65);
  });

  it("an Enterprise project budget binds the same way, and Enterprise keeps no learning cap of its own", async () => {
    const t = install({ edition: "enterprise" });
    await t.ready();
    // Far past what Public would allow in a month.
    t.seedCounter(LEARNING_COUNTER, { spentUsd: 500, committedUsd: 500 });
    await t.model.complete(t.request);
    near(t.counter(LEARNING_COUNTER)?.committedUsd, 500.15);
    t.limitProject(1);
    t.seedCounter("PROJECT#web", { spentUsd: 0.95, committedUsd: 0.95 });
    await expect(t.model.complete(t.request)).rejects.toThrow();
    expect(t.proxy.mintKey).toHaveBeenCalledTimes(1);
  });

  it("when the budgets have less left than the call holds, the call is refused rather than run on a smaller key", async () => {
    const t = install();
    await t.ready();
    t.limitProject(1);
    t.seedCounter("PROJECT#web", { spentUsd: 0.9, committedUsd: 0.9 });
    await expect(t.model.complete({ ...t.request, budgetUsd: 0.2 })).rejects.toThrow(LEARNING_NO_BUDGET);
  });

  it("a budget refusal from the company's own limits stops the call before any key is made", async () => {
    const t = install();
    await t.ready();
    t.limitProject(0.01);
    await expect(t.model.complete(t.request)).rejects.toThrow();
    expect(t.proxy.mintKey).not.toHaveBeenCalled();
    expect(t.learningCompletion).not.toHaveBeenCalled();
  });
});

describe("Public: the $20 learning month is held atomically with the key (M2, L1)", () => {
  it("refuses a call that does not fit the month, with nothing held and no key left behind", async () => {
    const t = install();
    await t.ready();
    t.seedCounter(LEARNING_COUNTER, { spentUsd: 19.9, committedUsd: 19.9 });
    await expect(t.model.complete(t.request)).rejects.toThrow(LEARNING_MONTH_FULL);
    expect(t.learningCompletion).not.toHaveBeenCalled();
    // The org and project counters were in the same transaction: nothing moved, and the key that was made was given back.
    expect(t.counter("ORG")?.committedUsd ?? 0).toBe(0);
    near(t.counter(LEARNING_COUNTER)?.committedUsd, 19.9);
    expect(t.proxy.revokeKey).toHaveBeenCalled();
  });

  it("concurrent calls cannot take the month past its cap, whatever order they finish in (this proves the transaction's condition on a fake table, not DynamoDB's own atomicity)", async () => {
    const t = install({ monthlyCapUsd: 0.5 });
    await t.ready();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => t.model.complete({ ...t.request, budgetUsd: 0.15 })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(3);
    near(t.counter(LEARNING_COUNTER)?.committedUsd, 0.45);
  });

  it("holds of calls with different amounts settle on their own keys: each key releases exactly its own unspent cap", async () => {
    const t = install();
    await t.ready();
    await t.model.complete({ ...t.request, purpose: "reflect", budgetUsd: 0.15 });
    await t.model.complete({ ...t.request, purpose: "judge", budgetUsd: 0.01, maxOutputTokens: 120 });
    near(t.counter(LEARNING_COUNTER)?.committedUsd, 0.16);
    // The small call finishes and settles first, then the big one: neither borrows the other's hold.
    t.proxy.setKeySpent(t.proxy.mintedKeys()[1]!, 0.004);
    t.proxy.setKeySpent(t.proxy.mintedKeys()[0]!, 0.1);
    await t.sweepLater(FINALIZE_DELAY_MS + 1_000);
    near(t.counter(LEARNING_COUNTER)?.spentUsd, 0.104);
    near(t.counter(LEARNING_COUNTER)?.committedUsd, 0.104);
  });
});

describe("the learning ledger lines page like any other (M3)", () => {
  it("a page boundary that falls on a learning line pages on without error", async () => {
    const t = install();
    await t.ready();
    const ledger = ledgerOf(t.dependencies)!;
    const clock = { t: Date.now() };
    const at = { ...ledger, now: () => clock.t };
    const { registerKey, settleKey } = await import("../../packages/broker/src/spend/ledger.js");
    const plain = async (index: number) => {
      const secret = `sk-plain-key-${String(index).padStart(4, "0")}`;
      await registerKey(at, { orgId: TEST_ORG, month: MONTH, keyId: keyIdOf(secret), capUsd: 1, scopes: [{ key: { kind: "org" } }], tags: { agentId: "rovara-code", payerKind: "project", payerId: "web", project: "web", source: "rovara", origin: "app", operationId: `op-${String(index)}` }, expiresAt: clock.t + 3_600_000 });
      t.proxy.setKeySpent(secret, 0.01);
      clock.t += 1_000;
      await settleKey(at, TEST_ORG, keyIdOf(secret));
    };
    await plain(0);
    clock.t += 1_000;
    // The learning call, settled second.
    await t.model.complete(t.request);
    t.proxy.setKeySpent(t.proxy.mintedKeys()[0]!, 0.05);
    await settleKey(at, TEST_ORG, t.keyIds()[0]!);
    for (let index = 1; index <= 49; index += 1) await plain(index);
    const deps = { documentClient: t.db, tableName: "state", now: () => clock.t } as never;
    const caller = { orgId: TEST_ORG, orgRole: "owner" } as never;
    const get = async (cursor?: string) => routeSpendRequest(deps, caller, { method: "GET" } as never, new URL(`https://x/v1/app/org/spend/ledger?month=${MONTH}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`)) as Promise<{ lines: Array<{ origin?: string; usd: number }>; next?: string }>;
    const first = await get();
    expect(first.lines).toHaveLength(50);
    // Positive control: the learning line is the last of the first page, so the cursor IS the learning line's sort key.
    expect(first.lines.at(-1)).toMatchObject({ origin: "learning", agentId: "learning", usd: 0.05, source: SRC_ANTHROPIC });
    expect(first.next).toBeDefined();
    const second = await get(first.next);
    expect(second.lines).toHaveLength(1);
    expect(second.lines[0]).toMatchObject({ origin: "app" });
    expect(second.next).toBeUndefined();
  });
});

describe("no Rovara-paid route", () => {
  it("with no usable provider it throws and makes no call: nothing falls back to a Rovara-paid model", async () => {
    const t = install({ projectOrder: [] });
    await t.store.save({ orgId: TEST_ORG, source: anthropic(), mode: "create", by: "dev-owner" });
    await t.store.setOrder({ orgId: TEST_ORG, order: [SRC_ANTHROPIC, "rovara"], by: "dev-owner" });
    await expect(t.model.complete(t.request)).rejects.toThrow(LEARNING_NO_PROVIDER);
    expect(t.learningCompletion).not.toHaveBeenCalled();
    expect(t.proxy.mintKey).not.toHaveBeenCalled();
  });

  it("a person's ChatGPT plan is never the route", async () => {
    const t = install();
    await t.store.setOrder({ orgId: TEST_ORG, order: [SRC_CHATGPT], by: "dev-owner" });
    await expect(t.model.complete(t.request)).rejects.toThrow();
    expect(t.learningCompletion).not.toHaveBeenCalled();
    expect(t.proxy.mintKey).not.toHaveBeenCalled();
  });

  it("a model the company forbids is never chosen", async () => {
    const t = install({ forbidden: [SONNET] });
    await t.ready();
    await expect(t.model.complete(t.request)).rejects.toThrow();
    expect(t.learningCompletion).not.toHaveBeenCalled();
  });

  it("an install without the function's operation or without a spend ledger, a request without a project and a company that is not one all fail closed", async () => {
    const without = install({ withOp: false });
    await expect(without.model.complete(without.request)).rejects.toThrow();
    const noLedger = install({ withAgents: false });
    await noLedger.ready();
    await expect(noLedger.model.complete(noLedger.request)).rejects.toThrow();
    expect(noLedger.proxy.mintKey).not.toHaveBeenCalled();
    const t = install();
    await t.ready();
    await expect(t.model.complete({ ...t.request, project: undefined as never })).rejects.toThrow();
    await expect(t.model.complete({ ...t.request, workspaceId: "not-an-org" })).rejects.toThrow();
    expect(t.learningCompletion).not.toHaveBeenCalled();
  });

  it("the failure of the function is the caller's failure (the reflector answers model_error), after the key was blocked", async () => {
    const t = install();
    await t.ready();
    t.learningCompletion.mockRejectedValueOnce(new Error("MODEL_PROXY_UNAVAILABLE"));
    await expect(t.model.complete(t.request)).rejects.toThrow();
    expect(t.proxy.blockKey).toHaveBeenCalled();
  });
});

void scopeKey;
