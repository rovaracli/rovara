import { describe, expect, it } from "vitest";
import { findSignerCertificates, parseCertificate, parseSignedData } from "../../packages/audit-verifier/src/cms.js";
import {
  DerError,
  bytesToHex,
  children,
  integerValue,
  oidValue,
  parseDer,
  type DerNode,
} from "../../packages/audit-verifier/src/der.js";
import { buildTimeStampRequest, parseTimeStampResponse } from "../../packages/audit-verifier/src/timestamp.js";
import {
  buildResponse,
  buildToken,
  makePki,
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
