// R3: the vector index interface of the Team record, and the pieces that do not depend on a backend.
// Design learning-v2-team-record.md 4.4.2 (vector search) and 4.9.1 (Q1: S3 Vectors for both tiers, behind this interface).
//
// Rules this file enforces for every backend:
//  - every query is scoped to one project (scoped retrieval, control C9);
//  - the metadata filter is only a coarse cut: the authoritative permission check runs on every hit (searchVisible);
//  - an index belongs to one workspace (the caller builds it from the caller's org, never from a request body).
import { createHash } from "node:crypto";
import { NON_FILTERABLE_VECTOR_KEYS, VECTOR_DIMENSION_DEFAULT, retiredTeamRecordVectorIndexName, teamRecordVectorIndexName } from "@agentx/contracts";
import type { TrustClass } from "./shared-types.js";
import { assertSafeId } from "./shared-types.js";

export { VECTOR_DIMENSION_DEFAULT };
/** S3 Vectors limits, read from the AWS limits page on 2026-10-30. */
export const S3_VECTORS_LIMITS = {
  putBatch: 500,
  deleteBatch: 500,
  getBatch: 100,
  topKMax: 10_000,
  pageSize: 100,
  filterableMetadataBytes: 2048,
  filterConstraintsMax: 100,
  keyMaxLength: 1024,
  dimensionMax: 4096,
} as const;
/** The design's over-fetch factor: ask for k x 3 so recall survives the authoritative filter. */
export const OVERFETCH_FACTOR = 3;

export type VectorTier = "hot" | "lake";
export type AudienceKind = "project" | "restricted";

/** Filterable metadata, at most 2 KB in total (checked on write). `ref` is the only non-filterable key. */
export interface VectorMetadata {
  audience_kind: AudienceKind;
  /** Source scope, e.g. slack:T1/C9. Capped at 200 characters. */
  scope: string;
  project: string;
  trust: TrustClass;
  /** Storage tier. Not the lesson risk tier. */
  tier: VectorTier;
  /** fact | lesson | event | skill ... */
  kind: string;
  lesson_tier?: 0 | 1 | 2;
  /** Non-filterable: the id of the record this vector stands for. */
  ref: string;
}

export const FILTERABLE_KEYS = ["audience_kind", "scope", "project", "trust", "tier", "kind", "lesson_tier"] as const;
export const NON_FILTERABLE_KEYS = NON_FILTERABLE_VECTOR_KEYS;

export interface VectorItem {
  key: string;
  vector: number[];
  metadata: VectorMetadata;
}

export interface VectorHit {
  key: string;
  /** Cosine distance (0 = identical). */
  distance: number;
  metadata: VectorMetadata;
}

export interface VectorFilter {
  /** Required: retrieval is always scoped to one project. */
  project: string;
  audienceKinds?: AudienceKind[];
  scopes?: string[];
  trusts?: TrustClass[];
  tiers?: VectorTier[];
  kinds?: string[];
  lessonTiers?: Array<0 | 1 | 2>;
}

export interface BatchResult {
  done: number;
  /** Keys whose batch still failed after the bounded retries. The caller retries only these (embedPending). */
  failed: string[];
}

export interface VectorIndex {
  readonly dimension: number;
  put(items: VectorItem[]): Promise<BatchResult>;
  query(request: { vector: number[]; topK: number; filter: VectorFilter }): Promise<VectorHit[]>;
  get(keys: string[]): Promise<VectorItem[]>;
  delete(keys: string[]): Promise<BatchResult>;
}

const TRUSTS = new Set<string>(["member", "rovara", "system", "outsider"]);
const TIERS = new Set<string>(["hot", "lake"]);
const AUDIENCES = new Set<string>(["project", "restricted"]);

export function vectorKey(kind: string, id: string): string {
  assertSafeId(kind, "vector kind");
  if (id.length === 0 || id.length > 200 || [...id].some((char) => char.charCodeAt(0) < 0x20)) throw new Error("team-record: vector id is not valid");
  return `${kind}:${id}`;
}

/** Throws unless the vector has exactly the index dimension and only finite numbers. */
export function assertVector(vector: number[], dimension: number): void {
  if (!Array.isArray(vector) || vector.length !== dimension) throw new Error("team-record: vector has the wrong dimension");
  for (const value of vector) if (!Number.isFinite(value)) throw new Error("team-record: vector has a non-finite value");
}

/** Validates metadata for a write: known keys only, allowed values, filterable part within 2 KB. */
export function validateMetadata(metadata: VectorMetadata): void {
  if (!AUDIENCES.has(metadata.audience_kind)) throw new Error("team-record: metadata audience_kind is not valid");
  if (!TRUSTS.has(metadata.trust)) throw new Error("team-record: metadata trust is not valid");
  if (!TIERS.has(metadata.tier)) throw new Error("team-record: metadata tier is not valid");
  assertSafeId(metadata.project, "metadata project");
  assertSafeId(metadata.kind, "metadata kind");
  if (typeof metadata.scope !== "string" || metadata.scope.length === 0 || metadata.scope.length > 200) throw new Error("team-record: metadata scope is not valid");
  if (typeof metadata.ref !== "string" || metadata.ref.length === 0 || metadata.ref.length > 512) throw new Error("team-record: metadata ref is not valid");
  if (metadata.lesson_tier !== undefined && ![0, 1, 2].includes(metadata.lesson_tier)) throw new Error("team-record: metadata lesson_tier is not valid");
  const filterable: Record<string, unknown> = {};
  for (const key of FILTERABLE_KEYS) if (metadata[key] !== undefined) filterable[key] = metadata[key];
  if (Buffer.byteLength(JSON.stringify(filterable), "utf8") > S3_VECTORS_LIMITS.filterableMetadataBytes) {
    throw new Error("team-record: filterable metadata is over 2 KB");
  }
}

/** Reads metadata a backend returned. A hit with unknown or malformed metadata is dropped by the caller (fail closed). */
export function parseMetadata(value: unknown): VectorMetadata | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const candidate: VectorMetadata = {
    audience_kind: raw.audience_kind as AudienceKind,
    scope: raw.scope as string,
    project: raw.project as string,
    trust: raw.trust as TrustClass,
    tier: raw.tier as VectorTier,
    kind: raw.kind as string,
    ref: raw.ref as string,
    ...(raw.lesson_tier === undefined ? {} : { lesson_tier: raw.lesson_tier as 0 | 1 | 2 }),
  };
  try {
    validateMetadata(candidate);
  } catch {
    return undefined;
  }
  return candidate;
}

export type MetadataFilter = Record<string, unknown>;

function inClause(key: string, values: readonly (string | number)[]): MetadataFilter {
  return { [key]: { $in: [...values] } };
}

/**
 * Builds the S3 Vectors filter for a request. The project clause is always present. Throws when the filter would pass
 * the 100-constraint limit, or when a list is empty (an empty list would otherwise mean "no restriction").
 */
export function buildMetadataFilter(filter: VectorFilter): MetadataFilter {
  assertSafeId(filter.project, "filter project");
  const clauses: MetadataFilter[] = [{ project: { $eq: filter.project } }];
  let constraints = 1;
  const add = (key: string, values: readonly (string | number)[] | undefined): void => {
    if (values === undefined) return;
    if (values.length === 0) throw new Error(`team-record: filter ${key} is an empty list`);
    clauses.push(inClause(key, values));
    constraints += values.length;
  };
  add("audience_kind", filter.audienceKinds);
  add("scope", filter.scopes);
  add("trust", filter.trusts);
  add("tier", filter.tiers);
  add("kind", filter.kinds);
  add("lesson_tier", filter.lessonTiers);
  if (constraints > S3_VECTORS_LIMITS.filterConstraintsMax) throw new Error("team-record: filter has more than 100 constraints");
  return clauses.length === 1 ? clauses[0]! : { $and: clauses };
}

/** One index per workspace (the name is defined in contracts, so the CDK stack and the broker agree). */
export function vectorIndexName(workspaceId: string): string {
  return teamRecordVectorIndexName(workspaceId);
}

/** The workspace's index of the embedding generation before the current one (contracts `retiredTeamRecordVectorIndexName`): deleted once the current index exists. */
export function retiredVectorIndexName(workspaceId: string): string {
  return retiredTeamRecordVectorIndexName(workspaceId);
}

/**
 * Picks a vector bucket for a NEW workspace, once, when it is created (10,000 indexes per bucket; about 8,000 workspaces each). The result
 * must be stored on the workspace and read back from there: running this again after the bucket list changed gives another answer, which
 * would orphan the workspace's vectors (review I-7). The stack allows one bucket until that storage exists.
 */
export function chooseVectorBucketForNewWorkspace(workspaceId: string, buckets: readonly string[]): string {
  assertSafeId(workspaceId, "workspace id");
  if (buckets.length === 0) throw new Error("team-record: no vector bucket is configured");
  const digest = createHash("sha256").update(`team-record-bucket\u0000${workspaceId}`).digest();
  return buckets[digest.readUInt32BE(0) % buckets.length]!;
}

export interface VisibleSearch {
  index: VectorIndex;
  vector: number[];
  k: number;
  filter: VectorFilter;
  /** The authoritative check (ACL snapshot, tombstone, live check). A throw counts as "not visible". */
  canSee: (hit: VectorHit) => boolean | Promise<boolean>;
  overfetch?: number;
}

export interface VisibleResult {
  hits: VectorHit[];
  /** Hits in the ranked window the caller may not see. A count only; nothing else leaves this function. */
  withheld: number;
}

/**
 * Over-fetches k x 3, applies the authoritative check to every hit in rank order, and returns the first k visible hits plus a
 * count of the hidden ones met on the way. Fails closed on a check that throws.
 */
export async function searchVisible(request: VisibleSearch): Promise<VisibleResult> {
  const { k } = request;
  if (!Number.isInteger(k) || k < 1 || k > 100) throw new Error("team-record: k must be between 1 and 100");
  const factor = request.overfetch ?? OVERFETCH_FACTOR;
  const topK = Math.min(k * factor, S3_VECTORS_LIMITS.topKMax);
  const ranked = await request.index.query({ vector: request.vector, topK, filter: request.filter });
  const hits: VectorHit[] = [];
  let withheld = 0;
  for (const hit of ranked) {
    if (hits.length >= k) break;
    // The async wrapper also catches a check that throws before it returns a promise.
    const allowed = await (async () => request.canSee(hit))().then((value) => value === true, () => false);
    if (allowed) hits.push(hit);
    else withheld += 1;
  }
  return { hits, withheld };
}
