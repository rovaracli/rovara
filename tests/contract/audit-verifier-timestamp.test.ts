import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import { findSignerCertificates, parseCertificate, parseSignedData } from "../../packages/audit-verifier/src/cms.js";
import {
  DerError,
  bytesToHex,
  children,
  encodeOid,
  hexToBytes,
  integerValue,
  oidValue,
  parseDer,
  timeValue,
  type DerNode,
} from "../../packages/audit-verifier/src/der.js";
import {
  buildTimeStampRequest,
  parseTimeStampResponse,
  verifyTimeStampToken,
} from "../../packages/audit-verifier/src/timestamp.js";
import { defaultAnchors } from "../../packages/audit-verifier/src/trust.js";
import { DIGICERT_ROOT_PEM, SECTIGO_ROOT_PEM } from "../../packages/audit-verifier/src/trust-roots.js";
import {
  OIDS,
  buildResponse,
  buildToken,
  issueCertificate,
  makePki,
  makeSigner,
  newKey,
  type Authority,
  type CertSpec,
  type FakePki,
} from "../support/fake-tsa.js";
import {
  REAL_TIMESTAMP_HASH_HEX,
  REAL_TIMESTAMP_NONCE,
  REAL_TIMESTAMP_RESPONSES,
} from "../support/real-timestamp-responses.js";

const HASH_HEX = "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03";

function realResponse(label: "digicert" | "sectigo"): Uint8Array {
  return new Uint8Array(Buffer.from(REAL_TIMESTAMP_RESPONSES[label].base64, "base64"));
}

describe("the DER reader", () => {
  it("decodes object identifiers, including long arcs and the 2.x first-arc form", () => {
    for (const oid of ["1.2.840.113549.1.9.16.2.47", "2.16.840.1.101.3.4.2.1", "2.999.3", "1.3.6.1.4.1.6449.2.1.1", "0.9.2342"]) {
      expect(oidValue(parseDer(encodeOid(oid)))).toBe(oid);
    }
    expect(() => oidValue(parseDer(hexToBytes("060480808001")))).toThrow(DerError); // padded arc
    expect(() => oidValue(parseDer(hexToBytes("06028180")))).toThrow(DerError); // ends inside an arc
  });

  it("decodes signed integers", () => {
    expect(integerValue(parseDer(hexToBytes("020100")))).toBe(0n);
    expect(integerValue(parseDer(hexToBytes("0201ff")))).toBe(-1n);
    expect(integerValue(parseDer(hexToBytes("02020080")))).toBe(128n);
    expect(integerValue(parseDer(hexToBytes("02020100")))).toBe(256n);
  });

  it("decodes UTCTime with the RFC 5280 century rule and GeneralizedTime with a fraction", () => {
    const utc = (text: string) => parseDer(Uint8Array.of(0x17, text.length, ...new TextEncoder().encode(text)));
    const generalized = (text: string) => parseDer(Uint8Array.of(0x18, text.length, ...new TextEncoder().encode(text)));
    expect(timeValue(utc("491231235959Z")).toISOString()).toBe("2049-12-31T23:59:59.000Z");
    expect(timeValue(utc("500101000000Z")).toISOString()).toBe("1950-01-01T00:00:00.000Z");
    expect(timeValue(generalized("20261020120000.25Z")).toISOString()).toBe("2026-10-20T12:00:00.250Z");
    expect(() => timeValue(generalized("20261301120000Z"))).toThrow(DerError); // month 13
    expect(() => timeValue(generalized("20260230120000Z"))).toThrow(DerError); // 30 February
    expect(() => timeValue(generalized("20261020120000+0100"))).toThrow(DerError); // not UTC
  });

  it("refuses lengths that overrun, indefinite lengths and multi-byte tags", () => {
    for (const hex of ["3005", "30820100", "3080", "1f0100", "04"]) {
      expect(() => parseDer(hexToBytes(hex))).toThrow(DerError);
    }
  });
});

describe("buildTimeStampRequest", () => {
  it("encodes exactly what `openssl ts -query -sha256 -cert` encodes for the same imprint and nonce", () => {
    // Produced by: openssl ts -query -data <"hello\n"> -sha256 -cert (nonce 0x602DEB9C5C38F887), xxd -p
    const fromOpenssl =
      "30430201013031300d0609608648016503040201050004205891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be030208602deb9c5c38f8870101ff";
    expect(bytesToHex(buildTimeStampRequest(REAL_TIMESTAMP_HASH_HEX, REAL_TIMESTAMP_NONCE))).toBe(fromOpenssl);
  });

  it("round-trips: version 1, SHA-256 imprint, the nonce, certReq TRUE", () => {
    const nonce = 0xfedcba9876543210n; // high bit set: needs a leading zero byte
    const request = parseDer(buildTimeStampRequest(HASH_HEX, nonce));
    const [version, imprint, requestNonce, certReq] = children(request) as [DerNode, DerNode, DerNode, DerNode];
    expect(integerValue(version)).toBe(1n);
    const [algorithm, digest] = children(imprint) as [DerNode, DerNode];
    expect(oidValue(children(algorithm)[0] as DerNode)).toBe("2.16.840.1.101.3.4.2.1");
    expect(bytesToHex(digest.content)).toBe(HASH_HEX);
    expect(integerValue(requestNonce)).toBe(nonce);
    expect(bytesToHex(certReq.raw)).toBe("0101ff");
  });

  it("encodes a small nonce and a zero nonce as minimal integers", () => {
    expect(bytesToHex(buildTimeStampRequest(HASH_HEX, 7n))).toContain("020107");
    expect(bytesToHex(buildTimeStampRequest(HASH_HEX, 0n))).toContain("020100");
  });

  it("refuses an imprint that is not 64 lowercase hex characters and a nonce outside 0..2^64-1", () => {
    expect(() => buildTimeStampRequest("abcd", 1n)).toThrow(TypeError);
    expect(() => buildTimeStampRequest(HASH_HEX.toUpperCase(), 1n)).toThrow(TypeError);
    expect(() => buildTimeStampRequest(HASH_HEX, -1n)).toThrow(RangeError);
    expect(() => buildTimeStampRequest(HASH_HEX, 1n << 64n)).toThrow(RangeError);
  });
});

describe("parseTimeStampResponse", () => {
  const pki = makePki("Parse");
  const token = buildToken({ signer: pki.signer, hashHex: HASH_HEX, nonce: 7n });

  it("reads a granted response and hands back the token bytes untouched", () => {
    const parsed = parseTimeStampResponse(buildResponse(0, token));
    expect(parsed.status).toBe(0);
    expect(parsed.token).toBeDefined();
    expect(bytesToHex(parsed.token as Uint8Array)).toBe(bytesToHex(token));
  });

  it("reads grantedWithMods as status 1 with a token", () => {
    const parsed = parseTimeStampResponse(buildResponse(1, token));
    expect(parsed.status).toBe(1);
    expect(parsed.token).toBeDefined();
  });

  it("reads a rejection: status 2, no token", () => {
    const parsed = parseTimeStampResponse(buildResponse(2));
    expect(parsed).toEqual({ status: 2 });
  });

  it("refuses a granted response without a token and a rejection that carries one", () => {
    expect(() => parseTimeStampResponse(buildResponse(0))).toThrow(DerError);
    expect(() => parseTimeStampResponse(buildResponse(2, token))).toThrow(DerError);
  });

  it("reads the real responses captured from DigiCert and Sectigo", () => {
    for (const label of ["digicert", "sectigo"] as const) {
      const parsed = parseTimeStampResponse(realResponse(label));
      expect(parsed.status).toBe(0);
      expect(parsed.token).toBeDefined();
      expect(parseSignedData(parsed.token as Uint8Array).eContentType).toBe("1.2.840.113549.1.9.16.1.4");
    }
  });

  it("throws DerError for truncated, padded and non-DER input", () => {
    const whole = buildResponse(0, token);
    for (const cut of [0, 1, 2, 5, whole.length >> 1, whole.length - 1]) {
      expect(() => parseTimeStampResponse(whole.subarray(0, cut))).toThrow(DerError);
    }
    expect(() => parseTimeStampResponse(Uint8Array.of(...whole, 0))).toThrow(DerError);
    expect(() => parseTimeStampResponse(Uint8Array.of(0x30, 0x80, 0x00, 0x00))).toThrow(DerError); // indefinite length
    expect(() => parseTimeStampResponse(new TextEncoder().encode("<html>502</html>"))).toThrow(DerError);
    expect(() => parseTimeStampResponse(Uint8Array.of(0x30, 0x03, 0x02, 0x01, 0x09))).toThrow(DerError); // status 9
  });
});

describe("parseSignedData and the signer identifier", () => {
  const pki: FakePki = makePki("Signer");

  it("finds the signer by issuerAndSerialNumber", () => {
    const token = buildToken({ signer: pki.signer, hashHex: HASH_HEX, certificates: [pki.ca, pki.signer] });
    const signedData = parseSignedData(token);
    expect(signedData.signerInfo.identifier.kind).toBe("issuerAndSerialNumber");
    expect(signedData.certificates).toHaveLength(2);
    const found = findSignerCertificates(signedData);
    expect(found.map(bytesToHex)).toEqual([bytesToHex(pki.signer.der)]);
  });

  it("finds the signer by subjectKeyIdentifier", () => {
    const token = buildToken({
      signer: pki.signer,
      hashHex: HASH_HEX,
      certificates: [pki.signer, pki.ca],
      signerIdentifier: "subjectKeyIdentifier",
    });
    const signedData = parseSignedData(token);
    expect(signedData.signerInfo.identifier.kind).toBe("subjectKeyIdentifier");
    const found = findSignerCertificates(signedData);
    expect(found.map(bytesToHex)).toEqual([bytesToHex(pki.signer.der)]);
  });

  it("does not match a certificate that only shares the serial number or only the issuer", () => {
    const other = makePki("Other");
    const token = buildToken({ signer: pki.signer, hashHex: HASH_HEX, certificates: [other.signer, other.ca] });
    expect(findSignerCertificates(parseSignedData(token))).toEqual([]);
  });

  it("finds nothing when the message carries no certificates", () => {
    const token = buildToken({ signer: pki.signer, hashHex: HASH_HEX, certificates: [] });
    expect(findSignerCertificates(parseSignedData(token))).toEqual([]);
  });

  it("finds the signer in the real DigiCert and Sectigo tokens (issuerAndSerialNumber or key identifier)", () => {
    for (const label of ["digicert", "sectigo"] as const) {
      const signedData = parseSignedData(parseTimeStampResponse(realResponse(label)).token as Uint8Array);
      const found = findSignerCertificates(signedData);
      expect(found).toHaveLength(1);
      expect(parseCertificate(found[0] as Uint8Array).subject.length).toBeGreaterThan(10);
    }
  });

  it("rejects a message that is not SignedData or is cut short", () => {
    expect(() => parseSignedData(Uint8Array.of(0x30, 0x00))).toThrow(DerError);
    const token = buildToken({ signer: pki.signer, hashHex: HASH_HEX });
    expect(() => parseSignedData(token.subarray(0, token.length - 3))).toThrow(DerError);
  });
});

// ---- RFC 3161 and RFC 5816 checks ----

const NONCE = 7n;

function verify(token: Uint8Array, anchors: readonly { x509: X509Certificate }[], input: { hashHex?: string; nonce?: bigint | null } = {}) {
  return verifyTimeStampToken(token, {
    hashHex: input.hashHex ?? HASH_HEX,
    ...(input.nonce === null ? {} : { nonce: input.nonce ?? NONCE }),
    anchors: anchors.map((a) => a.x509),
  });
}

function problemOf(result: ReturnType<typeof verify>): string {
  return result.ok ? "ok" : result.problem;
}

/** A token chained root -> ca -> signer with the CA certificates in the message. */
function standardToken(pki: FakePki, extra: Partial<Parameters<typeof buildToken>[0]> = {}): Uint8Array {
  return buildToken({
    signer: pki.signer,
    hashHex: HASH_HEX,
    nonce: NONCE,
    certificates: [pki.signer, pki.ca],
    ...extra,
  });
}

describe("verifyTimeStampToken: a valid token", () => {
  const pki = makePki("Valid");

  it("verifies and reports the time, the TSA and the serial number", () => {
    const result = verify(standardToken(pki), [pki.root]);
    expect(result).toEqual({
      ok: true,
      genTime: "2026-10-20T12:00:00.000Z",
      tsa: "O=Fake TSA Test, CN=Valid Test TSA Signer",
      serialHex: "1234abcd",
    });
  });

  it("verifies without a nonce when none was requested, and with the root absent from the message", () => {
    const token = buildToken({ signer: pki.signer, hashHex: HASH_HEX, certificates: [pki.signer, pki.ca] });
    expect(problemOf(verify(token, [pki.root], { nonce: null }))).toBe("ok");
  });

  it("accepts a pinned intermediate as the anchor", () => {
    expect(problemOf(verify(standardToken(pki), [pki.ca]))).toBe("ok");
  });

  it("finds the signer by subject key identifier", () => {
    const token = standardToken(pki, { signerIdentifier: "subjectKeyIdentifier" });
    expect(problemOf(verify(token, [pki.root]))).toBe("ok");
  });

  it("accepts the ESSCertID (SHA-1) attribute alone, and both attributes together", () => {
    expect(problemOf(verify(standardToken(pki, { signingCertificate: "v1" }), [pki.root]))).toBe("ok");
    expect(problemOf(verify(standardToken(pki, { signingCertificate: "both" }), [pki.root]))).toBe("ok");
  });

  it("accepts ESSCertIDv2 with SHA-384 and with an issuerSerial", () => {
    expect(problemOf(verify(standardToken(pki, { essHash: "sha384" }), [pki.root]))).toBe("ok");
    expect(problemOf(verify(standardToken(pki, { essIssuerSerial: true }), [pki.root]))).toBe("ok");
  });

  it.each(["sha256", "sha384", "sha512"] as const)("accepts ECDSA with %s", (hash) => {
    expect(problemOf(verify(standardToken(pki, { hash }), [pki.root]))).toBe("ok");
  });

  describe("with an RSA signer", () => {
    const rsa = makePki("Rsa", { signerKeyKind: "rsa" });

    it.each(["default", "rsaEncryption", "rsa-pss"] as const)("accepts RSA signature scheme %s", (signatureScheme) => {
      for (const hash of ["sha256", "sha512"] as const) {
        const token = standardToken(rsa, { signatureScheme, hash });
        expect(problemOf(verify(token, [rsa.root]))).toBe("ok");
      }
    });

    it("refuses an RSA signature made with another RSA key", () => {
      const other = makePki("OtherRsa", { signerKeyKind: "rsa" });
      const forged = { ...rsa.signer, privateKey: other.signer.privateKey };
      expect(problemOf(verify(standardToken(rsa, { signer: forged }), [rsa.root]))).toBe("signature");
    });
  });
});

describe("verifyTimeStampToken: message imprint and nonce", () => {
  const pki = makePki("Imprint");

  it("another hash is `imprint`", () => {
    const other = HASH_HEX.replace(/^5/, "6");
    expect(problemOf(verify(standardToken(pki), [pki.root], { hashHex: other }))).toBe("imprint");
  });

  it("an imprint made with another hash algorithm is `imprint`", () => {
    const token = standardToken(pki, { imprintHash: "sha384" });
    expect(problemOf(verify(token, [pki.root]))).toBe("imprint");
  });

  it("nonce 8 where 7 was sent is `nonce`", () => {
    expect(problemOf(verify(standardToken(pki), [pki.root], { nonce: 8n }))).toBe("nonce");
  });

  it("a token without a nonce, where one was sent, is `nonce`", () => {
    const token = buildToken({ signer: pki.signer, hashHex: HASH_HEX, certificates: [pki.signer, pki.ca] });
    expect(problemOf(verify(token, [pki.root]))).toBe("nonce");
  });

  it("the imprint is checked before the nonce", () => {
    const other = HASH_HEX.replace(/^5/, "6");
    expect(problemOf(verify(standardToken(pki), [pki.root], { hashHex: other, nonce: 8n }))).toBe("imprint");
  });
});

describe("verifyTimeStampToken: malformed input", () => {
  const pki = makePki("Malformed");
  const token = standardToken(pki);

  it("empty, truncated, padded and unrelated input is `malformed`, never a throw", () => {
    for (const bad of [
      new Uint8Array(0),
      token.subarray(0, 10),
      token.subarray(0, token.length - 1),
      Uint8Array.of(...token, 0),
      new TextEncoder().encode("not a token"),
      Uint8Array.of(0x30, 0x80, 0, 0),
    ]) {
      expect(problemOf(verify(bad, [pki.root]))).toBe("malformed");
    }
  });

  it("an eContentType other than id-ct-TSTInfo is `malformed`", () => {
    expect(problemOf(verify(standardToken(pki, { eContentType: "1.2.840.113549.1.7.1" }), [pki.root]))).toBe("malformed");
  });

  it("signed attributes without a content-type attribute are `malformed`", () => {
    expect(problemOf(verify(standardToken(pki, { omitContentType: true }), [pki.root]))).toBe("malformed");
  });

  it("a truncation at every length never throws", () => {
    for (let cut = 0; cut < token.length; cut += 7) {
      expect(problemOf(verify(token.subarray(0, cut), [pki.root]))).toBe("malformed");
    }
  });
});

describe("verifyTimeStampToken: the signer and its signature", () => {
  const pki = makePki("Signature");
  const other = makePki("Impostor");

  it("a signing-certificate attribute naming another certificate is `signature` (v2, v1 and both)", () => {
    for (const signingCertificate of ["v2", "v1", "both"] as const) {
      const token = standardToken(pki, { signingCertificate, essCertificate: other.signer.der });
      expect(problemOf(verify(token, [pki.root]))).toBe("signature");
    }
  });

  it("a token without any signing-certificate attribute is `signature`", () => {
    expect(problemOf(verify(standardToken(pki, { signingCertificate: "none" }), [pki.root]))).toBe("signature");
  });

  it("an ESS issuerSerial with another serial number is `signature`", () => {
    const token = standardToken(pki, { essIssuerSerial: { serial: pki.signer.serial + 1n } });
    expect(problemOf(verify(token, [pki.root]))).toBe("signature");
  });

  it("an ESS hash algorithm we do not accept (SHA-1 in ESSCertIDv2) is `signature`", () => {
    // ESSCertIDv2 with an explicit SHA-1 algorithm is refused: v2 exists to leave SHA-1 behind.
    const token = standardToken(pki, { signingCertificate: "v2", essHash: "sha1" });
    expect(problemOf(verify(token, [pki.root]))).toBe("signature");
  });

  it("a messageDigest attribute that is not the digest of the content is `signature`", () => {
    const token = standardToken(pki, { messageDigestOverride: new Uint8Array(32) });
    expect(problemOf(verify(token, [pki.root]))).toBe("signature");
  });

  it("a flipped signature bit is `signature`", () => {
    expect(problemOf(verify(standardToken(pki, { corruptSignature: true }), [pki.root]))).toBe("signature");
  });

  it("a changed genTime (content altered after signing) is `signature`", () => {
    const token = Uint8Array.from(standardToken(pki));
    const text = new TextDecoder("latin1").decode(token);
    const at = text.indexOf("20261020120000Z");
    expect(at).toBeGreaterThan(0);
    token[at + 13] = "1".charCodeAt(0);
    expect(problemOf(verify(token, [pki.root]))).toBe("signature");
  });

  it("a signature made with a key that is not the certificate's is `signature`", () => {
    const forged = { ...pki.signer, privateKey: other.signer.privateKey };
    expect(problemOf(verify(standardToken(pki, { signer: forged }), [pki.root]))).toBe("signature");
  });

  it("a message without the signer's certificate is `signature`", () => {
    const token = standardToken(pki, { certificates: [pki.ca] });
    expect(problemOf(verify(token, [pki.root]))).toBe("signature");
  });

  it("a certificate that only looks like the signer (same name and serial, other key) is not used", () => {
    // An impostor certificate with the signer's issuer and serial number, signed by the same CA,
    // but with another key: the ESS certificate hash names the real signer, not this one.
    const lookalike = issueCertificate({
      commonName: "Signature Test TSA Signer",
      issuer: pki.ca,
      serial: pki.signer.serial,
      keyUsage: ["digitalSignature"],
      extendedKeyUsage: { oids: [OIDS.timeStamping], critical: true },
    });
    const token = standardToken(pki, { certificates: [lookalike, pki.ca] });
    expect(problemOf(verify(token, [pki.root]))).toBe("signature");
  });
});

describe("verifyTimeStampToken: the signer certificate's extended key usage", () => {
  const pki = makePki("Eku");
  const make = (extendedKeyUsage?: { oids: readonly string[]; critical: boolean }) =>
    issueCertificate({
      commonName: "Eku Test TSA Signer",
      issuer: pki.ca,
      keyUsage: ["digitalSignature"],
      ...(extendedKeyUsage === undefined ? {} : { extendedKeyUsage }),
    });
  const tokenFor = (signer: Authority) =>
    buildToken({ signer, hashHex: HASH_HEX, nonce: NONCE, certificates: [signer, pki.ca] });

  it("critical id-kp-timeStamping alone is accepted", () => {
    expect(problemOf(verify(tokenFor(make({ oids: [OIDS.timeStamping], critical: true })), [pki.root]))).toBe("ok");
  });

  it.each([
    ["no extended key usage", undefined],
    ["non-critical timeStamping", { oids: [OIDS.timeStamping], critical: false }],
    ["timeStamping with another purpose", { oids: [OIDS.timeStamping, OIDS.serverAuth], critical: true }],
    ["another purpose only", { oids: [OIDS.serverAuth], critical: true }],
    ["anyExtendedKeyUsage", { oids: [OIDS.anyExtendedKeyUsage], critical: true }],
  ] as const)("%s is `eku`", (_label, usage) => {
    expect(problemOf(verify(tokenFor(make(usage)), [pki.root]))).toBe("eku");
  });
});

describe("verifyTimeStampToken: the certificate chain", () => {
  const pki = makePki("Chain");

  // A CA with no path length limit, so that only the middle certificate under test can fail the chain.
  const upper = issueCertificate({
    commonName: "Chain Test Upper",
    issuer: pki.root,
    basicConstraints: { ca: true },
    keyUsage: ["keyCertSign"],
  });

  /** root -> upper -> middle (built from `spec`) -> signer, with every certificate in the message. */
  function throughMiddle(spec: Omit<CertSpec, "commonName" | "issuer">): Uint8Array {
    const middle = issueCertificate({ commonName: "Chain Test Middle", issuer: upper, ...spec });
    const signer = makeSigner(middle, "Chain Test Leaf");
    return buildToken({ signer, hashHex: HASH_HEX, nonce: NONCE, certificates: [signer, middle, upper] });
  }

  it("the same shape with a proper CA in the middle is accepted (control for the cases below)", () => {
    const token = throughMiddle({ basicConstraints: { ca: true }, keyUsage: ["keyCertSign"] });
    expect(problemOf(verify(token, [pki.root]))).toBe("ok");
  });

  it("a chain through a non-CA intermediate is `chain`", () => {
    // A certificate with only digitalSignature, no basicConstraints: it signed the TSA certificate anyway.
    expect(problemOf(verify(throughMiddle({ keyUsage: ["digitalSignature"] }), [pki.root]))).toBe("chain");
  });

  it.each([
    ["cA FALSE (with keyCertSign)", { basicConstraints: { ca: false }, keyUsage: ["keyCertSign"] }],
    ["no basicConstraints (with keyCertSign)", { keyUsage: ["keyCertSign"] }],
    ["cA TRUE but keyUsage without keyCertSign", { basicConstraints: { ca: true }, keyUsage: ["digitalSignature"] }],
    ["cA TRUE and no keyUsage at all", { basicConstraints: { ca: true } }],
    [
      "an extended key usage that does not allow timestamping",
      {
        basicConstraints: { ca: true },
        keyUsage: ["keyCertSign"],
        extendedKeyUsage: { oids: [OIDS.serverAuth], critical: false },
      },
    ],
  ] as const)("an intermediate with %s is `chain`", (_label, spec) => {
    expect(problemOf(verify(throughMiddle(spec), [pki.root]))).toBe("chain");
  });

  it("an intermediate whose extended key usage is timestamping or anyExtendedKeyUsage is accepted", () => {
    for (const oids of [[OIDS.timeStamping], [OIDS.anyExtendedKeyUsage], [OIDS.serverAuth, OIDS.timeStamping]]) {
      const token = throughMiddle({
        basicConstraints: { ca: true },
        keyUsage: ["keyCertSign"],
        extendedKeyUsage: { oids, critical: false },
      });
      expect(problemOf(verify(token, [pki.root]))).toBe("ok");
    }
  });

  it("pathLenConstraint is respected: pathLen 0 forbids one intermediate below, pathLen 1 allows it", () => {
    const root = issueCertificate({ commonName: "Len Root", basicConstraints: { ca: true }, keyUsage: ["keyCertSign"] });
    const run = (pathLen: number) => {
      const upper = issueCertificate({
        commonName: "Len Upper",
        issuer: root,
        basicConstraints: { ca: true, pathLen },
        keyUsage: ["keyCertSign"],
      });
      const lower = issueCertificate({
        commonName: "Len Lower",
        issuer: upper,
        basicConstraints: { ca: true },
        keyUsage: ["keyCertSign"],
      });
      const signer = makeSigner(lower, "Len Signer");
      const token = buildToken({ signer, hashHex: HASH_HEX, nonce: NONCE, certificates: [signer, lower, upper] });
      return problemOf(verify(token, [root]));
    };
    expect(run(0)).toBe("chain");
    expect(run(1)).toBe("ok");
  });

  it("the anchor itself must be a CA that may sign certificates", () => {
    const noCaRoot = issueCertificate({ commonName: "Bad Root", keyUsage: ["digitalSignature"] });
    const ca = issueCertificate({
      commonName: "Bad Root CA",
      issuer: noCaRoot,
      basicConstraints: { ca: true },
      keyUsage: ["keyCertSign"],
    });
    const signer = makeSigner(ca, "Bad Root Signer");
    const token = buildToken({ signer, hashHex: HASH_HEX, nonce: NONCE, certificates: [signer, ca] });
    expect(problemOf(verify(token, [noCaRoot]))).toBe("chain");
  });

  it("every certificate must be valid at genTime", () => {
    const early = new Date("2020-01-01T00:00:00Z");
    const before = new Date("2026-06-01T00:00:00Z");
    const after = new Date("2026-12-01T00:00:00Z");
    const late = new Date("2035-01-01T00:00:00Z");
    const cases: Array<[string, Partial<CertSpec>, "root" | "ca" | "signer"]> = [
      ["signer expired", { notBefore: early, notAfter: before }, "signer"],
      ["signer not yet valid", { notBefore: after, notAfter: late }, "signer"],
      ["CA expired", { notBefore: early, notAfter: before }, "ca"],
      ["CA not yet valid", { notBefore: after, notAfter: late }, "ca"],
      ["root expired", { notBefore: early, notAfter: before }, "root"],
    ];
    for (const [label, window, which] of cases) {
      const root = issueCertificate({
        commonName: "Time Root",
        basicConstraints: { ca: true },
        keyUsage: ["keyCertSign"],
        ...(which === "root" ? window : {}),
      });
      const ca = issueCertificate({
        commonName: "Time CA",
        issuer: root,
        basicConstraints: { ca: true },
        keyUsage: ["keyCertSign"],
        ...(which === "ca" ? window : {}),
      });
      const signer = makeSigner(ca, "Time Signer", undefined, which === "signer" ? window : {});
      const token = buildToken({ signer, hashHex: HASH_HEX, nonce: NONCE, certificates: [signer, ca] });
      expect(problemOf(verify(token, [root])), label).toBe("chain");
    }
  });

  it("validity is judged at genTime, not at today's date", () => {
    // Valid in 2026 only; today (the test run) may be later. The token says 2026-10-20.
    const root = issueCertificate({
      commonName: "Window Root",
      basicConstraints: { ca: true },
      keyUsage: ["keyCertSign"],
      notBefore: new Date("2026-10-01T00:00:00Z"),
      notAfter: new Date("2026-10-30T00:00:00Z"),
    });
    const signer = makeSigner(root, "Window Signer", undefined, {
      notBefore: new Date("2026-10-01T00:00:00Z"),
      notAfter: new Date("2026-10-30T00:00:00Z"),
    });
    const token = buildToken({ signer, hashHex: HASH_HEX, nonce: NONCE, certificates: [signer] });
    expect(problemOf(verify(token, [root]))).toBe("ok");
  });

  it("an unknown root is `untrusted`, and so is no anchor at all", () => {
    const stranger = makePki("Stranger");
    expect(problemOf(verify(standardToken(pki), [stranger.root]))).toBe("untrusted");
    expect(problemOf(verify(standardToken(pki), []))).toBe("untrusted");
  });

  it("a missing intermediate is `untrusted`", () => {
    const token = buildToken({ signer: pki.signer, hashHex: HASH_HEX, nonce: NONCE, certificates: [pki.signer] });
    expect(problemOf(verify(token, [pki.root]))).toBe("untrusted");
  });

  it("an intermediate that claims the root as issuer but was signed by another key is `untrusted`", () => {
    const rogue = newKey("ec");
    const forgedCa = issueCertificate({
      commonName: "Forged CA",
      issuer: { ...pki.root, privateKey: rogue.privateKey },
      basicConstraints: { ca: true },
      keyUsage: ["keyCertSign"],
    });
    const signer = makeSigner(forgedCa, "Forged Signer");
    const token = buildToken({ signer, hashHex: HASH_HEX, nonce: NONCE, certificates: [signer, forgedCa] });
    expect(problemOf(verify(token, [pki.root]))).toBe("untrusted");
  });

  it("a certificate put in the message is never trusted just for being there", () => {
    const stranger = makePki("Planted");
    const token = buildToken({
      signer: stranger.signer,
      hashHex: HASH_HEX,
      nonce: NONCE,
      certificates: [stranger.signer, stranger.ca, stranger.root],
    });
    expect(problemOf(verify(token, [pki.root]))).toBe("untrusted");
  });

  it("a token labelled for one authority does not chain to another authority's root", () => {
    const digicert = makePki("DigiCertTest");
    const sectigo = makePki("SectigoTest");
    const anchors = { digicert: [digicert.root], sectigo: [sectigo.root] };
    const sectigoToken = standardToken(sectigo);
    expect(problemOf(verify(sectigoToken, anchors.sectigo))).toBe("ok");
    expect(problemOf(verify(sectigoToken, anchors.digicert))).toBe("untrusted");
  });
});

describe("pinned roots and the real tokens", () => {
  const anchors = defaultAnchors();

  it("pins one root per authority, self-signed CAs with the fingerprints recorded in the PEM headers", () => {
    const pinned = {
      digicert: {
        subject: "C=US\nO=DigiCert Inc\nOU=www.digicert.com\nCN=DigiCert Trusted Root G4",
        fingerprint:
          "55:2F:7B:DC:F1:A7:AF:9E:6C:E6:72:01:7F:4F:12:AB:F7:72:40:C7:8E:76:1A:C2:03:D1:D9:D2:0A:C8:99:88",
      },
      sectigo: {
        subject: "C=GB\nO=Sectigo Limited\nCN=Sectigo Public Time Stamping Root R46",
        fingerprint:
          "49:41:B0:01:B8:A9:7E:96:1B:78:17:C9:D9:E9:60:EC:4B:05:6B:FC:91:5A:8C:1A:AB:F6:EF:6B:3A:C0:46:A5",
      },
    } as const;
    expect(Object.keys(anchors).sort()).toEqual(["digicert", "sectigo"]);
    for (const label of ["digicert", "sectigo"] as const) {
      expect(anchors[label]).toHaveLength(1);
      const root = anchors[label][0] as X509Certificate;
      expect(root.subject).toBe(pinned[label].subject);
      expect(root.fingerprint256).toBe(pinned[label].fingerprint);
      expect(root.ca).toBe(true);
      expect(root.checkIssued(root)).toBe(true);
      const file = readFileSync(new URL(`../../packages/audit-verifier/src/trust/${label}.pem`, import.meta.url), "utf8");
      expect(file).toContain(`SHA-256 fingerprint: ${pinned[label].fingerprint}`);
      expect(file).toContain("Published list:");
      expect(new X509Certificate(file).fingerprint256).toBe(pinned[label].fingerprint);
    }
    expect(DIGICERT_ROOT_PEM).toBe(
      readFileSync(new URL("../../packages/audit-verifier/src/trust/digicert.pem", import.meta.url), "utf8"),
    );
    expect(SECTIGO_ROOT_PEM).toBe(
      readFileSync(new URL("../../packages/audit-verifier/src/trust/sectigo.pem", import.meta.url), "utf8"),
    );
  });

  it.each(["digicert", "sectigo"] as const)("the real %s token verifies against its own label's root", (label) => {
    const token = parseTimeStampResponse(realResponse(label)).token as Uint8Array;
    const result = verifyTimeStampToken(token, {
      hashHex: REAL_TIMESTAMP_HASH_HEX,
      nonce: REAL_TIMESTAMP_NONCE,
      anchors: anchors[label],
    });
    expect(result).toMatchObject({ ok: true, genTime: REAL_TIMESTAMP_RESPONSES[label].genTime });
  });

  it.each([
    ["digicert", "sectigo"],
    ["sectigo", "digicert"],
  ] as const)("the real %s token is `untrusted` against the %s root", (label, wrong) => {
    const token = parseTimeStampResponse(realResponse(label)).token as Uint8Array;
    const result = verifyTimeStampToken(token, {
      hashHex: REAL_TIMESTAMP_HASH_HEX,
      nonce: REAL_TIMESTAMP_NONCE,
      anchors: anchors[wrong],
    });
    expect(problemOf(result)).toBe("untrusted");
  });

  it("the real tokens still fail on a wrong imprint, a wrong nonce and a flipped signature byte", () => {
    const token = parseTimeStampResponse(realResponse("digicert")).token as Uint8Array;
    const base = { hashHex: REAL_TIMESTAMP_HASH_HEX, nonce: REAL_TIMESTAMP_NONCE, anchors: anchors.digicert };
    expect(problemOf(verifyTimeStampToken(token, { ...base, hashHex: HASH_HEX.replace(/^5/, "6") }))).toBe("imprint");
    expect(problemOf(verifyTimeStampToken(token, { ...base, nonce: 1n }))).toBe("nonce");
    // The last byte of the token is the last byte of the signature.
    const flipped = Uint8Array.from(token);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] as number) ^ 0x01;
    expect(problemOf(verifyTimeStampToken(flipped, base))).toBe("signature");
  });
});
