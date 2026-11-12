// The keyword index of the Team record (lanes K2 and K3, DECISIONS 145, design option (f) of team-record-keyword-index-design-2026-11-12.md).
//
// WHAT IT IS. For each project, sealed index segments (keyword-index-segment.ts: words only, no text) stored as chunk items in the project's own partition of the team-record table, a MANIFEST item that lists them, and
// a LIVE TAIL: the rows newer than the newest sealed time, read live like the old window. A search ranks segments, tail, late rows and notes together with global BM25 statistics (keyword-index-score.ts), so the answer is the
// one BM25 over the best passage of EVERY hot row would give; it then reloads the best rows from the table, and the caller runs the same permission filter as always. No infrastructure: the items live in the table the
// record already has, under the keys below, every one of them under `teamRecordPk(org, project)` (the company is in the key; nothing is shared across companies or projects).
//
//   KWIDX#M                      the manifest (one per project): version, coverage, the segments in time order, retired segment ids
//   KWIDX#S#<segment>#<n>        a chunk (at most CHUNK_BYTES) of a segment
//   KWIDX#B#<segment>            "a build of this segment is under way": a build writes it first, so a build that dies leaves a finder for its chunks
//   KWLATE#<occurredAt>#<id>     a row written with an `occurredAt` older than KEYWORD_LATE_MS: it may fall inside a sealed range, so it is read live until a rebuild folds it in (written in the row's own transaction)
//
// SEGMENT RANGES. Segment i covers the times (upTo of i-1, upTo of i]; the first covers everything up to its `upTo`. Ranges tile, so every time up to the watermark (the last `upTo`) is in exactly one segment, and the tail
// is every row after it. A seal only takes rows older than KEYWORD_LATE_MS, so a row written now is never older than a range that is being sealed (a row written after the seal read it, with an older time, has a LATE marker).
//
// THE MANIFEST IS THE LOCK. Every change (a seal, a rebuild, a merge, a removal mark) is a write conditional on the manifest's version. A build reads rows, writes new chunks, then switches the manifest; if anything marked
// the manifest meanwhile (above all a removal) the switch fails and the build is thrown away. That is what makes a removal safe against a build that had already read the row (see `markRemoved`).
//
// ERASE (lane K3). A removed row (a tombstone) is hidden at once by the permission filter, and the index is exact at read time because every hit is reloaded. Its words leave the index by rebuilding the segment that covers
// its time: `removalGate` (called by `purgeItems` before a row is deleted, the same rule as "a row goes only after its vector") marks the segments dirty, rebuilds them now within a budget, and says which rows are ready. A
// row is deleted only when its segment has been rebuilt without it, no retired segment or unfinished build is left, and the row is tombstoned (a rebuild skips tombstoned rows). Text expiry and archiving are cleaned by the nightly pass.
import { randomBytes } from "node:crypto";
import { BatchGetCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { teamRecordPk, type OrgId } from "@rovara-code/contracts";
import { RECORD_EVENT_SK_PREFIX, recordEventKey } from "@agentx/cloud-contracts";
import { errorName, type Item } from "../agents/table-writes.js";
import { keywordDocumentOf, structuredDocumentOf } from "./keyword-document.js";
import { LivePart, SegmentPart, rankParts, type DocMeta, type ScoringPart } from "./keyword-index-score.js";
import { encodeSegment, SegmentReader, type SegmentDocInput } from "./keyword-index-segment.js";
import { KEYWORD_LATE_MS, KWLATE_PREFIX } from "./keyword-late.js";
import { keywordTokens } from "./search-fusion.js";
import { projectOfPk } from "./scope-work.js";
import { eventFromItem, tombstoneItem, type StoredEvent, type StoredFact } from "./store.js";
import type { RecordLog, TeamRecordTable } from "./types.js";

// ---- numbers

/** Rows a sealed segment holds, at most, when it is made (a rebuild of a range that grew may split it). 4,000 rows are about 5 MB of text to read and a few MB of index to write: well inside the broker's 512 MB and 30 s. */
export const SEGMENT_DOCS = 4_000;
/** The tail is sealed once it holds this many rows, or its oldest row is this old. */
export const SEAL_TRIGGER_ROWS = 500;
export const SEAL_MAX_AGE_MS = 24 * 3_600_000;
/** More rows than this after the watermark, or more late markers than `LATE_MAX`, and the search uses the old window instead (the index is behind). */
export const TAIL_MAX_ROWS = 1_500;
export const LATE_MAX = 500;
/** The rows of the best ranks a search reloads and checks (the caller then keeps the best `KEYWORD_RRF_TOP` the reader may see). */
export const KEYWORD_CANDIDATES = 100;
export const KEYWORD_RRF_TOP = 30;
export const CHUNK_BYTES = 300_000;
/** A segment build reads rows until SEGMENT_DOCS rows OR about this many bytes of text and structured fields (a page of 8 KB rows is 4 MB, so it can overshoot by a page): the memory of one build, tokens included, stays far inside the broker's 512 MB. */
export const SEGMENT_BYTES = 16 * 1_048_576;
/** More rows than this at ONE instant cannot be cut into segments (a segment covers whole instants): the build fails closed and logs, and the project is searched by the window. */
export const SAME_INSTANT_MAX_ROWS = 10_000;
/** A search opens the index only when its segments are no bigger than this together (the process's cache is 150 MB): over it, the window answers. */
export const SEARCH_INDEX_MAX_BYTES = 100 * 1_048_576;
/** A build intent this old belongs to a build that died: its chunks are deleted. */
export const ORPHAN_AFTER_MS = 2 * 60_000;
/**
 * A row past its hot expiry is dropped from the index: the archiver takes it that night and the TTL removes it ARCHIVE_GRACE_DAYS (7) later, and a person erase after the TTL could no longer find the row to rebuild its segment. So
 * a build leaves out every row whose `hotExpiresAt` has passed (an archived row, with `archivedAt`, too), and the nightly pass (which runs after the archiver) rebuilds each segment that holds one: the words are gone within a
 * night of the hot expiry, a week before the TTL.
 */
const MAX_SEGMENTS = 1_200;

export { KWLATE_PREFIX } from "./keyword-late.js";
export const KWIDX_PREFIX = "KWIDX#";
export const KWIDX_MANIFEST_SK = "KWIDX#M";
const KWIDX_CHUNK_PREFIX = "KWIDX#S#";
const KWIDX_BUILD_PREFIX = "KWIDX#B#";

const chunkSk = (segment: string, n: number): string => `${KWIDX_CHUNK_PREFIX}${segment}#${String(n).padStart(5, "0")}`;
const manifestKey = (orgId: OrgId, project: string): { pk: string; sk: string } => ({ pk: teamRecordPk(orgId, project), sk: KWIDX_MANIFEST_SK });



// ---- the manifest

const SegmentEntrySchema = z.object({
  id: z.string().regex(/^[0-9a-z]{6,40}$/),
  upTo: z.string().datetime(),
  docs: z.number().int().min(0),
  bytes: z.number().int().min(0),
  chunks: z.number().int().min(1),
  textExpiresMin: z.number().int().min(0).optional(),
  hotExpiresMin: z.number().int().min(0).optional(),
  builtAt: z.string().datetime(),
  /** About how many bytes of row text and fields the segment was built from (a merge keeps the sum under SEGMENT_BYTES). */
  srcBytes: z.number().int().min(0).optional(),
  dirty: z.object({ since: z.string().datetime(), reason: z.enum(["removal", "expiry", "damaged"]) }).strict().optional(),
}).strict();
const ManifestSchema = z.object({
  version: z.number().int().min(1),
  coverage: z.enum(["building", "complete"]),
  segments: z.array(SegmentEntrySchema).max(MAX_SEGMENTS),
  retired: z.array(z.string().regex(/^[0-9a-z]{6,40}$/)).max(MAX_SEGMENTS),
  updatedAt: z.string().datetime(),
}).strict();
export type SegmentEntry = z.infer<typeof SegmentEntrySchema>;
export type Manifest = z.infer<typeof ManifestSchema>;

export type ManifestRead = { status: "none" } | { status: "bad" } | { status: "ok"; manifest: Manifest };

export interface KeywordIndexDeps {
  table: TeamRecordTable;
  now?: (() => number) | undefined;
  log?: RecordLog | undefined;
  cache?: SegmentCache | undefined;
}

/** The segments a Lambda has read, by company, project and segment id. A segment is immutable, so an entry never goes stale: it is only dropped when its segment is retired, or to make room. */
export class SegmentCache {
  private readonly entries = new Map<string, SegmentReader>();
  private bytes = 0;
  constructor(private readonly maxBytes: number = 150 * 1_048_576) {}
  static key(orgId: OrgId, project: string, segment: string): string { return `${orgId}|${project}|${segment}`; }
  get(key: string): SegmentReader | undefined {
    const found = this.entries.get(key);
    if (found !== undefined) { this.entries.delete(key); this.entries.set(key, found); }
    return found;
  }
  set(key: string, reader: SegmentReader): void {
    this.delete(key);
    this.entries.set(key, reader);
    this.bytes += reader.byteLength;
    for (const [oldest, old] of this.entries) {
      if (this.bytes <= this.maxBytes || oldest === key) break;
      this.entries.delete(oldest);
      this.bytes -= old.byteLength;
    }
  }
  delete(key: string): void {
    const found = this.entries.get(key);
    if (found !== undefined) { this.entries.delete(key); this.bytes -= found.byteLength; }
  }
  get size(): number { return this.entries.size; }
}
/** The Lambda's own cache (one per process). */
export const defaultSegmentCache = new SegmentCache();

const nowOf = (deps: KeywordIndexDeps): number => (deps.now ?? Date.now)();
const isoOf = (ms: number): string => new Date(ms).toISOString();

async function readManifest(deps: KeywordIndexDeps, orgId: OrgId, project: string): Promise<ManifestRead> {
  const response = await deps.table.documentClient.send(new GetCommand({ TableName: deps.table.tableName, Key: manifestKey(orgId, project), ConsistentRead: true })) as { Item?: Item };
  if (response.Item === undefined) return { status: "none" };
  const { pk: _pk, sk: _sk, entityType: _type, ...rest } = response.Item; // eslint-disable-line @typescript-eslint/no-unused-vars -- dropped on purpose
  const parsed = ManifestSchema.safeParse(rest);
  return parsed.success ? { status: "ok", manifest: parsed.data } : { status: "bad" };
}

const manifestItem = (orgId: OrgId, project: string, manifest: Manifest): Item => ({ ...manifestKey(orgId, project), entityType: "TEAM_RECORD_KWIDX_MANIFEST", ...manifest });

/** Writes the manifest if it still has version `expected` (0: it must not exist). False when another writer changed it. */
async function writeManifest(deps: KeywordIndexDeps, orgId: OrgId, project: string, next: Manifest, expected: number): Promise<boolean> {
  try {
    await deps.table.documentClient.send(new PutCommand({
      TableName: deps.table.tableName, Item: manifestItem(orgId, project, next),
      ...(expected === 0
        ? { ConditionExpression: "attribute_not_exists(pk)" }
        : { ConditionExpression: "#version = :expected", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":expected": expected } }),
    }));
    return true;
  } catch (error) {
    if (errorName(error) === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

// ---- rows

const INSTANT = /^REC#([^#]+)#(.+)$/;
/** The time and id a row's sort key names. */
export function rowOfSortKey(sk: string): { occurredAt: string; id: string } | undefined {
  const match = INSTANT.exec(sk);
  return match === null ? undefined : { occurredAt: match[1] as string, id: match[2] as string };
}

/**
 * One project's rows in a range of time, read with strongly consistent reads (an erase rebuild must see a tombstone that was just written), page by page. `after` is exclusive, `upTo` inclusive (instants). `limit` is soft:
 * once it is reached the read goes on only to the end of the instant it stopped in, so a range is never cut between two rows of the same instant. `more` says rows are left after the last one returned.
 */
async function readRows(deps: KeywordIndexDeps, orgId: OrgId, project: string, range: { after?: string; upTo?: string; ascending: boolean; limit: number; maxBytes?: number }): Promise<{ items: Item[]; more: boolean; bytes: number }> {
  const low = range.after === undefined ? RECORD_EVENT_SK_PREFIX : `${RECORD_EVENT_SK_PREFIX}${range.after}#\uffff`;
  const high = range.upTo === undefined ? `${RECORD_EVENT_SK_PREFIX}\uffff` : `${RECORD_EVENT_SK_PREFIX}${range.upTo}#\uffff`;
  const items: Item[] = [];
  let bytes = 0;
  let startKey: Record<string, unknown> | undefined;
  for (;;) {
    const response = await deps.table.documentClient.send(new QueryCommand({
      TableName: deps.table.tableName, KeyConditionExpression: "pk = :pk AND sk BETWEEN :low AND :high",
      ExpressionAttributeValues: { ":pk": teamRecordPk(orgId, project), ":low": low, ":high": high },
      ScanIndexForward: range.ascending, ConsistentRead: true, Limit: 200,
      ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of response.Items ?? []) { items.push(item); bytes += (typeof item.text === "string" ? item.text.length : 0) + 400; }
    startKey = response.LastEvaluatedKey;
    if (startKey === undefined) return { items, more: false, bytes };
    if (items.length >= range.limit || (range.maxBytes !== undefined && bytes >= range.maxBytes)) {
      // cut at an instant boundary: keep whole instants only
      const instantOf = (item: Item): string | undefined => rowOfSortKey(String(item.sk))?.occurredAt;
      const last = instantOf(items[items.length - 1] as Item);
      let cut = items.length;
      while (cut > 0 && instantOf(items[cut - 1] as Item) === last) cut -= 1;
      if (cut > 0) { const kept = items.slice(0, cut); return { items: kept, more: true, bytes: kept.reduce((sum, item) => sum + (typeof item.text === "string" ? item.text.length : 0) + 400, 0) }; }
      // every row so far is in one instant: read on until it changes, but not without end
      if (items.length > SAME_INSTANT_MAX_ROWS) throw new Error("keyword index: too many rows at one instant");
    }
  }
}

/** A row as a segment document, or undefined for a row the index leaves out: one that does not parse, a removed (tombstoned) one, or one the archiver has taken. */
function docOfItem(item: Item, nowSeconds: number): SegmentDocInput | undefined {
  if (item.tombstone !== undefined || item.archivedAt !== undefined) return undefined;
  const event = eventFromItem(item, nowSeconds);
  if (event === undefined || event.hotExpiresAt <= nowSeconds) return undefined;
  const expiring = event.text !== undefined && event.textExpiresAt !== undefined;
  return {
    id: event.id, occurredAtMs: Date.parse(event.occurredAt), kind: event.kind, source: event.source, restricted: event.audience.kind === "restricted", hotExpiresAt: event.hotExpiresAt,
    tokens: keywordTokens(keywordDocumentOf(event, nowSeconds)),
    ...(expiring ? { textExpiresAt: event.textExpiresAt as number, structTokens: keywordTokens(structuredDocumentOf(event)) } : {}),
  };
}

// ---- segments in the table

async function tableDelete(deps: KeywordIndexDeps, key: { pk: string; sk: string }): Promise<void> {
  await deps.table.documentClient.send(new DeleteCommand({ TableName: deps.table.tableName, Key: key }));
}

async function putChunks(deps: KeywordIndexDeps, orgId: OrgId, project: string, segment: string, bytes: Buffer): Promise<number> {
  const pk = teamRecordPk(orgId, project);
  const count = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
  for (let n = 0; n < count; n += 1) {
    await deps.table.documentClient.send(new PutCommand({
      TableName: deps.table.tableName,
      Item: { pk, sk: chunkSk(segment, n), entityType: "TEAM_RECORD_KWIDX_CHUNK", segment, n, data: new Uint8Array(bytes.subarray(n * CHUNK_BYTES, (n + 1) * CHUNK_BYTES)) },
    }));
  }
  return count;
}

/** Keys (sort keys) of every item of the project's partition under a prefix. */
async function sortKeysUnder(deps: KeywordIndexDeps, orgId: OrgId, project: string, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const response = await deps.table.documentClient.send(new QueryCommand({
      TableName: deps.table.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": teamRecordPk(orgId, project), ":prefix": prefix },
      ConsistentRead: true, ProjectionExpression: "sk", ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
    })) as { Items?: Array<{ sk?: unknown }>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of response.Items ?? []) if (typeof item.sk === "string") keys.push(item.sk);
    startKey = response.LastEvaluatedKey;
  } while (startKey !== undefined);
  return keys;
}

async function deleteChunks(deps: KeywordIndexDeps, orgId: OrgId, project: string, segment: string): Promise<void> {
  const pk = teamRecordPk(orgId, project);
  for (const sk of await sortKeysUnder(deps, orgId, project, `${KWIDX_CHUNK_PREFIX}${segment}#`)) await tableDelete(deps, { pk, sk });
  (deps.cache ?? defaultSegmentCache).delete(SegmentCache.key(orgId, project, segment));
}

/** A segment the manifest lists whose chunks are missing or the wrong size: the search marks it dirty (the next pass rebuilds it from the rows) and answers from the window meanwhile. */
export class DamagedSegmentError extends Error {
  constructor(readonly segment: string) { super("keyword index: a segment is damaged"); this.name = "DamagedSegmentError"; }
}

async function loadSegment(deps: KeywordIndexDeps, orgId: OrgId, project: string, entry: SegmentEntry): Promise<SegmentReader> {
  const cache = deps.cache ?? defaultSegmentCache;
  const key = SegmentCache.key(orgId, project, entry.id);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const pk = teamRecordPk(orgId, project);
  const parts = new Map<number, Uint8Array>();
  let keys = Array.from({ length: entry.chunks }, (_unused, n) => ({ pk, sk: chunkSk(entry.id, n) }));
  for (let attempt = 0; attempt < 4 && keys.length > 0; attempt += 1) {
    const next: typeof keys = [];
    for (let at = 0; at < keys.length; at += 100) {
      const batch = keys.slice(at, at + 100);
      const response = await deps.table.documentClient.send(new BatchGetCommand({ RequestItems: { [deps.table.tableName]: { Keys: batch, ConsistentRead: true } } })) as { Responses?: Record<string, Item[]>; UnprocessedKeys?: Record<string, { Keys?: typeof keys }> };
      for (const item of response.Responses?.[deps.table.tableName] ?? []) if (typeof item.n === "number" && item.data instanceof Uint8Array) parts.set(item.n, item.data);
      next.push(...(response.UnprocessedKeys?.[deps.table.tableName]?.Keys ?? []));
    }
    keys = next;
  }
  const ordered = Array.from({ length: entry.chunks }, (_unused, n) => parts.get(n));
  if (ordered.some((part) => part === undefined)) throw new DamagedSegmentError(entry.id);
  const bytes = Buffer.concat(ordered as Uint8Array[]);
  if (bytes.length !== entry.bytes) throw new DamagedSegmentError(entry.id);
  const reader = new SegmentReader(bytes);
  cache.set(key, reader);
  return reader;
}

// ---- the build

export interface BuildContext extends KeywordIndexDeps {
  orgId: OrgId;
  project: string;
  /** Epoch ms after which no new step starts. */
  deadlineAt: number;
}
const overDeadline = (ctx: BuildContext): boolean => nowOf(ctx) >= ctx.deadlineAt;

const newSegmentId = (now: number): string => `${now.toString(36)}${randomBytes(4).toString("hex")}`;

const instantOfItem = (item: Item): string => rowOfSortKey(String(item.sk))?.occurredAt ?? "";

interface Written { entry: SegmentEntry }

/** Encodes and stores one piece. The build intent was written before (see `withIntent`). */
async function writePiece(ctx: BuildContext, piece: { upTo: string; docs: SegmentDocInput[]; srcBytes: number }, id: string): Promise<Written> {
  const encoded = encodeSegment(piece.docs);
  const chunks = await putChunks(ctx, ctx.orgId, ctx.project, id, encoded.bytes);
  return {
    entry: {
      id, upTo: piece.upTo, docs: encoded.docs, bytes: encoded.bytes.length, chunks, builtAt: isoOf(nowOf(ctx)), srcBytes: piece.srcBytes,
      ...(encoded.textExpiresMin === undefined ? {} : { textExpiresMin: encoded.textExpiresMin }), ...(encoded.hotExpiresMin === undefined ? {} : { hotExpiresMin: encoded.hotExpiresMin }),
    },
  };
}

/** Writes the intent for a segment id, runs `work`, and removes the intent. On a throw the intent stays (it is how the chunks of a build that died are found). */
async function withIntents<T>(ctx: BuildContext, ids: readonly string[], work: () => Promise<T>): Promise<T> {
  const pk = teamRecordPk(ctx.orgId, ctx.project);
  for (const id of ids) await ctx.table.documentClient.send(new PutCommand({ TableName: ctx.table.tableName, Item: { pk, sk: `${KWIDX_BUILD_PREFIX}${id}`, entityType: "TEAM_RECORD_KWIDX_BUILD", segment: id, at: isoOf(nowOf(ctx)) } }));
  let result: T;
  try {
    result = await work();
  } catch (error) {
    // The build failed (a write that the table refused, say): its chunks and its intent are removed now if the table lets us; if it does not, the intent stays and is how the next pass finds the chunks.
    try {
      for (const id of ids) await deleteChunks(ctx, ctx.orgId, ctx.project, id);
      for (const id of ids) await tableDelete(ctx, { pk, sk: `${KWIDX_BUILD_PREFIX}${id}` });
    } catch { /* the intent stays */ }
    throw error;
  }
  for (const id of ids) await tableDelete(ctx, { pk, sk: `${KWIDX_BUILD_PREFIX}${id}` });
  return result;
}

const rangeOf = (manifest: Manifest, from: number, to: number): { after: string | undefined; upTo: string } => ({
  after: from === 0 ? undefined : (manifest.segments[from - 1] as SegmentEntry).upTo, upTo: (manifest.segments[to] as SegmentEntry).upTo,
});

export type Replaced = { status: "done"; manifest: Manifest } | { status: "conflict" } | { status: "deadline" };

/**
 * Rebuilds segments `from..to` (adjacent) from the table into new segments (one, or more if the range grew), and switches the manifest. The range is read a piece at a time (about SEGMENT_DOCS rows, cut only between instants),
 * so the memory is one piece however many rows a range holds. The new segments never carry a dirty mark: they were built from rows read AFTER the marks they answer (a mark written later changes the manifest's version and fails
 * this switch). The old segments' chunks are deleted at once; their ids stay in `retired` until that is done.
 */
export async function replaceSegments(ctx: BuildContext, manifest: Manifest, from: number, to: number): Promise<Replaced> {
  const { after, upTo } = rangeOf(manifest, from, to);
  const nowSeconds = Math.floor(nowOf(ctx) / 1000);
  const pk = teamRecordPk(ctx.orgId, ctx.project);
  const ids: string[] = [];
  const entries: SegmentEntry[] = [];
  const discard = async (): Promise<void> => {
    for (const id of ids) await deleteChunks(ctx, ctx.orgId, ctx.project, id);
    for (const id of ids) await tableDelete(ctx, { pk, sk: `${KWIDX_BUILD_PREFIX}${id}` });
  };
  try {
    let cursor = after;
    for (;;) {
      if (overDeadline(ctx)) { await discard(); return { status: "deadline" }; }
      const rows = await readRows(ctx, ctx.orgId, ctx.project, { ...(cursor === undefined ? {} : { after: cursor }), upTo, ascending: true, limit: SEGMENT_DOCS, maxBytes: SEGMENT_BYTES });
      const pieceEnd = rows.more ? instantOfItem(rows.items[rows.items.length - 1] as Item) : upTo;
      const docs = rows.items.flatMap((item) => { const doc = docOfItem(item, nowSeconds); return doc === undefined ? [] : [doc]; });
      const id = newSegmentId(nowOf(ctx));
      ids.push(id);
      await ctx.table.documentClient.send(new PutCommand({ TableName: ctx.table.tableName, Item: { pk, sk: `${KWIDX_BUILD_PREFIX}${id}`, entityType: "TEAM_RECORD_KWIDX_BUILD", segment: id, at: isoOf(nowOf(ctx)) } }));
      entries.push((await writePiece(ctx, { upTo: pieceEnd, docs, srcBytes: rows.bytes }, id)).entry);
      if (!rows.more) break;
      cursor = pieceEnd;
    }
    const replaced = manifest.segments.slice(from, to + 1);
    const next: Manifest = {
      ...manifest, version: manifest.version + 1, updatedAt: isoOf(nowOf(ctx)),
      segments: [...manifest.segments.slice(0, from), ...entries, ...manifest.segments.slice(to + 1)],
      retired: [...new Set([...manifest.retired, ...replaced.map((entry) => entry.id)])],
    };
    if (!(await writeManifest(ctx, ctx.orgId, ctx.project, next, manifest.version))) { await discard(); return { status: "conflict" }; }
    manifest = next;
  } catch (error) {
    // The build failed (a write the table refused, say): its chunks and intents are removed now if the table lets us; if it does not, the intents stay and are how the next pass finds the chunks.
    try { await discard(); } catch { /* the intents stay */ }
    throw error;
  }
  for (const id of ids) await tableDelete(ctx, { pk, sk: `${KWIDX_BUILD_PREFIX}${id}` });
  return { status: "done", manifest: await dropRetired(ctx, manifest) };
}

/** Deletes the chunks of retired segments and takes them off the manifest. The manifest is changed without moving its version (a build in flight must not fail for this), only if the version is still the one read. */
async function dropRetired(ctx: BuildContext, manifest: Manifest): Promise<Manifest> {
  if (manifest.retired.length === 0) return manifest;
  for (const id of manifest.retired) await deleteChunks(ctx, ctx.orgId, ctx.project, id);
  try {
    await ctx.table.documentClient.send(new UpdateCommand({
      TableName: ctx.table.tableName, Key: manifestKey(ctx.orgId, ctx.project), UpdateExpression: "SET retired = :none",
      ConditionExpression: "#version = :version", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":none": [], ":version": manifest.version },
    }));
  } catch (error) {
    if (errorName(error) !== "ConditionalCheckFailedException") throw error;
    // The manifest moved: the next pass drops what is still listed (the chunks are gone already; deleting nothing is fine).
    return manifest;
  }
  return { ...manifest, retired: [] };
}

/** Deletes the chunks of builds that died (an intent older than ORPHAN_AFTER_MS). Returns how many intents are still there afterwards (a fresh one is a build under way). */
async function cleanOrphans(ctx: BuildContext): Promise<number> {
  const pk = teamRecordPk(ctx.orgId, ctx.project);
  let left = 0;
  const response = await ctx.table.documentClient.send(new QueryCommand({
    TableName: ctx.table.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": pk, ":prefix": KWIDX_BUILD_PREFIX }, ConsistentRead: true,
  })) as { Items?: Item[] };
  if ((response.Items ?? []).length === 0) return 0;
  const read = await readManifest(ctx, ctx.orgId, ctx.project);
  // A segment the manifest lists is live: its build switched the manifest, and only the delete of its intent was lost. Its chunks are never an orphan's; only the intent goes.
  const live = new Set(read.status === "ok" ? read.manifest.segments.map((entry) => entry.id) : []);
  for (const item of response.Items ?? []) {
    const at = typeof item.at === "string" ? Date.parse(item.at) : 0;
    if (typeof item.segment !== "string") { await tableDelete(ctx, { pk, sk: String(item.sk) }); continue; }
    if (live.has(item.segment)) { await tableDelete(ctx, { pk, sk: String(item.sk) }); continue; }
    if (read.status !== "ok") { left += 1; continue; }   // no manifest to tell a live segment from an orphan: leave it (a manifest that does not parse is reset by the next pass)
    if (nowOf(ctx) - at < ORPHAN_AFTER_MS) { left += 1; continue; }
    await deleteChunks(ctx, ctx.orgId, ctx.project, item.segment);
    await tableDelete(ctx, { pk, sk: String(item.sk) });
  }
  return left;
}

/** Every item of the index (and the late markers) of one project: a manifest that does not parse is not trusted, and neither is any chunk it names. */
async function resetIndex(ctx: BuildContext): Promise<void> {
  const pk = teamRecordPk(ctx.orgId, ctx.project);
  for (const prefix of [KWIDX_PREFIX, KWLATE_PREFIX]) for (const sk of await sortKeysUnder(ctx, ctx.orgId, ctx.project, prefix)) await tableDelete(ctx, { pk, sk });
}

interface LateMarker { sk: string; occurredAt: string; id: string }

async function listLateMarkers(deps: KeywordIndexDeps, orgId: OrgId, project: string, limit: number): Promise<{ markers: LateMarker[]; more: boolean }> {
  const markers: LateMarker[] = [];
  let startKey: Record<string, unknown> | undefined;
  for (;;) {
    const response = await deps.table.documentClient.send(new QueryCommand({
      TableName: deps.table.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": teamRecordPk(orgId, project), ":prefix": KWLATE_PREFIX },
      ConsistentRead: true, Limit: limit + 1, ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of response.Items ?? []) {
      const parts = /^KWLATE#([^#]+)#(.+)$/.exec(String(item.sk));
      if (parts !== null) markers.push({ sk: String(item.sk), occurredAt: parts[1] as string, id: parts[2] as string });
    }
    startKey = response.LastEvaluatedKey;
    if (markers.length > limit) return { markers: markers.slice(0, limit), more: true };
    if (startKey === undefined) return { markers, more: false };
  }
}

const segmentIndexCovering = (manifest: Manifest, occurredAt: string): number => manifest.segments.findIndex((entry) => entry.upTo >= occurredAt);
const watermarkOf = (manifest: Manifest): string => manifest.segments.length === 0 ? "" : (manifest.segments[manifest.segments.length - 1] as SegmentEntry).upTo;

// ---- maintenance

export interface MaintainResult {
  rebuilt: number;
  folded: number;
  sealed: number;
  merged: number;
  expired: number;
  /** Segments marked dirty for longer than an hour (a removal waiting for its rebuild). */
  overdue: number;
  /** True while the project's first build is not finished. */
  building: boolean;
  /** The pass stopped for want of time with work left. */
  more: boolean;
}
const emptyMaintain = (): MaintainResult => ({ rebuilt: 0, folded: 0, sealed: 0, merged: 0, expired: 0, overdue: 0, building: false, more: false });

async function ensureManifest(ctx: BuildContext): Promise<Manifest | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const read = await readManifest(ctx, ctx.orgId, ctx.project);
    if (read.status === "ok") return read.manifest;
    if (read.status === "bad") { ctx.log?.("record.keyword_index_reset", {}); await resetIndex(ctx); continue; }
    const fresh: Manifest = { version: 1, coverage: "building", segments: [], retired: [], updatedAt: isoOf(nowOf(ctx)) };
    if (await writeManifest(ctx, ctx.orgId, ctx.project, fresh, 0)) return fresh;
  }
  return undefined;
}

/**
 * One maintenance pass over one project (the 15-minute job; the nightly job passes `expiry`): rebuild dirty segments, fold late rows into their segments, rebuild segments whose text or hot rows have expired (nightly only), seal
 * the tail, merge small neighbours, and clean up what died. Bounded by `deadlineAt`; it does the most urgent work first (removals), and stops cleanly between steps.
 */
export async function maintainProject(deps: KeywordIndexDeps, orgId: OrgId, project: string, options: { deadlineAt: number; expiry?: boolean; build?: boolean }): Promise<MaintainResult> {
  const ctx: BuildContext = { ...deps, orgId, project, deadlineAt: options.deadlineAt };
  const result = emptyMaintain();
  // `build: false` is the kill switch (the broker setting): no first build, no seal, no merge, no folding of late rows. What only removes words still runs: the rebuild of segments a removal marked dirty, of expired ones (nightly), the clean-up of
  // what died, and the reset of a manifest that does not parse. A project with no index is left without one.
  const build = options.build !== false;
  let manifest: Manifest | undefined;
  if (build) manifest = await ensureManifest(ctx);
  else {
    const read = await readManifest(ctx, orgId, project);
    if (read.status === "bad") { ctx.log?.("record.keyword_index_reset", {}); await resetIndex(ctx); return result; }
    manifest = read.status === "ok" ? read.manifest : undefined;
    if (manifest === undefined) return result;
  }
  if (manifest === undefined) { result.more = true; return result; }
  await cleanOrphans(ctx);
  manifest = await dropRetired(ctx, manifest);
  const nowSeconds = Math.floor(nowOf(ctx) / 1000);
  const late = build ? await listLateMarkers(ctx, orgId, project, LATE_MAX) : { markers: [] as LateMarker[], more: false };
  if (late.more) result.more = true;

  // 1. Rebuild: dirty segments (a removal waits on these), then the ones a late row falls in, then (nightly) expired ones. A segment built in this pass is not taken again.
  const builtHere = new Set<string>();
  const foldedMarkers = new Set<string>();
  const wanted = (current: Manifest): string | undefined => {
    const dirty = current.segments.filter((entry) => entry.dirty !== undefined).sort((left, right) => String(left.dirty?.since).localeCompare(String(right.dirty?.since)))[0];
    if (dirty !== undefined) return dirty.id;
    const watermark = watermarkOf(current);
    for (const marker of late.markers) {
      if (marker.occurredAt > watermark || foldedMarkers.has(marker.sk)) continue;
      const covering = segmentIndexCovering(current, marker.occurredAt);
      if (covering >= 0 && !builtHere.has((current.segments[covering] as SegmentEntry).id)) return (current.segments[covering] as SegmentEntry).id;
    }
    if (options.expiry === true) {
      return current.segments.find((entry) => !builtHere.has(entry.id) && ((entry.textExpiresMin !== undefined && entry.textExpiresMin <= nowSeconds) || (entry.hotExpiresMin !== undefined && entry.hotExpiresMin <= nowSeconds)))?.id;
    }
    return undefined;
  };
  const markerList = [...late.markers];
  for (let guard = 0; guard < MAX_SEGMENTS; guard += 1) {
    const id = wanted(manifest);
    if (id === undefined) break;
    if (overDeadline(ctx)) { result.more = true; break; }
    const at = manifest.segments.findIndex((entry) => entry.id === id);
    const entry = manifest.segments[at] as SegmentEntry;
    const { after } = rangeOf(manifest, at, at);
    const inRange = markerList.filter((marker) => marker.occurredAt <= entry.upTo && (after === undefined || marker.occurredAt > after));
    const dirtyReason = entry.dirty !== undefined ? "removal" : inRange.length > 0 ? "late" : "expiry";
    const replaced = await replaceSegments(ctx, manifest, at, at);
    if (replaced.status === "conflict") { result.more = true; break; }
    if (replaced.status === "deadline") { result.more = true; break; }
    for (const built of replaced.manifest.segments) if (!manifest.segments.some((old) => old.id === built.id)) builtHere.add(built.id);
    manifest = replaced.manifest;
    for (const marker of inRange) { await tableDelete(ctx, { pk: teamRecordPk(orgId, project), sk: marker.sk }); foldedMarkers.add(marker.sk); }
    result.folded += inRange.length;
    if (dirtyReason === "expiry") result.expired += 1;
    result.rebuilt += 1;
  }
  for (const entry of manifest.segments) if (entry.dirty !== undefined && nowOf(ctx) - Date.parse(entry.dirty.since) > 3_600_000) result.overdue += 1;

  // 2. Seal the tail (and, while the first build is not finished, keep sealing oldest first).
  for (let guard = 0; build && guard < 200 && !overDeadline(ctx); guard += 1) {
    const sealed = await sealTail(ctx, manifest, markerList, foldedMarkers);
    if (sealed.status === "none") break;
    if (sealed.status === "conflict") { result.more = true; break; }
    manifest = sealed.manifest;
    result.sealed += 1;
    if (!sealed.more) break;
  }
  if (build && overDeadline(ctx) && manifest.coverage === "building") result.more = true;

  // 3. Merge one pair of small neighbours.
  if (build && !overDeadline(ctx)) {
    let best: number | undefined;
    for (let at = 0; at + 1 < manifest.segments.length; at += 1) {
      const left = manifest.segments[at] as SegmentEntry;
      const right = manifest.segments[at + 1] as SegmentEntry;
      if (left.dirty !== undefined || right.dirty !== undefined || left.docs + right.docs > SEGMENT_DOCS || (left.srcBytes ?? 0) + (right.srcBytes ?? 0) > SEGMENT_BYTES) continue;
      if (best === undefined || left.docs + right.docs < (manifest.segments[best] as SegmentEntry).docs + (manifest.segments[best + 1] as SegmentEntry).docs) best = at;
    }
    if (best !== undefined) {
      const merged = await replaceSegments(ctx, manifest, best, best + 1);
      if (merged.status === "done") { manifest = merged.manifest; result.merged += 1; }
    }
  }
  result.building = manifest.coverage === "building";
  return result;
}

/**
 * Seals rows after the watermark and older than KEYWORD_LATE_MS into a new segment, when the first build is not finished, or there are SEAL_TRIGGER_ROWS of them, or the oldest is a day old. `more`: rows are left to seal after this one.
 * Sealing an empty range just moves the watermark (the last segment's `upTo`; an empty project gets one empty segment).
 */
async function sealTail(ctx: BuildContext, manifest: Manifest, markers: readonly LateMarker[], folded: Set<string>): Promise<{ status: "none" } | { status: "conflict" } | { status: "sealed"; manifest: Manifest; more: boolean }> {
  const cutoff = isoOf(nowOf(ctx) - KEYWORD_LATE_MS);
  const watermark = watermarkOf(manifest);
  if (watermark >= cutoff) return { status: "none" };
  const rows = await readRows(ctx, ctx.orgId, ctx.project, { ...(watermark === "" ? {} : { after: watermark }), upTo: cutoff, ascending: true, limit: SEGMENT_DOCS, maxBytes: SEGMENT_BYTES });
  const first = rows.items[0] === undefined ? undefined : instantOfItem(rows.items[0]);
  const building = manifest.coverage === "building";
  const due = building || rows.more || rows.items.length >= SEAL_TRIGGER_ROWS || (first !== undefined && nowOf(ctx) - Date.parse(first) >= SEAL_MAX_AGE_MS);
  if (!due) return { status: "none" };
  const upTo = rows.more ? instantOfItem(rows.items[rows.items.length - 1] as Item) : cutoff;
  const nowSeconds = Math.floor(nowOf(ctx) / 1000);
  const docs = rows.items.flatMap((item) => { const doc = docOfItem(item, nowSeconds); return doc === undefined ? [] : [doc]; });
  const coverage: Manifest["coverage"] = rows.more ? manifest.coverage : "complete";
  const sealedMarkers = markers.filter((marker) => marker.occurredAt > watermark && marker.occurredAt <= upTo && !folded.has(marker.sk));
  let next!: Manifest;
  let id: string | undefined;
  if (docs.length === 0 && manifest.segments.length > 0) {
    // nothing to index in the range: the last segment's range grows to cover it
    const last = manifest.segments[manifest.segments.length - 1] as SegmentEntry;
    next = { ...manifest, version: manifest.version + 1, coverage, updatedAt: isoOf(nowOf(ctx)), segments: [...manifest.segments.slice(0, -1), { ...last, upTo }] };
    if (!(await writeManifest(ctx, ctx.orgId, ctx.project, next, manifest.version))) return { status: "conflict" };
  } else {
    id = newSegmentId(nowOf(ctx));
    const written = await withIntents(ctx, [id], async () => {
      const piece = await writePiece(ctx, { upTo, docs, srcBytes: rows.bytes }, id as string);
      next = { ...manifest, version: manifest.version + 1, coverage, updatedAt: isoOf(nowOf(ctx)), segments: [...manifest.segments, piece.entry] };
      if (!(await writeManifest(ctx, ctx.orgId, ctx.project, next, manifest.version))) { await deleteChunks(ctx, ctx.orgId, ctx.project, id as string); return false; }
      return true;
    });
    if (!written) return { status: "conflict" };
  }
  // The markers of the rows this seal took in (listed BEFORE the rows were read, so each row they name was read) are no longer needed.
  for (const marker of sealedMarkers) { await tableDelete(ctx, { pk: teamRecordPk(ctx.orgId, ctx.project), sk: marker.sk }); folded.add(marker.sk); }
  return { status: "sealed", manifest: next, more: rows.more };
}

export interface KeywordIndexJobDeps extends KeywordIndexDeps {
  /** The org's projects (the catalog). */
  projects(orgId: OrgId): Promise<string[]>;
  /** False for a project that is archived or whose company is closing: its index is left alone. */
  projectOpen?(orgId: OrgId, project: string): Promise<boolean>;
  orgs(): Promise<OrgId[]>;
}

export interface KeywordJobSummary extends MaintainResult { orgs: number; projects: number; failed: number }

/** The time one project's pass may run to: the share of what is left of the run that is its turn, and never past the run's own end. */
export function passDeadline(now: number, startedAt: number, runMs: number, stillToServe: number): number {
  const remaining = startedAt + runMs - now;
  return now + Math.min(remaining / Math.max(1, stillToServe), remaining);
}

/**
 * The maintenance job over every workspace and project, inside `runMs`. Each project gets a pass bounded by what is left of the run, shared out by the number still waiting. The start moves with the clock so a project at the
 * end of the list is not always the one that is cut off. A failure in one project never stops the others (a fixed log line, no text).
 */
export async function runKeywordIndexJob(deps: KeywordIndexJobDeps, startedAt: number, runMs: number, options: { expiry?: boolean; build?: boolean } = {}): Promise<KeywordJobSummary> {
  const now = deps.now ?? Date.now;
  const summary: KeywordJobSummary = { ...emptyMaintain(), orgs: 0, projects: 0, failed: 0 };
  const orgs = (await deps.orgs()).sort();
  const targets: Array<{ orgId: OrgId; project: string }> = [];
  for (const orgId of orgs) {
    summary.orgs += 1;
    for (const project of (await deps.projects(orgId)).sort()) if ((await deps.projectOpen?.(orgId, project)) !== false) targets.push({ orgId, project });
  }
  const offset = targets.length === 0 ? 0 : Math.floor(now() / 900_000) % targets.length;
  const ordered = [...targets.slice(offset), ...targets.slice(0, offset)];
  for (const [at, target] of ordered.entries()) {
    const remaining = startedAt + runMs - now();
    if (remaining < 500) { summary.more = true; break; }
    try {
      const done = await maintainProject(deps, target.orgId, target.project, { deadlineAt: passDeadline(now(), startedAt, runMs, ordered.length - at), ...(options.expiry === true ? { expiry: true } : {}), ...(options.build === false ? { build: false } : {}) });
      summary.projects += 1;
      for (const key of ["rebuilt", "folded", "sealed", "merged", "expired", "overdue"] as const) summary[key] += done[key];
      summary.building = summary.building || done.building;
      summary.more = summary.more || done.more;
    } catch {
      summary.failed += 1;
      deps.log?.("record.keyword_index_failed", {});
    }
  }
  if (summary.overdue > 0) deps.log?.("record.keyword_index_overdue", { segments: summary.overdue });
  return summary;
}

// ---- erase (K3)

/**
 * Deletes up to `maxItems` index items (manifest, chunks, build intents) and late markers of a project's partition: a project archive or a company close. Keys only are read (a chunk is 300 KB). Returns how many it
 * deleted and whether any are left. The erase runs this BEFORE it purges the project's rows, so those rows need not wait for a rebuild (`purgeItems` with `indexHandled`).
 */
export async function eraseKeywordIndexItems(deps: KeywordIndexDeps, orgId: OrgId, project: string | undefined, maxItems: number): Promise<{ deleted: number; more: boolean }> {
  const pk = teamRecordPk(orgId, project);
  let deleted = 0;
  for (const prefix of [KWIDX_PREFIX, KWLATE_PREFIX]) {
    let startKey: Record<string, unknown> | undefined;
    do {
      const response = await deps.table.documentClient.send(new QueryCommand({
        TableName: deps.table.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
        ConsistentRead: true, ProjectionExpression: "sk", Limit: 100, ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
      })) as { Items?: Array<{ sk?: unknown }>; LastEvaluatedKey?: Record<string, unknown> };
      for (const item of response.Items ?? []) {
        if (deleted >= maxItems) return { deleted, more: true };
        if (typeof item.sk === "string") { await tableDelete(deps, { pk, sk: item.sk }); deleted += 1; }
      }
      startKey = response.LastEvaluatedKey;
    } while (startKey !== undefined);
  }
  return { deleted, more: false };
}

/** Marks one segment dirty because its chunks cannot be read (a search found them missing). Conditional on the manifest's version, a few tries. */
async function markDamaged(ctx: BuildContext, segment: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const read = await readManifest(ctx, ctx.orgId, ctx.project);
    if (read.status !== "ok" || !read.manifest.segments.some((entry) => entry.id === segment)) return;
    const since = isoOf(nowOf(ctx));
    const next: Manifest = { ...read.manifest, version: read.manifest.version + 1, updatedAt: since, segments: read.manifest.segments.map((entry) => (entry.id === segment && entry.dirty === undefined ? { ...entry, dirty: { since, reason: "damaged" as const } } : entry)) };
    if (await writeManifest(ctx, ctx.orgId, ctx.project, next, read.manifest.version)) return;
  }
}

// ---- removal (K3)

/** The row keys a removal names: the sort key says the project (the partition) and the time. */
function removedRows(rows: readonly Item[]): Array<{ project: string; occurredAt: string; pk: string; sk: string; tombstoned: boolean }> {
  const found: Array<{ project: string; occurredAt: string; pk: string; sk: string; tombstoned: boolean }> = [];
  for (const row of rows) {
    if (typeof row.pk !== "string" || typeof row.sk !== "string") continue;
    const project = projectOfPk(row.pk);
    const at = rowOfSortKey(row.sk);
    if (project !== undefined && at !== undefined) found.push({ project, occurredAt: at.occurredAt, pk: row.pk, sk: row.sk, tombstoned: row.tombstone !== undefined });
  }
  return found;
}

/**
 * Marks the segments that cover these rows dirty, and moves the manifest's version either way (a build that has read the rows can then not switch in). Done AFTER the rows are tombstoned: a build that reads the table from
 * now on leaves them out, and one that read before fails its switch. Returns false when there is no index for the project (nothing to mark).
 */
async function markRemoved(ctx: BuildContext, occurredAts: readonly string[]): Promise<boolean> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const read = await readManifest(ctx, ctx.orgId, ctx.project);
    if (read.status === "none") return false;
    if (read.status === "bad") { await resetIndex(ctx); return false; }
    const { manifest } = read;
    const since = isoOf(nowOf(ctx));
    const dirty = new Set<number>();
    for (const occurredAt of occurredAts) { const at = segmentIndexCovering(manifest, occurredAt); if (at >= 0) dirty.add(at); }
    const next: Manifest = {
      ...manifest, version: manifest.version + 1, updatedAt: since,
      segments: manifest.segments.map((entry, at) => (dirty.has(at) && entry.dirty === undefined ? { ...entry, dirty: { since, reason: "removal" as const } } : entry)),
    };
    if (await writeManifest(ctx, ctx.orgId, ctx.project, next, manifest.version)) return true;
  }
  throw new Error("keyword index: the manifest kept changing");
}

/** For tests and the erase proofs: marks the segments that cover these times dirty (see `markRemoved`). */
export async function markKeywordIndexRemoved(deps: KeywordIndexDeps, orgId: OrgId, project: string, occurredAts: readonly string[]): Promise<boolean> {
  return markRemoved({ ...deps, orgId, project, deadlineAt: Number.POSITIVE_INFINITY }, occurredAts);
}

export interface RemovalGate {
  /** Row keys (`pk|sk`) whose words are out of the index: safe to delete. */
  ready: Set<string>;
  /** How many rows must wait. */
  waiting: number;
  /** Of those, how many are in a project whose gate FAILED (an error, not just a rebuild still to come): counted and logged, never swallowed (`record.keyword_index_gate_failed`). */
  failed: number;
}

/**
 * The wait-for-rebuild rule of the erase (lane K3). Before a row is deleted the index must have been rebuilt without it, the same rule as "a row goes only after its vector". For each project the rows belong to: tombstone any
 * row that is not (so a rebuild leaves it out), mark the covering segments dirty, rebuild them NOW within `budgetMs`, clean retired segments and dead builds, and report the rows whose project has no dirty segment covering
 * them, no retired segment and no build under way. A failure of any step leaves the rows waiting (fail closed); the 15-minute job rebuilds what is left, and the next run of the delete worker finds it done.
 */
export async function removalGate(deps: KeywordIndexDeps, orgId: OrgId, rows: readonly Item[], options: { budgetMs: number }): Promise<RemovalGate> {
  const ready = new Set<string>();
  let waiting = 0;
  let failed = 0;
  const byProject = new Map<string, ReturnType<typeof removedRows>>();
  // A row with no project lives in the company's own partition (`_workspace`), which no index covers: nothing to rebuild, so it is ready.
  for (const row of rows) if (typeof row.pk === "string" && typeof row.sk === "string" && projectOfPk(row.pk) === undefined) ready.add(`${row.pk}|${row.sk}`);
  for (const row of removedRows(rows)) byProject.set(row.project, [...(byProject.get(row.project) ?? []), row]);
  const deadlineAt = nowOf(deps) + options.budgetMs;
  for (const [project, group] of byProject) {
    const ctx: BuildContext = { ...deps, orgId, project, deadlineAt };
    try {
      // A row that is not tombstoned yet would be rebuilt into the segment: it is hidden first, always (the cause is the generic one of a removal), so no build from now on keeps its words.
      for (const row of group) if (!row.tombstoned) await tombstoneItem(deps.table, { pk: row.pk, sk: row.sk }, { at: isoOf(nowOf(deps)), cause: "person_erased" });
      const read = await readManifest(ctx, orgId, project);
      if (read.status === "none") { for (const row of group) ready.add(`${row.pk}|${row.sk}`); continue; }
      if (!(await markRemoved(ctx, group.map((row) => row.occurredAt)))) { for (const row of group) ready.add(`${row.pk}|${row.sk}`); continue; }
      await rebuildDirty(ctx);
      const intents = await cleanOrphans(ctx);
      let state = await readManifest(ctx, orgId, project);
      if (state.status === "ok" && state.manifest.retired.length > 0) { await dropRetired(ctx, state.manifest); state = await readManifest(ctx, orgId, project); }
      const manifest = state.status === "ok" ? state.manifest : undefined;
      const clean = manifest !== undefined && manifest.retired.length === 0 && intents === 0;
      for (const row of group) {
        const covering = manifest === undefined ? -1 : segmentIndexCovering(manifest, row.occurredAt);
        const dirty = covering >= 0 && (manifest as Manifest).segments[covering]?.dirty !== undefined;
        if (clean && !dirty) ready.add(`${row.pk}|${row.sk}`);
      }
    } catch {
      failed += group.filter((row) => !ready.has(`${row.pk}|${row.sk}`)).length;
      deps.log?.("record.keyword_index_gate_failed", { rows: group.length });
    }
    waiting += group.filter((row) => !ready.has(`${row.pk}|${row.sk}`)).length;
  }
  return { ready, waiting, failed };
}

/** Rebuilds the dirty segments of a project, most urgent first, until none is left, the budget is spent or a rebuild loses a race. Returns the manifest as it stands. */
async function rebuildDirty(ctx: BuildContext): Promise<Manifest | undefined> {
  for (let guard = 0; guard < MAX_SEGMENTS; guard += 1) {
    const read = await readManifest(ctx, ctx.orgId, ctx.project);
    if (read.status !== "ok") return undefined;
    const dirty = read.manifest.segments.findIndex((entry) => entry.dirty !== undefined);
    if (dirty < 0) return read.manifest;
    if (overDeadline(ctx)) return read.manifest;
    const replaced = await replaceSegments(ctx, read.manifest, dirty, dirty);
    if (replaced.status === "deadline") return read.manifest;
    // a lost race (conflict) reads the manifest again: a mark written meanwhile is rebuilt on the next turn
  }
  return undefined;
}

// ---- search

export interface KeywordIndexHit { event?: StoredEvent; fact?: StoredFact; score: number }

export interface KeywordIndexView {
  /** How many sealed segments, rows in the tail and late rows the view ranked over (for the log). */
  readonly shape: { segments: number; docs: number; tail: number; late: number };
  /** The best `top` rows and notes for the query among those `accept` allows, best first. Segment hits are reloaded from the table (a row that is gone is left out). */
  rank(query: string, input: { facts: readonly StoredFact[]; accept(meta: DocMeta): boolean; top: number; nowSeconds: number }): Promise<KeywordIndexHit[]>;
}

/**
 * Opens a project's index for a search, or undefined when it cannot answer exactly: no manifest, the first build is not finished (coverage is not complete), a manifest that does not parse, a tail or a set of late rows
 * longer than the bounds, or a segment that cannot be read. The caller then uses the window read of lane K1.
 */
export async function openKeywordIndex(deps: KeywordIndexDeps, orgId: OrgId, project: string, nowSeconds: number): Promise<KeywordIndexView | undefined> {
  const read = await readManifest(deps, orgId, project);
  if (read.status !== "ok" || read.manifest.coverage !== "complete") return undefined;
  const { manifest } = read;
  if (manifest.segments.reduce((sum, entry) => sum + entry.bytes, 0) > SEARCH_INDEX_MAX_BYTES) { deps.log?.("record.keyword_index_too_large", {}); return undefined; }
  const watermark = watermarkOf(manifest);
  // the tail: rows after the watermark, newest first, bounded
  const tail = await readRows(deps, orgId, project, { ...(watermark === "" ? {} : { after: watermark }), ascending: false, limit: TAIL_MAX_ROWS });
  if (tail.more || tail.items.length > TAIL_MAX_ROWS) return undefined;
  const late = await listLateMarkers(deps, orgId, project, LATE_MAX);
  if (late.more) return undefined;
  // the segments, a few at a time
  const readers: SegmentReader[] = [];
  try {
    for (let at = 0; at < manifest.segments.length; at += 6) readers.push(...await Promise.all(manifest.segments.slice(at, at + 6).map((entry) => loadSegment(deps, orgId, project, entry))));
  } catch (error) {
    // A listed segment that cannot be read whole: it is marked dirty (the next pass, or a removal's gate, rebuilds it from the rows) and this search uses the window.
    if (error instanceof DamagedSegmentError) {
      deps.log?.("record.keyword_index_damaged", {});
      await markDamaged({ ...deps, orgId, project, deadlineAt: Number.POSITIVE_INFINITY }, error.segment).catch(() => undefined);
      return undefined;
    }
    throw error;
  }
  // late rows inside a sealed range are read live, unless a rebuild has folded them in already
  const lateKeys = late.markers.filter((marker) => marker.occurredAt <= watermark).flatMap((marker) => {
    const covering = segmentIndexCovering(manifest, marker.occurredAt);
    const reader = covering >= 0 ? readers[covering] : undefined;
    return reader !== undefined && reader.find(Date.parse(marker.occurredAt), marker.id) !== undefined ? [] : [recordEventKey(orgId, project, marker.occurredAt, marker.id)];
  });
  const lateItems = await batchGetItems(deps, lateKeys);
  const liveEvents: StoredEvent[] = [];
  const addLive = (item: Item): void => {
    if (item.tombstone !== undefined || item.archivedAt !== undefined) return;
    const event = eventFromItem(item, nowSeconds);
    if (event !== undefined) liveEvents.push(event);
  };
  for (const item of tail.items) addLive(item);
  for (const item of lateItems) addLive(item);
  const docs = readers.reduce((sum, reader) => sum + reader.docs, 0);
  return {
    shape: { segments: readers.length, docs, tail: tail.items.length, late: lateKeys.length },
    async rank(query, input) {
      const live = [...liveEvents.map((event) => ({ meta: { ms: Date.parse(event.occurredAt), kind: event.kind, source: event.source, restricted: event.audience.kind === "restricted", isFact: false }, tokens: keywordTokens(keywordDocumentOf(event, input.nowSeconds)) })),
        ...input.facts.map((fact) => ({ meta: { ms: Date.parse(fact.createdAt), kind: "fact", source: "rovara", restricted: false, isFact: true }, tokens: keywordTokens(fact.text) }))];
      const parts: ScoringPart[] = [...readers.map((reader) => new SegmentPart(reader)), new LivePart(live)];
      const liveIndex = parts.length - 1;
      const ranked = rankParts(query, parts, input.nowSeconds).filter((hit) => input.accept(parts[hit.part]!.meta(hit.doc)));
      const identity = (hit: { part: number; doc: number }): { ms: number; id: string } => {
        if (hit.part === liveIndex) { const at = hit.doc; return at < liveEvents.length ? { ms: (parts[hit.part] as LivePart).meta(at).ms, id: (liveEvents[at] as StoredEvent).id } : { ms: (parts[hit.part] as LivePart).meta(at).ms, id: (input.facts[at - liveEvents.length] as StoredFact).id }; }
        return { ms: (readers[hit.part] as SegmentReader).occurredAtMs[hit.doc] as number, id: (readers[hit.part] as SegmentReader).docId(hit.doc) };
      };
      const ordered = ranked.map((hit) => ({ hit, who: identity(hit) })).sort((left, right) => right.hit.score - left.hit.score || right.who.ms - left.who.ms || (left.who.id < right.who.id ? 1 : left.who.id > right.who.id ? -1 : 0)).slice(0, input.top);
      const reload = ordered.filter(({ hit }) => hit.part !== liveIndex);
      const reloaded = await batchGetItems(deps, reload.map(({ who }) => recordEventKey(orgId, project, isoOf(who.ms), who.id)));
      const byId = new Map<string, StoredEvent>();
      for (const item of reloaded) { const event = eventFromItem(item, input.nowSeconds); if (event !== undefined) byId.set(event.id, event); }
      const hits: KeywordIndexHit[] = [];
      for (const { hit, who } of ordered) {
        if (hit.part === liveIndex) {
          if (hit.doc < liveEvents.length) hits.push({ event: liveEvents[hit.doc] as StoredEvent, score: hit.score });
          else hits.push({ fact: input.facts[hit.doc - liveEvents.length] as StoredFact, score: hit.score });
        } else {
          const event = byId.get(who.id);
          if (event !== undefined) hits.push({ event, score: hit.score });
        }
      }
      return hits;
    },
  };
}

/** Strongly consistent reads of rows by key, in batches of 100, retrying what the table left unprocessed a few times. A key the table does not return is simply absent. */
async function batchGetItems(deps: KeywordIndexDeps, keys: ReadonlyArray<{ pk: string; sk: string }>): Promise<Item[]> {
  const found: Item[] = [];
  let pending = [...keys];
  for (let attempt = 0; attempt < 4 && pending.length > 0; attempt += 1) {
    const next: Array<{ pk: string; sk: string }> = [];
    for (let at = 0; at < pending.length; at += 100) {
      const response = await deps.table.documentClient.send(new BatchGetCommand({ RequestItems: { [deps.table.tableName]: { Keys: pending.slice(at, at + 100), ConsistentRead: true } } })) as { Responses?: Record<string, Item[]>; UnprocessedKeys?: Record<string, { Keys?: Array<{ pk: string; sk: string }> }> };
      found.push(...(response.Responses?.[deps.table.tableName] ?? []));
      next.push(...(response.UnprocessedKeys?.[deps.table.tableName]?.Keys ?? []));
    }
    pending = next;
  }
  return found;
}
