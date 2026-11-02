// A Bedrock inference-profile id names its model behind a geography prefix. Every prefix the pinned catalog uses must be stripped, so a forbidden model, a "different model" rule and a
// price all see one model whichever geography serves it; an id with a prefix nobody listed reads as unrecognised and fails closed (forbidden when anything is forbidden, never independent).
import { amazonBedrockProvider } from "@earendil-works/pi-ai/providers/amazon-bedrock";
import { describe, expect, it } from "vitest";
import {
  BEDROCK_REGION_PREFIXES, BEDROCK_VENDOR_PREFIXES, canonicalModelName, forbiddenModelMatcher, isUnrecognisedBedrockModel, modelCompany, sameModelOrUnrecognised, type ModelIdentifier,
} from "@agentx/contracts";
import { E2E_AGENT_ELIGIBLE_MODELS } from "../../packages/contracts/src/e2e-agent-models.generated.js";
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
      expect(canonicalModelName(bedrock(id))).toBe(canonicalModelName({ provider: "anthropic", modelId: id.slice(id.indexOf("claude-")) }));
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
    expect(canonicalModelName(bedrock("amazon.nova-lite-v1:0"))).toBe("amazon-nova-lite");
    expect(canonicalModelName(bedrock("us.amazon.nova-lite-v1:0"))).toBe("amazon-nova-lite");
    expect(canonicalModelName({ provider: "openrouter", modelId: "anthropic/claude-haiku-4.5" })).toBe("claude-haiku-4-5");
    expect(modelCompany(bedrock("eu.anthropic.claude-opus-5"))).toBe("anthropic");
    expect(modelCompany(bedrock("us.amazon.nova-lite-v1:0"))).toBe("other");
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
    // Not shaped <unknown>.<vendor>.*: left alone.
    expect(isUnrecognisedBedrockModel(bedrock("zz.claude-opus-5"))).toBe(false);
    expect(isUnrecognisedBedrockModel(bedrock("claude-opus-5"))).toBe(false);
    expect(isUnrecognisedBedrockModel({ provider: "openrouter", modelId: "zz.anthropic.claude-opus-5" })).toBe(false);
    expect(isUnrecognisedBedrockModel(bedrock("us.zz.claude-opus-5"))).toBe(false);
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
