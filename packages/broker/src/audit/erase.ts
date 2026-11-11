// Erasing personal details from the audit ledger (Task 15, I8). The chain never holds a name, email or login: it holds salted
// commitments, and the details themselves are sealed in the keys table under one key per person (`SUBJECT#<developerId>`), wrapped by
// the org's data key. So erasing is deleting a key, and the chain still verifies.
//
//   eraseAuditSubject   one person: their key becomes a tombstone `{ erasedAt }` (never recreated), with the `audit.subject_erased`
//                       event in the same transaction; then the org's export files are deleted (they hold the details in plaintext).
//   scheduleAuditShred  a closed company: the due item and the `audit.org_shred_scheduled` event, for closeOrg's transaction.
//   processDueShreds    thirty days after the close (run by the anchor every 15 minutes): writes SHREDDED, waits for any key creation
//                       already in flight to land, deletes every other item of the org's keys partition and its export files.
//
// What a delete may touch is fixed by the keys: `ORG#<orgId>` in the keys table (the org id is parsed, never concatenated from input),
// the one due item in the State table, and the `<orgId>/` folder of the exports bucket. The org's own record (`ORG#<orgId>` / `META` in
// the State table) is never read or written here: staff may need the log of a closed company, and the group that closed it is not erased.
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DeleteObjectCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { AUDIT_DETAILS_SHRED_AFTER_CLOSE_DAYS, AUDIT_ERROR_MESSAGES, AUDIT_EXPORT_FILE_LIFECYCLE_DAYS, AUDIT_PENDING_TTL_DAYS, AUDIT_TRANSIENT_COPY_DAYS } from "@agentx/cloud-contracts";
import { OrgIdSchema, agentXError, type OrgId } from "@rovara-code/contracts";
import { type AuditActor } from "@agentx/cloud-contracts";
import { auditOccurrence, auditShredScheduled, auditSubjectErased } from "./events.js";
import { flushAuditEvents } from "./flush.js";
import { AUDIT_KEY_CACHE_MS } from "./keyring.js";
import { auditPending, type AuditDeps, type TransactItem } from "./outbox.js";

/** The State-table partition of the due items: one per closed company, with the time it is due in the sort key. */
export const AUDIT_SHRED_DUE_PARTITION = "AUDIT_SHRED_DUE";
/**
 * How long a shred waits after writing SHREDDED before it deletes anything: the appender's timeout (30 s) plus 5 s of margin, so that a
 * key creation which started just before SHREDDED was written still lands inside the wait, and the sweep comes after it (the keyring
 * cannot condition a create on SHREDDED). With the sweep's own margin it fits the anchor's 300 s timeout.
 */
export const AUDIT_SHRED_SETTLE_MS = 35_000;
/** The event the broker sends the export function to delete an org's export files (an erasure does this). */
export const AUDIT_EXPORT_PURGE_SOURCE = "agentx.audit-export-purge";

/** The due partition is read this many items to a page, and at most this many items are looked at in one run (the rest wait for the next). */
const DUE_PAGE = 25;
const DUE_SCANNED_MAX = 500;
/** What a sweep keeps back from the function's remaining time: a step is not started unless this much would be left after it. */
export const AUDIT_SHRED_MARGIN_MS = 60_000;
/** Items per page when a partition is read to be emptied. */
const PAGE = 100;
/** A developer id as a key: letters, digits, `_`, `.` and `-`. Never `#`, a space or a newline, and never the org's own subject. */
const SUBJECT_ID = /^[A-Za-z0-9_.-]{1,100}$/;
const ORG_SUBJECT = "org";

/** Whether `value` can be the id of a person whose details are erased: not the org's own subject, not a key-shaped string. */
export const isAuditSubjectId = (value: unknown): value is string => typeof value === "string" && SUBJECT_ID.test(value) && value !== ORG_SUBJECT;
const DUE_SORT_KEY = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)#(org_[0-9a-z]+)$/;

/** Every store that can hold a person's details in plaintext, and the longest a copy lives in it (the privacy notice's list). */
export const AUDIT_DETAIL_STORES = [
  { id: "intake-queue", store: "The intake queue (SQS)", maxDays: 14, how: "Deleted when the appender appends the event; at most the queue's 14-day retention if it is stuck." },
  { id: "dead-letter-queue", store: "The intake dead-letter queue (SQS)", maxDays: 14, how: "A message that could not be appended waits here for at most the queue's 14-day retention." },
  { id: "pending-items", store: "Pending audit items (State table)", maxDays: AUDIT_PENDING_TTL_DAYS, how: "Deleted as soon as the event is sent; an item that cannot be sent is removed by the table's time to live after 14 days." },
  { id: "pending-items-backups", store: "Point-in-time recovery of the State table", maxDays: AUDIT_TRANSIENT_COPY_DAYS, how: "Keeps the table's earlier states for up to 35 days, counted from the day a pending item was deleted." },
  { id: "pending-items-stream", store: "The State table's change stream", maxDays: 1, how: "Keeps a change for 24 hours." },
  { id: "exports-bucket", store: "Export files (S3)", maxDays: AUDIT_EXPORT_FILE_LIFECYCLE_DAYS, how: "Deleted when a person is erased and when a company is shredded; otherwise by the bucket's 7-day lifecycle rule." },
  { id: "key-cache", store: "The appender's and the broker's memory", maxDays: AUDIT_KEY_CACHE_MS / 86_400_000, how: "A decrypted key stays in memory for 5 minutes. Erasure and shredding are still seen at once: they are read from the keys table on every call." },
] as const;

/**
 * How long, at the most, a copy of an erased person's details can still exist: an event that could not be delivered stays a pending
 * item for its time to live (14 days) and the State table's backups then keep it for up to 35 more. The privacy notice and the
 * answer to an erasure promise this, not the 35 days of the backups alone.
 */
export const AUDIT_COPIES_GONE_WITHIN_DAYS = AUDIT_PENDING_TTL_DAYS + AUDIT_TRANSIENT_COPY_DAYS;

/** What the response to an erasure says, so that the person who asked can pass it on. */
export function auditErasedMessage(name: string): string {
  return `${name}'s details in the audit ledger can't be read any more. Copies in queues, backups and recent exports are gone within ${String(AUDIT_COPIES_GONE_WITHIN_DAYS)} days.`;
}

const unavailable = () => agentXError("AUDIT_UNAVAILABLE", AUDIT_ERROR_MESSAGES.AUDIT_UNAVAILABLE);
const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

function checkedOrg(value: unknown): OrgId {
  const parsed = OrgIdSchema.safeParse(value);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "That is not an organization id.");
  return parsed.data;
}

// ---- one person ----------------------------------------------------------------------------------------------------------

export interface AuditEraseDeps extends AuditDeps {
  documentClient: DynamoDBDocumentClient;
  /** The keys table: the tombstone is written here. */
  keysTable: string;
  /** The State table: the pending audit item is put here, in the same transaction. */
  tableName: string;
  now: () => number;
  log: (entry: Record<string, unknown>) => void;
  /** Deletes the org's export files (they hold details in plaintext). Rejects if it could not. */
  purgeExports: (orgId: OrgId) => Promise<void>;
  /**
   * v1.2 learning loop: clears the person's learning data in every project of the org (corrections' text and GitHub id, open suggestions that hold their words). Called after the tombstone, on
   * a repeat of the request as well (the walk resumes). Rejects if it could not. REQUIRED: a production wiring that forgets it must fail to build, not skip a person's data. A test
   * that has no learning passes `noLearningToErase`.
   */
  eraseLearning: (orgId: OrgId, developerId: string) => Promise<unknown>;
}

/** For a test with no learning data: the hook that erases nothing. */
export const noLearningToErase = async (): Promise<void> => undefined;

export interface AuditEraseRequest {
  orgId: OrgId;
  /** The person's developer id: the subject of their details. */
  developerId: string;
  /** The staff member who erased. */
  by: Extract<AuditActor, { kind: "operator" }>;
  /** Why (sealed in the event's details under the org, which is shredded with it). */
  reason: string;
  /** Makes the request repeatable: the same id for one person is the same erasure. */
  requestId: string;
}

export interface AuditEraseResult {
  /** When the tombstone was written (the first time, for a repeat). */
  erasedAt: string;
  /** True when the person was already erased: nothing was recorded again, the export files were cleared again. */
  alreadyErased: boolean;
}

function isConditionFailure(error: unknown): boolean {
  if (error instanceof ConditionalCheckFailedException) return true;
  if (!(error instanceof Error) || error.name !== "TransactionCanceledException") return false;
  return (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons?.[0]?.Code === "ConditionalCheckFailed";
}

/** Whether the org has been shredded (SHREDDED in its keys partition). Read consistently. */
async function isShredded(deps: Pick<AuditEraseDeps, "documentClient" | "keysTable">, orgId: OrgId): Promise<boolean> {
  const out = await deps.documentClient.send(new GetCommand({ TableName: deps.keysTable, Key: { pk: `ORG#${orgId}`, sk: "SHREDDED" }, ConsistentRead: true }));
  return out.Item !== undefined;
}

/**
 * Erases one person's details from one org's ledger. In ONE transaction: the person's key item becomes `{ erasedAt }` (one overwriting
 * put, conditioned on there being no tombstone yet, so an earlier erasure keeps its time and is not recorded twice) and the
 * `audit.subject_erased` event is put as a pending item. Then the org's export files are deleted. The tombstone is also written for a
 * person who has no key yet, so that none is ever made. A repeat of the request, or of an erasure whose file clean-up failed, does the
 * clean-up again and records nothing new.
 */
export async function eraseAuditSubject(deps: AuditEraseDeps, request: AuditEraseRequest): Promise<AuditEraseResult> {
  const orgId = checkedOrg(request.orgId);
  const { developerId } = request;
  if (!isAuditSubjectId(developerId)) throw agentXError("CONFIG_INVALID", "That is not a person's id.");
  // A shredded org has no keys left to erase, and nothing may be written into its partition again.
  if (await isShredded(deps, orgId)) throw agentXError("NOT_FOUND", "That organization's audit details have already been deleted.");
  const erasedAt = new Date(deps.now()).toISOString();
  const event = auditSubjectErased({
    orgId,
    actor: request.by,
    occurredAt: erasedAt,
    occurrence: auditOccurrence(request.requestId, developerId),
    subject: developerId,
    details: [{ subject: ORG_SUBJECT, fields: { reason: request.reason } }],
  });
  // The erasure is recorded or it does not happen: no outbox, or an event the schema refuses, is a 503 and no tombstone.
  const pending = deps.audit === undefined ? [] : auditPending(deps, event);
  if (pending.length !== 1) throw unavailable();
  const tombstone: TransactItem = {
    Put: {
      TableName: deps.keysTable,
      Item: { pk: `ORG#${orgId}`, sk: `SUBJECT#${developerId}`, erasedAt },
      ConditionExpression: "attribute_not_exists(erasedAt)",
    },
  };
  let result: AuditEraseResult;
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [tombstone, ...pending] }));
    result = { erasedAt, alreadyErased: false };
  } catch (error) {
    if (!isConditionFailure(error)) throw error;
    const existing = await deps.documentClient.send(new GetCommand({ TableName: deps.keysTable, Key: { pk: `ORG#${orgId}`, sk: `SUBJECT#${developerId}` }, ConsistentRead: true }));
    result = { erasedAt: typeof existing.Item?.erasedAt === "string" ? existing.Item.erasedAt : erasedAt, alreadyErased: true };
  }
  if (!result.alreadyErased) await flushAuditEvents(deps, [event]);
  try {
    await deps.purgeExports(orgId);
  } catch (error) {
    deps.log({ event: "audit.erase_exports_failed", level: "error", orgId, error: errorName(error) });
    throw agentXError("RUNTIME_UNAVAILABLE", "The details are erased, but the export files could not be cleared just now. Send the same request again.");
  }
  try {
    // A missing hook is a wiring mistake: it fails here, loudly, and never reads as "nothing to erase".
    if (typeof deps.eraseLearning !== "function") throw new Error("the learning erase hook is not wired");
    await deps.eraseLearning(orgId, developerId);
  } catch (error) {
    // The error's name only: the learning items hold correction text.
    deps.log({ event: "audit.erase_learning_failed", level: "error", orgId, error: errorName(error) });
    throw agentXError("RUNTIME_UNAVAILABLE", "The details are erased, but their suggested-rule data could not be cleared just now. Send the same request again.");
  }
  return result;
}

// ---- export files --------------------------------------------------------------------------------------------------------

export interface AuditPurgeDeps {
  s3: Pick<S3Client, "send">;
  exportsBucket: string;
}

/** Deletes every export file of one org (its `<orgId>/` folder, nothing else) and says how many. */
export async function purgeAuditExports(deps: AuditPurgeDeps, orgId: string, beforePage?: () => void): Promise<number> {
  const org = checkedOrg(orgId);
  const prefix = `${org}/`;
  let deleted = 0;
  let token: string | undefined;
  do {
    beforePage?.();
    const page = await deps.s3.send(new ListObjectsV2Command({ Bucket: deps.exportsBucket, Prefix: prefix, ...(token === undefined ? {} : { ContinuationToken: token }) }));
    for (const object of page.Contents ?? []) {
      // The list was asked for the prefix; this is the second guard before a delete.
      if (object.Key === undefined || !object.Key.startsWith(prefix)) continue;
      await deps.s3.send(new DeleteObjectCommand({ Bucket: deps.exportsBucket, Key: object.Key }));
      deleted += 1;
    }
    token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
  } while (token !== undefined);
  return deleted;
}

// ---- one company ---------------------------------------------------------------------------------------------------------

/**
 * The two items for the transaction that closes an org: the State-table put of the due item (`AUDIT_SHRED_DUE`, due thirty days after
 * `closedAt`) and the `audit.org_shred_scheduled` pending item. The same close gives the same items, so a retry is harmless.
 * Nothing (an install with no ledger) when there is no outbox: there is then nothing to shred.
 */
export function scheduleAuditShred(deps: AuditDeps & { tableName: string }, input: { orgId: string; closedAt: string; actor: AuditActor }): TransactItem[] {
  if (deps.audit === undefined) return [];
  const orgId = checkedOrg(input.orgId);
  const closedMs = Date.parse(input.closedAt);
  if (Number.isNaN(closedMs)) throw new Error("scheduleAuditShred needs the time the org closed");
  const dueAt = new Date(closedMs + AUDIT_DETAILS_SHRED_AFTER_CLOSE_DAYS * 86_400_000).toISOString();
  const event = auditShredScheduled({ orgId, actor: input.actor, occurredAt: new Date(closedMs).toISOString(), occurrence: input.closedAt, shredAfterDays: AUDIT_DETAILS_SHRED_AFTER_CLOSE_DAYS });
  return [
    { Put: { TableName: deps.tableName, Item: { pk: AUDIT_SHRED_DUE_PARTITION, sk: `${dueAt}#${orgId}`, orgId, closedAt: new Date(closedMs).toISOString() } } },
    ...auditPending(deps, event),
  ];
}

export interface AuditShredDeps {
  documentClient: DynamoDBDocumentClient;
  keysTable: string;
  stateTable: string;
  s3: Pick<S3Client, "send">;
  exportsBucket: string;
  log: (entry: Record<string, unknown>) => void;
  /** Pauses (the wait after SHREDDED). Defaults to a timer. */
  sleep?: (ms: number) => Promise<void>;
  /** The clock SHREDDED is stamped with, and the settle wait is counted on. Defaults to the real one. */
  now?: () => number;
  /** How much time the function has left (Lambda's `getRemainingTimeInMillis`). Absent: no limit. A step that would not fit is deferred. */
  remainingMs?: () => number;
}

export interface AuditShredOutcome {
  /** Orgs whose shred is complete (the due item is gone). */
  shredded: OrgId[];
  /** Orgs whose shred stopped on an error (logged as `audit.shred_failed`); their due items stay for the next run. */
  failed: OrgId[];
}

interface DueShred {
  orgId: OrgId;
  sk: string;
}

/** Thrown inside a sweep when the function is about to run out of time: the org is deferred, not failed. */
class ShredDeferred extends Error {
  constructor() {
    super("the shred ran out of time");
    this.name = "ShredDeferred";
  }
}

/** The marker's time, if the org has SHREDDED (Query only: the anchor holds no GetItem on the keys table). */
async function readMarker(deps: AuditShredDeps, orgId: OrgId): Promise<string | undefined> {
  const out = await deps.documentClient.send(new QueryCommand({
    TableName: deps.keysTable,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
    ExpressionAttributeValues: { ":pk": `ORG#${orgId}`, ":sk": "SHREDDED" },
    ConsistentRead: true,
  }));
  const marker = (out.Items ?? []).find((item) => item.sk === "SHREDDED");
  if (marker === undefined) return undefined;
  return typeof marker.at === "string" ? marker.at : "";
}

/** Writes SHREDDED if it is not there (the first writer's time stays), and returns its time. */
async function writeMarker(deps: AuditShredDeps, orgId: OrgId, now: number): Promise<string> {
  const existing = await readMarker(deps, orgId);
  if (existing !== undefined) return existing;
  const at = new Date(now).toISOString();
  try {
    await deps.documentClient.send(new PutCommand({
      TableName: deps.keysTable,
      Item: { pk: `ORG#${orgId}`, sk: "SHREDDED", at },
      ConditionExpression: "attribute_not_exists(pk)",
    }));
    return at;
  } catch (error) {
    if (errorName(error) !== "ConditionalCheckFailedException") throw error;
    return (await readMarker(deps, orgId)) ?? at;
  }
}

/** Deletes every item of the org's keys partition except the marker, page by page. */
async function emptyKeysPartition(deps: AuditShredDeps, orgId: OrgId, beforePage: () => void): Promise<void> {
  const pk = `ORG#${orgId}`;
  let start: Record<string, unknown> | undefined;
  do {
    beforePage();
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.keysTable,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk },
      ConsistentRead: true,
      Limit: PAGE,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    }));
    for (const item of page.Items ?? []) {
      // The marker stays for good: without it a key would be created again. And an item of another partition is never deleted.
      if (item.pk !== pk || typeof item.sk !== "string" || item.sk === "SHREDDED") continue;
      await deps.documentClient.send(new DeleteCommand({ TableName: deps.keysTable, Key: { pk, sk: item.sk } }));
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
}

/**
 * Shreds every company whose time has come (`now` is at or past the due time in the sort key). In order: for each, the SHREDDED marker
 * is written; then ONE wait until thirty seconds have passed since the latest marker (so a key creation that began before it has
 * landed); then for each, every other item of its keys partition and its export files are deleted, and its due item last. Another
 * org's items are never read or deleted. Idempotent: a run that finds nothing due does nothing, a repeat finds the marker and no keys,
 * and a due item left behind by a crash is cleared. One company's failure is logged and does not stop the others.
 */
export async function processDueShreds(deps: AuditShredDeps, now: number): Promise<AuditShredOutcome> {
  const outcome: AuditShredOutcome = { shredded: [], failed: [] };
  const clock = deps.now ?? Date.now;
  // Whether the function could not do `needed` ms more work and still leave the margin.
  const tooLate = (needed: number): boolean => deps.remainingMs !== undefined && deps.remainingMs() < needed + AUDIT_SHRED_MARGIN_MS;
  const defer = (orgs: number): void => { deps.log({ event: "audit.shred_deferred", level: "error", orgs }); };

  // The due items, page by page: damaged items stay in the partition, and paging past them keeps the ones behind them reachable.
  const queue: DueShred[] = [];
  let scanned = 0;
  let start: Record<string, unknown> | undefined;
  do {
    const due = await deps.documentClient.send(new QueryCommand({
      TableName: deps.stateTable,
      KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
      ExpressionAttributeValues: { ":pk": AUDIT_SHRED_DUE_PARTITION, ":from": "0", ":to": `${new Date(now).toISOString()}#~` },
      Limit: DUE_PAGE,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    }));
    for (const item of due.Items ?? []) {
      scanned += 1;
      const sk = typeof item.sk === "string" ? item.sk : "";
      const parsed = OrgIdSchema.safeParse(item.orgId);
      const named = DUE_SORT_KEY.exec(sk);
      // The org comes from the item and must be the one its key names; anything else is damage, left for a person to look at.
      if (!parsed.success || named === null || named[2] !== parsed.data) {
        deps.log({ event: "audit.shred_item_invalid", level: "error", sk: sk.slice(0, 80) });
        continue;
      }
      queue.push({ orgId: parsed.data, sk });
    }
    start = due.LastEvaluatedKey;
  } while (start !== undefined && scanned < DUE_SCANNED_MAX);
  if (queue.length === 0) return outcome;
  // No time to even write the markers: leave it all for the next run.
  if (tooLate(0)) {
    defer(queue.length);
    return outcome;
  }

  // 1. The markers. After this no keyring creates a key for these orgs (it reads SHREDDED on every call). Stamped with the time of the
  // write: the 30 seconds below are counted from it.
  const markers = new Map<OrgId, string>();
  for (const { orgId } of queue) {
    try {
      markers.set(orgId, await writeMarker(deps, orgId, clock()));
    } catch (error) {
      deps.log({ event: "audit.shred_failed", level: "error", orgId, step: "marker", error: errorName(error) });
      outcome.failed.push(orgId);
    }
  }
  // 2. One wait for all of them: until AUDIT_SHRED_SETTLE_MS after the latest marker was written.
  let wait = 0;
  for (const marker of markers.values()) {
    const at = Date.parse(marker);
    wait = Math.max(wait, (Number.isNaN(at) ? clock() : at) + AUDIT_SHRED_SETTLE_MS - clock());
  }
  if (wait > 0) {
    // A wait the function cannot afford: the markers stand, and the next run (15 minutes on) sweeps without waiting.
    if (tooLate(wait)) {
      defer(markers.size);
      return outcome;
    }
    await (deps.sleep ?? ((ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); })))(wait);
  }
  // 3. The sweep.
  const swept = queue.filter(({ orgId }) => markers.has(orgId));
  for (const [index, { orgId, sk }] of swept.entries()) {
    const stop = (): void => { if (tooLate(0)) throw new ShredDeferred(); };
    try {
      stop();
      await emptyKeysPartition(deps, orgId, stop);
      await purgeAuditExports(deps, orgId, stop);
      // Only this org's due item: the delete names the org it was made for.
      await deps.documentClient.send(new DeleteCommand({
        TableName: deps.stateTable,
        Key: { pk: AUDIT_SHRED_DUE_PARTITION, sk },
        ConditionExpression: "orgId = :org",
        ExpressionAttributeValues: { ":org": orgId },
      }));
      outcome.shredded.push(orgId);
      deps.log({ event: "audit.org_shredded", orgId });
    } catch (error) {
      if (error instanceof ShredDeferred) {
        defer(swept.length - index);
        break;
      }
      deps.log({ event: "audit.shred_failed", level: "error", orgId, step: "sweep", error: errorName(error) });
      outcome.failed.push(orgId);
    }
  }
  return outcome;
}
