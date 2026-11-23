import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
const inventory = JSON.parse(readFileSync(new URL("./held-states.json", import.meta.url), "utf8")) as Record<string, unknown>;
// The fallback scene a board state resolves to: the page's own scene, one of its eight state suffixes, or one of two named extras.
const FALLBACKS = ["slow", "empty", "first-failed", "refresh-failed", "partial", "offline", "access-ended", "unknown"];
const EXTRAS = ["name-missing", "keys-empty"];

it("R5 accounts for every assigned board scene as a served read or held fallback", () => {
 const data: Record<string, unknown> = inventory;
 const rows = data["boardScenes"];
 expect(Array.isArray(rows)).toBe(true);
 if (!Array.isArray(rows)) return;
 expect(rows).toHaveLength(56);
 const common = ["Main example", "Loading", "Loading is taking longer", "Empty", "First read failed", "Refresh failed with prior data", "Partly read", "Offline", "Access ended", "Cannot tell yet"];
 for (const stem of ["name-prompt", "setup-agents", "account", "personal-github", "automation-keys"]) {
  for (const label of common) expect(rows).toContainEqual(expect.objectContaining({ stem, label }));
 }
 for (const row of rows as { stem: string; fallbackScene: string; classification: string }[]) {
  expect(["SERVED", "HELD"]).toContain(row.classification);
  expect([row.stem, ...FALLBACKS.map(kind => `${row.stem}-${kind}`), ...EXTRAS]).toContain(row.fallbackScene);
 }
});
