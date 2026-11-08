// Lessons in production, lane 1: the learning pipeline's model runs on the COMPANY's own provider and the company pays. No provider: the call fails and nothing is made. There is no Rovara-paid route.
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_GUARDRAILS, ModelSourceSchema, agentGuardrailsKey, editionPolicy, sourceAlias, type Edition, type ModelIdentifier, type ModelSource } from "../../packages/contracts/src/index.js";
import { ModelSourceStore } from "../../packages/broker/src/model-sources/store.js";
import type { RoutingDependencies } from "../../packages/broker/src/model-sources/routing.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

const admit = vi.hoisted(() => vi.fn(async (...args: unknown[]) => { void args; return { maxBudgetUsd: 1.5 }; }));
vi.mock("../../packages/broker/src/spend/admission.js", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), admitWork: admit }));

import { LEARNING_CALL_BUDGET_USD, customerLearningModel } from "../../packages/broker/src/aws/broker/learning-model.js";
import type { AwsBrokerDependencies } from "../../packages/broker/src/aws/broker/definitions.js";

const SRC_ANTHROPIC = "src_aaaaaaaaaaaaaaaaaaaa";
const SRC_CHATGPT = "personal-chatgpt";
const SONNET = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
const anthropic = (): ModelSource => ModelSourceSchema.parse({ kind: "anthropic", sourceId: SRC_ANTHROPIC, label: "Anthropic", models: [{ catalog: SONNET }] });

function install(options: { forbidden?: ModelIdentifier[]; edition?: Edition; withOp?: boolean; projectOrder?: string[] } = {}) {
  const db = new FakeDynamoDb();
  // The company's forbidden models are read now from its guardrails document.
  if (options.forbidden !== undefined) db.set({ ...agentGuardrailsKey(TEST_ORG), guardrails: { ...DEFAULT_AGENT_GUARDRAILS, forbiddenModels: options.forbidden }, revision: 1 });
  const store = new ModelSourceStore({ documentClient: db, tableName: "state", now: Date.now, chatgptSwitch: async () => true });
  const routing: RoutingDependencies = {
    sources: store, egress: { documentClient: db, tableName: "state" }, launch: { kinds: ["anthropic", "openai", "openrouter", "bedrock", "endpoint"] }, edition: editionPolicy(options.edition ?? "public"),
    forbiddenModels: async () => options.forbidden ?? [],
    ...(options.projectOrder === undefined ? {} : { projectSourceOrder: async () => options.projectOrder }), chatgpt: { serves: async () => "gpt-5.4" },
  };
  const calls: Array<Record<string, unknown>> = [];
  const learningCompletion = vi.fn(async (input: Record<string, unknown>) => { calls.push(input); return { text: "{\"candidates\":[]}", costUsd: 0.02, model: String(input.model) }; });
  const dependencies = {
    documentClient: db, tableName: "state", cloud: true,
    modelAccess: { access: options.withOp === false ? {} : { learningCompletion }, proxyUrl: "http://proxy" },
  } as unknown as AwsBrokerDependencies;
  const model = customerLearningModel(dependencies, { routing: () => routing });
  const request = { purpose: "reflect" as const, system: "sys", user: "usr", maxOutputTokens: 1800, workspaceId: TEST_ORG, project: "web" };
  return { db, store, model, request, calls, learningCompletion, dependencies };
}

describe("the learning model runs on the company's own provider", () => {
  it("routes to the company's source: its alias and transport go to the function, with the org, project, purpose and a capped budget", async () => {
    const t = install();
    await t.store.save({ orgId: TEST_ORG, source: anthropic(), mode: "create", by: "dev-owner" });
    await t.store.setOrder({ orgId: TEST_ORG, order: [SRC_ANTHROPIC], by: "dev-owner" });
    const answer = await t.model.complete(t.request);
    expect(answer).toEqual({ text: "{\"candidates\":[]}", costUsd: 0.02, model: sourceAlias(TEST_ORG, SRC_ANTHROPIC, SONNET) });
    expect(t.calls[0]).toMatchObject({ orgId: TEST_ORG, project: "web", purpose: "reflect", system: "sys", user: "usr", maxOutputTokens: 1800, model: sourceAlias(TEST_ORG, SRC_ANTHROPIC, SONNET), api: "anthropic-messages", maxBudgetUsd: LEARNING_CALL_BUDGET_USD });
    // No member and no ledger-tagged person: the call carries no developer at all.
    expect(Object.keys(t.calls[0]!)).not.toContain("developerId");
  });

  it("the key's cap is never above what the company's budgets have left", async () => {
    const t = install();
    await t.store.save({ orgId: TEST_ORG, source: anthropic(), mode: "create", by: "dev-owner" });
    await t.store.setOrder({ orgId: TEST_ORG, order: [SRC_ANTHROPIC], by: "dev-owner" });
    admit.mockResolvedValueOnce({ maxBudgetUsd: 0.05 });
    await t.model.complete(t.request);
    expect(t.calls[0]!.maxBudgetUsd).toBe(0.05);
    admit.mockResolvedValueOnce({ maxBudgetUsd: 0 });
    await expect(t.model.complete(t.request)).rejects.toThrow();
    expect(t.calls).toHaveLength(1);
  });

  it("a budget refusal from the company's own limits stops the call before any key is made", async () => {
    const t = install();
    await t.store.save({ orgId: TEST_ORG, source: anthropic(), mode: "create", by: "dev-owner" });
    await t.store.setOrder({ orgId: TEST_ORG, order: [SRC_ANTHROPIC], by: "dev-owner" });
    admit.mockRejectedValueOnce(new Error("ORG_BUDGET_EXCEEDED"));
    await expect(t.model.complete(t.request)).rejects.toThrow();
    expect(t.learningCompletion).not.toHaveBeenCalled();
  });

  it("with no usable provider it throws and makes no call: nothing falls back to a Rovara-paid model", async () => {
    const t = install({ projectOrder: [] });
    await t.store.save({ orgId: TEST_ORG, source: anthropic(), mode: "create", by: "dev-owner" });
    await t.store.setOrder({ orgId: TEST_ORG, order: [SRC_ANTHROPIC, "rovara"], by: "dev-owner" });
    await expect(t.model.complete(t.request)).rejects.toThrow();
    expect(t.learningCompletion).not.toHaveBeenCalled();
  });

  it("a person's ChatGPT plan is never the route", async () => {
    const t = install();
    await t.store.setOrder({ orgId: TEST_ORG, order: [SRC_CHATGPT], by: "dev-owner" });
    await expect(t.model.complete(t.request)).rejects.toThrow();
    expect(t.learningCompletion).not.toHaveBeenCalled();
  });

  it("a model the company forbids is never chosen", async () => {
    const t = install({ forbidden: [SONNET] });
    await t.store.save({ orgId: TEST_ORG, source: anthropic(), mode: "create", by: "dev-owner" });
    await t.store.setOrder({ orgId: TEST_ORG, order: [SRC_ANTHROPIC], by: "dev-owner" });
    await expect(t.model.complete(t.request)).rejects.toThrow();
    expect(t.learningCompletion).not.toHaveBeenCalled();
  });

  it("an install without the function's operation, a request without a project and a company that is not one all fail closed", async () => {
    const without = install({ withOp: false });
    await expect(without.model.complete(without.request)).rejects.toThrow();
    const t = install();
    await expect(t.model.complete({ ...t.request, project: undefined as never })).rejects.toThrow();
    await expect(t.model.complete({ ...t.request, workspaceId: "not-an-org" })).rejects.toThrow();
    expect(t.learningCompletion).not.toHaveBeenCalled();
  });

  it("the failure of the function is the caller's failure (the reflector answers model_error)", async () => {
    const t = install();
    await t.store.save({ orgId: TEST_ORG, source: anthropic(), mode: "create", by: "dev-owner" });
    await t.store.setOrder({ orgId: TEST_ORG, order: [SRC_ANTHROPIC], by: "dev-owner" });
    t.learningCompletion.mockRejectedValueOnce(new Error("MODEL_PROXY_UNAVAILABLE"));
    await expect(t.model.complete(t.request)).rejects.toThrow();
  });
});
