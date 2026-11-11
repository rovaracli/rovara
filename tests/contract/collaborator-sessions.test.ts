// Decision 103 (collaborator role, W11): a project collaborator may comment on a task's session and its page, and use the live Ask (on the Ask's own rates, the same for everyone); a viewer still may not.
// Both are explicit permissions of Cloud's table (`comment`, `ask`), asked of the member's EXACT role in agent-sessions/access.ts and the Ask. A collaborator gets nothing else above a viewer: no steering,
// stopping, sharing, starting work or agents.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ASK_RATE, projectMemberKey, type AgentSessionRecord } from "@rovara-code/contracts";
import { sendSessionMessage, type SessionMessageDependencies } from "../../packages/broker/src/agent-sessions/messages.js";
import { memberMay, requireSessionLevel, resolveSessionAccess, sessionActionsFor, sessionAskLevelOf } from "../../packages/broker/src/agent-sessions/access.js";
import { submitAsk, type AskDependencies } from "../../packages/broker/src/agent-sessions/ask.js";
import { mayComment, pageAccess } from "../../packages/broker/src/developer/task-access.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { MIA, ORG_A, PRIYA, ZED, sessionWorld } from "../support/agent-session-world.js";

// Zed is a member of org A with no project role in sessionWorld; here he is made a collaborator on `web` (the grant row a collaborator has: role viewer, projectRole collaborator).
function world() {
  const w = sessionWorld();
  w.db.set({ ...projectMemberKey(ORG_A, ZED, "web"), entityType: "MEMBERSHIP", ownerKey: ZED, projectName: "web", grantId: randomUUID(), role: "viewer", projectRole: "collaborator", grantedBy: { developerId: PRIYA } });
  const made = w.seedSession({ kind: "task", owner: PRIYA });
  w.db.set({ ...w.db.get({ pk: `DEVTASK#${made.taskId}`, sk: "META" })!, title: "Bump the Stripe SDK", workflow: { revision: 1, stage: "IMPLEMENT", state: "RUNNING", artifacts: [], decisions: [], pullRequests: [], checkPolicy: { required: [], optional: [], selectedOptionalIds: [] } } });
  const access = { documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members };
  const sent: unknown[] = [];
  const audit = capturingAuditDeps({ db: w.db, now: () => w.clock.now });
  const askDeps: AskDependencies = {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, edition: "enterprise", enabled: true, queue: { send: async (message) => { sent.push(message); } },
    access, actions: { readArtifact: async () => { throw new Error("no document"); } } as never, readers: { diff: vi.fn(async () => undefined) },
    store: () => ({ documentClient: w.db, tableName: "state", questionHashKey: "k".repeat(48), isErased: async () => false, erasedPeople: async () => [] }),
    audit: { ...audit.deps, documentClient: w.db, tableName: "state" }, people: async () => [], orchestratorInstructions: async () => "Be brief.", defaultModel: "chat-runtime",
  };
  const messageDeps: SessionMessageDependencies = { documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, log: () => undefined };
  const ask = (who: string, requestId = randomUUID()) => submitAsk(askDeps, w.caller(who), made.sessionId, { requestId, question: "Why did it change the retry logic?" });
  const comment = (who: string) => sendSessionMessage(messageDeps, w.caller(who), made.sessionId, { requestId: randomUUID(), kind: "comment", text: "Looks right to me" } as never);
  return { w, made, access, ask, comment, sent };
}

describe("comments on a session (decision 103)", () => {
  it("lets a collaborator comment, and still refuses a viewer", async () => {
    const t = world();
    expect((await t.comment(ZED)).author).toMatchObject({ developerId: ZED });
    await expect(t.comment(MIA)).rejects.toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
  });

  it("offers a collaborator watch and comment and nothing more; a viewer only watch", async () => {
    const t = world();
    const collaborator = await resolveSessionAccess(t.access, t.w.caller(ZED), t.made.sessionId);
    const viewer = await resolveSessionAccess(t.access, t.w.caller(MIA), t.made.sessionId);
    expect(collaborator).toMatchObject({ level: "view", projectRole: "viewer", memberRole: "collaborator" });
    expect(sessionActionsFor(collaborator, { status: "running" })).toEqual(["watch", "comment"]);
    expect(sessionActionsFor(viewer, { status: "running" })).toEqual(["watch"]);
  });

  it("never lets a collaborator steer, stop, share or take any other step above a viewer", async () => {
    const t = world();
    await expect(requireSessionLevel(t.access, t.w.caller(ZED), t.made.sessionId, "use", "send messages to the agent")).rejects.toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
    await expect(requireSessionLevel(t.access, t.w.caller(ZED), t.made.sessionId, "edit", "stop it")).rejects.toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
    await expect(sendSessionMessage({ documentClient: t.w.db, tableName: "state", now: () => t.w.clock.now, projectMembers: t.w.members, log: () => undefined }, t.w.caller(ZED), t.made.sessionId, { requestId: randomUUID(), kind: "steer", text: "Do it differently" } as never))
      .rejects.toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
  });

  it("asks the permission table, not the role's name: comment and ask come from the exact role's row", () => {
    expect(memberMay({ memberRole: "collaborator" }, "view", { comment: true })).toBe(true);
    expect(memberMay({ memberRole: "collaborator" }, "use", { ask: true })).toBe(true);
    expect(memberMay({ memberRole: "viewer" }, "view", { comment: true })).toBe(false);
    expect(memberMay({ memberRole: "viewer" }, "use", { ask: true })).toBe(false);
    // Neither opens anything else: not a steer (use without ask), not an edit.
    expect(memberMay({ memberRole: "collaborator" }, "use", {})).toBe(false);
    expect(memberMay({ memberRole: "collaborator" }, "edit", { comment: true, ask: true })).toBe(false);
    expect(memberMay({}, "view", { comment: true })).toBe(false);
  });
});

describe("the live Ask (decision 103)", () => {
  it("lets a collaborator ask and refuses a viewer, writing nothing for the viewer", async () => {
    const t = world();
    expect((await t.ask(ZED)).state).toBe("queued");
    const sentBefore = t.sent.length;
    await expect(t.ask(MIA)).rejects.toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
    expect(t.sent).toHaveLength(sentBefore);
  });

  it("re-reads the collaborator's standing when the service answers: the Ask's level is use for a collaborator, view for a viewer", async () => {
    const t = world();
    const session = t.made.record as unknown as AgentSessionRecord;
    expect(await sessionAskLevelOf(t.access, t.w.caller(ZED), session)).toBe("use");
    expect(await sessionAskLevelOf(t.access, t.w.caller(MIA), session)).toBe("view");
    // A collaborator removed from the project asks nothing more.
    t.w.db.delete(projectMemberKey(ORG_A, ZED, "web") as never);
    expect(await sessionAskLevelOf(t.access, t.w.caller(ZED), session)).not.toBe("use");
  });

  it("spends the same rates as anyone's Ask: the collaborator's 21st Ask in an hour is refused and queues nothing", async () => {
    const t = world();
    for (let index = 0; index < ASK_RATE.perPersonPerHour; index += 1) {
      expect((await t.ask(ZED)).state).toBe("queued");
      // The one-at-a-time lock: the earlier Ask is answered before the next one.
      for (const item of t.w.db.find((row) => String(row.sk).startsWith("ASK_LOCK") || String(row.sk).includes("LOCK#"))) t.w.db.delete({ pk: item.pk, sk: item.sk } as never);
    }
    const sentBefore = t.sent.length;
    await expect(t.ask(ZED)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(t.sent).toHaveLength(sentBefore);
  });
});

describe("comments on a task page (decision 103)", () => {
  const task = { taskId: randomUUID(), project: "web", orgId: ORG_A, status: "RUNNING" } as unknown as DeveloperTaskRecord;
  it("lets a viewer-floor member comment only when their exact role has the comment permission, and never through a session-only reading", () => {
    expect(mayComment({ role: "viewer", memberRole: "collaborator" })).toBe(true);
    expect(mayComment({ role: "viewer", memberRole: "viewer" })).toBe(false);
    expect(mayComment({ role: "viewer" })).toBe(false);
    expect(mayComment({ role: "viewer", source: "session", memberRole: "collaborator" })).toBe(false);
    // A collaborator is offered commenting and nothing else (no suggesting, deciding or asking AgentX).
    expect(pageAccess({ task, role: "viewer", memberRole: "collaborator", ownerActorIds: [] })).toMatchObject({ canComment: true, canSuggest: false, canDecide: false, canAsk: false });
    expect(pageAccess({ task, role: "viewer", ownerActorIds: [] })).toMatchObject({ canComment: false });
  });
});
