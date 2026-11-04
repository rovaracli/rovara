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
const input = (stage: StageModelInput["stage"], models = [sonnet, opus, gpt, gemini], more: Partial<StageModelInput> = {}): StageModelInput => ({
  orgId: "org_a", stage, sourcesRevision: 2, candidates: models.map((model) => row(model)), forbidden: [], builtinDefault: sonnet, referenceModel: sonnet, allowLegacyDefaultFallback: true, reviewDefaultDifferentCompany: true, ...more,
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
    expect(resolveStageModel(input("code_review", undefined, { defaultLastAttempt: true }))).toMatchObject({ kind: "resolved", model: sonnet, fallback: { reasonCode: "DEFAULT_MODEL_UNAVAILABLE" }, otherCompanyFailed: true });
  });
  it("a build step is untouched (the default is for steps that check another step)", () => {
    expect(resolveStageModel({ ...input("code_review"), stage: "build", referenceModel: undefined })).toMatchObject({ kind: "resolved", reason: "BUILTIN_DEFAULT" });
  });
});

describe("the fallback note names the model that was asked for, never the model that ran (QA-06)", () => {
  const unusableOpus = { ...row(opus), accountCannotUse: true as const };
  for (const stage of REVIEWS) {
    it(`${stage}: the preferred other model is not callable on this account, so the builder's model checks and the note says the preferred model was unavailable`, () => {
      const result = resolveStageModel(input(stage, [sonnet], { candidates: [row(sonnet), unusableOpus] }));
      expect(result).toMatchObject({ kind: "resolved", model: sonnet, fallback: { used: "anthropic/claude-sonnet-4", wanted: "anthropic/claude-opus-4", reasonCode: "DEFAULT_MODEL_UNAVAILABLE" } });
    });
  }
  it("the same model on a source that cannot serve it, replaced by the same model on one that can: the note names no model", () => {
    const source = { model: sonnet, sourceId: "src_aaaaaaaaaaaaaaaaaaaa", enabled: true, inEffectiveOrder: true, evidence: { orgId: "org_a", sourcesRevision: 2, kind: "tested_bedrock_role" as const } };
    const result = resolveStageModel({ ...input("build", [sonnet]), referenceModel: undefined, candidates: [{ ...row(sonnet), accountCannotUse: true as const }, source] });
    expect(result).toMatchObject({ kind: "resolved", model: sonnet, sourceId: "src_aaaaaaaaaaaaaaaaaaaa", fallback: { used: "anthropic/claude-sonnet-4", wanted: null } });
  });
  it("with no other model asked for at all, the note names none (the page says \"the preferred model\") rather than the model that ran", () => {
    const result = resolveStageModel(input("code_review", [sonnet]));
    expect(result).toMatchObject({ kind: "resolved", model: sonnet, fallback: { used: "anthropic/claude-sonnet-4", wanted: null } });
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
  it("a model of an unrecognised company is below the floor, so it never wins by default; the builder's own model stands, marked", () => {
    const strange = { provider: "acme", modelId: "mystery-1" };
    expect(resolveStageModel(input("code_review", [sonnet, strange]))).toMatchObject({ kind: "resolved", model: sonnet, noOtherCompany: true, fallback: { reasonCode: "DEFAULT_MODEL_UNAVAILABLE" } });
  });
  it("without the legacy fallback (publish-time validation) a weak other-company model is still accepted, so the default never refuses what was accepted before", () => {
    const strange = { provider: "acme", modelId: "mystery-1" };
    expect(resolveStageModel(input("code_review", [sonnet, strange], { allowLegacyDefaultFallback: false }))).toMatchObject({ kind: "resolved", model: strange });
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
    // With only Claude models, the default would say "no other company" and mark it; the explicit model-level rule picks the same model without the default's reason or note.
    for (const rule of [{ projectChoice: explicitModelLevel }, { companyDefault: explicitModelLevel }]) {
      const result = resolveStageModel(input("code_review", [sonnet, opus], rule));
      expect(result).toMatchObject({ kind: "resolved", model: opus, reason: "BUILTIN_DEFAULT" });
      expect(result).not.toHaveProperty("noOtherCompany");
    }
  });
  it("among frontier models the step prefers a different company from the one it checks, even over a cheaper model of its own (the explicit model-level rule picks the same way)", () => {
    const bedrockSonnet = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-5" }, bedrockOpus = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-opus-5-5" }, gpt55 = { provider: "openai", modelId: "gpt-5.5" };
    const rule = { projectChoice: { differentFrom: { stage: "build" as const, level: "model" as const } }, referenceModel: bedrockSonnet };
    expect(resolveStageModel(input("code_review", [bedrockSonnet, bedrockOpus, gpt55], rule))).toMatchObject({ kind: "resolved", model: gpt55 });
    expect(resolveStageModel(input("code_review", [bedrockSonnet, bedrockOpus], rule))).toMatchObject({ kind: "resolved", model: bedrockOpus });
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
    expect(ids(reviewDefaultExtras({ servable, approved: undefined, forbidden: [], have: new Set(), size: 0 }))).toEqual(["openai/gpt-5", "anthropic/claude-opus-4", "google/gemini-2.5-pro", "anthropic/claude-sonnet-4"]);
    expect(ids(reviewDefaultExtras({ servable, approved: undefined, forbidden: [gpt], have: new Set(), size: 0 }))).not.toContain("openai/gpt-5");
    expect(ids(reviewDefaultExtras({ servable, approved: [sonnet, gemini], forbidden: [], have: new Set(), size: 0 }))).toEqual(["google/gemini-2.5-pro", "anthropic/claude-sonnet-4"]);
  });
  it("never grows the pool past its limit, and keeps every company's strongest when room is short", () => {
    const servable = [opus, sonnet, gpt, gemini];
    const have = new Set(Array.from({ length: STAGE_POOL_MAX - 2 }, (_, index) => `m${String(index)}`));
    expect(ids(reviewDefaultExtras({ servable, approved: undefined, forbidden: [], have, size: STAGE_POOL_MAX - 2 }))).toEqual(["openai/gpt-5", "anthropic/claude-opus-4"]);
    expect(reviewDefaultExtras({ servable, approved: undefined, forbidden: [], have: new Set(Array.from({ length: STAGE_POOL_MAX }, (_, index) => `m${String(index)}`)), size: STAGE_POOL_MAX })).toEqual([]);
  });
  it("takes at most three of one company, so one company's long list cannot crowd the others out", () => {
    const many = ["gpt-5", "gpt-5-1", "gpt-5-2", "gpt-5-3", "gpt-5-4"].map((modelId) => ({ provider: "openai", modelId }));
    const added = reviewDefaultExtras({ servable: [...many, gemini], approved: undefined, forbidden: [], have: new Set(), size: 0 });
    expect(added.filter((model) => model.provider === "openai")).toHaveLength(3);
    expect(added).toContainEqual(gemini);
  });
  it("does not re-add a model the pool already holds", () => {
    expect(ids(reviewDefaultExtras({ servable: [gpt], approved: undefined, forbidden: [], have: new Set(["gpt-5"]), size: 1 }))).toEqual([]);
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

describe("H2: the capability floor", () => {
  const deepseek = { provider: "amazon-bedrock", modelId: "us.deepseek.r1-v1:0" }, nova = { provider: "amazon-bedrock", modelId: "us.amazon.nova-micro-v1:0" }, mini = { provider: "openai", modelId: "gpt-5-mini" };
  it("never picks DeepSeek or Nova by default: Bedrock offering Sonnet, Opus, DeepSeek R1 and Nova Micro reviews on Opus, marked", () => {
    expect(resolveStageModel(input("code_review", [sonnet, opus, deepseek, nova]))).toMatchObject({ kind: "resolved", model: opus, noOtherCompany: true });
  });
  it("not even when they are all that is left besides the builder (legacy fallback on), nor a mini model of another company", () => {
    expect(resolveStageModel(input("code_review", [sonnet, deepseek, nova, mini]))).toMatchObject({ kind: "resolved", model: sonnet, noOtherCompany: true });
  });
  it("a Sonnet-tier-or-better model of another company is chosen over weak ones", () => {
    expect(resolveStageModel(input("code_review", [sonnet, deepseek, gemini]))).toMatchObject({ model: gemini, reason: "DEFAULT_DIFFERENT_COMPANY" });
  });
});

describe("H1: a person's ChatGPT plan is never the review default", () => {
  const plan = (model: { provider: string; modelId: string }) => ({ model, sourceId: "personal-chatgpt", enabled: true, inEffectiveOrder: true, evidence: { orgId: "org_a", sourcesRevision: 2, kind: "chatgpt_connection" as const, payerDeveloperId: "dev_1", connectionRevision: "rev" } });
  const KEY = "src_bbbbbbbbbbbbbbbbbbbb";
  it("resolver: a plan-served model of another company is skipped; the company's own source of it is taken", () => {
    const base = input("code_review", [sonnet, opus]);
    const viaPlan = { ...base, payerDeveloperId: "dev_1", connectionRevision: "rev", candidates: [...base.candidates, plan(gpt)] };
    expect(resolveStageModel(viaPlan)).toMatchObject({ kind: "resolved", model: opus, noOtherCompany: true });
    const keyed = { ...row(gpt, KEY), evidence: { orgId: "org_a", sourcesRevision: 2, kind: "stored_key" as const } };
    expect(resolveStageModel({ ...viaPlan, candidates: [...viaPlan.candidates, keyed] })).toMatchObject({ kind: "resolved", model: gpt, sourceId: KEY, reason: "DEFAULT_DIFFERENT_COMPANY" });
  });
  it("live: with the order personal-chatgpt, rovara, a company key, the default is served by the company key", async () => {
    const { deps, input: live } = await liveFixture();
    const chatgpt = { settings: async () => ({ enabled: true, preferredModel: "gpt-5" }), view: async () => ({ connected: true, status: "connected" as const, connectedAt: "2026-11-01T00:00:00Z", models: ["gpt-5"] }) };
    const routing = { ...openaiRouting(), sources: { read: async () => ({ sources: [{ sourceId: OPENAI, kind: "openai" as const, label: "Fixture OpenAI", models: [{ catalog: { provider: "openai", modelId: "gpt-5" } }] }], order: ["personal-chatgpt", "rovara", OPENAI], credentials: [OPENAI], removing: [], revision: 1 }) } };
    const result = await loadPinnedTaskStage({ ...deps, routing, chatgpt }, { ...live, payerDeveloperId: "a".repeat(64) });
    expect(result).toMatchObject({ kind: "resolved", model: { provider: "openai", modelId: "gpt-5" }, sourceId: OPENAI, reason: "DEFAULT_DIFFERENT_COMPANY" });
  });
  it("live: the company key that serves it can fund the task (the funding check passes for the chosen source)", async () => {
    const { actualCompanyFunding } = await import("../../packages/broker/src/org/task-stop-funding.js");
    const { deps } = await liveFixture();
    const proof = { version: 1 as const, orgId: TEST_ORG, project: "payments", sourcesRevision: 1, sources: [{ sourceId: OPENAI, kind: "stored_key" as const }] };
    const funded = await actualCompanyFunding({ routing: openaiRouting(), now: () => Date.now(), documentClient: deps.documentClient, tableName: "state" }, proof, { sourceId: OPENAI, model: { provider: "openai", modelId: "gpt-5" } });
    expect(funded?.sources).toEqual([{ sourceId: OPENAI, kind: "stored_key" }]);
  });
});

describe("M2: a task keeps the review rule it was started with", () => {
  it("resolver: without the flag (an older pin) nothing changes from before", () => {
    const result = resolveStageModel(input("code_review", [sonnet, opus], { reviewDefaultDifferentCompany: undefined }));
    expect(result).toMatchObject({ kind: "resolved", model: opus, reason: "BUILTIN_DEFAULT" });
    expect(result).not.toHaveProperty("noOtherCompany");
  });
  it("live: a new pin carries the default; an old pin (no field) resolves and reads the pool as it did", async () => {
    const { deps, input: live } = await liveFixture();
    expect(live.pin.frozenInputs?.reviewDefault).toBe("different_company");
    const frozenInputs = { ...live.pin.frozenInputs! };
    delete (frozenInputs as { reviewDefault?: unknown }).reviewDefault;
    const old = await loadPinnedTaskStage({ ...deps, routing: openaiRouting() }, { ...live, pin: { ...live.pin, frozenInputs } });
    expect(old).toMatchObject({ kind: "resolved" });
    expect(old).not.toMatchObject({ reason: "DEFAULT_DIFFERENT_COMPANY" });
    // The pool was not widened either: another company's model the company could use is not even a candidate for an older task.
    expect(old.kind === "resolved" && old.model.provider).not.toBe("openai");
    expect(old).not.toHaveProperty("noOtherCompany");
  });
});

describe("behaviour 6: a task pinned before this deploy keeps the model its reviews ranked to (no review-default marker = the order it started with)", () => {
  const fable = { provider: "anthropic", modelId: "claude-fable-5-1" };
  const withFable = [sonnet, opus, fable, gpt, gemini];
  it("an older pin picks the strongest by the old order (Opus), not the cheaper other-company GPT-5 the one frontier tier now prefers", () => {
    expect(resolveStageModel(input("code_review", [sonnet, opus, gpt, gemini], { reviewDefaultDifferentCompany: false }))).toMatchObject({ kind: "resolved", model: opus });
    expect(resolveStageModel(input("code_review", [sonnet, opus, gpt, gemini], { reviewDefaultDifferentCompany: undefined }))).toMatchObject({ kind: "resolved", model: opus });
    // The new pin, the same models: GPT-5 (a different company, cheaper).
    expect(resolveStageModel(input("code_review", [sonnet, opus, gpt, gemini]))).toMatchObject({ kind: "resolved", model: gpt, reason: "DEFAULT_DIFFERENT_COMPANY" });
  });
  it("Fable stays above Opus for an older pin, and after Opus is refused the next try is still Fable (the old tier-by-tier demotion)", () => {
    expect(resolveStageModel(input("plan_check", withFable, { reviewDefaultDifferentCompany: false }))).toMatchObject({ kind: "resolved", model: fable });
    expect(resolveStageModel(input("plan_check", withFable, { reviewDefaultDifferentCompany: false, deniedModels: [opus] }))).toMatchObject({ kind: "resolved", model: fable });
  });
  it("the legacy fallback of an older pin keeps the old order as well", () => {
    expect(resolveStageModel(input("security_review", withFable, { reviewDefaultDifferentCompany: false, allowLegacyDefaultFallback: true, defaultLastAttempt: false }))).toMatchObject({ kind: "resolved", model: fable });
  });
});

describe("M3 and L5: the pool matches the approved list exactly and compares models by canonical name", () => {
  const bedrockGpt = { provider: "amazon-bedrock", modelId: "openai.gpt-5" };
  it("approved amazon-bedrock/openai.gpt-5 does not admit openai/gpt-5", () => {
    expect(reviewDefaultExtras({ servable: [gpt], approved: [bedrockGpt], forbidden: [], have: new Set(), size: 0 })).toEqual([]);
    expect(reviewDefaultExtras({ servable: [gpt], approved: [gpt], forbidden: [], have: new Set(), size: 0 })).toEqual([gpt]);
  });
  it("one model over two routes is one model: a pool already holding it by its canonical name is not given it again", async () => {
    const { canonicalModelName } = await import("../../packages/contracts/src/index.js");
    expect(reviewDefaultExtras({ servable: [gpt], approved: undefined, forbidden: [], have: new Set([canonicalModelName(bedrockGpt)]), size: 1 })).toEqual([]);
  });
});

describe("L1: another company's model that was usable and failed is not 'none available'", () => {
  it("the only other-company model was refused by an earlier try: marked as failed, not as unavailable", () => {
    const result = resolveStageModel(input("code_review", [sonnet, opus, gpt], { deniedModels: [gpt] }));
    expect(result).toMatchObject({ kind: "resolved", model: opus, otherCompanyFailed: true });
    expect(result).not.toHaveProperty("noOtherCompany");
  });
  it("none existed at all: unavailable, and not failed", () => {
    const result = resolveStageModel(input("code_review", [sonnet, opus]));
    expect(result).toMatchObject({ noOtherCompany: true });
    expect(result).not.toHaveProperty("otherCompanyFailed");
  });
});

describe("L2 and L3: what the broker says", () => {
  it("the added models are offered to the checking stages only, never to Build or Plan", async () => {
    const { loadStageModelSnapshot } = await import("../../packages/broker/src/model-selection/snapshot.js");
    const { mergeWorld } = await import("../support/rovara-code-merge-world.js");
    const { ORG_A, MAX } = await import("../support/agent-session-world.js");
    const w = mergeWorld();
    const snapshot = await loadStageModelSnapshot({ documentClient: w.db, tableName: "state", store: w.store, now: () => w.clock.now, routing: openaiRouting() }, { orgId: ORG_A, developerId: MAX }, "web");
    const has = (stage: string) => snapshot.stages.find((row) => row.stage === stage)!.candidates.some((candidate) => candidate.model.modelId === "gpt-5");
    expect([has("code_review"), has("security_review"), has("plan_check")]).toEqual([true, true, true]);
    expect([has("build"), has("plan"), has("understand"), has("pull_request")]).toEqual([false, false, false, false]);
    expect(snapshot.stages.every((row) => row.reviewDefaultDifferentCompany === true)).toBe(true);
  });
  it("the company page's read says which checking steps default to a different company, from the saved policy", async () => {
    const { getCompanyModelSelectionPolicy } = await import("../../packages/broker/src/model-selection/company-read.js");
    const { orgMemberKey, developerOrgKey, orgMetaKey } = await import("../../packages/contracts/src/index.js");
    const h = await createDeveloperTaskBroker();
    const dev = "a".repeat(64);
    h.db.set({ ...orgMemberKey(TEST_ORG, dev), orgId: TEST_ORG, developerId: dev, role: "admin" });
    h.db.set({ ...developerOrgKey(dev), orgId: TEST_ORG, role: "admin" });
    h.db.set({ ...orgMetaKey(TEST_ORG), orgId: TEST_ORG });
    h.db.set({ pk: `ORG#${TEST_ORG}#SETTINGS`, sk: "MODEL_SELECTION_POLICY", orgId: TEST_ORG, entityType: "MODEL_SELECTION_POLICY", version: 1, revision: 1, rankingVersion: "g3-v1", stepOverrides: { code_review: { model: opus, thinkingLevel: null, locked: false }, plan_check: { thinkingLevel: "low", locked: false } } });
    const read = await getCompanyModelSelectionPolicy({ documentClient: h.db, tableName: "state", routing: {}, now: () => Date.now() }, { orgId: TEST_ORG, developerId: dev });
    expect(read.reviewDefaults).toEqual({ plan_check: "different_company", security_review: "different_company" });
  });
});
