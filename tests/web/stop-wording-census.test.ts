// REVIEW-SONNET-1: a census over every UI/contract source file. The old hosted Stop wording must be gone everywhere,
// the new sentence must live in one constant, and the Close warning must still be the only "machine ... lost" text.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "packages");
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (name === "node_modules" || name === "dist") return [];
    return statSync(path).isDirectory() ? sources(path) : /\.(ts|tsx)$/u.test(name) ? [path] : [];
  });
}
const files = sources(ROOT).map(path => ({ path, text: readFileSync(path, "utf8") }));

describe("Stop wording census", () => {
  it("no source still says Stop ends the machine or loses changes", () => {
    for (const { path, text } of files) {
      expect(text, path).not.toMatch(/STOP_DATA_LOSS|Stopping now ends|Stopping a running step ends|Stop and end the machine/u);
    }
  });
  it("only the Close dialog says closing deletes the machine and unpushed changes are lost", () => {
    const hits = files.filter(({ text }) => /aren't pushed to GitHub or in a pull request are lost/u.test(text)).map(({ path }) => path.replace(ROOT, ""));
    expect(hits).toEqual(["/ui/src/screens/session/CloseTaskDialog.tsx"]);
  });
  it("the hosted Stop sentence is written once, in stop-note.ts", () => {
    const hits = files.filter(({ text }) => text.includes("Its files are kept; Retry continues from them.")).map(({ path }) => path.replace(ROOT, ""));
    expect(hits.sort()).toEqual(["/ui/src/design/parts/shell-gallery-scenes.tsx", "/ui/src/screens/session/stop-note.ts"]);
  });
});
