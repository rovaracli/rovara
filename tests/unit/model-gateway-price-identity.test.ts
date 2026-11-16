// BEDROCK-PRICE-ROWS (2026-11-16): every Bedrock id Rovara's AI offers must meet its AWS price list row, so a call is charged the
// model's real price, not the cautious estimate (1.5x the dearest known rate). The price fetcher folds an AWS name to lower case with
// dashes (fetchAWS); the price index folds the called id (normalizeBedrockModel). Both must meet, and no two offered models may meet
// on one identity.
//
// AWS price list names ("model" attribute of AmazonBedrockFoundationModels products):
//   RECORDED: the Claude names (tests/fixtures/model-gateway-prices/aws.json, 2026-11-09; model-gateway-rovara-ai.test.ts, 2026-11-15).
//   ASSUMED:  every other name below. None is recorded in a fixture or doc yet (no AWS call is made from tests or from this lane).
//             briefs/staging-switchover/62-price-rows-check.sh confirms them against the real price fetch once the gateway is deployed.
import { beforeAll, describe, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { ROVARA_AI_US_CONVERSE_MODELS, ROVARA_AI_US_MODELS, parseRovaraAiModels } from "../../packages/model-gateway/src/agent-ai.js";
import { identityKey, normalizeBedrockModel, normalizedModel } from "../../packages/model-gateway/src/price-identity.js";
import { fetchAWS, fetchLiteLLM } from "../../packages/model-gateway/src/price-sources.js";
import { InMemoryPriceSnapshotStore } from "../../packages/model-gateway/src/price-snapshot.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { PriceRefresher } from "../../packages/model-gateway/src/price-refresh.js";
import { resolvePrice } from "../../packages/model-gateway/src/price.js";
beforeAll(denyNetwork);

const now = Date.UTC(2026, 10, 16);
/** offered Bedrock id -> [AWS price list name, recorded or assumed, the identity both fold to]. */
const TABLE: Record<string, [string, "recorded" | "assumed", string]> = {
  "us.anthropic.claude-haiku-4-5-20251001-v1:0": ["Claude Haiku 4.5", "recorded", "claude-haiku-4-5"],
  "us.anthropic.claude-haiku-5-5": ["Claude Haiku 5.5", "recorded", "claude-haiku-5-5"],
  "us.anthropic.claude-sonnet-5-5": ["Claude Sonnet 5.5", "recorded", "claude-sonnet-5-5"],
  "us.anthropic.claude-opus-5-5": ["Claude Opus 5.5", "recorded", "claude-opus-5-5"],
  "us.anthropic.claude-fable-5-2": ["Claude Fable 5.2", "recorded", "claude-fable-5-2"],
  "qwen.qwen3-coder-480b-a35b-v1:0": ["Qwen3 Coder 480B A35B", "assumed", "qwen3-coder-480b-a35b"],
  "qwen.qwen3-coder-30b-a3b-v1:0": ["Qwen3 Coder 30B A3B", "assumed", "qwen3-coder-30b-a3b"],
  "qwen.qwen3-235b-a22b-2507-v1:0": ["Qwen3 235B A22B 2507", "assumed", "qwen3-235b-a22b-2507"],
  "mistral.devstral-2-123b": ["Devstral 2 123B", "assumed", "devstral-2-123b"],
  "mistral.mistral-large-3-675b-instruct": ["Mistral Large 3 675B Instruct", "assumed", "mistral-large-3-675b-instruct"],
  "deepseek.v3-v1:0": ["DeepSeek V3.1", "assumed", "deepseek-v3-1"],
  "moonshotai.kimi-k2.5": ["Kimi K2.5", "assumed", "kimi-k2-5"],
  "zai.glm-5": ["GLM 5", "assumed", "glm-5"],
  "zai.glm-4.7": ["GLM 4.7", "assumed", "glm-4-7"],
  "us.amazon.nova-2-lite-v1:0": ["Nova 2 Lite", "assumed", "nova-2-lite"],
  "openai.gpt-oss-120b-1:0": ["gpt-oss-120b", "assumed", "gpt-oss-120b"],
  "openai.gpt-oss-20b-1:0": ["gpt-oss-20b", "assumed", "gpt-oss-20b"],
  "us.amazon.nova-pro-v1:0": ["Nova Pro", "assumed", "nova-pro"],
  "moonshot.kimi-k2-thinking": ["Kimi K2 Thinking", "assumed", "kimi-k2-thinking"],
  "minimax.minimax-m2.5": ["MiniMax M2.5", "assumed", "minimax-m2-5"],
  "us.moonshotai.kimi-k3": ["Kimi K3", "assumed", "kimi-k3"],
  "us.moonshotai.kimi-k3.1": ["Kimi K3.1", "assumed", "kimi-k3-1"],
};
const offered = [...new Set([...parseRovaraAiModels(ROVARA_AI_US_MODELS, "us-west-2").values(), ...parseRovaraAiModels(ROVARA_AI_US_CONVERSE_MODELS, "us-west-2").values()])];
/** fetchAWS's own folding of an AWS "model" attribute (price-sources.ts). */
const awsFold = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");

describe("every offered Bedrock id meets its AWS price list row", () => {
  it("the table covers exactly the offered ids (a new offered model needs a row here)", () => {
    expect(new Set(Object.keys(TABLE))).toEqual(new Set(offered));
  });
  for (const [id, [aws, , identity]] of Object.entries(TABLE)) {
    it(`${id} and "${aws}" are one identity: ${identity}`, () => {
      expect(normalizeBedrockModel(id)).toBe(identity);
      expect(normalizedModel("bedrock", awsFold(aws))).toBe(identity);
      expect(identityKey("bedrock", id)).toBe(identityKey("bedrock", awsFold(aws)));
      // LiteLLM's Bedrock keys (bare, bedrock/, bedrock_converse/, a Region group) fold the same way.
      for (const key of [id, `bedrock/${id}`, `bedrock_converse/${id}`]) expect(normalizeBedrockModel(key)).toBe(identity);
    });
  }
  it("the dotted names meet whatever punctuation the price list uses", () => {
    for (const [id, names] of [["moonshotai.kimi-k2.5", ["Kimi K2.5", "Kimi-K2.5", "kimi k2 5", "Kimi K2_5"]], ["zai.glm-4.7", ["GLM 4.7", "GLM-4.7"]], ["minimax.minimax-m2.5", ["MiniMax M2.5", "MiniMax-M2.5"]], ["us.moonshotai.kimi-k3.1", ["Kimi K3.1", "Kimi-K3.1"]]] as const) {
      for (const name of names) expect([id, name, identityKey("bedrock", awsFold(name))]).toEqual([id, name, identityKey("bedrock", id)]);
    }
  });
  it("no two offered models share an identity", () => {
    const identities = offered.map((id) => identityKey("bedrock", id));
    expect(new Set(identities).size).toBe(offered.length);
    // Neighbours that differ only after a dot or a number stay apart.
    for (const [a, b] of [["us.moonshotai.kimi-k3", "us.moonshotai.kimi-k3.1"], ["zai.glm-5", "zai.glm-4.7"], ["openai.gpt-oss-120b-1:0", "openai.gpt-oss-20b-1:0"], ["moonshotai.kimi-k2.5", "moonshot.kimi-k2-thinking"], ["deepseek.v3-v1:0", "deepseek.v3.2"], ["us.amazon.nova-2-lite-v1:0", "us.amazon.nova-pro-v1:0"]]) {
      expect(normalizeBedrockModel(a!)).not.toBe(normalizeBedrockModel(b!));
    }
  });
  it("an identity folds to itself (a stored snapshot stays valid), and is never empty", () => {
    for (const id of [...offered, ...Object.values(TABLE).map(([aws]) => awsFold(aws)), "deepseek.v3.2", "us.deepseek.r1-v1:0", "foo_v3", "x-20240101-v1-v2", "...", "-", "us.", "a/b.c", "bedrock/", "-v1", "@1", "x//-v1", "/ -v1", ":0//--"]) {
      const once = normalizeBedrockModel(id);
      expect([id, normalizeBedrockModel(once)]).toEqual([id, once]);
      expect(once.length).toBeGreaterThan(0);
    }
  });
  it("reviewed ids not offered today meet their (assumed) AWS names; another version of them is not taken for them", () => {
    for (const [id, aws] of [["deepseek.v3.2", "DeepSeek V3.2"], ["us.deepseek.r1-v1:0", "DeepSeek R1"], ["deepseek.r1-v1:0", "DeepSeek-R1"]] as const) {
      expect([id, identityKey("bedrock", id)]).toEqual([id, identityKey("bedrock", awsFold(aws))]);
    }
    // Exact ids only: a later version of an aliased id is not priced as the aliased model (it gets the cautious price).
    for (const id of ["deepseek.v3-v2:0", "openai.gpt-oss-120b-2:0", "zai.glm-5:0", "zai.glm-5-1:0"]) {
      expect(Object.values(TABLE).map(([, , identity]) => identity)).not.toContain(normalizeBedrockModel(id));
    }
  });
  it("every Region group and LiteLLM's punctuation fold away", () => {
    for (const group of ["us", "eu", "apac", "global", "jp", "au", "in", "ca", "us-gov"]) {
      expect([group, normalizeBedrockModel(`${group}.moonshotai.kimi-k2.5`)]).toEqual([group, "kimi-k2-5"]);
      expect([group, normalizeBedrockModel(`${group}.openai.gpt-oss-20b-1:0`)]).toEqual([group, "gpt-oss-20b"]);
    }
    expect(normalizeBedrockModel("  bedrock/MoonshotAI.Kimi-K2.5  ")).toBe("kimi-k2-5");
    expect(normalizeBedrockModel("bedrock/_kimi-k2.5_")).toBe("kimi-k2-5");
    // A version that only shows after folding (`_v3`) folds away too, so the identity folds to itself.
    expect(normalizeBedrockModel("foo_v3")).toBe("foo");
    expect(normalizedModel("bedrock", awsFold("(Kimi K2.5)"))).toBe("kimi-k2-5");
  });
  it("folding is idempotent for any text (fuzzed, fixed seed), so no LiteLLM key can make a snapshot invalid", () => {
    const alphabet = "av1-./: _@us9bk"; let seed = 1;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let n = 0; n < 20_000; n++) {
      const text = Array.from({ length: 1 + Math.floor(random() * 14) }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
      const once = normalizeBedrockModel(text);
      expect([text, normalizeBedrockModel(once)]).toEqual([text, once]);
    }
  });
  it("a version dot is never taken for a provider (a bare dotted name keeps its whole name)", () => {
    expect(normalizeBedrockModel("kimi-k2.5")).toBe("kimi-k2-5");
    expect(normalizeBedrockModel("glm-4.5")).toBe("glm-4-5");
    expect(normalizeBedrockModel("us.kimi-k3.1")).toBe("kimi-k3-1");
    expect(normalizeBedrockModel("kimi-k2.5")).not.toBe(normalizeBedrockModel("glm-4.5"));
  });
});

const transport = (body: unknown) => ({ get: async () => ({ status: 200, body: Buffer.from(JSON.stringify(body)) }) });
/** An AWS offer with one input and one output product per name, each model at its own price (dollars per 1M tokens). */
function offer(models: ReadonlyArray<readonly [string, number]>) {
  const products: Record<string, unknown> = {}; const terms: Record<string, unknown> = {};
  models.forEach(([name, input], i) => {
    for (const [kind, usd] of [["input", input], ["output", input * 4]] as const) {
      const sku = `SKU${i}${kind}`;
      products[sku] = { attributes: { model: name, usagetype: `USW2-MP:USW2_${kind}_tokens_standard-Units` } };
      terms[sku] = { T: { priceDimensions: { D: { unit: "1M tokens", pricePerUnit: { USD: String(usd) } } } } };
    }
  });
  return { products, terms: { OnDemand: terms } };
}
async function refreshed(litellm: Record<string, unknown>, aws: ReadonlyArray<readonly [string, number]>) {
  const store = new InMemoryPriceSnapshotStore(); const prices = new SnapshotPriceSource(store, { now: () => now, overrides: [] });
  const r = await new PriceRefresher({ store, prices,
    litellm: (previous) => fetchLiteLLM(transport(litellm), { previous, now, minModels: 1 }),
    aws: (previous) => fetchAWS(transport(offer(aws)), { previous, now, minModels: 1, regions: ["us-west-2"] }),
  }).run(now);
  expect(r.ok).toBe(true);
  return prices;
}
const unrelated = { "gpt-x": { litellm_provider: "openai", mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 } };

describe("the price each offered id is charged, through the price fetch and the index", () => {
  it("every offered id is charged its own AWS row's price, not an estimate", async () => {
    const rows = Object.values(TABLE).map(([aws], i) => [aws, i + 1] as const);
    const prices = await refreshed(unrelated, rows);
    for (const [i, id] of Object.keys(TABLE).entries()) {
      const p = await resolvePrice(prices, "bedrock", id);
      expect([id, p.estimated, p.inputMicrosPerMTok, p.outputMicrosPerMTok]).toEqual([id, false, (i + 1) * 1e6, (i + 1) * 4e6]);
    }
  });
  it("a LiteLLM Bedrock row for a dotted id pools with its AWS row (the dearer rate holds)", async () => {
    const prices = await refreshed({ ...unrelated, "moonshotai.kimi-k2.5": { litellm_provider: "bedrock_converse", mode: "chat", input_cost_per_token: 0.5e-6, output_cost_per_token: 9e-6 } }, [["Kimi K2.5", 1], ["GLM 4.7", 2]]);
    const p = await resolvePrice(prices, "bedrock", "moonshotai.kimi-k2.5");
    expect([p.estimated, p.inputMicrosPerMTok, p.outputMicrosPerMTok]).toEqual([false, 1e6, 9e6]);
  });
  it("a genuinely unknown model still gets the cautious estimate (1.5x the dearest known rate)", async () => {
    const prices = await refreshed(unrelated, [["Kimi K2.5", 1], ["GLM 4.7", 2]]);
    for (const id of ["moonshotai.kimi-k9.9", "zai.glm-4.8", "deepseek.v4-v1:0"]) {
      const p = await resolvePrice(prices, "bedrock", id);
      expect([id, p.estimated, p.inputMicrosPerMTok, p.outputMicrosPerMTok]).toEqual([id, true, 3e6, 12e6]);
    }
  });
});
