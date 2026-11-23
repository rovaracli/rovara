import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
const script = new URL("../../scripts/openrouter-qualify.mjs", import.meta.url).href;
type Row = { model: string; route: string; status: string; pricing: Record<string, string> };
type Result = { model: string; status: string; reason: string; resumed?: boolean; providers: { status: string; reasons: Record<string, string> }[] };
type Report = { status: string; harnessVersion: string; models: Result[]; chargedMicros: number; preCallHoldsMicros: number; exposureMicros: number; notReached: string[]; failuresByCause: Record<string, number>; proposedTariffRows: Row[]; errors: string[] };
const { qualify, main } = await import(script) as { qualify: (options: Record<string, unknown>) => Promise<Report>; main: (argv: string[], env?: Record<string, string>) => Promise<number> };
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
   if (Object.values(caps).some(v => v === 0)) return Response.json({ error: { code: "404", message: mode === "refusal" ? "No endpoints found" : "No endpoints found that satisfy the max price for this request." } }, { status: 404 });
   if (mode === "auth") return Response.json({ error: {} }, { status: 401 });
   if (mode === "unknown") return new Response("invalid");
   const cost = mode === "overage" ? "1" : "0.000002036";
   generation = { model: mode === "identity" ? "vendor/wrong" : body.model, provider_name: body.provider.only[0], native_tokens_prompt: 10, native_tokens_completion: 513, native_tokens_reasoning: 171, native_tokens_cached: 0, total_cost: cost, is_byok: false };
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
it("qualifies every model provider-by-provider and emits only labelled PASS candidates", async () => {
 const r = await run({}, server(undefined, [endpoint(), endpoint("second-provider")]));
 expect(r.report.status).toBe("PASS"); expect(r.report.models).toHaveLength(2); expect(r.paid).toHaveLength(28);
 expect(r.report.proposedTariffRows).toHaveLength(4);
 expect(r.report.models.every(m => m.status === "PASS" && m.providers.length === 2 && m.reason)).toBe(true);
 expect(r.report.proposedTariffRows.every(row => row.status === "CANDIDATE")).toBe(true);
 expect(r.report.exposureMicros).toBe(r.report.preCallHoldsMicros);
});
it("filters missing tools, missing or estimated prices and unsafe auxiliary components before paid calls", async () => {
 const r = await run({}, server([
  entry("vendor/no-tools", { supported_parameters: [] }),
  entry("vendor/unpriced", { pricing: { ...pricing, internal_reasoning: null } }),
  entry("vendor/estimated", { pricing: { ...pricing, estimated: true } }),
  entry("vendor/fee", { pricing: { ...pricing, unknown_fee: "0.1" } }),
  entry("vendor/good"),
 ]));
 expect(r.paid).toHaveLength(7); expect(r.report.models.map(m => m.status)).toEqual(["FAIL", "FAIL", "FAIL", "FAIL", "PASS"]);
 expect(r.report.failuresByCause).toMatchObject({ no_tools_support: 1, unpriced_component: 3 });
 expect(r.report.proposedTariffRows.map(row => row.model)).toEqual(["vendor/good"]);
});
it.each([
 [endpoint("bad", { supported_parameters: [] }), "no_tools_support"],
 [endpoint("bad", { pricing: { ...pricing, input_cache_write: null } }), "unpriced_component"],
 [endpoint("bad", { tag: undefined }), "provider_routing"],
])("rejects unusable endpoints with a cause", async (ep, cause) => {
 const r = await run({}, server([entry("vendor/a")], [ep]));
 expect(r.paid).toHaveLength(0); expect(r.report.models[0]?.status).toBe("FAIL"); expect(r.report.failuresByCause[cause]).toBe(1);
});
it("reserves the overall cap before every call and lists unreached models", async () => {
 const r = await run({ spendCap: "0.000012", perModelCap: "1" }, server([entry("vendor/a"), entry("vendor/b"), entry("vendor/c")]));
 expect(r.paid).toHaveLength(1); expect(r.report.exposureMicros).toBeLessThanOrEqual(12);
 expect(r.report.notReached).toEqual(["vendor/b", "vendor/c"]);
 expect(r.report.failuresByCause.overall_cap).toBe(3); expect(r.report.proposedTariffRows).toEqual([]);
});
it("enforces the per-model cap across providers and continues with the next model", async () => {
 const r = await run({ perModelCap: "0.000044" }, server(undefined, [endpoint(), endpoint("second-provider")]));
 expect(r.paid.filter(p => p.model === "vendor/a")).toHaveLength(5);
 expect(r.paid.filter(p => p.model === "vendor/b")).toHaveLength(5);
 expect(r.report.failuresByCause.per_model_cap).toBe(2); expect(r.report.proposedTariffRows).toEqual([]);
});
it.each(["unknown", "auth", "overage"])("retains holds and safe debits on %s and stops safely", async mode => {
 const r = await run({ spendCap: "0.1", perModelCap: "0.05" }, server(undefined, undefined, mode));
 expect(r.report.status).toBe("FAIL"); expect(r.report.preCallHoldsMicros).toBeGreaterThan(0);
 if (mode !== "unknown") { expect(r.paid).toHaveLength(1); expect(r.report.notReached).toEqual(["vendor/b"]); }
 if (mode === "overage") expect(r.report.chargedMicros).toBe(1000000);
});
it.each([["identity", "identity_mismatch"], ["refusal", "price_cap_refusal"], ["generation", "generation_lookup"]])("groups %s failures and never promotes them", async (mode, cause) => {
 const r = await run({}, server(undefined, undefined, mode));
 expect(r.report.failuresByCause[cause]).toBe(2); expect(r.report.proposedTariffRows).toEqual([]);
});
it("resumes matching PASS models and carries evidence without spending again", async () => {
 const first = await run(); const r = await run({ resumeReport: first.report });
 expect(r.paid).toHaveLength(0); expect(r.report.status).toBe("PASS"); expect(r.report.models.every(m => m.resumed)).toBe(true);
 expect(r.report.proposedTariffRows).toEqual(first.report.proposedTariffRows); expect(r.report.preCallHoldsMicros).toBe(0);
});
it("requalifies when harness, tariff, provider set or PASS status changes", async () => {
 const first = await run();
 for (const change of ["harness", "tariff", "providers", "status"]) {
  const prior = structuredClone(first.report);
  if (change === "harness") prior.harnessVersion = "obsolete";
  if (change === "status") prior.models[0]!.status = "FAIL";
  const fixture = change === "tariff" ? server([entry("vendor/a"), entry("vendor/b")], [endpoint("fixture-provider", { pricing: { ...pricing, request: "0.000002" } })]) : change === "providers" ? server(undefined, [endpoint("other-provider")]) : server();
  const r = await run({ resumeReport: prior }, fixture);
  expect(r.paid.length).toBeGreaterThan(0);
 }
});
it("rejects malformed arguments and a resume containing credential echoes before HTTP", async () => {
 for (const options of [{ spendCap: "0" }, { perModelCap: "-1" }, { spendCap: "0.0000001" }, { resumeReport: { secret: key } }]) {
  const r = await run(options); expect(r.paid).toEqual([]); expect(r.report.status).toBe("FAIL"); expect(r.report.errors.length).toBeGreaterThan(0);
 }
});
it("supports the all-models CLI with explicit cap and a resume path", async () => {
 const dir = mkdtempSync(join(tmpdir(), "providers-all-cli-")); const path = join(dir, "prior.json");
 const fixture = server(); const first = await run({}, fixture); writeFileSync(path, JSON.stringify(first.report));
 const output: string[] = []; const spy = vi.spyOn(process.stdout, "write").mockImplementation(value => { output.push(String(value)); return true; });
 vi.stubGlobal("fetch", server().fetcher);
 try {
  expect(await main(["--all-models", "--report", join(dir, "report.json"), "--spend-cap", "15.00", "--per-model-cap", "0.05", "--resume", path], { OPENROUTER_API_KEY: key })).toBe(0);
  const report = JSON.parse(output.join("")) as Report; expect(report.models.every(m => m.resumed)).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(first.report);
  expect(readdirSync(dir).sort()).toEqual(["prior.json", "report-catalogue.json", "report.json"]);
 } finally { spy.mockRestore(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true }); }
});

it.each(["report", "catalogue"])("prints the full paid report before an unwritable %s path fails and exits non-zero", async target => {
 const dir = mkdtempSync(join(tmpdir(), "providers-p3-write-failure-"));
 const reportPath = join(dir, "report.json");
 const failedPath = target === "report" ? reportPath : join(dir, "report-catalogue.json");
 const fixture = server([entry("vendor/a")]);
 const output: string[] = []; const errors: string[] = [];
 let outputAtFailure = "";
 const stdout = vi.spyOn(process.stdout, "write").mockImplementation(value => { output.push(String(value)); return true; });
 const stderr = vi.spyOn(process.stderr, "write").mockImplementation(value => { outputAtFailure = output.join(""); errors.push(String(value)); return true; });
 vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
  const response = await fixture.fetcher(...args);
  // Simulate the destination becoming unavailable AFTER preflight and a paid send.
  if (fixture.paid.length === 1) mkdirSync(failedPath, { recursive: true });
  return response;
 });
 try {
  const exitCode = await main(["--all-models", "--report", reportPath, "--spend-cap", "15.00", "--per-model-cap", "0.05"], { OPENROUTER_API_KEY: key });
  expect(fixture.paid).toHaveLength(7);
  expect(output.join("")).not.toBe("");
  const report = JSON.parse(output.join("")) as Report;
  expect(report.status).toBe("PASS");
  expect(report.models).toHaveLength(1);
  expect(report.proposedTariffRows).toHaveLength(1);
  expect(report.chargedMicros).toBe(12);
  expect(report.preCallHoldsMicros).toBeGreaterThan(0);
  expect(report.exposureMicros).toBe(report.preCallHoldsMicros);
  expect(exitCode).toBe(1);
  expect(outputAtFailure).toBe(output.join(""));
  expect(errors.join("")).toContain(failedPath);
  expect(errors.join("")).toMatch(/failed to write/iu);
 } finally { stdout.mockRestore(); stderr.mockRestore(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); }
});

it.each(["report", "resume", "catalogue"])("preflights a read-only %s path before discovery or paid sends", async target => {
 const dir = mkdtempSync(join(tmpdir(), "providers-p3b-readonly-file-"));
 const reportPath = join(dir, "report.json"); const resumePath = join(dir, "prior.json");
 const failedPath = target === "report" ? reportPath : target === "resume" ? resumePath : join(dir, "report-catalogue.json");
 writeFileSync(failedPath, "{}"); chmodSync(failedPath, 0o400);
 const fixture = server([entry("vendor/a")]); const requests: string[] = []; const errors: string[] = [];
 const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
 const stderr = vi.spyOn(process.stderr, "write").mockImplementation(value => { errors.push(String(value)); return true; });
 vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => { requests.push(new Request(...args).method); return fixture.fetcher(...args); });
 try {
  const args = ["--all-models", "--report", reportPath];
  if (target === "resume") args.push("--resume", resumePath);
  const exitCode = await main(args, { OPENROUTER_API_KEY: key });
  expect(fixture.paid).toHaveLength(0);
  expect(requests).toEqual([]);
  expect(exitCode).toBe(1);
  expect(errors.join("")).toContain(failedPath);
  expect(readFileSync(failedPath, "utf8")).toBe("{}");
  expect(readdirSync(dir)).toEqual([target === "report" ? "report.json" : target === "resume" ? "prior.json" : "report-catalogue.json"]);
 } finally { chmodSync(failedPath, 0o600); stdout.mockRestore(); stderr.mockRestore(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); }
});

it.each(["report", "resume"])("preflights an unwritable %s target directory before discovery or paid sends", async target => {
 const dir = mkdtempSync(join(tmpdir(), "providers-p3b-readonly-dir-")); const blocked = join(dir, "blocked");
 mkdirSync(blocked); const failedPath = join(blocked, target === "report" ? "report.json" : "prior.json");
 if (target === "resume") writeFileSync(failedPath, "{}");
 chmodSync(blocked, 0o500);
 const fixture = server([entry("vendor/a")]); const requests: string[] = []; const errors: string[] = [];
 const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
 const stderr = vi.spyOn(process.stderr, "write").mockImplementation(value => { errors.push(String(value)); return true; });
 vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => { requests.push(new Request(...args).method); return fixture.fetcher(...args); });
 try {
  const args = ["--all-models", "--report", target === "report" ? failedPath : join(dir, "report.json")];
  if (target === "resume") args.push("--resume", failedPath);
  expect(await main(args, { OPENROUTER_API_KEY: key })).toBe(1);
  expect(fixture.paid).toHaveLength(0);
  expect(requests).toEqual([]);
  expect(errors.join("")).toContain(failedPath);
  expect(readdirSync(blocked)).toEqual(target === "resume" ? ["prior.json"] : []);
 } finally { chmodSync(blocked, 0o700); stdout.mockRestore(); stderr.mockRestore(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); }
});
