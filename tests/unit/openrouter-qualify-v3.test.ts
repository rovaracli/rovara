import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const script = new URL("../../scripts/openrouter-qualify.mjs", import.meta.url).href;
type Row = { model: string; status: string; max_completion_tokens: number; observedModelIds: string[]; zeroPriceProof: Record<string, { attempt: number; source: string }> };
type Call = { holdMicros: number; requestControls: { max_tokens: number }; checks: Record<string, string>; generation?: { model: string }; responseModel?: string; usage?: { cost_details: Record<string, unknown> } };
type Provider = { status: string; calls: Call[]; priceCapProbes?: { holdMicros: number }[]; candidateTariff?: Row };
type Report = { status: string; models: { model: string; resumed?: boolean; providers: Provider[] }[]; preCallHoldsMicros: number; perModelCapMicros: number; exposureMicros: number; chargedMicros: number; failuresByCause: Record<string, number>; proposedTariffRows: Row[] };
const { qualify } = await import(script) as { qualify: (options: Record<string, unknown>) => Promise<Report> };
const recorded = JSON.parse(readFileSync(new URL("../fixtures/openrouter-harness-v3.json", import.meta.url), "utf8")) as { model: string; actual: string; pricing: Record<string, string> };
const now = Date.UTC(2026, 10, 22);
async function run(options: { actual?: unknown; answer?: unknown; pricing?: Record<string, string>; ceiling?: number; spendCap?: string; perModelCap?: string; unknown?: boolean; badCheck?: boolean; breakdown?: boolean; cached?: number; reasoning?: number; zeroOutputBill?: boolean; resumeReport?: Report; ids?: string[]; at?: number } = {}) {
 const pricing = options.pricing ?? recorded.pricing;
 const ids = options.ids ?? [recorded.model];
 const entries = ids.map(id => ({ id, pricing, supported_parameters: ["tools"], top_provider: { max_completion_tokens: options.ceiling ?? 4096 } }));
 const bodies: { model: string; max_tokens: number; reasoning: { enabled: boolean; max_tokens: number }; provider: { max_price: Record<string, number> } }[] = [];
 let generation: Record<string, unknown> = {};
 const fetcher: typeof fetch = async (url, init) => {
  const request = new Request(url, init);
  if (request.method !== "POST") return Response.json({ data: generation });
  const body = await request.json() as typeof bodies[number]; bodies.push(body);
  const normalCaps = { prompt: Number(pricing.prompt) * 1e6, completion: Math.max(Number(pricing.completion), Number(pricing.internal_reasoning)) * 1e6, request: Number(pricing.request) };
  if (Object.entries(normalCaps).some(([key, value]) => value > 0 && body.provider.max_price[key] === 0)) return Response.json({ error: { message: "No endpoints found that satisfy the max price for this request" } }, { status: 404 });
  if (options.unknown) return new Response("unreadable");
  const cached = options.cached ?? 0;
  const reasoning = options.reasoning === 0 && bodies.length === 4 ? 8 : options.reasoning ?? 8;
  const promptCost = (10 - cached) * Number(pricing.prompt) + cached * Number(pricing.input_cache_read);
  const outputCost = options.zeroOutputBill ? 0 : 20 * Number(pricing.completion);
  const cost = (promptCost + outputCost + Number(pricing.request)).toFixed(12);
  const actual = Object.hasOwn(options, "actual") ? options.actual : body.model;
  generation = { model: actual, provider_name: "Fixture", native_tokens_prompt: 10, native_tokens_completion: 20, native_tokens_reasoning: reasoning, native_tokens_cached: cached, total_cost: cost, is_byok: false };
  return Response.json({ id: `gen-v3-${bodies.length}`, model: Object.hasOwn(options, "answer") ? options.answer : body.model, choices: [{ message: { content: options.badCheck ? "" : "four" } }], usage: { prompt_tokens: 10, completion_tokens: 20, prompt_tokens_details: { cached_tokens: cached, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: reasoning }, cost, cost_details: { upstream_inference_cost: cost, ...(options.breakdown ? { upstream_inference_prompt_cost: promptCost.toFixed(12), upstream_inference_completions_cost: outputCost.toFixed(12) } : {}) } } });
 };
 const report = await qualify({ allModels: true, catalogue: { models: { data: entries }, endpoints: Object.fromEntries(ids.map(id => [id, { data: { endpoints: [{ tag: "fixture", provider_name: "Fixture", pricing, supported_parameters: ["tools"], max_completion_tokens: options.ceiling ?? 4096 }] } }])) }, env: { OPENROUTER_API_KEY: "v3-fixture-only" }, now: () => options.at ?? now, fetch: fetcher, sleep: async () => {}, ...(options.spendCap ? { spendCap: options.spendCap } : {}), ...(options.perModelCap ? { perModelCap: options.perModelCap } : {}), ...(options.resumeReport ? { resumeReport: options.resumeReport } : {}) });
 return { report, bodies };
}
it.each([
 [recorded.model, true, recorded.model], [recorded.actual, true, recorded.actual],
 [`${recorded.model}-1118`, true, `${recorded.model}-20261118`],
 [`${recorded.model}-20240229`, true, `${recorded.model}-20240229`],
 [`${recorded.model}-2026-11-18`, true, `${recorded.model}-2026-11-18`], [`${recorded.model}-2024-02-29`, true, `${recorded.model}-2024-02-29`],
 ...["20260229", "20261301", "0230", "2026-02-29", "2026-13-01", "2026-11-18-extra", "2026-1-18", "1999-11-18", "20261118-extra", "preview", "211118", "x1118"].map(suffix => [`${recorded.model}-${suffix}`, false, ""] as [unknown, boolean, string]),
 ["other/gemini-4-neon-20261118", false, ""], ["googlx/gemini-4-neon-20261118", false, ""],
 [`${recorded.model}-21261118`, false, ""], [null, false, ""],
])("accepts only exact or calendar-dated identity %s", async (actual, accepted, normalized) => {
 const { report } = await run({ actual });
 expect(report.models[0]!.providers[0]!.calls[0]!.checks.identity_and_non_byok).toBe(accepted ? "PASS" : "FAIL");
 if (accepted) {
  expect(report.proposedTariffRows[0]!.observedModelIds).toContain(normalized);
  expect(report.models[0]!.providers[0]!.calls[0]!.generation!.model).toBe(actual);
 }
});
it("checks response identity independently and retains its raw dated ID", async () => {
 const good = await run({ answer: recorded.actual });
 expect(good.report.proposedTariffRows[0]!.observedModelIds).toContain(recorded.actual);
 expect(good.report.models[0]!.providers[0]!.calls[0]!.responseModel).toBe(recorded.actual);
 expect((await run({ answer: "other/model" })).report.proposedTariffRows).toEqual([]);
});
it.each([4096, 1024, 512])("uses the 1024 then 512 ladder under endpoint ceiling %s", async ceiling => {
 const r = await run({ ceiling });
 expect(r.report.status).toBe("PASS");
 expect(r.bodies.every(body => body.max_tokens === Math.min(1024, ceiling))).toBe(true);
 expect(r.bodies.every(body => body.reasoning.enabled && body.reasoning.max_tokens === body.max_tokens / 4)).toBe(true);
 expect(r.report.proposedTariffRows[0]!.max_completion_tokens).toBe(Math.min(1024, ceiling));
 expect(r.report.models[0]!.providers[0]!.calls).toHaveLength(4);
});
it("refuses ceilings below the ladder and never sends above a held budget", async () => {
 expect((await run({ ceiling: 511 })).bodies).toEqual([]);
 const first = await run();
 const hold = first.report.models[0]!.providers[0]!.calls[0]!.holdMicros;
 const r = await run({ spendCap: ((hold - 1) / 1e6).toFixed(6) });
 expect(r.bodies).toHaveLength(1); expect(r.bodies[0]!.max_tokens).toBe(512);
 expect(r.report.exposureMicros).toBeLessThan(hold);
});
it("enforces a hard $0.50 per-model maximum before send, including an owner cap above it", async () => {
 const pricing = { ...recorded.pricing, request: "0.26" };
 for (const perModelCap of [undefined, "1"]) {
  const r = await run({ pricing, ...(perModelCap ? { perModelCap } : {}), ids: [recorded.model, "vendor/next"] });
  expect(r.report.perModelCapMicros).toBe(500000);
  expect(r.bodies).toHaveLength(2);
  expect(r.report.failuresByCause.per_model_cap).toBe(2);
  expect(r.report.proposedTariffRows).toEqual([]);
 }
});
it("sums every pre-call hold exactly, retains unknown holds, and never reports the old name", async () => {
 for (const unknown of [false, true]) {
  const { report, bodies } = await run({ unknown });
  const provider = report.models[0]!.providers[0]!;
  const holds = [...provider.calls, ...(provider.priceCapProbes ?? [])].reduce((sum, call) => sum + call.holdMicros, 0);
  expect(report.preCallHoldsMicros).toBe(holds); expect(holds).toBeGreaterThan(0);
  expect(report.exposureMicros).toBe(holds); expect(bodies).toHaveLength(unknown ? 1 : 6);
  expect(report).not.toHaveProperty("reservedMicros");
 }
});
it("keeps explicitly priced zero cache components CANDIDATE without exercised billed proof", async () => {
 const { report } = await run({ breakdown: true });
 expect(report.proposedTariffRows[0]!.status).toBe("CANDIDATE");
 expect(report.proposedTariffRows[0]!.zeroPriceProof).not.toHaveProperty("input_cache_write");
 expect(report.proposedTariffRows[0]!.zeroPriceProof).not.toHaveProperty("input_cache_read");
});
it("promotes billing evidence only after each zero component is isolated in billed usage", async () => {
 const pricing = { ...recorded.pricing, prompt: "0", request: "0.000001", input_cache_read: "0.000001", input_cache_write: "0.000001" };
 const unproven = await run({ pricing });
 expect(unproven.report.proposedTariffRows[0]!.status).toBe("CANDIDATE");
 const proven = await run({ pricing, breakdown: true });
 expect(proven.report.proposedTariffRows[0]!.status).toBe("PROVEN");
 expect(proven.report.proposedTariffRows[0]!.zeroPriceProof.prompt).toMatchObject({ attempt: 1, source: "usage.cost_details.upstream_inference_prompt_cost" });
 expect((await run({ pricing, breakdown: true, badCheck: true })).report.proposedTariffRows).toEqual([]);
});
it("recomputes proof on resume and rejects a forged promotion", async () => {
 const first = await run();
 first.report.proposedTariffRows[0]!.status = "PROVEN";
 const next = await run({ resumeReport: first.report });
 expect(next.bodies.length).toBeGreaterThan(0);
 expect(next.report.models[0]!.resumed).not.toBe(true);
 expect(next.report.proposedTariffRows[0]!.status).toBe("CANDIDATE");
});
it.each(["spendCap", "perModelCap"])("accepts an exact %s boundary and refuses the next hold", async cap => {
 const first = await run();
 const total = first.report.preCallHoldsMicros;
 const exact = await run({ [cap]: (total / 1e6).toFixed(6) });
 expect(exact.report.status).toBe("PASS");
 const less = await run({ [cap]: ((total - 1) / 1e6).toFixed(6) });
 expect(less.report.status).toBe("FAIL");
 expect(less.report.preCallHoldsMicros).toBeLessThan(total);
});
it("requires proof independently for every zero component", async () => {
 const pricing = { ...recorded.pricing, prompt: "0", request: "0.000001", input_cache_write: "0.000001" };
 const r = await run({ pricing, breakdown: true });
 expect(r.report.proposedTariffRows[0]!.zeroPriceProof).toHaveProperty("prompt");
 expect(r.report.proposedTariffRows[0]!.zeroPriceProof).not.toHaveProperty("input_cache_read");
 expect(r.report.proposedTariffRows[0]!.status).toBe("CANDIDATE");
});
it("proves a zero cache-read rate only with fully cached, isolated billed input", async () => {
 const pricing = { ...recorded.pricing, request: "0.000001", input_cache_write: "0.000001" };
 const r = await run({ pricing, cached: 10, breakdown: true });
 expect(r.report.proposedTariffRows[0]!.zeroPriceProof).toHaveProperty("input_cache_read");
 expect(r.report.proposedTariffRows[0]!.status).toBe("PROVEN");
 const unused = await run({ pricing, breakdown: true });
 expect(unused.report.proposedTariffRows[0]!.zeroPriceProof).not.toHaveProperty("input_cache_read");
 expect(unused.report.proposedTariffRows[0]!.status).toBe("CANDIDATE");
});
it.each(["completion", "internal_reasoning"])("isolates zero %s in the output bill", async component => {
 const pricing = { ...recorded.pricing, request: "0.000001", input_cache_read: "0.000001", input_cache_write: "0.000001", [component]: "0" };
 const r = await run({ pricing, breakdown: true, reasoning: component === "completion" ? 0 : 20, zeroOutputBill: true });
 expect(r.report.proposedTariffRows[0]!.zeroPriceProof).toHaveProperty(component);
 expect(r.report.proposedTariffRows[0]!.status).toBe("PROVEN");
 const unproven = await run({ pricing, breakdown: true, reasoning: 8 });
 expect(unproven.report.proposedTariffRows[0]!.zeroPriceProof).not.toHaveProperty(component);
 expect(unproven.report.proposedTariffRows[0]!.status).toBe("CANDIDATE");
});
it.each([5, 10])("refuses zero prompt proof when cached input cannot isolate it: %s", async cached => {
 const pricing = { ...recorded.pricing, prompt: "0", request: "0.000001", input_cache_write: "0.000001" };
 const r = await run({ pricing, breakdown: true, cached });
 const row = r.report.proposedTariffRows[0]!;
 expect(row.zeroPriceProof).not.toHaveProperty("prompt");
 if (cached === 5) expect(row.zeroPriceProof).not.toHaveProperty("input_cache_read");
 expect(row.status).toBe("CANDIDATE");
});
it("refuses reasoning proof from a mixed output bill even when the whole output bill is zero", async () => {
 const pricing = { ...recorded.pricing, internal_reasoning: "0", request: "0.000001", input_cache_read: "0.000001", input_cache_write: "0.000001" };
 const r = await run({ pricing, breakdown: true, zeroOutputBill: true, reasoning: 8 });
 expect(r.report.proposedTariffRows[0]!.zeroPriceProof).not.toHaveProperty("internal_reasoning");
 expect(r.report.proposedTariffRows[0]!.status).toBe("CANDIDATE");
});
it.each(["row proof", "provider proof", "row IDs", "provider IDs", "unrecognized details", "broken breakdown"])("refuses changed resume evidence: %s", async field => {
 const pricing = { ...recorded.pricing, prompt: "0", request: "0.000001", input_cache_read: "0.000001", input_cache_write: "0.000001" };
 const first = await run({ pricing, breakdown: true });
 const provider = first.report.models[0]!.providers[0]!;
 const row = first.report.proposedTariffRows[0]!;
 // Resume reports are serialized files, so their provider/row objects are independent.
 const prior = structuredClone(first.report);
 const retained = prior.models[0]!.providers[0]!;
 if (field === "row proof") prior.proposedTariffRows[0]!.zeroPriceProof = {};
 if (field === "provider proof") retained.candidateTariff!.zeroPriceProof = {};
 if (field === "row IDs") prior.proposedTariffRows[0]!.observedModelIds = ["other/model"];
 if (field === "provider IDs") retained.candidateTariff!.observedModelIds = ["other/model"];
 if (field === "unrecognized details" || field === "broken breakdown") for (const call of retained.calls) call.usage!.cost_details[field === "unrecognized details" ? "unrecognized_component_count" : "upstream_inference_completions_cost"] = field === "unrecognized details" ? 1 : "1";
 expect(provider.candidateTariff!.status).toBe(row.status);
 const next = await run({ pricing, breakdown: true, resumeReport: prior });
 expect(next.bodies.length).toBeGreaterThan(0);
 expect(next.report.models[0]!.resumed).not.toBe(true);
});
it.each([
 ["a -1231 id seen on 1 January is last December", Date.UTC(2026, 0, 1), "1231", "20251231"],
 ["a -0101 id seen on 1 January is that day", Date.UTC(2026, 0, 1), "0101", "20260101"],
 ["a -1231 id seen on 31 December is that day", Date.UTC(2026, 11, 31, 23, 59), "1231", "20261231"],
 ["a -0101 id seen on 31 December is this year's 1 January", Date.UTC(2026, 11, 31), "0101", "20260101"],
 ["a -1123 id seen on 22 November is a future date, so last year", Date.UTC(2026, 10, 22), "1123", "20251123"],
 ["a -1122 id seen on 22 November is today", Date.UTC(2026, 10, 22), "1122", "20261122"],
 ["a leap-day id in a leap year", Date.UTC(2028, 2, 1), "0229", "20280229"],
] as const)("expands -MMDD against the run's UTC date: %s", async (_name, at, suffix, normalized) => {
 const { report } = await run({ actual: `${recorded.model}-${suffix}`, at });
 expect(report.models[0]!.providers[0]!.calls[0]!.checks.identity_and_non_byok).toBe("PASS");
 expect(report.proposedTariffRows[0]!.observedModelIds).toEqual([recorded.model, `${recorded.model}-${normalized}`].sort());
});
it("refuses a leap-day -MMDD id in a non-leap year", async () => {
 const { report } = await run({ actual: `${recorded.model}-0229`, at: Date.UTC(2026, 2, 1) });
 expect(report.models[0]!.providers[0]!.calls[0]!.checks.identity_and_non_byok).toBe("FAIL");
});
it("accepts OpenRouter's real dashed dated id for the production models and records it raw", async () => {
 for (const model of ["openai/gpt-5-mini", "openai/gpt-5-nano"]) {
  const { report } = await run({ ids: [model], actual: `${model}-2025-08-07`, answer: `${model}-2025-08-07` });
  expect(report.models[0]!.providers[0]!.calls[0]!.checks.identity_and_non_byok).toBe("PASS");
  expect(report.proposedTariffRows[0]!.observedModelIds).toContain(`${model}-2025-08-07`);
  expect(report.models[0]!.providers[0]!.calls[0]!.responseModel).toBe(`${model}-2025-08-07`);
  const compact = await run({ ids: [model], actual: `${model}-20250807` });
  expect(compact.report.proposedTariffRows[0]!.observedModelIds).toContain(`${model}-20250807`);
 }
});
it("refuses a model whose every advertised rate is zero before sending anything (no free-so-unlimited hold)", async () => {
 const zero = { prompt: "0", completion: "0", internal_reasoning: "0", request: "0", input_cache_read: "0", input_cache_write: "0" };
 const r = await run({ pricing: zero });
 expect(r.bodies).toEqual([]);
 expect(r.report.status).toBe("FAIL");
 expect(r.report.failuresByCause.zero_priced).toBe(1);
 expect(r.report.preCallHoldsMicros).toBe(0);
 expect(r.report.proposedTariffRows).toEqual([]);
 expect(JSON.stringify(r.report)).toContain("every advertised rate is zero");
});
it("still holds a positive amount when only the prompt rate is zero", async () => {
 const r = await run({ pricing: { ...recorded.pricing, prompt: "0" } });
 expect(r.bodies.length).toBeGreaterThan(0);
 expect(r.report.models[0]!.providers[0]!.calls.every(call => call.holdMicros >= 1)).toBe(true);
 expect(r.report.failuresByCause.zero_priced).toBeUndefined();
});
it("treats a flat per-request fee alone as a priced model with a positive hold", async () => {
 const flat = { prompt: "0", completion: "0", internal_reasoning: "0", request: "0.0001", input_cache_read: "0", input_cache_write: "0" };
 const r = await run({ pricing: flat });
 expect(r.bodies.length).toBeGreaterThan(0);
 expect(r.report.failuresByCause.zero_priced).toBeUndefined();
 expect(r.report.models[0]!.providers[0]!.calls.every(call => call.holdMicros >= 100)).toBe(true);
});
