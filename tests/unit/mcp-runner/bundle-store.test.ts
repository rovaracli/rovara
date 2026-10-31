// Stdio MCP host redesign, task T6: the controller's bundle store. Bytes are kept under their own sha256 and only under it.
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { directoryBundleStore, objectBundleStore, type BundleObjectApi } from "../../../packages/gateway/src/mcp-runner/bundle-store.js";
import { sha256 } from "../../support/mcp-controller-fixtures.js";

let work: string;
beforeEach(async () => { work = await mkdtemp(join(tmpdir(), "bundle-store-")); });
afterEach(async () => { await rm(work, { recursive: true, force: true }); });

const BYTES = Buffer.from("some bundle bytes");
const HASH = sha256(BYTES);
const source = (...parts: Buffer[]): AsyncIterable<Buffer> => (async function* () { for (const part of parts) yield part; })();
const read = async (stream: Readable): Promise<Buffer> => { const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(chunk as Buffer); return Buffer.concat(chunks); };

describe("directory bundle store", () => {
  it("keeps bytes under their hash, in several chunks, and gives them back", async () => {
    const store = directoryBundleStore(work);
    expect(await store.has(HASH)).toBe(false);
    expect(await store.put(HASH, source(BYTES.subarray(0, 5), BYTES.subarray(5)), 1_000)).toBe("stored");
    expect(await store.has(HASH)).toBe(true);
    const opened = await store.open(HASH);
    expect(opened!.size).toBe(BYTES.length);
    expect(await read(opened!.stream)).toEqual(BYTES);
  });
  it("keeps nothing when the bytes are not the hash in the address, and leaves no file behind", async () => {
    const store = directoryBundleStore(work);
    expect(await store.put(HASH, source(Buffer.from("other bytes")), 1_000)).toBe("hash_mismatch");
    expect(await store.has(HASH)).toBe(false);
    expect(await store.open(HASH)).toBeUndefined();
    expect(await readdir(join(work, "incoming"))).toEqual([]);
    expect(await readdir(work)).toEqual(["incoming"]);
  });
  it("stops reading past the limit and keeps nothing, even when the bytes so far would have hashed right", async () => {
    const store = directoryBundleStore(work);
    expect(await store.put(HASH, source(BYTES), BYTES.length - 1)).toBe("too_large");
    expect(await store.has(HASH)).toBe(false);
    expect(await store.put(HASH, source(BYTES), BYTES.length)).toBe("stored");
    expect(await readdir(join(work, "incoming"))).toEqual([]);
  });
  it("refuses a name that is not a sha256, so no path can be made from it", async () => {
    const store = directoryBundleStore(work);
    for (const bad of ["../x", "x", HASH.toUpperCase(), `${HASH}/..`, ""]) {
      expect(await store.put(bad, source(BYTES), 1_000), bad).toBe("hash_mismatch");
      expect(await store.has(bad), bad).toBe(false);
      expect(await store.open(bad), bad).toBeUndefined();
    }
  });
  it("lets a failing source fail the put and leaves no file behind", async () => {
    const store = directoryBundleStore(work);
    await expect(store.put(HASH, (async function* () { yield BYTES; throw new Error("connection reset"); })(), 1_000)).rejects.toThrow();
    expect(await store.has(HASH)).toBe(false);
    expect(await readdir(join(work, "incoming"))).toEqual([]);
  });
});

describe("object bundle store", () => {
  function fakeApi() {
    const objects = new Map<string, Buffer>();
    const puts: Array<{ key: string; size: number }> = [];
    const api: BundleObjectApi = {
      put: async ({ key, body, size }) => { puts.push({ key, size }); objects.set(key, await read(body)); },
      get: async (key) => { const found = objects.get(key); return found === undefined ? undefined : { size: found.length, stream: Readable.from(found) }; },
      head: async (key) => objects.has(key),
    };
    return { api, objects, puts };
  }
  it("uploads verified bytes under bundles/<hash> and reads them back", async () => {
    const { api, puts } = fakeApi();
    const store = objectBundleStore(api, { stagingDirectory: join(work, "staging") });
    expect(await store.put(HASH, source(BYTES), 1_000)).toBe("stored");
    expect(puts).toEqual([{ key: `bundles/${HASH}`, size: BYTES.length }]);
    expect(await store.has(HASH)).toBe(true);
    expect(await read((await store.open(HASH))!.stream)).toEqual(BYTES);
    expect(await readdir(join(work, "staging"))).toEqual([]);
  });
  it("uploads nothing when the bytes are not the hash, or too many, and rejects names that are not a sha256", async () => {
    const { api, puts } = fakeApi();
    const store = objectBundleStore(api, { stagingDirectory: join(work, "staging") });
    expect(await store.put(HASH, source(Buffer.from("nope")), 1_000)).toBe("hash_mismatch");
    expect(await store.put(HASH, source(BYTES), 3)).toBe("too_large");
    expect(await store.put("../x", source(BYTES), 1_000)).toBe("hash_mismatch");
    expect(puts).toEqual([]);
    expect(await store.has("../x")).toBe(false);
    expect(await store.open("../x")).toBeUndefined();
    expect(await readdir(join(work, "staging"))).toEqual([]);
  });
  it("removes the staged file when the upload fails", async () => {
    const store = objectBundleStore({ put: async () => { throw new Error("denied"); }, get: async () => undefined, head: async () => false }, { stagingDirectory: join(work, "staging") });
    await expect(store.put(HASH, source(BYTES), 1_000)).rejects.toThrow("denied");
    expect(await readdir(join(work, "staging"))).toEqual([]);
  });
});
