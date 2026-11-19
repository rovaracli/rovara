// L4-EVC (DEC 254zzz20 D5, D6, D8): the setup flow's ONE eval card through Cloud's handler. Code serves four hosted routes (setup-run-routes.ts); Cloud forwards each to Code's own
// path as the signed-in person (their own bearer token), the same way as eval-confirm: only a company owner or admin, or the project's maintainer, may POST (the read is open to anyone in the
// company; Code decides `canApprove`), only an object body, only each route's own keys (nothing that names a company, a role or a payer), Code's fixed unknown-route 404 reads 501 NOT_ON_CODE_YET,
// and there is no step-up (owner DEC 254zzz73): Cloud adds no REAUTH_REQUIRED answer of its own.
import { describe, expect, it } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest, type CodeSession } from "../../packages/cloud-server/src/index.js";
import { EVAL_APPROVE_KEYS, EVAL_DECIDE_KEYS, EVAL_HEALTH_KEYS, EVAL_WRAPPER_KEYS } from "../../packages/cloud-server/src/routes.js";
import { APP_ROUTES } from "../../packages/contracts/src/code-contract-v0.js";

const CODE = "https://code.example.test";
const ADA = "a".repeat(64), PAM = "b".repeat(64), DEV = "c".repeat(64), BOB = "d".repeat(64);
const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa", OTHER = "org_bbbbbbbbbbbbbbbbbbbb";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const NO_ROUTE = { error: { code: "NOT_FOUND", message: "route not found" } };
const UUID = "6f9d0c1e-2b3a-4c5d-8e7f-001122334455";
const APPROVE = { taskId: UUID, reportDigest: "d".repeat(64), selection: "npm test", paths: ["evals/a.yaml"], approve: true, seen: { perCheckHighMicros: 1_500_000, monthlyCapMicros: 40_000_000 } };
const DECIDE = { requestId: `eval-${"a".repeat(40)}-3`, outcome: "approve", seen: { revision: 3, artifactDigest: "e".repeat(64) } };
const HEALTH = { requestId: UUID, seenCostMicros: 2_400_000 };
const WRAPPER = { requestId: UUID, action: "open_pull_request", selection: "npm test" };
const CHECK = { requestId: UUID, action: "check" };
const TAILS = { get: "eval", approve: "eval-approve", decide: "eval-decide", health: "eval-health", wrapper: "eval-wrapper" } as const;
const codePath = (tail: string, project = "payments") => `/v1/app/projects/${project}/setup-agent/${tail}`;
const webPath = (tail: string, project = "payments") => `/v1/web/projects/${project}/setup-agent/${tail}`;

interface CodeCall { method: string; path: string; search: string; authorization: string | undefined; headers: Record<string, string>; body: unknown }
type Answer = (call: CodeCall) => Response;
function setUp(answer: Answer = (call) => json(200, { from: call.authorization, path: call.path })) {
  const calls: CodeCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    const call: CodeCall = { method: init?.method ?? "GET", path: url.pathname, search: url.search, authorization: headers["authorization"], headers, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (url.pathname === "/v1/auth/token") return json(400, { error: "invalid_grant" });
    if (/\/setup-agent\/eval(?:-approve|-decide|-health|-wrapper)?$/u.test(url.pathname)) return answer(call);
    return json(404, NO_ROUTE);
  }) as typeof fetch;
  const store = new LocalSessionStore(undefined, { environment: {} });
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "projects:members", fetch: fetchImpl });
  const handler = createCloudHandler({
    client, store, work: new LocalWorkSessionStore(), origin: "https://cloud.example.test", org: { orgId: "acme", name: "Acme", plan: "test" },
    callbackPath: "/callback", secureCookies: true, log: () => undefined, now: () => new Date(Date.UTC(2026, 10, 18)),
  });
  const signIn = async (token: string, access: CodeSession["access"]) => {
    await store.create(`cookie-${token}`, { accessToken: token, refreshToken: `r-${token}`, csrf: "csrf", signedInAt: "2026-11-18T00:00:00.000Z", access });
    return { cookie: `rovara_cloud_session=cookie-${token}`, "x-rovara-csrf": "csrf" };
  };
  const send = async (method: "GET" | "POST", target: string, headers: Record<string, string> = {}, body?: unknown) => {
    const url = new URL(target, "http://127.0.0.1:8787");
    const request: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) };
    const answered = await handler(request);
    return { status: answered!.status, body: JSON.parse(answered!.body) as unknown, text: answered!.body, headers: answered!.headers };
  };
  const toCode = () => calls.filter((call) => /\/setup-agent\/eval/u.test(call.path));
  return { signIn, send, calls, toCode };
}
type W = ReturnType<typeof setUp>;
const admin = (w: W) => w.signIn("ada-token", { developerId: ADA, displayName: "Ada", administrator: false, companyId: COMPANY, companyRole: "admin", projects: [], notices: [] });
const owner = (w: W) => w.signIn("own-token", { developerId: ADA, displayName: "Own", administrator: false, companyId: COMPANY, companyRole: "owner", projects: [], notices: [] });
const maintainer = (w: W) => w.signIn("pam-token", { developerId: PAM, displayName: "Pam", administrator: false, companyId: COMPANY, companyRole: "member", projects: [{ name: "payments", access: "administrator" }], notices: [] });
const member = (w: W) => w.signIn("dev-token", { developerId: DEV, displayName: "Dev", administrator: false, companyId: COMPANY, companyRole: "member", projects: [{ name: "payments", access: "developer" }, { name: "other", access: "administrator" }], notices: [] });
const posts: Array<[keyof typeof TAILS, unknown]> = [["approve", APPROVE], ["decide", DECIDE], ["health", HEALTH], ["wrapper", WRAPPER]];
const REFUSED = { status: 403, body: { error: { code: "FORBIDDEN", message: "Only a company owner, admin or project maintainer can answer for the eval's spend." } } };

describe("each route is forwarded to Code's own path as the signed-in person", () => {
  it("GET eval: the exact path, the person's own token, no body, no query", async () => {
    const w = setUp();
    const res = await w.send("GET", `${webPath("eval")}?company=${OTHER}&x=1`, await admin(w));
    expect(res.status).toBe(200);
    expect(w.toCode().map((call) => [call.method, call.path, call.search, call.authorization, call.body])).toEqual([["GET", codePath("eval"), "", "Bearer ada-token", undefined]]);
  });
  for (const [name, body] of posts) {
    it(`POST ${TAILS[name]}: a company admin and the project's maintainer reach Code with their own token and exactly the body`, async () => {
      const w = setUp();
      expect((await w.send("POST", webPath(TAILS[name]), await admin(w), body)).status).toBe(200);
      expect((await w.send("POST", webPath(TAILS[name]), await maintainer(w), body)).status).toBe(200);
      expect((await w.send("POST", webPath(TAILS[name]), await owner(w), body)).status).toBe(200);
      expect(w.toCode().map((call) => [call.method, call.path, call.authorization, call.body])).toEqual([
        ["POST", codePath(TAILS[name]), "Bearer ada-token", body], ["POST", codePath(TAILS[name]), "Bearer pam-token", body], ["POST", codePath(TAILS[name]), "Bearer own-token", body],
      ]);
    });
  }
  it("Code's answer comes back whole, and the answer is never cached", async () => {
    const w = setUp((call) => json(200, { project: "payments", state: "propose", marker: call.authorization }));
    const ada = await admin(w);
    const first = await w.send("GET", webPath("eval"), ada);
    expect(first.body).toEqual({ project: "payments", state: "propose", marker: "Bearer ada-token" });
    expect(first.headers?.["cache-control"]).toBe("no-store");
    await w.send("GET", webPath("eval"), ada);
    expect(w.toCode()).toHaveLength(2);
  });
});

describe("who may ask", () => {
  for (const [name, body] of posts) {
    it(`POST ${TAILS[name]}: a plain member (a developer here, a maintainer elsewhere) is refused 403 and Code is never called`, async () => {
      const w = setUp();
      expect(await w.send("POST", webPath(TAILS[name]), await member(w), body)).toMatchObject(REFUSED);
      expect(w.calls).toHaveLength(0);
    });
    it(`POST ${TAILS[name]}: Code's install administrator who is a plain member of the company is refused`, async () => {
      const w = setUp();
      const cookie = await w.signIn("inst-token", { developerId: DEV, displayName: "Inst", administrator: true, companyId: COMPANY, companyRole: "member", projects: [], notices: [] });
      expect((await w.send("POST", webPath(TAILS[name]), cookie, body)).status).toBe(403);
      expect(w.calls).toHaveLength(0);
    });
    it(`POST ${TAILS[name]}: a person Code names no company for gets NO_COMPANY, no session is 401, a bad CSRF token is 403`, async () => {
      const w = setUp();
      const none = await w.signIn("none-token", { developerId: DEV, displayName: "None", administrator: true, projects: [{ name: "payments", access: "administrator" }], notices: [] });
      expect(await w.send("POST", webPath(TAILS[name]), none, body)).toMatchObject({ status: 403, body: { error: { code: "NO_COMPANY" } } });
      expect((await w.send("POST", webPath(TAILS[name]), {}, body)).status).toBe(401);
      const wrong = await w.send("POST", webPath(TAILS[name]), { cookie: (await admin(w)).cookie, "x-rovara-csrf": "wrong" }, body);
      expect(wrong).toMatchObject({ status: 403, body: { error: { code: "CSRF_INVALID" } } });
      expect(w.calls).toHaveLength(0);
    });
  }
  it("POST eval-wrapper: a plain member may ask only for Check now (a read of the default branch); every other act is refused 403 and Code is never called for it", async () => {
    const w = setUp();
    const cookie = await member(w);
    for (const body of [WRAPPER, { requestId: UUID, action: "dismiss" }, { requestId: UUID, action: "reopen" }, { requestId: UUID, action: "merge" }, { requestId: UUID }]) {
      expect(await w.send("POST", webPath("eval-wrapper"), cookie, body), JSON.stringify(body)).toMatchObject(REFUSED);
    }
    expect(w.calls).toHaveLength(0);
    expect((await w.send("POST", webPath("eval-wrapper"), cookie, { ...CHECK, company: OTHER, extra: 1 })).status).toBe(200);
    expect(w.toCode().map((call) => [call.method, call.path, call.body])).toEqual([["POST", codePath("eval-wrapper"), CHECK]]);
    expect(w.toCode().map((call) => call.authorization)).toEqual(["Bearer dev-token"]);
  });
  it("GET eval: a plain member of the company may read the card (Code decides canApprove); a person with no company may not", async () => {
    const w = setUp();
    expect((await w.send("GET", webPath("eval"), await member(w))).status).toBe(200);
    expect(w.toCode().map((call) => call.authorization)).toEqual(["Bearer dev-token"]);
    const none = await w.signIn("none-token", { developerId: DEV, displayName: "None", administrator: true, projects: [], notices: [] });
    expect(await w.send("GET", webPath("eval"), none)).toMatchObject({ status: 403, body: { error: { code: "NO_COMPANY" } } });
    expect(w.toCode()).toHaveLength(1);
  });
  it("a project name no project route takes is not forwarded", async () => {
    const w = setUp();
    const cookie = await admin(w);
    for (const name of ["-x", "a%2Fb", "p".repeat(101)]) {
      expect((await w.send("GET", webPath("eval", name), cookie)).status).toBe(501);
      for (const [tail, body] of [["eval-approve", APPROVE], ["eval-decide", DECIDE], ["eval-health", HEALTH]] as const) expect((await w.send("POST", webPath(tail, name), cookie, body)).status).toBe(501);
    }
    expect(w.toCode()).toHaveLength(0);
  });
});

describe("the body", () => {
  it("names each route's own keys and nothing else", () => {
    expect([...EVAL_APPROVE_KEYS]).toEqual(["taskId", "reportDigest", "selection", "paths", "approve", "seen"]);
    expect([...EVAL_DECIDE_KEYS]).toEqual(["requestId", "outcome", "seen"]);
    expect([...EVAL_HEALTH_KEYS]).toEqual(["requestId", "seenCostMicros"]);
    expect([...EVAL_WRAPPER_KEYS]).toEqual(["requestId", "action", "selection"]);
  });
  const extra = { company: OTHER, companyId: OTHER, role: "owner", payer: "someone", approver: "x", maxCostMicros: 1, __proto__x: 1 };
  for (const [name, body] of posts) {
    it(`POST ${TAILS[name]}: any other key is dropped, at the top and inside seen`, async () => {
      const w = setUp();
      const seen = (body as { seen?: object }).seen;
      const noisy = { ...body as object, ...extra, ...(seen === undefined ? {} : { seen: { ...seen, company: OTHER, role: "owner", payer: "x" } }) };
      expect((await w.send("POST", webPath(TAILS[name]), await admin(w), noisy)).status).toBe(200);
      expect(w.toCode()[0]!.body).toEqual(body);
      expect(JSON.stringify(w.toCode()[0]!.body)).not.toContain(OTHER);
    });
    it(`POST ${TAILS[name]}: a body that is not an object is refused 400 CONFIG_INVALID and Code is never called`, async () => {
      const w = setUp();
      const cookie = await admin(w);
      for (const bad of [[], ["x"], "text", 5, null, true, ""]) {
        const res = await w.send("POST", webPath(TAILS[name]), cookie, typeof bad === "string" ? bad : bad);
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ error: { code: "CONFIG_INVALID" } });
      }
      expect(w.toCode()).toHaveLength(0);
    });
  }
  it("a key the browser leaves out is not invented; a seen that is not an object goes to Code as sent (Code refuses it)", async () => {
    const w = setUp();
    const cookie = await admin(w);
    await w.send("POST", webPath("eval-decide"), cookie, { requestId: DECIDE.requestId });
    await w.send("POST", webPath("eval-approve"), cookie, { ...APPROVE, seen: "1500000" });
    expect(w.toCode()[0]!.body).toEqual({ requestId: DECIDE.requestId });
    expect(w.toCode()[1]!.body).toEqual({ ...APPROVE, seen: "1500000" });
  });
});

describe("Code's answer", () => {
  const routes: Array<[string, "GET" | "POST", unknown]> = [["eval", "GET", undefined], ["eval-approve", "POST", APPROVE], ["eval-decide", "POST", DECIDE], ["eval-health", "POST", HEALTH], ["eval-wrapper", "POST", WRAPPER]];
  for (const [tail, method, body] of routes) {
    it(`${method} ${tail}: Code's fixed unknown-route 404 reads 501 NOT_ON_CODE_YET; Code's other 404s are its own (mutant: the route-not-found match)`, async () => {
      const w = setUp(() => json(404, NO_ROUTE));
      const answer = await w.send(method, webPath(tail), await admin(w), body);
      expect(answer.status).toBe(501);
      expect(answer.body).toMatchObject({ error: { code: "NOT_ON_CODE_YET" } });
      const other = setUp(() => json(404, { error: { code: "NOT_FOUND", message: "project not found" } }));
      expect(await other.send(method, webPath(tail), await admin(other), body)).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND", message: "project not found" } } });
      const off = setUp(() => json(404, { error: { code: "NOT_FOUND", message: "Approving an eval's spend isn't available on this install yet." } }));
      expect((await off.send(method, webPath(tail), await admin(off), body)).status).toBe(501);
      const noHost = setUp(() => json(404, { error: { code: "NOT_FOUND", message: "Setting up the file Rovara needs to read your eval isn't available on this install yet." } }));
      expect((await noHost.send(method, webPath(tail), await admin(noHost), body)).status).toBe(501);
    });
  }
  for (const [tail, body] of [["eval-approve", APPROVE], ["eval-decide", DECIDE]] as const) {
    it(`POST ${tail}: Code's refusals (the wrong role among them) pass as they are; Cloud has no step-up answer of its own`, async () => {
      for (const [status, refusal] of [[403, { error: { code: "FORBIDDEN", message: "not a maintainer" } }], [409, { error: { code: "CHANGE_STALE", message: "moved" } }], [400, { error: { code: "CONFIG_INVALID", message: "seen: wrong" } }]] as const) {
        const other = setUp(() => json(status, refusal));
        expect(await other.send("POST", webPath(tail), await maintainer(other), body)).toMatchObject({ status, body: refusal });
      }
    });
  }
});

describe("two companies", () => {
  it("each person's request carries only their own token and the project in the path; a company named in a header, query or body never reaches Code; Code's answer for one is never the other's", async () => {
    const w = setUp((call) => json(200, { project: "payments", state: call.authorization === "Bearer ada-token" ? "propose" : "approved", canApprove: true }));
    const ada = await admin(w);
    const bob = await w.signIn("bob-token", { developerId: BOB, displayName: "Bob", administrator: false, companyId: OTHER, companyRole: "admin", projects: [], notices: [] });
    const hint = { "x-rovara-company": OTHER, "x-company-id": OTHER };
    const first = await w.send("GET", `${webPath("eval")}?company=${OTHER}`, { ...ada, ...hint });
    const second = await w.send("GET", webPath("eval"), bob);
    const again = await w.send("GET", webPath("eval"), ada);
    expect((first.body as { state: string }).state).toBe("propose");
    expect((second.body as { state: string }).state).toBe("approved");
    expect((again.body as { state: string }).state).toBe("propose");
    expect(w.toCode().map((call) => [call.authorization, call.path, call.search])).toEqual([["Bearer ada-token", codePath("eval"), ""], ["Bearer bob-token", codePath("eval"), ""], ["Bearer ada-token", codePath("eval"), ""]]);
    for (const call of w.calls) { expect(JSON.stringify(call.headers)).not.toContain(OTHER); expect(call.search).not.toContain(OTHER); }
    await w.send("POST", `${webPath("eval-health")}?company=${OTHER}`, { ...ada, ...hint }, { ...HEALTH, company: OTHER });
    const sent = w.toCode().at(-1)!;
    expect(sent).toMatchObject({ authorization: "Bearer ada-token", body: HEALTH, search: "" });
    expect(JSON.stringify(sent.headers)).not.toContain(OTHER);
  });
  it("a person of company B who holds no entry for the project, and is a plain member there, is refused on every POST without reaching Code", async () => {
    const w = setUp();
    const cookie = await w.signIn("bobm-token", { developerId: BOB, displayName: "Bob", administrator: false, companyId: OTHER, companyRole: "member", projects: [], notices: [] });
    for (const [name, body] of posts) expect((await w.send("POST", webPath(TAILS[name]), cookie, body)).status).toBe(403);
    expect(w.calls).toHaveLength(0);
  });
});

describe("contract v0", () => {
  it("lists the five routes as Code's, answered by cloud-server today", () => {
    for (const [method, tail] of [["GET", "eval"], ["POST", "eval-approve"], ["POST", "eval-decide"], ["POST", "eval-health"], ["POST", "eval-wrapper"]] as const) {
      const row = APP_ROUTES.find((route) => route.method === method && route.path === `/v1/app/projects/{p}/setup-agent/${tail}`);
      expect(row, tail).toMatchObject({ owner: "code", screen: "later", codeRoutes: [], source: "setup-agent", cloudServerToday: true });
    }
  });
});
