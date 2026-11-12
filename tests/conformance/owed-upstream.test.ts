// Convergence wave 1: what Cloud's adapters need from Code's ports and Code does not carry yet (tests/conformance/owed-upstream.json). Each entry names a port that exists, says why,
// and is owed by a date; an entry past its date fails here, so a gap is either closed upstream (the entry comes off) or re-dated on purpose.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SUITE_FILE } from "./ports.js";

interface OwedEntry { port: string; member: string; lane: string; owedUntil: string; reason: string }
const owed = JSON.parse(readFileSync(new URL("./owed-upstream.json", import.meta.url), "utf8")) as { entries: OwedEntry[] };
/** Ports with no conformance suite yet that an entry may still name (Code's plug-in points, `plugin-points.ts`). */
const PORTS_WITHOUT_SUITE = new Set(["company-instructions", "build-system", "learning", "team-record-source"]);

describe("owed upstream (Code ports Cloud's adapters need more of)", () => {
  it("lists well-formed entries for ports that exist, each once", () => {
    const seen = new Set<string>();
    for (const entry of owed.entries) {
      expect(Object.hasOwn(SUITE_FILE, entry.port) || PORTS_WITHOUT_SUITE.has(entry.port), entry.port).toBe(true);
      expect(entry.member).toMatch(/^[A-Za-z][A-Za-z ]{0,63}$/u);
      expect(entry.lane).toMatch(/^[A-Z][0-9]{1,2}$/u);
      expect(entry.owedUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(entry.reason.length).toBeGreaterThan(20);
      expect(seen.has(`${entry.port}.${entry.member}`)).toBe(false);
      seen.add(`${entry.port}.${entry.member}`);
    }
  });

  it("has no entry past its owedUntil date", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(owed.entries.filter((entry) => entry.owedUntil < today).map((entry) => `${entry.port}.${entry.member} (owed until ${entry.owedUntil})`)).toEqual([]);
  });
});
