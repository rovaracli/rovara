// What the sealer needs from the rest of the sealed audit log, as interfaces. Lane AL-1 defines them and ships NO working implementation:
//   - AL-2 (the Object Lock bucket and its IAM) implements `AuditLockedStorage`.
//   - AL-3 (the timestamp authority client) implements `AuditTimestampSource`.
// The "unconfigured" stand-ins below refuse every call. They are not fakes: with them a seal stays planned and says so (DEC 540: nothing here claims a lock or a
// timestamp that nothing has made).
import type { z } from "zod";
import type { LockedEvidenceV1Schema } from "./audit-contracts-v1.js";

export type LockedEvidenceV1 = z.infer<typeof LockedEvidenceV1Schema>;

/** The bytes the sealer asks the storage target to keep, and their SHA-256 (lower-case hex), so the target need not choose them. */
export type LockedObjectWrite = { key: string; body: Uint8Array; sha256: string };

/**
 * TODO(AL-2): write `body` at `key` as a NEW object version under COMPLIANCE Object Lock (retention at least 365 days), never overwriting, then READ BACK the
 * version, mode, retain-until and digest from S3 and return those, not what was requested. The sealer parses the answer with `LockedEvidenceV1Schema` and checks
 * the key and digest, but parsing asserted metadata proves no lock (audit-contracts-v1.md). A repeat call with the same key and bytes (after a stop) may return
 * the version written earlier or a new one of the same bytes; the sealer accepts either as long as `writtenAt` is no earlier than the start of the step (the row
 * it continues, minus a 5-minute skew) and not in the future, and it persists the first answer it accepts. Set `retainUntil` to at least 365 days after `writtenAt`
 * plus a margin explicitly rather than relying on a bucket default.
 */
export interface AuditLockedStorage {
  putLocked(write: LockedObjectWrite): Promise<LockedEvidenceV1>;
}

/**
 * TODO(AL-3): ask the authority for an RFC 3161 token over `statementHash` (the SHA-256 of the epoch statement, `statementHash()` of the verifier) and return the
 * token's DER bytes. Before returning, VERIFY it with `verifyTimeStampToken` against the pinned anchors for `provider`, and with `timestampCoversRecord` against the
 * last record of every seal in the epoch: a token an export would fail must never be returned. `provider` is the label the bundle carries (`tsa`).
 */
export interface AuditTimestampSource {
  readonly provider: string;
  stamp(input: { epochId: string; statementHash: string }): Promise<Uint8Array>;
}

/** A sealing step whose storage or timestamp source is not built or not wired yet. The seal or epoch stays in its phase. */
export class AuditSealingNotConfigured extends Error {
  constructor(readonly missing: "locked-storage" | "timestamp-source") {
    super(`audit sealing: ${missing} is not configured, so this step did not happen`);
    this.name = "AuditSealingNotConfigured";
  }
}

export const unconfiguredLockedStorage: AuditLockedStorage = {
  putLocked: () => Promise.reject(new AuditSealingNotConfigured("locked-storage")),
};

/** The label of the stand-in; the sealer never writes it onto a statement. */
export const UNCONFIGURED_PROVIDER = "unconfigured";

export const unconfiguredTimestampSource: AuditTimestampSource = {
  provider: UNCONFIGURED_PROVIDER,
  stamp: () => Promise.reject(new AuditSealingNotConfigured("timestamp-source")),
};
