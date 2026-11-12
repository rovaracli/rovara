// Customer test AWS account, lane TA2: SNS record verification and the signing-certificate loader. The fixed vector below is a self-signed test certificate (public) and signatures made once with its key, which is not kept: it proves the
// production path (certificate parse, validity, key, canonical string, both signature versions) end to end. The other cases generate key pairs.
import { generateKeyPairSync, createSign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SNS_MAX_AGE_MS, SnsTransientError, certificateLoader, createSnsVerifier, isSnsCertUrl, snsCanonicalString, type SnsEventRecord } from "../../packages/broker/src/test-access/sns-verify.js";

const TOPIC = "arn:aws:sns:us-west-2:999988887777:agentx-test-access-callback";
const CERT_URL = "https://sns.us-west-2.amazonaws.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem";
const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const TIMESTAMP = "2026-11-12T12:00:00.000Z";
const CERT_PEM = [
  "-----BEGIN CERTIFICATE-----",
  "MIIC+jCCAeKgAwIBAgIUbGfCxXfIJDPtATewRjwfkWx50bwwDQYJKoZIhvcNAQEL",
  "BQAwHDEaMBgGA1UEAwwRc25zLmFtYXpvbmF3cy5jb20wIBcNMjYxMTEyMDcxMTU5",
  "WhgPMjEyNjEwMTkwNzExNTlaMBwxGjAYBgNVBAMMEXNucy5hbWF6b25hd3MuY29t",
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqd9zSMgwpiGy7/dH23AR",
  "tf/7HOeqU6WR18VNy62btoMGXn8C6W5oHixmYi0vXCfDKiBnlpZIqM7hC/j2frxK",
  "h4LjfK8Oy4SQpGoxO2z9hp3hYSIUaOOzC8uP6ZhfdaEYqjHbnYUibjYIcHDkLFnL",
  "gSZS8A2S2BwWJ4HA360fqmK8jq92+ijQfuZNlkyf5Dn8eVhMD3DcRuawYqnXEmBc",
  "1s7bY/C3CCY/faeAO8wfBKnueLtO1uID08WnvuGyuJuEu951dPK/NI7+ssGJbCq3",
  "8Sv6/X3puzZr73msfGUZiTxSZRJPB/vwztGsQ3iOvkxgP0EBfvG/GDQizQgHokJJ",
  "mQIDAQABozIwMDAdBgNVHQ4EFgQUybM25iztdTZW41xDWI0L5h2bTdYwDwYDVR0T",
  "AQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAU7OpStUS+XK+plw1lbRvCqlr",
  "YG6VHBr7BXnuOENLJlvkccaBD6XiHXwIzNa/XvYvd3qFxy5HnJ0MOCcizuijaN5w",
  "PvTqBMFFrwe2JzfBlXgUh+zCessV0R+MZLPRzi6XQOe2JzAkpizPefcUAI4PYQ8b",
  "JxEo9+UZqYJvazFeJZbGiCYeqqC1byAv5sHFHWNI3huRmzMgM3PxV1k5T3Kq9uCV",
  "YY8KgzBnnl665t//ktycDU7QwG5B7qIICG8eoLa+l6UsWGRGsmiYrrl3hMcA4W3M",
  "glJATcz5/Pl+1op3GQ5V1yL4ta2wESjBkBOiDlD10AROvOkFbcKEomQze12bZA==",
  "-----END CERTIFICATE-----"
].join("\n");
const SIG_V1 = "I3SRhcL47vFLHCFNxJXuqpPGTyvhepO1Yhx3bmLB3C5GAnxYv8KG3RHUWM/nmLREwWVl3A5L8ooy1RHAKzVhTlb++1lCW1FUhOcFKo0z2KLld8fzpPsYwGoqqdHvmlQSTjoFQE/gnOumNZ5Nu/AZ88gLCMCp9SjLhBwNNxj84YrmPClMwkGlWcI232FqS0xaeC/hijkYzfb1taMcFgQs0Mk4x05vncbRWG4SY4VEJXQ/Ft7UGr77TWjnNxJqmIek4hI2N7w84Cak4pCnykKpt2WM6XDjuOJ4taR6eCzowJlR3Bc93BYCy6z+wpPnyOAC/RtZO010dD8xidJP1FL0Kw==";
const SIG_V2 = "eWW7zTOF1K0/BJRJ4mhq2TvQl0qsjJwBJCkdUzDbBpOZuuMUCCOhscXM6lPt1+2vz2ff1IO6DrjLZZKiueA1Sl8BNUfCvVS2HG70kdmbdyDWGWSNrrDXFHgSo2pGU/sa+SUBIQPSPk9sYaZ0J54AGdbv3PoMrsXHHC1q9FqUHXvGFYNK/onQ1WjN7/AxkvlHOQNWR0w97uhykjfKeW/bCeUkse1IgcEC1wrBhmntztGJfuVo2psOYBychZkHGfkXiq3NhrVcQ52JbLfzWCIhDBsR22XJ1jSokDE/oz0kQ9Sj8wRjVT4YZgTQqbsR6wEkLBdFekBGDId+3Q3lHcqjtg==";
const VECTOR_MESSAGE = { Message: '{"hello":"world"}', MessageId: "11111111-2222-3333-4444-555555555555", Timestamp: TIMESTAMP, TopicArn: TOPIC };

const record = (over: Record<string, unknown> = {}, sns: Record<string, unknown> = {}): SnsEventRecord => ({
  EventSubscriptionArn: `${TOPIC}:sub-1`,
  Sns: { Type: "Notification", ...VECTOR_MESSAGE, SignatureVersion: "1", Signature: SIG_V1, SigningCertUrl: CERT_URL, Subject: null, ...sns },
  ...over,
});
const loader = (fetchCalls: string[] = [], pem: string = CERT_PEM, now: () => number = () => NOW) => certificateLoader({
  now,
  fetch: (url, init) => {
    fetchCalls.push(`${url}|${init.redirect}`);
    return Promise.resolve({ ok: true, status: 200, body: new Response(pem).body });
  },
});
const verifier = (over: { allowed?: string[]; now?: () => number; publicKey?: (url: string) => Promise<KeyObject | undefined> } = {}) =>
  createSnsVerifier({ allowedTopicArns: new Set(over.allowed ?? [TOPIC]), now: over.now ?? (() => NOW), publicKey: over.publicKey ?? loader() });

describe("the fixed vector (production certificate path)", () => {
  it("verifies a version 2 (SHA-256) signature made with the certificate's key, and refuses version 1 (SHA-1) even when its signature is valid", async () => {
    const verify = verifier();
    expect(await verify(record({}, { SignatureVersion: "2", Signature: SIG_V2 }))).toEqual({ ok: true, message: VECTOR_MESSAGE.Message, topicArn: TOPIC, topicRegion: "us-west-2" });
    expect(await verify(record())).toEqual({ ok: false, code: "signature_version" });
  });

  it("refuses a changed message, a changed topic id, a signature of the other version, and a missing or malformed signature", async () => {
    const verify = verifier();
    const v2 = { SignatureVersion: "2", Signature: SIG_V2 };
    expect(await verify(record({}, { ...v2, Message: '{"hello":"worle"}' }))).toEqual({ ok: false, code: "signature" });
    expect(await verify(record({}, { ...v2, MessageId: "11111111-2222-3333-4444-555555555556" }))).toEqual({ ok: false, code: "signature" });
    expect(await verify(record({}, { SignatureVersion: "2" }))).toEqual({ ok: false, code: "signature" });
    expect(await verify(record({}, { ...v2, Signature: "not base64!" }))).toEqual({ ok: false, code: "signature" });
    expect(await verify(record({}, { ...v2, Signature: undefined }))).toEqual({ ok: false, code: "malformed" });
    for (const SignatureVersion of ["3", "1", 2, undefined]) expect(await verify(record({}, { ...v2, SignatureVersion })), String(SignatureVersion)).toEqual({ ok: false, code: "signature_version" });
    // A subject that was not signed.
    expect(await verify(record({}, { ...v2, Subject: "hello" }))).toEqual({ ok: false, code: "signature" });
  });
});

describe("what is checked before the signature", () => {
  it("refuses a subscription or unsubscribe confirmation and never fetches anything", async () => {
    const fetched: string[] = [];
    const verify = verifier({ publicKey: loader(fetched) });
    for (const Type of ["SubscriptionConfirmation", "UnsubscribeConfirmation", undefined, 5]) expect(await verify(record({}, { Type, SubscribeURL: "https://attacker.example.com/confirm" }))).toEqual({ ok: false, code: "not_notification" });
    expect(fetched).toEqual([]);
  });

  it("refuses a topic that is not exactly one of Rovara's, and a subscription that is not that topic's", async () => {
    const fetched: string[] = [];
    const verify = verifier({ publicKey: loader(fetched) });
    for (const TopicArn of ["arn:aws:sns:us-west-2:111122223333:agentx-test-access-callback", "arn:aws:sns:us-east-1:999988887777:agentx-test-access-callback", `${TOPIC}x`, "", 7]) expect(await verify(record({}, { TopicArn }))).toEqual({ ok: false, code: "topic" });
    expect(await verify(record({ EventSubscriptionArn: "arn:aws:sns:us-west-2:111122223333:other:sub" }))).toEqual({ ok: false, code: "topic" });
    expect(await createSnsVerifier({ allowedTopicArns: new Set(), now: () => NOW, publicKey: loader(fetched) })(record())).toEqual({ ok: false, code: "topic" });
    expect(fetched).toEqual([]);
  });

  it("refuses a signing certificate URL that is not SNS's own in the topic's Region, and fetches nothing from it", async () => {
    const fetched: string[] = [];
    const verify = verifier({ publicKey: loader(fetched) });
    const bad = [
      "http://sns.us-west-2.amazonaws.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem",
      "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem",
      "https://sns.us-west-2.amazonaws.com.attacker.example.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem",
      "https://attacker.example.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem",
      "https://sns.us-west-2.amazonaws.com:8443/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem",
      "https://user@sns.us-west-2.amazonaws.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem",
      "https://sns.us-west-2.amazonaws.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem?x=1",
      "https://sns.us-west-2.amazonaws.com/other.pem",
      "https://sns.us-west-2.amazonaws.com/../SimpleNotificationService-0123456789abcdef0123456789abcdef.pem",
      "https://169.254.169.254/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem",
      "not a url",
    ];
    for (const SigningCertUrl of bad) expect(await verify(record({}, { SigningCertUrl })), SigningCertUrl).toEqual({ ok: false, code: "cert_url" });
    expect(fetched).toEqual([]);
    expect(isSnsCertUrl(CERT_URL, "us-west-2")).toBe(true);
    expect(isSnsCertUrl(CERT_URL, "us-east-1")).toBe(false);
  });

  it("refuses a message that is stale, from the future, or too large", async () => {
    expect(await verifier({ now: () => NOW + SNS_MAX_AGE_MS + 1 })(record())).toEqual({ ok: false, code: "timestamp" });
    expect(await verifier({ now: () => NOW - 6 * 60_000 })(record())).toEqual({ ok: false, code: "timestamp" });
    expect(await verifier()(record({}, { Timestamp: "yesterday" }))).toEqual({ ok: false, code: "timestamp" });
    expect(await verifier()(record({}, { Message: "x".repeat(70 * 1024) }))).toEqual({ ok: false, code: "too_large" });
  });

  it("refuses a record that is not an object or lacks a field", async () => {
    const verify = verifier();
    expect(await verify({})).toEqual({ ok: false, code: "malformed" });
    expect(await verify({ Sns: null } as unknown as SnsEventRecord)).toEqual({ ok: false, code: "malformed" });
    expect(await verify(record({}, { Message: 5 }))).toEqual({ ok: false, code: "malformed" });
    expect(await verify(record({}, { Subject: 5 }))).toEqual({ ok: false, code: "malformed" });
  });
});

describe("with generated keys", () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sign = (fields: { Message: string; MessageId: string; Timestamp: string; TopicArn: string; Subject?: string }, algorithm: string, key = pair.privateKey) => createSign(algorithm).update(snsCanonicalString(fields)).sign(key, "base64");
  const signed = (over: Record<string, unknown> = {}, version: "1" | "2" = "2", key = pair.privateKey): SnsEventRecord => {
    const fields = { Message: "{}", MessageId: "m-1", Timestamp: TIMESTAMP, TopicArn: TOPIC, ...over } as { Message: string; MessageId: string; Timestamp: string; TopicArn: string; Subject?: string };
    return { EventSubscriptionArn: `${TOPIC}:s`, Sns: { Type: "Notification", ...fields, SignatureVersion: version, Signature: sign(fields, version === "1" ? "RSA-SHA1" : "RSA-SHA256", key), SigningCertUrl: CERT_URL } };
  };
  const verify = verifier({ publicKey: () => Promise.resolve(pair.publicKey) });

  it("verifies a signed message with and without a subject, and refuses a signature made with another key", async () => {
    expect(await verify(signed())).toMatchObject({ ok: true, message: "{}" });
    expect(await verify(signed({ Subject: "Hello" }))).toMatchObject({ ok: true });
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(await verify(signed({}, "2", other.privateKey))).toEqual({ ok: false, code: "signature" });
  });

  it("refuses a certificate that cannot be used (no key), and passes a transient fetch fault on", async () => {
    expect(await verifier({ publicKey: () => Promise.resolve(undefined) })(signed())).toEqual({ ok: false, code: "signature" });
    await expect(verifier({ publicKey: () => Promise.reject(new SnsTransientError()) })(signed())).rejects.toBeInstanceOf(SnsTransientError);
  });
});

describe("the certificate loader", () => {
  const response = (status: number, text: string) => ({ ok: status >= 200 && status < 300, status, body: new Response(text).body });

  it("fetches without following redirects, caches for an hour, and then fetches again", async () => {
    const fetched: string[] = [];
    let now = NOW;
    const load = loader(fetched, CERT_PEM, () => now);
    expect(await load(CERT_URL)).toBeDefined();
    expect(await load(CERT_URL)).toBeDefined();
    expect(fetched).toEqual([`${CERT_URL}|error`]);
    now += 61 * 60_000;
    await load(CERT_URL);
    expect(fetched).toHaveLength(2);
  });

  it("gives undefined for a client error, a body that is not a certificate, a huge body, and a certificate out of date; and a transient error for a server fault or a network fault", async () => {
    const make = (answer: () => Promise<{ ok: boolean; status: number; body: ReadableStream<Uint8Array> | null }>, now = () => NOW) => certificateLoader({ now, fetch: answer });
    expect(await make(() => Promise.resolve(response(404, "")))(CERT_URL)).toBeUndefined();
    expect(await make(() => Promise.resolve(response(200, "hello")))(CERT_URL)).toBeUndefined();
    expect(await make(() => Promise.resolve(response(200, `-----BEGIN CERTIFICATE-----${"A".repeat(20_000)}`)))(CERT_URL)).toBeUndefined();
    expect(await make(() => Promise.resolve(response(200, "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----")))(CERT_URL)).toBeUndefined();
    expect(await make(() => Promise.resolve(response(200, CERT_PEM)), () => Date.parse("2200-01-01T00:00:00Z"))(CERT_URL)).toBeUndefined();
    expect(await make(() => Promise.resolve(response(200, CERT_PEM)), () => Date.parse("2000-01-01T00:00:00Z"))(CERT_URL)).toBeUndefined();
    await expect(make(() => Promise.resolve(response(503, "")))(CERT_URL)).rejects.toBeInstanceOf(SnsTransientError);
    await expect(make(() => Promise.reject(new Error("socket hang up")))(CERT_URL)).rejects.toBeInstanceOf(SnsTransientError);
  });

  it("reads at most 16 KB of a body and stops (a stream that never ends is cancelled, not buffered)", async () => {
    let pulled = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({ pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(4096).fill(65)); }, cancel() { cancelled = true; } });
    const load = certificateLoader({ now: () => NOW, fetch: () => Promise.resolve({ ok: true, status: 200, body: endless }) });
    expect(await load(CERT_URL)).toBeUndefined();
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
    expect(await certificateLoader({ now: () => NOW, fetch: () => Promise.resolve({ ok: true, status: 200, body: null }) })(CERT_URL)).toBeUndefined();
  });

  it("refuses a certificate that was not issued to SNS's name", async () => {
    const wrongSubject = [
  "-----BEGIN CERTIFICATE-----",
    "MIIDADCCAeigAwIBAgIUVeoud55fWMg5UkYFMU0Nsr5gzaQwDQYJKoZIhvcNAQEL",
    "BQAwHzEdMBsGA1UEAwwUYXR0YWNrZXIuZXhhbXBsZS5jb20wIBcNMjYxMTEyMDg1",
    "NzEwWhgPMjEyNjEwMTkwODU3MTBaMB8xHTAbBgNVBAMMFGF0dGFja2VyLmV4YW1w",
    "bGUuY29tMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1TYwWa2CJFNl",
    "brNpccIeW4RKpUSIOELKnxXhd1GR3rEPndhJsr/s1avQsABDRox6DLTvqaYFFsvJ",
    "/NFAwrD9WNAEu5/jiMfSevKoFtaTumPYR9rDD5sQKoFb2jJ7VwmPDY5Ati4S/vIT",
    "XHJuLkw1PzwGWw9lZlOS1Slc99rfuid9xY6CBYCpdNtMeW5blpza6hzQIAL6/OSJ",
    "/9cZlnZ0GxerGoqFDt1+QV3c6HFHuGxItU8fmFesjjgDwNwm4pXYw8kwEC682NQ2",
    "YoeuaaAMadB3MRAW35LsQrayDKyjb7eHhxsP48gtntDP0Z7yguEi2hGzxsdKjYA6",
    "nle5uurV/wIDAQABozIwMDAdBgNVHQ4EFgQU3KvtfyXSJHxCW5mzv3HDn3z1vvww",
    "DwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEACceHfL7YKcalHD3/",
    "vqK4Ovef9EV1qgkF31k084puXDfXpTPbUKovvkKEQ7oVcaxRjrL/z8KMkDqGM5gW",
    "YzU0evaf/rSPPx99cRxAogn7DsUHD19/XFet6/AvpuNPqlsdp5oF5nuKOWOqNhTe",
    "ViyhOCjUf5VNRbFUvmMHXfMmHGLefjUQSbVAm4DowK1FwTMX8z1Ul7lb1QXcFGEX",
    "27m9KRPXdYhDFYLGgR3vd4NEwrg6HGU8NAWHiNM2ttZC90Vf1HuaB14nT+akgTC1",
    "DDXhlbKGJidn2YhechSSgRWxgQfI+tAMw7jR02NdLT8sMNbe4Fr9ZIbQFLzDerxd",
    "lQieMQ==",
    "-----END CERTIFICATE-----"
    ].join("\n");
    const load = certificateLoader({ now: () => NOW, fetch: () => Promise.resolve(response(200, wrongSubject)) });
    expect(await load(CERT_URL)).toBeUndefined();
    expect(await certificateLoader({ now: () => NOW, fetch: () => Promise.resolve(response(200, CERT_PEM)) })(CERT_URL)).toBeDefined();
  });

  it("keeps a small cache", async () => {
    const fetched: string[] = [];
    const load = certificateLoader({ now: () => NOW, maxEntries: 2, fetch: (url) => { fetched.push(url); return Promise.resolve(response(200, CERT_PEM)); } });
    for (const id of ["a", "b", "c", "a"]) await load(`https://sns.us-west-2.amazonaws.com/SimpleNotificationService-${id.repeat(32)}.pem`);
    expect(fetched).toHaveLength(4);
  });
});
