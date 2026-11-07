// Plan 2, Task 5: the invite join page on the cell. The public pages for an invite link, the sign-in that carries it, and the
// "done" page that reports what happened. An invite is consumed only when the person joined; every other outcome creates no
// org, member, DEVELOPER_ORG# item, session or code (Review Focus 2, I8).
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { developerOrgKey, orgInviteKey } from "@agentx/contracts";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { maskEmail } from "../../packages/broker/src/developer/join-page.js";
import { inviteTokenHash } from "../../packages/broker/src/org/invite-url.js";
import { sha256Hex } from "../../packages/broker/src/developer/tokens.js";
import { MAYA, createDeveloperTaskBroker, seedMembership, DEV_ISSUER } from "../support/developer-task-broker.js";
import { API, ISSUER, OIDC_ISSUER, T0, httpEvent, identityHarness, type FakeOidcUser } from "../support/developer-fakes.js";
import { TEST_ORG } from "../support/orgs.js";
import type { HttpApiV2Event } from "../../packages/broker/src/aws/lambda.js";
import type { HttpResult } from "../../packages/broker/src/developer/server.js";

const JOIN_COOKIE = "__Host-rovara_join_pkce";
const REVIEW_COOKIE = "__Host-agentx_review_pkce";
const bea: FakeOidcUser = { sub: "bea-1", name: "Bea Ortiz", email: "bea@example.com", email_verified: true };
const carl: FakeOidcUser = { sub: "carl-1", name: "Carl Wu", email: "carl@x.dev", email_verified: true };
const dana: FakeOidcUser = { sub: "dana-1", name: "Dana Roe", email: "b@x.dev", email_verified: true };
const idOf = (user: FakeOidcUser) => ownerKeyForSubject(OIDC_ISSUER, user.sub);
const OWNER = "f".repeat(64);

const entities = (text: string) => text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&");
/** The page's visible copy: its heading and each paragraph, unescaped. */
function copy(response: { body: string }): { title: string; paragraphs: string[]; hrefs: string[]; labels: string[] } {
  const title = /<h1>(.*?)<\/h1>/s.exec(response.body)?.[1] ?? "";
  return {
    title: entities(title),
    paragraphs: [...response.body.matchAll(/<p>(.*?)<\/p>/gs)].map((match) => entities(match[1]!)),
    hrefs: [...response.body.matchAll(/<a [^>]*href="([^"]*)"/g)].map((match) => entities(match[1]!)),
    labels: [...response.body.matchAll(/<a [^>]*>(.*?)<\/a>/gs)].map((match) => entities(match[1]!)),
  };
}

type Harness = ReturnType<typeof identityHarness>;
const withCookie = (event: HttpApiV2Event, cookie: string | undefined): HttpApiV2Event => (cookie === undefined ? event : { ...event, headers: { ...event.headers, cookie } });
const get = (h: Harness, path: string, cookie?: string): Promise<HttpResult> => h.http(withCookie(httpEvent("GET", path), cookie));

/** An org named `name` owned by OWNER, whose display name is "Maya Chen" in the sign-in table. */
async function acme(h: Harness, name = "Acme") {
  const orgId = await h.orgs.createOrgWithOwner({ name, developerId: OWNER });
  await h.deps.store.upsertDeveloper({ developerId: OWNER, provider: "cloud", issuer: OIDC_ISSUER, subject: "owner-1", displayName: "Maya Chen" });
  return orgId;
}
async function inviteTo(h: Harness, orgId: Parameters<Harness["orgs"]["createInvite"]>[0]["orgId"], extra: { role?: "admin" | "member"; email?: string; ttlSeconds?: number; createdBy?: string } = {}) {
  const { createdBy, ...rest } = extra;
  return (await h.orgs.createInvite({ orgId, createdBy: createdBy ?? OWNER, role: "member", ...rest })).token;
}

/** Start the join as a browser would: the cookie it is given, and the provider URL it is sent to. */
async function startJoin(h: Harness, token: string, method = "cloud") {
  let response = await get(h, `/v1/auth/join/start?invite=${token}`);
  const cookie = (response.cookies ?? []).find((value) => value.startsWith(`${JOIN_COOKIE}=`));
  if (response.statusCode === 200) {
    const link = new RegExp(`href="([^"]*method=${method})"`).exec(response.body)?.[1];
    if (link === undefined) throw new Error("test setup: no method link");
    response = await get(h, link.replaceAll("&amp;", "&"));
  }
  if (response.statusCode !== 302) throw new Error(`test setup: start answered ${response.statusCode}`);
  return { providerUrl: response.headers.location!, cookie: cookie?.split(";")[0], setCookie: cookie };
}
/** Sign in at the provider as `user`, follow the callback, then open the done page when the callback pointed at one. */
async function joinAs(h: Harness, token: string, user: FakeOidcUser, options: { cookie?: string | null; between?: () => void | Promise<void> } = {}) {
  const started = await startJoin(h, token);
  await options.between?.();
  const cookie = options.cookie === undefined ? started.cookie : options.cookie ?? undefined;
  const callback = await get(h, h.oidc.approve(started.providerUrl, user.sub), cookie);
  const location = callback.headers.location;
  const done = callback.statusCode === 302 && location !== undefined ? await get(h, new URL(location, API).pathname + new URL(location, API).search, cookie) : undefined;
  return { started, callback, done, doneUrl: location };
}

/** UX1: a join that worked ends in the app: a redirect to the welcome page on the sign-in server's own origin, with the join cookie cleared and nothing else set. */
function expectLanded(done: HttpResult | undefined) {
  expect(done?.statusCode).toBe(302);
  expect(done!.headers.location).toBe(`${new URL(ISSUER).origin}/app/welcome?joined=1`);
  expect(done!.cookies).toEqual([`${JOIN_COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`]);
}
const everything = (h: Harness) => JSON.stringify([...h.db.find(() => true), ...h.state.find(() => true)]);
const personItems = (h: Harness, id: string) => ({
  pointer: h.state.get(developerOrgKey(id)),
  members: h.state.find((item) => item.entityType === "ORG_MEMBER" && item.developerId === id),
  sessions: h.db.find((item) => String(item.pk).startsWith("SESSION#") || String(item.pk).startsWith("CODE#") || String(item.pk).startsWith("REFRESH#")),
});

describe("GET /v1/auth/join", () => {
  it("shows an open invite with its status 200, the exact copy and a button into the sign-in", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [] });
    const orgId = await acme(h);
    const token = await inviteTo(h, orgId);
    const response = await get(h, `/v1/auth/join?invite=${token}`);
    expect(response.statusCode).toBe(200);
    const page = copy(response);
    expect(page.title).toBe("Join Acme on Rovara");
    expect(page.paragraphs).toEqual([
      "Maya Chen invited you to join Acme as a member.",
      // UX1: a browser page shows no terminal command (the CLI reads the JSON form of this address).
      "Sign in on the next page to join. No new company is created.",
    ]);
    expect(response.body).not.toContain("agentx");
    expect(page.labels).toEqual(["Join Acme"]);
    expect(page.hrefs).toEqual([`${ISSUER}/join/start?invite=${token}`]);
    expect(response.headers["content-security-policy"]).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("reads an admin invite as 'an admin', names the masked address of an email-targeted invite, and says Someone for an unknown creator", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [] });
    const orgId = await acme(h);
    const token = await inviteTo(h, orgId, { role: "admin", email: "priya@acme.dev" });
    h.db.delete({ pk: `DEVELOPER#${OWNER}`, sk: "META" });
    const page = copy(await get(h, `/v1/auth/join?invite=${token}`));
    expect(page.paragraphs.slice(0, 2)).toEqual(["Someone invited you to join Acme as an admin.", "This invite is for p•••@acme.dev. Sign in with that address on the next page to join."]);
  });

  it("answers 410 for an expired invite", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [] });
    const orgId = await acme(h);
    const token = await inviteTo(h, orgId, { ttlSeconds: 60 });
    h.tick(61_000);
    const response = await get(h, `/v1/auth/join?invite=${token}`);
    expect(response.statusCode).toBe(410);
    expect(copy(response)).toMatchObject({ title: "This invite has expired", paragraphs: ["Invites last seven days. Ask Maya Chen to send you a new invite from Administration, Invites."], hrefs: ["/app/signup"], labels: ["Go to Rovara"] });
  });

  it("answers 410 for a used invite", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [] });
    const orgId = await acme(h);
    const token = await inviteTo(h, orgId);
    await h.orgs.acceptInvite({ tokenHash: inviteTokenHash(token), developerId: "c".repeat(64) });
    const response = await get(h, `/v1/auth/join?invite=${token}`);
    expect(response.statusCode).toBe(410);
    expect(copy(response)).toMatchObject({ title: "This invite was already used", paragraphs: ["Each invite works once. If you already joined, open Rovara and sign in. Otherwise ask Maya Chen for a new invite."], hrefs: ["/app"], labels: ["Open Rovara"] });
  });

  it.each([["an unknown token", "A".repeat(43)], ["a malformed one", "short"], ["none at all", ""]])("answers 404 for %s", async (_name, token) => {
    const h = identityHarness({ cloud: {}, oidcUsers: [] });
    const response = await get(h, token === "" ? "/v1/auth/join" : `/v1/auth/join?invite=${token}`);
    expect(response.statusCode).toBe(404);
    expect(copy(response)).toMatchObject({ title: "This invite link isn't valid", paragraphs: ["Check that you copied the whole link, or ask the person who invited you for a new invite."], hrefs: ["/app/signup"], labels: ["Go to Rovara"] });
  });

  it("escapes an org named with markup, in the title, the copy and the button", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [] });
    const orgId = await acme(h, "<script>x</script>");
    const token = await inviteTo(h, orgId);
    const response = await get(h, `/v1/auth/join?invite=${token}`);
    expect(response.body).not.toContain("<script>");
    expect(response.body).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(copy(response).title).toBe("Join <script>x</script> on Rovara");
  });
});

describe("GET /v1/auth/join as JSON (agentx login --invite)", () => {
  const getJson = (h: Harness, path: string, accept = "application/json"): Promise<HttpResult> => h.http({ ...httpEvent("GET", path), headers: { accept } });

  it("answers an open invite with its organization and role, and nothing else", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [] });
    const orgId = await acme(h);
    const token = await inviteTo(h, orgId, { role: "admin", email: "priya@acme.dev" });
    const response = await getJson(h, `/v1/auth/join?invite=${token}`);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ orgName: "Acme", role: "admin", state: "open" });
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers.vary).toBe("accept");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    for (const secret of [token, "priya", "Maya", "acme.dev", OWNER]) expect(response.body).not.toContain(secret);
  });

  it("answers an expired invite 410 and a used one 410, with only the state", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [] });
    const orgId = await acme(h);
    const expired = await inviteTo(h, orgId, { ttlSeconds: 60 });
    const used = await inviteTo(h, orgId);
    await h.orgs.acceptInvite({ tokenHash: inviteTokenHash(used), developerId: "c".repeat(64) });
    h.tick(61_000);
    const first = await getJson(h, `/v1/auth/join?invite=${expired}`);
    const second = await getJson(h, `/v1/auth/join?invite=${used}`);
    expect([first.statusCode, JSON.parse(first.body)]).toEqual([410, { state: "expired" }]);
    expect([second.statusCode, JSON.parse(second.body)]).toEqual([410, { state: "used" }]);
  });

  it.each([["an unknown token", "A".repeat(43)], ["a malformed one", "short"], ["none at all", ""]])("answers 404 with state unknown for %s", async (_name, token) => {
    const h = identityHarness({ cloud: {}, oidcUsers: [] });
    const response = await getJson(h, token === "" ? "/v1/auth/join" : `/v1/auth/join?invite=${token}`);
    expect([response.statusCode, JSON.parse(response.body)]).toEqual([404, { state: "unknown" }]);
  });

  it("gives the page to a browser, and to a request that does not ask for JSON", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [] });
    const orgId = await acme(h);
    const token = await inviteTo(h, orgId);
    for (const accept of ["text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8", "*/*", "text/html"]) {
      const response = await getJson(h, `/v1/auth/join?invite=${token}`, accept);
      expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    }
    expect((await get(h, `/v1/auth/join?invite=${token}`)).headers["content-type"]).toBe("text/html; charset=utf-8");
  });

  it("creates and changes nothing", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [] });
    const orgId = await acme(h);
    const token = await inviteTo(h, orgId);
    const before = everything(h);
    await getJson(h, `/v1/auth/join?invite=${token}`);
    expect(everything(h)).toBe(before);
  });
});

describe("the join sign-in", () => {
  it("joins a new cloud identity: the done page says so, the invite is used, the person is a member, and a browser session exists without a CLI code", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [bea], slack: false });
    const orgId = await acme(h);
    const token = await inviteTo(h, orgId);
    const { callback, done, started } = await joinAs(h, token, bea);
    expect(started.setCookie).toMatch(new RegExp(`^${JOIN_COOKIE}=[A-Za-z0-9_-]{43}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600$`));
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toMatch(new RegExp(`^${ISSUER}/join/done\\?request=[A-Za-z0-9_-]+$`));
    // UX1: the person who joined lands in the app at once, on the same origin as the join's sign-in cookie; the join cookie is spent.
    expectLanded(done);
    expect(h.state.get(orgInviteKey(sha256Hex(token)))).toMatchObject({ acceptedBy: idOf(bea) });
    expect(h.state.get(orgInviteKey(sha256Hex(token)))?.acceptedAt).toBeDefined();
    expect(await h.orgs.orgForDeveloper(idOf(bea))).toEqual({ orgId, role: "member" });
    expect(personItems(h, idOf(bea)).sessions.filter(item => String(item.pk).startsWith("SESSION#"))).toHaveLength(1);
    expect(personItems(h, idOf(bea)).sessions.filter(item => String(item.pk).startsWith("CODE#"))).toHaveLength(0);
    const sessionCookie = callback.cookies?.find(value => value.startsWith("__Host-agentx_review_session="));
    expect(sessionCookie).toMatch(/; Secure; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000$/);
  });

  it("with several sign-in methods shows the chooser (with the cookie set) and still joins", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [bea] });
    const orgId = await acme(h);
    const token = await inviteTo(h, orgId, { role: "admin" });
    const chooser = await get(h, `/v1/auth/join/start?invite=${token}`);
    expect(chooser.statusCode).toBe(200);
    expect(chooser.cookies?.[0]).toMatch(new RegExp(`^${JOIN_COOKIE}=`));
    expect(copy(chooser).title).toBe("Sign in to Rovara");
    expect(copy(chooser).labels).toEqual(["Sign in with Slack", "Sign in with Rovara"]);
    const { done } = await joinAs(h, token, bea);
    expectLanded(done);
    expect(await h.orgs.orgForDeveloper(idOf(bea))).toEqual({ orgId, role: "admin" });
  });

  it("start shows the invite's own page for a dead or unknown invite and sets no cookie", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [bea], slack: false });
    const orgId = await acme(h);
    const used = await inviteTo(h, orgId);
    await h.orgs.acceptInvite({ tokenHash: inviteTokenHash(used), developerId: "c".repeat(64) });
    const usedPage = await get(h, `/v1/auth/join/start?invite=${used}`);
    expect([usedPage.statusCode, copy(usedPage).title, usedPage.cookies]).toEqual([410, "This invite was already used", undefined]);
    const unknown = await get(h, `/v1/auth/join/start?invite=${"A".repeat(43)}`);
    expect([unknown.statusCode, unknown.cookies]).toEqual([404, undefined]);
    expect(h.db.find((item) => item.entityType === "AUTH_REQUEST")).toHaveLength(0);
  });

  it("already in another org (Review Focus 2): the done page names both orgs and the invite stays unused", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [bea], slack: false });
    const acmeId = await acme(h);
    const own = await h.orgs.createOrgWithOwner({ name: "Bea's team", developerId: idOf(bea) });
    const token = await inviteTo(h, acmeId);
    const { done } = await joinAs(h, token, bea);
    expect(done?.statusCode).toBe(200);
    expect(copy(done!)).toMatchObject({
      title: "You're already in Bea's team",
      paragraphs: [
        "A person belongs to one Rovara company at a time. You can keep using Bea's team, or leave it and then open this invite again to join Acme.",
        "If you are the last owner of Bea's team, leaving closes it. The invite stays valid until it expires.",
      ],
      // UX1: a clear choice, not a dead end: keep the company, or open the account menu on its Leave step.
      labels: ["Keep using Bea's team", "Leave Bea's team to join Acme"],
      hrefs: [`${new URL(API).origin}/app`, `${new URL(API).origin}/app?account=leave`],
    });
    expect(h.state.get(orgInviteKey(sha256Hex(token)))?.acceptedAt).toBeUndefined();
    expect(await h.orgs.orgForDeveloper(idOf(bea))).toEqual({ orgId: own, role: "owner" });
    expect(personItems(h, idOf(bea)).sessions).toHaveLength(0);
  });

  it("an invite for another email shows the wrong-email page and leaves the person with no org, member, pointer or session", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [dana], slack: false });
    const orgId = await acme(h);
    const token = await inviteTo(h, orgId, { email: "a@x.dev" });
    const orgsBefore = h.state.find((item) => item.entityType === "ORG").length;
    const { done } = await joinAs(h, token, dana);
    expect(done?.statusCode).toBe(200);
    expect(copy(done!)).toMatchObject({ title: "This invite is for a different email", paragraphs: ["It was sent to a•••@x.dev. Open the invite again and sign in with that address, or ask Maya Chen for an invite to yours."], labels: ["Go to Rovara"] });
    expect(h.state.get(orgInviteKey(sha256Hex(token)))?.acceptedAt).toBeUndefined();
    const items = personItems(h, idOf(dana));
    expect(items.pointer).toBeUndefined();
    expect(items.members).toHaveLength(0);
    expect(items.sessions).toHaveLength(0);
    expect(h.state.find((item) => item.entityType === "ORG")).toHaveLength(orgsBefore);
    // Only the inviting owner has a DEVELOPER_ORG# pointer.
    expect(h.state.find((item) => String(item.pk).startsWith("DEVELOPER_ORG#")).map((item) => item.pk)).toEqual([developerOrgKey(OWNER).pk]);
    expect(h.state.find((item) => item.entityType === "ORG_EMAIL")).toHaveLength(0);
  });

  it("wrong email, then the right invite (I8): the same person joins, not ALREADY_IN_ORG", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [dana], slack: false });
    const orgId = await acme(h);
    const wrong = await inviteTo(h, orgId, { email: "a@x.dev" });
    const right = await inviteTo(h, orgId, { email: "b@x.dev", role: "admin" });
    expect(copy((await joinAs(h, wrong, dana)).done!).title).toBe("This invite is for a different email");
    const second = await joinAs(h, right, dana);
    expectLanded(second.done);
    expect(await h.orgs.orgForDeveloper(idOf(dana))).toEqual({ orgId, role: "admin" });
    expect(h.state.get(orgInviteKey(sha256Hex(wrong)))?.acceptedAt).toBeUndefined();
  });

  it("an invite used between the page and the sign-in shows 'can no longer be used' and creates nothing", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [bea], slack: false });
    const orgId = await acme(h);
    const token = await inviteTo(h, orgId);
    const started = await startJoin(h, token);
    await h.orgs.acceptInvite({ tokenHash: inviteTokenHash(token), developerId: "c".repeat(64) });
    const callback = await get(h, h.oidc.approve(started.providerUrl, bea.sub), started.cookie);
    const done = await get(h, new URL(callback.headers.location!, API).pathname + new URL(callback.headers.location!, API).search, started.cookie);
    expect(copy(done)).toMatchObject({ title: "This invite can no longer be used", paragraphs: ["It expired, was revoked or was already used. Ask Maya Chen for a new invite."] });
    expect(personItems(h, idOf(bea)).pointer).toBeUndefined();
    expect(personItems(h, idOf(bea)).members).toHaveLength(0);
  });

  it("an invite into an org that closed shows 'can no longer be used'", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [bea], slack: false });
    const orgId = await acme(h);
    const token = await inviteTo(h, orgId);
    await h.orgs.closeOrg(orgId, { archiveProjects: async () => undefined, clearEgress: async () => undefined });
    const { done } = await joinAs(h, token, bea);
    expect(copy(done!).title).toBe("This invite can no longer be used");
    expect(personItems(h, idOf(bea)).pointer).toBeUndefined();
  });

  it("does not join the install's single org or create a trial org when the invite expires mid-sign-in", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [bea], slack: false });
    const orgId = await acme(h);
    const token = await inviteTo(h, orgId, { ttlSeconds: 60 });
    const orgsBefore = h.state.find((item) => item.entityType === "ORG").length;
    const { done } = await joinAs(h, token, bea, { between: () => h.tick(61_000) });
    expect(copy(done!).title).toBe("This invite can no longer be used");
    expect(copy(done!).paragraphs).toEqual(["It expired, was revoked or was already used. Ask Maya Chen for a new invite."]);
    expect(h.state.find((item) => item.entityType === "ORG")).toHaveLength(orgsBefore);
    expect(personItems(h, idOf(bea)).pointer).toBeUndefined();
  });

  it("refuses a malformed invite at start with the 404 page and no sign-in request", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [bea], slack: false });
    const response = await get(h, "/v1/auth/join/start?invite=short");
    expect(response.statusCode).toBe(404);
    expect(h.db.find((item) => item.entityType === "AUTH_REQUEST")).toHaveLength(0);
  });

  it("the callback without this browser's join cookie creates nothing and does not accept the invite", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [bea], slack: false });
    const orgId = await acme(h);
    const token = await inviteTo(h, orgId);
    const { callback } = await joinAs(h, token, bea, { cookie: null });
    expect(callback.statusCode).toBe(400);
    expect(h.state.get(orgInviteKey(sha256Hex(token)))?.acceptedAt).toBeUndefined();
    expect(personItems(h, idOf(bea)).pointer).toBeUndefined();
    expect(h.db.find((item) => typeof item.pk === "string" && item.pk.startsWith("JOIN_RESULT#"))).toHaveLength(0);
  });
});

describe("GET /v1/auth/join/done", () => {
  async function joined() {
    const h = identityHarness({ cloud: {}, oidcUsers: [bea], slack: false });
    const orgId = await acme(h);
    const token = await inviteTo(h, orgId);
    const result = await joinAs(h, token, bea);
    return { h, ...result, path: new URL(result.doneUrl!, API).pathname + new URL(result.doneUrl!, API).search };
  }
  const refused = { title: "This page belongs to another browser", paragraphs: ["Open the invite link again in this browser to finish joining."] };

  it("is 400 without the join cookie, with only the review cookie, and with another browser's verifier", async () => {
    const { h, path, started } = await joined();
    for (const cookie of [undefined, `${REVIEW_COOKIE}=${started.cookie!.slice(JOIN_COOKIE.length + 1)}`, `${JOIN_COOKIE}=${"x".repeat(43)}`, `${JOIN_COOKIE}=`]) {
      const response = await get(h, path, cookie);
      expect(response.statusCode, String(cookie)).toBe(400);
      expect(copy(response), String(cookie)).toMatchObject(refused);
    }
    // The browser that started it lands in the app (UX1).
    expect((await get(h, path, started.cookie)).statusCode).toBe(302);
  });

  it("is the same 400 for an unknown or malformed request id", async () => {
    const { h, started } = await joined();
    for (const path of ["/v1/auth/join/done", "/v1/auth/join/done?request=short", `/v1/auth/join/done?request=${"A".repeat(43)}`]) {
      const response = await get(h, path, started.cookie);
      expect([response.statusCode, copy(response).title]).toEqual([400, refused.title]);
    }
  });

  it("is gone once the result's ten minutes pass", async () => {
    const { h, path, started } = await joined();
    h.tick(601_000);
    expect((await get(h, path, started.cookie)).statusCode).toBe(400);
  });
});

describe("what is stored and logged", () => {
  it("never stores the raw invite token, and logs neither it nor a request id", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [bea, carl], slack: false });
    const acmeId = await acme(h);
    const own = await h.orgs.createOrgWithOwner({ name: "Bea's team", developerId: idOf(bea) });
    expect(own).toBeDefined();
    const targeted = await inviteTo(h, acmeId, { email: "zed@x.dev" });
    const open = await inviteTo(h, acmeId);
    const expiring = await inviteTo(h, acmeId, { ttlSeconds: 60 });
    const results = [await joinAs(h, open, carl), await joinAs(h, targeted, bea), await joinAs(h, expiring, bea, { between: () => h.tick(61_000) })];
    const stored = everything(h);
    for (const token of [open, targeted, expiring]) expect(stored).not.toContain(token);
    expect(stored).toContain(inviteTokenHash(open));
    const logged = JSON.stringify(h.logs);
    for (const token of [open, targeted, expiring]) expect(logged).not.toContain(token);
    for (const result of results) expect(logged).not.toContain(new URL(result.doneUrl!, API).searchParams.get("request")!);
    // Every join auth request carries the hash, never the token, and says what it is for.
    const requests = h.db.find((item) => item.entityType === "AUTH_REQUEST");
    expect(requests).toHaveLength(3);
    for (const request of requests) expect(request).toMatchObject({ purpose: "join", inviteTokenHash: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as string });
    expect(requests.map((request) => request.inviteTokenHash).sort()).toEqual([open, targeted, expiring].map(inviteTokenHash).sort());
    expect(requests.every((request) => request.inviteToken === undefined)).toBe(true);
  });

  it("stores a join result for ten minutes under JOIN_RESULT#<request>, with the page's facts and no secret", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [dana], slack: false });
    const orgId = await acme(h);
    const token = await inviteTo(h, orgId, { email: "a@x.dev", role: "admin" });
    const { doneUrl } = await joinAs(h, token, dana);
    const id = new URL(doneUrl!, API).searchParams.get("request")!;
    const stored = h.db.get(`JOIN_RESULT#${id}`, "META");
    expect(stored).toMatchObject({
      outcome: "INVITE_WRONG_EMAIL", orgName: "Acme", role: "admin", invitedOrgName: "Acme", maskedEmail: "a•••@x.dev", inviterName: "Maya Chen",
      expiresAt: Math.floor(T0 / 1000) + 600,
    });
    expect(stored).not.toHaveProperty("currentOrgName");
    expect(JSON.stringify(stored)).not.toContain("a@x.dev");
    expect(await h.deps.store.getJoinResult(id)).toMatchObject({ outcome: "INVITE_WRONG_EMAIL" });
    h.tick(601_000);
    expect(await h.deps.store.getJoinResult(id)).toBeUndefined();
  });
});

describe("OrgStore.describeInvite", () => {
  it("describes an open, expired and used invite, and nothing for an unknown token", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [] });
    const orgId = await acme(h);
    const open = await inviteTo(h, orgId, { email: "Priya@Acme.dev", role: "admin" });
    expect(await h.orgs.describeInvite(open)).toEqual({ orgId, orgName: "Acme", role: "admin", createdBy: OWNER, email: "priya@acme.dev", state: "open" });
    const short = await inviteTo(h, orgId, { ttlSeconds: 10 });
    h.tick(11_000);
    expect(await h.orgs.describeInvite(short)).toMatchObject({ state: "expired" });
    await h.orgs.acceptInvite({ tokenHash: inviteTokenHash(open), developerId: "c".repeat(64) });
    expect(await h.orgs.describeInvite(open)).toMatchObject({ state: "used" });
    expect(await h.orgs.describeInvite("A".repeat(43))).toBeUndefined();
    expect(await h.orgs.describeInvite("not a token")).toBeUndefined();
  });
});

describe("maskEmail", () => {
  it("keeps the first character and the domain", () => {
    expect(maskEmail("priya@acme.dev")).toBe("p•••@acme.dev");
    expect(maskEmail("a@x.dev")).toBe("a•••@x.dev");
  });
});

describe("the invite link a cell hands out", () => {
  async function inviteLink(extra: Parameters<typeof createDeveloperTaskBroker>[0] = {}, brokerExtra?: Record<string, unknown>) {
    const harness = await createDeveloperTaskBroker({ ...extra, ...(brokerExtra === undefined ? {} : { brokerExtra }) });
    seedMembership(harness.db, MAYA.developerId, { orgId: TEST_ORG, role: "owner" });
    const created = await harness.dev(MAYA, "POST", "/v1/dev/org/invites", { requestId: randomUUID(), role: "member" });
    expect(created.status).toBe(200);
    return String(created.body.inviteUrl);
  }

  it("points a private install's link at its own cell, with the token in the query", async () => {
    const link = await inviteLink();
    expect(link).toMatch(new RegExp(`^${DEV_ISSUER}/join\\?invite=[A-Za-z0-9_-]{43}$`));
  });

  // UX1: the app's own origin serves /join, so a cloud link no longer depends on the rovara.dev forwarder or the web origin setting.
  it("points a cloud install's link at the app's own origin, with the token in the fragment", async () => {
    const origin = new URL(DEV_ISSUER).origin.replaceAll(".", "\\.");
    expect(await inviteLink({}, { cloud: true })).toMatch(new RegExp(`^${origin}/join#invite=[A-Za-z0-9_-]{43}$`));
    expect(await inviteLink({ developerExtra: { webOrigin: "http://localhost:3000" } }, { cloud: true })).toMatch(new RegExp(`^${origin}/join#invite=`));
  });
});

describe("the invite token hash", () => {
  it("is the SHA-256 of the token in base64url", () => {
    expect(inviteTokenHash("abc")).toBe(createHash("sha256").update("abc").digest("base64url"));
  });
});
