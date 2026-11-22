import { expect, it } from "vitest";
const script = new URL("../../scripts/openrouter-qualify.mjs", import.meta.url).href;
type Call = { holdMicros: number; maxPromptTokens: number; checks: Record<string, string> };
type Provider = { cause?: string; calls: Call[]; reasons: Record<string, string> };
type Row = { model: string; status: string; assumedZero: string[]; reasoningBilledAtCompletion?: boolean; pricing: Record<string, string> };
type Report = { status: string; models: { model: string; status: string; reason: string; providers: Provider[] }[]; reservedMicros: number; exposureMicros: number; chargedMicros: number; failuresByCause: Record<string, number>; notReached: string[]; proposedTariffRows: Row[] };
const { qualify } = await import(script) as { qualify: (o: Record<string, unknown>) => Promise<Report> };
const full = { prompt: "0.000001", completion: "0.000002", internal_reasoning: "0.000003", request: "0.000001", input_cache_read: "0", input_cache_write: "0" };
const minimal = { prompt: full.prompt, completion: full.completion };
const entry = (id: string, pricing: Record<string, unknown> = minimal) => ({ id, pricing, supported_parameters: ["tools"], top_provider: { max_completion_tokens: 4096 } });
async function run(pricing: Record<string, unknown> = minimal, options: { ids?: string[]; cost?: string; cap?: string; write?: boolean; tokens?: number; hiddenProbe?: boolean } = {}) {
 const entries = (options.ids ?? ["vendor/a"]).map(id => entry(id, pricing));
 const bodies: Record<string, unknown>[] = []; let generation: Record<string, unknown> = {};
 const fetcher: typeof fetch = async (url, init) => {
  const req = new Request(url, init); const path = new URL(req.url).pathname;
  if (path === "/api/v1/models") return Response.json({ data: entries });
  if (path.endsWith("/endpoints")) return Response.json({ data: { endpoints: ["first", "second"].map(tag => ({ tag, provider_name: tag, pricing, supported_parameters: ["tools"], max_completion_tokens: 4096 })) } });
  if (req.method !== "POST") return Response.json({ data: generation });
  const body = await req.json() as Record<string, unknown>; bodies.push(body);
  // Catch search/media/cache additions on EVERY outgoing call, including cap probes.
  expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model", "provider", "reasoning", "stream", "usage"]);
  expect(Array.isArray(body.messages)).toBe(true);
  for (const message of body.messages as Record<string, unknown>[]) { expect(message.role).toBe("user"); expect(typeof message.content).toBe("string"); }
  expect(JSON.stringify(body)).not.toMatch(/plugins|web_search|image_url|input_audio|cache_control|prompt_cache|caching/u);
  const provider = body.provider as { only: string[]; max_price: Record<string, number> };
  const probing = provider.max_price.prompt === 0 || provider.max_price.completion === 0 || provider.max_price.request === 0 && (Number(pricing.request ?? 0) > 0 || Array.isArray(pricing.overrides) && pricing.overrides.some((o: unknown) => typeof o === "object" && o !== null && Number((o as Record<string, unknown>).request ?? 0) > 0));
  if (probing && !options.hiddenProbe) return Response.json({ error: { message: "No endpoints found that satisfy the max price for this request" } }, { status: 404 });
  const tokens = options.tokens ?? 1025;
  const cost = probing && options.hiddenProbe ? "0.005" : options.cost ?? "0.00206"; // 10 prompt + 1025 output; no separate reasoning charge.
  generation = { model: body.model, provider_name: provider.only[0], native_tokens_prompt: 10, native_tokens_completion: tokens, native_tokens_reasoning: 341, native_tokens_cached: 0, total_cost: cost, is_byok: false };
  return Response.json({ id: `gen-${bodies.length}`, model: body.model, choices: [{ message: { content: "four" } }], usage: { prompt_tokens: 10, completion_tokens: tokens, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: options.write ? 1 : 0 }, completion_tokens_details: { reasoning_tokens: 341 }, cost, cost_details: { upstream_inference_cost: cost } } });
 };
 const report = await qualify({ allModels: true, spendCap: options.cap ?? "15", perModelCap: "1", fetch: fetcher, env: { OPENROUTER_API_KEY: "absent-zero-fixture-credential" }, now: () => 1000, sleep: async () => {} });
 return { report, bodies };
}
it("holds absent reasoning at completion for max completion PLUS reasoning and records only zero assumptions", async () => {
 const { report } = await run();
 expect(report.status).toBe("PASS");
 const call = report.models[0]!.providers[0]!.calls[0]!;
 // Integer micro-USD rates: prompt bytes + (4096 + 1024) * 2.
 expect(call.holdMicros).toBe(call.maxPromptTokens + 10240);
 expect(report.proposedTariffRows).toHaveLength(2);
 for (const row of report.proposedTariffRows) {
  expect(row.assumedZero).toEqual(["request", "input_cache_read", "input_cache_write"]);
  expect(row.pricing.internal_reasoning).toBe("0.000002");
  expect(row.reasoningBilledAtCompletion).toBe(true);
 }
});
it.each(["request", "input_cache_read", "input_cache_write"])("accepts only ABSENT %s as zero; explicit malformed values refuse", async field => {
 const p: Record<string, unknown> = { ...full }; delete p[field];
 const { report } = await run(p);
 expect(report.status).toBe("PASS"); expect(report.proposedTariffRows[0]!.assumedZero).toEqual([field]);
 for (const value of [null, "bad", "-1"]) {
  const bad = await run({ ...p, [field]: value });
  expect(bad.bodies).toEqual([]); expect(bad.report.models[0]!.reason).toContain(`pricing.${field}`);
 }
});
it.each(["web_search", "image", "audio", "input_audio", "output_audio", "input_audio_cache", "input_cache_write_1h"])("permits unused nonzero %s without sending its input or controls", async field => {
 const { report } = await run({ ...minimal, [field]: "0.01" });
 expect(report.status).toBe("PASS");
});
it("names an unknown price key and excludes unknown override shapes before sending", async () => {
 for (const p of [{ ...minimal, secret_fee: "0" }, { ...minimal, overrides: [{ mystery: "0.1" }] }, { ...minimal, overrides: { completion: "0.01" } }]) {
  const r = await run(p); expect(r.bodies).toEqual([]);
  expect(r.report.models[0]!.reason).toContain("secret_fee" in p ? "secret_fee" : "overrides");
 }
});
it("takes component maxima over base and every conditional override, including absent reasoning fallback", async () => {
 const { report, bodies } = await run({ ...minimal, overrides: [{ min_prompt_tokens: 1000, prompt: "0.000003", completion: "0.000004" }, { min_prompt_tokens: 2000, prompt: "0.000002", completion: "0.000006", request: "0.000007" }] });
 expect(report.status).toBe("PASS");
 const call = report.models[0]!.providers[0]!.calls[0]!;
 expect(call.holdMicros).toBe(call.maxPromptTokens * 3 + 30720 + 7);
 expect(bodies[0]!.provider).toMatchObject({ max_price: { prompt: 3, completion: 6, request: 0.000007 } });
 expect(report.proposedTariffRows[0]!.pricing).toMatchObject({ prompt: "0.000003", completion: "0.000006", internal_reasoning: "0.000006", request: "0.000007" });
 expect(report.proposedTariffRows[0]!.assumedZero).not.toContain("request");
});
it.each(["15", "0.004"])("refuses hidden charge, records FAIL cause, retains hold, stops the model and stops the run above cap %s", async cap => {
 const prices = cap === "15" ? minimal : { ...full, prompt: "0.000000001", completion: "0.000000002", internal_reasoning: "0.000000003" };
 const { report, bodies } = await run(prices, { cost: "0.005", cap, ids: ["vendor/a", "vendor/b"] });
 expect(report.status).toBe("FAIL"); expect(report.proposedTariffRows).toEqual([]);
 expect(report.failuresByCause.hidden_charge).toBeGreaterThan(0);
 expect(bodies.filter(b => b.model === "vendor/a")).toHaveLength(1);
 const hold = report.models[0]!.providers[0]!.calls[0]!.holdMicros;
 expect(report.reservedMicros).toBe(hold * (cap === "15" ? 2 : 1));
 if (cap === "15") expect(hold).toBeGreaterThan(5000);
 expect(report.exposureMicros).toBeGreaterThanOrEqual(5000);
 if (cap === "0.004") { expect(bodies).toHaveLength(1); expect(report.notReached).toContain("vendor/b"); }
 else expect(bodies.filter(b => b.model === "vendor/b")).toHaveLength(1);
});
it("enforces token maximum <= hold even when the reported cost fits both", async () => {
 const { report } = await run({ ...full, completion: "0.000002", internal_reasoning: "0" }, { tokens: 4096 });
 expect(report.status).toBe("FAIL");
 expect(report.models[0]!.providers[0]!.calls[0]!.checks.token_max_within_hold).toBe("FAIL");
});
it("keeps the unexpected write refusal for newly eligible absent-write models", async () => {
 const { report } = await run(minimal, { write: true });
 expect(report.status).toBe("FAIL"); expect(report.proposedTariffRows).toEqual([]);
 expect(report.models[0]!.providers[0]!.calls[0]!.checks.no_reported_auxiliary_charge).toBe("FAIL");
 expect(report.exposureMicros).toBeGreaterThanOrEqual(report.reservedMicros);
});
it("uses exact thinking IDs and excludes router aliases and free/online IDs with raw reasons", async () => {
 const ids = ["vendor/a:thinking", "~vendor/a~version", "vendor/a:free", "vendor/a:online", "vendor/a?bad"];
 const { report, bodies } = await run(minimal, { ids });
 expect(report.models.map(m => m.model)).toEqual(ids);
 expect(report.models.slice(0, 1).every(m => m.status === "PASS")).toBe(true);
 for (const id of ids.slice(0, 1)) {
  expect(bodies.filter(body => body.model === id)).toHaveLength(12); // Four controls + two cap probes per provider.
  expect(report.proposedTariffRows.filter(row => row.model === id)).toHaveLength(2);
 }
 expect(bodies.every(body => ids.slice(0, 1).includes(String(body.model)))).toBe(true);
 expect(report.proposedTariffRows.every(row => row.status === "CANDIDATE")).toBe(true);
 for (const model of report.models.slice(1)) { expect(model.status).toBe("FAIL"); expect(model.reason).toBeTruthy(); expect(bodies.some(b => b.model === model.model)).toBe(false); }
 expect(report.models[2]!.reason).toContain("different data policy");
 expect(report.models[3]!.reason).toContain("search is never requested");
 const absent = await qualify({ allModels: true, fetch: async () => Response.json({ data: [] }), env: { OPENROUTER_API_KEY: "fixture" } });
 expect(absent.proposedTariffRows).toEqual([]);
});

it("refuses duplicate extended catalogue IDs before any qualification call", async () => {
 const ids = ["vendor/a:thinking", "vendor/a~version"];
 const { report, bodies } = await run(minimal, { ids: ids.flatMap(id => [id, id]) });
 expect(bodies).toEqual([]);
 expect(report.proposedTariffRows).toEqual([]);
 expect(report.models).toHaveLength(4);
 for (const model of report.models) {
  expect(model.status).toBe("FAIL");
  expect(model.reason).toContain("duplicate model identifier");
 }
});

it("applies the hidden-charge model stop to unexpectedly accepted cap probes", async () => {
 const { report, bodies } = await run(minimal, { hiddenProbe: true });
 expect(report.status).toBe("FAIL"); expect(report.proposedTariffRows).toEqual([]);
 expect(report.failuresByCause.hidden_charge).toBe(1);
 expect(bodies).toHaveLength(5); // four controls and the first accepted probe; no second provider.
 expect(report.reservedMicros).toBe(report.exposureMicros);
});

it("uses maxima across clock/day overrides and validates their shape instead of choosing today's rate", async () => {
 const r = await run({ ...minimal, overrides: [{ utc_days: ["saturday", "sunday"], utc_start: 1500, utc_end: 100, completion: "0.000006", input_cache_write_1h: "0.0000000833333333333333" }] });
 expect(r.report.status).toBe("PASS");
 expect(r.report.proposedTariffRows[0]!.pricing.completion).toBe("0.000006");
 for (const condition of [{ utc_start: 1500 }, { utc_start: 1560, utc_end: 100 }, { utc_days: ["funday"] }, { min_prompt_tokens: -1 }]) {
  const bad = await run({ ...minimal, overrides: [{ ...condition, completion: "0.000006" }] });
  expect(bad.bodies).toEqual([]); expect(bad.report.models[0]!.reason).toContain("overrides");
 }
});
