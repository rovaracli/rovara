// L4-SIGNIN (Cloud side): the browser's remembered Slack workspace and the page's own method button reach Code's authorize link only in their allowed shapes; the sign-in
// page's offer is two booleans read from Code's configuration; and the workspace of THIS sign-in is read back from Code's access check. Nothing here decides who signed in.
import { describe, expect, it, vi } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest } from "../../packages/cloud-server/src/index.js";

const CODE = "https://code.example.test";
const ADA = "a".repeat(64);
const HINT = "T0HINT0001";

function setUp(options: { configuration?: () => Response; slackTeamId?: unknown } = {}) {
  const calls: string[] = [];
  const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push(url.pathname);
    if (url.pathname === "/v1/auth/.well-known/agentx-configuration") return options.configuration?.() ?? respond(200, { methods: { slack: true, oidc: null, github: { displayName: "GitHub" } } });
    if (url.pathname === "/v1/auth/token") return respond(200, { access_token: "access-1", refresh_token: "refresh-1" });
    if (url.pathname === "/v1/dev/access") return respond(200, { developerId: ADA, displayName: "Ada", nameChosen: true, administrator: true, projects: [], notices: [], ...("slackTeamId" in options ? { slackTeamId: options.slackTeamId } : {}) });
    return respond(404, { error: { code: "NOT_FOUND", message: "route not found" } });
  }) as typeof fetch;
  const store = new LocalSessionStore(undefined, { environment: {} });
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "projects:members", fetch: fetchImpl });
  const handler = createCloudHandler({ client, store, work: new LocalWorkSessionStore(), origin: "https://cloud.example.test", org: { orgId: "acme", name: "Acme", plan: "test" }, callbackPath: "/callback", secureCookies: true, log: () => undefined });
  const call = async (method: string, target: string, cookie?: string) => {
    const url = new URL(target, "http://127.0.0.1:8787");
    const request: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers: cookie === undefined ? {} : { cookie } };
    return handler(request);
  };
  const signIn = async () => {
    const start = await call("GET", "/v1/auth/browser/authorize?return_to=/app/projects");
    const state = new URL(start!.headers.location!).searchParams.get("state")!;
    const back = await call("GET", `/callback?code=good-code&state=${state}`);
    return back!.headers["set-cookie"]!.split(";")[0]!;
  };
  return { call, signIn, calls };
}
const authorizeOf = (response: { headers: Record<string, string> } | undefined) => new URL(response!.headers.location!);

describe("the authorize link to Code", () => {
  it("with no hint and no method it is exactly what it was", async () => {
    const { call } = setUp();
    const url = authorizeOf(await call("GET", "/v1/auth/browser/authorize?return_to=/app/projects"));
    expect([...url.searchParams.keys()].sort()).toEqual(["client_id", "code_challenge", "code_challenge_method", "redirect_uri", "response_type", "scope", "state"]);
  });

  it("a workspace id and a method the page's button named are passed on", async () => {
    const { call } = setUp();
    const url = authorizeOf(await call("GET", `/v1/auth/browser/authorize?return_to=/app&method=slack&slack_team=${HINT}`));
    expect(url.searchParams.get("slack_team")).toBe(HINT);
    expect(url.searchParams.get("method")).toBe("slack");
    expect(authorizeOf(await call("GET", "/v1/auth/browser/authorize?method=github")).searchParams.get("method")).toBe("github");
  });

  it.each([
    ["lowercase", "t0hint0001"], ["too short", "T0HIN"], ["too long", "T0HINT00010000000"], ["an enterprise id", "E0HINT0001"], ["an injection", "T0HINT0001%26redirect_uri%3Dhttps%3A%2F%2Fevil.example"],
    ["a url", "https%3A%2F%2Fevil.example"], ["empty", ""], ["a space", "T0HINT%200001"], ["a newline", "T0HINT0001%0A"],
  ])("a bad workspace id (%s) is dropped, never sent to Code", async (_case, bad) => {
    const { call } = setUp();
    const url = authorizeOf(await call("GET", `/v1/auth/browser/authorize?return_to=/app&slack_team=${bad}`));
    expect(url.searchParams.has("slack_team")).toBe(false);
    expect(url.toString()).not.toContain("evil.example");
    expect(url.origin + url.pathname).toBe(`${CODE}/v1/auth/authorize`);
  });

  it.each([["oidc"], ["facebook"], [""], ["slack%26x%3D1"], ["SLACK"]])("a method that is not slack or github (%s) is dropped", async (method) => {
    const { call } = setUp();
    const url = authorizeOf(await call("GET", `/v1/auth/browser/authorize?method=${method}`));
    expect(url.searchParams.has("method")).toBe(false);
  });

  it("the return path rule is unchanged: a hint never opens a redirect", async () => {
    const { call } = setUp();
    const response = await call("GET", `/v1/auth/browser/authorize?return_to=https://evil.example&slack_team=${HINT}`);
    expect(authorizeOf(response).origin).toBe(CODE);
  });

  it("the sign-in still returns only to an app path whatever the hint", async () => {
    const { call } = setUp();
    const start = await call("GET", `/v1/auth/browser/authorize?return_to=/app/projects&method=slack&slack_team=${HINT}`);
    const state = authorizeOf(start).searchParams.get("state")!;
    const back = await call("GET", `/callback?code=good-code&state=${state}`);
    expect(back!.headers.location).toBe("/app/projects");
  });
});

describe("the sign-in page's offer", () => {
  it("is two booleans from Code's configuration, with no sign-in needed", async () => {
    const { call } = setUp();
    const answer = await call("GET", "/v1/auth/browser/methods");
    expect(answer!.status).toBe(200);
    expect(JSON.parse(answer!.body)).toEqual({ slack: true, github: true });
    expect(answer!.headers["cache-control"]).toBe("no-store");
  });

  it("lists GitHub only when Code's configuration does", async () => {
    const { call } = setUp({ configuration: () => new Response(JSON.stringify({ methods: { slack: true, oidc: null } }), { status: 200 }) });
    expect(JSON.parse((await call("GET", "/v1/auth/browser/methods"))!.body)).toEqual({ slack: true, github: false });
  });

  it.each([
    ["Code answering an error", () => new Response("no", { status: 503 })],
    ["something that is not JSON", () => new Response("<html>", { status: 200 })],
    ["JSON with no methods", () => new Response("{}", { status: 200 })],
    ["null methods", () => new Response(JSON.stringify({ methods: null }), { status: 200 })],
    ["github as a string", () => new Response(JSON.stringify({ methods: { slack: "yes", github: "on" } }), { status: 200 })],
  ])("is nothing at all for %s", async (_case, configuration) => {
    const { call } = setUp({ configuration });
    expect(JSON.parse((await call("GET", "/v1/auth/browser/methods"))!.body)).toEqual({ slack: false, github: false });
  });

  it("asks Code once for everyone within half a minute, and again after, and never waits long on it", async () => {
    const seen: string[] = [];
    let clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const fetchImpl = (async (input: string | URL | Request) => { seen.push(input instanceof Request ? input.url : input.toString()); return new Response(JSON.stringify({ methods: { slack: true } }), { status: 200 }); }) as typeof fetch;
    const client = new CodeClient({ baseUrl: CODE, clientId: "c", clientSecret: "s", redirectUri: "http://127.0.0.1:8787/callback", scopes: "x", fetch: fetchImpl });
    await Promise.all([client.signInOffer(), client.signInOffer(), client.signInOffer()]);
    await client.signInOffer();
    expect(seen).toHaveLength(1);
    clock += 31_000;
    await client.signInOffer();
    expect(seen).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it("never passes Code's words on", async () => {
    const { call } = setUp({ configuration: () => new Response(JSON.stringify({ methods: { slack: true, github: { displayName: "<b>GitHub</b>" }, secret: "canary-1" }, issuer: "canary-2" }), { status: 200 }) });
    const answer = await call("GET", "/v1/auth/browser/methods");
    expect(Object.keys(JSON.parse(answer!.body) as Record<string, unknown>).sort()).toEqual(["github", "slack"]);
    expect(answer!.body).not.toContain("canary");
  });
});

describe("the workspace of this sign-in (GET /v1/web/me/sign-in-workspace)", () => {
  it("answers the Slack workspace Code named at sign-in, only for a signed-in browser", async () => {
    const { call, signIn } = setUp({ slackTeamId: HINT });
    expect((await call("GET", "/v1/web/me/sign-in-workspace"))!.status).toBe(401);
    const cookie = await signIn();
    const answer = await call("GET", "/v1/web/me/sign-in-workspace", cookie);
    expect(answer!.status).toBe(200);
    expect(JSON.parse(answer!.body)).toEqual({ slackTeamId: HINT });
  });

  it.each([["none", undefined], ["a lowercase id", "t0hint0001"], ["a url", "https://evil.example"], ["a number", 5], ["an object", { id: HINT }]])("answers nothing for %s", async (_case, slackTeamId) => {
    const { call, signIn } = setUp(slackTeamId === undefined ? {} : { slackTeamId });
    const cookie = await signIn();
    expect(JSON.parse((await call("GET", "/v1/web/me/sign-in-workspace", cookie))!.body)).toEqual({});
  });

  it("is the sign-in's own: another browser's cookie gets nothing of it", async () => {
    const { call, signIn } = setUp({ slackTeamId: HINT });
    await signIn();
    expect((await call("GET", "/v1/web/me/sign-in-workspace", "rovara_cloud_session=" + "x".repeat(43)))!.status).toBe(401);
  });
});
