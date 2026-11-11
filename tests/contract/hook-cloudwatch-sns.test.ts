// Plan 4 Task 25: CloudWatch alarms start agents and chains through a customer's SNS topic with an HTTPS subscription to the hook's URL.
// SNS signs each message with a certificate it publishes at `sns.<region>.amazonaws.com`; a message is believed only after that signature verifies over the string AWS documents
// (SignatureVersion 2, SHA256 with RSA), only from a certificate URL that passes AWS's host rules, and only for the one topic the hook names. A subscription is confirmed by the
// broker itself, only for that topic, only in an AWS account the org connected. Layer 1 drives verification, Layer 2 the hook route with a recording dispatcher, Layer 3 the real
// dispatch and the hook-creation routes, Layer 4 what the code left in logs.
import { afterEach, describe, expect, it } from "vitest";
import { HOOK_BODY_MAX_BYTES, SNS_CERT_CACHE_HOURS, SNS_CERT_FETCHES_PER_MINUTE, SNS_CERT_MAX_BYTES } from "@rovara-code/contracts";
import { RUN_START_TITLE_MAX, type ChainDefinitionInput } from "@rovara-code/contracts";
import { dispatchTriggerEvent } from "../../packages/broker/src/triggers/dispatch.js";
import type { HookDelivery } from "../../packages/broker/src/triggers/ingress.js";
import { hookProviders } from "../../packages/broker/src/triggers/providers/index.js";
import { cloudwatchProvider, confirmationTarget } from "../../packages/broker/src/triggers/providers/cloudwatch-sns.js";
import { SnsCertMemory, parseSnsMessage, snsStringToSign, verifySnsMessage, type SnsMessage } from "../../packages/broker/src/triggers/sns-verify.js";
import type { HookRecord } from "@rovara-code/contracts";
import { HOOK_1, LINEAR_TENANT, ORG_A, ORG_B, setupHookWorld, type HookWorld } from "../support/hook-fixtures.js";
import { START } from "../support/chain-run-world.js";
import {
  FakeSnsNetwork, OTHER_ACCOUNT, OTHER_SIGNING_KEY_PEM, OTHER_TOPIC_ARN, SNS_ACCOUNT, SNS_CERT_URL, SNS_REGION, SNS_SUBSCRIPTION_ARN, SNS_TOKEN, SNS_TOPIC_ARN, TEST_CERT_EXPIRED_PEM, TEST_CERT_FUTURE_PEM,
  TEST_CERT_PEM, alarmJson, awsStringToSign, confirmXml, confirmationFields, notificationFields, signSns, subscribeUrl, type AlarmOver, type SnsFields, type SignOptions,
} from "../support/sns-fixtures.js";
import { DANA, HOOK_A, disposeGateWorlds, setupTriggerWorld } from "../support/trigger-world.js";

afterEach(disposeGateWorlds);

const HOUR = 3_600_000;
const MINUTE = 60_000;
const CW_TENANT = { awsAccountId: SNS_ACCOUNT, topicArn: SNS_TOPIC_ARN };
const FORBIDDEN = { status: 403, body: { error: { code: "FORBIDDEN", message: "signature check failed" } } };
const IGNORED = { status: 202, body: { delivery: "IGNORED" } };
const CONFIRMED = { status: 202, body: { delivery: "SUBSCRIPTION_CONFIRMED" } };
const UNSUBSCRIBED = { status: 202, body: { delivery: "UNSUBSCRIBED" } };
const ONE_STEP: ChainDefinitionInput = { start: "look", steps: [{ kind: "agent", id: "look", name: "Look", agent: { agentId: "root-cause-analyst", version: "current" }, next: { kind: "end" } }], limits: { maxRunUsd: 5 } };
const iso = (ms: number): string => new Date(ms).toISOString();
const CERT_URL_OF = (name: string, region = SNS_REGION): string => `https://sns.${region}.amazonaws.com/SimpleNotificationService-${name}.pem`;

interface Options { status?: HookRecord["status"]; connected?: boolean }
async function cwWorld(options: Options = {}) {
  const w = setupHookWorld({ cloudwatch: cloudwatchProvider });
  const net = new FakeSnsNetwork();
  const connected = new Set<string>(options.connected === false ? [] : [`${ORG_A}|${SNS_ACCOUNT}`]);
  Object.assign(w.deps, { snsFetch: net.fetch, awsAccounts: { isConnected: async (org: string, account: string) => connected.has(`${org}|${account}`) } });
  const hook = await w.hook({ source: "cloudwatch", hookId: HOOK_1, project: "web", tenant: CW_TENANT as never, auth: "sns", hasSecret: false, status: options.status ?? "active", secret: null });
  const stored = async () => (await w.store.record(ORG_A, HOOK_1))!;
  return { w, net, hook, connected, stored };
}

interface Sending { topicHeader?: string | null; type?: string | null; raw?: Buffer; ip?: string }
function snsDelivery(hook: Pick<HookRecord, "hookId">, body: string, options: Sending = {}): HookDelivery {
  const headers: Record<string, string | undefined> = { "content-type": "text/plain; charset=UTF-8" };
  if (options.topicHeader !== null) headers["x-amz-sns-topic-arn"] = options.topicHeader ?? SNS_TOPIC_ARN;
  if (options.type !== null) headers["x-amz-sns-message-type"] = options.type ?? "Notification";
  return { source: "cloudwatch", hookId: hook.hookId, raw: options.raw ?? Buffer.from(body, "utf8"), headers, sourceIp: options.ip ?? "205.251.233.1" };
}
const notification = (over: Parameters<typeof notificationFields>[0] = {}, sign: SignOptions = {}): string => signSns(notificationFields(over), sign);
const subscription = (over: Parameters<typeof confirmationFields>[1] = {}, sign: SignOptions = {}): string => signSns(confirmationFields("SubscriptionConfirmation", over), sign);
const unsubscription = (over: Parameters<typeof confirmationFields>[1] = {}, sign: SignOptions = {}): string => signSns(confirmationFields("UnsubscribeConfirmation", over), sign);
const asMessage = (text: string): SnsMessage => parseSnsMessage(JSON.parse(text))!;
const noWrites = (w: HookWorld, mark: number) => expect(w.writesSince(mark)).toEqual([]);

// ---- Layer 1: the signature

describe("verifySnsMessage: AWS's documented rules", () => {
  async function verifier() {
    const net = new FakeSnsNetwork();
    const memory = new SnsCertMemory();
    return { net, memory, verify: (text: string, now = START) => verifySnsMessage({ memory, fetch: net.fetch }, asMessage(text), now) };
  }

  it("verifies a Notification, a SubscriptionConfirmation and an UnsubscribeConfirmation signed with SHA256 over the string AWS documents", async () => {
    const { verify } = await verifier();
    expect(await verify(notification())).toBe(true);
    expect(await verify(notification({ subject: null }))).toBe(true);
    expect(await verify(subscription())).toBe(true);
    expect(await verify(unsubscription())).toBe(true);
  });

  it("builds the string to sign as AWS says: byte-sorted keys, `<key>\\n<value>\\n`, Subject only when present, the confirmation keys for the two confirmation types", () => {
    const withSubject = asMessage(notification({ message: "m1", messageId: "id1", subject: "s1", timestamp: "2026-10-22T08:00:00.000Z" }));
    expect(snsStringToSign(withSubject)).toBe(`Message\nm1\nMessageId\nid1\nSubject\ns1\nTimestamp\n2026-10-22T08:00:00.000Z\nTopicArn\n${SNS_TOPIC_ARN}\nType\nNotification\n`);
    const without = asMessage(notification({ message: "m1", messageId: "id1", subject: null, timestamp: "2026-10-22T08:00:00.000Z" }));
    expect(snsStringToSign(without)).toBe(`Message\nm1\nMessageId\nid1\nTimestamp\n2026-10-22T08:00:00.000Z\nTopicArn\n${SNS_TOPIC_ARN}\nType\nNotification\n`);
    for (const type of ["SubscriptionConfirmation", "UnsubscribeConfirmation"] as const) {
      const fields = confirmationFields(type, { messageId: "id2" });
      const confirmation = asMessage(signSns(fields));
      expect(snsStringToSign(confirmation)).toBe(awsStringToSign(fields));
      expect(snsStringToSign(confirmation)).toBe(`Message\n${fields["Message"]!}\nMessageId\nid2\nSubscribeURL\n${fields["SubscribeURL"]!}\nTimestamp\n${fields["Timestamp"]!}\nToken\n${SNS_TOKEN}\nTopicArn\n${SNS_TOPIC_ARN}\nType\n${type}\n`);
    }
  });

  it("refuses a message whose signed field was changed after signing, one by one (a Subject added later, a changed Message, topic, id, time, type)", async () => {
    const { verify } = await verifier();
    expect(await verify(notification({ subject: null }, { after: { Subject: "added later" } }))).toBe(false);
    expect(await verify(notification({}, { after: { Subject: "changed" } }))).toBe(false);
    expect(await verify(notification({}, { after: { Message: alarmJson({ name: "Other" }) } }))).toBe(false);
    expect(await verify(notification({}, { after: { MessageId: "other-id" } }))).toBe(false);
    expect(await verify(notification({}, { after: { Timestamp: "2026-10-22T08:59:32.000Z" } }))).toBe(false);
    expect(await verify(notification({}, { after: { TopicArn: `${SNS_TOPIC_ARN}x` } }))).toBe(false);
    expect(await verify(subscription({}, { after: { SubscribeURL: subscribeUrl({ token: "other" }) } }))).toBe(false);
    expect(await verify(subscription({}, { after: { Token: "other" } }))).toBe(false);
    expect(await verify(subscription({}, { after: { Type: "UnsubscribeConfirmation" } }))).toBe(false);
  });

  it("accepts only SignatureVersion 2 with a SHA256 signature: version 1 (even SHA1-signed), a mislabelled hash and an unknown version are refused, with no certificate fetch for a version it will not accept", async () => {
    const { verify, net } = await verifier();
    expect(await verify(notification({}, { version: "1", hash: "sha1" }))).toBe(false);
    expect(await verify(notification({}, { version: "1", hash: "sha256" }))).toBe(false);
    expect(await verify(notification({}, { version: "3" }))).toBe(false);
    expect(await verify(notification({}, { version: "" }))).toBe(false);
    expect(net.certRequests).toEqual([]);
    expect(await verify(notification({}, { version: "2", hash: "sha1" }))).toBe(false);
    expect(await verify(notification({}, { version: "2" }))).toBe(true);
  });

  it("refuses a signature made with another key, a signature that is not base64, and an empty one", async () => {
    const { verify } = await verifier();
    expect(await verify(notification({}, { key: OTHER_SIGNING_KEY_PEM }))).toBe(false);
    expect(await verify(notification({}, { after: { Signature: "!!not base64!!" } }))).toBe(false);
    expect(await verify(notification({}, { after: { Signature: "" } }))).toBe(false);
    expect(await verify(notification({}, { after: { Signature: "AAAA" } }))).toBe(false);
  });

  it("refuses any Type but the three SNS sends", async () => {
    const { verify } = await verifier();
    for (const type of ["notification", "SubscriptionConfirmations", "", "Other"]) expect(await verify(signSns({ ...notificationFields(), Type: type })), type).toBe(false);
  });

  const bad = (name: string, certUrl: string, topic = SNS_TOPIC_ARN) => [name, certUrl, topic] as const;
  it.each([
    bad("another host", "https://sns.evil.example/SimpleNotificationService-0123.pem"),
    bad("the AWS host as a prefix of another", `https://sns.${SNS_REGION}.amazonaws.com.evil.example/SimpleNotificationService-0123.pem`),
    bad("the AWS host in the user info", `https://sns.${SNS_REGION}.amazonaws.com@evil.example/SimpleNotificationService-0123.pem`),
    bad("a user and password", `https://user:pw@sns.${SNS_REGION}.amazonaws.com/SimpleNotificationService-0123.pem`),
    bad("plain http", `http://sns.${SNS_REGION}.amazonaws.com/SimpleNotificationService-0123.pem`),
    bad("another region than the topic's", CERT_URL_OF("0123", "eu-west-1")),
    bad("an explicit port", `https://sns.${SNS_REGION}.amazonaws.com:443/SimpleNotificationService-0123.pem`),
    bad("another port", `https://sns.${SNS_REGION}.amazonaws.com:8443/SimpleNotificationService-0123.pem`),
    bad("a query", `${CERT_URL_OF("0123")}?x=1`),
    bad("a fragment", `${CERT_URL_OF("0123")}#x`),
    bad("a path that does not end in .pem", `https://sns.${SNS_REGION}.amazonaws.com/SimpleNotificationService-0123.txt`),
    bad("a path with another directory", `https://sns.${SNS_REGION}.amazonaws.com/a/b.pem`),
    bad("a path that climbs", `https://sns.${SNS_REGION}.amazonaws.com/../x.pem`),
    bad("an upper-case host", `https://SNS.${SNS_REGION}.amazonaws.com/SimpleNotificationService-0123.pem`),
    bad("a bare amazonaws.com host", "https://amazonaws.com/SimpleNotificationService-0123.pem"),
    bad("another service's host", `https://s3.${SNS_REGION}.amazonaws.com/SimpleNotificationService-0123.pem`),
    bad("a host with a deeper name", `https://x.sns.${SNS_REGION}.amazonaws.com/SimpleNotificationService-0123.pem`),
    bad("a backslash", `https://sns.${SNS_REGION}.amazonaws.com\\@evil.example/SimpleNotificationService-0123.pem`),
    bad("no path", `https://sns.${SNS_REGION}.amazonaws.com`),
    bad("a trailing dot host", `https://sns.${SNS_REGION}.amazonaws.com./SimpleNotificationService-0123.pem`),
    bad("not a URL", "SimpleNotificationService-0123.pem"),
    bad("a cn host for an aws topic", "https://sns.cn-north-1.amazonaws.com.cn/SimpleNotificationService-0123.pem"),
  ])("refuses a certificate URL with %s without fetching anything, though the certificate would verify", async (_name, certUrl) => {
    const { verify, net } = await verifier();
    net.certs.set(certUrl, TEST_CERT_PEM);
    expect(await verify(notification({}, { certUrl }))).toBe(false);
    expect(net.requests).toEqual([]);
  });

  it("takes the region from the TOPIC: a topic of another region needs that region's host, and an unreadable topic ARN is refused", async () => {
    const { verify, net } = await verifier();
    const eu = "arn:aws:sns:eu-west-1:123456789012:t";
    net.certs.set(CERT_URL_OF("0123", "eu-west-1"), TEST_CERT_PEM);
    expect(await verify(notification({ topicArn: eu }, { certUrl: CERT_URL_OF("0123", "eu-west-1") }))).toBe(true);
    expect(await verify(notification({ topicArn: eu }))).toBe(false);
    expect(await verify(notification({ topicArn: "not-an-arn" }))).toBe(false);
    expect(await verify(notification({ topicArn: "arn:aws:sqs:us-east-1:123456789012:q" }))).toBe(false);
  });

  it("does not read the China partition's host: only the aws partition's topics are trusted (review I-1)", async () => {
    const { verify, net } = await verifier();
    const topicArn = "arn:aws-cn:sns:cn-north-1:123456789012:t";
    const certUrl = "https://sns.cn-north-1.amazonaws.com.cn/SimpleNotificationService-0123.pem";
    net.certs.set(certUrl, TEST_CERT_PEM);
    expect(await verify(notification({ topicArn }, { certUrl }))).toBe(false);
    expect(net.requests).toEqual([]);
  });

  it("refuses a certificate outside its validity dates (expired, not yet valid) and one that is not a certificate", async () => {
    const { verify, net } = await verifier();
    const certUrl = CERT_URL_OF("expired");
    net.certs.set(certUrl, TEST_CERT_EXPIRED_PEM);
    expect(await verify(notification({}, { certUrl }))).toBe(false);
    net.certs.set(CERT_URL_OF("future"), TEST_CERT_FUTURE_PEM);
    expect(await verify(notification({}, { certUrl: CERT_URL_OF("future") }))).toBe(false);
    net.certs.set(CERT_URL_OF("junk"), "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n");
    expect(await verify(notification({}, { certUrl: CERT_URL_OF("junk") }))).toBe(false);
    net.certs.set(CERT_URL_OF("text"), "hello");
    expect(await verify(notification({}, { certUrl: CERT_URL_OF("text") }))).toBe(false);
    expect(net.certRequests).toHaveLength(4);
  });

  it("checks the validity dates against the time it is given, at both ends, on every use of a cached certificate", async () => {
    const { verify, net } = await verifier();
    const text = notification();
    expect(await verify(text, Date.parse("2020-01-01T00:00:01Z"))).toBe(true);
    expect(await verify(text, Date.parse("2019-12-31T23:59:59Z"))).toBe(false);
    expect(await verify(text, Date.parse("2119-12-31T23:59:59Z"))).toBe(true);
    expect(await verify(text, Date.parse("2120-01-01T00:00:01Z"))).toBe(false);
    expect(net.certRequests.length).toBeGreaterThanOrEqual(1);
  });

  it("refuses when the certificate cannot be had: not found, a server error, a redirect, a network failure, a body over the limit", async () => {
    const { verify, net } = await verifier();
    expect(await verify(notification({}, { certUrl: CERT_URL_OF("missing") }))).toBe(false);
    net.certStatus = 500;
    expect(await verify(notification())).toBe(false);
    net.certStatus = 302;
    expect(await verify(notification())).toBe(false);
    net.certStatus = undefined;
    const big = `${TEST_CERT_PEM}${"# padding\n".repeat(Math.ceil(SNS_CERT_MAX_BYTES / 10))}`;
    net.certs.set(SNS_CERT_URL, big);
    expect(await verify(notification())).toBe(false);
    net.certs.set(SNS_CERT_URL, TEST_CERT_PEM);
    expect(await verify(notification())).toBe(true);
  });

  it("caches a certificate by URL for SNS_CERT_CACHE_HOURS and fetches it again after that, and never caches a failure", async () => {
    const { verify, net } = await verifier();
    const text = notification();
    net.certStatus = 500;
    expect(await verify(text)).toBe(false);
    net.certStatus = undefined;
    expect(await verify(text)).toBe(true);
    expect(net.certRequests).toHaveLength(2);
    expect(await verify(text, START + (SNS_CERT_CACHE_HOURS - 1) * HOUR)).toBe(true);
    expect(net.certRequests).toHaveLength(2);
    expect(await verify(text, START + (SNS_CERT_CACHE_HOURS + 1) * HOUR)).toBe(true);
    expect(net.certRequests).toHaveLength(3);
  });

  it("fetches at most SNS_CERT_FETCHES_PER_MINUTE certificates not yet cached a minute, and still uses the cached ones", async () => {
    const { verify, net } = await verifier();
    const cached = notification();
    expect(await verify(cached)).toBe(true);
    const urls = Array.from({ length: SNS_CERT_FETCHES_PER_MINUTE + 2 }, (_value, index) => CERT_URL_OF(`${String(index).padStart(4, "0")}`));
    for (const url of urls) net.certs.set(url, TEST_CERT_PEM);
    const results: boolean[] = [];
    for (const [index, certUrl] of urls.entries()) results.push(await verify(notification({ messageId: `m${String(index)}` }, { certUrl }), START + index * 1000));
    // One fetch is already spent on the cached certificate, so nine more get through.
    expect(results.filter(Boolean)).toHaveLength(SNS_CERT_FETCHES_PER_MINUTE - 1);
    expect(results.slice(0, SNS_CERT_FETCHES_PER_MINUTE - 1).every(Boolean)).toBe(true);
    expect(net.certRequests).toHaveLength(SNS_CERT_FETCHES_PER_MINUTE);
    expect(await verify(cached, START + 20_000)).toBe(true);
    expect(net.certRequests).toHaveLength(SNS_CERT_FETCHES_PER_MINUTE);
    // The minute passes.
    expect(await verify(notification({}, { certUrl: urls.at(-1)! }), START + MINUTE + 5_000)).toBe(true);
    expect(net.certRequests).toHaveLength(SNS_CERT_FETCHES_PER_MINUTE + 1);
  });

  it("parseSnsMessage reads only a message whose fields are the strings SNS sends, and keeps Subject only when it is text", () => {
    const text = notification();
    expect(parseSnsMessage(JSON.parse(text))).toMatchObject({ Type: "Notification", TopicArn: SNS_TOPIC_ARN, SignatureVersion: "2" });
    expect(parseSnsMessage(JSON.parse(notification({ subject: null })))).not.toHaveProperty("Subject");
    for (const missing of ["Message", "MessageId", "Timestamp", "TopicArn", "Type", "Signature", "SignatureVersion", "SigningCertURL"]) {
      expect(parseSnsMessage({ ...JSON.parse(text), [missing]: undefined }), missing).toBeUndefined();
      expect(parseSnsMessage({ ...JSON.parse(text), [missing]: 5 }), missing).toBeUndefined();
    }
    expect(parseSnsMessage({ ...JSON.parse(text), Subject: 5 })).toBeUndefined();
    expect(parseSnsMessage({ ...JSON.parse(subscription()), Token: undefined })).toBeUndefined();
    expect(parseSnsMessage({ ...JSON.parse(subscription()), SubscribeURL: undefined })).toBeUndefined();
    for (const value of [null, 5, "x", [], undefined]) expect(parseSnsMessage(value)).toBeUndefined();
  });
});

// ---- the SubscribeURL

describe("confirmationTarget: only SNS's own confirm action for the hook's topic", () => {
  const message = (url: string, token = SNS_TOKEN) => asMessage(subscription({ subscribeUrl: url, token }));
  it("accepts the URL SNS sends, with or without the arn colons encoded", () => {
    expect(confirmationTarget(message(subscribeUrl()), SNS_TOPIC_ARN)?.href).toContain("Action=ConfirmSubscription");
    const encoded = `https://sns.${SNS_REGION}.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(SNS_TOPIC_ARN)}&Token=${SNS_TOKEN}`;
    expect(confirmationTarget(message(encoded), SNS_TOPIC_ARN)).toBeDefined();
  });

  it.each([
    ["another host", subscribeUrl({ host: "example.com" })],
    ["a lookalike host", subscribeUrl({ host: `sns.${SNS_REGION}.amazonaws.com.evil.example` })],
    ["another region's host", subscribeUrl({ host: "sns.eu-west-1.amazonaws.com" })],
    ["http", subscribeUrl({ scheme: "http" })],
    ["another action", subscribeUrl({ action: "Unsubscribe" })],
    ["another topic", subscribeUrl({ topicArn: OTHER_TOPIC_ARN })],
    ["a path", subscribeUrl({ path: "/x" })],
    ["a port", `https://sns.${SNS_REGION}.amazonaws.com:8443/?Action=ConfirmSubscription&TopicArn=${SNS_TOPIC_ARN}&Token=${SNS_TOKEN}`],
    ["user info", `https://a@sns.${SNS_REGION}.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${SNS_TOPIC_ARN}&Token=${SNS_TOKEN}`],
    ["a fragment", `${subscribeUrl()}#x`],
    ["no token", `https://sns.${SNS_REGION}.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${SNS_TOPIC_ARN}`],
    ["an empty token", `https://sns.${SNS_REGION}.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${SNS_TOPIC_ARN}&Token=`],
    ["another token than the signed one", subscribeUrl({ token: "another-token" })],
    ["an extra parameter", `${subscribeUrl()}&AuthenticateOnUnsubscribe=true`],
    ["a repeated parameter", `${subscribeUrl()}&Token=${SNS_TOKEN}`],
    ["not a URL", "confirm me"],
  ])("refuses %s", (_name, url) => {
    expect(confirmationTarget(message(url), SNS_TOPIC_ARN)).toBeUndefined();
  });

  it("does not read a message that is not a confirmation", () => {
    expect(confirmationTarget(asMessage(notification()), SNS_TOPIC_ARN)).toBeUndefined();
  });
});

// ---- Layer 2: the route

describe("a confirmed subscription and a notification, through the hook route", () => {
  it("confirms a pending hook from a signed SubscriptionConfirmation with one GET to its SubscribeURL, and stores the subscription ARN", async () => {
    const { w, net, hook, stored } = await cwWorld({ status: "pending_confirmation" });
    expect(await w.receive(snsDelivery(hook, subscription(), { type: "SubscriptionConfirmation" }))).toEqual(CONFIRMED);
    expect(net.confirmRequests).toEqual([subscribeUrl()]);
    expect(net.requests.filter((request) => request.url.includes("Confirm")).map((request) => request.method)).toEqual(["GET"]);
    const record = await stored();
    expect(record).toMatchObject({ status: "active", subscriptionArn: SNS_SUBSCRIPTION_ARN, hasSecret: false, auth: "sns" });
    expect(w.dispatched).toEqual([]);
  });

  it("a second confirmation for the now active hook is ignored (202) and visits nothing", async () => {
    const { w, net, hook } = await cwWorld({ status: "pending_confirmation" });
    await w.receive(snsDelivery(hook, subscription(), { type: "SubscriptionConfirmation" }));
    expect(await w.receive(snsDelivery(hook, subscription({ messageId: "another" }), { type: "SubscriptionConfirmation" }))).toEqual(IGNORED);
    expect(net.confirmRequests).toHaveLength(1);
  });

  it("dispatches one alarm.fired event for a signed ALARM notification: its key, time, subject, console link and fields", async () => {
    const { w, hook } = await cwWorld();
    expect(await w.receive(snsDelivery(hook, notification()))).toEqual({ status: 202, body: { delivery: "ACCEPTED", events: 1 } });
    expect(w.dispatched).toHaveLength(1);
    expect(w.dispatched[0]).toMatchObject({ orgId: ORG_A, event: {
      source: "cloudwatch", type: "alarm.fired", eventKey: "cw:da41e39f-ea4d-435a-b922-c6aae3915ebe", project: "web", hookId: hook.hookId, occurredAt: "2026-10-22T08:59:30.123Z",
      subject: { kind: "alert", id: "HighCPU", title: "HighCPU: Threshold Crossed: 1 datapoint [92.1] was greater than the threshold (80.0).", url: `https://${SNS_REGION}.console.aws.amazon.com/cloudwatch/home?region=${SNS_REGION}#alarmsV2:alarm/HighCPU` },
      fields: { alarm: ["HighCPU"], namespace: ["AWS/EC2"], region: [SNS_REGION] }, actor: { kind: "unknown" },
    } });
  });

  it("answers the same MessageId again with 200 DUPLICATE and dispatches nothing more", async () => {
    const { w, hook } = await cwWorld();
    await w.receive(snsDelivery(hook, notification()));
    expect(await w.receive(snsDelivery(hook, notification()))).toEqual({ status: 200, body: { delivery: "DUPLICATE" } });
    expect(w.dispatched).toHaveLength(1);
  });

  it("reads a notification with no Subject, and encodes an alarm name in the console link", async () => {
    const { w, hook } = await cwWorld();
    await w.receive(snsDelivery(hook, notification({ subject: null, alarm: { name: "api/5xx rate #1" }, messageId: "m-enc" })));
    expect(w.dispatched[0]!.event.subject).toMatchObject({ id: "api/5xx rate #1", url: `https://${SNS_REGION}.console.aws.amazon.com/cloudwatch/home?region=${SNS_REGION}#alarmsV2:alarm/api%2F5xx%20rate%20%231` });
  });

  it("takes the region from the topic: a topic in another region (here eu-west-1) is read from that region's host, and its alarm's console link is that region's", async () => {
    const w = setupHookWorld({ cloudwatch: cloudwatchProvider });
    const net = new FakeSnsNetwork();
    const topicArn = "arn:aws:sns:eu-west-1:123456789012:t";
    const certUrl = "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-0123.pem";
    net.certs.set(certUrl, TEST_CERT_PEM);
    Object.assign(w.deps, { snsFetch: net.fetch, awsAccounts: { isConnected: async () => true } });
    const hook = await w.hook({ source: "cloudwatch", hookId: HOOK_1, project: "web", tenant: { awsAccountId: SNS_ACCOUNT, topicArn } as never, auth: "sns", hasSecret: false, status: "active", secret: null });
    expect((await w.receive(snsDelivery(hook, notification({ topicArn }, { certUrl }), { topicHeader: topicArn }))).status).toBe(202);
    expect(w.dispatched[0]!.event.fields["region"]).toEqual(["eu-west-1"]);
  });

  it("ignores an OK or INSUFFICIENT_DATA state (202), and an alarm whose time or name can't be read", async () => {
    const { w, hook } = await cwWorld();
    expect(await w.receive(snsDelivery(hook, notification({ messageId: "ok", alarm: { state: "OK" } })))).toEqual(IGNORED);
    expect(await w.receive(snsDelivery(hook, notification({ messageId: "id", alarm: { state: "INSUFFICIENT_DATA" } })))).toEqual(IGNORED);
    expect(await w.receive(snsDelivery(hook, notification({ messageId: "t1", alarm: { at: "yesterday" } })))).toEqual(IGNORED);
    expect(await w.receive(snsDelivery(hook, notification({ messageId: "t2", message: JSON.stringify({ ...JSON.parse(alarmJson()), AlarmName: "" }) })))).toEqual(IGNORED);
    expect(await w.receive(snsDelivery(hook, notification({ messageId: "t3", message: JSON.stringify({ ...JSON.parse(alarmJson()), AlarmName: 5 }) })))).toEqual(IGNORED);
    expect(w.dispatched).toEqual([]);
  });

  it("reads the StateChangeTime SNS sends (an offset without a colon) and one with a colon or Z", async () => {
    const { w, hook } = await cwWorld();
    for (const [index, at] of ["2026-10-22T10:59:30.123+0200", "2026-10-22T10:59:30.123+02:00", "2026-10-22T08:59:30.123Z", "2026-10-22T08:59:30.123-0000"].entries()) {
      await w.receive(snsDelivery(hook, notification({ messageId: `t${String(index)}`, alarm: { at } })));
    }
    expect(w.dispatched.map((entry) => entry.event.occurredAt)).toEqual(Array(4).fill("2026-10-22T08:59:30.123Z"));
  });

  it("cleans the alarm name and reason, keeps a long alarm name within an event's limits, and cuts the title", async () => {
    const { w, hook } = await cwWorld();
    const long = "A".repeat(255);
    await w.receive(snsDelivery(hook, notification({ messageId: "l1", alarm: { name: long, reason: `bad\u0000 ${"r".repeat(500)}` } })));
    await w.receive(snsDelivery(hook, notification({ messageId: "l2", alarm: { name: "Boom‮ here", reason: "\u0007\u0000 " } })));
    const [first, second] = w.dispatched.map((entry) => entry.event);
    expect(first!.subject.id).toHaveLength(200);
    expect([...first!.subject.title].length).toBeLessThanOrEqual(RUN_START_TITLE_MAX);
    expect(first!.subject.title).toMatch(/^A+: bad r+$/);
    expect(first!.fields["alarm"]![0]!.length).toBeLessThanOrEqual(200);
    expect(second!.subject.title).toBe("Boom here");
    expect(second!.subject.title).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });

  it("leaves namespace empty when the trigger names none", async () => {
    const { w, hook } = await cwWorld();
    const body = JSON.parse(alarmJson()) as Record<string, unknown>;
    body["Trigger"] = {};
    await w.receive(snsDelivery(hook, notification({ message: JSON.stringify(body) })));
    expect(w.dispatched[0]!.event.fields).toMatchObject({ namespace: [], alarm: ["HighCPU"] });
  });
});

describe("spoofing: nothing is trusted that the signature does not cover", () => {
  it("answers 403, with no write and no dispatch, for a bad certificate URL, a changed body, version 1, a wrong key and an expired certificate", async () => {
    const { w, net, hook } = await cwWorld();
    const mark = w.db.commandNames().length;
    net.certs.set("https://sns.evil.example/c.pem", TEST_CERT_PEM);
    net.certs.set(CERT_URL_OF("expired"), TEST_CERT_EXPIRED_PEM);
    const attempts = [
      notification({}, { certUrl: "https://sns.evil.example/c.pem" }),
      notification({}, { certUrl: `https://sns.${SNS_REGION}.amazonaws.com.evil.example/c.pem` }),
      notification({}, { certUrl: `http://sns.${SNS_REGION}.amazonaws.com/c.pem` }),
      notification({}, { certUrl: CERT_URL_OF("0123", "eu-west-1") }),
      notification({}, { after: { Message: alarmJson({ name: "Changed" }) } }),
      notification({}, { version: "1", hash: "sha1" }),
      notification({}, { key: OTHER_SIGNING_KEY_PEM }),
      notification({}, { certUrl: CERT_URL_OF("expired") }),
    ];
    for (const text of attempts) expect(await w.receive(snsDelivery(hook, text)), text.slice(0, 60)).toEqual(FORBIDDEN);
    // Only a URL that passed the host rules is ever fetched: the good one (cached after the first use) and the expired certificate's.
    expect(net.certRequests).toEqual([SNS_CERT_URL, CERT_URL_OF("expired")]);
    expect(w.dispatched).toEqual([]);
    noWrites(w, mark);
  });

  it("answers 403 for a body that is not JSON, not an object, or has no signature (a raw message), and writes nothing", async () => {
    const { w, hook } = await cwWorld();
    const mark = w.db.commandNames().length;
    for (const raw of ["not json", "null", "42", "[]", alarmJson(), JSON.stringify({ ...notificationFields(), SignatureVersion: "2" }), ""]) {
      expect(await w.receive(snsDelivery(hook, raw)), raw.slice(0, 40)).toEqual(FORBIDDEN);
    }
    expect(await w.receive(snsDelivery(hook, "", { raw: Buffer.from([0xff, 0xfe]) }))).toEqual(FORBIDDEN);
    expect(w.dispatched).toEqual([]);
    noWrites(w, mark);
  });

  it("refuses a message for another topic whatever it is signed with: the body's, the header's, a missing header", async () => {
    const { w, net, hook } = await cwWorld();
    const mark = w.db.commandNames().length;
    const other = notification({ topicArn: OTHER_TOPIC_ARN });
    expect(await w.receive(snsDelivery(hook, other, { topicHeader: OTHER_TOPIC_ARN }))).toEqual(FORBIDDEN);
    expect(await w.receive(snsDelivery(hook, other))).toEqual(FORBIDDEN);
    expect(await w.receive(snsDelivery(hook, notification(), { topicHeader: OTHER_TOPIC_ARN }))).toEqual(FORBIDDEN);
    expect(await w.receive(snsDelivery(hook, notification(), { topicHeader: null }))).toEqual(FORBIDDEN);
    expect(await w.receive(snsDelivery(hook, notification(), { topicHeader: "" }))).toEqual(FORBIDDEN);
    expect(await w.receive(snsDelivery(hook, notification(), { topicHeader: `${SNS_TOPIC_ARN} ` }))).toEqual(FORBIDDEN);
    expect(await w.receive(snsDelivery(hook, notification({ topicArn: SNS_TOPIC_ARN.toUpperCase() }), { topicHeader: SNS_TOPIC_ARN.toUpperCase() }))).toEqual(FORBIDDEN);
    expect(net.requests).toEqual([]);
    expect(w.dispatched).toEqual([]);
    noWrites(w, mark);
  });

  it("refuses a valid notification from a topic in another account, and one whose alarm names another account, with no dispatch", async () => {
    const { w, hook } = await cwWorld();
    const mark = w.db.commandNames().length;
    expect(await w.receive(snsDelivery(hook, notification({ topicArn: OTHER_TOPIC_ARN }), { topicHeader: SNS_TOPIC_ARN }))).toEqual(FORBIDDEN);
    expect(await w.receive(snsDelivery(hook, notification({ messageId: "x1", alarm: { account: OTHER_ACCOUNT } })))).toEqual(FORBIDDEN);
    expect(await w.receive(snsDelivery(hook, notification({ messageId: "x2", message: JSON.stringify({ ...JSON.parse(alarmJson()), AWSAccountId: undefined }) })))).toEqual(FORBIDDEN);
    expect(await w.receive(snsDelivery(hook, notification({ messageId: "x3", message: JSON.stringify({ ...JSON.parse(alarmJson()), AWSAccountId: Number(SNS_ACCOUNT) }) })))).toEqual(FORBIDDEN);
    expect(await w.receive(snsDelivery(hook, notification({ messageId: "x4", message: "plain text, not an alarm" })))).toEqual(FORBIDDEN);
    expect(w.dispatched).toEqual([]);
    expect(w.writesSince(mark).filter((name) => name === "PutCommand")).toEqual([]);
  });

  it("does not let a hook of another org's id carry the topic of this one: the hook is found by its own id only", async () => {
    const { w, hook } = await cwWorld();
    const other = await w.hook({ orgId: ORG_B, source: "cloudwatch", hookId: `hk_${"8".repeat(26)}`, project: "ops", tenant: { awsAccountId: OTHER_ACCOUNT, topicArn: OTHER_TOPIC_ARN } as never, auth: "sns", hasSecret: false, status: "active", secret: null });
    expect(await w.receive(snsDelivery(other, notification()))).toEqual(FORBIDDEN);
    expect(await w.receive(snsDelivery(hook, notification({ topicArn: OTHER_TOPIC_ARN }), { topicHeader: OTHER_TOPIC_ARN }))).toEqual(FORBIDDEN);
    expect(w.dispatched).toEqual([]);
  });

  it("answers 403 to any delivery to a hook that is unsubscribed or disabled, and to a provider that checks another way", async () => {
    for (const status of ["unsubscribed", "disabled"] as const) {
      const { w, hook } = await cwWorld({ status });
      expect(await w.receive(snsDelivery(hook, notification()))).toEqual(FORBIDDEN);
      expect(await w.receive(snsDelivery(hook, subscription(), { type: "SubscriptionConfirmation" }))).toEqual(FORBIDDEN);
      expect(w.dispatched).toEqual([]);
    }
    const { w, hook } = await cwWorld();
    const other = await w.hook({ source: "cloudwatch", hookId: `hk_${"7".repeat(26)}`, project: "web", tenant: CW_TENANT as never, auth: "hmac", hasSecret: true, status: "active" });
    expect(await w.receive(snsDelivery(other, notification()))).toEqual(FORBIDDEN);
    expect(await w.receive(snsDelivery(hook, notification({ messageId: "fine" })))).toMatchObject({ status: 202 });
  });

  it("a Notification to a hook still pending_confirmation is refused with no write, and so is a raw-delivery body", async () => {
    const { w, hook, stored } = await cwWorld({ status: "pending_confirmation" });
    const mark = w.db.commandNames().length;
    expect(await w.receive(snsDelivery(hook, notification()))).toEqual(FORBIDDEN);
    expect(await w.receive(snsDelivery(hook, alarmJson()))).toEqual(FORBIDDEN);
    expect(w.dispatched).toEqual([]);
    noWrites(w, mark);
    expect((await stored()).status).toBe("pending_confirmation");
  });

  it("a SignatureVersion 1 notification (SHA1) is refused even though SNS's default topics send it", async () => {
    const { w, hook } = await cwWorld();
    expect(await w.receive(snsDelivery(hook, notification({}, { version: "1", hash: "sha1" })))).toEqual(FORBIDDEN);
  });
});

describe("the subscription: confirm only the hook's own topic, in an account the org connected", () => {
  const confirm = (w: HookWorld, hook: Pick<HookRecord, "hookId">, text: string) => w.receive(snsDelivery(hook, text, { type: "SubscriptionConfirmation" }));

  it.each([
    ["example.com", subscribeUrl({ host: "example.com" })],
    ["another topic", subscribeUrl({ topicArn: OTHER_TOPIC_ARN })],
    ["another region's SNS", subscribeUrl({ host: "sns.eu-west-1.amazonaws.com" })],
    ["another action", subscribeUrl({ action: "Unsubscribe" })],
    ["http", subscribeUrl({ scheme: "http" })],
    ["a token that is not the signed one", subscribeUrl({ token: "forged" })],
  ])("answers 403 and fetches nothing for a signed confirmation whose SubscribeURL is %s", async (_name, url) => {
    const { w, net, hook, stored } = await cwWorld({ status: "pending_confirmation" });
    expect(await confirm(w, hook, subscription({ subscribeUrl: url }))).toEqual(FORBIDDEN);
    expect(net.confirmRequests).toEqual([]);
    expect(net.requests.filter((request) => !request.url.endsWith(".pem"))).toEqual([]);
    expect((await stored()).status).toBe("pending_confirmation");
  });

  it("answers 403 and fetches nothing for a confirmation of another topic, though it is signed", async () => {
    const { w, net, hook, stored } = await cwWorld({ status: "pending_confirmation" });
    expect(await confirm(w, hook, subscription({ topicArn: OTHER_TOPIC_ARN }))).toEqual(FORBIDDEN);
    expect(net.requests).toEqual([]);
    expect((await stored()).status).toBe("pending_confirmation");
  });

  it("answers 403 and fetches nothing when the hook's AWS account is not one the org connected, or the check is not available", async () => {
    const { w, net, hook, stored } = await cwWorld({ status: "pending_confirmation", connected: false });
    expect(await confirm(w, hook, subscription())).toEqual(FORBIDDEN);
    expect(net.confirmRequests).toEqual([]);
    expect((await stored()).status).toBe("pending_confirmation");
    const bare = await cwWorld({ status: "pending_confirmation" });
    delete (bare.w.deps as { awsAccounts?: unknown }).awsAccounts;
    expect(await confirm(bare.w, bare.hook, subscription())).toEqual(FORBIDDEN);
    expect(bare.net.confirmRequests).toEqual([]);
  });

  it("checks the connected account for the hook's own org, not another's", async () => {
    const { w, net, hook, connected } = await cwWorld({ status: "pending_confirmation", connected: false });
    connected.add(`${ORG_B}|${SNS_ACCOUNT}`);
    expect(await confirm(w, hook, subscription())).toEqual(FORBIDDEN);
    expect(net.confirmRequests).toEqual([]);
  });

  it("answers 503 and leaves the hook pending when SNS's answer to the visit is a failure, a refusal, or names no subscription of this topic", async () => {
    const { w, net, hook, stored } = await cwWorld({ status: "pending_confirmation" });
    net.confirm = "fail";
    expect((await confirm(w, hook, subscription())).status).toBe(503);
    net.confirm = { status: 400, body: "<ErrorResponse/>" };
    expect((await confirm(w, hook, subscription({ messageId: "m2" }))).status).toBe(503);
    net.confirm = { status: 200, body: "<ConfirmSubscriptionResponse/>" };
    expect((await confirm(w, hook, subscription({ messageId: "m3" }))).status).toBe(503);
    net.confirm = { status: 200, body: confirmXml(`${OTHER_TOPIC_ARN}:2bcfbf39-05c3-41de-beaa-fcfcc21c8f55`) };
    expect((await confirm(w, hook, subscription({ messageId: "m4" }))).status).toBe(503);
    net.confirm = { status: 200, body: confirmXml("not-an-arn") };
    expect((await confirm(w, hook, subscription({ messageId: "m5" }))).status).toBe(503);
    expect((await stored()).status).toBe("pending_confirmation");
    net.confirm = { status: 200, body: confirmXml() };
    expect(await confirm(w, hook, subscription({ messageId: "m6" }))).toEqual(CONFIRMED);
    expect((await stored()).status).toBe("active");
  });

  it("refuses a confirmation older than the event window or dated ahead, though it is signed", async () => {
    const { w, net, hook } = await cwWorld({ status: "pending_confirmation" });
    expect(await confirm(w, hook, subscription({ timestamp: iso(START - 25 * HOUR) }))).toEqual(FORBIDDEN);
    expect(await confirm(w, hook, subscription({ timestamp: iso(START + 10 * MINUTE) }))).toEqual(FORBIDDEN);
    expect(await confirm(w, hook, subscription({ timestamp: "yesterday" }))).toEqual(FORBIDDEN);
    expect(net.confirmRequests).toEqual([]);
  });

  it("stops the hook with an UnsubscribeConfirmation, visits no URL, and then answers 403 to a notification", async () => {
    const { w, net, hook, stored } = await cwWorld();
    expect(await w.receive(snsDelivery(hook, unsubscription(), { type: "UnsubscribeConfirmation" }))).toEqual(UNSUBSCRIBED);
    expect((await stored()).status).toBe("unsubscribed");
    expect(net.requests.filter((request) => !request.url.endsWith(".pem"))).toEqual([]);
    expect(await w.receive(snsDelivery(hook, notification()))).toEqual(FORBIDDEN);
    expect(w.dispatched).toEqual([]);
  });

  it("an UnsubscribeConfirmation for another topic, with a bad signature, or stale changes nothing", async () => {
    const { w, hook, stored } = await cwWorld();
    expect(await w.receive(snsDelivery(hook, unsubscription({ topicArn: OTHER_TOPIC_ARN }), { type: "UnsubscribeConfirmation", topicHeader: OTHER_TOPIC_ARN }))).toEqual(FORBIDDEN);
    expect(await w.receive(snsDelivery(hook, unsubscription({}, { key: OTHER_SIGNING_KEY_PEM }), { type: "UnsubscribeConfirmation" }))).toEqual(FORBIDDEN);
    expect(await w.receive(snsDelivery(hook, unsubscription({ timestamp: iso(START - 30 * HOUR) }), { type: "UnsubscribeConfirmation" }))).toEqual(FORBIDDEN);
    expect((await stored()).status).toBe("active");
  });

  it("the store confirms only a pending hook and stops only an active or pending one", async () => {
    const { w, hook } = await cwWorld({ status: "active" });
    expect(await w.store.confirmSubscription(ORG_A, hook.hookId, SNS_SUBSCRIPTION_ARN)).toBe(false);
    expect(await w.store.markUnsubscribed(ORG_A, hook.hookId)).toBe(true);
    expect(await w.store.markUnsubscribed(ORG_A, hook.hookId)).toBe(false);
    expect(await w.store.confirmSubscription(ORG_A, hook.hookId, SNS_SUBSCRIPTION_ARN)).toBe(false);
    expect(await w.store.markUnsubscribed(ORG_B, hook.hookId)).toBe(false);
    expect((await w.store.record(ORG_A, hook.hookId))!.status).toBe("unsubscribed");
    expect(await w.store.confirmSubscription(ORG_B, hook.hookId, SNS_SUBSCRIPTION_ARN)).toBe(false);
  });
});

describe("limits and the order of checks", () => {
  it("answers 413 for a body over the size limit before reading anything, and counts a verified delivery against the hook's rate", async () => {
    const { w, net, hook } = await cwWorld();
    expect((await w.receive(snsDelivery(hook, "", { raw: Buffer.alloc(HOOK_BODY_MAX_BYTES + 1, 97) }))).status).toBe(413);
    expect(net.requests).toEqual([]);
    await w.receive(snsDelivery(hook, notification()));
    expect(w.db.find((item) => String(item["pk"]).includes("HOOK_RATE#"))).toHaveLength(1);
  });

  it("makes no write before the signature verifies, and no certificate fetch for a flood of forged URLs beyond the container's allowance", async () => {
    const { w, net, hook } = await cwWorld();
    const mark = w.db.commandNames().length;
    for (let index = 0; index < 40; index += 1) {
      const certUrl = CERT_URL_OF(`forged${String(index)}`);
      net.certs.set(certUrl, TEST_CERT_PEM);
      await w.receive(snsDelivery(hook, notification({ messageId: `f${String(index)}` }, { key: OTHER_SIGNING_KEY_PEM, certUrl })));
    }
    noWrites(w, mark);
    expect(net.certRequests.length).toBeLessThanOrEqual(SNS_CERT_FETCHES_PER_MINUTE);
  });

  it("an event older than the window is not started", async () => {
    const { w, hook } = await cwWorld();
    expect(await w.receive(snsDelivery(hook, notification({ alarm: { at: "2026-10-20T08:00:00.000+0000" } })))).toMatchObject({ status: 202, body: { events: 0 } });
    expect(w.dispatched).toEqual([]);
  });

  it("answers 503 and forgets the event when dispatch fails, so SNS's retry starts it", async () => {
    const { w, hook } = await cwWorld();
    w.dispatchFails.error = new Error("down");
    expect((await w.receive(snsDelivery(hook, notification()))).status).toBe(503);
    w.dispatchFails.error = undefined;
    expect((await w.receive(snsDelivery(hook, notification()))).status).toBe(202);
    expect(w.dispatched).toHaveLength(1);
  });
});

// ---- the provider

describe("the CloudWatch provider", () => {
  it("is Rovara's SNS provider with no secret, registered beside the others, and never verifies a secret", async () => {
    expect([cloudwatchProvider.source, cloudwatchProvider.auth, cloudwatchProvider.secretOrigin]).toEqual(["cloudwatch", "sns", "none"]);
    expect(hookProviders().cloudwatch).toBe(cloudwatchProvider);
    expect(cloudwatchProvider.verify(Buffer.from("x"), {}, "secret")).toBe(false);
    expect(cloudwatchProvider.verify(Buffer.from("x"), { authorization: "secret" }, "")).toBe(false);
  });

  it("refuses a hook of another source, and reads only a Notification", async () => {
    const { hook } = await cwWorld();
    const other = { ...hook, source: "datadog" } as HookRecord;
    expect(cloudwatchProvider.normalize(JSON.parse(notification()), {}, other)).toEqual({ tenantMismatch: true });
    expect(cloudwatchProvider.normalize(JSON.parse(subscription()), {}, hook)).toEqual({ ignored: "not a notification" });
    expect(cloudwatchProvider.normalize(null, {}, hook)).toEqual({ tenantMismatch: true });
  });

  it("tells the person to subscribe with HTTPS, to set SignatureVersion 2 and to leave raw delivery off, with the hook's own topic in the words", async () => {
    const { hook } = await cwWorld();
    const setup = cloudwatchProvider.setupFor?.(hook);
    expect(setup?.steps).toEqual([`Subscribe this URL to ${SNS_TOPIC_ARN} with protocol HTTPS, and set the topic's SignatureVersion to 2. Leave raw message delivery off, because raw messages carry no signature. Rovara confirms the subscription itself.`]);
    expect(setup).not.toHaveProperty("payloadTemplate");
    expect(cloudwatchProvider.setupFor?.({ ...hook, source: "datadog" })).toBeUndefined();
  });
});

// ---- Layer 3: creating the hook, and the real dispatch

describe("creating a CloudWatch hook", () => {
  async function routes(connected = true) {
    const v = setupTriggerWorld();
    const hw = setupHookWorld(hookProviders(), { db: v.db, clock: v.clock });
    v.routeDeps.eventHooks = { store: hw.store, secrets: hw.secrets, providers: hw.providers, origin: "https://api.example.com", awsAccounts: { isConnected: async (org: string, account: string) => connected && org === ORG_A && account === SNS_ACCOUNT } };
    const create = (body: Record<string, unknown>) => v.agentCall(DANA, "POST", "/v1/app/projects/web/event-hooks", { requestId: crypto.randomUUID(), source: "cloudwatch", tenant: CW_TENANT, ...body });
    return { v, hw, create };
  }

  it("makes a hook that waits for its confirmation, with no secret, the URL and the exact copy", async () => {
    const { hw, create } = await routes();
    const made = await create({});
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body["hook"]).toMatchObject({ source: "cloudwatch", auth: "sns", hasSecret: false, status: "pending_confirmation", tenant: CW_TENANT });
    expect(made.body["url"]).toBe(`https://api.example.com/v1/hooks/cloudwatch/${(made.body["hook"] as { hookId: string }).hookId}`);
    expect(made.body["setup"]).toEqual({ steps: [`Subscribe this URL to ${SNS_TOPIC_ARN} with protocol HTTPS, and set the topic's SignatureVersion to 2. Leave raw message delivery off, because raw messages carry no signature. Rovara confirms the subscription itself.`] });
    expect(made.body).not.toHaveProperty("secret");
    expect(hw.secrets.puts).toBe(0);
    expect(hw.secrets.values.size).toBe(0);
    const record = await hw.store.record(ORG_A, (made.body["hook"] as { hookId: string }).hookId);
    expect(record).toMatchObject({ status: "pending_confirmation", hasSecret: false, auth: "sns" });
  });

  it("refuses a topic in an AWS account the org has not connected, and a secret, and a tenant that is not one account and topic", async () => {
    const off = await routes(false);
    const refused = await off.create({});
    expect(refused.status).toBe(400);
    expect(String(refused.body["message"])).toMatch(/connect/i);
    expect(off.hw.secrets.puts).toBe(0);
    expect(await off.hw.store.list(ORG_A)).toEqual([]);
    const { create } = await routes();
    expect((await create({ secret: "a-secret-of-sixteen-chars" })).status).toBe(400);
    expect((await create({ tenant: { awsAccountId: SNS_ACCOUNT, topicArn: OTHER_TOPIC_ARN } })).status).toBe(400);
    expect((await create({ tenant: { awsAccountId: OTHER_ACCOUNT, topicArn: OTHER_TOPIC_ARN } })).status).toBe(400);
    expect((await create({ tenant: { awsAccountId: "x", topicArn: SNS_TOPIC_ARN } })).status).toBe(400);
  });

  it("answers 503 when the broker has no way to know the org's accounts", async () => {
    const { v, create } = await routes();
    delete (v.routeDeps.eventHooks as { awsAccounts?: unknown }).awsAccounts;
    expect((await create({})).status).toBe(503);
  });

  it("a repeat of the request gives the same hook and the copy again, with nothing written", async () => {
    const { hw, create } = await routes();
    const requestId = crypto.randomUUID();
    const first = await create({ requestId });
    const again = await create({ requestId });
    expect(again.status).toBe(200);
    expect(again.body["replayed"]).toBe(true);
    expect(again.body["setup"]).toEqual(first.body["setup"]);
    expect((await hw.store.list(ORG_A)).length).toBe(1);
    expect(hw.secrets.puts).toBe(0);
  });

  it("has no secret to rotate, and deleting it schedules no secret work that matters", async () => {
    const { v, hw, create } = await routes();
    const made = await create({});
    const hookId = (made.body["hook"] as { hookId: string }).hookId;
    const rotate = await v.agentCall(DANA, "POST", `/v1/app/projects/web/event-hooks/${hookId}/rotate`, {});
    expect(rotate.status).toBe(400);
    const removed = await v.agentCall(DANA, "DELETE", `/v1/app/projects/web/event-hooks/${hookId}`, {});
    expect(removed.status).toBe(200);
    expect((await hw.store.record(ORG_A, hookId))!.status).toBe("disabled");
  });
});

describe("through Task 20's dispatch", () => {
  it("starts one chain run for an ALARM that the trigger's alarm filter names, and none for another alarm or an OK", async () => {
    const v = setupTriggerWorld();
    (v.routeDeps as { log?: unknown }).log = () => undefined;
    const w = setupHookWorld({ cloudwatch: cloudwatchProvider }, { db: v.db, clock: v.clock });
    const net = new FakeSnsNetwork();
    Object.assign(w.deps, { snsFetch: net.fetch, awsAccounts: { isConnected: async (org: string, account: string) => org === ORG_A && account === SNS_ACCOUNT } });
    w.deps.dispatch = async (orgId, event) => dispatchTriggerEvent(v.routeDeps as never, orgId, event);
    const chain = await v.budgetedChain(ONE_STEP);
    const hook = await w.hook({ source: "cloudwatch", hookId: HOOK_A, project: "web", tenant: CW_TENANT as never, auth: "sns", hasSecret: false, status: "active", secret: null });
    v.hook("cloudwatch", HOOK_A);
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec: { kind: "event", source: "cloudwatch", type: "alarm.fired", filter: { alarm: ["HighCPU"], namespace: ["AWS/EC2"] } }, hookId: HOOK_A });
    const runs = () => v.db.find((item) => String(item["pk"]).includes("#CHAIN_RUN#") && item["sk"] === "META");
    await w.receive(snsDelivery(hook, notification({ messageId: "o1", alarm: { name: "DiskFull" } })));
    await w.receive(snsDelivery(hook, notification({ messageId: "o2", alarm: { state: "OK" } })));
    expect(runs()).toEqual([]);
    expect((await w.receive(snsDelivery(hook, notification({ messageId: "hit" })))).status).toBe(202);
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toMatchObject({ origin: "event", project: "web", startedBy: { kind: "event", triggerId: trigger.triggerId, source: "cloudwatch", type: "alarm.fired" } });
    expect(await w.receive(snsDelivery(hook, notification({ messageId: "hit" })))).toEqual({ status: 200, body: { delivery: "DUPLICATE" } });
    expect(runs()).toHaveLength(1);
  });
});

// ---- Layer 4: logs

describe("what the code leaves in logs", () => {
  it("keeps the alarm, its reason, the token, the URLs and the signature out of every log line, on every path", async () => {
    const MARK = "PAYLOAD-MARK-271828";
    const { w, net, hook, connected } = await cwWorld({ status: "pending_confirmation" });
    const send = (text: string, options: Sending = {}) => w.receive(snsDelivery(hook, text, options));
    const secretToken = `${MARK}-token`;
    await send(subscription({ token: secretToken, subscribeUrl: subscribeUrl({ host: `${MARK}.example.com`, token: secretToken }) }), { type: "SubscriptionConfirmation" });
    net.confirm = "fail";
    await send(subscription({ token: secretToken, messageId: "c2" }), { type: "SubscriptionConfirmation" });
    net.confirm = { status: 200, body: confirmXml(`${OTHER_TOPIC_ARN}:${MARK}`) };
    await send(subscription({ token: secretToken, messageId: "c3" }), { type: "SubscriptionConfirmation" });
    connected.clear();
    await send(subscription({ token: secretToken, messageId: "c4" }), { type: "SubscriptionConfirmation" });
    connected.add(`${ORG_A}|${SNS_ACCOUNT}`);
    net.confirm = { status: 200, body: confirmXml() };
    await send(subscription({ token: secretToken, messageId: "c5" }), { type: "SubscriptionConfirmation" });
    const alarm: AlarmOver = { name: `${MARK}-alarm`, reason: `${MARK}-reason` };
    const fields: SnsFields = notificationFields({ subject: `${MARK}-subject`, alarm });
    await send(signSns(fields, { key: OTHER_SIGNING_KEY_PEM }));
    await send(signSns(fields, { certUrl: `https://sns.evil.example/${MARK}.pem` }));
    await send(signSns(notificationFields({ topicArn: OTHER_TOPIC_ARN, alarm })), { topicHeader: OTHER_TOPIC_ARN });
    await send(signSns(notificationFields({ alarm: { ...alarm, account: OTHER_ACCOUNT }, messageId: "n3" })));
    await send(signSns(notificationFields({ message: `${MARK} not json`, messageId: "n4" })));
    await send(signSns(fields));
    await send(`${MARK} not json`);
    await send(signSns(confirmationFields("UnsubscribeConfirmation", { token: secretToken })), { type: "UnsubscribeConfirmation" });
    const everything = JSON.stringify(w.logs);
    for (const forbidden of [MARK, secretToken, "Signature", "SubscribeURL", "amazonaws.com", SNS_TOPIC_ARN, SNS_ACCOUNT]) expect(everything, forbidden).not.toContain(forbidden);
    // The refusals did log (a URL refused, an account not connected, a fault), so the absence above means something.
    expect(w.logs.length).toBeGreaterThanOrEqual(3);
    for (const entry of w.logs) expect(Object.keys(entry.fields).every((key) => key === "hookId" || key === "error")).toBe(true);
    expect(w.dispatched).toHaveLength(1);
  });
});

// ---- pins: the edges the first mutation pass found alive

function snsVerifier(fetchUnder?: typeof fetch) {
  const net = new FakeSnsNetwork();
  const memory = new SnsCertMemory();
  return { net, memory, verify: (text: string, now = START) => verifySnsMessage({ memory, fetch: fetchUnder ?? net.fetch }, asMessage(text), now) };
}

describe("pins: signature and certificate edges", () => {
  it("refuses a signature with anything but base64 around or inside it, though the decoder would skip it", async () => {
    const { verify } = snsVerifier();
    const signed = JSON.parse(notification()) as { Signature: string };
    const good = signed.Signature;
    const tamper = (value: string) => JSON.stringify({ ...signed, Signature: value });
    expect(await verify(tamper(good))).toBe(true);
    for (const value of [`!!${good}`, `${good.slice(0, 10)}!!${good.slice(10)}`, `${good}!!`, `${good}\n`, ` ${good}`, `${good.slice(0, 10)} ${good.slice(10)}`]) expect(await verify(tamper(value)), value.slice(0, 20)).toBe(false);
  });

  it("refuses the US government partition's topics and hosts, and any other partition (review I-1)", async () => {
    const { verify, net } = snsVerifier();
    const certUrl = "https://sns.us-gov-west-1.amazonaws.com/SimpleNotificationService-0123.pem";
    net.certs.set(certUrl, TEST_CERT_PEM);
    expect(await verify(notification({ topicArn: "arn:aws-us-gov:sns:us-gov-west-1:123456789012:t" }, { certUrl }))).toBe(false);
    expect(await verify(notification({ topicArn: "arn:aws-iso:sns:us-iso-east-1:123456789012:t" }, { certUrl }))).toBe(false);
    expect(net.requests).toEqual([]);
  });

  it("refuses a topic ARN that has anything before or after it, or a name with characters a topic can't have", async () => {
    const { verify, net } = snsVerifier();
    for (const topicArn of [`x${SNS_TOPIC_ARN}`, `${SNS_TOPIC_ARN}/evil`, `${SNS_TOPIC_ARN} `, `${SNS_TOPIC_ARN}\n`, `${SNS_TOPIC_ARN}:sub`, "arn:aws:sns:us-east-1:12345678901:t", "arn:aws:sns:us-east-1:123456789012:"]) {
      expect(await verify(notification({ topicArn })), topicArn).toBe(false);
    }
    expect(net.requests).toEqual([]);
  });

  it("refuses a certificate name that is empty, hidden, starts with a dash, or does not end in .pem", async () => {
    const { verify, net } = snsVerifier();
    for (const name of [".pem", ".hidden.pem", "-x.pem", "xpem", "x.pem.txt", "x/y.pem", "x%2fy.pem", "x y.pem"]) {
      const certUrl = `https://sns.${SNS_REGION}.amazonaws.com/${name}`;
      net.certs.set(certUrl, TEST_CERT_PEM);
      expect(await verify(notification({}, { certUrl })), name).toBe(false);
    }
    expect(net.requests).toEqual([]);
    const certUrl = `https://sns.${SNS_REGION}.amazonaws.com/a.b-c_d9.pem`;
    net.certs.set(certUrl, TEST_CERT_PEM);
    expect(await verify(notification({}, { certUrl }))).toBe(true);
  });

  it("keeps a certificate for just under the cache time and fetches it again at exactly that time", async () => {
    const { verify, net } = snsVerifier();
    const text = notification();
    await verify(text);
    await verify(text, START + SNS_CERT_CACHE_HOURS * HOUR - 1);
    expect(net.certRequests).toHaveLength(1);
    await verify(text, START + SNS_CERT_CACHE_HOURS * HOUR);
    expect(net.certRequests).toHaveLength(2);
  });

  it("keeps at most a bounded number of certificates, the oldest going first", async () => {
    const { verify, net } = snsVerifier();
    const total = 205;
    let now = START;
    for (let index = 0; index < total; index += 1) {
      const certUrl = CERT_URL_OF(`bound${String(index)}`);
      net.certs.set(certUrl, TEST_CERT_PEM);
      if (index % SNS_CERT_FETCHES_PER_MINUTE === 0) now += 2 * MINUTE;
      expect(await verify(notification({ messageId: `b${String(index)}` }, { certUrl }), now), String(index)).toBe(true);
    }
    expect(net.certRequests).toHaveLength(total);
    // The last one is still kept; the first was dropped to make room, so it is fetched again.
    await verify(notification({}, { certUrl: CERT_URL_OF(`bound${String(total - 1)}`) }), now);
    expect(net.certRequests).toHaveLength(total);
    now += 2 * MINUTE;
    await verify(notification({}, { certUrl: CERT_URL_OF("bound0") }), now);
    expect(net.certRequests).toHaveLength(total + 1);
  });

  it("allows the next fetch at exactly one minute after the allowance was used up, and not a millisecond before", async () => {
    const { verify, net } = snsVerifier();
    const urls = Array.from({ length: SNS_CERT_FETCHES_PER_MINUTE + 2 }, (_value, index) => CERT_URL_OF(`edge${String(index)}`));
    for (const url of urls) net.certs.set(url, TEST_CERT_PEM);
    for (const url of urls.slice(0, SNS_CERT_FETCHES_PER_MINUTE)) expect(await verify(notification({}, { certUrl: url }), START)).toBe(true);
    expect(await verify(notification({}, { certUrl: urls[SNS_CERT_FETCHES_PER_MINUTE]! }), START + MINUTE - 1)).toBe(false);
    expect(await verify(notification({}, { certUrl: urls[SNS_CERT_FETCHES_PER_MINUTE]! }), START + MINUTE)).toBe(true);
  });

  it("refuses a certificate answered with any status but 200, though its body is the certificate", async () => {
    const odd: typeof fetch = async () => new Response(TEST_CERT_PEM, { status: 203 });
    expect(await snsVerifier(odd).verify(notification())).toBe(false);
    const ok: typeof fetch = async () => new Response(TEST_CERT_PEM, { status: 200 });
    expect(await snsVerifier(ok).verify(notification())).toBe(true);
  });

  it("accepts a certificate on its first and its last second of validity and refuses the second outside", async () => {
    const { verify } = snsVerifier();
    const text = notification();
    expect(await verify(text, Date.parse("2020-01-01T00:00:00Z"))).toBe(true);
    expect(await verify(text, Date.parse("2120-01-01T00:00:00Z"))).toBe(true);
    expect(await verify(text, Date.parse("2019-12-31T23:59:59Z"))).toBe(false);
    expect(await verify(text, Date.parse("2120-01-01T00:00:01Z"))).toBe(false);
  });

  it("answers false, never an error, for a message that makes the check itself fail", async () => {
    const { memory, net } = snsVerifier();
    const hostile = { ...asMessage(notification()), get Message(): string { throw new Error("boom"); } };
    expect(await verifySnsMessage({ memory, fetch: net.fetch }, hostile, START)).toBe(false);
  });

  it("gives up on a certificate and on a confirmation that hang, after the deadline of five seconds, not fifteen", async () => {
    const hang: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "TimeoutError")));
    });
    const started = Date.now();
    const cert = snsVerifier(hang).verify(notification());
    const { w, hook, net } = await cwWorld({ status: "pending_confirmation" });
    Object.assign(w.deps, { snsFetch: ((input, init) => ((input instanceof Request ? input.url : String(input)).includes("ConfirmSubscription") ? hang(input, init) : net.fetch(input, init))) satisfies typeof fetch });
    const confirm = w.receive(snsDelivery(hook, subscription(), { type: "SubscriptionConfirmation" }));
    const [verified, answered] = await Promise.all([cert, confirm]);
    expect(verified).toBe(false);
    expect(answered.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(9_000);
  }, 20_000);
});

describe("pins: the provider and the route", () => {
  it("logs a tenant refusal for an alarm with no account or a numeric one, so the refusal is the check's and not a fault", async () => {
    const { w, hook } = await cwWorld();
    await w.receive(snsDelivery(hook, notification({ messageId: "x2", message: JSON.stringify({ ...JSON.parse(alarmJson()), AWSAccountId: undefined }) })));
    await w.receive(snsDelivery(hook, notification({ messageId: "x3", message: JSON.stringify({ ...JSON.parse(alarmJson()), AWSAccountId: Number(SNS_ACCOUNT) }) })));
    expect(w.logs.map((entry) => entry.event)).toEqual(["hook.tenant_mismatch", "hook.tenant_mismatch"]);
  });

  it("keeps an alarm whose name makes the console link longer than an event may carry (each character is twelve characters of link), and gives it no link", async () => {
    const { w, hook } = await cwWorld();
    const name = "😀".repeat(255);
    expect((await w.receive(snsDelivery(hook, notification({ alarm: { name } })))).status).toBe(202);
    expect(w.dispatched).toHaveLength(1);
    expect(w.dispatched[0]!.event.subject).not.toHaveProperty("url");
    expect([...w.dispatched[0]!.event.subject.id]).toHaveLength(200);
  });

  it("confirmationTarget reads only a SubscriptionConfirmation and a token that is not empty", async () => {
    const { hook } = await cwWorld();
    expect(hook.hookId).toBe(HOOK_1);
    const unsubscribe = asMessage(unsubscription());
    expect(unsubscribe.SubscribeURL).toBeDefined();
    expect(confirmationTarget(unsubscribe, SNS_TOPIC_ARN)).toBeUndefined();
    const empty = asMessage(subscription({ token: "", subscribeUrl: subscribeUrl({ token: "" }) }));
    expect(empty.Token).toBe("");
    expect(confirmationTarget(empty, SNS_TOPIC_ARN)).toBeUndefined();
  });

  it("counts a failed verification against the hook", async () => {
    const { w, hook } = await cwWorld();
    expect(w.memory.failures.count(hook.hookId, START)).toBe(0);
    await w.receive(snsDelivery(hook, notification({}, { key: OTHER_SIGNING_KEY_PEM })));
    await w.receive(snsDelivery(hook, notification({}, { version: "1", hash: "sha1" })));
    expect(w.memory.failures.count(hook.hookId, START)).toBe(2);
    await w.receive(snsDelivery(hook, notification()));
    expect(w.memory.failures.count(hook.hookId, START)).toBe(2);
  });

  it("does not confirm on SNS's answer unless it is a 200 with a subscription of this topic whose last part is an id, nothing before or after it", async () => {
    const { w, net, hook, stored } = await cwWorld({ status: "pending_confirmation" });
    const id = "2bcfbf39-05c3-41de-beaa-fcfcc21c8f55";
    const refused: Array<{ status: number; body: string }> = [
      { status: 500, body: confirmXml() },
      { status: 202, body: confirmXml() },
      { status: 200, body: confirmXml(`${SNS_TOPIC_ARN}:not-an-id`) },
      { status: 200, body: confirmXml(`${SNS_TOPIC_ARN}:${id}-extra`) },
      { status: 200, body: confirmXml(`${SNS_TOPIC_ARN}:junk${id}`) },
      { status: 200, body: confirmXml(`${SNS_TOPIC_ARN}:${id}:more`) },
      { status: 200, body: `${"x".repeat(70_000)}${confirmXml()}` },
    ];
    for (const [index, answer] of refused.entries()) {
      net.confirm = answer;
      expect((await w.receive(snsDelivery(hook, subscription({ messageId: `p${String(index)}` }), { type: "SubscriptionConfirmation" }))).status, String(index)).toBe(503);
    }
    expect((await stored()).status).toBe("pending_confirmation");
  });

  it("answers 403 to a delivery for a hook of another source that is waiting for confirmation, which only an SNS hook may do", async () => {
    const w = setupHookWorld();
    const hook = await w.hook({ source: "linear", hookId: HOOK_1, status: "pending_confirmation" });
    const body = { id: "a", tenant: LINEAR_TENANT };
    expect(await w.receive(w.delivery(hook, body))).toEqual(FORBIDDEN);
    expect(w.dispatched).toEqual([]);
    // The same signed delivery is taken by an active hook, so the refusal above is the status's.
    const active = await w.hook({ source: "linear", hookId: `hk_${"5".repeat(26)}`, status: "active" });
    expect((await w.receive(w.delivery(active, body))).status).toBe(202);
  });
});
