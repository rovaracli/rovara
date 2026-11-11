// Reading the audit ledger (Task 11). The broker only reads here: the ledger and seals tables, the keys table for a person's
// details, and nothing is written. Every key is built from the `orgId` argument and nothing a caller supplies (a cursor holds
// a sequence number and no org), so one org's admin cannot read another org's records by any parameter.
//
//   readAuditRecords  a page of one org's records with their details opened, filtered by sequence, time, action or actor
//   readAuditStatus   how far the org is sealed, the latest independent time, and the lock mode of the latest seal
//
// The epoch helpers (`readEpoch`, `epochTimestampBound`) are shared with the export builder (export.ts).
import { GetCommand, QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { AUDIT_ERROR_MESSAGES, AUDIT_FILTER_SCAN_MAX, type AuditRecordV1, type EpochStatementV1, type LockedObjectV1 } from "@agentx/cloud-contracts";
import { OrgIdSchema, agentXError } from "@rovara-code/contracts";
import { auditSeqSortKey } from "./appender.js";
import type { AuditKeyring, OpenedDetail, SealedDetail } from "./keyring.js";

/** The most records one page holds. */
export const AUDIT_READ_PAGE_MAX = 200;
export const AUDIT_READ_PAGE_DEFAULT = 50;
/** The seals the status looks back through for the latest independent time and the epochs still without one. */
export const AUDIT_STATUS_SEAL_WINDOW = 20;
/** A filtered scan reads this many records at a time. */
const SCAN_PAGE = 500;

export interface AuditReadDeps {
  documentClient: DynamoDBDocumentClient;
  ledgerTable: string;
  sealsTable: string;
  /** Opens details. Its keys are looked up by the `orgId` passed to each call. */
  keyring: AuditKeyring;
}

export type LockMode = "COMPLIANCE" | "GOVERNANCE";

export interface AuditReadQuery {
  fromSeq?: number;
  toSeq?: number;
  /** A time range over `recordedAt` (ISO 8601): from this time on, up to this time. Located by binary search. */
  from?: string;
  to?: string;
  /** Filters: at most AUDIT_FILTER_SCAN_MAX records may lie in the range, else AUDIT_FILTER_TOO_WIDE. */
  action?: string;
  actorId?: string;
  /** The `nextCursor` of the page before. */
  cursor?: string;
  /** At most AUDIT_READ_PAGE_MAX. */
  limit?: number;
  /** QA6-09: `newest` returns the newest record first and pages back toward the oldest (the cursor then says where the page before ended going backwards). Absent: oldest first, as ever. */
  order?: "newest";
}

export interface AuditReadRecord {
  record: AuditRecordV1;
  /** The record's details, opened: a person's part is `erased` after their key was deleted, and every part after the org was shredded. */
  details: OpenedDetail[];
}

export interface AuditLedgerStatus {
  headSeq: number;
  /** The last sequence number in the org's last seal (0 when nothing is sealed). */
  sealedThroughSeq: number;
  /** The latest time an independent authority vouched for, among the org's newest seals (its own timestamp or a later epoch's that covers it). */
  latestTimestamp?: string;
  /**
   * Epochs among the org's newest seals that have no independent time yet, neither their own nor a covering one. Read it beside
   * `latestTimestamp`: a date there says nothing about these.
   */
  epochsWithoutTimestamp: string[];
  /** The lock mode of the org's latest seal. */
  lockMode?: LockMode;
}

export interface AuditReadResult extends AuditLedgerStatus {
  records: AuditReadRecord[];
  /** Present when more records may follow; pass it back as `cursor`. */
  nextCursor?: string;
}

type Item = Record<string, unknown>;

function rangeInvalid(): Error {
  return agentXError("AUDIT_RANGE_INVALID", AUDIT_ERROR_MESSAGES.AUDIT_RANGE_INVALID);
}

/** The org id every key is built from: checked, so a malformed one cannot reach a key. */
export function checkedOrgId(orgId: string): string {
  const parsed = OrgIdSchema.safeParse(orgId);
  if (!parsed.success) throw new TypeError("audit ledger: not an organization id");
  return parsed.data;
}

export const encodeAuditCursor = (seq: number): string => Buffer.from(JSON.stringify({ seq }), "utf8").toString("base64url");

export function decodeAuditCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    const seq = (parsed as { seq?: unknown } | null)?.seq;
    if (typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0) return seq;
  } catch {
    // fall through
  }
  throw rangeInvalid();
}

const wholeNumber = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

function instant(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw rangeInvalid();
  return ms;
}

// ---- table reads ------------------------------------------------------------------------------------------------

async function getItem(deps: AuditReadDeps, table: string, pk: string, sk: string): Promise<Item | undefined> {
  const out = await deps.documentClient.send(new GetCommand({ TableName: table, Key: { pk, sk }, ConsistentRead: true }));
  return out.Item;
}

export async function readHeadSeq(deps: AuditReadDeps, orgId: string): Promise<number> {
  const head = await getItem(deps, deps.ledgerTable, `AUDIT#${orgId}`, "HEAD");
  if (head === undefined) return 0;
  if (!wholeNumber(head.seq) || head.seq < 0) throw new Error("audit ledger: the head is malformed");
  return head.seq;
}

export async function readSealedSeq(deps: AuditReadDeps, orgId: string): Promise<number> {
  const state = await getItem(deps, deps.sealsTable, `SEALED#${orgId}`, "STATE");
  if (state === undefined) return 0;
  if (!wholeNumber(state.sealedSeq) || state.sealedSeq < 0) throw new Error("audit ledger: the sealed state is malformed");
  return state.sealedSeq;
}

/** A stored record as the chain defines it: the table's key attributes and the sealed details are not part of it. */
export function recordOfItem(item: Item): AuditRecordV1 {
  return Object.fromEntries(Object.entries(item).filter(([name]) => name !== "pk" && name !== "sk" && name !== "sealedDetails")) as unknown as AuditRecordV1;
}

export function sealedDetailsOf(item: Item): SealedDetail[] {
  return Array.isArray(item.sealedDetails) ? (item.sealedDetails as SealedDetail[]) : [];
}

/** Records `from` to `to` as stored items, in order (every page of the query is followed). */
export async function queryLedgerItems(deps: AuditReadDeps, orgId: string, from: number, to: number): Promise<Item[]> {
  const items: Item[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const out = await deps.documentClient.send(new QueryCommand({
      TableName: deps.ledgerTable,
      KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
      ExpressionAttributeValues: { ":pk": `AUDIT#${orgId}`, ":from": auditSeqSortKey(from), ":to": auditSeqSortKey(to) },
      ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    }));
    items.push(...(out.Items ?? []));
    start = out.LastEvaluatedKey;
  } while (start !== undefined);
  return items;
}

// ---- epochs -------------------------------------------------------------------------------------------------------

const EPOCH_ID = /^e\d{8}T\d{4}Z$/;
const STAMP_PREFIX = "stamp#";

export interface EpochStamp {
  object: LockedObjectV1;
  genTime: string;
}

export interface EpochRecord {
  epochId: string;
  status: string;
  closedAt: string;
  prevEpochId: string | null;
  statement?: EpochStatementV1;
  objects?: { statement: LockedObjectV1; leaves: LockedObjectV1 };
  /** Timestamp tokens by authority label. */
  stamps: Record<string, EpochStamp>;
  /** The epoch whose tokens cover this one, when it has none of its own. */
  coveredBy?: string;
}

export function isEpochId(value: unknown): value is string {
  return typeof value === "string" && EPOCH_ID.test(value);
}

export async function readEpoch(deps: AuditReadDeps, epochId: string): Promise<EpochRecord | undefined> {
  if (!isEpochId(epochId)) throw new Error("audit ledger: not an epoch id");
  const item = await getItem(deps, deps.sealsTable, `EPOCH#${epochId}`, "META");
  if (item === undefined) return undefined;
  return {
    epochId,
    status: String(item.status),
    closedAt: String(item.closedAt),
    prevEpochId: isEpochId(item.prevEpochId) ? item.prevEpochId : null,
    ...(item.statement === undefined ? {} : { statement: item.statement as EpochStatementV1 }),
    ...(item.objects === undefined ? {} : { objects: item.objects as NonNullable<EpochRecord["objects"]> }),
    stamps: Object.fromEntries(Object.entries(item).filter(([name]) => name.startsWith(STAMP_PREFIX)).map(([name, value]) => [name.slice(STAMP_PREFIX.length), value as EpochStamp])),
    ...(isEpochId(item.covered_by) ? { coveredBy: item.covered_by } : {}),
  };
}

const earliest = (times: readonly string[]): string | undefined => times.reduce<string | undefined>((best, time) => (best === undefined || Date.parse(time) < Date.parse(best) ? time : best), undefined);

/** The independent time that bounds an epoch: its own earliest token time, else its covering epoch's; undefined when it has neither. */
export async function epochTimestampBound(deps: AuditReadDeps, epoch: EpochRecord, cache: Map<string, EpochRecord | undefined> = new Map()): Promise<string | undefined> {
  const own = earliest(Object.values(epoch.stamps).map((stamp) => stamp.genTime));
  if (own !== undefined || epoch.coveredBy === undefined) return own;
  if (!cache.has(epoch.coveredBy)) cache.set(epoch.coveredBy, await readEpoch(deps, epoch.coveredBy));
  const covering = cache.get(epoch.coveredBy);
  return covering === undefined ? undefined : earliest(Object.values(covering.stamps).map((stamp) => stamp.genTime));
}

/** How far the org is sealed and timestamped. Looks at the org's newest AUDIT_STATUS_SEAL_WINDOW seals, not the whole history. */
export async function readAuditStatus(deps: AuditReadDeps, orgId: string): Promise<AuditLedgerStatus> {
  checkedOrgId(orgId);
  const [headSeq, sealedThroughSeq] = await Promise.all([readHeadSeq(deps, orgId), readSealedSeq(deps, orgId)]);
  const newest = await deps.documentClient.send(new QueryCommand({
    TableName: deps.sealsTable,
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: { ":pk": `SEALS#${orgId}` },
    ScanIndexForward: false,
    Limit: AUDIT_STATUS_SEAL_WINDOW,
    ConsistentRead: true,
  }));
  const seals = newest.Items ?? [];
  const lockMode = (seals[0]?.objects as { seal?: { lockMode?: unknown } } | undefined)?.seal?.lockMode;
  const cache = new Map<string, EpochRecord | undefined>();
  const withoutTimestamp: string[] = [];
  let latest: string | undefined;
  for (const epochId of new Set(seals.map((seal): unknown => seal.epochId).filter(isEpochId))) {
    if (!cache.has(epochId)) cache.set(epochId, await readEpoch(deps, epochId));
    const epoch = cache.get(epochId);
    if (epoch === undefined) continue;
    const bound = await epochTimestampBound(deps, epoch, cache);
    if (bound === undefined) withoutTimestamp.push(epochId);
    else if (latest === undefined || Date.parse(bound) > Date.parse(latest)) latest = bound;
  }
  return {
    headSeq,
    sealedThroughSeq,
    ...(latest === undefined ? {} : { latestTimestamp: latest }),
    epochsWithoutTimestamp: withoutTimestamp.sort(),
    ...(lockMode === "COMPLIANCE" || lockMode === "GOVERNANCE" ? { lockMode } : {}),
  };
}

// ---- records ------------------------------------------------------------------------------------------------------

/** `recordedAt` of one record as a time, or undefined when the record is missing. */
async function recordedAtOf(deps: AuditReadDeps, orgId: string, seq: number): Promise<number | undefined> {
  const item = await getItem(deps, deps.ledgerTable, `AUDIT#${orgId}`, auditSeqSortKey(seq));
  if (item === undefined) return undefined;
  const ms = Date.parse(String(item.recordedAt));
  if (Number.isNaN(ms)) throw new Error("audit ledger: a record has no readable time");
  return ms;
}

/** The first sequence number in 1..head whose `recordedAt` is at or after `ms` (head + 1 when none is). `recordedAt` rises with `seq`. */
export async function firstSeqAtOrAfter(deps: AuditReadDeps, orgId: string, head: number, ms: number): Promise<number> {
  let low = 1;
  let high = head + 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const at = await recordedAtOf(deps, orgId, middle);
    if (at === undefined) throw new Error("audit ledger: a record is missing from the chain");
    if (at >= ms) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** The last sequence number in 1..head whose `recordedAt` is at or before `ms` (0 when none is). */
export async function lastSeqAtOrBefore(deps: AuditReadDeps, orgId: string, head: number, ms: number): Promise<number> {
  let low = 1;
  let high = head + 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const at = await recordedAtOf(deps, orgId, middle);
    if (at === undefined) throw new Error("audit ledger: a record is missing from the chain");
    if (at > ms) high = middle;
    else low = middle + 1;
  }
  return low - 1;
}

async function openRecord(deps: AuditReadDeps, orgId: string, item: Item): Promise<AuditReadRecord> {
  const record = recordOfItem(item);
  const sealed = sealedDetailsOf(item);
  return { record, details: sealed.length === 0 ? [] : await deps.keyring.openDetails(orgId, record.seq, sealed) };
}

/** What a records query asks, once every check that needs no table has passed (AUDIT_RANGE_INVALID otherwise). */
export interface CheckedReadQuery {
  limit: number;
  fromMs: number | undefined;
  toMs: number | undefined;
  /** The sequence number the cursor says the page before ended at (0 without a cursor). */
  after: number;
}

/**
 * Every check on a records query that reads nothing: whole numbers, ranges, times, filters and the cursor. A caller that must
 * record a read before it happens (the staff path) runs this first, so that a typo leaves no record of a read that never was.
 */
export function checkReadQuery(query: AuditReadQuery): CheckedReadQuery {
  const { fromSeq, toSeq, from, to, action, actorId, cursor } = query;
  if (query.limit !== undefined && (!wholeNumber(query.limit) || query.limit < 1)) throw rangeInvalid();
  const limit = Math.min(query.limit ?? AUDIT_READ_PAGE_DEFAULT, AUDIT_READ_PAGE_MAX);
  for (const seq of [fromSeq, toSeq]) if (seq !== undefined && (!wholeNumber(seq) || seq < 1)) throw rangeInvalid();
  if (fromSeq !== undefined && toSeq !== undefined && fromSeq > toSeq) throw rangeInvalid();
  const fromMs = from === undefined ? undefined : instant(from);
  const toMs = to === undefined ? undefined : instant(to);
  if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) throw rangeInvalid();
  if ((action !== undefined && (action === "" || action.length > 64)) || (actorId !== undefined && (actorId === "" || actorId.length > 200))) throw rangeInvalid();
  const after = cursor === undefined ? 0 : decodeAuditCursor(cursor);
  return { limit, fromMs, toMs, after };
}

/**
 * A page of the org's records, oldest first, with details opened (for owners and admins: the caller decides who may call).
 * The range is the intersection of the sequence range and the time range given; a filter on `action` or `actorId` needs a range
 * of at most AUDIT_FILTER_SCAN_MAX records. `limit` above AUDIT_READ_PAGE_MAX is lowered to it.
 */
export async function readAuditRecords(deps: AuditReadDeps, orgId: string, query: AuditReadQuery = {}): Promise<AuditReadResult> {
  checkedOrgId(orgId);
  const { fromSeq, toSeq, action, actorId } = query;
  const { limit, fromMs, toMs, after } = checkReadQuery(query);
  const status = await readAuditStatus(deps, orgId);
  const { headSeq } = status;
  let low = fromSeq ?? 1;
  let high = Math.min(toSeq ?? headSeq, headSeq);
  if (fromMs !== undefined && headSeq > 0) low = Math.max(low, await firstSeqAtOrAfter(deps, orgId, headSeq, fromMs));
  if (toMs !== undefined && headSeq > 0) high = Math.min(high, await lastSeqAtOrBefore(deps, orgId, headSeq, toMs));
  const filtered = action !== undefined || actorId !== undefined;
  // The width of the range the person asked for, before the cursor moves in: the answer to "too wide" must not change page to page.
  if (filtered && high - low + 1 > AUDIT_FILTER_SCAN_MAX) throw agentXError("AUDIT_FILTER_TOO_WIDE", AUDIT_ERROR_MESSAGES.AUDIT_FILTER_TOO_WIDE);
  if (query.order === "newest") return newestFirst(deps, orgId, status, { low, high, limit, filtered, action, actorId, before: query.cursor === undefined ? undefined : after });
  low = Math.max(low, after + 1);

  const found: Item[] = [];
  for (let start = low; start <= high && found.length < limit; ) {
    const pageEnd = filtered ? Math.min(high, start + SCAN_PAGE - 1) : Math.min(high, start + (limit - found.length) - 1);
    for (const item of await queryLedgerItems(deps, orgId, start, pageEnd)) {
      if (action !== undefined && item.action !== action) continue;
      if (actorId !== undefined && (item.actor as { id?: unknown } | undefined)?.id !== actorId) continue;
      found.push(item);
      if (found.length >= limit) break;
    }
    start = pageEnd + 1;
  }
  const records: AuditReadRecord[] = [];
  for (const item of found) records.push(await openRecord(deps, orgId, item));
  const last = found.at(-1);
  return {
    ...status,
    records,
    // Full page that stopped before the end of the range: more may follow.
    ...(found.length >= limit && last !== undefined && Number(last.seq) < high ? { nextCursor: encodeAuditCursor(Number(last.seq)) } : {}),
  };
}


/**
 * QA6-09: the same range read from its newest end. A page walks down from the top of the range (or from the record before the cursor's), in chunks that are re-ordered newest first; an unfiltered page reads
 * only what it returns. The cursor is the lowest sequence number returned, and the next page is everything below it.
 */
async function newestFirst(
  deps: AuditReadDeps, orgId: string, status: AuditLedgerStatus,
  range: { low: number; high: number; limit: number; filtered: boolean; action: string | undefined; actorId: string | undefined; before: number | undefined },
): Promise<AuditReadResult> {
  const { low, limit, filtered, action, actorId } = range;
  const high = range.before === undefined ? range.high : Math.min(range.high, range.before - 1);
  const found: Item[] = [];
  for (let end = high; end >= low && found.length < limit; ) {
    const start = Math.max(low, filtered ? end - SCAN_PAGE + 1 : end - (limit - found.length) + 1);
    const chunk = (await queryLedgerItems(deps, orgId, start, end)).reverse();
    for (const item of chunk) {
      if (action !== undefined && item.action !== action) continue;
      if (actorId !== undefined && (item.actor as { id?: unknown } | undefined)?.id !== actorId) continue;
      found.push(item);
      if (found.length >= limit) break;
    }
    end = start - 1;
  }
  const records: AuditReadRecord[] = [];
  for (const item of found) records.push(await openRecord(deps, orgId, item));
  const last = found.at(-1);
  return { ...status, records, ...(found.length >= limit && last !== undefined && Number(last.seq) > low ? { nextCursor: encodeAuditCursor(Number(last.seq)) } : {}) };
}
