// Customer test AWS account, lane TA2: the SNS callback handler. Create, repeat, Update and Delete, and every refusal, with the in-memory store and a recording fetch. The signature check has its own file; here the verifier is a stub.
import { describe, expect, it } from "vitest";
import { CALLBACK_FAILURE_REASONS, connectionExternalId } from "@agentx/cloud-contracts";
import { CallbackTransientError, handleCallbackEvent } from "../../packages/broker/src/test-access/callback.js";
import { startConnection } from "../../packages/broker/src/test-access/connect.js";
import { connectTokenHash } from "../../packages/broker/src/test-access/token.js";
import { ACCOUNT, OTHER_ACCOUNT, ORG, OTHER_ORG, PROJECT, REGION, ROVARA_ACCOUNT, STACK_ID, callbackRequest, caller, connectionExternalIdOfLast, snsEvent, tokenOfLink, world, type Fixture } from "../support/test-access-fixtures.js";

async function begin(w: Fixture, over: { region?: string } = {}) {
  const started = await startConnection(w.connectDeps, caller(), { projectId: PROJECT, region: over.region ?? REGION });
  connectionExternalIdOfLast.value = connectionExternalId(ORG, started.connection.connectionId);
  return { connectionId: started.connection.connectionId, token: tokenOfLink(started.link), link: started.link };
}
const create = (w: Fixture, c: { connectionId: string; token: string }, over: Record<string, unknown> = {}) => handleCallbackEvent(snsEvent(callbackRequest({ connectionId: c.connectionId, token: c.token, ...over })), w.callbackDeps);
const stored = (w: Fixture, connectionId: string) => w.store.connections.get(`${ORG}#${connectionId}`)!;

describe("a Create", () => {
  it("records the stack, moves the connection to reported (not confirmed), spends the token, audits it, and answers SUCCESS with nothing in Data", async () => {
    const w = world();
    const c = await begin(w);
    expect(await create(w, c)).toEqual(["connected"]);
    const record = stored(w, c.connectionId);
    expect(record).toMatchObject({ status: "reported", stackId: STACK_ID, accountId: ACCOUNT, region: REGION, reportedVia: "callback", templateVersion: "1.0.0", version: 2 });
    expect(record.roleArn).toBe(`arn:aws:iam::${ACCOUNT}:role/rovara-test-${c.connectionId}`);
    expect(record.cleanupRoleArn).toBe(`arn:aws:iam::${ACCOUNT}:role/rovara-cleanup-${c.connectionId}`);
    expect(w.store.stacks.get(STACK_ID)).toMatchObject({ orgId: ORG, connectionId: c.connectionId, accountId: ACCOUNT });
    expect([...w.store.tokens.values()][0]!.usedAtMs).toBe(w.clock.ms);
    expect(w.puts).toHaveLength(1);
    expect(w.puts[0]!.body).toMatchObject({ Status: "SUCCESS", StackId: STACK_ID, RequestId: "req-0001", LogicalResourceId: "RovaraCallback", PhysicalResourceId: `rovara-connection-${connectionExternalId(ORG, c.connectionId)}` });
    expect(w.puts[0]!.body).not.toHaveProperty("Data");
    expect(w.store.audits.map((event) => event.action)).toEqual(["test_access.connection_started", "test_access.connection_reported"]);
    expect(w.assumeCalls).toHaveLength(0);
  });

  it("answers a repeated delivery of the same request SUCCESS again and changes nothing", async () => {
    const w = world();
    const c = await begin(w);
    await create(w, c);
    const before = structuredClone(stored(w, c.connectionId));
    expect(await create(w, c)).toEqual(["repeat"]);
    expect(stored(w, c.connectionId)).toEqual(before);
    expect(w.puts.map((put) => put.body["Status"])).toEqual(["SUCCESS", "SUCCESS"]);
    expect(w.store.audits).toHaveLength(2);
  });

  it("refuses a token that is unknown, used for another stack, or expired, with the fixed sentence, and spends nothing", async () => {
    const w = world();
    const c = await begin(w);
    await create(w, c);
    const otherStack = `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/Rovara-test-access/99999999-2222-3333-4444-555555555555`;
    expect(await create(w, c, { StackId: otherStack })).toEqual(["refused_token_refused"]);
    const third = `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/Rovara-test-access/88888888-2222-3333-4444-555555555555`;
    expect(await create(w, { connectionId: c.connectionId, token: "u".repeat(43) }, { StackId: third })).toEqual(["refused_token_refused"]);
    const late = await begin(w);
    w.clock.ms += 31 * 60_000;
    expect(await create(w, late, { StackId: otherStack })).toEqual(["refused_token_refused"]);
    for (const put of w.puts.slice(1)) expect(put.body).toMatchObject({ Status: "FAILED", Reason: CALLBACK_FAILURE_REASONS.token_refused });
    expect(w.store.stacks.size).toBe(1);
  });

  it("does not spend the token on a message whose external id is another connection's or organization's", async () => {
    const w = world();
    const c = await begin(w);
    for (const ExternalId of [connectionExternalId(OTHER_ORG, c.connectionId), connectionExternalId(ORG, "conn_zzzzzzzzzzzzzzzzzzzz")]) {
      expect(await create(w, c, { properties: { ExternalId } })).toEqual(["refused_external_id_mismatch"]);
    }
    expect(stored(w, c.connectionId).status).toBe("awaiting");
    expect([...w.store.tokens.values()][0]!.usedAtMs).toBeUndefined();
    expect(await create(w, c)).toEqual(["connected"]);
  });

  it("refuses a token used from another Region, or roles other than the ones the template names", async () => {
    const w = world();
    const c = await begin(w);
    // The Region: the link was made for us-west-2; a us-east-1 stack through the us-east-1 topic carries the same token.
    w.verdict.value = (record) => ({ ok: true, message: String((record.Sns as { Message: string }).Message), topicArn: "arn:aws:sns:us-east-1:999988887777:agentx-test-access-callback", topicRegion: "us-east-1" });
    const east = `arn:aws:cloudformation:us-east-1:${ACCOUNT}:stack/Rovara-test-access/11111111-2222-3333-4444-555555555555`;
    const eastUrl = "https://cloudformation-custom-resource-response-useast1.s3.amazonaws.com/x?sig=1";
    expect(await create(w, c, { region: "us-east-1", StackId: east, ResponseURL: eastUrl })).toEqual(["refused_region_mismatch"]);
    w.verdict.value = undefined;
    expect(await create(w, c, { properties: { RoleArn: `arn:aws:iam::${ACCOUNT}:role/admin` } })).toEqual(["refused_role_mismatch"]);
    expect(await create(w, c, { properties: { CleanupRoleArn: `arn:aws:iam::${ACCOUNT}:role/rovara-test-${c.connectionId}` } })).toEqual(["refused_role_mismatch"]);
    expect(stored(w, c.connectionId).status).toBe("awaiting");
    expect([...w.store.tokens.values()][0]!.usedAtMs).toBeUndefined();
  });

  it("refuses Rovara's own account and the company's production accounts, reading the list now, and retries when the list cannot be read", async () => {
    const w = world();
    const c = await begin(w);
    expect(await create(w, c, { accountId: ROVARA_ACCOUNT })).toEqual(["refused_account_refused"]);
    expect(await create(w, c, { accountId: "111122223333" })).toEqual(["refused_account_refused"]);
    w.prodDeny.value = new Error("list unavailable");
    await expect(create(w, c)).rejects.toThrow("list unavailable");
    expect([...w.store.tokens.values()][0]!.usedAtMs).toBeUndefined();
    expect(w.store.stacks.size).toBe(0);
    w.prodDeny.value = { accountIds: [], hosts: [], arnPrefixes: [] };
    expect(await create(w, c)).toEqual(["connected"]);
  });

  it("is bound to the connection's organization and project: a token whose connection record disagrees is refused", async () => {
    const w = world();
    const c = await begin(w);
    const token = [...w.store.tokens.values()][0]!;
    token.projectId = "other-project";
    expect(await create(w, c)).toEqual(["refused_token_refused"]);
    expect(stored(w, c.connectionId).status).toBe("awaiting");
  });

  it("lets only one of two stacks that race with the same token win", async () => {
    const w = world();
    const c = await begin(w);
    const second = `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/Rovara-test-access/77777777-2222-3333-4444-555555555555`;
    const results = await Promise.all([create(w, c), create(w, c, { StackId: second })].map((run) => run.then((words) => words[0], (error: unknown) => (error instanceof CallbackTransientError ? "retry" : "error"))));
    expect(results.filter((word) => word === "connected")).toHaveLength(1);
    expect(w.store.stacks.size).toBe(1);
    expect([...w.store.tokens.values()][0]!.usedAtMs).toBeDefined();
  });

  it("when a poll found the role first, the callback only adds its stack; with another account it is refused and the token spent", async () => {
    const w = world();
    const c = await begin(w);
    const record = stored(w, c.connectionId);
    Object.assign(record, { status: "connected", version: 5, accountId: ACCOUNT, roleArn: `arn:aws:iam::${ACCOUNT}:role/rovara-test-${c.connectionId}`, cleanupRoleArn: `arn:aws:iam::${ACCOUNT}:role/rovara-cleanup-${c.connectionId}`, reportedVia: "account_id" });
    expect(await create(w, c, { accountId: OTHER_ACCOUNT })).toEqual(["refused_token_refused"]);
    expect([...w.store.tokens.values()][0]!.usedAtMs).toBeDefined();
    const fresh = await begin(w);
    Object.assign(stored(w, fresh.connectionId), { status: "connected", version: 5, accountId: ACCOUNT, roleArn: `arn:aws:iam::${ACCOUNT}:role/rovara-test-${fresh.connectionId}`, reportedVia: "account_id" });
    expect(await create(w, fresh)).toEqual(["connected"]);
    expect(stored(w, fresh.connectionId)).toMatchObject({ status: "connected", stackId: STACK_ID, accountId: ACCOUNT });
  });

  it("with an admin-typed account id polling, a stack from another account is refused", async () => {
    const w = world();
    const c = await begin(w);
    Object.assign(stored(w, c.connectionId), { status: "polling", pollAccountId: OTHER_ACCOUNT, pollUntil: new Date(w.clock.ms + 60_000).toISOString() });
    expect(await create(w, c)).toEqual(["refused_account_mismatch"]);
    expect([...w.store.tokens.values()][0]!.usedAtMs).toBeUndefined();
  });

  it("throws when CloudFormation does not take the SUCCESS, so SNS redelivers and the repeat is answered again", async () => {
    const w = world();
    const c = await begin(w);
    w.fetchStatus.value = 500;
    await expect(create(w, c)).rejects.toBeInstanceOf(CallbackTransientError);
    expect(stored(w, c.connectionId).status).toBe("reported");
    w.fetchStatus.value = 200;
    expect(await create(w, c)).toEqual(["repeat"]);
  });

  it("throws, and changes nothing, when the store is down", async () => {
    const w = world();
    const c = await begin(w);
    w.store.down = true;
    await expect(create(w, c)).rejects.toThrow("store unavailable");
    w.store.down = false;
    expect(stored(w, c.connectionId).status).toBe("awaiting");
  });

  it("while the ta switch is off a Create is answered not-ready at once and nothing is recorded", async () => {
    const w = world();
    const c = await begin(w);
    w.enabled.value = false;
    expect(await create(w, c)).toEqual(["dropped_disabled"]);
    expect(w.puts[0]!.body).toMatchObject({ Status: "FAILED", Reason: CALLBACK_FAILURE_REASONS.not_ready });
    expect(stored(w, c.connectionId).status).toBe("awaiting");
  });
});

describe("what is dropped without an answer", () => {
  it("drops a message that does not verify, one that is not JSON, and one whose response URL is not CloudFormation's", async () => {
    const w = world();
    const c = await begin(w);
    w.verdict.value = () => ({ ok: false, code: "signature" });
    expect(await create(w, c)).toEqual(["dropped_signature"]);
    w.verdict.value = undefined;
    expect(await handleCallbackEvent(snsEvent("not json"), w.callbackDeps)).toEqual(["dropped_malformed_request"]);
    expect(await create(w, c, { ResponseURL: "https://attacker.example.com/x" })).toEqual(["dropped_response_url"]);
    expect(w.puts).toHaveLength(0);
    expect(stored(w, c.connectionId).status).toBe("awaiting");
  });

  it("reads at most ten records of an event", async () => {
    const w = world();
    const one = snsEvent("not json").Records[0]!;
    const words = await handleCallbackEvent({ Records: Array.from({ length: 25 }, () => one) }, w.callbackDeps);
    expect(words).toHaveLength(10);
    expect(await handleCallbackEvent({ Records: "x" }, w.callbackDeps)).toEqual([]);
  });
});

describe("an Update and a Delete", () => {
  async function connected(w: Fixture) {
    const c = await begin(w);
    await create(w, c);
    return c;
  }

  it("an Update from the recorded stack changes only the template version", async () => {
    const w = world();
    const c = await connected(w);
    const before = structuredClone(stored(w, c.connectionId));
    expect(await handleCallbackEvent(snsEvent(callbackRequest({ RequestType: "Update", connectionId: c.connectionId, token: c.token, properties: { TemplateVersion: "1.1.0" } })), w.callbackDeps)).toEqual(["updated"]);
    expect(stored(w, c.connectionId)).toMatchObject({ ...before, templateVersion: "1.1.0", version: before.version + 1 });
    expect(w.puts.at(-1)!.body).toMatchObject({ Status: "SUCCESS" });
  });

  it("an Update from a stack that was never recorded, or that names another account or other roles, changes nothing and is still answered SUCCESS", async () => {
    const w = world();
    const c = await connected(w);
    const before = structuredClone(stored(w, c.connectionId));
    const stranger = `arn:aws:cloudformation:${REGION}:${OTHER_ACCOUNT}:stack/Rovara-test-access/99999999-2222-3333-4444-555555555555`;
    for (const over of [{ StackId: stranger, accountId: OTHER_ACCOUNT }, { properties: { RoleArn: `arn:aws:iam::${ACCOUNT}:role/rovara-test-conn_zzzzzzzzzzzzzzzzzzzz` } }]) {
      expect(await handleCallbackEvent(snsEvent(callbackRequest({ RequestType: "Update", connectionId: c.connectionId, token: c.token, ...over })), w.callbackDeps)).toEqual(["ignored"]);
    }
    expect(stored(w, c.connectionId)).toEqual(before);
    expect(w.puts.slice(-2).map((put) => put.body["Status"])).toEqual(["SUCCESS", "SUCCESS"]);
  });

  it("a Delete of the recorded stack disconnects the connection, ends its audit trail, and is answered SUCCESS", async () => {
    const w = world();
    const c = await connected(w);
    const words = await handleCallbackEvent(snsEvent(callbackRequest({ RequestType: "Delete", connectionId: c.connectionId, token: c.token })), w.callbackDeps);
    expect(words).toEqual(["disconnected"]);
    expect(stored(w, c.connectionId)).toMatchObject({ status: "disconnected", endCause: "deleted_stack" });
    expect(w.store.stacks.size).toBe(0);
    expect(w.puts.at(-1)!.body).toMatchObject({ Status: "SUCCESS" });
    expect(w.store.audits.at(-1)).toMatchObject({ action: "test_access.connection_ended", facts: { cause: "deleted_stack" } });
  });

  it("a Delete for a stack that is not the recorded one changes nothing and is still answered SUCCESS; a repeated Delete is too", async () => {
    const w = world();
    const c = await connected(w);
    const stranger = `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/Rovara-test-access/99999999-2222-3333-4444-555555555555`;
    expect(await handleCallbackEvent(snsEvent(callbackRequest({ RequestType: "Delete", connectionId: c.connectionId, token: c.token, StackId: stranger })), w.callbackDeps)).toEqual(["ignored"]);
    expect(stored(w, c.connectionId).status).toBe("reported");
    expect(w.puts.at(-1)!.body).toMatchObject({ Status: "SUCCESS" });
    await handleCallbackEvent(snsEvent(callbackRequest({ RequestType: "Delete", connectionId: c.connectionId, token: c.token })), w.callbackDeps);
    expect(await handleCallbackEvent(snsEvent(callbackRequest({ RequestType: "Delete", connectionId: c.connectionId, token: c.token })), w.callbackDeps)).toEqual(["ignored"]);
    expect(w.puts.at(-1)!.body).toMatchObject({ Status: "SUCCESS" });
  });

  it("a Delete is answered and handled even while the ta switch is off", async () => {
    const w = world();
    const c = await connected(w);
    w.enabled.value = false;
    expect(await handleCallbackEvent(snsEvent(callbackRequest({ RequestType: "Delete", connectionId: c.connectionId, token: c.token })), w.callbackDeps)).toEqual(["disconnected"]);
  });
});

it("never writes the token, the external id or a role into a log line, an audit event or an answer", async () => {
  const w = world();
  const c = await begin(w);
  await create(w, c);
  await create(w, c, { properties: { ConnectToken: "u".repeat(43) }, StackId: STACK_ID.replace("1111", "2222") });
  const everything = JSON.stringify([w.logs, w.store.audits, w.puts]);
  expect(everything).not.toContain(c.token);
  expect(everything).not.toContain("u".repeat(43));
  expect(everything).not.toContain(connectTokenHash(c.token));
  // Logs name the connection and a fixed word, nothing of the request.
  expect(JSON.stringify(w.logs)).not.toContain(ACCOUNT);
  expect(JSON.stringify(w.logs)).not.toContain(connectionExternalId(ORG, c.connectionId));
  // The audit holds the account in `details` (private), never in a fact.
  for (const event of w.store.audits) expect(JSON.stringify(event.facts ?? {})).not.toContain(ACCOUNT);
});
