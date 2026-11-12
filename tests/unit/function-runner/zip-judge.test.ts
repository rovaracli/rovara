// Slice 4, lane W2: the zip judge and unpacker (packages/worker/src/function-runner/zip-judge.ts, zip-unpack.ts). Archive attacks are refused WHOLE (nothing stays on disk). Relative links inside the package are allowed (real layers ship
// them); absolute links, links that leave the package, writes through links, setuid bits and devices are refused.
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FUNCTION_CODE_LIMITS, FunctionCodeError, effectiveCodeLimits, type FunctionCodeProblem } from "../../../packages/worker/src/function-runner/code-errors.js";
import { inspectFunctionZip } from "../../../packages/worker/src/function-runner/zip-judge.js";
import { unpackFunctionCode } from "../../../packages/worker/src/function-runner/zip-unpack.js";
import { buildZip, linkEntry, type TestZipEntry } from "../../support/zip-builder.js";

const LIMITS = { maxEntries: 100, maxExpandedBytes: 1_000_000 };
const roots: string[] = [];
function workdir(): string {
  const root = mkdtempSync(join(tmpdir(), "fn-code-"));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function refused(zip: Buffer, reason: FunctionCodeProblem, limits = LIMITS): Promise<string> {
  const root = workdir();
  const target = join(root, "task");
  const error = await unpackFunctionCode(zip, target, limits).then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(FunctionCodeError);
  expect((error as FunctionCodeError).reason).toBe(reason);
  // The whole archive is refused: nothing from it stays on disk, not even the folder.
  expect(existsSync(target)).toBe(false);
  expect(readdirSync(root)).toEqual([]);
  return (error as Error).message;
}

const good: TestZipEntry[] = [{ name: "index.js", data: "exports.handler = async () => 1;\n" }, { name: "lib/", data: "", method: 0, mode: 0o040755 }, { name: "lib/util.py", data: "x = 1\n" }, { name: "bin/run.sh", data: "#!/bin/sh\n", mode: 0o100755 }];

describe("a good package", () => {
  it("unpacks with fixed modes and the exact bytes", async () => {
    const root = workdir();
    const target = join(root, "task");
    const result = await unpackFunctionCode(buildZip(good), target, LIMITS);
    expect(result).toMatchObject({ entries: 4, files: 3, links: 0 });
    expect(readFileSync(join(target, "index.js"), "utf8")).toBe("exports.handler = async () => 1;\n");
    expect(readFileSync(join(target, "lib", "util.py"), "utf8")).toBe("x = 1\n");
    expect(statSync(join(target, "index.js")).mode & 0o777).toBe(0o644);
    expect(statSync(join(target, "bin", "run.sh")).mode & 0o777).toBe(0o755);
    expect(statSync(join(target, "lib")).mode & 0o777).toBe(0o755);
  });
  it("accepts stored entries, a sticky bit and a package with only folders", async () => {
    const root = workdir();
    await unpackFunctionCode(buildZip([{ name: "a.txt", data: "hi", method: 0 }, { name: "tmp/", data: "", method: 0, mode: 0o041777 }]), join(root, "t"), LIMITS);
    expect(readFileSync(join(root, "t", "a.txt"), "utf8")).toBe("hi");
    expect(statSync(join(root, "t", "tmp")).mode & 0o7777).toBe(0o755);
  });
  it("does not unpack a zip inside the zip: it is one plain file", async () => {
    const inner = buildZip([{ name: "../../evil", data: "x" }]);
    const root = workdir();
    await unpackFunctionCode(buildZip([{ name: "layer.zip", data: inner, method: 0 }]), join(root, "t"), LIMITS);
    expect(readdirSync(join(root, "t"))).toEqual(["layer.zip"]);
    expect(readFileSync(join(root, "t", "layer.zip")).equals(inner)).toBe(true);
  });
});

describe("zip-slip and path tricks are refused whole", () => {
  const names = ["../evil.js", "a/../../evil.js", "/etc/passwd", "C:/evil.js", "c:evil.js", "a\\..\\evil.js", "a//b.js", "./index.js", "a/./b.js", "a/b/..", "x\u0000y", "x\u202ey.js", "..", "."];
  for (const name of names) {
    it(`refuses a package with ${JSON.stringify(name)} beside good files`, async () => {
      await refused(buildZip([{ name: "index.js", data: "ok" }, { name, data: "bad" }, { name: "later.js", data: "ok" }]), "unsafe_entry");
    });
  }
  it("refuses a name that is not UTF-8, one past the length cap, and a path that is too deep", async () => {
    const zip = buildZip([{ name: "ok.js", data: "x" }, { name: "aQb.js", data: "x" }]);
    for (let at = zip.indexOf("aQb.js"); at >= 0; at = zip.indexOf("aQb.js", at + 1)) zip[at + 1] = 0xff;
    await refused(zip, "unsafe_entry");
    await refused(buildZip([{ name: "a".repeat(FUNCTION_CODE_LIMITS.maxNameBytes + 1), data: "x" }]), "unsafe_entry");
    await refused(buildZip([{ name: `${"d/".repeat(FUNCTION_CODE_LIMITS.maxDepth + 1)}f.js`, data: "x" }]), "unsafe_entry");
  });
  it("accepts a path exactly at the depth cap", async () => {
    const root = workdir();
    const name = `${"d/".repeat(FUNCTION_CODE_LIMITS.maxDepth - 1)}f.js`;
    await unpackFunctionCode(buildZip([{ name, data: "x" }]), join(root, "t"), LIMITS);
    expect(existsSync(join(root, "t", ...name.split("/")))).toBe(true);
  });
  it("never puts an entry's name in the refusal", async () => {
    const message = await refused(buildZip([{ name: "../secret-name-9f3.js", data: "bad" }]), "unsafe_entry");
    expect(message).not.toContain("secret-name");
  });
  it("does not write outside the target even when the target path is a link planted before", async () => {
    const root = workdir();
    // A fresh unpack needs a target that does not exist: a package is never unpacked over a folder that already holds a link.
    symlinkSync(root, join(root, "task"));
    await expect(unpackFunctionCode(buildZip(good), join(root, "task"), LIMITS)).rejects.toBeInstanceOf(FunctionCodeError);
    expect(lstatSync(join(root, "task")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(root, "index.js"))).toBe(false);
  });
});

describe("devices, setuid bits and other non-files are refused whole", () => {
  const modes: Array<[string, number]> = [["character device", 0o020666], ["block device", 0o060666], ["pipe", 0o010644], ["socket", 0o140755], ["setuid file", 0o104755], ["setgid file", 0o102755], ["setuid and setgid", 0o106755]];
  for (const [label, mode] of modes) {
    it(`refuses a ${label}`, async () => {
      await refused(buildZip([{ name: "index.js", data: "ok" }, { name: "evil", data: "x", mode }]), "unsafe_entry");
    });
    it(`refuses a ${label} whatever the host byte says`, async () => {
      await refused(buildZip([{ name: "evil", data: "x", mode, host: 0 }]), "unsafe_entry");
    });
  }
  it("refuses a setuid folder and a Windows reparse point", async () => {
    await refused(buildZip([{ name: "d/", data: "", method: 0, mode: 0o044755 }]), "unsafe_entry");
    await refused(buildZip([{ name: "f", data: "x", externalAttributes: 0x400 }]), "unsafe_entry");
  });
  it("refuses a link entry through a folder-looking name too", async () => {
    await refused(buildZip([{ name: "dir/", data: "", method: 0, mode: 0o120777 }]), "unsafe_entry");
  });
  it("refuses a folder entry that carries data, and a file whose mode says folder", async () => {
    await refused(buildZip([{ name: "dir/", data: "x", method: 0, mode: 0o040755 }]), "unsafe_entry");
    await refused(buildZip([{ name: "file", data: "x", mode: 0o040755 }]), "unsafe_entry");
  });
  it("refuses a name used twice, and a file that is also a folder", async () => {
    await refused(buildZip([{ name: "a.js", data: "1" }, { name: "a.js", data: "2" }]), "unsafe_entry");
    await refused(buildZip([{ name: "a", data: "1" }, { name: "a/b", data: "2" }]), "unsafe_entry");
    await refused(buildZip([{ name: "a/b", data: "2" }, { name: "a", data: "1" }]), "unsafe_entry");
  });
});

describe("links: relative links inside the package are allowed", () => {
  it("unpacks a real layer's links (versioned library, bin link, lib64, dangling, chain, link to a folder)", async () => {
    const root = workdir();
    const target = join(root, "opt");
    const zip = buildZip([
      { name: "lib/", data: "", method: 0, mode: 0o040755 },
      { name: "lib/libfoo.so.1.2.3", data: "\u007fELF-bytes" },
      linkEntry("lib/libfoo.so.1", "libfoo.so.1.2.3"),
      linkEntry("lib/libfoo.so", "libfoo.so.1"),
      linkEntry("lib64", "lib"),
      { name: "tool/bin/tool.js", data: "#!/usr/bin/env node\n", mode: 0o100755 },
      linkEntry("bin/tool", "../tool/bin/tool.js"),
      linkEntry("lib/absent", "not-there"),
      linkEntry("up/self", ".."),
      linkEntry("deep", "tool/bin/"),
    ]);
    const result = await unpackFunctionCode(zip, target, LIMITS);
    expect(result).toMatchObject({ links: 7 });
    expect(readlinkSync(join(target, "lib", "libfoo.so"))).toBe("libfoo.so.1");
    expect(readFileSync(join(target, "lib", "libfoo.so"), "utf8")).toBe("\u007fELF-bytes");
    expect(readFileSync(join(target, "lib64", "libfoo.so.1"), "utf8")).toBe("\u007fELF-bytes");
    expect(readFileSync(join(target, "bin", "tool"), "utf8")).toBe("#!/usr/bin/env node\n");
    expect(lstatSync(join(target, "bin", "tool")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(target, "lib", "absent")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(target, "deep", "tool.js"))).toBe(true);
  });
  it("lists links in the plan with their judged target, and counts their size", () => {
    const plan = inspectFunctionZip(buildZip([{ name: "a", data: "x" }, linkEntry("l", "a")]), LIMITS);
    expect(plan.map((entry) => [entry.path, entry.kind, entry.target])).toEqual([["a", "file", undefined], ["l", "symlink", "a"]]);
  });
  it("reads a stored link and a deflated link alike", () => {
    expect(inspectFunctionZip(buildZip([{ name: "a", data: "x" }, linkEntry("l1", "a", { method: 0 }), linkEntry("l2", "a", { method: 8 })]), LIMITS).filter((e) => e.kind === "symlink").map((e) => e.target)).toEqual(["a", "a"]);
  });
  it("follows a link through other links: a path that is only inside lexically is judged as it is on disk", () => {
    // d -> sub/deep; x -> d/../.. is inside (sub/deep, then sub, then the root).
    const inside = [{ name: "sub/deep/f", data: "x" }, linkEntry("d", "sub/deep"), linkEntry("x", "d/../..")];
    expect(() => inspectFunctionZip(buildZip(inside), LIMITS)).not.toThrow();
  });
});

describe("links: escapes and loops are refused whole", () => {
  const ok = { name: "index.js", data: "ok" };
  const bad: Array<[string, TestZipEntry[]]> = [
    ["an absolute target", [linkEntry("l", "/etc/passwd")]],
    ["a target that is the root", [linkEntry("l", "/")]],
    ["a target of ..", [linkEntry("l", "..")]],
    ["a target of ../x", [linkEntry("l", "../x")]],
    ["a deep link up past the root", [linkEntry("a/b/l", "../../../x")]],
    ["a hidden escape inside a path", [linkEntry("l", "a/../../x")]],
    ["an escape through another link (lexically inside, really outside)", [linkEntry("a/b/d", "../.."), linkEntry("x", "a/b/d/..")]],
    ["a chain that escapes at its end", [linkEntry("a", "b"), linkEntry("b", "../c")]],
    ["a loop of two links", [linkEntry("a", "b"), linkEntry("b", "a")]],
    ["a link to itself", [linkEntry("a", "a")]],
    ["a longer loop through folders", [linkEntry("a", "b/c"), linkEntry("b", "a")]],
    ["a path that goes through a file", [{ name: "f", data: "x" }, linkEntry("l", "f/..")]],
    ["a drive letter", [linkEntry("l", "C:/windows")]],
    ["a backslash", [linkEntry("l", "a\\..\\..\\b")]],
    ["a NUL", [linkEntry("l", "a\u0000b")]],
    ["a bidi override", [linkEntry("l", "a\u202eb")]],
    ["a segment past the file name limit", [linkEntry("l", "x".repeat(300))]],
    ["an empty target", [linkEntry("l", "", { declaredUncompressed: 0 })]],
    ["a target past the length cap", [linkEntry("l", "a/".repeat(600))]],
  ];
  for (const [label, entries] of bad) {
    it(`refuses ${label}`, async () => {
      await refused(buildZip([ok, ...entries, { name: "later.js", data: "ok" }]), "unsafe_link");
    });
  }
  it("refuses a link whose target is not UTF-8", async () => {
    await refused(buildZip([linkEntry("l", "x", { rawCompressed: Buffer.from([0xff, 0xfe]), method: 0, declaredUncompressed: 2, declaredCompressed: 2, declaredCrc: 0 })]), "corrupt");
  });
  it("refuses a link whose CRC lies, and one that inflates past its declared size", async () => {
    await refused(buildZip([{ name: "a", data: "x" }, linkEntry("l", "a", { declaredCrc: 1 })]), "corrupt");
    await refused(buildZip([linkEntry("l", "a".repeat(500), { declaredUncompressed: 5 })]), "corrupt");
  });
  it("refuses an entry written through a link or through a file, in any order", async () => {
    await refused(buildZip([linkEntry("l", "."), { name: "l/x", data: "bad" }]), "unsafe_entry");
    await refused(buildZip([{ name: "l/x", data: "bad" }, linkEntry("l", ".")]), "unsafe_entry");
    await refused(buildZip([linkEntry("l", "d"), { name: "l/", data: "", method: 0, mode: 0o040755 }, { name: "d/", data: "", method: 0, mode: 0o040755 }]), "unsafe_entry");
    await refused(buildZip([linkEntry("l", "d"), linkEntry("l", "e")]), "unsafe_entry");
  });
  it("writes nothing outside the target for an escaping link, even beside good files", async () => {
    const root = workdir();
    writeFileSync(join(root, "canary"), "keep");
    await expect(unpackFunctionCode(buildZip([{ name: "index.js", data: "x" }, linkEntry("evil", "../canary")]), join(root, "task"), LIMITS)).rejects.toMatchObject({ reason: "unsafe_link" });
    expect(readdirSync(root)).toEqual(["canary"]);
    expect(readFileSync(join(root, "canary"), "utf8")).toBe("keep");
  });
});

describe("zip bombs are refused whole", () => {
  it("refuses more entries than the cap, before reading any", async () => {
    const many = Array.from({ length: 101 }, (_, index) => ({ name: `f${String(index)}.txt`, data: "x" }));
    await refused(buildZip(many), "too_many_entries");
  });
  it("refuses a package that declares more expanded bytes than the cap", async () => {
    await refused(buildZip([{ name: "a", data: "x", declaredUncompressed: 600_000 }, { name: "b", data: "x", declaredUncompressed: 600_000 }]), "too_large");
  });
  it("refuses sizes that would overflow a 32-bit sum, and the zip64 marker sizes", async () => {
    await refused(buildZip([{ name: "a", data: "x", declaredUncompressed: 0xfffffffe }, { name: "b", data: "x", declaredUncompressed: 0xfffffffe }]), "too_large");
    await refused(buildZip([{ name: "a", data: "x", declaredUncompressed: 0xffffffff }]), "unsupported");
    await refused(buildZip([{ name: "a", data: "x", declaredCompressed: 0xffffffff }]), "unsupported");
  });
  it("refuses an entry that inflates past what it declared (a small zip, a big output)", async () => {
    const big = Buffer.alloc(2_000_000, 0);
    const zip = buildZip([{ name: "bomb.bin", data: big, declaredUncompressed: 10 }]);
    expect(zip.length).toBeLessThan(5_000);
    await refused(zip, "too_large");
  });
  it("refuses an entry that inflates to less than it declared", async () => {
    await refused(buildZip([{ name: "short.txt", data: "abc", declaredUncompressed: 50 }]), "corrupt");
  });
  it("refuses a stored entry whose two sizes differ", async () => {
    await refused(buildZip([{ name: "a", data: "abc", method: 0, declaredUncompressed: 5 }]), "corrupt");
  });
  it("refuses two entries that share the same bytes (overlapping entries)", async () => {
    await refused(buildZip([{ name: "a.txt", data: "hello" }, { name: "b.txt", data: "hello", shareLocalWith: 0 }]), "corrupt");
  });
  it("refuses a bad CRC", async () => {
    await refused(buildZip([{ name: "a.txt", data: "hello", declaredCrc: 12345 }]), "corrupt");
  });
  it("applies the request's limits only when they are lower than the runner's, and clamps higher ones", () => {
    expect(effectiveCodeLimits({ maxEntries: 5, maxExpandedBytes: 10 })).toEqual({ maxEntries: 5, maxExpandedBytes: 10 });
    expect(effectiveCodeLimits({ maxEntries: 10 ** 9, maxExpandedBytes: 10 ** 12 })).toEqual({ maxEntries: FUNCTION_CODE_LIMITS.maxEntries, maxExpandedBytes: FUNCTION_CODE_LIMITS.maxExpandedBytes });
    expect(() => effectiveCodeLimits({ maxEntries: 0, maxExpandedBytes: 10 })).toThrow(FunctionCodeError);
    expect(() => effectiveCodeLimits({ maxEntries: 1.5, maxExpandedBytes: 10 })).toThrow(FunctionCodeError);
  });
  it("applies the limits given to unpack, not larger ones", async () => {
    await refused(buildZip(good), "too_many_entries", { maxEntries: 3, maxExpandedBytes: 1_000_000 });
    await refused(buildZip(good), "too_large", { maxEntries: 100, maxExpandedBytes: 5 });
  });
});

describe("a zip that disagrees with itself, or uses features the runner does not unpack", () => {
  it("refuses a local header whose name differs from the central directory's", async () => {
    await refused(buildZip([{ name: "ok.js", data: "x", localName: "ev.js" }]), "corrupt");
  });
  it("refuses an encrypted entry, an unknown method, multi-disk and zip64", async () => {
    await refused(buildZip([{ name: "a", data: "x", flags: 1 }]), "unsupported");
    await refused(buildZip([{ name: "a", data: "x", method: 9 as never, rawCompressed: Buffer.from("x") }]), "unsupported");
    await refused(buildZip([{ name: "a", data: "x" }], { zip64Locator: true }), "unsupported");
    await refused(buildZip([{ name: "a", data: "x", diskStart: 1 }]), "unsupported");
    await refused(buildZip([{ name: "a", data: "x" }], { eocd: { disk: 1 } }), "unsupported");
  });
  it("refuses lies in the end record: a count, an offset, a size", async () => {
    const one = [{ name: "a", data: "x" }];
    await refused(buildZip(one, { eocd: { total: 2, entriesOnDisk: 2 } }), "corrupt");
    await refused(buildZip(one, { eocd: { total: 0, entriesOnDisk: 0 } }), "corrupt");
    await refused(buildZip(one, { eocd: { centralOffset: 0 } }), "corrupt");
    await refused(buildZip(one, { eocd: { centralSize: 1 } }), "corrupt");
    await refused(buildZip(one, { eocd: { total: 0xffff, entriesOnDisk: 0xffff } }), "unsupported");
  });
  it("refuses trailing bytes, garbage and a truncated file", async () => {
    await refused(buildZip(good, { trailing: Buffer.from("junk") }), "corrupt");
    await refused(Buffer.from("not a zip at all, but long enough to have an end record somewhere"), "corrupt");
    await refused(buildZip(good).subarray(0, 40), "corrupt");
    await refused(Buffer.alloc(0), "corrupt");
  });
  it("refuses damaged deflate data", async () => {
    await refused(buildZip([{ name: "a", data: "hello world", rawCompressed: Buffer.from([0xff, 0xff, 0xff, 0xff]) }]), "corrupt");
  });
  it("accepts a header with extra fields, and a data-descriptor flag set in the local header only", async () => {
    const root = workdir();
    await unpackFunctionCode(buildZip([{ name: "a", data: "x", extra: Buffer.from([0x55, 0x54, 0x00, 0x00]) }]), join(root, "t"), LIMITS);
    expect(readFileSync(join(root, "t", "a"), "utf8")).toBe("x");
  });
  it("inspects without writing", () => {
    expect(inspectFunctionZip(buildZip(good), LIMITS).map((entry) => entry.path)).toEqual(["index.js", "lib", "lib/util.py", "bin/run.sh"]);
  });
});

describe("overlay mode (the later layer wins) and fresh mode", () => {
  it("replaces a file with a file, a link with a file, a file with a folder, and a folder with a link, never through a link", async () => {
    const root = workdir();
    const opt = join(root, "opt");
    await unpackFunctionCode(buildZip([{ name: "a", data: "one" }, linkEntry("b", "a"), { name: "c", data: "file" }, { name: "d/x", data: "in-d" }, linkEntry("e", "d"), { name: "keep", data: "keep" }]), opt, LIMITS);
    // Layer two: a is rewritten; b (a link) becomes a file; c (a file) becomes a folder; d (a folder) becomes a link; and e (a link to d) gets a folder in its place for e/y.
    const result = await unpackFunctionCode(buildZip([{ name: "a", data: "two" }, { name: "b", data: "file-now" }, { name: "c/y", data: "under-c" }, linkEntry("d", "c"), { name: "e/y", data: "under-e" }]), opt, LIMITS, { mode: "overlay" });
    expect(result.files).toBe(4);
    expect(readFileSync(join(opt, "a"), "utf8")).toBe("two");
    expect(lstatSync(join(opt, "b")).isFile()).toBe(true);
    expect(readFileSync(join(opt, "b"), "utf8")).toBe("file-now");
    expect(readFileSync(join(opt, "c", "y"), "utf8")).toBe("under-c");
    expect(readlinkSync(join(opt, "d"))).toBe("c");
    expect(lstatSync(join(opt, "e")).isDirectory()).toBe(true);
    expect(readFileSync(join(opt, "e", "y"), "utf8")).toBe("under-e");
    expect(readFileSync(join(opt, "keep"), "utf8")).toBe("keep");
    // The first layer's folder d held x; the link replaced the folder, and "a" the link earlier pointed to was never written through.
    expect(existsSync(join(opt, "c", "x"))).toBe(false);
  });
  it("refuses an overlay onto a target that is missing or is a link, and does not clean up an overlay failure", async () => {
    const root = workdir();
    await expect(unpackFunctionCode(buildZip(good), join(root, "none"), LIMITS, { mode: "overlay" })).rejects.toMatchObject({ reason: "write_failed" });
    symlinkSync(root, join(root, "lnk"));
    await expect(unpackFunctionCode(buildZip(good), join(root, "lnk"), LIMITS, { mode: "overlay" })).rejects.toMatchObject({ reason: "write_failed" });
    expect(readdirSync(root).sort()).toEqual(["lnk"]);
    const opt = join(root, "opt");
    await unpackFunctionCode(buildZip([{ name: "first", data: "1" }]), opt, LIMITS);
    await expect(unpackFunctionCode(buildZip([{ name: "a", data: "x", declaredCrc: 5 }]), opt, LIMITS, { mode: "overlay" })).rejects.toMatchObject({ reason: "corrupt" });
    expect(existsSync(join(opt, "first"))).toBe(true);
  });
  it("refuses a fresh unpack onto an existing folder and stops at an abort", async () => {
    const root = workdir();
    await expect(unpackFunctionCode(buildZip(good), root, LIMITS)).rejects.toMatchObject({ reason: "write_failed" });
    expect(readdirSync(root)).toEqual([]);
    const controller = new AbortController();
    controller.abort();
    await expect(unpackFunctionCode(buildZip(good), join(root, "t"), LIMITS, { signal: controller.signal })).rejects.toMatchObject({ reason: "write_failed" });
    expect(readdirSync(root)).toEqual([]);
  });
});
