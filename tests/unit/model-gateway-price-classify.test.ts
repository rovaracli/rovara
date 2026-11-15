import { beforeAll, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
const base = { mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 };
it("ports every dearest tier and rounds upwards independently", async () => {
  const { ratesOf, rateMicros } = await import("../../packages/model-gateway/src/price-classify.js");
  const inputs = ["input_cost_per_audio_token", "input_cost_per_image_token", "cache_creation_input_token_cost", "cache_creation_input_token_cost_above_1hr", "input_cost_per_token_above_200k_tokens", "input_cost_per_token_priority", "cache_read_input_token_cost", "input_cost_per_token_batches", "input_cost_per_token_flex", "input_cost_per_token_cache_hit"];
  const outputs = ["output_cost_per_audio_token", "output_cost_per_image_token", "output_cost_per_reasoning_token", "output_cost_per_token_above_200k_tokens", "output_cost_per_token_priority", "output_cost_per_token_batches", "output_cost_per_token_flex"];
  for (const field of inputs) expect(ratesOf({ ...base, [field]: 10.0000001e-6 }, 0)).toEqual({ inputMicrosPerMTok: 10_000_001, outputMicrosPerMTok: 2_000_000 });
  for (const field of outputs) expect(ratesOf({ ...base, [field]: 20e-6 }, 0)).toEqual({ inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 20_000_000 });
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
