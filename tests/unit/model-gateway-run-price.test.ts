import type { RunPrice } from "../../packages/model-gateway/src/model-gateway-token.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { answerRateQuote, RATE_QUOTE_AUDIENCE, type RateQuoteOptions } from "../../packages/model-gateway/src/rate-quote.js";
import { claims, now } from "./model-gateway-fixture.js";
beforeAll(denyNetwork);
const model = "claude-haiku-4-5";
const bedrock = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
async function world() {
  const rates = { inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000, cacheReadMicrosPerMTok: 300_000, cacheWrite5mMicrosPerMTok: 4_000_000, cacheWrite1hMicrosPerMTok: 6_000_000 };
  const prices = new SnapshotPriceSource({ load: async () => ({ version: 9, sources: { litellm: { fetchedAt: now - 100, count: 3, entries: [
    { provider: "anthropic", model, kind: "chat", ...rates },
    { provider: "openai", model: "gpt-5", kind: "chat", ...rates },
    { provider: "bedrock", model: bedrock, kind: "chat", ...rates, inputMicrosPerMTok: 8_000_000, longContext: [
      { aboveTokens: 32_000, inputMicrosPerMTok: 12_000_000, outputMicrosPerMTok: 20_000_000, cacheWrite1hMicrosPerMTok: 30_000_000 },
      { aboveTokens: 200_000, inputMicrosPerMTok: 10_000_000, outputMicrosPerMTok: 40_000_000, cacheReadMicrosPerMTok: 2_000_000 },
    ] },
  ] } } }), save: async () => false }, { now: () => now, overrides: [] }); await prices.reload();
  const options: RateQuoteOptions = { prices, verify: async () => ({ ...claims, aud: RATE_QUOTE_AUDIENCE }), now: () => now,
    sources: { sourceFor: async () => "rovara" }, keys: { connected: async () => true, identityFor: async () => ({ sourceId: "company", versionId: "r1" }) },
    rovara: { sourceId: "operator-source", models: new Map([[model, bedrock]]), exempt: new Set() }, region: "us-west-2", switchedOn: new Set(), offeredProviders: new Set(["bedrock", "anthropic", "openai"]) };
  return options;
}
const get = (options: RateQuoteOptions, name = model) => answerRateQuote(options, { method: "GET", url: `/v1/service/companies/${claims.cid}/rate-quote?model=${name}&runPrice=1`, headers: { authorization: "Bearer fixture" } });
describe("gateway run price selection and bounds", () => {
  it("uses the actual Bedrock mapping and component maxima across only this model's context tiers", async () => {
    const result = await get(await world());
    expect(result.body).toMatchObject({ runPrice: { companyId: claims.cid, model, provider: "bedrock", snapshotVersion: 9,
      inputUsdPerMillion: 12, outputUsdPerMillion: 40, cacheWriteUsdPerMillion: 30, cacheReadUsdPerMillion: 12 } });
    // Unknown cache components in the 32k band are completed conservatively from that band's input.
    expect(JSON.stringify(result.body)).not.toContain("fixture-key");
  });
  it("prices the company's own provider, independently of the operator's Bedrock mapping", async () => {
    const w = await world();
    const own = await get({ ...w, sources: { sourceFor: async () => "anthropic_key" } });
    expect(own.body).toMatchObject({ runPrice: { provider: "anthropic", inputUsdPerMillion: 6, outputUsdPerMillion: 30, cacheWriteUsdPerMillion: 12 } });
    const openai = await get({ ...w, switchedOn: new Set(["openai"]), sources: { sourceFor: async () => "openai_key" } }, "gpt-5");
    expect(openai.body).toMatchObject({ runPrice: { provider: "openai", model: "gpt-5" } });
  });
  it("follows a saved fallback when the first provider cannot serve the model; failed reads never fall back", async () => {
    const w = await world();
    const sources = { sourceFor: async () => "openai_key" as const, orderFor: async () => ({ source: "openai_key" as const, fallback: ["rovara" as const] }) };
    expect((await get({ ...w, sources, switchedOn: new Set(["openai"]) })).body).toMatchObject({ runPrice: { provider: "bedrock" } });
    const broken = { ...w, sources: { sourceFor: async () => "anthropic_key" as const, orderFor: async () => ({ source: "anthropic_key" as const, fallback: ["rovara" as const] }) }, keys: { ...w.keys, connected: async () => { throw new Error("unreadable"); } } };
    expect((await get(broken)).body).toEqual({ state: "unavailable", reason: "missing_price" });
  });
  it("never substitutes another provider's cheap row, unknown model or stale snapshot", async () => {
    const w = await world();
    for (const opts of [{ ...w, rovara: { models: new Map([[model, "unpriced"]]), exempt: new Set<string>() } }, { ...w, now: () => now + 4 * 86_400_000 }]) {
      expect((await get(opts)).body).not.toHaveProperty("runPrice");
    }
    expect((await get(w, "unknown")).body).not.toHaveProperty("runPrice");
  });
  it("reports readiness only with a fresh versioned snapshot", async () => {
    const w = await world();
    expect(w.prices.runPriceSnapshotVersion()).toBe(9);
    const empty = new SnapshotPriceSource({ load: async () => undefined, save: async () => false }); await empty.reload();
    expect(empty.runPriceSnapshotVersion()).toBeUndefined();
  });
});

it("skips a disabled operator model onto the same provider fallback as admission", async () => {
  const w = await world();
  const result = await get({ ...w, disabled: new Set([model]), sources: { sourceFor: async () => "rovara", orderFor: async () => ({ source: "rovara", fallback: ["anthropic_key"] }) } });
  expect(result.body).toMatchObject({ runPrice: { provider: "anthropic", inputUsdPerMillion: 6 } });
});


it("preserves the old strict preview envelope unless the caller negotiates runPrice", async () => {
  const w = await world();
  const { LearningField, RateQuoteV1Schema } = await import("../../packages/contracts/src/run-usage.js");
  const result = await answerRateQuote(w, { method: "GET", url: `/v1/service/companies/${claims.cid}/rate-quote?model=${model}`, headers: { authorization: "Bearer fixture" } });
  expect(LearningField(RateQuoteV1Schema).safeParse(result.body).success).toBe(true);
  expect(result.body).not.toHaveProperty("runPrice");
});
it("withholds authorization for unbounded reported cost and prices a registered endpoint's actual catalog", async () => {
  const w = await world();
  const endpoint = { ...w, switchedOn: new Set(["endpoint"]), sources: { sourceFor: async () => "custom_endpoint" as const },
    keys: { ...w.keys, endpointMetadata: async () => ({ sourceId: "endpoint-account", versionId: "v3", models: [{ name: "company-alias", catalog: { provider: "anthropic", modelId: model } }] }) } };
  expect((await get(endpoint, "company-alias")).body).toMatchObject({ runPrice: { sourceId: "endpoint-account", connectionRevision: "v3", catalogModel: model } });
  const missing = { ...endpoint, keys: { ...endpoint.keys, endpointMetadata: async () => undefined }, sources: { sourceFor: async () => "custom_endpoint" as const, orderFor: async () => ({ source: "custom_endpoint" as const, fallback: ["rovara" as const] }) } };
  expect((await get(missing)).body).toMatchObject({ runPrice: { provider: "bedrock" } });
  const unknownPrice = { ...endpoint, keys: { ...endpoint.keys, endpointMetadata: async () => ({ sourceId: "endpoint-account", versionId: "v3", models: [{ name: model, catalog: { provider: "anthropic", modelId: "unpriced" } }] }) } };
  expect((await get(unknownPrice)).body).toMatchObject({ state: "unavailable" });
  const router = { ...w, switchedOn: new Set(["openrouter"]), offeredProviders: new Set(["openrouter"]), sources: { sourceFor: async () => "openrouter_key" as const } };
  // A genuine priced OpenRouter row must still never become a signed run ceiling.
  const prices = new SnapshotPriceSource({ load: async () => ({ version: 9, sources: { litellm: { fetchedAt: now - 100, count: 1, entries: [{ provider: "openrouter", model: "vendor/model", kind: "chat", inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000 }] } } }), save: async () => false }, { now: () => now, overrides: [] }); await prices.reload();
  const reported = (await get({ ...router, prices }, "vendor/model")).body;
  expect(reported).toMatchObject({ state: "unavailable" });
  expect(reported).not.toHaveProperty("runPrice");
  expect(prices.correctionFor("openrouter", "vendor/model")).toBeUndefined();
});

it("checks the signed source, snapshot and every context/cache ceiling before reservation or provider send", async () => {
  const { call, setup, mint, requestBody } = await import("./model-gateway-fixture.js");
  const w = await world();
  const quote = (await get({ ...w, sources: { sourceFor: async () => "anthropic_key" } })).body as { runPrice: RunPrice };
  expect(quote.runPrice).toBeDefined();
  const source = { kind: "company_key" as const, id: "company", name: "Company AI", provider: "anthropic", connectionRevision: "r1" };
  for (const patch of [undefined, { sourceId: "rotated" }, { connectionRevision: "r2" }, { provider: "bedrock" }, { catalogModel: "other" }, { snapshotVersion: 10 }, { snapshotHash: "f".repeat(64) }, { expiresAt: now }, { inputUsdPerMillion: 0.000001 }, { outputUsdPerMillion: 0.000001 }, { cacheReadUsdPerMillion: 0 }, { cacheWriteUsdPerMillion: 0.000001 }, { companyId: "org_bbbbbbbbbbbbbbbbbbbb" }, { model: "other" }]) {
    const open = vi.fn(async () => "fixture-key");
    const f = setup({ prices: w.prices, agentKeys: { connected: async () => true, keyFor: open, resolveForCharge: async () => ({ source, key: open }) } });
    const reserve = vi.spyOn(f.meter, "reserve");
    const grant = { ...quote.runPrice, ...patch };
    const result = await call(f.deps, { ...requestBody, model }, mint({ mdl: [model], runPrice: grant }));
    if (patch === undefined) { expect(result.status).toBe(200); expect(reserve).toHaveBeenCalledTimes(1); expect(f.calls).toHaveLength(1); }
    else { expect([401, 409]).toContain(result.status); expect(reserve).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(0); }
  }
});
