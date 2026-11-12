// Slice 4 X1: the native-code classifier, the ELF header reader, wheel metadata parsing, wheel tag compatibility, the bounded zip reader and the directory adapter.
// Every binary is built here from a few header bytes.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { directoryInputs } from "../../packages/worker/src/function-runner/directory-inputs.js";
import { inspectHeader } from "../../packages/worker/src/function-runner/elf.js";
import { classifyNative, displayPath, type PackageFileInput } from "../../packages/worker/src/function-runner/native-classify.js";
import {
  expandTags, lambdaGlibc, normalizeProjectName, normalizeVersion, parseMetadataHeaders, parsePlatformTag, parseRecord, parseWheelFile, parseWheelFilename, wheelFit,
} from "../../packages/worker/src/function-runner/wheel-meta.js";
import { ZipError, openZip } from "../../packages/worker/src/function-runner/zip-read.js";
import { ARM, X86, elf, file, text, zip } from "../support/x86-package-fixtures.js";

describe("ELF header", () => {
  it("reads machine, class and endianness", () => {
    expect(inspectHeader(X86(), true)).toMatchObject({ kind: "elf", info: { arch: "x86_64", elfClass: 64, endian: "le", machine: 62 } });
    expect(inspectHeader(ARM(), true)).toMatchObject({ kind: "elf", info: { arch: "arm64", machine: 183 } });
    expect(inspectHeader(elf({ machine: 3, elfClass: 1 }), true)).toMatchObject({ kind: "elf", info: { arch: "other", machine: 3 } });
  });
  it("treats x32, ILP32 and big-endian objects as other", () => {
    expect(inspectHeader(elf({ machine: 62, elfClass: 1 }), false)).toMatchObject({ info: { arch: "other" } });
    expect(inspectHeader(elf({ machine: 183, elfClass: 1 }), false)).toMatchObject({ info: { arch: "other" } });
    expect(inspectHeader(elf({ machine: 183, data: 2 }), false)).toMatchObject({ info: { arch: "other", endian: "be", machine: 183 } });
  });
  it("flags truncated and malformed headers instead of guessing", () => {
    expect(inspectHeader(elf({ machine: 62, length: 19 }), false)).toEqual({ kind: "malformed-elf", reason: "truncated" });
    expect(inspectHeader(Uint8Array.from([0x7f, 0x45, 0x4c, 0x46]), false)).toEqual({ kind: "malformed-elf", reason: "truncated" });
    expect(inspectHeader(elf({ machine: 62, elfClass: 3 as 1 }), false)).toEqual({ kind: "malformed-elf", reason: "bad-class" });
    expect(inspectHeader(elf({ machine: 62, data: 7 as 1 }), false)).toEqual({ kind: "malformed-elf", reason: "bad-data" });
    expect(inspectHeader(elf({ machine: 62, version: 2 }), false)).toEqual({ kind: "malformed-elf", reason: "bad-version" });
    expect(inspectHeader(elf({ machine: 62, type: 0 }), false)).toEqual({ kind: "malformed-elf", reason: "bad-type" });
    expect(inspectHeader(elf({ machine: 62, type: 9 }), false)).toEqual({ kind: "malformed-elf", reason: "bad-type" });
  });
  it("recognises Mach-O and PE only where the evidence is strong enough", () => {
    expect(inspectHeader(Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]), false)).toEqual({ kind: "foreign", format: "macho" });
    expect(inspectHeader(Uint8Array.from([0x4d, 0x5a, 0x90, 0]), false)).toEqual({ kind: "not-native" });
    expect(inspectHeader(Uint8Array.from([0x4d, 0x5a, 0x90, 0]), true)).toEqual({ kind: "foreign", format: "pe" });
    expect(inspectHeader(Uint8Array.from([0xca, 0xfe, 0xba, 0xbe]), false)).toEqual({ kind: "not-native" });
    expect(inspectHeader(new Uint8Array(0), true)).toEqual({ kind: "not-native" });
  });
});

describe("classifyNative", () => {
  it("returns none for pure Python and plain files", () => {
    const result = classifyNative([file("app.py", "print(1)"), file("data.bin", new Uint8Array(100)), file("README", "")]);
    expect(result).toMatchObject({ native: false, arch: "none", offenderCount: 0, complete: true });
  });
  it("classifies x86_64, arm64 and mixed packages", () => {
    expect(classifyNative([file("a/x.so", X86()), file("b/y.so", X86())])).toMatchObject({ native: true, arch: "x86_64", counts: { x86_64: 2, arm64: 0 }, offenderCount: 2 });
    expect(classifyNative([file("a/x.so", ARM())])).toMatchObject({ native: true, arch: "arm64", offenderCount: 0, counts: { arm64: 1 } });
    const mixed = classifyNative([file("a/x.so", ARM()), file("bin/tool", X86())]);
    expect(mixed).toMatchObject({ native: true, arch: "mixed", counts: { arm64: 1, x86_64: 1 } });
    expect(mixed.offenders).toHaveLength(1);
    expect(mixed.offenders[0]).toMatchObject({ path: "bin/tool", kind: "x86_64", elf: { machine: 62 } });
  });
  it("finds ELF files by content, whatever their name", () => {
    expect(classifyNative([file("bin/ffmpeg", X86()), file("lib/libfoo.so.1.2", X86())]).counts.x86_64).toBe(2);
  });
  it("counts an unsupported machine as native and never as clean", () => {
    const result = classifyNative([file("x.so", elf({ machine: 243 }))]);
    expect(result).toMatchObject({ native: true, arch: "mixed", counts: { other: 1 } });
    expect(result.offenders[0]).toMatchObject({ kind: "other-machine" });
  });
  it("does not call malformed, foreign, placeholder or unreadable native files pure", () => {
    const files: PackageFileInput[] = [
      file("trunc.node", elf({ machine: 62, length: 10 })),
      file("mac.node", Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe])),
      file("empty.so", ""),
      { path: "gone.so", size: 10, read: () => { throw new Error("EIO"); } },
    ];
    const result = classifyNative(files);
    expect(result).toMatchObject({ native: true, arch: "mixed", offenderCount: 4 });
    expect(result.offenders.map((o) => o.kind).sort()).toEqual(["foreign-binary", "malformed-elf", "not-an-object", "unreadable"]);
    expect(result.nodeAddons.map((a) => a.arch)).toEqual(["unknown", "unknown"]);
  });
  it("ignores unreadable files that are not native by name", () => {
    expect(classifyNative([{ path: "data.txt", size: 5, read: () => { throw new Error("x"); } }])).toMatchObject({ native: false, arch: "none" });
  });
  it("never trusts a declared size and never reads more than asked", () => {
    const huge = file("x.so", X86(), Number.MAX_SAFE_INTEGER);
    expect(classifyNative([huge]).offenders[0]?.declaredSize).toBe(Number.MAX_SAFE_INTEGER);
    const lie = classifyNative([{ path: "x.so", size: -5, head: X86() }, { path: "y.so", size: Number.NaN, head: X86() }]);
    expect(lie.offenders.map((o) => o.declaredSize)).toEqual([null, null]);
    let asked = 0;
    const reader: PackageFileInput = { path: "z.so", size: 1e12, read: (_offset, length) => { asked = length; return new Uint8Array(1_000_000).fill(0x7f); } };
    const result = classifyNative([reader]);
    expect(asked).toBeLessThanOrEqual(64);
    expect(result.native).toBe(true);
  });
  it("only looks at the first 64 bytes of a long head", () => {
    const head = new Uint8Array(10_000);
    head.set(X86());
    expect(classifyNative([{ path: "a.so", size: 10_000, head }]).arch).toBe("x86_64");
  });
  it("neutralises hostile paths and caps the offender list", () => {
    const evil = `a‮b\u0000c\n${"x".repeat(400)}.so`;
    const result = classifyNative([file(evil, X86())]);
    const shown = result.offenders[0]!.path;
    expect(shown).toContain("[U+202E]");
    expect(shown).toContain("[U+0000]");
    expect(shown).toContain("[U+000A]");
    expect(shown.length).toBeLessThanOrEqual(303);
    expect(displayPath("ok/path.so")).toBe("ok/path.so");
    const many = Array.from({ length: 30 }, (_, i) => file(`m${i}.so`, X86()));
    const capped = classifyNative(many, { maxOffenders: 5 });
    expect(capped.offenders).toHaveLength(5);
    expect(capped.offenderCount).toBe(30);
  });
  it("is not pure when the file list is longer than the bound", () => {
    const result = classifyNative([file("a.py", "x"), file("b.py", "x"), file("c.py", "x")], { maxFiles: 2 });
    expect(result).toMatchObject({ complete: false, native: true, arch: "mixed" });
  });
  it("reads wheel tags from dist-info WHEEL files", () => {
    const wheelText = "Wheel-Version: 1.0\nRoot-Is-Purelib: false\nTag: cp312-cp312-manylinux_2_17_x86_64\nTag: cp312-cp312-manylinux2014_x86_64\n";
    const result = classifyNative([file("numpy-2.0.dist-info/WHEEL", wheelText)]);
    expect(result.wheels).toEqual([{ path: "numpy-2.0.dist-info/WHEEL", tags: ["cp312-cp312-manylinux_2_17_x86_64", "cp312-cp312-manylinux2014_x86_64"], platforms: ["x86_64"], rootIsPurelib: false }]);
    expect(result).toMatchObject({ native: true, arch: "x86_64" });
    const pure = classifyNative([file("six-1.0.dist-info/WHEEL", "Root-Is-Purelib: true\nTag: py2.py3-none-any\n")]);
    expect(pure).toMatchObject({ native: false, arch: "none" });
    expect(pure.wheels[0]).toMatchObject({ platforms: ["any"], rootIsPurelib: true });
    const mixedTags = classifyNative([file("a-1.dist-info/WHEEL", "Tag: cp312-cp312-manylinux_2_17_x86_64\n"), file("b-1.dist-info/WHEEL", "Tag: cp312-cp312-manylinux_2_17_aarch64\n")]);
    expect(mixedTags.arch).toBe("mixed");
  });
  it("lists node addons with the framework layout", () => {
    const result = classifyNative([
      file("node_modules/a/prebuilds/linux-x64/a.node", X86()),
      file("node_modules/a/prebuilds/linux-arm64/a.node", ARM()),
      file("node_modules/@napi-rs/c-linux-x64-gnu/c.linux-x64-gnu.node", X86()),
      file("node_modules/b/lib/binding/b.node", X86()),
      file("build/Release/own.node", X86()),
    ]);
    expect(result.nodeAddons.map((a) => [a.framework, a.arch])).toEqual([["prebuildify", "x86_64"], ["prebuildify", "arm64"], ["napi-rs", "x86_64"], ["node-pre-gyp", "x86_64"], ["unknown", "x86_64"]]);
  });
});

describe("wheel metadata", () => {
  it("parses METADATA headers and stops at the body", () => {
    const headers = parseMetadataHeaders("Metadata-Version: 2.1\r\nName: Foo_Bar\r\nVersion: 1.0\r\n  folded\r\n\r\nName: ignored\r\n");
    expect(headers.get("name")).toBe("Foo_Bar");
    expect(headers.get("version")).toBe("1.0");
    expect(headers.size).toBe(3);
  });
  it("parses WHEEL tags and drops malformed ones", () => {
    expect(parseWheelFile("Tag: cp312-cp312-linux_aarch64\nTag: bogus\nTag: cp3-12\nRoot-Is-Purelib: True\n")).toEqual({ tags: ["cp312-cp312-linux_aarch64"], rootIsPurelib: true });
    expect(parseWheelFile("")).toEqual({ tags: [], rootIsPurelib: undefined });
  });
  it("expands compressed tags and caps the product", () => {
    expect(expandTags("cp312-cp312-manylinux_2_17_x86_64.manylinux2014_x86_64")).toHaveLength(2);
    expect(expandTags("py2.py3-none-any")).toHaveLength(2);
    expect(expandTags("a-b")).toEqual([]);
    const big = `${Array.from({ length: 30 }, (_, i) => `p${i}`).join(".")}-${Array.from({ length: 30 }, (_, i) => `a${i}`).join(".")}-${Array.from({ length: 30 }, (_, i) => `x${i}`).join(".")}`;
    expect(expandTags(big)).toHaveLength(512);
  });
  it("parses wheel file names", () => {
    expect(parseWheelFilename("numpy-2.5.4-cp312-cp312-manylinux_2_27_aarch64.manylinux_2_28_aarch64.whl")).toMatchObject({ name: "numpy", version: "2.5.4", build: undefined, platformTags: ["manylinux_2_27_aarch64", "manylinux_2_28_aarch64"] });
    expect(parseWheelFilename("foo-1.0-3-py3-none-any.whl")?.build).toBe("3");
    expect(parseWheelFilename("foo-1.0-py3-none-any.tar.gz")).toBeUndefined();
    expect(parseWheelFilename("a-b-c.whl")).toBeUndefined();
    expect(parseWheelFilename("../foo-1.0-py3-none-any.whl")).toBeUndefined();
    expect(parseWheelFilename("foo-1.0-x-py3-none-any.whl")).toBeUndefined();
  });
  it("normalises names and versions", () => {
    expect(normalizeProjectName("Foo_Bar.baz--Q")).toBe("foo-bar-baz-q");
    expect(normalizeVersion("V1.0_rc1")).toBe("1.0.rc1");
    expect(normalizeVersion("2.1.0+cpu")).not.toBe(normalizeVersion("2.1.0"));
  });
  it("parses platform tags, legacy manylinux names included", () => {
    expect(parsePlatformTag("manylinux2014_aarch64")).toEqual({ family: "manylinux", arch: "aarch64", glibc: [2, 17] });
    expect(parsePlatformTag("manylinux1_x86_64")).toEqual({ family: "manylinux", arch: "x86_64", glibc: [2, 5] });
    expect(parsePlatformTag("manylinux_2_28_x86_64")).toEqual({ family: "manylinux", arch: "x86_64", glibc: [2, 28] });
    expect(parsePlatformTag("musllinux_1_2_aarch64")).toMatchObject({ family: "musllinux", arch: "aarch64" });
    expect(parsePlatformTag("linux_aarch64")).toMatchObject({ family: "linux", arch: "aarch64" });
    expect(parsePlatformTag("macosx_11_0_arm64")).toMatchObject({ family: "other" });
  });
  it("parses RECORD rows with quoting", () => {
    const rows = parseRecord('a/b.py,sha256=abc,10\n"we,ird.py",,\n"q""uote.py",sha256=z,1\nlast.py,,');
    expect(rows.map((r) => r.path)).toEqual(["a/b.py", "we,ird.py", 'q"uote.py', "last.py"]);
    expect(rows[0]).toEqual({ path: "a/b.py", hash: "sha256=abc", size: "10" });
  });
});

describe("wheel fit", () => {
  const py312 = { python: { major: 3, minor: 12 }, glibc: lambdaGlibc(12) };
  const fit = (name: string, target = py312) => wheelFit(parseWheelFilename(name)!, target);
  it("uses glibc 2.34 for python3.12 and 2.26 below", () => {
    expect(lambdaGlibc(12)).toEqual([2, 34]);
    expect(lambdaGlibc(11)).toEqual([2, 26]);
  });
  it("accepts manylinux levels up to the image glibc and refuses higher or x86", () => {
    expect(fit("numpy-2.5.4-cp312-cp312-manylinux_2_28_aarch64.whl")).toBeDefined();
    expect(fit("numpy-2.5.4-cp312-cp312-manylinux_2_34_aarch64.whl")).toBeDefined();
    expect(fit("numpy-2.5.4-cp312-cp312-manylinux_2_35_aarch64.whl")).toBeUndefined();
    expect(fit("numpy-2.5.4-cp312-cp312-manylinux_2_28_x86_64.whl")).toBeUndefined();
    expect(fit("numpy-2.5.4-cp312-cp312-musllinux_1_2_aarch64.whl")).toBeUndefined();
    expect(fit("numpy-2.5.4-cp312-cp312-macosx_11_0_arm64.whl")).toBeUndefined();
    const al2 = { python: { major: 3, minor: 11 }, glibc: lambdaGlibc(11) };
    expect(fit("psycopg2_binary-2.9.13-cp311-cp311-manylinux_2_28_aarch64.whl", al2)).toBeUndefined();
    expect(fit("lxml-5.0-cp311-cp311-manylinux2014_aarch64.whl", al2)).toBeDefined();
  });
  it("matches CPython versions exactly, stable ABI downwards, and py3-none", () => {
    expect(fit("a-1-cp311-cp311-manylinux2014_aarch64.whl")).toBeUndefined();
    expect(fit("a-1-cp313-cp313-manylinux2014_aarch64.whl")).toBeUndefined();
    expect(fit("a-1-cp39-abi3-manylinux2014_aarch64.whl")).toBeDefined();
    expect(fit("a-1-cp313-abi3-manylinux2014_aarch64.whl")).toBeUndefined();
    expect(fit("a-1-py3-none-manylinux2014_aarch64.whl")).toBeDefined();
    expect(fit("a-1-py3-none-any.whl")).toMatchObject({ pure: true });
    expect(fit("a-1-py2-none-any.whl")).toBeUndefined();
  });
  it("prefers the exact build over abi3 over pure, and the newest glibc level", async () => {
    const { compareFit } = await import("../../packages/worker/src/function-runner/wheel-meta.js");
    const exact = fit("a-1-cp312-cp312-manylinux2014_aarch64.whl")!;
    const abi3 = fit("a-1-cp39-abi3-manylinux_2_28_aarch64.whl")!;
    const pure = fit("a-1-py3-none-any.whl")!;
    const newer = fit("a-1-cp312-cp312-manylinux_2_28_aarch64.whl")!;
    expect(compareFit(exact, abi3)).toBeGreaterThan(0);
    expect(compareFit(abi3, pure)).toBeGreaterThan(0);
    expect(compareFit(newer, exact)).toBeGreaterThan(0);
  });
});

describe("zip reader", () => {
  it("reads stored and deflated members with modes and checks CRC", () => {
    const bytes = zip([{ name: "a/b.txt", data: "hello hello hello hello" }, { name: "c.sh", data: "#!/bin/sh\n", store: true, mode: 0o755 }]);
    const entries = openZip(bytes);
    expect(entries.map((e) => e.name)).toEqual(["a/b.txt", "c.sh"]);
    expect(new TextDecoder().decode(entries[0]!.read())).toBe("hello hello hello hello");
    expect(entries[1]!.mode).toBe(0o755);
    const corrupted = zip([{ name: "x", data: "abcdef", store: true }], (b) => { const out = b.slice(); out[out.indexOf(0x61)] = 0x7a; return out; });
    expect(() => openZip(corrupted)[0]!.read()).toThrowError(expect.objectContaining({ code: "bad-crc" }) as Error);
  });
  it.each([["../evil", "unsafe-path"], ["/abs", "unsafe-path"], ["a\\b", "unsafe-path"], ["a/../b", "unsafe-path"], ["C:x", "unsafe-path"], ["a\u0000b", "unsafe-path"]])("refuses the member name %j", (name, code) => {
    expect(() => openZip(zip([{ name, data: "x" }]))).toThrowError(expect.objectContaining({ code }) as Error);
  });
  it("refuses duplicates, oversized members, too many members, garbage and cut archives", () => {
    expect(() => openZip(zip([{ name: "a", data: "1" }, { name: "a", data: "2" }]))).toThrowError(expect.objectContaining({ code: "duplicate-entry" }) as Error);
    expect(() => openZip(zip([{ name: "a", data: "x".repeat(100) }]), { maxEntries: 10, maxEntryBytes: 50, maxTotalBytes: 1000 })).toThrowError(expect.objectContaining({ code: "too-large" }) as Error);
    expect(() => openZip(zip([{ name: "a", data: "1" }, { name: "b", data: "1" }]), { maxEntries: 1, maxEntryBytes: 50, maxTotalBytes: 1000 })).toThrowError(expect.objectContaining({ code: "too-many-entries" }) as Error);
    expect(() => openZip(text("not a zip at all, but long enough to scan"))).toThrow(ZipError);
    const good = zip([{ name: "a", data: "hello" }]);
    expect(() => openZip(good.subarray(0, good.length - 5))).toThrow(ZipError);
  });
  it("does not inflate past the declared size (zip bomb)", () => {
    const bomb = zip([{ name: "a", data: new Uint8Array(1_000_000) }], (b) => {
      // Lower the declared size in the central directory and the local header to 10 bytes while the stream still inflates to 1 MB.
      const out = b.slice();
      const view = new DataView(out.buffer);
      view.setUint32(22, 10, true);
      const cd = out.length - 22 - 46 - 1;
      view.setUint32(cd + 24, 10, true);
      return out;
    });
    expect(() => openZip(bomb)[0]!.read()).toThrow(ZipError);
  });
  it("refuses an entry whose offsets point outside the archive", () => {
    const bytes = zip([{ name: "a", data: "hello" }], (b) => { const out = b.slice(); const cd = out.length - 22 - 46 - 1; new DataView(out.buffer).setUint32(cd + 42, 0x7ffffff0, true); return out; });
    expect(() => openZip(bytes)[0]!.read()).toThrow(ZipError);
  });
  it("flags symlinks", () => {
    expect(openZip(zip([{ name: "l", data: "target", symlink: true }]))[0]!.symlink).toBe(true);
  });
});

describe("directoryInputs", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  it("lists files with bounded reads, skips symlinks and feeds the classifier", () => {
    const root = mkdtempSync(join(tmpdir(), "x86-dir-"));
    dirs.push(root);
    mkdirSync(join(root, "pkg"));
    writeFileSync(join(root, "pkg", "x.so"), X86());
    writeFileSync(join(root, "app.py"), "print(1)");
    const outside = mkdtempSync(join(tmpdir(), "x86-out-"));
    dirs.push(outside);
    writeFileSync(join(outside, "secret.so"), X86());
    symlinkSync(join(outside, "secret.so"), join(root, "pkg", "link.so"));
    symlinkSync(outside, join(root, "linkdir"));
    const found = directoryInputs(root);
    expect(found.files.map((f) => f.path)).toEqual(["app.py", "pkg/x.so"]);
    expect(found.skipped).toBe(2);
    expect(classifyNative(found.files)).toMatchObject({ native: true, arch: "x86_64" });
    expect(found.files[1]!.read!(0, 4)).toEqual(Uint8Array.from([0x7f, 0x45, 0x4c, 0x46]));
    expect(directoryInputs(root, { maxFiles: 1 })).toMatchObject({ truncated: true });
  });
});
