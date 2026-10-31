// CN-2: the contracts barrel is made of `export *` lines. When two modules export the same name, TypeScript does not always say so (an explicit `export { X } from`
// quietly beats a star, and two stars hide the name from the importer), so a consumer can end up with the wrong one of two different things sharing a name.
// That happened with `stripHiddenCharacters` (fixed by a rename in 6a21bcce5). This test reads the barrel with the TypeScript compiler and fails when two modules it
// re-exports define the same name as different things. The same thing re-exported by two paths is one thing and is fine.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CONTRACTS_ENTRY = path.join(ROOT, "packages", "contracts", "src", "index.ts");
const CONTRACTS_TSCONFIG = path.join(ROOT, "packages", "contracts", "tsconfig.json");

interface BarrelDuplicate { barrel: string; name: string; definedIn: string[] }

function compilerOptionsFrom(tsconfig: string): ts.CompilerOptions {
  const read = ts.readConfigFile(tsconfig, (file) => ts.sys.readFile(file));
  expect(read.error, "the contracts tsconfig must read").toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(tsconfig));
  const options: ts.CompilerOptions = { ...parsed.options };
  delete options.tsBuildInfoFile;
  return { ...options, noEmit: true, composite: false, declaration: false, declarationMap: false, incremental: false };
}

/** Every name exported by each barrel (a module with an `export *` line, reached from the entry through those lines), grouped by what the name is. */
function findBarrelDuplicates(entry: string, options: ts.CompilerOptions): { duplicates: BarrelDuplicate[]; barrels: string[]; names: number; unresolved: string[] } {
  const program = ts.createProgram([entry], options);
  const checker = program.getTypeChecker();
  const relative = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");
  const resolveAlias = (symbol: ts.Symbol) => ((symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol);
  const definedIn = (symbol: ts.Symbol) => [...new Set((symbol.declarations ?? []).map((declaration) => relative(declaration.getSourceFile().fileName)))].sort().join(" + ");

  const duplicates: BarrelDuplicate[] = [];
  const unresolved: string[] = [];
  const barrels: string[] = [];
  let names = 0;
  const seen = new Set<string>();
  const queue = [path.resolve(entry)];

  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = program.getSourceFile(file);
    if (!source || source.isDeclarationFile || file.includes(`${path.sep}node_modules${path.sep}`)) continue;
    const exportDeclarations = source.statements.filter((statement): statement is ts.ExportDeclaration => ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier));
    if (!exportDeclarations.some((declaration) => declaration.exportClause === undefined)) continue; // no `export *`: not a barrel
    barrels.push(relative(file));

    const byName = new Map<string, Map<ts.Symbol, string>>();
    const add = (name: string, symbol: ts.Symbol) => {
      const target = resolveAlias(symbol);
      const bucket = byName.get(name) ?? new Map<ts.Symbol, string>();
      bucket.set(target, definedIn(target));
      byName.set(name, bucket);
    };

    for (const declaration of exportDeclarations) {
      const specifier = declaration.moduleSpecifier as ts.StringLiteral;
      const moduleSymbol = checker.getSymbolAtLocation(specifier);
      if (!moduleSymbol) { unresolved.push(`${relative(file)}: ${specifier.text}`); continue; }
      const moduleExports = checker.getExportsOfModule(moduleSymbol);
      const clause = declaration.exportClause;
      if (clause === undefined) {
        // `export *` re-exports every name but `default`.
        for (const symbol of moduleExports) if (symbol.name !== "default") add(symbol.name, symbol);
        const resolved = moduleSymbol.valueDeclaration?.getSourceFile() ?? moduleSymbol.declarations?.[0]?.getSourceFile();
        if (resolved) queue.push(resolved.fileName);
      } else if (ts.isNamespaceExport(clause)) {
        add(clause.name.text, moduleSymbol);
      } else {
        for (const element of clause.elements) {
          const exported = moduleExports.find((symbol) => symbol.name === (element.propertyName ?? element.name).text);
          if (exported) add(element.name.text, exported);
          else unresolved.push(`${relative(file)}: ${(element.propertyName ?? element.name).text} from ${specifier.text}`);
        }
      }
    }

    names += byName.size;
    for (const [name, bucket] of byName) {
      if (bucket.size > 1) duplicates.push({ barrel: relative(file), name, definedIn: [...bucket.values()].sort() });
    }
  }
  return { duplicates, barrels, names, unresolved };
}

describe("the contracts barrel", () => {
  const options = compilerOptionsFrom(CONTRACTS_TSCONFIG);

  it("exports no name from two different modules", () => {
    const result = findBarrelDuplicates(CONTRACTS_ENTRY, options);
    // A scan that read nothing cannot pass: the barrel and its plugins sub-barrel are known, and it names well over a thousand things.
    expect(result.barrels).toEqual(expect.arrayContaining(["packages/contracts/src/index.ts", "packages/contracts/src/plugins/index.ts"]));
    expect(result.names).toBeGreaterThan(1000);
    expect(result.unresolved).toEqual([]);
    expect(result.duplicates.map((entry) => `${entry.name} (${entry.barrel}): ${entry.definedIn.join(" | ")}`)).toEqual([]);
  }, 120_000);
});

describe("the duplicate check can fail", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "barrel-dup-"));
  const write = (name: string, text: string) => { mkdirSync(path.dirname(path.join(directory, name)), { recursive: true }); writeFileSync(path.join(directory, name), text); };
  const run = (barrel: string) => findBarrelDuplicates(path.join(directory, barrel), { ...options(), rootDir: directory });
  const options = (): ts.CompilerOptions => ({ module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2023, strict: true, noEmit: true, skipLibCheck: true, types: [] });
  const cleanup = () => rmSync(directory, { recursive: true, force: true });

  it("reports two stars exporting one name, an explicit export beating a star, and a duplicate inside a sub-barrel; ignores one thing re-exported twice", () => {
    write("a.ts", "export const shared = 1; export const onlyA = 1; export const same = 1;");
    write("b.ts", "export const shared = 'two'; export const onlyB = 1;");
    write("c.ts", "export type Explicit = string; export const onlyC = 1;");
    write("reexport.ts", "export { same } from './a.js';");
    write("sub/x.ts", "export const inner = 1;");
    write("sub/y.ts", "export const inner = 2;");
    write("sub/index.ts", "export * from './x.js'; export * from './y.js';");
    write("d.ts", "export type Explicit = number;");
    write("index.ts", "export * from './a.js'; export * from './b.js'; export * from './c.js'; export * from './reexport.js'; export * from './sub/index.js'; export { Explicit } from './d.js';");
    const result = run("index.ts");
    expect(result.unresolved).toEqual([]);
    expect(result.barrels).toHaveLength(2);
    const found = result.duplicates.map((entry) => `${entry.name}@${entry.barrel.endsWith("/sub/index.ts") ? "sub" : "root"}`).sort();
    try {
      expect(found).toEqual(["Explicit@root", "inner@sub", "shared@root"]);
    } finally {
      cleanup();
    }
  });
});
