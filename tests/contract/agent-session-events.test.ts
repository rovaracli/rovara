// Plan 5 Task 6: the session event log. An event is one conditional put at EVENT#<at>#<eventId> with a deterministic id and no counter, so a retry is the
// same item and two writers never conflict. A transaction that holds an event puts it last: a cancellation at that position alone means "already recorded".
// The log is read oldest first, re-reading five seconds before the cursor so an event written late is still seen. It adds no way for a run or a note to fail.
import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import {
  SESSION_EVENTS_PAGE_MAX,
  SESSION_EVENT_TEXT_MAX,
  SessionEventPageReaderSchema,
  SessionEventPageSchema,
  agentSessionKey,
  sessionEventId,
  sessionEventSk,
  type SessionEvent,
} from "../../packages/contracts/src/index.js";
import { ensureTaskSession } from "../../packages/broker/src/agent-sessions/create.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { appendSessionEvent, readSessionEvents, slackReplyAuthor } from "../../packages/broker/src/agent-sessions/events.js";
import { routeAgentSessionRequest } from "../../packages/broker/src/agent-sessions/routes.js";
import { recordWorkflowThreadNote } from "../../packages/broker/src/aws/developer-tasks.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";
import { ARJUN, BO, CELL, MIA, ORG_A, ORG_B, PRIYA, ZED, sessionWorld } from "../support/agent-session-world.js";

const signInOf = (db: FakeDynamoDb) => new DeveloperSignInStore({ documentClient: db, tableName: "signin", now: Date.now });
const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));
const GITHUB_TOKEN = `ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)}`;
const AT = "2026-10-22T10:00:00.000Z";
const at = (offsetMs: number) => new Date(Date.parse(AT) + offsetMs).toISOString();
const DAY = 86_400;

function eventsWorld() {
  const w = sessionWorld();
  const deps = { documentClient: w.db, tableName: "state", now: () => Date.parse(AT) + 60_000, projectMembers: w.members, signInStore: w.signInStore };
  const { sessionId, taskId } = w.seedSession();
  const event = (kind: string, occurrence: string, when: string, extra: Partial<SessionEvent> = {}): SessionEvent => ({
    eventId: sessionEventId(kind, occurrence), at: when, type: "status", text: `${kind} ${occurrence}`, ...extra,
  });
  const rows = (id = sessionId) => w.db.find((item) => item.pk === agentSessionKey(ORG_A, id, "META").pk && String(item.sk).startsWith("EVENT#"));
  const read = (who: string, after?: string, orgId = ORG_A, id = sessionId) => readSessionEvents(deps, w.caller(who, orgId), id, after === undefined ? {} : { after });
  return { w, deps, sessionId, taskId, event, rows, read };
}
type EventsWorld = ReturnType<typeof eventsWorld>;
const put = async (e: EventsWorld, ...events: SessionEvent[]) => { for (const event of events) await appendSessionEvent(e.deps, ORG_A, e.sessionId, event); };
/** What a client does: reads page after page from the cursor it was given, de-duplicating by event id, until a page brings nothing new. */
async function drain(e: EventsWorld, who = PRIYA): Promise<{ events: SessionEvent[]; pages: number }> {
  const seen = new Map<string, SessionEvent>();
  let after: string | undefined;
  for (let pages = 1; pages <= 20; pages += 1) {
    const page = await e.read(who, after);
    expect(SessionEventPageSchema.safeParse(page).success).toBe(true);
    const fresh = page.events.filter((event) => !seen.has(event.eventId));
    for (const event of fresh) seen.set(event.eventId, event);
    if (fresh.length === 0) return { events: [...seen.values()], pages };
    after = page.next;
  }
  throw new Error("the cursor never reached the end");
}

describe("appending an event", () => {
  it("writes one item per event id: the same event twice is one row, and two events at the same instant both commit", async () => {
    const e = eventsWorld();
    const status = e.event("status", "run-1", AT);
    expect(await appendSessionEvent(e.deps, ORG_A, e.sessionId as never, status)).toBe("appended");
    expect(await appendSessionEvent(e.deps, ORG_A, e.sessionId as never, status)).toBe("exists");
    expect(await appendSessionEvent(e.deps, ORG_A, e.sessionId as never, e.event("steer", "Ev1", AT, { type: "steer", source: "slack" }))).toBe("appended");
    expect(e.rows()).toHaveLength(2);
    expect(e.rows().map((row) => row.sk)).toContain(sessionEventSk(AT, status.eventId));
  });

  it("keeps the first write when a retry carries other words (the event is its id)", async () => {
    const e = eventsWorld();
    await put(e, e.event("status", "run-1", AT, { text: "first" }));
    expect(await appendSessionEvent(e.deps, ORG_A, e.sessionId as never, e.event("status", "run-1", AT, { text: "second" }))).toBe("exists");
    expect(e.rows().map((row) => row.text)).toEqual(["first"]);
  });

  it("stores a token redacted, cuts the text to the event limit, and expires the item a year after its time", async () => {
    const e = eventsWorld();
    await put(e, e.event("comment", "m1", AT, { type: "comment", text: `Use ${GITHUB_TOKEN} now` }), e.event("step", "long", at(1000), { type: "step", text: "x".repeat(900) }));
    const [secret, long] = e.rows();
    expect(String(secret!.text)).not.toContain(GITHUB_TOKEN);
    expect(String(secret!.text)).toContain("[REDACTED]");
    expect([...String(long!.text)]).toHaveLength(SESSION_EVENT_TEXT_MAX);
    expect(secret!.indexExpiresAt).toBe(Math.floor(Date.parse(AT) / 1000) + 365 * DAY);
    expect(long!.indexExpiresAt).toBe(Math.floor(Date.parse(at(1000)) / 1000) + 365 * DAY);
  });

  it("tells an end once and a pause as a pause: the same end twice is one row, and a paused status keeps its words", async () => {
    const e = eventsWorld();
    const ended = e.event("ended", "run-1", AT, { type: "ended", actor: { kind: "system" }, text: "Finished: succeeded." });
    await put(e, ended, { ...ended, text: "Finished: failed." });
    const paused = e.event("status", "run-2:paused", at(5000), { text: "Paused: the budget was reached. Nothing was lost; continue it to carry on." });
    await put(e, paused);
    expect((await e.read(PRIYA)).events.map((event) => event.text)).toEqual(["Finished: succeeded.", paused.text]);
  });

  it("writes nothing for an event that doesn't fit the schema", async () => {
    const e = eventsWorld();
    await expect(appendSessionEvent(e.deps, ORG_A, e.sessionId as never, { ...e.event("status", "x", AT), eventId: "not-an-id" })).rejects.toThrow();
    await expect(appendSessionEvent(e.deps, ORG_A, e.sessionId as never, { ...e.event("status", "x", AT), at: "yesterday" })).rejects.toThrow();
    expect(e.rows()).toHaveLength(0);
  });
});

describe("reading events", () => {
  it("answers them oldest first, ties by event id, and pages through all of them with the cursor", async () => {
    const e = eventsWorld();
    const all = Array.from({ length: SESSION_EVENTS_PAGE_MAX * 2 + 50 }, (_, n) => e.event("status", `n${String(n)}`, at(Math.floor(n / 3) * 20_000)));
    // Written in a scrambled order: the read doesn't depend on it.
    for (const event of [...all].sort((left, right) => left.eventId.localeCompare(right.eventId))) await put(e, event);
    const first = await e.read(PRIYA);
    expect(first.events).toHaveLength(SESSION_EVENTS_PAGE_MAX);
    expect(first.next).toBe(`${first.events.at(-1)!.at}#${first.events.at(-1)!.eventId}`);
    const expected = [...all].sort((left, right) => left.at.localeCompare(right.at) || left.eventId.localeCompare(right.eventId)).map((event) => event.eventId);
    const drained = await drain(e);
    expect(drained.events.map((event) => event.eventId)).toEqual(expected);
    expect(SessionEventPageReaderSchema.safeParse(first).success).toBe(true);
  });

  // S3-L2: a timeline entry is free text, so it is read through the one email rule (the same as every other free text), not a rule of its own.
  it.each([
    ["a plain address", `Shared with omar.diaz${String.fromCharCode(64)}example.test`, "Shared with [email removed]"],
    ["an address spelled out", "Shared with omar.diaz [at] example.test", "Shared with [email removed]"],
    ["an address that is only the entry", `omar.diaz${String.fromCharCode(64)}example.test`, "[email removed]"],
    ["code text with an at sign", `Bumped react${String.fromCharCode(64)}18.3.1`, `Bumped react${String.fromCharCode(64)}18.3.1`],
    ["a sentence with at", "Looked at example.test at noon", "Looked at example.test at noon"],
  ])("reads an entry's text through the one email rule: %s", async (_why, text, expected) => {
    const e = eventsWorld();
    await put(e, e.event("status", "mail", at(0), { text }));
    expect((await e.read(PRIYA)).events.map((event) => event.text)).toEqual([expected]);
  });

  it("answers an empty log with no cursor, and keeps the caller's cursor when nothing is new", async () => {
    const e = eventsWorld();
    expect(await e.read(PRIYA)).toEqual({ events: [] });
    await put(e, e.event("status", "a", AT));
    const page = await e.read(PRIYA);
    expect(await e.read(PRIYA, page.next)).toEqual({ events: [], next: page.next }); // the cursor's own event isn't sent again
    expect(await e.read(PRIYA, `${at(60_000)}#${sessionEventId("status", "zz")}`)).toEqual({ events: [], next: `${at(60_000)}#${sessionEventId("status", "zz")}` });
  });

  it("re-reads five seconds before the cursor: an event written late with an earlier time is still seen, once", async () => {
    const e = eventsWorld();
    await put(e, e.event("status", "a", AT), e.event("status", "b", at(10_000)));
    const page = await e.read(PRIYA);
    await put(e, e.event("comment", "late", at(7_000), { type: "comment" })); // written after the page was read, 3 seconds before its last event
    const next = await e.read(PRIYA, page.next);
    const ids = next.events.map((event) => event.eventId);
    expect(ids).toContain(sessionEventId("comment", "late"));
    expect(new Set(ids).size).toBe(ids.length);
    // An event more than five seconds behind the cursor is not re-read (the documented limit).
    await put(e, e.event("comment", "too-late", at(1_000), { type: "comment" }));
    expect((await e.read(PRIYA, page.next)).events.map((event) => event.eventId)).not.toContain(sessionEventId("comment", "too-late"));
    // A fresh read from the start sees everything.
    expect((await drain(e)).events.map((event) => event.eventId)).toContain(sessionEventId("comment", "too-late"));
  });

  it("still reaches the end when more than a page of events share one instant", async () => {
    const e = eventsWorld();
    const crowd = Array.from({ length: SESSION_EVENTS_PAGE_MAX * 2 }, (_, n) => e.event("status", `c${String(n)}`, AT));
    await put(e, ...crowd);
    const drained = await drain(e);
    expect(new Set(drained.events.map((event) => event.eventId))).toEqual(new Set(crowd.map((event) => event.eventId)));
    expect(drained.pages).toBeLessThanOrEqual(5); // each page moves on by at least half a page, however many events share the instant
  });

  it("leaves out an event whose expiry has passed though the table hasn't deleted it, and still fills the page behind a run of them", async () => {
    const e = eventsWorld();
    // Written 400 days before `now`: each expired 35 days ago, and the table hasn't deleted it yet.
    for (let n = 0; n < 250; n += 1) await put(e, e.event("status", `old${String(n)}`, at(-400 * DAY * 1000 + n * 1000)));
    await put(e, e.event("status", "live1", AT), e.event("status", "live2", at(1000)));
    const page = await e.read(PRIYA);
    expect(page.events.map((event) => event.text)).toEqual(["status live1", "status live2"]);
    expect(e.rows()).toHaveLength(252);
  });

  it("never mixes in another session's events", async () => {
    const e = eventsWorld();
    const other = e.w.seedSession({ owner: ARJUN });
    await put(e, e.event("status", "mine", AT));
    await appendSessionEvent(e.deps, ORG_A, other.sessionId, e.event("status", "theirs", AT));
    expect((await e.read(PRIYA)).events.map((event) => event.text)).toEqual(["status mine"]);
  });

  it("leaves out an item under this session's key that names another org or session", async () => {
    const e = eventsWorld();
    await put(e, e.event("status", "mine", AT));
    const stray = e.event("status", "stray", at(1000));
    e.w.db.set({ ...agentSessionKey(ORG_A, e.sessionId, sessionEventSk(stray.at, stray.eventId)), entityType: "AGENT_SESSION_EVENT", orgId: ORG_B, sessionId: e.sessionId, ...stray });
    const other = e.event("status", "other", at(2000));
    e.w.db.set({ ...agentSessionKey(ORG_A, e.sessionId, sessionEventSk(other.at, other.eventId)), entityType: "AGENT_SESSION_EVENT", orgId: ORG_A, sessionId: "ses_99999999999999999999", ...other });
    expect((await e.read(PRIYA)).events.map((event) => event.text)).toEqual(["status mine"]);
  });

  it("refuses a cursor that is not one this log gave, without echoing it", async () => {
    const e = eventsWorld();
    await put(e, e.event("status", "a", AT));
    for (const bad of ["", "nope", `${AT}`, `${AT}#evt_xyz`, `2026-13-40T99:99:99.000Z#${sessionEventId("a", "b")}`, `${AT}#${sessionEventId("a", "b").toUpperCase()}`, `x${AT}#${sessionEventId("a", "b")}`, `2026-02-30T10:00:00.000Z#${sessionEventId("a", "b")}`, "9".repeat(300)]) {
      const refused = await code(e.read(PRIYA, bad));
      expect(refused, bad).toMatchObject({ code: "CONFIG_INVALID" });
      if (bad.length > 3) expect(refused?.message).not.toContain(bad.slice(0, 12));
    }
  });

  it("is for people who may view the session: a sharee reads, and a stranger and another org get 404", async () => {
    const e = eventsWorld();
    await put(e, e.event("status", "a", AT));
    e.w.seedShare(ORG_A, e.sessionId, { kind: "member", developerId: MIA }, "view");
    expect((await e.read(MIA)).events).toHaveLength(1);
    expect(await code(e.read(ZED))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(e.read(BO, undefined, ORG_B))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(readSessionEvents(e.deps, e.w.caller(PRIYA), "ses_99999999999999999999", {}))).toMatchObject({ code: "NOT_FOUND" });
    // Another org's events under the same session id are never read: the keys come from the caller's org.
    const mine = e.w.seedSession({ orgId: ORG_B, owner: BO });
    await appendSessionEvent(e.deps, ORG_B, mine.sessionId, e.event("status", "b-only", AT));
    expect(await code(e.read(PRIYA, undefined, ORG_A, mine.sessionId))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("is served at GET /v1/app/sessions/{id}/events with the cursor as ?after=", async () => {
    const e = eventsWorld();
    await put(e, e.event("status", "a", AT), e.event("status", "b", at(20_000)), e.event("status", "c", at(22_000)));
    const route = (method: string, path: string) => routeAgentSessionRequest(
      { ...e.deps, origin: CELL, taskView: async () => { throw new Error("not used"); } },
      e.w.caller(PRIYA), { method, path: path.split("?")[0]!, headers: {}, requestId: "r" }, new URL(path, CELL),
    ) as Promise<{ events: SessionEvent[]; next?: string }>;
    const first = await route("GET", `/v1/app/sessions/${e.sessionId}/events`);
    expect(SessionEventPageReaderSchema.safeParse(first).success).toBe(true);
    expect(first.events).toHaveLength(3);
    const second = await route("GET", `/v1/app/sessions/${e.sessionId}/events?after=${encodeURIComponent(first.next!)}`);
    expect(second.events.map((event) => event.text)).toEqual(["status b"]); // "b" is within five seconds before the cursor ("c"), "a" is not
    expect(await code(route("POST", `/v1/app/sessions/${e.sessionId}/events`))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(route("GET", `/v1/app/sessions/${e.sessionId}/events?after=junk`))).toMatchObject({ code: "CONFIG_INVALID" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The Slack thread reply is a `steer` event in the note's own transaction, last
// ---------------------------------------------------------------------------------------------------------------------------------------------

const THREAD = { teamId: "T0TEAM", channelId: "C0CHANNEL", threadTs: "1695500000.000100" };

function noteWorld(options: { sessionId?: "none" | "unreadable" | "other-task" } = {}) {
  const e = eventsWorld();
  const { w, taskId, sessionId } = e;
  const { sessionId: _own, ...task } = w.db.get(taskKey(taskId))!; // eslint-disable-line @typescript-eslint/no-unused-vars -- put back below unless the test wants none
  w.db.set({ ...task, workflow: { revision: 1 }, share: { ...THREAD }, slackUserId: "U0PRIYA", ...(options.sessionId === "none" ? {} : { sessionId }) });
  if (options.sessionId === "unreadable") w.db.set({ ...w.db.get(agentSessionKey(ORG_A, sessionId, "META"))!, surprise: true });
  if (options.sessionId === "other-task") w.db.set({ ...w.db.get(agentSessionKey(ORG_A, sessionId, "META"))!, subject: { kind: "task", taskId: "00000000-0000-4000-8000-000000000000" } });
  const clock = { now: Date.parse(AT) };
  const transacts: Array<Array<Record<string, unknown>>> = [];
  const deps = {
    documentClient: w.db, tableName: "state", now: () => clock.now,
    actions: { transact: async (items: Array<Record<string, unknown>>) => { transacts.push(items); await w.db.send(new TransactWriteCommand({ TransactItems: items })); } },
  } as never;
  const note = (extra: { messageTs?: string; eventId?: string; text?: string; actor?: { developerId: string; name: string } | null; peopleAccess?: { peopleRevision?: number; isOwner: boolean } } = {}) =>
    recordWorkflowThreadNote(deps, {
      taskId, thread: THREAD, userId: "U0ARJUN", messageTs: extra.messageTs ?? "1695500001.000100", eventId: extra.eventId ?? "Ev1", text: extra.text ?? "Please keep the diff small.",
      ...(extra.actor === null ? {} : { actor: extra.actor ?? { developerId: ARJUN, name: "Arjun" } }),
      ...(extra.peopleAccess === undefined ? {} : { peopleAccess: extra.peopleAccess }),
    });
  const notes = () => w.db.find((item) => item.pk === `DEVTASK#${taskId}` && String(item.sk).startsWith("NOTE#"));
  return { ...e, clock, transacts, note, notes };
}

describe("a Slack thread reply on a task's session", () => {
  it("adds a steer event as the last item of the note's own transaction, with the words and id the plan names", async () => {
    const n = noteWorld();
    expect(await n.note({ text: "Please keep the diff small." })).toEqual({ outcome: "captured" });
    expect(n.transacts).toHaveLength(1);
    const items = n.transacts[0]!;
    expect(items).toHaveLength(3);
    expect((items.at(-1) as { Put: { Item: { entityType: string } } }).Put.Item.entityType).toBe("AGENT_SESSION_EVENT");
    expect(n.rows()).toHaveLength(1);
    expect(n.rows()[0]).toMatchObject({
      eventId: sessionEventId("steer", "Ev1"), at: AT, type: "steer", source: "slack", actor: { kind: "member", developerId: ARJUN, name: "Arjun" },
      text: "Arjun in Slack: Please keep the diff small.", orgId: ORG_A, sessionId: n.sessionId,
    });
    expect(n.notes()).toHaveLength(1);
    expect(n.w.db.get(taskKey(n.taskId))).toMatchObject({ threadNoteCount: 1 });
    // The page can read it.
    expect((await n.read(PRIYA)).events.map((event) => event.text)).toEqual(["Arjun in Slack: Please keep the diff small."]);
  });

  it("keeps the first 200 characters of the reply in the event and all of it in the note", async () => {
    const n = noteWorld();
    const text = `${"é".repeat(150)}${"b".repeat(150)}`;
    await n.note({ text });
    expect(n.rows()[0]!.text).toBe(`Arjun in Slack: ${[...text].slice(0, 200).join("")}`);
    expect(n.notes()[0]!.text).toBe(text);
  });

  it("redacts a token before the 200-character cut, so a token cut in half is not left half readable", async () => {
    const n = noteWorld();
    // The token begins 190 characters in: a cut first would leave `ghp_` and a few characters, which no pattern matches.
    const text = `${"w".repeat(184)} ${GITHUB_TOKEN} and then some more words`;
    await n.note({ text });
    expect(String(n.rows()[0]!.text)).not.toMatch(/ghp_[A-Za-z0-9]/);
    expect(String(n.rows()[0]!.text)).toContain("[REDACTED]");
  });

  it("stores a token in the reply redacted in the event", async () => {
    const n = noteWorld();
    await n.note({ text: `Try ${GITHUB_TOKEN}` });
    expect(String(n.rows()[0]!.text)).not.toContain(GITHUB_TOKEN);
  });

  it("answers duplicate for a second delivery and adds no event, even when the second one carries another event id", async () => {
    const n = noteWorld();
    expect(await n.note()).toEqual({ outcome: "captured" });
    expect(await n.note()).toEqual({ outcome: "duplicate" });
    expect(await n.note({ eventId: "Ev1-as-message" })).toEqual({ outcome: "duplicate" });
    expect(n.rows()).toHaveLength(1);
    expect(n.notes()).toHaveLength(1);
    expect(n.w.db.get(taskKey(n.taskId))).toMatchObject({ threadNoteCount: 1 });
  });

  it("commits the note when the event is already there: a cancellation at the last position alone is success, and the rest is retried without it", async () => {
    const n = noteWorld();
    await put(n, n.event("steer", "Ev9", AT, { type: "steer", source: "slack", text: "Arjun in Slack: the first copy" }));
    expect(await n.note({ eventId: "Ev9", messageTs: "1695500009.000100" })).toEqual({ outcome: "captured" });
    expect(n.transacts).toHaveLength(2);
    expect(n.transacts[1]).toHaveLength(2); // the note and the task's count, no event
    expect(n.notes()).toHaveLength(1);
    expect(n.w.db.get(taskKey(n.taskId))).toMatchObject({ threadNoteCount: 1 });
    expect(n.rows().map((row) => row.text)).toEqual(["Arjun in Slack: the first copy"]);
  });

  it("holds the same contract with the Task People fence in the transaction: the event is still last", async () => {
    const n = noteWorld();
    await put(n, n.event("steer", "Ev9", AT, { type: "steer", source: "slack", text: "first copy" }));
    expect(await n.note({ eventId: "Ev9", messageTs: "1695500009.000100", peopleAccess: { isOwner: false } })).toEqual({ outcome: "captured" });
    expect(n.transacts[0]).toHaveLength(4);
    expect((n.transacts[0]!.at(-1) as { Put?: unknown }).Put).toBeDefined();
    expect(n.transacts[1]).toHaveLength(3);
    expect(n.notes()).toHaveLength(1);
  });

  it("does not take a conflict at an earlier position for 'already recorded': a refused task stays refused", async () => {
    const n = noteWorld();
    await put(n, n.event("steer", "Ev9", AT, { type: "steer", source: "slack", text: "first copy" }));
    n.w.db.set({ ...n.w.db.get(taskKey(n.taskId))!, threadNoteCount: 200 }); // the task keeps no more replies: the count's condition fails at position 1
    expect(await n.note({ eventId: "Ev9" })).toEqual({ outcome: "refused" });
    expect(n.transacts).toHaveLength(1);
    expect(n.notes()).toHaveLength(0);
  });

  it("commits a reply and a projector status event on the same session at the same moment: there is no shared counter", async () => {
    const n = noteWorld();
    await put(n, n.event("status", "run-1", AT));
    await n.note();
    await put(n, n.event("step", "run-1:2", AT, { type: "step" }));
    expect(n.rows().map((row) => row.type).sort()).toEqual(["status", "steer", "step"]);
    expect((await n.read(PRIYA)).events).toHaveLength(3);
  });

  it("saves a reply from the person who took the task over as the owner's, and one from the creator who handed it over as a teammate's (Plan 5 Task 12a)", async () => {
    const n = noteWorld();
    n.w.db.set({ ...n.w.db.get(taskKey(n.taskId))!, currentOwner: { developerId: ARJUN, name: "Arjun", provider: "slack", slackUserId: "U0ARJUN", since: "2026-10-22T08:00:00.000Z" } });
    expect(await n.note({ eventId: "EvTaker", messageTs: "1695500001.000200" })).toEqual({ outcome: "captured" });
    expect(n.notes().map((item) => item["isOwner"])).toEqual([true]);
    const untaken = noteWorld();
    expect(await untaken.note({ eventId: "EvOther", messageTs: "1695500001.000300" })).toEqual({ outcome: "captured" });
    expect(untaken.notes().map((item) => item["isOwner"])).toEqual([false]);
  });

  describe("adds no new way for a note to fail", () => {
    it("saves the note of a task that has no session", async () => {
      const n = noteWorld({ sessionId: "none" });
      expect(await n.note()).toEqual({ outcome: "captured" });
      expect(n.transacts[0]).toHaveLength(2);
      expect(n.rows()).toHaveLength(0);
    });

    it("saves the note when the session can't be read", async () => {
      const n = noteWorld({ sessionId: "unreadable" });
      expect(await n.note()).toEqual({ outcome: "captured" });
      expect(n.transacts[0]).toHaveLength(2);
      expect(n.rows()).toHaveLength(0);
    });

    it("writes no event for a chain step's task: it has no session of its own, and its chain run's is not told", async () => {
      const n = noteWorld({ sessionId: "none" });
      const chain = n.w.seedSession({ kind: "chain" });
      n.w.db.set({ ...n.w.db.get(taskKey(n.taskId))!, chain: { chainRunId: chain.sessionId, stepId: "step-1" } });
      expect(await n.note()).toEqual({ outcome: "captured" });
      expect(n.transacts[0]).toHaveLength(2);
      expect(n.rows()).toHaveLength(0);
      expect(n.rows(chain.sessionId)).toHaveLength(0);
    });

    it("writes no event on a session that isn't this task's", async () => {
      const n = noteWorld({ sessionId: "other-task" });
      expect(await n.note()).toEqual({ outcome: "captured" });
      expect(n.rows()).toHaveLength(0);
    });

    it("saves the note, with a plain name and no person, when the name or the id can't be an event's", async () => {
      const n = noteWorld();
      expect(await n.note({ actor: { developerId: "U0SLACKONLY", name: "‮\u0000" } })).toEqual({ outcome: "captured" });
      expect(n.rows()[0]).toMatchObject({ text: "Someone in Slack: Please keep the diff small." });
      expect(n.rows()[0]!.actor).toBeUndefined();
    });

    it("saves the note, with a plain name, when the caller names nobody", async () => {
      const n = noteWorld();
      expect(await n.note({ actor: null })).toEqual({ outcome: "captured" });
      expect(n.rows()[0]).toMatchObject({ text: "Someone in Slack: Please keep the diff small." });
    });
  });
});

describe("through the real broker", () => {
  async function started(options: { developerRecord: boolean }) {
    const harness = await createDeveloperTaskBroker();
    const thread = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000021" };
    const first = await harness.handler({ source: "agentx.slack-ingress", action: "start-workflow", thread, userId: MAYA.slackUserId, instructions: "Add a greeting", workflowPath: "QUICK", requestId: randomUUID() });
    const taskId = String((JSON.parse(first.body) as { taskId: string }).taskId);
    // The harness has no agents set up, so the task has no session yet: it gets one as a read would give it.
    const ownerId = String(harness.db.get(`DEVTASK#${taskId}`, "META")!.developerId);
    const stored = { ...harness.db.get(`DEVTASK#${taskId}`, "META")!, agent: { agentId: "rovara-code", name: "Rovara Code", version: 3 }, origin: "slack", startedBy: { developerId: MAYA.developerId } };
    harness.db.set(stored);
    if (options.developerRecord) harness.db.set({ pk: `DEVELOPER#${ownerId}`, sk: "META", developerId: ownerId, provider: "slack", displayName: "Maya Chen", slackUserId: MAYA.slackUserId, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    const sessionId = String(await ensureTaskSession({ documentClient: harness.db, tableName: "state", now: Date.now }, stored as never, { ownerName: "Maya Chen", title: "Add a greeting" }));
    expect(sessionId).toMatch(/^ses_/);
    const send = async (userId: string, messageTs: string, eventId: string, text: string) =>
      JSON.parse((await harness.handler({ source: "agentx.slack-ingress", action: "thread-note", taskId, thread, userId, messageTs, eventId, text })).body) as { outcome: string };
    const steers = () => harness.db.find((item) => String(item.sk).startsWith("EVENT#") && String(item.pk).endsWith(sessionId) && item.type === "steer");
    return { harness, taskId, sessionId, send, steers, ownerId };
  }

  it("tells a Slack thread reply on a started task in that task's session, once, with the person's name", async () => {
    const t = await started({ developerRecord: true });
    expect(await t.send(MAYA.slackUserId!, "1695500002.000007", "EvA", "Keep the old flag.")).toEqual({ outcome: "captured" });
    expect(await t.send(MAYA.slackUserId!, "1695500002.000007", "EvB", "Keep the old flag.")).toEqual({ outcome: "duplicate" });
    expect(t.steers()).toHaveLength(1);
    expect(t.steers()[0]).toMatchObject({ eventId: sessionEventId("steer", "EvA"), source: "slack", text: "Maya Chen in Slack: Keep the old flag.", actor: { kind: "member", developerId: t.ownerId, name: "Maya Chen" } });
  });

  it("names the owner by what the task keeps when no developer record says more, and a teammate by what the caller is called", async () => {
    const t = await started({ developerRecord: false });
    expect(await t.send(MAYA.slackUserId!, "1695500002.000007", "EvA", "From the owner.")).toEqual({ outcome: "captured" });
    expect(await t.send("U0TEAMMATE1", "1695500003.000001", "EvC", "From a teammate.")).toEqual({ outcome: "captured" });
    expect(t.steers().map((row) => row.text).sort()).toEqual(["Slack user U0MAYA001 in Slack: From the owner.", "Slack user U0TEAMMATE1 in Slack: From a teammate."]);
  });

  it("names a teammate by the name the task's Task People list holds for their Slack id, and never throws", async () => {
    const t = await started({ developerRecord: false });
    const teammate = developerIdForSlackUser("U0TEAMMATE1");
    const task = t.harness.db.get(`DEVTASK#${t.taskId}`, "META") as never as { taskId: string; developerId: string; developerName: string; slackUserId?: string };
    const caller = { developerId: teammate, name: "Slack user U0TEAMMATE1" } as never;
    const deps = { documentClient: t.harness.db, tableName: "state" } as never;
    const signIn = signInOf(new FakeDynamoDb());
    expect(await slackReplyAuthor(deps, signIn, task, "U0TEAMMATE1", caller)).toEqual({ developerId: teammate, name: "Slack user U0TEAMMATE1" });
    t.harness.db.set({
      pk: `DEVTASK#${t.taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false,
      people: [{ developerId: teammate, slackUserId: "U0TEAMMATE1", name: "Tess Teammate", role: "commenter" }],
    });
    expect(await slackReplyAuthor(deps, signIn, task, "U0TEAMMATE1", caller)).toEqual({ developerId: teammate, name: "Tess Teammate" });
    // The owner is the task's own developer, by the name the task keeps (the caller's is a placeholder).
    expect(await slackReplyAuthor(deps, signIn, { ...task, developerId: "o".repeat(64), developerName: "Maya on the task", slackUserId: "U0OWNER001" }, "U0OWNER001", { developerId: "c".repeat(64), name: "Slack user U0OWNER001" }))
      .toEqual({ developerId: "o".repeat(64), name: "Maya on the task" });
    // A table that is down leaves the caller's own name.
    const down = { documentClient: { send: async () => { throw new Error("down"); } }, tableName: "state" } as never;
    expect(await slackReplyAuthor(down, { getDeveloper: async () => { throw new Error("down"); } }, task, "U0TEAMMATE1", caller)).toEqual({ developerId: teammate, name: "Slack user U0TEAMMATE1" });
  });

  describe("the developer record is read through the sign-in table (review I-1)", () => {
    const task = { taskId: "00000000-0000-4000-8000-0000000000aa", developerId: "d".repeat(64), developerName: "Name on the task", slackUserId: "U0OWNER001" };
    const record = (developerId: string, displayName: string, extra: Record<string, unknown> = {}) => ({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, provider: "slack", displayName, firstSignInAt: "x", lastSignInAt: "x", revoked: false, ...extra });
    const state = () => ({ documentClient: new FakeDynamoDb(), tableName: "state" }) as never;

    it("finds the name in the sign-in table, and a record in the state table is not it", async () => {
      const signin = new FakeDynamoDb();
      signin.set(record("e".repeat(64), "Eve from sign-in"));
      const stateDb = new FakeDynamoDb();
      stateDb.set(record("f".repeat(64), "Fay from the state table"));
      const caller = (developerId: string) => ({ developerId, name: "Slack user U0X" });
      expect(await slackReplyAuthor({ documentClient: stateDb, tableName: "state" }, signInOf(signin), task, "U0TEAM", caller("e".repeat(64)))).toEqual({ developerId: "e".repeat(64), name: "Eve from sign-in" });
      expect(await slackReplyAuthor({ documentClient: stateDb, tableName: "state" }, signInOf(signin), task, "U0TEAM", caller("f".repeat(64)))).toEqual({ developerId: "f".repeat(64), name: "Slack user U0X" });
    });

    it("follows a merge: a duplicate's replies are the survivor's", async () => {
      const signin = new FakeDynamoDb();
      signin.set(record("a".repeat(64), "Old duplicate", { mergedInto: "b".repeat(64) }));
      signin.set(record("b".repeat(64), "The survivor"));
      expect(await slackReplyAuthor(state(), signInOf(signin), task, "U0TEAM", { developerId: "a".repeat(64), name: "Slack user U0X" })).toEqual({ developerId: "b".repeat(64), name: "The survivor" });
    });

    it("asks the broker's sign-in table when a reply is told (the wiring)", async () => {
      const t = await started({ developerRecord: true });
      const reads: Array<{ table: unknown; pk: unknown }> = [];
      const base = t.harness.db.send.bind(t.harness.db);
      t.harness.db.send = (async (command: { constructor: { name: string }; input: { TableName?: unknown; Key?: { pk?: unknown } } }) => {
        if (command.constructor.name === "GetCommand" && String(command.input.Key?.pk).startsWith("DEVELOPER#")) reads.push({ table: command.input.TableName, pk: command.input.Key?.pk });
        return base(command);
      });
      expect(await t.send(MAYA.slackUserId!, "1695500002.000007", "EvA", "Keep the old flag.")).toEqual({ outcome: "captured" });
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every((read) => read.table === "signin")).toBe(true);
    });
  });

});

