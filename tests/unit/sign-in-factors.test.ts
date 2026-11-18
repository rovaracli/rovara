// L4-MF4, Cloud's half (sign-in-factors.ts): GET /v1/app/me/sign-in-factors passes Code's GET /v1/dev/me/sign-in-factors through AS THE PERSON. The browser's own words
// (path ids, query, body) are never forwarded; Code's answer is rebuilt into the fixed shape (masked email only, at most 10 passkeys of an opaque id and times); Code's
// refusals become Cloud's fixed words, and a Code that does not serve the route is "not connected yet" (501 NOT_ON_CODE_YET), which the account page hides.
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, SIGN_IN_FACTOR_WORDS, createCloudHandler, type CloudRequest } from "../../packages/cloud-server/src/index.js";

const CODE = "https://code.example.test";
const ORIGIN = "https://cloud.example.test";
const START = Date.parse("2026-11-17T12:00:00.000Z");
const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const id64 = (name: string) => createHash("sha256").update(name).digest("hex");
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: "none" })}.${b64(claims)}.sig`;

interface Person { key: string; developerId: string; token: string }
const person = (key: string): Person => ({ key, developerId: id64(key), token: jwt({ sub: key }) });
const NOVA = person("nova"), BOB = person("bob");
const GOOD = { credentialId: "key-one", createdAt: "2026-10-01T00:00:00.000Z" };
type Factors = { factorEmail?: unknown; passkeys?: unknown; secret?: unknown };

function world() {
  const calls: Array<{ method: string; path: string; search: string; token?: string; body?: string }> = [];
  const factors = new Map<string, Factors>([
    [NOVA.developerId, { factorEmail: "n***@acme.test", passkeys: [{ ...GOOD, lastUsedAt: "2026-11-01T00:00:00.000Z" }] }],
    [BOB.developerId, { factorEmail: "b***@other.test", passkeys: [{ ...GOOD, credentialId: "key-bob" }] }],
  ]);
  let override: (() => Response) | undefined;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const token = (init?.headers as Record<string, string> | undefined)?.authorization?.replace(/^Bearer /u, "");
    calls.push({ method: init?.method ?? "GET", path: url.pathname, search: url.search, ...(token === undefined ? {} : { token }), ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (url.pathname === "/v1/auth/token") return respond(400, { error: "invalid_grant" });
    if (override !== undefined) return override();
    const who = [NOVA, BOB].find((one) => one.token === token);
    if (who === undefined) return respond(401, { error: { code: "AUTH_REQUIRED" } });
    if (url.pathname === "/v1/dev/me/sign-in-factors" && (init?.method ?? "GET") === "GET") return respond(200, factors.get(who.developerId));
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
  const api = async (who: Who | undefined, method: string, target: string, body?: string) => {
    const url = new URL(`/v1/web${target}`, ORIGIN);
    const headers: Record<string, string> = who === undefined ? {} : { cookie: `rovara_cloud_session=${who.cookie}`, "x-rovara-csrf": `csrf-${who.person.key}`, "content-type": "application/json" };
    const request: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers, ...(body === undefined ? {} : { body }) };
    const answer = (await handler(request))!;
    return { status: answer.status, body: JSON.parse(answer.body) as Record<string, unknown> & { error?: { code: string; message: string } } };
  };
  const codeCalls = () => calls.filter((call) => call.path === "/v1/dev/me/sign-in-factors");
  return { api, signIn, calls, codeCalls, factors, logs, override: (next: (() => Response) | undefined) => { override = next; } };
}

describe("GET /v1/app/me/sign-in-factors (L4-MF4)", () => {
  it("needs a sign-in, and answers Code's masked email and passkeys as the person", async () => {
    const w = world();
    expect((await w.api(undefined, "GET", "/me/sign-in-factors")).status).toBe(401);
    expect(w.codeCalls()).toEqual([]);
    const nova = await w.signIn(NOVA);
    expect(await w.api(nova, "GET", "/me/sign-in-factors")).toEqual({ status: 200, body: { factorEmail: "n***@acme.test", passkeys: [{ ...GOOD, lastUsedAt: "2026-11-01T00:00:00.000Z" }] } });
    expect(w.codeCalls()).toEqual([{ method: "GET", path: "/v1/dev/me/sign-in-factors", search: "", token: NOVA.token }]);
  });

  it("is the caller's only: two people each read their own, and nothing the browser sends is forwarded or names a person", async () => {
    const w = world();
    const nova = await w.signIn(NOVA), bob = await w.signIn(BOB);
    expect((await w.api(bob, "GET", "/me/sign-in-factors")).body).toEqual({ factorEmail: "b***@other.test", passkeys: [{ ...GOOD, credentialId: "key-bob" }] });
    const sneaky = await w.api(nova, "GET", `/me/sign-in-factors?person=${BOB.developerId}&developerId=${BOB.developerId}`, JSON.stringify({ developerId: BOB.developerId }));
    expect(sneaky.body.factorEmail).toBe("n***@acme.test");
    expect(w.codeCalls().at(-1)).toEqual({ method: "GET", path: "/v1/dev/me/sign-in-factors", search: "", token: NOVA.token });
    expect(w.codeCalls().map((call) => call.token)).toEqual([BOB.token, NOVA.token]);
  });

  it("has no member or id path, and no other method: those stay 501 and never reach Code", async () => {
    const w = await Promise.resolve(world());
    const nova = await w.signIn(NOVA);
    for (const [method, target] of [["GET", `/org/members/${BOB.developerId}/sign-in-factors`], ["GET", `/me/sign-in-factors/${BOB.developerId}`], ["GET", `/me/${BOB.developerId}/sign-in-factors`]] as const) {
      expect((await w.api(nova, method, target)).status, `${method} ${target}`).toBe(501);
    }
    for (const method of ["POST", "PUT", "DELETE"]) expect((await w.api(nova, method, "/me/sign-in-factors", method === "DELETE" ? undefined : "{}")).status, method).toBe(501);
    expect(w.codeCalls()).toEqual([]);
  });

  it("omits the email when Code sends none, and answers no passkeys as an empty list", async () => {
    const w = world();
    w.factors.set(NOVA.developerId, { passkeys: [] });
    expect(await w.api(await w.signIn(NOVA), "GET", "/me/sign-in-factors")).toEqual({ status: 200, body: { passkeys: [] } });
  });

  it("rebuilds Code's answer: key material and extra fields never pass through", async () => {
    const w = world();
    w.factors.set(NOVA.developerId, { factorEmail: "n***@acme.test", secret: "S", passkeys: [{ ...GOOD, publicKey: "PUB", counter: 3, transports: ["usb"] }] });
    const answer = await w.api(await w.signIn(NOVA), "GET", "/me/sign-in-factors");
    expect(answer).toEqual({ status: 200, body: { factorEmail: "n***@acme.test", passkeys: [GOOD] } });
    expect(JSON.stringify(answer.body)).not.toMatch(/PUB|counter|transports|secret/u);
  });

  it("an answer that does not read is a fixed 503 that echoes nothing: a full address, a half-masked one, too many passkeys, a bad id or time", async () => {
    const bad: Array<Factors | string> = [
      { factorEmail: "nova@acme.test", passkeys: [] }, { factorEmail: "n***va@acme.test", passkeys: [] }, { factorEmail: "n***@acme.test other@acme.test", passkeys: [] }, { factorEmail: 5, passkeys: [] },
      { passkeys: Array.from({ length: 11 }, (_, index) => ({ ...GOOD, credentialId: `k${String(index)}` })) },
      { passkeys: [{ ...GOOD, credentialId: "has space" }] }, { passkeys: [{ ...GOOD, credentialId: "a".repeat(513) }] }, { passkeys: [{ ...GOOD, createdAt: "yesterday" }] },
      { passkeys: [{ ...GOOD, lastUsedAt: 9 }] }, { passkeys: "none" }, "just words", { factorEmail: "n***@acme.test" },
    ];
    for (const body of bad) {
      const w = world();
      w.override(() => respond(200, body));
      const answer = await w.api(await w.signIn(NOVA), "GET", "/me/sign-in-factors");
      expect(answer, JSON.stringify(body)).toEqual({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: SIGN_IN_FACTOR_WORDS.unavailable } } });
      expect(JSON.stringify(answer.body)).not.toContain("acme.test");
    }
  });

  it("Code's refusals become Cloud's fixed words; a Code without the route is 'not connected yet'; Code's own words never pass through", async () => {
    const cases: Array<[Response, number, string, string]> = [
      [respond(404, { error: { code: "NOT_FOUND", message: "route not found maya@example.test" } }), 501, "NOT_ON_CODE_YET", SIGN_IN_FACTOR_WORDS.notOnCode],
      [respond(405, {}), 501, "NOT_ON_CODE_YET", SIGN_IN_FACTOR_WORDS.notOnCode],
      [respond(501, {}), 501, "NOT_ON_CODE_YET", SIGN_IN_FACTOR_WORDS.notOnCode],
      [respond(500, { error: { code: "X", message: "SECRET maya@example.test" } }), 503, "RUNTIME_UNAVAILABLE", SIGN_IN_FACTOR_WORDS.unavailable],
      [respond(503, { error: { code: "RUNTIME_UNAVAILABLE", message: "SECRET maya@example.test" } }), 503, "RUNTIME_UNAVAILABLE", SIGN_IN_FACTOR_WORDS.unavailable],
      [respond(403, { error: { code: "FORBIDDEN", message: "SECRET maya@example.test" } }), 503, "RUNTIME_UNAVAILABLE", SIGN_IN_FACTOR_WORDS.unavailable],
    ];
    for (const [response, status, code, message] of cases) {
      const w = world();
      w.override(() => response.clone());
      const answer = await w.api(await w.signIn(NOVA), "GET", "/me/sign-in-factors");
      expect(answer, String(response.status)).toEqual({ status, body: { error: { code, message } } });
      expect(JSON.stringify(answer)).not.toContain("SECRET");
      // The refusal is logged by status only.
      expect(w.logs.filter((entry) => entry.event === "cloud.sign_in_factors_refused")).toEqual([{ event: "cloud.sign_in_factors_refused", status: response.status, developerId: NOVA.developerId }]);
    }
  });
});
