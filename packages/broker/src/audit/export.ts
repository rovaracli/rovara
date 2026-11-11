// Exporting the audit ledger as a self-checking bundle (Task 11). The bundle is what the standalone verifier
// (packages/audit-verifier) checks offline, so it is built from the locked objects the anchor wrote, not from the table:
//
//   buildAuditBundle   the org's records and seals for a range, widened to whole seals; every sealed object (seal, records,
//                      epoch statement, leaves, timestamp tokens) is read by the VERSION ID the anchor recorded, so a later
//                      version or delete marker at the same key changes nothing; records after the last seal come from the table
//   startAuditExport   records the request (`running`) and starts the build in the background (an async invoke of the export function)
//   runAuditExport     builds, runs `verifyBundle` exactly as an auditor would, and only then writes the file and marks `ready`
//                      in one transaction with the `audit.exported` pending item; a bundle that does not verify is `failed`, no file
//   getAuditExport, exportDownloadUrl   status and a short-lived download link
//
// Every key is built from the `orgId` argument: the seal index only supplies version ids, and its recorded keys must equal the
// keys derived here, so a changed index item cannot make one org's export read another org's objects.
import { createHash, randomBytes, type X509Certificate } from "node:crypto";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AUDIT_ERROR_MESSAGES, AUDIT_EXPORT_MAX_RECORDS, AUDIT_EXPORT_AVAILABLE_DAYS, AUDIT_EXPORT_MAX_EVENT_AGE_SECONDS, AUDIT_EXPORT_TIMEOUT_SECONDS, AUDIT_EXPORT_URL_SECONDS, genesisHash, inclusionPath, sealHash, sealLeafData, verifyBundle, type AuditBundleV1, type AuditRecordV1, type BundleDetail, type BundleReport, type BundleSeal, type BundleTimestamp, type EpochStatementV1, type LockedObjectV1, type OrgSealV1 } from "@agentx/cloud-contracts";
import { AgentXError, agentXError, orgScoped, type OrgId } from "@rovara-code/contracts";
import { type AuditActor } from "@agentx/cloud-contracts";
import { leavesObjectKey, recordsObjectKey, sealObjectKey, statementObjectKey, tokenObjectKey } from "./anchor.js";
import { auditExported } from "./events.js";
import { flushAuditEvents } from "./flush.js";
import { auditPending, type AuditDeps } from "./outbox.js";
import {
  checkedOrgId,
  isEpochId,
  queryLedgerItems,
  readEpoch,
  readHeadSeq,
  readSealedSeq,
  recordOfItem,
  sealedDetailsOf,
  type AuditReadDeps,
  type EpochRecord,
} from "./reader.js";

const gzipAsync = promisify(gzip);

/** The event the broker sends the export function (an asynchronous invoke) to build an export. */
export const AUDIT_EXPORT_SOURCE = "agentx.audit-export";
export interface AuditExportEvent {
  source: typeof AUDIT_EXPORT_SOURCE;
  orgId: string;
  exportId: string;
}

/** The platform starts no attempt of an export older than this (the function's event age), and the worker refuses one that is. */
export const AUDIT_EXPORT_MAX_AGE_MS = AUDIT_EXPORT_MAX_EVENT_AGE_SECONDS * 1000;
/**
 * A `running` export older than the last start the platform allows plus one full run has lost its worker: it is reported as failed,
 * and that is final. A minute is added for start-up time and the clocks of the machines involved.
 */
export const AUDIT_EXPORT_STALE_MS = AUDIT_EXPORT_MAX_AGE_MS + AUDIT_EXPORT_TIMEOUT_SECONDS * 1000 + 60_000;
/** A put that S3 answers with a conflicting conditional operation is tried again this many times before the run gives up (and the platform retries it). */
const PUT_CONFLICT_RETRIES = 3;
/** Seal objects are read this many at a time. */
const SEAL_READ_CONCURRENCY = 4;
/** How far back a covering chain is followed (a few epochs a day: this is years). */
const COVER_WALK_MAX = 100_000;

/** What every export function needs: the tables the reader reads, the State table where export records live, and the outbox. */
export interface AuditExportBase extends AuditReadDeps, AuditDeps {
  /** The State table: the export records live here, beside the pending audit items. */
  tableName: string;
  now: () => number;
  log: (entry: Record<string, unknown>) => void;
}

/** The broker's side: record a request, start the build, read its status and hand out a link. The broker builds nothing itself. */
export interface AuditExportClientDeps extends AuditExportBase {
  exportsBucket: string;
  /** Starts `runAuditExport` in the export function (an asynchronous invoke of it). */
  invokeExport: (event: AuditExportEvent) => Promise<void>;
  /** A presigned GET URL for one object of the exports bucket, and the lifetime it really has (never longer than the signing credentials). */
  presign: (input: { bucket: string; key: string; expiresInSeconds: number }) => Promise<{ url: string; expiresInSeconds: number }>;
}

/** The export function's side: build, verify and store. */
export interface AuditExportDeps extends AuditExportBase {
  /** The ledger bucket (reads by version id only) and the exports bucket (put, get, delete, list). One client for both. */
  s3: S3Client;
  ledgerBucket: string;
  exportsBucket: string;
  /** The roots tokens are checked against, per authority label. A label without roots is reported, not failed (`unverifiedAuthorities`). */
  anchors: Readonly<Record<string, readonly X509Certificate[]>>;
}

export interface AuditBundleRange {
  fromSeq: number;
  toSeq: number;
  withDetails: boolean;
}

/** A problem with what is stored (a missing sealed object, an index that does not fit), as opposed to a failed call: retrying will not help. */
export class AuditExportBuildError extends Error {
  constructor(readonly code: "SEALED_OBJECT_MISSING" | "SEAL_INDEX_INCONSISTENT", message: string) {
    super(message);
    this.name = "AuditExportBuildError";
  }
}

const SHREDDED_CANNOT_EXPORT = "That organization's audit details have been deleted, so it can't be exported.";
const SHREDDED_EXPORT_GONE = "That export was deleted with the organization's audit details.";
/**
 * NOT_FOUND for a shredded org: nothing is exported for it and no link is signed. The staff routes ask this BEFORE they record a staff
 * read, so that a request that cannot happen leaves no record in the closed company's permanent log.
 */
export async function refuseShreddedExport(deps: Pick<AuditExportBase, "keyring">, orgId: string, what: "start" | "download"): Promise<void> {
  if (await deps.keyring.isOrgShredded(orgId)) throw agentXError("NOT_FOUND", what === "start" ? SHREDDED_CANNOT_EXPORT : SHREDDED_EXPORT_GONE);
}

const rangeInvalid = (): Error => agentXError("AUDIT_RANGE_INVALID", AUDIT_ERROR_MESSAGES.AUDIT_RANGE_INVALID);
const pad12 = (seq: number): string => String(seq).padStart(12, "0");
const inconsistent = (what: string): AuditExportBuildError => new AuditExportBuildError("SEAL_INDEX_INCONSISTENT", what);

/** Where an export's files live: every attempt writes one under this prefix, with a key of its own. */
export const exportObjectPrefix = (orgId: string, exportId: string): string => `${orgId}/${exportId}.`;
/** The one shape a file's key may have: `<orgId>/<exportId>.<16 lowercase hex>.rovara-audit.json.gz`. */
const exportFileKey = (orgId: string, exportId: string): RegExp => new RegExp(`^${orgId}/${exportId}\\.[0-9a-f]{16}\\.rovara-audit\\.json\\.gz$`);
/** The file of one attempt. The attempt's suffix is random, so no run can write, replace or delete another run's file. */
export const exportObjectKey = (orgId: string, exportId: string, attempt: string): string => `${exportObjectPrefix(orgId, exportId)}${attempt}.rovara-audit.json.gz`;

// ---- reading sealed objects ---------------------------------------------------------------------------------------

function isMissing(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === "NoSuchKey" || name === "NoSuchVersion" || name === "NotFound" || status === 404;
}

/** One object of the ledger bucket, by the version id the anchor recorded: never "the latest". */
async function readVersion(deps: AuditExportDeps, key: string, versionId: unknown): Promise<Uint8Array> {
  if (typeof versionId !== "string" || versionId === "") throw inconsistent("a sealed object has no recorded version");
  try {
    const out = await deps.s3.send(new GetObjectCommand({ Bucket: deps.ledgerBucket, Key: key, VersionId: versionId }));
    if (out.Body === undefined) throw new AuditExportBuildError("SEALED_OBJECT_MISSING", "a sealed object has no body");
    return await out.Body.transformToByteArray();
  } catch (error) {
    if (isMissing(error)) throw new AuditExportBuildError("SEALED_OBJECT_MISSING", "a sealed object is missing");
    throw error;
  }
}

async function readJson<T>(deps: AuditExportDeps, key: string, object: LockedObjectV1 | undefined): Promise<T> {
  // The key is derived here; a recorded key that differs means the index points somewhere else.
  if (object === undefined || object.key !== key) throw inconsistent("a recorded object does not have the key it should");
  try {
    return JSON.parse(Buffer.from(await readVersion(deps, key, object.versionId)).toString("utf8")) as T;
  } catch (error) {
    if (error instanceof SyntaxError) throw inconsistent("a sealed object is not readable");
    throw error;
  }
}

// ---- the seal index -------------------------------------------------------------------------------------------------

interface SealIndexEntry {
  fromSeq: number;
  toSeq: number;
  epochId: string;
  objects: { records: LockedObjectV1; seal: LockedObjectV1 };
}

function toSealEntry(item: Record<string, unknown>): SealIndexEntry {
  const fromSeq = Number(item.sk);
  const toSeq = item.toSeq;
  if (!Number.isSafeInteger(fromSeq) || typeof toSeq !== "number" || !Number.isSafeInteger(toSeq) || toSeq < fromSeq || !isEpochId(item.epochId)) throw inconsistent("a seal index item is malformed");
  const objects = item.objects as SealIndexEntry["objects"] | undefined;
  if (objects?.seal === undefined || objects.records === undefined) throw inconsistent("a seal index item has no objects");
  return { fromSeq, toSeq, epochId: item.epochId, objects };
}

async function sealIndex(deps: AuditReadDeps, orgId: string, from: string, to: string, options: { newestFirst?: boolean; limit?: number } = {}): Promise<SealIndexEntry[]> {
  const entries: SealIndexEntry[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const out = await deps.documentClient.send(new QueryCommand({
      TableName: deps.sealsTable,
      KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
      ExpressionAttributeValues: { ":pk": `SEALS#${orgId}`, ":from": from, ":to": to },
      ConsistentRead: true,
      ...(options.newestFirst === true ? { ScanIndexForward: false } : {}),
      ...(options.limit === undefined ? {} : { Limit: options.limit }),
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    }));
    entries.push(...(out.Items ?? []).map(toSealEntry));
    start = options.limit === undefined ? out.LastEvaluatedKey : undefined;
  } while (start !== undefined);
  return entries;
}

/** The seal that starts at or before `seq` and is the newest such: the one that holds `seq` when `seq` is sealed. */
async function sealAtOrBefore(deps: AuditReadDeps, orgId: string, seq: number): Promise<SealIndexEntry | undefined> {
  return (await sealIndex(deps, orgId, pad12(0), pad12(seq), { newestFirst: true, limit: 1 }))[0];
}

// ---- epochs ---------------------------------------------------------------------------------------------------------

interface EpochPart {
  meta: EpochRecord;
  statement: EpochStatementV1;
  object: LockedObjectV1;
  leaves: OrgSealV1[];
  /** `sealLeafData` of each leaf, computed once per epoch. */
  leafData: Uint8Array[];
  tokens: BundleTimestamp[];
}

const TSA_LABEL = /^[A-Za-z0-9_.-]{1,64}$/;

/** The reads of the epochs a bundle touches, each once. */
class EpochReader {
  private readonly parts = new Map<string, Promise<EpochPart>>();

  constructor(private readonly deps: AuditExportDeps) {}

  part(epochId: string): Promise<EpochPart> {
    let found = this.parts.get(epochId);
    if (found === undefined) {
      found = this.load(epochId);
      this.parts.set(epochId, found);
    }
    return found;
  }

  private async load(epochId: string): Promise<EpochPart> {
    const meta = await readEpoch(this.deps, epochId);
    if (meta?.objects === undefined || meta.statement === undefined) throw inconsistent("an epoch has no statement objects");
    const statement = await readJson<EpochStatementV1>(this.deps, statementObjectKey(epochId), meta.objects.statement);
    const leaves = (await readJson<{ seals: OrgSealV1[] }>(this.deps, leavesObjectKey(epochId), meta.objects.leaves)).seals;
    if (statement.epochId !== epochId || !Array.isArray(leaves)) throw inconsistent("an epoch's objects do not fit it");
    const tokens: BundleTimestamp[] = [];
    for (const [label, stamp] of Object.entries(meta.stamps).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
      if (!TSA_LABEL.test(label)) throw inconsistent("a timestamp has an unusable label");
      const key = tokenObjectKey(epochId, label);
      if (stamp.object.key !== key) throw inconsistent("a timestamp's object has the wrong key");
      tokens.push({ tsa: label, token: Buffer.from(await readVersion(this.deps, key, stamp.object.versionId)).toString("base64"), object: stamp.object });
    }
    return { meta, statement, object: meta.objects.statement, leaves, leafData: leaves.map((leaf) => sealLeafData(leaf)), tokens };
  }

  /**
   * The statements from the epoch after `epochId` up to `coveringId`, and the covering epoch's tokens, or undefined when the
   * chain cannot be followed from the covering epoch back to `epochId` (the verifier then reports the epoch as not covered).
   */
  async coveredBy(epochId: string, coveringId: string): Promise<{ epochs: EpochStatementV1[]; timestamps: BundleTimestamp[] } | undefined> {
    const chain: EpochStatementV1[] = [];
    let id: string | null = coveringId;
    for (let steps = 0; id !== null && steps < COVER_WALK_MAX; steps += 1) {
      const meta = await readEpoch(this.deps, id);
      if (meta?.statement === undefined) return undefined;
      chain.push(meta.statement);
      if (meta.prevEpochId === epochId) return { epochs: chain.reverse(), timestamps: (await this.part(coveringId)).tokens };
      id = meta.prevEpochId;
    }
    return undefined;
  }
}

// ---- the bundle -----------------------------------------------------------------------------------------------------

async function inGroups<T, R>(items: readonly T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let offset = 0; offset < items.length; offset += size) results.push(...await Promise.all(items.slice(offset, offset + size).map(work)));
  return results;
}

async function readSealEntry(deps: AuditExportDeps, orgId: string, entry: SealIndexEntry, epochs: EpochReader): Promise<{ bundleSeal: BundleSeal; records: AuditRecordV1[] }> {
  const seal = await readJson<OrgSealV1>(deps, sealObjectKey(orgId, entry.fromSeq), entry.objects.seal);
  if (seal.orgId !== orgId || seal.fromSeq !== entry.fromSeq || seal.toSeq !== entry.toSeq || seal.epochId !== entry.epochId) throw inconsistent("a seal does not fit its index item");
  const recordsKey = recordsObjectKey(orgId, entry.fromSeq);
  if (entry.objects.records.key !== recordsKey) throw inconsistent("a recorded object does not have the key it should");
  const text = Buffer.from(await readVersion(deps, recordsKey, entry.objects.records.versionId)).toString("utf8");
  let records: AuditRecordV1[];
  try {
    records = text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as AuditRecordV1);
  } catch {
    throw inconsistent("a sealed records object is not readable");
  }
  if (records.length !== entry.toSeq - entry.fromSeq + 1) throw inconsistent("a sealed records object does not hold its range");

  const epoch = await epochs.part(entry.epochId);
  const index = epoch.leaves.findIndex((leaf) => leaf.orgId === orgId);
  const leaf = epoch.leaves[index];
  if (leaf === undefined || sealHash(leaf) !== sealHash(seal)) throw inconsistent("an epoch's leaves do not hold the org's seal");
  const bundleSeal: BundleSeal = {
    seal,
    sealObject: entry.objects.seal,
    recordsObject: entry.objects.records,
    inclusion: { index, size: epoch.leaves.length, path: inclusionPath(epoch.leafData, index) },
    epoch: epoch.statement,
    epochObject: epoch.object,
    timestamps: epoch.tokens,
  };
  if (epoch.meta.coveredBy !== undefined) {
    const covered = await epochs.coveredBy(entry.epochId, epoch.meta.coveredBy);
    if (covered === undefined) deps.log({ event: "audit.export_cover_chain_broken", level: "warn", epochId: entry.epochId, coveredBy: epoch.meta.coveredBy });
    else bundleSeal.coveredBy = covered;
  }
  return { bundleSeal, records };
}

/**
 * The org's bundle for a range of sequence numbers. The range is widened to whole seals at both ends (a seal is checked as a
 * whole), and a range that reaches past the last seal carries the records after it as `unsealed`. More than AUDIT_EXPORT_MAX_RECORDS
 * after widening is AUDIT_RANGE_INVALID, before any object is read. Details only when asked: opened with the org's keys, a part
 * whose key is gone as `erased`.
 */
export async function buildAuditBundle(deps: AuditExportDeps, orgId: string, range: AuditBundleRange): Promise<AuditBundleV1> {
  checkedOrgId(orgId);
  const wholeNumber = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
  if (!wholeNumber(range.fromSeq) || !wholeNumber(range.toSeq) || range.fromSeq < 1 || range.fromSeq > range.toSeq) throw rangeInvalid();
  const [headSeq, sealedSeq] = await Promise.all([readHeadSeq(deps, orgId), readSealedSeq(deps, orgId)]);
  if (range.fromSeq > headSeq) throw rangeInvalid();
  const toSeq = Math.min(range.toSeq, headSeq);

  let startSeq: number;
  if (range.fromSeq <= sealedSeq) {
    const enclosing = await sealAtOrBefore(deps, orgId, range.fromSeq);
    if (enclosing === undefined || enclosing.toSeq < range.fromSeq) throw inconsistent("a sealed sequence number is in no seal");
    startSeq = enclosing.fromSeq;
  } else {
    startSeq = sealedSeq + 1;
  }
  let endSeq = toSeq;
  if (toSeq <= sealedSeq) {
    const enclosing = await sealAtOrBefore(deps, orgId, toSeq);
    if (enclosing === undefined || enclosing.toSeq < toSeq) throw inconsistent("a sealed sequence number is in no seal");
    endSeq = enclosing.toSeq;
  }
  if (endSeq - startSeq + 1 > AUDIT_EXPORT_MAX_RECORDS) throw rangeInvalid();

  const sealedEnd = Math.min(endSeq, sealedSeq);
  const entries = startSeq <= sealedEnd ? await sealIndex(deps, orgId, pad12(startSeq), pad12(sealedEnd)) : [];
  let next = startSeq;
  for (const entry of entries) {
    if (entry.fromSeq !== next) throw inconsistent("the seal index has a gap");
    next = entry.toSeq + 1;
  }
  if (entries.length > 0 && next - 1 !== sealedEnd) throw inconsistent("the seal index does not reach the sealed end");

  let previous: AuditBundleV1["previous"] = { seq: 0, hash: genesisHash(orgId) };
  let previousSeal: OrgSealV1 | null = null;
  if (startSeq > 1) {
    const before = await sealAtOrBefore(deps, orgId, startSeq - 1);
    if (before === undefined || before.toSeq !== startSeq - 1) throw inconsistent("the seal before the export is missing");
    previousSeal = await readJson<OrgSealV1>(deps, sealObjectKey(orgId, before.fromSeq), before.objects.seal);
    if (previousSeal.orgId !== orgId || previousSeal.toSeq !== before.toSeq) throw inconsistent("the seal before the export does not fit its index item");
    previous = { seq: previousSeal.toSeq, hash: previousSeal.headHash };
  }

  const epochs = new EpochReader(deps);
  const sealed = await inGroups(entries, SEAL_READ_CONCURRENCY, (entry) => readSealEntry(deps, orgId, entry, epochs));

  const unsealedFrom = Math.max(startSeq, sealedSeq + 1);
  // With details every item of the range is read (the ciphertext is on the item); without, only the unsealed tail.
  const itemsFrom = range.withDetails ? startSeq : unsealedFrom;
  const items = itemsFrom <= endSeq ? await queryLedgerItems(deps, orgId, itemsFrom, endSeq) : [];
  const tail = items.filter((item) => Number(item.seq) >= unsealedFrom);
  if (unsealedFrom <= endSeq && tail.length !== endSeq - unsealedFrom + 1) throw inconsistent("records are missing from the table");
  const unsealed = tail.map(recordOfItem);

  const bundle: AuditBundleV1 = {
    format: "rovara-audit-bundle",
    v: 1,
    orgId,
    exportedAt: new Date(deps.now()).toISOString(),
    previous,
    previousSeal,
    records: sealed.flatMap((entry) => entry.records),
    seals: sealed.map((entry) => entry.bundleSeal),
    unsealed,
  };

  if (range.withDetails) {
    const bySeq = new Map(items.map((item) => [Number(item.seq), item]));
    const details: BundleDetail[] = [];
    for (const record of [...bundle.records, ...bundle.unsealed]) {
      if (record.details.length === 0) continue;
      const item = bySeq.get(record.seq);
      const opened = item === undefined ? [] : await deps.keyring.openDetails(orgId, record.seq, sealedDetailsOf(item));
      for (const commit of record.details) {
        const part = opened.find((candidate) => candidate.subject === commit.subject);
        details.push(part === undefined || "erased" in part ? { seq: record.seq, subject: commit.subject, erased: true } : { seq: record.seq, subject: commit.subject, salt: part.salt, fields: part.fields });
      }
    }
    bundle.details = details;
  }
  return bundle;
}

// ---- export records -------------------------------------------------------------------------------------------------

const EXPORT_ID = /^aex_[0-9a-f]{32}$/;

/** Who asks: a member of the org (the org comes from their session) or a Rovara operator reading one org. The org is the only source of every key. */
export interface AuditExportRequester {
  orgId: OrgId;
  actor: Extract<AuditActor, { kind: "member" | "operator" }>;
}

export interface AuditExportRequest {
  /** Makes the request idempotent: the same request id for one org is the same export. */
  requestId: string;
  fromSeq: number;
  toSeq: number;
  withDetails?: boolean;
}

/** `expired`: a ready export past its `expiresAt` (a day before the bucket removes the file). */
export type AuditExportStatus = "running" | "ready" | "failed" | "expired";

export interface AuditExportSummary {
  fromSeq: number;
  toSeq: number;
  records: number;
  sealedThroughSeq: number;
  unsealedCount: number;
  /** Read beside each other: `timestampedThrough` says nothing about the epochs listed in `epochsWithoutTimestamp`. */
  timestampedThrough?: string;
  epochsWithoutTimestamp: string[];
  coveredEpochs: string[];
  unverifiedAuthorities: string[];
  lockModes: string[];
  bytes: number;
}

export interface AuditExportView {
  exportId: string;
  status: AuditExportStatus;
  requestedBy: AuditActor;
  range: { fromSeq: number; toSeq: number };
  withDetails: boolean;
  createdAt: string;
  completedAt?: string;
  /** When a ready export stops being offered: AUDIT_EXPORT_AVAILABLE_DAYS after it completed. */
  expiresAt?: string;
  summary?: AuditExportSummary;
  failure?: { code: string; failedChecks?: string[]; report?: BundleReport };
}

const metaKey = (orgId: string, exportId: string): { pk: string; sk: string } => ({ pk: orgScoped(orgId, `AUDIT_EXPORT#${exportId}`), sk: "META" });

/** Whole sequence numbers from 1, `from` not after `to`, and at most AUDIT_EXPORT_MAX_RECORDS records: else AUDIT_RANGE_INVALID. */
export function assertExportRange(fromSeq: unknown, toSeq: unknown): void {
  const wholeNumber = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
  if (!wholeNumber(fromSeq) || !wholeNumber(toSeq) || fromSeq < 1 || fromSeq > toSeq || toSeq - fromSeq + 1 > AUDIT_EXPORT_MAX_RECORDS) throw rangeInvalid();
}

/** Whether `value` has the shape of an export id (`aex_` and 32 hex): anything else names no export. */
export const isAuditExportId = (value: string): boolean => EXPORT_ID.test(value);

export function auditExportId(orgId: string, requestId: string): string {
  return `aex_${createHash("sha256").update(`rovara-audit-export-v1\n${orgId}\n${requestId}`).digest("hex").slice(0, 32)}`;
}

/** A ready export with no readable expiry counts as expired: nothing signs a link for a record that cannot say its file is still there. */
function isExpired(expiresAt: unknown, now: number): boolean {
  const at = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
  return Number.isNaN(at) || now >= at;
}

function viewOf(item: Record<string, unknown>, now: number): AuditExportView {
  const { pk: _pk, sk: _sk, entityType: _entityType, orgId: _orgId, ...view } = item;
  void _pk; void _sk; void _entityType; void _orgId;
  const result = view as unknown as AuditExportView;
  if (result.status === "running" && now - Date.parse(result.createdAt) > AUDIT_EXPORT_STALE_MS) {
    return { ...result, status: "failed", failure: { code: "TIMED_OUT" } };
  }
  if (result.status === "ready" && isExpired(result.expiresAt, now)) return { ...result, status: "expired" };
  return result;
}

async function readMeta(deps: AuditExportBase, orgId: string, exportId: string): Promise<Record<string, unknown> | undefined> {
  if (!EXPORT_ID.test(exportId)) return undefined;
  const out = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: metaKey(orgId, exportId), ConsistentRead: true }));
  return out.Item;
}

/** The export's record, or undefined when this org has no such export (another org's export id is unknown here). */
export async function getAuditExport(deps: AuditExportBase, orgId: string, exportId: string): Promise<AuditExportView | undefined> {
  checkedOrgId(orgId);
  const item = await readMeta(deps, orgId, exportId);
  return item === undefined ? undefined : viewOf(item, deps.now());
}

/**
 * Records the request as `running` and starts the build in the background. The same `requestId` for the same org is the same
 * export: a repeat returns it and starts nothing. A range of more than AUDIT_EXPORT_MAX_RECORDS is refused up front.
 */
export async function startAuditExport(deps: AuditExportClientDeps, requester: AuditExportRequester, request: AuditExportRequest): Promise<{ exportId: string; status: AuditExportStatus }> {
  const orgId = checkedOrgId(requester.orgId);
  const { fromSeq, toSeq } = request;
  assertExportRange(fromSeq, toSeq);
  // A shredded org (task 15) gets no new export: this is the code that answers, for the org's routes and the staff path alike.
  await refuseShreddedExport(deps, orgId, "start");
  if (typeof request.requestId !== "string" || request.requestId === "" || request.requestId.length > 200) throw agentXError("CONFIG_INVALID", "Give each export request an id of 1 to 200 characters.");
  const exportId = auditExportId(orgId, request.requestId);
  const now = new Date(deps.now()).toISOString();
  try {
    await deps.documentClient.send(new PutCommand({
      TableName: deps.tableName,
      Item: {
        ...metaKey(orgId, exportId),
        entityType: "AUDIT_EXPORT",
        orgId,
        exportId,
        status: "running",
        requestedBy: requester.actor,
        range: { fromSeq, toSeq },
        withDetails: request.withDetails === true,
        createdAt: now,
      },
      ConditionExpression: "attribute_not_exists(pk)",
    }));
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") {
      const existing = await getAuditExport(deps, orgId, exportId);
      return { exportId, status: existing?.status ?? "running" };
    }
    throw error;
  }
  try {
    await deps.invokeExport({ source: AUDIT_EXPORT_SOURCE, orgId, exportId });
  } catch (error) {
    deps.log({ event: "audit.export_start_failed", level: "error", orgId, exportId, error: error instanceof Error ? error.name : "unknown" });
    await failExport(deps, orgId, exportId, { code: "COULD_NOT_START" });
    return { exportId, status: "failed" };
  }
  return { exportId, status: "running" };
}

async function failExport(deps: AuditExportBase, orgId: string, exportId: string, failure: NonNullable<AuditExportView["failure"]>): Promise<void> {
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName,
      Key: metaKey(orgId, exportId),
      UpdateExpression: "SET #status = :failed, #failure = :failure, #completedAt = :at",
      ConditionExpression: "#status = :running",
      ExpressionAttributeNames: { "#status": "status", "#failure": "failure", "#completedAt": "completedAt" },
      ExpressionAttributeValues: { ":failed": "failed", ":running": "running", ":failure": failure, ":at": new Date(deps.now()).toISOString() },
    }));
  } catch (error) {
    // Finished by someone else already.
    if (!(error instanceof Error && error.name === "ConditionalCheckFailedException")) throw error;
  }
}

function isRequestConflict(error: unknown): boolean {
  return error instanceof Error && (error.name === "ConditionalRequestConflict" || (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 409);
}

export type AuditExportOutcome = "ready" | "failed" | "unknown" | "already_ready" | "already_failed";

/**
 * Builds the export, checks it with the verifier's own `verifyBundle`, and only a bundle that passes is written. `failed` keeps the
 * whole report and writes no file. A file is gzipped JSON at `<orgId>/<exportId>.<attempt>.rovara-audit.json.gz` in the exports
 * bucket, where `<attempt>` is 16 random hex digits chosen by this run alone (so no run writes over or deletes another's file); `ready`
 * is set in ONE transaction with the `audit.exported` pending item, recording that key, the file's size and `expiresAt` (6 days on, a
 * day before the bucket's lifecycle removes the file), so the record of the export and the export commit together. A commit that is
 * definitely cancelled removes this run's own file and throws; any other commit error keeps the file and throws (the commit may
 * still land), and the platform's retry of the background invoke starts again. A finished export is not rebuilt.
 */
export async function runAuditExport(deps: AuditExportDeps, event: { orgId: string; exportId: string }): Promise<AuditExportOutcome> {
  const orgId = checkedOrgId(event.orgId);
  const { exportId } = event;
  const item = await readMeta(deps, orgId, exportId);
  if (item === undefined) {
    deps.log({ event: "audit.export_unknown", level: "warn", orgId });
    return "unknown";
  }
  if (item.status === "ready") return "already_ready";
  if (item.status === "failed") return "already_failed";
  // The platform starts no attempt older than the event age; one that is delivered late anyway is refused, so an export that was
  // reported failed (or is about to be) can never become ready.
  if (deps.now() - Date.parse(String(item.createdAt)) > AUDIT_EXPORT_MAX_AGE_MS) {
    await failExport(deps, orgId, exportId, { code: "TIMED_OUT" });
    return "failed";
  }
  // A queued export of an org that has since been shredded builds nothing.
  if (await deps.keyring.isOrgShredded(orgId)) {
    await failExport(deps, orgId, exportId, { code: "ORG_SHREDDED" });
    return "failed";
  }
  const range = item.range as { fromSeq: number; toSeq: number };
  const withDetails = item.withDetails === true;

  let bundle: AuditBundleV1;
  try {
    bundle = await buildAuditBundle(deps, orgId, { fromSeq: range.fromSeq, toSeq: range.toSeq, withDetails });
  } catch (error) {
    if (error instanceof AgentXError) {
      await failExport(deps, orgId, exportId, { code: error.code });
      return "failed";
    }
    if (error instanceof AuditExportBuildError) {
      deps.log({ event: "audit.export_build_failed", level: "error", orgId, exportId, code: error.code, reason: error.message });
      await failExport(deps, orgId, exportId, { code: error.code });
      return "failed";
    }
    throw error;
  }

  const report = verifyBundle(bundle, { anchors: deps.anchors });
  if (!report.ok) {
    const failedChecks = report.checks.filter((check) => !check.ok).map((check) => check.name);
    deps.log({ event: "audit.export_verification_failed", level: "error", orgId, exportId, failedChecks });
    await failExport(deps, orgId, exportId, { code: "BUNDLE_CHECK_FAILED", failedChecks, report });
    return "failed";
  }

  const body = await gzipAsync(Buffer.from(JSON.stringify(bundle), "utf8"));
  // This attempt's file has a key of its own, so a run never writes over, or deletes, a file it did not write.
  const key = exportObjectKey(orgId, exportId, randomBytes(8).toString("hex"));
  for (let attempt = 0; ; attempt += 1) {
    try {
      await deps.s3.send(new PutObjectCommand({ Bucket: deps.exportsBucket, Key: key, Body: body, ContentType: "application/gzip", IfNoneMatch: "*" }));
      break;
    } catch (error) {
      // 409 ConditionalRequestConflict: another conditional write was in flight; try again a moment later, and past the retries
      // throw, so that the platform retries the run.
      if (!isRequestConflict(error) || attempt >= PUT_CONFLICT_RETRIES) throw error;
      await new Promise<void>((resolve) => { setTimeout(resolve, 50 * 2 ** attempt); });
    }
  }

  // A shred that began while this run built: the file just written must not outlive the marker. Looking after the put means the
  // marker was written before the look, or the file was there before it: the shred's sweep (30 s after the marker) then finds it.
  if (await deps.keyring.isOrgShredded(orgId)) {
    try {
      await deps.s3.send(new DeleteObjectCommand({ Bucket: deps.exportsBucket, Key: key }));
    } catch {
      // The shred's sweep and the bucket's lifecycle remove it.
    }
    await failExport(deps, orgId, exportId, { code: "ORG_SHREDDED" });
    return "failed";
  }

  const all = [...bundle.records, ...bundle.unsealed];
  const first = all[0];
  const last = all.at(-1);
  const summary: AuditExportSummary = {
    fromSeq: first?.seq ?? range.fromSeq,
    toSeq: last?.seq ?? range.toSeq,
    records: all.length,
    sealedThroughSeq: report.sealedThroughSeq,
    unsealedCount: report.unsealedCount,
    ...(report.timestampedThrough === undefined ? {} : { timestampedThrough: report.timestampedThrough }),
    epochsWithoutTimestamp: report.epochsWithoutTimestamp,
    coveredEpochs: report.coveredEpochs,
    unverifiedAuthorities: report.unverifiedAuthorities,
    lockModes: report.lockModes,
    bytes: body.length,
  };
  const completedAtMs = deps.now();
  const completedAt = new Date(completedAtMs).toISOString();
  // Offered for a day less than the exports bucket keeps its files, so a link is never made for a file the lifecycle may have removed.
  const expiresAt = new Date(completedAtMs + AUDIT_EXPORT_AVAILABLE_DAYS * 86_400_000).toISOString();
  const exported = auditExported({
    orgId,
    actor: item.requestedBy as AuditActor,
    occurredAt: completedAt,
    occurrence: exportId,
    exportId,
    fromSeq: summary.fromSeq,
    toSeq: summary.toSeq,
    withDetails,
  });
  try {
    await deps.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: deps.tableName,
            Key: metaKey(orgId, exportId),
            UpdateExpression: "SET #status = :ready, #summary = :summary, #completedAt = :at, #expiresAt = :expiresAt, #objectKey = :key",
            ConditionExpression: "#status = :running",
            ExpressionAttributeNames: { "#status": "status", "#summary": "summary", "#completedAt": "completedAt", "#expiresAt": "expiresAt", "#objectKey": "objectKey" },
            ExpressionAttributeValues: { ":ready": "ready", ":running": "running", ":summary": summary, ":at": completedAt, ":expiresAt": expiresAt, ":key": key },
          },
        },
        ...auditPending(deps, exported),
      ],
    }));
  } catch (error) {
    // The answer may have been lost after the commit, so look at the record before touching the file.
    const current = await readMeta(deps, orgId, exportId);
    if (current?.status === "ready" && current.objectKey === key) {
      // This run's own commit went through.
      await flushAuditEvents(deps, [exported]);
      return "ready";
    }
    // Only a definite cancellation (a condition failed, a conflict) means nothing was committed, so only then is this run's own file
    // removed. After any other error the commit may still land and name this file, so it is kept (at worst an orphan the lifecycle
    // clears) and the error is thrown for the platform's retry.
    if (error instanceof Error && error.name === "TransactionCanceledException") {
      try {
        await deps.s3.send(new DeleteObjectCommand({ Bucket: deps.exportsBucket, Key: key }));
      } catch {
        // The lifecycle removes it.
      }
    }
    if (current?.status === "ready") return "already_ready";
    if (current?.status === "failed") return "already_failed";
    throw error;
  }
  await flushAuditEvents(deps, [exported]);
  return "ready";
}

/** A link to download a finished export, valid for at most AUDIT_EXPORT_URL_SECONDS (less when the signing credentials end sooner: the answer says how long). NOT_FOUND for an export this org does not have or one that is not ready. */
export async function exportDownloadUrl(deps: AuditExportClientDeps, orgId: string, exportId: string): Promise<{ url: string; expiresInSeconds: number }> {
  checkedOrgId(orgId);
  const item = await readMeta(deps, orgId, exportId);
  if (item === undefined || item.status !== "ready") throw agentXError("NOT_FOUND", "That export was not found, or it is not ready yet.");
  // A shredded org's files are being deleted (or are gone): no link is signed for one, and this is the code that decides it.
  await refuseShreddedExport(deps, orgId, "download");
  // After `expiresAt` the bucket may have removed the file (NOT_FOUND is the code that fits: the export is gone).
  if (isExpired(item.expiresAt, deps.now())) throw agentXError("NOT_FOUND", "That export has expired. Request it again.");
  // The file is the one the ready record names, and only if it has exactly this org's, this export's and an attempt's name.
  const key = item.objectKey;
  if (typeof key !== "string" || !exportFileKey(orgId, exportId).test(key)) {
    deps.log({ event: "audit.export_file_unnamed", level: "error", orgId, exportId });
    throw agentXError("NOT_FOUND", "That export was not found, or it is not ready yet.");
  }
  return deps.presign({ bucket: deps.exportsBucket, key, expiresInSeconds: AUDIT_EXPORT_URL_SECONDS });
}
