// Writing a package's files to the host without ever following a link (slice 4, lane W2). The arm64 swap returns EDITS (paths to remove and files to add, relative to the package
// root); whoever materialises them on the worker's disk MUST use these two helpers and nothing else: a path from a package is never a host path on its own.
//
// What they do: every folder above the file is looked at with lstat and must be a real folder (created when absent); a link or a file in the way is a refusal, never followed. The
// file itself is created with O_CREAT | O_EXCL | O_NOFOLLOW (it fails on anything already there, a link included). Node has no `openat`, so the walk is one component at a time;
// that is race-free here because the package folder is a private build folder the worker alone writes. Where the operating system offers `openat2(RESOLVE_BENEATH)` (Linux 5.6), a native
// writer should use it instead and keep these as the fallback.
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { FunctionCodeError } from "./code-errors.js";

/** `FileHandle.write` may write less than it was given; loop until every byte is out. */
export async function writeFully(handle: FileHandle, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset);
    if (bytesWritten <= 0) throw new FunctionCodeError("write_failed");
    offset += bytesWritten;
  }
}

function segmentsOf(rel: string): string[] {
  if (typeof rel !== "string" || rel === "" || rel.startsWith("/") || rel.includes("\\") || rel.includes("\0")) throw new FunctionCodeError("unsafe_entry");
  const segments = rel.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) throw new FunctionCodeError("unsafe_entry");
  return segments;
}

/** The folder that holds `rel`, every component checked with lstat to be a real folder (created when `create`). Returns the folder's path and the file's name. */
async function walkParents(root: string, rel: string, create: boolean): Promise<{ dir: string; name: string } | undefined> {
  const segments = segmentsOf(rel);
  const name = segments.pop()!;
  let dir = root;
  for (const segment of segments) {
    dir = join(dir, segment);
    const info = await lstat(dir).catch(() => undefined);
    if (info === undefined) {
      if (!create) return undefined;
      await mkdir(dir, { mode: 0o755 });
      await chmod(dir, 0o755);
    } else if (!info.isDirectory()) throw new FunctionCodeError("unsafe_entry");
  }
  return { dir, name };
}

/** Creates `rel` below `root` with `data` (mode 0644 or 0755). Refuses anything already at the path and any link or file among the folders above it. */
export async function writeBeneath(root: string, rel: string, data: Uint8Array, executable: boolean): Promise<void> {
  try {
    const where = (await walkParents(root, rel, true))!;
    const handle = await open(join(where.dir, where.name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await writeFully(handle, data);
      await handle.chmod(executable ? 0o755 : 0o644);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof FunctionCodeError) throw error;
    throw new FunctionCodeError("write_failed");
  }
}

/** Removes the regular file `rel` below `root`. A link at the path, or any link among the folders above it, is a refusal; a path that is not there is fine. */
export async function removeBeneath(root: string, rel: string): Promise<void> {
  try {
    const where = await walkParents(root, rel, false);
    if (where === undefined) return;
    const target = join(where.dir, where.name);
    const info = await lstat(target).catch(() => undefined);
    if (info === undefined) return;
    if (!info.isFile()) throw new FunctionCodeError("unsafe_entry");
    await unlink(target);
  } catch (error) {
    if (error instanceof FunctionCodeError) throw error;
    throw new FunctionCodeError("write_failed");
  }
}
