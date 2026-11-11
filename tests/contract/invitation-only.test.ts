// 0.5.14: "new companies by invitation only" on the hosted cloud. A cloud or GitHub sign-in with no company and no usable invite never makes a company (no org, no budget rows),
// and the person is told Rovara is invitation-only. An invite, an existing member, the Slack/company rules and an install with the setting off are unchanged. With the cloud
// pool admin-create-only, opening an invite makes the invitee's pool user (AdminCreateUser, no email sent), so an invite still works for a person with no account.
import { describe, expect, it, vi } from "vitest";
import { developerOrgKey, orgInviteKey } from "@agentx/cloud-contracts";
import { ownerKeyForSubject, type HttpApiV2Event } from "../../packages/broker/src/aws/lambda.js";
import { createDeveloperIdentityHandler, type HttpResult } from "../../packages/broker/src/developer/server.js";
import { sha256Hex } from "../../packages/broker/src/developer/tokens.js";
import { inviteTokenHash } from "../../packages/broker/src/org/invite-url.js";
import { INVITATION_ONLY_MESSAGE, resolveOrgOnSignIn } from "../../packages/broker/src/org/sign-in.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { API, OIDC_ISSUER, httpEvent, identityHarness, type FakeGithubUser, type FakeOidcUser } from "../support/developer-fakes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

const SESSION_COOKIE = "__Host-agentx_review_session";
const JOIN_COOKIE = "__Host-rovara_join_pkce";
const REVIEW_COOKIE = "__Host-agentx_review_pkce";
const maya: FakeOidcUser = { sub: "maya-io", name: "Maya Chen", email: "maya@example.com", email_verified: true };
const bea: FakeOidcUser = { sub: "bea-io", name: "Bea Ortiz", email: "bea@example.com", email_verified: true };
const carl: FakeOidcUser = { sub: "carl-io", name: "Carl Wu", email: "carl@x.dev", email_verified: true };
const octo: FakeGithubUser = { id: 7001, login: "octo-io", name: "Octo", emails: [{ email: "octo@example.com", primary: true, verified: true }] };
const idOf = (user: FakeOidcUser) => ownerKeyForSubject(OIDC_ISSUER, user.sub);
const OWNER = "f".repeat(64);
const dev = (letter: string) => letter.repeat(64);
const now = () => Date.parse("2026-10-19T00:00:00.000Z");
const everything = (state: FakeDynamoDb) => state.find(() => true);

describe("resolveOrgOnSignIn with new companies by invitation only", () => {
  const setup = () => {
    const state = new FakeDynamoDb();
    return { state, orgs: new OrgStore({ documentClient: state, tableName: "state", now }) };
  };
  const input = (method: "cloud" | "github", developerId: string, extra: { email?: string; emailVerified?: boolean; inviteTokenHash?: string } = {}) =>
    ({ method, developerId, displayName: "Maya", emailVerified: true, ...extra });

  it.each(["cloud", "github"] as const)("refuses an uninvited %s sign-in and writes nothing at all", async (method) => {
    const { state, orgs } = setup();
    const refusal = await resolveOrgOnSignIn({ orgs, newOrgsByInvitationOnly: true }, input(method, dev("a"), { email: "maya@example.com" })).catch((error: unknown) => error as { code?: string; message?: string });
    expect(refusal).toMatchObject({ code: "CONFIG_INVALID" });
    expect((refusal as { message: string }).message).toContain(INVITATION_ONLY_MESSAGE);
    expect(everything(state)).toHaveLength(0);
  });

  it("is the guard that stops it: the same sign-in with the setting off (or absent) makes an org, as before", async () => {
    for (const flag of [{}, { newOrgsByInvitationOnly: false }]) {
      const { state, orgs } = setup();
      const result = await resolveOrgOnSignIn({ orgs, ...flag }, input("cloud", dev("a"), { email: "maya@example.com" }));
      expect(result).toMatchObject({ role: "owner" });
      expect(state.find((item) => item.entityType === "ORG")).toHaveLength(1);
    }
  });

  it("refuses an unknown invite, and an invite written for another address, and leaves the invite usable", async () => {
    const { state, orgs } = setup();
    const org = await orgs.createOrgWithOwner({ name: "A", developerId: dev("a") });
    const { token } = await orgs.createInvite({ orgId: org, createdBy: dev("a"), role: "member", email: "kate@provider.dev" });
    const before = everything(state).length;
    const deps = { orgs, newOrgsByInvitationOnly: true };
    await expect(resolveOrgOnSignIn(deps, input("cloud", dev("b"), { inviteTokenHash: inviteTokenHash("no-such-token") }))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(resolveOrgOnSignIn(deps, input("github", dev("c"), { email: "other@provider.dev", inviteTokenHash: inviteTokenHash(token) }))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(everything(state)).toHaveLength(before);
    expect(state.get(orgInviteKey(sha256Hex(token)))?.acceptedAt).toBeUndefined();
  });

  it("still lets an invite in (cloud and GitHub), and keeps the org a person already has", async () => {
    const { state, orgs } = setup();
    const org = await orgs.createOrgWithOwner({ name: "A", developerId: dev("a") });
    const deps = { orgs, newOrgsByInvitationOnly: true };
    const cloud = await orgs.createInvite({ orgId: org, createdBy: dev("a"), role: "admin" });
    expect(await resolveOrgOnSignIn(deps, input("cloud", dev("b"), { inviteTokenHash: inviteTokenHash(cloud.token) }))).toEqual({ orgId: org, role: "admin" });
    const github = await orgs.createInvite({ orgId: org, createdBy: dev("a"), role: "member" });
    expect(await resolveOrgOnSignIn(deps, input("github", dev("c"), { inviteTokenHash: inviteTokenHash(github.token) }))).toEqual({ orgId: org, role: "member" });
    expect(await resolveOrgOnSignIn(deps, input("cloud", dev("a")))).toEqual({ orgId: org, role: "owner" });
    expect(state.find((item) => item.entityType === "ORG")).toHaveLength(1);
  });

  it("leaves rule 4 alone: a Slack sign-in still joins the install's single org", async () => {
    const { orgs } = setup();
    expect(await resolveOrgOnSignIn({ orgs, singleOrgId: TEST_ORG, newOrgsByInvitationOnly: true }, { method: "slack", developerId: dev("d"), displayName: "Di", emailVerified: false }))
      .toEqual({ orgId: TEST_ORG, role: "member" });
  });
});

describe("the sign-in server with new companies by invitation only", () => {
  const harness = (extra: { on?: boolean; github?: boolean; users?: FakeOidcUser[] } = {}) => {
    const h = identityHarness({
      cloud: {}, oidcUsers: extra.users ?? [maya, bea], slack: false, singleOrg: false, ...(extra.on === false ? {} : { newOrgsByInvitationOnly: true }),
      ...(extra.github === true ? { github: { users: [octo] } } : {}),
    });
    const joined = vi.fn(async () => undefined);
    h.deps.onOrgJoined = joined;
    return { h, joined };
  };
  const orgs = (h: ReturnType<typeof identityHarness>) => h.state.find((item) => item.entityType === "ORG");
  const refusedLogs = (h: ReturnType<typeof identityHarness>) => h.logs.filter((entry) => entry.event === "signin.refused");

  it.each(["cloud", "github"] as const)("an uninvited %s sign-in from the CLI is refused in plain words, with no org, no pointer and no budget sync", async (method) => {
    const { h, joined } = harness({ github: true });
    const who = method === "cloud" ? maya.sub : String(octo.id);
    const back = await h.signIn(method, who);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("error_description")).toContain("invitation-only");
    expect(back.searchParams.get("error_description")).toContain("invite you");
    expect(back.searchParams.get("code")).toBeNull();
    expect(orgs(h)).toHaveLength(0);
    expect(h.state.find((item) => item.entityType === "ORG_MEMBER")).toHaveLength(0);
    expect(h.state.find((item) => String(item.pk).startsWith("DEVELOPER_ORG#") || String(item.pk).includes("ORG_EMAIL"))).toHaveLength(0);
    expect(joined).not.toHaveBeenCalled();
    expect(refusedLogs(h)).toEqual([expect.objectContaining({ method, reason: "invitation_only" })]);
  });

  it("with the setting off the same sign-in makes a company and syncs its budgets, as before (positive control for the refusal above)", async () => {
    const { h, joined } = harness({ on: false, github: true });
    expect((await h.signIn("cloud", maya.sub)).searchParams.get("code")).toBeTruthy();
    expect((await h.signIn("github", String(octo.id))).searchParams.get("code")).toBeTruthy();
    expect(orgs(h)).toHaveLength(2);
    expect(joined).toHaveBeenCalledTimes(2);
  });

  it("an invite still works from the CLI, and a person who already has a company signs in", async () => {
    const { h } = harness();
    const orgId = await h.orgs.createOrgWithOwner({ name: "Acme", developerId: OWNER });
    const { token } = await h.orgs.createInvite({ orgId, createdBy: OWNER, role: "member" });
    expect((await h.signIn("cloud", bea.sub, { query: { invite: token } })).searchParams.get("code")).toBeTruthy();
    expect(await h.orgs.orgForDeveloper(idOf(bea))).toEqual({ orgId, role: "member" });
    // Maya joined earlier by her own company, made before the setting was turned on.
    const own = await h.orgs.createOrgWithOwner({ name: "Maya's", developerId: idOf(maya) });
    expect((await h.signIn("cloud", maya.sub)).searchParams.get("code")).toBeTruthy();
    expect(await h.orgs.orgForDeveloper(idOf(maya))).toEqual({ orgId: own, role: "owner" });
    expect(orgs(h)).toHaveLength(2);
  });

  async function browserSignIn(h: ReturnType<typeof identityHarness>, user: string, query = "") {
    const start = await h.http(httpEvent("GET", `/v1/auth/browser/authorize?return_to=%2Fapp%2Fwelcome${query}`));
    const cookie = start.cookies!.find((value) => value.startsWith(`${REVIEW_COOKIE}=`))!.split(";")[0]!;
    return h.http({ ...httpEvent("GET", h.oidc.approve(start.headers.location!, user)), headers: { cookie } });
  }

  it("a browser sign-in, whether or not the person chose Create a company, ends on the invitation-only page and creates nothing", async () => {
    const { h, joined } = harness();
    for (const query of ["", "&intent=create"]) {
      const done = await browserSignIn(h, maya.sub, query);
      expect(done.headers.location).toBe("/app/signed-out?reason=invitation_only");
      expect(done.cookies?.some((value) => value.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
    }
    expect(orgs(h)).toHaveLength(0);
    expect(h.db.find((item) => String(item.pk).startsWith("SESSION#"))).toHaveLength(0);
    expect(joined).not.toHaveBeenCalled();
  });

  it("with the setting off a browser sign-in without the intent is still no_account, and with it creates the company", async () => {
    const { h } = harness({ on: false });
    expect((await browserSignIn(h, maya.sub)).headers.location).toBe("/app/signed-out?reason=no_account");
    expect((await browserSignIn(h, maya.sub, "&intent=create")).headers.location).toBe("/app/welcome");
    expect(orgs(h)).toHaveLength(1);
  });
});

describe("an invite works when the cloud pool is admin-create-only", () => {
  type H = ReturnType<typeof identityHarness>;
  const harness = (extra: { on?: boolean; users?: FakeOidcUser[]; github?: boolean } = {}) => identityHarness({
    cloud: {}, oidcUsers: extra.users ?? [bea, carl], slack: false, singleOrg: false,
    ...(extra.on === false ? {} : { newOrgsByInvitationOnly: true, invitedUsers: true }),
    ...(extra.github === true ? { github: { users: [octo] } } : {}),
  });
  const withCookie = (event: HttpApiV2Event, cookie: string | undefined): HttpApiV2Event => (cookie === undefined ? event : { ...event, headers: { ...event.headers, cookie } });
  const get = (h: H, path: string, cookie?: string, headers: Record<string, string> = {}): Promise<HttpResult> => h.http(withCookie(httpEvent("GET", path, undefined, headers), cookie));
  /** The invite page's email form: a POST with the invite and the address in its body, from a source address. */
  const post = (h: H, fields: Record<string, string>, extra: { ip?: string; origin?: string } = {}): Promise<HttpResult> => {
    const event = httpEvent("POST", "/v1/auth/join/start", fields, extra.origin === undefined ? {} : { origin: extra.origin });
    return h.http({ ...event, requestContext: { ...event.requestContext, http: { method: "POST", sourceIp: extra.ip ?? "198.51.100.7" } } });
  };
  async function acme(h: H) {
    const orgId = await h.orgs.createOrgWithOwner({ name: "Acme", developerId: OWNER });
    await h.deps.store.upsertDeveloper({ developerId: OWNER, provider: "cloud", issuer: OIDC_ISSUER, subject: "owner-io", displayName: "Maya Chen" });
    return orgId;
  }
  const inviteTo = async (h: H, orgId: Parameters<H["orgs"]["createInvite"]>[0]["orgId"], email?: string) =>
    (await h.orgs.createInvite({ orgId, createdBy: OWNER, role: "member", ...(email === undefined ? {} : { email }) })).token;
  const created = (h: H) => h.cognito.calls.filter((call) => call.name === "AdminCreateUserCommand");
  /** After the start page: sign in at the provider as `user`, finish the callback and the done page. */
  async function finish(h: H, start: HttpResult, user: FakeOidcUser) {
    const cookie = (start.cookies ?? []).find((value) => value.startsWith(`${JOIN_COOKIE}=`))!.split(";")[0]!;
    const providerUrl = start.statusCode === 302 ? start.headers.location! : /class="method" href="([^"]*)"/.exec(start.body)![1]!.replaceAll("&amp;", "&");
    const callback = await get(h, h.oidc.approve(providerUrl, user.sub), cookie);
    const location = new URL(callback.headers.location!, "https://x.example");
    return get(h, location.pathname + location.search, cookie);
  }
  /** Every URL a response sends the browser to: its Location, its meta refresh, its links and its form action. */
  const urlsIn = (response: HttpResult): string[] => [
    response.headers.location ?? "", ...[...response.body.matchAll(/content="0;url=([^"]*)"/g)].map((match) => match[1]!),
    ...[...response.body.matchAll(/href="([^"]*)"/g)].map((match) => match[1]!), ...[...response.body.matchAll(/action="([^"]*)"/g)].map((match) => match[1]!),
  ];

  it("makes the pool user for the address an email invite is written for (verified, no email sent), and the person then joins", async () => {
    const h = harness();
    const orgId = await acme(h);
    const token = await inviteTo(h, orgId, "bea@example.com");
    const start = await get(h, `/v1/auth/join/start?invite=${token}`);
    expect(start.statusCode).toBe(302);
    expect(h.cognito.calls.map((call) => call.name)).toEqual(["AdminGetUserCommand", "AdminCreateUserCommand"]);
    expect(created(h)[0]!.input).toEqual({
      UserPoolId: "us-east-1_TESTPOOL", Username: "bea@example.com", MessageAction: "SUPPRESS",
      UserAttributes: [{ Name: "email", Value: "bea@example.com" }, { Name: "email_verified", Value: "true" }],
    });
    const done = await finish(h, start, bea);
    expect(done.statusCode).toBe(302);
    expect(done.headers.location).toContain("/app/welcome?joined=1");
    expect(await h.orgs.orgForDeveloper(idOf(bea))).toEqual({ orgId, role: "member" });
  });

  it("uses the invite's own address, whatever else is typed, and leaves an existing pool user alone", async () => {
    const h = harness();
    const orgId = await acme(h);
    const token = await inviteTo(h, orgId, "bea@example.com");
    await post(h, { invite: token, email: "someone-else@example.com" });
    expect(created(h).map((call) => call.input.Username)).toEqual(["bea@example.com"]);
    const again = await inviteTo(h, orgId, "bea@example.com");
    await get(h, `/v1/auth/join/start?invite=${again}`);
    expect(created(h)).toHaveLength(1);
  });

  it("a link anyone may use asks for an email address on its page, in a POST form that allows a submission to this server only", async () => {
    const h = harness();
    const token = await inviteTo(h, await acme(h));
    const page = await get(h, `/v1/auth/join?invite=${token}`);
    expect(page.statusCode).toBe(200);
    expect(page.body).toMatch(/<form method="post" action="[^"]*\/join\/start">/);
    expect(page.body).not.toContain('method="get"');
    expect(page.body).toContain(`name="invite" value="${token}"`);
    expect(page.body).toMatch(/<input id="rv-email" type="email" name="email" required/);
    expect(page.headers["content-security-policy"]).toContain("form-action 'self'");
    // A browser sends `Origin: null` with a form POST from a page whose policy is `no-referrer` (proved in Chromium, Firefox and WebKit): this page's is same-origin, so it sends the real origin.
    expect(page.headers["referrer-policy"]).toBe("same-origin");
    // Every other join page, and the hop to the provider, still send no referrer at all.
    expect((await get(h, `/v1/auth/join?invite=${"A".repeat(43)}`)).headers["referrer-policy"]).toBe("no-referrer");
    expect((await post(h, { invite: token, email: "page-check@x.dev" })).headers["referrer-policy"]).toBe("no-referrer");
    // The Join link for a person who already has an account (or GitHub) is still there.
    expect(page.body).toContain(`/join/start?invite=${token}`);
  });

  it("makes the pool user for the address posted on a link invite, moves the browser on by a page with no address in any URL, and the person joins", async () => {
    const h = harness();
    const orgId = await acme(h);
    const token = await inviteTo(h, orgId);
    const start = await post(h, { invite: token, email: "Carl@X.dev" });
    expect(start.statusCode).toBe(200);
    expect(start.body).toContain('http-equiv="refresh"');
    expect(start.body).toContain("Continue");
    expect(start.cookies?.some((value) => value.startsWith(`${JOIN_COOKIE}=`))).toBe(true);
    expect(created(h).map((call) => call.input.Username)).toEqual(["carl@x.dev"]);
    expect(created(h)[0]!.input).toMatchObject({ MessageAction: "SUPPRESS" });
    expect(start.headers.location).toBeUndefined();
    for (const url of urlsIn(start)) expect(decodeURIComponent(url).toLowerCase()).not.toContain("carl");
    expect(JSON.stringify(h.logs).toLowerCase()).not.toContain("carl@x.dev");
    const done = await finish(h, start, carl);
    expect(done.headers.location).toContain("/app/welcome?joined=1");
    expect(await h.orgs.orgForDeveloper(idOf(carl))).toEqual({ orgId, role: "member" });
  });

  it("never reads an address from a query string: a GET with one makes no pool user, and the legacy-host hop does not copy it", async () => {
    const h = harness();
    const token = await inviteTo(h, await acme(h));
    const response = await get(h, `/v1/auth/join/start?invite=${token}&email=carl%40x.dev`);
    expect(response.statusCode).toBe(302);
    expect(h.cognito.calls).toHaveLength(0);
    expect(response.headers.location).not.toContain("carl");
    // The legacy host (the API's own address) forwards an invite to the custom domain: only the invite goes along.
    const legacy = createDeveloperIdentityHandler({ ...h.deps, config: { ...h.deps.config, issuer: "https://canonical.example/v1/auth", legacyIssuer: `${API}/v1/auth` } });
    for (const query of [`invite=${token}&email=carl%40x.dev`, `email=carl%40x.dev&invite=${token}`, `invite=${token}&EMAIL=carl%40x.dev`.replace("EMAIL", "email")]) {
      const event = { ...httpEvent("GET", `/v1/auth/join/start?${query}`), headers: { host: new URL(API).host, accept: "text/html" } };
      const forwarded = await legacy(event) as HttpResult;
      expect(forwarded.statusCode).toBe(302);
      expect(forwarded.headers.location).toBe(`https://canonical.example/v1/auth/join/start?invite=${token}`);
    }
  });

  it("refuses a post from another site, and refuses something that is not an email address, before any pool call", async () => {
    const h = harness();
    const token = await inviteTo(h, await acme(h));
    expect((await post(h, { invite: token, email: "carl@x.dev" }, { origin: "https://evil.example" })).statusCode).toBe(403);
    for (const typed of ["not-an-email", "k\u00e4se@x.dev", `${"a".repeat(250)}@x.dev`, ""]) {
      expect((await post(h, { invite: token, email: typed })).statusCode).toBe(400);
    }
    expect(h.cognito.calls).toHaveLength(0);
    // The page's own origin is accepted.
    expect((await post(h, { invite: token, email: "carl@x.dev" }, { origin: new URL(h.deps.config.issuer).origin })).statusCode).toBe(200);
  });

  it("accepts Origin: null (what a browser sends when it sends no Referer), and still refuses a real foreign origin", async () => {
    const h = harness();
    const token = await inviteTo(h, await acme(h));
    expect((await post(h, { invite: token, email: "carl@x.dev" }, { origin: "null" })).statusCode).toBe(200);
    expect(created(h).map((call) => call.input.Username)).toEqual(["carl@x.dev"]);
    for (const origin of ["https://evil.example", "http://abc.example", `${new URL(h.deps.config.issuer).origin}.evil.example`]) {
      expect((await post(h, { invite: token, email: "dana@x.dev" }, { origin })).statusCode).toBe(403);
    }
    expect(created(h)).toHaveLength(1);
  });

  it("without a source address only the per-invite cap applies, so requests that lack one never share a bucket", async () => {
    const h = harness();
    const orgId = await acme(h);
    let made = 0;
    for (let invite = 0; invite < 5; invite++) {
      const link = await inviteTo(h, orgId);
      for (let n = 0; n < 3; n++, made++) {
        const event = httpEvent("POST", "/v1/auth/join/start", { invite: link, email: `n${made}@x.dev` });
        expect((await h.http({ ...event, requestContext: { ...event.requestContext, http: { method: "POST" } } })).statusCode).toBe(200);
      }
      const event = httpEvent("POST", "/v1/auth/join/start", { invite: link, email: "over@x.dev" });
      expect((await h.http({ ...event, requestContext: { ...event.requestContext, http: { method: "POST" } } })).statusCode).toBe(429);
    }
    expect(created(h)).toHaveLength(15);
  });

  it("makes no pool user for an invite that cannot be used", async () => {
    const h = harness();
    const orgId = await acme(h);
    const token = await inviteTo(h, orgId, "bea@example.com");
    await h.orgs.acceptInvite({ tokenHash: inviteTokenHash(token), developerId: dev("c") });
    expect((await get(h, `/v1/auth/join/start?invite=${token}`)).statusCode).toBe(410);
    expect((await post(h, { invite: "A".repeat(43), email: "carl@x.dev" })).statusCode).toBe(404);
    expect(h.cognito.calls).toHaveLength(0);
  });

  it("a failed pool call is a retry page: nothing joined, the invite is still unused, and the slot it took is given back", async () => {
    const h = harness();
    const orgId = await acme(h);
    const token = await inviteTo(h, orgId, "bea@example.com");
    h.cognito.failNextCreate = "InternalErrorException";
    const response = await get(h, `/v1/auth/join/start?invite=${token}`);
    expect(response.statusCode).toBe(503);
    expect(h.logs).toContainEqual({ event: "signin.join_pool_user_failed", error: "InternalErrorException" });
    expect(h.state.get(orgInviteKey(sha256Hex(token)))?.acceptedAt).toBeUndefined();
    expect(h.state.get(developerOrgKey(idOf(bea)))).toBeUndefined();
    // A second open works (the pool user is made, or already there).
    expect((await get(h, `/v1/auth/join/start?invite=${token}`)).statusCode).toBe(302);
    // A typed address that failed does not use up one of the link invite's three.
    const link = await inviteTo(h, orgId);
    h.cognito.failNextCreate = "InternalErrorException";
    expect((await post(h, { invite: link, email: "a1@x.dev" })).statusCode).toBe(503);
    for (const address of ["a2@x.dev", "a3@x.dev", "a4@x.dev"]) expect((await post(h, { invite: link, email: address })).statusCode).toBe(200);
    expect((await post(h, { invite: link, email: "a5@x.dev" })).statusCode).toBe(429);
  });

  it("with the setting off nothing is asked of the pool and the page has no form (an open pool needs neither)", async () => {
    const h = harness({ on: false });
    const orgId = await acme(h);
    const link = await inviteTo(h, orgId);
    const email = await inviteTo(h, orgId, "bea@example.com");
    expect((await get(h, `/v1/auth/join?invite=${link}`)).body).not.toContain("<form");
    expect((await get(h, `/v1/auth/join/start?invite=${email}`)).statusCode).toBe(302);
    expect((await post(h, { invite: link, email: "carl@x.dev" })).statusCode).toBe(302);
    expect(h.cognito.calls).toHaveLength(0);
  });

  it("an invite does not make a company for the person: joining puts them in the inviting org and creates no other org", async () => {
    const h = harness();
    const orgId = await acme(h);
    const token = await inviteTo(h, orgId, "bea@example.com");
    await finish(h, await get(h, `/v1/auth/join/start?invite=${token}`), bea);
    expect(h.state.find((item) => item.entityType === "ORG")).toHaveLength(1);
  });

  it("when two opens race to make the same pool user, the loser makes nothing and gives its slot back", async () => {
    const h = harness();
    const link = await inviteTo(h, await acme(h));
    h.cognito.failNextCreate = "UsernameExistsException";
    expect((await post(h, { invite: link, email: "a1@x.dev" })).statusCode).toBe(200);
    for (const address of ["a2@x.dev", "a3@x.dev", "a4@x.dev"]) expect((await post(h, { invite: link, email: address })).statusCode).toBe(200);
    expect((await post(h, { invite: link, email: "a5@x.dev" })).statusCode).toBe(429);
  });

  it("a person who already has a pool user takes no slot, so opening again and again is never limited", async () => {
    const h = harness();
    const link = await inviteTo(h, await acme(h));
    for (let attempt = 0; attempt < 8; attempt++) expect((await post(h, { invite: link, email: "carl@x.dev" })).statusCode).toBe(200);
    expect(created(h)).toHaveLength(1);
  });

  it("a link invite makes at most 3 pool users a day, and the fourth is a plain 'too many tries' page that names no address and makes none", async () => {
    const h = harness();
    const orgId = await acme(h);
    const link = await inviteTo(h, orgId);
    for (const address of ["a1@x.dev", "a2@x.dev", "a3@x.dev"]) expect((await post(h, { invite: link, email: address })).statusCode).toBe(200);
    const limited = await post(h, { invite: link, email: "a4@x.dev" });
    expect(limited.statusCode).toBe(429);
    expect(limited.body).toContain("Too many tries");
    expect(limited.body).not.toContain("a4@x.dev");
    expect(created(h)).toHaveLength(3);
    expect(h.logs.filter((entry) => entry.event === "signin.join_pool_user_created").map((entry) => entry.count)).toEqual([1, 2, 3]);
    expect(JSON.stringify(h.logs)).not.toMatch(/a[1-4]@x\.dev/);
    expect(h.logs).toContainEqual({ event: "signin.join_pool_user_limited", invite: inviteTokenHash(link).slice(0, 12) });
    // Another invite is its own count; a day later the first one may make more.
    expect((await post(h, { invite: await inviteTo(h, orgId), email: "b1@x.dev" })).statusCode).toBe(200);
    h.tick(24 * 3600 * 1000);
    expect((await post(h, { invite: link, email: "a4@x.dev" })).statusCode).toBe(200);
  });

  it("one source address makes at most 10 pool users an hour across invites, and the slot an invite took is given back when the source is over", async () => {
    const h = harness();
    const orgId = await acme(h);
    const invites = [await inviteTo(h, orgId), await inviteTo(h, orgId), await inviteTo(h, orgId), await inviteTo(h, orgId)];
    let made = 0;
    for (const invite of invites) for (let n = 0; n < 3 && made < 10; n++, made++) expect((await post(h, { invite, email: `s${made}@x.dev` }, { ip: "203.0.113.9" })).statusCode).toBe(200);
    expect((await post(h, { invite: invites[3]!, email: "s10@x.dev" }, { ip: "203.0.113.9" })).statusCode).toBe(429);
    expect(created(h)).toHaveLength(10);
    // The refused one gave its invite slot back: the fourth invite still has two of its three, from another source.
    expect((await post(h, { invite: invites[3]!, email: "s11@x.dev" }, { ip: "203.0.113.10" })).statusCode).toBe(200);
    expect((await post(h, { invite: invites[3]!, email: "s12@x.dev" }, { ip: "203.0.113.10" })).statusCode).toBe(200);
    // The source's own hour passes.
    h.tick(3600 * 1000);
    expect((await post(h, { invite: invites[0]!, email: "s13@x.dev" }, { ip: "203.0.113.9" })).statusCode).toBe(429);
    expect((await post(h, { invite: await inviteTo(h, orgId), email: "s14@x.dev" }, { ip: "203.0.113.9" })).statusCode).toBe(200);
  });

  it("shows a methods page, not the meta refresh, when more than one sign-in method is on, and the join cookie is still set", async () => {
    const h = harness({ github: true });
    const token = await inviteTo(h, await acme(h));
    const response = await post(h, { invite: token, email: "carl@x.dev" });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("http-equiv");
    expect(response.body).toContain("method=cloud");
    expect(response.cookies?.some((value) => value.startsWith(`${JOIN_COOKIE}=`))).toBe(true);
    expect(created(h)).toHaveLength(1);
  });
});

describe("the CLI's invite sign-in (agentx login --invite) under invitation only", () => {
  type H = ReturnType<typeof identityHarness>;
  const harness = (on = true) => identityHarness({ cloud: {}, oidcUsers: [bea, carl], slack: false, singleOrg: false, ...(on ? { newOrgsByInvitationOnly: true, invitedUsers: true } : {}) });
  async function acme(h: H) {
    const orgId = await h.orgs.createOrgWithOwner({ name: "Acme", developerId: OWNER });
    await h.deps.store.upsertDeveloper({ developerId: OWNER, provider: "cloud", issuer: OIDC_ISSUER, subject: "owner-io", displayName: "Maya Chen" });
    return orgId;
  }
  const inviteTo = async (h: H, orgId: Parameters<H["orgs"]["createInvite"]>[0]["orgId"], email?: string) =>
    (await h.orgs.createInvite({ orgId, createdBy: OWNER, role: "member", ...(email === undefined ? {} : { email }) })).token;
  const created = (h: H) => h.cognito.calls.filter((call) => call.name === "AdminCreateUserCommand");
  const json = (h: H, token: string) => h.http({ ...httpEvent("GET", `/v1/auth/join?invite=${token}`), headers: { accept: "application/json" } });

  it("makes the pool user for the address an invite is written for before the sign-in page, and the person joins", async () => {
    const h = harness();
    const orgId = await acme(h);
    const token = await inviteTo(h, orgId, "bea@example.com");
    const back = await h.signIn("cloud", bea.sub, { query: { invite: token } });
    expect(back.searchParams.get("code")).toBeTruthy();
    expect(created(h).map((call) => call.input.Username)).toEqual(["bea@example.com"]);
    expect(created(h)[0]!.input).toMatchObject({ MessageAction: "SUPPRESS" });
    expect(await h.orgs.orgForDeveloper(idOf(bea))).toEqual({ orgId, role: "member" });
  });

  it("a failed pool call ends the CLI sign-in with a try-again answer, and nothing is joined", async () => {
    const h = harness();
    const token = await inviteTo(h, await acme(h), "bea@example.com");
    h.cognito.failNextCreate = "InternalErrorException";
    const back = await h.signIn("cloud", bea.sub, { query: { invite: token } });
    expect(back.searchParams.get("error")).toBe("temporarily_unavailable");
    expect(back.searchParams.get("code")).toBeNull();
    expect(await h.orgs.orgForDeveloper(idOf(bea))).toBeUndefined();
  });

  it("makes no pool user for a link invite or an unusable one, and with the setting off asks nothing of the pool", async () => {
    const h = harness();
    const orgId = await acme(h);
    await h.signIn("cloud", bea.sub, { query: { invite: await inviteTo(h, orgId) } });
    await h.signIn("cloud", carl.sub, { query: { invite: "A".repeat(43) } });
    expect(created(h)).toHaveLength(0);
    const off = harness(false);
    await off.signIn("cloud", bea.sub, { query: { invite: await inviteTo(off, await acme(off), "bea@example.com") } });
    expect(off.cognito.calls).toHaveLength(0);
  });

  it("the JSON of the join page tells the CLI a link invite is browser-only, and says it of no other invite", async () => {
    const on = harness();
    const orgId = await acme(on);
    expect(JSON.parse((await json(on, await inviteTo(on, orgId))).body)).toEqual({ orgName: "Acme", role: "member", state: "open", inBrowserOnly: true });
    expect(JSON.parse((await json(on, await inviteTo(on, orgId, "bea@example.com"))).body)).toEqual({ orgName: "Acme", role: "member", state: "open" });
    const off = harness(false);
    expect(JSON.parse((await json(off, await inviteTo(off, await acme(off)))).body)).toEqual({ orgName: "Acme", role: "member", state: "open" });
  });
});
