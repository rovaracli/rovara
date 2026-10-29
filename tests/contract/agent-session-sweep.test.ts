// Plan 5 Task 7a: the sweep reaches every open session within a few runs (a cursor, a page of 100, a budget), corrects what the stream missed (a lazily
// created session of an old, ended task), clears old presence, and the drain gives an ended session's items their retention expiry.
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it, vi } from "vitest";
import {
  SESSION_RETENTION_DAYS,
  SESSION_SWEEP_BUDGET_MS,
  SESSION_SWEEP_CURSOR_KEY,
  SESSION_SWEEP_PAGE,
  agentSessionKey,
  endedSessionWorkKey,
  liveSessionKey,
  mySessionsKey,
  openAgentSessionKey,
  projectSessionsKey,
  sessionLegSk,
  sharedSessionsKey,
  sessionBindingKey,
  sessionSurfaceKey,
  type OrgId,
} from "../../packages/contracts/src/index.js";
import { ENDED_DRAIN_CURSOR_KEY, DRAIN_BUDGET_MS, drainEndedSessions, sweepAgentSessions } from "../../packages/broker/src/agent-sessions/sweep.js";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import "../support/skip-bundling.js";
import { createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { ORG_A, ORG_B, PRIYA, T0, sessionWorld } from "../support/agent-session-world.js";
import { DAY_MS, iso, projectorWorld } from "../support/agent-session-projector-world.js";

const ORG_C = "org_cccccccccccccccccccc" as OrgId;
const DAY = 86_400;

function openList(w: ReturnType<typeof sessionWorld>, perOrg: number) {
  const ids: Array<{ orgId: OrgId; sessionId: string }> = [];
  for (const orgId of [ORG_A, ORG_B, ORG_C]) {
    for (let n = 0; n < perOrg; n += 1) {
      const sessionId = `ses_${orgId.slice(4, 5)}${String(n).padStart(19, "0")}`;
      w.db.set({ ...openAgentSessionKey(orgId, sessionId), entityType: "OPEN_AGENT_SESSION", orgId, sessionId });
      ids.push({ orgId, sessionId });
    }
  }
  return ids;
}

describe("the session sweep", () => {
  it("refreshes a page of 100 a run, a different 100 each time, and wraps to the start after the last", async () => {
    const w = sessionWorld();
    const ids = openList(w, 400);
    expect(ids).toHaveLength(1200);
    const clock = { now: T0 };
    const seen: string[][] = [];
    let current: string[] = [];
    const refresh = async (_deps: unknown, orgId: string, sessionId: string) => { clock.now += 10; current.push(`${orgId}#${sessionId}`); return "unchanged" as const; };
    const deps = { documentClient: w.db, tableName: "state", now: () => clock.now, log: () => undefined, refresh };
    // 100 refreshes at 10 ms each fill a 1,000 ms budget exactly: one page a run.
    for (let run = 0; run < 13; run += 1) {
      current = [];
      await sweepAgentSessions(deps, clock.now, { budgetMs: 1000 });
      seen.push(current);
    }
    expect(SESSION_SWEEP_PAGE).toBe(100);
    expect(seen.slice(0, 3).map((run) => run.length)).toEqual([100, 100, 100]);
    expect(new Set(seen.slice(0, 3).flat()).size).toBe(300);
    expect(new Set(seen.slice(0, 12).flat()).size).toBe(1200); // every open session within twelve runs, across all three orgs
    expect(seen[12]).toEqual(seen[0]); // and the thirteenth starts over
    expect(w.db.get(SESSION_SWEEP_CURSOR_KEY)).toBeDefined();
  });

  it("reads the list a page at a time", async () => {
    const w = sessionWorld();
    openList(w, 50);
    const limits: unknown[] = [];
    const base = w.db.send.bind(w.db);
    const spy = { send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => { if (command.constructor.name === "QueryCommand") limits.push(command.input.Limit); return base(command); } };
    await sweepAgentSessions({ documentClient: spy, tableName: "state", now: () => T0, log: () => undefined, refresh: async () => "unchanged" as const }, T0);
    expect(limits[0]).toBe(SESSION_SWEEP_PAGE);
  });

  it("stops at its budget and saves where it got to, and the next run starts after it", async () => {
    const w = sessionWorld();
    openList(w, 50);
    const clock = { now: T0 };
    const order: string[] = [];
    const refresh = async (_deps: unknown, orgId: string, sessionId: string) => { clock.now += 100; order.push(`${orgId}#${sessionId}`); return "unchanged" as const; };
    const deps = { documentClient: w.db, tableName: "state", now: () => clock.now, log: () => undefined, refresh };
    await sweepAgentSessions(deps, clock.now, { budgetMs: 1000 });
    expect(order).toHaveLength(10);
    await sweepAgentSessions(deps, clock.now, { budgetMs: 1000 });
    expect(order.slice(10, 20)).not.toEqual(order.slice(0, 10));
    expect(new Set(order).size).toBe(20);
    expect(SESSION_SWEEP_BUDGET_MS).toBe(20_000);
  });

  it("refreshes each session under the org its own record names, and skips and logs one whose key says another", async () => {
    const w = sessionWorld();
    const good = { orgId: ORG_A, sessionId: "ses_00000000000000000001" };
    w.db.set({ ...openAgentSessionKey(good.orgId, good.sessionId), entityType: "OPEN_AGENT_SESSION", ...good });
    w.db.set({ ...openAgentSessionKey(ORG_A, "ses_00000000000000000002"), entityType: "OPEN_AGENT_SESSION", orgId: ORG_B, sessionId: "ses_00000000000000000002" });
    const logs: Array<Record<string, unknown>> = [];
    const calls: string[] = [];
    const refresh = async (_d: unknown, orgId: string, sessionId: string) => { calls.push(`${orgId}#${sessionId}`); return "unchanged" as const; };
    await sweepAgentSessions({ documentClient: w.db, tableName: "state", now: () => T0, log: (entry: Record<string, unknown>) => logs.push(entry), refresh }, T0);
    expect(calls).toEqual([`${ORG_A}#ses_00000000000000000001`]);
    expect(logs.map((entry) => entry.event)).toContain("agent_session.sweep_org_mismatch");
  });

  it("corrects a lazily created session of an old, ended task: it stops showing 'starting' on the live and open indexes", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "SUCCEEDED");
    p.patchTask(s.taskId, { closedAt: "2026-10-20T08:30:00.000Z" });
    expect(p.tile(s.sessionId)?.status).toBe("starting");
    await sweepAgentSessions(p.deps, T0);
    expect(p.sessionOf(s.sessionId)).toMatchObject({ summary: { status: "succeeded" }, endedAt: "2026-10-20T08:30:00.000Z" });
    expect(p.tile(s.sessionId)).toMatchObject({ summary: { status: "succeeded" } });
    expect(p.w.db.get(openAgentSessionKey(ORG_A, s.sessionId))).toBeUndefined();
    expect(p.w.db.get(endedSessionWorkKey("2026-10-22", ORG_A, s.sessionId))).toBeDefined();
  });

  it("brings a session the projector skipped up to date, and one the stream never reported", async () => {
    const p = projectorWorld();
    const sessions = Array.from({ length: 5 }, () => p.open());
    for (const s of sessions) p.operation(s.workspaceId, "task", "RUNNING");
    await sweepAgentSessions(p.deps, T0);
    expect(sessions.map((s) => p.sessionOf(s.sessionId).summary.status)).toEqual(Array(5).fill("running"));
  });

  it("deletes presence items past their time and leaves current ones", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "RUNNING");
    const nowSeconds = Math.floor(T0 / 1000);
    p.w.db.set({ ...agentSessionKey(ORG_A, s.sessionId, `PRESENCE#${"a".repeat(64)}`), entityType: "AGENT_SESSION_PRESENCE", orgId: ORG_A, sessionId: s.sessionId, indexExpiresAt: nowSeconds - 5 });
    p.w.db.set({ ...agentSessionKey(ORG_A, s.sessionId, `PRESENCE#${"b".repeat(64)}`), entityType: "AGENT_SESSION_PRESENCE", orgId: ORG_A, sessionId: s.sessionId, indexExpiresAt: nowSeconds + 60 });
    await sweepAgentSessions(p.deps, T0);
    const left = p.w.db.find((item) => item.pk === agentSessionKey(ORG_A, s.sessionId, "META").pk && String(item.sk).startsWith("PRESENCE#")).map((item) => item.sk);
    expect(left).toEqual([`PRESENCE#${"b".repeat(64)}`]);
  });
});

describe("retention: drainEndedSessions", () => {
  function ended() {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "SUCCEEDED");
    const closedAt = "2026-10-20T08:30:00.000Z";
    p.patchTask(s.taskId, { closedAt });
    return { p, s, closedAt, expires: Math.floor(Date.parse(closedAt) / 1000) + SESSION_RETENTION_DAYS * DAY };
  }
  const seedItems = (p: ReturnType<typeof projectorWorld>, sessionId: string, orgId = ORG_A) => {
    const put = (key: { pk: string; sk: string }, extra: Record<string, unknown> = {}) => { p.w.db.set({ ...key, orgId, sessionId, ...extra }); return key; };
    return {
      share: put(agentSessionKey(orgId, sessionId, "SHARE#MEMBER#x"), { entityType: "AGENT_SESSION_SHARE", principal: { kind: "member", developerId: "x".repeat(64) }, level: "view" }),
      follower: put(agentSessionKey(orgId, sessionId, "FOLLOWER#x")),
      binding: put(sessionBindingKey(orgId, sessionId, "slack_thread"), { binding: { kind: "slack_thread", teamId: "T1", channelId: "C1", threadTs: "1695500000.000100" } }),
      leg: put(agentSessionKey(orgId, sessionId, sessionLegSk(1))),
      message: put(agentSessionKey(orgId, sessionId, "MESSAGE#msg_0123456789abcdefghij")),
      turn: put(agentSessionKey(orgId, sessionId, "TURN#2026-10-20T08:00:00.000Z#1")),
      mine: put(mySessionsKey(orgId, PRIYA, "2026-10-22T08:00:00.000Z", sessionId)),
      project: put(projectSessionsKey(orgId, "web", "2026-10-22T08:00:00.000Z", sessionId)),
      shared: put(sharedSessionsKey(orgId, { kind: "member", developerId: "x".repeat(64) }, sessionId)),
      surface: put(sessionSurfaceKey(orgId, { kind: "slack_thread", teamId: "T1", channelId: "C1", threadTs: "1695500000.000100" })),
    };
  };

  it("gives a session's share, follower, binding, leg, message and turn items, its list entries and its surface key an expiry a year after it ended, then deletes the work item", async () => {
    const { p, s, expires } = ended();
    const keys = seedItems(p, s.sessionId);
    await p.refresh(s.sessionId);
    const work = endedSessionWorkKey("2026-10-22", ORG_A, s.sessionId);
    expect(p.w.db.get(work)).toBeDefined();
    p.w.clock.now = Date.parse("2026-10-22T12:00:00.000Z");
    await drainEndedSessions(p.deps, p.w.clock.now);
    for (const [name, key] of Object.entries(keys)) expect(p.w.db.get(key)?.indexExpiresAt, name).toBe(expires);
    expect(p.w.db.get(work)).toBeUndefined();
    // An item the session never had is not made by the drain.
    expect(p.w.db.get(agentSessionKey(ORG_A, s.sessionId, "SHARE#ORG"))).toBeUndefined();
    // And a second run changes nothing.
    const before = p.w.db.transactions().length;
    await drainEndedSessions(p.deps, p.w.clock.now);
    expect(p.w.db.transactions().length).toBe(before);
  });

  it("pages a session with many items, saves its place on the work item, and resumes after the deadline", async () => {
    const { p, s, expires } = ended();
    await p.refresh(s.sessionId);
    for (let n = 0; n < 250; n += 1) p.w.db.set({ ...agentSessionKey(ORG_A, s.sessionId, `MESSAGE#msg_${String(n).padStart(20, "0")}`), orgId: ORG_A, sessionId: s.sessionId });
    const work = endedSessionWorkKey("2026-10-22", ORG_A, s.sessionId);
    p.w.clock.now = Date.parse("2026-10-22T12:00:00.000Z");
    // A clock that jumps past the budget after the first page of 100.
    const base = p.w.db.send.bind(p.w.db);
    let updates = 0;
    const timed = { send: async (command: { constructor: { name: string } }) => { if (command.constructor.name === "UpdateCommand") { updates += 1; if (updates === 100) p.w.clock.now += DRAIN_BUDGET_MS + 1; } return base(command as never); } };
    await drainEndedSessions({ ...p.deps, documentClient: timed }, p.w.clock.now);
    const partial = p.w.db.get(work)!;
    expect(partial.cursor).toMatchObject({ prefix: 2, after: expect.stringMatching(/^MESSAGE#/) as string });
    const stamped = () => p.w.db.find((item) => String(item.sk).startsWith("MESSAGE#") && item.indexExpiresAt === expires).length;
    expect(stamped()).toBeGreaterThanOrEqual(100);
    expect(stamped()).toBeLessThan(250);
    await drainEndedSessions(p.deps, p.w.clock.now);
    expect(stamped()).toBe(250);
    expect(p.w.db.get(work)).toBeUndefined();
  });

  it("resumes from a saved day, so a schedule that was down for days loses nothing", async () => {
    const p = projectorWorld();
    const old = p.open();
    p.operation(old.workspaceId, "task", "SUCCEEDED");
    p.patchTask(old.taskId, { closedAt: "2026-10-12T08:30:00.000Z" });
    p.w.clock.now = Date.parse("2026-10-12T09:00:00.000Z");
    await p.refresh(old.sessionId);
    const keys = seedItems(p, old.sessionId);
    expect(p.w.db.get(ENDED_DRAIN_CURSOR_KEY)).toMatchObject({ day: "2026-10-12" });
    // The next run is ten days later.
    p.w.clock.now = Date.parse("2026-10-22T12:00:00.000Z");
    await drainEndedSessions(p.deps, p.w.clock.now);
    expect(p.w.db.get(keys.share)?.indexExpiresAt).toBe(Math.floor(Date.parse("2026-10-12T08:30:00.000Z") / 1000) + SESSION_RETENTION_DAYS * DAY);
    expect(p.w.db.get(endedSessionWorkKey("2026-10-12", ORG_A, old.sessionId))).toBeUndefined();
    expect(p.w.db.get(ENDED_DRAIN_CURSOR_KEY)?.day).toBe("2026-10-21");
  });

  it("never creates an item: one a session never had stays absent", async () => {
    const { p, s } = ended();
    await p.refresh(s.sessionId);
    p.w.db.set({ ...agentSessionKey(ORG_A, s.sessionId, "SHARE#MEMBER#y"), orgId: ORG_A, sessionId: s.sessionId, principal: { kind: "member", developerId: "y".repeat(64) }, level: "view" });
    const before = p.w.db.find(() => true).length;
    p.w.clock.now = Date.parse("2026-10-22T12:00:00.000Z");
    await drainEndedSessions(p.deps, p.w.clock.now);
    // The work item is gone; nothing was made (no list entry for the owner, the project or the share, no surface key).
    expect(p.w.db.find(() => true).length).toBe(before - 1);
  });

  it("does not touch another org's session through a work item that names the wrong org", async () => {
    const { p, s } = ended();
    await p.refresh(s.sessionId);
    seedItems(p, s.sessionId);
    const work = endedSessionWorkKey("2026-10-22", ORG_A, s.sessionId);
    p.w.db.set({ ...p.w.db.get(work)!, orgId: ORG_B });
    p.w.clock.now = Date.parse("2026-10-22T12:00:00.000Z");
    await drainEndedSessions(p.deps, p.w.clock.now);
    expect(p.w.db.find((item) => item.indexExpiresAt !== undefined && String(item.sk).startsWith("SHARE#"))).toHaveLength(0);
    expect(p.logs.map((entry) => entry.event)).toContain("agent_session.drain_org_mismatch");
  });

  it("an item written to an ended session after the drain already ran is stamped at write (Task 4's rule), and the live tile expires after a day", async () => {
    const { p, s } = ended();
    await p.refresh(s.sessionId);
    const tile = p.tile(s.sessionId)!;
    expect(tile.indexExpiresAt).toBe(Math.floor(Date.parse("2026-10-20T08:30:00.000Z") / 1000) + 24 * 3600);
    expect(DAY_MS).toBe(86_400_000);
    expect(iso(T0)).toBe("2026-10-22T09:00:00.000Z");
    expect(liveSessionKey(ORG_A, s.sessionId).pk).toContain("LIVE_SESSIONS");
  });
});

describe("the broker's sweep event", () => {
  it("answers { source: agentx.session-sweep } with the sweep, then the drain, and a failure of the first never stops the second", async () => {
    const harness = await createDeveloperTaskBroker();
    const result = JSON.parse((await harness.handler({ source: "agentx.session-sweep" })).body) as { sweep: unknown; drain: unknown };
    expect(result.sweep).toMatchObject({ refreshed: 0, unchanged: 0, failed: 0 });
    expect(result.drain).toMatchObject({ drained: 0, pending: false });
    harness.db.injectFault({ command: "QueryCommand", match: (input) => input.KeyConditionExpression === "pk = :pk" && (input.ExpressionAttributeValues as { ":pk"?: string })[":pk"] === "OPEN_AGENT_SESSIONS", error: { name: "ThrottlingException" }, times: 1 });
    const failed = JSON.parse((await harness.handler({ source: "agentx.session-sweep" })).body) as { sweep: unknown; drain: unknown };
    expect(failed.sweep).toBe("failed");
    expect(failed.drain).toMatchObject({ pending: false });
  });
});

describe("the sweep event's time", () => {
  it("gives the drain only what is left of the event's 25 seconds after the sweep", async () => {
    const harness = await createDeveloperTaskBroker();
    const today = new Date().toISOString().slice(0, 10);
    harness.db.set({ ...openAgentSessionKey(ORG_A, "ses_00000000000000000001"), entityType: "OPEN_AGENT_SESSION", orgId: ORG_A, sessionId: "ses_00000000000000000001" });
    harness.db.set({ ...endedSessionWorkKey(today, ORG_A, "ses_00000000000000000002"), entityType: "ENDED_AGENT_SESSION", orgId: ORG_A, sessionId: "ses_00000000000000000002" });
    const real = Date.now.bind(Date);
    let offset = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => real() + offset);
    // The sweep saves its cursor when it is done: that is when 26 seconds have gone by.
    const stop = harness.db.onWrite((change) => { if (change.after?.pk === SESSION_SWEEP_CURSOR_KEY.pk) offset = 26_000; });
    try {
      const result = JSON.parse((await harness.handler({ source: "agentx.session-sweep" })).body) as { drain: { drained: number; pending: boolean } };
      expect(result.drain).toEqual({ drained: 0, pending: true });
    } finally {
      stop();
      clock.mockRestore();
    }
  });
});

describe("the sweep's schedule", () => {
  const sweeps = (stack: Stack) => Object.values(Template.fromStack(stack).findResources("AWS::Scheduler::Schedule") as Record<string, { Properties: Record<string, unknown> }>)
    .map((resource) => resource.Properties).filter((properties) => JSON.stringify(properties.Target).includes("agentx.session-sweep"));
  const named = () => buildAgentXApp({ agentxEnv: "staging" }).node.children.filter((child): child is Stack => Stack.isStack(child)).find((stack) => stack.stackName === "agentx-staging-control-plane")!;

  // One synth of the whole named app (the slowest step on a CI runner) serves both reads, within the full-app synth budget the infrastructure tests use.
  it("is an own schedule of a named environment: every 5 minutes, with the exact input, on the recovery role", () => {
    const stack = named();
    const [sweep, ...rest] = sweeps(stack);
    expect(rest).toHaveLength(0);
    expect(sweep).toMatchObject({
      FlexibleTimeWindow: { Mode: "OFF" }, ScheduleExpression: "rate(5 minutes)", State: "ENABLED",
      Target: { Input: JSON.stringify({ source: "agentx.session-sweep" }), RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 300 } },
    });
    const recovery = Object.values(Template.fromStack(stack).findResources("AWS::Scheduler::Schedule") as Record<string, { Properties: { Target: { RoleArn: unknown; Input: string } } }>)
      .find((resource) => resource.Properties.Target.Input.includes("agentx.workflow-merge-recovery"))!;
    expect((sweep!.Target as { RoleArn: unknown }).RoleArn).toEqual(recovery.Properties.Target.RoleArn);
  }, 240_000);

  it("is not in a legacy (unnamed) environment's template", () => {
    expect(sweeps(new ControlPlaneStack(new App(), "LegacySweepControlPlane"))).toHaveLength(0);
  });
});
