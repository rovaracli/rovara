// Rovara Cloud's server for its web app (PrepLabsAI/Rovara-cloud#1, phase 1): sign-in through a Rovara Code install
// as a sign-in client, the session cookie and CSRF, the app's API answered from Code as the signed-in person, a token
// refreshed once on 401 (one refresh shared by calls made together), every route not on Code yet answering 501; and
// phase 2: sessions on Code's tasks, Home's cards and the plan approval page.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { APPROVAL_FORM_SCRIPT } from "../../packages/cloud-server/src/approve.js";
import { CODE_TASK_PAGE, CodeClient, LocalSessionStore, LocalWorkSessionStore, StoreConflict, createCloudHandler, type SessionStore, type WorkSessionStore, returnPath, sessionStatus, type CloudRequest, type CodeTask } from "../../packages/cloud-server/src/index.js";
import {
  HomeResponseReaderSchema, SessionResponseReaderSchema, SessionCloseResponseReaderSchema, SessionFollowResponseReaderSchema, SessionPresenceResponseReaderSchema,
  SessionShareDeleteResponseReaderSchema, SessionSharePutResponseReaderSchema, SessionSharesResponseReaderSchema, SessionEventPageSchema,
} from "../../packages/contracts/src/web.js";
import { SessionMessageSchema } from "../../packages/contracts/src/agent-sessions.js";
import { SessionMessagePageSchema } from "../../packages/contracts/src/session-views.js";
import { createWorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { ProjectOverviewSchema } from "../../packages/contracts/src/session-views.js";
import { isConfirmUrl } from "../../packages/ui/src/text/links.js";

const CODE = "https://code.example.test";
const ADA = "a".repeat(64);
const GRACE = "f".repeat(64);
const ACME = "org_acme0000000000000000";
const OTHER = "org_other000000000000000";

interface Call { method: string; path: string; authorization?: string; body?: string }

/** A fake Code install: the token endpoint, the access check and the client routes the server uses. */
function fakeCode() {
  const calls: Call[] = [];
  let validToken = "access-1";
  let refreshable = true;
  // Code rotates refresh tokens: each one works once.
  let generation = 1;
  let decisionRefusal: string | undefined;
  // DEC 254zzz94: what Code answers on the task's merge route, by method (unset: Code's unknown-route 404).
  const mergeAnswers = new Map<string, { status: number; body: unknown }>();
  let revokeFails = false;
  // Spec 067: the people Code lets read the task besides its owner (Ada). Grace signs in with her own code and token.
  const readers = new Map<string, { developerId: string; name: string; role: string; projectMember: boolean; grantedAt: string }>();
  const members = [{ developerId: ADA, name: "Ada", role: "administrator" }];
  const TASK_ID = "6f9d0c1e-2b3a-4c5d-8e7f-001122334455";
  let task: Record<string, unknown> = {
    taskId: TASK_ID, title: "Fix the README typo", project: "payments", status: "RUNNING", startingRevision: 1, client: "Rovara Cloud", shared: false,
    createdAt: "2026-11-14T10:00:00.000Z", updatedAt: "2026-11-14T10:05:00.000Z", events: [], changedFiles: [], artifacts: [], pullRequests: [], pageActions: [],
  };
  let peopleRevision = 3;
  let adaName = "Ada";
  let graceName: string | undefined;
  // DEC 253z: the person's company and company role, from Code's live membership. Ada owns Acme; Grace is a member of it.
  const companies = new Map<string, Record<string, unknown> | undefined>([[ADA, { companyId: ACME, companyRole: "owner", companyName: "Acme Ltd" }], [GRACE, { companyId: ACME, companyRole: "member", companyName: "Acme Ltd" }]]);
  const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const call: Call = { method: init?.method ?? "GET", path: url.pathname, ...(init?.headers ? { authorization: (init.headers as Record<string, string>).authorization } : {}), ...(typeof init?.body === "string" ? { body: init.body } : init?.body instanceof URLSearchParams ? { body: init.body.toString() } : {}) };
    calls.push(call);
    if (url.pathname === "/v1/auth/revoke") {
      if (call.authorization !== `Basic ${Buffer.from("rovara-cloud:secret").toString("base64")}`) return respond(401, { error: "invalid_client" });
      return revokeFails ? respond(503, {}) : respond(200, {});
    }
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
        ? { developerId: GRACE, displayName: graceName ?? "Grace", nameChosen: graceName !== undefined, administrator: false, projects: [{ name: "payments", access: "developer" }], notices: [], ...companies.get(GRACE) }
        : { developerId: ADA, displayName: adaName, administrator: true, projects: [{ name: "payments", access: "administrator" }], notices: [], ...companies.get(ADA) });
    }
    if (url.pathname === "/v1/dev/me/name" && call.method === "PUT") {
      const raw = (JSON.parse(call.body ?? "{}") as { name?: unknown }).name;
      const name = (typeof raw === "string" ? raw : "").replace(/\s+/gu, " ").trim();
      if (name.includes("@")) return respond(400, { error: { code: "CONFIG_INVALID", message: "name: must not be an email address" } });
      if (grace) graceName = name; else adaName = name;
      return respond(200, { name, nameChosen: true, requestId: "r" });
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
    if (url.pathname === `/v1/dev/tasks/${TASK_ID}/events` && call.method === "GET") {
      // Code's task events (DeveloperTaskEventSchema), as Code answers them: not necessarily in time order.
      return respond(200, { events: [
        { at: "2026-11-14T10:02:00.000Z", kind: "tool", text: "Edited README.md" },
        { at: "2026-11-14T10:01:00.000Z", kind: "status", text: "Worker status: RUNNING" },
        { at: "2026-11-14T10:03:00.000Z", kind: "error", text: "the check \u0007failed" },
        { at: "2026-11-14T10:03:00.000Z", kind: "message", text: "   " },
      ], requestId: "r" });
    }
    if ((url.pathname === `/v1/dev/tasks/${TASK_ID}/workflow/send-back` || url.pathname === `/v1/dev/tasks/${TASK_ID}/workflow/review-findings`) && call.method === "POST") {
      task = { ...task, workflow: { ...(task.workflow as object), stage: url.pathname.endsWith("send-back") ? "IMPLEMENT" : "PULL_REQUEST", state: url.pathname.endsWith("send-back") ? "RUNNING" : "READY", revision: 17 } };
      return respond(200, { task, requestId: "r" });
    }
    if (url.pathname === `/v1/dev/tasks/${TASK_ID}/workflow/review` && call.method === "POST") {
      task = { ...task, workflow: { ...(task.workflow as object), state: "RUNNING", revision: 17 } };
      return respond(200, { task, requestId: "r" });
    }
    if (url.pathname === `/v1/dev/tasks/${TASK_ID}/workflow/decision`) {
      if (decisionRefusal !== undefined) return respond(409, { error: { code: "IDEMPOTENCY_CONFLICT", message: decisionRefusal } });
      task = { ...task, workflow: { ...(task.workflow as object), stage: "IMPLEMENTATION", state: "RUNNING" } };
      return respond(200, { task });
    }
    if (url.pathname === `/v1/app/tasks/${TASK_ID}/merge` && mergeAnswers.has(call.method)) { const a = mergeAnswers.get(call.method)!; return respond(a.status, a.body); }
    if (url.pathname === `/v1/dev/tasks/${TASK_ID}/people` && call.method === "GET") return respond(200, { view: { revision: peopleRevision } });
    if (url.pathname === `/v1/dev/tasks/${TASK_ID}/people/take-ownership`) {
      const body = JSON.parse(call.body ?? "{}") as { expectedPeopleRevision?: number };
      if (body.expectedPeopleRevision !== peopleRevision) return respond(409, { error: { code: "CONFLICT", message: "people changed" } });
      peopleRevision += 1;
      // Code's answer (TaskPeopleChangeResultSchema, its COMMITTED branch): the change is made now.
      return respond(200, { change: { status: "COMMITTED", view: { revision: peopleRevision } } });
    }
    if (url.pathname === "/v1/dev/client/repositories") return respond(200, { installations: [{ installationId: 7, accountLogin: "acme", accountType: "Organization", repositorySelection: "selected", status: "active", repositories: [{ fullName: "acme/payments-api", githubRepositoryId: 1, private: true, defaultBranch: "main" }, { fullName: "acme/web-app", githubRepositoryId: 2, private: true, defaultBranch: "main" }] }] });
    return respond(404, { error: { code: "NOT_FOUND", message: "route not found" } });
  }) as typeof fetch;
  return {
    fetchImpl, calls, taskId: TASK_ID,
    setTask: (change: Record<string, unknown>) => { task = { ...task, ...change }; },
    /** Ada's name in Code from now on (her next sign-in reads it). */
    setAdaName: (name: string) => { adaName = name; },
    /** What Code's access check says of this person's company from now on (undefined: none). */
    setCompany: (developerId: string, company: Record<string, unknown> | undefined) => { companies.set(developerId, company); },
    refuseDecisions: (message: string) => { decisionRefusal = message; },
    answerMerge: (method: "GET" | "POST", status: number, body: unknown) => { mergeAnswers.set(method, { status, body }); },
    failRevoke: () => { revokeFails = true; },
    expireToken: () => { validToken = "access-rotated"; }, endSignIn: () => { refreshable = false; validToken = "nobody"; } };
}

/** One Cloud server; with `shared`, a second server on the same stores and the same Code (PrepLabsAI/Rovara-cloud#11). */
function setUp(shared?: { code: ReturnType<typeof fakeCode>; store: SessionStore; work: WorkSessionStore }) {
  const code = shared?.code ?? fakeCode();
  const store = shared?.store ?? new LocalSessionStore(undefined, { environment: {} });
  const logged: Array<Record<string, unknown>> = [];
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "projects:members", fetch: code.fetchImpl });
  const work = shared?.work ?? new LocalWorkSessionStore();
  const clock = { ms: Date.parse("2026-11-14T12:00:00.000Z") };
  const handler = createCloudHandler({ client, store, work, origin: "https://cloud.example.test", org: { orgId: "acme", name: "Acme", plan: "test" }, callbackPath: "/callback", secureCookies: true, log: (event) => { logged.push(event); }, now: () => new Date(clock.ms) });
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
  return { code, store, work, call, signIn, clock, logged };
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
    // The company's own id and name from Code's access check, never the deployment's ("acme", "Acme").
    expect(JSON.parse((await call("GET", "/v1/web/me", { cookie }))!.body)).toMatchObject({ developer: { id: ADA, name: "Ada", orgRole: "owner" }, org: { orgId: ACME, name: "Acme Ltd", plan: "test" } });
    expect(JSON.parse((await call("GET", "/v1/web/nav", { cookie }))!.body)).toMatchObject({ me: { orgRole: "owner" }, org: { name: "Acme Ltd" }, projects: [{ name: "payments" }], features: { admin: true } });
    expect(JSON.parse((await call("GET", "/v1/web/projects", { cookie }))!.body)).toEqual({ projects: [{ name: "payments", status: "active", latestRevision: 3, myRole: "maintainer", setup: { status: "unchecked" }, repositories: [{ name: "api", fullName: "acme/payments-api", defaultBranch: "main" }] }] });
    expect(JSON.parse((await call("GET", "/v1/web/projects/payments/overview", { cookie }))!.body)).toMatchObject({ project: { name: "payments", latestRevision: 3, repositories: [{ fullName: "acme/payments-api" }] }, you: { role: "maintainer", canEditSettings: true } });
    expect((await call("GET", "/v1/web/projects/ledger", { cookie }))!.status).toBe(404);
  });

  it("names the company and role from Code's access check now: a company admin is owner or admin, never Code's install administrator", async () => {
    const { call, signIn, code } = setUp();
    const { cookie } = await signIn();
    const me = async () => JSON.parse((await call("GET", "/v1/web/me", { cookie }))!.body) as { developer: { orgRole: string }; org: { orgId: string; name: string } };
    const nav = async () => JSON.parse((await call("GET", "/v1/web/nav", { cookie }))!.body) as { me: { orgRole: string }; org: { name: string }; features: { admin: boolean } };
    // Ada stays Code's install administrator throughout; only her company role moves.
    code.setCompany(ADA, { companyId: ACME, companyRole: "admin" });
    expect(await me()).toMatchObject({ developer: { orgRole: "admin" }, org: { orgId: ACME, name: "Your company" } });
    expect(await nav()).toMatchObject({ me: { orgRole: "admin" }, org: { name: "Your company" }, features: { admin: true } });
    code.setCompany(ADA, { companyId: ACME, companyRole: "member", companyName: "Acme Ltd" });
    expect(await me()).toMatchObject({ developer: { orgRole: "member" } });
    expect((await nav()).features.admin).toBe(false);
    // A name that doesn't read (control characters, too long) is never shown.
    code.setCompany(ADA, { companyId: ACME, companyRole: "owner", companyName: "Ac\u0000me" });
    expect((await nav()).org.name).toBe("Your company");
    code.setCompany(ADA, { companyId: ACME, companyRole: "owner", companyName: "x".repeat(201) });
    expect((await me()).org.name).toBe("Your company");
  });

  it("refuses me and nav with fixed words when Code names no company, or a company or role that doesn't read; the browser can't name one", async () => {
    const { call, signIn, code } = setUp();
    const { cookie } = await signIn();
    const refused = { error: { code: "NO_COMPANY", message: "You're not in a company yet." } };
    for (const company of [undefined, { companyId: ACME }, { companyId: ACME, companyRole: "auditor" }, { companyId: ACME, companyRole: "Owner" }, { companyId: "acme", companyRole: "owner" }, { companyId: 5, companyRole: "owner" }, { companyRole: "owner" }]) {
      code.setCompany(ADA, company);
      for (const path of ["/v1/web/me", "/v1/web/nav", "/v1/web/company/audit"]) {
        const answer = await call("GET", path, { cookie, headers: { "x-rovara-company": ACME, cookie: `${cookie}; company=${ACME}` } });
        // /me keeps the sign-in's CSRF value in its refusal (the onboarding pages send one change); nothing else.
        const csrf = (JSON.parse((await call("GET", "/v1/web/me", { cookie }))!.body) as { csrf?: string }).csrf;
        expect({ path, company, status: answer!.status, body: JSON.parse(answer!.body) as unknown }).toEqual({ path, company, status: 403, body: path === "/v1/web/me" ? { ...refused, csrf } : refused });
        expect(csrf).toMatch(/^[\w-]{43}$/u);
      }
      expect((await call("GET", `/v1/web/nav?companyId=${ACME}`, { cookie }))!.status).toBe(403);
    }
  });

  it("keeps one company's sessions from another: a session started in Acme reads as missing to its reader once Code puts her in another company", async () => {
    const { call, signIn, code, work } = setUp();
    const ada = await signIn();
    const started = JSON.parse((await call("POST", "/v1/web/projects/payments/code", { cookie: ada.cookie, csrf: ada.csrf, body: { requestId: "22222222-2222-4222-8222-222222222222", input: { text: "Fix the typo" } } }))!.body) as { sessionId: string };
    expect((await work.get(started.sessionId))?.companyId).toBe(ACME);
    await call("PUT", `/v1/web/sessions/${started.sessionId}/shares`, { cookie: ada.cookie, csrf: ada.csrf, body: { requestId: "33333333-3333-4333-8333-333333333333", principal: { kind: "member", developerId: GRACE }, level: "view" } });
    const grace = await signIn("grace-code");
    code.setTask({ ...PLAN_WAITING, spent: { usd: 999.13 }, runEstimate: { lowUsd: 4.37, highUsd: 10.19, runLimitUsd: 12.71, stopAtUsd: 12.71 } });
    // Positive control: in Acme, Grace reads the shared session.
    expect((await call("GET", `/v1/web/sessions/${started.sessionId}`, { cookie: grace.cookie }))!.status).toBe(200);
    code.setCompany(GRACE, { companyId: OTHER, companyRole: "owner" });
    const other = await signIn("grace-code");
    const reads = ["", "/messages", "/events", "/shares"];
    for (const tail of reads) {
      const answer = await call("GET", `/v1/web/sessions/${started.sessionId}${tail}`, { cookie: other.cookie });
      expect({ tail, status: answer!.status }).toEqual({ tail, status: 404 });
      expect(answer!.body).not.toMatch(/999\.13|4\.37|10\.19|12\.71/);
    }
    for (const [tail, body] of [["/follow", undefined], ["/messages", { requestId: "44444444-4444-4444-8444-444444444444", kind: "comment", text: "hi" }], ["/presence", {}]] as const) {
      const answer = await call("POST", `/v1/web/sessions/${started.sessionId}${tail}`, { cookie: other.cookie, csrf: other.csrf, ...(body === undefined ? {} : { body }) });
      expect({ tail, status: answer!.status }).toEqual({ tail, status: 404 });
      expect(answer!.body).not.toMatch(/999\.13|4\.37|10\.19|12\.71/);
    }
    expect(JSON.parse((await call("GET", "/v1/web/home", { cookie: other.cookie }))!.body)).toMatchObject({ total: 0 });
    // A retried start from the other company never answers Acme's session.
    const retried = await call("POST", "/v1/web/projects/payments/code", { cookie: other.cookie, csrf: other.csrf, body: { requestId: "22222222-2222-4222-8222-222222222222", input: { text: "Fix the typo" } } });
    expect(JSON.parse(retried!.body)).not.toMatchObject({ sessionId: started.sessionId });
    // Nothing in Acme's session changed.
    expect((await work.get(started.sessionId))?.followers ?? []).toEqual([]);
    expect((await work.get(started.sessionId))?.messages ?? []).toEqual([]);
  });

  it("starts no work for a person Code names no company for, and writes no session", async () => {
    const { call, signIn, code, work } = setUp();
    const ada = await signIn();
    code.setCompany(ADA, undefined);
    const answer = await call("POST", "/v1/web/projects/payments/code", { cookie: ada.cookie, csrf: ada.csrf, body: { requestId: "55555555-5555-4555-8555-555555555555", input: { text: "Fix the typo" } } });
    expect({ status: answer!.status, body: JSON.parse(answer!.body) as unknown }).toEqual({ status: 403, body: { error: { code: "NO_COMPANY", message: "You're not in a company yet." } } });
    expect(code.calls.filter((entry) => entry.path === "/v1/dev/tasks" && entry.method === "POST")).toEqual([]);
    expect(await work.startedBy(ADA)).toEqual([]);
  });

  it("keeps the company Code names now with the stored sign-in: moved to another company, the person's next session read is that company's", async () => {
    const { call, signIn, code } = setUp();
    const ada = await signIn();
    const started = JSON.parse((await call("POST", "/v1/web/projects/payments/code", { cookie: ada.cookie, csrf: ada.csrf, body: { requestId: "66666666-6666-4666-8666-666666666666", input: { text: "Fix the typo" } } }))!.body) as { sessionId: string };
    expect((await call("GET", `/v1/web/sessions/${started.sessionId}`, { cookie: ada.cookie }))!.status).toBe(200);
    code.setCompany(ADA, { companyId: OTHER, companyRole: "owner" });
    // Any route that asks Code (here the navigation) moves the stored sign-in to the new company; session reads follow it, same cookie.
    expect((await call("GET", "/v1/web/nav", { cookie: ada.cookie }))!.status).toBe(200);
    expect((await call("GET", `/v1/web/sessions/${started.sessionId}`, { cookie: ada.cookie }))!.status).toBe(404);
  });

  it("keeps the plan approval page to the session's company", async () => {
    const { call, signIn, code } = setUp();
    const ada = await signIn();
    const started = JSON.parse((await call("POST", "/v1/web/projects/payments/code", { cookie: ada.cookie, csrf: ada.csrf, body: { requestId: "77777777-7777-4777-8777-777777777777", input: { text: "Fix the typo" } } }))!.body) as { sessionId: string };
    code.setTask(PLAN_WAITING);
    expect((await call("GET", `/v1/app/approve/plan-${started.sessionId}`, { cookie: ada.cookie }))!.status).toBe(200);
    code.setCompany(ADA, { companyId: OTHER, companyRole: "owner" });
    const other = await signIn();
    expect((await call("GET", `/v1/app/approve/plan-${started.sessionId}`, { cookie: other.cookie }))!.status).toBe(404);
    const decided = await call("POST", `/v1/app/approve/plan-${started.sessionId}`, { cookie: other.cookie, form: { csrf: other.csrf, decision: "approve", revision: "4", digest: "d".repeat(64) }, headers: { origin: "https://cloud.example.test" } });
    expect(decided!.status).toBe(404);
    expect(code.calls.filter((entry) => entry.path.endsWith("/approve") || entry.path.includes("/plan/decision"))).toEqual([]);
  });

  it("still shows a session written before sessions carried a company (Code checks its task, as before)", async () => {
    const { call, signIn, work } = setUp();
    const ada = await signIn();
    await work.put({ sessionId: "ses_legacy00000000000000", taskId: "6f9d0c1e-2b3a-4c5d-8e7f-001122334455", project: "payments", startedBy: { developerId: ADA, name: "Ada" }, owner: { developerId: ADA, name: "Ada" }, createdAt: "2026-11-01T00:00:00.000Z", revision: 1 });
    expect((await call("GET", "/v1/web/sessions/ses_legacy00000000000000", { cookie: ada.cookie }))!.status).toBe(200);
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

  it("ends the sign-in at Code on sign-out: Code's revoke with the refresh token and Cloud's client", async () => {
    const { call, signIn, code, logged } = setUp();
    const { cookie, csrf } = await signIn();
    await call("POST", "/v1/auth/browser/sign-out", { cookie, csrf });
    const revoke = code.calls.filter((entry) => entry.path === "/v1/auth/revoke");
    expect(revoke).toHaveLength(1);
    expect(Object.fromEntries(new URLSearchParams(revoke[0]!.body))).toEqual({ token: "refresh-1", token_type_hint: "refresh_token" });
    expect(revoke[0]!.authorization).toBe(`Basic ${Buffer.from("rovara-cloud:secret").toString("base64")}`);
    expect(logged.at(-1)).toEqual({ event: "cloud.signed_out", developerId: ADA });
  });

  it("signs out on Cloud even when Code's revoke fails, and says so in the log", async () => {
    const { call, signIn, code, store, logged } = setUp();
    const { cookie, csrf } = await signIn();
    code.failRevoke();
    const out = await call("POST", "/v1/auth/browser/sign-out", { cookie, csrf });
    expect(out!.status).toBe(204);
    expect(await store.get(cookie.split("=")[1]!)).toBeUndefined();
    expect(logged.at(-1)).toEqual({ event: "cloud.revoke_failed", developerId: ADA });
  });

  it("logs no cookie, token, CSRF token or client secret through sign-in, refresh, a route and sign-out", async () => {
    const { call, signIn, code, logged } = setUp();
    const { cookie, csrf } = await signIn();
    code.expireToken();
    await call("GET", "/v1/web/nav", { cookie });
    await call("GET", "/v1/web/org/budget-settings", { cookie });
    await call("POST", "/v1/auth/browser/sign-out", { cookie, csrf });
    const text = JSON.stringify(logged);
    expect(logged.length).toBeGreaterThan(1);
    for (const secret of [cookie.split("=")[1]!, csrf, "access-1", "access-2", "refresh-1", "refresh-2", "secret", Buffer.from("rovara-cloud:secret").toString("base64")]) expect(text).not.toContain(secret);
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

/** REVIEW/BLOCKED by findings, as production's ReactJS task showed it (Rovara-cloud#25): two blocking code-review findings, one advisory note, the security review passed. */
const FINDINGS = [
  { advisory: false, origin: "INTRODUCED", severity: "LOW", file: "src/pages/Blog.jsx", text: "Blog.jsx injects blog.css via useEffect after first render." },
  { advisory: false, origin: "INTRODUCED", severity: "LOW", file: "index.html", line: 3, text: "The meta description tag was dropped." },
  { advisory: true, origin: "INTRODUCED", severity: "LOW", text: "Consider a README note." },
];
const REVIEW_FINDINGS = () => {
  const blocked = REVIEW_BLOCKED();
  return { workflow: { ...blocked.workflow, blockReason: "the code review did not pass", reviews: [
    { ...blocked.workflow.reviews[0]!, status: "FINDINGS", findings: FINDINGS },
    { ...blocked.workflow.reviews[1]!, status: "PASS", findings: [] },
  ] } };
};
const fingerprint = (text: string, file = "", line = 0) => createHash("sha256").update(JSON.stringify(["CRITIC", text, file, line])).digest("hex");

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
      needsYou: true, following: true, approvalUrl: confirmUrl, actions: ["watch", "comment", "stop", "close"],
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

  it("sends a task stopped by review findings back to coding with the owner's note, or the default note (Rovara-cloud#25)", async () => {
    const { call, auth, code, sessionId } = await begin();
    code.setTask({ status: "SUCCEEDED", ...REVIEW_FINDINGS() });
    const sent = await call("POST", `/v1/web/sessions/${sessionId}/send-back`, { ...auth, body: { requestId: "88888888-8888-4888-8888-888888888888", note: "  Import blog.css directly and restore the meta description.  " } });
    expect(sent!.status).toBe(200);
    expect(SessionResponseReaderSchema.parse(JSON.parse(sent!.body)).session.status).toBe("running");
    expect(JSON.parse(code.calls.find((entry) => entry.path === `/v1/dev/tasks/${code.taskId}/workflow/send-back`)!.body!)).toEqual({ requestId: "88888888-8888-4888-8888-888888888888", expectedRevision: 16, instructions: "Import blog.css directly and restore the meta description." });
    code.setTask({ status: "SUCCEEDED", ...REVIEW_FINDINGS() });
    await call("POST", `/v1/web/sessions/${sessionId}/send-back`, { ...auth, body: { requestId: "99999999-9999-4999-8999-999999999999" } });
    expect(JSON.parse(code.calls.filter((entry) => entry.path.endsWith("/workflow/send-back")).at(-1)!.body!)).toMatchObject({ instructions: "Fix the review findings." });
  });

  it("accepts every blocking finding with the owner's reason, by IDs it computes from Code's task, never from the request (Rovara-cloud#25)", async () => {
    const { call, auth, code, sessionId } = await begin();
    code.setTask({ status: "SUCCEEDED", ...REVIEW_FINDINGS() });
    expect((await call("POST", `/v1/web/sessions/${sessionId}/accept-findings`, { ...auth, body: { requestId: "88888888-8888-4888-8888-888888888888" } }))!.status).toBe(400);
    const accepted = await call("POST", `/v1/web/sessions/${sessionId}/accept-findings`, { ...auth, body: { requestId: "88888888-8888-4888-8888-888888888888", reason: "Cosmetic; fixed in a follow-up.", resolutions: [{ findingId: "e".repeat(64), action: "ACCEPT", note: "x" }] } });
    expect(accepted!.status).toBe(200);
    expect(JSON.parse(code.calls.find((entry) => entry.path === `/v1/dev/tasks/${code.taskId}/workflow/review-findings`)!.body!)).toEqual({
      requestId: "88888888-8888-4888-8888-888888888888", expectedRevision: 16, candidateDigest: CANDIDATE,
      resolutions: [
        { findingId: fingerprint(FINDINGS[0]!.text, "src/pages/Blog.jsx"), action: "ACCEPT", note: "Cosmetic; fixed in a follow-up." },
        { findingId: fingerprint(FINDINGS[1]!.text, "index.html", 3), action: "ACCEPT", note: "Cosmetic; fixed in a follow-up." },
      ],
    });
  });

  it("refuses send-back and accept when nothing is blocked by findings: a review that couldn't finish, or a plan waiting", async () => {
    const { call, auth, code, sessionId } = await begin();
    code.setTask({ status: "SUCCEEDED", ...REVIEW_BLOCKED() });
    expect((await call("POST", `/v1/web/sessions/${sessionId}/send-back`, { ...auth, body: { requestId: "88888888-8888-4888-8888-888888888888" } }))!.status).toBe(409);
    code.setTask(PLAN_WAITING);
    expect((await call("POST", `/v1/web/sessions/${sessionId}/accept-findings`, { ...auth, body: { requestId: "88888888-8888-4888-8888-888888888888", reason: "ok" } }))!.status).toBe(409);
    expect(code.calls.some((entry) => entry.path.endsWith("/workflow/send-back") || entry.path.endsWith("/workflow/review-findings"))).toBe(false);
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

  it("shows what the task has cost from Code's spent figure, with its run limit, on the session and its tile; absent spend stays absent (Rovara-cloud#31)", async () => {
    const { call, auth, code, sessionId } = await begin();
    const session = async () => SessionResponseReaderSchema.parse(JSON.parse((await call("GET", `/v1/web/sessions/${sessionId}`, { cookie: auth.cookie }))!.body)).session;
    expect((await session()).cost).toEqual({ payer: { kind: "member", name: "Ada" } });
    code.setTask({ ...PLAN_WAITING, spent: { usd: 28.4812, inputTokens: 26_257_037, outputTokens: 257_592, runs: 17, unpricedRuns: 0, updatedAt: "2026-11-15T01:43:15.327Z" }, runLimit: { limitUsd: 40, canAskAgain: true } });
    expect((await session()).cost).toEqual({ spentUsd: 28.48, runLimitUsd: 40, payer: { kind: "member", name: "Ada" } });
    const [tile] = ProjectOverviewSchema.parse(JSON.parse((await call("GET", "/v1/web/projects/payments/overview", { cookie: auth.cookie }))!.body)).running;
    expect(tile?.costUsd).toBe(28.48);
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
    // One script only: the fixed form script, carrying the nonce the page's policy names (nothing from the task is in it).
    const nonce = /script-src 'nonce-([A-Za-z0-9+/=]{24})'/u.exec(page!.headers["content-security-policy"]!)?.[1];
    expect(nonce).toBeDefined();
    expect([...page!.body.matchAll(/<script\b/gu)]).toHaveLength(1);
    expect(page!.body).toContain(`<script nonce="${nonce}">${APPROVAL_FORM_SCRIPT}</script></body>`);
    expect(page!.headers["content-security-policy"]).toContain("connect-src 'self'");
    expect(page!.headers["content-security-policy"]).toContain("form-action 'self'");
    const again = await call("GET", `/v1/app/approve/plan-${sessionId}`, { cookie: auth.cookie });
    expect(again!.headers["content-security-policy"]).not.toContain(`'nonce-${nonce}'`);
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
    expect(await read(grace)).toMatchObject({ sessionId, you: { level: "view", owner: false, following: false, actions: ["watch", "comment"] }, approvals: [] });
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

describe("the Conversation: timeline and comments (Rovara-cloud#24)", () => {
  const begin = async () => {
    const context = setUp();
    const ada = await context.signIn();
    const grace = await context.signIn("grace-code");
    const started = await context.call("POST", "/v1/web/projects/payments/code", { ...ada, body: { requestId: "22222222-2222-4222-8222-222222222222", input: { text: "Fix the README typo" } } });
    const { sessionId } = JSON.parse(started!.body) as { sessionId: string };
    const share = () => context.call("PUT", `/v1/web/sessions/${sessionId}/shares`, { ...ada, body: { requestId: "66666666-6666-4666-8666-666666666666", principal: { kind: "member", developerId: GRACE }, level: "view" } });
    const post = (who: { cookie: string; csrf: string }, body: Record<string, unknown>) => context.call("POST", `/v1/web/sessions/${sessionId}/messages`, { ...who, body });
    const list = async (who: { cookie: string }, after?: string) => SessionMessagePageSchema.parse(JSON.parse((await context.call("GET", `/v1/web/sessions/${sessionId}/messages${after === undefined ? "" : `?after=${encodeURIComponent(after)}`}`, { cookie: who.cookie }))!.body));
    return { ...context, ada, grace, sessionId, share, post, list };
  };

  it("answers the timeline from Code's task events: oldest first, agent steps and system lines, cleaned, with stable ids and a cursor", async () => {
    const { call, ada, sessionId } = await begin();
    const page = SessionEventPageSchema.parse(JSON.parse((await call("GET", `/v1/web/sessions/${sessionId}/events`, { cookie: ada.cookie }))!.body));
    expect(page.events.map((event) => [event.type, event.actor?.kind, event.text])).toEqual([
      ["status", "system", "Worker status: RUNNING"], ["step", "agent", "Edited README.md"], ["status", "system", "the check failed"],
    ]);
    const again = SessionEventPageSchema.parse(JSON.parse((await call("GET", `/v1/web/sessions/${sessionId}/events`, { cookie: ada.cookie }))!.body));
    expect(again.events.map((event) => event.eventId)).toEqual(page.events.map((event) => event.eventId));
    const after = SessionEventPageSchema.parse(JSON.parse((await call("GET", `/v1/web/sessions/${sessionId}/events?after=${encodeURIComponent(page.events[0]!.at + "#" + page.events[0]!.eventId)}`, { cookie: ada.cookie }))!.body));
    expect(after.events).toHaveLength(2);
    expect(page.next).toBe(`${page.events[2]!.at}#${page.events[2]!.eventId}`);
  });

  it("lets anyone who can read the session comment, reply in a thread and read the comments; a retried send is the same comment", async () => {
    const { ada, grace, share, post, list } = await begin();
    const first = await post(ada, { requestId: "11111111-1111-4111-8111-111111111111", kind: "comment", text: "Looks good so far." });
    expect(first!.status).toBe(201);
    const comment = SessionMessageSchema.parse(JSON.parse(first!.body));
    expect(comment).toMatchObject({ kind: "comment", source: "app", author: { developerId: ADA, name: "Ada" }, text: "Looks good so far.", rev: 1 });
    expect(JSON.parse((await post(ada, { requestId: "11111111-1111-4111-8111-111111111111", kind: "comment", text: "Looks good so far." }))!.body)).toMatchObject({ messageId: comment.messageId });
    expect((await post(grace, { requestId: "22222222-2222-4222-8222-222222222222", kind: "comment", text: "hi" }))!.status).toBe(404);
    await share();
    const reply = SessionMessageSchema.parse(JSON.parse((await post(grace, { requestId: "33333333-3333-4333-8333-333333333333", kind: "comment", text: "Agreed.", threadId: comment.messageId }))!.body));
    const nested = SessionMessageSchema.parse(JSON.parse((await post(ada, { requestId: "44444444-4444-4444-8444-444444444444", kind: "comment", text: "Thanks.", threadId: reply.messageId }))!.body));
    expect([reply.threadId, nested.threadId]).toEqual([comment.messageId, comment.messageId]);
    const page = await list(grace);
    expect(page.messages.map((message) => [message.author.name, message.text])).toEqual([["Ada", "Looks good so far."], ["Grace", "Agreed."], ["Ada", "Thanks."]]);
    expect(page.next).toBe(`${nested.createdAt}#${nested.messageId}`);
  });

  it("refuses a message to the agent, a pinned comment and an empty or oversized comment", async () => {
    const { ada, post } = await begin();
    const steer = await post(ada, { requestId: "11111111-1111-4111-8111-111111111111", kind: "steer", text: "Use React 19." });
    expect(steer!.status).toBe(409);
    expect(JSON.parse(steer!.body)).toMatchObject({ error: { message: expect.stringContaining("Send back to coding") as unknown } });
    expect((await post(ada, { requestId: "22222222-2222-4222-8222-222222222222", kind: "comment", text: "x", anchor: { target: "step", targetId: "s1", revision: "done" } }))!.status).toBe(400);
    expect((await post(ada, { requestId: "33333333-3333-4333-8333-333333333333", kind: "comment", text: "   " }))!.status).toBe(400);
    expect((await post(ada, { requestId: "44444444-4444-4444-8444-444444444444", kind: "comment", text: "x".repeat(2001) }))!.status).toBe(400);
  });

  it("lets only the author edit or delete a comment, on the revision they saw; a deleted one keeps no text", async () => {
    const { call, ada, grace, sessionId, share, post, list } = await begin();
    await share();
    const comment = SessionMessageSchema.parse(JSON.parse((await post(ada, { requestId: "11111111-1111-4111-8111-111111111111", kind: "comment", text: "Frist draft." }))!.body));
    const path = `/v1/web/sessions/${sessionId}/messages/${comment.messageId}`;
    expect((await call("PATCH", path, { ...grace, body: { rev: 1, text: "Hijacked." } }))!.status).toBe(403);
    expect((await call("PATCH", path, { ...ada, body: { rev: 2, text: "First draft." } }))!.status).toBe(409);
    const edited = SessionMessageSchema.parse(JSON.parse((await call("PATCH", path, { ...ada, body: { rev: 1, text: "First draft." } }))!.body));
    expect(edited).toMatchObject({ text: "First draft.", rev: 2 });
    expect(edited.editedAt).toBeDefined();
    const deleted = SessionMessageSchema.parse(JSON.parse((await call("DELETE", path, { ...ada, body: { rev: 2 } }))!.body));
    expect(deleted).toMatchObject({ text: "Comment deleted", rev: 3 });
    expect((await list(ada)).messages[0]).toMatchObject({ text: "Comment deleted", deletedAt: deleted.deletedAt });
    expect((await call("PATCH", path, { ...ada, body: { rev: 3, text: "Back." } }))!.status).toBe(404);
  });

  it("offers comment to anyone who can read the session, so the app shows the send box", async () => {
    const { call, ada, grace, sessionId, share } = await begin();
    await share();
    for (const who of [ada, grace]) {
      const session = SessionResponseReaderSchema.parse(JSON.parse((await call("GET", `/v1/web/sessions/${sessionId}`, { cookie: who.cookie }))!.body)).session;
      expect(session.you.actions).toContain("comment");
    }
  });
});


describe("several servers on the same stores (Rovara-cloud#11)", () => {
  it("keeps a person signed in when another server refreshed their tokens first (Code's refresh tokens work once)", async () => {
    const a = setUp();
    const { cookie } = await a.signIn();
    const id = cookie.split("=")[1]!;
    const before = structuredClone((await a.store.get(id))!);
    a.code.expireToken();
    expect((await a.call("GET", "/v1/web/nav", { cookie }))!.status).toBe(200);
    const refreshed = (await a.store.get(id))!.refreshToken;
    expect(refreshed).not.toBe(before.refreshToken);
    // Server B read the sign-in before A saved its refresh: its own refresh is refused, so it reads the store again and goes on.
    let stale = true;
    const shared = Object.create(a.store) as SessionStore;
    shared.get = async (key) => (stale && key === id ? (stale = false, structuredClone(before)) : a.store.get(key));
    const b = setUp({ code: a.code, store: shared, work: a.work });
    expect((await b.call("GET", "/v1/web/nav", { cookie }))!.status).toBe(200);
    expect((await a.store.get(id))?.refreshToken).toBe(refreshed);
  });

  it("still signs the person out when the sign-in really ended", async () => {
    const a = setUp();
    const { cookie } = await a.signIn();
    const b = setUp({ code: a.code, store: a.store, work: a.work });
    a.code.endSignIn();
    expect((await b.call("GET", "/v1/web/nav", { cookie }))!.status).toBe(401);
    expect(await a.store.get(cookie.split("=")[1]!)).toBeUndefined();
  });

  it("runs a request again when another server wrote the session in between, so neither change is lost", async () => {
    const a = setUp();
    const ada = await a.signIn();
    const started = await a.call("POST", "/v1/web/projects/payments/code", { ...ada, body: { requestId: "22222222-2222-4222-8222-222222222222", input: { text: "Fix the README typo" } } });
    const { sessionId } = JSON.parse(started!.body) as { sessionId: string };
    const comment = (server: typeof a, requestId: string, text: string) =>
      server.call("POST", `/v1/web/sessions/${sessionId}/messages`, { ...ada, body: { requestId, kind: "comment", text } });
    // Server B's first write finds that server A added a comment after B read the session.
    let first = true;
    const racing: WorkSessionStore = {
      get: (key) => a.work.get(key), byRequest: (key) => a.work.byRequest(key), byTask: (key) => a.work.byTask(key), startedBy: (key) => a.work.startedBy(key),
      put: async (session, requestId) => {
        if (first) { first = false; expect((await comment(a, "33333333-3333-4333-8333-333333333333", "From server A"))!.status).toBe(201); }
        return a.work.put(session, requestId);
      },
    };
    const b = setUp({ code: a.code, store: a.store, work: racing });
    expect((await comment(b, "44444444-4444-4444-8444-444444444444", "From server B"))!.status).toBe(201);
    expect((await a.work.get(sessionId))?.messages?.map((message) => message.text)).toEqual(["From server A", "From server B"]);
  });

  it("gives up after a few tries rather than looping", async () => {
    const a = setUp();
    const ada = await a.signIn();
    const started = await a.call("POST", "/v1/web/projects/payments/code", { ...ada, body: { requestId: "22222222-2222-4222-8222-222222222222", input: { text: "Fix the README typo" } } });
    const { sessionId } = JSON.parse(started!.body) as { sessionId: string };
    let writes = 0;
    const busy: WorkSessionStore = { get: (key) => a.work.get(key), byRequest: (key) => a.work.byRequest(key), byTask: (key) => a.work.byTask(key), startedBy: (key) => a.work.startedBy(key), put: async () => { writes += 1; throw new StoreConflict(sessionId); } };
    const b = setUp({ code: a.code, store: a.store, work: busy });
    await expect(b.call("POST", `/v1/web/sessions/${sessionId}/messages`, { ...ada, body: { requestId: "55555555-5555-4555-8555-555555555555", kind: "comment", text: "Hi" } })).rejects.toBeInstanceOf(StoreConflict);
    expect(writes).toBe(3);
  });
});

describe("people's names on sessions follow their current name (Rovara-cloud#39)", () => {
  const begin = async () => {
    const context = setUp();
    const ada = await context.signIn();
    const grace = await context.signIn("grace-code");
    const started = await context.call("POST", "/v1/web/projects/payments/code", { ...ada, body: { requestId: "22222222-2222-4222-8222-222222222222", input: { text: "Fix the README typo" } } });
    const { sessionId } = JSON.parse(started!.body) as { sessionId: string };
    await context.call("PUT", `/v1/web/sessions/${sessionId}/shares`, { ...ada, body: { requestId: "66666666-6666-4666-8666-666666666666", principal: { kind: "member", developerId: GRACE }, level: "view" } });
    const read = async (who: { cookie: string }) => SessionResponseReaderSchema.parse(JSON.parse((await context.call("GET", `/v1/web/sessions/${sessionId}`, { cookie: who.cookie }))!.body)).session;
    return { ...context, ada, grace, sessionId, read };
  };

  it("shows the owner's new name on sessions started under the old one: to the owner at once, and to others once the owner signs in again", async () => {
    const { signIn, code, grace, read, call, sessionId } = await begin();
    await call("POST", `/v1/web/sessions/${sessionId}/messages`, { ...(await signIn()), body: { requestId: "11111111-1111-4111-8111-111111111111", kind: "comment", text: "Started." } });
    code.setAdaName("Ada Lovelace");
    expect((await read(grace)).owner.name).toBe("Ada");
    const ada = await signIn();
    expect((await read(ada)).owner.name).toBe("Ada Lovelace");
    expect((await read(grace)).owner).toEqual({ developerId: ADA, name: "Ada Lovelace" });
    expect((await read(grace)).cost.payer.name).toBe("Ada Lovelace");
    const comments = SessionMessagePageSchema.parse(JSON.parse((await call("GET", `/v1/web/sessions/${sessionId}/messages`, { cookie: grace.cookie }))!.body));
    expect(comments.messages[0]?.author.name).toBe("Ada Lovelace");
  });

  it("renames the owner's sessions when they choose a new name in Cloud", async () => {
    const { call, ada, grace, read } = await begin();
    expect((await call("PUT", "/v1/web/me/name", { ...ada, body: { name: "Ada K" } }))!.status).toBe(200);
    expect((await read(grace)).owner.name).toBe("Ada K");
  });
});


describe("the Merge button through Code (DEC 254zzz94)", () => {
  const PULL = { repositoryId: "payments-api", number: 42, url: "https://github.com/acme/payments-api/pull/42" };
  const begin = async () => {
    const world = setUp();
    const auth = await world.signIn();
    const started = await world.call("POST", "/v1/web/projects/payments/code", { ...auth, body: { requestId: "22222222-2222-4222-8222-222222222222", input: { text: "Fix the README typo" } } });
    const { sessionId } = JSON.parse(started!.body) as { sessionId: string };
    return { ...world, auth, sessionId, mergeCalls: () => world.code.calls.filter((entry) => entry.path.endsWith("/merge")) };
  };
  const ID = "66666666-6666-4666-8666-666666666666";

  it("reads whether the person may merge from Code's task route, and presses with exactly the request id, as the person", async () => {
    const { call, auth, sessionId, code, mergeCalls } = await begin();
    code.answerMerge("GET", 200, { mayMerge: true, ready: true, pullRequests: [PULL] });
    code.answerMerge("POST", 200, { status: "MERGED", pullRequests: [{ repositoryId: "payments-api", number: 42 }] });
    const read = await call("GET", `/v1/web/sessions/${sessionId}/merge`, { cookie: auth.cookie });
    expect(read!.status).toBe(200);
    expect(JSON.parse(read!.body)).toEqual({ mayMerge: true, ready: true, pullRequests: [PULL] });
    const pressed = await call("POST", `/v1/web/sessions/${sessionId}/merge`, { ...auth, body: { requestId: ID } });
    expect(pressed!.status).toBe(200);
    expect(JSON.parse(pressed!.body)).toEqual({ status: "MERGED", pullRequests: [{ repositoryId: "payments-api", number: 42 }] });
    expect(mergeCalls().map((entry) => [entry.method, entry.path])).toEqual([["GET", `/v1/app/tasks/${code.taskId}/merge`], ["POST", `/v1/app/tasks/${code.taskId}/merge`]]);
    expect(JSON.parse(mergeCalls()[1]!.body!)).toEqual({ requestId: ID });
  });

  it("refuses a body with anything but a request id, a query, and an unknown session, without asking Code", async () => {
    const { call, auth, sessionId, mergeCalls } = await begin();
    for (const body of [{}, { requestId: "x" }, { requestId: ID, force: true }, [ID]]) expect((await call("POST", `/v1/web/sessions/${sessionId}/merge`, { ...auth, body }))!.status).toBe(400);
    expect((await call("POST", `/v1/web/sessions/${sessionId}/merge?as=admin`, { ...auth, body: { requestId: ID } }))!.status).toBe(400);
    expect((await call("POST", "/v1/web/sessions/ses_00000000000000000000/merge", { ...auth, body: { requestId: ID } }))!.status).toBe(404);
    expect((await call("GET", "/v1/web/sessions/ses_00000000000000000000/merge", { cookie: auth.cookie }))!.status).toBe(404);
    expect(mergeCalls()).toEqual([]);
  });

  it("passes Code's fixed refusals on under their own code, and says 'not available yet' for a Code without the route", async () => {
    const { call, auth, sessionId, code } = await begin();
    const notYet = await call("POST", `/v1/web/sessions/${sessionId}/merge`, { ...auth, body: { requestId: ID } });
    expect(notYet!.status).toBe(501);
    expect((JSON.parse(notYet!.body) as { error: { message: string } }).error.message).toContain("isn't available on this Rovara yet");
    for (const [status, codeName, message] of [[409, "MERGE_NOT_READY", "Checks haven't passed on the latest code."], [403, "FORBIDDEN", "Do this on the Rovara website: the command line and AI tools cannot make this change."], [404, "TASK_NOT_FOUND", "no such task"], [409, "IDEMPOTENCY_CONFLICT", "That request was already used by someone else."]] as const) {
      code.answerMerge("POST", status, { error: { code: codeName, message } });
      const answer = await call("POST", `/v1/web/sessions/${sessionId}/merge`, { ...auth, body: { requestId: ID } });
      expect([answer!.status, (JSON.parse(answer!.body) as { error: unknown }).error]).toEqual([status, { code: codeName, message }]);
    }
    // Anything else (an unexpected code, a status that does not match, a long or multi-line sentence) is Cloud's own words: nothing of Code's is echoed.
    for (const body of [{ error: { code: "INTERNAL", message: "stack at ghs_secret" } }, { error: { code: "MERGE_NOT_READY", message: "line one\nghs_secret" } }, "oops"]) {
      code.answerMerge("POST", body === "oops" ? 500 : 409, body);
      const answer = await call("POST", `/v1/web/sessions/${sessionId}/merge`, { ...auth, body: { requestId: ID } });
      expect(answer!.status).toBe(503);
      expect(answer!.body).not.toContain("ghs_");
    }
  });

  it("carries what the person was shown (heads, risk) both ways, each checked; a bad one is refused without asking Code", async () => {
    const { call, auth, sessionId, code, mergeCalls } = await begin();
    const HEAD = { repositoryId: "payments-api", number: 42, headSha: "a".repeat(40) };
    code.answerMerge("GET", 200, { mayMerge: true, ready: true, risk: "medium", heads: [HEAD], pullRequests: [PULL] });
    code.answerMerge("POST", 200, { status: "MERGED", pullRequests: [{ repositoryId: "payments-api", number: 42 }] });
    expect(JSON.parse((await call("GET", `/v1/web/sessions/${sessionId}/merge`, { cookie: auth.cookie }))!.body)).toEqual({ mayMerge: true, ready: true, risk: "medium", heads: [HEAD], pullRequests: [PULL] });
    for (const body of [{ requestId: ID, risk: "none" }, { requestId: ID, expectedHeads: [{ ...HEAD, headSha: "zz" }] }, { requestId: ID, expectedHeads: [{ ...HEAD, extra: 1 }] }, { requestId: ID, expectedHeads: [] }]) {
      expect((await call("POST", `/v1/web/sessions/${sessionId}/merge`, { ...auth, body }))!.status).toBe(400);
    }
    expect(mergeCalls().filter((entry) => entry.method === "POST")).toEqual([]);
    expect((await call("POST", `/v1/web/sessions/${sessionId}/merge`, { ...auth, body: { requestId: ID, expectedHeads: [HEAD], risk: "medium" } }))!.status).toBe(200);
    expect(JSON.parse(mergeCalls().filter((entry) => entry.method === "POST")[0]!.body!)).toEqual({ requestId: ID, expectedHeads: [HEAD], risk: "medium" });
    for (const body of [{ mayMerge: true, ready: true, risk: "extreme", pullRequests: [] }, { mayMerge: true, ready: true, heads: [{ ...HEAD, headSha: "x" }], pullRequests: [] }]) {
      code.answerMerge("GET", 200, body);
      expect((await call("GET", `/v1/web/sessions/${sessionId}/merge`, { cookie: auth.cookie }))!.status).toBe(502);
    }
  });

  it("a long half merge is cut, never dropped; an answer Cloud can't read never says nothing was merged", async () => {
    const { call, auth, sessionId, code } = await begin();
    const long = "a, b merged, but c didn't: " + "the code host would not merge it ".repeat(30) + ". Merge it on GitHub or press Merge again.";
    code.answerMerge("POST", 409, { error: { code: "MERGE_NOT_READY", message: long } });
    const half = JSON.parse((await call("POST", `/v1/web/sessions/${sessionId}/merge`, { ...auth, body: { requestId: ID } }))!.body) as { error: { code: string; message: string } };
    expect(half.error.code).toBe("MERGE_NOT_READY");
    expect(half.error.message.startsWith("a, b merged, but c didn't:")).toBe(true);
    expect(half.error.message.length).toBeLessThanOrEqual(600);
    code.answerMerge("POST", 500, "oops");
    const unknown = JSON.parse((await call("POST", `/v1/web/sessions/${sessionId}/merge`, { ...auth, body: { requestId: ID } }))!.body) as { error: { message: string } };
    expect(unknown.error.message).toBe("We couldn't confirm the result yet; checking GitHub. Reload this page in a moment.");
    expect(unknown.error.message).not.toMatch(/nothing was merged/iu);
  });

  it("refuses an answer from Code that does not read (a link that is not github.com, ready without may, extra shapes)", async () => {
    const { call, auth, sessionId, code } = await begin();
    for (const body of [{ mayMerge: true, ready: true, pullRequests: [{ ...PULL, url: "https://evil.example/pull/42" }] }, { mayMerge: false, ready: true, pullRequests: [] }, { mayMerge: true, ready: true }, { mayMerge: true, ready: true, pullRequests: [{ ...PULL, number: 0 }] }]) {
      code.answerMerge("GET", 200, body);
      expect((await call("GET", `/v1/web/sessions/${sessionId}/merge`, { cookie: auth.cookie }))!.status).toBe(502);
    }
    code.answerMerge("POST", 200, { status: "QUEUED", pullRequests: [] });
    expect((await call("POST", `/v1/web/sessions/${sessionId}/merge`, { ...auth, body: { requestId: ID } }))!.status).toBe(502);
  });
});
