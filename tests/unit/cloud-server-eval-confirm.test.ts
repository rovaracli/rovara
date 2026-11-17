// DEC 253q (d): POST /v1/app/projects/{p}/setup-agent/eval-confirm through Cloud's handler. Cloud is an API layer over Code: it
// forwards the confirm to Code's own route as the signed-in person (their own bearer token), only for a company administrator or the
// project's maintainer (Code re-checks the role live), only an object body and only its taskId, reportDigest, selection and paths.
// Code's answer comes back as is, except Code's fixed unknown-route 404, which reads 501 NOT_ON_CODE_YET until Code serves the route (E2).
import { describe, expect, it } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest, type CodeSession } from "../../packages/cloud-server/src/index.js";
import { APP_ROUTES } from "../../packages/contracts/src/code-contract-v0.js";

const CODE = "https://code.example.test";
const ADA = "a".repeat(64);
const PAM = "b".repeat(64);
const DEV = "c".repeat(64);
const PATH = "/v1/app/projects/payments/setup-agent/eval-confirm";
const WEB = "/v1/web/projects/payments/setup-agent/eval-confirm";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const NOT_ON_CODE = { error: { code: "NOT_ON_CODE_YET", message: "/v1/app/projects/payments/setup-agent/eval-confirm isn't on this Rovara Code yet." } };
const confirm = { taskId: "6f9d0c1e-2b3a-4c5d-8e7f-001122334455", reportDigest: "d".repeat(64), selection: "all-questions", paths: ["evals/a.yaml"] };

interface CodeCall { method: string; path: string; authorization: string | undefined; body: unknown }
function setUp(answer: (call: CodeCall) => Response = () => json(200, { confirmed: true, requestId: "r" })) {
  const calls: CodeCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const call: CodeCall = { method: init?.method ?? "GET", path: url.pathname, authorization: (init?.headers as Record<string, string> | undefined)?.authorization, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (url.pathname === "/v1/auth/token") return json(400, { error: "invalid_grant" });
    if (url.pathname === PATH) return answer(call);
    return json(404, { error: { code: "NOT_FOUND", message: "route not found" } });
  }) as typeof fetch;
  const store = new LocalSessionStore(undefined, { environment: {} });
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "projects:members", fetch: fetchImpl });
  const handler = createCloudHandler({
    client, store, work: new LocalWorkSessionStore(), origin: "https://cloud.example.test", org: { orgId: "acme", name: "Acme", plan: "test" },
    callbackPath: "/callback", secureCookies: true, log: () => undefined, now: () => new Date(Date.UTC(2026, 10, 16)),
  });
  const signIn = async (token: string, access: CodeSession["access"]) => {
    await store.create(`cookie-${token}`, { accessToken: token, refreshToken: `r-${token}`, csrf: "csrf", signedInAt: "2026-11-16T00:00:00.000Z", access });
    return `rovara_cloud_session=cookie-${token}`;
  };
  const post = async (target: string, body: unknown, headers: Record<string, string> = {}) => {
    const url = new URL(target, "http://127.0.0.1:8787");
    const request: CloudRequest = { method: "POST", path: url.pathname, query: url.searchParams, headers, body: typeof body === "string" ? body : JSON.stringify(body) };
    const answered = await handler(request);
    return { status: answered!.status, body: JSON.parse(answered!.body) as unknown };
  };
  const forwarded = () => calls.filter((call) => call.path === PATH);
  return { signIn, post, calls, forwarded };
}
const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";
const admin = (w: ReturnType<typeof setUp>) => w.signIn("ada-token", { developerId: ADA, displayName: "Ada", administrator: false, companyId: COMPANY, companyRole: "admin", projects: [], notices: [] });
const maintainer = (w: ReturnType<typeof setUp>) => w.signIn("pam-token", { developerId: PAM, displayName: "Pam", administrator: false, companyId: COMPANY, companyRole: "member", projects: [{ name: "payments", access: "administrator" }], notices: [] });
const member = (w: ReturnType<typeof setUp>) => w.signIn("dev-token", { developerId: DEV, displayName: "Dev", administrator: false, companyId: COMPANY, companyRole: "member", projects: [{ name: "payments", access: "developer" }, { name: "other", access: "administrator" }], notices: [] });
const as = (cookie: string) => ({ cookie, "x-rovara-csrf": "csrf" });

describe("who is forwarded", () => {
  it("a company administrator: Code gets the person's own token, the exact path and the body", async () => {
    const w = setUp();
    const res = await w.post(WEB, confirm, as(await admin(w)));
    expect(res).toEqual({ status: 200, body: { confirmed: true, requestId: "r" } });
    expect(w.forwarded()).toEqual([{ method: "POST", path: PATH, authorization: "Bearer ada-token", body: confirm }]);
  });
  it("the project's maintainer", async () => {
    const w = setUp();
    expect((await w.post(WEB, confirm, as(await maintainer(w)))).status).toBe(200);
    expect(w.forwarded().map((call) => call.authorization)).toEqual(["Bearer pam-token"]);
  });
  it("a plain member (a developer here, a maintainer elsewhere) is refused 403 and Code is never called", async () => {
    const w = setUp();
    const res = await w.post(WEB, confirm, as(await member(w)));
    expect(res).toEqual({ status: 403, body: { error: { code: "FORBIDDEN", message: "Only a company owner, admin or project maintainer confirms the eval." } } });
    expect(w.calls).toHaveLength(0);
  });
  it("a company owner, though not Code's install administrator", async () => {
    const w = setUp();
    const cookie = await w.signIn("own-token", { developerId: ADA, displayName: "Own", administrator: false, companyId: COMPANY, companyRole: "owner", projects: [], notices: [] });
    expect((await w.post(WEB, confirm, as(cookie))).status).toBe(200);
  });
  it("Code's install administrator who is a plain member of the company is refused, and Code is never called", async () => {
    const w = setUp();
    const cookie = await w.signIn("inst-token", { developerId: DEV, displayName: "Inst", administrator: true, companyId: COMPANY, companyRole: "member", projects: [], notices: [] });
    expect((await w.post(WEB, confirm, as(cookie))).status).toBe(403);
    expect(w.calls).toHaveLength(0);
  });
  it("a person Code names no company for is refused with the fixed words, even as install administrator", async () => {
    const w = setUp();
    const cookie = await w.signIn("none-token", { developerId: DEV, displayName: "None", administrator: true, projects: [{ name: "payments", access: "administrator" }], notices: [] });
    expect(await w.post(WEB, confirm, as(cookie))).toEqual({ status: 403, body: { error: { code: "NO_COMPANY", message: "You're not in a company yet." } } });
    expect(w.calls).toHaveLength(0);
  });
  it("a person with no entry for the project is refused", async () => {
    const w = setUp();
    const cookie = await w.signIn("x-token", { developerId: DEV, displayName: "X", administrator: false, companyId: COMPANY, companyRole: "member", projects: [], notices: [] });
    expect((await w.post(WEB, confirm, as(cookie))).status).toBe(403);
    expect(w.calls).toHaveLength(0);
  });
  it("no session is 401 and a bad CSRF token is 403, and Code is never called", async () => {
    const w = setUp();
    expect((await w.post(WEB, confirm)).status).toBe(401);
    const res = await w.post(WEB, confirm, { cookie: await admin(w), "x-rovara-csrf": "wrong" });
    expect(res.status).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe("CSRF_INVALID");
    expect(w.calls).toHaveLength(0);
  });
});

describe("the body", () => {
  it("keys other than taskId, reportDigest, selection and paths are dropped", async () => {
    const w = setUp();
    const cookie = await admin(w);
    await w.post(WEB, { ...confirm, approver: "someone-else", maxCostMicros: 1, __proto__x: 1 }, as(cookie));
    expect(w.forwarded()[0]!.body).toEqual(confirm);
    await w.post(WEB, { taskId: "t", extra: 1 }, as(cookie));
    expect(w.forwarded()[1]!.body).toEqual({ taskId: "t" });
  });
  it("a body that is not an object is refused 400 CONFIG_INVALID and Code is never called", async () => {
    const w = setUp();
    const cookie = await admin(w);
    for (const body of [[], ["taskId"], "text", 5, null, true]) {
      const res = await w.post(WEB, body, as(cookie));
      expect(res.status).toBe(400);
      expect((res.body as { error: { code: string } }).error.code).toBe("CONFIG_INVALID");
    }
    expect((await w.post(WEB, "", as(cookie))).status).toBe(400);
    expect(w.forwarded()).toHaveLength(0);
  });
  it("a project name no project route takes is not forwarded", async () => {
    const w = setUp();
    const cookie = await admin(w);
    for (const name of ["-x", "a%2Fb", "p".repeat(101)]) expect((await w.post(`/v1/web/projects/${name}/setup-agent/eval-confirm`, confirm, as(cookie))).status).toBe(501);
    expect(w.calls).toHaveLength(0);
  });
});

describe("Code's answer comes back as is", () => {
  it("501 NOT_ON_CODE_YET, until Code serves the route", async () => {
    const w = setUp(() => json(501, NOT_ON_CODE));
    expect(await w.post(WEB, confirm, as(await admin(w)))).toEqual({ status: 501, body: NOT_ON_CODE });
  });
  it("Code's fixed unknown-route 404 (a Code that does not serve the route yet) reads 501 NOT_ON_CODE_YET; Code's other 404s are its own (mutant: the route-not-found match)", async () => {
    const w = setUp(() => json(404, { error: { code: "NOT_FOUND", message: "route not found" } }));
    const answer = await w.post(WEB, confirm, as(await admin(w)));
    expect(answer.status).toBe(501);
    expect(answer.body).toMatchObject({ error: { code: "NOT_ON_CODE_YET" } });
    const other = setUp(() => json(404, { error: { code: "NOT_FOUND", message: "There is no eval report for that setup run." } }));
    expect(await other.post(WEB, confirm, as(await admin(other)))).toEqual({ status: 404, body: { error: { code: "NOT_FOUND", message: "There is no eval report for that setup run." } } });
  });
  it("Code's own refusals (its live role re-check, a missing task)", async () => {
    for (const [status, body] of [[403, { error: { code: "FORBIDDEN", message: "not a maintainer" } }], [404, { error: { code: "TASK_NOT_FOUND", message: "no such task" } }]] as const) {
      const w = setUp(() => json(status, body));
      expect(await w.post(WEB, confirm, as(await maintainer(w)))).toEqual({ status, body });
    }
  });
});

describe("contract v0", () => {
  it("lists the route as Code's, answered by cloud-server today", () => {
    const row = APP_ROUTES.find((route) => route.method === "POST" && route.path === "/v1/app/projects/{p}/setup-agent/eval-confirm");
    expect(row).toMatchObject({ owner: "code", screen: "later", codeRoutes: [], source: "setup-agent", cloudServerToday: true });
  });
});
