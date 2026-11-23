import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
const script = new URL("../../scripts/openrouter-qualify.mjs", import.meta.url).href;
type Prices = Record<string, unknown>;
type Call = { holdMicros: number; maxPromptTokens: number; checks: Record<string, string>; reasons: Record<string, string> };
type Provider = { cause?: string; calls?: Call[]; checks?: Record<string, string> };
type Report = { errors: string[]; chargedMicros: number; preCallHoldsMicros: number; models: { model: string; causes: string[]; reason: string; providers: Provider[] }[]; proposedTariffRows: { pricing: Record<string, string> }[] };
const { qualify, qualificationCostMicros } = await import(script) as {
 qualify: (options: Record<string, unknown>) => Promise<Report>;
 qualificationCostMicros: (components: [number, string][]) => number;
};
const prices = { prompt: "0.000001", completion: "0.000002" };
const entry = (id = "vendor/model", pricing: Prices = prices) => ({ id, pricing, supported_parameters: ["tools"], top_provider: { max_completion_tokens: 4096 } });
const endpoint = (pricing: Prices = prices, tag = "provider/fp4") => ({ tag, provider_name: "Provider", pricing, supported_parameters: ["tools"], max_completion_tokens: 4096 });
async function run(pricing: Prices = prices, options: { endpoints?: ReturnType<typeof endpoint>[]; ids?: string[]; cost?: string; probeCost?: string } = {}) {
 const bodies: { model: string; provider: { order: string[]; only: string[]; allow_fallbacks: boolean; max_price: Record<string, number> } }[] = [];
 let generation: Record<string, unknown> = {};
 const fetcher = vi.fn(async (url: string, init: RequestInit) => {
  if (init.method !== "POST") return Response.json({ data: generation });
  if (typeof init.body !== "string") throw new Error("expected JSON request body");
  const body = JSON.parse(init.body) as typeof bodies[number]; bodies.push(body);
  const probe = body.provider.max_price.prompt === 0 || body.provider.max_price.completion === 0;
  if (probe && options.probeCost === undefined) return Response.json({ error: { message: "No endpoints found that satisfy the max price for this request" } }, { status: 404 });
  const cost = probe ? options.probeCost : options.cost ?? "0.001036";
  generation = { model: body.model, provider_name: "Provider", native_tokens_prompt: 10, native_tokens_completion: 513, native_tokens_reasoning: 171, native_tokens_cached: 0, total_cost: cost, is_byok: false };
  return Response.json({ id: `gen-${bodies.length}`, model: body.model, choices: [{ message: { content: "four" } }], usage: { prompt_tokens: 10, completion_tokens: 513, completion_tokens_details: { reasoning_tokens: 171 }, cost, cost_details: { upstream_inference_cost: cost } } });
 });
 const report = await qualify({ allModels: true, catalogue: { models: { data: (options.ids ?? ["vendor/model"]).map(id => entry(id)) }, endpoints: Object.fromEntries((options.ids ?? ["vendor/model"]).map(id => [id, { data: { endpoints: options.endpoints ?? [endpoint(pricing)] } }])) }, spendCap: "15", perModelCap: "1", env: { OPENROUTER_API_KEY: "discovery2-fixture" }, now: () => 1000, sleep: async () => {}, fetch: fetcher });
 return { report, bodies, fetcher };
}
it.each([0, "0", "0.0"])("accepts exact zero discount %s", async discount => {
 const { report, bodies } = await run({ ...prices, discount });
 expect(report.errors).toEqual([]); expect(report.proposedTariffRows).toHaveLength(1); expect(bodies).toHaveLength(6);
});
it.each([0.1, -0.1, "0.0001", "abc", NaN, "NaN", null, false])("refuses nonzero/unreadable discount %s before any paid call", async discount => {
 const { report, bodies } = await run({ ...prices, discount });
 expect(bodies).toEqual([]); expect(report.models[0]!.reason).toContain(`discount_nonzero:${String(discount)}`);
});
it.each(["0.1", "-0.1", "abc"])("refuses override discount %s before any paid method", async discount => {
 const { report, bodies, fetcher } = await run({ ...prices, overrides: [{ min_prompt_tokens: 100000, prompt: "0.000002", discount }] });
 expect(fetcher.mock.calls.filter(([, init]) => init.method === "POST")).toEqual([]);
 expect(bodies).toEqual([]); expect(report.errors).toEqual([]);
 expect(report.models[0]!.causes).toEqual(["unpriced_component"]);
 expect(report.models[0]!.reason).toContain(`discount_nonzero:${discount}`);
 expect(report.proposedTariffRows).toEqual([]);
});
it("accepts exact zero override discount", async () => {
 const { report, bodies, fetcher } = await run({ ...prices, overrides: [{ min_prompt_tokens: 100000, prompt: "0.000002", discount: "0" }] });
 expect(report.errors).toEqual([]); expect(report.proposedTariffRows).toHaveLength(1);
 expect(bodies).toHaveLength(6);
 expect(fetcher.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(6);
});
it("ceilings exact finite decimal products for random token counts including the maximum safe count", () => {
 expect(typeof qualificationCostMicros).toBe("function");
 let state = 0x254351n;
 for (let i = 0; i < 250; i++) {
  state = (state * 1664525n + 1013904223n) % (2n ** 53n);
  const tokens = i === 0 ? Number.MAX_SAFE_INTEGER : i === 1 ? 4096 : Number(state);
  const digits = i % 2 === 0 ? "0000000000000000003333333333333333" : "0000000000000000009999999999999999";
  const numerator = BigInt(tokens) * BigInt(digits) * 1_000_000n;
  const denominator = 10n ** BigInt(digits.length);
  const held = BigInt(qualificationCostMicros([[tokens, `0.${digits}`]]));
  expect(held * denominator).toBeGreaterThanOrEqual(numerator);
  expect(held * denominator).toBeLessThan(numerator + denominator);
 }
 // Beyond Number's significant digits: a float parse loses the last positive atom.
 expect(qualificationCostMicros([[1, "0.0000010000000000000000000000000001"]])).toBe(2);
 expect(qualificationCostMicros([[0, "0.000001"]])).toBe(0);
 expect(() => qualificationCostMicros([[Number.MAX_SAFE_INTEGER, "1"]])).toThrow();
});
it("ceilings the combined hold once without rounding token rates or components first", async () => {
 const rate = "0.0000003333333333333333";
 // Finer than the gateway's micro-USD/MTok granularity: only an extended id (harness-only handling, ruling (d)) can still reach the exact-rational arithmetic;
 // a plain id is refused by the runtime_policy check (see openrouter-qualify-runtime-align.test.ts).
 const { report } = await run({ prompt: rate, completion: rate }, { cost: "0.0002", ids: ["vendor/model:thinking"] });
 const call = report.models[0]!.providers[0]!.calls![0]!;
 const exact = BigInt(call.maxPromptTokens + 2048 + 1024) * 3333333333333333n * 1_000_000n;
 const denominator = 10n ** 22n;
 expect(BigInt(call.holdMicros) * denominator).toBeGreaterThanOrEqual(exact);
 expect(BigInt(call.holdMicros) * denominator).toBeLessThan(exact + denominator);
 expect(report.proposedTariffRows[0]!.pricing.completion).toBe(rate);
});
it("uses rounded-up fractional maximum, rejects one micro above it, and retains the hold", async () => {
 const p = { prompt: "0.0000010000000000000001", completion: "0.0000020000000000000001" };
 const accepted = await run(p, { cost: "0.001379", ids: ["vendor/model:thinking"] }); // exact max 1378.0000000000000694 micros -> 1379.
 expect(accepted.report.models[0]!.providers[0]!.calls![0]!.checks.bounded_inference_cost).toBe("PASS");
 expect(accepted.report.proposedTariffRows).toHaveLength(1);
 for (const probe of [false, true]) {
  const rejected = await run(p, { ...(probe ? { cost: "0.001379", probeCost: "0.001380" } : { cost: "0.001380" }), ids: ["vendor/model:thinking"] });
  expect(rejected.report.models[0]!.providers[0]!.checks!.hidden_charge).toBe("FAIL");
  expect(rejected.report.proposedTariffRows).toEqual([]); expect(rejected.report.preCallHoldsMicros).toBeGreaterThan(0);
 }
});
it("pins exact tags with fallbacks disabled and holds maximum prices across duplicate routed endpoints", async () => {
 const { report, bodies } = await run(prices, { endpoints: [endpoint(), endpoint({ prompt: "0.000003", completion: "0.000006" })], cost: "0.004134" });
 expect(report.proposedTariffRows).toHaveLength(1);
 for (const body of bodies) expect(body.provider).toMatchObject({ order: ["provider/fp4"], only: ["provider/fp4"], allow_fallbacks: false });
 const call = report.models[0]!.providers[0]!.calls![0]!;
 expect(call.holdMicros).toBe(call.maxPromptTokens * 3 + (2048 + 1024) * 6);
 expect(report.proposedTariffRows[0]!.pricing).toMatchObject({ prompt: "0.000003", completion: "0.000006", internal_reasoning: "0.000006" });
});
it.each(["unpriced", "no-tools", "identity"])("refuses an entire tag if a routable duplicate is %s", async problem => {
 const other = endpoint();
 if (problem === "unpriced") other.pricing = { ...prices, completion: null };
 if (problem === "no-tools") other.supported_parameters = [];
 if (problem === "identity") other.provider_name = "Different";
 const r = await run(prices, { endpoints: [endpoint(), other] });
 expect(r.bodies).toEqual([]); expect(r.report.proposedTariffRows).toEqual([]);
});
it("labels batch, free, router aliases and malformed ids with one precise cause", async () => {
 const ids = ["vendor/model:batch", "vendor/model:free", "~vendor/model", "vendor/model?bad", "~malformed", "vendor/???bad:batch", "openrouter/auto", "openrouter/fusion", "openrouter/???bad"];
 const r = await run(prices, { ids });
 expect(r.bodies).toEqual([]);
 expect(r.report.models.map(m => m.causes)).toEqual([["batch_variant"], ["free_variant"], ["router_alias"], ["invalid_id"], ["invalid_id"], ["invalid_id"], ["router_alias"], ["router_alias"], ["invalid_id"]]);
 expect(r.report.models.map(m => m.model)).toEqual(ids);
});
it("replays real models AND endpoints offline and gives exactly one cause per excluded model", async () => {
 const catalogue = JSON.parse(readFileSync(new URL("../fixtures/openrouter-discovery2-catalogue.json", import.meta.url), "utf8")) as { models: { data: { id: string }[] } };
 const fetcher = vi.fn(() => { throw new Error("offline proof attempted network"); });
 const counts: Record<string, number> = {};
 const classified: { model: string; cause: string }[] = [];
 for (const item of catalogue.models.data) {
  const report = await qualify({ allModels: true, catalogue: { ...catalogue, models: { data: [item] } }, spendCap: "0.000001", perModelCap: "1", env: { OPENROUTER_API_KEY: "discovery2-offline-fixture" }, fetch: fetcher, now: () => 1000 });
  expect(report.errors, item.id).toEqual([]);
  expect(report.chargedMicros).toBe(0); expect(report.preCallHoldsMicros).toBe(0);
  const model = report.models[0]!;
  // A route admitted to the reservation guard is eligible; it is never sent.
  const cause = model.causes.includes("overall_cap") || model.causes.includes("per_model_cap") ? "eligible" : model.causes[0]!;
  expect(cause, item.id).toBeTruthy();
  if (cause !== "eligible") expect(model.causes, item.id).toHaveLength(1);
  classified.push({ model: item.id, cause }); counts[cause] = (counts[cause] ?? 0) + 1;
 }
 expect(fetcher).not.toHaveBeenCalled();
 expect(classified).toHaveLength(441);
 expect(new Set(classified.map(m => m.model)).size).toBe(441);
 expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(441);
 expect(counts).toEqual({ eligible: 256, unpriced_component: 13, no_tools_support: 58, provider_routing: 16, batch_variant: 61, free_variant: 11, router_alias: 26 });
});
