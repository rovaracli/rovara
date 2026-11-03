// The agent docs name files and functions, never line numbers, and this test keeps them true: a rename or delete that
// leaves a doc pointing at nothing fails here, in the same change. New files not yet listed in a generated table are
// only a warning, printed below, so adding a file never blocks a merge.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CHECKED_DOCS, CODEMAP_PATH, checkCodemap, definesSymbol, describeFile, existsExactly, extractBlocks, extractReferences, writeCodemap } from "../../scripts/codemap.js";

const repositoryRoot = join(import.meta.dirname, "..", "..");
// Spelled out so CI's docs-only check (scripts/ci-docs-only.ts) sees that this test reads these files.
const CHECKED_DOC_PATHS = ["docs/architecture/code-map.md", "AGENTS.md", "docs/agents/task-checklist.md"];

describe("the agent docs", () => {
  it("are the files the checker reads", () => {
    expect([...CHECKED_DOCS]).toEqual(CHECKED_DOC_PATHS);
  });

  it.each(CHECKED_DOC_PATHS)("%s names only files, folders and functions that exist", (doc) => {
    const report = checkCodemap(repositoryRoot, readFileSync(join(repositoryRoot, doc), "utf8"));
    for (const warning of report.warnings) console.warn(`${doc}: ${warning}`);
    expect(report.errors).toEqual([]);
  });

  it("the code map has no line numbers, which go stale on every merge", () => {
    expect(readFileSync(join(repositoryRoot, CODEMAP_PATH), "utf8")).not.toMatch(/\.(ts|tsx|md|json):\d+/);
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

  it("reads paths, path#name, root files and specs, and skips patterns and generated tables", () => {
    const markdown = [
      "See `packages/a/src/x.ts#run` and `packages/a/src/` and `infra/lib/app.ts` and `AGENTS.md` and `specs/001-a/spec.md`.",
      "Members and anchors: `packages/a/src/x.ts#Runner.start`, `docs/a.md#some-heading`.",
      "Not paths: `npm run lint`, `code: \"xx\"`, `packages/a/src/<name>.ts`, `tests/**/*.test.ts`, `src/index.ts`.",
      "<!-- codemap:files packages/a/src -->",
      "| `x.ts` | Runs. |",
      "<!-- /codemap:files -->",
    ].join("\n");
    expect(extractReferences(markdown)).toEqual([
      { path: "packages/a/src/x.ts", symbol: "run" },
      { path: "packages/a/src/" },
      { path: "infra/lib/app.ts" },
      { path: "AGENTS.md" },
      { path: "specs/001-a/spec.md" },
      { path: "packages/a/src/x.ts", symbol: "Runner" },
      { path: "docs/a.md" },
    ]);
    expect(extractBlocks(markdown)).toEqual([{ folder: "packages/a/src", files: ["x.ts"] }]);
  });

  it("reads Windows line endings the same way", () => {
    const markdown = "`packages/a/x.ts`\r\n<!-- codemap:files packages/a -->\r\n| `x.ts` | Runs. |\r\n<!-- /codemap:files -->\r\n";
    expect(extractBlocks(markdown)).toEqual([{ folder: "packages/a", files: ["x.ts"] }]);
    expect(describeFile("// Runs the thing.\r\nexport const run = 1;\r\n")).toBe("Runs the thing.");
  });

  it("counts top-level declarations and re-exports by their exported name, nothing else", () => {
    expect(definesSymbol("export async function run() {}", "run")).toBe(true);
    expect(definesSymbol("export const LIMIT = 3;", "LIMIT")).toBe(true);
    expect(definesSymbol("export interface Spec {}", "Spec")).toBe(true);
    expect(definesSymbol("class Runner {}", "Runner")).toBe(true);
    expect(definesSymbol("export { run as start, stop } from './y.js';", "stop")).toBe(true);
    expect(definesSymbol("export { run as start } from './y.js';", "start")).toBe(true);
    expect(definesSymbol("export { run as start } from './y.js';", "run")).toBe(false);
    expect(definesSymbol("// const run was removed", "run")).toBe(false);
    expect(definesSymbol('import { type run } from "./a.js";', "run")).toBe(false);
    expect(definesSymbol("function outer() {\n  const run = 1;\n}", "run")).toBe(false);
    expect(definesSymbol("const runner = run();", "run")).toBe(false);
    expect(definesSymbol("export const enum Mode { A }", "Mode")).toBe(true);
    expect(definesSymbol("export namespace Tools {}", "Tools")).toBe(true);
    expect(definesSymbol("export * as helpers from './h.js';", "helpers")).toBe(true);
    expect(definesSymbol("export const a$ = 1;", "a")).toBe(false);
  });

  it("fails on a missing file, a wrongly cased path, a removed name and a table row whose file is gone", () => {
    const root = repository({ "packages/a/src/x.ts": "export function run() {}\n", "packages/a/src/new.ts": "export const fresh = 1;\n" });
    const markdown = [
      "`packages/a/src/x.ts#run` `packages/a/src/x.ts#gone` `packages/a/src/missing.ts` `packages/A/src/x.ts`",
      "<!-- codemap:files packages/a/src -->",
      "| `x.ts` | Runs. |",
      "| `old.ts` | Was here. |",
      "<!-- /codemap:files -->",
    ].join("\n");
    const report = checkCodemap(root, markdown);
    expect(report.errors).toEqual([
      "packages/a/src/x.ts no longer defines gone.",
      "packages/a/src/missing.ts does not exist.",
      "packages/A/src/x.ts does not exist.",
      "The table for packages/a/src lists files that are gone: old.ts. Run node scripts/codemap.ts --write.",
    ]);
    expect(report.warnings).toEqual(["The table for packages/a/src does not list new.ts yet. Run node scripts/codemap.ts --write."]);
    expect(existsExactly(root, "packages/a/src/x.ts")).toBe(true);
    expect(existsExactly(root, "packages/a/src/X.ts")).toBe(false);
  });

  it("regenerates a table from each file's header comment, or its first exports without one", () => {
    const root = repository({
      "packages/a/src/x.ts": "// Part of the broker (split out of ../broker.ts): runs the thing. More detail.\nexport function run() {}\n",
      "packages/a/src/y.ts": "/**\n * Stops the thing | safely.\n */\nexport const stop = 1;\n",
      "packages/a/src/z.ts": "import { a } from './a.js';\nexport function one() {}\n",
      "packages/a/src/w.ts": "/* eslint-disable no-console */\nexport const w = 1;\n",
      "packages/a/src/z.test.ts": "it('is skipped', () => {});\n",
    });
    const written = writeCodemap(root, "<!-- codemap:files packages/a/src -->\nstale\n<!-- /codemap:files -->");
    expect(written).toBe(
      [
        "<!-- codemap:files packages/a/src -->",
        "| File | What it owns |",
        "|---|---|",
        "| `w.ts` | (No header comment.) Exports `w`. |",
        "| `x.ts` | runs the thing. |",
        "| `y.ts` | Stops the thing \\| safely. |",
        "| `z.ts` | (No header comment.) Exports `one`. |",
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
