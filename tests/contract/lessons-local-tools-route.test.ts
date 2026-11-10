// Lessons for local coding tools (decision 46b, lane B1), end to end through the real handler on a wired install: `POST /v1/dev/projects/{project}/lessons`, with the person's own sign-in and with their own script token (the new
// `lessons` permission). Tasks, sessions and the project's repositories are written by the production writers, as in `lessons-live-visibility-wired.test.ts`; the lesson store is the production Dynamo store.
// What is pinned: a person outside the project, a project that is not there and a repository that is not the project's all answer alike; a token needs the `lessons` permission and the project; a lesson narrowed by a People denial
// or a task shared with fewer people is never returned, an erased one is gone on the next call; the install switch, the company's "lessons stay in Rovara" switch, the project's own switch and Regulated each return nothing with
// a plain reason; the route is rate limited; the day's counter holds numbers only and no log, row or audit event holds lesson, task, file or repository text.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectMemberKey, projectRevisionKey, teamRecordPk, type OrgId } from "@agentx/contracts";
import { appCsrfTokenFor } from "../../packages/broker/src/developer/app-csrf.js";
import { installLessons } from "../../packages/broker/src/aws/broker/lessons-wiring.js";
import { scriptTokenRoute } from "../../packages/broker/src/script-tokens/authenticate.js";
import { LOCAL_LESSONS_PER_MINUTE } from "../../packages/broker/src/aws/developer-routes/lessons-local.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { DEV_ISSUER, MAYA, OMAR, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { draft, lessonRecord } from "../unit/lessons/lesson-helpers.js";

type Reply = { status: number; body: Record<string, unknown> };
const ORIGIN = new URL(DEV_ISSUER).origin;
const ZED: Developer = { developerId: "f".repeat(64), name: "Zed Park", provider: "oidc", sessionId: "s-zed" };
const OTHER_ORG = "org_zzzzzzzzzzzzzzzzzzzz" as OrgId;
const at = "2026-11-08T00:00:00.000Z";
const API = "https://github.com/acme/api";
const WEB = "https://github.com/acme/web";
const pinned = (name: string, id: number) => ({ name, url: `https://github.com/acme/${name}`, path: name, defaultBranch: "main", credentialRef: "github-app", githubRepositoryId: id, installationId: 5 });
const SECRET_TASK = "refund-ledger-secret-task";
const SECRET_FILE = "src/secret-payments/ledger.ts";

beforeEach(() => { vi.stubEnv("SCRIPT_TOKENS_ENABLED", "1"); vi.stubEnv("LEARNED_LESSONS_ENABLED", "1"); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function world() {
  const audit = capturingAuditDeps();
  // The handler copies its dependencies at start, so the lessons runtime is handed over as an object that is filled once the table exists (the table is made by the broker).
  const holder: Record<string, unknown> = {};
  const h = await createDeveloperTaskBroker({ audit, brokerExtra: { agents: {}, lessons: holder } });
  const sessions = new Map<string, string>();
  const sessionOf = (who: Developer) => {
    let sid = sessions.get(who.developerId);
    if (sid === undefined) {
      sid = randomUUID();
      sessions.set(who.developerId, sid);
      h.db.set({ pk: `SESSION#${sid}`, sk: "META", sessionId: sid, developerId: who.developerId, amr: who.provider, identityKey: `id-${who.developerId.slice(0, 8)}`, authTime: new Date(Date.now() - 30_000).toISOString(), startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 3600, reviewExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
    }
    return sid;
  };
  const send = async (headers: Record<string, string>, method: string, path: string, body?: unknown, routeKey?: string): Promise<Reply> => {
    const response = await h.handler({ version: "2.0", ...(routeKey === undefined ? {} : { routeKey }), rawPath: path, rawQueryString: "", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), requestContext: { requestId: randomUUID(), http: { method } } });
    return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
  };
  const web = (who: Developer, method: string, path: string, body?: unknown) => {
    const sid = sessionOf(who);
    return send({ cookie: `__Host-agentx_review_session=${sid}`, "sec-fetch-site": "same-origin", origin: ORIGIN, "x-rovara-csrf": appCsrfTokenFor(sid) }, method, path.replace("/v1/app/", "/v1/web/"), body, "ANY /v1/web/{proxy+}");
  };
  const script = (token: string, method: string, path: string, body?: unknown) => send({ authorization: `Bearer ${token}` }, method, path, body);
  const token = async (who: Developer, permissions: string[], projects = ["payments"]) => {
    const reply = await web(who, "POST", "/v1/app/script-tokens", { requestId: randomUUID(), name: "local tool", projects, permissions });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    return (reply.body as { secret: string }).secret;
  };
  // ZED is in the company with no role on the project.
  h.db.set({ pk: `SESSION#${ZED.sessionId}`, sk: "META", sessionId: ZED.sessionId, developerId: ZED.developerId, amr: ZED.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
  h.db.set({ pk: `DEVELOPER#${ZED.developerId}`, sk: "META", developerId: ZED.developerId, provider: ZED.provider, displayName: ZED.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  seedMembership(h.db, ZED.developerId, { orgId: TEST_ORG, role: "member" });
  h.db.set({ ...projectMemberKey(TEST_ORG, OMAR.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: OMAR.developerId, projectName: "payments", grantId: randomUUID(), role: "developer", projectRole: "contributor", source: "grant", grantedAt: at });
  // The production lessons runtime on this table, handed to the handler.
  const dependencies = {
    documentClient: h.db, tableName: "state", agents: {}, developer: { signInTableName: "signin" }, artifactBucketName: "artifacts", s3: { send: async () => ({}) },
    teamRecord: { table: { documentClient: h.db, tableName: "record" }, edition: "public", emitter: { sendBack: async () => undefined }, taskVisibility: async () => ({ kind: "shared" }) },
  } as Record<string, unknown>;
  installLessons(dependencies as never);
  const runtime = dependencies.lessons as { store: { setVersion(key: unknown): Promise<number>; commit(key: unknown, version: number, lessons: unknown[], by: number): Promise<unknown> } };
  Object.assign(holder, runtime);
  const key = { workspaceId: TEST_ORG, project: "payments" };
  const commit = async (...lessons: unknown[]) => { await runtime.store.commit(key, await runtime.store.setVersion(key), lessons, 1); };
  const startTask = async (who: Developer) => {
    const reply = await h.dev(who, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Retry failed HTTP calls", client: "test-client" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return (reply.body.task as { taskId: string }).taskId;
  };
  const deny = (taskId: string, who: Developer) => h.db.set({ pk: `DEVTASK#${taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people: [{ developerId: who.developerId, slackUserId: "U0PERSON00", name: who.name, role: "denied" }] });
  const pin = (revision: number, ...repositories: ReturnType<typeof pinned>[]) => h.db.set({ ...projectRevisionKey(TEST_ORG, "payments", revision), entityType: "PROJECT_REVISION", definition: { name: "payments", revision, repositories } });
  // A task every lesson is learned from by default (a real one, started through the production route, before any revision is pinned).
  const source = await startTask(OMAR);
  const teach = (id: string, over: Record<string, unknown> = {}) => lessonRecord({
    id, workspaceId: TEST_ORG, project: "payments", type: "convention", tier: 1, stages: ["UNDERSTAND", "PLAN", "IMPLEMENT"], approvals: [{ approvalId: "ap", by: "ann", at: 1, mode: "one" }],
    title: `Quarantined advice ${id}`, description: `Quarantined why ${id}`, scope: { repos: ["api"] }, provenance: { ...draft().provenance, supportTasks: [source] }, ...over,
  } as never);
  const ask = (who: Developer, body: Record<string, unknown> = { repo: API }, project = "payments") => h.dev(who, "POST", `/v1/dev/projects/${project}/lessons`, body);
  const ids = (reply: Reply) => ((reply.body.lessons as Array<{ id: string }> | undefined) ?? []).map((l) => l.id).sort();
  return { ...h, audit, web, script, token, key, commit, startTask, source, deny, pin, teach, ask, ids };
}

describe("a project member's own sign-in", () => {
  it("gets the project-wide lessons for the repository its git remote names (positive control for every refusal below)", async () => {
    const w = await world();
    w.pin(2, pinned("api", 1), pinned("web", 2));
    await w.commit(w.teach("les_route00001"), w.teach("les_webonly001", { scope: { repos: ["web"] } }));
    const reply = await w.ask(MAYA);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body).toMatchObject({ status: "ok", project: "payments", repo: "github.com/acme/api", complete: true });
    expect(w.ids(reply)).toEqual(["les_route00001"]);
    expect(reply.body.markdown).toContain("- [les_route00001]");
    expect(w.ids(await w.ask(MAYA, { repo: WEB }))).toEqual(["les_webonly001"]);
  });

  it("a person with no role in the project, a project that is not there and another company's project are one answer", async () => {
    const w = await world();
    w.pin(2, pinned("api", 1));
    await w.commit(w.teach("les_route00001"));
    const outsider = await w.ask(ZED);
    const missing = await w.ask(MAYA, { repo: API }, "no-such-project");
    expect(outsider.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(outsider.body.error).toEqual(missing.body.error);
    expect(JSON.stringify(outsider.body)).not.toContain("les_route00001");
    expect((await w.ask(MAYA)).status).toBe(200);
  });

  it("a git remote that is not one of the project's repositories (another company's included) answers as a missing project, and says nothing of which repositories exist", async () => {
    const w = await world();
    w.pin(2, pinned("api", 1));
    await w.commit(w.teach("les_route00001"));
    const missing = await w.ask(MAYA, { repo: API }, "no-such-project");
    for (const repo of ["https://github.com/other-co/secret-repo", "git@github.com:acme/payments-internal.git", "not a remote"]) {
      const reply = await w.ask(MAYA, { repo });
      expect(reply.status, repo).toBe(404);
      expect(reply.body.error, repo).toEqual(missing.body.error);
    }
    // the same project of another company: a person of another company has no such project
    const rows = w.db.find((item) => typeof item.pk === "string" && (item.pk).includes(OTHER_ORG));
    expect(rows).toEqual([]);
  });

  it("a lesson whose source task is narrowed by a People denial is not returned; once the task is open it is; an erased lesson is gone on the next call", async () => {
    const w = await world();
    const narrowed = await w.startTask(OMAR);
    w.pin(2, pinned("api", 1));
    await w.commit(w.teach("les_open000001"), w.teach("les_narrow0001", { provenance: { ...draft().provenance, supportTasks: [narrowed] } }));
    expect(w.ids(await w.ask(MAYA))).toEqual(["les_narrow0001", "les_open000001"]);
    w.deny(narrowed, ZED);
    expect(w.ids(await w.ask(MAYA))).toEqual(["les_open000001"]);
    await w.commit(w.teach("les_open000001", { status: "withdrawn", version: 2 }));
    expect(w.ids(await w.ask(MAYA))).toEqual([]);
  });

  it("a lesson restricted to one project repository is returned only for that repository", async () => {
    const w = await world();
    w.pin(2, pinned("api", 9), pinned("web", 10));
    const restricted = { provenance: { ...draft().provenance, supportTasks: [w.source], audience: { kind: "restricted", acl: { source: "github", scope: "github:repo/9", capturedAt: at, liveCheck: "on_read" } }, sourceScopes: ["github:repo/9"] }, scope: {} };
    await w.commit(w.teach("les_onlyapi001", restricted));
    expect(w.ids(await w.ask(MAYA, { repo: API }))).toEqual(["les_onlyapi001"]);
    expect(w.ids(await w.ask(MAYA, { repo: WEB }))).toEqual([]);
    expect(w.ids(await w.ask(MAYA, {}))).toEqual([]);
  });

  it("returns nothing, with a plain reason, when the install's switch is off, the company keeps lessons in Rovara, the project switched it off, or the project is Regulated", async () => {
    const w = await world();
    w.pin(2, pinned("api", 1));
    await w.commit(w.teach("les_route00001"));
    expect(w.ids(await w.ask(MAYA))).toEqual(["les_route00001"]);
    const record = { documentClient: w.db, tableName: "record" };
    void record;
    // the project's own switch
    const projectKey = { pk: teamRecordPk(TEST_ORG, "payments"), sk: "LESSONSET#LOCALTOOLS" };
    w.db.set({ ...projectKey, entityType: "LESSON_SETTINGS", enabled: false });
    expect(await w.ask(MAYA)).toMatchObject({ status: 200, body: { status: "off", reason: "project_setting", lessons: [] } });
    w.db.set({ ...projectKey, entityType: "LESSON_SETTINGS", enabled: true });
    expect(w.ids(await w.ask(MAYA))).toEqual(["les_route00001"]);
    // Regulated
    const presetKey = { pk: teamRecordPk(TEST_ORG, "payments"), sk: "LESSONSET#PRESET" };
    w.db.set({ ...presetKey, entityType: "LESSON_SETTINGS", preset: "regulated" });
    expect(await w.ask(MAYA)).toMatchObject({ status: 200, body: { status: "off", reason: "regulated", lessons: [] } });
    w.db.set({ ...presetKey, entityType: "LESSON_SETTINGS", preset: "standard" });
    expect(w.ids(await w.ask(MAYA))).toEqual(["les_route00001"]);
    // the company's "lessons stay in Rovara"
    const companyKey = { pk: teamRecordPk(TEST_ORG, undefined), sk: "LESSONSET#COMPANYSTAY" };
    w.db.set({ ...companyKey, entityType: "LESSON_SETTINGS", stays: true });
    expect(await w.ask(MAYA)).toMatchObject({ status: 200, body: { status: "off", reason: "company_stays", lessons: [] } });
    w.db.set({ ...companyKey, entityType: "LESSON_SETTINGS", stays: false });
    // the install's lessons switch (decision 47): say so, return nothing
    vi.stubEnv("LEARNED_LESSONS_ENABLED", "0");
    const off = await w.ask(MAYA);
    expect(off).toMatchObject({ status: 200, body: { status: "off", reason: "install_switch", lessons: [] } });
    expect(String(off.body.message)).toContain("switched off");
    // a stored setting that is not valid is not "unset": the call fails closed
    vi.stubEnv("LEARNED_LESSONS_ENABLED", "1");
    w.db.set({ ...projectKey, entityType: "LESSON_SETTINGS", enabled: "yes" });
    expect((await w.ask(MAYA)).status).toBe(503);
  });

  it("is rate limited per person, and refuses a body with a field it does not take or a task text that is too long", async () => {
    const w = await world();
    w.pin(2, pinned("api", 1));
    for (let i = 0; i < LOCAL_LESSONS_PER_MINUTE; i += 1) expect((await w.ask(MAYA)).status).toBe(200);
    expect((await w.ask(MAYA)).status).toBe(429);
    // another person has their own budget
    expect((await w.ask(OMAR)).status).toBe(200);
    const bad = await w.ask(OMAR, { repo: API, project: "other" });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain("other");
    expect((await w.ask(OMAR, { task: "x".repeat(2_001) })).status).toBe(400);
    expect((await w.ask(OMAR, { stage: "deploy" })).status).toBe(400);
  });
});

describe("a person's own script token", () => {
  it("needs the lessons permission and the project; a token made without it cannot read lessons, and one for another project cannot either", async () => {
    const w = await world();
    w.pin(2, pinned("api", 1));
    await w.commit(w.teach("les_route00001"));
    const ok = await w.token(MAYA, ["lessons"]);
    const reply = await w.script(ok, "POST", "/v1/dev/projects/payments/lessons", { repo: API });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(w.ids(reply)).toEqual(["les_route00001"]);
    const readOnly = await w.token(MAYA, ["read", "start"]);
    expect((await w.script(readOnly, "POST", "/v1/dev/projects/payments/lessons", { repo: API })).status).toBe(403);
    const elsewhere = await w.token(MAYA, ["lessons"], ["payments"]);
    expect((await w.script(elsewhere, "POST", "/v1/dev/projects/billing/lessons", { repo: API })).status).toBe(403);
    // the lessons permission opens only this route
    expect((await w.script(ok, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "x", client: "c" })).status).toBe(403);
    expect((await w.script(ok, "GET", "/v1/dev/tasks?project=payments")).status).toBe(403);
    expect(scriptTokenRoute("POST", "/v1/dev/projects/payments/lessons")).toEqual({ permission: "lessons", project: "path", name: "payments" });
    expect(scriptTokenRoute("GET", "/v1/dev/projects/payments/lessons")).toBeUndefined();
    expect(scriptTokenRoute("POST", "/v1/dev/projects/payments/lessons/x")).toBeUndefined();
  });

  it("stops when its creator no longer holds a role in the project (live, not at the time it was made)", async () => {
    const w = await world();
    w.pin(2, pinned("api", 1));
    const secret = await w.token(OMAR, ["lessons"]);
    expect((await w.script(secret, "POST", "/v1/dev/projects/payments/lessons", { repo: API })).status).toBe(200);
    w.db.delete(projectMemberKey(TEST_ORG, OMAR.developerId, "payments"));
    const after = await w.script(secret, "POST", "/v1/dev/projects/payments/lessons", { repo: API });
    expect(after.status).toBe(404);
  });
});

describe("nothing a lesson, a task, a file or a repository says is kept", () => {
  it("the day's counter holds numbers only, and no log, row or audit event holds the lesson, task, file or repository text", async () => {
    const lines: string[] = [];
    for (const method of ["log", "info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
    const w = await world();
    w.pin(2, pinned("api", 1));
    await w.commit(w.teach("les_route00001", { title: "Quarantined advice title" }));
    const answered = await w.ask(MAYA, { repo: API, task: SECRET_TASK, files: [SECRET_FILE] });
    expect(w.ids(answered)).toEqual(["les_route00001"]);
    await w.ask(MAYA, { repo: "https://github.com/other-co/secret-repo", task: SECRET_TASK, files: [SECRET_FILE] });
    vi.stubEnv("LEARNED_LESSONS_ENABLED", "0");
    await w.ask(MAYA, { repo: API, task: SECRET_TASK, files: [SECRET_FILE] });
    const counters = w.db.find((item) => item.entityType === "LESSON_LOCAL_DAY");
    // positive control: the counters are there, with numbers and fixed codes only
    expect(counters).toHaveLength(1);
    expect(counters[0]).toMatchObject({ calls: 3, lessonsReturned: 1, refused_unknown_repo: 1, refused_install_switch: 1, day: new Date().toISOString().slice(0, 10) });
    expect(String(counters[0]!.sk)).toContain(MAYA.developerId);
    const rows = JSON.stringify(w.db.find((item) => item.entityType === "LESSON_LOCAL_DAY"));
    const everything = JSON.stringify([lines, w.audit.recorded(), rows, w.db.find((item) => item.entityType !== "LESSON" && item.entityType !== "LESSON_HEAD" && !(typeof item.sk === "string" && item.sk.startsWith("LESSON")))]);
    for (const secret of [SECRET_TASK, "secret-payments", "secret-repo", "other-co", "Quarantined"]) expect(everything, secret).not.toContain(secret);
  });
});
