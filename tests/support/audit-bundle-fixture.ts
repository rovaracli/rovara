/**
 * Builds consistent audit bundles for tests: two organizations, up to three 15-minute epochs, a
 * hash chain per organization, seals, epoch statements chained by hash, and fake RFC 3161 tokens.
 * Organization A is exported. Everything is deterministic except the fake PKI's keys.
 */
import type { X509Certificate } from "node:crypto";
import type {
  AuditBundleV1,
  BundleDetail,
  BundleSeal,
  BundleTimestamp,
  EpochStatementV1,
  LockedObjectV1,
  LockMode,
} from "../../packages/audit-verifier/src/bundle.js";
import { statementHash } from "../../packages/audit-verifier/src/bundle.js";
import { detailCommit, genesisHash, recordHash, recordLeafData, sealHash, sealLeafData, type AuditRecordV1, type OrgSealV1 } from "../../packages/audit-verifier/src/record.js";
import { inclusionPath, merkleRoot } from "../../packages/audit-verifier/src/merkle.js";
import { buildToken, makePki, type FakePki } from "./fake-tsa.js";

export const ORG_A = "org-a";
export const ORG_B = "org-b";
export const TSA_LABEL = "digicert";

const BASE_MS = Date.parse("2026-10-20T12:00:00Z");
const EPOCH_MS = 15 * 60 * 1000;

export type SealPlan = { epoch: number; toSeq: number };

export interface FixtureOptions {
  /** Records org A has in total (default 40). */
  recordsA?: number;
  recordsB?: number;
  /** Org A's seals, in order (default: epoch 1 to seq 12, epoch 2 to 20, epoch 3 to 35). */
  sealsA?: readonly SealPlan[];
  sealsB?: readonly SealPlan[];
  /** Epochs that carry their own token (default: all). */
  stamped?: readonly number[];
  lockMode?: LockMode;
  /** Records first..last of org A get an extra fact, so the chain from there on is different. */
  rewrite?: { from: number; to: number };
  /** Export starting at this seq, which must be the first seq of one of A's seals (default: the start). */
  exportFrom?: number;
  /** The genTime a token carries (default: 90 seconds after the epoch closes). */
  genTimeFor?: (epoch: number, closedAt: Date) => Date;
}

export const DEFAULT_SEALS_A: readonly SealPlan[] = [
  { epoch: 1, toSeq: 12 },
  { epoch: 2, toSeq: 20 },
  { epoch: 3, toSeq: 35 },
];
const DEFAULT_SEALS_B: readonly SealPlan[] = [
  { epoch: 1, toSeq: 4 },
  { epoch: 2, toSeq: 8 },
  { epoch: 3, toSeq: 12 },
];

let sharedPki: FakePki | undefined;
export function fixturePki(): FakePki {
  sharedPki ??= makePki("Bundle");
  return sharedPki;
}

export function fixtureAnchors(pki: FakePki = fixturePki()): Record<string, X509Certificate[]> {
  return { [TSA_LABEL]: [pki.root.x509] };
}

export function epochIdOf(epoch: number): string {
  const close = new Date(BASE_MS + epoch * EPOCH_MS);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `e${close.getUTCFullYear()}${pad(close.getUTCMonth() + 1)}${pad(close.getUTCDate())}T${pad(close.getUTCHours())}${pad(close.getUTCMinutes())}Z`;
}

export function closedAtOf(epoch: number): Date {
  return new Date(BASE_MS + epoch * EPOCH_MS);
}

function lockedObject(key: string, mode: LockMode): LockedObjectV1 {
  return {
    key,
    versionId: `v-${key.length}`,
    lastModified: "2026-10-20T12:20:00.000Z",
    lockMode: mode,
    retainUntil: "2029-10-20T12:20:00.000Z",
  };
}

const DETAIL_SALT = "00112233445566778899aabbccddeeff";
export const DETAIL_FIELDS = { name: "Alice Example", email: "alice@example.test" };
export const DETAIL_SUBJECT = "person:alice";
const DETAIL_SEQ = 7;
const ERASED_SEQ = 9;

function recordedAtFor(seq: number, plan: readonly SealPlan[]): string {
  let from = 1;
  for (const entry of plan) {
    if (seq <= entry.toSeq) {
      const index = seq - from;
      return new Date(closedAtOf(entry.epoch).getTime() - 14 * 60 * 1000 + index * 20 * 1000).toISOString();
    }
    from = entry.toSeq + 1;
  }
  const last = plan[plan.length - 1];
  const after = last === undefined ? BASE_MS : closedAtOf(last.epoch).getTime();
  return new Date(after + 60 * 1000 + (seq - from) * 20 * 1000).toISOString();
}

function buildChain(
  orgId: string,
  total: number,
  plan: readonly SealPlan[],
  options: { rewrite?: { from: number; to: number } | undefined; withDetails: boolean },
): { records: AuditRecordV1[]; seals: OrgSealV1[] } {
  const records: AuditRecordV1[] = [];
  let prevHash = genesisHash(orgId);
  for (let seq = 1; seq <= total; seq += 1) {
    const rewritten = options.rewrite !== undefined && seq >= options.rewrite.from && seq <= options.rewrite.to;
    const details: Array<{ subject: string; commit: string }> = [];
    if (options.withDetails && seq === DETAIL_SEQ) {
      details.push({ subject: DETAIL_SUBJECT, commit: detailCommit(Buffer.from(DETAIL_SALT, "hex"), DETAIL_SUBJECT, DETAIL_FIELDS) });
    }
    if (options.withDetails && seq === ERASED_SEQ) {
      details.push({ subject: "person:bob", commit: detailCommit(Buffer.from(DETAIL_SALT, "hex"), "person:bob", { name: "Bob" }) });
    }
    const body = {
      v: 1 as const,
      orgId,
      seq,
      eventId: `${orgId}-evt-${seq}`,
      action: "member.invited",
      actor: { kind: "user", id: "u_1" },
      target: { kind: "member", id: `n_${seq}` },
      occurredAt: recordedAtFor(seq, plan),
      recordedAt: recordedAtFor(seq, plan),
      related: [],
      facts: { role: "admin", ...(rewritten ? { rewritten: true } : {}) },
      details,
      prevHash,
    };
    const record: AuditRecordV1 = { ...body, hash: recordHash(body) };
    records.push(record);
    prevHash = record.hash;
  }
  const seals: OrgSealV1[] = [];
  let from = 1;
  let prevSealHash = genesisHash(orgId);
  for (const entry of plan) {
    const range = records.slice(from - 1, entry.toSeq);
    const seal: OrgSealV1 = {
      v: 1,
      orgId,
      fromSeq: from,
      toSeq: entry.toSeq,
      batchRoot: merkleRoot(recordLeafData(range)),
      headHash: (range[range.length - 1] as AuditRecordV1).hash,
      prevSealHash,
      epochId: epochIdOf(entry.epoch),
    };
    seals.push(seal);
    prevSealHash = sealHash(seal);
    from = entry.toSeq + 1;
  }
  return { records, seals };
}

export interface AuditFixture {
  bundle: AuditBundleV1;
  pki: FakePki;
  anchors: Record<string, X509Certificate[]>;
  /** Statements by epoch number (index 0 is epoch 1). */
  statements: EpochStatementV1[];
}

export function mintToken(
  pki: FakePki,
  hashHex: string,
  genTime: Date,
  mode: LockMode = "COMPLIANCE",
  label: string = TSA_LABEL,
): BundleTimestamp {
  const token = buildToken({ signer: pki.signer, hashHex, genTime, certificates: [pki.ca, pki.signer] });
  return { tsa: label, token: Buffer.from(token).toString("base64"), object: lockedObject(`tokens/${label}`, mode) };
}

export function buildAuditFixture(options: FixtureOptions = {}): AuditFixture {
  const pki = fixturePki();
  const mode = options.lockMode ?? "COMPLIANCE";
  const plansA = options.sealsA ?? DEFAULT_SEALS_A;
  const plansB = options.sealsB ?? DEFAULT_SEALS_B;
  const a = buildChain(ORG_A, options.recordsA ?? 40, plansA, { rewrite: options.rewrite, withDetails: true });
  const b = buildChain(ORG_B, options.recordsB ?? 12, plansB, { withDetails: false });
  const epochCount = Math.max(...plansA.map((p) => p.epoch), ...plansB.map((p) => p.epoch));
  const stamped = options.stamped ?? Array.from({ length: epochCount }, (_, i) => i + 1);

  // One statement per epoch; its seals root covers every organization's seal in that epoch.
  const statements: EpochStatementV1[] = [];
  const inclusions = new Map<string, { index: number; size: number; path: string[] }>();
  for (let epoch = 1; epoch <= epochCount; epoch += 1) {
    const epochId = epochIdOf(epoch);
    const leaves = [...a.seals, ...b.seals]
      .filter((seal) => seal.epochId === epochId)
      .sort((x, y) => (x.orgId < y.orgId ? -1 : 1));
    const leafData = leaves.map(sealLeafData);
    leaves.forEach((seal, index) => {
      inclusions.set(`${seal.orgId}:${seal.fromSeq}`, { index, size: leaves.length, path: inclusionPath(leafData, index) });
    });
    const previous = statements[epoch - 2];
    statements.push({
      v: 1,
      epochId,
      closedAt: closedAtOf(epoch).toISOString(),
      prevEpochId: previous === undefined ? null : previous.epochId,
      prevStatementHash: previous === undefined ? null : statementHash(previous),
      sealsRoot: merkleRoot(leafData),
      sealCount: leaves.length,
    });
  }

  const tokens = new Map<number, BundleTimestamp[]>();
  for (const epoch of stamped) {
    const statement = statements[epoch - 1] as EpochStatementV1;
    const closed = closedAtOf(epoch);
    const genTime = options.genTimeFor?.(epoch, closed) ?? new Date(closed.getTime() + 90 * 1000);
    tokens.set(epoch, [mintToken(pki, statementHash(statement), genTime, mode)]);
  }

  const epochNumberOf = (epochId: string): number => statements.findIndex((s) => s.epochId === epochId) + 1;
  const exportFrom = options.exportFrom ?? 1;
  const firstIndex = exportFrom === 1 ? 0 : a.seals.findIndex((seal) => seal.fromSeq === exportFrom);
  if (firstIndex < 0) throw new Error(`exportFrom ${exportFrom} is not the start of a seal`);

  const seals: BundleSeal[] = a.seals.slice(firstIndex).map((seal) => {
    const epoch = epochNumberOf(seal.epochId);
    const own = tokens.get(epoch) ?? [];
    const entry: BundleSeal = {
      seal,
      sealObject: lockedObject(`orgs/${ORG_A}/seals/${seal.fromSeq}.json`, mode),
      recordsObject: lockedObject(`orgs/${ORG_A}/records/${seal.fromSeq}.json`, mode),
      inclusion: inclusions.get(`${ORG_A}:${seal.fromSeq}`) as { index: number; size: number; path: string[] },
      epoch: statements[epoch - 1] as EpochStatementV1,
      epochObject: lockedObject(`epochs/${seal.epochId}.json`, mode),
      timestamps: own,
    };
    if (own.length === 0) {
      const covering = Array.from({ length: epochCount - epoch }, (_, i) => epoch + 1 + i).find((later) => tokens.has(later));
      if (covering !== undefined) {
        entry.coveredBy = {
          epochs: statements.slice(epoch, covering),
          timestamps: tokens.get(covering) as BundleTimestamp[],
        };
      }
    }
    return entry;
  });

  const startIndex = exportFrom - 1;
  const sealedThrough = a.seals.length === 0 ? 0 : (a.seals[a.seals.length - 1] as OrgSealV1).toSeq;
  const previousRecord = a.records[startIndex - 1];
  const previousSeal = firstIndex === 0 ? null : (a.seals[firstIndex - 1] as OrgSealV1);
  const details: BundleDetail[] = [];
  if (exportFrom <= DETAIL_SEQ && DETAIL_SEQ <= a.records.length) details.push({ seq: DETAIL_SEQ, subject: DETAIL_SUBJECT, salt: DETAIL_SALT, fields: { ...DETAIL_FIELDS } });
  if (exportFrom <= ERASED_SEQ && ERASED_SEQ <= a.records.length) details.push({ seq: ERASED_SEQ, subject: "person:bob", erased: true });

  const bundle: AuditBundleV1 = {
    format: "rovara-audit-bundle",
    v: 1,
    orgId: ORG_A,
    exportedAt: "2026-10-20T14:00:00.000Z",
    previous: previousRecord === undefined ? { seq: 0, hash: genesisHash(ORG_A) } : { seq: previousRecord.seq, hash: previousRecord.hash },
    previousSeal,
    records: a.records.filter((record) => record.seq >= exportFrom && record.seq <= sealedThrough),
    seals,
    unsealed: a.records.filter((record) => record.seq > sealedThrough),
    details,
  };
  return { bundle, pki, anchors: fixtureAnchors(pki), statements };
}

/** A deep copy with no shared objects (structuredClone would keep shared statements shared). */
export function cloneBundle(bundle: AuditBundleV1): AuditBundleV1 {
  return JSON.parse(JSON.stringify(bundle)) as AuditBundleV1;
}

/** Flips the first hex character of a 64-character hex string. */
export function flipHex(hex: string): string {
  return (hex[0] === "0" ? "1" : "0") + hex.slice(1);
}

/** Recomputes every hash from `fromSeq` on so the chain stays internally consistent (an attacker's rewrite). */
export function rechainFrom(bundle: AuditBundleV1, fromSeq: number, edit: (record: AuditRecordV1) => void): void {
  const all = [...bundle.records, ...bundle.unsealed];
  let prevHash = bundle.previous.hash;
  for (const record of all) {
    if (record.seq === fromSeq) edit(record);
    if (record.seq >= fromSeq) {
      record.prevHash = prevHash;
      record.hash = recordHash(record);
    }
    prevHash = record.hash;
  }
}
