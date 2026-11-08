// Plan 5 Task 9: following a session and seeing who is looking at it now. A follow is a `FOLLOWER#` item and a `followerCount` change in one transaction (at most
// 200, idempotent, the owner follows without an item); a follower hears of the session's notable changes through Task 8's sink; a heartbeat puts a `PRESENCE#` item
// that is trusted for 90 seconds and told to the session's channel only when the person wasn't there already.
import { afterEach, describe, expect, it } from "vitest";
import {
  PRESENCE_HEARTBEAT_SECONDS,
  PRESENCE_TTL_SECONDS,
  RealtimeNoticeSchema,
  SESSION_FOLLOWERS_MAX,
  SessionFollowResponseSchema,
  SessionPresenceResponseSchema,
  agentSessionKey,
  changesKey,
  orgMemberKey,
  sessionChannel,
  type AgentSessionRecord,
} from "../../packages/contracts/src/index.js";
import { registerSessionNoticeSink } from "../../packages/broker/src/agent-sessions/notice-sink.js";
import { followSession, recordPresence, removeFollower, unfollowSession, viewingNow, type SessionFollowerDependencies } from "../../packages/broker/src/agent-sessions/followers.js";
import { sessionView, type SessionReadDependencies } from "../../packages/broker/src/agent-sessions/read.js";
import { routeAgentSessionRequest } from "../../packages/broker/src/agent-sessions/routes.js";
import { createRealtimeSink } from "../../packages/broker/src/realtime/sink.js";
import type { RealtimeConfig } from "../../packages/broker/src/realtime/publish.js";
import { ARJUN, BO, CELL, MAX, MIA, OLA, ORG_A, ORG_B, PRIYA, T0, ZED } from "../support/agent-session-world.js";
import { iso, projectorWorld } from "../support/agent-session-projector-world.js";

afterEach(() => registerSessionNoticeSink(undefined));

type Item = Record<string, unknown>;
const ENDPOINT = "https://abcdefghij.appsync-api.us-east-1.amazonaws.com/event";
const hex = (digit: string) => digit.repeat(64);
const FOLLOWER_LIMIT_TEXT = "This session has the most followers it can have.";
const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));

/** A fetch that records each publish. */
function recorder() {
  const calls: Array<{ channel: string; events: string[] }> = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    calls.push(JSON.parse(init.body) as { channel: string; events: string[] });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const config = (): RealtimeConfig => ({ endpoint: ENDPOINT, region: "us-east-1", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" }), fetch: fetchImpl });
  return { calls, config };
}

function world(options: { realtime?: boolean } = {}) {
  const p = projectorWorld();
  const { w } = p;
  const rec = recorder();
  const deps: SessionFollowerDependencies = {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, ...(options.realtime === false ? {} : { realtimePublish: rec.config() }), log: () => undefined,
  };
  const made = w.seedSession();
  const session = made.record as unknown as AgentSessionRecord;
  const metaKey = agentSessionKey(ORG_A, session.sessionId, "META");
  const itemOf = (developerId: string) => w.db.get(agentSessionKey(ORG_A, session.sessionId, `FOLLOWER#${developerId}`));
  const presenceOf = (developerId: string) => w.db.get(agentSessionKey(ORG_A, session.sessionId, `PRESENCE#${developerId}`));
  const count = () => (w.db.get(metaKey) as Item).followerCount as number;
  const follow = (who: string, id = session.sessionId, orgId = ORG_A) => followSession(deps, w.caller(who, orgId), id);
  const unfollow = (who: string, id = session.sessionId, orgId = ORG_A) => unfollowSession(deps, w.caller(who, orgId), id);
  const presence = (who: string, id = session.sessionId, orgId = ORG_A) => recordPresence(deps, w.caller(who, orgId), id);
  const presenceNotices = () => rec.calls.filter((call) => call.channel === sessionChannel(ORG_A, session.sessionId)).flatMap((call) => call.events.map((event) => RealtimeNoticeSchema.parse(JSON.parse(event))));
  /** A change the sink is handed: the session needs a person. */
  const needsPerson = async (target: AgentSessionRecord = session) => {
    const sent = recorder();
    const change = {
      orgId: target.orgId, sessionId: target.sessionId, session: target, previous: target.summary, summary: { ...target.summary, status: "needs_person", needsPeople: [] }, summaryRevision: 5,
      statusChanged: true, stepChanged: false, ended: false, at: iso(w.clock.now),
    } as never;
    await createRealtimeSink({ realtime: sent.config() })({ documentClient: w.db, tableName: "state", now: () => w.clock.now }, change);
    return sent;
  };
  const feedTypes = (developerId: string) => w.db.find((item) => item.pk === changesKey(ORG_A, developerId, iso(T0), 0).pk).map((item) => (item.notice as { type: string }).type);
  return { p, w, deps, rec, made, session, metaKey, itemOf, presenceOf, count, follow, unfollow, presence, presenceNotices, needsPerson, feedTypes };
}

describe("following a session", () => {
  it("writes a follower item and counts it on the session, in one transaction, and answers that the caller follows", async () => {
    const f = world();
    expect(SessionFollowResponseSchema.parse(await f.follow(ARJUN))).toEqual({ following: true });
    expect(f.itemOf(ARJUN)).toMatchObject({ entityType: "AGENT_SESSION_FOLLOWER", orgId: ORG_A, sessionId: f.session.sessionId, developerId: ARJUN });
    expect(f.count()).toBe(1);
    // One transaction held the item and the count (never two writes with a gap between), and the session's revision was not touched.
    const transaction = f.w.db.transactions().at(-1)!;
    expect(transaction).toHaveLength(2);
    expect(f.w.db.commandNames().filter((name) => name === "TransactWriteCommand")).toHaveLength(1);
    expect((f.w.db.get(f.metaKey) as Item).revision).toBe(1);
  });

  it("is idempotent: following twice keeps one item, one count and writes nothing the second time", async () => {
    const f = world();
    await f.follow(ARJUN);
    const before = f.w.db.commandNames().length;
    expect(await f.follow(ARJUN)).toEqual({ following: true });
    expect(f.count()).toBe(1);
    expect(f.w.db.find((item) => String(item.sk).startsWith("FOLLOWER#"))).toHaveLength(1);
    expect(f.w.db.commandNames().slice(before).filter((name) => name === "TransactWriteCommand" || name === "PutCommand" || name === "UpdateCommand")).toEqual([]);
  });

  it("unfollows: the item goes and the count drops; unfollowing when not following writes nothing", async () => {
    const f = world();
    await f.follow(ARJUN);
    await f.follow(MIA);
    expect(await f.unfollow(ARJUN)).toEqual({ following: false });
    expect(f.itemOf(ARJUN)).toBeUndefined();
    expect(f.itemOf(MIA)).toBeDefined();
    expect(f.count()).toBe(1);
    const before = f.w.db.commandNames().length;
    expect(await f.unfollow(ARJUN)).toEqual({ following: false });
    expect(f.count()).toBe(1);
    expect(f.w.db.commandNames().slice(before).filter((name) => name !== "GetCommand" && name !== "QueryCommand" && name !== "BatchGetCommand")).toEqual([]);
  });

  it("removes a follow whose count had drifted to zero, and never takes the count below zero", async () => {
    const f = world();
    f.w.follower(ORG_A, f.session.sessionId, ARJUN);
    expect(f.count()).toBe(0);
    expect(await f.unfollow(ARJUN)).toEqual({ following: false });
    expect(f.itemOf(ARJUN)).toBeUndefined();
    expect(f.count()).toBe(0);
  });

  it("makes the owner follow their own session without an item, and the answer says so whichever way they ask", async () => {
    const f = world();
    expect(await f.follow(PRIYA)).toEqual({ following: true });
    expect(f.itemOf(PRIYA)).toBeUndefined();
    expect(f.count()).toBe(0);
    expect(await f.unfollow(PRIYA)).toEqual({ following: true });
    expect(f.count()).toBe(0);
    // A session taken over: the effective owner follows without an item, and the one who started it follows with one.
    const taken = f.w.seedSession({ currentOwner: ARJUN }).record as unknown as AgentSessionRecord;
    expect(await f.follow(ARJUN, taken.sessionId)).toEqual({ following: true });
    expect(f.w.db.get(agentSessionKey(ORG_A, taken.sessionId, `FOLLOWER#${ARJUN}`))).toBeUndefined();
    expect(await f.follow(PRIYA, taken.sessionId)).toEqual({ following: true });
    expect(f.w.db.get(agentSessionKey(ORG_A, taken.sessionId, `FOLLOWER#${PRIYA}`))).toBeDefined();
  });

  it("is for people who can view it: a viewer follows; someone with no level, another org's member and a bad id get NOT_FOUND, and nothing is written", async () => {
    const f = world();
    expect(await f.follow(MIA)).toEqual({ following: true });
    const written = () => f.w.db.find((item) => String(item.sk).startsWith("FOLLOWER#")).length;
    expect(written()).toBe(1);
    for (const [who, id, org] of [[ZED, f.session.sessionId, ORG_A], [BO, f.session.sessionId, ORG_B], [ARJUN, "ses_nonexistent0000000000", ORG_A], [ARJUN, "nonsense", ORG_A]] as const) {
      expect(await code(f.follow(who, id, org)), who).toMatchObject({ code: "NOT_FOUND" });
      expect(await code(f.unfollow(who, id, org)), who).toMatchObject({ code: "NOT_FOUND" });
    }
    expect(written()).toBe(1);
    expect(f.count()).toBe(1);
  });

  it("refuses the 201st follower with the plain words, lets existing followers follow again at the limit, and takes the next one after somebody leaves", async () => {
    const f = world();
    expect(SESSION_FOLLOWERS_MAX).toBe(200);
    const crowd = Array.from({ length: SESSION_FOLLOWERS_MAX }, (_, index) => `${String(index).padStart(4, "0")}${"e".repeat(60)}`);
    for (const who of crowd) f.w.member(ORG_A, who, "member");
    f.w.seedShare(ORG_A, f.session.sessionId, { kind: "org" }, "view");
    for (const who of crowd) await f.follow(who);
    expect(f.count()).toBe(200);
    expect(await code(f.follow(ARJUN))).toEqual({ code: "CONFIG_INVALID", message: FOLLOWER_LIMIT_TEXT });
    expect(f.itemOf(ARJUN)).toBeUndefined();
    expect(f.count()).toBe(200);
    expect(await f.follow(crowd[7]!)).toEqual({ following: true });
    await f.unfollow(crowd[3]!);
    expect(await f.follow(ARJUN)).toEqual({ following: true });
    expect(f.count()).toBe(200);
  }, 30_000);

  it("keeps an item written on an ended session until the session's own retention ends", async () => {
    const f = world();
    const ended = f.w.seedSession({ ended: true }).record as unknown as AgentSessionRecord;
    await f.follow(ARJUN, ended.sessionId);
    const item = f.w.db.get(agentSessionKey(ORG_A, ended.sessionId, `FOLLOWER#${ARJUN}`))!;
    expect(item.indexExpiresAt).toBe(Math.floor(Date.parse("2026-10-22T08:30:00.000Z") / 1000) + 365 * 86_400);
    await f.follow(ARJUN);
    expect(f.itemOf(ARJUN)!.indexExpiresAt).toBeUndefined();
  });

  it("when a follow is lost to the same person's other request, answers that they follow and counts once", async () => {
    const f = world();
    // The other request commits between this one's look and its write.
    let injected = false;
    const racing = {
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (!injected && command.constructor.name === "TransactWriteCommand") {
          injected = true;
          await f.follow(ARJUN);
        }
        return f.w.db.send(command);
      },
    };
    const reply = await followSession({ ...f.deps, documentClient: racing }, f.w.caller(ARJUN), f.session.sessionId);
    expect(reply).toEqual({ following: true });
    expect(f.count()).toBe(1);
  });
});

describe("following, when the table is not quiet", () => {
  /** A table that runs `before` once, just before the first transaction, as another request might. */
  const interfering = (f: ReturnType<typeof world>, before: () => Promise<void>) => {
    let done = false;
    return {
      send: async (command: { constructor: { name: string } }) => {
        if (!done && command.constructor.name === "TransactWriteCommand") { done = true; await before(); }
        return f.w.db.send(command as never);
      },
    };
  };

  it("says the session is gone when it vanished between the look and the write, and not that it has too many followers", async () => {
    const f = world();
    const racing = interfering(f, async () => { f.w.db.delete(f.metaKey); });
    expect(await code(followSession({ ...f.deps, documentClient: racing }, f.w.caller(ARJUN), f.session.sessionId))).toMatchObject({ code: "NOT_FOUND" });
    expect(f.itemOf(ARJUN)).toBeUndefined();
  });

  it("passes on a failure that is not a lost condition, to follow and to unfollow", async () => {
    const f = world();
    const broken = { send: async (command: { constructor: { name: string } }) => { if (command.constructor.name === "TransactWriteCommand") throw new Error("boom"); return f.w.db.send(command as never); } };
    await expect(followSession({ ...f.deps, documentClient: broken }, f.w.caller(ARJUN), f.session.sessionId)).rejects.toThrow("boom");
    await f.follow(ARJUN);
    await expect(unfollowSession({ ...f.deps, documentClient: broken }, f.w.caller(ARJUN), f.session.sessionId)).rejects.toThrow("boom");
    expect(f.itemOf(ARJUN)).toBeDefined();
  });

  it("when another request removed the follow first, takes nothing more off the count and says nothing was removed", async () => {
    const f = world();
    await f.follow(ARJUN);
    await f.follow(MIA);
    const racing = interfering(f, async () => { await f.unfollow(ARJUN); });
    expect(await removeFollower({ ...f.deps, documentClient: racing }, f.session, ARJUN)).toBe(false);
    expect(f.count()).toBe(1);
    expect(f.itemOf(MIA)).toBeDefined();
  });

  it("answers that it removed the follow whose count had drifted, and passes on a failure that is not a lost condition", async () => {
    const f = world();
    f.w.follower(ORG_A, f.session.sessionId, ARJUN);
    expect(await removeFollower(f.deps, f.session, ARJUN)).toBe(true);
    f.w.follower(ORG_A, f.session.sessionId, MIA);
    const broken = { send: async (command: { constructor: { name: string } }) => { if (command.constructor.name === "TransactWriteCommand") throw new Error("boom"); return f.w.db.send(command as never); } };
    await expect(removeFollower({ ...f.deps, documentClient: broken }, f.session, MIA)).rejects.toThrow("boom");
    expect(f.itemOf(MIA)).toBeDefined();
  });
});

describe("following, when another transaction holds the same items (TransactionConflict, Task 9 review)", () => {
  const conflict = (reasons: string[], times = 1) => ({ command: "TransactWriteCommand", error: { name: "TransactionCanceledException", cancellationReasons: reasons.map((Code) => ({ Code })) }, times });
  const transactions = (f: ReturnType<typeof world>) => f.w.db.commandNames().filter((name) => name === "TransactWriteCommand").length;

  it("retries an unfollow that hit a conflict, so the count still drops (it never falls through to a lone delete)", async () => {
    const f = world();
    await f.follow(ARJUN);
    await f.follow(MIA);
    f.w.db.injectFault(conflict(["None", "TransactionConflict"]));
    expect(await f.unfollow(ARJUN)).toEqual({ following: false });
    expect(f.itemOf(ARJUN)).toBeUndefined();
    expect(f.count()).toBe(1);
    expect(f.w.db.commandNames()).not.toContain("DeleteCommand");
  });

  it("gives up after a bounded number of conflicts with a retryable error, and leaves the follow and the count as they were", async () => {
    const f = world();
    await f.follow(ARJUN);
    const before = transactions(f);
    f.w.db.injectFault(conflict(["TransactionConflict", "TransactionConflict"], 50));
    expect(await code(f.unfollow(ARJUN))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(transactions(f) - before).toBe(4);
    expect(f.itemOf(ARJUN)).toBeDefined();
    expect(f.count()).toBe(1);
    expect(f.w.db.commandNames()).not.toContain("DeleteCommand");
  });

  it("takes the lone delete only when the count refused and the follow was there: a follow that vanished is not removed again", async () => {
    const f = world();
    await f.follow(ARJUN);
    // The follow's own condition failed (someone removed it): nothing is deleted on the side.
    f.w.db.injectFault(conflict(["ConditionalCheckFailed", "None"]));
    expect(await removeFollower(f.deps, f.session, ARJUN)).toBe(false);
    expect(f.w.db.commandNames()).not.toContain("DeleteCommand");
    expect(f.itemOf(ARJUN)).toBeDefined();
  });

  it("passes on a cancellation that is neither a lost condition nor a conflict (a throttled transaction), and deletes nothing on the side", async () => {
    const f = world();
    await f.follow(ARJUN);
    f.w.db.injectFault(conflict(["ThrottlingError", "None"]));
    await expect(removeFollower(f.deps, f.session, ARJUN)).rejects.toMatchObject({ name: "TransactionCanceledException" });
    expect(f.w.db.commandNames()).not.toContain("DeleteCommand");
    expect(f.itemOf(ARJUN)).toBeDefined();
  });

  it("retries a follow that hit a conflict, and writes one item and one count", async () => {
    const f = world();
    f.w.db.injectFault(conflict(["None", "TransactionConflict"]));
    expect(await f.follow(ARJUN)).toEqual({ following: true });
    expect(f.count()).toBe(1);
    expect(f.w.db.find((item) => String(item.sk).startsWith("FOLLOWER#"))).toHaveLength(1);
  });

  it("answers a follow that keeps hitting conflicts with a retryable error, not a raw failure, and writes nothing", async () => {
    const f = world();
    f.w.db.injectFault(conflict(["TransactionConflict", "TransactionConflict"], 50));
    expect(await code(f.follow(ARJUN))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(f.itemOf(ARJUN)).toBeUndefined();
    expect(f.count()).toBe(0);
  });

  it("treats the whole-call TransactionConflictException the same way", async () => {
    const f = world();
    f.w.db.injectFault({ command: "TransactWriteCommand", error: { name: "TransactionConflictException" } });
    expect(await f.follow(ARJUN)).toEqual({ following: true });
    expect(f.count()).toBe(1);
  });
});

describe("the people who follow are told", () => {
  it("puts a notice in a follower's changes feed when the session needs a person, and none after they unfollow", async () => {
    const f = world();
    await f.follow(ARJUN);
    const first = await f.needsPerson();
    expect(first.calls.some((call) => call.channel.includes("/u/"))).toBe(true);
    expect(f.feedTypes(ARJUN)).toEqual(["session.updated"]);
    await f.unfollow(ARJUN);
    f.w.db.find((item) => String(item.pk).includes("CHANGES#") && String(item.pk).includes(ARJUN)).forEach((item) => f.w.db.delete({ pk: item.pk as string, sk: item.sk as string }));
    await f.needsPerson();
    expect(f.feedTypes(ARJUN)).toEqual([]);
  });

  it("drops a follower who lost access, and takes them off the count", async () => {
    const f = world();
    await f.follow(ARJUN);
    await f.follow(MIA);
    expect(f.count()).toBe(2);
    // Arjun left the company: positively without access.
    f.w.db.delete(orgMemberKey(ORG_A, ARJUN));
    await f.needsPerson();
    expect(f.itemOf(ARJUN)).toBeUndefined();
    expect(f.itemOf(MIA)).toBeDefined();
    expect(f.count()).toBe(1);
  });

  it("takes a share's follower off the count too when removing the share leaves them without access", async () => {
    const f = world();
    const shared = f.w.seedSession({ project: null }).record as unknown as AgentSessionRecord;
    f.w.seedShare(ORG_A, shared.sessionId, { kind: "member", developerId: ZED }, "view");
    await f.follow(ZED, shared.sessionId);
    expect((f.w.db.get(agentSessionKey(ORG_A, shared.sessionId, "META")) as Item).followerCount).toBe(1);
    const { deleteSessionShare } = await import("../../packages/broker/src/agent-sessions/shares.js");
    await deleteSessionShare({ ...f.deps, signInStore: f.w.signInStore }, f.w.caller(PRIYA), shared.sessionId, `MEMBER#${ZED}`);
    expect(f.w.db.get(agentSessionKey(ORG_A, shared.sessionId, `FOLLOWER#${ZED}`))).toBeUndefined();
    expect((f.w.db.get(agentSessionKey(ORG_A, shared.sessionId, "META")) as Item).followerCount).toBe(0);
  });

  it("removeFollower reports whether it removed one, and leaves another session's follower and count alone", async () => {
    const f = world();
    const other = f.w.seedSession().record as unknown as AgentSessionRecord;
    await f.follow(ARJUN);
    await f.follow(ARJUN, other.sessionId);
    expect(await removeFollower(f.deps, f.session, ARJUN)).toBe(true);
    expect(await removeFollower(f.deps, f.session, ARJUN)).toBe(false);
    expect(f.w.db.get(agentSessionKey(ORG_A, other.sessionId, `FOLLOWER#${ARJUN}`))).toBeDefined();
    expect((f.w.db.get(agentSessionKey(ORG_A, other.sessionId, "META")) as Item).followerCount).toBe(1);
    expect(f.count()).toBe(0);
  });
});

describe("who is looking now", () => {
  it("shows a person who sent a heartbeat, and drops them 90 seconds after the last one with nothing else to do", async () => {
    const f = world();
    expect(PRESENCE_TTL_SECONDS).toBe(90);
    expect(PRESENCE_HEARTBEAT_SECONDS).toBe(30);
    const first = SessionPresenceResponseSchema.parse(await f.presence(ARJUN));
    expect(first.viewingNow).toEqual([{ developerId: ARJUN, name: "Arjun" }]);
    expect(f.presenceOf(ARJUN)).toMatchObject({ entityType: "AGENT_SESSION_PRESENCE", orgId: ORG_A, sessionId: f.session.sessionId, developerId: ARJUN, name: "Arjun", at: iso(T0), indexExpiresAt: Math.floor(T0 / 1000) + 90 });
    for (const [after, shown] of [[0, true], [89_999, true], [90_000, false], [91_000, false]] as const) {
      f.w.clock.now = T0 + after;
      expect((await viewingNow(f.deps, f.session, f.w.clock.now)).map((who) => who.developerId), `${String(after)} ms`).toEqual(shown ? [ARJUN] : []);
    }
  });

  it("a heartbeat renews it, and everyone who is there is in the list, in a steady order", async () => {
    const f = world();
    await f.presence(MIA);
    f.w.clock.now = T0 + 60_000;
    await f.presence(ARJUN);
    f.w.clock.now = T0 + 100_000;
    // Mia's last heartbeat is 100 s old: gone. Arjun's is 40 s old.
    expect((await viewingNow(f.deps, f.session, f.w.clock.now)).map((who) => who.name)).toEqual(["Arjun"]);
    await f.presence(MIA);
    expect((await viewingNow(f.deps, f.session, f.w.clock.now)).map((who) => who.name)).toEqual(["Arjun", "Mia"]);
    expect(f.w.db.find((item) => String(item.sk).startsWith("PRESENCE#"))).toHaveLength(2);
  });

  it("checks the time on read: an item the table still holds past its 90 seconds is not shown, and one with no readable time never is", async () => {
    const f = world();
    f.w.db.set({ ...agentSessionKey(ORG_A, f.session.sessionId, `PRESENCE#${ARJUN}`), entityType: "AGENT_SESSION_PRESENCE", orgId: ORG_A, sessionId: f.session.sessionId, developerId: ARJUN, name: "Arjun", at: iso(T0 - 91_000), indexExpiresAt: 1 });
    f.w.db.set({ ...agentSessionKey(ORG_A, f.session.sessionId, `PRESENCE#${MIA}`), entityType: "AGENT_SESSION_PRESENCE", orgId: ORG_A, sessionId: f.session.sessionId, developerId: MIA, name: "Mia", at: "not a time" });
    f.w.db.set({ ...agentSessionKey(ORG_A, f.session.sessionId, `PRESENCE#${MAX}`), entityType: "AGENT_SESSION_PRESENCE", orgId: ORG_A, sessionId: f.session.sessionId, developerId: MAX, name: "Max", at: iso(T0 - 10_000) });
    expect(await viewingNow(f.deps, f.session, T0)).toEqual([{ developerId: MAX, name: "Max" }]);
  });

  it("lists people by name, whatever order their ids sort in", async () => {
    const f = world();
    await f.presence(MIA);
    await f.presence(MAX);
    expect((await viewingNow(f.deps, f.session, f.w.clock.now)).map((who) => who.name)).toEqual(["Max", "Mia"]);
  });

  it("leaves out an item whose person or name doesn't read", async () => {
    const f = world();
    const put = (id: string, extra: Item) => f.w.db.set({ ...agentSessionKey(ORG_A, f.session.sessionId, `PRESENCE#${id}`), entityType: "AGENT_SESSION_PRESENCE", orgId: ORG_A, sessionId: f.session.sessionId, developerId: id, name: "Someone", at: iso(T0), ...extra });
    put(ARJUN, { name: "" });
    put(MIA, { developerId: "not-a-developer" });
    put(MAX, { name: "x".repeat(500) });
    put(OLA, {});
    expect((await viewingNow(f.deps, f.session, T0)).map((who) => who.developerId)).toEqual([OLA]);
  });

  it("looks at no more than 500 presence items in one read, a page of 100 at a time", async () => {
    const f = world();
    const stale = Array.from({ length: 500 }, (_, n) => `${String(n).padStart(3, "0")}${"a".repeat(61)}`);
    for (const id of stale) f.w.db.set({ ...agentSessionKey(ORG_A, f.session.sessionId, `PRESENCE#${id}`), entityType: "AGENT_SESSION_PRESENCE", orgId: ORG_A, sessionId: f.session.sessionId, developerId: id, name: "Old", at: iso(T0 - 600_000) });
    f.w.db.set({ ...agentSessionKey(ORG_A, f.session.sessionId, `PRESENCE#${hex("f")}`), entityType: "AGENT_SESSION_PRESENCE", orgId: ORG_A, sessionId: f.session.sessionId, developerId: hex("f"), name: "Late", at: iso(T0) });
    const before = f.w.db.commandNames().length;
    expect(await viewingNow(f.deps, f.session, T0)).toEqual([]);
    expect(f.w.db.commandNames().slice(before).filter((name) => name === "QueryCommand")).toHaveLength(5);
    // Fewer stale items and the late one is reached.
    for (const id of stale.slice(0, 100)) f.w.db.delete(agentSessionKey(ORG_A, f.session.sessionId, `PRESENCE#${id}`));
    expect((await viewingNow(f.deps, f.session, T0)).map((who) => who.name)).toEqual(["Late"]);
  });

  it("shows at most 20 people", async () => {
    const f = world();
    for (let n = 0; n < 25; n += 1) {
      const who = `${String(n).padStart(2, "0")}${"d".repeat(62)}`;
      f.w.db.set({ ...agentSessionKey(ORG_A, f.session.sessionId, `PRESENCE#${who}`), entityType: "AGENT_SESSION_PRESENCE", orgId: ORG_A, sessionId: f.session.sessionId, developerId: who, name: `Person ${String(n).padStart(2, "0")}`, at: iso(T0) });
    }
    const shown = await viewingNow(f.deps, f.session, T0);
    expect(shown).toHaveLength(20);
    expect(shown[0]!.name).toBe("Person 00");
    expect(shown[19]!.name).toBe("Person 19");
  });

  it("tells the session's channel, and only it, when the person wasn't there; a later heartbeat tells nobody; one after the 90 seconds tells again", async () => {
    const f = world();
    await f.presence(ARJUN);
    expect(f.rec.calls.map((call) => call.channel)).toEqual([sessionChannel(ORG_A, f.session.sessionId)]);
    expect(f.presenceNotices()).toEqual([{ type: "session.updated", sessionId: f.session.sessionId, revision: f.session.summaryRevision }]);
    f.w.clock.now = T0 + 30_000;
    await f.presence(ARJUN);
    f.w.clock.now = T0 + 60_000;
    await f.presence(ARJUN);
    expect(f.rec.calls).toHaveLength(1);
    // Somebody else arriving is news.
    await f.presence(MIA);
    expect(f.rec.calls).toHaveLength(2);
    // A person whose last heartbeat is past 90 seconds but whose item the table has not deleted yet is new again.
    f.w.clock.now = T0 + 60_000 + 91_000;
    await f.presence(ARJUN);
    expect(f.rec.calls).toHaveLength(3);
    // Nothing is written to anyone's changes feed for it.
    expect(f.w.db.find((item) => String(item.pk).includes("CHANGES#"))).toEqual([]);
  });

  it("tells the summary's revision, as the sink's notices do, not the session record's", async () => {
    const f = world();
    f.w.db.set({ ...f.w.db.get(f.metaKey)!, summaryRevision: 7, revision: 3 });
    await f.presence(MIA);
    expect(f.presenceNotices()).toEqual([{ type: "session.updated", sessionId: f.session.sessionId, revision: 7 }]);
  });

  it("does nothing more than keep the item when there is no events API, and a publish that fails changes nothing", async () => {
    const quiet = world({ realtime: false });
    expect(await quiet.presence(ARJUN)).toEqual({ viewingNow: [{ developerId: ARJUN, name: "Arjun" }] });
    const failing = world();
    const logs: Array<Record<string, unknown>> = [];
    const bad = { ...failing.deps, log: (entry: Record<string, unknown>) => logs.push(entry), realtimePublish: { ...failing.rec.config(), fetch: (async () => new Response("no", { status: 500 })) as unknown as typeof fetch } };
    expect((await recordPresence(bad, failing.w.caller(ARJUN), failing.session.sessionId)).viewingNow).toHaveLength(1);
    expect(failing.presenceOf(ARJUN)).toBeDefined();
    expect(logs).toContainEqual({ event: "realtime.publish_failed", channelKind: "session", error: "http_500" });
  });

  it("is for people who can view it: no level and another org get NOT_FOUND and leave no item", async () => {
    const f = world();
    for (const [who, org] of [[ZED, ORG_A], [BO, ORG_B]] as const) expect(await code(f.presence(who, f.session.sessionId, org)), who).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(f.presence(ARJUN, "nonsense"))).toMatchObject({ code: "NOT_FOUND" });
    expect(f.w.db.find((item) => String(item.sk).startsWith("PRESENCE#"))).toEqual([]);
    expect(f.rec.calls).toEqual([]);
    // A viewer on the project may watch, and so show up.
    expect((await f.presence(MIA)).viewingNow).toEqual([{ developerId: MIA, name: "Mia" }]);
    // The heartbeat of a person who is an org admin with no grant counts as well.
    expect((await f.presence(OLA)).viewingNow.map((who) => who.name)).toEqual(["Mia", "Ola"]);
  });

  it("keeps a name in the item that has no control or direction characters, and a missing name reads as a member", async () => {
    const f = world();
    const caller = { ...f.w.caller(ARJUN), name: "Ar‮jun\u0007" };
    await recordPresence(f.deps, caller, f.session.sessionId);
    expect(f.presenceOf(ARJUN)!.name).toBe("Arjun");
    await recordPresence(f.deps, { ...f.w.caller(MIA), name: "‮" }, f.session.sessionId);
    expect(f.presenceOf(MIA)!.name).toBe("a member");
  });
});

describe("the session's view and the routes", () => {
  const read = () => {
    const f = world();
    const deps: SessionReadDependencies = {
      documentClient: f.w.db, tableName: "state", now: () => f.w.clock.now, projectMembers: f.w.members, signInStore: f.w.signInStore, origin: CELL, cursorKey: "k".repeat(64),
      taskView: async (task) => ({ taskId: task.taskId, title: "Bump the Stripe SDK", project: task.project, status: "RUNNING", startingRevision: 1, client: "test", shared: false, createdAt: "2026-10-22T08:00:00.000Z", updatedAt: "2026-10-22T08:05:00.000Z", events: [] }) as never,
    };
    return { f, deps };
  };

  it("shows how many follow and who is looking, and whether you follow (the owner always does)", async () => {
    const { f, deps } = read();
    await f.follow(ARJUN);
    await f.follow(MIA);
    await f.presence(MIA);
    const arjun = await sessionView(deps, f.w.caller(ARJUN), f.session.sessionId);
    expect(arjun.followers).toBe(2);
    expect(arjun.viewingNow).toEqual([{ developerId: MIA, name: "Mia" }]);
    expect(arjun.you.following).toBe(true);
    expect((await sessionView(deps, f.w.caller(PRIYA), f.session.sessionId)).you.following).toBe(true);
    expect((await sessionView(deps, f.w.caller(MAX), f.session.sessionId)).you.following).toBe(false);
    f.w.clock.now += 120_000;
    expect((await sessionView(deps, f.w.caller(MAX), f.session.sessionId)).viewingNow).toEqual([]);
  });

  it("answers POST and DELETE …/follow and POST …/presence through the session routes, and no other method", async () => {
    const { f, deps } = read();
    const call = (who: string, method: string, path: string, body?: string) => routeAgentSessionRequest({ ...deps, realtimePublish: f.rec.config() }, f.w.caller(who), { method, path, headers: {}, requestId: "r", ...(body === undefined ? {} : { body }) }, new URL(`${CELL}${path}`));
    const base = `/v1/app/sessions/${f.session.sessionId}`;
    expect(await call(ARJUN, "POST", `${base}/follow`)).toEqual({ following: true });
    expect(await call(ARJUN, "POST", `${base}/follow`, "{}")).toEqual({ following: true });
    expect(f.count()).toBe(1);
    expect(await call(ARJUN, "DELETE", `${base}/follow`)).toEqual({ following: false });
    expect(await call(MIA, "POST", `${base}/presence`)).toEqual({ viewingNow: [{ developerId: MIA, name: "Mia" }] });
    expect(f.rec.calls).toHaveLength(1);
    for (const [method, suffix] of [["GET", "follow"], ["PUT", "follow"], ["PATCH", "follow"], ["GET", "presence"], ["DELETE", "presence"], ["PUT", "presence"]] as const) {
      expect(await code(call(ARJUN, method, `${base}/${suffix}`)), `${method} ${suffix}`).toMatchObject({ code: "NOT_FOUND" });
    }
    expect(await code(call(ZED, "POST", `${base}/follow`))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(call(ARJUN, "POST", `/v1/app/sessions/nonsense/follow`))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(call(ARJUN, "POST", `${base}/followers`))).toMatchObject({ code: "NOT_FOUND" });
  });
});
