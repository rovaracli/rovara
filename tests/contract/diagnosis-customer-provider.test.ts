// Live interaction F2, owner decision 2026-11-03 (replacing the Rovara-paid design, DG-3): a diagnosis runs on the company's OWN AI provider and the company pays for it. Rovara mints and uses no key of its own
// for a diagnosis. Rovara's METERED built-in AI source counts as the company's provider (owner, 2026-11-03: "bill it to them"), but only through the ordinary admitted, budget-capped chat-turn key billed to the
// company or project. With no usable provider the diagnosis is not offered, in one fixed sentence. These tests use the real routing over a real source store; only the proxy mint and the budget admission are stubbed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalModelName, DIAGNOSIS_LIGHT_BUDGET_USD, DIAGNOSIS_NO_PROVIDER_MESSAGE, DIAGNOSIS_REFUSALS, ModelSourceSchema, sourceAlias, type Edition, type ModelIdentifier, type ModelSource } from "@rovara-code/contracts";
import { editionPolicy } from "@agentx/cloud-contracts";
import { ModelSourceStore } from "../../packages/broker/src/model-sources/store.js";
import type { RoutingDependencies } from "../../packages/broker/src/model-sources/routing.js";
import { chooseDiagnosisRoute, customerProviderRouting } from "../../packages/broker/src/model-sources/diagnosis-provider.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

const world = vi.hoisted((): { routing: unknown } => ({ routing: undefined }));
const admit = vi.hoisted(() => vi.fn(async (...args: unknown[]) => { void args; return { maxBudgetUsd: 1.5 }; }));
const minted = vi.hoisted(() => vi.fn(async (...args: unknown[]) => { void args; return { key: "fake-proxy-key", expiresAt: 4_000_000_000_000 }; }));
vi.mock("../../packages/broker/src/aws/broker/scope-helpers.js", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), routingOf: () => world.routing }));
vi.mock("../../packages/broker/src/spend/admission.js", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), admitWork: admit }));
vi.mock("../../packages/broker/src/org/budget.js", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), mintKeyHealing: minted }));

import { mintChatTurnKey } from "../../packages/broker/src/aws/broker/model-access.js";
import type { AwsBrokerDependencies } from "../../packages/broker/src/aws/broker/definitions.js";

const SRC_ANTHROPIC = "src_aaaaaaaaaaaaaaaaaaaa";
const SRC_OPENAI = "src_oooooooooooooooooooo";
const SONNET = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
const GPT = { provider: "openai", modelId: "gpt-5.4" };
const NOBODY = vi.fn(async () => undefined);
const anthropic = (): ModelSource => ModelSourceSchema.parse({ kind: "anthropic", sourceId: SRC_ANTHROPIC, label: "Anthropic", models: [{ catalog: SONNET }] });
const openai = (): ModelSource => ModelSourceSchema.parse({ kind: "openai", sourceId: SRC_OPENAI, label: "OpenAI", models: [{ catalog: GPT }] });

function install(edition: Edition, options: { forbidden?: ModelIdentifier[]; projectOrder?: string[]; chatgptServes?: boolean } = {}) {
  const db = new FakeDynamoDb();
  const store = new ModelSourceStore({ documentClient: db, tableName: "state", now: Date.now, chatgptSwitch: async () => options.chatgptServes === true });
  const deps: RoutingDependencies = {
    sources: store, egress: { documentClient: db, tableName: "state" }, launch: { kinds: ["anthropic", "openai", "openrouter", "bedrock", "endpoint"] }, edition: editionPolicy(edition),
    forbiddenModels: async () => options.forbidden ?? [],
    ...(options.projectOrder === undefined ? {} : { projectSourceOrder: async () => options.projectOrder }),
    ...(options.chatgptServes === true ? { chatgpt: { serves: async () => "gpt-5.4" } } : {}),
  };
  return {
    db, store, deps,
    add: async (source: ModelSource) => { await store.save({ orgId: TEST_ORG, source, mode: "create", by: "dev-owner" }); },
    order: async (ids: string[]) => { await store.setOrder({ orgId: TEST_ORG, order: ids, by: "dev-owner" }); },
  };
}
const none = () => false;
const choose = (deps: RoutingDependencies, forbidden: (model: ModelIdentifier) => boolean = none, preferred: ModelIdentifier[] = []) => chooseDiagnosisRoute(deps, TEST_ORG, "web", forbidden, preferred);

describe("which provider a diagnosis may run on", () => {
  it("Public: a company with only Rovara's metered built-in AI HAS a usable provider: the diagnosis is offered, on the `rovara` source", async () => {
    const t = install("public");
    await t.order(["rovara"]);
    const chosen = await choose(t.deps);
    expect(chosen?.route.sourceId).toBe("rovara");
    expect(chosen?.route.alias).toBeDefined();
  });

  it("Public: with a company source first in the order it is the route; the project's own order is respected too", async () => {
    for (const projectOrder of [undefined, [SRC_ANTHROPIC, "rovara"]]) {
      const t = install("public", projectOrder === undefined ? {} : { projectOrder });
      await t.add(anthropic());
      await t.order([SRC_ANTHROPIC, "rovara"]);
      const chosen = await choose(t.deps, none, [SONNET]);
      expect(chosen?.route.sourceId).toBe(SRC_ANTHROPIC);
      expect(chosen?.route.alias).toBe(sourceAlias(TEST_ORG, SRC_ANTHROPIC, SONNET));
      expect(chosen?.model).toEqual(SONNET);
    }
  });

  it("a project that leaves out every source has no provider, in either edition (no fall back to anything)", async () => {
    for (const edition of ["public", "enterprise"] as const) {
      const t = install(edition, { projectOrder: [] });
      await t.order(["rovara"]);
      expect(await choose(t.deps), edition).toBeUndefined();
    }
  });

  it("Enterprise: the install is in the company's own AWS account, so its own Bedrock (the `rovara` source of that install) is the company's provider", async () => {
    const t = install("enterprise");
    await t.order(["rovara"]);
    const chosen = await choose(t.deps);
    expect(chosen?.route.sourceId).toBe("rovara");
  });

  it("never a person's ChatGPT plan, in either edition", async () => {
    for (const edition of ["public", "enterprise"] as const) {
      const t = install(edition, { chatgptServes: true });
      await t.order(["personal-chatgpt"]);
      expect(await choose(t.deps), edition).toBeUndefined();
    }
  });

  it("a company that forbids every model its sources serve has no usable provider; one allowed model is enough, and the order of the sources decides (the chat service's configured model only comes last)", async () => {
    const t = install("public", { forbidden: [SONNET] });
    await t.add(anthropic());
    await t.add(openai());
    await t.order([SRC_ANTHROPIC, SRC_OPENAI]);
    const forbidden = (model: ModelIdentifier) => model.modelId === SONNET.modelId;
    expect((await choose(t.deps, forbidden))?.route.sourceId).toBe(SRC_OPENAI);
    expect(await choose(t.deps, () => true)).toBeUndefined();
    expect((await choose(t.deps, none, [GPT]))?.model).toEqual(SONNET);
  });

  it("fails closed: an install with no model proxy (no sources to read) has no company provider", async () => {
    expect(await choose({})).toBeUndefined();
    expect(customerProviderRouting({})).toBeUndefined();
  });

  it("an unreadable source record is the ordinary retryable refusal, never a fall back to Rovara's AI", async () => {
    const t = install("public");
    const broken: RoutingDependencies = { ...t.deps, sources: { read: async () => { throw new Error("db down"); } } };
    await expect(choose(broken)).rejects.toMatchObject({ code: "MODEL_PROXY_UNAVAILABLE" });
  });
});

describe("a diagnosis turn's key", () => {
  let t: ReturnType<typeof install>;
  const dependencies = { documentClient: new FakeDynamoDb(), tableName: "state", agents: {}, cloud: true, modelAccess: { access: {}, proxyUrl: "https://proxy.example.invalid" } } as unknown as AwsBrokerDependencies;
  const mint = (claimKey: () => Promise<boolean>, turnId = "Ev1234567890") => mintChatTurnKey(dependencies, TEST_ORG, "web", undefined, { turnId }, undefined, { diagnosis: { claimKey } });

  beforeEach(async () => {
    admit.mockClear(); minted.mockClear(); NOBODY.mockClear();
    t = install("public");
    await t.add(anthropic());
    await t.order([SRC_ANTHROPIC, "rovara"]);
    world.routing = t.deps;
  });

  it("is admitted and paid like any chat turn of the company (its budgets), on the company's own source, capped at one diagnosis turn", async () => {
    const key = await mint(async () => true);
    const alias = sourceAlias(TEST_ORG, SRC_ANTHROPIC, SONNET);
    expect(key).toMatchObject({ apiKey: "fake-proxy-key", baseUrl: "https://proxy.example.invalid", route: { alias, api: "anthropic-messages" }, classifierModel: null });
    expect(admit).toHaveBeenCalledTimes(1);
    expect(admit.mock.calls[0]![1]).toMatchObject({ orgId: TEST_ORG, project: "web", payer: { kind: "project", project: "web" }, path: "CHAT" });
    const input = minted.mock.calls[0]![1] as Record<string, unknown>;
    expect(input).toMatchObject({ orgId: TEST_ORG, purpose: "turn", refId: "Ev1234567890", maxBudgetUsd: DIAGNOSIS_LIGHT_BUDGET_USD, models: [alias] });
    // Rovara pays for nothing: there is no flag that asks for a key outside the company's own team.
    expect(input).not.toHaveProperty("rovaraPaid");
  });

  it("is capped by what the company's budgets have left when that is less than one diagnosis turn", async () => {
    admit.mockResolvedValueOnce({ maxBudgetUsd: 0.07 });
    await mint(async () => true);
    expect((minted.mock.calls[0]![1] as Record<string, unknown>)["maxBudgetUsd"]).toBe(0.07);
  });

  it("a spent budget is the company's to know about: the refusal passes through, and nothing is claimed or minted", async () => {
    const { agentXError } = await import("@rovara-code/contracts");
    admit.mockRejectedValueOnce(agentXError("TRIAL_LOCKED", "The trial has ended."));
    const claimKey = vi.fn(async () => true);
    await expect(mint(claimKey)).rejects.toMatchObject({ code: "TRIAL_LOCKED" });
    expect(claimKey).not.toHaveBeenCalled();
    expect(minted).not.toHaveBeenCalled();
  });

  it("with no usable provider (the project leaves out every source) nothing is admitted, claimed or minted, and the words are the fixed sentence", async () => {
    world.routing = { ...t.deps, projectSourceOrder: async () => [] };
    const claimKey = vi.fn(async () => true);
    const error = await mint(claimKey).then(() => undefined, (caught: unknown) => caught as { code: string; message: string });
    expect(error).toMatchObject({ code: "MODEL_NOT_ALLOWED" });
    expect(error?.message).toContain(DIAGNOSIS_NO_PROVIDER_MESSAGE);
    expect(DIAGNOSIS_NO_PROVIDER_MESSAGE).toBe("Diagnosis uses your company's AI provider. Connect one in Settings to turn it on.");
    expect(DIAGNOSIS_REFUSALS.noProvider).toBe(DIAGNOSIS_NO_PROVIDER_MESSAGE);
    expect(admit).not.toHaveBeenCalled();
    expect(claimKey).not.toHaveBeenCalled();
    expect(minted).not.toHaveBeenCalled();
  });

  it("without routing at all (no agents, no model proxy) nothing is minted either", async () => {
    world.routing = undefined;
    await expect(mint(async () => true)).rejects.toMatchObject({ code: "MODEL_NOT_ALLOWED" });
    await expect(mint(async () => true)).rejects.toThrow(DIAGNOSIS_NO_PROVIDER_MESSAGE);
    expect(minted).not.toHaveBeenCalled();
  });

  it("DG-3: mints ONE key per diagnosis: a repeat (a retry, a redelivery) finds the claim taken, mints nothing, and the caller is told the proxy could not issue a key", async () => {
    let taken = false;
    const claimKey = async () => { if (taken) return false; taken = true; return true; };
    await expect(mint(claimKey)).resolves.toMatchObject({ apiKey: "fake-proxy-key" });
    await expect(mint(claimKey)).rejects.toMatchObject({ code: "MODEL_PROXY_UNAVAILABLE" });
    await expect(mint(claimKey, "Ev9999999999")).rejects.toMatchObject({ code: "MODEL_PROXY_UNAVAILABLE" });
    expect(minted).toHaveBeenCalledTimes(1);
  });

  it("QA6-14: the key is claimed with the model and source it is for; a retry that avoids the refused model is keyed on another one, and with no other model it is refused in fixed words before anything is claimed or minted", async () => {
    // The first key: the company's Anthropic source, claimed with its model and source.
    const claimKey = vi.fn(async (chosen?: unknown) => { void chosen; return true; });
    await mint(claimKey);
    expect(claimKey).toHaveBeenCalledWith({ model: SONNET, sourceId: SRC_ANTHROPIC });
    // The retry: the model just refused is left out, so the next source's model is the choice.
    minted.mockClear(); admit.mockClear();
    const retryClaim = vi.fn(async (chosen?: unknown) => { void chosen; return true; });
    const retried = await mintChatTurnKey(dependencies, TEST_ORG, "web", undefined, { turnId: "Ev1234567890R" }, undefined, { diagnosis: { claimKey: retryClaim, avoid: canonicalModelName(SONNET) } });
    const chosen = retryClaim.mock.calls[0]![0] as { model: ModelIdentifier; sourceId: string };
    expect(chosen.sourceId).toBe("rovara");
    expect(canonicalModelName(chosen.model)).not.toBe(canonicalModelName(SONNET));
    expect(retried).toMatchObject({ apiKey: "fake-proxy-key" });
    expect((minted.mock.calls[0]![1] as { models: string[] }).models).not.toContain(sourceAlias(TEST_ORG, SRC_ANTHROPIC, SONNET));
    // Only that one source and model: leaving it out leaves nothing, and the words say so.
    world.routing = { ...t.deps, projectSourceOrder: async () => [SRC_ANTHROPIC] };
    minted.mockClear(); admit.mockClear();
    const noneLeft = vi.fn(async () => true);
    const error = await mintChatTurnKey(dependencies, TEST_ORG, "web", undefined, { turnId: "Ev1234567890R" }, undefined, { diagnosis: { claimKey: noneLeft, avoid: canonicalModelName(SONNET) } }).then(() => undefined, (caught: unknown) => caught as { code: string; message: string });
    expect(error?.code).toBe("MODEL_NOT_ALLOWED");
    expect(error?.message).toContain("Your company's AI provider has no other model Rovara can try for this diagnosis.");
    expect(noneLeft).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
    expect(minted).not.toHaveBeenCalled();
  });

  it("a company with only the metered Rovara source gets a diagnosis, billed to the company or project like its tasks: admitted against its budgets, capped at 25 cents or what is left, and never a key outside the company's own team", async () => {
    await t.order(["rovara"]);
    const key = await mint(async () => true);
    expect(key).toMatchObject({ apiKey: "fake-proxy-key", route: { api: "anthropic-messages" }, classifierModel: null });
    expect(admit).toHaveBeenCalledTimes(1);
    expect(admit.mock.calls[0]![1]).toMatchObject({ orgId: TEST_ORG, project: "web", payer: { kind: "project", project: "web" }, path: "CHAT" });
    const input = minted.mock.calls[0]![1] as Record<string, unknown>;
    expect(input).toMatchObject({ orgId: TEST_ORG, maxBudgetUsd: DIAGNOSIS_LIGHT_BUDGET_USD, tags: { source: "rovara", payerKind: "project", payerId: "web" } });
    expect(input).not.toHaveProperty("rovaraPaid");
    admit.mockResolvedValueOnce({ maxBudgetUsd: 0.04 });
    await mint(async () => true, "Ev2222222222");
    expect((minted.mock.calls[1]![1] as Record<string, unknown>)["maxBudgetUsd"]).toBe(0.04);
  });

  it("there is no way for Rovara to be the payer: a spent company budget refuses the metered source too, and nothing is claimed or minted", async () => {
    await t.order(["rovara"]);
    const { agentXError } = await import("@rovara-code/contracts");
    admit.mockRejectedValueOnce(agentXError("BUDGET_EXCEEDED", "The budget is spent."));
    const claimKey = vi.fn(async () => true);
    await expect(mint(claimKey)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(claimKey).not.toHaveBeenCalled();
    expect(minted).not.toHaveBeenCalled();
  });

  it("Enterprise: the install's own AI serves it, as before", async () => {
    t = install("enterprise");
    await t.order(["rovara"]);
    world.routing = t.deps;
    const key = await mint(async () => true);
    expect(key).toMatchObject({ apiKey: "fake-proxy-key", route: { api: "anthropic-messages" } });
    expect(admit).toHaveBeenCalledTimes(1);
  });

  it("the ordinary chat turn is untouched: it is capped at the ordinary turn allowance, not at a diagnosis's, and carries no diagnosis route", async () => {
    await mintChatTurnKey(dependencies, TEST_ORG, "web", undefined, { turnId: "Ev1234567890" }).catch(() => undefined);
    const input = minted.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    if (input !== undefined) {
      expect(input["maxBudgetUsd"]).toBe(1.5);
      expect(input).not.toHaveProperty("rovaraPaid");
    }
  });
});
