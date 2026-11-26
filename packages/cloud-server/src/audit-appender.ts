// The audit log's appender (lane AL-1): turns one pending item into the next record of its company's hash chain and commits it with its receipt.
// Each record commits to the one before it (`prevHash`), so changing, removing or reordering a stored record breaks every later hash; the existing
// offline verifier (`checkChain`) recomputes exactly what is written here. Two appenders racing cannot fork the chain: the commit is conditional on the head
// the appender read (audit-ledger-store.ts), and the loser re-reads and takes the next position.
//
// This does not authenticate who sent the pending item (audit-contracts-v1.md: AUD-3 enablement gate) and does not seal anything (audit-sealer.ts).
import { genesisHash } from "@agentx/contracts";
import { encodeAuditEventIdV1, type AuditRecordV1 } from "@agentx/contracts/audit-record-v1";
import { PendingAuditV1Schema, materializeAuditRecordV1, type PendingAuditV1, type ReceiptAuditV1 } from "./audit-contracts-v1.js";
import type { AuditChainStore, ChainHead } from "./audit-ledger-store.js";

/** The same event identity arrived with a different facts digest: nothing was written. Fixed words, never the offending values. (Only identity and digest are compared; the digest commits to the raw source, and the item is not authenticated, see AUD-3.) */
export class AuditAppendRefused extends Error {
  constructor() {
    super("audit append: this event was already committed with a different facts digest");
    this.name = "AuditAppendRefused";
  }
}

/** The head kept moving under every attempt. Nothing was written; the caller may try again (the queue redelivers). */
export class AuditAppendContended extends Error {
  constructor() {
    super("audit append: the chain's head kept moving, nothing was written");
    this.name = "AuditAppendContended";
  }
}

export type AppendResult =
  | { outcome: "appended"; record: AuditRecordV1; receipt: ReceiptAuditV1 }
  | { outcome: "already-appended"; receipt: ReceiptAuditV1 };

export type AppenderOptions = { now?: () => Date; maxAttempts?: number; /** Waits between attempts (default: a short random wait that grows with the attempt, so writers that collided do not collide again). */ pause?: (ms: number) => Promise<void> };

export class AuditAppender {
  private readonly now: () => Date;
  private readonly maxAttempts: number;
  private readonly pause: (ms: number) => Promise<void>;

  constructor(private readonly store: AuditChainStore, options: AppenderOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.maxAttempts = options.maxAttempts ?? 8;
    this.pause = options.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Appends the item, or says it already was. Repeating a call is harmless: one event identity is one record. */
  async append(input: unknown): Promise<AppendResult> {
    const pending: PendingAuditV1 = PendingAuditV1Schema.parse(input);
    const companyId = pending.event.orgId;
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const existing = await this.store.getReceipt(pending.source);
      if (existing !== undefined) return this.alreadyAppended(pending, existing);

      const head = await this.store.getHead(companyId);
      const record = materializeAuditRecordV1(
        { source: pending.source, factsDigest: pending.factsDigest, event: pending.event },
        {
          seq: head === undefined ? 1 : head.seq + 1,
          // Never before the record it follows, even if this server's clock is behind: the sealer cuts a segment by time and relies on recordedAt not going backwards.
          recordedAt: this.recordedAt(head),
          prevHash: head === undefined ? genesisHash(companyId) : head.hash,
        },
      );
      const receipt: ReceiptAuditV1 = {
        v: 1, kind: "receipt", source: pending.source, factsDigest: pending.factsDigest,
        seq: record.seq, recordHash: record.hash, committedAt: record.recordedAt,
      };
      const result = await this.store.commitAppend({ record, receipt, expectedHead: head });
      if (result === "committed") return { outcome: "appended", record, receipt };
      // "receipt-exists" and "head-moved" (a lost race or a conflict with another writer's transaction) both mean: wait a little, then read again.
      await this.pause(Math.random() * 10 * (attempt + 1));
    }
    throw new AuditAppendContended();
  }

  private recordedAt(head: ChainHead | undefined): string {
    const now = this.now().toISOString();
    return head !== undefined && Date.parse(head.recordedAt) > Date.parse(now) ? head.recordedAt : now;
  }

  private alreadyAppended(pending: PendingAuditV1, receipt: ReceiptAuditV1): AppendResult {
    if (receipt.factsDigest !== pending.factsDigest || encodeAuditEventIdV1(receipt.source) !== pending.event.eventId) throw new AuditAppendRefused();
    return { outcome: "already-appended", receipt };
  }
}
