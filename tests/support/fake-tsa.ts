/**
 * A fake time-stamping authority for tests: mints X.509 certificates and RFC 3161 tokens with
 * node:crypto and a small DER writer of its own (deliberately not the verifier's), so the verifier
 * is tested against an independent encoder.
 */
import {
  X509Certificate,
  constants,
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";

// ---- DER writer ----

export type Bytes = Uint8Array;

export function cat(...parts: readonly Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function lengthOf(n: number): Bytes {
  if (n < 0x80) return Uint8Array.of(n);
  const digits: number[] = [];
  for (let rest = n; rest > 0; rest = Math.floor(rest / 256)) digits.unshift(rest % 256);
  return Uint8Array.of(0x80 | digits.length, ...digits);
}

export function tlv(tag: number, ...content: readonly Bytes[]): Bytes {
  const body = cat(...content);
  return cat(Uint8Array.of(tag), lengthOf(body.length), body);
}

export const seq = (...parts: readonly Bytes[]): Bytes => tlv(0x30, ...parts);
export const set = (...parts: readonly Bytes[]): Bytes => tlv(0x31, ...parts);
/** SET OF in DER order: members sorted by their encodings. */
export const setOf = (...parts: readonly Bytes[]): Bytes =>
  set(...[...parts].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
export const ctx = (n: number, ...parts: readonly Bytes[]): Bytes => tlv(0xa0 | n, ...parts);
export const ctxPrimitive = (n: number, content: Bytes): Bytes => tlv(0x80 | n, content);
export const octets = (content: Bytes): Bytes => tlv(0x04, content);
export const nul = (): Bytes => tlv(0x05);
export const bool = (value: boolean): Bytes => tlv(0x01, Uint8Array.of(value ? 0xff : 0));
export const utf8 = (text: string): Bytes => tlv(0x0c, new TextEncoder().encode(text));

export function int(value: bigint): Bytes {
  const digits: number[] = [];
  for (let rest = value; rest > 0n; rest >>= 8n) digits.unshift(Number(rest & 0xffn));
  if (digits.length === 0 || (digits[0] as number) >= 0x80) digits.unshift(0);
  return tlv(0x02, Uint8Array.from(digits));
}

export function oid(dotted: string): Bytes {
  const arcs = dotted.split(".").map(Number);
  const out: number[] = [];
  const push = (arc: number): void => {
    const group = [arc & 0x7f];
    for (let rest = Math.floor(arc / 128); rest > 0; rest = Math.floor(rest / 128)) group.unshift((rest & 0x7f) | 0x80);
    out.push(...group);
  };
  push((arcs[0] as number) * 40 + (arcs[1] as number));
  for (const arc of arcs.slice(2)) push(arc);
  return tlv(0x06, Uint8Array.from(out));
}

export function bitString(content: Bytes, unusedBits: number): Bytes {
  return tlv(0x03, Uint8Array.of(unusedBits), content);
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

export function utcTime(date: Date): Bytes {
  const text = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(
    date.getUTCHours(),
  )}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return tlv(0x17, new TextEncoder().encode(text));
}

export function generalizedTime(date: Date): Bytes {
  const text = `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(
    date.getUTCHours(),
  )}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return tlv(0x18, new TextEncoder().encode(text));
}

// ---- identifiers ----

export const OIDS = {
  commonName: "2.5.4.3",
  organization: "2.5.4.10",
  signedData: "1.2.840.113549.1.7.2",
  tstInfo: "1.2.840.113549.1.9.16.1.4",
  data: "1.2.840.113549.1.7.1",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
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
  serverAuth: "1.3.6.1.5.5.7.3.1",
  rsaEncryption: "1.2.840.113549.1.1.1",
  sha256WithRsa: "1.2.840.113549.1.1.11",
  sha384WithRsa: "1.2.840.113549.1.1.12",
  sha512WithRsa: "1.2.840.113549.1.1.13",
  rsaPss: "1.2.840.113549.1.1.10",
  mgf1: "1.2.840.113549.1.1.8",
  ecdsaSha256: "1.2.840.10045.4.3.2",
  ecdsaSha384: "1.2.840.10045.4.3.3",
  ecdsaSha512: "1.2.840.10045.4.3.4",
} as const;

export type HashName = "sha256" | "sha384" | "sha512";
export type EssHashName = HashName | "sha1";
const HASH_OID: Record<EssHashName, string> = {
  sha1: OIDS.sha1,
  sha256: OIDS.sha256,
  sha384: OIDS.sha384,
  sha512: OIDS.sha512,
};
const RSA_OID: Record<HashName, string> = {
  sha256: OIDS.sha256WithRsa,
  sha384: OIDS.sha384WithRsa,
  sha512: OIDS.sha512WithRsa,
};
const ECDSA_OID: Record<HashName, string> = {
  sha256: OIDS.ecdsaSha256,
  sha384: OIDS.ecdsaSha384,
  sha512: OIDS.ecdsaSha512,
};

const digestOf = (hash: HashName | "sha1", data: Bytes): Buffer => createHash(hash).update(data).digest();
const hashAlgorithm = (hash: EssHashName): Bytes => seq(oid(HASH_OID[hash]), nul());

// ---- keys ----

export type KeyKind = "ec" | "rsa";

export function newKey(kind: KeyKind = "ec"): { privateKey: KeyObject; publicKey: KeyObject } {
  if (kind === "ec") return generateKeyPairSync("ec", { namedCurve: "P-256" });
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

function signatureFor(
  kind: KeyKind,
  hash: HashName,
  data: Bytes,
  key: KeyObject,
): { algorithm: Bytes; signature: Bytes } {
  if (kind === "ec") {
    return { algorithm: seq(oid(ECDSA_OID[hash])), signature: cryptoSign(hash, data, key) };
  }
  return { algorithm: seq(oid(RSA_OID[hash]), nul()), signature: cryptoSign(hash, data, key) };
}

// ---- certificates ----

export function name(commonName: string, organization = "Fake TSA Test"): Bytes {
  const rdn = (type: string, value: string): Bytes => set(seq(oid(type), utf8(value)));
  return seq(rdn(OIDS.organization, organization), rdn(OIDS.commonName, commonName));
}

export interface CertSpec {
  commonName: string;
  /** The issuer; omit for a self-signed certificate. */
  issuer?: Authority;
  keyKind?: KeyKind;
  serial?: bigint;
  notBefore?: Date;
  notAfter?: Date;
  /** basicConstraints; omit the field for no basicConstraints extension at all. */
  basicConstraints?: { ca: boolean; pathLen?: number };
  /** keyUsage names; omit for no keyUsage extension. */
  keyUsage?: readonly ("digitalSignature" | "keyCertSign" | "cRLSign")[];
  /** extendedKeyUsage; omit for none. */
  extendedKeyUsage?: { oids: readonly string[]; critical: boolean };
  /** Hash used to sign this certificate. */
  signatureHash?: HashName;
  /** Omit the subject key identifier extension. */
  noSubjectKeyIdentifier?: boolean;
}

export interface Authority {
  readonly commonName: string;
  readonly keyKind: KeyKind;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly nameDer: Bytes;
  /** The Name of whoever issued this certificate (itself when self-signed). */
  readonly issuerNameDer: Bytes;
  /** The certificate, DER. */
  readonly der: Bytes;
  readonly x509: X509Certificate;
  readonly serial: bigint;
}

const KEY_USAGE_BIT = { digitalSignature: 0, keyCertSign: 5, cRLSign: 6 } as const;

function keyUsageExtension(names: NonNullable<CertSpec["keyUsage"]>): Bytes {
  let byte = 0;
  let highestBit = 0;
  for (const entry of names) {
    const bit = KEY_USAGE_BIT[entry];
    byte |= 0x80 >> bit;
    highestBit = Math.max(highestBit, bit);
  }
  return seq(oid(OIDS.keyUsage), bool(true), octets(bitString(Uint8Array.of(byte), 7 - highestBit)));
}

let serialCounter = 1000n;
export const FAKE_NOT_BEFORE = new Date("2026-01-01T00:00:00Z");
export const FAKE_NOT_AFTER = new Date("2030-01-01T00:00:00Z");
/** The time the fake TSA stamps by default; inside every fake certificate's validity. */
export const FAKE_GEN_TIME = new Date("2026-10-20T12:00:00Z");

export function issueCertificate(spec: CertSpec): Authority {
  const keyKind = spec.keyKind ?? "ec";
  const keys = newKey(keyKind);
  const spki = new Uint8Array(keys.publicKey.export({ type: "spki", format: "der" }));
  const serial = spec.serial ?? (serialCounter += 1n);
  const subject = name(spec.commonName);
  const issuerAuthority = spec.issuer;
  const signingKey = issuerAuthority?.privateKey ?? keys.privateKey;
  const signingKind = issuerAuthority?.keyKind ?? keyKind;
  const hash = spec.signatureHash ?? "sha256";

  const extensions: Bytes[] = [];
  if (spec.noSubjectKeyIdentifier !== true) {
    extensions.push(seq(oid(OIDS.subjectKeyIdentifier), octets(octets(digestOf("sha1", spki)))));
  }
  if (spec.basicConstraints !== undefined) {
    const { ca, pathLen } = spec.basicConstraints;
    extensions.push(
      seq(
        oid(OIDS.basicConstraints),
        bool(true),
        octets(seq(...(ca ? [bool(true)] : []), ...(pathLen === undefined ? [] : [int(BigInt(pathLen))]))),
      ),
    );
  }
  if (spec.keyUsage !== undefined) extensions.push(keyUsageExtension(spec.keyUsage));
  if (spec.extendedKeyUsage !== undefined) {
    const { oids, critical } = spec.extendedKeyUsage;
    extensions.push(
      seq(oid(OIDS.extendedKeyUsage), ...(critical ? [bool(true)] : []), octets(seq(...oids.map((o) => oid(o))))),
    );
  }

  const signatureAlgorithm = signatureFor(signingKind, hash, new Uint8Array(0), signingKey).algorithm;
  const tbs = seq(
    ctx(0, int(2n)),
    int(serial),
    signatureAlgorithm,
    issuerAuthority?.nameDer ?? subject,
    seq(utcTime(spec.notBefore ?? FAKE_NOT_BEFORE), utcTime(spec.notAfter ?? FAKE_NOT_AFTER)),
    subject,
    spki,
    ...(extensions.length > 0 ? [ctx(3, seq(...extensions))] : []),
  );
  const signature = signatureFor(signingKind, hash, tbs, signingKey).signature;
  const der = seq(tbs, signatureAlgorithm, bitString(signature, 0));
  return {
    commonName: spec.commonName,
    keyKind,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    nameDer: subject,
    issuerNameDer: issuerAuthority?.nameDer ?? subject,
    der,
    x509: new X509Certificate(der),
    serial,
  };
}

/** A whole fake hierarchy: root, a CA below it, and a TSA signer below that. */
export interface FakePki {
  readonly root: Authority;
  readonly ca: Authority;
  readonly signer: Authority;
}

export function makePki(label: string, options: { signerKeyKind?: KeyKind } = {}): FakePki {
  const root = issueCertificate({
    commonName: `${label} Test Root`,
    basicConstraints: { ca: true },
    keyUsage: ["keyCertSign", "cRLSign"],
  });
  const ca = issueCertificate({
    commonName: `${label} Test TSA CA`,
    issuer: root,
    basicConstraints: { ca: true, pathLen: 0 },
    keyUsage: ["keyCertSign", "cRLSign"],
    extendedKeyUsage: { oids: [OIDS.timeStamping], critical: false },
  });
  return { root, ca, signer: makeSigner(ca, `${label} Test TSA Signer`, options.signerKeyKind) };
}

export function makeSigner(issuer: Authority, commonName: string, keyKind?: KeyKind, overrides: Partial<CertSpec> = {}): Authority {
  return issueCertificate({
    commonName,
    issuer,
    ...(keyKind === undefined ? {} : { keyKind }),
    keyUsage: ["digitalSignature"],
    extendedKeyUsage: { oids: [OIDS.timeStamping], critical: true },
    ...overrides,
  });
}

// ---- tokens ----

export interface TokenSpec {
  signer: Authority;
  hashHex: string;
  nonce?: bigint;
  genTime?: Date;
  serial?: bigint;
  /** Certificates placed in the message; default is just the signer. */
  certificates?: readonly Authority[];
  signerIdentifier?: "issuerAndSerialNumber" | "subjectKeyIdentifier";
  hash?: HashName;
  /** How the signature algorithm is named. */
  signatureScheme?: "default" | "rsaEncryption" | "rsa-pss";
  /** "v2" (default), "v1", "both", or "none" (leave the signing-certificate attribute out). */
  signingCertificate?: "v2" | "v1" | "both" | "none";
  /** The certificate whose hash the signing-certificate attribute carries; default is the signer's. */
  essCertificate?: Bytes;
  /** Hash of the signing-certificate attribute (ESSCertIDv2); default sha256. */
  essHash?: EssHashName;
  /** Add an issuerSerial to the ESS certificate id. */
  essIssuerSerial?: boolean | { serial: bigint };
  /** Use these bytes as the messageDigest attribute instead of the true digest. */
  messageDigestOverride?: Bytes;
  /** Leave the content-type attribute out. */
  omitContentType?: boolean;
  /** eContentType; default id-ct-TSTInfo. */
  eContentType?: string;
  /** Hash algorithm named in the TSTInfo message imprint; default sha256. Independent of the signature hash. */
  imprintHash?: HashName;
  /** Hash (hex) written into the TSTInfo message imprint instead of `hashHex`. */
  imprintHashHex?: string;
  /** Flip a bit of the signature after signing. */
  corruptSignature?: boolean;
}

function essIssuerSerial(spec: TokenSpec): Bytes[] {
  if (spec.essIssuerSerial === undefined || spec.essIssuerSerial === false) return [];
  const serial = spec.essIssuerSerial === true ? spec.signer.serial : spec.essIssuerSerial.serial;
  return [seq(seq(ctx(4, spec.signer.issuerNameDer)), int(serial))];
}

export function buildTstInfo(
  spec: Pick<TokenSpec, "hashHex" | "nonce" | "genTime" | "serial" | "imprintHashHex" | "imprintHash">,
): Bytes {
  const hash = spec.imprintHash ?? "sha256";
  return seq(
    int(1n),
    oid("1.2.3.4.5"),
    seq(hashAlgorithm(hash), octets(Buffer.from(spec.imprintHashHex ?? spec.hashHex, "hex"))),
    int(spec.serial ?? 0x1234abcdn),
    generalizedTime(spec.genTime ?? FAKE_GEN_TIME),
    ...(spec.nonce === undefined ? [] : [int(spec.nonce)]),
  );
}

export function buildToken(spec: TokenSpec): Bytes {
  const hash = spec.hash ?? "sha256";
  const signer = spec.signer;
  const tstInfo = buildTstInfo(spec);
  const eContentType = spec.eContentType ?? OIDS.tstInfo;

  const attributes: Bytes[] = [];
  if (spec.omitContentType !== true) attributes.push(seq(oid(OIDS.contentType), setOf(oid(eContentType))));
  attributes.push(
    seq(oid(OIDS.messageDigest), setOf(octets(spec.messageDigestOverride ?? digestOf(hash, tstInfo)))),
  );
  const mode = spec.signingCertificate ?? "v2";
  const essSubject = spec.essCertificate ?? signer.der;
  if (mode === "v2" || mode === "both") {
    const essHash = spec.essHash ?? "sha256";
    const certId = seq(
      ...(essHash === "sha256" ? [] : [hashAlgorithm(essHash)]),
      octets(digestOf(essHash, essSubject)),
      ...essIssuerSerial(spec),
    );
    attributes.push(seq(oid(OIDS.signingCertificateV2), setOf(seq(seq(certId)))));
  }
  if (mode === "v1" || mode === "both") {
    const certId = seq(octets(digestOf("sha1", essSubject)), ...essIssuerSerial(spec));
    attributes.push(seq(oid(OIDS.signingCertificate), setOf(seq(seq(certId)))));
  }
  const attributeSet = setOf(...attributes);
  // The signature covers the attributes tagged SET; the message carries them tagged [0].
  const signedAttributes = Uint8Array.from(attributeSet);
  signedAttributes[0] = 0xa0;

  const scheme = spec.signatureScheme ?? "default";
  let signatureAlgorithm: Bytes;
  let signatureValue: Bytes;
  if (signer.keyKind === "ec") {
    const made = signatureFor("ec", hash, attributeSet, signer.privateKey);
    signatureAlgorithm = made.algorithm;
    signatureValue = made.signature;
  } else if (scheme === "rsaEncryption") {
    signatureAlgorithm = seq(oid(OIDS.rsaEncryption), nul());
    signatureValue = cryptoSign(hash, attributeSet, signer.privateKey);
  } else if (scheme === "rsa-pss") {
    const saltLength = digestOf(hash, new Uint8Array(0)).length;
    signatureAlgorithm = seq(
      oid(OIDS.rsaPss),
      seq(
        ctx(0, hashAlgorithm(hash)),
        ctx(1, seq(oid(OIDS.mgf1), hashAlgorithm(hash))),
        ctx(2, int(BigInt(saltLength))),
      ),
    );
    signatureValue = cryptoSign(hash, attributeSet, {
      key: signer.privateKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength,
    });
  } else {
    const made = signatureFor("rsa", hash, attributeSet, signer.privateKey);
    signatureAlgorithm = made.algorithm;
    signatureValue = made.signature;
  }
  if (spec.corruptSignature === true) {
    signatureValue = Uint8Array.from(signatureValue);
    signatureValue[signatureValue.length - 1] = (signatureValue[signatureValue.length - 1] as number) ^ 0x01;
  }

  const identifierKind = spec.signerIdentifier ?? "issuerAndSerialNumber";
  const signerIdentifier =
    identifierKind === "issuerAndSerialNumber"
      ? seq(signer.issuerNameDer, int(signer.serial))
      : ctxPrimitive(0, digestOf("sha1", new Uint8Array(signer.publicKey.export({ type: "spki", format: "der" }))));
  const signerInfo = seq(
    int(identifierKind === "issuerAndSerialNumber" ? 1n : 3n),
    signerIdentifier,
    hashAlgorithm(hash),
    signedAttributes,
    signatureAlgorithm,
    octets(signatureValue),
  );
  const certificates = spec.certificates ?? [signer];
  const signedData = seq(
    int(3n),
    set(hashAlgorithm(hash)),
    seq(oid(eContentType), ctx(0, octets(tstInfo))),
    ...(certificates.length === 0 ? [] : [ctx(0, ...certificates.map((c) => c.der))]),
    set(signerInfo),
  );
  return seq(oid(OIDS.signedData), ctx(0, signedData));
}

/** A TimeStampResp. A granted response carries the token; a rejection carries a status string and failInfo. */
export function buildResponse(status: number, token?: Bytes): Bytes {
  const statusInfo =
    token === undefined && status >= 2
      ? seq(int(BigInt(status)), seq(utf8("request rejected")), bitString(Uint8Array.of(0x80), 7))
      : seq(int(BigInt(status)));
  return seq(statusInfo, ...(token === undefined ? [] : [token]));
}
