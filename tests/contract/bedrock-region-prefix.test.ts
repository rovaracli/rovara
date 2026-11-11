// A Bedrock inference-profile id names its model behind a geography prefix. Every prefix the pinned catalog uses must be stripped, so a forbidden model, a "different model" rule and a
// price all see one model whichever geography serves it; an id with a prefix nobody listed reads as unrecognised and fails closed (forbidden when anything is forbidden, never independent).
import { amazonBedrockProvider } from "@earendil-works/pi-ai/providers/amazon-bedrock";
import { describe, expect, it } from "vitest";
import { BEDROCK_REGION_PREFIXES, BEDROCK_VENDOR_PREFIXES, ModelSourceSchema, canonicalModelName, forbiddenModelMatcher, isUnrecognisedBedrockModel, legacyAliasModelName, modelCompany, sameModelOrUnrecognised, sourceAlias, type ModelIdentifier } from "@rovara-code/contracts";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { E2E_AGENT_ELIGIBLE_MODELS } from "@rovara-code/contracts";
import { listPricesPerMillion } from "../../packages/model-runtime/src/catalog.js";
import { resolveStageModel, type StageModelInput } from "../../packages/broker/src/model-selection/resolver.js";
import { candidatesOf, recommendCriticModel } from "../../packages/broker/src/rovara-code/critic.js";
import { reviewerModelFor } from "../../packages/broker/src/rovara-code/reviewer-model.js";

const bedrock = (modelId: string): ModelIdentifier => ({ provider: "amazon-bedrock", modelId });
const OPUS_5: ModelIdentifier = { provider: "anthropic", modelId: "claude-opus-5" };
const SONNET_5: ModelIdentifier = { provider: "anthropic", modelId: "claude-sonnet-5" };
const GEOGRAPHIES = ["us", "eu", "apac", "global", "au", "jp", "in", "ca", "us-gov"] as const;
const UNKNOWN = bedrock("zz.anthropic.claude-opus-5");

describe("the Bedrock region prefixes", () => {
  it("lists every geography the pinned catalog uses, and no vendor in it", () => {
    expect([...BEDROCK_REGION_PREFIXES].sort()).toEqual([...GEOGRAPHIES].sort());
    for (const vendor of BEDROCK_VENDOR_PREFIXES) expect(BEDROCK_REGION_PREFIXES as readonly string[]).not.toContain(vendor);
  });

  it("walks every amazon-bedrock id of the pinned Pi catalog and the e2e model list: the first segment is a listed geography or a known vendor", () => {
    const ids = [
      ...amazonBedrockProvider().getModels().map((entry) => entry.id),
      ...E2E_AGENT_ELIGIBLE_MODELS.filter((entry) => entry.provider === "amazon-bedrock").map((entry) => entry.modelId),
    ];
    expect(ids.length).toBeGreaterThan(100);
    const unknown = ids.filter((id) => {
      const first = id.split(".")[0]!;
      return !(BEDROCK_REGION_PREFIXES as readonly string[]).includes(first) && !(BEDROCK_VENDOR_PREFIXES as readonly string[]).includes(first);
    });
    expect(unknown).toEqual([]);
    // Every Claude id of the catalog reads as the same model as its plain name, whatever its geography.
    const claude = ids.filter((id) => id.includes("anthropic.claude"));
    expect(claude.length).toBeGreaterThanOrEqual(22);
    for (const id of claude) {
      expect(canonicalModelName(bedrock(id))).toBe(canonicalModelName({ provider: "anthropic", modelId: id.slice(id.indexOf("claude-")).replace(/-v\d+(?::\d+)?$/, "") }));
      expect(modelCompany(bedrock(id))).toBe("anthropic");
      expect(isUnrecognisedBedrockModel(bedrock(id))).toBe(false);
    }
    for (const id of ids) expect(isUnrecognisedBedrockModel(bedrock(id))).toBe(false);
  });
});

describe("canonicalModelName and modelCompany over every geography", () => {
  it.each(GEOGRAPHIES)("reads %s.anthropic.claude-opus-5 as claude-opus-5 and Anthropic's", (geography) => {
    const model = bedrock(`${geography}.anthropic.claude-opus-5`);
    expect(canonicalModelName(model)).toBe("claude-opus-5");
    expect(canonicalModelName(model)).toBe(canonicalModelName(OPUS_5));
    expect(modelCompany(model)).toBe("anthropic");
  });

  it("reads an upper- or mixed-case prefix the same way", () => {
    expect(canonicalModelName(bedrock("US.anthropic.claude-opus-5"))).toBe("claude-opus-5");
    expect(canonicalModelName(bedrock("JP.Anthropic.Claude-Opus-5"))).toBe("claude-opus-5");
    expect(canonicalModelName(bedrock("US-GOV.anthropic.claude-opus-5"))).toBe("claude-opus-5");
    expect(modelCompany(bedrock("US.anthropic.claude-opus-5"))).toBe("anthropic");
  });

  it("keeps the existing names for us, eu, apac and global ids, versions and dates stripped as before", () => {
    expect(canonicalModelName(bedrock("us.anthropic.claude-haiku-4-5-20251001-v1:0"))).toBe("claude-haiku-4-5");
    expect(canonicalModelName(bedrock("eu.anthropic.claude-sonnet-4-5-20250929-v1:0"))).toBe("claude-sonnet-4-5");
    expect(canonicalModelName(bedrock("apac.anthropic.claude-sonnet-4-20250514-v1:0"))).toBe("claude-sonnet-4");
    expect(canonicalModelName(bedrock("global.anthropic.claude-fable-5"))).toBe("claude-fable-5");
    expect(canonicalModelName(bedrock("anthropic.claude-opus-5"))).toBe("claude-opus-5");
    expect(canonicalModelName(bedrock("amazon.nova-lite-v1:0"))).toBe("nova-lite");
    expect(canonicalModelName(bedrock("us.amazon.nova-lite-v1:0"))).toBe("nova-lite");
    expect(canonicalModelName({ provider: "openrouter", modelId: "anthropic/claude-haiku-4.5" })).toBe("claude-haiku-4-5");
    expect(modelCompany(bedrock("eu.anthropic.claude-opus-5"))).toBe("anthropic");
    // SH33 (setup-test-health, owner 2026-11-01): Bedrock's own vendors are named companies, so Nova is Amazon's.
    expect(modelCompany(bedrock("us.amazon.nova-lite-v1:0"))).toBe("amazon");
  });
});

describe("prices", () => {
  it("find a plain Claude model's list price behind every geography, the catalog listing that profile or not", () => {
    const known = new Set(amazonBedrockProvider().getModels().map((entry) => entry.id));
    const bases = [...known].filter((id) => id.startsWith("anthropic.claude-"));
    let unlisted = 0;
    for (const base of bases) {
      for (const geography of BEDROCK_REGION_PREFIXES) {
        const id = `${geography}.${base}`;
        if (known.has(id)) continue;
        unlisted += 1;
        expect(listPricesPerMillion(bedrock(id)), id).toEqual(listPricesPerMillion(bedrock(base)));
      }
    }
    expect(unlisted).toBeGreaterThan(0);
    expect(listPricesPerMillion(bedrock("zz.anthropic.claude-sonnet-5"))).toBeUndefined();
  });
});

describe("a Bedrock id with a prefix nobody listed", () => {
  it("is unrecognised, and is no company's", () => {
    expect(isUnrecognisedBedrockModel(UNKNOWN)).toBe(true);
    expect(isUnrecognisedBedrockModel(bedrock("ZZ.Anthropic.claude-opus-5"))).toBe(true);
    expect(isUnrecognisedBedrockModel(bedrock("zz.openai.gpt-5.4"))).toBe(true);
    expect(modelCompany(UNKNOWN)).toBe("other");
    expect(isUnrecognisedBedrockModel({ provider: "openrouter", modelId: "zz.anthropic.claude-opus-5" })).toBe(false);
    expect(isUnrecognisedBedrockModel({ provider: "anthropic", modelId: "claude-opus-5" })).toBe(false);
  });

  it.each([
    ["a second prefix", "us.jp.anthropic.claude-opus-5"],
    ["a doubled region", "us.us.anthropic.claude-opus-5"],
    ["an empty segment", "us..anthropic.claude-opus-5"],
    ["a foundation-model ARN", "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-opus-5"],
    ["an inference-profile ARN", "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/abc123"],
    ["a bare id", "claude-opus-5"],
    ["a region and no vendor", "zz.claude-opus-5"],
    ["a region and a bare id", "us.zz.claude-opus-5"],
    ["a percent-escaped dot", "us%2Eanthropic.claude-opus-5"],
    ["a zero-width character", "us.anthropic.claude-opus\u200b-5"],
    ["a Cyrillic look-alike", "us.anthropic.claude-\u043Fpus-5"],
    ["a space", "us.anthropic.claude opus-5"],
    ["a slash", "us.anthropic/claude-opus-5"],
    ["a trailing dot", "us.anthropic."],
  ])("reads %s as unrecognised", (_name, modelId) => {
    expect(isUnrecognisedBedrockModel(bedrock(modelId))).toBe(true);
    expect(forbiddenModelMatcher([OPUS_5])(bedrock(modelId))).toBe(true);
    expect(forbiddenModelMatcher([])(bedrock(modelId))).toBe(false);
  });

  it("is forbidden whenever anything is forbidden, and by no empty list", () => {
    expect(forbiddenModelMatcher([OPUS_5])(UNKNOWN)).toBe(true);
    expect(forbiddenModelMatcher([{ provider: "openai", modelId: "gpt-5.4" }])(UNKNOWN)).toBe(true);
    expect(forbiddenModelMatcher([])(UNKNOWN)).toBe(false);
  });

  it("does not let an unrecognised forbidden entry forbid every model", () => {
    const forbidden = forbiddenModelMatcher([UNKNOWN]);
    expect(forbidden(SONNET_5)).toBe(false);
    expect(forbidden(bedrock("jp.anthropic.claude-sonnet-5"))).toBe(false);
    expect(forbidden(UNKNOWN)).toBe(true);
  });

  it("matches a forbidden entry through every geography, and nothing else", () => {
    const forbidden = forbiddenModelMatcher([OPUS_5]);
    for (const geography of GEOGRAPHIES) expect(forbidden(bedrock(`${geography}.anthropic.claude-opus-5`))).toBe(true);
    expect(forbidden(bedrock("US.anthropic.claude-opus-5"))).toBe(true);
    expect(forbidden(bedrock("jp.anthropic.claude-sonnet-5"))).toBe(false);
    expect(forbidden(SONNET_5)).toBe(false);
  });

  it("counts as the same model as any other, never as an independent one", () => {
    expect(sameModelOrUnrecognised(UNKNOWN, SONNET_5)).toBe(true);
    expect(sameModelOrUnrecognised(SONNET_5, UNKNOWN)).toBe(true);
    expect(sameModelOrUnrecognised(bedrock("jp.anthropic.claude-opus-5"), OPUS_5)).toBe(true);
    expect(sameModelOrUnrecognised(bedrock("jp.anthropic.claude-opus-5"), SONNET_5)).toBe(false);
  });
});

describe("the stage model resolver", () => {
  const candidate = (model: ModelIdentifier) => ({ model, sourceId: "rovara", enabled: true, inEffectiveOrder: true, evidence: { orgId: "org_a", sourcesRevision: 2, kind: "rovara_catalog" as const } });
  const input = (models: ModelIdentifier[], changes: Partial<StageModelInput> = {}): StageModelInput => ({
    orgId: "org_a", stage: "build", sourcesRevision: 2, candidates: models.map(candidate), forbidden: [], approved: models, builtinDefault: models[0]!, ...changes,
  });

  it.each([...GEOGRAPHIES, "US"])("refuses %s.anthropic.claude-opus-5 when claude-opus-5 is forbidden", (geography) => {
    const model = bedrock(`${geography}.anthropic.claude-opus-5`);
    expect(resolveStageModel(input([model], { forbidden: [OPUS_5], projectChoice: { model } }))).toEqual({ kind: "refusal", code: "MODEL_FORBIDDEN" });
  });

  it("refuses an unknown-prefix id whenever something is forbidden, and not when nothing is", () => {
    expect(resolveStageModel(input([UNKNOWN], { forbidden: [SONNET_5], projectChoice: { model: UNKNOWN } }))).toEqual({ kind: "refusal", code: "MODEL_FORBIDDEN" });
    expect(resolveStageModel(input([UNKNOWN], { projectChoice: { model: UNKNOWN } }))).toMatchObject({ kind: "resolved", model: UNKNOWN });
  });

  it("does not take a jp, au, in, ca, us-gov or upper-case id as an independent checker of the same model", () => {
    for (const geography of ["jp", "au", "in", "ca", "us-gov", "US"]) {
      const same = bedrock(`${geography}.anthropic.claude-opus-5`);
      const base = input([same], { stage: "code_review", referenceModel: OPUS_5 });
      expect(resolveStageModel(base)).toEqual({ kind: "refusal", code: "DIFFERENT_FROM_UNSATISFIABLE" });
      expect(resolveStageModel(input([same, SONNET_5], { stage: "code_review", referenceModel: OPUS_5 }))).toMatchObject({ kind: "resolved", model: SONNET_5 });
    }
  });

  it("never takes an unknown-prefix id as independent, whichever side it is on", () => {
    expect(resolveStageModel(input([UNKNOWN], { stage: "code_review", referenceModel: SONNET_5 }))).toEqual({ kind: "refusal", code: "DIFFERENT_FROM_UNSATISFIABLE" });
    expect(resolveStageModel(input([SONNET_5], { stage: "code_review", referenceModel: UNKNOWN }))).toEqual({ kind: "refusal", code: "DIFFERENT_FROM_UNSATISFIABLE" });
  });

  it("does not let an unrecognised forbidden entry refuse a recognised model", () => {
    expect(resolveStageModel(input([SONNET_5], { forbidden: [UNKNOWN], projectChoice: { model: SONNET_5 } }))).toMatchObject({ kind: "resolved", model: SONNET_5 });
    expect(candidatesOf({ forbidden: [UNKNOWN] }, [SONNET_5])).toEqual([SONNET_5]);
  });

  it("does not take an unknown-prefix id as approved by someone else's approval", () => {
    expect(resolveStageModel(input([SONNET_5, UNKNOWN], { approved: [SONNET_5], projectChoice: { model: UNKNOWN } }))).toEqual({ kind: "refusal", code: "MODEL_NOT_ALLOWED_IN_PROJECT" });
  });
});

describe("the plan check's and the review's model choice", () => {
  it("leaves a jp or upper-case id of a forbidden model out, and prefers another model to a same-model one", () => {
    const jp = bedrock("jp.anthropic.claude-opus-5");
    const upper = bedrock("US.anthropic.claude-opus-5");
    expect(candidatesOf({ forbidden: [OPUS_5] }, [jp, upper, SONNET_5])).toEqual([SONNET_5]);
    expect(recommendCriticModel({}, OPUS_5, [jp, SONNET_5])).toEqual({ model: SONNET_5, sameModelAsPlanner: false });
    expect(recommendCriticModel({}, OPUS_5, [jp])).toEqual({ model: jp, sameModelAsPlanner: true });
    expect(recommendCriticModel({}, OPUS_5, [upper])).toEqual({ model: upper, sameModelAsPlanner: true });
  });

  it("leaves an unknown-prefix id out whenever something is forbidden, and never offers it as different", () => {
    expect(candidatesOf({ forbidden: [SONNET_5] }, [UNKNOWN, OPUS_5])).toEqual([OPUS_5]);
    expect(recommendCriticModel({}, SONNET_5, [UNKNOWN])).toEqual({ model: UNKNOWN, sameModelAsPlanner: true });
    expect(recommendCriticModel({}, UNKNOWN, [OPUS_5])).toEqual({ model: OPUS_5, sameModelAsPlanner: true });
    expect(recommendCriticModel({}, SONNET_5, [UNKNOWN, OPUS_5])).toEqual({ model: OPUS_5, sameModelAsPlanner: false });
  });

  it("does not treat an unknown-prefix id as approved by every approved entry", () => {
    expect(candidatesOf({ approved: [SONNET_5] }, [UNKNOWN, SONNET_5])).toEqual([SONNET_5]);
  });

  it("reviews on a model other than the builder's across geographies, and says so when only the builder's own is left", () => {
    const jp = bedrock("jp.anthropic.claude-opus-5");
    const base = { step: undefined, project: {}, guardrails: { forbiddenModels: [] as ModelIdentifier[] } };
    expect(reviewerModelFor({ ...base, builderModel: OPUS_5, sources: [jp, SONNET_5] })).toEqual({ chosenBy: "rovara", model: { provider: "anthropic", modelId: "claude-sonnet-5" }, sameModelAsBuilder: false });
    expect(reviewerModelFor({ ...base, builderModel: OPUS_5, sources: [jp] })).toEqual({ chosenBy: "rovara", model: { provider: "amazon-bedrock", modelId: "jp.anthropic.claude-opus-5" }, sameModelAsBuilder: true });
    expect(reviewerModelFor({ ...base, builderModel: SONNET_5, sources: [UNKNOWN] })).toMatchObject({ chosenBy: "rovara", sameModelAsBuilder: true });
    expect(reviewerModelFor({ ...base, builderModel: SONNET_5, sources: [UNKNOWN, OPUS_5] })).toMatchObject({ model: { modelId: "claude-opus-5" }, sameModelAsBuilder: false });
  });
});

/** The name the model proxy's aliases were built from before 0.4.29. A literal copy, so a change to the shipped function shows up here. */
const FROZEN_ALIAS_NAME = (model: ModelIdentifier): string => {
  let id = model.modelId;
  if (model.provider === "amazon-bedrock") id = id.replace(/^(?:us|eu|apac|global)\./, "").replace(/^anthropic\./, "");
  if (model.provider === "openrouter") id = id.replace(/^[^/]+\//, "");
  return id.replace(/-v\d+:\d+$/, "").replace(/-\d{8}$/, "").toLowerCase().replaceAll(".", "-");
};
const CATALOG: ModelIdentifier[] = [
  ...amazonBedrockProvider().getModels().map((entry) => bedrock(entry.id)),
  ...anthropicProvider().getModels().map((entry) => ({ provider: "anthropic", modelId: entry.id })),
  ...openaiProvider().getModels().map((entry) => ({ provider: "openai", modelId: entry.id })),
  ...openrouterProvider().getModels().map((entry) => ({ provider: "openrouter", modelId: entry.id })),
];

/** An independent reading of a catalog id as the model it names: no geography, no maker (a Bedrock prefix or an OpenRouter directory), no variant, revision, version or date. */
const MODEL_ONLY = (model: ModelIdentifier): string => {
  let id = model.modelId.toLowerCase();
  if (model.provider === "amazon-bedrock") id = id.replace(/^(?:us-gov|us|eu|apac|global|au|jp|in|ca)\./, "").replace(/^[a-z0-9]+\./, "");
  if (model.provider === "openrouter") id = id.replace(/^[^/]+\//, "");
  return id.replace(/:[a-z][a-z0-9_-]*$/, "").replace(/-1:0$/, "").replace(/:\d+$/, "").replace(/-v\d+$/, "").replace(/-\d{8}$/, "").replaceAll(".", "-");
};

describe("proxy aliases and stored sources do not move", () => {
  it("names every catalog model's alias exactly as before, though canonicalModelName now reads more of it", () => {
    expect(CATALOG.length).toBeGreaterThan(300);
    let moved = 0;
    for (const model of CATALOG) {
      expect(legacyAliasModelName(model), model.modelId).toBe(FROZEN_ALIAS_NAME(model));
      expect(sourceAlias("org_aaaaaaaaaaaaaaaaaaaa", "src_bbbbbbbbbbbbbbbbbbbb", model), model.modelId).toBe(`org_aaaaaaaaaaaaaaaaaaaa.src_bbbbbbbbbbbbbbbbbbbb.${FROZEN_ALIAS_NAME(model)}`);
      if (canonicalModelName(model) !== FROZEN_ALIAS_NAME(model)) moved += 1;
    }
    // The canonical name did move for these (so the test above is not vacuous): geographies, bare -vN and OpenRouter variants.
    expect(moved).toBeGreaterThan(100);
  });

  it("still reads a stored source that lists the us. and the jp. form of one model", () => {
    const source = {
      kind: "bedrock", sourceId: "src_bbbbbbbbbbbbbbbbbbbb", label: "Company", roleArn: "arn:aws:iam::123456789012:role/test-models", region: "us-west-2", externalId: "rovara-org_aaaaaaaaaaaaaaaaaaaa", tested: true,
      models: [{ catalog: bedrock("us.anthropic.claude-sonnet-5") }, { catalog: bedrock("jp.anthropic.claude-sonnet-5") }],
    };
    expect(ModelSourceSchema.safeParse(source).success).toBe(true);
    // A real duplicate is still refused.
    expect(ModelSourceSchema.safeParse({ ...source, models: [{ catalog: bedrock("us.anthropic.claude-sonnet-5") }, { catalog: bedrock("anthropic.claude-sonnet-5") }] }).success).toBe(false);
  });
});

describe("a bare version and an OpenRouter variant do not make another model", () => {
  const OPUS_46: ModelIdentifier = { provider: "anthropic", modelId: "claude-opus-4-6" };
  it("reads us.anthropic.claude-opus-4-6-v1 and anthropic/claude-opus-4.6:batch as claude-opus-4-6", () => {
    for (const model of [bedrock("us.anthropic.claude-opus-4-6-v1"), bedrock("global.anthropic.claude-opus-4-6-v1"), bedrock("anthropic.claude-opus-4-6-v1:0"), { provider: "openrouter", modelId: "anthropic/claude-opus-4.6:batch" }, { provider: "openrouter", modelId: "anthropic/claude-opus-4.6" }]) {
      expect(canonicalModelName(model), model.modelId).toBe("claude-opus-4-6");
      expect(forbiddenModelMatcher([OPUS_46])(model), model.modelId).toBe(true);
      expect(sameModelOrUnrecognised(model, OPUS_46), model.modelId).toBe(true);
    }
    expect(recommendCriticModel({}, OPUS_46, [bedrock("us.anthropic.claude-opus-4-6-v1")])).toMatchObject({ sameModelAsPlanner: true });
  });

  it("does not collapse a version number that is part of a name (a deepseek or a qwen model)", () => {
    expect(canonicalModelName({ provider: "openrouter", modelId: "deepseek/deepseek-v3" })).toBe("deepseek-v3");
    expect(canonicalModelName({ provider: "openrouter", modelId: "deepseek/deepseek-v3.2" })).toBe("deepseek-v3-2");
    expect(canonicalModelName(bedrock("deepseek.v3-v1:0"))).toBe("deepseek-v3");
    expect(canonicalModelName(bedrock("deepseek.v3.2"))).toBe("deepseek-v3-2");
  });

  it("collapses nothing in the catalogs except the same model on another geography, version suffix or variant", () => {
    const byName = new Map<string, ModelIdentifier[]>();
    for (const model of CATALOG) byName.set(canonicalModelName(model), [...(byName.get(canonicalModelName(model)) ?? []), model]);
    const unexplained = [...byName].filter(([, models]) => new Set(models.map(FROZEN_ALIAS_NAME)).size > 1 && new Set(models.map(MODEL_ONLY)).size > 1).map(([name, models]) => `${name}: ${models.map((model) => `${model.provider}:${model.modelId}`).join(" | ")}`);
    expect(unexplained).toEqual([]);
  });
});

describe("one name for a model across Bedrock, OpenRouter and its maker's own API", () => {
  const openrouter = (modelId: string): ModelIdentifier => ({ provider: "openrouter", modelId });
  const PAIRS: Array<[string, ModelIdentifier, ModelIdentifier]> = [
    ["gpt-6-sol: openai vs bedrock", { provider: "openai", modelId: "gpt-6-sol" }, bedrock("us.openai.gpt-6-sol")],
    ["gpt-6-sol: openai vs openrouter", { provider: "openai", modelId: "gpt-6-sol" }, openrouter("openai/gpt-6-sol")],
    ["gpt-5.4: openai vs global bedrock", { provider: "openai", modelId: "gpt-5.4" }, bedrock("global.openai.gpt-5.4")],
    ["gpt-oss-120b: openrouter vs the -1:0 id", openrouter("openai/gpt-oss-120b"), bedrock("openai.gpt-oss-120b-1:0")],
    ["gpt-oss-120b: the plain bedrock id vs the -1:0 id", bedrock("openai.gpt-oss-120b"), bedrock("us-gov.openai.gpt-oss-120b-1:0")],
    ["gpt-oss-20b: openrouter :batch vs the -1:0 id", openrouter("openai/gpt-oss-20b:batch"), bedrock("openai.gpt-oss-20b-1:0")],
    ["qwen3-32b", openrouter("qwen/qwen3-32b"), bedrock("qwen.qwen3-32b-v1:0")],
    ["grok-4.6 (xai vs x-ai)", openrouter("x-ai/grok-4.6"), bedrock("global.xai.grok-4.6")],
    ["glm-4.7 (zai vs z-ai)", openrouter("z-ai/glm-4.7"), bedrock("zai.glm-4.7")],
    ["minimax-m2.1", openrouter("minimax/minimax-m2.1"), bedrock("minimax.minimax-m2.1")],
    ["kimi-k2.5 (moonshotai)", openrouter("moonshotai/kimi-k2.5"), bedrock("moonshotai.kimi-k2.5")],
    ["kimi-k2-thinking (moonshot vs moonshotai)", openrouter("moonshotai/kimi-k2-thinking"), bedrock("moonshot.kimi-k2-thinking")],
    ["nova-lite: amazon vs bedrock", openrouter("amazon/nova-lite-v1"), bedrock("us.amazon.nova-lite-v1:0")],
    ["deepseek-v3.2 stays one model", openrouter("deepseek/deepseek-v3.2"), bedrock("deepseek.v3.2")],
  ];

  it.each(PAIRS)("reads %s as one model: forbidden by either, never independent of the other", (_name, left, right) => {
    expect(canonicalModelName(left)).toBe(canonicalModelName(right));
    expect(forbiddenModelMatcher([left])(right)).toBe(true);
    expect(forbiddenModelMatcher([right])(left)).toBe(true);
    expect(sameModelOrUnrecognised(left, right)).toBe(true);
    expect(recommendCriticModel({}, left, [right])).toMatchObject({ sameModelAsPlanner: true });
    expect(reviewerModelFor({ step: undefined, project: {}, guardrails: { forbiddenModels: [] as ModelIdentifier[] }, builderModel: left, sources: [right] })).toMatchObject({ sameModelAsBuilder: true });
  });

  it("resolves a forbidden openai model out of a bedrock route, and keeps a different gpt model apart", () => {
    const candidate = { sourceId: "rovara", enabled: true, inEffectiveOrder: true, evidence: { orgId: "org_a", sourcesRevision: 2, kind: "rovara_catalog" as const } };
    const model = bedrock("us.openai.gpt-6-sol");
    const input: StageModelInput = { orgId: "org_a", stage: "build", sourcesRevision: 2, candidates: [{ ...candidate, model }], forbidden: [{ provider: "openai", modelId: "gpt-6-sol" }], approved: [model], builtinDefault: model, projectChoice: { model } };
    expect(resolveStageModel(input)).toEqual({ kind: "refusal", code: "MODEL_FORBIDDEN" });
    expect(forbiddenModelMatcher([{ provider: "openai", modelId: "gpt-6-sol" }])(bedrock("us.openai.gpt-6-luna"))).toBe(false);
    expect(forbiddenModelMatcher([{ provider: "openai", modelId: "gpt-5" }])(bedrock("us.openai.gpt-5-1:0"))).toBe(false);
    expect(canonicalModelName(bedrock("openai.gpt-5-1:0"))).toBe("gpt-5-1");
  });

  /** The canonical name of the first fix round (0.4.29 candidate): geography, `anthropic.`, revision and `-vN` stripped, but not other makers. */
  const PREVIOUS_CANONICAL = (model: ModelIdentifier): string => {
    let id = model.modelId;
    if (model.provider === "amazon-bedrock") id = id.toLowerCase().replace(/^(?:us-gov|us|eu|apac|global|au|jp|in|ca)\./, "").replace(/^anthropic\./, "").replace(/:\d+$/, "").replace(/-v\d+$/, "");
    if (model.provider === "openrouter") id = id.replace(/^[^/]+\//, "").replace(/:[a-z][a-z0-9_-]*$/i, "");
    return id.replace(/-v\d+:\d+$/, "").replace(/-\d{8}$/, "").toLowerCase().replaceAll(".", "-");
  };
  /** Every name this change newly merges, each one model sold under two spellings (maker named or not, revision suffix, the maker's directory spelling). A new merge not on this list fails the test. */
  const EXPECTED_NEW_MERGES = [
    "glm-4-7", "glm-4-7-flash", "glm-5", "glm-5-3", "gpt-5-4", "gpt-5-5", "gpt-5-6-luna", "gpt-5-6-sol", "gpt-5-6-terra", "gpt-6-1-sol", "gpt-6-astra", "gpt-6-luna", "gpt-6-sol",
    "gpt-oss-120b", "gpt-oss-20b", "gpt-oss-safeguard-20b", "grok-4-3", "grok-4-6", "grok-4-7", "kimi-k2-5", "kimi-k2-thinking", "kimi-k3", "minimax-m2", "minimax-m2-1", "minimax-m2-5",
    "nova-2-lite", "nova-lite", "nova-micro", "nova-premier", "nova-pro", "qwen3-235b-a22b-2507", "qwen3-32b", "qwen3-coder-next", "voxtral-small-24b-2507",
  ];

  it("merges exactly the listed names, each of one model written two ways, and no two different models", () => {
    const groups = new Map<string, ModelIdentifier[]>();
    for (const model of CATALOG) groups.set(canonicalModelName(model), [...(groups.get(canonicalModelName(model)) ?? []), model]);
    const merged = [...groups].filter(([, models]) => new Set(models.map(PREVIOUS_CANONICAL)).size > 1);
    expect(merged.map(([name]) => name).sort()).toEqual([...EXPECTED_NEW_MERGES].sort());
    // Each merged group is one model: stripping the geography, the maker, a variant, a revision and a version leaves one name.
    for (const [name, models] of merged) expect(new Set(models.map(MODEL_ONLY)).size, `${name}: ${models.map((m) => m.modelId).join(" | ")}`).toBe(1);
  });

  it("gives every catalog id the company it had before: Anthropic's models, the OpenAI and Gemini ids by name, Bedrock's own vendors (SH33), everything else other", () => {
    const FROZEN_COMPANY = (m: ModelIdentifier): string => {
      const provider = m.provider.toLowerCase();
      const id = m.modelId.toLowerCase();
      if (provider === "anthropic") return "anthropic";
      if (provider === "openai") return "openai";
      if (provider === "amazon-bedrock") {
        // SH33: Bedrock's own vendors are named from the id; any other vendor stays other.
        const vendor = id.replace(/^(?:us-gov|us|eu|apac|global|au|jp|in|ca)\./, "").split(".", 1)[0]!;
        return ["anthropic", "amazon", "meta", "mistral", "deepseek", "openai", "qwen", "cohere"].includes(vendor) ? vendor : "other";
      }
      if (provider === "openrouter") {
        if (id.startsWith("anthropic/")) return "anthropic";
        if (id.startsWith("openai/")) return "openai";
        if (id.startsWith("google/")) return "google";
      }
      if (id.startsWith("gpt-")) return "openai";
      if (id.startsWith("gemini")) return "google";
      return "other";
    };
    for (const model of CATALOG) expect(modelCompany(model), `${model.provider}:${model.modelId}`).toBe(FROZEN_COMPANY(model));
  });
});
