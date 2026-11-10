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
`);
  });

  it("is valid YAML that LiteLLM reads back as the same structure", () => {
    expect(parse(litellmConfig({ region: "eu-west-1", models }))).toEqual({
      model_list: models.map(({ id }) => ({ model_name: id, litellm_params: { model: `bedrock/${id}`, aws_region_name: "eu-west-1" } })),
      litellm_settings: { callbacks: "rovara_guard.proxy_handler_instance" },
      general_settings: { master_key: "os.environ/LITELLM_MASTER_KEY", database_url: "os.environ/DATABASE_URL", user_api_key_cache_ttl: 10, disable_budget_reservation: true },
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
});
