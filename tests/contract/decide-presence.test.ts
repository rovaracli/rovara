// Plan 3, Task 21a-presence (PF31h, R66, R67): decisions need a person present. This file tests the presence machinery: decide tickets
// and their limits, the one-decision session, requireDecideSession, the sign-in flow that makes the session, and the confirmation page.
// The decide routes themselves (decideApproval, decideSpendRequest, the approval kinds) belong to 21a-wiring; a fake `DecideKind` stands
// in for them here.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrgId } from "@rovara-code/contracts";
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
import type { ConfirmView, DecideInspection, DecideKind, DecideKinds, DecideTarget } from "../../packages/broker/src/developer/decide-kinds.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import type { HttpApiV2Event } from "../../packages/broker/src/aws/lambda.js";
import type { HttpResult } from "../../packages/broker/src/developer/server.js";
import { isDecidePagePath, routeDecidePage } from "../../packages/broker/src/aws/decide-web.js";
import { DECIDE_PKCE_COOKIE, TICKET_EXPIRED_MESSAGE as EXPIRED } from "../../packages/broker/src/developer/decide-session.js";
import { isFreshInteractiveSignIn } from "../../packages/broker/src/developer/decide-signin.js";
import { DECIDE_NOTICE_SENTENCE } from "../../packages/broker/src/developer/identity-notice.js";
import { createAdminBroker } from "../support/admin-broker.js";
import { developerTokenVerifier } from "../../packages/broker/src/developer/verify-token.js";
import type { DeveloperApiConfiguration } from "../../packages/broker/src/aws/developer-routes.js";
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
function fakeKind(eligible: Set<string>, decided: Array<{ target: DecideTarget; decision: string }> = []): DecideKind & { decided: typeof decided; view: ConfirmView; eligible: Set<string>; orgId: OrgId | undefined; closed: { by: string; at: string } | undefined } {
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

  it("redeems a ticket once even when two requests race for it", async () => {
    const s = setup();
    const value = await s.store.mintTicket({ orgId: ORG, developerId: ALICE, approvalId: APR_A, mintedBy: "token" });
    const results = await Promise.all([s.store.redeemTicket(value), s.store.redeemTicket(value), s.store.redeemTicket(value)]);
    expect(results.filter((result) => result !== undefined)).toHaveLength(1);
  });

  it("claims a session only for the approval it was opened for, and only once", async () => {
    const s = setup();
    const cookie = await sessionFor(s, APR_A);
    expect(await s.store.claimSession(cookie, APR_B)).toBe(false);
    expect(await s.store.claimSession(cookie, APR_A)).toBe(true);
    expect(await s.store.claimSession(cookie, APR_A)).toBe(false);
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
/** Where the callback sends the browser next: a redirect's Location, or the target of the page's meta refresh. */
const landingOf = (response: HttpResult) => response.headers.location ?? /http-equiv="refresh" content="0;url=([^"]*)"/.exec(response.body)?.[1]?.replaceAll("&amp;", "&");
const decideItems = (h: Harness) => h.db.find((item) => /^DECIDE_(TICKET|STATE|SESSION)#/.test(String(item.pk)));

const gina = { sub: "gina-1", name: "Gina Park", email: "gina@x.dev", email_verified: true } satisfies FakeOidcUser;
const ginaCognito = { sub: "sub-of-gina@x.dev", name: "Gina Park", email: "gina@x.dev", email_verified: true, amr: ["otp"] } satisfies FakeOidcUser;
const hugo = { sub: "hugo-1", name: "Hugo Lim", email: "hugo@x.dev", email_verified: true } satisfies FakeOidcUser;
const GINA_ID = ownerKeyForSubject(OIDC_ISSUER, gina.sub);
const HUGO_ID = ownerKeyForSubject(OIDC_ISSUER, hugo.sub);
const GH_GINA = { id: 77, login: "gh-gina", name: "Gina Park", emails: [{ email: "gina@x.dev", primary: true, verified: true }] };
const GH_ID = ownerKeyForSubject("https://github.com", "77");

/** The sign-in function with the decide flow on, Gina and Hugo signed in once with their email code. */
async function flow(options: { oidcUsers?: FakeOidcUser[]; cognito?: FakeCognitoUser[]; github?: boolean; eligible?: string[]; orgId?: OrgId | undefined; notice?: Array<Record<string, unknown>>; kinds?: DecideKinds } = {}) {
  const kind = fakeKind(new Set(options.eligible ?? [GINA_ID, GH_ID]));
  kind.orgId = options.orgId;
  const sent: Array<Record<string, unknown>> = options.notice ?? [];
  const cognito = fakeCognito({ users: options.cognito ?? [{ email: "gina@x.dev", sub: ginaCognito.sub }] });
  const h = identityHarness({
    cloud: {}, singleOrg: false, oidcUsers: options.oidcUsers ?? [gina, hugo, ginaCognito],
    ...(options.github === true ? { github: { users: [GH_GINA] } } : {}),
    decide: { kinds: options.kinds ?? { apr: kind, spr: kind }, cognito },
    notice: { ses: { send: async (command: unknown) => { sent.push((command as { input: Record<string, unknown> }).input); return {}; } }, from: "Rovara <signin@rovara.dev>", cellUrl: "https://rovara.example" },
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
    // The member's own pool user is read (and, here, already linked): nothing is created.
    expect(h.cognito.calls.filter((call) => call.name !== "AdminGetUserCommand")).toEqual([]);
    // The state binds the callback to that user's sub (Important 1).
    expect(record?.expectedSub).toBe(ginaCognito.sub);
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
    expect(h.cognito.calls.filter((call) => call.name === "AdminCreateUserCommand")).toEqual([]);
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
    // A same-origin page, not a redirect: the next request is a new same-site navigation, which carries the Strict cookie (Important 3).
    expect(callback.statusCode).toBe(200);
    expect(landingOf(callback)).toBe(`/v1/app/approve/${APR_A}`);
    expect(callback.headers.location).toBeUndefined();
    expect(callback.body).toContain(`<a class="method" href="/v1/app/approve/${APR_A}">`);
    expect(callback.headers["cache-control"]).toBe("no-store");
    expect(callback.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
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
    expect(first.statusCode).toBe(200);
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
    const started = await startDecide(f.h, GINA_ID);
    const before = JSON.stringify(f.h.db.find((item) => !String(item.pk).startsWith("DECIDE_")));
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
    expect(landingOf(callback)).toBe(`/v1/app/approve/${APR_A}`);
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
    expect(callback.statusCode).toBe(200);
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
    // The pool user for that email is found by AdminGetUser first; nothing is created, so no account-creation slot is taken either.
    expect(f.cognito.calls.map((call) => call.name)).toEqual(["AdminGetUserCommand"]);
    await f.h.decide.takeCreateUserSlot(GH_ID);
    expect(f.h.db.get(`SIGNIN_IDENTITY#${ownerKeyForSubject(OIDC_ISSUER, "orphan-sub")}`, "META")).toMatchObject({ developerId: GH_ID });
    const again = await startDecide(f.h, GH_ID, APR_B);
    expect(again.response.statusCode).toBe(302);
    expect(f.cognito.calls.filter((call) => call.name === "AdminCreateUserCommand")).toHaveLength(0);
    expect(f.h.db.find((item) => String(item.pk).startsWith("SIGNIN_IDENTITY#") && item.developerId === GH_ID)).toHaveLength(2);
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
      if (owner === "linked") f.h.db.set({ pk: `SIGNIN_IDENTITY#${ownerKeyForSubject(OIDC_ISSUER, sub)}`, sk: "META", developerId: HUGO_ID, provider: "cloud", issuer: OIDC_ISSUER, subject: sub, linkedAt: "2026-09-01T00:00:00.000Z", lastSignInAt: "2026-09-01T00:00:00.000Z" });
      else f.h.db.set({ pk: `DEVELOPER#${ownerKeyForSubject(OIDC_ISSUER, sub)}`, sk: "META", developerId: ownerKeyForSubject(OIDC_ISSUER, sub), provider: "cloud", issuer: OIDC_ISSUER, subject: sub, displayName: "Rec", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
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
    expect(f.cognito.calls.map((call) => call.name)).toEqual(["AdminGetUserCommand"]);
  });
});

describe("GET /v1/auth/decide/identify (R7-1): a link with no ticket names the member with a normal sign-in", () => {
  const authRequests = (h: Harness) => h.db.find((item) => item.purpose === "decide_identify");
  /** Opens the identify link for `approvalId`, follows the method page to `method`, and returns the provider URL and the PKCE cookie. */
  async function identifyAt(h: Harness, method: "cloud" | "github", approvalId = APR_A) {
    let response = await request(h, `/v1/auth/decide/identify?return=${encodeURIComponent(`/v1/app/approve/${approvalId}`)}`);
    const pkce = cookieValueOf(response, DECIDE_PKCE_COOKIE);
    if (response.statusCode === 200) {
      const link = new RegExp(`href="([^"]*method=${method})"`).exec(response.body)?.[1];
      if (link === undefined) throw new Error("test setup: no method link");
      response = await request(h, link.replaceAll("&amp;", "&"), `${DECIDE_PKCE_COOKIE}=${pkce}`);
    }
    return { response, pkce: pkce === undefined ? undefined : `${DECIDE_PKCE_COOKIE}=${pkce}`, providerUrl: response.headers.location };
  }

  it.each([
    ["an absolute URL", "https://evil.example"],
    ["a protocol-relative path", "//evil.example"],
    ["an encoded slash in the id", "/v1/app/approve/%2F%2Fevil"],
    ["a dot-dot", "/v1/app/approve/../x"],
    ["a dot-dot after a real id", `/v1/app/approve/${APR_A}/../x`],
    ["a backslash", `/v1/app/approve\\${APR_A}`],
    ["another path", "/v1/app/approvals"],
    ["a suffix", `/v1/app/approve/${APR_A}/extra`],
    ["a double-encoded path", `%252Fv1%252Fapp%252Fapprove%252F${APR_A}`],
    ["nothing", ""],
  ])("refuses %s with 400 and starts nothing", async (_name, value) => {
    const { h } = await flow();
    const response = await request(h, `/v1/auth/decide/identify?return=${value === "" ? "" : value.startsWith("%25") ? value : encodeURIComponent(value)}`);
    expect(response.statusCode).toBe(400);
    expect(response.headers.location).toBeUndefined();
    expect(response.cookies).toBeUndefined();
    expect(authRequests(h)).toEqual([]);
    const raw = await request(h, `/v1/auth/decide/identify?return=${value}`);
    expect(raw.statusCode).toBe(400);
    expect(raw.headers.location).toBeUndefined();
    expect(authRequests(h)).toEqual([]);
  });

  it("opens no Cognito user, link or notice, and mints no ticket, until the person has signed in and may decide", async () => {
    const { h, cognito, sent } = await flow({ github: true, cognito: [] });
    await signInOnce(h, "github", "77");
    const links = h.db.find((item) => String(item.pk).startsWith("SIGNIN_IDENTITY#")).length;
    const opened = await identifyAt(h, "github");
    expect(opened.response.statusCode).toBe(302);
    expect(new URL(opened.providerUrl!).origin).toBe("https://github.com");
    expect(cognito.calls).toEqual([]);
    expect(sent).toEqual([]);
    expect(h.db.find((item) => String(item.pk).startsWith("DECIDE_"))).toEqual([]);
    expect(h.db.find((item) => String(item.pk).startsWith("SIGNIN_IDENTITY#"))).toHaveLength(links);
    expect(opened.pkce).toMatch(/^__Host-rovara_decide_pkce=[A-Za-z0-9_-]{43}$/);
  });

  it("GitHub-only approver from Slack: identifies with GitHub (never fresh), gets a ticket for themselves, then the email code, and has a session", async () => {
    const { h, cognito, sent } = await flow({ github: true, cognito: [], oidcUsers: [ginaCognito] });
    await signInOnce(h, "github", "77");
    const opened = await identifyAt(h, "github");
    const callback = await request(h, h.github.approve(opened.providerUrl!, 77), opened.pkce);
    expect(callback.statusCode).toBe(302);
    const location = callback.headers.location!;
    expect(location).toMatch(/^\/v1\/auth\/decide\/start\?ticket=[A-Za-z0-9_-]{43}$/);
    // The identify sign-in is not fresh: no session exists yet, and the ticket names the GitHub member.
    expect(h.db.find((item) => String(item.pk).startsWith("DECIDE_SESSION#"))).toEqual([]);
    expect(h.db.find((item) => String(item.pk).startsWith("DECIDE_TICKET#"))[0]).toMatchObject({ developerId: GH_ID, approvalId: APR_A, mintedBy: "identified_session" });
    expect(cognito.calls).toEqual([]);
    const start = await request(h, location);
    expect(start.statusCode).toBe(302);
    expect(new URL(start.headers.location!).searchParams.get("login_hint")).toBe("gina@x.dev");
    expect(cognito.calls.filter((call) => call.name === "AdminCreateUserCommand")).toHaveLength(1);
    expect(sent).toHaveLength(1);
    const pkce = `${DECIDE_PKCE_COOKIE}=${cookieValueOf(start, DECIDE_PKCE_COOKIE)}`;
    const done = await request(h, h.oidc.approve(start.headers.location!, ginaCognito.sub, { claims: { auth_time: nowSeconds(h) } }), pkce);
    expect(landingOf(done)).toBe(`/v1/app/approve/${APR_A}`);
    const value = cookieValueOf(done, DECIDE_COOKIE)!;
    const context: DecideRequestContext = { store: h.decide, now: h.now, cellOrigin: API, kinds: {} };
    await expect(requireDecideSession(context, post(`/v1/app/approve/${APR_A}`, value, { csrf: csrfTokenFor(value) }, { origin: API }))).resolves.toMatchObject({ developerId: GH_ID, approvalId: APR_A });
  });

  it("lets a maintainer added after the approval was asked decide it, and refuses one removed since, minting no ticket (R68, identify path)", async () => {
    // Eligibility is the kind's live answer: the stored candidates are never consulted.
    const { h, kind } = await flow({ eligible: [] });
    await signInOnce(h, "cloud", gina.sub);
    const noTicket = async () => {
      const opened = await identifyAt(h, "cloud");
      return request(h, h.oidc.approve(opened.providerUrl!, gina.sub), opened.pkce);
    };
    const refused = await noTicket();
    expect(refused.statusCode).toBe(403);
    expect(copy(refused).paragraphs).toContain("Only a project maintainer can decide this.");
    expect(h.db.find((item) => String(item.pk).startsWith("DECIDE_TICKET#"))).toEqual([]);
    kind.eligible.add(GINA_ID);
    const allowed = await noTicket();
    expect(allowed.statusCode).toBe(302);
    expect(h.db.find((item) => String(item.pk).startsWith("DECIDE_TICKET#"))).toHaveLength(1);
    kind.eligible.delete(GINA_ID);
    const removed = await noTicket();
    expect(removed.statusCode).toBe(403);
    expect(h.db.find((item) => String(item.pk).startsWith("DECIDE_TICKET#"))).toHaveLength(1);
  });

  it("says who decided an approval that is already decided, and finds nothing for another org's approval", async () => {
    const { h, kind } = await flow();
    await signInOnce(h, "cloud", gina.sub);
    kind.closed = { by: "Hugo Lim", at: "2026-10-21T11:00:00.000Z" };
    const decided = await (async () => { const opened = await identifyAt(h, "cloud"); return request(h, h.oidc.approve(opened.providerUrl!, gina.sub), opened.pkce); })();
    expect(copy(decided).paragraphs).toContain("This was already decided by Hugo Lim at 2026-10-21T11:00:00.000Z.");
    kind.closed = undefined;
    kind.orgId = OTHER_ORG;
    const other = await (async () => { const opened = await identifyAt(h, "cloud"); return request(h, h.oidc.approve(opened.providerUrl!, gina.sub), opened.pkce); })();
    expect(other.statusCode).toBe(404);
    expect(h.db.find((item) => String(item.pk).startsWith("DECIDE_TICKET#"))).toEqual([]);
  });

  it("refuses an identify callback from another browser, a stranger with no account, and an eleventh ticket in an hour", async () => {
    const { h } = await flow();
    await signInOnce(h, "cloud", gina.sub);
    const opened = await identifyAt(h, "cloud");
    const elsewhere = await request(h, h.oidc.approve(opened.providerUrl!, gina.sub), `${DECIDE_PKCE_COOKIE}=${"v".repeat(43)}`);
    expect(elsewhere.statusCode).toBe(400);
    const stranger = { sub: "nobody-1", name: "Nobody", email: "nobody@elsewhere.dev", email_verified: true };
    const strangerH = (await flow({ oidcUsers: [gina, stranger] })).h;
    await signInOnce(strangerH, "cloud", gina.sub);
    const open2 = await identifyAt(strangerH, "cloud");
    const links = strangerH.db.find((item) => String(item.pk).startsWith("SIGNIN_IDENTITY#")).length;
    const refused = await request(strangerH, strangerH.oidc.approve(open2.providerUrl!, stranger.sub), open2.pkce);
    expect(refused.statusCode).toBe(403);
    expect(strangerH.db.find((item) => String(item.pk).startsWith("SIGNIN_IDENTITY#"))).toHaveLength(links);
    // The eleventh ticket for one member within an hour.
    const orgId = await orgOf(h, GINA_ID);
    for (let index = 0; index < 10; index += 1) await h.decide.mintTicket({ orgId, developerId: GINA_ID, approvalId: `apr_${String(index).padStart(20, "a")}`, mintedBy: "token" });
    const limited = await (async () => { const o = await identifyAt(h, "cloud"); return request(h, h.oidc.approve(o.providerUrl!, gina.sub), o.pkce); })();
    expect(limited.statusCode).toBe(429);
    expect(copy(limited).paragraphs).toContain("Too many confirmation attempts. Try again later.");
  });
});


// ---------------------------------------------------------------------------------------------------------------------------------
// The confirmation page: GET and POST /v1/app/approve/{id}.
// ---------------------------------------------------------------------------------------------------------------------------------
describe("the confirmation page", () => {
  const page = (s: ReturnType<typeof setup>, input: { method?: string; id?: string; query?: string; cookie?: string; headers?: Record<string, string>; fields?: Record<string, string> }) => {
    const id = input.id ?? APR_A;
    const path = `/v1/app/approve/${id}`;
    const headers: Record<string, string> = {
      ...(input.cookie === undefined ? {} : { cookie: `${DECIDE_COOKIE}=${input.cookie}` }),
      ...((input.method ?? "GET") === "POST" ? { origin: CELL, "content-type": "application/x-www-form-urlencoded" } : {}),
      ...(input.headers ?? {}),
    };
    return routeDecidePage(s.context, {
      method: input.method ?? "GET", path: `${path}${input.query ?? ""}`, headers, requestId: "r",
      ...(input.fields === undefined ? {} : { body: new URLSearchParams(input.fields).toString() }),
    }, new URL(`${CELL}${path}${input.query ?? ""}`));
  };
  const text = (response: { body: string }) => entities(response.body.replace(/<[^>]*>/g, " "));

  it("claims only its own paths", () => {
    expect(isDecidePagePath(`/v1/app/approve/${APR_A}`)).toBe(true);
    expect(isDecidePagePath("/v1/app/approvals")).toBe(false);
  });

  it("sends a browser with no fresh session to the identify step, and one carrying a ticket to the start, which takes the ticket out of the address bar", async () => {
    const s = setup();
    const bare = await page(s, {});
    expect(bare).toMatchObject({ statusCode: 302, headers: { location: `/v1/auth/decide/identify?return=/v1/app/approve/${APR_A}` } });
    const ticket = "T".repeat(43);
    const ticketed = await page(s, { query: `?ticket=${ticket}` });
    expect(ticketed.headers.location).toBe(`/v1/auth/decide/start?ticket=${ticket}`);
    expect(ticketed.headers.location).not.toContain(APR_A);
    // A ticket that is not shaped like one is not forwarded.
    expect((await page(s, { query: "?ticket=../../x" })).headers.location).toBe(`/v1/auth/decide/identify?return=/v1/app/approve/${APR_A}`);
    // A session opened for another approval is no session for this one.
    const other = await sessionFor(s, APR_B);
    expect((await page(s, { cookie: other })).statusCode).toBe(302);
  });

  it("shows the call and its arguments as text, in a POST form with the CSRF field, under the page's own headers", async () => {
    const s = setup();
    s.kind.view.paragraphs = ["The agent wants to close the issue."];
    s.kind.view.call = { connector: "github", tool: "issues.update", arguments: { title: "<script>alert(1)</script>", state: "closed", nested: { n: 2 }, bidi: "a\u202Eb" } };
    s.kind.view.facts = [{ label: "Agent", value: "Triage" }, { label: "Project", value: "web" }];
    const cookie = await sessionFor(s, APR_A);
    const response = await page(s, { cookie });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("<script>");
    expect(response.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(text(response)).toContain("issues.update");
    expect(text(response)).toContain('"state": "closed"');
    expect(text(response)).toContain("[U+202E]");
    expect(text(response)).toContain("The agent wants to close the issue.");
    expect(response.body).toContain(`<form method="post" action="/v1/app/approve/${APR_A}">`);
    expect(response.body).toContain(`name="csrf" value="${csrfTokenFor(cookie)}"`);
    expect(response.body).toContain('name="decision" value="approve"');
    expect(response.body).toContain('name="decision" value="decline"');
    const csp = response.headers["content-security-policy"]!;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toContain("form-action 'none'");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    // `no-referrer` would make the browser send `Origin: null` on the form post, which the Origin check refuses.
    expect(response.headers["referrer-policy"]).toBe("same-origin");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
  });

  it("answers 404 for another org's approval, 403 with who may decide, and who decided an approval already decided", async () => {
    const s = setup();
    const cookie = await sessionFor(s, APR_A);
    s.kind.orgId = OTHER_ORG;
    expect((await page(s, { cookie })).statusCode).toBe(404);
    s.kind.orgId = ORG;
    s.kind.eligible.delete(ALICE);
    const forbidden = await page(s, { cookie });
    expect(forbidden.statusCode).toBe(403);
    expect(text(forbidden)).toContain("Only a project maintainer can decide this.");
    s.kind.closed = { by: "Hugo Lim", at: "2026-10-21T11:00:00.000Z" };
    expect(text(await page(s, { cookie }))).toContain("This was already decided by Hugo Lim at 2026-10-21T11:00:00.000Z.");
  });

  it("refuses a bearer token on either route with REAUTH_REQUIRED and a ticketed confirmUrl (JSON), changing nothing", async () => {
    const s = setup();
    const get = await refusal(page(s, { headers: { authorization: "Bearer alice" } }));
    expect(get).toMatchObject({ code: "REAUTH_REQUIRED", status: 401 });
    expect(String(get?.details?.confirmUrl)).toContain(`${CELL}/v1/app/approve/${APR_A}?ticket=`);
    const posted = await refusal(page(s, { method: "POST", headers: { authorization: "Bearer alice" }, fields: { decision: "approve" } }));
    expect(posted).toMatchObject({ code: "REAUTH_REQUIRED" });
    expect(s.kind.decided).toEqual([]);
  });

  it("approves once for a fresh session with the right Origin and CSRF, applies exactly one decision, and spends the session", async () => {
    const s = setup();
    const cookie = await sessionFor(s, APR_A, ALICE, 120);
    const response = await page(s, { method: "POST", cookie, fields: { decision: "approve", csrf: csrfTokenFor(cookie) } });
    expect(response.statusCode).toBe(200);
    expect(text(response)).toContain("Approved.");
    expect(s.kind.decided).toEqual([{ target: { orgId: ORG, developerId: ALICE, approvalId: APR_A }, decision: "approve" }]);
    expect(s.db.get(`DECIDE_SESSION#${sha(cookie)}`, "META")).toBeUndefined();
    // The same session can't decide again, or decide anything else.
    const again = await page(s, { method: "POST", cookie, fields: { decision: "approve", csrf: csrfTokenFor(cookie) } });
    expect(again.statusCode).toBe(401);
    expect(s.kind.decided).toHaveLength(1);
  });

  it("declines through the same checks", async () => {
    const s = setup();
    const cookie = await sessionFor(s, APR_A);
    const response = await page(s, { method: "POST", cookie, fields: { decision: "decline", csrf: csrfTokenFor(cookie) } });
    expect(text(response)).toContain("Declined.");
    expect(s.kind.decided.map((entry) => entry.decision)).toEqual(["decline"]);
  });

  it("refuses a missing or wrong CSRF field, an Origin that is not the cell's, and Origin: null, with the exact words, and changes nothing", async () => {
    const s = setup();
    const cookie = await sessionFor(s, APR_A);
    for (const attempt of [
      { fields: { decision: "approve" } },
      { fields: { decision: "approve", csrf: "wrong" } },
      { fields: { decision: "approve", csrf: csrfTokenFor(cookie) }, headers: { origin: "https://evil.example" } },
      { fields: { decision: "approve", csrf: csrfTokenFor(cookie) }, headers: { origin: "null" } },
    ]) {
      const response = await page(s, { method: "POST", cookie, ...attempt });
      expect(response.statusCode).toBe(403);
      expect(text(response)).toContain("This request didn't come from Rovara's page.");
    }
    expect(s.kind.decided).toEqual([]);
    // None of those spent the session.
    expect((await page(s, { method: "POST", cookie, fields: { decision: "approve", csrf: csrfTokenFor(cookie) } })).statusCode).toBe(200);
  });

  it("asks again when the session is 11 minutes old, and re-checks eligibility at the moment of the post (R68)", async () => {
    const s = setup();
    const old = await sessionFor(s, APR_A, ALICE, 660);
    const stale = await page(s, { method: "POST", cookie: old, fields: { decision: "approve", csrf: csrfTokenFor(old) } });
    expect(stale.statusCode).toBe(401);
    expect(stale.body).toContain(`/v1/auth/decide/identify?return=/v1/app/approve/${APR_A}`);
    const cookie = await sessionFor(s, APR_A);
    s.kind.eligible.delete(ALICE);
    const demoted = await page(s, { method: "POST", cookie, fields: { decision: "approve", csrf: csrfTokenFor(cookie) } });
    expect(demoted.statusCode).toBe(403);
    expect(s.kind.decided).toEqual([]);
  });

  it("shows why a decision could not be applied, in the words it was refused with", async () => {
    const s = setup();
    const words = "The draft changed after this was asked. Publish again.";
    s.kind.decide = async () => { throw Object.assign(new Error(`AGENT_REVISION_CONFLICT: ${words}`), { code: "AGENT_REVISION_CONFLICT", statusCode: 409 }); };
    // An AgentXError is what a real kind throws; the page passes its words on.
    const { AgentXError } = await import("@rovara-code/contracts");
    s.kind.decide = async () => { throw new AgentXError("AGENT_REVISION_CONFLICT", words, 409); };
    const cookie = await sessionFor(s, APR_A);
    const response = await page(s, { method: "POST", cookie, fields: { decision: "approve", csrf: csrfTokenFor(cookie) } });
    expect(response.statusCode).toBe(409);
    expect(text(response)).toContain(words);
  });

  it("refuses a choice that is neither approve nor decline, and an id that is not an approval", async () => {
    const s = setup();
    const cookie = await sessionFor(s, APR_A);
    expect((await page(s, { method: "POST", cookie, fields: { decision: "maybe", csrf: csrfTokenFor(cookie) } })).statusCode).toBe(400);
    expect(s.kind.decided).toEqual([]);
    const notFound = await routeDecidePage(s.context, { method: "GET", path: "/v1/app/approve/not-an-id", headers: {}, requestId: "r" }, new URL(`${CELL}/v1/app/approve/not-an-id`));
    expect(notFound.statusCode).toBe(404);
    await expect(routeDecidePage(undefined, { method: "GET", path: `/v1/app/approve/${APR_A}`, headers: {}, requestId: "r" }, new URL(`${CELL}/v1/app/approve/${APR_A}`))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});


describe("through the broker", () => {
  afterEach(() => vi.useRealTimers());
  async function brokerWith(options: { decide: boolean }) {
    const f = await flow({ eligible: [GINA_ID] });
    // The broker reads the real clock; the sign-in function's tokens are issued on the harness clock.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(f.h.now());
    await signInOnce(f.h, "cloud", gina.sub);
    const code = (await f.h.signIn("cloud", gina.sub)).searchParams.get("code")!;
    const token = String((await f.h.exchange(code)).body.access_token);
    const config: DeveloperApiConfiguration = {
      issuer: ISSUER, env: "staging", methods: { slack: true, oidc: true, cloud: true, github: true }, signInTableName: "signin",
      channelMembers: async () => ({ ok: true as const, memberOf: [] }),
      verifyAccessToken: developerTokenVerifier({ issuer: ISSUER, keys: async () => [await f.h.signer.publicJwk()], now: () => Date.now() }),
    };
    const { db, handler } = await createAdminBroker({ developer: config, ...(options.decide ? { extra: { decide: { kinds: { apr: f.kind, spr: f.kind } } } } : {}) });
    for (const source of [f.h.db, f.h.state]) for (const item of source.items.values()) db.set(structuredClone(item));
    const call = async (method: string, path: string, headers: Record<string, string> = {}, body?: string) => {
      const response = await handler({ rawPath: path, headers, routeKey: "ANY /v1/app/{proxy+}", ...(body === undefined ? {} : { body }), requestContext: { requestId: "r", http: { method } } }) as { statusCode: number; headers: Record<string, string>; body: string };
      return response;
    };
    return { ...f, decide: f.h.decide, db, call, token };
  }

  it("answers a bearer token with REAUTH_REQUIRED, 401, and a confirmUrl whose ticket is stored as a hash", async () => {
    const b = await brokerWith({ decide: true });
    const response = await b.call("GET", `/v1/app/approve/${APR_A}`, { authorization: `Bearer ${b.token}` });
    expect(response.statusCode).toBe(401);
    const error = (JSON.parse(response.body) as { error: { code: string; message: string; confirmUrl: string } }).error;
    expect(error, response.body).toMatchObject({ code: "REAUTH_REQUIRED" });
    expect(error.confirmUrl).toMatch(new RegExp(`^${API}/v1/app/approve/${APR_A}\\?ticket=[A-Za-z0-9_-]{43}$`));
    expect(error.message).toBe(`Decisions are made in your browser. Open ${error.confirmUrl}.`);
    const ticket = new URL(error.confirmUrl).searchParams.get("ticket")!;
    expect(b.db.get(`DECIDE_TICKET#${sha(ticket)}`, "META")).toMatchObject({ developerId: GINA_ID, approvalId: APR_A, mintedBy: "token" });
    expect(JSON.stringify(b.db.find(() => true))).not.toContain(ticket);
  });

  it("serves the page to a browser with a session, with the page's headers, and sends one without to the identify step", async () => {
    const b = await brokerWith({ decide: true });
    const cookie = `cookie-${"x".repeat(40)}`;
    const signedInAt = seconds(Date.now());
    await b.decide.putSession(cookie, { orgId: await orgOf(b.h, GINA_ID), developerId: GINA_ID, approvalId: APR_A, signedInAt, method: "email_code", csrfHash: sha(csrfTokenFor(cookie)), expiresAt: signedInAt + 600 });
    for (const item of b.h.db.items.values()) b.db.set(structuredClone(item));
    const shown = await b.call("GET", `/v1/app/approve/${APR_A}`, { cookie: `${DECIDE_COOKIE}=${cookie}` });
    expect(shown.statusCode).toBe(200);
    expect(shown.headers["content-security-policy"]).toContain("form-action 'self'");
    expect(shown.headers["x-frame-options"]).toBe("DENY");
    expect(shown.body).toContain("Run a write");
    const bare = await b.call("GET", `/v1/app/approve/${APR_A}`);
    expect(bare.statusCode).toBe(302);
    expect(bare.headers.location).toBe(`/v1/auth/decide/identify?return=/v1/app/approve/${APR_A}`);
  });

  it("answers not found where no approval kinds are registered", async () => {
    const b = await brokerWith({ decide: false });
    expect((await b.call("GET", `/v1/app/approve/${APR_A}`)).statusCode).toBe(404);
  });
});


describe("isFreshInteractiveSignIn (R67, R6-4)", () => {
  const state = { startedAt: T0, identityProvider: "COGNITO", prompt: "login" } as const;
  const at = (offsetSeconds: number) => seconds(T0) + offsetSeconds;
  it("accepts an auth_time from this flow that shows the email code, and one with no amr from the flow's own native sign-in", () => {
    expect(isFreshInteractiveSignIn({ authTime: at(5), amr: ["otp"] }, state, T0 + 10_000)).toBe(true);
    expect(isFreshInteractiveSignIn({ authTime: at(5) }, state, T0 + 10_000)).toBe(true);
    expect(isFreshInteractiveSignIn({ authTime: seconds(T0) }, state, T0 + 600_000)).toBe(true);
  });
  it("refuses no auth_time, an auth_time before the flow began, one older than 10 minutes, and one from the future", () => {
    expect(isFreshInteractiveSignIn({}, state, T0 + 10_000)).toBe(false);
    expect(isFreshInteractiveSignIn({ authTime: Number.NaN }, state, T0 + 10_000)).toBe(false);
    expect(isFreshInteractiveSignIn({ authTime: at(-1) }, state, T0 + 10_000)).toBe(false);
    expect(isFreshInteractiveSignIn({ authTime: seconds(T0) }, state, T0 + 601_000)).toBe(false);
    expect(isFreshInteractiveSignIn({ authTime: at(300) }, state, T0 + 10_000)).toBe(false);
  });
  it("refuses an amr that does not show the email code, and a missing amr when the state was not made by the decide start route", () => {
    expect(isFreshInteractiveSignIn({ authTime: at(5), amr: ["pwd"] }, state, T0 + 10_000)).toBe(false);
    expect(isFreshInteractiveSignIn({ authTime: at(5), amr: [] }, state, T0 + 10_000)).toBe(false);
    expect(isFreshInteractiveSignIn({ authTime: at(5) }, { ...state, identityProvider: "Google" as never }, T0 + 10_000)).toBe(false);
    expect(isFreshInteractiveSignIn({ authTime: at(5) }, { ...state, prompt: "none" as never }, T0 + 10_000)).toBe(false);
  });
});


// ---------------------------------------------------------------------------------------------------------------------------------
// Fix round 1 (review of 21a-presence).
// ---------------------------------------------------------------------------------------------------------------------------------
describe("fix round 1: the callback must be the member's own email-code pool user", () => {
  const fresh = (h: Harness) => ({ claims: { auth_time: nowSeconds(h) } });
  const sessions = (h: Harness) => h.db.find((item) => String(item.pk).startsWith("DECIDE_SESSION#"));

  it("refuses a Google-federated pool user's fresh token (no amr, a silent return) even though it resolves to the same member", async () => {
    // gina-1 stands for the member's Google sign-in through the pool: linked to Gina, token without an email-code amr, auth_time fresh.
    const f = await flow();
    await signInOnce(f.h, "cloud", gina.sub);
    const started = await startDecide(f.h, GINA_ID);
    const callback = await finishDecide(f.h, started, gina.sub, fresh(f.h));
    expect(callback.statusCode).toBe(403);
    expect(copy(callback).paragraphs).toContain("Confirm with the email code sent to your address. Open the approval again.");
    expect(cookieValueOf(callback, DECIDE_COOKIE)).toBeUndefined();
    expect(sessions(f.h)).toEqual([]);
  });

  it("also refuses a token that names federated identities, whoever it is for", async () => {
    const f = await flow({ oidcUsers: [gina, hugo, { ...ginaCognito, identities: [{ providerName: "Google" }] } as never] });
    await signInOnce(f.h, "cloud", gina.sub);
    const started = await startDecide(f.h, GINA_ID);
    const callback = await finishDecide(f.h, started, ginaCognito.sub, fresh(f.h));
    expect(callback.statusCode).toBe(403);
    expect(sessions(f.h)).toEqual([]);
  });

  it("gives a member whose only cloud sign-in is Google an email-code user, links it with one notice, and lets them confirm", async () => {
    const notices: Array<Record<string, unknown>> = [];
    const f = await flow({ cognito: [], notice: notices, oidcUsers: [gina, ginaCognito] });
    await signInOnce(f.h, "cloud", gina.sub);
    const started = await startDecide(f.h, GINA_ID);
    expect(started.response.statusCode).toBe(302);
    expect(f.cognito.calls.map((call) => call.name)).toEqual(["AdminGetUserCommand", "AdminCreateUserCommand"]);
    expect(f.h.db.get(`SIGNIN_IDENTITY#${ownerKeyForSubject(OIDC_ISSUER, ginaCognito.sub)}`, "META")).toMatchObject({ developerId: GINA_ID, provider: "cloud" });
    expect(notices).toHaveLength(1);
    const callback = await finishDecide(f.h, started, ginaCognito.sub, fresh(f.h));
    expect(callback.statusCode).toBe(200);
    expect(sessions(f.h)).toHaveLength(1);
    // The same Google identity is still refused as the proof.
    const second = await startDecide(f.h, GINA_ID, APR_B);
    expect(f.cognito.calls.filter((call) => call.name === "AdminCreateUserCommand")).toHaveLength(1);
    expect((await finishDecide(f.h, second, gina.sub, fresh(f.h))).statusCode).toBe(403);
  });

  it("refuses, with the one copy, an address whose pool user is a federated (EXTERNAL_PROVIDER) one, and creates nothing", async () => {
    const f = await flow({ cognito: [{ email: "gina@x.dev", sub: "fed-sub", federated: true }] });
    await signInOnce(f.h, "cloud", gina.sub);
    const started = await startDecide(f.h, GINA_ID);
    expect(started.response.statusCode).toBe(403);
    expect(copy(started.response).paragraphs).toContain("Rovara couldn't set up email confirmation for your account. Ask an admin for help.");
    expect(f.cognito.calls.map((call) => call.name)).toEqual(["AdminGetUserCommand"]);
    expect(f.h.db.get(`SIGNIN_IDENTITY#${ownerKeyForSubject(OIDC_ISSUER, "fed-sub")}`, "META")).toBeUndefined();
    expect(f.h.db.find((item) => String(item.pk).startsWith("DECIDE_STATE#"))).toEqual([]);
  });

  it("refuses a different account BEFORE any link: an unlinked pool user with the member's email is not linked or merged by the callback", async () => {
    const signup = { sub: "signup-sub", name: "Signup", email: "gina@x.dev", email_verified: true, amr: ["otp"] };
    const f = await flow({ oidcUsers: [gina, hugo, ginaCognito, signup] });
    await signInOnce(f.h, "cloud", gina.sub);
    const started = await startDecide(f.h, GINA_ID);
    const before = JSON.stringify(f.h.db.find((item) => !String(item.pk).startsWith("DECIDE_")));
    const callback = await finishDecide(f.h, started, signup.sub, fresh(f.h));
    expect(callback.statusCode).toBe(403);
    expect(copy(callback).paragraphs).toContain("You confirmed as a different account. Open the approval again.");
    expect(f.h.db.get(`SIGNIN_IDENTITY#${ownerKeyForSubject(OIDC_ISSUER, signup.sub)}`, "META")).toBeUndefined();
    expect(JSON.stringify(f.h.db.find((item) => !String(item.pk).startsWith("DECIDE_")))).toBe(before);
    expect(sessions(f.h)).toEqual([]);
  });

  it("takes the daily account-creation slot only for a successful AdminCreateUser", async () => {
    const failing = await flow({ cognito: [], github: true, oidcUsers: [ginaCognito] });
    await signInOnce(failing.h, "github", "77");
    failing.cognito.failNextCreate = "InternalErrorException";
    const started = await startDecide(failing.h, GH_ID);
    expect(started.response.statusCode).toBe(500);
    // The failed attempt used no slot: a retry creates the user.
    const retry = await startDecide(failing.h, GH_ID, APR_B);
    expect(retry.response.statusCode).toBe(302);
    expect(failing.cognito.calls.filter((call) => call.name === "AdminCreateUserCommand")).toHaveLength(2);
    // The successful one used it.
    await expect(failing.h.decide.takeCreateUserSlot(GH_ID)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });
});

describe("fix round 1: the callback ends on a same-origin page, not a redirect (Strict cookie)", () => {
  /**
   * The browser rule this models: a SameSite=Strict cookie is sent only when the whole navigation is same-site. The callback is reached from
   * the pool's managed-login page, a cross-site start, and a 302 continues that same navigation, so the cookie is not sent on the next hop.
   * A page that sends the browser on itself (a link, a meta refresh) starts a new navigation, initiated by our own origin.
   */
  const nextHop = (response: HttpResult) => response.statusCode >= 300 && response.statusCode < 400
    ? { path: response.headers.location!, strictCookieSent: false }
    : { path: landingOf(response)!, strictCookieSent: true };

  it("lets the person land on the confirmation page with the cookie the callback set", async () => {
    const f = await flow();
    await signInOnce(f.h, "cloud", gina.sub);
    const started = await startDecide(f.h, GINA_ID);
    const callback = await finishDecide(f.h, started, ginaCognito.sub, { claims: { auth_time: nowSeconds(f.h) } });
    const cookie = cookieValueOf(callback, DECIDE_COOKIE)!;
    const hop = nextHop(callback);
    expect(hop).toEqual({ path: `/v1/app/approve/${APR_A}`, strictCookieSent: true });
    const context: DecideRequestContext = { store: f.h.decide, now: f.h.now, cellOrigin: API, kinds: { apr: f.kind } };
    const landing = await routeDecidePage(context, { method: "GET", path: hop.path, headers: hop.strictCookieSent ? withCookie(cookie) : {}, requestId: "r" }, new URL(`${API}${hop.path}`));
    expect(landing.statusCode).toBe(200);
    expect(landing.body).toContain('name="decision" value="approve"');
    expect(callback.body).toContain(`<meta http-equiv="refresh" content="0;url=/v1/app/approve/${APR_A}">`);
    expect(setCookie(callback, DECIDE_COOKIE)).toContain("SameSite=Strict");
  });

  it("shows the model catches the old behaviour: the same landing after a 302 finds no cookie and is sent round again", async () => {
    const f = await flow();
    await signInOnce(f.h, "cloud", gina.sub);
    const started = await startDecide(f.h, GINA_ID);
    const callback = await finishDecide(f.h, started, ginaCognito.sub, { claims: { auth_time: nowSeconds(f.h) } });
    const redirected: HttpResult = { statusCode: 302, headers: { location: `/v1/app/approve/${APR_A}` }, body: "", cookies: callback.cookies ?? [] };
    const hop = nextHop(redirected);
    const context: DecideRequestContext = { store: f.h.decide, now: f.h.now, cellOrigin: API, kinds: { apr: f.kind } };
    const landing = await routeDecidePage(context, { method: "GET", path: hop.path, headers: hop.strictCookieSent ? withCookie(cookieValueOf(callback, DECIDE_COOKIE)!) : {}, requestId: "r" }, new URL(`${API}${hop.path}`));
    expect(landing.statusCode).toBe(302);
    expect(landing.headers.location).toContain("/v1/auth/decide/identify");
  });
});

describe("fix round 1: an earlier real session, the ticket in logs, and each member's share", () => {
  it("ends the browser's earlier real decide session when a new sign-in completes, and the old value no longer works", async () => {
    const f = await flow();
    await signInOnce(f.h, "cloud", gina.sub);
    const first = await finishDecide(f.h, await startDecide(f.h, GINA_ID), ginaCognito.sub, { claims: { auth_time: nowSeconds(f.h) } });
    const old = cookieValueOf(first, DECIDE_COOKIE)!;
    const context: DecideRequestContext = { store: f.h.decide, now: f.h.now, cellOrigin: API, kinds: {} };
    await expect(requireDecideSession(context, get(`/v1/app/approve/${APR_A}`, withCookie(old)))).resolves.toBeDefined();
    f.h.tick(1000);
    const started = await startDecide(f.h, GINA_ID, APR_B);
    const second = await request(f.h, f.h.oidc.approve(started.providerUrl!, ginaCognito.sub, { claims: { auth_time: nowSeconds(f.h) } }), `${started.pkce}; ${DECIDE_COOKIE}=${old}`);
    const value = cookieValueOf(second, DECIDE_COOKIE)!;
    expect(value).not.toBe(old);
    expect(f.h.db.get(`DECIDE_SESSION#${sha(old)}`, "META")).toBeUndefined();
    expect(await refusal(requireDecideSession(context, get(`/v1/app/approve/${APR_A}`, withCookie(old))))).toMatchObject({ code: "REAUTH_REQUIRED" });
    await expect(requireDecideSession(context, get(`/v1/app/approve/${APR_B}`, withCookie(value)))).resolves.toBeDefined();
  });

  it("never logs a ticket, a state, a verifier or a cookie value across a whole decide flow", async () => {
    const f = await flow();
    await signInOnce(f.h, "cloud", gina.sub);
    const started = await startDecide(f.h, GINA_ID);
    const callback = await finishDecide(f.h, started, ginaCognito.sub, { claims: { auth_time: nowSeconds(f.h) } });
    const secrets = [started.ticket, new URL(started.providerUrl!).searchParams.get("state")!, started.pkce!.split("=")[1]!, cookieValueOf(callback, DECIDE_COOKIE)!];
    const logged = JSON.stringify(f.h.logs);
    for (const secret of secrets) expect(logged).not.toContain(secret);
  });

  it("gives each member a share of the per-approval ticket cap: one member can't block the others", async () => {
    const s = setup();
    for (let index = 0; index < 5; index += 1) await s.store.mintTicket({ orgId: ORG, developerId: ALICE, approvalId: APR_A, mintedBy: "token" });
    expect(await refusal(s.store.mintTicket({ orgId: ORG, developerId: ALICE, approvalId: APR_A, mintedBy: "token" }))).toMatchObject({ code: "TOO_MANY_REQUESTS", status: 429, message: RATE_LIMIT_MESSAGE });
    // Bob still gets his, and Alice keeps hers on other approvals.
    await s.store.mintTicket({ orgId: ORG, developerId: BOB, approvalId: APR_A, mintedBy: "token" });
    await s.store.mintTicket({ orgId: ORG, developerId: ALICE, approvalId: APR_B, mintedBy: "token" });
  });
});


describe("eligibility asked of the broker fails closed (21a-wiring, hand-off 1)", () => {
  /** The kinds the sign-in function has: they ask the broker, which can fail to answer. */
  const unreachable: DecideKinds = (() => {
    const kind: DecideKind = { inspect: async () => { throw new Error("the broker did not answer"); }, decide: async () => { throw new Error("not here"); } };
    return { apr: kind, spr: kind };
  })();

  it("a ticket start whose eligibility can't be asked gives a 503 page and calls Cognito for nothing, makes no state and no link", async () => {
    const { h, cognito, sent } = await flow({ github: true, cognito: [], oidcUsers: [ginaCognito], kinds: unreachable });
    await signInOnce(h, "github", "77");
    const links = h.db.find((item) => String(item.pk).startsWith("SIGNIN_IDENTITY#")).length;
    const started = await startDecide(h, GH_ID);
    expect(started.response.statusCode).toBe(503);
    expect(started.response.headers.location).toBeUndefined();
    expect(cognito.calls).toEqual([]);
    expect(sent).toEqual([]);
    expect(h.db.find((item) => String(item.pk).startsWith("DECIDE_STATE#") || String(item.pk).startsWith("DECIDE_SESSION#"))).toEqual([]);
    expect(h.db.find((item) => String(item.pk).startsWith("SIGNIN_IDENTITY#"))).toHaveLength(links);
    expect(JSON.stringify(started.response)).not.toContain("did not answer");
  });

  it("a ticket start checks eligibility again: a member who lost it since the ticket was minted gets 403 and no state, no Cognito call", async () => {
    const { h, kind, cognito } = await flow();
    await signInOnce(h, "cloud", gina.sub);
    const ticket = await h.decide.mintTicket({ orgId: await orgOf(h, GINA_ID), developerId: GINA_ID, approvalId: APR_A, mintedBy: "token" });
    kind.eligible.delete(GINA_ID);
    const response = await request(h, `/v1/auth/decide/start?ticket=${ticket}`);
    expect(response.statusCode).toBe(403);
    expect(response.headers.location).toBeUndefined();
    expect(h.db.find((item) => String(item.pk).startsWith("DECIDE_STATE#"))).toEqual([]);
    expect(cognito.calls).toEqual([]);
  });

  it("an identify callback whose eligibility can't be asked gives a 503 page and mints no ticket", async () => {
    const { h } = await flow({ kinds: unreachable });
    await signInOnce(h, "cloud", gina.sub);
    let response = await request(h, `/v1/auth/decide/identify?return=${encodeURIComponent(`/v1/app/approve/${APR_A}`)}`);
    const pkce = cookieValueOf(response, DECIDE_PKCE_COOKIE);
    if (response.statusCode === 200) {
      const link = /href="([^"]*method=cloud)"/.exec(response.body)?.[1];
      response = await request(h, link!.replaceAll("&amp;", "&"), `${DECIDE_PKCE_COOKIE}=${pkce}`);
    }
    const callback = await request(h, h.oidc.approve(response.headers.location!, gina.sub), `${DECIDE_PKCE_COOKIE}=${pkce}`);
    expect(callback.statusCode).toBe(503);
    expect(h.db.find((item) => String(item.pk).startsWith("DECIDE_TICKET#"))).toEqual([]);
    expect(callback.headers.location).toBeUndefined();
  });

  it("a token whose member's eligibility can't be asked gets an error and no ticket", async () => {
    const s = setup();
    s.context.kinds = unreachable;
    const refused = await refusal(requireDecideSession(s.context, { method: "POST", path: `/v1/app/approvals/${APR_A}/decide`, headers: { authorization: "Bearer alice" }, body: "{}" }));
    expect(refused).toBeDefined();
    expect(refused?.code).not.toBe("REAUTH_REQUIRED");
    expect(s.db.find((item) => String(item.pk).startsWith("DECIDE_TICKET#"))).toEqual([]);
  });
});
