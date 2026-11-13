// Plan 5 Task 21: sessions follow the members who leave or merge, and go with a closed company. A removed member's follows, presence and shares go and their devices are revoked, and
// nothing of theirs passes to the successor (their task sessions keep refusing through R60). A merged duplicate's follows, shares, session ownership (the session, its live tile, its
// "mine" row and the task's current owner) and devices move to the survivor. A mover that runs out of time leaves the marker for the next drain. Closing an org deletes its live index,
// open and ended work entries, presence, devices and change feeds, shortens the rest to 30 days, and touches no other org.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { agentSessionKey, changesKey, endedSessionWorkKey, livePresenceKey, liveSessionKey, mySessionsKey, openAgentSessionKey, projectMetaKey, projectMonthStatsKey, projectSessionsKey, sharedSessionsKey, sessionBindingKey, sessionSurfaceKey, type OrgId } from "@rovara-code/contracts";
import { deviceCommandKey, deviceKey, memberDevicesKey, memberMergeQueueKey, memberRemovalQueueKey, orgMemberKey, orgRemovedKey } from "@agentx/cloud-contracts";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { drainMemberMerges, drainMemberRemovals, onMemberRemoved, onMembersMerged, resolveMember, type LifecycleDeps } from "../../packages/broker/src/agents/lifecycle.js";
import { clearOrgSessions, closeOrgSessions, closeStopRequestId, onSessionMemberRemoved, onSessionMembersMerged, stopOrgSessions } from "../../packages/broker/src/agent-sessions/lifecycle.js";
import "../../packages/broker/src/agent-sessions/index.js";
import { writeAsk } from "../../packages/broker/src/agent-sessions/ask-store.js";
import { personLabel } from "../../packages/broker/src/aws/developer-tasks/thread-notes.js";
import { askByPersonKey, sessionAskKey } from "@rovara-code/contracts";
import { sessionLevelOf } from "../../packages/broker/src/agent-sessions/access.js";
import { AgentSessionStore } from "../../packages/broker/src/agent-sessions/store.js";
import { liveSessions } from "../../packages/broker/src/agent-sessions/live.js";
import { requireCreatorStillMember } from "../../packages/broker/src/developer/creator-member.js";
import { requireNewWorkAllowed } from "../../packages/broker/src/developer/project-roles.js";
import { effectiveTaskOwner, ownerActorIdOf, takenOverSince, taskIndexKey, taskKey, taskOwnerKey, taskPayerKey, type DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { paymentOfTask } from "../../packages/broker/src/spend/payer.js";
import { viewCoreTaskRowsClient } from "../../packages/broker/src/cloud/app/core-task-rows.js";
import { createPendingChange, getAnyApproval, registerApprovalSubjectHandler, registerApproverRule } from "../../packages/broker/src/agents/approvals.js";
import { deleteSessionShare, type SessionShareDependencies } from "../../packages/broker/src/agent-sessions/shares.js";
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
    // A session everyone on the project sees: Arjun follows it with no share and no presence, so only the live index leads to it.
    const open = w.session({ owner: PRIYA, followers: [ARJUN, MIA] });
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
    return { w, mine, others, shared, quiet, open, theirs };
  };

  it("deletes their follows (counting them off), presence and shares with their index rows, and leaves everyone else's", async () => {
    const { w, others, shared, quiet, open, theirs } = setup();
    await onMemberRemoved(w.deps, { orgId: ORG_A, developerId: ARJUN, by: PRIYA });
    expect(w.followers(ORG_A, open.sessionId)).toEqual([MIA]);
    expect(w.count(ORG_A, open.sessionId)).toBe(1);
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
    // A later run changes nothing: a device revoked once keeps the time it was revoked.
    w.clock.now += 3_600_000;
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

  it("moves the duplicate's Asks to the survivor, so erasing the survivor finds them (live interaction I7)", async () => {
    const { w, zedsOwn } = setup();
    const ask = (askId: string, askedBy: string, answer: string) => writeAsk({ documentClient: w.db, tableName: "state", questionHashKey: "k".repeat(32), erasedPeople: async () => [], isErased: async () => false },
      { edition: "enterprise", orgId: ORG_A, sessionId: zedsOwn.sessionId, askId, audience: "web", askedBy, question: "q", answer, contextBytes: 1, model: "m", nowMs: T0 });
    await ask(`ask_${"1".repeat(20)}`, ZED, "ANSWER-OF-ZED");
    await ask(`ask_${"2".repeat(20)}`, MIA, `${personLabel(ZED)} approved`);
    await merge(w);
    await onSessionMembersMerged(w.deps, { orgId: ORG_A, survivorId: ARJUN, duplicateId: ZED });
    expect(w.get(sessionAskKey(ORG_A, zedsOwn.sessionId as never, `ask_${"1".repeat(20)}`))).toMatchObject({ askedBy: ARJUN });
    expect(w.get(askByPersonKey(ORG_A, ARJUN, zedsOwn.sessionId as never, `ask_${"1".repeat(20)}`))).toBeDefined();
    expect(w.get(sessionAskKey(ORG_A, zedsOwn.sessionId as never, `ask_${"2".repeat(20)}`))).toMatchObject({ answer: `${personLabel(ARJUN)} approved` });
    expect(w.db.find((item) => String(item.pk).includes(`ASKBY#${ZED}`))).toEqual([]);
  });

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
    // The creator's row stays (history).
    expect(w.get(taskIndexKey(PRIYA, takenByZed.createdAt, takenByZed.taskId))).toBeDefined();
    expect(w.get(taskIndexKey(ZED, zedsOwn.createdAt, zedsOwn.taskId))).toBeDefined();
  });

  it("leaves a session alone whose owner is someone else now (a take-over since), and only drops the duplicate's stale row", async () => {
    const { w, followed } = setup();
    w.db.set({ ...mySessionsKey(ORG_A, ZED, followed.createdAt, followed.sessionId), entityType: "MY_SESSION", orgId: ORG_A, sessionId: followed.sessionId, developerId: ZED, createdAt: followed.createdAt });
    const before = structuredClone(w.get(agentSessionKey(ORG_A, followed.sessionId, "META")));
    await merge(w);
    expect((w.get(agentSessionKey(ORG_A, followed.sessionId, "META")))!["owner"]).toEqual((before as Item)["owner"]);
    expect(w.get(mySessionsKey(ORG_A, ZED, followed.createdAt, followed.sessionId))).toBeUndefined();
    expect(w.get(mySessionsKey(ORG_A, ARJUN, followed.createdAt, followed.sessionId))).toBeUndefined();
  });

  it("reads the session again after a lost race, and moves it", async () => {
    const { w, zedsOwn } = setup();
    w.db.injectFault({ command: "TransactWriteCommand", error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }, { Code: "None" }, { Code: "None" }] }, times: 1 });
    await merge(w);
    expect(w.get(agentSessionKey(ORG_A, zedsOwn.sessionId, "META"))!["owner"]).toMatchObject({ developerId: ARJUN });
    expect(w.get(agentSessionKey(ORG_A, zedsOwn.sessionId, "META"))!["revision"]).toBe(2);
  });

  it("gives up with a retryable refusal when the session keeps changing, and the marker stays", async () => {
    const { w, zedsOwn } = setup();
    w.db.injectFault({ command: "TransactWriteCommand", error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "ConditionalCheckFailed" }] }, times: 50 });
    expect(await code(merge(w))).toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: "This session is busy right now; the next run moves it." });
    expect(w.get(agentSessionKey(ORG_A, zedsOwn.sessionId, "META"))!["owner"]).toMatchObject({ developerId: ZED });
  });

  it("does not hand on a task whose current owner is someone else, and keeps the creator's own list row when the creator took it back", async () => {
    const { w, takenByZed, zedsOwn } = setup();
    // A task Zed's session names but Priya owns now (a stale state a take-over left): its owner stays Priya.
    w.db.set({ ...w.taskOf(takenByZed.taskId), currentOwner: { developerId: PRIYA, name: "Priya", provider: "oidc", since: "2026-10-22T08:30:00.000Z" } });
    // A task Zed created and took back: the creator's row stays as history, the current owner moves.
    w.db.set({ ...w.taskOf(zedsOwn.taskId), developerId: ZED, developerName: "Zed", currentOwner: { developerId: ZED, name: "Zed", provider: "oidc", since: "2026-10-22T08:30:00.000Z" } });
    await merge(w);
    expect(w.taskOf(takenByZed.taskId).currentOwner).toMatchObject({ developerId: PRIYA, name: "Priya" });
    // Review M-1: the session whose task stays Priya's stays with the duplicate for the next run, and says so in the log.
    expect(w.get(agentSessionKey(ORG_A, takenByZed.sessionId, "META"))!["owner"]).toMatchObject({ developerId: ZED });
    expect(w.get(mySessionsKey(ORG_A, ZED, takenByZed.createdAt, takenByZed.sessionId))).toBeDefined();
    expect(w.lines.map((line) => line.event)).toContain("agent_session.lifecycle_session_left");
    expect(w.taskOf(zedsOwn.taskId).currentOwner).toMatchObject({ developerId: ARJUN, name: "Arjun", since: "2026-10-22T08:30:00.000Z" });
    expect(w.get(taskIndexKey(ZED, zedsOwn.createdAt, zedsOwn.taskId))).toBeDefined();
    // The survivor gets a copy of the creator's row so the task is in their list; the creator's row is not moved.
    expect(w.get(taskIndexKey(ARJUN, zedsOwn.createdAt, zedsOwn.taskId))).toBeDefined();
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
    expect(await code(merge(w))).toMatchObject({ code: "NOT_FOUND", message: "the member the sessions move to could not be found" });
    expect(w.followers(ORG_A, followed.sessionId)).toContain(ZED);
  });

  it("leaves a session alone whose task's owner can't be read, and moves nothing of it (Review M-1)", async () => {
    const { w, zedsOwn } = setup();
    w.db.set({ ...w.taskOf(zedsOwn.taskId), currentOwner: { developerId: "", name: "?", provider: "nope", since: "x" } });
    await merge(w);
    expect(w.get(agentSessionKey(ORG_A, zedsOwn.sessionId, "META"))!["owner"]).toMatchObject({ developerId: ZED });
    expect(w.get(mySessionsKey(ORG_A, ZED, zedsOwn.createdAt, zedsOwn.sessionId))).toBeDefined();
    expect(w.get(liveSessionKey(ORG_A, zedsOwn.sessionId))).toMatchObject({ ownerId: ZED });
  });

  it("moves a session whose task is the survivor's already (an earlier run handed it on), and a session whose task is gone (Review M-1)", async () => {
    const { w, zedsOwn, takenByZed } = setup();
    w.db.set({ ...w.taskOf(zedsOwn.taskId), currentOwner: { developerId: ARJUN, name: "Arjun", provider: "oidc", since: "2026-10-22T09:00:00.000Z" } });
    w.db.delete(taskKey(takenByZed.taskId));
    await merge(w);
    for (const session of [zedsOwn, takenByZed]) {
      expect(w.get(agentSessionKey(ORG_A, session.sessionId, "META"))!["owner"], session.sessionId).toMatchObject({ developerId: ARJUN });
      expect(w.get(mySessionsKey(ORG_A, ARJUN, session.createdAt, session.sessionId))).toBeDefined();
    }
  });

  it("a share the duplicate made can be removed by the survivor as its maker, before the mover has run (Review M-2)", async () => {
    const { w, followed } = setup();
    w.share(ORG_A, followed.sessionId, OWNER, "view", ZED);
    const deps: SessionShareDependencies = { documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore };
    // Arjun holds only "view" on this session; he made no share himself, but Zed did and Zed is Arjun now.
    expect(await deleteSessionShare(deps, { orgId: ORG_A, developerId: ARJUN, name: "Arjun" }, followed.sessionId, `MEMBER#${OWNER}`)).toEqual({ removed: true });
    // A share Priya made is still not his to remove.
    const refused = await code(deleteSessionShare(deps, { orgId: ORG_A, developerId: ARJUN, name: "Arjun" }, followed.sessionId, `MEMBER#${MIA}`));
    expect(refused).toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
  });

  describe("the duplicate's tasks keep working for the survivor (Controller ruling 3)", () => {
    const MERGED_AT = new Date(T0).toISOString();
    /** A task with no session, as a CLI task from before sessions: its record and its creator's list row. */
    const soloTask = (w: World, over: Record<string, unknown> = {}) => {
      const taskId = `00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, "0")}`;
      const createdAt = "2026-10-21T08:00:00.000Z";
      w.db.set({
        ...taskKey(taskId), entityType: "DEVELOPER_TASK", taskId, orgId: ORG_A, developerId: ZED, developerName: "Zed", provider: "oidc", project: "web", workspaceId: `w-${taskId}`,
        ownerKey: taskOwnerKey(ZED, taskId), createdAt, updatedAt: createdAt, ...over,
      });
      w.db.set({ ...taskIndexKey(ZED, createdAt, taskId), entityType: "DEVELOPER_TASK_INDEX", taskId, orgId: ORG_A, project: "web", title: "t", client: "app", status: "RUNNING", createdAt, updatedAt: createdAt });
      return { taskId, createdAt };
    };

    it("hands a task nobody took over to the survivor as its current owner, keeping the creator as history and the principal as it was", async () => {
      const { w, zedsOwn } = setup();
      const before = w.taskOf(zedsOwn.taskId);
      await merge(w);
      const task = w.taskOf(zedsOwn.taskId);
      expect(effectiveTaskOwner(task)).toMatchObject({ developerId: ARJUN, name: "Arjun", provider: "oidc" });
      expect(ownerActorIdOf(task)).toBe(taskOwnerKey(ARJUN, zedsOwn.taskId));
      expect(takenOverSince(task)).toBe(MERGED_AT);
      // The creator's fields, the principal and the workspace never change.
      expect(task).toMatchObject({ developerId: ZED, developerName: "Zed", ownerKey: before.ownerKey, workspaceId: before.workspaceId });
      expect(w.get(taskIndexKey(ARJUN, zedsOwn.createdAt, zedsOwn.taskId))).toMatchObject({ taskId: zedsOwn.taskId });
      expect(w.get(taskIndexKey(ZED, zedsOwn.createdAt, zedsOwn.taskId))).toBeDefined();
    });

    it("hands on a task that has no session too", async () => {
      const { w } = setup();
      const solo = soloTask(w);
      await merge(w);
      expect(effectiveTaskOwner(w.taskOf(solo.taskId)).developerId).toBe(ARJUN);
      expect(w.get(taskIndexKey(ARJUN, solo.createdAt, solo.taskId))).toBeDefined();
    });

    it("leaves a task someone else took over, and another org's task of the same creator id, alone", async () => {
      const { w } = setup();
      const taken = soloTask(w, { currentOwner: { developerId: PRIYA, name: "Priya", provider: "oidc", since: "2026-10-22T08:30:00.000Z" }, payer: { kind: "member", developerId: PRIYA } });
      const foreign = soloTask(w, { orgId: ORG_B });
      const before = { taken: structuredClone(w.taskOf(taken.taskId)), foreign: structuredClone(w.taskOf(foreign.taskId)) };
      await merge(w);
      expect(w.taskOf(taken.taskId)).toEqual(before.taken);
      expect(w.taskOf(foreign.taskId)).toEqual(before.foreign);
      expect(w.get(taskIndexKey(ARJUN, foreign.createdAt, foreign.taskId))).toBeUndefined();
    });

    it("makes the survivor pay: a member payer, and the creator-default payer, become the survivor; other payers stay", async () => {
      const { w, zedsOwn } = setup();
      const explicit = soloTask(w, { payer: { kind: "member", developerId: ZED } });
      const project = soloTask(w, { payer: { kind: "project", project: "web" } });
      const third = soloTask(w, { payer: { kind: "member", developerId: PRIYA } });
      await merge(w);
      expect(paymentOfTask(w.taskOf(zedsOwn.taskId)).payer).toEqual({ kind: "member", developerId: ARJUN });
      expect(paymentOfTask(w.taskOf(explicit.taskId)).payer).toEqual({ kind: "member", developerId: ARJUN });
      expect(paymentOfTask(w.taskOf(project.taskId)).payer).toEqual({ kind: "project", project: "web" });
      expect(paymentOfTask(w.taskOf(third.taskId)).payer).toEqual({ kind: "member", developerId: PRIYA });
    });

    it("M-B: a task the CORE runs keeps its payer in its own row, which follows the person in the same transaction (a member payer moves, a project or another member's stays), and its record gets no payer", async () => {
      const { w } = setup();
      const coreTask = (payer: Record<string, unknown>) => {
        const solo = soloTask(w);
        const { orgId, ...record } = w.taskOf(solo.taskId) as unknown as Record<string, unknown>;
        void orgId;
        // The core's record names its company, not `orgId`, and its payer is a row of its own (what the start's admission captured).
        w.db.delete(taskKey(solo.taskId));
        w.db.set({ ...record, companyId: ORG_A });
        w.db.set({ ...taskPayerKey(solo.taskId), entityType: "TASK_PAYER", orgId: ORG_A, taskId: solo.taskId, payer });
        return solo;
      };
      const mine = coreTask({ kind: "member", developerId: ZED });
      const project = coreTask({ kind: "project", project: "web" });
      const third = coreTask({ kind: "member", developerId: PRIYA });
      // The handler gives these routes a client that reads a core row's company as `orgId` too.
      await onMembersMerged({ ...w.deps, documentClient: viewCoreTaskRowsClient(w.db) }, { orgId: ORG_A, survivorId: ARJUN, duplicateId: ZED });
      expect(w.get(taskPayerKey(mine.taskId))).toMatchObject({ payer: { kind: "member", developerId: ARJUN } });
      expect(w.get(taskPayerKey(project.taskId))).toMatchObject({ payer: { kind: "project", project: "web" } });
      expect(w.get(taskPayerKey(third.taskId))).toMatchObject({ payer: { kind: "member", developerId: PRIYA } });
      // The task record is handed on as any task's is (the condition accepts its `companyId`), and gets no `payer`.
      expect(effectiveTaskOwner(w.taskOf(mine.taskId)).developerId).toBe(ARJUN);
      expect(w.taskOf(mine.taskId)).not.toHaveProperty("payer");
    });

    it("moves the session's payer copy with it", async () => {
      const { w, zedsOwn, followed } = setup();
      w.db.set({ ...w.get(agentSessionKey(ORG_A, zedsOwn.sessionId, "META"))!, payer: { kind: "member", developerId: ZED } });
      w.db.set({ ...w.get(agentSessionKey(ORG_A, followed.sessionId, "META"))!, payer: { kind: "member", developerId: PRIYA } });
      await merge(w);
      expect(w.get(agentSessionKey(ORG_A, zedsOwn.sessionId, "META"))!["payer"]).toEqual({ kind: "member", developerId: ARJUN });
      expect(w.get(agentSessionKey(ORG_A, followed.sessionId, "META"))!["payer"]).toEqual({ kind: "member", developerId: PRIYA });
    });

    it("hands on a duplicate with more than 5,000 task rows in one run, and then moves the shares, follows and devices (Review I-1)", async () => {
      const { w, followed } = setup();
      for (let i = 0; i < 5_100; i += 1) {
        w.db.set({ ...taskIndexKey(ZED, new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 1000).toISOString(), `t${String(i)}`), entityType: "DEVELOPER_TASK_INDEX", taskId: `t${String(i)}`, orgId: ORG_A });
      }
      const last = soloTask(w);
      await merge(w);
      expect(effectiveTaskOwner(w.taskOf(last.taskId)).developerId).toBe(ARJUN);
      expect(w.get(deviceKey(ORG_A, DEVICE_A))!["developerId"]).toBe(ARJUN);
      expect(w.shares(ORG_A, followed.sessionId)).toContain(`MEMBER#${ARJUN}=edit`);
      // A repeat reads the marked rows without touching a task again.
      const after = w.snapshot();
      await merge(w);
      expect(w.snapshot()).toBe(after);
    });

    it("a run stopped by its deadline is continued by the next: each run hands on more tasks, and the steps after them run in the end (Review I-1)", async () => {
      const { w } = setup();
      const solos = Array.from({ length: 30 }, () => soloTask(w));
      let clock = T0;
      const tick = () => (clock += 1);
      const handed = () => solos.filter((solo) => effectiveTaskOwner(w.taskOf(solo.taskId)).developerId === ARJUN).length;
      let runs = 0;
      let finished = false;
      let before = handed();
      while (!finished && runs < 60) {
        runs += 1;
        try {
          await onSessionMembersMerged({ ...w.deps, now: tick, deadline: clock + 80 }, { orgId: ORG_A, survivorId: ARJUN, duplicateId: ZED });
          finished = true;
        } catch (error) {
          expect((error as Error).name).toBe("LifecycleDeadline");
          if (before < 30) expect(handed(), `run ${String(runs)} made no progress`).toBeGreaterThan(before);
        }
        before = handed();
      }
      expect(finished).toBe(true);
      expect(runs).toBeGreaterThan(1);
      expect(handed()).toBe(30);
      expect(w.get(deviceKey(ORG_A, DEVICE_A))!["developerId"]).toBe(ARJUN);
    });

    it("does not hand on a task that someone else created and nobody took over, though the duplicate's session names it, and keeps a third person's payer on a session the duplicate owns", async () => {
      const { w, zedsOwn } = setup();
      w.db.set({ ...w.taskOf(zedsOwn.taskId), developerId: PRIYA, developerName: "Priya", payer: { kind: "member", developerId: PRIYA } });
      w.db.set({ ...w.get(agentSessionKey(ORG_A, zedsOwn.sessionId, "META"))!, payer: { kind: "member", developerId: PRIYA } });
      const before = structuredClone(w.taskOf(zedsOwn.taskId));
      await merge(w);
      expect(w.taskOf(zedsOwn.taskId)).toEqual(before);
      expect(w.get(taskIndexKey(ARJUN, zedsOwn.createdAt, zedsOwn.taskId))).toBeUndefined();
      expect(w.get(agentSessionKey(ORG_A, zedsOwn.sessionId, "META"))!["payer"]).toEqual({ kind: "member", developerId: PRIYA });
      // Review M-1: the task is not the duplicate's to hand on, so the session does not move either (the two owners never disagree).
      expect(w.get(agentSessionKey(ORG_A, zedsOwn.sessionId, "META"))!["owner"]).toMatchObject({ developerId: ZED });
      expect(w.get(mySessionsKey(ORG_A, ZED, zedsOwn.createdAt, zedsOwn.sessionId))).toBeDefined();
      expect(w.get(liveSessionKey(ORG_A, zedsOwn.sessionId))).toMatchObject({ ownerId: ZED });
    });

    it("loses to a take-over that lands between the read and the write: the task is read again and left to its new owner", async () => {
      const { w } = setup();
      const solo = soloTask(w);
      const send = w.db.send;
      let raced = false;
      w.db.send = (async (command: { constructor: { name: string }; input: { TransactItems?: Array<Record<string, { Key?: { pk: string } }>> } }) => {
        const touchesTask = command.constructor.name === "TransactWriteCommand" && (command.input.TransactItems ?? []).some((entry) => Object.values(entry)[0]?.Key?.pk === taskKey(solo.taskId).pk);
        if (touchesTask && !raced) {
          raced = true;
          w.db.set({ ...w.taskOf(solo.taskId), currentOwner: { developerId: PRIYA, name: "Priya", provider: "oidc", since: "2026-10-22T09:00:00.000Z" }, payer: { kind: "member", developerId: PRIYA } });
        }
        return send(command);
      });
      await merge(w);
      expect(raced).toBe(true);
      expect(effectiveTaskOwner(w.taskOf(solo.taskId)).developerId).toBe(PRIYA);
      expect(paymentOfTask(w.taskOf(solo.taskId)).payer).toEqual({ kind: "member", developerId: PRIYA });
    });

    it("makes the next dispatch's owner check follow the survivor: R60 names and tests the survivor, not the merged-away id", async () => {
      const { w, zedsOwn } = setup();
      await merge(w);
      const deps = { documentClient: w.db, tableName: "state", orgId: ORG_A };
      // Arjun is a member: the check passes. Remove him and it refuses naming him.
      await expect(requireCreatorStillMember(deps, w.taskOf(zedsOwn.taskId))).resolves.toBeUndefined();
      w.removed(ARJUN);
      expect(await code(requireCreatorStillMember(deps, w.taskOf(zedsOwn.taskId)))).toMatchObject({ code: "TASK_ACCESS_DENIED", message: "Arjun is no longer a member of the organization, so Rovara stopped this task." });
    });

    it("does it again to nothing, and a second run finishes tasks the first did not reach", async () => {
      const { w } = setup();
      await merge(w);
      const after = w.snapshot();
      await merge(w);
      expect(w.snapshot()).toBe(after);
      const late = soloTask(w);
      await merge(w);
      expect(effectiveTaskOwner(w.taskOf(late.taskId)).developerId).toBe(ARJUN);
    });

    it("rewrites who made the duplicate's shares to the survivor, and leaves other people's", async () => {
      const { w, followed, zedsOwn } = setup();
      // Zed (edit on `followed`) shared it with Ola; Zed also shared his own session with Mia; Priya shared `followed` with Mia (seeded).
      w.share(ORG_A, followed.sessionId, OWNER, "view", ZED);
      w.share(ORG_A, zedsOwn.sessionId, MIA, "view", ZED);
      await merge(w);
      expect(w.get(agentSessionKey(ORG_A, followed.sessionId, `SHARE#MEMBER#${OWNER}`))!["sharedBy"]).toMatchObject({ developerId: ARJUN, name: "Arjun" });
      expect(w.get(agentSessionKey(ORG_A, zedsOwn.sessionId, `SHARE#MEMBER#${MIA}`))!["sharedBy"]).toMatchObject({ developerId: ARJUN, name: "Arjun" });
      expect(w.get(agentSessionKey(ORG_A, followed.sessionId, `SHARE#MEMBER#${MIA}`))!["sharedBy"]).toMatchObject({ developerId: PRIYA });
    });
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

describe("a follow alone grants nothing (Controller ruling 1)", () => {
  it("gives no read to a member with no role or share, or to a person who has left, whatever follows they hold", async () => {
    const w = world();
    const s = w.session({ owner: PRIYA, followers: [ZED, ARJUN] });
    const record = (await new AgentSessionStore({ documentClient: w.db, tableName: "state", now: () => w.clock.now }).get(ORG_A, s.sessionId))!;
    const deps = { documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members };
    // Zed is a member with no role on web and no share: his follow is only a flag.
    expect(await sessionLevelOf(deps, { orgId: ORG_A, developerId: ZED }, record, {})).toBe("none");
    // Arjun has left the company with his follow still there: nothing is read for him.
    w.removed(ARJUN);
    expect(await sessionLevelOf(deps, { orgId: ORG_A, developerId: ARJUN }, record, {})).toBe("none");
    expect(w.followers(ORG_A, s.sessionId)).toEqual([ARJUN, ZED].sort());
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
    // A follower who is no member and owns nothing, with a feed and a device: only the session names him. And a member's list row for a session whose record is gone.
    w.follow(ORG_A, a.sessionId, hex("7"));
    w.db.set({ ...changesKey(ORG_A, hex("7"), CREATED_AT, 1), entityType: "CHANGE_NOTICE", orgId: ORG_A, type: "session_shared", sessionId: a.sessionId });
    w.device(ORG_A, hex("7"), "dvc_dddddddddddddddddddd");
    w.db.set({ ...mySessionsKey(ORG_A, PRIYA, CREATED_AT, "ses_eeeeeeeeeeeeeeeeeeee"), entityType: "MY_SESSION", orgId: ORG_A, sessionId: "ses_eeeeeeeeeeeeeeeeeeee", developerId: PRIYA, createdAt: CREATED_AT });
    // A long-ended session of a person who has left: no live tile, and no member whose own list names it; only its project's list does.
    const gone = w.session({ owner: hex("8"), ended: true });
    w.db.delete(liveSessionKey(ORG_A, gone.sessionId));
    // Org B's own rows of every kind.
    const b = w.session({ orgId: ORG_B, owner: BO, project: "web", followers: [BO] });
    w.share(ORG_B, b.sessionId, BO, "view");
    w.device(ORG_B, BO, DEVICE_C);
    w.db.set({ ...changesKey(ORG_B, BO, CREATED_AT, 1), entityType: "CHANGE_NOTICE", orgId: ORG_B, type: "session_shared", sessionId: b.sessionId });
    w.db.set({ ...endedSessionWorkKey(day, ORG_B, b.sessionId), entityType: "ENDED_AGENT_SESSION", orgId: ORG_B, sessionId: b.sessionId });
    w.db.set({ ...openAgentSessionKey(ORG_B, b.sessionId), entityType: "OPEN_AGENT_SESSION", orgId: ORG_B, sessionId: b.sessionId });
    // An entry the drain has not reached yet, two days back, of each org.
    w.db.set({ ...endedSessionWorkKey("2026-10-20", ORG_A, "ses_cccccccccccccccccccc"), entityType: "ENDED_AGENT_SESSION", orgId: ORG_A, sessionId: "ses_cccccccccccccccccccc" });
    w.db.set({ ...endedSessionWorkKey("2026-10-20", ORG_B, "ses_dddddddddddddddddddd"), entityType: "ENDED_AGENT_SESSION", orgId: ORG_B, sessionId: "ses_dddddddddddddddddddd" });
    w.db.set({ pk: "ENDED_DRAIN_CURSOR", sk: "META", entityType: "ENDED_DRAIN_CURSOR", day: "2026-10-20" });
    return { w, a, ended, b, gone };
  };
  const rowsOf = (w: World, orgId: OrgId) => JSON.stringify(w.db.find((item) => String(item.pk).includes(orgId) || String(item.sk).includes(orgId)));
  const orgAPartitions = (w: World) => w.db.find((item) => String(item.pk).startsWith(`ORG#${ORG_A}#`) && /LIVE_SESSIONS|LIVE_PRESENCE|CHANGES#|DEVICE#|MEMBER_DEVICES#/.test(String(item.pk)));

  /** How many sessions of org A have their record given the expiry. */
  const stampedCount = (w: World) => w.db.find((item) => item.sk === "META" && String(item.pk).startsWith(`ORG#${ORG_A}#AGENT_SESSION#`) && typeof item.indexExpiresAt === "number").length;
  const manySessions = (w: World, count: number) => Array.from({ length: count }, () => {
    const made = w.session({ owner: PRIYA });
    for (let i = 0; i < 3; i += 1) w.db.set({ ...agentSessionKey(ORG_A, made.sessionId, `EVENT#2026-10-22T08:0${String(i)}:00.000Z#evt_${String(i)}`), entityType: "AGENT_SESSION_EVENT", orgId: ORG_A, text: "x" });
    return made;
  });

  it("makes progress across runs: each run that runs out of time leaves more sessions done, and the close completes (Review I-2)", async () => {
    // How many clock ticks a whole close takes, on a world of its own.
    const calibration = setup();
    manySessions(calibration.w, 25);
    let spent = T0;
    await closeOrgSessions({ documentClient: calibration.w.db, tableName: "state", now: () => (spent += 1) }, ORG_A, { budgetMs: 1_000_000 });
    const whole = spent - T0;
    const { w } = setup();
    manySessions(w, 25);
    let clock = T0;
    const tick = () => (clock += 1);
    let runs = 0;
    let finished = false;
    let before = stampedCount(w);
    while (!finished && runs < 40) {
      runs += 1;
      try {
        await closeOrgSessions({ documentClient: w.db, tableName: "state", now: tick }, ORG_A, { budgetMs: Math.ceil(whole * 0.45) });
        finished = true;
      } catch (error) {
        expect((error as { code?: string }).code).toBe("RUNTIME_UNAVAILABLE");
        expect(stampedCount(w), `run ${String(runs)} made no progress`).toBeGreaterThan(before);
      }
      before = stampedCount(w);
    }
    expect(finished).toBe(true);
    expect(runs).toBeGreaterThan(1);
    expect(orgAPartitions(w)).toEqual([]);
    expect(stampedCount(w)).toBeGreaterThanOrEqual(25);
  });

  it("a run that fails partway through a session finishes it next time: the record is stamped last (Review I-2)", async () => {
    const { w, a } = setup();
    w.db.set({ ...agentSessionKey(ORG_A, a.sessionId, "EVENT#2026-10-22T08:00:00.000Z#evt_9"), entityType: "AGENT_SESSION_EVENT", orgId: ORG_A, text: "x" });
    w.db.injectFault({ command: "UpdateCommand", match: (input) => JSON.stringify(input).includes("EVENT#2026-10-22T08:00:00.000Z#evt_9"), error: { name: "InternalServerError" }, times: 1 });
    expect(await code(clearOrgSessions(w.deps, ORG_A))).toMatchObject({ name: "InternalServerError" });
    expect(w.get(agentSessionKey(ORG_A, a.sessionId, "META"))!["indexExpiresAt"]).toBeUndefined();
    await clearOrgSessions(w.deps, ORG_A);
    expect(w.get(agentSessionKey(ORG_A, a.sessionId, "EVENT#2026-10-22T08:00:00.000Z#evt_9"))!["indexExpiresAt"]).toBe(EXPIRES);
    expect(w.get(agentSessionKey(ORG_A, a.sessionId, "META"))!["indexExpiresAt"]).toBe(EXPIRES);
  });

  it("does not read a finished session again on a later run (Review I-2)", async () => {
    const { w } = setup();
    const made = manySessions(w, 3);
    await clearOrgSessions(w.deps, ORG_A);
    const queried: string[] = [];
    const send = w.db.send;
    w.db.send = (async (command: { constructor: { name: string }; input: { ExpressionAttributeValues?: Record<string, unknown> } }) => {
      if (command.constructor.name === "QueryCommand") queried.push(String(command.input.ExpressionAttributeValues?.[":pk"]));
      return send(command);
    });
    w.clock.now += 3_600_000;
    await clearOrgSessions(w.deps, ORG_A);
    for (const session of made) expect(queried.filter((pk) => pk.includes(session.sessionId)), session.sessionId).toEqual([]);
  });

  it("stops the org's running work first, once per open session with a request id that repeats, never failing the close (Review M-6)", async () => {
    const { w, a, ended } = setup();
    const calls: Array<{ sessionId: string; requestId: string }> = [];
    const stop = async (sessionId: string, requestId: string) => {
      calls.push({ sessionId, requestId });
      if (sessionId === ended.sessionId) throw new Error("this one cannot be stopped");
    };
    await stopOrgSessions(w.deps, ORG_A, stop);
    expect(calls.map((call) => call.sessionId).sort()).toEqual([a.sessionId, ended.sessionId].sort());
    for (const call of calls) expect(call.requestId).toBe(closeStopRequestId(ORG_A, call.sessionId));
    expect(closeStopRequestId(ORG_A, a.sessionId)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(closeStopRequestId(ORG_A, a.sessionId)).not.toBe(closeStopRequestId(ORG_B, a.sessionId));
    expect(w.lines.some((line) => line.event === "agent_session.close_stop_failed")).toBe(true);
    // A second run asks again with the same ids; the stop is idempotent by them.
    await stopOrgSessions(w.deps, ORG_A, stop);
    expect(calls.filter((call) => call.sessionId === a.sessionId).map((call) => call.requestId)).toHaveLength(2);
    expect(new Set(calls.filter((call) => call.sessionId === a.sessionId).map((call) => call.requestId)).size).toBe(1);
  });

  it("asks nothing for another org's sessions", async () => {
    const { w, b } = setup();
    const asked: string[] = [];
    await stopOrgSessions(w.deps, ORG_A, async (sessionId) => { asked.push(sessionId); });
    expect(asked).not.toContain(b.sessionId);
  });

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
    expect(w.get(endedSessionWorkKey("2026-10-20", ORG_A, "ses_cccccccccccccccccccc"))).toBeUndefined();
    expect(w.get(endedSessionWorkKey("2026-10-20", ORG_B, "ses_dddddddddddddddddddd"))).toBeDefined();
    expect(rowsOf(w, ORG_B)).toBe(theirs);
    expect(w.get(openAgentSessionKey(ORG_B, b.sessionId as never))).toBeDefined();
    expect(w.get(endedSessionWorkKey("2026-10-22", ORG_B, b.sessionId as never))).toBeDefined();
    expect(w.get(liveSessionKey(ORG_B, b.sessionId))).toBeDefined();
  });

  it("gives the rest an expiry 30 days on, and never lengthens a shorter one", async () => {
    const { w, a, ended, gone } = setup();
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
    expect(w.get(agentSessionKey(ORG_A, gone.sessionId, "META"))!["indexExpiresAt"]).toBe(EXPIRES);
    expect(w.get(mySessionsKey(ORG_A, PRIYA, CREATED_AT, "ses_eeeeeeeeeeeeeeeeeeee"))!["indexExpiresAt"]).toBe(EXPIRES);
    expect(w.get(mySessionsKey(ORG_A, hex("8"), gone.createdAt, gone.sessionId))!["indexExpiresAt"]).toBe(EXPIRES);
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
    // Task 20 review I1: the binding sits in a partition of its own (`sessionBindingKey`), not the session's.
    w.db.set({ ...sessionBindingKey(ORG_A, s.sessionId, "slack_thread"), entityType: "AGENT_SESSION_BINDING", orgId: ORG_A, sessionId: s.sessionId, binding });
    w.db.set({ ...sessionSurfaceKey(ORG_A, binding), entityType: "SESSION_SURFACE", orgId: ORG_A, sessionId: s.sessionId, binding });
    await clearOrgSessions(w.deps, ORG_A);
    expect(w.get(sessionSurfaceKey(ORG_A, binding))!["indexExpiresAt"]).toBe(Math.floor(T0 / 1000) + 30 * DAY);
    expect(w.get(sessionBindingKey(ORG_A, s.sessionId as never, "slack_thread"))!["indexExpiresAt"]).toBe(Math.floor(T0 / 1000) + 30 * DAY);
  });
});

describe("a removal in an org with no owner left (Review M-5)", () => {
  const SUBJECT = (sessionId: string) => ({ kind: "session_owner" as const, sessionId, to: PRIYA, sessionRevision: 1 });
  const setup = () => {
    const w = world();
    registerApproverRule("lifecycle_test", async () => true);
    registerApprovalSubjectHandler("session_owner", async () => undefined);
    w.db.delete(orgMemberKey(ORG_A, OWNER));
    const asked = (approvers: { kind: "ids"; ids: string[] } | { kind: "rule"; rule: string; candidates: string[] }, requestedBy = PRIYA) =>
      createPendingChange(w.deps, { orgId: ORG_A, requestId: randomUUID(), requestedBy, subject: SUBJECT(`ses_${"1".repeat(20)}`), changes: ["a change"], approvers });
    const record = async (approvalId: string) => (await getAnyApproval(w.deps, ORG_A, approvalId))!;
    const listed = (approvalId: string) => w.db.find((item) => item.entityType === "APPROVER_INDEX" && item.approvalId === approvalId).map((item) => String(item.pk).split("APPROVER#")[1]).sort();
    const notices = (developerId: string) => w.db.find((item) => item.entityType === "CHANGE_NOTICE" && item.pk === changesKey(ORG_A, developerId, CREATED_AT, 0).pk && (item.notice as { type?: string } | undefined)?.type === "home.changed");
    return { w, asked, record, listed, notices };
  };
  const removeArjun = (w: World) => onMemberRemoved(w.deps, { orgId: ORG_A, developerId: ARJUN, by: PRIYA });

  it("re-routes an approval to the approvers who are left, and never decides it", async () => {
    const { w, asked, record, listed } = setup();
    const ids = await asked({ kind: "ids", ids: [ARJUN, MIA] });
    const rule = await asked({ kind: "rule", rule: "lifecycle_test", candidates: [ARJUN, MAX] });
    w.db.delete(orgMemberKey(ORG_A, ARJUN));
    await removeArjun(w);
    expect((await record(ids.approvalId)).approvers).toEqual({ kind: "ids", ids: [MIA] });
    expect((await record(rule.approvalId)).approvers).toEqual({ kind: "rule", rule: "lifecycle_test", candidates: [MAX] });
    for (const made of [ids, rule]) expect((await record(made.approvalId)).status).toBe("PENDING");
    expect(listed(ids.approvalId)).toEqual([MIA]);
    expect(listed(rule.approvalId)).toEqual([MAX]);
    expect(listed(rule.approvalId)).not.toContain(ARJUN);
  });

  it("ends an approval nobody else can decide, as expired with the reason, tells the requester, and never approves it", async () => {
    const { w, asked, record, listed, notices } = setup();
    const only = await asked({ kind: "ids", ids: [ARJUN] });
    w.db.delete(orgMemberKey(ORG_A, ARJUN));
    await removeArjun(w);
    const ended = await record(only.approvalId);
    expect(ended).toMatchObject({ status: "EXPIRED", closedBy: "system", closedReason: "Everyone who could decide this has left your organization, so it was closed without a decision. Ask again if it is still needed." });
    expect(listed(only.approvalId)).toEqual([]);
    expect(notices(PRIYA)).toHaveLength(1);
    expect(w.db.find((item) => item.entityType === "OPEN_APPROVAL" && item.approvalId === only.approvalId)).toEqual([]);
  });

  it("does not tell a requester who is the one who left, and repeating changes nothing", async () => {
    const { w, asked, record, notices } = setup();
    const own = await asked({ kind: "ids", ids: [ARJUN] }, ARJUN);
    w.db.delete(orgMemberKey(ORG_A, ARJUN));
    await removeArjun(w);
    expect((await record(own.approvalId)).status).toBe("EXPIRED");
    expect(notices(ARJUN)).toEqual([]);
    const after = w.snapshot();
    w.clock.now += 3_600_000;
    await removeArjun(w);
    expect(w.snapshot().replaceAll(String(T0), "")).toBe(after.replaceAll(String(T0), ""));
  });

  it("leaves an approval alone that does not name the leaver", async () => {
    const { w, asked, record } = setup();
    const other = await asked({ kind: "ids", ids: [MIA, MAX] });
    const before = structuredClone(await record(other.approvalId));
    w.db.delete(orgMemberKey(ORG_A, ARJUN));
    await removeArjun(w);
    expect(await record(other.approvalId)).toEqual(before);
  });
});

// Re-check R-1 of Plan 5 Task 21: whenever a waiting approval can no longer be decided because the person who left was its only possible decider, it is re-listed to someone the rule lets decide, or ended
// with the reason and the asker told, with an owner left or not. Nothing is ever approved.
describe("a removal that leaves an approval with no one to decide it (Re-check R-1)", () => {
  const SUBJECT = { kind: "session_owner" as const, sessionId: `ses_${"1".repeat(20)}`, to: PRIYA, sessionRevision: 1 };
  const setup = (options: { owner: boolean }) => {
    const w = world();
    registerApproverRule("lifecycle_any", async () => true);
    registerApproverRule("lifecycle_none", async () => false);
    registerApproverRule("lifecycle_staff", async (_deps, _record, caller) => caller.developerId === OWNER || caller.developerId === hex("e"));
    registerApprovalSubjectHandler("session_owner", async () => undefined);
    if (!options.owner) w.db.delete(orgMemberKey(ORG_A, OWNER));
    const asked = (approvers: { kind: "rule"; rule: string; candidates: string[] } | { kind: "ids"; ids: string[] }) =>
      createPendingChange(w.deps, { orgId: ORG_A, requestId: randomUUID(), requestedBy: PRIYA, subject: SUBJECT, changes: ["a change"], approvers });
    const record = async (approvalId: string) => (await getAnyApproval(w.deps, ORG_A, approvalId))!;
    const listed = (approvalId: string) => w.db.find((item) => item.entityType === "APPROVER_INDEX" && item.approvalId === approvalId).map((item) => String(item.pk).split("APPROVER#")[1]).sort();
    const notices = (developerId: string) => w.db.find((item) => item.entityType === "CHANGE_NOTICE" && item.pk === changesKey(ORG_A, developerId, CREATED_AT, 0).pk && (item.notice as { type?: string } | undefined)?.type === "home.changed");
    const leave = async () => {
      w.db.delete(orgMemberKey(ORG_A, ARJUN));
      await onMemberRemoved(w.deps, { orgId: ORG_A, developerId: ARJUN, by: PRIYA });
    };
    return { w, asked, record, listed, notices, leave };
  };
  const REASON = "Everyone who could decide this has left your organization, so it was closed without a decision. Ask again if it is still needed.";

  it("lists a rule-kind approval whose only candidate left to someone the rule lets decide (an owner is left), the owner before an admin who joined earlier", async () => {
    const { w, asked, record, listed, leave } = setup({ owner: true });
    w.db.set({ ...w.get(orgMemberKey(ORG_A, hex("e")))!, joinedAt: "2026-09-01T00:00:00.000Z" });
    const made = await asked({ kind: "rule", rule: "lifecycle_any", candidates: [ARJUN] });
    await leave();
    expect(await record(made.approvalId)).toMatchObject({ status: "PENDING", approvers: { kind: "rule", rule: "lifecycle_any", candidates: [OWNER] } });
    expect(listed(made.approvalId)).toEqual([OWNER]);
  });

  it("never lists the person who is leaving, though their member record is still there as an admin", async () => {
    const { w, asked, record } = setup({ owner: false });
    w.db.set({ ...w.get(orgMemberKey(ORG_A, ARJUN))!, role: "admin", joinedAt: "2020-01-01T00:00:00.000Z" });
    const made = await asked({ kind: "rule", rule: "lifecycle_any", candidates: [ARJUN] });
    await onMemberRemoved(w.deps, { orgId: ORG_A, developerId: ARJUN, by: PRIYA });
    expect((await record(made.approvalId)).approvers).toEqual({ kind: "rule", rule: "lifecycle_any", candidates: [hex("e")] });
  });

  it("adds a person the rule lets decide when the candidates left do not satisfy it, and keeps the ones listed", async () => {
    const { asked, record, leave } = setup({ owner: true });
    const made = await asked({ kind: "rule", rule: "lifecycle_staff", candidates: [ARJUN, MAX] });
    await leave();
    const after = await record(made.approvalId);
    expect(after.status).toBe("PENDING");
    expect([...(after.approvers as unknown as { candidates: string[] }).candidates].sort()).toEqual([MAX, OWNER].sort());
  });

  it("leaves a rule-kind approval alone whose remaining candidates the rule lets decide", async () => {
    const { asked, record, leave } = setup({ owner: true });
    const made = await asked({ kind: "rule", rule: "lifecycle_staff", candidates: [ARJUN, OWNER] });
    await leave();
    expect(await record(made.approvalId)).toMatchObject({ status: "PENDING", approvers: { kind: "rule", rule: "lifecycle_staff", candidates: [OWNER] } });
  });

  it("ends a rule-kind approval nobody the rule lets decide is left for, with the reason, and tells the asker; never approved", async () => {
    const { asked, record, listed, notices, leave } = setup({ owner: true });
    const made = await asked({ kind: "rule", rule: "lifecycle_none", candidates: [ARJUN, MAX] });
    await leave();
    expect(await record(made.approvalId)).toMatchObject({ status: "EXPIRED", closedBy: "system", closedReason: REASON });
    expect(listed(made.approvalId)).toEqual([]);
    expect(notices(PRIYA)).toHaveLength(1);
  });

  it("does the same in an org with no owner: the admins are looked at, and the approval ends when none satisfies the rule", async () => {
    const lists = setup({ owner: false });
    const listedOne = await lists.asked({ kind: "rule", rule: "lifecycle_staff", candidates: [ARJUN] });
    const ended = await lists.asked({ kind: "rule", rule: "lifecycle_none", candidates: [ARJUN] });
    await lists.leave();
    expect(await lists.record(listedOne.approvalId)).toMatchObject({ status: "PENDING", approvers: { kind: "rule", candidates: [hex("e")] } });
    expect(await lists.record(ended.approvalId)).toMatchObject({ status: "EXPIRED", closedReason: REASON });
  });

  it("hands an id-list approval to the successor, as before, and names no one the list did not", async () => {
    const { asked, record, leave } = setup({ owner: true });
    const made = await asked({ kind: "ids", ids: [ARJUN, MIA] });
    await leave();
    expect((await record(made.approvalId)).approvers).toEqual({ kind: "ids", ids: [OWNER, MIA] });
  });
});

describe("the stop of running work has a time limit (Re-check R-2)", () => {
  it("stops asking once its time is over, and says so", async () => {
    const w = world();
    const ids = Array.from({ length: 12 }, () => w.session({ owner: PRIYA }).sessionId);
    for (const sessionId of ids) w.db.set({ ...openAgentSessionKey(ORG_A, sessionId), entityType: "OPEN_AGENT_SESSION", orgId: ORG_A, sessionId });
    let clock = T0;
    const asked: string[] = [];
    await stopOrgSessions({ ...w.deps, now: () => (clock += 1), deadline: T0 + 5 }, ORG_A, async (sessionId) => { asked.push(sessionId); });
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.length).toBeLessThan(12);
    expect(w.lines.map((line) => line.event)).toContain("agent_session.close_stop_deadline");
  });
});
