// Customer test AWS account, lane TA2: the DynamoDB adapter of the store, against a fake client that evaluates the adapter's own condition expressions. The point: the one-use token, the version check, the key layout (per organization) and a
// row that does not parse.
import { describe, expect, it } from "vitest";
import { connectionExternalId } from "@agentx/cloud-contracts";
import { AuditEventInputSchema } from "@agentx/cloud-contracts";
import { dynamoTestAccessStore } from "../../packages/broker/src/test-access/dynamo-store.js";
import { connectionAudit } from "../../packages/broker/src/test-access/audit.js";
import type { ConnectTokenItem, ConnectionRecord, StackItem } from "../../packages/broker/src/test-access/store.js";
import { FakeDynamoClient } from "../support/fake-dynamo-client.js";
import { ACCOUNT, NOW, OTHER_ORG, ORG, PROJECT, REGION } from "../support/test-access-fixtures.js";

const CONN = "conn_aaaaaaaaaaaaaaaaaaaa";
const HASH = "f".repeat(64);
const STACK = `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/Rovara-test-access/11111111-2222-3333-4444-555555555555`;
const record = (over: Partial<ConnectionRecord> = {}): ConnectionRecord => ({ orgId: ORG, connectionId: CONN, projectId: PROJECT, region: REGION, status: "awaiting", version: 1, externalId: connectionExternalId(ORG, CONN), createdBy: "a".repeat(64), createdAt: new Date(NOW).toISOString(), tokenExpiresAt: new Date(NOW + 1_800_000).toISOString(), ...over });
const token = (over: Partial<ConnectTokenItem> = {}): ConnectTokenItem => ({ tokenHash: HASH, orgId: ORG, projectId: PROJECT, connectionId: CONN, region: REGION, expiresAtMs: NOW + 1_800_000, ...over });
const audit = (r: ConnectionRecord) => connectionAudit({ record: r, action: "test_access.connection_started", actor: { kind: "system" }, occurredAt: new Date(NOW).toISOString(), facts: { region: REGION } });
const stack = (over: Partial<StackItem> = {}): StackItem => ({ stackId: STACK, orgId: ORG, connectionId: CONN, accountId: ACCOUNT, tokenHash: HASH, recordedAtMs: NOW, ...over });
function build() {
  const client = new FakeDynamoClient();
  const pending: unknown[] = [];
  const store = dynamoTestAccessStore({ documentClient: client, tableName: "state", audit: { sqs: undefined as never, queueUrl: "q", documentClient: undefined as never, tableName: "state", now: () => NOW, log: () => undefined } });
  return { client, store, pending };
}

describe("creating and reading", () => {
  it("writes the connection, the token under its hash and the audit item in one transaction; a repeat id is refused", async () => {
    const { client, store } = build();
    expect(await store.createConnection(record(), token(), audit(record()))).toBe(true);
    expect(client.sent).toEqual(["TransactWriteCommand"]);
    expect([...client.items.keys()].map((key) => key.split("\u0000")[0]!.replace(/[0-9a-f]{64}$/u, "<hash>")).sort()).toEqual(["AUDIT_PENDING#" + [...client.items.keys()].find((key) => key.startsWith("AUDIT_PENDING#"))!.split("\u0000")[0]!.split("#")[1], `ORG#${ORG}`, "TATOKEN#<hash>"].sort());
    expect(await store.createConnection(record(), token({ tokenHash: "e".repeat(64) }), audit(record()))).toBe(false);
    expect(await store.createConnection(record({ connectionId: "conn_bbbbbbbbbbbbbbbbbbbb" }), token(), audit(record()))).toBe(false);
    expect(await store.getConnection(ORG, CONN)).toEqual(record());
    expect(AuditEventInputSchema.safeParse(audit(record())).success).toBe(true);
  });

  it("keeps every connection under its organization: another organization reads nothing", async () => {
    const { store } = build();
    await store.createConnection(record(), token(), audit(record()));
    expect(await store.getConnection(OTHER_ORG, CONN)).toBeUndefined();
    expect(await store.listConnections(OTHER_ORG, 10)).toEqual([]);
    expect((await store.listConnections(ORG, 10)).map((r) => r.connectionId)).toEqual([CONN]);
    await expect(store.getConnection("org_bad", CONN)).rejects.toThrow();
  });

  it("treats a row that does not parse, or names another organization or connection, as absent", async () => {
    const { client, store } = build();
    await store.createConnection(record(), token(), audit(record()));
    const key = [...client.items.keys()].find((k) => k.startsWith(`ORG#${ORG}`))!;
    const row = client.items.get(key)!;
    client.items.set(key, { ...row, record: { ...(row["record"] as object), status: "bogus" } });
    expect(await store.getConnection(ORG, CONN)).toBeUndefined();
    client.items.set(key, { ...row, record: { ...(row["record"] as object), orgId: OTHER_ORG } });
    expect(await store.getConnection(ORG, CONN)).toBeUndefined();
    client.items.set(key, { ...row, record: { ...(row["record"] as object), extra: 1 } });
    expect(await store.getConnection(ORG, CONN)).toBeUndefined();
    client.items.set(key, { ...row, version: 9 });
    expect(await store.getConnection(ORG, CONN)).toBeUndefined();
  });
});

describe("committing a connection", () => {
  it("replaces it only from the version read; a lost race is false and writes nothing", async () => {
    const { store } = build();
    await store.createConnection(record(), token(), audit(record()));
    const next = record({ version: 2, status: "reported", accountId: ACCOUNT });
    expect(await store.commitConnection(next, 1, undefined)).toBe(true);
    expect(await store.commitConnection(record({ version: 2, status: "confirmed" }), 1, undefined)).toBe(false);
    expect((await store.getConnection(ORG, CONN))?.status).toBe("reported");
    expect(await store.commitConnection(record({ connectionId: "conn_zzzzzzzzzzzzzzzzzzzz", version: 2 }), 1, undefined)).toBe(false);
  });

  it("keeps the poll list in step with the status, and forgets the stack of a disconnected connection", async () => {
    const { client, store } = build();
    await store.createConnection(record(), token(), audit(record()));
    expect(await store.listPolling(10)).toEqual([]);
    await store.commitConnection(record({ version: 2, status: "polling", pollAccountId: ACCOUNT, pollUntil: new Date(NOW + 1_800_000).toISOString() }), 1, undefined);
    expect(await store.listPolling(10)).toEqual([{ orgId: ORG, connectionId: CONN }]);
    await store.commitConnection(record({ version: 3, status: "confirmed" }), 2, undefined);
    expect(await store.listPolling(10)).toEqual([]);
    client.items.set(`TASTACK#x\u0000STACK`, {});
    await store.consumeToken({ tokenHash: HASH, nowMs: NOW, stack: stack(), next: record({ version: 4, status: "reported", stackId: STACK, accountId: ACCOUNT }), expectedVersion: 3, audit: audit(record()) });
    expect(await store.getStack(STACK)).toBeDefined();
    await store.commitConnection(record({ version: 5, status: "disconnected", stackId: STACK }), 4, undefined);
    expect(await store.getStack(STACK)).toBeUndefined();
  });

  it("a stack row whose key matches but whose body names another stack is not that stack's record", async () => {
    const { client, store } = build();
    await store.createConnection(record(), token(), audit(record()));
    await store.consumeToken({ tokenHash: HASH, nowMs: NOW, stack: stack(), next: record({ version: 2, status: "reported", stackId: STACK }), expectedVersion: 1, audit: audit(record()) });
    const key = [...client.items.keys()].find((k) => k.startsWith("TASTACK#"))!;
    client.items.set(key, { ...client.items.get(key)!, stackId: "arn:aws:cloudformation:us-west-2:555566667777:stack/Other/99999999-2222-3333-4444-555555555555" });
    expect(await store.getStack(STACK)).toBeUndefined();
  });

  it("rethrows what is not a lost condition, and a poll list row that does not match its key is skipped", async () => {
    const { client, store } = build();
    await store.createConnection(record(), token(), audit(record()));
    client.failNextTransaction = Object.assign(new Error("throttled"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ThrottlingError" }] });
    await expect(store.commitConnection(record({ version: 2 }), 1, undefined)).rejects.toThrow("throttled");
    client.failNextTransaction = new Error("network");
    await expect(store.commitConnection(record({ version: 2 }), 1, undefined)).rejects.toThrow("network");
    client.items.set("TAPOLL\u0000wrong", { pk: "TAPOLL", sk: "wrong", orgId: ORG, connectionId: CONN });
    expect(await store.listPolling(10)).toEqual([]);
  });
});

describe("consuming the token", () => {
  async function ready() {
    const built = build();
    await built.store.createConnection(record(), token(), audit(record()));
    return built;
  }
  const consume = (store: ReturnType<typeof build>["store"], over: { nowMs?: number; next?: ConnectionRecord; expectedVersion?: number; stack?: StackItem; tokenHash?: string } = {}) =>
    store.consumeToken({ tokenHash: over.tokenHash ?? HASH, nowMs: over.nowMs ?? NOW, stack: over.stack ?? stack(), next: over.next ?? record({ version: 2, status: "reported", stackId: STACK, accountId: ACCOUNT }), expectedVersion: over.expectedVersion ?? 1, audit: audit(record()) });

  it("spends the token, records the stack and moves the connection together, once", async () => {
    const { store } = await ready();
    expect(await consume(store)).toBe("ok");
    expect((await store.getToken(HASH))?.usedAtMs).toBe(NOW);
    expect(await store.getStack(STACK)).toEqual(stack());
    expect((await store.getConnection(ORG, CONN))).toMatchObject({ status: "reported", version: 2 });
    // The same token again, for another stack: refused, and the stack is not recorded.
    const other = `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/Rovara-test-access/99999999-2222-3333-4444-555555555555`;
    expect(await consume(store, { stack: stack({ stackId: other }), expectedVersion: 2, next: record({ version: 3, status: "reported", stackId: other }) })).toBe("token_refused");
    expect(await store.getStack(other)).toBeUndefined();
  });

  it("refuses an expired token, an unknown one, and one made for another connection or project, changing nothing", async () => {
    const { client, store } = await ready();
    expect(await consume(store, { nowMs: NOW + 1_800_000 })).toBe("token_refused");
    expect(await consume(store, { tokenHash: "0".repeat(64) })).toBe("token_refused");
    expect(await consume(store, { next: record({ version: 2, status: "reported", projectId: "other" }) })).toBe("token_refused");
    expect(await consume(store, { next: record({ version: 2, status: "reported", connectionId: "conn_bbbbbbbbbbbbbbbbbbbb" }) })).toBe("token_refused");
    expect(await consume(store, { next: record({ version: 2, status: "reported", orgId: OTHER_ORG }) })).toBe("token_refused");
    expect((await store.getToken(HASH))?.usedAtMs).toBeUndefined();
    expect(await store.getStack(STACK)).toBeUndefined();
    expect([...client.items.keys()].some((key) => key.startsWith("TASTACK#"))).toBe(false);
  });

  it("a stack that is recorded already, or a connection that moved, is reported and the token stays unspent", async () => {
    const { client, store } = await ready();
    client.items.set(`TASTACK#${"0".repeat(64)}\u0000STACK`, {});
    expect(await consume(store, { expectedVersion: 7 })).toBe("connection_changed");
    expect((await store.getToken(HASH))?.usedAtMs).toBeUndefined();
    expect(await consume(store)).toBe("ok");
    const again = build();
    await again.store.createConnection(record(), token(), audit(record()));
    await again.store.createConnection(record({ connectionId: "conn_bbbbbbbbbbbbbbbbbbbb" }), token({ tokenHash: "e".repeat(64), connectionId: "conn_bbbbbbbbbbbbbbbbbbbb" }), audit(record()));
    expect(await consume(again.store)).toBe("ok");
    expect(await consume(again.store, { tokenHash: "e".repeat(64), next: record({ connectionId: "conn_bbbbbbbbbbbbbbbbbbbb", version: 2, status: "reported" }) })).toBe("stack_taken");
  });

  it("retiring a token spends it without a stack, once, and a missing token is not an error", async () => {
    const { store } = await ready();
    await store.retireToken(HASH, NOW);
    await store.retireToken(HASH, NOW + 5);
    await store.retireToken("0".repeat(64), NOW);
    expect((await store.getToken(HASH))?.usedAtMs).toBe(NOW);
    expect(await consume(store)).toBe("token_refused");
  });

  it("never stores the token itself: only its hash is a key or a value anywhere", async () => {
    const { client, store } = await ready();
    await consume(store);
    expect(JSON.stringify([...client.items.entries()])).not.toContain("t".repeat(43));
  });
});
