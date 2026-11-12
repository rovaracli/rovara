// Slice 4, lane W2: the worker's function code store (packages/worker/src/function-runner/code-store.ts). Content-addressed per run, size and digest enforced on the stream, whole-zip refusal, atomic publication, budgets, layer order
// (later layers win), the native-code hook, and cleanup at run end.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FUNCTION_CODE_LIMITS, FunctionCodeError, type FunctionCodeProblem } from "../../../packages/worker/src/function-runner/code-errors.js";
import { FunctionCodeStore, LAMBDA_LAYER_ROOT, LAMBDA_TASK_ROOT, type RunCode } from "../../../packages/worker/src/function-runner/code-store.js";
import { NATIVE_CLASSIFIER_IS_STUB, classifyNative, type ClassifiableFile } from "../../../packages/worker/src/function-runner/native-classify.js";
import { chunksOf, type PackageAnnouncement } from "../../../packages/worker/src/function-runner/package-stream.js";
import { buildZip, linkEntry, type TestZipEntry } from "../../support/zip-builder.js";

const roots: string[] = [];
function rootDir(): string {
  const root = mkdtempSync(join(tmpdir(), "fn-store-"));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A stream that fails the test if anything reads it. */
function neverRead(): AsyncIterable<Uint8Array> {
  return { [Symbol.asyncIterator]: () => { throw new Error("must not be read"); } };
}

const sha = (zip: Buffer): string => createHash("sha256").update(zip).digest("hex");
const announce = (zip: Buffer, kind: "function" | "layer" = "function"): PackageAnnouncement => ({ kind, sha256: sha(zip), sizeBytes: zip.length });

async function reason(promise: Promise<unknown>): Promise<FunctionCodeProblem | "ok"> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (!(error instanceof FunctionCodeError)) throw error;
    return error.reason;
  }
}

function files(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else out.push(`${prefix}${entry.name}`);
    }
  };
  walk(root, "");
  return out.sort();
}

const fn: TestZipEntry[] = [{ name: "app.py", data: "def handler(e, c): return 1\n" }, { name: "lib/", data: "", method: 0, mode: 0o040755 }, { name: "lib/util.py", data: "x = 1\n" }];

async function setup(options: ConstructorParameters<typeof FunctionCodeStore>[0] extends infer T ? Partial<T> : never = {}): Promise<{ root: string; store: FunctionCodeStore; run: RunCode }> {
  const root = rootDir();
  const store = new FunctionCodeStore({ root, ...options });
  await store.sweepStale();
  return { root, store, run: await store.openRun("run-1") };
}

describe("receiving a package", () => {
  it("keeps a good zip under its digest, once per run, and says what it holds", async () => {
    const { root, store, run } = await setup();
    const zip = buildZip(fn);
    const stored = await run.receive(announce(zip), chunksOf(zip, 7));
    expect(stored).toMatchObject({ kind: "function", sha256: sha(zip), sizeBytes: zip.length, entries: 3, deduped: false });
    expect(run.has(sha(zip))).toBe(true);
    expect(files(join(root, "runs", "run-1"))).toEqual([`blobs/${sha(zip)}.zip`]);
    expect(readFileSync(join(root, "runs", "run-1", "blobs", `${sha(zip)}.zip`)).equals(zip)).toBe(true);
    expect(run.usedBytes()).toBe(zip.length);
    expect(store.usage().usedBytes).toBe(zip.length);
  });

  it("does not read the stream of a package the run already holds", async () => {
    const { run } = await setup();
    const zip = buildZip(fn);
    await run.receive(announce(zip), chunksOf(zip));
    const second = await run.receive(announce(zip), neverRead());
    expect(second.deduped).toBe(true);
    expect(run.usedBytes()).toBe(zip.length);
  });

  it("keeps the same digest apart in two runs (no cache across runs)", async () => {
    const { store, run } = await setup();
    const other = await store.openRun("run-2");
    const zip = buildZip(fn);
    await run.receive(announce(zip), chunksOf(zip));
    expect(other.has(sha(zip))).toBe(false);
    expect((await other.receive(announce(zip), chunksOf(zip))).deduped).toBe(false);
  });

  const badStreams: Array<[string, (zip: Buffer) => { announcement: PackageAnnouncement; bytes: AsyncIterable<Uint8Array> }, FunctionCodeProblem]> = [
    ["another digest than announced", (zip) => ({ announcement: { ...announce(zip), sha256: "0".repeat(64) }, bytes: chunksOf(zip) }), "digest"],
    ["a body longer than announced", (zip) => ({ announcement: announce(zip), bytes: chunksOf(Buffer.concat([zip, Buffer.from("!")])) }), "size"],
    ["a body shorter than announced", (zip) => ({ announcement: announce(zip), bytes: chunksOf(zip.subarray(1)) }), "size"],
    ["a non-hex digest", (zip) => ({ announcement: { ...announce(zip), sha256: sha(zip).toUpperCase() }, bytes: chunksOf(zip) }), "bad_request"],
    ["a size of zero", (zip) => ({ announcement: { ...announce(zip), sizeBytes: 0 }, bytes: chunksOf(zip) }), "size"],
    ["a size past the cap", (zip) => ({ announcement: { ...announce(zip), sizeBytes: FUNCTION_CODE_LIMITS.maxZipBytes + 1 }, bytes: chunksOf(zip) }), "size"],
    ["a fractional size", (zip) => ({ announcement: { ...announce(zip), sizeBytes: 1.5 }, bytes: chunksOf(zip) }), "size"],
    ["a kind that is neither", (zip) => ({ announcement: { ...announce(zip), kind: "image" as never }, bytes: chunksOf(zip) }), "bad_request"],
    ["chunks that are text", (zip) => ({ announcement: announce(zip), bytes: (async function* () { yield "text" as never; })() }), "bad_request"],
  ];
  for (const [label, make, expected] of badStreams) {
    it(`refuses ${label} and leaves nothing`, async () => {
      const { root, store, run } = await setup();
      const zip = buildZip(fn);
      const { announcement, bytes } = make(zip);
      expect(await reason(run.receive(announcement, bytes))).toBe(expected);
      expect(files(join(root, "runs", "run-1"))).toEqual([]);
      expect(run.usedBytes()).toBe(0);
      expect(store.usage().usedBytes).toBe(0);
    });
  }

  it("cuts a stream as soon as it is longer than announced", async () => {
    const { run } = await setup();
    const zip = buildZip(fn);
    let pulled = 0;
    const endless = (async function* () {
      for (;;) { pulled += 1; yield Buffer.alloc(1024); if (pulled > 10_000) return; }
    })();
    expect(await reason(run.receive(announce(zip), endless))).toBe("size");
    expect(pulled).toBeLessThan(10);
  });

  it("judges the whole zip before keeping it: a bad entry, a link out, a bomb", async () => {
    const { root, run } = await setup();
    for (const hostile of [buildZip([...fn, { name: "../x", data: "y" }]), buildZip([...fn, linkEntry("l", "../../x")]), buildZip([{ name: "b", data: Buffer.alloc(1000), declaredUncompressed: 3 }, { name: "c", data: "c", declaredUncompressed: 300 * 1024 * 1024 }])]) {
      expect(["unsafe_entry", "unsafe_link", "too_large"]).toContain(await reason(run.receive(announce(hostile), chunksOf(hostile))));
    }
    expect(files(join(root, "runs", "run-1"))).toEqual([]);
    expect(run.usedBytes()).toBe(0);
  });

  it("gives up on a stalled stream, and on an aborted one, and cleans the scratch", async () => {
    const { root, run } = await setup();
    const zip = buildZip(fn);
    const stalled = (async function* () { yield zip.subarray(0, 5); await new Promise(() => undefined); })();
    expect(await reason(run.receive(announce(zip), stalled, { timeoutMs: 30 }))).toBe("timed_out");
    const controller = new AbortController();
    const stalledAgain = (async function* () { yield zip.subarray(0, 5); await new Promise(() => undefined); })();
    const pending = run.receive(announce(zip), stalledAgain, { signal: controller.signal, timeoutMs: 60_000 });
    setTimeout(() => { controller.abort(); }, 20);
    expect(await reason(pending)).toBe("timed_out");
    expect(files(join(root, "runs", "run-1"))).toEqual([]);
    expect(run.usedBytes()).toBe(0);
  });
});

describe("budgets", () => {
  it("refuses a package that does not fit the worker's disk budget before reading it, and a run's own cap", async () => {
    const zip = buildZip(fn);
    const small = await setup({ diskBudgetBytes: zip.length - 1 });
    expect(await reason(small.run.receive(announce(zip), neverRead()))).toBe("budget");
    const perRun = await setup({ maxRunBytes: zip.length * 2 - 1 });
    const second = buildZip([{ name: "other", data: "o".repeat(40) }]);
    await perRun.run.receive(announce(zip), chunksOf(zip));
    expect(await reason(perRun.run.receive(announce(second), chunksOf(second)))).toBe("ok");
    const third = buildZip([{ name: "third", data: "t".repeat(2000), method: 0 }]);
    expect(await reason(perRun.run.receive(announce(third), chunksOf(third)))).toBe("budget");
  });

  it("shares the worker's budget between runs and gives it back when a run ends", async () => {
    const zip = buildZip(fn);
    const other = buildZip([{ name: "other", data: "o".repeat(2000), method: 0 }]);
    const { store, run } = await setup({ diskBudgetBytes: zip.length + other.length - 1 });
    const second = await store.openRun("run-2");
    await run.receive(announce(zip), chunksOf(zip));
    expect(await reason(second.receive(announce(other), chunksOf(other)))).toBe("budget");
    await run.close();
    expect(store.usage().usedBytes).toBe(0);
    expect(await reason(second.receive(announce(other), chunksOf(other)))).toBe("ok");
  });
});

describe("materializing a function with layers", () => {
  const layerOne = buildZip([
    { name: "python/lib/python3.12/site-packages/dep/__init__.py", data: "VERSION = 1\n" },
    { name: "python/lib/python3.12/site-packages/dep/_native.so", data: "\u007fELF-one" },
    { name: "bin/tool", data: "#!/bin/sh\necho one\n", mode: 0o100755 },
    linkEntry("lib64", "lib"),
    { name: "shared.txt", data: "from layer one" },
  ]);
  const layerTwo = buildZip([{ name: "python/lib/python3.12/site-packages/dep/__init__.py", data: "VERSION = 2\n" }, { name: "shared.txt", data: "from layer two" }, { name: "lib/libx.so.1", data: "\u007fELF-two" }, linkEntry("lib/libx.so", "libx.so.1")]);

  async function loaded(run: RunCode): Promise<{ fnZip: Buffer }> {
    const fnZip = buildZip(fn);
    await run.receive(announce(fnZip), chunksOf(fnZip));
    await run.receive(announce(layerOne, "layer"), chunksOf(layerOne));
    await run.receive(announce(layerTwo, "layer"), chunksOf(layerTwo));
    return { fnZip };
  }

  it("unpacks the function into task and the layers, in order and later winning, into opt", async () => {
    const seen: ClassifiableFile[][] = [];
    const classify = vi.fn((list: readonly ClassifiableFile[]) => { seen.push([...list]); return Promise.resolve({ native: true, arch: "arm64" as const }); });
    const { root, run } = await setup({ classify });
    const { fnZip } = await loaded(run);
    const code = await run.materialize("fn-a:1", { packageSha256: sha(fnZip), layerSha256s: [sha(layerOne), sha(layerTwo)] });
    expect(readFileSync(join(code.taskDir, "app.py"), "utf8")).toBe("def handler(e, c): return 1\n");
    expect(readFileSync(join(code.optDir, "python/lib/python3.12/site-packages/dep/__init__.py"), "utf8")).toBe("VERSION = 2\n");
    expect(readFileSync(join(code.optDir, "shared.txt"), "utf8")).toBe("from layer two");
    expect(readFileSync(join(code.optDir, "python/lib/python3.12/site-packages/dep/_native.so"), "utf8")).toBe("\u007fELF-one");
    expect(readlinkSync(join(code.optDir, "lib64"))).toBe("lib");
    expect(readFileSync(join(code.optDir, "lib64", "libx.so"), "utf8")).toBe("\u007fELF-two");
    expect(lstatSync(join(code.optDir, "bin", "tool")).mode & 0o777).toBe(0o755);
    // The tree sits under the run's folder in a numbered folder, never under a name from the package or the key.
    expect(code.taskDir).toBe(join(root, "runs", "run-1", "trees", "0", "task"));
    // The classifier saw the final regular files with the Lambda paths, once, and their first bytes are readable.
    expect(classify).toHaveBeenCalledTimes(1);
    const names = seen[0]!.map((file) => file.path).sort();
    expect(names).toContain(`${LAMBDA_TASK_ROOT}/app.py`);
    expect(names).toContain(`${LAMBDA_LAYER_ROOT}/lib/libx.so.1`);
    expect(names).not.toContain(`${LAMBDA_LAYER_ROOT}/lib/libx.so`);
    const so = seen[0]!.find((file) => file.path.endsWith("_native.so"))!;
    expect((await so.head(4)).toString("latin1")).toBe("\u007fELF");
    expect(code.native).toEqual({ native: true, arch: "arm64" });
    expect(code.files).toBe(names.length);
    expect(run.usedBytes()).toBe(fnZip.length + layerOne.length + layerTwo.length + code.expandedBytes);
  });

  it("applies the stub classifier by default: nothing is native, and it says it is a stub", async () => {
    const { run } = await setup();
    const { fnZip } = await loaded(run);
    const code = await run.materialize("k", { packageSha256: sha(fnZip), layerSha256s: [sha(layerOne)] });
    expect(code.native).toEqual({ native: false, arch: "none" });
    expect(NATIVE_CLASSIFIER_IS_STUB).toBe(true);
    expect(await classifyNative([])).toEqual({ native: false, arch: "none" });
  });

  it("makes an empty opt for a function with no layer, and the layer order is the request's, not the arrival's", async () => {
    const { run } = await setup();
    const { fnZip } = await loaded(run);
    const plain = await run.materialize("plain", { packageSha256: sha(fnZip), layerSha256s: [] });
    expect(readdirSync(plain.optDir)).toEqual([]);
    const swapped = await run.materialize("swapped", { packageSha256: sha(fnZip), layerSha256s: [sha(layerTwo), sha(layerOne)] });
    expect(readFileSync(join(swapped.optDir, "shared.txt"), "utf8")).toBe("from layer one");
    expect(readFileSync(join(swapped.optDir, "python/lib/python3.12/site-packages/dep/__init__.py"), "utf8")).toBe("VERSION = 1\n");
  });

  it("refuses unknown digests, too many layers, a bad key, a key in use, and a combined size past Lambda's limit; nothing is left half built", async () => {
    const { root, run } = await setup();
    const { fnZip } = await loaded(run);
    expect(await reason(run.materialize("k", { packageSha256: "1".repeat(64), layerSha256s: [] }))).toBe("not_found");
    expect(await reason(run.materialize("k", { packageSha256: sha(fnZip), layerSha256s: ["2".repeat(64)] }))).toBe("not_found");
    expect(await reason(run.materialize("k", { packageSha256: sha(fnZip), layerSha256s: Array.from({ length: 6 }, () => sha(layerOne)) }))).toBe("bad_request");
    expect(await reason(run.materialize("", { packageSha256: sha(fnZip), layerSha256s: [] }))).toBe("bad_request");
    expect(await reason(run.materialize("a\u0000b", { packageSha256: sha(fnZip), layerSha256s: [] }))).toBe("bad_request");
    expect(await reason(run.materialize("not-hex", { packageSha256: "xyz", layerSha256s: [] }))).toBe("bad_request");
    await run.materialize("k", { packageSha256: sha(fnZip), layerSha256s: [] });
    expect(await reason(run.materialize("k", { packageSha256: sha(fnZip), layerSha256s: [] }))).toBe("bad_request");
    // Two layers that each declare 150 MB are together past 250 MB, refused before anything is written.
    const heavy = (name: string): Buffer => buildZip([{ name, data: "x", declaredUncompressed: 150 * 1024 * 1024 }]);
    const a = heavy("a");
    const b = heavy("b");
    await run.receive(announce(a, "layer"), chunksOf(a));
    await run.receive(announce(b, "layer"), chunksOf(b));
    expect(await reason(run.materialize("big", { packageSha256: sha(fnZip), layerSha256s: [sha(a), sha(b)] }))).toBe("too_large");
    expect(readdirSync(join(root, "runs", "run-1", "trees")).filter((name) => name.startsWith(".build"))).toEqual([]);
  });

  it("removes a half-built tree when an unpack fails, and gives its space back", async () => {
    const { root, run } = await setup();
    const { fnZip } = await loaded(run);
    // A CRC lie is found only while writing: the judge passes, the unpack fails.
    const liar = buildZip([{ name: "a.txt", data: "hello", declaredCrc: 123 }]);
    await run.receive(announce(liar, "layer"), chunksOf(liar));
    const before = run.usedBytes();
    expect(await reason(run.materialize("liar", { packageSha256: sha(fnZip), layerSha256s: [sha(liar)] }))).toBe("corrupt");
    expect(readdirSync(join(root, "runs", "run-1", "trees"))).toEqual([]);
    expect(run.usedBytes()).toBe(before);
    expect(await reason(run.materialize("liar", { packageSha256: sha(fnZip), layerSha256s: [] }))).toBe("ok");
  });

  it("holds a function key as a map key only: a key full of path text creates no such path", async () => {
    const { root, run } = await setup();
    const { fnZip } = await loaded(run);
    const code = await run.materialize("../../../escape/..%2f", { packageSha256: sha(fnZip), layerSha256s: [] });
    expect(code.taskDir.startsWith(join(root, "runs", "run-1", "trees"))).toBe(true);
    expect(readdirSync(root)).toEqual(["runs"]);
  });

  it("starts only one build for a key when asked twice at once, and caps functions per run", async () => {
    const { run } = await setup({ maxFunctionsPerRun: 2 });
    const { fnZip } = await loaded(run);
    const request = { packageSha256: sha(fnZip), layerSha256s: [] };
    const results = await Promise.all([reason(run.materialize("same", request)), reason(run.materialize("same", request))]);
    expect(results.sort()).toEqual(["bad_request", "ok"]);
    await run.materialize("two", request);
    expect(await reason(run.materialize("three", request))).toBe("budget");
    await run.discard("two");
    expect(await reason(run.materialize("three", request))).toBe("ok");
  });

  it("discard and dropPackage give space back; unknown ones do nothing", async () => {
    const { root, run } = await setup();
    const { fnZip } = await loaded(run);
    const all = run.usedBytes();
    const code = await run.materialize("k", { packageSha256: sha(fnZip), layerSha256s: [] });
    expect(run.usedBytes()).toBeGreaterThan(all);
    await run.discard("k");
    expect(run.usedBytes()).toBe(all);
    expect(existsSync(code.taskDir)).toBe(false);
    await run.discard("never-made");
    await run.dropPackage(sha(layerTwo));
    expect(run.has(sha(layerTwo))).toBe(false);
    expect(existsSync(join(root, "runs", "run-1", "blobs", `${sha(layerTwo)}.zip`))).toBe(false);
    await run.dropPackage(sha(layerTwo));
    expect(run.usedBytes()).toBe(fnZip.length + layerOne.length);
  });
});

describe("run end, restart and ids", () => {
  it("removes everything at close, gives the space back, is safe twice, and refuses later calls", async () => {
    const { root, store, run } = await setup();
    const zip = buildZip(fn);
    await run.receive(announce(zip), chunksOf(zip));
    await run.materialize("k", { packageSha256: sha(zip), layerSha256s: [] });
    await run.close();
    await run.close();
    expect(existsSync(join(root, "runs", "run-1"))).toBe(false);
    expect(store.usage()).toMatchObject({ usedBytes: 0, openRuns: 0 });
    expect(await reason(run.receive(announce(zip), chunksOf(zip)))).toBe("run_closed");
    expect(await reason(run.materialize("k", { packageSha256: sha(zip), layerSha256s: [] }))).toBe("run_closed");
    expect(run.has(sha(zip))).toBe(false);
  });

  it("stops a stream in flight when the run ends and leaves nothing behind", async () => {
    const { root, run } = await setup();
    const zip = buildZip(fn);
    const stalled = (async function* () { yield zip.subarray(0, 9); await new Promise(() => undefined); })();
    const pending = run.receive(announce(zip), stalled);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await run.close();
    expect(await reason(pending)).toBe("run_closed");
    expect(existsSync(join(root, "runs", "run-1"))).toBe(false);
  });

  it("sweeps stale runs at start, and opens a run again after it ended with a clean folder", async () => {
    const root = rootDir();
    mkdirSync(join(root, "runs", "old-run", "blobs"), { recursive: true });
    writeFileSync(join(root, "runs", "old-run", "blobs", "x.zip"), "stale");
    const store = new FunctionCodeStore({ root });
    expect(await store.sweepStale()).toBe(1);
    expect(readdirSync(join(root, "runs"))).toEqual([]);
    const first = await store.openRun("again");
    expect(await store.openRun("again")).toBe(first);
    const zip = buildZip(fn);
    await first.receive(announce(zip), chunksOf(zip));
    await first.close();
    const second = await store.openRun("again");
    expect(second).not.toBe(first);
    expect(second.has(sha(zip))).toBe(false);
    expect(files(join(root, "runs", "again"))).toEqual([]);
  });

  it("accepts only plain run ids and an absolute root", async () => {
    const { store } = await setup();
    for (const id of ["", ".", "..", "a/b", "../x", "a b", "-lead", "x".repeat(65), "tab\there", "nul\u0000"]) expect(await reason(store.openRun(id))).toBe("bad_request");
    expect(await reason(store.openRun("task-0123456789abcdef_1"))).toBe("ok");
    expect(() => new FunctionCodeStore({ root: "relative/dir" })).toThrow(FunctionCodeError);
  });
});
