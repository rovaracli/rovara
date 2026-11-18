// L4-GH, Cloud's half of "Connect your GitHub" (github-link.ts) on a pretend Rovara Code that keeps Code's rules (a start needs a fresh step-up; a claim needs the single-use state, the same
// sign-in, GitHub's code; first link wins, one account per person). The return arrives at the SAME callback as Connect GitHub, so it is told apart by the cookie's binding (`flow: "link"`):
// it may finish a link only for the browser and sign-in that started it, once, with the state it was started with, and it never reaches the company connect. Fixed words only.
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CodeClient, GITHUB_CALLBACK_PATH, GITHUB_CONNECT_COOKIE, GITHUB_CONNECT_TTL_MS, GITHUB_LINK_WORDS, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, githubStateKey, type CloudRequest, type PendingSignIn } from "../../packages/cloud-server/src/index.js";

const CODE = "https://code.example.test";
const ORIGIN = "https://cloud.example.test";
const REDIRECT = `${ORIGIN}/callback`;
const START = Date.parse("2026-11-17T12:00:00.000Z");
const NOW_S = Math.floor(START / 1000);
const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const id64 = (name: string) => createHash("sha256").update(name).digest("hex");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: "none" })}.${b64(claims)}.sig`;

interface Person { key: string; developerId: string; token: string; github: { id: number; login: string } }
const person = (key: string, github: { id: number; login: string }, stepUpAge?: number): Person => ({ key, developerId: id64(key), github, token: jwt({ sub: key, ...(stepUpAge === undefined ? {} : { step_up_at: NOW_S - stepUpAge, step_up_amr: "passkey" }) }) });
const NOVA = person("nova", { id: 7, login: "nova-dev" }, 30);
const NOVA_STALE = { ...person("nova", { id: 7, login: "nova-dev" }), key: "nova-stale", token: jwt({ sub: "nova-stale" }) };
const BOB = person("bob", { id: 8, login: "bob" }, 30);
const PEOPLE = [NOVA, NOVA_STALE, BOB];
const WORDS = { notSetUp: "Connecting your GitHub account isn't set up on this Rovara yet. Ask the Rovara team." };

function world() {
  let clock = START;
  const calls: Array<{ method: string; path: string; token?: string; body?: Record<string, unknown> }> = [];
  const links = new Map<string, { login: string; githubId: number; at: string }>(); // developerId -> link
  const owners = new Map<number, string>(); // github id -> developerId
  const states = new Map<string, { developerId: string; used: boolean }>();
  const overrides = new Map<string, () => Response | Promise<Response>>();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const token = (init?.headers as Record<string, string> | undefined)?.authorization?.replace(/^Bearer /u, "");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname, ...(token === undefined ? {} : { token }), ...(body === undefined ? {} : { body }) });
    if (url.pathname === "/v1/auth/token") return respond(400, { error: "invalid_grant" });
    const override = overrides.get(`${method} ${url.pathname}`);
    if (override !== undefined) return override();
    const who = PEOPLE.find((one) => one.token === token);
    if (who === undefined) return respond(401, { error: { code: "AUTH_REQUIRED" } });
    const p = url.pathname;
    const fresh = () => /step_up_at/u.test(Buffer.from(token!.split(".")[1]!, "base64url").toString());
    if (p === "/v1/dev/access") return respond(200, { developerId: who.developerId, displayName: who.key, administrator: false, projects: [], notices: [], companyId: "org_aaaaaaaaaaaaaaaaaaaa", companyRole: "member" });
    if (p === "/v1/dev/me/github" && method === "GET") {
      const mine = links.get(who.developerId);
      return respond(200, mine === undefined ? { linked: false } : { linked: true, login: mine.login, linkedAt: mine.at, githubUserId: mine.githubId });
    }
    if (p === "/v1/dev/me/github" && method === "DELETE") return respond(200, { unlinked: links.delete(who.developerId) });
    if (p === "/v1/dev/me/github/link" && method === "POST") {
      if (!fresh()) return respond(403, { error: { code: "REAUTH_REQUIRED", message: "stale" } });
      const state = randomBytes(32).toString("base64url");
      states.set(state, { developerId: who.developerId, used: false });
      return respond(200, { state, expiresAt: new Date(clock + 600_000).toISOString(), authorizeUrl: `https://github.com/login/oauth/authorize?client_id=Iv1.client&state=${state}` });
    }
    if (p === "/v1/dev/me/github/link/claim" && method === "POST") {
      const state = states.get(String(body?.state));
      if (Object.keys(body ?? {}).sort().join() !== "code,state" || state === undefined || state.used || state.developerId !== who.developerId || !fresh()) return respond(403, { error: { code: "FORBIDDEN", message: "Start again from Rovara." } });
      state.used = true;
      const owner = owners.get(who.github.id);
      if (owner !== undefined && owner !== who.developerId) return respond(409, { error: { code: "GITHUB_ACCOUNT_TAKEN", message: "x" } });
      owners.set(who.github.id, who.developerId);
      links.set(who.developerId, { login: who.github.login, githubId: who.github.id, at: new Date(clock).toISOString() });
      return respond(200, { status: "linked", alreadyLinked: false, githubUser: who.github });
    }
    return respond(404, { error: { code: "NOT_FOUND", message: "route not found" } });
  }) as typeof fetch;
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: REDIRECT, scopes: "", fetch: fetchImpl });
  const sessions = new LocalSessionStore(undefined, { now: () => clock, environment: {} });
  const pendingWrites: Array<[string, PendingSignIn]> = [];
  const put = sessions.putPending.bind(sessions);
  sessions.putPending = async (key, value) => { pendingWrites.push([key, structuredClone(value)]); await put(key, value); };
  const logs: Array<Record<string, unknown>> = [];
  const handler = createCloudHandler({
    client, store: sessions, org: { orgId: "rovara", name: "Rovara", plan: "cloud" }, callbackPath: "/callback", secureCookies: true, work: new LocalWorkSessionStore(), origin: ORIGIN,
    now: () => new Date(clock), log: (event) => { logs.push(event); },
  });
  const raw = async (method: string, target: string, headers: Record<string, string> = {}, body?: string) => {
    const url = new URL(target, ORIGIN);
    const request: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers, ...(body === undefined ? {} : { body }) };
    return (await handler(request))!;
  };
  const signIn = async (who: Person) => {
    const cookie = randomBytes(32).toString("base64url");
    await sessions.create(cookie, { accessToken: who.token, access: { developerId: who.developerId, displayName: who.key, administrator: false, projects: [], notices: [] }, csrf: `csrf-${who.key}`, signedInAt: new Date(clock).toISOString() });
    return { person: who, cookie };
  };
  type Who = Awaited<ReturnType<typeof signIn>>;
  const api = async (who: Who, method: string, path: string, body?: unknown, rawBody?: string) => {
    const answer = await raw(method, `/v1/web${path}`, { cookie: `rovara_cloud_session=${who.cookie}`, "x-rovara-csrf": `csrf-${who.person.key}`, "content-type": "application/json" }, rawBody ?? (body === undefined ? undefined : JSON.stringify(body)));
    return { status: answer.status, body: JSON.parse(answer.body) as Record<string, unknown> & { error?: { code: string; message: string } }, headers: answer.headers };
  };
  const codeCalls = (path: string) => calls.filter((call) => call.path === path);
  /** Starts a link: the cookie value the browser holds and the state GitHub will send back. */
  const start = async (who: Who) => {
    const answer = await api(who, "POST", "/me/github/link", {});
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const binder = /rovara_cloud_github=([A-Za-z0-9_-]+);/u.exec(String(answer.headers["set-cookie"]))![1]!;
    const state = new URL(String(answer.body.authorizeUrl)).searchParams.get("state")!;
    return { answer, binder, state };
  };
  const callback = async (query: string, cookies: { binder?: string; session?: string }) => {
    const cookie = [cookies.session === undefined ? undefined : `rovara_cloud_session=${cookies.session}`, cookies.binder === undefined ? undefined : `${GITHUB_CONNECT_COOKIE}=${cookies.binder}`].filter((part) => part !== undefined).join("; ");
    const answer = await raw("GET", `${GITHUB_CALLBACK_PATH}?${query}`, cookie === "" ? {} : { cookie });
    return { status: answer.status, location: answer.headers.location, setCookie: answer.headers["set-cookie"] };
  };
  return { raw, api, signIn, start, callback, calls, codeCalls, logs, pendingWrites, overrides, sessions, links, advance: (ms: number) => { clock += ms; } };
}

const LANDING = "/app/account?github_link=";
const code = "gh-code-1";

describe("start (POST /v1/app/me/github/link)", () => {
  it("asks Code as the person with an empty body, answers only GitHub's address, and binds the browser with an HttpOnly, Secure, SameSite=Lax cookie; the binding says it is a link", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const { answer, binder, state } = await w.start(nova);
    expect(w.codeCalls("/v1/dev/me/github/link")).toEqual([{ method: "POST", path: "/v1/dev/me/github/link", token: NOVA.token, body: {} }]);
    expect(Object.keys(answer.body)).toEqual(["authorizeUrl"]);
    expect(answer.body.authorizeUrl).toBe(`https://github.com/login/oauth/authorize?client_id=Iv1.client&state=${state}`);
    const cookie = String(answer.headers["set-cookie"]);
    expect(cookie).toMatch(/HttpOnly/u); expect(cookie).toMatch(/Secure/u); expect(cookie).toMatch(/SameSite=Lax/u); expect(cookie).toContain("Path=/api/connect/github");
    const [key, pending] = w.pendingWrites[0]!;
    expect(key).toBe(githubStateKey(binder));
    expect(pending.github).toMatchObject({ kind: "state", flow: "link", developerId: NOVA.developerId, stateHash: sha(state) });
    expect(JSON.stringify(pending)).not.toContain(state); expect(key).not.toContain(binder); expect(JSON.stringify(answer.body)).not.toContain(binder);
  });
  it("the browser names nothing: any body is refused before Code is asked", async () => {
    const w = world(); const nova = await w.signIn(NOVA);
    for (const body of [{ companyId: "x" }, { personId: "x" }, { githubUserId: 8 }, { back: "/app" }, [], "x"]) {
      expect((await w.api(nova, "POST", "/me/github/link", body)).status).toBe(400);
    }
    expect(w.codeCalls("/v1/dev/me/github/link")).toEqual([]);
    expect(w.pendingWrites).toEqual([]);
  });
  it("needs the sign-in's CSRF token", async () => {
    const w = world(); const nova = await w.signIn(NOVA);
    expect((await w.raw("POST", "/v1/web/me/github/link", { cookie: `rovara_cloud_session=${nova.cookie}` }, "{}")).status).toBe(403);
    expect(w.codeCalls("/v1/dev/me/github/link")).toEqual([]);
  });
  it("says Cloud's own words for Code's refusals (a stale step-up, no routes, an App not set up, a fault), never Code's", async () => {
    const w = world();
    const stale = await w.signIn(NOVA_STALE);
    expect(await w.api(stale, "POST", "/me/github/link", {})).toMatchObject({ status: 403, body: { error: { code: "REAUTH_REQUIRED", message: GITHUB_LINK_WORDS.reauth } } });
    const nova = await w.signIn(NOVA);
    w.overrides.set("POST /v1/dev/me/github/link", () => respond(404, { error: { code: "NOT_FOUND", message: "route not found" } }));
    expect(await w.api(nova, "POST", "/me/github/link", {})).toMatchObject({ status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: GITHUB_LINK_WORDS.notAvailable } } });
    w.overrides.set("POST /v1/dev/me/github/link", () => respond(503, { error: { code: "RUNTIME_UNAVAILABLE", message: WORDS.notSetUp } }));
    expect(await w.api(nova, "POST", "/me/github/link", {})).toMatchObject({ status: 503, body: { error: { message: GITHUB_LINK_WORDS.notSetUp } } });
    w.overrides.set("POST /v1/dev/me/github/link", () => respond(503, { error: { code: "RUNTIME_UNAVAILABLE", message: "secret detail" } }));
    const fault = await w.api(nova, "POST", "/me/github/link", {});
    expect(fault.body.error!.message).toBe(GITHUB_LINK_WORDS.unavailable); expect(JSON.stringify(fault.body)).not.toContain("secret detail");
    w.overrides.set("POST /v1/dev/me/github/link", () => respond(403, { error: { code: "FORBIDDEN", message: "Code's own words" } }));
    expect(JSON.stringify((await w.api(nova, "POST", "/me/github/link", {})).body)).not.toContain("Code's own words");
    expect(w.pendingWrites).toEqual([]);
  });
  it("sends the browser nowhere GitHub's login page isn't: a wrong host, an extra parameter, another state or an unreadable answer is refused and binds nothing", async () => {
    const w = world(); const nova = await w.signIn(NOVA);
    const state = randomBytes(32).toString("base64url");
    const answers: unknown[] = [
      { state, authorizeUrl: `https://evil.example/login/oauth/authorize?client_id=Iv1.client&state=${state}` },
      { state, authorizeUrl: `https://github.com/login/oauth/authorize?client_id=Iv1.client&state=${state}&redirect_uri=https://evil.example` },
      { state, authorizeUrl: `https://github.com/login/oauth/authorize?client_id=Iv1.client&state=${randomBytes(32).toString("base64url")}` },
      { state, authorizeUrl: `https://github.com/other?client_id=Iv1.client&state=${state}` },
      { state: "short", authorizeUrl: "https://github.com/login/oauth/authorize?client_id=Iv1.client&state=short" },
      { authorizeUrl: 5 }, "nope",
    ];
    for (const body of answers) {
      w.overrides.set("POST /v1/dev/me/github/link", () => respond(200, body));
      const answer = await w.api(nova, "POST", "/me/github/link", {});
      expect(answer.status, JSON.stringify(body)).toBe(503); expect(answer.headers["set-cookie"]).toBeUndefined();
    }
    expect(w.pendingWrites).toEqual([]);
  });
});

describe("the return (GET /api/connect/github/callback, a link flow)", () => {
  it("links for the browser and sign-in that started it: Code's claim is asked as the person with the state and the code only, the cookie is cleared, and the person lands on the profile", async () => {
    const w = world(); const nova = await w.signIn(NOVA);
    const { binder, state } = await w.start(nova);
    const back = await w.callback(`state=${state}&code=${code}`, { binder, session: nova.cookie });
    expect(back.location).toBe(`${LANDING}linked`);
    expect(String(back.setCookie)).toContain("Max-Age=0");
    expect(w.codeCalls("/v1/dev/me/github/link/claim")).toEqual([{ method: "POST", path: "/v1/dev/me/github/link/claim", token: NOVA.token, body: { state, code } }]);
    // It never reached the company connect.
    expect(w.codeCalls("/v1/dev/company/github/claim")).toEqual([]);
    expect(await w.api(nova, "GET", "/me/github")).toMatchObject({ status: 200, body: { linked: true, login: "nova-dev" } });
    expect(JSON.stringify(w.logs)).not.toContain(state); expect(JSON.stringify(w.logs)).not.toContain(code);
  });
  it("is used once: the same return again, or a replayed binding, asks Code nothing more", async () => {
    const w = world(); const nova = await w.signIn(NOVA);
    const { binder, state } = await w.start(nova);
    await w.callback(`state=${state}&code=${code}`, { binder, session: nova.cookie });
    const again = await w.callback(`state=${state}&code=${code}`, { binder, session: nova.cookie });
    expect(again.location).toBe("/app/onboard?github=start_again");
    expect(w.codeCalls("/v1/dev/me/github/link/claim")).toHaveLength(1);
  });
  it("another browser, another sign-in, no cookie, no session, a wrong or repeated state, or a stale binding: one word, and Code's claim is never asked", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const bob = await w.signIn(BOB);
    // A refusal lands on the profile once the cookie's binding is known to be a link; with no cookie, or a binder nobody holds, it cannot be told, so it lands on onboarding.
    const ONBOARD = "/app/onboard?github=start_again";
    const refused = async (cookies: (s: { binder: string }) => { binder?: string; session?: string }, query: (s: { state: string }) => string, advance = 0, expected = `${LANDING}start_again`) => {
      const s = await w.start(nova);
      w.advance(advance);
      const back = await w.callback(query(s), cookies(s));
      expect(back.location).toBe(expected);
    };
    await refused((s) => ({ binder: s.binder, session: bob.cookie }), (s) => `state=${s.state}&code=${code}`);
    await refused((s) => ({ binder: s.binder }), (s) => `state=${s.state}&code=${code}`);
    await refused(() => ({ session: nova.cookie }), () => `state=${"x"}&code=${code}`, 0, ONBOARD);
    await refused(() => ({ binder: "A".repeat(43), session: nova.cookie }), () => `state=${"x"}&code=${code}`, 0, ONBOARD);
    await refused((s) => ({ binder: s.binder, session: nova.cookie }), () => `state=${randomBytes(32).toString("base64url")}&code=${code}`);
    await refused((s) => ({ binder: s.binder, session: nova.cookie }), (s) => `state=${s.state}&state=${s.state}&code=${code}`);
    await refused((s) => ({ binder: s.binder, session: nova.cookie }), (s) => `state=${s.state}&code=${code}`, GITHUB_CONNECT_TTL_MS + 1000);
    expect(w.codeCalls("/v1/dev/me/github/link/claim")).toEqual([]);
  });
  it("a return that also carries install fields is not a link return; GitHub's cancel (no code) is its own word; a code that is not a code is refused; Code is not asked", async () => {
    const w = world(); const nova = await w.signIn(NOVA);
    for (const [extra, word] of [["&installation_id=5", "start_again"], ["&setup_action=install", "start_again"], ["", "cancelled"], ["&code=bad code!", "start_again"]] as const) {
      const { binder, state } = await w.start(nova);
      const hasCode = extra.startsWith("&code");
      const back = await w.callback(`state=${state}${extra === "" ? "&error=access_denied" : hasCode ? extra : `${extra}&code=${code}`}`, { binder, session: nova.cookie });
      expect(back.location, extra).toBe(`${LANDING}${word === "start_again" && hasCode ? "cancelled" : word}`);
    }
    expect(w.codeCalls("/v1/dev/me/github/link/claim")).toEqual([]);
  });
  it("says Code's refusals as one fixed word each: taken, a stale step-up, anything else Code refuses, no routes, a fault, an answer that does not read", async () => {
    const w = world(); const nova = await w.signIn(NOVA);
    const run = async (response: () => Response) => {
      w.overrides.set("POST /v1/dev/me/github/link/claim", response);
      const { binder, state } = await w.start(nova);
      return (await w.callback(`state=${state}&code=${code}`, { binder, session: nova.cookie })).location;
    };
    expect(await run(() => respond(409, { error: { code: "GITHUB_ACCOUNT_TAKEN", message: "x" } }))).toBe(`${LANDING}taken`);
    expect(await run(() => respond(409, { error: { code: "GITHUB_ACCOUNT_LINK_EXISTS", message: "x" } }))).toBe(`${LANDING}exists`);
    expect(await run(() => respond(409, { error: { code: "SOMETHING_ELSE", message: "x" } }))).toBe(`${LANDING}unavailable`);
    expect(await run(() => respond(403, { error: { code: "REAUTH_REQUIRED", message: "x" } }))).toBe(`${LANDING}reauth`);
    expect(await run(() => respond(403, { error: { code: "FORBIDDEN", message: "Start again from Rovara." } }))).toBe(`${LANDING}start_again`);
    expect(await run(() => respond(404, { error: { code: "NOT_FOUND", message: "route not found" } }))).toBe(`${LANDING}not_available`);
    expect(await run(() => respond(500, { error: "boom" }))).toBe(`${LANDING}unavailable`);
    for (const body of [{ status: "linked" }, { status: "linked", githubUser: { id: 0, login: "x" } }, { status: "linked", githubUser: { id: 7, login: "has space" } }, { status: "other", githubUser: { id: 7, login: "x" } }, "nope"]) {
      expect(await run(() => respond(200, body)), JSON.stringify(body)).toBe(`${LANDING}unavailable`);
    }
  });
  it("the company connect is untouched: a binding with no flow is claimed as before and never reaches the link", async () => {
    const w = world(); const nova = await w.signIn(NOVA);
    const binder = randomBytes(32).toString("base64url");
    const state = randomBytes(32).toString("base64url");
    await w.sessions.putPending(githubStateKey(binder), { verifier: "", returnTo: "/app/onboard", at: START, github: { kind: "state", session: "x".repeat(64), developerId: NOVA.developerId, stateHash: sha(state) } });
    const back = await w.callback(`state=${state}&code=${code}`, { binder, session: nova.cookie });
    expect(back.location).toBe("/app/onboard?github=start_again");
    expect(w.codeCalls("/v1/dev/me/github/link/claim")).toEqual([]);
  });
});

describe("read and unlink", () => {
  it("rebuilds Code's read field by field: the login and time only", async () => {
    const w = world(); const nova = await w.signIn(NOVA);
    expect(await w.api(nova, "GET", "/me/github")).toMatchObject({ status: 200, body: { linked: false } });
    const { binder, state } = await w.start(nova);
    await w.callback(`state=${state}&code=${code}`, { binder, session: nova.cookie });
    const read = await w.api(nova, "GET", "/me/github");
    expect(read.body).toEqual({ linked: true, login: "nova-dev", linkedAt: new Date(START).toISOString() });
    for (const body of [{ linked: true }, { linked: true, login: "has space" }, { linked: "yes" }, "x"]) {
      w.overrides.set("GET /v1/dev/me/github", () => respond(200, body));
      expect((await w.api(nova, "GET", "/me/github")).status).toBe(503);
    }
    w.overrides.set("GET /v1/dev/me/github", () => respond(404, { error: { code: "NOT_FOUND", message: "x" } }));
    expect((await w.api(nova, "GET", "/me/github")).status).toBe(501);
  });
  it("unlinks as the person; takes no details; Code's fault is one fixed sentence", async () => {
    const w = world(); const nova = await w.signIn(NOVA);
    const { binder, state } = await w.start(nova);
    await w.callback(`state=${state}&code=${code}`, { binder, session: nova.cookie });
    expect((await w.api(nova, "DELETE", "/me/github", { personId: "x" })).status).toBe(400);
    expect(w.codeCalls("/v1/dev/me/github").filter((call) => call.method === "DELETE")).toEqual([]);
    expect(await w.api(nova, "DELETE", "/me/github")).toMatchObject({ status: 200, body: { unlinked: true } });
    expect(w.codeCalls("/v1/dev/me/github").filter((call) => call.method === "DELETE")).toEqual([{ method: "DELETE", path: "/v1/dev/me/github", token: NOVA.token }]);
    expect(await w.api(nova, "GET", "/me/github")).toMatchObject({ body: { linked: false } });
    w.overrides.set("DELETE /v1/dev/me/github", () => respond(500, { error: { message: "secret" } }));
    const fault = await w.api(nova, "DELETE", "/me/github");
    expect(fault).toMatchObject({ status: 503, body: { error: { message: GITHUB_LINK_WORDS.unlinkUnavailable } } });
  });
  it("needs a signed-in browser", async () => {
    const w = world();
    expect((await w.raw("GET", "/v1/web/me/github")).status).toBe(401);
    expect((await w.raw("DELETE", "/v1/web/me/github")).status).toBe(401);
  });
});
