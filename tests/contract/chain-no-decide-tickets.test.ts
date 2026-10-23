// Plan 4 Task 8 (M12, R66): Plan 4 mints no decide tickets. Every link it shows or stores is Plan 3's bare `confirmUrlFor(record)`, so Plan 3's identify-first path
// applies, or the ticketed `confirmUrl` Plan 3 returns to the caller's own token. The broker role could write a `DECIDE_TICKET#` item, so only the code keeps this
// rule, and this test is what enforces it: it reads every source file of the chain and trigger code and fails on a ticket key or an import of what mints one.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE = fileURLToPath(new URL("../../packages/broker/src", import.meta.url));
const ROOTS = ["chains", "triggers"].map((name) => join(SOURCE, name));

function sourcesUnder(directory: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? sourcesUnder(path) : /\.(ts|tsx|js|mjs)$/.test(entry) ? [path] : [];
  });
}

/** What Plan 3 exports that makes a ticket or a ticketed link. */
const MINTING = ["mintConfirmUrl", "mintTicket", "confirmUrlWithTicket", "DecideStore", "decideTicketKey", "decide-session"];

describe("Plan 4 mints no decide tickets (M12)", () => {
  const files = ROOTS.flatMap(sourcesUnder);

  it("reads the chain code (and the trigger code when it exists)", () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((file) => file.endsWith("chains/runner.ts"))).toBe(true);
    expect(files.some((file) => file.endsWith("chains/gates.ts"))).toBe(true);
    expect(files.some((file) => file.endsWith("chains/write-approvers.ts"))).toBe(true);
  });

  it("has no `DECIDE_TICKET#` key in any file", () => {
    for (const file of files) expect(readFileSync(file, "utf8"), file).not.toContain("DECIDE_TICKET#");
  });

  it("imports nothing that mints a ticket, and never says `ticket=` in a link it builds", () => {
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const name of MINTING) expect(source, `${file} mentions ${name}`).not.toContain(name);
      expect(source, file).not.toMatch(/\?ticket=|[&?]ticket\b/);
    }
  });

  it("builds every link to a decision with Plan 3's `confirmUrlFor`, and the gate's event text, which every reader of the run sees, has none (review I-1)", () => {
    const gates = readFileSync(join(SOURCE, "chains/gates.ts"), "utf8");
    expect(gates.replace(/^\s*\/\/.*$/gmu, "")).not.toContain("confirmUrlFor");
    for (const file of files) expect(readFileSync(file, "utf8"), file).not.toMatch(/\/v1\/app\/approve\//);
  });
});
