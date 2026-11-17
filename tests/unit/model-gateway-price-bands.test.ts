// PRICE-BANDS (2026-11-17), follow-up to PR #88. Two offered Bedrock models were still charged the cautious estimate:
// 1. Claude Haiku 5.5: LiteLLM prices it from 100k prompt tokens up (the price tiers held only 128k and 200k), and fetchAWS put AWS's
//    `_long_ctx` rates at 200k. AWS's offer never states where that band starts, so pooling now reads it from the model's LiteLLM rows
//    (only ever earlier). Every band LiteLLM uses is now allowed: 32k, 100k, 128k, 200k, 256k, 272k, 512k.
// 2. Claude Haiku 4.5: its EU row is past its deprecation date (2026-10-15). A deprecated row with every field known now prices its
//    identity, but only when no non-deprecated row names it; then one log line per refresh says how many identities used one.
import { beforeAll, describe, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { fetchAWS, fetchLiteLLM } from "../../packages/model-gateway/src/price-sources.js";
import { InMemoryPriceSnapshotStore } from "../../packages/model-gateway/src/price-snapshot.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { PriceRefresher } from "../../packages/model-gateway/src/price-refresh.js";
import { resolvePrice } from "../../packages/model-gateway/src/price.js";
import { ratesForUsage } from "../../packages/model-gateway/src/price-tiers.js";
import { ratesOf } from "../../packages/model-gateway/src/price-classify.js";
beforeAll(denyNetwork);

const now = Date.UTC(2026, 10, 17);
const transport = (body: unknown) => ({ get: async () => ({ status: 200, body: Buffer.from(JSON.stringify(body)) }) });
/** The real us-west-2 AWS rows for Claude Haiku 5.5 (public AmazonBedrockFoundationModels offer, 2026-11-17), dollars per 1M tokens. */
const HAIKU_5_5_AWS: ReadonlyArray<readonly [string, string]> = [
  ["input_tokens", "0.11"], ["output_tokens", "0.55"], ["cache_read_tokens", "0.011"], ["cache_write_tokens", "0.1375"], ["cache_write_tokens_1h", "0.22"],
  ["input_tokens_long_ctx", "0.55"], ["output_tokens_long_ctx", "2.75"], ["cache_read_tokens_long_ctx", "0.055"], ["cache_write_tokens_long_ctx", "0.6875"], ["cache_write_tokens_1h_long_ctx", "1.1"],
];
function offer(models: Record<string, ReadonlyArray<readonly [string, string]>>) {
  const products: Record<string, unknown> = {}; const terms: Record<string, unknown> = {};
  for (const [name, rows] of Object.entries(models)) rows.forEach(([usage, usd]) => {
    const sku = `${name}-${usage}`;
    products[sku] = { attributes: { model: name, usagetype: `USW2-MP:USW2_${usage}_standard-Units` } };
    terms[sku] = { T: { priceDimensions: { D: { unit: "1M tokens", pricePerUnit: { USD: usd } } } } };
  });
  return { products, terms: { OnDemand: terms } };
}
/** LiteLLM's real us row for Haiku 5.5 (raw.githubusercontent.com/BerriAI/litellm main, 2026-11-17). */
const HAIKU_5_5_LITELLM = { litellm_provider: "bedrock_converse", mode: "chat", input_cost_per_token: 1.1e-7, output_cost_per_token: 5.5e-7, cache_read_input_token_cost: 1.1e-8, cache_creation_input_token_cost: 1.375e-7, cache_creation_input_token_cost_above_1hr: 2.2e-7, input_cost_per_token_above_100k_tokens: 5.5e-7, output_cost_per_token_above_100k_tokens: 2.75e-6, cache_read_input_token_cost_above_100k_tokens: 5.5e-8, cache_creation_input_token_cost_above_100k_tokens: 6.875e-7, cache_creation_input_token_cost_above_1hr_above_100k_tokens: 1.1e-6 };
const unrelated = { "gpt-x": { litellm_provider: "openai", mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 } };
async function refreshed(litellm: Record<string, unknown>, aws: Record<string, ReadonlyArray<readonly [string, string]>>, logs: unknown[] = []) {
  const store = new InMemoryPriceSnapshotStore(); const prices = new SnapshotPriceSource(store, { now: () => now, overrides: [] });
  const r = await new PriceRefresher({ store, prices, log: (line) => logs.push(line),
    litellm: (previous) => fetchLiteLLM(transport({ ...unrelated, ...litellm }), { previous, now, minModels: 1 }),
    aws: (previous) => fetchAWS(transport(offer({ "Unrelated Model": [["input_tokens", "1"], ["output_tokens", "2"]], ...aws })), { previous, now, minModels: 1, regions: ["us-west-2"] }),
  }).run(now);
  expect(r.ok).toBe(true);
  return prices;
}
const BASE = { inputMicrosPerMTok: 110_000, outputMicrosPerMTok: 550_000 };
const LONG = { inputMicrosPerMTok: 550_000, outputMicrosPerMTok: 2_750_000 };
const pick = (r: { inputMicrosPerMTok: number; outputMicrosPerMTok: number }) => ({ inputMicrosPerMTok: r.inputMicrosPerMTok, outputMicrosPerMTok: r.outputMicrosPerMTok });

describe("every long-context band LiteLLM uses", () => {
  it("is kept as its own band; a band LiteLLM does not use leaves the row unknown", () => {
    const base = { mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 };
    for (const k of [32, 100, 128, 200, 256, 272, 512]) {
      expect([k, ratesOf({ ...base, [`input_cost_per_token_above_${k}k_tokens`]: 3e-6 }, now)]).toEqual([k, { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, longContext: [{ aboveTokens: k * 1000, inputMicrosPerMTok: 3_000_000 }] }]);
    }
    // Two bands in one row (LiteLLM's Qwen rows: 32k and 256k) stay two bands, in order.
    expect(ratesOf({ ...base, input_cost_per_token_above_256k_tokens: 5e-6, input_cost_per_token_above_32k_tokens: 3e-6 }, now)).toEqual({ inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, longContext: [{ aboveTokens: 32_000, inputMicrosPerMTok: 3_000_000 }, { aboveTokens: 256_000, inputMicrosPerMTok: 5_000_000 }] });
    for (const k of [64, 300, 1000, 1100]) expect([k, ratesOf({ ...base, [`input_cost_per_token_above_${k}k_tokens`]: 3e-6 }, now)]).toEqual([k, "unsupported price field"]);
  });
});

describe("Claude Haiku 5.5: AWS's long-context rates start at the band LiteLLM states (100k), never at a hardcoded 200k", () => {
  it("is priced from its rows, not the cautious estimate, with the long rates from 100,001 prompt tokens", async () => {
    const prices = await refreshed({ "us.anthropic.claude-haiku-5-5": HAIKU_5_5_LITELLM }, { "Claude Haiku 5.5": HAIKU_5_5_AWS });
    const p = await resolvePrice(prices, "bedrock", "us.anthropic.claude-haiku-5-5");
    expect([p.estimated, pick(p)]).toEqual([false, BASE]);
    // The band boundary: strictly above 100,000 prompt tokens; 100,000-200,000 tokens is NOT charged the base rate.
    for (const [tokens, rates] of [[99_999, BASE], [100_000, BASE], [100_001, LONG], [150_000, LONG], [200_000, LONG], [200_001, LONG]] as const) expect([tokens, pick(ratesForUsage(p, tokens))]).toEqual([tokens, rates]);
  });
  it("the AWS row alone moves to the LiteLLM band: a LiteLLM row with only a 100k base band still brings AWS's dearer long rates to 100k", async () => {
    // LiteLLM states the band (and a cheap long rate); AWS's own long rates are dearer. The AWS rates must apply from 100k, not 200k.
    const cheapLong = { ...HAIKU_5_5_LITELLM, input_cost_per_token_above_100k_tokens: 1.2e-7, output_cost_per_token_above_100k_tokens: 6e-7 };
    const prices = await refreshed({ "us.anthropic.claude-haiku-5-5": cheapLong }, { "Claude Haiku 5.5": HAIKU_5_5_AWS });
    const p = await resolvePrice(prices, "bedrock", "us.anthropic.claude-haiku-5-5");
    expect(p.longContext?.map((t) => t.aboveTokens)).toEqual([100_000]);
    for (const tokens of [100_001, 150_000, 200_000]) expect([tokens, pick(ratesForUsage(p, tokens))]).toEqual([tokens, LONG]);
  });
  it("without a LiteLLM band the AWS long rates keep the 200k fallback (today's behaviour), and a later LiteLLM band never moves them later", async () => {
    const alone = await refreshed({}, { "Claude Haiku 5.5": HAIKU_5_5_AWS });
    expect((await resolvePrice(alone, "bedrock", "us.anthropic.claude-haiku-5-5")).longContext?.map((t) => t.aboveTokens)).toEqual([200_000]);
    // LiteLLM says 272k (its OpenAI rows); AWS's long rates still apply above 200k.
    const late = { ...HAIKU_5_5_LITELLM }; for (const f of Object.keys(late)) if (f.includes("_above_100k_tokens")) { const v = late[f as keyof typeof late]; delete late[f as keyof typeof late]; Object.assign(late, { [f.replace("100k", "272k")]: v }); }
    const prices = await refreshed({ "us.anthropic.claude-haiku-5-5": late }, { "Claude Haiku 5.5": HAIKU_5_5_AWS });
    const p = await resolvePrice(prices, "bedrock", "us.anthropic.claude-haiku-5-5");
    expect(p.longContext?.map((t) => t.aboveTokens)).toEqual([200_000, 272_000]);
    for (const [tokens, rates] of [[200_000, BASE], [200_001, LONG], [272_001, LONG]] as const) expect([tokens, pick(ratesForUsage(p, tokens))]).toEqual([tokens, rates]);
  });
  it("of several LiteLLM bands for one identity, the lowest wins", async () => {
    const eu = { ...HAIKU_5_5_LITELLM, input_cost_per_token_above_32k_tokens: 1.1e-7 };
    const prices = await refreshed({ "us.anthropic.claude-haiku-5-5": HAIKU_5_5_LITELLM, "eu.anthropic.claude-haiku-5-5": eu }, { "Claude Haiku 5.5": HAIKU_5_5_AWS });
    const p = await resolvePrice(prices, "bedrock", "us.anthropic.claude-haiku-5-5");
    expect([p.estimated, p.longContext?.[0]?.aboveTokens]).toEqual([false, 32_000]);
    expect(pick(ratesForUsage(p, 32_001))).toEqual(LONG);
  });
});

/** LiteLLM's real Haiku 4.5 rows (2026-11-17): the US row is live; the EU row is past its deprecation date. */
const HAIKU_4_5_US = { litellm_provider: "bedrock_converse", mode: "chat", input_cost_per_token: 1.1e-6, output_cost_per_token: 5.5e-6, cache_read_input_token_cost: 1.1e-7, cache_creation_input_token_cost: 1.375e-6, cache_creation_input_token_cost_above_1hr: 2.2e-6 };
const HAIKU_4_5_EU = { ...HAIKU_4_5_US, deprecation_date: "2026-10-15", input_cost_per_token_batches: 5.5e-7, output_cost_per_token_batches: 2.75e-6 };
const HAIKU_45 = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const used = (logs: unknown[]) => logs.filter((l) => (l as { event?: string }).event === "price_deprecated_used");
describe("a deprecated row with every field known", () => {
  it("is only an alias when a live row names the identity (the live row's price holds, no log)", async () => {
    const logs: unknown[] = [];
    // The deprecated row is dearer here: it still does not price an identity that has a live row.
    const prices = await refreshed({ [HAIKU_45]: HAIKU_4_5_US, "eu.anthropic.claude-haiku-4-5-20251001-v1:0": { ...HAIKU_4_5_EU, input_cost_per_token: 9e-6 } }, {}, logs);
    for (const id of [HAIKU_45, "eu.anthropic.claude-haiku-4-5-20251001-v1:0"]) {
      const p = await resolvePrice(prices, "bedrock", id);
      expect([id, p.estimated, pick(p)]).toEqual([id, false, { inputMicrosPerMTok: 1_100_000, outputMicrosPerMTok: 5_500_000 }]);
    }
    expect(used(logs)).toEqual([]);
  });
  it("an AWS row is a live row too", async () => {
    const logs: unknown[] = [];
    const prices = await refreshed({ "eu.anthropic.claude-haiku-4-5-20251001-v1:0": HAIKU_4_5_EU }, { "Claude Haiku 4.5": [["input_tokens", "2"], ["output_tokens", "8"]] }, logs);
    const p = await resolvePrice(prices, "bedrock", HAIKU_45);
    expect([p.estimated, pick(p)]).toEqual([false, { inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 8_000_000 }]);
    expect(used(logs)).toEqual([]);
  });
  it("prices its identity at its exact rates when no live row exists, logged once per refresh with a count and no names", async () => {
    const logs: unknown[] = [];
    const other = { ...HAIKU_4_5_EU, input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5 };
    const prices = await refreshed({ "eu.anthropic.claude-haiku-4-5-20251001-v1:0": HAIKU_4_5_EU, "apac.anthropic.claude-haiku-4-5-20251001-v1:0": HAIKU_4_5_EU, "eu.anthropic.claude-sonnet-4-20250514-v1:0": other }, {}, logs);
    const p = await resolvePrice(prices, "bedrock", HAIKU_45);
    expect([p.estimated, pick(p), p.cacheReadMicrosPerMTok, p.cacheWrite5mMicrosPerMTok, p.cacheWrite1hMicrosPerMTok]).toEqual([false, { inputMicrosPerMTok: 1_100_000, outputMicrosPerMTok: 5_500_000 }, 110_000, 1_375_000, 2_200_000]);
    expect(pick(await resolvePrice(prices, "bedrock", "us.anthropic.claude-sonnet-4-20250514-v1:0"))).toEqual({ inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 });
    expect(used(logs)).toEqual([{ event: "price_deprecated_used", identities: 2 }]);
    expect(JSON.stringify(logs)).not.toMatch(/haiku|sonnet|anthropic/u);
  });
  it("a deprecated row with an unknown field, or an unreadable date, still gets the cautious estimate", async () => {
    for (const row of [{ ...HAIKU_4_5_EU, secret_price_field: 1e-6 }, { ...HAIKU_4_5_EU, deprecation_date: "someday" }]) {
      const logs: unknown[] = [];
      const prices = await refreshed({ "eu.anthropic.claude-haiku-4-5-20251001-v1:0": row }, {}, logs);
      expect((await resolvePrice(prices, "bedrock", HAIKU_45)).estimated).toBe(true);
      expect(used(logs)).toEqual([]);
    }
  });
  it("a row before its deprecation date is an ordinary price (unchanged)", async () => {
    const logs: unknown[] = [];
    const prices = await refreshed({ "eu.anthropic.claude-haiku-4-5-20251001-v1:0": { ...HAIKU_4_5_EU, deprecation_date: "2027-01-01" } }, {}, logs);
    expect((await resolvePrice(prices, "bedrock", HAIKU_45)).estimated).toBe(false);
    expect(used(logs)).toEqual([]);
  });
});
