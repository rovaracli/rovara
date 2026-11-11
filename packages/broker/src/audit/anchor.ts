// The epoch sealer (the anchor). Every 15 minutes it takes each org's new records, seals them into create-only objects in
// the Object Lock bucket, and chains the epoch to the one before it. The locked objects are the truth for "what was sealed":
// the table state below only says where to continue, and every continuation is checked against the locked seal.
//
// Seals table (this function is its only writer):
//   EPOCH#<epochId> META        { status, closedAt, prevEpochId, prevStatementHash, createdAt, statement?, statementHash?, objects? }
//   EPOCH#<epochId> ORG#<org>   the org's intent: { fromSeq, toSeq, finalized, seal?, objects?, index?, skipped?, blocked? }
//   EPOCH_HEAD HEAD             { epochId, statementHash, closedAt } of the last completed epoch, and `openEpochId` while one is open
//   SEALED#<org> STATE          { sealedSeq, lastFromSeq, lastSealHash, lastSealVersionId, lastEpochId, sealedAt }
//   SEALS#<org> <fromSeq>       { epochId, toSeq, objects }: the index of an org's seals
//   BACKSTOP STATE              { hour }: the hour the backstop last completed
// An epoch's META also carries `stamp#<label>` (Task 10: { object, genTime } of the timestamp token stored for that authority)
// and, for an epoch that has no token of its own, `covered_by` (the epoch whose tokens cover it, by the statements' chain).
// Ledger table (the appender's; this function only reads it, except for the dirty markers): AUDIT#<org> records and HEAD,
// AUDIT_DIRTY markers (read, put by the backstop, deleted by a finalize), AUDIT_ORGS (read).
//
// One statement per epoch id, and epochs only move forward, are structural here and not a matter of care:
//  - The epoch is opened by one transaction that creates its META (`attribute_not_exists`) and sets `openEpochId` on HEAD
//    under the conditions `no epoch open`, `epochId = the last completed id`, `new id > last id` and `new closedAt > last
//    closedAt`. Two runs, a retry, or a clock that went backwards cannot open a second epoch with an id already used or
//    one that is not later than the last.
//  - Every statement field comes from that META item, and the statement is chosen once (`attribute_not_exists(statement)`)
//    from the intents' stored seals; after that the frozen seals must reproduce it exactly or the run stops. Objects are
//    written create-only and a resume rewrites the same bytes.
//  - The epoch is closed by one transaction that marks META `sealed` and moves HEAD on (and clears `openEpochId`).
import { createHash } from "node:crypto";
import { GetObjectCommand, HeadObjectCommand, ListObjectVersionsCommand, PutObjectCommand, type PutObjectCommandInput, type S3ClientConfig } from "@aws-sdk/client-s3";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { AUDIT_BACKSTOP_SEAL_AGE_MINUTES, AUDIT_MAX_RECORDS_PER_ORG_EPOCH, AUDIT_SEAL_INTERVAL_MINUTES, auditCanonicalJson, checkChain, genesisHash, merkleRoot, recordHash, recordLeafData, sealHash, sealLeafData, statementHash, timestampCoversRecord, verifyTimeStampToken, type AuditRecordV1, type EpochStatementV1, type LockedObjectV1, type OrgSealV1 } from "@agentx/cloud-contracts";
import { processDueShreds } from "./erase.js";
import { currentLockState, enforceObjectLock, runLockChecks, type LockCheckDeps } from "./lock-check.js";
import { TsaError, checkGenTime, randomNonce, requestTimestamp, type TsaDeps, type TsaSettings, type TsaTarget } from "./tsa-client.js";

/** The event the schedule sends (EventBridge Scheduler, every 15 minutes). */
export const AUDIT_EPOCH_SOURCE = "agentx.audit-epoch";

const SLOT_MS = AUDIT_SEAL_INTERVAL_MINUTES * 60_000;
/** Orgs are processed this many at a time. */
const PAGE = 50;
/** A transaction that hit a TransactionConflict is tried again this many times. */
const CONFLICT_RETRIES = 5;
const CONFLICT_BACKOFF_MS = 25;
/** The fourth item of an org's finalize transaction: the dirty marker. */
const MARKER_INDEX = 3;
const INTENT_INDEX = 2;
/** Attributes of an epoch's META that hold a timestamp token's record are `stamp#<label>`. */
const STAMP_PREFIX = "stamp#";
/** One run asks each timestamp authority at most this often (I11: the epoch of the run and the newest one still waiting). */
const MAX_STAMP_REQUESTS_PER_LABEL = 2;

/**
 * What the anchor runs with. `documentClient` is its own client: it is granted the seals table, and on the ledger table only
 * reads and the dirty marker. `s3` is built with `auditS3ClientConfig`. `lock` is what the stack deployed (the Object Lock
 * floor itself is in code: lock-check.ts).
 */
export interface AnchorDeps extends LockCheckDeps {
  /** Pauses before a retry (a TransactionConflict, a 409 from S3). Defaults to a timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Task 10: the timestamp authorities. Absent means none: epochs are sealed without a token (`AUDIT_TSA_KIND=off`). */
  tsa?: TsaDeps;
  /**
   * Task 15: where the shred sweep works (the keys table, the State table where the due items live, the exports bucket). Absent means
   * no sweep. It uses this client and `s3` (one client serves both buckets) and `sleep` for its 30-second wait.
   */
  shred?: { keysTable: string; stateTable: string; exportsBucket: string; now?: () => number; remainingMs?: () => number };
}

export interface AnchorEpochSummary {
  epochId: string;
  status: "sealed" | "stamp_pending";
  /** Orgs sealed in the epoch (the leaves). */
  orgs: number;
  /** Orgs left unsealed in this epoch (failed a check; a person must look). */
  skipped: number;
  /** Orgs whose seal is in the statement but whose finalize was refused (the table state was changed). */
  blocked: number;
  records: number;
  /** True for an epoch that an earlier run opened and this run finished. */
  resumed: boolean;
}

export interface AnchorRunResult {
  status: "idle" | "sealed" | "stamp_pending" | "stopped";
  /** Why a run did nothing (`idle`) or stopped. */
  reason?: string;
  epochs: AnchorEpochSummary[];
}

/** The S3 client's settings: a checksum on every request that supports one (an Object Lock bucket requires it). */
export function auditS3ClientConfig(region?: string): S3ClientConfig {
  return {
    ...(region === undefined ? {} : { region }),
    requestChecksumCalculation: "WHEN_SUPPORTED",
    maxAttempts: 3,
  };
}

const pad12 = (seq: number): string => String(seq).padStart(12, "0");
export const recordsObjectKey = (orgId: string, fromSeq: number): string => `orgs/${orgId}/records/${pad12(fromSeq)}.jsonl`;
export const sealObjectKey = (orgId: string, fromSeq: number): string => `orgs/${orgId}/seals/${pad12(fromSeq)}.json`;
const epochDirectory = (epochId: string): string => `epochs/${epochId.slice(1, 5)}/${epochId.slice(5, 7)}/${epochId.slice(7, 9)}`;
export const statementObjectKey = (epochId: string): string => `${epochDirectory(epochId)}/${epochId}.json`;
export const leavesObjectKey = (epochId: string): string => `${epochDirectory(epochId)}/${epochId}.leaves.json`;
/** The timestamp token of an epoch from one authority (`digicert`, `sectigo`, `custom-1`, `custom-2`): the DER TimeStampToken. */
export const tokenObjectKey = (epochId: string, label: string): string => `${epochDirectory(epochId)}/${epochId}.${label}.tsr`;

/** `e20261020T1215Z` for the 15-minute slot that contains `ms`. */
export function epochIdAt(ms: number): string {
  const slot = new Date(Math.floor(ms / SLOT_MS) * SLOT_MS);
  const two = (value: number): string => String(value).padStart(2, "0");
  return `e${String(slot.getUTCFullYear())}${two(slot.getUTCMonth() + 1)}${two(slot.getUTCDate())}T${two(slot.getUTCHours())}${two(slot.getUTCMinutes())}Z`;
}

/**
 * The request that creates an object in the ledger bucket. It satisfies the bucket policy for both lock profiles: it is
 * conditional (`If-None-Match: *`, RequireConditionalWrites) and states no retention of its own, so the bucket's default
 * retention applies and DenyShortRetention (which looks at a stated retain-until date) has nothing to refuse. The checksum
 * is what an Object Lock bucket requires of a PutObject.
 */
export function lockedPutInput(bucket: string, key: string, text: string | Uint8Array, contentType: string): PutObjectCommandInput {
  return {
    Bucket: bucket,
    Key: key,
    Body: text,
    ContentType: contentType,
    IfNoneMatch: "*",
    ChecksumAlgorithm: "SHA256",
    ChecksumSHA256: createHash("sha256").update(text).digest("base64"),
  };
}

type Item = Record<string, unknown>;

/** The run must stop here: sealing pauses until a person looks. Its entry is logged. */
class StopRun extends Error {
  /** `entry` is logged when the run stops; undefined when the cause was already logged where it was found. */
  constructor(readonly reason: string, readonly entry: Record<string, unknown> | undefined) {
    super(`audit anchor stopped: ${reason}`);
    this.name = "AuditAnchorStop";
  }
}
/** The seal or records key of an org is not empty and not our own bytes (a delete marker, a second version, other bytes). */
class VersionDriftError extends Error {
  constructor(readonly key: string) {
    super("audit anchor: version drift");
    this.name = "AuditVersionDrift";
  }
}
/** A create-only write got 412 and the stored bytes are not ours. */
class ObjectConflictError extends Error {
  constructor(readonly key: string) {
    super("audit anchor: object conflict");
    this.name = "AuditObjectConflict";
  }
}
/** An object was written without the retention the bucket promises. */
class LockMissingError extends Error {
  constructor(readonly key: string) {
    super("audit anchor: no retention on an object");
    this.name = "AuditLockMissing";
  }
}
/** The org's records or its sealed state do not fit the locked seal. */
class ChainMismatchError extends Error {
  constructor(readonly reason: string, readonly details: Record<string, unknown> = {}) {
    super(`audit anchor: chain mismatch (${reason})`);
    this.name = "AuditChainMismatch";
  }
}

interface Context {
  deps: AnchorDeps;
  now: number;
  nowIso: string;
  /** Requests made to each timestamp authority in this run (at most MAX_STAMP_REQUESTS_PER_LABEL, however many epochs the run drives). */
  stampRequests: Map<string, number>;
  /** When this run last sent each authority a request (the spacing is measured from it). */
  lastStampRequestAt: Map<string, number>;
  /** The latest record time of each epoch looked up in this run (the genTime check), by epoch id. */
  lastRecordedAt: Map<string, string | undefined>;
  /** The epochs whose covering was settled (or refused) in this run: it is not repeated within the run. */
  settled: Set<string>;
}

/** A timestamp token kept for an epoch: where it is stored, and the time the authority vouches for. */
interface Stamp {
  object: LockedObjectV1;
  genTime: string;
}

interface EpochMeta {
  epochId: string;
  status: "freezing" | "frozen" | "stamp_pending" | "sealed";
  closedAt: string;
  prevEpochId: string | null;
  prevStatementHash: string | null;
  statement?: EpochStatementV1;
  objects?: { statement: LockedObjectV1; leaves: LockedObjectV1 };
  /** Timestamp tokens by authority label (Task 10). */
  stamps: Record<string, Stamp>;
  /** The epoch whose tokens cover this one, when it has none of its own. */
  coveredBy?: string;
}

interface Intent {
  orgId: string;
  fromSeq: number;
  toSeq: number;
  finalized: boolean;
  seal?: OrgSealV1;
  objects?: { records: LockedObjectV1; seal: LockedObjectV1 };
  index?: { index: number; size: number };
  skipped?: string;
  blocked?: string;
  /** The `recordedAt` of the last record the seal covers (Task 10: a timestamp must not predate it by more than 5 minutes). */
  lastRecordedAt?: string;
}

interface SealedState {
  sealedSeq: number;
  lastFromSeq: number;
  lastSealHash: string;
  lastSealVersionId: string;
  lastEpochId: string;
  sealedAt: string;
}

const timerSleep = (ms: number): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

function httpStatus(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
}

function isNotFound(error: unknown): boolean {
  return ["NoSuchKey", "NoSuchVersion", "NotFound"].includes(errorName(error)) || httpStatus(error) === 404;
}

function isConditionalFailure(error: unknown): boolean {
  return errorName(error) === "ConditionalCheckFailedException";
}

/** The per-item codes of a cancelled transaction, or undefined for any other error. */
function cancellationCodes(error: unknown): string[] | undefined {
  if (errorName(error) !== "TransactionCanceledException") return undefined;
  const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
  return reasons === undefined ? undefined : reasons.map((reason) => reason.Code ?? "None");
}

function isTransactionConflict(error: unknown): boolean {
  return errorName(error) === "TransactionConflictException" || (cancellationCodes(error) ?? []).includes("TransactionConflict");
}

function integer(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`audit anchor: ${what} is malformed`);
  return value;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string") throw new Error(`audit anchor: ${what} is malformed`);
  return value;
}

const sha256Hex = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

async function getItem(ctx: Context, table: string, pk: string, sk: string): Promise<Item | undefined> {
  const out = await ctx.deps.documentClient.send(new GetCommand({ TableName: table, Key: { pk, sk }, ConsistentRead: true }));
  return out.Item;
}

async function queryAll(ctx: Context, input: { TableName: string; KeyConditionExpression: string; ExpressionAttributeValues: Record<string, unknown> }): Promise<Item[]> {
  const items: Item[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const out = await ctx.deps.documentClient.send(new QueryCommand({ ...input, ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }) }));
    items.push(...(out.Items ?? []));
    start = out.LastEvaluatedKey;
  } while (start !== undefined);
  return items;
}

async function transact(ctx: Context, items: TransactWriteCommandInput["TransactItems"]): Promise<void> {
  await ctx.deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
}

/** Runs `work` over `items` in pages of PAGE; every item of a page finishes before the next page starts or a failure is thrown. */
async function eachPage<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  for (let offset = 0; offset < items.length; offset += PAGE) {
    const results = await Promise.allSettled(items.slice(offset, offset + PAGE).map((item) => work(item)));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason as unknown);
    if (failures.length > 0) throw failures.find((failure) => failure instanceof StopRun) ?? failures[0];
  }
}

// ---- reading the ledger -----------------------------------------------------------------------------------------

function toIntent(item: Item): Intent {
  return {
    orgId: text(item.sk, "intent key").slice("ORG#".length),
    fromSeq: integer(item.fromSeq, "intent fromSeq"),
    toSeq: integer(item.toSeq, "intent toSeq"),
    finalized: item.finalized === true,
    ...(item.seal === undefined ? {} : { seal: item.seal as OrgSealV1 }),
    ...(item.objects === undefined ? {} : { objects: item.objects as Intent["objects"] }),
    ...(item.index === undefined ? {} : { index: item.index as Intent["index"] }),
    ...(typeof item.skipped === "string" ? { skipped: item.skipped } : {}),
    ...(typeof item.blocked === "string" ? { blocked: item.blocked } : {}),
    ...(typeof item.lastRecordedAt === "string" ? { lastRecordedAt: item.lastRecordedAt } : {}),
  } as Intent;
}

async function readIntents(ctx: Context, epochId: string): Promise<Intent[]> {
  const items = await queryAll(ctx, {
    TableName: ctx.deps.sealsTable,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": `EPOCH#${epochId}`, ":prefix": "ORG#" },
  });
  return items.map(toIntent).sort((left, right) => (left.orgId < right.orgId ? -1 : left.orgId > right.orgId ? 1 : 0));
}

async function readMeta(ctx: Context, epochId: string): Promise<EpochMeta> {
  const item = await getItem(ctx, ctx.deps.sealsTable, `EPOCH#${epochId}`, "META");
  if (item === undefined) throw new Error(`audit anchor: epoch ${epochId} has no META item`);
  return {
    epochId,
    status: text(item.status, "epoch status") as EpochMeta["status"],
    closedAt: text(item.closedAt, "epoch closedAt"),
    prevEpochId: item.prevEpochId === null || item.prevEpochId === undefined ? null : text(item.prevEpochId, "prevEpochId"),
    prevStatementHash: item.prevStatementHash === null || item.prevStatementHash === undefined ? null : text(item.prevStatementHash, "prevStatementHash"),
    ...(item.statement === undefined ? {} : { statement: item.statement as EpochStatementV1 }),
    ...(item.objects === undefined ? {} : { objects: item.objects as NonNullable<EpochMeta["objects"]> }),
    stamps: Object.fromEntries(Object.entries(item).filter(([name]) => name.startsWith(STAMP_PREFIX)).map(([name, value]) => [name.slice(STAMP_PREFIX.length), value as Stamp])),
    ...(typeof item.covered_by === "string" ? { coveredBy: item.covered_by } : {}),
  };
}

async function readState(ctx: Context, orgId: string): Promise<SealedState | undefined> {
  const item = await getItem(ctx, ctx.deps.sealsTable, `SEALED#${orgId}`, "STATE");
  if (item === undefined) return undefined;
  return {
    sealedSeq: integer(item.sealedSeq, "sealedSeq"),
    lastFromSeq: integer(item.lastFromSeq, "lastFromSeq"),
    lastSealHash: text(item.lastSealHash, "lastSealHash"),
    lastSealVersionId: text(item.lastSealVersionId, "lastSealVersionId"),
    lastEpochId: text(item.lastEpochId, "lastEpochId"),
    sealedAt: text(item.sealedAt, "sealedAt"),
  };
}

async function readHeadSeq(ctx: Context, orgId: string): Promise<number> {
  const item = await getItem(ctx, ctx.deps.ledgerTable, `AUDIT#${orgId}`, "HEAD");
  return item === undefined ? 0 : integer(item.seq, "head seq");
}

/** The records `from` to `to` of an org, in order, as the chain defines them (the stored extras are dropped). */
async function readRecords(ctx: Context, orgId: string, from: number, to: number): Promise<AuditRecordV1[]> {
  const items = await queryAll(ctx, {
    TableName: ctx.deps.ledgerTable,
    KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
    ExpressionAttributeValues: { ":pk": `AUDIT#${orgId}`, ":from": `SEQ#${pad12(from)}`, ":to": `SEQ#${pad12(to)}` },
  });
  return items.map((item) => Object.fromEntries(Object.entries(item).filter(([name]) => name !== "pk" && name !== "sk" && name !== "sealedDetails")) as unknown as AuditRecordV1);
}

async function dirtyOrgs(ctx: Context): Promise<string[]> {
  const items = await queryAll(ctx, { TableName: ctx.deps.ledgerTable, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": "AUDIT_DIRTY" } });
  return items.map((item) => text(item.sk, "dirty marker key"));
}

// ---- S3 ---------------------------------------------------------------------------------------------------------

interface ObjectToWrite { key: string; text: string | Uint8Array; contentType: string }

/**
 * What the key holds before we write it. R1-2: an empty key is `ListObjectVersions` showing no version and no delete
 * marker. One version whose bytes are ours is a resume after a crash: written already. A delete marker (a simple write
 * would then succeed, because `If-None-Match` passes on a marker), a second version, or other bytes is tampering.
 */
/** Every version and delete marker of exactly `key` (not of keys that merely start with it). */
async function listKeyVersions(ctx: Context, key: string): Promise<{ versions: string[]; markers: number }> {
  const versions: string[] = [];
  let markers = 0;
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  do {
    const out = await ctx.deps.s3.send(new ListObjectVersionsCommand({
      Bucket: ctx.deps.bucket,
      Prefix: key,
      ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker }),
      ...(versionIdMarker === undefined ? {} : { VersionIdMarker: versionIdMarker }),
    }));
    for (const version of out.Versions ?? []) if (version.Key === key && typeof version.VersionId === "string") versions.push(version.VersionId);
    markers += (out.DeleteMarkers ?? []).filter((marker) => marker.Key === key).length;
    keyMarker = out.IsTruncated === true ? out.NextKeyMarker : undefined;
    versionIdMarker = out.IsTruncated === true ? out.NextVersionIdMarker : undefined;
  } while (keyMarker !== undefined);
  return { versions, markers };
}

async function inspectKey(ctx: Context, item: ObjectToWrite): Promise<{ versionId: string } | undefined> {
  const { versions, markers } = await listKeyVersions(ctx, item.key);
  if (markers > 0 || versions.length > 1) throw new VersionDriftError(item.key);
  if (versions.length === 0) return undefined;
  const versionId = versions[0]!;
  const stored = await ctx.deps.s3.send(new GetObjectCommand({ Bucket: ctx.deps.bucket, Key: item.key, VersionId: versionId }));
  if (sha256Hex(await stored.Body!.transformToString()) !== sha256Hex(item.text)) throw new VersionDriftError(item.key);
  return { versionId };
}

function versionIdOf(versionId: string | undefined): string {
  if (typeof versionId !== "string") throw new Error("audit anchor: the ledger bucket is not versioned");
  return versionId;
}

/**
 * A create-only write. A 412 is accepted only when the bytes already there are the bytes we meant to write, or, when `accepts`
 * is given, when it says the stored bytes are as good (a timestamp token another run stored: the authority signs different bytes
 * each time, so an identical repeat cannot be expected).
 */
async function createObject(ctx: Context, item: ObjectToWrite, accepts?: (stored: Uint8Array) => boolean): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const out = await ctx.deps.s3.send(new PutObjectCommand(lockedPutInput(ctx.deps.bucket, item.key, item.text, item.contentType)));
      return versionIdOf(out.VersionId);
    } catch (error) {
      const status = httpStatus(error);
      // 409: another write to the key is in flight. Wait a moment (25 ms, doubling) and try again.
      if (status === 409 && attempt < CONFLICT_RETRIES) {
        await (ctx.deps.sleep ?? timerSleep)(CONFLICT_BACKOFF_MS * 2 ** attempt);
        continue;
      }
      if (status !== 412 && errorName(error) !== "PreconditionFailed") throw error;
      let stored;
      try {
        stored = await ctx.deps.s3.send(new GetObjectCommand({ Bucket: ctx.deps.bucket, Key: item.key }));
      } catch (readError) {
        // A 412 with nothing readable at the key: not something to build on.
        if (isNotFound(readError)) throw new VersionDriftError(item.key);
        throw readError;
      }
      const storedBytes = await stored.Body!.transformToByteArray();
      if (accepts === undefined ? sha256Hex(storedBytes) !== sha256Hex(item.text) : !accepts(storedBytes)) throw new ObjectConflictError(item.key);
      return versionIdOf(stored.VersionId);
    }
  }
}

async function lockedObject(ctx: Context, key: string, versionId: string): Promise<LockedObjectV1> {
  const head = await ctx.deps.s3.send(new HeadObjectCommand({ Bucket: ctx.deps.bucket, Key: key, VersionId: versionId }));
  const mode = head.ObjectLockMode;
  const until = head.ObjectLockRetainUntilDate;
  if ((mode !== "COMPLIANCE" && mode !== "GOVERNANCE") || until === undefined || head.LastModified === undefined) throw new LockMissingError(key);
  return { key, versionId, lastModified: head.LastModified.toISOString(), lockMode: mode, retainUntil: new Date(until).toISOString() };
}

/**
 * Writes the objects (in the order given), after checking every key first, last key first, so a key in doubt is found
 * before anything is written for the org.
 */
async function writeObjects(ctx: Context, items: ObjectToWrite[]): Promise<LockedObjectV1[]> {
  const existing = new Map<string, { versionId: string } | undefined>();
  for (const item of [...items].reverse()) existing.set(item.key, await inspectKey(ctx, item));
  const written: LockedObjectV1[] = [];
  for (const item of items) {
    const versionId = existing.get(item.key)?.versionId ?? await createObject(ctx, item);
    written.push(await lockedObject(ctx, item.key, versionId));
  }
  return written;
}

// ---- sealing one org --------------------------------------------------------------------------------------------

async function readLockedSeal(ctx: Context, orgId: string, state: SealedState): Promise<OrgSealV1> {
  let body: string;
  try {
    const out = await ctx.deps.s3.send(new GetObjectCommand({ Bucket: ctx.deps.bucket, Key: sealObjectKey(orgId, state.lastFromSeq), VersionId: state.lastSealVersionId }));
    body = await out.Body!.transformToString();
  } catch (error) {
    if (isNotFound(error)) throw new ChainMismatchError("locked_seal_missing");
    throw error;
  }
  let seal: OrgSealV1;
  try {
    seal = JSON.parse(body) as OrgSealV1;
  } catch {
    throw new ChainMismatchError("locked_seal_unreadable");
  }
  if (typeof seal !== "object" || seal === null || seal.orgId !== orgId || seal.fromSeq !== state.lastFromSeq) throw new ChainMismatchError("locked_seal_unreadable");
  return seal;
}

/**
 * Seals the range frozen in the intent. C3b: the continuity check is against the LOCKED seal the state names, not against
 * the state. The seal must hash to the state's hash, must end where the state says the org is sealed to, and the record at
 * that seq must still be the record the seal committed to. Only then is the new range checked from that record.
 */
async function sealOne(ctx: Context, meta: EpochMeta, intent: Intent): Promise<void> {
  const { orgId, fromSeq, toSeq } = intent;
  const state = await readState(ctx, orgId);
  const sealedSeq = state?.sealedSeq ?? 0;
  if (fromSeq !== sealedSeq + 1) throw new ChainMismatchError("state_moved", { expectedFromSeq: sealedSeq + 1, fromSeq });
  let previous: { seq: number; hash: string };
  let prevSealHash: string;
  if (state === undefined) {
    previous = { seq: 0, hash: genesisHash(orgId) };
    prevSealHash = genesisHash(orgId);
  } else {
    const locked = await readLockedSeal(ctx, orgId, state);
    if (sealHash(locked) !== state.lastSealHash) throw new ChainMismatchError("locked_seal_hash");
    if (locked.toSeq !== state.sealedSeq) throw new ChainMismatchError("locked_seal_end", { lockedToSeq: locked.toSeq, sealedSeq: state.sealedSeq });
    const [recordAtSealed] = await readRecords(ctx, orgId, sealedSeq, sealedSeq);
    if (recordAtSealed === undefined || recordAtSealed.hash !== locked.headHash || recordHash(recordAtSealed) !== locked.headHash) {
      throw new ChainMismatchError("locked_head_hash", { seq: sealedSeq });
    }
    previous = { seq: sealedSeq, hash: recordAtSealed.hash };
    prevSealHash = state.lastSealHash;
  }

  const records = await readRecords(ctx, orgId, fromSeq, toSeq);
  if (records.length !== toSeq - fromSeq + 1) throw new ChainMismatchError("missing_records", { found: records.length, expected: toSeq - fromSeq + 1 });
  const chain = checkChain(records, { seq: previous.seq, hash: previous.hash, orgId });
  if (!chain.ok) throw new ChainMismatchError(chain.problem, { seq: chain.seq });

  const seal: OrgSealV1 = {
    v: 1,
    orgId,
    fromSeq,
    toSeq,
    batchRoot: merkleRoot(recordLeafData(records)),
    headHash: records[records.length - 1]!.hash,
    prevSealHash,
    epochId: meta.epochId,
  };
  const recordsText = `${records.map((record) => auditCanonicalJson(record)).join("\n")}\n`;
  const [recordsObject, sealObject] = await writeObjects(ctx, [
    { key: recordsObjectKey(orgId, fromSeq), text: recordsText, contentType: "application/x-ndjson" },
    { key: sealObjectKey(orgId, fromSeq), text: auditCanonicalJson(seal), contentType: "application/json" },
  ]);
  await ctx.deps.documentClient.send(new UpdateCommand({
    TableName: ctx.deps.sealsTable,
    Key: { pk: `EPOCH#${meta.epochId}`, sk: `ORG#${orgId}` },
    UpdateExpression: "SET #seal = :seal, #objects = :objects, #lastRecordedAt = :lastRecordedAt",
    ExpressionAttributeNames: { "#seal": "seal", "#objects": "objects", "#lastRecordedAt": "lastRecordedAt" },
    ExpressionAttributeValues: { ":seal": seal, ":objects": { records: recordsObject, seal: sealObject }, ":lastRecordedAt": records[records.length - 1]!.recordedAt },
  }));
}

async function skipIntent(ctx: Context, meta: EpochMeta, intent: Intent, reason: string): Promise<void> {
  await ctx.deps.documentClient.send(new UpdateCommand({
    TableName: ctx.deps.sealsTable,
    Key: { pk: `EPOCH#${meta.epochId}`, sk: `ORG#${intent.orgId}` },
    UpdateExpression: "SET #skipped = :reason",
    ExpressionAttributeNames: { "#skipped": "skipped" },
    ExpressionAttributeValues: { ":reason": reason },
  }));
}

async function sealOrg(ctx: Context, meta: EpochMeta, intent: Intent): Promise<void> {
  try {
    await sealOne(ctx, meta, intent);
  } catch (error) {
    const { log } = ctx.deps;
    if (error instanceof ChainMismatchError) {
      log({ event: "audit.chain_mismatch", level: "error", orgId: intent.orgId, epochId: meta.epochId, reason: error.reason, ...error.details });
      await skipIntent(ctx, meta, intent, "chain_mismatch");
      return;
    }
    if (error instanceof VersionDriftError) {
      log({ event: "audit.version_drift", level: "error", orgId: intent.orgId, epochId: meta.epochId, key: error.key });
      await skipIntent(ctx, meta, intent, "version_drift");
      return;
    }
    if (error instanceof ObjectConflictError) {
      throw new StopRun("object_conflict", { event: "audit.object_conflict", level: "error", orgId: intent.orgId, epochId: meta.epochId, key: error.key });
    }
    if (error instanceof LockMissingError) {
      throw new StopRun("lock_config_mismatch", { event: "audit.lock_config_mismatch", level: "error", orgId: intent.orgId, epochId: meta.epochId, key: error.key });
    }
    throw error;
  }
}

// ---- the epoch --------------------------------------------------------------------------------------------------

/** What an org still has to seal: its range, or nothing. A marker that names only sealed records is stale and is cleared. */
async function planOrg(ctx: Context, orgId: string): Promise<{ fromSeq: number; toSeq: number } | undefined> {
  const [state, headSeq] = await Promise.all([readState(ctx, orgId), readHeadSeq(ctx, orgId)]);
  const sealedSeq = state?.sealedSeq ?? 0;
  if (headSeq <= sealedSeq) {
    try {
      await ctx.deps.documentClient.send(new DeleteCommand({
        TableName: ctx.deps.ledgerTable,
        Key: { pk: "AUDIT_DIRTY", sk: orgId },
        ConditionExpression: "#lastSeq <= :sealedSeq",
        ExpressionAttributeNames: { "#lastSeq": "lastSeq" },
        ExpressionAttributeValues: { ":sealedSeq": sealedSeq },
      }));
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
    }
    return undefined;
  }
  const fromSeq = sealedSeq + 1;
  return { fromSeq, toSeq: Math.min(headSeq, fromSeq + AUDIT_MAX_RECORDS_PER_ORG_EPOCH - 1) };
}

async function hasWork(ctx: Context): Promise<boolean> {
  for (const orgId of await dirtyOrgs(ctx)) {
    if (await planOrg(ctx, orgId) !== undefined) return true;
  }
  return false;
}

async function freeze(ctx: Context, meta: EpochMeta): Promise<void> {
  const existing = new Set((await readIntents(ctx, meta.epochId)).map((intent) => intent.orgId));
  const orgs = (await dirtyOrgs(ctx)).filter((orgId) => !existing.has(orgId));
  await eachPage(orgs, async (orgId) => {
    const plan = await planOrg(ctx, orgId);
    if (plan === undefined) return;
    try {
      await ctx.deps.documentClient.send(new PutCommand({
        TableName: ctx.deps.sealsTable,
        Item: { pk: `EPOCH#${meta.epochId}`, sk: `ORG#${orgId}`, fromSeq: plan.fromSeq, toSeq: plan.toSeq, finalized: false },
        ConditionExpression: "attribute_not_exists(pk)",
      }));
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
    }
  });
  try {
    await ctx.deps.documentClient.send(new UpdateCommand({
      TableName: ctx.deps.sealsTable,
      Key: { pk: `EPOCH#${meta.epochId}`, sk: "META" },
      UpdateExpression: "SET #status = :frozen",
      ConditionExpression: "#status = :freezing",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":frozen": "frozen", ":freezing": "freezing" },
    }));
  } catch (error) {
    if (!isConditionalFailure(error)) throw error;
  }
}

/**
 * Step 6. The leaves are the sealed intents' seals in org id order; `sealCount` is their number (R1-3). The statement is
 * chosen once: stored with `attribute_not_exists`. When it is stored already, the frozen seals must give exactly it.
 */
async function settleStatement(ctx: Context, meta: EpochMeta): Promise<{ statement: EpochStatementV1; leaves: OrgSealV1[] }> {
  const intents = await readIntents(ctx, meta.epochId);
  if (intents.some((intent) => intent.seal === undefined && intent.skipped === undefined)) throw new Error("audit anchor: an intent is neither sealed nor skipped");
  const sealed = intents.filter((intent) => intent.seal !== undefined && intent.skipped === undefined);
  const leaves = sealed.map((intent) => intent.seal!);
  const statement: EpochStatementV1 = {
    v: 1,
    epochId: meta.epochId,
    closedAt: meta.closedAt,
    prevEpochId: meta.prevEpochId,
    prevStatementHash: meta.prevStatementHash,
    sealsRoot: merkleRoot(leaves.map((seal) => sealLeafData(seal))),
    sealCount: leaves.length,
  };
  const matches = (stored: EpochStatementV1): boolean => auditCanonicalJson(stored) === auditCanonicalJson(statement);
  const changed = (): StopRun => new StopRun("statement_changed", { event: "audit.chain_mismatch", level: "error", epochId: meta.epochId, reason: "statement_changed" });
  if (meta.statement !== undefined) {
    if (!matches(meta.statement)) throw changed();
  } else {
    try {
      await ctx.deps.documentClient.send(new UpdateCommand({
        TableName: ctx.deps.sealsTable,
        Key: { pk: `EPOCH#${meta.epochId}`, sk: "META" },
        UpdateExpression: "SET #statement = :statement, #statementHash = :hash",
        ConditionExpression: "attribute_not_exists(#statement) AND #status = :frozen",
        ExpressionAttributeNames: { "#statement": "statement", "#statementHash": "statementHash", "#status": "status" },
        ExpressionAttributeValues: { ":statement": statement, ":hash": statementHash(statement), ":frozen": "frozen" },
      }));
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      // Another run chose a statement first: it must be the one these seals give.
      const stored = (await readMeta(ctx, meta.epochId)).statement;
      if (stored === undefined || !matches(stored)) throw changed();
    }
  }
  await eachPage(sealed.map((intent, index) => ({ intent, index })), async ({ intent, index }) => {
    if (intent.index?.index === index && intent.index.size === leaves.length) return;
    await ctx.deps.documentClient.send(new UpdateCommand({
      TableName: ctx.deps.sealsTable,
      Key: { pk: `EPOCH#${meta.epochId}`, sk: `ORG#${intent.orgId}` },
      UpdateExpression: "SET #index = :index",
      ExpressionAttributeNames: { "#index": "index" },
      ExpressionAttributeValues: { ":index": { index, size: leaves.length } },
    }));
  });
  return { statement, leaves };
}

async function writeEpochObjects(ctx: Context, meta: EpochMeta, statement: EpochStatementV1, leaves: OrgSealV1[]): Promise<void> {
  let objects: LockedObjectV1[];
  try {
    objects = await writeObjects(ctx, [
      { key: statementObjectKey(meta.epochId), text: auditCanonicalJson(statement), contentType: "application/json" },
      { key: leavesObjectKey(meta.epochId), text: auditCanonicalJson({ v: 1, epochId: meta.epochId, seals: leaves }), contentType: "application/json" },
    ]);
  } catch (error) {
    if (error instanceof VersionDriftError) throw new StopRun("version_drift", { event: "audit.version_drift", level: "error", epochId: meta.epochId, key: error.key });
    if (error instanceof ObjectConflictError) throw new StopRun("object_conflict", { event: "audit.object_conflict", level: "error", epochId: meta.epochId, key: error.key });
    if (error instanceof LockMissingError) throw new StopRun("lock_config_mismatch", { event: "audit.lock_config_mismatch", level: "error", epochId: meta.epochId, key: error.key });
    throw error;
  }
  await ctx.deps.documentClient.send(new UpdateCommand({
    TableName: ctx.deps.sealsTable,
    Key: { pk: `EPOCH#${meta.epochId}`, sk: "META" },
    UpdateExpression: "SET #objects = :objects",
    ExpressionAttributeNames: { "#objects": "objects" },
    ExpressionAttributeValues: { ":objects": { statement: objects[0]!, leaves: objects[1]! } },
  }));
}

/**
 * Step 7, Task 9. HeadObject every object of the epoch that is not finalized yet, by its version id (lock-check.ts). An epoch
 * object (the statement, the leaves) with a lock below the floor stops the run before any org is finalized: the epoch stays open
 * and nothing is finalized. An org whose records or seal object is below the floor is not finalized: it is marked blocked (its
 * seal is in the statement already, so the epoch cannot drop it) and the other orgs go on. Each failure is logged by the check
 * as `audit.lock_config_mismatch` with the object.
 */
async function enforceEpochLocks(ctx: Context, meta: EpochMeta): Promise<void> {
  const { floor, ratchetSince } = await currentLockState(ctx.deps);
  const epochObjects = meta.objects === undefined ? [] : [meta.objects.statement, meta.objects.leaves];
  const epoch = await enforceObjectLock(ctx.deps, epochObjects, ctx.now, { floor, ratchetSince, context: { epochId: meta.epochId } });
  if (!epoch.ok) throw new StopRun("lock_config_mismatch", undefined);
  const pending = (await readIntents(ctx, meta.epochId)).filter((intent) => intent.seal !== undefined && intent.objects !== undefined && !intent.finalized && intent.skipped === undefined && intent.blocked === undefined);
  await eachPage(pending, async (intent) => {
    const checked = await enforceObjectLock(ctx.deps, [intent.objects!.records, intent.objects!.seal], ctx.now, { floor, ratchetSince, context: { orgId: intent.orgId, epochId: meta.epochId } });
    if (!checked.ok) await blockIntent(ctx, meta, intent, "lock_config_mismatch");
  });
}

/** Marks an intent whose finalize the table refused (its sealed state was changed): the seal stays in the statement, the org waits for a person. */
async function blockIntent(ctx: Context, meta: EpochMeta, intent: Intent, reason: string): Promise<void> {
  await ctx.deps.documentClient.send(new UpdateCommand({
    TableName: ctx.deps.sealsTable,
    Key: { pk: `EPOCH#${meta.epochId}`, sk: `ORG#${intent.orgId}` },
    UpdateExpression: "SET #blocked = :reason",
    ExpressionAttributeNames: { "#blocked": "blocked" },
    ExpressionAttributeValues: { ":reason": reason },
  }));
}

/**
 * Step 8 for one org (C1): one small transaction moves the org's sealed state, adds its index item, marks its intent and
 * deletes its dirty marker, but only when the marker names nothing newer than this seal (C2). A failure of that one
 * condition is retried without the marker's delete, which leaves the marker for the next epoch.
 */
async function finalizeOne(ctx: Context, meta: EpochMeta, intent: Intent): Promise<"finalized" | "blocked" | "already"> {
  const { orgId, fromSeq, toSeq } = intent;
  const seal = intent.seal!;
  const objects = intent.objects!;
  const { sealsTable, ledgerTable } = ctx.deps;
  const sleep = ctx.deps.sleep ?? timerSleep;
  let withMarker = true;
  for (let attempt = 0; ; attempt += 1) {
    const items: TransactWriteCommandInput["TransactItems"] = [
      {
        Put: {
          TableName: sealsTable,
          Item: {
            pk: `SEALED#${orgId}`, sk: "STATE", sealedSeq: toSeq, lastFromSeq: fromSeq, lastSealHash: sealHash(seal),
            lastSealVersionId: objects.seal.versionId, lastEpochId: meta.epochId, sealedAt: ctx.nowIso,
          },
          ...(fromSeq === 1
            ? { ConditionExpression: "attribute_not_exists(pk)" }
            : { ConditionExpression: "#sealedSeq = :previous", ExpressionAttributeNames: { "#sealedSeq": "sealedSeq" }, ExpressionAttributeValues: { ":previous": fromSeq - 1 } }),
        },
      },
      {
        Put: {
          TableName: sealsTable,
          Item: { pk: `SEALS#${orgId}`, sk: pad12(fromSeq), epochId: meta.epochId, toSeq, objects },
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
      {
        Update: {
          TableName: sealsTable,
          Key: { pk: `EPOCH#${meta.epochId}`, sk: `ORG#${orgId}` },
          UpdateExpression: "SET #finalized = :true",
          ConditionExpression: "#finalized = :false",
          ExpressionAttributeNames: { "#finalized": "finalized" },
          ExpressionAttributeValues: { ":true": true, ":false": false },
        },
      },
      ...(withMarker
        ? [{
          Delete: {
            TableName: ledgerTable,
            Key: { pk: "AUDIT_DIRTY", sk: orgId },
            ConditionExpression: "attribute_not_exists(pk) OR #lastSeq <= :toSeq",
            ExpressionAttributeNames: { "#lastSeq": "lastSeq" },
            ExpressionAttributeValues: { ":toSeq": toSeq },
          },
        }]
        : []),
    ];
    try {
      await transact(ctx, items);
      return "finalized";
    } catch (error) {
      if (isTransactionConflict(error)) {
        if (attempt >= CONFLICT_RETRIES) throw error;
        await sleep(CONFLICT_BACKOFF_MS * 2 ** attempt);
        continue;
      }
      const codes = cancellationCodes(error);
      if (codes === undefined) throw error;
      const failed = codes.flatMap((code, index) => (code === "ConditionalCheckFailed" ? [index] : []));
      // C2: only the marker's condition failed. Seal without deleting it.
      if (withMarker && failed.length === 1 && failed[0] === MARKER_INDEX) {
        withMarker = false;
        continue;
      }
      // Already finalized by another run.
      if (failed.includes(INTENT_INDEX)) {
        const current = await getItem(ctx, sealsTable, `EPOCH#${meta.epochId}`, `ORG#${orgId}`);
        if (current?.finalized === true) return "already";
      }
      // The sealed state is not where the intent started: someone changed it. The seal stays in the statement; the org waits.
      ctx.deps.log({ event: "audit.chain_mismatch", level: "error", orgId, epochId: meta.epochId, reason: "finalize_refused", failedItems: failed });
      await blockIntent(ctx, meta, intent, "chain_mismatch");
      return "blocked";
    }
  }
}

async function finalizeOrgs(ctx: Context, meta: EpochMeta): Promise<void> {
  const pending = (await readIntents(ctx, meta.epochId)).filter((intent) => intent.seal !== undefined && !intent.finalized && intent.skipped === undefined && intent.blocked === undefined);
  await eachPage(pending, async (intent) => { await finalizeOne(ctx, meta, intent); });
}

/** Step 9, last: META `sealed` (or `stamp_pending`, when a timestamp is still missing) and HEAD move together. */
async function completeEpoch(ctx: Context, meta: EpochMeta, statement: EpochStatementV1, status: "sealed" | "stamp_pending"): Promise<void> {
  const { sealsTable } = ctx.deps;
  await transact(ctx, [
    {
      Update: {
        TableName: sealsTable,
        Key: { pk: `EPOCH#${meta.epochId}`, sk: "META" },
        UpdateExpression: "SET #status = :next",
        ConditionExpression: "#status = :frozen AND attribute_exists(#statement)",
        ExpressionAttributeNames: { "#status": "status", "#statement": "statement" },
        ExpressionAttributeValues: { ":next": status, ":frozen": "frozen" },
      },
    },
    {
      Update: {
        TableName: sealsTable,
        Key: { pk: "EPOCH_HEAD", sk: "HEAD" },
        UpdateExpression: "SET #epochId = :id, #statementHash = :hash, #closedAt = :closedAt REMOVE #open",
        ConditionExpression: meta.prevEpochId === null
          ? "#open = :id AND attribute_not_exists(#epochId)"
          : "#open = :id AND #epochId = :previous",
        ExpressionAttributeNames: { "#epochId": "epochId", "#statementHash": "statementHash", "#closedAt": "closedAt", "#open": "openEpochId" },
        ExpressionAttributeValues: {
          ":id": meta.epochId, ":hash": statementHash(statement), ":closedAt": meta.closedAt,
          ...(meta.prevEpochId === null ? {} : { ":previous": meta.prevEpochId }),
        },
      },
    },
  ]);
}

// ---- timestamps (Task 10) ---------------------------------------------------------------------------------------

interface StampTarget {
  meta: EpochMeta;
  statement: EpochStatementV1;
}

type ActiveTsa = { tsa: TsaDeps; settings: Exclude<TsaSettings, { kind: "off" }> };

/** The timestamp settings, or undefined when there are none or they say `off`: then an epoch is sealed without tokens. */
function activeTsa(ctx: Context): ActiveTsa | undefined {
  const tsa = ctx.deps.tsa;
  if (tsa === undefined || tsa.settings.kind === "off") return undefined;
  return { tsa, settings: tsa.settings };
}

const hasAllStamps = (active: ActiveTsa, stamps: Record<string, Stamp>): boolean => active.settings.targets.every((target) => stamps[target.label] !== undefined);

/** Waits until this authority was last asked at least `spacingMs` ago (measured from the start of that request). */
async function keepSpacing(ctx: Context, active: ActiveTsa, label: string): Promise<void> {
  const clock = active.tsa.clock ?? Date.now;
  const last = ctx.lastStampRequestAt.get(label);
  if (last !== undefined) {
    const wait = active.settings.spacingMs - (clock() - last);
    if (wait > 0) await (active.tsa.sleep ?? timerSleep)(wait);
  }
  ctx.lastStampRequestAt.set(label, clock());
}

/**
 * The latest `recordedAt` among the last records of the epoch's org seals: what a token's time is held against (the bundle check
 * compares each seal's own last record, so the latest of them is the binding one). Undefined for an epoch with no seal. The
 * intents carry it since the seal was written; a seal written without it has its last record read.
 */
async function lastRecordedAtOf(ctx: Context, epochId: string): Promise<string | undefined> {
  if (ctx.lastRecordedAt.has(epochId)) return ctx.lastRecordedAt.get(epochId);
  const times: string[] = [];
  const sealed = (await readIntents(ctx, epochId)).filter((intent) => intent.seal !== undefined && intent.skipped === undefined);
  await eachPage(sealed, async (intent) => {
    if (intent.lastRecordedAt !== undefined) {
      times.push(intent.lastRecordedAt);
      return;
    }
    const [record] = await readRecords(ctx, intent.orgId, intent.seal!.toSeq, intent.seal!.toSeq);
    if (record === undefined) throw new ChainMismatchError("missing_records", { seq: intent.seal!.toSeq });
    times.push(record.recordedAt);
  });
  let latest: string | undefined;
  for (const time of times) if (latest === undefined || Date.parse(time) > Date.parse(latest)) latest = time;
  ctx.lastRecordedAt.set(epochId, latest);
  return latest;
}

/**
 * One token for one epoch from one authority, stored create-only as `<epochId>.<label>.tsr` and recorded on the epoch's META.
 * What the key holds comes first: a token an earlier run stored (it crashed before recording it) is read back, checked with the
 * offline verifier and adopted, with no new request; a delete marker or a second version is version drift; a stored object that
 * does not verify is never adopted. Only a token that verifies under this label's roots is ever written.
 */
async function stampOne(ctx: Context, active: ActiveTsa, target: TsaTarget, epoch: StampTarget): Promise<Stamp> {
  const { epochId } = epoch.meta;
  const { label } = target;
  if (target.unavailable !== undefined) throw new TsaError(label, target.unavailable);
  const clock = active.tsa.clock ?? Date.now;
  const lastRecordedAt = await lastRecordedAtOf(ctx, epochId);
  const key = tokenObjectKey(epochId, label);
  const hashHex = statementHash(epoch.statement);
  const verify = (bytes: Uint8Array) => verifyTimeStampToken(bytes, { hashHex, anchors: target.anchors });
  const { versions, markers } = await listKeyVersions(ctx, key);
  if (markers > 0 || versions.length > 1) {
    ctx.deps.log({ event: "audit.version_drift", level: "error", epochId, key });
    throw new TsaError(label, "version_drift");
  }
  let versionId = versions[0];
  let genTime: string;
  if (versionId !== undefined) {
    const stored = await ctx.deps.s3.send(new GetObjectCommand({ Bucket: ctx.deps.bucket, Key: key, VersionId: versionId }));
    const verdict = verify(await stored.Body!.transformToByteArray());
    if (!verdict.ok) throw new TsaError(label, "stored_token_invalid");
    // A token an earlier build kept with an unbelievable time is never adopted; the epoch waits for a successor to cover it.
    checkGenTime(label, verdict.genTime, { lastRecordedAt, nowMs: clock(), notBeforeMs: Date.parse(epoch.meta.closedAt) });
    genTime = verdict.genTime;
  } else {
    await keepSpacing(ctx, active, label);
    ctx.stampRequests.set(label, (ctx.stampRequests.get(label) ?? 0) + 1);
    const stamped = await requestTimestamp(active.tsa.fetch, label, target.url, hashHex, {
      timeoutMs: active.settings.timeoutMs,
      nonce: (active.tsa.nonce ?? randomNonce)(),
      anchors: target.anchors,
      clock,
      ...(lastRecordedAt === undefined ? {} : { lastRecordedAt }),
    });
    genTime = stamped.genTime;
    let tooEarly = false;
    try {
      // A 412 means another run stored a token first: its bytes differ from ours, and are accepted when they verify too.
      versionId = await createObject(ctx, { key, text: stamped.token, contentType: "application/octet-stream" }, (bytes) => {
        const verdict = verify(bytes);
        if (!verdict.ok) return false;
        try {
          checkGenTime(label, verdict.genTime, { lastRecordedAt, nowMs: clock(), notBeforeMs: Date.parse(epoch.meta.closedAt) });
        } catch {
          tooEarly = true;
          return false;
        }
        genTime = verdict.genTime;
        return true;
      });
    } catch (error) {
      if (error instanceof ObjectConflictError) throw new TsaError(label, tooEarly ? "gen_time" : "stored_token_invalid");
      if (error instanceof VersionDriftError) throw new TsaError(label, "version_drift");
      throw error;
    }
  }
  const object = await lockedObject(ctx, key, versionId);
  const stamp: Stamp = { object, genTime };
  try {
    await ctx.deps.documentClient.send(new UpdateCommand({
      TableName: ctx.deps.sealsTable,
      Key: { pk: `EPOCH#${epochId}`, sk: "META" },
      UpdateExpression: "SET #stamp = :stamp",
      ConditionExpression: "attribute_not_exists(#stamp)",
      ExpressionAttributeNames: { "#stamp": `${STAMP_PREFIX}${label}` },
      ExpressionAttributeValues: { ":stamp": stamp },
    }));
  } catch (error) {
    // Another run recorded this key's one version already.
    if (!isConditionalFailure(error)) throw error;
  }
  ctx.deps.log({ event: "audit.timestamp_stored", epochId, label, genTime });
  return stamp;
}

/**
 * Step 7 (Task 10, I11): asks each authority for the epochs that lack its token. The epochs are the one being closed and at most
 * the newest one still waiting. An authority's requests are sequential and spaced; the authorities run in parallel; a run makes
 * at most MAX_STAMP_REQUESTS_PER_LABEL requests to each. A failure is logged, never thrown: sealing goes on and the epoch waits.
 */
async function stampEpochs(ctx: Context, epochs: StampTarget[]): Promise<void> {
  const active = activeTsa(ctx);
  if (active === undefined) return;
  const results = await Promise.allSettled(active.settings.targets.map(async (target) => {
    for (const epoch of epochs) {
      if (epoch.meta.stamps[target.label] !== undefined) continue;
      if ((ctx.stampRequests.get(target.label) ?? 0) >= MAX_STAMP_REQUESTS_PER_LABEL) return;
      try {
        epoch.meta.stamps[target.label] = await stampOne(ctx, active, target, epoch);
      } catch (error) {
        if (error instanceof TsaError) {
          ctx.deps.log({ event: "audit.timestamp_failed", level: "warn", label: error.label, problem: error.problem, epochId: epoch.meta.epochId });
        } else if (error instanceof LockMissingError) {
          throw new StopRun("lock_config_mismatch", { event: "audit.lock_config_mismatch", level: "error", epochId: epoch.meta.epochId, key: error.key });
        } else {
          throw error;
        }
      }
    }
  }));
  const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason as unknown);
  if (failed.length > 0) throw failed.find((reason) => reason instanceof StopRun) ?? failed[0];
}

/** Every token written for these epochs carries the floor's lock, like every other object of the epoch. */
async function enforceStampLocks(ctx: Context, epochs: StampTarget[]): Promise<void> {
  if (!epochs.some((epoch) => Object.keys(epoch.meta.stamps).length > 0)) return;
  const { floor, ratchetSince } = await currentLockState(ctx.deps);
  for (const epoch of epochs) {
    const objects = Object.values(epoch.meta.stamps).map((stamp) => stamp.object);
    if (objects.length === 0) continue;
    const checked = await enforceObjectLock(ctx.deps, objects, ctx.now, { floor, ratchetSince, context: { epochId: epoch.meta.epochId } });
    if (!checked.ok) throw new StopRun("lock_config_mismatch", undefined);
  }
}

/** The completed epoch that is still waiting for a token, if the newest completed epoch is one (pending epochs are always a run ending at the head). */
async function newestPending(ctx: Context): Promise<StampTarget | undefined> {
  const head = await getItem(ctx, ctx.deps.sealsTable, "EPOCH_HEAD", "HEAD");
  if (typeof head?.epochId !== "string") return undefined;
  const meta = await readMeta(ctx, head.epochId);
  return meta.status === "stamp_pending" && meta.statement !== undefined ? { meta, statement: meta.statement } : undefined;
}

/**
 * Every epoch before `epoch` that is still waiting is covered by it (`covered_by`) and sealed: its statement chains to this
 * one's, which has tokens, so the verifier takes the later tokens for the older epochs too. The walk goes back by `prevEpochId`
 * and stops at the first epoch that is neither waiting nor covered by some epoch. The writes go oldest first
 * but a page of them runs at once, so a crash can leave a later epoch of the page covered and an earlier one still waiting: the
 * walk passes through the epochs already covered (by this epoch or any other), and so finishes the work on a repeat.
 *
 * The covering is all or nothing, and only when the verifier would accept it (review N1): each waiting epoch's last record is held
 * against the earliest time among this epoch's tokens with the verifier's own rule. If any epoch fails it, nothing is written, the
 * refusal is logged for each such epoch, and `complete` is false: the epoch stays waiting, so the waiting epochs stay one run that
 * ends at the head, and a later epoch with later tokens can still cover them.
 */
async function coverOlder(ctx: Context, epoch: EpochMeta): Promise<{ covered: number; complete: boolean }> {
  const epochId = epoch.epochId;
  const pending: string[] = [];
  for (let id = epoch.prevEpochId; id !== null;) {
    const item = await getItem(ctx, ctx.deps.sealsTable, `EPOCH#${id}`, "META");
    if (item === undefined) break;
    const waiting = item.status === "stamp_pending";
    // The walk passes every epoch some epoch already covers, whichever one: a page of covering writes can fail half way after a newer
    // epoch has completed, and an epoch still waiting behind covered ones (review N4) must still be found.
    if (!waiting && typeof item.covered_by !== "string") break;
    if (waiting) pending.push(id);
    id = typeof item.prevEpochId === "string" ? item.prevEpochId : null;
  }
  if (pending.length > 0) {
    const earliest = Object.values(epoch.stamps).map((stamp) => stamp.genTime).reduce((best, time) => (Date.parse(time) < Date.parse(best) ? time : best));
    const refused: string[] = [];
    await eachPage(pending, async (id) => {
      const last = await lastRecordedAtOf(ctx, id);
      if (last !== undefined && !timestampCoversRecord(earliest, last)) refused.push(id);
    });
    if (refused.length > 0) {
      for (const id of refused.sort()) ctx.deps.log({ event: "audit.timestamp_failed", level: "warn", label: "all", problem: "gen_time", epochId: id, coveredBy: epochId });
      return { covered: 0, complete: false };
    }
  }
  pending.reverse();
  await eachPage(pending, async (id) => {
    try {
      await ctx.deps.documentClient.send(new UpdateCommand({
        TableName: ctx.deps.sealsTable,
        Key: { pk: `EPOCH#${id}`, sk: "META" },
        UpdateExpression: "SET #status = :sealed, #coveredBy = :by",
        ConditionExpression: "#status = :pending",
        ExpressionAttributeNames: { "#status": "status", "#coveredBy": "covered_by" },
        ExpressionAttributeValues: { ":sealed": "sealed", ":pending": "stamp_pending", ":by": epochId },
      }));
    } catch (error) {
      // Covered by an earlier attempt of this same run's work.
      if (!isConditionalFailure(error)) throw error;
    }
  });
  return { covered: pending.length, complete: true };
}

/** An epoch that has every token and was waiting is sealed (after the epochs it covers, so a crash resumes the covering). */
async function sealWaiting(ctx: Context, epochId: string): Promise<void> {
  try {
    await ctx.deps.documentClient.send(new UpdateCommand({
      TableName: ctx.deps.sealsTable,
      Key: { pk: `EPOCH#${epochId}`, sk: "META" },
      UpdateExpression: "SET #status = :sealed",
      ConditionExpression: "#status = :pending",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":sealed": "sealed", ":pending": "stamp_pending" },
    }));
  } catch (error) {
    if (!isConditionalFailure(error)) throw error;
  }
}

/**
 * After the stamping (and, for the epoch being closed, after it is closed): each epoch with a token from every authority covers
 * the waiting epochs before it, oldest epoch first, and is itself sealed if it was waiting.
 */
async function settleStamps(ctx: Context, epochs: StampTarget[]): Promise<void> {
  const active = activeTsa(ctx);
  if (active === undefined) return;
  for (const epoch of epochs) {
    if (!hasAllStamps(active, epoch.meta.stamps)) continue;
    if (ctx.settled.has(epoch.meta.epochId)) continue;
    ctx.settled.add(epoch.meta.epochId);
    const { covered, complete } = await coverOlder(ctx, epoch.meta);
    // An epoch that could not cover the ones before it stays waiting with them (they are always a run that ends at the head).
    if (complete) await sealWaiting(ctx, epoch.meta.epochId);
    if (covered > 0) ctx.deps.log({ event: "audit.timestamps_covered", epochId: epoch.meta.epochId, covered });
  }
}

/** A run with no epoch of its own still tries the newest waiting one, so an epoch is not stuck for want of new activity. */
async function stampWaiting(ctx: Context): Promise<void> {
  if (activeTsa(ctx) === undefined) return;
  const waiting = await newestPending(ctx);
  // A head that holds every token was settled (or refused) at the start of the run by `resumeStamps`.
  if (waiting === undefined || hasAllStamps(activeTsa(ctx) as ActiveTsa, waiting.meta.stamps)) return;
  await stampEpochs(ctx, [waiting]);
  await enforceStampLocks(ctx, [waiting]);
  await settleStamps(ctx, [waiting]);
}

/** A pending epoch older than this, with nothing to cover it, is reported every run (the same alarm as a failed token). */
const PENDING_ALARM_MINUTES = 180;
/** The most epochs the age check walks back through in one run. */
const ALARM_WALK_LIMIT = 1000;

/**
 * The first thing every run does for the timestamps (I2): finish the settling a crashed run left. The newest completed epoch is
 * the head, and the epochs that wait are always a run that ends at the head: an epoch is completed as `sealed` only when none
 * waits before it, and otherwise as `stamp_pending` and sealed last, after it has covered them. So a sealed head means there is
 * nothing to settle and this does nothing (one read). A waiting head that holds a token from every authority has its locks
 * checked (N2, as in any run that stamps) and is then settled with the same idempotent step the end of a run takes. Whatever
 * still waits afterwards is checked for age (`alarmIfWaitingTooLong`), so the alarm fires even when no authority is asked or answers wrongly.
 */
async function resumeStamps(ctx: Context): Promise<void> {
  const active = activeTsa(ctx);
  if (active === undefined) return;
  const head = await getItem(ctx, ctx.deps.sealsTable, "EPOCH_HEAD", "HEAD");
  if (typeof head?.epochId !== "string") return;
  const meta = await readMeta(ctx, head.epochId);
  if (meta.statement === undefined || meta.status !== "stamp_pending") return;
  if (hasAllStamps(active, meta.stamps)) {
    const target: StampTarget = { meta, statement: meta.statement };
    await enforceStampLocks(ctx, [target]);
    await settleStamps(ctx, [target]);
  }
  await alarmIfWaitingTooLong(ctx, head.epochId);
}

/**
 * Logs a timestamp failure (`pending_too_long`) for any epoch that is still waiting after PENDING_ALARM_MINUTES. The walk starts at the
 * head and passes waiting epochs and epochs some epoch covered, so an epoch left waiting behind covered ones is found too; it stops at
 * the first other epoch, or after ALARM_WALK_LIMIT epochs. It does nothing when nothing waits.
 */
async function alarmIfWaitingTooLong(ctx: Context, headId: string): Promise<void> {
  const limit = ctx.now - PENDING_ALARM_MINUTES * 60_000;
  let id: string | null = headId;
  for (let steps = 0; id !== null && steps < ALARM_WALK_LIMIT; steps += 1) {
    const meta: EpochMeta = await readMeta(ctx, id);
    if (meta.status === "stamp_pending") {
      if (Date.parse(meta.closedAt) < limit) {
        ctx.deps.log({ event: "audit.timestamp_failed", level: "error", label: "all", problem: "pending_too_long", epochId: meta.epochId, closedAt: meta.closedAt });
        return;
      }
    } else if (meta.coveredBy === undefined) {
      return;
    }
    id = meta.prevEpochId;
  }
}

async function driveEpoch(ctx: Context, epochId: string, resumed: boolean): Promise<AnchorEpochSummary> {
  let meta = await readMeta(ctx, epochId);
  if (meta.status === "freezing") {
    await freeze(ctx, meta);
    meta = await readMeta(ctx, epochId);
  }
  if (meta.status !== "frozen") throw new Error(`audit anchor: epoch ${epochId} is open with status ${meta.status}`);
  // Step 5 runs once: after the statement is chosen the intents are final.
  if (meta.statement === undefined) {
    const intents = await readIntents(ctx, epochId);
    await eachPage(intents.filter((intent) => intent.seal === undefined && intent.skipped === undefined), (intent) => sealOrg(ctx, meta, intent));
  }
  const { statement, leaves } = await settleStatement(ctx, meta);
  meta = await readMeta(ctx, epochId);
  await writeEpochObjects(ctx, meta, statement, leaves);
  meta = await readMeta(ctx, epochId);
  // Step 7. Task 10: the timestamps, for this epoch and the newest one still waiting; a failure only leaves the epoch waiting.
  // Task 9: every object is read back, by its version id, and must carry the floor's lock (the tokens too).
  const waiting = await newestPending(ctx);
  const targets: StampTarget[] = [...(waiting === undefined ? [] : [waiting]), { meta, statement }];
  await stampEpochs(ctx, targets);
  await enforceStampLocks(ctx, targets);
  await enforceEpochLocks(ctx, meta);
  await finalizeOrgs(ctx, meta);
  const active = activeTsa(ctx);
  const stamped = active === undefined || hasAllStamps(active, meta.stamps);
  // Sealed at once only when nothing waits before it; otherwise it is sealed last, by `settleStamps`, after it has covered them
  // (a sealed head with waiting epochs behind it could never be found again by a later run).
  await completeEpoch(ctx, meta, statement, stamped && (active === undefined || waiting === undefined) ? "sealed" : "stamp_pending");
  await settleStamps(ctx, targets);

  const intents = await readIntents(ctx, epochId);
  const sealed = intents.filter((intent) => intent.seal !== undefined && intent.skipped === undefined);
  return {
    epochId,
    status: (await readMeta(ctx, epochId)).status === "sealed" ? "sealed" : "stamp_pending",
    orgs: sealed.length,
    skipped: intents.filter((intent) => intent.skipped !== undefined).length,
    blocked: intents.filter((intent) => intent.blocked !== undefined).length,
    records: sealed.reduce((total, intent) => total + (intent.toSeq - intent.fromSeq + 1), 0),
    resumed,
  };
}

async function openEpoch(ctx: Context, head: Item | undefined): Promise<{ epochId: string } | { idle: string }> {
  const epochId = epochIdAt(ctx.now);
  const closedAt = ctx.nowIso;
  const lastId = typeof head?.epochId === "string" ? head.epochId : undefined;
  const lastClosedAt = typeof head?.closedAt === "string" ? head.closedAt : undefined;
  if (lastId !== undefined && (!(epochId > lastId) || lastClosedAt === undefined || !(closedAt > lastClosedAt))) return { idle: "slot_not_after_head" };
  const lastStatementHash = typeof head?.statementHash === "string" ? head.statementHash : null;
  const { sealsTable } = ctx.deps;
  try {
    await transact(ctx, [
      {
        Put: {
          TableName: sealsTable,
          Item: { pk: `EPOCH#${epochId}`, sk: "META", status: "freezing", closedAt, prevEpochId: lastId ?? null, prevStatementHash: lastId === undefined ? null : lastStatementHash, createdAt: closedAt },
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
      lastId === undefined
        ? { Put: { TableName: sealsTable, Item: { pk: "EPOCH_HEAD", sk: "HEAD", openEpochId: epochId }, ConditionExpression: "attribute_not_exists(pk)" } }
        : {
          Update: {
            TableName: sealsTable,
            Key: { pk: "EPOCH_HEAD", sk: "HEAD" },
            UpdateExpression: "SET #open = :id",
            ConditionExpression: "attribute_not_exists(#open) AND #epochId = :last AND #epochId < :id AND #closedAt < :closedAt",
            ExpressionAttributeNames: { "#open": "openEpochId", "#epochId": "epochId", "#closedAt": "closedAt" },
            ExpressionAttributeValues: { ":id": epochId, ":last": lastId, ":closedAt": closedAt },
          },
        },
    ]);
  } catch (error) {
    const codes = cancellationCodes(error);
    if (codes !== undefined && codes.includes("ConditionalCheckFailed")) return { idle: "epoch_taken" };
    if (isTransactionConflict(error)) return { idle: "epoch_taken" };
    throw error;
  }
  return { epochId };
}

// ---- the backstop -----------------------------------------------------------------------------------------------

/**
 * C2's backstop, at the first run of each hour: any org with records past its sealed seq and no seal for at least
 * AUDIT_BACKSTOP_SEAL_AGE_MINUTES gets its marker back, if it has none. The put is conditional on the marker being absent,
 * which is the pinned `PutItem` and nothing the appender could race with.
 */
async function runBackstop(ctx: Context): Promise<void> {
  const hour = ctx.nowIso.slice(0, 13);
  const done = await getItem(ctx, ctx.deps.sealsTable, "BACKSTOP", "STATE");
  if (typeof done?.hour === "string" && done.hour >= hour) return;
  const orgs = (await queryAll(ctx, { TableName: ctx.deps.ledgerTable, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": "AUDIT_ORGS" } })).map((item) => text(item.sk, "org list key"));
  await eachPage(orgs, async (orgId) => {
    const [state, headSeq] = await Promise.all([readState(ctx, orgId), readHeadSeq(ctx, orgId)]);
    const sealedSeq = state?.sealedSeq ?? 0;
    if (headSeq <= sealedSeq) return;
    if (state !== undefined && ctx.now - Date.parse(state.sealedAt) < AUDIT_BACKSTOP_SEAL_AGE_MINUTES * 60_000) return;
    try {
      await ctx.deps.documentClient.send(new PutCommand({
        TableName: ctx.deps.ledgerTable,
        Item: { pk: "AUDIT_DIRTY", sk: orgId, since: sealedSeq + 1, lastSeq: headSeq },
        ConditionExpression: "attribute_not_exists(pk)",
      }));
    } catch (error) {
      if (isConditionalFailure(error)) return;
      throw error;
    }
    ctx.deps.log({ event: "audit.backstop_marked", level: "warn", orgId, headSeq, sealedSeq });
  });
  try {
    await ctx.deps.documentClient.send(new PutCommand({
      TableName: ctx.deps.sealsTable,
      Item: { pk: "BACKSTOP", sk: "STATE", hour },
      ConditionExpression: "attribute_not_exists(pk) OR #hour < :hour",
      ExpressionAttributeNames: { "#hour": "hour" },
      ExpressionAttributeValues: { ":hour": hour },
    }));
  } catch (error) {
    // Another run finished this hour's backstop first.
    if (!isConditionalFailure(error)) throw error;
  }
}

// ---- the run ----------------------------------------------------------------------------------------------------

function logEpoch(ctx: Context, summary: AnchorEpochSummary): void {
  ctx.deps.log({ event: "audit.epoch_sealed", ...summary });
}

/**
 * One run, every 15 minutes: finish the epoch an earlier run left open (if that fails the run stops and opens no new one),
 * run the hourly backstop, and, if any org has new records, open the epoch of this slot and seal it.
 */
export async function runAuditEpoch(deps: AnchorDeps, now: number): Promise<AnchorRunResult> {
  try {
    return await runEpochs(deps, now);
  } finally {
    // Task 15: the shreds that have come due, after the sealing, whether or not the epoch work finished: an erasure that is due must
    // not wait on a lock mismatch or a stuck timestamp. Its errors are logged for the alarm and never fail the run.
    await sweepDueShreds(deps, now);
  }
}

/** Shreds the companies whose time has come (erase.ts). Never throws: a failure is the `audit.shred_failed` alarm's to report. */
async function sweepDueShreds(deps: AnchorDeps, now: number): Promise<void> {
  const settings = deps.shred;
  if (settings === undefined) return;
  try {
    await processDueShreds({ documentClient: deps.documentClient, s3: deps.s3, log: deps.log, ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }), ...settings }, now);
  } catch (error) {
    deps.log({ event: "audit.shred_failed", level: "error", step: "run", error: errorName(error) });
  }
}

async function runEpochs(deps: AnchorDeps, now: number): Promise<AnchorRunResult> {
  const ctx: Context = { deps, now, nowIso: new Date(now).toISOString(), stampRequests: new Map(), lastStampRequestAt: new Map(), lastRecordedAt: new Map(), settled: new Set() };
  const epochs: AnchorEpochSummary[] = [];
  const finish = (reason?: string): AnchorRunResult => {
    const status = epochs.some((epoch) => epoch.status === "stamp_pending") ? "stamp_pending" : epochs.length > 0 ? "sealed" : "idle";
    return { status, ...(reason === undefined ? {} : { reason }), epochs };
  };
  try {
    // 0. Task 9: the bucket must still be what the floor says (default retention, versioning), and the next slice of the sealed
    // keys is swept for delete markers and extra versions. A bucket below the floor stops the run before anything is written or
    // finalized; the mismatch is logged by the check.
    const lock = await runLockChecks(deps, now);
    if (!lock.ok) throw new StopRun("lock_config_mismatch", undefined);

    // 0b. Task 10: settle the timestamps a crashed run left half done, before this run makes any epoch of its own.
    await resumeStamps(ctx);

    // 1. Resume first.
    const head = await getItem(ctx, deps.sealsTable, "EPOCH_HEAD", "HEAD");
    if (typeof head?.openEpochId === "string") {
      const summary = await driveEpoch(ctx, head.openEpochId, true);
      epochs.push(summary);
      logEpoch(ctx, summary);
    }
    await runBackstop(ctx);

    // 2. Open this slot's epoch, if there is anything to seal and the slot is later than the last epoch's.
    const last = await getItem(ctx, deps.sealsTable, "EPOCH_HEAD", "HEAD");
    const lastId = typeof last?.epochId === "string" ? last.epochId : undefined;
    let idle: string | undefined;
    if (lastId !== undefined && !(epochIdAt(now) > lastId)) idle = "slot_not_after_head";
    else if (!(await hasWork(ctx))) idle = "nothing_to_seal";
    else {
      const opened = await openEpoch(ctx, last);
      if ("idle" in opened) idle = opened.idle;
      else {
        const summary = await driveEpoch(ctx, opened.epochId, false);
        epochs.push(summary);
        logEpoch(ctx, summary);
      }
    }
    if (idle !== undefined) {
      // Nothing to seal this slot: the newest epoch still waiting for a timestamp gets another try.
      await stampWaiting(ctx);
      deps.log({ event: "audit.epoch_sealed", status: "idle", reason: idle });
    }
    return finish(idle);
  } catch (error) {
    if (error instanceof StopRun) {
      if (error.entry !== undefined) deps.log(error.entry);
      deps.log({ event: "audit.epoch_stopped", level: "error", reason: error.reason });
      return { status: "stopped", reason: error.reason, epochs };
    }
    deps.log({ event: "audit.epoch_failed", level: "error", error: errorName(error) });
    throw error;
  }
}
