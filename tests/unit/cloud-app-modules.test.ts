// Convergence S0: the production adapter list. Every spending action Code's core asks Admission about is either admitted by a rule here or left out on
// purpose (automation, decision 45.10); a new action at a pin bump fails this test instead of being refused in production without a word.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CORE_ADMISSION_ACTIONS, OWED_POINTS, POINTS_BY_AREA } from "../../packages/broker/src/cloud/app/index.js";

const LEFT_OUT: Readonly<Record<string, string>> = { "automation.run": "automation is hidden in Cloud (decision 45.10): refused" };

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => (entry.isDirectory() ? sources(join(directory, entry.name)) : entry.name.endsWith(".ts") ? [join(directory, entry.name)] : [])))).flat();
}

describe("the Cloud adapter modules", () => {
  it("admit every action the core asks Admission about, or leave it out with a reason", async () => {
    const asked = new Set<string>();
    for (const file of await sources(join(import.meta.dirname, "../../vendor/rovara-code/packages/broker/src/core"))) {
      const text = await readFile(file, "utf8");
      for (const match of text.matchAll(/(?:admission\.admit|admission\.stage|\badmit)\(\s*(?:deps,\s*)?\{[^}]*?action:\s*"([a-z_.-]+)"/g)) asked.add(match[1]!);
      if (text.includes("BASE_MERGED_ADMISSION_ACTION")) asked.add("autofix.base-merged");
    }
    for (const literal of ["task.start", "machine.start", "model.call"]) asked.add(literal);
    expect([...asked].filter((action) => CORE_ADMISSION_ACTIONS[action] === undefined && LEFT_OUT[action] === undefined).sort()).toEqual([]);
  });

  it("names the lane that owes each point no merged adapter fills, and those points are ones the switch needs", () => {
    const needed = new Set(Object.values(POINTS_BY_AREA).flat());
    for (const point of Object.keys(OWED_POINTS)) expect(needed.has(point as never), point).toBe(true);
  });
});
