// Plan 5 Task 5: reading a session, its sections and its link. Every read goes through the session level (a person who can't view a session gets
// NOT_FOUND and never learns it exists); the body is the task's own view built for the reader; a chain step's task needs a project role; the link
// `/s/<id>` takes a task session's viewer to the task page, which now admits them to read only. Tasks started before sessions get one lazily.
// The first part runs the read functions over a small fake company; the second goes through the real broker (routes, wiring, the task page).
import { chainRunViewOf } from "../support/chain-run-view.js";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type * as BrokerModule from "../../packages/broker/src/aws/broker.js";
import { LIVE_INDEX_SCAN_MAX, agentXError, agentSessionKey, liveSessionKey, mySessionsKey, openAgentSessionKey, projectSessionsKey, sessionBindingKey, sharedSessionsKey, type OrgId } from "../../packages/contracts/src/index.js";
import {
  NeedsConfirmationSchema,
  SessionListReaderSchema,
  SessionListSchema,
  SessionResponseReaderSchema,
  SessionResponseSchema,
  SessionShareDeleteResponseSchema,
  SessionSharePutResponseSchema,
  SessionSharesResponseSchema,
  SessionStepTaskResponseSchema,
  SessionViewSchema,
} from "../../packages/contracts/src/index.js";
import { createTaskSessionItems, ensureTaskSession } from "../../packages/broker/src/agent-sessions/create.js";
import { newSessionRoleMemo, requireSessionLevel } from "../../packages/broker/src/agent-sessions/access.js";
import { listSessions, sessionStepTask, sessionView, type SessionReadDependencies } from "../../packages/broker/src/agent-sessions/read.js";
import { isAgentSessionRoute } from "../../packages/broker/src/agent-sessions/routes.js";
import { AgentSessionStore } from "../../packages/broker/src/agent-sessions/store.js";
import { createWriteApprovalRecord, getApprovalSubjectHandler, getApproverRule, type WriteApprovalRecord } from "../../packages/broker/src/agents/approvals.js";
import { can, resolveTaskAccess } from "../../packages/broker/src/developer/task-access.js";
import { mayDecideSpendRequest } from "../../packages/broker/src/spend/requests.js";
import { spendRequestKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { DEV_ISSUER, MAYA, OMAR, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import { ARJUN, BO, CELL, MAX, MIA, OLA, ORG_A, ORG_B, PRIYA, ZED, sessionWorld, type SessionWorld } from "../support/agent-session-world.js";

const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));
/** A route's answer without the envelope's request id. */
const bodyOf = (reply: { body: Record<string, unknown> }) => { const { requestId: _id, ...rest } = reply.body; return rest; }; // eslint-disable-line @typescript-eslint/no-unused-vars -- dropped on purpose
const PLACEHOLDER_SPEND = "spr_0123456789abcdefghij";

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Part 1: the read functions over a fake company (Priya owns; Arjun and Mia are contributor and viewer on web; Max maintains it; Zed has no role)
// ---------------------------------------------------------------------------------------------------------------------------------------------

interface ViewCall { taskId: string; options: { events: number; details: boolean; actor?: "owner" | "viewer" } }

const taskViewOf = (task: { taskId: string; project: string }, extra: Record<string, unknown> = {}) => ({
  taskId: task.taskId, title: "Bump the Stripe SDK", project: task.project, status: "RUNNING", startingRevision: 1, client: "test", shared: false,
  createdAt: "2026-10-22T08:00:00.000Z", updatedAt: "2026-10-22T08:05:00.000Z", events: [], ...extra,
});

function readWorld(extra: Partial<SessionReadDependencies> = {}, viewExtra: Record<string, unknown> = {}) {
  const w = sessionWorld();
  const calls: ViewCall[] = [];
  const deps: SessionReadDependencies = {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: CELL, cursorKey: "k".repeat(64),
    taskView: async (task, options) => {
      calls.push({ taskId: task.taskId, options });
      return taskViewOf(task, viewExtra) as never;
    },
    ...extra,
  };
  /** Writes the index rows a start writes for a session, and optionally changes its creation time. */
  const index = (sessionId: string, createdAt?: string) => {
    const meta = w.db.get(agentSessionKey(ORG_A, sessionId, "META"))!;
    const created = createdAt ?? String(meta.createdAt);
    w.db.set({ ...meta, createdAt: created });
    const owner = (meta.owner as { developerId: string }).developerId;
    w.db.set({ ...mySessionsKey(ORG_A, owner, created, sessionId), entityType: "MY_SESSION", orgId: ORG_A, sessionId, developerId: owner, createdAt: created });
    if (meta.project !== undefined) w.db.set({ ...projectSessionsKey(ORG_A, (meta.project as string), created, sessionId), entityType: "PROJECT_SESSION", orgId: ORG_A, sessionId, project: meta.project, createdAt: created });
  };
  const shareWith = (sessionId: string, developerId: string, level: "view" | "use" | "edit" = "view") => {
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId }, level);
    w.db.set({ ...sharedSessionsKey(ORG_A, { kind: "member", developerId }, sessionId), entityType: "SHARED_SESSION", orgId: ORG_A, sessionId, principal: { kind: "member", developerId }, level, sharedAt: "2026-10-22T08:10:00.000Z" });
  };
  const patch = (sessionId: string, fields: Record<string, unknown>) => w.db.set({ ...w.db.get(agentSessionKey(ORG_A, sessionId, "META"))!, ...fields });
  return { w, deps, calls, index, shareWith, patch };
}
const view = (r: ReturnType<typeof readWorld>, who: string, sessionId: string, orgId: OrgId = ORG_A) => sessionView(r.deps, { ...r.w.caller(who, orgId) }, sessionId);

describe("reading a task session", () => {
  it("shows the owner the task as the owner sees it, with what they may do, and parses with its schemas", async () => {
    const r = readWorld();
    const { sessionId, taskId } = r.w.seedSession();
    const session = await view(r, PRIYA, sessionId);
    expect(SessionViewSchema.parse(session)).toEqual(session);
    expect(SessionResponseReaderSchema.safeParse({ session }).success).toBe(true);
    expect(r.calls).toEqual([{ taskId, options: { events: 20, details: true, actor: "owner" } }]);
    expect(session).toMatchObject({
      contractVersion: 1, sessionId, kind: "task", mode: "delegate", title: "Bump the Stripe SDK", project: "web", owner: { developerId: PRIYA, name: "Priya" },
      where: { kind: "cloud" }, link: `${CELL}/s/${sessionId}`, body: { kind: "task", task: { taskId } }, approvals: [], viewingNow: [], bindings: [],
      you: { level: "edit", owner: true, following: true }, followers: 0, revision: 1,
    });
    expect(session.you.actions).toEqual(["watch", "comment", "steer", "stop", "take_over", "share", "handoff", "close"]);
  });

  it("offers retry only once the session has failed or been cancelled (13 review)", async () => {
    const r = readWorld();
    const { sessionId, record } = r.w.seedSession();
    const meta = r.w.db.get(agentSessionKey(ORG_A, sessionId, "META")) as Record<string, unknown>;
    for (const [status, offered] of [["running", false], ["succeeded", false], ["failed", true], ["cancelled", true]] as const) {
      r.w.db.set({ ...meta, summaryRevision: 2, summary: { ...record.summary, status } });
      expect((await view(r, PRIYA, sessionId)).you.actions.includes("retry"), status).toBe(offered);
    }
  });

  it("offers retry on a blocked workflow, which shows as needing a person, to the owner and not to a sharee (Task 14 ruling)", async () => {
    const r = readWorld();
    const { sessionId, record } = r.w.seedSession();
    const meta = r.w.db.get(agentSessionKey(ORG_A, sessionId, "META")) as Record<string, unknown>;
    r.w.db.set({ ...meta, summaryRevision: 2, summary: { ...record.summary, status: "needs_person", workflowBlocked: true } });
    expect((await view(r, PRIYA, sessionId)).you.actions).toContain("retry");
    r.w.db.set({ ...meta, summaryRevision: 3, summary: { ...record.summary, status: "needs_person" } });
    expect((await view(r, PRIYA, sessionId)).you.actions).not.toContain("retry");
    r.w.db.set({ ...meta, summaryRevision: 4, summary: { ...record.summary, status: "needs_person", workflowBlocked: true } });
    r.shareWith(sessionId, ZED);
    expect((await view(r, ZED, sessionId)).you.actions).not.toContain("retry");
  });

  it("builds a sharee's view with the viewer's presentation, and gives them watch and comment only", async () => {
    const r = readWorld();
    const { sessionId } = r.w.seedSession();
    r.shareWith(sessionId, ZED);
    const session = await view(r, ZED, sessionId);
    expect(r.calls.map((call) => call.options.actor)).toEqual(["viewer"]);
    expect(session.you).toEqual({ level: "view", owner: false, following: false, actions: ["watch", "comment"] });
    // A project contributor who owns nothing reads it as a viewer too.
    await view(r, ARJUN, sessionId);
    expect(r.calls.map((call) => call.options.actor)).toEqual(["viewer", "viewer"]);
    // The effective owner after a take-over is the owner of the view.
    const taken = r.w.seedSession({ currentOwner: ARJUN });
    await view(r, ARJUN, taken.sessionId);
    expect(r.calls.at(-1)?.options.actor).toBe("owner");
  });

  it("answers NOT_FOUND to another org, to someone with no level, and when the task belongs to another org, and builds nothing", async () => {
    const r = readWorld();
    const { sessionId } = r.w.seedSession();
    expect(await code(view(r, BO, sessionId, ORG_B))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(view(r, ZED, sessionId))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(view(r, PRIYA, "ses_00000000000000009999"))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(view(r, PRIYA, "not-an-id"))).toMatchObject({ code: "NOT_FOUND" });
    const foreignTask = r.w.seedSession({ taskOrgId: ORG_B });
    expect(await code(view(r, PRIYA, foreignTask.sessionId))).toMatchObject({ code: "NOT_FOUND" });
    expect(r.calls).toEqual([]);
  });

  it("says a project viewer owns nothing and may only watch", async () => {
    const r = readWorld();
    const { sessionId } = r.w.seedSession();
    expect((await view(r, MIA, sessionId)).you).toMatchObject({ level: "view", actions: ["watch"] });
  });

  it("takes status, step and cost from the summary once the projector has computed one, and from the task before that", async () => {
    const r = readWorld({}, { status: "SUCCEEDED" });
    const fresh = r.w.seedSession();
    // The stored summary is the placeholder the start wrote (revision 1): the task says where it is.
    expect(await view(r, PRIYA, fresh.sessionId)).toMatchObject({ status: "succeeded", cost: { spentUsd: 0 } });
    const computed = r.w.seedSession();
    r.patch(computed.sessionId, {
      summaryRevision: 3, summary: { status: "needs_person", step: "Waiting for the plan", peek: "npm test", costUsd: 2.5, runLimitUsd: 10, stopAtUsd: 8, lastRunFailed: true, needsPeople: [], pendingApprovals: 0, digest: "d".repeat(64), computedAt: "2026-10-22T08:20:00.000Z" },
    });
    expect(await view(r, PRIYA, computed.sessionId)).toMatchObject({
      status: "needs_person", step: "Waiting for the plan", peek: "npm test", lastRunFailed: true, cost: { spentUsd: 2.5, runLimitUsd: 10, stopAtUsd: 8 },
    });
    const paused = readWorld({}, { status: "RUNNING", paused: { reason: "budget", scope: { kind: "task" } } });
    const pausedSession = paused.w.seedSession();
    expect((await view(paused, PRIYA, pausedSession.sessionId)).status).toBe("paused");
    const failed = readWorld({}, { status: "FAILED" });
    expect((await view(failed, PRIYA, failed.w.seedSession().sessionId)).status).toBe("failed");
    const cancelled = readWorld({}, { status: "CANCELLED" });
    expect((await view(cancelled, PRIYA, cancelled.w.seedSession().sessionId)).status).toBe("cancelled");
    const starting = readWorld({}, { status: "STARTING" });
    expect((await view(starting, PRIYA, starting.w.seedSession().sessionId)).status).toBe("starting");
  });

  it("takes the run limit and the stop point from the task until the summary is computed", async () => {
    const r = readWorld();
    const { sessionId, taskId } = r.w.seedSession();
    r.w.db.set({ ...r.w.db.get(taskKey(taskId))!, budgetUsd: 10, maxPerRunUsd: 4 });
    expect((await view(r, PRIYA, sessionId)).cost).toMatchObject({ runLimitUsd: 10, stopAtUsd: 4 });
    r.w.db.set({ ...r.w.db.get(taskKey(taskId))!, budgetUsd: 10, maxPerRunUsd: 40 });
    expect((await view(r, PRIYA, sessionId)).cost).toMatchObject({ runLimitUsd: 10, stopAtUsd: 10 });
    r.w.db.set({ ...r.w.db.get(taskKey(taskId))!, budgetUsd: undefined, maxPerRunUsd: undefined });
    expect((await view(r, PRIYA, sessionId)).cost).not.toHaveProperty("runLimitUsd");
  });

  it("names who pays, and shows the budget link only to a person who may decide it", async () => {
    const decide = new Set<string>();
    const r = readWorld(
      { deciding: { approvals: async () => [], spend: async (who, id) => decide.has(`${who.developerId}|${id}`) } },
      { status: "RUNNING", paused: { reason: "budget", scope: { kind: "task", taskId: "x" }, spendRequestId: PLACEHOLDER_SPEND } },
    );
    const { sessionId } = r.w.seedSession();
    r.shareWith(sessionId, ZED);
    r.patch(sessionId, { payer: { kind: "project", project: "web" } });
    decide.add(`${PRIYA}|${PLACEHOLDER_SPEND}`);
    const owner = await view(r, PRIYA, sessionId);
    expect(owner.cost.payer).toEqual({ kind: "project", name: "web" });
    expect(owner.cost.paused).toEqual({ scope: "task", spendRequestId: PLACEHOLDER_SPEND, confirmUrl: `${CELL}/v1/app/approve/${PLACEHOLDER_SPEND}` });
    const sharee = await view(r, ZED, sessionId);
    expect(sharee.cost.paused).toEqual({ scope: "task", spendRequestId: PLACEHOLDER_SPEND });
    expect(JSON.stringify(sharee)).not.toContain("/v1/app/approve/");
    r.patch(sessionId, { payer: { kind: "member", developerId: PRIYA } });
    expect((await view(r, PRIYA, sessionId)).cost.payer).toEqual({ kind: "member", name: "Priya" });
    r.patch(sessionId, { payer: { kind: "agent", agentId: "agt_0123456789abcdefghij" }, agent: { agentId: "agt_0123456789abcdefghij", name: "Triage bot", version: 2 } });
    expect((await view(r, PRIYA, sessionId)).cost.payer).toEqual({ kind: "agent", name: "Triage bot" });
  });

  it("lists the caller's own pending decisions with bare links, and strips the links of a decision they can't make from the task's own view", async () => {
    const pending = { approvalId: "apr_0123456789abcdefghij", kind: "write", text: "Create a Linear issue", confirmUrl: `${CELL}/v1/app/approve/apr_0123456789abcdefghij` };
    const other = { approvalId: "apr_abcdefghij0123456789", kind: "step", text: "Approve the step", confirmUrl: `${CELL}/v1/app/approve/apr_abcdefghij0123456789` };
    const r = readWorld(
      { deciding: { approvals: async (who) => (who.developerId === PRIYA ? [{ approvalId: pending.approvalId, title: "Create a Linear issue" }] : []), spend: async () => false } },
      { run: { state: "WAITING_FOR_APPROVAL", steps: [], pendingApprovals: [pending, other] } },
    );
    const { sessionId } = r.w.seedSession();
    r.shareWith(sessionId, ZED);
    const owner = await view(r, PRIYA, sessionId);
    expect(owner.approvals).toEqual([{ approvalId: pending.approvalId, title: "Create a Linear issue", confirmUrl: pending.confirmUrl }]);
    const ownerApprovals = (owner.body as unknown as { task: { run: { pendingApprovals: Array<{ approvalId: string; confirmUrl?: string }> } } }).task.run.pendingApprovals;
    expect(ownerApprovals.find((entry) => entry.approvalId === pending.approvalId)?.confirmUrl).toBe(pending.confirmUrl);
    expect(ownerApprovals.find((entry) => entry.approvalId === other.approvalId)?.confirmUrl).toBeUndefined();
    const sharee = await view(r, ZED, sessionId);
    expect(sharee.approvals).toEqual([]);
    expect(JSON.stringify(sharee)).not.toContain("/v1/app/approve/");
    expect(JSON.stringify(owner)).not.toContain("\"arguments\"");
  });

  it("shows followers, whether the caller follows, and the session's outside bindings", async () => {
    const r = readWorld();
    const { sessionId } = r.w.seedSession();
    r.patch(sessionId, { followerCount: 3 });
    r.w.follower(ORG_A, sessionId, ARJUN);
    r.w.db.set({
      ...sessionBindingKey(ORG_A, sessionId, "slack_thread"), entityType: "AGENT_SESSION_BINDING", orgId: ORG_A, sessionId,
      binding: { kind: "slack_thread", teamId: "T0123ABC", channelId: "C0123ABC", threadTs: "1760000000.123456" }, at: "2026-10-22T08:00:00.000Z",
    });
    r.w.db.set({
      ...sessionBindingKey(ORG_A, sessionId, "linear_issue"), entityType: "AGENT_SESSION_BINDING", orgId: ORG_A, sessionId,
      binding: { kind: "linear_issue", issueId: "ENG-1", url: "https://linear.app/acme/issue/ENG-1" }, at: "2026-10-22T08:00:00.000Z",
    });
    const asArjun = await view(r, ARJUN, sessionId);
    expect(asArjun).toMatchObject({ followers: 3, you: { following: true } });
    expect((await view(r, PRIYA, sessionId)).you.following).toBe(true); // the effective owner always follows, with no item (Task 9)
    expect(asArjun.bindings).toEqual([
      { kind: "slack_thread", url: "https://app.slack.com/client/T0123ABC/C0123ABC/thread/C0123ABC-1760000000.123456" },
      { kind: "linear_issue", url: "https://linear.app/acme/issue/ENG-1" },
    ]);
  });
});

describe("a taken-over session names its effective owner (review m-4)", () => {
  it("shows the taker as the owner in the header and in the tile, and the previous owner as someone who doesn't own it", async () => {
    const r = readWorld();
    const { sessionId } = r.w.seedSession({ currentOwner: ARJUN });
    r.index(sessionId);
    const seen = await view(r, PRIYA, sessionId);
    expect(seen.owner).toEqual({ developerId: ARJUN, name: "Arjun" });
    expect(seen.you).toMatchObject({ owner: false });
    expect((await view(r, ARJUN, sessionId)).owner).toEqual({ developerId: ARJUN, name: "Arjun" });
    expect((await view(r, ARJUN, sessionId)).you.owner).toBe(true);
    // The list's tile names the taker too.
    expect((await listSessions(r.deps, r.w.caller(PRIYA), { owner: "me" })).sessions.find((tile) => tile.sessionId === sessionId)?.owner).toEqual({ developerId: ARJUN, name: "Arjun" });
    // A session nobody took over keeps its own owner.
    const plain = r.w.seedSession();
    expect((await view(r, ARJUN, plain.sessionId)).owner).toEqual({ developerId: PRIYA, name: "Priya" });
  });

  it("tells a person who needs more to ask the effective owner, not the one who handed it over", async () => {
    const r = readWorld();
    const { sessionId } = r.w.seedSession({ currentOwner: ARJUN });
    const refused = await code(requireSessionLevel(r.deps, r.w.caller(PRIYA), sessionId, "edit", "stop it"));
    expect(refused).toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
    expect(refused?.message).toContain("Ask Arjun to share it with you");
    expect(refused?.message).not.toContain("Priya");
    // The same text for a session nobody took over names its owner.
    const plain = r.w.seedSession();
    expect((await code(requireSessionLevel(r.deps, r.w.caller(ARJUN), plain.sessionId, "edit", "stop it")))?.message).toContain("Ask Priya to share it with you");
  });

  it("keeps a session whose taker has no recorded name readable: a fixed fallback names them and authority stays by id (ruling on 12a question 1)", async () => {
    const r = readWorld();
    const { sessionId, taskId } = r.w.seedSession({ currentOwner: ARJUN });
    const { name: _name, ...taker } = (r.w.db.get(taskKey(taskId)) as { currentOwner: Record<string, unknown> }).currentOwner; // eslint-disable-line @typescript-eslint/no-unused-vars -- removed on purpose
    r.w.db.set({ ...r.w.db.get(taskKey(taskId))!, currentOwner: taker });
    r.index(sessionId);
    const priyaSees = await view(r, PRIYA, sessionId);
    expect(priyaSees.owner).toEqual({ developerId: ARJUN, name: "a member" });
    expect(priyaSees.you).toMatchObject({ owner: false });
    const arjunSees = await view(r, ARJUN, sessionId);
    expect(arjunSees.owner).toEqual({ developerId: ARJUN, name: "a member" });
    expect(arjunSees.you.owner).toBe(true);
    // Whoever needs more is told to ask the fallback, never the person who handed the session over.
    const refused = await code(requireSessionLevel(r.deps, r.w.caller(PRIYA), sessionId, "edit", "stop it"));
    expect(refused).toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
    expect(refused?.message).toContain("Ask a member to share it with you");
    expect(refused?.message).not.toContain("Priya");
    // The list shows the session, still the taker's.
    const tiles = (await listSessions(r.deps, r.w.caller(PRIYA), { owner: "me" })).sessions;
    expect(tiles.find((tile) => tile.sessionId === sessionId)?.owner).toEqual({ developerId: ARJUN, name: "a member" });
  });

  it("still refuses a session whose taker's id can't be read: that is an owner nobody can name (Task 12a)", async () => {
    const r = readWorld();
    const { sessionId, taskId } = r.w.seedSession({ currentOwner: ARJUN });
    const stored = r.w.db.get(taskKey(taskId)) as { currentOwner: Record<string, unknown> };
    r.w.db.set({ ...r.w.db.get(taskKey(taskId))!, currentOwner: { ...stored.currentOwner, developerId: "" } });
    expect(await code(view(r, PRIYA, sessionId))).toMatchObject({ code: "TASK_ACCESS_DENIED" });
    expect(await code(view(r, ARJUN, sessionId))).toMatchObject({ code: "TASK_ACCESS_DENIED" });
    expect((await code(requireSessionLevel(r.deps, r.w.caller(PRIYA), sessionId, "edit", "stop it")))?.code).toBe("TASK_ACCESS_DENIED");
    // The list leaves the session out rather than fail, and still lists the others.
    const plain = r.w.seedSession();
    r.index(sessionId);
    r.index(plain.sessionId);
    const tiles = (await listSessions(r.deps, r.w.caller(PRIYA), { owner: "me" })).sessions.map((tile) => tile.sessionId);
    expect(tiles).toContain(plain.sessionId);
    expect(tiles).not.toContain(sessionId);
  });
});

describe("who may press Merge, for a viewer whose level alone would hide the button (C59 minor)", () => {
  it("tells an org admin with no share that they may press, and nobody else at view level", async () => {
    const r = readWorld();
    const { sessionId } = r.w.seedSession();
    // The owner presses with `edit`; the page needs nothing more for them.
    expect((await view(r, PRIYA, sessionId)).you).not.toHaveProperty("mayMerge");
    // An org admin who was given no share reads the task at view level, and the server lets them press Merge (pressMerge: owner, maintainer of the project, or org admin).
    const admin = await view(r, OLA, sessionId);
    expect(admin.you.level).toBe("view");
    expect(admin.you).toMatchObject({ mayMerge: true });
    // A contributor or a viewer of the project who is neither the owner nor a maintainer is refused by the server, so the page is not told they may.
    r.shareWith(sessionId, MIA);
    expect((await view(r, MIA, sessionId)).you).not.toHaveProperty("mayMerge");
    r.shareWith(sessionId, ARJUN);
    expect((await view(r, ARJUN, sessionId)).you).not.toHaveProperty("mayMerge");
  });
});

describe("reading a local session", () => {
  it("shows the tool and whether the Mac is offline, and only to the owner and the people it was shared with", async () => {
    const r = readWorld();
    const { sessionId } = r.w.seedSession({ kind: "local" });
    r.patch(sessionId, { summaryRevision: 2, summary: { status: "running", costUsd: 0, needsPeople: [], pendingApprovals: 0, offline: true, digest: "d".repeat(64), computedAt: "2026-10-22T08:20:00.000Z" } });
    const owner = await view(r, PRIYA, sessionId);
    expect(owner).toMatchObject({ kind: "local", where: { kind: "mac", label: "Priya's MacBook", offline: true }, body: { kind: "local", tool: "claude-code" }, status: "running" });
    expect(owner.cost.payer).toEqual({ kind: "member", name: "Priya" });
    expect(r.calls).toEqual([]);
    expect(await code(view(r, ARJUN, sessionId))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(view(r, OLA, sessionId))).toMatchObject({ code: "NOT_FOUND" });
    r.shareWith(sessionId, ARJUN);
    expect((await view(r, ARJUN, sessionId)).you.level).toBe("view");
  });
});

// ---- chain sessions: Plan 4's reads, behind a seam

function chainWorld() {
  const seen: Array<{ method: string; actor: unknown; id: string; seq?: number }> = [];
  const r = readWorld({
    chain: {
      runView: async (actor, runId) => { seen.push({ method: "runView", actor, id: runId }); return chainRunViewOf(runId, { sections: [{ seq: 1, stepId: "investigate", name: "investigate", kind: "agent", status: "succeeded", attempt: 1, startedAt: "2026-10-22T09:00:00.000Z" }, { seq: 2, stepId: "fix", name: "fix", kind: "agent", status: "running", attempt: 1, startedAt: "2026-10-22T09:05:00.000Z" }] }); },
      stepTask: async (actor, runId, seq) => { seen.push({ method: "stepTask", actor, id: runId, seq }); return taskViewOf({ taskId: randomUUID(), project: "web" }) as never; },
    },
    chainReadAccess: async (who) => who.developerId === ARJUN || who.developerId === MAX,
  });
  return { ...r, seen };
}

describe("reading a chain session", () => {
  it("gives the body Plan 4's run view through the internal session actor", async () => {
    const r = chainWorld();
    const { sessionId } = r.w.seedSession({ kind: "chain" });
    const session = await view(r, ARJUN, sessionId);
    expect(session.body).toMatchObject({ kind: "chain", chain: { sessionId, status: "running", sections: [{ seq: 1 }, { seq: 2 }] } });
    expect(SessionViewSchema.safeParse(session).success).toBe(true);
    expect(r.seen).toEqual([{ method: "runView", actor: { kind: "session", developerId: ARJUN }, id: sessionId }]);
    expect(r.calls).toEqual([]);
  });

  it("is refused, not guessed, when Plan 4's reads aren't wired", async () => {
    const r = readWorld({ chainReadAccess: async () => true });
    const { sessionId } = r.w.seedSession({ kind: "chain" });
    expect(await code(view(r, ARJUN, sessionId))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("answers a sharee with no project role 200 on the session and NOT_FOUND on a step's task, and a contributor sharee the task", async () => {
    const r = chainWorld();
    const { sessionId } = r.w.seedSession({ kind: "chain" });
    r.shareWith(sessionId, ZED);
    expect((await view(r, ZED, sessionId)).you.level).toBe("view");
    expect(await code(sessionStepTask(r.deps, r.w.caller(ZED), sessionId, 2))).toMatchObject({ code: "NOT_FOUND" });
    // Arjun reads the chain (view) and is a contributor on web: he gets the step's task.
    const step = await sessionStepTask(r.deps, r.w.caller(ARJUN), sessionId, 2);
    expect(SessionStepTaskResponseSchema.safeParse(step).success).toBe(true);
    expect(r.seen.filter((entry) => entry.method === "stepTask")).toEqual([{ method: "stepTask", actor: { kind: "session", developerId: ARJUN }, id: sessionId, seq: 2 }]);
    // A project viewer reads the chain too but can't start tasks there, so the step's task is not theirs.
    r.shareWith(sessionId, MIA);
    expect(await code(sessionStepTask(r.deps, r.w.caller(MIA), sessionId, 2))).toMatchObject({ code: "NOT_FOUND" });
    // An org admin's maintainership counts as a project role, and a share is enough for the level.
    r.shareWith(sessionId, OLA);
    expect((await sessionStepTask(r.deps, r.w.caller(OLA), sessionId, 1)).task.project).toBe("web");
  });

  it("is NOT_FOUND for another org, for a task session, for a bad step number, and without Plan 4's reads", async () => {
    const r = chainWorld();
    const { sessionId } = r.w.seedSession({ kind: "chain" });
    expect(await code(sessionStepTask(r.deps, r.w.caller(BO, ORG_B), sessionId, 1))).toMatchObject({ code: "NOT_FOUND" });
    const task = r.w.seedSession();
    expect(await code(sessionStepTask(r.deps, r.w.caller(PRIYA), task.sessionId, 1))).toMatchObject({ code: "NOT_FOUND" });
    for (const seq of [0, -1, 1.5, 100_000, Number.NaN]) expect(await code(sessionStepTask(r.deps, r.w.caller(ARJUN), sessionId, seq)), String(seq)).toMatchObject({ code: "NOT_FOUND" });
    const bare = readWorld({ chainReadAccess: async () => true });
    const other = bare.w.seedSession({ kind: "chain" });
    expect(await code(sessionStepTask(bare.deps, bare.w.caller(ARJUN), other.sessionId, 1))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
});

// ---- the lists

describe("listing sessions", () => {
  function listWorld() {
    const r = readWorld();
    const a = r.w.seedSession(); // Priya's, on web
    const b = r.w.seedSession({ owner: ARJUN }); // Arjun's, on web
    const c = r.w.seedSession({ kind: "local" }); // Priya's Mac session, on web
    const d = r.w.seedSession({ ended: true }); // Priya's, ended
    const e = r.w.seedSession({ project: "ops" }); // Priya's, on ops (nobody else has a role there)
    r.index(a.sessionId, "2026-10-22T08:01:00.000Z");
    r.index(b.sessionId, "2026-10-22T08:02:00.000Z");
    r.index(c.sessionId, "2026-10-22T08:03:00.000Z");
    r.index(d.sessionId, "2026-10-22T08:00:00.000Z");
    r.index(e.sessionId, "2026-10-22T08:04:00.000Z");
    return { ...r, a: a.sessionId, b: b.sessionId, c: c.sessionId, d: d.sessionId, e: e.sessionId };
  }
  const ids = (page: { sessions: Array<{ sessionId: string }> }) => page.sessions.map((tile) => tile.sessionId);

  it("lists the caller's own sessions, newest first, as tiles that parse", async () => {
    const l = listWorld();
    const page = await listSessions(l.deps, l.w.caller(PRIYA), { owner: "me" });
    expect(ids(page)).toEqual([l.e, l.c, l.a, l.d]);
    expect(SessionListSchema.parse(page)).toEqual(page);
    expect(SessionListReaderSchema.safeParse(page).success).toBe(true);
    expect(page.sessions[0]).toMatchObject({ kind: "task", title: "Bump the Stripe SDK", level: "edit", where: { kind: "cloud" }, project: "ops" });
    expect(page.next).toBeUndefined();
  });

  it("lists a project's sessions with each row re-checked and dropped when the caller has no level", async () => {
    const l = listWorld();
    // Arjun sees Priya's task session and his own on web, but not her Mac session (nothing shared) and nothing on ops.
    expect(ids(await listSessions(l.deps, l.w.caller(ARJUN), { project: "web" }))).toEqual([l.b, l.a, l.d]);
    expect(ids(await listSessions(l.deps, l.w.caller(ARJUN), { project: "ops" }))).toEqual([]);
    expect(ids(await listSessions(l.deps, l.w.caller(ZED), { project: "web" }))).toEqual([]);
    l.shareWith(l.c, ARJUN);
    expect(ids(await listSessions(l.deps, l.w.caller(ARJUN), { project: "web" }))).toEqual([l.c, l.b, l.a, l.d]);
    // Another org's caller reads their own org's index, which is empty.
    expect(ids(await listSessions(l.deps, l.w.caller(BO, ORG_B), { project: "web" }))).toEqual([]);
  });

  it("lists what is shared with the caller, and not what is shared with someone else", async () => {
    const l = listWorld();
    l.shareWith(l.c, MIA);
    l.shareWith(l.e, ARJUN);
    expect(ids(await listSessions(l.deps, l.w.caller(MIA), { shared: "me" }))).toEqual([l.c]);
    expect(ids(await listSessions(l.deps, l.w.caller(ARJUN), { shared: "me" }))).toEqual([l.e]);
    expect(ids(await listSessions(l.deps, l.w.caller(ZED), { shared: "me" }))).toEqual([]);
    expect(ids(await listSessions(l.deps, l.w.caller(BO, ORG_B), { shared: "me" }))).toEqual([]);
    // A share that was removed but whose index row stayed is dropped by the re-check.
    l.w.db.delete(agentSessionKey(ORG_A, l.e, `SHARE#MEMBER#${ARJUN}`));
    expect(ids(await listSessions(l.deps, l.w.caller(ARJUN), { shared: "me" }))).toEqual([]);
  });

  it("filters by open or ended and pages with an opaque cursor", async () => {
    const l = listWorld();
    expect(ids(await listSessions(l.deps, l.w.caller(PRIYA), { owner: "me", status: "ended" }))).toEqual([l.d]);
    expect(ids(await listSessions(l.deps, l.w.caller(PRIYA), { owner: "me", status: "open" }))).toEqual([l.e, l.c, l.a]);
    const first = await listSessions(l.deps, l.w.caller(PRIYA), { owner: "me", limit: 2 });
    expect(ids(first)).toEqual([l.e, l.c]);
    expect(first.next).toEqual(expect.any(String));
    const second = await listSessions(l.deps, l.w.caller(PRIYA), { owner: "me", limit: 2, cursor: first.next! });
    expect(ids(second)).toEqual([l.a, l.d]);
    expect(second.next).toBeUndefined();
    // A cursor of someone else's, or a made-up one, is refused without echoing it.
    const bad = await code(listSessions(l.deps, l.w.caller(PRIYA), { owner: "me", cursor: "x".repeat(50) }));
    expect(bad).toMatchObject({ code: "CONFIG_INVALID" });
    expect(bad?.message).not.toContain("xxxx");
  });

  describe("the cursor (review m-1)", () => {
    const flip = (text: string, at: number) => `${text.slice(0, at)}${text[at] === "A" ? "B" : "A"}${text.slice(at + 1)}`;
    const readable = (text: string) => [text, Buffer.from(text, "base64url").toString("latin1"), ...text.split(".").map((part) => Buffer.from(part, "base64url").toString("latin1"))].join("\n");

    it("never names a session the caller can't see, even when the scan cap stops the page", async () => {
      const r = readWorld();
      // The caller has no role on ops, and the scan stops at its cap on rows of sessions they can't see.
      for (let n = 0; n <= LIVE_INDEX_SCAN_MAX; n += 1) {
        const sessionId = `ses_${String(700000 + n).padStart(20, "0")}`;
        const createdAt = new Date(Date.parse("2026-10-21T00:00:00.000Z") + n * 1000).toISOString();
        r.w.db.set({ ...projectSessionsKey(ORG_A, "ops", createdAt, sessionId), entityType: "PROJECT_SESSION", orgId: ORG_A, sessionId, project: "ops", createdAt });
      }
      const page = await listSessions(r.deps, r.w.caller(ZED), { project: "ops" });
      expect(page.sessions).toEqual([]);
      expect(page.next).toEqual(expect.any(String));
      const shown = readable(page.next!);
      expect(shown).not.toMatch(/ses_[0-9a-z]{20}/);
      expect(shown).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      // The cursor still works: the one row left is read, and nothing more is promised.
      const rest = await listSessions(r.deps, r.w.caller(ZED), { project: "ops", cursor: page.next! });
      expect(rest).toEqual({ sessions: [] });
    });

    it("is refused when any part of it changes, and is bound to the list and the person it was given to", async () => {
      const l = listWorld();
      const first = await listSessions(l.deps, l.w.caller(PRIYA), { owner: "me", limit: 2 });
      const cursor = first.next!;
      expect(ids(await listSessions(l.deps, l.w.caller(PRIYA), { owner: "me", limit: 2, cursor }))).toEqual([l.a, l.d]);
      const changed = [flip(cursor, 0), flip(cursor, 5), flip(cursor, Math.floor(cursor.length / 2)), flip(cursor, cursor.length - 1), cursor.slice(0, -1), `${cursor}A`, cursor.toUpperCase(), ""];
      for (const bad of changed) {
        if (bad === cursor) continue;
        const refused = await code(listSessions(l.deps, l.w.caller(PRIYA), { owner: "me", limit: 2, cursor: bad }));
        expect(refused, bad).toMatchObject({ code: "CONFIG_INVALID" });
        if (bad !== "") expect(refused?.message).not.toContain(bad.slice(0, 12)); // an empty cursor has nothing to echo
      }
      // The one spelling it was written in: no prefix, and no other base64url spelling of the same bytes, opens it.
      expect(await code(listSessions(l.deps, l.w.caller(PRIYA), { owner: "me", limit: 2, cursor: cursor.slice("v1.".length) }))).toMatchObject({ code: "CONFIG_INVALID" });
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      const bytes = Buffer.from(cursor.slice("v1.".length), "base64url");
      const spellings = [...alphabet].map((c) => `v1.${cursor.slice("v1.".length, -1)}${c}`).filter((text) => text !== cursor && Buffer.from(text.slice("v1.".length), "base64url").equals(bytes));
      expect(spellings.length).toBeGreaterThan(0);
      for (const same of spellings) expect(await code(listSessions(l.deps, l.w.caller(PRIYA), { owner: "me", limit: 2, cursor: same })), same).toMatchObject({ code: "CONFIG_INVALID" });
      // Another list, and another person's list, refuse it too.
      expect(await code(listSessions(l.deps, l.w.caller(PRIYA), { project: "web", limit: 2, cursor }))).toMatchObject({ code: "CONFIG_INVALID" });
      expect(await code(listSessions(l.deps, l.w.caller(ARJUN), { owner: "me", limit: 2, cursor }))).toMatchObject({ code: "CONFIG_INVALID" });
      const project = await listSessions(l.deps, l.w.caller(ARJUN), { project: "web", limit: 1 });
      expect(project.next).toEqual(expect.any(String));
      expect(await code(listSessions(l.deps, l.w.caller(MIA), { project: "web", limit: 1, cursor: project.next! }))).toMatchObject({ code: "CONFIG_INVALID" });
      // A key the server no longer holds: the old cursors stop working.
      expect(await code(listSessions({ ...l.deps, cursorKey: "z".repeat(64) }, l.w.caller(PRIYA), { owner: "me", limit: 2, cursor }))).toMatchObject({ code: "CONFIG_INVALID" });
    });

    it("never gives the same cursor twice for the same place (a fresh nonce each time)", async () => {
      const l = listWorld();
      const one = (await listSessions(l.deps, l.w.caller(PRIYA), { owner: "me", limit: 2 })).next!;
      const two = (await listSessions(l.deps, l.w.caller(PRIYA), { owner: "me", limit: 2 })).next!;
      expect(one).not.toBe(two);
      // Both open to the same place.
      expect(ids(await listSessions(l.deps, l.w.caller(PRIYA), { owner: "me", limit: 2, cursor: one }))).toEqual(ids(await listSessions(l.deps, l.w.caller(PRIYA), { owner: "me", limit: 2, cursor: two })));
    });

    it("answers RUNTIME_UNAVAILABLE rather than a list it can't sign, when no cursor key is set", async () => {
      const l = listWorld();
      const { cursorKey: _key, ...without } = l.deps; // eslint-disable-line @typescript-eslint/no-unused-vars -- removed on purpose
      expect(await code(listSessions(without as never, l.w.caller(PRIYA), { owner: "me" }))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    });
  });

  it("asks the project channel for the caller's role once per request, not once per row (review m-2)", async () => {
    const r = readWorld();
    r.w.members.channel(ORG_A, "web", ZED);
    const made = Array.from({ length: 6 }, (_, n) => r.w.seedSession({ owner: n % 2 === 0 ? PRIYA : ARJUN }).sessionId);
    made.forEach((id, n) => r.index(id, `2026-10-22T08:0${String(n)}:00.000Z`));
    r.w.members.calls.length = 0;
    const page = await listSessions(r.deps, r.w.caller(ZED), { project: "web" });
    expect(page.sessions).toHaveLength(6);
    expect(r.w.members.calls.filter((call) => call === "roleOf web")).toHaveLength(1);
    // A person with no role at all costs one lookup too, and sees nothing.
    r.w.members.calls.length = 0;
    expect((await listSessions(r.deps, r.w.caller(BO, ORG_B), { project: "web" })).sessions).toEqual([]);
    const other = r.w.members.calls.length;
    expect(other).toBeLessThanOrEqual(1);
  });

  it("asks the channel once for a project share's role too, for an org admin who has no grant (review m-2)", async () => {
    const r = readWorld();
    const first = r.w.seedSession().sessionId;
    const second = r.w.seedSession().sessionId;
    for (const id of [first, second]) r.w.seedShare(ORG_A, id, { kind: "project", project: "web" }, "view");
    const memo = newSessionRoleMemo();
    r.w.members.calls.length = 0;
    for (const id of [first, second]) await requireSessionLevel(r.deps, r.w.caller(OLA), id, "view", "view it", { memo });
    expect(r.w.members.calls.filter((call) => call === "roleOf web")).toHaveLength(1); // as a plain member (an admin's own role needs no lookup), for both sessions
  });

  it("drops an index row that names another org, and refuses a limit outside 1 to 100", async () => {
    const l = listWorld();
    const key = mySessionsKey(ORG_A, PRIYA, "2026-10-22T08:01:00.000Z", l.a);
    l.w.db.set({ ...l.w.db.get(key)!, orgId: ORG_B });
    expect(ids(await listSessions(l.deps, l.w.caller(PRIYA), { owner: "me" }))).toEqual([l.e, l.c, l.d]);
    expect(await code(listSessions(l.deps, l.w.caller(PRIYA), { owner: "me", limit: 101 }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(listSessions(l.deps, l.w.caller(PRIYA), { owner: "me", limit: 0 }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect((await listSessions(l.deps, l.w.caller(PRIYA), { owner: "me", limit: 100 })).sessions).toHaveLength(3);
    expect((await listSessions(l.deps, l.w.caller(PRIYA), { owner: "me", limit: 1 })).sessions).toHaveLength(1);
  });

  it("needs exactly one of owner, project or shared, and a real project name", async () => {
    const l = listWorld();
    expect(await code(listSessions(l.deps, l.w.caller(PRIYA), {}))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(listSessions(l.deps, l.w.caller(PRIYA), { owner: "me", project: "web" }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(listSessions(l.deps, l.w.caller(PRIYA), { project: "../etc" }))).toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("the access guards", () => {
  it("lets a session viewer read a task and nothing else", () => {
    expect(can("viewer", "read", "session")).toBe(true);
    expect(can("viewer", "peopleRead", "session")).toBe(true);
    expect(can("viewer", "takeOwnership", "session")).toBe(false);
    expect(can("viewer", "takeOwnership")).toBe(true);
    for (const action of ["comment", "suggest", "decide", "ask", "peopleManage", "retry", "publish", "feedback", "close", "control", "work"] as const) expect(can("viewer", action, "session"), action).toBe(false);
  });

  it("owns the paths under /v1/app/sessions", () => {
    expect(isAgentSessionRoute("/v1/app/sessions")).toBe(true);
    expect(isAgentSessionRoute("/v1/app/sessions/ses_0123456789abcdefghij/shares")).toBe(true);
    expect(isAgentSessionRoute("/v1/app/sessionsx")).toBe(false);
    expect(isAgentSessionRoute("/v1/app/agents")).toBe(false);
  });

  it("registers the company-wide share's rule and handler when the routes load", () => {
    expect(getApproverRule("session_share_org")).toBeDefined();
    expect(getApprovalSubjectHandler("session_share_org")).toBeDefined();
  });
});

describe("a task from before sessions", () => {
  function lazyWorld() {
    const w = sessionWorld();
    const { sessionId: seeded, taskId } = w.seedSession();
    // Drop the session the seed made: this is a task started before the deploy.
    w.db.delete(agentSessionKey(ORG_A, seeded, "META"));
    const task = w.db.get(taskKey(taskId))!;
    const { sessionId: _gone, ...rest } = task; // eslint-disable-line @typescript-eslint/no-unused-vars -- the point is that it has none
    const full = {
      ...rest, agent: { agentId: "rovara-code", name: "Rovara Code", version: 3, builtin: true }, origin: "app", title: "Bump the Stripe SDK",
      startedBy: { developerId: PRIYA }, payer: { kind: "member", developerId: PRIYA }, createdAt: "2026-10-20T08:00:00.000Z",
    };
    w.db.set(full);
    const table = { documentClient: w.db, tableName: "state", now: () => w.clock.now };
    const ensure = (override: Record<string, unknown> = {}) => ensureTaskSession(table, { ...full, ...override } as never, { ownerName: "Priya", title: "Bump the Stripe SDK" });
    return { w, taskId, full, table, ensure };
  }
  const sessionsOf = (w: SessionWorld) => w.db.find((item) => typeof item.pk === "string" && item.pk.includes("AGENT_SESSION#") && item.sk === "META");

  it("gets a session of its own, once, named on the task and listed for its owner", async () => {
    const l = lazyWorld();
    const id = await l.ensure();
    expect(id).toMatch(/^ses_[0-9a-z]{20}$/);
    expect(sessionsOf(l.w)).toHaveLength(1);
    expect((l.w.db.get(taskKey(l.taskId)) as { sessionId?: string }).sessionId).toBe(id);
    const record = (await new AgentSessionStore(l.table).get(ORG_A, id as never))!;
    expect(record).toMatchObject({
      kind: "task", subject: { kind: "task", taskId: l.taskId }, project: "web", agent: { agentId: "rovara-code", name: "Rovara Code", version: 3 },
      owner: { developerId: PRIYA, name: "Priya" }, startedBy: { kind: "member", developerId: PRIYA }, origin: "app", createdAt: "2026-10-20T08:00:00.000Z",
    });
    expect(l.w.db.get(mySessionsKey(ORG_A, PRIYA, "2026-10-20T08:00:00.000Z", id as never))).toBeDefined();
    expect(l.w.db.get(openAgentSessionKey(ORG_A, id as never))).toBeDefined();
    expect(l.w.db.get(liveSessionKey(ORG_A, id as never))).toBeDefined();
    // A second call finds the same one and writes nothing more.
    const before = l.w.db.transactions().length;
    expect(await l.ensure({ sessionId: id })).toBe(id);
    expect(l.w.db.transactions().length).toBe(before);
  });

  it("gives one session even when two first reads race", async () => {
    const l = lazyWorld();
    const [first, second, third] = await Promise.all([l.ensure(), l.ensure(), l.ensure()]);
    expect(first).toBeDefined();
    expect(new Set([first, second, third]).size).toBe(1);
    expect(sessionsOf(l.w)).toHaveLength(1);
    expect((l.w.db.get(taskKey(l.taskId)) as { sessionId?: string }).sessionId).toBe(first);
  });

  it("skips a task with no starter, a chain step's task and a task with no agent, and never throws", async () => {
    for (const override of [{ startedBy: undefined }, { chain: { chainRunId: "crn_0123456789abcdefghij", stepId: "fix" } }, { agent: undefined }, { origin: undefined }, { orgId: undefined }]) {
      const l = lazyWorld();
      expect(await l.ensure(override), JSON.stringify(override)).toBeUndefined();
      expect(sessionsOf(l.w)).toHaveLength(0);
    }
    // A name or title that can't be shown never makes it throw.
    const l = lazyWorld();
    const broken = { documentClient: { send: async () => { throw new Error("table is down"); } }, tableName: "state", now: () => 0 };
    await expect(ensureTaskSession(broken as never, l.full as never, { ownerName: "Priya", title: "x" })).resolves.toBeUndefined();
  });

  it("leaves a session another read named in the meantime alone, and never answers with another org's", async () => {
    const l = lazyWorld();
    const other = "ses_00000000000000000001";
    // A read that raced us already named one; ours, still holding the old copy of the task, writes nothing.
    l.w.db.set({ ...l.w.db.get(taskKey(l.taskId))!, sessionId: other });
    expect(await l.ensure()).toBe(other);
    expect(sessionsOf(l.w)).toHaveLength(0);
    expect((l.w.db.get(taskKey(l.taskId)) as { sessionId?: string }).sessionId).toBe(other);
    // A copy of the task that says another org gets nothing from this one's record.
    expect(await l.ensure({ orgId: ORG_B })).toBeUndefined();
  });

  it("keeps a task that is somebody else's org out", async () => {
    const l = lazyWorld();
    expect(await l.ensure({ orgId: ORG_B })).toBeUndefined();
    expect((l.w.db.get(taskKey(l.taskId)) as { sessionId?: string }).sessionId).toBeUndefined();
  });

  it("makes the same items a start makes", () => {
    const items = createTaskSessionItems({ documentClient: {} as never, tableName: "state", now: () => 0 }, {
      orgId: ORG_A, sessionId: "ses_00000000000000000001", taskId: randomUUID(), project: "web", agent: { agentId: "rovara-code", name: "Rovara Code", version: 1 }, title: "t",
      owner: { developerId: PRIYA, name: "Priya" }, startedBy: { kind: "member", developerId: PRIYA }, origin: "app", payer: { kind: "member", developerId: PRIYA }, now: "2026-10-20T08:00:00.000Z",
    });
    expect(items.length).toBeGreaterThanOrEqual(7);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Part 2: through the real broker
// ---------------------------------------------------------------------------------------------------------------------------------------------

let createAgentRunStarter: typeof BrokerModule.createAgentRunStarter;
beforeAll(async () => {
  await loadSlackBroker();
  ({ createAgentRunStarter } = await import("../../packages/broker/src/aws/broker.js"));
});

const ZOE: Developer = { developerId: "5".repeat(64), name: "Zoe Park", provider: "oidc", sessionId: "s-zoe" };
const BOB: Developer = { developerId: "6".repeat(64), name: "Bob Other", provider: "oidc", sessionId: "s-bob" };
const ORIGIN = new URL(DEV_ISSUER).origin;
const COOKIE = "__Host-agentx_review_session";

async function setup() {
  const h = await createDeveloperTaskBroker({
    brokerExtra: { agents: {} },
    orgResolver: async ({ developerId }) => (developerId === BOB.developerId ? ORG_B : TEST_ORG),
  });
  const known = (who: Developer, orgId: OrgId = TEST_ORG) => {
    h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    seedMembership(h.db, who.developerId, { orgId, role: "member" });
  };
  known(ZOE);
  known(BOB, ORG_B);
  const start = async (extra: Record<string, unknown> = {}) => {
    const reply = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK", ...extra });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const task = reply.body.task as { taskId: string; sessionId: string };
    return { taskId: task.taskId, sessionId: task.sessionId };
  };
  const share = (who: Developer, sessionId: string, to: Developer, level = "view") =>
    h.dev(who, "PUT", `/v1/app/sessions/${sessionId}/shares`, { requestId: randomUUID(), principal: { kind: "member", developerId: to.developerId }, level });
  const starter = () => {
    const found = createAgentRunStarter(h.brokerInput as never);
    if (found === undefined) throw new Error("no agent run starter");
    return found;
  };
  const browser = async (path: string, who: Developer, extra: { method?: string; cookie?: boolean; body?: unknown; routeKey?: string } = {}) => {
    const response = await h.handler({
      version: "2.0", routeKey: extra.routeKey ?? (path.startsWith("/s/") ? "ANY /s/{proxy+}" : "ANY /review/{proxy+}"), rawPath: path, rawQueryString: "",
      headers: {
        host: new URL(DEV_ISSUER).host, ...(extra.cookie === false ? {} : { cookie: `${COOKIE}=${browserSession(who)}; __Host-agentx_review_csrf=${"c".repeat(43)}` }),
        ...(extra.method === "POST" ? { origin: ORIGIN, "x-agentx-csrf": "c".repeat(43), "content-type": "application/json" } : {}),
      },
      ...(extra.body === undefined ? {} : { body: JSON.stringify(extra.body) }), requestContext: { requestId: randomUUID(), http: { method: extra.method ?? "GET" } },
    });
    return { status: response.statusCode, headers: (response as unknown as { headers: Record<string, string> }).headers, body: response.body };
  };
  const sessions = new Map<string, string>();
  const browserSession = (who: Developer) => {
    let id = sessions.get(who.developerId);
    if (id === undefined) {
      id = randomUUID();
      sessions.set(who.developerId, id);
      h.db.set({ pk: `SESSION#${id}`, sk: "META", sessionId: id, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 600, reviewExpiresAt: Math.floor(Date.now() / 1000) + 600 });
    }
    return id;
  };
  return { ...h, known, start, share, starter, browser };
}

describe("the session routes", () => {
  it("reads a started task as a session, for its owner, with the task inside", async () => {
    const t = await setup();
    const { taskId, sessionId } = await t.start();
    const reply = await t.dev(MAYA, "GET", `/v1/app/sessions/${sessionId}`);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const parsed = SessionResponseSchema.parse(bodyOf(reply));
    expect(SessionResponseReaderSchema.safeParse(bodyOf(reply)).success).toBe(true);
    expect(parsed.session).toMatchObject({
      sessionId, kind: "task", project: "payments", owner: { developerId: MAYA.developerId }, link: `${ORIGIN}/s/${sessionId}`,
      you: { level: "edit", owner: true }, body: { kind: "task", task: { taskId, sessionId } },
    });
    expect((parsed.session.body as { task: { events: unknown[] } }).task.events).toEqual(expect.any(Array));
    expect(JSON.stringify(reply.body)).not.toContain("\"arguments\"");
  });

  it("keeps a session from a person with no level, and shows it to a sharee as a viewer", async () => {
    const t = await setup();
    const { sessionId } = await t.start();
    expect((await t.dev(OMAR, "GET", `/v1/app/sessions/${sessionId}`)).status).toBe(404);
    expect((await t.dev(OMAR, "GET", `/v1/app/sessions/${sessionId}/shares`)).status).toBe(404);
    const shared = await t.share(MAYA, sessionId, OMAR);
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    SessionSharePutResponseSchema.parse(bodyOf(shared));
    const seen = await t.dev(OMAR, "GET", `/v1/app/sessions/${sessionId}`);
    expect(seen.status, JSON.stringify(seen.body)).toBe(200);
    expect(SessionResponseSchema.parse(bodyOf(seen)).session.you).toEqual({ level: "view", owner: false, following: false, actions: ["watch", "comment"] });
    expect((await t.dev(BOB, "GET", `/v1/app/sessions/${sessionId}`)).status).toBe(404);
    expect((await t.dev(BOB, "GET", `/v1/app/sessions/${sessionId}/shares`)).status).toBe(404);
    expect((await t.dev(BOB, "PUT", `/v1/app/sessions/${sessionId}/shares`, { requestId: randomUUID(), principal: { kind: "member", developerId: BOB.developerId }, level: "edit" })).status).toBe(404);
    expect((await t.dev(BOB, "DELETE", `/v1/app/sessions/${sessionId}/shares/ORG`)).status).toBe(404);
    expect((await t.dev(BOB, "GET", `/v1/app/sessions/${sessionId}/sections/1/task`)).status).toBe(404);
  });

  it("maps list, put, delete and the lists of sessions to routes that answer with their schemas", async () => {
    const t = await setup();
    const { sessionId } = await t.start();
    await t.share(MAYA, sessionId, OMAR);
    const shares = await t.dev(MAYA, "GET", `/v1/app/sessions/${sessionId}/shares`);
    expect(shares.status).toBe(200);
    expect(SessionSharesResponseSchema.parse(bodyOf(shares)).shares).toHaveLength(1);
    expect((await t.dev(OMAR, "GET", `/v1/app/sessions/${sessionId}/shares`)).status).toBe(200);
    // A viewer can't share.
    const denied = await t.share(OMAR, sessionId, ZOE);
    expect(denied.status).toBe(403);
    expect((denied.body.error as { code: string }).code).toBe("SESSION_LEVEL_REQUIRED");
    // Lists.
    const mine = await t.dev(MAYA, "GET", "/v1/app/sessions?owner=me");
    expect(SessionListSchema.parse(bodyOf(mine)).sessions.map((tile) => tile.sessionId)).toEqual([sessionId]);
    expect(SessionListSchema.parse(bodyOf(await t.dev(OMAR, "GET", "/v1/app/sessions?shared=me"))).sessions.map((tile) => tile.sessionId)).toEqual([sessionId]);
    expect(SessionListSchema.parse(bodyOf(await t.dev(ZOE, "GET", "/v1/app/sessions?shared=me"))).sessions).toEqual([]);
    expect(SessionListSchema.parse(bodyOf(await t.dev(OMAR, "GET", "/v1/app/sessions?project=payments"))).sessions.map((tile) => tile.sessionId)).toEqual([sessionId]);
    expect(SessionListSchema.parse(bodyOf(await t.dev(ZOE, "GET", "/v1/app/sessions?project=payments"))).sessions).toEqual([]);
    expect(SessionListSchema.parse(bodyOf(await t.dev(BOB, "GET", "/v1/app/sessions?project=payments"))).sessions).toEqual([]);
    expect((await t.dev(MAYA, "GET", "/v1/app/sessions")).status).toBe(400);
    // Delete, by the key the list gives, encoded.
    const key = encodeURIComponent(`MEMBER#${OMAR.developerId}`);
    const removed = await t.dev(MAYA, "DELETE", `/v1/app/sessions/${sessionId}/shares/${key}`);
    expect(SessionShareDeleteResponseSchema.parse(bodyOf(removed))).toEqual({ removed: true });
    expect((await t.dev(OMAR, "GET", `/v1/app/sessions/${sessionId}`)).status).toBe(404);
    expect(SessionShareDeleteResponseSchema.parse(bodyOf(await t.dev(MAYA, "DELETE", `/v1/app/sessions/${sessionId}/shares/${key}`)))).toEqual({ removed: false });
    expect((await t.dev(MAYA, "GET", "/v1/app/sessions/ses_00000000000000000000")).status).toBe(404);
    expect((await t.dev(MAYA, "POST", `/v1/app/sessions/${sessionId}`)).status).toBe(404);
  });

  it("answers a company-wide share 202 with a confirmation link, and the handler the broker registered applies it with the broker's own dependencies", async () => {
    const t = await setup();
    const { sessionId } = await t.start();
    const reply = await t.dev(MAYA, "PUT", `/v1/app/sessions/${sessionId}/shares`, { requestId: randomUUID(), principal: { kind: "org" }, level: "view" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const needs = NeedsConfirmationSchema.parse(bodyOf(reply));
    expect(needs.confirmUrl).toContain("/v1/app/approve/apr_");
    expect((await t.dev(ZOE, "GET", `/v1/app/sessions/${sessionId}`)).status).toBe(404);
    // The wiring: the dependencies the broker built for the agent routes carry the session ones, and the handler works with them.
    const deps = t.starter() as unknown as { agentSessions?: unknown };
    expect(deps.agentSessions).toBeDefined();
    const handler = getApprovalSubjectHandler("session_share_org")!;
    await handler(deps as never, {
      orgId: TEST_ORG, approvalId: "apr_0123456789abcdefghij", kind: "change", subject: { kind: "session_share_org", sessionId, level: "view" }, changes: ["x"],
      approvers: { kind: "rule", rule: "session_share_org", candidates: [MAYA.developerId] }, status: "EXECUTING", requestedBy: MAYA.developerId, decidedBy: MAYA.developerId,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } as never);
    expect((await t.dev(ZOE, "GET", `/v1/app/sessions/${sessionId}`)).status).toBe(200);
  });

  it("lists the caller's own pending approval on the session, with a bare link, and not another person's", async () => {
    const t = await setup();
    const { taskId, sessionId } = await t.start();
    await t.share(MAYA, sessionId, OMAR);
    const approvalId = "apr_0123456789abcdefghij";
    const record: WriteApprovalRecord = {
      orgId: TEST_ORG, approvalId, kind: "write", subject: { kind: "agent_run", taskId, stepId: "work" }, operationId: randomUUID(), connector: "linear", connectorType: "linear",
      tool: "save_issue", toolAccess: "write", scope: "eng", schemaHash: "a".repeat(64), projectRevision: 1, scopeDigest: "b".repeat(64), arguments: { title: "SECRET-ARGUMENT-TEXT" },
      argumentsHash: "c".repeat(64), summary: "Create a Linear issue", class: "consequential", approvers: { kind: "ids", ids: [MAYA.developerId] }, status: "PENDING", project: "payments",
      owner: { developerId: MAYA.developerId, name: MAYA.name }, attempts: 0, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    } as never;
    expect(await createWriteApprovalRecord({ documentClient: t.db, tableName: "state", now: Date.now }, record, [], 8)).toBe("created");
    const owner = await t.dev(MAYA, "GET", `/v1/app/sessions/${sessionId}`);
    expect(SessionResponseSchema.parse(bodyOf(owner)).session.approvals).toEqual([{ approvalId, title: "Create a Linear issue", confirmUrl: `${ORIGIN}/v1/app/approve/${approvalId}` }]);
    const viewer = await t.dev(OMAR, "GET", `/v1/app/sessions/${sessionId}`);
    expect(SessionResponseSchema.parse(bodyOf(viewer)).session.approvals).toEqual([]);
    expect(JSON.stringify(owner.body) + JSON.stringify(viewer.body)).not.toContain("SECRET-ARGUMENT-TEXT");
    expect(JSON.stringify(owner.body) + JSON.stringify(viewer.body)).not.toContain("\"arguments\"");
  });
});

describe("what the routes refuse", () => {
  it("answers only the methods and paths it maps", async () => {
    const t = await setup();
    const { sessionId } = await t.start();
    expect((await t.dev(MAYA, "POST", "/v1/app/sessions", {})).status).toBe(404);
    expect((await t.dev(MAYA, "GET", `/v1/app/sessions/${sessionId}/shares/ORG`)).status).toBe(404);
    expect((await t.dev(MAYA, "PUT", `/v1/app/sessions/${sessionId}/sections/1/task`, {})).status).toBe(404);
    expect((await t.dev(MAYA, "GET", `/v1/app/sessions/${sessionId}/sections/1/task`)).status).toBe(404);
    for (const limit of ["abc", "1e1", "-1", "1000"]) expect((await t.dev(MAYA, "GET", `/v1/app/sessions?owner=me&limit=${limit}`)).status, limit).toBe(400);
    expect((await t.dev(MAYA, "GET", "/v1/app/sessions?owner=me&limit=5")).status).toBe(200);
    expect((await t.dev(MAYA, "GET", "/v1/app/sessions?owner=me&status=nope")).status).toBe(400);
  });

  it("reads a chain session by Plan 4's rule by default, and fails closed on a record that is not a chain run's", async () => {
    const t = await setup();
    const deps = t.starter() as unknown as { agentSessions: { chainReadAccess?: (caller: { orgId: OrgId; developerId: string }, session: never) => Promise<boolean> } };
    expect(deps.agentSessions.chainReadAccess).toBeDefined();
    expect(await deps.agentSessions.chainReadAccess!({ orgId: TEST_ORG, developerId: MAYA.developerId }, {} as never)).toBe(false);
  });

  it("leaves a budget request nobody can decide any more without a link", async () => {
    const t = await setup();
    const id = "spr_0123456789abcdefghij";
    const asked = { orgId: TEST_ORG, developerId: MAYA.developerId };
    expect(await mayDecideSpendRequest(t.starter() as never, asked, id)).toBe(false);
    const record = { ...spendRequestKey(TEST_ORG, id), entityType: "SPEND_REQUEST", orgId: TEST_ORG, spendRequestId: id, kind: "run_limit", amountUsd: 5, approverIds: [MAYA.developerId], requestedBy: { kind: "system" } };
    t.db.set({ ...record, status: "PENDING", expiresAt: new Date(Date.now() - 60_000).toISOString() });
    expect(await mayDecideSpendRequest(t.starter() as never, asked, id)).toBe(false);
    t.db.set({ ...record, status: "APPROVED", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(await mayDecideSpendRequest(t.starter() as never, asked, id)).toBe(false);
  });

  it("names a pending decision only on its own session, and only to a person who may decide it", async () => {
    const t = await setup();
    const first = await t.start();
    const second = await t.start();
    await t.share(MAYA, first.sessionId, OMAR);
    const ask = (taskId: string, approvalId: string, ids: string[]) => createWriteApprovalRecord({ documentClient: t.db, tableName: "state", now: Date.now }, {
      orgId: TEST_ORG, approvalId, kind: "write", subject: { kind: "agent_run", taskId, stepId: "work" }, operationId: randomUUID(), connector: "linear", connectorType: "linear",
      tool: "save_issue", toolAccess: "write", scope: "eng", schemaHash: "a".repeat(64), projectRevision: 1, scopeDigest: "b".repeat(64), arguments: {}, argumentsHash: "c".repeat(64),
      summary: `Change ${approvalId}`, class: "consequential", approvers: { kind: "ids", ids }, status: "PENDING", project: "payments", owner: { developerId: MAYA.developerId, name: MAYA.name },
      attempts: 0, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    } as never, [], 8);
    // Listed for Omar too, who has no role on the project and so may not decide it.
    expect(await ask(first.taskId, "apr_aaaaaaaaaaaaaaaaaaaa", [MAYA.developerId, OMAR.developerId])).toBe("created");
    expect(await ask(second.taskId, "apr_bbbbbbbbbbbbbbbbbbbb", [MAYA.developerId])).toBe("created");
    const onFirst = SessionResponseSchema.parse(bodyOf(await t.dev(MAYA, "GET", `/v1/app/sessions/${first.sessionId}`))).session.approvals;
    expect(onFirst.map((entry) => entry.approvalId)).toEqual(["apr_aaaaaaaaaaaaaaaaaaaa"]);
    const onSecond = SessionResponseSchema.parse(bodyOf(await t.dev(MAYA, "GET", `/v1/app/sessions/${second.sessionId}`))).session.approvals;
    expect(onSecond.map((entry) => entry.approvalId)).toEqual(["apr_bbbbbbbbbbbbbbbbbbbb"]);
    expect(SessionResponseSchema.parse(bodyOf(await t.dev(OMAR, "GET", `/v1/app/sessions/${first.sessionId}`))).session.approvals).toEqual([]);
  });
});

describe("the task page's access for a session viewer", () => {
  it("is a read-only viewer from the session, and nothing for any action but reading", async () => {
    const w = sessionWorld();
    const { sessionId, taskId } = w.seedSession();
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ZED }, "view");
    const deps = {
      documentClient: w.db, tableName: "state", now: () => w.clock.now, agentSessions: { documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members },
      checkAccess: async () => { throw new Error("no project access"); }, log: () => undefined,
    };
    const access = await resolveTaskAccess(deps, w.caller(ZED), taskId);
    expect(access).toMatchObject({ role: "viewer", source: "session", ownerActorIds: [] });
    expect(await resolveTaskAccess(deps as never, w.caller(ZED), taskId, "read")).toMatchObject({ source: "session" });
    expect(await resolveTaskAccess(deps as never, w.caller(ZED), taskId, "peopleRead")).toMatchObject({ source: "session" });
    for (const action of ["comment", "takeOwnership", "decide", "retry", "work", "peopleManage"] as const) {
      expect(await code(resolveTaskAccess(deps as never, w.caller(ZED), taskId, action)), action).toMatchObject({ code: "TASK_NOT_FOUND" });
    }
    // A project viewer reads through their session level too; someone with no level, and everyone when the session dependencies are absent, do not.
    expect(await code(resolveTaskAccess(deps as never, w.caller(MIA), taskId, "read"))).toBeUndefined();
    const nobody = "7".repeat(64);
    w.member(ORG_A, nobody, "member");
    expect(await code(resolveTaskAccess(deps as never, w.caller(nobody), taskId, "read"))).toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(await code(resolveTaskAccess({ ...deps, agentSessions: undefined } as never, w.caller(ZED), taskId))).toMatchObject({ code: "TASK_NOT_FOUND" });
  });
});

describe("a task read for the first time after the deploy", () => {
  it("gets its session on the full read, once, even when two reads race, and the session then reads", async () => {
    const t = await setup();
    const { taskId, sessionId } = await t.start();
    // Make it a task from before sessions.
    for (const item of t.db.find((entry) => typeof entry.pk === "string" && (entry.pk.includes(sessionId) || /LIVE_SESSIONS|MY_SESSIONS#|PROJECT_SESSIONS#|OPEN_AGENT_SESSIONS/.test(entry.pk)))) t.db.delete({ pk: String(item.pk), sk: String(item.sk) });
    const { sessionId: _sessionId, ...task } = t.db.get(taskKey(taskId))!; // eslint-disable-line @typescript-eslint/no-unused-vars -- removed on purpose
    t.db.set(task);
    expect(t.db.find((entry) => String(entry.pk).includes("AGENT_SESSION#"))).toHaveLength(0);
    const [one, two] = await Promise.all([t.dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`), t.dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)]);
    const first = (one.body.task as { sessionId?: string }).sessionId;
    expect(first).toMatch(/^ses_/);
    expect((two.body.task as { sessionId?: string }).sessionId).toBe(first);
    expect(t.db.find((entry) => String(entry.pk).includes("AGENT_SESSION#") && entry.sk === "META")).toHaveLength(1);
    expect((await t.dev(MAYA, "GET", `/v1/app/sessions/${first}`)).status).toBe(200);
    expect((t.db.get(taskKey(taskId)) as { sessionId?: string }).sessionId).toBe(first);
  });

  it("is not given one by a read that isn't the full one", async () => {
    const t = await setup();
    const { taskId, sessionId } = await t.start();
    for (const item of t.db.find((entry) => typeof entry.pk === "string" && entry.pk.includes(sessionId))) t.db.delete({ pk: String(item.pk), sk: String(item.sk) });
    const { sessionId: _sessionId, ...task } = t.db.get(taskKey(taskId))!; // eslint-disable-line @typescript-eslint/no-unused-vars -- removed on purpose
    t.db.set(task);
    expect((await t.dev(MAYA, "GET", `/v1/dev/tasks/${taskId}/events`)).status).toBe(200);
    expect(t.db.find((entry) => String(entry.pk).includes("AGENT_SESSION#"))).toHaveLength(0);
  });
});

describe("the link /s/<id>", () => {
  it("sends a person who can view a task session to its task page, and that page admits them to read it only", async () => {
    const t = await setup();
    const { taskId, sessionId } = await t.start();
    await t.share(MAYA, sessionId, OMAR);
    const link = await t.browser(`/s/${sessionId}`, OMAR);
    expect(link.status).toBe(404);
    expect(link.headers.location).toBeUndefined();
    const page = await t.browser(`/review/${taskId}/task`, OMAR);
    expect(page.status, page.body.slice(0, 300)).toBe(200);
    expect(page.body).toContain(`href="/s/${sessionId}">Back to the session</a>`);
    const state = await t.browser(`/review/${taskId}/task/api/state`, OMAR);
    expect(state.status, state.body).toBe(200);
    expect(JSON.parse(state.body)).toMatchObject({ canRead: true, canComment: false, canSuggest: false, canDecide: false, canAsk: false, canTakeOwnership: false, canManagePeople: false });
    expect((await t.browser(`/review/${taskId}/task/api/comments`, OMAR)).status).toBe(200);
    // Nothing that changes the task is open to them.
    const comment = await t.browser(`/review/${taskId}/task/api/comments`, OMAR, { method: "POST", body: { requestId: randomUUID(), document: "plan", version: 1, target: { kind: "document" }, text: "hello", ask: false } });
    expect(`${String(comment.status)} ${comment.body}`).toContain("not_allowed");
    expect(comment.status).toBe(403);
    // v1.2 learning loop (B3): the Remember and Forget paths are wired to the page API and refuse a person who may not comment, whatever they hold in the session.
    const remember = await t.browser(`/review/${taskId}/task/api/comments/${randomUUID()}/remember`, OMAR, { method: "POST", body: {} });
    expect(remember.status, remember.body).toBeGreaterThanOrEqual(403);
    expect(remember.status, remember.body).toBeLessThanOrEqual(404);
    expect(remember.body).not.toContain("correction");
    // The React route is wired too, and learning writes are browser-only: a bearer-token caller is refused (403) before the body or anything else is read.
    const react = await t.dev(MAYA, "POST", "/v1/app/projects/payments/learning/remember", { standing: "member" });
    expect(react.status, JSON.stringify(react.body)).toBe(403);
    expect(JSON.stringify(react.body)).toContain("live browser session");
    const take = await t.browser(`/review/${taskId}/task/api/people/take-ownership`, OMAR, { method: "POST", body: { requestId: randomUUID(), expectedPeopleRevision: 1 } });
    expect(take.status, take.body).toBe(404);
    const decide = await t.browser(`/review/${taskId}/task/api/decision`, OMAR, { method: "POST", body: { requestId: randomUUID(), expectedRevision: 1, artifactDigest: "a".repeat(64), decision: "APPROVE", answers: [], includedCommentIds: [] } });
    expect(decide.status, decide.body).toBe(403);
    expect(decide.body).toContain("owners_only");
    // Retrying and continuing go through the task's own rules, which a session level never opens.
    const retry = await t.dev(OMAR, "POST", `/v1/dev/tasks/${taskId}/workflow/retry`, { requestId: randomUUID(), instructions: "Try again", expectedRevision: 1 });
    const carryOn = await t.dev(OMAR, "POST", `/v1/dev/tasks/${taskId}/continue`, { requestId: randomUUID(), instructions: "Go on" });
    expect([retry.status, carryOn.status], JSON.stringify([retry.body, carryOn.body])).toEqual([404, 404]);
    expect(t.db.find((entry) => entry.entityType === "TASK_PEOPLE_EVENT")).toHaveLength(0);
    // A task nobody shared with them stays closed to them, and so does the link.
    expect((await t.browser(`/s/${sessionId}`, ZOE)).status).toBe(404);
    expect((await t.browser(`/review/${taskId}/task`, ZOE)).status).toBeGreaterThanOrEqual(400);
    // Another org gets the same answer for a real id and a made-up one.
    const real = await t.browser(`/s/${sessionId}`, BOB);
    const fake = await t.browser("/s/ses_00000000000000000000", BOB);
    expect(real.status).toBe(404);
    expect(bodyOf({ body: JSON.parse(real.body) as Record<string, unknown> })).toEqual(bodyOf({ body: JSON.parse(fake.body) as Record<string, unknown> }));
  });

  it("opens the task page and its poll to a session viewer outside the channel when the task has a People list, with no People data (review I-1)", async () => {
    const t = await setup();
    const { taskId, sessionId } = await t.start();
    // The task was shared in Slack and its People panel was opened: a PEOPLE item exists, and Omar is neither in it nor in the channel.
    t.db.set({
      pk: `DEVTASK#${taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 3, orphaned: false,
      people: [{ developerId: MAYA.developerId, slackUserId: "U0MAYA001", name: "Quentin Peoplesworth", role: "commenter" }],
    });
    await t.share(MAYA, sessionId, OMAR);
    const link = await t.browser(`/s/${sessionId}`, OMAR);
    expect(link.status).toBe(404);
    expect(link.headers.location).toBeUndefined();
    const page = await t.browser(`/review/${taskId}/task`, OMAR);
    expect(page.status, page.body.slice(0, 300)).toBe(200);
    expect(page.body).toContain(`href="/s/${sessionId}">Back to the session</a>`);
    expect(page.body).not.toContain("Quentin Peoplesworth");
    const state = await t.browser(`/review/${taskId}/task/api/state`, OMAR);
    expect(state.status, state.body).toBe(200);
    const polled = JSON.parse(state.body) as Record<string, unknown>;
    expect(polled).toMatchObject({ canRead: true, canManagePeople: false, canTakeOwnership: false });
    expect(polled.peopleRevision).toBeUndefined();
    // The People list itself answers nothing to this reader (not a refusal, and not the list).
    const people = await t.browser(`/review/${taskId}/task/api/people`, OMAR);
    expect(people.status, people.body).toBe(404);
    expect(people.body).not.toContain("Quentin Peoplesworth");
    expect(people.body).not.toContain("denied");
    // Someone the session was not shared with still gets nothing.
    expect((await t.browser(`/review/${taskId}/task`, ZOE)).status).toBeGreaterThanOrEqual(400);
    expect((await t.browser(`/review/${taskId}/task/api/state`, ZOE)).status).toBeGreaterThanOrEqual(400);
  });

  it("leaves signed-out and malformed shared links exclusively to the web shell", async () => {
    const t = await setup();
    const { sessionId } = await t.start();
    const anonymous = await t.browser(`/s/${sessionId}`, MAYA, { cookie: false });
    expect(anonymous.status).toBe(404);
    expect(anonymous.headers.location).toBeUndefined();
    expect((await t.browser("/s/not-a-session", MAYA)).status).toBe(404);
    expect((await t.browser(`/s/${sessionId}`, MAYA, { method: "POST" })).status).toBe(404);
    expect((await t.browser(`/s/${sessionId}x`, MAYA)).status).toBe(404);
  });

  it("leaves owner shared links to the web shell and preserves the task page", async () => {
    const t = await setup();
    const { taskId, sessionId } = await t.start();
    const own = await t.browser(`/s/${sessionId}`, MAYA);
    expect(own.status).toBe(404);expect(own.headers.location).toBeUndefined();
    expect((await t.browser(`/review/${taskId}/task`, MAYA)).status).toBe(200);
  });

  it("never serves local-session facts from the retired broker link", async () => {
    const t = await setup();
    const sessionId = "ses_0123456789abcdefghij";
    t.db.set({
      ...agentSessionKey(TEST_ORG, sessionId, "META"), entityType: "AGENT_SESSION", orgId: TEST_ORG, sessionId, kind: "local", mode: "delegate",
      subject: { kind: "local", deviceId: "dvc_0123456789abcdefghij", tool: "claude-code" }, legs: [], where: { kind: "mac", deviceId: "dvc_0123456789abcdefghij", label: "Mac" },
      title: "Fix <b>it</b>", owner: { developerId: MAYA.developerId, name: "Maya <i>Chen</i>" }, startedBy: { kind: "local" }, origin: "local", followerCount: 0, summaryRevision: 2, revision: 1,
      createdAt: "2026-10-22T08:00:00.000Z", updatedAt: "2026-10-22T08:00:00.000Z",
      summary: { status: "running", costUsd: 0, needsPeople: [], pendingApprovals: 0, digest: "d".repeat(64), computedAt: "2026-10-22T08:00:00.000Z" },
    });
    const page = await t.browser(`/s/${sessionId}`, MAYA);
    expect(page.status).toBe(404);
    expect(page.body).not.toContain("Fix &lt;b&gt;it&lt;/b&gt;");
    expect(page.body).not.toContain("Maya &lt;i&gt;Chen&lt;/i&gt;");
    expect(page.body).not.toContain("<b>it</b>");
    expect((await t.browser(`/s/${sessionId}`, OMAR)).status).toBe(404);
  });
});

// keep the imports honest for the checks above
void agentXError;
void MAX;
void MIA;
void OLA;
void ARJUN;
void PRIYA;
void ZED;
