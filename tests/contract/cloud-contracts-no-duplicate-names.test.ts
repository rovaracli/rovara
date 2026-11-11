import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Convergence W0-3 (R4): Cloud's contracts (`@agentx/cloud-contracts`) and Rovara Code's (`@rovara-code/contracts`) are two packages, and a name must have one owner. A name both
// export is allowed in exactly one case: Cloud's entry re-exports Code's own binding (the browser entry does, for the names it carries). Anything else is a second definition under the
// same name, which is only allowed where packages/cloud-contracts/owed-upstream.json lists the file that defines it, with the reason (Cloud is ahead of the pinned Code there, so the
// change is owed to Code first). The list can only shrink: a listed file that no longer shadows a name of Code's fails this test until it is taken off.
const root = process.cwd();
const CLOUD_SRC = "packages/cloud-contracts/src/";
const CLOUD_ENTRIES = ["index.ts", "web.ts", "testing.ts"].map((entry) => path.join(root, CLOUD_SRC, entry));
const CODE_INDEX = path.join(root, "vendor/rovara-code/packages/contracts/src/index.ts");

interface Owed { file: string; since: string; reason: string }
const owed = (JSON.parse(readFileSync(path.join(root, "packages/cloud-contracts/owed-upstream.json"), "utf8")) as { files: Owed[] }).files;

function exportsOf(checker: ts.TypeChecker, program: ts.Program, entry: string): Map<string, string> {
  const source = program.getSourceFile(entry);
  expect(source, entry).toBeDefined();
  const symbol = checker.getSymbolAtLocation(source!);
  expect(symbol, entry).toBeDefined();
  const names = new Map<string, string>();
  for (const exported of checker.getExportsOfModule(symbol!)) {
    const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const declaration = target.declarations?.[0];
    names.set(exported.name, declaration === undefined ? "?" : path.relative(root, declaration.getSourceFile().fileName));
  }
  return names;
}

function duplicates(): Map<string, string[]> {
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2023, lib: ["lib.es2023.d.ts"], strict: true, skipLibCheck: true,
    noEmit: true, types: ["node"], verbatimModuleSyntax: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true,
  };
  const program = ts.createProgram([CODE_INDEX, ...CLOUD_ENTRIES], options);
  const checker = program.getTypeChecker();
  const code = exportsOf(checker, program, CODE_INDEX);
  const byFile = new Map<string, string[]>();
  for (const entry of CLOUD_ENTRIES) {
    for (const [name, declaredIn] of exportsOf(checker, program, entry)) {
      if (!code.has(name)) continue;
      // Code's own binding, reached through the package (the vendored source or its built files): the same name, not a second definition.
      if (declaredIn.startsWith("vendor/rovara-code/")) continue;
      const file = declaredIn.startsWith(CLOUD_SRC) ? declaredIn.slice(CLOUD_SRC.length) : declaredIn;
      const names = byFile.get(file) ?? [];
      if (!names.includes(name)) names.push(name);
      byFile.set(file, names);
    }
  }
  return byFile;
}

describe("Cloud's contracts and Rovara Code's contracts export no name twice", () => {
  const found = duplicates();

  it("defines every name Code's contracts also export only in a file the owed-upstream list names", () => {
    const listed = new Set(owed.map((entry) => entry.file));
    const unlisted = [...found].filter(([file]) => !listed.has(file)).map(([file, names]) => `${file}: ${names.sort().join(", ")}`);
    expect(unlisted, "a name both packages export is a second definition: import it from @rovara-code/contracts, or (Cloud is ahead of Code) list the file in packages/cloud-contracts/owed-upstream.json with the reason").toEqual([]);
  });

  it("lists no file that has stopped shadowing a name of Code's", () => {
    const stale = owed.filter((entry) => !found.has(entry.file)).map((entry) => entry.file);
    expect(stale, "these files no longer define a name Code also exports: take them off the list").toEqual([]);
  });

  it("gives every listed file a reason and a date, and lists a file once", () => {
    for (const entry of owed) {
      expect(entry.reason.length, entry.file).toBeGreaterThan(20);
      expect(entry.since, entry.file).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    }
    expect(new Set(owed.map((entry) => entry.file)).size).toBe(owed.length);
  });

  it("keeps the browser entry's own definitions out of Code's names (it re-exports them, it never redefines them)", () => {
    const options: ts.CompilerOptions = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2023, lib: ["lib.es2023.d.ts"], skipLibCheck: true, noEmit: true, types: ["node"] };
    const program = ts.createProgram([CODE_INDEX, path.join(root, CLOUD_SRC, "web.ts")], options);
    const checker = program.getTypeChecker();
    const code = exportsOf(checker, program, CODE_INDEX);
    const web = exportsOf(checker, program, path.join(root, CLOUD_SRC, "web.ts"));
    const shadowed = [...web].filter(([name, declaredIn]) => code.has(name) && !declaredIn.startsWith("vendor/rovara-code/") && !owed.some((entry) => declaredIn === CLOUD_SRC + entry.file)).map(([name]) => name);
    expect(shadowed).toEqual([]);
  });
});
