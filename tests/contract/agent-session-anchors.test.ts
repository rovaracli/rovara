// Plan 5 Task 10b: a comment pinned to one part of the session (a paragraph of the plan, a step of an agent run, a changed file). The anchor is `{ target, targetId, revision, excerpt? }`, for a
// comment only. The server checks that the part is in the view built for the writer, never trusts the excerpt for anything but display (it is redacted like the text and cut to 200 characters),
// works out `anchorState` on every read against the view built for the reader (current, outdated or gone), lists the comments of one anchor, and lets replies take their thread's anchor.
// Old comments with no anchor parse, list and read as they did.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SESSION_ANCHORS_MAX, SESSION_ANCHOR_EXCERPT_MAX, SESSION_ANCHOR_TARGETS, SESSION_MESSAGES_PAGE_MAX, SessionAnchorSchema, SessionMessagePageSchema, SessionMessageSchema, agentSessionKey, type AgentSessionRecord } from "@rovara-code/contracts";
import { SessionViewSchema } from "@agentx/cloud-contracts";
import { editSessionMessage, deleteSessionMessage, listSessionMessages, sendSessionMessage, type SessionMessageDependencies } from "../../packages/broker/src/agent-sessions/messages.js";
import { anchorTargetsOf } from "../../packages/broker/src/agent-sessions/anchors.js";
import { routeAgentSessionRequest } from "../../packages/broker/src/agent-sessions/routes.js";
import { sessionView } from "../../packages/broker/src/agent-sessions/read.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { ARJUN, MIA, ORG_A, ORG_B, PRIYA, T0, ZED, sessionWorld } from "../support/agent-session-world.js";

const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));
/** What a message's anchor quotes: a gone anchor has no excerpt, and the type says so by not having the field. */
const excerptOf = (anchor: unknown): string | undefined => (anchor as { excerpt?: string } | undefined)?.excerpt;
const TOKEN = `ghp_${"A1b2C3d4E5".repeat(4).slice(0, 36)}`;
const PLAN = { target: "plan_block", targetId: "p2", revision: "v2" } as const;
const STEP = { target: "step", targetId: "build", revision: "running" } as const;
const FILE = { target: "change_file", targetId: "web:src/a.ts", revision: "+12-3" } as const;

/** What the task's own view holds that a comment can be pinned to: three plan paragraphs (plan version 2), one agent step, one changed file. */
const baseView = () => ({
  workflow: { artifacts: [{ id: "plan-1", type: "plan", version: 1 }, { id: "plan-2", type: "plan", version: 2 }, { id: "req-1", type: "requirements", version: 5 }], planContent: "First paragraph.\n\nSecond paragraph.\n\n\n  \nThird paragraph." },
  run: { state: "RUNNING", steps: [{ id: "build", name: "Build", status: "running" }], pendingApprovals: [] },
  changedFiles: [{ repository: "web", path: "src/a.ts", added: 12, removed: 3 }],
});

function world(options: { noView?: boolean; kind?: "task" | "chain" | "local" } = {}) {
  const w = sessionWorld();
  const logs: Array<Record<string, unknown>> = [];
  const state = { view: baseView() as Record<string, unknown>, hideFor: undefined as undefined | ((actor: "owner" | "viewer") => Partial<ReturnType<typeof baseView>>), fail: false, calls: [] as Array<{ taskId: string; events: number; details: boolean; actor: string }> };
  const taskView = async (task: { taskId: string }, o: { events: number; details: boolean; actor: "owner" | "viewer" }) => {
    state.calls.push({ taskId: task.taskId, events: o.events, details: o.details, actor: o.actor });
    if (state.fail) throw new Error("the view is down");
    return { ...state.view, ...(state.hideFor?.(o.actor) ?? {}) } as never;
  };
  const deps: SessionMessageDependencies = { documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, log: (entry) => logs.push(entry), ...(options.noView === true ? {} : { taskView }) };
  const made = w.seedSession({ kind: options.kind ?? "task" });
  const session = made.record as unknown as AgentSessionRecord;
  const sid = session.sessionId;
  w.seedShare(ORG_A, sid, { kind: "member", developerId: ARJUN }, "view");
  const send = (who: string, text: string, extra: Record<string, unknown> = {}, id: string = sid, orgId = ORG_A) =>
    sendSessionMessage(deps, w.caller(who, orgId), id, { requestId: randomUUID(), kind: "comment", text, ...extra } as never);
  const list = (who: string, query: { after?: string; anchor?: string } = {}, id: string = sid, orgId = ORG_A) => listSessionMessages(deps, w.caller(who, orgId), id, query);
  const messageItems = () => w.db.find((item) => item.pk === agentSessionKey(ORG_A, sid, "META").pk && /^MESSAGE#msg_/.test(String(item.sk)));
  const everything = () => JSON.stringify(w.db.find(() => true));
  return { w, deps, logs, state, made, sid, send, list, messageItems, everything };
}

describe("the anchor contract", () => {
  const stored = { messageId: "msg_00000000000000000001", sessionId: "ses_00000000000000000001", kind: "comment", source: "app", author: { developerId: PRIYA, name: "Priya" }, text: "hi", createdAt: "2026-10-22T09:00:00.000Z", rev: 1 };

  it("names the parts a comment can be pinned to, and only those the session view has", () => {
    expect([...SESSION_ANCHOR_TARGETS]).toEqual(["plan_block", "step", "change_file"]);
    expect(SESSION_ANCHOR_EXCERPT_MAX).toBe(200);
  });

  it("reads an anchor strictly: its target, id and revision, and an excerpt of at most 200 characters, with no other field and no control character", () => {
    const ok = { ...PLAN, excerpt: "x".repeat(200) };
    expect(SessionAnchorSchema.parse(ok)).toEqual(ok);
    expect(SessionAnchorSchema.parse(PLAN)).toEqual(PLAN);
    for (const bad of [
      { ...PLAN, excerpt: "x".repeat(201) }, { ...PLAN, extra: 1 }, { ...PLAN, target: "section" }, { ...PLAN, targetId: "" }, { ...PLAN, targetId: "a\u0007b" }, { ...PLAN, targetId: "x".repeat(301) },
      { ...PLAN, revision: "" }, { ...PLAN, revision: "x".repeat(65) }, { ...PLAN, revision: "v\n2" }, { ...PLAN, excerpt: "a\u0000b" }, { target: "plan_block", targetId: "p1" }, { ...PLAN, excerpt: "" },
    ]) expect(SessionAnchorSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it("puts anchor, anchorState and threadId on a comment only, and reads a comment stored before them exactly as it was", () => {
    expect(SessionMessageSchema.parse(stored)).toEqual(stored);
    const pinned = { ...stored, anchor: PLAN, anchorState: "outdated", threadId: "msg_00000000000000000000" };
    expect(SessionMessageSchema.parse(pinned)).toEqual(pinned);
    for (const state of ["current", "outdated", "gone"]) expect(SessionMessageSchema.safeParse({ ...stored, anchor: PLAN, anchorState: state }).success).toBe(true);
    expect(SessionMessageSchema.safeParse({ ...stored, anchorState: "stale" }).success).toBe(false);
    expect(SessionMessageSchema.safeParse({ ...stored, anchor: { ...PLAN, extra: 1 } }).success).toBe(false);
    const steer = { ...stored, kind: "steer", delivery: { state: "queued", at: stored.createdAt } };
    expect(SessionMessageSchema.safeParse(steer).success).toBe(true);
    for (const extra of [{ anchor: PLAN }, { anchorState: "current" }, { threadId: "msg_00000000000000000000" }]) expect(SessionMessageSchema.safeParse({ ...steer, ...extra }).success).toBe(false);
  });
});

describe("the parts of a session view a comment can be pinned to", () => {
  it("lists each non-empty paragraph of the plan (p1, p2, ... at the plan's newest version), each step of an agent run (its status) and each changed file (its counts)", () => {
    expect(anchorTargetsOf(baseView() as never)).toEqual([
      { target: "plan_block", targetId: "p1", revision: "v2" }, { target: "plan_block", targetId: "p2", revision: "v2" }, { target: "plan_block", targetId: "p3", revision: "v2" },
      STEP, FILE,
    ]);
  });

  it("lists nothing it can't give a revision for: no plan text, no plan version, no steps, no files", () => {
    expect(anchorTargetsOf({})).toEqual([]);
    expect(anchorTargetsOf({ workflow: { artifacts: [{ type: "plan", version: 1 }] } })).toEqual([]);
    expect(anchorTargetsOf({ workflow: { planContent: "A.\n\nB.", artifacts: [{ type: "requirements", version: 1 }] } })).toEqual([]);
    expect(anchorTargetsOf({ workflow: { planContent: "   \n\n  ", artifacts: [{ type: "plan", version: 1 }] } })).toEqual([]);
  });

  it("holds the list to its bounds: 200 paragraphs, 100 steps, 300 files, no id over 300 characters", () => {
    const view = {
      workflow: { planContent: Array.from({ length: 250 }, (_, n) => `para ${String(n)}`).join("\n\n"), artifacts: [{ type: "plan", version: 3 }] },
      run: { steps: Array.from({ length: 150 }, (_, n) => ({ id: `s${String(n)}`, name: "S", status: "done" })) },
      changedFiles: [...Array.from({ length: 350 }, (_, n) => ({ repository: "web", path: `f${String(n)}.ts`, added: 1, removed: 0 })), { repository: "web", path: "x".repeat(300), added: 1, removed: 0 }],
    };
    const anchors = anchorTargetsOf(view);
    expect(anchors.filter((a) => a.target === "plan_block")).toHaveLength(200);
    expect(anchors.filter((a) => a.target === "step")).toHaveLength(100);
    expect(anchors.filter((a) => a.target === "change_file")).toHaveLength(300);
    expect(anchors).toHaveLength(600);
    expect(SESSION_ANCHORS_MAX).toBe(600);
    expect(anchors.every((a) => a.targetId.length <= 300)).toBe(true);
    expect(anchorTargetsOf({ changedFiles: [{ repository: "web", path: "x".repeat(300), added: 1, removed: 0 }] })).toEqual([]);
  });

  it("is in the session view for the web to wire in, and left out when the view has no part", async () => {
    const t = world();
    const view = await sessionView({ ...t.deps, origin: "https://cell.example.com" } as never, t.w.caller(PRIYA), t.sid);
    expect(SessionViewSchema.shape.anchors.parse(view.anchors)).toHaveLength(5);
    expect(view.anchors).toContainEqual(PLAN);
    expect(view.anchors).toContainEqual(STEP);
    expect(view.anchors).toContainEqual(FILE);
    t.state.view = {};
    expect((await sessionView({ ...t.deps, origin: "https://cell.example.com" } as never, t.w.caller(PRIYA), t.sid)).anchors).toBeUndefined();
  });
});

describe("sending a pinned comment", () => {
  it("stores the anchor with the comment, answers it as current, and checks the part in the view built for the writer", async () => {
    const t = world();
    const message = await t.send(PRIYA, "this paragraph is wrong", { anchor: { ...PLAN, excerpt: "Second paragraph." } });
    expect(SessionMessageSchema.parse(message)).toMatchObject({ kind: "comment", anchor: { ...PLAN, excerpt: "Second paragraph." }, anchorState: "current" });
    expect(t.messageItems()[0]).toMatchObject({ anchor: { ...PLAN, excerpt: "Second paragraph." } });
    expect(t.messageItems()[0]).not.toHaveProperty("anchorState");
    // The view was built for this writer: the owner, with details, and no events.
    expect(t.state.calls).toEqual([{ taskId: t.made.taskId, events: 0, details: true, actor: "owner" }]);
    for (const anchor of [STEP, FILE]) expect((await t.send(PRIYA, "here", { anchor })).anchor).toMatchObject(anchor);
  });

  it("answers a comment with no anchor as it always did: no anchor, no state, the view not even read", async () => {
    const t = world();
    const message = await t.send(PRIYA, "just a comment");
    expect(message).not.toHaveProperty("anchor");
    expect(message).not.toHaveProperty("anchorState");
    expect(message).not.toHaveProperty("threadId");
    expect(t.state.calls).toHaveLength(0);
  });

  it("gives a comment pinned to an older revision the state outdated at once, and still takes it", async () => {
    const t = world();
    const message = await t.send(PRIYA, "from the old plan", { anchor: { ...PLAN, revision: "v1" } });
    expect(message.anchorState).toBe("outdated");
    expect(message.anchor).toMatchObject({ revision: "v1" });
  });

  it("refuses with NOT_FOUND a part that is not in the writer's view: a paragraph that does not exist, another step, a file the writer can't see", async () => {
    const t = world();
    for (const anchor of [{ ...PLAN, targetId: "p4" }, { ...STEP, targetId: "test" }, { ...FILE, targetId: "web:src/b.ts" }, { ...PLAN, target: "step" }]) {
      expect(await code(t.send(PRIYA, "x", { anchor })), JSON.stringify(anchor)).toEqual({ code: "NOT_FOUND", message: "that part of the session was not found" });
    }
    // Arjun's view (a session viewer, who can comment as a plain viewer of the session) hides the changed files.
    t.state.hideFor = (actor) => (actor === "viewer" ? { changedFiles: [] } : {});
    expect(t.messageItems()).toHaveLength(0);
    expect((await t.send(PRIYA, "owner sees it", { anchor: FILE })).anchor).toMatchObject(FILE);
    expect(await code(t.send(ARJUN, "can't see it", { anchor: FILE }))).toEqual({ code: "NOT_FOUND", message: "that part of the session was not found" });
    expect(t.messageItems()).toHaveLength(1);
    // The refusal names nothing the client sent.
    const refused = await code(t.send(PRIYA, "x", { anchor: { ...FILE, targetId: "web:secret/path.ts" } }));
    expect(JSON.stringify(refused)).not.toContain("secret");
  });

  it("fails closed when the view can't be built or isn't wired, and for a session that has no such parts", async () => {
    const down = world();
    down.state.fail = true;
    expect(await code(down.send(PRIYA, "x", { anchor: PLAN }))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(down.messageItems()).toHaveLength(0);
    expect(JSON.stringify(down.logs)).not.toContain("the view is down");
    const unwired = world({ noView: true });
    expect(await code(unwired.send(PRIYA, "x", { anchor: PLAN }))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    for (const kind of ["chain", "local"] as const) {
      const other = world({ kind });
      expect(await code(other.send(PRIYA, "x", { anchor: PLAN })), kind).toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("takes a comment only: a message to the agent can't carry an anchor or a thread", async () => {
    const t = world();
    expect(await code(t.send(PRIYA, "x", { kind: "steer", anchor: PLAN }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(t.send(PRIYA, "x", { kind: "steer", threadId: "msg_00000000000000000000" }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(t.messageItems()).toHaveLength(0);
  });

  it("validates the anchor at the boundary: its fields, a 200-character excerpt at most, and no unknown field", async () => {
    const t = world();
    for (const anchor of [{ ...PLAN, excerpt: "x".repeat(201) }, { ...PLAN, extra: 1 }, { target: "plan_block" }, "p2", { ...PLAN, targetId: "p\u0007" }]) {
      expect(await code(t.send(PRIYA, "x", { anchor })), JSON.stringify(anchor)).toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(t.messageItems()).toHaveLength(0);
  });

  it("redacts the excerpt like the text (a secret, mentions, direction marks), keeps it to one line of at most 200 characters, and leaves it out when nothing is left", async () => {
    const t = world();
    const message = await t.send(PRIYA, "see this", { anchor: { ...PLAN, excerpt: `key ${TOKEN}\n<@U0PRIYA01> <!channel>‮ done ${"y".repeat(300)}`.slice(0, 200) } });
    const excerpt = excerptOf(message.anchor) ?? "";
    expect(excerpt).toContain("[REDACTED]");
    expect(excerpt).not.toContain(TOKEN);
    expect(excerpt).not.toMatch(/<[@!#]/u);
    expect(excerpt).not.toMatch(/[‪-‮\n]/u);
    expect([...excerpt].length).toBeLessThanOrEqual(200);
    expect(t.everything()).not.toContain(TOKEN);
    // An excerpt that grows when redacted is cut to 200 after redaction.
    const grown = await t.send(PRIYA, "see this", { anchor: { ...PLAN, excerpt: Array.from({ length: 22 }, () => "pwd=x").join(" ").slice(0, 150) } });
    expect([...(excerptOf(grown.anchor) ?? "")].length).toBeLessThanOrEqual(200);
    // Nothing left of it: no excerpt at all.
    const blank = await t.send(PRIYA, "see this", { anchor: { ...PLAN, excerpt: "‮‮" } });
    expect(blank.anchor).toEqual(PLAN);
  });

  it("catches a secret split by an invisible character, in the text and in the excerpt", async () => {
    const t = world();
    const split = `${TOKEN.slice(0, 8)}\u200b${TOKEN.slice(8, 20)}\u2060${TOKEN.slice(20)}`;
    const message = await t.send(PRIYA, `key ${split} done`, { anchor: { ...PLAN, excerpt: `quoted ${TOKEN.slice(0, 6)}\u200d${TOKEN.slice(6)}` } });
    expect(message.text).toContain("[REDACTED]");
    expect(message.text).not.toContain(TOKEN.slice(0, 8));
    expect(excerptOf(message.anchor)).toContain("[REDACTED]");
    expect(excerptOf(message.anchor)).not.toContain(TOKEN.slice(0, 6));
    expect(t.everything()).not.toContain(TOKEN.slice(0, 8));
    // An edit is the same, and a line break survives.
    const edited = await editSessionMessage(t.deps, t.w.caller(PRIYA), t.sid, message.messageId, { rev: 1, text: `again ${TOKEN.slice(0, 10)}\u00ad${TOKEN.slice(10)}\nsecond line` });
    expect(edited.text).toContain("[REDACTED]");
    expect(edited.text).toContain("\nsecond line");
    expect(edited.text).not.toContain(TOKEN.slice(0, 10));
  });

  it("never lets the excerpt decide anything: a wrong one changes neither the state nor the target, and a long text is still cut as before", async () => {
    const t = world();
    const message = await t.send(PRIYA, "x", { anchor: { ...PLAN, excerpt: "Something the plan never said." } });
    expect(message.anchorState).toBe("current");
    expect(message.anchor).toMatchObject({ target: "plan_block", targetId: "p2" });
  });

  it("puts no excerpt or anchor in an event, a notice or a log, and no text in the logs", async () => {
    const t = world();
    await t.send(PRIYA, "the words of the comment", { anchor: { ...PLAN, excerpt: "the excerpt words" } });
    const events = t.w.db.find((item) => String(item.sk).startsWith("EVENT#"));
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("excerpt");
    expect(JSON.stringify(events)).not.toContain("words");
    expect(events[0]).toMatchObject({ text: "Priya commented." });
    expect(JSON.stringify(t.logs)).not.toContain("words");
  });

  it("replays a request by its id: the same anchor answers the same message, another anchor is a different request", async () => {
    const t = world();
    const requestId = randomUUID();
    const first = await t.send(PRIYA, "x", { requestId, anchor: PLAN });
    expect((await t.send(PRIYA, "x", { requestId, anchor: PLAN })).messageId).toBe(first.messageId);
    expect(await code(t.send(PRIYA, "x", { requestId, anchor: { ...PLAN, targetId: "p1" } }))).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await code(t.send(PRIYA, "x", { requestId }))).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(t.messageItems()).toHaveLength(1);
  });

  it("keeps every rule of an ordinary comment: a person with no level, another org, and a project viewer", async () => {
    const t = world();
    expect(await code(t.send(ZED, "x", { anchor: PLAN }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(t.send("9".repeat(64), "x", { anchor: PLAN }, t.sid, ORG_B))).toMatchObject({ code: "NOT_FOUND" });
    t.w.seedShare(ORG_A, t.sid, { kind: "member", developerId: MIA }, "view");
    expect(await code(t.send(MIA, "x", { anchor: PLAN }))).toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
    expect(t.messageItems()).toHaveLength(0);
  });
});

describe("replies take their thread's anchor", () => {
  it("copies the anchor of the first message into a reply, whatever the client sends, and names the thread by that message's id", async () => {
    const t = world();
    const root = await t.send(PRIYA, "first", { anchor: { ...PLAN, excerpt: "Second paragraph." } });
    expect(root).not.toHaveProperty("threadId");
    const reply = await t.send(ARJUN, "agreed", { threadId: root.messageId });
    // The reply holds the thread's part and no excerpt: what the first comment quoted goes with that comment.
    expect(reply).toMatchObject({ threadId: root.messageId, anchorState: "current" });
    expect(reply.anchor).toEqual(PLAN);
    expect(t.messageItems().find((item) => item.messageId === reply.messageId)).toMatchObject({ threadId: root.messageId, anchor: PLAN });
    // A reply with an anchor of its own is refused: the thread's is the only one.
    expect(await code(t.send(ARJUN, "again", { threadId: root.messageId, anchor: FILE }))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("threads replies to a comment with no anchor too, with no anchor and no state", async () => {
    const t = world();
    const root = await t.send(PRIYA, "first");
    const reply = await t.send(ARJUN, "agreed", { threadId: root.messageId });
    expect(reply).toMatchObject({ threadId: root.messageId });
    expect(reply).not.toHaveProperty("anchor");
    expect(reply).not.toHaveProperty("anchorState");
  });

  it("still takes a reply when the part has since gone, and refuses a thread that is not there: unknown, a reply, a message to the agent, a deleted comment", async () => {
    const t = world();
    const root = await t.send(PRIYA, "first", { anchor: PLAN });
    t.state.view = {};
    expect((await t.send(ARJUN, "still talking", { threadId: root.messageId })).anchorState).toBe("gone");
    const reply = (await t.list(PRIYA)).messages.find((m) => m.threadId !== undefined)!;
    expect(await code(t.send(ARJUN, "x", { threadId: reply.messageId }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(t.send(ARJUN, "x", { threadId: "msg_00000000000000000099" }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(t.send(ARJUN, "x", { threadId: "nope" }))).toMatchObject({ code: "CONFIG_INVALID" });
    t.w.db.set({
      ...agentSessionKey(ORG_A, t.sid, "MESSAGE#msg_00000000000000000042"), entityType: "AGENT_SESSION_MESSAGE", orgId: ORG_A, sessionId: t.sid, messageId: "msg_00000000000000000042", kind: "steer", source: "app",
      author: { developerId: PRIYA, name: "Priya" }, text: "x", createdAt: new Date(T0).toISOString(), rev: 1, delivery: { state: "queued", at: new Date(T0).toISOString() },
    });
    expect(await code(t.send(ARJUN, "x", { threadId: "msg_00000000000000000042" }))).toMatchObject({ code: "NOT_FOUND" });
    await deleteSessionMessage(t.deps, t.w.caller(PRIYA), t.sid, root.messageId, { rev: 1 });
    expect(await code(t.send(ARJUN, "x", { threadId: root.messageId }))).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("reading pinned comments", () => {
  it("works out current, outdated and gone against the view built for the reader, for the comment and its replies", async () => {
    const t = world();
    const root = await t.send(PRIYA, "first", { anchor: { ...PLAN, excerpt: "Second paragraph." } });
    t.w.clock.now += 1000;
    await t.send(ARJUN, "agreed", { threadId: root.messageId });
    t.w.clock.now += 1000;
    await t.send(PRIYA, "plain");
    const states = async () => (await t.list(PRIYA)).messages.map((m) => m.anchorState);
    expect(await states()).toEqual(["current", "current", undefined]);
    // The plan moved on: version 3 still has the paragraph.
    t.state.view = { ...baseView(), workflow: { ...baseView().workflow, artifacts: [{ id: "p", type: "plan", version: 3 }] } };
    expect(await states()).toEqual(["outdated", "outdated", undefined]);
    // And then it has fewer paragraphs.
    t.state.view = { ...baseView(), workflow: { artifacts: [{ id: "p", type: "plan", version: 4 }], planContent: "Only one." } };
    const gone = (await t.list(PRIYA)).messages;
    expect(gone.map((m) => m.anchorState)).toEqual(["gone", "gone", undefined]);
    // A gone part keeps only its kind: no id, no revision, no excerpt.
    expect(gone[0]!.anchor).toEqual({ target: "plan_block" });
    expect(gone[1]!.anchor).toEqual({ target: "plan_block" });
    expect(t.state.calls.slice(-3).every((call) => call.actor === "owner")).toBe(true);
  });

  it("reads the revision of each kind of part: a step by its status, a file by its counts", async () => {
    const t = world();
    await t.send(PRIYA, "step", { anchor: STEP });
    t.w.clock.now += 1000;
    await t.send(PRIYA, "file", { anchor: FILE });
    t.state.view = { ...baseView(), run: { steps: [{ id: "build", name: "Build", status: "done" }] }, changedFiles: [{ repository: "web", path: "src/a.ts", added: 12, removed: 3 }] };
    expect((await t.list(PRIYA)).messages.map((m) => m.anchorState)).toEqual(["outdated", "current"]);
    t.state.view = { ...baseView(), changedFiles: [{ repository: "web", path: "src/a.ts", added: 13, removed: 3 }] };
    expect((await t.list(PRIYA)).messages.map((m) => m.anchorState)).toEqual(["current", "outdated"]);
    t.state.view = { ...baseView(), run: undefined, changedFiles: [] };
    expect((await t.list(PRIYA)).messages.map((m) => m.anchorState)).toEqual(["gone", "gone"]);
  });

  it("shows a reader who can't see the part the comment as gone, with no excerpt", async () => {
    const t = world();
    await t.send(PRIYA, "about the file", { anchor: { ...FILE, excerpt: "the file's first lines" } });
    t.state.hideFor = (actor) => (actor === "viewer" ? { changedFiles: [] } : {});
    const mine = (await t.list(PRIYA)).messages[0]!;
    expect(mine).toMatchObject({ anchorState: "current", anchor: { excerpt: "the file's first lines" } });
    const theirs = (await t.list(ARJUN)).messages[0]!;
    expect(theirs).toMatchObject({ anchorState: "gone" });
    // A viewer who can't see the file learns only that the comment is on a file: not its path, not its counts, not what was quoted.
    expect(theirs.anchor).toEqual({ target: "change_file" });
    expect(JSON.stringify(theirs)).not.toMatch(/first lines|src\/a\.ts|web:|\+12-3/u);
    expect(SessionMessageSchema.parse(theirs).anchor).toEqual({ target: "change_file" });
    // Nor can they list the part by its id: the list of a part they can't see is empty, and says nothing more.
    expect((await t.list(ARJUN, { anchor: "change_file:web:src/a.ts" })).messages).toEqual([]);
    expect((await t.list(PRIYA, { anchor: "change_file:web:src/a.ts" })).messages.map((m) => m.text)).toEqual(["about the file"]);
    // A reply (which holds the thread's anchor) hides it the same way.
    t.state.hideFor = undefined;
    const reply = await t.send(PRIYA, "and a reply", { threadId: (await t.list(PRIYA)).messages[0]!.messageId });
    t.state.hideFor = (actor) => (actor === "viewer" ? { changedFiles: [] } : {});
    expect((await t.list(ARJUN)).messages.find((m) => m.messageId === reply.messageId)?.anchor).toEqual({ target: "change_file" });
    expect(JSON.stringify(await t.list(ARJUN))).not.toMatch(/src\/a\.ts/u);
  });

  it("reads a gone anchor that carries only its kind, and no other shape without an id", () => {
    const stored = { messageId: "msg_00000000000000000001", sessionId: "ses_00000000000000000001", kind: "comment", source: "app", author: { developerId: PRIYA, name: "Priya" }, text: "hi", createdAt: "2026-10-22T09:00:00.000Z", rev: 1 };
    expect(SessionMessageSchema.parse({ ...stored, anchor: { target: "change_file" }, anchorState: "gone" }).anchor).toEqual({ target: "change_file" });
    expect(SessionMessageSchema.safeParse({ ...stored, anchor: { target: "change_file", extra: 1 }, anchorState: "gone" }).success).toBe(false);
    expect(SessionMessageSchema.safeParse({ ...stored, anchor: { target: "section" }, anchorState: "gone" }).success).toBe(false);
  });

  it("hides the excerpt and says gone when the view can't be built, and logs only ids", async () => {
    const t = world();
    await t.send(PRIYA, "x", { anchor: { ...PLAN, excerpt: "the excerpt words" } });
    t.state.fail = true;
    const message = (await t.list(PRIYA)).messages[0]!;
    expect(message).toMatchObject({ anchorState: "gone" });
    expect(message.anchor).not.toHaveProperty("excerpt");
    expect(t.logs).toContainEqual({ event: "agent_session.anchor_view_failed", orgId: ORG_A, sessionId: t.sid, error: "Error" });
    expect(JSON.stringify(t.logs)).not.toMatch(/the view is down|words/u);
    // With no view wired it is the same.
    const unwired = { ...t.deps } as Partial<SessionMessageDependencies>;
    delete (unwired as { taskView?: unknown }).taskView;
    expect((await listSessionMessages(unwired as SessionMessageDependencies, t.w.caller(PRIYA), t.sid, {})).messages[0]).toMatchObject({ anchorState: "gone" });
  });

  it("reads the view only when the page holds a pinned comment, and once", async () => {
    const t = world();
    await t.send(PRIYA, "plain");
    await t.list(PRIYA);
    expect(t.state.calls).toHaveLength(0);
    await t.send(PRIYA, "one", { anchor: PLAN });
    await t.send(PRIYA, "two", { anchor: STEP });
    t.state.calls.length = 0;
    await t.list(PRIYA);
    expect(t.state.calls).toHaveLength(1);
  });

  it("gives an edit and a delete of a pinned comment its anchor and state too, and changes neither", async () => {
    const t = world();
    const root = await t.send(PRIYA, "first", { anchor: { ...PLAN, excerpt: "Second paragraph." } });
    const edited = await editSessionMessage(t.deps, t.w.caller(PRIYA), t.sid, root.messageId, { rev: 1, text: "better" });
    expect(edited).toMatchObject({ text: "better", anchor: { ...PLAN, excerpt: "Second paragraph." }, anchorState: "current", rev: 2 });
    expect(t.messageItems()[0]).toMatchObject({ anchor: { ...PLAN, excerpt: "Second paragraph." } });
    const deleted = await deleteSessionMessage(t.deps, t.w.caller(PRIYA), t.sid, root.messageId, { rev: 2 });
    expect(deleted).toMatchObject({ text: "[deleted]", anchor: PLAN, anchorState: "current" });
    expect(deleted.anchor).not.toHaveProperty("excerpt");
    // The excerpt of a deleted comment is gone from the store too: no copy of what it quoted outlives it.
    expect(t.messageItems()[0]!.anchor).toEqual(PLAN);
  });

  it("lists a comment stored before anchors exactly as it was, with nothing added", async () => {
    const t = world();
    t.w.db.set({
      ...agentSessionKey(ORG_A, t.sid, "MESSAGE#msg_00000000000000000001"), entityType: "AGENT_SESSION_MESSAGE", orgId: ORG_A, sessionId: t.sid, messageId: "msg_00000000000000000001", kind: "comment", source: "app",
      author: { developerId: PRIYA, name: "Priya" }, text: "an old comment", createdAt: new Date(T0).toISOString(), rev: 1,
    });
    const page = await t.list(PRIYA);
    expect(SessionMessagePageSchema.parse(page).messages).toEqual([{ messageId: "msg_00000000000000000001", sessionId: t.sid, kind: "comment", source: "app", author: { developerId: PRIYA, name: "Priya" }, text: "an old comment", createdAt: new Date(T0).toISOString(), rev: 1 }]);
    expect(t.state.calls).toHaveLength(0);
  });
});

describe("the comments of one anchor", () => {
  const seed = async (t: ReturnType<typeof world>) => {
    const root = await t.send(PRIYA, "on p2", { anchor: PLAN });
    t.w.clock.now += 1000;
    await t.send(ARJUN, "reply to p2", { threadId: root.messageId });
    t.w.clock.now += 1000;
    await t.send(PRIYA, "on the step", { anchor: STEP });
    t.w.clock.now += 1000;
    await t.send(PRIYA, "unpinned");
    t.w.clock.now += 1000;
    await t.send(PRIYA, "on the file", { anchor: { ...FILE, excerpt: "export const a = 1;" } });
    return root;
  };

  it("lists the comments and replies of one part, oldest first, and no others; the full list holds them all", async () => {
    const t = world();
    await seed(t);
    expect((await t.list(PRIYA, { anchor: "plan_block:p2" })).messages.map((m) => m.text)).toEqual(["on p2", "reply to p2"]);
    expect((await t.list(PRIYA, { anchor: "step:build" })).messages.map((m) => m.text)).toEqual(["on the step"]);
    expect((await t.list(PRIYA, { anchor: "plan_block:p1" })).messages).toEqual([]);
    expect((await t.list(PRIYA)).messages.map((m) => m.text)).toEqual(["on p2", "reply to p2", "on the step", "unpinned", "on the file"]);
    // An id with a colon in it (a file in a repository) is one id.
    expect((await t.list(PRIYA, { anchor: "change_file:web:src/a.ts" })).messages.map((m) => m.text)).toEqual(["on the file"]);
    // Each comes with its state.
    expect((await t.list(PRIYA, { anchor: "plan_block:p2" })).messages.map((m) => m.anchorState)).toEqual(["current", "current"]);
  });

  it("refuses an anchor it can't read, and echoes nothing of it", async () => {
    const t = world();
    for (const anchor of ["", "plan_block", "plan_block:", "section:s1", ":p2", "plan_block:p\u0007", `plan_block:${"x".repeat(301)}`, "Plan_block:p2"]) {
      const refused = await code(t.list(PRIYA, { anchor }));
      expect(refused, JSON.stringify(anchor)).toMatchObject({ code: "CONFIG_INVALID" });
      expect(refused?.message).not.toContain("x".repeat(20));
    }
  });

  it("pages like the full list: a page holds at most 100 new comments, and the cursor goes on from the last", async () => {
    const t = world();
    for (let n = 0; n < SESSION_MESSAGES_PAGE_MAX + 5; n += 1) {
      t.w.db.set({
        ...agentSessionKey(ORG_A, t.sid, `MESSAGE#msg_${(T0 + n * 1000).toString(36).padStart(9, "0")}00000000000`), entityType: "AGENT_SESSION_MESSAGE", orgId: ORG_A, sessionId: t.sid,
        messageId: `msg_${(T0 + n * 1000).toString(36).padStart(9, "0")}00000000000`, kind: "comment", source: "app", author: { developerId: PRIYA, name: "Priya" }, text: `c${String(n)}`,
        createdAt: new Date(T0 + n * 1000).toISOString(), rev: 1, anchor: PLAN,
      });
    }
    const first = await t.list(PRIYA, { anchor: "plan_block:p2" });
    expect(first.messages).toHaveLength(SESSION_MESSAGES_PAGE_MAX);
    expect(first.next).toBeDefined();
    const second = await t.list(PRIYA, { anchor: "plan_block:p2", ...(first.next === undefined ? {} : { after: first.next }) });
    expect(second.messages.map((m) => m.text).filter((text) => !first.messages.some((m) => m.text === text))).toEqual(["c100", "c101", "c102", "c103", "c104"]);
  });

  it("follows the access rules of the full list: no level or another org is NOT_FOUND, a session viewer reads", async () => {
    const t = world();
    await seed(t);
    expect(await code(t.list(ZED, { anchor: "plan_block:p2" }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(t.list("9".repeat(64), { anchor: "plan_block:p2" }, t.sid, ORG_B))).toMatchObject({ code: "NOT_FOUND" });
    expect((await t.list(ARJUN, { anchor: "plan_block:p2" })).messages).toHaveLength(2);
  });
});

describe("the routes", () => {
  it("sends a pinned comment and a reply by POST .../messages and lists one anchor by GET .../messages?anchor=", async () => {
    const t = world();
    const deps = { ...t.deps, signInStore: t.w.signInStore, origin: "https://cell.example.com" };
    const call = (who: string, method: string, query: string, body?: unknown) => routeAgentSessionRequest(
      deps as never, t.w.caller(who), { method, path: `/v1/app/sessions/${t.sid}/messages`, headers: {}, requestId: "r", ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      new URL(`https://cell.example.com/v1/app/sessions/${t.sid}/messages${query}`),
    ) as Promise<Record<string, unknown>>;
    const root = SessionMessageSchema.parse(await call(PRIYA, "POST", "", { requestId: randomUUID(), kind: "comment", text: "pinned", anchor: PLAN }));
    expect(root).toMatchObject({ anchor: PLAN, anchorState: "current" });
    t.w.clock.now += 1000;
    const reply = SessionMessageSchema.parse(await call(ARJUN, "POST", "", { requestId: randomUUID(), kind: "comment", text: "reply", threadId: root.messageId }));
    expect(reply.threadId).toBe(root.messageId);
    t.w.clock.now += 1000;
    await call(PRIYA, "POST", "", { requestId: randomUUID(), kind: "comment", text: "elsewhere", anchor: STEP });
    const page = SessionMessagePageSchema.parse(await call(PRIYA, "GET", "?anchor=plan_block%3Ap2"));
    expect(page.messages.map((m) => m.text)).toEqual(["pinned", "reply"]);
    expect(await code(call(PRIYA, "GET", "?anchor=nope"))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(call(PRIYA, "POST", "", { requestId: randomUUID(), kind: "comment", text: "x", anchor: PLAN, other: 1 }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(call(PRIYA, "POST", "", { requestId: randomUUID(), kind: "comment", text: "x", anchor: { ...PLAN, excerpt: "x".repeat(201) } }))).toMatchObject({ code: "CONFIG_INVALID" });
  });
});

// ---- the edges: what each guard is for (found by mutation)

describe("the edges of pinned comments", () => {
  it("ends a paragraph at a blank line however it is spelled (spaces, tabs, CRLF), and counts a part once however often the view lists it", () => {
    const blocks = (planContent: string) => anchorTargetsOf({ workflow: { planContent, artifacts: [{ type: "plan", version: 1 }] } }).map((a) => a.targetId);
    expect(blocks("A.\n  \nB.")).toEqual(["p1", "p2"]);
    expect(blocks("A.\r\n\r\nB.\n\t\nC.")).toEqual(["p1", "p2", "p3"]);
    expect(blocks("A.\nstill A.\nB.")).toEqual(["p1"]);
    const twice = anchorTargetsOf({ run: { steps: [{ id: "build", status: "running" }, { id: "build", status: "done" }] }, changedFiles: [{ repository: "web", path: "a.ts", added: 1, removed: 0 }, { repository: "web", path: "a.ts", added: 2, removed: 0 }] });
    expect(twice).toEqual([{ target: "step", targetId: "build", revision: "running" }, { target: "change_file", targetId: "web:a.ts", revision: "+1-0" }]);
    // A step that holds nothing a revision can be made of is left out.
    expect(anchorTargetsOf({ run: { steps: [{ id: "build", status: "" }, { id: "test", status: "queued" }] } })).toEqual([{ target: "step", targetId: "test", revision: "queued" }]);
  });

  it("says nothing of a view that isn't wired, and refuses a task of another org without reading its view", async () => {
    const unwired = world({ noView: true });
    await unwired.send(PRIYA, "x");
    expect(await code(unwired.send(PRIYA, "x", { anchor: PLAN }))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(unwired.logs).toEqual([]);
    const foreign = world();
    foreign.w.db.set({ ...foreign.w.db.get(taskKey(foreign.made.taskId))!, orgId: ORG_B });
    expect(await code(foreign.send(PRIYA, "x", { anchor: PLAN }))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(foreign.state.calls).toHaveLength(0);
    // A task that is gone is the same.
    const gone = world();
    gone.w.db.delete(taskKey(gone.made.taskId));
    expect(await code(gone.send(PRIYA, "x", { anchor: PLAN }))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("tells a part by its kind as well as its id: a step called p2 is not the second paragraph", async () => {
    const t = world();
    t.state.view = { ...baseView(), run: { steps: [{ id: "p2", name: "P", status: "running" }] } };
    const onStep = await t.send(PRIYA, "on the step", { anchor: { target: "step", targetId: "p2", revision: "running" } });
    t.w.clock.now += 1000;
    const onPlan = await t.send(PRIYA, "on the paragraph", { anchor: PLAN });
    expect([onStep.anchorState, onPlan.anchorState]).toEqual(["current", "current"]);
    t.w.clock.now += 1000;
    // Each list holds its own comments only.
    expect((await t.list(PRIYA, { anchor: "step:p2" })).messages.map((m) => m.text)).toEqual(["on the step"]);
    expect((await t.list(PRIYA, { anchor: "plan_block:p2" })).messages.map((m) => m.text)).toEqual(["on the paragraph"]);
    // The step goes away; the paragraph stays: each is read as itself, and a part that is gone has no list.
    t.state.view = { ...baseView(), run: undefined };
    expect((await t.list(PRIYA)).messages.map((m) => m.anchorState)).toEqual(["gone", "current"]);
    expect((await t.list(PRIYA, { anchor: "step:p2" })).messages).toEqual([]);
    expect((await t.list(PRIYA, { anchor: "plan_block:p2" })).messages.map((m) => m.text)).toEqual(["on the paragraph"]);
  });

  it("leaves the task page's comments out of the list of one part", async () => {
    const t = world();
    await t.send(PRIYA, "pinned", { anchor: PLAN });
    t.w.db.set({
      pk: `DEVTASK#${t.made.taskId}`, sk: "COMMENT#11111111-1111-4111-8111-111111111111", entityType: "TASK_COMMENT", schemaVersion: 1, taskId: t.made.taskId, commentId: "11111111-1111-4111-8111-111111111111",
      document: "plan", version: 1, target: { kind: "claim", id: "2.1" }, author: { kind: "person", developerId: ARJUN, name: "Arjun", owner: false }, text: "from the page", createdAt: new Date(T0 + 500).toISOString(), rev: 1,
    });
    expect((await t.list(PRIYA)).messages.map((m) => m.text)).toEqual(["pinned", "from the page"]);
    expect((await t.list(PRIYA, { anchor: "plan_block:p2" })).messages.map((m) => m.text)).toEqual(["pinned"]);
  });

  it("flattens the excerpt to one line, takes out format characters, cuts it at exactly 200 characters after redaction, and leaves it out when nothing is left", async () => {
    const t = world();
    const quoted = async (excerpt: string) => { const anchor = (await t.send(PRIYA, "x", { anchor: { ...PLAN, excerpt } })).anchor; return anchor === undefined ? undefined : { ...anchor, excerpt: excerptOf(anchor) }; };
    expect((await quoted("a\n\n   b\tc \r\n d"))?.excerpt).toBe("a b c d");
    expect((await quoted("a\u200db\u00adc\ufeff"))?.excerpt).toBe("abc");
    expect((await quoted("\u200d\u200d  "))).toEqual(PLAN);
    expect((await quoted("  padded  "))?.excerpt).toBe("padded");
    expect([...(await quoted("x".repeat(200)))!.excerpt!]).toHaveLength(200);
    // 33 secrets of a few characters each grow past 200 when redacted: the cut comes after, at exactly 200.
    const grown = (await quoted(Array.from({ length: 33 }, () => "pwd=x").join("\n")))!.excerpt!;
    expect(grown).toContain("[REDACTED]");
    expect([...grown]).toHaveLength(200);
  });

  it("treats a request with another thread as another request, and answers a replayed pinned comment with its state", async () => {
    const t = world();
    const root = await t.send(PRIYA, "first", { anchor: PLAN });
    const other = await t.send(PRIYA, "other", { anchor: STEP });
    const requestId = randomUUID();
    const reply = await t.send(ARJUN, "reply", { requestId, threadId: root.messageId });
    expect(await code(t.send(ARJUN, "reply", { requestId, threadId: other.messageId }))).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await t.send(ARJUN, "reply", { requestId, threadId: root.messageId })).toEqual(reply);
    expect(reply.anchorState).toBe("current");
    const again = await t.send(PRIYA, "pinned", { requestId: "11111111-2222-4333-8444-555555555555", anchor: { ...PLAN, excerpt: "quoted" } });
    expect(await t.send(PRIYA, "pinned", { requestId: "11111111-2222-4333-8444-555555555555", anchor: { ...PLAN, excerpt: "quoted" } })).toEqual(again);
    t.state.view = { ...baseView(), workflow: { ...baseView().workflow, artifacts: [{ id: "p", type: "plan", version: 9 }] } };
    expect((await t.send(PRIYA, "pinned", { requestId: "11111111-2222-4333-8444-555555555555", anchor: { ...PLAN, excerpt: "quoted" } })).anchorState).toBe("outdated");
  });

  it("refuses an anchor query that only looks like one, naming nothing", async () => {
    const t = world();
    for (const anchor of ["plan_blockx", "step", "stepx", "change_filex", "plan_blocks"]) expect(await code(t.list(PRIYA, { anchor })), anchor).toMatchObject({ code: "CONFIG_INVALID" });
    expect((await t.list(PRIYA, { anchor: "plan_block:p1:p2" })).messages).toEqual([]);
  });
});
