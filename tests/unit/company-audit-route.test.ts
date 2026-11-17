// GET /v1/app/company/audit (plan v3.2 7.5) through Cloud's handler: admin only (Code's access check now, not the sign-in's copy), this company's records only, Cloud's records
// merged with the engine records Code serves as the signed-in person, and a plain marker when Code does not serve them yet.
import { describe, expect, it } from "vitest";
import { CodeClient, LocalCloudAuditStore, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudAuditRecord, type CloudAuditStore, type CloudRequest, type CodeSession } from "../../packages/cloud-server/src/index.js";
import type { CompanyAuditPage } from "../../packages/contracts/src/code-contract-v0.js";

const CODE = "https://code.example.test";
const ADA = "a".repeat(64);
const GRACE = "f".repeat(64);
/** Companies as Code names them (DEC 253z). */
const ACME = "org_acme0000000000000000";
const GLOBEX = "org_globex00000000000000";
const BASE = Date.UTC(2026, 10, 14, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

interface CodeCall { path: string; search: URLSearchParams; authorization: string | undefined }
type AuditBehavior = (call: CodeCall) => Response | Promise<Response>;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let counter = 0;
const cloudRow = (companyId: string, atMs: number, over: Partial<CloudAuditRecord> = {}): CloudAuditRecord => ({
  id: `aud_${String(counter++).padStart(20, "0")}`, companyId, at: iso(atMs), actor: { developerId: ADA, name: "Ada", type: "person" }, action: "company.rules.changed", subject: "", outcome: "ok", via: "web", ...over,
});
const engineJson = (atMs: number, n: number, over: Record<string, unknown> = {}) => ({
  eventId: `ev_${String(n).padStart(4, "0")}`, at: iso(atMs), actor: { developerId: GRACE, name: "Grace", type: "person" }, action: "task.approved", subject: "task:t1", outcome: "ok", via: "slack", ...over,
});

function setUp(options: { audit?: CloudAuditStore | null; behavior?: AuditBehavior; org?: string } = {}) {
  const calls: CodeCall[] = [];
  const behavior: AuditBehavior = options.behavior ?? (() => json(404, { error: { code: "NOT_FOUND", message: "route not found" } }));
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
    if (url.pathname === "/v1/dev/access") {
      // Ada is an administrator in Code; Grace is not; "stale" is Ada's sign-in after Code removed her administrator role.
      const who = authorization === "Bearer ada-token" ? { developerId: ADA, displayName: "Ada", administrator: true } : authorization === "Bearer grace-token" ? { developerId: GRACE, displayName: "Grace", administrator: false } : { developerId: ADA, displayName: "Ada", administrator: false };
      // DEC 253z: the company and the company role decide; Ada's stale sign-in is a plain member now.
      // "install-token": Code's install administrator, a plain member of the company; "owner-token": the company's owner, not an install administrator.
      const role = authorization === "Bearer install-token" ? "member" : authorization === "Bearer owner-token" ? "owner" : who.administrator ? "admin" : "member";
      if (authorization === "Bearer install-token") who.administrator = true;
      const company = { companyId: options.org ?? ACME, companyRole: role };
      return json(200, { ...who, ...company, projects: [], notices: [] });
    }
    // A sign-in Code has ended: its refresh is refused too.
    if (url.pathname === "/v1/auth/token") return json(400, { error: "invalid_grant" });
    if (url.pathname === "/v1/auth/revoke") return json(200, {});
    if (url.pathname === "/v1/dev/client/company/audit/records") {
      const call = { path: url.pathname, search: url.searchParams, authorization };
      calls.push(call);
      return behavior(call);
    }
    return json(404, { error: { code: "NOT_FOUND", message: "route not found" } });
  }) as typeof fetch;
  const store = new LocalSessionStore(undefined, { environment: {} });
  const audit = options.audit === undefined ? new LocalCloudAuditStore() : options.audit ?? undefined;
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "projects:members", fetch: fetchImpl });
  const handler = createCloudHandler({
    client, store, work: new LocalWorkSessionStore(), origin: "https://cloud.example.test", org: { orgId: "rovara", name: "Rovara", plan: "test" },
    callbackPath: "/callback", secureCookies: true, log: () => undefined, now: () => new Date(BASE + 86_400_000), ...(audit === undefined ? {} : { audit }),
  });
  const cookies = new Map<string, string>();
  const signIn = async (token: string, cachedAdministrator: boolean) => {
    if (cookies.has(token)) return cookies.get(token)!;
    const session: CodeSession = { accessToken: token, refreshToken: `r-${token}`, csrf: "csrf", signedInAt: iso(BASE), access: { developerId: token === "grace-token" ? GRACE : ADA, displayName: "x", administrator: cachedAdministrator, projects: [], notices: [] } };
    await store.create(`cookie-${token}`, session);
    cookies.set(token, `rovara_cloud_session=cookie-${token}`);
    return cookies.get(token)!;
  };
  const get = async (target: string, cookie?: string) => {
    const url = new URL(target, "http://127.0.0.1:8787");
    const request: CloudRequest = { method: "GET", path: url.pathname, query: url.searchParams, headers: cookie === undefined ? {} : { cookie } };
    const answer = await handler(request);
    return { status: answer!.status, body: JSON.parse(answer!.body) as Record<string, unknown> & CompanyAuditPage };
  };
  return { get, signIn, calls, audit: audit as LocalCloudAuditStore };
}
const admin = async (world: ReturnType<typeof setUp>) => world.signIn("ada-token", true);

describe("who may read the company audit", () => {
  it("needs a sign-in", async () => {
    const world = setUp();
    expect((await world.get("/v1/web/company/audit")).status).toBe(401);
    expect(world.calls).toHaveLength(0);
  });

  it("refuses a person Code says is not an administrator, before reading anything", async () => {
    let reads = 0;
    const spy: CloudAuditStore = { append: async () => "added", read: async () => { reads += 1; return { rows: [], more: false }; } };
    const world = setUp({ audit: spy, behavior: () => json(200, { records: [] }) });
    const answer = await world.get("/v1/web/company/audit", await world.signIn("grace-token", false));
    expect(answer.status).toBe(403);
    expect(answer.body).toEqual({ error: { code: "FORBIDDEN", message: "Only a company administrator can read the audit." } });
    expect(reads).toBe(0);
    expect(world.calls).toHaveLength(0);
  });

  it("a company admin is the company owner or admin, never Code's install administrator", async () => {
    const world = setUp({ behavior: () => json(200, { records: [] }) });
    expect((await world.get("/v1/web/company/audit", await world.signIn("install-token", true))).status).toBe(403);
    expect(world.calls).toHaveLength(0);
    expect((await world.get("/v1/web/company/audit", await world.signIn("owner-token", false))).status).toBe(200);
  });

  it("asks Code now: a sign-in that still says administrator is refused once Code says otherwise", async () => {
    const world = setUp({ behavior: () => json(200, { records: [] }) });
    const stale = await world.signIn("stale-token", true);
    expect((await world.get("/v1/web/company/audit", stale)).status).toBe(403);
    expect(world.calls).toHaveLength(0);
  });

  it("does not tell a non-administrator that the audit store is missing or that a query is bad", async () => {
    const world = setUp({ audit: null });
    const cookie = await world.signIn("grace-token", false);
    expect((await world.get("/v1/web/company/audit?bogus=1", cookie)).status).toBe(403);
  });

  it("ends the sign-in, as any other route does, when Code answers 401 to the engine read and refuses the refresh", async () => {
    const world = setUp({ behavior: () => json(401, { error: { code: "AUTH_REQUIRED" } }) });
    const cookie = await admin(world);
    const answer = await world.get("/v1/web/company/audit", cookie);
    expect(answer.status).toBe(401);
    expect(answer.body).toEqual({ error: { code: "AUTH_REQUIRED", message: "Your Rovara sign-in ended. Sign in again." } });
    expect((await world.get("/v1/web/company/audit", cookie)).status).toBe(401);
  });

  it("passes on Code's own refusal when Code's audit route refuses an administrator Cloud believed", async () => {
    const world = setUp({ behavior: () => json(403, { error: { code: "FORBIDDEN", message: "only a company administrator can read this" } }) });
    const answer = await world.get("/v1/web/company/audit", await admin(world));
    expect(answer.status).toBe(403);
    expect(answer.body).toEqual({ error: { code: "FORBIDDEN", message: "only a company administrator can read this" } });
  });
});

describe("the merged list", () => {
  it("lists Cloud's records for this company and Code's records, newest first, and asks Code as the person", async () => {
    const world = setUp({
      behavior: () => json(200, { records: [engineJson(BASE + 1000, 1), engineJson(BASE + 3000, 2)], skipped: 0 }),
    });
    const mine = [cloudRow(ACME, BASE + 2000), cloudRow(ACME, BASE + 4000, { action: "hook.start.answered", project: "payments", subject: "task:t9", detail: "over_estimate_limit", outcome: "refused", via: "policy-hook" })];
    await world.audit.append(cloudRow(GLOBEX, BASE + 2500));
    for (const row of mine) await world.audit.append(row);
    const answer = await world.get("/v1/web/company/audit", await admin(world));
    expect(answer.status).toBe(200);
    expect(answer.body.records.map((entry) => entry.id)).toEqual([`cloud:${mine[1]!.id}`, "engine:ev_0002", `cloud:${mine[0]!.id}`, "engine:ev_0001"]);
    expect(answer.body.engine).toEqual({ state: "connected" });
    expect(answer.body.next).toBeUndefined();
    expect(answer.body.records[0]).toEqual({
      id: `cloud:${mine[1]!.id}`, source: "cloud", at: iso(BASE + 4000), actor: { developerId: ADA, name: "Ada", type: "person" }, via: "policy-hook", action: "hook.start.answered",
      subject: "task:t9", project: "payments", outcome: "refused", detail: "over_estimate_limit",
    });
    expect(answer.body.records[1]).toEqual({ id: "engine:ev_0002", source: "engine", at: iso(BASE + 3000), actor: { developerId: GRACE, name: "Grace", type: "person" }, via: "slack", action: "task.approved", subject: "task:t1", outcome: "ok" });
    expect(world.calls).toHaveLength(1);
    expect(world.calls[0]!.authorization).toBe("Bearer ada-token");
    expect(Object.fromEntries(world.calls[0]!.search)).toEqual({ limit: "200" });
  });

  it("passes the filters on to Code and applies them to Cloud's records", async () => {
    const world = setUp({ behavior: () => json(200, { records: [] }) });
    await world.audit.append(cloudRow(ACME, BASE + 1000, { project: "payments" }));
    await world.audit.append(cloudRow(ACME, BASE + 2000, { project: "web" }));
    const from = iso(BASE), to = iso(BASE + 5000);
    const answer = await world.get(`/v1/web/company/audit?from=${from}&to=${to}&person=${ADA}&project=payments&action=company.*`, await admin(world));
    expect(answer.body.records).toHaveLength(1);
    expect(answer.body.records[0]!.project).toBe("payments");
    expect(Object.fromEntries(world.calls[0]!.search)).toEqual({ from, to, person: ADA, project: "payments", action: "company.*", limit: "200" });
  });

  it("pages through the list with the cursor it hands back, across both sources", async () => {
    const engineRows = [engineJson(BASE + 1500, 1), engineJson(BASE + 2500, 2)];
    const world = setUp({ behavior: (call) => json(200, { records: engineRows.filter((row) => call.search.get("to") === null || Date.parse(row.at) <= Date.parse(call.search.get("to")!)) }) });
    const rows = [cloudRow(ACME, BASE + 1000), cloudRow(ACME, BASE + 2000), cloudRow(ACME, BASE + 3000)];
    for (const row of rows) await world.audit.append(row);
    const cookie = await admin(world);
    const first = await world.get("/v1/web/company/audit?limit=2", cookie);
    expect(first.body.records.map((entry) => entry.id)).toEqual([`cloud:${rows[2]!.id}`, "engine:ev_0002"]);
    expect(first.body.next).toBeDefined();
    const second = await world.get(`/v1/web/company/audit?limit=2&cursor=${first.body.next!}`, cookie);
    expect(second.body.records.map((entry) => entry.id)).toEqual([`cloud:${rows[1]!.id}`, "engine:ev_0001"]);
    const third = await world.get(`/v1/web/company/audit?limit=2&cursor=${second.body.next!}`, cookie);
    expect(third.body.records.map((entry) => entry.id)).toEqual([`cloud:${rows[0]!.id}`]);
    expect(third.body.next).toBeUndefined();
    expect(Date.parse(world.calls[1]!.search.get("to")!)).toBe(BASE + 2500);
  });
});

describe("one company", () => {
  it("shows each company only its own records, and the company is Code's answer, never the query's", async () => {
    const acme = setUp({ behavior: () => json(200, { records: [] }) });
    const mine = cloudRow(ACME, BASE + 1000), theirs = cloudRow(GLOBEX, BASE + 2000);
    await acme.audit.append(mine);
    await acme.audit.append(theirs);
    const answer = await acme.get("/v1/web/company/audit", await admin(acme));
    expect(answer.body.records.map((entry) => entry.id)).toEqual([`cloud:${mine.id}`]);
    for (const param of ["company=globex", "companyId=globex", "orgId=globex", "org=globex"]) {
      const refused = await acme.get(`/v1/web/company/audit?${param}`, await admin(acme));
      expect(refused.status, param).toBe(400);
      expect(JSON.stringify(refused.body)).not.toContain(theirs.id);
    }
    expect(acme.calls).toHaveLength(1);
  });

  it("reads under the company Code names for the person: the same store read as another company shows that company's records", async () => {
    const shared = new LocalCloudAuditStore();
    const row = cloudRow(GLOBEX, BASE);
    await shared.append(row);
    await shared.append(cloudRow(ACME, BASE + 1));
    const globex = setUp({ audit: shared, org: GLOBEX, behavior: () => json(200, { records: [] }) });
    const answer = await globex.get("/v1/web/company/audit", await admin(globex));
    expect(answer.body.records.map((entry) => entry.id)).toEqual([`cloud:${row.id}`]);
  });

  it("refuses a company id that is not valid, rather than reading a partition for it", async () => {
    const world = setUp({ org: "a#b", behavior: () => json(200, { records: [] }) });
    expect((await world.get("/v1/web/company/audit", await admin(world))).body).toEqual({ error: { code: "NO_COMPANY", message: "You're not in a company yet." } });
    expect(world.calls).toHaveLength(0);
  });
});

describe("when Code does not serve the engine records", () => {
  const states: Array<[string, AuditBehavior, string]> = [
    ["a 404 (not mounted yet)", () => json(404, { error: { code: "NOT_FOUND", message: "route not found" } }), "not_connected"],
    ["a 501", () => json(501, { error: { code: "NOT_ON_CODE_YET", message: "x" } }), "not_connected"],
    ["a 500", () => json(500, { error: { code: "X", message: "secret detail" } }), "unavailable"],
    ["a 503", () => json(503, {}), "unavailable"],
    ["a refused request (400)", () => json(400, { error: { code: "CONFIG_INVALID", message: "the query is not valid" } }), "unavailable"],
    ["a network failure", () => { throw new TypeError("fetch failed: ECONNRESET secret detail"); }, "unavailable"],
    ["an answer that is not a page", () => json(200, { nothing: true }), "unavailable"],
    ["an answer that is not JSON", () => new Response("<html>", { status: 200 }), "unavailable"],
    ["a cursor that is not text", () => json(200, { records: [], next: 5 }), "unavailable"],
  ];
  it.each(states)("shows Cloud's own records and the marker after %s", async (_name, behavior, state) => {
    const world = setUp({ behavior });
    const row = cloudRow(ACME, BASE);
    await world.audit.append(row);
    const answer = await world.get("/v1/web/company/audit", await admin(world));
    expect(answer.status).toBe(200);
    expect(answer.body.records.map((entry) => entry.id)).toEqual([`cloud:${row.id}`]);
    expect(answer.body.engine.state).toBe(state);
    expect(answer.body.engine.message).toMatch(/Cloud's own records only/u);
    expect(JSON.stringify(answer.body)).not.toContain("secret detail");
  });

  it("says in words that engine records are not connected yet", async () => {
    const world = setUp();
    const answer = await world.get("/v1/web/company/audit", await admin(world));
    expect(answer.body).toEqual({ records: [], engine: { state: "not_connected", message: "Engine records are not connected yet. This list shows Cloud's own records only." } });
  });

  it("drops engine lines Code sent that are not readable, and keeps the others", async () => {
    const world = setUp({ behavior: () => json(200, { records: [engineJson(BASE + 1000, 1), { eventId: "", at: iso(BASE) }, "text", null, engineJson(BASE + 4000, 4, { eventId: undefined }), engineJson(BASE + 5000, 5, { actor: { developerId: GRACE, name: "" } }), engineJson(BASE + 6000, 6, { eventId: "has a space" }), engineJson(BASE + 2000, 2, { at: "not a time" }), engineJson(BASE + 3000, 3, { via: "Web Page", actor: { developerId: GRACE, name: "Grace", type: "robot" } })] }) });
    const answer = await world.get("/v1/web/company/audit", await admin(world));
    expect(answer.body.records.map((entry) => entry.id)).toEqual(["engine:ev_0003", "engine:ev_0001"]);
    // Rows that could not be read are not hidden by a plain "connected".
    expect(answer.body.engine).toEqual({ state: "incomplete", message: "Some engine records could not be read, so the engine lines shown are not all of them." });
    expect(answer.body.records[0]).toEqual({ id: "engine:ev_0003", source: "engine", at: iso(BASE + 3000), actor: { developerId: GRACE, name: "Grace" }, action: "task.approved", subject: "task:t1", outcome: "ok" });
  });
});

describe("the route's own failures", () => {
  it("answers 503 with fixed words when no audit store is configured, or when it fails", async () => {
    const none = setUp({ audit: null });
    expect((await none.get("/v1/web/company/audit", await admin(none)))).toMatchObject({ status: 503, body: { error: { code: "AUDIT_UNAVAILABLE", message: "The company audit isn't available right now." } } });
    const broken: CloudAuditStore = { append: async () => "added", read: async () => { throw new Error("table password hunter2 down"); } };
    const failing = setUp({ audit: broken });
    const answer = await failing.get("/v1/web/company/audit", await admin(failing));
    expect(answer.status).toBe(503);
    expect(JSON.stringify(answer.body)).not.toContain("hunter2");
  });

  it("answers 400 with fixed words for a query that is not valid, and for a cursor that is not this list's", async () => {
    const world = setUp({ behavior: () => json(200, { records: [] }) });
    const cookie = await admin(world);
    for (const target of ["?limit=0", "?limit=201", "?from=yesterday", "?person=", "?action=Bad", "?cursor=garbage", "?from=2026-11-14T13:00:00Z&to=2026-11-14T12:00:00Z", "?person=a&person=b"]) {
      const answer = await world.get(`/v1/web/company/audit${target}`, cookie);
      expect(answer.status, target).toBe(400);
      expect(answer.body).toEqual({ error: { code: "CONFIG_INVALID", message: "the audit query is not valid" } });
    }
    expect(world.calls).toHaveLength(0);
  });
});
