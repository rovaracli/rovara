// ERASED-REJOIN-NAME (DECISIONS #22, owner: "Yes, like Slack"): a person who was erased and rejoins may choose a NEW display name for the new membership. Their old history stays "A former member", the
// name they were erased under can't be chosen again to link it back, and the erasure tombstone stays in the name item (the new name is written beside it). The developer id is the same after a rejoin
// (it comes from the sign-in identity), so what tells the memberships apart is time: the new name's `chosenAt` is the day the new membership began.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { sessionEventId } from "@rovara-code/contracts";
import { ASK_RETENTION_DAYS } from "@rovara-code/contracts";
import { askAliasHashKey, erasedNameIsChosenAgain, readErasedAliases, rememberErasedAliases } from "../../packages/broker/src/agent-sessions/ask-erased-aliases.js";
import { appendSessionEvent, readSessionEvents } from "../../packages/broker/src/agent-sessions/events.js";
import { ownerNameOverlay, ownerNamedAt } from "../../packages/broker/src/agent-sessions/owner-names.js";
import { FORMER_MEMBER, auditActorNamesOf } from "../../packages/broker/src/audit/actor-names.js";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { FORMER_MEMBER_NAME, chosenNameKey, deleteChosenNameOfRemoved, eraseChosenName, readChosenNameState, readOwnChosenName } from "../../packages/broker/src/developer/chosen-name.js";
import { nameEraserOf } from "../../packages/broker/src/developer/erase-name.js";
import { forgetResolvedNames, nameResolverOf, replacementNames, resolveStoredName, scrubErasedNames, shownNameOf } from "../../packages/broker/src/developer/name-resolver.js";
import { createTaskComment, listTaskComments, setSuggestion, listSuggestions } from "../../packages/broker/src/developer/page-comments.js";
import { DeveloperSignInStore, NAME_WAS_ERASED_MESSAGE } from "../../packages/broker/src/developer/store.js";
import { resolveTaskAccess } from "../../packages/broker/src/developer/task-access.js";
import { ARJUN, ORG_A, PRIYA, sessionWorld } from "../support/agent-session-world.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { SAM, pagePlan, pageTask } from "../support/page-tasks.js";
import { TEST_ORG } from "../support/orgs.js";

const OLD = "Priya Rao";
const REAL = "Priya Realname";
const NEW = "Pri Newname";
const ERASED_AT = "2026-10-25T10:00:00.000Z";
const REJOINED_AT = "2026-11-02T10:00:00.000Z";
const NOW = Date.parse("2026-11-02T10:00:00.000Z");
const KEY = askAliasHashKey("test-signing-key-for-hashes");
const rejoinedItem = (developerId: string, name = NEW, chosenAt = REJOINED_AT) => ({ ...chosenNameKey(developerId), entityType: "DEVELOPER_NAME", developerId, erased: true, erasedAt: ERASED_AT, name, chosenAt });
const tombstoneItem = (developerId: string) => ({ ...chosenNameKey(developerId), entityType: "DEVELOPER_NAME", developerId, erased: true, erasedAt: ERASED_AT });

beforeEach(() => { forgetResolvedNames(); });

describe("choosing a name after an erase", () => {
  const profile = (displayName: string) => ({ developerId: PRIYA, provider: "cloud" as const, issuer: "https://idp.example.test", subject: "sub-p", displayName, email: "p@example.test" });
  function stores(nowMs = NOW, check?: (developerId: string, name: string) => Promise<boolean>) {
    const db = new FakeDynamoDb();
    const signIn = new DeveloperSignInStore({ documentClient: db, tableName: "signin", now: () => nowMs });
    const broker = new DeveloperSignInStore({ documentClient: db, tableName: "signin", nameTableName: "state", now: () => nowMs, ...(check === undefined ? {} : { erasedNameCheck: check }) });
    return { db, signIn, broker };
  }
  const table = (db: FakeDynamoDb) => ({ documentClient: db, tableName: "state" });

  it("is allowed, keeps the tombstone beside the new name, and a later sign-in never writes the provider's name back", async () => {
    const { db, signIn, broker } = stores();
    await signIn.upsertDeveloper(profile(REAL));
    await eraseChosenName(db, "state", PRIYA, ERASED_AT);
    await signIn.eraseDisplayName(PRIYA, ERASED_AT);
    expect((await broker.getDeveloper(PRIYA))?.displayName).toBe(FORMER_MEMBER_NAME);
    const record = await broker.setChosenDisplayName({ developerId: PRIYA, orgId: TEST_ORG, name: NEW });
    expect(record).toMatchObject({ displayName: NEW, displayNameChosen: true });
    // The tombstone is still there (kept, with its time), the new name and its time are beside it.
    expect(db.get(chosenNameKey(PRIYA))).toMatchObject({ erased: true, erasedAt: ERASED_AT, name: NEW, chosenAt: new Date(NOW).toISOString() });
    expect(await readChosenNameState(db, "state", PRIYA)).toEqual({ name: NEW, erased: false, erasedEver: true, rejoinedAt: new Date(NOW).toISOString() });
    // The sign-in record still holds the placeholder and its erase mark: the provider's name does not write back into old history.
    await signIn.upsertDeveloper(profile(REAL));
    const signInRecord = db.get({ pk: `DEVELOPER#${PRIYA}`, sk: "META" }) as { displayName: string; nameErasedAt: string };
    expect(signInRecord.nameErasedAt).toBe(ERASED_AT);
    expect(signInRecord.displayName).not.toBe(REAL);
    expect(JSON.stringify(db.get({ pk: `DEVELOPER#${PRIYA}`, sk: "META" }))).not.toContain(REAL);
    expect((await broker.getDeveloper(PRIYA))?.displayName).toBe(NEW);
  });

  it("refuses the name the person was erased under (kept only as keyed hashes), in any case, spacing or word order, and stores nothing", async () => {
    const { db, signIn, broker } = stores(NOW, (developerId, name) => erasedNameIsChosenAgain(table(db0), TEST_ORG, developerId, name, NOW, KEY));
    const db0 = db;
    await signIn.upsertDeveloper(profile(REAL));
    // The Asks step keeps the hashes of the names the person was known by (the chosen one and the sign-in one), then the names step writes the tombstone.
    await rememberErasedAliases(table(db), TEST_ORG, { developerId: PRIYA, names: [OLD, REAL] }, Date.parse(ERASED_AT), KEY);
    await eraseChosenName(db, "state", PRIYA, ERASED_AT);
    await signIn.eraseDisplayName(PRIYA, ERASED_AT);
    for (const same of [OLD, "  priya   RAO ", "RAO Priya", "Príya Rao", REAL, "priya realname"]) {
      await expect(broker.setChosenDisplayName({ developerId: PRIYA, orgId: TEST_ORG, name: same }), same).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining(NAME_WAS_ERASED_MESSAGE) as string });
    }
    // Nothing changed: still the bare tombstone, with no name in it.
    expect(db.get(chosenNameKey(PRIYA))).toEqual(tombstoneItem(PRIYA));
    expect(JSON.stringify(db.get(chosenNameKey(PRIYA)))).not.toContain("Priya");
    // A different name is accepted; the stored hashes hold none of the readable names.
    expect((await broker.setChosenDisplayName({ developerId: PRIYA, orgId: TEST_ORG, name: NEW })).displayName).toBe(NEW);
    expect(JSON.stringify(db.get(chosenNameKey(PRIYA)))).not.toContain(OLD);
  });

  it("refuses a one-word name that is one of the old name's words, accepts one that is not, and a name nobody kept is accepted", async () => {
    const check = (db: FakeDynamoDb) => (developerId: string, name: string) => erasedNameIsChosenAgain(table(db), TEST_ORG, developerId, name, NOW, KEY);
    const db = new FakeDynamoDb();
    await rememberErasedAliases(table(db), TEST_ORG, { developerId: PRIYA, names: [OLD] }, Date.parse(ERASED_AT), KEY);
    expect(await check(db)(PRIYA, "Priya")).toBe(true);
    expect(await check(db)(PRIYA, "Priya Jones")).toBe(false);
    expect(await check(db)(PRIYA, NEW)).toBe(false);
    // Another person's hashes say nothing about this person; no key, no check.
    expect(await check(db)(ARJUN, OLD)).toBe(false);
    expect(await erasedNameIsChosenAgain(table(db), TEST_ORG, PRIYA, OLD, NOW, undefined)).toBe(false);
    // The hashes are kept as long as the longest Ask (30 days); after that nothing is left to compare with.
    expect(await erasedNameIsChosenAgain(table(db), TEST_ORG, PRIYA, OLD, Date.parse(ERASED_AT) + (ASK_RETENTION_DAYS + 1) * 86_400_000, KEY)).toBe(false);
  });

  it("a name chosen while the erase lands is refused by the tombstone it did not read", async () => {
    const { db, broker, signIn } = stores();
    await signIn.upsertDeveloper(profile(REAL));
    await eraseChosenName(db, "state", PRIYA, ERASED_AT);
    const send = db.send.bind(db);
    // The erase is written again between the read and the write: the tombstone is no longer the one that was read.
    let swapped = false;
    db.send = ((command: Parameters<typeof send>[0]) => {
      if (!swapped && (command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") { swapped = true; db.set({ ...tombstoneItem(PRIYA), erasedAt: "2026-11-02T09:59:00.000Z" }); }
      return send(command);
    });
    await expect(broker.setChosenDisplayName({ developerId: PRIYA, orgId: TEST_ORG, name: NEW })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.get(chosenNameKey(PRIYA))).not.toHaveProperty("name");
  });
});

describe("renames, the second erase and the hashes", () => {
  const profile = (displayName: string) => ({ developerId: PRIYA, provider: "cloud" as const, issuer: "https://idp.example.test", subject: "sub-p", displayName, email: "p@example.test" });
  const DAY = 86_400_000;

  it("a rename keeps the day the new membership began: work from before the rename stays named by the new name", async () => {
    const clock = { now: NOW };
    const db = new FakeDynamoDb();
    const signIn = new DeveloperSignInStore({ documentClient: db, tableName: "signin", now: () => clock.now });
    const broker = new DeveloperSignInStore({ documentClient: db, tableName: "signin", nameTableName: "state", now: () => clock.now });
    await signIn.upsertDeveloper(profile(REAL));
    await eraseChosenName(db, "state", PRIYA, ERASED_AT);
    await broker.setChosenDisplayName({ developerId: PRIYA, orgId: TEST_ORG, name: NEW });
    const first = new Date(NOW).toISOString();
    clock.now += 5 * DAY;
    await broker.setChosenDisplayName({ developerId: PRIYA, orgId: TEST_ORG, name: "Pri Renamed" });
    expect(db.get(chosenNameKey(PRIYA))).toMatchObject({ erased: true, erasedAt: ERASED_AT, name: "Pri Renamed", chosenAt: new Date(clock.now).toISOString(), rejoinedAt: first });
    const replaced = await replacementNames({ documentClient: db, tableName: "state", orgId: TEST_ORG }, [PRIYA]);
    // A record from two days after the new membership began (before the rename) reads by the current name; one from before it is still "A former member".
    expect(shownNameOf(OLD, PRIYA, replaced, new Date(NOW + 2 * DAY).toISOString())).toBe("Pri Renamed");
    expect(shownNameOf(OLD, PRIYA, replaced, new Date(NOW - DAY).toISOString())).toBe(FORMER_MEMBER_NAME);
  });

  it("a second erase of a person who came back starts a fresh entry when the first expired, and the new hashes live a full term", async () => {
    const db = new FakeDynamoDb();
    const t = { documentClient: db, tableName: "state" };
    const first = Date.parse(ERASED_AT);
    await rememberErasedAliases(t, TEST_ORG, { developerId: PRIYA, names: [OLD] }, first, KEY);
    // The table's TTL has not removed the expired entry yet when the person, who came back as NEW, is erased again.
    const later = first + (ASK_RETENTION_DAYS + 3) * DAY;
    await rememberErasedAliases(t, TEST_ORG, { developerId: PRIYA, names: [NEW] }, later, KEY);
    expect(await erasedNameIsChosenAgain(t, TEST_ORG, PRIYA, NEW, later + DAY, KEY)).toBe(true);
    expect(await erasedNameIsChosenAgain(t, TEST_ORG, PRIYA, NEW, later + (ASK_RETENTION_DAYS - 1) * DAY, KEY)).toBe(true);
    // The expired entry's hashes were not carried over.
    expect(await erasedNameIsChosenAgain(t, TEST_ORG, PRIYA, OLD, later + DAY, KEY)).toBe(false);
    expect((await readErasedAliases(t, TEST_ORG, later + DAY)).length).toBe(1);
    // An entry still alive is merged and its term runs on from the later erase.
    const mid = later + 20 * DAY;
    await rememberErasedAliases(t, TEST_ORG, { developerId: PRIYA, names: ["Pri Third"] }, mid, KEY);
    expect(await erasedNameIsChosenAgain(t, TEST_ORG, PRIYA, NEW, mid + 25 * DAY, KEY)).toBe(true);
    expect(await erasedNameIsChosenAgain(t, TEST_ORG, PRIYA, "Pri Third", mid + 25 * DAY, KEY)).toBe(true);
  });

  it("an erase that lands on a bare tombstone after a name write read it makes that write fail; a name chosen between the erase's own two writes is erased", async () => {
    const db = new FakeDynamoDb();
    const signIn = new DeveloperSignInStore({ documentClient: db, tableName: "signin", now: () => NOW });
    const broker = new DeveloperSignInStore({ documentClient: db, tableName: "signin", nameTableName: "state", now: () => NOW });
    await signIn.upsertDeveloper(profile(REAL));
    db.set(tombstoneItem(PRIYA));
    const send = db.send.bind(db);
    let landed = false;
    db.send = ((command: Parameters<typeof send>[0]) => {
      if (!landed && (command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") { landed = true; return eraseChosenName(db, "state", PRIYA, "2026-11-02T10:00:00.000Z").then(() => send(command)); }
      return send(command);
    });
    await expect(broker.setChosenDisplayName({ developerId: PRIYA, orgId: TEST_ORG, name: NEW })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.get(chosenNameKey(PRIYA))).not.toHaveProperty("name");
    db.send = send;
    // Between the erase's two writes a name is chosen: the erase notices and erases over it.
    const db2 = new FakeDynamoDb();
    db2.set(tombstoneItem(PRIYA));
    const send2 = db2.send.bind(db2);
    db2.send = ((command: Parameters<typeof send2>[0]) => {
      if (command instanceof UpdateCommand) db2.set(rejoinedItem(PRIYA));
      return send2(command);
    });
    await eraseChosenName(db2, "state", PRIYA, "2026-11-03T00:00:00.000Z");
    expect(db2.get(chosenNameKey(PRIYA))).toEqual({ ...tombstoneItem(PRIYA), erasedAt: "2026-11-03T00:00:00.000Z" });
  });
});

describe("the eraser, the backfill and removal", () => {
  it("a repeated erase keeps the first time (the time the readers scope by); an erase of a person who came back erases the new name too", async () => {
    const db = new FakeDynamoDb();
    await eraseChosenName(db, "state", PRIYA, ERASED_AT);
    await eraseChosenName(db, "state", PRIYA, "2026-12-01T00:00:00.000Z");
    // The first time stands; the repeat is counted (`eraseRev`), which a name write in flight is conditioned on.
    expect(db.get(chosenNameKey(PRIYA))).toEqual({ ...tombstoneItem(PRIYA), eraseRev: 1 });
    db.set(rejoinedItem(PRIYA));
    expect(await readOwnChosenName(db, "state", PRIYA)).toBe(NEW);
    await eraseChosenName(db, "state", PRIYA, "2026-12-01T00:00:00.000Z");
    expect(db.get(chosenNameKey(PRIYA))).toEqual({ ...tombstoneItem(PRIYA), erasedAt: "2026-12-01T00:00:00.000Z" });
    expect(JSON.stringify(db.get(chosenNameKey(PRIYA)))).not.toContain(NEW);
  });

  it("the operator backfill still works: it tombstones a person who has a chosen name, clears the sign-in name, and leaves an earlier tombstone alone", async () => {
    const db = new FakeDynamoDb();
    const calls: string[] = [];
    const eraser = nameEraserOf({ documentClient: db, stateTable: "state", now: () => NOW, eraseSignInName: async (request) => { calls.push(request.developerId); return { ok: true }; } });
    db.set({ ...chosenNameKey(PRIYA), entityType: "DEVELOPER_NAME", developerId: PRIYA, name: OLD, chosenAt: "2026-10-01T00:00:00.000Z" });
    await eraser.erase(PRIYA);
    expect(db.get(chosenNameKey(PRIYA))).toEqual({ ...tombstoneItem(PRIYA), erasedAt: new Date(NOW).toISOString() });
    db.set(tombstoneItem(ARJUN));
    await eraser.erase(ARJUN);
    expect(db.get(chosenNameKey(ARJUN))).toMatchObject(tombstoneItem(ARJUN));
    expect(calls).toEqual([PRIYA, ARJUN]);
  });

  it("removing a person who came back removes the new name from storage, keeps the tombstone, and a removed person who was never erased still gets the marker", async () => {
    const db = new FakeDynamoDb();
    db.set(rejoinedItem(PRIYA));
    await deleteChosenNameOfRemoved(db, "state", PRIYA, "2026-11-05T00:00:00.000Z");
    expect(db.get(chosenNameKey(PRIYA))).toEqual(tombstoneItem(PRIYA));
    // A name chosen after the removal (a second rejoin) stays.
    db.set(rejoinedItem(PRIYA, NEW, "2026-11-09T00:00:00.000Z"));
    await deleteChosenNameOfRemoved(db, "state", PRIYA, "2026-11-05T00:00:00.000Z");
    expect(db.get(chosenNameKey(PRIYA))).toMatchObject({ name: NEW });
    db.set({ ...chosenNameKey(ARJUN), entityType: "DEVELOPER_NAME", developerId: ARJUN, name: "Arjun Chosen", chosenAt: "2026-10-01T00:00:00.000Z" });
    await deleteChosenNameOfRemoved(db, "state", ARJUN, "2026-11-05T00:00:00.000Z");
    expect(db.get(chosenNameKey(ARJUN))).toEqual({ ...chosenNameKey(ARJUN), entityType: "DEVELOPER_NAME", developerId: ARJUN, removed: true, removedAt: "2026-11-05T00:00:00.000Z" });
  });
});

describe("the resolver for a person who came back", () => {
  function world() {
    const db = new FakeDynamoDb();
    db.set(rejoinedItem(PRIYA));
    db.set(tombstoneItem(ARJUN));
    return db;
  }
  const deps = (db: FakeDynamoDb) => ({ documentClient: db, tableName: "state", orgId: TEST_ORG });

  it("reads a stored copy as 'A former member' unless it is from the new membership (on or after the day the new name was chosen), which reads as the new name; no time means the safe side", async () => {
    const db = world();
    const replaced = await replacementNames(deps(db), [PRIYA, ARJUN]);
    expect(replaced.get(PRIYA)).toBe(FORMER_MEMBER_NAME);
    expect(shownNameOf(OLD, PRIYA, replaced)).toBe(FORMER_MEMBER_NAME);
    expect(shownNameOf(OLD, PRIYA, replaced, "2026-10-01T00:00:00.000Z")).toBe(FORMER_MEMBER_NAME);
    expect(shownNameOf(OLD, PRIYA, replaced, "2026-11-02T09:59:59.999Z")).toBe(FORMER_MEMBER_NAME);
    expect(shownNameOf(OLD, PRIYA, replaced, "not a time")).toBe(FORMER_MEMBER_NAME);
    // From the new membership the NEW name shows, never the copy (which may be an old one on a surface that reads the event's time, not the copy's).
    expect(shownNameOf(OLD, PRIYA, replaced, REJOINED_AT)).toBe(NEW);
    expect(shownNameOf(OLD, PRIYA, replaced, Date.parse("2026-12-01T00:00:00.000Z"))).toBe(NEW);
    // A person who was erased and has not chosen a name stays "A former member" at any time.
    expect(shownNameOf(OLD, ARJUN, replaced, "2026-12-01T00:00:00.000Z")).toBe(FORMER_MEMBER_NAME);
    expect(await resolveStoredName(deps(db), PRIYA, OLD, "2026-12-01T00:00:00.000Z")).toBe(NEW);
    expect(await resolveStoredName(deps(db), PRIYA, OLD)).toBe(FORMER_MEMBER_NAME);
    // A list of the people who are here now shows the person by the name of the new membership (the record carries it), so the list leaves them out.
    expect([...replaced.currentOnly().keys()]).toEqual([ARJUN]);
  });

  it("blanks the old name out of words but never cuts the new name up when the old name is a word of it", () => {
    expect(scrubErasedNames(`Priya Rao asked Priya Rao Jones`, ["Priya Rao"], ["Priya Rao Jones"])).toBe(`${FORMER_MEMBER_NAME} asked Priya Rao Jones`);
    expect(scrubErasedNames(`Priya asked Priya Newname`, ["Priya"], ["Priya Newname"])).toBe(`${FORMER_MEMBER_NAME} asked Priya Newname`);
    expect(scrubErasedNames(`Priya Newname asked Priya`, ["Priya"])).toBe(`${FORMER_MEMBER_NAME} Newname asked ${FORMER_MEMBER_NAME}`);
  });

  it("an owner on a header or a tile reads by the time of its own record", async () => {
    const db = world();
    const overlay = await ownerNameOverlay({ documentClient: db, tableName: "state" }, [PRIYA, ARJUN], TEST_ORG);
    expect(ownerNamedAt({ developerId: PRIYA, name: OLD }, overlay, "2026-10-01T00:00:00.000Z").name).toBe(FORMER_MEMBER_NAME);
    expect(ownerNamedAt({ developerId: PRIYA, name: OLD }, overlay, "2026-11-03T00:00:00.000Z").name).toBe(NEW);
    expect(ownerNamedAt({ developerId: PRIYA, name: OLD }, overlay).name).toBe(FORMER_MEMBER_NAME);
    expect(ownerNamedAt({ developerId: ARJUN, name: "Arjun Real" }, overlay, "2026-12-01T00:00:00.000Z").name).toBe(FORMER_MEMBER_NAME);
  });
});

describe("the conversation timeline for a person who came back", () => {
  it("reads 'A former member' for everything before the new membership, in the actor and in other people's words, and the new name after, kept whole", async () => {
    const w = sessionWorld();
    const deps = { documentClient: w.db, tableName: "state", now: () => Date.parse("2026-11-04T00:00:00.000Z"), projectMembers: w.members, signInStore: w.signInStore };
    const { sessionId } = w.seedSession();
    const event = (name: string, at: string, actor: { developerId: string; name: string }, text: string) =>
      appendSessionEvent(deps, ORG_A, sessionId, { eventId: sessionEventId(name, name), at, type: "status", actor: { kind: "member", ...actor }, text });
    await event("a", "2026-10-22T10:00:00.000Z", { developerId: PRIYA, name: OLD }, `${OLD} started Rovara Code`);
    await event("b", "2026-10-22T10:00:01.000Z", { developerId: ARJUN, name: "Arjun Real" }, `Arjun Real took over from ${OLD}.`);
    await event("c", "2026-11-03T10:00:00.000Z", { developerId: PRIYA, name: NEW }, `${NEW} commented.`);
    await event("d", "2026-11-03T10:00:01.000Z", { developerId: ARJUN, name: "Arjun Real" }, `Arjun Real asked ${NEW} about ${OLD}.`);
    w.db.set(rejoinedItem(PRIYA));
    const read = (await readSessionEvents(deps, w.caller(PRIYA), sessionId, {})).events;
    const byId = (name: string) => read.find((entry) => entry.eventId === sessionEventId(name, name))!;
    expect(byId("a")).toMatchObject({ actor: { name: FORMER_MEMBER_NAME }, text: `${FORMER_MEMBER_NAME} started Rovara Code` });
    expect(byId("b")).toMatchObject({ actor: { name: "Arjun Real" }, text: `Arjun Real took over from ${FORMER_MEMBER_NAME}.` });
    expect(byId("c")).toMatchObject({ actor: { name: NEW }, text: `${NEW} commented.` });
    expect(byId("d")).toMatchObject({ text: `Arjun Real asked ${NEW} about ${FORMER_MEMBER_NAME}.` });
    expect(JSON.stringify(read)).not.toContain(OLD);
  });
});

describe("comments and suggestions for a person who came back", () => {
  it("show the earlier ones as 'A former member' and the later ones by the new name", async () => {
    const fixture = pageTask();
    fixture.addVersion("plan", pagePlan());
    const before = { ...await resolveTaskAccess(fixture.deps, SAM, fixture.taskId), caller: SAM };
    await createTaskComment(fixture.deps, before, { requestId: randomUUID(), document: "plan", version: 1, target: { kind: "claim", id: "2.1" }, text: "Above reads better.", ask: false });
    await setSuggestion(fixture.deps, before, { document: "plan", decisionId: "d1", optionId: "above" });
    const erasedAt = new Date(START_PLUS(1)).toISOString();
    const chosenAt = new Date(START_PLUS(2)).toISOString();
    fixture.db.set({ ...chosenNameKey(SAM.developerId), entityType: "DEVELOPER_NAME", developerId: SAM.developerId, erased: true, erasedAt, name: NEW, chosenAt });
    fixture.advance(3 * 3_600_000);
    const sam = { ...SAM, name: NEW };
    const after = { ...await resolveTaskAccess(fixture.deps, sam, fixture.taskId), caller: sam };
    await createTaskComment(fixture.deps, after, { requestId: randomUUID(), document: "plan", version: 1, target: { kind: "claim", id: "2.1" }, text: "Back again.", ask: false });
    expect((await listSuggestions(fixture.deps, fixture.taskId, TEST_ORG)).map((entry) => entry.name)).toEqual([FORMER_MEMBER_NAME]);
    await setSuggestion(fixture.deps, after, { document: "plan", decisionId: "d1", optionId: "above" });
    const comments = (await listTaskComments(fixture.deps, fixture.taskId, TEST_ORG)).map((entry) => (entry.author.kind === "person" ? entry.author.name : ""));
    expect(comments).toEqual([FORMER_MEMBER_NAME, NEW]);
    expect(JSON.stringify(await listTaskComments(fixture.deps, fixture.taskId))).not.toContain("Sam Lee");
    // The suggestion is the person's one per decision: made again after the rejoin, it carries the new time and reads by the new name.
    expect((await listSuggestions(fixture.deps, fixture.taskId, TEST_ORG)).map((entry) => entry.name)).toEqual([NEW]);
  });
});

describe("the audit page for a person who came back", () => {
  it("names them 'A former member' for every record (the page carries no time per name: the safe side), also with the Team record on", async () => {
    const db = new FakeDynamoDb();
    db.set(rejoinedItem(PRIYA));
    db.set({ pk: `DEVELOPER#${PRIYA}`, sk: "META", developerId: PRIYA, displayName: REAL });
    for (const teamRecordTable of [undefined, "state"]) {
      expect(await auditActorNamesOf({ documentClient: db, stateTable: "state", signInTable: "signin", teamRecordTable, orgId: TEST_ORG })([PRIYA])).toEqual({ [PRIYA]: FORMER_MEMBER });
    }
  });
});

describe("a plain resolver check", () => {
  it("nameResolverOf keeps working with the new class", async () => {
    const db = new FakeDynamoDb();
    db.set(rejoinedItem(PRIYA));
    const replaced = await replacementNames(nameResolverOf({ documentClient: db, tableName: "state" }, TEST_ORG), [PRIYA]);
    expect(replaced.rejoinedAs.get(PRIYA)).toBe(NEW);
    expect(replaced.rejoinedAt.get(PRIYA)).toBe(REJOINED_AT);
  });
});

function START_PLUS(hours: number): number { return Date.parse("2026-10-11T10:00:00.000Z") + hours * 3_600_000; }
