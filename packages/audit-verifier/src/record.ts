import { canonicalJson, isWellFormed, type JsonValue } from "./canonical-json.js";
import { sha256Hex } from "./hash.js";

export type AuditRecordV1 = {
  v: 1;
  orgId: string;
  seq: number;
  eventId: string;
  action: string;
  actor: { kind: string; id: string };
  target: { kind: string; id: string };
  occurredAt: string;
  recordedAt: string;
  related: string[];
  facts: Record<string, string | number | boolean>;
  proof?: { kind: string; method?: string; authTime?: string; sessionRef?: string; via?: string };
  details: Array<{ subject: string; commit: string }>;
  prevHash: string;
  hash: string;
};

export type OrgSealV1 = {
  v: 1;
  orgId: string;
  fromSeq: number;
  toSeq: number;
  batchRoot: string;
  headHash: string;
  prevSealHash: string;
  epochId: string;
};

export type ChainCheck =
  | { ok: true }
  | { ok: false; seq: number; problem: "hash" | "link" | "gap" | "org" };

const RECORD_PREFIX = "rovara-audit-record-v1\n";
const SEAL_PREFIX = "rovara-audit-seal-v1\n";
const GENESIS_PREFIX = "rovara-audit-genesis-v1\n";

/** sha256 of the record prefix and the canonical record without its `hash` field. */
export function recordHash(record: Omit<AuditRecordV1, "hash"> & { hash?: string }): string {
  // fromEntries defines own properties, so a parsed record's own "__proto__" field is hashed
  // (plain assignment would hit the prototype setter and drop it).
  const body: Record<string, JsonValue> = Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== "hash"),
  );
  return sha256Hex(RECORD_PREFIX + canonicalJson(body));
}

/** The `prevHash` of an org's first record and the `prevSealHash` of its first seal. */
export function genesisHash(orgId: string): string {
  // Hashing a lone surrogate as UTF-8 would turn it into U+FFFD and collide with other ids.
  if (!isWellFormed(orgId)) throw new TypeError("audit record: orgId is not well-formed Unicode");
  return sha256Hex(GENESIS_PREFIX + orgId);
}

export function sealHash(seal: OrgSealV1): string {
  return sha256Hex(SEAL_PREFIX + canonicalJson(seal));
}

/** A batch's Merkle leaf data: each record hash's 32 bytes, in the order given (`seq` order). */
export function recordLeafData(records: readonly Pick<AuditRecordV1, "hash">[]): Uint8Array[] {
  return records.map((record) => {
    // Buffer.from(.., "hex") truncates silently, so check the shape first.
    if (!/^[0-9a-f]{64}$/.test(record.hash)) throw new TypeError("audit record: hash is not 32 bytes of hex");
    return Uint8Array.from(Buffer.from(record.hash, "hex"));
  });
}

/** A seal's Merkle leaf data (the leaves of an epoch): the UTF-8 canonical JSON of the seal. */
export function sealLeafData(seal: OrgSealV1): Uint8Array {
  return new TextEncoder().encode(canonicalJson(seal));
}

/**
 * Walks `records` from `previous` (the record, or genesis at seq 0, that precedes them).
 * Per record, in order: org, then gap (seq is not previous + 1), then link (prevHash is not the
 * previous hash), then hash (the record does not hash to its own `hash`).
 * The org is `previous.orgId` when given, otherwise the first record's.
 */
export function checkChain(
  records: readonly AuditRecordV1[],
  previous: { seq: number; hash: string; orgId?: string },
): ChainCheck {
  let expectedSeq = previous.seq;
  let expectedPrevHash = previous.hash;
  let orgId = previous.orgId;
  for (const record of records) {
    orgId ??= record.orgId;
    if (record.orgId !== orgId) return { ok: false, seq: record.seq, problem: "org" };
    expectedSeq += 1;
    if (record.seq !== expectedSeq) return { ok: false, seq: record.seq, problem: "gap" };
    // A chain that starts at seq 0 must start at the org's genesis, whatever the caller passed.
    if (previous.seq === 0 && record.seq === 1 && previous.hash !== genesisHash(orgId)) {
      return { ok: false, seq: record.seq, problem: "link" };
    }
    if (record.prevHash !== expectedPrevHash) return { ok: false, seq: record.seq, problem: "link" };
    if (recordHash(record) !== record.hash) return { ok: false, seq: record.seq, problem: "hash" };
    expectedPrevHash = record.hash;
  }
  return { ok: true };
}

/** sha256(salt || utf8(canonicalJson({ subject, fields }))), the commitment a record holds for erasable details. */
export function detailCommit(
  salt: Uint8Array,
  subject: string,
  fields: Record<string, JsonValue>,
): string {
  if (salt.length < 16) throw new RangeError("audit record: detail salt must be at least 16 bytes");
  const body = new TextEncoder().encode(canonicalJson({ subject, fields }));
  const input = new Uint8Array(salt.length + body.length);
  input.set(salt, 0);
  input.set(body, salt.length);
  return sha256Hex(input);
}
