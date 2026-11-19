// Guided onboarding PR 11 (slack-connect.ts, linear-connect.ts, connect-flow.ts): Add to Slack, the channel picker, Connect Linear and the team pick, on a
// pretend Rovara Code that keeps PRs #836, #840 and #838's rules (single-use states bound to the person's token; the company read from the token). The browser
// never names a company; a callback goes on only with the cookie set at start, for the same sign-in, the same person and the same state, once; refusals are
// Cloud's fixed sentences; nothing Slack, Linear or Code sent as a secret reaches a log, a page, a URL or a stored row's plain text. Two companies throughout.
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CodeClient, LINEAR_CALLBACK_PATH, LINEAR_WORDS, LocalSessionStore, LocalWorkSessionStore, SLACK_CALLBACK_PATH, SLACK_WORDS, connectBack, createCloudHandler,
  type CloudRequest, type PendingSignIn,
} from "../../packages/cloud-server/src/index.js";

const CODE = "https://code.example.test";
const ORIGIN = "https://cloud.example.test";
const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const START = Date.parse("2026-11-17T12:00:00.000Z");
const NOW_S = Math.floor(START / 1000);
const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const id64 = (name: string) => createHash("sha256").update(name).digest("hex");
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** An access token as Code signs it; Cloud reads only its step-up claims. */
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: "none" })}.${b64(claims)}.sig`;

interface Person { key: string; developerId: string; companyId: string; role: "owner" | "admin" | "member"; token: string; teamId: string; teamName: string }
const person = (key: string, companyId: string, role: Person["role"], team: string, stepUpAge?: number): Person => ({
  key, developerId: id64(key), companyId, role, teamId: team, teamName: `${key}-space`,
  token: jwt({ sub: key, ...(stepUpAge === undefined ? {} : { step_up_at: NOW_S - stepUpAge, step_up_amr: "passkey" }) }),
});
const NOVA = person("nova", A, "owner", "TNOVA1", 30);
const NOVA_PLAIN = { ...person("nova", A, "owner", "TNOVA1"), key: "nova-plain" };
const NOVA_OLD = { ...person("nova", A, "owner", "TNOVA1", 3600), key: "nova-old" };
const ADA = person("ada", A, "admin", "TNOVA1", 30);
const MAX = person("max", A, "member", "TNOVA1");
const BOB = person("bob", B, "owner", "TBOB01", 30);
/** A person Code names no company for. */
const NOBODY = person("nobody", "", "owner", "TNOBODY1", 30);
const PEOPLE = [NOVA, NOVA_PLAIN, NOVA_OLD, ADA, MAX, BOB, NOBODY];

const SLACK_CODES = { ok: "slackcode-ok", other: "slackcode-otherspace", taken: "slackcode-taken", enterprise: "slackcode-grid" } as const;
const LINEAR_CODES = { ok: "lincode-ok", taken: "lincode-taken" } as const;
const SLACK_REDIRECT = `${ORIGIN}${SLACK_CALLBACK_PATH}`;
const LINEAR_REDIRECT = `${ORIGIN}${LINEAR_CALLBACK_PATH}`;
const forbidden = (message: string) => respond(403, { error: { code: "FORBIDDEN", message } });

function world() {
  let clock = START;
  const states = new Map<string, { token: string; spent: boolean; provider: string }>();
  // Per company: its workspace, its links (channel -> project), its Linear workspace and team picks.
  const slackOf = new Map<string, { teamId: string; teamName: string }>();
  const links = new Map<string, Map<string, string>>([[A, new Map()], [B, new Map()]]);
  const linearOf = new Map<string, { id: string; name: string; urlKey: string }>();
  const picks = new Map<string, Map<string, string>>([[A, new Map()], [B, new Map()]]);
  const projectsOf: Record<string, string[]> = { [A]: ["web", "api"], [B]: ["ledger"] };
  const channelsOf: Record<string, Array<{ id: string; name: string; isPrivate: boolean }>> = {
    [A]: [{ id: "CGENERAL1", name: "general", isPrivate: false }, { id: "CWEB00001", name: "web-dev", isPrivate: false }, { id: "GSECRET01", name: "secret", isPrivate: true }],
    [B]: [{ id: "CLEDGER01", name: "ledger", isPrivate: false }],
  };
  const teamsOf: Record<string, Array<{ id: string; key: string; name: string }>> = { [A]: [{ id: "team-a1", key: "WEB", name: "Web" }, { id: "team-a2", key: "API", name: "Api" }], [B]: [{ id: "team-b1", key: "LED", name: "Ledger" }] };
  const calls: Array<{ method: string; path: string; search: string; token?: string; body?: unknown }> = [];
  const overrides = new Map<string, () => Response | Promise<Response>>();
  const secret = () => randomBytes(32).toString("base64url");
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const token = (init?.headers as Record<string, string> | undefined)?.authorization?.replace(/^Bearer /u, "");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname, search: url.search, ...(token === undefined ? {} : { token }), ...(body === undefined ? {} : { body }) });
    // Every refresh is refused (the grant is dead): a 401 ends the sign-in unless another server refreshed it first.
    if (url.pathname === "/v1/auth/token") return respond(400, { error: "invalid_grant" });
    const override = overrides.get(`${method} ${url.pathname}`);
    if (override !== undefined) return override();
    const who = PEOPLE.find((one) => one.token === token);
    if (who === undefined) return respond(401, { error: { code: "AUTH_REQUIRED" } });
    const company = who.companyId;
    const isAdmin = who.role !== "member";
    const p = url.pathname;
    if (p === "/v1/dev/access") return respond(200, { developerId: who.developerId, displayName: who.key, administrator: false, projects: [], notices: [], ...(company === "" ? {} : { companyId: company, companyRole: who.role }) });
    const mint = (provider: string) => { const state = secret(); states.set(state, { token: who.token, spent: false, provider }); return state; };
    const spend = (provider: string) => {
      const kept = states.get(String(body?.state));
      if (!isAdmin || kept === undefined || kept.spent || kept.token !== who.token || kept.provider !== provider) return false;
      kept.spent = true;
      return true;
    };
    // ---- Slack install (#836)
    if (p === "/v1/dev/company/slack/install" && method === "POST") {
      if (!isAdmin) return forbidden(SLACK_WORDS.adminOnly);
      const state = mint("slack");
      const authorize = new URL("https://slack.com/oauth/v2/authorize");
      for (const [key, value] of Object.entries({ client_id: "111.222", scope: "chat:write,commands", redirect_uri: String(body?.redirectUri), state })) authorize.searchParams.set(key, value);
      return respond(200, { state, expiresAt: new Date(clock + 600_000).toISOString(), authorizeUrl: authorize.toString(), signedInWorkspace: { teamId: who.teamId, teamName: who.teamName } });
    }
    if (p === "/v1/dev/company/slack/install/complete" && method === "POST") {
      if (!spend("slack")) return forbidden("Start again from Rovara.");
      if (body?.error === "access_denied") return respond(200, { status: "cancelled" });
      if (body?.error !== undefined) return forbidden("Start again from Rovara.");
      if (body?.code === SLACK_CODES.enterprise) return forbidden(SLACK_WORDS.enterprise);
      if (body?.code === SLACK_CODES.taken) return respond(409, { error: { code: "SLACK_WORKSPACE_TAKEN", message: SLACK_WORDS.taken } });
      const team = body?.code === SLACK_CODES.other ? { teamId: "TOTHER1", teamName: "Other space" } : { teamId: who.teamId, teamName: who.teamName };
      if (body?.code !== SLACK_CODES.ok && body?.code !== SLACK_CODES.other) return forbidden("Start again from Rovara.");
      const already = slackOf.get(company)?.teamId === team.teamId;
      slackOf.set(company, team);
      return respond(200, { status: "connected", alreadyConnected: already, workspace: team, signedInWorkspace: { teamId: who.teamId, teamName: who.teamName }, matchesSignIn: team.teamId === who.teamId });
    }
    if (p === "/v1/dev/company/slack" && method === "GET") {
      const ws = slackOf.get(company);
      return respond(200, { workspace: ws === undefined ? null : { ...ws, state: "connected", connectedAt: new Date(clock).toISOString(), connectedBy: { kind: "person", personId: who.developerId, name: who.key } } });
    }
    if (p === "/v1/dev/company/slack/disconnect" && method === "POST") {
      if (who.role !== "owner") return forbidden(SLACK_WORDS.ownerOnly);
      const ws = slackOf.get(company);
      if (ws === undefined) return respond(404, { error: { code: "NOT_FOUND", message: SLACK_WORDS.notConnected } });
      slackOf.delete(company);
      const lost = [...new Set(links.get(company)!.values())];
      links.get(company)!.clear();
      return respond(200, { status: "disconnected", workspace: ws, projectsLosingChannel: lost });
    }
    // ---- Channels (#840)
    const notConnected = () => respond(409, { error: { code: "SLACK_NOT_CONNECTED", message: "Add Rovara to Slack first: this company has no Slack workspace connected." } });
    const projectOk = (name: string) => projectsOf[company]!.includes(name);
    if (p === "/v1/dev/company/slack/channels" && method === "GET") {
      const project = url.searchParams.get("project") ?? "";
      if (!projectOk(project)) return respond(404, { error: { code: "NOT_FOUND", message: "project not found" } });
      if (!isAdmin) return forbidden(SLACK_WORDS.linkNotAllowed);
      const ws = slackOf.get(company);
      if (ws === undefined) return notConnected();
      const linked = links.get(company)!;
      return respond(200, { workspace: { teamId: ws.teamId }, channels: channelsOf[company]!.map((c) => ({ ...c, ...(linked.has(c.id) ? { linked: true, linkedProject: linked.get(c.id) } : {}) })), nextCursor: "dGVhbTpDMDAx" });
    }
    const channelMatch = /^\/v1\/dev\/company\/slack\/projects\/([^/]+)\/channel(\/check)?$/u.exec(p);
    if (channelMatch !== null) {
      const project = decodeURIComponent(channelMatch[1]!);
      if (!projectOk(project)) return respond(404, { error: { code: "NOT_FOUND", message: "project not found" } });
      const linked = links.get(company)!;
      const ws = slackOf.get(company);
      if (method === "GET") return respond(200, { workspace: ws === undefined ? null : { teamId: ws.teamId }, channels: [...linked].filter(([, proj]) => proj === project).map(([channelId]) => ({ channelId })) });
      if (!isAdmin) return forbidden(SLACK_WORDS.linkNotAllowed);
      if (ws === undefined) return notConnected();
      if (method === "DELETE") {
        const mine = [...linked].filter(([, proj]) => proj === project).map(([c]) => c);
        if (mine.length === 0) return respond(404, { error: { code: "NOT_FOUND", message: SLACK_WORDS.notLinked } });
        for (const c of mine) linked.delete(c);
        return respond(200, { status: "unlinked", teamId: ws.teamId, channels: mine });
      }
      const channel = channelsOf[company]!.find((c) => c.id === body?.channelId);
      if (channel === undefined) return respond(409, { error: { code: "SLACK_CHANNEL_REFUSED", message: SLACK_WORDS.channelShared } });
      if (linked.has(channel.id) && linked.get(channel.id) !== project) return respond(409, { error: { code: "SLACK_CHANNEL_TAKEN", message: SLACK_WORDS.channelTaken } });
      if (channel.isPrivate && channelMatch[2] === undefined) return respond(200, { status: "invite_needed", workspace: { teamId: ws.teamId }, channel: { id: channel.id }, message: "Code's own words" });
      const already = linked.get(channel.id) === project;
      const replaced = [...linked].filter(([c, proj]) => proj === project && c !== channel.id).map(([c]) => c);
      for (const c of replaced) linked.delete(c);
      linked.set(channel.id, project);
      return respond(200, { status: "linked", workspace: { teamId: ws.teamId }, channel, alreadyLinked: already, replaced });
    }
    // ---- Linear (#838)
    if (p === "/v1/dev/company/linear/connect" && method === "POST") {
      if (!isAdmin) return forbidden(LINEAR_WORDS.adminOnly);
      const state = mint("linear");
      const authorize = new URL("https://linear.app/oauth/authorize");
      for (const [key, value] of Object.entries({ client_id: "linclient1", redirect_uri: LINEAR_REDIRECT, response_type: "code", scope: "read,write,comments:create,issues:create", state, actor: "app", prompt: "consent", code_challenge: "c".repeat(43), code_challenge_method: "S256" })) authorize.searchParams.set(key, value);
      return respond(200, { state, expiresAt: new Date(clock + 600_000).toISOString(), authorizeUrl: authorize.toString() });
    }
    if (p === "/v1/dev/company/linear/complete" && method === "POST") {
      if (!spend("linear")) return forbidden("Start again from Rovara.");
      if (body?.code === LINEAR_CODES.taken) return respond(409, { error: { code: "LINEAR_WORKSPACE_TAKEN", message: LINEAR_WORDS.taken } });
      if (body?.code !== LINEAR_CODES.ok) return forbidden("Start again from Rovara.");
      const ws = { id: `lin-${company.slice(-4)}`, name: `${company === A ? "Acme" : "Beta"} Linear`, urlKey: company === A ? "acme" : "beta" };
      const reconnected = linearOf.has(company);
      linearOf.set(company, ws);
      return respond(200, { status: "connected", reconnected, workspace: ws });
    }
    if (p === "/v1/dev/company/linear" && method === "GET") {
      const ws = linearOf.get(company);
      return respond(200, ws === undefined ? { status: "disconnected" } : { status: "connected", statusAt: new Date(clock).toISOString(), workspace: ws, connectedAt: new Date(clock).toISOString(), connectedBy: { personId: who.developerId, name: who.key } });
    }
    if (p === "/v1/dev/company/linear" && method === "DELETE") {
      if (who.role !== "owner") return forbidden(LINEAR_WORDS.ownerOnly);
      const ws = linearOf.get(company);
      if (ws === undefined) return respond(409, { error: { code: "LINEAR_NOT_CONNECTED", message: LINEAR_WORDS.notConnected } });
      linearOf.delete(company);
      const projects = [...picks.get(company)!.keys()];
      picks.get(company)!.clear();
      return respond(200, { status: "disconnected", workspaceName: ws.name, projects });
    }
    const teamMatch = /^\/v1\/dev\/company\/linear\/projects\/([^/]+)$/u.exec(p);
    if (teamMatch !== null) {
      const project = decodeURIComponent(teamMatch[1]!);
      if (!projectOk(project)) return respond(404, { error: { code: "NOT_FOUND", message: "project not found" } });
      if (!isAdmin) return forbidden(LINEAR_WORDS.teamAdminOnly);
      const mine = picks.get(company)!;
      if (method === "DELETE") { const had = mine.delete(project); return respond(200, { project, team: null, cleared: had }); }
      if (!linearOf.has(company)) return respond(409, { error: { code: "LINEAR_NOT_CONNECTED", message: LINEAR_WORDS.notConnected } });
      const teams = teamsOf[company]!;
      if (method === "GET") { const pick = mine.get(project); return respond(200, { project, team: pick === undefined ? null : teams.find((t) => t.id === pick), teams }); }
      const team = teams.find((t) => t.id === body?.teamId);
      if (team === undefined) return respond(404, { error: { code: "NOT_FOUND", message: LINEAR_WORDS.teamNotFound } });
      mine.set(project, team.id);
      return respond(200, { project, team });
    }
    return respond(404, { error: { code: "NOT_FOUND", message: "route not found" } });
  }) as typeof fetch;
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: `${ORIGIN}/callback`, scopes: "", fetch: fetchImpl });
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
    await sessions.create(cookie, { accessToken: who.token, access: { developerId: who.developerId, displayName: who.key, administrator: false, projects: [], notices: [], companyId: who.companyId, companyRole: who.role }, csrf: `csrf-${who.key}`, signedInAt: new Date(clock).toISOString() });
    return { person: who, cookie };
  };
  type Who = Awaited<ReturnType<typeof signIn>>;
  const api = async (who: Who, method: string, path: string, body?: unknown, rawBody?: string) => {
    const answer = await raw(method, `/v1/web${path}`, { cookie: `rovara_cloud_session=${who.cookie}`, "x-rovara-csrf": `csrf-${who.person.key}`, "content-type": "application/json" }, rawBody ?? (body === undefined ? undefined : JSON.stringify(body)));
    return { status: answer.status, body: JSON.parse(answer.body) as Record<string, unknown> & { error?: { code: string; message: string } }, headers: answer.headers };
  };
  const start = async (provider: "slack" | "linear", who: Who, body: unknown = {}) => {
    const answer = await api(who, "POST", provider === "slack" ? "/slack/install" : "/linear/connect", body);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const binder = new RegExp(`^rovara_cloud_${provider}=([A-Za-z0-9_-]{43});`, "u").exec(answer.headers["set-cookie"] ?? "")?.[1];
    const state = new URL(String(answer.body.authorizeUrl)).searchParams.get("state")!;
    return { binder: binder!, state, answer };
  };
  const callback = async (provider: "slack" | "linear", query: Record<string, string> | string, cookies: { session?: string; binder?: string }) => {
    const search = typeof query === "string" ? query : new URLSearchParams(query).toString();
    const cookie = [cookies.session === undefined ? undefined : `rovara_cloud_session=${cookies.session}`, cookies.binder === undefined ? undefined : `rovara_cloud_${provider}=${cookies.binder}`].filter(Boolean).join("; ");
    const answer = await raw("GET", `${provider === "slack" ? SLACK_CALLBACK_PATH : LINEAR_CALLBACK_PATH}?${search}`, cookie === "" ? {} : { cookie });
    return { status: answer.status, location: answer.headers.location, setCookie: answer.headers["set-cookie"], body: answer.body };
  };
  const codeCalls = (path: string) => calls.filter((call) => call.path === path);
  return { raw, api, signIn, start, callback, calls, codeCalls, logs, pendingWrites, put, overrides, slackOf, links, linearOf, picks, sessions, advance: (ms: number) => { clock += ms; } };
}

const SLACK_COMPLETE = "/v1/dev/company/slack/install/complete";
const LINEAR_COMPLETE = "/v1/dev/company/linear/complete";
const cleared = (provider: string) => `rovara_cloud_${provider}=; HttpOnly; SameSite=Lax; Path=/api/connect/${provider}; Secure; Max-Age=0`;

describe("Add to Slack: start (POST /v1/app/slack/install)", () => {
  it("asks Code as the person with this Cloud's callback only, answers Slack's page, binds the browser with an HttpOnly, Secure, SameSite=Lax cookie, keeps only hashes", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const { binder, state, answer } = await w.start("slack", nova);
    expect(w.codeCalls("/v1/dev/company/slack/install")).toEqual([{ method: "POST", path: "/v1/dev/company/slack/install", search: "", token: NOVA.token, body: { redirectUri: SLACK_REDIRECT } }]);
    const url = new URL(String(answer.body.authorizeUrl));
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: "111.222", scope: "chat:write,commands", redirect_uri: SLACK_REDIRECT, state });
    expect(Object.keys(answer.body).sort()).toEqual(["authorizeUrl", "expiresAt"]);
    expect(answer.headers["set-cookie"]).toBe(`rovara_cloud_slack=${binder}; HttpOnly; SameSite=Lax; Path=/api/connect/slack; Secure; Max-Age=600`);
    const stored = JSON.stringify(w.pendingWrites);
    expect(w.pendingWrites).toHaveLength(1);
    for (const value of [state, binder, nova.cookie]) expect(stored).not.toContain(value);
    expect(w.pendingWrites[0]![1].connect).toMatchObject({ provider: "slack", kind: "state", stateHash: createHash("sha256").update(state).digest("hex"), developerId: NOVA.developerId, back: "/app/onboard" });
  });

  it("takes {} or {back: an app page} only; never a company, a workspace or a return address elsewhere; a query naming a company never reaches Code", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    for (const body of [{ companyId: B }, { teamId: "TBOB01" }, { back: "https://evil.example/app" }, { back: "/app/../x" }, { back: "//evil.example" }, { back: "/app/x?y=1" }, { back: "/app/%2e%2e" }, { back: "/apps" }, { back: "/app/onboard", companyId: B }, [], "x", null]) {
      const answer = await w.api(nova, "POST", "/slack/install", body);
      expect(answer, JSON.stringify(body)).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID", message: SLACK_WORDS.noDetails } } });
      expect(answer.headers["set-cookie"]).toBeUndefined();
    }
    expect((await w.api(nova, "POST", "/slack/install", undefined, "{not json")).status).toBe(400);
    expect(w.codeCalls("/v1/dev/company/slack/install")).toEqual([]);
    const answer = await w.raw("POST", `/v1/web/slack/install?company=${B}&companyId=${B}`, { cookie: `rovara_cloud_session=${nova.cookie}`, "x-rovara-csrf": "csrf-nova", "content-type": "application/json" }, JSON.stringify({ back: "/app/admin/projects/web" }));
    expect(answer.status).toBe(200);
    expect(JSON.stringify(w.calls)).not.toContain(B);
    expect(w.pendingWrites.at(-1)![1].connect?.back).toBe("/app/admin/projects/web");
  });

  it("needs the sign-in's CSRF token and a sign-in", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    expect((await w.raw("POST", "/v1/web/slack/install", { cookie: `rovara_cloud_session=${nova.cookie}` }, "{}")).status).toBe(403);
    expect((await w.raw("POST", "/v1/web/slack/install", {}, "{}")).status).toBe(401);
    expect(w.codeCalls("/v1/dev/company/slack/install")).toEqual([]);
  });

  it("says Code's fixed sentences by status, never Code's other words, and sets no cookie on a refusal", async () => {
    const w = world();
    const max = await w.signIn(MAX);
    expect((await w.api(max, "POST", "/slack/install", {})).body).toEqual({ error: { code: "FORBIDDEN", message: SLACK_WORDS.adminOnly } });
    const nova = await w.signIn(NOVA);
    const cases: Array<[Response, string]> = [
      [respond(404, { error: { code: "NOT_FOUND", message: "route not found" } }), SLACK_WORDS.notAvailable],
      [respond(503, { error: { code: "RUNTIME_UNAVAILABLE", message: SLACK_WORDS.notSetUp } }), SLACK_WORDS.notSetUp],
      [respond(503, { error: { code: "RUNTIME_UNAVAILABLE", message: "arn:aws:secret boom" } }), SLACK_WORDS.unavailable],
      [respond(500, { error: { code: "X", message: "stack trace" } }), SLACK_WORDS.unavailable],
      [respond(400, { error: { code: "CONFIG_INVALID", message: "echo <script>" } }), SLACK_WORDS.unavailable],
    ];
    for (const [response, words] of cases) {
      w.overrides.set("POST /v1/dev/company/slack/install", () => response.clone());
      const answer = await w.api(nova, "POST", "/slack/install", {});
      expect(answer.body.error?.message).toBe(words);
      expect(answer.headers["set-cookie"]).toBeUndefined();
    }
  });

  it("refuses a Code answer whose Slack address goes elsewhere, comes back elsewhere, or carries anything but the state, a client id and bot scopes", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const state = "s".repeat(43);
    const good = { client_id: "111.222", scope: "chat:write", redirect_uri: SLACK_REDIRECT, state };
    const address = (origin: string, path: string, query: Record<string, string>) => `${origin}${path}?${new URLSearchParams(query).toString()}`;
    const bad = [
      address("https://evil.example", "/oauth/v2/authorize", good),
      address("https://slack.com.evil.example", "/oauth/v2/authorize", good),
      address("https://slack.com", "/oauth/authorize", good),
      address("https://slack.com", "/oauth/v2/authorize", { ...good, redirect_uri: "https://evil.example/api/connect/slack/callback" }),
      address("https://slack.com", "/oauth/v2/authorize", { ...good, state: "t".repeat(43) }),
      address("https://slack.com", "/oauth/v2/authorize", { ...good, user_scope: "admin" }),
      address("https://slack.com", "/oauth/v2/authorize", { ...good, client_id: "abc" }),
      `${address("https://slack.com", "/oauth/v2/authorize", good)}#frag`,
    ];
    for (const authorizeUrl of bad) {
      w.overrides.set("POST /v1/dev/company/slack/install", () => respond(200, { state, expiresAt: new Date(START).toISOString(), authorizeUrl }));
      const answer = await w.api(nova, "POST", "/slack/install", {});
      expect(answer, authorizeUrl).toMatchObject({ status: 503, body: { error: { message: SLACK_WORDS.unavailable } } });
      expect(answer.headers["set-cookie"]).toBeUndefined();
    }
    w.overrides.set("POST /v1/dev/company/slack/install", () => respond(200, { state, expiresAt: new Date(START).toISOString(), authorizeUrl: address("https://slack.com", "/oauth/v2/authorize", good) }));
    expect((await w.api(nova, "POST", "/slack/install", {})).status).toBe(200);
  });
});

describe("the Slack callback (GET /api/connect/slack/callback)", () => {
  it("completes as the person with Slack's code and the bound state only, clears the cookie, lands on the start's page with the outcome kept server-side, once", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const { binder, state } = await w.start("slack", nova);
    const back = await w.callback("slack", { code: SLACK_CODES.ok, state }, { session: nova.cookie, binder });
    expect(back).toMatchObject({ status: 302, location: "/app/onboard?slack=result", setCookie: cleared("slack") });
    expect(w.codeCalls(SLACK_COMPLETE)).toEqual([{ method: "POST", path: SLACK_COMPLETE, search: "", token: NOVA.token, body: { state, code: SLACK_CODES.ok } }]);
    expect((await w.api(nova, "POST", "/slack/install/result", {})).body).toEqual({ status: "connected", alreadyConnected: false, workspaceName: "nova-space" });
    expect((await w.api(nova, "POST", "/slack/install/result", {})).body).toEqual({ status: "none" });
  });

  it("lands on the page the start named", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const { binder, state } = await w.start("slack", nova, { back: "/app/admin/connections" });
    expect((await w.callback("slack", { code: SLACK_CODES.ok, state }, { session: nova.cookie, binder })).location).toBe("/app/admin/connections?slack=result");
  });

  it("does nothing without the cookie, or with a malformed one: no Code call, the cookie cleared, 'start_again'", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const { state } = await w.start("slack", nova);
    for (const binder of [undefined, "", "short", "x".repeat(44), "x".repeat(43)]) {
      const back = await w.callback("slack", { code: SLACK_CODES.ok, state }, { session: nova.cookie, ...(binder === undefined ? {} : { binder }) });
      expect(back).toMatchObject({ status: 302, location: "/app/onboard?slack=start_again", setCookie: cleared("slack") });
    }
    expect(w.codeCalls(SLACK_COMPLETE)).toEqual([]);
  });

  it("refuses another session's cookie (another company's person, or the same person's other sign-in), and a cookie with no sign-in; the binding is spent by the try", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const bob = await w.signIn(BOB);
    const novaAgain = await w.signIn(NOVA);
    const { binder, state } = await w.start("slack", nova);
    expect((await w.callback("slack", { code: SLACK_CODES.ok, state }, { session: bob.cookie, binder })).location).toBe("/app/onboard?slack=start_again");
    // Spent: even the right sign-in can't use that binding now.
    expect((await w.callback("slack", { code: SLACK_CODES.ok, state }, { session: nova.cookie, binder })).location).toBe("/app/onboard?slack=start_again");
    const second = await w.start("slack", nova);
    expect((await w.callback("slack", { code: SLACK_CODES.ok, state: second.state }, { session: novaAgain.cookie, binder: second.binder })).location).toBe("/app/onboard?slack=start_again");
    const third = await w.start("slack", nova);
    expect((await w.callback("slack", { code: SLACK_CODES.ok, state: third.state }, { binder: third.binder })).location).toBe("/app/onboard?slack=start_again");
    expect(w.codeCalls(SLACK_COMPLETE)).toEqual([]);
    expect(w.logs.filter((l) => l.event === "cloud.slack_callback_refused").map((l) => l.reason)).toEqual(["session", "no_binding", "session", "session"]);
  });

  it("refuses a state the cookie wasn't set for, a repeated state, or none, before asking Code", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const first = await w.start("slack", nova);
    const second = await w.start("slack", nova);
    // The second start's state with the first start's cookie.
    expect((await w.callback("slack", { code: SLACK_CODES.ok, state: second.state }, { session: nova.cookie, binder: first.binder })).location).toBe("/app/onboard?slack=start_again");
    const third = await w.start("slack", nova);
    expect((await w.callback("slack", `code=${SLACK_CODES.ok}&state=${third.state}&state=${third.state}`, { session: nova.cookie, binder: third.binder })).location).toBe("/app/onboard?slack=start_again");
    const fourth = await w.start("slack", nova);
    expect((await w.callback("slack", { code: SLACK_CODES.ok }, { session: nova.cookie, binder: fourth.binder })).location).toBe("/app/onboard?slack=start_again");
    expect(w.codeCalls(SLACK_COMPLETE)).toEqual([]);
  });

  it("works once: a replay after success does nothing; and refuses after ten minutes", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const { binder, state } = await w.start("slack", nova);
    expect((await w.callback("slack", { code: SLACK_CODES.ok, state }, { session: nova.cookie, binder })).location).toBe("/app/onboard?slack=result");
    expect((await w.callback("slack", { code: SLACK_CODES.ok, state }, { session: nova.cookie, binder })).location).toBe("/app/onboard?slack=start_again");
    const late = await w.start("slack", nova);
    w.advance(10 * 60_000 + 1);
    expect((await w.callback("slack", { code: SLACK_CODES.ok, state: late.state }, { session: nova.cookie, binder: late.binder })).location).toBe("/app/onboard?slack=start_again");
    expect(w.codeCalls(SLACK_COMPLETE)).toHaveLength(1);
  });

  it("refuses a repeated, malformed, missing or doubled Slack value before asking Code", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    for (const extra of [`code=${SLACK_CODES.ok}&code=x`, "code=bad%20code", "error=Access-Denied", `code=${SLACK_CODES.ok}&error=access_denied`, ""]) {
      const { binder, state } = await w.start("slack", nova);
      const back = await w.callback("slack", `state=${state}${extra === "" ? "" : `&${extra}`}`, { session: nova.cookie, binder });
      expect(back.location, extra).toBe("/app/onboard?slack=start_again");
    }
    expect(w.codeCalls(SLACK_COMPLETE)).toEqual([]);
  });

  it("passes Slack's Cancel to Code with the state, and lands on 'cancelled'", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const { binder, state } = await w.start("slack", nova);
    expect((await w.callback("slack", { error: "access_denied", state }, { session: nova.cookie, binder })).location).toBe("/app/onboard?slack=cancelled");
    expect(w.codeCalls(SLACK_COMPLETE)[0]?.body).toEqual({ state, error: "access_denied" });
  });

  it("lands on Code's refusals as one fixed word each, never Code's words", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const words: Array<[string | Response, string]> = [
      [SLACK_CODES.taken, "taken"], [SLACK_CODES.enterprise, "enterprise"], ["unknown-code", "start_again"],
      [respond(409, { error: { code: "SLACK_COMPANY_HAS_WORKSPACE", message: "x" } }), "other_workspace"],
      [respond(503, { error: { code: "RUNTIME_UNAVAILABLE", message: SLACK_WORDS.notSetUp } }), "not_set_up"],
      [respond(503, { error: { code: "RUNTIME_UNAVAILABLE", message: "xoxb-leaked" } }), "unavailable"],
      [respond(404, { error: { code: "NOT_FOUND" } }), "not_available"],
      [respond(200, { status: "connected", alreadyConnected: "yes", workspace: { teamId: "T1" } }), "unavailable"],
      [respond(200, { status: "connected", alreadyConnected: false, workspace: { teamId: "TX1", teamName: "A" }, signedInWorkspace: { teamId: "TX1" }, matchesSignIn: false }), "unavailable"],
    ];
    for (const [what, word] of words) {
      const { binder, state } = await w.start("slack", nova);
      if (typeof what === "string") w.overrides.delete(`POST ${SLACK_COMPLETE}`); else w.overrides.set(`POST ${SLACK_COMPLETE}`, () => what.clone());
      const back = await w.callback("slack", { code: typeof what === "string" ? what : SLACK_CODES.ok, state }, { session: nova.cookie, binder });
      expect(back.location, word).toBe(`/app/onboard?slack=${word}`);
      expect((await w.api(nova, "POST", "/slack/install/result", {})).body).toEqual({ status: "none" });
    }
    expect(JSON.stringify(w.logs)).not.toContain("xoxb");
  });

  it("Code's 409 SLACK_WORKSPACE_TAKEN lands on 'taken' and Cloud's one sentence is exact, never echoing the workspace name or id", async () => {
    expect(SLACK_WORDS.taken).toBe("This Slack workspace is already connected to another company.");
    const w = world();
    const nova = await w.signIn(NOVA);
    const { binder, state } = await w.start("slack", nova);
    w.overrides.set(`POST ${SLACK_COMPLETE}`, () => respond(409, { error: { code: "SLACK_WORKSPACE_TAKEN", message: "Workspace Leaky Labs (T0LEAKED1) is connected to company c-secret-9" } }));
    const back = await w.callback("slack", { code: SLACK_CODES.ok, state }, { session: nova.cookie, binder });
    expect(back.location).toBe("/app/onboard?slack=taken");
    for (const leaked of ["Leaky", "T0LEAKED1", "c-secret-9"]) {
      expect(back.location).not.toContain(leaked);
      expect(JSON.stringify(w.logs)).not.toContain(leaked);
    }
    expect(SLACK_WORDS.taken).not.toMatch(/Leaky|T0LEAKED1|c-secret-9|Rovara company/u);
  });

  it("keeps the 'You signed in from A but added Rovara to B' question across reads until it expires or Slack is disconnected", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const { binder, state } = await w.start("slack", nova);
    await w.callback("slack", { code: SLACK_CODES.other, state }, { session: nova.cookie, binder });
    const expected = { status: "connected", alreadyConnected: false, workspaceName: "Other space", mismatch: { signedInName: "nova-space" } };
    expect((await w.api(nova, "POST", "/slack/install/result", {})).body).toEqual(expected);
    expect((await w.api(nova, "POST", "/slack/install/result", {})).body).toEqual(expected);
    expect((await w.api(nova, "POST", "/slack/disconnect", {})).status).toBe(200);
    expect((await w.api(nova, "POST", "/slack/install/result", {})).body).toEqual({ status: "none" });
  });

  it("keeps the outcome to its own sign-in: another company's person, or another sign-in of the same person, reads nothing", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const other = await w.signIn(NOVA);
    const bob = await w.signIn(BOB);
    const { binder, state } = await w.start("slack", nova);
    await w.callback("slack", { code: SLACK_CODES.ok, state }, { session: nova.cookie, binder });
    expect((await w.api(bob, "POST", "/slack/install/result", {})).body).toEqual({ status: "none" });
    expect((await w.api(other, "POST", "/slack/install/result", {})).body).toEqual({ status: "none" });
    expect((await w.api(nova, "POST", "/slack/install/result", {})).body).toMatchObject({ status: "connected" });
  });

  it("checks every part of a stored row: another person's id, another sign-in's hash or another provider's row under the right key does nothing", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    for (const change of [
      (row: PendingSignIn) => ({ ...row, connect: { ...row.connect!, developerId: BOB.developerId } }),
      (row: PendingSignIn) => ({ ...row, connect: { ...row.connect!, session: "0".repeat(64) } }),
      (row: PendingSignIn) => ({ ...row, connect: { ...row.connect!, provider: "linear" as const } }),
      (row: PendingSignIn) => ({ ...row, connect: { ...row.connect!, kind: "result" as const } }),
      (row: PendingSignIn) => ({ ...row, connect: { ...row.connect!, back: "https://evil.example" } }),
    ]) {
      const { binder, state } = await w.start("slack", nova);
      const [key, row] = w.pendingWrites.at(-1)!;
      await w.put(key, change(structuredClone(row)));
      expect((await w.callback("slack", { code: SLACK_CODES.ok, state }, { session: nova.cookie, binder })).location).toBe("/app/onboard?slack=start_again");
    }
    expect(w.codeCalls(SLACK_COMPLETE)).toEqual([]);
    // A kept outcome with another person's id reads as nothing.
    const { binder, state } = await w.start("slack", nova);
    await w.callback("slack", { code: SLACK_CODES.ok, state }, { session: nova.cookie, binder });
    const [key, row] = w.pendingWrites.at(-1)!;
    await w.put(key, { ...row, connect: { ...row.connect!, developerId: BOB.developerId } });
    expect((await w.api(nova, "POST", "/slack/install/result", {})).body).toEqual({ status: "none" });
  });

  it("is not a sign-in: the sign-in callback refuses a connect's rows; and the Slack callback refuses a Linear binding", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    await w.start("slack", nova);
    const [key] = w.pendingWrites.at(-1)!;
    expect((await w.raw("GET", `/callback?state=${encodeURIComponent(key)}&code=x`)).status).toBe(400);
    const linear = await w.start("linear", nova);
    const back = await w.raw("GET", `${SLACK_CALLBACK_PATH}?code=${SLACK_CODES.ok}&state=${linear.state}`, { cookie: `rovara_cloud_session=${nova.cookie}; rovara_cloud_slack=${linear.binder}` });
    expect(back.headers.location).toBe("/app/onboard?slack=start_again");
    expect(w.codeCalls(SLACK_COMPLETE)).toEqual([]);
  });
});

describe("the company's Slack workspace and disconnect", () => {
  it("answers each company only its own workspace, without ids or a token; no company is ever sent", async () => {
    const w = world();
    const nova = await w.signIn(NOVA), bob = await w.signIn(BOB), max = await w.signIn(MAX);
    w.slackOf.set(A, { teamId: "TNOVA1", teamName: "Acme" });
    expect((await w.api(nova, "GET", "/slack")).body).toEqual({ workspace: { teamName: "Acme", state: "connected", connectedAt: new Date(START).toISOString(), connectedBy: { kind: "person", name: "nova" } } });
    expect((await w.api(max, "GET", "/slack")).body).toMatchObject({ workspace: { teamName: "Acme" } });
    expect((await w.api(bob, "GET", "/slack")).body).toEqual({ workspace: null });
    expect(JSON.stringify(w.calls.filter((c) => c.path === "/v1/dev/company/slack"))).not.toMatch(/org_/u);
    w.overrides.set("GET /v1/dev/company/slack", () => respond(200, { workspace: { teamId: "bad", state: "connected" } }));
    expect((await w.api(nova, "GET", "/slack")).body).toEqual({ error: { code: "RUNTIME_UNAVAILABLE", message: SLACK_WORDS.readUnavailable } });
  });

  it("disconnect: an owner only (no step-up since owner DEC 254zzz73); a member and an admin are refused before Code is asked; another company's owner never reaches A's", async () => {
    const w = world();
    w.slackOf.set(A, { teamId: "TNOVA1", teamName: "Acme" });
    w.links.get(A)!.set("CWEB00001", "web");
    for (const who of [MAX, ADA]) {
      const answer = await w.api(await w.signIn(who), "POST", "/slack/disconnect", {});
      expect(answer.status, who.key).toBe(403);
      expect(answer.body.error?.code, who.key).toBe("FORBIDDEN");
    }
    expect(w.codeCalls("/v1/dev/company/slack/disconnect")).toEqual([]);
    // B's owner disconnects only B's (none here): A's workspace stays.
    expect((await w.api(await w.signIn(BOB), "POST", "/slack/disconnect", {})).body).toEqual({ error: { code: "NOT_FOUND", message: SLACK_WORDS.notConnected } });
    expect(w.slackOf.get(A)).toBeDefined();
    const nova = await w.signIn(NOVA_PLAIN);
    expect((await w.api(nova, "POST", "/slack/disconnect", { companyId: B })).status).toBe(400);
    const answer = await w.api(nova, "POST", "/slack/disconnect", {});
    expect(answer.body).toEqual({ status: "disconnected", workspaceName: "Acme", projectsLosingChannel: ["web"] });
    expect(w.codeCalls("/v1/dev/company/slack/disconnect").filter((c) => c.token === NOVA_PLAIN.token)).toEqual([{ method: "POST", path: "/v1/dev/company/slack/disconnect", search: "", token: NOVA_PLAIN.token, body: {} }]);
    expect((await w.api(nova, "POST", "/slack/disconnect", {})).body).toEqual({ error: { code: "NOT_FOUND", message: SLACK_WORDS.notConnected } });
    // Any 403 from Code is the owner-only sentence now (there is no step-up answer).
    w.overrides.set("POST /v1/dev/company/slack/disconnect", () => respond(403, { error: { code: "REAUTH_REQUIRED", message: "Code words" } }));
    expect((await w.api(nova, "POST", "/slack/disconnect", {})).body.error).toEqual({ code: "FORBIDDEN", message: SLACK_WORDS.ownerOnly });
  });
});

describe("the Slack channel picker and a project's channel", () => {
  it("lists one page for the person's company, with only the project and cursor sent; each company sees only its own channels", async () => {
    const w = world();
    w.slackOf.set(A, { teamId: "TNOVA1", teamName: "Acme" });
    w.slackOf.set(B, { teamId: "TBOB01", teamName: "Beta" });
    w.links.get(A)!.set("CGENERAL1", "api");
    const nova = await w.signIn(NOVA), bob = await w.signIn(BOB);
    const page = await w.api(nova, "GET", `/slack/channels?project=web&cursor=abc&companyId=${B}`);
    expect(page.body).toEqual({ channels: [
      { id: "CGENERAL1", name: "general", isPrivate: false, linked: true, linkedProject: "api" }, { id: "CWEB00001", name: "web-dev", isPrivate: false }, { id: "GSECRET01", name: "secret", isPrivate: true },
    ], nextCursor: "dGVhbTpDMDAx" });
    expect(w.codeCalls("/v1/dev/company/slack/channels").at(-1)?.search).toBe("?project=web&cursor=abc");
    expect((await w.api(bob, "GET", "/slack/channels?project=ledger")).body).toEqual({ channels: [{ id: "CLEDGER01", name: "ledger", isPrivate: false }], nextCursor: "dGVhbTpDMDAx" });
    // Another company's project is Code's "not found" in Cloud's words.
    expect((await w.api(bob, "GET", "/slack/channels?project=web")).body).toEqual({ error: { code: "NOT_FOUND", message: SLACK_WORDS.projectNotFound } });
    expect(JSON.stringify(w.calls)).not.toContain("org_");
  });

  it("checks the project name and cursor before asking Code", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    for (const search of ["", "?project=Web", "?project=web&project=api", "?project=../x", "?project=web&cursor=a%20b", "?project=web&cursor=a&cursor=b"]) {
      expect((await w.api(nova, "GET", `/slack/channels${search}`)).status, search).toBeGreaterThanOrEqual(400);
    }
    expect(w.codeCalls("/v1/dev/company/slack/channels")).toEqual([]);
  });

  it("links (or asks for the /invite), checks, changes and unlinks a project's channel with fixed words", async () => {
    const w = world();
    w.slackOf.set(A, { teamId: "TNOVA1", teamName: "Acme" });
    const nova = await w.signIn(NOVA);
    expect((await w.api(nova, "GET", "/projects/web/slack/channel")).body).toEqual({ connected: true, channels: [] });
    expect((await w.api(nova, "PUT", "/projects/web/slack/channel", { channelId: "GSECRET01" })).body).toEqual({ status: "invite_needed", channel: { id: "GSECRET01" }, message: SLACK_WORDS.invite });
    expect((await w.api(nova, "POST", "/projects/web/slack/channel/check", { channelId: "GSECRET01" })).body).toEqual({ status: "linked", channel: { id: "GSECRET01", name: "secret", isPrivate: true }, alreadyLinked: false, replaced: [] });
    expect((await w.api(nova, "PUT", "/projects/web/slack/channel", { channelId: "CWEB00001" })).body).toEqual({ status: "linked", channel: { id: "CWEB00001", name: "web-dev", isPrivate: false }, alreadyLinked: false, replaced: ["GSECRET01"] });
    expect((await w.api(nova, "GET", "/projects/web/slack/channel")).body).toEqual({ connected: true, channels: [{ id: "CWEB00001" }] });
    expect((await w.api(nova, "PUT", "/projects/api/slack/channel", { channelId: "CWEB00001" })).body).toEqual({ error: { code: "SLACK_CHANNEL_TAKEN", message: SLACK_WORDS.channelTaken } });
    expect((await w.api(nova, "DELETE", "/projects/web/slack/channel")).body).toEqual({ status: "unlinked", channels: ["CWEB00001"] });
    expect((await w.api(nova, "DELETE", "/projects/web/slack/channel")).body).toEqual({ error: { code: "NOT_FOUND", message: SLACK_WORDS.notLinked } });
    expect(w.codeCalls("/v1/dev/company/slack/projects/web/channel").map((c) => c.body).filter(Boolean)).toEqual([{ channelId: "GSECRET01" }, { channelId: "CWEB00001" }]);
  });

  it("refuses a bad body or project before Code, and says Code's refusals in Cloud's words", async () => {
    const w = world();
    const nova = await w.signIn(NOVA), max = await w.signIn(MAX);
    for (const body of [{}, { channelId: "TNOVA1" }, { channelId: "CWEB00001", teamId: "TBOB01" }, { channelId: "CWEB00001", companyId: B }, "x"]) {
      expect((await w.api(nova, "PUT", "/projects/web/slack/channel", body)).body, JSON.stringify(body)).toEqual({ error: { code: "CONFIG_INVALID", message: SLACK_WORDS.pickChannel } });
    }
    expect((await w.api(nova, "PUT", "/projects/Bad_Name/slack/channel", { channelId: "CWEB00001" })).status).toBe(404);
    expect((await w.api(nova, "GET", "/projects/%E0%A4%A/slack/channel")).status).toBe(404);
    expect(w.calls.filter((c) => c.path.includes("/slack/projects/"))).toEqual([]);
    expect((await w.api(nova, "PUT", "/projects/web/slack/channel", { channelId: "CWEB00001" })).body).toEqual({ error: { code: "SLACK_NOT_CONNECTED", message: SLACK_WORDS.channelNotConnected } });
    w.slackOf.set(A, { teamId: "TNOVA1", teamName: "Acme" });
    expect((await w.api(max, "PUT", "/projects/web/slack/channel", { channelId: "CWEB00001" })).body).toEqual({ error: { code: "FORBIDDEN", message: SLACK_WORDS.linkNotAllowed } });
    expect((await w.api(nova, "PUT", "/projects/web/slack/channel", { channelId: "CNOTOURS1" })).body).toEqual({ error: { code: "SLACK_CHANNEL_REFUSED", message: SLACK_WORDS.channelShared } });
    for (const [response, words] of [
      [respond(409, { error: { code: "SLACK_CHANNEL_REFUSED", message: "<b>other</b>" } }), SLACK_WORDS.channelRefused],
      [respond(409, { error: { code: "SLACK_NOT_CONNECTED", message: SLACK_WORDS.channelNoToken } }), SLACK_WORDS.channelNoToken],
      [respond(503, { error: { code: "RUNTIME_UNAVAILABLE", message: "xoxb-1" } }), SLACK_WORDS.channelUnavailable],
      [respond(200, { status: "linked", channel: { id: "CWEB00001", name: "<script>", isPrivate: false }, alreadyLinked: false, replaced: [] }), SLACK_WORDS.channelUnavailable],
    ] as const) {
      w.overrides.set("PUT /v1/dev/company/slack/projects/web/channel", () => response.clone());
      expect((await w.api(nova, "PUT", "/projects/web/slack/channel", { channelId: "CWEB00001" })).body.error?.message).toBe(words);
    }
  });
});

describe("Connect Linear: start and callback", () => {
  it("asks Code with {} as the person, checks Linear's address comes back to this Cloud as the app with PKCE, binds the browser, keeps only hashes", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const { binder, state, answer } = await w.start("linear", nova);
    expect(w.codeCalls("/v1/dev/company/linear/connect")).toEqual([{ method: "POST", path: "/v1/dev/company/linear/connect", search: "", token: NOVA.token, body: {} }]);
    expect(new URL(String(answer.body.authorizeUrl)).searchParams.get("redirect_uri")).toBe(LINEAR_REDIRECT);
    expect(answer.headers["set-cookie"]).toBe(`rovara_cloud_linear=${binder}; HttpOnly; SameSite=Lax; Path=/api/connect/linear; Secure; Max-Age=600`);
    for (const value of [state, binder, nova.cookie]) expect(JSON.stringify(w.pendingWrites)).not.toContain(value);
  });

  it("refuses an address that goes elsewhere, comes back elsewhere, drops actor=app or PKCE, or carries anything extra", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const state = "s".repeat(43);
    const good: Record<string, string> = { client_id: "linclient1", redirect_uri: LINEAR_REDIRECT, response_type: "code", scope: "read", state, actor: "app", prompt: "consent", code_challenge: "c".repeat(43), code_challenge_method: "S256" };
    const at = (q: Record<string, string>, origin = "https://linear.app", path = "/oauth/authorize") => `${origin}${path}?${new URLSearchParams(q).toString()}`;
    const without = (key: string) => Object.fromEntries(Object.entries(good).filter(([k]) => k !== key));
    for (const authorizeUrl of [
      at(good, "https://evil.example"), at(good, "https://linear.app", "/oauth/token"), at({ ...good, redirect_uri: "https://evil.example/api/connect/linear/callback" }), at({ ...good, actor: "user" }),
      at({ ...good, code_challenge_method: "plain" }), at(without("code_challenge")), at({ ...good, state: "t".repeat(43) }), at({ ...good, scope: "admin,read" }).replace("admin%2Cread", "ADMIN"), at({ ...good, extra: "1" }), at(without("prompt")),
    ]) {
      w.overrides.set("POST /v1/dev/company/linear/connect", () => respond(200, { state, expiresAt: new Date(START).toISOString(), authorizeUrl }));
      const answer = await w.api(nova, "POST", "/linear/connect", {});
      expect(answer, authorizeUrl).toMatchObject({ status: 503, body: { error: { message: LINEAR_WORDS.unavailable } } });
      expect(answer.headers["set-cookie"]).toBeUndefined();
    }
    w.overrides.set("POST /v1/dev/company/linear/connect", () => respond(200, { state, expiresAt: new Date(START).toISOString(), authorizeUrl: at(good) }));
    expect((await w.api(nova, "POST", "/linear/connect", {})).status).toBe(200);
  });

  it("refuses a body naming anything, and a non-admin gets Code's fixed sentence", async () => {
    const w = world();
    const nova = await w.signIn(NOVA), max = await w.signIn(MAX);
    for (const body of [{ companyId: B }, { workspace: "x" }, { back: "https://x" }]) expect((await w.api(nova, "POST", "/linear/connect", body)).body).toEqual({ error: { code: "CONFIG_INVALID", message: LINEAR_WORDS.noDetails } });
    expect((await w.api(max, "POST", "/linear/connect", {})).body).toEqual({ error: { code: "FORBIDDEN", message: LINEAR_WORDS.adminOnly } });
    expect(w.codeCalls("/v1/dev/company/linear/connect")).toHaveLength(1);
  });

  it("completes once as the person with Linear's code, and keeps only the workspace's name and url key", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const { binder, state } = await w.start("linear", nova, { back: "/app/admin/projects/web" });
    expect(await w.callback("linear", { code: LINEAR_CODES.ok, state }, { session: nova.cookie, binder })).toMatchObject({ status: 302, location: "/app/admin/projects/web?linear=result", setCookie: cleared("linear") });
    expect(w.codeCalls(LINEAR_COMPLETE)).toEqual([{ method: "POST", path: LINEAR_COMPLETE, search: "", token: NOVA.token, body: { state, code: LINEAR_CODES.ok } }]);
    expect((await w.api(nova, "POST", "/linear/connect/result", {})).body).toEqual({ status: "connected", reconnected: false, workspaceName: "Acme Linear", urlKey: "acme" });
    expect((await w.api(nova, "POST", "/linear/connect/result", {})).body).toEqual({ status: "none" });
    expect((await w.callback("linear", { code: LINEAR_CODES.ok, state }, { session: nova.cookie, binder })).location).toBe("/app/onboard?linear=start_again");
    expect(w.codeCalls(LINEAR_COMPLETE)).toHaveLength(1);
  });

  it("refuses without the cookie, with another session's, a mismatched state, or after ten minutes, before asking Code", async () => {
    const w = world();
    const nova = await w.signIn(NOVA), bob = await w.signIn(BOB);
    const a = await w.start("linear", nova);
    expect((await w.callback("linear", { code: LINEAR_CODES.ok, state: a.state }, { session: nova.cookie })).location).toBe("/app/onboard?linear=start_again");
    expect((await w.callback("linear", { code: LINEAR_CODES.ok, state: a.state }, { session: bob.cookie, binder: a.binder })).location).toBe("/app/onboard?linear=start_again");
    const b = await w.start("linear", nova), c = await w.start("linear", nova);
    expect((await w.callback("linear", { code: LINEAR_CODES.ok, state: c.state }, { session: nova.cookie, binder: b.binder })).location).toBe("/app/onboard?linear=start_again");
    w.advance(10 * 60_000 + 1);
    expect((await w.callback("linear", { code: LINEAR_CODES.ok, state: c.state }, { session: nova.cookie, binder: c.binder })).location).toBe("/app/onboard?linear=start_again");
    // A Slack binding is not a Linear one.
    const s = await w.start("slack", nova);
    const back = await w.raw("GET", `${LINEAR_CALLBACK_PATH}?code=${LINEAR_CODES.ok}&state=${s.state}`, { cookie: `rovara_cloud_session=${nova.cookie}; rovara_cloud_linear=${s.binder}` });
    expect(back.headers.location).toBe("/app/onboard?linear=start_again");
    expect(w.codeCalls(LINEAR_COMPLETE)).toEqual([]);
  });

  it("lands on Cancel without asking Code, and on Code's refusals as one fixed word each", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const cancel = await w.start("linear", nova);
    expect((await w.callback("linear", { error: "access_denied", state: cancel.state }, { session: nova.cookie, binder: cancel.binder })).location).toBe("/app/onboard?linear=cancelled");
    const weird = await w.start("linear", nova);
    expect((await w.callback("linear", { error: "server_error", state: weird.state }, { session: nova.cookie, binder: weird.binder })).location).toBe("/app/onboard?linear=start_again");
    expect(w.codeCalls(LINEAR_COMPLETE)).toEqual([]);
    for (const [what, word] of [
      [LINEAR_CODES.taken, "taken"], ["nope", "start_again"],
      [respond(409, { error: { code: "LINEAR_WORKSPACE_TAKEN", message: LINEAR_WORDS.otherWorkspace } }), "other_workspace"],
      [respond(503, { error: { code: "RUNTIME_UNAVAILABLE", message: LINEAR_WORDS.notSetUp } }), "not_set_up"],
      [respond(503, { error: { code: "RUNTIME_UNAVAILABLE", message: "lin_oauth_leak" } }), "unavailable"],
      [respond(501, {}), "not_available"],
      [respond(200, { status: "connected", reconnected: false, workspace: { id: "x", name: "\u0000", urlKey: "a" } }), "unavailable"],
    ] as const) {
      const { binder, state } = await w.start("linear", nova);
      if (typeof what === "string") w.overrides.delete(`POST ${LINEAR_COMPLETE}`); else w.overrides.set(`POST ${LINEAR_COMPLETE}`, () => what.clone());
      expect((await w.callback("linear", { code: typeof what === "string" ? what : LINEAR_CODES.ok, state }, { session: nova.cookie, binder })).location, word).toBe(`/app/onboard?linear=${word}`);
    }
    expect(JSON.stringify(w.logs)).not.toContain("lin_oauth_leak");
  });
});

describe("the company's Linear connection, disconnect, and a project's team", () => {
  it("answers each company only its own connection, without ids or tokens", async () => {
    const w = world();
    const nova = await w.signIn(NOVA), bob = await w.signIn(BOB);
    w.linearOf.set(A, { id: "lin-a", name: "Acme Linear", urlKey: "acme" });
    expect((await w.api(nova, "GET", "/linear")).body).toEqual({ status: "connected", workspace: { name: "Acme Linear", urlKey: "acme" }, connectedAt: new Date(START).toISOString(), connectedBy: { name: "nova" } });
    expect((await w.api(bob, "GET", "/linear")).body).toEqual({ status: "disconnected" });
  });

  it("disconnect: an owner only (no step-up since owner DEC 254zzz73), checked before Code is asked; another company's owner never reaches A's", async () => {
    const w = world();
    w.linearOf.set(A, { id: "lin-a", name: "Acme Linear", urlKey: "acme" });
    w.picks.get(A)!.set("web", "team-a1");
    for (const who of [MAX, ADA]) {
      expect((await w.api(await w.signIn(who), "DELETE", "/linear")).body.error?.code, who.key).toBe("FORBIDDEN");
    }
    expect(w.calls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect((await w.api(await w.signIn(BOB), "DELETE", "/linear")).body).toEqual({ error: { code: "LINEAR_NOT_CONNECTED", message: LINEAR_WORDS.notConnected } });
    expect(w.linearOf.get(A)).toBeDefined();
    const nova = await w.signIn(NOVA_OLD);
    expect((await w.api(nova, "DELETE", "/linear")).body).toEqual({ status: "disconnected", workspaceName: "Acme Linear", projects: ["web"] });
    expect((await w.api(nova, "DELETE", "/linear")).body).toEqual({ error: { code: "LINEAR_NOT_CONNECTED", message: LINEAR_WORDS.notConnected } });
  });

  it("reads, picks and clears a project's team for the person's own company only", async () => {
    const w = world();
    w.linearOf.set(A, { id: "lin-a", name: "Acme Linear", urlKey: "acme" });
    const nova = await w.signIn(NOVA), bob = await w.signIn(BOB), max = await w.signIn(MAX);
    expect((await w.api(nova, "GET", "/projects/web/linear")).body).toEqual({ team: null, teams: [{ id: "team-a1", key: "WEB", name: "Web" }, { id: "team-a2", key: "API", name: "Api" }] });
    expect((await w.api(nova, "PUT", "/projects/web/linear", { teamId: "team-a2" })).body).toEqual({ team: { id: "team-a2", key: "API", name: "Api" } });
    expect((await w.api(nova, "GET", "/projects/web/linear")).body).toMatchObject({ team: { id: "team-a2" } });
    // Another company's team id is not found; another company's project is not found; a member is refused.
    expect((await w.api(nova, "PUT", "/projects/web/linear", { teamId: "team-b1" })).body).toEqual({ error: { code: "NOT_FOUND", message: LINEAR_WORDS.teamNotFound } });
    expect((await w.api(bob, "GET", "/projects/web/linear")).body).toEqual({ error: { code: "NOT_FOUND", message: LINEAR_WORDS.projectNotFound } });
    expect((await w.api(bob, "GET", "/projects/ledger/linear")).body).toEqual({ error: { code: "LINEAR_NOT_CONNECTED", message: LINEAR_WORDS.notConnected } });
    expect((await w.api(max, "PUT", "/projects/web/linear", { teamId: "team-a1" })).body).toEqual({ error: { code: "FORBIDDEN", message: LINEAR_WORDS.teamAdminOnly } });
    for (const body of [{}, { teamId: "a b" }, { teamId: "team-a1", companyId: B }]) expect((await w.api(nova, "PUT", "/projects/web/linear", body)).body).toEqual({ error: { code: "CONFIG_INVALID", message: LINEAR_WORDS.pickTeam } });
    expect((await w.api(nova, "DELETE", "/projects/web/linear")).body).toEqual({ team: null, cleared: true });
    expect(JSON.stringify(w.calls)).not.toContain("org_");
    w.overrides.set("GET /v1/dev/company/linear/projects/web", () => respond(409, { error: { code: "LINEAR_NOT_CONNECTED", message: LINEAR_WORDS.needsReconnect } }));
    expect((await w.api(nova, "GET", "/projects/web/linear")).body).toEqual({ error: { code: "LINEAR_NOT_CONNECTED", message: LINEAR_WORDS.needsReconnect } });
    w.overrides.set("GET /v1/dev/company/linear/projects/web", () => respond(200, { team: null, teams: [{ id: "t", key: "K", name: "<‮>" }] }));
    expect((await w.api(nova, "GET", "/projects/web/linear")).body).toEqual({ error: { code: "RUNTIME_UNAVAILABLE", message: LINEAR_WORDS.teamsUnavailable } });
  });
});

describe("connectBack: the only pages a connect comes back to", () => {
  it("allows /app and plain segments, nothing else", () => {
    for (const ok of ["/app", "/app/onboard", "/app/admin/projects/web", "/app/admin/connections"]) expect(connectBack(ok)).toBe(ok);
    for (const bad of ["", "/", "/apps", "/app/", "/app//x", "/app/../x", "/app/./x", "/app/x?y", "/app/x#y", "/app/%2e", "https://x/app", "/app/a/b/c/d/e", 5, null, `/app/${"a".repeat(101)}`]) expect(connectBack(bad), String(bad)).toBeUndefined();
  });
});

describe("nothing secret leaks", () => {
  it("keeps states, Slack's and Linear's codes, cookies and binders out of every log line, landing address and stored row's plain text", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const secrets: string[] = [nova.cookie, SLACK_CODES.ok, LINEAR_CODES.ok];
    const locations: string[] = [];
    for (const provider of ["slack", "linear"] as const) {
      const { binder, state } = await w.start(provider, nova);
      secrets.push(binder, state);
      const back = await w.callback(provider, { code: provider === "slack" ? SLACK_CODES.ok : LINEAR_CODES.ok, state }, { session: nova.cookie, binder });
      locations.push(back.location!, back.body);
      const bad = await w.callback(provider, { code: "leak-me-code", state: "q".repeat(43) }, { session: nova.cookie, binder });
      locations.push(bad.location!, bad.body);
      secrets.push("leak-me-code", "q".repeat(43));
    }
    // Positive control: the callbacks did reach Code with the real values.
    expect(w.codeCalls(SLACK_COMPLETE)).toHaveLength(1);
    expect(w.codeCalls(LINEAR_COMPLETE)).toHaveLength(1);
    const visible = JSON.stringify([w.logs, locations, w.pendingWrites.map(([key, row]) => [key, row])]);
    for (const value of secrets) expect(visible, value).not.toContain(value);
  });
});

describe("review gaps: every trust check has its own test", () => {
  it("a session cookie with no stored sign-in, or a binding row with a malformed sign-in hash, is refused cleanly", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const a = await w.start("slack", nova);
    await w.sessions.delete(nova.cookie);
    expect(await w.callback("slack", { code: SLACK_CODES.ok, state: a.state }, { session: nova.cookie, binder: a.binder })).toMatchObject({ status: 302, location: "/app/onboard?slack=start_again" });
    const nova2 = await w.signIn(NOVA);
    const b = await w.start("slack", nova2);
    const [key, row] = w.pendingWrites.at(-1)!;
    await w.put(key, { ...row, connect: { ...row.connect!, session: "short" } });
    expect(await w.callback("slack", { code: SLACK_CODES.ok, state: b.state }, { session: nova2.cookie, binder: b.binder })).toMatchObject({ status: 302, location: "/app/onboard?slack=start_again" });
    expect(w.codeCalls(SLACK_COMPLETE)).toEqual([]);
  });

  it("a kept outcome of another provider, another kind or another sign-in's hash under this key reads as nothing", async () => {
    for (const change of [
      (row: PendingSignIn) => ({ ...row, connect: { ...row.connect!, provider: "linear" as const } }),
      (row: PendingSignIn) => ({ ...row, connect: { ...row.connect!, kind: "state" as const } }),
      (row: PendingSignIn) => ({ ...row, connect: { ...row.connect!, session: "0".repeat(64) } }),
    ]) {
      const w = world();
      const nova = await w.signIn(NOVA);
      const { binder, state } = await w.start("slack", nova);
      await w.callback("slack", { code: SLACK_CODES.ok, state }, { session: nova.cookie, binder });
      const [key, row] = w.pendingWrites.at(-1)!;
      await w.put(key, change(structuredClone(row)));
      expect((await w.api(nova, "POST", "/slack/install/result", {})).body).toEqual({ status: "none" });
    }
  });

  it("someone Code names no company for is refused at both starts and both disconnects, before Code is asked", async () => {
    const w = world();
    const nobody = await w.signIn(NOBODY);
    for (const [method, path] of [["POST", "/slack/install"], ["POST", "/linear/connect"], ["POST", "/slack/disconnect"], ["DELETE", "/linear"]] as const) {
      expect((await w.api(nobody, method, path, method === "POST" ? {} : undefined)).body, path).toEqual({ error: { code: "NO_COMPANY", message: "You're not in a company yet." } });
    }
    expect(w.calls.filter((c) => c.path !== "/v1/dev/access")).toEqual([]);
  });

  it("Slack: a scope list that doesn't read, or a complete answer without a workspace, is refused", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const state = "s".repeat(43);
    w.overrides.set("POST /v1/dev/company/slack/install", () => respond(200, { state, expiresAt: new Date(START).toISOString(), authorizeUrl: `https://slack.com/oauth/v2/authorize?${new URLSearchParams({ client_id: "1.2", scope: "chat:write user_scope=admin", redirect_uri: SLACK_REDIRECT, state }).toString()}` }));
    expect((await w.api(nova, "POST", "/slack/install", {})).status).toBe(503);
    w.overrides.delete("POST /v1/dev/company/slack/install");
    const a = await w.start("slack", nova);
    w.overrides.set(`POST ${SLACK_COMPLETE}`, () => respond(200, { status: "connected", alreadyConnected: false }));
    expect((await w.callback("slack", { code: SLACK_CODES.ok, state: a.state }, { session: nova.cookie, binder: a.binder })).location).toBe("/app/onboard?slack=unavailable");
  });

  it("every project route checks the project name before asking Code", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    for (const [method, path, body] of [
      ["GET", "/projects/Bad_Name/slack/channel", undefined], ["DELETE", "/projects/Bad_Name/slack/channel", undefined], ["POST", "/projects/Bad_Name/slack/channel/check", { channelId: "CWEB00001" }],
      ["GET", "/projects/Bad_Name/linear", undefined], ["PUT", "/projects/Bad_Name/linear", { teamId: "t1" }], ["DELETE", "/projects/Bad_Name/linear", undefined],
    ] as const) {
      expect((await w.api(nova, method, path, body)).status, `${method} ${path}`).toBe(404);
    }
    expect(w.calls.filter((c) => c.path.includes("/projects/"))).toEqual([]);
  });

  it("Linear: the authorize address needs a PKCE challenge, response_type=code and prompt=consent; the callback's code must read and be one value", async () => {
    const w = world();
    const nova = await w.signIn(NOVA);
    const state = "s".repeat(43);
    const good: Record<string, string> = { client_id: "linclient1", redirect_uri: LINEAR_REDIRECT, response_type: "code", scope: "read", state, actor: "app", prompt: "consent", code_challenge: "c".repeat(43), code_challenge_method: "S256" };
    for (const change of [{ code_challenge: "short" }, { response_type: "token" }, { prompt: "none" }]) {
      w.overrides.set("POST /v1/dev/company/linear/connect", () => respond(200, { state, expiresAt: new Date(START).toISOString(), authorizeUrl: `https://linear.app/oauth/authorize?${new URLSearchParams({ ...good, ...change }).toString()}` }));
      expect((await w.api(nova, "POST", "/linear/connect", {})).status, JSON.stringify(change)).toBe(503);
    }
    w.overrides.delete("POST /v1/dev/company/linear/connect");
    for (const query of [`code=${LINEAR_CODES.ok}&code=${LINEAR_CODES.ok}`, "code=bad%20code", "code=a%2Fb"]) {
      const { binder, state: s } = await w.start("linear", nova);
      expect((await w.callback("linear", `state=${s}&${query}`, { session: nova.cookie, binder })).location, query).toBe("/app/onboard?linear=start_again");
    }
    expect(w.codeCalls(LINEAR_COMPLETE)).toEqual([]);
    // A workspace url key that doesn't read is refused.
    const { binder, state: s } = await w.start("linear", nova);
    w.overrides.set(`POST ${LINEAR_COMPLETE}`, () => respond(200, { status: "connected", reconnected: false, workspace: { id: "lin-1", name: "Acme", urlKey: "Bad Key!" } }));
    expect((await w.callback("linear", { code: LINEAR_CODES.ok, state: s }, { session: nova.cookie, binder })).location).toBe("/app/onboard?linear=unavailable");
  });
});
