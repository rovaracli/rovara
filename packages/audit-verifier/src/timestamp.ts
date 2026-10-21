/**
 * RFC 3161 time-stamp requests and responses.
 */
import {
  DerError,
  TAG,
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
  parseDer,
  type DerNode,
} from "./der.js";
import { OID } from "./cms.js";

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
