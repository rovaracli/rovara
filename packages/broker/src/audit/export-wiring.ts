// The two pieces of AWS the broker's export client is wired to, kept apart from broker.ts so that they can be tested:
//  - `exportInvoker`: starting an export is an asynchronous invoke of the export function, and only a 202 means it was accepted;
//  - `exportLinkSigner`: the download link is the SDK's presigned GET, signed with the broker's own credentials, and it is never
//    given a lifetime longer than those credentials have left (a link signed with a role session stops working when the session
//    does, so the answer says how long the link really lasts).
import { InvokeCommand, type LambdaClient } from "@aws-sdk/client-lambda";
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { agentXError } from "@agentx/contracts";
import type { AuditExportClientDeps, AuditExportEvent } from "./export.js";

/** A link with less than this left of the signing credentials is not handed out: it would be dead before it could be used. */
export const AUDIT_LINK_MIN_SECONDS = 60;

export function exportInvoker(lambda: Pick<LambdaClient, "send">, functionName: string): (event: AuditExportEvent) => Promise<void> {
  return async (event) => {
    const response = await lambda.send(new InvokeCommand({ FunctionName: functionName, InvocationType: "Event", Payload: Buffer.from(JSON.stringify(event)) }));
    if (response.StatusCode !== 202) throw new Error(`audit export start answered ${String(response.StatusCode)}`);
  };
}

export function exportLinkSigner(s3: S3Client, now: () => number = Date.now): AuditExportClientDeps["presign"] {
  return async ({ bucket, key, expiresInSeconds }) => {
    const { expiration } = await s3.config.credentials();
    let lifetime = expiresInSeconds;
    if (expiration !== undefined) {
      const left = Math.floor((expiration.getTime() - now()) / 1000);
      // Credentials that are over, about to be, or with an expiration that is no date: the provider renews them for the next call.
      if (!Number.isFinite(left) || left < AUDIT_LINK_MIN_SECONDS) throw agentXError("RUNTIME_UNAVAILABLE", "Rovara can't sign a download link just now. Try again in a minute.");
      lifetime = Math.min(lifetime, left);
    }
    return { url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: lifetime }), expiresInSeconds: lifetime };
  };
}
