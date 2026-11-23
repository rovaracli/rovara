import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const script = new URL("../../scripts/openrouter-qualify.mjs", import.meta.url).href;
type Report = { models: { model: string; status: string; causes: string[]; reason: string }[]; errors: string[]; chargedMicros: number; preCallHoldsMicros: number };
type Catalogue = { models: unknown; endpoints: Record<string, unknown>; statuses?: Record<string, number> };
const { main, qualify } = await import(script) as {
 main: (argv: string[], env: Record<string, string>) => Promise<number>;
 qualify: (options: Record<string, unknown>) => Promise<Report>;
};
const pricing = { prompt: "0.000001", completion: "0.000002" };
const entry = (id: string) => ({ id, pricing, supported_parameters: ["tools"], top_provider: { max_completion_tokens: 4096 } });
const fixture = () => ({
 models: { data: [entry("vendor/a:free"), { ...entry("vendor/no-tools"), supported_parameters: [] }, entry("vendor/empty"), entry("vendor/unpriced"), entry("vendor/good")], public_metadata: { fetched_at: 1000 } },
 endpoints: {
  "vendor/empty": { data: { endpoints: [] }, public_metadata: "empty route list" },
  "vendor/unpriced": { data: { endpoints: [{ tag: "unpriced", provider_name: "Unpriced", pricing: { prompt: "unknown" }, supported_parameters: ["tools"] }] } },
  "vendor/good": { data: { endpoints: [{ tag: "good", provider_name: "Good", pricing, supported_parameters: ["tools"], max_completion_tokens: 4096 }] }, public_metadata: ["retain", "all", "fields"] },
 },
});

async function discover(catalogue: Catalogue, check: (paths: { report: string; catalogue: string }, output: string, key: string) => Promise<void>) {
 const dir = mkdtempSync(join(tmpdir(), "providers-catalogue-save-"));
 const paths = { report: join(dir, "discovery.json"), catalogue: join(dir, "discovery-catalogue.json") };
 const key = randomUUID().replaceAll("-", "");
 const requests: string[] = [];
 const output: string[] = [];
 const stdout = vi.spyOn(process.stdout, "write").mockImplementation(value => { output.push(String(value)); return true; });
 vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
  const request = new Request(url, init);
  requests.push(request.method);
  expect(request.headers.get("Authorization")).toBe(`Bearer ${key}`);
  const path = new URL(request.url).pathname;
  if (path === "/api/v1/models") return Response.json(catalogue.models);
  const id = path.slice("/api/v1/models/".length, -"/endpoints".length);
  if (!Object.hasOwn(catalogue.endpoints, id)) throw new Error("unexpected request");
  return Response.json(catalogue.endpoints[id], { status: catalogue.statuses?.[`models/${id}/endpoints`] ?? 200 });
 });
 try {
  expect(await main(["--all-models", "--report", paths.report, "--spend-cap", "15", "--per-model-cap", "0.000001"], { OPENROUTER_API_KEY: key })).toBe(1);
  await check(paths, output.join(""), key);
  expect(requests).toEqual(["GET", "GET", "GET", "GET"]);
 } finally { stdout.mockRestore(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); }
}

it("saves exactly the fetched model and endpoint JSON bodies next to the report, without request headers or runtime credentials", async () => {
 const catalogue = fixture();
 await discover(catalogue, async (paths, output, key) => {
  const saved = readFileSync(paths.catalogue, "utf8");
  expect(JSON.parse(saved)).toEqual(catalogue);
  expect(saved).not.toContain(key);
  expect(saved).not.toMatch(/authorization/iu);
  expect(JSON.parse(readFileSync(paths.report, "utf8"))).toEqual(JSON.parse(output));
 });
});

it("replays all eligibility verdicts from the saved supplied catalogue without fetching", async () => {
 await discover(fixture(), async (paths, output) => {
  const catalogue = JSON.parse(readFileSync(paths.catalogue, "utf8")) as Catalogue;
  let requests = 0;
  const replay = await qualify({ allModels: true, catalogue, spendCap: "15", perModelCap: "0.000001", env: { OPENROUTER_API_KEY: randomUUID() }, fetch: async () => { requests++; throw new Error("offline"); } });
  const original = JSON.parse(output) as Report;
  expect(original.models.map(model => model.causes)).toEqual([["free_variant"], ["no_tools_support"], ["provider_routing"], ["unpriced_component"], ["per_model_cap"]]);
  expect(replay).toEqual(original);
  expect(replay.errors).toEqual([]);
  expect(replay.chargedMicros).toBe(0); expect(replay.preCallHoldsMicros).toBe(0);
  expect(requests).toBe(0);
 });
});

it("retains a fetched endpoint error JSON body and its refusal during offline replay", async () => {
 const catalogue: Catalogue = fixture();
 catalogue.endpoints["vendor/good"] = { error: { code: 503, message: "public endpoint evidence unavailable" } };
 catalogue.statuses = { "models/vendor/good/endpoints": 503 };
 await discover(catalogue, async (paths, output) => {
  const saved = JSON.parse(readFileSync(paths.catalogue, "utf8")) as Catalogue;
  expect(saved).toEqual(catalogue);
  let requests = 0;
  const replay = await qualify({ allModels: true, catalogue: saved, spendCap: "15", perModelCap: "0.000001", env: { OPENROUTER_API_KEY: randomUUID() }, fetch: async () => { requests++; throw new Error("offline"); } });
  expect(replay).toEqual(JSON.parse(output));
  expect(replay.models.at(-1)?.causes).toEqual(["provider_routing"]);
  expect(requests).toBe(0);
 });
});

it.each(["models", "endpoints", "authorization"])("withholds a catalogue containing credential or header evidence in %s", async location => {
 const catalogue = fixture();
 // Construct the canary at runtime and inject it in a response body, never a real key.
 const canary = randomUUID().replaceAll("-", "");
 const dir = mkdtempSync(join(tmpdir(), "providers-catalogue-withheld-"));
 const reportPath = join(dir, "refused.json"); const output: string[] = [];
 const stdout = vi.spyOn(process.stdout, "write").mockImplementation(value => { output.push(String(value)); return true; });
 if (location === "models") Reflect.set(catalogue.models, "echo", canary);
 else Reflect.set(catalogue.endpoints["vendor/good"], location === "authorization" ? "Authorization" : "echo", location === "authorization" ? "header must not persist" : canary.slice(0, 16));
 vi.stubGlobal("fetch", async (url: string) => Response.json(new URL(url).pathname === "/api/v1/models" ? catalogue.models : catalogue.endpoints[new URL(url).pathname.slice("/api/v1/models/".length, -"/endpoints".length) as keyof typeof catalogue.endpoints]));
 try {
  expect(await main(["--all-models", "--report", reportPath, "--per-model-cap", "0.000001"], { OPENROUTER_API_KEY: canary })).toBe(1);
  expect(output.join("")).toContain("Catalogue withheld");
  expect(output.join("")).not.toContain(canary);
  expect(existsSync(reportPath)).toBe(false);
  expect(existsSync(join(dir, "refused-catalogue.json"))).toBe(false);
 } finally { stdout.mockRestore(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); }
});
