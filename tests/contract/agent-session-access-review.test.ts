// Plan 5 Task 4, review fix round: followers are re-checked on the full access path (the Slack channel counts) and only for the people a removed share
// could have covered; a project share counts a role only from a grant row or the Slack channel, never from the org role; an org admin is never a project
// viewer; and the share notice goes to the effective owner.
import { describe, expect, it } from "vitest";
import { requireSessionLevel, resolveSessionAccess, sessionActionsFor, type SessionAccessDependencies } from "../../packages/broker/src/agent-sessions/access.js";
import { deleteSessionShare, putSessionShare, type SessionShareDependencies } from "../../packages/broker/src/agent-sessions/shares.js";
import { ARJUN, MAX, MIA, OLA, ORG_A, ORG_B, PRIYA, ZED, sessionWorld, type SessionWorld } from "../support/agent-session-world.js";

const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));

function depsOf(w: SessionWorld): SessionShareDependencies {
  return { documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore };
}
const followers = (w: SessionWorld) => w.db.find((item) => String(item.sk).startsWith("FOLLOWER#")).map((item) => String(item.sk).replace("FOLLOWER#", "")).sort();
const accessOf = async (w: SessionWorld, who: string, sessionId: string) => {
  const deps: SessionAccessDependencies = depsOf(w);
  const access = await resolveSessionAccess(deps, w.caller(who), sessionId);
  return { level: access.level, projectRole: access.projectRole, actions: sessionActionsFor(access) };
};

describe("I-1: removing a share re-checks followers on the full path", () => {
  it("keeps the follow of a person who reaches the project only through its Slack channel", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession();
    w.members.channel(ORG_A, "web", ZED);
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ARJUN }, "view");
    w.seedShare(ORG_A, sessionId, { kind: "org" }, "view");
    w.follower(ORG_A, sessionId, ZED);
    expect((await accessOf(w, ZED, sessionId)).level).toBe("view");
    expect(await deleteSessionShare(depsOf(w), w.caller(PRIYA), sessionId, "ORG")).toEqual({ removed: true });
    expect(followers(w)).toEqual([ZED]);
  });

  it("keeps the follow of a channel-only person when a project share they were not covered by is removed, and drops one it covered", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession();
    w.members.channel(ORG_A, "web", ZED);
    w.members.channel(ORG_A, "ops", MIA);
    w.seedShare(ORG_A, sessionId, { kind: "project", project: "ops" }, "view");
    w.follower(ORG_A, sessionId, ZED);
    w.follower(ORG_A, sessionId, MIA);
    expect((await accessOf(w, MIA, sessionId)).level).toBe("view");
    await deleteSessionShare(depsOf(w), w.caller(PRIYA), sessionId, "PROJECT#ops");
    // Mia is a viewer on web by her grant, so she keeps it; the point is that Zed, who is there through the channel, does not lose his follow.
    expect(followers(w)).toContain(ZED);
  });

  it("drops the follow of a person whose only way in was the removed project share", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession();
    w.members.channel(ORG_A, "ops", ZED);
    w.seedShare(ORG_A, sessionId, { kind: "project", project: "ops" }, "view");
    w.follower(ORG_A, sessionId, ZED);
    expect((await accessOf(w, ZED, sessionId)).level).toBe("view");
    await deleteSessionShare(depsOf(w), w.caller(PRIYA), sessionId, "PROJECT#ops");
    expect(followers(w)).toEqual([]);
  });

  it("re-checks only the member whose share was removed", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession();
    const nobody = "7".repeat(64);
    w.member(ORG_A, nobody, "member");
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ZED }, "view");
    // A stale follow of someone with no access at all is not this removal's business; the removed member's own follow is.
    w.follower(ORG_A, sessionId, nobody);
    w.follower(ORG_A, sessionId, ZED);
    await deleteSessionShare(depsOf(w), w.caller(PRIYA), sessionId, `MEMBER#${ZED}`);
    expect(followers(w)).toEqual([nobody]);
  });
});

describe("I-2: a project share counts a role only from a grant row or the channel", () => {
  it("gives an org admin with no grant on the project nothing from a project share of a Mac session", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession({ kind: "local" });
    w.seedShare(ORG_A, sessionId, { kind: "project", project: "ops" }, "edit");
    expect(await code(resolveSessionAccess(depsOf(w), w.caller(OLA), sessionId))).toMatchObject({ code: "NOT_FOUND" });
    // A person with a grant on ops, and one with a channel seat, are covered.
    w.grant(ARJUN, "ops", "contributor");
    w.members.channel(ORG_A, "ops", ZED);
    expect((await accessOf(w, ARJUN, sessionId)).level).toBe("edit");
    expect((await accessOf(w, ZED, sessionId)).level).toBe("edit");
    // An admin who does hold a grant on ops is covered too.
    w.grant(OLA, "ops", "viewer");
    expect((await accessOf(w, OLA, sessionId)).level).toBe("edit");
  });

  it("still reaches an org admin who has a seat in the project's Slack channel, on the full path only", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession({ kind: "local" });
    w.seedShare(ORG_A, sessionId, { kind: "project", project: "ops" }, "use");
    w.members.channel(ORG_A, "ops", OLA);
    expect((await accessOf(w, OLA, sessionId)).level).toBe("use");
    expect(await code(resolveSessionAccess(depsOf(w), w.caller(OLA), sessionId, { readOnlyPath: true }))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("gives an org admin with no grant no edit or take-over from a project share of a task session", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession();
    w.seedShare(ORG_A, sessionId, { kind: "project", project: "web" }, "edit");
    const ola = await accessOf(w, OLA, sessionId);
    expect(ola.level).toBe("view");
    expect(ola.actions).toEqual(["watch", "comment", "stop"]);
    // A contributor on the project is covered by it.
    expect((await accessOf(w, ARJUN, sessionId)).level).toBe("edit");
  });
});

describe("m-1: an org admin is never a project viewer", () => {
  it("keeps view and Stop, and commenting, for an admin with a leftover viewer grant", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession();
    w.grant(OLA, "web", "viewer");
    const ola = await accessOf(w, OLA, sessionId);
    expect(ola).toMatchObject({ level: "view", projectRole: "maintainer" });
    expect(ola.actions).toEqual(["watch", "comment", "stop"]);
    await requireSessionLevel(depsOf(w), w.caller(OLA), sessionId, "view", "comment on it", { comment: true });
    await requireSessionLevel(depsOf(w), w.caller(OLA), sessionId, "edit", "stop it", { orgAdminMay: true });
    // And a `use` share to such an admin is not refused as a share to a project viewer.
    const reply = await putSessionShare(depsOf(w), w.caller(PRIYA), sessionId, { requestId: crypto.randomUUID(), principal: { kind: "member", developerId: OLA }, level: "use" });
    expect(reply.status).toBe(200);
  });

  it("still lets a maintainer grant decide edit for an admin", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession();
    w.grant(OLA, "web", "maintainer");
    expect((await accessOf(w, OLA, sessionId)).level).toBe("edit");
  });
});

describe("m-2: the notice and its undo go to the effective owner", () => {
  const noticeFor = (w: SessionWorld, who: string) => w.db.find((item) => String(item.pk).includes(`CHANGES#${who}`));

  it("tells the taker, not the previous owner, when a maintainer shares a session that was taken over", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession({ currentOwner: ARJUN });
    const reply = await putSessionShare(depsOf(w), w.caller(MAX), sessionId, { requestId: crypto.randomUUID(), principal: { kind: "member", developerId: ZED }, level: "view" });
    expect(reply.status).toBe(200);
    expect(noticeFor(w, ARJUN)).toHaveLength(1);
    expect(noticeFor(w, PRIYA)).toHaveLength(0);
  });

  it("ignores a take-over recorded on a task of another org", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession({ currentOwner: ARJUN, taskOrgId: ORG_B });
    await putSessionShare(depsOf(w), w.caller(MAX), sessionId, { requestId: crypto.randomUUID(), principal: { kind: "member", developerId: ZED }, level: "view" });
    expect(noticeFor(w, PRIYA)).toHaveLength(1);
    expect(noticeFor(w, ARJUN)).toHaveLength(0);
  });

  it("sends no notice when the taker shares, and one to the taker when the session's first owner does", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession({ currentOwner: ARJUN });
    await putSessionShare(depsOf(w), w.caller(ARJUN), sessionId, { requestId: crypto.randomUUID(), principal: { kind: "member", developerId: ZED }, level: "view" });
    expect(noticeFor(w, ARJUN)).toHaveLength(0);
    expect(noticeFor(w, PRIYA)).toHaveLength(0);
    // Priya, now maintainer by a grant, shares: the owner who gets told is Arjun.
    w.grant(PRIYA, "web", "maintainer");
    await putSessionShare(depsOf(w), w.caller(PRIYA), sessionId, { requestId: crypto.randomUUID(), principal: { kind: "member", developerId: MIA }, level: "view" });
    expect(noticeFor(w, ARJUN)).toHaveLength(1);
    expect(noticeFor(w, PRIYA)).toHaveLength(0);
  });
});
