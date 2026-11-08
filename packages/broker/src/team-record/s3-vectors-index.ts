// R3: the S3 Vectors implementation of VectorIndex. It talks to a narrow port that mirrors the S3 Vectors API shapes
// (request field names read from the AWS API reference on 2026-10-30). The SDK adapter is not here: @aws-sdk/client-s3vectors is not
// a dependency yet (see report.md, "Wiring pending"). Tests use a fake port.
import {
  S3_VECTORS_LIMITS,
  assertVector,
  buildMetadataFilter,
  parseMetadata,
  validateMetadata,
  vectorIndexName,
  retiredVectorIndexName,
  NON_FILTERABLE_KEYS,
  type BatchResult,
  type VectorFilter,
  type VectorHit,
  type VectorIndex,
  type VectorItem,
} from "./vectors.js";

export interface S3VectorsPort {
  putVectors(request: { vectorBucketName: string; indexName: string; vectors: Array<{ key: string; data: { float32: number[] }; metadata: Record<string, unknown> }> }): Promise<void>;
  queryVectors(request: {
    vectorBucketName: string;
    indexName: string;
    queryVector: { float32: number[] };
    topK: number;
    filter?: Record<string, unknown>;
    returnMetadata: true;
    returnDistance: true;
    /** Always ENHANCED: filters apply before the search, also on an index created before 30 Sep 2026 (CLASSIC). */
    queryMode: "ENHANCED";
    nextToken?: string;
  }): Promise<{ vectors: Array<{ key: string; distance?: number; metadata?: unknown }>; nextToken?: string }>;
  getVectors(request: { vectorBucketName: string; indexName: string; keys: string[]; returnData: true; returnMetadata: true }): Promise<{
    vectors: Array<{ key: string; data?: { float32?: number[] }; metadata?: unknown }>;
  }>;
  deleteVectors(request: { vectorBucketName: string; indexName: string; keys: string[] }): Promise<void>;
  /** Throws an error whose `code` is NotFoundException when the index is not there. */
  getIndex(request: { vectorBucketName: string; indexName: string }): Promise<void>;
  /** Deleting an index deletes every vector in it. Throws NotFoundException when it is already gone. */
  deleteIndex(request: { vectorBucketName: string; indexName: string }): Promise<void>;
  createIndex(request: {
    vectorBucketName: string;
    indexName: string;
    dataType: "float32";
    dimension: number;
    distanceMetric: "cosine";
    metadataConfiguration: { nonFilterableMetadataKeys: string[] };
  }): Promise<void>;
}

/** The port throws errors carrying the S3 Vectors error name in `code` (for example TooManyRequestsException). */
const TRANSIENT_CODES = new Set(["TooManyRequestsException", "ServiceUnavailableException", "RequestTimeoutException", "InternalServerException"]);

function codeOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    if (typeof code === "string") return code;
  }
  return undefined;
}

export interface Retry {
  attempts: number;
  baseDelayMs: number;
  sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_RETRY: Retry = { attempts: 3, baseDelayMs: 200, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

async function withRetry<T>(retry: Retry, call: () => Promise<T>): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await call();
    } catch (error) {
      attempt += 1;
      const code = codeOf(error);
      if (attempt >= retry.attempts || code === undefined || !TRANSIENT_CODES.has(code)) throw error;
      await retry.sleep(retry.baseDelayMs * 2 ** (attempt - 1));
    }
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface S3VectorsIndexOptions {
  port: S3VectorsPort;
  /** The workspace's vector bucket, read from where the workspace stored its assignment (review I-7). Never derived from a list at run time. */
  bucket: string;
  /** From the caller's org, never from a request body. */
  workspaceId: string;
  dimension: number;
  retry?: Retry;
}

export class S3VectorsIndex implements VectorIndex {
  readonly dimension: number;
  private readonly port: S3VectorsPort;
  private readonly bucket: string;
  private readonly indexName: string;
  private readonly retiredIndexName: string;
  private readonly retry: Retry;

  constructor(options: S3VectorsIndexOptions) {
    if (!Number.isInteger(options.dimension) || options.dimension < 1 || options.dimension > S3_VECTORS_LIMITS.dimensionMax) throw new Error("team-record: index dimension is not valid");
    this.dimension = options.dimension;
    this.port = options.port;
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(options.bucket)) throw new Error("team-record: vector bucket name is not valid");
    this.bucket = options.bucket;
    this.indexName = vectorIndexName(options.workspaceId);
    this.retiredIndexName = retiredVectorIndexName(options.workspaceId);
    this.retry = options.retry ?? DEFAULT_RETRY;
  }

  /** Creates this workspace's index. An index that already exists is fine. */
  async ensureIndex(): Promise<void> {
    try {
      await withRetry(this.retry, () =>
        this.port.createIndex({
          vectorBucketName: this.bucket,
          indexName: this.indexName,
          dataType: "float32",
          dimension: this.dimension,
          distanceMetric: "cosine",
          metadataConfiguration: { nonFilterableMetadataKeys: [...NON_FILTERABLE_KEYS] },
        }),
      );
    } catch (error) {
      if (codeOf(error) !== "ConflictException") throw error;
    }
  }

  /**
   * Deletes this workspace's index of the embedding generation before the self-hosted embedder (its vectors are in another model's space and nothing can search them), once the current
   * index exists. `absent`: nothing to delete. `current_missing`: the current index is not there yet, so nothing is deleted (an Enterprise stack that has not made it yet). Any other failure
   * throws; the caller treats the old index as still present, which blocks an erase until it is gone.
   */
  async retireOldIndex(): Promise<"deleted" | "absent" | "current_missing"> {
    try {
      await withRetry(this.retry, () => this.port.getIndex({ vectorBucketName: this.bucket, indexName: this.indexName }));
    } catch (error) {
      if (codeOf(error) === "NotFoundException") return "current_missing";
      throw error;
    }
    try {
      await withRetry(this.retry, () => this.port.deleteIndex({ vectorBucketName: this.bucket, indexName: this.retiredIndexName }));
      return "deleted";
    } catch (error) {
      if (codeOf(error) === "NotFoundException") return "absent";
      throw error;
    }
  }

  async put(items: VectorItem[]): Promise<BatchResult> {
    // Validate everything first: a bad item rejects the whole call before any write.
    for (const item of items) {
      assertVector(item.vector, this.dimension);
      validateMetadata(item.metadata);
      if (item.key.length === 0 || item.key.length > S3_VECTORS_LIMITS.keyMaxLength) throw new Error("team-record: vector key is not valid");
    }
    const result: BatchResult = { done: 0, failed: [] };
    for (const batch of chunk(items, S3_VECTORS_LIMITS.putBatch)) {
      try {
        await withRetry(this.retry, () =>
          this.port.putVectors({
            vectorBucketName: this.bucket,
            indexName: this.indexName,
            vectors: batch.map((item) => ({ key: item.key, data: { float32: item.vector }, metadata: { ...item.metadata } })),
          }),
        );
        result.done += batch.length;
      } catch {
        result.failed.push(...batch.map((item) => item.key));
      }
    }
    return result;
  }

  async query(request: { vector: number[]; topK: number; filter: VectorFilter }): Promise<VectorHit[]> {
    assertVector(request.vector, this.dimension);
    if (!Number.isInteger(request.topK) || request.topK < 1 || request.topK > S3_VECTORS_LIMITS.topKMax) throw new Error("team-record: topK is not valid");
    const filter = buildMetadataFilter(request.filter);
    const hits: VectorHit[] = [];
    let nextToken: string | undefined;
    // A page holds at most 100 results; bound the loop by the pages topK needs, plus one.
    const maxPages = Math.ceil(request.topK / S3_VECTORS_LIMITS.pageSize) + 1;
    for (let page = 0; page < maxPages && hits.length < request.topK; page += 1) {
      const response = await withRetry(this.retry, () =>
        this.port.queryVectors({
          vectorBucketName: this.bucket,
          indexName: this.indexName,
          queryVector: { float32: request.vector },
          topK: request.topK,
          filter,
          returnMetadata: true,
          returnDistance: true,
          queryMode: "ENHANCED",
          ...(nextToken === undefined ? {} : { nextToken }),
        }),
      );
      for (const vector of response.vectors) {
        const metadata = parseMetadata(vector.metadata);
        // Fail closed: a hit with no usable metadata, or outside the project asked for, is dropped.
        if (metadata === undefined || metadata.project !== request.filter.project) continue;
        if (typeof vector.distance !== "number" || !Number.isFinite(vector.distance)) continue;
        hits.push({ key: vector.key, distance: vector.distance, metadata });
      }
      nextToken = response.nextToken;
      if (nextToken === undefined) break;
    }
    // Rank by distance with a fixed tie-break by key, so the same index and query give the same order (design 4.13).
    hits.sort((a, b) => a.distance - b.distance || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return hits.slice(0, request.topK);
  }

  async get(keys: string[]): Promise<VectorItem[]> {
    const out: VectorItem[] = [];
    for (const batch of chunk(keys, S3_VECTORS_LIMITS.getBatch)) {
      const response = await withRetry(this.retry, () =>
        this.port.getVectors({ vectorBucketName: this.bucket, indexName: this.indexName, keys: batch, returnData: true, returnMetadata: true }),
      );
      for (const vector of response.vectors) {
        const metadata = parseMetadata(vector.metadata);
        const data = vector.data?.float32;
        if (metadata === undefined || data === undefined || data.length !== this.dimension) continue;
        out.push({ key: vector.key, vector: data, metadata });
      }
    }
    return out;
  }

  async delete(keys: string[]): Promise<BatchResult> {
    const result: BatchResult = { done: 0, failed: [] };
    for (const batch of chunk(keys, S3_VECTORS_LIMITS.deleteBatch)) {
      try {
        await withRetry(this.retry, () => this.port.deleteVectors({ vectorBucketName: this.bucket, indexName: this.indexName, keys: batch }));
        result.done += batch.length;
      } catch {
        result.failed.push(...batch);
      }
    }
    return result;
  }
}
