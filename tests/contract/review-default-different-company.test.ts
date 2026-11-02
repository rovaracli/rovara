// Owner decision 2026-11-02 (option A): the review steps (plan check, code review, security review) that nobody has set default to the strongest usable model of a different company than the step they check.
// One test per rule; each is mutation-checked (see the lane report).
import { describe, expect, it } from "vitest";
import { resolveStageModel, type StageModelInput } from "../../packages/broker/src/model-selection/resolver.js";
import { reviewDefaultExtras, STAGE_POOL_MAX } from "../../packages/broker/src/model-selection/review-default-pool.js";
import { reviewNoOtherCompanyLine } from "../../packages/broker/src/rovara-code/review-model-lines.js";
import { EffectiveStageModelSchema } from "../../packages/contracts/src/stage-models.js";

const sonnet = { provider: "anthropic", modelId: "claude-sonnet-4" };
const opus = { provider: "anthropic", modelId: "claude-opus-4" };
const gpt = { provider: "openai", modelId: "gpt-5" };
const gemini = { provider: "google", modelId: "gemini-2.5-pro" };
const REVIEWS = ["code_review", "security_review", "plan_check"] as const;
const row = (model: { provider: string; modelId: string }, sourceId = "rovara") => ({ model, sourceId, enabled: true, inEffectiveOrder: true, evidence: { orgId: "org_a", sourcesRevision: 2, kind: "rovara_catalog" as const } });
const input = (stage: (typeof REVIEWS)[number], models = [sonnet, opus, gpt, gemini], more: Partial<StageModelInput> = {}): StageModelInput => ({
  orgId: "org_a", stage, sourcesRevision: 2, candidates: models.map((model) => row(model)), forbidden: [], builtinDefault: sonnet, referenceModel: sonnet, allowLegacyDefaultFallback: true, ...more,
});

describe("rule 1: a review nobody has set defaults to the strongest usable model of a different company", () => {
  for (const stage of REVIEWS) {
    it(`${stage}: picks the strongest other-company model by the existing ranking, not the stronger same-company one`, () => {
      // opus (same company as the builder) outranks gpt-5 and gemini in the ranking, but it is not another company's.
      expect(resolveStageModel(input(stage))).toMatchObject({ kind: "resolved", model: gpt, reason: "DEFAULT_DIFFERENT_COMPANY" });
      expect(resolveStageModel(input(stage))).not.toHaveProperty("noOtherCompany");
    });
  }
  it("takes the next company's model when the strongest is not usable (denied by an earlier try)", () => {
    expect(resolveStageModel(input("code_review", undefined, { deniedModels: [gpt] }))).toMatchObject({ kind: "resolved", model: gemini, reason: "DEFAULT_DIFFERENT_COMPANY" });
  });
  it("keeps the last-attempt rule: after the allowed tries the builder's own model still reviews, with its visible fallback", () => {
    expect(resolveStageModel(input("code_review", undefined, { defaultLastAttempt: true }))).toMatchObject({ kind: "resolved", model: sonnet, fallback: { reasonCode: "DEFAULT_MODEL_UNAVAILABLE" }, noOtherCompany: true });
  });
  it("a build step is untouched (the default is for steps that check another step)", () => {
    expect(resolveStageModel({ ...input("code_review"), stage: "build", referenceModel: undefined })).toMatchObject({ kind: "resolved", reason: "BUILTIN_DEFAULT" });
  });
});

describe("rule 2: no other company's model is usable, so today's behaviour stands and says so", () => {
  for (const stage of REVIEWS) {
    it(`${stage}: the same company's other model, marked noOtherCompany, never a refusal`, () => {
      const result = resolveStageModel(input(stage, [sonnet, opus]));
      expect(result).toMatchObject({ kind: "resolved", model: opus, reason: "BUILTIN_DEFAULT", noOtherCompany: true });
    });
  }
  it("only the builder's own model is usable: the old same-model fallback, marked and with its fallback record", () => {
    expect(resolveStageModel(input("code_review", [sonnet]))).toMatchObject({ kind: "resolved", model: sonnet, noOtherCompany: true, fallback: { reasonCode: "DEFAULT_MODEL_UNAVAILABLE" } });
  });
  it("an unrecognised company is never claimed to be the same company", () => {
    const strange = { provider: "acme", modelId: "mystery-1" };
    expect(resolveStageModel(input("code_review", [sonnet, strange]))).toMatchObject({ kind: "resolved", model: strange });
    expect(resolveStageModel(input("code_review", [sonnet, strange]))).not.toHaveProperty("noOtherCompany");
  });
  it("two unrecognised companies are never claimed to be the same company either", () => {
    const first = { provider: "acme", modelId: "mystery-0" }, second = { provider: "acme", modelId: "mystery-1" };
    const result = resolveStageModel(input("code_review", [first, second], { referenceModel: first }));
    expect(result).toMatchObject({ kind: "resolved", model: second });
    expect(result).not.toHaveProperty("noOtherCompany");
  });
  it("the sentence is the fixed one, and the contract carries the flag to the page", () => {
    expect(reviewNoOtherCompanyLine(opus)).toBe("Review uses anthropic/claude-opus-4 (same company as the builder: no other company's model is available)");
    const shape = { model: opus, sourceId: "rovara", thinkingLevel: null, decidedBy: "rovara", locked: false, reason: "BUILTIN_DEFAULT", noOtherCompany: true };
    expect(EffectiveStageModelSchema.safeParse(shape).success).toBe(true);
    expect(EffectiveStageModelSchema.safeParse({ ...shape, noOtherCompany: false }).success).toBe(false);
    expect(EffectiveStageModelSchema.safeParse({ ...shape, reason: "DEFAULT_DIFFERENT_COMPANY" }).success).toBe(true);
  });
});

describe("rule 4: explicit choices, forbidden models and approved lists", () => {
  it("never overrides a company lock, a project choice, a company default or a recipe default", () => {
    const sameCompany = { model: opus };
    expect(resolveStageModel(input("code_review", undefined, { companyLock: { model: opus, thinkingLevel: null } }))).toMatchObject({ model: opus, reason: "COMPANY_LOCK", locked: true });
    expect(resolveStageModel(input("code_review", undefined, { projectChoice: sameCompany }))).toMatchObject({ model: opus, reason: "PROJECT_CHOICE" });
    expect(resolveStageModel(input("code_review", undefined, { companyDefault: sameCompany }))).toMatchObject({ model: opus, reason: "COMPANY_DEFAULT" });
    expect(resolveStageModel(input("code_review", undefined, { companyDefault: sameCompany, companyDefaultOrigin: "recipe" }))).toMatchObject({ model: opus, reason: "RECIPE_DEFAULT" });
    for (const result of [resolveStageModel(input("code_review", undefined, { projectChoice: sameCompany })), resolveStageModel(input("code_review", undefined, { companyDefault: sameCompany }))]) expect(result).not.toHaveProperty("noOtherCompany");
  });
  it("an explicit different-model rule (the way back to today's behaviour) keeps picking by model, not by company", () => {
    const explicitModelLevel = { differentFrom: { stage: "build" as const, level: "model" as const } };
    expect(resolveStageModel(input("code_review", undefined, { projectChoice: explicitModelLevel }))).toMatchObject({ kind: "resolved", model: opus, reason: "BUILTIN_DEFAULT" });
    expect(resolveStageModel(input("code_review", undefined, { companyDefault: explicitModelLevel }))).toMatchObject({ kind: "resolved", model: opus });
  });
  it("an explicit vendor rule or the company guardrail still refuses instead of falling back", () => {
    const vendor = { differentFrom: { stage: "build" as const, level: "vendor" as const } };
    expect(resolveStageModel(input("code_review", [sonnet, opus], { projectChoice: vendor }))).toEqual({ kind: "refusal", code: "DIFFERENT_FROM_UNSATISFIABLE" });
    expect(resolveStageModel(input("code_review", [sonnet, opus], { requireDifferentVendor: true }))).toEqual({ kind: "refusal", code: "DIFFERENT_FROM_UNSATISFIABLE" });
  });
  it("the company guardrail is a rule, not the default: its pick keeps the ordinary reason", () => {
    expect(resolveStageModel(input("code_review", undefined, { requireDifferentVendor: true }))).toMatchObject({ kind: "resolved", model: gpt, reason: "BUILTIN_DEFAULT" });
  });
  it("a forbidden other-company model is never the default; the next company's, then the same company's, is", () => {
    expect(resolveStageModel(input("code_review", undefined, { forbidden: [gpt] }))).toMatchObject({ model: gemini, reason: "DEFAULT_DIFFERENT_COMPANY" });
    expect(resolveStageModel(input("code_review", undefined, { forbidden: [gpt, gemini] }))).toMatchObject({ model: opus, noOtherCompany: true });
  });
  it("the project's approved list limits the default to approved models", () => {
    expect(resolveStageModel(input("code_review", undefined, { approved: [sonnet, opus, gemini] }))).toMatchObject({ model: gemini, reason: "DEFAULT_DIFFERENT_COMPANY" });
    expect(resolveStageModel(input("code_review", undefined, { approved: [sonnet, opus] }))).toMatchObject({ model: opus, noOtherCompany: true });
  });
  it("a model without source evidence is not usable, so it is never the default", () => {
    const unverified = input("code_review");
    unverified.candidates = unverified.candidates.map((candidate) => (candidate.model.modelId === "gpt-5" ? { ...candidate, evidence: undefined } : candidate));
    expect(resolveStageModel(unverified)).toMatchObject({ model: gemini });
  });
});

describe("rule 5: the models the company can use reach the stage pool, within its limit", () => {
  const ids = (list: ReadonlyArray<{ provider: string; modelId: string }>) => list.map((model) => `${model.provider}/${model.modelId}`);
  it("adds the strongest few of each company, strongest first, and nothing forbidden or unapproved", () => {
    const servable = [sonnet, opus, gpt, gemini, { provider: "openai", modelId: "gpt-5-mini" }];
    expect(ids(reviewDefaultExtras({ servable, approved: undefined, forbidden: [], have: new Set() }))).toEqual(["anthropic/claude-opus-4", "openai/gpt-5", "google/gemini-2.5-pro", "anthropic/claude-sonnet-4", "openai/gpt-5-mini"]);
    expect(ids(reviewDefaultExtras({ servable, approved: undefined, forbidden: [gpt], have: new Set() }))).not.toContain("openai/gpt-5");
    expect(ids(reviewDefaultExtras({ servable, approved: [sonnet, gemini], forbidden: [], have: new Set() }))).toEqual(["google/gemini-2.5-pro", "anthropic/claude-sonnet-4"]);
  });
  it("never grows the pool past its limit, and keeps every company's strongest when room is short", () => {
    const servable = [opus, sonnet, gpt, gemini];
    const have = new Set(Array.from({ length: STAGE_POOL_MAX - 2 }, (_, index) => `p\0m${String(index)}`));
    expect(ids(reviewDefaultExtras({ servable, approved: undefined, forbidden: [], have }))).toEqual(["anthropic/claude-opus-4", "openai/gpt-5"]);
    expect(reviewDefaultExtras({ servable, approved: undefined, forbidden: [], have: new Set(Array.from({ length: STAGE_POOL_MAX }, (_, index) => `p\0m${String(index)}`)) })).toEqual([]);
  });
  it("does not re-add a model the pool already holds", () => {
    expect(ids(reviewDefaultExtras({ servable: [gpt], approved: undefined, forbidden: [], have: new Set([`${gpt.provider}\0${gpt.modelId}`]) }))).toEqual([]);
  });
});

// ---- the live paths: the pool the stage candidates are read for, and the pinned task stage ----
import { loadPinnedTaskStage } from "../../packages/broker/src/model-selection/task-live.js";
import { prepareTaskModelPolicyPin } from "../../packages/broker/src/model-selection/task-pin.js";
import { createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { agentGuardrailsKey, builtinRecipe, DEFAULT_AGENT_GUARDRAILS, recipeDigest } from "../../packages/contracts/src/index.js";

const OPENAI = "src_bbbbbbbbbbbbbbbbbbbb";
const claudeSonnet = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-5" };
const openaiRouting = (models = [{ provider: "openai", modelId: "gpt-5" }]) => ({
  sources: { read: async () => ({ sources: [{ sourceId: OPENAI, kind: "openai" as const, label: "Fixture OpenAI", models: models.map((catalog) => ({ catalog })) }], order: ["rovara", OPENAI], credentials: [OPENAI], removing: [], revision: 1 }) },
  launch: { kinds: ["openai" as const, "anthropic" as const] },
});
async function liveFixture() {
  const h = await createDeveloperTaskBroker(), recipe = builtinRecipe("rovara-code", 1), digest = recipeDigest(recipe);
  const deps = { documentClient: h.db, tableName: "state", routing: {}, now: () => Date.now() };
  const pin = await prepareTaskModelPolicyPin(deps, { orgId: TEST_ORG, project: "payments", agentId: "rovara-code", recipe, digest });
  const input = { orgId: TEST_ORG, project: "payments", agentId: "rovara-code", recipe, digest, pin, stage: "code_review" as const, priorModels: { build: claudeSonnet }, deniedModels: [] as { provider: string; modelId: string }[] };
  return { h, deps, input };
}

describe("rules 1, 2 and 4 on the pinned task stage (what a task actually runs)", () => {
  it("a company that can use another company's model gets it as the review default", async () => {
    const { deps, input } = await liveFixture();
    const result = await loadPinnedTaskStage({ ...deps, routing: openaiRouting() }, input);
    expect(result).toMatchObject({ kind: "resolved", model: { provider: "openai", modelId: "gpt-5" }, sourceId: OPENAI, reason: "DEFAULT_DIFFERENT_COMPANY" });
  });
  it("a company with only Rovara's Claude models keeps today's behaviour and is told so", async () => {
    const { deps, input } = await liveFixture();
    const result = await loadPinnedTaskStage(deps, input);
    expect(result).toMatchObject({ kind: "resolved", noOtherCompany: true });
    expect(result.kind === "resolved" && result.model.modelId).not.toBe(claudeSonnet.modelId);
  });
  it("a forbidden company model is never read into the pool, so the default falls back without it", async () => {
    const { h, deps, input } = await liveFixture();
    h.db.set({ ...agentGuardrailsKey(TEST_ORG), revision: 1, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, forbiddenModels: [{ provider: "openai", modelId: "gpt-5" }] } });
    expect(await loadPinnedTaskStage({ ...deps, routing: openaiRouting() }, input)).toMatchObject({ kind: "resolved", noOtherCompany: true });
  });
  it("a project's approved list that leaves the other company out keeps the default inside the list", async () => {
    const { deps, input } = await liveFixture();
    const approved = [claudeSonnet, { provider: "amazon-bedrock", modelId: "us.anthropic.claude-opus-5" }];
    const pin = { ...input.pin, frozenInputs: { ...input.pin.frozenInputs, projectModels: { default: claudeSonnet, approved } } };
    const result = await loadPinnedTaskStage({ ...deps, routing: openaiRouting() }, { ...input, pin });
    expect(result).toMatchObject({ kind: "resolved", noOtherCompany: true });
    expect(result.kind === "resolved" && approved.some((model) => model.modelId === result.model.modelId)).toBe(true);
  });
  it("a project's explicit review choice is never replaced, even when another company's model is usable", async () => {
    const { deps, input } = await liveFixture();
    const choice = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-opus-5-5" };
    const pin = { ...input.pin, frozenInputs: { ...input.pin.frozenInputs, projectChoices: { code_review: { model: choice } } } };
    const result = await loadPinnedTaskStage({ ...deps, routing: openaiRouting() }, { ...input, pin });
    expect(result).toMatchObject({ kind: "resolved", model: choice, reason: "PROJECT_CHOICE" });
    expect(result).not.toHaveProperty("noOtherCompany");
  });
});

describe("rule 3: What How we work reads: each review step's model with its reason", () => {
  it("the stage read carries the new reason and the same-company flag from the resolver, and the snapshot reads the company's models into the pool", async () => {
    const { loadStageModelSnapshot } = await import("../../packages/broker/src/model-selection/snapshot.js");
    const { getStageModels } = await import("../../packages/broker/src/model-selection/read.js");
    const { mergeWorld } = await import("../support/rovara-code-merge-world.js");
    const { ORG_A, MAX } = await import("../support/agent-session-world.js");
    const w = mergeWorld();
    const read = async (routing: object) => {
      const deps = { documentClient: w.db, tableName: "state", store: w.store, now: () => w.clock.now, routing };
      const snapshot = await loadStageModelSnapshot(deps, { orgId: ORG_A, developerId: MAX }, "web");
      return getStageModels({ now: () => w.clock.now, projectFor: async () => ({ name: "web", canEdit: true }), snapshot: async () => snapshot }, { orgId: ORG_A, developerId: MAX }, "web", {});
    };
    const withOpenai = await read(openaiRouting());
    expect(withOpenai.stages.find((stage) => stage.stage === "code_review")).toMatchObject({ effective: { model: { provider: "openai", modelId: "gpt-5" }, reason: "DEFAULT_DIFFERENT_COMPANY", decidedBy: "rovara" } });
    expect(withOpenai.stages.find((stage) => stage.stage === "plan_check")).toMatchObject({ effective: { reason: "DEFAULT_DIFFERENT_COMPANY" } });
    expect(withOpenai.stages.find((stage) => stage.stage === "build")).toMatchObject({ effective: { reason: "BUILTIN_DEFAULT" } });
    expect(withOpenai.stages.find((stage) => stage.stage === "code_review")?.candidates.map((candidate) => candidate.model.modelId)).toContain("gpt-5");
    const claudeOnly = await read({});
    const review = claudeOnly.stages.find((stage) => stage.stage === "code_review");
    expect(review).toMatchObject({ effective: { noOtherCompany: true } });
    expect(claudeOnly.stages.find((stage) => stage.stage === "build")).not.toMatchObject({ effective: { noOtherCompany: true } });
  });
});
