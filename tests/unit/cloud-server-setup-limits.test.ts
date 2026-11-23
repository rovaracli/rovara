// SETUP-LIMITS: GET and PUT /v1/web/projects/{p}/setup-agent/limits through Cloud's handler. Cloud forwards each to Code's own path as the signed-in person (their own bearer token); Code is the gate (it decides who may read, who may change,
// what a number may be and whether the revision is current), so Cloud adds no role rule: Code's 403 reaches the page. Only the three named keys go on; Code's answer is rebuilt field by field; Code's unknown-route 404 reads
// 501 NOT_ON_CODE_YET (the card hides); a write of unknown outcome is answered as unknown, never as refused.
import { describe, expect, it } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest, type CodeSession } from "../../packages/cloud-server/src/index.js";
import { setupLimitsBody } from "../../packages/cloud-server/src/setup-limits-routes.js";

const CODE = "https://code.example.test";
const ADA = "a".repeat(64), DEV = "c".repeat(64);
const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const UUID = "6f9d0c1e-2b3a-4c5d-8e7f-001122334455";
const DEFAULTS = { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 };
const MAXIMA = { commands: 120, sameStepTries: 5, wallClockMin: 120, budgetCents: 2000, hostAsks: 10 };
const VIEW = { revision: 2, limits: { commands: 30 }, companyLock: { budgetCents: 250 }, effective: { ...DEFAULTS, commands: 30, budgetCents: 250 }, defaults: DEFAULTS, maxima: MAXIMA };
const NO_ROUTE = { error: { code: "NOT_FOUND", message: "route not found" } };
const PATH = "/v1/app/projects/payments/setup-agent/limits";
const WEB = "/v1/web/projects/payments/setup-agent/limits";
const CHANGE = { requestId: UUID, expectedRevision: 2, limits: { commands: 25 } };

interface CodeCall { method: string; path: string; authorization: string | undefined; body: unknown }
function setUp(answer: (call: CodeCall) => Response | Promise<Response> = () => json(200, VIEW)) {
  const calls: CodeCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const call: CodeCall = { method: init?.method ?? "GET", path: url.pathname, authorization: (init?.headers as Record<string, string> | undefined)?.authorization, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (url.pathname === "/v1/auth/token") return json(400, { error: "invalid_grant" });
    if (url.pathname.startsWith(PATH.slice(0, -"/limits".length)) || url.pathname === PATH) return answer(call);
    return json(404, NO_ROUTE);
  }) as typeof fetch;
  const store = new LocalSessionStore(undefined, { environment: {} });
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "projects:members", fetch: fetchImpl });
  const handler = createCloudHandler({
    client, store, work: new LocalWorkSessionStore(), origin: "https://cloud.example.test", org: { orgId: "acme", name: "Acme", plan: "test" },
    callbackPath: "/callback", secureCookies: true, log: () => undefined, now: () => new Date(Date.UTC(2026, 10, 23)),
  });
  const signIn = async (token: string, access: CodeSession["access"]) => {
    await store.create(`cookie-${token}`, { accessToken: token, refreshToken: `r-${token}`, csrf: "csrf", signedInAt: "2026-11-23T00:00:00.000Z", access });
    return { cookie: `rovara_cloud_session=cookie-${token}`, "x-rovara-csrf": "csrf" };
  };
  const send = async (method: "GET" | "PUT" | "POST", target: string, headers: Record<string, string> = {}, body?: unknown) => {
    const url = new URL(target, "http://127.0.0.1:8787");
    const request: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) };
    const answered = await handler(request);
    return { status: answered!.status, body: JSON.parse(answered!.body) as unknown, text: answered!.body };
  };
  return { signIn, send, calls, toCode: () => calls.filter((call) => call.path === PATH) };
}
type W = ReturnType<typeof setUp>;
const admin = (w: W) => w.signIn("ada-token", { developerId: ADA, displayName: "Ada", administrator: false, companyId: COMPANY, companyRole: "admin", projects: [], notices: [] });
const reader = (w: W) => w.signIn("dev-token", { developerId: DEV, displayName: "Dev", administrator: false, companyId: COMPANY, companyRole: "member", projects: [{ name: "payments", access: "developer" }], notices: [] });
const stray = (w: W) => w.signIn("none-token", { developerId: DEV, displayName: "None", administrator: true, projects: [], notices: [] });
const refusal = (status: number, code: string, message: string) => json(status, { error: { code, message } });

describe("reading the project's setup limits", () => {
  it("forwards the read as the person and gives back the view, rebuilt (an extra field is not passed on)", async () => {
    const w = setUp(() => json(200, { ...VIEW, secret: "x", limits: { commands: 30 } }));
    const res = await w.send("GET", WEB, await reader(w));
    expect(res).toMatchObject({ status: 200, body: VIEW });
    expect(res.text).not.toContain("secret");
    expect(w.toCode()).toMatchObject([{ method: "GET", authorization: "Bearer dev-token" }]);
  });
  it("answers a person in no company with the fixed words and never calls Code", async () => {
    const w = setUp();
    expect((await w.send("GET", WEB, await stray(w))).status).toBe(403);
    expect(w.calls).toHaveLength(0);
  });
  it("refuses a query string and a malformed project name before Code", async () => {
    const w = setUp();
    const cookie = await admin(w);
    expect((await w.send("GET", `${WEB}?x=1`, cookie)).status).toBe(400);
    expect((await w.send("GET", "/v1/web/projects/-bad/setup-agent/limits", cookie)).status).toBe(400);
    expect(w.calls).toHaveLength(0);
  });
  it.each([
    ["a number that is not whole", { ...VIEW, effective: { ...DEFAULTS, commands: 1.5 } }],
    ["a limit that is missing from the full set", { ...VIEW, maxima: { commands: 120 } }],
    ["an unknown limit", { ...VIEW, limits: { speed: 3 } }],
    ["no revision", { ...VIEW, revision: undefined }],
    ["a string number", { ...VIEW, companyLock: { commands: "9" } }],
  ])("reads %s as unreadable, not as the limits", async (_name, body) => {
    const w = setUp(() => json(200, body));
    expect(await w.send("GET", WEB, await admin(w))).toMatchObject({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE" } } });
  });
  it("reads Code's unknown-route 404 and its not-on-the-core 404 as 501 NOT_ON_CODE_YET, and a missing project as the one 404", async () => {
    for (const body of [NO_ROUTE, { error: { code: "NOT_FOUND", message: "That is not on the core engine on this install yet." } }]) {
      const w = setUp(() => json(404, body));
      expect(await w.send("GET", WEB, await admin(w))).toMatchObject({ status: 501, body: { error: { code: "NOT_ON_CODE_YET" } } });
    }
    const w = setUp(() => refusal(404, "NOT_FOUND", "project not found"));
    expect(await w.send("GET", WEB, await admin(w))).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND" } } });
  });
});

describe("changing the project's setup limits", () => {
  it("forwards only the three keys, as the person, and gives back Code's new view", async () => {
    const w = setUp(() => json(200, { ...VIEW, revision: 3, limits: { commands: 25 }, effective: { ...DEFAULTS, commands: 25, budgetCents: 250 } }));
    const res = await w.send("PUT", WEB, await admin(w), CHANGE);
    expect(res).toMatchObject({ status: 200, body: { revision: 3, limits: { commands: 25 } } });
    expect(w.toCode()).toEqual([{ method: "PUT", path: PATH, authorization: "Bearer ada-token", body: CHANGE }]);
  });
  it("does not add a role rule of its own: a plain reader's change goes to Code, and Code's 403 reaches the page in Code's sentence", async () => {
    const w = setUp(() => refusal(403, "FORBIDDEN", "Only company owners and admins, or this project's admins, can change the project's setup limits."));
    const res = await w.send("PUT", WEB, await reader(w), CHANGE);
    expect({ status: res.status, body: res.body }).toEqual({ status: 403, body: { error: { code: "FORBIDDEN", message: "Only company owners and admins, or this project's admins, can change the project's setup limits." } } });
    expect(w.toCode()).toHaveLength(1);
  });
  it.each([
    [409, "CHANGE_STALE", "The limits changed since you looked. Read them again."], [409, "IDEMPOTENCY_CONFLICT", "That request id was already used for different limits."],
    [400, "CONFIG_INVALID", "commands: the company's cap is 20"], [503, "AUDIT_UNAVAILABLE", "The record of this change could not be written, so nothing was done. Try again."],
  ])("passes Code's %s %s on with its sentence", async (status, code, message) => {
    const w = setUp(() => refusal(status, code, message));
    expect(await w.send("PUT", WEB, await admin(w), CHANGE)).toMatchObject({ status, body: { error: { code, message } } });
  });
  it("does not echo a refusal it does not know: another code, or a sentence with a control character, reads as 'not available just now'", async () => {
    for (const [code, message] of [["SECRET_THING", "internal detail"], ["FORBIDDEN", "bad‮text"]] as const) {
      const w = setUp(() => refusal(403, code, message));
      const res = await w.send("PUT", WEB, await admin(w), CHANGE);
      expect(res.status).toBe(503);
      expect(res.text).not.toContain("internal detail");
      expect(res.text).not.toContain("‮");
    }
  });
  it("reads Code's unknown-route 404 as 501 NOT_ON_CODE_YET", async () => {
    const w = setUp(() => json(404, NO_ROUTE));
    expect(await w.send("PUT", WEB, await admin(w), CHANGE)).toMatchObject({ status: 501, body: { error: { code: "NOT_ON_CODE_YET" } } });
  });
  it.each([
    ["an extra key", { ...CHANGE, payer: "x" }], ["a missing key", { requestId: UUID, limits: {} }], ["a bad request id", { ...CHANGE, requestId: "nope" }], ["a negative revision", { ...CHANGE, expectedRevision: -1 }],
    ["an unknown limit", { ...CHANGE, limits: { speed: 1 } }], ["limits that are a list", { ...CHANGE, limits: [] }], ["a body that is a list", [CHANGE]], ["no JSON", "{nope"],
  ])("refuses %s before Code", async (_name, body) => {
    const w = setUp();
    expect((await w.send("PUT", WEB, await admin(w), body)).status).toBe(400);
    expect(w.calls).toHaveLength(0);
  });
  it("answers a change whose outcome is unknown as unknown (never as refused), and passes the same request id on when sent again", async () => {
    let first = true;
    const w = setUp(() => { if (first) { first = false; return new Response("", { status: 200 }); } return json(200, VIEW); });
    const cookie = await admin(w);
    const lost = await w.send("PUT", WEB, cookie, CHANGE);
    expect(lost).toMatchObject({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE" } } });
    expect(lost.text).toContain("outcome is unknown");
    expect((await w.send("PUT", WEB, cookie, CHANGE)).status).toBe(200);
    expect(w.toCode().map((call) => (call.body as { requestId: string }).requestId)).toEqual([UUID, UUID]);
  });
  it("says the change was made, not failed, when Code's answer to it does not read", async () => {
    const w = setUp(() => json(200, { nonsense: true }));
    expect((await w.send("PUT", WEB, await admin(w), CHANGE)).status).toBe(503);
  });
  it("refuses a PUT with no CSRF token before Code", async () => {
    const w = setUp();
    const cookie = await admin(w);
    const res = await w.send("PUT", WEB, { cookie: cookie.cookie }, CHANGE);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(w.calls).toHaveLength(0);
  });
});

describe("the change body", () => {
  it("keeps exactly the three keys", () => {
    expect(setupLimitsBody(CHANGE)).toEqual(CHANGE);
    expect(setupLimitsBody({ ...CHANGE, limits: {} })).toEqual({ ...CHANGE, limits: {} });
    expect(setupLimitsBody(null)).toBeUndefined();
  });
});
