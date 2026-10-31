// Stdio MCP host redesign, task T2: the deterministic bundle. The same tree gives the same bytes; any change to a path, a content or an execute bit changes the hash; modes,
// owners and times do not leak in; and an archive that is not exactly what the writer would write is refused when read back.
import { execFile } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUNDLE_LIMITS, BundleError, assertBundleHash, bundlePathProblem, normalizeTree, readBundleIndex, sha256File, symlinkProblem, writeBundle,
} from "../../../packages/gateway/src/mcp-runner/bundle.js";
import { TAR_BLOCK, encodeHeader, encodePaxBody, paddingFor } from "../../../packages/gateway/src/mcp-runner/tar.js";

let work: string;
beforeEach(async () => { work = await mkdtemp(join(tmpdir(), "bundle-test-")); });
afterEach(async () => { await rm(work, { recursive: true, force: true }); });

async function tree(name: string, files: Record<string, string | { content: string; mode: number }>, links: Record<string, string> = {}): Promise<string> {
  const root = join(work, name);
  await mkdir(root, { recursive: true });
  for (const [path, spec] of Object.entries(files)) {
    const file = join(root, path);
    await mkdir(join(file, ".."), { recursive: true });
    const { content, mode } = typeof spec === "string" ? { content: spec, mode: 0o644 } : spec;
    await writeFile(file, content);
    await chmod(file, mode);
  }
  for (const [path, target] of Object.entries(links)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await symlink(target, join(root, path));
  }
  return root;
}
const FILES = { "package.json": '{"name":"x"}', "bin/run.js": { content: "#!/usr/bin/env node\nconsole.log(1)\n", mode: 0o755 }, "node_modules/dep/index.js": "module.exports = 1\n", "node_modules/dep/package.json": "{}" };
let counter = 0;
const out = (): string => join(work, `out-${(counter += 1)}.tar`);
async function bundleOf(root: string): Promise<{ hash: string; file: string }> {
  const file = out();
  const info = await writeBundle(root, file);
  expect(info.bundleHash).toBe(await sha256File(file));
  return { hash: info.bundleHash, file };
}
const tar = (...args: string[]) => new Promise<string>((resolve, reject) => { execFile("tar", args, (error, stdout) => (error ? reject(error instanceof Error ? error : new Error("tar failed")) : resolve(stdout))); });
const code = async (promise: Promise<unknown>): Promise<string> => promise.then(() => "no error", (error: unknown) => (error instanceof BundleError ? error.code : `other:${String(error)}`));

describe("T2 bundle: deterministic bytes", () => {
  it("gives the same hash for the same tree, however and whenever it was made", async () => {
    const a = await tree("a", FILES);
    const b = await tree("b", Object.fromEntries(Object.entries(FILES).reverse()));
    await utimes(join(b, "package.json"), new Date(86_400_000), new Date(86_400_000));
    await chmod(join(b, "package.json"), 0o600); // a mode other than the two kept ones does not matter
    await chmod(join(b, "node_modules"), 0o700);
    expect((await bundleOf(a)).hash).toBe((await bundleOf(b)).hash);
    expect((await bundleOf(a)).hash).toBe((await bundleOf(a)).hash);
  });
  it("matches a known value, so a change of the format is a visible, deliberate change", async () => {
    // (Cross-checked against Python's tarfile writing the same four entries in ustar format: every header field is equal except devmajor and devminor, which tarfile leaves NUL and GNU tar writes as zeros, as this does.)
    const root = await tree("golden", { "a.txt": "hello\n", "bin/x.js": { content: "x\n", mode: 0o755 } }, { "link": "a.txt" });
    expect((await bundleOf(root)).hash).toBe("b0bd85ac2ba32b882813325359689f4219c8204e7a0d3293ef64a4780032931e");
  });
  it("changes with a content byte, a name, an added file, an execute bit, and a link target", async () => {
    const base = (await bundleOf(await tree("base", FILES, { "node_modules/.bin/run": "../../bin/run.js" }))).hash;
    const variants: Array<[string, Record<string, string | { content: string; mode: number }>, Record<string, string>]> = [
      ["content", { ...FILES, "package.json": '{"name":"y"}' }, { "node_modules/.bin/run": "../../bin/run.js" }],
      ["name", Object.fromEntries(Object.entries(FILES).map(([k, v]) => [k === "package.json" ? "package2.json" : k, v])), { "node_modules/.bin/run": "../../bin/run.js" }],
      ["an added file", { ...FILES, "extra.txt": "" }, { "node_modules/.bin/run": "../../bin/run.js" }],
      ["a lost execute bit", { ...FILES, "bin/run.js": { content: "#!/usr/bin/env node\nconsole.log(1)\n", mode: 0o644 } }, { "node_modules/.bin/run": "../../bin/run.js" }],
      ["a gained execute bit", { ...FILES, "package.json": { content: '{"name":"x"}', mode: 0o755 } }, { "node_modules/.bin/run": "../../bin/run.js" }],
      ["a link target", FILES, { "node_modules/.bin/run": "../dep/index.js" }],
      ["no link", FILES, {}],
    ];
    const seen = new Set([base]);
    for (const [label, files, links] of variants) {
      const hash = (await bundleOf(await tree(`v-${label.replaceAll(" ", "-")}`, files, links))).hash;
      expect(hash, label).not.toBe(base);
      seen.add(hash);
    }
    expect(seen.size).toBe(variants.length + 1);
  });
  it("keeps only the execute bit of a mode: setuid, setgid, sticky and write bits cannot be carried, and the index says 0644 or 0755 only", async () => {
    const root = await tree("modes", { "plain": { content: "p", mode: 0o666 }, "suid": { content: "s", mode: 0o4755 }, "sgid": { content: "g", mode: 0o2644 }, "exec": { content: "e", mode: 0o700 } });
    await chmod(join(root, "suid"), 0o4755);
    const { file, hash } = await bundleOf(root);
    const index = await readBundleIndex(file);
    expect(Object.fromEntries(index.map((entry) => [entry.path, entry.executable]))).toEqual({ plain: false, suid: true, sgid: false, exec: true });
    const raw = await readFile(file);
    for (let offset = 0; offset < raw.length - 1024; offset += TAR_BLOCK) {
      const block = raw.subarray(offset, offset + TAR_BLOCK);
      if (block.subarray(257, 262).toString("latin1") === "ustar") expect(["0000644", "0000755", "0000777"]).toContain(block.toString("latin1", 100, 107));
    }
    expect(hash).toBe((await bundleOf(await tree("modes2", { "plain": "p", "suid": { content: "s", mode: 0o755 }, "sgid": "g", "exec": { content: "e", mode: 0o755 } }))).hash);
  });
  it("writes mtime 0, owner 0:0 and no owner names", async () => {
    const root = await tree("meta", { "f": "x" });
    await utimes(join(root, "f"), new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    const raw = await readFile((await bundleOf(root)).file);
    const header = raw.subarray(0, TAR_BLOCK);
    expect(header.toString("latin1", 108, 115)).toBe("0000000");
    expect(header.toString("latin1", 116, 123)).toBe("0000000");
    expect(header.toString("latin1", 136, 147)).toBe("00000000000");
    expect(header.subarray(265, 329).every((byte) => byte === 0)).toBe(true);
  });
  it("is a tar the system's tar can read, with the entries in byte order and long and non-ASCII names intact", async () => {
    const longName = `node_modules/${"d".repeat(60)}/${"e".repeat(60)}/file-${"é".repeat(10)}.js`;
    const root = await tree("long", { "b.txt": "b", "a.txt": "a", "a-b.txt": "ab", [longName]: "L" }, { "a/l": "../a.txt" });
    const { file } = await bundleOf(root);
    // (macOS file systems may hand back a decomposed form of "é"; Linux keeps the bytes as they were written. Compare in one form.)
    const listing = (await tar("-tf", file)).split("\n").filter(Boolean).map((name) => name.normalize("NFC"));
    // byte order of the bare path: a folder comes before its own children, and "-" and "." sort before "/"
    expect(listing.slice(0, 5)).toEqual(["a/", "a-b.txt", "a.txt", "a/l", "b.txt"]);
    expect(listing).toContain(`${longName.split("/").slice(0, -1).join("/")}/`);
    expect(listing).toContain(longName);
    const index = await readBundleIndex(file);
    expect(index.find((entry) => entry.path.normalize("NFC") === longName)).toMatchObject({ kind: "file", size: 1 });
    expect(index.find((entry) => entry.path === "a/l")).toMatchObject({ kind: "symlink", linkTarget: "../a.txt" });
  });
  it("round-trips contents: every file's bytes are at its data offset", async () => {
    const { file } = await bundleOf(await tree("rt", FILES));
    const raw = await readFile(file);
    for (const entry of await readBundleIndex(file)) if (entry.kind === "file") expect(raw.subarray(entry.dataOffset, entry.dataOffset + entry.size).toString()).toBe(typeof FILES[entry.path as keyof typeof FILES] === "string" ? FILES[entry.path as keyof typeof FILES] : (FILES[entry.path as keyof typeof FILES] as { content: string }).content);
  });
  it("copies a hard link as the file it is, and refuses a pipe or a socket", async () => {
    const root = await tree("hard", { "one.txt": "same" });
    await link(join(root, "one.txt"), join(root, "two.txt"));
    const index = await readBundleIndex((await bundleOf(root)).file);
    expect(index.filter((entry) => entry.kind === "file").map((entry) => [entry.path, entry.size])).toEqual([["one.txt", 4], ["two.txt", 4]]);
    const { createServer } = await import("node:net");
    const socketRoot = await tree("sock", { "f": "x" });
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(join(socketRoot, "s"), resolve));
    try { expect(await code(writeBundle(socketRoot, out()))).toBe("special_file"); } finally { server.close(); }
  });
  it("refuses an existing destination and leaves no partial file after a failure", async () => {
    const root = await tree("dest", { "f": "x" });
    const file = out();
    await writeFile(file, "taken");
    expect(await code(writeBundle(root, file))).toBe("other:Error: EEXIST: file already exists, open '" + file + "'");
    expect(await readFile(file, "utf8")).toBe("taken");
    const bad = await tree("bad", { "f": "x" }, { "l": "/etc/passwd" });
    const failed = out();
    expect(await code(writeBundle(bad, failed))).toBe("link_outside");
    await expect(readFile(failed)).rejects.toThrow();
  });
});

describe("T2 bundle: bounds", () => {
  it("refuses more files than the limit and more bytes than the limit, before writing a complete archive", async () => {
    const root = await tree("many", { "a": "1", "b": "2", "c": "3" });
    expect(await code(writeBundle(root, out(), { maxEntries: 2, maxUnpackedBytes: 1_000 }))).toBe("too_many_files");
    expect(await code(writeBundle(root, out(), { maxEntries: 10, maxUnpackedBytes: 2 }))).toBe("too_large");
    expect(await code(writeBundle(root, out(), { maxEntries: 3, maxUnpackedBytes: 3 }))).toBe("no error");
    expect(BUNDLE_LIMITS.maxUnpackedBytes).toBe(300 * 1_048_576);
  });
  it("refuses a file that grows or shrinks while it is read", async () => {
    // A file longer than one read, then cut short between the size check and the copy, would otherwise be written with the wrong length.
    const root = await tree("grow", { "f": "x".repeat(200_000) });
    const info = await writeBundle(root, out());
    expect(info.unpackedBytes).toBe(200_000);
    await truncate(join(root, "f"), 10);
    expect((await writeBundle(root, out())).unpackedBytes).toBe(10);
  });
  it("refuses names that cannot be created safely", async () => {
    for (const bad of ["a\u0001b", "a\\b", "a\nb"]) {
      const root = await tree(`n-${bad.length}-${bad.charCodeAt(1)}`, { [bad]: "x" });
      expect(await code(writeBundle(root, out())), JSON.stringify(bad)).toBe("bad_name");
    }
    for (const bad of ["", "/a", "a/", "a//b", "a/./b", "a/../b", "..", "x".repeat(256), `${"a/".repeat(2_100)}z`]) expect(bundlePathProblem(bad), bad.slice(0, 20)).toBeDefined();
    for (const good of ["a", "a/b.c", "@scope/pkg/index.js", "ünï/cødé"]) expect(bundlePathProblem(good), good).toBeUndefined();
  });
});

describe("T2 bundle: links", () => {
  it("accepts a link that stays in the tree and refuses every other form", () => {
    expect(symlinkProblem("node_modules/.bin/run", "../pkg/bin/run.js")).toBeUndefined();
    expect(symlinkProblem("a/l", "../a.txt")).toBeUndefined();
    expect(symlinkProblem("l", "target")).toBeUndefined();
    expect(symlinkProblem("a/b/l", "../../x/y")).toBeUndefined();
    for (const target of ["", "/etc/passwd", "../x", "../../../x", "a/../../x", "a/../b", "./a", "a/./b", "a//b", "a/", "a\\b", "a\u0000b"]) {
      expect(symlinkProblem("l", target), JSON.stringify(target)).toBeDefined();
    }
    // The case a lexical check gets wrong: up through a link that points somewhere deeper. Any `..` after a name is refused.
    expect(symlinkProblem("a/b/c", "../../../x")).toBe("outside");
    expect(symlinkProblem("a/b/c/d", "b/../../../x")).toBe("form");
  });
  it("normalizeTree removes a .bin link that leaves the tree, keeps one that does not, and refuses any other link that leaves it", async () => {
    const root = await tree("links", { "node_modules/pkg/bin.js": { content: "x", mode: 0o755 } }, {
      "node_modules/.bin/ok": "../pkg/bin.js", "node_modules/.bin/out": "../../../../etc/passwd", "node_modules/.bin/abs": "/usr/bin/env", "node_modules/.bin/odd": "../pkg/../pkg/bin.js",
    });
    expect(await normalizeTree(root)).toEqual(["node_modules/.bin/abs", "node_modules/.bin/odd", "node_modules/.bin/out"]);
    expect((await readBundleIndex((await bundleOf(root)).file)).filter((entry) => entry.kind === "symlink").map((entry) => entry.path)).toEqual(["node_modules/.bin/ok"]);
    const other = await tree("links2", { "f": "x" }, { "sneaky": "../../outside" });
    expect(await code(normalizeTree(other))).toBe("link_outside");
  });
  it("normalizeTree sets folders to 0755 and files to 0644 or 0755, strips setuid, and makes an unreadable folder readable", async () => {
    const root = await tree("norm", { "d/f": { content: "x", mode: 0o4777 }, "d/g": { content: "y", mode: 0o600 } });
    await chmod(join(root, "d"), 0o000);
    await normalizeTree(root);
    const { stat } = await import("node:fs/promises");
    expect((await stat(join(root, "d"))).mode & 0o7777).toBe(0o755);
    expect((await stat(join(root, "d/f"))).mode & 0o7777).toBe(0o755);
    expect((await stat(join(root, "d/g"))).mode & 0o7777).toBe(0o644);
  });
});

// ---------------------------------------------------------------------------------------------
// Reading back: hostile archives
// ---------------------------------------------------------------------------------------------

interface Spec { name: string; type?: string; mode?: number; size?: number; content?: string; linkname?: string; pax?: Array<[string, string]> }
/** Builds an archive from specs with no checking, so a test can make one the writer never would. */
function craft(specs: Spec[], tail: Buffer = Buffer.alloc(2 * TAR_BLOCK, 0)): Buffer {
  const parts: Buffer[] = [];
  for (const spec of specs) {
    const content = Buffer.from(spec.content ?? "");
    if (spec.pax !== undefined) {
      const body = encodePaxBody(spec.pax);
      parts.push(encodeHeader({ name: "PaxHeader", mode: 0o644, size: body.length, type: "x" }), body, Buffer.alloc(paddingFor(body.length)));
    }
    parts.push(encodeHeader({ name: spec.name, mode: spec.mode ?? (spec.type === "5" ? 0o755 : 0o644), size: spec.size ?? content.length, type: spec.type ?? "0", linkname: spec.linkname ?? "" }), content, Buffer.alloc(paddingFor(content.length)));
  }
  parts.push(tail);
  return Buffer.concat(parts);
}
async function read(archive: Buffer): Promise<string> {
  const file = out();
  await writeFile(file, archive);
  return code(readBundleIndex(file));
}
const dir = (name: string): Spec => ({ name: `${name}/`, type: "5", size: 0 });

describe("T2 bundle: an archive that is not exactly what the writer writes is refused", () => {
  it("reads a well-formed archive (positive control for the cases below)", async () => {
    expect(await read(craft([dir("a"), { name: "a/f", content: "x" }, { name: "a/l", type: "2", size: 0, linkname: "f", mode: 0o777 }]))).toBe("no error");
    expect(await read(craft([]))).toBe("no error");
  });
  it("refuses a path that climbs out, is absolute, or is not clean", async () => {
    for (const name of ["../evil", "a/../../evil", "/etc/evil", "./f", "a//f", "f/", "", "a/./f"]) {
      expect(await read(craft([dir("a"), { name }])), name).toBe("bad_archive");
    }
  });
  it("refuses an entry whose parent folder is missing, comes later, or is a link (nothing can be written through a link)", async () => {
    expect(await read(craft([{ name: "a/f", content: "x" }]))).toBe("bad_archive");
    expect(await read(craft([{ name: "l", type: "2", size: 0, linkname: ".", mode: 0o777 }, { name: "l/f", content: "x" }]))).toBe("bad_archive");
    expect(await read(craft([{ name: "d/f", content: "x" }, dir("d")]))).toBe("bad_archive");
  });
  it("refuses links that leave the tree, that are absolute, or that climb after a name", async () => {
    for (const linkname of ["/etc/passwd", "../../x", "a/../../x", "../../../../x", ""]) {
      expect(await read(craft([dir("a"), { name: "a/l", type: "2", size: 0, linkname, mode: 0o777 }])), linkname).toBe("bad_archive");
    }
  });
  it("refuses hard links, devices, pipes, global headers and any type but file, folder and symbolic link", async () => {
    for (const type of ["1", "3", "4", "6", "7", "g", "L", "K", "x"]) expect(await read(craft([{ name: "t", type, size: 0 }])), type).toBe("bad_archive");
  });
  it("refuses modes that carry setuid, setgid, sticky or write bits, and any mode but the three kept", async () => {
    for (const mode of [0o4755, 0o2755, 0o1755, 0o777, 0o666, 0o600, 0o700, 0o000]) expect(await read(craft([{ name: "f", content: "x", mode }])), mode.toString(8)).toBe("bad_archive");
    expect(await read(craft([{ name: "d/", type: "5", size: 0, mode: 0o700 }]))).toBe("bad_archive");
    expect(await read(craft([{ name: "l", type: "2", size: 0, linkname: "x", mode: 0o755 }]))).toBe("bad_archive");
  });
  it("refuses entries out of order, repeated, or not strictly ascending", async () => {
    expect(await read(craft([{ name: "b", content: "x" }, { name: "a", content: "x" }]))).toBe("bad_archive");
    expect(await read(craft([{ name: "a", content: "x" }, { name: "a", content: "y" }]))).toBe("bad_archive");
    expect(await read(craft([dir("a"), { name: "a", content: "x" }]))).toBe("bad_archive");
  });
  it("refuses an owner, a time or a name that is not the one the writer uses", async () => {
    const good = craft([{ name: "f", content: "x" }]);
    const withField = (offset: number, text: string): Buffer => {
      const copy = Buffer.from(good);
      copy.write(text, offset, "latin1");
      const sum = copy.subarray(0, TAR_BLOCK).reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 0x20 : byte), 0);
      copy.write(sum.toString(8).padStart(6, "0"), 148, "latin1");
      return copy;
    };
    expect(await read(withField(108, "0000001"))).toBe("bad_archive"); // uid
    expect(await read(withField(116, "0000001"))).toBe("bad_archive"); // gid
    expect(await read(withField(136, "00000000001"))).toBe("bad_archive"); // mtime
    expect(await read(withField(265, "root"))).toBe("bad_archive"); // uname
    expect(await read(withField(345, "pre"))).toBe("bad_archive"); // prefix
    expect(await read(withField(257, "GNUtar"))).toBe("bad_archive"); // magic
  });
  it("refuses a bad checksum, a truncated archive, trailing data and a missing end", async () => {
    const good = craft([{ name: "f", content: "x" }]);
    const flipped = Buffer.from(good);
    flipped[0] = flipped[0]! ^ 1;
    expect(await read(flipped)).toBe("bad_archive");
    expect(await read(good.subarray(0, good.length - 1))).toBe("bad_archive");
    expect(await read(good.subarray(0, good.length - 2 * TAR_BLOCK))).toBe("bad_archive");
    expect(await read(Buffer.concat([good, Buffer.alloc(TAR_BLOCK, 0)]))).toBe("bad_archive");
    expect(await read(Buffer.concat([good, Buffer.from("junk")]))).toBe("bad_archive");
    expect(await read(craft([{ name: "f", content: "x" }], Buffer.alloc(TAR_BLOCK, 0)))).toBe("bad_archive");
    expect(await read(craft([{ name: "f", size: 5000, content: "x" }]))).toBe("bad_archive");
    expect(await read(Buffer.alloc(0))).toBe("bad_archive");
  });
  it("refuses content padding that is not zero", async () => {
    const good = craft([{ name: "f", content: "x" }]);
    good[TAR_BLOCK + 1] = 1;
    expect(await read(good)).toBe("bad_archive");
  });
  it("refuses pax records other than path and linkpath, repeated records, a pax path that does not fit, and a stand-in name that is not the canonical one", async () => {
    expect(await read(craft([{ name: "f", content: "x", pax: [["uid", "1"]] }]))).toBe("bad_archive");
    expect(await read(craft([{ name: "f", content: "x", pax: [["mtime", "5"]] }]))).toBe("bad_archive");
    expect(await read(craft([{ name: "f", content: "x", pax: [["path", "f"], ["path", "g"]] }]))).toBe("bad_archive");
    expect(await read(craft([{ name: "decoy", content: "x", pax: [["path", "real"]] }]))).toBe("bad_archive");
    expect(await read(craft([{ name: "f", content: "x", pax: [["path", "../escape"]] }]))).toBe("bad_archive");
    const longName = `${"d".repeat(120)}`;
    expect(await read(craft([{ name: longName.slice(0, 100), content: "x", pax: [["path", longName]] }]))).toBe("no error");
  });
  it("refuses too many entries and too many bytes", async () => {
    const file = out();
    await writeFile(file, craft([{ name: "a", content: "1" }, { name: "b", content: "22" }]));
    expect(await code(readBundleIndex(file, { maxEntries: 1, maxUnpackedBytes: 100 }))).toBe("too_many_files");
    expect(await code(readBundleIndex(file, { maxEntries: 10, maxUnpackedBytes: 2 }))).toBe("too_large");
    expect(await code(readBundleIndex(file, { maxEntries: 2, maxUnpackedBytes: 3 }))).toBe("no error");
  });
  it("refuses a link as the archive file itself (it is opened without following links)", async () => {
    const real = out();
    await writeFile(real, craft([]));
    const alias = join(work, "alias.tar");
    await symlink(real, alias);
    await expect(readBundleIndex(alias)).rejects.toThrow();
    await expect(sha256File(alias)).rejects.toThrow();
  });
});

describe("T2 bundle: the hash is checked before anything is used", () => {
  it("accepts the right hash and refuses any other, a changed byte, and a malformed hash", async () => {
    const { file, hash } = await bundleOf(await tree("hash", FILES));
    await expect(assertBundleHash(file, hash)).resolves.toBeUndefined();
    for (const wrong of ["0".repeat(64), hash.toUpperCase(), hash.slice(1), `${hash}0`, "", "sha256-abc"]) expect(await code(assertBundleHash(file, wrong)), wrong.slice(0, 12)).toBe("hash_mismatch");
    const raw = await readFile(file);
    raw[raw.length - 2000] = raw[raw.length - 2000]! ^ 1;
    const tampered = out();
    await writeFile(tampered, raw);
    expect(await code(assertBundleHash(tampered, hash))).toBe("hash_mismatch");
  });
});
