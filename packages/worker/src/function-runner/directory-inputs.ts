// Slice 4 X1: the files of an unpacked package folder as classifier input. Reads are bounded and synchronous; a symbolic link is left out (and counted) and is never
// followed (a link out of the package must not be read as package content); names the walk cannot represent safely are skipped.
import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { constants } from "node:fs";
import { join } from "node:path";
import { ELF_HEAD_BYTES } from "./elf.js";
import type { PackageFileInput } from "./native-classify.js";

export interface DirectoryInputOptions {
  /** Files listed. Default 500,000; beyond it the walk stops and `truncated` is true. */
  readonly maxFiles?: number;
  /** Folder depth. Default 64. */
  readonly maxDepth?: number;
}

export interface DirectoryInputs {
  readonly files: PackageFileInput[];
  readonly truncated: boolean;
  /** Links and special files that were left out. */
  readonly skipped: number;
}

/** Reads at most `length` bytes at `offset` of a regular file without following a final symbolic link. Returns an empty array on any failure. */
function boundedRead(absolute: string, offset: number, length: number): Uint8Array {
  let fd: number | undefined;
  try {
    fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) return new Uint8Array(0);
    const buffer = Buffer.alloc(length);
    const n = readSync(fd, buffer, 0, length, offset);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, n);
  } catch {
    return new Uint8Array(0);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function directoryInputs(root: string, options: DirectoryInputOptions = {}): DirectoryInputs {
  const maxFiles = options.maxFiles ?? 500_000;
  const maxDepth = options.maxDepth ?? 64;
  const files: PackageFileInput[] = [];
  let truncated = false;
  let skipped = 0;
  const walk = (relative: string, depth: number): void => {
    if (truncated) return;
    let names: string[];
    try { names = readdirSync(relative === "" ? root : join(root, relative)); } catch { return; }
    names.sort();
    for (const name of names) {
      if (truncated) return;
      if (name.includes("/") || name.includes("\0")) { skipped += 1; continue; }
      const rel = relative === "" ? name : `${relative}/${name}`;
      const absolute = join(root, rel);
      let stat;
      try { stat = lstatSync(absolute); } catch { skipped += 1; continue; }
      if (stat.isDirectory()) {
        if (depth + 1 > maxDepth) { skipped += 1; continue; }
        walk(rel, depth + 1);
      } else if (stat.isFile()) {
        if (files.length >= maxFiles) { truncated = true; return; }
        files.push({
          path: rel,
          size: stat.size,
          head: boundedRead(absolute, 0, ELF_HEAD_BYTES),
          read: (offset, length) => boundedRead(absolute, offset, Math.min(length, 16 * 1024 * 1024)),
        });
      } else skipped += 1;
    }
  };
  walk("", 0);
  return { files, truncated, skipped };
}
