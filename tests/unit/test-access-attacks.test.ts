// Customer test AWS account, lane TA2: the self-attack list. Each test is something a hostile customer or an outsider could try against the connect flow; each states what must hold. (A numbered list is in the lane's report.)
import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CALLBACK_FAILURE_REASONS, connectionExternalId } from "@agentx/cloud-contracts";
import { handleCallbackEvent } from "../../packages/broker/src/test-access/callback.js";
import { runCallbackLambda } from "../../packages/broker/src/test-access/callback-lambda.js";
import { acknowledgeNotProduction, confirmConnection, disconnectConnection, getConnection, startConnection, submitAccountId, suspendConnection, testConnection } from "../../packages/broker/src/test-access/connect.js";
import { dynamoTestAccessStore } from "../../packages/broker/src/test-access/dynamo-store.js";
import { POLL_SESSION_NAME, pollDue } from "../../packages/broker/src/test-access/poll.js";
import { openTestAccessSession } from "../../packages/broker/src/test-access/session.js";
import { snsCanonicalString } from "../../packages/broker/src/test-access/sns-verify.js";
import { connectTokenHash, mintConnectToken } from "../../packages/broker/src/test-access/token.js";
import { FakeDynamoClient } from "../support/fake-dynamo-client.js";
import { ACCOUNT, ADMIN, NOW, OTHER_ACCOUNT, OTHER_ADMIN, OTHER_ORG, ORG, PROJECT, REGION, ROVARA_ACCOUNT, STACK_ID, TOPIC, callbackRequest, caller, connectionExternalIdOfLast, secretParts, snsEvent, tokenOfLink, world, type Fixture } from "../support/test-access-fixtures.js";

const sessionDeps = (w: Fixture) => ({ enabled: () => w.enabled.value, store: w.store, aws: w.connectDeps.aws, now: () => w.clock.ms, rovaraAccountIds: [ROVARA_ACCOUNT], prodDeny: w.connectDeps.prodDeny });
async function begin(w: Fixture, who = caller(), orgForId = ORG) {
  const started = await startConnection(w.connectDeps, who, { projectId: PROJECT, region: REGION });
  connectionExternalIdOfLast.value = connectionExternalId(orgForId, started.connection.connectionId);
  return { id: started.connection.connectionId, token: tokenOfLink(started.link) };
}
const create = (w: Fixture, c: { id: string; token: string }, over: Record<string, unknown> = {}) => handleCallbackEvent(snsEvent(callbackRequest({ connectionId: c.id, token: c.token, ...over })), w.callbackDeps);
const rec = (w: Fixture, id: string, org = ORG) => w.store.connections.get(`${org}#${id}`)!;
const errorOf = async (call: Promise<unknown>): Promise<(Error & { code?: string }) | undefined> => call.then(() => undefined, (caught: Error & { code?: string }) => caught);

// A real-verifier rig (generated key pair standing in for SNS's certificate), on the DynamoDB adapter.
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });
const CERT_URL = "https://sns.us-west-2.amazonaws.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem";
function rig() {
  const w = world();
  const dynamo = new FakeDynamoClient();
  const fetched: string[] = [];
  const store = dynamoTestAccessStore({ documentClient: dynamo, tableName: "state" });
  const keyFetches: string[] = [];
  const input = {
    env: { TEST_ACCESS_TABLE_NAME: "state", TEST_ACCESS_TOPIC_ARNS: TOPIC, TEST_ACCESS_ROVARA_ACCOUNT_IDS: ROVARA_ACCOUNT, TEST_ACCOUNTS_ENABLED: "1" } as NodeJS.ProcessEnv,
    documentClient: dynamo, now: () => w.clock.ms, log: () => undefined,
    publicKey: (url: string) => { keyFetches.push(url); return Promise.resolve(pair.publicKey); },
    fetch: ((url: string) => { fetched.push(url); return Promise.resolve({ ok: true, status: 200 }); }) as unknown as typeof fetch,
  };
  w.connectDeps.store = store;
  return { w, dynamo, input, fetched, keyFetches, store };
}
function signed(request: Record<string, unknown> | string, over: Record<string, unknown> = {}, key = pair.privateKey, sns: Record<string, unknown> = {}) {
  const fields = { Message: typeof request === "string" ? request : JSON.stringify(request), MessageId: "m-1", Timestamp: new Date(NOW).toISOString(), TopicArn: TOPIC, ...over };
  const Signature = createSign("RSA-SHA256").update(snsCanonicalString(fields)).sign(key, "base64");
  return { Records: [{ EventSubscriptionArn: `${TOPIC}:sub`, Sns: { Type: "Notification", ...fields, SignatureVersion: "2", Signature, SigningCertUrl: CERT_URL, ...sns } }] };
}

describe("A1 forged and A2 mis-addressed messages", () => {
  it("A1: a message signed with a key that is not SNS's, or not signed at all, attaches nothing even with a valid token", async () => {
    const { w, input, store } = rig();
    const c = await begin(w);
    const request = callbackRequest({ connectionId: c.id, token: c.token });
    expect(await runCallbackLambda(signed(request, {}, attacker.privateKey), input)).toEqual(["dropped_signature"]);
    expect(await runCallbackLambda(signed(request, {}, pair.privateKey, { Signature: "AAAA" }), input)).toEqual(["dropped_signature"]);
    expect(await runCallbackLambda(signed(request, {}, pair.privateKey, { SignatureVersion: "0" }), input)).toEqual(["dropped_signature_version"]);
    expect(await store.getConnection(ORG, c.id)).toMatchObject({ status: "awaiting", version: 1 });
    expect([...(await store.listConnections(ORG, 5))].every((r) => r.stackId === undefined)).toBe(true);
  });

  it("A2: a message for another topic, in another account or Region, or a subscription confirmation, is dropped before anything is fetched or parsed", async () => {
    const { w, input, fetched, keyFetches } = rig();
    const c = await begin(w);
    const request = callbackRequest({ connectionId: c.id, token: c.token });
    for (const TopicArn of ["arn:aws:sns:us-west-2:111122223333:agentx-test-access-callback", "arn:aws:sns:us-east-1:999988887777:agentx-test-access-callback", "arn:aws:sns:us-west-2:999988887777:attacker-topic"]) expect(await runCallbackLambda(signed(request, { TopicArn }), input), TopicArn).toEqual(["dropped_topic"]);
    expect(await runCallbackLambda(signed(request, {}, pair.privateKey, { Type: "SubscriptionConfirmation", SubscribeURL: "https://attacker.example.com/confirm" }), input)).toEqual(["dropped_not_notification"]);
    expect(keyFetches).toEqual([]);
    expect(fetched).toEqual([]);
  });
});

describe("A3 replay", () => {
  it("A3: the same signed delivery twice reports once and answers twice; the same token for a new stack, and a captured message after ten minutes, change nothing", async () => {
    const { w, input, store, dynamo } = rig();
    const c = await begin(w);
    const request = callbackRequest({ connectionId: c.id, token: c.token });
    expect(await runCallbackLambda(signed(request), input)).toEqual(["connected"]);
    expect(await runCallbackLambda(signed(request), input)).toEqual(["repeat"]);
    const after = await store.getConnection(ORG, c.id);
    expect(after).toMatchObject({ status: "reported", version: 2, stackId: STACK_ID });
    const otherStack = `arn:aws:cloudformation:${REGION}:${OTHER_ACCOUNT}:stack/Rovara-test-access/99999999-2222-3333-4444-555555555555`;
    expect(await runCallbackLambda(signed(callbackRequest({ connectionId: c.id, token: c.token, StackId: otherStack, accountId: OTHER_ACCOUNT })), input)).toEqual(["refused_token_refused"]);
    expect(await store.getConnection(ORG, c.id)).toEqual(after);
    w.clock.ms += 11 * 60_000;
    expect(await runCallbackLambda(signed(request, { Timestamp: new Date(NOW).toISOString() }), input)).toEqual(["dropped_timestamp"]);
    expect([...dynamo.items.keys()].filter((key) => key.startsWith("TASTACK#"))).toHaveLength(1);
    const confirms = w.store.audits.filter((event) => event.action === "test_access.connection_reported");
    expect(confirms).toHaveLength(0);
  });
});

describe("A4 tenants and A5 the external id", () => {
  it("A4: a token cannot be used for another organization's connection, another project's, or with another organization's external id", async () => {
    const w = world();
    w.admins.add(OTHER_ADMIN);
    const a = await begin(w);
    const b = await begin(w, caller({ orgId: OTHER_ORG, developerId: OTHER_ADMIN, sessionId: "session-other" }), OTHER_ORG);
    // A's token with B's connection and external id; B's token with A's.
    expect(await create(w, { id: b.id, token: a.token }, { properties: { ExternalId: connectionExternalId(OTHER_ORG, b.id) } })).toEqual(["refused_external_id_mismatch"]);
    expect(await create(w, { id: a.id, token: b.token }, { properties: { ExternalId: connectionExternalId(ORG, a.id) } })).toEqual(["refused_external_id_mismatch"]);
    expect(rec(w, a.id).status).toBe("awaiting");
    expect(rec(w, b.id, OTHER_ORG).status).toBe("awaiting");
    expect([...w.store.tokens.values()].every((token) => token.usedAtMs === undefined)).toBe(true);
    // The token's own record disagreeing with the connection (project, organization) is refused as well.
    const tokenA = [...w.store.tokens.values()].find((token) => token.connectionId === a.id)!;
    tokenA.projectId = "someone-elses-project";
    expect(await create(w, a)).toEqual(["refused_token_refused"]);
    tokenA.projectId = PROJECT;
    tokenA.orgId = OTHER_ORG;
    expect(["refused_token_refused", "refused_external_id_mismatch"]).toContain((await create(w, a))[0]);
    expect(rec(w, a.id).status).toBe("awaiting");
  });

  it("A5: the external id sent to AWS is always the stored, derived one; a record whose id was swapped for another company's or a chosen one is refused before AWS is called, and a role that needs no external id fails the test", async () => {
    const w = world();
    const c = await begin(w);
    Object.assign(rec(w, c.id), { status: "connected", accountId: ACCOUNT, roleArn: `arn:aws:iam::${ACCOUNT}:role/rovara-test-${c.id}`, cleanupRoleArn: `arn:aws:iam::${ACCOUNT}:role/rovara-cleanup-${c.id}` });
    await openTestAccessSession(sessionDeps(w), { orgId: ORG, connectionId: c.id, taskId: "t", runId: "ab12cd34", services: ["sqs"] });
    expect(w.assumeCalls.map((call) => call.ExternalId)).toEqual([connectionExternalId(ORG, c.id)]);
    for (const externalId of [connectionExternalId(OTHER_ORG, c.id), "chosen-by-attacker-0000", ""]) {
      rec(w, c.id).externalId = externalId;
      const error = await errorOf(openTestAccessSession(sessionDeps(w), { orgId: ORG, connectionId: c.id, taskId: "t", runId: "ab12cd34", services: ["sqs"] }));
      expect((error as unknown as { code: string }).code, externalId).toBe("external_id");
    }
    expect(w.assumeCalls).toHaveLength(1);
  });
});

describe("A6 a leaked link and A7 other tenants", () => {
  it("A6: whoever holds the link can make a stack in their own account and report it, and still cannot make Rovara assume it: nothing opens, tests or assumes until an admin confirms the account shown", async () => {
    const w = world();
    const c = await begin(w);
    expect(await create(w, c, { accountId: OTHER_ACCOUNT, StackId: STACK_ID.replace(ACCOUNT, OTHER_ACCOUNT) })).toEqual(["connected"]);
    expect(rec(w, c.id)).toMatchObject({ status: "reported", accountId: OTHER_ACCOUNT });
    expect(w.assumeCalls).toHaveLength(0);
    expect((await errorOf(openTestAccessSession(sessionDeps(w), { orgId: ORG, connectionId: c.id, taskId: "t", runId: "ab12cd34", services: ["sqs"] })))?.message).toContain("not connected");
    expect((await errorOf(testConnection(w.connectDeps, caller(), c.id)))?.code).toBe("CHANGE_STALE");
    // The admin sees an account that is not theirs: they do not confirm; confirming a different id than the one shown is refused.
    expect((await errorOf(confirmConnection(w.connectDeps, caller(), c.id, { accountId: ACCOUNT })))?.code).toBe("CHANGE_STALE");
    expect(w.assumeCalls).toHaveLength(0);
    expect((await disconnectConnection(w.connectDeps, caller(), c.id)).status).toBe("disconnected");
  });

  it("A7: another organization's admin can read, type into, confirm, test, tick, suspend, disconnect or open a session for nothing of ours, and every refusal looks like a missing id", async () => {
    const w = world();
    w.admins.add(OTHER_ADMIN);
    const c = await begin(w);
    Object.assign(rec(w, c.id), { status: "reported", accountId: ACCOUNT, version: 2 });
    const other = caller({ orgId: OTHER_ORG, developerId: OTHER_ADMIN, sessionId: "session-other" });
    const calls = [
      getConnection(w.connectDeps, other, c.id), submitAccountId(w.connectDeps, other, c.id, { accountId: ACCOUNT }), confirmConnection(w.connectDeps, other, c.id, { accountId: ACCOUNT }), testConnection(w.connectDeps, other, c.id),
      acknowledgeNotProduction(w.connectDeps, other, c.id), suspendConnection(w.connectDeps, other, c.id), disconnectConnection(w.connectDeps, other, c.id),
      openTestAccessSession(sessionDeps(w), { orgId: OTHER_ORG, connectionId: c.id, taskId: "t", runId: "ab12cd34", services: [] }),
    ];
    const outcomes = await Promise.all(calls.map((call) => errorOf(call)));
    for (const outcome of outcomes) expect(outcome, "must be refused").toBeDefined();
    const missing = await Promise.all([getConnection(w.connectDeps, other, "conn_aaaaaaaaaaaaaaaaaaaa"), disconnectConnection(w.connectDeps, other, "conn_aaaaaaaaaaaaaaaaaaaa")].map((call) => errorOf(call)));
    expect(outcomes[0]!.message).toBe(missing[0]!.message);
    expect(outcomes[6]!.message).toBe(missing[1]!.message);
    expect(rec(w, c.id)).toMatchObject({ status: "reported", version: 2 });
    expect(w.assumeCalls).toHaveLength(0);
  });
});

describe("A7b a store that answers wrongly", () => {
  it("A7b: a record another organization owns that a store returns by mistake is not found, and a Delete whose stack record points at a connection that does not hold that stack changes nothing", async () => {
    const w = world();
    w.admins.add(OTHER_ADMIN);
    const c = await begin(w);
    const mine = rec(w, c.id);
    const lying = { ...w.connectDeps.store, getConnection: () => Promise.resolve(structuredClone(mine)) };
    const other = caller({ orgId: OTHER_ORG, developerId: OTHER_ADMIN, sessionId: "session-other" });
    expect((await errorOf(getConnection({ ...w.connectDeps, store: lying }, other, c.id)))?.code).toBe("NOT_FOUND");
    // A stack record that names the connection, while the connection holds another stack (or none): the Delete is ignored.
    await create(w, c);
    rec(w, c.id).stackId = `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/Rovara-test-access/aaaaaaaa-2222-3333-4444-555555555555`;
    expect((await create(w, c, { RequestType: "Delete" }))[0]).toBe("ignored");
    expect(rec(w, c.id).status).toBe("reported");
  });
});

describe("A8 oversized and malformed input", () => {
  it("A8: huge, deeply nested, wrongly typed, control-character and injection inputs are refused or dropped, without a crash and without a change", async () => {
    const { w, input, store } = rig();
    const c = await begin(w);
    const request = callbackRequest({ connectionId: c.id, token: c.token });
    const nested = `${"[".repeat(5_000)}${"]".repeat(5_000)}`;
    const cases: unknown[] = [
      "x".repeat(70 * 1024), nested, JSON.stringify({ RequestType: "Create" }), JSON.stringify({ ...request, StackId: 5 }), JSON.stringify({ ...request, ResourceProperties: [] }), JSON.stringify({ ...request, ResourceProperties: { ...(request["ResourceProperties"] as object), ConnectToken: "t".repeat(10_000) } }),
      JSON.stringify({ ...request, ResourceProperties: { ...(request["ResourceProperties"] as object), AccountId: "2222 33334444" } }), JSON.stringify({ ...request, ResourceProperties: { ...(request["ResourceProperties"] as object), Region: "us-west-2\nus-east-1" } }),
      JSON.stringify({ ...request, ResourceProperties: { ...(request["ResourceProperties"] as object), ExternalId: "rovara-org_x\u0000" } }), JSON.stringify({ ...request, RequestId: "r".repeat(1000) }), JSON.stringify({ ...request, ResponseURL: `https://x.s3.amazonaws.com/${"a".repeat(5000)}` }),
      "null", "42", '"string"', "{", "",
    ];
    for (const message of cases) {
      const words = await runCallbackLambda(signed(message as string), input);
      expect(words.length, String(message).slice(0, 30)).toBe(1);
      expect(words[0]).toMatch(/^(dropped_|refused_)/u);
    }
    expect(await runCallbackLambda({ Records: [{ Sns: { Message: 5 } }, null, 7, { Sns: null }] }, input)).toHaveLength(4);
    expect(await store.getConnection(ORG, c.id)).toMatchObject({ status: "awaiting", version: 1 });
  });

  it("A8: the API refuses an account id, a Region, a project and a connection id that are not what they should be, without echoing them", async () => {
    const w = world();
    const c = await begin(w);
    for (const accountId of ["2222 33334444", "２２２２３３３３４４４４", "222233334444\n", "x".repeat(10_000), "0x1234567890ab"]) {
      const error = await errorOf(submitAccountId(w.connectDeps, caller(), c.id, { accountId }));
      expect(error?.code, accountId.slice(0, 10)).toBe("CONFIG_INVALID");
      expect(error?.message).not.toContain(accountId.slice(0, 20));
    }
    for (const region of ["us-west-2\"; drop", "us-west-2 ", "US-WEST-2", "../../etc"]) expect((await errorOf(startConnection(w.connectDeps, caller(), { projectId: PROJECT, region })))?.code, region).toBe("CONFIG_INVALID");
    const missing = (await errorOf(getConnection(w.connectDeps, caller(), "conn_aaaaaaaaaaaaaaaaaaaa")))?.message;
    for (const id of ["conn_AAAAAAAAAAAAAAAAAAAA", "conn_short", "../x", `conn_${"a".repeat(5_000)}`]) expect((await errorOf(getConnection(w.connectDeps, caller(), id)))?.message, id.slice(0, 10)).toBe(missing);
  });
});

describe("A9 server-side request forgery", () => {
  it("A9: a response URL that is not CloudFormation's bucket for the stack's Region is never fetched, and nothing is recorded for it", async () => {
    const w = world();
    const c = await begin(w);
    const hosts = ["https://attacker.example.com/x", "http://cloudformation-custom-resource-response-uswest2.s3-us-west-2.amazonaws.com/x", "https://169.254.169.254/latest/meta-data/", "https://127.0.0.1/x", "https://localhost/x", "https://cloudformation-custom-resource-response-uswest2.s3-us-west-2.amazonaws.com:8443/x", "https://user:pass@cloudformation-custom-resource-response-uswest2.s3-us-west-2.amazonaws.com/x", "https://cloudformation-custom-resource-response-useast1.s3.amazonaws.com/x", "https://evil.cloudformation-custom-resource-response-uswest2.s3-us-west-2.amazonaws.com.attacker.example.com/x", "file:///etc/passwd", "gopher://x"];
    for (const ResponseURL of hosts) expect(await create(w, c, { ResponseURL }), ResponseURL).toEqual(["dropped_response_url"]);
    expect(w.puts).toEqual([]);
    expect(rec(w, c.id).status).toBe("awaiting");
  });

  it("A9: a certificate URL that is not SNS's own is never fetched, even with a perfect signature", async () => {
    const { w, input, keyFetches } = rig();
    const c = await begin(w);
    const request = callbackRequest({ connectionId: c.id, token: c.token });
    for (const SigningCertUrl of ["https://attacker.example.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem", "http://169.254.169.254/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem", "https://sns.us-west-2.amazonaws.com@attacker.example.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem"]) {
      expect(await runCallbackLambda(signed(request, {}, pair.privateKey, { SigningCertUrl }), input), SigningCertUrl).toEqual(["dropped_cert_url"]);
    }
    expect(keyFetches).toEqual([]);
  });
});

describe("A10 races and A20 partial failure", () => {
  it("A10: a callback and a poll that both reach the same connection leave one coherent state, whichever goes first", async () => {
    for (const callbackFirst of [true, false]) {
      const w = world();
      const c = await begin(w);
      await submitAccountId(w.connectDeps, caller(), c.id, { accountId: ACCOUNT });
      const callback = () => create(w, c);
      const poll = () => { w.clock.ms += 10_000; return pollDue(w.connectDeps); };
      if (callbackFirst) { await callback(); await poll(); } else { await poll(); await callback(); }
      const record = rec(w, c.id);
      expect(record.accountId, `callbackFirst=${callbackFirst}`).toBe(ACCOUNT);
      expect(["reported", "confirmed", "connected"]).toContain(record.status);
      expect(record).not.toHaveProperty("pollAccountId");
      // The stack is recorded exactly once when the callback arrived (before or after); the token is spent once.
      expect(w.store.stacks.size).toBe(1);
      expect([...w.store.tokens.values()].filter((token) => token.usedAtMs !== undefined)).toHaveLength(1);
      expect(w.store.polling.size).toBe(0);
    }
  });

  it("A20: a store that fails mid-callback leaves the token unspent and the connection untouched, and a redelivery then succeeds", async () => {
    const w = world();
    const c = await begin(w);
    w.store.beforeNext = () => { throw new Error("store unavailable"); };
    await expect(create(w, c)).rejects.toThrow("store unavailable");
    expect([...w.store.tokens.values()][0]!.usedAtMs).toBeUndefined();
    expect(rec(w, c.id)).toMatchObject({ status: "awaiting", version: 1 });
    expect(w.store.stacks.size).toBe(0);
    expect(await create(w, c)).toEqual(["connected"]);
  });
});

describe("A11 what the messages give away", () => {
  it("A11: every refusal sent to CloudFormation is one of the fixed sentences; an API refusal names no id, account, role or field; the token is nowhere in a log, an audit event, a view or an answer", async () => {
    const w = world();
    const c = await begin(w);
    const forged = ["t".repeat(43), "u".repeat(43)];
    for (const [index, token] of forged.entries()) await create(w, { id: c.id, token }, { StackId: STACK_ID.replace("1111", `000${index}`), properties: { ExternalId: connectionExternalId(OTHER_ORG, c.id) } });
    await create(w, { id: c.id, token: "v".repeat(43) }, { accountId: ROVARA_ACCOUNT });
    await create(w, c);
    const sentences = new Set(Object.values(CALLBACK_FAILURE_REASONS));
    for (const put of w.puts) {
      if (put.body["Status"] === "FAILED") expect(sentences.has(put.body["Reason"] as never), String(put.body["Reason"])).toBe(true);
      // A response carries the request's own StackId and the physical id (CloudFormation needs both); nothing else of the request or of Rovara's, and nothing in Data.
      expect(put.body).not.toHaveProperty("Data");
      expect(typeof put.body["Reason"] === "string" ? put.body["Reason"] : "").not.toMatch(/\d{12}|arn:|conn_|org_/u);
    }
    const everything = JSON.stringify([w.logs, w.store.audits, w.puts, await getConnection(w.connectDeps, caller(), c.id)]);
    for (const secret of [c.token, ...forged, connectTokenHash(c.token) as string]) expect(everything).not.toContain(secret);
    const errors = await Promise.all([confirmConnection(w.connectDeps, caller(), c.id, { accountId: OTHER_ACCOUNT }), submitAccountId(w.connectDeps, caller(), c.id, { accountId: ROVARA_ACCOUNT }), submitAccountId(w.connectDeps, caller(), c.id, { accountId: "111122223333" })].map((call) => errorOf(call)));
    for (const error of errors) expect(`${error?.code} ${error?.message}`, "no ids").not.toMatch(/\d{12}|conn_|org_|arn:/u);
  });
});

describe("A12 forged Update and Delete", () => {
  it("A12: a Delete or Update that names a stack Rovara did not record, or an account that is not the recorded one, changes nothing and cannot disconnect or rewrite another's connection", async () => {
    const w = world();
    const c = await begin(w);
    await create(w, c);
    const before = structuredClone(rec(w, c.id));
    const stranger = `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/Rovara-test-access/00000000-0000-0000-0000-000000000000`;
    const strangerAccount = `arn:aws:cloudformation:${REGION}:${OTHER_ACCOUNT}:stack/Rovara-test-access/11111111-2222-3333-4444-555555555555`;
    for (const RequestType of ["Delete", "Update"] as const) {
      for (const over of [{ StackId: stranger }, { StackId: strangerAccount, accountId: OTHER_ACCOUNT }, { properties: { ExternalId: connectionExternalId(ORG, "conn_zzzzzzzzzzzzzzzzzzzz") } }]) {
        // (A Delete that carries the very stack id Rovara recorded does disconnect: that is the stack's own deletion. Its id is the secret; see the report.)
        if (RequestType === "Delete" && !("StackId" in over)) continue;
        const words = await create(w, c, { RequestType, ...over });
        expect(words[0], `${RequestType} ${JSON.stringify(over).slice(0, 40)}`).toBe("ignored");
      }
    }
    expect({ ...rec(w, c.id) }).toEqual(before);
  });
});

describe("A12b the stack id is not a secret", () => {
  it("A12b (reviewer probe): a Delete or Update that carries the recorded StackId but not the connection's token (none, a wrong one, another connection's) changes nothing, and is still answered SUCCESS; the stack's own token does", async () => {
    const w = world();
    const c = await begin(w);
    await create(w, c);
    const other = await begin(w);
    const before = structuredClone(rec(w, c.id));
    const noToken = (type: "Delete" | "Update") => handleCallbackEvent(snsEvent((() => { const r = callbackRequest({ RequestType: type, connectionId: c.id, token: c.token }); delete (r["ResourceProperties"] as Record<string, unknown>)["ConnectToken"]; return r; })()), w.callbackDeps);
    for (const type of ["Delete", "Update"] as const) {
      // (An Update without the property is malformed for the contract and dropped; a Delete may lack it and is answered.)
      if (type === "Delete") expect((await noToken(type))[0], `${type} without a token`).toBe("ignored");
      expect((await create(w, c, { RequestType: type, token: "u".repeat(43) }))[0], `${type} wrong token`).toBe("ignored");
      expect((await create(w, c, { RequestType: type, token: other.token }))[0], `${type} another connection's token`).toBe("ignored");
    }
    expect(rec(w, c.id)).toEqual(before);
    expect(w.puts.slice(-6).every((put) => put.body["Status"] === "SUCCESS")).toBe(true);
    // The stack's own token (what CloudFormation sends from its template) is accepted.
    expect((await create(w, c, { RequestType: "Update", properties: { TemplateVersion: "1.2.0" } }))[0]).toBe("updated");
    expect((await create(w, c, { RequestType: "Delete" }))[0]).toBe("disconnected");
  });

  it("A12b: a forged Update cannot rewrite the template version the connection shows", async () => {
    const w = world();
    const c = await begin(w);
    await create(w, c);
    await create(w, c, { RequestType: "Update", token: "u".repeat(43), properties: { TemplateVersion: "9.9.9" } });
    expect(rec(w, c.id).templateVersion).toBe("1.0.0");
  });
});

describe("A13 Rovara's own account and production", () => {
  it("A13: Rovara's own accounts and the company's production accounts are refused by the callback, the typed id, the poll and the session", async () => {
    const w = world();
    const c = await begin(w);
    expect(await create(w, c, { accountId: ROVARA_ACCOUNT })).toEqual(["refused_account_refused"]);
    expect(await create(w, c, { accountId: "111122223333" })).toEqual(["refused_account_refused"]);
    expect((await errorOf(submitAccountId(w.connectDeps, caller(), c.id, { accountId: ROVARA_ACCOUNT })))?.code).toBe("CONFIG_INVALID");
    expect((await errorOf(submitAccountId(w.connectDeps, caller(), c.id, { accountId: "111122223333" })))?.code).toBe("CONFIG_INVALID");
    Object.assign(rec(w, c.id), { status: "connected", accountId: ROVARA_ACCOUNT, roleArn: `arn:aws:iam::${ROVARA_ACCOUNT}:role/rovara-test-${c.id}` });
    expect((await errorOf(openTestAccessSession(sessionDeps(w), { orgId: ORG, connectionId: c.id, taskId: "t", runId: "ab12cd34", services: [] })))?.message).toContain("not Rovara's");
    expect(w.assumeCalls).toHaveLength(0);
  });
});

describe("A14 guessing the token", () => {
  it("A14: tokens are 256 bits and unique, the store holds only a hash, and every wrong token gets the same answer with no timing path through the token's text", async () => {
    const seen = new Set(Array.from({ length: 2_000 }, () => mintConnectToken()));
    expect(seen.size).toBe(2_000);
    for (const token of seen) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const w = world();
    const c = await begin(w);
    for (const token of [c.token.slice(0, -1) + (c.token.endsWith("A") ? "B" : "A"), "A".repeat(43), c.token.toUpperCase().replace(/[^A-Z0-9]/gu, "A").padEnd(43, "A")]) {
      expect(await create(w, { id: c.id, token }, { StackId: STACK_ID.replace("5555", `${Math.floor(Math.random() * 9000) + 1000}`) })).toEqual(["refused_token_refused"]);
    }
    expect(JSON.stringify([...w.store.tokens.keys(), ...w.store.tokens.values()])).not.toContain(c.token);
    expect(connectTokenHash("short")).toBeUndefined();
    expect(connectTokenHash(`${c.token}!`)).toBeUndefined();
  });
});

describe("A15 expiry", () => {
  it("A15: a token is refused from the moment it expires, and a link older than that is shown as expired", async () => {
    const w = world();
    const c = await begin(w);
    w.clock.ms += 30 * 60_000 - 1;
    const early = await create(w, c);
    expect(early).toEqual(["connected"]);
    w.sessionAuthTime.value = new Date(w.clock.ms - 60_000).toISOString();
    const late = await begin(w);
    w.clock.ms += 30 * 60_000;
    expect(await create(w, late, { StackId: STACK_ID.replace("5555", "6666") })).toEqual(["refused_token_refused"]);
    w.sessionAuthTime.value = new Date(w.clock.ms - 60_000).toISOString();
    expect((await getConnection(w.connectDeps, caller(), late.id)).linkExpired).toBe(true);
  });
});

describe("A16 session abuse", () => {
  it("A16: the run id, the task id and the services are all the caller chooses; injection in them reaches AWS as nothing, and a suspended or cleanup-only state cannot open a run", async () => {
    const w = world();
    const c = await begin(w);
    Object.assign(rec(w, c.id), { status: "connected", accountId: ACCOUNT, roleArn: `arn:aws:iam::${ACCOUNT}:role/rovara-test-${c.id}`, cleanupRoleArn: `arn:aws:iam::${ACCOUNT}:role/rovara-cleanup-${c.id}` });
    for (const runId of ["ab12cd34,rovara-run=x", "ab12cd3\n", "AB12CD34", "ab12cd3", "a;b12cd34"]) expect((await errorOf(openTestAccessSession(sessionDeps(w), { orgId: ORG, connectionId: c.id, taskId: "t", runId, services: [] })))?.message, runId).toContain("run id");
    await openTestAccessSession(sessionDeps(w), { orgId: ORG, connectionId: c.id, taskId: "x\"},{\"Effect\":\"Allow", runId: "ab12cd34", services: ["sqs"] });
    expect(w.assumeCalls[0]!.RoleSessionName).toMatch(/^[\w+=,.@-]{2,64}$/u);
    expect(w.assumeCalls[0]!.Tags).toEqual([{ Key: "rovara-run", Value: "ab12cd34" }]);
    expect((JSON.parse(w.assumeCalls[0]!.Policy as string) as { Statement: unknown[] }).Statement).toHaveLength(2);
    rec(w, c.id).status = "suspended";
    expect(await errorOf(openTestAccessSession(sessionDeps(w), { orgId: ORG, connectionId: c.id, taskId: "t", runId: "ab12cd34", services: [] }))).toBeDefined();
    expect(w.assumeCalls).toHaveLength(1);
    // The credentials leave only as the return value: not in the error of a later failure.
    w.aws.assume = () => { throw new Error(`denied ${secretParts().secretAccessKey}`); };
    rec(w, c.id).status = "connected";
    expect((await errorOf(openTestAccessSession(sessionDeps(w), { orgId: ORG, connectionId: c.id, taskId: "t", runId: "ab12cd34", services: [] })))?.message).not.toContain(secretParts().secretAccessKey);
  });
});

describe("A17 abusing the poll", () => {
  it("A17: typing someone else's account id never connects (no role there), another organization's connection cannot be polled into, and a role that answers as another is ignored", async () => {
    const w = world();
    w.admins.add(OTHER_ADMIN);
    const c = await begin(w);
    await submitAccountId(w.connectDeps, caller(), c.id, { accountId: OTHER_ACCOUNT });
    w.aws.assume = () => { throw Object.assign(new Error("AccessDenied"), { name: "AccessDenied" }); };
    for (let tick = 0; tick < 5; tick += 1) { w.clock.ms += 10_000; await pollDue(w.connectDeps); }
    expect(rec(w, c.id)).toMatchObject({ status: "polling" });
    expect(w.assumeCalls.every((call) => call.RoleArn === `arn:aws:iam::${OTHER_ACCOUNT}:role/rovara-test-${c.id}` && call.ExternalId === connectionExternalId(ORG, c.id) && call.RoleSessionName === POLL_SESSION_NAME && call.Tags === undefined && call.Policy === undefined)).toBe(true);
    expect((await errorOf(submitAccountId(w.connectDeps, caller({ orgId: OTHER_ORG, developerId: OTHER_ADMIN, sessionId: "session-other" }), c.id, { accountId: ACCOUNT })))?.message).toContain("connection not found");
    w.clock.ms += 31 * 60_000;
    await pollDue(w.connectDeps);
    expect(rec(w, c.id)).toMatchObject({ status: "failed", endCause: "poll_timeout" });
  });
});

describe("A18 the switch", () => {
  it("A18: with the ta switch off the API is not found, the callback is refused at once, the poll and sessions do nothing", async () => {
    const w = world();
    const c = await begin(w);
    await submitAccountId(w.connectDeps, caller(), c.id, { accountId: ACCOUNT });
    w.enabled.value = false;
    expect((await errorOf(getConnection(w.connectDeps, caller(), c.id)))?.code).toBe("NOT_FOUND");
    expect((await errorOf(startConnection(w.connectDeps, caller(), { projectId: PROJECT, region: REGION })))?.code).toBe("NOT_FOUND");
    expect(await create(w, c)).toEqual(["dropped_disabled"]);
    w.clock.ms += 10_000;
    expect(await pollDue(w.connectDeps)).toEqual({ polled: 0, found: 0, expired: 0, skipped: 0 });
    expect((await errorOf(openTestAccessSession(sessionDeps(w), { orgId: ORG, connectionId: c.id, taskId: "t", runId: "ab12cd34", services: [] })))?.code).toBe("NOT_FOUND");
    expect(w.assumeCalls).toHaveLength(0);
    expect(rec(w, c.id).status).toBe("polling");
    void ADMIN;
  });
});

describe("A19 a configuration that does not know Rovara's own accounts", () => {
  it("A19 (reviewer probe): with an empty list of Rovara's accounts nothing starts, no account id is taken, no poll is tried, no callback attaches, and no test runs", async () => {
    const w = world();
    const c = await begin(w);
    w.connectDeps.config = { ...w.connectDeps.config, rovaraAccountIds: [] };
    w.callbackDeps.rovaraAccountIds = [];
    expect((await errorOf(startConnection(w.connectDeps, caller(), { projectId: PROJECT, region: REGION })))?.code).toBe("RUNTIME_UNAVAILABLE");
    expect((await errorOf(submitAccountId(w.connectDeps, caller(), c.id, { accountId: ROVARA_ACCOUNT })))?.code).toBe("RUNTIME_UNAVAILABLE");
    expect(await create(w, c, { accountId: ROVARA_ACCOUNT })).toEqual(["refused_not_ready"]);
    expect(rec(w, c.id).status).toBe("awaiting");
    Object.assign(rec(w, c.id), { status: "polling", pollAccountId: ROVARA_ACCOUNT, pollUntil: new Date(w.clock.ms + 60_000).toISOString() });
    w.clock.ms += 10_000;
    expect(await pollDue(w.connectDeps)).toEqual({ polled: 0, found: 0, expired: 0, skipped: 0 });
    expect(w.assumeCalls).toHaveLength(0);
    Object.assign(rec(w, c.id), { status: "confirmed", accountId: ROVARA_ACCOUNT });
    expect((await errorOf(testConnection(w.connectDeps, caller(), c.id)))?.code).toBe("RUNTIME_UNAVAILABLE");
    expect(w.assumeCalls).toHaveLength(0);
    w.connectDeps.config = { ...w.connectDeps.config, rovaraAccountIds: ["not-an-account"] };
    expect((await errorOf(submitAccountId(w.connectDeps, caller(), c.id, { accountId: ACCOUNT })))?.code).toBe("RUNTIME_UNAVAILABLE");
  });
});
