// DECISIONS 172 (d): Rovara's small override list of VERIFIED prices for models LiteLLM's bundled cost map lacks. A model with no price at all is not in it: the guard holds and settles it
// cautiously (tests/contract/model-proxy-unpriced.test.ts). The figures are AWS's own (Price List API, offer AmazonBedrockFoundationModels, publication 2026-11-09T22:43:12Z).
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { litellmConfig } from "../../packages/model-proxy/src/litellm-config.js";
import { BEDROCK_PRICE_OVERRIDES, bedrockClaudeModelIds, bedrockPriceOverride, bedrockProxyModels } from "../../packages/model-runtime/src/catalog.js";

describe("the verified price overrides", () => {
  it("are AWS's prices: Haiku 5.5 $0.11 in and $0.55 out on a geographic profile, five times that above 100,000 input tokens, $0.10 and $0.50 on the global profile", () => {
    expect(bedrockPriceOverride("us.anthropic.claude-haiku-5-5")).toEqual({
      input: 1.1e-7, output: 5.5e-7, cacheRead: 1.1e-8, cacheWrite: 1.375e-7,
      tiers: [{ inputTokensAbove: 100_000, input: 5.5e-7, output: 2.75e-6, cacheRead: 5.5e-8, cacheWrite: 6.875e-7 }], maxInputTokens: 1_000_000, maxOutputTokens: 128_000,
    });
    expect(bedrockPriceOverride("eu.anthropic.claude-haiku-5-5")).toEqual(bedrockPriceOverride("us.anthropic.claude-haiku-5-5"));
    expect(bedrockPriceOverride("global.anthropic.claude-haiku-5-5")).toMatchObject({ input: 1e-7, output: 5e-7, tiers: [{ inputTokensAbove: 100_000, input: 5e-7, output: 2.5e-6 }] });
  });

  it("are AWS's prices for Fable 5.2: $8.80 in and $44 out on a geographic profile, $8 and $40 global, with no long-context tier", () => {
    expect(bedrockPriceOverride("us.anthropic.claude-fable-5-2")).toMatchObject({ input: 8.8e-6, output: 4.4e-5, cacheRead: 2.2e-7, cacheWrite: 1.1e-5 });
    expect(bedrockPriceOverride("global.anthropic.claude-fable-5-2")).toMatchObject({ input: 8e-6, output: 4e-5 });
    expect(bedrockPriceOverride("us.anthropic.claude-fable-5-2")!.tiers).toBeUndefined();
  });

  it("list nothing else: a model that is not listed has no override and is left to LiteLLM's map, the refresh and the guard's estimate", () => {
    expect(Object.keys(BEDROCK_PRICE_OVERRIDES).sort()).toEqual(["anthropic.claude-fable-5-2", "anthropic.claude-haiku-5-5"]);
    expect(bedrockPriceOverride("us.anthropic.claude-sonnet-4-6")).toBeUndefined();
    expect(bedrockPriceOverride("us.anthropic.claude-not-a-model")).toBeUndefined();
  });

  it("reach the proxy's config, marked as Rovara's override (so a refresh from AWS replaces them), for those models only", () => {
    for (const geography of ["us", "eu"]) {
      const models = bedrockProxyModels(geography);
      expect(models.map(({ id }) => id)).toEqual(bedrockClaudeModelIds(geography));
      expect(models.filter(({ prices }) => prices !== undefined).map(({ id }) => id.slice(geography.length + 1)).sort()).toEqual(geography === "us" ? ["anthropic.claude-fable-5-2", "anthropic.claude-haiku-5-5"] : ["anthropic.claude-haiku-5-5"]);
    }
    const parsed = parse(litellmConfig({ region: "us-west-2", models: bedrockProxyModels("us") })) as { model_list: Array<{ model_name: string; model_info?: Record<string, unknown> }> };
    const haiku = parsed.model_list.find((entry) => entry.model_name === "us.anthropic.claude-haiku-5-5")!;
    expect(haiku.model_info).toMatchObject({ input_cost_per_token: 1.1e-7, output_cost_per_token: 5.5e-7, output_cost_per_token_above_100k_tokens: 2.75e-6, rovara_price_override: true });
    expect(parsed.model_list.filter((entry) => entry.model_info !== undefined)).toHaveLength(2);
  });
});
