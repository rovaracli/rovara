// Plan 5 Task 8: a session's change becomes notices (ids and numbers only) on the events API and in each person's changes feed. The feed is written first; the publish is
// bounded; who hears what follows the session's own rules; followers are checked again; `GET /v1/app/changes` and the token route answer only for the caller.
import { createHash } from "node:crypto";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { Sha256 } from "@aws-crypto/sha256-js";
import { SignatureV4 } from "@smithy/signature-v4";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANGES_FEED_DAYS, agentSessionKey, changesKey, type AgentSessionRecord, type OrgId } from "@rovara-code/contracts";
import { REALTIME_TOKEN_PROJECTS_MAX, RealtimeNoticeSchema, RealtimeTokenResponseSchema, parseRealtimeChannel, projectChannel, projectSegment, sessionChannel, userChannel, type RealtimeNotice } from "@agentx/cloud-contracts";
import { notifySessionChange, registerSessionNoticeSink, type SessionChange } from "../../packages/broker/src/agent-sessions/notice-sink.js";
import { routeAgentSessionRequest } from "../../packages/broker/src/agent-sessions/routes.js";
import { readChanges, writeChanges } from "../../packages/broker/src/realtime/changes.js";
import { noticesFor, publishNotices, signedHeaders, type RealtimeConfig } from "../../packages/broker/src/realtime/publish.js";
import { createRealtimeSink, installRealtimeSink, realtimeConfigFromEnvironment } from "../../packages/broker/src/realtime/sink.js";
import { realtimeSocketEndpoint } from "../../packages/broker/src/realtime/token.js";
import { ARJUN, MAX, MIA, OLA, ORG_A, ORG_B, PRIYA, T0, ZED, sessionWorld } from "../support/agent-session-world.js";
import { randomUUID } from "node:crypto";
import { unregisterAgentSessionTaskHandlers } from "../../packages/broker/src/agent-sessions/index.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import { iso, projectorWorld } from "../support/agent-session-projector-world.js";

type Item = Record<string, unknown>;
const ENDPOINT = "https://abcdefghij.appsync-api.us-east-1.amazonaws.com/event";
const hex = (digit: string) => digit.repeat(64);
afterEach(() => registerSessionNoticeSink(undefined));

interface Call { url: string; headers: Record<string, string>; channel: string; events: string[] }
/** A fetch that records each publish; `behave` can make it fail or hang. */
function recorder(behave?: (call: Call) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const body = JSON.parse(init.body) as { channel: string; events: string[] };
    const call = { url, headers: init.headers, channel: body.channel, events: body.events };
    calls.push(call);
    return behave === undefined ? new Response("{}", { status: 200 }) : behave(call);
  }) as unknown as typeof fetch;
  const config = (): RealtimeConfig => ({ endpoint: ENDPOINT, region: "us-east-1", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", sessionToken: "token" }), fetch: fetchImpl });
  return { calls, config };
}
const noticesOn = (calls: Call[], channel: string) => calls.filter((call) => call.channel === channel).flatMap((call) => call.events.map((event) => RealtimeNoticeSchema.parse(JSON.parse(event))));
const feedOf = (db: ReturnType<typeof sessionWorld>["db"], developerId: string, orgId: OrgId = ORG_A) => db.find((item) => item.pk === changesKey(orgId, developerId, iso(T0), 0).pk);

/** An open task session of Priya's (web, cloud) that a closed task ends: the refresh finds it ended. */
function endedTask() {
  const p = projectorWorld();
  const s = p.open();
  p.operation(s.workspaceId, "task", "SUCCEEDED");
  p.patchTask(s.taskId, { closedAt: "2026-10-22T08:30:00.000Z" });
  return { p, s };
}

describe("who hears a session's change", () => {
  it("tells the session's channel, its project's, and the owner's and each follower's own channel, with ids and numbers only", async () => {
    const { p, s } = endedTask();
    p.w.follower(ORG_A, s.sessionId, ARJUN);
    const rec = recorder();
    installRealtimeSink({ realtime: rec.config() });
    await p.refresh(s.sessionId);
    expect(new Set(rec.calls.map((call) => call.channel))).toEqual(new Set([sessionChannel(ORG_A, s.sessionId), projectChannel(ORG_A, "web"), userChannel(ORG_A, PRIYA), userChannel(ORG_A, ARJUN)]));
    const revision = p.sessionOf(s.sessionId).summaryRevision;
    expect(noticesOn(rec.calls, sessionChannel(ORG_A, s.sessionId))).toEqual([{ type: "session.updated", sessionId: s.sessionId, revision }]);
    expect(noticesOn(rec.calls, projectChannel(ORG_A, "web"))).toEqual([{ type: "session.updated", sessionId: s.sessionId, revision }]);
    expect(noticesOn(rec.calls, userChannel(ORG_A, PRIYA))).toEqual([{ type: "session.updated", sessionId: s.sessionId, revision }, { type: "home.changed", revision }]);
    expect(noticesOn(rec.calls, userChannel(ORG_A, ARJUN))).toEqual([{ type: "session.updated", sessionId: s.sessionId, revision }]);
    // No title, text, name or cost in any payload, and no channel carries a person's id or the project's name.
    const wire = JSON.stringify(rec.calls);
    for (const word of ["Bump the Stripe SDK", "Priya", "Arjun", "costUsd", "cost", "title", PRIYA, ARJUN, "web\""]) expect(wire, word).not.toContain(word);
    // The feed holds the owner's two notices and the follower's one, and nobody else's.
    expect(feedOf(p.w.db, PRIYA).map((item) => (item.notice as { type: string }).type).sort()).toEqual(["home.changed", "session.updated"]);
    expect(feedOf(p.w.db, ARJUN).map((item) => (item.notice as { type: string }).type)).toEqual(["session.updated"]);
    expect(p.w.db.find((item) => String(item.pk).includes("#CHANGES#"))).toHaveLength(3);
    // Each item is kept a week from the write, says when the change was made and which org it is in, and sits where the feed reads it.
    const summaryAt = p.sessionOf(s.sessionId).summary.computedAt;
    for (const item of feedOf(p.w.db, PRIYA)) {
      expect(item).toMatchObject({ entityType: "CHANGE_NOTICE", orgId: ORG_A, at: summaryAt, indexExpiresAt: Math.floor(p.w.clock.now / 1000) + CHANGES_FEED_DAYS * 86_400 });
      expect(item.sk).toMatch(new RegExp(`^${summaryAt.replace(/[.]/g, "\\.")}#\\d{6}$`));
    }
  });

  it("never tells a project's channel about a chain session, a local one, a task visible only through a share, or a task with a denied person; the session's own channel still hears", async () => {
    const p = projectorWorld();
    const { w } = p;
    const chain = w.seedSession({ kind: "chain" });
    const local = w.seedSession({ kind: "local" });
    const shared = w.seedSession({ project: null });
    w.seedShare(ORG_A, shared.sessionId, { kind: "member", developerId: ARJUN }, "view");
    const denied = w.seedSession({ people: [{ developerId: MIA, role: "denied" }] });
    const unreadable = w.seedSession();
    w.db.set({ pk: `DEVTASK#${unreadable.taskId}`, sk: "PEOPLE", schemaVersion: 2, people: "nonsense" });
    const plain = w.seedSession();
    for (const [name, made, projectHears] of [["chain", chain, false], ["local", local, false], ["shared only", shared, false], ["denied", denied, false], ["unreadable people", unreadable, false], ["plain task", plain, true]] as const) {
      const rec = recorder();
      const session = made.record as unknown as AgentSessionRecord;
      await createRealtimeSink({ realtime: rec.config() })({ documentClient: w.db, tableName: "state", now: () => w.clock.now }, changeOf(session, { statusChanged: true }));
      expect(rec.calls.some((call) => call.channel === sessionChannel(ORG_A, session.sessionId)), name).toBe(true);
      expect(rec.calls.some((call) => call.channel === projectChannel(ORG_A, "web")), name).toBe(projectHears);
    }
  });

  it("tells the people a decision waits on, before and after, and the owner's Home, when who is needed changes", async () => {
    const p = projectorWorld();
    const made = p.w.seedSession();
    const session = made.record as unknown as AgentSessionRecord;
    const rec = recorder();
    const deps = { documentClient: p.w.db, tableName: "state", now: () => p.w.clock.now };
    // Arjun was needed and is not any more; Mia is needed now; "Someone" is not a developer id and is told to nobody.
    await createRealtimeSink({ realtime: rec.config() })(deps, changeOf(session, { statusChanged: false, previous: { needsPeople: [ARJUN] }, summary: { status: "needs_person", needsPeople: [MIA, "Someone"] } }));
    for (const person of [ARJUN, MIA, PRIYA]) expect(noticesOn(rec.calls, userChannel(ORG_A, person)).map((notice) => notice.type).sort(), person).toEqual(["home.changed", "session.updated"]);
    expect(new Set(rec.calls.map((call) => call.channel))).toEqual(new Set([sessionChannel(ORG_A, session.sessionId), projectChannel(ORG_A, "web"), userChannel(ORG_A, PRIYA), userChannel(ORG_A, ARJUN), userChannel(ORG_A, MIA)]));
  });

  it("tells only the owner of a change that moved nothing a person is waiting on (a step or a cost)", async () => {
    const p = projectorWorld();
    const session = p.w.seedSession().record as unknown as AgentSessionRecord;
    p.w.follower(ORG_A, session.sessionId, ARJUN);
    const rec = recorder();
    await createRealtimeSink({ realtime: rec.config() })({ documentClient: p.w.db, tableName: "state", now: () => p.w.clock.now }, changeOf(session, { statusChanged: false, previous: { needsPeople: [MIA] }, summary: { status: "running", needsPeople: [MIA] } }));
    expect(noticesOn(rec.calls, userChannel(ORG_A, PRIYA))).toEqual([{ type: "session.updated", sessionId: session.sessionId, revision: 5 }]);
    expect(rec.calls.map((call) => call.channel).sort()).toEqual([sessionChannel(ORG_A, session.sessionId), projectChannel(ORG_A, "web"), userChannel(ORG_A, PRIYA)].sort());
  });
});

/** A change of a session, as the refresh hands it to the sink. */
function changeOf(session: AgentSessionRecord, over: { statusChanged?: boolean; ended?: boolean; previous?: { needsPeople: string[] }; summary?: { status: string; needsPeople: string[] } } = {}): SessionChange {
  return {
    orgId: session.orgId, sessionId: session.sessionId, session,
    previous: { ...session.summary, ...(over.previous ?? {}) }, summary: { ...session.summary, ...(over.summary ?? {}) } as SessionChange["summary"],
    summaryRevision: 5, statusChanged: over.statusChanged ?? false, stepChanged: false, ended: over.ended ?? false, at: iso(T0),
  };
}

describe("followers", () => {
  it("are told when the session needs a person, paused, stopped, is waiting or ended, and not of other changes", async () => {
    for (const [status, ended, told] of [["needs_person", false, true], ["paused", false, true], ["stopped", false, true], ["waiting", false, true], ["succeeded", true, true], ["failed", false, true], ["cancelled", false, true], ["running", false, false], ["starting", false, false]] as const) {
      const p = projectorWorld();
      const session = p.w.seedSession().record as unknown as AgentSessionRecord;
      p.w.follower(ORG_A, session.sessionId, ARJUN);
      const rec = recorder();
      await createRealtimeSink({ realtime: rec.config() })({ documentClient: p.w.db, tableName: "state", now: () => p.w.clock.now }, changeOf(session, { statusChanged: true, ended, summary: { status, needsPeople: [] } }));
      expect(rec.calls.some((call) => call.channel === userChannel(ORG_A, ARJUN)), status).toBe(told);
    }
    // A change of status that did not change the status (a step) tells no follower, even into a status they would hear.
    const p = projectorWorld();
    const session = p.w.seedSession().record as unknown as AgentSessionRecord;
    p.w.follower(ORG_A, session.sessionId, ARJUN);
    const rec = recorder();
    await createRealtimeSink({ realtime: rec.config() })({ documentClient: p.w.db, tableName: "state", now: () => p.w.clock.now }, changeOf(session, { statusChanged: false, summary: { status: "needs_person", needsPeople: [] } }));
    expect(rec.calls.some((call) => call.channel === userChannel(ORG_A, ARJUN))).toBe(false);
  });

  it("are checked again: one who can no longer see the session hears nothing and their follow is deleted; one who still can hears", async () => {
    const p = projectorWorld();
    const session = p.w.seedSession().record as unknown as AgentSessionRecord;
    for (const who of [ARJUN, MIA, ZED, OLA]) p.w.follower(ORG_A, session.sessionId, who);
    const rec = recorder();
    await createRealtimeSink({ realtime: rec.config() })({ documentClient: p.w.db, tableName: "state", now: () => p.w.clock.now }, changeOf(session, { statusChanged: true, summary: { status: "needs_person", needsPeople: [] } }));
    // Arjun (contributor) and Mia (viewer) and Ola (an org admin) may see it. Zed has no grant on web and no share: the read-only path can't tell whether web's Slack
    // channel has him, so he is not told this time, and his follow stays (Task 8 review, ruling 3).
    for (const who of [ARJUN, MIA, OLA]) expect(rec.calls.some((call) => call.channel === userChannel(ORG_A, who)), who).toBe(true);
    expect(rec.calls.some((call) => call.channel === userChannel(ORG_A, ZED))).toBe(false);
    expect(feedOf(p.w.db, ZED)).toEqual([]);
    expect(p.w.db.get(agentSessionKey(ORG_A, session.sessionId, `FOLLOWER#${ZED}`))).toBeDefined();
    for (const who of [ARJUN, MIA, OLA]) expect(p.w.db.get(agentSessionKey(ORG_A, session.sessionId, `FOLLOWER#${who}`)), who).toBeDefined();
  });

  it("are dropped only when the check positively says they lost access: someone who left the company, or a Task People denial; one the read-only path can't decide is kept and not told", async () => {
    const p = projectorWorld();
    const GONE = hex("8");
    const session = p.w.seedSession({ people: [{ developerId: MIA, role: "denied" }, { developerId: ZED, role: "denied" }] }).record as unknown as AgentSessionRecord;
    const undecided = p.w.seedSession().record as unknown as AgentSessionRecord;
    const sharedToProject = p.w.seedSession({ project: null }).record as unknown as AgentSessionRecord;
    p.w.seedShare(ORG_A, sharedToProject.sessionId, { kind: "project", project: "ops" }, "view");
    const NEWCOMER = hex("7");
    p.w.member(ORG_A, NEWCOMER, "member");
    for (const [made, who] of [[session, ARJUN], [session, MIA], [session, ZED], [session, GONE], [undecided, ZED], [undecided, GONE], [sharedToProject, NEWCOMER], [sharedToProject, GONE]] as const) p.w.follower(ORG_A, made.sessionId, who);
    const logs: Array<Record<string, unknown>> = [];
    const told = async (made: AgentSessionRecord) => {
      const rec = recorder();
      await createRealtimeSink({ realtime: rec.config() })({ documentClient: p.w.db, tableName: "state", now: () => p.w.clock.now, log: (entry) => logs.push(entry) }, changeOf(made, { statusChanged: true, summary: { status: "needs_person", needsPeople: [] } }));
      return (who: string) => rec.calls.some((call) => call.channel === userChannel(ORG_A, who));
    };
    const kept = (made: AgentSessionRecord, who: string) => p.w.db.get(agentSessionKey(ORG_A, made.sessionId, `FOLLOWER#${who}`)) !== undefined;
    const first = await told(session);
    // Denied (Mia, and Zed whom the Slack channel could not save from a denial) and gone: dropped. Arjun: told.
    expect(first(ARJUN)).toBe(true);
    for (const who of [MIA, ZED, GONE]) { expect(first(who), who).toBe(false); expect(kept(session, who), who).toBe(false); }
    expect(kept(session, ARJUN)).toBe(true);
    // Zed on a plain web session: not told, follow kept. Gone: dropped.
    const second = await told(undecided);
    expect(second(ZED)).toBe(false);
    expect(kept(undecided, ZED)).toBe(true);
    // It is said, with a count and no name.
    expect(logs).toContainEqual({ event: "realtime.followers_undecided", sessionId: undecided.sessionId, undecided: 1 });
    expect(kept(undecided, GONE)).toBe(false);
    // A share to another project the person may be in through its Slack channel: undecided, kept.
    const third = await told(sharedToProject);
    expect(third(NEWCOMER)).toBe(false);
    expect(kept(sharedToProject, NEWCOMER)).toBe(true);
    expect(kept(sharedToProject, GONE)).toBe(false);
  });

  it("are grouped by the facts that decide their level: followers alike in those are resolved once", async () => {
    const p = projectorWorld();
    const made = p.w.seedSession();
    const session = made.record as unknown as AgentSessionRecord;
    p.w.seedShare(ORG_A, session.sessionId, { kind: "org" }, "view");
    const crowd = Array.from({ length: 6 }, (_, index) => hex(String(index + 1)));
    for (const who of crowd) { p.w.member(ORG_A, who, "member"); p.w.follower(ORG_A, session.sessionId, who); }
    let shareReads = 0;
    const counting = { send: async (command: { constructor: { name: string }; input: { ExpressionAttributeValues?: Record<string, unknown> } }) => {
      if (command.constructor.name === "QueryCommand" && command.input.ExpressionAttributeValues?.[":prefix"] === "SHARE#") shareReads += 1;
      return p.w.db.send(command);
    } };
    const rec = recorder();
    await createRealtimeSink({ realtime: rec.config() })({ documentClient: counting, tableName: "state", now: () => p.w.clock.now }, changeOf(session, { statusChanged: true, summary: { status: "needs_person", needsPeople: [] } }));
    for (const who of crowd) expect(rec.calls.some((call) => call.channel === userChannel(ORG_A, who)), who).toBe(true);
    // One read of the session's shares for the facts, one for the one level that was worked out for all six.
    expect(shareReads).toBeLessThanOrEqual(2);
    // Followers who differ in those facts are not lumped together: one with a person entry that denies them is judged on their own.
    const denied = p.w.seedSession({ people: [{ developerId: crowd[0]!, role: "denied" }] });
    const deniedSession = denied.record as unknown as AgentSessionRecord;
    p.w.seedShare(ORG_A, deniedSession.sessionId, { kind: "org" }, "view");
    for (const who of crowd.slice(0, 2)) p.w.follower(ORG_A, deniedSession.sessionId, who);
    const again = recorder();
    await createRealtimeSink({ realtime: again.config() })({ documentClient: p.w.db, tableName: "state", now: () => p.w.clock.now }, changeOf(deniedSession, { statusChanged: true, summary: { status: "needs_person", needsPeople: [] } }));
    expect(again.calls.some((call) => call.channel === userChannel(ORG_A, crowd[0]!))).toBe(false);
    expect(again.calls.some((call) => call.channel === userChannel(ORG_A, crowd[1]!))).toBe(true);
  });

  it("past the projector's deadline, the followers not yet checked are neither told nor dropped, and it is logged", async () => {
    const p = projectorWorld();
    const session = p.w.seedSession().record as unknown as AgentSessionRecord;
    p.w.follower(ORG_A, session.sessionId, ARJUN);
    p.w.follower(ORG_A, session.sessionId, ZED);
    const rec = recorder();
    const logs: Array<Record<string, unknown>> = [];
    await createRealtimeSink({ realtime: rec.config() })({ documentClient: p.w.db, tableName: "state", now: () => p.w.clock.now, deadline: p.w.clock.now - 1, log: (entry) => logs.push(entry) }, changeOf(session, { statusChanged: true, summary: { status: "needs_person", needsPeople: [] } }));
    expect(rec.calls.some((call) => call.channel === userChannel(ORG_A, ARJUN))).toBe(false);
    expect(p.w.db.get(agentSessionKey(ORG_A, session.sessionId, `FOLLOWER#${ZED}`))).toBeDefined();
    expect(logs).toContainEqual({ event: "realtime.followers_unchecked", sessionId: session.sessionId, unchecked: 2 });
    // The owner is still told.
    expect(rec.calls.some((call) => call.channel === userChannel(ORG_A, PRIYA))).toBe(true);
  });

  it("of a chain session are neither told nor dropped without Plan 4's readers, and are judged by them with", async () => {
    const p = projectorWorld();
    const session = p.w.seedSession({ kind: "chain" }).record as unknown as AgentSessionRecord;
    p.w.follower(ORG_A, session.sessionId, ARJUN);
    p.w.follower(ORG_A, session.sessionId, ZED);
    const without = recorder();
    const deps = { documentClient: p.w.db, tableName: "state", now: () => p.w.clock.now };
    await createRealtimeSink({ realtime: without.config() })(deps, changeOf(session, { statusChanged: true, summary: { status: "needs_person", needsPeople: [] } }));
    expect(without.calls.some((call) => call.channel === userChannel(ORG_A, ARJUN))).toBe(false);
    expect(p.w.db.get(agentSessionKey(ORG_A, session.sessionId, `FOLLOWER#${ZED}`))).toBeDefined();
    const withReaders = recorder();
    await createRealtimeSink({ realtime: withReaders.config(), chainReadAccess: async (caller) => caller.developerId === ARJUN })(deps, changeOf(session, { statusChanged: true, summary: { status: "needs_person", needsPeople: [] } }));
    expect(withReaders.calls.some((call) => call.channel === userChannel(ORG_A, ARJUN))).toBe(true);
    expect(withReaders.calls.some((call) => call.channel === userChannel(ORG_A, ZED))).toBe(false);
    expect(p.w.db.get(agentSessionKey(ORG_A, session.sessionId, `FOLLOWER#${ZED}`))).toBeUndefined();
  });
});

describe("publishing", () => {
  it("writes each person's feed before any publish goes out", async () => {
    const { p, s } = endedTask();
    let feedAtFirstPublish: number | undefined;
    const rec = recorder(() => {
      feedAtFirstPublish ??= p.w.db.find((item) => String(item.pk).includes("#CHANGES#")).length;
      return new Response("{}", { status: 200 });
    });
    installRealtimeSink({ realtime: rec.config() });
    await p.refresh(s.sessionId);
    expect(rec.calls.length).toBeGreaterThan(0);
    expect(feedAtFirstPublish).toBe(2);
  });

  it("sends twelve notices on one channel as three requests of at most five events", async () => {
    const rec = recorder();
    const channel = sessionChannel(ORG_A, "ses_00000000000000000001");
    const entries = Array.from({ length: 12 }, (_, revision) => ({ channel, notice: { type: "session.updated" as const, sessionId: "ses_00000000000000000001", revision } }));
    const result = await publishNotices({ realtime: rec.config(), now: () => T0 }, entries);
    expect(rec.calls.map((call) => call.events.length)).toEqual([5, 5, 2]);
    expect(result).toEqual({ requests: 3, failed: 0 });
    // In order, and each event is the notice as JSON.
    expect(rec.calls.flatMap((call) => call.events.map((event) => (JSON.parse(event) as { revision: number }).revision))).toEqual(Array.from({ length: 12 }, (_, n) => n));
    // A request holds one channel: notices for two channels go as two requests.
    const two = recorder();
    await publishNotices({ realtime: two.config(), now: () => T0 }, [entries[0]!, { ...entries[1]!, channel: userChannel(ORG_A, PRIYA) }, entries[2]!]);
    expect(two.calls.map((call) => [call.channel, call.events.length])).toEqual([[channel, 2], [userChannel(ORG_A, PRIYA), 1]]);
  });

  it("returns within a second when a publish hangs, aborts it, and leaves the feed intact", async () => {
    const { p, s } = endedTask();
    let aborted = false;
    const hang = (async (_url: string, init: { signal: AbortSignal }) => {
      init.signal.addEventListener("abort", () => { aborted = true; });
      return new Promise<Response>(() => undefined);
    }) as unknown as typeof fetch;
    installRealtimeSink({ realtime: { ...recorder().config(), fetch: hang } });
    const started = Date.now();
    await p.refresh(s.sessionId);
    expect(Date.now() - started).toBeLessThan(1_800);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(aborted).toBe(true);
    expect(feedOf(p.w.db, PRIYA)).toHaveLength(2);
    expect(p.sessionOf(s.sessionId).summary.status).toBe("succeeded");
  });

  it("logs a failed request by the channel's kind and the error's name, and carries on with the rest", async () => {
    const logs: Array<Record<string, unknown>> = [];
    let n = 0;
    const rec = recorder(() => { n += 1; if (n === 1) return new Response("no", { status: 403 }); if (n === 2) throw new TypeError("network down"); return new Response("{}", { status: 200 }); });
    const notice = { type: "home.changed" as const, revision: 1 };
    const result = await publishNotices({ realtime: rec.config(), now: () => T0, log: (entry) => logs.push(entry) }, [
      { channel: sessionChannel(ORG_A, "ses_00000000000000000001"), notice }, { channel: userChannel(ORG_A, PRIYA), notice }, { channel: projectChannel(ORG_A, "web"), notice },
    ]);
    expect(result).toEqual({ requests: 3, failed: 2 });
    expect(logs).toEqual([{ event: "realtime.publish_failed", channelKind: "session", error: "http_403" }, { event: "realtime.publish_failed", channelKind: "user", error: "TypeError" }]);
    expect(JSON.stringify(logs)).not.toContain("secret");
  });

  it("posts nothing where there is no API, and still writes the feed", async () => {
    const { p, s } = endedTask();
    const rec = recorder();
    installRealtimeSink({ realtime: undefined });
    await p.refresh(s.sessionId);
    expect(rec.calls).toEqual([]);
    expect(feedOf(p.w.db, PRIYA)).toHaveLength(2);
    expect(await publishNotices({ realtime: undefined, now: () => T0 }, [{ channel: "/x", notice: { type: "home.changed", revision: 1 } }])).toEqual({ requests: 0, failed: 0 });
    expect(await publishNotices({ realtime: rec.config(), now: () => T0 }, [])).toEqual({ requests: 0, failed: 0 });
  });

  it("a failing sink never fails the refresh that told it, and a feed write that fails is logged and the notice still goes out", async () => {
    const { p, s } = endedTask();
    const rec = recorder();
    const failing = { send: async (command: { constructor: { name: string }; input: { Item?: Item } }) => {
      if (command.constructor.name === "PutCommand" && command.input.Item?.entityType === "CHANGE_NOTICE") throw Object.assign(new Error("full"), { name: "ProvisionedThroughputExceededException" });
      return p.w.db.send(command);
    } };
    installRealtimeSink({ realtime: rec.config() });
    await p.refresh(s.sessionId, ORG_A, { documentClient: failing });
    expect(p.logs).toContainEqual({ event: "realtime.feed_write_failed", error: "ProvisionedThroughputExceededException" });
    expect(rec.calls.length).toBeGreaterThan(0);
    expect(p.sessionOf(s.sessionId).summary.status).toBe("succeeded");
  });

  it("signs a request as AWS Signature Version 4 for appsync, the way the AWS signer does", async () => {
    const at = new Date("2026-10-22T09:00:00.000Z");
    const body = JSON.stringify({ channel: "/rovara/o-a/u/d-b", events: ["{}"] });
    const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", sessionToken: "IQoJb3JpZ2luX2Vj" };
    const url = new URL(ENDPOINT);
    const ours = signedHeaders({ url, body, region: "us-east-1", service: "appsync", credentials, at });
    const reference = await new SignatureV4({ service: "appsync", region: "us-east-1", credentials, sha256: Sha256, applyChecksum: false }).sign({
      method: "POST", protocol: url.protocol, hostname: url.hostname, path: url.pathname, headers: { "content-type": "application/json", host: url.host }, body,
    }, { signingDate: at });
    const theirs = Object.fromEntries(Object.entries(reference.headers).map(([name, value]) => [name.toLowerCase(), value]));
    expect(ours["authorization"]).toBe(theirs["authorization"]);
    expect(ours["x-amz-date"]).toBe("20261022T090000Z");
    expect(ours["x-amz-security-token"]).toBe(credentials.sessionToken);
    // No token, no header; Host is signed but not sent.
    const bare = signedHeaders({ url, body, region: "us-east-1", service: "appsync", credentials: { accessKeyId: "A", secretAccessKey: "B" }, at });
    expect(bare["x-amz-security-token"]).toBeUndefined();
    expect(bare["host"]).toBeUndefined();
    expect(bare["authorization"]).toContain("SignedHeaders=content-type;host;x-amz-date,");
    expect(ours["authorization"]).toContain("SignedHeaders=content-type;host;x-amz-date;x-amz-security-token,");
    // The request that goes out carries those headers and the JSON body.
    const rec = recorder();
    await publishNotices({ realtime: rec.config(), now: () => at.getTime() }, [{ channel: "/rovara/o-a/u/d-b", notice: { type: "home.changed", revision: 1 } }]);
    expect(rec.calls[0]!.url).toBe(ENDPOINT);
    expect(rec.calls[0]!.headers["content-type"]).toBe("application/json");
    expect(rec.calls[0]!.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261022\/us-east-1\/appsync\/aws4_request, SignedHeaders=/);
  });

  it("reads its API from REALTIME_HTTP_ENDPOINT, with the region the endpoint names and the Lambda's own credentials", async () => {
    expect(realtimeConfigFromEnvironment({})).toBeUndefined();
    expect(realtimeConfigFromEnvironment({ REALTIME_HTTP_ENDPOINT: "" })).toBeUndefined();
    const config = realtimeConfigFromEnvironment({ REALTIME_HTTP_ENDPOINT: "https://abcdefghij.appsync-api.eu-west-1.amazonaws.com/event", AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", AWS_SESSION_TOKEN: "ST" })!;
    expect(config.region).toBe("eu-west-1");
    expect(await config.credentials()).toEqual({ accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST" });
    expect(realtimeConfigFromEnvironment({ REALTIME_HTTP_ENDPOINT: "https://custom.example.com/event", AWS_REGION: "us-east-2" })!.region).toBe("us-east-2");
    expect(realtimeConfigFromEnvironment({ REALTIME_HTTP_ENDPOINT: "https://custom.example.com/event" })).toBeUndefined();
    await expect(realtimeConfigFromEnvironment({ REALTIME_HTTP_ENDPOINT: ENDPOINT })!.credentials()).rejects.toThrow("no AWS credentials");
    expect(realtimeSocketEndpoint(ENDPOINT)).toBe("wss://abcdefghij.appsync-realtime-api.us-east-1.amazonaws.com/event/realtime");
  });
});

describe("noticesFor, on its own", () => {
  const session = (kind: "task" | "chain" | "local", over: Item = {}) => {
    const w = sessionWorld();
    return { ...w.seedSession({ kind }).record, ...over } as unknown as AgentSessionRecord;
  };
  const change = (over: Partial<Parameters<typeof noticesFor>[1]> = {}) => ({
    summaryRevision: 7, statusChanged: false, ended: false, previous: { needsPeople: [] as string[] }, summary: { status: "running" as const, needsPeople: [] as string[] }, ...over,
  });
  const who = (planned: ReturnType<typeof noticesFor>, kind: string) => planned.filter((entry) => entry.notice.type === kind).map((entry) => entry.channel);
  const people = { owner: PRIYA, followers: [] as string[], projectNotice: true };

  it("gives a project channel only to a cloud task session that has a project, and only when the project may hear", () => {
    const task = session("task");
    expect(who(noticesFor(task, change(), people), "session.updated")).toContain(projectChannel(ORG_A, "web"));
    expect(who(noticesFor(task, change(), { ...people, projectNotice: false }), "session.updated")).not.toContain(projectChannel(ORG_A, "web"));
    for (const [name, other] of [["chain", session("chain")], ["local", session("local")], ["a task on a Mac", session("task", { where: { kind: "mac", deviceId: "dvc_0123456789abcdefghij", label: "Mac" } })], ["a task with no project", session("task", { project: undefined })]] as const) {
      const planned = noticesFor(other, change(), people);
      expect(planned.some((entry) => entry.channel.includes("/p/")), name).toBe(false);
      expect(planned.some((entry) => entry.channel === sessionChannel(ORG_A, other.sessionId)), name).toBe(true);
    }
  });

  it("tells Home when the status changed, when the end came, or when who is needed changed (more people, fewer, or others), and not otherwise", () => {
    const task = session("task");
    const homeFor = (over: Parameters<typeof change>[0]) => who(noticesFor(task, change(over), people), "home.changed");
    const ours = [userChannel(ORG_A, PRIYA)];
    expect(homeFor({})).toEqual([]);
    expect(homeFor({ statusChanged: true })).toEqual(ours);
    expect(homeFor({ ended: true })).toEqual(ours);
    // Who is needed: one more person (the same ones are all still there), one fewer, and one for another.
    expect(homeFor({ previous: { needsPeople: [ARJUN] }, summary: { status: "running", needsPeople: [ARJUN, MIA] } })).toContain(userChannel(ORG_A, MIA));
    expect(homeFor({ previous: { needsPeople: [ARJUN, MIA] }, summary: { status: "running", needsPeople: [ARJUN] } })).toContain(userChannel(ORG_A, MIA));
    expect(homeFor({ previous: { needsPeople: [ARJUN] }, summary: { status: "running", needsPeople: [MIA] } }).sort()).toEqual([userChannel(ORG_A, ARJUN), userChannel(ORG_A, MIA), ...ours].sort());
    expect(homeFor({ previous: { needsPeople: [ARJUN, MIA] }, summary: { status: "running", needsPeople: [ARJUN, MIA] } })).toEqual([]);
  });

  it("tells a follower of an end even when the status was already an ended one, and a follower of a notable status only when it changed", () => {
    const task = session("task");
    const heard = (over: Parameters<typeof change>[0]) => who(noticesFor(task, change(over), { ...people, followers: [ARJUN] }), "session.updated").includes(userChannel(ORG_A, ARJUN));
    expect(heard({ ended: true, statusChanged: false, summary: { status: "succeeded", needsPeople: [] } })).toBe(true);
    expect(heard({ ended: false, statusChanged: true, summary: { status: "needs_person", needsPeople: [] } })).toBe(true);
    expect(heard({ ended: false, statusChanged: false, summary: { status: "needs_person", needsPeople: [] } })).toBe(false);
    expect(heard({ ended: false, statusChanged: true, summary: { status: "running", needsPeople: [] } })).toBe(false);
    expect(heard({ ended: false, statusChanged: true, summary: { status: "starting", needsPeople: [] } })).toBe(false);
  });

  it("never tells a person twice of the same notice, and puts each person's notices only in their own feed", () => {
    const task = session("task");
    const planned = noticesFor(task, change({ statusChanged: true, previous: { needsPeople: [PRIYA, ARJUN] }, summary: { status: "needs_person", needsPeople: [PRIYA, ARJUN] } }), { ...people, followers: [ARJUN, MIA] });
    const keys = planned.map((entry) => `${entry.channel}|${JSON.stringify(entry.notice)}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of planned.filter((candidate) => candidate.channel.includes("/u/"))) expect(entry.feedTo).toHaveLength(1);
    for (const entry of planned.filter((candidate) => !candidate.channel.includes("/u/"))) expect(entry.feedTo).toEqual([]);
    expect(planned.find((entry) => entry.channel === userChannel(ORG_A, MIA))!.feedTo).toEqual([MIA]);
    const notice: RealtimeNotice = planned[0]!.notice;
    expect(notice).toEqual({ type: "session.updated", sessionId: task.sessionId, revision: 7 });
  });
});

describe("what the sink does with its time and its readers", () => {
  const needsPerson = { statusChanged: true, summary: { status: "needs_person", needsPeople: [] as string[] } };

  it("does not look at followers, or drop any, for a change they would not be told of", async () => {
    const p = projectorWorld();
    const session = p.w.seedSession().record as unknown as AgentSessionRecord;
    const GONE = hex("8"); // left the company: positively without access
    p.w.follower(ORG_A, session.sessionId, GONE);
    await createRealtimeSink({ realtime: undefined })({ documentClient: p.w.db, tableName: "state", now: () => p.w.clock.now }, changeOf(session, { statusChanged: true, summary: { status: "running", needsPeople: [] } }));
    expect(p.w.db.get(agentSessionKey(ORG_A, session.sessionId, `FOLLOWER#${GONE}`))).toBeDefined();
    // The same follower is dropped by a change they would be told of.
    await createRealtimeSink({ realtime: undefined })({ documentClient: p.w.db, tableName: "state", now: () => p.w.clock.now }, changeOf(session, needsPerson));
    expect(p.w.db.get(agentSessionKey(ORG_A, session.sessionId, `FOLLOWER#${GONE}`))).toBeUndefined();
  });

  it("does not check the owner when the owner follows their own session", async () => {
    const p = projectorWorld();
    const session = p.w.seedSession().record as unknown as AgentSessionRecord;
    p.w.follower(ORG_A, session.sessionId, PRIYA);
    const reads: string[] = [];
    const watching = { send: async (command: { constructor: { name: string }; input: { Key?: { pk: string; sk: string } } }) => { if (command.constructor.name === "GetCommand") reads.push(`${command.input.Key!.pk}|${command.input.Key!.sk}`); return p.w.db.send(command); } };
    const rec = recorder();
    await createRealtimeSink({ realtime: rec.config() })({ documentClient: watching, tableName: "state", now: () => p.w.clock.now }, changeOf(session, needsPerson));
    expect(reads.filter((read) => read.includes(`MEMBER#${PRIYA}`))).toEqual([]);
    expect(noticesOn(rec.calls, userChannel(ORG_A, PRIYA)).filter((notice) => notice.type === "session.updated")).toHaveLength(1);
  });

  it("tells apart followers who differ only in a share made to them, however they are ordered", async () => {
    const p = projectorWorld();
    // A session with no project: only its shares open it. Arjun has a share made to him; Zed has none, and is a member like him.
    const session = p.w.seedSession({ project: null }).record as unknown as AgentSessionRecord;
    p.w.seedShare(ORG_A, session.sessionId, { kind: "member", developerId: ARJUN }, "view");
    p.w.follower(ORG_A, session.sessionId, ARJUN);
    p.w.follower(ORG_A, session.sessionId, ZED);
    const rec = recorder();
    await createRealtimeSink({ realtime: rec.config() })({ documentClient: p.w.db, tableName: "state", now: () => p.w.clock.now }, changeOf(session, needsPerson));
    expect(rec.calls.some((call) => call.channel === userChannel(ORG_A, ARJUN))).toBe(true);
    expect(rec.calls.some((call) => call.channel === userChannel(ORG_A, ZED))).toBe(false);
    expect(p.w.db.get(agentSessionKey(ORG_A, session.sessionId, `FOLLOWER#${ZED}`))).toBeUndefined();
  });

  it.each([[50, 4], [120, 2]])("reads at most the followers a session may have (pages of %i), and stops reading pages once it has them", async (limit, expectedPages) => {
    const p = projectorWorld();
    const session = p.w.seedSession().record as unknown as AgentSessionRecord;
    p.w.seedShare(ORG_A, session.sessionId, { kind: "org" }, "view");
    const crowd = Array.from({ length: 205 }, (_, n) => `${String(n).padStart(4, "0")}${"0".repeat(60)}`);
    for (const who of crowd) { p.w.member(ORG_A, who, "member"); p.w.follower(ORG_A, session.sessionId, who); }
    let pages = 0;
    const paged = { send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === "QueryCommand" && (command.input.ExpressionAttributeValues as Record<string, unknown>)[":prefix"] === "FOLLOWER#") {
        pages += 1;
        return p.w.db.send(new QueryCommand({ ...command.input, Limit: limit } as never));
      }
      return p.w.db.send(command);
    } };
    const rec = recorder();
    await createRealtimeSink({ realtime: rec.config() })({ documentClient: paged, tableName: "state", now: () => p.w.clock.now }, changeOf(session, needsPerson));
    expect(pages).toBe(expectedPages);
    const told = crowd.filter((who) => rec.calls.some((call) => call.channel === userChannel(ORG_A, who)));
    expect(told).toHaveLength(200);
    expect(told).toEqual(crowd.slice(0, 200));
  });

  it("reads no Task People list for a session that has no task", async () => {
    const p = projectorWorld();
    const session = p.w.seedSession({ kind: "chain" }).record as unknown as AgentSessionRecord;
    const reads: string[] = [];
    const watching = { send: async (command: { constructor: { name: string }; input: { Key?: { pk: string; sk: string } } }) => { if (command.constructor.name === "GetCommand") reads.push(command.input.Key!.sk); return p.w.db.send(command); } };
    await createRealtimeSink({ realtime: undefined })({ documentClient: watching, tableName: "state", now: () => p.w.clock.now }, changeOf(session, needsPerson));
    expect(reads).not.toContain("PEOPLE");
  });
});

describe("publishing, in more detail", () => {
  it("runs a few requests at a time, not one by one and not all at once", async () => {
    let inFlight = 0;
    let most = 0;
    const rec = recorder(async () => { inFlight += 1; most = Math.max(most, inFlight); await new Promise((resolve) => setTimeout(resolve, 20)); inFlight -= 1; return new Response("{}", { status: 200 }); });
    const notice = { type: "home.changed" as const, revision: 1 };
    const entries = Array.from({ length: 12 }, (_, n) => ({ channel: userChannel(ORG_A, `${String(n).padStart(2, "0")}${"0".repeat(62)}`), notice }));
    await publishNotices({ realtime: rec.config(), now: () => T0 }, entries);
    expect(rec.calls).toHaveLength(12);
    expect(most).toBe(4);
  });

  it("starts no new request once the deadline has aborted the rest", async () => {
    const hang = vi.fn((_url: string, init: { signal: AbortSignal }) => new Promise<Response>((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))));
    const logs: Array<Record<string, unknown>> = [];
    const notice = { type: "home.changed" as const, revision: 1 };
    const entries = Array.from({ length: 12 }, (_, n) => ({ channel: userChannel(ORG_A, `${String(n).padStart(2, "0")}${"0".repeat(62)}`), notice }));
    const result = await publishNotices({ realtime: { ...recorder().config(), fetch: hang as unknown as typeof fetch }, now: () => T0, log: (entry) => logs.push(entry) }, entries);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(hang).toHaveBeenCalledTimes(4);
    expect(result.requests).toBe(4);
  });

  it("leaves no timer behind once it is done", async () => {
    vi.useFakeTimers();
    try {
      const rec = recorder();
      await publishNotices({ realtime: rec.config(), now: () => T0 }, [{ channel: sessionChannel(ORG_A, "ses_00000000000000000001"), notice: { type: "home.changed", revision: 1 } }]);
      expect(rec.calls).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("signs a request with a query string as the AWS signer does", async () => {
    const at = new Date("2026-10-22T09:00:00.000Z");
    const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
    const url = new URL("https://abcdefghij.appsync-api.us-east-1.amazonaws.com/event?a=1");
    const ours = signedHeaders({ url, body: "{}", region: "us-east-1", service: "appsync", credentials, at });
    const reference = await new SignatureV4({ service: "appsync", region: "us-east-1", credentials, sha256: Sha256, applyChecksum: false }).sign({
      method: "POST", protocol: url.protocol, hostname: url.hostname, path: url.pathname, query: { a: "1" }, headers: { "content-type": "application/json", host: url.host }, body: "{}",
    }, { signingDate: at });
    expect(ours["authorization"]).toBe(reference.headers["authorization"]);
  });

  it("counts the feed writes that failed, and says how many went through", async () => {
    const w = sessionWorld();
    const notice = { type: "home.changed" as const, revision: 1 };
    let n = 0;
    const flaky = { send: async (command: Parameters<typeof w.db.send>[0]) => { n += 1; if (n === 2) throw new Error("full"); return w.db.send(command); } };
    const entries = [PRIYA, ARJUN, MIA].map((developerId) => ({ developerId, notice, at: iso(T0) }));
    expect(await writeChanges({ documentClient: flaky, tableName: "state", now: () => T0, log: () => undefined }, ORG_A, entries)).toEqual({ written: 2, failed: 1 });
    expect(await writeChanges({ documentClient: w.db, tableName: "state", now: () => T0 }, ORG_A, [])).toEqual({ written: 0, failed: 0 });
  });
});

describe("the channels", () => {
  it("are names of the shape AppSync Events accepts, with no id, name or title in them", () => {
    const org = "org_0123456789abcdefghij" as OrgId;
    const longProject = `${"a".repeat(62)}-`;
    const channels = [userChannel(org, PRIYA), sessionChannel(org, "ses_0123456789abcdefghij"), sessionChannel(org, "crn_0123456789abcdefghij"), projectChannel(org, "web"), projectChannel(org, longProject)];
    for (const channel of channels) {
      expect(channel).toMatch(/^\/rovara\/o-0123456789abcdefghij\/[usp]\/[a-z]-[0-9a-z]+$/);
      for (const segment of channel.slice(1).split("/")) {
        expect(segment.length).toBeLessThanOrEqual(50);
        expect(segment).toMatch(/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/);
      }
      expect(parseRealtimeChannel(channel)).toBeDefined();
    }
    expect(channels[0]).toBe(`/rovara/o-0123456789abcdefghij/u/d-${createHash("sha256").update(PRIYA).digest("hex").slice(0, 40)}`);
    expect(channels[1]).toBe("/rovara/o-0123456789abcdefghij/s/s-0123456789abcdefghij");
    expect(channels[2]).toBe("/rovara/o-0123456789abcdefghij/s/c-0123456789abcdefghij");
    expect(channels[3]).toBe(`/rovara/o-0123456789abcdefghij/p/p-${createHash("sha256").update(`${org}\nweb`).digest("hex").slice(0, 40)}`);
    expect(projectSegment(org, "web")).not.toBe(projectSegment(ORG_B, "web"));
    expect(channels.join()).not.toContain("web");
    for (const bad of ["/rovara/o-0123456789abcdefghij/s/*", "/rovara/o-0123456789abcdefghij/*", "/rovara/*", "/other/o-0123456789abcdefghij/u/d-" + "a".repeat(40), "/rovara/o-0123456789abcdefghij/u/s-0123456789abcdefghij", "/rovara/o-0123456789abcdefghij/u/d-" + "a".repeat(41), `/rovara/o-0123456789abcdefghij/s/s-${"a".repeat(21)}`, `/rovara/o-0123456789abcdefghij/s/s-${"a".repeat(19)}`, `/rovara/o-0123456789abcdefghij/s/c-${"A".repeat(20)}`, "/rovara/o-0123456789abcdefghij/u/d-" + "a".repeat(40) + "/x", "rovara/o-0123456789abcdefghij/u/d-" + "a".repeat(40), "/rovara/o-0123456789ABCDEFGHIJ/u/d-" + "a".repeat(40)]) {
      expect(parseRealtimeChannel(bad), bad).toBeUndefined();
    }
    expect(() => userChannel("org_x", PRIYA)).toThrow();
  });

  it("carry notices that are strict: ids and numbers, nothing else", () => {
    expect(RealtimeNoticeSchema.safeParse({ type: "session.updated", sessionId: "ses_0123456789abcdefghij", revision: 1, title: "x" }).success).toBe(false);
    expect(RealtimeNoticeSchema.safeParse({ type: "device.command", deviceId: "dvc_0123456789abcdefghij", seq: 3 }).success).toBe(true);
    expect(RealtimeNoticeSchema.safeParse({ type: "session.event", sessionId: "crn_0123456789abcdefghij", eventId: "evt_0123456789abcdef01234567" }).success).toBe(true);
    expect(RealtimeNoticeSchema.safeParse({ type: "home.changed", revision: -1 }).success).toBe(false);
  });
});

describe("GET /v1/app/changes", () => {
  const put = (w: ReturnType<typeof sessionWorld>, developerId: string, at: string, n: number, extra: Item = {}, orgId: OrgId = ORG_A) =>
    w.db.set({ ...changesKey(orgId, developerId, at, n), entityType: "CHANGE_NOTICE", orgId, notice: { type: "home.changed", revision: n }, at, ...extra });
  const world = () => { const w = sessionWorld(); w.clock.now = Date.parse("2026-10-22T12:00:00.000Z"); return w; };
  const read = (w: ReturnType<typeof sessionWorld>, who: string, since?: string, orgId: OrgId = ORG_A) => readChanges({ documentClient: w.db, tableName: "state", now: () => w.clock.now }, { orgId, developerId: who }, since);

  it("gives the caller's own notices, oldest first, and never another person's or another org's", async () => {
    const w = world();
    put(w, PRIYA, "2026-10-22T10:00:00.000Z", 2);
    put(w, PRIYA, "2026-10-22T09:00:00.000Z", 1);
    put(w, PRIYA, "2026-10-22T09:00:00.000Z", 7, { notice: { type: "session.updated", sessionId: "ses_0123456789abcdefghij", revision: 4 } });
    put(w, ARJUN, "2026-10-22T09:30:00.000Z", 3);
    put(w, PRIYA, "2026-10-22T09:45:00.000Z", 4, {}, ORG_B);
    const page = await read(w, PRIYA);
    expect(page.notices).toEqual([
      { type: "home.changed", revision: 1, at: "2026-10-22T09:00:00.000Z", sk: "2026-10-22T09:00:00.000Z#000001" },
      { type: "session.updated", sessionId: "ses_0123456789abcdefghij", revision: 4, at: "2026-10-22T09:00:00.000Z", sk: "2026-10-22T09:00:00.000Z#000007" },
      { type: "home.changed", revision: 2, at: "2026-10-22T10:00:00.000Z", sk: "2026-10-22T10:00:00.000Z#000002" },
    ]);
    expect(page.next).toBe("2026-10-22T10:00:00.000Z#000002");
    expect(page.reset).toBeUndefined();
    expect((await read(w, ARJUN)).notices).toEqual([{ type: "home.changed", revision: 3, at: "2026-10-22T09:30:00.000Z", sk: "2026-10-22T09:30:00.000Z#000003" }]);
    expect((await read(w, PRIYA, undefined, ORG_B)).notices).toEqual([{ type: "home.changed", revision: 4, at: "2026-10-22T09:45:00.000Z", sk: "2026-10-22T09:45:00.000Z#000004" }]);
    expect((await read(w, ZED)).notices).toEqual([]);
  });

  it("gives what came after the cursor, and the same cursor back when nothing did", async () => {
    const w = world();
    put(w, PRIYA, "2026-10-22T09:00:00.000Z", 1);
    put(w, PRIYA, "2026-10-22T10:00:00.000Z", 2);
    const first = await read(w, PRIYA);
    const after = await read(w, PRIYA, "2026-10-22T09:00:00.000Z#000001");
    expect(after.notices).toEqual([{ type: "home.changed", revision: 2, at: "2026-10-22T10:00:00.000Z", sk: "2026-10-22T10:00:00.000Z#000002" }]);
    expect(await read(w, PRIYA, first.next)).toEqual({ notices: [], next: first.next });
    // An empty feed starts the caller at now: what is written after that is theirs.
    const empty = await read(w, ZED);
    // (30 seconds back, the settle window: a notice made just before now may still be on its way to the table.)
    expect(empty).toEqual({ notices: [], next: "2026-10-22T11:59:30.000Z#" });
    put(w, ZED, "2026-10-22T12:00:00.000Z", 0);
    expect((await read(w, ZED, empty.next)).notices).toHaveLength(1);
  });

  it("leaves out a notice past its seven days even while the table still has it, and keeps one just inside", async () => {
    const w = world();
    const edge = Date.parse("2026-10-22T12:00:00.000Z") - CHANGES_FEED_DAYS * 86_400_000;
    put(w, PRIYA, iso(edge - 1), 1, { indexExpiresAt: 1 });
    put(w, PRIYA, iso(edge + 1), 2);
    put(w, PRIYA, "2026-10-14T00:00:00.000Z", 3, { indexExpiresAt: 1 });
    expect((await read(w, PRIYA)).notices.map((notice) => (notice as { revision: number }).revision)).toEqual([2]);
  });

  it("answers an old cursor with reset and no notices, and a cursor at the edge with the feed", async () => {
    const w = world();
    const edge = Date.parse("2026-10-22T12:00:00.000Z") - CHANGES_FEED_DAYS * 86_400_000;
    put(w, PRIYA, iso(edge + 5), 1);
    expect(await read(w, PRIYA, `${iso(edge - 1)}#000001`)).toEqual({ notices: [], next: "2026-10-22T11:59:30.000Z#", reset: true });
    expect((await read(w, PRIYA, `${iso(edge)}#000000`)).notices).toHaveLength(1);
  });

  it("refuses something that is not a cursor from this feed", async () => {
    const w = world();
    for (const bad of ["", "yesterday", "2026-10-22T09:00:00Z#000001", "2026-10-22T09:00:00.000Z", "2026-10-22T09:00:00.000Z#1234567", "x2026-10-22T09:00:00.000Z#000001"]) {
      await expect(read(w, PRIYA, bad), bad).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
  });

  it("gives a page of at most 500 and a cursor that carries on, and passes over what it can't read", async () => {
    const w = world();
    for (let n = 0; n < 503; n += 1) put(w, PRIYA, iso(Date.parse("2026-10-22T09:00:00.000Z") + n), n);
    put(w, PRIYA, "2026-10-22T11:00:00.000Z", 9, { notice: { type: "session.updated", title: "x" } });
    const first = await read(w, PRIYA);
    expect(first.notices).toHaveLength(500);
    const rest = await read(w, PRIYA, first.next);
    expect(rest.notices.map((notice) => (notice as { revision: number }).revision)).toEqual([500, 501, 502]);
    expect(rest.next).toBe("2026-10-22T11:00:00.000Z#000009");
  });

  it("tells the share notice an old share left, with its undo", async () => {
    const w = world();
    w.db.set({ ...changesKey(ORG_A, PRIYA, "2026-10-22T09:00:00.000Z", 5), entityType: "CHANGE_NOTICE", orgId: ORG_A, type: "session_shared", sessionId: "ses_0123456789abcdefghij", revision: 3, by: ARJUN, undo: { principalKey: `MEMBER#${ZED}` }, at: "2026-10-22T09:00:00.000Z" });
    expect((await read(w, PRIYA)).notices).toEqual([{ type: "session_shared", sessionId: "ses_0123456789abcdefghij", revision: 3, by: ARJUN, undo: { principalKey: `MEMBER#${ZED}` }, at: "2026-10-22T09:00:00.000Z", sk: "2026-10-22T09:00:00.000Z#000005" }]);
  });

  describe("the settle window (Task 8 review, I-2): a notice that is committed late is still given", () => {
    const sks = (page: { notices: Array<{ sk: string }> }) => page.notices.map((notice) => notice.sk);

    it("holds the cursor back 30 seconds, so an item written after a newer one was read is found by the next read", async () => {
      const w = world(); // now 12:00:00
      put(w, PRIYA, "2026-10-22T11:59:50.000Z", 1);
      const first = await read(w, PRIYA);
      expect(sks(first)).toEqual(["2026-10-22T11:59:50.000Z#000001"]);
      expect(first.next).toBe("2026-10-22T11:59:30.000Z#");
      // The change made at 11:59:45 is written only now (the summary's time is taken before the follower checks and the Put).
      put(w, PRIYA, "2026-10-22T11:59:45.000Z", 2);
      w.clock.now += 5_000;
      const second = await read(w, PRIYA, first.next);
      expect(sks(second)).toEqual(["2026-10-22T11:59:45.000Z#000002", "2026-10-22T11:59:50.000Z#000001"]);
    });

    it("gives repeats while an item is inside the window, and a client that drops repeats by sk ends with each notice once", async () => {
      const w = world();
      put(w, PRIYA, "2026-10-22T11:59:50.000Z", 1);
      const seen = new Map<string, unknown>();
      let cursor: string | undefined;
      let given = 0;
      for (const step of [0, 5_000, 5_000]) {
        w.clock.now += step;
        const page = await read(w, PRIYA, cursor);
        given += page.notices.length;
        for (const notice of page.notices) seen.set(notice.sk, notice);
        cursor = page.next;
      }
      expect(given).toBe(3);
      expect([...seen.keys()]).toEqual(["2026-10-22T11:59:50.000Z#000001"]);
      // Past the window the item is settled: the cursor moves onto it and it is not given again.
      w.clock.now += 60_000;
      const settled = await read(w, PRIYA, cursor);
      expect(sks(settled)).toEqual(["2026-10-22T11:59:50.000Z#000001"]);
      expect(settled.next).toBe("2026-10-22T11:59:50.000Z#000001");
      expect(await read(w, PRIYA, settled.next)).toEqual({ notices: [], next: "2026-10-22T11:59:50.000Z#000001" });
    });

    it("never moves the cursor back from the one it was given, and gives the same one while nothing new is inside the window", async () => {
      const w = world();
      put(w, PRIYA, "2026-10-22T09:00:00.000Z", 1);
      const ahead = "2026-10-22T11:59:55.000Z#000003";
      expect(await read(w, PRIYA, ahead)).toEqual({ notices: [], next: ahead });
      // The newest item is at the window's start: the cursor is the window's start (an item at that instant is read again, and dropped by its sk).
      put(w, PRIYA, "2026-10-22T11:59:30.000Z", 5);
      const edge = await read(w, PRIYA, "2026-10-22T10:00:00.000Z#000000");
      expect(edge.next).toBe("2026-10-22T11:59:30.000Z#");
    });

    // Task 9 review (minor 2): a full page's cursor is the older of its last item and the window's edge, unless the edge is no newer than the cursor given (then the last item).
    it("holds a full page's cursor back to the window's edge when the page's last item is inside the window (a late item older than the last is still found)", async () => {
      const w = world(); // now 12:00:00, edge 11:59:30
      for (let n = 0; n < 503; n += 1) put(w, PRIYA, iso(Date.parse("2026-10-22T11:59:40.000Z") + n), n);
      const first = await read(w, PRIYA);
      expect(first.notices).toHaveLength(500);
      expect(first.next).toBe("2026-10-22T11:59:30.000Z#");
      // An item committed late, older than the page's last: the next read still finds it.
      put(w, PRIYA, "2026-10-22T11:59:35.000Z", 900);
      const again = await read(w, PRIYA, first.next);
      expect(sks(again)).toContain("2026-10-22T11:59:35.000Z#000900");
    });

    it("lets a burst carry on: with the edge no newer than the cursor given, the full page's cursor is its own last item", async () => {
      const w = world();
      for (let n = 0; n < 503; n += 1) put(w, PRIYA, iso(Date.parse("2026-10-22T11:59:40.000Z") + n), n);
      const first = await read(w, PRIYA);
      const second = await read(w, PRIYA, first.next);
      expect(second.notices).toHaveLength(500);
      expect(second.next).toBe(second.notices[499]!.sk);
      const rest = await read(w, PRIYA, second.next);
      expect(sks(rest)).toEqual([500, 501, 502].map((n) => `${iso(Date.parse("2026-10-22T11:59:40.000Z") + n)}#${String(n).padStart(6, "0")}`));
      // The cursor is never held back behind the one it was given, so the next page is not the same page.
      expect(rest.next).toBe(second.next);
    });

    it("moves a full page of settled items to its own last item", async () => {
      const w = world();
      for (let n = 0; n < 501; n += 1) put(w, PRIYA, iso(Date.parse("2026-10-22T11:00:00.000Z") + n), n);
      const first = await read(w, PRIYA);
      expect(first.next).toBe(first.notices[499]!.sk);
    });
  });

  it("is reached through the session routes by GET only, as the caller", async () => {
    const w = world();
    put(w, PRIYA, "2026-10-22T09:00:00.000Z", 1);
    const deps = { documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: "https://cell.example.com", taskView: async () => ({}) as never };
    const call = (who: string, method: string, path: string) => routeAgentSessionRequest(deps, w.caller(who), { method, path, headers: {}, requestId: "r" }, new URL(`https://cell.example.com${path}`));
    expect(await call(PRIYA, "GET", "/v1/app/changes")).toMatchObject({ notices: [{ type: "home.changed", revision: 1 }] });
    expect(await call(ARJUN, "GET", "/v1/app/changes")).toMatchObject({ notices: [] });
    await expect(call(PRIYA, "POST", "/v1/app/changes")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(call(PRIYA, "GET", "/v1/app/changes?since=nope")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await call(PRIYA, "GET", `/v1/app/changes?since=${encodeURIComponent("2026-10-22T09:00:00.000Z#000001")}`)).toMatchObject({ notices: [] });
  });
});

describe("POST /v1/app/realtime/token", () => {
  const make = (names: Record<string, string[]>, options: { endpoint?: string | undefined } = { endpoint: ENDPOINT }) => {
    const w = sessionWorld();
    const requests: unknown[] = [];
    const deps = {
      documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: "https://cell.example.com", taskView: async () => ({}) as never,
      realtime: {
        endpoint: options.endpoint,
        projectsOf: async (caller: { developerId: string }) => names[caller.developerId] ?? [],
        mint: async (request: unknown) => { requests.push(request); return { token: "signed.token.value", expiresAt: "2026-10-22T09:15:00.000Z" }; },
      },
    };
    const call = (who: string, method = "POST") => routeAgentSessionRequest(deps, w.caller(who), { method, path: "/v1/app/realtime/token", headers: {}, requestId: "r" }, new URL("https://cell.example.com/v1/app/realtime/token"));
    return { w, deps, requests, call };
  };

  it("lists only the caller's project segments, and the channels to subscribe to", async () => {
    const t = make({ [ARJUN]: ["web"], [PRIYA]: ["web", "ops"], [ZED]: [] });
    const arjun = RealtimeTokenResponseSchema.parse(await t.call(ARJUN));
    expect(arjun).toEqual({
      token: "signed.token.value", expiresAt: "2026-10-22T09:15:00.000Z", endpoint: "wss://abcdefghij.appsync-realtime-api.us-east-1.amazonaws.com/event/realtime",
      channels: { user: userChannel(ORG_A, ARJUN), projects: { web: projectChannel(ORG_A, "web") } },
    });
    expect(t.requests[0]).toEqual({ kind: "realtime-token", orgId: ORG_A, developerId: ARJUN, projects: [projectSegment(ORG_A, "web")] });
    const priya = await t.call(PRIYA) as { channels: { projects: Record<string, string> } };
    expect(Object.keys(priya.channels.projects).sort()).toEqual(["ops", "web"]);
    expect(t.requests[1]).toEqual({ kind: "realtime-token", orgId: ORG_A, developerId: PRIYA, projects: ["ops", "web"].map((name) => projectSegment(ORG_A, name)) });
    const zed = await t.call(ZED) as { channels: unknown };
    expect(zed.channels).toEqual({ user: userChannel(ORG_A, ZED), projects: {} });
    expect(JSON.stringify(arjun)).not.toContain("ops");
  });

  it("carries 'lookup' instead of the list past 25 projects, and still lists every channel", async () => {
    const many = Array.from({ length: REALTIME_TOKEN_PROJECTS_MAX + 1 }, (_, n) => `project-${String(n).padStart(2, "0")}`);
    const exact = many.slice(0, REALTIME_TOKEN_PROJECTS_MAX);
    const t = make({ [OLA]: many, [MAX]: exact });
    const ola = await t.call(OLA) as { channels: { projects: Record<string, string> } };
    expect((t.requests[0] as { projects: unknown }).projects).toBe("lookup");
    expect(Object.keys(ola.channels.projects)).toHaveLength(26);
    await t.call(MAX);
    expect((t.requests[1] as { projects: string[] }).projects).toHaveLength(25);
  });

  it("answers POST only, and says live updates are unavailable without an API or without a signature", async () => {
    const t = make({});
    await expect(t.call(PRIYA, "GET")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(make({}, { endpoint: undefined }).call(PRIYA)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: expect.stringContaining("Live updates aren't available") as string });
    const { realtime: _realtime, ...bare } = t.deps; // eslint-disable-line @typescript-eslint/no-unused-vars -- the dependencies without the realtime part
    await expect(routeAgentSessionRequest(bare, t.w.caller(PRIYA), { method: "POST", path: "/v1/app/realtime/token", headers: {}, requestId: "r" }, new URL("https://x.example.com/v1/app/realtime/token"))).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
});

describe("the broker", () => {
  type Row = Item & { id: string; kind: string; fence: number };
  const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };

  it("registers the sink where agents are set up, so a run's end reaches its owner's feed through the real refresh", async () => {
    await loadSlackBroker();
    unregisterAgentSessionTaskHandlers();
    const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {} } });
    const reply = await h.dev(MAYA, "POST", "/v1/app/agents/root-cause-analyst/runs", { requestId: randomUUID(), project: "payments", input: { text: "Why did checkout fail?" } });
    expect(reply.status).toBe(202);
    const taskId = (reply.body.task as { taskId: string }).taskId;
    const { workspaceId } = h.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
    const operations = () => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION") as Row[];
    await h.finish(workspaceId, operations().find((operation) => operation.kind === "prepare")!.id, "SUCCEEDED", PREPARED);
    const steps = () => operations().filter((operation) => operation.kind === "task").sort((a, b) => a.fence - b.fence);
    await h.finish(workspaceId, steps()[0]!.id, "SUCCEEDED", { result: { agentStepResult: { report: "Found it.", outcome: "SUCCEEDED" } } });
    await h.finish(workspaceId, steps()[1]!.id, "SUCCEEDED", { result: { agentStepResult: { report: "The retry was removed.", outcome: "SUCCEEDED" } } });
    const feed = h.db.find((item) => item.entityType === "CHANGE_NOTICE" && String(item.pk).endsWith(`#CHANGES#${MAYA.developerId}`));
    expect(feed.map((item) => (item.notice as { type: string }).type)).toContain("home.changed");
    expect(feed.every((item) => RealtimeNoticeSchema.safeParse(item.notice).success)).toBe(true);
    // A broker without agents has no sessions, so registers none.
    registerSessionNoticeSink(undefined);
    await createDeveloperTaskBroker({ brokerExtra: {} });
    const count = h.db.find((item) => item.entityType === "CHANGE_NOTICE").length;
    await notifySessionChange({ documentClient: h.db, tableName: "state", now: () => T0 }, changeOf(sessionWorld().seedSession().record as unknown as AgentSessionRecord, { statusChanged: true }));
    expect(h.db.find((item) => item.entityType === "CHANGE_NOTICE")).toHaveLength(count);
  });
});
