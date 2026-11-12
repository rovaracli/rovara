// Customer test AWS account, lane TA2: the connect API's logic. Start, read, type-the-account-id, confirm, test, suspend and disconnect, with who may do each.
import { describe, expect, it } from "vitest";
import { TEST_ACCESS_TOKEN_TTL_SECONDS, connectionExternalId, testAccessRoleName } from "@agentx/cloud-contracts";
import { LIVE_LINKS_MAX, acknowledgeNotProduction, confirmConnection, connectionView, disconnectConnection, getConnection, listConnections, startConnection, submitAccountId, suspendConnection, testConnection } from "../../packages/broker/src/test-access/connect.js";
import { connectTokenHash } from "../../packages/broker/src/test-access/token.js";
import { ACCOUNT, ADMIN, OTHER_ADMIN, OTHER_ORG, ORG, PRINCIPAL, PROJECT, REGION, ROVARA_ACCOUNT, TEMPLATE_URL, TOPIC, caller, connectionExternalIdOfLast, makeCalls, tokenOfLink, world, type Fixture } from "../support/test-access-fixtures.js";

const code = async (call: Promise<unknown>): Promise<string | undefined> => (await call.then(() => undefined, (error: unknown) => error as { code?: string })) as string | undefined;
const codeOf = async (call: Promise<unknown>): Promise<string | undefined> => {
  const error = await call.then(() => undefined, (caught: unknown) => caught as { code?: string });
  return error?.code;
};

async function start(w: Fixture) {
  const started = await startConnection(w.connectDeps, caller(), { projectId: PROJECT, region: REGION });
  connectionExternalIdOfLast.value = connectionExternalId(ORG, started.connection.connectionId);
  return started;
}
async function reported(w: Fixture) {
  const started = await start(w);
  const record = w.store.connections.get(`${ORG}#${started.connection.connectionId}`)!;
  Object.assign(record, { status: "reported", version: 2, accountId: ACCOUNT, roleArn: `arn:aws:iam::${ACCOUNT}:role/${testAccessRoleName(record.connectionId)}`, cleanupRoleArn: `arn:aws:iam::${ACCOUNT}:role/rovara-cleanup-${record.connectionId}`, reportedVia: "callback", stackId: "arn:aws:cloudformation:us-west-2:222233334444:stack/Rovara-test-access/11111111-2222-3333-4444-555555555555" });
  return { ...started, record };
}

describe("starting a connection", () => {
  it("mints a link with the token, the derived external id, the broker role and the Region's topic, stores only the token's hash, and audits it", async () => {
    const w = world();
    const { connection, link } = await start(w);
    expect(link.startsWith(`https://${REGION}.console.aws.amazon.com/cloudformation/home?region=${REGION}#/stacks/quickcreate?`)).toBe(true);
    const params = new URLSearchParams(link.slice(link.indexOf("?", link.indexOf("#")) + 1));
    expect(params.get("param_ExternalId")).toBe(connectionExternalId(ORG, connection.connectionId));
    expect(params.get("param_RovaraPrincipal")).toBe(PRINCIPAL);
    expect(params.get("param_CallbackTopicArn")).toBe(TOPIC);
    expect(params.get("templateURL")).toBe(TEMPLATE_URL);
    const token = tokenOfLink(link);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    // The store holds the hash, bound to the organization, project, connection and Region, expiring in 30 minutes; the token itself is nowhere.
    const [item] = [...w.store.tokens.values()];
    expect(item).toMatchObject({ tokenHash: connectTokenHash(token), orgId: ORG, projectId: PROJECT, connectionId: connection.connectionId, region: REGION, expiresAtMs: w.clock.ms + TEST_ACCESS_TOKEN_TTL_SECONDS * 1_000 });
    expect(JSON.stringify([...w.store.connections.values(), ...w.store.tokens.values(), w.store.audits])).not.toContain(token);
    expect(w.store.connections.get(`${ORG}#${connection.connectionId}`)).toMatchObject({ status: "awaiting", version: 1, externalId: connectionExternalId(ORG, connection.connectionId), createdBy: ADMIN });
    expect(w.store.audits[0]).toMatchObject({ action: "test_access.connection_started", facts: { region: REGION }, actor: { kind: "member", id: ADMIN }, proof: { kind: "fresh_sign_in" } });
    expect(JSON.stringify(connection)).not.toContain(token);
    expect(w.assumeCalls).toHaveLength(0);
  });

  it("two connections never share a token or an id", async () => {
    const w = world();
    const first = await start(w);
    const second = await start(w);
    expect(tokenOfLink(first.link)).not.toBe(tokenOfLink(second.link));
    expect(first.connection.connectionId).not.toBe(second.connection.connectionId);
  });

  it("is off with the ta switch: nothing is read or written", async () => {
    const w = world();
    w.enabled.value = false;
    expect(await codeOf(startConnection(w.connectDeps, caller(), { projectId: PROJECT, region: REGION }))).toBe("NOT_FOUND");
    expect(await codeOf(getConnection(w.connectDeps, caller(), "conn_aaaaaaaaaaaaaaaaaaaa"))).toBe("NOT_FOUND");
    expect(w.store.connections.size).toBe(0);
  });

  it("needs a live admin with a fresh sign-in of the same person, and a project the admin can edit", async () => {
    const w = world();
    const go = () => startConnection(w.connectDeps, caller(), { projectId: PROJECT, region: REGION });
    w.admins.clear();
    expect(await codeOf(go())).toBe("FORBIDDEN");
    w.admins.add(ADMIN);
    w.sessionAuthTime.value = new Date(w.clock.ms - 60 * 60_000).toISOString();
    expect(await codeOf(go())).toBe("REAUTH_REQUIRED");
    w.sessionAuthTime.value = undefined;
    expect(await codeOf(go())).toBe("REAUTH_REQUIRED");
    w.sessionAuthTime.value = new Date(w.clock.ms - 60_000).toISOString();
    expect(await codeOf(startConnection(w.connectDeps, caller({ sessionId: "session-other" }), { projectId: PROJECT, region: REGION }))).toBe("REAUTH_REQUIRED");
    expect(await codeOf(startConnection(w.connectDeps, caller({ sessionId: "nope" }), { projectId: PROJECT, region: REGION }))).toBe("REAUTH_REQUIRED");
    w.canEdit.value = false;
    expect(await codeOf(go())).toBe("PROJECT_NOT_FOUND");
    w.canEdit.value = true;
    expect(await codeOf(startConnection(w.connectDeps, caller({ orgId: "org_bad" }), { projectId: PROJECT, region: REGION }))).toBe("FORBIDDEN");
    expect(w.store.connections.size).toBe(0);
  });

  it("refuses a Region Rovara has no topic in, a malformed Region, a malformed project, and more than five waiting links", async () => {
    const w = world();
    for (const region of ["eu-west-1", "us-west-2; drop", "", "cn-north-1"]) expect(await codeOf(startConnection(w.connectDeps, caller(), { projectId: PROJECT, region })), region).toBe("CONFIG_INVALID");
    expect(await codeOf(startConnection(w.connectDeps, caller(), { projectId: "../x", region: REGION }))).toBe("PROJECT_NOT_FOUND");
    for (let index = 0; index < LIVE_LINKS_MAX; index += 1) await start(w);
    expect(await codeOf(startConnection(w.connectDeps, caller(), { projectId: PROJECT, region: REGION }))).toBe("CONFIG_INVALID");
    // An expired link no longer counts.
    w.clock.ms += 31 * 60_000;
    w.sessionAuthTime.value = new Date(w.clock.ms - 60_000).toISOString();
    await expect(start(w)).resolves.toBeDefined();
  });

  it("retries an id collision with a new id and token", async () => {
    const w = world();
    const first = await start(w);
    const ids = [first.connection.connectionId, "conn_bbbbbbbbbbbbbbbbbbbb"];
    const second = await startConnection({ ...w.connectDeps, newConnectionId: () => ids.shift() as string }, caller(), { projectId: PROJECT, region: REGION });
    expect(second.connection.connectionId).toBe("conn_bbbbbbbbbbbbbbbbbbbb");
  });
});

describe("reading", () => {
  it("another organization's connection is not found, the same as a missing one", async () => {
    const w = world();
    const { connection } = await start(w);
    w.admins.add(OTHER_ADMIN);
    const other = caller({ orgId: OTHER_ORG, developerId: OTHER_ADMIN });
    const foreign = await codeOf(getConnection(w.connectDeps, other, connection.connectionId));
    const missing = await codeOf(getConnection(w.connectDeps, other, "conn_aaaaaaaaaaaaaaaaaaaa"));
    expect(foreign).toBe("NOT_FOUND");
    expect(missing).toBe("NOT_FOUND");
    const messages = await Promise.all([getConnection(w.connectDeps, other, connection.connectionId), getConnection(w.connectDeps, other, "conn_aaaaaaaaaaaaaaaaaaaa"), getConnection(w.connectDeps, other, "../../x")].map((call) => call.then(() => "", (error: Error) => error.message)));
    expect(new Set(messages).size).toBe(1);
    expect(await listConnections(w.connectDeps, other)).toEqual([]);
  });

  it("the view shows the state, never the token, and marks a link that expired", async () => {
    const w = world();
    const { connection, link } = await start(w);
    expect(connection.linkExpired).toBe(false);
    w.clock.ms += 31 * 60_000;
    const view = await getConnection(w.connectDeps, caller(), connection.connectionId);
    expect(view.linkExpired).toBe(true);
    expect(JSON.stringify(view)).not.toContain(tokenOfLink(link));
  });
});

describe("typing the account id (the polling fallback)", () => {
  it("opens a 30-minute poll for a connection still waiting, and refuses a bad id, Rovara's own accounts and a production account", async () => {
    const w = world();
    const { connection } = await start(w);
    for (const accountId of ["12345", "1234567890ab", `${ACCOUNT} `, "", ROVARA_ACCOUNT, "111122223333"]) expect(await codeOf(submitAccountId(w.connectDeps, caller(), connection.connectionId, { accountId })), accountId).toBe("CONFIG_INVALID");
    const view = await submitAccountId(w.connectDeps, caller(), connection.connectionId, { accountId: ACCOUNT });
    expect(view.status).toBe("polling");
    expect(view.pollUntil).toBe(new Date(w.clock.ms + 30 * 60_000).toISOString());
    expect(w.store.polling.size).toBe(1);
    expect(w.store.connections.get(`${ORG}#${connection.connectionId}`)).toMatchObject({ pollAccountId: ACCOUNT, pollSubmittedBy: ADMIN });
    // A reported connection takes no typed id.
    const second = await reported(w);
    expect(await codeOf(submitAccountId(w.connectDeps, caller(), second.connection.connectionId, { accountId: ACCOUNT }))).toBe("CHANGE_STALE");
  });
});

describe("confirming", () => {
  it("confirms the account the admin was shown, then runs the test and ends connected", async () => {
    const w = world();
    const { connection } = await reported(w);
    expect((await getConnection(w.connectDeps, caller(), connection.connectionId)).needsConfirmation).toBe(true);
    const view = await confirmConnection(w.connectDeps, caller(), connection.connectionId, { accountId: ACCOUNT });
    expect(view.status).toBe("connected");
    expect(view.lastTest?.passed).toBe(true);
    expect(view.alias).toBe("beta-shared");
    expect(w.store.connections.get(`${ORG}#${connection.connectionId}`)).toMatchObject({ confirmedBy: ADMIN, status: "connected" });
    expect(w.store.audits.map((event) => event.action)).toEqual(["test_access.connection_started", "test_access.connection_confirmed", "test_access.connection_tested"]);
  });

  it("refuses a confirmation of another account than the one reported, a stale or missing id, a connection that has nothing to confirm, and an admin who is not fresh; and never assumes the role", async () => {
    const w = world();
    const { connection } = await reported(w);
    for (const accountId of ["555566667777", "", "x"]) expect(await codeOf(confirmConnection(w.connectDeps, caller(), connection.connectionId, { accountId })), accountId).toBe("CHANGE_STALE");
    w.sessionAuthTime.value = new Date(w.clock.ms - 60 * 60_000).toISOString();
    expect(await codeOf(confirmConnection(w.connectDeps, caller(), connection.connectionId, { accountId: ACCOUNT }))).toBe("REAUTH_REQUIRED");
    expect(w.assumeCalls).toHaveLength(0);
    expect(w.store.connections.get(`${ORG}#${connection.connectionId}`)!.status).toBe("reported");
    w.sessionAuthTime.value = new Date(w.clock.ms - 60_000).toISOString();
    const awaiting = await start(w);
    expect(await codeOf(confirmConnection(w.connectDeps, caller(), awaiting.connection.connectionId, { accountId: ACCOUNT }))).toBe("CHANGE_STALE");
    expect(w.assumeCalls).toHaveLength(0);
  });

  it("a connection that reported another account since the page loaded is not confirmed by the old page", async () => {
    const w = world();
    const { connection, record } = await reported(w);
    record.accountId = "555566667777";
    expect(await codeOf(confirmConnection(w.connectDeps, caller(), connection.connectionId, { accountId: ACCOUNT }))).toBe("CHANGE_STALE");
    expect(w.assumeCalls).toHaveLength(0);
  });

  it("a failing check leaves the connection needing attention, and testing again can pass", async () => {
    const w = world();
    const { connection } = await reported(w);
    w.aws.calls = makeCalls({ deleteQueueByName: () => Promise.resolve("not_found") }, w.aws.sent);
    const view = await confirmConnection(w.connectDeps, caller(), connection.connectionId, { accountId: ACCOUNT });
    expect(view.status).toBe("needs_attention");
    expect(view.lastTest?.checks.find((check) => check.id === "cannot_touch_others")).toMatchObject({ status: "fail", code: "fence_missing" });
    w.aws.calls = makeCalls({}, w.aws.sent);
    expect((await testConnection(w.connectDeps, caller(), connection.connectionId)).status).toBe("connected");
  });

  it("a prod alias needs the tick, then the test passes", async () => {
    const w = world();
    const { connection } = await reported(w);
    w.aws.calls = makeCalls({ listAccountAliases: () => Promise.resolve(["acme-prod"]) }, w.aws.sent);
    const view = await confirmConnection(w.connectDeps, caller(), connection.connectionId, { accountId: ACCOUNT });
    expect(view).toMatchObject({ status: "needs_attention", needsNotProductionTick: true });
    expect((await acknowledgeNotProduction(w.connectDeps, caller(), connection.connectionId))).toMatchObject({ status: "connected", needsNotProductionTick: false });
  });

  it("a test only runs for a connection an admin confirmed", async () => {
    const w = world();
    const { connection } = await reported(w);
    expect(await codeOf(testConnection(w.connectDeps, caller(), connection.connectionId))).toBe("CHANGE_STALE");
    const waiting = await start(w);
    expect(await codeOf(testConnection(w.connectDeps, caller(), waiting.connection.connectionId))).toBe("CHANGE_STALE");
    expect(w.assumeCalls).toHaveLength(0);
  });

  it("a connection suspended while the test runs is not moved back to connected", async () => {
    const w = world();
    const { connection } = await reported(w);
    w.aws.calls = makeCalls({ listAccountAliases: async () => { await suspendConnection(w.connectDeps, caller(), connection.connectionId); return ["beta"]; } }, w.aws.sent);
    await confirmConnection(w.connectDeps, caller(), connection.connectionId, { accountId: ACCOUNT });
    expect(w.store.connections.get(`${ORG}#${connection.connectionId}`)!.status).toBe("suspended");
  });
});

describe("suspending and disconnecting", () => {
  it("need a live admin only, apply at once, are audited, and are idempotent", async () => {
    const w = world();
    const { connection } = await reported(w);
    w.sessionAuthTime.value = undefined;
    expect((await suspendConnection(w.connectDeps, caller(), connection.connectionId)).status).toBe("suspended");
    expect(await suspendConnection(w.connectDeps, caller(), connection.connectionId)).toMatchObject({ status: "suspended" });
    expect((await disconnectConnection(w.connectDeps, caller(), connection.connectionId)).status).toBe("disconnected");
    expect((await disconnectConnection(w.connectDeps, caller(), connection.connectionId)).status).toBe("disconnected");
    expect(w.store.audits.filter((event) => event.action === "test_access.connection_ended").map((event) => event.facts)).toEqual([{ cause: "suspended" }, { cause: "disconnected" }]);
    w.admins.clear();
    expect(await codeOf(suspendConnection(w.connectDeps, caller(), connection.connectionId))).toBe("FORBIDDEN");
  });
});

it("the view of a record has no field that is not meant to be shown", () => {
  const view = connectionView({ orgId: ORG, connectionId: "conn_aaaaaaaaaaaaaaaaaaaa", projectId: PROJECT, region: REGION, status: "awaiting", version: 1, externalId: "x", createdBy: ADMIN, createdAt: "2026-11-12T12:00:00.000Z", tokenExpiresAt: "2026-11-12T12:30:00.000Z", pollSubmittedBy: ADMIN, lastPolledAt: "z", confirmedBy: ADMIN }, 0);
  expect(Object.keys(view).sort()).toEqual(["connectionId", "externalId", "linkExpired", "linkExpiresAt", "needsConfirmation", "needsNotProductionTick", "projectId", "region", "status"]);
  void code;
});
