/**
 * Which certificates a time-stamp token may chain to: the pinned roots, and the path checks.
 *
 * A token is checked only against the anchors of its own authority label, so a certificate that is
 * trusted for one time-stamping authority gives no trust to a token claiming to be from another.
 */
import { X509Certificate } from "node:crypto";
import { OID, parseCertificate, type CertificateFields } from "./cms.js";
import { DerError, TAG, bitStringBytes, booleanValue, bytesEqual, children, expectSequence, integerValue, oidValue, parseDer, type DerNode } from "./der.js";
import { DIGICERT_ROOT_PEM, SECTIGO_ROOT_PEM } from "./trust-roots.js";

export type AuthorityLabel = "digicert" | "sectigo";

/** The pinned roots per authority. See ./trust/*.pem for where each came from and its fingerprint. */
export function defaultAnchors(): Record<AuthorityLabel, X509Certificate[]> {
  return {
    digicert: [new X509Certificate(DIGICERT_ROOT_PEM)],
    sectigo: [new X509Certificate(SECTIGO_ROOT_PEM)],
  };
}

interface Candidate {
  readonly fields: CertificateFields;
  readonly x509: X509Certificate;
}

function candidate(der: Uint8Array): Candidate | undefined {
  try {
    return { fields: parseCertificate(der), x509: new X509Certificate(der) };
  } catch {
    return undefined; // an unreadable certificate takes no part in a path
  }
}

/** keyUsage has keyCertSign (bit 5). */
function allowsCertificateSigning(fields: CertificateFields): boolean {
  const extension = fields.extensions.get(OID.keyUsage);
  if (extension === undefined) return false;
  const { bytes } = bitStringBytes(parseDer(extension.value));
  return bytes.length > 0 && ((bytes[0] as number) & 0x04) !== 0;
}

/** basicConstraints says cA TRUE; `pathLen` is its constraint when present. */
function basicConstraints(fields: CertificateFields): { ca: boolean; pathLen?: number } | undefined {
  const extension = fields.extensions.get(OID.basicConstraints);
  if (extension === undefined) return undefined;
  const parts = children(parseDer(extension.value));
  let index = 0;
  let ca = false;
  if (parts[index]?.tag === TAG.boolean) {
    ca = booleanValue(parts[index] as DerNode);
    index += 1;
  }
  const next = parts[index];
  if (next === undefined) return { ca };
  const value = integerValue(next);
  if (value < 0n || value > 1000n) throw new DerError("bad pathLenConstraint");
  return { ca, pathLen: Number(value) };
}

export function extendedKeyUsages(fields: CertificateFields): string[] | undefined {
  const extension = fields.extensions.get(OID.extendedKeyUsage);
  if (extension === undefined) return undefined;
  return expectSequence(parseDer(extension.value), TAG.sequence, 1).map((node) => oidValue(node));
}

/** Whether `path[index]` may act as a CA over the `index - 1` intermediates below it, at `at`. */
function validCa(fields: CertificateFields, index: number): boolean {
  try {
    const constraints = basicConstraints(fields);
    if (constraints === undefined || !constraints.ca) return false;
    if (constraints.pathLen !== undefined && index - 1 > constraints.pathLen) return false;
    if (!allowsCertificateSigning(fields)) return false;
    const usages = extendedKeyUsages(fields);
    return usages === undefined || usages.includes(OID.timeStamping) || usages.includes(OID.anyExtendedKeyUsage);
  } catch {
    return false;
  }
}

const MAX_PATH_LENGTH = 8;
const MAX_PATHS = 32;

/**
 * Looks for paths from `signer` to one of `anchors` through `pool` (the certificates that came with the
 * token). "untrusted": no path of correctly signed certificates reaches an anchor. "chain": paths reach an
 * anchor but none passes the CA, path length, key usage and validity checks at `at`.
 */
export function checkCertificatePath(
  signer: Uint8Array,
  pool: readonly Uint8Array[],
  anchors: readonly X509Certificate[],
  at: Date,
): "ok" | "chain" | "untrusted" {
  const leaf = candidate(signer);
  if (leaf === undefined) return "untrusted";
  const anchorCandidates = anchors.flatMap((anchor) => {
    const found = candidate(new Uint8Array(anchor.raw));
    return found === undefined ? [] : [found];
  });
  const poolCandidates = pool.flatMap((der) => {
    const found = candidate(der);
    return found === undefined ? [] : [found];
  });

  const isAnchor = (c: Candidate): boolean => anchorCandidates.some((a) => bytesEqual(a.fields.raw, c.fields.raw));
  const signedBy = (subject: Candidate, issuer: Candidate): boolean => {
    if (!bytesEqual(subject.fields.issuer, issuer.fields.subject)) return false;
    try {
      return subject.x509.verify(issuer.x509.publicKey);
    } catch {
      return false;
    }
  };

  const paths: Candidate[][] = [];
  const walk = (path: Candidate[]): void => {
    if (paths.length >= MAX_PATHS) return;
    const last = path[path.length - 1] as Candidate;
    if (isAnchor(last)) {
      paths.push(path);
      return;
    }
    if (path.length >= MAX_PATH_LENGTH) return;
    for (const issuer of [...anchorCandidates, ...poolCandidates]) {
      if (path.some((member) => bytesEqual(member.fields.raw, issuer.fields.raw))) continue;
      if (signedBy(last, issuer)) walk([...path, issuer]);
    }
  };
  walk([leaf]);

  if (paths.length === 0) return "untrusted";
  const acceptable = paths.some((path) =>
    path.every((member, index) => {
      const valid = member.fields.notBefore <= at && at <= member.fields.notAfter;
      return valid && (index === 0 || validCa(member.fields, index));
    }),
  );
  return acceptable ? "ok" : "chain";
}
