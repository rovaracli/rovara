// Wiring lane wire-lessons: the developer routes answer both the Lessons screen's paths (the Sources tab among them) and the Team record's `/record/` paths, each by its own handler, in that order
// (the lessons routes come first and never take a `/record/` path); an install with no Team record answers the record paths as it always did; and the broker's one wiring function hands the routes
// the record runtime, the lesson ports and the rule-text reads only where the record is on.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AgentXError, developerOrgKey, errorStatus, orgMemberKey, orgMetaKey, projectMetaKey, projectRevisionKey, type OrgId } from "@agentx/contracts";
import { routeDeveloperRequest, type DeveloperCaller, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { installLessons, lessonsRuntimeFor, recordAndLessonRouteDependencies } from "../../packages/broker/src/aws/broker/lessons-wiring.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { createLessonsRuntime } from "../../packages/broker/src/lessons/runtime.js";
import { createApproverDirectory } from "../../packages/broker/src/lessons/directory.js";
import { InMemoryLessonStore } from "../../packages/broker/src/lessons/store.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { Alerts, Audit, Clock, MemoryVectors, ScriptedModel, Spend, allowAllAccess, directory, embedder, facts, Judge, lessonRecord, seed, settings, verifier } from "../unit/lessons/lesson-helpers.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId, me = "a".repeat(64), other = "b".repeat(64), auditorId = "c".repeat(64);
const names = { memberName: async () => "Priya", isErased: async () => false };

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

const record = (calls: string[]) => ({ routes: async (request: { method: string; path: string }) => { calls.push(`${request.method} ${request.path}`); return /\/record\//u.test(request.path) ? { status: 200, body: { from: "team-record", path: request.path } } : undefined; } });

function withRecord(over: { wired?: boolean; record?: boolean } = {}) {
  const base = fixture(over.wired === undefined ? {} : { wired: over.wired });
  const calls: string[] = [];
  if (over.record !== false) (base.deps as { teamRecord?: unknown }).teamRecord = record(calls);
  return { ...base, calls };
}

describe("both route families answer, each by its own handler", () => {
  it("the Sources tab path is the lessons route; the Team record's sources path is the record route", async () => {
    const f = withRecord();
    const tab = await f.request("GET", "/v1/app/projects/demo/lessons/sources");
    expect(tab.status).toBe(200);
    expect(tab.body).toMatchObject({ sources: [] });
    expect(f.calls).toEqual([]);
    const team = await f.request("GET", "/v1/app/projects/demo/record/sources");
    expect(team).toMatchObject({ status: 200, body: { from: "team-record", path: "/v1/app/projects/demo/record/sources" } });
    expect(f.calls).toEqual(["GET /v1/app/projects/demo/record/sources"]);
  });

  it("every record path reaches the record route, and the lessons list and digest are not taken by it", async () => {
    const f = withRecord();
    for (const tail of ["search?query=retry", "facts", "past-work", "sources", "stats/by_week"]) {
      const answer = await f.request("GET", `/v1/app/projects/demo/record/${tail}`);
      expect(answer.body, tail).toMatchObject({ from: "team-record" });
    }
    f.calls.length = 0;
    await seed(f.store, lessonRecord({ id: "les_act00001", project: "demo", workspaceId: A }));
    expect((await f.request("GET", "/v1/app/projects/demo/lessons")).body).toMatchObject({ mode: "On" });
    expect((await f.request("GET", "/v1/app/projects/demo/lessons/digest")).status).toBe(200);
    expect(f.calls).toEqual([]);
  });

  it("an install with no Team record answers the record paths as a path that does not exist, and still answers the lessons", async () => {
    const f = withRecord({ record: false });
    const missing = await f.request("GET", "/v1/app/projects/demo/nothing-here/sources");
    expect(await f.request("GET", "/v1/app/projects/demo/record/sources")).toEqual(missing);
    expect((await f.request("GET", "/v1/app/projects/demo/lessons/sources")).status).toBe(200);
  });

  it("with the lessons ports unwired the record still answers and the lessons paths do not", async () => {
    const f = withRecord({ wired: false });
    expect((await f.request("GET", "/v1/app/projects/demo/record/sources")).body).toMatchObject({ from: "team-record" });
    expect(await f.request("GET", "/v1/app/projects/demo/lessons/sources")).toEqual(await f.request("GET", "/v1/app/projects/demo/lessonz"));
  });
});

describe("what the broker hands the developer routes", () => {
  const runtime = { routes: {} as never, store: {} as never };
  it("nothing where the Team record is off (the default)", () => {
    expect(recordAndLessonRouteDependencies({ documentClient: {}, tableName: "t" } as never)).toEqual({});
  });
  it("the record runtime, the lesson ports and the rule-text reads where it is on", () => {
    const record = { taps: {} };
    const given = recordAndLessonRouteDependencies({ documentClient: {}, tableName: "t", teamRecord: record, lessons: runtime } as never) as Record<string, unknown>;
    expect(given.teamRecord).toBe(record);
    expect(given.lessons).toBe(runtime.routes);
    expect(Object.keys(given.loadedKnowledge as object).sort()).toEqual(["canReadRepository", "readRuleFile"]);
    expect(Object.keys(recordAndLessonRouteDependencies({ documentClient: {}, tableName: "t", teamRecord: record } as never)).sort()).toEqual(["teamRecord"]);
  });
  it("the /v1/app and /v1/web routes of the handler are built with it (they were not before: the record's routes were wired on the review page's branch only)", () => {
    const handler = readFileSync(new URL("../../packages/broker/src/aws/broker/handler.ts", import.meta.url), "utf8");
    const main = handler.slice(handler.indexOf("const routeDependencies: DeveloperRouteDependencies = {"));
    expect(main.slice(0, main.indexOf("await routeDeveloperRequest(routeDependencies"))).toContain("...recordAndLessonRouteDependencies(dependencies)");
  });
});

describe("the lessons runtime the broker builds", () => {
  it("is built only where the Team record is on (and the install has a sign-in table); otherwise nothing is installed", () => {
    const off = { documentClient: {}, tableName: "t", developer: { signInTableName: "signin" } } as never;
    expect(lessonsRuntimeFor(off)).toBeUndefined();
    const noSignIn = { documentClient: {}, tableName: "t", teamRecord: { table: { documentClient: {}, tableName: "record" } } } as never;
    expect(lessonsRuntimeFor(noSignIn)).toBeUndefined();
    const dependencies = { documentClient: {}, tableName: "t", developer: { signInTableName: "signin" } } as { lessons?: unknown };
    installLessons(dependencies as never);
    expect(dependencies.lessons).toBeUndefined();
    const on = { documentClient: new FakeDynamoDb(), tableName: "t", developer: { signInTableName: "signin" }, teamRecord: { table: { documentClient: new FakeDynamoDb(), tableName: "record" } } } as { lessons?: unknown };
    installLessons(on as never);
    expect(on.lessons).toBeDefined();
    const given = {}, kept = { lessons: given } as { lessons?: unknown };
    installLessons(kept as never);
    expect(kept.lessons).toBe(given);
  });

  const input = () => {
    const db = new FakeDynamoDb();
    return createLessonsRuntime({
      table: { documentClient: db, tableName: "record" }, now: () => 1_800_000_000_000, reader: { file: async () => undefined }, repositoriesOf: async () => [],
      evidence: { documentClient: db, tableName: "state", signInTableName: "signin", now: () => 1_800_000_000_000 }, linkedAccounts: async () => [], names: { memberName: async () => "x", isErased: async () => false },
    });
  };

  it("makes no model call: the judge, the correction rating and the spend gate refuse, and there are no lesson vectors or embeddings", async () => {
    const runtime = input();
    await expect(runtime.routes.judgeModel.complete({ purpose: "judge", system: "s", user: "u", maxOutputTokens: 10, workspaceId: A })).rejects.toThrow();
    await expect(runtime.routes.judge.rate({ lesson: { id: "x", title: "t", description: "", body: "b", type: "fact" }, correctionKind: "send_back", correctionText: "t" })).rejects.toThrow();
    expect(await runtime.routes.spend.admit(A, 0.01)).toBe(false);
    expect(await runtime.routes.embedder.embed("anything")).toEqual([]);
    expect(await runtime.routes.vectors.query(A, "demo", [], 10)).toEqual([]);
    expect(runtime.load.embedder).toBe(runtime.routes.embedder);
  });

  it("without an audit ledger nothing that needs an audit record can be decided", async () => {
    const runtime = input();
    await expect(runtime.routes.audit.emit({ action: "lesson.approved", workspaceId: A, project: "demo", lessonId: "les_aaaa1111", facts: {} })).rejects.toThrow();
  });

  it("the install's directory follows a merged developer to the member they became (the author rules compare members)", async () => {
    const db = new FakeDynamoDb();
    const old = "a".repeat(64), survivor = "b".repeat(64);
    db.set({ pk: `DEVELOPER#${old}`, sk: "META", developerId: old, mergedInto: survivor });
    db.set({ pk: `DEVELOPER#${survivor}`, sk: "META", developerId: survivor });
    const on = { documentClient: db, tableName: "t", developer: { signInTableName: "signin" }, teamRecord: { table: { documentClient: new FakeDynamoDb(), tableName: "record" } } } as { lessons?: { directory: { resolveMember?: (w: string, d: string) => Promise<string> } } };
    installLessons(on as never);
    const resolve = on.lessons!.directory.resolveMember!;
    expect(await resolve(A, old)).toBe(survivor);
    expect(await resolve(A, survivor)).toBe(survivor);
    expect(await resolve(A, "c".repeat(64))).toBe("c".repeat(64));
    await expect(resolve("not-an-org", old)).rejects.toThrow();
  });

  it("the approver directory answers nobody when the roster cannot be read, and an empty identity for a company id that is not one", async () => {
    const runtime = input();
    expect(await runtime.directory.eligibility(A, "demo")).toMatchObject({ complete: false, eligibleIds: [], ownerIds: [] });
    expect(await runtime.directory.eligibility("not-an-org", "demo")).toMatchObject({ complete: false, eligibleIds: [] });
    expect(await runtime.directory.identity("not-an-org", me)).toEqual({ principals: [], groups: [] });
    const linked = createApproverDirectory({ evidence: { documentClient: new FakeDynamoDb(), tableName: "s", signInTableName: "i", now: Date.now }, linkedAccounts: async () => ["gh-1"] });
    expect(await linked.identity(A, me)).toEqual({ principals: ["gh-1"], groups: [] });
    const broken = createApproverDirectory({ evidence: { documentClient: new FakeDynamoDb(), tableName: "s", signInTableName: "i", now: Date.now }, linkedAccounts: async () => { throw new Error("down"); } });
    expect(await broken.identity(A, me)).toEqual({ principals: [], groups: [] });
  });
});
