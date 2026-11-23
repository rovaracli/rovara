import { beforeAll, describe, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { REVIEWED_OPENROUTER_POLICIES, openRouterPolicy, openRouterHold, openRouterDecimal } from "../../packages/model-gateway/src/openrouter-policy.js";
import { settleChargeAmount } from "../../packages/model-gateway/src/reported-cost.js";
import { usageCost } from "../../packages/model-gateway/src/estimate.js";
import { offeredOpenRouterModels } from "../../packages/model-gateway/src/offered-models.js";
beforeAll(denyNetwork);
// The 5 rows reviewed in REVIEW-OPUS-TARIFFS (TARIFFS PASS 5). Prices are pinned independently of the source rows (USD per token).
const REVIEWED = {
 "anthropic/claude-haiku-5.5": { route: "amazon-bedrock", prompt: "0.0000005", completion: "0.0000025", read: "0.00000005", write: "0.000000625", expiresAt: 1795553914052 },
 "google/gemini-4-hydrogen": { route: "google-ai-studio/priority", prompt: "0.0000027", completion: "0.0000135", read: "0.000000135", write: "0.00000015", expiresAt: 1795549964233 },
 "openai/gpt-6-luna": { route: "amazon-bedrock/global", prompt: "0.0000002", completion: "0.00000075", read: "0.00000002", write: "0.00000025", expiresAt: 1795555047589 },
 "qwen/qwen3.7-flash": { route: "alibaba", prompt: "0.0000002", completion: "0.0000008", read: "0.00000004", write: "0.00000025", expiresAt: 1795562682958 },
 "qwen/qwen3.8-2.4t-a95b": { route: "alibaba", prompt: "0.000002", completion: "0.000006", read: "0.00000025", write: "0.0000025", expiresAt: 1795561150269 },
} as const;
const models = Object.keys(REVIEWED) as (keyof typeof REVIEWED)[];
const rows = REVIEWED_OPENROUTER_POLICIES;
const rowOf = (model: string) => rows.find(r => r.model === model)!;
const nowFor = (model: string) => rowOf(model).verifiedAt + 1;
const store = { load: async () => undefined, save: async () => false };
const price = (model: string, now: number) => { const p = new SnapshotPriceSource(store, { now: () => now }); return p.reload().then(() => p.priceFor("openrouter", model)); };

it("installs exactly the 5 reviewed rows, one per model, with review evidence and no candidate label", () => {
 expect(rows).toHaveLength(5);
 expect(rows.map(r => r.model).sort()).toEqual([...models].sort());
 expect(new Set(rows.map(r => r.model)).size).toBe(5);
 for (const r of rows) {
  const spec = REVIEWED[r.model as keyof typeof REVIEWED];
  expect(r.route).toBe(spec.route);
  expect(r.pricing).toEqual({ prompt: spec.prompt, completion: spec.completion, internal_reasoning: spec.completion, request: "0", input_cache_read: spec.read, input_cache_write: spec.write });
  expect(r.max_completion_tokens).toBe(2048);
  expect(r.reasoning).toEqual({ mode: "bounded", max_tokens: 1024 });
  expect(r.expiresAt).toBe(spec.expiresAt);
  expect(r.expiresAt - r.verifiedAt).toBeLessThanOrEqual(86_400_000);
  expect(r.evidence).toContain("TARIFFS PASS 5");
  expect(r.evidence).not.toContain("CANDIDATE");
  expect(Object.keys(r).sort()).toEqual(["evidence", "expiresAt", "max_completion_tokens", "model", "pricing", "reasoning", "route", "verifiedAt"]);
 }
});

describe.each(models)("%s", model => {
 const spec = REVIEWED[model];
 it("validates now, resolves to exactly one row, and refuses at and after expiry or before verification", () => {
  const r = rowOf(model);
  expect(rows.filter(x => x.model === model)).toHaveLength(1);
  expect(openRouterPolicy(model, nowFor(model))).toMatchObject({ model, route: spec.route });
  expect(openRouterPolicy(model, r.verifiedAt - 1)).toBeUndefined();
  expect(openRouterPolicy(model, r.expiresAt - 1)).toBeDefined();
  expect(openRouterPolicy(model, r.expiresAt)).toBeUndefined();
  expect(openRouterPolicy(model, r.expiresAt + 3_600_000)).toBeUndefined();
  // a second row for the same model switches the model off
  expect(openRouterPolicy(model, nowFor(model), [r, { ...r, route: "other" }])).toBeUndefined();
 });
 it("never charges less than the token cost at the row prices (reported cost low, high, absent)", async () => {
  const now = nowFor(model);
  const resolved = (await price(model, now))!;
  expect(resolved).toBeDefined();
  const usd = (n: number, p: string) => openRouterDecimal(p) * BigInt(n);
  const usages = [{ input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 }, { input: 12_345, output: 2048, cacheRead: 800, cacheWrite: 300 }, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }];
  for (const usage of usages) {
   // independent token cost: prompt at max(prompt, cache write), cache read at read, output at completion
   const exact = usd(usage.input, spec.prompt) + usd(usage.cacheRead, spec.read) + usd(usage.cacheWrite, spec.write > spec.prompt ? spec.write : spec.prompt) + usd(usage.output, spec.completion);
   const floorMicros = Number((exact * 1_000_000n) / 10n ** 18n);
   expect(usageCost(usage, resolved)).toBeGreaterThanOrEqual(floorMicros);
   for (const reportedCostMicros of [undefined, 0, 1, floorMicros * 10 + 7]) {
    const out = settleChargeAmount({ usage, price: { ...resolved, estimated: false }, reservationMicros: 1, ...(reportedCostMicros === undefined ? {} : { reportedCostMicros }) });
    expect(out.actualMicros).toBeGreaterThanOrEqual(floorMicros);
    expect(out.actualMicros).toBeGreaterThanOrEqual(Math.min(reportedCostMicros ?? 0, Number.MAX_SAFE_INTEGER));
   }
  }
 });
 it("holds the worst case: ceiling output at the row's rate plus every prompt token as a cache write", () => {
  const policy = openRouterPolicy(model, nowFor(model))!;
  const hold = openRouterHold(policy, 500, 2048);
  const exact = BigInt(500) * (openRouterDecimal(spec.prompt) + openRouterDecimal(spec.write)) + BigInt(2048) * openRouterDecimal(spec.completion);
  expect(hold).toBeGreaterThanOrEqual(Number((exact * 1_000_000n) / 10n ** 18n));
 });
 it("is refused once expired by the price source, and offered only while fresh", async () => {
  const r = rowOf(model);
  expect(await price(model, r.expiresAt)).toBeUndefined();
  expect(await price(model, r.verifiedAt - 1)).toBeUndefined();
  expect(offeredOpenRouterModels(rows, nowFor(model))).toContain(model);
  expect(offeredOpenRouterModels(rows, r.expiresAt)).not.toContain(model);
 });
});

it("refuses any model that is not in the reviewed set, including the 8 route_not_chosen siblings and a swapped route", async () => {
 const now = Math.max(...rows.map(r => r.verifiedAt)) + 1;
 for (const model of ["anthropic/claude-haiku-5.4", "openai/gpt-6.2-astra-pro", "x-ai/grok-4.7", "google/gemini-4-neon", "openai/gpt-5-mini", "openai/gpt-5-nano", "vendor/unreviewed"]) {
  expect(openRouterPolicy(model, now)).toBeUndefined();
  expect(await price(model, now)).toBeUndefined();
  expect(offeredOpenRouterModels(rows, now)).not.toContain(model);
 }
 // the validator keys on the model alone, so exactly one route per model is installed (the chosen one)
 expect(rows.map(r => `${r.model}@${r.route}`).sort()).toEqual(models.map(m => `${m}@${REVIEWED[m].route}`).sort());
 expect(offeredOpenRouterModels(rows, now).sort()).toEqual([...models].sort());
});

it("hashes the price: a changed price changes the policy hash, and the earliest expiry is gemini at 2026-11-24 19:52Z", () => {
 const r = rowOf("anthropic/claude-haiku-5.5"); const now = nowFor(r.model);
 const base = openRouterPolicy(r.model, now, [r])!.hash;
 expect(openRouterPolicy(r.model, now, [{ ...r, pricing: { ...r.pricing, completion: "0.0000024" } }])!.hash).not.toBe(base);
 expect(Math.min(...rows.map(x => x.expiresAt))).toBe(Date.UTC(2026, 10, 24, 19, 52, 44, 233));
});
