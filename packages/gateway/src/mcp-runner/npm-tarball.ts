// Stdio MCP host redesign (T3): unpacks the `.tgz` that `npm pack` downloaded, in plain Node, because the runner image has no `tar` program. The archive came from the registry,
// so nothing in it is trusted: it is read with hard limits, and only folders and plain files are created, each at a path that cannot leave the destination.
//
// An npm tarball puts everything under one top folder (usually `package/`); that folder is stripped. Links, hard links, devices and pipes are refused (npm never packs them).
// A `.npmrc` is dropped: npm reads one from the folder it runs in, and a package must not be able to change how its own install runs.
import { constants, createReadStream } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { Writable } from "node:stream";
import { TAR_BLOCK, TarError, decodeHeader, decodePaxBody, isZeroBlock, paddingFor } from "./tar.js";
import { bundlePathProblem } from "./bundle.js";

export type NpmTarballFailure = "bad_package" | "too_large";

export class NpmTarballError extends Error {
  constructor(readonly code: NpmTarballFailure) {
    super(code);
    this.name = "NpmTarballError";
  }
}

export interface NpmTarballLimits { maxEntries: number; maxUnpackedBytes: number }

/** Names that are not unpacked. */
const DROPPED = new Set([".npmrc"]);

/** Gunzips `source` to `destination` (a new file), stopping with `too_large` once more than `maxBytes` have come out: a few kilobytes of gzip can hold gigabytes. */
async function gunzipBounded(source: string, destination: string, maxBytes: number): Promise<void> {
  let total = 0;
  const handle = await open(destination, "wx", 0o600);
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) { callback(new NpmTarballError("too_large")); return; }
      handle.write(chunk).then(() => callback(), (error: unknown) => callback(error instanceof Error ? error : new Error("write failed")));
    },
  });
  try {
    await pipeline(createReadStream(source), createGunzip(), sink);
  } catch (error) {
    if (error instanceof NpmTarballError) throw error;
    throw new NpmTarballError("bad_package");
  } finally {
    await handle.close();
  }
}

/** Unpacks the npm tarball at `tarball` into the (empty or new) folder `destination`. Returns how many files were written and their total size. */
export async function extractNpmTarball(tarball: string, destination: string, workFile: string, limits: NpmTarballLimits): Promise<{ files: number; bytes: number }> {
  // The tar is limited to the content limit plus an allowance for headers: per entry a header, a pax header and its body, and up to a block of padding.
  await gunzipBounded(tarball, workFile, limits.maxUnpackedBytes + limits.maxEntries * 4 * TAR_BLOCK + 2 * TAR_BLOCK);
  const handle = await open(workFile, constants.O_RDONLY);
  let files = 0;
  let bytes = 0;
  let entries = 0;
  try {
    const length = (await handle.stat()).size;
    const read = async (offset: number, size: number): Promise<Buffer> => {
      if (offset + size > length) throw new NpmTarballError("bad_package");
      const buffer = Buffer.alloc(size);
      let done = 0;
      while (done < size) {
        const { bytesRead } = await handle.read(buffer, done, size - done, offset + done);
        if (bytesRead === 0) throw new NpmTarballError("bad_package");
        done += bytesRead;
      }
      return buffer;
    };
    await mkdir(destination, { recursive: true });
    let offset = 0;
    let pax = new Map<string, string>();
    for (;;) {
      if (offset >= length) break; // an archive may end without the zero blocks
      const block = await read(offset, TAR_BLOCK);
      if (isZeroBlock(block)) break;
      const header = decodeHeader(block);
      offset += TAR_BLOCK;
      const padded = header.size + paddingFor(header.size);
      if (header.type === "x" || header.type === "g") {
        if (header.size > 65_536) throw new NpmTarballError("bad_package");
        const records = decodePaxBody(await read(offset, header.size));
        offset += padded;
        if (header.type === "x") pax = records; // a global header (npm writes the git head) applies to nothing we use
        continue;
      }
      entries += 1;
      if (entries > limits.maxEntries) throw new NpmTarballError("too_large");
      const isFile = header.type === "0" || header.type === "\0";
      const isFolder = header.type === "5";
      if (!isFile && !isFolder) throw new NpmTarballError("bad_package");
      const named = pax.get("path") ?? (header.prefix === "" ? header.name : `${header.prefix}/${header.name}`);
      const size = pax.has("size") ? Number(pax.get("size")) : header.size;
      pax = new Map();
      if (!Number.isSafeInteger(size) || size < 0 || (isFolder && size !== 0)) throw new NpmTarballError("bad_package");
      const whole = size + paddingFor(size);
      const segments = (isFolder && named.endsWith("/") ? named.slice(0, -1) : named).split("/");
      // The top folder is stripped. An entry that is only the top folder has nothing to create.
      const relative = segments.slice(1).join("/");
      if (segments.length < 1 || segments[0] === "" || segments[0] === "." || segments[0] === "..") throw new NpmTarballError("bad_package");
      if (relative === "") {
        offset += whole;
        if (isFile) throw new NpmTarballError("bad_package");
        continue;
      }
      if (bundlePathProblem(relative) !== undefined) throw new NpmTarballError("bad_package");
      const target = join(destination, ...relative.split("/"));
      if (isFolder) {
        await mkdir(target, { recursive: true });
        offset += whole;
        continue;
      }
      bytes += size;
      if (bytes > limits.maxUnpackedBytes) throw new NpmTarballError("too_large");
      if (offset + whole > length) throw new NpmTarballError("bad_package");
      if (DROPPED.has(relative.split("/").at(-1)!)) { offset += whole; continue; }
      await mkdir(join(target, ".."), { recursive: true });
      // 'wx': a name that appears twice, or that is already there, is refused rather than overwritten.
      const out = await open(target, "wx", (header.mode & 0o111) !== 0 ? 0o755 : 0o644).catch(() => { throw new NpmTarballError("bad_package"); });
      try {
        let done = 0;
        while (done < size) {
          const chunk = await read(offset + done, Math.min(65_536, size - done));
          await out.write(chunk);
          done += chunk.length;
        }
      } finally {
        await out.close();
      }
      files += 1;
      offset += whole;
    }
    return { files, bytes };
  } catch (error) {
    if (error instanceof NpmTarballError) throw error;
    if (error instanceof TarError) throw new NpmTarballError("bad_package");
    // A name that clashes with a file or folder already made (EEXIST, ENOTDIR, EISDIR) is a bad archive, not a fault of ours.
    if (["EEXIST", "ENOTDIR", "EISDIR"].includes(String((error as { code?: unknown } | null)?.code))) throw new NpmTarballError("bad_package");
    throw error;
  } finally {
    await handle.close();
    await rm(workFile, { force: true });
  }
}
