// ERASE-NAME-1: the name a person chose (State item DEVELOPER_NAME#<id>) and the name their sign-in record holds must not outlive an erase, and must not show for a removed person's
// chosen name. An erase leaves a tombstone in the name item (no name in storage), the sign-in function clears the record's name, and every reader resolves through the erased state so a
// stored copy of the name that was missed (an event's actor, a session's stored owner, a task's stored owner) never shows. These tests check each surface for an erased person, with the
// Team record's switch on and off, and each with a positive control (the name shows before the erase).
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { agentSessionKey, erasedPersonKey, mySessionsKey, orgMemberKey, sessionEventId } from "../../packages/contracts/src/index.js";
import { sessionView, type SessionReadDependencies } from "../../packages/broker/src/agent-sessions/read.js";
import { appendSessionEvent, readSessionEvents } from "../../packages/broker/src/agent-sessions/events.js";
import { onMemberRemoved } from "../../packages/broker/src/agents/lifecycle.js";
import { FORMER_MEMBER, auditActorNamesOf } from "../../packages/broker/src/audit/actor-names.js";
import { personErasureStep } from "../../packages/broker/src/aws/broker/evidence-wiring.js";
import {
  FORMER_MEMBER_NAME, chosenNameKey, deleteChosenNameOfRemoved, eraseChosenName, readChosenName, readChosenNameStates, readChosenNames, readOwnChosenName,
} from "../../packages/broker/src/developer/chosen-name.js";
import { nameEraserOf } from "../../packages/broker/src/developer/erase-name.js";
import { placeholderDisplayName } from "../../packages/broker/src/developer/person-name.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import { erasePerson } from "../../packages/broker/src/team-record/erase.js";
import { ARJUN, CELL, ORG_A, PRIYA, sessionWorld } from "../support/agent-session-world.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { HOUR, SAM, T0, removalWorld } from "../support/member-removal-world.js";
import { TEST_ORG } from "../support/orgs.js";

const CHOSEN = "Priya R";
const REAL = "Priya Realname";
const AT = "2026-10-22T10:00:00.000Z";
const NOW = Date.parse("2026-11-07T10:00:00.000Z");
const nameItem = (developerId: string, name: string, chosenAt = "2026-10-27T09:00:00.000Z") => ({ ...chosenNameKey(developerId), entityType: "DEVELOPER_NAME", developerId, name, chosenAt });
const tombstoneOf = (db: FakeDynamoDb, developerId: string) => db.get(chosenNameKey(developerId));
const hex = (digit: string) => digit.repeat(64);

describe("the name item", () => {
  it("an erase leaves a tombstone with no name in it, and every reader reads 'A former member'", async () => {
    const db = new FakeDynamoDb();
    db.set(nameItem(PRIYA, CHOSEN));
    expect(await readChosenName(db, "state", PRIYA)).toBe(CHOSEN);
    await eraseChosenName(db, "state", PRIYA, AT);
    const stored = tombstoneOf(db, PRIYA)!;
    expect(stored).toMatchObject({ erased: true, erasedAt: AT, developerId: PRIYA });
    expect(JSON.stringify(stored)).not.toContain(CHOSEN);
    expect(stored).not.toHaveProperty("name");
    expect(await readChosenName(db, "state", PRIYA)).toBe(FORMER_MEMBER_NAME);
    expect([...(await readChosenNames(db, "state", [PRIYA, ARJUN])).entries()]).toEqual([[PRIYA, FORMER_MEMBER_NAME]]);
    expect((await readChosenNameStates(db, "state", [PRIYA])).get(PRIYA)).toEqual({ name: FORMER_MEMBER_NAME, erased: true });
    // The erase's own reads (the Asks' alias hashing) never take the label for one of the person's names.
    expect(await readOwnChosenName(db, "state", PRIYA)).toBeUndefined();
  });

  it("is repeatable and works for a person who never chose a name", async () => {
    const db = new FakeDynamoDb();
    await eraseChosenName(db, "state", ARJUN, AT);
    await eraseChosenName(db, "state", ARJUN, "2026-11-01T00:00:00.000Z");
    expect(await readChosenName(db, "state", ARJUN)).toBe(FORMER_MEMBER_NAME);
  });
});

describe("the sign-in record and the erase of the name", () => {
  const profile = (displayName: string) => ({ developerId: PRIYA, provider: "cloud" as const, issuer: "https://idp.example.test", subject: "sub-p", displayName, email: "p@example.test" });
  function stores() {
    const db = new FakeDynamoDb();
    // The sign-in function has no grant on the State item; the broker's store reads both.
    const signIn = new DeveloperSignInStore({ documentClient: db, tableName: "signin", now: () => NOW });
    const broker = new DeveloperSignInStore({ documentClient: db, tableName: "signin", nameTableName: "state", now: () => NOW });
    return { db, signIn, broker };
  }

  it("clears the record's name to the placeholder, and a later sign-in does not write the provider's name back", async () => {
    const { db, signIn } = stores();
    await signIn.upsertDeveloper(profile(REAL));
    expect((await signIn.getDeveloper(PRIYA))?.displayName).toBe(REAL);
    expect(await signIn.eraseDisplayName(PRIYA, AT)).toBe("erased");
    const record = db.get({ pk: `DEVELOPER#${PRIYA}`, sk: "META" }) as { displayName: string; nameErasedAt: string };
    expect(record.displayName).toBe(placeholderDisplayName(PRIYA));
    expect(record.nameErasedAt).toBe(AT);
    expect(JSON.stringify(record)).not.toContain(REAL);
    const again = await signIn.upsertDeveloper(profile(REAL));
    expect(again.displayName).toBe(placeholderDisplayName(PRIYA));
    // Repeating the erase keeps the first time and says not_found for a person who never signed in.
    expect(await signIn.eraseDisplayName(PRIYA, "2026-11-09T00:00:00.000Z")).toBe("erased");
    expect((db.get({ pk: `DEVELOPER#${PRIYA}`, sk: "META" }) as { nameErasedAt: string }).nameErasedAt).toBe(AT);
    expect(await signIn.eraseDisplayName(ARJUN, AT)).toBe("not_found");
  });

  it("the eraser writes the tombstone first and then asks the sign-in function; an unavailable function throws after the tombstone is in place", async () => {
    const { db, signIn, broker } = stores();
    await signIn.upsertDeveloper(profile(REAL));
    await broker.setChosenDisplayName({ developerId: PRIYA, orgId: TEST_ORG, name: CHOSEN });
    expect((await broker.getDeveloper(PRIYA))?.displayName).toBe(CHOSEN);
    const calls: unknown[] = [];
    let answer: { ok: true } | { ok: false; error: "not_found" | "invalid_request" | "unavailable" } = { ok: false, error: "unavailable" };
    const eraser = nameEraserOf({ documentClient: db, stateTable: "state", now: () => NOW, eraseSignInName: async (request) => {
      calls.push(request);
      if (answer.ok) await signIn.eraseDisplayName(request.developerId, request.at);
      return answer;
    } });
    await expect(eraser.erase(PRIYA)).rejects.toThrow("erase_name_sign_in_unavailable");
    expect(tombstoneOf(db, PRIYA)).toMatchObject({ erased: true });
    // The record still holds the real name, but no reader through the store shows it.
    expect((await broker.getDeveloper(PRIYA))?.displayName).toBe(FORMER_MEMBER_NAME);
    answer = { ok: true };
    await eraser.erase(PRIYA);
    expect(calls).toEqual([{ kind: "erase-developer-name", developerId: PRIYA, at: new Date(NOW).toISOString() }, { kind: "erase-developer-name", developerId: PRIYA, at: new Date(NOW).toISOString() }]);
    expect((db.get({ pk: `DEVELOPER#${PRIYA}`, sk: "META" }) as { displayName: string }).displayName).toBe(placeholderDisplayName(PRIYA));
    // A person who never signed in is an answer, not a failure.
    answer = { ok: false, error: "not_found" };
    await eraser.erase(ARJUN);
    expect(tombstoneOf(db, ARJUN)).toMatchObject({ erased: true });
  });

  it("shows 'A former member' in member lists and for one person, and refuses a name chosen over the tombstone", async () => {
    const { db, signIn, broker } = stores();
    await signIn.upsertDeveloper(profile(REAL));
    expect([...(await broker.getDevelopers([PRIYA])).values()].map((record) => record.displayName)).toEqual([REAL]);
    await eraseChosenName(db, "state", PRIYA, AT);
    expect([...(await broker.getDevelopers([PRIYA])).values()].map((record) => record.displayName)).toEqual([FORMER_MEMBER_NAME]);
    expect((await broker.getDeveloper(PRIYA))?.displayName).toBe(FORMER_MEMBER_NAME);
    await expect(broker.setChosenDisplayName({ developerId: PRIYA, orgId: TEST_ORG, name: "Back Again" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tombstoneOf(db, PRIYA)).toMatchObject({ erased: true });
  });
});

describe("the conversation timeline (session events)", () => {
  function eventsWorld() {
    const w = sessionWorld();
    const deps = { documentClient: w.db, tableName: "state", now: () => Date.parse(AT) + 60_000, projectMembers: w.members, signInStore: w.signInStore };
    const { sessionId } = w.seedSession();
    return { w, deps, sessionId };
  }

  it("an erased actor reads 'A former member' in the actor and in the words, whatever name the event stored; others are untouched", async () => {
    const { w, deps, sessionId } = eventsWorld();
    // The event stored the person's REAL name (a person who never chose one), which the placeholder-only overlay never replaced.
    await appendSessionEvent(deps, ORG_A, sessionId, { eventId: sessionEventId("started", "a"), at: AT, type: "status", actor: { kind: "member", developerId: PRIYA, name: REAL }, text: `${REAL} started Rovara Code` });
    await appendSessionEvent(deps, ORG_A, sessionId, { eventId: sessionEventId("linked", "b"), at: new Date(Date.parse(AT) + 1_000).toISOString(), type: "status", actor: { kind: "member", developerId: ARJUN, name: "Arjun Real" }, text: "Arjun Real linked this session." });
    const read = async () => (await readSessionEvents(deps, w.caller(PRIYA), sessionId, {})).events;
    const before = await read();
    expect(before.find((event) => event.eventId === sessionEventId("started", "a"))).toMatchObject({ actor: { name: REAL }, text: `${REAL} started Rovara Code` });
    await eraseChosenName(w.db, "state", PRIYA, AT);
    const after = await read();
    const started = after.find((event) => event.eventId === sessionEventId("started", "a"))!;
    expect(started.actor).toEqual({ kind: "member", developerId: PRIYA, name: FORMER_MEMBER_NAME });
    expect(started.text).toBe(`${FORMER_MEMBER_NAME} started Rovara Code`);
    expect(JSON.stringify(after)).not.toContain(REAL);
    expect(after.find((event) => event.eventId === sessionEventId("linked", "b"))).toMatchObject({ actor: { name: "Arjun Real" }, text: "Arjun Real linked this session." });
  });

  it("an erased person who had chosen a name is also replaced when the event stored the chosen name", async () => {
    const { w, deps, sessionId } = eventsWorld();
    w.db.set(nameItem(PRIYA, CHOSEN));
    await appendSessionEvent(deps, ORG_A, sessionId, { eventId: sessionEventId("started", "c"), at: AT, type: "status", actor: { kind: "member", developerId: PRIYA, name: CHOSEN }, text: `${CHOSEN} started` });
    const read = async () => (await readSessionEvents(deps, w.caller(PRIYA), sessionId, {})).events;
    expect((await read())[0]!.actor).toMatchObject({ name: CHOSEN });
    await eraseChosenName(w.db, "state", PRIYA, AT);
    const [event] = await read();
    expect(event!.actor).toMatchObject({ name: FORMER_MEMBER_NAME });
    expect(JSON.stringify(event)).not.toContain(CHOSEN);
  });
});

describe("the session header", () => {
  it("shows an erased owner and payer as 'A former member', though the session stored the real name", async () => {
    const w = sessionWorld();
    const deps: SessionReadDependencies = {
      documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: CELL, cursorKey: "k".repeat(64),
      taskView: async (task) => ({ taskId: task.taskId, title: "Bump the Stripe SDK", project: task.project, status: "RUNNING", startingRevision: 1, client: "test", shared: false, createdAt: AT, updatedAt: AT } as never),
    };
    const seeded = w.seedSession({ owner: PRIYA });
    const meta = w.db.get(agentSessionKey(ORG_A, seeded.sessionId, "META"))!;
    w.db.set({ ...meta, owner: { developerId: PRIYA, name: REAL } });
    w.db.set({ ...mySessionsKey(ORG_A, PRIYA, AT, seeded.sessionId), sessionId: seeded.sessionId, orgId: ORG_A });
    const before = await sessionView(deps, w.caller(PRIYA), seeded.sessionId);
    expect(before.owner.name).toBe(REAL);
    await eraseChosenName(w.db, "state", PRIYA, AT);
    const view = await sessionView(deps, w.caller(PRIYA), seeded.sessionId);
    expect(view.owner).toEqual({ developerId: PRIYA, name: FORMER_MEMBER_NAME });
    expect(view.cost.payer.name).toBe(FORMER_MEMBER_NAME);
    expect(JSON.stringify(view)).not.toContain(REAL);
  });
});

describe("the Audit page's names, with the Team record's switch on and off", () => {
  const ORG = "org_aaaaaaaaaaaaaaaaaaaa";
  const [priya, arjun] = [hex("a"), hex("b")];
  function world() {
    const db = new FakeDynamoDb();
    for (const [id, name] of [[priya, REAL], [arjun, "Arjun Shah"]] as const) {
      db.set({ ...orgMemberKey(ORG, id), orgId: ORG, developerId: id, role: "member" });
      db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, displayName: name });
    }
    return db;
  }
  it.each([["off", undefined], ["on", "record"]])("an erased person reads 'A former member' with the record %s, though the sign-in record still holds the name", async (_switch, teamRecordTable) => {
    const db = world();
    const names = () => auditActorNamesOf({ documentClient: db, stateTable: "state", signInTable: "signin", teamRecordTable, orgId: ORG })([priya, arjun]);
    // Positive control: the sign-in table is the one the reader reads, and it names both before the erase.
    db.set({ pk: `DEVELOPER#${priya}`, sk: "META", developerId: priya, displayName: REAL });
    expect(await names()).toEqual({ [priya]: REAL, [arjun]: "Arjun Shah" });
    await eraseChosenName(db, "state", priya, AT);
    expect(await names()).toEqual({ [priya]: FORMER_MEMBER, [arjun]: "Arjun Shah" });
  });

  it("with the record on, its own erased marker still counts", async () => {
    const db = world();
    db.set({ ...erasedPersonKey(ORG, { developerId: priya }), entityType: "TEAM_RECORD_ERASED", at: AT });
    expect(await auditActorNamesOf({ documentClient: db, stateTable: "state", signInTable: "signin", teamRecordTable: "state", orgId: ORG })([priya])).toEqual({ [priya]: FORMER_MEMBER });
  });
});

describe("what a person's erase runs", () => {
  const evidence = () => { const calls: string[] = []; return { calls, person: async (_org: unknown, id: string) => { calls.push(id); } }; };
  const eraser = () => { const calls: string[] = []; return { calls, erase: async (id: string) => { calls.push(id); } }; };

  it("erases the names where the Team record is off", async () => {
    const names = eraser(), proof = evidence();
    await personErasureStep(undefined, proof, names)(TEST_ORG, PRIYA);
    expect(names.calls).toEqual([PRIYA]);
    expect(proof.calls).toEqual([PRIYA]);
  });

  it("erases the names where the record is on, after its first pass, and also when the record's erase is unfinished (which is then repeated, and the evidence waits)", async () => {
    const order: string[] = [];
    const record = { erase: { person: async (): Promise<void> => { order.push("record"); throw new Error("unavailable"); } } };
    const names = { erase: async () => { order.push("names"); } };
    const proof = { person: async () => { order.push("evidence"); } };
    await expect(personErasureStep(record as never, proof as never, names)(TEST_ORG as never, PRIYA)).rejects.toThrow("unavailable");
    expect(order).toEqual(["record", "names"]);
    record.erase.person = async () => { order.push("record"); };
    await personErasureStep(record, proof, names)(TEST_ORG, PRIYA);
    expect(order).toEqual(["record", "names", "record", "names", "evidence"]);
  });

  it("the Team record's erase has a names step that runs the eraser for the person, and finishes without it where none is wired", async () => {
    const db = new FakeDynamoDb();
    const table = { documentClient: db, tableName: "state" } as never;
    const calls: string[] = [];
    const orgId = "org_aaaaaaaaaaaaaaaaaaaa" as never;
    const withNames = await erasePerson({ table, names: { erase: async (id) => { calls.push(id); } } }, orgId, { developerId: PRIYA, projects: [] }, "erase:test");
    expect(withNames.steps?.names).toBe(true);
    expect(calls).toEqual([PRIYA]);
    const without = await erasePerson({ table }, orgId, { developerId: PRIYA, projects: [] }, "erase:test2");
    expect(without.steps?.names).toBe(true);
    // A failure leaves the step unfinished: the next run repeats it.
    const failing = await erasePerson({ table, names: { erase: async () => { throw new Error("sign-in unavailable"); } } }, orgId, { developerId: PRIYA, projects: [] }, "erase:test3");
    expect(failing.steps?.names).toBe(false);
    expect(failing.complete).toBe(false);
  });
});

describe("a removed (not erased) person", () => {
  it("the removal deletes the name they chose before it, and what shows then is the sign-in record's name", async () => {
    const w = await removalWorld();
    await w.join(SAM, "Sam Signin", "member");
    w.db.set(nameItem(SAM, "Sam Chosen", new Date(T0 - HOUR).toISOString()));
    expect(await readChosenName(w.db, w.deps.tableName, SAM)).toBe("Sam Chosen");
    await w.remove(SAM);
    expect(w.db.get(chosenNameKey(SAM))).toBeUndefined();
    expect(await readChosenName(w.db, w.deps.tableName, SAM)).toBeUndefined();
    expect((await w.signInStore.getDeveloper(SAM))?.displayName).toBe("Sam Signin");
  });

  it("keeps a name chosen after the removal (a person who came back), and never touches an erase tombstone", async () => {
    const w = await removalWorld();
    await w.join(SAM, "Sam Signin", "member");
    const removedAt = new Date(T0).toISOString();
    w.db.set(nameItem(SAM, "Chosen After", new Date(T0 + HOUR).toISOString()));
    await deleteChosenNameOfRemoved(w.db, w.deps.tableName, SAM, removedAt);
    expect(await readChosenName(w.db, w.deps.tableName, SAM)).toBe("Chosen After");
    await eraseChosenName(w.db, w.deps.tableName, SAM, removedAt);
    await deleteChosenNameOfRemoved(w.db, w.deps.tableName, SAM, new Date(T0 + 24 * HOUR).toISOString());
    expect(w.db.get(chosenNameKey(SAM))).toMatchObject({ erased: true });
    // A repeat for a person with no name item is harmless.
    await deleteChosenNameOfRemoved(w.db, w.deps.tableName, hex("9"), removedAt);
  });

  it("a removal that runs again after a failure still deletes the name, and a finished removal is not run twice", async () => {
    const w = await removalWorld({ movers: "sweep" });
    await w.join(SAM, "Sam Signin", "member");
    w.db.set(nameItem(SAM, "Sam Chosen", new Date(T0 - HOUR).toISOString()));
    await w.remove(SAM);
    expect(w.markers()).toHaveLength(1);
    w.tick(60_000);
    expect(await w.sweep()).toMatchObject({ processed: 1, failed: 0 });
    expect(w.db.get(chosenNameKey(SAM))).toBeUndefined();
  });
});

void GetCommand; void onMemberRemoved;
