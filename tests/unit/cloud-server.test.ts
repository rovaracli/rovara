// Rovara Cloud's server for its web app (PrepLabsAI/Rovara-cloud#1, phase 1): sign-in through a Rovara Code install
// as a sign-in client, the session cookie and CSRF, the app's API answered from Code as the signed-in person, a token
// refreshed once on 401 (one refresh shared by calls made together), every route not on Code yet answering 501; and
// phase 2: sessions on Code's tasks, Home's cards and the plan approval page.
import { describe, expect, it } from "vitest";
import { CODE_TASK_PAGE, CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, returnPath, sessionStatus, type CloudRequest, type CodeTask } from "../../packages/cloud-server/src/index.js";
import {
  HomeResponseReaderSchema, SessionResponseReaderSchema, SessionCloseResponseReaderSchema, SessionFollowResponseReaderSchema, SessionPresenceResponseReaderSchema,
  SessionShareDeleteResponseReaderSchema, SessionSharePutResponseReaderSchema, SessionSharesResponseReaderSchema,
} from "../../packages/contracts/src/web.js";
import { createWorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { ProjectOverviewSchema } from "../../packages/contracts/src/session-views.js";
import { isConfirmUrl } from "../../packages/ui/src/text/links.js";

const CODE = "https://code.example.test";
const ADA = "a".repeat(64);
const GRACE = "f".repeat(64);

interface Call { method: string; path: string; authorization?: string; body?: string }

/** A fake Code install: the token endpoint, the access check and the client routes the server uses. */
function fakeCode() {
  const calls: Call[] = [];
  let validToken = "access-1";
  let refreshable = true;
  // Code rotates refresh tokens: each one works once.
  let generation = 1;
  let decisionRefusal: string | undefined;
  // Spec 067: the people Code lets read the task besides its owner (Ada). Grace signs in with her own code and token.
  const readers = new Map<string, { developerId: string; name: string; role: string; projectMember: boolean; grantedAt: string }>();
  const members = [{ developerId: ADA, name: "Ada", role: "administrator" }];
  const TASK_ID = "6f9d0c1e-2b3a-4c5d-8e7f-001122334455";
  let task: Record<string, unknown> = {
    taskId: TASK_ID, title: "Fix the README typo", project: "payments", status: "RUNNING", startingRevision: 1, client: "Rovara Cloud", shared: false,
    createdAt: "2026-11-14T10:00:00.000Z", updatedAt: "2026-11-14T10:05:00.000Z", events: [], changedFiles: [], artifacts: [], pullRequests: [], pageActions: [],
  };
  let peopleRevision = 3;
  const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const call: Call = { method: init?.method ?? "GET", path: url.pathname, ...(init?.headers ? { authorization: (init.headers as Record<string, string>).authorization } : {}), ...(typeof init?.body === "string" ? { body: init.body } : init?.body instanceof URLSearchParams ? { body: init.body.toString() } : {}) };
    calls.push(call);
    if (url.pathname === "/v1/auth/token") {
      const form = new URLSearchParams(call.body);
      if (call.authorization !== `Basic ${Buffer.from("rovara-cloud:secret").toString("base64")}`) return respond(401, { error: "invalid_client" });
      if (form.get("grant_type") === "authorization_code" && form.get("code") === "grace-code") return respond(200, { access_token: "grace-access" });
      if (form.get("grant_type") === "authorization_code") return form.get("code") === "good-code" ? respond(200, { access_token: validToken, refresh_token: "refresh-1" }) : respond(400, { error: "invalid_grant" });
      if (form.get("grant_type") === "refresh_token" && refreshable && form.get("refresh_token") === `refresh-${String(generation)}`) {
        generation += 1;
        validToken = `access-${String(generation)}`;
        return respond(200, { access_token: validToken, refresh_token: `refresh-${String(generation)}` });
      }
      return respond(400, { error: "invalid_grant" });
    }
    const grace = call.authorization === "Bearer grace-access";
    if (call.authorization !== `Bearer ${validToken}` && !grace) return respond(401, { error: { code: "AUTH_REQUIRED" } });
    if (url.pathname === "/v1/dev/access") {
      return respond(200, grace
        ? { developerId: GRACE, displayName: "Grace", nameChosen: false, administrator: false, projects: [{ name: "payments", access: "developer" }], notices: [] }
        : { developerId: ADA, displayName: "Ada", administrator: true, projects: [{ name: "payments", access: "administrator" }], notices: [] });
    }
    if (url.pathname === "/v1/dev/me/name" && call.method === "PUT") {
      const raw = (JSON.parse(call.body ?? "{}") as { name?: unknown }).name;
      const name = (typeof raw === "string" ? raw : "").replace(/\s+/gu, " ").trim();
      return name.includes("@") ? respond(400, { error: { code: "CONFIG_INVALID", message: "name: must not be an email address" } }) : respond(200, { name, nameChosen: true, requestId: "r" });
    }
    const notYours = () => respond(404, { error: { code: "TASK_NOT_FOUND", message: `no task ${TASK_ID} of yours` } });
    if (grace && url.pathname.startsWith(`/v1/dev/tasks/${TASK_ID}`)) {
      if (!readers.has(GRACE)) return notYours();
      if (url.pathname.includes("/readers")) return respond(403, { error: { code: "FORBIDDEN", message: "only the task's owner can share it" } });
      if (url.pathname !== `/v1/dev/tasks/${TASK_ID}` || call.method !== "GET") return notYours();
    }
    if (url.pathname === `/v1/dev/tasks/${TASK_ID}/readers`) return respond(200, { readers: [...readers.values()] });
    const reader = new RegExp(`^/v1/dev/tasks/${TASK_ID}/readers/([a-f0-9]{64})$`, "u").exec(url.pathname);
    if (reader !== null && call.method === "PUT") {
      if (reader[1] !== GRACE) return respond(400, { error: { code: "CONFIG_INVALID", message: "that person isn't a member of payments; add them to the project first" } });
      const already = readers.has(GRACE);
      readers.set(GRACE, readers.get(GRACE) ?? { developerId: GRACE, name: "Grace", role: "viewer", projectMember: true, grantedAt: "2026-11-14T10:06:00.000Z" });
      return respond(200, { reader: readers.get(GRACE), already });
    }
    if (reader !== null && call.method === "DELETE") return respond(200, { developerId: reader[1], removed: readers.delete(reader[1]!) });
    if (url.pathname === "/v1/dev/client/projects/payments") return respond(200, { name: "payments", latestRevision: 3, access: "administrator", repositories: [{ name: "api", url: "https://github.com/acme/payments-api.git", defaultBranch: "main", fullName: "acme/payments-api" }] });
    if (url.pathname.startsWith("/v1/dev/client/projects/") && url.pathname.endsWith("/members")) return respond(200, { project: "payments", members });
    if (url.pathname === "/v1/dev/client/projects" && call.method === "POST") return respond(200, { name: "web-app", latestRevision: 1, access: "administrator", repositories: [] });
    if (url.pathname === "/v1/dev/tasks" && call.method === "POST") return respond(200, { task });
    if (url.pathname === `/v1/dev/tasks/${TASK_ID}` && call.method === "GET") return respond(200, { task });
    if (url.pathname === `/v1/dev/tasks/${TASK_ID}/cancel`) { task = { ...task, status: "CANCELLED" }; return respond(200, { task }); }
    if (url.pathname === `/v1/dev/tasks/${TASK_ID}/close`) { task = { ...task, status: "CLOSED" }; return respond(200, { task, closed: true }); }
    if (url.pathname === `/v1/dev/tasks/${TASK_ID}/workflow/review` && call.method === "POST") {
      task = { ...task, workflow: { ...(task.workflow as object), state: "RUNNING", revision: 17 } };
      return respond(200, { task, requestId: "r" });
    }
    if (url.pathname === `/v1/dev/tasks/${TASK_ID}/workflow/decision`) {
      if (decisionRefusal !== undefined) return respond(409, { error: { code: "IDEMPOTENCY_CONFLICT", message: decisionRefusal } });
      task = { ...task, workflow: { ...(task.workflow as object), stage: "IMPLEMENTATION", state: "RUNNING" } };
      return respond(200, { task });
    }
    if (url.pathname === `/v1/dev/tasks/${TASK_ID}/people` && call.method === "GET") return respond(200, { view: { revision: peopleRevision } });
    if (url.pathname === `/v1/dev/tasks/${TASK_ID}/people/take-ownership`) {
      const body = JSON.parse(call.body ?? "{}") as { expectedPeopleRevision?: number };
      if (body.expectedPeopleRevision !== peopleRevision) return respond(409, { error: { code: "CONFLICT", message: "people changed" } });
      peopleRevision += 1;
      return respond(200, { view: { revision: peopleRevision } });
    }
    if (url.pathname === "/v1/dev/client/repositories") return respond(200, { installations: [{ installationId: 7, accountLogin: "acme", accountType: "Organization", repositorySelection: "selected", status: "active", repositories: [{ fullName: "acme/payments-api", githubRepositoryId: 1, private: true, defaultBranch: "main" }, { fullName: "acme/web-app", githubRepositoryId: 2, private: true, defaultBranch: "main" }] }] });
    return respond(404, { error: { code: "NOT_FOUND", message: "route not found" } });
  }) as typeof fetch;
  return {
    fetchImpl, calls, taskId: TASK_ID,
    setTask: (change: Record<string, unknown>) => { task = { ...task, ...change }; },
    refuseDecisions: (message: string) => { decisionRefusal = message; },
    expireToken: () => { validToken = "access-rotated"; }, endSignIn: () => { refreshable = false; validToken = "nobody"; } };
}

function setUp() {
  const code = fakeCode();
  const store = new LocalSessionStore();
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "projects:members", fetch: code.fetchImpl });
  const work = new LocalWorkSessionStore();
  const clock = { ms: Date.parse("2026-11-14T12:00:00.000Z") };
  const handler = createCloudHandler({ client, store, work, origin: "https://cloud.example.test", org: { orgId: "acme", name: "Acme", plan: "test" }, callbackPath: "/callback", secureCookies: true, log: () => undefined, now: () => new Date(clock.ms) });
  const call = async (method: string, target: string, options: { cookie?: string; csrf?: string; body?: unknown; form?: Record<string, string>; headers?: Record<string, string> } = {}) => {
    const url = new URL(target, "http://127.0.0.1:8787");
    const request: CloudRequest = {
      method, path: url.pathname, query: url.searchParams,
      headers: {
        ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.csrf ? { "x-rovara-csrf": options.csrf } : {}),
        ...(options.form ? { "content-type": "application/x-www-form-urlencoded" } : {}), ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.form === undefined ? {} : { body: new URLSearchParams(options.form).toString() }),
    };
    return handler(request);
  };
  /** Signs Ada (or, with grace-code, Grace) in through the fake Code and returns the cookie and CSRF token. */
  const signIn = async (code = "good-code") => {
    const start = await call("GET", "/v1/auth/browser/authorize?return_to=/app/projects");
    const state = new URL(start!.headers.location!).searchParams.get("state")!;
    const back = await call("GET", `/callback?code=${code}&state=${state}`);
    const cookie = back!.headers["set-cookie"]!.split(";")[0]!;
    const me = JSON.parse((await call("GET", "/v1/web/me", { cookie }))!.body) as { csrf: string };
    return { cookie, csrf: me.csrf, back };
  };
  return { code, store, work, call, signIn, clock };
}

describe("signing in through Rovara Code", () => {
  it("sends the browser to Code with PKCE and Cloud's client, and back to the page it came from with a secure, HttpOnly cookie", async () => {
    const { call, signIn } = setUp();
    const start = await call("GET", "/v1/auth/browser/authorize?return_to=/app/projects");
    const authorize = new URL(start!.headers.location!);
    expect(authorize.origin + authorize.pathname).toBe(`${CODE}/v1/auth/authorize`);
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({ response_type: "code", client_id: "rovara-cloud", redirect_uri: "http://127.0.0.1:8787/callback", code_challenge_method: "S256", scope: "projects:members" });
    const { back } = await signIn();
    expect(back!.status).toBe(302);
    expect(back!.headers.location).toBe("/app/projects");
    expect(back!.headers["set-cookie"]).toMatch(/^rovara_cloud_session=[\w-]{43}; HttpOnly; SameSite=Lax; Path=\/; Secure$/u);
  });

  it("refuses a state it did not issue, a state used twice, and a code Code refuses", async () => {
    const { call } = setUp();
    expect((await call("GET", "/callback?code=good-code&state=made-up"))!.status).toBe(400);
    const start = await call("GET", "/v1/auth/browser/authorize");
    const state = new URL(start!.headers.location!).searchParams.get("state")!;
    expect((await call("GET", `/callback?code=bad-code&state=${state}`))!.status).toBe(502);
    expect((await call("GET", `/callback?code=good-code&state=${state}`))!.status).toBe(400);
  });

  it("returns only to an app path", () => {
    expect(returnPath("/app/projects/payments")).toBe("/app/projects/payments");
    for (const outside of ["https://evil.example", "//evil.example", "/app/../admin", "/v1/web/me", null]) expect(returnPath(outside)).toBe("/app");
  });
});

describe("Code's own task page", () => {
  it("sends the browser to Code for /review/<task>/task, the link the app shows where Cloud has no page of its own", async () => {
    const { call } = setUp();
    for (const method of ["GET", "HEAD"]) {
      const answer = await call(method, "/review/11111111-1111-4111-8111-111111111111/task");
      expect(answer?.status).toBe(302);
      expect(answer?.headers.location).toBe(`${CODE}/review/11111111-1111-4111-8111-111111111111/task`);
    }
    // Code decides who may read the page, so Cloud needs no sign-in to send the browser there.
    expect((await call("GET", "/review/tsk_abc/task"))?.headers.location).toBe(`${CODE}/review/tsk_abc/task`);
  });

  it("sends nothing else on: other paths and methods are not Cloud's", async () => {
    const { call } = setUp();
    for (const path of ["/review/abc/task/api/e2e", "/review/abc", "/review//task", "/review/a.b/task", "/review/" + "a".repeat(101) + "/task"]) expect(await call("GET", path)).toBeUndefined();
    expect(await call("POST", "/review/abc/task")).toBeUndefined();
    expect(CODE_TASK_PAGE.test("/review/abc/task")).toBe(true);
  });
});

describe("the app's API, answered from Code as the person", () => {
  it("needs a session, and the CSRF token for a change", async () => {
    const { call, signIn } = setUp();
    expect((await call("GET", "/v1/web/me"))!.status).toBe(401);
    const { cookie } = await signIn();
    expect((await call("POST", "/v1/web/projects", { cookie, body: { repository: "acme/web-app" } }))!.status).toBe(403);
  });

  it("answers me, nav and the projects from Code's access check and project read", async () => {
    const { call, signIn } = setUp();
    const { cookie } = await signIn();
    expect(JSON.parse((await call("GET", "/v1/web/me", { cookie }))!.body)).toMatchObject({ developer: { id: ADA, name: "Ada", orgRole: "owner" }, org: { orgId: "acme", name: "Acme" } });
    expect(JSON.parse((await call("GET", "/v1/web/nav", { cookie }))!.body)).toMatchObject({ org: { name: "Acme" }, projects: [{ name: "payments" }], features: { admin: true } });
    expect(JSON.parse((await call("GET", "/v1/web/projects", { cookie }))!.body)).toEqual({ projects: [{ name: "payments", status: "active", latestRevision: 3, myRole: "maintainer", setup: { status: "unchecked" }, repositories: [{ name: "api", fullName: "acme/payments-api", defaultBranch: "main" }] }] });
    expect(JSON.parse((await call("GET", "/v1/web/projects/payments/overview", { cookie }))!.body)).toMatchObject({ project: { name: "payments", latestRevision: 3, repositories: [{ fullName: "acme/payments-api" }] }, you: { role: "maintainer", canEditSettings: true } });
    expect((await call("GET", "/v1/web/projects/ledger", { cookie }))!.status).toBe(404);
  });

  it("lists, adds and removes a project's members through Code, and adds only contributors", async () => {
    const { call, signIn, code } = setUp();
    const { cookie, csrf } = await signIn();
    expect(JSON.parse((await call("GET", "/v1/web/projects/payments/members", { cookie }))!.body)).toEqual({ members: [{ developerId: ADA, name: "Ada", role: "maintainer", source: "grant" }] });
    expect((await call("PUT", "/v1/web/projects/payments/members/cy%40example.com", { cookie, csrf, body: { role: "maintainer" } }))!.status).toBe(400);
    await call("PUT", "/v1/web/projects/payments/members/cy%40example.com", { cookie, csrf, body: {} });
    expect(code.calls.at(-1)).toMatchObject({ method: "PUT", path: "/v1/dev/client/projects/payments/members/cy%40example.com" });
  });

  it("creates a project from a repository, and answers a retried request with the same project without asking Code again", async () => {
    const { call, signIn, code } = setUp();
    const { cookie, csrf } = await signIn();
    const first = await call("POST", "/v1/web/projects", { cookie, csrf, body: { requestId: "11111111-1111-4111-8111-111111111111", repository: "acme/web-app", setupCommand: "npm ci" } });
    expect(first!.status).toBe(201);
    expect(JSON.parse(first!.body)).toMatchObject({ duplicate: false, project: { definition: { name: "web-app" } } });
    expect(JSON.parse(code.calls.find((entry) => entry.path === "/v1/dev/client/projects" && entry.method === "POST")!.body!)).toEqual({ repository: "acme/web-app", setupCommands: ["npm ci"] });
    const creates = code.calls.filter((entry) => entry.method === "POST" && entry.path === "/v1/dev/client/projects").length;
    const again = await call("POST", "/v1/web/projects", { cookie, csrf, body: { requestId: "11111111-1111-4111-8111-111111111111", repository: "acme/web-app" } });
    expect(JSON.parse(again!.body)).toMatchObject({ duplicate: true, project: { definition: { name: "web-app" } } });
    expect(code.calls.filter((entry) => entry.method === "POST" && entry.path === "/v1/dev/client/projects")).toHaveLength(creates);
  });

  it("lists GitHub accounts and their repositories, marking one a project already uses", async () => {
    const { call, signIn } = setUp();
    const { cookie } = await signIn();
    expect(JSON.parse((await call("GET", "/v1/web/github/installations", { cookie }))!.body)).toEqual({ installations: [{ installationId: 7, accountLogin: "acme", accountType: "Organization", repositorySelection: "selected", status: "active" }] });
    const repositories = JSON.parse((await call("GET", "/v1/web/github/repositories?installation=7", { cookie }))!.body) as { repositories: Array<{ fullName: string; project?: string }> };
    expect(repositories.repositories.map(({ fullName, project }) => ({ fullName, project }))).toEqual([{ fullName: "acme/payments-api", project: "payments" }, { fullName: "acme/web-app", project: undefined }]);
    expect((await call("GET", "/v1/web/github/repositories?installation=9", { cookie }))!.status).toBe(404);
  });

  it("refreshes an expired token once and keeps the new one; signs the person out when the sign-in has ended", async () => {
    const { call, signIn, code, store } = setUp();
    const { cookie } = await signIn();
    code.expireToken();
    expect((await call("GET", "/v1/web/nav", { cookie }))!.status).toBe(200);
    const id = cookie.split("=")[1]!;
    expect((await store.get(id))?.accessToken).toBe("access-2");
    code.endSignIn();
    expect((await call("GET", "/v1/web/nav", { cookie }))!.status).toBe(401);
    expect(await store.get(id)).toBeUndefined();
  });

  it("answers 501 for a route not on Code yet, and leaves the app's pages to the page handler", async () => {
    const { call, signIn } = setUp();
    const { cookie } = await signIn();
    const later = await call("GET", "/v1/web/org/budget-settings", { cookie });
    expect(later!.status).toBe(501);
    expect(JSON.parse(later!.body)).toEqual({ error: { code: "NOT_ON_CODE_YET", message: "/v1/app/org/budget-settings isn't connected to Rovara Code yet." } });
    expect(await call("GET", "/app/projects")).toBeUndefined();
  });

  it("sets the person's own name in Code, passes only the name, and shows it at once; nameChosen follows Code (Rovara#634)", async () => {
    const { call, signIn, code } = setUp();
    const grace = await signIn("grace-code");
    expect(JSON.parse((await call("GET", "/v1/web/me", { cookie: grace.cookie }))!.body)).toMatchObject({ developer: { nameChosen: false } });
    const saved = await call("PUT", "/v1/web/me/name", { cookie: grace.cookie, csrf: grace.csrf, body: { name: "  Grace   Hopper ", developerId: ADA } });
    expect(saved!.status).toBe(200);
    expect(JSON.parse(saved!.body)).toEqual({ name: "Grace Hopper", nameChosen: true });
    expect(JSON.parse(code.calls.find((c) => c.path === "/v1/dev/me/name")!.body!)).toEqual({ name: "  Grace   Hopper " });
    expect(JSON.parse((await call("GET", "/v1/web/me", { cookie: grace.cookie }))!.body)).toMatchObject({ developer: { name: "Grace Hopper", nameChosen: true } });

    const refused = await call("PUT", "/v1/web/me/name", { cookie: grace.cookie, csrf: grace.csrf, body: { name: "grace@example.com" } });
    expect(refused!.status).toBe(400);
    expect(JSON.parse(refused!.body)).toMatchObject({ error: { code: "CONFIG_INVALID" } });
    expect((await call("PUT", "/v1/web/me/name", { cookie: grace.cookie, csrf: grace.csrf, body: {} }))!.status).toBe(400);
    // An older Code says nothing about it: the app is not asked to prompt.
    const ada = await signIn();
    expect(JSON.parse((await call("GET", "/v1/web/me", { cookie: ada.cookie }))!.body)).toMatchObject({ developer: { nameChosen: true } });
  });

  it("answers what the agent loaded and its lessons as not recorded (404)", async () => {
    const { call, signIn } = setUp();
    const { cookie } = await signIn();
    for (const path of ["/v1/web/tasks/6f9d0c1e-2b3a-4c5d-8e7f-001122334455/loaded-knowledge", "/v1/web/tasks/6f9d0c1e-2b3a-4c5d-8e7f-001122334455/loaded-knowledge/op1/plan/0", "/v1/web/tasks/6f9d0c1e-2b3a-4c5d-8e7f-001122334455/lessons"]) {
      const answer = await call("GET", path, { cookie });
      expect(answer!.status).toBe(404);
      expect(JSON.parse(answer!.body)).toMatchObject({ error: { code: "NOT_FOUND" } });
    }
  });

  it("answers live updates as not offered (404), which the app reads as off rather than reconnecting", async () => {
    const { call, signIn } = setUp();
    const { cookie, csrf } = await signIn();
    const token = await call("POST", "/v1/web/realtime/token", { cookie, csrf });
    expect(token!.status).toBe(404);
    expect(JSON.parse(token!.body)).toEqual({ error: { code: "NOT_FOUND", message: "Live updates aren't on Rovara Code yet." } });
  });

  it("answers decision cards as switched off (404), which the app shows as no cards rather than an error", async () => {
    const { call, signIn } = setUp();
    const { cookie } = await signIn();
    const decisions = await call("GET", "/v1/web/decisions", { cookie });
    expect(decisions!.status).toBe(404);
    expect(JSON.parse(decisions!.body)).toEqual({ error: { code: "NOT_FOUND", message: "Decision cards aren't on Rovara Code yet." } });
  });

  it("signs out only with the CSRF token, and clears the cookie either way", async () => {
    const { call, signIn, store } = setUp();
    const { cookie, csrf } = await signIn();
    const id = cookie.split("=")[1]!;
    await call("POST", "/v1/auth/browser/sign-out", { cookie });
    expect(await store.get(id)).toBeDefined();
    const out = await call("POST", "/v1/auth/browser/sign-out", { cookie, csrf });
    expect(out!.headers["set-cookie"]).toContain("Max-Age=0");
    expect(await store.get(id)).toBeUndefined();
  });
});

describe("sessions on Code's tasks (phase 2a)", () => {
  const start = async (call: ReturnType<typeof setUp>["call"], auth: { cookie: string; csrf: string }, requestId = "22222222-2222-4222-8222-222222222222") =>
    call("POST", "/v1/web/projects/payments/code", { ...auth, body: { requestId, input: { text: "Fix the README typo" } } });

  it("starts a Quick task in Code and a Cloud session for it, and answers a retried start with the same session", async () => {
    const { call, signIn, code } = setUp();
    const auth = await signIn();
    const first = await start(call, auth);
    expect(first!.status).toBe(201);
    const body = JSON.parse(first!.body) as { sessionId: string; sessionUrl: string; task: { taskId: string } };
    expect(body.sessionId).toMatch(/^ses_[0-9a-z]{20}$/u);
    expect(body.sessionUrl).toBe(`https://cloud.example.test/s/${body.sessionId}`);
    expect(body.task.taskId).toBe(code.taskId);
    const sent = code.calls.find((entry) => entry.path === "/v1/dev/tasks" && entry.method === "POST")!;
    expect(JSON.parse(sent.body!)).toEqual({ requestId: "22222222-2222-4222-8222-222222222222", project: "payments", instructions: "Fix the README typo", workflow: true, workflowPath: "QUICK", client: "Rovara Cloud" });
    const again = JSON.parse((await start(call, auth))!.body) as { sessionId: string };
    expect(again.sessionId).toBe(body.sessionId);
    expect(code.calls.filter((entry) => entry.path === "/v1/dev/tasks" && entry.method === "POST")).toHaveLength(1);
  });

  it("refuses a start without a request id or any text", async () => {
    const { call, signIn } = setUp();
    const auth = await signIn();
    expect((await call("POST", "/v1/web/projects/payments/code", { ...auth, body: { input: { text: "x" } } }))!.status).toBe(400);
    expect((await call("POST", "/v1/web/projects/payments/code", { ...auth, body: { requestId: "22222222-2222-4222-8222-222222222222", input: { text: "  " } } }))!.status).toBe(400);
  });

  it("reads a session as the app's session page reads it, with Code's task inside", async () => {
    const { call, signIn } = setUp();
    const auth = await signIn();
    const { sessionId } = JSON.parse((await start(call, auth))!.body) as { sessionId: string };
    const read = await call("GET", `/v1/web/sessions/${sessionId}`, { cookie: auth.cookie });
    expect(read!.status).toBe(200);
    const parsed = SessionResponseReaderSchema.parse(JSON.parse(read!.body));
    expect(parsed.session).toMatchObject({ sessionId, kind: "task", title: "Fix the README typo", project: "payments", status: "running", owner: { developerId: ADA, name: "Ada" }, you: { owner: true, level: "edit" } });
    expect((parsed.session.body as { kind: string; task: { taskId: string } }).task.taskId).toBeDefined();
    expect((await call("GET", "/v1/web/sessions/ses_00000000000000000000", { cookie: auth.cookie }))!.status).toBe(404);
  });

  it("stops and closes through Code, and the session shows the task's new state", async () => {
    const { call, signIn, code } = setUp();
    const auth = await signIn();
    const { sessionId } = JSON.parse((await start(call, auth))!.body) as { sessionId: string };
    const stopped = await call("POST", `/v1/web/sessions/${sessionId}/stop`, { ...auth, body: { requestId: "33333333-3333-4333-8333-333333333333" } });
    expect(SessionResponseReaderSchema.parse(JSON.parse(stopped!.body)).session.status).toBe("cancelled");
    expect(code.calls.at(-1)).toMatchObject({ method: "POST", path: `/v1/dev/tasks/${code.taskId}/cancel` });
    const closed = await call("POST", `/v1/web/sessions/${sessionId}/close`, { ...auth, body: { requestId: "44444444-4444-4444-8444-444444444444" } });
    expect(SessionCloseResponseReaderSchema.parse(JSON.parse(closed!.body))).toMatchObject({ closed: true, session: { status: "stopped" } });
  });

  it("takes over a session against the people revision Code shows, and makes the person its owner", async () => {
    const { call, signIn, code, work } = setUp();
    const auth = await signIn();
    const { sessionId } = JSON.parse((await start(call, auth))!.body) as { sessionId: string };
    const taken = await call("POST", `/v1/web/sessions/${sessionId}/take-over`, { ...auth, body: { requestId: "55555555-5555-4555-8555-555555555555" } });
    expect(taken!.status).toBe(200);
    const sent = code.calls.find((entry) => entry.path.endsWith("/take-ownership"))!;
    expect(JSON.parse(sent.body!)).toEqual({ requestId: "55555555-5555-4555-8555-555555555555", expectedPeopleRevision: 3 });
    expect((await work.get(sessionId))?.revision).toBe(2);
  });

  it("needs the CSRF token for each change", async () => {
    const { call, signIn } = setUp();
    const auth = await signIn();
    const { sessionId } = JSON.parse((await start(call, auth))!.body) as { sessionId: string };
    expect((await call("POST", `/v1/web/sessions/${sessionId}/stop`, { cookie: auth.cookie, body: { requestId: "33333333-3333-4333-8333-333333333333" } }))!.status).toBe(403);
  });

  it("puts Code's task status in Cloud's words", () => {
    const task = (status: CodeTask["status"], state?: string): CodeTask => ({ taskId: "t", title: "t", project: "p", status, ...(state === undefined ? {} : { workflow: { state } }), createdAt: "", updatedAt: "" });
    expect([sessionStatus(task("STARTING")), sessionStatus(task("RUNNING")), sessionStatus(task("RUNNING", "BLOCKED")), sessionStatus(task("INTERRUPTED")), sessionStatus(task("CLOSED"))])
      .toEqual(["starting", "running", "needs_person", "failed", "stopped"]);
  });
});

const PLAN_DIGEST = "b".repeat(64);
const artifact = (version: number, sha256: string) => ({ id: `plan-${String(version)}`, type: "plan", version, sha256, producer: "planner", objectKey: `plans/${String(version)}.md`, createdAt: "2026-11-14T10:04:00.000Z" });
/** A Quick task whose plan (version 2) waits for its owner's review at workflow revision 4: a whole workflow, as Code sends it. */
const PLAN_WAITING = {
  workflow: {
    ...createWorkflowSnapshot({ taskId: "6f9d0c1e-2b3a-4c5d-8e7f-001122334455", ownerId: ADA, now: "2026-11-14T10:00:00.000Z", path: "QUICK" }),
    revision: 4, stage: "PLAN_REVIEW", state: "WAITING", artifacts: [artifact(1, "a".repeat(64)), artifact(2, PLAN_DIGEST)],
  },
};

const CANDIDATE = "f".repeat(64);
/** Code's REVIEW/BLOCKED as production showed it (Rovara-cloud#15): checks passed, the critic passed, the security review gave no answer in shape. */
const REVIEW_BLOCKED = (passed = true) => ({
  workflow: {
    ...createWorkflowSnapshot({ taskId: "6f9d0c1e-2b3a-4c5d-8e7f-001122334455", ownerId: ADA, now: "2026-11-14T10:00:00.000Z", path: "QUICK" }),
    revision: 16, stage: "REVIEW", state: "BLOCKED", blockReason: "the security review did not pass",
    candidate: { schemaVersion: 1, digest: CANDIDATE, repositories: [{ repositoryId: "payments", baseCommitSha: "1".repeat(40), commitSha: "2".repeat(40), treeSha: "3".repeat(40) }] },
    verification: { candidateDigest: CANDIDATE, environmentId: "fa8460e0-eedb-4103-9e34-016a6845ed54", producer: "agentx-worker-checks", recordedAt: "2026-11-14T10:02:52.913Z", results: [{ checkId: "required-1", status: passed ? "PASS" : "FAIL" }] },
    reviews: [
      { candidateDigest: CANDIDATE, operationId: "6a756d44-f9d4-43f2-bc1c-8298e1296d5b", provider: "amazon-bedrock", readOnly: true, recordedAt: "2026-11-14T10:02:59.001Z", role: "CRITIC", status: "PASS", version: "amazon.nova-pro-v1:0", findings: [{ advisory: true, origin: "INTRODUCED", severity: "LOW", text: "Looks right." }] },
      { candidateDigest: CANDIDATE, operationId: "6a756d44-f9d4-43f2-bc1c-8298e1296d5b", provider: "amazon-bedrock", readOnly: true, recordedAt: "2026-11-14T10:03:02.011Z", role: "SECURITY", status: "UNKNOWN", failureReason: "INVALID_SHAPE", version: "amazon.nova-pro-v1:0", findings: [] },
    ],
  },
});

describe("Home's cards and plan approval (phase 2b)", () => {
  const begin = async () => {
    const context = setUp();
    const auth = await context.signIn();
    const started = await context.call("POST", "/v1/web/projects/payments/code", { ...auth, body: { requestId: "22222222-2222-4222-8222-222222222222", input: { text: "Fix the README typo" } } });
    const { sessionId } = JSON.parse(started!.body) as { sessionId: string };
    return { ...context, auth, sessionId };
  };
  const home = async (call: ReturnType<typeof setUp>["call"], cookie: string) => HomeResponseReaderSchema.parse(JSON.parse((await call("GET", "/v1/web/home", { cookie }))!.body));
  const ORIGIN = { origin: "https://cloud.example.test" };

  it("has no cards while nothing needs the person", async () => {
    const { call, auth } = await begin();
    expect(await home(call, auth.cookie)).toEqual({ cards: [], total: 0 });
  });

  it("shows a plan waiting for its owner as a card and on the session, with a link the app accepts", async () => {
    const { call, auth, code, sessionId } = await begin();
    code.setTask(PLAN_WAITING);
    const confirmUrl = `https://cloud.example.test/v1/app/approve/plan-${sessionId}`;
    const answer = await home(call, auth.cookie);
    expect(answer).toMatchObject({ total: 1, cards: [{ cardId: `plan:${sessionId}`, kind: "plan", title: "Fix the README typo", sessionId, buttons: [{ action: "confirm", href: confirmUrl, method: "GET" }, { action: "open", href: `https://cloud.example.test/s/${sessionId}` }] }] });
    expect(JSON.parse((await call("GET", "/v1/web/nav", { cookie: auth.cookie }))!.body)).toMatchObject({ homeCount: 1 });
    const session = SessionResponseReaderSchema.parse(JSON.parse((await call("GET", `/v1/web/sessions/${sessionId}`, { cookie: auth.cookie }))!.body)).session;
    expect(session.approvals).toEqual([{ approvalId: `plan-${sessionId}`, title: "Review the plan", confirmUrl }]);
    expect(isConfirmUrl(confirmUrl, "https://cloud.example.test")).toBe(true);
  });

  it("lists the person's running sessions on the project page as Live tiles, until they end", async () => {
    const { call, auth, code, sessionId } = await begin();
    const overview = async (project: string) => ProjectOverviewSchema.parse(JSON.parse((await call("GET", `/v1/web/projects/${project}/overview`, { cookie: auth.cookie }))!.body));
    code.setTask(PLAN_WAITING);
    const confirmUrl = `https://cloud.example.test/v1/app/approve/plan-${sessionId}`;
    expect((await overview("payments")).running).toEqual([expect.objectContaining({
      sessionId, kind: "task", title: "Fix the README typo", project: "payments", status: "needs_person", statusWords: "Waiting for you", step: "Plan review",
      needsYou: true, following: true, approvalUrl: confirmUrl, actions: ["watch", "stop", "close"],
    })]);
    // Code's task status is its worker's last run: between steps it reads SUCCEEDED while the workflow still waits on the person.
    code.setTask({ status: "SUCCEEDED" });
    expect((await overview("payments")).running).toEqual([expect.objectContaining({ sessionId, status: "needs_person", needsYou: true })]);
    code.setTask({ status: "CLOSED" });
    expect((await overview("payments")).running).toEqual([]);
  });

  it("shows a review that couldn't finish to its owner with Code's reason, and retries the reviews from Home or the session (Rovara-cloud#15)", async () => {
    const { call, auth, code, sessionId } = await begin();
    code.setTask({ status: "RUNNING", ...REVIEW_BLOCKED() });
    const reason = "A review couldn't finish (security review: its answer wasn't in the expected format). Nothing was sent to GitHub.";
    const retryHref = `https://cloud.example.test/v1/app/sessions/${sessionId}/retry`;
    expect(await home(call, auth.cookie)).toMatchObject({ total: 1, cards: [{ cardId: `failure:${sessionId}`, kind: "failure", reason, buttons: [{ label: "Retry reviews", action: "retry", href: retryHref, method: "POST" }, { action: "open" }] }] });
    const before = SessionResponseReaderSchema.parse(JSON.parse((await call("GET", `/v1/web/sessions/${sessionId}`, { cookie: auth.cookie }))!.body)).session;
    expect(before.you.actions).toContain("retry");
    expect(before.status).toBe("needs_person");
    const [tile] = ProjectOverviewSchema.parse(JSON.parse((await call("GET", "/v1/web/projects/payments/overview", { cookie: auth.cookie }))!.body)).running;
    expect(tile?.statusWords).toBe("Review couldn't finish");
    expect(tile?.actions).toContain("retry");

    const retried = await call("POST", `/v1/web/sessions/${sessionId}/retry`, { ...auth, body: { requestId: "77777777-7777-4777-8777-777777777777" } });
    expect(retried!.status).toBe(200);
    expect(SessionResponseReaderSchema.parse(JSON.parse(retried!.body)).session.status).toBe("running");
    const { requestId, instructions, ...fence } = JSON.parse(code.calls.find((entry) => entry.path === `/v1/dev/tasks/${code.taskId}/workflow/review`)!.body!) as Record<string, unknown>;
    expect(requestId).toBe("77777777-7777-4777-8777-777777777777");
    expect(instructions).toMatch(/^Retry the independent read-only code and security reviews/u);
    expect(fence).toEqual({ expectedRevision: 16, candidateDigest: CANDIDATE });
    expect(await home(call, auth.cookie)).toEqual({ cards: [], total: 0 });
  });

  it("treats a task between steps (Code's status SUCCEEDED) by its workflow: a blocked review still gets its card, a queued step is running, a pull request waiting for merge needs the person", async () => {
    const { call, auth, code, sessionId } = await begin();
    code.setTask({ status: "SUCCEEDED", ...REVIEW_BLOCKED() });
    expect((await home(call, auth.cookie)).cards.map((card) => card.buttons.map((button) => button.label))).toEqual([["Retry reviews", "Open session"]]);
    const status = async () => SessionResponseReaderSchema.parse(JSON.parse((await call("GET", `/v1/web/sessions/${sessionId}`, { cookie: auth.cookie }))!.body)).session.status;
    code.setTask({ status: "SUCCEEDED", workflow: { ...REVIEW_BLOCKED().workflow, stage: "PULL_REQUEST", state: "READY" } });
    expect(await status()).toBe("running");
    code.setTask({ status: "SUCCEEDED", workflow: { ...REVIEW_BLOCKED().workflow, stage: "WAIT_FOR_MERGE", state: "WAITING" } });
    expect(await status()).toBe("needs_person");
  });

  it("offers no review retry when the checks didn't pass or the task isn't stopped at review, and needs a request ID", async () => {
    const { call, auth, code, sessionId } = await begin();
    code.setTask({ status: "RUNNING", ...REVIEW_BLOCKED(false) });
    const [card] = (await home(call, auth.cookie)).cards;
    expect(card?.buttons.map((button) => button.label)).toEqual(["Open session"]);
    expect((await call("POST", `/v1/web/sessions/${sessionId}/retry`, { ...auth, body: { requestId: "77777777-7777-4777-8777-777777777777" } }))!.status).toBe(409);
    code.setTask(PLAN_WAITING);
    expect((await call("POST", `/v1/web/sessions/${sessionId}/retry`, { ...auth, body: { requestId: "77777777-7777-4777-8777-777777777777" } }))!.status).toBe(409);
    expect((await call("POST", `/v1/web/sessions/${sessionId}/retry`, { ...auth, body: {} }))!.status).toBe(400);
    expect(code.calls.some((entry) => entry.path.endsWith("/workflow/review"))).toBe(false);
  });

  it("shows a failed run and an open pull request, until the pull request is merged", async () => {
    const { call, auth, code, sessionId } = await begin();
    code.setTask({ status: "FAILED" });
    expect((await home(call, auth.cookie)).cards).toMatchObject([{ kind: "failure", cardId: `failure:${sessionId}` }]);
    code.setTask({ status: "SUCCEEDED", pullRequests: [{ repository: "acme/payments-api", number: 12, url: "https://github.com/acme/payments-api/pull/12", state: "open" }] });
    expect((await home(call, auth.cookie)).cards).toMatchObject([{ kind: "pull_request", buttons: [{ action: "open", href: "https://github.com/acme/payments-api/pull/12" }, { action: "open" }] }]);
    code.setTask({ pullRequests: [{ repository: "acme/payments-api", number: 12, url: "https://github.com/acme/payments-api/pull/12", state: "merged" }] });
    expect((await home(call, auth.cookie)).total).toBe(0);
  });

  it("shows the plan only to the session's owner", async () => {
    const { call, auth, code, work, sessionId } = await begin();
    code.setTask(PLAN_WAITING);
    const record = (await work.get(sessionId))!;
    await work.put({ ...record, owner: { developerId: "e".repeat(64), name: "Grace <b>" } });
    expect((await home(call, auth.cookie)).total).toBe(0);
    expect(SessionResponseReaderSchema.parse(JSON.parse((await call("GET", `/v1/web/sessions/${sessionId}`, { cookie: auth.cookie }))!.body)).session.approvals).toEqual([]);
    const page = await call("GET", `/v1/app/approve/plan-${sessionId}`, { cookie: auth.cookie });
    expect(page!.status).toBe(403);
    expect(page!.body).toContain("Only Grace &lt;b&gt; can decide this plan");
  });

  it("shows the approval page with the plan it decides, escaped, under a strict policy", async () => {
    const { call, auth, code, sessionId } = await begin();
    expect((await call("GET", `/v1/app/approve/plan-${sessionId}`))!.status).toBe(401);
    expect((await call("GET", `/v1/app/approve/plan-${sessionId}`, { cookie: auth.cookie }))!.status).toBe(409);
    code.setTask({ ...PLAN_WAITING, title: "<script>alert(1)</script>\u202e" });
    const page = await call("GET", `/v1/app/approve/plan-${sessionId}`, { cookie: auth.cookie });
    expect(page!.status).toBe(200);
    expect(page!.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(page!.headers["x-frame-options"]).toBe("DENY");
    expect(page!.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;[U+202E]");
    expect(page!.body).not.toContain("<script>");
    expect(page!.body).toContain(`name="csrf" value="${auth.csrf}"`);
    expect(page!.body).toContain(`name="revision" value="4"`);
    expect(page!.body).toContain(`name="digest" value="${PLAN_DIGEST}"`);
    expect(page!.body).toContain("Plan version 2");
    expect((await call("GET", "/v1/app/approve/plan-ses_00000000000000000000", { cookie: auth.cookie }))!.status).toBe(404);
  });

  it("sends an approval to Code bound to the revision and plan the page showed, then returns to the session", async () => {
    const { call, auth, code, sessionId } = await begin();
    code.setTask(PLAN_WAITING);
    const path = `/v1/app/approve/plan-${sessionId}`;
    const form = { csrf: auth.csrf, revision: "4", digest: PLAN_DIGEST, decision: "APPROVE", reason: "" };
    expect((await call("POST", path, { cookie: auth.cookie, form }))!.status).toBe(403);
    expect((await call("POST", path, { cookie: auth.cookie, form, headers: { origin: "https://evil.example.test" } }))!.status).toBe(403);
    expect((await call("POST", path, { cookie: auth.cookie, form: { ...form, csrf: "wrong" }, headers: ORIGIN }))!.status).toBe(403);
    expect((await call("POST", path, { cookie: auth.cookie, form: { ...form, decision: "REQUEST_CHANGES" }, headers: ORIGIN }))!.status).toBe(400);
    expect((await call("POST", path, { cookie: auth.cookie, form: { ...form, digest: "a".repeat(64) }, headers: ORIGIN }))!.status).toBe(409);
    expect(code.calls.some((entry) => entry.path.endsWith("/workflow/decision"))).toBe(false);
    const done = await call("POST", path, { cookie: auth.cookie, form, headers: ORIGIN });
    expect(done).toMatchObject({ status: 303, headers: { location: `/s/${sessionId}` } });
    const { requestId, ...sent } = JSON.parse(code.calls.find((entry) => entry.path === `/v1/dev/tasks/${code.taskId}/workflow/decision`)!.body!) as Record<string, unknown>;
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(sent).toEqual({ expectedRevision: 4, decision: "APPROVE", reason: "Approved in Rovara Cloud", artifactDigest: PLAN_DIGEST });
    expect((await home(call, auth.cookie)).total).toBe(0);
  });

  it("asks Code for changes with the person's reason, and shows Code's refusal as a page", async () => {
    const { call, auth, code, sessionId } = await begin();
    code.setTask(PLAN_WAITING);
    const path = `/v1/app/approve/plan-${sessionId}`;
    const form = { csrf: auth.csrf, revision: "4", digest: PLAN_DIGEST, decision: "REQUEST_CHANGES", reason: "Keep the old heading" };
    code.refuseDecisions("Already approved by <Ada>");
    const refused = await call("POST", path, { cookie: auth.cookie, form, headers: ORIGIN });
    expect(refused!.status).toBe(409);
    expect(refused!.body).toContain("Already approved by &lt;Ada&gt;");
    expect(JSON.parse(code.calls.at(-1)!.body!)).toMatchObject({ decision: "REQUEST_CHANGES", reason: "Keep the old heading", expectedRevision: 4 });
  });

  it("refreshes an expired token once when calls made together all find it expired", async () => {
    const { call, auth, code } = await begin();
    code.expireToken();
    expect((await call("GET", "/v1/web/nav", { cookie: auth.cookie }))!.status).toBe(200);
    expect(code.calls.filter((entry) => entry.path === "/v1/auth/token" && entry.body?.includes("refresh_token"))).toHaveLength(1);
  });
});

describe("following, viewing and sharing a session (phase 2c)", () => {
  const begin = async () => {
    const context = setUp();
    const ada = await context.signIn();
    const grace = await context.signIn("grace-code");
    const started = await context.call("POST", "/v1/web/projects/payments/code", { ...ada, body: { requestId: "22222222-2222-4222-8222-222222222222", input: { text: "Fix the README typo" } } });
    const { sessionId } = JSON.parse(started!.body) as { sessionId: string };
    const share = () => context.call("PUT", `/v1/web/sessions/${sessionId}/shares`, { ...ada, body: { requestId: "66666666-6666-4666-8666-666666666666", principal: { kind: "member", developerId: GRACE }, level: "view" } });
    const read = async (who: { cookie: string }) => SessionResponseReaderSchema.parse(JSON.parse((await context.call("GET", `/v1/web/sessions/${sessionId}`, { cookie: who.cookie }))!.body)).session;
    return { ...context, ada, grace, sessionId, share, read };
  };
  const body = (response: { body: string } | undefined) => JSON.parse(response!.body) as unknown;

  it("shares a session with a person through Code's task readers, lists and removes the share", async () => {
    const { call, code, ada, sessionId, share } = await begin();
    const shared = await share();
    expect(shared!.status).toBe(200);
    expect(SessionSharePutResponseReaderSchema.parse(body(shared))).toEqual({ share: { principal: { kind: "member", developerId: GRACE }, level: "view", sharedBy: { developerId: ADA, name: "Ada" }, sharedAt: "2026-11-14T10:06:00.000Z" } });
    expect(JSON.parse(code.calls.find((entry) => entry.path === `/v1/dev/tasks/${code.taskId}/readers/${GRACE}`)!.body!)).toEqual({ requestId: "66666666-6666-4666-8666-666666666666", role: "viewer" });
    expect(SessionSharesResponseReaderSchema.parse(body(await call("GET", `/v1/web/sessions/${sessionId}/shares`, { cookie: ada.cookie }))).shares).toHaveLength(1);
    const removed = await call("DELETE", `/v1/web/sessions/${sessionId}/shares/${encodeURIComponent(`MEMBER#${GRACE}`)}`, ada);
    expect(SessionShareDeleteResponseReaderSchema.parse(body(removed))).toEqual({ removed: true });
    expect(SessionSharesResponseReaderSchema.parse(body(await call("GET", `/v1/web/sessions/${sessionId}/shares`, { cookie: ada.cookie }))).shares).toEqual([]);
  });

  it("shares only with a person, at view, and passes on Code's refusals", async () => {
    const { call, ada, grace, sessionId } = await begin();
    const put = (who: { cookie: string; csrf: string }, principal: unknown, level = "view") => call("PUT", `/v1/web/sessions/${sessionId}/shares`, { ...who, body: { requestId: "66666666-6666-4666-8666-666666666666", principal, level } });
    for (const principal of [{ kind: "project", project: "payments" }, { kind: "org" }]) expect((await put(ada, principal))!.status).toBe(400);
    expect((await put(ada, { kind: "member", developerId: GRACE }, "edit"))!.status).toBe(400);
    const notMember = await put(ada, { kind: "member", developerId: "b".repeat(64) });
    expect(notMember!.status).toBe(400);
    expect(notMember!.body).toContain("isn't a member of payments");
    expect((await call("DELETE", `/v1/web/sessions/${sessionId}/shares/ORG`, ada))!.status).toBe(400);
    // Someone the task isn't shared with can't see it to share it.
    expect((await put(grace, { kind: "member", developerId: GRACE }))!.status).toBe(404);
  });

  it("shows a shared session to the person at view, to watch only, and not before it is shared", async () => {
    const { call, code, grace, sessionId, share, read } = await begin();
    expect((await call("GET", `/v1/web/sessions/${sessionId}`, { cookie: grace.cookie }))!.status).toBe(404);
    await share();
    code.setTask(PLAN_WAITING);
    expect(await read(grace)).toMatchObject({ sessionId, you: { level: "view", owner: false, following: false, actions: ["watch"] }, approvals: [] });
  });

  it("lets anyone who may read the task follow it; the owner always follows", async () => {
    const { call, ada, grace, sessionId, share, read } = await begin();
    expect(SessionFollowResponseReaderSchema.parse(body(await call("DELETE", `/v1/web/sessions/${sessionId}/follow`, ada)))).toEqual({ following: true });
    expect((await call("POST", `/v1/web/sessions/${sessionId}/follow`, grace))!.status).toBe(404);
    await share();
    expect(SessionFollowResponseReaderSchema.parse(body(await call("POST", `/v1/web/sessions/${sessionId}/follow`, grace)))).toEqual({ following: true });
    expect(await read(grace)).toMatchObject({ followers: 1, you: { following: true } });
    expect(await read(ada)).toMatchObject({ followers: 1, you: { following: true } });
    expect(SessionFollowResponseReaderSchema.parse(body(await call("DELETE", `/v1/web/sessions/${sessionId}/follow`, grace)))).toEqual({ following: false });
    expect((await read(ada)).followers).toBe(0);
    // Unsharing ends the follow too.
    await call("POST", `/v1/web/sessions/${sessionId}/follow`, grace);
    await call("DELETE", `/v1/web/sessions/${sessionId}/shares/${encodeURIComponent(`MEMBER#${GRACE}`)}`, ada);
    expect((await read(ada)).followers).toBe(0);
  });

  it("shows who is looking at a session, for 90 seconds after their last heartbeat", async () => {
    const { call, ada, grace, sessionId, share, read, clock } = await begin();
    const beat = async (who: { cookie: string; csrf: string }) => SessionPresenceResponseReaderSchema.parse(body(await call("POST", `/v1/web/sessions/${sessionId}/presence`, who))).viewingNow;
    expect(await beat(ada)).toEqual([{ developerId: ADA, name: "Ada" }]);
    expect((await call("POST", `/v1/web/sessions/${sessionId}/presence`, grace))!.status).toBe(404);
    await share();
    clock.ms += 30_000;
    expect(await beat(grace)).toEqual([{ developerId: GRACE, name: "Grace" }, { developerId: ADA, name: "Ada" }]);
    expect((await read(ada)).viewingNow).toHaveLength(2);
    clock.ms += 61_000;
    expect((await read(ada)).viewingNow).toEqual([{ developerId: GRACE, name: "Grace" }]);
    clock.ms += 30_000;
    expect((await read(ada)).viewingNow).toEqual([]);
  });
});
