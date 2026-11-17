// Guided onboarding PR 2 (github-connect.ts): the "Connect GitHub" button's server side on a pretend Rovara Code that keeps PR #830's rules
// (single-use states and tickets bound to the person's token). The browser never names a company; the GitHub callback goes on only with the
// cookie set at connect, for the same sign-in, the same person and the same state, once; refusals are Code's fixed sentences; nothing
// GitHub or Code sent as a secret (state, code, ticket) reaches a log, a page or a URL. Two companies throughout.
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CodeClient, GITHUB_CALLBACK_PATH, type CompanyStore, GITHUB_WORDS, LocalCompanyStore, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest, type PendingSignIn,
} from "../../packages/cloud-server/src/index.js";

const CODE = "https://code.example.test";
const ORIGIN = "https://cloud.example.test";
const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const START = Date.parse("2026-11-17T12:00:00.000Z");
const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const id64 = (name: string) => createHash("sha256").update(name).digest("hex");

interface Person { key: string; developerId: string; companyId: string; role: "owner" | "admin" | "member"; token: string; githubUserId: number }
const NOVA: Person = { key: "nova", developerId: id64("nova"), companyId: A, role: "owner", token: "tok-nova", githubUserId: 1001 };
const MAX: Person = { key: "max", developerId: id64("max"), companyId: A, role: "member", token: "tok-max", githubUserId: 1002 };
const BOB: Person = { key: "bob", developerId: id64("bob"), companyId: B, role: "owner", token: "tok-bob", githubUserId: 2001 };
const PEOPLE = [NOVA, MAX, BOB];

/** GitHub's `code` values the pretend Code understands. */
const CODES = { connected: "ghcode-connected", choose: "ghcode-choose", taken: "ghcode-taken" } as const;

function world() {
  let clock = START;
  // The pretend Code: states and tickets by value, each bound to the token that minted it; spent once.
  const states = new Map<string, { token: string; spent: boolean }>();
  const tickets = new Map<string, { token: string; spent: boolean }>();
  const bound = new Map<number, string>();
  const calls: Array<{ method: string; path: string; search: string; token?: string; body?: unknown }> = [];
  const overrides = new Map<string, () => Response>();
  const secret = () => randomBytes(32).toString("base64url");
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
    const token = authorization?.replace(/^Bearer /u, "");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname, search: url.search, ...(token === undefined ? {} : { token }), ...(body === undefined ? {} : { body }) });
    const person = PEOPLE.find((one) => one.token === token);
    if (person === undefined) return respond(401, { error: { code: "AUTH_REQUIRED" } });
    const override = overrides.get(`${method} ${url.pathname}`);
    if (override !== undefined) return override();
    const isAdmin = person.role !== "member";
    const user = { id: person.githubUserId, login: `${person.key}-gh` };
    if (url.pathname === "/v1/dev/access") return respond(200, { developerId: person.developerId, displayName: person.key, administrator: false, projects: [], notices: [], companyId: person.companyId, companyRole: person.role });
    if (url.pathname === "/v1/dev/company/github/connect" && method === "POST") {
      if (!isAdmin) return respond(403, { error: { code: "FORBIDDEN", message: "Only a company owner or admin can connect GitHub." } });
      const state = secret();
      states.set(state, { token: person.token, spent: false });
      return respond(200, { state, expiresAt: new Date(clock + 600_000).toISOString(), installUrl: `https://github.com/apps/rovara-test/installations/new?state=${state}`, authorizeUrl: `https://github.com/login/oauth/authorize?client_id=Iv1.abc123&state=${state}` });
    }
    const startAgain = () => respond(403, { error: { code: "FORBIDDEN", message: "Start again from Rovara." } });
    if (url.pathname === "/v1/dev/company/github/claim" && method === "POST") {
      const kept = states.get(String(body?.state));
      if (!isAdmin || kept === undefined || kept.spent || kept.token !== person.token) return startAgain();
      kept.spent = true;
      if (body?.setupAction === "request") return respond(200, { status: "requested" });
      if (body?.code === CODES.taken) return respond(409, { error: { code: "GITHUB_INSTALLATION_TAKEN", message: "This GitHub account is already connected to a different Rovara company." } });
      if (body?.code === CODES.choose) {
        const ticket = secret();
        tickets.set(ticket, { token: person.token, spent: false });
        return respond(200, { status: "choose", ticket, expiresAt: new Date(clock + 600_000).toISOString(), githubUser: user, installations: [
          { installationId: 11, accountLogin: "acme", accountType: "Organization", suspended: false, connection: "unbound" },
          { installationId: 12, accountLogin: "beta-co", accountType: "Organization", suspended: false, connection: "another_company" },
        ] });
      }
      if (body?.code !== CODES.connected || typeof body.installationId !== "number") return startAgain();
      const already = bound.get(body.installationId) === person.companyId;
      bound.set(body.installationId, person.companyId);
      return respond(200, { status: "connected", alreadyConnected: already, installation: { installationId: body.installationId, accountLogin: "acme", accountType: "Organization" }, githubUser: user });
    }
    if (url.pathname === "/v1/dev/company/github/choose" && method === "POST") {
      const kept = tickets.get(String(body?.ticket));
      if (!isAdmin || kept === undefined || kept.spent || kept.token !== person.token || body?.installationId !== 11) return startAgain();
      kept.spent = true;
      bound.set(11, person.companyId);
      return respond(200, { status: "connected", alreadyConnected: false, installation: { installationId: 11, accountLogin: "acme", accountType: "Organization" }, githubUser: user });
    }
    if (url.pathname === "/v1/dev/company/github" && method === "GET") {
      const rows = [...bound].filter(([, company]) => company === person.companyId).map(([installationId]) => ({
        installationId, accountLogin: installationId === 11 ? "acme" : `acct${String(installationId)}`, connectedAt: new Date(clock).toISOString(), connectedBy: { kind: "person", personId: person.developerId, name: person.key },
      }));
      return respond(200, { installations: rows });
    }
    return respond(404, { error: { code: "NOT_FOUND", message: "route not found" } });
  }) as typeof fetch;
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: `${ORIGIN}/callback`, scopes: "", fetch: fetchImpl });
  const sessions = new LocalSessionStore(undefined, { now: () => clock, environment: {} });
  // Every pending row Cloud writes, to show only hashes are stored.
  const pendingWrites: Array<[string, PendingSignIn]> = [];
  const put = sessions.putPending.bind(sessions);
  sessions.putPending = async (key, value) => { pendingWrites.push([key, structuredClone(value)]); await put(key, value); };
  const companies: CompanyStore = new LocalCompanyStore();
  const logs: Array<Record<string, unknown>> = [];
  const handler = createCloudHandler({
    client, store: sessions, org: { orgId: "rovara", name: "Rovara", plan: "cloud" }, callbackPath: "/callback", secureCookies: true, work: new LocalWorkSessionStore(), origin: ORIGIN,
    company: { store: companies }, now: () => new Date(clock), log: (event) => { logs.push(event); },
  });
  const raw = async (method: string, target: string, headers: Record<string, string> = {}, body?: string) => {
    const url = new URL(target, ORIGIN);
    const request: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers, ...(body === undefined ? {} : { body }) };
    return (await handler(request))!;
  };
  const signIn = async (person: Person) => {
    const cookie = randomBytes(32).toString("base64url");
    await sessions.create(cookie, { accessToken: person.token, access: { developerId: person.developerId, displayName: person.key, administrator: false, projects: [], notices: [], companyId: person.companyId, companyRole: person.role }, csrf: `csrf-${person.key}`, signedInAt: new Date(clock).toISOString() });
    return { person, cookie };
  };
  type Who = Awaited<ReturnType<typeof signIn>>;
  const api = async (who: Who, method: string, path: string, body?: unknown, rawBody?: string) => {
    const answer = await raw(method, `/v1/web${path}`, { cookie: `rovara_cloud_session=${who.cookie}`, "x-rovara-csrf": `csrf-${who.person.key}`, "content-type": "application/json" }, rawBody ?? (body === undefined ? undefined : JSON.stringify(body)));
    return { status: answer.status, body: JSON.parse(answer.body) as Record<string, unknown> & { error?: { code: string; message: string } }, headers: answer.headers };
  };
  /** Connect: the binder from the cookie and the state from the install address. */
  const connect = async (who: Who) => {
    const answer = await api(who, "POST", "/github/connect", {});
    expect(answer.status).toBe(200);
    const binder = /^rovara_cloud_github=([A-Za-z0-9_-]{43});/u.exec(answer.headers["set-cookie"] ?? "")?.[1];
    const state = new URL(String(answer.body.installUrl)).searchParams.get("state")!;
    return { binder: binder!, state, answer };
  };
  /** GitHub's return, with the browser's cookies. */
  const callback = async (query: Record<string, string> | string, cookies: { session?: string; binder?: string }) => {
    const search = typeof query === "string" ? query : new URLSearchParams(query).toString();
    const cookie = [cookies.session === undefined ? undefined : `rovara_cloud_session=${cookies.session}`, cookies.binder === undefined ? undefined : `rovara_cloud_github=${cookies.binder}`].filter(Boolean).join("; ");
    const answer = await raw("GET", `${GITHUB_CALLBACK_PATH}?${search}`, cookie === "" ? {} : { cookie });
    return { status: answer.status, location: answer.headers.location, setCookie: answer.headers["set-cookie"], body: answer.body };
  };
  const codeCalls = (path: string) => calls.filter((call) => call.path === path);
  /** Rewrites a row Cloud wrote (as a tampered or confused store would hold it), under the same key. */
  const rewrite = async (key: string, change: (row: PendingSignIn) => PendingSignIn) => {
    const row = [...pendingWrites].reverse().find(([written]) => written === key)?.[1];
    if (row === undefined) throw new Error("no such row");
    await put(key, change(structuredClone(row)));
  };
  return { raw, api, signIn, connect, callback, calls, codeCalls, logs, pendingWrites, rewrite, companies, overrides, advance: (ms: number) => { clock += ms; } };
}

const CLAIM = "/v1/dev/company/github/claim";
const CLEARED = "rovara_cloud_github=; HttpOnly; SameSite=Lax; Path=/api/connect/github; Secure; Max-Age=0";

describe("connect (POST /v1/app/github/connect)", () => {
  it("asks Code as the person with an empty body, answers both GitHub addresses, and binds the browser with an HttpOnly, Secure, SameSite=Lax cookie", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const { binder, state, answer } = await w.connect(nova);
    expect(answer.body).toEqual({
      installUrl: `https://github.com/apps/rovara-test/installations/new?state=${state}`, authorizeUrl: `https://github.com/login/oauth/authorize?client_id=Iv1.abc123&state=${state}`,
      expiresAt: new Date(START + 600_000).toISOString(),
    });
    expect(answer.headers["set-cookie"]).toBe(`rovara_cloud_github=${binder}; HttpOnly; SameSite=Lax; Path=/api/connect/github; Secure; Max-Age=600`);
    expect(w.codeCalls("/v1/dev/company/github/connect")).toEqual([{ method: "POST", path: "/v1/dev/company/github/connect", search: "", token: "tok-nova", body: {} }]);
    // Only hashes are kept: neither the state nor the cookie's binder is in what Cloud stored.
    const stored = JSON.stringify(w.pendingWrites);
    expect(w.pendingWrites).toHaveLength(1);
    expect(stored).not.toContain(state);
    expect(stored).not.toContain(binder);
    expect(stored).not.toContain(nova.cookie);
    expect(w.pendingWrites[0]![1].github).toMatchObject({ kind: "state", stateHash: createHash("sha256").update(state).digest("hex"), developerId: NOVA.developerId });
  });

  it("never lets the browser name a company, an installation or anything else; nothing reaches Code", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    for (const body of [{ companyId: B }, { company: B }, { installationId: 5 }, [], "x"]) {
      const answer = await w.api(nova, "POST", "/github/connect", body);
      expect(answer).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID", message: GITHUB_WORDS.noDetails } } });
    }
    expect((await w.api(nova, "POST", "/github/connect", undefined, "{not json")).status).toBe(400);
    expect(w.codeCalls("/v1/dev/company/github/connect")).toEqual([]);
    // A query naming a company is ignored: Code is asked with {} and no query.
    const answer = await w.raw("POST", `/v1/web/github/connect?company=${B}&companyId=${B}`, { cookie: `rovara_cloud_session=${nova.cookie}`, "x-rovara-csrf": "csrf-nova", "content-type": "application/json" }, "{}");
    expect(answer.status).toBe(200);
    expect(w.codeCalls("/v1/dev/company/github/connect")).toEqual([{ method: "POST", path: "/v1/dev/company/github/connect", search: "", token: "tok-nova", body: {} }]);
    expect(JSON.stringify(w.calls)).not.toContain(B);
  });

  it("needs the sign-in's CSRF token", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const answer = await w.raw("POST", "/v1/web/github/connect", { cookie: `rovara_cloud_session=${nova.cookie}`, "content-type": "application/json" }, "{}");
    expect(answer.status).toBe(403);
    expect(w.codeCalls("/v1/dev/company/github/connect")).toEqual([]);
  });

  it("shows a non-admin Code's own sentence, and sets no cookie", async () => {
    const w = world();
    const max = await w.signIn(MAX);
    const answer = await w.api(max, "POST", "/github/connect", {});
    expect(answer).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN", message: "Only a company owner or admin can connect GitHub." } } });
    expect(answer.headers["set-cookie"]).toBeUndefined();
  });

  it("says Code's fixed sentences for a Code without the routes, an App not set up, or anything else, never Code's other words", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    w.overrides.set("POST /v1/dev/company/github/connect", () => respond(404, { error: { code: "NOT_FOUND", message: "route not found" } }));
    expect((await w.api(nova, "POST", "/github/connect", {})).body).toEqual({ error: { code: "NOT_FOUND", message: "Connecting GitHub isn't available yet." } });
    w.overrides.set("POST /v1/dev/company/github/connect", () => respond(503, { error: { code: "RUNTIME_UNAVAILABLE", message: "Connecting GitHub isn't set up on this Rovara yet. Ask the Rovara team." } }));
    expect((await w.api(nova, "POST", "/github/connect", {})).body).toEqual({ error: { code: "RUNTIME_UNAVAILABLE", message: "Connecting GitHub isn't set up on this Rovara yet. Ask the Rovara team." } });
    w.overrides.set("POST /v1/dev/company/github/connect", () => respond(503, { error: { code: "RUNTIME_UNAVAILABLE", message: "secret-arn:aws:boom" } }));
    expect((await w.api(nova, "POST", "/github/connect", {})).body).toEqual({ error: { code: "RUNTIME_UNAVAILABLE", message: GITHUB_WORDS.unavailable } });
    w.overrides.set("POST /v1/dev/company/github/connect", () => respond(500, { error: { code: "X", message: "stack trace" } }));
    expect((await w.api(nova, "POST", "/github/connect", {})).body).toEqual({ error: { code: "RUNTIME_UNAVAILABLE", message: GITHUB_WORDS.unavailable } });
  });

  it("refuses a Code answer whose GitHub addresses go elsewhere or carry anything but the state", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const state = "s".repeat(43);
    const bad = [
      { installUrl: `https://evil.example/apps/x/installations/new?state=${state}` },
      { installUrl: `https://github.com/apps/x/installations/new?state=${state}&redirect_uri=https://evil.example` },
      { installUrl: `https://github.com/apps/x/installations/new?state=${"t".repeat(43)}` },
      { authorizeUrl: `https://github.com/login/oauth/authorize?client_id=Iv1.a&state=${state}&redirect_uri=https://evil.example` },
      { authorizeUrl: `https://github.com.evil.example/login/oauth/authorize?client_id=Iv1.a&state=${state}` },
    ];
    for (const change of bad) {
      w.overrides.set("POST /v1/dev/company/github/connect", () => respond(200, { state, expiresAt: new Date(START).toISOString(), installUrl: `https://github.com/apps/x/installations/new?state=${state}`, authorizeUrl: `https://github.com/login/oauth/authorize?client_id=Iv1.a&state=${state}`, ...change }));
      const answer = await w.api(nova, "POST", "/github/connect", {});
      expect(answer, JSON.stringify(change)).toMatchObject({ status: 503, body: { error: { message: GITHUB_WORDS.unavailable } } });
      expect(answer.headers["set-cookie"]).toBeUndefined();
    }
  });
});

describe("the GitHub callback (GET /api/connect/github/callback)", () => {
  it("claims as the person with GitHub's values only, clears the cookie, and lands on onboarding with the outcome kept server-side", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const { binder, state } = await w.connect(nova);
    const back = await w.callback({ installation_id: "77", setup_action: "install", state, code: CODES.connected }, { session: nova.cookie, binder });
    expect(back).toMatchObject({ status: 302, location: "/app/onboard?github=result", setCookie: CLEARED });
    expect(w.codeCalls(CLAIM)).toEqual([{ method: "POST", path: CLAIM, search: "", token: "tok-nova", body: { state, code: CODES.connected, installationId: 77, setupAction: "install" } }]);
    const result = await w.api(nova, "POST", "/github/connect/result", {});
    expect(result).toMatchObject({ status: 200, body: { status: "connected", alreadyConnected: false, accountLogin: "acme", accountType: "Organization" } });
    // Taken once: a second read finds nothing (the real state shows from then on).
    expect((await w.api(nova, "POST", "/github/connect/result", {})).body).toEqual({ status: "none" });
  });

  it("does nothing without the cookie: no claim, the cookie cleared, 'Start again from Rovara.'", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const { state } = await w.connect(nova);
    const back = await w.callback({ state, code: CODES.connected, installation_id: "77" }, { session: nova.cookie });
    expect(back).toMatchObject({ status: 302, location: "/app/onboard?github=start_again", setCookie: CLEARED });
    expect(w.codeCalls(CLAIM)).toEqual([]);
    for (const binder of ["", "short", "x".repeat(44)]) {
      expect((await w.callback({ state, code: CODES.connected }, { session: nova.cookie, binder })).location).toBe("/app/onboard?github=start_again");
    }
    expect(w.codeCalls(CLAIM)).toEqual([]);
  });

  it("refuses another sign-in's cookie, in either direction, and a cookie with no sign-in", async () => {
    const w = world();
    const nova = await w.signIn(NOVA), bob = await w.signIn(BOB);
    // Bob's binder in Nova's browser (Bob tries to make Nova finish his connect).
    const bobs = await w.connect(bob);
    expect((await w.callback({ state: bobs.state, code: CODES.connected, installation_id: "77" }, { session: nova.cookie, binder: bobs.binder })).location).toBe("/app/onboard?github=start_again");
    // Nova's own binder with Bob's sign-in.
    const novas = await w.connect(nova);
    expect((await w.callback({ state: novas.state, code: CODES.connected, installation_id: "77" }, { session: bob.cookie, binder: novas.binder })).location).toBe("/app/onboard?github=start_again");
    // A second sign-in of the same person is another sign-in too.
    const nova2 = await w.signIn(NOVA);
    const third = await w.connect(nova);
    expect((await w.callback({ state: third.state, code: CODES.connected, installation_id: "77" }, { session: nova2.cookie, binder: third.binder })).location).toBe("/app/onboard?github=start_again");
    const fourth = await w.connect(nova);
    expect((await w.callback({ state: fourth.state, code: CODES.connected, installation_id: "77" }, { binder: fourth.binder })).location).toBe("/app/onboard?github=start_again");
    expect(w.codeCalls(CLAIM)).toEqual([]);
    expect(w.logs.filter((line) => line.event === "cloud.github_callback_refused").map((line) => line.reason)).toEqual(["session", "session", "session", "session"]);
  });

  it("refuses a state the cookie wasn't set for, and the binding is spent by the try", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const first = await w.connect(nova);
    const second = await w.connect(nova);
    // The second connect's state with the first connect's cookie.
    expect((await w.callback({ state: second.state, code: CODES.connected, installation_id: "77" }, { session: nova.cookie, binder: first.binder })).location).toBe("/app/onboard?github=start_again");
    // The right state now finds the binding gone.
    expect((await w.callback({ state: first.state, code: CODES.connected, installation_id: "77" }, { session: nova.cookie, binder: first.binder })).location).toBe("/app/onboard?github=start_again");
    // A state that differs in one character, and none at all.
    const third = await w.connect(nova);
    const flipped = (third.state[0] === "A" ? "B" : "A") + third.state.slice(1);
    expect((await w.callback({ state: flipped, code: CODES.connected }, { session: nova.cookie, binder: third.binder })).location).toBe("/app/onboard?github=start_again");
    const fourth = await w.connect(nova);
    expect((await w.callback({ code: CODES.connected }, { session: nova.cookie, binder: fourth.binder })).location).toBe("/app/onboard?github=start_again");
    expect(w.codeCalls(CLAIM)).toEqual([]);
    expect(w.logs.filter((line) => line.event === "cloud.github_callback_refused").map((line) => line.reason)).toEqual(["state", "no_binding", "state", "state"]);
  });

  it("works once: a replay after success, even with the same cookie, does nothing", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const { binder, state } = await w.connect(nova);
    const query = { state, code: CODES.connected, installation_id: "77", setup_action: "install" };
    expect((await w.callback(query, { session: nova.cookie, binder })).location).toBe("/app/onboard?github=result");
    expect((await w.callback(query, { session: nova.cookie, binder })).location).toBe("/app/onboard?github=start_again");
    expect(w.codeCalls(CLAIM)).toHaveLength(1);
  });

  it("refuses after ten minutes", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const { binder, state } = await w.connect(nova);
    w.advance(10 * 60_000 + 1);
    expect((await w.callback({ state, code: CODES.connected, installation_id: "77" }, { session: nova.cookie, binder })).location).toBe("/app/onboard?github=start_again");
    expect(w.codeCalls(CLAIM)).toEqual([]);
  });

  it("refuses a repeated or malformed GitHub value before asking Code", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    for (const extra of ["installation_id=7&installation_id=8", "installation_id=0", "installation_id=99999999999999999", "installation_id=1e3", "setup_action=delete", "code=a%20b", `code=${"c".repeat(129)}`]) {
      const { binder, state } = await w.connect(nova);
      expect((await w.callback(`state=${state}&code=${CODES.connected}&${extra}`.replace(`&code=${CODES.connected}&code=`, "&code="), { session: nova.cookie, binder })).location, extra).toBe("/app/onboard?github=start_again");
    }
    const { binder, state } = await w.connect(nova);
    expect((await w.callback(`state=${state}&state=${state}&code=${CODES.connected}`, { session: nova.cookie, binder })).location).toBe("/app/onboard?github=start_again");
    expect(w.codeCalls(CLAIM)).toEqual([]);
  });

  it("lands on Code's refusals as one fixed word each", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const run = async (code: string) => { const { binder, state } = await w.connect(nova); return (await w.callback({ state, code, installation_id: "77" }, { session: nova.cookie, binder })).location; };
    expect(await run("ghcode-unknown")).toBe("/app/onboard?github=start_again");
    expect(await run(CODES.taken)).toBe("/app/onboard?github=taken");
    w.overrides.set(`POST ${CLAIM}`, () => respond(503, { error: { code: "RUNTIME_UNAVAILABLE", message: "GitHub could not be connected just now. Start again from Rovara." } }));
    expect(await run(CODES.connected)).toBe("/app/onboard?github=unavailable");
    w.overrides.set(`POST ${CLAIM}`, () => respond(404, { error: { code: "NOT_FOUND", message: "route not found" } }));
    expect(await run(CODES.connected)).toBe("/app/onboard?github=not_available");
    w.overrides.set(`POST ${CLAIM}`, () => respond(200, { status: "connected", installation: { installationId: 1, accountLogin: "<script>", accountType: "Organization" }, githubUser: { id: 1, login: "x" }, alreadyConnected: false }));
    expect(await run(CODES.connected)).toBe("/app/onboard?github=unavailable");
    expect((await w.api(nova, "POST", "/github/connect/result", {})).body).toEqual({ status: "none" });
  });

  it("keeps a 'request' outcome with the App's install page for the GitHub admin", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const { binder, state } = await w.connect(nova);
    expect((await w.callback({ state, setup_action: "request" }, { session: nova.cookie, binder })).location).toBe("/app/onboard?github=result");
    expect(w.codeCalls(CLAIM)[0]!.body).toEqual({ state, setupAction: "request" });
    expect((await w.api(nova, "POST", "/github/connect/result", {})).body).toEqual({ status: "requested", adminUrl: "https://github.com/apps/rovara-test/installations/new" });
  });

  it("checks every part of a binding row: another person's id, or another sign-in's hash, under the right key does nothing", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const first = await w.connect(nova);
    await w.rewrite(w.pendingWrites.at(-1)![0], (row) => ({ ...row, github: { ...row.github!, developerId: BOB.developerId } }));
    expect((await w.callback({ state: first.state, code: CODES.connected, installation_id: "77" }, { session: nova.cookie, binder: first.binder })).location).toBe("/app/onboard?github=start_again");
    const second = await w.connect(nova);
    await w.rewrite(w.pendingWrites.at(-1)![0], (row) => ({ ...row, github: { ...row.github!, session: "0".repeat(64) } }));
    expect((await w.callback({ state: second.state, code: CODES.connected, installation_id: "77" }, { session: nova.cookie, binder: second.binder })).location).toBe("/app/onboard?github=start_again");
    const third = await w.connect(nova);
    await w.rewrite(w.pendingWrites.at(-1)![0], (row) => ({ ...row, github: { ...row.github!, kind: "result" } }));
    expect((await w.callback({ state: third.state, code: CODES.connected, installation_id: "77" }, { session: nova.cookie, binder: third.binder })).location).toBe("/app/onboard?github=start_again");
    expect(w.codeCalls(CLAIM)).toEqual([]);
  });

  it("checks every part of a kept outcome: another person's id or another sign-in's hash under this sign-in's key reads as nothing", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    for (const change of [{ developerId: BOB.developerId }, { session: "0".repeat(64) }, { kind: "state" as const }]) {
      const { binder, state } = await w.connect(nova);
      expect((await w.callback({ state, code: CODES.choose }, { session: nova.cookie, binder })).location).toBe("/app/onboard?github=result");
      await w.rewrite(w.pendingWrites.at(-1)![0], (row) => ({ ...row, github: { ...row.github!, ...change } }));
      expect((await w.api(nova, "POST", "/github/connect/result", {})).body, JSON.stringify(change)).toEqual({ status: "none" });
      const { binder: b2, state: s2 } = await w.connect(nova);
      await w.callback({ state: s2, code: CODES.choose }, { session: nova.cookie, binder: b2 });
      await w.rewrite(w.pendingWrites.at(-1)![0], (row) => ({ ...row, github: { ...row.github!, ...change } }));
      expect((await w.api(nova, "POST", "/github/choose", { installationId: 11 })).body, JSON.stringify(change)).toEqual({ error: { code: "FORBIDDEN", message: GITHUB_WORDS.startAgain } });
    }
    expect(w.codeCalls("/v1/dev/company/github/choose")).toEqual([]);
  });

  it("is not a sign-in: the sign-in callback refuses a GitHub connect's rows", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    await w.connect(nova);
    const key = w.pendingWrites[0]![0];
    expect(key).toMatch(/^github\.state\.[a-f0-9]{64}$/u);
    const answer = await w.raw("GET", `/callback?state=${encodeURIComponent(key)}&code=x`);
    expect(answer.status).toBe(400);
  });
});

describe("choosing an installation (the 'We found Rovara on …' list)", () => {
  async function chooseWorld() {
    const w = world();
    const nova = await w.signIn(NOVA);
    const { binder, state } = await w.connect(nova);
    expect((await w.callback({ state, code: CODES.choose }, { session: nova.cookie, binder })).location).toBe("/app/onboard?github=result");
    return { w, nova };
  }

  it("shows the list without the ticket, keeps it across a reload, and binds a listed one with the kept ticket", async () => {
    const { w, nova } = await chooseWorld();
    const ticket = String((w.pendingWrites.at(-1)![1].github?.result as { ticket?: string }).ticket);
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const shown = await w.api(nova, "POST", "/github/connect/result", {});
    expect(shown.body).toEqual({ status: "choose", githubLogin: "nova-gh", installations: [
      { installationId: 11, accountLogin: "acme", accountType: "Organization", suspended: false, connection: "unbound" },
      { installationId: 12, accountLogin: "beta-co", accountType: "Organization", suspended: false, connection: "another_company" },
    ] });
    expect(JSON.stringify(shown)).not.toContain(ticket);
    expect((await w.api(nova, "POST", "/github/connect/result", {})).body).toMatchObject({ status: "choose" });
    const chosen = await w.api(nova, "POST", "/github/choose", { installationId: 11 });
    expect(chosen).toMatchObject({ status: 200, body: { status: "connected", accountLogin: "acme", alreadyConnected: false } });
    expect(w.codeCalls("/v1/dev/company/github/choose")).toEqual([{ method: "POST", path: "/v1/dev/company/github/choose", search: "", token: "tok-nova", body: { ticket, installationId: 11 } }]);
    // Spent: a second choice has nothing to choose from.
    expect((await w.api(nova, "POST", "/github/choose", { installationId: 11 })).body).toEqual({ error: { code: "FORBIDDEN", message: GITHUB_WORDS.startAgain } });
  });

  it("won't choose another company's installation or one not listed, and keeps the list", async () => {
    const { w, nova } = await chooseWorld();
    for (const body of [{ installationId: 12 }, { installationId: 99 }, { installationId: "11" }, { installationId: 11, companyId: B }, {}]) {
      expect((await w.api(nova, "POST", "/github/choose", body)).body, JSON.stringify(body)).toEqual({ error: { code: "CONFIG_INVALID", message: GITHUB_WORDS.chooseListed } });
    }
    expect(w.codeCalls("/v1/dev/company/github/choose")).toEqual([]);
    expect((await w.api(nova, "POST", "/github/choose", { installationId: 11 })).status).toBe(200);
  });

  it("keeps the list to its own sign-in: another company's person, or another sign-in, sees nothing and can't choose", async () => {
    const { w, nova } = await chooseWorld();
    const bob = await w.signIn(BOB), nova2 = await w.signIn(NOVA);
    for (const who of [bob, nova2]) {
      expect((await w.api(who, "POST", "/github/connect/result", {})).body).toEqual({ status: "none" });
      expect((await w.api(who, "POST", "/github/choose", { installationId: 11 })).body).toEqual({ error: { code: "FORBIDDEN", message: GITHUB_WORDS.startAgain } });
    }
    expect(w.codeCalls("/v1/dev/company/github/choose")).toEqual([]);
    expect((await w.api(nova, "POST", "/github/choose", { installationId: 11 })).status).toBe(200);
  });
});

describe("one trial per GitHub account (github=trial_used)", () => {
  const connectAs = async (w: ReturnType<typeof world>, who: Awaited<ReturnType<ReturnType<typeof world>["signIn"]>>, installation: string) => {
    const { binder, state } = await w.connect(who);
    expect((await w.callback({ state, code: CODES.connected, installation_id: installation }, { session: who.cookie, binder })).location).toBe("/app/onboard?github=result");
    return (await w.api(who, "POST", "/github/connect/result", {})).body;
  };

  it("records the first company for Code's githubUser.id; the same GitHub account connecting for another company is told its trial was used", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    expect(await connectAs(w, nova, "77")).not.toHaveProperty("trialUsed");
    expect(await connectAs(w, nova, "78")).not.toHaveProperty("trialUsed");
    expect(await w.companies.unlockTrial(NOVA.githubUserId, B, new Date(START).toISOString())).toBe("used");
    expect(await w.companies.trial(B)).toBeUndefined();
    // Bob's company, but Nova's GitHub account (Code's answer names githubUser 1001).
    const bob = await w.signIn(BOB);
    w.overrides.set(`POST ${CLAIM}`, () => respond(200, { status: "connected", alreadyConnected: false, installation: { installationId: 90, accountLogin: "bee", accountType: "Organization" }, githubUser: { id: NOVA.githubUserId, login: "nova-gh" } }));
    expect(await connectAs(w, bob, "90")).toEqual({ status: "connected", alreadyConnected: false, accountLogin: "bee", accountType: "Organization", trialUsed: true });
    expect(w.logs.filter((line) => line.event === "cloud.github_trial_used")).toEqual([{ event: "cloud.github_trial_used", companyId: B, developerId: BOB.developerId }]);
    // Bob's own GitHub account gives Bob's company its trial.
    w.overrides.clear();
    expect(await connectAs(w, bob, "91")).not.toHaveProperty("trialUsed");
    expect(await w.companies.unlockTrial(BOB.githubUserId, B, new Date(START).toISOString())).toBe("held");
    expect((await w.companies.trial(B))?.githubUserId).toBe(BOB.githubUserId);
  });

  it("unlocks the connecting company's trial once, refuses a second company's with the same GitHub account, and echoes nothing (L2-8)", async () => {
    const w = world();
    const nova = await w.signIn(NOVA), bob = await w.signIn(BOB);
    expect(await connectAs(w, nova, "77")).not.toHaveProperty("trialUsed");
    expect((await w.companies.trial(A))?.githubUserId).toBe(NOVA.githubUserId);
    expect(w.logs.filter((line) => line.event === "cloud.github_trial_unlocked")).toEqual([{ event: "cloud.github_trial_unlocked", companyId: A, developerId: NOVA.developerId }]);
    // The second company, same GitHub account (Code names githubUser 1001): connected, but no trial, and only the fixed flag says so.
    w.overrides.set(`POST ${CLAIM}`, () => respond(200, { status: "connected", alreadyConnected: false, installation: { installationId: 90, accountLogin: "bee", accountType: "Organization" }, githubUser: { id: NOVA.githubUserId, login: "nova-gh" } }));
    const refused = await connectAs(w, bob, "90");
    expect(refused).toEqual({ status: "connected", alreadyConnected: false, accountLogin: "bee", accountType: "Organization", trialUsed: true });
    expect(await w.companies.trial(B)).toBeUndefined();
    expect((await w.companies.trial(A))?.githubUserId).toBe(NOVA.githubUserId);
    const text = JSON.stringify([refused, w.logs]);
    expect(text).not.toContain("nova-gh");
    expect(text).not.toContain(`"githubUserId"`);
    expect(w.logs.filter((line) => line.event === "cloud.github_trial_unlocked")).toHaveLength(1);
  });

  it("lets two companies racing on one GitHub account through the callback unlock only one trial (L2-8)", async () => {
    const w = world();
    const nova = await w.signIn(NOVA), bob = await w.signIn(BOB);
    w.overrides.set(`POST ${CLAIM}`, () => respond(200, { status: "connected", alreadyConnected: false, installation: { installationId: 90, accountLogin: "bee", accountType: "Organization" }, githubUser: { id: NOVA.githubUserId, login: "nova-gh" } }));
    const [one, two] = await Promise.all([w.connect(nova), w.connect(bob)]);
    await Promise.all([
      w.callback({ state: one.state, code: CODES.connected, installation_id: "90" }, { session: nova.cookie, binder: one.binder }),
      w.callback({ state: two.state, code: CODES.connected, installation_id: "90" }, { session: bob.cookie, binder: two.binder }),
    ]);
    const answers = await Promise.all([w.api(nova, "POST", "/github/connect/result", {}), w.api(bob, "POST", "/github/connect/result", {})]);
    expect(answers.filter((answer) => (answer.body as { trialUsed?: boolean }).trialUsed === true)).toHaveLength(1);
    const holders = (await Promise.all([A, B].map((company) => w.companies.trial(company)))).filter((trial) => trial !== undefined);
    expect(holders).toHaveLength(1);
  });

  it("applies to a choice too, and never fails a connection when the record can't be written", async () => {
    const w = world();
    await w.companies.unlockTrial(NOVA.githubUserId, B, new Date(START).toISOString());
    const nova = await w.signIn(NOVA);
    const { binder, state } = await w.connect(nova);
    await w.callback({ state, code: CODES.choose }, { session: nova.cookie, binder });
    expect((await w.api(nova, "POST", "/github/choose", { installationId: 11 })).body).toMatchObject({ status: "connected", trialUsed: true });
    w.companies.unlockTrial = async () => { throw new Error("table down"); };
    const again = await w.connect(nova);
    await w.callback({ state: again.state, code: CODES.connected, installation_id: "5" }, { session: nova.cookie, binder: again.binder });
    expect((await w.api(nova, "POST", "/github/connect/result", {})).body).toEqual({ status: "connected", alreadyConnected: false, accountLogin: "acme", accountType: "Organization" });
    expect(w.logs.some((line) => line.event === "cloud.github_trial_check_failed")).toBe(true);
  });
});

describe("the company's GitHub connections (GET /v1/app/github/connections)", () => {
  it("answers each company only its own, as Code reads them for the person; no company is ever sent", async () => {
    const w = world();
    const nova = await w.signIn(NOVA), bob = await w.signIn(BOB), max = await w.signIn(MAX);
    const novas = await w.connect(nova);
    await w.callback({ state: novas.state, code: CODES.connected, installation_id: "77" }, { session: nova.cookie, binder: novas.binder });
    const bobs = await w.connect(bob);
    await w.callback({ state: bobs.state, code: CODES.connected, installation_id: "88" }, { session: bob.cookie, binder: bobs.binder });
    const at = new Date(START).toISOString();
    expect((await w.api(nova, "GET", "/github/connections")).body).toEqual({ installations: [{ installationId: 77, accountLogin: "acct77", connectedAt: at, connectedBy: { kind: "person", name: "nova" } }] });
    expect((await w.api(max, "GET", "/github/connections")).body).toEqual({ installations: [{ installationId: 77, accountLogin: "acct77", connectedAt: at, connectedBy: { kind: "person", name: "max" } }] });
    expect((await w.api(bob, "GET", "/github/connections")).body).toEqual({ installations: [{ installationId: 88, accountLogin: "acct88", connectedAt: at, connectedBy: { kind: "person", name: "bob" } }] });
    const reads = w.codeCalls("/v1/dev/company/github");
    expect(reads.map((call) => [call.token, call.search, call.body])).toEqual([["tok-nova", "", undefined], ["tok-max", "", undefined], ["tok-bob", "", undefined]]);
    const sent = JSON.stringify(w.calls);
    expect(sent).not.toContain("companyId\":\"org_");
    expect(w.calls.every((call) => !call.search.includes("company"))).toBe(true);
  });

  it("says 'Connecting GitHub isn't available yet.' while Code has no such route, and a fixed sentence when it can't answer", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    w.overrides.set("GET /v1/dev/company/github", () => respond(404, { error: { code: "NOT_FOUND", message: "route not found" } }));
    expect(await w.api(nova, "GET", "/github/connections")).toMatchObject({ status: 404, body: { error: { message: "Connecting GitHub isn't available yet." } } });
    w.overrides.set("GET /v1/dev/company/github", () => respond(200, { installations: [{ installationId: 1, accountLogin: "a b", connectedAt: "x", connectedBy: {} }] }));
    expect(await w.api(nova, "GET", "/github/connections")).toMatchObject({ status: 503, body: { error: { message: GITHUB_WORDS.connectionsUnavailable } } });
  });
});

describe("nothing secret leaks", () => {
  it("keeps the state, GitHub's code, the ticket and the cookie out of every log line, page, landing address and stored row's plain text", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const pages: string[] = [];
    const secrets: string[] = [];
    // A connected path, a choose path (with its ticket), a refused path, and a wrong-state path.
    for (const code of [CODES.connected, CODES.choose, CODES.taken]) {
      const { binder, state } = await w.connect(nova);
      secrets.push(state, binder);
      const back = await w.callback({ state, code, installation_id: "77", setup_action: "install" }, { session: nova.cookie, binder });
      pages.push(back.location ?? "", back.body, back.setCookie ?? "");
      pages.push(JSON.stringify((await w.api(nova, "POST", "/github/connect/result", {})).body));
    }
    const wrong = await w.connect(nova);
    secrets.push(wrong.binder, wrong.state);
    const back = await w.callback({ state: "Z".repeat(43), code: "ghcode-secret-zzz" }, { session: nova.cookie, binder: wrong.binder });
    pages.push(back.location ?? "", back.body);
    const ticketRow = w.pendingWrites.map(([, row]) => row.github?.result).find((result) => result?.status === "choose") as { ticket: string } | undefined;
    expect(ticketRow?.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    secrets.push(ticketRow!.ticket, CODES.connected, CODES.choose, CODES.taken, "ghcode-secret-zzz", "Z".repeat(43));
    // Positive control: the paths ran (connected, choose, taken, a refusal).
    expect(w.logs.map((line) => line.event)).toEqual(expect.arrayContaining(["cloud.github_claimed", "cloud.github_claim_refused", "cloud.github_callback_refused"]));
    const logged = JSON.stringify(w.logs), shown = pages.join("\n");
    for (const value of secrets) {
      for (const form of [value, encodeURIComponent(value), Buffer.from(value).toString("base64")]) {
        expect(logged, `log has ${form}`).not.toContain(form);
        expect(shown, `page has ${form}`).not.toContain(form);
      }
    }
    // Rows keep hashes, not the state or binder (the ticket is sealed with the row in the deployed store).
    const rows = JSON.stringify(w.pendingWrites.map(([key, row]) => [key, { ...row, github: { ...row.github, result: undefined } }]));
    for (const value of secrets.filter((value) => value !== ticketRow!.ticket)) expect(rows).not.toContain(value);
  });
});
