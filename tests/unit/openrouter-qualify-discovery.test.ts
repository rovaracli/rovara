import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const script = new URL("../../scripts/openrouter-qualify.mjs", import.meta.url).href;
type Report = { models: { reason: string; causes: string[] }[]; errors: string[]; chargedMicros: number; reservedMicros: number };
const { qualify } = await import(script) as { qualify: (o: Record<string, unknown>) => Promise<Report> };
const discovery = JSON.parse(readFileSync(new URL("../fixtures/model-gateway-prices/openrouter-discovery-absent-zero-20261121.json", import.meta.url), "utf8")) as { models: { model: string; reason: string; causes: string[] }[] };
const catalogue = JSON.parse(readFileSync(new URL("../fixtures/openrouter-catalogue-20261122.json", import.meta.url), "utf8")) as { data: { id: string }[] };
it("rechecks the saved discovery report against the raw local catalogue; eligible models > 0 and every remaining exclusion has a cause", async () => {
 const counts: Record<string, number> = {};
 for (const row of discovery.models) {
  // The rejection report redacted 98 IDs. Never reconstruct or invent their identity.
  if (row.model === "[invalid model]") { counts.catalogue_id_redacted = (counts.catalogue_id_redacted ?? 0) + 1; continue; }
  const entries = catalogue.data.filter(e => e.id === row.model);
  expect(entries, row.model).toHaveLength(1);
  let endpointLookups = 0;
  const report = await qualify({ allModels: true, spendCap: "0.000001", perModelCap: "0.05", env: { OPENROUTER_API_KEY: "discovery-replay-fixture" }, now: () => 1000, fetch: async (url: string, init: RequestInit) => {
   expect(init.method).toBe("GET"); // no paid calls, sockets or real credentials
   if (new URL(url).pathname.endsWith("/endpoints")) { endpointLookups++; return Response.json({ data: { endpoints: [] } }); }
   return Response.json({ data: entries });
  } });
  expect(report.errors, row.model).toEqual([]);
  expect(report.chargedMicros).toBe(0); expect(report.reservedMicros).toBe(0);
  const result = report.models[0]!;
  expect(result.reason, row.model).toBeTruthy(); expect(result.causes.length, row.model).toBeGreaterThan(0);
  // Reaching endpoint discovery proves catalogue eligibility. No provider snapshot
  // exists here: do not substitute catalogue rates for a real endpoint tariff.
  const cause = endpointLookups === 1 ? "catalogue_eligible" : result.causes[0]!;
  counts[cause] = (counts[cause] ?? 0) + 1;
 }
 expect(discovery.models).toHaveLength(441);
 expect(counts.catalogue_eligible).toBeGreaterThan(0);
 expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(441);
 expect(counts).toEqual({ catalogue_eligible: 264, no_tools_support: 58, unpriced_component: 21, catalogue_id_redacted: 98 });
});
