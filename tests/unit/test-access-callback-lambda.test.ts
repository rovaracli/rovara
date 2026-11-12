// Customer test AWS account, lane TA2: the Lambda entry end to end: a SIGNED SNS event (generated key pair), the real verifier, the DynamoDB store (fake client), the real handler; then the admin's confirm and the connection test on the same
// store. Proves the pieces fit and that the environment gates the function.
import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { connectionExternalId } from "@agentx/cloud-contracts";
import { callbackLambdaDeps, runCallbackLambda } from "../../packages/broker/src/test-access/callback-lambda.js";
import { confirmConnection, startConnection } from "../../packages/broker/src/test-access/connect.js";
import { dynamoTestAccessStore } from "../../packages/broker/src/test-access/dynamo-store.js";
import { snsCanonicalString } from "../../packages/broker/src/test-access/sns-verify.js";
import { FakeDynamoClient } from "../support/fake-dynamo-client.js";
import { ACCOUNT, NOW, ORG, PROJECT, REGION, ROVARA_ACCOUNT, TOPIC, callbackRequest, caller, connectionExternalIdOfLast, tokenOfLink, world } from "../support/test-access-fixtures.js";

const ENV = { TEST_ACCESS_TABLE_NAME: "state", TEST_ACCESS_TOPIC_ARNS: TOPIC, TEST_ACCESS_ROVARA_ACCOUNT_IDS: ROVARA_ACCOUNT, TEST_ACCOUNTS_ENABLED: "1" } as NodeJS.ProcessEnv;
const CERT_URL = "https://sns.us-west-2.amazonaws.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem";
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });

function signedEvent(request: Record<string, unknown>, over: Record<string, unknown> = {}) {
  const fields = { Message: JSON.stringify(request), MessageId: "m-1", Timestamp: new Date(NOW).toISOString(), TopicArn: TOPIC, ...over };
  const Signature = createSign("RSA-SHA256").update(snsCanonicalString(fields)).sign(pair.privateKey, "base64");
  return { Records: [{ EventSubscriptionArn: `${TOPIC}:sub`, EventSource: "aws:sns", Sns: { Type: "Notification", ...fields, SignatureVersion: "2", Signature, SigningCertUrl: CERT_URL } }] };
}

function setup(env: NodeJS.ProcessEnv = ENV) {
  const w = world();
  const dynamo = new FakeDynamoClient();
  const puts: Array<{ url: string; redirect: unknown; body: Record<string, unknown> }> = [];
  const input = {
    env, documentClient: dynamo, now: () => w.clock.ms, publicKey: () => Promise.resolve(pair.publicKey), log: () => undefined,
    fetch: ((url: string, init: { redirect?: unknown; body: string }) => { puts.push({ url, redirect: init.redirect, body: JSON.parse(init.body) as Record<string, unknown> }); return Promise.resolve({ ok: true, status: 200 }); }) as unknown as typeof fetch,
  };
  const store = dynamoTestAccessStore({ documentClient: dynamo, tableName: "state" });
  const connectDeps = { ...w.connectDeps, store };
  return { w, dynamo, puts, input, store, connectDeps };
}

describe("the Lambda entry", () => {
  it("a signed Create attaches the account as reported; the admin confirms; the connection test passes", async () => {
    const { w, puts, input, store, connectDeps } = setup();
    const started = await startConnection(connectDeps, caller(), { projectId: PROJECT, region: REGION });
    const id = started.connection.connectionId;
    connectionExternalIdOfLast.value = connectionExternalId(ORG, id);
    const words = await runCallbackLambda(signedEvent(callbackRequest({ connectionId: id, token: tokenOfLink(started.link) })), input);
    expect(words).toEqual(["connected"]);
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ redirect: "error", body: { Status: "SUCCESS" } });
    expect(await store.getConnection(ORG, id)).toMatchObject({ status: "reported", accountId: ACCOUNT });
    const view = await confirmConnection(connectDeps, caller(), id, { accountId: ACCOUNT });
    expect(view).toMatchObject({ status: "connected", alias: "beta-shared" });
    expect(w.assumeCalls.length).toBeGreaterThan(0);
  });

  it("an unsigned, wrongly signed, wrong-topic or replayed-stale event changes nothing and is not answered", async () => {
    const { dynamo, puts, input, store, connectDeps } = setup();
    const started = await startConnection(connectDeps, caller(), { projectId: PROJECT, region: REGION });
    const id = started.connection.connectionId;
    const request = callbackRequest({ connectionId: id, token: tokenOfLink(started.link) });
    const good = signedEvent(request);
    const tampered = structuredClone(good);
    tampered.Records[0]!.Sns.Message = JSON.stringify({ ...request, ResponseURL: "https://attacker.example.com/x" });
    const otherTopic = signedEvent(request, { TopicArn: "arn:aws:sns:us-west-2:111122223333:agentx-test-access-callback" });
    const stale = signedEvent(request, { Timestamp: new Date(NOW - 11 * 60_000).toISOString() });
    const noSignature = structuredClone(good);
    delete (noSignature.Records[0]!.Sns as { Signature?: string }).Signature;
    expect(await runCallbackLambda(tampered, input)).toEqual(["dropped_signature"]);
    expect(await runCallbackLambda(otherTopic, input)).toEqual(["dropped_topic"]);
    expect(await runCallbackLambda(stale, input)).toEqual(["dropped_timestamp"]);
    expect(await runCallbackLambda(noSignature, input)).toEqual(["dropped_malformed"]);
    expect(puts).toHaveLength(0);
    expect(await store.getConnection(ORG, id)).toMatchObject({ status: "awaiting", version: 1 });
    expect([...dynamo.items.keys()].some((key) => key.startsWith("TASTACK#"))).toBe(false);
  });

  it("throws when the function's environment is incomplete or malformed, so nothing is answered wrongly", async () => {
    for (const env of [{}, { ...ENV, TEST_ACCESS_TABLE_NAME: "" }, { ...ENV, TEST_ACCESS_TOPIC_ARNS: "" }, { ...ENV, TEST_ACCESS_ROVARA_ACCOUNT_IDS: "" }, { ...ENV, TEST_ACCESS_ROVARA_ACCOUNT_IDS: "12" }] as NodeJS.ProcessEnv[]) {
      const { input } = setup(env);
      expect(callbackLambdaDeps(input)).toBeUndefined();
      await expect(runCallbackLambda({ Records: [] }, input)).rejects.toThrow("not configured");
    }
  });

  it("with the ta switch off a Create is answered not-ready and nothing is recorded", async () => {
    const { puts, input, store, connectDeps } = setup({ ...ENV, TEST_ACCOUNTS_ENABLED: "0" });
    const started = await startConnection(connectDeps, caller(), { projectId: PROJECT, region: REGION });
    const id = started.connection.connectionId;
    expect(await runCallbackLambda(signedEvent(callbackRequest({ connectionId: id, token: tokenOfLink(started.link) })), input)).toEqual(["dropped_disabled"]);
    expect(puts[0]!.body).toMatchObject({ Status: "FAILED" });
    expect((await store.getConnection(ORG, id))?.status).toBe("awaiting");
  });

  it("uses the company's production list from its approved environment, and an unreadable one retries", async () => {
    const { dynamo, input, connectDeps } = setup();
    const started = await startConnection(connectDeps, caller(), { projectId: PROJECT, region: REGION });
    const id = started.connection.connectionId;
    const event = signedEvent(callbackRequest({ connectionId: id, token: tokenOfLink(started.link) }));
    // An environment read that throws must not be read as "no production list": the handler rethrows, and nothing is recorded.
    const failing = { send: (command: unknown) => (/^Get/u.test((command as object).constructor.name) && JSON.stringify((command as { input: unknown }).input).includes("TESTENV#LATEST") ? Promise.reject(new Error("read failed")) : dynamo.send(command)) };
    await expect(runCallbackLambda(event, { ...input, documentClient: failing })).rejects.toThrow("read failed");
  });
});
