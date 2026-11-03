// docs/architecture/code-map.md tells coding agents where code lives. It names files and functions, never line numbers, and this test keeps it true:
// a rename or delete that leaves the map pointing at nothing fails here, in the same change. Files not yet listed in a generated table
// are only a warning (scripts/codemap.ts prints them), so adding a file never blocks a merge.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CHECKED_DOCS, CODEMAP_PATH, checkCodemap, definesSymbol, describeFile, extractBlocks, extractReferences, writeCodemap } from "../../scripts/codemap.js";

const repositoryRoot = join(import.meta.dirname, "..", "..");

describe("docs/architecture/code-map.md and AGENTS.md", () => {
  it.each(CHECKED_DOCS)("%s names only files, folders and functions that exist", (doc) => {
    const report = checkCodemap(repositoryRoot, readFileSync(join(repositoryRoot, doc), "utf8"));
    expect(report.errors).toEqual([]);
  });

  it("has no line numbers, which go stale on every merge", () => {
    const markdown = readFileSync(join(repositoryRoot, CODEMAP_PATH), "utf8");
    expect(markdown).not.toMatch(/\.(ts|tsx|md|json):\d+/);
  });
});

describe("the map checker", () => {
  const temporary: string[] = [];
  afterEach(() => {
    for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function repository(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "codemap-"));
    temporary.push(root);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  }

  it("reads paths and path#symbol references, skipping generated tables", () => {
    const markdown = [
      "See `packages/a/src/x.ts#run` and `packages/a/src/` and `infra/lib/app.ts`.",
      "Not a path: `npm run lint`, `code: \"xx\"`, `packages/a/src/<name>.ts`, `tests/**/*.test.ts`.",
      "<!-- codemap:files packages/a/src -->",
      "| `x.ts` | Runs. |",
      "<!-- /codemap:files -->",
    ].join("\n");
    expect(extractReferences(markdown)).toEqual([{ path: "packages/a/src/x.ts", symbol: "run" }, { path: "packages/a/src/" }, { path: "infra/lib/app.ts" }]);
    expect(extractBlocks(markdown)).toEqual([{ folder: "packages/a/src", files: ["x.ts"] }]);
  });

  it("finds declarations and named re-exports, and nothing else", () => {
    expect(definesSymbol("export async function run() {}", "run")).toBe(true);
    expect(definesSymbol("export const LIMIT = 3;", "LIMIT")).toBe(true);
    expect(definesSymbol("export interface Spec {}", "Spec")).toBe(true);
    expect(definesSymbol("export { run as start, stop } from './y.js';", "stop")).toBe(true);
    expect(definesSymbol("const runner = run();", "run")).toBe(false);
    expect(definesSymbol("function running() {}", "run")).toBe(false);
  });

  it("fails on a missing file, a removed symbol and a table row whose file is gone", () => {
    const root = repository({ "packages/a/src/x.ts": "export function run() {}\n", "packages/a/src/new.ts": "export const fresh = 1;\n" });
    const markdown = [
      "`packages/a/src/x.ts#run` `packages/a/src/x.ts#gone` `packages/a/src/missing.ts`",
      "<!-- codemap:files packages/a/src -->",
      "| `x.ts` | Runs. |",
      "| `old.ts` | Was here. |",
      "<!-- /codemap:files -->",
    ].join("\n");
    const report = checkCodemap(root, markdown);
    expect(report.errors).toEqual([
      "packages/a/src/x.ts no longer defines gone.",
      "packages/a/src/missing.ts does not exist.",
      "The table for packages/a/src lists files that are gone: old.ts. Run node scripts/codemap.ts --write.",
    ]);
    expect(report.warnings).toEqual(["The table for packages/a/src does not list new.ts yet. Run node scripts/codemap.ts --write."]);
  });

  it("regenerates a table from each file's header comment, or its exports when it has none", () => {
    const root = repository({
      "packages/a/src/x.ts": "// Part of the broker (split out of ../broker.ts): runs the thing. More detail.\nexport function run() {}\n",
      "packages/a/src/y.ts": "/**\n * Stops the thing | safely.\n */\nexport const stop = 1;\n",
      "packages/a/src/z.ts": "import { a } from './a.js';\nexport function one() {}\nexport type Two = string;\n",
      "packages/a/src/z.test.ts": "it('is skipped', () => {});\n",
    });
    const written = writeCodemap(root, "<!-- codemap:files packages/a/src -->\nstale\n<!-- /codemap:files -->");
    expect(written).toBe(
      [
        "<!-- codemap:files packages/a/src -->",
        "| File | What it owns |",
        "|---|---|",
        "| `x.ts` | runs the thing. |",
        "| `y.ts` | Stops the thing \\| safely. |",
        "| `z.ts` | Exports `one`, `Two`. |",
        "<!-- /codemap:files -->",
      ].join("\n"),
    );
    expect(checkCodemap(root, written)).toEqual({ errors: [], warnings: [] });
  });

  it("keeps a long description to one readable line", () => {
    const text = describeFile(`// ${"word ".repeat(80)}\n`);
    expect(text.length).toBeLessThanOrEqual(220);
    expect(text.endsWith("...")).toBe(true);
  });
});
