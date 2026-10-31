// Lists the exported names of the two developer files, so the list before the split can be compared with the list after it.
//   node scripts/split/check-exports.ts [--root <checkout>] [--ref <git ref>]   prints `file<TAB>name<TAB>value|type`, sorted
//   node scripts/split/check-exports.ts --compare <git ref>                      exits 1 unless the working tree's lists equal the ref's
// It reads each file alone (no module resolution), so it works on a checkout without node_modules. A name re-exported from a new module counts as
// the kind the re-export says (`type` for `export { type X }`, `export type`), which is what the original declaration (interface, type alias) was.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { CONFIGS } from "./developer-config.ts";

export function exportsOf(fileName: string, text: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const add = (name: string, type: boolean) => found.push(`${name}\t${type ? "type" : "value"}`);
  // A local `import type`/`import { type X }` binding re-exported with `export { X }` is a type.
  const typeImports = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause === undefined) continue;
    const clause = statement.importClause;
    const bindings = clause.namedBindings;
    if (bindings !== undefined && ts.isNamedImports(bindings)) for (const element of bindings.elements) if (clause.isTypeOnly || element.isTypeOnly) typeImports.add(element.name.text);
  }
  for (const statement of sourceFile.statements) {
    const exported = ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause === undefined) { add(`* from ${(statement.moduleSpecifier as ts.StringLiteral | undefined)?.text ?? "?"}`, false); continue; }
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const local = (element.propertyName ?? element.name).text;
          add(element.name.text, statement.isTypeOnly || element.isTypeOnly || (statement.moduleSpecifier === undefined && typeImports.has(local)));
        }
      }
    } else if (exported && (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))) add(statement.name.text, true);
    else if (exported && (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement))) add(statement.name?.text ?? "default", false);
    else if (exported && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) add(declaration.name.text, false);
    }
  }
  // An interface and a function of one name (merged) would list twice; the list is a set.
  return [...new Set(found)];
}

function listing(sources: Record<string, string>): string {
  return Object.entries(sources).flatMap(([file, text]) => exportsOf(file, text).map((entry) => `${path.basename(file)}\t${entry}`)).sort().join("\n");
}

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => { const at = args.indexOf(name); return at === -1 ? undefined : args[at + 1]; };
const root = path.resolve(flag("--root") ?? ".");
const files = Object.values(CONFIGS).map((config) => config.source);
const fromDisk = (): Record<string, string> => Object.fromEntries(files.map((file) => [file, readFileSync(path.join(root, file), "utf8")]));
const fromRef = (ref: string): Record<string, string> => Object.fromEntries(files.map((file) => [file, execFileSync("git", ["show", `${ref}:${file}`], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })]));

if (process.argv[1]?.endsWith("check-exports.ts")) {
  const compare = flag("--compare");
  if (compare !== undefined) {
    const before = listing(fromRef(compare));
    const after = listing(fromDisk());
    const beforeSet = new Set(before.split("\n"));
    const afterSet = new Set(after.split("\n"));
    const lost = [...beforeSet].filter((line) => !afterSet.has(line));
    const gained = [...afterSet].filter((line) => !beforeSet.has(line));
    console.log(`${beforeSet.size} exports before, ${afterSet.size} after`);
    for (const line of lost) console.log(`LOST    ${line}`);
    for (const line of gained) console.log(`GAINED  ${line}`);
    process.exit(lost.length === 0 && gained.length === 0 ? 0 : 1);
  }
  const ref = flag("--ref");
  console.log(listing(ref === undefined ? fromDisk() : fromRef(ref)));
}
