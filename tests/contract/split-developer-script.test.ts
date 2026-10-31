// scripts/split/split-developer.ts moves the declarations of the two big developer files into modules. These tests pin how it behaves on the NEXT run: it must not
// overwrite real modules, must write both files or neither, must keep comments that sat on import lines, must not place names by use when the config is strict, and
// the shared and private configs must put a shared name in the same module. (That the split is a pure move is proved by the exported-symbol check, tsc and the
// tests of the broker; this file is about the script.)
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareManifests } from "../../scripts/split/compare-manifests.ts";
import { CONFIGS as SHARED } from "../../scripts/split/developer-config.ts";
import { compareText, mergeConfig, planSplit, writePlan, type ConfigOverlay, type SplitConfig } from "../../scripts/split/split-lib.ts";

const ROOT = path.join(import.meta.dirname, "../..");
const SCRIPT = path.join(ROOT, "scripts/split/split-developer.ts");
const created: string[] = [];
afterEach(() => { for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const scratch = (): string => {
  const directory = mkdtempSync(path.join(tmpdir(), "split-developer-"));
  created.push(directory);
  return directory;
};
const run = (root: string, ...args: string[]) => {
  const result = spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], { encoding: "utf8" });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
};
const filesUnder = (directory: string): Record<string, string> => {
  const found: Record<string, string> = {};
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else found[path.relative(directory, full)] = readFileSync(full, "utf8");
    }
  };
  visit(directory);
  return found;
};

/** A small file with a header, two commented imports, a declaration that runs at load, and a router that stays. */
const BIG = `// header of the big file
import { dependency } from "./dependency.js";
// Lane A G1: this import has no setter, and that is on purpose.
import { other } from "./other.js";

export function one() { return dependency(); }
export function two() { return one() + other(); }
const hidden = 3;
export function three() { return hidden; }
export function route() { return one() + two() + three(); }
`;
const BAD = `export function inner() { return outer(); }\nexport function outer() { return 1; }\n`;
const CONFIG = `export const CONFIGS = {
  big: { source: "src/big.ts", outDir: "src/big", modules: { first: ["one", "two"], second: ["hidden", "three"] }, stay: ["route"], fallbackModule: "common", preserveImportOrder: true, strict: true },
  bad: { source: "src/bad.ts", outDir: "src/bad", modules: { m: ["inner"] }, stay: ["outer"], fallbackModule: "common", preserveImportOrder: true, strict: true },
};
`;

describe("a re-run on a tree that is already split", () => {
  const copyOfCurrentTree = (): string => {
    const root = scratch();
    for (const name of ["developer-tasks", "developer-routes"]) {
      mkdirSync(path.join(root, "packages/broker/src/aws"), { recursive: true });
      cpSync(path.join(ROOT, `packages/broker/src/aws/${name}.ts`), path.join(root, `packages/broker/src/aws/${name}.ts`));
      cpSync(path.join(ROOT, `packages/broker/src/aws/${name}`), path.join(root, `packages/broker/src/aws/${name}`), { recursive: true });
    }
    return root;
  };

  it("says so and changes nothing", () => {
    const root = copyOfCurrentTree();
    const before = filesUnder(root);
    const result = run(root);
    expect(result.code).toBe(0);
    expect(result.output.match(/already split: nothing left to move/g)).toHaveLength(2);
    expect(filesUnder(root)).toEqual(before);
  });

  it("refuses, and overwrites no module, when the thin file has gained a declaration beside the router (it used to rewrite common.ts to one line and exit 0)", () => {
    const root = copyOfCurrentTree();
    const thin = path.join(root, "packages/broker/src/aws/developer-tasks.ts");
    writeFileSync(thin, `${readFileSync(thin, "utf8")}\nexport function newLaneHelper() { return 1; }\n`);
    const before = filesUnder(root);
    const result = run(root);
    expect(result.code).toBe(1);
    expect(result.output).toContain("REFUSED");
    expect(result.output).toContain("newLaneHelper");
    expect(filesUnder(root)).toEqual(before);
  });

  it("writes no module file over an existing one without --force, even when called as a library", () => {
    const root = scratch();
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src/big.ts"), BIG);
    const config: SplitConfig = { source: "src/big.ts", outDir: "src/big", modules: { first: ["one", "two"], second: ["hidden", "three"] }, stay: ["route"], fallbackModule: "common", preserveImportOrder: true, strict: true };
    const plan = planSplit(root, config);
    mkdirSync(path.join(root, "src/big"), { recursive: true });
    writeFileSync(path.join(root, "src/big/first.ts"), "// real module\n");
    expect(() => writePlan(root, plan)).toThrow(/refusing to overwrite/);
    expect(readFileSync(path.join(root, "src/big/first.ts"), "utf8")).toBe("// real module\n");
    expect(readFileSync(path.join(root, "src/big.ts"), "utf8")).toBe(BIG);
  });
});

describe("a run over several files", () => {
  it("writes none of them when one has an error", () => {
    const root = scratch();
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src/big.ts"), BIG);
    writeFileSync(path.join(root, "src/bad.ts"), BAD);
    writeFileSync(path.join(root, "config.ts"), CONFIG);
    const before = filesUnder(root);
    const result = run(root, "--config", path.join(root, "config.ts"));
    expect(result.code).toBe(1);
    expect(result.output).toContain("uses a declaration that stays");
    expect(filesUnder(root)).toEqual(before);
    expect(existsSync(path.join(root, "src/big"))).toBe(false);
  });

  it("writes every file when none has an error, keeps the comments of the import lines, and is a pure move", () => {
    const root = scratch();
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src/big.ts"), BIG);
    writeFileSync(path.join(root, "config.ts"), CONFIG.replace(/\n {2}bad: \{[^\n]*\n/, "\n"));
    const result = run(root, "--config", path.join(root, "config.ts"));
    expect(result.code).toBe(0);
    const thin = readFileSync(path.join(root, "src/big.ts"), "utf8");
    expect(thin).toContain("// header of the big file");
    // The comment sits on the import in the thin file (the bare import that keeps the load order) and on the import in the module that uses it.
    expect(thin).toMatch(/\/\/ Lane A G1: this import has no setter, and that is on purpose\.\nimport "\.\/other\.js";/);
    const first = readFileSync(path.join(root, "src/big/first.ts"), "utf8");
    expect(first).toMatch(/\/\/ Lane A G1: this import has no setter, and that is on purpose\.\nimport \{ other \} from "\.\.\/other\.js";/);
    // The statements are the original text, in the original order, with only an `export` added where another module needs the declaration.
    expect(first).toContain("export function one() { return dependency(); }");
    expect(first).toContain("export function two() { return one() + other(); }");
    expect(readFileSync(path.join(root, "src/big/second.ts"), "utf8")).toContain("const hidden = 3;");
    expect(thin).toContain('export { one, two } from "./big/first.js";');
    expect(thin).toContain("export function route() { return one() + two() + three(); }");
    // And a second run changes nothing.
    const after = filesUnder(root);
    expect(run(root, "--config", path.join(root, "config.ts")).output).toContain("already split");
    expect(filesUnder(root)).toEqual(after);
  });
});

describe("placement", () => {
  const config: SplitConfig = { source: "src/big.ts", outDir: "src/big", modules: { first: ["one", "two"] }, stay: ["route"], fallbackModule: "common", preserveImportOrder: true, strict: true };
  const rootWithBig = (): string => {
    const root = scratch();
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src/big.ts"), BIG);
    return root;
  };

  it("a strict config refuses a name in no list instead of placing it by use, and says where it would have gone", () => {
    const plan = planSplit(rootWithBig(), config);
    const errors = plan.problems.filter((problem) => problem.severity === "error").map((problem) => problem.message);
    expect(errors.join("\n")).toContain("three");
    expect(errors.join("\n")).toContain("is in no list");
    // --allow-placement reports the same names without failing
    expect(planSplit(rootWithBig(), config, { allowPlacement: true }).problems.filter((problem) => problem.severity === "error")).toEqual([]);
  });

  it("a config that is not strict places the name by use, as before", () => {
    const plan = planSplit(rootWithBig(), { ...config, strict: false });
    expect(plan.problems.filter((problem) => problem.severity === "error")).toEqual([]);
    expect(plan.placedByAffinity.length).toBeGreaterThan(0);
  });
});

describe("the shared and the private config", () => {
  it("the overlay only adds: every name the shared config lists stays in the module it is listed under", () => {
    const overlay: ConfigOverlay = { modules: { common: ["extra"], "private-module": ["secret"] }, stay: ["alsoStays"], moduleOrder: ["private-module", ...Object.keys(SHARED["tasks"]?.modules ?? {})] };
    const shared = SHARED["tasks"] as SplitConfig;
    const merged = mergeConfig(shared, overlay);
    for (const [moduleName, names] of Object.entries(shared.modules)) expect(merged.modules[moduleName]).toEqual(expect.arrayContaining([...names]));
    expect(merged.modules["common"]).toEqual(expect.arrayContaining(["extra"]));
    expect(merged.modules["private-module"]).toEqual(["secret"]);
    expect(Object.keys(merged.modules)[0]).toBe("private-module");
    expect(merged.stay).toEqual([...shared.stay, "alsoStays"]);
    expect(mergeConfig(shared, undefined)).toBe(shared);
  });

  it("a name listed under two modules, or under a module and stay, is an error", () => {
    const root = scratch();
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src/big.ts"), BIG);
    const plan = planSplit(root, { source: "src/big.ts", outDir: "src/big", modules: { first: ["one", "two", "hidden", "three"], second: ["one"] }, stay: ["route", "three"], fallbackModule: "common", preserveImportOrder: true, strict: true });
    expect(plan.problems.map((problem) => problem.message).join("\n")).toMatch(/listed in both|listed under stay/);
  });

  it("the shared config is strict, so a name is never placed by use: the same name lands in the same file in every repository that carries it", () => {
    // That the public and the private manifests agree is the manifest diff (scripts/split/compare-manifests.ts); it relies on this.
    for (const config of Object.values(SHARED)) expect(config.strict).toBe(true);
  });

  it("compareManifests finds a shared name that lands in another file, and ignores names only the private side has", () => {
    const shared = { tasks: { a: "x/one.ts", b: "x/two.ts", gone: "x/three.ts" } };
    const privateSide = { tasks: { a: "x/one.ts", b: "x/other.ts", onlyPrivate: "x/four.ts" } };
    const result = compareManifests(shared, privateSide);
    expect(result.compared).toBe(2);
    expect(result.differing).toEqual(["tasks: b is in x/two.ts here and x/other.ts there"]);
    expect(result.absent).toEqual(["tasks: gone"]);
  });
});

describe("sorting", () => {
  it("compares by code unit, so the bytes of a generated import list do not depend on the locale or ICU", () => {
    expect(compareText("Z", "a")).toBeLessThan(0);
    expect(compareText("a", "Z")).toBeGreaterThan(0);
    expect(compareText("same", "same")).toBe(0);
    expect(["b", "A", "a", "B"].sort(compareText)).toEqual(["A", "B", "a", "b"]);
  });
});
