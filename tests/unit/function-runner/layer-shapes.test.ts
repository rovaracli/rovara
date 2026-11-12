// Slice 4, lane W2: real layer and package shapes (a Python layer with compiled wheels and versioned libraries, a Node layer with .bin links and scoped packages, a bin/ layer, a function with layers through the store), archives written by
// the real `zip` tool (plain and streamed with data descriptors) when it is installed, and a layer with more files than the parked judge allowed.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FunctionCodeStore } from "../../../packages/worker/src/function-runner/code-store.js";
import { chunksOf } from "../../../packages/worker/src/function-runner/package-stream.js";
import { inspectFunctionZip } from "../../../packages/worker/src/function-runner/zip-judge.js";
import { unpackFunctionCode } from "../../../packages/worker/src/function-runner/zip-unpack.js";
import { assertSafeTree, readTree } from "../../support/hostile-zips.js";
import { buildZip, linkEntry, type TestZipEntry } from "../../support/zip-builder.js";

const roots: string[] = [];
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function workdir(): string {
  const root = mkdtempSync(join(tmpdir(), "fn-shape-"));
  roots.push(root);
  return root;
}
const LIMITS = { maxEntries: 60_000, maxExpandedBytes: 250 * 1024 * 1024 };
const elf = (tag: string): string => `\u007fELF\u0002\u0001\u0001\u0000${tag}`;
const exe = (name: string, data: string): TestZipEntry => ({ name, data, mode: 0o100755 });
const dir = (name: string): TestZipEntry => ({ name: `${name}/`, data: "", method: 0, mode: 0o040755 });

const SITE = "python/lib/python3.12/site-packages";
const pythonLayer: TestZipEntry[] = [
  dir("python"), dir(`${SITE}`), dir(`${SITE}/numpy`),
  { name: `${SITE}/numpy/__init__.py`, data: "from . import core\n" },
  { name: `${SITE}/numpy/core/_multiarray_umath.cpython-312-aarch64-linux-gnu.so`, data: elf("umath") },
  { name: `${SITE}/numpy/core/__pycache__/__init__.cpython-312.pyc`, data: "\u0000\u0001pyc" },
  { name: `${SITE}/numpy.libs/libopenblas64_p-r0-0cf96a72.3.23.dev.so`, data: elf("openblas") },
  { name: `${SITE}/numpy.libs/libgfortran-040039e1.so.5.0.0`, data: elf("gfortran"), mode: 0o100755 },
  linkEntry(`${SITE}/numpy.libs/libgfortran-040039e1.so.5`, "libgfortran-040039e1.so.5.0.0"),
  { name: `${SITE}/numpy-1.26.4.dist-info/METADATA`, data: "Name: numpy\nVersion: 1.26.4\n" },
  { name: `${SITE}/numpy-1.26.4.dist-info/WHEEL`, data: "Wheel-Version: 1.0\nTag: cp312-cp312-manylinux_2_17_aarch64\n" },
  { name: `${SITE}/numpy-1.26.4.dist-info/RECORD`, data: "numpy/__init__.py,sha256=x,1\n" },
  exe("python/bin/f2py", "#!/opt/python/bin/python3\n"),
];
const nodeLayer: TestZipEntry[] = [
  { name: "nodejs/package.json", data: "{}" },
  { name: "nodejs/node_modules/typescript/bin/tsc", data: "#!/usr/bin/env node\n", mode: 0o100755 },
  linkEntry("nodejs/node_modules/.bin/tsc", "../typescript/bin/tsc"),
  { name: "nodejs/node_modules/sharp/build/Release/sharp-linux-arm64.node", data: elf("sharp") },
  { name: "nodejs/node_modules/@aws-sdk/client-s3/package.json", data: "{\"name\":\"@aws-sdk/client-s3\"}" },
  { name: "nodejs/node_modules/a/node_modules/b/node_modules/c/node_modules/d/index.js", data: "module.exports = 4;\n" },
  linkEntry("nodejs/node_modules/sharp/vendor/lib", "../build/Release"),
];
const binLayer: TestZipEntry[] = [
  exe("bin/ffmpeg", elf("ffmpeg")), linkEntry("bin/ffprobe", "ffmpeg"),
  { name: "lib/libavcodec.so.60.3.100", data: elf("avcodec") }, linkEntry("lib/libavcodec.so.60", "libavcodec.so.60.3.100"), linkEntry("lib/libavcodec.so", "libavcodec.so.60"),
  dir("etc"), dir("share/doc/ffmpeg"), { name: "share/doc/ffmpeg/copyright", data: "GPL\n" },
  exe("extensions/logger", "#!/bin/sh\n"),
];

describe("real layer shapes", () => {
  it("unpacks a Python layer with compiled wheels and a versioned library link", async () => {
    const target = join(workdir(), "opt");
    await unpackFunctionCode(buildZip(pythonLayer), target, LIMITS);
    const site = join(target, SITE);
    expect(readFileSync(join(site, "numpy", "core", "_multiarray_umath.cpython-312-aarch64-linux-gnu.so"), "latin1").startsWith("\u007fELF")).toBe(true);
    expect(readlinkSync(join(site, "numpy.libs", "libgfortran-040039e1.so.5"))).toBe("libgfortran-040039e1.so.5.0.0");
    expect(statSync(join(site, "numpy.libs", "libgfortran-040039e1.so.5.0.0")).mode & 0o777).toBe(0o755);
    expect(statSync(join(target, "python", "bin", "f2py")).mode & 0o777).toBe(0o755);
    assertSafeTree(target);
  });
  it("unpacks a Node layer: a .bin link, scoped packages, a native addon, deep node_modules", async () => {
    const target = join(workdir(), "opt");
    await unpackFunctionCode(buildZip(nodeLayer), target, LIMITS);
    const modules = join(target, "nodejs", "node_modules");
    expect(readlinkSync(join(modules, ".bin", "tsc"))).toBe("../typescript/bin/tsc");
    expect(readFileSync(join(modules, ".bin", "tsc"), "utf8")).toBe("#!/usr/bin/env node\n");
    expect(lstatSync(join(modules, "@aws-sdk", "client-s3", "package.json")).isFile()).toBe(true);
    expect(readFileSync(join(modules, "a", "node_modules", "b", "node_modules", "c", "node_modules", "d", "index.js"), "utf8")).toBe("module.exports = 4;\n");
    expect(readFileSync(join(modules, "sharp", "vendor", "lib", "sharp-linux-arm64.node"), "latin1").startsWith("\u007fELF")).toBe(true);
    assertSafeTree(target);
  });
  it("unpacks a bin/ layer: executables, a link to an executable, a two-step library link, empty folders", async () => {
    const target = join(workdir(), "opt");
    await unpackFunctionCode(buildZip(binLayer), target, LIMITS);
    expect(statSync(join(target, "bin", "ffprobe")).mode & 0o777).toBe(0o755);
    expect(readlinkSync(join(target, "bin", "ffprobe"))).toBe("ffmpeg");
    expect(readFileSync(join(target, "lib", "libavcodec.so"), "latin1").endsWith("avcodec")).toBe(true);
    expect(readTree(target).get("etc")).toMatchObject({ kind: "dir" });
    assertSafeTree(target);
  });
  it("lets a layer ship dangling links and links up to a folder inside the package", () => {
    expect(() => inspectFunctionZip(buildZip([linkEntry("python/lib64", "lib"), linkEntry("python/lib/ghost.so", "../../gone/ghost.so.1"), linkEntry("nodejs/node_modules/self", "..")]), LIMITS)).not.toThrow();
  });
  it("accepts a layer with more files than the parked judge's 20,000 cap, up to the zip's own 65,534 limit", async () => {
    const entries = Array.from({ length: 30_000 }, (_, index) => ({ name: `python/lib/python3.12/site-packages/pkg${String(index % 300)}/m${String(index)}.py`, data: "x = 1\n", method: 0 as const }));
    const target = join(workdir(), "opt");
    const result = await unpackFunctionCode(buildZip(entries), target, LIMITS);
    expect(result.files).toBe(30_000);
    const tooMany = Array.from({ length: 60_001 }, (_, index) => ({ name: `f${String(index)}`, data: "", method: 0 as const }));
    await expect(unpackFunctionCode(buildZip(tooMany), join(workdir(), "x"), LIMITS)).rejects.toMatchObject({ reason: "too_many_entries" });
  }, 120_000);
});

describe("a function with layers through the store", () => {
  it("builds /var/task and /opt for a function with a Python layer, a Node layer and a bin layer, in the layer order", async () => {
    const root = workdir();
    const store = new FunctionCodeStore({ root });
    await store.sweepStale();
    const run = await store.openRun("shapes");
    const sha = (zip: Buffer): string => createHash("sha256").update(zip).digest("hex");
    const fnZip = buildZip([{ name: "lambda_function.py", data: "def lambda_handler(e, c): return 1\n" }]);
    const overlay = buildZip([{ name: "bin/ffprobe", data: "#!/bin/sh\nreplaced\n", mode: 0o100755 }, { name: "python/lib/python3.12/site-packages/numpy/__init__.py", data: "patched\n" }]);
    const zips = { fn: fnZip, py: buildZip(pythonLayer), node: buildZip(nodeLayer), bin: buildZip(binLayer), overlay };
    for (const [name, zip] of Object.entries(zips)) await run.receive({ kind: name === "fn" ? "function" : "layer", sha256: sha(zip), sizeBytes: zip.length }, chunksOf(zip, 4096));
    const code = await run.materialize("fn:1", { packageSha256: sha(fnZip), layerSha256s: [sha(zips.py), sha(zips.node), sha(zips.bin), sha(zips.overlay)] });
    expect(readFileSync(join(code.taskDir, "lambda_function.py"), "utf8")).toContain("lambda_handler");
    expect(readFileSync(join(code.optDir, "python/lib/python3.12/site-packages/numpy/__init__.py"), "utf8")).toBe("patched\n");
    // The overlay layer's file replaced the earlier layer's link to ffmpeg; ffmpeg itself is untouched.
    expect(lstatSync(join(code.optDir, "bin", "ffprobe")).isFile()).toBe(true);
    expect(readFileSync(join(code.optDir, "bin", "ffprobe"), "utf8")).toContain("replaced");
    expect(readFileSync(join(code.optDir, "bin", "ffmpeg"), "latin1").startsWith("\u007fELF")).toBe(true);
    expect(readlinkSync(join(code.optDir, "nodejs/node_modules/.bin/tsc"))).toBe("../typescript/bin/tsc");
    assertSafeTree(code.optDir);
    await run.close();
  });
});

const hasZip = spawnSync("zip", ["-v"], { stdio: "ignore" }).status === 0;
describe.skipIf(!hasZip)("archives written by the real zip tool", () => {
  function sourceTree(withLinks = true): string {
    const src = join(workdir(), "src");
    mkdirSync(join(src, "python", "lib", "python3.12", "site-packages", "pkg"), { recursive: true });
    mkdirSync(join(src, "bin"));
    writeFileSync(join(src, "python/lib/python3.12/site-packages/pkg/__init__.py"), "v = 1\n");
    writeFileSync(join(src, "python/lib/python3.12/site-packages/pkg/data.bin"), Buffer.alloc(300_000, 7));
    writeFileSync(join(src, "bin/tool"), "#!/bin/sh\n");
    chmodSync(join(src, "bin/tool"), 0o755);
    if (withLinks) {
      symlinkSync("tool", join(src, "bin/tool-link"));
      symlinkSync("lib", join(src, "python/lib64"));
      symlinkSync("../python/lib/python3.12", join(src, "bin/py"));
    }
    return src;
  }
  const normalised = (tree: ReturnType<typeof readTree>): string[] => [...tree].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, node]) => `${path}|${node.kind}|${node.kind === "symlink" ? node.target : node.kind === "file" ? `${createHash("sha256").update(node.content).digest("hex")}|${String(node.exec)}` : ""}`);

  it("unpacks a zip made with `zip -y -r` (links kept as links) to the same tree", async () => {
    const src = sourceTree();
    const out = join(workdir(), "layer.zip");
    expect(spawnSync("zip", ["-q", "-y", "-r", out, "."], { cwd: src }).status).toBe(0);
    const target = join(workdir(), "opt");
    await unpackFunctionCode(readFileSync(out), target, LIMITS);
    expect(normalised(readTree(target))).toEqual(normalised(readTree(src)));
    assertSafeTree(target);
  });
  it("unpacks a streamed zip (data descriptors, as `zip -r - .` writes it; the tool cannot stream links) to the same tree", async () => {
    const src = sourceTree(false);
    const run = spawnSync("zip", ["-q", "-r", "-", "."], { cwd: src, maxBuffer: 50 * 1024 * 1024 });
    expect(run.status).toBe(0);
    // Positive control: this zip really holds data descriptors (their signature).
    expect(run.stdout.includes(Buffer.from([0x50, 0x4b, 0x07, 0x08]))).toBe(true);
    const target = join(workdir(), "opt");
    await unpackFunctionCode(run.stdout, target, LIMITS);
    expect(normalised(readTree(target))).toEqual(normalised(readTree(src)));
  });
  it("unpacks a zip made without -y: links stored as the files they point to", async () => {
    const src = sourceTree();
    const out = join(workdir(), "plain.zip");
    expect(spawnSync("zip", ["-q", "-r", out, "bin", "python/lib/python3.12/site-packages"], { cwd: src }).status).toBe(0);
    const target = join(workdir(), "opt");
    await unpackFunctionCode(readFileSync(out), target, LIMITS);
    expect(lstatSync(join(target, "bin", "tool-link")).isFile()).toBe(true);
    expect(readFileSync(join(target, "bin", "tool-link"), "utf8")).toBe("#!/bin/sh\n");
  });
});
