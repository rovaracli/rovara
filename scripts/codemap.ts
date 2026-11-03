// Keeps docs/architecture/code-map.md true. The map names files and functions (never line numbers, which move on every merge), and this script checks
// that each one still exists. It also regenerates the per-folder "what each file owns" tables from the files' own header comments.
//
//   node scripts/codemap.ts            check: exit 1 if the map or AGENTS.md names a file or function that is gone; warn about files not yet listed
//   node scripts/codemap.ts --write    regenerate the tables between <!-- codemap:files <folder> --> and <!-- /codemap:files --> markers
//
// tests/unit/codemap.test.ts runs the check, so a rename or delete that leaves the map stale fails in CI.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CODEMAP_PATH = "docs/architecture/code-map.md";
/** Every agent-facing doc whose backticked paths and names are checked. Only the code map has generated tables. */
export const CHECKED_DOCS = [CODEMAP_PATH, "AGENTS.md"] as const;

/** A reference in the map: a repo path in backticks, optionally `path#symbol` for a function, class, type or const defined in that file. */
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
  /** The map is wrong: a named file, folder or symbol no longer exists. */
  readonly errors: readonly string[];
  /** The map is incomplete or its tables are out of date: never fails the check. */
  readonly warnings: readonly string[];
}

// A path with a placeholder (`packages/contracts/src/<name>.ts`) or a glob is a pattern, not a reference, so it is not matched.
const REFERENCE = /`((?:packages|infra|tests|scripts|docs|\.github)\/[^\s`*?{}<>]+?)(?:#([A-Za-z_$][\w$]*))?`/g;
const BLOCK = /<!-- codemap:files (\S+) -->\n([\s\S]*?)<!-- \/codemap:files -->/g;
const ROW_FILE = /^\| `([^`]+)` \|/gm;
const SOURCE_FILE = /\.(ts|tsx)$/;
const SPLIT_PREFIX = /^Part of the broker(?: \([^)]*\))?:\s*/;

/** Every backticked repo path outside the generated tables (their rows are checked against their folder instead). */
export function extractReferences(markdown: string): CodemapReference[] {
  const outside = markdown.replace(BLOCK, "");
  const references: CodemapReference[] = [];
  for (const match of outside.matchAll(REFERENCE)) {
    const path = match[1]!.replace(/[.,;:]$/, "");
    references.push(match[2] === undefined ? { path } : { path, symbol: match[2] });
  }
  return references;
}

export function extractBlocks(markdown: string): CodemapBlock[] {
  return [...markdown.matchAll(BLOCK)].map((match) => ({
    folder: match[1]!,
    files: [...match[2]!.matchAll(ROW_FILE)].map((row) => row[1]!),
  }));
}

/** True where `source` defines `symbol` at the top level of a declaration, or re-exports it by name. */
export function definesSymbol(source: string, symbol: string): boolean {
  const name = symbol.replace(/[$]/g, "\\$");
  return (
    new RegExp(`(?:function\\*?|const|let|var|class|interface|type|enum)\\s+${name}\\b`).test(source) ||
    new RegExp(`export\\s+(?:type\\s+)?\\{[^}]*\\b${name}\\b[^}]*\\}`).test(source)
  );
}

/** The first sentence of the file's leading comment, or its first exports when it has none. */
export function describeFile(source: string): string {
  const head = source.slice(0, 4000);
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
  comment = comment.replace(/\s+/g, " ").replace(SPLIT_PREFIX, "").trim();
  if (comment !== "") {
    const sentence = /^(.+?[.!?])(?:\s|$)/.exec(comment)?.[1] ?? comment;
    const text = sentence.length > 220 ? `${sentence.slice(0, 217).trimEnd()}...` : sentence;
    return text.replace(/\|/g, "\\|");
  }
  const exports = [...source.matchAll(/^export (?:async )?(?:function\*?|const|class|type|interface) (\w+)/gm)].map((match) => `\`${match[1]!}\``);
  if (exports.length === 0) return "";
  return exports.length > 5 ? `Exports ${exports.slice(0, 5).join(", ")} and ${exports.length - 5} more.` : `Exports ${exports.join(", ")}.`;
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
  return markdown.replace(BLOCK, (_whole, folder: string) => `<!-- codemap:files ${folder} -->\n${renderBlock(root, folder)}<!-- /codemap:files -->`);
}

export function checkCodemap(root: string, markdown: string): CodemapReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const reference of extractReferences(markdown)) {
    const target = join(root, reference.path);
    if (!existsSync(target)) {
      errors.push(`${reference.path} does not exist.`);
      continue;
    }
    if (reference.symbol !== undefined) {
      if (statSync(target).isDirectory()) errors.push(`${reference.path}#${reference.symbol}: a symbol must name a file, not a folder.`);
      else if (!definesSymbol(readFileSync(target, "utf8"), reference.symbol)) errors.push(`${reference.path} no longer defines ${reference.symbol}.`);
    }
  }
  for (const block of extractBlocks(markdown)) {
    if (!existsSync(join(root, block.folder))) {
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
  const root = fileURLToPath(new URL("..", import.meta.url));
  const path = join(root, CODEMAP_PATH);
  const markdown = readFileSync(path, "utf8");
  if (argv.includes("--write")) {
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
