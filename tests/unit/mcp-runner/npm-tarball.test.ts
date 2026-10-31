// Stdio MCP host redesign, task T3: unpacking the registry's tarball in plain Node. The archive is untrusted: only folders and plain files, at paths that stay inside,
// within hard limits.
import { lstat, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NpmTarballError, extractNpmTarball } from "../../../packages/gateway/src/mcp-runner/npm-tarball.js";
import { TAR_BLOCK, encodeHeader, encodePaxBody, paddingFor } from "../../../packages/gateway/src/mcp-runner/tar.js";

let work: string;
beforeEach(async () => { work = await mkdtemp(join(tmpdir(), "npm-tarball-test-")); });
afterEach(async () => { await rm(work, { recursive: true, force: true }); });

interface Spec { name: string; type?: string; mode?: number; content?: string; size?: number; linkname?: string; pax?: Array<[string, string]> }
function tarOf(specs: Spec[]): Buffer {
  const parts: Buffer[] = [];
  for (const spec of specs) {
    const content = Buffer.from(spec.content ?? "");
    if (spec.pax !== undefined) {
      const body = encodePaxBody(spec.pax);
      parts.push(encodeHeader({ name: "PaxHeader", mode: 0o644, size: body.length, type: spec.type === "g" ? "g" : "x" }), body, Buffer.alloc(paddingFor(body.length)));
      if (spec.type === "g") continue;
    }
    parts.push(encodeHeader({ name: spec.name, mode: spec.mode ?? (spec.type === "5" ? 0o755 : 0o644), size: spec.size ?? content.length, type: spec.type ?? "0", linkname: spec.linkname ?? "" }), content, Buffer.alloc(paddingFor(content.length)));
  }
  parts.push(Buffer.alloc(2 * TAR_BLOCK));
  return Buffer.concat(parts);
}
const LIMITS = { maxEntries: 1_000, maxUnpackedBytes: 1_000_000 };
let counter = 0;
async function extract(tar: Buffer | { gz: Buffer }, limits = LIMITS): Promise<{ dest: string; result?: { files: number; bytes: number }; failure?: string }> {
  const archive = join(work, `a-${(counter += 1)}.tgz`);
  await writeFile(archive, "gz" in tar ? tar.gz : gzipSync(tar));
  const dest = join(work, `dest-${counter}`);
  try { return { dest, result: await extractNpmTarball(archive, dest, join(work, `scratch-${counter}.tar`), limits) }; } catch (error) { return { dest, failure: error instanceof NpmTarballError ? error.code : `other:${String(error)}` }; }
}
const listing = async (dest: string): Promise<string[]> => (await readdir(dest, { recursive: true })).sort();

describe("T3 npm tarball: unpacking", () => {
  it("strips the top folder, creates folders and files, and keeps only the execute bit of a mode", async () => {
    const { dest, result, failure } = await extract(tarOf([
      { name: "package/", type: "5" }, { name: "package/package.json", content: '{"name":"x"}' }, { name: "package/bin/", type: "5" },
      { name: "package/bin/run.js", content: "#!/usr/bin/env node\n", mode: 0o4755 }, { name: "package/lib/deep/file.txt", content: "deep", mode: 0o666 },
    ]));
    expect(failure).toBeUndefined();
    expect(result).toEqual({ files: 3, bytes: 12 + 20 + 4 });
    expect(await listing(dest)).toEqual(["bin", "bin/run.js", "lib", "lib/deep", "lib/deep/file.txt", "package.json"]);
    expect(await readFile(join(dest, "lib/deep/file.txt"), "utf8")).toBe("deep");
    expect((await stat(join(dest, "bin/run.js"))).mode & 0o7000).toBe(0);
    expect((await stat(join(dest, "bin/run.js"))).mode & 0o100).toBe(0o100);
    expect((await stat(join(dest, "lib/deep/file.txt"))).mode & 0o111).toBe(0);
  });
  it("accepts a long name given in a pax header and ignores a global header (npm writes the git head in one)", async () => {
    const long = `package/${"d".repeat(120)}/index.js`;
    const { dest, failure } = await extract(tarOf([{ name: "pax_global_header", type: "g", pax: [["comment", "0123456789abcdef"]], content: "" }, { name: long.slice(0, 100), content: "x", pax: [["path", long]] }, { name: "package/package.json", content: "{}" }]));
    expect(failure).toBeUndefined();
    expect(await readFile(join(dest, "d".repeat(120), "index.js"), "utf8")).toBe("x");
  });
  it("does not unpack a .npmrc, at any depth (it would change how the install runs)", async () => {
    const { dest, failure } = await extract(tarOf([{ name: "package/.npmrc", content: "registry=https://evil.example/\n" }, { name: "package/sub/.npmrc", content: "git=/bin/sh\n" }, { name: "package/package.json", content: "{}" }]));
    expect(failure).toBeUndefined();
    expect(await listing(dest)).toEqual(["package.json"]);
  });
  it("accepts an empty package folder", async () => {
    const { result, failure } = await extract(tarOf([{ name: "package/", type: "5" }]));
    expect(failure).toBeUndefined();
    expect(result).toEqual({ files: 0, bytes: 0 });
  });
});

describe("T3 npm tarball: a hostile archive is refused", () => {
  const refused = async (specs: Spec[], limits = LIMITS) => { const { failure, dest } = await extract(tarOf(specs), limits); return { failure, dest }; };
  it("refuses a path that climbs out or is absolute", async () => {
    for (const name of ["package/../../evil", "package/a/../../evil", "/etc/evil", "../evil", "package/./x", "package//x", "", "package/a\\b", "package/a\u0001b"]) {
      expect((await refused([{ name, content: "x" }])).failure, JSON.stringify(name)).toBe("bad_package");
    }
    await expect(lstat(join(work, "evil"))).rejects.toThrow();
  });
  it("refuses links of every kind, devices and pipes", async () => {
    for (const type of ["2", "1", "3", "4", "6", "7"]) expect((await refused([{ name: "package/l", type, linkname: "/etc/passwd" }])).failure, type).toBe("bad_package");
  });
  it("refuses a file that is also a folder, and a name that appears twice", async () => {
    expect((await refused([{ name: "package/a", content: "x" }, { name: "package/a/b", content: "y" }])).failure).toBe("bad_package");
    expect((await refused([{ name: "package/a", content: "x" }, { name: "package/a", content: "y" }])).failure).toBe("bad_package");
  });
  it("refuses a file at the top level with no folder", async () => {
    expect((await refused([{ name: "package", content: "x" }])).failure).toBe("bad_package");
  });
  it("refuses a bad checksum, a truncated archive, a size that runs past the end and something that is not gzip", async () => {
    const good = tarOf([{ name: "package/a", content: "x" }]);
    const flipped = Buffer.from(good);
    flipped[3] = flipped[3]! ^ 1;
    expect((await extract(flipped)).failure).toBe("bad_package");
    expect((await extract(good.subarray(0, 700))).failure).toBe("bad_package");
    expect((await refused([{ name: "package/a", size: 10_000, content: "x" }])).failure).toBe("bad_package");
    expect((await extract({ gz: Buffer.from("this is not gzip") })).failure).toBe("bad_package");
    expect((await extract({ gz: gzipSync(good).subarray(0, 20) })).failure).toBe("bad_package");
  });
  it("stops a gzip bomb by the bytes that come out, not the bytes that go in", async () => {
    const bomb = tarOf([{ name: "package/big", content: "0".repeat(2_000_000) }]);
    const gz = gzipSync(bomb);
    expect(gz.length).toBeLessThan(10_000);
    expect((await extract({ gz }, { maxEntries: 10, maxUnpackedBytes: 100_000 })).failure).toBe("too_large");
    expect((await extract({ gz }, { maxEntries: 10, maxUnpackedBytes: 3_000_000 })).failure).toBeUndefined();
  });
  it("refuses more files than the limit and more content than the limit", async () => {
    const many = Array.from({ length: 6 }, (_, index) => ({ name: `package/f${index}`, content: "x" }));
    expect((await refused(many, { maxEntries: 5, maxUnpackedBytes: 1_000 })).failure).toBe("too_large");
    expect((await refused(many, { maxEntries: 6, maxUnpackedBytes: 5 })).failure).toBe("too_large");
    expect((await refused(many, { maxEntries: 6, maxUnpackedBytes: 6 })).failure).toBeUndefined();
  });
  it("leaves its scratch file removed whether it worked or not", async () => {
    await extract(tarOf([{ name: "package/a", content: "x" }]));
    await extract(Buffer.from("junk"));
    expect((await readdir(work)).filter((name) => name.startsWith("scratch-"))).toEqual([]);
  });
});
