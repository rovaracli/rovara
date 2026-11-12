// Slice 4 X2: the arm64 wheel swap (planner, verification, re-classification), the PEP 691 index client and the Node addon plan. The index is a fake; no network.
import { describe, expect, it } from "vitest";
import { swapToArm64 } from "../../packages/worker/src/function-runner/arm64-swap.js";
import { classifyNative, type PackageFileInput } from "../../packages/worker/src/function-runner/native-classify.js";
import { planNodeAddons, arm64Twin } from "../../packages/worker/src/function-runner/node-addon-plan.js";
import { FakeWheelIndex, WheelIndexError, createPypiJsonIndex, sha256Hex } from "../../packages/worker/src/function-runner/wheel-index.js";
import { ARM, X86, file, installed, text, wheel, zip } from "../support/x86-package-fixtures.js";

const X86_TAGS = ["cp312-cp312-manylinux_2_17_x86_64", "cp312-cp312-manylinux2014_x86_64"];
const ARM_FILE = "numpy-2.5.4-cp312-cp312-manylinux_2_27_aarch64.manylinux_2_28_aarch64.whl";

function numpyInstalled(root = ""): PackageFileInput[] {
  return installed({
    name: "numpy", version: "2.5.4", tags: X86_TAGS, root,
    files: { "numpy/__init__.py": "x86 build", "numpy/_core/_mul.cpython-312-x86_64-linux-gnu.so": X86(), "numpy.libs/libopenblas.so.0": X86() },
  });
}
const numpyWheel = (extra: Partial<Parameters<typeof wheel>[0]> = {}): Uint8Array => wheel({
  name: "numpy", version: "2.5.4", tags: ["cp312-cp312-manylinux_2_27_aarch64", "cp312-cp312-manylinux_2_28_aarch64"],
  files: { "numpy/__init__.py": "arm build", "numpy/_core/_mul.cpython-312-aarch64-linux-gnu.so": ARM(), "numpy.libs/libopenblas.so.0": ARM() }, ...extra,
});
const app = (): PackageFileInput[] => [file("handler.py", "def handler(e, c): pass\n")];

describe("swapToArm64", () => {
  it("swaps an x86_64 wheel for the same version's aarch64 wheel and re-classifies", async () => {
    const index = new FakeWheelIndex();
    index.add("numpy", "numpy-2.5.4-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl", wheel({ name: "numpy", version: "2.5.4", tags: ["cp312-cp312-manylinux_2_28_x86_64"], files: { "numpy/__init__.py": "x" } }));
    index.add("numpy", ARM_FILE, numpyWheel());
    const input = [...app(), ...numpyInstalled()];
    const result = await swapToArm64(input, index);
    expect(result.before).toMatchObject({ arch: "x86_64" });
    expect(result.reports).toEqual([expect.objectContaining({ name: "numpy", version: "2.5.4", status: "swapped", fallback: "none", wheel: ARM_FILE, pureFallback: false })]);
    expect(index.downloads).toEqual([ARM_FILE]);
    expect(result.after).toMatchObject({ native: true, arch: "arm64", offenderCount: 0 });
    expect(result.fullyArm64).toBe(true);
    expect(result.needsQemu).toBe(false);
    const paths = result.files.map((f) => f.path);
    expect(paths).toContain("handler.py");
    expect(paths).toContain("numpy/_core/_mul.cpython-312-aarch64-linux-gnu.so");
    expect(paths).not.toContain("numpy/_core/_mul.cpython-312-x86_64-linux-gnu.so");
    expect(paths).toContain("numpy-2.5.4.dist-info/RECORD");
    expect(paths).not.toContain("numpy-2.5.4.dist-info/INSTALLER");
    expect(result.edits.remove).toContain("numpy/_core/_mul.cpython-312-x86_64-linux-gnu.so");
    expect(result.edits.add.map((a) => a.path)).toContain("numpy/__init__.py");
    // The caller's input is untouched and the user's own file is kept as is.
    expect(input.map((f) => f.path)).toContain("numpy/_core/_mul.cpython-312-x86_64-linux-gnu.so");
    expect(result.files.find((f) => f.path === "handler.py")).toBe(input[0]);
  });

  it("works for a layer where the packages sit under python/", async () => {
    const index = new FakeWheelIndex();
    index.add("numpy", ARM_FILE, numpyWheel());
    const result = await swapToArm64(numpyInstalled("python"), index);
    expect(result.reports[0]).toMatchObject({ status: "swapped" });
    expect(result.files.map((f) => f.path)).toContain("python/numpy/_core/_mul.cpython-312-aarch64-linux-gnu.so");
    expect(result.after.arch).toBe("arm64");
  });

  it("does nothing for pure or already-arm64 packages and fetches nothing", async () => {
    const index = new FakeWheelIndex();
    const pure = installed({ name: "six", version: "1.16.0", tags: ["py2-none-any", "py3-none-any"], files: { "six.py": "x" }, purelib: true });
    const arm = installed({ name: "numpy", version: "2.5.4", tags: ["cp312-cp312-manylinux_2_28_aarch64"], files: { "numpy/_x.so": ARM() } });
    const result = await swapToArm64([...pure, ...arm], index);
    expect(result.reports).toEqual([]);
    expect(index.listCalls).toEqual([]);
    expect(result.fullyArm64).toBe(true);
  });

  it("reports no arm64 wheel for this version (and never takes another version)", async () => {
    const index = new FakeWheelIndex();
    index.add("psycopg2-binary", "psycopg2_binary-2.9.13-cp312-cp312-manylinux_2_27_aarch64.manylinux_2_28_aarch64.whl", wheel({ name: "psycopg2-binary", version: "2.9.13", tags: ["cp312-cp312-manylinux_2_28_aarch64"], files: { "psycopg2/_x.so": ARM() } }));
    index.add("psycopg2-binary", "psycopg2_binary-2.9.5-cp312-cp312-manylinux_2_17_x86_64.manylinux2014_x86_64.whl", wheel({ name: "psycopg2-binary", version: "2.9.5", tags: ["cp312-cp312-manylinux2014_x86_64"], files: { "psycopg2/_x.so": X86() } }));
    const old = installed({ name: "psycopg2-binary", version: "2.9.5", tags: X86_TAGS, files: { "psycopg2/_psycopg.cpython-312-x86_64-linux-gnu.so": X86() } });
    const result = await swapToArm64(old, index);
    expect(result.reports).toEqual([expect.objectContaining({ status: "no-arm64-wheel", detail: "no-compatible-tag", fallback: "qemu" })]);
    expect(index.downloads).toEqual([]);
    expect(result.needsQemu).toBe(true);
    expect(result.after.arch).toBe("x86_64");
    expect(result.edits).toEqual({ remove: [], add: [] });
  });

  it("says version-not-on-index when no file of that version exists", async () => {
    const index = new FakeWheelIndex();
    index.add("numpy", "numpy-2.5.3-cp312-cp312-manylinux_2_28_aarch64.whl", wheel({ name: "numpy", version: "2.5.3", tags: ["cp312-cp312-manylinux_2_28_aarch64"], files: { "numpy/_x.so": ARM() } }));
    const result = await swapToArm64(numpyInstalled(), index);
    expect(result.reports[0]).toMatchObject({ status: "no-arm64-wheel", detail: "version-not-on-index" });
    const empty = await swapToArm64(numpyInstalled(), new FakeWheelIndex());
    expect(empty.reports[0]).toMatchObject({ status: "no-arm64-wheel", detail: "project-not-on-index" });
  });

  it("reports source-only packages (psycopg2, mysqlclient)", async () => {
    const index = new FakeWheelIndex();
    index.addListing("psycopg2", "psycopg2-2.9.9.tar.gz");
    const pkg = installed({ name: "psycopg2", version: "2.9.9", tags: ["cp312-cp312-linux_x86_64"], files: { "psycopg2/_psycopg.so": X86() } });
    const result = await swapToArm64(pkg, index);
    expect(result.reports).toEqual([expect.objectContaining({ name: "psycopg2", status: "source-only", detail: "sdist-only", fallback: "qemu" })]);
    expect(result.needsQemu).toBe(true);
  });

  it("respects the glibc level of the image", async () => {
    const index = new FakeWheelIndex();
    index.add("numpy", "numpy-2.5.4-cp312-cp312-manylinux_2_35_aarch64.whl", numpyWheel());
    expect((await swapToArm64(numpyInstalled(), index)).reports[0]).toMatchObject({ status: "no-arm64-wheel", detail: "no-compatible-tag" });
    const ok = new FakeWheelIndex();
    ok.add("numpy", "numpy-2.5.4-cp312-cp312-manylinux_2_35_aarch64.whl", numpyWheel());
    expect((await swapToArm64(numpyInstalled(), ok, { glibc: [2, 35] })).reports[0]).toMatchObject({ status: "swapped" });
    // python3.11 means the Amazon Linux 2 image (glibc 2.26) unless told otherwise.
    const al2 = new FakeWheelIndex();
    al2.add("numpy", "numpy-2.5.4-cp311-cp311-manylinux_2_28_aarch64.whl", numpyWheel());
    const tags11 = installed({ name: "numpy", version: "2.5.4", tags: ["cp311-cp311-manylinux2014_x86_64"], files: { "numpy/_x.so": X86() } });
    expect((await swapToArm64(tags11, al2)).reports[0]).toMatchObject({ status: "no-arm64-wheel" });
  });

  it("picks the exact CPython build over abi3 and the newest allowed glibc", async () => {
    const index = new FakeWheelIndex();
    index.add("numpy", "numpy-2.5.4-cp39-abi3-manylinux_2_28_aarch64.whl", numpyWheel({ files: { "numpy/__init__.py": "abi3", "numpy/_x.so": ARM() } }));
    index.add("numpy", "numpy-2.5.4-cp312-cp312-manylinux2014_aarch64.whl", numpyWheel({ files: { "numpy/__init__.py": "exact-old", "numpy/_x.so": ARM() } }));
    index.add("numpy", "numpy-2.5.4-cp312-cp312-manylinux_2_28_aarch64.whl", numpyWheel({ files: { "numpy/__init__.py": "exact-new", "numpy/_x.so": ARM() } }));
    const result = await swapToArm64(numpyInstalled(), index);
    expect(result.reports[0]!.wheel).toBe("numpy-2.5.4-cp312-cp312-manylinux_2_28_aarch64.whl");
  });

  it("flags a yanked pin and a pure-Python fallback", async () => {
    const yanked = new FakeWheelIndex();
    yanked.add("numpy", ARM_FILE, numpyWheel(), { yanked: true });
    expect((await swapToArm64(numpyInstalled(), yanked)).reports[0]).toMatchObject({ status: "swapped", yanked: true });
    const pure = new FakeWheelIndex();
    pure.add("numpy", "numpy-2.5.4-py3-none-any.whl", wheel({ name: "numpy", version: "2.5.4", tags: ["py3-none-any"], purelib: true, files: { "numpy/__init__.py": "pure" } }));
    const result = await swapToArm64(numpyInstalled(), pure);
    expect(result.reports[0]).toMatchObject({ status: "swapped", pureFallback: true, detail: "pure-python-fallback" });
    expect(result.after).toMatchObject({ native: true === result.after.native, arch: "none" });
    expect(result.fullyArm64).toBe(true);
  });

  describe("verification", () => {
    it("refuses a download that does not match the index hash", async () => {
      const index = new FakeWheelIndex();
      index.add("numpy", ARM_FILE, numpyWheel(), { sha256: "a".repeat(64) });
      const result = await swapToArm64(numpyInstalled(), index);
      expect(result.reports[0]).toMatchObject({ status: "hash-mismatch", detail: "index", fallback: "qemu" });
      expect(result.edits.add).toEqual([]);
      expect(result.after.arch).toBe("x86_64");
    });
    it("refuses a file the index lists without a hash", async () => {
      const index = new FakeWheelIndex();
      index.add("numpy", ARM_FILE, numpyWheel(), { sha256: null });
      const result = await swapToArm64(numpyInstalled(), index);
      expect(result.reports[0]).toMatchObject({ status: "unsafe", detail: "index-hash-missing" });
      expect(index.downloads).toEqual([]);
    });
    it("refuses a wheel whose own RECORD hash does not match a member", async () => {
      const index = new FakeWheelIndex();
      index.add("numpy", ARM_FILE, numpyWheel({ badHashFor: "numpy/__init__.py" }));
      expect((await swapToArm64(numpyInstalled(), index)).reports[0]).toMatchObject({ status: "hash-mismatch", detail: "record" });
    });
    it("refuses a wheel for another project or version than its name says", async () => {
      const index = new FakeWheelIndex();
      index.add("numpy", ARM_FILE, numpyWheel({ metadataName: "evil" }));
      expect((await swapToArm64(numpyInstalled(), index)).reports[0]).toMatchObject({ status: "unsafe", detail: "wheel-metadata-mismatch" });
    });
    it("refuses archive tricks: traversal names, symlinks, a second dist-info, garbage", async () => {
      const cases: [string, Uint8Array, string][] = [
        ["traversal", zip([{ name: "../../handler.py", data: "x" }]), "zip-unsafe-path"],
        ["symlink", zip([{ name: "numpy-2.5.4.dist-info/METADATA", data: "Name: numpy\nVersion: 2.5.4\n" }, { name: "numpy/link", data: "/etc/passwd", symlink: true }]), "wheel-symlink"],
        ["two dist-infos", zip([{ name: "a-1.dist-info/METADATA", data: "x" }, { name: "b-1.dist-info/METADATA", data: "x" }]), "wheel-dist-info-count"],
        ["garbage", text("PK-not-really-a-zip-file-but-long-enough-bytes"), "zip-not-a-zip"],
      ];
      for (const [, bytes, detail] of cases) {
        const index = new FakeWheelIndex();
        index.add("numpy", ARM_FILE, bytes);
        expect((await swapToArm64(numpyInstalled(), index)).reports[0], detail).toMatchObject({ status: "unsafe", detail });
      }
    });
    it("refuses a wheel that would overwrite a file it does not own", async () => {
      const index = new FakeWheelIndex();
      index.add("numpy", ARM_FILE, numpyWheel({ files: { "handler.py": "owned!", "numpy/_x.so": ARM() } }));
      const result = await swapToArm64([...app(), ...numpyInstalled()], index);
      expect(result.reports[0]).toMatchObject({ status: "unsafe", detail: "would-overwrite" });
      expect(result.files.find((f) => f.path === "handler.py")).toBe(result.files[0]);
    });
    it("does not apply a wheel whose files are still x86_64", async () => {
      const index = new FakeWheelIndex();
      index.add("numpy", ARM_FILE, numpyWheel({ files: { "numpy/_x.so": X86() } }));
      const result = await swapToArm64(numpyInstalled(), index);
      expect(result.reports[0]).toMatchObject({ status: "verify-failed", detail: "not-arm64-after-swap" });
      expect(result.needsQemu).toBe(true);
    });
    it("bounds the download and total added bytes", async () => {
      const index = new FakeWheelIndex();
      index.add("numpy", ARM_FILE, numpyWheel());
      expect((await swapToArm64(numpyInstalled(), index, { maxWheelBytes: 100 })).reports[0]).toMatchObject({ status: "index-error", detail: "too-large" });
      expect((await swapToArm64(numpyInstalled(), index, { maxTotalAddedBytes: 100 })).reports[0]).toMatchObject({ status: "unsafe", detail: "too-large" });
    });
  });

  describe("hostile or odd installed metadata", () => {
    it("ignores RECORD rows that leave the package folder and never deletes through them", async () => {
      const index = new FakeWheelIndex();
      index.add("numpy", ARM_FILE, numpyWheel());
      const victim = file("../victim.txt", "keep");
      const input = [...installed({ name: "numpy", version: "2.5.4", tags: X86_TAGS, files: { "numpy/_x.so": X86() }, recordExtra: ["../victim.txt,,", "/etc/passwd,,", "a/../../b,,"] }), victim, file("etc/passwd", "keep")];
      const result = await swapToArm64(input, index);
      expect(result.reports[0]!.status).toBe("swapped");
      expect(result.edits.remove).not.toContain("../victim.txt");
      expect(result.files.map((f) => f.path)).toEqual(expect.arrayContaining(["../victim.txt", "etc/passwd"]));
    });
    it("refuses when two distributions claim the same file", async () => {
      const index = new FakeWheelIndex();
      index.add("numpy", ARM_FILE, numpyWheel());
      const a = numpyInstalled();
      const b = installed({ name: "other", version: "1.0", tags: ["py3-none-any"], files: { "numpy/__init__.py": "shared" }, purelib: true });
      const result = await swapToArm64([...a, ...b], index);
      expect(result.reports[0]).toMatchObject({ status: "unplannable", detail: "shared-files" });
    });
    it("cannot plan without a RECORD", async () => {
      const result = await swapToArm64(installed({ name: "numpy", version: "2.5.4", tags: X86_TAGS, files: { "numpy/_x.so": X86() }, noRecord: true }), new FakeWheelIndex());
      expect(result.reports[0]).toMatchObject({ status: "unplannable", detail: "record-missing", fallback: "qemu" });
    });
    it("refuses a name that is not a project name and a folder that disagrees with METADATA", async () => {
      const index = new FakeWheelIndex();
      const odd = installed({ name: "numpy", version: "2.5.4", tags: X86_TAGS, files: { "numpy/_x.so": X86() } }).map((f) => (f.path.endsWith("/METADATA") ? file(f.path, "Name: ../../etc\nVersion: 2.5.4\n") : f));
      expect((await swapToArm64(odd, index)).reports[0]).toMatchObject({ status: "unplannable", detail: "metadata-unreadable" });
      const mismatch = installed({ name: "numpy", version: "2.5.4", tags: X86_TAGS, files: { "numpy/_x.so": X86() } }).map((f) => (f.path.endsWith("/METADATA") ? file(f.path, "Name: requests\nVersion: 2.5.4\n") : f));
      expect((await swapToArm64(mismatch, index)).reports[0]).toMatchObject({ status: "unplannable", detail: "metadata-mismatch" });
      expect(index.listCalls).toEqual([]);
    });
    it("needs a Python version when the tags do not give one", async () => {
      const index = new FakeWheelIndex();
      index.add("cryptography", "cryptography-50.0.2-cp311-abi3-manylinux_2_28_aarch64.whl", wheel({ name: "cryptography", version: "50.0.2", tags: ["cp311-abi3-manylinux_2_28_aarch64"], files: { "cryptography/_rust.abi3.so": ARM() } }));
      const pkg = installed({ name: "cryptography", version: "50.0.2", tags: ["cp311-abi3-manylinux_2_17_x86_64"], files: { "cryptography/_rust.abi3.so": X86() } });
      expect((await swapToArm64(pkg, index)).reports[0]).toMatchObject({ status: "unplannable", detail: "python-version-unknown" });
      const ok = await swapToArm64(pkg, index, { python: { major: 3, minor: 12 } });
      expect(ok.reports[0]).toMatchObject({ status: "swapped" });
    });
  });

  it("reports index outages without leaking text", async () => {
    const index = new FakeWheelIndex();
    index.failList.add("numpy");
    const result = await swapToArm64(numpyInstalled(), index);
    expect(result.reports[0]).toMatchObject({ status: "index-error", detail: "unavailable", fallback: "qemu" });
  });

  it("reports each package, lists unowned native files and asks for qemu when any x86 code stays", async () => {
    const index = new FakeWheelIndex();
    index.add("numpy", ARM_FILE, numpyWheel());
    const input = [
      ...app(), ...numpyInstalled(),
      ...installed({ name: "lxml", version: "5.0.0", tags: X86_TAGS, files: { "lxml/etree.so": X86() } }),
      file("vendor/libvendored.so", X86()), file("bin/tool", X86()), file("lib/arm.so", ARM()),
    ];
    const result = await swapToArm64(input, index);
    expect(Object.fromEntries(result.reports.map((r) => [r.name, r.status]))).toEqual({ numpy: "swapped", lxml: "no-arm64-wheel" });
    expect(result.unowned.map((u) => u.path).sort()).toEqual(["bin/tool", "vendor/libvendored.so"]);
    expect(result.after.arch).toBe("mixed");
    expect(result.needsQemu).toBe(true);
    expect(result.fullyArm64).toBe(false);
    // A second run on the result finds only what is left.
    const again = await swapToArm64(result.files, index);
    expect(again.reports.map((r) => r.name)).toEqual(["lxml"]);
  });

  it("maps .data directories and keeps script permissions", async () => {
    const index = new FakeWheelIndex();
    index.add("tool", "tool-1.0-cp312-cp312-manylinux2014_aarch64.whl", wheel({
      name: "tool", version: "1.0", tags: ["cp312-cp312-manylinux2014_aarch64"],
      files: { "tool/_n.so": ARM(), "tool-1.0.data/scripts/tool-cli": "#!python\n", "tool-1.0.data/purelib/tool_extra.py": "x", "tool-1.0.data/headers/tool.h": "h" },
    }));
    const pkg = installed({ name: "tool", version: "1.0", tags: X86_TAGS, files: { "tool/_n.so": X86() } });
    const result = await swapToArm64(pkg, index);
    expect(result.reports[0]!.status).toBe("swapped");
    const paths = result.files.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(["bin/tool-cli", "tool_extra.py", "tool/_n.so"]));
    expect(paths).not.toContain("tool-1.0.data/headers/tool.h");
  });

  it("re-runs the classifier the way W2 will: classifyNative on the new list", async () => {
    const index = new FakeWheelIndex();
    index.add("numpy", ARM_FILE, numpyWheel());
    const result = await swapToArm64(numpyInstalled(), index);
    const w2 = classifyNative(result.files);
    expect(w2.native).toBe(true);
    expect(w2.arch).toBe("arm64");
    expect(w2.wheels[0]!.platforms).toEqual(["aarch64"]);
    expect(sha256Hex(result.edits.add[0]!.data)).toHaveLength(64);
  });
});

describe("createPypiJsonIndex", () => {
  const listing = (files: unknown[]): Response => new Response(JSON.stringify({ meta: { "api-version": "1.0" }, name: "numpy", files }), { status: 200, headers: { "content-type": "application/vnd.pypi.simple.v1+json" } });
  const entry = (filename: string, url: string, extra: object = {}): object => ({ filename, url, hashes: { sha256: "b".repeat(64) }, ...extra });

  it("lists files, keeps hashes and yank flags, and asks the JSON index with a normalised name", async () => {
    const seen: string[] = [];
    const index = createPypiJsonIndex({
      fetch: ((url: string, init: RequestInit) => {
        seen.push(`${url} ${(init.headers as Record<string, string>).accept}`);
        return Promise.resolve(listing([entry("numpy-2.5.4-py3-none-any.whl", "https://files.pythonhosted.org/packages/ab/numpy.whl", { yanked: "bad", size: 12 }), entry("evil.whl", "https://evil.example/x.whl"), { filename: "no-hash.whl", url: "https://files.pythonhosted.org/n.whl" }]));
      }) as unknown as typeof fetch,
    });
    const files = await index.listFiles("NumPy_x");
    expect(seen).toEqual(["https://pypi.org/simple/numpy-x/ application/vnd.pypi.simple.v1+json"]);
    expect(files).toEqual([
      { filename: "numpy-2.5.4-py3-none-any.whl", url: "https://files.pythonhosted.org/packages/ab/numpy.whl", sha256: "b".repeat(64), yanked: true, size: 12 },
      { filename: "no-hash.whl", url: "https://files.pythonhosted.org/n.whl", sha256: undefined, yanked: false, size: undefined },
    ]);
  });
  it("returns [] for an unknown project and a fixed error for failures", async () => {
    const make = (status: number): ReturnType<typeof createPypiJsonIndex> => createPypiJsonIndex({ fetch: (() => Promise.resolve(new Response("secret detail", { status }))) });
    expect(await make(404).listFiles("nope")).toEqual([]);
    await expect(make(500).listFiles("nope")).rejects.toMatchObject({ code: "unavailable" });
    const thrown = createPypiJsonIndex({ fetch: (() => Promise.reject(new Error("ECONNREFUSED 10.0.0.1"))) });
    await expect(thrown.listFiles("x")).rejects.toMatchObject({ code: "unavailable", message: "unavailable" });
    await expect(make(200).listFiles("../../x")).rejects.toBeInstanceOf(WheelIndexError);
  });
  it("rejects bodies that are not an index and listings over the cap", async () => {
    const bad = createPypiJsonIndex({ fetch: (() => Promise.resolve(new Response("<html>", { status: 200 }))) });
    await expect(bad.listFiles("x")).rejects.toMatchObject({ code: "bad-response" });
    const big = createPypiJsonIndex({ fetch: (() => Promise.resolve(listing(Array.from({ length: 200 }, (_, i) => entry(`f${i}.whl`, "https://files.pythonhosted.org/f.whl"))))), maxListingBytes: 100 });
    await expect(big.listFiles("x")).rejects.toMatchObject({ code: "too-large" });
  });
  it("follows redirects only to allowed hosts and downloads under a cap", async () => {
    const calls: string[] = [];
    const index = createPypiJsonIndex({
      fetch: ((url: string) => {
        calls.push(url);
        if (url === "https://files.pythonhosted.org/a.whl") return Promise.resolve(new Response(null, { status: 302, headers: { location: "https://files.pythonhosted.org/b.whl" } }));
        if (url === "https://files.pythonhosted.org/b.whl") return Promise.resolve(new Response(new Uint8Array(10), { status: 200 }));
        if (url === "https://files.pythonhosted.org/evil.whl") return Promise.resolve(new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest" } }));
        return Promise.resolve(new Response("x", { status: 404 }));
      }) as unknown as typeof fetch,
    });
    const file = { filename: "a.whl", url: "https://files.pythonhosted.org/a.whl", sha256: undefined, yanked: false, size: undefined };
    expect((await index.download(file, 100)).length).toBe(10);
    await expect(index.download(file, 5)).rejects.toMatchObject({ code: "too-large" });
    await expect(index.download({ ...file, url: "https://files.pythonhosted.org/evil.whl" }, 100)).rejects.toMatchObject({ code: "blocked-host" });
    await expect(index.download({ ...file, url: "http://files.pythonhosted.org/a.whl" }, 100)).rejects.toMatchObject({ code: "blocked-host" });
    await expect(index.download({ ...file, url: "https://user:pw@files.pythonhosted.org/a.whl" }, 100)).rejects.toMatchObject({ code: "blocked-host" });
    expect(calls).not.toContain("https://169.254.169.254/latest");
  });
});

describe("planNodeAddons", () => {
  const pkgJson = (name: string, version: string, optional: Record<string, string> = {}): PackageFileInput => file(`node_modules/${name}/package.json`, JSON.stringify({ name, version, optionalDependencies: optional }));

  it("maps x64 names and paths to their arm64 twins", () => {
    expect(arm64Twin("@img/sharp-linux-x64")).toBe("@img/sharp-linux-arm64");
    expect(arm64Twin("prebuilds/linux-x64/a.node")).toBe("prebuilds/linux-arm64/a.node");
    expect(arm64Twin("c.linux-x64-gnu.node")).toBe("c.linux-arm64-gnu.node");
    expect(arm64Twin("node_modules/x64bit/index.js")).toBeUndefined();
  });
  it("accepts a package that already ships the arm64 twin (prebuildify)", () => {
    const plan = planNodeAddons([pkgJson("bcrypt", "5.1.0"), file("node_modules/bcrypt/prebuilds/linux-x64/bcrypt.node", X86()), file("node_modules/bcrypt/prebuilds/linux-arm64/bcrypt.node", ARM())]);
    expect(plan.packages).toEqual([expect.objectContaining({ name: "bcrypt", status: "arm64-present", fallback: "none" })]);
    expect(plan.allPlanned).toBe(true);
  });
  it("plans the arm64 variant a parent lists in optionalDependencies (napi-rs, sharp, esbuild)", () => {
    const plan = planNodeAddons([
      pkgJson("@napi-rs/canvas", "0.1.5", { "@napi-rs/canvas-linux-x64-gnu": "0.1.5", "@napi-rs/canvas-linux-arm64-gnu": "0.1.5" }),
      pkgJson("@napi-rs/canvas-linux-x64-gnu", "0.1.5"),
      file("node_modules/@napi-rs/canvas-linux-x64-gnu/skia.linux-x64-gnu.node", X86()),
    ]);
    expect(plan.packages).toEqual([expect.objectContaining({
      name: "@napi-rs/canvas-linux-x64-gnu", status: "swap-planned", fallback: "none",
      step: { fetch: { name: "@napi-rs/canvas-linux-arm64-gnu", version: "0.1.5" }, drop: "node_modules/@napi-rs/canvas-linux-x64-gnu" },
    })]);
  });
  it("sends everything else to qemu: unlisted variants, first-party addons, odd manifests", () => {
    const plan = planNodeAddons([
      pkgJson("@napi-rs/canvas", "0.1.5", { "@napi-rs/canvas-linux-x64-gnu": "0.1.5" }),
      pkgJson("@napi-rs/canvas-linux-x64-gnu", "0.1.5"),
      file("node_modules/@napi-rs/canvas-linux-x64-gnu/skia.node", X86()),
      file("build/Release/mine.node", X86()),
      file("node_modules/native-only/package.json", "not json {"),
      file("node_modules/native-only/build/Release/n.node", X86()),
    ]);
    expect(plan.packages.map((p) => [p.name, p.status, p.detail])).toEqual([
      ["", "qemu", "first-party-addon"],
      ["@napi-rs/canvas-linux-x64-gnu", "qemu", "no-arm64-binary-listed"],
      ["native-only", "qemu", "no-arm64-binary-listed"],
    ]);
    expect(plan.allPlanned).toBe(false);
  });
  it("never plans a fetch for a hostile package name or version", () => {
    const plan = planNodeAddons([
      pkgJson("@evil/x-linux-x64", "1.0.0", {}),
      file("node_modules/@evil/p/package.json", JSON.stringify({ name: "@evil/p", version: "1.0.0", optionalDependencies: { "@evil/x-linux-arm64": "1.0.0" } })),
      file("node_modules/@evil/x-linux-x64/package.json", JSON.stringify({ name: "@evil/x-linux-x64", version: "1.0.0; curl evil" })),
      file("node_modules/@evil/x-linux-x64/a.node", X86()),
    ]);
    expect(plan.packages.every((p) => p.status === "qemu")).toBe(true);
    expect(JSON.stringify(plan)).not.toContain("curl");
  });
  it("is empty for a package without addons or with arm64 addons only", () => {
    expect(planNodeAddons([file("index.js", "x"), file("node_modules/a/a.node", ARM())])).toEqual({ packages: [], allPlanned: true });
  });
});
