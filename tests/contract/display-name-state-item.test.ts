// Release 0.4.18: the name a person chooses is an item of its own in the broker's State table (DEVELOPER_NAME#<id>), not an update of the sign-in record.
// The broker has no write on the sign-in table (a bug there must not be able to un-revoke a person), so the rename is one transaction of: the name item (State),
// a ConditionCheck on the sign-in record (not revoked, not merged), and the audit's pending item (State). Readers lay the chosen name over the record's.
import { BatchGetCommand, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { auditEventId } from "@agentx/cloud-contracts";
import { auditOccurrence } from "../../packages/broker/src/audit/events.js";
import { chosenNameKey } from "../../packages/broker/src/developer/chosen-name.js";
import { placeholderDisplayName } from "../../packages/broker/src/developer/person-name.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import { MAYA, OMAR, createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

const idOf = (letter: string) => letter.repeat(64);
const T0 = Date.parse("2026-10-27T09:00:00.000Z");
const PLACEHOLDER = /^Member [0-9a-f]{8}$/;
const profile = (displayName: string, letter = "c") => ({ developerId: idOf(letter), provider: "cloud" as const, issuer: "https://idp.example.test", subject: `sub-${letter}`, displayName, email: `${letter}@example.com` });

/** A store over one fake table with every command it sends recorded, the sign-in table named "signin" and the State table "state". */
function world() {
  const audit = capturingAuditDeps();
  const db = new FakeDynamoDb();
  audit.attach(db);
  const sent: unknown[] = [];
  const documentClient = { send: (command: never) => { sent.push(command); return db.send(command); } };
  let now = T0;
  const store = new DeveloperSignInStore({ documentClient, tableName: "signin", nameTableName: "state", now: () => now, audit: audit.audit });
  const tick = (ms: number) => { now += ms; };
  return { db, store, audit, sent, tick };
}
const transactionsOf = (sent: unknown[]) => sent.filter((command): command is TransactWriteCommand => command instanceof TransactWriteCommand);

describe("the rename is one transaction that writes only the State table", () => {
  it("puts the name item, checks the sign-in record without writing it, and adds the audit's pending item", async () => {
    const { store, sent } = world();
    await store.upsertDeveloper(profile("c@example.com"));
    const mark = sent.length;
    await store.setChosenDisplayName({ developerId: idOf("c"), orgId: TEST_ORG, name: "Cy F" });
    const transactions = transactionsOf(sent.slice(mark));
    expect(transactions).toHaveLength(1);
    const items = transactions[0]!.input.TransactItems!;
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({ Put: { TableName: "state", Item: { ...chosenNameKey(idOf("c")), entityType: "DEVELOPER_NAME", developerId: idOf("c"), name: "Cy F", chosenAt: new Date(T0).toISOString() }, ConditionExpression: "attribute_not_exists(erased)" } });
    expect(items[1]).toEqual({ ConditionCheck: {
      TableName: "signin", Key: { pk: `DEVELOPER#${idOf("c")}`, sk: "META" },
      ConditionExpression: "attribute_exists(pk) AND (attribute_not_exists(revoked) OR revoked = :false) AND attribute_not_exists(mergedInto)",
      ExpressionAttributeValues: { ":false": false },
    } });
    expect(items[2]!.Put!.TableName).toBe("state");
    expect(String((items[2]!.Put!.Item as { pk: string }).pk)).toMatch(/^AUDIT_PENDING#/);
    // Nothing in it writes the sign-in table: a ConditionCheck is the only item that names it.
    const onSignIn = items.filter((item) => Object.values(item).some((part) => (part as { TableName?: string }).TableName === "signin"));
    expect(onSignIn.map((item) => Object.keys(item))).toEqual([["ConditionCheck"]]);
  });

  it("sends no Put, Update or Delete to the sign-in table outside the sign-in's own writes, and leaves the record as it was", async () => {
    const { store, sent, db } = world();
    await store.upsertDeveloper(profile("c@example.com"));
    const before = structuredClone(db.get(`DEVELOPER#${idOf("c")}`, "META"));
    const mark = sent.length;
    await store.setChosenDisplayName({ developerId: idOf("c"), orgId: TEST_ORG, name: "Cy F" });
    for (const command of sent.slice(mark)) {
      if (command instanceof PutCommand || command instanceof UpdateCommand || command instanceof DeleteCommand) expect((command.input as { TableName?: string }).TableName).not.toBe("signin");
    }
    expect(db.get(`DEVELOPER#${idOf("c")}`, "META")).toEqual(before);
  });

  it("refuses a revoked person, a merged one and one with no record, writing nothing and auditing nothing", async () => {
    const { store, db, audit } = world();
    await store.upsertDeveloper(profile("Cy"));
    db.set({ ...db.get(`DEVELOPER#${idOf("c")}`, "META")!, revoked: true });
    await expect(store.setChosenDisplayName({ developerId: idOf("c"), orgId: TEST_ORG, name: "Cy F" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    db.set({ ...db.get(`DEVELOPER#${idOf("c")}`, "META")!, revoked: false, mergedInto: idOf("d") });
    await expect(store.setChosenDisplayName({ developerId: idOf("c"), orgId: TEST_ORG, name: "Cy F" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(store.setChosenDisplayName({ developerId: idOf("9"), orgId: TEST_ORG, name: "Nobody" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.get(`DEVELOPER_NAME#${idOf("c")}`, "NAME")).toBeUndefined();
    expect(db.get(`DEVELOPER_NAME#${idOf("9")}`, "NAME")).toBeUndefined();
    expect(audit.recorded()).toEqual([]);
    expect((await store.getDeveloper(idOf("c")))?.displayName).toBe("Cy");
  });

  it("refuses a record revoked after it was read: the check is in the transaction, so no name item is left", async () => {
    const { store, db, audit } = world();
    await store.upsertDeveloper(profile("Cy"));
    // The record is read as live, then revoked before the transaction runs.
    db.injectFault({ command: "TransactWriteCommand", error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }, { Code: "None" }] } });
    await expect(store.setChosenDisplayName({ developerId: idOf("c"), orgId: TEST_ORG, name: "Cy F" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.get(`DEVELOPER_NAME#${idOf("c")}`, "NAME")).toBeUndefined();
    expect(audit.recorded()).toEqual([]);
  });

  it("does not report another cancellation as a refusal", async () => {
    const { store, db } = world();
    await store.upsertDeveloper(profile("Cy"));
    db.injectFault({ command: "TransactWriteCommand", error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "TransactionConflict" }, { Code: "None" }, { Code: "None" }] } });
    await expect(store.setChosenDisplayName({ developerId: idOf("c"), orgId: TEST_ORG, name: "Cy F" })).rejects.toMatchObject({ name: "TransactionCanceledException" });
  });

  it("audits member.renamed once, with the person and no name", async () => {
    const { store, audit, tick } = world();
    await store.upsertDeveloper(profile("Cy"));
    tick(500);
    await store.setChosenDisplayName({ developerId: idOf("c"), orgId: TEST_ORG, name: "Cy F" });
    const at = new Date(T0 + 500).toISOString();
    expect(audit.recordedBy("member.renamed")).toEqual([{
      eventId: auditEventId("member.renamed", auditOccurrence(idOf("c"), at)), orgId: TEST_ORG, action: "member.renamed",
      actor: { kind: "member", id: idOf("c") }, target: { kind: "member", id: idOf("c") }, occurredAt: at,
    }]);
    expect(JSON.stringify(audit.recorded())).not.toContain("Cy F");
  });

  it("replays: the same name again writes and audits nothing; a changed name is a second change; a retry after a failure stores the name once", async () => {
    const { store, audit, sent, tick, db } = world();
    await store.upsertDeveloper(profile("Cy"));
    db.injectFault({ command: "TransactWriteCommand", error: { name: "ThrottlingException" } });
    await expect(store.setChosenDisplayName({ developerId: idOf("c"), orgId: TEST_ORG, name: "Cy F" })).rejects.toMatchObject({ name: "ThrottlingException" });
    expect(db.get(`DEVELOPER_NAME#${idOf("c")}`, "NAME")).toBeUndefined();
    tick(1000);
    const first = await store.setChosenDisplayName({ developerId: idOf("c"), orgId: TEST_ORG, name: "Cy F" });
    expect(first).toMatchObject({ displayName: "Cy F", displayNameChosen: true });
    const transactions = transactionsOf(sent).length;
    tick(1000);
    expect(await store.setChosenDisplayName({ developerId: idOf("c"), orgId: TEST_ORG, name: "Cy F" })).toMatchObject({ displayName: "Cy F" });
    expect(transactionsOf(sent)).toHaveLength(transactions);
    expect(audit.recordedBy("member.renamed")).toHaveLength(1);
    tick(1000);
    await store.setChosenDisplayName({ developerId: idOf("c"), orgId: TEST_ORG, name: "Cy G" });
    expect(audit.recordedBy("member.renamed")).toHaveLength(2);
    expect((await store.getDeveloper(idOf("c")))?.displayName).toBe("Cy G");
  });

  it("keeps the name when the audit queue is down (the pending item is in the transaction)", async () => {
    const { store, audit, db } = world();
    await store.upsertDeveloper(profile("Cy"));
    audit.queueDown();
    await store.setChosenDisplayName({ developerId: idOf("c"), orgId: TEST_ORG, name: "Cy F" });
    expect(db.get(`DEVELOPER_NAME#${idOf("c")}`, "NAME")).toMatchObject({ name: "Cy F" });
    expect(audit.pending()).toHaveLength(1);
  });

  it("validates the name again in the store: an email, an empty name and a placeholder shape are refused before any write", async () => {
    const { store, sent } = world();
    await store.upsertDeveloper(profile("Cy"));
    const mark = sent.length;
    for (const name of ["c@example.com", "Cy (c@example.com)", "  ", "", "x".repeat(81), "Member 3fa9", placeholderDisplayName(idOf("c"))]) {
      await expect(store.setChosenDisplayName({ developerId: idOf("c"), orgId: TEST_ORG, name })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(sent.slice(mark)).toEqual([]);
  });

  it("needs the State table: a store made without it cannot rename", async () => {
    const db = new FakeDynamoDb();
    const store = new DeveloperSignInStore({ documentClient: db, tableName: "signin", now: () => T0 });
    await store.upsertDeveloper(profile("Cy"));
    await expect(store.setChosenDisplayName({ developerId: idOf("c"), orgId: TEST_ORG, name: "Cy F" })).rejects.toBeTruthy();
  });
});

describe("what is read after a rename", () => {
  it("shows the chosen name, marked chosen, and a sign-in never overwrites it (the sign-in does not touch the item)", async () => {
    const { store, db, tick } = world();
    await store.upsertDeveloper(profile("c@example.com"));
    tick(1000);
    await store.setChosenDisplayName({ developerId: idOf("c"), orgId: TEST_ORG, name: "Cy F" });
    const item = structuredClone(db.get(`DEVELOPER_NAME#${idOf("c")}`, "NAME"));
    tick(1000);
    const after = await store.upsertDeveloper(profile("Someone Else"));
    expect(after.lastSignInAt).toBe(new Date(T0 + 2000).toISOString());
    expect(await store.getDeveloper(idOf("c"))).toMatchObject({ displayName: "Cy F", displayNameChosen: true });
    await store.upsertDeveloper(profile("c@example.com"));
    expect((await store.getDeveloper(idOf("c")))?.displayName).toBe("Cy F");
    expect(db.get(`DEVELOPER_NAME#${idOf("c")}`, "NAME")).toEqual(item);
  });

  it("reads old records safely: a stored email is the placeholder, a name chosen under 0.4.16 stays, and an item that holds an email or no name is not trusted", async () => {
    const { store, db } = world();
    db.set({ pk: `DEVELOPER#${idOf("a")}`, sk: "META", developerId: idOf("a"), provider: "oidc", displayName: "omar@example.com", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    expect((await store.getDeveloper(idOf("a")))?.displayName).toMatch(PLACEHOLDER);
    // A 0.4.16 record the person already named on the sign-in record itself (a private install, where that write was allowed).
    db.set({ pk: `DEVELOPER#${idOf("b")}`, sk: "META", developerId: idOf("b"), provider: "oidc", displayName: "Old Choice", displayNameChosen: true, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    expect(await store.getDeveloper(idOf("b"))).toMatchObject({ displayName: "Old Choice", displayNameChosen: true });
    // An item holding an address shows as the placeholder, not the address.
    db.set({ pk: `DEVELOPER#${idOf("d")}`, sk: "META", developerId: idOf("d"), provider: "oidc", displayName: "Dee", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    db.set({ ...chosenNameKey(idOf("d")), entityType: "DEVELOPER_NAME", developerId: idOf("d"), name: "dee@example.com", chosenAt: "x" });
    expect((await store.getDeveloper(idOf("d")))?.displayName).toMatch(PLACEHOLDER);
    // An item with no usable name is ignored.
    db.set({ pk: `DEVELOPER#${idOf("e")}`, sk: "META", developerId: idOf("e"), provider: "oidc", displayName: "Eve", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    db.set({ ...chosenNameKey(idOf("e")), entityType: "DEVELOPER_NAME", developerId: idOf("e"), name: 7, chosenAt: "x" });
    expect(await store.getDeveloper(idOf("e"))).toMatchObject({ displayName: "Eve" });
    expect((await store.getDeveloper(idOf("e")))?.displayNameChosen).not.toBe(true);
  });

  it("reads a list's chosen names in one BatchGetItem per 100 people, not one read per person", async () => {
    const { store, db, sent } = world();
    const ids = Array.from({ length: 130 }, (_value, index) => index.toString(16).padStart(64, "0"));
    for (const id of ids) db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, provider: "oidc", displayName: `Person ${id.slice(-3)}`, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    db.set({ ...chosenNameKey(ids[7]!), entityType: "DEVELOPER_NAME", developerId: ids[7]!, name: "Chosen Seven", chosenAt: "x" });
    const mark = sent.length;
    const records = await store.getDevelopers([...ids, ids[0]!, idOf("f")]);
    const commands = sent.slice(mark);
    expect(commands.filter((command) => command instanceof BatchGetCommand)).toHaveLength(2);
    expect(commands.filter((command) => command instanceof GetCommand && (command.input.Key as { pk: string }).pk.startsWith("DEVELOPER_NAME#"))).toEqual([]);
    expect(records.size).toBe(130);
    expect(records.get(ids[7]!)).toMatchObject({ displayName: "Chosen Seven", displayNameChosen: true });
    expect(records.get(ids[8]!)?.displayName).toBe(`Person ${ids[8]!.slice(-3)}`);
    expect(records.has(idOf("f"))).toBe(false);
  });
});

async function broker() {
  const audit = capturingAuditDeps();
  const h = await createDeveloperTaskBroker({ audit });
  seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
  return { ...h, audit };
}

describe("every screen shows the chosen name", () => {
  it("shows it to the person and in the org's members list (owner and plain member)", async () => {
    const h = await broker();
    const answer = await h.dev(MAYA, "PUT", "/v1/app/me/name", { name: "Maya C" });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body).toMatchObject({ name: "Maya C", nameChosen: true });
    // The sign-in record is as it was; only the State item is new.
    expect(h.db.get(`DEVELOPER#${MAYA.developerId}`, "META")).toMatchObject({ displayName: "Maya Chen" });
    expect(h.db.get(`DEVELOPER_NAME#${MAYA.developerId}`, "NAME")).toMatchObject({ name: "Maya C" });
    expect((await h.dev(MAYA, "GET", "/v1/app/me")).body.developer).toMatchObject({ name: "Maya C", nameChosen: true });
    const nameIn = (body: unknown) => (body as { members: Array<{ developerId: string; name: string }> }).members.find((member) => member.developerId === MAYA.developerId)?.name;
    expect(nameIn((await h.dev(OMAR, "GET", "/v1/app/org/members")).body)).toBe("Maya C");
    expect(nameIn((await h.dev(MAYA, "GET", "/v1/app/org/members")).body)).toBe("Maya C");
    // Omar did not choose one, so he reads as his sign-in record has him.
    expect(((await h.dev(MAYA, "GET", "/v1/app/org/members")).body as { members: Array<{ developerId: string; name: string }> }).members.find((member) => member.developerId === OMAR.developerId)?.name).toBe("Omar Diaz");
  });

  it("lists the members with one BatchGetItem for the names, whatever the size of the org", async () => {
    const h = await broker();
    for (let index = 0; index < 12; index += 1) {
      const id = `${index.toString(16)}`.padStart(2, "0").repeat(32);
      h.db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, provider: "oidc", displayName: `Member Person ${index}`, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
      seedMembership(h.db, id, { orgId: TEST_ORG, role: "member" });
    }
    await h.dev(MAYA, "PUT", "/v1/app/me/name", { name: "Maya C" });
    const sent: unknown[] = [];
    const send = h.db.send.bind(h.db);
    h.db.send = ((command: never) => { sent.push(command); return send(command); }) as typeof h.db.send;
    const answer = await h.dev(OMAR, "GET", "/v1/app/org/members");
    expect(answer.status).toBe(200);
    // The one read of the caller's own name is the sign-in check of the request; the list's names come from the batch.
    const nameReads = sent.filter((command) => command instanceof GetCommand && String((command.input.Key as { pk: string }).pk).startsWith("DEVELOPER_NAME#"));
    expect(nameReads.map((command) => (command as GetCommand).input.Key)).toEqual([chosenNameKey(OMAR.developerId)]);
    expect(sent.filter((command) => command instanceof BatchGetCommand)).toHaveLength(1);
  });

  it("refuses a revoked person's rename through the route and writes no name item", async () => {
    const h = await broker();
    // The session check refuses a revoked person first; a record revoked between that check and the transaction is the store's test above.
    h.db.set({ ...h.db.get(`DEVELOPER#${MAYA.developerId}`, "META")!, revoked: true });
    const answer = await h.dev(MAYA, "PUT", "/v1/app/me/name", { name: "Maya C" });
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(h.db.get(`DEVELOPER_NAME#${MAYA.developerId}`, "NAME")).toBeUndefined();
    expect(h.audit.recorded()).toEqual([]);
  });

  it("audits the rename once through the route, with no name", async () => {
    const h = await broker();
    await h.dev(MAYA, "PUT", "/v1/app/me/name", { name: "Maya C" });
    await h.dev(MAYA, "PUT", "/v1/app/me/name", { name: "Maya C" });
    expect(h.audit.recordedBy("member.renamed")).toEqual([expect.objectContaining({ orgId: TEST_ORG, actor: { kind: "member", id: MAYA.developerId } })]);
    expect(JSON.stringify(h.audit.recorded())).not.toContain("Maya C");
  });
});
