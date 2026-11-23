import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const script = new URL("../../scripts/openrouter-qualify.mjs", import.meta.url).href;
type Row = { model: string; route: string; status: string; pricing: Record<string, string> };
type Call = { holdMicros: number; checks: Record<string, string> };
type Provider = { route: string; status: string; reasons: Record<string, string>; calls: Call[]; candidateTariff?: Row; priceCapProbes?: { holdMicros: number; status: string; reason: string }[] };
type Result = { model: string; status: string; reason: string; resumed?: boolean; providers: Provider[] };
type Report = { status: string; harnessVersion: string; models: Result[]; chargedMicros: number; preCallHoldsMicros: number; exposureMicros: number; notReached: string[]; failuresByCause: Record<string, number>; proposedTariffRows: Row[]; errors: string[] };
const { qualify } = await import(script) as { qualify: (options: Record<string, unknown>) => Promise<Report>; main: (argv: string[], env?: Record<string, string>) => Promise<number> };
const key = "all-models-fixture-key-never-print";
const pricing = { prompt: "0.000000001", completion: "0.000000002", internal_reasoning: "0.000000003", request: "0.000001", input_cache_read: "0", input_cache_write: "0" };
const entry = (id: string, overrides = {}) => ({ id, pricing: { ...pricing }, supported_parameters: ["tools", "tool_choice", "max_tokens", "reasoning"], top_provider: { max_completion_tokens: 4096 }, ...overrides });
const endpoint = (tag = "fixture-provider", overrides = {}) => ({ tag, provider_name: tag, pricing: { ...pricing }, supported_parameters: ["tools", "tool_choice", "max_tokens", "reasoning"], max_completion_tokens: 4096, ...overrides });
function server(entries = [entry("vendor/a"), entry("vendor/b")], endpoints = [endpoint()], mode = "pass") {
 const paid: { model: string; provider: { only: string[]; max_price: Record<string, number> } }[] = [];
 const lookups: string[] = []; let generation: Record<string, unknown> = {};
 const fetcher: typeof fetch = async (url, init) => {
  const req = new Request(url, init); const path = new URL(req.url).pathname;
  expect(req.headers.get("Authorization")).toBe(`Bearer ${key}`);
  expect(init?.redirect).toBe("error");
  if (path === "/api/v1/models") return Response.json({ data: entries });
  if (path.endsWith("/endpoints")) { lookups.push(path); return Response.json({ data: { endpoints } }); }
  if (req.method === "POST") {
   const body = await req.json() as typeof paid[number]; paid.push(body);
   const caps = body.provider.max_price;
   if (mode === "unreadable-probe" && Object.values(caps).some(v => v === 0)) return new Response("invalid", { status: 404 });
   if (Object.values(caps).some(v => v === 0)) return Response.json({ error: { code: "404", message: mode === "refusal" ? "No endpoints found" : "No endpoints found that satisfy the max price for this request." } }, { status: 404 });
   if (mode === "auth") return Response.json({ error: {} }, { status: 401 });
   if (mode === "unknown") return new Response("invalid");
   const cost = mode === "overage" ? "1" : mode === "overage-small" ? "0.06" : "0.000002036";
   generation = { model: mode === "identity" ? "vendor/wrong" : body.model, provider_name: mode === "first-provider-fails" && body.provider.only[0] === "fixture-provider" ? "wrong" : body.provider.only[0], native_tokens_prompt: 10, native_tokens_completion: 513, native_tokens_reasoning: 171, native_tokens_cached: 0, total_cost: cost, is_byok: false };
   return Response.json({ id: `gen-${paid.length}`, model: body.model, choices: [{ message: { content: "Four" } }], usage: { prompt_tokens: 10, completion_tokens: 513, completion_tokens_details: { reasoning_tokens: 171 }, cost, cost_details: { upstream_inference_cost: cost } } });
  }
  if (mode === "generation") return new Response("", { status: 503 });
  return Response.json({ data: generation });
 };
 return { fetcher, paid, lookups };
}
async function run(options: Record<string, unknown> = {}, fixture = server()) {
 const report = await qualify({ allModels: true, spendCap: "15.00", ...options, fetch: fixture.fetcher, env: { OPENROUTER_API_KEY: key }, now: () => 1000, sleep: async () => {} });
 expect(JSON.stringify(report)).not.toContain(key);
 return { report, ...fixture };
}
it("skips a previously PASSed model even when one of its providers failed", async () => {
 const first = await run({}, server(undefined, [endpoint(), endpoint("second-provider")], "first-provider-fails"));
 expect(first.report.models.every(m => m.status === "PASS")).toBe(true);
 const r = await run({ resumeReport: first.report }, server(undefined, [endpoint(), endpoint("second-provider")]));
 expect(r.paid).toHaveLength(0); expect(r.report.models.every(m => m.resumed)).toBe(true);
 expect(r.report.models[0]?.providers).toHaveLength(2);
});
it("invalidates a resume when the pinned provider identity changes", async () => {
 const first = await run();
 const r = await run({ resumeReport: first.report }, server(undefined, [endpoint("fixture-provider", { provider_name: "new-identity" })]));
 expect(r.paid.length).toBeGreaterThan(0); expect(r.report.models.some(m => m.resumed)).toBe(false);
});
it("never carries an extra unqualified row from a resume report", async () => {
 const first = await run(); first.report.proposedTariffRows.push({ ...first.report.proposedTariffRows[0]!, route: "unqualified" });
 const r = await run({ resumeReport: first.report });
 expect(r.report.proposedTariffRows.some(row => row.route === "unqualified")).toBe(false);
});
it("records models whose first hold cannot fit the default per-model cap", async () => {
 const r = await run({}, server([entry("vendor/a", { pricing: { ...pricing, completion: "0.01" } })], [endpoint("fixture-provider", { pricing: { ...pricing, completion: "0.01" } })]));
 expect(r.paid).toHaveLength(0); expect(r.report.notReached).toEqual(["vendor/a"]);
 expect(r.report.failuresByCause.per_model_cap).toBe(1);
});
it("excludes explicitly estimated endpoint tariffs without paid calls", async () => {
 const r = await run({}, server([entry("vendor/a")], [endpoint("fixture-provider", { is_estimated: true })]));
 expect(r.paid).toHaveLength(0); expect(r.report.failuresByCause.unpriced_component).toBe(1);
});
it("retains an unknown call hold across providers before hitting the model cap", async () => {
 const r = await run({ perModelCap: "0.000006" }, server(undefined, [endpoint(), endpoint("second-provider")], "unknown"));
 expect(r.paid).toHaveLength(2); expect(r.report.preCallHoldsMicros).toBeGreaterThan(6);
 expect(r.report.failuresByCause.per_model_cap).toBe(2);
});
it("preserves run-8 identity and refusal details in each failed model reason", async () => {
 const r = await run({}, server(undefined, undefined, "identity"));
 expect(r.report.models.every(m => m.reason.includes("generation.model expected requested model"))).toBe(true);
});

it("groups a debit above the model cap while continuing under the overall cap", async () => {
 const r = await run({ perModelCap: "0.05" }, server(undefined, undefined, "overage-small"));
 expect(r.paid).toHaveLength(2); expect(r.report.chargedMicros).toBe(120000);
 expect(r.report.failuresByCause.per_model_cap).toBe(2);
});
it("lists the current model as unreached when provider discovery hits shared auth failure", async () => {
 const fixture = server(); const base = fixture.fetcher;
 fixture.fetcher = async (url, init) => new URL(new Request(url, init).url).pathname.endsWith("/endpoints") ? new Response("", { status: 401 }) : base(url, init);
 const r = await run({}, fixture);
 expect(r.paid).toHaveLength(0); expect(r.report.notReached).toEqual(["vendor/a", "vendor/b"]);
});

it("retains a generation-lookup failure hold before another provider can spend", async () => {
 const r = await run({ perModelCap: "0.000006" }, server([entry("vendor/a")], [endpoint(), endpoint("second-provider")], "generation"));
 expect(r.paid).toHaveLength(1);
 expect(r.paid[0]?.provider.only).toEqual(["fixture-provider"]);
 const first = r.report.models[0]!.providers[0]!;
 expect(first.calls[0]?.checks.generation).toBe("FAIL");
 expect(r.report.exposureMicros).toBe(first.calls[0]!.holdMicros);
 expect(r.report.exposureMicros).toBe(r.report.preCallHoldsMicros);
 expect(r.report.models[0]!.providers[1]!.calls).toEqual([]);
 expect(r.report.failuresByCause.per_model_cap).toBe(1);
});
it("retains every unreadable price-cap probe hold in exposure", async () => {
 const r = await run({}, server([entry("vendor/a")], [endpoint()], "unreadable-probe"));
 const provider = r.report.models[0]!.providers[0]!;
 expect(provider.calls).toHaveLength(4);
 expect(provider.calls.every(call => Object.values(call.checks).every(check => check === "PASS"))).toBe(true);
 expect(provider.priceCapProbes).toHaveLength(3);
 expect(provider.priceCapProbes!.every(probe => probe.status === "FAIL" && probe.reason === "HTTP evidence unavailable")).toBe(true);
 expect(r.paid).toHaveLength(7);
 const holds = [...provider.calls, ...provider.priceCapProbes!].reduce((sum, call) => sum + call.holdMicros, 0);
 expect(r.report.preCallHoldsMicros).toBe(holds);
 expect(r.report.exposureMicros).toBe(holds);
 expect(r.report.proposedTariffRows).toEqual([]);
});
it.each([0, 1])("requalifies a resume whose candidate row price alone was edited at index %s", async index => {
 const first = await run();
 const row = first.report.proposedTariffRows[index]!;
 row.pricing = { ...row.pricing, completion: "0.000000001" };
 expect(first.report.models[index]!.providers[0]!.candidateTariff!.pricing.completion).toBe(pricing.completion);
 const r = await run({ resumeReport: first.report });
 expect(r.paid).toHaveLength(7);
 expect(r.report.models[index]?.resumed).not.toBe(true);
 expect(r.report.models[1 - index]?.resumed).toBe(true);
 expect(r.report.proposedTariffRows.find(candidate => candidate.model === row.model)!.pricing.completion).toBe(pricing.completion);
 expect(r.report.proposedTariffRows).not.toContainEqual(row);
});
it.each(["REVIEWED", undefined])("requalifies a resume whose candidate label is %s", async status => {
 const first = await run();
 if (status === undefined) Reflect.deleteProperty(first.report.proposedTariffRows[0]!, "status");
 else first.report.proposedTariffRows[0]!.status = status;
 const r = await run({ resumeReport: first.report });
 expect(r.paid).toHaveLength(7);
 expect(r.report.models[0]?.resumed).not.toBe(true);
 expect(r.report.models[1]?.resumed).toBe(true);
 expect(r.report.proposedTariffRows.every(row => row.status === "CANDIDATE")).toBe(true);
});
it.each(["three calls", "empty checks", "failed check"])("requalifies a PASS resume with %s", async change => {
 const first = await run();
 const calls = first.report.models[0]!.providers[0]!.calls;
 if (change === "three calls") calls.pop();
 if (change === "empty checks") calls[0]!.checks = {};
 if (change === "failed check") calls[0]!.checks.visible_text = "FAIL";
 const r = await run({ resumeReport: first.report });
 expect(r.paid).toHaveLength(7);
 expect(r.report.models[0]?.resumed).not.toBe(true);
 expect(r.report.models[1]?.resumed).toBe(true);
 const fresh = r.report.models[0]!.providers[0]!.calls;
 expect(fresh).toHaveLength(4);
 expect(fresh.every(call => Object.keys(call.checks).length > 0 && Object.values(call.checks).every(check => check === "PASS"))).toBe(true);
});
it("binds the resume version to the harness, policy and token validation module", async () => {
 const r = await run();
 const hash = createHash("sha256");
 for (const path of ["../../scripts/openrouter-qualify.mjs", "../../packages/model-gateway/dist/openrouter-policy.js", "../../packages/model-gateway/dist/model-gateway-token.js"]) hash.update(readFileSync(new URL(path, import.meta.url)));
 expect(r.report.harnessVersion).toBe(hash.digest("hex"));
});
it.each([0, 1])("lists all unreached models when broken resume provider evidence stops at index %s", async index => {
 const entries = [entry("vendor/a"), entry("vendor/b"), entry("vendor/c")];
 const first = await run({}, server(entries));
 Reflect.set(first.report.models[index]!, "providers", [null]);
 const r = await run({ resumeReport: first.report }, server(entries));
 expect(r.report.status).toBe("FAIL");
 expect(r.report.errors).toHaveLength(1);
 expect(r.paid).toHaveLength(0);
 expect(r.report.notReached).toEqual(entries.slice(index).map(model => model.id));
 expect(r.lookups).toHaveLength(index + 1);
 expect(r.report.proposedTariffRows.map(row => row.model)).toEqual(entries.slice(0, index).map(model => model.id));
});
