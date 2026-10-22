/**
 * The export bundle: its types, the hash an epoch statement is timestamped by, and a strict parser.
 * Everything here is built from node built-ins and this package's own files.
 */
import { canonicalJson, type JsonValue } from "./canonical-json.js";
import { sha256Hex } from "./hash.js";
import type { AuditRecordV1, OrgSealV1 } from "./record.js";

export type LockMode = "COMPLIANCE" | "GOVERNANCE";

/** An object Rovara wrote under Object Lock. Informational offline: the verifier cannot check S3. */
export type LockedObjectV1 = {
  key: string;
  versionId: string;
  lastModified: string;
  lockMode: LockMode;
  retainUntil: string;
};

/** What each timestamp authority signs, through its hash. Chained to the previous epoch. */
export type EpochStatementV1 = {
  v: 1;
  epochId: string;
  closedAt: string;
  prevEpochId: string | null;
  prevStatementHash: string | null;
  sealsRoot: string;
  sealCount: number;
};

export type BundleTimestamp = {
  /** The authority label: "digicert", "sectigo", or a customer's. Picks the anchors the token must chain to. */
  tsa: string;
  /** The RFC 3161 TimeStampToken (DER), base64. */
  token: string;
  object: LockedObjectV1;
};

export type BundleSeal = {
  seal: OrgSealV1;
  sealObject: LockedObjectV1;
  recordsObject: LockedObjectV1;
  inclusion: { index: number; size: number; path: string[] };
  epoch: EpochStatementV1;
  epochObject: LockedObjectV1;
  timestamps: BundleTimestamp[];
  coveredBy?: { epochs: EpochStatementV1[]; timestamps: BundleTimestamp[] };
};

export type BundleDetail =
  | { seq: number; subject: string; salt: string; fields: Record<string, JsonValue> }
  | { seq: number; subject: string; erased: true };

export type AuditBundleV1 = {
  format: "rovara-audit-bundle";
  v: 1;
  orgId: string;
  exportedAt: string;
  previous: { seq: number; hash: string };
  previousSeal: OrgSealV1 | null;
  records: AuditRecordV1[];
  seals: BundleSeal[];
  unsealed: AuditRecordV1[];
  details?: BundleDetail[];
};

/** sha256 of the canonical statement: the 32 bytes each timestamp authority signs. */
export function statementHash(statement: EpochStatementV1): string {
  // Built from the seven known fields so a bundle cannot smuggle extra ones into what is hashed.
  return sha256Hex(
    canonicalJson({
      v: statement.v,
      epochId: statement.epochId,
      closedAt: statement.closedAt,
      prevEpochId: statement.prevEpochId,
      prevStatementHash: statement.prevStatementHash,
      sealsRoot: statement.sealsRoot,
      sealCount: statement.sealCount,
    }),
  );
}

export class BundleParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleParseError";
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const EPOCH_ID = /^e\d{8}T\d{4}Z$/;
const LABEL = /^[A-Za-z0-9_.-]{1,64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;

type Obj = Record<string, unknown>;

function fail(path: string, what: string): never {
  throw new BundleParseError(`${path}: ${what}`);
}

function obj(value: unknown, path: string): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "expected an object");
  return value as Obj;
}

function arr(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  return value;
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "expected a string");
  return value;
}

function pattern(value: unknown, path: string, re: RegExp, what: string): string {
  const text = str(value, path);
  if (!re.test(text)) fail(path, `expected ${what}`);
  return text;
}

function safeInt(value: unknown, path: string, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    fail(path, "expected a non-negative integer");
  }
  return value;
}

function own(source: Obj, key: string): unknown {
  return Object.hasOwn(source, key) ? source[key] : undefined;
}

function lockedObject(value: unknown, path: string): LockedObjectV1 {
  const o = obj(value, path);
  const mode = own(o, "lockMode");
  if (mode !== "COMPLIANCE" && mode !== "GOVERNANCE") fail(`${path}.lockMode`, "expected COMPLIANCE or GOVERNANCE");
  return {
    key: str(own(o, "key"), `${path}.key`),
    versionId: str(own(o, "versionId"), `${path}.versionId`),
    lastModified: str(own(o, "lastModified"), `${path}.lastModified`),
    lockMode: mode,
    retainUntil: str(own(o, "retainUntil"), `${path}.retainUntil`),
  };
}

function orgSeal(value: unknown, path: string): OrgSealV1 {
  const o = obj(value, path);
  if (own(o, "v") !== 1) fail(`${path}.v`, "expected 1");
  return {
    v: 1,
    orgId: str(own(o, "orgId"), `${path}.orgId`),
    fromSeq: safeInt(own(o, "fromSeq"), `${path}.fromSeq`, 1),
    toSeq: safeInt(own(o, "toSeq"), `${path}.toSeq`, 1),
    batchRoot: pattern(own(o, "batchRoot"), `${path}.batchRoot`, HEX64, "64 hex characters"),
    headHash: pattern(own(o, "headHash"), `${path}.headHash`, HEX64, "64 hex characters"),
    prevSealHash: pattern(own(o, "prevSealHash"), `${path}.prevSealHash`, HEX64, "64 hex characters"),
    epochId: pattern(own(o, "epochId"), `${path}.epochId`, EPOCH_ID, "an epoch id"),
  };
}

function epochStatement(value: unknown, path: string): EpochStatementV1 {
  const o = obj(value, path);
  if (own(o, "v") !== 1) fail(`${path}.v`, "expected 1");
  const prevEpochId = own(o, "prevEpochId");
  const prevStatementHash = own(o, "prevStatementHash");
  return {
    v: 1,
    epochId: pattern(own(o, "epochId"), `${path}.epochId`, EPOCH_ID, "an epoch id"),
    closedAt: pattern(own(o, "closedAt"), `${path}.closedAt`, ISO_TIME, "an ISO 8601 UTC time"),
    prevEpochId: prevEpochId === null ? null : pattern(prevEpochId, `${path}.prevEpochId`, EPOCH_ID, "an epoch id or null"),
    prevStatementHash:
      prevStatementHash === null
        ? null
        : pattern(prevStatementHash, `${path}.prevStatementHash`, HEX64, "64 hex characters or null"),
    sealsRoot: pattern(own(o, "sealsRoot"), `${path}.sealsRoot`, HEX64, "64 hex characters"),
    sealCount: safeInt(own(o, "sealCount"), `${path}.sealCount`, 1),
  };
}

function timestamps(value: unknown, path: string): BundleTimestamp[] {
  return arr(value, path).map((entry, i) => {
    const o = obj(entry, `${path}[${i}]`);
    return {
      tsa: pattern(own(o, "tsa"), `${path}[${i}].tsa`, LABEL, "a label of letters, digits, dot, dash or underscore"),
      token: pattern(own(o, "token"), `${path}[${i}].token`, BASE64, "base64"),
      object: lockedObject(own(o, "object"), `${path}[${i}].object`),
    };
  });
}

function records(value: unknown, path: string): AuditRecordV1[] {
  return arr(value, path).map((entry, i) => {
    const at = `${path}[${i}]`;
    const o = obj(entry, at);
    str(own(o, "orgId"), `${at}.orgId`);
    safeInt(own(o, "seq"), `${at}.seq`, 1);
    str(own(o, "hash"), `${at}.hash`);
    str(own(o, "prevHash"), `${at}.prevHash`);
    str(own(o, "recordedAt"), `${at}.recordedAt`);
    for (const [i2, d] of arr(own(o, "details"), `${at}.details`).entries()) {
      const detail = obj(d, `${at}.details[${i2}]`);
      str(own(detail, "subject"), `${at}.details[${i2}].subject`);
      str(own(detail, "commit"), `${at}.details[${i2}].commit`);
    }
    return o as unknown as AuditRecordV1;
  });
}

function details(value: unknown, path: string): BundleDetail[] {
  return arr(value, path).map((entry, i) => {
    const at = `${path}[${i}]`;
    const o = obj(entry, at);
    const seq = safeInt(own(o, "seq"), `${at}.seq`, 1);
    const subject = str(own(o, "subject"), `${at}.subject`);
    if (own(o, "erased") === true) return { seq, subject, erased: true as const };
    return {
      seq,
      subject,
      salt: pattern(own(o, "salt"), `${at}.salt`, /^[0-9a-f]+$/, "hex"),
      fields: obj(own(o, "fields"), `${at}.fields`) as Record<string, JsonValue>,
    };
  });
}

/**
 * Checks the shape of a parsed bundle and returns a normalized copy. A `limits` field, or any other
 * unknown one, is dropped: the verifier prints its own copy and never a bundle's.
 */
export function parseBundle(value: unknown): AuditBundleV1 {
  const o = obj(value, "bundle");
  if (own(o, "format") !== "rovara-audit-bundle") fail("format", 'expected "rovara-audit-bundle"');
  if (own(o, "v") !== 1) fail("v", "expected 1 (this verifier reads version 1)");
  const previous = obj(own(o, "previous"), "previous");
  const previousSeal = own(o, "previousSeal");
  const result: AuditBundleV1 = {
    format: "rovara-audit-bundle",
    v: 1,
    orgId: str(own(o, "orgId"), "orgId"),
    exportedAt: str(own(o, "exportedAt"), "exportedAt"),
    previous: {
      seq: safeInt(own(previous, "seq"), "previous.seq"),
      hash: pattern(own(previous, "hash"), "previous.hash", HEX64, "64 hex characters"),
    },
    previousSeal: previousSeal === null ? null : orgSeal(previousSeal, "previousSeal"),
    records: records(own(o, "records"), "records"),
    seals: arr(own(o, "seals"), "seals").map((entry, i): BundleSeal => {
      const at = `seals[${i}]`;
      const s = obj(entry, at);
      const inclusion = obj(own(s, "inclusion"), `${at}.inclusion`);
      const coveredBy = own(s, "coveredBy");
      const base = {
        seal: orgSeal(own(s, "seal"), `${at}.seal`),
        sealObject: lockedObject(own(s, "sealObject"), `${at}.sealObject`),
        recordsObject: lockedObject(own(s, "recordsObject"), `${at}.recordsObject`),
        inclusion: {
          index: safeInt(own(inclusion, "index"), `${at}.inclusion.index`),
          size: safeInt(own(inclusion, "size"), `${at}.inclusion.size`, 1),
          path: arr(own(inclusion, "path"), `${at}.inclusion.path`).map((p, j) =>
            pattern(p, `${at}.inclusion.path[${j}]`, HEX64, "64 hex characters"),
          ),
        },
        epoch: epochStatement(own(s, "epoch"), `${at}.epoch`),
        epochObject: lockedObject(own(s, "epochObject"), `${at}.epochObject`),
        timestamps: timestamps(own(s, "timestamps"), `${at}.timestamps`),
      };
      if (coveredBy === undefined) return base;
      const c = obj(coveredBy, `${at}.coveredBy`);
      return {
        ...base,
        coveredBy: {
          epochs: arr(own(c, "epochs"), `${at}.coveredBy.epochs`).map((e, j) =>
            epochStatement(e, `${at}.coveredBy.epochs[${j}]`),
          ),
          timestamps: timestamps(own(c, "timestamps"), `${at}.coveredBy.timestamps`),
        },
      };
    }),
    unsealed: records(own(o, "unsealed"), "unsealed"),
  };
  const detailList = own(o, "details");
  if (detailList !== undefined) result.details = details(detailList, "details");
  return result;
}
