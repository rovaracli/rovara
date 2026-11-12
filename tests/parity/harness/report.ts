// The parity table: one row per area (1-46). An area is "same" when every scenario covering it compared the same on the facets both engines observe,
// "different" when any did not (with the diff), and "not covered" when no scenario reached a comparison for it (with each reason). Written as Markdown
// and JSON (PARITY_REPORT_DIR, else the system temp folder) and returned for the test to print.
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PARITY_AREAS } from "../areas.js";
import type { ScenarioResult } from "./compare.js";

export interface AreaRow {
  id: number;
  name: string;
  outcome: "same" | "different" | "not covered";
  scenarios: string[];
  /** Facets compared the same / not covered across its scenarios (an area can be "same" on some facets only). */
  sameFacets: string[];
  uncoveredFacets: string[];
  notes: string[];
}

export function areaTable(results: readonly ScenarioResult[]): AreaRow[] {
  return PARITY_AREAS.map((area): AreaRow => {
    const mine = results.filter((result) => result.scenario.areas.includes(area.id));
    const notes: string[] = [];
    if (area.cloudOnly !== undefined) notes.push(`Cloud-only: ${area.cloudOnly}`);
    for (const result of mine) {
      if (result.notCovered !== undefined) notes.push(`${result.scenario.id}: ${result.notCovered}`);
      for (const facet of result.facets) {
        if (facet.outcome === "different") notes.push(`${result.scenario.id} ${facet.facet}: cloud ${JSON.stringify(facet.cloud)} | core ${JSON.stringify(facet.core)}`);
      }
    }
    const compared = mine.filter((result) => result.notCovered === undefined && result.facets.some((facet) => facet.outcome !== "not covered"));
    const outcome = compared.length === 0 ? "not covered" : compared.some((result) => result.outcome === "different") ? "different" : "same";
    const facets = (kind: string) => [...new Set(compared.flatMap((result) => result.facets.filter((facet) => facet.outcome === kind).map((facet) => facet.facet)))].sort();
    if (mine.length === 0 && area.cloudOnly === undefined) notes.push("no scenario yet");
    return { id: area.id, name: area.name, outcome, scenarios: mine.map((result) => result.scenario.id), sameFacets: facets("same"), uncoveredFacets: facets("not covered"), notes };
  });
}

export function markdownOf(rows: readonly AreaRow[], results: readonly ScenarioResult[]): string {
  const count = (outcome: AreaRow["outcome"]) => rows.filter((row) => row.outcome === outcome).length;
  const lines = [
    "# Cloud parity: Cloud's path vs Rovara Code's core",
    "",
    `Areas: ${count("same")} same, ${count("different")} different, ${count("not covered")} not covered (of ${rows.length}). Scenarios: ${results.length}.`,
    "",
    "| # | Area | Outcome | Same on | Scenarios | Notes |",
    "|---|---|---|---|---|---|",
    ...rows.map((row) => `| ${row.id} | ${row.name} | ${row.outcome} | ${row.sameFacets.join(", ")} | ${row.scenarios.join(", ")} | ${row.notes.join("<br>").replace(/\|/g, "\\|")} |`),
  ];
  return `${lines.join("\n")}\n`;
}

export async function writeReport(rows: readonly AreaRow[], results: readonly ScenarioResult[], directory = process.env.PARITY_REPORT_DIR ?? join(tmpdir(), "rovara-parity")): Promise<string> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "parity.md"), markdownOf(rows, results));
  await writeFile(join(directory, "parity.json"), `${JSON.stringify({ rows, results: results.map((result) => ({ id: result.scenario.id, outcome: result.outcome, notCovered: result.notCovered, facets: result.facets })) }, null, 2)}\n`);
  return directory;
}
