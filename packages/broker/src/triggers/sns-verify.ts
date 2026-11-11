// Plan 4 Task 25: verifying that an Amazon SNS message really came from SNS, by AWS's "Verifying the signatures of Amazon SNS messages". SNS signs each message with the private
// key of a certificate it publishes at `https://sns.<region>.amazonaws.com/SimpleNotificationService-<id>.pem`; the message names that URL itself, so the URL is the first thing
// that must not be believed. In order: the message is of a type SNS sends; its `SignatureVersion` is "2" (a SHA256 with RSA signature: version 1 is SHA1, which AWS marks as the
// weaker option, and the setup text asks the person to set the topic to 2); `SigningCertURL` is exactly `https://sns.<the topic's region>.amazonaws.com/<name>.pem` (the host
// and region are built here and compared whole, so a port, a login, a query, a fragment, another region or a lookalike host can't pass); the certificate is fetched from that
// host only (`vendorFetch`: https, no redirect, a size cap, a deadline), parsed, and checked against its dates now; and the signature is checked over the string AWS documents.
// Differences from AWS's page, recorded in the commit message: AWS accepts SignatureVersion 1 as well; the plan, and this code, accept only 2. AWS also lists a chain check, which
// is not done: trust comes from the HTTPS fetch from AWS's own host (a certificate named by a message is never taken from the message, and the host is built here from the topic's
// own region, which must be a real commercial region), the same trust AWS's own SNS message validators place in it, with no check of the certificate's chain.
// Nothing here logs and nothing throws: a message that can't be verified answers false.
import { X509Certificate, verify } from "node:crypto";
import { z } from "zod";
import { SNS_CERT_CACHE_HOURS, SNS_CERT_FETCHES_PER_MINUTE, SNS_CERT_MAX_BYTES, SNS_FETCH_TIMEOUT_MS, SNS_REGION_PATTERN } from "@rovara-code/contracts";
import { vendorFetch } from "../connectors/native/vendor-fetch.js";

const HOUR = 3_600_000;
const MINUTE = 60_000;
const CERTS_KEPT_MAX = 200;
const CONFIRMATION_TYPES = ["SubscriptionConfirmation", "UnsubscribeConfirmation"] as const;
const TYPES = ["Notification", ...CONFIRMATION_TYPES] as const;

const Text = (max: number) => z.string().max(max);
const Raw = z.object({
  Type: Text(64), MessageId: Text(256), TopicArn: Text(512), Message: Text(262_144), Timestamp: Text(64), SignatureVersion: Text(16), Signature: Text(2048), SigningCertURL: Text(1024),
  Subject: Text(1024).optional(), SubscribeURL: Text(2048).optional(), Token: Text(1024).optional(),
}).superRefine((message, context) => {
  if ((CONFIRMATION_TYPES as readonly string[]).includes(message.Type) && (message.SubscribeURL === undefined || message.Token === undefined)) context.addIssue({ code: "custom", message: "a confirmation names its SubscribeURL and Token" });
});

/** The fields of an SNS message that are verified and read: all text, as SNS sends them. */
export type SnsMessage = z.infer<typeof Raw>;

/** The message as SNS sent it, or undefined when it lacks a field or a field is not text. (Whether its type, version and signature are right is `verifySnsMessage`'s.) */
export function parseSnsMessage(body: unknown): SnsMessage | undefined {
  const parsed = Raw.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/** Whether `Type` is one of the three SNS sends. */
export const isConfirmation = (type: string): type is (typeof CONFIRMATION_TYPES)[number] => (CONFIRMATION_TYPES as readonly string[]).includes(type);

/** The string SNS signed: the type's keys in byte-sort order, each as `<key>\n<value>\n`, `Subject` only when the message has one. */
export function snsStringToSign(message: SnsMessage): string {
  const pairs: Array<[string, string | undefined]> = message.Type === "Notification"
    ? [["Message", message.Message], ["MessageId", message.MessageId], ["Subject", message.Subject], ["Timestamp", message.Timestamp], ["TopicArn", message.TopicArn], ["Type", message.Type]]
    : [["Message", message.Message], ["MessageId", message.MessageId], ["SubscribeURL", message.SubscribeURL], ["Timestamp", message.Timestamp], ["Token", message.Token], ["TopicArn", message.TopicArn], ["Type", message.Type]];
  return pairs.filter((pair): pair is [string, string] => pair[1] !== undefined).map(([key, value]) => `${key}\n${value}\n`).join("");
}

const TOPIC_ARN = new RegExp(`^arn:aws:sns:(${SNS_REGION_PATTERN}):\\d{12}:[A-Za-z0-9_.-]{1,256}$`);
const CERT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.pem$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The host SNS serves a topic's certificates and confirmations from: `sns.<region>.amazonaws.com`. Undefined for an ARN that is not a topic of the `aws` partition in a real commercial region (`SNS_REGION_PATTERN`). */
export function snsHostOfTopic(topicArn: string): string | undefined {
  const match = TOPIC_ARN.exec(topicArn);
  return match === null ? undefined : `sns.${match[1]!}.amazonaws.com`;
}

/** The URL of a certificate, when it is exactly `https://<the topic's SNS host>/<name>.pem`. */
export function signingCertUrl(raw: string, topicArn: string): URL | undefined {
  const host = snsHostOfTopic(topicArn);
  const prefix = host === undefined ? undefined : `https://${host}/`;
  if (prefix === undefined || !raw.startsWith(prefix) || !CERT_NAME.test(raw.slice(prefix.length))) return undefined;
  return new URL(raw);
}

/** What one container remembers of certificates: each by URL for `SNS_CERT_CACHE_HOURS`, and when it last fetched one (at most `SNS_CERT_FETCHES_PER_MINUTE` a minute). */
export class SnsCertMemory {
  private readonly certs = new Map<string, { cert: X509Certificate; at: number }>();
  private fetches: number[] = [];

  cached(url: string, now: number): X509Certificate | undefined {
    const found = this.certs.get(url);
    if (found === undefined) return undefined;
    if (now - found.at >= SNS_CERT_CACHE_HOURS * HOUR) {
      this.certs.delete(url);
      return undefined;
    }
    return found.cert;
  }

  remember(url: string, cert: X509Certificate, now: number): void {
    this.certs.delete(url);
    if (this.certs.size >= CERTS_KEPT_MAX) this.certs.delete(this.certs.keys().next().value as string);
    this.certs.set(url, { cert, at: now });
  }

  /** Counts a fetch about to be made; false (and no count) when this minute's allowance is used up. */
  allowFetch(now: number): boolean {
    this.fetches = this.fetches.filter((at) => at > now - MINUTE);
    if (this.fetches.length >= SNS_CERT_FETCHES_PER_MINUTE) return false;
    this.fetches.push(now);
    return true;
  }
}

export interface SnsVerifyDeps {
  memory: SnsCertMemory;
  /** The fetch under the certificate request; defaults to the vendor fetch that refuses non-public addresses. */
  fetch?: typeof fetch;
}

async function certificateOf(deps: SnsVerifyDeps, url: URL, now: number): Promise<X509Certificate | undefined> {
  const kept = deps.memory.cached(url.href, now);
  if (kept !== undefined) return kept;
  if (!deps.memory.allowFetch(now)) return undefined;
  try {
    const answer = await vendorFetch({ url, allowedHosts: [url.hostname], timeoutMs: SNS_FETCH_TIMEOUT_MS, maxBytes: SNS_CERT_MAX_BYTES, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) });
    if (answer.status !== 200 || answer.text === undefined) return undefined;
    const cert = new X509Certificate(answer.text);
    if (cert.publicKey.asymmetricKeyType !== "rsa") return undefined;
    deps.memory.remember(url.href, cert, now);
    return cert;
  } catch {
    return undefined;
  }
}

const withinDates = (cert: X509Certificate, now: number): boolean => now >= Date.parse(cert.validFrom) && now <= Date.parse(cert.validTo);

/** Whether `message` was signed by SNS (see the top of this file). Never throws. */
export async function verifySnsMessage(deps: SnsVerifyDeps, message: SnsMessage, now: number): Promise<boolean> {
  try {
    if (!(TYPES as readonly string[]).includes(message.Type) || message.SignatureVersion !== "2") return false;
    const url = signingCertUrl(message.SigningCertURL, message.TopicArn);
    if (url === undefined || message.Signature === "" || !BASE64.test(message.Signature)) return false;
    const cert = await certificateOf(deps, url, now);
    if (cert === undefined || !withinDates(cert, now)) return false;
    return verify("sha256", Buffer.from(snsStringToSign(message), "utf8"), cert.publicKey, Buffer.from(message.Signature, "base64"));
  } catch {
    return false;
  }
}
