// Slice 4, lane W2: property and fuzz tests of the zip judge, the unpacker and the store. The generators are seeded (tests/support/hostile-zips.ts: a failure names its seed; FN_FUZZ_SEED and FN_FUZZ_CASES replay or widen a run).
// Properties: whatever the archive, the judge never throws anything but a FunctionCodeError, nothing is ever written outside the target, a refused archive leaves nothing, an accepted tree is safe by an independent check made on the
// real disk (only files, folders and links; fixed modes; no absolute link; every link ends inside), and a valid tree unpacks to exactly what was put in it.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FunctionCodeError } from "../../../packages/worker/src/function-runner/code-errors.js";
import { FunctionCodeStore } from "../../../packages/worker/src/function-runner/code-store.js";
import { chunksOf } from "../../../packages/worker/src/function-runner/package-stream.js";
import { inspectFunctionZip } from "../../../packages/worker/src/function-runner/zip-judge.js";
import { unpackFunctionCode } from "../../../packages/worker/src/function-runner/zip-unpack.js";
import { Rng, applyLayer, assertSafeTree, forAllSeeds, fuzzCases, hostileZip, readTree, validTree, type ModelNode } from "../../support/hostile-zips.js";
import { buildZip, linkEntry } from "../../support/zip-builder.js";

const LIMITS = { maxEntries: 200, maxExpandedBytes: 1_000_000 };
const roots: string[] = [];
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function arenaDir(): string {
  const root = mkdtempSync(join(tmpdir(), "fn-fuzz-"));
  roots.push(root);
  return root;
}

/** The arena's contents outside `work`, as text, for before/after comparison. */
function outside(arena: string): string {
  const parts: string[] = [];
  for (const [path, node] of [...readTree(arena)].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (path === "work" || path.startsWith("work/")) continue;
    parts.push(`${path}|${node.kind}|${node.kind === "file" ? createHash("sha256").update(node.content).digest("hex") : node.kind === "symlink" ? node.target : ""}`);
  }
  return parts.join("\n");
}

function plant(arena: string): void {
  writeFileSync(join(arena, "canary.txt"), "keep");
  mkdirSync(join(arena, "canary-dir"));
  writeFileSync(join(arena, "canary-dir", "inner.txt"), "keep");
  symlinkSync("canary.txt", join(arena, "outside-link"));
  mkdirSync(join(arena, "work"));
}

const comparable = (tree: Map<string, ModelNode & { mode?: number }>): string[] =>
  [...tree].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, node]) => `${path}|${node.kind}|${node.kind === "file" ? `${createHash("sha256").update(node.content).digest("hex")}|${String(node.exec)}` : node.kind === "symlink" ? node.target : ""}`);

describe("property: hostile and damaged archives", () => {
  it("never crash, never write outside the target, leave nothing when refused, and give a safe tree when accepted", async () => {
    const stats = new Map<string, { accepted: number; refused: number }>();
    const reasons = new Map<string, number>();
    await forAllSeeds(fuzzCases(700), async (rng, seed) => {
      const arena = arenaDir();
      plant(arena);
      const before = outside(arena);
      const { label, zip } = hostileZip(rng, () => validTree(rng).entries);
      const target = join(arena, "work", "task");
      const stat = stats.get(label) ?? { accepted: 0, refused: 0 };
      stats.set(label, stat);
      try {
        const result = await unpackFunctionCode(zip, target, LIMITS);
        stat.accepted += 1;
        expect(result.entries).toBeLessThanOrEqual(LIMITS.maxEntries);
        expect(result.expandedBytes).toBeLessThanOrEqual(LIMITS.maxExpandedBytes);
        assertSafeTree(target);
        expect(readTree(target).size).toBeGreaterThanOrEqual(0);
      } catch (error) {
        if (!(error instanceof FunctionCodeError)) throw new Error(`non-FunctionCodeError from "${label}" (seed ${String(seed)}): ${String(error)}`, { cause: error });
        stat.refused += 1;
        reasons.set(error.reason, (reasons.get(error.reason) ?? 0) + 1);
        expect(readdirSync(join(arena, "work"))).toEqual([]);
        expect(error.message).not.toMatch(/evil|passwd|escape|inner\.zip/u);
      }
      expect(outside(arena)).toBe(before);
      rmSync(arena, { recursive: true, force: true });
    });
    // Positive controls: the generator really produced both outcomes, and every strategy ran.
    const totals = [...stats.values()].reduce((sum, s) => ({ accepted: sum.accepted + s.accepted, refused: sum.refused + s.refused }), { accepted: 0, refused: 0 });
    expect(totals.accepted).toBeGreaterThan(0);
    expect(totals.refused).toBeGreaterThan(totals.accepted);
    expect(stats.size).toBeGreaterThanOrEqual(24);
    for (const reason of ["unsafe_entry", "unsafe_link", "corrupt", "too_large", "unsupported"]) expect(reasons.get(reason) ?? 0).toBeGreaterThan(0);
    // Strategies that are hostile every time are never accepted.
    for (const label of ["write through a link", "folder below a link", "link loop", "file and folder with one name", "overlapping entries", "CRC lie", "name lies", "zip64 locator", "inflation bomb", "huge declared sizes"]) {
      expect({ label, accepted: stats.get(label)?.accepted ?? 0 }).toEqual({ label, accepted: 0 });
    }
    console.info(`hostile zips: ${String(totals.accepted + totals.refused)} cases, ${String(totals.accepted)} accepted (all safe), ${String(totals.refused)} refused; reasons ${JSON.stringify(Object.fromEntries(reasons))}`);
  }, 300_000);

  it("keeps the judge pure and total over arbitrary bytes: only FunctionCodeError, and an accepted plan is consistent", async () => {
    let accepted = 0;
    await forAllSeeds(fuzzCases(3000), (rng) => {
      const zip = rng.bool(0.3) ? rng.bytes(rng.range(0, 600)) : hostileZip(rng, () => validTree(rng).entries).zip;
      try {
        const plan = inspectFunctionZip(zip, LIMITS);
        accepted += 1;
        const seen = new Set<string>();
        const regions: Array<[number, number]> = [];
        for (const entry of plan) {
          expect(seen.has(entry.path)).toBe(false);
          seen.add(entry.path);
          expect(entry.path.startsWith("/") || entry.path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")).toBe(false);
          expect(entry.dataEnd).toBeLessThanOrEqual(zip.length);
          expect((entry.target !== undefined) === (entry.kind === "symlink")).toBe(true);
          regions.push([entry.localOffset, entry.dataEnd]);
        }
        regions.sort((a, b) => a[0] - b[0]);
        for (let index = 1; index < regions.length; index += 1) expect(regions[index]![0]).toBeGreaterThanOrEqual(regions[index - 1]![1]);
      } catch (error) {
        if (!(error instanceof FunctionCodeError)) throw error;
      }
    });
    expect(accepted).toBeGreaterThan(0);
  }, 120_000);
});

describe("property: valid trees", () => {
  it("unpack to exactly the tree that was zipped (files, bytes, execute bits, folders, relative links), and the judge accepts every one", async () => {
    let links = 0;
    await forAllSeeds(fuzzCases(400), async (rng) => {
      const arena = arenaDir();
      const tree = validTree(rng);
      const target = join(arena, "task");
      await unpackFunctionCode(buildZip(tree.entries), target, { maxEntries: 1000, maxExpandedBytes: 50_000_000 });
      expect(comparable(readTree(target))).toEqual(comparable(tree.nodes));
      assertSafeTree(target);
      links += [...tree.nodes.values()].filter((node) => node.kind === "symlink").length;
      rmSync(arena, { recursive: true, force: true });
    });
    expect(links).toBeGreaterThan(50);
  }, 300_000);

  it("unpack as layers the way Lambda does: in order, a later layer wins, nothing is written through a link", async () => {
    await forAllSeeds(fuzzCases(250), async (rng) => {
      const arena = arenaDir();
      const target = join(arena, "opt");
      const layers = Array.from({ length: rng.range(2, 4) }, () => validTree(rng));
      const merged = new Map<string, ModelNode>();
      for (const [index, layer] of layers.entries()) {
        await unpackFunctionCode(buildZip(layer.entries), target, { maxEntries: 1000, maxExpandedBytes: 50_000_000 }, { mode: index === 0 ? "fresh" : "overlay" });
        applyLayer(merged, layer.nodes);
      }
      expect(comparable(readTree(target))).toEqual(comparable(merged));
      assertSafeTree(target);
      rmSync(arena, { recursive: true, force: true });
    });
  }, 300_000);
});

describe("property: through the store", () => {
  it("receives and materializes hostile zips without a crash, and leaves nothing after the run ends", async () => {
    const root = arenaDir();
    const store = new FunctionCodeStore({ root, maxConcurrentUnpacks: 2 });
    await store.sweepStale();
    let materialized = 0;
    await forAllSeeds(fuzzCases(250), async (rng, seed) => {
      const run = await store.openRun(`fuzz-${String(seed)}`);
      const zips = [hostileZip(rng, () => validTree(rng).entries).zip, validTree(rng, 6) && buildZip(validTree(rng).entries)];
      const stored: string[] = [];
      for (const [index, zip] of zips.entries()) {
        const sha256 = createHash("sha256").update(zip).digest("hex");
        try {
          await run.receive({ kind: index === 0 ? "function" : "layer", sha256, sizeBytes: zip.length }, chunksOf(zip, rng.range(1, 5000)));
          stored.push(sha256);
        } catch (error) {
          if (!(error instanceof FunctionCodeError)) throw error;
        }
      }
      try {
        if (stored.length > 0) {
          const code = await run.materialize("k", { packageSha256: stored[0]!, layerSha256s: stored.slice(1) });
          materialized += 1;
          assertSafeTree(code.taskDir);
          assertSafeTree(code.optDir);
        }
      } catch (error) {
        if (!(error instanceof FunctionCodeError)) throw error;
        expect(readdirSync(join(root, "runs", `fuzz-${String(seed)}`, "trees"))).toEqual([]);
      }
      await run.close();
      expect(lstatSync(join(root, "runs")).isDirectory()).toBe(true);
      expect(readdirSync(join(root, "runs"))).toEqual([]);
    });
    expect(materialized).toBeGreaterThan(0);
    expect(store.usage().usedBytes).toBe(0);
  }, 300_000);
});

describe("fixed regression seeds of the hostile generator", () => {
  it("replays the generator deterministically: one seed, one zip", () => {
    const first = hostileZip(new Rng(7), () => validTree(new Rng(8)).entries);
    const second = hostileZip(new Rng(7), () => validTree(new Rng(8)).entries);
    expect(first.zip.equals(second.zip)).toBe(true);
    expect(first.label).toBe(second.label);
  });
  it("catches the classic escape: a link through a link, lexically inside and really outside", async () => {
    const arena = arenaDir();
    plant(arena);
    const zip = buildZip([linkEntry("a/b/d", "../.."), linkEntry("x", "a/b/d/..")]);
    await expect(unpackFunctionCode(zip, join(arena, "work", "task"), LIMITS)).rejects.toMatchObject({ reason: "unsafe_link" });
    expect(readFileSync(join(arena, "canary.txt"), "utf8")).toBe("keep");
  });
});
