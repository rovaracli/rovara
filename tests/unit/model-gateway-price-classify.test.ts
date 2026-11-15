import { beforeAll, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
const base = { mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 };
it("ports every dearest tier and rounds upwards independently", async () => {
  const { ratesOf, rateMicros } = await import("../../packages/model-gateway/src/price-classify.js");
  const inputs = ["cache_creation_input_token_cost", "cache_creation_input_token_cost_above_1hr", "input_cost_per_token_above_200k_tokens", "cache_read_input_token_cost", "input_cost_per_token_batches", "input_cost_per_token_flex", "input_cost_per_token_cache_hit"];
  const outputs = ["output_cost_per_reasoning_token", "output_cost_per_token_above_200k_tokens", "output_cost_per_token_batches", "output_cost_per_token_flex"];
  for (const field of inputs) {
    const optional = field === "cache_creation_input_token_cost" ? "cacheWrite5mMicrosPerMTok" : field === "cache_creation_input_token_cost_above_1hr" ? "cacheWrite1hMicrosPerMTok" : field === "cache_read_input_token_cost" || field === "input_cost_per_token_cache_hit" ? "cacheReadMicrosPerMTok" : undefined;
    expect(ratesOf({ ...base, [field]: 10.0000001e-6 }, 0)).toEqual({ inputMicrosPerMTok: optional !== undefined || field.includes("above_200k") ? 1_000_000 : 10_000_001, outputMicrosPerMTok: 2_000_000,
      ...(optional === undefined ? {} : { [optional]: 10_000_001 }), ...(field.includes("above_200k") ? { longContext: [{ aboveTokens: 200000, inputMicrosPerMTok: 10_000_001 }] } : {}) });
  }
  for (const field of outputs) expect(ratesOf({ ...base, [field]: 20e-6 }, 0)).toEqual({ inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: field.includes("above_200k") ? 2_000_000 : 20_000_000, ...(field.includes("above_200k") ? { longContext: [{ aboveTokens: 200000, outputMicrosPerMTok: 20_000_000 }] } : {}) });
  expect(rateMicros(1.0000001e-6)).toBe(1_000_001);
  expect(rateMicros(1.0000000000000002e-6)).toBe(1_000_000);
});
it("unknown price fields stay unknown, metadata is harmless, invalid and unit prices have fixed reasons", async () => {
  const { ratesOf } = await import("../../packages/model-gateway/src/price-classify.js");
  expect(ratesOf({ ...base, harmless_metadata: "private-canary" }, 0)).toEqual({ inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000 });
  for (const extra of [{ secret_price: 1 }, { cost_per_request: 0 }, { input_cost_per_token: 0 }, { output_cost_per_token: -1 }, { input_cost_per_token: 0.002 }, { mode: "image" }, { deprecation_date: "private-canary" }]) {
    const result = ratesOf({ ...base, ...extra }, 0); expect(typeof result).toBe("string"); expect(JSON.stringify(result)).not.toContain("private-canary");
  }
});
it("unserved cost fields name known gateway features", async () => {
  const { UNSERVED_FEATURE_COST_FIELDS } = await import("../../packages/model-gateway/src/price-classify.js");
  const { GATEWAY_FEATURE_NAMES } = await import("../../packages/model-gateway/src/guard.js");
  for (const [field, entry] of Object.entries(UNSERVED_FEATURE_COST_FIELDS)) {
    expect(GATEWAY_FEATURE_NAMES, `${field} must name a known gateway feature`).toContain(entry.feature);
    expect(entry.reason).toEqual(expect.any(String));
  }
});
it("unserved cost fields cannot exclude exposed gateway features", async () => {
  const { UNSERVED_FEATURE_COST_FIELDS } = await import("../../packages/model-gateway/src/price-classify.js");
  const { GATEWAY_EXPOSED_FEATURES } = await import("../../packages/model-gateway/src/guard.js");
  expect(GATEWAY_EXPOSED_FEATURES).toBeDefined();
  for (const [field, { feature }] of Object.entries(UNSERVED_FEATURE_COST_FIELDS)) {
    expect(GATEWAY_EXPOSED_FEATURES.has(feature), `${field} is listed as unserved but ${feature} is now exposed; remove the entry so the row is priced or marked uncertain`).toBe(false);
  }
});
