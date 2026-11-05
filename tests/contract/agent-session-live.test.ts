// Plan 5 Task 14: the Live wall's data. `GET /v1/app/live?filter=all|mine|team|needs_me|failed&project=&cursor=` shows other people's work, so what it answers is read for the caller, now:
// only the sessions they may view, with the actions they may take at their level, an approval link only for a decision they may make (bare, never with a ticket), nothing of another org,
// and a fixed number of reads however many tiles there are. `SessionTileSchema` is the list's tile; the Live wall's is `LiveTileSchema`, read with `LiveResponseReaderSchema`.
import type { AgentRouteDependencies } from "../../packages/broker/src/agents/routes.js";
import { randomUUID } from "node:crypto";
import { BatchGetCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  LIVE_PAGE_MAX, LiveResponseReaderSchema, LiveResponseSchema, LiveTileReaderSchema, LiveTileSchema, SESSION_STATUS_WORDS, SESSION_STATUSES, agentSessionKey, liveSessionKey, livePresenceKey, orgMemberKey, projectMemberKey,
  projectChannel, sharedSessionsKey, type LiveResponse, type OrgId, type SessionStatus,
} from "../../packages/contracts/src/index.js";
import { decidingOf, routeAgentSessionRequest } from "../../packages/broker/src/agent-sessions/routes.js";
import { batchGetItems, liveSessions, type LiveDependencies } from "../../packages/broker/src/agent-sessions/live.js";
import { recordPresence } from "../../packages/broker/src/agent-sessions/followers.js";
import { sweepAgentSessions } from "../../packages/broker/src/agent-sessions/sweep.js";
import { registerSessionNoticeSink } from "../../packages/broker/src/agent-sessions/notice-sink.js";
import { installRealtimeSink } from "../../packages/broker/src/realtime/sink.js";
import { createWriteApprovalRecord, type ApprovalDependencies } from "../../packages/broker/src/agents/approvals.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { projectorWorld, workflow } from "../support/agent-session-projector-world.js";
import { MAYA, OMAR, createDeveloperTaskBroker, grantProject } from "../support/developer-task-broker.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import { chosenNameKey } from "../../packages/broker/src/developer/chosen-name.js";
import { ARJUN, BO, CELL, MAX, MIA, OLA, ORG_A, ORG_B, PRIYA, T0, ZED, sessionWorld } from "../support/agent-session-world.js";

type Item = Record<string, unknown>;
const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3_600_000;
const hex = (digit: string) => digit.repeat(64);

interface Seed {
  kind?: "task" | "chain" | "local"; owner?: string; project?: string | null; status?: SessionStatus; endedAgoHours?: number; needs?: string[]; pending?: number; lastRunFailed?: boolean; workflowBlocked?: boolean;
  step?: string; peek?: string; cost?: number; createdAt?: string; title?: string; people?: Array<{ developerId: string; role: "owner" | "commenter" | "viewer" | "denied" }>; currentOwner?: string;
  orgId?: OrgId; startedBy?: string; tile?: boolean;
}

/** A company with `web` (Priya, Arjun, Max, Mia as viewer) and `api` (Max), and a way to seed sessions the way the summary refresh leaves them: the session, its task and its live tile. */
function world() {
  const w = sessionWorld();
  w.project(ORG_A, "api");
  w.grant(MAX, "api", "maintainer");
  const calls = { approvalsFor: 0, approvalsForSessions: [] as string[] };
  const decisions = new Map<string, Array<{ approvalId: string; title: string }>>();
  let minute = 0;
  const seed = (o: Seed = {}) => {
    const orgId = o.orgId ?? ORG_A;
    const ended = o.endedAgoHours !== undefined;
    const status: SessionStatus = o.status ?? (ended ? "succeeded" : "running");
    minute += 1;
    const createdAt = o.createdAt ?? iso(Date.parse("2026-10-22T07:00:00.000Z") + minute * 60_000);
    const updatedAt = iso(T0 - 5 * 60_000 + minute * 1000);
    const seeded = w.seedSession({ ...(o.kind === undefined ? {} : { kind: o.kind }), owner: o.owner ?? PRIYA, ...(o.project === undefined ? {} : { project: o.project }), orgId, ...(o.people === undefined ? {} : { people: o.people }), ...(o.currentOwner === undefined ? {} : { currentOwner: o.currentOwner }) });
    const meta = w.db.get(agentSessionKey(orgId, seeded.sessionId, "META")) as Item & { kind: string; project?: string; owner: { developerId: string; name: string }; title: string; where: unknown; revision: number };
    const { endedAt: _unused, ...open } = meta; // eslint-disable-line @typescript-eslint/no-unused-vars -- the seed's own end is replaced
    const endedAt = ended ? iso(T0 - o.endedAgoHours! * HOUR) : undefined;
    const summary = {
      status, ...(o.step === undefined ? {} : { step: o.step }), ...(o.peek === undefined ? {} : { peek: o.peek }), ...(o.lastRunFailed === true ? { lastRunFailed: true } : {}), ...(o.workflowBlocked === true ? { workflowBlocked: true } : {}),
      costUsd: o.cost ?? 0, needsPeople: o.needs ?? [], pendingApprovals: o.pending ?? 0, digest: "d".repeat(64), computedAt: updatedAt,
    };
    const record = {
      ...open, createdAt, updatedAt, summary, summaryRevision: 2, title: o.title ?? "Bump the Stripe SDK", ...(endedAt === undefined ? {} : { endedAt }),
      ...(o.startedBy === undefined ? {} : { startedBy: { kind: "member", developerId: o.startedBy } }),
    };
    w.db.set(record);
    if (o.tile !== false) {
      w.db.set({
        ...liveSessionKey(orgId, seeded.sessionId), entityType: "LIVE_SESSION", orgId, sessionId: seeded.sessionId, kind: record.kind, ...(record.project === undefined ? {} : { project: record.project }),
        ownerId: record.owner.developerId, owner: record.owner, title: record.title, where: record.where, status, summary, summaryRevision: 2, revision: record.revision, createdAt, updatedAt,
        ...(endedAt === undefined ? {} : { endedAt }),
      });
    }
    return { ...seeded, createdAt, updatedAt, record };
  };
  const deps = (extra: Partial<LiveDependencies> = {}): LiveDependencies => ({
    documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: CELL, cursorKey: "k".repeat(64),
    taskView: async () => ({}) as never,
    deciding: {
      approvals: async () => [],
      spend: async () => false,
      approvalsFor: async (caller, sessions) => {
        calls.approvalsFor += 1;
        calls.approvalsForSessions.push(...sessions.map((session) => session.sessionId));
        return new Map(sessions.flatMap((session) => {
          const mine = decisions.get(`${caller.developerId}|${session.sessionId}`);
          return mine === undefined ? [] : [[session.sessionId, mine] as const];
        }));
      },
    },
    ...extra,
  });
  const live = (who: string, query: Record<string, string> = {}, orgId: OrgId = ORG_A, extra: Partial<LiveDependencies> = {}) => {
    const search = new URLSearchParams(query).toString();
    const path = `/v1/app/live${search === "" ? "" : `?${search}`}`;
    return routeAgentSessionRequest(deps(extra), w.caller(who, orgId), { method: "GET", path, headers: {}, requestId: "r" }, new URL(`${CELL}${path}`)) as Promise<LiveResponse>;
  };
  const ids = async (who: string, query: Record<string, string> = {}, orgId: OrgId = ORG_A) => (await live(who, query, orgId)).tiles.map((tile) => tile.sessionId);
  return { ...w, seed, deps, live, ids, calls, decisions };
}
type World = ReturnType<typeof world>;

/** The company of the plan's test: seven sessions in `web` and `api`. */
function company() {
  const w = world();
  const s1 = w.seed({ step: "Planning", peek: "reading the plan", cost: 1.25 });
  const s2 = w.seed({ project: "api" });
  w.seedShare(ORG_A, s2.sessionId, { kind: "member", developerId: MIA }, "view");
  w.db.set({ ...sharedSessionsKey(ORG_A, { kind: "member", developerId: MIA }, s2.sessionId), entityType: "SHARED_SESSION", orgId: ORG_A, sessionId: s2.sessionId, principal: { kind: "member", developerId: MIA }, level: "view", sharedAt: "2026-10-22T08:10:00.000Z" });
  const s3 = w.seed({ status: "failed", endedAgoHours: 2 });
  const s4 = w.seed({ status: "failed", endedAgoHours: 30 });
  const s5 = w.seed({ status: "needs_person", needs: [ARJUN, MIA], pending: 1, step: "Waiting for an approval" });
  const s6 = w.seed({ status: "stopped" });
  const s7 = w.seed({ kind: "local", project: null });
  return { w, s1, s2, s3, s4, s5, s6, s7 };
}

afterEach(() => registerSessionNoticeSink(undefined));

describe("the shapes", () => {
  it("has a strict tile and response, and readers that keep what a newer server adds", () => {
    const tile = {
      contractVersion: 1, sessionId: "ses_00000000000000000001", kind: "task", title: "Bump the Stripe SDK", project: "web", owner: { developerId: PRIYA, name: "Priya" }, where: { kind: "cloud" }, status: "running",
      statusWords: "Running", costUsd: 0, viewingNow: [], viewingNowCount: 0, needsYou: false, following: false, actions: ["watch", "comment"], updatedAt: "2026-10-22T09:00:00.000Z",
    };
    expect(LiveTileSchema.parse(tile)).toEqual(tile);
    expect(LiveResponseSchema.parse({ tiles: [tile] })).toEqual({ tiles: [tile] });
    expect(LiveTileSchema.safeParse({ ...tile, extra: 1 }).success).toBe(false);
    expect(LiveTileSchema.safeParse({ ...tile, viewingNow: Array.from({ length: 6 }, () => ({ developerId: ARJUN, name: "Arjun" })) }).success).toBe(false);
    expect(LiveResponseSchema.safeParse({ tiles: Array.from({ length: LIVE_PAGE_MAX + 1 }, () => tile) }).success).toBe(false);
    const newer = LiveResponseReaderSchema.parse({ tiles: [{ ...tile, status: "snoozed", actions: ["watch", "teleport"], future: { a: 1 } }], next: "abc", more: true });
    expect(newer.tiles[0]).toMatchObject({ status: "unknown", actions: ["watch", "unknown"], future: { a: 1 } });
    expect(LiveTileReaderSchema.safeParse({ ...tile, status: undefined }).success).toBe(false);
  });

  it("has a word for every status, the fixed ones from the shared words", () => {
    for (const status of SESSION_STATUSES) expect(SESSION_STATUS_WORDS[status], status).toMatch(/^[A-Z]/u);
    expect(SESSION_STATUS_WORDS.stopped).toBe("Stopped");
    expect(SESSION_STATUS_WORDS.needs_person).toBe("Needs a person");
  });

  it("keeps the org's presence in one partition, per session and person", () => {
    expect(livePresenceKey(ORG_A, "ses_00000000000000000001", ARJUN)).toEqual({ pk: `ORG#${ORG_A}#LIVE_PRESENCE`, sk: `ses_00000000000000000001#${ARJUN}` });
    expect(() => livePresenceKey(ORG_A, "ses_00000000000000000001", "a#b")).toThrow();
  });
});

describe("who sees what on the wall (the plan's company)", () => {
  it("shows Arjun the open sessions he can view, newest first, with the words of the stopped one, and neither Mia's nor the local one", async () => {
    const { w, s1, s5, s6 } = company();
    const answer = await w.live(ARJUN, { filter: "all" });
    expect(answer.tiles.map((tile) => tile.sessionId)).toEqual([s6.sessionId, s5.sessionId, s1.sessionId]);
    expect(answer.next).toBeUndefined();
    const stopped = answer.tiles[0]!;
    expect(stopped).toMatchObject({ status: "stopped", statusWords: "Stopped" });
    expect(LiveResponseSchema.parse(answer)).toEqual(answer);
    expect(LiveResponseReaderSchema.parse(answer)).toEqual(answer);
    expect(answer.tiles[2]).toEqual({
      contractVersion: 1, sessionId: s1.sessionId, kind: "task", title: "Bump the Stripe SDK", project: "web", owner: { developerId: PRIYA, name: "Priya" }, where: { kind: "cloud" }, status: "running", statusWords: "Running",
      step: "Planning", peek: "reading the plan", costUsd: 1.25, viewingNow: [], viewingNowCount: 0, needsYou: false, following: false, actions: ["watch", "comment"], updatedAt: s1.updatedAt,
    });
  });

  it("gives Needs me exactly the session waiting on the caller, with a bare approval link", async () => {
    const { w, s5 } = company();
    w.decisions.set(`${ARJUN}|${s5.sessionId}`, [{ approvalId: "apr_aaaaaaaaaaaaaaaaaaaa", title: "Create a Linear issue" }, { approvalId: "apr_bbbbbbbbbbbbbbbbbbbb", title: "Other" }]);
    const answer = await w.live(ARJUN, { filter: "needs_me" });
    expect(answer.tiles).toHaveLength(1);
    expect(answer.tiles[0]).toMatchObject({ sessionId: s5.sessionId, needsYou: true, status: "needs_person", statusWords: "Needs a person", approvalUrl: `${CELL}/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa` });
    expect(answer.tiles[0]!.approvalUrl).not.toMatch(/ticket|\?/u);
    expect(await w.ids(PRIYA, { filter: "needs_me" })).toEqual([]);
  });

  it("gives Failed the session that ended failed two hours ago and not the one from thirty hours ago", async () => {
    const { w, s3 } = company();
    expect(await w.ids(ARJUN, { filter: "failed" })).toEqual([s3.sessionId]);
    // The 24 hours are counted from the clock now, not from the table's lazy deletion.
    w.clock.now += 23 * HOUR;
    expect(await w.ids(ARJUN, { filter: "failed" })).toEqual([]);
  });

  it("gives Failed an open session whose last run failed, and keeps it out of Mine for someone else", async () => {
    const w = world();
    const failing = w.seed({ status: "waiting", lastRunFailed: true });
    w.seed({ status: "waiting" });
    w.seed({ status: "failed", endedAgoHours: 1, owner: MAX });
    expect((await w.ids(ARJUN, { filter: "failed" })).length).toBe(2);
    expect(await w.ids(ARJUN, { filter: "mine" })).toEqual([]);
    expect((await w.live(ARJUN, { filter: "failed" })).tiles.map((tile) => tile.lastRunFailed)).toContain(true);
    expect(await w.ids(PRIYA, { filter: "mine" })).toContain(failing.sessionId);
  });

  it("gives Team the sessions on projects the caller has a role in: a web-only member sees no api session even when it is shared with them", async () => {
    const { w, s1, s2, s5, s6 } = company();
    expect(await w.ids(MIA, { filter: "all" })).toEqual([s6.sessionId, s5.sessionId, s2.sessionId, s1.sessionId]);
    expect(await w.ids(MIA, { filter: "team" })).toEqual([s6.sessionId, s5.sessionId, s1.sessionId]);
    expect(await w.ids(MAX, { filter: "team" })).toEqual([s6.sessionId, s5.sessionId, s2.sessionId, s1.sessionId]);
  });

  it("gives Team a local session only when it is shared with the caller", async () => {
    const { w, s7, s6, s5, s1 } = company();
    expect(await w.ids(ARJUN, { filter: "team" })).toEqual([s6.sessionId, s5.sessionId, s1.sessionId]);
    w.seedShare(ORG_A, s7.sessionId, { kind: "member", developerId: ARJUN }, "view");
    w.db.set({ ...sharedSessionsKey(ORG_A, { kind: "member", developerId: ARJUN }, s7.sessionId), entityType: "SHARED_SESSION", orgId: ORG_A, sessionId: s7.sessionId, principal: { kind: "member", developerId: ARJUN }, level: "view" });
    expect(await w.ids(ARJUN, { filter: "team" })).toEqual([s7.sessionId, s6.sessionId, s5.sessionId, s1.sessionId]);
    // Its owner has it on Mine and All, not on Team.
    expect(await w.ids(PRIYA, { filter: "team" })).not.toContain(s7.sessionId);
    expect(await w.ids(PRIYA, { filter: "mine" })).toContain(s7.sessionId);
  });

  it("gives Mine the sessions the caller owns now or started, and follows a take-over", async () => {
    const w = world();
    const own = w.seed({ owner: PRIYA });
    const started = w.seed({ owner: MAX, startedBy: PRIYA });
    const taken = w.seed({ owner: PRIYA, currentOwner: MAX, startedBy: MAX });
    expect((await w.ids(PRIYA, { filter: "mine" })).sort()).toEqual([own.sessionId, started.sessionId].sort());
    expect((await w.ids(MAX, { filter: "mine" })).sort()).toEqual([started.sessionId, taken.sessionId].sort());
    expect((await w.live(MAX, { filter: "all" })).tiles.find((tile) => tile.sessionId === taken.sessionId)).toMatchObject({ owner: { developerId: MAX } });
  });

  it("filters by project, and refuses a name that is not a project's", async () => {
    const { w, s2 } = company();
    expect(await w.ids(MAX, { filter: "all", project: "api" })).toEqual([s2.sessionId]);
    expect(await w.ids(ARJUN, { filter: "all", project: "api" })).toEqual([]);
    expect(await code(w.live(ARJUN, { project: "NOT A PROJECT" }))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("defaults to All, and refuses a filter, a limit or a method it does not take", async () => {
    const { w } = company();
    expect(await w.ids(ARJUN)).toEqual(await w.ids(ARJUN, { filter: "all" }));
    expect(await code(w.live(ARJUN, { filter: "everything" }))).toEqual({ code: "CONFIG_INVALID", message: "filter: must be one of all, mine, team, needs_me or failed" });
    for (const limit of ["0", "101", "abc", "1e1", "-1"]) expect(await code(w.live(ARJUN, { limit })), limit).toMatchObject({ code: "CONFIG_INVALID" });
    const post = routeAgentSessionRequest(w.deps(), w.caller(ARJUN), { method: "POST", path: "/v1/app/live", headers: {}, requestId: "r" }, new URL(`${CELL}/v1/app/live`));
    expect(await code(post)).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("the actions a tile offers are the caller's own", () => {
  it("gives Arjun watch and comment on Priya's tile, Max the owner's controls on it, a project viewer only watch, and an org admin who is no member of the project stop", async () => {
    const { w, s1 } = company();
    const of = async (who: string) => (await w.live(who, { filter: "all" })).tiles.find((tile) => tile.sessionId === s1.sessionId)!.actions;
    expect(await of(ARJUN)).toEqual(["watch", "comment"]);
    expect(await of(MIA)).toEqual(["watch"]);
    expect(await of(OLA)).toEqual(["watch", "comment", "stop"]);
    expect(await of(MAX)).toEqual(expect.arrayContaining(["watch", "comment", "steer", "stop", "take_over", "share"]));
    expect(await of(MAX)).not.toContain("retry");
    expect(await of(PRIYA)).toEqual(expect.arrayContaining(["stop", "handoff"]));
    // QA6-11: the owner already owns it, so Take over is for others only.
    expect(await of(PRIYA)).not.toContain("take_over");
  });

  it("offers retry on a session that failed", async () => {
    const { w, s3 } = company();
    const tile = (await w.live(MAX, { filter: "failed" })).tiles.find((entry) => entry.sessionId === s3.sessionId)!;
    expect(tile.actions).toEqual(expect.arrayContaining(["stop", "retry", "take_over"]));
    expect((await w.live(ARJUN, { filter: "failed" })).tiles[0]!.actions).toEqual(["watch", "comment"]);
  });

  it("offers retry on a session whose workflow is blocked (it shows as needing a person), to an editor and nobody below (Task 14 ruling)", async () => {
    const w = world();
    const blocked = w.seed({ status: "needs_person", needs: [PRIYA], workflowBlocked: true });
    const waiting = w.seed({ status: "needs_person", needs: [PRIYA] });
    const actionsOf = async (who: string, sessionId: string) => (await w.live(who, { filter: "all" })).tiles.find((tile) => tile.sessionId === sessionId)!.actions;
    expect(await actionsOf(MAX, blocked.sessionId)).toEqual(expect.arrayContaining(["stop", "retry", "take_over"]));
    expect(await actionsOf(PRIYA, blocked.sessionId)).toContain("retry");
    expect(await actionsOf(MAX, waiting.sessionId)).not.toContain("retry");
    expect(await actionsOf(ARJUN, blocked.sessionId)).toEqual(["watch", "comment"]);
    expect(await actionsOf(MIA, blocked.sessionId)).toEqual(["watch"]);
  });

  it("names the people who follow: the owner always, a follower by their item, nobody else", async () => {
    const { w, s1, s5 } = company();
    w.follower(ORG_A, s5.sessionId, ARJUN);
    const mine = async (who: string) => Object.fromEntries((await w.live(who, { filter: "all" })).tiles.map((tile) => [tile.sessionId, tile.following]));
    expect(await mine(ARJUN)).toMatchObject({ [s1.sessionId]: false, [s5.sessionId]: true });
    expect(await mine(PRIYA)).toMatchObject({ [s1.sessionId]: true, [s5.sessionId]: true });
  });
});

describe("it shows nothing the caller may not see, read live", () => {
  it("shows Bo nothing of org A and Priya nothing of org B, and a tile row forged into the wrong org shows nothing", async () => {
    const { w, s1 } = company();
    const bos = w.seed({ orgId: ORG_B, owner: BO, project: "web", title: "Bo's secret title" });
    expect(await w.ids(BO, { filter: "all" }, ORG_B)).toEqual([bos.sessionId]);
    expect(await w.ids(PRIYA, { filter: "all" })).not.toContain(bos.sessionId);
    // A row in org A's wall that names org B's session (and one that names a session of org A that is not there) leaks nothing and breaks nothing.
    w.db.set({ ...liveSessionKey(ORG_A, bos.sessionId), entityType: "LIVE_SESSION", orgId: ORG_A, sessionId: bos.sessionId, kind: "task", project: "web", ownerId: BO, title: "Bo's secret title", status: "running", createdAt: "2026-10-22T08:59:00.000Z", updatedAt: "2026-10-22T08:59:00.000Z" });
    w.db.set({ ...liveSessionKey(ORG_A, "ses_99999999999999999999"), entityType: "LIVE_SESSION", orgId: ORG_A, sessionId: "ses_99999999999999999999", kind: "task", project: "web", ownerId: PRIYA, status: "running", createdAt: "2026-10-22T08:58:00.000Z", updatedAt: "2026-10-22T08:58:00.000Z" });
    const answer = await w.live(PRIYA, { filter: "all" });
    expect(JSON.stringify(answer)).not.toContain("Bo's secret title");
    expect(answer.tiles.map((tile) => tile.sessionId)).toContain(s1.sessionId);
    expect(answer.tiles.map((tile) => tile.sessionId)).not.toContain(bos.sessionId);
    expect(await w.ids(BO, { filter: "all" }, ORG_B)).toEqual([bos.sessionId]);
  });

  it("shows a person who is no longer a member of the org nothing", async () => {
    const { w } = company();
    w.db.delete(orgMemberKey(ORG_A, ARJUN));
    expect(await w.ids(ARJUN, { filter: "all" })).toEqual([]);
  });

  it("hides a session from someone a Task People entry denies, and shows it to an org admin as a viewer", async () => {
    const w = world();
    const denied = w.seed({ people: [{ developerId: PRIYA, role: "owner" }, { developerId: ARJUN, role: "denied" }] });
    const open = w.seed({});
    expect(await w.ids(ARJUN, { filter: "all" })).toEqual([open.sessionId]);
    expect((await w.ids(OLA, { filter: "all" })).sort()).toEqual([denied.sessionId, open.sessionId].sort());
  });

  it("follows a revoked grant, a removed share and a withdrawn company-wide share at once, with nothing cached", async () => {
    const w = world();
    const web = w.seed({});
    const api = w.seed({ project: "api" });
    expect(await w.ids(ARJUN, { filter: "all" })).toEqual([web.sessionId]);
    // Shared with the whole company, Arjun sees the api session too.
    w.seedShare(ORG_A, api.sessionId, { kind: "org" }, "view");
    w.db.set({ ...sharedSessionsKey(ORG_A, { kind: "org" }, api.sessionId), entityType: "SHARED_SESSION", orgId: ORG_A, sessionId: api.sessionId, principal: { kind: "org" }, level: "view" });
    expect(await w.ids(ARJUN, { filter: "all" })).toEqual([api.sessionId, web.sessionId]);
    w.db.delete(sharedSessionsKey(ORG_A, { kind: "org" }, api.sessionId));
    w.db.delete(agentSessionKey(ORG_A, api.sessionId, "SHARE#ORG"));
    expect(await w.ids(ARJUN, { filter: "all" })).toEqual([web.sessionId]);
    // His grant on web is revoked: nothing is left.
    w.db.delete(projectMemberKey(ORG_A, ARJUN, "web"));
    w.members.revoke(ORG_A, "web", ARJUN);
    expect(await w.ids(ARJUN, { filter: "all" })).toEqual([]);
  });

  it("shows a session shared with a project to a member of that project, and to nobody else", async () => {
    const w = world();
    const api = w.seed({ project: "api" });
    w.seedShare(ORG_A, api.sessionId, { kind: "project", project: "web" }, "view");
    w.db.set({ ...sharedSessionsKey(ORG_A, { kind: "project", project: "web" }, api.sessionId), entityType: "SHARED_SESSION", orgId: ORG_A, sessionId: api.sessionId, principal: { kind: "project", project: "web" }, level: "view" });
    expect(await w.ids(ARJUN, { filter: "all" })).toEqual([api.sessionId]);
    expect(await w.ids(ZED, { filter: "all" })).toEqual([]);
  });

  it("skips a tile whose session cannot be read, with a log line that names no title, and still answers the rest", async () => {
    const w = world();
    const good = w.seed({});
    const broken = w.seed({});
    w.db.set({ ...(w.db.get(agentSessionKey(ORG_A, broken.sessionId, "META")) as Item), summary: { nonsense: true } });
    const logs: Array<Record<string, unknown>> = [];
    const answer = await liveSessions(w.deps({ log: (entry) => logs.push(entry) }), { ...w.caller(PRIYA) }, {});
    expect(answer.tiles.map((tile) => tile.sessionId)).toContain(good.sessionId);
    expect(answer.tiles.map((tile) => tile.sessionId)).not.toContain(broken.sessionId);
    expect(logs.map((entry) => entry.event)).toContain("agent_session.live_session_unreadable");
    expect(JSON.stringify(logs)).not.toContain("Bump the Stripe SDK");
  });
});

describe("approval links", () => {
  /** A write approval Priya's run waits on, routed to ids (Arjun may decide it; Mia is listed but a project viewer). */
  async function withRealApprovals() {
    const w = world();
    const s5 = w.seed({ status: "needs_person", needs: [ARJUN, MIA], pending: 1 });
    const approvals = {
      store: new AgentStore({ documentClient: w.db, tableName: "state", now: () => w.clock.now }), projectMembers: w.members, documentClient: w.db, tableName: "state", signInStore: w.signInStore,
      now: () => w.clock.now, confirmOrigin: CELL, log: () => undefined,
    } as unknown as ApprovalDependencies & AgentRouteDependencies;
    const made = await createWriteApprovalRecord({ documentClient: w.db, tableName: "state", now: () => w.clock.now }, {
      orgId: ORG_A, approvalId: "apr_aaaaaaaaaaaaaaaaaaaa", kind: "write", subject: { kind: "agent_run", taskId: s5.taskId, stepId: "work" }, operationId: randomUUID(), connector: "linear", connectorType: "linear",
      tool: "save_issue", toolAccess: "write", scope: "eng", schemaHash: "a".repeat(64), projectRevision: 1, scopeDigest: "b".repeat(64), arguments: { title: "SECRET-ARGUMENT" }, argumentsHash: "c".repeat(64),
      summary: "Create a Linear issue", class: "consequential", approvers: { kind: "ids", ids: [ARJUN, MIA] }, status: "PENDING", project: "web", owner: { developerId: PRIYA, name: "Priya" },
      attempts: 0, createdAt: "2026-10-22T08:30:00.000Z", expiresAt: "2026-10-29T08:30:00.000Z",
    } as never, [], 8);
    expect(made).toBe("created");
    return { w, s5, deciding: decidingOf(approvals) };
  }

  it("gives the link to the person who may decide the approval and to nobody else, from Plan 3's own live check", async () => {
    const { w, s5, deciding } = await withRealApprovals();
    const url = `${CELL}/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa`;
    const urlOf = async (who: string) => (await w.live(who, { filter: "all" }, ORG_A, { deciding })).tiles.find((tile) => tile.sessionId === s5.sessionId)!;
    expect(await urlOf(ARJUN)).toMatchObject({ needsYou: true, approvalUrl: url });
    // Mia is named as someone waited on, but a viewer of the project may not decide: the tile says so and carries no link.
    const mia = await urlOf(MIA);
    expect(mia.needsYou).toBe(true);
    expect(mia).not.toHaveProperty("approvalUrl");
    for (const who of [PRIYA, MAX, OLA]) expect(await urlOf(who), who).not.toHaveProperty("approvalUrl");
    expect(JSON.stringify(await w.live(ARJUN, {}, ORG_A, { deciding }))).not.toContain("SECRET-ARGUMENT");
  });

  it("asks for the decisions once for the whole page, and only for sessions that have one waiting", async () => {
    const { w, s5 } = company();
    w.seed({ status: "needs_person", needs: [ARJUN], pending: 2 });
    await w.live(ARJUN, { filter: "all" });
    expect(w.calls.approvalsFor).toBe(1);
    expect(w.calls.approvalsForSessions).toContain(s5.sessionId);
    expect(w.calls.approvalsForSessions).toHaveLength(2);
  });

  it("gives no link when the decisions cannot be read, and without a decisions source", async () => {
    const { w, s5 } = company();
    w.decisions.set(`${ARJUN}|${s5.sessionId}`, [{ approvalId: "apr_aaaaaaaaaaaaaaaaaaaa", title: "x" }]);
    const none = (await w.live(ARJUN, { filter: "needs_me" }, ORG_A, { deciding: undefined } as never)).tiles[0]!;
    expect(none).toMatchObject({ sessionId: s5.sessionId, needsYou: true });
    expect(none).not.toHaveProperty("approvalUrl");
    const failing = (await w.live(ARJUN, { filter: "needs_me" }, ORG_A, { deciding: { approvals: async () => [], spend: async () => false, approvalsFor: async () => { throw Object.assign(new Error("down"), { name: "AgentXError" }); } } })).tiles[0]!;
    expect(failing).not.toHaveProperty("approvalUrl");
  });
});

describe("who is looking", () => {
  const viewer = (w: World, sessionId: string, name: string, digit: string, ageMs = 10_000) =>
    w.db.set({ ...livePresenceKey(ORG_A, sessionId, hex(digit)), entityType: "LIVE_PRESENCE", orgId: ORG_A, sessionId, developerId: hex(digit), name, at: iso(T0 - ageMs), indexExpiresAt: Math.floor(T0 / 1000) + 60 });

  it("names at most five of the people looking, in name order, and counts them all; a stale heartbeat does not count, nor does a session the caller cannot see", async () => {
    const { w, s1, s2 } = company();
    ["Gus", "Ann", "Eve", "Cal", "Bea", "Fay", "Dan"].forEach((name, index) => viewer(w, s1.sessionId, name, String(index + 1)));
    viewer(w, s1.sessionId, "Old", "8", 200_000);
    viewer(w, s2.sessionId, "Elsewhere", "9");
    const tile = (await w.live(ARJUN, { filter: "all" })).tiles.find((entry) => entry.sessionId === s1.sessionId)!;
    expect(tile.viewingNow.map((who) => who.name)).toEqual(["Ann", "Bea", "Cal", "Dan", "Eve"]);
    expect(tile.viewingNowCount).toBe(7);
    expect(JSON.stringify(await w.live(ARJUN, { filter: "all" }))).not.toContain("Elsewhere");
  });

  it("leaves out a heartbeat whose own expiry has passed, although its time is fresh; one with no expiry still counts (Task 14 review)", async () => {
    const { w, s1 } = company();
    const put = (digit: string, name: string, extra: Record<string, unknown>) =>
      w.db.set({ ...livePresenceKey(ORG_A, s1.sessionId, hex(digit)), entityType: "LIVE_PRESENCE", orgId: ORG_A, sessionId: s1.sessionId, developerId: hex(digit), name, at: iso(T0 - 10_000), ...extra });
    put("1", "Live", { indexExpiresAt: Math.floor(T0 / 1000) + 60 });
    put("2", "Expired", { indexExpiresAt: Math.floor(T0 / 1000) - 1 });
    put("3", "Edge", { indexExpiresAt: Math.floor(T0 / 1000) });
    put("4", "Undated", {});
    const tile = (await w.live(ARJUN, { filter: "all" })).tiles.find((entry) => entry.sessionId === s1.sessionId)!;
    expect(tile.viewingNow.map((who) => who.name)).toEqual(["Live", "Undated"]);
    expect(tile.viewingNowCount).toBe(2);
  });

  it("logs when the presence index is cut at its row cap, without a name or a title (Task 14 review)", async () => {
    const { w, s1 } = company();
    for (let index = 0; index < 1001; index += 1) {
      const digit = String(index).padStart(64, "0");
      w.db.set({ ...livePresenceKey(ORG_A, s1.sessionId, digit), entityType: "LIVE_PRESENCE", orgId: ORG_A, sessionId: s1.sessionId, developerId: digit, name: "Crowd", at: iso(T0 - 1000), indexExpiresAt: Math.floor(T0 / 1000) + 60 });
    }
    const logs: Array<Record<string, unknown>> = [];
    const answer = await liveSessions(w.deps({ log: (entry) => logs.push(entry) }), w.caller(ARJUN), { filter: "all" });
    expect(logs.filter((entry) => entry.event === "agent_session.live_presence_truncated")).toEqual([{ event: "agent_session.live_presence_truncated", orgId: ORG_A }]);
    expect(answer.tiles.length).toBeGreaterThan(0);
    const quiet: Array<Record<string, unknown>> = [];
    const small = company();
    await liveSessions(small.w.deps({ log: (entry) => quiet.push(entry) }), small.w.caller(ARJUN), { filter: "all" });
    expect(quiet.map((entry) => entry.event)).not.toContain("agent_session.live_presence_truncated");
  });

  it("is written by the heartbeat, for the Live wall to read in one query", async () => {
    const { w, s1 } = company();
    const deps = w.deps();
    await recordPresence(deps, { ...w.caller(ARJUN), name: "Arjun" }, s1.sessionId);
    expect(w.db.get(livePresenceKey(ORG_A, s1.sessionId, ARJUN))).toMatchObject({ entityType: "LIVE_PRESENCE", orgId: ORG_A, sessionId: s1.sessionId, developerId: ARJUN, name: "Arjun", at: iso(T0), indexExpiresAt: Math.floor(T0 / 1000) + 90 });
    const tile = (await w.live(PRIYA, { filter: "all" })).tiles.find((entry) => entry.sessionId === s1.sessionId)!;
    expect(tile.viewingNow).toEqual([{ developerId: ARJUN, name: "Arjun" }]);
    expect(tile.viewingNowCount).toBe(1);
    // A heartbeat that cannot reach the wall's index never fails the session's own presence.
    w.db.injectFault({ command: "PutCommand", match: (input) => JSON.stringify(input).includes("LIVE_PRESENCE") && !JSON.stringify(input).includes("AGENT_SESSION_PRESENCE"), error: { name: "InternalServerError" } });
    w.clock.now += 120_000;
    await expect(recordPresence(deps, { ...w.caller(ARJUN), name: "Arjun" }, s1.sessionId)).resolves.toMatchObject({ viewingNow: [{ developerId: ARJUN }] });
  });
});

describe("a share partition cut at its row cap (Task 14 review)", () => {
  it("logs which kind of partition was cut, and nothing of the sessions in it", async () => {
    const { w } = company();
    for (let index = 0; index < 1001; index += 1) {
      const id = `ses_${String(700_000 + index).padStart(20, "0")}`;
      w.db.set({ ...sharedSessionsKey(ORG_A, { kind: "member", developerId: ARJUN }, id), entityType: "SHARED_SESSION", orgId: ORG_A, sessionId: id, principal: { kind: "member", developerId: ARJUN }, level: "view" });
    }
    const logs: Array<Record<string, unknown>> = [];
    await liveSessions(w.deps({ log: (entry) => logs.push(entry) }), w.caller(ARJUN), { filter: "all" });
    expect(logs.filter((entry) => entry.event === "agent_session.live_shares_truncated")).toEqual([{ event: "agent_session.live_shares_truncated", orgId: ORG_A, principal: "member" }]);
    const quiet: Array<Record<string, unknown>> = [];
    const small = company();
    await liveSessions(small.w.deps({ log: (entry) => quiet.push(entry) }), small.w.caller(ARJUN), { filter: "all" });
    expect(quiet.map((entry) => entry.event)).not.toContain("agent_session.live_shares_truncated");
  });
});

describe("a fixed number of reads", () => {
  /** The reads one request made, by command, from what the table was sent. */
  const readsOf = async (w: World, run: () => Promise<unknown>) => {
    const before = w.db.commandNames().length;
    await run();
    const sent = w.db.commandNames().slice(before);
    return { sent, total: sent.length, gets: sent.filter((name) => name === "GetCommand").length, queries: sent.filter((name) => name === "QueryCommand").length, batches: sent.filter((name) => name === "BatchGetCommand").length };
  };

  it("makes the same few reads for 300 sessions as for a handful: never one per tile", async () => {
    const small = world();
    for (let index = 0; index < 5; index += 1) small.seed({});
    const smallReads = await readsOf(small, () => small.live(PRIYA, { filter: "mine" }));

    const w = world();
    for (let index = 0; index < 300; index += 1) w.seed({ owner: index % 2 === 0 ? PRIYA : MAX });
    for (const filter of ["all", "mine", "team", "needs_me", "failed"]) {
      const reads = await readsOf(w, () => w.live(PRIYA, { filter }));
      expect(reads.total, `${filter}: ${reads.sent.join(" ")}`).toBeLessThanOrEqual(40);
      expect(reads.gets, filter).toBeLessThanOrEqual(5);
      expect(reads.queries, filter).toBeLessThanOrEqual(12);
    }
    const widest = await readsOf(w, () => w.live(PRIYA, { filter: "mine" }));
    // 300 sessions are 3 chunks of 100: a few batches each, not a read per session.
    expect(widest.batches).toBeLessThanOrEqual(20);
    expect(widest.total).toBeLessThanOrEqual(smallReads.total + 20);
  });

  it("pages through 300 sessions in pages of at most 100, each session once", async () => {
    const w = world();
    const seeded = Array.from({ length: 300 }, () => w.seed({}).sessionId);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const answer = await w.live(ARJUN, { filter: "all", ...(cursor === undefined ? {} : { cursor }) });
      expect(answer.tiles.length).toBeLessThanOrEqual(LIVE_PAGE_MAX);
      seen.push(...answer.tiles.map((tile) => tile.sessionId));
      cursor = answer.next;
      if (cursor === undefined) break;
    }
    expect(seen).toHaveLength(300);
    expect(new Set(seen).size).toBe(300);
    expect([...seen].sort()).toEqual([...seeded].sort());
  });

  it("asks the table again for what is left of a batch it only partly served, and fails closed if it never gets it", async () => {
    const w = world();
    const a = w.seed({});
    const send = w.db.send;
    let held = 0;
    w.db.send = async (command) => {
      const answer = await send(command) as { Responses?: Record<string, Item[]>; UnprocessedKeys?: Record<string, { Keys: unknown[] }> };
      if (command.constructor.name === "BatchGetCommand" && held < 1 && answer.Responses !== undefined) {
        held += 1;
        const [table, items] = Object.entries(answer.Responses)[0]!;
        const input = (command as unknown as { input: { RequestItems: Record<string, { Keys: unknown[] }> } }).input.RequestItems[table]!;
        return { Responses: { [table]: items.slice(0, -1) }, UnprocessedKeys: { [table]: { Keys: input.Keys.slice(-1) } } };
      }
      return answer;
    };
    expect(await w.ids(PRIYA, { filter: "all" })).toEqual([a.sessionId]);
    expect(held).toBe(1);
    // A table that never serves the key leaves the wall unavailable, never a wall without that session.
    w.db.send = async (command) => {
      const answer = await send(command) as { Responses?: Record<string, Item[]>; UnprocessedKeys?: Record<string, { Keys: unknown[] }> };
      if (command.constructor.name !== "BatchGetCommand" || answer.Responses === undefined) return answer;
      const [table] = Object.keys(answer.Responses);
      const input = (command as unknown as { input: { RequestItems: Record<string, { Keys: unknown[] }> } }).input.RequestItems[table!]!;
      return { Responses: { [table!]: [] }, UnprocessedKeys: { [table!]: { Keys: input.Keys } } };
    };
    expect(await code(w.live(PRIYA, { filter: "all" }))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
});

describe("paging", () => {
  it("pages with a sealed cursor that is bound to the person and the filter", async () => {
    const { w, s1, s2, s5, s6, s7 } = company();
    const first = await w.live(PRIYA, { filter: "all", limit: "2" });
    expect(first.tiles.map((tile) => tile.sessionId)).toEqual([s7.sessionId, s6.sessionId]);
    expect(first.next).toBeDefined();
    const second = await w.live(PRIYA, { filter: "all", limit: "2", cursor: first.next! });
    expect(second.tiles.map((tile) => tile.sessionId)).toEqual([s5.sessionId, s2.sessionId]);
    const third = await w.live(PRIYA, { filter: "all", limit: "2", cursor: second.next! });
    expect(third.tiles.map((tile) => tile.sessionId)).toEqual([s1.sessionId]);
    expect(third.next).toBeUndefined();
    const refused = { code: "CONFIG_INVALID", message: "cursor: is not one this list gave" };
    expect(await code(w.live(PRIYA, { filter: "mine", limit: "2", cursor: first.next! }))).toEqual(refused);
    expect(await code(w.live(PRIYA, { filter: "all", project: "web", limit: "2", cursor: first.next! }))).toEqual(refused);
    expect(await code(w.live(ARJUN, { filter: "all", limit: "2", cursor: first.next! }))).toEqual(refused);
    expect(await code(w.live(PRIYA, { filter: "all", cursor: "garbage" }))).toEqual(refused);
  });

  it("is unavailable, and not an unsealed list, when the server has no cursor key", async () => {
    const { w } = company();
    expect(await code(w.live(PRIYA, {}, ORG_A, { cursorKey: undefined } as never))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
});

describe("realtime: the Task 8 notices are what tells the wall to read again", () => {
  it("answers the new state after the change that sent a session.updated notice to the project's channel", async () => {
    const pw = projectorWorld();
    const published: Array<{ channel: string; events: string[] }> = [];
    installRealtimeSink({
      realtime: {
        endpoint: "https://events.example.com/event", region: "us-east-1", credentials: async () => ({ accessKeyId: "AKIA", secretAccessKey: "secret" }),
        fetch: (async (_url: unknown, init: { body: string }) => { published.push(JSON.parse(init.body) as { channel: string; events: string[] }); return new Response("{}", { status: 200 }); }) as never,
      },
    });
    const { sessionId, taskId } = pw.open();
    // The same table: Arjun reads Priya's session on the world the projector wrote.
    const deps = { documentClient: pw.w.db, tableName: "state", now: () => pw.w.clock.now, projectMembers: pw.w.members, signInStore: pw.w.signInStore, origin: CELL, cursorKey: "k".repeat(64), taskView: async () => ({}) as never };
    const wall = async () => (await liveSessions(deps, pw.w.caller(ARJUN), {})).tiles;
    expect(await wall()).toMatchObject([{ sessionId, status: "running", statusWords: "Running", needsYou: false }]);
    // The plan is ready for its owner to review.
    pw.patchTask(taskId, { workflow: workflow("PLAN_REVIEW", "WAITING") });
    pw.w.clock.now += 5_000;
    expect(await pw.refresh(sessionId)).toBe("updated");
    // The change told the project's channel (which a person on the wall listens to) and the session's own...
    const channels = published.map((entry) => entry.channel);
    expect(channels).toContain(projectChannel(ORG_A, "web"));
    expect(published.filter((entry) => entry.channel === projectChannel(ORG_A, "web")).flatMap((entry) => entry.events.map((event) => JSON.parse(event) as { type: string; sessionId: string }))).toContainEqual(expect.objectContaining({ type: "session.updated", sessionId }));
    // ...and the next read of the wall shows the new state, newer than the one before.
    const [after] = await wall();
    expect(after).toMatchObject({ sessionId, status: "needs_person", statusWords: "Needs a person", needsYou: false });
    expect((await liveSessions(deps, pw.w.caller(PRIYA), { filter: "needs_me" })).tiles.map((tile) => tile.sessionId)).toEqual([sessionId]);
    expect(Date.parse(after!.updatedAt)).toBeGreaterThan(T0);
  });
});

describe("the session record decides, and the tile only narrows what is read", () => {
  /** Rewrites a session's index tile only; the session record stays as it was. */
  const staleTile = (w: World, orgId: OrgId, sessionId: string, fields: Record<string, unknown>) => w.db.set({ ...(w.db.get(liveSessionKey(orgId, sessionId)) as Item), ...fields });
  const batches = async (w: World, run: () => Promise<unknown>) => {
    const before = w.db.commandNames().length;
    await run();
    return w.db.commandNames().slice(before).filter((name) => name === "BatchGetCommand").length;
  };

  it("does not show a session its record says is not a match, whatever its tile says", async () => {
    const w = world();
    const plain = w.seed({});
    const webOnly = w.seed({});
    const open = w.seed({});
    const ended = w.seed({ status: "failed", endedAgoHours: 40 });
    staleTile(w, ORG_A, plain.sessionId, { summary: { status: "needs_person", needsPeople: [ARJUN], pendingApprovals: 0 } });
    staleTile(w, ORG_A, webOnly.sessionId, { project: "api" });
    staleTile(w, ORG_A, open.sessionId, { summary: { status: "failed", lastRunFailed: true, needsPeople: [] } });
    staleTile(w, ORG_A, ended.sessionId, { endedAt: iso(T0 - HOUR), status: "failed", summary: { status: "failed", needsPeople: [] } });
    expect(await w.ids(ARJUN, { filter: "needs_me" })).toEqual([]);
    expect(await w.ids(MAX, { filter: "all", project: "api" })).toEqual([]);
    expect(await w.ids(ARJUN, { filter: "failed" })).toEqual([]);
    // A tile that says a session ended while the record says it is open does not take it off the wall; one that says open does not bring back what ended.
    staleTile(w, ORG_A, open.sessionId, { endedAt: iso(T0 - HOUR) });
    staleTile(w, ORG_A, ended.sessionId, { endedAt: undefined });
    const all = await w.ids(ARJUN, { filter: "all" });
    expect(all).toEqual(expect.arrayContaining([plain.sessionId, webOnly.sessionId]));
    expect(all).not.toContain(ended.sessionId);
  });

  it("skips a session record that is another org's, and one that names another session, without showing or failing", async () => {
    const w = world();
    const good = w.seed({});
    const foreign = w.seed({});
    const swapped = w.seed({});
    w.db.set({ ...(w.db.get(agentSessionKey(ORG_A, foreign.sessionId, "META")) as Item), orgId: ORG_B });
    w.db.set({ ...(w.db.get(agentSessionKey(ORG_A, swapped.sessionId, "META")) as Item), sessionId: good.sessionId });
    const logs: Array<Record<string, unknown>> = [];
    const answer = await liveSessions(w.deps({ log: (entry) => logs.push(entry) }), w.caller(PRIYA), {});
    expect(answer.tiles.map((tile) => tile.sessionId)).toEqual([good.sessionId]);
    expect(logs.filter((entry) => entry.event === "agent_session.live_session_unreadable")).toHaveLength(2);
  });

  // Release 0.4.18: one more batch than before, for the page's owners' chosen names (still fixed, whatever the number of sessions).
  it("reads nothing about sessions the filter cannot keep: Needs me, Failed and a project read one small batch among 300 sessions", async () => {
    const w = world();
    for (let index = 0; index < 299; index += 1) w.seed({});
    const mine = w.seed({ status: "needs_person", needs: [ARJUN], pending: 0, lastRunFailed: true });
    expect(await w.ids(ARJUN, { filter: "needs_me" })).toEqual([mine.sessionId]);
    expect(await batches(w, () => w.live(ARJUN, { filter: "needs_me" }))).toBeLessThanOrEqual(4);
    expect(await batches(w, () => w.live(ARJUN, { filter: "failed" }))).toBeLessThanOrEqual(4);
    expect(await batches(w, () => w.live(ARJUN, { filter: "all", project: "api" }))).toBeLessThanOrEqual(1);
    expect(await batches(w, () => w.live(ARJUN, { filter: "all", limit: "10" }))).toBeLessThanOrEqual(8);
  });

  it("reads none of the sessions that already ended when asked for the open ones", async () => {
    const w = world();
    const open = w.seed({});
    for (let index = 0; index < 150; index += 1) w.seed({ status: "succeeded", endedAgoHours: 1 });
    expect(await w.ids(PRIYA)).toEqual([open.sessionId]);
    expect(await batches(w, () => w.live(PRIYA, {}))).toBeLessThanOrEqual(4);
  });

  it("closes a session made late for a task that had already ended: once the sweep has looked, it is off the wall (Task 5 hand-off)", async () => {
    const pw = projectorWorld();
    const { sessionId, taskId } = pw.open();
    // As a lazily created session reads before anything has looked at its task: the start's summary, "starting", for a task that was closed long ago.
    pw.patchTask(taskId, { closedAt: "2026-10-20T08:00:00.000Z", outcome: "completed", updatedAt: "2026-10-20T08:00:00.000Z" });
    const deps = { documentClient: pw.w.db, tableName: "state", now: () => pw.w.clock.now, projectMembers: pw.w.members, signInStore: pw.w.signInStore, origin: CELL, cursorKey: "k".repeat(64), taskView: async () => ({}) as never };
    expect((await liveSessions(deps, pw.w.caller(PRIYA), {})).tiles.map((tile) => tile.sessionId)).toEqual([sessionId]);
    await sweepAgentSessions({ documentClient: pw.w.db, tableName: "state", now: () => pw.w.clock.now, log: () => undefined }, pw.w.clock.now, { budgetMs: 5000 });
    expect((await liveSessions(deps, pw.w.caller(PRIYA), {})).tiles).toEqual([]);
  });

  it("reads none of the sessions of other orgs that sit in the index, and none that ended failed outside the window or with another status", async () => {
    const w = world();
    const good = w.seed({});
    for (let index = 0; index < 150; index += 1) {
      const id = `ses_${String(900_000 + index).padStart(20, "0")}`;
      w.db.set({ ...liveSessionKey(ORG_A, id), entityType: "LIVE_SESSION", orgId: ORG_B, sessionId: id, kind: "task", project: "web", createdAt: "2026-10-22T08:00:00.000Z", updatedAt: "2026-10-22T08:00:00.000Z" });
    }
    expect(await w.ids(PRIYA)).toEqual([good.sessionId]);
    expect(await batches(w, () => w.live(PRIYA, {}))).toBeLessThanOrEqual(4);
  });

  it("ignores a share row and a presence row that name another org, even in this org's partitions", async () => {
    const w = world();
    const api = w.seed({ project: "api" });
    w.db.set({ ...sharedSessionsKey(ORG_A, { kind: "member", developerId: ARJUN }, api.sessionId), entityType: "SHARED_SESSION", orgId: ORG_B, sessionId: api.sessionId, principal: { kind: "member", developerId: ARJUN }, level: "view" });
    expect(await w.ids(ARJUN, { filter: "all" })).toEqual([]);
    w.db.set({ ...livePresenceKey(ORG_A, api.sessionId, hex("7")), entityType: "LIVE_PRESENCE", orgId: ORG_B, sessionId: api.sessionId, developerId: hex("7"), name: "Elsewhere", at: iso(T0 - 1000) });
    const tile = (await w.live(MAX, { filter: "all" })).tiles[0]!;
    expect(tile.viewingNowCount).toBe(0);
    expect(JSON.stringify(tile)).not.toContain("Elsewhere");
  });
});

describe("paging and bounds of the index", () => {
  it("gives no next page when the last page is exactly full, or when everything after it is hidden from the caller", async () => {
    const w = world();
    for (let index = 0; index < 3; index += 1) w.seed({});
    const exact = await w.live(PRIYA, { limit: "3" });
    expect(exact.tiles).toHaveLength(3);
    expect(exact.next).toBeUndefined();
    // Two older sessions the caller may not see lie behind a full page of three they may.
    const hidden = world();
    hidden.seed({ project: "api" });
    hidden.seed({ project: "api" });
    for (let index = 0; index < 3; index += 1) hidden.seed({});
    const page = await hidden.live(ARJUN, { limit: "3" });
    expect(page.tiles).toHaveLength(3);
    expect(page.next).toBeUndefined();
    // A short page that ran out is not a page with more behind it.
    const short = await hidden.live(ARJUN, { limit: "4" });
    expect(short.tiles).toHaveLength(3);
    expect(short.next).toBeUndefined();
  });

  it("gives a next page when more visible sessions follow, and the next page holds them", async () => {
    const w = world();
    const all = Array.from({ length: 5 }, () => w.seed({}).sessionId).reverse();
    const first = await w.live(PRIYA, { limit: "3" });
    expect(first.tiles.map((tile) => tile.sessionId)).toEqual(all.slice(0, 3));
    expect(first.next).toBeDefined();
    expect((await w.live(PRIYA, { limit: "3", cursor: first.next! })).tiles.map((tile) => tile.sessionId)).toEqual(all.slice(3));
  });

  it("reads at most LIVE_INDEX_SCAN_MAX index rows, in as many pages as the table gives, and logs that it cut the list", async () => {
    const w = world();
    const first = w.seed({});
    for (let index = 0; index < 1100; index += 1) {
      const id = `ses_${String(800_000 + index).padStart(20, "0")}`;
      w.db.set({ ...liveSessionKey(ORG_A, id), entityType: "LIVE_SESSION", orgId: ORG_A, sessionId: id, kind: "task", project: "web", createdAt: "2026-10-21T08:00:00.000Z", updatedAt: "2026-10-21T08:00:00.000Z" });
    }
    // The table hands out 200 rows to a page.
    const send = w.db.send;
    const indexPages: number[] = [];
    w.db.send = (command) => {
      if (command.constructor.name !== "QueryCommand") return send(command);
      const input = (command as unknown as { input: Record<string, unknown> }).input;
      if (String(input.ExpressionAttributeValues && (input.ExpressionAttributeValues as Record<string, unknown>)[":pk"]).endsWith("LIVE_SESSIONS")) indexPages.push(1);
      return send(new QueryCommand({ ...input, Limit: 200 } as never));
    };
    const logs: Array<Record<string, unknown>> = [];
    const answer = await liveSessions(w.deps({ log: (entry) => logs.push(entry) }), w.caller(PRIYA), {});
    w.db.send = send;
    expect(indexPages.length).toBeLessThanOrEqual(5);
    expect(logs.map((entry) => entry.event)).toContain("agent_session.live_index_truncated");
    expect(answer.tiles.map((tile) => tile.sessionId)).toContain(first.sessionId);
  });

  it("takes the same item named twice in one batch once, and gives back items in no promised order", async () => {
    const w = world();
    const a = w.seed({});
    const key = agentSessionKey(ORG_A, a.sessionId, "META");
    const got = await batchGetItems({ documentClient: w.db, tableName: "state" }, [key, key, { pk: "NOT", sk: "THERE" }]);
    expect([...got.values()].map((item) => item.sessionId)).toEqual([a.sessionId]);
  });
});

describe("what the decisions source may do", () => {
  it("gives no link for a session whose decisions came back empty, and lets an error that is not the app's own through", async () => {
    const { w, s5 } = company();
    const empty = (await w.live(ARJUN, { filter: "needs_me" }, ORG_A, { deciding: { approvals: async () => [], spend: async () => false, approvalsFor: async () => new Map([[s5.sessionId, []]]) } })).tiles[0]!;
    expect(empty).not.toHaveProperty("approvalUrl");
    const broken = { approvals: async () => [], spend: async () => false, approvalsFor: async () => { throw new TypeError("boom"); } };
    expect(await code(w.live(ARJUN, { filter: "needs_me" }, ORG_A, { deciding: broken }))).toMatchObject({ message: "boom" });
  });
});

describe("through the real broker", () => {
  beforeAll(async () => { await loadSlackBroker(); });

  it("serves the wall at /v1/app/live from the tile the start wrote: the starter sees it, a stranger sees nothing, and a person with a role sees it with their own actions", async () => {
    const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {} } });
    const started = await h.dev(MAYA, "POST", "/v1/app/agents/root-cause-analyst/runs", { requestId: randomUUID(), project: "payments", input: { text: "Why did checkout fail?" } });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const sessionId = (h.db.find((item) => item.entityType === "AGENT_SESSION")[0] as { sessionId: string }).sessionId;
    const read = async (who: typeof MAYA, query = "") => {
      const reply = await h.dev(who, "GET", `/v1/app/live${query}`);
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      const { requestId: _id, ...body } = reply.body; // eslint-disable-line @typescript-eslint/no-unused-vars -- the envelope's id
      return LiveResponseReaderSchema.parse(body);
    };
    const mine = await read(MAYA, "?filter=mine");
    expect(mine.tiles).toHaveLength(1);
    expect(mine.tiles[0]).toMatchObject({ sessionId, kind: "task", project: "payments", owner: { developerId: MAYA.developerId }, status: "starting", statusWords: "Starting", following: true, needsYou: false });
    expect(mine.tiles[0]!.actions).toEqual(expect.arrayContaining(["watch", "comment", "stop", "handoff"]));
    expect((await read(OMAR)).tiles).toEqual([]);
    grantProject(h.db, OMAR);
    expect((await read(OMAR)).tiles.map((tile) => tile.sessionId)).toEqual([sessionId]);
    expect((await read(OMAR)).tiles[0]!.actions).toEqual(["watch", "comment"]);
    expect((await read(OMAR, "?filter=mine")).tiles).toEqual([]);
    expect((await h.dev(OMAR, "GET", "/v1/app/live?filter=nope")).status).toBe(400);
    expect((await h.dev(OMAR, "POST", "/v1/app/live", {})).status).toBe(404);
  });
});

it("lets navigation count all 300 visible open sessions through the same visibility policy and one index read", async () => {
 const { navigationLive } = await import("../../packages/broker/src/agent-sessions/live.js");
 const w = world();for (let i = 0; i < 300; i++) w.seed({});
 const original = w.db.send.bind(w.db);let indexReads = 0;
 w.db.send = async command => { if (command instanceof QueryCommand && command.input.ExpressionAttributeValues?.[":pk"] === liveSessionKey(ORG_A, "ses_00000000000000000000").pk) indexReads++;return original(command); };
 expect(await navigationLive(w.deps(), w.caller(PRIYA))).toHaveLength(300);expect(indexReads).toBe(1);
 expect(await navigationLive(w.deps(), w.caller(BO, ORG_B))).toEqual([]);
});

it("shows the owner's chosen name on every tile of a session started before the rename, with one BatchGetItem for the page (release 0.4.18)", async () => {
  const w = world();
  for (let i = 0; i < 3; i++) w.seed({ owner: PRIYA });
  const sent: unknown[] = [];
  const send = (command: never) => { sent.push(command); return w.db.send(command); };
  const placeholder = await liveSessions(w.deps({ documentClient: { send } }), w.caller(PRIYA), { filter: "mine" });
  expect(placeholder.tiles.map((tile) => tile.owner.name)).toEqual(["Priya", "Priya", "Priya"]);
  w.db.set({ ...chosenNameKey(PRIYA), entityType: "DEVELOPER_NAME", developerId: PRIYA, name: "Priya R", chosenAt: "2026-10-27T09:00:00.000Z" });
  sent.length = 0;
  const answer = await liveSessions(w.deps({ documentClient: { send } }), w.caller(PRIYA), { filter: "mine" });
  expect(answer.tiles.map((tile) => tile.owner)).toEqual([PRIYA, PRIYA, PRIYA].map((developerId) => ({ developerId, name: "Priya R" })));
  expect(sent.filter((command) => command instanceof BatchGetCommand && JSON.stringify(command.input).includes("DEVELOPER_NAME#"))).toHaveLength(1);
  expect(sent.filter((command) => command instanceof GetCommand && String((command.input.Key as { pk: string }).pk).startsWith("DEVELOPER_NAME#"))).toEqual([]);
});
