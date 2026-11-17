// DEC 254w, Cloud's half of account linking (sign-in-links.ts): "Connected sign-ins" on a pretend Rovara Code that keeps Code's rules (a start needs a fresh
// step-up and Cloud's registered redirect URL; a finish needs the one-time code, the PKCE verifier and the same token; the first method is never removed;
// an unlink ends every sign-in of the person). The link return arrives at Cloud's sign-in callback, so it must be told apart from a sign-in, and it may finish
// a link only for the browser sign-in that started it, once, with the state it was started with. Fixed words only; Code's other words never pass through.
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CodeClient, LINK_TTL_MS, LocalSessionStore, LocalWorkSessionStore, SIGN_IN_LINK_WORDS, createCloudHandler, linkPendingKey, type CloudRequest, type PendingSignIn } from "../../packages/cloud-server/src/index.js";

const CODE = "https://code.example.test";
const ORIGIN = "https://cloud.example.test";
const REDIRECT = `${ORIGIN}/callback`;
const START = Date.parse("2026-11-17T12:00:00.000Z");
const NOW_S = Math.floor(START / 1000);
const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const id64 = (name: string) => createHash("sha256").update(name).digest("hex");
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: "none" })}.${b64(claims)}.sig`;
const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

interface Person { key: string; developerId: string; token: string; primary: string }
const person = (key: string, primary: string, stepUpAge?: number): Person => ({
  key, developerId: id64(key), primary, token: jwt({ sub: key, ...(stepUpAge === undefined ? {} : { step_up_at: NOW_S - stepUpAge, step_up_amr: "passkey" }) }),
});
const NOVA = person("nova", "github", 30);
const NOVA_PLAIN = { ...person("nova", "github"), key: "nova-plain", token: jwt({ sub: "nova-plain" }) };
const BOB = person("bob", "slack", 30);
const PEOPLE = [NOVA, NOVA_PLAIN, BOB];
const forbidden = (message: string) => respond(403, { error: { code: "FORBIDDEN", message } });
const WORDS = { codeRefused: "That sign-in can't be connected to your account.", codeLast: "This is the first way this person signs in, so it can't be removed.", codeNotConnected: "That sign-in is not connected." };

function world() {
  let clock = START;
  const calls: Array<{ method: string; path: string; token?: string; body?: Record<string, unknown> }> = [];
  const linked = new Map<string, Map<string, string>>(); // developerId -> method -> linkedAt
  const links = new Map<string, { developerId: string; method: string; challenge: string; state: string; code: string; finished: boolean }>();
  const ended = new Set<string>();
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
    if (who === undefined || ended.has(who.developerId)) return respond(401, { error: { code: "AUTH_REQUIRED" } });
    const p = url.pathname;
    const mine = () => { let m = linked.get(who.developerId); if (m === undefined) { m = new Map(); linked.set(who.developerId, m); } return m; };
    const fresh = () => token !== undefined && who.token === token && /step_up_at/u.test(Buffer.from(token.split(".")[1]!, "base64url").toString());
    if (p === "/v1/dev/access") return respond(200, { developerId: who.developerId, displayName: who.key, administrator: false, projects: [], notices: [] });
    if (p === "/v1/dev/me/sign-ins" && method === "GET") {
      return respond(200, { signIns: [{ method: who.primary, primary: true, secret: "x" }, ...[...mine()].map(([m, at]) => ({ method: m, primary: false, linkedAt: at }))] });
    }
    if (p === "/v1/dev/me/sign-ins/link" && method === "POST") {
      const keys = Object.keys(body ?? {}).sort().join(",");
      if (keys !== "challenge,method,returnTo,state" || !/^[A-Za-z0-9_-]{43,128}$/u.test(String(body!.challenge)) || !/^[A-Za-z0-9_-]{16,128}$/u.test(String(body!.state)) || !["slack", "github"].includes(String(body!.method))) return respond(400, { error: { code: "CONFIG_INVALID", message: "bad" } });
      if (!fresh()) return respond(403, { error: { code: "REAUTH_REQUIRED", message: "stale" } });
      if (body!.returnTo !== REDIRECT || body!.method === who.primary || mine().has(String(body!.method))) return forbidden(WORDS.codeRefused);
      const id = `lnk_${randomBytes(32).toString("base64url")}`;
      links.set(id, { developerId: who.developerId, method: String(body!.method), challenge: String(body!.challenge), state: String(body!.state), code: `lnc_${randomBytes(32).toString("base64url")}`, finished: false });
      return respond(200, { authorizeUrl: `https://${body!.method === "slack" ? "slack.com/openid/connect/authorize" : "github.com/login/oauth/authorize"}?state=${id}`, linkId: id });
    }
    if (p === "/v1/dev/me/sign-ins/link/finish" && method === "POST") {
      const link = links.get(String(body?.linkId));
      if (link === undefined || link.finished || link.developerId !== who.developerId || link.code !== body?.linkCode || s256(String(body?.verifier)) !== link.challenge) return forbidden(WORDS.codeRefused);
      link.finished = true;
      mine().set(link.method, new Date(clock).toISOString());
      return respond(200, { method: link.method });
    }
    const del = /^\/v1\/dev\/me\/sign-ins\/([a-z]+)$/u.exec(p);
    if (del !== null && method === "DELETE") {
      if (!fresh()) return respond(403, { error: { code: "REAUTH_REQUIRED", message: "stale" } });
      if (del[1] === who.primary) return forbidden(WORDS.codeLast);
      if (!mine().delete(del[1]!)) return respond(404, { error: { code: "NOT_FOUND", message: WORDS.codeNotConnected } });
      ended.add(who.developerId); // Code ends every sign-in of the person
      return respond(200, { removed: true });
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
  const FINISH = "/v1/dev/me/sign-ins/link/finish";
  /** Starts a link and returns what Code was sent (so the test can play Code's return as the browser would). */
  const start = async (who: Who, method = "slack") => {
    const answer = await api(who, "POST", "/me/sign-ins/link", { method });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const sent = codeCalls("/v1/dev/me/sign-ins/link").at(-1)!.body!;
    const linkId = new URL(String(answer.body.authorizeUrl)).searchParams.get("state")!;
    return { answer, state: String(sent.state), linkId, code: links.get(linkId)!.code };
  };
  const callback = async (query: string, sessionCookie?: string) => {
    const answer = await raw("GET", `/callback?${query}`, sessionCookie === undefined ? {} : { cookie: `rovara_cloud_session=${sessionCookie}` });
    return { status: answer.status, location: answer.headers.location, setCookie: answer.headers["set-cookie"], headers: answer.headers, body: answer.body };
  };
  const good = (s: { state: string; linkId: string; code: string }) => `state=${s.state}&link_id=${s.linkId}&link_code=${s.code}`;
  return { raw, api, signIn, start, callback, good, calls, codeCalls, logs, pendingWrites, overrides, sessions, linked, ended, FINISH, advance: (ms: number) => { clock += ms; } };
}

describe("connect a sign-in: start (POST /v1/app/me/sign-ins/link)", () => {
  it("asks Code as the person with a valid S256 challenge, Cloud's registered redirect URL and a state, keeps the pending link for this browser's sign-in, and answers only the provider's address", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const { answer, state, linkId } = await w.start(nova, "slack");
    const call = w.codeCalls("/v1/dev/me/sign-ins/link")[0]!;
    expect(call).toMatchObject({ method: "POST", token: NOVA.token });
    expect(Object.keys(call.body!).sort()).toEqual(["challenge", "method", "returnTo", "state"]);
    expect(call.body).toMatchObject({ method: "slack", returnTo: REDIRECT });
    expect(String(call.body!.challenge)).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(state).toMatch(/^[A-Za-z0-9_-]{16,128}$/u);
    expect(Object.keys(answer.body)).toEqual(["authorizeUrl"]);
    expect(answer.headers["set-cookie"]).toBeUndefined();
    // The verifier, the state and the link id are never in the answer.
    const [key, pending] = w.pendingWrites[0]!;
    expect(key).toBe(linkPendingKey(nova.cookie));
    expect(s256(pending.verifier)).toBe(call.body!.challenge);
    expect(pending.link).toEqual({ method: "slack", developerId: NOVA.developerId, stateHash: createHash("sha256").update(state).digest("hex"), linkId });
    for (const secret of [pending.verifier, state]) expect(JSON.stringify(answer.body)).not.toContain(secret);
    expect(JSON.stringify(answer.body)).not.toContain(pending.verifier);
    expect(JSON.stringify(pending)).not.toContain(state);
    expect(key).not.toContain(nova.cookie);
  });

  it("takes exactly one linkable method; anything else is refused before Code is asked", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    for (const body of [{}, { method: "email" }, { method: "oidc" }, { method: "slack", returnTo: "https://evil.example" }, { method: "slack", challenge: "x".repeat(43) }, { method: ["slack"] }, [], "slack", null]) {
      const answer = await w.api(nova, "POST", "/me/sign-ins/link", body);
      expect(answer, JSON.stringify(body)).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID", message: SIGN_IN_LINK_WORDS.invalid } } });
    }
    expect((await w.api(nova, "POST", "/me/sign-ins/link", undefined, "{nope")).status).toBe(400);
    expect(w.codeCalls("/v1/dev/me/sign-ins/link")).toEqual([]);
    expect(w.pendingWrites).toEqual([]);
  });

  it("passes Code's need for a fresh sign-in on (REAUTH_REQUIRED) and keeps nothing", async () => {
    const w = world();
    const plain = await w.signIn(NOVA_PLAIN);
    const answer = await w.api(plain, "POST", "/me/sign-ins/link", { method: "slack" });
    expect(answer).toMatchObject({ status: 403, body: { error: { code: "REAUTH_REQUIRED", message: SIGN_IN_LINK_WORDS.reauth } } });
    expect(w.pendingWrites).toEqual([]);
  });

  it("says Code's refusal in fixed words only, 501 when Code does not serve the routes, and keeps nothing", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    expect(await w.api(nova, "POST", "/me/sign-ins/link", { method: "github" })).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN", message: SIGN_IN_LINK_WORDS.refused } } });
    const cases: Array<[Response, number, string, string]> = [
      [respond(404, { error: { code: "NOT_FOUND", message: "route not found" } }), 501, "NOT_ON_CODE_YET", SIGN_IN_LINK_WORDS.notOnCode],
      [respond(404, { error: { code: "NOT_FOUND", message: "connecting sign-ins is not set up in this deployment" } }), 501, "NOT_ON_CODE_YET", SIGN_IN_LINK_WORDS.notOnCode],
      [forbidden("arn:aws:iam::1:role/secret boom"), 403, "FORBIDDEN", SIGN_IN_LINK_WORDS.refused],
      [respond(503, { error: { code: "RUNTIME_UNAVAILABLE", message: "stack trace <script>" } }), 503, "RUNTIME_UNAVAILABLE", SIGN_IN_LINK_WORDS.unavailable],
      [respond(500, "boom"), 503, "RUNTIME_UNAVAILABLE", SIGN_IN_LINK_WORDS.unavailable],
    ];
    for (const [response, status, code, message] of cases) {
      w.overrides.set("POST /v1/dev/me/sign-ins/link", () => response.clone());
      expect(await w.api(nova, "POST", "/me/sign-ins/link", { method: "slack" })).toMatchObject({ status, body: { error: { code, message } } });
    }
    expect(w.pendingWrites).toEqual([]);
  });

  it("refuses a provider address that is not https on the method's own host, and an unreadable link id, keeping nothing", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const id = `lnk_${"a".repeat(43)}`;
    const bad = ["https://evil.example/x", "https://slack.com.evil.example/x", "http://slack.com/x", "https://user:pw@slack.com/x", "https://slack.com:8443/x", "https://slack.com/x#f", "https://github.com/x", "javascript:alert(1)", "not a url"];
    for (const authorizeUrl of bad) {
      w.overrides.set("POST /v1/dev/me/sign-ins/link", () => respond(200, { authorizeUrl, linkId: id }));
      expect(await w.api(nova, "POST", "/me/sign-ins/link", { method: "slack" }), authorizeUrl).toMatchObject({ status: 503, body: { error: { message: SIGN_IN_LINK_WORDS.unavailable } } });
    }
    w.overrides.set("POST /v1/dev/me/sign-ins/link", () => respond(200, { authorizeUrl: "https://slack.com/x", linkId: "lnk_short" }));
    expect((await w.api(nova, "POST", "/me/sign-ins/link", { method: "slack" })).status).toBe(503);
    expect(w.pendingWrites).toEqual([]);
  });

  it("needs a sign-in and the CSRF token", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    expect((await w.raw("POST", "/v1/web/me/sign-ins/link", { cookie: `rovara_cloud_session=${nova.cookie}` }, JSON.stringify({ method: "slack" }))).status).toBe(403);
    expect((await w.raw("POST", "/v1/web/me/sign-ins/link", {}, JSON.stringify({ method: "slack" }))).status).toBe(401);
    expect(w.codeCalls("/v1/dev/me/sign-ins/link")).toEqual([]);
  });
});

describe("connect a sign-in: the link return (the registered callback with link_* words)", () => {
  it("with the stored state, finishes once with the stored verifier as the same sign-in, clears the pending link, and lands on the account page with one fixed word", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const s = await w.start(nova, "slack");
    const verifier = w.pendingWrites[0]![1].verifier;
    const back = await w.callback(w.good(s), nova.cookie);
    expect(back).toMatchObject({ status: 302, location: "/app/account?linked=slack" });
    expect(back.setCookie).toBeUndefined();
    expect(w.codeCalls(w.FINISH)).toEqual([{ method: "POST", path: w.FINISH, token: NOVA.token, body: { linkId: s.linkId, linkCode: s.code, verifier } }]);
    expect(w.codeCalls("/v1/auth/token")).toEqual([]);
    expect(w.linked.get(NOVA.developerId)?.has("slack")).toBe(true);
    // The pending link is gone.
    expect(await w.sessions.takePending(linkPendingKey(nova.cookie))).toBeUndefined();
    expect((await w.api(nova, "GET", "/me/sign-ins")).body.signIns).toEqual([{ method: "github", primary: true }, { method: "slack", primary: false, linkedAt: new Date(START).toISOString() }]);
  });

  it("does not finish for a wrong, missing, repeated or malformed state, and the pending link is spent either way", async () => {
    for (const bad of [(s: { linkId: string; code: string }) => `state=${"A".repeat(32)}&link_id=${s.linkId}&link_code=${s.code}`, (s: { linkId: string; code: string }) => `link_id=${s.linkId}&link_code=${s.code}`,
      (s: { state: string; linkId: string; code: string }) => `state=${s.state}&state=${s.state}&link_id=${s.linkId}&link_code=${s.code}`, (s: { linkId: string; code: string }) => `state=short&link_id=${s.linkId}&link_code=${s.code}`]) {
      const w = world();
      const nova = await w.signIn(NOVA);
      const s = await w.start(nova, "slack");
      expect(await w.callback(bad(s), nova.cookie)).toMatchObject({ status: 302, location: "/app/account?link=failed" });
      expect(w.codeCalls(w.FINISH)).toEqual([]);
      // Spent: the right return afterwards finds nothing.
      expect(await w.callback(w.good(s), nova.cookie)).toMatchObject({ location: "/app/account?link=failed" });
      expect(w.codeCalls(w.FINISH)).toEqual([]);
    }
  });

  it("does not finish from a browser whose sign-in did not start the link (another person, the same person's other sign-in, no sign-in at all)", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const novaElsewhere = await w.signIn(NOVA);
    const bob = await w.signIn(BOB);
    const s = await w.start(nova, "slack");
    for (const cookie of [bob.cookie, novaElsewhere.cookie, undefined, "x".repeat(43)]) {
      expect(await w.callback(w.good(s), cookie)).toMatchObject({ status: 302, location: "/app/account?link=failed" });
    }
    expect(w.codeCalls(w.FINISH)).toEqual([]);
    // The starter's own pending link is untouched by the others, so the starter can still finish.
    expect(await w.callback(w.good(s), nova.cookie)).toMatchObject({ location: "/app/account?linked=slack" });
    expect(w.codeCalls(w.FINISH)).toHaveLength(1);
  });

  it("does not finish when the sign-in under that cookie is no longer the person who started the link", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const s = await w.start(nova, "slack");
    await w.sessions.delete(nova.cookie);
    await w.sessions.create(nova.cookie, { accessToken: BOB.token, access: { developerId: BOB.developerId, displayName: "bob", administrator: false, projects: [], notices: [] }, csrf: "csrf-bob", signedInAt: new Date(START).toISOString() });
    expect((await w.callback(w.good(s), nova.cookie)).location).toBe("/app/account?link=failed");
    expect(w.codeCalls(w.FINISH)).toEqual([]);
  });

  it("answers every link return, whatever it decides, with no-referrer and no-store", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const s = await w.start(nova, "slack");
    const returns = [await w.callback(w.good(s), undefined), await w.callback(`state=${"A".repeat(32)}&link_error=cancelled`, nova.cookie), await w.callback(w.good(s), nova.cookie)];
    const t = await w.start(nova, "slack");
    returns.push(await w.callback(w.good(t), nova.cookie));
    expect(returns.map((r) => r.location)).toEqual(["/app/account?link=failed", "/app/account?link=failed", "/app/account?link=failed", "/app/account?linked=slack"]);
    for (const one of returns) {
      expect(one.headers["referrer-policy"]).toBe("no-referrer");
      expect(one.headers["cache-control"]).toBe("no-store");
    }
  });

  it("does not finish a replayed return", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const s = await w.start(nova, "slack");
    expect((await w.callback(w.good(s), nova.cookie)).location).toBe("/app/account?linked=slack");
    expect((await w.callback(w.good(s), nova.cookie)).location).toBe("/app/account?link=failed");
    expect(w.codeCalls(w.FINISH)).toHaveLength(1);
  });

  it("never finishes on a link_error, and lands on one fixed word", async () => {
    for (const [error, word] of [["cancelled", "cancelled"], ["refused", "refused"], ["failed", "failed"], ["<script>", "failed"], ["", "failed"]] as const) {
      const w = world();
      const nova = await w.signIn(NOVA);
      const s = await w.start(nova, "slack");
      const back = await w.callback(`state=${s.state}&link_error=${encodeURIComponent(error)}`, nova.cookie);
      expect(back.location, error).toBe(`/app/account?link=${word}`);
      expect(w.codeCalls(w.FINISH)).toEqual([]);
    }
    // An error together with a code is not a return Cloud believes.
    const w = world();
    const nova = await w.signIn(NOVA);
    const s = await w.start(nova, "slack");
    expect((await w.callback(`${w.good(s)}&link_error=cancelled`, nova.cookie)).location).toBe("/app/account?link=failed");
    expect(w.codeCalls(w.FINISH)).toEqual([]);
  });

  it("does not finish for another link's id, a malformed id or code, a missing code, or an expired link", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    for (const make of [(s: { state: string; code: string }) => `state=${s.state}&link_id=lnk_${"b".repeat(43)}&link_code=${s.code}`, (s: { state: string; linkId: string }) => `state=${s.state}&link_id=${s.linkId}&link_code=nope`,
      (s: { state: string; linkId: string }) => `state=${s.state}&link_id=${s.linkId}`, (s: { state: string; code: string }) => `state=${s.state}&link_code=${s.code}`]) {
      const s = await w.start(nova, "slack");
      expect((await w.callback(make(s), nova.cookie)).location).toBe("/app/account?link=failed");
    }
    const late = await w.start(nova, "slack");
    w.advance(LINK_TTL_MS + 1000);
    expect((await w.callback(w.good(late), nova.cookie)).location).toBe("/app/account?link=failed");
    expect(w.codeCalls(w.FINISH)).toEqual([]);
  });

  it("answers Code's refusals of the finish with fixed words and never signs anyone in", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    for (const [response, word] of [[forbidden("anything"), "refused"], [respond(503, {}), "failed"], [respond(200, { method: "github" }), "failed"], [respond(200, "x"), "failed"]] as const) {
      const s = await w.start(nova, "slack");
      w.overrides.set("POST /v1/dev/me/sign-ins/link/finish", () => response.clone());
      const back = await w.callback(w.good(s), nova.cookie);
      expect(back.location).toBe(`/app/account?link=${word}`);
      expect(back.body).toBe("");
    }
    expect(w.codeCalls("/v1/auth/token")).toEqual([]);
  });

  it("ends the sign-in when Code no longer knows it, and still lands on a fixed word", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const s = await w.start(nova, "slack");
    w.ended.add(NOVA.developerId);
    expect((await w.callback(w.good(s), nova.cookie)).location).toBe("/app/account?link=failed");
    expect(await w.sessions.get(nova.cookie)).toBeUndefined();
  });

  it("is never read as a sign-in: a callback without link words still is one", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    await w.start(nova, "slack");
    const answer = await w.callback("state=nothing-pending&code=abc", nova.cookie);
    expect(answer.status).toBe(400);
    expect(w.codeCalls(w.FINISH)).toEqual([]);
  });
});

describe("connected sign-ins: the list (GET /v1/app/me/sign-ins)", () => {
  it("lists the person's own methods, rebuilt field by field, with the methods Cloud can connect", async () => {
    const w = world();
    const nova = await w.signIn(NOVA), bob = await w.signIn(BOB);
    expect((await w.api(nova, "GET", "/me/sign-ins")).body).toEqual({ signIns: [{ method: "github", primary: true }], linkable: ["slack", "github"] });
    expect((await w.api(bob, "GET", "/me/sign-ins")).body).toEqual({ signIns: [{ method: "slack", primary: true }], linkable: ["slack", "github"] });
    expect(w.codeCalls("/v1/dev/me/sign-ins").map((call) => call.token)).toEqual([NOVA.token, BOB.token]);
  });

  it("answers 501 when Code serves no such route, and fixed words for anything unreadable", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    for (const message of ["route not found", "connecting sign-ins is not set up in this deployment"]) {
      w.overrides.set("GET /v1/dev/me/sign-ins", () => respond(404, { error: { code: "NOT_FOUND", message } }));
      expect(await w.api(nova, "GET", "/me/sign-ins")).toMatchObject({ status: 501, body: { error: { code: "NOT_ON_CODE_YET" } } });
    }
    for (const body of [{}, { signIns: "x" }, { signIns: [{ method: "<b>", primary: true }] }, { signIns: [{ method: "slack", primary: "yes" }] }, { signIns: [{ method: "slack", primary: false, linkedAt: "soon" }] }]) {
      w.overrides.set("GET /v1/dev/me/sign-ins", () => respond(200, body));
      expect(await w.api(nova, "GET", "/me/sign-ins"), JSON.stringify(body)).toMatchObject({ status: 503, body: { error: { message: SIGN_IN_LINK_WORDS.unavailable } } });
    }
  });
});

describe("connected sign-ins: unlink (DELETE /v1/app/me/sign-ins/{method})", () => {
  it("passes the unlink to Code as the person with no body, and answers { removed: true }", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const s = await w.start(nova, "slack");
    await w.callback(w.good(s), nova.cookie);
    const answer = await w.api(nova, "DELETE", "/me/sign-ins/slack");
    expect(answer).toMatchObject({ status: 200, body: { removed: true } });
    expect(w.codeCalls("/v1/dev/me/sign-ins/slack")).toEqual([{ method: "DELETE", path: "/v1/dev/me/sign-ins/slack", token: NOVA.token }]);
    expect(w.linked.get(NOVA.developerId)?.has("slack")).toBe(false);
  });

  it("deletes this browser's Cloud session after a successful unlink and expires its cookie, and only then", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const other = await w.signIn(NOVA);
    const s = await w.start(nova, "slack");
    await w.callback(w.good(s), nova.cookie);
    const refused = await w.api(nova, "DELETE", "/me/sign-ins/github");
    expect(refused.status).toBe(403);
    expect(refused.headers["set-cookie"]).toBeUndefined();
    expect(await w.sessions.get(nova.cookie)).toBeDefined();
    const answer = await w.api(nova, "DELETE", "/me/sign-ins/slack");
    expect(answer.status).toBe(200);
    expect(answer.headers["set-cookie"]).toBe("rovara_cloud_session=; HttpOnly; SameSite=Lax; Path=/; Secure; Max-Age=0");
    expect(await w.sessions.get(nova.cookie)).toBeUndefined();
    // Only this browser's row is Cloud's to remove here; the other one ends when its own next call finds Code has ended it.
    expect(await w.sessions.get(other.cookie)).toBeDefined();
  });

  it("signs the person out on Cloud's next call once Code has ended every sign-in", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const s = await w.start(nova, "slack");
    await w.callback(w.good(s), nova.cookie);
    await w.api(nova, "DELETE", "/me/sign-ins/slack");
    expect(await w.api(nova, "GET", "/me/sign-ins")).toMatchObject({ status: 401, body: { error: { code: "AUTH_REQUIRED" } } });
    expect(await w.sessions.get(nova.cookie)).toBeUndefined();
  });

  it("passes REAUTH_REQUIRED, the first-method refusal and not-connected as Cloud's fixed words", async () => {
    const w = world();
    const plain = await w.signIn(NOVA_PLAIN);
    expect(await w.api(plain, "DELETE", "/me/sign-ins/slack")).toMatchObject({ status: 403, body: { error: { code: "REAUTH_REQUIRED", message: SIGN_IN_LINK_WORDS.reauth } } });
    const nova = await w.signIn(NOVA);
    expect(await w.api(nova, "DELETE", "/me/sign-ins/github")).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN", message: SIGN_IN_LINK_WORDS.lastMethod } } });
    expect(await w.api(nova, "DELETE", "/me/sign-ins/slack")).toMatchObject({ status: 404, body: { error: { code: "SIGN_IN_NOT_CONNECTED", message: SIGN_IN_LINK_WORDS.notConnected } } });
  });

  it("answers 501 when Code does not serve the route, never echoes Code's other words, and asks Code nothing for an unknown method", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    w.overrides.set("DELETE /v1/dev/me/sign-ins/slack", () => respond(404, { error: { code: "NOT_FOUND", message: "route not found" } }));
    expect(await w.api(nova, "DELETE", "/me/sign-ins/slack")).toMatchObject({ status: 501, body: { error: { code: "NOT_ON_CODE_YET" } } });
    w.overrides.set("DELETE /v1/dev/me/sign-ins/slack", () => forbidden("arn:aws:secret leak"));
    expect((await w.api(nova, "DELETE", "/me/sign-ins/slack")).body.error?.message).toBe(SIGN_IN_LINK_WORDS.forbidden);
    w.overrides.set("DELETE /v1/dev/me/sign-ins/slack", () => respond(200, { removed: false }));
    expect((await w.api(nova, "DELETE", "/me/sign-ins/slack")).status).toBe(503);
    const before = w.calls.length;
    for (const method of ["email", "oidc", "..", "x".repeat(40)]) expect((await w.api(nova, "DELETE", `/me/sign-ins/${method}`)).status, method).toBeGreaterThanOrEqual(404);
    expect(w.calls.slice(before).filter((call) => call.path.startsWith("/v1/dev/me/sign-ins/"))).toEqual([]);
  });
});
