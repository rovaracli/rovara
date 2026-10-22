// Plan 3, Task 21a-presence (PF31h, R66, R67): decisions need a person present. This file tests the presence machinery: decide tickets
// and their limits, the one-decision session, requireDecideSession, the sign-in flow that makes the session, and the confirmation page.
// The decide routes themselves (decideApproval, decideSpendRequest, the approval kinds) belong to 21a-wiring; a fake `DecideKind` stands
// in for them here.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { OrgId } from "@agentx/contracts";
import {
  APPROVAL_ID_PATTERN,
  DECIDE_COOKIE,
  DecideStore,
  RATE_LIMIT_MESSAGE,
  TICKET_EXPIRED_MESSAGE,
  csrfTokenFor,
  requireDecideSession,
  type DecideRequestContext,
} from "../../packages/broker/src/developer/decide-session.js";
import type { ConfirmView, DecideInspection, DecideKind, DecideTarget } from "../../packages/broker/src/developer/decide-kinds.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import type { HttpApiV2Event } from "../../packages/broker/src/aws/lambda.js";
import type { HttpResult } from "../../packages/broker/src/developer/server.js";
import { DECIDE_PKCE_COOKIE, TICKET_EXPIRED_MESSAGE as EXPIRED } from "../../packages/broker/src/developer/decide-session.js";
import { DECIDE_NOTICE_SENTENCE } from "../../packages/broker/src/developer/identity-notice.js";
import { API, ISSUER, OIDC_ISSUER, fakeCognito, httpEvent, identityHarness, type FakeCognitoUser, type FakeOidcUser } from "../support/developer-fakes.js";

const T0 = Date.parse("2026-10-21T12:00:00.000Z");
const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const OTHER_ORG = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const APR_A = "apr_aaaaaaaaaaaaaaaaaaaa";
const APR_B = "apr_bbbbbbbbbbbbbbbbbbbb";
const SPR_A = "spr_aaaaaaaaaaaaaaaaaaaa";
const CELL = "https://abc123.execute-api.us-east-1.amazonaws.com";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const refusal = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; statusCode?: number; message: string; details?: Record<string, unknown> }) => ({
  code: error.code, status: error.statusCode, message: error.message.replace(`${String(error.code)}: `, ""), details: error.details,
}));

/** A fake kind: `open` for the members in `eligible`, forbidden for the rest, not found for any org but ORG; it records what it decided. */
function fakeKind(eligible: Set<string>, decided: Array<{ target: DecideTarget; decision: string }> = []): DecideKind & { decided: typeof decided; view: ConfirmView; eligible: Set<string>; orgId: OrgId | undefined; closed?: { by: string; at: string } } {
  const view: ConfirmView = { title: "Run a write", facts: [{ label: "Agent", value: "Triage" }] };
  const kind = {
    decided, view, eligible, orgId: ORG as OrgId | undefined, closed: undefined as { by: string; at: string } | undefined,
    async inspect(target: DecideTarget): Promise<DecideInspection> {
      if (kind.orgId !== undefined && target.orgId !== kind.orgId) return { status: "not_found" };
      if (kind.closed !== undefined) return { status: "decided", ...kind.closed };
      return kind.eligible.has(target.developerId) ? { status: "open", view } : { status: "forbidden", who: "a project maintainer" };
    },
    async decide(target: DecideTarget, decision: "approve" | "decline") {
      decided.push({ target, decision });
      return { message: decision === "approve" ? "Approved." : "Declined." };
    },
  };
  return kind;
}

function setup(options: { eligible?: string[] } = {}) {
  let clock = T0;
  const now = () => clock;
  const db = new FakeDynamoDb();
  const store = new DecideStore({ documentClient: db, tableName: "signin", now });
  const kind = fakeKind(new Set(options.eligible ?? [ALICE]));
  const context: DecideRequestContext = {
    store, now, cellOrigin: CELL, kinds: { apr: kind, spr: kind },
    authenticateBearer: async (authorization) => {
      if (authorization === "Bearer alice") return { developerId: ALICE, orgId: ORG };
      if (authorization === "Bearer bob") return { developerId: BOB, orgId: ORG };
      if (authorization === "Bearer stranger") return { developerId: ALICE, orgId: OTHER_ORG };
      throw Object.assign(new Error("AUTH_REQUIRED: bad token"), { code: "AUTH_REQUIRED" });
    },
  };
  return { db, store, kind, context, now, tick: (ms: number) => { clock += ms; } };
}
const seconds = (ms: number) => Math.floor(ms / 1000);

/** A signed-in session for `approvalId`, signed in `agoSeconds` ago, as the sign-in function writes it. */
async function sessionFor(s: ReturnType<typeof setup>, approvalId: string, developerId = ALICE, agoSeconds = 0, cookie = `cookie-${Math.random().toString(36).slice(2)}-${"x".repeat(30)}`) {
  const signedInAt = seconds(s.now()) - agoSeconds;
  await s.store.putSession(cookie, { orgId: ORG, developerId, approvalId, signedInAt, method: "email_code", csrfHash: sha(csrfTokenFor(cookie)), expiresAt: signedInAt + 600 });
  return cookie;
}
const get = (path: string, headers: Record<string, string> = {}) => ({ method: "GET", path, headers });
const post = (path: string, cookie: string | undefined, fields: Record<string, string>, headers: Record<string, string> = {}) => ({
  method: "POST", path,
  headers: { origin: CELL, "content-type": "application/x-www-form-urlencoded", ...(cookie === undefined ? {} : { cookie: `${DECIDE_COOKIE}=${cookie}` }), ...headers },
  body: new URLSearchParams(fields).toString(),
});
const withCookie = (cookie: string) => ({ cookie: `${DECIDE_COOKIE}=${cookie}` });

describe("decide tickets (R7-1)", () => {
  it("stores only the hash of the value, and redeems it once for the member and approval it was minted for", async () => {
    const s = setup();
    const value = await s.store.mintTicket({ orgId: ORG, developerId: ALICE, approvalId: APR_A, mintedBy: "token" });
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = s.db.get(`DECIDE_TICKET#${sha(value)}`, "META");
    expect(stored).toMatchObject({ orgId: ORG, developerId: ALICE, approvalId: APR_A, mintedBy: "token" });
    expect(stored?.expiresAt).toBe(seconds(T0) + 600);
    expect(JSON.stringify(s.db.find(() => true))).not.toContain(value);
    expect(await s.store.redeemTicket(value)).toMatchObject({ orgId: ORG, developerId: ALICE, approvalId: APR_A, mintedBy: "token" });
    expect(await s.store.redeemTicket(value)).toBeUndefined();
  });

  it("refuses an unknown, malformed or expired value, and creates nothing", async () => {
    const s = setup();
    const value = await s.store.mintTicket({ orgId: ORG, developerId: ALICE, approvalId: APR_A, mintedBy: "identified_session" });
    s.tick(601_000);
    expect(await s.store.redeemTicket(value)).toBeUndefined();
    expect(await s.store.redeemTicket("A".repeat(43))).toBeUndefined();
    expect(await s.store.redeemTicket("short")).toBeUndefined();
    expect(await s.store.redeemTicket("")).toBeUndefined();
    expect(s.db.find((item) => String(item.pk).startsWith("DECIDE_TICKET#"))).toHaveLength(1);
  });

  it("allows one unused ticket per (approval, member): a new mint marks the previous one used", async () => {
    const s = setup();
    const first = await s.store.mintTicket({ orgId: ORG, developerId: ALICE, approvalId: APR_A, mintedBy: "token" });
    const second = await s.store.mintTicket({ orgId: ORG, developerId: ALICE, approvalId: APR_A, mintedBy: "token" });
    expect(await s.store.redeemTicket(first)).toBeUndefined();
    expect(await s.store.redeemTicket(second)).toBeDefined();
    // Another approval, or another member, keeps its own.
    const other = await s.store.mintTicket({ orgId: ORG, developerId: ALICE, approvalId: APR_B, mintedBy: "token" });
    const bobs = await s.store.mintTicket({ orgId: ORG, developerId: BOB, approvalId: APR_A, mintedBy: "token" });
    expect(await s.store.redeemTicket(other)).toBeDefined();
    expect(await s.store.redeemTicket(bobs)).toBeDefined();
  });

  it("allows 10 tickets per member per hour and refuses the 11th with 429 and the one text", async () => {
    const s = setup();
    for (let index = 0; index < 10; index += 1) {
      await s.store.mintTicket({ orgId: ORG, developerId: ALICE, approvalId: `apr_${String(index).padStart(20, "a")}`, mintedBy: "token" });
    }
    const refused = await refusal(s.store.mintTicket({ orgId: ORG, developerId: ALICE, approvalId: APR_A, mintedBy: "token" }));
    expect(refused).toMatchObject({ code: "TOO_MANY_REQUESTS", status: 429, message: RATE_LIMIT_MESSAGE });
    expect(RATE_LIMIT_MESSAGE).toBe("Too many confirmation attempts. Try again later.");
    // Another member is unaffected, and the hour after, so is Alice.
    await s.store.mintTicket({ orgId: ORG, developerId: BOB, approvalId: APR_A, mintedBy: "token" });
    s.tick(3_600_000);
    await s.store.mintTicket({ orgId: ORG, developerId: ALICE, approvalId: APR_A, mintedBy: "token" });
  });

  it("allows 20 tickets per approval per day, whoever asks", async () => {
    const s = setup();
    for (let index = 0; index < 20; index += 1) {
      await s.store.mintTicket({ orgId: ORG, developerId: String(index).padStart(64, "0"), approvalId: APR_A, mintedBy: "token" });
    }
    expect(await refusal(s.store.mintTicket({ orgId: ORG, developerId: ALICE, approvalId: APR_A, mintedBy: "token" }))).toMatchObject({ code: "TOO_MANY_REQUESTS", status: 429, message: RATE_LIMIT_MESSAGE });
    s.tick(86_400_000);
    await s.store.mintTicket({ orgId: ORG, developerId: ALICE, approvalId: APR_A, mintedBy: "token" });
  });

  it("allows one Cognito user creation per member per day, with the same refusal whether or not the member exists", async () => {
    const s = setup();
    await s.store.takeCreateUserSlot(ALICE);
    const again = await refusal(s.store.takeCreateUserSlot(ALICE));
    const stranger = await (async () => { await s.store.takeCreateUserSlot("9".repeat(64)); return refusal(s.store.takeCreateUserSlot("9".repeat(64))); })();
    expect(again).toMatchObject({ code: "TOO_MANY_REQUESTS", status: 429, message: RATE_LIMIT_MESSAGE });
    expect(stranger).toEqual(again);
    s.tick(86_400_000);
    await s.store.takeCreateUserSlot(ALICE);
  });

  it("has an expired-link text the sign-in and the page share", () => {
    expect(TICKET_EXPIRED_MESSAGE).toBe("This confirmation link has expired. Open the approval again from Rovara.");
    expect(APPROVAL_ID_PATTERN.test(APR_A)).toBe(true);
    expect(APPROVAL_ID_PATTERN.test("apr_../x")).toBe(false);
  });
});

describe("requireDecideSession", () => {
  it("refuses a bearer token with REAUTH_REQUIRED and a confirmUrl whose ticket was minted for that token's member", async () => {
    const s = setup();
    for (const path of [`/v1/app/approvals/${APR_A}/decide`, `/v1/app/spend-requests/${SPR_A}/decide`, `/v1/app/approve/${APR_A}`]) {
      const refused = await refusal(requireDecideSession(s.context, { ...get(path, { authorization: "Bearer alice" }), method: path.endsWith("decide") ? "POST" : "GET" }));
      expect(refused, path).toMatchObject({ code: "REAUTH_REQUIRED", status: 401 });
      const confirmUrl = String(refused?.details?.confirmUrl);
      const id = path.includes(SPR_A) ? SPR_A : APR_A;
      expect(confirmUrl).toMatch(new RegExp(`^${CELL}/v1/app/approve/${id}\\?ticket=[A-Za-z0-9_-]{43}$`));
      expect(refused?.message).toBe(`Decisions are made in your browser. Open ${confirmUrl}.`);
      const ticket = await s.store.redeemTicket(new URL(confirmUrl).searchParams.get("ticket")!);
      expect(ticket).toMatchObject({ orgId: ORG, developerId: ALICE, approvalId: id, mintedBy: "token" });
    }
    expect(s.kind.decided).toEqual([]);
  });

  it("mints no ticket for a token whose member may not decide now (403), for an approval of another org (404), or for a bad token", async () => {
    const s = setup();
    expect(await refusal(requireDecideSession(s.context, post(`/v1/app/approvals/${APR_A}/decide`, undefined, {}, { authorization: "Bearer bob" })))).toMatchObject({ code: "FORBIDDEN", message: "Only a project maintainer can decide this." });
    expect(await refusal(requireDecideSession(s.context, post(`/v1/app/approvals/${APR_A}/decide`, undefined, {}, { authorization: "Bearer stranger" })))).toMatchObject({ code: "NOT_FOUND" });
    expect(await refusal(requireDecideSession(s.context, post(`/v1/app/approvals/${APR_A}/decide`, undefined, {}, { authorization: "Bearer nope" })))).toMatchObject({ code: "AUTH_REQUIRED" });
    expect(s.db.find((item) => String(item.pk).startsWith("DECIDE_TICKET#"))).toEqual([]);
  });

  it("answers an id that is not an approval id with NOT_FOUND", async () => {
    const s = setup();
    expect(await refusal(requireDecideSession(s.context, get("/v1/app/approve/apr_..%2Fx")))).toMatchObject({ code: "NOT_FOUND" });
    expect(await refusal(requireDecideSession(s.context, get("/v1/app/approvals/nope/decide")))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("sends a request with no cookie, an unknown cookie, or a cookie opened for another approval to the identify step", async () => {
    const s = setup();
    const other = await sessionFor(s, APR_B);
    const signInUrl = `/v1/auth/decide/identify?return=/v1/app/approve/${APR_A}`;
    for (const headers of [{}, withCookie("not-a-session-value-".padEnd(40, "z")), withCookie(other)]) {
      expect(await refusal(requireDecideSession(s.context, get(`/v1/app/approve/${APR_A}`, headers)))).toMatchObject({ code: "REAUTH_REQUIRED", status: 401, details: { signInUrl } });
    }
  });

  it("accepts a session signed in 2 minutes ago and refuses one signed in 11 minutes ago, however the clock got there", async () => {
    const s = setup();
    const fresh = await sessionFor(s, APR_A, ALICE, 120);
    await expect(requireDecideSession(s.context, get(`/v1/app/approve/${APR_A}`, withCookie(fresh)))).resolves.toMatchObject({ orgId: ORG, developerId: ALICE, approvalId: APR_A });
    const old = await sessionFor(s, APR_A, ALICE, 660);
    expect(await refusal(requireDecideSession(s.context, get(`/v1/app/approve/${APR_A}`, withCookie(old))))).toMatchObject({ code: "REAUTH_REQUIRED", details: { signInUrl: `/v1/auth/decide/identify?return=/v1/app/approve/${APR_A}` } });
    // The same session ages out while the person reads the page.
    s.tick(481_000);
    expect(await refusal(requireDecideSession(s.context, get(`/v1/app/approve/${APR_A}`, withCookie(fresh))))).toMatchObject({ code: "REAUTH_REQUIRED" });
  });

  it("refuses a state-changing request with a missing or wrong csrf field, or an Origin that is not the cell's, with the exact FORBIDDEN, and leaves the session unused", async () => {
    const s = setup();
    const cookie = await sessionFor(s, APR_A);
    const csrf = csrfTokenFor(cookie);
    const words = "This request didn't come from Rovara's page.";
    const bad = [
      post(`/v1/app/approve/${APR_A}`, cookie, {}),
      post(`/v1/app/approve/${APR_A}`, cookie, { csrf: "wrong" }),
      post(`/v1/app/approve/${APR_A}`, cookie, { csrf: `${csrf}x` }),
      post(`/v1/app/approve/${APR_A}`, cookie, { csrf: csrf.slice(1) }),
      post(`/v1/app/approve/${APR_A}`, cookie, { csrf }, { origin: "https://evil.example" }),
      post(`/v1/app/approve/${APR_A}`, cookie, { csrf }, { origin: "null" }),
      post(`/v1/app/approve/${APR_A}`, cookie, { csrf }, { origin: `${CELL}.evil.example` }),
      { ...post(`/v1/app/approve/${APR_A}`, cookie, { csrf }), headers: { cookie: `${DECIDE_COOKIE}=${cookie}` } },
    ];
    for (const request of bad) expect(await refusal(requireDecideSession(s.context, request))).toMatchObject({ code: "FORBIDDEN", message: words });
    expect(s.db.get(`DECIDE_SESSION#${sha(cookie)}`, "META")?.usedAt).toBeUndefined();
    // The right csrf field and Origin pass, as a form field or as a JSON field.
    await expect(requireDecideSession(s.context, post(`/v1/app/approve/${APR_A}`, cookie, { csrf }))).resolves.toMatchObject({ developerId: ALICE });
  });

  it("lets one session decide once: after finish a second request or another approval is REAUTH_REQUIRED, and two at once decide once", async () => {
    const s = setup();
    const cookie = await sessionFor(s, APR_A);
    const csrf = csrfTokenFor(cookie);
    const request = post(`/v1/app/approve/${APR_A}`, cookie, { csrf });
    const results = await Promise.allSettled([requireDecideSession(s.context, request), requireDecideSession(s.context, request)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "REAUTH_REQUIRED" });
    const winner = (results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof requireDecideSession>>>).value;
    await winner.finish();
    expect(s.db.get(`DECIDE_SESSION#${sha(cookie)}`, "META")).toBeUndefined();
    expect(await refusal(requireDecideSession(s.context, request))).toMatchObject({ code: "REAUTH_REQUIRED" });
    // A session opened for apr_A can't decide apr_B.
    const second = await sessionFor(s, APR_A);
    expect(await refusal(requireDecideSession(s.context, post(`/v1/app/approve/${APR_B}`, second, { csrf: csrfTokenFor(second) })))).toMatchObject({ code: "REAUTH_REQUIRED" });
    expect(s.db.get(`DECIDE_SESSION#${sha(second)}`, "META")?.usedAt).toBeUndefined();
  });

  it("never stores or logs the cookie value", async () => {
    const s = setup();
    const cookie = await sessionFor(s, APR_A);
    await requireDecideSession(s.context, post(`/v1/app/approve/${APR_A}`, cookie, { csrf: csrfTokenFor(cookie) }));
    expect(JSON.stringify(s.db.find(() => true))).not.toContain(cookie);
    expect(s.db.get(`DECIDE_SESSION#${sha(cookie)}`, "META")).toMatchObject({ orgId: ORG, developerId: ALICE, approvalId: APR_A, method: "email_code" });
  });
});


// ---------------------------------------------------------------------------------------------------------------------------------
// The sign-in function's side: identify, start, and the callback that makes the session.
// ---------------------------------------------------------------------------------------------------------------------------------
type Harness = ReturnType<typeof identityHarness>;
const entities = (text: string) => text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&");
const copy = (response: { body: string }) => ({
  title: entities(/<h1>(.*?)<\/h1>/s.exec(response.body)?.[1] ?? ""),
  paragraphs: [...response.body.matchAll(/<p>(.*?)<\/p>/gs)].map((match) => entities(match[1]!)),
});
const request = (h: Harness, path: string, cookie?: string): Promise<HttpResult> => {
  const event: HttpApiV2Event = httpEvent("GET", path);
  return h.http(cookie === undefined ? event : { ...event, headers: { ...event.headers, cookie } });
};
const setCookie = (response: HttpResult, name: string) => (response.cookies ?? []).find((cookie) => cookie.startsWith(`${name}=`));
const cookieValueOf = (response: HttpResult, name: string) => setCookie(response, name)?.split(";")[0]?.slice(name.length + 1);
const nowSeconds = (h: Harness) => Math.floor(h.now() / 1000);
const decideItems = (h: Harness) => h.db.find((item) => /^DECIDE_(TICKET|STATE|SESSION)#/.test(String(item.pk)));

const gina = { sub: "gina-1", name: "Gina Park", email: "gina@x.dev", email_verified: true } satisfies FakeOidcUser;
const ginaCognito = { sub: "sub-of-gina@x.dev", name: "Gina Park", email: "gina@x.dev", email_verified: true, amr: ["otp"] } satisfies FakeOidcUser;
const hugo = { sub: "hugo-1", name: "Hugo Lim", email: "hugo@x.dev", email_verified: true } satisfies FakeOidcUser;
const GINA_ID = ownerKeyForSubject(OIDC_ISSUER, gina.sub);
const HUGO_ID = ownerKeyForSubject(OIDC_ISSUER, hugo.sub);
const GH_GINA = { id: 77, login: "gh-gina", name: "Gina Park", emails: [{ email: "gina@x.dev", primary: true, verified: true }] };
const GH_ID = ownerKeyForSubject("https://github.com", "77");

/** The sign-in function with the decide flow on, Gina and Hugo signed in once with their email code. */
async function flow(options: { oidcUsers?: FakeOidcUser[]; cognito?: FakeCognitoUser[]; github?: boolean; eligible?: string[]; orgId?: OrgId | undefined; notice?: Array<Record<string, unknown>> } = {}) {
  const kind = fakeKind(new Set(options.eligible ?? [GINA_ID, GH_ID]));
  kind.orgId = options.orgId;
  const sent: Array<Record<string, unknown>> = options.notice ?? [];
  const cognito = fakeCognito({ users: options.cognito ?? [{ email: "gina@x.dev", sub: ginaCognito.sub }] });
  const h = identityHarness({
    cloud: {}, singleOrg: false, oidcUsers: options.oidcUsers ?? [gina, hugo, ginaCognito],
    ...(options.github === true ? { github: { users: [GH_GINA] } } : {}),
    decide: { kinds: { apr: kind, spr: kind }, cognito },
    notice: { ses: { send: async (command: unknown) => { sent.push((command as { input: Record<string, unknown> }).input); return {}; } } as never, from: "Rovara <signin@rovara.dev>", cellUrl: "https://rovara.example" },
  });
  return { h, kind, sent, cognito };
}
const orgOf = async (h: Harness, developerId: string) => (await h.orgs.orgForDeveloper(developerId))!.orgId;

/** Starts the fresh sign-in with a ticket minted for `developerId`; returns the response, the PKCE cookie and the provider URL. */
async function startDecide(h: Harness, developerId: string, approvalId = APR_A, extraQuery = "") {
  const ticket = await h.decide.mintTicket({ orgId: await orgOf(h, developerId), developerId, approvalId, mintedBy: "token" });
  const response = await request(h, `/v1/auth/decide/start?ticket=${ticket}${extraQuery}`);
  const cookie = cookieValueOf(response, DECIDE_PKCE_COOKIE);
  return { response, ticket, pkce: cookie === undefined ? undefined : `${DECIDE_PKCE_COOKIE}=${cookie}`, providerUrl: response.headers.location };
}
/** Completes the email-code sign-in at the pool as `sub` and follows the callback. */
function finishDecide(h: Harness, started: { pkce: string | undefined; providerUrl: string | undefined }, sub: string, overrides: Parameters<Harness["oidc"]["approve"]>[2] = {}) {
  return request(h, h.oidc.approve(started.providerUrl!, sub, overrides), started.pkce);
}
async function signInOnce(h: Harness, method: "cloud" | "github", who: string) {
  const back = await h.signIn(method, who);
  expect(back.searchParams.get("code"), `sign-in as ${who}`).not.toBeNull();
}

describe("GET /v1/auth/decide/start (fresh sign-in, R67)", () => {
  it("sends the browser to the pool's email code only, for the ticket member's verified email, with a state record and the PKCE cookie", async () => {
    const { h } = await flow();
    await signInOnce(h, "cloud", gina.sub);
    const started = await startDecide(h, GINA_ID);
    expect(started.response.statusCode).toBe(302);
    const url = new URL(started.providerUrl!);
    expect(`${url.origin}${url.pathname}`).toBe(`${OIDC_ISSUER}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      identity_provider: "COGNITO", prompt: "login", max_age: "0", login_hint: "gina@x.dev", redirect_uri: `${ISSUER}/callback/cloud`, response_type: "code",
    });
    expect(url.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const state = url.searchParams.get("state")!;
    const record = h.db.get(`DECIDE_STATE#${sha(state)}`, "META");
    expect(record).toMatchObject({
      purpose: "decide", nonce: url.searchParams.get("nonce"), return: `/v1/app/approve/${APR_A}`, approvalId: APR_A, developerId: GINA_ID, identityProvider: "COGNITO", prompt: "login",
      startedAt: h.now(),
    });
    const cookie = setCookie(started.response, DECIDE_PKCE_COOKIE)!;
    expect(cookie).toMatch(/; Secure; HttpOnly; SameSite=Lax; Path=\/; Max-Age=600$/);
    expect(record?.codeVerifierHash).toBe(sha(cookieValueOf(started.response, DECIDE_PKCE_COOKIE)!));
    // The state's raw value and the verifier are never stored.
    expect(JSON.stringify(h.db.find(() => true))).not.toContain(state);
    expect(JSON.stringify(h.db.find(() => true))).not.toContain(cookieValueOf(started.response, DECIDE_PKCE_COOKIE)!);
    expect(h.cognito.calls).toEqual([]);
  });

  it("takes who and where only from the ticket: a member, an email, an id or a return in the URL change nothing", async () => {
    const { h } = await flow();
    await signInOnce(h, "cloud", gina.sub);
    await signInOnce(h, "cloud", hugo.sub);
    const started = await startDecide(h, GINA_ID, APR_A, `&return=https://evil.example&email=hugo@x.dev&developerId=${HUGO_ID}&login_hint=hugo@x.dev&member=${HUGO_ID}`);
    const url = new URL(started.providerUrl!);
    expect(url.searchParams.get("login_hint")).toBe("gina@x.dev");
    expect(h.db.get(`DECIDE_STATE#${sha(url.searchParams.get("state")!)}`, "META")).toMatchObject({ developerId: GINA_ID, return: `/v1/app/approve/${APR_A}` });
  });

  it("refuses an expired, reused, unknown or malformed ticket with the exact 400 and creates nothing", async () => {
    const { h } = await flow();
    await signInOnce(h, "cloud", gina.sub);
    const orgId = await orgOf(h, GINA_ID);
    const used = await h.decide.mintTicket({ orgId, developerId: GINA_ID, approvalId: APR_A, mintedBy: "token" });
    expect((await request(h, `/v1/auth/decide/start?ticket=${used}`)).statusCode).toBe(302);
    const old = await h.decide.mintTicket({ orgId, developerId: GINA_ID, approvalId: APR_B, mintedBy: "token" });
    h.tick(601_000);
    const before = h.db.find((item) => String(item.pk).startsWith("DECIDE_STATE#")).length;
    for (const ticket of [used, old, "A".repeat(43), "short", ""]) {
      const response = await request(h, `/v1/auth/decide/start?ticket=${ticket}`);
      expect(response.statusCode, ticket).toBe(400);
      expect(copy(response).paragraphs).toContain(EXPIRED);
      expect(response.headers.location).toBeUndefined();
    }
    expect((await request(h, "/v1/auth/decide/start")).statusCode).toBe(400);
    expect(h.db.find((item) => String(item.pk).startsWith("DECIDE_STATE#"))).toHaveLength(before);
    expect(h.cognito.calls).toEqual([]);
  });

  it("refuses a member with no verified email, or only a non-ASCII one, with the exact words, and creates nothing", async () => {
    const unverified: FakeOidcUser = { sub: "una-1", name: "Una", email: "una@x.dev", email_verified: false };
    const jorg: FakeOidcUser = { sub: "jorg-1", name: "Jörg", email: "jörg@x.dev", email_verified: true };
    const { h } = await flow({ oidcUsers: [unverified, jorg], eligible: [ownerKeyForSubject(OIDC_ISSUER, "una-1"), ownerKeyForSubject(OIDC_ISSUER, "jorg-1")] });
    await signInOnce(h, "cloud", "una-1");
    await signInOnce(h, "cloud", "jorg-1");
    for (const sub of ["una-1", "jorg-1"]) {
      const started = await startDecide(h, ownerKeyForSubject(OIDC_ISSUER, sub));
      expect(started.response.statusCode).toBe(403);
      expect(copy(started.response).paragraphs).toContain("Rovara needs a verified email to confirm decisions. Sign in once with your email code, or ask an admin.");
    }
    expect(h.db.find((item) => String(item.pk).startsWith("DECIDE_STATE#"))).toEqual([]);
    expect(h.cognito.calls).toEqual([]);
  });

  it("uses the most recently used verified email when a member has several", async () => {
    const { h } = await flow({ github: true, cognito: [] });
    await signInOnce(h, "cloud", gina.sub);
    // Gina's GitHub account has a verified address of its own, linked to her by the shared verified email? No: a different address stays its own member.
    h.tick(60_000);
    await signInOnce(h, "cloud", gina.sub);
    const started = await startDecide(h, GINA_ID);
    expect(new URL(started.providerUrl!).searchParams.get("login_hint")).toBe("gina@x.dev");
  });
});

describe("the callback that makes the session (R67, R6-4)", () => {
  const approveAs = async (options: { claims?: Partial<FakeOidcUser>; nonce?: string; flowOptions?: Parameters<typeof flow>[0]; ageSeconds?: number } = {}) => {
    const f = await flow(options.flowOptions);
    await signInOnce(f.h, "cloud", gina.sub);
    const started = await startDecide(f.h, GINA_ID);
    f.h.tick(5_000);
    const callback = await finishDecide(f.h, started, ginaCognito.sub, {
      claims: { auth_time: nowSeconds(f.h) - (options.ageSeconds ?? 0), ...(options.claims ?? {}) }, ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
    });
    return { ...f, started, callback };
  };
  const refusedWith = (callback: HttpResult) => ({ status: callback.statusCode, noSession: cookieValueOf(callback, DECIDE_COOKIE) === undefined, noRedirect: callback.headers.location === undefined });

  it("accepts a fresh email-code sign-in: stores the session, sets the cookie, and redirects to the approval from the state", async () => {
    const { h, callback, started } = await approveAs();
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(`/v1/app/approve/${APR_A}`);
    const cookie = setCookie(callback, DECIDE_COOKIE)!;
    expect(cookie).toMatch(/^__Host-rovara_decide=[A-Za-z0-9_-]{43}; Secure; HttpOnly; SameSite=Strict; Path=\/; Max-Age=600$/);
    const value = cookieValueOf(callback, DECIDE_COOKIE)!;
    const orgId = await orgOf(h, GINA_ID);
    const session = h.db.get(`DECIDE_SESSION#${sha(value)}`, "META");
    expect(session).toMatchObject({ orgId, developerId: GINA_ID, approvalId: APR_A, method: "email_code", csrfHash: sha(csrfTokenFor(value)) });
    expect(session?.expiresAt).toBe((session?.signedInAt as number) + 600);
    expect(session?.signedInAt).toBe(nowSeconds(h));
    expect(session?.usedAt).toBeUndefined();
    // The PKCE cookie is cleared, the state is spent, and nothing holds the cookie value.
    expect(setCookie(callback, DECIDE_PKCE_COOKIE)).toMatch(/Max-Age=0/);
    expect(h.db.find((item) => String(item.pk).startsWith("DECIDE_STATE#"))).toEqual([]);
    expect(JSON.stringify([...h.db.find(() => true), ...h.logs])).not.toContain(value);
    expect(started.response.statusCode).toBe(302);
    // It is a real session: the page's guard accepts it.
    const context: DecideRequestContext = { store: h.decide, now: h.now, cellOrigin: API, kinds: {} };
    await expect(requireDecideSession(context, get(`/v1/app/approve/${APR_A}`, withCookie(value)))).resolves.toMatchObject({ developerId: GINA_ID, approvalId: APR_A });
  });

  it("refuses an ID token whose auth_time is 20 minutes old", async () => {
    const { h, callback } = await approveAs({ ageSeconds: 1200 });
    expect(refusedWith(callback)).toEqual({ status: 403, noSession: true, noRedirect: true });
    expect(h.db.find((item) => String(item.pk).startsWith("DECIDE_SESSION#"))).toEqual([]);
  });

  it("refuses an auth_time of 5 minutes ago that is before the flow started (a session that existed before the flow)", async () => {
    const f = await flow();
    await signInOnce(f.h, "cloud", gina.sub);
    f.h.tick(400_000);
    const started = await startDecide(f.h, GINA_ID);
    const callback = await finishDecide(f.h, started, ginaCognito.sub, { claims: { auth_time: nowSeconds(f.h) - 300 } });
    expect(refusedWith(callback)).toEqual({ status: 403, noSession: true, noRedirect: true });
  });

  it("refuses a token with no auth_time, and one whose nonce differs from the stored one", async () => {
    const noTime = await approveAs({ claims: { auth_time: undefined as never } });
    expect(refusedWith(noTime.callback).status).toBe(403);
    const wrongNonce = await approveAs({ nonce: "n".repeat(43) });
    expect(refusedWith(wrongNonce.callback)).toEqual({ status: 403, noSession: true, noRedirect: true });
    expect(wrongNonce.h.db.find((item) => String(item.pk).startsWith("DECIDE_SESSION#"))).toEqual([]);
  });

  it("refuses an ID token whose amr does not show the email code", async () => {
    const { callback } = await approveAs({ claims: { amr: ["pwd"] } });
    expect(refusedWith(callback)).toEqual({ status: 403, noSession: true, noRedirect: true });
  });

  it("accepts a token with no amr when the flow itself asked for a fresh native sign-in (R6-4), and the state is single use", async () => {
    const f = await flow({ oidcUsers: [gina, hugo, { ...ginaCognito, amr: undefined as never }] });
    await signInOnce(f.h, "cloud", gina.sub);
    const started = await startDecide(f.h, GINA_ID);
    const url = f.h.oidc.approve(started.providerUrl!, ginaCognito.sub, { claims: { auth_time: nowSeconds(f.h) } });
    const first = await request(f.h, url, started.pkce);
    expect(first.statusCode).toBe(302);
    expect(cookieValueOf(first, DECIDE_COOKIE)).toBeDefined();
    const again = await request(f.h, url, started.pkce);
    expect(again.statusCode).toBe(400);
    expect(cookieValueOf(again, DECIDE_COOKIE)).toBeUndefined();
  });

  it("does not treat a normal cloud sign-in as a decide flow: no state record, no session", async () => {
    const { h } = await flow({ oidcUsers: [gina, ginaCognito] });
    await signInOnce(h, "cloud", ginaCognito.sub);
    expect(decideItems(h)).toEqual([]);
  });

  it("never accepts GitHub: a GitHub callback bearing the decide state is refused and leaves the state unspent", async () => {
    const { h } = await flow({ github: true });
    await signInOnce(h, "cloud", gina.sub);
    const started = await startDecide(h, GINA_ID);
    const state = new URL(started.providerUrl!).searchParams.get("state")!;
    const silent = await request(h, `/v1/auth/callback/github?code=x&state=${state}`, started.pkce);
    expect(silent.statusCode).toBe(400);
    expect(cookieValueOf(silent, DECIDE_COOKIE)).toBeUndefined();
    expect(h.db.get(`DECIDE_STATE#${sha(state)}`, "META")).toBeDefined();
    expect(h.db.find((item) => String(item.pk).startsWith("DECIDE_SESSION#"))).toEqual([]);
  });

  it("refuses a callback from another browser (no PKCE cookie, or a different one) and creates no session", async () => {
    const { h } = await flow();
    await signInOnce(h, "cloud", gina.sub);
    const started = await startDecide(h, GINA_ID);
    const callback = await finishDecide(h, { ...started, pkce: `${DECIDE_PKCE_COOKIE}=${"v".repeat(43)}` }, ginaCognito.sub, { claims: { auth_time: nowSeconds(h) } });
    expect(refusedWith(callback).noSession).toBe(true);
    expect(callback.statusCode).toBe(400);
    expect(h.db.find((item) => String(item.pk).startsWith("DECIDE_SESSION#"))).toEqual([]);
  });

  it("refuses a sign-in as a different account: a ticket for Gina redeemed while Hugo signs in creates nothing for Hugo", async () => {
    const hugoCognito = { sub: "sub-of-hugo@x.dev", name: "Hugo", email: "hugo@x.dev", email_verified: true, amr: ["otp"] };
    const f = await flow({ oidcUsers: [gina, hugo, ginaCognito, hugoCognito], cognito: [{ email: "gina@x.dev", sub: ginaCognito.sub }, { email: "hugo@x.dev", sub: hugoCognito.sub }] });
    await signInOnce(f.h, "cloud", gina.sub);
    await signInOnce(f.h, "cloud", hugo.sub);
    await signInOnce(f.h, "cloud", hugoCognito.sub);
    const before = JSON.stringify(f.h.db.find((item) => !String(item.pk).startsWith("DECIDE_")));
    const started = await startDecide(f.h, GINA_ID);
    const callback = await finishDecide(f.h, started, hugoCognito.sub, { claims: { auth_time: nowSeconds(f.h) } });
    expect(callback.statusCode).toBe(403);
    expect(copy(callback).paragraphs).toContain("You confirmed as a different account. Open the approval again.");
    expect(refusedWith(callback).noSession).toBe(true);
    expect(JSON.stringify(f.h.db.find((item) => !String(item.pk).startsWith("DECIDE_")))).toBe(before);
  });

  it("reads the return only from the state record: a return on the callback query is ignored", async () => {
    const f = await flow();
    await signInOnce(f.h, "cloud", gina.sub);
    const started = await startDecide(f.h, GINA_ID);
    const callback = await request(f.h, `${f.h.oidc.approve(started.providerUrl!, ginaCognito.sub, { claims: { auth_time: nowSeconds(f.h) } })}&return=https://evil.example&approvalId=${APR_B}&developerId=${HUGO_ID}`, started.pkce);
    expect(callback.headers.location).toBe(`/v1/app/approve/${APR_A}`);
    const session = f.h.db.find((item) => String(item.pk).startsWith("DECIDE_SESSION#"))[0];
    expect(session).toMatchObject({ approvalId: APR_A, developerId: GINA_ID });
  });

  it("ignores and replaces a decide cookie the browser already has: the new value differs, and the old one is no session", async () => {
    const f = await flow();
    await signInOnce(f.h, "cloud", gina.sub);
    const planted = "p".repeat(43);
    const started = await startDecide(f.h, GINA_ID);
    const callback = await request(f.h, f.h.oidc.approve(started.providerUrl!, ginaCognito.sub, { claims: { auth_time: nowSeconds(f.h) } }), `${started.pkce}; ${DECIDE_COOKIE}=${planted}`);
    const value = cookieValueOf(callback, DECIDE_COOKIE)!;
    expect(value).toBeDefined();
    expect(value).not.toBe(planted);
    const context: DecideRequestContext = { store: f.h.decide, now: f.h.now, cellOrigin: API, kinds: {} };
    expect(await refusal(requireDecideSession(context, get(`/v1/app/approve/${APR_A}`, withCookie(planted))))).toMatchObject({ code: "REAUTH_REQUIRED" });
    await expect(requireDecideSession(context, get(`/v1/app/approve/${APR_A}`, withCookie(value)))).resolves.toBeDefined();
  });
});

describe("a member with no Cognito identity (R6-2, R7-2)", () => {
  it("creates the pool user once (verified, no message), links it to the member with one notice, and the email-code sign-in then resolves to the same member", async () => {
    const notices: Array<Record<string, unknown>> = [];
    const f = await flow({ github: true, cognito: [], notice: notices, oidcUsers: [ginaCognito] });
    await signInOnce(f.h, "github", "77");
    const before = f.h.db.find((item) => String(item.pk).startsWith("SIGNIN_IDENTITY#")).length;
    const started = await startDecide(f.h, GH_ID);
    expect(started.response.statusCode).toBe(302);
    const creates = f.cognito.calls.filter((call) => call.name === "AdminCreateUserCommand");
    expect(creates).toHaveLength(1);
    expect(creates[0]!.input).toEqual({
      UserPoolId: "us-east-1_TESTPOOL", Username: "gina@x.dev", UserAttributes: [{ Name: "email", Value: "gina@x.dev" }, { Name: "email_verified", Value: "true" }], MessageAction: "SUPPRESS",
    });
    expect(f.h.db.find((item) => String(item.pk).startsWith("SIGNIN_IDENTITY#"))).toHaveLength(before + 1);
    expect(f.h.db.get(`SIGNIN_IDENTITY#${ownerKeyForSubject(OIDC_ISSUER, ginaCognito.sub)}`, "META")).toMatchObject({ developerId: GH_ID, provider: "cloud" });
    expect(notices).toHaveLength(1);
    expect(JSON.stringify(notices[0])).toContain(DECIDE_NOTICE_SENTENCE);
    expect(JSON.stringify(notices[0])).toContain("gina@x.dev");
    expect(DECIDE_NOTICE_SENTENCE).toBe("Rovara added an email-code sign-in to your account, used to confirm decisions.");
    // The code goes to the member's verified email, and the sign-in completes as the same developer.
    expect(new URL(started.providerUrl!).searchParams.get("login_hint")).toBe("gina@x.dev");
    const callback = await finishDecide(f.h, started, ginaCognito.sub, { claims: { auth_time: nowSeconds(f.h) } });
    expect(callback.statusCode).toBe(302);
    const session = f.h.db.find((item) => String(item.pk).startsWith("DECIDE_SESSION#"))[0];
    expect(session).toMatchObject({ developerId: GH_ID, approvalId: APR_A });
    // A second decision creates no user, no link and no notice.
    const second = await startDecide(f.h, GH_ID, APR_B);
    expect(second.response.statusCode).toBe(302);
    expect(f.cognito.calls.filter((call) => call.name === "AdminCreateUserCommand")).toHaveLength(1);
    expect(f.h.db.find((item) => String(item.pk).startsWith("SIGNIN_IDENTITY#"))).toHaveLength(before + 1);
    expect(notices).toHaveLength(1);
  });

  it("reads an existing pool user for that email and links it once when it is verified, matches, and belongs to no one else", async () => {
    const f = await flow({ github: true, cognito: [{ email: "gina@x.dev", sub: "orphan-sub" }], oidcUsers: [ginaCognito] });
    await signInOnce(f.h, "github", "77");
    const started = await startDecide(f.h, GH_ID);
    expect(started.response.statusCode).toBe(302);
    expect(f.cognito.calls.map((call) => call.name)).toEqual(["AdminCreateUserCommand", "AdminGetUserCommand"]);
    expect(f.h.db.get(`SIGNIN_IDENTITY#${ownerKeyForSubject(OIDC_ISSUER, "orphan-sub")}`, "META")).toMatchObject({ developerId: GH_ID });
    const again = await startDecide(f.h, GH_ID, APR_B);
    expect(again.response.statusCode).toBe(302);
    expect(f.cognito.calls.filter((call) => call.name === "AdminGetUserCommand")).toHaveLength(1);
  });

  it.each([
    ["is not verified", { email: "gina@x.dev", sub: "u-1", emailVerified: false }],
    ["has another email", { email: "gina@x.dev", sub: "u-1", mismatch: true }],
  ] as const)("refuses, with the one copy and no link, an existing pool user that %s", async (_name, user) => {
    const f = await flow({ github: true, cognito: [{ email: "gina@x.dev", sub: user.sub, ...("emailVerified" in user ? { emailVerified: user.emailVerified } : {}) }] });
    if ("mismatch" in user) {
      // The pool's record for that address names a different address.
      const stored = f.cognito.users.get("gina@x.dev")!;
      f.cognito.users.set("gina@x.dev", { ...stored, email: "someone-else@x.dev" });
    }
    await signInOnce(f.h, "github", "77");
    const links = f.h.db.find((item) => String(item.pk).startsWith("SIGNIN_IDENTITY#")).length;
    const started = await startDecide(f.h, GH_ID);
    expect(started.response.statusCode).toBe(403);
    expect(copy(started.response).paragraphs).toContain("Rovara couldn't set up email confirmation for your account. Ask an admin for help.");
    expect(f.h.db.find((item) => String(item.pk).startsWith("SIGNIN_IDENTITY#"))).toHaveLength(links);
    expect(f.h.db.find((item) => String(item.pk).startsWith("DECIDE_STATE#"))).toEqual([]);
  });

  it("refuses an existing pool user whose sub is linked to another developer, or has a developer record of its own", async () => {
    // Hugo already signed in with the pool user Gina's address names; and a second pool user has its own developer record.
    for (const [owner, sub] of [["linked", ginaCognito.sub], ["recorded", "recorded-sub"]] as const) {
      const f = await flow({ github: true, cognito: [{ email: "gina@x.dev", sub }], oidcUsers: [gina, hugo, ginaCognito, { sub: "recorded-sub", name: "Rec", email: "rec@x.dev", email_verified: true }] });
      await signInOnce(f.h, "github", "77");
      if (owner === "linked") await f.h.db.set({ pk: `SIGNIN_IDENTITY#${ownerKeyForSubject(OIDC_ISSUER, sub)}`, sk: "META", developerId: HUGO_ID, provider: "cloud", issuer: OIDC_ISSUER, subject: sub, linkedAt: "2026-09-01T00:00:00.000Z", lastSignInAt: "2026-09-01T00:00:00.000Z" });
      else await f.h.db.set({ pk: `DEVELOPER#${ownerKeyForSubject(OIDC_ISSUER, sub)}`, sk: "META", developerId: ownerKeyForSubject(OIDC_ISSUER, sub), provider: "cloud", issuer: OIDC_ISSUER, subject: sub, displayName: "Rec", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
      const started = await startDecide(f.h, GH_ID);
      expect(started.response.statusCode, owner).toBe(403);
      expect(copy(started.response).paragraphs).toContain("Rovara couldn't set up email confirmation for your account. Ask an admin for help.");
      expect(f.h.db.get(`DEVELOPER#${GH_ID}`, `IDENTITY#${ownerKeyForSubject(OIDC_ISSUER, sub)}`)).toBeUndefined();
    }
  });

  it("answers the second creation in a day with 429 and the one text, and calls Cognito no more", async () => {
    const f = await flow({ github: true, cognito: [], oidcUsers: [ginaCognito], });
    await signInOnce(f.h, "github", "77");
    await f.h.decide.takeCreateUserSlot(GH_ID);
    const started = await startDecide(f.h, GH_ID);
    expect(started.response.statusCode).toBe(429);
    expect(copy(started.response).paragraphs).toContain("Too many confirmation attempts. Try again later.");
    expect(f.cognito.calls).toEqual([]);
  });
});
