// Slice 4, lane W2: the fixes from the Opus review of 9507ec555. H1 (layers that are safe alone and escape together), M1 (the link resolver's CPU), M2 (what directories and empty files cost the budget),
// M3 (the swap's overwrite check and the no-follow writer), and the lows (RECORD completeness, Runtime-given Python, linux_aarch64, yanked files, failed removals, open/close races, `..data`, short writes,
// archives inside archives, the raw path of a node action). The three probes of the review are tests here: H1 is probe1, M1 is probe2, M2 is probe3.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { FunctionCodeError, type FunctionCodeProblem } from "../../../packages/worker/src/function-runner/code-errors.js";
import { ENTRY_OVERHEAD_BYTES, FunctionCodeStore, type RunCode } from "../../../packages/worker/src/function-runner/code-store.js";
import { LinkTree } from "../../../packages/worker/src/function-runner/link-tree.js";
import { swapToArm64, pythonOfRuntime } from "../../../packages/worker/src/function-runner/arm64-swap.js";
import { classifyNative, type PackageFileInput } from "../../../packages/worker/src/function-runner/native-classify.js";
import { planNodeAddons } from "../../../packages/worker/src/function-runner/node-addon-plan.js";
import { removeBeneath, writeBeneath, writeFully } from "../../../packages/worker/src/function-runner/no-follow-write.js";
import { chunksOf } from "../../../packages/worker/src/function-runner/package-stream.js";
import { FakeWheelIndex } from "../../../packages/worker/src/function-runner/wheel-index.js";
import { parseWheelFilename, wheelFit } from "../../../packages/worker/src/function-runner/wheel-meta.js";
import { inspectFunctionZip } from "../../../packages/worker/src/function-runner/zip-judge.js";
import { unpackFunctionCode } from "../../../packages/worker/src/function-runner/zip-unpack.js";
import { ARM, X86, file, installed, wheel, zip as plainZip } from "../../support/x86-package-fixtures.js";
import { buildZip, linkEntry } from "../../support/zip-builder.js";

const roots: string[] = [];
const restore: string[] = [];
function rootDir(): string {
  const root = mkdtempSync(join(tmpdir(), "fn-review-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const path of restore.splice(0)) { try { chmodSync(path, 0o755); } catch { /* gone */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sha = (zip: Uint8Array): string => createHash("sha256").update(zip).digest("hex");
async function reason(promise: Promise<unknown>): Promise<FunctionCodeProblem | "ok"> {
  try { await promise; return "ok"; } catch (error) { if (!(error instanceof FunctionCodeError)) throw error; return error.reason; }
}
async function setup(options: Partial<ConstructorParameters<typeof FunctionCodeStore>[0]> = {}): Promise<{ root: string; store: FunctionCodeStore; run: RunCode }> {
  const root = rootDir();
  const store = new FunctionCodeStore({ root, ...options });
  await store.sweepStale();
  return { root, store, run: await store.openRun("run-1") };
}
async function give(run: RunCode, zip: Buffer, kind: "function" | "layer"): Promise<void> {
  await run.receive({ kind, sha256: sha(zip), sizeBytes: zip.length }, chunksOf(zip));
}
const LIMITS = { maxEntries: 60_000, maxExpandedBytes: 250 * 1024 * 1024 };

describe("H1: layers that are safe alone and escape together (probe1)", () => {
  const N = 12;
  const deep = Array.from({ length: N }, (_, i) => `p${String(i)}`).join("/");
  // layer 1: deep/d -> ../ x12 (back to the /opt root: legal alone). layer 2: deep/e -> d/ then 13 x .. then etc/passwd: with d unknown it stays inside; with d in place it climbs out.
  const fn = buildZip([{ name: "h.py", data: "x" }]);
  const layerOne = buildZip([{ name: `${deep}/`, data: "", method: 0, mode: 0o040755 }, linkEntry(`${deep}/d`, Array(N).fill("..").join("/"))]);
  const layerTwo = buildZip([{ name: `${deep}/`, data: "", method: 0, mode: 0o040755 }, linkEntry(`${deep}/e`, `d/${Array(N + 1).fill("..").join("/")}/etc/passwd`)]);

  it("each layer alone is accepted (a positive control: the escape needs both)", async () => {
    const { run } = await setup();
    for (const [name, layer] of [["one", layerOne], ["two", layerTwo]] as const) {
      await give(run, fn, "function");
      await give(run, layer, "layer");
      expect(await reason(run.materialize(name, { packageSha256: sha(fn), layerSha256s: [sha(layer)] }))).toBe("ok");
    }
  });

  it("refuses the two together, in either order, before anything is written, and leaves no tree", async () => {
    const { root, run } = await setup();
    for (const zip of [fn, layerOne, layerTwo]) await give(run, zip, zip === fn ? "function" : "layer");
    expect(await reason(run.materialize("ab", { packageSha256: sha(fn), layerSha256s: [sha(layerOne), sha(layerTwo)] }))).toBe("unsafe_link");
    expect(await reason(run.materialize("ba", { packageSha256: sha(fn), layerSha256s: [sha(layerTwo), sha(layerOne)] }))).toBe("unsafe_link");
    expect(readdirSync(join(root, "runs", "run-1", "trees"))).toEqual([]);
    expect(run.usedBytes()).toBe(fn.length + layerOne.length + layerTwo.length);
  });

  it("is caught by the planned check alone: the merged plans of the layers resolve outside /opt", () => {
    const alone = (zip: Buffer): LinkTree => LinkTree.fromPlan(inspectFunctionZip(zip, LIMITS));
    expect(() => alone(layerOne).checkLinks()).not.toThrow();
    expect(() => alone(layerTwo).checkLinks()).not.toThrow();
    const merged = new LinkTree();
    merged.applyPlan(inspectFunctionZip(layerOne, LIMITS));
    merged.applyPlan(inspectFunctionZip(layerTwo, LIMITS));
    expect(() => merged.checkLinks()).toThrow(expect.objectContaining({ reason: "unsafe_link" }));
  });

  it("leaves a link dead and harmless when a later layer turns a folder it went through into a file, but still refuses a single zip that does so", () => {
    const first = inspectFunctionZip(buildZip([{ name: "b/", data: "", method: 0, mode: 0o040755 }, { name: "b/bin", data: "x" }, linkEntry("c", "b/bin")]), LIMITS);
    const second = inspectFunctionZip(buildZip([{ name: "b", data: "now a file" }]), LIMITS);
    const merged = new LinkTree();
    merged.applyPlan(first);
    merged.applyPlan(second);
    expect(() => merged.checkLinks({ strict: false })).not.toThrow();
    expect(() => merged.checkLinks()).toThrow(FunctionCodeError);
    expect(() => inspectFunctionZip(buildZip([{ name: "f", data: "x" }, linkEntry("c", "f/g")]), LIMITS)).toThrow(FunctionCodeError);
  });

  it("is caught on the real folder too, even when the planned check is skipped (the overlay reads the disk back)", async () => {
    const root = rootDir();
    const opt = join(root, "opt");
    await unpackFunctionCode(layerOne, opt, LIMITS);
    // No plan carried forward here: layer two alone is judged fine, and the disk check after the overlay is what refuses it.
    await expect(unpackFunctionCode(layerTwo, opt, LIMITS, { mode: "overlay" })).rejects.toMatchObject({ reason: "unsafe_link" });
    // The refusal is about the finished folder, found with readlink alone: this is the resolution the operating system would do, and it ends outside.
    const tree = await LinkTree.fromDisk(opt);
    expect(() => tree.checkLinks()).toThrow(FunctionCodeError);
  });

  it("follows a link through a folder a later layer turned into a link", async () => {
    const root = rootDir();
    const opt = join(root, "opt");
    // layer 1: a/b/l -> ../../x (inside: a/b is two deep). layer 2 replaces folder a with a link to "." so a/b/l is gone: fine. A second shape: layer 2 replaces folder b's parent chain so l's ".." climbs.
    await unpackFunctionCode(buildZip([{ name: "a/b/", data: "", method: 0, mode: 0o040755 }, { name: "x", data: "1" }, linkEntry("a/b/l", "../../x"), linkEntry("link-to-b", "a/b")]), opt, LIMITS);
    await unpackFunctionCode(buildZip([linkEntry("a", ".")]), opt, LIMITS, { mode: "overlay" });
    expect(lstatSync(join(opt, "a")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(opt, "a", "b"))).toBe(false);
  });
});

describe("M1: the link resolver's cost (probe2)", () => {
  it("refuses 3,000 links that each walk a 512-deep link 40 times in well under a second (it took 4.4 s)", () => {
    const entries = [linkEntry("L", Array(512).fill("x").join("/"))];
    const many = Array(40).fill("L").join("/");
    for (let i = 0; i < 3000; i += 1) entries.push(linkEntry(`m${String(i)}`, many, { method: 8 }));
    const zip = buildZip(entries);
    const started = Date.now();
    let outcome = "accepted";
    try { inspectFunctionZip(zip, LIMITS); } catch (error) { outcome = (error as FunctionCodeError).reason; }
    expect(outcome).toBe("unsafe_link");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("accepts 30,000 ordinary links quickly, and 5,000 links through a shared link (memoised)", () => {
    const plain = [{ name: "d/", data: "", method: 0 as const, mode: 0o040755 }, { name: "d/f", data: "x" }];
    for (let i = 0; i < 30_000; i += 1) plain.push(linkEntry(`ln${String(i)}`, "d/f", { method: 0 }) as never);
    let started = Date.now();
    expect(() => inspectFunctionZip(buildZip(plain), LIMITS)).not.toThrow();
    expect(Date.now() - started).toBeLessThan(5000);
    const shared = [{ name: "d/", data: "", method: 0 as const, mode: 0o040755 }, linkEntry("h", "d")];
    for (let i = 0; i < 5000; i += 1) shared.push(linkEntry(`x${String(i)}`, "h/h/h/h/h/h/h/h", { method: 0 }));
    started = Date.now();
    expect(() => inspectFunctionZip(buildZip(shared), LIMITS)).not.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("ends a chain of links longer than the hop limit and a very deep resolved path in a refusal", () => {
    const chain = Array.from({ length: 60 }, (_, i) => linkEntry(`c${String(i)}`, `c${String(i + 1)}`));
    expect(() => inspectFunctionZip(buildZip(chain), LIMITS)).toThrow(FunctionCodeError);
    const deep = [linkEntry("deep", Array(150).fill("s").join("/"))];
    expect(() => inspectFunctionZip(buildZip(deep), LIMITS)).toThrow(FunctionCodeError);
  });

  it("unpacks with the plan the judge made when the zip arrived, without judging again", async () => {
    const good = buildZip([{ name: "a.txt", data: "hello" }]);
    const plan = inspectFunctionZip(good, LIMITS);
    // Trailing bytes make the judge refuse this copy; the offsets in the plan are still right, so only an unpack that skips the judge succeeds.
    const damaged = Buffer.concat([good, Buffer.from("junk")]);
    const root = rootDir();
    await expect(unpackFunctionCode(damaged, join(root, "judged"), LIMITS)).rejects.toMatchObject({ reason: "corrupt" });
    await unpackFunctionCode(damaged, join(root, "planned"), LIMITS, { plan });
    expect(readFileSync(join(root, "planned", "a.txt"), "utf8")).toBe("hello");
  });
});

describe("M2: folders, empty files and links cost the budget (probe3)", () => {
  const dirs = (count: number): Buffer => buildZip(Array.from({ length: count }, (_, i) => ({ name: `d${String(i)}/`, data: "", method: 0 as const, mode: 0o040755 })));

  it("charges 4 KiB for each entry, reserved before the unpack and kept after it", async () => {
    const { run } = await setup();
    const zip = dirs(2000);
    await give(run, zip, "function");
    const before = run.usedBytes();
    expect(before).toBe(zip.length);
    for (let k = 0; k < 3; k += 1) await run.materialize(`k${String(k)}`, { packageSha256: sha(zip), layerSha256s: [] });
    expect(run.usedBytes()).toBe(before + 3 * 2000 * ENTRY_OVERHEAD_BYTES);
    await run.discard("k0");
    expect(run.usedBytes()).toBe(before + 2 * 2000 * ENTRY_OVERHEAD_BYTES);
  });

  it("refuses a tree that does not fit the run's budget before writing any of it, and one past the entry cap", async () => {
    const zip = dirs(2000);
    const small = await setup({ maxRunBytes: zip.length + 1000 * ENTRY_OVERHEAD_BYTES });
    await give(small.run, zip, "function");
    expect(await reason(small.run.materialize("k", { packageSha256: sha(zip), layerSha256s: [] }))).toBe("budget");
    expect(readdirSync(join(small.root, "runs", "run-1", "trees"))).toEqual([]);
    const capped = await setup({ maxTreeEntriesPerRun: 3000 });
    await give(capped.run, zip, "function");
    expect(await reason(capped.run.materialize("one", { packageSha256: sha(zip), layerSha256s: [] }))).toBe("ok");
    expect(await reason(capped.run.materialize("two", { packageSha256: sha(zip), layerSha256s: [] }))).toBe("budget");
    await capped.run.discard("one");
    expect(await reason(capped.run.materialize("three", { packageSha256: sha(zip), layerSha256s: [] }))).toBe("ok");
  });

  it("caps the plans a run keeps for the zips it received", async () => {
    const { run } = await setup({ maxStoredEntriesPerRun: 2500 });
    const first = dirs(2000);
    const second = buildZip(Array.from({ length: 2000 }, (_, i) => ({ name: `e${String(i)}/`, data: "", method: 0 as const, mode: 0o040755 })));
    await give(run, first, "function");
    expect(await reason(run.receive({ kind: "layer", sha256: sha(second), sizeBytes: second.length }, chunksOf(second)))).toBe("budget");
    await run.dropPackage(sha(first));
    expect(await reason(run.receive({ kind: "layer", sha256: sha(second), sizeBytes: second.length }, chunksOf(second)))).toBe("ok");
  });
});

describe("M3: the swap's overwrite check, and the writer that never follows a link", () => {
  const X86_TAGS = ["cp312-cp312-manylinux_2_17_x86_64"];
  const armWheel = (files: Record<string, Uint8Array | string> = {}, extra: Partial<Parameters<typeof wheel>[0]> = {}): Uint8Array => wheel({
    name: "numpy", version: "2.5.4", tags: ["cp312-cp312-manylinux_2_28_aarch64"], files: { "numpy/__init__.py": "arm", "numpy/_m.so": ARM(), ...files }, ...extra,
  });
  const pkg = (): PackageFileInput[] => installed({ name: "numpy", version: "2.5.4", tags: X86_TAGS, files: { "numpy/__init__.py": "x86", "numpy/_m.so": X86() } });
  const indexWith = (bytes: Uint8Array, name = "numpy-2.5.4-cp312-cp312-manylinux_2_28_aarch64.whl"): FakeWheelIndex => {
    const index = new FakeWheelIndex();
    index.add("numpy", name, bytes);
    return index;
  };
  const run = (files: PackageFileInput[], index: FakeWheelIndex, nonFiles?: Map<string, "dir" | "symlink" | "other">) =>
    swapToArm64(files, index, { runtime: "python3.12", ...(nonFiles === undefined ? {} : { nonFiles }) });

  it("swaps as before when nothing is in the way (a positive control for the refusals)", async () => {
    const result = await run(pkg(), indexWith(armWheel()), new Map([["numpy", "dir"], ["numpy-2.5.4.dist-info", "dir"]]));
    expect(result.reports[0]).toMatchObject({ status: "swapped" });
  });

  it("refuses an add whose path is a link or a folder, whose parent is a link, or that sits below a file", async () => {
    const cases: Array<[string, Map<string, "dir" | "symlink" | "other">, Record<string, string | Uint8Array>, string]> = [
      ["a link at the added path", new Map([["numpy/extra.py", "symlink"]]), { "numpy/extra.py": "evil" }, "would-overwrite"],
      ["a folder at the added path", new Map([["numpy/extra", "dir"]]), { "numpy/extra": "evil" }, "would-overwrite"],
      ["a link as the parent folder", new Map([["numpy/sub", "symlink"]]), { "numpy/sub/x.py": "evil" }, "path-through-link"],
      ["a link higher up", new Map([["numpy", "symlink"]]), { "numpy/extra.py": "evil" }, "path-through-link"],
      ["a special file in the way", new Map([["numpy/fifo", "other"]]), { "numpy/fifo/x.py": "evil" }, "path-through-link"],
    ];
    for (const [label, nonFiles, extraFiles, detail] of cases) {
      const result = await run(pkg(), indexWith(armWheel(extraFiles)), nonFiles);
      expect({ label, report: result.reports[0] }).toMatchObject({ label, report: { status: "unsafe", detail } });
      expect(result.edits.add).toEqual([]);
    }
    // A file of the package where the wheel needs a folder, and a folder (holding files) where the wheel puts a file.
    const underFile = pkg().concat(file("numpy/extra.py", "mine"));
    expect((await run(underFile, indexWith(armWheel({ "numpy/extra.py/deeper.py": "x" })))).reports[0]).toMatchObject({ status: "unsafe", detail: "would-overwrite" });
    const overFolder = pkg().concat(file("numpy/extra/inner.py", "mine"));
    expect((await run(overFolder, indexWith(armWheel({ "numpy/extra": "x" })))).reports[0]).toMatchObject({ status: "unsafe", detail: "would-overwrite" });
  });

  it("refuses a wheel that puts a file and a folder at one place", async () => {
    const result = await run(pkg(), indexWith(armWheel({ "numpy/clash": "file", "numpy/clash/inside.py": "dir" })));
    expect(result.reports[0]).toMatchObject({ status: "unsafe", detail: "would-overwrite" });
  });

  it("refuses to remove a file through a link", async () => {
    const result = await run(pkg(), indexWith(armWheel()), new Map([["numpy", "symlink"]]));
    expect(result.reports[0]).toMatchObject({ status: "unsafe", detail: "path-through-link" });
  });

  it("writeBeneath creates files under the root, makes folders, sets the mode, and never follows a link", async () => {
    const root = rootDir();
    const outside = rootDir();
    writeFileSync(join(outside, "canary"), "keep");
    await writeBeneath(root, "a/b/tool", Buffer.from("#!/bin/sh\n"), true);
    await writeBeneath(root, "a/b/plain", Buffer.from("x"), false);
    expect(statSync(join(root, "a", "b", "tool")).mode & 0o777).toBe(0o755);
    expect(statSync(join(root, "a", "b", "plain")).mode & 0o777).toBe(0o644);
    symlinkSync(outside, join(root, "link"));
    symlinkSync(join(outside, "canary"), join(root, "a", "b", "final-link"));
    await expect(writeBeneath(root, "link/pwned", Buffer.from("evil"), false)).rejects.toMatchObject({ reason: "unsafe_entry" });
    await expect(writeBeneath(root, "a/b/final-link", Buffer.from("evil"), false)).rejects.toBeInstanceOf(FunctionCodeError);
    await expect(writeBeneath(root, "a/b/plain", Buffer.from("again"), false)).rejects.toBeInstanceOf(FunctionCodeError);
    await expect(writeBeneath(root, "a/b/plain/under-a-file", Buffer.from("x"), false)).rejects.toMatchObject({ reason: "unsafe_entry" });
    for (const bad of ["", "/abs", "a/../../x", "a//b", "./x", "a\\b", "a\0b"]) await expect(writeBeneath(root, bad, Buffer.from("x"), false)).rejects.toMatchObject({ reason: "unsafe_entry" });
    expect(readFileSync(join(outside, "canary"), "utf8")).toBe("keep");
    expect(readdirSync(outside)).toEqual(["canary"]);
  });

  it("removeBeneath removes a file, ignores a missing one, and refuses a link or a link above", async () => {
    const root = rootDir();
    const outside = rootDir();
    writeFileSync(join(outside, "canary"), "keep");
    await writeBeneath(root, "a/f", Buffer.from("x"), false);
    await removeBeneath(root, "a/f");
    expect(existsSync(join(root, "a", "f"))).toBe(false);
    await removeBeneath(root, "a/never");
    await removeBeneath(root, "nothing/here");
    symlinkSync(outside, join(root, "link"));
    symlinkSync(join(outside, "canary"), join(root, "a", "l"));
    await expect(removeBeneath(root, "link/canary")).rejects.toMatchObject({ reason: "unsafe_entry" });
    await expect(removeBeneath(root, "a/l")).rejects.toMatchObject({ reason: "unsafe_entry" });
    expect(readFileSync(join(outside, "canary"), "utf8")).toBe("keep");
  });

  it("writeFully loops over short writes", async () => {
    const chunks: number[] = [];
    const handle = { write: (data: Uint8Array, offset: number, length: number) => { const n = Math.min(3, length); chunks.push(n); void data; void offset; return Promise.resolve({ bytesWritten: n }); } };
    await writeFully(handle as never, Buffer.alloc(10));
    expect(chunks).toEqual([3, 3, 3, 1]);
    await expect(writeFully({ write: () => Promise.resolve({ bytesWritten: 0 }) } as never, Buffer.alloc(2))).rejects.toMatchObject({ reason: "write_failed" });
  });
});

describe("the lows of the swap", () => {
  const X86_TAGS = ["cp312-cp312-manylinux_2_17_x86_64"];
  const pkg = (): PackageFileInput[] => installed({ name: "numpy", version: "2.5.4", tags: X86_TAGS, files: { "numpy/__init__.py": "x86", "numpy/_m.so": X86() } });
  const idx = (bytes: Uint8Array, name = "numpy-2.5.4-cp312-cp312-manylinux_2_28_aarch64.whl", extra: { yanked?: boolean } = {}): FakeWheelIndex => {
    const index = new FakeWheelIndex();
    index.add("numpy", name, bytes, extra);
    return index;
  };
  const wheelOf = (extra: Partial<Parameters<typeof wheel>[0]> = {}): Uint8Array => wheel({ name: "numpy", version: "2.5.4", tags: ["cp312-cp312-manylinux_2_28_aarch64"], files: { "numpy/__init__.py": "arm", "numpy/_m.so": ARM() }, ...extra });

  it("refuses a wheel member missing from RECORD, or listed with an empty hash", async () => {
    expect((await swapToArm64(pkg(), idx(wheelOf()), { runtime: "python3.12" })).reports[0]).toMatchObject({ status: "swapped" });
    expect((await swapToArm64(pkg(), idx(wheelOf({ recordOmit: ["numpy/_m.so"] })), { runtime: "python3.12" })).reports[0]).toMatchObject({ status: "unsafe", detail: "member-not-in-record" });
    expect((await swapToArm64(pkg(), idx(wheelOf({ recordEmptyHash: ["numpy/_m.so"] })), { runtime: "python3.12" })).reports[0]).toMatchObject({ status: "unsafe", detail: "record-hash-missing" });
  });

  it("takes the Python version from the Runtime, never from the package's own wheels", async () => {
    expect(pythonOfRuntime("python3.12")).toEqual({ major: 3, minor: 12 });
    expect(pythonOfRuntime("nodejs22.x")).toBeUndefined();
    expect(pythonOfRuntime("python3.12; rm")).toBeUndefined();
    // The package's own tags say cp312; without the Runtime that is no longer believed.
    expect((await swapToArm64(pkg(), idx(wheelOf()))).reports[0]).toMatchObject({ status: "unplannable", detail: "python-version-unknown" });
    // A package whose tags claim cp312 on a python3.9 function: the wheel for cp312 does not fit python3.9.
    expect((await swapToArm64(pkg(), idx(wheelOf()), { runtime: "python3.9" })).reports[0]).toMatchObject({ status: "no-arm64-wheel" });
  });

  it("does not install a plain linux_aarch64 wheel, and keeps a manylinux one", () => {
    const target = { python: { major: 3, minor: 12 }, glibc: [2, 34] as const };
    expect(wheelFit(parseWheelFilename("numpy-2.5.4-cp312-cp312-linux_aarch64.whl")!, target)).toBeUndefined();
    expect(wheelFit(parseWheelFilename("numpy-2.5.4-cp312-cp312-manylinux_2_28_aarch64.whl")!, target)).toBeDefined();
  });

  it("never prefers a yanked file to one that is not yanked, whatever the fit", async () => {
    const index = new FakeWheelIndex();
    index.add("numpy", "numpy-2.5.4-cp312-cp312-manylinux_2_28_aarch64.whl", wheelOf(), { yanked: true });
    index.add("numpy", "numpy-2.5.4-cp312-abi3-manylinux_2_17_aarch64.whl", wheelOf({ tags: ["cp312-abi3-manylinux_2_17_aarch64"] }), { yanked: false });
    const result = await swapToArm64(pkg(), index, { runtime: "python3.12" });
    expect(result.reports[0]).toMatchObject({ status: "swapped", yanked: false, wheel: "numpy-2.5.4-cp312-abi3-manylinux_2_17_aarch64.whl" });
  });

  it("keeps the raw folder path in a node plan's action, and the safe one for display", () => {
    const folder = "node_modules/@napi-rs/canvas-linux-x64-gnu";
    const manifest = (name: string, extra = ""): PackageFileInput => file(`node_modules/${name}/package.json`, `{"name":"${name}","version":"0.1.5"${extra}}`);
    const files = [manifest("@napi-rs/canvas", ',"optionalDependencies":{"@napi-rs/canvas-linux-arm64-gnu":"0.1.5"}'), manifest("@napi-rs/canvas-linux-x64-gnu"), file(`${folder}/canvas.linux-x64-gnu.node`, X86())];
    const plan = planNodeAddons(files);
    expect(plan.packages[0]!.step).toMatchObject({ drop: folder, dropPath: folder });
    const odd = planNodeAddons([file("node_modules/@napi-rs/canvas/package.json", '{"name":"@napi-rs/canvas","version":"0.1.5","optionalDependencies":{"@napi-rs/canvas-linux-arm64-gnu":"0.1.5"}}'), file("node_modules/@napi-rs/canvas-linux-x64-gnu/package.json", '{"name":"@napi-rs/canvas-linux-x64-gnu","version":"0.1.5"}'), file("node_modules/@napi-rs/canvas-linux-x64-gnu/a\u0007b.node", X86())]);
    expect(odd.packages[0]!.step?.dropPath).toBe("node_modules/@napi-rs/canvas-linux-x64-gnu");
  });
});

describe("archives inside archives are looked into", () => {
  const archive = (path: string, bytes: Uint8Array): PackageFileInput => file(path, bytes);
  const tar = (members: Array<{ name: string; data: Uint8Array }>): Uint8Array => {
    const blocks: Buffer[] = [];
    for (const member of members) {
      const header = Buffer.alloc(512);
      header.write(member.name, 0, "latin1");
      header.write("0000644\0", 100, "latin1");
      header.write(`${member.data.length.toString(8).padStart(11, "0")}\0`, 124, "latin1");
      header.write("0", 156, "latin1");
      header.write("ustar\0", 257, "latin1");
      blocks.push(header, Buffer.from(member.data), Buffer.alloc((512 - (member.data.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return Buffer.concat(blocks);
  };

  it("finds x86_64 code in a .whl, an .egg, a .pyz and a .jar kept as files, and names it as archive!/member", () => {
    for (const name of ["vendor/dep-1.0-cp312-cp312-manylinux_2_17_x86_64.whl", "vendor/dep.egg", "app.pyz", "lib/native.jar"]) {
      const result = classifyNative([archive(name, plainZip([{ name: "pkg/_x.so", data: X86() }, { name: "pkg/__init__.py", data: "x" }]))]);
      expect({ name, arch: result.arch, complete: result.complete, offenders: result.offenders.map((o) => o.path) }).toEqual({ name, arch: "x86_64", complete: true, offenders: [`${name}!/pkg/_x.so`] });
    }
  });

  it("finds an ELF without a .so name, reads the WHEEL tags of a nested wheel, and counts arm64 inside", () => {
    expect(classifyNative([archive("a.zip", plainZip([{ name: "bin/tool", data: X86() }]))]).arch).toBe("x86_64");
    expect(classifyNative([archive("b.whl", plainZip([{ name: "p/_a.so", data: ARM() }]))])).toMatchObject({ arch: "arm64", complete: true });
    const wheelBytes = wheel({ name: "dep", version: "1.0", tags: ["cp312-cp312-manylinux_2_17_x86_64"], files: { "dep/__init__.py": "x" } });
    expect(classifyNative([archive("dep.whl", wheelBytes)]).wheels.map((w) => w.platforms)).toEqual([["x86_64"]]);
  });

  it("looks into a tar.gz and a plain tar", () => {
    const members = [{ name: "data/readme.txt", data: Buffer.from("hi") }, { name: "bin/tool", data: X86() }];
    expect(classifyNative([archive("data.tar.gz", gzipSync(tar(members)))])).toMatchObject({ arch: "x86_64", complete: true });
    expect(classifyNative([archive("data.tgz", gzipSync(tar(members)))]).arch).toBe("x86_64");
    expect(classifyNative([archive("data.tar", tar(members))]).arch).toBe("x86_64");
    expect(classifyNative([archive("pure.tar", tar([{ name: "a.txt", data: Buffer.from("hi") }]))])).toMatchObject({ native: false, arch: "none", complete: true });
  });

  it("calls a pure archive pure, and marks an archive it cannot open as incomplete (never pure)", () => {
    expect(classifyNative([archive("pure.jar", plainZip([{ name: "A.class", data: "cafebabe" }]))])).toMatchObject({ native: false, arch: "none", complete: true });
    for (const [label, input] of [
      ["a corrupt wheel", archive("broken.whl", Buffer.from("PK not a zip at all, long enough to look for an end record in"))],
      ["an xz tarball", archive("data.tar.xz", Buffer.from("xz bytes"))],
      ["a bzip2 tarball", archive("data.tar.bz2", Buffer.from("bz bytes"))],
      ["a truncated tar", archive("t.tar", tar([{ name: "a", data: Buffer.alloc(2000) }]).subarray(0, 700))],
      ["a gzip that is not gzip", archive("t.tar.gz", Buffer.from("not gzip"))],
      ["an archive over the read bound", { ...file("huge.jar", "x"), size: 64 * 1024 * 1024 } as PackageFileInput],
    ] as const) {
      const result = classifyNative([input]);
      expect({ label, complete: result.complete, native: result.native, arch: result.arch }).toEqual({ label, complete: false, native: true, arch: "mixed" });
    }
  });

  it("opens an archive inside an archive once, and gives up (incomplete) at the second level", () => {
    const inner = plainZip([{ name: "pkg/_x.so", data: X86() }]);
    expect(classifyNative([archive("outer.zip", plainZip([{ name: "inner.whl", data: inner }]))])).toMatchObject({ arch: "x86_64", complete: true });
    const innermost = plainZip([{ name: "deep.zip", data: inner }]);
    const result = classifyNative([archive("outer.zip", plainZip([{ name: "mid.zip", data: innermost }]))]);
    expect(result.complete).toBe(false);
    expect(result.native).toBe(true);
  });

  it("stops at the byte budget of nested archives instead of inflating without end", () => {
    const big = plainZip([{ name: "blob.bin", data: Buffer.alloc(12 * 1024 * 1024, 7) }]);
    const many = Array.from({ length: 16 }, (_, i) => archive(`a${String(i)}.zip`, big));
    const result = classifyNative(many);
    expect(result.complete).toBe(false);
  });
});

describe("the lows of the store", () => {
  it("frees the space and reports a fixed sentence when a folder cannot be removed (discard and close)", async () => {
    if (process.getuid?.() === 0) return;
    const { root, store, run } = await setup();
    const zip = buildZip([{ name: "locked/", data: "", method: 0, mode: 0o040755 }, { name: "locked/f", data: "x" }]);
    await give(run, zip, "function");
    const code = await run.materialize("k", { packageSha256: sha(zip), layerSha256s: [] });
    const used = run.usedBytes();
    expect(used).toBeGreaterThan(zip.length);
    const locked = join(code.taskDir, "locked");
    chmodSync(locked, 0o500);
    restore.push(locked);
    let message = "";
    try { await run.discard("k"); } catch (error) { message = (error as Error).message; expect(error).toBeInstanceOf(FunctionCodeError); }
    expect(message).not.toContain(root);
    expect(message).not.toContain("EACCES");
    expect(run.usedBytes()).toBe(zip.length);
    const closed = await reason(run.close());
    expect(closed).toBe("write_failed");
    expect(store.usage().usedBytes).toBe(0);
    chmodSync(locked, 0o755);
    rmSync(join(root, "runs"), { recursive: true, force: true });
  });

  it("builds a new run of an id whose old run is still closing in the old run's folder, not over it", async () => {
    const { root, store, run } = await setup();
    const zip = buildZip([{ name: "a", data: "1" }]);
    await give(run, zip, "function");
    const closing = run.close();
    const reopened = store.openRun("run-1");
    await closing;
    const next = await reopened;
    expect(next).not.toBe(run);
    await give(next, zip, "function");
    expect(existsSync(join(root, "runs", "run-1", "blobs", `${sha(zip)}.zip`))).toBe(true);
    expect(await reason(next.materialize("k", { packageSha256: sha(zip), layerSha256s: [] }))).toBe("ok");
    // Many open and close rounds on one id, started at once, never lose the new run's folder.
    for (let round = 0; round < 5; round += 1) {
      const current = await store.openRun("run-1");
      const done = current.close();
      const again = store.openRun("run-1");
      await done;
      const fresh = await again;
      await give(fresh, zip, "function");
      expect(readdirSync(join(root, "runs", "run-1", "blobs"))).toEqual([`${sha(zip)}.zip`]);
    }
  });

  it("makes one run when openRun is called twice at once", async () => {
    const root = rootDir();
    const store = new FunctionCodeStore({ root });
    await store.sweepStale();
    const [a, b, c] = await Promise.all([store.openRun("same"), store.openRun("same"), store.openRun("same")]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(store.usage().openRuns).toBe(1);
  });

  it("accepts a name that only starts with two dots (`..data`), as a real folder with links to it does", async () => {
    const root = rootDir();
    const zip = buildZip([{ name: "..2024_01/", data: "", method: 0, mode: 0o040755 }, { name: "..2024_01/config", data: "v" }, linkEntry("..data", "..2024_01"), linkEntry("config", "..data/config")]);
    await unpackFunctionCode(zip, join(root, "t"), LIMITS);
    expect(readFileSync(join(root, "t", "config"), "utf8")).toBe("v");
    expect(readlinkSync(join(root, "t", "..data"))).toBe("..2024_01");
    mkdirSync(join(root, "ov"));
    await unpackFunctionCode(buildZip([{ name: "..keep", data: "k" }]), join(root, "ov"), LIMITS, { mode: "overlay" });
    expect(readFileSync(join(root, "ov", "..keep"), "utf8")).toBe("k");
  });
});
