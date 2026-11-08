// Lessons in production, lane 1 (fix round 1): the learning pipeline's model runs on the COMPANY's own provider and the company pays; there is no Rovara-paid route. Its money goes through the product's ordinary key
// lifecycle: the key's cap is RESERVED in the spend ledger (org, project and the Public learning month) before the call, the key is BLOCKED after it, and the sweep settles the proxy's own figure once the proxy
// has flushed it. These tests drive the model on a fake table, a fake proxy that reports spend late, and the real mint, ledger and sweep.
import { agentXError } from "@agentx/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AGENT_GUARDRAILS, FINALIZE_DELAY_MS, LESSONS_BROKER_MODEL_WAIT_SECONDS, LESSONS_REFLECT_VISIBILITY_SECONDS, LESSONS_WORKER_DEADLINE_SECONDS, LESSONS_WORKER_TIMEOUT_SECONDS, KEY_EXPIRY_GRACE_MS, ModelSourceSchema, agentGuardrailsKey, editionPolicy, modelKeyKey, modelCounter, originCounter, scopeKey, sourceAlias, sourceCounter, spendCounterKey, spendOriginKind,
  egressDomainsKey, type Edition, type ModelIdentifier, type ModelSource,
} from "../../packages/contracts/src/index.js";
import { listPricesPerMillion } from "@agentx/model-runtime/catalog";
import { endpointQualificationDigest } from "../../packages/broker/src/model-sources/endpoint-digest.js";
import { learningReasoningEffort, reasonsByDefault, unfitForLearning } from "../../packages/broker/src/model-sources/diagnosis-provider.js";
import { ModelSourceStore } from "../../packages/broker/src/model-sources/store.js";
import type { RoutingDependencies } from "../../packages/broker/src/model-sources/routing.js";
import { keyIdOf } from "../../packages/broker/src/org/budget.js";
import { ScopeFullError, sweepSpend } from "../../packages/broker/src/spend/ledger.js";
import { routeSpendRequest } from "../../packages/broker/src/spend/routes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { TEST_ORG } from "../support/orgs.js";
import {
  LEARNING_BROKER_WAIT_MS, LEARNING_CALL_BUDGET_USD, LEARNING_DEADLINE, LEARNING_HOLD_MARGIN, LEARNING_MONTH_FULL, LEARNING_NO_BUDGET, LEARNING_ALL_FORBIDDEN, LEARNING_NO_PROVIDER, LEARNING_TOO_DEAR, customerLearningModel, learningFaultOf, worstCaseTokens,
} from "../../packages/broker/src/aws/broker/learning-model.js";
import { LEARNING_COUNTER } from "../../packages/broker/src/aws/broker/learning-spend.js";
import { runReflectMessage, type ReflectWorkerDeps } from "../../packages/broker/src/lessons/reflect-worker.js";
import { dynamoReflectClaims, reflectClaimKey } from "../../packages/broker/src/lessons/reflect-claims.js";
import type { currentLearningAttempt} from "../../packages/broker/src/lessons/learning-deadline.js";
import { withLearningAttempt, withLearningDeadline } from "../../packages/broker/src/lessons/learning-deadline.js";
import { LESSONS_WORKER_STATE_WRITE_KEY_PATTERNS } from "../../infra/lib/team-record-wiring.js";
import { LearningRefusal } from "../../packages/broker/src/lessons/pause.js";
import { LearningNotForwarded } from "../../packages/broker/src/model-proxy/access.js";
import { keysOutcome } from "../../packages/broker/src/spend/ledger.js";
import { LEARNING_INVOKE_TIMEOUT_MS } from "../../packages/broker/src/model-proxy/invoker.js";
import { ledgerOf } from "../../packages/broker/src/aws/broker/sweeps-and-readiness.js";
import type { AwsBrokerDependencies } from "../../packages/broker/src/aws/broker/definitions.js";

const SRC_ANTHROPIC = "src_aaaaaaaaaaaaaaaaaaaa";
const SRC_CHATGPT = "personal-chatgpt";
const SONNET = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
const HAIKU = { provider: "anthropic", modelId: "claude-haiku-4-5" };
const UNPRICED = { provider: "anthropic", modelId: "acme-tuned-1" };
const ALIAS = sourceAlias(TEST_ORG, SRC_ANTHROPIC, SONNET);
const MONTH = new Date().toISOString().slice(0, 7);
const anthropic = (models: ModelIdentifier[] = [SONNET]): ModelSource => ModelSourceSchema.parse({ kind: "anthropic", sourceId: SRC_ANTHROPIC, label: "Anthropic", models: models.map((catalog) => ({ catalog })) });
// The hold is sized to the call: the chosen model's worst-case list price plus the margin. The one model here is Sonnet ($3 in, $15 out per million tokens); the request below is 3 + 3 UTF-8 bytes (a token each at the bound),
// 256 tokens of framing and 1800 output tokens.
const withMargin = (usd: number) => Math.ceil(usd * LEARNING_HOLD_MARGIN * 1e6) / 1e6;
const HOLD = withMargin((262 * 3 + 1800 * 15) / 1_000_000);
const near = (value: number | undefined, expected: number) => expect(value ?? 0).toBeCloseTo(expected, 6);

afterEach(() => { vi.restoreAllMocks(); });

function install(options: { forbidden?: ModelIdentifier[]; edition?: Edition; withOp?: boolean; projectOrder?: string[]; monthlyCapUsd?: number; withAgents?: boolean; unpriced?: boolean; models?: ModelIdentifier[]; lessonsModel?: ModelIdentifier; source?: ModelSource; approveEgress?: { sourceId: string; host: string } } = {}) {
  const db = new FakeDynamoDb();
  // The company's forbidden models are read now from its guardrails document.
  if (options.forbidden !== undefined) db.set({ ...agentGuardrailsKey(TEST_ORG), guardrails: { ...DEFAULT_AGENT_GUARDRAILS, forbiddenModels: options.forbidden }, revision: 1 });
  if (options.approveEgress !== undefined) {
    const owner = { kind: "model-source" as const, sourceId: options.approveEgress.sourceId };
    db.set({ ...egressDomainsKey(TEST_ORG, owner), orgId: TEST_ORG, owner, active: true, domains: [{ domain: options.approveEgress.host, status: "approved", requestedAt: "2026-10-21T00:00:00.000Z", requestedBy: "dev-owner" }], updatedAt: "2026-10-21T00:00:00.000Z" });
  }
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
  const model = customerLearningModel(dependencies, { routing: () => routing, edition: options.edition ?? "public", ...(options.lessonsModel === undefined ? {} : { lessonsModel: async () => options.lessonsModel }), ...(options.monthlyCapUsd === undefined ? {} : { monthlyCapUsd: options.monthlyCapUsd }), log: () => undefined });
  const request = { purpose: "reflect" as const, system: "sys", user: "usr", maxOutputTokens: 1800, workspaceId: TEST_ORG, project: "web" };
  const counter = (sk: string) => db.get(spendCounterKey(TEST_ORG, MONTH, sk)) as { spentUsd?: number; committedUsd?: number } | undefined;
  const seedCounter = (sk: string, counts: { spentUsd?: number; committedUsd?: number }) => db.set({ ...spendCounterKey(TEST_ORG, MONTH, sk), entityType: "SPEND_COUNTER", ...counts });
  const limitProject = (limitUsd: number) => db.set({ pk: `ORG#${TEST_ORG}#PROJECT_AI#web`, sk: "SETTINGS", entityType: "PROJECT_AI", projectPays: false, monthlyBudgetUsd: limitUsd, revision: 1 });
  const ready = async () => {
    const source = options.source ?? anthropic(options.unpriced === true ? [UNPRICED] : options.models ?? [SONNET]);
    await store.save({ orgId: TEST_ORG, source, mode: "create", by: "dev-owner" });
    await store.setOrder({ orgId: TEST_ORG, order: [source.sourceId], by: "dev-owner" });
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
    expect(minted).toMatchObject({ orgId: TEST_ORG, models: [ALIAS], maxBudgetUsd: HOLD, ttlSeconds: 300 });
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
    near(answer.costUsd, HOLD);
  });
});

describe("the model is the company's CHEAPEST suitable one, not its main assistant model (R8)", () => {
  const aliasOf = (model: ModelIdentifier) => sourceAlias(TEST_ORG, SRC_ANTHROPIC, model);
  const priceOf = (model: ModelIdentifier, tokens: number) => { const price = listPricesPerMillion(model)!; return withMargin((tokens * price.input + 1800 * price.output) / 1_000_000); };

  it("picks the lowest list price among the company's models whatever their order, and holds that model's price", async () => {
    const t = install({ models: [SONNET, HAIKU] });
    await t.ready();
    await t.model.complete(t.request);
    expect(t.calls[0]).toMatchObject({ model: aliasOf(HAIKU) });
    near(t.record(t.keyIds()[0]!)?.capUsd, priceOf(HAIKU, 262));
  });

  it("a model with no list price comes after every priced one, and is used when it is the only one", async () => {
    const mixed = install({ models: [UNPRICED, SONNET] });
    await mixed.ready();
    await mixed.model.complete(mixed.request);
    expect(mixed.calls[0]).toMatchObject({ model: aliasOf(SONNET) });
    const alone = install({ unpriced: true });
    await alone.ready();
    await alone.model.complete(alone.request);
    expect(alone.calls[0]).toMatchObject({ model: aliasOf(UNPRICED) });
  });

  it("a forbidden model is never chosen: the next cheapest is used, and when every model is forbidden the refusal says so", async () => {
    const t = install({ models: [SONNET, HAIKU], forbidden: [HAIKU] });
    await t.ready();
    await t.model.complete(t.request);
    expect(t.calls[0]).toMatchObject({ model: aliasOf(SONNET) });
    const none = install({ models: [SONNET, HAIKU], forbidden: [HAIKU, SONNET] });
    await none.ready();
    await expect(none.model.complete(none.request)).rejects.toMatchObject({ code: "all_models_forbidden", message: LEARNING_ALL_FORBIDDEN });
    expect(none.proxy.mintKey).not.toHaveBeenCalled();
  });

  it("the company's lessons model wins over the cheapest while it is served and allowed; once it is forbidden the cheapest is used again", async () => {
    const set = install({ models: [SONNET, HAIKU], lessonsModel: SONNET });
    await set.ready();
    await set.model.complete(set.request);
    expect(set.calls[0]).toMatchObject({ model: aliasOf(SONNET) });
    const forbidden = install({ models: [SONNET, HAIKU], lessonsModel: SONNET, forbidden: [SONNET] });
    await forbidden.ready();
    await forbidden.model.complete(forbidden.request);
    expect(forbidden.calls[0]).toMatchObject({ model: aliasOf(HAIKU) });
    // A setting for a model no company source serves is ignored too.
    const unserved = install({ models: [HAIKU], lessonsModel: SONNET });
    await unserved.ready();
    await unserved.model.complete(unserved.request);
    expect(unserved.calls[0]).toMatchObject({ model: aliasOf(HAIKU) });
  });

  it("a model whose output limit is below what the call asks for is not suitable; with none left the refusal says so", async () => {
    const t = install({ models: [HAIKU] });
    await t.ready();
    await expect(t.model.complete({ ...t.request, maxOutputTokens: 200_000 })).rejects.toMatchObject({ code: "no_suitable_model" });
  });

  it("quote() answers the hold, or the fixed code of why learning cannot run, and makes no key and no call", async () => {
    const t = install({ models: [HAIKU, SONNET] });
    await t.ready();
    const quoted = await t.model.quote!(t.request);
    expect(quoted.ok).toBe(true);
    near(quoted.ok ? quoted.usd : 0, priceOf(HAIKU, 262));
    expect(t.proxy.mintKey).not.toHaveBeenCalled();
    t.limitProject(1);
    t.seedCounter("PROJECT#web", { spentUsd: 0.999, committedUsd: 0.999 });
    expect(await t.model.quote!(t.request)).toEqual({ ok: false, code: "no_budget" });
    const none = install({ projectOrder: [] });
    await none.ready();
    expect(await none.model.quote!(none.request)).toEqual({ ok: false, code: "no_provider" });
  });

  it("the usage is the company's: learning spend reads as automatic, never as a person's (R9)", async () => {
    expect(spendOriginKind("learning")).toBe("autonomous");
    expect(spendOriginKind("app")).toBe("person");
  });
});

const SRC_OPENROUTER = "src_rrrrrrrrrrrrrrrrrrrr";
const SRC_OPENAI = "src_oooooooooooooooooooo".slice(0, 24);
const openrouter = (...models: string[]): ModelSource => ModelSourceSchema.parse({ kind: "openrouter", sourceId: SRC_OPENROUTER, label: "OpenRouter", models: models.map((modelId) => ({ catalog: { provider: "openrouter", modelId } })) });
const openai = (...models: string[]): ModelSource => ModelSourceSchema.parse({ kind: "openai", sourceId: SRC_OPENAI, label: "OpenAI", models: models.map((modelId) => ({ catalog: { provider: "openai", modelId } })) });
const orAlias = (modelId: string) => sourceAlias(TEST_ORG, SRC_OPENROUTER, { provider: "openrouter", modelId });
const oaAlias = (modelId: string) => sourceAlias(TEST_ORG, SRC_OPENAI, { provider: "openai", modelId });

describe("H1: a model priced at zero, a router and a free variant are never the 'cheapest' (they can train on the text or spend uncounted)", () => {
  const PAID = "anthropic/claude-haiku-4.5";

  it("next to a paid model, `openrouter/auto` (listed at $0, routes to a real model and bills the company) and a ':free' variant are passed over", async () => {
    const t = install({ source: openrouter("openrouter/auto", "cohere/north-mini-code:free", PAID) });
    await t.ready();
    await t.model.complete(t.request);
    expect(t.calls[0]).toMatchObject({ model: orAlias(PAID) });
    // The hold is the paid model's price (not the $0.001 floor of a model listed at nothing).
    expect(t.record(t.keyIds()[0]!)?.capUsd).toBeGreaterThan(0.01);
  });

  it("unfitForLearning: free variants, routers and any catalog model listed at a zero price are unfit, whatever else is true of them; paid models are not", () => {
    const unfit = (provider: string, modelId: string) => unfitForLearning({ provider, modelId });
    expect([unfit("openrouter", "openrouter/auto"), unfit("openrouter", "openrouter/free"), unfit("openrouter", "typesafe/jev-router"), unfit("openrouter", "google/gemma-4-31b-it:free"), unfit("openrouter", "anything:FREE")]).toEqual([true, true, true, true, true]);
    // Zero price from the catalog itself (not the name): the entries listed at nothing.
    expect(unfit("openrouter", "auto")).toBe(true);
    expect([unfit("anthropic", "claude-haiku-4-5"), unfit("openai", "gpt-5-nano"), unfit("openrouter", "anthropic/claude-haiku-4.5"), unfit("anthropic", "acme-tuned-1")]).toEqual([false, false, false, false]);
    expect([reasonsByDefault({ provider: "openai", modelId: "gpt-5-nano" }), reasonsByDefault({ provider: "openai", modelId: "gpt-4.1-nano" }), reasonsByDefault({ provider: "anthropic", modelId: "claude-haiku-4-5" }), reasonsByDefault({ provider: "anthropic", modelId: "acme-tuned-1" })]).toEqual([true, false, false, false]);
  });

  it("when only free, router or zero-priced models are served, learning has no suitable model: the refusal says so and no key is made", async () => {
    for (const id of ["openrouter/auto", "openrouter/free", "cohere/north-mini-code:free", "typesafe/jev-router"]) {
      const t = install({ source: openrouter(id) });
      await t.ready();
      await expect(t.model.complete(t.request)).rejects.toMatchObject({ code: "no_suitable_model" });
      expect(t.proxy.mintKey).not.toHaveBeenCalled();
      expect(await t.model.quote!(t.request)).toEqual({ ok: false, code: "no_suitable_model" });
    }
  });

  it("a stored lessons model that is unfit is ignored on read: the cheapest paid model is used, as for an unserved setting", async () => {
    const t = install({ source: openrouter("openrouter/auto", PAID), lessonsModel: { provider: "openrouter", modelId: "openrouter/auto" } });
    await t.ready();
    await t.model.complete(t.request);
    expect(t.calls[0]).toMatchObject({ model: orAlias(PAID) });
  });
});

describe("N1: the twin filter touches OpenRouter sources only", () => {
  it("a qualified company endpoint that lists a fit model and an unfit one stays qualified (its digest covers the whole list), and learning routes the fit one through it", async () => {
    const SRC_ENDPOINT = "src_eeeeeeeeeeeeeeeeeeee";
    const ROUTER = { provider: "openrouter", modelId: "openrouter/auto" };
    expect(unfitForLearning(ROUTER)).toBe(true);
    expect(unfitForLearning(SONNET)).toBe(false);
    const base = { kind: "endpoint", sourceId: SRC_ENDPOINT, label: "Gateway", baseUrl: "https://llm.example.com/v1", api: "openai-completions", models: [{ name: "our-router", catalog: ROUTER }, { name: "our-sonnet", catalog: SONNET }] };
    const source = ModelSourceSchema.parse({ ...base, qualifiedDigest: endpointQualificationDigest(ModelSourceSchema.parse(base) as never) });
    const t = install({ source, edition: "enterprise", approveEgress: { sourceId: SRC_ENDPOINT, host: "llm.example.com" } });
    await t.ready();
    await t.model.complete(t.request);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({ model: sourceAlias(TEST_ORG, SRC_ENDPOINT, SONNET) });
  });
});

describe("H2: a model that reasons by default is ranked after the ones that do not, and is asked for the least reasoning", () => {
  it("gpt-5-nano is cheaper than gpt-4.1-nano on paper, but it spends a short answer budget on reasoning: the non-reasoning model is chosen", async () => {
    const t = install({ source: openai("gpt-5-nano", "gpt-4.1-nano") });
    await t.ready();
    await t.model.complete(t.request);
    expect(t.calls[0]).toMatchObject({ model: oaAlias("gpt-4.1-nano") });
    expect(t.calls[0]).not.toHaveProperty("reasoningEffort");
  });

  it("when a reasoning model is the only one, the call asks for minimal reasoning (low for the families that have no minimal), and its hold still covers the whole output budget", async () => {
    const nano = install({ source: openai("gpt-5-nano") });
    await nano.ready();
    await nano.model.complete(nano.request);
    expect(nano.calls[0]).toMatchObject({ model: oaAlias("gpt-5-nano"), api: "openai-responses", reasoningEffort: "minimal" });
    const price = listPricesPerMillion({ provider: "openai", modelId: "gpt-5-nano" })!;
    near(nano.record(nano.keyIds()[0]!)?.capUsd, Math.max(withMargin((262 * price.input + 1800 * price.output) / 1_000_000), 0.001));
    expect(nano.record(nano.keyIds()[0]!)?.capUsd).toBeGreaterThanOrEqual((1800 * price.output) / 1_000_000);
    const o4 = install({ source: openai("o4-mini") });
    await o4.ready();
    await o4.model.complete(o4.request);
    expect(o4.calls[0]).toMatchObject({ reasoningEffort: "low" });
  });

  it("an Anthropic model lists reasoning in the catalog but thinks only when asked: it is not demoted, and no reasoning field is sent", async () => {
    const t = install({ models: [HAIKU] });
    await t.ready();
    await t.model.complete(t.request);
    expect(Object.keys(t.calls[0]!)).not.toContain("reasoningEffort");
    const mixed = install({ source: openrouter("openai/gpt-5-nano", "anthropic/claude-haiku-4.5") });
    await mixed.ready();
    await mixed.model.complete(mixed.request);
    expect(mixed.calls[0]).toMatchObject({ model: orAlias("anthropic/claude-haiku-4.5") });
  });
});

describe("R1: the reasoning level comes from the catalog's thinkingLevelMap, never from the model's name", () => {
  const effortOf = (provider: string, modelId: string) => learningReasoningEffort({ provider, modelId });
  const openaiOnly = async (...ids: string[]) => { const t = install({ source: openai(...ids) }); await t.ready(); return t; };

  it("reads the level from real catalog entries: off value first (none), else minimal, else low; a reasoning model with none of those is unfit; no map sends nothing", () => {
    expect(effortOf("openai", "gpt-5")).toEqual({ fit: true, effort: "minimal" });
    expect(effortOf("openai", "gpt-5-nano")).toEqual({ fit: true, effort: "minimal" });
    expect(effortOf("openai", "gpt-5.4-nano")).toEqual({ fit: true, effort: "none" });
    expect(effortOf("openai", "gpt-5.1")).toEqual({ fit: true, effort: "none" });
    expect(effortOf("openai", "o4-mini")).toEqual({ fit: true, effort: "low" });
    expect(effortOf("openai", "gpt-5.2-chat-latest")).toEqual({ fit: false });
    expect(effortOf("openai", "gpt-5.4-pro")).toEqual({ fit: false });
    // An OpenRouter hybrid whose thinking is off by default: asking for "low" would turn it ON, so it is asked for none.
    expect(effortOf("openrouter", "~anthropic/claude-haiku-latest")).toEqual({ fit: true, effort: "none" });
    // A reasoning entry with no map at all: nothing is sent (a guessed level may be refused by the provider).
    expect(effortOf("openrouter", "deepseek/deepseek-v3.2")).toEqual({ fit: true });
    // Not a model that reasons by default: nothing to ask for.
    expect(effortOf("openai", "gpt-4.1-nano")).toEqual({ fit: true });
    expect(effortOf("anthropic", "claude-haiku-4-5")).toEqual({ fit: true });
    expect(effortOf("anthropic", "acme-tuned-1")).toEqual({ fit: true });
  });

  it("gpt-5.4-nano is asked for 'none' (it has no 'minimal'), gpt-5.1 too, and gpt-5 'minimal'", async () => {
    for (const [id, effort] of [["gpt-5.4-nano", "none"], ["gpt-5.1", "none"], ["gpt-5", "minimal"], ["gpt-5-mini", "minimal"]] as const) {
      const t = await openaiOnly(id);
      await t.model.complete(t.request);
      expect(t.calls[0]).toMatchObject({ model: oaAlias(id), reasoningEffort: effort });
    }
  });

  it("an OpenRouter hybrid (`~anthropic/claude-haiku-latest`) is sent 'none' on the completions transport; a reasoning entry with no map is sent nothing", async () => {
    const hybrid = install({ source: openrouter("~anthropic/claude-haiku-latest") });
    await hybrid.ready();
    await hybrid.model.complete(hybrid.request);
    expect(hybrid.calls[0]).toMatchObject({ model: orAlias("~anthropic/claude-haiku-latest"), api: "openai-completions", reasoningEffort: "none" });
    const bare = install({ source: openrouter("deepseek/deepseek-v3.2") });
    await bare.ready();
    await bare.model.complete(bare.request);
    expect(Object.keys(bare.calls[0]!)).not.toContain("reasoningEffort");
  });

  it("gpt-5.2-chat-latest and gpt-5.4-pro (no minimal, low or off) are unfit for learning: never chosen, never quoted, no key made; the setting and stored value are ignored too", async () => {
    expect([unfitForLearning({ provider: "openai", modelId: "gpt-5.2-chat-latest" }), unfitForLearning({ provider: "openai", modelId: "gpt-5.4-pro" }), unfitForLearning({ provider: "openai", modelId: "gpt-5.4-nano" })]).toEqual([true, true, false]);
    for (const id of ["gpt-5.2-chat-latest", "gpt-5.4-pro"]) {
      const t = await openaiOnly(id);
      await expect(t.model.complete(t.request)).rejects.toMatchObject({ code: "no_suitable_model" });
      expect(await t.model.quote!(t.request)).toEqual({ ok: false, code: "no_suitable_model" });
      expect(t.proxy.mintKey).not.toHaveBeenCalled();
    }
    const mixed = await openaiOnly("gpt-5.2-chat-latest", "gpt-5.4-pro", "gpt-5.4-nano");
    await mixed.model.complete(mixed.request);
    expect(mixed.calls[0]).toMatchObject({ model: oaAlias("gpt-5.4-nano"), reasoningEffort: "none" });
    const preferred = install({ source: openai("gpt-5.2-chat-latest", "gpt-5.4-nano"), lessonsModel: { provider: "openai", modelId: "gpt-5.2-chat-latest" } });
    await preferred.ready();
    await preferred.model.complete(preferred.request);
    expect(preferred.calls[0]).toMatchObject({ model: oaAlias("gpt-5.4-nano") });
  });
});

describe("R2: an OpenRouter ':batch' variant is not for chat calls", () => {
  it("is unfit for learning (ranking, allowed set and stored setting): the full-price twin is used even though the batch entry is half the price", async () => {
    expect(unfitForLearning({ provider: "openrouter", modelId: "openai/gpt-4.1-nano:batch" })).toBe(true);
    expect(unfitForLearning({ provider: "openrouter", modelId: "openai/gpt-4.1-nano" })).toBe(false);
    const t = install({ source: openrouter("openai/gpt-4.1-nano:batch", "openai/gpt-4.1-nano") });
    await t.ready();
    await t.model.complete(t.request);
    expect(t.calls[0]).toMatchObject({ model: orAlias("openai/gpt-4.1-nano") });
    const only = install({ source: openrouter("openai/gpt-4.1-nano:batch") });
    await only.ready();
    await expect(only.model.complete(only.request)).rejects.toMatchObject({ code: "no_suitable_model" });
    const set = install({ source: openrouter("openai/gpt-4.1-nano:batch", "openai/gpt-4.1-nano"), lessonsModel: { provider: "openrouter", modelId: "openai/gpt-4.1-nano:batch" } });
    await set.ready();
    await set.model.complete(set.request);
    expect(set.calls[0]).toMatchObject({ model: orAlias("openai/gpt-4.1-nano") });
  });
});

describe("R6: a scope that fills at the mint is a budget pause, not a provider failure", () => {
  it("a ScopeFullError for the org or the project (not the learning month) maps to no_budget", async () => {
    const t = install();
    await t.ready();
    t.proxy.mintKey.mockRejectedValueOnce(new ScopeFullError("ORG"));
    await expect(t.model.complete(t.request)).rejects.toMatchObject({ name: "LearningRefusal", code: "no_budget", message: LEARNING_NO_BUDGET });
  });
});

describe("L4 / L5: the budget codes are exact", () => {
  it("a rate-limit style code from the mint is a plain failure, not 'the AI budget has run out'", async () => {
    const t = install();
    await t.ready();
    t.proxy.mintKey.mockRejectedValueOnce(Object.assign(new Error("slow down"), { code: "RATE_LIMITED" }));
    const failure = await t.model.complete(t.request).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as { code?: string }).code).toBe("RATE_LIMITED");
    expect(failure).not.toHaveProperty("name", "LearningRefusal");
    t.proxy.mintKey.mockRejectedValueOnce(Object.assign(new Error("full"), { code: "PROJECT_BUDGET_EXCEEDED" }));
    await expect(t.model.complete(t.request)).rejects.toMatchObject({ code: "no_budget" });
  });
});

describe("the money: reserved before the call, blocked after it, settled when the proxy has flushed (C1, H2, M1)", () => {
  it("holds the key's cap on the org, the project and the learning month in one reservation, sized to the call and never above a ceiling the caller names", async () => {
    const t = install();
    await t.ready();
    await t.model.complete({ ...t.request, budgetUsd: 0.12 });
    const [keyId] = t.keyIds();
    expect(t.record(keyId!)).toMatchObject({ reserved: true, finalized: false, tags: { origin: "learning", source: SRC_ANTHROPIC } });
    near(t.record(keyId!)?.capUsd, HOLD);
    for (const sk of ["ORG", "PROJECT#web", LEARNING_COUNTER]) near(t.counter(sk)?.committedUsd, HOLD);
  });

  it("a model with no list price holds the caller's budget, else the default call budget", async () => {
    const t = install({ unpriced: true });
    await t.ready();
    await t.model.complete({ ...t.request, budgetUsd: 0.12 });
    expect(t.record(t.keyIds()[0]!)?.capUsd).toBe(0.12);
    const { budgetUsd: _omitted, ...bare } = { ...t.request, budgetUsd: 0 };
    void _omitted;
    await t.model.complete(bare);
    expect(t.record(t.keyIds()[1]!)?.capUsd).toBe(LEARNING_CALL_BUDGET_USD);
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
    for (const sk of ["ORG", "PROJECT#web", LEARNING_COUNTER]) { near(t.counter(sk)?.committedUsd, HOLD); near(t.counter(sk)?.spentUsd, 0); }
    // The proxy flushes. The sweep after FINALIZE_DELAY_MS settles the real figure and releases what was not spent.
    t.proxy.setKeySpent(t.proxy.mintedKeys()[0]!, 0.07);
    await t.sweepLater(FINALIZE_DELAY_MS + 1_000);
    const scopes = ["ORG", "PROJECT#web", LEARNING_COUNTER, sourceCounter(SRC_ANTHROPIC), modelCounter(ALIAS), originCounter("learning", "autonomous")];
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
    for (const sk of ["ORG", "PROJECT#web", LEARNING_COUNTER]) near(t.counter(sk)?.committedUsd, HOLD);
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
    near(t.counter(LEARNING_COUNTER)?.committedUsd, HOLD);
    // Not yet expired: the hold stays. Past the key's expiry and the grace: released.
    await t.sweepLater(60_000);
    near(t.counter(LEARNING_COUNTER)?.committedUsd, HOLD);
    t.proxy.blockKey.mockResolvedValue(undefined);
    await t.sweepLater(300_000 + KEY_EXPIRY_GRACE_MS + 60_000);
    near(t.counter(LEARNING_COUNTER)?.committedUsd, 0);
    expect(t.record(t.keyIds()[0]!)?.finalized).toBe(true);
  });

  it("a longer prompt holds more, and a ceiling the caller names refuses a call whose worst case passes it before any key is made", async () => {
    const t = install();
    await t.ready();
    await expect(t.model.complete({ ...t.request, user: "x".repeat(40_000), budgetUsd: 0.05 })).rejects.toThrow(LEARNING_TOO_DEAR);
    expect(t.proxy.mintKey).not.toHaveBeenCalled();
    await t.model.complete({ ...t.request, user: "x".repeat(40_000) });
    near(t.record(t.keyIds()[0]!)?.capUsd, withMargin(((40_000 + 3 + 256) * 3 + 1800 * 15) / 1_000_000));
  });

  it("R7 / M1: every byte is a token at the bound (CJK, hex, base64 and dense JSON included), so no prompt is under-held by a characters-per-token guess", async () => {
    const t = install();
    await t.ready();
    const cjk = "漢".repeat(3_000);
    await t.model.complete({ ...t.request, user: cjk });
    // 3000 characters of 3 bytes: 9000 tokens at the bound (the old guess said 1000), plus the framing and the system text (3 bytes).
    const inputTokens = 9_000 + 3 + 256;
    near(t.record(t.keyIds()[0]!)?.capUsd, withMargin((inputTokens * 3 + 1800 * 15) / 1_000_000));
    expect(worstCaseTokens("abc")).toBe(3);
    expect(worstCaseTokens("é")).toBe(2);
    // Text that tokenizes at one or two characters a token (hex, base64, digit runs) is still bounded: never more tokens than bytes.
    for (const dense of ["0123456789abcdef".repeat(64), "QUJDREVGR0g=".repeat(64), "1234567890".repeat(100)]) expect(worstCaseTokens(dense)).toBe(dense.length);
  });

  it("M1: the hold carries a margin above the worst-case list price, so a proxy price a little above the list price cannot take a call past its hold", async () => {
    const t = install();
    await t.ready();
    await t.model.complete(t.request);
    const worst = (262 * 3 + 1800 * 15) / 1_000_000;
    const held = t.record(t.keyIds()[0]!)?.capUsd ?? 0;
    expect(held).toBeGreaterThanOrEqual(worst * 1.2);
    expect(LEARNING_HOLD_MARGIN).toBeGreaterThan(1);
  });

  it("R3: a key capped below the hold (a concurrent mint took the room after the look) is blocked and refused, and no call is made", async () => {
    const t = install();
    await t.ready();
    t.limitProject(1);
    // The company's figures are read once for the look (admitWork) and once more when the cap is planned: between the two, another mint takes the project's room.
    const base = t.proxy.orgSpend.getMockImplementation()!;
    let reads = 0;
    t.proxy.orgSpend.mockImplementation(async (...args) => {
      const figures = await base(...args);
      reads += 1;
      if (reads === 1) t.seedCounter("PROJECT#web", { spentUsd: 0.99, committedUsd: 0.99 });
      return figures;
    });
    await expect(t.model.complete(t.request)).rejects.toMatchObject({ code: "no_budget" });
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(t.learningCompletion).not.toHaveBeenCalled();
    expect(t.proxy.blockKey).toHaveBeenCalled();
  });
});

describe("the company's budgets bind learning, project budgets included (H1)", () => {
  it("a project with less left than the call needs refuses it before any key; a project with room is charged on its own counter", async () => {
    const t = install();
    await t.ready();
    t.limitProject(1);
    t.seedCounter("PROJECT#web", { spentUsd: 0.99, committedUsd: 0.99 });
    await expect(t.model.complete(t.request)).rejects.toMatchObject({ code: "no_budget" });
    expect(t.proxy.mintKey).not.toHaveBeenCalled();
    expect(t.learningCompletion).not.toHaveBeenCalled();
    t.seedCounter("PROJECT#web", { spentUsd: 0.5, committedUsd: 0.5 });
    await t.model.complete(t.request);
    near(t.counter("PROJECT#web")?.committedUsd, 0.5 + HOLD);
  });

  it("an Enterprise project budget binds the same way, and Enterprise keeps no learning cap of its own", async () => {
    const t = install({ edition: "enterprise" });
    await t.ready();
    // Far past what Public would allow in a month.
    t.seedCounter(LEARNING_COUNTER, { spentUsd: 500, committedUsd: 500 });
    await t.model.complete(t.request);
    near(t.counter(LEARNING_COUNTER)?.committedUsd, 500 + HOLD);
    t.limitProject(1);
    t.seedCounter("PROJECT#web", { spentUsd: 0.99, committedUsd: 0.99 });
    await expect(t.model.complete(t.request)).rejects.toThrow();
    expect(t.proxy.mintKey).toHaveBeenCalledTimes(1);
  });

  it("when the budgets have less left than the call holds, the call is refused rather than run on a smaller key", async () => {
    const t = install();
    await t.ready();
    t.limitProject(1);
    t.seedCounter("PROJECT#web", { spentUsd: 0.99, committedUsd: 0.99 });
    await expect(t.model.complete(t.request)).rejects.toThrow(LEARNING_NO_BUDGET);
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
    t.seedCounter(LEARNING_COUNTER, { spentUsd: 19.99, committedUsd: 19.99 });
    await expect(t.model.complete(t.request)).rejects.toMatchObject({ message: LEARNING_MONTH_FULL, code: "monthly_limit" });
    expect(t.learningCompletion).not.toHaveBeenCalled();
    // The org and project counters were in the same transaction: nothing moved, and the key that was made was given back.
    expect(t.counter("ORG")?.committedUsd ?? 0).toBe(0);
    near(t.counter(LEARNING_COUNTER)?.committedUsd, 19.99);
    expect(t.proxy.revokeKey).toHaveBeenCalled();
  });

  it("concurrent calls cannot take the month past its cap, whatever order they finish in (this proves the transaction's condition on a fake table, not DynamoDB's own atomicity)", async () => {
    const t = install({ monthlyCapUsd: 0.12 });
    await t.ready();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => t.model.complete(t.request)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(3);
    near(t.counter(LEARNING_COUNTER)?.committedUsd, 3 * HOLD);
  });

  it("holds of calls with different amounts settle on their own keys: each key releases exactly its own unspent cap", async () => {
    const t = install();
    await t.ready();
    await t.model.complete({ ...t.request, purpose: "reflect" });
    await t.model.complete({ ...t.request, purpose: "judge", maxOutputTokens: 120 });
    const judgeHold = withMargin((262 * 3 + 120 * 15) / 1_000_000);
    near(t.counter(LEARNING_COUNTER)?.committedUsd, HOLD + judgeHold);
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

// Lessons in production, lane 2 (LP-3): the same ledger reservations, seen from the WORKER. A worker that dies (or is given up on) between the key's reservation and its settling never leaks the month's cap
// or charges twice, and a call that could not finish before the worker's deadline is not started at all.
describe("the worker's side of the money (LP-3)", () => {
  const body = JSON.stringify({ orgId: TEST_ORG, taskId: "task-1", outcome: "merged", requestId: "r1" });
  /** The worker's lease store on the test's own table and ledger, with the real keys-outcome check. */
  const leasesOf = (t: ReturnType<typeof install>) => dynamoReflectClaims({ documentClient: t.db, tableName: "state", keysOutcome: (org, ids) => keysOutcome(ledgerOf(t.dependencies)!, org, ids) });
  const workerOf = (t: ReturnType<typeof install>, over: Partial<ReflectWorkerDeps> = {}): ReflectWorkerDeps => ({
    claims: leasesOf(t), learn: async () => { await t.model.complete(t.request); return { status: "reflected", retry: false }; }, now: () => Date.now(), deadlineMs: 240_000, graceMs: 1_000, log: () => undefined, ...over,
  });

  it("R1: a worker given up on while the model call is in flight has MADE the call: the lease says so, a redelivery waits for nothing and never runs it again, even when the sweep finalizes the key at $0", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const t = install();
      await t.ready();
      // The call never answers (and ignores the signal): the worker is given up on at its deadline with the key reserved and the call started.
      t.learningCompletion.mockImplementationOnce(() => new Promise(() => undefined));
      const worker = workerOf(t);
      const running = runReflectMessage(worker, body);
      await vi.advanceTimersByTimeAsync(241_000);
      expect(await running).toEqual({ result: "timed_out", retry: true });
      const firstKey = t.keyIds()[0]!;
      expect(t.keyIds()).toHaveLength(1);
      // The key was tagged with the attempt and noted on the lease; the lease carries the mark written just before the call.
      const lease = t.db.get(reflectClaimKey(TEST_ORG, "task-1", "merged").pk, "CLAIM") as { leaseState: string; attempt: number; attemptId: string; modelKeyIds: string[]; callStartedAt?: number };
      expect(lease).toMatchObject({ leaseState: "retry", attempt: 1, modelKeyIds: [firstKey] });
      expect(typeof lease.callStartedAt).toBe("number");
      expect(t.record(firstKey)?.tags.operationId).toMatch(new RegExp(`^learning-${lease.attemptId}-`));
      for (const sk of ["ORG", "PROJECT#web", LEARNING_COUNTER]) near(t.counter(sk)?.committedUsd, HOLD);
      // The proxy booked NOTHING for the key (an unpriced route, or spend that has not landed yet) and the sweep finalizes it at $0: the old rule would run the work again here.
      await t.sweepLater(300_000 + KEY_EXPIRY_GRACE_MS + 60_000);
      for (const sk of ["ORG", "PROJECT#web", LEARNING_COUNTER]) { near(t.counter(sk)?.committedUsd, 0); near(t.counter(sk)?.spentUsd, 0); }
      expect(t.record(firstKey)?.finalized).toBe(true);
      vi.setSystemTime(Date.now() + 301_000 + KEY_EXPIRY_GRACE_MS + 60_000);
      for (let delivery = 0; delivery < 3; delivery += 1) expect(await runReflectMessage(worker, body)).toEqual({ result: "already", retry: false });
      expect(t.keyIds()).toHaveLength(1);
      expect(t.learningCompletion).toHaveBeenCalledTimes(1);
      expect(t.db.get(reflectClaimKey(TEST_ORG, "task-1", "merged").pk, "CLAIM")).toMatchObject({ leaseState: "spent", attempt: 1 });
    } finally { vi.useRealTimers(); }
  });

  it("R1 (positive control): a fault from BEFORE the call starts (a table read) is retried on a new attempt once the earlier key has settled with nothing spent; the call was made exactly once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const t = install();
      await t.ready();
      // The guardrails read fails before any key exists; the worker retries.
      t.db.injectFault({ command: "GetCommand", match: (input) => JSON.stringify(input["Key"]) === JSON.stringify(agentGuardrailsKey(TEST_ORG)), error: { name: "ProvisionedThroughputExceededException" }, times: 1 });
      const worker = workerOf(t);
      expect(await runReflectMessage(worker, body)).toEqual({ result: "failed", retry: true });
      expect(t.keyIds()).toHaveLength(0);
      const lease = t.db.get(reflectClaimKey(TEST_ORG, "task-1", "merged").pk, "CLAIM") as { leaseState: string; callStartedAt?: number };
      expect(lease).toMatchObject({ leaseState: "retry" });
      expect(lease.callStartedAt).toBeUndefined();
      expect(await runReflectMessage(worker, body)).toEqual({ result: "reflected", retry: false });
      expect(t.db.get(reflectClaimKey(TEST_ORG, "task-1", "merged").pk, "CLAIM")).toMatchObject({ leaseState: "done", attempt: 2 });
      expect(t.learningCompletion).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("R1: a reflection whose call ANSWERED but whose lease could not be ended (finish failed) is spent too: a duplicate message after the lease lapses makes no second call", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const t = install();
      await t.ready();
      const claims = leasesOf(t);
      const worker = workerOf(t, { claims: { ...claims, finish: async () => { throw new Error("table down"); } } });
      expect(await runReflectMessage(worker, body)).toEqual({ result: "reflected", retry: false });
      expect(t.learningCompletion).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 2_000_000);
      expect(await runReflectMessage(workerOf(t), body)).toEqual({ result: "already", retry: false });
      expect(t.learningCompletion).toHaveBeenCalledTimes(1);
      expect(t.db.get(reflectClaimKey(TEST_ORG, "task-1", "merged").pk, "CLAIM")).toMatchObject({ leaseState: "spent" });
    } finally { vi.useRealTimers(); }
  });

  it("R1: if the earlier attempt's key spent anything, the work is never run again, however many times the message comes back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const t = install();
      await t.ready();
      t.learningCompletion.mockImplementationOnce(() => new Promise(() => undefined));
      const worker = workerOf(t);
      const running = runReflectMessage(worker, body);
      await vi.advanceTimersByTimeAsync(241_000);
      expect((await running).result).toBe("timed_out");
      // The call did reach the provider: the proxy flushes a figure for the key.
      t.proxy.setKeySpent(t.proxy.mintedKeys()[0]!, 0.06);
      await t.sweepLater(300_000 + KEY_EXPIRY_GRACE_MS + 60_000);
      vi.setSystemTime(Date.now() + 301_000 + KEY_EXPIRY_GRACE_MS + 60_000);
      for (let delivery = 0; delivery < 3; delivery += 1) expect(await runReflectMessage(worker, body)).toEqual({ result: "already", retry: false });
      expect(t.keyIds()).toHaveLength(1);
      expect(t.db.get(reflectClaimKey(TEST_ORG, "task-1", "merged").pk, "CLAIM")).toMatchObject({ leaseState: "spent", attempt: 1 });
    } finally { vi.useRealTimers(); }
  });

  /** One attempt of the worker, with a lease store on the test's own table (the real mark writes), and what it ended as. */
  const attemptOf = (t: ReturnType<typeof install>, extra: Partial<NonNullable<ReturnType<typeof currentLearningAttempt>>> = {}) => {
    const claims = leasesOf(t);
    return { claims, run: async <T,>(work: () => Promise<T>) => {
      const taken = await claims.take({ orgId: TEST_ORG, taskId: "task-1", outcome: "merged" }, Date.now());
      if (taken.kind !== "taken") throw new Error("not taken");
      const lease = taken.lease;
      const attempt: NonNullable<ReturnType<typeof currentLearningAttempt>> = {
        deadlineAt: Date.now() + 200_000, attemptId: lease.attemptId, leaseKey: lease.key, lastAttempt: false,
        callStarting: () => claims.markCallStarted(lease, Date.now()), callNotSent: () => claims.clearCallStarted(lease), ...extra,
      };
      const outcome = await withLearningAttempt(attempt, work).then(() => "ok" as const, (error: unknown) => error);
      return { attempt, outcome, lease: () => t.db.get(reflectClaimKey(TEST_ORG, "task-1", "merged").pk, "CLAIM") as { callStartedAt?: number } };
    } };
  };

  it("R1: once the call has started EVERY failure is final: a function error, a timeout, an abort and an answer with no text, whatever the key settles at", async () => {
    for (const failure of [new Error("MODEL_PROXY_UNAVAILABLE"), Object.assign(new Error("aborted"), { name: "AbortError" }), agentXError("MODEL_PROXY_UNAVAILABLE", "the learning model call failed"), agentXError("MODEL_PROXY_UNAVAILABLE", "the learning model answered with no text")]) {
      const t = install();
      await t.ready();
      t.learningCompletion.mockRejectedValueOnce(failure);
      const ran = await attemptOf(t).run(() => t.model.complete(t.request));
      expect(ran.outcome).toBe(failure);
      expect(ran.attempt.fault).toBe("final");
      expect(typeof ran.lease().callStartedAt).toBe("number");
    }
  });

  it("R1: the mark is written BEFORE the call (the call sees it on the lease), and a lease that cannot be marked means NO call is made and the fault is retryable", async () => {
    const t = install();
    await t.ready();
    let markedWhenCalled: number | undefined;
    const ran = attemptOf(t);
    t.learningCompletion.mockImplementationOnce(async (input) => {
      markedWhenCalled = (t.db.get(reflectClaimKey(TEST_ORG, "task-1", "merged").pk, "CLAIM") as { callStartedAt?: number }).callStartedAt;
      return { text: "{}", model: String(input["model"]) };
    });
    const first = await ran.run(() => t.model.complete(t.request));
    expect(first.outcome).toBe("ok");
    expect(typeof markedWhenCalled).toBe("number");

    const u = install();
    await u.ready();
    const refused = await attemptOf(u, { callStarting: async () => { throw new Error("table down"); } }).run(() => u.model.complete(u.request));
    expect(refused.outcome).toBeInstanceOf(Error);
    expect(refused.attempt.fault).toBe("retryable");
    expect(u.learningCompletion).not.toHaveBeenCalled();
    expect(u.proxy.blockKey).toHaveBeenCalled();
  });

  it("R1: the in-VPC client's typed 'not forwarded' refusal (nothing was sent) is the one exception: the mark is taken back and the fault is retryable; a mark that cannot be taken back leaves it final", async () => {
    const t = install();
    await t.ready();
    t.learningCompletion.mockRejectedValueOnce(new LearningNotForwarded("the learning model call was not sent"));
    const ran = await attemptOf(t).run(() => t.model.complete(t.request));
    expect(ran.attempt.fault).toBe("retryable");
    expect(ran.lease().callStartedAt).toBeUndefined();
    const u = install();
    await u.ready();
    u.learningCompletion.mockRejectedValueOnce(new LearningNotForwarded("the learning model call was not sent"));
    const stuck = await attemptOf(u, { callNotSent: async () => { throw new Error("table down"); } }).run(() => u.model.complete(u.request));
    expect(stuck.attempt.fault).toBe("final");
    expect(typeof stuck.lease().callStartedAt).toBe("number");
  });

  it("R4: the time is looked at again right before the call: steps that ate the budget (the mint) leave no call, no mark, a blocked key that spent nothing, and a retryable fault", async () => {
    const t = install();
    await t.ready();
    const deadlineAt = Date.now() + LEARNING_BROKER_WAIT_MS + 5_000;
    // The mint is slow: by the time it returns, the call can no longer finish inside the deadline.
    const baseMint = t.proxy.mintKey.getMockImplementation()!;
    t.proxy.mintKey.mockImplementation(async (mint) => { const minted = await baseMint(mint); vi.setSystemTime(Date.now() + 10_000); return minted; });
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    try {
      const ran = await attemptOf(t, { deadlineAt }).run(() => t.model.complete(t.request));
      expect(ran.outcome).toMatchObject({ message: LEARNING_DEADLINE });
      expect(ran.attempt.fault).toBe("retryable");
      expect(t.learningCompletion).not.toHaveBeenCalled();
      expect(ran.lease().callStartedAt).toBeUndefined();
      expect(t.proxy.blockKey).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  /** The State table as the worker's role sees it (M7): a write whose partition key is outside the grant is refused with AccessDenied, every write of a transaction included. */
  const iamShaped = (db: FakeDynamoDb) => {
    const allowed = LESSONS_WORKER_STATE_WRITE_KEY_PATTERNS.map((pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*")}$`, "u"));
    const refused: string[] = [];
    const check = (pk: unknown): void => {
      if (typeof pk === "string" && !allowed.some((pattern) => pattern.test(pk))) { refused.push(pk); throw Object.assign(new Error("not authorized"), { name: "AccessDeniedException" }); }
    };
    const send = async (command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> => {
      const input = command.input;
      switch (command.constructor.name) {
        case "PutCommand": check((input["Item"] as { pk?: unknown }).pk); break;
        case "UpdateCommand": case "DeleteCommand": check((input["Key"] as { pk?: unknown }).pk); break;
        case "TransactWriteCommand":
          for (const item of input["TransactItems"] as Array<Record<string, { Item?: { pk?: unknown }; Key?: { pk?: unknown } }>>) for (const action of Object.values(item)) check((action.Item ?? action.Key)?.pk);
          break;
        default: break;
      }
      return db.send(command);
    };
    return { client: { send } as unknown as FakeDynamoDb, refused };
  };

  it("R2: inside the worker the budget-sync marker is best-effort: its write is refused (AccessDenied, the grant is not widened), the reflection still runs, the proxy was told, and only a fixed code is logged; a lost proxy state heals by forcing the upsert", async () => {
    const t = install();
    await t.ready();
    const shaped = iamShaped(t.db);
    (t.dependencies as unknown as { documentClient: unknown }).documentClient = shaped.client;
    const ran = await attemptOf(t).run(() => t.model.complete(t.request));
    expect(ran.outcome).toBe("ok");
    // The marker was attempted and refused; nothing else the ledger needs was.
    expect(shaped.refused.length).toBeGreaterThan(0);
    expect(shaped.refused.every((pk) => pk.includes("#SETTINGS") || pk.includes("SYNC"))).toBe(true);
    expect(t.proxy.upsertOrg).toHaveBeenCalled();
    expect(t.learningCompletion).toHaveBeenCalledTimes(1);
    // Lost proxy state: the markers cannot be deleted, so the upsert is forced instead and the mint goes through on the second try.
    const upserts = t.proxy.upsertOrg.mock.calls.length;
    t.proxy.mintKey.mockRejectedValueOnce(agentXError("NOT_FOUND", "team not found"));
    await expect(withLearningAttempt({ deadlineAt: Date.now() + 200_000 }, () => t.model.complete(t.request))).resolves.toHaveProperty("costUsd");
    expect(t.proxy.upsertOrg.mock.calls.length).toBeGreaterThan(upserts);
    // Outside a worker (no attempt) the same refusal is an ordinary failure: the broker has the grant, so a denial there is a real fault.
    const outside = install();
    await outside.ready();
    (outside.dependencies as unknown as { documentClient: unknown }).documentClient = iamShaped(outside.db).client;
    await expect(outside.model.complete(outside.request)).rejects.toMatchObject({ name: "AccessDeniedException" });
  });

  it("R3: ONE refusal class: a LearningRefusal (a 1b code, or no model path / no ledger in this install) is final and carries its code; a table fault inside quote() is typed retryable, a refusal in it is not a fault at all", async () => {
    const t = install();
    await t.ready();
    const faultOf = async (u: ReturnType<typeof install>, run: () => Promise<unknown>) => {
      const attempt = { deadlineAt: Date.now() + 200_000 } as NonNullable<ReturnType<typeof currentLearningAttempt>>;
      const error = await withLearningAttempt(attempt, run).catch((e: unknown) => e);
      return { fault: attempt.fault, error };
    };
    // quote(): a table fault is retryable (nothing was held or sent) ...
    t.db.injectFault({ command: "GetCommand", error: { name: "ProvisionedThroughputExceededException" }, times: 1 });
    expect((await faultOf(t, () => t.model.quote!(t.request))).fault).toBe("retryable");
    // ... a refusal answers with its code and sets no fault.
    const noProvider = install({ projectOrder: [] });
    await noProvider.store.save({ orgId: TEST_ORG, source: anthropic(), mode: "create", by: "dev-owner" });
    await noProvider.store.setOrder({ orgId: TEST_ORG, order: [SRC_ANTHROPIC, "rovara"], by: "dev-owner" });
    const quoted = await faultOf(noProvider, () => noProvider.model.quote!(noProvider.request));
    expect(quoted.fault).toBeUndefined();
    // complete(): every 1b refusal is a LearningRefusal and final.
    const refused = await faultOf(noProvider, () => noProvider.model.complete(noProvider.request));
    expect(refused.error).toBeInstanceOf(LearningRefusal);
    expect(refused.fault).toBe("final");
    const bare = install({ withOp: false });
    const noPath = await faultOf(bare, () => bare.model.complete(bare.request));
    expect(noPath.error).toMatchObject({ code: "no_provider" });
    expect(noPath.fault).toBe("final");
    const noAgents = install({ withAgents: false });
    await noAgents.ready();
    const noLedger = await faultOf(noAgents, () => noAgents.model.complete(noAgents.request));
    expect(noLedger.error).toBeInstanceOf(LearningRefusal);
    expect(noLedger.fault).toBe("final");
    expect(learningFaultOf(new LearningRefusal("no_budget", "x"), false)).toBe("final");
  });

  it("H1: before the call, a table fault or a 5xx is retryable and a 4xx answer is final; the deadline's refusal is retryable; a month that is full, a price too high and no provider are final", async () => {
    const t = install();
    await t.ready();
    const faultOf = async (u: ReturnType<typeof install>, run: () => Promise<unknown>) => {
      const attempt = { deadlineAt: Date.now() + 200_000 } as NonNullable<ReturnType<typeof currentLearningAttempt>>;
      await withLearningAttempt(attempt, run).catch(() => undefined);
      return attempt.fault;
    };
    t.db.injectFault({ command: "GetCommand", error: { name: "ProvisionedThroughputExceededException" }, times: 1 });
    expect(await faultOf(t, () => t.model.complete(t.request))).toBe("retryable");
    expect(learningFaultOf(agentXError("MODEL_PROXY_UNAVAILABLE", "x"), false)).toBe("retryable");
    expect(learningFaultOf(agentXError("CONFIG_INVALID", "x"), false)).toBe("final");
    const refused = { deadlineAt: Date.now() + 1_000 } as NonNullable<ReturnType<typeof currentLearningAttempt>>;
    await withLearningAttempt(refused, () => t.model.complete(t.request)).catch(() => undefined);
    expect(refused.fault).toBe("retryable");
    const tooDear = install();
    await tooDear.ready();
    expect(await faultOf(tooDear, () => tooDear.model.complete({ ...tooDear.request, system: "s".repeat(8_000), user: "u".repeat(40_000), maxOutputTokens: 2_000, budgetUsd: 0.001 }))).toBe("final");
    const monthFull = install({ monthlyCapUsd: 0.01 });
    await monthFull.ready();
    expect(await faultOf(monthFull, () => monthFull.model.complete(monthFull.request))).toBe("final");
  });

  it("M4: the attempt's abort signal reaches the function's call, so a call in flight is stopped at the deadline", async () => {
    const t = install();
    await t.ready();
    const controller = new AbortController();
    await withLearningAttempt({ deadlineAt: Date.now() + 200_000, signal: controller.signal, attemptId: "att-9" }, () => t.model.complete(t.request));
    expect(t.calls[0]!["signal"]).toBe(controller.signal);
    await t.model.complete(t.request);
    expect(t.calls[1]!["signal"]).toBeUndefined();
  });

  it("a call that could still be running at the worker's deadline is refused before any key exists: nothing is reserved or charged", async () => {
    const t = install();
    await t.ready();
    const deadlineAt = Date.now() + 60_000;
    await expect(withLearningDeadline(deadlineAt, () => t.model.complete(t.request))).rejects.toThrow(LEARNING_DEADLINE);
    expect(t.proxy.mintKey).not.toHaveBeenCalled();
    for (const sk of ["ORG", "PROJECT#web", LEARNING_COUNTER]) near(t.counter(sk)?.committedUsd, 0);
    // With the broker's whole wait available the same call goes ahead (the positive control), and outside a worker there is no deadline at all.
    await withLearningDeadline(Date.now() + LEARNING_BROKER_WAIT_MS + 1_000, () => t.model.complete(t.request));
    expect(t.proxy.mintKey).toHaveBeenCalledTimes(1);
    await t.model.complete(t.request);
    expect(t.proxy.mintKey).toHaveBeenCalledTimes(2);
  });

  it("the worker's numbers fit together: the model step (100 s) is inside the function (120 s), which is inside the broker's wait (130 s), which fits before the worker's deadline (240 s) and timeout (300 s), under the queue's visibility", () => {
    expect(LEARNING_INVOKE_TIMEOUT_MS).toBe(LESSONS_BROKER_MODEL_WAIT_SECONDS * 1000);
    expect(LEARNING_BROKER_WAIT_MS).toBe(LEARNING_INVOKE_TIMEOUT_MS);
    expect(LESSONS_WORKER_DEADLINE_SECONDS).toBeGreaterThan(LESSONS_BROKER_MODEL_WAIT_SECONDS);
    // The worker outlives its own deadline by the key-block step and the work around it.
    expect(LESSONS_WORKER_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(LESSONS_WORKER_DEADLINE_SECONDS + 30);
    expect(LESSONS_WORKER_TIMEOUT_SECONDS).toBeGreaterThan(LESSONS_BROKER_MODEL_WAIT_SECONDS + 60);
    expect(LESSONS_REFLECT_VISIBILITY_SECONDS).toBeGreaterThan(LESSONS_WORKER_TIMEOUT_SECONDS);
    expect(LESSONS_WORKER_TIMEOUT_SECONDS).toBe(300);
    expect(LESSONS_REFLECT_VISIBILITY_SECONDS).toBe(1800);
  });
});
