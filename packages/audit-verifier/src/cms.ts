/**
 * Parsing of CMS SignedData (RFC 5652) and of the X.509 fields the verifier reads. Nothing here decides
 * whether anything is trustworthy; timestamp.ts and trust.ts do that with what this module returns.
 *
 * The X.509 reader lives here because choosing the signer (RFC 5652 5.3) needs a certificate's issuer,
 * serial number and subject key identifier.
 */
import {
  DerError,
  TAG,
  booleanValue,
  bytesEqual,
  children,
  contextTag,
  expectSequence,
  expectTag,
  integerValue,
  oidValue,
  parseDer,
  timeValue,
  type DerNode,
} from "./der.js";

export const OID = {
  signedData: "1.2.840.113549.1.7.2",
  tstInfo: "1.2.840.113549.1.9.16.1.4",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingCertificate: "1.2.840.113549.1.9.16.2.12",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
  sha1: "1.3.14.3.2.26",
  sha256: "2.16.840.1.101.3.4.2.1",
  sha384: "2.16.840.1.101.3.4.2.2",
  sha512: "2.16.840.1.101.3.4.2.3",
  subjectKeyIdentifier: "2.5.29.14",
  keyUsage: "2.5.29.15",
  basicConstraints: "2.5.29.19",
  extendedKeyUsage: "2.5.29.37",
  anyExtendedKeyUsage: "2.5.29.37.0",
  timeStamping: "1.3.6.1.5.5.7.3.8",
} as const;

// ---- X.509 ----

export interface CertificateExtension {
  readonly critical: boolean;
  /** The extnValue OCTET STRING content (itself DER). */
  readonly value: Uint8Array;
}

export interface CertificateFields {
  readonly raw: Uint8Array;
  readonly serial: bigint;
  /** The issuer Name exactly as encoded, for byte comparison with a signer identifier. */
  readonly issuer: Uint8Array;
  readonly subject: Uint8Array;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly extensions: ReadonlyMap<string, CertificateExtension>;
}

export function parseCertificate(der: Uint8Array): CertificateFields {
  const certificate = expectSequence(parseDer(der), TAG.sequence, 3, 3);
  const tbs = expectSequence(certificate[0] as DerNode, TAG.sequence, 6);
  let index = 0;
  if ((tbs[0] as DerNode).tag === contextTag(0, true)) index += 1; // version
  const serial = integerValue(tbs[index] as DerNode);
  const issuer = expectTag(tbs[index + 2], TAG.sequence);
  const validity = expectSequence(expectTag(tbs[index + 3], TAG.sequence), TAG.sequence, 2, 2);
  const subject = expectTag(tbs[index + 4], TAG.sequence);
  const notBefore = timeValue(validity[0] as DerNode);
  const notAfter = timeValue(validity[1] as DerNode);
  const extensions = new Map<string, CertificateExtension>();
  const extensionsWrapper = tbs.slice(index + 6).find((node) => node.tag === contextTag(3, true));
  if (extensionsWrapper !== undefined) {
    const list = expectSequence(children(extensionsWrapper)[0] as DerNode, TAG.sequence, 0);
    for (const entry of list) {
      const parts = expectSequence(entry, TAG.sequence, 2, 3);
      const oid = oidValue(parts[0] as DerNode);
      const critical = parts.length === 3 ? booleanValue(parts[1] as DerNode) : false;
      const value = expectTag(parts[parts.length - 1], TAG.octetString).content;
      if (extensions.has(oid)) throw new DerError(`certificate repeats extension ${oid}`);
      extensions.set(oid, { critical, value });
    }
  }
  return { raw: der, serial, issuer: issuer.raw, subject: subject.raw, notBefore, notAfter, extensions };
}

/** The subjectKeyIdentifier extension's key id, when the certificate has one. */
export function subjectKeyIdentifier(certificate: CertificateFields): Uint8Array | undefined {
  const extension = certificate.extensions.get(OID.subjectKeyIdentifier);
  if (extension === undefined) return undefined;
  return expectTag(parseDer(extension.value), TAG.octetString).content;
}

// ---- CMS ----

export type SignerIdentifier =
  | { readonly kind: "issuerAndSerialNumber"; readonly issuer: Uint8Array; readonly serial: bigint }
  | { readonly kind: "subjectKeyIdentifier"; readonly keyId: Uint8Array };

export interface SignerInfo {
  readonly identifier: SignerIdentifier;
  readonly digestAlgorithm: string;
  /** The signedAttrs as encoded in the message, tagged [0]. */
  readonly signedAttributesRaw: Uint8Array;
  readonly attributes: ReadonlyMap<string, readonly DerNode[]>;
  readonly signatureAlgorithm: { readonly oid: string; readonly parameters?: DerNode };
  readonly signature: Uint8Array;
}

export interface SignedData {
  readonly eContentType: string;
  readonly eContent: Uint8Array | undefined;
  /** Every certificate in the message, DER, in the order given. */
  readonly certificates: readonly Uint8Array[];
  readonly signerInfo: SignerInfo;
}

function parseAlgorithm(node: DerNode): { oid: string; parameters?: DerNode } {
  const parts = expectSequence(node, TAG.sequence, 1, 2);
  const oid = oidValue(parts[0] as DerNode);
  const parameters = parts[1];
  return parameters === undefined ? { oid } : { oid, parameters };
}

function parseSignerIdentifier(node: DerNode, version: bigint): SignerIdentifier {
  if (node.tag === TAG.sequence) {
    if (version !== 1n) throw new DerError("issuerAndSerialNumber needs SignerInfo version 1");
    const parts = expectSequence(node, TAG.sequence, 2, 2);
    return {
      kind: "issuerAndSerialNumber",
      issuer: expectTag(parts[0], TAG.sequence).raw,
      serial: integerValue(parts[1] as DerNode),
    };
  }
  if (node.tag === contextTag(0, false)) {
    if (version !== 3n) throw new DerError("subjectKeyIdentifier needs SignerInfo version 3");
    return { kind: "subjectKeyIdentifier", keyId: node.content };
  }
  throw new DerError("unknown SignerIdentifier form");
}

function parseAttributes(node: DerNode): Map<string, DerNode[]> {
  const map = new Map<string, DerNode[]>();
  for (const attribute of children(node)) {
    const parts = expectSequence(attribute, TAG.sequence, 2, 2);
    const oid = oidValue(parts[0] as DerNode);
    if (map.has(oid)) throw new DerError(`attribute ${oid} appears twice`);
    map.set(oid, expectSequence(parts[1] as DerNode, TAG.set, 1));
  }
  return map;
}

/** Parses a ContentInfo holding SignedData with exactly one SignerInfo (RFC 3161 2.4.2). */
export function parseSignedData(der: Uint8Array): SignedData {
  const contentInfo = expectSequence(parseDer(der), TAG.sequence, 2, 2);
  if (oidValue(contentInfo[0] as DerNode) !== OID.signedData) throw new DerError("not SignedData");
  const wrapper = expectTag(contentInfo[1], contextTag(0, true));
  const signedData = expectSequence(children(wrapper)[0] as DerNode, TAG.sequence, 4);
  integerValue(signedData[0] as DerNode); // version
  expectTag(signedData[1], TAG.set); // digestAlgorithms

  const encapsulated = expectSequence(signedData[2] as DerNode, TAG.sequence, 1, 2);
  const eContentType = oidValue(encapsulated[0] as DerNode);
  let eContent: Uint8Array | undefined;
  if (encapsulated[1] !== undefined) {
    const explicit = expectTag(encapsulated[1], contextTag(0, true));
    const octets = children(explicit);
    if (octets.length !== 1) throw new DerError("eContent must hold one OCTET STRING");
    eContent = expectTag(octets[0], TAG.octetString).content;
  }

  const certificates: Uint8Array[] = [];
  let next = 3;
  if ((signedData[next] as DerNode).tag === contextTag(0, true)) {
    for (const entry of children(signedData[next] as DerNode)) {
      if (entry.tag === TAG.sequence) certificates.push(entry.raw);
    }
    next += 1;
  }
  if (signedData[next]?.tag === contextTag(1, true)) next += 1; // crls
  const signerInfos = expectSequence(expectTag(signedData[next], TAG.set), TAG.set, 1, 1);
  if (next + 1 !== signedData.length) throw new DerError("unexpected members after signerInfos");

  const info = expectSequence(signerInfos[0] as DerNode, TAG.sequence, 6, 7);
  const version = integerValue(info[0] as DerNode);
  const identifier = parseSignerIdentifier(info[1] as DerNode, version);
  const digestAlgorithm = parseAlgorithm(info[2] as DerNode).oid;
  const attributesNode = expectTag(info[3], contextTag(0, true));
  const attributes = parseAttributes(attributesNode);
  const signatureAlgorithm = parseAlgorithm(info[4] as DerNode);
  const signature = expectTag(info[5], TAG.octetString).content;
  if (info[6] !== undefined && info[6].tag !== contextTag(1, true)) {
    throw new DerError("unexpected member in SignerInfo");
  }

  return {
    eContentType,
    eContent,
    certificates,
    signerInfo: {
      identifier,
      digestAlgorithm,
      signedAttributesRaw: attributesNode.raw,
      attributes,
      signatureAlgorithm,
      signature,
    },
  };
}

/** The bytes the signature covers: signedAttrs re-tagged from [0] to SET OF (RFC 5652 5.4). */
export function signedAttributesToBeSigned(signerInfo: SignerInfo): Uint8Array {
  const copy = Uint8Array.from(signerInfo.signedAttributesRaw);
  copy[0] = TAG.set;
  return copy;
}

/** The certificates in the message that the SignerIdentifier names; usually one. */
export function findSignerCertificates(signedData: SignedData): Uint8Array[] {
  const identifier = signedData.signerInfo.identifier;
  const found: Uint8Array[] = [];
  for (const der of signedData.certificates) {
    let certificate: CertificateFields;
    try {
      certificate = parseCertificate(der);
    } catch {
      continue; // a malformed bystander certificate cannot be the signer
    }
    if (identifier.kind === "issuerAndSerialNumber") {
      if (certificate.serial === identifier.serial && bytesEqual(certificate.issuer, identifier.issuer)) {
        found.push(der);
      }
    } else {
      let keyId: Uint8Array | undefined;
      try {
        keyId = subjectKeyIdentifier(certificate);
      } catch {
        continue;
      }
      if (keyId !== undefined && bytesEqual(keyId, identifier.keyId)) found.push(der);
    }
  }
  return found;
}
