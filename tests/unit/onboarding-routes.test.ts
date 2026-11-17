// Onboarding (DEC 253z, 254a; onboarding-routes.ts and the join paths in handler.ts): a person with no company creates one through Code with an
// operator's invite code, in Cloud's fixed words; and an invite link joins a company. The link carries only an opaque token; Cloud's server
// looks the invite up and sends `company=` to Code's sign-in itself (never from the browser); Code still checks the email; any failure is one
// sentence. Two companies throughout.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CodeClient, JOIN_PATH, LocalCompanyStore, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest, type InviteRecord,
} from "../../packages/cloud-server/src/index.js";

const CODE = "https://code.example.test";
const ORIGIN = "https://cloud.example.test";
const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const START = Date.parse("2026-11-17T12:00:00.000Z");
const NOVA = "1".repeat(64);
const UNUSABLE = { error: { code: "INVITE_UNUSABLE", message: "This invite can't be used. Ask your company admin for a new one." } };
const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

function world() {
  let clock = START;
  // What Code's access check says of Nova's company (none at first), and what its company route answers.
  let company: Record<string, unknown> | undefined;
  let createAnswer: () => Response = () => respond(200, { companyId: B, companyName: "Nova Co", companyRole: "owner", requestId: "r" });
  const calls: Array<{ method: string; path: string; authorization?: string; body?: unknown }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ method: init?.method ?? "GET", path: url.pathname, ...(authorization === undefined ? {} : { authorization }), ...(body === undefined ? {} : { body }) });
    if (url.pathname === "/v1/auth/token") return respond(200, { access_token: "nova-token" });
    if (authorization !== "Bearer nova-token") return respond(401, { error: { code: "AUTH_REQUIRED" } });
    if (url.pathname === "/v1/dev/access") return respond(200, { developerId: NOVA, displayName: "Nova", administrator: false, projects: [], notices: [], ...company });
    if (url.pathname === "/v1/dev/company" && init?.method === "POST") return createAnswer();
    return respond(404, { error: { code: "NOT_FOUND", message: "route not found" } });
  }) as typeof fetch;
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: `${ORIGIN}/callback`, scopes: "", fetch: fetchImpl });
  const sessions = new LocalSessionStore(undefined, { now: () => clock, environment: {} });
  const store = new LocalCompanyStore();
  const logs: Array<Record<string, unknown>> = [];
  const handler = createCloudHandler({
    client, store: sessions, org: { orgId: "rovara", name: "Rovara", plan: "cloud" }, callbackPath: "/callback", secureCookies: true, work: new LocalWorkSessionStore(), origin: ORIGIN,
    company: { store }, now: () => new Date(clock), log: (event) => { logs.push(event); },
  });
  const raw = async (method: string, target: string, headers: Record<string, string> = {}, body?: string) => {
    const url = new URL(target, ORIGIN);
    const request: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers, ...(body === undefined ? {} : { body }) };
    return (await handler(request))!;
  };
  /** Nova signed in (no company), with her cookie and CSRF. */
  const signIn = async () => {
    const id = `cookie-${randomUUID()}`;
    await sessions.create(id, { accessToken: "nova-token", access: { developerId: NOVA, displayName: "Nova", administrator: false, projects: [], notices: [], ...company }, csrf: "csrf-nova", signedInAt: new Date(clock).toISOString() });
    return id;
  };
  const api = async (cookie: string, method: string, path: string, body?: unknown, csrf = "csrf-nova") => {
    const answer = await raw(method, `/v1/web${path}`, { cookie: `rovara_cloud_session=${cookie}`, "x-rovara-csrf": csrf, "content-type": "application/json" }, body === undefined ? undefined : JSON.stringify(body));
    return { status: answer.status, body: JSON.parse(answer.body) as Record<string, unknown> & { error?: { code: string; message: string } } };
  };
  /** A pending invite to company `companyId`, as the invite route keeps it once Code took the pre-approval. Answers the link's token. */
  const invite = async (companyId = A, change: Partial<InviteRecord> = {}) => {
    const token = randomUUID().replace(/-/gu, "").padEnd(43, "x").slice(0, 43);
    const record: InviteRecord = {
      companyId, inviteId: randomUUID(), requestId: randomUUID(), role: "member", email: "nova@example.com", tokenHash: hash(token), createdBy: "a".repeat(64),
      createdAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 7 * 86_400_000).toISOString(), state: "pending", revision: 1, companyName: companyId === A ? "Acme" : "Bee Co", ...change,
    };
    await store.createInvite(record);
    return { token, record };
  };
  const lookUp = (token: unknown, headers: Record<string, string> = { origin: ORIGIN, "content-type": "application/json" }) => raw("POST", JOIN_PATH, headers, JSON.stringify({ invite: token }));
  const ticketOf = (answer: { headers: Record<string, string> }) => /^rovara_cloud_join=([A-Za-z0-9_-]{43});/u.exec(answer.headers["set-cookie"] ?? "")?.[1];
  return {
    raw, api, signIn, invite, lookUp, ticketOf, store, sessions, calls, logs,
    setCompany: (value: Record<string, unknown> | undefined) => { company = value; }, setCreate: (answer: () => Response) => { createAnswer = answer; },
    advance: (ms: number) => { clock += ms; },
  };
}

describe("creating a company (DEC 254a)", () => {
  it("asks Code as the person, with only the name and the invite code, and has the app sign in again", async () => {
    const w = world();
    const nova = await w.signIn();
    const made = await w.api(nova, "POST", "/companies", { name: "  Nova \t Co ", inviteCode: "inv_abcdefgh1234" });
    expect(made).toEqual({ status: 201, body: { companyId: B, signInAgain: true } });
    expect(w.calls.filter((call) => call.path === "/v1/dev/company")).toEqual([{ method: "POST", path: "/v1/dev/company", authorization: "Bearer nova-token", body: { name: "Nova Co", inviteCode: "inv_abcdefgh1234" } }]);
  });

  it("refuses a body that doesn't read, or names a company, before asking Code", async () => {
    const w = world();
    const nova = await w.signIn();
    for (const body of [undefined, [], { name: "Co" }, { inviteCode: "inv_abcdefgh1234" }, { name: "", inviteCode: "inv_abcdefgh1234" }, { name: "x".repeat(81), inviteCode: "inv_abcdefgh1234" },
      { name: "Co\u0000", inviteCode: "inv_abcdefgh1234" }, { name: "Co‮", inviteCode: "inv_abcdefgh1234" }, { name: "Co", inviteCode: "short" }, { name: "Co", inviteCode: "has space 123" },
      { name: "Co", inviteCode: "inv_abcdefgh1234", companyId: A }, { name: 5, inviteCode: "inv_abcdefgh1234" }]) {
      const answer = await w.api(nova, "POST", "/companies", body);
      expect({ body, status: answer.status, code: answer.body.error?.code }).toEqual({ body, status: 400, code: "CONFIG_INVALID" });
    }
    expect(w.calls.filter((call) => call.path === "/v1/dev/company")).toEqual([]);
    expect((await w.api(nova, "POST", "/companies", { name: "Co", inviteCode: "inv_abcdefgh1234" }, "wrong")).status).toBe(403);
  });

  it("refuses a person Code already names a company for, without asking Code to create one", async () => {
    const w = world();
    w.setCompany({ companyId: A, companyRole: "member" });
    const nova = await w.signIn();
    expect(await w.api(nova, "POST", "/companies", { name: "Co", inviteCode: "inv_abcdefgh1234" })).toEqual({ status: 409, body: { error: { code: "CONFLICT", message: "You're already in a company." } } });
    expect(w.calls.filter((call) => call.path === "/v1/dev/company")).toEqual([]);
  });

  it("answers Code's outcomes in Cloud's fixed words, never Code's", async () => {
    const cases: Array<[number, unknown, number, string]> = [
      [403, { error: { code: "FORBIDDEN", message: "code inv_SECRET used by someone@x" } }, 403, "This invite code can't be used. Ask the Rovara team for a new one."],
      [409, { error: { code: "CONFLICT", message: "member of org_zzz" } }, 409, "You're already in a company."],
      [429, { error: { code: "RATE_LIMITED", message: "slow down" } }, 429, "Too many tries. Wait an hour and try again."],
      [404, { error: { code: "NOT_FOUND", message: "route not found" } }, 501, "Creating a company isn't available yet."],
      [500, { error: { code: "X", message: "stack trace" } }, 503, "Your company couldn't be created right now. Try again in a moment."],
      [200, { companyId: B, companyRole: "member" }, 503, "Your company couldn't be created right now. Try again in a moment."],
      [200, { companyId: "acme", companyRole: "owner" }, 503, "Your company couldn't be created right now. Try again in a moment."],
    ];
    for (const [codeStatus, codeBody, status, message] of cases) {
      const w = world();
      w.setCreate(() => respond(codeStatus, codeBody));
      const answer = await w.api(await w.signIn(), "POST", "/companies", { name: "Co", inviteCode: "inv_abcdefgh1234" });
      expect({ codeStatus, status: answer.status, message: answer.body.error?.message }).toEqual({ codeStatus, status, message });
      expect(JSON.stringify(answer.body)).not.toMatch(/SECRET|someone|org_zzz|stack/u);
    }
  });
});

describe("joining from an invite link", () => {
  it("looks the invite up server-side: the company's name, and a single-use ticket in an HttpOnly cookie; the token is never echoed", async () => {
    const w = world();
    const { token } = await w.invite(A);
    const found = await w.lookUp(token);
    expect(found.status).toBe(200);
    expect(JSON.parse(found.body)).toEqual({ companyName: "Acme" });
    expect(found.headers["set-cookie"]).toMatch(/^rovara_cloud_join=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Lax; Path=\/v1\/auth\/browser; Secure; Max-Age=600$/u);
    expect(JSON.stringify(found)).not.toContain(token);
  });

  it("answers the one sentence for an invite that can't be used: unknown, withdrawn, used, unconfirmed, expired, malformed", async () => {
    const w = world();
    const tokens = [
      "y".repeat(43), (await w.invite(A, { state: "revoked" })).token, (await w.invite(A, { state: "accepted" })).token, (await w.invite(A, { state: "unconfirmed" })).token,
      (await w.invite(A, { expiresAt: new Date(START - 1).toISOString() })).token, (await w.invite("not-a-company")).token, "short", 42, null,
    ];
    for (const token of tokens) {
      const answer = await w.lookUp(token);
      expect({ token, status: answer.status, body: JSON.parse(answer.body) as unknown, cookie: answer.headers["set-cookie"] }).toEqual({ token, status: 404, body: UNUSABLE, cookie: undefined });
    }
    const { token } = await w.invite(A);
    expect((await w.raw("POST", JOIN_PATH, { origin: ORIGIN, "content-type": "application/json" }, JSON.stringify({ invite: token, company: B }))).status).toBe(404);
  });

  it("never looks up a token that isn't one a link carries", async () => {
    const w = world();
    const looked: string[] = [];
    const real = w.store.inviteByToken.bind(w.store);
    w.store.inviteByToken = async (tokenHash: string) => { looked.push(tokenHash); return real(tokenHash); };
    for (const token of ["a".repeat(42), "a".repeat(44), `${"a".repeat(42)}=`, `${"a".repeat(42)}/`, "a".repeat(43) + "\n"]) expect((await w.lookUp(token)).status).toBe(404);
    expect(looked).toEqual([]);
    expect((await w.lookUp("a".repeat(43))).status).toBe(404);
    expect(looked).toEqual([hash("a".repeat(43))]);
  });

  it("starts a join only from a ticket the lookup kept, never from another kind of pending sign-in under that name", async () => {
    const w = world();
    const { record } = await w.invite(A);
    const ticket = "t".repeat(43);
    await w.sessions.putPending(`join.${ticket}`, { verifier: "v", returnTo: "/app", at: START, invite: record.tokenHash });
    expect((await w.raw("GET", "/v1/auth/browser/authorize?join=1", { cookie: `rovara_cloud_join=${ticket}` })).headers.location).toBe("/app/join?unusable=1");
  });

  it("takes the lookup only from the app's own page: same origin, JSON", async () => {
    const w = world();
    const { token } = await w.invite(A);
    for (const headers of [{ "content-type": "application/json" }, { origin: "https://evil.example", "content-type": "application/json" }, { origin: "null", "content-type": "application/json" }, { origin: ORIGIN, "content-type": "text/plain" }]) {
      const answer = await w.lookUp(token, headers);
      expect({ headers, status: answer.status, cookie: answer.headers["set-cookie"] }).toEqual({ headers, status: 403, cookie: undefined });
    }
  });

  it("signs in through Code with the invite's company, chosen by Cloud's server from the ticket, never from the request", async () => {
    const w = world();
    const { token } = await w.invite(A);
    const ticket = w.ticketOf(await w.lookUp(token))!;
    const start = await w.raw("GET", `/v1/auth/browser/authorize?join=1&company=${B}&return_to=/app/admin`, { cookie: `rovara_cloud_join=${ticket}` });
    expect(start.status).toBe(302);
    const to = new URL(start.headers.location!);
    expect(to.origin + to.pathname).toBe(`${CODE}/v1/auth/authorize`);
    expect(to.searchParams.getAll("company")).toEqual([A]);
    expect(to.toString()).not.toContain(token);
    expect(start.headers["set-cookie"]).toMatch(/^rovara_cloud_join=; .*Max-Age=0$/u);
    // Single use: the same ticket again goes to the one sentence.
    expect((await w.raw("GET", "/v1/auth/browser/authorize?join=1", { cookie: `rovara_cloud_join=${ticket}` })).headers.location).toBe("/app/join?unusable=1");
    // The ordinary sign-in never sends a company, whatever the request says.
    expect(new URL((await w.raw("GET", `/v1/auth/browser/authorize?company=${B}`)).headers.location!).searchParams.has("company")).toBe(false);
  });

  it("sends a join to the one sentence with no ticket, a made-up one, an old one, or once the invite stopped being usable", async () => {
    const w = world();
    expect((await w.raw("GET", "/v1/auth/browser/authorize?join=1")).headers.location).toBe("/app/join?unusable=1");
    expect((await w.raw("GET", "/v1/auth/browser/authorize?join=1", { cookie: `rovara_cloud_join=${"z".repeat(43)}` })).headers.location).toBe("/app/join?unusable=1");
    const old = await w.invite(A);
    const oldTicket = w.ticketOf(await w.lookUp(old.token))!;
    w.advance(10 * 60_000 + 1);
    expect((await w.raw("GET", "/v1/auth/browser/authorize?join=1", { cookie: `rovara_cloud_join=${oldTicket}` })).headers.location).toBe("/app/join?unusable=1");
    const withdrawn = await w.invite(A);
    const ticket = w.ticketOf(await w.lookUp(withdrawn.token))!;
    await w.store.updateInvite({ ...withdrawn.record, state: "revoked", revision: 2 }, { revision: 1, state: "pending" });
    expect((await w.raw("GET", "/v1/auth/browser/authorize?join=1", { cookie: `rovara_cloud_join=${ticket}` })).headers.location).toBe("/app/join?unusable=1");
    expect(w.calls).toEqual([]);
  });

  const joinTo = async (w: ReturnType<typeof world>, companyId: string) => {
    const made = await w.invite(companyId);
    const start = await w.raw("GET", "/v1/auth/browser/authorize?join=1", { cookie: `rovara_cloud_join=${w.ticketOf(await w.lookUp(made.token))!}` });
    return { made, state: new URL(start.headers.location!).searchParams.get("state")! };
  };

  it("marks the invite taken once Code put the person in the invite's company, and lands in the app", async () => {
    const w = world();
    const { made, state } = await joinTo(w, A);
    w.setCompany({ companyId: A, companyRole: "member", companyName: "Acme" });
    const back = await w.raw("GET", `/callback?code=c1&state=${state}`);
    expect(back.status).toBe(302);
    expect(back.headers.location).toBe("/app?joined=1");
    expect(back.headers["set-cookie"]).toMatch(/^rovara_cloud_session=/u);
    expect(await w.store.invite(A, made.record.inviteId)).toMatchObject({ state: "accepted", acceptedBy: NOVA });
    // Used: the link does nothing any more.
    expect((await w.lookUp(made.token)).status).toBe(404);
  });

  it("doesn't take the invite when Code put the person in another company (or none), and says the one sentence", async () => {
    for (const company of [{ companyId: B, companyRole: "owner" }, undefined]) {
      const w = world();
      const { made, state } = await joinTo(w, A);
      w.setCompany(company);
      expect((await w.raw("GET", `/callback?code=c1&state=${state}`)).headers.location).toBe("/app/join?unusable=1");
      expect(await w.store.invite(A, made.record.inviteId)).toMatchObject({ state: "pending" });
    }
  });

  it("shows Code's refusal of a join as the one sentence, never Code's words", async () => {
    const w = world();
    const { made, state } = await joinTo(w, A);
    const back = await w.raw("GET", `/callback?error=access_denied%20email%20nova%40example.com%20not%20preapproved&state=${state}`);
    expect({ status: back.status, location: back.headers.location }).toEqual({ status: 302, location: "/app/join?unusable=1" });
    expect(back.body).not.toContain("nova");
    expect(await w.store.invite(A, made.record.inviteId)).toMatchObject({ state: "pending" });
  });

  it("never takes a join ticket as a sign-in's state", async () => {
    const w = world();
    const { token } = await w.invite(A);
    const ticket = w.ticketOf(await w.lookUp(token))!;
    expect((await w.raw("GET", `/callback?code=c1&state=join.${ticket}`)).status).toBe(400);
    expect(w.calls).toEqual([]);
  });
});
