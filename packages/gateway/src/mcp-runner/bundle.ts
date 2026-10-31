// Stdio MCP host redesign (T2), design section 4 steps 5 and 6: the deterministic bundle. The install task normalises the installed tree and writes it as ONE tar whose bytes depend
// only on the tree's paths, contents and executable bits. The sha256 of that tar is the `bundleHash` the admin's approval binds, and the fetch step (T4) refuses any other bytes.
//
// What makes it deterministic (and so makes the hash mean something):
//   - entries sorted by the bytes of their path; mtime 0; owner 0:0; no owner names; ustar headers; a pax header only for a name that needs one;
//   - modes are not copied: a directory is 0755, a file 0644 (0755 if it had ANY execute bit), a link 0777. So setuid, setgid, sticky and group/world write bits cannot be carried;
//   - only directories, regular files and symbolic links. A device, a socket or a pipe is refused. A hard link is written as the file it is.
//
// What it refuses to read back (readBundleIndex): any archive that is not exactly what writeBundle would write for the same tree. Each header is re-encoded from its parsed
// fields and compared byte for byte, so an archive with another mode, owner, time, order, padding or extra record is not accepted even if its hash were approved.
import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readlink, rm, symlink } from "node:fs/promises";
import { join, posix } from "node:path";
import { TAR_BLOCK, TarError, decodeHeader, decodePaxBody, encodeHeader, encodePaxBody, isZeroBlock, paddingFor } from "./tar.js";

export const BUNDLE_LIMITS = {
  /** Entries (directories, files and links) in one bundle. */
  maxEntries: 200_000,
  /** Total size of the files in one bundle: the design's 300 MB. */
  maxUnpackedBytes: 300 * 1_048_576,
  maxPathBytes: 4_096,
  maxSegmentBytes: 255,
  maxLinkBytes: 1_024,
} as const;

export interface BundleLimits { maxEntries: number; maxUnpackedBytes: number }

export type BundleErrorCode =
  | "too_many_files" | "too_large" | "bad_name" | "special_file" | "link_outside" | "changed_while_reading" | "not_a_directory"
  | "bad_archive" | "hash_mismatch";

/** A bundle that cannot be written or read. The message is a fixed code, never a file name or text from the archive. */
export class BundleError extends Error {
  constructor(readonly code: BundleErrorCode) {
    super(code);
    this.name = "BundleError";
  }
}

export type BundleEntryKind = "file" | "dir" | "symlink";

export interface BundleEntry {
  /** Relative, with `/` separators, no leading or trailing slash. */
  path: string;
  kind: BundleEntryKind;
  /** Bytes of content (files only; 0 otherwise). */
  size: number;
  /** Files only: whether it runs as a program (0755). */
  executable: boolean;
  /** Links only: where it points, relative to its own folder. */
  linkTarget?: string;
  /** Where the content starts in the tar file (files only). */
  dataOffset: number;
}

// ---------------------------------------------------------------------------------------------
// Names and links
// ---------------------------------------------------------------------------------------------

/** Why a relative path may not be in a bundle, or undefined when it may. */
export function bundlePathProblem(path: string): string | undefined {
  if (path === "" || Buffer.byteLength(path) > BUNDLE_LIMITS.maxPathBytes) return "length";
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return "segment";
    if (Buffer.byteLength(segment) > BUNDLE_LIMITS.maxSegmentBytes) return "length";
    for (const char of segment) {
      const code = char.codePointAt(0)!;
      if (code < 0x20 || code === 0x7f || char === "\\" || char === "�") return "character";
    }
  }
  return undefined;
}

/**
 * Whether a symbolic link at `linkPath` may point at `target`. The target is relative, goes up some number of folders (no more than the link is deep) and then only down through
 * plain names. A `..` after a plain name is refused: it would go through a link that points somewhere else and could climb out of the tree by a path no lexical check sees.
 */
export function symlinkProblem(linkPath: string, target: string): string | undefined {
  if (target === "" || Buffer.byteLength(target) > BUNDLE_LIMITS.maxLinkBytes || target.startsWith("/")) return "form";
  const depth = linkPath.split("/").length - 1;
  let ups = 0;
  let down = false;
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") return "form";
    if (segment === "..") {
      if (down) return "form";
      ups += 1;
      continue;
    }
    down = true;
    for (const char of segment) {
      const code = char.codePointAt(0)!;
      if (code < 0x20 || code === 0x7f || char === "\\" || char === "�") return "form";
    }
  }
  return ups > depth ? "outside" : undefined;
}

const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

interface Found { path: string; kind: BundleEntryKind; absolute: string; size: number; executable: boolean; linkTarget?: string }

async function walk(root: string, visit: (found: Found) => Promise<void>, limits: BundleLimits, beforeRead?: (folder: string) => Promise<void>): Promise<void> {
  let count = 0;
  const pending: string[] = [""];
  while (pending.length > 0) {
    const relative = pending.pop()!;
    const folder = relative === "" ? root : join(root, ...relative.split("/"));
    await beforeRead?.(folder);
    for (const name of await readdir(folder)) {
      const path = relative === "" ? name : `${relative}/${name}`;
      if (bundlePathProblem(path) !== undefined) throw new BundleError("bad_name");
      count += 1;
      if (count > limits.maxEntries) throw new BundleError("too_many_files");
      const absolute = join(folder, name);
      const info = await lstat(absolute);
      if (info.isDirectory()) {
        pending.push(path);
        await visit({ path, kind: "dir", absolute, size: 0, executable: false });
      } else if (info.isFile()) {
        await visit({ path, kind: "file", absolute, size: info.size, executable: (info.mode & 0o111) !== 0 });
      } else if (info.isSymbolicLink()) {
        await visit({ path, kind: "symlink", absolute, size: 0, executable: false, linkTarget: await readlink(absolute) });
      } else {
        throw new BundleError("special_file");
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Normalising the installed tree
// ---------------------------------------------------------------------------------------------

/**
 * Makes the installed tree what the bundle will say it is: folders 0755, files 0644 (0755 when they had an execute bit), and no link that leaves the tree. A `.bin` link that
 * points outside (or in a form the bundle does not carry) is removed, as the design says. Any other link of that kind refuses the install: nothing else is expected, so nothing
 * else is guessed at. Returns the paths of the links it removed.
 */
export async function normalizeTree(root: string, limits: BundleLimits = BUNDLE_LIMITS): Promise<string[]> {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory()) throw new BundleError("not_a_directory");
  const removed: string[] = [];
  const found: Found[] = [];
  // A folder is made readable before it is listed (an install under a strict umask can leave one that is not).
  await walk(root, async (item) => { found.push(item); }, limits, async (folder) => { await chmod(folder, 0o755); });
  for (const item of found) {
    if (item.kind === "dir") await chmod(item.absolute, 0o755);
    else if (item.kind === "file") await chmod(item.absolute, item.executable ? 0o755 : 0o644);
    else if (symlinkProblem(item.path, item.linkTarget!) !== undefined) {
      if (!item.path.split("/").slice(0, -1).includes(".bin")) throw new BundleError("link_outside");
      await rm(item.absolute, { force: true });
      removed.push(item.path);
    }
  }
  return removed.sort(byteOrder);
}

// ---------------------------------------------------------------------------------------------
// Writing the tar
// ---------------------------------------------------------------------------------------------

const MODES = { file: 0o644, executable: 0o755, dir: 0o755, symlink: 0o777 } as const;

/** The header block(s) of one entry, exactly as the writer produces them and as the reader expects them (a pax block first when the name or target needs one). */
function entryHeaders(entry: { path: string; kind: BundleEntryKind; size: number; executable: boolean; linkTarget?: string | undefined }): Buffer {
  const name = entry.kind === "dir" ? `${entry.path}/` : entry.path;
  const target = entry.linkTarget ?? "";
  const records: Array<readonly [string, string]> = [];
  const plain = (value: string) => Buffer.byteLength(value) <= 100 && /^[\x20-\x7e]*$/u.test(value);
  if (!plain(name)) records.push(["path", name]);
  if (!plain(target)) records.push(["linkpath", target]);
  // The block a reader that ignores pax would see: a stand-in that is plain ASCII and at most 100 bytes.
  const stand = (value: string) => (plain(value) ? value : Buffer.from(value.replace(/[^\x20-\x7e]/gu, "?")).subarray(0, 100).toString("latin1"));
  const type = entry.kind === "dir" ? "5" : entry.kind === "symlink" ? "2" : "0";
  const mode = entry.kind === "dir" ? MODES.dir : entry.kind === "symlink" ? MODES.symlink : entry.executable ? MODES.executable : MODES.file;
  const main = encodeHeader({ name: stand(name), mode, size: entry.kind === "file" ? entry.size : 0, type, linkname: stand(target) });
  if (records.length === 0) return main;
  const body = encodePaxBody(records);
  return Buffer.concat([encodeHeader({ name: "PaxHeader", mode: 0o644, size: body.length, type: "x" }), body, Buffer.alloc(paddingFor(body.length), 0), main]);
}

export interface BundleInfo {
  /** sha256 of the tar file, 64 lower-case hex characters. */
  bundleHash: string;
  tarBytes: number;
  /** Entries in the tar (folders, files and links). */
  entryCount: number;
  /** Bytes of file content. */
  unpackedBytes: number;
}

/**
 * Writes the deterministic tar of `root` to `destination` (a new file; an existing one is an error) and returns its hash. The tree should have been through `normalizeTree`;
 * a link that does not meet the link rule refuses the bundle.
 */
export async function writeBundle(root: string, destination: string, limits: BundleLimits = BUNDLE_LIMITS): Promise<BundleInfo> {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory()) throw new BundleError("not_a_directory");
  const entries: Found[] = [];
  let unpacked = 0;
  await walk(root, async (item) => {
    if (item.kind === "symlink" && symlinkProblem(item.path, item.linkTarget!) !== undefined) throw new BundleError("link_outside");
    unpacked += item.size;
    if (unpacked > limits.maxUnpackedBytes) throw new BundleError("too_large");
    entries.push(item);
  }, limits);
  entries.sort((a, b) => byteOrder(a.path, b.path));

  const hash = createHash("sha256");
  let written = 0;
  const handle = await open(destination, "wx", 0o600);
  const pending: Buffer[] = [];
  let pendingBytes = 0;
  const flush = async (): Promise<void> => {
    if (pendingBytes === 0) return;
    const chunk = Buffer.concat(pending);
    pending.length = 0;
    pendingBytes = 0;
    let offset = 0;
    while (offset < chunk.length) offset += (await handle.write(chunk, offset, chunk.length - offset)).bytesWritten;
  };
  const put = async (chunk: Buffer): Promise<void> => {
    hash.update(chunk);
    written += chunk.length;
    pending.push(chunk);
    pendingBytes += chunk.length;
    if (pendingBytes >= 1_048_576) await flush();
  };
  try {
    for (const entry of entries) {
      await put(entryHeaders(entry));
      if (entry.kind !== "file") continue;
      const source = await open(entry.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        let copied = 0;
        const buffer = Buffer.allocUnsafe(65_536);
        for (;;) {
          const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) break;
          copied += bytesRead;
          if (copied > entry.size) throw new BundleError("changed_while_reading");
          await put(Buffer.from(buffer.subarray(0, bytesRead)));
        }
        if (copied !== entry.size) throw new BundleError("changed_while_reading");
      } finally {
        await source.close();
      }
      await put(Buffer.alloc(paddingFor(entry.size), 0));
    }
    await put(Buffer.alloc(2 * TAR_BLOCK, 0));
    await flush();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(destination, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return { bundleHash: hash.digest("hex"), tarBytes: written, entryCount: entries.length, unpackedBytes: unpacked };
}

// ---------------------------------------------------------------------------------------------
// Checking and reading the tar
// ---------------------------------------------------------------------------------------------

/** sha256 of a file, read in chunks. */
export async function sha256File(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(65_536);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

/** Throws `hash_mismatch` unless the file's sha256 is `expected` (64 lower-case hex characters). The comparison does not leak how many characters matched. */
export async function assertBundleHash(path: string, expected: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/u.test(expected)) throw new BundleError("hash_mismatch");
  const actual = Buffer.from(await sha256File(path), "hex");
  if (!timingSafeEqual(actual, Buffer.from(expected, "hex"))) throw new BundleError("hash_mismatch");
}

/**
 * Reads the tar at `path` and returns its entries, or throws `bad_archive`. It accepts only an archive exactly as `writeBundle` writes it (see the top of this file), with paths
 * that are safe to create under a folder: no absolute or `..` path, every parent is a folder entry that comes first (so no entry is ever created through a link), no repeated
 * path, links that stay inside. The caller checks the hash first (`assertBundleHash`) and then unpacks only what this returns.
 */
export async function readBundleIndex(path: string, limits: BundleLimits = BUNDLE_LIMITS): Promise<BundleEntry[]> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const length = (await handle.stat()).size;
    const read = async (offset: number, size: number): Promise<Buffer> => {
      if (offset + size > length) throw new BundleError("bad_archive");
      const buffer = Buffer.alloc(size);
      let done = 0;
      while (done < size) {
        const { bytesRead } = await handle.read(buffer, done, size - done, offset + done);
        if (bytesRead === 0) throw new BundleError("bad_archive");
        done += bytesRead;
      }
      return buffer;
    };
    const entries: BundleEntry[] = [];
    const folders = new Set<string>();
    let previous: string | undefined;
    let unpacked = 0;
    let offset = 0;
    for (;;) {
      const first = await read(offset, TAR_BLOCK);
      if (isZeroBlock(first)) {
        // The end: exactly one more zero block and the end of the file.
        if (length !== offset + 2 * TAR_BLOCK || !isZeroBlock(await read(offset + TAR_BLOCK, TAR_BLOCK))) throw new BundleError("bad_archive");
        return entries;
      }
      if (entries.length >= limits.maxEntries) throw new BundleError("too_many_files");
      const raw: Buffer[] = [first];
      let header = decodeHeader(first);
      let cursor = offset + TAR_BLOCK;
      let pax = new Map<string, string>();
      if (header.type === "x") {
        if (header.size === 0 || header.size > 8_192) throw new BundleError("bad_archive");
        const body = await read(cursor, header.size);
        const padding = await read(cursor + header.size, paddingFor(header.size));
        if (!isZeroBlock(padding) && padding.length > 0) throw new BundleError("bad_archive");
        pax = decodePaxBody(body);
        for (const key of pax.keys()) if (key !== "path" && key !== "linkpath") throw new BundleError("bad_archive");
        raw.push(body, padding);
        cursor += header.size + padding.length;
        const next = await read(cursor, TAR_BLOCK);
        if (isZeroBlock(next)) throw new BundleError("bad_archive");
        raw.push(next);
        header = decodeHeader(next);
        cursor += TAR_BLOCK;
      }
      const kind: BundleEntryKind | undefined = header.type === "0" ? "file" : header.type === "5" ? "dir" : header.type === "2" ? "symlink" : undefined;
      if (kind === undefined) throw new BundleError("bad_archive");
      const named = pax.get("path") ?? header.name;
      const path = kind === "dir" ? (named.endsWith("/") ? named.slice(0, -1) : "") : named;
      if (path === "" || bundlePathProblem(path) !== undefined) throw new BundleError("bad_archive");
      const linkTarget = kind === "symlink" ? (pax.get("linkpath") ?? header.linkname) : undefined;
      if (kind === "symlink" && (linkTarget === undefined || symlinkProblem(path, linkTarget) !== undefined)) throw new BundleError("bad_archive");
      if (kind !== "symlink" && (pax.has("linkpath") || header.linkname !== "")) throw new BundleError("bad_archive");
      const size = kind === "file" ? header.size : 0;
      if (kind !== "file" && header.size !== 0) throw new BundleError("bad_archive");
      const executable = kind === "file" && header.mode === MODES.executable;
      // Canonical form: the headers must be byte for byte what the writer would produce for these fields (mode, owner, time, order of records, stand-in names).
      const expected = entryHeaders({ path, kind, size, executable, linkTarget });
      if (!Buffer.concat(raw).equals(expected)) throw new BundleError("bad_archive");
      // Order and parents: strictly ascending, and every parent is a folder that came earlier.
      if (previous !== undefined && byteOrder(previous, path) >= 0) throw new BundleError("bad_archive");
      previous = path;
      const parent = posix.dirname(path);
      if (parent !== "." && !folders.has(parent)) throw new BundleError("bad_archive");
      if (kind === "dir") folders.add(path);
      unpacked += size;
      if (unpacked > limits.maxUnpackedBytes) throw new BundleError("too_large");
      const dataOffset = cursor;
      const padding = paddingFor(size);
      if (size > 0 || padding > 0) {
        if (dataOffset + size + padding > length) throw new BundleError("bad_archive");
        if (padding > 0 && !isZeroBlock(await read(dataOffset + size, padding))) throw new BundleError("bad_archive");
      }
      entries.push({ path, kind, size, executable, ...(linkTarget === undefined ? {} : { linkTarget }), dataOffset });
      offset = dataOffset + size + padding;
    }
  } catch (error) {
    if (error instanceof BundleError) throw error;
    if (error instanceof TarError) throw new BundleError("bad_archive");
    throw error;
  } finally {
    await handle.close();
  }
}

/**
 * Creates the entries of `entries` (from `readBundleIndex`, in its order) under `destination`, a new folder. Folders are 0755 and files 0644 (0755 when the archive says
 * executable), set explicitly so that the process's umask does not change them. Nothing is created through a link: `readBundleIndex` guarantees that every parent is a folder
 * entry, and every file is opened with 'wx', so an existing name is an error rather than an overwrite.
 */
export async function extractBundle(archive: string, destination: string, entries: readonly BundleEntry[]): Promise<void> {
  const source = await open(archive, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.allocUnsafe(65_536);
    for (const entry of entries) {
      const target = join(destination, ...entry.path.split("/"));
      if (entry.kind === "dir") {
        await mkdir(target, { mode: 0o755 });
        await chmod(target, 0o755);
      } else if (entry.kind === "symlink") {
        await symlink(entry.linkTarget!, target);
      } else {
        const out = await open(target, "wx", 0o600);
        try {
          let done = 0;
          while (done < entry.size) {
            const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, entry.size - done), entry.dataOffset + done);
            if (bytesRead === 0) throw new BundleError("bad_archive");
            await out.write(buffer, 0, bytesRead);
            done += bytesRead;
          }
          await out.chmod(entry.executable ? 0o755 : 0o644);
        } finally {
          await out.close();
        }
      }
    }
  } finally {
    await source.close();
  }
}
