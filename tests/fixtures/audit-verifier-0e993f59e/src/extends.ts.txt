/**
 * `--extends`: does a newer export continue an older one you kept, or was history rewritten and
 * re-sealed in between? Both exports should be verified on their own first.
 */
import type { AuditBundleV1 } from "./bundle.js";
import type { OrgSealV1 } from "./record.js";
import { sealHash } from "./record.js";
import { bundleSealedThroughSeq } from "./verify-bundle.js";

function recordHashAt(bundle: AuditBundleV1, seq: number): string | undefined {
  if (bundle.previous.seq === seq) return bundle.previous.hash;
  return [...bundle.records, ...bundle.unsealed].find((record) => record.seq === seq)?.hash;
}

function sealEndingAt(bundle: AuditBundleV1, seq: number): OrgSealV1 | undefined {
  const inside = bundle.seals.find((entry) => entry.seal.toSeq === seq);
  if (inside !== undefined) return inside.seal;
  return bundle.previousSeal !== null && bundle.previousSeal.toSeq === seq ? bundle.previousSeal : undefined;
}

export function verifyExtends(newer: AuditBundleV1, older: AuditBundleV1): { ok: boolean; detail: string } {
  if (newer.orgId !== older.orgId) return { ok: false, detail: "the two exports are for different organizations" };
  const through = bundleSealedThroughSeq(older);
  if (through === 0) return { ok: true, detail: "the older export has nothing sealed, so there is nothing to compare" };
  const newerThrough = bundleSealedThroughSeq(newer);
  if (newerThrough < through) {
    return { ok: false, detail: `the newer export is sealed only through seq ${newerThrough}, the older through seq ${through}` };
  }
  const newerRecord = recordHashAt(newer, through);
  const olderRecord = recordHashAt(older, through);
  if (newerRecord === undefined || olderRecord === undefined) {
    return { ok: false, detail: `the ${newerRecord === undefined ? "newer" : "older"} export does not include the record at seq ${through}` };
  }
  if (newerRecord !== olderRecord) {
    return { ok: false, detail: `the record at seq ${through} has a different hash in the two exports` };
  }
  const newerSeal = sealEndingAt(newer, through);
  const olderSeal = sealEndingAt(older, through);
  if (newerSeal === undefined || olderSeal === undefined) {
    return { ok: false, detail: `the ${newerSeal === undefined ? "newer" : "older"} export has no seal ending at seq ${through}` };
  }
  if (sealHash(newerSeal) !== sealHash(olderSeal)) {
    return { ok: false, detail: `the seal ending at seq ${through} differs between the two exports` };
  }
  return { ok: true, detail: `the newer export keeps the record and seal at seq ${through} from the older one` };
}
