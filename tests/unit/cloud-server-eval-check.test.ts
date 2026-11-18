// L4-EVCI2: the setup checklist's "Eval check from your CI" through Cloud's handler. Code serves GET and PUT `/v1/app/projects/{p}/ci-eval-check` (it reads the workflow files, proposes, and keeps the confirmed check);
// Cloud passes each to Code as the signed-in person: the body is rebuilt from its two known fields, every answer is rebuilt from known fields (anything that does not read is refused whole), only a company owner or
// admin or the project's administrator may PUT (Cloud refuses the others before Code is asked; Code decides again), Code's fixed unknown-route 404 reads 501 NOT_ON_CODE_YET, and no text of Code's other than two
// fixed sentences reaches the app. Mutants are listed in the PR body with the test that kills each.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest, type CodeSession } from "../../packages/cloud-server/src/index.js";
import { EVAL_CHECK_ANSWERS, EVAL_CHECK_CODE_WORDS, EVAL_CHECK_LIMITS as SERVER_LIMITS, EVAL_CHECK_WORDS as SERVER_WORDS, evalCheckAnswer, evalCheckBody } from "../../packages/cloud-server/src/eval-check-routes.js";
import { APP_ROUTES } from "../../packages/contracts/src/code-contract-v0.js";
import { EVAL_CHECK_LIMITS, EVAL_CHECK_SENTENCES, EvalCheckSetBodySchema, EvalCheckViewSchema } from "../../packages/contracts/src/eval-check-web.js";

const CODE = "https://code.example.test";
const ADA = "a".repeat(64), PAM = "b".repeat(64), DEV = "c".repeat(64);
const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa", OTHER = "org_bbbbbbbbbbbbbbbbbbbb";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const NO_ROUTE = { error: { code: "NOT_FOUND", message: "route not found" } };
const UUID = "6f9d0c1e-2b3a-4c5d-8e7f-001122334455";
const PATH = (project = "payments") => `/v1/app/projects/${project}/ci-eval-check`;
const WEB = (project = "payments") => `/v1/web/projects/${project}/ci-eval-check`;
const ITEM = { name: "evals", source: "15368", workflow: ".github/workflows/ci.yml", repository: "payments", basis: "name" };
const VIEW = (over: Record<string, unknown> = {}) => ({ project: "payments", canManage: true, confirmed: null, proposals: { verdict: "proposals", items: [ITEM], cut: false }, explanation: "Rovara shows this check's result on its pull requests.", ...over });

interface CodeCall { method: string; path: string; search: string; authorization: string | undefined; body: unknown }
type Answer = (call: CodeCall) => Response;
function setUp(answer: Answer = () => json(200, VIEW())) {
  const calls: CodeCall[] = [];
  // Code's access check (what Cloud asks first, as the person): each token's own answer.
  const accessOf = new Map<string, unknown>(), created = new Set<string>();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    const call: CodeCall = { method: init?.method ?? "GET", path: url.pathname, search: url.search, authorization: headers["authorization"], body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (url.pathname === "/v1/auth/token") return json(400, { error: "invalid_grant" });
    if (url.pathname === "/v1/dev/access") { calls.pop(); return json(200, accessOf.get((headers["authorization"] ?? "").replace("Bearer ", ""))); }
    if (/\/ci-eval-check$/u.test(url.pathname)) return answer(call);
    return json(404, NO_ROUTE);
  }) as typeof fetch;
  const store = new LocalSessionStore(undefined, { environment: {} });
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "projects:members", fetch: fetchImpl });
  const handler = createCloudHandler({
    client, store, work: new LocalWorkSessionStore(), origin: "https://cloud.example.test", org: { orgId: "acme", name: "Acme", plan: "test" },
    callbackPath: "/callback", secureCookies: true, log: () => undefined, now: () => new Date(Date.UTC(2026, 10, 18)),
  });
  const signIn = async (token: string, access: CodeSession["access"]) => {
    accessOf.set(token, access);
    if (!created.has(token)) await store.create(`cookie-${token}`, { accessToken: token, refreshToken: `r-${token}`, csrf: "csrf", signedInAt: "2026-11-18T00:00:00.000Z", access });
    created.add(token);
    return { cookie: `rovara_cloud_session=cookie-${token}`, "x-rovara-csrf": "csrf" };
  };
  const send = async (method: "GET" | "PUT" | "POST", target: string, headers: Record<string, string> = {}, body?: unknown) => {
    const url = new URL(target, "http://127.0.0.1:8787");
    const request: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) };
    const answered = await handler(request);
    return { status: answered!.status, body: JSON.parse(answered!.body) as Record<string, any>, text: answered!.body, headers: answered!.headers }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const toCode = () => calls.filter((call) => /\/ci-eval-check$/u.test(call.path));
  return { signIn, send, calls, toCode };
}
type W = ReturnType<typeof setUp>;
const admin = (w: W) => w.signIn("ada-token", { developerId: ADA, displayName: "Ada", administrator: false, companyId: COMPANY, companyRole: "admin", projects: [], notices: [] });
const owner = (w: W) => w.signIn("own-token", { developerId: ADA, displayName: "Own", administrator: false, companyId: COMPANY, companyRole: "owner", projects: [], notices: [] });
const maintainer = (w: W) => w.signIn("pam-token", { developerId: PAM, displayName: "Pam", administrator: false, companyId: COMPANY, companyRole: "member", projects: [{ name: "payments", access: "administrator" }], notices: [] });
const member = (w: W) => w.signIn("dev-token", { developerId: DEV, displayName: "Dev", administrator: false, companyId: COMPANY, companyRole: "member", projects: [{ name: "payments", access: "developer" }, { name: "other", access: "administrator" }], notices: [] });
const CHOOSE = { requestId: UUID, check: { name: "evals", source: "15368" } };
const NONE = { requestId: UUID, check: null };

let logged: string[] = [];
beforeEach(() => { logged = []; vi.spyOn(console, "log").mockImplementation((line: unknown) => { logged.push(String(line)); }); });
afterEach(() => { vi.restoreAllMocks(); });

describe("the read", () => {
  it("is forwarded to Code's own path as the person: their own token, no body, no query; a plain member of the company may read", async () => {
    const w = setUp();
    expect((await w.send("GET", `${WEB()}`, await admin(w))).status).toBe(200);
    expect((await w.send("GET", WEB(), await member(w), undefined)).status).toBe(200);
    expect(w.toCode().map((call) => [call.method, call.path, call.search, call.authorization, call.body])).toEqual([["GET", PATH(), "", "Bearer ada-token", undefined], ["GET", PATH(), "", "Bearer dev-token", undefined]]);
  });
  it("a query is refused and never forwarded; a project name no route takes is not forwarded", async () => {
    const w = setUp();
    const cookie = await admin(w);
    expect((await w.send("GET", `${WEB()}?company=${OTHER}`, cookie)).status).toBe(400);
    for (const name of ["-x", "a%2Fb", "p".repeat(101), "Upper"]) expect([404, 501].includes((await w.send("GET", WEB(name), cookie)).status), name).toBe(true);
    expect(w.toCode()).toHaveLength(0);
  });
  it("answers the confirmed check and the proposals, rebuilt from known fields: nothing else of Code's (a change time, a role, a secret) comes through, and the card's own sentence is Cloud's", async () => {
    const w = setUp(() => json(200, VIEW({ confirmed: { name: "evals", source: "15368", changedAt: "2026-11-18T08:00:00.000Z", secret: "do-not-echo" }, role: "owner", token: "do-not-echo", explanation: "Code's own words", proposals: { verdict: "proposals", items: [{ ...ITEM, extra: "do-not-echo" }], cut: false, secret: "do-not-echo" } })));
    const answered = await w.send("GET", WEB(), await admin(w));
    expect(answered.status).toBe(200);
    expect(answered.body).toEqual({ project: "payments", canManage: true, confirmed: { name: "evals", source: "15368" }, proposals: { verdict: "proposals", items: [ITEM], cut: false }, explanation: SERVER_WORDS.explanation });
    expect(answered.text).not.toContain("do-not-echo");
    expect(EvalCheckViewSchema.safeParse(answered.body).success).toBe(true);
    expect(answered.headers?.["cache-control"]).toBe("no-store");
  });
  it("a reader gets no proposals; an answer that gives a reader any is not read", async () => {
    const w = setUp(() => json(200, VIEW({ canManage: false, proposals: null, confirmed: { name: "evals" } })));
    expect((await w.send("GET", WEB(), await member(w))).body).toMatchObject({ canManage: false, proposals: null, confirmed: { name: "evals" } });
    const leaky = setUp(() => json(200, VIEW({ canManage: false })));
    expect(await leaky.send("GET", WEB(), await member(leaky))).toMatchObject({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: SERVER_WORDS.unavailable } } });
  });
  it("an answer that does not read is refused whole", () => {
    const bad: unknown[] = [
      null, "x", [], VIEW({ project: "other" }), VIEW({ canManage: "yes" }), VIEW({ confirmed: { name: "" } }), VIEW({ confirmed: { name: "a\nb" } }), VIEW({ confirmed: { name: "x".repeat(201) } }), VIEW({ confirmed: { name: "evals", source: "" } }),
      VIEW({ proposals: { verdict: "maybe", items: [], cut: false } }), VIEW({ proposals: { verdict: "proposals", items: [], cut: false } }), VIEW({ proposals: { verdict: "none_found", items: [ITEM], cut: false } }),
      VIEW({ proposals: { verdict: "proposals", items: Array(6).fill(ITEM), cut: false } }), VIEW({ proposals: { verdict: "proposals", items: [{ ...ITEM, basis: "other" }], cut: false } }),
      VIEW({ proposals: { verdict: "proposals", items: [{ ...ITEM, workflow: "../x" }], cut: false } }), VIEW({ proposals: { verdict: "proposals", items: [{ ...ITEM, workflow: "/etc/x" }], cut: false } }), VIEW({ proposals: { verdict: "proposals", items: [{ ...ITEM, repository: "a‮b" }], cut: false } }),
      VIEW({ proposals: { verdict: "proposals", items: [ITEM], cut: "no" } }), VIEW({ proposals: "x" }), VIEW({ confirmed: "evals" }),
    ];
    for (const value of bad) expect(() => evalCheckAnswer(value, "payments"), JSON.stringify(value)).toThrow();
    expect(() => evalCheckAnswer(VIEW({ proposals: { verdict: "unknown", items: [], cut: false } }), "payments")).not.toThrow();
    expect(() => evalCheckAnswer(VIEW({ proposals: { verdict: "none_found", items: [], cut: false } }), "payments")).not.toThrow();
  });
});

describe("the confirm", () => {
  it("a company owner, a company admin and the project's administrator reach Code with their own token and exactly the two fields", async () => {
    const w = setUp();
    for (const [who, token] of [[admin, "ada-token"], [owner, "own-token"], [maintainer, "pam-token"]] as const) {
      expect((await w.send("PUT", WEB(), await who(w), CHOOSE)).status, token).toBe(200);
    }
    expect((await w.send("PUT", WEB(), await admin(w), NONE)).status).toBe(200);
    expect(w.toCode().map((call) => [call.method, call.path, call.authorization, call.body])).toEqual([
      ["PUT", PATH(), "Bearer ada-token", CHOOSE], ["PUT", PATH(), "Bearer own-token", CHOOSE], ["PUT", PATH(), "Bearer pam-token", CHOOSE], ["PUT", PATH(), "Bearer ada-token", NONE],
    ]);
  });
  it("a plain member (a developer here, a maintainer of another project) is refused 403 in fixed words and Code is never called", async () => {
    const w = setUp();
    expect(await w.send("PUT", WEB(), await member(w), CHOOSE)).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN", message: SERVER_WORDS.notAllowed } } });
    expect(await w.send("PUT", WEB(), await member(w), NONE)).toMatchObject({ status: 403 });
    const installAdmin = await w.signIn("inst-token", { developerId: DEV, displayName: "Inst", administrator: true, companyId: COMPANY, companyRole: "member", projects: [], notices: [] });
    expect((await w.send("PUT", WEB(), installAdmin, CHOOSE)).status).toBe(403);
    expect(w.calls).toHaveLength(0);
  });
  it("a person Code names no company for gets NO_COMPANY, no session is 401, a bad CSRF token is 403, and Code is never called", async () => {
    const w = setUp();
    const none = await w.signIn("none-token", { developerId: DEV, displayName: "None", administrator: true, projects: [{ name: "payments", access: "administrator" }], notices: [] });
    expect(await w.send("PUT", WEB(), none, CHOOSE)).toMatchObject({ status: 403, body: { error: { code: "NO_COMPANY" } } });
    expect((await w.send("PUT", WEB(), {}, CHOOSE)).status).toBe(401);
    expect(await w.send("PUT", WEB(), { cookie: (await admin(w)).cookie, "x-rovara-csrf": "wrong" }, CHOOSE)).toMatchObject({ status: 403, body: { error: { code: "CSRF_INVALID" } } });
    expect(w.calls).toHaveLength(0);
  });
  it("a body that is not exactly a request id and a check (or null) is refused and never forwarded", async () => {
    const w = setUp();
    const cookie = await admin(w);
    const bad: unknown[] = [
      {}, { ...CHOOSE, company: OTHER }, { ...CHOOSE, role: "owner" }, { requestId: "x", check: null }, { check: null }, { requestId: UUID }, { requestId: UUID, check: "evals" }, { requestId: UUID, check: {} },
      { requestId: UUID, check: { name: "" } }, { requestId: UUID, check: { name: "x".repeat(201) } }, { requestId: UUID, check: { name: "a\nb" } }, { requestId: UUID, check: { name: "evals", source: "" } },
      { requestId: UUID, check: { name: "evals", payer: "x" } }, { requestId: UUID, check: [] }, [], "x", 7, "{not json",
    ];
    for (const body of bad) expect((await w.send("PUT", WEB(), cookie, body)).status, JSON.stringify(body)).toBe(400);
    expect(w.toCode()).toHaveLength(0);
    expect(evalCheckBody({ requestId: UUID, check: { name: "evals", source: "15368" } })).toEqual(CHOOSE);
    expect(evalCheckBody({ requestId: UUID, check: null })).toEqual(NONE);
  });
  it("a query is refused and never forwarded", async () => {
    const w = setUp();
    expect((await w.send("PUT", `${WEB()}?company=${OTHER}`, await admin(w), CHOOSE)).status).toBe(400);
    expect(w.toCode()).toHaveLength(0);
  });
  it("answers Code's new view rebuilt, and logs what was done and where, never what was chosen", async () => {
    const secret = "SECRET-CHECK-NAME";
    const w = setUp(() => json(200, VIEW({ confirmed: { name: secret, source: "15368" } })));
    const answered = await w.send("PUT", WEB(), await admin(w), { requestId: UUID, check: { name: secret, source: "15368" } });
    expect(answered.body["confirmed"]).toEqual({ name: secret, source: "15368" });
    expect(logged.join("\n")).toContain("cloud.eval_check");
    expect(logged.join("\n")).toContain("eval_check_confirmed");
    expect(logged.join("\n")).not.toContain(secret);
    await w.send("PUT", WEB(), await admin(w), NONE);
    expect(logged.join("\n")).toContain("eval_check_cleared");
  });
});

describe("Code's refusals reach the app in fixed words", () => {
  const refuse = (status: number, code: string, message: string) => () => json(status, { error: { code, message } });
  it("Code's unknown-route 404 is 501 NOT_ON_CODE_YET; any other 404 is the project's; both for the read and the confirm", async () => {
    const yet = setUp(() => json(404, NO_ROUTE));
    for (const [method, body] of [["GET", undefined], ["PUT", CHOOSE]] as const) expect(await yet.send(method, WEB(), await admin(yet), body)).toMatchObject({ status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: SERVER_WORDS.notYet } } });
    const gone = setUp(refuse(404, "NOT_FOUND", "project not found"));
    expect(await gone.send("GET", WEB(), await admin(gone))).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND", message: SERVER_WORDS.notFound } } });
  });
  it("Code's 403 is Cloud's own fixed words, whatever Code said", async () => {
    const w = setUp(refuse(403, "FORBIDDEN", "Code says: SECRET-DETAIL"));
    const answered = await w.send("PUT", WEB(), await admin(w), CHOOSE);
    expect(answered).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN", message: SERVER_WORDS.notAllowed } } });
    expect(answered.text).not.toContain("SECRET-DETAIL");
  });
  it("Code's two fixed sentences are passed on exactly; any other 400 or 503 is Cloud's own sentence", async () => {
    const proposed = setUp(refuse(400, "CONFIG_INVALID", EVAL_CHECK_CODE_WORDS.notProposed));
    expect(await proposed.send("PUT", WEB(), await admin(proposed), CHOOSE)).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID", message: EVAL_CHECK_CODE_WORDS.notProposed } } });
    const cannot = setUp(refuse(503, "RUNTIME_UNAVAILABLE", EVAL_CHECK_CODE_WORDS.cannotRead));
    expect(await cannot.send("PUT", WEB(), await admin(cannot), CHOOSE)).toMatchObject({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: EVAL_CHECK_CODE_WORDS.cannotRead } } });
    const other400 = setUp(refuse(400, "CONFIG_INVALID", "SECRET-DETAIL"));
    const a = await other400.send("PUT", WEB(), await admin(other400), CHOOSE);
    expect(a).toMatchObject({ status: 400, body: { error: { message: SERVER_WORDS.invalid } } });
    expect(a.text).not.toContain("SECRET-DETAIL");
    const audit = setUp(refuse(503, "AUDIT_UNAVAILABLE", "SECRET-DETAIL"));
    expect(await audit.send("PUT", WEB(), await admin(audit), CHOOSE)).toMatchObject({ status: 503, body: { error: { code: "AUDIT_UNAVAILABLE", message: SERVER_WORDS.auditUnavailable } } });
    const boom = setUp(refuse(500, "INTERNAL", "SECRET-DETAIL"));
    const b = await boom.send("GET", WEB(), await admin(boom));
    expect(b).toMatchObject({ status: 503, body: { error: { message: SERVER_WORDS.unavailable } } });
    expect(b.text).not.toContain("SECRET-DETAIL");
  });
});

describe("the words and limits are the web contract's", () => {
  it("the server repeats the contract's limits and sentence, so a change of one is a change of both", () => {
    expect(SERVER_LIMITS).toEqual(EVAL_CHECK_LIMITS);
    expect(SERVER_WORDS.explanation).toBe("Rovara shows this check's result on its pull requests.");
    // Every fixed refusal the server can give is one the page is willing to show, and the page shows no other.
    for (const answer of [EVAL_CHECK_ANSWERS.notAllowed, EVAL_CHECK_ANSWERS.notProposed, EVAL_CHECK_ANSWERS.cannotRead, EVAL_CHECK_ANSWERS.auditUnavailable, EVAL_CHECK_ANSWERS.unavailable, EVAL_CHECK_ANSWERS.notFound]) expect(EVAL_CHECK_SENTENCES.has((answer.body as { error: { message: string } }).error.message), JSON.stringify(answer)).toBe(true);
    expect(EVAL_CHECK_SENTENCES.size).toBe(6);
    expect(EvalCheckSetBodySchema.safeParse(CHOOSE).success).toBe(true);
    expect(EvalCheckSetBodySchema.safeParse(NONE).success).toBe(true);
    expect(EvalCheckSetBodySchema.safeParse({ ...CHOOSE, extra: 1 }).success).toBe(false);
  });
  it("the contract table lists both routes as answered by Cloud", () => {
    const rows = APP_ROUTES.filter((route) => route.path === "/v1/app/projects/{p}/ci-eval-check");
    expect(rows.map((route) => route.method).sort()).toEqual(["GET", "PUT"]);
    for (const row of rows) expect(row.cloudServerToday).toBe(true);
  });
});
