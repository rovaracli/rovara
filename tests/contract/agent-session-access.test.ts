// Plan 5 Task 4: what a person may do on a session. The level is the highest of ownership, the caller's own project grant and org role, shares and
// Task People roles, capped by a project viewer's rule and a Task People `denied` entry; another org, and no level at all, answer NOT_FOUND.
import { describe, expect, it } from "vitest";
import type { SessionStatus } from "@agentx/contracts";
import { OFFER_HANDOFF, requireSessionLevel, resolveSessionAccess, sessionActionsFor, type SessionAccessDependencies } from "../../packages/broker/src/agent-sessions/access.js";
import { ARJUN, BO, MAX, MIA, OLA, ORG_A, ORG_B, PRIYA, ZED, sessionWorld, type SessionWorld } from "../support/agent-session-world.js";

const VIEWER_TEXT = "Viewers of web can only watch its sessions.";

function depsOf(w: SessionWorld, extra: Partial<SessionAccessDependencies> = {}): SessionAccessDependencies {
  return {
    documentClient: w.db, tableName: "state", now: () => w.clock.now,
    projectMembers: {
      roleOf: (orgId, project, who) => {
        w.channelCalls.push(`roleOf ${project} ${who.developerId.slice(0, 2)}`);
        return w.members.roleOf(orgId, project, who);
      },
    },
    ...extra,
  };
}
const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));
const levelOf = async (w: SessionWorld, who: string, sessionId: string, extra: Partial<SessionAccessDependencies> = {}) => {
  const access = await resolveSessionAccess(depsOf(w, extra), w.caller(who), sessionId);
  return { level: access.level, owner: access.owner, orgAdmin: access.orgAdmin, projectRole: access.projectRole, actions: sessionActionsFor(access, { status: "running" }) };
};

describe("a task session on a project", () => {
  it("is edited by its owner and a grant maintainer, viewed by project members and org admins, and not found by another org", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession();
    expect(await levelOf(w, PRIYA, sessionId)).toMatchObject({ level: "edit", owner: true, orgAdmin: false });
    expect(await levelOf(w, ARJUN, sessionId)).toMatchObject({ level: "view", owner: false, projectRole: "contributor" });
    expect(await levelOf(w, MIA, sessionId)).toMatchObject({ level: "view", projectRole: "viewer" });
    expect(await levelOf(w, MAX, sessionId)).toMatchObject({ level: "edit", owner: false, projectRole: "maintainer" });
    const ola = await levelOf(w, OLA, sessionId);
    expect(ola).toMatchObject({ level: "view", orgAdmin: true });
    expect(ola.actions).toContain("stop");
    expect(ola.actions).not.toContain("take_over");
    expect(ola.actions).not.toContain("steer");
    expect(await code(resolveSessionAccess(depsOf(w), w.caller(BO, ORG_B), sessionId))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(resolveSessionAccess(depsOf(w), w.caller(ZED), sessionId))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("gives an org admin who also holds a maintainer grant edit, and one with a contributor grant only view", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession();
    w.grant(OLA, "web", "maintainer");
    expect(await levelOf(w, OLA, sessionId)).toMatchObject({ level: "edit", orgAdmin: true });
    w.grant(OLA, "web", "contributor");
    expect(await levelOf(w, OLA, sessionId)).toMatchObject({ level: "view", orgAdmin: true });
  });

  it("reads the caller's org membership live: a person who left, or whom the token still calls a member, is not found", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession();
    w.db.delete(`ORG#${ORG_A}`, `MEMBER#${ARJUN}`);
    expect(await code(resolveSessionAccess(depsOf(w), w.caller(ARJUN), sessionId))).toMatchObject({ code: "NOT_FOUND" });
    // A share doesn't bring back someone who is no longer in the company.
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ARJUN }, "edit");
    expect(await code(resolveSessionAccess(depsOf(w), w.caller(ARJUN), sessionId))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("takes the level from the highest of the grant and the shares", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession();
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ARJUN }, "edit");
    expect(await levelOf(w, ARJUN, sessionId)).toMatchObject({ level: "edit", owner: false });
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ZED }, "use");
    expect(await levelOf(w, ZED, sessionId)).toMatchObject({ level: "use" });
    // A share doesn't lower what the grant gives.
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: MAX }, "view");
    expect(await levelOf(w, MAX, sessionId)).toMatchObject({ level: "edit" });
  });

  it("gives a project share to the people with a role on that project, and an org share to everyone in the company", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession({ project: null });
    w.grant(ARJUN, "ops", "contributor");
    w.seedShare(ORG_A, sessionId, { kind: "project", project: "ops" }, "use");
    expect(await levelOf(w, ARJUN, sessionId)).toMatchObject({ level: "use" });
    expect(await code(resolveSessionAccess(depsOf(w), w.caller(MAX), sessionId))).toMatchObject({ code: "NOT_FOUND" });
    w.seedShare(ORG_A, sessionId, { kind: "org" }, "view");
    expect(await levelOf(w, ZED, sessionId)).toMatchObject({ level: "view" });
    expect(await levelOf(w, MAX, sessionId)).toMatchObject({ level: "view" });
    expect(await levelOf(w, ARJUN, sessionId)).toMatchObject({ level: "use" });
  });

  it("never gives an Auditor more than view: not through an org share, a member share, ownership or a People entry (I2)", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession();
    w.db.set({ pk: `ORG#${ORG_A}`, sk: `MEMBER#${ZED}`, entityType: "ORG_MEMBER", orgId: ORG_A, developerId: ZED, role: "auditor", joinedAt: "2026-10-01T00:00:00.000Z" });
    w.seedShare(ORG_A, sessionId, { kind: "org" }, "edit");
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ZED }, "use");
    const access = await levelOf(w, ZED, sessionId);
    expect(access.level).toBe("view");
    expect(access.actions).not.toContain("steer");
    expect(access.actions).not.toContain("take_over");
    // A member with the same shares still gets them.
    expect(await levelOf(w, MAX, sessionId)).toMatchObject({ level: "edit" });
  });

  it("gives a person on no project the one session they were given, and no other", async () => {
    const w = sessionWorld();
    const mine = w.seedSession();
    const other = w.seedSession();
    w.seedShare(ORG_A, mine.sessionId, { kind: "member", developerId: ZED }, "view");
    expect(await levelOf(w, ZED, mine.sessionId)).toMatchObject({ level: "view", projectRole: undefined });
    expect(await code(resolveSessionAccess(depsOf(w), w.caller(ZED), other.sessionId))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("does not use a task of another org for the task rules", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession({ taskOrgId: ORG_B, people: [{ developerId: ZED, role: "commenter" }] });
    expect(await code(resolveSessionAccess(depsOf(w), w.caller(ZED), sessionId))).toMatchObject({ code: "NOT_FOUND" });
    expect(await levelOf(w, ARJUN, sessionId)).toMatchObject({ level: "view" });
  });

  it("finds nothing for an id of another org's session or one that doesn't exist", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession({ orgId: ORG_B, owner: BO, project: "web" });
    expect(await code(resolveSessionAccess(depsOf(w), w.caller(PRIYA), sessionId))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(resolveSessionAccess(depsOf(w), w.caller(PRIYA), "ses_99999999999999999999"))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(resolveSessionAccess(depsOf(w), w.caller(PRIYA), "not-an-id"))).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("a project viewer", () => {
  it("is refused a comment and every use or edit action with the viewer message, whatever their shares say", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession();
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: MIA }, "use");
    const deps = depsOf(w);
    expect((await levelOf(w, MIA, sessionId)).actions).toEqual(["watch"]);
    expect(await code(requireSessionLevel(deps, w.caller(MIA), sessionId, "view", "comment on it", { comment: true }))).toEqual({ code: "SESSION_LEVEL_REQUIRED", message: VIEWER_TEXT });
    expect(await code(requireSessionLevel(deps, w.caller(MIA), sessionId, "use", "message the agent"))).toEqual({ code: "SESSION_LEVEL_REQUIRED", message: VIEWER_TEXT });
    expect(await code(requireSessionLevel(deps, w.caller(MIA), sessionId, "edit", "stop it"))).toEqual({ code: "SESSION_LEVEL_REQUIRED", message: VIEWER_TEXT });
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: MIA }, "edit");
    expect(await code(requireSessionLevel(deps, w.caller(MIA), sessionId, "edit", "stop it"))).toEqual({ code: "SESSION_LEVEL_REQUIRED", message: VIEWER_TEXT });
    // Watching is what a viewer may do.
    expect((await requireSessionLevel(deps, w.caller(MIA), sessionId, "view", "see it")).level).toBe("view");
  });

  it("keeps the rights of an owner whom a demotion made a viewer, since the work is theirs", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession({ owner: MIA });
    expect(await levelOf(w, MIA, sessionId)).toMatchObject({ level: "edit", owner: true, projectRole: "viewer" });
    expect((await requireSessionLevel(depsOf(w), w.caller(MIA), sessionId, "edit", "stop it")).owner).toBe(true);
  });
});

describe("requireSessionLevel", () => {
  it("says what is needed and who to ask when the level is short, and 404s when there is none", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession();
    const deps = depsOf(w);
    expect(await code(requireSessionLevel(deps, w.caller(ARJUN), sessionId, "edit", "stop it"))).toEqual({
      code: "SESSION_LEVEL_REQUIRED", message: 'You need "can edit" on this session to stop it. Ask Priya to share it with you.',
    });
    expect(await code(requireSessionLevel(deps, w.caller(ARJUN), sessionId, "use", "message the agent"))).toEqual({
      code: "SESSION_LEVEL_REQUIRED", message: 'You need "can use" on this session to message the agent. Ask Priya to share it with you.',
    });
    expect(await code(requireSessionLevel(deps, w.caller(ZED), sessionId, "view", "see it"))).toMatchObject({ code: "NOT_FOUND" });
    expect((await requireSessionLevel(deps, w.caller(PRIYA), sessionId, "edit", "stop it")).owner).toBe(true);
    expect((await requireSessionLevel(deps, w.caller(MAX), sessionId, "edit", "stop it")).level).toBe("edit");
  });

  it("lets an org admin stop a session and nothing else that needs edit", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession();
    const deps = depsOf(w);
    expect((await requireSessionLevel(deps, w.caller(OLA), sessionId, "edit", "stop it", { orgAdminMay: true })).orgAdmin).toBe(true);
    expect(await code(requireSessionLevel(deps, w.caller(OLA), sessionId, "edit", "take it over"))).toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
    expect(await code(requireSessionLevel(deps, w.caller(ARJUN), sessionId, "edit", "stop it", { orgAdminMay: true }))).toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
  });
});

describe("a chain session", () => {
  it("is found by the readers Plan 4 names, and by a share; a maintainer grant edits it", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession({ kind: "chain" });
    const readers = new Set<string>();
    const extra = { chainReadAccess: async (who: { developerId: string }) => readers.has(who.developerId) };
    expect(await code(resolveSessionAccess(depsOf(w, extra), w.caller(ARJUN), sessionId))).toMatchObject({ code: "NOT_FOUND" });
    // The project's contributors are not readers of a chain just for being on the project.
    expect(await code(resolveSessionAccess(depsOf(w, extra), w.caller(MIA), sessionId))).toMatchObject({ code: "NOT_FOUND" });
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ARJUN }, "view");
    expect(await levelOf(w, ARJUN, sessionId, extra)).toMatchObject({ level: "view" });
    readers.add(ZED);
    expect(await levelOf(w, ZED, sessionId, extra)).toMatchObject({ level: "view" });
    expect(await levelOf(w, MAX, sessionId, extra)).toMatchObject({ level: "edit" });
    expect(await levelOf(w, PRIYA, sessionId, extra)).toMatchObject({ level: "edit", owner: true });
  });

  it("is found by nobody beyond its owner and its shares when no chain reader is wired", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession({ kind: "chain" });
    expect(await code(resolveSessionAccess(depsOf(w), w.caller(OLA), sessionId))).toMatchObject({ code: "NOT_FOUND" });
    expect(await levelOf(w, PRIYA, sessionId)).toMatchObject({ level: "edit" });
  });
});

describe("a local session on a project", () => {
  it("is found by nobody but its owner and the people it was shared with: no project rule and no org admin rule", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession({ kind: "local" });
    for (const who of [ARJUN, MAX, OLA]) expect(await code(resolveSessionAccess(depsOf(w), w.caller(who), sessionId)), who).toMatchObject({ code: "NOT_FOUND" });
    expect(await levelOf(w, PRIYA, sessionId)).toMatchObject({ level: "edit", owner: true });
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ARJUN }, "view");
    expect(await levelOf(w, ARJUN, sessionId)).toMatchObject({ level: "view" });
    expect(await code(resolveSessionAccess(depsOf(w), w.caller(MAX), sessionId))).toMatchObject({ code: "NOT_FOUND" });
    expect((await levelOf(w, ARJUN, sessionId)).orgAdmin).toBe(false);
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: OLA }, "view");
    expect(await levelOf(w, OLA, sessionId)).toMatchObject({ level: "view", orgAdmin: false });
  });
});

describe("Task People on a task session", () => {
  it("caps a denied person at nothing, except an org admin, who still sees it", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession({ people: [{ developerId: ARJUN, role: "denied" }, { developerId: OLA, role: "denied" }, { developerId: MAX, role: "denied" }] });
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ARJUN }, "edit");
    expect(await code(resolveSessionAccess(depsOf(w), w.caller(ARJUN), sessionId))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(resolveSessionAccess(depsOf(w), w.caller(MAX), sessionId))).toMatchObject({ code: "NOT_FOUND" });
    expect(await levelOf(w, OLA, sessionId)).toMatchObject({ level: "view", orgAdmin: true });
    // Everyone not named still has what they had.
    expect(await levelOf(w, MIA, sessionId)).toMatchObject({ level: "view" });
  });

  it("gives a commenter use and a viewer view, to people who are on no project", async () => {
    const w = sessionWorld();
    const commenter = w.seedSession({ people: [{ developerId: ZED, role: "commenter" }] });
    expect(await levelOf(w, ZED, commenter.sessionId)).toMatchObject({ level: "use", projectRole: undefined });
    const viewer = w.seedSession({ people: [{ developerId: ZED, role: "viewer" }] });
    expect(await levelOf(w, ZED, viewer.sessionId)).toMatchObject({ level: "view", projectRole: undefined });
    const none = w.seedSession({ people: [{ developerId: ARJUN, role: "viewer" }] });
    expect(await code(resolveSessionAccess(depsOf(w), w.caller(ZED), none.sessionId))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("follows the task's current owner after a take-over: they own it, and the first owner is one more project member", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession({ currentOwner: ARJUN });
    expect(await levelOf(w, ARJUN, sessionId)).toMatchObject({ level: "edit", owner: true });
    expect(await levelOf(w, PRIYA, sessionId)).toMatchObject({ level: "view", owner: false });
  });

  it("gives the Task People owner edit only while no one has taken the task over", async () => {
    const w = sessionWorld();
    const plain = w.seedSession({ people: [{ developerId: ZED, role: "owner" }] });
    expect(await levelOf(w, ZED, plain.sessionId)).toMatchObject({ level: "edit", owner: false });
    const taken = w.seedSession({ people: [{ developerId: ZED, role: "owner" }], currentOwner: ARJUN });
    expect(await code(resolveSessionAccess(depsOf(w), w.caller(ZED), taken.sessionId))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("treats a people record it can't read as a denial for everyone but an org admin and the owner's own session", async () => {
    const w = sessionWorld();
    const { sessionId, taskId } = w.seedSession();
    w.db.set({ pk: `DEVTASK#${taskId}`, sk: "PEOPLE", schemaVersion: 7, people: "garbled" });
    expect(await code(resolveSessionAccess(depsOf(w), w.caller(ARJUN), sessionId))).toMatchObject({ code: "NOT_FOUND" });
    expect(await levelOf(w, OLA, sessionId)).toMatchObject({ level: "view" });
  });
});

describe("the read-only path", () => {
  it("reads grants, shares and Task People with no call to the project members' Slack path", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession({ people: [{ developerId: ZED, role: "commenter" }] });
    w.seedShare(ORG_A, sessionId, { kind: "project", project: "ops" }, "use");
    w.grant(MIA, "ops", "contributor");
    const deps = depsOf(w, { projectMembers: { roleOf: () => { throw new Error("a Slack call on the read-only path"); } } });
    const read = async (who: string) => (await resolveSessionAccess(deps, w.caller(who), sessionId, { readOnlyPath: true })).level;
    expect(await read(PRIYA)).toBe("edit");
    expect(await read(ARJUN)).toBe("view");
    expect(await read(MAX)).toBe("edit");
    // A project share reaches a person only through a grant row or the channel, never an org admin's maintainership of every project (review I-2).
    expect(await read(OLA)).toBe("view");
    expect(await read(ZED)).toBe("use");
    expect(await read(MIA)).toBe("view");
  });

  it("finds nothing for a person who reaches the project only through its Slack channel, while the normal path does", async () => {
    const w = sessionWorld();
    const { sessionId } = w.seedSession();
    w.members.channel(ORG_A, "web", ZED);
    expect(await levelOf(w, ZED, sessionId)).toMatchObject({ level: "view" });
    expect(w.channelCalls.length).toBeGreaterThan(0);
    w.channelCalls.length = 0;
    const deps = depsOf(w);
    expect(await code(resolveSessionAccess(deps, w.caller(ZED), sessionId, { readOnlyPath: true }))).toMatchObject({ code: "NOT_FOUND" });
    expect(w.channelCalls).toEqual([]);
  });
});

describe("sessionActionsFor", () => {
  const actions = (level: "none" | "view" | "use" | "edit", extra: { owner?: boolean; orgAdmin?: boolean; projectRole?: "viewer" | "contributor" | "maintainer" } = {}, status: SessionStatus = "failed") =>
    sessionActionsFor({ level, owner: extra.owner ?? false, orgAdmin: extra.orgAdmin ?? false, ...(extra.projectRole === undefined ? {} : { projectRole: extra.projectRole }) }, { status });
  it("lists what each level may do", () => {
    expect(actions("none")).toEqual([]);
    expect(actions("view")).toEqual(["watch", "comment"]);
    expect(actions("use")).toEqual(["watch", "comment", "steer"]);
    expect(actions("edit")).toEqual(["watch", "comment", "steer", "stop", "retry", "take_over", "share"]);
    // QA6-11: the owner already owns the session, so Take over is not offered to them (and is to everyone else who can edit).
    expect(actions("edit", { owner: true })).toEqual(["watch", "comment", "steer", "stop", "retry", "share"]);
    // Moving a session between a Mac and the cloud is unfinished, so the owner is not offered it (owner decision 14); the switch is off.
    expect(OFFER_HANDOFF).toBe(false);
    expect(actions("view", { orgAdmin: true })).toEqual(["watch", "comment", "stop"]);
    expect(actions("edit", { orgAdmin: true })).toEqual(["watch", "comment", "steer", "stop", "retry", "take_over", "share"]);
  });

  it("offers retry only for a failed or cancelled session (13 review)", () => {
    for (const status of ["failed", "cancelled"] as const) expect(actions("edit", {}, status)).toContain("retry");
    for (const status of ["starting", "running", "needs_person", "paused", "waiting", "stopped", "succeeded"] as const) {
      expect(actions("edit", { owner: true }, status), status).not.toContain("retry");
      expect(actions("edit", { owner: true }, status), status).toEqual(expect.arrayContaining(["stop", "share"]));
      expect(actions("edit", { owner: true }, status), status).not.toContain("take_over");
    }
    // A lower level never gets it, whatever the status.
    expect(actions("use", {}, "failed")).not.toContain("retry");
  });

  it("offers retry for a blocked workflow too, only at edit and only when the summary says it is blocked (Task 14 ruling)", () => {
    const blocked = (level: "none" | "view" | "use" | "edit", extra: { owner?: boolean; projectRole?: "viewer" | "contributor" | "maintainer" } = {}, flagged = true) =>
      sessionActionsFor({ level, owner: extra.owner ?? false, orgAdmin: false, ...(extra.projectRole === undefined ? {} : { projectRole: extra.projectRole }) }, { status: "needs_person", ...(flagged ? { workflowBlocked: true as const } : {}) });
    expect(blocked("edit")).toContain("retry");
    expect(blocked("edit")).toEqual(["watch", "comment", "steer", "stop", "retry", "take_over", "share"]);
    expect(blocked("edit", {}, false)).not.toContain("retry");
    expect(blocked("use")).not.toContain("retry");
    expect(blocked("view")).not.toContain("retry");
    expect(blocked("edit", { projectRole: "viewer" })).toEqual(["watch"]);
    expect(blocked("edit", { owner: true, projectRole: "viewer" })).toContain("retry");
    // A stale flag on a session that is running or finished offers nothing; a paused one (budget pause on a blocked workflow) does.
    const flaggedAt = (status: SessionStatus) => sessionActionsFor({ level: "edit", owner: false, orgAdmin: false }, { status, workflowBlocked: true });
    for (const status of ["starting", "running", "waiting", "stopped", "succeeded"] as const) expect(flaggedAt(status), status).not.toContain("retry");
    expect(flaggedAt("paused")).toContain("retry");
  });

  it("gives a project viewer who isn't the owner only watching, and an owner who is a viewer everything", () => {
    expect(actions("use", { projectRole: "viewer" })).toEqual(["watch"]);
    expect(actions("edit", { projectRole: "viewer" })).toEqual(["watch"]);
    expect(actions("edit", { owner: true, projectRole: "viewer" })).toContain("stop");
  });
});
