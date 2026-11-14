// S3-9: the lighter flow's reviewer ports over the broker's own money and model machinery (cloud/app/tier-review-ports.ts), on a fake table and a fake proxy with the REAL admission, mint and ledger:
// the task's captured payer, a source billed to the company (never a person's plan, never a forbidden model), the payer's budgets (a used-up month refuses), and a key capped at the call's hold,
// reserved on the payer's scopes, used for the one call and blocked after it whatever happened.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_GUARDRAILS, ModelSourceSchema, agentGuardrailsKey, sourceAlias, type ModelIdentifier, type Payer } from "@rovara-code/contracts";
import { editionPolicy, modelKeyKey, spendCounterKey } from "@agentx/cloud-contracts";
import { ModelSourceStore } from "../../packages/broker/src/model-sources/store.js";
import type { RoutingDependencies } from "../../packages/broker/src/model-sources/routing.js";
import { keyIdOf } from "../../packages/broker/src/org/budget.js";
import { cloudTierReviewPorts, TIER_REVIEW_ORIGIN } from "../../packages/broker/src/cloud/app/tier-review-ports.js";
import { taskPayerKey } from "../../packages/broker/src/cloud/app/money.js";
import type { ReviewCompletionInput } from "../../packages/broker/src/model-proxy/access.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { TEST_ORG } from "../support/orgs.js";

const SRC = "src_aaaaaaaaaaaaaaaaaaaa";
const SONNET = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
const HAIKU = { provider: "anthropic", modelId: "claude-haiku-4-5" };
const OTHER_ORG = "org_bbbbbbbbbbbbbbbbbbbb";
const MEMBER = "c".repeat(64);
const MONTH = new Date().toISOString().slice(0, 7);
const ROUTE = { model: SONNET, alias: sourceAlias(TEST_ORG, SRC, SONNET), sourceId: SRC, api: "anthropic-messages" as const };

afterEach(() => { vi.restoreAllMocks(); });

function install(options: { forbidden?: ModelIdentifier[]; models?: ModelIdentifier[]; order?: string[]; withReview?: boolean } = {}) {
  const db = new FakeDynamoDb();
  if (options.forbidden !== undefined) db.set({ ...agentGuardrailsKey(TEST_ORG), guardrails: { ...DEFAULT_AGENT_GUARDRAILS, forbiddenModels: options.forbidden }, revision: 1 });
  const store = new ModelSourceStore({ documentClient: db, tableName: "state", now: Date.now, chatgptSwitch: async () => true });
  const routing: RoutingDependencies = {
    sources: store, egress: { documentClient: db, tableName: "state" }, launch: { kinds: ["anthropic", "openai", "openrouter", "bedrock", "endpoint"] }, edition: editionPolicy("public"),
    forbiddenModels: async () => options.forbidden ?? [], chatgpt: { serves: async () => "gpt-5.4" },
  };
  const proxy = fakeModelAccess();
  proxy.setOrgSpent(TEST_ORG, 0);
  const baseMint = proxy.mintKey.getMockImplementation()!;
  proxy.mintKey.mockImplementation(async (mint) => ({ ...(await baseMint(mint)), expiresAt: Date.now() + mint.ttlSeconds * 1000 }));
  const reviews: ReviewCompletionInput[] = [];
  const reviewCompletion = vi.fn(async (input: ReviewCompletionInput) => { reviews.push(input); return { text: "[]", model: input.model }; });
  const access = Object.assign(proxy, options.withReview === false ? {} : { reviewCompletion });
  const ledger = { documentClient: db, tableName: "state", access, now: Date.now, cloud: true };
  const ports = cloudTierReviewPorts({ companyId: TEST_ORG, documentClient: db, tableName: "state", access, routing, ledger, cloud: true });
  const ready = async () => {
    const source = ModelSourceSchema.parse({ kind: "anthropic", sourceId: SRC, label: "Anthropic", models: (options.models ?? [SONNET]).map((catalog) => ({ catalog })) });
    await store.save({ orgId: TEST_ORG, source, mode: "create", by: "dev-owner" });
    await store.setOrder({ orgId: TEST_ORG, order: options.order ?? [SRC], by: "dev-owner" });
  };
  const payerRow = (taskId: string, payer: Payer, orgId: string = TEST_ORG) => db.set({ ...taskPayerKey(taskId), entityType: "TASK_PAYER", orgId, taskId, payer, project: "web", origin: "app", settingsRevision: 0 });
  const limitProject = (limitUsd: number) => db.set({ pk: `ORG#${TEST_ORG}#PROJECT_AI#web`, sk: "SETTINGS", entityType: "PROJECT_AI", projectPays: false, monthlyBudgetUsd: limitUsd, revision: 1 });
  const counter = (sk: string) => db.get(spendCounterKey(TEST_ORG, MONTH, sk)) as { committedUsd?: number } | undefined;
  return { db, proxy, ports, reviews, reviewCompletion, ready, payerRow, limitProject, counter };
}

const call = (overrides: Record<string, unknown> = {}) => ({
  taskId: "task-1", project: "web", payer: { kind: "member", developerId: MEMBER } as Payer, route: ROUTE, holdUsd: 0.2, prompt: "the whole prompt", purpose: "questions" as const, signal: new AbortController().signal, ...overrides,
});

describe("task: the payer the core task's start captured, for this company only", () => {
  it("answers the captured payer and project; another company's row, or none, is no payer", async () => {
    const t = install();
    t.payerRow("task-1", { kind: "member", developerId: MEMBER });
    t.payerRow("task-2", { kind: "project", project: "web" }, OTHER_ORG);
    expect(await t.ports.task("task-1")).toEqual({ project: "web", payer: { kind: "member", developerId: MEMBER } });
    expect(await t.ports.task("task-2")).toBeUndefined();
    expect(await t.ports.task("task-none")).toBeUndefined();
  });
});

describe("route: a source billed to the company, never a person's plan, never a forbidden model", () => {
  it("routes the model Code's checking rule chose through the company's own source", async () => {
    const t = install();
    await t.ready();
    expect(await t.ports.route({ project: "web", model: SONNET })).toEqual(ROUTE);
  });

  it("a forbidden model, a model no company source serves, or only a person's ChatGPT plan: no route", async () => {
    const forbidden = install({ forbidden: [SONNET] });
    await forbidden.ready();
    expect(await forbidden.ports.route({ project: "web", model: SONNET })).toBeUndefined();
    const unserved = install();
    await unserved.ready();
    expect(await unserved.ports.route({ project: "web", model: { provider: "openai", modelId: "gpt-5.4" } })).toBeUndefined();
    const plan = install({ order: ["personal-chatgpt"] });
    await plan.ready();
    expect(await plan.ports.route({ project: "web", model: undefined })).toBeUndefined();
    expect(await plan.ports.route({ project: "web", model: { provider: "openai", modelId: "gpt-5.4" } })).toBeUndefined();
  });

  it("no model chosen: the company's strongest listed model it can call (the dearest), never a forbidden one", async () => {
    const t = install({ models: [HAIKU, SONNET] });
    await t.ready();
    expect((await t.ports.route({ project: "web", model: undefined }))?.model).toEqual(SONNET);
    const without = install({ models: [HAIKU, SONNET], forbidden: [SONNET] });
    await without.ready();
    expect((await without.ports.route({ project: "web", model: undefined }))?.model).toEqual(HAIKU);
  });
});

describe("room: the payer's budgets, as a chat turn of the project", () => {
  it("answers the room; a project month that is used up refuses with the project's code", async () => {
    const t = install();
    await t.ready();
    expect(await t.ports.room({ project: "web", payer: { kind: "project", project: "web" } })).toBeGreaterThan(0);
    // The room is the smallest scope's room: a project month of $1 with $0.70 taken leaves $0.30, which is what bounds the call's hold.
    t.limitProject(1);
    t.db.set({ ...spendCounterKey(TEST_ORG, MONTH, "PROJECT#web"), entityType: "SPEND_COUNTER", spentUsd: 0.7, committedUsd: 0.7 });
    expect(await t.ports.room({ project: "web", payer: { kind: "project", project: "web" } })).toBeCloseTo(0.3, 6);
    t.db.set({ ...spendCounterKey(TEST_ORG, MONTH, "PROJECT#web"), entityType: "SPEND_COUNTER", spentUsd: 1, committedUsd: 1 });
    await expect(t.ports.room({ project: "web", payer: { kind: "project", project: "web" } })).rejects.toMatchObject({ code: "PROJECT_BUDGET_EXCEEDED" });
  });
});

describe("call: one key for the task's payer, capped at the hold, reserved, used once, blocked after", () => {
  it("mints a key for the member payer, scoped to the one alias, tagged with the task and the reviewer origin, reserved on the payer's scopes; the call carries the key and the prompt only; the key is blocked", async () => {
    const t = install();
    await t.ready();
    expect(await t.ports.call(call())).toBe("[]");
    expect(t.proxy.mintKey).toHaveBeenCalledTimes(1);
    const minted = t.proxy.mintKey.mock.calls[0]![0];
    expect(minted).toMatchObject({ orgId: TEST_ORG, developerId: MEMBER, models: [ROUTE.alias], maxBudgetUsd: 0.2, ttlSeconds: 300 });
    expect(minted.tags).toMatchObject({ taskId: "task-1", payerKind: "member", payerId: MEMBER, project: "web", source: SRC, origin: TIER_REVIEW_ORIGIN });
    expect(t.reviews).toHaveLength(1);
    expect(t.reviews[0]).toMatchObject({ key: t.proxy.mintedKeys()[0], purpose: "questions", user: "the whole prompt", model: ROUTE.alias, api: "anthropic-messages" });
    // Reserved on the company's, the project's and the member's month (the scopes every spend of the task counts against), and blocked after the call so the sweep settles it.
    const keyId = keyIdOf(t.proxy.mintedKeys()[0]!);
    const record = t.db.get(modelKeyKey(TEST_ORG, keyId)) as { capUsd: number; finalizeAfter?: number };
    expect(record.capUsd).toBe(0.2);
    expect(record.finalizeAfter).toBeTypeOf("number");
    for (const scope of ["ORG", "PROJECT#web", `MEMBER#${MEMBER}`]) expect(t.counter(scope)?.committedUsd ?? 0).toBeGreaterThan(0);
  });

  it("the call fails: the key is blocked all the same (its cap stays held until the sweep settles it, never charged at $0)", async () => {
    const t = install();
    await t.ready();
    t.reviewCompletion.mockRejectedValueOnce(new Error("provider down"));
    await expect(t.ports.call(call())).rejects.toThrow("provider down");
    const record = t.db.get(modelKeyKey(TEST_ORG, keyIdOf(t.proxy.mintedKeys()[0]!))) as { finalizeAfter?: number };
    expect(record.finalizeAfter).toBeTypeOf("number");
  });

  it("a full scope (the project's month cannot take the hold) refuses at the mint: no call is made", async () => {
    const t = install();
    await t.ready();
    t.limitProject(1);
    t.db.set({ ...spendCounterKey(TEST_ORG, MONTH, "PROJECT#web"), entityType: "SPEND_COUNTER", spentUsd: 0.9, committedUsd: 0.9 });
    await expect(t.ports.call(call({ payer: { kind: "project", project: "web" } }))).rejects.toThrow();
    expect(t.reviews).toEqual([]);
  });

  it("a model access with no reviewer call refuses before any key is minted", async () => {
    const t = install({ withReview: false });
    await t.ready();
    await expect(t.ports.call(call())).rejects.toThrow(/no reviewer calls/u);
    expect(t.proxy.mintKey).not.toHaveBeenCalled();
  });

  it("an aborted signal after the mint: no call, and the key is blocked", async () => {
    const t = install();
    await t.ready();
    const controller = new AbortController();
    controller.abort();
    await expect(t.ports.call(call({ signal: controller.signal }))).rejects.toThrow(/time ran out/u);
    expect(t.reviews).toEqual([]);
  });
});
