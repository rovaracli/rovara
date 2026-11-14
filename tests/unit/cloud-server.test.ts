// Rovara Cloud's server for its web app (PrepLabsAI/Rovara-cloud#1, phase 1): sign-in through a Rovara Code install
// as a sign-in client, the session cookie and CSRF, the app's API answered from Code as the signed-in person, a token
// refreshed once on 401, and every route not on Code yet answering 501.
import { describe, expect, it } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, returnPath, sessionStatus, type CloudRequest, type CodeTask } from "../../packages/cloud-server/src/index.js";
import { SessionResponseReaderSchema, SessionCloseResponseReaderSchema } from "../../packages/contracts/src/web.js";

const CODE = "https://code.example.test";
const ADA = "a".repeat(64);

interface Call { method: string; path: string; authorization?: string; body?: string }

/** A fake Code install: the token endpoint, the access check and the client routes the server uses. */
function fakeCode() {
  const calls: Call[] = [];
  let validToken = "access-1";
  let refreshable = true;
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
      if (form.get("grant_type") === "authorization_code") return form.get("code") === "good-code" ? respond(200, { access_token: validToken, refresh_token: "refresh-1" }) : respond(400, { error: "invalid_grant" });
      if (form.get("grant_type") === "refresh_token" && refreshable) { validToken = "access-2"; return respond(200, { access_token: "access-2", refresh_token: "refresh-2" }); }
      return respond(400, { error: "invalid_grant" });
    }
    if (call.authorization !== `Bearer ${validToken}`) return respond(401, { error: { code: "AUTH_REQUIRED" } });
    if (url.pathname === "/v1/dev/access") return respond(200, { developerId: ADA, displayName: "Ada", administrator: true, projects: [{ name: "payments", access: "administrator" }], notices: [] });
    if (url.pathname === "/v1/dev/client/projects/payments") return respond(200, { name: "payments", latestRevision: 3, access: "administrator", repositories: [{ name: "api", url: "https://github.com/acme/payments-api.git", defaultBranch: "main", fullName: "acme/payments-api" }] });
    if (url.pathname.startsWith("/v1/dev/client/projects/") && url.pathname.endsWith("/members")) return respond(200, { project: "payments", members });
    if (url.pathname === "/v1/dev/client/projects" && call.method === "POST") return respond(200, { name: "web-app", latestRevision: 1, access: "administrator", repositories: [] });
    if (url.pathname === "/v1/dev/tasks" && call.method === "POST") return respond(200, { task });
    if (url.pathname === `/v1/dev/tasks/${TASK_ID}` && call.method === "GET") return respond(200, { task });
    if (url.pathname === `/v1/dev/tasks/${TASK_ID}/cancel`) { task = { ...task, status: "CANCELLED" }; return respond(200, { task }); }
    if (url.pathname === `/v1/dev/tasks/${TASK_ID}/close`) { task = { ...task, status: "CLOSED" }; return respond(200, { task, closed: true }); }
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
  return { fetchImpl, calls, taskId: TASK_ID, expireToken: () => { validToken = "access-rotated"; }, endSignIn: () => { refreshable = false; validToken = "nobody"; } };
}

function setUp() {
  const code = fakeCode();
  const store = new LocalSessionStore();
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "projects:members", fetch: code.fetchImpl });
  const work = new LocalWorkSessionStore();
  const handler = createCloudHandler({ client, store, work, origin: "https://cloud.example.test", org: { orgId: "acme", name: "Acme", plan: "test" }, callbackPath: "/callback", secureCookies: true, log: () => undefined });
  const call = async (method: string, target: string, options: { cookie?: string; csrf?: string; body?: unknown } = {}) => {
    const url = new URL(target, "http://127.0.0.1:8787");
    const request: CloudRequest = {
      method, path: url.pathname, query: url.searchParams,
      headers: { ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.csrf ? { "x-rovara-csrf": options.csrf } : {}) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    };
    return handler(request);
  };
  /** Signs Ada in through the fake Code and returns her cookie and CSRF token. */
  const signIn = async () => {
    const start = await call("GET", "/v1/auth/browser/authorize?return_to=/app/projects");
    const state = new URL(start!.headers.location!).searchParams.get("state")!;
    const back = await call("GET", `/callback?code=good-code&state=${state}`);
    const cookie = back!.headers["set-cookie"]!.split(";")[0]!;
    const me = JSON.parse((await call("GET", "/v1/web/me", { cookie }))!.body) as { csrf: string };
    return { cookie, csrf: me.csrf, back };
  };
  return { code, store, work, call, signIn };
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
