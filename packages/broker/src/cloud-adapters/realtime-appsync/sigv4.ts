// A SigV4 signature for one JSON POST to the events API (service `appsync`). It is the same algorithm, header set and canonical form as the hosted broker signs with today (so the one request a hosted
// publish makes and the one this adapter makes are byte for byte the same for the same input); `tests/unit/cloud-realtime-appsync.test.ts` checks it against the AWS SDK's own signer.
import { createHash, createHmac } from "node:crypto";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | undefined;
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const hmac = (key: Buffer | string, value: string): Buffer => createHmac("sha256", key).update(value, "utf8").digest();

/** The headers of a SigV4-signed POST of `body` to `url` for `service`: `content-type`, `x-amz-date`, `x-amz-security-token` when there is one, and `authorization` (`host` is signed but left to the HTTP client). */
export function signedHeaders(input: { url: URL; body: string; region: string; service: string; credentials: AwsCredentials; at: Date }): Record<string, string> {
  const stamp = input.at.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}/u, "");
  const day = stamp.slice(0, 8);
  const headers: Record<string, string> = { "content-type": "application/json", host: input.url.host, "x-amz-date": stamp };
  if (input.credentials.sessionToken !== undefined) headers["x-amz-security-token"] = input.credentials.sessionToken;
  // SigV4 wants the signed headers sorted by name; sorted here whatever order they are added in.
  const names = Object.keys(headers).sort();
  const canonical = ["POST", input.url.pathname, input.url.search.slice(1), ...names.map((name) => `${name}:${headers[name]!.trim()}`), "", names.join(";"), sha256(input.body)].join("\n");
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, day), input.region), input.service), "aws4_request");
  const { host: _host, ...sent } = headers; // eslint-disable-line @typescript-eslint/no-unused-vars -- the HTTP client sets Host from the URL; it is signed but not sent
  return { ...sent, authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${createHmac("sha256", key).update(toSign, "utf8").digest("hex")}` };
}
