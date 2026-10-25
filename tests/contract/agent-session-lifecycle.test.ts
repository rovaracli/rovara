// Plan 5 Task 21: sessions follow the members who leave or merge, and go with a closed company. A removed member's follows, presence and shares go and their devices are revoked, and
// nothing of theirs passes to the successor (their task sessions keep refusing through R60). A merged duplicate's follows, shares, session ownership (the session, its live tile, its
// "mine" row and the task's current owner) and devices move to the survivor. A mover that runs out of time leaves the marker for the next drain. Closing an org deletes its live index,
// open and ended work entries, presence, devices and change feeds, shortens the rest to 30 days, and touches no other org.
import { afterEach, describe, expect, it } from "vitest";
import {
  agentSessionKey, changesKey, deviceCommandKey, deviceKey, endedSessionWorkKey, livePresenceKey, liveSessionKey, memberDevicesKey, memberMergeQueueKey, memberRemovalQueueKey,
  mySessionsKey, openAgentSessionKey, orgMemberKey, orgRemovedKey, projectMetaKey, projectMonthStatsKey, projectSessionsKey, sharedSessionsKey, sessionSurfaceKey,
  type OrgId,
} from "@agentx/contracts";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { drainMemberMerges, drainMemberRemovals, onMemberRemoved, onMembersMerged, resolveMember, type LifecycleDeps } from "../../packages/broker/src/agents/lifecycle.js";
import { clearOrgSessions, closeOrgSessions, onSessionMemberRemoved, onSessionMembersMerged } from "../../packages/broker/src/agent-sessions/lifecycle.js";
import "../../packages/broker/src/agent-sessions/index.js";
import { liveSessions } from "../../packages/broker/src/agent-sessions/live.js";
import { requireCreatorStillMember } from "../../packages/broker/src/developer/creator-member.js";
import { requireNewWorkAllowed } from "../../packages/broker/src/developer/project-roles.js";
import { effectiveTaskOwner, taskIndexKey, taskKey, type DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { ARJUN, BO, CELL, MAX, MIA, NAMES, ORG_A, ORG_B, PRIYA, T0, ZED, sessionWorld } from "../support/agent-session-world.js";

type Item = Record<string, unknown>;
const hex = (digit: string) => digit.repeat(64);
const OWNER = hex("1");
const CREATED_AT = "2026-10-22T08:00:00.000Z";
const DAY = 86_400;
const DEVICE_A = "dvc_aaaaaaaaaaaaaaaaaaaa";
const DEVICE_B = "dvc_bbbbbbbbbbbbbbbbbbbb";
const DEVICE_C = "dvc_cccccccccccccccccccc";
const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; name?: string; message: string }) => ({ code: error.code, name: error.name, message: error.message.replace(`${String(error.code)}: `, "") }));

function world() {
  const w = sessionWorld();
  w.member(ORG_A, OWNER, "owner");
  const store = new AgentStore({ documentClient: w.db, tableName: "state", now: () => w.clock.now });
  const lines: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const deps = {
    store, projectMembers: w.members, documentClient: w.db, tableName: "state", signInStore: w.signInStore, now: () => w.clock.now,
    log: (event: string, fields: Record<string, unknown>) => { lines.push({ event, fields }); },
  } as unknown as LifecycleDeps;
  const get = (key: { pk: string; sk: string }) => w.db.get(key) as Item | undefined;
  const snapshot = () => JSON.stringify([...w.db.items.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));

  /** A session as the start leaves it: the record, its live tile, its "mine" row and (for a task) the creator's task-list row. */
  let sequence = 0;
  const session = (options: Parameters<typeof w.seedSession>[0] & { followers?: string[] } = {}) => {
    sequence += 1;
    const seeded = w.seedSession(options);
    const orgId = options.orgId ?? ORG_A;
    const owner = options.owner ?? PRIYA;
    const meta = get(agentSessionKey(orgId, seeded.sessionId, "META"))!;
    const createdAt = `${CREATED_AT.slice(0, 17)}${String(sequence).padStart(2, "0")}.000Z`;
    w.db.set({ ...meta, createdAt });
    if ((options.kind ?? "task") === "task") w.db.set({ ...get(taskKey(seeded.taskId))!, createdAt });
    w.db.set({
      ...liveSessionKey(orgId, seeded.sessionId), entityType: "LIVE_SESSION", orgId, sessionId: seeded.sessionId, kind: meta["kind"], project: "web", ownerId: owner, owner: meta["owner"], title: meta["title"],
      where: meta["where"], status: "running", summary: meta["summary"], summaryRevision: 1, revision: meta["revision"], createdAt, updatedAt: createdAt,
    });
    w.db.set({ ...mySessionsKey(orgId, owner, createdAt, seeded.sessionId), entityType: "MY_SESSION", orgId, sessionId: seeded.sessionId, developerId: owner, createdAt });
    w.db.set({ ...projectSessionsKey(orgId, "web", createdAt, seeded.sessionId), entityType: "PROJECT_SESSION", orgId, sessionId: seeded.sessionId, project: "web", createdAt });
    if ((options.kind ?? "task") === "task") {
      w.db.set({ ...taskIndexKey(owner, createdAt, seeded.taskId), entityType: "DEVELOPER_TASK_INDEX", taskId: seeded.taskId, orgId, project: "web", title: "Bump the Stripe SDK", client: "app", status: "RUNNING", createdAt, updatedAt: createdAt });
    }
    for (const follower of options.followers ?? []) follow(orgId, seeded.sessionId, follower);
    return { ...seeded, orgId, owner, createdAt };
  };
  const follow = (orgId: OrgId, sessionId: string, developerId: string) => {
    w.follower(orgId, sessionId, developerId);
    const meta = get(agentSessionKey(orgId, sessionId, "META"))!;
    w.db.set({ ...meta, followerCount: Number(meta["followerCount"] ?? 0) + 1 });
  };
  const present = (orgId: OrgId, sessionId: string, developerId: string) => {
    w.db.set({ ...agentSessionKey(orgId, sessionId, `PRESENCE#${developerId}`), entityType: "AGENT_SESSION_PRESENCE", orgId, sessionId, developerId, name: NAMES[developerId] ?? "Someone", at: new Date(T0).toISOString() });
    w.db.set({ ...livePresenceKey(orgId, sessionId, developerId), entityType: "LIVE_PRESENCE", orgId, sessionId, developerId, name: NAMES[developerId] ?? "Someone", at: new Date(T0).toISOString() });
  };
  /** A member share and its index row, as the share route writes them. */
  const share = (orgId: OrgId, sessionId: string, developerId: string, level: "view" | "use" | "edit", sharedBy = PRIYA) => {
    const principal = { kind: "member" as const, developerId };
    w.seedShare(orgId, sessionId, principal, level, sharedBy);
    w.db.set({ ...sharedSessionsKey(orgId, principal, sessionId), entityType: "SHARED_SESSION", orgId, sessionId, principal, level, sharedAt: "2026-10-22T08:10:00.000Z" });
  };
  const device = (orgId: OrgId, developerId: string, deviceId: string) => {
    w.db.set({ ...deviceKey(orgId, deviceId), entityType: "DEVICE", orgId, deviceId, developerId, label: "A MacBook", platform: "mac", createdAt: CREATED_AT, lastSeenAt: CREATED_AT });
    w.db.set({ ...memberDevicesKey(orgId, developerId, deviceId), entityType: "MEMBER_DEVICE", orgId, deviceId, developerId });
    w.db.set({ ...deviceCommandKey(orgId, deviceId, 1), entityType: "DEVICE_COMMAND", orgId, deviceId, command: "stop" });
  };
  const followers = (orgId: OrgId, sessionId: string) => w.db.find((item) => item.pk === agentSessionKey(orgId, sessionId, "META").pk && String(item.sk).startsWith("FOLLOWER#")).map((item) => String(item.sk).slice("FOLLOWER#".length)).sort();
  const shares = (orgId: OrgId, sessionId: string) => w.db.find((item) => item.pk === agentSessionKey(orgId, sessionId, "META").pk && String(item.sk).startsWith("SHARE#")).map((item) => `${String(item.sk).slice("SHARE#".length)}=${String(item.level)}`).sort();
  const indexed = (orgId: OrgId, developerId: string) => w.db.find((item) => item.pk === sharedSessionsKey(orgId, { kind: "member", developerId }, "ses_00000000000000000000").pk).map((item) => String(item.sk)).sort();
  const count = (orgId: OrgId, sessionId: string) => get(agentSessionKey(orgId, sessionId, "META"))!["followerCount"];
  const taskOf = (taskId: string) => get(taskKey(taskId)) as unknown as DeveloperTaskRecord & Item;
  /** Org A's people, for a merge: Zed is Arjun's second sign-in. */
  const merged = (duplicateId: string, survivorId: string) => {
    const record = get({ pk: `DEVELOPER#${duplicateId}`, sk: "META" })!;
    w.db.set({ ...record, mergedInto: survivorId });
    w.db.delete(orgMemberKey(ORG_A, duplicateId));
  };
  const removed = (developerId: string, orgId: OrgId = ORG_A) => {
    w.db.delete(orgMemberKey(orgId, developerId));
    w.db.set({ ...orgRemovedKey(orgId, developerId), entityType: "ORG_REMOVED", orgId, developerId });
  };
  return { ...w, store, deps, lines, get, snapshot, session, follow, present, share, device, followers, shares, indexed, count, taskOf, merged, removed };
}
type World = ReturnType<typeof world>;

afterEach(() => undefined);

describe("a member is removed", () => {
  const setup = () => {
    const w = world();
    const mine = w.session({ owner: ARJUN });
    const others = w.session({ owner: PRIYA, followers: [ARJUN, MIA, MAX] });
    const shared = w.session({ owner: PRIYA, followers: [ARJUN] });
    const quiet = w.session({ owner: PRIYA, followers: [MIA] });
    w.share(ORG_A, others.sessionId, ARJUN, "edit");
    w.share(ORG_A, others.sessionId, MIA, "view");
    w.share(ORG_A, shared.sessionId, ARJUN, "use");
    w.present(ORG_A, others.sessionId, ARJUN);
    w.present(ORG_A, others.sessionId, MIA);
    w.device(ORG_A, ARJUN, DEVICE_A);
    w.device(ORG_A, MIA, DEVICE_B);
    // Org B has a member with the same kind of rows: it must stay as it is.
    const theirs = w.session({ orgId: ORG_B, owner: BO, project: "web", followers: [BO] });
    w.share(ORG_B, theirs.sessionId, BO, "view");
    w.device(ORG_B, BO, DEVICE_C);
    w.db.delete(orgMemberKey(ORG_A, ARJUN));
    return { w, mine, others, shared, quiet, theirs };
  };

  it("deletes their follows (counting them off), presence and shares with their index rows, and leaves everyone else's", async () => {
    const { w, others, shared, quiet, theirs } = setup();
    await onMemberRemoved(w.deps, { orgId: ORG_A, developerId: ARJUN, by: PRIYA });
    expect(w.followers(ORG_A, others.sessionId)).toEqual([MAX, MIA].sort());
    expect(w.count(ORG_A, others.sessionId)).toBe(2);
    expect(w.followers(ORG_A, shared.sessionId)).toEqual([]);
    expect(w.count(ORG_A, shared.sessionId)).toBe(0);
    expect(w.followers(ORG_A, quiet.sessionId)).toEqual([MIA]);
    expect(w.count(ORG_A, quiet.sessionId)).toBe(1);
    expect(w.shares(ORG_A, others.sessionId)).toEqual([`MEMBER#${MIA}=view`]);
    expect(w.shares(ORG_A, shared.sessionId)).toEqual([]);
    expect(w.indexed(ORG_A, ARJUN)).toEqual([]);
    expect(w.indexed(ORG_A, MIA)).toHaveLength(1);
    expect(w.get(agentSessionKey(ORG_A, others.sessionId, `PRESENCE#${ARJUN}`))).toBeUndefined();
    expect(w.get(agentSessionKey(ORG_A, others.sessionId, `PRESENCE#${MIA}`))).toBeDefined();
    // Org B is as it was.
    expect(w.followers(ORG_B, theirs.sessionId)).toEqual([BO]);
    expect(w.shares(ORG_B, theirs.sessionId)).toEqual([`MEMBER#${BO}=view`]);
    expect(w.get(memberDevicesKey(ORG_B, BO, DEVICE_C as never))).toBeDefined();
  });

  it("revokes their devices and no one else's", async () => {
    const { w } = setup();
    await onMemberRemoved(w.deps, { orgId: ORG_A, developerId: ARJUN, by: PRIYA });
    const revoked = w.get(deviceKey(ORG_A, DEVICE_A))!;
    expect(revoked["revokedAt"]).toBe(new Date(T0).toISOString());
    expect(typeof revoked["indexExpiresAt"]).toBe("number");
    expect(w.get(deviceKey(ORG_A, DEVICE_B as never))!["revokedAt"]).toBeUndefined();
    expect(w.get(deviceKey(ORG_B, DEVICE_C as never))!["revokedAt"]).toBeUndefined();
  });

  it("passes nothing to the successor: their sessions keep them as owner, and their task sessions stay with R60", async () => {
    const { w, mine } = setup();
    const before = { meta: structuredClone(w.get(agentSessionKey(ORG_A, mine.sessionId, "META"))), task: structuredClone(w.taskOf(mine.taskId)), tile: structuredClone(w.get(liveSessionKey(ORG_A, mine.sessionId))) };
    await onMemberRemoved(w.deps, { orgId: ORG_A, developerId: ARJUN, by: PRIYA });
    expect(w.get(agentSessionKey(ORG_A, mine.sessionId, "META"))).toEqual(before.meta);
    expect(w.taskOf(mine.taskId)).toEqual(before.task);
    expect(w.get(liveSessionKey(ORG_A, mine.sessionId))).toEqual(before.tile);
    expect(w.get(mySessionsKey(ORG_A, ARJUN, mine.createdAt, mine.sessionId))).toBeDefined();
    expect(w.get(mySessionsKey(ORG_A, OWNER, mine.createdAt, mine.sessionId))).toBeUndefined();
    expect(effectiveTaskOwner(w.taskOf(mine.taskId)).developerId).toBe(ARJUN);
    w.removed(ARJUN);
    const refused = await code(requireCreatorStillMember({ documentClient: w.db, tableName: "state", orgId: ORG_A }, w.taskOf(mine.taskId)));
    expect(refused).toMatchObject({ code: "TASK_ACCESS_DENIED", message: "Arjun is no longer a member of the organization, so Rovara stopped this task." });
  });

  it("keeps refusing a taken-over task naming the taker who left", async () => {
    const w = world();
    const taken = w.session({ owner: ARJUN, currentOwner: ARJUN });
    w.removed(ARJUN);
    await onSessionMemberRemoved(w.deps, { orgId: ORG_A, developerId: ARJUN });
    expect(effectiveTaskOwner(w.taskOf(taken.taskId)).developerId).toBe(ARJUN);
    expect(await code(requireCreatorStillMember({ documentClient: w.db, tableName: "state", orgId: ORG_A }, w.taskOf(taken.taskId)))).toMatchObject({ code: "TASK_ACCESS_DENIED" });
  });

  it("does the same when no owner is left to take anything over, and repeating it changes nothing", async () => {
    const { w, others, shared } = setup();
    w.db.delete(orgMemberKey(ORG_A, OWNER));
    await onMemberRemoved(w.deps, { orgId: ORG_A, developerId: ARJUN, by: PRIYA });
    expect(w.followers(ORG_A, others.sessionId)).toEqual([MAX, MIA].sort());
    expect(w.shares(ORG_A, shared.sessionId)).toEqual([]);
    expect(w.get(deviceKey(ORG_A, DEVICE_A as never))!["revokedAt"]).toBeDefined();
    expect(w.lines.map((line) => line.event)).toContain("member_removed.no_successor");
    const after = w.snapshot();
    await onMemberRemoved(w.deps, { orgId: ORG_A, developerId: ARJUN, by: PRIYA });
    expect(w.snapshot()).toBe(after);
  });

  it("a follower another request removed first, or a share already gone, is not an error", async () => {
    const { w, others } = setup();
    w.db.delete(agentSessionKey(ORG_A, others.sessionId, `FOLLOWER#${ARJUN}`));
    w.db.delete(agentSessionKey(ORG_A, others.sessionId, `SHARE#MEMBER#${ARJUN}`));
    await onSessionMemberRemoved(w.deps, { orgId: ORG_A, developerId: ARJUN });
    expect(w.indexed(ORG_A, ARJUN)).toEqual([]);
    // The count was never taken below what the remaining items say.
    expect(Number(w.count(ORG_A, others.sessionId))).toBeGreaterThanOrEqual(2);
  });

  it("refuses an id that is not a member id or an org id (nothing is read for it)", async () => {
    const w = world();
    expect(await code(onSessionMemberRemoved(w.deps, { orgId: ORG_A, developerId: "not-an-id" }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(onSessionMemberRemoved(w.deps, { orgId: "nope", developerId: ARJUN }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(w.db.commandNames()).toEqual([]);
  });

  it("fails closed: a table that cannot be read leaves the marker and the sessions as they were", async () => {
    const { w, others } = setup();
    w.db.injectFault({ command: "QueryCommand", error: { name: "ProvisionedThroughputExceededException" }, times: 100 });
    expect(await code(onSessionMemberRemoved(w.deps, { orgId: ORG_A, developerId: ARJUN }))).toMatchObject({ name: "ProvisionedThroughputExceededException" });
    expect(w.followers(ORG_A, others.sessionId)).toContain(ARJUN);
    expect(w.shares(ORG_A, others.sessionId)).toContain(`MEMBER#${ARJUN}=edit`);
  });
});

describe("two members are merged", () => {
  /** Zed is Arjun's second sign-in; Zed's rows move to Arjun. */
  const setup = () => {
    const w = world();
    w.db.set({ ...w.get({ pk: `DEVELOPER#${ARJUN}`, sk: "META" })!, provider: "oidc", displayName: "Arjun" });
    const zedsOwn = w.session({ owner: ZED });
    const takenByZed = w.session({ owner: ZED, currentOwner: ZED });
    // The task was Priya's, then Zed took it over: Zed has its task-list row.
    w.db.set({ ...taskIndexKey(PRIYA, takenByZed.createdAt, takenByZed.taskId), entityType: "DEVELOPER_TASK_INDEX", taskId: takenByZed.taskId, orgId: ORG_A, project: "web", title: "t", client: "app", status: "RUNNING", createdAt: takenByZed.createdAt, updatedAt: takenByZed.createdAt });
    w.db.set({ ...w.taskOf(takenByZed.taskId), developerId: PRIYA, developerName: "Priya" });
    const followed = w.session({ owner: PRIYA, followers: [ZED, MIA] });
    const bothFollow = w.session({ owner: PRIYA, followers: [ZED, ARJUN, MIA] });
    const arjunOwns = w.session({ owner: ARJUN, followers: [ZED] });
    w.share(ORG_A, followed.sessionId, ZED, "edit");
    w.share(ORG_A, bothFollow.sessionId, ZED, "use");
    w.share(ORG_A, bothFollow.sessionId, ARJUN, "edit");
    w.share(ORG_A, arjunOwns.sessionId, ZED, "view");
    w.share(ORG_A, followed.sessionId, MIA, "view");
    w.device(ORG_A, ZED, DEVICE_A);
    w.device(ORG_A, MIA, DEVICE_B);
    const otherOrg = w.session({ orgId: ORG_B, owner: BO, project: "web", followers: [BO] });
    w.merged(ZED, ARJUN);
    return { w, zedsOwn, takenByZed, followed, bothFollow, arjunOwns, otherOrg };
  };
  const merge = (w: World) => onMembersMerged(w.deps, { orgId: ORG_A, survivorId: ARJUN, duplicateId: ZED });

  it("moves the duplicate's follows to the survivor (the count stays, or drops when the survivor followed already or owns it)", async () => {
    const { w, followed, bothFollow, arjunOwns } = setup();
    await merge(w);
    expect(w.followers(ORG_A, followed.sessionId)).toEqual([ARJUN, MIA].sort());
    expect(w.count(ORG_A, followed.sessionId)).toBe(2);
    expect(w.followers(ORG_A, bothFollow.sessionId)).toEqual([ARJUN, MIA].sort());
    expect(w.count(ORG_A, bothFollow.sessionId)).toBe(2);
    expect(w.followers(ORG_A, arjunOwns.sessionId)).toEqual([]);
    expect(w.count(ORG_A, arjunOwns.sessionId)).toBe(0);
  });

  it("moves the duplicate's shares, keeping the higher level, and drops one on a session the survivor owns", async () => {
    const { w, followed, bothFollow, arjunOwns } = setup();
    await merge(w);
    expect(w.shares(ORG_A, followed.sessionId)).toEqual([`MEMBER#${ARJUN}=edit`, `MEMBER#${MIA}=view`].sort());
    // Arjun had "edit" and Zed "use": the higher stands.
    expect(w.shares(ORG_A, bothFollow.sessionId)).toEqual([`MEMBER#${ARJUN}=edit`]);
    expect(w.shares(ORG_A, arjunOwns.sessionId)).toEqual([]);
    expect(w.indexed(ORG_A, ZED)).toEqual([]);
    expect(w.indexed(ORG_A, ARJUN)).toHaveLength(2);
    const moved = w.get(agentSessionKey(ORG_A, followed.sessionId, `SHARE#MEMBER#${ARJUN}`))!;
    expect(moved["principal"]).toEqual({ kind: "member", developerId: ARJUN });
  });

  it("raises a lower share of the survivor to the duplicate's higher one", async () => {
    const { w, bothFollow } = setup();
    w.share(ORG_A, bothFollow.sessionId, ARJUN, "view");
    await merge(w);
    expect(w.shares(ORG_A, bothFollow.sessionId)).toEqual([`MEMBER#${ARJUN}=use`]);
    expect((w.get(sharedSessionsKey(ORG_A, { kind: "member", developerId: ARJUN }, bothFollow.sessionId)))!["level"]).toBe("use");
  });

  it("moves the sessions the duplicate owns: the session, its live tile, the \"mine\" row, the task's current owner and the task-list row", async () => {
    const { w, zedsOwn, takenByZed } = setup();
    await merge(w);
    for (const session of [zedsOwn, takenByZed]) {
      const meta = w.get(agentSessionKey(ORG_A, session.sessionId, "META"))!;
      expect(meta["owner"]).toEqual({ developerId: ARJUN, name: "Arjun" });
      expect(meta["revision"]).toBe(2);
      expect(w.get(liveSessionKey(ORG_A, session.sessionId))).toMatchObject({ ownerId: ARJUN, owner: { developerId: ARJUN, name: "Arjun" }, revision: 2 });
      expect(w.get(mySessionsKey(ORG_A, ZED, session.createdAt, session.sessionId))).toBeUndefined();
      expect(w.get(mySessionsKey(ORG_A, ARJUN, session.createdAt, session.sessionId))).toMatchObject({ developerId: ARJUN, sessionId: session.sessionId });
    }
    expect(w.taskOf(takenByZed.taskId).currentOwner).toMatchObject({ developerId: ARJUN, name: "Arjun", provider: "oidc" });
    expect(effectiveTaskOwner(w.taskOf(takenByZed.taskId)).developerId).toBe(ARJUN);
    expect(w.get(taskIndexKey(ZED, takenByZed.createdAt, takenByZed.taskId))).toBeUndefined();
    expect(w.get(taskIndexKey(ARJUN, takenByZed.createdAt, takenByZed.taskId))).toMatchObject({ taskId: takenByZed.taskId });
    // The creator's row stays, and a task nobody took over keeps its creator (history): the duplicate's own list row stays.
    expect(w.get(taskIndexKey(PRIYA, takenByZed.createdAt, takenByZed.taskId))).toBeDefined();
    expect(w.taskOf(zedsOwn.taskId).currentOwner).toBeUndefined();
    expect(w.get(taskIndexKey(ZED, zedsOwn.createdAt, zedsOwn.taskId))).toBeDefined();
  });

  it("moves the duplicate's devices to the survivor", async () => {
    const { w } = setup();
    await merge(w);
    expect(w.get(deviceKey(ORG_A, DEVICE_A as never))!["developerId"]).toBe(ARJUN);
    expect(w.get(memberDevicesKey(ORG_A, ZED, DEVICE_A as never))).toBeUndefined();
    expect(w.get(memberDevicesKey(ORG_A, ARJUN, DEVICE_A as never))).toMatchObject({ deviceId: DEVICE_A, developerId: ARJUN });
    expect(w.get(deviceKey(ORG_A, DEVICE_B as never))!["developerId"]).toBe(MIA);
    expect(w.get(deviceCommandKey(ORG_A, DEVICE_A as never, 1))).toBeDefined();
  });

  it("touches nothing of another org, and repeating the merge changes nothing", async () => {
    const { w, otherOrg } = setup();
    const theirs = JSON.stringify([...w.db.items.entries()].filter(([key]) => key.includes(ORG_B)));
    await merge(w);
    expect(JSON.stringify([...w.db.items.entries()].filter(([key]) => key.includes(ORG_B)))).toBe(theirs);
    expect(w.followers(ORG_B, otherOrg.sessionId)).toEqual([BO]);
    const after = w.snapshot();
    await merge(w);
    expect(w.snapshot()).toBe(after);
  });

  it("finishes what a run that stopped half-way left: rows of the duplicate that appear after a run are moved by the next", async () => {
    const { w, followed, bothFollow } = setup();
    await onSessionMembersMerged(w.deps, { orgId: ORG_A, survivorId: ARJUN, duplicateId: ZED });
    w.share(ORG_A, followed.sessionId, ZED, "use");
    w.follow(ORG_A, bothFollow.sessionId, ZED);
    await merge(w);
    expect(w.shares(ORG_A, followed.sessionId)).toEqual([`MEMBER#${ARJUN}=edit`, `MEMBER#${MIA}=view`].sort());
    expect(w.followers(ORG_A, bothFollow.sessionId)).toEqual([ARJUN, MIA].sort());
    expect(w.count(ORG_A, bothFollow.sessionId)).toBe(2);
  });

  it("refuses a survivor that has no sign-in record, and moves nothing", async () => {
    const { w, followed } = setup();
    w.db.delete({ pk: `DEVELOPER#${ARJUN}`, sk: "META" });
    expect(await code(merge(w))).toBeDefined();
    expect(w.followers(ORG_A, followed.sessionId)).toContain(ZED);
  });

  it("is stopped by its deadline, leaves the marker, and finishes on the next drain", async () => {
    const { w, zedsOwn, followed } = setup();
    w.db.set({ ...memberMergeQueueKey("2026-10-22T09:00:00.000Z", ORG_A, ZED), entityType: "MEMBER_MERGE", orgId: ORG_A, survivorId: ARJUN, duplicateId: ZED });
    const marker = memberMergeQueueKey("2026-10-22T09:00:00.000Z", ORG_A, ZED);
    // The time is already over: the mover stops before its first item.
    const stopped = await drainMemberMerges({ ...w.deps, deadline: T0 }, T0);
    expect(stopped).toMatchObject({ processed: 0, failed: 1 });
    expect(w.get(marker)).toBeDefined();
    expect(w.get(agentSessionKey(ORG_A, zedsOwn.sessionId, "META"))!["owner"]).toMatchObject({ developerId: ZED });
    // Later, with time, after the marker's back-off.
    w.clock.now = T0 + 6 * 60_000;
    const finished = await drainMemberMerges(w.deps, w.clock.now);
    expect(finished).toMatchObject({ processed: 1, failed: 0 });
    expect(w.get(marker)).toBeUndefined();
    expect(w.get(agentSessionKey(ORG_A, zedsOwn.sessionId, "META"))!["owner"]).toMatchObject({ developerId: ARJUN });
    expect(w.followers(ORG_A, followed.sessionId)).toEqual([ARJUN, MIA].sort());
    expect(await resolveMember(w.deps, ORG_A, ZED)).toBe(ARJUN);
  });

  it("a removal marker works the same way through the removal drain", async () => {
    const w = world();
    const s = w.session({ owner: PRIYA, followers: [ARJUN] });
    w.share(ORG_A, s.sessionId, ARJUN, "view");
    w.db.delete(orgMemberKey(ORG_A, ARJUN));
    const marker = memberRemovalQueueKey("2026-10-22T09:00:00.000Z", ORG_A, ARJUN);
    w.db.set({ ...marker, entityType: "MEMBER_REMOVAL", orgId: ORG_A, developerId: ARJUN, by: PRIYA });
    expect(await drainMemberRemovals(w.deps, T0)).toMatchObject({ processed: 1, failed: 0 });
    expect(w.get(marker)).toBeUndefined();
    expect(w.followers(ORG_A, s.sessionId)).toEqual([]);
    expect(w.shares(ORG_A, s.sessionId)).toEqual([]);
  });
});

describe("a project is archived", () => {
  it("changes nothing for a running session, which stays on Live, while new work on the project is refused", async () => {
    const w = world();
    const running = w.session({ owner: PRIYA });
    const before = { meta: structuredClone(w.get(agentSessionKey(ORG_A, running.sessionId, "META"))), tile: structuredClone(w.get(liveSessionKey(ORG_A, running.sessionId))) };
    w.db.set({ ...w.get(projectMetaKey(ORG_A, "web"))!, status: "archived", archivedAt: CREATED_AT, archivedBy: OWNER });
    const { onProjectArchived } = await import("../../packages/broker/src/agents/lifecycle.js");
    await onProjectArchived(w.deps, { orgId: ORG_A, project: "web" });
    expect(w.get(agentSessionKey(ORG_A, running.sessionId, "META"))).toEqual(before.meta);
    expect(w.get(liveSessionKey(ORG_A, running.sessionId))).toEqual(before.tile);
    const wall = await liveSessions({
      documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: CELL, cursorKey: "k".repeat(64),
      taskView: async () => ({}) as never, deciding: { approvals: async () => [], spend: async () => false, approvalsFor: async () => new Map() },
    }, w.caller(PRIYA), {});
    expect(wall.tiles.map((tile) => tile.sessionId)).toEqual([running.sessionId]);
    expect(await code(requireNewWorkAllowed({ documentClient: w.db, tableName: "state" }, ORG_A, "web", "contributor", "task"))).toMatchObject({ code: "PROJECT_ARCHIVED" });
  });
});

describe("an org is closed", () => {
  const EXPIRES = Math.floor(T0 / 1000) + 30 * DAY;
  const setup = () => {
    const w = world();
    const a = w.session({ owner: PRIYA, followers: [ARJUN] });
    const ended = w.session({ owner: ARJUN, ended: true });
    w.share(ORG_A, a.sessionId, MIA, "view");
    w.present(ORG_A, a.sessionId, ARJUN);
    w.device(ORG_A, ARJUN, DEVICE_A);
    w.device(ORG_A, MIA, DEVICE_B);
    const day = "2026-10-22";
    for (const [orgId, session] of [[ORG_A, a], [ORG_A, ended], [ORG_B, undefined]] as const) {
      const sessionId = session?.sessionId ?? "ses_bbbbbbbbbbbbbbbbbbbb";
      w.db.set({ ...openAgentSessionKey(orgId, sessionId), entityType: "OPEN_AGENT_SESSION", orgId, sessionId });
      w.db.set({ ...endedSessionWorkKey(day, orgId, sessionId), entityType: "ENDED_AGENT_SESSION", orgId, sessionId });
    }
    for (const developerId of [PRIYA, ARJUN]) {
      w.db.set({ ...changesKey(ORG_A, developerId, CREATED_AT, 1), entityType: "CHANGE_NOTICE", orgId: ORG_A, type: "session_shared", sessionId: a.sessionId });
      w.db.set({ ...changesKey(ORG_A, developerId, CREATED_AT, 2), entityType: "CHANGE_NOTICE", orgId: ORG_A, type: "session_shared", sessionId: a.sessionId });
    }
    w.db.set({ ...projectMonthStatsKey(ORG_A, "web", "2026-10"), entityType: "PROJECT_SESSION_STATS", orgId: ORG_A, started: 2 });
    // Org B's own rows of every kind.
    const b = w.session({ orgId: ORG_B, owner: BO, project: "web", followers: [BO] });
    w.share(ORG_B, b.sessionId, BO, "view");
    w.device(ORG_B, BO, DEVICE_C);
    w.db.set({ ...changesKey(ORG_B, BO, CREATED_AT, 1), entityType: "CHANGE_NOTICE", orgId: ORG_B, type: "session_shared", sessionId: b.sessionId });
    w.db.set({ ...endedSessionWorkKey(day, ORG_B, b.sessionId), entityType: "ENDED_AGENT_SESSION", orgId: ORG_B, sessionId: b.sessionId });
    w.db.set({ ...openAgentSessionKey(ORG_B, b.sessionId), entityType: "OPEN_AGENT_SESSION", orgId: ORG_B, sessionId: b.sessionId });
    w.db.set({ pk: "ENDED_DRAIN_CURSOR", sk: "META", entityType: "ENDED_DRAIN_CURSOR", day });
    return { w, a, ended, b };
  };
  const rowsOf = (w: World, orgId: OrgId) => JSON.stringify(w.db.find((item) => String(item.pk).includes(orgId) || String(item.sk).includes(orgId)));
  const orgAPartitions = (w: World) => w.db.find((item) => String(item.pk).startsWith(`ORG#${ORG_A}#`) && /LIVE_SESSIONS|LIVE_PRESENCE|CHANGES#|DEVICE#|MEMBER_DEVICES#/.test(String(item.pk)));

  it("deletes the org's live index, presence, open and ended entries, devices and change feeds, and leaves another org's", async () => {
    const { w, a, ended, b } = setup();
    const theirs = rowsOf(w, ORG_B);
    await clearOrgSessions(w.deps, ORG_A);
    expect(orgAPartitions(w)).toEqual([]);
    expect(w.get(liveSessionKey(ORG_A, a.sessionId))).toBeUndefined();
    expect(w.get(openAgentSessionKey(ORG_A, a.sessionId as never))).toBeUndefined();
    expect(w.get(openAgentSessionKey(ORG_A, ended.sessionId as never))).toBeUndefined();
    expect(w.get(endedSessionWorkKey("2026-10-22", ORG_A, a.sessionId as never))).toBeUndefined();
    expect(w.get(endedSessionWorkKey("2026-10-22", ORG_A, ended.sessionId as never))).toBeUndefined();
    expect(rowsOf(w, ORG_B)).toBe(theirs);
    expect(w.get(openAgentSessionKey(ORG_B, b.sessionId as never))).toBeDefined();
    expect(w.get(endedSessionWorkKey("2026-10-22", ORG_B, b.sessionId as never))).toBeDefined();
    expect(w.get(liveSessionKey(ORG_B, b.sessionId))).toBeDefined();
  });

  it("gives the rest an expiry 30 days on, and never lengthens a shorter one", async () => {
    const { w, a, ended } = setup();
    w.db.set({ ...agentSessionKey(ORG_A, a.sessionId, "EVENT#2026-10-22T08:00:00.000Z#evt_1"), entityType: "AGENT_SESSION_EVENT", orgId: ORG_A, indexExpiresAt: EXPIRES - 5 });
    w.db.set({ ...agentSessionKey(ORG_A, a.sessionId, "EVENT#2026-10-22T08:01:00.000Z#evt_2"), entityType: "AGENT_SESSION_EVENT", orgId: ORG_A, indexExpiresAt: EXPIRES + 1_000_000 });
    await clearOrgSessions(w.deps, ORG_A);
    for (const session of [a, ended]) {
      expect(w.get(agentSessionKey(ORG_A, session.sessionId, "META"))!["indexExpiresAt"]).toBe(EXPIRES);
      expect(w.get(mySessionsKey(ORG_A, session.owner, session.createdAt, session.sessionId))!["indexExpiresAt"]).toBe(EXPIRES);
      expect(w.get(projectSessionsKey(ORG_A, "web", session.createdAt, session.sessionId))!["indexExpiresAt"]).toBe(EXPIRES);
    }
    expect(w.get(agentSessionKey(ORG_A, a.sessionId, `FOLLOWER#${ARJUN}`))!["indexExpiresAt"]).toBe(EXPIRES);
    expect(w.get(agentSessionKey(ORG_A, a.sessionId, `SHARE#MEMBER#${MIA}`))!["indexExpiresAt"]).toBe(EXPIRES);
    expect(w.get(sharedSessionsKey(ORG_A, { kind: "member", developerId: MIA }, a.sessionId))!["indexExpiresAt"]).toBe(EXPIRES);
    expect(w.get(projectMonthStatsKey(ORG_A, "web", "2026-10"))!["indexExpiresAt"]).toBe(EXPIRES);
    expect(w.get(agentSessionKey(ORG_A, a.sessionId, "EVENT#2026-10-22T08:00:00.000Z#evt_1"))!["indexExpiresAt"]).toBe(EXPIRES - 5);
    expect(w.get(agentSessionKey(ORG_A, a.sessionId, "EVENT#2026-10-22T08:01:00.000Z#evt_2"))!["indexExpiresAt"]).toBe(EXPIRES);
  });

  it("leaves org B's sessions with no expiry, and a repeat later does not push the expiry out", async () => {
    const { w, a, b } = setup();
    await clearOrgSessions(w.deps, ORG_A);
    expect(w.get(agentSessionKey(ORG_B, b.sessionId, "META"))!["indexExpiresAt"]).toBeUndefined();
    expect(w.get(mySessionsKey(ORG_B, BO, b.createdAt, b.sessionId))!["indexExpiresAt"]).toBeUndefined();
    w.clock.now = T0 + 3_600_000;
    await clearOrgSessions(w.deps, ORG_A);
    expect(w.get(agentSessionKey(ORG_A, a.sessionId, "META"))!["indexExpiresAt"]).toBe(EXPIRES);
  });

  it("a run that stops at its deadline throws a retryable refusal and a second run finishes", async () => {
    const { w, a } = setup();
    const stopped = await code(closeOrgSessions({ documentClient: w.db, tableName: "state", now: () => w.clock.now }, ORG_A, { budgetMs: -1 }));
    expect(stopped).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await closeOrgSessions({ documentClient: w.db, tableName: "state", now: () => w.clock.now }, ORG_A);
    expect(orgAPartitions(w)).toEqual([]);
    expect(w.get(agentSessionKey(ORG_A, a.sessionId, "META"))!["indexExpiresAt"]).toBe(EXPIRES);
  });

  it("fails closed: a table that cannot be read stops the close and deletes nothing it has not stamped", async () => {
    const { w } = setup();
    w.db.injectFault({ command: "QueryCommand", error: { name: "ProvisionedThroughputExceededException" }, times: 100 });
    expect(await code(clearOrgSessions(w.deps, ORG_A))).toMatchObject({ name: "ProvisionedThroughputExceededException" });
    expect(orgAPartitions(w).length).toBeGreaterThan(0);
  });

  it("refuses an id that is not an org id", async () => {
    const w = world();
    expect(await code(clearOrgSessions(w.deps, "org_*"))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(w.db.commandNames()).toEqual([]);
  });
});

describe("the surface bindings of a closed org", () => {
  it("get the 30-day expiry too", async () => {
    const w = world();
    const s = w.session({ owner: PRIYA });
    const binding = { kind: "slack_thread" as const, teamId: "T0123456789", channelId: "C0123456789", threadTs: "1700000000.000100" };
    w.db.set({ ...agentSessionKey(ORG_A, s.sessionId, "BINDING#slack"), entityType: "AGENT_SESSION_BINDING", orgId: ORG_A, sessionId: s.sessionId, binding });
    w.db.set({ ...sessionSurfaceKey(ORG_A, binding), entityType: "SESSION_SURFACE", orgId: ORG_A, sessionId: s.sessionId, binding });
    await clearOrgSessions(w.deps, ORG_A);
    expect(w.get(sessionSurfaceKey(ORG_A, binding))!["indexExpiresAt"]).toBe(Math.floor(T0 / 1000) + 30 * DAY);
  });
});
