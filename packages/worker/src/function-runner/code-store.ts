// The worker's function code store (slice 4, lane W2). It keeps the code of the functions a run created, on the worker's disk, until the run ends.
//
// Layout, under one root the worker owns (nothing else may live there; `sweepStale` empties `runs/` at worker start):
//   <root>/runs/<runId>/incoming/<random>.part   a package being received (never visible to anything else)
//   <root>/runs/<runId>/blobs/<sha256>.zip       a received zip that matched its digest and size and passed the judge, keyed by its SHA-256 (the same bytes are kept once per run)
//   <root>/runs/<runId>/trees/<n>/task           a function's package unpacked: mounted read-only as /var/task
//   <root>/runs/<runId>/trees/<n>/opt            its layers unpacked in order, later layers winning: mounted read-only as /opt
//
// Rules:
//   - NO CACHE ACROSS RUNS. A blob is keyed by run and digest (design section 8.6): another run never sees it, and the end of a run removes everything it had.
//   - NO PACKAGE TEXT IS A HOST PATH. Folder names under the root are the run id (a checked token), a hex digest and a counter. A function key the caller names is a map key only. Entry names inside a package are judged
//     (`zip-judge.ts`) and joined under a tree folder by `zip-unpack.ts`, which checks the result again.
//   - ATOMIC. A zip is written as `incoming/<random>.part` and renamed to its blob name only after the digest, the size and the judge passed; a tree is unpacked into `trees/.build-<random>` and renamed to `trees/<n>` only when
//     complete. A half package is never under a name anything reads, and a failure removes its own scratch.
//   - BOUNDED. One zip is at most `maxZipBytes` and the stream is cut as soon as it is longer than announced; a function and its layers together unpack to at most `maxExpandedBytes` (Lambda's 250 MB), at most five layers; a run holds at
//     most `maxFunctionsPerRun` functions and `maxRunBytes` of code; the whole worker at most `diskBudgetBytes`. Space is reserved BEFORE it is used (the announced size, the declared unpacked size) and settled to the real figure after.
//     A stream has a wall-clock limit. At most `maxConcurrentUnpacks` zips are held in memory and unpacked at once.
//   - CLEANUP AT RUN END. `RunCode.close()` stops what is in flight, waits for it, removes the run's folder and gives its space back. It is safe to call twice.
// This module starts no process and reads no network; the pipe transport (a later lane) feeds `PackageReceiver.receive`.
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, lstat, chmod } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DEFAULT_CODE_LIMITS, FUNCTION_CODE_LIMITS, FunctionCodeError } from "./code-errors.js";
import { classifyNative, type ClassifiableFile, type ClassifyNative, type NativeClassification } from "./native-classify.js";
import type { PackageAnnouncement, PackageBytes, PackageReceiver, ReceiveOptions, StoredPackage } from "./package-stream.js";
import { inspectFunctionZip } from "./zip-judge.js";
import { unpackFunctionCode } from "./zip-unpack.js";

/** Where Lambda puts a function's code and its layers. The sandbox lane mounts `taskDir` and `optDir` read-only at these paths. */
export const LAMBDA_TASK_ROOT = "/var/task";
export const LAMBDA_LAYER_ROOT = "/opt";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const KEY_HIDDEN = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

export interface CodeStoreOptions {
  /** An absolute folder the worker owns. */
  root: string;
  /** All code on this worker, all runs together. Default 8 GiB. */
  diskBudgetBytes?: number;
  /** One run's code (zips and unpacked trees). Default 2 GiB (design section 8.5). */
  maxRunBytes?: number;
  /** Functions with an unpacked tree in one run. Default 200 (design section 8.5). */
  maxFunctionsPerRun?: number;
  /** Zips held in memory and unpacked at the same time. Default 2. */
  maxConcurrentUnpacks?: number;
  /** The wall-clock limit of one package's stream. Default 120 s. */
  receiveTimeoutMs?: number;
  /** The native-code classifier (lane X1). Default: the stub. */
  classify?: ClassifyNative;
}

export interface MaterializeRequest {
  /** The digest of the function's own zip (a package this run received). */
  packageSha256: string;
  /** Layer digests in the function's configured order: the first is unpacked first, later layers win. */
  layerSha256s: readonly string[];
}

export interface MaterializedCode {
  key: string;
  /** Mount read-only at /var/task. */
  taskDir: string;
  /** Mount read-only at /opt. */
  optDir: string;
  files: number;
  /** Bytes of regular files on disk in both folders. */
  expandedBytes: number;
  native: NativeClassification;
}

/** One run's code. Everything the front sends for a run goes through its `receive`. */
export interface RunCode extends PackageReceiver {
  readonly runId: string;
  /** Unpacks a received function package and its layers (all received first). One tree per `key`; `discard` it before using the key again. */
  materialize(key: string, request: MaterializeRequest): Promise<MaterializedCode>;
  /** Removes one function's tree and gives its space back. Unknown key: nothing happens. */
  discard(key: string): Promise<void>;
  /** Removes one stored zip (the function was deleted and nothing needs it). Unknown digest: nothing happens. */
  dropPackage(sha256: string): Promise<void>;
  /** Ends the run: stops what is in flight, removes every file, gives the space back. */
  close(): Promise<void>;
  usedBytes(): number;
}

/** What is held, against what is allowed: a node of a tree of limits, so a run's reservation is also the worker's. */
class Ledger {
  used = 0;
  constructor(readonly limit: number, private readonly parent?: Ledger) {}
  take(bytes: number): Lease {
    this.check(bytes);
    this.add(bytes);
    return new Lease(this, bytes);
  }
  private check(bytes: number): void {
    if (this.used + bytes > this.limit) throw new FunctionCodeError("budget");
    this.parent?.check(bytes);
  }
  add(bytes: number): void {
    this.used += bytes;
    this.parent?.add(bytes);
  }
}

class Lease {
  private freed = false;
  constructor(private readonly ledger: Ledger, private held: number) {}
  /** Moves the held amount down to the real figure (reserving is always for the most it can be, so the real figure is never higher). */
  settle(actual: number): void {
    if (this.freed || actual >= this.held) return;
    this.ledger.add(actual - this.held);
    this.held = actual;
  }
  free(): void {
    if (this.freed) return;
    this.freed = true;
    this.ledger.add(-this.held);
    this.held = 0;
  }
}

class Semaphore {
  private waiting: Array<() => void> = [];
  private active = 0;
  constructor(private readonly slots: number) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.slots) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active += 1;
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next === undefined) this.active -= 1;
      else next();
    }
  }
}

interface BlobRecord {
  sizeBytes: number;
  entries: number;
  expandedBytes: number;
  kind: PackageAnnouncement["kind"];
  lease: Lease;
}

interface TreeRecord {
  dir: string;
  lease: Lease;
}

export class FunctionCodeStore {
  private readonly runsDir: string;
  private readonly ledger: Ledger;
  private readonly runs = new Map<string, RunCodeImpl>();
  private readonly gate: Semaphore;
  readonly settings: Required<Omit<CodeStoreOptions, "root" | "classify">> & { classify: ClassifyNative };

  constructor(options: CodeStoreOptions) {
    if (!isAbsolute(options.root)) throw new FunctionCodeError("bad_request");
    this.settings = {
      diskBudgetBytes: options.diskBudgetBytes ?? 8 * 1024 ** 3,
      maxRunBytes: options.maxRunBytes ?? 2 * 1024 ** 3,
      maxFunctionsPerRun: options.maxFunctionsPerRun ?? 200,
      maxConcurrentUnpacks: options.maxConcurrentUnpacks ?? 2,
      receiveTimeoutMs: options.receiveTimeoutMs ?? 120_000,
      classify: options.classify ?? classifyNative,
    };
    this.runsDir = join(options.root, "runs");
    this.ledger = new Ledger(this.settings.diskBudgetBytes);
    this.gate = new Semaphore(this.settings.maxConcurrentUnpacks);
  }

  /** At worker start: no run survives a restart, so everything under `runs/` is stale. Returns how many run folders were removed. */
  async sweepStale(): Promise<number> {
    await mkdir(this.runsDir, { recursive: true, mode: 0o700 });
    const names = await readdir(this.runsDir);
    for (const name of names) await rm(join(this.runsDir, name), { recursive: true, force: true });
    return names.length;
  }

  /** The run's code area, created on first use. The same open run gives the same object. */
  async openRun(runId: string): Promise<RunCode> {
    if (!RUN_ID.test(runId)) throw new FunctionCodeError("bad_request");
    const open = this.runs.get(runId);
    if (open !== undefined && !open.isClosed) return open;
    await mkdir(this.runsDir, { recursive: true, mode: 0o700 });
    const dir = join(this.runsDir, runId);
    // A leftover folder of the same id would be stale (a crash before the sweep): start clean.
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { mode: 0o700 });
    for (const sub of ["incoming", "blobs", "trees"]) await mkdir(join(dir, sub), { mode: 0o700 });
    const run = new RunCodeImpl(this, runId, dir, new Ledger(this.settings.maxRunBytes, this.ledger));
    this.runs.set(runId, run);
    return run;
  }

  usage(): { usedBytes: number; limitBytes: number; openRuns: number } {
    return { usedBytes: this.ledger.used, limitBytes: this.ledger.limit, openRuns: [...this.runs.values()].filter((run) => !run.isClosed).length };
  }

  /** @internal */
  async gated<T>(work: () => Promise<T>): Promise<T> {
    return this.gate.run(work);
  }
}

class RunCodeImpl implements RunCode {
  private closed = false;
  private readonly stop = new AbortController();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly blobs = new Map<string, BlobRecord>();
  private readonly trees = new Map<string, TreeRecord>();
  /** Keys whose tree is being built, so two calls for one key cannot both start. */
  private readonly building = new Set<string>();
  private counter = 0;

  constructor(private readonly store: FunctionCodeStore, readonly runId: string, private readonly dir: string, private readonly ledger: Ledger) {}

  get isClosed(): boolean {
    return this.closed;
  }

  usedBytes(): number {
    return this.ledger.used;
  }

  has(sha256: string): boolean {
    return !this.closed && this.blobs.has(sha256);
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.inflight.add(work);
    const done = (): void => { this.inflight.delete(work); };
    work.then(done, done);
    return work;
  }

  receive(announcement: PackageAnnouncement, bytes: PackageBytes, options: ReceiveOptions = {}): Promise<StoredPackage> {
    return this.track(this.receiveNow(announcement, bytes, options));
  }

  private async receiveNow(announcement: PackageAnnouncement, bytes: PackageBytes, options: ReceiveOptions): Promise<StoredPackage> {
    if (this.closed) throw new FunctionCodeError("run_closed");
    const { kind, sha256, sizeBytes } = announcement;
    if ((kind !== "function" && kind !== "layer") || typeof sha256 !== "string" || !SHA256.test(sha256)) throw new FunctionCodeError("bad_request");
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > FUNCTION_CODE_LIMITS.maxZipBytes) throw new FunctionCodeError("size");
    const known = this.blobs.get(sha256);
    if (known !== undefined) return { kind, sha256, sizeBytes: known.sizeBytes, entries: known.entries, expandedBytes: known.expandedBytes, deduped: true };

    const lease = this.ledger.take(sizeBytes);
    const part = join(this.dir, "incoming", `${randomBytes(12).toString("hex")}.part`);
    let kept = false;
    try {
      const signal = AbortSignal.any([this.stop.signal, AbortSignal.timeout(options.timeoutMs ?? this.store.settings.receiveTimeoutMs), ...(options.signal === undefined ? [] : [options.signal])]);
      await this.spool(bytes, part, sizeBytes, sha256, signal);
      const judged = await this.store.gated(async () => {
        this.assertOpen();
        const zip = await readFile(part);
        const entries = inspectFunctionZip(zip, DEFAULT_CODE_LIMITS);
        return { entries: entries.length, expandedBytes: entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0) };
      });
      this.assertOpen();
      const existing = this.blobs.get(sha256);
      if (existing !== undefined) return { kind, sha256, sizeBytes: existing.sizeBytes, entries: existing.entries, expandedBytes: existing.expandedBytes, deduped: true };
      await rename(part, join(this.dir, "blobs", `${sha256}.zip`));
      this.blobs.set(sha256, { sizeBytes, entries: judged.entries, expandedBytes: judged.expandedBytes, kind, lease });
      kept = true;
      return { kind, sha256, sizeBytes, entries: judged.entries, expandedBytes: judged.expandedBytes, deduped: false };
    } finally {
      if (!kept) {
        lease.free();
        await rm(part, { force: true }).catch(() => undefined);
      }
    }
  }

  /** Writes the stream to `part`, counting as it goes: cut at once when longer than announced; exact size and digest after. */
  private async spool(bytes: PackageBytes, part: string, announcedSize: number, sha256: string, signal: AbortSignal): Promise<void> {
    const iterator = bytes[Symbol.asyncIterator]();
    const aborted = new Promise<never>((_, reject) => {
      const fail = (): void => reject(new FunctionCodeError(this.closed ? "run_closed" : "timed_out"));
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    });
    aborted.catch(() => undefined);
    const hash = createHash("sha256");
    let total = 0;
    const handle = await open(part, "wx", 0o600);
    try {
      for (;;) {
        const step = await Promise.race([iterator.next(), aborted]);
        if (step.done === true) break;
        const chunk: unknown = step.value;
        if (!(chunk instanceof Uint8Array)) throw new FunctionCodeError("bad_request");
        total += chunk.length;
        if (total > announcedSize) throw new FunctionCodeError("size");
        hash.update(chunk);
        await handle.write(chunk);
      }
    } catch (error) {
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
      if (error instanceof FunctionCodeError) throw error;
      throw new FunctionCodeError("write_failed");
    } finally {
      await handle.close().catch(() => undefined);
    }
    if (total !== announcedSize) throw new FunctionCodeError("size");
    if (hash.digest("hex") !== sha256) throw new FunctionCodeError("digest");
  }

  materialize(key: string, request: MaterializeRequest): Promise<MaterializedCode> {
    return this.track(this.materializeNow(key, request));
  }

  private assertOpen(): void {
    if (this.closed) throw new FunctionCodeError("run_closed");
  }

  private async materializeNow(key: string, request: MaterializeRequest): Promise<MaterializedCode> {
    this.assertOpen();
    if (typeof key !== "string" || key.length < 1 || key.length > 256 || KEY_HIDDEN.test(key) || this.trees.has(key) || this.building.has(key)) throw new FunctionCodeError("bad_request");
    if (request.layerSha256s.length > FUNCTION_CODE_LIMITS.maxLayers) throw new FunctionCodeError("bad_request");
    if (this.trees.size + this.building.size >= this.store.settings.maxFunctionsPerRun) throw new FunctionCodeError("budget");
    const shas = [request.packageSha256, ...request.layerSha256s];
    for (const sha of shas) if (typeof sha !== "string" || !SHA256.test(sha)) throw new FunctionCodeError("bad_request");
    for (const sha of shas) if (!this.blobs.has(sha)) throw new FunctionCodeError("not_found");
    // Reserve the key and a slot at once.
    this.building.add(key);
    const build = join(this.dir, "trees", `.build-${randomBytes(12).toString("hex")}`);
    let lease: Lease | undefined;
    let published: string | undefined;
    try {
      // The declared unpacked size of the function and its layers together must fit Lambda's limit; reserve that much room before writing.
      const declared = shas.reduce((sum, sha) => sum + this.blobs.get(sha)!.expandedBytes, 0);
      if (declared > FUNCTION_CODE_LIMITS.maxExpandedBytes) throw new FunctionCodeError("too_large");
      lease = this.ledger.take(declared);
      const result = await this.store.gated(async () => {
        this.assertOpen();
        await mkdir(build, { mode: 0o700 });
        const taskDir = join(build, "task");
        const optDir = join(build, "opt");
        let remaining: number = FUNCTION_CODE_LIMITS.maxExpandedBytes;
        const unpack = async (sha: string, target: string, mode: "fresh" | "overlay"): Promise<void> => {
          const zip = await readFile(join(this.dir, "blobs", `${sha}.zip`));
          const done = await unpackFunctionCode(zip, target, { maxEntries: DEFAULT_CODE_LIMITS.maxEntries, maxExpandedBytes: remaining }, { mode, signal: this.stop.signal });
          remaining -= done.expandedBytes;
          this.assertOpen();
        };
        await unpack(request.packageSha256, taskDir, "fresh");
        if (request.layerSha256s.length === 0) await mkdir(optDir, { mode: 0o755 });
        for (const [index, sha] of request.layerSha256s.entries()) await unpack(sha, optDir, index === 0 ? "fresh" : "overlay");
        await chmod(optDir, 0o755);
        // Published under its final name before it is listed, so the paths the classifier is given stay valid.
        const finalDir = join(this.dir, "trees", String(this.counter));
        this.counter += 1;
        await rename(build, finalDir);
        const task = await listFiles(join(finalDir, "task"), LAMBDA_TASK_ROOT);
        const opt = await listFiles(join(finalDir, "opt"), LAMBDA_LAYER_ROOT);
        return { finalDir, files: [...task.files, ...opt.files], bytes: task.bytes + opt.bytes };
      });
      lease.settle(result.bytes);
      published = result.finalDir;
      const native = await this.store.settings.classify(result.files);
      this.assertOpen();
      this.trees.set(key, { dir: result.finalDir, lease });
      lease = undefined;
      return { key, taskDir: join(result.finalDir, "task"), optDir: join(result.finalDir, "opt"), files: result.files.length, expandedBytes: result.bytes, native };
    } catch (error) {
      await rm(build, { recursive: true, force: true }).catch(() => undefined);
      if (published !== undefined) await rm(published, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof FunctionCodeError) throw error;
      throw new FunctionCodeError("write_failed");
    } finally {
      this.building.delete(key);
      lease?.free();
    }
  }

  async discard(key: string): Promise<void> {
    const tree = this.trees.get(key);
    if (tree === undefined) return;
    this.trees.delete(key);
    await rm(tree.dir, { recursive: true, force: true });
    tree.lease.free();
  }

  async dropPackage(sha256: string): Promise<void> {
    const blob = this.blobs.get(sha256);
    if (blob === undefined) return;
    this.blobs.delete(sha256);
    await rm(join(this.dir, "blobs", `${sha256}.zip`), { force: true });
    blob.lease.free();
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.stop.abort();
    }
    // What is in flight sees the stop, cleans its own scratch and settles; only then is the folder removed.
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
    await rm(this.dir, { recursive: true, force: true });
    for (const blob of this.blobs.values()) blob.lease.free();
    for (const tree of this.trees.values()) tree.lease.free();
    this.blobs.clear();
    this.trees.clear();
  }
}

/** The regular files below `dir`, never following a link, with their real sizes. `base` is the Lambda path the folder is mounted at (display text for the classifier). */
async function listFiles(dir: string, base: string): Promise<{ files: ClassifiableFile[]; bytes: number }> {
  const files: ClassifiableFile[] = [];
  let bytes = 0;
  const pending: Array<{ abs: string; rel: string }> = [{ abs: dir, rel: "" }];
  while (pending.length > 0) {
    const here = pending.pop()!;
    for (const entry of await readdir(here.abs, { withFileTypes: true })) {
      const rel = here.rel === "" ? entry.name : `${here.rel}/${entry.name}`;
      const abs = join(here.abs, entry.name);
      if (entry.isDirectory()) pending.push({ abs, rel });
      else if (entry.isFile()) {
        const info = await lstat(abs);
        bytes += info.size;
        files.push({ path: `${base}/${rel}`, size: info.size, executable: (info.mode & 0o100) !== 0, head: (count) => readHead(abs, count) });
      }
    }
  }
  return { files, bytes };
}

async function readHead(path: string, count: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(Math.max(0, Math.min(count, 1024 * 1024)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
