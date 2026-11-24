import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
const script = new URL("../../scripts/openrouter-qualify.mjs", import.meta.url).href;
const { qualify } = await import(script) as { qualify: (options: Record<string, unknown>) => Promise<{ status: string; chargedMicros: number; preCallHoldsMicros: number; models: { model: string; status: string; reasoningProbe?: string; priceCapProbes?: { component: string; holdMicros: number; status: string; reason?: string; httpStatus?: number; chargedMicros?: number; error?: { code?: string; message?: string } }[]; reasons: Record<string, string>; checks: Record<string, string>; calls: { checks: Record<string, string>; reasons: Record<string, string>; holdMicros: number; reasoningOverCap?: { requestedMaxTokens: number; usageTokens: number; generationTokens: number }; generation?: { model: string }; usage?: { cost_details: { unrecognized_components: string[] } } }[]; boundedTariffErrors?: string[]; candidateTariff?: { max_completion_tokens: number; pricing: Record<string, string>; cacheWriteBasis?: string; cacheWriteEnforcementVersion?: string } }[] }> };
const models = ["vendor/model-a", "vendor/model-b"];
const relaxedModels = ["openai/gpt-5-mini", "openai/gpt-5-nano"];
const savedCatalogue = JSON.parse(readFileSync(new URL("../fixtures/model-gateway-prices/openrouter-bounded-20261120.json", import.meta.url), "utf8")) as { data: { id: string; pricing: Record<string, string>; top_provider: { max_completion_tokens: number } }[] };
const run8Refusal = JSON.parse(readFileSync(new URL("../fixtures/model-gateway-prices/openrouter-run8-refusal.json", import.meta.url), "utf8")) as { httpStatus: number; body: { error: { code: string; message: string } } };
const refusalMessage = run8Refusal.body.error.message;
const pricing = { prompt: "0.000000001", completion: "0.000000002", internal_reasoning: "0.000000003", request: "0.000001", input_cache_read: "0", input_cache_write: "0" };
/** The request body's reasoning object as a typed read: anything that is not an object reads as empty. */
const reasoningOf = (body: Record<string, unknown>): { enabled?: unknown; max_tokens?: unknown } => { const reasoning = body.reasoning; return typeof reasoning === "object" && reasoning !== null ? reasoning : {}; };
type LookupFixture = { lookup?: (generation: Record<string, unknown>, attempt: number) => Response; id?: unknown; answerModel?: unknown; probe?: (body: Record<string, unknown>, attempt: number) => Response };
async function fake(mode = "pass", cap = "0.50", entries?: { id: string; pricing: Record<string, unknown>; top_provider: { max_completion_tokens: number } }[], modelIds = models, evidence?: (usage: Record<string, unknown>, generation: Record<string, unknown>, body: Record<string, unknown>) => void, lookup: LookupFixture = {}) {
 const waits: number[] = []; let clock = 0;
 const requests: Record<string, unknown>[] = []; const probeRequests: Record<string, unknown>[] = []; let generations = 0; let refusals = 0;
 let generation: Record<string, unknown> = {};
 // Baseline receipt bills reasoning inside completion (the cheapest interpretation).
 const decimal = (v: unknown) => { if (v !== undefined && typeof v !== "string") throw new Error("Invalid fixture price"); const [whole, fraction = ""] = (v ?? "0").split("."); return BigInt(whole! + fraction.padEnd(18, "0")); };
 const billed = (p: Record<string, unknown>) => {
  const amount = 10n * decimal(p.prompt) + 513n * decimal(p.completion) + decimal(p.request);
  const text = amount.toString().padStart(19, "0"); return `${text.slice(0, -18)}.${text.slice(-18)}`;
 };
 // Fake HTTP server: Request/Response messages, no socket or external network.
 const httpServer: typeof fetch = async (url, init) => {
  expect(init?.redirect).toBe("error");
  const req = new Request(url, init); expect(new URL(req.url).origin).toBe("https://openrouter.ai"); const path = new URL(req.url).pathname;
  expect(req.headers.get("Authorization")).toBe("Bearer canary-key-never-print");
  if (path === "/api/v1/models") return Response.json({ data: entries ?? models.map(id => ({ id, pricing: mode === "fees" ? { ...pricing, image: "0.1" } : pricing, top_provider: { max_completion_tokens: 4096 } })) });
  if (req.method === "POST") {
   const b = await req.json() as Record<string, unknown>;
   for (const key of Object.keys(b)) expect(key).not.toMatch(/plugins|web|search|tools/iu);
   const caps = (b.provider as { max_price: Record<string, number> }).max_price;
   const prices = entries?.find(e => e.id === b.model)?.pricing ?? pricing;
   if (caps.prompt === 0 || caps.completion === 0 || caps.request === 0 && Number(prices.request ?? 0) > 0) {
    probeRequests.push(b);
    if (lookup.probe) return lookup.probe(b, probeRequests.length);
   }
   if ((caps.prompt === 0 || caps.completion === 0 || (caps.request === 0 && Number(prices.request ?? 0) > 0)) && mode !== "ignoredcaps") { refusals++; return mode === "schema" ? Response.json({ error: { message: "max_price.prompt must be greater than zero" } }, { status: 400 }) : Response.json(run8Refusal.body, { status: run8Refusal.httpStatus }); }
   requests.push(b);
   const cost = billed(entries?.find(e => e.id === b.model)?.pricing ?? pricing);
   const usage: Record<string, unknown> = { prompt_tokens: 10, completion_tokens: 513, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 171 }, cost: mode === "upstream_only" ? undefined : mode === "overage" ? 1 : cost, cost_details: { upstream_inference_cost: mode === "upstream_only" ? 0.01 : cost, ...(mode === "details" ? { surprise_fee: 1 } : {}) } };
   generation = { model: b.model, provider_name: mode === "route" ? "other-provider" : "fixture-provider", native_tokens_prompt: 10, native_tokens_completion: 513, native_tokens_reasoning: mode === "reasoning" ? -1 : 171, native_tokens_cached: 0, total_cost: mode === "mismatch" ? 0.1 : mode === "overage" ? 1 : cost, is_byok: false };
   evidence?.(usage, generation, b);
   if (mode === "faileddebit") return Response.json({ error: { message: "unavailable" }, usage: { cost: "0.009", cost_details: { upstream_inference_cost: "0.01" } } }, { status: 503 });
   return Response.json({ id: Object.hasOwn(lookup, "id") ? lookup.id : `gen-${requests.length}`, model: Object.hasOwn(lookup, "answerModel") ? lookup.answerModel : b.model, choices: [{ message: { content: mode === "empty" ? "" : "READY" } }], usage });
  }
  generations++;
  if (lookup.lookup) return lookup.lookup(generation, generations);
  if (mode === "generation" && generations === 1) return Response.json({}, { status: 503 });
  return Response.json({ data: generation });
 };
 const report = await qualify({ models: modelIds, provider: "fixture-provider", spendCap: cap, fetch: httpServer, now: () => clock, sleep: async (ms: number) => { waits.push(ms); clock += ms; }, env: { OPENROUTER_API_KEY: "canary-key-never-print" } });
 const stdout = JSON.stringify(report); const stderr = "";
 expect(stdout + stderr).not.toContain("canary-key-never-print"); expect(stdout + stderr).not.toContain("Authorization");
 return { report, requests, probeRequests, generations, refusals, waits };
}
it("qualifies three plain HTTP calls plus a separate reasoning probe per model using exact caps, pinned route and bounded reasoning and room for visible text", async () => {
 const r = await fake(); expect(r.report?.status).toBe("PASS"); expect(r.requests).toHaveLength(8); expect(r.generations).toBe(8);
 // Owner rule 2026-11-23: the three CONTROL probes send reasoning OFF; the 4th (the reasoning probe) keeps the bounded 1024.
 expect(r.requests[0]).toMatchObject({ max_tokens: 2048, reasoning: { enabled: false }, provider: { order: ["fixture-provider"], only: ["fixture-provider"], allow_fallbacks: false, max_price: { prompt: 0.001, completion: 0.003 } } });
 expect(r.requests[0]).not.toHaveProperty("plugins");
 expect(r.requests.slice(0, 3).every(b => { const reasoning = reasoningOf(b); return reasoning.enabled === false && reasoning.max_tokens === undefined; })).toBe(true);
 expect(r.requests[3]).toMatchObject({ reasoning: { enabled: true, max_tokens: 1024 } });
});
it.each(["reasoning", "route", "mismatch", "overage", "fees", "details"])("fails each model independently on %s", async mode => {
 const r = await fake(mode); expect(r.report?.status).toBe("FAIL"); expect(r.requests).toHaveLength(mode === "fees" ? 0 : mode === "overage" ? 1 : 2);
 if (mode === "overage") expect(r.report?.chargedMicros).toBe(1_000_000);
});
it("reserves against the total spend cap before any paid request", async () => {
 const r = await fake("pass", "0.000001"); expect(r.report?.status).toBe("FAIL"); expect(r.requests).toEqual([]);
});

it("enforces the hard $0.50 single-model ceiling even when the spend cap is far higher (kills a 10x ceiling)", async () => {
 // Each hold is just over $0.20, so a third call would take one model past $0.50.
 const dear = models.map(id => ({ id, pricing: { ...pricing, request: "0.2" }, top_provider: { max_completion_tokens: 4096 } }));
 const r = await fake("pass", "5.00", dear);
 expect(r.report.status).toBe("FAIL");
 expect(r.requests).toHaveLength(4); // two sends per model, then refused before send
 for (const model of r.report.models) {
  expect(model.calls).toHaveLength(2);
  expect(model.checks.per_model_cap).toBe("FAIL");
  expect(model.calls.reduce((sum, call) => sum + call.holdMicros, 0)).toBeLessThanOrEqual(500_000);
 }
 expect(r.report.preCallHoldsMicros).toBeLessThanOrEqual(1_000_000);
});
it("refuses the next hold above the hard $0.50 single-model ceiling before sending (one rung: no smaller size, kills a loosened ceiling)", async () => {
 const dear = models.map(id => ({ id, pricing: { ...pricing, completion: "0.00014", internal_reasoning: "0.00014" }, top_provider: { max_completion_tokens: 4096 } }));
 const r = await fake("pass", "5.00", dear);
 // Hold at 2048 is ~$0.287: the first call takes it; a second would pass $0.50, and there is no smaller rung to drop to.
 expect(r.requests.map(b => b.max_tokens)).toEqual([2048, 2048]);
 for (const model of r.report.models) {
  expect(model.calls).toHaveLength(1);
  expect(model.calls[0]!.holdMicros).toBeGreaterThanOrEqual(2048 * 140);
  expect(model.calls[0]!.holdMicros).toBeLessThanOrEqual(500_000);
  expect(model.checks.per_model_cap ?? model.checks.spend_cap).toBe("FAIL");
 }
});
it("proves each positive price cap rejects an otherwise identical request at zero", async () => {
 const r = await fake(); expect(r.report?.status).toBe("PASS"); expect(r.refusals).toBe(6);
});

it("rejects a generic zero-price schema error as proof of routing enforcement", async () => {
 const r = await fake("schema"); expect(r.report?.status).toBe("FAIL");
});
it("records and refuses an unexpectedly accepted zero-cap probe", async () => {
 const r = await fake("ignoredcaps"); expect(r.report?.status).toBe("FAIL"); expect(r.requests).toHaveLength(14); expect(r.generations).toBe(14); expect(r.report?.chargedMicros).toBe(42);
});

it("records the larger generation debit even when totals disagree", async () => {
 const r = await fake("mismatch"); expect(r.report?.status).toBe("FAIL"); expect(r.report?.chargedMicros).toBe(200_000);
});
it("records an upstream-only debit even when total usage cost is unreadable", async () => {
 const r = await fake("upstream_only"); expect(r.report?.status).toBe("FAIL"); expect(r.report?.chargedMicros).toBe(20_000);
});

// REVIEW-M2-HARNESS P1: a provider that echoes the credential as a generation id must never get it into a lookup URL, the
// report, stdout or stderr: on the ordinary call path AND the accepted-probe path.
it("never sends, prints or reports a provider-echoed credential (ordinary call and accepted probe)", async () => {
 const KEY = "canary-key-never-print";
 const { containsCredential } = await import(script) as { containsCredential: (text: string, key: string) => boolean };
 const urls: string[] = [];
 const echo: typeof fetch = async (url, init) => {
  const req = new Request(url, init); urls.push(req.url); const path = new URL(req.url).pathname;
  if (path === "/api/v1/models") return Response.json({ data: models.map(id => ({ id, pricing, top_provider: { max_completion_tokens: 4096 } })) });
  if (req.method === "POST") {
   const b = await req.json() as Record<string, unknown>;
   // accept every request, including the zero-cap probes, and echo the credential as the id
   return Response.json({ id: `gen-${KEY}`, model: b.model, usage: { prompt_tokens: 10, completion_tokens: 513, completion_tokens_details: { reasoning_tokens: 171 }, cost: 0.00000408 } });
  }
  return Response.json({ data: { total_cost: 0.00000408 } });
 };
 const report = await qualify({ models, provider: "fixture-provider", spendCap: "0.50", fetch: echo, env: { OPENROUTER_API_KEY: KEY } });
 expect(report.status).toBe("FAIL");
 for (const u of urls) expect(containsCredential(decodeURIComponent(u), KEY), u).toBe(false);
 expect(urls.some(u => u.includes("/generation"))).toBe(false);
 expect(JSON.stringify(report)).not.toContain(KEY);
 // any 16-character piece of the key also counts as the credential
 expect(containsCredential(`gen-x${KEY.slice(3, 19)}y`, KEY)).toBe(true);
 expect(containsCredential("gen-123", KEY)).toBe(false);
});

const catalogueEntry = (id: string, prices: Record<string, unknown>, max = 128000) => ({ id, pricing: prices, top_provider: { max_completion_tokens: max } });
const publicPrices = { prompt: "0.00000025", completion: "0.000002", web_search: "0.01", input_cache_read: "0.000000025", input_cache_write: "0" };
it("qualifies omitted reasoning/request prices with an explicit write price without sending search controls", async () => {
 const r = await fake("pass", "0.50", relaxedModels.map(id => catalogueEntry(id, publicPrices)), relaxedModels);
 expect(r.report.status).toBe("PASS"); expect(r.requests).toHaveLength(8);
 for (const result of r.report.models) {
  expect(result.candidateTariff?.pricing).toEqual({ prompt: publicPrices.prompt, completion: publicPrices.completion, internal_reasoning: "0", request: "0", input_cache_read: publicPrices.input_cache_read, input_cache_write: "0" });
  for (const call of result.calls) expect(call.checks.no_web_search_cost).toBe("PASS");
 }
 for (const body of r.requests) for (const key of ["plugins", "web_search_options", "tools"]) expect(body).not.toHaveProperty(key);
});
it("checks each bounded tariff independently and makes no paid calls for a failed model", async () => {
 const r = await fake("pass", "0.50", [catalogueEntry(relaxedModels[0]!, { ...publicPrices, image: "0.01" }), catalogueEntry(relaxedModels[1]!, publicPrices)], relaxedModels);
 expect(r.report.status).toBe("FAIL"); expect(r.report.models[0]?.checks.bounded_tariff).toBe("FAIL");
 expect(r.report.models[0]?.calls).toEqual([]);
 expect(r.report.models[1]?.checks.bounded_tariff).toBe("PASS"); expect(r.requests).toHaveLength(4);
 expect(r.requests.every(b => b.model === relaxedModels[1])).toBe(true);
});
it.each(["image", "audio", "input_audio", "output_audio", "input_cache_write_1h", "unknown_fee"])("reports both models' nonzero %s catalog values without inference", async field => {
 const r = await fake("pass", "0.50", models.map(id => catalogueEntry(id, { ...publicPrices, [field]: "0.01" })));
 expect(r.requests).toEqual([]);
 for (const result of r.report.models) { expect(result.checks.bounded_tariff).toBe("FAIL"); expect(result.boundedTariffErrors).toContain(`pricing.${field}="0.01"`); }
});
it("names all invalid price fields, missing required prices and a short output bound", async () => {
 const r = await fake("pass", "0.50", [catalogueEntry(models[0]!, { completion: "0.000002", request: null, image: "0.02", audio: "0.03" }), catalogueEntry(models[1]!, publicPrices, 511)]);
 expect(r.requests).toEqual([]);
 expect(r.report.models[0]?.boundedTariffErrors).toEqual(expect.arrayContaining(["pricing.prompt missing required field", "pricing.request=null", 'pricing.image="0.02"', 'pricing.audio="0.03"']));
 expect(r.report.models[1]?.boundedTariffErrors).toContain("max_completion_tokens <= 1024: below the runtime bounded-reasoning floor");
});
it("never reports arbitrary catalog text or echoed credentials in bounded diagnostics", async () => {
 const r = await fake("pass", "0.50", models.map(id => catalogueEntry(id, { ...publicPrices, prompt: "canary-key-never-print", provider_message: "Authorization: arbitrary upstream text" })));
 expect(r.requests).toEqual([]); expect(JSON.stringify(r.report)).not.toContain("arbitrary upstream text");
 expect(r.report.models.every(m => m.checks.bounded_tariff === "FAIL")).toBe(true);
});
it("stops all later inference on credential failure", async () => {
 let paidCalls = 0;
 const report = await qualify({ models, provider: "fixture-provider", env: { OPENROUTER_API_KEY: "canary-key-never-print" }, fetch: async (_url: string, init?: RequestInit) => {
  if (init?.method === "GET") return Response.json({ data: models.map(id => catalogueEntry(id, pricing)) });
  paidCalls++; return Response.json({ error: { message: "credential problem" } }, { status: 401 });
 } });
 expect(paidCalls).toBe(1); expect(report.models[1]?.checks.not_attempted).toBe("FAIL");
});

it("refuses saved native-search catalog models before every POST with a web_search not-allowlisted reason", async () => {
 const nativeModels = ["perplexity/sonar-deep-research", "perplexity/sonar-reasoning-pro"];
 const r = await fake("pass", "0.50", savedCatalogue.data, nativeModels);
 expect(r.requests).toEqual([]); expect(r.refusals).toBe(0); expect(r.generations).toBe(0);
 for (const result of r.report.models) {
  expect(result.checks.bounded_tariff).toBe("FAIL"); expect(result.calls).toEqual([]);
  expect(result.boundedTariffErrors).toContain('pricing.web_search="0.005" (not allowlisted)');
 }
});
it("qualifies the live report models with absent cache-write prices and records enforced proof", async () => {
 const r = await fake("pass", "0.50", savedCatalogue.data, relaxedModels);
 expect(r.report.status).toBe("PASS"); expect(r.requests).toHaveLength(8);
 for (const result of r.report.models) {
  expect(result.checks.bounded_tariff).toBe("PASS");
  expect(result.candidateTariff).toMatchObject({ cacheWriteBasis: "never_requested_enforced", cacheWriteEnforcementVersion: "openrouter-no-cache-write-v1", pricing: { input_cache_write: "0" } });
 }
 for (const body of r.requests) expect(JSON.stringify(body)).not.toMatch(/cache_control|prompt_cache|caching/u);
});
it("refuses unexpected writes with absent prices even when inference totals reconcile", async () => {
 const r = await fake("pass", "0.50", savedCatalogue.data, relaxedModels, usage => { usage.prompt_tokens_details = { cached_tokens: 0, cache_write_tokens: 1 }; });
 expect(r.report.models[0]?.checks.bounded_tariff).toBe("PASS");
 expect(r.report.status).toBe("FAIL"); expect(r.requests).toHaveLength(2);
 expect(r.report.models[0]?.calls[0]?.checks.no_reported_auxiliary_charge).toBe("FAIL");
 expect(r.report.chargedMicros).toBe(1235);
});
it.each(["internal_reasoning", "request", "input_cache_read", "input_cache_write"])("refuses non-allowlisted models missing %s before any POST", async field => {
 const missing = { ...pricing }; Reflect.deleteProperty(missing, field);
 const r = await fake("pass", "0.50", models.map(id => catalogueEntry(id, missing)));
 expect(r.requests).toEqual([]); expect(r.refusals).toBe(0);
 for (const result of r.report.models) {
  expect(result.checks.bounded_tariff).toBe("FAIL");
  expect(result.boundedTariffErrors).toContain(`pricing.${field} missing required field (not allowlisted)`);
 }
});
it("refuses paid search outside the allowlist even with all six prices present", async () => {
 const r = await fake("pass", "0.50", models.map(id => catalogueEntry(id, { ...pricing, web_search: "0.01" })));
 expect(r.requests).toEqual([]); expect(r.refusals).toBe(0);
 for (const result of r.report.models) expect(result.boundedTariffErrors).toContain('pricing.web_search="0.01" (not allowlisted)');
});

// REVIEW-BOUNDED-2 P1: complete synthetic tariffs isolate post-call checks from P2's pre-call refusal.
const feeCases = ["details-search", "usage-search", "generation-search", "usage-write", "generation-write", "cache-write-tokens", "aggregate-slack", "usage-other-fee"];
it.each(relaxedModels.flatMap(model => feeCases.map(fee => [model, fee] as const)))("refuses positive auxiliary evidence for %s: %s", async (model, fee) => {
 const entries = savedCatalogue.data.filter(e => relaxedModels.includes(e.id)).map(e => ({ ...e, pricing: { ...e.pricing, input_cache_write: "0" } }));
 const ids = [model, relaxedModels.find(id => id !== model)!];
 const r = await fake("pass", "0.50", entries, ids, (usage, generation) => {
  expect(["0.001028500000000000", "0.000205700000000000"]).toContain(usage.cost);
  const withFee = usage.cost === "0.001028500000000000" ? "0.0010286" : "0.0002058";
  usage.cost = withFee; generation.total_cost = withFee;
  if (fee === "details-search") (usage.cost_details as Record<string, unknown>).web_search = "0.0000001";
  if (fee === "usage-search") usage.web_search_cost = "0.0000001";
  if (fee === "generation-search") generation.web_search_cost = "0.0000001";
  if (fee === "usage-write") usage.cache_write_cost = "0.0000001";
  if (fee === "generation-write") generation.cache_write_cost = "0.0000001";
  if (fee === "cache-write-tokens") usage.prompt_tokens_details = { cached_tokens: 0, cache_write_tokens: 10 };
  if (fee === "usage-other-fee") usage.extra = { service_fee: "0.0000001" };
 });
 expect(r.report.status).toBe("FAIL"); expect(r.requests).toHaveLength(2); expect(r.refusals).toBe(0);
 expect(r.report.models[0]?.calls[0]?.checks.no_web_search_cost).toBe("FAIL");
 expect(r.report.models[1]?.calls).toHaveLength(1);
 // The positive fee fits the rounded hold, and must still be refused.
 expect(r.report.chargedMicros).toBe(1235);
});
it.each(relaxedModels)("accepts exact fee-free inference evidence for complete synthetic %s tariff", async model => {
 const entries = savedCatalogue.data.filter(e => relaxedModels.includes(e.id)).map(e => ({ ...e, pricing: { ...e.pricing, input_cache_write: "0" } }));
 const r = await fake("pass", "0.50", entries, [model, relaxedModels.find(id => id !== model)!]);
 expect(r.report.status).toBe("PASS"); expect(r.requests).toHaveLength(8); expect(r.refusals).toBe(4);
});
it("refuses positive documented cache-write tokens even when reported costs equal exact inference", async () => {
 const r = await fake("pass", "0.50", undefined, models, usage => { usage.prompt_tokens_details = { cached_tokens: 0, cache_write_tokens: 10 }; });
 expect(r.report.status).toBe("FAIL"); expect(r.requests).toHaveLength(2); expect(r.refusals).toBe(0);
 expect(r.report.models[0]?.calls[0]?.checks.no_web_search_cost).toBe("FAIL");
});

it("refuses a positive fee outside cost_details even when both total costs still reconcile", async () => {
 const r = await fake("pass", "0.50", undefined, models, (usage, generation) => {
  expect(generation.total_cost).toBe(usage.cost);
  usage.service_fee = "0.0000001";
 });
 expect(r.report.status).toBe("FAIL");
 expect(r.requests).toHaveLength(2);
 expect(r.report.models[0]?.calls[0]?.checks.no_reported_auxiliary_charge).toBe("FAIL");
});

// LIVE2: removing continuation, visible-answer checks or full-bound holds must fail these cases.
it("continues to nano after mini generation evidence fails, keeping overall FAIL", async () => {
 const r = await fake("generation", "0.50", savedCatalogue.data, relaxedModels);
 expect(r.report.status).toBe("FAIL");
 expect(r.report.models[0]?.calls[0]?.checks.generation).toBe("FAIL");
 expect(r.report.models[1]).toMatchObject({ model: relaxedModels[1], status: "PASS" });
 expect(r.requests).toHaveLength(5);
});
it("requires visible response text even with valid generation token counts", async () => {
 const r = await fake("empty");
 expect(r.report.status).toBe("FAIL");
 expect(r.report.models.map(m => m.calls[0]?.checks.visible_text)).toEqual(["FAIL", "FAIL"]);
 expect(r.requests).toHaveLength(2);
});
it("uses a short prompt and holds the entire combined output bound", async () => {
 const r = await fake("pass", "0.50", savedCatalogue.data, relaxedModels);
 expect(r.report.status).toBe("PASS");
 for (const body of r.requests.filter(b => !JSON.stringify(b.messages).includes("Reasoning probe:"))) {
  expect(Number(body.max_tokens)).toBe(2048);
  expect(JSON.stringify(body.messages)).not.toMatch(/Think hard|keep reasoning until/u);
 }
 // Mini completion/reasoning: $2/M * 4096 = 8192 micros, before prompt cost.
 expect(r.report.models[0]?.calls[0]?.holdMicros).toBeGreaterThanOrEqual(2048);
});
it("names unknown charged components and refuses even when inference totals reconcile", async () => {
 const r = await fake("pass", "0.50", undefined, models, usage => {
  (usage.cost_details as Record<string, unknown>).unpriced_component = "0.0000001";
 });
 expect(r.report.status).toBe("FAIL"); expect(r.requests).toHaveLength(2);
 for (const m of r.report.models) {
  expect(m.calls[0]?.usage?.cost_details.unrecognized_components).toEqual(["unpriced_component"]);
  expect(m.calls[0]?.checks.cost_details_covered).toBe("FAIL");
 }
});
it("redacts unsafe and credential-bearing cost component names", async () => {
 const r = await fake("pass", "0.50", undefined, models, usage => {
  Object.assign(usage.cost_details as object, { "canary-key-never-print": 1, "Authorization: arbitrary upstream text": 1 });
 });
 expect(r.report.status).toBe("FAIL");
 expect(r.report.models[0]?.calls[0]?.usage?.cost_details.unrecognized_components).toEqual(["[invalid field]", "[invalid field]"]);
 expect(JSON.stringify(r.report)).not.toContain("arbitrary upstream text");
});

// FIX-PROBE: reasoning is a separate paid call; neither probe may under-reserve.
it("qualifies zero-reasoning plain answers with a separate explicitly requested bounded reasoning probe", async () => {
 const r = await fake("pass", "0.50", undefined, models, (usage, generation, body) => {
  if (JSON.stringify(body.messages).includes("Reasoning probe:")) return;
  usage.completion_tokens = 1;
  generation.native_tokens_completion = 1;
  usage.completion_tokens_details = { reasoning_tokens: 0 };
  usage.cost = "0.000001012";
  usage.cost_details = { upstream_inference_cost: "0.000001012" };
  generation.native_tokens_reasoning = 0;
  generation.total_cost = "0.000001012";
 });
 expect(r.report.status).toBe("PASS");
 expect(r.requests).toHaveLength(8);
 for (const model of models) {
  const calls = r.requests.filter(b => b.model === model);
  expect(calls.slice(0, 3).every(b => JSON.stringify(b.messages).includes("What is 2 + 2?"))).toBe(true);
  expect(calls[3]).toMatchObject({ max_tokens: 2048, reasoning: { enabled: true, max_tokens: 1024 } });
  expect(JSON.stringify(calls[3]?.messages)).toMatch(/Reasoning probe:.*reason/iu);
 }
 for (const model of r.report.models) expect(model.calls[3]?.checks.high_reasoning_exercised).toBe("PASS");
});
it("refuses a reasoning probe that reports no reasoning even when plain answers pass", async () => {
 const r = await fake("pass", "0.50", undefined, models, (usage, generation, body) => {
  if (!JSON.stringify(body.messages).includes("Reasoning probe:")) return;
  usage.completion_tokens = 1;
  generation.native_tokens_completion = 1;
  usage.completion_tokens_details = { reasoning_tokens: 0 };
  usage.cost = "0.000001012";
  usage.cost_details = { upstream_inference_cost: "0.000001012" };
  generation.native_tokens_reasoning = 0;
  generation.total_cost = "0.000001012";
 });
 expect(r.report.status).toBe("FAIL");
 for (const model of r.report.models) expect(model.calls[3]?.checks.high_reasoning_exercised).toBe("FAIL");
 expect(r.refusals).toBe(0);
});
it("pins the reasoning probe hold to its full combined bound at the dearer reasoning rate", async () => {
 const r = await fake();
 for (const model of r.report.models) {
  const body = r.requests.filter(b => b.model === model.model)[3];
  expect(body).toBeDefined();
  // Hand-derived fixture tariff: prompt .001 micro/token + output .003 + request 1.
  const bytes = Buffer.byteLength(JSON.stringify(body));
  expect(model.calls[3]?.holdMicros).toBe(Math.ceil(bytes * 0.001 + 2048 * 0.003 + 1));
 }
});
it("pins every zero-price probe hold to its original request bound, killing mutant F", async () => {
 const r = await fake();
 for (const model of r.report.models) {
  const body = r.requests.find(b => b.model === model.model);
  const bytes = Buffer.byteLength(JSON.stringify(body));
  const hold = Math.ceil(bytes * 0.001 + 2048 * 0.003 + 1);
  expect(model.priceCapProbes).toHaveLength(3);
  for (const probe of model.priceCapProbes ?? []) expect(probe.holdMicros).toBe(hold);
 }
});
it("counts a failed HTTP call's known excess debit and stops before the next model exceeds the cap", async () => {
 const r = await fake("faileddebit", "0.005");
 expect(r.report.status).toBe("FAIL");
 expect(r.report.chargedMicros).toBe(10_000);
 expect(r.report.models[0]?.calls[0]?.checks.response).toBe("FAIL");
 expect(r.report.models[1]?.checks.not_attempted).toBe("FAIL");
 expect(r.requests).toHaveLength(1);
});

// LIVE3: only the prompt/completions breakdown may accompany the aggregate.
it.each([
 ["0.00000101", "0.000001026"], // exact aggregate: $0.000002036
 ["0.00000101", "0.000002026"], // +1 micro-dollar rounding boundary
 ["0.00000001", "0.000001026"], // -1 micro-dollar rounding boundary
])("accepts a consistent inference breakdown (%s + %s) and runs each model's reasoning probe", async (prompt, completion) => {
 const r = await fake("pass", "0.50", undefined, models, usage => {
  Object.assign(usage.cost_details as object, { upstream_inference_prompt_cost: prompt, upstream_inference_completions_cost: completion });
 });
 expect(r.report.status).toBe("PASS"); expect(r.requests).toHaveLength(8);
 for (const model of r.report.models) {
  expect(model.reasoningProbe).toBe("PASS");
  expect(model.calls[3]?.checks.high_reasoning_exercised).toBe("PASS");
  for (const call of model.calls) {
   expect(call.checks.cost_details_covered).toBe("PASS");
   expect(call.usage?.cost_details.unrecognized_components).toEqual([]);
  }
 }
});
it.each([
 { upstream_inference_prompt_cost: "0.00000101", upstream_inference_completions_cost: "0.000002026000000001" },
 { upstream_inference_prompt_cost: "0.00000001", upstream_inference_completions_cost: "0.000001025999999999" },
 { upstream_inference_prompt_cost: "0.00000101" },
 { upstream_inference_completions_cost: "0.00000205" },
 { upstream_inference_prompt_cost: "-0.000001", upstream_inference_completions_cost: "0.000005083" },
 { upstream_inference_prompt_cost: null, upstream_inference_completions_cost: "0.000004083" },
 { upstream_inference_prompt_cost: "unreadable", upstream_inference_completions_cost: "0.000004083" },
])("refuses mismatched or unreadable inference breakdown %# without running reasoning probes", async details => {
 const r = await fake("pass", "0.50", undefined, models, usage => { Object.assign(usage.cost_details as object, details); });
 expect(r.report.status).toBe("FAIL"); expect(r.requests).toHaveLength(2); expect(r.refusals).toBe(0);
 expect(r.report.chargedMicros).toBe(6);
 for (const model of r.report.models) {
  expect(model.calls[0]?.checks.cost_details_covered).toBe("FAIL");
  expect(model.reasoningProbe).toBe("probe skipped: generation failed");
 }
});
it.each(["0", "0.0000001"])("refuses a third unknown breakdown component even at %s", async fee => {
 const r = await fake("pass", "0.50", undefined, models, usage => {
  Object.assign(usage.cost_details as object, { upstream_inference_prompt_cost: "0.00000101", upstream_inference_completions_cost: "0.00000205", third_component: fee });
 });
 expect(r.report.status).toBe("FAIL"); expect(r.requests).toHaveLength(2);
 for (const model of r.report.models) {
  expect(model.calls[0]?.checks.cost_details_covered).toBe("FAIL");
  expect(model.calls[0]?.usage?.cost_details.unrecognized_components).toEqual(["third_component"]);
 }
});
it("reports the skipped reasoning probe after a generation lookup failure while probing the next model", async () => {
 const r = await fake("generation");
 expect(r.report.status).toBe("FAIL"); expect(r.requests).toHaveLength(5);
 expect(r.report.models[0]?.reasoningProbe).toBe("probe skipped: generation failed");
 expect(r.report.models[1]?.reasoningProbe).toBe("PASS");
 expect(r.report.models[1]?.calls[3]?.checks.high_reasoning_exercised).toBe("PASS");
});

// LIVE4: removing GET-only retry, its bound or diagnostics must fail these fixtures.
it.each(["404", "missing", "empty", "null"])("recovers delayed generation %s without extra completions, holds or spend", async missing => {
 const baseline = await fake();
 const r = await fake("pass", "0.50", undefined, models, undefined, { lookup: (generation, attempt) => {
  if (attempt > 2) return Response.json({ data: generation });
  if (missing === "404") return new Response("not ready", { status: 404 });
  return Response.json(missing === "missing" ? {} : { data: missing === "empty" ? {} : null });
 } });
 expect(r.report.status).toBe("PASS"); expect(r.waits).toEqual([1000, 2000]);
 expect(r.generations).toBe(baseline.generations + 2);
 expect(r.requests).toEqual(baseline.requests); expect(r.refusals).toBe(baseline.refusals);
 expect(r.report.chargedMicros).toBe(baseline.report.chargedMicros);
 expect(r.report.preCallHoldsMicros).toBe(baseline.report.preCallHoldsMicros);
});
it("bounds unavailable generation at six tries over 30 seconds per model, retaining only each completion's debit and hold", async () => {
 const r = await fake("pass", "0.50", undefined, models, undefined, { lookup: () => Response.json({}, { status: 404 }) });
 expect(r.report.status).toBe("FAIL"); expect(r.generations).toBe(12);
 expect(r.waits).toEqual([1000, 2000, 4000, 8000, 15000, 1000, 2000, 4000, 8000, 15000]);
 expect(r.requests).toHaveLength(2); expect(r.report.chargedMicros).toBe(6);
 expect(r.report.preCallHoldsMicros).toBe(r.report.models.reduce((sum, m) => sum + m.calls[0]!.holdMicros, 0));
 for (const m of r.report.models) expect(m.calls[0]?.reasons.generation).toBe("not available after 6 tries over 30 s");
});
it.each([400, 401, 403, 429, 503])("fails generation HTTP %s immediately with a safe reason", async status => {
 const r = await fake("pass", "0.50", undefined, models, undefined, { lookup: () => new Response("canary-key-never-print", { status }) });
 expect(r.report.status).toBe("FAIL"); expect(r.waits).toEqual([]);
 expect(r.generations).toBe([401, 403].includes(status) ? 1 : 2);
 expect(r.report.models[0]?.calls[0]?.reasons.generation).toBe(`http ${status}`);
});
it.each(["bad-json", "null-body", "array-data", "string-data", "missing-field"])("fails malformed generation %s without retry or raw evidence", async mode => {
 const r = await fake("pass", "0.50", undefined, models, undefined, { lookup: generation => {
  if (mode === "bad-json") return new Response("canary-key-never-print");
  if (mode === "null-body") return Response.json(null);
  if (mode === "array-data") return Response.json({ data: [] });
  if (mode === "string-data") return Response.json({ data: "canary-key-never-print" });
  const partial = { ...generation }; delete partial.native_tokens_prompt;
  return Response.json({ data: partial });
 } });
 expect(r.report.status).toBe("FAIL"); expect(r.waits).toEqual([]); expect(r.generations).toBe(2);
 expect(r.report.models[0]?.calls[0]?.reasons.generation).toBe(mode === "missing-field" ? "missing field native_tokens_prompt" : "malformed body");
});
it.each([undefined, "bad-id", "gen-canary-key-never-print"])("records a malformed id safely before any generation fetch %#", async id => {
 const r = await fake("pass", "0.50", undefined, models, undefined, { id });
 expect(r.report.status).toBe("FAIL"); expect(r.generations).toBe(0); expect(r.waits).toEqual([]);
 expect(r.report.models[0]?.calls[0]?.reasons.generation).toBe("malformed id");
});
it("uses the same bounded generation lookup for an accepted price-cap probe without retrying its completion", async () => {
 const r = await fake("ignoredcaps", "0.50", undefined, models, undefined, { lookup: (generation, attempt) => attempt === 5 ? Response.json({}, { status: 404 }) : Response.json({ data: generation }) });
 expect(r.report.status).toBe("FAIL"); expect(r.requests).toHaveLength(14);
 expect(r.generations).toBe(15); expect(r.waits).toEqual([1000]); expect(r.report.chargedMicros).toBe(42);
 expect(r.report.models[0]?.priceCapProbes?.[0]?.reason).toContain("expected price-cap refusal");
});
it.each(["reasoning", "route", "mismatch", "overage", "fees", "details", "empty", "schema", "generation", "faileddebit"])("gives every failed check and probe a reason for %s", async mode => {
 const r = await fake(mode);
 for (const model of r.report.models) {
  for (const [name, value] of Object.entries(model.checks)) if (value === "FAIL") expect(model.reasons[name], name).toEqual(expect.any(String));
  for (const call of model.calls) for (const [name, value] of Object.entries(call.checks)) if (value === "FAIL") expect(call.reasons[name], name).toEqual(expect.any(String));
  for (const probe of model.priceCapProbes ?? []) if (probe.status === "FAIL") expect(probe.reason).toEqual(expect.any(String));
 }
});
it("records which bounded field and value failed without echoing provider text", async () => {
 const r = await fake("pass", "0.50", undefined, models, (usage, generation) => {
  generation.native_tokens_completion = 0;
  generation.native_tokens_reasoning = 1100;
  usage.completion_tokens_details = { reasoning_tokens: 1100 };
  generation.provider_name = "canary-key-never-print";
 });
 const reasons = r.report.models[0]?.calls[0]?.reasons;
 expect(reasons?.visible_generation).toContain("native_tokens_completion 0");
 expect(r.report.models[0]?.calls[0]?.reasoningOverCap).toEqual({ requestedMaxTokens: 1024, usageTokens: 1100, generationTokens: 1100 });
 expect(reasons?.identity_and_non_byok).toContain("generation.provider_name");
});
it.each([0, "0"])("deliberately accepts an exactly-zero breakdown part %s", async zero => {
 const r = await fake("pass", "0.50", undefined, models, usage => {
  Object.assign(usage.cost_details as object, { upstream_inference_prompt_cost: zero, upstream_inference_completions_cost: usage.cost });
 });
 expect(r.report.status).toBe("PASS");
});

it("retains a larger generation debit before refusing a missing field", async () => {
 const r = await fake("pass", "0.50", undefined, models, undefined, { lookup: generation => {
  const partial = { ...generation, total_cost: "0.1" }; delete (partial as Record<string, unknown>).native_tokens_prompt;
  return Response.json({ data: partial });
 } });
 expect(r.report.chargedMicros).toBe(200_000); expect(r.waits).toEqual([]);
 expect(r.report.models[0]?.calls[0]?.reasons.generation).toBe("missing field native_tokens_prompt");
});
it("bounds each price-cap probe's unavailable generation and continues the other probes", async () => {
 const r = await fake("ignoredcaps", "0.50", undefined, models, undefined, { lookup: (generation, attempt) => attempt >= 5 ? Response.json({ data: {} }) : Response.json({ data: generation }) });
 expect(r.report.status).toBe("FAIL"); expect(r.requests).toHaveLength(8);
 expect(r.generations).toBe(28); expect(r.report.chargedMicros).toBe(24);
 expect(r.report.models[0]?.priceCapProbes?.[0]?.reason).toBe("not available after 6 tries over 30 s");
});
it("names usage's output cap violation with its observed value", async () => {
 const r = await fake("pass", "0.50", undefined, models, usage => { usage.completion_tokens = 5000; });
 expect(r.report.models[0]?.calls[0]?.reasons.completion_plus_reasoning_within_limit).toContain("usage.completion_tokens 5000 > max 2048");
});

// LIVE5 numeric observation, $27 * .25/M + 165 * 2/M = $0.00033675.
// The saved report omitted generation.model; dated IDs are exercised separately below.
const live5Observation = {
 usage: { prompt_tokens: 27, completion_tokens: 165, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 128 }, cost: 0.00033675,
  cost_details: { upstream_inference_cost: 0.00033675, upstream_inference_prompt_cost: 6.75e-06, upstream_inference_completions_cost: 0.00033 } },
 generation: { native_tokens_prompt: 27, native_tokens_completion: 165, native_tokens_reasoning: 128, native_tokens_cached: 0, total_cost: 0.00033675, num_search_results: null, is_byok: false },
};
it("passes every check for the LIVE5 observation without double-billing inclusive reasoning or enabling search", async () => {
 const r = await fake("pass", "0.50", savedCatalogue.data, relaxedModels, (usage, generation, body) => {
  if (body.model !== relaxedModels[0]) return;
  Object.assign(usage, structuredClone(live5Observation.usage));
  Object.assign(generation, live5Observation.generation);
 });
 expect(r.report.status).toBe("PASS"); expect(r.requests).toHaveLength(8);
 for (const model of r.report.models) for (const call of model.calls) expect(Object.values(call.checks).every(value => value === "PASS")).toBe(true);
 expect(r.report.models[0]?.reasoningProbe).toBe("PASS");
});
it("bounds both output interpretations and uses the cached-input rate as-is", async () => {
 const entries = models.map(id => catalogueEntry(id, { ...pricing, input_cache_read: "0.0000000005" }));
 const r = await fake("pass", "0.50", entries, models, (usage, generation) => {
  // Upper bound: 6 * 1e-9 + 4 * .5e-9 + (513 + 171) * 2e-9 + 1e-6.
  usage.prompt_tokens_details = { cached_tokens: 4, cache_write_tokens: 0 };
  usage.cost = "0.000002376"; usage.cost_details = { upstream_inference_cost: usage.cost };
  generation.native_tokens_cached = 4; generation.total_cost = usage.cost;
 });
 expect(r.report.status).toBe("PASS");
});
it.each(["native-cap", "usage-cap"])("refuses output above the sent cap: %s", async mode => {
 const r = await fake("pass", "0.50", savedCatalogue.data, relaxedModels, (usage, generation) => {
  if (mode === "native-cap") generation.native_tokens_completion = 4097;
  if (mode === "usage-cap") usage.completion_tokens = 4097;
 });
 expect(r.report.status).toBe("FAIL");
 for (const model of r.report.models) expect(model.calls[0]?.checks.completion_plus_reasoning_within_limit).toBe("FAIL");
});
it("accepts inclusive completion at the sent cap even when it contains reasoning", async () => {
 const r = await fake("pass", "0.50", savedCatalogue.data, relaxedModels, (usage, generation, body) => {
  if (body.model !== relaxedModels[0]) return;
  const output = Number(body.max_tokens);
  const cost = output === 1024 ? "0.0020505" : "0.0010265";
  usage.completion_tokens = output; generation.native_tokens_completion = output;
  usage.cost = cost; usage.cost_details = { upstream_inference_cost: cost }; generation.total_cost = cost;
 });
 expect(r.report.status).toBe("PASS");
});
it.each([null, 0, "0"])("accepts num_search_results %s only on the search-free request", async results => {
 const r = await fake("pass", "0.50", undefined, models, (_usage, generation) => { generation.num_search_results = results; });
 expect(r.report.status).toBe("PASS");
});
it.each([1, "1", "unreadable", {}, false])("refuses positive or unreadable num_search_results %# in every auxiliary check", async results => {
 const r = await fake("pass", "0.50", undefined, models, (_usage, generation) => { generation.num_search_results = results; });
 expect(r.report.status).toBe("FAIL");
 for (const model of r.report.models) for (const check of ["cost_details_covered", "no_reported_auxiliary_charge", "no_web_search_cost"]) expect(model.calls[0]?.checks[check]).toBe("FAIL");
});
it.each(relaxedModels)("accepts only the pinned dated generation variant for %s and records its model", async model => {
 const r = await fake("pass", "0.50", savedCatalogue.data, relaxedModels, (_usage, generation, body) => {
  if (body.model === model) generation.model = `${model}-2025-08-07`;
 });
 expect(r.report.status).toBe("PASS");
 for (const call of r.report.models.find(result => result.model === model)?.calls ?? []) expect(call.generation?.model).toBe(`${model}-2025-08-07`);
});
it("records the exact generation model safely", async () => {
 const r = await fake(); expect(r.report.status).toBe("PASS");
 expect(r.report.models[0]?.calls[0]?.generation?.model).toBe(models[0]);
});
it.each(["openai/gpt-5-nano", "other/gpt-5-mini-2025-08-07", "openai/gpt-5-mini-preview", "openai/gpt-5-mini-2025-8-7", "openai/gpt-5-mini-2025-08-07-extra", "vendor/model-b-2025-08-07"])("refuses an unpinned generation model %s", async actual => {
 const ids = actual.startsWith("vendor/") ? models : relaxedModels;
 const r = await fake("pass", "0.50", ids === models ? undefined : savedCatalogue.data, ids, (_usage, generation) => { generation.model = actual; });
 expect(r.report.status).toBe("FAIL"); expect(r.report.models[0]?.calls[0]?.checks.identity_and_non_byok).toBe("FAIL");
});
it("refuses BYOK even with a pinned dated model", async () => {
 const r = await fake("pass", "0.50", savedCatalogue.data, relaxedModels, (_usage, generation, body) => { generation.model = `${String(body.model)}-2025-08-07`; generation.is_byok = true; });
 expect(r.report.status).toBe("FAIL");
 for (const model of r.report.models) expect(model.calls[0]?.checks.identity_and_non_byok).toBe("FAIL");
});
it.each(["openai/gpt-5-mini-2025-08-07", "openai/gpt-5-nano", "other/gpt-5-mini-2025-08-07", "openai/gpt-5-mini-preview"])("checks the answer model against the same pinned identity rule: %s", async answerModel => {
 const r = await fake("pass", "0.50", savedCatalogue.data, relaxedModels, undefined, { answerModel });
 expect(r.report.models[0]?.calls[0]?.checks.identity_and_non_byok).toBe(answerModel === "openai/gpt-5-mini-2025-08-07" ? "PASS" : "FAIL");
});
it.each(["canary-key-never-print", "prefix-canary-key-never-print/suffix", "x".repeat(129), "arbitrary upstream text", null, 5])("redacts unsafe generation model evidence %#", async actual => {
 const r = await fake("pass", "0.50", undefined, models, (_usage, generation) => { generation.model = actual; });
 expect(r.report.status).toBe("FAIL");
 expect(r.report.models[0]?.calls[0]?.generation?.model).toBe("[invalid]");
 if (typeof actual === "string") expect(JSON.stringify(r.report)).not.toContain(actual);
});

// LIVE6: fixtures catch exact-cost equality, null-engine refusal and reasoning/subtotal assumptions.
const liveObservations = JSON.parse(readFileSync(new URL("../fixtures/model-gateway-prices/openrouter-live5-live6.json", import.meta.url), "utf8")) as { observations: { run: number; model: string; usage: Record<string, unknown>; generation: Record<string, unknown> }[] };
it.each(liveObservations.observations)("LIVE6 qualifies run $run $model observations", async observation => {
 const r = await fake("pass", "0.50", savedCatalogue.data, relaxedModels, (usage, generation, body) => {
  if (body.model === observation.model) { Object.assign(usage, structuredClone(observation.usage)); Object.assign(generation, structuredClone(observation.generation)); }
 });
 expect(r.report.status).toBe("PASS"); expect(r.requests).toHaveLength(8);
 for (const model of r.report.models) for (const call of model.calls) expect(Object.values(call.checks).every(check => check === "PASS")).toBe(true);
});
it.each([
 { cost: "0", pass: false }, { cost: "0.00029475", pass: true },
 { cost: "0.000294750000000001", pass: false }, { cost: "0.1", pass: false },
])("LIVE6 bounds positive reported cost $cost inclusively", async ({ cost, pass }) => {
 const observation = liveObservations.observations[2]!;
 const r = await fake("pass", "0.50", savedCatalogue.data, relaxedModels, (usage, generation, body) => {
  if (body.model !== observation.model) return;
  Object.assign(usage, structuredClone(observation.usage), { cost, cost_details: { upstream_inference_cost: cost } });
  Object.assign(generation, observation.generation, { total_cost: cost });
 });
 expect(r.report.status).toBe(pass ? "PASS" : "FAIL");
 expect(r.report.models[0]?.calls[0]?.checks.bounded_inference_cost).toBe(pass ? "PASS" : "FAIL");
});
it("LIVE6 refuses reported cost above hold even below computed maximum", async () => {
 const r = await fake("pass", "0.50", savedCatalogue.data, relaxedModels, (usage, generation) => {
  usage.completion_tokens_details = { reasoning_tokens: 100000 }; generation.native_tokens_reasoning = 100000;
  usage.cost = "0.02"; usage.cost_details = { upstream_inference_cost: "0.02" }; generation.total_cost = "0.02";
 });
 expect(r.report.status).toBe("FAIL");
 expect(r.report.models[0]?.calls[0]?.checks.bounded_inference_cost).toBe("PASS");
 expect(r.report.models[0]?.calls[0]?.checks.usage_cost_within_hold).toBe("FAIL");
});
it.each(["usage", "upstream", "generation"])("LIVE6 refuses unequal %s cost", async field => {
 const r = await fake("pass", "0.50", savedCatalogue.data, relaxedModels, (usage, generation) => {
  if (field === "usage") usage.cost = "0.001";
  if (field === "upstream") (usage.cost_details as Record<string, unknown>).upstream_inference_cost = "0.001";
  if (field === "generation") generation.total_cost = "0.001";
 });
 expect(r.report.status).toBe("FAIL"); expect(r.report.models[0]?.calls[0]?.checks.bounded_inference_cost).toBe("FAIL");
});
it("LIVE6 accepts inconsistent readable token counters within their caps", async () => {
 const r = await fake("pass", "0.50", undefined, models, (usage, generation) => {
  usage.prompt_tokens = 11; usage.completion_tokens = 514;
  usage.completion_tokens_details = { reasoning_tokens: 1200 }; generation.native_tokens_reasoning = 1201;
 });
 expect(r.report.status).toBe("PASS");
});
it.each(["native", "usage"])("LIVE6 refuses malformed %s token evidence", async field => {
 const r = await fake("pass", "0.50", undefined, models, (usage, generation) => {
  if (field === "native") generation.native_tokens_reasoning = -1;
  else usage.prompt_tokens_details = { cached_tokens: 11 };
 });
 expect(r.report.status).toBe("FAIL"); expect(r.report.models[0]?.calls[0]?.checks.bounded_inference_cost).toBe("FAIL");
});
it("LIVE6 records and logs reasoning above the requested cap while charging real cost", async () => {
 const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
 try {
  const r = await fake("pass", "0.50", savedCatalogue.data, relaxedModels, (usage, generation) => {
   usage.completion_tokens_details = { reasoning_tokens: 1200 }; generation.native_tokens_reasoning = 1201;
  });
  expect(r.report.status).toBe("PASS"); expect(r.report.chargedMicros).toBe(4940);
  for (const model of r.report.models) for (const call of model.calls) expect(call.reasoningOverCap).toEqual({ requestedMaxTokens: 1024, usageTokens: 1200, generationTokens: 1201 });
  expect(log.mock.calls.map(args => args[0]).join("")).toContain("reasoning above requested cap 1024: usage 1200, generation 1201");
 } finally { log.mockRestore(); }
});
it.each([null, "google", 0, {}, false])("LIVE6 accepts only a null engine on a search-free request %#", async engine => {
 const r = await fake("pass", "0.50", undefined, models, (_usage, generation) => { generation.web_search_engine = engine; });
 expect(r.report.status).toBe(engine === null ? "PASS" : "FAIL");
});
it("LIVE6 refuses null search evidence when search was requested", async () => {
 const { noAuxiliaryEvidence } = await import(script) as { noAuxiliaryEvidence: (value: unknown, path: string, searchNotRequested: boolean) => boolean };
 for (const field of ["num_search_results", "web_search_engine"]) {
  expect(noAuxiliaryEvidence({ [field]: null }, "generation", false)).toBe(false);
  expect(noAuxiliaryEvidence({ [field]: null }, "generation", true)).toBe(true);
 }
});

// RUN8: exact live wording; the successful control and one-component differential still apply.
it.each([refusalMessage, `  ${refusalMessage}. \n`, refusalMessage.toUpperCase()])("accepts the run-8 differential 404 refusal: %s", async message => {
 const r = await fake("pass", "0.50", savedCatalogue.data, relaxedModels, undefined, { probe: () => Response.json({ error: { code: 404, message } }, { status: 404 }) });
 expect(r.report.status).toBe("PASS"); expect(r.probeRequests).toHaveLength(4);
 for (const model of r.report.models) {
  expect(model.calls).toHaveLength(4); expect(model.priceCapProbes).toHaveLength(2);
  const control = r.requests.find(b => b.model === model.model)!;
  for (const probe of model.priceCapProbes ?? []) {
   expect(probe).toMatchObject({ status: "PASS", httpStatus: 404, chargedMicros: 0, error: { code: "404", message: message.replace(/[\p{Cc}\p{Cf}]/gu, " ") } });
   expect(probe.reason).toEqual(expect.any(String));
   const sent = r.probeRequests.find(b => b.model === model.model && (b.provider as { max_price: Record<string, number> }).max_price[probe.component] === 0)!;
   const restored = structuredClone(sent);
   (restored.provider as { max_price: Record<string, number> }).max_price[probe.component] = (control.provider as { max_price: Record<string, number> }).max_price[probe.component]!;
   expect(restored).toEqual(control);
  }
 }
});
it.each([
 [400, {}, refusalMessage, true],
 [422, {}, refusalMessage, true],
 [404, { usage: { cost: "0.000001" } }, refusalMessage, false],
 [404, { usage: { cost: "0" } }, refusalMessage, false],
 [404, { usage: { cost_details: { upstream_inference_cost: "0.000001" } } }, refusalMessage, false],
 [200, {}, refusalMessage, false],
 [404, { id: "gen-probe" }, refusalMessage, false],
 [404, { usage: {} }, refusalMessage, false],
 [404, { usage: null }, refusalMessage, false],
 [404, { id: null }, refusalMessage, false],
 [404, {}, "model not found", false],
 [503, {}, refusalMessage, false],
] as const)("requires status, zero debit, absent id/usage and matching message %#", async (status, extra, message, pass) => {
 const r = await fake("pass", "0.50", savedCatalogue.data, relaxedModels, undefined, { probe: () => Response.json({ error: { message }, ...extra }, { status }) });
 expect(r.report.status).toBe(pass ? "PASS" : "FAIL"); expect(r.probeRequests).toHaveLength(4);
 for (const model of r.report.models) {
  expect(model.checks.provider_honoured_max_price).toBe(pass ? "PASS" : "FAIL");
  expect(model.priceCapProbes).toHaveLength(2);
  for (const probe of model.priceCapProbes ?? []) { expect(probe.status).toBe(pass ? "PASS" : "FAIL"); expect(probe.reason).toEqual(expect.any(String)); }
 }
 if ("usage" in extra && extra.usage && "cost" in extra.usage) expect(r.report.chargedMicros).toBeGreaterThanOrEqual(4);
});
it("continues after the first failed component and never turns a partial pass into qualification", async () => {
 const r = await fake("pass", "0.50", savedCatalogue.data, relaxedModels, undefined, { probe: (_body, attempt) => Response.json({ error: { message: attempt % 2 ? "model not found" : refusalMessage } }, { status: 404 }) });
 expect(r.probeRequests).toHaveLength(4); expect(r.report.status).toBe("FAIL");
 for (const model of r.report.models) expect(model.priceCapProbes?.map(p => [p.component, p.status])).toEqual([["prompt", "FAIL"], ["completion", "PASS"]]);
});
it("runs no refusal probes without a successful same-run control for that model", async () => {
 const r = await fake("generation", "0.50", savedCatalogue.data, relaxedModels, undefined, { probe: () => Response.json({ error: { message: refusalMessage } }, { status: 404 }) });
 expect(r.report.models[0]?.priceCapProbes).toBeUndefined();
 expect(r.probeRequests.every(b => b.model === relaxedModels[1])).toBe(true);
 expect(r.report.models[0]?.status).toBe("FAIL"); expect(r.report.models[1]?.status).toBe("PASS");
});
it.each(["code", "message"] as const)("bounds and safely prints refusal error.%s", async field => {
 const value = "No endpoints found\n\u001b[31m\u202e" + "x".repeat(350);
 const r = await fake("pass", "0.50", savedCatalogue.data, relaxedModels, undefined, { probe: () => Response.json({ error: { code: "404", message: "No endpoints found", [field]: value } }, { status: 404 }) });
 const diagnostic = r.report.models[0]?.priceCapProbes?.[0]?.error?.[field];
 expect(diagnostic).toBe(value.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 300));
 expect(diagnostic).toHaveLength(300);
});
it.each(["canary-key-never-print", "canary-key-never-print".slice(3, 19)])("redacts echoed credentials in both refusal diagnostics %#", async echo => {
 const r = await fake("pass", "0.50", savedCatalogue.data, relaxedModels, undefined, { probe: () => Response.json({ error: { code: echo, message: `No endpoints found ${echo}` } }, { status: 404 }) });
 expect(r.report.models[0]?.priceCapProbes?.[0]?.error).toEqual({ code: "[redacted]", message: "[redacted]" });
 expect(JSON.stringify(r.report)).not.toContain(echo);
});
it("records HTTP status even when refusal JSON is malformed, and still tries every component", async () => {
 const r = await fake("pass", "0.50", savedCatalogue.data, relaxedModels, undefined, { probe: () => new Response("invalid JSON", { status: 404 }) });
 expect(r.probeRequests).toHaveLength(4); expect(r.report.status).toBe("FAIL");
 for (const model of r.report.models) for (const probe of model.priceCapProbes ?? []) expect(probe.httpStatus).toBe(404);
});

it("preserves the shared authentication stop during refusal probes", async () => {
 const r = await fake("pass", "0.50", savedCatalogue.data, relaxedModels, undefined, { probe: () => Response.json({ error: { code: 401, message: "No endpoints found" } }, { status: 401 }) });
 expect(r.report.status).toBe("FAIL"); expect(r.probeRequests).toHaveLength(1);
 expect(r.report.models[1]?.checks.not_attempted).toBe("FAIL");
});
it("retains a failed probe's debit and stops further calls at the shared spend cap", async () => {
 const r = await fake("pass", "0.50", savedCatalogue.data, relaxedModels, undefined, { probe: () => Response.json({ error: { message: refusalMessage }, usage: { cost: "1" } }, { status: 404 }) });
 expect(r.report.status).toBe("FAIL"); expect(r.report.chargedMicros).toBeGreaterThanOrEqual(1_000_000);
 expect(r.probeRequests).toHaveLength(1); expect(r.report.models[1]?.checks.not_attempted).toBe("FAIL");
});

it.each([
 "No endpoints found matching your data policy",
 "No endpoints found", "No eligible providers", "No allowed providers", "No providers available",
 "No matching endpoints within max_price limits",
 `prefix ${refusalMessage}`, `${refusalMessage} suffix`, `${refusalMessage}..`,
 refusalMessage.replace("max price", "max_price"), refusalMessage.replace("max price", "max  price"),
 `${refusalMessage}\nextra`,
])("refuses wording outside the run-8 price-cap message: %s", async message => {
 const r = await fake("pass", "0.50", savedCatalogue.data, relaxedModels, undefined, { probe: () => Response.json({ error: { code: "404", message } }, { status: 404 }) });
 expect(r.report.status).toBe("FAIL"); expect(r.probeRequests).toHaveLength(4);
 for (const model of r.report.models) {
  expect(model.checks.provider_honoured_max_price).toBe("FAIL");
  expect(model.priceCapProbes?.every(p => p.status === "FAIL")).toBe(true);
 }
});
