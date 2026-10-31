// Proves the split kept the order in which files load. Whatever registers itself when its file loads (member movers, home-card sources, approver rules, subject handlers) does so in
// the order ECMAScript evaluates the module graph, so a different order of the same files can change what runs first. This follows the static imports and re-exports of the entry
// file (relative paths, and @agentx/<package> to that package's src), in the order a JavaScript engine evaluates them (depth first, a file after everything it imports), for the
// checkout before the split and the checkout after it, drops the files of the new folder from the second list, and requires the two lists to be the same.
//
//   node scripts/split/check-load-order.ts --before <checkout of the unsplit tree> --after <checkout> [--entry packages/broker/src/aws/broker.ts] [--ignore packages/broker/src/aws/broker/]
//
// It reads files as text (no module resolution by TypeScript, no node_modules): a git worktree of the commit before the split is enough for --before. Exit 0 identical, 1 different.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const ENTRY = "packages/broker/src/aws/broker.ts";

/** The files a file loads at run time, in the order its imports and re-exports name them (type-only ones are erased and load nothing). */
function requestsOf(file: string): string[] {
  const sourceFile = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const specifiers: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly !== true) specifiers.push((statement.moduleSpecifier as ts.StringLiteral).text);
    else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined && !statement.isTypeOnly) specifiers.push((statement.moduleSpecifier as ts.StringLiteral).text);
  }
  return specifiers;
}

function resolveFile(root: string, from: string, specifier: string): string | undefined {
  let base: string;
  if (specifier.startsWith(".")) base = path.resolve(path.dirname(from), specifier);
  else {
    const match = /^@agentx\/([^/]+)(?:\/(.+))?$/.exec(specifier);
    if (match === null) return undefined;
    base = path.join(root, "packages", match[1] as string, "src", match[2] ?? "index");
  }
  const bare = base.replace(/\.(?:js|jsx|mjs)$/, "");
  for (const candidate of [`${bare}.ts`, `${bare}.tsx`, path.join(bare, "index.ts"), path.join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

/** Every file of the graph in evaluation order, as paths from the root. */
export function loadOrder(root: string, entry: string = ENTRY): string[] {
  const visited = new Set<string>();
  const order: string[] = [];
  const visit = (file: string): void => {
    if (visited.has(file)) return;
    visited.add(file);
    for (const specifier of requestsOf(file)) {
      const target = resolveFile(root, file, specifier);
      if (target !== undefined) visit(target);
    }
    order.push(path.relative(root, file).split(path.sep).join("/"));
  };
  visit(path.resolve(root, entry));
  return order;
}

/** Where the two orders first differ (empty when identical), after dropping from `after` the files under `ignore`. */
export function compareOrders(before: readonly string[], after: readonly string[], ignore: string): string[] {
  const kept = after.filter((file) => !file.startsWith(ignore));
  const problems: string[] = [];
  if (before.length !== kept.length) problems.push(`${String(before.length)} files load before the split, ${String(kept.length)} after (not counting ${ignore})`);
  const missing = before.filter((file) => !kept.includes(file));
  const extra = kept.filter((file) => !before.includes(file));
  if (missing.length > 0) problems.push(`no longer loaded: ${missing.slice(0, 10).join(", ")}`);
  if (extra.length > 0) problems.push(`newly loaded: ${extra.slice(0, 10).join(", ")}`);
  const common = before.filter((file) => kept.includes(file));
  const afterCommon = kept.filter((file) => before.includes(file));
  const at = common.findIndex((file, index) => afterCommon[index] !== file);
  if (at !== -1) problems.push(`the order differs from position ${String(at)}: ${common[at]} loaded there before, ${afterCommon[at]} now (before: ${common.slice(at, at + 3).join(" < ")}; after: ${afterCommon.slice(at, at + 3).join(" < ")})`);
  return problems;
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => (args.indexOf(name) === -1 ? undefined : args[args.indexOf(name) + 1]);
  const before = flag("--before");
  const after = flag("--after");
  if (before === undefined || after === undefined) { process.stderr.write("usage: check-load-order.ts --before <unsplit checkout> --after <checkout> [--entry file] [--ignore folder/]\n"); process.exit(2); }
  const entry = flag("--entry") ?? ENTRY;
  const ignore = flag("--ignore") ?? `${entry.replace(/\.ts$/, "")}/`;
  const first = loadOrder(path.resolve(before), entry);
  const second = loadOrder(path.resolve(after), entry);
  const problems = compareOrders(first, second, ignore);
  process.stdout.write(problems.length === 0 ? `load order identical: ${String(first.length)} files, entry last (the ${String(second.length - first.length)} new module files under ${ignore} aside)\n` : `${problems.join("\n")}\n`);
  process.exitCode = problems.length === 0 ? 0 : 1;
}
