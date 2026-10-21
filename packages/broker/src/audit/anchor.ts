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
import {
  AUDIT_BACKSTOP_SEAL_AGE_MINUTES,
  AUDIT_MAX_RECORDS_PER_ORG_EPOCH,
  AUDIT_SEAL_INTERVAL_MINUTES,
  auditCanonicalJson,
  checkChain,
  genesisHash,
  merkleRoot,
  recordHash,
  recordLeafData,
  sealHash,
  sealLeafData,
  statementHash,
  type AuditRecordV1,
  type EpochStatementV1,
  type LockedObjectV1,
  type OrgSealV1,
} from "@agentx/contracts";
import { currentFloor, enforceObjectLock, runLockChecks, type LockCheckDeps } from "./lock-check.js";

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

/**
 * What the anchor runs with. `documentClient` is its own client: it is granted the seals table, and on the ledger table only
 * reads and the dirty marker. `s3` is built with `auditS3ClientConfig`. `lock` is what the stack deployed (the Object Lock
 * floor itself is in code: lock-check.ts).
 */
export interface AnchorDeps extends LockCheckDeps {
  /** Pauses before a retry (a TransactionConflict, a 409 from S3). Defaults to a timer. */
  sleep?: (ms: number) => Promise<void>;
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
export function lockedPutInput(bucket: string, key: string, text: string, contentType: string): PutObjectCommandInput {
  return {
    Bucket: bucket,
    Key: key,
    Body: text,
    ContentType: contentType,
    IfNoneMatch: "*",
    ChecksumAlgorithm: "SHA256",
    ChecksumSHA256: createHash("sha256").update(text, "utf8").digest("base64"),
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
}

interface EpochMeta {
  epochId: string;
  status: "freezing" | "frozen" | "stamp_pending" | "sealed";
  closedAt: string;
  prevEpochId: string | null;
  prevStatementHash: string | null;
  statement?: EpochStatementV1;
  objects?: { statement: LockedObjectV1; leaves: LockedObjectV1 };
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

const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

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

interface ObjectToWrite { key: string; text: string; contentType: string }

/**
 * What the key holds before we write it. R1-2: an empty key is `ListObjectVersions` showing no version and no delete
 * marker. One version whose bytes are ours is a resume after a crash: written already. A delete marker (a simple write
 * would then succeed, because `If-None-Match` passes on a marker), a second version, or other bytes is tampering.
 */
async function inspectKey(ctx: Context, item: ObjectToWrite): Promise<{ versionId: string } | undefined> {
  const versions: string[] = [];
  let markers = 0;
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  do {
    const out = await ctx.deps.s3.send(new ListObjectVersionsCommand({
      Bucket: ctx.deps.bucket,
      Prefix: item.key,
      ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker }),
      ...(versionIdMarker === undefined ? {} : { VersionIdMarker: versionIdMarker }),
    }));
    for (const version of out.Versions ?? []) if (version.Key === item.key && typeof version.VersionId === "string") versions.push(version.VersionId);
    markers += (out.DeleteMarkers ?? []).filter((marker) => marker.Key === item.key).length;
    keyMarker = out.IsTruncated === true ? out.NextKeyMarker : undefined;
    versionIdMarker = out.IsTruncated === true ? out.NextVersionIdMarker : undefined;
  } while (keyMarker !== undefined);
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

/** A create-only write. A 412 is accepted only when the bytes already there are the bytes we meant to write. */
async function createObject(ctx: Context, item: ObjectToWrite): Promise<string> {
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
      if (sha256Hex(await stored.Body!.transformToString()) !== sha256Hex(item.text)) throw new ObjectConflictError(item.key);
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
    UpdateExpression: "SET #seal = :seal, #objects = :objects",
    ExpressionAttributeNames: { "#seal": "seal", "#objects": "objects" },
    ExpressionAttributeValues: { ":seal": seal, ":objects": { records: recordsObject, seal: sealObject } },
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
  const floor = await currentFloor(ctx.deps);
  const epochObjects = meta.objects === undefined ? [] : [meta.objects.statement, meta.objects.leaves];
  const epoch = await enforceObjectLock(ctx.deps, epochObjects, ctx.now, { floor, context: { epochId: meta.epochId } });
  if (!epoch.ok) throw new StopRun("lock_config_mismatch", undefined);
  const pending = (await readIntents(ctx, meta.epochId)).filter((intent) => intent.seal !== undefined && intent.objects !== undefined && !intent.finalized && intent.skipped === undefined && intent.blocked === undefined);
  await eachPage(pending, async (intent) => {
    const checked = await enforceObjectLock(ctx.deps, [intent.objects!.records, intent.objects!.seal], ctx.now, { floor, context: { orgId: intent.orgId, epochId: meta.epochId } });
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

/** Step 9, last: META `sealed` and HEAD move together. */
async function completeEpoch(ctx: Context, meta: EpochMeta, statement: EpochStatementV1): Promise<void> {
  const { sealsTable } = ctx.deps;
  await transact(ctx, [
    {
      Update: {
        TableName: sealsTable,
        Key: { pk: `EPOCH#${meta.epochId}`, sk: "META" },
        UpdateExpression: "SET #status = :sealed",
        ConditionExpression: "#status = :frozen AND attribute_exists(#statement)",
        ExpressionAttributeNames: { "#status": "status", "#statement": "statement" },
        ExpressionAttributeValues: { ":sealed": "sealed", ":frozen": "frozen" },
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
  // Step 7 (Task 10: the timestamps goes here too), before anything is finalized. Task 9: every object is read back, by its
  // version id, and must carry the floor's lock.
  await enforceEpochLocks(ctx, meta);
  await finalizeOrgs(ctx, meta);
  await completeEpoch(ctx, meta, statement);

  const intents = await readIntents(ctx, epochId);
  const sealed = intents.filter((intent) => intent.seal !== undefined && intent.skipped === undefined);
  return {
    epochId,
    status: "sealed",
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
  const ctx: Context = { deps, now, nowIso: new Date(now).toISOString() };
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
    if (idle !== undefined) deps.log({ event: "audit.epoch_sealed", status: "idle", reason: idle });
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
