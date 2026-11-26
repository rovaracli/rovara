// The sealed audit log's storage (lane AL-1): the hash chain's rows, the seal and epoch state, and the conditional writes that keep both
// chains from forking when two writers race. One DynamoDB table (Cloud's State table), no update or delete anywhere in this file.
//
//   pk                          sk                      what
//   LEDGERREC#<company>         <seq, 16 digits>        one chain record, written once (`record`)
//   LEDGERHEAD#<company>        HEAD                    the chain's head: seq, hash, recordedAt. Moves forward only, in the transaction that writes the record
//   LEDGERORGS                  <company>               every company that has a chain (written with its first record)
//   RECEIPT#<install>#<company> <encoded event id>      what an append committed (audit-contracts-v1.ts receiptKeyV1), written with its record
//   SEALSTATE#<company>         <from>#<to>             a seal's progress (audit-contracts-v1.ts sealProgressKeyV1)
//   SEALTIP#<company>           TIP                     the company's last planned seal: the next seal must start after it
//   EPOCHSEAL#<epoch>           <company>               a seal planned into the epoch (the epoch's leaves)
//   EPOCHSEALED                 <epoch>                 an epoch that has at least one planned seal (written in the transaction that plans it)
//   EPOCHFENCE                  FENCE                   no seal may be planned into an epoch before this one (moves forward only)
//   EPOCHLOG                    <epoch>                 an epoch that is closed: no seal may join it any more
//   EPOCHSTATE#<epoch>          STATE                   an epoch statement's progress (audit-contracts-v1.ts epochProgressKeyV1)
//   EPOCHTIP                    TIP                     the last planned epoch: the next statement chains to it
//   EPOCHDONE                   DONE                    every epoch up to this one is timestamped
//
// Every write is conditional except two that are idempotent by construction: the company listing and the epoch-sealed marker (a plain Put of the same key
// and content). There is no update or delete expression, and no item has an `expiresAt`.
// Nothing here proves a lock or a timestamp: a seal or an epoch is "locked" or "timestamped" here only when the storage target (AL-2) and the
// timestamp source (AL-3) said so and the answer parsed (audit-sealing-ports.ts). Their IAM is not in this lane (see AL-1-DONE.md).
import { TransactWriteCommand, GetCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { AuditRecordV1Schema, type AuditRecordV1, type AuditSourceV1 } from "@agentx/contracts/audit-record-v1";
import { sealHash as sealHashOf, type OrgSealV1 } from "@agentx/contracts";
import {
  EpochProgressV1Schema, SealProgressV1Schema, epochProgressKeyV1, receiptKeyV1, sealProgressKeyV1, ReceiptAuditV1Schema,
  type EpochProgressV1, type ReceiptAuditV1, type SealProgressV1,
} from "./audit-contracts-v1.js";

type Db = Pick<DynamoDBDocumentClient, "send">;
type Key = { pk: string; sk: string };

/** The chain's head: the last committed record. `recordedAt` keeps the next record's time from going backwards. */
export type ChainHead = { seq: number; hash: string; recordedAt: string };
/** A company's last planned seal. */
export type SealTip = { toSeq: number; headHash: string; sealHash: string; epochId: string };
/** The last planned epoch statement. */
export type EpochTip = { epochId: string; statementHash: string };

/** A stored row that is not what the ledger wrote (a record that does not hash to itself, a state that does not parse, a row out of place). Nothing is read past it. */
export class AuditLedgerCorrupt extends Error {
  constructor(readonly where: string) {
    super(`the audit ledger holds a row that is not valid (${where})`);
    this.name = "AuditLedgerCorrupt";
  }
}

/** A write was cancelled for a reason that is not a failed condition (a conflict with another transaction, throttling): nothing was written and trying again is right. Not corruption. */
export class AuditStoreBusy extends Error {
  constructor(what: string) {
    super(`the audit ledger could not complete a write now (${what})`);
    this.name = "AuditStoreBusy";
  }
}

/** The chain side: what the appender needs. */
export interface AuditChainStore {
  getReceipt(source: AuditSourceV1): Promise<ReceiptAuditV1 | undefined>;
  getHead(companyId: string): Promise<ChainHead | undefined>;
  /**
   * Writes the record, moves the head, writes the receipt and (with a first record) lists the company, all or nothing.
   * "head-moved": the head is not `expectedHead` (another appender got there first): nothing was written. "receipt-exists": this event is already committed.
   */
  commitAppend(input: { record: AuditRecordV1; receipt: ReceiptAuditV1; expectedHead: ChainHead | undefined }): Promise<"committed" | "head-moved" | "receipt-exists">;
  /** Up to `limit` records of one company from `fromSeq` on, in seq order. Every row is checked against its own hash and its place. */
  readRecords(companyId: string, fromSeq: number, limit: number): Promise<AuditRecordV1[]>;
}

/** The seal side: what the sealer needs. */
export interface AuditSealStore extends AuditChainStore {
  listCompanies(): Promise<string[]>;
  getSealTip(companyId: string): Promise<SealTip | undefined>;
  getEpochTip(): Promise<EpochTip | undefined>;
  getEpochSeal(epochId: string, companyId: string): Promise<OrgSealV1 | undefined>;
  /** Every seal planned into the epoch, in company order. */
  listEpochSeals(epochId: string): Promise<OrgSealV1[]>;
  /**
   * Plans a seal: its progress row, the company's seal tip (which must still be `expected.tip`), the epoch's leaf and the epoch's sealed marker. Refused when
   * the epoch is closed or fenced off, when an epoch at or after this one is already planned, when the tip moved, or when the company already has a seal in this epoch.
   */
  planSeal(progress: SealProgressV1, expected: { tip: SealTip | undefined }): Promise<"planned" | "refused">;
  getSealProgress(companyId: string, fromSeq: number, toSeq: number): Promise<SealProgressV1 | undefined>;
  /** Replaces a progress row, only while it is in the phase `from` holds. "stale": it is not (someone else advanced it). */
  advanceSeal(from: SealProgressV1, to: SealProgressV1): Promise<"advanced" | "stale">;
  closeEpoch(epochId: string, closedAt: string): Promise<"closed" | "exists">;
  /** The epoch before which no seal may be planned (undefined: none yet). */
  getFence(): Promise<string | undefined>;
  /** From now on no seal may be planned into an epoch before `epochId`. Only moves forward; a lower id is ignored. */
  fenceBefore(epochId: string): Promise<void>;
  /** The epochs after the done pointer that have a planned seal (closed or not), oldest first. */
  listSealedEpochs(): Promise<string[]>;
  /** The closed epochs not yet done, oldest first. */
  listOpenEpochs(): Promise<string[]>;
  getEpochProgress(epochId: string): Promise<EpochProgressV1 | undefined>;
  planEpoch(progress: EpochProgressV1, expected: { tip: EpochTip | undefined }): Promise<"planned" | "refused">;
  advanceEpoch(from: EpochProgressV1, to: EpochProgressV1): Promise<"advanced" | "stale">;
  /** Moves the done pointer forward to this epoch. */
  markEpochDone(epochId: string): Promise<void>;
}

const SEQ_WIDTH = 16;
const padSeq = (seq: number): string => String(seq).padStart(SEQ_WIDTH, "0");
const LAST_SEQ_KEY = padSeq(Number.MAX_SAFE_INTEGER);

export const chainRecordKey = (companyId: string, seq: number): Key => ({ pk: `LEDGERREC#${companyId}`, sk: padSeq(seq) });
export const chainHeadKey = (companyId: string): Key => ({ pk: `LEDGERHEAD#${companyId}`, sk: "HEAD" });
export const companiesKey = (companyId: string): Key => ({ pk: "LEDGERORGS", sk: companyId });
export const sealTipKey = (companyId: string): Key => ({ pk: `SEALTIP#${companyId}`, sk: "TIP" });
export const epochSealKey = (epochId: string, companyId: string): Key => ({ pk: `EPOCHSEAL#${epochId}`, sk: companyId });
export const epochLogKey = (epochId: string): Key => ({ pk: "EPOCHLOG", sk: epochId });
export const epochTipKey: Key = { pk: "EPOCHTIP", sk: "TIP" };
export const epochFenceKey: Key = { pk: "EPOCHFENCE", sk: "FENCE" };
export const epochSealedKey = (epochId: string): Key => ({ pk: "EPOCHSEALED", sk: epochId });
export const epochDoneKey: Key = { pk: "EPOCHDONE", sk: "DONE" };

type Cancelled = { CancellationReasons?: Array<{ Code?: string }> };
/** The indexes of the transaction items whose condition failed, or undefined when the error is not a refused condition. */
function failedItems(error: unknown): number[] | undefined {
  const reasons = (error as Cancelled).CancellationReasons;
  if (reasons === undefined) return undefined;
  return reasons.flatMap((reason, index) => (reason.Code === "ConditionalCheckFailed" ? [index] : []));
}

const isConditionFailure = (error: unknown): boolean => (error as { name?: string }).name === "ConditionalCheckFailedException";
/** Two transactions touched the same item at the same instant: nothing was written, and trying again is right. */
const CONFLICT_CODES = new Set(["TransactionConflict", "TransactionInProgress"]);
const isConflict = (error: unknown): boolean =>
  ["TransactionConflictException", "TransactionInProgressException"].includes((error as { name?: string }).name ?? "")
  || ((error as Cancelled).CancellationReasons ?? []).some((reason) => CONFLICT_CODES.has(reason.Code ?? ""));

export class DynamoAuditLedgerStore implements AuditSealStore {
  constructor(private readonly db: Db, private readonly table: string) {}

  private async get(key: Key): Promise<Record<string, unknown> | undefined> {
    const { Item } = await this.db.send(new GetCommand({ TableName: this.table, Key: key, ConsistentRead: true }));
    return Item;
  }

  private async queryAll(partition: string, range?: { after?: string; between?: [string, string] }, limit?: number): Promise<Array<Record<string, unknown>>> {
    const rows: Array<Record<string, unknown>> = [];
    let start: Record<string, unknown> | undefined;
    do {
      const condition = range?.between !== undefined
        ? { KeyConditionExpression: "pk = :pk AND sk BETWEEN :lo AND :hi", ExpressionAttributeValues: { ":pk": partition, ":lo": range.between[0], ":hi": range.between[1] } }
        : range?.after !== undefined
          ? { KeyConditionExpression: "pk = :pk AND sk > :after", ExpressionAttributeValues: { ":pk": partition, ":after": range.after } }
          : { KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": partition } };
      const page = await this.db.send(new QueryCommand({
        TableName: this.table, ConsistentRead: true, ScanIndexForward: true, ...condition,
        ...(limit === undefined ? {} : { Limit: limit - rows.length }), ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      }));
      rows.push(...(page.Items ?? []));
      start = page.LastEvaluatedKey;
    } while (start !== undefined && (limit === undefined || rows.length < limit));
    return limit === undefined ? rows : rows.slice(0, limit);
  }

  async getReceipt(source: AuditSourceV1): Promise<ReceiptAuditV1 | undefined> {
    const key = receiptKeyV1(source);
    const item = await this.get(key);
    if (item === undefined) return undefined;
    const parsed = ReceiptAuditV1Schema.safeParse(item.receipt);
    if (!parsed.success) throw new AuditLedgerCorrupt("receipt");
    return parsed.data;
  }

  async getHead(companyId: string): Promise<ChainHead | undefined> {
    const item = await this.get(chainHeadKey(companyId));
    if (item === undefined) return undefined;
    const { headSeq, headHash, headRecordedAt } = item;
    if (typeof headSeq !== "number" || typeof headHash !== "string" || typeof headRecordedAt !== "string") throw new AuditLedgerCorrupt("head");
    return { seq: headSeq, hash: headHash, recordedAt: headRecordedAt };
  }

  async commitAppend(input: { record: AuditRecordV1; receipt: ReceiptAuditV1; expectedHead: ChainHead | undefined }): Promise<"committed" | "head-moved" | "receipt-exists"> {
    const { record, receipt, expectedHead } = input;
    const company = record.orgId;
    const items: NonNullable<TransactWriteCommandInput["TransactItems"]> = [
      // The record is written once: a second writer at the same seq is refused even if the head check were missing.
      { Put: { TableName: this.table, Item: { ...chainRecordKey(company, record.seq), record }, ConditionExpression: "attribute_not_exists(pk)" } },
      // The head moves forward only from the head this writer read. The first record needs no head to exist.
      expectedHead === undefined
        ? { Put: { TableName: this.table, Item: { ...chainHeadKey(company), headSeq: record.seq, headHash: record.hash, headRecordedAt: record.recordedAt }, ConditionExpression: "attribute_not_exists(pk)" } }
        : {
          Put: {
            TableName: this.table, Item: { ...chainHeadKey(company), headSeq: record.seq, headHash: record.hash, headRecordedAt: record.recordedAt },
            ConditionExpression: "headSeq = :seq AND headHash = :hash", ExpressionAttributeValues: { ":seq": expectedHead.seq, ":hash": expectedHead.hash },
          },
        },
      { Put: { TableName: this.table, Item: { ...receiptKeyV1(receipt.source), receipt }, ConditionExpression: "attribute_not_exists(pk)" } },
    ];
    if (expectedHead === undefined) items.push({ Put: { TableName: this.table, Item: { ...companiesKey(company) } } });
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: items }));
      return "committed";
    } catch (error) {
      const failed = failedItems(error);
      if (failed !== undefined) {
        // Item 2 is the receipt: that event is already committed, whatever else moved.
        if (failed.includes(2)) return "receipt-exists";
        if (failed.length > 0) return "head-moved";
      }
      // A conflict with another writer's transaction: read again, like a lost race.
      if (isConflict(error)) return "head-moved";
      throw error;
    }
  }

  async readRecords(companyId: string, fromSeq: number, limit: number): Promise<AuditRecordV1[]> {
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 1 || !Number.isSafeInteger(limit) || limit < 1) throw new RangeError("audit ledger: bad record range");
    const rows = await this.queryAll(`LEDGERREC#${companyId}`, { between: [padSeq(fromSeq), LAST_SEQ_KEY] }, limit);
    return rows.map((row, index) => {
      const parsed = AuditRecordV1Schema.safeParse(row.record);
      // A row that does not hash to itself, sits at another seq than its key, belongs to another company, or leaves a gap is corrupt: never returned.
      if (!parsed.success || row.sk !== padSeq(parsed.data.seq) || parsed.data.orgId !== companyId || parsed.data.seq !== fromSeq + index) {
        throw new AuditLedgerCorrupt(`record ${fromSeq + index}`);
      }
      return parsed.data;
    });
  }

  async listCompanies(): Promise<string[]> {
    return (await this.queryAll("LEDGERORGS")).map((row) => String(row.sk));
  }

  async getSealTip(companyId: string): Promise<SealTip | undefined> {
    const item = await this.get(sealTipKey(companyId));
    if (item === undefined) return undefined;
    const { sealedToSeq, sealedHeadHash, sealHash, sealEpochId } = item;
    if (typeof sealedToSeq !== "number" || typeof sealedHeadHash !== "string" || typeof sealHash !== "string" || typeof sealEpochId !== "string") throw new AuditLedgerCorrupt("seal tip");
    return { toSeq: sealedToSeq, headHash: sealedHeadHash, sealHash, epochId: sealEpochId };
  }

  async getEpochTip(): Promise<EpochTip | undefined> {
    const item = await this.get(epochTipKey);
    if (item === undefined) return undefined;
    if (typeof item.tipEpochId !== "string" || typeof item.tipStatementHash !== "string") throw new AuditLedgerCorrupt("epoch tip");
    return { epochId: item.tipEpochId, statementHash: item.tipStatementHash };
  }

  async getEpochSeal(epochId: string, companyId: string): Promise<OrgSealV1 | undefined> {
    const item = await this.get(epochSealKey(epochId, companyId));
    return item === undefined ? undefined : readSeal(item, epochId, companyId);
  }

  async listEpochSeals(epochId: string): Promise<OrgSealV1[]> {
    return (await this.queryAll(`EPOCHSEAL#${epochId}`)).map((item) => readSeal(item, epochId, String(item.sk)));
  }

  async planSeal(progress: SealProgressV1, expected: { tip: SealTip | undefined }): Promise<"planned" | "refused"> {
    if (progress.phase !== "planned") throw new TypeError("audit ledger: a seal is planned in the planned phase");
    const { companyId, checkpoint } = progress;
    const seal: OrgSealV1 = {
      v: 1, orgId: companyId, fromSeq: checkpoint.fromSeq, toSeq: checkpoint.toSeq, batchRoot: progress.batchRoot,
      headHash: checkpoint.headHash, prevSealHash: checkpoint.prevSealHash, epochId: checkpoint.epochId,
    };
    const tip = { sealedToSeq: checkpoint.toSeq, sealedHeadHash: checkpoint.headHash, sealHash: sealHashOf(seal), sealEpochId: checkpoint.epochId };
    try {
      await this.db.send(new TransactWriteCommand({
        TransactItems: [
          // The epoch is still open: a seal planned into a closed epoch would be missing from its statement.
          { ConditionCheck: { TableName: this.table, Key: epochLogKey(checkpoint.epochId), ConditionExpression: "attribute_not_exists(pk)" } },
          // No epoch at or after this one is planned: epochs are planned in order, so this seal's epoch is still ahead of the statements.
          { ConditionCheck: { TableName: this.table, Key: epochTipKey, ConditionExpression: "attribute_not_exists(pk) OR tipEpochId < :epoch", ExpressionAttributeValues: { ":epoch": checkpoint.epochId } } },
          // Not fenced off: a tick for a later epoch has closed the door on this one (see fenceBefore).
          { ConditionCheck: { TableName: this.table, Key: epochFenceKey, ConditionExpression: "attribute_not_exists(pk) OR fenceEpochId <= :epoch", ExpressionAttributeValues: { ":epoch": checkpoint.epochId } } },
          // The epoch now has a seal, so a later tick knows to close it even if this writer never does.
          { Put: { TableName: this.table, Item: { ...epochSealedKey(checkpoint.epochId) } } },
          // The company's seals form one chain: this seal starts where the tip this writer read ended.
          expected.tip === undefined
            ? { Put: { TableName: this.table, Item: { ...sealTipKey(companyId), ...tip }, ConditionExpression: "attribute_not_exists(pk)" } }
            : {
              Put: {
                TableName: this.table, Item: { ...sealTipKey(companyId), ...tip },
                ConditionExpression: "sealedToSeq = :to AND sealHash = :hash", ExpressionAttributeValues: { ":to": expected.tip.toSeq, ":hash": expected.tip.sealHash },
              },
            },
          { Put: { TableName: this.table, Item: { ...sealProgressKeyV1(companyId, checkpoint.fromSeq, checkpoint.toSeq), progress }, ConditionExpression: "attribute_not_exists(pk)" } },
          // One seal for a company in an epoch.
          { Put: { TableName: this.table, Item: { ...epochSealKey(checkpoint.epochId, companyId), seal }, ConditionExpression: "attribute_not_exists(pk)" } },
        ],
      }));
      return "planned";
    } catch (error) {
      const failed = failedItems(error);
      if (failed === undefined) throw error;
      // Only a failed condition is a refusal. A conflict or throttling cancelled the transaction without one: busy, try again.
      if (failed.length === 0) throw new AuditStoreBusy("transaction cancelled");
      return "refused";
    }
  }

  async getSealProgress(companyId: string, fromSeq: number, toSeq: number): Promise<SealProgressV1 | undefined> {
    const item = await this.get(sealProgressKeyV1(companyId, fromSeq, toSeq));
    if (item === undefined) return undefined;
    const parsed = SealProgressV1Schema.safeParse(item.progress);
    if (!parsed.success || parsed.data.companyId !== companyId || parsed.data.checkpoint.fromSeq !== fromSeq || parsed.data.checkpoint.toSeq !== toSeq) throw new AuditLedgerCorrupt("seal progress");
    return parsed.data;
  }

  async advanceSeal(from: SealProgressV1, to: SealProgressV1): Promise<"advanced" | "stale"> {
    if (from.companyId !== to.companyId || from.checkpoint.fromSeq !== to.checkpoint.fromSeq || from.checkpoint.toSeq !== to.checkpoint.toSeq || from.batchRoot !== to.batchRoot) {
      throw new TypeError("audit ledger: a seal's range and root are fixed");
    }
    return this.advance(sealProgressKeyV1(to.companyId, to.checkpoint.fromSeq, to.checkpoint.toSeq), to, from.phase);
  }

  async closeEpoch(epochId: string, closedAt: string): Promise<"closed" | "exists"> {
    try {
      await this.db.send(new PutCommand({ TableName: this.table, Item: { ...epochLogKey(epochId), closedAt }, ConditionExpression: "attribute_not_exists(pk)" }));
      return "closed";
    } catch (error) {
      if (isConditionFailure(error)) return "exists";
      throw error;
    }
  }

  async getFence(): Promise<string | undefined> {
    const item = await this.get(epochFenceKey);
    if (item === undefined) return undefined;
    if (typeof item.fenceEpochId !== "string") throw new AuditLedgerCorrupt("epoch fence");
    return item.fenceEpochId;
  }

  async fenceBefore(epochId: string): Promise<void> {
    try {
      await this.db.send(new PutCommand({
        TableName: this.table, Item: { ...epochFenceKey, fenceEpochId: epochId },
        ConditionExpression: "attribute_not_exists(pk) OR fenceEpochId < :epoch", ExpressionAttributeValues: { ":epoch": epochId },
      }));
    } catch (error) {
      // Already at or past this epoch.
      if (!isConditionFailure(error)) throw error;
    }
  }

  async listSealedEpochs(): Promise<string[]> {
    return this.epochsAfterDone("EPOCHSEALED");
  }

  async listOpenEpochs(): Promise<string[]> {
    return this.epochsAfterDone("EPOCHLOG");
  }

  private async epochsAfterDone(partition: string): Promise<string[]> {
    const done = await this.get(epochDoneKey);
    const after = done === undefined ? undefined : done.doneEpochId;
    if (done !== undefined && typeof after !== "string") throw new AuditLedgerCorrupt("epoch done pointer");
    const rows = await this.queryAll(partition, after === undefined ? undefined : { after: after as string });
    return rows.map((row) => String(row.sk));
  }

  async getEpochProgress(epochId: string): Promise<EpochProgressV1 | undefined> {
    const item = await this.get(epochProgressKeyV1(epochId));
    if (item === undefined) return undefined;
    const parsed = EpochProgressV1Schema.safeParse(item.progress);
    if (!parsed.success || parsed.data.epochId !== epochId) throw new AuditLedgerCorrupt("epoch progress");
    return parsed.data;
  }

  async planEpoch(progress: EpochProgressV1, expected: { tip: EpochTip | undefined }): Promise<"planned" | "refused"> {
    if (progress.phase !== "planned") throw new TypeError("audit ledger: an epoch is planned in the planned phase");
    const tip = { tipEpochId: progress.epochId, tipStatementHash: progress.statementHash };
    try {
      await this.db.send(new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: this.table, Item: { ...epochProgressKeyV1(progress.epochId), progress }, ConditionExpression: "attribute_not_exists(pk)" } },
          // The statements form one chain: this one chains to the tip this writer read.
          expected.tip === undefined
            ? { Put: { TableName: this.table, Item: { ...epochTipKey, ...tip }, ConditionExpression: "attribute_not_exists(pk)" } }
            : {
              Put: {
                TableName: this.table, Item: { ...epochTipKey, ...tip },
                ConditionExpression: "tipEpochId = :epoch AND tipStatementHash = :hash", ExpressionAttributeValues: { ":epoch": expected.tip.epochId, ":hash": expected.tip.statementHash },
              },
            },
          // Closed: a statement is planned only from an epoch no seal can still join.
          { ConditionCheck: { TableName: this.table, Key: epochLogKey(progress.epochId), ConditionExpression: "attribute_exists(pk)" } },
        ],
      }));
      return "planned";
    } catch (error) {
      const failed = failedItems(error);
      if (failed === undefined) throw error;
      // Only a failed condition is a refusal. A conflict or throttling cancelled the transaction without one: busy, try again.
      if (failed.length === 0) throw new AuditStoreBusy("transaction cancelled");
      return "refused";
    }
  }

  async advanceEpoch(from: EpochProgressV1, to: EpochProgressV1): Promise<"advanced" | "stale"> {
    if (from.epochId !== to.epochId || from.statementHash !== to.statementHash) throw new TypeError("audit ledger: an epoch statement is fixed");
    return this.advance(epochProgressKeyV1(to.epochId), to, from.phase);
  }

  async markEpochDone(epochId: string): Promise<void> {
    try {
      await this.db.send(new PutCommand({
        TableName: this.table, Item: { ...epochDoneKey, doneEpochId: epochId },
        ConditionExpression: "attribute_not_exists(pk) OR doneEpochId < :epoch", ExpressionAttributeValues: { ":epoch": epochId },
      }));
    } catch (error) {
      // Already at or past this epoch.
      if (!isConditionFailure(error)) throw error;
    }
  }

  private async advance(key: Key, to: SealProgressV1 | EpochProgressV1, fromPhase: string): Promise<"advanced" | "stale"> {
    try {
      await this.db.send(new PutCommand({
        TableName: this.table, Item: { ...key, progress: to },
        ConditionExpression: "#progress.#phase = :phase", ExpressionAttributeNames: { "#progress": "progress", "#phase": "phase" }, ExpressionAttributeValues: { ":phase": fromPhase },
      }));
      return "advanced";
    } catch (error) {
      if (isConditionFailure(error)) return "stale";
      throw error;
    }
  }
}

const HEX64 = /^[0-9a-f]{64}$/u;
/** A seal row, checked: its key says the epoch and company, and every field is the shape the verifier reads. */
function readSeal(item: Record<string, unknown>, epochId: string, companyId: string): OrgSealV1 {
  const seal = item.seal as Partial<OrgSealV1> | undefined;
  if (
    seal === undefined || seal.v !== 1 || seal.orgId !== companyId || seal.epochId !== epochId || item.pk !== `EPOCHSEAL#${epochId}`
    || !Number.isSafeInteger(seal.fromSeq) || !Number.isSafeInteger(seal.toSeq) || (seal.fromSeq as number) < 1 || (seal.toSeq as number) < (seal.fromSeq as number)
    || ![seal.batchRoot, seal.headHash, seal.prevSealHash].every((hash) => typeof hash === "string" && HEX64.test(hash))
  ) throw new AuditLedgerCorrupt("epoch seal");
  return seal as OrgSealV1;
}
