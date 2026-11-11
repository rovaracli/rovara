import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Convergence W0-3 (R4): Cloud's contracts (`@agentx/cloud-contracts`) and Rovara Code's (`@rovara-code/contracts`) are two packages, and a name must have one owner. A name both
// export is allowed in exactly one case: Cloud's entry re-exports Code's own binding (the browser entry does, for the names it carries). Anything else is a second definition under the
// same name, which is only allowed where packages/cloud-contracts/owed-upstream.json lists that exact name under the file that defines it, with the reason (Cloud is ahead of the pinned Code
// there, so the change is owed to Code first). The list can only shrink: a listed name that is no longer shadowed fails this test until it is taken off, and an entry older than 7 days fails
// (plan 3.1: the upstream-owed ledger is looked at again after a week).
const root = process.cwd();
const CLOUD_SRC = "packages/cloud-contracts/src/";
const CLOUD_ENTRIES = ["index.ts", "web.ts", "testing.ts"].map((entry) => path.join(root, CLOUD_SRC, entry));
const CODE_INDEX = path.join(root, "vendor/rovara-code/packages/contracts/src/index.ts");

interface Owed { file: string; names: string[]; owedSince: string; reason: string }
const OWED_DAYS_MAX = 7;
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
  const listed = new Map(owed.map((entry) => [entry.file, entry]));

  it("defines every name Code's contracts also export only where the owed-upstream list names that exact name under that file", () => {
    const unlisted = [...found].flatMap(([file, names]) => {
      const entry = listed.get(file);
      const extra = names.filter((name) => entry === undefined || !entry.names.includes(name)).sort();
      return extra.length === 0 ? [] : [`${file}: ${extra.join(", ")}`];
    });
    expect(unlisted, "a name both packages export is a second definition: import it from @rovara-code/contracts, or (Cloud is ahead of Code) list the name under its file in packages/cloud-contracts/owed-upstream.json with the reason").toEqual([]);
  });

  it("lists no name that has stopped shadowing one of Code's", () => {
    const stale = owed.flatMap((entry) => {
      const still = found.get(entry.file) ?? [];
      const gone = entry.names.filter((name) => !still.includes(name));
      return gone.length === 0 ? [] : [`${entry.file}: ${gone.join(", ")}`];
    });
    expect(stale, "these names are no longer defined by Cloud as well as Code: take them off the list").toEqual([]);
  });

  it("gives every listed file a reason, a date and at least one name, lists a file once and a name once", () => {
    for (const entry of owed) {
      expect(entry.reason.length, entry.file).toBeGreaterThan(20);
      expect(entry.owedSince, entry.file).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(entry.names.length, entry.file).toBeGreaterThan(0);
      expect(new Set(entry.names).size, entry.file).toBe(entry.names.length);
    }
    expect(new Set(owed.map((entry) => entry.file)).size).toBe(owed.length);
    const all = owed.flatMap((entry) => entry.names);
    expect(new Set(all).size, "a name is listed under two files").toBe(all.length);
  });

  it("fails an entry that has been owed for more than 7 days (plan 3.1: the ledger is looked at again after a week)", () => {
    const old = owed.filter((entry) => Date.now() - Date.parse(`${entry.owedSince}T00:00:00Z`) > OWED_DAYS_MAX * 86_400_000).map((entry) => `${entry.file} (since ${entry.owedSince})`);
    expect(old, "land these upstream and re-pin, or have the controller renew the date on purpose").toEqual([]);
  });

  it("keeps the browser entry's own definitions out of Code's names (it re-exports them, it never redefines them)", () => {
    const options: ts.CompilerOptions = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2023, lib: ["lib.es2023.d.ts"], skipLibCheck: true, noEmit: true, types: ["node"] };
    const program = ts.createProgram([CODE_INDEX, path.join(root, CLOUD_SRC, "web.ts")], options);
    const checker = program.getTypeChecker();
    const code = exportsOf(checker, program, CODE_INDEX);
    const web = exportsOf(checker, program, path.join(root, CLOUD_SRC, "web.ts"));
    const shadowed = [...web].filter(([name, declaredIn]) => code.has(name) && !declaredIn.startsWith("vendor/rovara-code/") && !listed.get(declaredIn.slice(CLOUD_SRC.length))?.names.includes(name)).map(([name]) => name);
    expect(shadowed).toEqual([]);
  });
});
