// TE-B1-fresh: reads a committed candidate out of its repository's object store and writes it as plain files, VERIFYING EVERY OBJECT on the way.
//
// WHY NOT e2e-candidate-source.ts's materializeInto. The candidate repository's `.git/objects` is writable by the agent. git trusts the id it is asked for: a loose blob swapped under the same id is returned with exit 0 (shown on git 2.54), and an
// `objects/info/alternates` file the agent wrote can point git at objects of its own. So nothing git answers is taken at its word here. The walk starts from the commit id and the tree id the candidate names and recomputes the id of every object it
// reads: the commit (its `tree` line must be the named tree), every tree (the entries are parsed from the bytes whose hash was just checked), and every blob (hashed while it streams to disk). The result is a Merkle proof from the named ids to the files:
// anything missing, swapped or corrupt is "not run", with fixed words, and the partly written export is removed by the caller. Alternates are therefore harmless: a byte they change changes an id.
//
// OWN CAPS (not the E2E build-source caps): 100,000 files, 1 GiB in all, 100 MiB a file; blobs are streamed to disk, never held; the free disk space is checked before the first byte is written (the total plus a margin). Nothing is cut to fit.
//
// git runs only in a throwaway bare repository this worker makes (empty template, no refs, no config but its own defaults) whose alternates name the candidate's object directory: no hook, filter, attribute or config of the candidate is ever read.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, statfs, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { candidateGitEnvironment } from "./e2e-candidate-source.js";

export type FreshExportFailure = "export_failed" | "tree_changed" | "too_large" | "no_space" | "corrupt" | "stopped";

/** A refusal with a fixed reason; the message is never shown to anyone. */
export class FreshExportError extends Error {
  constructor(readonly reason: FreshExportFailure, detail: string = reason) { super(detail); }
}

export interface FreshExportCaps {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  /** Kept free on the disk beyond the export itself. */
  diskMarginBytes: number;
  /** Entries of all the trees together. */
  maxTreeEntries: number;
}
export const FRESH_EXPORT_CAPS: Readonly<FreshExportCaps> = { maxFiles: 100_000, maxTotalBytes: 1024 ** 3, maxFileBytes: 100 * 1024 ** 2, diskMarginBytes: 256 * 1024 ** 2, maxTreeEntries: 400_000 };

const SHA1 = /^[a-f0-9]{40}$/u;
const GIT_FLAGS = ["-c", "core.attributesFile=/dev/null"] as const;
const TREE_OBJECT_CAP_BYTES = 64 * 1024 * 1024;
const COMMIT_OBJECT_CAP_BYTES = 1024 * 1024;
const GIT_LIFETIME_MS = 15 * 60_000;
const FILE_MODES = new Map([["100644", 0o644], ["100755", 0o755]]);

export interface FreshSkippedEntry { path: string; mode: string }

interface Sink {
  begin(size: number): Promise<void>;
  write(chunk: Buffer): Promise<void>;
  end(): Promise<void>;
  abort(): Promise<void>;
}
interface Request { sha: string; type: "commit" | "tree" | "blob"; sink: Sink }

/** One `git cat-file --batch` over the borrowed repository: every answer is hashed and compared with the id that was asked for. */
async function readVerified(gitDir: string, requests: readonly Request[], signal: AbortSignal): Promise<void> {
  if (requests.length === 0) return;
  if (signal.aborted) throw new FreshExportError("stopped");
  const child = spawn("git", [...GIT_FLAGS, `--git-dir=${gitDir}`, "cat-file", "--batch"], { cwd: dirname(gitDir), env: candidateGitEnvironment(), stdio: ["pipe", "pipe", "ignore"] });
  const killer = setTimeout(() => child.kill("SIGKILL"), GIT_LIFETIME_MS);
  const onAbort = () => child.kill("SIGKILL");
  signal.addEventListener("abort", onAbort, { once: true });
  const exited = new Promise<number | null>((resolve) => { child.once("close", (code) => resolve(code)); child.once("error", () => resolve(-1)); });
  child.stdin.on("error", () => undefined);
  child.stdin.end(`${requests.map((request) => request.sha).join("\n")}\n`);
  let index = 0;
  let current: { request: Request; hash: ReturnType<typeof createHash>; remaining: number } | undefined;
  let header = Buffer.alloc(0);
  let expectNewline = false;
  try {
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      let offset = 0;
      while (offset < chunk.length) {
        if (current !== undefined) {
          const take = Math.min(current.remaining, chunk.length - offset);
          const piece = chunk.subarray(offset, offset + take);
          current.hash.update(piece);
          await current.request.sink.write(piece);
          current.remaining -= take;
          offset += take;
          if (current.remaining === 0) {
            const { request, hash } = current;
            if (hash.digest("hex") !== request.sha) throw new FreshExportError("corrupt", "an object does not match its id");
            await request.sink.end();
            current = undefined;
            expectNewline = true;
          }
          continue;
        }
        if (expectNewline) {
          if (chunk[offset] !== 0x0a) throw new FreshExportError("corrupt", "an object is not followed by a newline");
          offset += 1;
          expectNewline = false;
          continue;
        }
        const newline = chunk.indexOf(0x0a, offset);
        if (newline < 0) {
          header = Buffer.concat([header, chunk.subarray(offset)]);
          if (header.length > 256) throw new FreshExportError("corrupt", "a header is too long");
          offset = chunk.length;
          continue;
        }
        header = Buffer.concat([header, chunk.subarray(offset, newline)]);
        offset = newline + 1;
        const request = requests[index];
        const parts = header.toString("utf8").split(" ");
        header = Buffer.alloc(0);
        if (request === undefined || parts[0] !== request.sha) throw new FreshExportError("corrupt", "an answer is for another object");
        if (parts[1] === "missing") throw new FreshExportError("corrupt", "an object is missing");
        const size = Number(parts[2]);
        if (parts[1] !== request.type || !Number.isSafeInteger(size) || size < 0) throw new FreshExportError("corrupt", "an object is not the kind that was asked for");
        index += 1;
        await request.sink.begin(size);
        current = { request, hash: createHash("sha1").update(`${request.type} ${String(size)}\0`), remaining: size };
        if (size === 0) {
          const { hash } = current;
          if (hash.digest("hex") !== request.sha) throw new FreshExportError("corrupt", "an object does not match its id");
          await request.sink.end();
          current = undefined;
          expectNewline = true;
        }
      }
    }
    const code = await exited;
    if (signal.aborted) throw new FreshExportError("stopped");
    if (code !== 0 || index !== requests.length || current !== undefined || header.length > 0) throw new FreshExportError("corrupt", "git did not answer every request");
  } catch (error) {
    child.kill("SIGKILL");
    await current?.request.sink.abort().catch(() => undefined);
    if (signal.aborted) throw new FreshExportError("stopped");
    throw error;
  } finally {
    clearTimeout(killer);
    signal.removeEventListener("abort", onAbort);
  }
}

/** A small object, held in memory (a commit or a tree), within its cap. */
function collector(cap: number): Sink & { bytes(): Buffer } {
  const parts: Buffer[] = [];
  return {
    begin(size) { if (size > cap) throw new FreshExportError("too_large", "an object is over its cap"); return Promise.resolve(); },
    write(chunk) { parts.push(Buffer.from(chunk)); return Promise.resolve(); },
    end() { return Promise.resolve(); },
    abort() { return Promise.resolve(); },
    bytes: () => Buffer.concat(parts),
  };
}

async function plainDirectory(path: string): Promise<void> {
  const stat = await lstat(path).catch(() => undefined);
  if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== path) throw new FreshExportError("export_failed", "not a plain git directory");
}

/** Runs `use` against a throwaway bare repository whose alternates name only the candidate's object directory. */
async function withBorrowedObjects<T>(scratchRoot: string, repositoryRoot: string, signal: AbortSignal, use: (gitDir: string) => Promise<T>): Promise<T> {
  const realRepository = await realpath(repositoryRoot).catch(() => { throw new FreshExportError("export_failed", "no repository"); });
  const objects = join(realRepository, ".git", "objects");
  await plainDirectory(join(realRepository, ".git"));
  await plainDirectory(objects);
  if (objects.includes("\n")) throw new FreshExportError("export_failed", "odd path");
  await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
  const work = await mkdtemp(join(scratchRoot, "git-"));
  try {
    const gitDir = join(work, "borrowed.git");
    await new Promise<void>((resolve, reject) => {
      const child = spawn("git", [...GIT_FLAGS, "init", "--bare", "--quiet", "--template=", gitDir], { cwd: work, env: candidateGitEnvironment(), stdio: "ignore" });
      child.once("error", reject);
      child.once("close", (code) => (code === 0 ? resolve() : reject(new Error("git init failed"))));
    }).catch(() => { throw new FreshExportError("export_failed", "could not make the throwaway repository"); });
    await mkdir(join(gitDir, "objects", "info"), { recursive: true });
    await writeFile(join(gitDir, "objects", "info", "alternates"), `${objects}\n`, { mode: 0o600 });
    return await use(gitDir);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

interface FileEntry { path: string; mode: string; sha: string }

/** The entries of a tree object's bytes (already hash-checked): `<mode> <name>\0<20 raw bytes>` each. */
function treeEntries(bytes: Buffer): Array<{ mode: string; name: string; sha: string }> {
  const entries: Array<{ mode: string; name: string; sha: string }> = [];
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    const nul = space < 0 ? -1 : bytes.indexOf(0x00, space);
    if (space < 0 || nul < 0 || nul + 21 > bytes.length) throw new FreshExportError("corrupt", "a tree is not well formed");
    entries.push({ mode: bytes.subarray(offset, space).toString("latin1"), name: bytes.subarray(space + 1, nul).toString("utf8"), sha: bytes.subarray(nul + 1, nul + 21).toString("hex") });
    offset = nul + 21;
  }
  return entries;
}

const unsafeName = (name: string): boolean => name === "" || name === "." || name === ".." || name.toLowerCase() === ".git" || name.includes("/") || name.includes("\0") || name.includes("\\");

/**
 * Writes the committed regular files of `commitSha` into the existing empty directory `destination`, verifying every object (see the header). Symlinks (120000) and submodules (160000) are not written; they are returned. Throws a
 * FreshExportError (nothing else) for every refusal; the caller removes the destination.
 */
export async function materializeVerified(input: {
  repositoryRoot: string; commitSha: string; treeSha: string; destination: string; scratchRoot: string; signal: AbortSignal; caps?: Partial<FreshExportCaps>;
}): Promise<FreshSkippedEntry[]> {
  const caps = { ...FRESH_EXPORT_CAPS, ...input.caps };
  if (!SHA1.test(input.commitSha) || !SHA1.test(input.treeSha)) throw new FreshExportError("export_failed", "not a full lowercase hex object id");
  return withBorrowedObjects(input.scratchRoot, input.repositoryRoot, input.signal, async (gitDir) => {
    // 1. the commit, verified; its tree must be the one the candidate names
    const commit = collector(COMMIT_OBJECT_CAP_BYTES);
    await readVerified(gitDir, [{ sha: input.commitSha, type: "commit", sink: commit }], input.signal);
    const treeLine = /^tree ([a-f0-9]{40})\n/u.exec(commit.bytes().toString("utf8"));
    if (treeLine === null || treeLine[1] !== input.treeSha) throw new FreshExportError("tree_changed", "the commit's tree is not the named tree");
    // 2. the trees, level by level, each verified before its bytes are read as entries
    const files: FileEntry[] = [];
    const skipped: FreshSkippedEntry[] = [];
    let entriesSeen = 0;
    let level: Array<{ sha: string; prefix: string }> = [{ sha: input.treeSha, prefix: "" }];
    while (level.length > 0) {
      const sinks = level.map(() => collector(TREE_OBJECT_CAP_BYTES));
      await readVerified(gitDir, level.map((tree, at) => ({ sha: tree.sha, type: "tree" as const, sink: sinks[at]! })), input.signal);
      const next: Array<{ sha: string; prefix: string }> = [];
      for (const [at, tree] of level.entries()) {
        for (const entry of treeEntries(sinks[at]!.bytes())) {
          entriesSeen += 1;
          if (entriesSeen > caps.maxTreeEntries) throw new FreshExportError("too_large", "too many tree entries");
          if (unsafeName(entry.name)) throw new FreshExportError("export_failed", "a tree entry has a name the export cannot hold");
          const path = tree.prefix === "" ? entry.name : `${tree.prefix}/${entry.name}`;
          if (entry.mode === "40000") {
            next.push({ sha: entry.sha, prefix: path });
          } else if (entry.mode === "120000" || entry.mode === "160000") skipped.push({ path, mode: entry.mode });
          else if (FILE_MODES.has(entry.mode)) {
            files.push({ path, mode: entry.mode, sha: entry.sha });
            if (files.length > caps.maxFiles) throw new FreshExportError("too_large", "too many files");
          } else throw new FreshExportError("export_failed", "a tree entry has a mode the export cannot hold");
        }
      }
      level = next;
    }
    // 3. sizes first (so a file over its cap, or a disk too small, is refused before anything is written)
    const sizes = await blobSizes(gitDir, files, input.signal);
    let total = 0;
    for (const [at, file] of files.entries()) {
      const size = sizes[at]!;
      if (size > caps.maxFileBytes) throw new FreshExportError("too_large", `${file.path} is over the per-file cap`);
      total += size;
      if (total > caps.maxTotalBytes) throw new FreshExportError("too_large", "over the total cap");
    }
    const disk = await statfs(input.destination).catch(() => undefined);
    if (disk === undefined || disk.bavail * disk.bsize < total + caps.diskMarginBytes) throw new FreshExportError("no_space", "not enough free disk space");
    // 4. the blobs, streamed to disk and hashed as they go
    const madeDirectories = new Set<string>([input.destination]);
    let written = 0;
    const requests: Request[] = files.map((file, at) => ({ sha: file.sha, type: "blob" as const, sink: fileSink(input.destination, file, madeDirectories, sizes[at]!, caps.maxFileBytes, (size) => { written += size; if (written > caps.maxTotalBytes) throw new FreshExportError("too_large", "over the total cap"); }) }));
    // in slices, so an open file is never waiting behind thousands of requests
    for (let start = 0; start < requests.length; start += 2_000) await readVerified(gitDir, requests.slice(start, start + 2_000), input.signal);
    return skipped;
  });
}

/** The blobs' sizes from `cat-file --batch-check` (advisory: the streamed bytes are checked against them and against the id). */
async function blobSizes(gitDir: string, files: readonly FileEntry[], signal: AbortSignal): Promise<number[]> {
  if (files.length === 0) return [];
  const child = spawn("git", [...GIT_FLAGS, `--git-dir=${gitDir}`, "cat-file", "--batch-check"], { cwd: dirname(gitDir), env: candidateGitEnvironment(), stdio: ["pipe", "pipe", "ignore"] });
  const onAbort = () => child.kill("SIGKILL");
  signal.addEventListener("abort", onAbort, { once: true });
  child.stdin.on("error", () => undefined);
  child.stdin.end(`${files.map((file) => file.sha).join("\n")}\n`);
  const chunks: Buffer[] = [];
  let kept = 0;
  try {
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      kept += chunk.length;
      if (kept > files.length * 128 + 4096) { child.kill("SIGKILL"); throw new FreshExportError("corrupt", "too much output"); }
      chunks.push(chunk);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  if (signal.aborted) throw new FreshExportError("stopped");
  const lines = Buffer.concat(chunks).toString("utf8").split("\n");
  return files.map((file, at) => {
    const parts = (lines[at] ?? "").split(" ");
    const size = Number(parts[2]);
    if (parts[0] !== file.sha || parts[1] !== "blob" || !Number.isSafeInteger(size) || size < 0) throw new FreshExportError("corrupt", "a blob is missing");
    return size;
  });
}

/** Writes one file as its blob streams in: made exclusively (nothing is followed or replaced), at its exact mode, never more bytes than the size the check allowed. */
function fileSink(destination: string, file: FileEntry, made: Set<string>, expectedSize: number, maxFileBytes: number, counted: (size: number) => void): Sink {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let got = 0;
  const target = join(destination, ...file.path.split("/"));
  return {
    async begin(size) {
      if (size > maxFileBytes || size !== expectedSize) throw new FreshExportError("corrupt", "a blob's size changed");
      counted(size);
      const directory = dirname(target);
      if (!made.has(directory)) {
        await mkdir(directory, { recursive: true, mode: 0o755 });
        // every folder made on the way is set outright: a process umask must not make the tree unreadable to the sandbox's user
        let walk = directory;
        while (walk !== destination && !made.has(walk)) { made.add(walk); await chmod(walk, 0o755); walk = dirname(walk); }
      }
      handle = await open(target, "wx", FILE_MODES.get(file.mode));
    },
    async write(chunk) {
      got += chunk.length;
      if (got > expectedSize) throw new FreshExportError("corrupt", "a blob is larger than it said");
      await handle!.write(chunk);
    },
    async end() { await handle!.close(); handle = undefined; await chmod(target, FILE_MODES.get(file.mode)!); },
    async abort() { await handle?.close().catch(() => undefined); handle = undefined; },
  };
}

/** Makes a tree the checks wrote removable: directories get owner rwx, files owner rw (a check may leave 0000 or 0555 folders). Never follows a link. */
export async function makeRemovable(path: string): Promise<void> {
  const stat = await lstat(path).catch(() => undefined);
  if (stat === undefined || stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await chmod(path, (stat.mode & 0o7777) | 0o700).catch(() => undefined);
    for (const name of await readdir(path).catch(() => [] as string[])) await makeRemovable(join(path, name));
  } else {
    await chmod(path, (stat.mode & 0o7777) | 0o600).catch(() => undefined);
  }
}
