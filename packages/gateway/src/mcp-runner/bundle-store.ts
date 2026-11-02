// Stdio MCP host redesign (T6), design sections 4 and 6: where the controller keeps the bundles the install tasks upload.
//
// A bundle is stored under its own sha256 and only after the controller has hashed the bytes it received and found them equal to the hash in the address. Whatever an install task
// claims, the store never holds bytes under a name they do not have. The fetch step checks the hash again before it unpacks (fetch.ts), so a store that was tampered with later is
// refused downstream too.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

export type BundlePutResult = "stored" | "hash_mismatch" | "too_large";

/** A stored bundle, for the sweep: its sha256 and when it was last written (milliseconds). */
export interface StoredBundle { hash: string; lastModified: number }

export interface BundleStore {
  /** Reads `source` (at most `maxBytes`), and keeps the bytes under `hash` only if their sha256 is `hash`. */
  put(hash: string, source: AsyncIterable<Buffer>, maxBytes: number): Promise<BundlePutResult>;
  /** The stored bundle, or undefined. */
  open(hash: string): Promise<{ size: number; stream: Readable } | undefined>;
  has(hash: string): Promise<boolean>;
  /** Review M10: every bundle held, with when it was written. Absent where the store cannot be swept. Throws when it cannot be read (the sweep then removes nothing). */
  list?: (() => Promise<StoredBundle[]>) | undefined;
  /** Review M10: removes one bundle by its sha256, and nothing else. A bundle that is already gone is not an error. Refuses a name that is not a sha256. */
  remove?: ((hash: string) => Promise<void>) | undefined;
}

const SHA256 = /^[0-9a-f]{64}$/u;

/** Writes the incoming bytes to a new file in `directory`, hashing as they arrive. On a mismatch or an overrun the file is removed. */
async function stage(hash: string, source: AsyncIterable<Buffer>, maxBytes: number, directory: string): Promise<{ result: BundlePutResult; path?: string; size?: number }> {
  if (!SHA256.test(hash)) return { result: "hash_mismatch" };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const folder = await mkdtemp(join(directory, "incoming-"));
  const path = join(folder, "bundle.tar");
  const out = createWriteStream(path, { flags: "wx", mode: 0o600 });
  const digest = createHash("sha256");
  let size = 0;
  let overrun = false;
  try {
    for await (const chunk of source) {
      size += chunk.byteLength;
      if (size > maxBytes) { overrun = true; break; }
      digest.update(chunk);
      if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", resolve));
    }
    await new Promise<void>((resolve, reject) => { out.once("error", reject); out.end(() => resolve()); });
  } catch (error) {
    out.destroy();
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
  if (overrun) { await rm(folder, { recursive: true, force: true }); return { result: "too_large" }; }
  if (digest.digest("hex") !== hash) { await rm(folder, { recursive: true, force: true }); return { result: "hash_mismatch" }; }
  return { result: "stored", path, size };
}

/** A store in a folder (tests, and a controller with a volume). Files are named by their hash. */
export function directoryBundleStore(directory: string): BundleStore {
  const target = (hash: string): string => join(directory, `${hash}.tar`);
  return {
    async put(hash, source, maxBytes) {
      const staged = await stage(hash, source, maxBytes, join(directory, "incoming"));
      if (staged.result !== "stored" || staged.path === undefined) return staged.result;
      await rename(staged.path, target(hash));
      await rm(join(staged.path, ".."), { recursive: true, force: true });
      return "stored";
    },
    async open(hash) {
      if (!SHA256.test(hash)) return undefined;
      const info = await stat(target(hash)).catch(() => undefined);
      if (info === undefined || !info.isFile()) return undefined;
      return { size: info.size, stream: createReadStream(target(hash)) };
    },
    async has(hash) {
      return SHA256.test(hash) && (await stat(target(hash)).catch(() => undefined))?.isFile() === true;
    },
    async list() {
      const found: StoredBundle[] = [];
      for (const name of await readdir(directory).catch(() => [] as string[])) {
        const match = /^([0-9a-f]{64})\.tar$/u.exec(name);
        if (match === null) continue;
        const info = await stat(join(directory, name)).catch(() => undefined);
        if (info !== undefined && info.isFile()) found.push({ hash: match[1]!, lastModified: info.mtimeMs });
      }
      return found;
    },
    async remove(hash) {
      if (!SHA256.test(hash)) throw new Error("a bundle is named by its sha256");
      await rm(target(hash), { force: true });
    },
  };
}

/** The S3 calls the store makes. The bucket (KMS, lifecycle) is built by the infrastructure; this is all the controller may do with it. */
export interface BundleObjectApi {
  put(input: { key: string; body: Readable; size: number }): Promise<void>;
  get(key: string): Promise<{ size: number; stream: Readable } | undefined>;
  head(key: string): Promise<boolean>;
  /** Review M10: every object under the prefix, with when it was last written. Throws when the list is not complete (the sweep then removes nothing). */
  list?: ((prefix: string) => Promise<Array<{ key: string; lastModified: number }>>) | undefined;
  /** Review M10: removes one object (in a versioned bucket this adds a delete marker; earlier versions expire by the bucket's lifecycle). */
  remove?: ((key: string) => Promise<void>) | undefined;
}

/** A store in an object bucket. The bytes are staged on disk first (the hash must be known before anything is kept), then uploaded under `bundles/<hash>`. */
export function objectBundleStore(api: BundleObjectApi, options: { stagingDirectory?: string } = {}): BundleStore {
  const key = (hash: string): string => `bundles/${hash}`;
  return {
    async put(hash, source, maxBytes) {
      const staged = await stage(hash, source, maxBytes, options.stagingDirectory ?? join(tmpdir(), "mcp-controller-staging"));
      if (staged.result !== "stored" || staged.path === undefined || staged.size === undefined) return staged.result;
      try {
        await api.put({ key: key(hash), body: createReadStream(staged.path), size: staged.size });
      } finally {
        await rm(join(staged.path, ".."), { recursive: true, force: true });
      }
      return "stored";
    },
    async open(hash) { return SHA256.test(hash) ? api.get(key(hash)) : undefined; },
    async has(hash) { return SHA256.test(hash) && api.head(key(hash)); },
    ...(api.list === undefined ? {} : {
      async list() {
        const found: StoredBundle[] = [];
        for (const item of await api.list!("bundles/")) {
          const match = /^bundles\/([0-9a-f]{64})$/u.exec(item.key);
          if (match !== null) found.push({ hash: match[1]!, lastModified: item.lastModified });
        }
        return found;
      },
    }),
    ...(api.remove === undefined ? {} : {
      async remove(hash) {
        if (!SHA256.test(hash)) throw new Error("a bundle is named by its sha256");
        await api.remove!(key(hash));
      },
    }),
  };
}
