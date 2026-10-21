/**
 * Checks an export bundle offline. Only the pinned roots passed in `anchors` are ever trusted;
 * certificates inside a bundle's tokens are evidence for the path search, never anchors.
 */
import type { X509Certificate } from "node:crypto";
import type { AuditBundleV1, BundleSeal, BundleTimestamp, EpochStatementV1, LockMode } from "./bundle.js";
import { statementHash } from "./bundle.js";
import { checkChain, detailCommit, genesisHash, recordLeafData, sealHash, sealLeafData, type AuditRecordV1 } from "./record.js";
import { merkleRoot, verifyInclusion } from "./merkle.js";
import { verifyTimeStampToken } from "./timestamp.js";

export type BundleCheck = { name: string; ok: boolean; detail: string };

export type BundleReport = {
  ok: boolean;
  checks: BundleCheck[];
  /** The last sequence number in the last seal (0 when nothing is sealed). */
  sealedThroughSeq: number;
  /** Records after the last seal. */
  unsealedCount: number;
  /** The latest of the per-epoch independent times (each epoch's earliest valid genTime). */
  timestampedThrough?: string;
  /** Epochs with no valid token of their own, proven by a later epoch's token through the statement chain. */
  coveredEpochs: string[];
  /** Epochs with neither: reported, not a failure. */
  epochsWithoutTimestamp: string[];
  /** Authority labels with tokens in the export that were not checked, because no trusted root was given for them. */
  unverifiedAuthorities: string[];
  lockModes: LockMode[];
};

export type VerifyBundleOptions = {
  /** Anchors per authority label. A token is checked only against its own label's anchors. */
  anchors: Readonly<Record<string, readonly X509Certificate[]>>;
};

/** A token's genTime may be this much before the seal's last recordedAt (clock skew). */
export const TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

/**
 * The bundle check's rule for a token and the last record it should cover: genTime must not be more than the skew before that
 * record's `recordedAt`. The anchor applies the same function before it stores a token, so it never keeps one that an export
 * would fail. An unreadable time on either side fails.
 */
export function timestampCoversRecord(genTime: string, lastRecordedAt: string): boolean {
  return Date.parse(genTime) >= Date.parse(lastRecordedAt) - TIMESTAMP_SKEW_MS;
}
const MAX_LISTED = 5;

function listed(items: readonly string[]): string {
  if (items.length <= MAX_LISTED) return items.join("; ");
  return `${items.slice(0, MAX_LISTED).join("; ")}; and ${items.length - MAX_LISTED} more`;
}

function check(name: string, run: () => { ok: boolean; detail: string }): BundleCheck {
  try {
    return { name, ...run() };
  } catch (error) {
    return { name, ok: false, detail: `could not be evaluated: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Problems found, or the success text. */
function outcome(problems: readonly string[], success: string): { ok: boolean; detail: string } {
  return problems.length === 0 ? { ok: true, detail: success } : { ok: false, detail: listed(problems) };
}

function label(seal: BundleSeal): string {
  return `seal ${seal.seal.fromSeq}-${seal.seal.toSeq}`;
}

function decodeBase64(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) return undefined;
  return Uint8Array.from(Buffer.from(text, "base64"));
}

type TokenOutcome = { valid: string[]; problems: string[]; unverifiable: string[] /* authority labels */ };

/**
 * Verifies every token against `hashHex` and its own label's anchors. A token whose label has
 * no anchors is unverifiable (reported, not a failure); a token that fails is a problem.
 */
function checkTokens(
  tokens: readonly BundleTimestamp[],
  hashHex: string,
  anchors: VerifyBundleOptions["anchors"],
  lastRecordedAt: string | undefined,
  context: string,
): TokenOutcome {
  const outcomeOf: TokenOutcome = { valid: [], problems: [], unverifiable: [] };
  for (const entry of tokens) {
    const roots = Object.hasOwn(anchors, entry.tsa) ? (anchors[entry.tsa] ?? []) : [];
    if (roots.length === 0) {
      outcomeOf.unverifiable.push(entry.tsa);
      continue;
    }
    const bytes = decodeBase64(entry.token);
    if (bytes === undefined) {
      outcomeOf.problems.push(`${context} ${entry.tsa}: token is not base64`);
      continue;
    }
    const verdict = verifyTimeStampToken(bytes, { hashHex, anchors: roots });
    if (!verdict.ok) {
      outcomeOf.problems.push(`${context} ${entry.tsa}: token rejected (${verdict.problem})`);
      continue;
    }
    if (lastRecordedAt !== undefined) {
      if (!timestampCoversRecord(verdict.genTime, lastRecordedAt)) {
        outcomeOf.problems.push(
          `${context} ${entry.tsa}: genTime ${verdict.genTime} is more than 5 minutes before the last record it should cover (${lastRecordedAt})`,
        );
        continue;
      }
    }
    outcomeOf.valid.push(verdict.genTime);
  }
  return outcomeOf;
}

function earliest(times: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const time of times) if (best === undefined || Date.parse(time) < Date.parse(best)) best = time;
  return best;
}

function latest(times: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const time of times) if (best === undefined || Date.parse(time) > Date.parse(best)) best = time;
  return best;
}

export function bundleSealedThroughSeq(bundle: AuditBundleV1): number {
  const last = bundle.seals[bundle.seals.length - 1];
  if (last !== undefined) return last.seal.toSeq;
  return bundle.previousSeal?.toSeq ?? 0;
}

export function verifyBundle(bundle: AuditBundleV1, options: VerifyBundleOptions): BundleReport {
  const all: AuditRecordV1[] = [...bundle.records, ...bundle.unsealed];
  const bySeq = new Map<number, AuditRecordV1>();
  for (const record of all) if (!bySeq.has(record.seq)) bySeq.set(record.seq, record);
  const lastSeq = all.reduce((max, record) => Math.max(max, record.seq), bundle.previous.seq);
  const sealedThroughSeq = bundleSealedThroughSeq(bundle);

  const checks: BundleCheck[] = [];

  const chain = check("chain", () => {
    const result = checkChain(all, { seq: bundle.previous.seq, hash: bundle.previous.hash, orgId: bundle.orgId });
    if (result.ok) {
      return { ok: true, detail: `${all.length} records link to each other and to the earlier record (seq ${bundle.previous.seq})` };
    }
    return { ok: false, detail: `record ${result.seq} fails the ${result.problem} check` };
  });
  checks.push(chain);

  checks.push(
    check("sealRanges", () => {
      const problems: string[] = [];
      let expectedFrom = bundle.previous.seq + 1;
      for (const entry of bundle.seals) {
        const { seal } = entry;
        if (seal.orgId !== bundle.orgId) problems.push(`${label(entry)} belongs to another organization`);
        if (seal.fromSeq !== expectedFrom) problems.push(`${label(entry)} should start at seq ${expectedFrom}`);
        if (seal.toSeq < seal.fromSeq) problems.push(`${label(entry)} ends before it starts`);
        if (seal.toSeq > lastSeq) problems.push(`${label(entry)} reaches past the last record in the export (seq ${lastSeq})`);
        expectedFrom = seal.toSeq + 1;
      }
      return outcome(problems, `${bundle.seals.length} seals cover seq ${bundle.previous.seq + 1} to ${sealedThroughSeq} without gaps`);
    }),
  );

  // Records missing from a sealed range are reported by the chain check (a gap); these checks then
  // skip that seal. With a passing chain a missing record cannot happen, which is enforced below.
  const rangeOf = (entry: BundleSeal): AuditRecordV1[] | undefined => {
    const found: AuditRecordV1[] = [];
    for (let seq = entry.seal.fromSeq; seq <= entry.seal.toSeq; seq += 1) {
      const record = bySeq.get(seq);
      if (record === undefined) return undefined;
      found.push(record);
    }
    return found;
  };

  const skippedNote = (skipped: number): string[] => {
    if (skipped === 0) return [];
    return chain.ok ? [`${skipped} seals could not be checked because records are missing`] : [];
  };
  const skippedSuffix = (skipped: number): string => (skipped === 0 ? "" : `; ${skipped} not checked, records missing (see chain)`);

  checks.push(
    check("batchRoot", () => {
      const problems: string[] = [];
      let skipped = 0;
      for (const entry of bundle.seals) {
        const range = rangeOf(entry);
        if (range === undefined) {
          skipped += 1;
          continue;
        }
        // The stored hashes are the leaves; the chain check recomputes them from the content.
        if (merkleRoot(recordLeafData(range)) !== entry.seal.batchRoot) {
          problems.push(`${label(entry)}: the records do not give the sealed batch root`);
        }
      }
      problems.push(...skippedNote(skipped));
      return outcome(problems, `${bundle.seals.length} batch roots match their records${skippedSuffix(skipped)}`);
    }),
  );

  checks.push(
    check("headHash", () => {
      const problems: string[] = [];
      let skipped = 0;
      for (const entry of bundle.seals) {
        const head = bySeq.get(entry.seal.toSeq);
        if (head === undefined) {
          skipped += 1;
          continue;
        }
        if (head.hash !== entry.seal.headHash) problems.push(`${label(entry)}: the record at seq ${entry.seal.toSeq} is not the sealed head`);
      }
      problems.push(...skippedNote(skipped));
      return outcome(problems, `${bundle.seals.length} sealed heads match their records${skippedSuffix(skipped)}`);
    }),
  );

  checks.push(
    check("prevSealHash", () => {
      const problems: string[] = [];
      const first = bundle.seals[0];
      const { previousSeal, previous } = bundle;
      if (previous.seq === 0) {
        if (previousSeal !== null) problems.push("a previous seal is given for an export that starts at the first record");
        if (first !== undefined && first.seal.prevSealHash !== genesisHash(bundle.orgId)) {
          problems.push(`${label(first)} does not start from the organization's genesis`);
        }
      } else if (previousSeal !== null) {
        if (previousSeal.orgId !== bundle.orgId) problems.push("the previous seal belongs to another organization");
        if (previousSeal.toSeq !== previous.seq) problems.push(`the previous seal ends at seq ${previousSeal.toSeq}, not ${previous.seq}`);
        if (previousSeal.headHash !== previous.hash) problems.push("the previous seal's head is not the record before this export");
        if (first !== undefined && first.seal.prevSealHash !== sealHash(previousSeal)) {
          problems.push(`${label(first)} does not link to the previous seal`);
        }
      } else if (first !== undefined) {
        problems.push("the previous seal is missing");
      }
      for (let i = 1; i < bundle.seals.length; i += 1) {
        const entry = bundle.seals[i] as BundleSeal;
        const before = bundle.seals[i - 1] as BundleSeal;
        if (entry.seal.prevSealHash !== sealHash(before.seal)) problems.push(`${label(entry)} does not link to ${label(before)}`);
      }
      return outcome(problems, `${bundle.seals.length} seals link to the one before`);
    }),
  );

  checks.push(
    check("epochs", () => {
      const problems: string[] = [];
      const byId = new Map<string, string>(); // epoch id -> statement hash
      let before: BundleSeal | undefined;
      for (const entry of bundle.seals) {
        const hash = statementHash(entry.epoch);
        const known = byId.get(entry.epoch.epochId);
        if (known !== undefined && known !== hash) {
          problems.push(`${label(entry)}: epoch ${entry.epoch.epochId} appears with two different statements`);
        }
        byId.set(entry.epoch.epochId, known ?? hash);
        if (before !== undefined) {
          if (entry.epoch.epochId < before.epoch.epochId || Date.parse(entry.epoch.closedAt) < Date.parse(before.epoch.closedAt)) {
            problems.push(`${label(entry)}: epoch ${entry.epoch.epochId} is earlier than epoch ${before.epoch.epochId} of the seal before`);
          }
        }
        before = entry;
      }
      return outcome(problems, `${byId.size} distinct epochs, each with one statement, in order`);
    }),
  );

  checks.push(
    check("inclusion", () => {
      const problems: string[] = [];
      for (const entry of bundle.seals) {
        if (entry.epoch.epochId !== entry.seal.epochId) {
          problems.push(`${label(entry)} names epoch ${entry.seal.epochId} but is shown in ${entry.epoch.epochId}`);
          continue;
        }
        if (entry.inclusion.size !== entry.epoch.sealCount || entry.inclusion.index >= entry.epoch.sealCount) {
          problems.push(`${label(entry)}: the proof is for a tree of ${entry.inclusion.size}, not the epoch's ${entry.epoch.sealCount} seals`);
          continue;
        }
        const ok = verifyInclusion({
          leafData: sealLeafData(entry.seal),
          index: entry.inclusion.index,
          size: entry.inclusion.size,
          path: entry.inclusion.path,
          root: entry.epoch.sealsRoot,
        });
        if (!ok) problems.push(`${label(entry)} is not in the seals root of epoch ${entry.epoch.epochId}`);
      }
      return outcome(problems, `${bundle.seals.length} seals are in their epochs' seals roots`);
    }),
  );

  // Timestamps and coverage, per seal entry.
  // Status is keyed by the statement's hash, never its epoch id: a statement that merely reuses a
  // stamped epoch's id gets none of that epoch's time.
  const stamped = new Map<string, string>(); // statement hash -> earliest own valid genTime
  const covered = new Map<string, string>(); // statement hash -> earliest covering genTime
  const seen: Array<{ hash: string; epochId: string }> = []; // distinct statements in bundle order
  const timestampProblems: string[] = [];
  const coverageProblems: string[] = [];
  const unverifiable: string[] = [];
  const notes = { timestampsChecked: 0, covers: 0 };
  for (const entry of bundle.seals) {
    const epochId = entry.epoch.epochId;
    const key = statementHash(entry.epoch);
    if (!seen.some((item) => item.hash === key)) seen.push({ hash: key, epochId });
    const lastRecordedAt = bySeq.get(entry.seal.toSeq)?.recordedAt;
    try {
      const own = checkTokens(entry.timestamps, key, options.anchors, lastRecordedAt, `epoch ${epochId}`);
      notes.timestampsChecked += entry.timestamps.length;
      timestampProblems.push(...own.problems);
      unverifiable.push(...own.unverifiable);
      const bound = earliest(own.valid);
      if (bound !== undefined && (!stamped.has(key) || Date.parse(bound) < Date.parse(stamped.get(key) as string))) {
        stamped.set(key, bound);
      }
    } catch (error) {
      timestampProblems.push(`epoch ${epochId}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (entry.coveredBy !== undefined) {
      try {
        const { epochs, timestamps } = entry.coveredBy;
        const brokenBefore = coverageProblems.length;
        if (epochs.length === 0) coverageProblems.push(`epoch ${epochId}: coveredBy lists no epochs`);
        let previousId = epochId;
        let previousHash = statementHash(entry.epoch);
        for (const next of epochs) {
          if (next.prevEpochId !== previousId || next.prevStatementHash !== previousHash) {
            coverageProblems.push(`epoch ${epochId}: epoch ${next.epochId} does not chain to epoch ${previousId} by its previous statement hash`);
          }
          previousId = next.epochId;
          previousHash = statementHash(next);
        }
        const covering: EpochStatementV1 | undefined = epochs[epochs.length - 1];
        if (covering !== undefined) {
          const result = checkTokens(timestamps, statementHash(covering), options.anchors, lastRecordedAt, `epoch ${epochId} covered by ${covering.epochId},`);
          notes.covers += 1;
          coverageProblems.push(...result.problems);
          unverifiable.push(...result.unverifiable);
          const bound = earliest(result.valid);
          if (bound !== undefined && coverageProblems.length === brokenBefore) {
            if (!covered.has(key) || Date.parse(bound) < Date.parse(covered.get(key) as string)) covered.set(key, bound);
          }
        }
      } catch (error) {
        coverageProblems.push(`epoch ${epochId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  checks.push(
    check("timestamps", () =>
      outcome(timestampProblems, `${notes.timestampsChecked} tokens checked against the pinned roots; ${stamped.size} epochs have a valid timestamp of their own`),
    ),
  );
  checks.push(
    check("coverage", () =>
      outcome(coverageProblems, `${notes.covers} covering chains checked; ${[...covered.keys()].filter((hash) => !stamped.has(hash)).length} epochs are covered by a later epoch`),
    ),
  );

  checks.push(
    check("details", () => {
      const problems: string[] = [];
      const list = bundle.details ?? [];
      for (const detail of list) {
        const record = bySeq.get(detail.seq);
        const commit = record?.details.find((entry) => entry.subject === detail.subject)?.commit;
        if (record === undefined) {
          problems.push(`detail for seq ${detail.seq}: the record is not in the export`);
        } else if (commit === undefined) {
          problems.push(`detail for seq ${detail.seq}: the record has no commitment for ${detail.subject}`);
        } else if (!("erased" in detail)) {
          const salt = Uint8Array.from(Buffer.from(detail.salt, "hex"));
          if (detailCommit(salt, detail.subject, detail.fields) !== commit) {
            problems.push(`detail for seq ${detail.seq} (${detail.subject}) does not match its commitment`);
          }
        }
      }
      const shown = list.filter((entry) => !("erased" in entry)).length;
      return outcome(problems, `${shown} details match their commitments; ${list.length - shown} erased`);
    }),
  );

  const coveredEpochs = seen.filter((item) => !stamped.has(item.hash) && covered.has(item.hash)).map((item) => item.epochId);
  const epochsWithoutTimestamp = seen
    .filter((item) => !stamped.has(item.hash) && !covered.has(item.hash))
    .map((item) => item.epochId);
  const bounds = seen.flatMap((item) => {
    const own = stamped.get(item.hash);
    return own !== undefined ? [own] : covered.has(item.hash) ? [covered.get(item.hash) as string] : [];
  });
  const timestampedThrough = latest(bounds);

  const lockModes: LockMode[] = [];
  const noteLock = (mode: LockMode): void => {
    if (!lockModes.includes(mode)) lockModes.push(mode);
  };
  for (const entry of bundle.seals) {
    noteLock(entry.sealObject.lockMode);
    noteLock(entry.recordsObject.lockMode);
    noteLock(entry.epochObject.lockMode);
    for (const stamp of entry.timestamps) noteLock(stamp.object.lockMode);
    for (const stamp of entry.coveredBy?.timestamps ?? []) noteLock(stamp.object.lockMode);
  }

  return {
    ok: checks.every((entry) => entry.ok),
    checks,
    sealedThroughSeq,
    unsealedCount: all.filter((record) => record.seq > sealedThroughSeq).length,
    ...(timestampedThrough === undefined ? {} : { timestampedThrough }),
    coveredEpochs,
    epochsWithoutTimestamp,
    unverifiedAuthorities: [...new Set(unverifiable)],
    lockModes,
  };
}
