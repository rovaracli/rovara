// L4-SRC-SL, Cloud's half (lessons-slack-switch.ts): GET and PUT /v1/app/me/lessons-slack pass Code's /v1/dev/me/lessons-slack through AS THE PERSON. Nothing of the browser's request but the checked
// `{ optOut }` is forwarded (no path id, no query, no person); Code's answer is rebuilt as `{ optOut }`; Code's refusals become Cloud's fixed words, and a Code that does not serve the route is
// "not connected yet" (501 NOT_ON_CODE_YET), which the account page hides.
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, LESSONS_SLACK_WORDS, createCloudHandler, type CloudRequest } from "../../packages/cloud-server/src/index.js";

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

function world() {
  const calls: Array<{ method: string; path: string; search: string; token?: string; body?: string }> = [];
  const switches = new Map<string, boolean>([[NOVA.developerId, false], [BOB.developerId, true]]);
  let override: (() => Response) | undefined;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const token = (init?.headers as Record<string, string> | undefined)?.authorization?.replace(/^Bearer /u, "");
    calls.push({ method: init?.method ?? "GET", path: url.pathname, search: url.search, ...(token === undefined ? {} : { token }), ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (url.pathname === "/v1/auth/token") return respond(400, { error: "invalid_grant" });
    if (override !== undefined) return override();
    const who = [NOVA, BOB].find((one) => one.token === token);
    if (who === undefined) return respond(401, { error: { code: "AUTH_REQUIRED" } });
    if (url.pathname === "/v1/dev/me/lessons-slack") {
      if ((init?.method ?? "GET") === "PUT") switches.set(who.developerId, (JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { optOut: boolean }).optOut);
      return respond(200, { optOut: switches.get(who.developerId) });
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
  const codeCalls = () => calls.filter((call) => call.path === "/v1/dev/me/lessons-slack");
  return { api, signIn, calls, codeCalls, switches, logs, override: (next: (() => Response) | undefined) => { override = next; } };
}

const PATH = "/me/lessons-slack";
describe("GET and PUT /v1/app/me/lessons-slack (L4-SRC-SL)", () => {
  it("needs a sign-in, reads the person's own switch and sets it, passing only the checked body", async () => {
    const w = world();
    expect((await w.api(undefined, "GET", PATH)).status).toBe(401);
    expect((await w.api(undefined, "PUT", PATH, JSON.stringify({ optOut: true }))).status).toBe(401);
    expect(w.codeCalls()).toEqual([]);
    const nova = await w.signIn(NOVA);
    expect(await w.api(nova, "GET", PATH)).toEqual({ status: 200, body: { optOut: false } });
    expect(await w.api(nova, "PUT", PATH, JSON.stringify({ optOut: true }))).toEqual({ status: 200, body: { optOut: true } });
    expect(w.codeCalls()).toEqual([
      { method: "GET", path: "/v1/dev/me/lessons-slack", search: "", token: NOVA.token },
      { method: "PUT", path: "/v1/dev/me/lessons-slack", search: "", token: NOVA.token, body: JSON.stringify({ optOut: true }) },
    ]);
    expect(w.switches.get(BOB.developerId)).toBe(true);
  });

  it("is the caller's only: nothing the browser sends names a person, and a body with anything else is refused before Code is asked", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const sneaky = await w.api(nova, "GET", `${PATH}?person=${BOB.developerId}&developerId=${BOB.developerId}`, JSON.stringify({ developerId: BOB.developerId }));
    expect(sneaky.body).toEqual({ optOut: false });
    expect(w.codeCalls().at(-1)).toEqual({ method: "GET", path: "/v1/dev/me/lessons-slack", search: "", token: NOVA.token });
    const before = w.codeCalls().length;
    for (const body of [{ optOut: true, developerId: BOB.developerId }, { optOut: "yes" }, {}, [], "nope", { person: BOB.developerId }]) {
      expect((await w.api(nova, "PUT", PATH, JSON.stringify(body))).body, JSON.stringify(body)).toEqual({ error: { code: "CONFIG_INVALID", message: LESSONS_SLACK_WORDS.badBody } });
    }
    expect((await w.api(nova, "PUT", PATH)).body.error?.code).toBe("CONFIG_INVALID");
    expect(w.codeCalls()).toHaveLength(before);
    expect(w.switches.get(BOB.developerId)).toBe(true);
  });

  it("a PUT with no or a wrong CSRF token is refused before Code is asked; a GET needs none", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    for (const csrf of ["", "csrf-bob", "wrong"]) {
      const answer = await w.api(nova, "PUT", PATH, JSON.stringify({ optOut: true }), csrf);
      expect(answer.status, csrf).toBe(403);
    }
    expect(w.codeCalls()).toEqual([]);
    expect((await w.api(nova, "GET", PATH, undefined, "")).status).toBe(200);
  });

  it("drops any extra field Code sends and answers just { optOut }", async () => {
    const w = world();
    w.override(() => respond(200, { optOut: false, secret: "S" }));
    const answer = await w.api(await w.signIn(NOVA), "GET", PATH);
    expect(answer).toEqual({ status: 200, body: { optOut: false } });
  });

  it("has no id path and no other method: those stay 501 and never reach Code", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    for (const [method, target] of [["GET", `/me/lessons-slack/${BOB.developerId}`], ["PUT", `/org/members/${BOB.developerId}/lessons-slack`], ["POST", PATH], ["DELETE", PATH]] as const) {
      expect((await w.api(nova, method, target, method === "DELETE" ? undefined : "{}")).status, `${method} ${target}`).toBe(501);
    }
    expect(w.codeCalls()).toEqual([]);
  });

  it("rebuilds Code's answer as { optOut }: an answer that is not exactly that is a fixed 503 that echoes nothing", async () => {
    const bad: unknown[] = [{}, { optOut: "no" }, "just words", [], { optOut: null }];
    for (const body of bad) {
      for (const method of ["GET", "PUT"]) {
        const w = world();
        w.override(() => respond(200, body));
        const answer = await w.api(await w.signIn(NOVA), method, PATH, method === "PUT" ? JSON.stringify({ optOut: true }) : undefined);
        expect(answer, JSON.stringify(body)).toEqual({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: LESSONS_SLACK_WORDS.unavailable } } });
        expect(JSON.stringify(answer.body)).not.toContain("secret");
      }
    }
  });

  it("Code's refusals become Cloud's fixed words; a Code without the route is 'not connected yet'; Code's own words never pass through", async () => {
    const cases: Array<[Response, number, string, string]> = [
      [respond(404, { error: { code: "NOT_FOUND", message: "route not found maya@example.test" } }), 501, "NOT_ON_CODE_YET", LESSONS_SLACK_WORDS.notOnCode],
      [respond(405, {}), 501, "NOT_ON_CODE_YET", LESSONS_SLACK_WORDS.notOnCode],
      [respond(501, {}), 501, "NOT_ON_CODE_YET", LESSONS_SLACK_WORDS.notOnCode],
      [respond(500, { error: { code: "X", message: "SECRET maya@example.test" } }), 503, "RUNTIME_UNAVAILABLE", LESSONS_SLACK_WORDS.unavailable],
      [respond(403, { error: { code: "FORBIDDEN", message: "SECRET maya@example.test" } }), 503, "RUNTIME_UNAVAILABLE", LESSONS_SLACK_WORDS.unavailable],
    ];
    for (const [response, status, code, message] of cases) {
      const w = world();
      w.override(() => response.clone());
      const answer = await w.api(await w.signIn(NOVA), "PUT", PATH, JSON.stringify({ optOut: true }));
      expect(answer, String(response.status)).toEqual({ status, body: { error: { code, message } } });
      expect(JSON.stringify(answer)).not.toContain("SECRET");
      expect(w.logs.filter((entry) => entry.event === "cloud.lessons_slack_switch_refused")).toEqual([{ event: "cloud.lessons_slack_switch_refused", method: "PUT", status: response.status, developerId: NOVA.developerId }]);
    }
  });
});
