// Customer test AWS account, lane TA2: is this record really a notification SNS delivered for one of Rovara's callback topics? (customer-test-account.md section 1; the callback is the one place a stranger's data meets Rovara.)
//
// What is checked, in this order, before the body is looked at by anything else:
//   1. the record is a `Notification` (a subscription or unsubscribe confirmation is refused and its URL is never visited: that URL is attacker-shaped input);
//   2. the topic is exactly one of Rovara's own callback topics (`allowedTopicArns`: this deployment's account, the shared topic name, one per Region), and the delivery's subscription belongs to it;
//   3. the message is not larger than a custom resource request can be, and is not stale (a replayed old delivery) or from the future;
//   4. the signing certificate's URL is `https://sns.<the topic's Region>.amazonaws.com/SimpleNotificationService-<id>.pem`, with no port, credentials or query, so a message cannot make Rovara fetch a key from anywhere else;
//   5. the signature (SignatureVersion 2 only: SHA-256) over the canonical string verifies with that certificate's key, and the certificate is within its validity.
// This proves SNS delivered the message for OUR topic. It does not prove who published it: the topic takes publishes from any AWS account. That is the connect token's job (callback.ts). Checking both is what makes a forged
// or replayed callback useless.
//
// A failure is a fixed code, never text from the record. A certificate that cannot be fetched is transient (`SnsTransientError`): the caller lets SNS retry the delivery. Everything else is final.
import { X509Certificate, createVerify, type KeyObject } from "node:crypto";

export const SNS_MAX_MESSAGE_BYTES = 64 * 1024;
export const SNS_MAX_AGE_MS = 10 * 60_000;
export const SNS_MAX_FUTURE_MS = 5 * 60_000;
const CERT_PATH = /^\/SimpleNotificationService-[0-9A-Za-z]{8,64}\.pem$/u;
const TOPIC_ARN = /^arn:aws:sns:([a-z]{2}(?:-[a-z]+)+-\d):(\d{12}):[A-Za-z0-9_-]{1,256}$/u;

export type SnsRefusal = "not_notification" | "topic" | "too_large" | "timestamp" | "cert_url" | "signature_version" | "signature" | "malformed";

export class SnsTransientError extends Error {
  constructor() {
    super("the SNS signing certificate could not be fetched");
    this.name = "SnsTransientError";
  }
}

/** The part of a Lambda SNS event record this reads. Every field is untrusted until the signature verifies. */
export interface SnsEventRecord {
  EventSubscriptionArn?: unknown;
  Sns?: {
    Type?: unknown;
    MessageId?: unknown;
    TopicArn?: unknown;
    Subject?: unknown;
    Message?: unknown;
    Timestamp?: unknown;
    SignatureVersion?: unknown;
    Signature?: unknown;
    SigningCertUrl?: unknown;
    SigningCertURL?: unknown;
  };
}

export type SnsVerdict = { ok: true; message: string; topicArn: string; topicRegion: string } | { ok: false; code: SnsRefusal };

export interface SnsVerifierConfig {
  /** Exactly Rovara's callback topics. An empty set refuses everything. */
  allowedTopicArns: ReadonlySet<string>;
  now: () => number;
  /** The signing certificate's public key, fetched from the (already checked) URL. Throws `SnsTransientError` when it cannot be fetched. Returns undefined when what came back is not a usable, in-date certificate. */
  publicKey: (certUrl: string) => Promise<KeyObject | undefined>;
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** The string SNS signs for a Notification: the present fields among Message, MessageId, Subject, Timestamp, TopicArn, Type, each as a name line and a value line. */
export function snsCanonicalString(fields: { Message: string; MessageId: string; Subject?: string; Timestamp: string; TopicArn: string }): string {
  const parts: Array<[string, string]> = [["Message", fields.Message], ["MessageId", fields.MessageId]];
  if (fields.Subject !== undefined) parts.push(["Subject", fields.Subject]);
  parts.push(["Timestamp", fields.Timestamp], ["TopicArn", fields.TopicArn], ["Type", "Notification"]);
  return parts.map(([name, value]) => `${name}\n${value}\n`).join("");
}

/** The signing certificate URL SNS uses for a topic in `region`, or false. */
export function isSnsCertUrl(value: string, region: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // The URL must already be in its normal form (no dot segments, no escapes): what is checked is exactly what is fetched.
  return url.href === value && url.protocol === "https:" && url.hostname === `sns.${region}.amazonaws.com` && url.port === "" && url.username === "" && url.password === "" && url.search === "" && url.hash === "" && CERT_PATH.test(url.pathname);
}

export function createSnsVerifier(config: SnsVerifierConfig): (record: SnsEventRecord) => Promise<SnsVerdict> {
  const refuse = (code: SnsRefusal): SnsVerdict => ({ ok: false, code });
  return async (record) => {
    if (record === null || typeof record !== "object") return refuse("malformed");
    const sns = record.Sns;
    if (sns === null || typeof sns !== "object") return refuse("malformed");
    if (sns.Type !== "Notification") return refuse("not_notification");
    const topicArn = text(sns.TopicArn);
    if (topicArn === undefined || !config.allowedTopicArns.has(topicArn)) return refuse("topic");
    const topic = TOPIC_ARN.exec(topicArn);
    if (topic === null) return refuse("topic");
    const subscription = text(record.EventSubscriptionArn);
    if (subscription !== undefined && !subscription.startsWith(`${topicArn}:`)) return refuse("topic");
    const message = text(sns.Message);
    const messageId = text(sns.MessageId);
    const timestamp = text(sns.Timestamp);
    const signature = text(sns.Signature);
    const certUrl = text(sns.SigningCertUrl) ?? text(sns.SigningCertURL);
    if (message === undefined || messageId === undefined || timestamp === undefined || signature === undefined || certUrl === undefined) return refuse("malformed");
    const subject = sns.Subject === null || sns.Subject === undefined ? undefined : text(sns.Subject);
    if (sns.Subject !== null && sns.Subject !== undefined && subject === undefined) return refuse("malformed");
    if (Buffer.byteLength(message, "utf8") > SNS_MAX_MESSAGE_BYTES) return refuse("too_large");
    const sentAt = Date.parse(timestamp);
    const now = config.now();
    if (!Number.isFinite(sentAt) || now - sentAt > SNS_MAX_AGE_MS || sentAt - now > SNS_MAX_FUTURE_MS) return refuse("timestamp");
    const topicRegion = topic[1] as string;
    if (!isSnsCertUrl(certUrl, topicRegion)) return refuse("cert_url");
    // Only version 2 (SHA-256): Rovara's topics are set to it (infra/lib/test-access-callback.ts), and a SHA-1 signature is never accepted.
    if (sns.SignatureVersion !== "2") return refuse("signature_version");
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(signature) || signature.length > 4096) return refuse("signature");
    const key = await config.publicKey(certUrl);
    if (key === undefined) return refuse("signature");
    const canonical = snsCanonicalString({ Message: message, MessageId: messageId, ...(subject === undefined ? {} : { Subject: subject }), Timestamp: timestamp, TopicArn: topicArn });
    let valid: boolean;
    try {
      valid = createVerify("RSA-SHA256").update(canonical, "utf8").verify(key, Buffer.from(signature, "base64"));
    } catch {
      valid = false;
    }
    return valid ? { ok: true, message, topicArn, topicRegion } : refuse("signature");
  };
}

/** The most bytes of a signing certificate read (a real one is about 2 KB). */
export const CERT_MAX_BYTES = 16 * 1024;

/** Reads a body up to `max` bytes and stops there: a larger body is cancelled and gives undefined, so a hostile or broken response never fills memory. */
async function readCapped(stream: ReadableStream<Uint8Array> | null, max: number): Promise<string | undefined> {
  if (stream === null) return undefined;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface CertificateLoaderConfig {
  fetch: (url: string, init: { redirect: "error"; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; body: ReadableStream<Uint8Array> | null }>;
  now(): number;
  cacheMs?: number;
  timeoutMs?: number;
  maxEntries?: number;
}

/** Fetches and caches signing certificates: only a URL `isSnsCertUrl` accepted is ever passed in. A response that is large, is not a certificate, or is out of date gives undefined. The cache is small and short. */
export function certificateLoader(config: CertificateLoaderConfig): (url: string) => Promise<KeyObject | undefined> {
  const cache = new Map<string, { key: KeyObject; at: number }>();
  const cacheMs = config.cacheMs ?? 60 * 60_000;
  const maxEntries = config.maxEntries ?? 16;
  return async (url) => {
    const cached = cache.get(url);
    if (cached !== undefined && config.now() - cached.at < cacheMs) return cached.key;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 5_000);
    let body: string;
    try {
      const response = await config.fetch(url, { redirect: "error", signal: controller.signal });
      if (response.status >= 400 && response.status < 500) return undefined;
      if (!response.ok) throw new SnsTransientError();
      const read = await readCapped(response.body, CERT_MAX_BYTES);
      // A body over the cap is not a certificate: it is dropped without being read further.
      if (read === undefined) return undefined;
      body = read;
    } catch {
      throw new SnsTransientError();
    } finally {
      clearTimeout(timer);
    }
    if (!body.includes("-----BEGIN CERTIFICATE-----")) return undefined;
    let key: KeyObject;
    try {
      const certificate = new X509Certificate(body);
      // SNS signs with a certificate issued to its own name.
      if (!/(?:^|\n)CN=sns(?:\.[a-z0-9-]+)?\.amazonaws\.com(?:\n|$)/u.test(certificate.subject)) return undefined;
      const now = config.now();
      if (now < Date.parse(certificate.validFrom) || now > Date.parse(certificate.validTo)) return undefined;
      key = certificate.publicKey;
    } catch {
      return undefined;
    }
    if (cache.size >= maxEntries) cache.delete(cache.keys().next().value as string);
    cache.set(url, { key, at: config.now() });
    return key;
  };
}
