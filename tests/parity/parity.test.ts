// The parity suite (decision 130): every scenario through Cloud's old path and through Rovara Code's core on the composition root's adapters, compared on
// normalized outcomes, and the per-area table (same / different / not covered) written to PARITY_REPORT_DIR (else the temp folder) and printed.
//
// What fails the suite: a difference that is not in known-differences.ts with its likely cause (a new difference is a finding to look at, never noise),
// a known difference that no longer shows (so the list stays true), a scenario file not listed, an area with no scenario, an engine that crashes
// (reported, and failed unless the scenario expects it). "Not covered" never fails: it is the table's honest to-do list.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PARITY_AREAS } from "./areas.js";
import { CloudEngine } from "./engines/cloud.js";
import { DRIVER_GROUPS as CLOUD_GROUPS } from "./engines/cloud-drivers/index.js";
import { DRIVER_GROUPS as CORE_GROUPS } from "./engines/core-drivers/index.js";
import { CoreEngine } from "./engines/core.js";
import { compareScenario, type ScenarioResult } from "./harness/compare.js";
import { areaTable, markdownOf, writeReport } from "./harness/report.js";
import { StagingTargetRefused, createStagingEngine } from "./harness/staging-target.js";
import { KNOWN_DIFFERENCES } from "./known-differences.js";
import { SCENARIOS } from "./scenarios/index.js";

const results: ScenarioResult[] = [];

describe("the parity suite's own rules", () => {
  it("lists every scenario file, and every area has a scenario or is Cloud-only", async () => {
    const files = (await readdir(join(import.meta.dirname, "scenarios"))).filter((name) => name.endsWith(".ts") && name !== "index.ts" && !name.startsWith("index-")).map((name) => name.replace(/\.ts$/, "")).sort();
    expect(SCENARIOS.map((scenario) => scenario.id).sort()).toEqual(files);
    for (const area of PARITY_AREAS) {
      if (area.cloudOnly !== undefined) continue;
      expect(SCENARIOS.some((scenario) => scenario.areas.includes(area.id)), `area ${String(area.id)} has no scenario`).toBe(true);
    }
  });

  it("drives each step key from one lane's file only, on each engine", () => {
    for (const groups of [CORE_GROUPS, CLOUD_GROUPS]) {
      const owners = new Map<string, string>();
      for (const [lane, drivers] of Object.entries(groups)) {
        for (const key of Object.keys(drivers)) {
          expect(owners.get(key), `${key} is driven by ${String(owners.get(key))} and ${lane}`).toBeUndefined();
          owners.set(key, lane);
        }
      }
    }
  });

  it("never reaches a deployment from a test: the staging target refuses unless the controller enables it", () => {
    expect(() => createStagingEngine({ baseUrl: "https://example.invalid", token: "x", companyId: "org_s0parity00000000000a", engine: "core", env: {} })).toThrow(StagingTargetRefused);
  });
});

describe("Cloud's path vs the core, scenario by scenario", () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.id}: ${scenario.title}`, async () => {
      const cloud = new CloudEngine();
      const core = new CoreEngine();
      try {
        const result = await compareScenario(scenario, cloud, core);
        results.push(result);
        // An engine that crashes is a failure to look at, never a quiet "not covered".
        expect(result.notCovered ?? "", `${scenario.id}: ${result.notCovered ?? ""}`).not.toMatch(/^an engine failed/);
        const known = KNOWN_DIFFERENCES.filter((entry) => entry.scenario === scenario.id || entry.scenario === "*");
        for (const facet of result.facets) {
          if (facet.outcome !== "different") continue;
          const differing = [...facet.cloud.filter((value) => !facet.core.includes(value)), ...facet.core.filter((value) => !facet.cloud.includes(value))];
          const explained = known.find((entry) => entry.facet === facet.facet && (entry.only === undefined || differing.every((value) => entry.only!.includes(value))));
          expect(explained, `${scenario.id} ${facet.facet} differs and is not in known-differences.ts:\ncloud ${JSON.stringify(facet.cloud)}\ncore  ${JSON.stringify(facet.core)}`).toBeDefined();
        }
        for (const entry of known.filter((candidate) => candidate.scenario !== "*")) {
          const facet = result.facets.find((candidate) => candidate.facet === entry.facet);
          expect(facet?.outcome, `${scenario.id} ${entry.facet} is listed as different but is ${facet?.outcome ?? "not compared"}`).toBe("different");
        }
      } finally {
        await cloud.dispose();
        await core.dispose();
      }
    }, 240_000);
  }
});

afterAll(async () => {
  if (results.length === 0) return;
  const rows = areaTable(results);
  const directory = await writeReport(rows, results);
  console.log(`${markdownOf(rows, results)}\n(report: ${directory})`);
});
