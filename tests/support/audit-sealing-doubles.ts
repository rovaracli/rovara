// Test doubles for the sealed audit log's two ports (AL-2 storage, AL-3 timestamps) and an exporter that assembles the verifier's bundle from what the
// sealer stored. They stand in for services that are NOT built: nothing here is a lock or a real timestamp, and nothing in product code imports this file.
import { createHash, type X509Certificate } from "node:crypto";
import {
  genesisHash, verifyBundle, inclusionPath, sealLeafData,
  type AuditBundleV1, type AuditRecordV1 as VerifierRecord, type BundleSeal, type BundleTimestamp, type LockedObjectV1,
} from "../../packages/audit-verifier/src/index.js";
import type { AuditLockedStorage, AuditTimestampSource, LockedEvidenceV1, LockedObjectWrite } from "../../packages/cloud-server/src/audit-sealing-ports.js";
import type { AuditSealStore } from "../../packages/cloud-server/src/audit-ledger-store.js";
import { closedAtOfEpoch } from "../../packages/cloud-server/src/audit-sealer.js";
import { buildToken, makePki, type FakePki } from "./fake-tsa.js";

const DAY_MS = 86_400_000;

/** Keeps every write by key, returns versions with 400 days of retention. A double: no S3, no Object Lock. */
export class LockedStorageDouble implements AuditLockedStorage {
  readonly objects = new Map<string, { body: Uint8Array; evidence: LockedEvidenceV1 }>();
  readonly writes: string[] = [];
  failNext = 0;
  /** Fails every write whose key contains this, until cleared. */
  failKeyPart: string | undefined;
  /** Answers with this retention instead of 400 days. */
  retentionDays = 400;
  /** Answers for other bytes than were sent. */
  lie = false;
  constructor(private readonly now: () => Date) {}

  async putLocked(write: LockedObjectWrite): Promise<LockedEvidenceV1> {
    if (this.failNext > 0) { this.failNext -= 1; throw new Error("storage unavailable"); }
    if (this.failKeyPart !== undefined && write.key.includes(this.failKeyPart)) throw new Error("storage unavailable");
    this.writes.push(write.key);
    const writtenAt = this.now().toISOString();
    const evidence: LockedEvidenceV1 = {
      key: write.key, versionId: `v${this.writes.length}`, sha256: this.lie ? "0".repeat(64) : write.sha256, writtenAt, lockMode: "COMPLIANCE",
      retainUntil: new Date(this.now().getTime() + this.retentionDays * DAY_MS).toISOString(),
    };
    this.objects.set(write.key, { body: write.body, evidence });
    return evidence;
  }
}

export const TSA_LABEL = "testtsa";
let pki: FakePki | undefined;
export const doublePki = (): FakePki => (pki ??= makePki("AL1"));

/** Mints a real-format token over the statement hash, signed by a throwaway test authority. */
export class TimestampDouble implements AuditTimestampSource {
  readonly provider = TSA_LABEL;
  readonly asked: string[] = [];
  failNext = 0;
  async stamp(input: { epochId: string; statementHash: string }): Promise<Uint8Array> {
    if (this.failNext > 0) { this.failNext -= 1; throw new Error("authority unavailable"); }
    this.asked.push(input.epochId);
    const genTime = new Date(closedAtOfEpoch(input.epochId).getTime() + 90_000);
    return buildToken({ signer: doublePki().signer, hashHex: input.statementHash, genTime, certificates: [doublePki().ca, doublePki().signer] });
  }
}

const locked = (evidence: LockedEvidenceV1): LockedObjectV1 => ({
  key: evidence.key, versionId: evidence.versionId, lastModified: evidence.writtenAt, lockMode: evidence.lockMode, retainUntil: evidence.retainUntil,
});

/** The verifier's export bundle for one company, built only from what the sealer and the ports stored. */
export async function assembleBundle(input: { store: AuditSealStore; storage: LockedStorageDouble; companyId: string; epochIds: readonly string[] }): Promise<AuditBundleV1> {
  const { store, storage, companyId } = input;
  const head = await store.getHead(companyId);
  const records = head === undefined ? [] : (await store.readRecords(companyId, 1, head.seq)) as unknown as VerifierRecord[];
  const seals: BundleSeal[] = [];
  for (const epochId of [...input.epochIds].sort()) {
    const all = await store.listEpochSeals(epochId);
    const mine = all.find((seal) => seal.orgId === companyId);
    if (mine === undefined) continue;
    const progress = await store.getSealProgress(companyId, mine.fromSeq, mine.toSeq);
    const epoch = await store.getEpochProgress(epochId);
    if (progress?.phase !== "locked" || epoch?.phase !== "timestamped") throw new Error(`epoch ${epochId} is not finished`);
    const token = storage.objects.get(epoch.token.key);
    if (token === undefined) throw new Error("token object missing");
    const stamp: BundleTimestamp = { tsa: epoch.tsaProvider, token: Buffer.from(token.body).toString("base64"), object: locked(epoch.token) };
    const leaves = all.map(sealLeafData);
    const index = all.findIndex((seal) => seal.orgId === companyId);
    seals.push({
      seal: mine, sealObject: locked(progress.seal), recordsObject: locked(progress.batch),
      inclusion: { index, size: all.length, path: inclusionPath(leaves, index) },
      epoch: { v: 1, epochId, closedAt: epoch.closedAt, prevEpochId: epoch.prevEpochId, prevStatementHash: epoch.prevStatementHash, sealsRoot: epoch.sealsRoot, sealCount: epoch.sealCount },
      epochObject: locked(epoch.statement), timestamps: [stamp],
    });
  }
  const sealedThrough = seals.length === 0 ? 0 : (seals[seals.length - 1] as BundleSeal).seal.toSeq;
  return {
    format: "rovara-audit-bundle", v: 1, orgId: companyId, exportedAt: new Date().toISOString(),
    previous: { seq: 0, hash: genesisHash(companyId) }, previousSeal: null,
    records: records.filter((record) => record.seq <= sealedThrough), seals, unsealed: records.filter((record) => record.seq > sealedThrough),
  };
}

export const doubleAnchors = (): Record<string, X509Certificate[]> => ({ [TSA_LABEL]: [doublePki().root.x509] });
export { verifyBundle };
export const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
