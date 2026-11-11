// Plan 4 Task 25, review fixes. I-1: the SNS region is a real commercial AWS region (so `s3` can't make the trusted host `sns.s3.amazonaws.com`, an S3 address), where the hook is made
// and where the host is built. M-2: a delivery is believed only while the hook's AWS account is still one the org connected (read now), and removing that connection turns the hooks of
// the account off.
import { afterEach, describe, expect, it } from "vitest";
import { HOOK_TENANT_SCHEMAS } from "@rovara-code/contracts";
import { disableHooksOfAccount, type HookStore } from "../../packages/broker/src/triggers/hooks.js";
import { cloudwatchProvider } from "../../packages/broker/src/triggers/providers/cloudwatch-sns.js";
import { SnsCertMemory, parseSnsMessage, snsHostOfTopic, verifySnsMessage } from "../../packages/broker/src/triggers/sns-verify.js";
import { OrgConnectionStore } from "../../packages/broker/src/connections/store.js";
import { OrgSecrets } from "../../packages/broker/src/connections/org-secrets.js";
import type { HookRecord } from "@rovara-code/contracts";
import { HOOK_1, LINEAR_TENANT, ORG_A, ORG_B, setupHookWorld } from "../support/hook-fixtures.js";
import { START } from "../support/chain-run-world.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { FAKE_CONNECTOR_ROLE_ARN, FakeOrgSecrets } from "../support/fake-org-secrets.js";
import { FakeSnsNetwork, SNS_ACCOUNT, SNS_REGION, SNS_TOPIC_ARN, TEST_CERT_PEM, notificationFields, signSns } from "../support/sns-fixtures.js";
import type { HookDelivery } from "../../packages/broker/src/triggers/ingress.js";
import { disposeGateWorlds } from "../support/trigger-world.js";

afterEach(disposeGateWorlds);

const topicIn = (region: string): string => `arn:aws:sns:${region}:${SNS_ACCOUNT}:rovara-alarms`;
const certUrlIn = (region: string): string => `https://sns.${region}.amazonaws.com/SimpleNotificationService-0123.pem`;

describe("I-1: the SNS region must be a real AWS region", () => {
  it.each(["s3", "foo", "", "us-gov-west-1", "cn-north-1", "us-west", "us-west-22", "US-WEST-2", "us-west-2 ", "xx-west-2"])("the hook's tenant refuses a topic in region %j", (region) => {
    expect(HOOK_TENANT_SCHEMAS.cloudwatch.safeParse({ awsAccountId: SNS_ACCOUNT, topicArn: topicIn(region) }).success, region).toBe(false);
  });

  it.each(["us-west-2", "us-east-1", "eu-central-1", "ap-southeast-4", "sa-east-1", "ca-central-1", "me-south-1", "af-south-1", "il-central-1", "mx-central-1"])("the hook's tenant accepts a topic in %s", (region) => {
    expect(HOOK_TENANT_SCHEMAS.cloudwatch.safeParse({ awsAccountId: SNS_ACCOUNT, topicArn: topicIn(region) }).success, region).toBe(true);
  });

  it("the China and US government partitions are not accepted (their SNS hosts differ)", () => {
    expect(HOOK_TENANT_SCHEMAS.cloudwatch.safeParse({ awsAccountId: SNS_ACCOUNT, topicArn: `arn:aws-cn:sns:cn-north-1:${SNS_ACCOUNT}:t` }).success).toBe(false);
    expect(HOOK_TENANT_SCHEMAS.cloudwatch.safeParse({ awsAccountId: SNS_ACCOUNT, topicArn: `arn:aws-us-gov:sns:us-gov-west-1:${SNS_ACCOUNT}:t` }).success).toBe(false);
    expect(snsHostOfTopic(`arn:aws-cn:sns:cn-north-1:${SNS_ACCOUNT}:t`)).toBeUndefined();
    expect(snsHostOfTopic(`arn:aws-us-gov:sns:us-gov-west-1:${SNS_ACCOUNT}:t`)).toBeUndefined();
  });

  it("refuses a topic of another partition that names a commercial region, and a region with two digits or none", () => {
    for (const topicArn of [`arn:aws-cn:sns:us-east-1:${SNS_ACCOUNT}:t`, `arn:aws-us-gov:sns:us-east-1:${SNS_ACCOUNT}:t`, `arn:aws-iso:sns:us-east-1:${SNS_ACCOUNT}:t`]) {
      expect(HOOK_TENANT_SCHEMAS.cloudwatch.safeParse({ awsAccountId: SNS_ACCOUNT, topicArn }).success, topicArn).toBe(false);
      expect(snsHostOfTopic(topicArn), topicArn).toBeUndefined();
    }
    expect(snsHostOfTopic(`arn:aws:sns:us-east-11:${SNS_ACCOUNT}:t`)).toBeUndefined();
    expect(snsHostOfTopic(`arn:aws:sns:us-east-:${SNS_ACCOUNT}:t`)).toBeUndefined();
  });

  it("builds no host for an unreal region, and the host of a real one", () => {
    for (const region of ["s3", "foo", ""]) expect(snsHostOfTopic(topicIn(region)), region).toBeUndefined();
    expect(snsHostOfTopic(topicIn("us-west-2"))).toBe("sns.us-west-2.amazonaws.com");
  });

  it("verifies nothing and fetches nothing for a topic in region `s3`, though a certificate would be served at sns.s3.amazonaws.com", async () => {
    const net = new FakeSnsNetwork();
    const url = "https://sns.s3.amazonaws.com/SimpleNotificationService-0123.pem";
    net.certs.set(url, TEST_CERT_PEM);
    const text = signSns(notificationFields({ topicArn: topicIn("s3") }), { certUrl: url });
    const message = parseSnsMessage(JSON.parse(text))!;
    expect(await verifySnsMessage({ memory: new SnsCertMemory(), fetch: net.fetch }, message, START)).toBe(false);
    expect(net.requests).toEqual([]);
  });

  it("verifies a notification for a topic in us-west-2 against that region's host", async () => {
    const net = new FakeSnsNetwork();
    net.certs.set(certUrlIn("us-west-2"), TEST_CERT_PEM);
    const message = parseSnsMessage(JSON.parse(signSns(notificationFields({ topicArn: topicIn("us-west-2") }), { certUrl: certUrlIn("us-west-2") })))!;
    expect(await verifySnsMessage({ memory: new SnsCertMemory(), fetch: net.fetch }, message, START)).toBe(true);
  });
});

// ---- M-2

const TENANT = { awsAccountId: SNS_ACCOUNT, topicArn: SNS_TOPIC_ARN };
const FORBIDDEN = { status: 403, body: { error: { code: "FORBIDDEN", message: "signature check failed" } } };

async function world(connected: Set<string>) {
  const w = setupHookWorld({ cloudwatch: cloudwatchProvider });
  const net = new FakeSnsNetwork();
  Object.assign(w.deps, { snsFetch: net.fetch, awsAccounts: { isConnected: async (org: string, account: string) => connected.has(`${org}|${account}`) } });
  const hook = await w.hook({ source: "cloudwatch", hookId: HOOK_1, project: "web", tenant: TENANT as never, auth: "sns", hasSecret: false, status: "active", secret: null });
  return { w, net, hook };
}

const deliveryOf = (hook: Pick<HookRecord, "hookId">, body: string): HookDelivery => ({
  source: "cloudwatch", hookId: hook.hookId, raw: Buffer.from(body, "utf8"), sourceIp: "205.251.233.1",
  headers: { "content-type": "text/plain; charset=UTF-8", "x-amz-sns-topic-arn": SNS_TOPIC_ARN, "x-amz-sns-message-type": "Notification" },
});

describe("M-2: a delivery needs the hook's AWS account to be connected now", () => {
  it("dispatches while the account is connected, and answers 403 with nothing dispatched or written once it is not, logging the hook only", async () => {
    const connected = new Set([`${ORG_A}|${SNS_ACCOUNT}`]);
    const { w, hook } = await world(connected);
    expect((await w.receive(deliveryOf(hook, signSns(notificationFields({ messageId: "m-1" }))))).status).toBe(202);
    expect(w.dispatched).toHaveLength(1);
    connected.clear();
    const mark = w.dispatched.length;
    const writes = w.db.commandNames().length;
    expect(await w.receive(deliveryOf(hook, signSns(notificationFields({ messageId: "m-2" }))))).toEqual(FORBIDDEN);
    expect(w.dispatched).toHaveLength(mark);
    expect(w.writesSince(writes)).toEqual([]);
    expect(w.logs.filter((entry) => entry.event === "hook.sns_account_not_connected")).toEqual([{ event: "hook.sns_account_not_connected", fields: { hookId: HOOK_1 } }]);
  });

  it("checks the hook's own org: another org's connection of the account does not count", async () => {
    const { w, hook } = await world(new Set([`${ORG_B}|${SNS_ACCOUNT}`]));
    expect(await w.receive(deliveryOf(hook, signSns(notificationFields({ messageId: "m-3" }))))).toEqual(FORBIDDEN);
    expect(w.dispatched).toEqual([]);
  });

  it("fails closed where the connection check is not available", async () => {
    const { w, hook } = await world(new Set([`${ORG_A}|${SNS_ACCOUNT}`]));
    delete (w.deps as { awsAccounts?: unknown }).awsAccounts;
    expect(await w.receive(deliveryOf(hook, signSns(notificationFields({ messageId: "m-4" }))))).toEqual(FORBIDDEN);
    expect(w.dispatched).toEqual([]);
  });

  it("does not read the connections for a delivery whose signature fails", async () => {
    const reads: string[] = [];
    const { w, hook } = await world(new Set());
    Object.assign(w.deps, { awsAccounts: { isConnected: async (org: string) => { reads.push(org); return true; } } });
    const forged = JSON.parse(signSns(notificationFields({ messageId: "m-5" }))) as Record<string, string>;
    forged["Message"] = "changed after signing";
    expect(await w.receive(deliveryOf(hook, JSON.stringify(forged)))).toEqual(FORBIDDEN);
    expect(reads).toEqual([]);
  });
});

describe("M-2: removing the connection turns the account's hooks off", () => {
  it("disables each CloudWatch hook of that account and org, and only when no other connection of the org still holds the account", async () => {
    const w = setupHookWorld({ cloudwatch: cloudwatchProvider });
    const store: HookStore = w.store;
    const other = { awsAccountId: "210987654321", topicArn: `arn:aws:sns:us-east-1:210987654321:t` };
    const make = (hookId: string, tenant: object, orgId = ORG_A) => w.hook({ orgId, source: "cloudwatch", hookId, project: "web", tenant: tenant as never, auth: "sns", hasSecret: false, status: "active", secret: null });
    const mine = await make(HOOK_1, TENANT);
    const second = await make(`hk_${"d".repeat(26)}`, TENANT);
    const elsewhere = await make(`hk_${"e".repeat(26)}`, other);
    const theirs = await make(`hk_${"f".repeat(26)}`, TENANT, ORG_B);
    const off = await w.hook({ source: "cloudwatch", hookId: `hk_${"g".repeat(26)}`, project: "web", tenant: TENANT as never, auth: "sns", hasSecret: false, status: "disabled", secret: null });
    const linear = await w.hook({ source: "linear", hookId: `hk_${"h".repeat(26)}`, project: "web", tenant: LINEAR_TENANT as never, auth: "hmac", secret: "s".repeat(32) });
    const stillConnected = { isConnected: async () => true };
    expect(await disableHooksOfAccount({ store, awsAccounts: stillConnected }, ORG_A, SNS_ACCOUNT)).toBe(0);
    expect((await store.record(ORG_A, mine.hookId))!.status).toBe("active");
    const gone = { isConnected: async () => false };
    expect(await disableHooksOfAccount({ store, awsAccounts: gone }, ORG_A, SNS_ACCOUNT)).toBe(2);
    for (const hook of [mine, second]) expect((await store.record(ORG_A, hook.hookId))!.status).toBe("disabled");
    expect((await store.record(ORG_A, elsewhere.hookId))!.status).toBe("active");
    expect((await store.record(ORG_A, linear.hookId))!.status).toBe("active");
    expect((await store.record(ORG_A, off.hookId))!.status).toBe("disabled");
    expect((await store.record(ORG_B, theirs.hookId))!.status).toBe("active");
    expect(await store.orgOf(mine.hookId)).toBeUndefined();
  });

  it("the connection store tells its caller what was removed, after it is gone, and a failing callback does not undo the removal", async () => {
    const fake = new FakeOrgSecrets({ env: "staging", now: () => START });
    const db = new FakeDynamoDb();
    const secrets = new OrgSecrets({ env: "staging", roleArn: FAKE_CONNECTOR_ROLE_ARN, sts: fake.sts, secretsFor: fake.secretsFor, now: () => START });
    const seen: unknown[] = [];
    let fail = false;
    const store = new OrgConnectionStore({
      documentClient: db, tableName: "T", env: "staging", secrets, now: () => START, checkEndpoint: async () => undefined,
      // The callback takes a moment: the removal is not over until it is.
      afterRemove: async (removed) => { await new Promise((resolve) => setTimeout(resolve, 5)); seen.push(removed); if (fail) throw new Error("boom"); },
    });
    const role = `arn:aws:iam::${SNS_ACCOUNT}:role/rovara-read`;
    const connection = (connectionId: string) => ({ connectionId, type: "cloudwatch", label: "AWS prod", access: "read", roleArn: role, regions: [SNS_REGION] }) as const;
    await store.put({ orgId: ORG_A, connection: connection("con_aaaaaaaaaaaaaaaaaaaa"), by: "a".repeat(64) });
    await store.put({ orgId: ORG_A, connection: connection("con_bbbbbbbbbbbbbbbbbbbb"), by: "a".repeat(64) });
    await store.remove({ orgId: ORG_A, connectionId: "con_aaaaaaaaaaaaaaaaaaaa", by: "a".repeat(64) });
    expect(seen).toEqual([{ orgId: ORG_A, connectionId: "con_aaaaaaaaaaaaaaaaaaaa", type: "cloudwatch", roleArn: role }]);
    expect(await store.get(ORG_A, "con_aaaaaaaaaaaaaaaaaaaa")).toBeUndefined();
    fail = true;
    await store.remove({ orgId: ORG_A, connectionId: "con_bbbbbbbbbbbbbbbbbbbb", by: "a".repeat(64) });
    expect(await store.get(ORG_A, "con_bbbbbbbbbbbbbbbbbbbb")).toBeUndefined();
    expect(seen).toHaveLength(2);
  });
});
