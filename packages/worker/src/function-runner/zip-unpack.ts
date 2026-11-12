// The zip unpacker (slice 4, lane W2; ported from the parked s4-runner `unpackFunctionCode`). It judges the zip as a whole (`inspectFunctionZip`) and only then writes it under a folder the caller names. No package text is ever used as
// a host path on its own: every entry name was judged to be plain relative segments, and the destination is built from the target folder plus those segments, then checked again to sit inside it.
//
// Two modes. `fresh` (a function's /var/task, a layer's first unpack): the target must not exist; on any failure the whole target is removed, so a refused archive leaves nothing. `overlay` (a later layer into /opt, the way Lambda
// unpacks layers: in order, later layers win): the target must be a real folder; an entry replaces what is there (a file over a file, a link over a file, a folder over a file; a file over a folder removes the folder), never through a
// link: a path whose parent is a link or file on disk from an earlier layer gets a real folder in its place. A failed overlay is NOT cleaned up here (earlier layers' content is in the same folder): the caller removes the whole tree.
//
// Order of writing: folders and files first (each file created with O_EXCL after the old entry, if any, was removed with lstat semantics, so a link on disk is never followed), links LAST. Nothing is ever written after a link exists, so a
// link can never redirect a write. Files get a fixed mode (0644, or 0755 with an execute bit in the entry's Unix mode), folders 0755, chmod'd explicitly so the process umask does not matter. Nothing here starts a process or reads the network.
import { lstat, mkdir, open, chmod, rm, symlink } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { createInflateRaw, crc32 } from "node:zlib";
import { FunctionCodeError, type FunctionCodeLimits } from "./code-errors.js";
import { inspectFunctionZip, type ZipEntryPlan } from "./zip-judge.js";

export type UnpackMode = "fresh" | "overlay";

export interface UnpackOptions {
  mode?: UnpackMode;
  signal?: AbortSignal;
}

export interface UnpackResult {
  entries: number;
  files: number;
  links: number;
  expandedBytes: number;
}

/**
 * Judges the zip as a whole and only then writes it under `targetDir` (see the file's header for the two modes). Every file's bytes must inflate to exactly its declared size and CRC.
 */
export async function unpackFunctionCode(zip: Buffer, targetDir: string, limits: FunctionCodeLimits, options: UnpackOptions = {}): Promise<UnpackResult> {
  const mode = options.mode ?? "fresh";
  const entries = inspectFunctionZip(zip, limits);
  if (mode === "fresh") {
    try {
      await mkdir(targetDir, { mode: 0o755 });
      await chmod(targetDir, 0o755);
    } catch {
      throw new FunctionCodeError("write_failed");
    }
  } else {
    const info = await lstat(targetDir).catch(() => undefined);
    if (info === undefined || !info.isDirectory()) throw new FunctionCodeError("write_failed");
  }
  try {
    return await writeAll(zip, entries, targetDir, mode, options.signal);
  } catch (error) {
    if (mode === "fresh") await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof FunctionCodeError) throw error;
    throw new FunctionCodeError("write_failed");
  }
}

async function writeAll(zip: Buffer, entries: readonly ZipEntryPlan[], targetDir: string, mode: UnpackMode, signal: AbortSignal | undefined): Promise<UnpackResult> {
  /** Folders (relative paths) this call created or confirmed to be real folders: nothing writes through anything else. */
  const real = new Set<string>([""]);
  const overlay = mode === "overlay";
  const insideTarget = (parts: readonly string[]): string => {
    const destination = join(targetDir, ...parts);
    const rel = relative(targetDir, destination);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new FunctionCodeError("unsafe_entry");
    return destination;
  };
  const ensureDir = async (parts: readonly string[]): Promise<void> => {
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const key = parts.slice(0, depth).join("/");
      if (real.has(key)) continue;
      const destination = insideTarget(parts.slice(0, depth));
      if (overlay) {
        const existing = await lstat(destination).catch(() => undefined);
        if (existing !== undefined && !existing.isDirectory()) await rm(destination, { recursive: true, force: true });
        if (existing === undefined || !existing.isDirectory()) await mkdir(destination, { mode: 0o755 });
      } else {
        await mkdir(destination, { mode: 0o755 });
      }
      await chmod(destination, 0o755);
      real.add(key);
    }
  };
  const clear = async (destination: string): Promise<void> => {
    if (overlay) await rm(destination, { recursive: true, force: true });
  };

  let files = 0;
  let expandedBytes = 0;
  for (const entry of entries) {
    if (signal?.aborted === true) throw new FunctionCodeError("write_failed");
    if (entry.kind === "symlink") continue;
    const parts = entry.path.split("/");
    if (entry.kind === "dir") {
      await ensureDir(parts);
      continue;
    }
    await ensureDir(parts.slice(0, -1));
    const destination = insideTarget(parts);
    await clear(destination);
    expandedBytes += await writeEntry(zip, entry, destination);
    files += 1;
  }
  // Links last: from here nothing is written, so no link can redirect a write.
  let links = 0;
  for (const entry of entries) {
    if (entry.kind !== "symlink") continue;
    if (signal?.aborted === true) throw new FunctionCodeError("write_failed");
    const parts = entry.path.split("/");
    await ensureDir(parts.slice(0, -1));
    const destination = insideTarget(parts);
    await clear(destination);
    await symlink(entry.target!, destination);
    links += 1;
    expandedBytes += entry.uncompressedSize;
  }
  return { entries: entries.length, files, links, expandedBytes };
}

async function writeEntry(zip: Buffer, entry: ZipEntryPlan, destination: string): Promise<number> {
  const source = zip.subarray(entry.dataStart, entry.dataEnd);
  // 'wx' is O_CREAT | O_EXCL: it never follows a link and never overwrites.
  const handle = await open(destination, "wx", 0o600);
  try {
    let written = 0;
    let crc = 0;
    if (entry.method === 0) {
      await handle.write(source);
      written = source.length;
      crc = crc32(source);
    } else {
      const inflate = createInflateRaw({ chunkSize: 64 * 1024 });
      inflate.on("error", () => undefined);
      inflate.end(source);
      try {
        for await (const chunk of inflate as AsyncIterable<Buffer>) {
          written += chunk.length;
          // An entry that inflates past what it declared is a bomb, however small the zip.
          if (written > entry.uncompressedSize) throw new FunctionCodeError("too_large");
          crc = crc32(chunk, crc);
          await handle.write(chunk);
        }
      } catch (error) {
        inflate.destroy();
        if (error instanceof FunctionCodeError) throw error;
        throw new FunctionCodeError("corrupt");
      }
    }
    if (written !== entry.uncompressedSize || crc !== entry.crc32) throw new FunctionCodeError("corrupt");
    await handle.chmod(entry.executable ? 0o755 : 0o644);
    return written;
  } finally {
    await handle.close();
  }
}

