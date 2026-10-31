// scripts/split/split-broker.ts moves the declarations of packages/broker/src/aws/broker.ts into modules. These tests pin how the script behaves on a small file of the same shape:
// the thin file loads everything in the old order, a dry run refuses whenever a real run would, a second run does nothing, a stale folder is not overwritten, and the moves that would
// change behaviour (a constant read across an import cycle, shared mutable state, a statement that is not a declaration) are refused. That the real split is a pure move is proved by
// verify-moved.ts, broker-exports.ts, check-load-order.ts, tsc and the broker's tests; this file is about the script.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareOrders, loadOrder } from "../../scripts/split/check-load-order.ts";
import { CONFIGS as SHARED } from "../../scripts/split/broker-config.ts";
import { mergeConfig, type ConfigOverlay } from "../../scripts/split/split-broker.ts";

const ROOT = path.join(import.meta.dirname, "../..");
const SCRIPT = path.join(ROOT, "scripts/split/split-broker.ts");
const created: string[] = [];
afterEach(() => { for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const CONFIG = (modules: string, extra = "") => `export const CONFIGS = { broker: {
  source: "src/big.ts", outDir: "src/big", marker: "split-by: test", headerPrefix: "Part of big:", maxLines: 1500, keepFrom: "handler",
  modules: [${modules}], overrides: {}, testsListingSourceFiles: [], testHelper: "tests/support/broker-source.ts", ${extra}
} };\n`;
const TWO = `{ name: "first", from: "LIMIT", description: "the first." }, { name: "second", from: "hidden", description: "the second." }`;

const BIG = `// header of the big file
import { dependency } from "./dependency.js";
// Registers a mover; it must load before the next one.
import "./registers.js";
import { other } from "./other.js";
import type { Shape } from "./shape.js";

export const LIMIT = 3;
export function one(): number { return dependency() + LIMIT; }
export function two(): number { return one() + other(); }
function hidden(): number { return 3; }
export function three(shape?: Shape): number { return hidden() + (shape === undefined ? 0 : 1); }
export const handler = (): number => one() + two() + three();
`;

function scratch(source: string, config = CONFIG(TWO), more: Record<string, string> = {}): { root: string; config: string } {
  const root = mkdtempSync(path.join(tmpdir(), "split-broker-"));
  created.push(root);
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src/big.ts"), source);
  for (const name of ["dependency", "other", "registers", "shape"]) writeFileSync(path.join(root, `src/${name}.ts`), name === "shape" ? "export interface Shape { a: number }\n" : name === "registers" ? "export {};\n" : `export const ${name} = () => 1;\n`);
  for (const [file, text] of Object.entries(more)) writeFileSync(path.join(root, file), text);
  const configFile = path.join(root, "config.ts");
  writeFileSync(configFile, config);
  return { root, config: configFile };
}
const run = (root: string, configFile: string, ...args: string[]) => {
  const result = spawnSync(process.execPath, [SCRIPT, "--root", root, "--config", configFile, ...args], { encoding: "utf8" });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
};
const read = (root: string, file: string): string => readFileSync(path.join(root, file), "utf8");

describe("the thin file keeps the load order", () => {
  it("imports every original import bare, first, in the old order, with the comment that sat on it", () => {
    const { root, config } = scratch(BIG);
    expect(run(root, config).code).toBe(0);
    const thin = read(root, "src/big.ts");
    const bare = [...thin.matchAll(/^import "([^"]+)";$/gm)].map((match) => match[1]);
    expect(bare).toEqual(["./dependency.js", "./registers.js", "./other.js"]); // the type-only import loads nothing, so it is not repeated
    expect(thin).toContain("// Registers a mover; it must load before the next one.\nimport \"./registers.js\";");
    expect(thin.indexOf('import "./other.js";')).toBeLessThan(thin.indexOf('from "./big/first.js"'));
    expect(thin).toContain("export { LIMIT, one, two } from \"./big/first.js\";");
    expect(read(root, "src/big/first.ts")).toContain("export function two(): number { return one() + other(); }");
  });

  it("loads the same files in the same order before and after (check-load-order)", () => {
    const before = scratch(BIG);
    const after = scratch(BIG);
    expect(run(after.root, after.config).code).toBe(0);
    const unsplit = loadOrder(before.root, "src/big.ts");
    const split = loadOrder(after.root, "src/big.ts");
    expect(unsplit.at(-1)).toBe("src/big.ts");
    expect(compareOrders(unsplit, split, "src/big/")).toEqual([]);
    expect(split.some((file) => file.startsWith("src/big/"))).toBe(true);
  });

  it("notices when two files swap places", () => {
    const problems = compareOrders(["a.ts", "b.ts", "c.ts"], ["a.ts", "c.ts", "b.ts"], "x/");
    expect(problems.join("\n")).toMatch(/order differs from position 1/);
    expect(compareOrders(["a.ts", "b.ts"], ["x/new.ts", "a.ts", "b.ts"], "x/")).toEqual([]);
  });
});

describe("a dry run predicts the real run", () => {
  it("exits 0 and writes nothing when the split applies", () => {
    const { root, config } = scratch(BIG);
    const result = run(root, config, "--dry-run");
    expect(result.code).toBe(0);
    expect(result.output).toContain("would apply cleanly");
    expect(existsSync(path.join(root, "src/big"))).toBe(false);
    expect(read(root, "src/big.ts")).toBe(BIG);
  });

  it("exits 2 when an anchor is missing, exactly as the real run does, and writes nothing", () => {
    const { root, config } = scratch(BIG, CONFIG(`${TWO}, { name: "third", from: "notThere", description: "x." }`));
    const dry = run(root, config, "--dry-run");
    expect(dry.code).toBe(2);
    expect(dry.output).toContain("ANCHOR MISSING");
    expect(dry.output).toContain("would be refused");
    const real = run(root, config);
    expect(real.code).toBe(2);
    expect(existsSync(path.join(root, "src/big"))).toBe(false);
    expect(read(root, "src/big.ts")).toBe(BIG);
  });

  it("exits 2 for a missing override symbol and for a folder that already has files", () => {
    const { root, config } = scratch(BIG, CONFIG(TWO).replace("overrides: {}", 'overrides: { gone: "first" }'));
    expect(run(root, config, "--dry-run").code).toBe(2);
    const second = scratch(BIG);
    mkdirSync(path.join(second.root, "src/big"), { recursive: true });
    writeFileSync(path.join(second.root, "src/big/old.ts"), "export const old = 1;\n");
    const result = run(second.root, second.config, "--dry-run");
    expect(result.code).toBe(2);
    expect(result.output).toContain("already has files");
  });
});

describe("a second run, a stale folder and --force", () => {
  it("says it is already split and changes nothing; --check agrees", () => {
    const { root, config } = scratch(BIG);
    expect(run(root, config).code).toBe(0);
    const split = read(root, "src/big.ts");
    const again = run(root, config);
    expect(again.code).toBe(0);
    expect(again.output).toContain("already split");
    expect(read(root, "src/big.ts")).toBe(split);
    expect(run(root, config, "--check").code).toBe(0);
    rmSync(path.join(root, "src/big/second.ts"));
    expect(run(root, config, "--check").code).toBe(2);
  });

  it("--check is 1 on an unsplit tree, and a folder with files stops a run without the marker", () => {
    const { root, config } = scratch(BIG);
    expect(run(root, config, "--check").code).toBe(1);
    mkdirSync(path.join(root, "src/big"), { recursive: true });
    writeFileSync(path.join(root, "src/big/stale.ts"), "export const stale = 1;\n");
    const refused = run(root, config);
    expect(refused.code).toBe(2);
    expect(read(root, "src/big.ts")).toBe(BIG);
    const forced = run(root, config, "--force");
    expect(forced.code).toBe(0);
    expect(existsSync(path.join(root, "src/big/stale.ts"))).toBe(false); // no module file of an older run is left behind
    expect(existsSync(path.join(root, "src/big/first.ts"))).toBe(true);
  });

  it("writes the placement manifest only where --manifest says, in the split-developer shape", () => {
    const { root, config } = scratch(BIG);
    const manifest = path.join(root, "manifest.json");
    expect(run(root, config, "--dry-run", "--manifest", manifest).code).toBe(0);
    const written = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, Record<string, string>>;
    expect(written["src/big.ts"]).toMatchObject({ LIMIT: "src/big/first.ts", hidden: "src/big/second.ts", handler: "src/big.ts" });
    expect(existsSync(path.join(root, "scripts"))).toBe(false);
  });
});

describe("moves that would change behaviour are refused", () => {
  const CYCLE = (tail: string) => `export const X = 1;
export function fa(): number { return fb(); }
export const Y = ${tail};
export function fb(): number { return fa(); }
export const handler = (): number => fa() + Y;
`;
  const CYCLE_CONFIG = CONFIG(`{ name: "a", from: "X", description: "a." }, { name: "b", from: "Y", description: "b." }`);

  it("a constant that reads a constant of a module it is in an import cycle with", () => {
    const { root, config } = scratch(CYCLE("X + 1"), CYCLE_CONFIG);
    const result = run(root, config, "--dry-run");
    expect(result.code).toBe(2);
    expect(result.output).toMatch(/reads X .* when the module loads/);
  });

  const ab = (a: string, b: string) => CONFIG(`{ name: "a", from: "${a}", description: "a." }, { name: "b", from: "${b}", description: "b." }`);
  const handlerLine = "export const handler = (): number => fa() + fb();\n";

  it("a static class field, an enum member, and a call of a function that reads a constant, all while the module loads", () => {
    const klass = scratch(`export const X = 1;\nexport function fa(): number { return fb(); }\nexport class K { static v = X + 1; }\nexport function fb(): number { return fa(); }\n${handlerLine}`, ab("X", "K"));
    expect(run(klass.root, klass.config, "--dry-run").output).toMatch(/reads X .* when the module loads/);
    const member = scratch(`export const X = 1;\nexport function fa(): number { return fb(); }\nexport enum E { A = X + 1 }\nexport function fb(): number { return fa(); }\n${handlerLine}`, ab("X", "E"));
    expect(run(member.root, member.config, "--dry-run").output).toMatch(/reads X .* when the module loads/);
    const call = scratch(`export function fa(): number { return fb(); }\nexport function reader(): number { return X; }\nexport const X = 1;\nexport const Y = reader();\nexport function fb(): number { return fa() + Y; }\n${handlerLine}`, ab("fa", "X"));
    const outcome = run(call.root, call.config, "--dry-run");
    expect(outcome.code).toBe(2);
    expect(outcome.output).toMatch(/calls reader when the module loads, and reader reads X/);
  });

  it("a constant that reads another module's constant is fine when the modules are not in a cycle", () => {
    const { root, config } = scratch(`export const X = 1;\nexport const Y = X + 1;\nexport const handler = (): number => Y;\n`, CYCLE_CONFIG);
    expect(run(root, config, "--dry-run").code).toBe(0);
  });

  it("mutable module state used from another module", () => {
    const source = `export let counter = 0;\nexport function bump(): void { counter += 1; }\nexport function read(): number { return counter; }\nexport const handler = (): number => read();\n`;
    const { root, config } = scratch(source, CONFIG(`{ name: "a", from: "counter", description: "a." }, { name: "b", from: "read", description: "b." }`));
    const result = run(root, config, "--dry-run");
    expect(result.code).toBe(2);
    expect(result.output).toContain("mutable module state");
  });

  it("a top-level statement that is not a declaration, unless it is in the part that stays", () => {
    const before = scratch(`export const LIMIT = 3;\nregister(LIMIT);\nfunction register(_n: number): void {}\nexport const handler = (): number => LIMIT;\n`, CONFIG(`{ name: "first", from: "LIMIT", description: "x." }`));
    const refused = run(before.root, before.config, "--dry-run");
    expect(refused.code).toBe(2);
    expect(refused.output).toContain("is not a declaration");
    const after = scratch(`export const LIMIT = 3;\nexport const handler = (): number => LIMIT;\nregister(LIMIT);\nfunction register(_n: number): void {}\n`, CONFIG(`{ name: "first", from: "LIMIT", description: "x." }`));
    expect(run(after.root, after.config, "--dry-run").code).toBe(0);
  });

  it("a declaration that stays in the thin file but a module needs", () => {
    const { root, config } = scratch(`export const LIMIT = 3;\nexport function one(): number { return LIMIT + singleton; }\nconst singleton = 2;\nexport const handler = (): number => one();\n`, CONFIG(`{ name: "first", from: "LIMIT", description: "x." }`, "").replace('keepFrom: "handler"', 'keepFrom: "singleton"'));
    const result = run(root, config, "--dry-run");
    expect(result.code).toBe(2);
    expect(result.output).toContain("stays in the source file");
  });
});

describe("the shared and the private config", () => {
  it("the overlay adds modules and overrides, names a module once, and sets the order", () => {
    const shared = SHARED["broker"]!;
    const overlay: ConfigOverlay = { modules: [{ name: "extra", from: "cloudOnly", description: "x." }], overrides: { cloudSymbol: "extra" }, moduleOrder: ["extra", ...shared.modules.map((module) => module.name)] };
    const merged = mergeConfig(shared, overlay);
    expect(merged.modules.map((module) => module.name)[0]).toBe("extra");
    expect(merged.modules).toHaveLength(shared.modules.length + 1);
    expect(merged.overrides).toMatchObject({ cloudSymbol: "extra", awsClientConfiguration: "runtime-clients" });
    expect(() => mergeConfig(shared, { modules: [{ name: "definitions", description: "again" }] })).toThrow(/redefines/);
    expect(() => mergeConfig(shared, { modules: [{ name: "extra", from: "z", description: "x" }], moduleOrder: ["extra"] })).toThrow(/moduleOrder lacks/);
  });

  it("the shared config names no declaration that only Rovara Cloud has: every anchor of the overlay is absent from it", () => {
    const sharedAnchors = new Set(SHARED["broker"]!.modules.flatMap((module) => (module.from === undefined ? [] : [module.from])));
    const overlayFile = path.join(ROOT, "scripts/split/broker-config.private.ts");
    if (!existsSync(overlayFile)) return; // the public repository has no overlay
    const text = readFileSync(overlayFile, "utf8");
    for (const anchor of sharedAnchors) expect(text, anchor).not.toContain(`from: "${anchor}"`);
  });
});
