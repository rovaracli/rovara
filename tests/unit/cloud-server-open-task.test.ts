// K2: POST /v1/app/tasks/{taskId}/open through Cloud's handler. A person Code lets read a task (a People co-owner, commenter or viewer) opens it in
// Cloud by its Code id: Cloud finds the task's session or makes it on the first open, but only after Code's own task read (as that person) succeeds.
// The owner comes from Code's People read, never from the opener; the company from the sign-in; a Code refusal answers like a missing session.
import { describe, expect, it } from "vitest";
import { DynamoWorkSessionStore } from "../../packages/cloud-server/src/dynamo-stores.js";
import { openTaskByCodeId } from "../../packages/cloud-server/src/open-task.js";
import type { RouteContext } from "../../packages/cloud-server/src/routes.js";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, StoreConflict, createCloudHandler, type CloudRequest, type CodeSession, type WorkSession } from "../../packages/cloud-server/src/index.js";
import { SessionResponseReaderSchema } from "../../packages/contracts/src/web.js";

const CODE = "https://code.example.test";
const ADA = "a".repeat(64);
const SAM = "b".repeat(64);
const EVE = "c".repeat(64);
const ADA_PERSON = "11111111-1111-4111-8111-111111111111";
const SAM_PERSON = "22222222-2222-4222-8222-222222222222";
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const TASK = "6f9d0c1e-2b3a-4c5d-8e7f-001122334455";
const OTHER_TASK = "7a9d0c1e-2b3a-4c5d-8e7f-001122334466";
const REFUSED = { status: 404, body: { error: { code: "SESSION_NOT_FOUND", message: "That session doesn't exist, or you can't see it." } } };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const OPEN = `/v1/web/tasks/${TASK}/open`;

interface CodeCall { method: string; path: string; authorization: string | undefined }
type Who = "ada" | "sam" | "eve" | "zed" | "kim";
const WHO: Record<string, Who> = { "Bearer fay-token": "zed", "Bearer ada-token": "ada", "Bearer sam-token": "sam", "Bearer eve-token": "eve", "Bearer zed-token": "zed", "Bearer kim-token": "kim" };

interface Options { task?: (who: Who) => unknown; people?: (who: Who) => unknown; taskStatus?: (who: Who) => number; peopleStatus?: (who: Who) => number }

function setUp(options: Options = {}) {
  const calls: CodeCall[] = [], accessOf: Record<string, unknown> = {};
  const task = { taskId: TASK, title: "Fix the README typo", project: "payments", status: "RUNNING", startingRevision: 1, client: "Rovara Cloud", shared: false, createdAt: "2026-11-14T10:00:00.000Z", updatedAt: "2026-11-14T10:05:00.000Z", events: [], changedFiles: [], artifacts: [], pullRequests: [], pageActions: [] };
  const peopleFor = (who: Who) => ({ view: { revision: 3, orphaned: false, canManage: who === "ada", canTakeOwnership: false, people: [
    { personId: ADA_PERSON, name: "Ada", role: "owner", you: who === "ada", effectiveRole: "owner" },
    { personId: SAM_PERSON, name: "Sam", role: "commenter", you: who === "sam", effectiveRole: "commenter" },
  ] } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method: init?.method ?? "GET", path: url.pathname, authorization: headers.authorization });
    if (url.pathname === "/v1/auth/token") return json(400, { error: "invalid_grant" });
    if (url.pathname === "/v1/dev/access") return json(200, accessOf[headers.authorization ?? ""]);
    const who = WHO[headers.authorization ?? ""]!;
    const refusal = { error: { code: "TASK_NOT_FOUND", message: "There is no such task." } };
    if (url.pathname === "/v1/dev/projects/ignored") return json(404, {});
    if (url.pathname === "/v1/dev/tasks" && init?.method === "POST") return json(201, { task });
    if (url.pathname === `/v1/dev/tasks/${TASK}`) {
      const status = options.taskStatus?.(who) ?? (who === "eve" ? 404 : who === "zed" ? 403 : 200);
      return status === 200 ? json(200, { task: options.task?.(who) ?? task }) : json(status, refusal);
    }
    if (url.pathname === `/v1/dev/tasks/${TASK}/people/take-ownership` && init?.method === "POST") return json(200, { ok: true });
    if (url.pathname === `/v1/dev/tasks/${TASK}/people`) {
      const status = options.peopleStatus?.(who) ?? 200;
      return status === 200 ? json(200, options.people?.(who) ?? peopleFor(who)) : json(status, refusal);
    }
    return json(404, { error: { code: "NOT_FOUND", message: "route not found" } });
  }) as typeof fetch;
  const store = new LocalSessionStore(undefined, { environment: {} });
  const work = new LocalWorkSessionStore();
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "projects:members", fetch: fetchImpl });
  const handler = createCloudHandler({
    client, store, work, origin: "https://cloud.example.test", org: { orgId: "acme", name: "Acme", plan: "test" },
    callbackPath: "/callback", secureCookies: true, log: () => undefined, now: () => new Date(Date.UTC(2026, 10, 17)),
  });
  const signedIn = new Set<string>();
  const signIn = async (token: string, access: CodeSession["access"]) => {
    accessOf[`Bearer ${token}`] = access;
    if (!signedIn.has(token)) await store.create(`cookie-${token}`, { accessToken: token, refreshToken: `r-${token}`, csrf: "csrf", signedInAt: "2026-11-17T00:00:00.000Z", access });
    signedIn.add(token);
    return { cookie: `rovara_cloud_session=cookie-${token}`, "x-rovara-csrf": "csrf" };
  };
  const call = async (method: "GET" | "POST", target: string, body: unknown, headers: Record<string, string>) => {
    const url = new URL(target, "http://127.0.0.1:8787");
    const request: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) };
    const answered = await handler(request);
    return { status: answered!.status, body: JSON.parse(answered!.body) as unknown };
  };
  const post = (target: string, body: unknown, headers: Record<string, string>) => call("POST", target, body, headers);
  const get = (target: string, headers: Record<string, string>) => call("GET", target, undefined, headers);
  const people = (id: string, name: string, administrator = false) => ({ developerId: id, displayName: name, administrator, companyId: A, companyRole: "member" as const, projects: [{ name: "payments", access: "developer" }], notices: [] as string[] });
  const ada = () => signIn("ada-token", people(ADA, "Ada", true));
  const sam = () => signIn("sam-token", people(SAM, "Sam"));
  const kim = () => signIn("kim-token", people("d".repeat(64), "Kim"));
  const eve = () => signIn("eve-token", { ...people(EVE, "Eve"), companyId: B });
  const zed = () => signIn("zed-token", { ...people("e".repeat(64), "Zed"), projects: [] });
  const sessions = () => work.everything().sessions;
  const zedLike = (name: string, access: CodeSession["access"]) => signIn(`${name}-token`, access);
  return { post, get, calls, ada, sam, kim, eve, zed, zedLike, work, sessions, route: () => calls.filter((c) => c.path !== "/v1/dev/access").map((c) => `${c.method} ${c.path}`) };
}

describe("opening a task by its Code id", () => {
  it("a commenter opens a task they did not start: Code's task read first, then the People read, then one session", async () => {
    const w = setUp();
    const res = await w.post(OPEN, undefined, await w.sam());
    expect(res.status).toBe(200);
    const { sessionId, sessionUrl } = res.body as { sessionId: string; sessionUrl: string };
    expect(sessionId).toMatch(/^ses_[0-9a-z]{20}$/u);
    expect(sessionUrl).toBe(`https://cloud.example.test/s/${sessionId}`);
    expect(Object.keys(res.body as object).sort()).toEqual(["sessionId", "sessionUrl"]);
    expect(w.route()).toEqual([`GET /v1/dev/tasks/${TASK}`, `GET /v1/dev/tasks/${TASK}/people`]);
    expect(w.calls.every((c) => c.authorization === "Bearer sam-token")).toBe(true);
    expect(w.sessions()).toHaveLength(1);
    const record = w.sessions()[0]!;
    expect(record).toMatchObject({ sessionId, taskId: TASK, project: "payments", companyId: A, revision: 1, ownerUnresolved: true });
    // The owner is the one Code names (Ada), never the opener.
    expect(record.owner.name).toBe("Ada");
    expect(record.owner.developerId).not.toBe(SAM);
    expect(record.owner.developerId).toMatch(/^[0-9a-f]{64}$/u);
    // The session page reads as a watcher: not the owner, no owner actions.
    const page = await w.get(`/v1/web/sessions/${sessionId}`, await w.sam());
    expect(page.status).toBe(200);
    const view = SessionResponseReaderSchema.parse(page.body).session as { owner: { name: string }; you: { owner: boolean; level: string; actions: string[] } };
    expect(view.owner.name).toBe("Ada");
    expect(view.you.owner).toBe(false);
    expect(view.you.actions).not.toContain("stop");
    expect(view.you.actions).not.toContain("close");
  });

  it("the session is made once: the same person again, and the owner, get the same session", async () => {
    const w = setUp();
    const first = (await w.post(OPEN, undefined, await w.sam())).body as { sessionId: string };
    const again = (await w.post(OPEN, undefined, await w.sam())).body as { sessionId: string };
    const owner = (await w.post(OPEN, undefined, await w.ada())).body as { sessionId: string };
    expect(again.sessionId).toBe(first.sessionId);
    expect(owner.sessionId).toBe(first.sessionId);
    expect(w.sessions()).toHaveLength(1);
  });

  it("Code's task read happens before the store is looked at, on every open", async () => {
    const w = setUp();
    await w.post(OPEN, undefined, await w.sam());
    w.calls.length = 0;
    await w.post(OPEN, undefined, await w.sam());
    expect(w.route()[0]).toBe(`GET /v1/dev/tasks/${TASK}`);
  });

  it("two people opening at the same moment get the same session, and one is stored", async () => {
    const w = setUp();
    const headers = [await w.sam(), await w.ada(), await w.kim()];
    const answers = await Promise.all(headers.map((h) => w.post(OPEN, undefined, h)));
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200]);
    expect(new Set(answers.map((a) => (a.body as { sessionId: string }).sessionId)).size).toBe(1);
    expect(w.sessions()).toHaveLength(1);
  });

  it("the owner opening a session a commenter's open made becomes its owner (Code says they are); a commenter never does", async () => {
    const w = setUp();
    const { sessionId } = (await w.post(OPEN, undefined, await w.sam())).body as { sessionId: string };
    await w.post(OPEN, undefined, await w.sam());
    expect(w.sessions()[0]!.owner.name).toBe("Ada");
    expect(w.sessions()[0]!.ownerUnresolved).toBe(true);
    await w.post(OPEN, undefined, await w.ada());
    const record = w.sessions()[0]!;
    expect(record.owner).toEqual({ developerId: ADA, name: "Ada" });
    expect(record.ownerUnresolved).toBeUndefined();
    expect(record.revision).toBe(2);
    const page = await w.get(`/v1/web/sessions/${sessionId}`, await w.ada());
    expect((SessionResponseReaderSchema.parse(page.body).session as { you: { owner: boolean } }).you.owner).toBe(true);
  });

  it("a task Code answers with another task id, or with no project, opens nothing", async () => {
    for (const task of [{ taskId: OTHER_TASK, project: "payments" }, { taskId: TASK, project: "" }, { taskId: TASK }, { taskId: TASK, project: 7 }]) {
      const w = setUp({ task: () => task });
      expect(await w.post(OPEN, undefined, await w.sam())).toEqual(REFUSED);
      expect(w.sessions()).toHaveLength(0);
    }
  });

  it("with two owners, the opener who is one of them is the owner; a people entry with no name or that is null opens nothing", async () => {
    const wrap = (people: unknown[]) => ({ view: { revision: 1, orphaned: false, canManage: false, canTakeOwnership: false, people } });
    const owner = (id: string, name: string, you: boolean) => ({ personId: id, name, role: "owner", you, effectiveRole: "owner" });
    const two = setUp({ people: () => wrap([owner(ADA_PERSON, "Ada", false), owner(SAM_PERSON, "Sam", true)]) });
    await two.post(OPEN, undefined, await two.sam());
    expect(two.sessions()[0]).toMatchObject({ owner: { developerId: SAM, name: "Sam" } });
    expect(two.sessions()[0]!.ownerUnresolved).toBeUndefined();
    for (const people of [[owner(ADA_PERSON, "", true)], [owner(ADA_PERSON, "   ", true)], [null]]) {
      const w = setUp({ people: () => wrap(people) });
      expect(await w.post(OPEN, undefined, await w.sam())).toEqual(REFUSED);
      expect(w.sessions()).toHaveLength(0);
    }
  });

  it("only Code's refusals (400, 403, 404, 410) read as a missing session: a busy or rate-limited Code passes through", async () => {
    for (const status of [429, 408, 409]) {
      const w = setUp({ taskStatus: () => status });
      expect((await w.post(OPEN, undefined, await w.sam())).status).toBe(status);
      expect(w.sessions()).toHaveLength(0);
    }
    for (const status of [400, 403, 404, 410]) {
      const w = setUp({ taskStatus: () => status });
      expect(await w.post(OPEN, undefined, await w.sam())).toEqual(REFUSED);
    }
  });

  it("healing also names the owner as the starter, so the owner's own lists show the session", async () => {
    const w = setUp();
    await w.post(OPEN, undefined, await w.sam());
    expect(w.sessions()[0]!.startedBy.developerId).not.toBe(ADA);
    await w.post(OPEN, undefined, await w.ada());
    expect(w.sessions()[0]!.startedBy).toEqual({ developerId: ADA, name: "Ada" });
    expect((await w.work.startedBy(ADA)).map((each) => each.taskId)).toEqual([TASK]);
  });

  it("taking the task over clears the placeholder mark, so the new owner is not healed over later", async () => {
    const w = setUp();
    const { sessionId } = (await w.post(OPEN, undefined, await w.sam())).body as { sessionId: string };
    const taken = await w.post(`/v1/web/sessions/${sessionId}/take-over`, { requestId: "55555555-5555-4555-8555-555555555555" }, await w.sam());
    expect(taken.status).toBe(200);
    expect(w.sessions()[0]).toMatchObject({ owner: { developerId: SAM, name: "Sam" } });
    expect(w.sessions()[0]!.ownerUnresolved).toBeUndefined();
  });

  it("a session with a resolved owner costs no People read on later opens", async () => {
    const w = setUp();
    await w.post(OPEN, undefined, await w.ada());
    w.calls.length = 0;
    await w.post(OPEN, undefined, await w.sam());
    expect(w.route()).toEqual([`GET /v1/dev/tasks/${TASK}`]);
  });

  it("the owner who opens first is the session's owner from the start", async () => {
    const w = setUp();
    await w.post(OPEN, undefined, await w.ada());
    expect(w.sessions()[0]).toMatchObject({ owner: { developerId: ADA, name: "Ada" }, startedBy: { developerId: ADA } });
    expect(w.sessions()[0]!.ownerUnresolved).toBeUndefined();
  });

  it("a person Code refuses (404 or 403) gets the missing-session answer and nothing is written or asked further", async () => {
    const w = setUp();
    for (const header of [await w.eve(), await w.zed()]) {
      const res = await w.post(OPEN, undefined, header);
      expect(res).toEqual(REFUSED);
    }
    expect(w.sessions()).toHaveLength(0);
    expect(w.route().filter((p) => p.endsWith("/people"))).toEqual([]);
    // The same words as a session Cloud does not hold.
    expect(await w.get("/v1/web/sessions/ses_zzzzzzzzzzzzzzzzzzzz", await w.eve())).toEqual(REFUSED);
  });

  it("a person Code names no company for opens nothing and no task is read for them", async () => {
    const w = setUp();
    const none = { developerId: "f".repeat(64), displayName: "Fay", administrator: false, projects: [], notices: [] as string[] };
    expect(await w.post(OPEN, undefined, await w.zedLike("fay", none))).toEqual(REFUSED);
    expect(w.route()).toEqual([]);
    expect(w.sessions()).toHaveLength(0);
  });

  it("a person Code refuses learns nothing from a session that exists (same answer as without one)", async () => {
    const w = setUp();
    await w.post(OPEN, undefined, await w.sam());
    expect(await w.post(OPEN, undefined, await w.zed())).toEqual(REFUSED);
    expect(await w.post(OPEN, undefined, await w.eve())).toEqual(REFUSED);
    expect(w.sessions()).toHaveLength(1);
  });

  it("two companies: a person of company B opening company A's task creates nothing and learns nothing, whether or not A's session exists", async () => {
    const w = setUp();
    const before = await w.post(OPEN, undefined, await w.eve());
    await w.post(OPEN, undefined, await w.sam());
    const after = await w.post(OPEN, undefined, await w.eve());
    expect(before).toEqual(REFUSED);
    expect(after).toEqual(before);
    expect(w.sessions()).toHaveLength(1);
    expect(w.sessions()[0]!.companyId).toBe(A);
  });

  it("a session of company A is not answered to a person of company B even if Code let them read the task", async () => {
    const w = setUp({ taskStatus: () => 200 });
    await w.post(OPEN, undefined, await w.sam());
    const res = await w.post(OPEN, undefined, await w.eve());
    expect(res).toEqual(REFUSED);
    expect(w.sessions()).toHaveLength(1);
  });

  it("no owner in Code's People answer, or an answer that is not the shape, opens nothing", async () => {
    const entry = (extra: Record<string, unknown> = {}) => ({ personId: SAM_PERSON, name: "Sam", role: "commenter", you: true, effectiveRole: "commenter", ...extra });
    const wrap = (people: unknown[]) => ({ view: { revision: 1, orphaned: false, canManage: false, canTakeOwnership: false, people } });
    const bad: unknown[] = [
      wrap([entry()]), wrap([]), { view: {} }, {}, wrap([entry({ effectiveRole: "owner", name: "x".repeat(81) })]), wrap([entry({ effectiveRole: "owner", personId: "not-a-uuid" })]),
      wrap([entry({ effectiveRole: "admin" })]), wrap([entry({ effectiveRole: "owner", you: false, name: "Ada" }), ...Array.from({ length: 100 }, () => entry())]), wrap([entry({ effectiveRole: "owner", you: "yes" })]),
    ];
    for (const answer of bad) {
      const w = setUp({ people: () => answer });
      expect(await w.post(OPEN, undefined, await w.sam())).toEqual(REFUSED);
      expect(w.sessions()).toHaveLength(0);
    }
  });

  it("Code refusing the People read opens nothing", async () => {
    const w = setUp({ peopleStatus: () => 403 });
    expect(await w.post(OPEN, undefined, await w.sam())).toEqual(REFUSED);
    expect(w.sessions()).toHaveLength(0);
  });

  it("Code being down is not a refusal: its status passes through and nothing is written", async () => {
    const w = setUp({ taskStatus: () => 503 });
    expect((await w.post(OPEN, undefined, await w.sam())).status).toBe(503);
    expect(w.sessions()).toHaveLength(0);
    const v = setUp({ peopleStatus: () => 500 });
    expect((await v.post(OPEN, undefined, await v.sam())).status).toBe(500);
    expect(v.sessions()).toHaveLength(0);
  });

  it("takes the task id, project, owner and company from nowhere but the path, Code and the sign-in", async () => {
    const w = setUp();
    const body = { taskId: OTHER_TASK, project: "other", owner: { developerId: SAM, name: "Sam" }, companyId: B, sessionId: "ses_zzzzzzzzzzzzzzzzzzzz" };
    const res = await w.post(`${OPEN}?taskId=${OTHER_TASK}&companyId=org_bbbbbbbbbbbbbbbbbbbb&project=other`, body, { ...(await w.sam()), "x-company-id": B });
    expect(res.status).toBe(200);
    expect(w.sessions()[0]).toMatchObject({ taskId: TASK, project: "payments", companyId: A });
    expect(w.sessions()[0]!.owner.name).toBe("Ada");
    expect(w.calls.some((c) => c.path.includes(OTHER_TASK))).toBe(false);
  });

  it("an upper-case task id finds the same session as the lower-case one", async () => {
    const w = setUp();
    const one = (await w.post(OPEN, undefined, await w.sam())).body as { sessionId: string };
    const two = (await w.post(`/v1/web/tasks/${TASK.toUpperCase()}/open`, undefined, await w.sam())).body as { sessionId: string };
    expect(two.sessionId).toBe(one.sessionId);
  });

  it("needs the sign-in's CSRF token like every other write, and a sign-in", async () => {
    const w = setUp();
    const { cookie } = await w.sam();
    expect((await w.post(OPEN, undefined, { cookie })).status).toBe(403);
    expect((await w.post(OPEN, undefined, {})).status).toBe(401);
    expect(w.sessions()).toHaveLength(0);
  });

  it("a path that is not a task id is not this route", async () => {
    const w = setUp();
    expect((await w.post("/v1/web/tasks/not-a-uuid/open", undefined, await w.sam())).status).toBe(501);
    expect(w.calls).toHaveLength(0);
  });
});

describe("the session the starter made", () => {
  it("is found by its task: the starter and a commenter both open it and no second session is made", async () => {
    const w = setUp();
    const headers = await w.ada();
    const started = await w.post("/v1/web/projects/payments/code", { requestId: "33333333-3333-4333-8333-333333333333", input: { text: "Fix the README typo" } }, headers);
    expect(started.status).toBe(201);
    const startedBody = started.body as { sessionId: string; sessionUrl: string; task: { taskId: string } };
    expect(Object.keys(startedBody).sort()).toEqual(["sessionId", "sessionUrl", "task"]);
    expect(startedBody.task.taskId).toBe(TASK);
    // The starter's record is exactly what it was before K2: no company, no placeholder owner.
    const stored: WorkSession = w.sessions()[0]!;
    expect(stored).toEqual({ sessionId: startedBody.sessionId, taskId: TASK, project: "payments", startedBy: { developerId: ADA, name: "Ada" }, owner: { developerId: ADA, name: "Ada" }, createdAt: "2026-11-17T00:00:00.000Z", revision: 1, companyId: A });
    expect((await w.post(OPEN, undefined, headers)).body).toEqual({ sessionId: startedBody.sessionId, sessionUrl: startedBody.sessionUrl });
    expect((await w.post(OPEN, undefined, await w.sam())).body).toEqual({ sessionId: startedBody.sessionId, sessionUrl: startedBody.sessionUrl });
    expect(w.sessions()).toHaveLength(1);
    expect(w.sessions()[0]!.owner).toEqual({ developerId: ADA, name: "Ada" });
    // A retried start still answers the same session.
    const retried = await w.post("/v1/web/projects/payments/code", { requestId: "33333333-3333-4333-8333-333333333333", input: { text: "Fix the README typo" } }, headers);
    expect((retried.body as { sessionId: string }).sessionId).toBe(startedBody.sessionId);
  });
});

describe("the work store's task record", () => {
  const record = (sessionId: string): WorkSession => ({ sessionId, taskId: TASK, project: "payments", startedBy: { developerId: ADA, name: "Ada" }, owner: { developerId: ADA, name: "Ada" }, createdAt: "2026-11-17T00:00:00.000Z", revision: 1 });
  it("finds a session by its task, and `once` lets only the first new session of a task in", async () => {
    const store = new LocalWorkSessionStore();
    expect(await store.byTask(TASK)).toBeUndefined();
    await store.put(record("ses_aaaaaaaaaaaaaaaaaaaa"), undefined, { once: true });
    expect((await store.byTask(TASK))?.sessionId).toBe("ses_aaaaaaaaaaaaaaaaaaaa");
    await expect(store.put(record("ses_bbbbbbbbbbbbbbbbbbbb"), undefined, { once: true })).rejects.toBeInstanceOf(StoreConflict);
    expect(await store.get("ses_bbbbbbbbbbbbbbbbbbbb")).toBeUndefined();
    expect((await store.byTask(TASK))?.sessionId).toBe("ses_aaaaaaaaaaaaaaaaaaaa");
    // Without `once` a new session is written as before (the starter flow), and a changed session keeps the task's record.
    await store.put(record("ses_cccccccccccccccccccc"));
    expect((await store.byTask(TASK))?.sessionId).toBe("ses_cccccccccccccccccccc");
  });
});

describe("the route's own company check, without the company-scoped store in front of it", () => {
  it("a session stamped with another company is refused even when the store shows it and Code lets the person read the task", async () => {
    const work = new LocalWorkSessionStore();
    await work.put({ sessionId: "ses_aaaaaaaaaaaaaaaaaaaa", taskId: TASK, project: "payments", startedBy: { developerId: ADA, name: "Ada" }, owner: { developerId: ADA, name: "Ada" }, createdAt: "2026-11-17T00:00:00.000Z", revision: 1, companyId: A });
    const access = { developerId: EVE, displayName: "Eve", administrator: false, companyId: B, companyRole: "member", projects: [], notices: [] };
    const client = { access: async () => access, json: async (_session: unknown, path: string) => (path.includes("/people") ? { view: { people: [] } } : { task: { taskId: TASK, project: "payments" } }) };
    const context = { client, session: { access }, params: [TASK], work, now: () => new Date(0), origin: "https://cloud.example.test" } as unknown as RouteContext;
    expect(await openTaskByCodeId(context)).toEqual(REFUSED);
    expect(work.everything().sessions).toHaveLength(1);
  });
});

describe("a first opener who loses the race", () => {
  const access = { developerId: SAM, displayName: "Sam", administrator: false, companyId: A, companyRole: "member", projects: [], notices: [] };
  const mine = (work: unknown) => ({ client: { access: async () => access, json: async (_s: unknown, path: string) => (path.includes("/people") ? { view: { people: [{ personId: SAM_PERSON, name: "Sam", you: true, effectiveRole: "owner" }] } } : { task: { taskId: TASK, project: "payments" } }) }, session: { access }, params: [TASK], work, now: () => new Date(0), origin: "https://cloud.example.test" }) as unknown as RouteContext;
  const winnerSession: WorkSession = { sessionId: "ses_wwwwwwwwwwwwwwwwwwww", taskId: TASK, project: "payments", startedBy: { developerId: ADA, name: "Ada" }, owner: { developerId: ADA, name: "Ada" }, createdAt: "2026-11-17T00:00:00.000Z", revision: 1, companyId: A };
  it("gets the winner's session even when it shows a moment after the conflict", async () => {
    let reads = 0;
    const work = { byTask: async () => { reads += 1; return reads >= 4 ? winnerSession : undefined; }, put: async () => { throw new StoreConflict("ses_loser"); } };
    expect((await openTaskByCodeId(mine(work))).body).toMatchObject({ sessionId: "ses_wwwwwwwwwwwwwwwwwwww" });
    expect(reads).toBe(4);
  });
  it("is refused when no session ever shows", async () => {
    const work = { byTask: async () => undefined, put: async () => { throw new StoreConflict("ses_loser"); } };
    expect(await openTaskByCodeId(mine(work))).toEqual(REFUSED);
  });
});

describe("the DynamoDB store reads two transactions that touch the same task record as a conflict", () => {
  it("a TransactionConflict or a failed condition on the task record is a StoreConflict (so the request runs again), anything else is not", async () => {
    const record: WorkSession = { sessionId: "ses_aaaaaaaaaaaaaaaaaaaa", taskId: TASK, project: "payments", startedBy: { developerId: ADA, name: "Ada" }, owner: { developerId: ADA, name: "Ada" }, createdAt: "2026-11-17T00:00:00.000Z", revision: 1 };
    const failing = (...codes: string[]) => new DynamoWorkSessionStore({ send: async () => { throw Object.assign(new Error("cancelled"), { name: "TransactionCanceledException", CancellationReasons: codes.map((Code) => ({ Code })) }); } } as never, "table");
    await expect(failing("None", "TransactionConflict").put(record, undefined, { once: true })).rejects.toBeInstanceOf(StoreConflict);
    await expect(failing("None", "ConditionalCheckFailed").put(record, undefined, { once: true })).rejects.toBeInstanceOf(StoreConflict);
    await expect(failing("None", "ThrottlingError").put(record)).rejects.not.toBeInstanceOf(StoreConflict);
  });
});

// Web task channel Q7: Code's task view names the task's own person (`task.owner`), so Cloud never guesses the owner from the People list.
describe("opening a task whose Code view names the owner", () => {
  const base = { taskId: TASK, title: "Fix the README typo", project: "payments", status: "RUNNING", startingRevision: 1, client: "Rovara Cloud", shared: false, createdAt: "2026-11-14T10:00:00.000Z", updatedAt: "2026-11-14T10:05:00.000Z", events: [] };
  const named = (owner: unknown) => ({ task: () => ({ ...base, owner }) });
  const ADA_OWNER = { developerId: ADA, name: "Ada Lovelace" };

  it("a commenter's first open names Code's owner on the session, with no placeholder and no People read", async () => {
    const w = setUp(named(ADA_OWNER));
    const res = await w.post(OPEN, undefined, await w.sam());
    expect(res.status).toBe(200);
    expect(w.route()).toEqual([`GET /v1/dev/tasks/${TASK}`]);
    const record = w.sessions()[0]!;
    expect(record.owner).toEqual(ADA_OWNER);
    expect(record.startedBy).toEqual(ADA_OWNER);
    expect(record.ownerUnresolved).toBeUndefined();
    expect(record.owner.developerId).not.toBe(SAM);
  });

  it("the owner's own first open names the signed-in person, as before", async () => {
    const w = setUp(named(ADA_OWNER));
    await w.post(OPEN, undefined, await w.ada());
    expect(w.sessions()[0]).toMatchObject({ owner: { developerId: ADA, name: "Ada" } });
    expect(w.sessions()[0]!.ownerUnresolved).toBeUndefined();
  });

  it("a session made with a placeholder (an older Code) is healed to Code's owner by anyone who can open it, not only by the owner", async () => {
    const old = setUp();
    const { sessionId } = (await old.post(OPEN, undefined, await old.sam())).body as { sessionId: string };
    expect(old.sessions()[0]!.ownerUnresolved).toBe(true);
    // The same store, now with a Code that names the owner on the task.
    const record = old.sessions()[0]!;
    const newer = setUp(named(ADA_OWNER));
    await newer.work.put(record);
    await newer.post(OPEN, undefined, await newer.kim());
    const healed = newer.sessions().find((one) => one.sessionId === sessionId)!;
    expect(healed.owner).toEqual(ADA_OWNER);
    expect(healed.startedBy).toEqual(ADA_OWNER);
    expect(healed.ownerUnresolved).toBeUndefined();
    expect(healed.revision).toBe(record.revision + 1);
  });

  it.each([
    ["an extra key", { ...ADA_OWNER, issuer: "https://id.example" }],
    ["an id that is not a sign-in id", { developerId: "ada", name: "Ada" }],
    ["an upper-case id", { developerId: "A".repeat(64), name: "Ada" }],
    ["an empty name", { developerId: ADA, name: "  " }],
    ["a name over 80 characters", { developerId: ADA, name: "x".repeat(81) }],
    ["a name that is not text", { developerId: ADA, name: 7 }],
    ["an array", [ADA, "Ada"]],
    ["a string", "Ada"],
    ["null", null],
  ])("does not believe %s: the owner is read from People, as with an older Code", async (_label, owner) => {
    const w = setUp(named(owner));
    expect((await w.post(OPEN, undefined, await w.sam())).status).toBe(200);
    expect(w.route()).toEqual([`GET /v1/dev/tasks/${TASK}`, `GET /v1/dev/tasks/${TASK}/people`]);
    expect(w.sessions()[0]!.ownerUnresolved).toBe(true);
    expect(w.sessions()[0]!.owner.name).toBe("Ada");
  });

  it("never reads the owner from the request: a body naming one changes nothing", async () => {
    const w = setUp(named(ADA_OWNER));
    await w.post(OPEN, { owner: { developerId: SAM, name: "Sam" } }, await w.sam());
    expect(w.sessions()[0]!.owner).toEqual(ADA_OWNER);
  });

  it("a person Code refuses learns nothing and nothing is written, whoever the view names", async () => {
    const w = setUp(named(ADA_OWNER));
    expect(await w.post(OPEN, undefined, await w.eve())).toEqual(REFUSED);
    expect(w.sessions()).toHaveLength(0);
  });
});
