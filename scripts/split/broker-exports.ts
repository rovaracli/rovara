// Proves the broker.ts split kept its public surface: lists every name broker.ts exports (through re-exports too), with what each is, the type TypeScript gives it, and a hash
// of its declaration text, so a moved-but-changed declaration shows up as a difference.
//
//   node scripts/split/broker-exports.ts snapshot <out.json> [--root <checkout>]    (loads the broker package's TypeScript program: run through heavy.sh)
//   node scripts/split/broker-exports.ts compare <before.json> <after.json>         (exit 0 identical, 1 different)
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export interface ExportEntry { kind: string; type: string; declaration: string }
export type Snapshot = Record<string, ExportEntry>;

export function snapshot(root: string): Snapshot {
  const configPath = path.join(root, "packages/broker/tsconfig.json");
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (diagnostic) => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")); } });
  if (parsed === undefined) throw new Error("cannot read the broker tsconfig");
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, ...(parsed.projectReferences === undefined ? {} : { projectReferences: parsed.projectReferences }) });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(path.join(root, "packages/broker/src/aws/broker.ts"));
  if (source === undefined) throw new Error("broker.ts is not in the program");
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (moduleSymbol === undefined) throw new Error("broker.ts has no exports");
  const result: Snapshot = {};
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const target = (exported.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(exported) : exported;
    const declarations = target.declarations ?? [];
    const kinds = declarations.map((declaration) => ts.SyntaxKind[declaration.kind]).sort().join("+");
    const first = declarations[0];
    let type = "";
    if (first !== undefined) {
      const isTypeOnly = (target.flags & ts.SymbolFlags.Value) === 0;
      type = isTypeOnly
        ? checker.typeToString(checker.getDeclaredTypeOfSymbol(target), undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias)
        : checker.typeToString(checker.getTypeOfSymbolAtLocation(target, first), undefined, ts.TypeFormatFlags.NoTruncation);
    }
    type = type.replace(/import\("[^"]*"\)\./g, "");
    const text = declarations.map((declaration) => declaration.getText().replace(/^export\s+/, "")).join("\n");
    result[exported.name] = { kind: kinds, type, declaration: createHash("sha256").update(text).digest("hex") };
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => (a < b ? -1 : 1)));
}

const tokens = (type: string): string => (type.match(/[\w"'-]+/g) ?? []).sort().join(" ");

export function compare(before: Snapshot, after: Snapshot): string[] {
  const differences: string[] = [];
  for (const name of Object.keys(before)) {
    const now = after[name];
    const was = before[name]!;
    if (now === undefined) { differences.push(`removed: ${name}`); continue; }
    if (now.kind !== was.kind) differences.push(`${name}: kind ${was.kind} -> ${now.kind}`);
    // TypeScript prints the members of a union in the order it created them, which moves when files are arranged differently; the same tokens in another order are the same type.
    if (now.type !== was.type && tokens(now.type) !== tokens(was.type)) differences.push(`${name}: type changed`);
    if (now.declaration !== was.declaration) differences.push(`${name}: declaration text changed`);
  }
  for (const name of Object.keys(after)) if (!(name in before)) differences.push(`added: ${name}`);
  return differences;
}

const [command, first, second, ...rest] = process.argv.slice(2);
if (command === "snapshot" && first !== undefined) {
  const rootIndex = [second, ...rest].indexOf("--root");
  const root = path.resolve(rootIndex >= 0 ? [second, ...rest][rootIndex + 1] ?? "." : ".");
  const data = snapshot(root);
  writeFileSync(first, `${JSON.stringify(data, null, 1)}\n`);
  process.stdout.write(`${String(Object.keys(data).length)} exports written to ${first}\n`);
} else if (command === "compare" && first !== undefined && second !== undefined) {
  const differences = compare(JSON.parse(readFileSync(first, "utf8")) as Snapshot, JSON.parse(readFileSync(second, "utf8")) as Snapshot);
  process.stdout.write(differences.length === 0 ? "broker.ts exports are identical (names, kinds, types, declaration text)\n" : `${differences.join("\n")}\n`);
  process.exitCode = differences.length === 0 ? 0 : 1;
} else {
  process.stderr.write("usage: broker-exports.ts snapshot <out.json> [--root dir] | compare <before.json> <after.json>\n");
  process.exitCode = 2;
}
