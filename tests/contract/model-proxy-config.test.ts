import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { litellmConfig } from "../../packages/model-proxy/src/litellm-config.js";

describe("LiteLLM config generator", () => {
  const models = [{ id: "us.anthropic.claude-sonnet-4-6" }, { id: "us.anthropic.claude-haiku-4-5-20251001-v1:0" }];

  it("emits one Bedrock entry per model, aliased to its own catalog id", () => {
    expect(litellmConfig({ region: "us-east-1", models })).toBe(`model_list:
  - model_name: "us.anthropic.claude-sonnet-4-6"
    litellm_params:
      model: "bedrock/us.anthropic.claude-sonnet-4-6"
      aws_region_name: "us-east-1"
  - model_name: "us.anthropic.claude-haiku-4-5-20251001-v1:0"
    litellm_params:
      model: "bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0"
      aws_region_name: "us-east-1"
litellm_settings:
  callbacks: rovara_guard.proxy_handler_instance
general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
  database_url: os.environ/DATABASE_URL
  user_api_key_cache_ttl: 10
  disable_budget_reservation: true
router_settings:
  num_retries: 0
`);
  });

  it("is valid YAML that LiteLLM reads back as the same structure", () => {
    expect(parse(litellmConfig({ region: "eu-west-1", models }))).toEqual({
      model_list: models.map(({ id }) => ({ model_name: id, litellm_params: { model: `bedrock/${id}`, aws_region_name: "eu-west-1" } })),
      litellm_settings: { callbacks: "rovara_guard.proxy_handler_instance" },
      general_settings: { master_key: "os.environ/LITELLM_MASTER_KEY", database_url: "os.environ/DATABASE_URL", user_api_key_cache_ttl: 10, disable_budget_reservation: true },
      router_settings: { num_retries: 0 },
    });
  });

  it("never carries a secret value, only references to environment variables", () => {
    const config = litellmConfig({ region: "us-east-1", models });
    expect(config).not.toMatch(/\bapi_key\b|aws_secret|aws_access/i);
    // The settings that would let a request bring its own credentials or have its headers forwarded stay unset (spike, question 8).
    expect(config).not.toMatch(/configurable_clientside_auth_params|allow_client_side_credentials|forward_client_headers_to_llm_api/);
  });

  it("refuses an empty model list and ids that are not safe to quote", () => {
    expect(() => litellmConfig({ region: "us-east-1", models: [] })).toThrow("at least one model");
    expect(() => litellmConfig({ region: "", models })).toThrow("region");
    expect(() => litellmConfig({ region: "us-east-1", models: [{ id: "bad\nid" }] })).toThrow("model id");
    expect(() => litellmConfig({ region: "us-east-1", models: [{ id: "us.anthropic.claude-sonnet-4-6" }, { id: "us.anthropic.claude-sonnet-4-6" }] })).toThrow("twice");
  });

  describe("a model's own prices (for a model LiteLLM's cost map lacks)", () => {
    const prices = {
      input: 1.1e-7, output: 5.5e-7, cacheRead: 1.1e-8, cacheWrite: 1.375e-7,
      tiers: [{ inputTokensAbove: 100_000, input: 5.5e-7, output: 2.75e-6, cacheRead: 5.5e-8, cacheWrite: 6.875e-7 }],
      maxInputTokens: 1_000_000, maxOutputTokens: 128_000,
    };
    const priced = [{ id: "us.anthropic.claude-haiku-5-5", prices }, { id: "us.anthropic.claude-sonnet-4-6" }];

    it("writes them as that model's model_info, in plain decimals, and leaves a model without prices exactly as it was", () => {
      const config = litellmConfig({ region: "us-west-2", models: priced });
      expect(config).toContain(`  - model_name: "us.anthropic.claude-haiku-5-5"
    litellm_params:
      model: "bedrock/us.anthropic.claude-haiku-5-5"
      aws_region_name: "us-west-2"
    model_info:
      input_cost_per_token: 0.00000011
      output_cost_per_token: 0.00000055
      cache_read_input_token_cost: 0.000000011
      cache_creation_input_token_cost: 0.0000001375
      input_cost_per_token_above_100k_tokens: 0.00000055
      output_cost_per_token_above_100k_tokens: 0.00000275
      cache_read_input_token_cost_above_100k_tokens: 0.000000055
      cache_creation_input_token_cost_above_100k_tokens: 0.0000006875
      max_input_tokens: 1000000
      max_output_tokens: 128000
  - model_name: "us.anthropic.claude-sonnet-4-6"
    litellm_params:
      model: "bedrock/us.anthropic.claude-sonnet-4-6"
      aws_region_name: "us-west-2"
litellm_settings:`);
      expect(litellmConfig({ region: "us-east-1", models })).toBe(litellmConfig({ region: "us-east-1", models: models.map(({ id }) => ({ id })) }));
    });

    it("reads back as numbers (never exponent text, which PyYAML would read as a string)", () => {
      const parsed = parse(litellmConfig({ region: "us-west-2", models: priced })) as { model_list: Array<{ model_info?: Record<string, unknown> }> };
      const info = parsed.model_list[0]!.model_info!;
      expect(info).toEqual({
        input_cost_per_token: 1.1e-7, output_cost_per_token: 5.5e-7, cache_read_input_token_cost: 1.1e-8, cache_creation_input_token_cost: 1.375e-7,
        input_cost_per_token_above_100k_tokens: 5.5e-7, output_cost_per_token_above_100k_tokens: 2.75e-6, cache_read_input_token_cost_above_100k_tokens: 5.5e-8,
        cache_creation_input_token_cost_above_100k_tokens: 6.875e-7, max_input_tokens: 1_000_000, max_output_tokens: 128_000,
      });
      expect(parsed.model_list[1]!.model_info).toBeUndefined();
      expect(litellmConfig({ region: "us-west-2", models: priced })).not.toMatch(/\d[eE][-+]?\d/);
    });

    it("marks a verified override of Rovara's own, which the guard's refresh may replace", () => {
      const parsed = parse(litellmConfig({ region: "us-west-2", models: [{ id: "us.anthropic.claude-haiku-5-5", prices: { ...prices, override: true } }] })) as { model_list: Array<{ model_info: Record<string, unknown> }> };
      expect(parsed.model_list[0]!.model_info["rovara_price_override"]).toBe(true);
      expect(Object.keys((parse(litellmConfig({ region: "us-west-2", models: priced })) as { model_list: Array<{ model_info: Record<string, unknown> }> }).model_list[0]!.model_info)).not.toContain("rovara_price_override");
    });

    it("refuses a price that is zero, negative, not a number or finer than twelve decimals, and a tier that LiteLLM could not name", () => {
      const refuse = (changed: Record<string, unknown>) => () => litellmConfig({ region: "us-west-2", models: [{ id: "us.anthropic.claude-haiku-5-5", prices: { ...prices, ...changed } }] });
      expect(refuse({ input: 0 })).toThrow("input price must be a positive number");
      expect(refuse({ output: -1e-7 })).toThrow("output price");
      expect(refuse({ input: Number.NaN })).toThrow("input price");
      expect(refuse({ output: Number.POSITIVE_INFINITY })).toThrow("output price");
      expect(refuse({ cacheRead: 0 })).toThrow("cache read price");
      expect(refuse({ input: 1.1e-13 })).toThrow("does not fit");
      expect(refuse({ maxOutputTokens: 0 })).toThrow("output limit");
      expect(refuse({ tiers: [{ ...prices.tiers[0]!, inputTokensAbove: 100_500 }] })).toThrow("whole number of thousands");
      expect(refuse({ tiers: [{ ...prices.tiers[0]!, output: 0 }] })).toThrow("output price");
      expect(refuse({ tiers: [prices.tiers[0]!, prices.tiers[0]!] })).toThrow("twice");
    });
  });
});
