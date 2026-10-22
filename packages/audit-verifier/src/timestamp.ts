/**
 * RFC 3161 time-stamp requests and responses.
 */
import { X509Certificate, constants, createHash, verify as cryptoVerify } from "node:crypto";
import {
  OID,
  findSignerCertificates,
  parseCertificate,
  parseSignedData,
  signedAttributesToBeSigned,
  type CertificateFields,
  type SignerInfo,
} from "./cms.js";
import {
  DerError,
  TAG,
  bytesEqual,
  bytesToHex,
  children,
  contextTag,
  encodeBoolean,
  encodeInteger,
  encodeNull,
  encodeOctetString,
  encodeOid,
  encodeSequence,
  expectSequence,
  expectTag,
  hexToBytes,
  integerValue,
  oidValue,
  parseDer,
  timeValue,
  type DerNode,
} from "./der.js";
import { checkCertificatePath, extendedKeyUsages } from "./trust.js";

const MAX_NONCE = 1n << 64n;

/**
 * A TimeStampReq: version 1, a SHA-256 message imprint, the nonce, certReq TRUE.
 * `hashHex` is the 64 lowercase hex characters of the SHA-256 being stamped.
 */
export function buildTimeStampRequest(hashHex: string, nonce: bigint): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hashHex)) throw new TypeError("timestamp: hash must be 64 lowercase hex characters");
  if (nonce < 0n || nonce >= MAX_NONCE) throw new RangeError("timestamp: nonce must be between 0 and 2^64 - 1");
  return encodeSequence(
    encodeInteger(1n),
    encodeSequence(
      encodeSequence(encodeOid(OID.sha256), encodeNull()),
      encodeOctetString(hexToBytes(hashHex)),
    ),
    encodeInteger(nonce),
    encodeBoolean(true),
  );
}

export interface TimeStampResponse {
  /** PKIStatus: 0 granted, 1 grantedWithMods, 2 rejection, 3 waiting, 4 revocationWarning, 5 revocationNotification. */
  readonly status: number;
  /** The TimeStampToken (a CMS ContentInfo), present exactly when the status is 0 or 1. */
  readonly token?: Uint8Array;
}

/** Reads a TimeStampResp. Throws DerError when it is not a well-formed response. */
export function parseTimeStampResponse(der: Uint8Array): TimeStampResponse {
  const parts = expectSequence(parseDer(der), TAG.sequence, 1, 2);
  const info = expectSequence(parts[0] as DerNode, TAG.sequence, 1, 3);
  const status = integerValue(info[0] as DerNode);
  if (status < 0n || status > 5n) throw new DerError("unknown PKIStatus");
  const granted = status <= 1n;
  const tokenNode = parts[1];
  if (granted && tokenNode === undefined) throw new DerError("granted response without a token");
  if (!granted && tokenNode !== undefined) throw new DerError("refused response carries a token");
  if (tokenNode === undefined) return { status: Number(status) };
  expectTag(tokenNode, TAG.sequence);
  return { status: Number(status), token: tokenNode.raw };
}

// ---- verification ----

export type TimestampProblem = "malformed" | "imprint" | "nonce" | "signature" | "chain" | "eku" | "untrusted";

export type TimestampVerdict =
  | {
      readonly ok: true;
      /** The time the TSA vouches for, ISO 8601 UTC with milliseconds. */
      readonly genTime: string;
      /** The signer certificate's subject, rendered "C=..., O=..., CN=...". */
      readonly tsa: string;
      /** The TSA's serial number for this token, lowercase hex. */
      readonly serialHex: string;
    }
  | { readonly ok: false; readonly problem: TimestampProblem };

export interface TimestampCheckInput {
  /** SHA-256 (64 lowercase hex characters) that the token must stamp. */
  readonly hashHex: string;
  /** The nonce sent in the request, when there was one. */
  readonly nonce?: bigint;
  /** Roots this token may chain to: only those of its own authority label. */
  readonly anchors: readonly X509Certificate[];
}

interface TstInfo {
  readonly imprintAlgorithm: string;
  readonly imprint: Uint8Array;
  readonly serial: bigint;
  readonly genTime: Date;
  readonly nonce?: bigint;
}

/** TSTInfo (RFC 3161 2.4.2): version 1, policy, imprint, serial, genTime, then optional members. */
function parseTstInfo(der: Uint8Array): TstInfo {
  const parts = expectSequence(parseDer(der), TAG.sequence, 5);
  if (integerValue(parts[0] as DerNode) !== 1n) throw new DerError("unsupported TSTInfo version");
  oidValue(parts[1] as DerNode); // policy
  const imprintParts = expectSequence(parts[2] as DerNode, TAG.sequence, 2, 2);
  const imprintAlgorithm = oidValue(expectSequence(imprintParts[0] as DerNode, TAG.sequence, 1, 2)[0] as DerNode);
  const imprint = expectTag(imprintParts[1], TAG.octetString).content;
  const serial = integerValue(parts[3] as DerNode);
  const genTime = timeValue(expectTag(parts[4], TAG.generalizedTime));
  let nonce: bigint | undefined;
  for (const optional of parts.slice(5)) {
    if (optional.tag === TAG.integer) nonce = integerValue(optional); // after accuracy and ordering, before tsa
  }
  return { imprintAlgorithm, imprint, serial, genTime, ...(nonce === undefined ? {} : { nonce }) };
}

const HASHES: Readonly<Record<string, "sha1" | "sha256" | "sha384" | "sha512">> = {
  [OID.sha1]: "sha1",
  [OID.sha256]: "sha256",
  [OID.sha384]: "sha384",
  [OID.sha512]: "sha512",
};
const HASH_BYTES = { sha256: 32, sha384: 48, sha512: 64 } as const;
const SIGNING_HASHES = new Set(["sha256", "sha384", "sha512"]);

/** The hash named by an AlgorithmIdentifier node, or undefined when it is not one we accept. */
function hashOf(oid: string): "sha1" | "sha256" | "sha384" | "sha512" | undefined {
  return HASHES[oid];
}

function digest(hash: "sha1" | "sha256" | "sha384" | "sha512", data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash(hash).update(data).digest());
}

/**
 * Whether the signing-certificate attribute (RFC 2634 ESSCertID, or RFC 5816 ESSCertIDv2) names `certificate`.
 * Only the first certificate id counts: it identifies the signer (RFC 2634 5.4.1).
 */
function essNamesCertificate(
  value: DerNode,
  version: 1 | 2,
  certificate: CertificateFields,
): boolean {
  const signingCertificate = expectSequence(value, TAG.sequence, 1, 2);
  const certIds = expectSequence(signingCertificate[0] as DerNode, TAG.sequence, 1);
  const id = expectSequence(certIds[0] as DerNode, TAG.sequence, 1, 3);
  let index = 0;
  let hash: "sha1" | "sha256" | "sha384" | "sha512" | undefined = version === 1 ? "sha1" : "sha256";
  if (version === 2 && id[0]?.tag === TAG.sequence) {
    const algorithm = expectSequence(id[0], TAG.sequence, 1, 2);
    hash = hashOf(oidValue(algorithm[0] as DerNode));
    index += 1;
  }
  if (hash === undefined || (version === 2 && hash === "sha1")) return false;
  const certHash = expectTag(id[index], TAG.octetString).content;
  if (!bytesEqual(certHash, digest(hash, certificate.raw))) return false;
  const issuerSerial = id[index + 1];
  if (issuerSerial !== undefined) {
    const parts = expectSequence(issuerSerial, TAG.sequence, 2, 2);
    const names = expectSequence(parts[0] as DerNode, TAG.sequence, 1, 1);
    const directory = expectTag(names[0], contextTag(4, true));
    const issuer = children(directory)[0];
    if (issuer === undefined || !bytesEqual(issuer.raw, certificate.issuer)) return false;
    if (integerValue(parts[1] as DerNode) !== certificate.serial) return false;
  }
  return true;
}

/** Hash and Node verify options for the signature algorithm; undefined when the algorithm is not accepted. */
function signatureScheme(
  signerInfo: SignerInfo,
  keyType: string | undefined,
): { hash: "sha256" | "sha384" | "sha512"; pss?: { saltLength: number } } | undefined {
  const { oid, parameters } = signerInfo.signatureAlgorithm;
  const fromDigest = hashOf(signerInfo.digestAlgorithm);
  const accept = (hash: string | undefined): "sha256" | "sha384" | "sha512" | undefined =>
    hash !== undefined && SIGNING_HASHES.has(hash) ? (hash as "sha256" | "sha384" | "sha512") : undefined;
  const table: Readonly<Record<string, { family: "rsa" | "ec"; hash?: string }>> = {
    "1.2.840.113549.1.1.1": { family: "rsa" },
    "1.2.840.113549.1.1.11": { family: "rsa", hash: "sha256" },
    "1.2.840.113549.1.1.12": { family: "rsa", hash: "sha384" },
    "1.2.840.113549.1.1.13": { family: "rsa", hash: "sha512" },
    "1.2.840.10045.2.1": { family: "ec" },
    "1.2.840.10045.4.3.2": { family: "ec", hash: "sha256" },
    "1.2.840.10045.4.3.3": { family: "ec", hash: "sha384" },
    "1.2.840.10045.4.3.4": { family: "ec", hash: "sha512" },
  };
  if (oid === "1.2.840.113549.1.1.10") {
    // RSASSA-PSS (RFC 4055): hash, MGF1 hash and salt length are in the parameters.
    if (keyType !== "rsa" && keyType !== "rsa-pss") return undefined;
    if (parameters === undefined) return undefined;
    let hash: string | undefined;
    let mgfHash: string | undefined;
    let declaredSalt = 20n;
    for (const field of children(parameters)) {
      const inner = children(field)[0];
      if (inner === undefined) return undefined;
      if (field.tag === contextTag(0, true)) {
        hash = HASHES[oidValue(expectSequence(inner, TAG.sequence, 1, 2)[0] as DerNode)];
      } else if (field.tag === contextTag(1, true)) {
        const mgf = expectSequence(inner, TAG.sequence, 2, 2);
        if (oidValue(mgf[0] as DerNode) !== "1.2.840.113549.1.1.8") return undefined;
        mgfHash = HASHES[oidValue(expectSequence(mgf[1] as DerNode, TAG.sequence, 1, 2)[0] as DerNode)];
      } else if (field.tag === contextTag(2, true)) {
        declaredSalt = integerValue(inner);
      } else {
        return undefined; // trailerField other than the default is not used with PSS
      }
    }
    const accepted = accept(hash);
    if (accepted === undefined || mgfHash !== hash) return undefined;
    // RFC 4055: 0 <= saltLength <= the hash length in bytes. A negative value would reach Node as one of
    // its special constants (-2 means "recover the length from the signature").
    if (declaredSalt < 0n || declaredSalt > BigInt(HASH_BYTES[accepted])) return undefined;
    return { hash: accepted, pss: { saltLength: Number(declaredSalt) } };
  }
  const entry = table[oid];
  if (entry === undefined) return undefined;
  if (entry.family === "rsa" ? keyType !== "rsa" : keyType !== "ec") return undefined;
  const hash = accept(entry.hash ?? (fromDigest === undefined ? undefined : fromDigest));
  return hash === undefined ? undefined : { hash };
}

function subjectText(certificate: X509Certificate): string {
  return certificate.subject.split("\n").join(", ");
}

/**
 * Checks an RFC 3161 time-stamp token against the hash it should stamp. In order: the message imprint and
 * nonce; the signer (found by issuer and serial number or by key identifier) with its signed attributes and
 * signing-certificate attribute; the signature; the timestamping-only extended key usage; the certificate
 * chain to one of `anchors`.
 */
export function verifyTimeStampToken(token: Uint8Array, input: TimestampCheckInput): TimestampVerdict {
  const fail = (problem: TimestampProblem): TimestampVerdict => ({ ok: false, problem });
  try {
    // 1. Structure, content type, imprint, nonce.
    const signedData = parseSignedData(token);
    if (signedData.eContentType !== OID.tstInfo || signedData.eContent === undefined) return fail("malformed");
    const tst = parseTstInfo(signedData.eContent);
    if (!/^[0-9a-f]{64}$/.test(input.hashHex)) return fail("imprint"); // the same lowercase SHA-256 hex the request takes
    if (tst.imprintAlgorithm !== OID.sha256 || bytesToHex(tst.imprint) !== input.hashHex) return fail("imprint");
    if (input.nonce !== undefined && tst.nonce !== input.nonce) return fail("nonce");

    // 2. The signer, its signed attributes and the signing-certificate attribute.
    const { signerInfo } = signedData;
    const contentType = signerInfo.attributes.get(OID.contentType);
    if (contentType === undefined || contentType.length !== 1) return fail("malformed");
    if (oidValue(contentType[0] as DerNode) !== signedData.eContentType) return fail("malformed");
    const digestHash = hashOf(signerInfo.digestAlgorithm);
    if (digestHash === undefined || !SIGNING_HASHES.has(digestHash)) return fail("signature");
    const messageDigest = signerInfo.attributes.get(OID.messageDigest);
    if (messageDigest === undefined || messageDigest.length !== 1) return fail("malformed");
    const claimed = expectTag(messageDigest[0], TAG.octetString).content;
    if (!bytesEqual(claimed, digest(digestHash, signedData.eContent))) return fail("signature");

    const v2 = signerInfo.attributes.get(OID.signingCertificateV2);
    const v1 = signerInfo.attributes.get(OID.signingCertificate);
    if (v2 === undefined && v1 === undefined) return fail("signature");
    if ((v2 !== undefined && v2.length !== 1) || (v1 !== undefined && v1.length !== 1)) return fail("malformed");

    const signerDer = findSignerCertificates(signedData).find((der) => {
      const fields = parseCertificate(der);
      return (
        (v2 === undefined || essNamesCertificate(v2[0] as DerNode, 2, fields)) &&
        (v1 === undefined || essNamesCertificate(v1[0] as DerNode, 1, fields))
      );
    });
    if (signerDer === undefined) return fail("signature");
    const signer = parseCertificate(signerDer);
    const signerKey = new X509Certificate(signerDer);

    // 3. The signature over the signed attributes, tagged as a SET.
    const scheme = signatureScheme(signerInfo, signerKey.publicKey.asymmetricKeyType);
    if (scheme === undefined) return fail("signature");
    const toBeSigned = signedAttributesToBeSigned(signerInfo);
    const verified =
      scheme.pss === undefined
        ? cryptoVerify(scheme.hash, toBeSigned, signerKey.publicKey, signerInfo.signature)
        : cryptoVerify(
            scheme.hash,
            toBeSigned,
            { key: signerKey.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: scheme.pss.saltLength },
            signerInfo.signature,
          );
    if (!verified) return fail("signature");

    // 4. The signer certificate: critical extended key usage with id-kp-timeStamping alone (RFC 3161 2.3).
    const eku = signer.extensions.get(OID.extendedKeyUsage);
    const usages = extendedKeyUsages(signer);
    if (eku === undefined || !eku.critical || usages === undefined) return fail("eku");
    if (usages.length !== 1 || usages[0] !== OID.timeStamping) return fail("eku");

    // 5. The chain.
    const chain = checkCertificatePath(signerDer, signedData.certificates, input.anchors, tst.genTime);
    if (chain !== "ok") return fail(chain);

    return {
      ok: true,
      genTime: tst.genTime.toISOString(),
      tsa: subjectText(signerKey),
      serialHex: tst.serial.toString(16),
    };
  } catch {
    // Whatever the input does to the parsers or to node:crypto, a token we cannot read is "malformed".
    return fail("malformed");
  }
}
