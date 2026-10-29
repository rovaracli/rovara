// The only writer of the audit chain. One org's events arrive one at a time (the intake queue is FIFO with the org as its
// message group), and a conditional head makes a fork impossible even when a message is redelivered while its first
// delivery is still running or the drain and the flush both sent it:
//   AUDIT#<org> SEQ#<12 digits>   the record, plus `sealedDetails` (ciphertext, not part of the hash)
//   AUDIT#<org> HEAD              { seq, hash, updatedAt }
//   AUDIT#<org> EVENT#<eventId>   { seq }: the claim that makes an event append once
//   AUDIT_DIRTY <org>             { since, lastSeq }: an org with records the anchor has not sealed (C2)
//   AUDIT#<org> FILTER#v1#...    canonical metadata postings and contiguous coverage; retained after erase/shred
//   AUDIT_ORGS  <org>             written once, with the org's first record
import { TransactWriteCommand, GetCommand, type DynamoDBDocumentClient, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { genesisHash, recordHash, type AuditDetailPart, type AuditEventInput, type AuditRecordV1 } from "@agentx/contracts";
import { AUDIT_INDEX_COVERAGE, auditIndexPostings } from "./search-index.js";
import type { AuditKeyring } from "./keyring.js";

/** A conflict or a lost race is retried this many times after the first attempt, then the message is left to SQS. */
export const AUDIT_APPEND_MAX_RETRIES = 5;
/** The wait before retrying a TransactionConflict doubles from this, up to the cap. */
const CONFLICT_BACKOFF_MS = 25;
const CONFLICT_BACKOFF_MAX_MS = 1000;

export interface AppenderDeps {
  /** The appender's own client; it is granted the ledger and keys tables only. */
  documentClient: DynamoDBDocumentClient;
  ledgerTable: string;
  keyring: AuditKeyring;
  now: () => number;
  log: (entry: Record<string, unknown>) => void;
  /** Pauses before a retry after a TransactionConflict. Defaults to a timer. */
  sleep?: (ms: number) => Promise<void>;
}

export type AppendResult = "appended" | "duplicate";

export function auditSeqSortKey(seq: number): string {
  return `SEQ#${String(seq).padStart(12, "0")}`;
}

type Reason = { Code?: string };
type Outcome = { kind: "appended"; seq: number } | { kind: "duplicate" } | { kind: "retry"; wait: boolean };

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

/** The index of each item in the transaction, so a cancellation reason can be read back to the item that caused it. */
const CLAIM_INDEX = 2;

/**
 * What a cancelled transaction means. The claim failing is a duplicate whatever else failed (a redelivery fails every
 * condition at once). A failed record or head condition means another append won the sequence number: read again. A
 * TransactionConflict is another transaction touching one of the items right now (the anchor clearing the marker, or the
 * same org's other append): wait a little and read again. Anything else is not for this function to guess about.
 */
function classify(error: unknown): Outcome | undefined {
  const name = errorName(error);
  if (name === "TransactionConflictException") return { kind: "retry", wait: true };
  if (name !== "TransactionCanceledException") return undefined;
  const reasons = (error as { CancellationReasons?: Reason[] }).CancellationReasons;
  if (reasons === undefined) return undefined;
  if (reasons[CLAIM_INDEX]?.Code === "ConditionalCheckFailed") return { kind: "duplicate" };
  const codes = reasons.map((reason) => reason.Code);
  if (codes.includes("TransactionConflict")) return { kind: "retry", wait: true };
  if (codes.slice(0, CLAIM_INDEX).includes("ConditionalCheckFailed")) return { kind: "retry", wait: false };
  return undefined;
}

/**
 * The parts to seal for an event: its own, one per subject (two parts of one subject merge, so a subject has one
 * commitment), and, for a name-keyed target, the name as `targetName` in the `org` part. The name is why the target is
 * pseudonymized in the chain: it is recoverable only while the org's keys exist.
 */
export function auditDetailParts(event: AuditEventInput): AuditDetailPart[] {
  const parts = new Map<string, Record<string, string>>();
  for (const part of event.details ?? []) parts.set(part.subject, { ...(parts.get(part.subject) ?? {}), ...part.fields });
  if ("name" in event.target) parts.set("org", { ...(parts.get("org") ?? {}), targetName: event.target.name });
  return [...parts].map(([subject, fields]) => ({ subject, fields }));
}

function buildTransaction(deps: AppenderDeps, event: AuditEventInput, built: { seq: number; record: AuditRecordV1; sealedDetails: unknown[] }, prev: { seq: number; hash: string }, advanceCoverage: boolean): TransactWriteCommandInput["TransactItems"] {
  const { ledgerTable: TableName } = deps;
  const { seq, record } = built;
  const pk = `AUDIT#${event.orgId}`;
  const updatedAt = record.recordedAt;
  const first = prev.seq === 0;
  return [
    {
      Put: {
        TableName,
        Item: { pk, sk: auditSeqSortKey(seq), ...record, ...(built.sealedDetails.length === 0 ? {} : { sealedDetails: built.sealedDetails }) },
        ConditionExpression: "attribute_not_exists(pk)",
      },
    },
    first
      ? { Put: { TableName, Item: { pk, sk: "HEAD", seq, hash: record.hash, updatedAt }, ConditionExpression: "attribute_not_exists(pk)" } }
      : {
        Update: {
          TableName,
          Key: { pk, sk: "HEAD" },
          UpdateExpression: "SET #seq = :seq, #hash = :hash, #updatedAt = :updatedAt",
          ConditionExpression: "#seq = :prev AND #hash = :prevHash",
          ExpressionAttributeNames: { "#seq": "seq", "#hash": "hash", "#updatedAt": "updatedAt" },
          ExpressionAttributeValues: { ":seq": seq, ":hash": record.hash, ":updatedAt": updatedAt, ":prev": prev.seq, ":prevHash": prev.hash },
        },
      },
    { Put: { TableName, Item: { pk, sk: `EVENT#${event.eventId}`, seq }, ConditionExpression: "attribute_not_exists(pk)" } },
    {
      Update: {
        TableName,
        Key: { pk: "AUDIT_DIRTY", sk: event.orgId },
        UpdateExpression: "SET #since = if_not_exists(#since, :seq), #lastSeq = :seq",
        ExpressionAttributeNames: { "#since": "since", "#lastSeq": "lastSeq" },
        ExpressionAttributeValues: { ":seq": seq },
      },
    },
    ...(first ? [{ Put: { TableName, Item: { pk: "AUDIT_ORGS", sk: event.orgId, createdAt: updatedAt } } }] : []),
    ...auditIndexPostings(record).map(Item => ({ Put: { TableName, Item, ConditionExpression: "attribute_not_exists(pk)" } })),
    ...(advanceCoverage ? [{ Put: {
      TableName, Item: { pk, sk: AUDIT_INDEX_COVERAGE, v: 1, orgId: event.orgId, fromSeq: 1, throughSeq: seq },
      ConditionExpression: first ? "attribute_not_exists(pk)" : "#through = :prev",
      ...(first ? {} : { ExpressionAttributeNames: { "#through": "throughSeq" }, ExpressionAttributeValues: { ":prev": prev.seq } }),
    } }] : []),
  ];
}

/** Appends one event and says which sequence number it got. See `appendOne`. */
export async function appendEvent(deps: AppenderDeps, event: AuditEventInput): Promise<{ result: AppendResult; seq?: number }> {
  const { documentClient, ledgerTable } = deps;
  const pk = `AUDIT#${event.orgId}`;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));

  // A redelivery or a second send finds its claim here and costs one read: no record is built, no key is made.
  const claim = await documentClient.send(new GetCommand({ TableName: ledgerTable, Key: { pk, sk: `EVENT#${event.eventId}` }, ConsistentRead: true }));
  if (claim.Item !== undefined) return { result: "duplicate" };

  const target = "id" in event.target
    ? { kind: event.target.kind, id: event.target.id }
    : { kind: event.target.kind, id: await deps.keyring.pseudonym(event.orgId, event.target.kind, event.target.name) };
  const parts = auditDetailParts(event);
  await deps.keyring.prepareCursorKey(event.orgId);

  for (let attempt = 0; ; attempt += 1) {
    const head = await documentClient.send(new GetCommand({ TableName: ledgerTable, Key: { pk, sk: "HEAD" }, ConsistentRead: true }));
    const prev = head.Item === undefined
      ? { seq: 0, hash: genesisHash(event.orgId) }
      : { seq: head.Item.seq as unknown, hash: head.Item.hash as unknown };
    if (typeof prev.seq !== "number" || !Number.isSafeInteger(prev.seq) || typeof prev.hash !== "string") throw new Error("audit append: the head is malformed");
    const coverage = await documentClient.send(new GetCommand({ TableName: ledgerTable, Key: { pk, sk: AUDIT_INDEX_COVERAGE }, ConsistentRead: true }));
    const advanceCoverage = prev.seq === 0 || (coverage.Item?.v === 1 && coverage.Item.orgId === event.orgId && coverage.Item.fromSeq === 1 && coverage.Item.throughSeq === prev.seq);
    const seq = prev.seq + 1;
    const sealed = await deps.keyring.sealDetails(event.orgId, seq, parts);
    const unhashed: Omit<AuditRecordV1, "hash"> = {
      v: 1,
      orgId: event.orgId,
      seq,
      eventId: event.eventId,
      action: event.action,
      actor: { kind: event.actor.kind, id: event.actor.id },
      target,
      occurredAt: event.occurredAt,
      recordedAt: new Date(deps.now()).toISOString(),
      related: event.related ?? [],
      facts: event.facts ?? {},
      ...(event.proof === undefined ? {} : { proof: event.proof }),
      details: sealed.commits,
      prevHash: prev.hash,
    };
    const record: AuditRecordV1 = { ...unhashed, hash: recordHash(unhashed) };

    let outcome: Outcome;
    try {
      await documentClient.send(new TransactWriteCommand({ TransactItems: buildTransaction(deps, event, { seq, record, sealedDetails: sealed.sealed }, { seq: prev.seq, hash: prev.hash }, advanceCoverage) }));
      outcome = { kind: "appended", seq };
    } catch (error) {
      const reasons = (error as { CancellationReasons?: Reason[] } | null | undefined)?.CancellationReasons;
      const coverageRace = advanceCoverage && reasons?.at(-1)?.Code === "ConditionalCheckFailed";
      const classified = classify(error) ?? (coverageRace ? { kind: "retry" as const, wait: false } : undefined);
      if (classified === undefined) throw error;
      outcome = classified;
    }
    if (outcome.kind === "appended") return { result: "appended", seq: outcome.seq };
    if (outcome.kind === "duplicate") return { result: "duplicate" };
    if (attempt >= AUDIT_APPEND_MAX_RETRIES) {
      // The message goes back to the queue (and, after its receives, to the dead-letter queue and its alarm).
      throw Object.assign(new Error(`audit append: gave up after ${String(attempt + 1)} attempts`), { name: "AuditAppendContention" });
    }
    if (outcome.wait) await sleep(Math.min(CONFLICT_BACKOFF_MAX_MS, CONFLICT_BACKOFF_MS * 2 ** attempt));
  }
}

/**
 * Appends `event` to its org's chain: reads the head, builds the record (a name-keyed target becomes a pseudonym and its
 * name moves into the sealed `org` details), and commits record, head, claim, dirty marker, postings and contiguous coverage in one transaction.
 * `duplicate` when the event's claim exists already. A lost race for the sequence number, or a TransactionConflict, is
 * retried with a fresh read, at most five times; then it throws and SQS delivers the message again.
 */
export async function appendOne(deps: AppenderDeps, event: AuditEventInput): Promise<AppendResult> {
  return (await appendEvent(deps, event)).result;
}
