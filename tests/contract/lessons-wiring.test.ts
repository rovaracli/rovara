// L3b wiring: the lessons routes on the developer routes. Off unless the install wired the lesson ports AND learning is on for the project; the Auditor reads and writes nothing else;
// a write needs a live browser session; per-person rate rows; and "what the agent loaded" is reachable. Real dispatcher, real rate rows (a fake table), fake lesson ports.
import { describe, expect, it } from "vitest";
import { AgentXError, developerOrgKey, errorStatus, orgMemberKey, orgMetaKey, projectMetaKey, projectRevisionKey, type OrgId } from "@agentx/contracts";
import { routeDeveloperRequest, type DeveloperCaller, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { InMemoryLessonStore } from "../../packages/broker/src/lessons/store.js";
import { lessonRouteDependenciesOf } from "../../packages/broker/src/aws/developer-routes/lessons.js";
import { LESSON_RATES } from "../../packages/broker/src/lessons/routes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { withLessonAudiences } from "../../packages/broker/src/lessons/task-audience.js";
import type { AccessCheckPort } from "../../packages/broker/src/team-record/access-port.js";
import { Alerts, Audit, Clock, MemoryVectors, ScriptedModel, Spend, directory, embedder, facts, Judge, lessonRecord, seed, settings, verifier, wideAudience } from "../unit/lessons/lesson-helpers.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId, me = "a".repeat(64), other = "b".repeat(64), auditorId = "c".repeat(64);
const BASE = "/v1/app/projects/demo/lessons";
const names = { memberName: async () => "Priya", isErased: async () => false };
// Every task is open to the whole project "demo" (the shared fake in lesson-helpers.ts answers for its own project, so the live check of a lesson's source tasks would withhold every lesson here).
const allowAllAccess: AccessCheckPort = {
  mayRead: async (_org, _viewer, places) => places.map(() => true),
  taskVisibility: withLessonAudiences({ read: async (_org, ids) => new Map(ids.map((id) => [id, { kind: "shared" as const }])) }, { read: async (_org, ids) => new Map(ids.map((id) => [id, wideAudience({ project: "demo" })])) }),
};

function fixture(over: { wired?: boolean; settings?: Parameters<typeof settings>[0] } = {}) {
  const db = new FakeDynamoDb();
  for (const [id, role] of [[me, "owner"], [other, "owner"], [auditorId, "auditor"]] as const) {
    db.set({ ...orgMemberKey(A, id), orgId: A, developerId: id, role, joinedAt: "2026-10-01T00:00:00.000Z" });
    db.set({ ...developerOrgKey(id), orgId: A, developerId: id, role });
    db.set({ pk: `DEVELOPER#${id}`, sk: "META", displayName: id.slice(0, 4), provider: "cloud" });
  }
  db.set({ ...orgMetaKey(A), orgId: A, name: "Company", plan: "team" });
  db.set({ ...projectRevisionKey(A, "demo", 1), entityType: "PROJECT", definition: { name: "demo", revision: 1 } });
  db.set({ ...projectMetaKey(A, "demo"), entityType: "PROJECT_META", name: "demo", status: "active" });
  const store = new InMemoryLessonStore();
  const clock = new Clock(Date.parse("2026-10-26T12:00:00Z"));
  const lessons = {
    store, directory: directory({ eligibleIds: [me, other], ownerIds: [me], complete: true }), settings: settings(over.settings ?? {}), access: allowAllAccess, audit: new Audit(), now: clock.now, names,
    embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), alerts: new Alerts(), verifier: verifier("valid"), facts: facts(), judge: new Judge(), sources: { table: { documentClient: db, tableName: "state" } },
  };
  const deps = {
    tableName: "state", now: () => clock.now(), documentClient: db,
    developer: { issuer: "https://cell.example/v1/auth", env: "test", methods: { slack: false, oidc: false, cloud: true }, signInTableName: "signin", verifyAccessToken: async () => ({}), channelMembers: async () => ({ ok: true, memberOf: [] }) },
    orgs: new OrgStore({ tableName: "state", documentClient: db, now: Date.now }), ...(over.wired === false ? {} : { lessons }),
  } as unknown as DeveloperRouteDependencies;
  const callerOf = (developerId: string, orgRole: string, browser = true): DeveloperCaller => ({ orgId: A, developerId, orgRole, name: "n", amr: "cloud", sessionId: "s", ...(browser ? { browserSession: true as const } : {}) }) as unknown as DeveloperCaller;
  async function request(method: string, path: string, body?: unknown, as: DeveloperCaller = callerOf(me, "owner")) {
    try { return { status: 200, body: await routeDeveloperRequest(deps, { method, path, headers: {}, requestId: "t", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, new URL(path, "https://cell.example"), { caller: as, csrf: "" }) as Record<string, unknown> }; }
    catch (error) { if (!(error instanceof AgentXError)) throw error; return { status: errorStatus(error.code), body: { error: { code: error.code } } }; }
  }
  return { db, store, lessons, deps, request, callerOf };
}
const codeOf = (answer: { body: unknown }): string => (answer.body as { error: { code: string } }).error.code;
const pending = (over = {}) => lessonRecord({ id: "les_pend0001", project: "demo", workspaceId: A, status: "pending", tier: 1, tierReasons: ["not_a_fact"], approvals: [], type: "convention", pendingExpiresAt: 9e15, provenance: { ...lessonRecord().provenance, authors: ["carl"] }, ...over });

describe("off unless wired and on", () => {
  it("an install with no lesson ports answers exactly as for a path that does not exist", async () => {
    const f = fixture({ wired: false });
    const missing = await f.request("GET", "/v1/app/projects/demo/lessonz");
    expect(await f.request("GET", BASE)).toEqual(missing);
    expect(await f.request("GET", BASE + "/sources")).toEqual(missing);
    expect(await f.request("POST", BASE + "/les_pend0001/approve", { expectedVersion: 1 })).toMatchObject({ status: missing.status });
  });
  it("a wired install answers the read for a project whose learning is on", async () => {
    const f = fixture();
    await seed(f.store, pending({ workspaceId: A }));
    const answer = await f.request("GET", BASE);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ mode: "On", canDecide: true, waiting: [{ id: "les_pend0001" }] });
  });
  it("with the project's learning Off every lessons route answers not found and changes nothing", async () => {
    const f = fixture({ settings: { mode: "Off" } });
    await seed(f.store, pending());
    for (const [method, path, body] of [["GET", BASE], ["GET", BASE + "/digest"], ["GET", BASE + "/sources"], ["GET", BASE + "/les_pend0001/history"], ["POST", BASE + "/les_pend0001/approve", { expectedVersion: 1 }], ["POST", BASE + "/les_pend0001/reject", { expectedVersion: 1, reason: "no" }], ["POST", BASE + "/les_pend0001/merge", { expectedVersion: 1 }], ["POST", BASE + "/les_pend0001/retire", {}], ["POST", BASE + "/rollback", { targetSetVersion: 0, expectedSetVersion: 1 }]] as const) {
      const answer = await f.request(method, path, body);
      expect(answer.status, `${method} ${path}`).toBe(404);
    }
    expect((await f.store.get({ workspaceId: A, project: "demo" }, "les_pend0001"))!.status).toBe("pending");
  });
  it("an unknown project is the same refusal as everywhere else", async () => {
    const f = fixture();
    expect(codeOf(await f.request("GET", "/v1/app/projects/nope/lessons"))).toBe("PROJECT_NOT_FOUND");
  });
});

describe("writes", () => {
  it("need a live browser session: a token caller is refused and nothing changes", async () => {
    const f = fixture();
    await seed(f.store, pending());
    const answer = await f.request("POST", BASE + "/les_pend0001/approve", { expectedVersion: 1 }, f.callerOf(me, "owner", false));
    expect(codeOf(answer)).toBe("FORBIDDEN");
    expect((await f.store.get({ workspaceId: A, project: "demo" }, "les_pend0001"))!.status).toBe("pending");
    expect((await f.request("POST", BASE + "/les_pend0001/approve", { expectedVersion: 1 })).status).toBe(200);
  });
});

describe("the Auditor", () => {
  it("reads the active lessons and the sources of a project and nothing else; every write is refused before it reaches a route", async () => {
    const f = fixture();
    await seed(f.store, pending(), lessonRecord({ id: "les_act00001", project: "demo", workspaceId: A }));
    const auditor = f.callerOf(auditorId, "auditor");
    const view = await f.request("GET", BASE, undefined, auditor);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ canDecide: false, waiting: [], removed: [], snapshots: [] });
    expect((view.body as { active: Array<{ id: string }> }).active.map((l) => l.id)).toEqual(["les_act00001"]);
    expect((view.body as { active: Array<{ canApprove: boolean; canReject: boolean; canRetire: boolean }> }).active.every((l) => !l.canApprove && !l.canReject && !l.canRetire)).toBe(true);
    expect(await f.request("GET", BASE + "/sources", undefined, auditor)).toMatchObject({ status: 200, body: { sources: [], otherPaused: 0 } });
    for (const [method, path, body] of [
      ["GET", BASE + "/digest"], ["GET", BASE + "/les_act00001/history"],
      ["POST", BASE + "/les_pend0001/approve", { expectedVersion: 1 }], ["POST", BASE + "/les_pend0001/reject", { expectedVersion: 1, reason: "no" }], ["POST", BASE + "/les_pend0001/merge", { expectedVersion: 1 }], ["POST", BASE + "/les_act00001/retire", {}],
      ["POST", BASE + "/rollback", { targetSetVersion: 0, expectedSetVersion: 1 }], ["POST", "/v1/app/tasks/11111111-1111-4111-8111-111111111111/lessons/les_act00001/feedback", { kind: "helpful" }],
      ["GET", "/v1/app/tasks/11111111-1111-4111-8111-111111111111/lessons"],
    ] as const) expect(codeOf(await f.request(method, path, body, auditor)), `${method} ${path}`).toBe("FORBIDDEN");
    expect((await f.store.get({ workspaceId: A, project: "demo" }, "les_pend0001"))!.status).toBe("pending");
    expect((await f.store.get({ workspaceId: A, project: "demo" }, "les_act00001"))!.status).toBe("active");
  });
  it("an Auditor asking for a project that does not exist, or another company's, gets the same refusal as anyone", async () => {
    const f = fixture();
    expect(codeOf(await f.request("GET", "/v1/app/projects/nope/lessons", undefined, f.callerOf(auditorId, "auditor")))).toBe("PROJECT_NOT_FOUND");
    expect(codeOf(await f.request("GET", BASE, undefined, { ...f.callerOf(auditorId, "auditor"), orgId: "org_bbbbbbbbbbbbbbbbbbbb" }))).toBe("PROJECT_NOT_FOUND");
  });
});

describe("the dependencies are bound to the caller they were built for", () => {
  it("projectFor and taskFor refuse a different person or company", async () => {
    const f = fixture();
    const route = lessonRouteDependenciesOf(f.deps, f.callerOf(me, "owner"))!;
    await expect(route.projectFor(f.callerOf(me, "owner"), "demo")).resolves.toMatchObject({ name: "demo" });
    await expect(route.projectFor(f.callerOf(other, "owner"), "demo")).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await expect(route.projectFor({ ...f.callerOf(me, "owner"), orgId: "org_bbbbbbbbbbbbbbbbbbbb" }, "demo")).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await expect(route.taskFor(f.callerOf(other, "owner"), "11111111-1111-4111-8111-111111111111")).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });
});

describe("rate limits", () => {
  it("decisions: a person gets LESSON_RATES.decision a minute, then 429; another person has their own budget; a refused request does not decide", async () => {
    const f = fixture();
    await seed(f.store, pending());
    const body = { expectedVersion: 99 };
    for (let i = 0; i < LESSON_RATES.decision; i += 1) expect(codeOf(await f.request("POST", BASE + "/les_pend0001/approve", body)), String(i)).toBe("CHANGE_STALE");
    expect((await f.request("POST", BASE + "/les_pend0001/approve", { expectedVersion: 1 })).status).toBe(429);
    expect((await f.request("POST", BASE + "/les_pend0001/reject", { expectedVersion: 1, reason: "x" })).status).toBe(429);
    expect((await f.request("POST", BASE + "/les_pend0001/retire", {})).status).toBe(429);
    expect((await f.store.get({ workspaceId: A, project: "demo" }, "les_pend0001"))!.status).toBe("pending");
    expect((await f.request("POST", BASE + "/les_pend0001/approve", { expectedVersion: 1 }, f.callerOf(other, "owner"))).status).toBe(200);
  });
  it("edits have their own smaller budget", async () => {
    const f = fixture();
    await seed(f.store, pending());
    const edit = { expectedVersion: 99, edit: { title: "t", description: "", body: "b" } };
    for (let i = 0; i < LESSON_RATES.edit; i += 1) expect(codeOf(await f.request("POST", BASE + "/les_pend0001/approve", edit)), String(i)).toBe("CHANGE_STALE");
    expect((await f.request("POST", BASE + "/les_pend0001/approve", edit)).status).toBe(429);
    expect(codeOf(await f.request("POST", BASE + "/les_pend0001/approve", { expectedVersion: 99 }))).toBe("CHANGE_STALE");
  });
  it("rollbacks have their own budget", async () => {
    const f = fixture();
    const roll = { targetSetVersion: 0, expectedSetVersion: 99 };
    for (let i = 0; i < LESSON_RATES.rollback; i += 1) expect(codeOf(await f.request("POST", BASE + "/rollback", roll)), String(i)).toBe("CHANGE_STALE");
    expect((await f.request("POST", BASE + "/rollback", roll)).status).toBe(429);
  });
  it("a rate row that cannot be written refuses the request and decides nothing", async () => {
    const f = fixture();
    await seed(f.store, pending());
    f.db.injectFault({ command: "UpdateCommand", error: { name: "ServiceUnavailable" } });
    const answer = await f.request("POST", BASE + "/les_pend0001/approve", { expectedVersion: 1 });
    expect(answer.status).toBe(503);
    expect((await f.store.get({ workspaceId: A, project: "demo" }, "les_pend0001"))!.status).toBe("pending");
  });
});

describe("what the agent loaded", () => {
  it("is not mounted on an install with no lesson ports: the path answers as one that does not exist", async () => {
    const f = fixture({ wired: false });
    const missing = await f.request("GET", "/v1/app/tasks/11111111-1111-4111-8111-111111111111/loaded-knowledgez");
    expect(await f.request("GET", "/v1/app/tasks/11111111-1111-4111-8111-111111111111/loaded-knowledge")).toEqual(missing);
    expect(await f.request("GET", "/v1/app/tasks/11111111-1111-4111-8111-111111111111/loaded-knowledge/op1/plan/items/0/text")).toEqual(missing);
  });
  it("is mounted: a task the caller cannot see answers as a task that is not there, not as a missing route", async () => {
    const f = fixture();
    const answer = await f.request("GET", "/v1/app/tasks/11111111-1111-4111-8111-111111111111/loaded-knowledge");
    expect(codeOf(answer)).toBe("TASK_NOT_FOUND");
  });
});
