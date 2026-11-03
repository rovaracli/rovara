// Keeps the agent docs true: docs/architecture/code-map.md, AGENTS.md and docs/agents/task-checklist.md name files and
// functions (never line numbers, which move on every merge), and this script checks that each one still exists. It also
// regenerates the code map's per-folder "what each file owns" tables from the files' own header comments.
//
//   node scripts/codemap.ts            check: exit 1 if a doc names a file or function that is gone; warn about files not yet listed
//   node scripts/codemap.ts --write    regenerate the tables between <!-- codemap:files <folder> --> and <!-- /codemap:files --> markers
//
// tests/unit/codemap.test.ts runs the check, so a rename or delete that leaves a doc stale fails in CI.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CODEMAP_PATH = "docs/architecture/code-map.md";
/** Every agent-facing doc whose backticked paths and names are checked. Only the code map has generated tables. */
export const CHECKED_DOCS = [CODEMAP_PATH, "AGENTS.md", "docs/agents/task-checklist.md"] as const;

/** A reference in a doc: a repo path in backticks, optionally `path#name` for a top-level function, class, type or const in that file. */
export interface CodemapReference {
  readonly path: string;
  readonly symbol?: string;
}

/** A generated table: the folder it describes and the file names its rows list. */
export interface CodemapBlock {
  readonly folder: string;
  readonly files: readonly string[];
}

export interface CodemapReport {
  /** The doc is wrong: a named file, folder or symbol no longer exists. */
  readonly errors: readonly string[];
  /** The doc is incomplete: never fails the check. */
  readonly warnings: readonly string[];
}

const ROOT_FILES = "AGENTS\\.md|CLAUDE\\.md|README\\.md|CONTRIBUTING\\.md|package\\.json|\\.node-version|\\.gitignore|eslint\\.config\\.js|vitest\\.config\\.ts|tsconfig[\\w.-]*\\.json";
// A path with a placeholder (`packages/contracts/src/<name>.ts`) or a glob is a pattern, not a reference, so it is not matched.
// `#name` may be followed by `.member` (only `name` is checked); a `.md#anchor` is a link to a heading, and only the file is checked.
const REFERENCE = new RegExp(
  "`((?:(?:packages|infra|tests|scripts|docs|specs|\\.github)\\/[^\\s`*?{}<>#]+?)|(?:" + ROOT_FILES + "))(?:#([A-Za-z_$][\\w$-]*)(?:\\.[\\w$]+)*)?`",
  "g",
);
const BLOCK = /<!-- codemap:files (\S+) -->\n([\s\S]*?)<!-- \/codemap:files -->/g;
const ROW_FILE = /^\| `([^`]+)` \|/gm;
const SOURCE_FILE = /\.(ts|tsx)$/;
const SPLIT_PREFIX = /^Part of the broker(?: \([^)]*\))?:\s*/;
/** Leading comments that are tooling or legal text, not a description of the file. */
const NOT_A_DESCRIPTION = /^\s*(?:eslint|@ts-|prettier|@license|copyright|spdx|#!)/i;

const lf = (text: string): string => text.replace(/\r\n?/g, "\n");
const escapeName = (name: string): string => name.replace(/[$]/g, "\\$");

/** Every backticked repo path outside the generated tables (their rows are checked against their folder instead). */
export function extractReferences(markdown: string): CodemapReference[] {
  const outside = lf(markdown).replace(BLOCK, "");
  const references: CodemapReference[] = [];
  for (const match of outside.matchAll(REFERENCE)) {
    const path = match[1]!.replace(/[.,;:]$/, "");
    references.push(match[2] === undefined || path.endsWith(".md") ? { path } : { path, symbol: match[2] });
  }
  return references;
}

export function extractBlocks(markdown: string): CodemapBlock[] {
  return [...lf(markdown).matchAll(BLOCK)].map((match) => ({
    folder: match[1]!,
    files: [...match[2]!.matchAll(ROW_FILE)].map((row) => row[1]!),
  }));
}

/**
 * True where `source` declares `symbol` at the top level (a line that starts with the declaration, optionally exported),
 * or re-exports something under that name. A name that only appears in a comment, an import or a nested local does not count.
 */
export function definesSymbol(source: string, symbol: string): boolean {
  const text = lf(source);
  const declaration = new RegExp(
    `^(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:const\\s+enum|function\\*?|const|let|var|class|interface|type|enum|namespace|module)\\s+${escapeName(symbol)}(?![\\w$])`,
    "m",
  );
  if (declaration.test(text)) return true;
  if (new RegExp(`^export\\s+\\*\\s+as\\s+${escapeName(symbol)}(?![\\w$])`, "m").test(text)) return true;
  for (const match of text.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    const exported = match[1]!.split(",").map((entry) => entry.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()!.trim());
    if (exported.includes(symbol)) return true;
  }
  return false;
}

/** For a file with no header comment: its first three exports, in source order (they rarely change). */
function exportsFallback(source: string): string {
  const names = [...lf(source).matchAll(/^export (?:async )?(?:function\*?|const|class|type|interface|enum) (\w+)/gm)].slice(0, 3).map((match) => `\`${match[1]!}\``);
  return names.length === 0 ? "" : `(No header comment.) Exports ${names.join(", ")}.`;
}

/** The first sentence of the file's leading comment; for a file without one, its first exports. */
export function describeFile(source: string): string {
  const head = lf(source).slice(0, 4000);
  let comment: string;
  const block = /^\s*\/\*\*?([\s\S]*?)\*\//.exec(head);
  if (block) {
    comment = block[1]!
      .split("\n")
      .map((line) => line.replace(/^\s*\*\s?/, "").trim())
      .join(" ");
  } else {
    const lines: string[] = [];
    for (const line of head.split("\n")) {
      const match = /^\s*\/\/\s?(.*)$/.exec(line);
      if (!match) break;
      lines.push(match[1]!.trim());
    }
    comment = lines.join(" ");
  }
  comment = comment.replace(/\s+/g, " ").trim();
  if (comment === "" || NOT_A_DESCRIPTION.test(comment)) return exportsFallback(source);
  comment = comment.replace(SPLIT_PREFIX, "");
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(comment)?.[1] ?? comment;
  const text = sentence.length > 220 ? `${sentence.slice(0, 217).trimEnd()}...` : sentence;
  return text.replace(/\|/g, "\\|");
}

/** True where `path` exists with exactly this spelling. macOS ignores case; Linux CI does not. */
export function existsExactly(root: string, path: string): boolean {
  let directory = root;
  for (const part of path.split("/").filter((segment) => segment !== "")) {
    if (!existsSync(directory) || !statSync(directory).isDirectory() || !readdirSync(directory).includes(part)) return false;
    directory = join(directory, part);
  }
  return true;
}

/** The source files directly in `folder`, sorted, test files excluded. */
export function folderFiles(root: string, folder: string): string[] {
  const directory = join(root, folder);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => SOURCE_FILE.test(name) && !/\.test\.tsx?$/.test(name) && statSync(join(directory, name)).isFile())
    .sort();
}

export function renderBlock(root: string, folder: string): string {
  const rows = folderFiles(root, folder).map((name) => `| \`${name}\` | ${describeFile(readFileSync(join(root, folder, name), "utf8"))} |`);
  return ["| File | What it owns |", "|---|---|", ...rows, ""].join("\n");
}

/** The map with every generated table rebuilt from the current files. */
export function writeCodemap(root: string, markdown: string): string {
  return lf(markdown).replace(BLOCK, (_whole, folder: string) => `<!-- codemap:files ${folder} -->\n${renderBlock(root, folder)}<!-- /codemap:files -->`);
}

export function checkCodemap(root: string, markdown: string): CodemapReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const reference of extractReferences(markdown)) {
    if (!existsExactly(root, reference.path)) {
      errors.push(`${reference.path} does not exist.`);
      continue;
    }
    if (reference.symbol !== undefined) {
      const target = join(root, reference.path);
      if (statSync(target).isDirectory()) errors.push(`${reference.path}#${reference.symbol}: a name must point into a file, not a folder.`);
      else if (!definesSymbol(readFileSync(target, "utf8"), reference.symbol)) errors.push(`${reference.path} no longer defines ${reference.symbol}.`);
    }
  }
  for (const block of extractBlocks(markdown)) {
    if (!existsExactly(root, block.folder)) {
      errors.push(`The table for ${block.folder} names a folder that does not exist.`);
      continue;
    }
    const present = new Set(folderFiles(root, block.folder));
    const gone = block.files.filter((name) => !present.has(name));
    if (gone.length > 0) errors.push(`The table for ${block.folder} lists files that are gone: ${gone.join(", ")}. Run node scripts/codemap.ts --write.`);
    const listed = new Set(block.files);
    const unlisted = [...present].filter((name) => !listed.has(name));
    if (unlisted.length > 0) warnings.push(`The table for ${block.folder} does not list ${unlisted.join(", ")} yet. Run node scripts/codemap.ts --write.`);
  }
  return { errors, warnings };
}

function main(argv: readonly string[]): number {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const path = join(root, CODEMAP_PATH);
  if (argv.includes("--write")) {
    const markdown = readFileSync(path, "utf8");
    const next = writeCodemap(root, markdown);
    if (next !== markdown) writeFileSync(path, next);
    console.log(next === markdown ? `${CODEMAP_PATH} is up to date.` : `Rewrote the generated tables in ${CODEMAP_PATH}.`);
  }
  let failed = false;
  for (const doc of CHECKED_DOCS) {
    const report = checkCodemap(root, readFileSync(join(root, doc), "utf8"));
    for (const warning of report.warnings) console.warn(`warning: ${doc}: ${warning}`);
    for (const error of report.errors) console.error(`error: ${doc}: ${error}`);
    if (report.errors.length > 0) {
      failed = true;
      console.error(`${doc} names ${report.errors.length} thing(s) that no longer exist. Fix it (paths and names only, no line numbers).`);
    } else console.log(`${doc}: every file and name it lists exists.`);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
