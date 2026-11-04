import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { bindingItemsForOpenSession, sessionForSurface } from "../../packages/broker/src/agent-sessions/bindings.js";
import { httpControlPlaneClient } from "../../packages/mcp/src/client.js";
import { DEVELOPER_TOOLS } from "../../packages/mcp/src/tools.js";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { agentSessionKey, orgMemberKey, projectMemberKey, changesKey, sharedSessionsKey, sessionBindingKey, sessionSurfaceKey } from "@agentx/contracts";
import { putSessionShare, deleteSessionShare } from "../../packages/broker/src/agent-sessions/shares.js";
import { routeAgentSessionRequest, type SessionRouteDependencies } from "../../packages/broker/src/agent-sessions/routes.js";
import { MAYA, OMAR, bearerFor, createDeveloperTaskBroker, markThreadPosted } from "../support/developer-task-broker.js";
import { NeedsConfirmationReaderSchema, NeedsConfirmationSchema, SessionShareDeleteResponseReaderSchema, SessionShareDeleteResponseSchema } from "../../packages/contracts/src/index.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { proposeTaskOwnershipForPage, submitSlackTaskOwnership, routeDeveloperTaskRequest, type DeveloperTaskRouteDependencies } from "../../packages/broker/src/aws/developer-tasks.js";
import { StatusReply } from "../../packages/broker/src/aws/status-reply.js";
import { takeTaskOwnership } from "../../packages/broker/src/developer/task-people.js";
import { codeShareItems, undoCodeShare } from "../../packages/broker/src/rovara-code/sharing.js";
import { noticesOf } from "../../packages/broker/src/developer/notifications.js";
import { widenedShareMessage } from "../../packages/broker/src/developer/share-messages.js";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { createWorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { taskIndexKey, taskKey } from "../../packages/broker/src/developer/task-records.js";
import { ARJUN, PRIYA, ORG_A, ORG_B, sessionWorld } from "../support/agent-session-world.js";

beforeAll(loadSlackBroker);

function world() {
  const w = sessionWorld();
  const s = w.seedSession();
  const task = w.db.get(taskKey(s.taskId))!;
  w.db.set({ ...task, title: "Bump the Stripe SDK", client: "app", startingRevision: 1, workflow: createWorkflowSnapshot({ taskId: s.taskId, ownerId: PRIYA, now: new Date(w.clock.now).toISOString() }) });
  const deps = { documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore,
    origin: "https://cell.example.com", turnRecordsTableName: "turns", taskView: async () => { throw new Error("ADMITTED"); } } satisfies SessionRouteDependencies;
  w.db.set({ ...taskIndexKey(PRIYA, String(task.createdAt), s.taskId), taskId: s.taskId, shared: false });
  const notices = () => w.db.find((item) => item.entityType === "CHANGE_NOTICE");
  return { ...w, ...s, deps, notices };
}

describe("Rovara Code session shares", () => {
  it("narrowing is immediate and sends no owner notice", async () => {
    const w = world();
    w.seedShare(ORG_A, w.sessionId, { kind: "member", developerId: ARJUN }, "edit");
    const result = await putSessionShare(w.deps, w.caller(ARJUN), w.sessionId, { requestId: randomUUID(), principal: { kind: "member", developerId: ARJUN }, level: "view" });
    expect(result.status).toBe(200);
    expect(w.notices()).toEqual([]);
  });

  it("C1: deleting a widened member share revokes both grant and index", async () => {
    const w = world();
    w.seedShare(ORG_A, w.sessionId, { kind: "member", developerId: ARJUN }, "edit");
    w.seedShare(ORG_A, w.sessionId, { kind: "member", developerId: PRIYA }, "view");
    await putSessionShare(w.deps, w.caller(ARJUN), w.sessionId, { requestId: randomUUID(), principal: { kind: "member", developerId: PRIYA }, level: "use" });
    const [notice] = w.notices();
    expect(notice).toMatchObject({ by: ARJUN, sessionId: w.sessionId, undo: { principalKey: `MEMBER#${PRIYA}` } });
    await deleteSessionShare(w.deps, w.caller(PRIYA), w.sessionId, `MEMBER#${PRIYA}`);
    expect(w.db.get(agentSessionKey(ORG_A, w.sessionId, `SHARE#MEMBER#${PRIYA}`))).toBeUndefined();
    expect(w.db.get(sharedSessionsKey(ORG_A, { kind: "member", developerId: PRIYA }, w.sessionId))).toBeUndefined();
  });

  it("the legacy ownership primitive cannot bypass session confirmation", async () => {
    const w = world();
    w.seedShare(ORG_A, w.sessionId, { kind: "member", developerId: ARJUN }, "edit");
    await expect(takeTaskOwnership({ ...w.deps, agentSessions: w.deps }, w.caller(ARJUN), w.taskId, { requestId: randomUUID(), expectedPeopleRevision: 1 })).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    expect(w.db.get(taskKey(w.taskId))).not.toHaveProperty("currentOwner");
  });
});

it("the legacy MCP take-ownership route returns the session confirmation without moving authority", async () => {
  const w = world();
  w.seedShare(ORG_A, w.sessionId, { kind: "member", developerId: ARJUN }, "edit");
  const approvals = {
    store: new AgentStore({ documentClient: w.db, tableName: "state", now: () => w.clock.now }),
    documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members,
    signInStore: w.signInStore, agentSessions: w.deps, confirmOrigin: w.deps.origin,
    mintConfirmUrl: async () => "https://cell.example.com/v1/app/approve/test",
  };
  const path = `/v1/dev/tasks/${w.taskId}/people/take-ownership`;
  const before = structuredClone(w.db.get(taskKey(w.taskId)));
  const reply = await routeDeveloperTaskRequest({ ...w.deps, orgId: ORG_A, agentRuns: approvals } as unknown as DeveloperTaskRouteDependencies,
    w.caller(ARJUN), { method: "POST", path, requestId: randomUUID(), headers: {}, body: JSON.stringify({ requestId: randomUUID(), expectedPeopleRevision: 1 }) }, new URL(path, w.deps.origin));
  expect(reply).toBeInstanceOf(StatusReply);
  expect(reply).toMatchObject({ statusCode: 202, body: { status: "NEEDS_CONFIRMATION" } });
  const client = httpControlPlaneClient({ session: async () => ({ baseUrl: w.deps.origin, accessToken: "test-token", signInCommand: "test" }),
    fetch: async (_url, init) => {
      if (typeof init?.body !== "string") throw new Error("expected a serialized request");
      const response = await routeDeveloperTaskRequest({ ...w.deps, orgId: ORG_A, agentRuns: approvals } as unknown as DeveloperTaskRouteDependencies,
        w.caller(ARJUN), { method: "POST", path, requestId: randomUUID(), headers: {}, body: init.body }, new URL(path, w.deps.origin));
      if (!(response instanceof StatusReply)) throw new Error("expected confirmation");
      return new Response(JSON.stringify({ ...response.body, requestId: "transport" }), { status: response.statusCode, headers: { "content-type": "application/json" } });
    } });
  const tool = DEVELOPER_TOOLS.find((entry) => entry.name === "agentx_take_task_ownership")!;
  const result = await tool.handler({ client, newRequestId: randomUUID, now: () => w.clock.now } as never,
    { task_id: w.taskId, request_id: randomUUID(), expected_people_revision: 1 }, {} as never);
  expect(result.structured).toMatchObject({ status: "PENDING", confirmation_url: "https://cell.example.com/v1/app/approve/test" });

  expect(w.db.get(taskKey(w.taskId))).toEqual(before);
  expect(w.db.find((item) => item.subject !== undefined)).toEqual(expect.arrayContaining([expect.objectContaining({ subject: expect.objectContaining({ kind: "session_owner", sessionId: w.sessionId, to: ARJUN }) as unknown })]));
});

// Every Code session route is exercised with the same live authority table. Allowed callers
// reach each route's domain checks; denied callers must stop at authority, before any write.
const routes = [
  { method: "GET", tail: "", level: "view" },
  { method: "GET", tail: "/shares", level: "view" },
  { method: "GET", tail: "/events", level: "view" },
  { method: "POST", tail: "/answers", level: "use", body: { round: 1, answers: [{ questionId: "q1", text: "Yes" }] } },
  { method: "POST", tail: "/change-anyway", level: "use" },
  { method: "POST", tail: "/retry", level: "edit" },
  { method: "POST", tail: "/stop", level: "edit" },
  { method: "POST", tail: "/close", level: "edit" },
  { method: "POST", tail: "/messages", level: "use", body: { kind: "steer", text: "What should happen next?" } },
  { method: "POST", tail: "/messages", level: "view", body: { kind: "comment", text: "Please keep this comment for the team." } },
  { method: "POST", tail: "/take-over", level: "edit" },
  { method: "PUT", tail: "/shares", level: "edit", body: { principal: { kind: "member", developerId: PRIYA }, level: "view" } },
  { method: "DELETE", tail: `/shares/MEMBER%23${PRIYA}`, level: "edit" },
] as const;
const ranks = { view: 1, use: 2, edit: 3, owner: 4, removed: 0, otherOrg: 0 };
for (const route of routes) for (const standing of Object.keys(ranks) as Array<keyof typeof ranks>) {
  it(`${route.method} ${route.tail || "/"} ${"body" in route && "kind" in route.body ? route.body.kind : ""}: ${standing}`, async () => {
    const w = world();
    const who = standing === "owner" ? PRIYA : ARJUN;
    if (standing !== "owner" && standing !== "removed" && standing !== "otherOrg") w.seedShare(ORG_A, w.sessionId, { kind: "member", developerId: ARJUN }, standing);
    if (standing === "removed") w.db.delete(orgMemberKey(ORG_A, ARJUN));
    // Seed a target for DELETE so its permission check cannot be skipped by a missing share.
    w.seedShare(ORG_A, w.sessionId, { kind: "member", developerId: PRIYA }, "view", PRIYA);
    const url = new URL(`/v1/app/sessions/${w.sessionId}${route.tail}`, w.deps.origin);
    const before = w.db.transactions().length;
    let error: { code?: string } | undefined;
    try {
      await routeAgentSessionRequest(w.deps, w.caller(who, standing === "otherOrg" ? ORG_B : ORG_A), {
        method: route.method, path: url.pathname, requestId: randomUUID(), headers: {}, body: JSON.stringify({ requestId: randomUUID(), ...("body" in route ? route.body : {}) }),
      }, url);
    } catch (caught) { error = caught as { code?: string }; }
    if (ranks[standing] < ranks[route.level]) {
      expect(error?.code).toBe(standing === "removed" || standing === "otherOrg" ? "NOT_FOUND" : "SESSION_LEVEL_REQUIRED");
      expect(w.db.transactions()).toHaveLength(before);
    } else {
      expect(error?.code).not.toBe("SESSION_LEVEL_REQUIRED");
      expect(error?.code).not.toBe("NOT_FOUND");
      for (const code of ["FORBIDDEN", "TASK_ACCESS_DENIED", "PROJECT_ACCESS_DENIED", "AUTH_REQUIRED"]) expect(error?.code).not.toBe(code);
    }
  });
}

describe("legacy Slack sharing", () => {
  const share = { teamId: "T0TEAM001", channelId: "C0CHANNEL001", threadTs: "1695500000.000100", sharedReason: "requested" as const, sharedAt: "2026-10-22T08:00:00.000Z", mode: "view" as const };
  it("widens with the exact notice copy and the existing DELETE undo, and narrowing sends no notice", async () => {
    const w = world();
    const task = { ...w.db.get(taskKey(w.taskId)), title: "Retry the job", share, shareVersion: 1 } as unknown as DeveloperTaskRecord;
    const requestId = randomUUID();
    const next = { ...share, mode: "continue" as const };
    const items = codeShareItems("state", task, next, requestId, ARJUN, new Date(w.clock.now).toISOString());
    await w.db.send(new TransactWriteCommand({ TransactItems: items }));
    w.db.set({ ...task, share: next, shareVersion: 2, codeShareRequestId: requestId });
    expect(w.db.find((item) => item.text !== undefined)).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('shared "Retry the job" with') as unknown })]));
    const notice = w.notices()[0]!;
    expect(notice).toMatchObject({ by: ARJUN, sessionId: w.sessionId, undo: { principalKey: `SLACK#${requestId}` } });
    const undoUrl = `/v1/app/sessions/${w.sessionId}/shares/${encodeURIComponent(`SLACK#${requestId}`)}`;
    expect(widenedShareMessage({ actor: "Arjun", title: task.title, who: "#web", undoUrl })).toBe(`Arjun shared "Retry the job" with #web. Undo: ${undoUrl}`);
    const url = new URL(undoUrl, w.deps.origin);
    await routeAgentSessionRequest(w.deps, w.caller(PRIYA), { method: "DELETE", path: url.pathname, requestId: randomUUID(), headers: {} }, url);
    expect(w.db.get(taskKey(w.taskId))).toMatchObject({ share: { mode: "view" }, shareVersion: 3 });
    expect(codeShareItems("state", { ...task, share: next }, share, randomUUID(), ARJUN, new Date(w.clock.now).toISOString())).toEqual([]);
    expect(await undoCodeShare(w.deps, w.caller(PRIYA), w.sessionId, `SLACK#${requestId}`)).toEqual({ removed: false });
  });

  it("a stale undo cannot replace a later share, another org cannot use it", async () => {
    const w = world();
    const task = { ...w.db.get(taskKey(w.taskId)), share, shareVersion: 1 } as unknown as DeveloperTaskRecord;
    const requestId = randomUUID();
    await w.db.send(new TransactWriteCommand({ TransactItems: codeShareItems("state", task, { ...share, mode: "continue" }, requestId, ARJUN, new Date(w.clock.now).toISOString()) }));
    w.db.set({ ...task, codeShareRequestId: randomUUID() });
    const count = w.db.transactions().length;
    await expect(undoCodeShare(w.deps, w.caller(PRIYA), w.sessionId, `SLACK#${requestId}`)).rejects.toMatchObject({ code: "SESSION_REVISION_CONFLICT" });
    await expect(undoCodeShare(w.deps, w.caller(PRIYA, ORG_B), w.sessionId, `SLACK#${requestId}`)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(w.db.transactions()).toHaveLength(count);
  });
});

it("the real Code start and legacy Slack share route use session authority and support undo after thread posting", async () => {
  const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {} } });
  const started = await h.dev(MAYA, "POST", "/v1/app/projects/payments/code", { requestId: randomUUID(), path: "QUICK", input: { text: "Fix the retry" } });
  expect(started.status).toBe(202);
  const { taskId } = started.body.task as { taskId: string };
  const task = () => h.db.get(taskKey(taskId))!;
  const sessionId = String(task().sessionId);
  expect((await h.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/share`, { requestId: randomUUID(), shareMode: "view" })).status).toBe(200);
  markThreadPosted(h.db, taskId);
  const before = h.db.find((item) => item.entityType === "CHANGE_NOTICE").length;
  const requestId = randomUUID();
  expect((await h.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/share`, { requestId, shareMode: "continue" })).status).toBe(200);
  expect(h.db.find((item) => item.entityType === "CHANGE_NOTICE")).toHaveLength(before);
  const undo = await h.dev(MAYA, "DELETE", `/v1/app/sessions/${sessionId}/shares/${encodeURIComponent(`SLACK#${requestId}`)}`);
  expect(undo.status).toBe(200);
  expect(task()).toMatchObject({ share: { mode: "view" } });
  await h.orgOf(OMAR);
  expect((await h.dev(OMAR, "POST", `/v1/dev/tasks/${taskId}/share`, { requestId: randomUUID(), shareMode: "continue" })).status).toBe(404);
  h.db.delete(orgMemberKey(TEST_ORG, MAYA.developerId));
  expect((await h.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/share`, { requestId: randomUUID(), shareMode: "continue" })).status).not.toBe(200);
});

for (const level of ["view", "use", "edit", "owner", "removed", "otherOrg"] as const) {
  it(`legacy POST share: ${level} (live session authority)`, async () => {
    const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {} }, ...(level === "otherOrg" ? { orgResolver: async (subject) => subject.developerId === OMAR.developerId ? ORG_B : TEST_ORG } : {}) });
    const started = await h.dev(MAYA, "POST", "/v1/app/projects/payments/code", { requestId: randomUUID(), path: "QUICK", input: { text: "Fix the retry" } });
    const { taskId } = started.body.task as { taskId: string };
    const task = h.db.get(taskKey(taskId))!;
    const actor = level === "owner" || level === "removed" ? MAYA : OMAR;
    await h.orgOf(actor);
    if (actor === OMAR && level !== "otherOrg") {
      h.db.set({ ...projectMemberKey(TEST_ORG, OMAR.developerId, "payments"), role: "developer", projectRole: "contributor" });
      h.db.set({ ...agentSessionKey(TEST_ORG, String(task.sessionId), `SHARE#MEMBER#${OMAR.developerId}`), principal: { kind: "member", developerId: OMAR.developerId }, level, sharedBy: { developerId: MAYA.developerId, name: MAYA.name }, sharedAt: new Date().toISOString() });
    }
    if (level === "removed") h.db.delete(orgMemberKey(TEST_ORG, MAYA.developerId));
    const writes = h.db.transactions().length;
    const result = await h.dev(actor, "POST", `/v1/dev/tasks/${taskId}/share`, { requestId: randomUUID(), shareMode: "view" });
    if (level === "edit" || level === "owner") expect(result.status).toBe(200);
    else {
      expect(result.status).not.toBe(200);
      if (level === "otherOrg") {
        expect(result.body.error).toMatchObject({ code: "TASK_NOT_FOUND" });
        expect(h.db.get(taskKey(taskId))!.orgId).toBe(TEST_ORG);
      }
      expect(h.db.transactions()).toHaveLength(writes);
    }
  });
}

it("a Code company share narrows immediately, while widening still needs confirmation", async () => {
  const w = world();
  w.seedShare(ORG_A, w.sessionId, { kind: "org" }, "edit");
  const result = await putSessionShare(w.deps, w.caller(PRIYA), w.sessionId, { requestId: randomUUID(), principal: { kind: "org" }, level: "view" });
  expect(result.status).toBe(200);
  expect(w.notices()).toEqual([]);
  await expect(putSessionShare(w.deps, w.caller(PRIYA), w.sessionId, { requestId: randomUUID(), principal: { kind: "org" }, level: "edit" })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
});

it("narrowing a Code Slack thread emits no notification; plain task behavior stays the same", () => {
  const base = { entityType: "DEVELOPER_TASK", taskId: randomUUID(), share: { mode: "continue" } };
  const next = { ...base, share: { mode: "view" } };
  expect(noticesOf(base, next, "2026-10-26T12:00:00.000Z", "event")).toEqual([expect.objectContaining({ kind: "mode" })]);
  const workflow = { definitionId: "agentx-task-to-pr" };
  expect(noticesOf({ ...base, workflow }, { ...next, workflow }, "2026-10-26T12:00:00.000Z", "event")).toEqual([]);
});

it("I4: undoing an initial posted Slack share removes both binding directions", async () => {
  const w = world();
  const task = { ...w.db.get(taskKey(w.taskId)), title: "Retry" } as unknown as DeveloperTaskRecord;
  const share = { teamId: "T0TEAM001", channelId: "C0CHANNEL001", sharedReason: "requested" as const, sharedAt: new Date(w.clock.now).toISOString(), mode: "continue" as const };
  const requestId = randomUUID();
  await w.db.send(new TransactWriteCommand({ TransactItems: codeShareItems("state", task, share, requestId, ARJUN, share.sharedAt) }));
  // Posting the thread advances shareVersion but preserves the request marker.
  w.db.set({ ...task, share: { ...share, threadTs: "1695500000.000100" }, shared: true, shareVersion: 2, codeShareRequestId: requestId });
  const binding = { kind: "slack_thread" as const, teamId: share.teamId, channelId: share.channelId, threadTs: "1695500000.000100" };
  await w.db.send(new TransactWriteCommand({ TransactItems: bindingItemsForOpenSession(w.deps, ORG_A, w.sessionId, binding, share.sharedAt) }));
  expect(await sessionForSurface(w.deps, ORG_A, binding)).toBeDefined();
  await undoCodeShare(w.deps, w.caller(PRIYA), w.sessionId, `SLACK#${requestId}`);
  expect(w.db.get(taskKey(w.taskId))).toMatchObject({ shared: false, developerId: PRIYA });
  expect(w.db.get(taskKey(w.taskId))).not.toHaveProperty("share");
  expect(w.db.get(sessionBindingKey(ORG_A, w.sessionId, "slack_thread"))).toBeUndefined();
  expect(w.db.get(sessionSurfaceKey(ORG_A, binding))).toBeUndefined();
  expect(await sessionForSurface(w.deps, ORG_A, binding)).toBeUndefined();
});

it("expired and malformed undo records fail closed with no writes", async () => {
  const w = world();
  const requestId = randomUUID();
  const key = agentSessionKey(ORG_A, w.sessionId, `SHARE#SLACK#${requestId}`);
  const task = w.db.get(taskKey(w.taskId))!;
  w.db.set({ ...task, share: { teamId: "T0TEAM001", channelId: "C0CHANNEL001", mode: "continue" }, shareVersion: 2, codeShareRequestId: requestId });
  for (const record of [
    { previousShare: null, expiresAt: Math.floor(w.clock.now / 1000) - 1 },
    { previousShare: { mode: "continue" }, expiresAt: Math.floor(w.clock.now / 1000) + 600 },
  ]) {
    w.db.set({ ...key, orgId: ORG_A, taskId: w.taskId, ...record });
    const count = w.db.transactions().length;
    await expect(undoCodeShare(w.deps, w.caller(PRIYA), w.sessionId, `SLACK#${requestId}`)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(w.db.transactions()).toHaveLength(count);
  }
});

it("widening resolves the effective owner from the current task rather than its creator", async () => {
  const w = world();
  const at = new Date(w.clock.now).toISOString();
  const task = { ...w.db.get(taskKey(w.taskId)), currentOwner: { developerId: ARJUN, name: "Arjun", provider: "oidc", since: at } } as unknown as DeveloperTaskRecord;
  const items = codeShareItems("state", task, { teamId: "T0TEAM001", channelId: "C0CHANNEL001", mode: "view", sharedAt: at, sharedReason: "requested" }, randomUUID(), PRIYA, at);
  await w.db.send(new TransactWriteCommand({ TransactItems: items }));
  expect(w.notices()).toHaveLength(1);
  expect(w.notices()[0]).toMatchObject({ pk: changesKey(ORG_A, ARJUN, at, 0).pk, by: PRIYA });
});

for (const [surface, propose] of [["page", proposeTaskOwnershipForPage], ["Slack", submitSlackTaskOwnership]] as const) {
  it(`I2: ${surface} ownership returns the session_owner confirmation`, async () => {
    const w = world();
    w.seedShare(ORG_A, w.sessionId, { kind: "member", developerId: ARJUN }, "edit");
    const approvals = { store: new AgentStore({ documentClient: w.db, tableName: "state", now: () => w.clock.now }),
      ...w.deps, agentSessions: w.deps, confirmOrigin: w.deps.origin, mintConfirmUrl: async () => "https://cell.example.com/v1/app/approve/test" };
    const before = structuredClone(w.db.get(taskKey(w.taskId)));
    const result = await propose({ ...w.deps, orgId: ORG_A, issuer: w.deps.origin, agentRuns: approvals } as unknown as DeveloperTaskRouteDependencies,
      w.caller(ARJUN), w.taskId, { requestId: randomUUID(), expectedPeopleRevision: 1 });
    expect(result).toMatchObject({ status: "PENDING", confirmationUrl: "https://cell.example.com/v1/app/approve/test" });
    expect(w.db.get(taskKey(w.taskId))).toEqual(before);
    expect(w.db.find((item) => (item.subject as { kind?: string } | undefined)?.kind === "session_owner")).toHaveLength(1);
    expect(w.db.find((item) => item.entityType === "TASK_PEOPLE_PROPOSAL")).toEqual([]);
  });
}

it("I3: Slack share undo atomically records its actor, audit turn, event and session revision", async () => {
  const w = world();
  const at = new Date(w.clock.now).toISOString();
  const task = w.db.get(taskKey(w.taskId)) as unknown as DeveloperTaskRecord;
  const share = { teamId: "T0TEAM001", channelId: "C0CHANNEL001", mode: "view" as const, sharedAt: at, sharedReason: "requested" as const };
  const requestId = randomUUID();
  await w.db.send(new TransactWriteCommand({ TransactItems: codeShareItems("state", task, share, requestId, ARJUN, at) }));
  w.db.set({ ...task, share, shared: true, shareVersion: 1, codeShareRequestId: requestId });
  const revision = Number(w.db.get(agentSessionKey(ORG_A, w.sessionId, "META"))!.revision);
  await undoCodeShare(w.deps, w.caller(PRIYA), w.sessionId, `SLACK#${requestId}`);
  expect(w.db.get(agentSessionKey(ORG_A, w.sessionId, "META"))!.revision).toBe(revision + 1);
  expect(w.db.find((item) => item.action === "share")).toEqual([expect.objectContaining({ developer: { developerId: PRIYA, provider: "oidc", displayName: "Priya" } })]);
  expect(w.db.find((item) => typeof item.text === "string" && item.text.includes("undid sharing"))).toEqual([expect.objectContaining({ actor: { kind: "member", developerId: PRIYA, name: "Priya" } })]);
  const tx = w.db.transactions().at(-1)!;
  expect(tx.some((entry) => (entry.Put as { TableName?: string } | undefined)?.TableName === "turns")).toBe(true);
});

for (const level of ["view", "use"] as const) it(`M1: ${level} cannot undo a Slack share`, async () => {
  const w = world();
  w.seedShare(ORG_A, w.sessionId, { kind: "member", developerId: ARJUN }, level);
  const task = w.db.get(taskKey(w.taskId)) as unknown as DeveloperTaskRecord;
  const at = new Date(w.clock.now).toISOString();
  const share = { teamId: "T0TEAM001", channelId: "C0CHANNEL001", mode: "view" as const, sharedAt: at, sharedReason: "requested" as const };
  const requestId = randomUUID();
  await w.db.send(new TransactWriteCommand({ TransactItems: codeShareItems("state", task, share, requestId, PRIYA, at) }));
  w.db.set({ ...task, share, shared: true, shareVersion: 1, codeShareRequestId: requestId });
  const writes = w.db.transactions().length;
  await expect(undoCodeShare(w.deps, w.caller(ARJUN), w.sessionId, `SLACK#${requestId}`)).rejects.toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
  expect(w.db.transactions()).toHaveLength(writes);
  expect(w.db.get(taskKey(w.taskId))).toMatchObject({ shared: true, shareVersion: 1 });
});

it("M1: an owner change racing sharing aborts the write and reauthorizes", async () => {
  const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {} } });
  const started = await h.dev(MAYA, "POST", "/v1/app/projects/payments/code", { requestId: randomUUID(), path: "QUICK", input: { text: "Fix retry" } });
  const { taskId } = started.body.task as { taskId: string };
  await h.orgOf(OMAR);
  const send = h.db.send;
  let raced = false;
  h.db.send = async (command) => {
    if (!raced && command instanceof TransactWriteCommand && command.input.TransactItems?.some((entry) => entry.Update?.UpdateExpression?.includes("codeShareRequestId"))) {
      raced = true;
      h.db.set({ ...h.db.get(taskKey(taskId)), currentOwner: { developerId: OMAR.developerId, name: OMAR.name, provider: OMAR.provider, since: new Date().toISOString() } });
    }
    return send(command);
  };
  const reply = await h.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/share`, { requestId: randomUUID(), shareMode: "continue" });
  expect(raced).toBe(true);
  expect(reply.body.error).toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
  expect(h.db.get(taskKey(taskId))).not.toHaveProperty("share");
  expect(h.db.find((item) => item.entityType === "CODE_SHARE_UNDO")).toEqual([]);
});

it("M2: revoking an editor share before transact aborts widening and reauthorizes", async () => {
  const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {} } });
  const started = await h.dev(MAYA, "POST", "/v1/app/projects/payments/code", { requestId: randomUUID(), path: "QUICK", input: { text: "Fix retry" } });
  const { taskId } = started.body.task as { taskId: string };
  const sessionId = String(h.db.get(taskKey(taskId))!.sessionId);
  await h.orgOf(OMAR);
  h.db.set({ ...projectMemberKey(TEST_ORG, OMAR.developerId, "payments"), role: "developer", projectRole: "contributor" });
  const key = agentSessionKey(TEST_ORG, sessionId, `SHARE#MEMBER#${OMAR.developerId}`);
  h.db.set({ ...key, principal: { kind: "member", developerId: OMAR.developerId }, level: "edit", sharedBy: { developerId: MAYA.developerId, name: MAYA.name }, sharedAt: new Date().toISOString() });
  const send = h.db.send;
  let raced = false;
  h.db.send = async (command) => {
    if (!raced && command instanceof TransactWriteCommand && command.input.TransactItems?.some((entry) => entry.Update?.UpdateExpression?.includes("codeShareRequestId"))) {
      raced = true;
      h.db.delete(key);
      const meta = h.db.get(agentSessionKey(TEST_ORG, sessionId, "META"))!;
      h.db.set({ ...meta, revision: Number(meta.revision) + 1 });
    }
    return send(command);
  };
  const result = await h.dev(OMAR, "POST", `/v1/dev/tasks/${taskId}/share`, { requestId: randomUUID(), shareMode: "continue" });
  expect(raced).toBe(true);
  expect(result.body.error).toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
  expect(h.db.get(taskKey(taskId))).not.toHaveProperty("share");
  expect(h.db.find((item) => item.entityType === "CODE_SHARE_UNDO")).toEqual([]);
});

for (const stage of ["CLOSED", "MERGED"] as const) it(`M3: ${stage} Code work cannot be newly shared`, async () => {
  const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {} } });
  const started = await h.dev(MAYA, "POST", "/v1/app/projects/payments/code", { requestId: randomUUID(), path: "QUICK", input: { text: "Fix retry" } });
  const { taskId } = started.body.task as { taskId: string };
  const task = h.db.get(taskKey(taskId))!;
  h.db.set({ ...task, workflow: { ...(task.workflow as Record<string, unknown>), stage, state: "COMPLETE", outcome: "PASSED" } });
  const response = await h.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/share`, { requestId: randomUUID(), shareMode: "continue" });
  expect(response.body.error).toMatchObject({ code: "CONFIG_INVALID" });
  expect(h.db.get(taskKey(taskId))).not.toHaveProperty("share");
  expect(h.db.find((item) => item.entityType === "CODE_SHARE_UNDO")).toEqual([]);
});

it("M5: widening copy links to the deployment origin", () => {
  const w = world();
  const task = w.db.get(taskKey(w.taskId)) as unknown as DeveloperTaskRecord;
  const at = new Date(w.clock.now).toISOString();
  const items = codeShareItems("state", task, { teamId: "T0TEAM001", channelId: "C0CHANNEL001", mode: "view", sharedAt: at, sharedReason: "requested" }, randomUUID(), ARJUN, at, "Arjun", w.deps.origin);
  const event = items.find((entry) => entry.Put?.Item?.text !== undefined)?.Put?.Item;
  expect(event?.text).toContain(`Undo: ${w.deps.origin}/v1/app/sessions/${w.sessionId}/shares/`);
});

it("M5: requests sharing a UUID prefix do not overwrite same-millisecond owner notices", async () => {
  const w = world();
  const task = w.db.get(taskKey(w.taskId)) as unknown as DeveloperTaskRecord;
  const at = new Date(w.clock.now).toISOString();
  for (const requestId of ["11111000-0000-4000-8000-000000000001", "11111000-0000-4000-8000-000000000002"]) {
    await w.db.send(new TransactWriteCommand({ TransactItems: codeShareItems("state", task, { teamId: "T0TEAM001", channelId: "C0CHANNEL001", mode: "view", sharedAt: at, sharedReason: "requested" }, requestId, ARJUN, at) }));
  }
  expect(w.notices()).toHaveLength(2);
});

it("M6: undo cannot create a phantom current-owner index row", async () => {
  const w = world();
  const at = new Date(w.clock.now).toISOString();
  const task = { ...w.db.get(taskKey(w.taskId)), currentOwner: { developerId: ARJUN, name: "Arjun", provider: "oidc", since: at } } as unknown as DeveloperTaskRecord;
  const share = { teamId: "T0TEAM001", channelId: "C0CHANNEL001", mode: "view" as const, sharedAt: at, sharedReason: "requested" as const };
  const requestId = randomUUID();
  await w.db.send(new TransactWriteCommand({ TransactItems: codeShareItems("state", task, share, requestId, PRIYA, at) }));
  w.db.set({ ...task, share, shared: true, shareVersion: 1, codeShareRequestId: requestId });
  const index = taskIndexKey(ARJUN, task.createdAt, w.taskId);
  expect(w.db.get(index)).toBeUndefined();
  await expect(undoCodeShare(w.deps, w.caller(ARJUN), w.sessionId, `SLACK#${requestId}`)).rejects.toBeDefined();
  expect(w.db.get(index)).toBeUndefined();
  expect(w.db.get(taskKey(w.taskId))).toMatchObject({ shared: true, shareVersion: 1 });
});

it("M8: a company grant disappearing before narrowing cannot become an unconfirmed share", async () => {
  const w = world();
  w.seedShare(ORG_A, w.sessionId, { kind: "org" }, "edit");
  const key = agentSessionKey(ORG_A, w.sessionId, "SHARE#ORG");
  const send = w.db.send;
  let raced = false;
  w.db.send = async (command) => {
    if (!raced && command instanceof TransactWriteCommand && command.input.TransactItems?.some((entry) => entry.Put?.Item?.sk === "SHARE#ORG")) {
      raced = true;
      w.db.delete(key); // TTL-style removal does not bump the session revision.
    }
    return send(command);
  };
  await expect(putSessionShare(w.deps, w.caller(PRIYA), w.sessionId, { requestId: randomUUID(), principal: { kind: "org" }, level: "view" })).rejects.toBeDefined();
  expect(raced).toBe(true);
  expect(w.db.get(key)).toBeUndefined();
});

it("M9: legacy Code ownership creates its missing session before requesting confirmation", async () => {
  const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {} } });
  const started = await h.dev(MAYA, "POST", "/v1/app/projects/payments/code", { requestId: randomUUID(), path: "QUICK", input: { text: "Fix retry" } });
  const { taskId } = started.body.task as { taskId: string };
  const task = { ...h.db.get(taskKey(taskId))! };
  h.db.delete(agentSessionKey(TEST_ORG, String(task.sessionId), "META"));
  delete task.sessionId;
  h.db.set(task);
  await h.orgOf(OMAR);
  h.db.set({ ...projectMemberKey(TEST_ORG, OMAR.developerId, "payments"), role: "developer", projectRole: "maintainer" });
  const result = await h.dev(OMAR, "POST", `/v1/dev/tasks/${taskId}/people/take-ownership`, { requestId: randomUUID(), expectedPeopleRevision: 1 });
  expect(result.status).toBe(202);
  expect(result.body).toMatchObject({ status: "NEEDS_CONFIRMATION" });
  const sessionId = String(h.db.get(taskKey(taskId))!.sessionId);
  expect(h.db.get(agentSessionKey(TEST_ORG, sessionId, "META"))).toMatchObject({ owner: { developerId: MAYA.developerId } });
  expect(h.db.get(taskKey(taskId))).not.toHaveProperty("currentOwner");
  expect(h.db.find((item) => (item.subject as { kind?: string } | undefined)?.kind === "session_owner")).toHaveLength(1);
});

// Task 23 re-check N2 (C43 b): the ownership route checked only "same org" before it made the task's missing session row; the take-over then refused the caller. The row is made only for a caller who may take it over.
for (const [who, setup] of [
  ["an org member with no access to the task", undefined],
  ["a project viewer", "viewer"],
] as const) it(`N2: ${who} cannot make the task's session row by asking to take ownership`, async () => {
  const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {} } });
  const started = await h.dev(MAYA, "POST", "/v1/app/projects/payments/code", { requestId: randomUUID(), path: "QUICK", input: { text: "Fix retry" } });
  const { taskId } = started.body.task as { taskId: string };
  const task = { ...h.db.get(taskKey(taskId))! };
  h.db.delete(agentSessionKey(TEST_ORG, String(task.sessionId), "META"));
  delete task.sessionId;
  h.db.set(task);
  await h.orgOf(OMAR);
  if (setup !== undefined) h.db.set({ ...projectMemberKey(TEST_ORG, OMAR.developerId, "payments"), role: "developer", projectRole: setup });
  const before = h.db.find(() => true).length;
  const result = await h.dev(OMAR, "POST", `/v1/dev/tasks/${taskId}/people/take-ownership`, { requestId: randomUUID(), expectedPeopleRevision: 1 });
  expect(result.status).toBeGreaterThanOrEqual(400);
  expect(h.db.get(taskKey(taskId))).not.toHaveProperty("sessionId");
  expect(h.db.find((item) => item.entityType === "AGENT_SESSION" || item.sk === "META" && String(item.pk).startsWith("AGENTSESSION#"))).toEqual([]);
  expect(h.db.find(() => true).length).toBe(before);
});

it("M4: an owner's own widening keeps its undo without sending a self-notice", () => {
  const w = world();
  const task = w.db.get(taskKey(w.taskId)) as unknown as DeveloperTaskRecord;
  const at = new Date(w.clock.now).toISOString();
  const items = codeShareItems("state", task, { teamId: "T0TEAM001", channelId: "C0CHANNEL001", mode: "view", sharedAt: at, sharedReason: "requested" }, randomUUID(), PRIYA, at);
  expect(items.some((entry) => entry.Put?.Item?.entityType === "CODE_SHARE_UNDO")).toBe(true);
  expect(items.filter((entry) => entry.Put?.Item?.entityType === "CHANGE_NOTICE")).toEqual([]);
});

it("I2 ingress: a Slack ownership action returns the session confirmation link", async () => {
  const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {} }, channelMembers: async (request) => ({ ok: true, memberOf: [...request.channelIds] }) });
  const started = await h.dev(MAYA, "POST", "/v1/app/projects/payments/code", { requestId: randomUUID(), path: "QUICK", input: { text: "Fix retry" } });
  const { taskId } = started.body.task as { taskId: string };
  expect((await h.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/share`, { requestId: randomUUID(), shareMode: "view" })).status).toBe(200);
  markThreadPosted(h.db, taskId);
  const task = h.db.get(taskKey(taskId))!;
  const share = task.share as { teamId: string; channelId: string; threadTs: string };
  const userId = "U0TAKER01";
  const developerId = developerIdForSlackUser(userId);
  h.db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, provider: "slack", slackUserId: userId, displayName: "Taker", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  h.db.set({ ...projectMemberKey(TEST_ORG, developerId, "payments"), role: "developer", projectRole: "maintainer" });
  const response = await h.handler({ source: "agentx.slack-ingress", action: "task-people-take-ownership", taskId, requestId: randomUUID(), expectedPeopleRevision: 1, userId,
    thread: { teamId: share.teamId, channelId: share.channelId, threadTs: share.threadTs } });
  const body = JSON.parse(response.body) as { status?: string; confirmationUrl?: string };
  expect(body.status).toBe("PENDING");
  expect(body.confirmationUrl).toContain("/v1/app/approve/apr_");
  expect(h.db.get(taskKey(taskId))).not.toHaveProperty("currentOwner");
});

for (const state of ["missing", "other-org"] as const) it(`M7: principal DELETE still narrows when the task is ${state}`, async () => {
  const w = world();
  const principal = { kind: "member" as const, developerId: ARJUN };
  await putSessionShare(w.deps, w.caller(PRIYA), w.sessionId, { requestId: randomUUID(), principal, level: "view" });
  const key = agentSessionKey(ORG_A, w.sessionId, `SHARE#MEMBER#${ARJUN}`);
  expect(w.db.get(key)).toBeDefined();
  expect(w.db.get(sharedSessionsKey(ORG_A, principal, w.sessionId))).toBeDefined();
  if (state === "missing") w.db.delete(taskKey(w.taskId));
  else w.db.set({ ...w.db.get(taskKey(w.taskId)), orgId: ORG_B });
  expect(await deleteSessionShare(w.deps, w.caller(PRIYA), w.sessionId, `MEMBER#${ARJUN}`)).toEqual({ removed: true });
  expect(w.db.get(key)).toBeUndefined();
  expect(w.db.get(sharedSessionsKey(ORG_A, principal, w.sessionId))).toBeUndefined();
});

// ---- round trip (bug E): what the broker really answers, read by the schema each client reads it with

it("round trip: the sharing and ownership answers of a Code task, as the broker sends them and the MCP client reads them", async () => {
  const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {} } });
  const started = await h.dev(MAYA, "POST", "/v1/app/projects/payments/code", { requestId: randomUUID(), path: "QUICK", input: { text: "Fix the retry" } });
  expect(started.status).toBe(202);
  const { taskId } = started.body.task as { taskId: string };
  const sessionId = String(h.db.get(taskKey(taskId))!.sessionId);
  // The MCP client over the real broker handler, as `who` (the handler's own bytes, requestId included, are what it parses).
  const clientFor = async (who: typeof MAYA) => httpControlPlaneClient({ session: async () => ({ baseUrl: "https://cell.example.com", accessToken: (await bearerFor(who, await h.orgOf(who))).replace(/^Bearer /, ""), signInCommand: "test" }),
    fetch: async (url, init) => {
      const target = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      const response = await h.handler({ version: "2.0", rawPath: target.pathname, rawQueryString: target.search.slice(1), headers: Object.fromEntries(new Headers(init?.headers).entries()),
        ...(typeof init?.body === "string" ? { body: init.body } : {}), requestContext: { requestId: randomUUID(), http: { method: init?.method ?? "GET" } } });
      return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
    } });

  // POST /share answers { task }: the MCP client reads it with DeveloperTaskResponseSchema.
  const shareId = randomUUID();
  const shared = await (await clientFor(MAYA)).shareTask(taskId, { requestId: shareId, shareMode: "view" } as never);
  expect(shared).toMatchObject({ taskId });

  // DELETE …/shares/SLACK#<request> (the undo of a legacy share) answers { removed }.
  markThreadPosted(h.db, taskId);
  const requestId = randomUUID();
  expect((await h.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/share`, { requestId, shareMode: "continue" })).status).toBe(200);
  const undo = await h.dev(MAYA, "DELETE", `/v1/app/sessions/${sessionId}/shares/${encodeURIComponent(`SLACK#${requestId}`)}`);
  expect(undo.status).toBe(200);
  expect(SessionShareDeleteResponseReaderSchema.safeParse(undo.body).success).toBe(true);
  const { requestId: _gateway, ...own } = undo.body; // eslint-disable-line @typescript-eslint/no-unused-vars -- set aside on purpose
  expect(SessionShareDeleteResponseSchema.safeParse(own).success).toBe(true);

  // POST …/people/take-ownership answers 202 NEEDS_CONFIRMATION for a Code task: the reader and the MCP client both read it.
  await h.orgOf(OMAR);
  h.db.set({ ...projectMemberKey(TEST_ORG, OMAR.developerId, "payments"), role: "developer", projectRole: "maintainer" });
  const ownership = await h.dev(OMAR, "POST", `/v1/dev/tasks/${taskId}/people/take-ownership`, { requestId: randomUUID(), expectedPeopleRevision: 1 });
  expect(ownership.status, JSON.stringify(ownership.body)).toBe(202);
  expect(typeof ownership.body.requestId).toBe("string");
  expect(NeedsConfirmationReaderSchema.safeParse(ownership.body).success).toBe(true);
  const { requestId: _transport, ...ownConfirmation } = ownership.body; // eslint-disable-line @typescript-eslint/no-unused-vars -- set aside on purpose
  expect(NeedsConfirmationSchema.safeParse(ownConfirmation).success).toBe(true);
  const taken = await (await clientFor(OMAR)).takeTaskOwnership(taskId, { requestId: randomUUID(), expectedPeopleRevision: 1 });
  expect(taken).toMatchObject({ status: "PENDING" });
});
