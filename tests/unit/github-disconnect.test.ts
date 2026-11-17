// Guided onboarding PR 12b: disconnecting a GitHub account from the Connections page (DELETE /v1/app/github/connections/{installationId} -> Code #832
// DELETE /v1/dev/company/github/{id}). A company OWNER with a fresh step-up only, checked by Cloud before Code is asked (Code checks both again); the browser
// names only the installation; another company's installation is "not connected"; refused while projects use its repos (Cloud rebuilds Code's sentence from
// project names it can read); Code's answer is checked; refusals are fixed words. Also: #832's health on the connections read. Two companies throughout.
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CodeClient, GITHUB_WORDS, LocalCompanyStore, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, githubInUseWords, type CloudRequest } from "../../packages/cloud-server/src/index.js";

const CODE = "https://code.example.test";
const ORIGIN = "https://cloud.example.test";
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const START = Date.parse("2026-11-17T12:00:00.000Z");
const NOW_S = Math.floor(START / 1000);
const LEAK = "SENSITIVE-CODE-DETAIL";
const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const id64 = (name: string) => createHash("sha256").update(name).digest("hex");
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: "none" })}.${b64(claims)}.sig`;

interface Person { key: string; developerId: string; companyId: string; role: "owner" | "admin" | "member"; token: string }
const person = (key: string, companyId: string, role: Person["role"], stepUpAge?: number): Person => ({
  key, developerId: id64(key), companyId, role, token: jwt({ sub: key, ...(stepUpAge === undefined ? {} : { step_up_at: NOW_S - stepUpAge, step_up_amr: "passkey" }) }),
});
const NOVA = person("nova", A, "owner", 30);
const NOVA_PLAIN = { ...person("nova", A, "owner"), key: "nova-plain" };
const NOVA_OLD = { ...person("nova", A, "owner", 3600), key: "nova-old" };
const ADA = person("ada", A, "admin", 30);
const MAX = person("max", A, "member", 30);
const BOB = person("bob", B, "owner", 30);
const PEOPLE = [NOVA, NOVA_PLAIN, NOVA_OLD, ADA, MAX, BOB];

function world() {
  // The pretend Code (#832's rule): each installation belongs to one company; in use while a project of that company holds one of its repos.
  const installations = new Map<number, { company: string; login: string; type: "Organization" | "User"; status: string }>([[11, { company: A, login: "acme", type: "Organization", status: "active" }], [12, { company: A, login: "acme-old", type: "User", status: "suspended" }], [21, { company: B, login: "beta", type: "Organization", status: "active" }]]);
  const inUse = new Map<number, string[]>([[11, ["web", "api"]]]);
  const calls: Array<{ method: string; path: string; search: string; token?: string; body?: unknown }> = [];
  const overrides = new Map<string, () => Response>();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const token = (init?.headers as Record<string, string> | undefined)?.authorization?.replace(/^Bearer /u, "");
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname, search: url.search, ...(token === undefined ? {} : { token }), ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}) });
    const who = PEOPLE.find((one) => one.token === token);
    if (who === undefined) return respond(401, { error: { code: "AUTH_REQUIRED" } });
    if (url.pathname === "/v1/dev/access") return respond(200, { developerId: who.developerId, displayName: who.key, administrator: false, projects: [], notices: [], companyId: who.companyId, companyRole: who.role });
    const override = overrides.get(`${method} ${url.pathname}`);
    if (override !== undefined) return override();
    if (url.pathname === "/v1/dev/company/github" && method === "GET") {
      return respond(200, { installations: [...installations].filter(([, row]) => row.company === who.companyId).map(([installationId, row]) => ({ installationId, accountLogin: row.login, status: row.status, accountType: row.type, connectedAt: new Date(START).toISOString(), connectedBy: { kind: "person", personId: who.developerId, name: who.key } })) });
    }
    const match = /^\/v1\/dev\/company\/github\/([^/]+)$/u.exec(url.pathname);
    if (match !== null && method === "DELETE") {
      if (who.role !== "owner") return respond(403, { error: { code: "FORBIDDEN", message: `${LEAK} owner` } });
      const id = Number(match[1]), row = installations.get(id);
      if (row === undefined || row.company !== who.companyId) return respond(404, { error: { code: "NOT_FOUND", message: `${LEAK} not yours` } });
      const using = inUse.get(id);
      if (using !== undefined) return respond(409, { error: { code: "GITHUB_IN_USE", message: githubInUseWords(using) } });
      installations.delete(id);
      return respond(200, { status: "disconnected", installationId: id, accountLogin: row.login, uninstallUrl: row.type === "Organization" ? `https://github.com/organizations/${row.login}/settings/installations/${String(id)}` : `https://github.com/settings/installations/${String(id)}` });
    }
    return respond(404, { error: { code: "NOT_FOUND", message: "route not found" } });
  }) as typeof fetch;
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: `${ORIGIN}/callback`, scopes: "", fetch: fetchImpl });
  const sessions = new LocalSessionStore(undefined, { now: () => START, environment: {} });
  const logs: Array<Record<string, unknown>> = [];
  const handler = createCloudHandler({
    client, store: sessions, org: { orgId: "rovara", name: "Rovara", plan: "cloud" }, callbackPath: "/callback", secureCookies: true, work: new LocalWorkSessionStore(), origin: ORIGIN,
    company: { store: new LocalCompanyStore() }, now: () => new Date(START), log: (event) => { logs.push(event); },
  });
  const signIn = async (who: Person) => {
    const cookie = randomBytes(32).toString("base64url");
    // The stored sign-in says owner of company A for everyone: Cloud must ask Code, never trust this.
    await sessions.create(cookie, { accessToken: who.token, access: { developerId: who.developerId, displayName: who.key, administrator: false, projects: [], notices: [], companyId: A, companyRole: "owner" }, csrf: `csrf-${who.key}`, signedInAt: new Date(START).toISOString() });
    return { who, cookie };
  };
  const api = async (signed: Awaited<ReturnType<typeof signIn>>, method: string, path: string, body?: unknown, csrf = true) => {
    const url = new URL(`/v1/web${path}`, ORIGIN);
    const request: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers: { cookie: `rovara_cloud_session=${signed.cookie}`, ...(csrf ? { "x-rovara-csrf": `csrf-${signed.who.key}` } : {}), "content-type": "application/json" }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) };
    const answer = (await handler(request))!;
    return { status: answer.status, text: answer.body, body: JSON.parse(answer.body) as Record<string, unknown> & { error?: { code: string; message: string } } };
  };
  const deletes = () => calls.filter((call) => call.method === "DELETE");
  return { api, signIn, calls, deletes, overrides, installations, inUse, logs };
}

describe("the connections read carries #832's health", () => {
  it("passes status and account type when they read as Code's words, and leaves them out otherwise", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    expect((await w.api(nova, "GET", "/github/connections")).body).toEqual({ installations: [
      { installationId: 11, accountLogin: "acme", status: "active", accountType: "Organization", connectedAt: new Date(START).toISOString(), connectedBy: { kind: "person", name: "nova" } },
      { installationId: 12, accountLogin: "acme-old", status: "suspended", accountType: "User", connectedAt: new Date(START).toISOString(), connectedBy: { kind: "person", name: "nova" } },
    ] });
    w.overrides.set("GET /v1/dev/company/github", () => respond(200, { installations: [{ installationId: 11, accountLogin: "acme", status: LEAK, accountType: "Robot", connectedAt: new Date(START).toISOString(), connectedBy: { kind: "operator" } }] }));
    const odd = await w.api(nova, "GET", "/github/connections");
    expect(odd.body).toEqual({ installations: [{ installationId: 11, accountLogin: "acme", connectedAt: new Date(START).toISOString(), connectedBy: { kind: "operator" } }] });
    expect(odd.text).not.toContain(LEAK);
  });
});

describe("disconnecting a GitHub account", () => {
  it("an ended sign-in signs the person out (401, the session deleted) and nothing is disconnected", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    w.overrides.set("DELETE /v1/dev/company/github/12", () => respond(401, { error: { code: "AUTH_REQUIRED", message: LEAK } }));
    const answer = await w.api(nova, "DELETE", "/github/connections/12");
    expect(answer.status).toBe(401);
    expect(answer.text).not.toContain(LEAK);
    expect((await w.api(nova, "GET", "/github/connections")).status).toBe(401);
    expect(w.installations.has(12)).toBe(true);
  });

  it("an owner with a fresh step-up disconnects the company's own installation; Code gets only the id in its path and the person's own token", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const answer = await w.api(nova, "DELETE", "/github/connections/12");
    expect(answer).toMatchObject({ status: 200, body: { status: "disconnected", installationId: 12, accountLogin: "acme-old", uninstallUrl: "https://github.com/settings/installations/12" } });
    expect(w.deletes()).toEqual([{ method: "DELETE", path: "/v1/dev/company/github/12", search: "", token: NOVA.token }]);
    expect(w.logs).toContainEqual({ event: "cloud.github_disconnected", developerId: NOVA.developerId, installationId: 12 });
  });

  it("a member, an admin, an owner with no step-up and one with an old step-up are refused before Code is asked", async () => {
    const w = world();
    for (const [who, code, message] of [[MAX, "FORBIDDEN", GITHUB_WORDS.ownerOnly], [ADA, "FORBIDDEN", GITHUB_WORDS.ownerOnly], [NOVA_PLAIN, "REAUTH_REQUIRED", "Confirm it's you again, then try once more."], [NOVA_OLD, "REAUTH_REQUIRED", "Confirm it's you again, then try once more."]] as const) {
      const answer = await w.api(await w.signIn(who), "DELETE", "/github/connections/12");
      expect(answer.status, who.key).toBe(403);
      expect(answer.body.error, who.key).toEqual({ code, message });
    }
    expect(w.deletes()).toEqual([]);
    expect(w.installations.has(12)).toBe(true);
  });

  it("refuses without the CSRF header, a body with any detail, and an id that isn't one, without asking Code", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    expect((await w.api(nova, "DELETE", "/github/connections/12", undefined, false)).status).toBe(403);
    expect((await w.api(nova, "DELETE", "/github/connections/12", { companyId: B })).status).toBe(400);
    for (const id of ["0", "012", "-1", "1e3", "abc", "99999999999999999", "9999999999999999", "12%2F..%2F21"]) {
      expect((await w.api(nova, "DELETE", `/github/connections/${id}`)).body.error, id).toEqual({ code: "NOT_FOUND", message: GITHUB_WORDS.notConnected });
    }
    expect(w.deletes()).toEqual([]);
  });

  it("another company's installation reads 'not connected' in fixed words, and nothing changes", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const answer = await w.api(nova, "DELETE", "/github/connections/21");
    expect(answer).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND", message: GITHUB_WORDS.notConnected } } });
    expect(answer.text).not.toContain(LEAK);
    expect(w.installations.get(21)?.company).toBe(B);
  });

  it("refused while projects use it: Cloud rebuilds the sentence from the project names it can read; anything else gets the sentence without names", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    expect((await w.api(nova, "DELETE", "/github/connections/11")).body).toEqual({ error: { code: "GITHUB_IN_USE", message: githubInUseWords(["web", "api"]) }, projects: ["web", "api"] });
    for (const message of [`${LEAK}`, "Projects still use this GitHub connection: <b>x</b>. Remove its repositories from them first.", "Projects still use this GitHub connection: Web Site. Remove its repositories from them first.",
      "Projects still use this GitHub connection: web, -x. Remove its repositories from them first.", "Projects still use this GitHub connection: web, , api. Remove its repositories from them first.",
      `Projects still use this GitHub connection: ${Array.from({ length: 101 }, (_, n) => `p${String(n)}`).join(", ")}. Remove its repositories from them first.`]) {
      w.overrides.set("DELETE /v1/dev/company/github/11", () => respond(409, { error: { code: "GITHUB_IN_USE", message } }));
      const answer = await w.api(nova, "DELETE", "/github/connections/11");
      expect(answer.body).toEqual({ error: { code: "GITHUB_IN_USE", message: GITHUB_WORDS.inUseUnreadable } });
    }
    expect(w.installations.has(11)).toBe(true);
  });

  it("Code's other refusals read fixed words: step-up, owner, not served, failure", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const cases: Array<[Response, number, string, string]> = [
      [respond(403, { error: { code: "REAUTH_REQUIRED", message: LEAK } }), 403, "REAUTH_REQUIRED", "Confirm it's you again, then try once more."],
      [respond(403, { error: { code: "FORBIDDEN", message: LEAK } }), 403, "FORBIDDEN", GITHUB_WORDS.ownerOnly],
      [respond(404, { error: { code: "NOT_FOUND", message: "route not found" } }), 501, "NOT_ON_CODE_YET", GITHUB_WORDS.notAvailable],
      [respond(404, { error: { code: "SOMETHING_ELSE", message: LEAK } }), 501, "NOT_ON_CODE_YET", GITHUB_WORDS.notAvailable],
      [respond(500, { error: { code: "X", message: LEAK } }), 503, "RUNTIME_UNAVAILABLE", GITHUB_WORDS.disconnectUnavailable],
    ];
    for (const [reply, status, code, message] of cases) {
      w.overrides.set("DELETE /v1/dev/company/github/12", () => reply);
      const answer = await w.api(nova, "DELETE", "/github/connections/12");
      expect({ status: answer.status, error: answer.body.error }).toEqual({ status, error: { code, message } });
      expect(answer.text).not.toContain(LEAK);
    }
  });

  it("an answer that isn't this installation's disconnect, or carries another address to go to, is not confirmed", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    for (const body of [
      { status: "connected", installationId: 12, accountLogin: "acme-old" },
      { status: "disconnected", installationId: 13, accountLogin: "acme-old" },
      { status: "disconnected", installationId: 12, accountLogin: "bad login!" },
      { status: "disconnected", installationId: 12, accountLogin: "acme-old", uninstallUrl: "https://evil.example/settings/installations/12" },
      { status: "disconnected", installationId: 12, accountLogin: "acme-old", uninstallUrl: "https://github.com/settings/installations/13" },
      { status: "disconnected", installationId: 12, accountLogin: "acme-old", uninstallUrl: "javascript:alert(1)" },
    ]) {
      w.overrides.set("DELETE /v1/dev/company/github/12", () => respond(200, body));
      expect((await w.api(nova, "DELETE", "/github/connections/12")).body).toEqual({ error: { code: "RUNTIME_UNAVAILABLE", message: GITHUB_WORDS.disconnectUnavailable } });
    }
  });
});
