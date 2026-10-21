// A presigned GET URL for one S3 object (AWS Signature Version 4, query string signing, "UNSIGNED-PAYLOAD"). It is here
// because the broker has no other use for a presigner and does not carry the SDK's presigner package for one URL shape. It
// is checked against the worked example in AWS's "Authenticating requests: using query parameters" and against the SDK's own
// signer (tests/contract/audit-export.test.ts).
//
// The URL is signed with the credentials it is given. Credentials of a role session (a session token) make a URL that stops
// working when that session does; the caller asks for no more than AUDIT_EXPORT_URL_SECONDS.
import { createHash, createHmac } from "node:crypto";

export interface PresignCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | undefined;
}

export interface PresignInput {
  bucket: string;
  key: string;
  region: string;
  credentials: PresignCredentials;
  expiresInSeconds: number;
  /** The signing time. */
  now: Date;
  /** The host to sign for. Default: the bucket's virtual-hosted regional endpoint. */
  host?: string;
}

/** RFC 3986 encoding, as SigV4 asks: everything but letters, digits and `-_.~` is percent-encoded. */
function encode(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

const hmac = (key: Buffer | string, data: string): Buffer => createHmac("sha256", key).update(data).digest();

export function presignGetObject(input: PresignInput): string {
  if (!Number.isInteger(input.expiresInSeconds) || input.expiresInSeconds < 1 || input.expiresInSeconds > 604_800) {
    throw new RangeError("a presigned URL lasts from 1 second to 7 days");
  }
  const host = input.host ?? `${input.bucket}.s3.${input.region}.amazonaws.com`;
  const stamp = input.now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = stamp.slice(0, 8);
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const path = `/${input.key.split("/").map(encode).join("/")}`;
  const query: Array<[string, string]> = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${input.credentials.accessKeyId}/${scope}`],
    ["X-Amz-Date", stamp],
    ["X-Amz-Expires", String(input.expiresInSeconds)],
    ...(input.credentials.sessionToken === undefined || input.credentials.sessionToken === "" ? [] : [["X-Amz-Security-Token", input.credentials.sessionToken] as [string, string]]),
    ["X-Amz-SignedHeaders", "host"],
  ];
  const canonicalQuery = query.map(([name, value]) => [encode(name), encode(value)] as const).sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)).map(([name, value]) => `${name}=${value}`).join("&");
  const canonicalRequest = ["GET", path, canonicalQuery, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, day), input.region), "s3"), "aws4_request");
  const signature = hmac(signingKey, stringToSign).toString("hex");
  return `https://${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
