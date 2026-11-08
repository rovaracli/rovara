import { describe, expect, it } from "vitest";
import { S3VectorsIndex, type S3VectorsPort } from "../../../packages/broker/src/team-record/s3-vectors-index.js";
import {
  buildMetadataFilter,
  searchVisible,
  validateMetadata,
  chooseVectorBucketForNewWorkspace,
  vectorIndexName,
  type VectorHit,
  type VectorIndex,
  type VectorMetadata,
} from "../../../packages/broker/src/team-record/vectors.js";

const DIM = 4;
const meta = (over: Partial<VectorMetadata> = {}): VectorMetadata => ({
  audience_kind: "project", scope: "github:repo/1", project: "p1", trust: "member", tier: "hot", kind: "fact", ref: "f1", ...over,
});
const vec = (n: number): number[] => [n, 0, 0, 0];
const noSleep = { attempts: 3, baseDelayMs: 1, sleep: async () => undefined };

/** The fields the tests read from any port request. */
interface Req { indexName: string; vectorBucketName: string; vectors: unknown[]; keys: string[]; nextToken?: string; [key: string]: unknown }
const asReq = (request: object): Req => request as Req;

function fakePort(over: Partial<S3VectorsPort> = {}) {
  const calls: Array<{ op: string; request: Req }> = [];
  const port: S3VectorsPort = {
    putVectors: async (request) => { calls.push({ op: "put", request: asReq(request) }); },
    queryVectors: async (request) => { calls.push({ op: "query", request: asReq(request) }); return { vectors: [] }; },
    getVectors: async (request) => { calls.push({ op: "get", request: asReq(request) }); return { vectors: [] }; },
    deleteVectors: async (request) => { calls.push({ op: "delete", request: asReq(request) }); },
    createIndex: async (request) => { calls.push({ op: "create", request: asReq(request) }); },
    getIndex: async (request) => { calls.push({ op: "get-index", request: asReq(request) }); },
    deleteIndex: async (request) => { calls.push({ op: "delete-index", request: asReq(request) }); },
    ...over,
  };
  return { port, calls };
}
const make = (port: S3VectorsPort) => new S3VectorsIndex({ port, bucket: "bucket-1", workspaceId: "ws1", dimension: DIM, retry: noSleep });
const err = (code: string) => Object.assign(new Error("x"), { code });

describe("metadata filter", () => {
  it("always scopes to one project and ANDs the optional lists", () => {
    expect(buildMetadataFilter({ project: "p1" })).toEqual({ project: { $eq: "p1" } });
    expect(buildMetadataFilter({ project: "p1", trusts: ["member", "rovara"], tiers: ["hot"] })).toEqual({
      $and: [{ project: { $eq: "p1" } }, { trust: { $in: ["member", "rovara"] } }, { tier: { $in: ["hot"] } }],
    });
  });
  it("refuses an empty list (it would mean no restriction) and a project that is not a safe id", () => {
    expect(() => buildMetadataFilter({ project: "p1", scopes: [] })).toThrow(/empty list/);
    expect(() => buildMetadataFilter({ project: "p1' OR 1=1" })).toThrow(/safe id/);
  });
  it("refuses more than 100 constraints", () => {
    const scopes = Array.from({ length: 100 }, (_, i) => `s${i}`);
    expect(() => buildMetadataFilter({ project: "p1", scopes })).toThrow(/100 constraints/);
  });
});

describe("metadata validation", () => {
  it("refuses filterable metadata over 2 KB", () => {
    expect(() => validateMetadata(meta())).not.toThrow();
    expect(() => validateMetadata(meta({ scope: "x".repeat(201) }))).toThrow(/scope/);
  });
  it("refuses unknown trust and audience values", () => {
    expect(() => validateMetadata(meta({ trust: "admin" as never }))).toThrow(/trust/);
    expect(() => validateMetadata(meta({ audience_kind: "all" as never }))).toThrow(/audience_kind/);
  });
});

describe("index naming and isolation", () => {
  it("gives each workspace its own valid, stable index name", () => {
    const a = vectorIndexName("ws-a");
    expect(a).toMatch(/^ws-[0-9a-f]{32}$/);
    expect(vectorIndexName("ws-a")).toBe(a);
    expect(vectorIndexName("ws-b")).not.toBe(a);
  });
  it("picks a bucket deterministically and refuses an empty list", () => {
    expect(chooseVectorBucketForNewWorkspace("ws-a", ["b1", "b2", "b3"])).toBe(chooseVectorBucketForNewWorkspace("ws-a", ["b1", "b2", "b3"]));
    expect(() => chooseVectorBucketForNewWorkspace("ws-a", [])).toThrow(/bucket/);
  });
  it("sends every request to the index of the workspace it was built for", async () => {
    const { port, calls } = fakePort();
    const index = make(port);
    await index.put([{ key: "fact:1", vector: vec(1), metadata: meta() }]);
    await index.query({ vector: vec(1), topK: 3, filter: { project: "p1" } });
    await index.delete(["fact:1"]);
    expect(new Set(calls.map((c) => c.request.indexName))).toEqual(new Set([vectorIndexName("ws1")]));
    expect(new Set(calls.map((c) => c.request.vectorBucketName))).toEqual(new Set(["bucket-1"]));
  });
});

describe("S3VectorsIndex writes", () => {
  it("rejects a wrong-dimension or non-finite vector before writing anything", async () => {
    const { port, calls } = fakePort();
    const index = make(port);
    await expect(index.put([{ key: "a", vector: vec(1), metadata: meta() }, { key: "b", vector: [1, 2], metadata: meta() }])).rejects.toThrow(/dimension/);
    await expect(index.put([{ key: "b", vector: [1, NaN, 0, 0], metadata: meta() }])).rejects.toThrow(/finite/);
    expect(calls).toHaveLength(0);
  });
  it("splits puts and deletes into batches of 500", async () => {
    const { port, calls } = fakePort();
    const index = make(port);
    const items = Array.from({ length: 1201 }, (_, i) => ({ key: `fact:${i}`, vector: vec(1), metadata: meta() }));
    expect(await index.put(items)).toEqual({ done: 1201, failed: [] });
    expect(calls.filter((c) => c.op === "put").map((c) => c.request.vectors.length)).toEqual([500, 500, 201]);
    calls.length = 0;
    expect(await index.delete(items.map((i) => i.key))).toEqual({ done: 1201, failed: [] });
    expect(calls.map((c) => c.request.keys.length)).toEqual([500, 500, 201]);
  });
  it("retries a throttled put, then succeeds", async () => {
    let n = 0;
    const { port } = fakePort({ putVectors: async () => { n += 1; if (n < 3) throw err("TooManyRequestsException"); } });
    expect(await make(port).put([{ key: "a", vector: vec(1), metadata: meta() }])).toEqual({ done: 1, failed: [] });
    expect(n).toBe(3);
  });
  it("reports the keys of a batch that keeps failing and still writes the other batches", async () => {
    let n = 0;
    const { port } = fakePort({ putVectors: async () => { n += 1; if (n <= 3) throw err("ServiceUnavailableException"); } });
    const items = Array.from({ length: 600 }, (_, i) => ({ key: `k${i}`, vector: vec(1), metadata: meta() }));
    const result = await make(port).put(items);
    expect(result.done).toBe(100);
    expect(result.failed).toHaveLength(500);
  });
  it("does not retry a deterministic error", async () => {
    let n = 0;
    const { port } = fakePort({ deleteVectors: async () => { n += 1; throw err("AccessDeniedException"); } });
    expect((await make(port).delete(["a"])).failed).toEqual(["a"]);
    expect(n).toBe(1);
  });
  it("creates the index with cosine, the dimension, and ref as the only non-filterable key; an existing index is fine", async () => {
    const { port, calls } = fakePort({ createIndex: async (r) => { calls.push({ op: "create", request: asReq(r) }); throw err("ConflictException"); } });
    await make(port).ensureIndex();
    const created = calls.find((c) => c.op === "create")!.request;
    expect(created).toMatchObject({ distanceMetric: "cosine", dimension: DIM, dataType: "float32", metadataConfiguration: { nonFilterableMetadataKeys: ["ref"] } });
  });
});

describe("S3VectorsIndex queries", () => {
  it("sends the project filter, asks for ENHANCED mode, pages through results and sorts by distance then key", async () => {
    const pages = [
      { vectors: [{ key: "fact:b", distance: 0.2, metadata: meta() }, { key: "fact:a", distance: 0.2, metadata: meta() }], nextToken: "t1" },
      { vectors: [{ key: "fact:c", distance: 0.1, metadata: meta() }] },
    ];
    const seen: Req[] = [];
    const { port } = fakePort({ queryVectors: async (r) => { seen.push(asReq(r)); return pages[seen.length - 1]!; } });
    const hits = await make(port).query({ vector: vec(1), topK: 150, filter: { project: "p1" } });
    expect(seen[0]).toMatchObject({ queryMode: "ENHANCED", filter: { project: { $eq: "p1" } }, topK: 150 });
    expect(seen[1]!.nextToken).toBe("t1");
    expect(hits.map((h) => h.key)).toEqual(["fact:c", "fact:a", "fact:b"]);
  });
  it("drops a hit with malformed metadata or from another project (fail closed)", async () => {
    const { port } = fakePort({
      queryVectors: async () => ({ vectors: [
        { key: "fact:1", distance: 0.1, metadata: meta() },
        { key: "fact:2", distance: 0.1, metadata: { project: "p1" } },
        { key: "fact:3", distance: 0.1, metadata: meta({ project: "other" }) },
        { key: "fact:4", metadata: meta() },
      ] }),
    });
    const hits = await make(port).query({ vector: vec(1), topK: 10, filter: { project: "p1" } });
    expect(hits.map((h) => h.key)).toEqual(["fact:1"]);
  });
  it("bounds the paging loop even if the service keeps returning a token", async () => {
    let n = 0;
    const { port } = fakePort({ queryVectors: async () => { n += 1; return { vectors: [], nextToken: "again" }; } });
    await make(port).query({ vector: vec(1), topK: 100, filter: { project: "p1" } });
    expect(n).toBe(2);
  });
  it("get skips a missing vector and a vector of the wrong size", async () => {
    const { port } = fakePort({ getVectors: async () => ({ vectors: [
      { key: "a", data: { float32: vec(1) }, metadata: meta() },
      { key: "b", metadata: meta() },
      { key: "c", data: { float32: [1] }, metadata: meta() },
    ] }) });
    expect((await make(port).get(["a", "b", "c", "d"])).map((i) => i.key)).toEqual(["a"]);
  });
});

describe("searchVisible", () => {
  const hit = (n: number): VectorHit => ({ key: `fact:${n}`, distance: n / 100, metadata: meta({ ref: `f${n}` }) });
  function indexReturning(hits: VectorHit[], requested: number[] = []): VectorIndex {
    return { dimension: DIM, put: async () => ({ done: 0, failed: [] }), get: async () => [], delete: async () => ({ done: 0, failed: [] }),
      query: async (r) => { requested.push(r.topK); return hits; } };
  }
  it("over-fetches k x 3, keeps the first k visible hits in rank order, and counts the hidden ones met on the way", async () => {
    const requested: number[] = [];
    const index = indexReturning(Array.from({ length: 12 }, (_, i) => hit(i)), requested);
    const result = await searchVisible({ index, vector: vec(1), k: 3, filter: { project: "p1" }, canSee: (h) => h.metadata.ref !== "f0" && h.metadata.ref !== "f2" });
    expect(requested).toEqual([9]);
    expect(result.hits.map((h) => h.key)).toEqual(["fact:1", "fact:3", "fact:4"]);
    expect(result.withheld).toBe(2);
  });
  it("treats a check that throws as not visible", async () => {
    const index = indexReturning([hit(1), hit(2)]);
    const result = await searchVisible({ index, vector: vec(1), k: 2, filter: { project: "p1" }, canSee: (h) => { if (h.key === "fact:1") throw new Error("acl lookup failed"); return true; } });
    expect(result.hits.map((h) => h.key)).toEqual(["fact:2"]);
    expect(result.withheld).toBe(1);
  });
  it("returns nothing and exposes no hit when every hit is hidden", async () => {
    const result = await searchVisible({ index: indexReturning([hit(1), hit(2)]), vector: vec(1), k: 5, filter: { project: "p1" }, canSee: () => false });
    expect(result).toEqual({ hits: [], withheld: 2 });
  });
  it("rejects a k outside 1..100", async () => {
    await expect(searchVisible({ index: indexReturning([]), vector: vec(1), k: 0, filter: { project: "p1" }, canSee: () => true })).rejects.toThrow(/k must/);
  });
});
