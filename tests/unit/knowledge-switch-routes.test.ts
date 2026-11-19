// L4-JA7, Cloud's half (knowledge-switch-routes.ts): "Knowledge stays in Rovara" (company) and a project's local coding tools setting pass to Code AS THE PERSON. Nothing of the browser's request but the checked
// `{ stays }` / `{ enabled }` and the project name is forwarded (no company, person, role or query); Code's answer is rebuilt in a fixed shape; Code's refusals become Cloud's fixed words and a Code that does not serve the
// routes is "not connected yet" (501 NOT_ON_CODE_YET), which the settings screens hide.
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, KNOWLEDGE_SWITCH_WORDS, createCloudHandler, type CloudRequest } from "../../packages/cloud-server/src/index.js";

const CODE = "https://code.example.test";
const ORIGIN = "https://cloud.example.test";
const START = Date.parse("2026-11-17T12:00:00.000Z");
const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const id64 = (name: string) => createHash("sha256").update(name).digest("hex");
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: "none" })}.${b64(claims)}.sig`;

interface Person { key: string; developerId: string; token: string }
const person = (key: string): Person => ({ key, developerId: id64(key), token: jwt({ sub: key }) });
const NOVA = person("nova"), BOB = person("bob"), ZED = person("zed");

function world() {
  const calls: Array<{ method: string; path: string; search: string; token?: string; body?: string }> = [];
  // Two companies, each with its own switches; Code decides which company a token's person is in and what they may do (Cloud knows neither).
  const store = { stays: new Map<string, boolean>([["A", false], ["B", true]]), own: new Map<string, boolean>() };
  const companyOf = (who: Person): "A" | "B" => (who.key === "zed" ? "B" : "A");
  let override: (() => Response) | undefined;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const token = (init?.headers as Record<string, string> | undefined)?.authorization?.replace(/^Bearer /u, "");
    calls.push({ method: init?.method ?? "GET", path: url.pathname, search: url.search, ...(token === undefined ? {} : { token }), ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (url.pathname === "/v1/auth/token") return respond(400, { error: "invalid_grant" });
    if (override !== undefined) return override();
    const who = [NOVA, BOB, ZED].find((one) => one.token === token);
    if (who === undefined) return respond(401, { error: { code: "AUTH_REQUIRED" } });
    const company = companyOf(who);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, boolean> : {};
    if (url.pathname === "/v1/dev/company/lessons/local-tools") {
      if (who.key === "bob") return respond(403, { error: { code: "FORBIDDEN", message: "SECRET only admins" } });
      if (method === "PUT") store.stays.set(company, body["stays"]!);
      return respond(200, { stays: store.stays.get(company) });
    }
    const project = /^\/v1\/dev\/projects\/([^/]+)\/lessons\/local-tools$/u.exec(url.pathname);
    if (project !== null) {
      if (project[1] === "ghost") return respond(404, { error: { code: "NOT_FOUND", message: "No such project. SECRET" } });
      if (method === "PUT") { if (who.key === "bob") return respond(403, { error: { code: "FORBIDDEN", message: "SECRET" } }); store.own.set(`${company}/${project[1]}`, body["enabled"]!); }
      const own = store.own.get(`${company}/${project[1]}`), stays = store.stays.get(company)!;
      return respond(200, { enabled: !stays && own !== false, ...(own === undefined ? {} : { own }), ...(stays ? { reason: "company_stays" } : own === false ? { reason: "project_setting" } : {}), preset: "standard", companyStays: stays, canChange: who.key !== "bob", extra: "SECRET" });
    }
    return respond(404, { error: { code: "NOT_FOUND", message: "route not found" } });
  }) as typeof fetch;
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: `${ORIGIN}/callback`, scopes: "", fetch: fetchImpl });
  const sessions = new LocalSessionStore(undefined, { now: () => START, environment: {} });
  const logs: Array<Record<string, unknown>> = [];
  const handler = createCloudHandler({
    client, store: sessions, org: { orgId: "rovara", name: "Rovara", plan: "cloud" }, callbackPath: "/callback", secureCookies: true, work: new LocalWorkSessionStore(), origin: ORIGIN,
    now: () => new Date(START), log: (event) => { logs.push(event); },
  });
  const signIn = async (who: Person) => {
    const cookie = randomBytes(32).toString("base64url");
    await sessions.create(cookie, { accessToken: who.token, access: { developerId: who.developerId, displayName: who.key, administrator: false, projects: [], notices: [] }, csrf: `csrf-${who.key}`, signedInAt: new Date(START).toISOString() });
    return { person: who, cookie };
  };
  type Who = Awaited<ReturnType<typeof signIn>>;
  const api = async (who: Who | undefined, method: string, target: string, body?: string, csrf?: string) => {
    const url = new URL(`/v1/web${target}`, ORIGIN);
    const headers: Record<string, string> = who === undefined ? {} : { cookie: `rovara_cloud_session=${who.cookie}`, "x-rovara-csrf": csrf ?? `csrf-${who.person.key}`, "content-type": "application/json" };
    const request: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers, ...(body === undefined ? {} : { body }) };
    const answer = (await handler(request))!;
    return { status: answer.status, body: JSON.parse(answer.body) as Record<string, unknown> & { error?: { code: string; message: string } } };
  };
  const codeCalls = () => calls.filter((call) => call.path.startsWith("/v1/dev/") && call.path.endsWith("/lessons/local-tools"));
  return { api, signIn, calls, codeCalls, store, logs, override: (next: (() => Response) | undefined) => { override = next; } };
}

const COMPANY = "/company/lessons/local-tools";
const PROJECT = "/projects/payments/lessons/local-tools";
describe("the company's switch", () => {
  it("needs a sign-in, reads and sets it as the person, and passes only the checked body", async () => {
    const w = world();
    expect((await w.api(undefined, "GET", COMPANY)).status).toBe(401);
    expect((await w.api(undefined, "PUT", COMPANY, JSON.stringify({ stays: true }))).status).toBe(401);
    expect(w.codeCalls()).toEqual([]);
    const nova = await w.signIn(NOVA);
    expect(await w.api(nova, "GET", COMPANY)).toEqual({ status: 200, body: { stays: false } });
    expect(await w.api(nova, "PUT", COMPANY, JSON.stringify({ stays: true }))).toEqual({ status: 200, body: { stays: true } });
    expect(w.codeCalls()).toEqual([
      { method: "GET", path: "/v1/dev/company/lessons/local-tools", search: "", token: NOVA.token },
      { method: "PUT", path: "/v1/dev/company/lessons/local-tools", search: "", token: NOVA.token, body: JSON.stringify({ stays: true }) },
    ]);
    // Company B (a different person's token) is its own: Cloud names no company.
    expect(w.store.stays.get("B")).toBe(true);
    expect((await w.api(await w.signIn(ZED), "GET", COMPANY)).body).toEqual({ stays: true });
  });

  it("nothing the browser sends names a company or person, and a body with anything else is refused before Code is asked", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    await w.api(nova, "GET", `${COMPANY}?company=B&developerId=${BOB.developerId}`);
    expect(w.codeCalls()).toEqual([]);
    for (const body of [{ stays: true, company: "B" }, { stays: "yes" }, {}, [], "nope", { enabled: true }, { stays: null }]) {
      expect((await w.api(nova, "PUT", COMPANY, JSON.stringify(body))).body, JSON.stringify(body)).toEqual({ error: { code: "CONFIG_INVALID", message: KNOWLEDGE_SWITCH_WORDS.invalid } });
    }
    expect((await w.api(nova, "PUT", `${COMPANY}?x=1`, JSON.stringify({ stays: true }))).status).toBe(400);
    expect((await w.api(nova, "PUT", COMPANY)).body.error?.code).toBe("CONFIG_INVALID");
    expect(w.codeCalls()).toEqual([]);
    expect(w.store.stays.get("A")).toBe(false);
  });

  it("a PUT with no or a wrong CSRF token is refused before Code is asked", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    for (const csrf of ["", "csrf-bob", "wrong"]) expect((await w.api(nova, "PUT", COMPANY, JSON.stringify({ stays: true }), csrf)).status, csrf).toBe(403);
    expect(w.codeCalls()).toEqual([]);
  });

  it("a person Code refuses (not an owner or admin) gets one fixed sentence, never Code's words", async () => {
    const w = world();
    for (const method of ["GET", "PUT"]) {
      const answer = await w.api(await w.signIn(BOB), method, COMPANY, method === "PUT" ? JSON.stringify({ stays: false }) : undefined);
      expect(answer).toEqual({ status: 403, body: { error: { code: "FORBIDDEN", message: KNOWLEDGE_SWITCH_WORDS.companyForbidden } } });
      expect(JSON.stringify(answer)).not.toContain("SECRET");
    }
  });

  it("rebuilds Code's answer as { stays }: extra fields are dropped and a wrong shape is a fixed 503", async () => {
    const w = world();
    w.override(() => respond(200, { stays: true, secret: "S" }));
    expect(await w.api(await w.signIn(NOVA), "GET", COMPANY)).toEqual({ status: 200, body: { stays: true } });
    for (const body of [{}, { stays: "no" }, "words", [], { stays: null }]) {
      const v = world();
      v.override(() => respond(200, body));
      const answer = await v.api(await v.signIn(NOVA), "PUT", COMPANY, JSON.stringify({ stays: true }));
      expect(answer, JSON.stringify(body)).toEqual({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: KNOWLEDGE_SWITCH_WORDS.unavailable } } });
    }
  });
});

describe("a project's setting", () => {
  it("reads and sets it as the person with only the project name in the path and { enabled } in the body", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    expect(await w.api(nova, "GET", PROJECT)).toEqual({ status: 200, body: { enabled: true, preset: "standard", companyStays: false, canChange: true } });
    expect(await w.api(nova, "PUT", PROJECT, JSON.stringify({ enabled: false }))).toEqual({ status: 200, body: { enabled: false, own: false, reason: "project_setting", preset: "standard", companyStays: false, canChange: true } });
    expect(w.codeCalls()).toEqual([
      { method: "GET", path: "/v1/dev/projects/payments/lessons/local-tools", search: "", token: NOVA.token },
      { method: "PUT", path: "/v1/dev/projects/payments/lessons/local-tools", search: "", token: NOVA.token, body: JSON.stringify({ enabled: false }) },
    ]);
    // The same project name in the other company is another switch, decided by Code from the token.
    expect((await w.api(await w.signIn(ZED), "GET", PROJECT)).body).toMatchObject({ enabled: false, reason: "company_stays", companyStays: true });
  });

  it("drops fields Code was not asked for, and leaves out a reason a newer Code added", async () => {
    const w = world();
    w.override(() => respond(200, { enabled: false, reason: "something_new", preset: "standard", companyStays: false, canChange: false, secret: "S" }));
    expect(await w.api(await w.signIn(NOVA), "GET", PROJECT)).toEqual({ status: 200, body: { enabled: false, preset: "standard", companyStays: false, canChange: false } });
  });

  it("a name Code would not accept, a query, or a body with anything else never reaches Code", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    for (const target of ["/projects/../lessons/local-tools", "/projects/a b/lessons/local-tools", "/projects/a%2Fb/lessons/local-tools", `/projects/${"x".repeat(101)}/lessons/local-tools`]) {
      expect((await w.api(nova, "GET", target)).status, target).not.toBe(200);
    }
    expect((await w.api(nova, "GET", `${PROJECT}?project=other`)).status).toBe(400);
    for (const body of [{ enabled: true, project: "other" }, { enabled: "no" }, {}, [], { stays: true }]) {
      expect((await w.api(nova, "PUT", PROJECT, JSON.stringify(body))).body, JSON.stringify(body)).toEqual({ error: { code: "CONFIG_INVALID", message: KNOWLEDGE_SWITCH_WORDS.invalid } });
    }
    expect(w.codeCalls()).toEqual([]);
  });

  it("a person who may not change it gets the project sentence; a project Code does not have is 'project not found'", async () => {
    const w = world();
    expect(await w.api(await w.signIn(BOB), "PUT", PROJECT, JSON.stringify({ enabled: false }))).toEqual({ status: 403, body: { error: { code: "FORBIDDEN", message: KNOWLEDGE_SWITCH_WORDS.projectForbidden } } });
    const ghost = await w.api(await w.signIn(NOVA), "GET", "/projects/ghost/lessons/local-tools");
    expect(ghost).toEqual({ status: 404, body: { error: { code: "NOT_FOUND", message: KNOWLEDGE_SWITCH_WORDS.notFound } } });
    expect(JSON.stringify(ghost)).not.toContain("SECRET");
  });

  it("a wrong shape from Code is a fixed 503", async () => {
    for (const body of [{}, { enabled: "yes", preset: "standard", companyStays: false, canChange: true }, { enabled: true, preset: "weird", companyStays: false, canChange: true }, { enabled: true, preset: "standard", companyStays: false }, { enabled: true, own: "x", preset: "standard", companyStays: false, canChange: true }, "x", []]) {
      const w = world();
      w.override(() => respond(200, body));
      expect(await w.api(await w.signIn(NOVA), "GET", PROJECT), JSON.stringify(body)).toEqual({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: KNOWLEDGE_SWITCH_WORDS.unavailable } } });
    }
  });
});

describe("Code's refusals, both settings", () => {
  it("become Cloud's fixed words; a Code without the routes is 'not connected yet'; Code's own words never pass through", async () => {
    const cases: Array<[Response, number, string, string]> = [
      [respond(404, { error: { code: "NOT_FOUND", message: "route not found" } }), 501, "NOT_ON_CODE_YET", KNOWLEDGE_SWITCH_WORDS.notYet],
      [respond(405, {}), 501, "NOT_ON_CODE_YET", KNOWLEDGE_SWITCH_WORDS.notYet],
      [respond(501, {}), 501, "NOT_ON_CODE_YET", KNOWLEDGE_SWITCH_WORDS.notYet],
      [respond(404, { error: { code: "NOT_FOUND", message: "No such project. SECRET" } }), 404, "NOT_FOUND", KNOWLEDGE_SWITCH_WORDS.notFound],
      [respond(500, { error: { code: "X", message: "SECRET maya@example.test" } }), 503, "RUNTIME_UNAVAILABLE", KNOWLEDGE_SWITCH_WORDS.unavailable],
      [respond(503, { error: { code: "AUDIT_UNAVAILABLE", message: "SECRET ledger" } }), 503, "AUDIT_UNAVAILABLE", KNOWLEDGE_SWITCH_WORDS.noRecord],
      [respond(400, { error: { code: "CONFIG_INVALID", message: "SECRET" } }), 400, "CONFIG_INVALID", KNOWLEDGE_SWITCH_WORDS.invalid],
    ];
    for (const [response, status, code, message] of cases) {
      for (const [target, body] of [[COMPANY, { stays: true }], [PROJECT, { enabled: true }]] as const) {
        const w = world();
        w.override(() => response.clone());
        const answer = await w.api(await w.signIn(NOVA), "PUT", target, JSON.stringify(body));
        expect(answer, `${String(response.status)} ${target}`).toEqual({ status, body: { error: { code, message } } });
        expect(JSON.stringify(answer)).not.toContain("SECRET");
      }
    }
  });
  it("has no other method or path: those stay 501 and never reach Code", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    for (const [method, target] of [["POST", COMPANY], ["DELETE", PROJECT], ["GET", "/company/lessons/local-tools/x"], ["GET", "/projects/payments/lessons/local-tools/x"], ["PUT", "/org/lessons/local-tools"]] as const) {
      expect((await w.api(nova, method, target, method === "GET" ? undefined : "{}")).status, `${method} ${target}`).toBe(501);
    }
    expect(w.codeCalls()).toEqual([]);
  });
});
