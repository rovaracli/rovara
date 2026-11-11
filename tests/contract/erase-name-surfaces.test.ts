// ERASE-NAME-2: every surface that shows a name stored with the work (a task, a comment, a suggestion, a session, a notice, an index row) resolves it through the one rule in
// developer/name-resolver.ts: an erased person reads "A former member" (the name item's tombstone, or the audit ledger's tombstone for people erased before the name item had one), a removed person
// is never shown by the name they chose (the removal marker), and a person who came back is shown as before. Each surface has a positive control (the stored name shows before) and is checked for
// an erased and a removed person. The ledger's tombstone lives in the keys table; here it is a second table name in the one fake database (the keys do not collide).
import { randomUUID } from "node:crypto";
import { BatchGetCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentSessionKey, sessionEventId } from "@rovara-code/contracts";
import { orgMemberKey } from "@agentx/cloud-contracts";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { orgFailureIndexKey, orgUsageIndexKey } from "@rovara-code/contracts";
import { chosenOwnerNames, ownerNameOverlay } from "../../packages/broker/src/agent-sessions/owner-names.js";
import { ensureTaskSession } from "../../packages/broker/src/agent-sessions/create.js";
import { requireSessionLevel } from "../../packages/broker/src/agent-sessions/access.js";
import { aliasHashesOf, askAliasHashKey, readErasedAliases } from "../../packages/broker/src/agent-sessions/ask-erased-aliases.js";
import { appendSessionEvent, readSessionEvents } from "../../packages/broker/src/agent-sessions/events.js";
import { erasePerson } from "../../packages/broker/src/team-record/erase.js";
import { NAME_ERASED_MESSAGE } from "../../packages/broker/src/developer/store.js";
import { listSessionMessages, sendSessionMessage, type SessionMessageDependencies } from "../../packages/broker/src/agent-sessions/messages.js";
import { planWhyEntries } from "../../packages/broker/src/aws/developer-tasks/thread-notes.js";
import { savedByName } from "../../packages/broker/src/aws/developer-routes/settings-proof.js";
import { runOfApproval } from "../../packages/broker/src/agents/approvals-store.js";
import { listSuggestions, listTaskComments, setSuggestion } from "../../packages/broker/src/developer/page-comments.js";
import { FORMER_MEMBER_NAME, chosenNameKey, eraseChosenName, readOwnChosenName } from "../../packages/broker/src/developer/chosen-name.js";
import { UNAVAILABLE_NAME, erasedNamesOnPage, forgetResolvedNames, replacementNames, resolveStoredName, scrubErasedNames } from "../../packages/broker/src/developer/name-resolver.js";
import { placeholderDisplayName } from "../../packages/broker/src/developer/person-name.js";
import { resolveTaskAccess } from "../../packages/broker/src/developer/task-access.js";
import { createTaskComment } from "../../packages/broker/src/developer/page-comments.js";
import { createAdminReadBroker } from "../support/admin-read-broker.js";
import { MAYA } from "../support/developer-task-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { SAM, pagePlan, pageTask } from "../support/page-tasks.js";
import { ARJUN, ORG_A, PRIYA, sessionWorld } from "../support/agent-session-world.js";
import { TEST_ORG } from "../support/orgs.js";

const REAL = "Priya Realname";
const CHOSEN = "Priya Chosen";
const KEYS = "keys";
const AT = "2026-10-22T10:00:00.000Z";
const hex = (digit: string) => digit.repeat(64);
const nameItem = (developerId: string, name = CHOSEN) => ({ ...chosenNameKey(developerId), entityType: "DEVELOPER_NAME", developerId, name, chosenAt: "2026-10-01T00:00:00.000Z" });
const removedItem = (developerId: string) => ({ ...chosenNameKey(developerId), entityType: "DEVELOPER_NAME", developerId, removed: true, removedAt: "2026-10-15T00:00:00.000Z" });
const ledgerTombstone = (db: FakeDynamoDb, orgId: string, developerId: string) => db.set({ pk: `ORG#${orgId}`, sk: `SUBJECT#${developerId}`, erasedAt: "2026-09-01T00:00:00.000Z" });
const sent = (db: FakeDynamoDb) => { const commands: unknown[] = []; return { commands, client: { send: (command: never) => { commands.push(command); return db.send(command); } } }; };

beforeEach(() => { forgetResolvedNames(); });

describe("the resolver", () => {
  const ids = { erased: hex("1"), ledger: hex("2"), removed: hex("3"), back: hex("4"), plain: hex("5") };
  function world() {
    const db = new FakeDynamoDb();
    db.set(nameItem(ids.erased));
    db.set({ ...chosenNameKey(ids.erased), entityType: "DEVELOPER_NAME", developerId: ids.erased, erased: true, erasedAt: AT });
    ledgerTombstone(db, TEST_ORG, ids.ledger);
    db.set(removedItem(ids.removed));
    db.set(removedItem(ids.back)); db.set({ ...orgMemberKey(TEST_ORG, ids.back), orgId: TEST_ORG, developerId: ids.back, role: "member" });
    db.set(nameItem(ids.plain));
    db.set({ pk: `DEVELOPER#${ids.removed}`, sk: "META", developerId: ids.removed, displayName: "Rena Signin" });
    return db;
  }
  const deps = (db: FakeDynamoDb, extra: Record<string, unknown> = {}) => ({ documentClient: db, tableName: "state", orgId: TEST_ORG, keysTable: KEYS, ...extra });

  it("says who is replaced and by what: erased by the name item, erased by the ledger only, removed (sign-in name, else placeholder), and nobody else", async () => {
    const db = world();
    const replaced = await replacementNames(deps(db, { signInTable: "signin" }), Object.values(ids));
    expect(Object.fromEntries(replaced)).toEqual({
      [ids.erased]: FORMER_MEMBER_NAME, [ids.ledger]: FORMER_MEMBER_NAME, [ids.removed]: "Rena Signin",
    });
    // Without a sign-in table a removed person reads as the placeholder.
    forgetResolvedNames();
    expect((await replacementNames(deps(db), [ids.removed])).get(ids.removed)).toBe(placeholderDisplayName(ids.removed));
    // A person with a stale marker who is a member again, and one who chose a name, keep their stored copy.
    expect(replaced.has(ids.back)).toBe(false);
    expect(replaced.has(ids.plain)).toBe(false);
  });

  it("without the company it reads the name item alone, and the ledger is not asked", async () => {
    const db = world();
    const recorder = sent(db);
    const replaced = await replacementNames({ documentClient: recorder.client, tableName: "state", keysTable: KEYS }, [ids.ledger, ids.erased]);
    expect([...replaced.keys()]).toEqual([ids.erased]);
    expect(recorder.commands.filter((command) => command instanceof GetCommand)).toHaveLength(0);
  });

  it("reads many people with one BatchGetItem and one ledger read each, and keeps a 'no' for a moment", async () => {
    const db = world();
    const many = Array.from({ length: 30 }, (_, index) => `p${String(index).padStart(2, "0")}`);
    const recorder = sent(db);
    await replacementNames({ ...deps(db), documentClient: recorder.client }, many);
    expect(recorder.commands.filter((command) => command instanceof BatchGetCommand)).toHaveLength(1);
    expect(recorder.commands.filter((command) => command instanceof GetCommand)).toHaveLength(30);
    await replacementNames({ ...deps(db), documentClient: recorder.client }, many);
    expect(recorder.commands.filter((command) => command instanceof GetCommand)).toHaveLength(30);
  });

  it("treats a person the ledger erased as erased WITHOUT writing: the chosen name stays until the erase's own names step (after the Asks hashes) has read it", async () => {
    const db = world();
    db.set(nameItem(ids.ledger));
    const recorder = sent(db);
    // The gap: the ledger says erased, the Asks step has not hashed the name yet, and a page is read.
    const replaced = await replacementNames({ ...deps(db), documentClient: recorder.client }, [ids.ledger]);
    expect(replaced.get(ids.ledger)).toBe(FORMER_MEMBER_NAME);
    // ... so the name is not shown, and the name item is untouched: the erase can still read and hash it.
    expect(db.get(chosenNameKey(ids.ledger))).toMatchObject({ name: CHOSEN });
    expect(db.get(chosenNameKey(ids.ledger))).not.toHaveProperty("erased");
    expect(recorder.commands.filter((command) => !(command instanceof GetCommand) && !(command instanceof BatchGetCommand))).toEqual([]);
    expect(await readOwnChosenName(db, "state", ids.ledger)).toBe(CHOSEN);
  });

  it("shows a generic name, not the stored one, when a read fails, and logs the failure without a name", async () => {
    const db = world();
    const failing = { send: async () => { throw new Error("unavailable"); } };
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      expect([...await replacementNames({ ...deps(db), documentClient: failing }, [ids.erased])]).toEqual([[ids.erased, UNAVAILABLE_NAME]]);
      expect(await resolveStoredName({ ...deps(db), documentClient: failing }, ids.erased, REAL)).toBe(UNAVAILABLE_NAME);
    } finally {
      log.mockRestore();
    }
    expect(lines.some((line) => line.includes("name_resolver_unavailable"))).toBe(true);
    expect(lines.join("\n")).not.toContain(REAL);
    // A ledger read that fails for one person leaves that person generic, and the others settled.
    forgetResolvedNames();
    const ledgerKeyOf = (command: unknown): string | undefined => (command instanceof GetCommand ? (command.input.Key as { sk?: string } | undefined)?.sk : undefined);
    const flaky = { send: (command: never) => (ledgerKeyOf(command) === `SUBJECT#${ids.plain}` ? Promise.reject(new Error("throttled")) : db.send(command)) };
    const quiet = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const replaced = await replacementNames({ ...deps(db), documentClient: flaky }, [ids.plain, ids.ledger]);
      expect(Object.fromEntries(replaced)).toEqual({ [ids.plain]: UNAVAILABLE_NAME, [ids.ledger]: FORMER_MEMBER_NAME });
    } finally {
      quiet.mockRestore();
    }
  });
});

describe("blanking an erased person's stored name out of words other people wrote", () => {
  it("replaces exact whole-word occurrences of the erased actors' names only, and skips generic words, placeholders and short names", () => {
    const replaced = new Map([["a", FORMER_MEMBER_NAME], ["b", FORMER_MEMBER_NAME], ["c", FORMER_MEMBER_NAME], ["d", FORMER_MEMBER_NAME], ["e", UNAVAILABLE_NAME]]);
    const names = erasedNamesOnPage([
      { developerId: "a", name: "Priya Realname" }, { developerId: "b", name: "Someone" }, { developerId: "c", name: placeholderDisplayName(hex("c")) }, { developerId: "d", name: "Al" },
      { developerId: "e", name: "Eve Failure" }, { developerId: "z", name: "Zed Bystander" },
    ], replaced);
    expect(names).toEqual(["Priya Realname"]);
    expect(scrubErasedNames("Omar took over from Priya Realname. Priya Realnames stays; priya realname too; Someone helped.", names)).toBe(`Omar took over from ${FORMER_MEMBER_NAME}. Priya Realnames stays; priya realname too; Someone helped.`);
  });
});

describe("the thread notes a plan quotes (Slack notes sent to the model)", () => {
  const task = (db: FakeDynamoDb, developerId: string) => ({ taskId: randomUUID(), orgId: TEST_ORG, developerId, developerName: REAL, requestText: "Fix the retry bug", threadNotesFedFrom: undefined, threadNotesFedThrough: undefined } as never);
  it("credits the request to the stored name before, to 'A former member' once erased, and not to the chosen name once removed", async () => {
    const db = new FakeDynamoDb();
    const id = hex("a");
    const authors = async () => (await planWhyEntries({ documentClient: db, tableName: "state" }, task(db, id), [])).map((entry) => entry.author);
    expect(await authors()).toEqual([REAL]);
    db.set(removedItem(id));
    // The placeholder is no name for a plan: it reads "the task owner", as for a person with no name.
    expect(await authors()).toEqual(["the task owner"]);
    db.set({ ...chosenNameKey(id), entityType: "DEVELOPER_NAME", developerId: id, erased: true, erasedAt: AT });
    expect(await authors()).toEqual([FORMER_MEMBER_NAME]);
  });

  it("covers a person erased before the name item had a tombstone (the ledger's)", async () => {
    const db = new FakeDynamoDb();
    const id = hex("b");
    ledgerTombstone(db, TEST_ORG, id);
    const entries = await planWhyEntries({ documentClient: db, tableName: "state" }, task(db, id), []);
    process.env["AUDIT_KEYS_TABLE_NAME"] = KEYS;
    try {
      forgetResolvedNames();
      expect((await planWhyEntries({ documentClient: db, tableName: "state" }, task(db, id), [])).map((entry) => entry.author)).toEqual([FORMER_MEMBER_NAME]);
    } finally {
      delete process.env["AUDIT_KEYS_TABLE_NAME"];
    }
    expect(entries.map((entry) => entry.author)).toEqual([REAL]);
  });
});

describe("the task page's comments and suggestions", () => {
  async function commented() {
    const fixture = pageTask();
    fixture.addVersion("plan", pagePlan());
    const access = { ...await resolveTaskAccess(fixture.deps, SAM, fixture.taskId), caller: SAM };
    await createTaskComment(fixture.deps, access, { requestId: randomUUID(), document: "plan", version: 1, target: { kind: "claim", id: "2.1" }, text: "Above reads better.", ask: false });
    await setSuggestion(fixture.deps, access, { document: "plan", decisionId: "d1", optionId: "above" });
    return fixture;
  }
  const names = async (fixture: Awaited<ReturnType<typeof commented>>) => ({
    comment: (await listTaskComments(fixture.deps, fixture.taskId, TEST_ORG)).map((entry) => (entry.author.kind === "person" ? entry.author.name : "")),
    suggestion: (await listSuggestions(fixture.deps, fixture.taskId, TEST_ORG)).map((entry) => entry.name),
  });

  it("show the stored name, then 'A former member' for an erased person and the placeholder for a removed one", async () => {
    const fixture = await commented();
    expect(await names(fixture)).toEqual({ comment: ["Sam Lee"], suggestion: ["Sam Lee"] });
    fixture.db.set(removedItem(SAM.developerId));
    expect(await names(fixture)).toEqual({ comment: [placeholderDisplayName(SAM.developerId)], suggestion: [placeholderDisplayName(SAM.developerId)] });
    fixture.db.set({ ...chosenNameKey(SAM.developerId), entityType: "DEVELOPER_NAME", developerId: SAM.developerId, erased: true, erasedAt: AT });
    expect(await names(fixture)).toEqual({ comment: [FORMER_MEMBER_NAME], suggestion: [FORMER_MEMBER_NAME] });
    expect(JSON.stringify(await listTaskComments(fixture.deps, fixture.taskId))).not.toContain("Sam Lee");
  });

  it("leave someone else's comments alone, and a comment's words are not rewritten", async () => {
    const fixture = await commented();
    fixture.db.set({ ...chosenNameKey(hex("9")), entityType: "DEVELOPER_NAME", developerId: hex("9"), erased: true, erasedAt: AT });
    expect(await names(fixture)).toEqual({ comment: ["Sam Lee"], suggestion: ["Sam Lee"] });
  });
});

describe("the admin reads", () => {
  const failure = (endedAt: string, requester: unknown) => {
    const operationId = "11111111-1111-4111-8111-111111111111";
    return {
      ...orgFailureIndexKey(TEST_ORG, endedAt, operationId), entityType: "FAILURE_INDEX", operationId, workspaceId: "22222222-2222-4222-8222-222222222222",
      project: "payments", origin: "ai_tool", requester, kind: "task", status: "FAILED", category: "task_failed", error: "npm test exited 1", endedAt,
    };
  };
  const usage = (at: string, requester: unknown) => {
    const operationId = "11111112-1111-4111-8111-111111111111";
    return {
      ...orgUsageIndexKey(TEST_ORG, at, operationId), entityType: "USAGE_INDEX", operationId, workspaceId: "22222222-2222-4222-8222-222222222222", project: "payments", origin: "ai_tool",
      requester, at, durationMs: 60_000, inputTokens: 1_000, outputTokens: 100, costUsd: 0.5,
    };
  };
  const requester = { kind: "developer", developerId: MAYA.developerId, provider: "slack", name: REAL };

  it("shows the requester of a failure and of usage by the stored name, then replaced once erased", async () => {
    const { db, admin } = await createAdminReadBroker();
    const at = new Date(Date.now() - 3_600_000).toISOString();
    db.set(failure(at, requester));
    db.set(usage(at, requester));
    const failureName = async () => ((await admin("GET", "/v1/admin/failures")).body.failures as Array<{ requester: { name?: string } }>)[0]!.requester.name;
    const usageKeys = async () => ((await admin("GET", "/v1/admin/usage?group_by=requester")).body.groups as Array<{ key: string }>).map((group) => group.key);
    expect(await failureName()).toBe(REAL);
    expect(await usageKeys()).toEqual([`developer:${REAL} (${MAYA.developerId.slice(0, 8)})`]);
    db.set({ ...chosenNameKey(MAYA.developerId), entityType: "DEVELOPER_NAME", developerId: MAYA.developerId, erased: true, erasedAt: AT });
    expect(await failureName()).toBe(FORMER_MEMBER_NAME);
    expect(await usageKeys()).toEqual([`developer:${FORMER_MEMBER_NAME} (${MAYA.developerId.slice(0, 8)})`]);
  });

  it("shows a workspace's owner by the task's stored name, then replaced once erased", async () => {
    const harness = await createAdminReadBroker();
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
    expect(started.status).toBeLessThan(300);
    const owner = async () => ((await harness.admin("GET", "/v1/admin/workspaces")).body.workspaces as Array<{ owner: { developerName?: string } }>)[0]!.owner.developerName;
    expect(await owner()).toBe("Maya Chen");
    harness.db.set({ ...chosenNameKey(MAYA.developerId), entityType: "DEVELOPER_NAME", developerId: MAYA.developerId, erased: true, erasedAt: AT });
    expect(await owner()).toBe(FORMER_MEMBER_NAME);
  });
});

describe("sessions", () => {
  it("does not store a fresh copy of an erased person's name when a task is given its session", async () => {
    const w = sessionWorld();
    const { sessionId: seeded, taskId } = w.seedSession();
    w.db.delete(agentSessionKey(ORG_A, seeded, "META"));
    const { sessionId: _gone, ...rest } = w.db.get(taskKey(taskId))!; // eslint-disable-line @typescript-eslint/no-unused-vars -- the task has none
    const full = { ...rest, agent: { agentId: "rovara-code", name: "Rovara Code", version: 3, builtin: true }, origin: "app", title: "Bump the Stripe SDK", startedBy: { developerId: PRIYA }, payer: { kind: "member", developerId: PRIYA }, createdAt: "2026-10-20T08:00:00.000Z" };
    w.db.set(full);
    w.db.set({ ...chosenNameKey(PRIYA), entityType: "DEVELOPER_NAME", developerId: PRIYA, erased: true, erasedAt: AT });
    const id = await ensureTaskSession({ documentClient: w.db, tableName: "state", now: () => w.clock.now }, full as never, { ownerName: REAL, title: "Bump the Stripe SDK" });
    expect(id).toMatch(/^ses_/);
    const stored = w.db.get(agentSessionKey(ORG_A, id as never, "META")) as { owner: { name: string } };
    expect(stored.owner.name).toBe(FORMER_MEMBER_NAME);
    expect(JSON.stringify(w.db.find(() => true))).not.toContain(REAL);
  });

  it("stores the name as given for a person who was not erased (a positive control)", async () => {
    const w = sessionWorld();
    const { sessionId: seeded, taskId } = w.seedSession();
    w.db.delete(agentSessionKey(ORG_A, seeded, "META"));
    const { sessionId: _gone, ...rest } = w.db.get(taskKey(taskId))!; // eslint-disable-line @typescript-eslint/no-unused-vars -- the task has none
    const full = { ...rest, agent: { agentId: "rovara-code", name: "Rovara Code", version: 3, builtin: true }, origin: "app", title: "Bump the Stripe SDK", startedBy: { developerId: PRIYA }, payer: { kind: "member", developerId: PRIYA }, createdAt: "2026-10-20T08:00:00.000Z" };
    w.db.set(full);
    const id = await ensureTaskSession({ documentClient: w.db, tableName: "state", now: () => w.clock.now }, full as never, { ownerName: REAL, title: "Bump the Stripe SDK" });
    expect((w.db.get(agentSessionKey(ORG_A, id as never, "META")) as { owner: { name: string } }).owner.name).toBe(REAL);
  });

  it("lists a message's author as stored, then replaced for an erased person and for a removed one", async () => {
    const w = sessionWorld();
    const deps = { documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members } as unknown as SessionMessageDependencies;
    const made = w.seedSession();
    const sid = (made.record as unknown as { sessionId: string }).sessionId;
    const author = async () => (await listSessionMessages(deps, w.caller(ARJUN), sid, {})).messages.map((message) => message.author.name);
    await sendSessionMessage(deps, w.caller(PRIYA), sid, { requestId: randomUUID(), kind: "comment", text: "Looks right to me." } as never);
    const stored = (await author())[0]!;
    expect(stored).not.toBe(FORMER_MEMBER_NAME);
    // A removal marker of a person who is still a member is old (they came back): the stored name stands.
    w.db.set(removedItem(PRIYA));
    expect(await author()).toEqual([stored]);
    w.db.delete(orgMemberKey(ORG_A, PRIYA));
    expect(await author()).toEqual([placeholderDisplayName(PRIYA)]);
    w.db.set({ ...chosenNameKey(PRIYA), entityType: "DEVELOPER_NAME", developerId: PRIYA, erased: true, erasedAt: AT });
    expect(await author()).toEqual([FORMER_MEMBER_NAME]);
    // Someone else's message is not touched.
    w.db.set({ ...chosenNameKey(ARJUN), entityType: "DEVELOPER_NAME", developerId: ARJUN, name: "Arjun Chosen", chosenAt: "2026-10-01T00:00:00.000Z" });
    expect(await author()).toEqual([FORMER_MEMBER_NAME]);
  });

  it("names a removed owner by the placeholder in the header, never the name stored from when they had chosen one", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession({ owner: PRIYA });
    const meta = w.db.get(agentSessionKey(ORG_A, sessionId, "META"))!;
    w.db.set({ ...meta, owner: { developerId: PRIYA, name: CHOSEN } });
    const names = async () => [...(await chosenOwnerNames({ documentClient: w.db, tableName: "state" }, [PRIYA], ORG_A)).values()];
    expect(await names()).toEqual([]);
    w.db.delete(orgMemberKey(ORG_A, PRIYA));
    w.db.set(removedItem(PRIYA));
    expect(await names()).toEqual([placeholderDisplayName(PRIYA)]);
    // They came back: the marker is old, and the stored copy stands.
    w.db.set({ ...orgMemberKey(ORG_A, PRIYA), orgId: ORG_A, developerId: PRIYA, role: "member" });
    expect(await names()).toEqual([]);
  });

  it("covers a person the ledger erased before the name item had a tombstone, in headers and events", async () => {
    const w = sessionWorld();
    const ghost = hex("7");
    ledgerTombstone(w.db, ORG_A, ghost);
    process.env["AUDIT_KEYS_TABLE_NAME"] = KEYS;
    try {
      const overlay = await ownerNameOverlay({ documentClient: w.db, tableName: "state" }, [ghost], ORG_A);
      expect(overlay.replaced.get(ghost)).toBe(FORMER_MEMBER_NAME);
    } finally {
      delete process.env["AUDIT_KEYS_TABLE_NAME"];
    }
  });
});

describe("the settings proof's 'saved by' notice", () => {
  it("names who saved by the stored name, then 'A former member' once erased and the placeholder once removed", async () => {
    const db = new FakeDynamoDb();
    const by = hex("c");
    const deps = { documentClient: db as never, tableName: "state", developer: { signInTableName: "signin" } } as never;
    const saved = { by, byName: REAL };
    expect(await savedByName(deps, TEST_ORG as never, saved)).toBe(REAL);
    db.set(removedItem(by));
    db.set({ pk: `DEVELOPER#${by}`, sk: "META", developerId: by, displayName: "Cy Signin" });
    expect(await savedByName(deps, TEST_ORG as never, saved)).toBe("Cy Signin");
    db.set({ ...chosenNameKey(by), entityType: "DEVELOPER_NAME", developerId: by, erased: true, erasedAt: AT });
    expect(await savedByName(deps, TEST_ORG as never, saved)).toBe(FORMER_MEMBER_NAME);
    expect(await savedByName(deps, TEST_ORG as never, { byName: REAL })).toBe(REAL);
  });
});

describe("the owner shown on an approval, for an erased and a removed owner", () => {
  it("replaces the stored owner name in the run's owner, the way the refusal text names them", async () => {
    const db = new FakeDynamoDb();
    const owner = hex("d");
    const record = { kind: "step", orgId: TEST_ORG, project: "payments", subject: { kind: "agent_run", taskId: randomUUID(), stepId: "work" }, owner: { developerId: owner, name: CHOSEN } } as never;
    const deps = { documentClient: db as never, tableName: "state" };
    expect((await runOfApproval(deps, record))?.owner.name).toBe(CHOSEN);
    db.set(removedItem(owner));
    expect((await runOfApproval(deps, record))?.owner.name).toBe(placeholderDisplayName(owner));
    db.set({ ...chosenNameKey(owner), entityType: "DEVELOPER_NAME", developerId: owner, erased: true, erasedAt: AT });
    expect((await runOfApproval(deps, record))?.owner.name).toBe(FORMER_MEMBER_NAME);
  });
});

describe("the erase's order: the chosen name is hashed before anything destroys it", () => {
  it("a page read between the ledger's tombstone and the Asks step shows 'A former member', destroys nothing, and the Asks step then keeps the hash of the chosen name", async () => {
    const orgId = "org_aaaaaaaaaaaaaaaaaaaa" as const;
    const db = new FakeDynamoDb();
    const person = hex("7");
    db.set(nameItem(person, CHOSEN));
    db.set({ pk: `ORG#${orgId}`, sk: `SUBJECT#${person}`, erasedAt: AT });
    // The page read.
    const replaced = await replacementNames({ documentClient: db, tableName: "state", orgId, keysTable: KEYS }, [person]);
    expect(replaced.get(person)).toBe(FORMER_MEMBER_NAME);
    expect(db.get(chosenNameKey(person))).toMatchObject({ name: CHOSEN });
    // The record's erase: the Asks step reads the chosen name and keeps its keyed hash, and only then does the names step run.
    const key = askAliasHashKey("k".repeat(40));
    const erased: string[] = [];
    const table = { documentClient: db, tableName: "state" } as never;
    const result = await erasePerson({ table, askAliasKey: key, names: { erase: async (id: string) => { erased.push(id); await eraseChosenName(db, "state", id, AT); } } }, orgId, { developerId: person, projects: [], names: [REAL] }, "erase:gap");
    expect(result.steps?.names).toBe(true);
    expect(erased).toEqual([person]);
    const kept = await readErasedAliases(table, orgId, Date.parse(AT));
    expect(kept.flatMap((entry) => entry.names)).toEqual(expect.arrayContaining(aliasHashesOf(key, { names: [CHOSEN, REAL] }).names));
    expect(db.get(chosenNameKey(person))).toMatchObject({ erased: true });
    expect(db.get(chosenNameKey(person))).not.toHaveProperty("name");
  });
});

describe("the owner's name in access errors", () => {
  it("names an erased owner 'A former member' in the 'ask <owner>' message", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession({ owner: PRIYA });
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ARJUN }, "view");
    const deps = { documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members };
    const message = async () => (await requireSessionLevel(deps, w.caller(ARJUN), sessionId, "edit", "stop it").catch((error: Error) => error) as Error).message;
    expect(await message()).toContain("Priya");
    w.db.set({ ...chosenNameKey(PRIYA), entityType: "DEVELOPER_NAME", developerId: PRIYA, erased: true, erasedAt: AT });
    const after = await message();
    expect(after).toContain(FORMER_MEMBER_NAME);
    expect(after).not.toContain("Priya");
  });
});

describe("session events written by other people", () => {
  it("blanks the stored name of an erased actor of the page out of other actors' words, and leaves everyone else's words alone", async () => {
    const w = sessionWorld();
    const deps = { documentClient: w.db, tableName: "state", now: () => Date.parse(AT) + 60_000, projectMembers: w.members, signInStore: w.signInStore };
    const { sessionId } = w.seedSession();
    await appendSessionEvent(deps, ORG_A, sessionId, { eventId: sessionEventId("started", "a"), at: AT, type: "status", actor: { kind: "member", developerId: PRIYA, name: REAL }, text: `${REAL} started Rovara Code` });
    await appendSessionEvent(deps, ORG_A, sessionId, { eventId: sessionEventId("took", "b"), at: new Date(Date.parse(AT) + 1_000).toISOString(), type: "status", actor: { kind: "member", developerId: ARJUN, name: "Arjun Real" }, text: `Arjun Real took over from ${REAL}.` });
    const texts = async () => (await readSessionEvents(deps, w.caller(ARJUN), sessionId, {})).events.map((event) => event.text);
    expect(await texts()).toEqual([`${REAL} started Rovara Code`, `Arjun Real took over from ${REAL}.`]);
    w.db.set({ ...chosenNameKey(PRIYA), entityType: "DEVELOPER_NAME", developerId: PRIYA, erased: true, erasedAt: AT });
    expect(await texts()).toEqual([`${FORMER_MEMBER_NAME} started Rovara Code`, `Arjun Real took over from ${FORMER_MEMBER_NAME}.`]);
  });
});

describe("the message for a name that was erased", () => {
  it("says plainly that the details were just erased (a name chosen while the erase landed), and sends no one to an administrator", () => {
    expect(NAME_ERASED_MESSAGE).toContain("erased");
    expect(NAME_ERASED_MESSAGE.toLowerCase()).not.toContain("administrator");
    expect(NAME_ERASED_MESSAGE.toLowerCase()).not.toContain("admin");
  });
});

describe("a page's name overlay when the name read fails", () => {
  it("shows a generic name for every owner on the page, not the stored one, and logs it", async () => {
    const failing = { send: async () => { throw new Error("throttled"); } };
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      const overlay = await ownerNameOverlay({ documentClient: failing, tableName: "state" }, [PRIYA, ARJUN], ORG_A);
      expect(Object.fromEntries(overlay.replaced)).toEqual({ [PRIYA]: UNAVAILABLE_NAME, [ARJUN]: UNAVAILABLE_NAME });
      expect(overlay.chosen.size).toBe(0);
    } finally {
      log.mockRestore();
    }
    expect(lines.some((line) => line.includes("name_resolver_unavailable"))).toBe(true);
  });
});
