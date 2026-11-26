// The audit log's sealer (lane AL-1): every five minutes (AUDIT_SEAL_INTERVAL_MINUTES) it closes a segment of each company's chain into a seal, gathers the
// seals into an epoch statement chained to the last one, and drives both through the storage target and the timestamp source (audit-sealing-ports.ts).
//
// A tick, for the epoch that ends at the last five-minute boundary:
//   1. each company with records up to that boundary that no seal covers gets a seal planned (range, Merkle root, head, link to its last seal), after the
//      sealer re-checks that range against the chain (`checkChain`): a stored record that was changed is refused, never sealed;
//   2. the epoch is closed (no seal can join it), its statement is planned from the seals in it and chained to the previous statement;
//   3. every closed epoch not yet done is advanced as far as the ports allow: seal batch and seal locked, statement locked, token received, token locked.
// Every step is written before the next and resumed from what is stored, so a sealer that stops anywhere is picked up by the next tick, and two sealers
// racing give one seal chain and one epoch chain (conditional writes in audit-ledger-store.ts).
//
// The seals and statements are in the format the offline verifier checks. With the ports unconfigured nothing is locked or timestamped and every seal stays
// "planned": this module claims nothing it did not do.
import { createHash } from "node:crypto";
import {
  AUDIT_MAX_RECORDS_PER_ORG_EPOCH, AUDIT_SEAL_INTERVAL_MINUTES, auditCanonicalJson, checkChain, genesisHash, merkleRoot, recordLeafData, sealLeafData, statementHash,
  type EpochStatementV1, type OrgSealV1,
} from "@agentx/contracts";
import type { AuditRecordV1 } from "@agentx/contracts/audit-record-v1";
import {
  EpochProgressV1Schema, LockedEvidenceV1Schema, SealProgressV1Schema, type EpochProgressV1, type SealProgressV1,
} from "./audit-contracts-v1.js";
import type { AuditSealStore, EpochTip, SealTip } from "./audit-ledger-store.js";
import { AuditLedgerCorrupt } from "./audit-ledger-store.js";
import type { AuditLockedStorage, AuditTimestampSource, LockedEvidenceV1, LockedObjectWrite } from "./audit-sealing-ports.js";

/** A range that is about to be sealed does not check against the chain (or no longer matches what was planned). Nothing is sealed or locked. */
export class AuditSealRefused extends Error {
  constructor(readonly companyId: string, readonly problem: string) {
    super(`audit seal: company ${companyId} was not sealed (${problem})`);
    this.name = "AuditSealRefused";
  }
}

export type SealTickReport = {
  epochId: string;
  /** Seals planned by this tick. */
  planned: Array<{ companyId: string; fromSeq: number; toSeq: number }>;
  /** Steps that did not happen, with the reason. A refusal here (a corrupt chain) needs a person; a port error is retried by the next tick. */
  blocked: Array<{ what: string; reason: string; refused: boolean }>;
  /** Epochs now timestamped and done. */
  completedEpochs: string[];
};

export type SealerOptions = { now?: () => Date; intervalMinutes?: number; maxRecordsPerSeal?: number };

const pad = (n: number): string => String(n).padStart(2, "0");

/** `e20261125T2205Z`: the epoch that closed at this instant (a whole interval). */
export function epochIdOf(closedAt: Date): string {
  return `e${closedAt.getUTCFullYear()}${pad(closedAt.getUTCMonth() + 1)}${pad(closedAt.getUTCDate())}T${pad(closedAt.getUTCHours())}${pad(closedAt.getUTCMinutes())}Z`;
}

/** The instant an epoch id names. */
export function closedAtOfEpoch(epochId: string): Date {
  const match = /^e(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z$/u.exec(epochId);
  if (match === null) throw new TypeError("audit seal: not an epoch id");
  const [y, mo, d, h, mi] = match.slice(1).map(Number) as [number, number, number, number, number];
  return new Date(Date.UTC(y, mo - 1, d, h, mi));
}

/** The last interval boundary at or before `now`. */
export function lastBoundary(now: Date, intervalMinutes: number): Date {
  const ms = intervalMinutes * 60_000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const sealOf = (progress: SealProgressV1): OrgSealV1 => ({
  v: 1, orgId: progress.companyId, fromSeq: progress.checkpoint.fromSeq, toSeq: progress.checkpoint.toSeq, batchRoot: progress.batchRoot,
  headHash: progress.checkpoint.headHash, prevSealHash: progress.checkpoint.prevSealHash, epochId: progress.checkpoint.epochId,
});
const range16 = (from: number, to: number): string => `${String(from).padStart(16, "0")}-${String(to).padStart(16, "0")}`;
const reason = (error: unknown): string => (error instanceof Error ? error.name : "error");

export class AuditSealer {
  private readonly now: () => Date;
  private readonly interval: number;
  private readonly maxPerSeal: number;

  constructor(
    private readonly store: AuditSealStore,
    private readonly storage: AuditLockedStorage,
    private readonly timestamps: AuditTimestampSource,
    options: SealerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.interval = options.intervalMinutes ?? AUDIT_SEAL_INTERVAL_MINUTES;
    this.maxPerSeal = options.maxRecordsPerSeal ?? AUDIT_MAX_RECORDS_PER_ORG_EPOCH;
  }

  async tick(): Promise<SealTickReport> {
    const boundary = lastBoundary(this.now(), this.interval);
    const epochId = epochIdOf(boundary);
    const report: SealTickReport = { epochId, planned: [], blocked: [], completedEpochs: [] };

    await this.planSeals(epochId, boundary, report);
    if ((await this.store.listEpochSeals(epochId)).length > 0) await this.store.closeEpoch(epochId, boundary.toISOString());
    await this.advanceEpochs(report);
    return report;
  }

  private async planSeals(epochId: string, boundary: Date, report: SealTickReport): Promise<void> {
    // A later epoch is already planned: this tick is late, its records go into a later epoch.
    const epochTip = await this.store.getEpochTip();
    if (epochTip !== undefined && epochTip.epochId >= epochId) return;
    for (const companyId of (await this.store.listCompanies()).sort()) {
      try {
        await this.planSealFor(companyId, epochId, boundary, report);
      } catch (error) {
        report.blocked.push({ what: `plan seal ${companyId}`, reason: reason(error), refused: error instanceof AuditSealRefused || error instanceof AuditLedgerCorrupt });
      }
    }
  }

  private async planSealFor(companyId: string, epochId: string, boundary: Date, report: SealTickReport): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if ((await this.store.getEpochSeal(epochId, companyId)) !== undefined) return;
      const head = await this.store.getHead(companyId);
      const tip: SealTip | undefined = await this.store.getSealTip(companyId);
      const fromSeq = (tip?.toSeq ?? 0) + 1;
      if (head === undefined || head.seq < fromSeq) return;

      const read = await this.store.readRecords(companyId, fromSeq, Math.min(this.maxPerSeal, head.seq - fromSeq + 1));
      // recordedAt never goes backwards along a chain (the appender), so the segment is the leading records up to the boundary.
      const firstLate = read.findIndex((record) => Date.parse(record.recordedAt) > boundary.getTime());
      const inSegment = firstLate === -1 ? read : read.slice(0, firstLate);
      if (inSegment.length === 0) return;

      const check = checkChain(inSegment, { seq: fromSeq - 1, hash: tip?.headHash ?? genesisHash(companyId), orgId: companyId });
      if (!check.ok) throw new AuditSealRefused(companyId, `${check.problem} at seq ${check.seq}`);

      const last = inSegment[inSegment.length - 1] as AuditRecordV1;
      const progress = SealProgressV1Schema.parse({
        v: 1, kind: "seal-progress", phase: "planned", companyId,
        checkpoint: { fromSeq, toSeq: last.seq, headHash: last.hash, prevSealHash: tip?.sealHash ?? genesisHash(companyId), epochId },
        batchRoot: merkleRoot(recordLeafData(inSegment)), updatedAt: this.now().toISOString(),
      });
      if ((await this.store.planSeal(progress, { tip })) === "planned") {
        report.planned.push({ companyId, fromSeq, toSeq: last.seq });
        return;
      }
      // Refused: another sealer planned first, or the tip moved. Look again.
    }
  }

  private async advanceEpochs(report: SealTickReport): Promise<void> {
    let contiguous = true;
    let tip: EpochTip | undefined = await this.store.getEpochTip();
    for (const epochId of await this.store.listOpenEpochs()) {
      try {
        const result = await this.advanceEpoch(epochId, tip, report);
        tip = result.tip;
        if (result.done && contiguous) {
          await this.store.markEpochDone(epochId);
          report.completedEpochs.push(epochId);
        } else if (!result.done) contiguous = false;
      } catch (error) {
        contiguous = false;
        report.blocked.push({ what: `epoch ${epochId}`, reason: reason(error), refused: error instanceof AuditSealRefused || error instanceof AuditLedgerCorrupt });
      }
    }
  }

  private async advanceEpoch(epochId: string, tipIn: EpochTip | undefined, report: SealTickReport): Promise<{ done: boolean; tip: EpochTip | undefined }> {
    const seals = await this.store.listEpochSeals(epochId);
    if (seals.length === 0) throw new AuditLedgerCorrupt(`epoch ${epochId} is closed with no seals`);

    let allLocked = true;
    for (const seal of seals) {
      try {
        const progress = await this.store.getSealProgress(seal.orgId, seal.fromSeq, seal.toSeq);
        if (progress === undefined) throw new AuditLedgerCorrupt(`seal ${seal.orgId} ${seal.fromSeq}`);
        if ((await this.advanceSeal(progress)).phase !== "locked") allLocked = false;
      } catch (error) {
        allLocked = false;
        report.blocked.push({ what: `seal ${seal.orgId} ${seal.fromSeq}-${seal.toSeq}`, reason: reason(error), refused: error instanceof AuditSealRefused || error instanceof AuditLedgerCorrupt });
      }
    }

    let epoch = await this.store.getEpochProgress(epochId);
    let tip = tipIn;
    if (epoch === undefined) {
      if (tip !== undefined && tip.epochId >= epochId) throw new AuditLedgerCorrupt(`epoch ${epochId} is closed after a later one was planned`);
      const sorted = [...seals].sort((a, b) => (a.orgId < b.orgId ? -1 : a.orgId > b.orgId ? 1 : 0));
      const statement: EpochStatementV1 = {
        v: 1, epochId, closedAt: closedAtOfEpoch(epochId).toISOString(),
        prevEpochId: tip?.epochId ?? null, prevStatementHash: tip?.statementHash ?? null,
        sealsRoot: merkleRoot(sorted.map(sealLeafData)), sealCount: sorted.length,
      };
      const planned = EpochProgressV1Schema.parse({ ...statement, kind: "epoch-progress", phase: "planned", statementHash: statementHash(statement), updatedAt: this.now().toISOString() });
      if ((await this.store.planEpoch(planned, { tip })) === "refused") {
        epoch = await this.store.getEpochProgress(epochId);
        if (epoch === undefined) throw new AuditLedgerCorrupt(`epoch ${epochId} could not be planned`);
      } else epoch = planned;
    }
    tip = { epochId: epoch.epochId, statementHash: epoch.statementHash };

    // The statement is locked and stamped only when every seal in it is locked: a timestamp over seals that are not yet durable proves nothing a later export could show.
    if (!allLocked) return { done: false, tip };
    return { done: (await this.advanceEpochPhases(epoch)).phase === "timestamped", tip };
  }

  private async lock(write: LockedObjectWrite): Promise<LockedEvidenceV1> {
    const evidence = LockedEvidenceV1Schema.parse(await this.storage.putLocked(write));
    if (evidence.key !== write.key || evidence.sha256 !== write.sha256) throw new AuditSealRefused("-", "the storage target answered for other bytes than were sent");
    return evidence;
  }

  private async advanceSeal(start: SealProgressV1): Promise<SealProgressV1> {
    let progress = start;
    while (progress.phase !== "locked") {
      const { companyId, checkpoint } = progress;
      const stamp = this.now().toISOString();
      let next: SealProgressV1;
      if (progress.phase === "planned") {
        // Read the range again and compare with what was planned: a row changed since is never locked.
        const records = await this.store.readRecords(companyId, checkpoint.fromSeq, checkpoint.toSeq - checkpoint.fromSeq + 1);
        const check = checkChain(records, { seq: checkpoint.fromSeq - 1, hash: await this.hashBefore(companyId, checkpoint.fromSeq), orgId: companyId });
        if (!check.ok || merkleRoot(recordLeafData(records)) !== progress.batchRoot || records[records.length - 1]?.hash !== checkpoint.headHash) {
          throw new AuditSealRefused(companyId, "the records no longer match the planned seal");
        }
        const body = utf8(auditCanonicalJson({ v: 1, orgId: companyId, fromSeq: checkpoint.fromSeq, toSeq: checkpoint.toSeq, records }));
        const batch = await this.lock({ key: `audit/${companyId}/records/${range16(checkpoint.fromSeq, checkpoint.toSeq)}.json`, body, sha256: sha256(body) });
        next = SealProgressV1Schema.parse({ ...progress, phase: "batch-locked", batch, updatedAt: stamp });
      } else {
        const body = utf8(auditCanonicalJson(sealOf(progress)));
        const seal = await this.lock({ key: `audit/${companyId}/seals/${range16(checkpoint.fromSeq, checkpoint.toSeq)}.json`, body, sha256: sha256(body) });
        next = SealProgressV1Schema.parse({ ...progress, phase: "locked", seal, updatedAt: stamp });
      }
      if ((await this.store.advanceSeal(progress, next)) === "advanced") progress = next;
      else {
        // Someone else advanced it first: continue from what is stored (their evidence, not ours).
        const stored = await this.store.getSealProgress(companyId, checkpoint.fromSeq, checkpoint.toSeq);
        if (stored === undefined) throw new AuditLedgerCorrupt("seal progress vanished");
        progress = stored;
      }
    }
    return progress;
  }

  /** The hash the record at `fromSeq` must link to. The chain's own first record links to genesis; later ones to the record before. */
  private async hashBefore(companyId: string, fromSeq: number): Promise<string> {
    if (fromSeq === 1) return genesisHash(companyId);
    const [before] = await this.store.readRecords(companyId, fromSeq - 1, 1);
    if (before === undefined) throw new AuditLedgerCorrupt(`record ${fromSeq - 1}`);
    return before.hash;
  }

  private async advanceEpochPhases(start: EpochProgressV1): Promise<EpochProgressV1> {
    let progress = start;
    while (progress.phase !== "timestamped") {
      const stamp = this.now().toISOString();
      let next: EpochProgressV1;
      if (progress.phase === "planned") {
        const statement: EpochStatementV1 = {
          v: 1, epochId: progress.epochId, closedAt: progress.closedAt, prevEpochId: progress.prevEpochId, prevStatementHash: progress.prevStatementHash,
          sealsRoot: progress.sealsRoot, sealCount: progress.sealCount,
        };
        const body = utf8(auditCanonicalJson(statement));
        const evidence = await this.lock({ key: `audit/epochs/${progress.epochId}.json`, body, sha256: sha256(body) });
        next = EpochProgressV1Schema.parse({ ...progress, phase: "waiting-timestamp", statement: evidence, tsaProvider: this.timestamps.provider, updatedAt: stamp });
      } else if (progress.phase === "waiting-timestamp") {
        const token = await this.timestamps.stamp({ epochId: progress.epochId, statementHash: progress.statementHash });
        // The token's bytes are stored before they are uploaded: a restart uses the same answer.
        next = EpochProgressV1Schema.parse({ ...progress, phase: "timestamp-received", tokenBase64: Buffer.from(token).toString("base64"), tokenHash: sha256(token), updatedAt: stamp });
      } else {
        const body = Uint8Array.from(Buffer.from(progress.tokenBase64, "base64"));
        const evidence = await this.lock({ key: `audit/epochs/${progress.epochId}.${progress.tsaProvider}.tst`, body, sha256: sha256(body) });
        const rest: Record<string, unknown> = { ...progress };
        delete rest.tokenBase64;
        delete rest.tokenHash;
        next = EpochProgressV1Schema.parse({ ...rest, phase: "timestamped", token: evidence, updatedAt: stamp });
      }
      if ((await this.store.advanceEpoch(progress, next)) === "advanced") progress = next;
      else {
        const stored = await this.store.getEpochProgress(progress.epochId);
        if (stored === undefined) throw new AuditLedgerCorrupt("epoch progress vanished");
        progress = stored;
      }
    }
    return progress;
  }
}
