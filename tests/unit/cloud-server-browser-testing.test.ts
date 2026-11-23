// Browser testing in a project's setup (DEC 417/420/421) through Cloud's handler. Code serves the route family `/v1/app/projects/{p}/browser-testing`; Cloud passes each call to Code as the signed-in person: nothing typed is
// in any body or answer (a member no schema lists is refused), every change is for a company owner or admin only (the project's own administrator is refused before Code is asked), every answer is read with the strict
// contract schema, Code's refusals pass only as its exact fixed sentences, a change whose answer did not arrive is the one "outcome is unknown" answer, and the logs never carry what was chosen.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest, type CodeSession } from "../../packages/cloud-server/src/index.js";
import { BROWSER_TESTING_ANSWERS as A, browserTestingRefusal } from "../../packages/cloud-server/src/browser-testing-routes.js";
import { CodeError } from "../../packages/cloud-server/src/code-client.js";
import { BROWSER_TESTING_CLOUD_SENTENCES as W, BROWSER_TESTING_CODE_SENTENCES as C, BrowserTestingViewSchema } from "../../packages/contracts/src/browser-testing-web.js";
import { APP_ROUTES } from "../../packages/contracts/src/code-contract-v0.js";
import { BT_DIGEST, approval, btView } from "../web/support/browser-testing-fixtures.js";

const CODE = "https://code.example.test";
const ADA = "a".repeat(64), PAM = "b".repeat(64), DEV = "c".repeat(64);
const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const NO_ROUTE = { error: { code: "NOT_FOUND", message: "route not found" } };
const UUID = "6f9d0c1e-2b3a-4c5d-8e7f-001122334455";
const PATH = (tail = "", project = "payments") => `/v1/app/projects/${project}/browser-testing${tail}`;
const WEB = (tail = "", project = "payments") => `/v1/web/projects/${project}/browser-testing${tail}`;
const DECISION = { requestId: approval().requestId, outcome: "approve", seen: { revision: 5, artifactDigest: BT_DIGEST } };
const DECIDED = { project: "payments", decision: "approved", revision: 5, replayed: false, view: btView("on") };

interface CodeCall { method: string; path: string; search: string; authorization: string | undefined; body: unknown }
type Answer = (call: CodeCall) => Response | Promise<Response>;
function setUp(answer: Answer = (call) => json(200, call.method === "GET" ? btView("draft") : call.path.endsWith("/decision") ? DECIDED : btView("draft"))) {
  const calls: CodeCall[] = [];
  const accessOf = new Map<string, unknown>(), created = new Set<string>();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    const call: CodeCall = { method: init?.method ?? "GET", path: url.pathname, search: url.search, authorization: headers["authorization"], body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (url.pathname === "/v1/auth/token") return json(400, { error: "invalid_grant" });
    if (url.pathname === "/v1/dev/access") { calls.pop(); return json(200, accessOf.get((headers["authorization"] ?? "").replace("Bearer ", ""))); }
    if (/\/browser-testing(?:\/[a-z]+)?$/u.test(url.pathname)) return answer(call);
    return json(404, NO_ROUTE);
  }) as typeof fetch;
  const store = new LocalSessionStore(undefined, { environment: {} });
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "projects:members", fetch: fetchImpl });
  const handler = createCloudHandler({
    client, store, work: new LocalWorkSessionStore(), origin: "https://cloud.example.test", org: { orgId: "acme", name: "Acme", plan: "test" },
    callbackPath: "/callback", secureCookies: true, log: () => undefined, now: () => new Date(Date.UTC(2026, 10, 23)),
  });
  const signIn = async (token: string, access: CodeSession["access"]) => {
    accessOf.set(token, access);
    if (!created.has(token)) await store.create(`cookie-${token}`, { accessToken: token, refreshToken: `r-${token}`, csrf: "csrf", signedInAt: "2026-11-23T00:00:00.000Z", access });
    created.add(token);
    return { cookie: `rovara_cloud_session=cookie-${token}`, "x-rovara-csrf": "csrf" };
  };
  const send = async (method: "GET" | "PUT" | "POST", target: string, headers: Record<string, string> = {}, body?: unknown) => {
    const url = new URL(target, "http://127.0.0.1:8787");
    const request: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) };
    const answered = await handler(request);
    return { status: answered!.status, body: JSON.parse(answered!.body) as Record<string, any>, text: answered!.body, headers: answered!.headers }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const toCode = () => calls.filter((call) => /\/browser-testing(?:\/[a-z]+)?$/u.test(call.path));
  return { signIn, send, calls, toCode };
}
type S = ReturnType<typeof setUp>;
const admin = (w: S) => w.signIn("ada-token", { developerId: ADA, displayName: "Ada", administrator: false, companyId: COMPANY, companyRole: "admin", projects: [], notices: [] });
const owner = (w: S) => w.signIn("own-token", { developerId: ADA, displayName: "Own", administrator: false, companyId: COMPANY, companyRole: "owner", projects: [], notices: [] });
const projectAdmin = (w: S) => w.signIn("pam-token", { developerId: PAM, displayName: "Pam", administrator: false, companyId: COMPANY, companyRole: "member", projects: [{ name: "payments", access: "administrator" }], notices: [] });
const member = (w: S) => w.signIn("dev-token", { developerId: DEV, displayName: "Dev", administrator: false, companyId: COMPANY, companyRole: "member", projects: [{ name: "payments", access: "developer" }], notices: [] });

const CHANGES: Array<[string, "POST" | "PUT", string, Record<string, unknown>]> = [
  ["refresh", "POST", "/refresh", { requestId: UUID }],
  ["choices", "PUT", "/draft", { requestId: UUID, expectedDraftRevision: 3, proof: { screenshotMode: "all", video: true }, runTimeoutMs: 300_000 }],
  ["check", "POST", "/check", { requestId: UUID, expectedDraftRevision: 3 }],
  ["decision", "POST", "/decision", DECISION],
  ["discard", "POST", "/discard", { requestId: UUID }],
  ["pause", "POST", "/pause", { requestId: UUID }],
  ["resume", "POST", "/resume", { requestId: UUID }],
];

let logged: string[] = [];
beforeEach(() => { logged = []; vi.spyOn(console, "log").mockImplementation((line: unknown) => { logged.push(String(line)); }); });
afterEach(() => { vi.restoreAllMocks(); });

describe("the read", () => {
  it("is forwarded to Code's own path as the person, with no body and no query; any role on the company may ask (Code decides who sees the project)", async () => {
    const w = setUp();
    for (const who of [admin, member, projectAdmin]) expect((await w.send("GET", WEB(), await who(w))).status).toBe(200);
    expect(w.toCode().map((call) => [call.method, call.path, call.search, call.authorization, call.body])).toEqual([
      ["GET", PATH(), "", "Bearer ada-token", undefined], ["GET", PATH(), "", "Bearer dev-token", undefined], ["GET", PATH(), "", "Bearer pam-token", undefined],
    ]);
  });
  it("answers the view Code served, read with the strict schema, never cached", async () => {
    const w = setUp();
    const answered = await w.send("GET", WEB(), await admin(w));
    expect(BrowserTestingViewSchema.parse(answered.body)).toEqual(btView("draft"));
    expect(answered.headers?.["cache-control"]).toBe("no-store");
  });
  it("a query is refused and never forwarded; a project name no route takes is not forwarded", async () => {
    const w = setUp();
    const cookie = await admin(w);
    expect((await w.send("GET", `${WEB()}?company=org_bbbbbbbbbbbbbbbbbbbb`, cookie)).status).toBe(400);
    for (const name of ["-x", "a%2Fb", "p".repeat(101), "Upper"]) expect([404, 501].includes((await w.send("GET", WEB("", name), cookie)).status), name).toBe(true);
    expect(w.toCode()).toHaveLength(0);
  });
  it("an answer that does not read is refused whole: a password, an address or any extra member, another project, a bad value", async () => {
    const bad: Array<Record<string, unknown>> = [
      btView("draft", { password: "do-not-echo" }), btView("draft", { sandboxAddress: "http://app:4317" }), btView("draft", { project: "other" }), btView("draft", { state: "maybe" }),
      btView("draft", { accounts: [{ profileId: "admin", roleRef: "admin", signInPath: "/login", lastSignIn: null, password: "do-not-echo" }] }),
      btView("draft", { accounts: [{ profileId: "admin", roleRef: "admin", signInPath: "/login", lastSignIn: { status: "maybe", checkedAt: "2026-11-23T05:02:00.000Z" } }] }),
      btView("draft", { faults: ["a-fault-nobody-named"] }), btView("draft", { canManage: "yes" }), btView("on", { approved: { revision: 1, approvedAt: null, approvedBy: null, decidedByYou: false, summary: null, token: "do-not-echo" } }),
    ];
    for (const value of bad) {
      const w = setUp(() => json(200, value));
      const answered = await w.send("GET", WEB(), await admin(w));
      expect(answered, JSON.stringify(value)).toMatchObject({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: W.unavailable } } });
      expect(answered.text).not.toContain("do-not-echo");
    }
  });
  it("Code's unknown-route 404 is 501 NOT_ON_CODE_YET; its other 404 is not found; nothing else of Code's text comes through", async () => {
    const w = setUp(() => json(404, NO_ROUTE));
    expect(await w.send("GET", WEB(), await admin(w))).toMatchObject({ status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: W.notYet } } });
    const gone = setUp(() => json(404, { error: { code: "NOT_FOUND", message: "secret detail of Code" } }));
    const answered = await gone.send("GET", WEB(), await admin(gone));
    expect(answered).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND", message: W.notFound } } });
    expect(answered.text).not.toContain("secret detail");
  });
});

describe("the changes", () => {
  it.each(CHANGES)("%s: a company owner or admin reaches Code with their own token and exactly the listed members", async (_name, method, tail, body) => {
    const w = setUp();
    expect((await w.send(method, WEB(tail), await admin(w), body)).status).toBe(200);
    expect((await w.send(method, WEB(tail), await owner(w), body)).status).toBe(200);
    expect(w.toCode().map((call) => [call.method, call.path, call.authorization, call.body])).toEqual([[method, PATH(tail), "Bearer ada-token", body], [method, PATH(tail), "Bearer own-token", body]]);
  });
  it.each(CHANGES)("%s: the project's own administrator and a plain member are refused 403 in fixed words and Code is never called", async (_name, method, tail, body) => {
    const w = setUp();
    expect(await w.send(method, WEB(tail), await projectAdmin(w), body)).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN", message: C.notAllowed } } });
    expect(await w.send(method, WEB(tail), await member(w), body)).toMatchObject({ status: 403 });
    const installAdmin = await w.signIn("inst-token", { developerId: DEV, displayName: "Inst", administrator: true, companyId: COMPANY, companyRole: "member", projects: [], notices: [] });
    expect((await w.send(method, WEB(tail), installAdmin, body)).status).toBe(403);
    expect(w.calls).toHaveLength(0);
  });
  it.each(CHANGES)("%s: a member the schema does not list (a password, a company, a role, an address), a missing member and a body that is not an object are refused 400 and never forwarded", async (_name, method, tail, body) => {
    const w = setUp();
    const cookie = await admin(w);
    for (const extra of [{ password: "do-not-echo" }, { companyId: COMPANY }, { role: "owner" }, { address: "http://localhost:3000" }, { username: "ada" }]) {
      const answered = await w.send(method, WEB(tail), cookie, { ...body, ...extra });
      expect(answered, JSON.stringify(extra)).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID", message: W.invalid } } });
      expect(answered.text).not.toContain("do-not-echo");
    }
    expect((await w.send(method, WEB(tail), cookie, { requestId: "not-a-uuid" })).status).toBe(400);
    expect((await w.send(method, WEB(tail), cookie, "[]")).status).toBe(400);
    expect((await w.send(method, WEB(tail), cookie, "{not json")).status).toBe(400);
    expect(w.toCode()).toHaveLength(0);
  });
  it("the choices need a draft revision and at least one choice; the time limit is bounded", async () => {
    const w = setUp();
    const cookie = await admin(w);
    for (const body of [{ requestId: UUID }, { requestId: UUID, proof: { screenshotMode: "all", video: false } }, { requestId: UUID, expectedDraftRevision: 3 }, { requestId: UUID, expectedDraftRevision: 3, runTimeoutMs: 1000 }, { requestId: UUID, expectedDraftRevision: 3, runTimeoutMs: 9_000_000 }, { requestId: UUID, expectedDraftRevision: 3, proof: { screenshotMode: "none", video: false } }]) {
      expect((await w.send("PUT", WEB("/draft"), cookie, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(w.toCode()).toHaveLength(0);
  });
  it("a decision with a request id that is not Code's setup id, an outcome that is not approve or reject, or a digest that is not 64 hex is refused", async () => {
    const w = setUp();
    const cookie = await admin(w);
    for (const body of [{ ...DECISION, requestId: UUID }, { ...DECISION, outcome: "maybe" }, { ...DECISION, seen: { revision: 5, artifactDigest: "abc" } }, { ...DECISION, seen: { revision: 5, artifactDigest: BT_DIGEST, extra: 1 } }]) {
      expect((await w.send("POST", WEB("/decision"), cookie, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(w.toCode()).toHaveLength(0);
  });
  it("a change answers the page's read again (the decision answers what was decided and the read), another project's answer is refused", async () => {
    const w = setUp();
    expect((await w.send("POST", WEB("/pause"), await admin(w), { requestId: UUID })).body).toEqual(btView("draft"));
    expect((await w.send("POST", WEB("/decision"), await admin(w), DECISION)).body).toEqual(DECIDED);
    const other = setUp(() => json(200, btView("draft", { project: "other" })));
    expect(await other.send("POST", WEB("/pause"), await admin(other), { requestId: UUID })).toMatchObject({ status: 503, body: { error: { message: W.outcomeUnknown } } });
  });
});

describe("refusals and unknown outcomes", () => {
  it("Code's exact fixed sentences pass with its status and code; any other text becomes Cloud's fixed words", async () => {
    for (const [status, code, message] of [[409, "CHANGE_STALE", C.stale], [409, "WORKSPACE_BUSY", C.anotherWaiting], [503, "RUNTIME_UNAVAILABLE", C.sandboxUnavailable], [503, "AUDIT_UNAVAILABLE", C.auditUnavailable], [403, "FORBIDDEN", C.adminOnly], [400, "CONFIG_INVALID", C.needsInput]] as const) {
      const w = setUp(() => json(status, { error: { code, message } }));
      expect(await w.send("POST", WEB("/check"), await admin(w), { requestId: UUID, expectedDraftRevision: 3 }), message).toMatchObject({ status, body: { error: { code, message } } });
    }
    const own = setUp(() => json(409, { error: { code: "CHANGE_STALE", message: "Code's own words: do-not-echo the person's setup" } }));
    const answered = await own.send("POST", WEB("/check"), await admin(own), { requestId: UUID, expectedDraftRevision: 3 });
    expect(answered.text).not.toContain("do-not-echo");
    // review L3: a 409 in words nobody fixed is still "changed while you were looking", not "could not be read just now"
    expect(answered).toMatchObject({ status: 409, body: { error: { code: "CHANGE_STALE", message: C.stale } } });
  });
  it("a change whose answer did not arrive (an unreadable body) is the one unknown-outcome answer, never a refusal, and is not sent twice", async () => {
    const unreadable = setUp(() => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }));
    expect(await unreadable.send("POST", WEB("/pause"), await admin(unreadable), { requestId: UUID })).toMatchObject({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: W.outcomeUnknown } } });
    expect(unreadable.toCode()).toHaveLength(1);
  });
  it("browserTestingRefusal maps the status classes: 404 route, 404 project, 403, 400, anything else", () => {
    expect(browserTestingRefusal(new CodeError(404, NO_ROUTE))).toBe(A.notYet);
    expect(browserTestingRefusal(new CodeError(404, { error: { code: "NOT_FOUND", message: C.projectNotFound } })).status).toBe(404);
    expect(browserTestingRefusal(new CodeError(403, { error: { code: "FORBIDDEN", message: "other" } }))).toBe(A.notAllowed);
    expect(browserTestingRefusal(new CodeError(400, { error: { code: "CONFIG_INVALID", message: "other" } }))).toBe(A.invalid);
    expect(browserTestingRefusal(new CodeError(500, {}))).toBe(A.unavailable);
  });
});

describe("review L2: the core host's 'not on the core engine yet' 404", () => {
  it("is 501 NOT_ON_CODE_YET like an older Code's unknown route, on a read and on a change; other 404 words stay 'not found'", async () => {
    const CORE = { error: { code: "NOT_FOUND", message: "That is not on the core engine on this install yet." } };
    expect(browserTestingRefusal(new CodeError(404, CORE))).toBe(A.notYet);
    const w = setUp(() => json(404, CORE));
    expect(await w.send("GET", WEB(), await admin(w))).toMatchObject({ status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: W.notYet } } });
    expect(await w.send("POST", WEB("/pause"), await admin(w), { requestId: UUID })).toMatchObject({ status: 501, body: { error: { code: "NOT_ON_CODE_YET" } } });
  });
});

describe("the logs and the table", () => {
  it("the logs say what was done and where, never what was chosen", async () => {
    const w = setUp();
    await w.send("PUT", WEB("/draft"), await admin(w), CHANGES[1]![3]);
    await w.send("POST", WEB("/decision"), await admin(w), DECISION);
    const lines = logged.map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return {}; } }).filter((line) => line["event"] === "cloud.browser_testing");
    expect(lines).toEqual([{ event: "cloud.browser_testing", action: "choices", project: "payments" }, { event: "cloud.browser_testing", action: "decision", project: "payments" }]);
    expect(logged.join("\n")).not.toMatch(/screenshotMode|runTimeoutMs|expectedDraftRevision|requestId|artifactDigest|6f9d0c1e/u);
  });
  it("contract v0 lists the eight web routes as Cloud's today", () => {
    const rows = APP_ROUTES.filter((route) => route.path.includes("/browser-testing"));
    expect(rows.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      "GET /v1/app/projects/{p}/browser-testing", "POST /v1/app/projects/{p}/browser-testing/check", "POST /v1/app/projects/{p}/browser-testing/decision", "POST /v1/app/projects/{p}/browser-testing/discard",
      "POST /v1/app/projects/{p}/browser-testing/pause", "POST /v1/app/projects/{p}/browser-testing/refresh", "POST /v1/app/projects/{p}/browser-testing/resume", "PUT /v1/app/projects/{p}/browser-testing/draft",
    ]);
    for (const route of rows) expect(route.cloudServerToday).toBe(true);
  });
});

describe("review (lead 4 Opus, fedbc9de7): a change Code may have made is never answered as 'could not be read'", () => {
  // Code's write path makes the change and THEN reads the page again (core-host/browser-testing-routes.ts `await applyChange(...); return json(200, await read())`, and the decision's `view: await read()`);
  // a failed read after the change, any other thrown error, a Lambda 502 or an API Gateway 504 all reach Cloud as a 5xx. The change may have been made: that is the one "outcome is unknown" answer (rule #14).
  it.each([
    ["an API Gateway timeout", 504, { message: "Endpoint request timed out" }],
    ["a Lambda error", 502, { message: "Internal server error" }],
    ["a 500 with no words", 500, {}],
    ["Code's own 'couldn't read' after the change", 503, { error: { code: "RUNTIME_UNAVAILABLE", message: C.unreadable } }],
  ] as const)("%s on Approve / Pause is the unknown-outcome answer, sent once", async (_name, status, body) => {
    for (const [tail, sent] of [["/decision", DECISION], ["/pause", { requestId: UUID }]] as const) {
      const w = setUp(() => json(status, body));
      expect(await w.send("POST", WEB(tail), await admin(w), sent), `${tail} ${status}`).toMatchObject({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: W.outcomeUnknown } } });
      expect(w.toCode()).toHaveLength(1);
    }
  });
  it("a refusal Code makes BEFORE any change keeps its own words (the sandbox, the audit record), and a READ's 5xx stays 'could not be read'", async () => {
    for (const message of [C.sandboxUnavailable, C.auditUnavailable]) {
      const w = setUp(() => json(503, { error: { code: message === C.auditUnavailable ? "AUDIT_UNAVAILABLE" : "RUNTIME_UNAVAILABLE", message } }));
      expect(await w.send("POST", WEB("/check"), await admin(w), { requestId: UUID, expectedDraftRevision: 3 })).toMatchObject({ body: { error: { message } } });
    }
    const r = setUp(() => json(504, { message: "Endpoint request timed out" }));
    expect(await r.send("GET", WEB(""), await admin(r))).toMatchObject({ body: { error: { message: W.unavailable } } });
  });
});

describe("review (lead 4 Opus, fedbc9de7): the decision's own read must be THIS project's", () => {
  it("a decision answer whose page read names another project is refused whole (unknown outcome), never shown", async () => {
    const w = setUp(() => json(200, { ...DECIDED, view: btView("on", { project: "other" }) }));
    expect(await w.send("POST", WEB("/decision"), await admin(w), DECISION)).toMatchObject({ status: 503, body: { error: { message: W.outcomeUnknown } } });
  });
});
