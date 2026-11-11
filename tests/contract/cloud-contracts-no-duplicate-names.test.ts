import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Convergence W0-3 (R4, owner decision 94): Cloud's contracts (`@agentx/cloud-contracts`) and Rovara Code's (`@rovara-code/contracts`) are two packages, and a name must have one owner. A name
// both export is allowed in exactly one case: Cloud's entry re-exports Code's own binding (the browser entry does, for the names it carries). Anything else is a second definition under the
// same name, which is only allowed where packages/cloud-contracts/owed-upstream.json lists that exact name under the file that defines it. Each entry is one of three kinds, with a reason:
//   - owedUntil: Cloud is ahead of the pinned Code (a Code lane is landing the shape). The entry fails this test after that date, so it cannot sit there unseen.
//   - cloudOnly: Cloud's own on purpose (AWS infrastructure, Enterprise roles, closed lists). Never expires.
//   - migration: a shape in saved data; adopting Code's is a data migration. Never expires on its own, and is listed in DEFERRED-CHECKS.
// The list can only shrink: a listed name that is no longer shadowed fails until it is taken off.
const root = process.cwd();
const CLOUD_SRC = "packages/cloud-contracts/src/";
const CLOUD_ENTRIES = ["index.ts", "web.ts", "testing.ts"].map((entry) => path.join(root, CLOUD_SRC, entry));
const CODE_INDEX = path.join(root, "vendor/rovara-code/packages/contracts/src/index.ts");

interface Listed { file: string; names: string[]; reason: string; owedUntil?: string; cloudOnly?: true; migration?: true }
const listed = (JSON.parse(readFileSync(path.join(root, "packages/cloud-contracts/owed-upstream.json"), "utf8")) as { files: Listed[] }).files;
const kindOf = (entry: Listed): string[] => [entry.owedUntil === undefined ? "" : "owedUntil", entry.cloudOnly === true ? "cloudOnly" : "", entry.migration === true ? "migration" : ""].filter((kind) => kind !== "");
/** The listed names per file: a file may have several entries (one kind each) with different names. */
const namesByFile = (entries: Listed[]): Map<string, Set<string>> => {
  const result = new Map<string, Set<string>>();
  for (const entry of entries) result.set(entry.file, new Set([...(result.get(entry.file) ?? []), ...entry.names]));
  return result;
};
/** Whether an owed entry is past its date: the day itself is still allowed. */
const pastDate = (owedUntil: string, now: number): boolean => now > Date.parse(`${owedUntil}T23:59:59.999Z`);

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
  const listedNames = namesByFile(listed);

  it("defines every name Code's contracts also export only where the owed-upstream list names that exact name under that file", () => {
    const unlisted = [...found].flatMap(([file, names]) => {
      const entry = listedNames.get(file);
      const extra = names.filter((name) => entry === undefined || !entry.has(name)).sort();
      return extra.length === 0 ? [] : [`${file}: ${extra.join(", ")}`];
    });
    expect(unlisted, "a name both packages export is a second definition: import it from @rovara-code/contracts, or (Cloud is ahead of Code, or Cloud's own on purpose) list the name under its file in packages/cloud-contracts/owed-upstream.json with the reason").toEqual([]);
  });

  it("lists no name that has stopped shadowing one of Code's", () => {
    const stale = listed.flatMap((entry) => {
      const still = found.get(entry.file) ?? [];
      const gone = entry.names.filter((name) => !still.includes(name));
      return gone.length === 0 ? [] : [`${entry.file}: ${gone.join(", ")}`];
    });
    expect(stale, "these names are no longer defined by Cloud as well as Code: take them off the list").toEqual([]);
  });

  it("gives every entry exactly one kind (owedUntil, cloudOnly or migration), a reason and at least one name, and lists a name once", () => {
    for (const entry of listed) {
      expect(kindOf(entry), `${entry.file}: exactly one of owedUntil, cloudOnly: true, migration: true`).toHaveLength(1);
      if (entry.owedUntil !== undefined) expect(entry.owedUntil, entry.file).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(entry.cloudOnly === undefined || entry.cloudOnly === true, entry.file).toBe(true);
      expect(entry.migration === undefined || entry.migration === true, entry.file).toBe(true);
      expect(entry.reason.length, entry.file).toBeGreaterThan(20);
      expect(entry.names.length, entry.file).toBeGreaterThan(0);
      expect(new Set(entry.names).size, entry.file).toBe(entry.names.length);
    }
    const all = listed.flatMap((entry) => entry.names);
    expect(new Set(all).size, "a name is listed twice").toBe(all.length);
  });

  it("fails an owed entry after its owedUntil date, and never fails a cloudOnly or migration entry for age", () => {
    const late = listed.filter((entry) => entry.owedUntil !== undefined && pastDate(entry.owedUntil, Date.now())).map((entry) => `${entry.file} (owed until ${entry.owedUntil})`);
    expect(late, "land these in Code and re-pin, or have the controller move the date on purpose").toEqual([]);
  });

  it("applies the date rule to owed entries only (the rule, on fixed dates)", () => {
    const entries: Listed[] = [
      { file: "a.ts", names: ["A"], reason: "owed entry with a date in the past", owedUntil: "2026-01-01" },
      { file: "b.ts", names: ["B"], reason: "cloud only entry, no date", cloudOnly: true },
      { file: "c.ts", names: ["C"], reason: "migration entry, no date", migration: true },
    ];
    const farFuture = Date.parse("2099-01-01T00:00:00Z");
    const expired = (now: number) => entries.filter((entry) => entry.owedUntil !== undefined && pastDate(entry.owedUntil, now)).map((entry) => entry.file);
    expect(expired(farFuture)).toEqual(["a.ts"]);
    expect(expired(Date.parse("2026-01-01T12:00:00Z"))).toEqual([]);
    expect(expired(Date.parse("2026-01-02T00:00:00Z"))).toEqual(["a.ts"]);
    // The same file may have two entries of different kinds with different names, and a duplicate name that no entry lists is still found.
    const two = namesByFile([{ file: "x.ts", names: ["One"], reason: "r".repeat(30), owedUntil: "2026-12-01" }, { file: "x.ts", names: ["Two"], reason: "r".repeat(30), migration: true }]);
    expect([...(two.get("x.ts") ?? [])].sort()).toEqual(["One", "Two"]);
    expect(two.get("x.ts")?.has("Three")).toBe(false);
  });

  it("keeps the browser entry's own definitions out of Code's names (it re-exports them, it never redefines them)", () => {
    const options: ts.CompilerOptions = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2023, lib: ["lib.es2023.d.ts"], skipLibCheck: true, noEmit: true, types: ["node"] };
    const program = ts.createProgram([CODE_INDEX, path.join(root, CLOUD_SRC, "web.ts")], options);
    const checker = program.getTypeChecker();
    const code = exportsOf(checker, program, CODE_INDEX);
    const web = exportsOf(checker, program, path.join(root, CLOUD_SRC, "web.ts"));
    const shadowed = [...web].filter(([name, declaredIn]) => code.has(name) && !declaredIn.startsWith("vendor/rovara-code/") && !listedNames.get(declaredIn.slice(CLOUD_SRC.length))?.has(name)).map(([name]) => name);
    expect(shadowed).toEqual([]);
  });
});
