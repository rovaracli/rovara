// Convergence S0-Q2: Cloud's settings mapped onto the core's flow options, project rules, lessons switch and per-step model port.
// Each row states what Cloud does and what the core must be told; the readers Cloud uses itself are run over the same inputs so the mapping cannot drift from them.
import { describe, expect, it, vi } from "vitest";
import { createOwnerTaskAccess } from "@rovara-code/broker/core/task-flow";
import { ROVARA_CODE_AGENT_ID, builtinRecipe, type ModelIdentifier, type StageId, type StageModelChoice } from "@rovara-code/contracts";
import { createCloudApp, cloudFlowOptions } from "../../packages/broker/src/cloud/app/index.js";
import { UNMAPPED_SETTINGS, cloudSettingsFromEnvironment, mapCloudSettings, recipeStepKinds, type CloudCompanySettings } from "../../packages/broker/src/cloud/app/settings-mapping.js";
import { STEP_MODEL_WORDS, createCloudStepModels, type CloudModelFacts } from "../../packages/broker/src/cloud/app/model-mapping.js";
import { autofixConfigFromEnvironment } from "../../packages/broker/src/aws/workflow-autofix-runner.js";
import { learnedLessonsEnabled } from "../../packages/broker/src/lessons/switch.js";
import { rovaraCodeV2LiveFromEnvironment } from "../../packages/broker/src/rovara-code/v2-switch.js";
import { FAKE_COMPANY, createFakeWorld } from "../support/cloud-core-fakes.js";

const V2_STEPS = recipeStepKinds(builtinRecipe(ROVARA_CODE_AGENT_ID, 2));
const V1_STEPS = recipeStepKinds(builtinRecipe(ROVARA_CODE_AGENT_ID, 1));
const base = { connectorWritesBehindApproval: true } as const;
const settingsOf = (env: Record<string, string>, steps: readonly string[] | undefined, extra: { workspaceLimits?: { member: number; organization: number } } = {}): CloudCompanySettings =>
  cloudSettingsFromEnvironment(env, { recipeStepKinds: steps, ...base, ...extra });

describe("S0-Q2: Understand and the plan check (aws/developer-tasks/start.ts:370 and :372)", () => {
  it("the pinned recipe is what has a plan check step: version 2 has it, version 1 does not", () => {
    expect(V2_STEPS).toContain("plan_critic");
    expect(V1_STEPS).not.toContain("plan_critic");
  });

  it.each([
    { name: "rv on, version 2 recipe", env: { AGENTX_ROVARA_CODE_V2_ENABLED: "true" }, steps: V2_STEPS, understandFirst: true, planCheck: true },
    { name: "rv on, version 1 recipe", env: { AGENTX_ROVARA_CODE_V2_ENABLED: "true" }, steps: V1_STEPS, understandFirst: false, planCheck: false },
    { name: "rv off, version 2 recipe (a plan check step with no Understand: the core cannot start a program without Understand)", env: {}, steps: V2_STEPS, understandFirst: false, planCheck: true },
    { name: "rv word is not exactly true", env: { AGENTX_ROVARA_CODE_V2_ENABLED: "1" }, steps: V2_STEPS, understandFirst: false, planCheck: true },
    { name: "no agents wired (the journey install)", env: { AGENTX_ROVARA_CODE_V2_ENABLED: "true" }, steps: undefined, understandFirst: false, planCheck: false },
  ])("$name", ({ env, steps, understandFirst, planCheck }) => {
    const mapped = mapCloudSettings(settingsOf(env, steps));
    expect(mapped.flowOptions.understandFirst).toBe(understandFirst);
    expect(mapped.flowOptions.planCheck).toBe(planCheck);
    expect(settingsOf(env, steps).rovaraCodeV2Live).toBe(rovaraCodeV2LiveFromEnvironment(env));
  });
});

describe("S0-Q2: the plan's self-check, automatic fixing, lessons, live steer, limits, connector writes", () => {
  it.each([
    { name: "unset: on", env: {}, expected: true },
    { name: "false: off", env: { PLAN_SELF_CHECK_ENABLED: "false" }, expected: false },
    { name: "only the exact word turns it off", env: { PLAN_SELF_CHECK_ENABLED: "0" }, expected: true },
  ])("plan self-check, $name", ({ env, expected }) => {
    expect(mapCloudSettings(settingsOf(env, undefined)).flowOptions.planSelfCheck).toBe(expected);
  });

  it.each([
    { name: "unset: on, the default cap", env: {} },
    { name: "off (any case, trimmed)", env: { AUTOFIX_ENABLED: " False " } },
    { name: "a cap", env: { AUTOFIX_ENABLED: "true", AUTOFIX_CAP_USD: "7.5" } },
    { name: "a cap that is not a number is no cap (the policy asks)", env: { AUTOFIX_CAP_USD: "lots" } },
    { name: "a negative cap is no cap", env: { AUTOFIX_CAP_USD: "-1" } },
  ])("automatic fixing, $name: the core is told what Cloud's own reader says", ({ env }) => {
    const cloud = autofixConfigFromEnvironment(env);
    const mapped = mapCloudSettings(settingsOf(env, undefined)).flowOptions.autofix;
    expect(mapped.enabled).toBe(cloud.enabled);
    expect(mapped.roundEstimateUsd).toBe(cloud.roundEstimateUsd);
    if (Number.isNaN(cloud.capUsd)) expect(mapped.capUsd).toBeNaN(); else expect(mapped.capUsd).toBe(cloud.capUsd);
  });

  it("automatic fixing off on Cloud is off on the core, which would otherwise default to on", () => {
    expect(mapCloudSettings(settingsOf({ AUTOFIX_ENABLED: "false" }, undefined)).flowOptions.autofix.enabled).toBe(false);
  });

  it.each(["1", "0", "true", " 1", "", undefined])("lessons, LEARNED_LESSONS_ENABLED=%j: on only where Cloud's own switch is", (value) => {
    const env: Record<string, string> = value === undefined ? {} : { LEARNED_LESSONS_ENABLED: value };
    expect(mapCloudSettings(settingsOf(env, undefined)).lessonsEnabled()).toBe(learnedLessonsEnabled(env));
  });

  it("live steer is on only when exactly 1", () => {
    expect(mapCloudSettings(settingsOf({ LIVE_STEER_ENABLED: "1" }, undefined)).flowOptions.liveSteer).toBe(true);
    expect(mapCloudSettings(settingsOf({ LIVE_STEER_ENABLED: "true" }, undefined)).flowOptions.liveSteer).toBe(false);
    expect(mapCloudSettings(settingsOf({}, undefined)).flowOptions.liveSteer).toBe(false);
  });

  it("workspace limits are the company's own, or the core's defaults stand", () => {
    expect(mapCloudSettings(settingsOf({}, undefined, { workspaceLimits: { member: 3, organization: 20 } })).flowOptions.limits).toEqual({ member: 3, organization: 20 });
    expect(mapCloudSettings(settingsOf({}, undefined)).flowOptions).not.toHaveProperty("limits");
  });

  it("connector writes are allowed exactly where Cloud serves them behind a person's approval", () => {
    expect(mapCloudSettings(cloudSettingsFromEnvironment({}, { recipeStepKinds: undefined, connectorWritesBehindApproval: true })).projectRules.allowConnectorWrites).toBe(true);
    expect(mapCloudSettings(cloudSettingsFromEnvironment({}, { recipeStepKinds: undefined, connectorWritesBehindApproval: false })).projectRules.allowConnectorWrites).toBe(false);
  });

  it("every Cloud setting with no flow option is listed once, with why", () => {
    const names = UNMAPPED_SETTINGS.map((entry) => entry.setting);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of UNMAPPED_SETTINGS) expect(entry.why.length, entry.setting).toBeGreaterThan(20);
  });
});

// ---- the per-step model (area 24) ----

const sonnet: ModelIdentifier = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6" };
const opus: ModelIdentifier = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-opus-5-5" };
const gpt: ModelIdentifier = { provider: "openai", modelId: "gpt-5.4" };

function facts(over: Partial<CloudModelFacts> & { overrides?: Partial<Record<StageId, StageModelChoice & { locked?: boolean }>>; models?: ModelIdentifier[]; routable?: (model: ModelIdentifier) => boolean } = {}): CloudModelFacts {
  const models = over.models ?? [sonnet, opus];
  const routable = over.routable ?? (() => true);
  return {
    companyId: FAKE_COMPANY, sourcesRevision: async () => 0, servable: async () => models.map((model) => ({ model, sourceId: "rovara" })),
    installModel: async () => sonnet, route: async (model) => (routable(model) ? { alias: model.modelId, api: "anthropic-messages", catalog: model.modelId } : undefined),
    stepOverrides: async () => over.overrides ?? {}, unusable: async () => new Set<string>(), forbidden: async () => [], ...over,
  };
}

describe("S0-Q2: the model each step runs on (area 24)", () => {
  it("with nothing set: the install's model writes the plan and the code, and the hosted review rule picks the strongest other model to check them", async () => {
    const steps = createCloudStepModels(facts());
    const model = async (stage: StageId) => { const choice = await steps.choose({ stage }); return choice.ok ? choice.step.model : choice; };
    expect(await model("plan")).toEqual(sonnet);
    expect(await model("build")).toEqual(sonnet);
    expect(await model("code_review")).toEqual(opus);
  });

  it("the company's per-step setting (the MODEL_SELECTION_POLICY row) wins over the defaults, and a lock is a lock", async () => {
    const steps = createCloudStepModels(facts({ overrides: { build: { model: opus }, plan: { model: opus, locked: true } } }));
    const build = await steps.choose({ stage: "build" });
    expect(build.ok && build.step.model).toEqual(opus);
    expect(build.ok && build.step.reason).toBe("COMPANY_DEFAULT");
    const plan = await steps.choose({ stage: "plan" });
    expect(plan.ok && plan.step.reason).toBe("COMPANY_LOCK");
  });

  it("a locked model that cannot be routed refuses the step in Cloud's words, never a different model", async () => {
    const steps = createCloudStepModels(facts({ overrides: { plan: { model: opus, locked: true } }, models: [sonnet] }));
    const refused = await steps.choose({ stage: "plan" });
    expect(refused).toEqual({ ok: false, code: "LOCK_UNSATISFIABLE", words: STEP_MODEL_WORDS.LOCK_UNSATISFIABLE });
  });

  it("a model no source can route is refused for the step", async () => {
    const steps = createCloudStepModels(facts({ routable: () => false }));
    expect(await steps.choose({ stage: "plan" })).toEqual({ ok: false, code: "MODEL_NOT_VERIFIED", words: STEP_MODEL_WORDS.MODEL_NOT_VERIFIED });
  });

  it("a model an earlier try found unusable is left out of the next choice", async () => {
    const steps = createCloudStepModels(facts({ models: [sonnet, opus, gpt] }));
    const first = await steps.choose({ stage: "plan_check" });
    expect(first.ok && first.step.model).not.toEqual(sonnet);
    const retry = await steps.choose({ stage: "plan_check", denied: first.ok ? [first.step.model] : [] });
    expect(retry.ok && retry.step.model).not.toEqual(first.ok ? first.step.model : undefined);
  });

  it("no install model and no setting: no model to choose (the core hands the step over with none, as before)", async () => {
    const steps = createCloudStepModels(facts({ installModel: async () => undefined }));
    expect(await steps.choose({ stage: "plan" })).toEqual({ ok: false, code: "NO_MODEL", words: STEP_MODEL_WORDS.NO_MODEL });
  });

  it("every refusal code has Cloud's words", () => {
    for (const [code, words] of Object.entries(STEP_MODEL_WORDS)) expect(words.length, code).toBeGreaterThan(10);
  });
});

describe("S0-Q2: nothing changes with the switch off", () => {
  it("an off app never reads the settings, builds the registry or creates an adapter", async () => {
    const world = createFakeWorld();
    const runtime = vi.fn(() => ({
      callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }),
      now: () => new Date(world.clock.now), log: () => undefined,
      flowOptions: cloudFlowOptions(settingsOf({}, undefined), facts()),
    }));
    for (const value of [undefined, "off", "", "0", "nonsense"]) {
      const app = createCloudApp({ env: value === undefined ? {} : { CLOUD_CORE_ENGINE: value }, modules: world.modules, context: () => world.context(), runtime });
      expect(app.active).toBe(false);
      await expect(app.runtimeFor(FAKE_COMPANY)).rejects.toThrow(/off/);
      await expect(app.registry()).rejects.toThrow(/off/);
    }
    // `runtime` is only called to build a runtime, which an off app refuses before it gets there; the world's adapters were never created.
    expect(world.created).toEqual([]);
  });

  it("cloudFlowOptions states every option the core would otherwise default, and adds the model port only when given facts", () => {
    const without = cloudFlowOptions(settingsOf({ AUTOFIX_ENABLED: "false" }, undefined));
    expect(without).toMatchObject({ understandFirst: false, planCheck: false, planSelfCheck: true, autofix: { enabled: false }, liveSteer: false });
    expect(without).not.toHaveProperty("stepModels");
    expect(cloudFlowOptions(settingsOf({}, undefined), facts())).toHaveProperty("stepModels");
  });
});
