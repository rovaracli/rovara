// Plan 2, Task 8b: a fresh sign-in before a sign-in method is removed, and adding a removed one back (human decision 2026-10-21).
// Fresh: the person signed in interactively within the last 10 minutes, with a method that is not the one being removed. A refresh
// renewal never counts. Adding back: the identity links only to the developer it was unlinked from, and only while that developer has a
// fresh session.
import type { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StartIdentityLinkRequest, UnlinkIdentityRequest } from "@agentx/contracts";
import { FRESH_SIGN_IN_SECONDS } from "@agentx/contracts";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import {
  DeveloperSignInStore, REAUTH_SAME_METHOD, REAUTH_TO_CHANGE_METHODS, RELINK_ALREADY, RELINK_NOT_REMOVED, RELINK_OWN_ACCOUNT, developerIdentityKey, isFreshSignIn,
  signInIdentityKey,
} from "../../packages/broker/src/developer/store.js";
import { T0, authorizeQuery, httpEvent, identityHarness, type FakeGithubUser, type FakeOidcUser } from "../support/developer-fakes.js";
import { brokerCall } from "../support/identity-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const GITHUB_ISSUER = "https://github.com";
const OIDC_ISSUER = "https://idp.example.test";
const FROM = "Rovara <signin@rovara.dev>";
const CELL = "https://rovara.dev";
const priya: FakeOidcUser = { sub: "priya-cloud-1", name: "Priya Rao", email: "priya@acme.dev", email_verified: true };
const zed: FakeOidcUser = { sub: "zed-cloud-1", name: "Zed Ito", email: "zed@other.dev", email_verified: true };
const octo: FakeGithubUser = { id: 4711, login: "octo", name: "Priya R.", emails: [{ email: "priya@acme.dev", primary: true, verified: true }] };
const githubId = ownerKeyForSubject(GITHUB_ISSUER, "4711");
const cloudId = ownerKeyForSubject(OIDC_ISSUER, priya.sub);
const zedId = ownerKeyForSubject(OIDC_ISSUER, zed.sub);
const WINDOW_MS = FRESH_SIGN_IN_SECONDS * 1000;

type Harness = ReturnType<typeof identityHarness>;
const claimsOf = (accessToken: unknown) => JSON.parse(Buffer.from(String(accessToken).split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;

beforeEach(() => { vi.useFakeTimers({ now: T0, toFake: ["Date"] }); });
afterEach(() => { vi.useRealTimers(); });

/** Moves the sign-in server's clock and the broker's together. */
function advance(h: Harness, ms: number): void {
  h.tick(ms);
  vi.setSystemTime(Date.now() + ms);
}

async function signIn(h: Harness, method: "cloud" | "github", who: string): Promise<{ claims: Record<string, unknown>; token: string; refresh: string; location: URL }> {
  const location = await h.signIn(method, who);
  const code = location.searchParams.get("code");
  if (code === null) return { claims: {}, token: "", refresh: "", location };
  const exchanged = await h.exchange(code);
  expect(exchanged.status).toBe(200);
  return { claims: claimsOf(exchanged.body.access_token), token: String(exchanged.body.access_token), refresh: String(exchanged.body.refresh_token), location };
}

/** A fake SES client that records the commands it was sent, and can be told to fail. */
function fakeSes(failWith?: Error) {
  const sent: SendEmailCommand[] = [];
  return {
    sent,
    client: { send: vi.fn(async (command: unknown) => { if (failWith !== undefined) throw failWith; sent.push(command as SendEmailCommand); return { MessageId: "m-1" }; }) } as never,
  };
}

/** How a refusal reads on the page the person sees: a sentence. */
const sentence = (words: string) => `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
const errorOf = (answer: { body: Record<string, unknown> }) => answer.body.error as { code: string; message: string };

/** GitHub first (the account's own sign-in), then the same person's email code, linked to it. */
async function twoMethods(options: { ses?: ReturnType<typeof fakeSes>; extraUsers?: FakeOidcUser[] } = {}) {
  const h = identityHarness({
    cloud: {}, oidcUsers: [priya, ...(options.extraUsers ?? [])], github: { users: [octo] },
    ...(options.ses === undefined ? {} : { notice: { ses: options.ses.client, from: FROM, cellUrl: CELL } }),
  });
  const github = await signIn(h, "github", "4711");
  const cloud = await signIn(h, "cloud", priya.sub);
  expect(github.claims.sub).toBe(githubId);
  expect(cloud.claims).toMatchObject({ sub: githubId, amr: "cloud" });
  return { h, github, cloud };
}

describe("isFreshSignIn", () => {
  const at = (ms: number) => new Date(T0 + ms).toISOString();
  it("is fresh for 10 minutes from the interactive sign-in, inclusive, and never before it was known", () => {
    expect(FRESH_SIGN_IN_SECONDS).toBe(600);
    expect(isFreshSignIn({ authTime: at(0) }, T0)).toBe(true);
    expect(isFreshSignIn({ authTime: at(0) }, T0 + WINDOW_MS)).toBe(true);
    expect(isFreshSignIn({ authTime: at(0) }, T0 + WINDOW_MS + 1)).toBe(false);
  });
  it("fails closed on a session with no authTime or an unreadable one", () => {
    expect(isFreshSignIn({}, T0)).toBe(false);
    expect(isFreshSignIn({ authTime: "yesterday" }, T0)).toBe(false);
    expect(isFreshSignIn({ authTime: "" }, T0)).toBe(false);
  });
});

describe("a session records when the person signed in interactively", () => {
  it("authTime is the time of the sign-in itself, not of the code's redemption, and a refresh renewal never changes it", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [priya] });
    const location = await h.signIn("cloud", priya.sub);
    advance(h, 30_000);
    const exchanged = await h.exchange(location.searchParams.get("code")!);
    expect(exchanged.status).toBe(200);
    const sessionId = String(claimsOf(exchanged.body.access_token).sid);
    const signedInAt = new Date(T0).toISOString();
    expect(h.db.get(`SESSION#${sessionId}`, "META")).toMatchObject({ authTime: signedInAt, startedAt: new Date(T0 + 30_000).toISOString() });

    advance(h, WINDOW_MS + 60_000);
    expect((await h.refresh(String(exchanged.body.refresh_token))).status).toBe(200);
    const after = h.db.get(`SESSION#${sessionId}`, "META")!;
    expect(after).toMatchObject({ authTime: signedInAt });
    expect(after.lastRefreshAt).toBeDefined();
  });
});

describe("the CLI's fresh sign-in", () => {
  it("leaves the method being removed out of the choices: with one left, it goes straight to that provider; without the parameter both are offered", async () => {
    const h = identityHarness({ slack: false, cloud: {}, oidcUsers: [priya], github: { users: [octo] } });
    const both = await h.http(httpEvent("GET", authorizeQuery()));
    expect(both.statusCode).toBe(200);
    expect(both.body).toContain("method=cloud");
    expect(both.body).toContain("method=github");
    const withoutGithub = await h.http(httpEvent("GET", authorizeQuery({ exclude_method: "github" })));
    expect(withoutGithub.statusCode).toBe(302);
    expect(withoutGithub.headers.location).toMatch(/^https:\/\/idp\.example\.test\/authorize\?/);
    const withoutCloud = await h.http(httpEvent("GET", authorizeQuery({ exclude_method: "cloud" })));
    expect(withoutCloud.statusCode).toBe(302);
    expect(withoutCloud.headers.location).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
    // Leaving out the only method there is leaves it in: the server still decides who is fresh.
    const only = identityHarness({ slack: false, cloud: {}, oidcUsers: [priya] });
    expect((await only.http(httpEvent("GET", authorizeQuery({ exclude_method: "cloud" })))).statusCode).toBe(302);
  });

  it("asks the email-code provider to prompt for a sign-in again (fresh=1), and only then", async () => {
    const h = identityHarness({ slack: false, cloud: {}, oidcUsers: [priya] });
    const plain = await h.http(httpEvent("GET", authorizeQuery()));
    expect(new URL(plain.headers.location!).searchParams.get("prompt")).toBeNull();
    const fresh = await h.http(httpEvent("GET", authorizeQuery({ fresh: "1" })));
    expect(new URL(fresh.headers.location!).searchParams.get("prompt")).toBe("login");
    // The choice page keeps it: the request remembers that the sign-in must be fresh.
    const many = identityHarness({ slack: false, cloud: {}, oidcUsers: [priya], github: { users: [octo] } });
    const page = await many.http(httpEvent("GET", authorizeQuery({ fresh: "1" })));
    const link = /href="([^"]*method=cloud)"/.exec(page.body)![1]!.replaceAll("&amp;", "&");
    const toProvider = await many.http(httpEvent("GET", link));
    expect(new URL(toProvider.headers.location!).searchParams.get("prompt")).toBe("login");
  });
});

describe("removing a sign-in method needs a fresh sign-in with another method", () => {
  it("refuses a session whose interactive sign-in is more than 10 minutes old with REAUTH_REQUIRED, and changes nothing", async () => {
    const { h, github } = await twoMethods();
    advance(h, WINDOW_MS + 1000);
    const refused = await brokerCall(h, "DELETE", "/v1/app/me/identities/cloud", github.token);
    expect(refused.status).toBe(403);
    expect(errorOf(refused)).toEqual({ code: "REAUTH_REQUIRED", message: REAUTH_TO_CHANGE_METHODS });
    expect(REAUTH_TO_CHANGE_METHODS).toBe("to change your sign-in methods, sign in again first with a method you are keeping, then try again");
    expect(h.db.get(developerIdentityKey(githubId, cloudId))).toBeDefined();
    expect(h.db.get(signInIdentityKey(cloudId))).not.toHaveProperty("unlinkedFrom");
    expect(Object.keys(h.db.get(`DEVELOPER#${githubId}`, "META") ?? {}).filter((key) => /^(sessionsEndedBy|identityUnlinked)/.test(key))).toEqual([]);
  });

  it("allows a session that signed in within 10 minutes, to the second, with a method that stays on the account", async () => {
    const { h, github } = await twoMethods();
    advance(h, WINDOW_MS);
    const removed = await brokerCall(h, "DELETE", "/v1/app/me/identities/cloud", github.token);
    expect(removed.status).toBe(200);
    expect((removed.body.identities as Array<{ provider: string }>).map((identity) => identity.provider)).toEqual(["github"]);
  });

  it("refuses at 10 minutes and one millisecond", async () => {
    const { h, github } = await twoMethods();
    advance(h, WINDOW_MS + 1);
    expect(errorOf(await brokerCall(h, "DELETE", "/v1/app/me/identities/cloud", github.token)).code).toBe("REAUTH_REQUIRED");
  });

  it("refuses a fresh session made with the method being removed, and says to sign in with a different one", async () => {
    const { h, cloud } = await twoMethods();
    advance(h, 1000);
    const refused = await brokerCall(h, "DELETE", "/v1/app/me/identities/cloud", cloud.token);
    expect(refused.status).toBe(403);
    expect(errorOf(refused)).toEqual({ code: "REAUTH_REQUIRED", message: REAUTH_SAME_METHOD });
    expect(REAUTH_SAME_METHOD).toBe("you are signed in with the method you are removing; sign in again with a different method first, then try again");
    expect(h.db.get(developerIdentityKey(githubId, cloudId))).toBeDefined();
  });

  it("a refresh renewal never makes a session fresh: the interactive sign-in time is what counts", async () => {
    const { h, github } = await twoMethods();
    advance(h, WINDOW_MS + 60_000);
    const renewed = await h.refresh(github.refresh);
    expect(renewed.status).toBe(200);
    const renewedToken = String(renewed.body.access_token);
    expect(claimsOf(renewedToken).sid).toBe(github.claims.sid);
    const refused = await brokerCall(h, "DELETE", "/v1/app/me/identities/cloud", renewedToken);
    expect(refused.status).toBe(403);
    expect(errorOf(refused).code).toBe("REAUTH_REQUIRED");
    // A new interactive sign-in is fresh, and then the removal goes through.
    const again = await signIn(h, "github", "4711");
    expect((await brokerCall(h, "DELETE", "/v1/app/me/identities/cloud", again.token)).status).toBe(200);
  });

  it("refuses a session from before sessions recorded when they signed in (no authTime)", async () => {
    const { h } = await twoMethods();
    const old = await h.deps.store.createSession({ developerId: githubId, amr: "github", identityKey: githubId });
    const renewed = await h.refresh(old.refreshToken);
    expect(renewed.status).toBe(200);
    expect(h.db.get(`SESSION#${old.session.sessionId}`, "META")).not.toHaveProperty("authTime");
    const refused = await brokerCall(h, "DELETE", "/v1/app/me/identities/cloud", String(renewed.body.access_token));
    expect(errorOf(refused).code).toBe("REAUTH_REQUIRED");
  });

  it("still answers a method that cannot be removed with its own words, before asking for a fresh sign-in", async () => {
    const { h, github } = await twoMethods();
    advance(h, WINDOW_MS + 1000);
    const first = await brokerCall(h, "DELETE", "/v1/app/me/identities/github", github.token);
    expect(first.status).toBe(400);
    expect(errorOf(first).code).toBe("CONFIG_INVALID");
  });

  it("the sign-in function checks the session itself: an unknown, another developer's, revoked or ended session is a fresh sign-in needed", async () => {
    const { h, github } = await twoMethods({ extraUsers: [zed] });
    const other = await signIn(h, "cloud", zed.sub);
    const request = (sessionId: string) => ({ kind: "unlink-identity" as const, developerId: githubId, sessionId, provider: "cloud" as const });
    const expected = { ok: false, error: "reauth", message: REAUTH_TO_CHANGE_METHODS };
    expect(await h.handler(request("00000000-0000-4000-8000-000000000000"))).toEqual(expected);
    expect(await h.handler(request(String(other.claims.sid)))).toEqual(expected);
    await h.deps.store.revokeSession(String(github.claims.sid), "signed_out");
    expect(await h.handler(request(String(github.claims.sid)))).toEqual(expected);
    expect(h.db.get(developerIdentityKey(githubId, cloudId))).toBeDefined();
    // A session that ended with an admin's "end sessions" is not fresh either.
    const again = await signIn(h, "github", "4711");
    advance(h, 1000);
    await h.deps.store.endSessions(githubId, new Date(Date.now() + 1000).toISOString());
    expect(await h.handler(request(String(again.claims.sid)))).toEqual(expected);
  });

  it("the route passes the session of the verified token, never one the request carries", async () => {
    const { h, github } = await twoMethods();
    const unlinkIdentity = vi.fn(async (request: UnlinkIdentityRequest) => await h.handler(request) as never);
    const answer = await brokerCall(h, "DELETE", "/v1/app/me/identities/cloud", github.token, { body: { sessionId: "00000000-0000-4000-8000-000000000000", developerId: cloudId }, unlinkIdentity });
    expect(answer.status).toBe(200);
    expect(unlinkIdentity).toHaveBeenCalledWith({ kind: "unlink-identity", developerId: githubId, sessionId: String(github.claims.sid), provider: "cloud" });
  });

  it("answers a refusal of the function as REAUTH_REQUIRED, not as a sign-in that ended", async () => {
    const { h, github } = await twoMethods();
    const answer = await brokerCall(h, "DELETE", "/v1/app/me/identities/cloud", github.token, { unlinkIdentity: async () => ({ ok: false, error: "reauth", message: "sign in again" }) });
    expect(answer.status).toBe(403);
    expect(errorOf(answer)).toEqual({ code: "REAUTH_REQUIRED", message: "sign in again" });
  });
});

/** The browser side of the link flow: the authorize URL, the provider, the callback. Returns the page the person sees. */
async function finishLink(h: Harness, authorizeUrl: string, method: "cloud" | "github", who: string) {
  const url = new URL(authorizeUrl);
  const toProvider = await h.http(httpEvent("GET", url.pathname + url.search));
  expect(toProvider.statusCode).toBe(302);
  const callback = method === "github" ? h.github.approve(toProvider.headers.location!, who) : h.oidc.approve(toProvider.headers.location!, who);
  return h.http(httpEvent("GET", callback));
}
const startLink = (h: Harness, token: string, provider: "cloud" | "github", extra: Parameters<typeof brokerCall>[4] = {}) =>
  brokerCall(h, "POST", `/v1/app/me/identities/${provider}`, token, extra);
const authRequests = (h: Harness) => h.db.find((item) => item.entityType === "AUTH_REQUEST");

/** The account with email code removed from it (by its GitHub sign-in): the identity that can be added back. */
async function removedCloud(options: { ses?: ReturnType<typeof fakeSes>; extraUsers?: FakeOidcUser[] } = {}) {
  const world = await twoMethods(options);
  advance(world.h, 1000);
  expect((await brokerCall(world.h, "DELETE", "/v1/app/me/identities/cloud", world.github.token)).status).toBe(200);
  advance(world.h, 1000);
  return world;
}

describe("adding a removed sign-in method back", () => {
  it("links the identity back to the developer it was removed from, records who and when, and sends the new-method notice", async () => {
    const ses = fakeSes();
    const { h, github } = await removedCloud({ ses });
    expect(ses.sent).toHaveLength(1);
    const started = await startLink(h, github.token, "cloud");
    expect(started.status).toBe(200);
    const authorizeUrl = String(started.body.authorizeUrl);
    expect(authorizeUrl).toMatch(/^https:\/\/abc123\.execute-api\.us-east-1\.amazonaws\.com\/v1\/auth\/authorize\?request=[A-Za-z0-9_-]{43}&method=cloud$/);
    expect(authRequests(h)).toHaveLength(3);

    advance(h, 1000);
    const page = await finishLink(h, authorizeUrl, "cloud", priya.sub);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Sign-in method added back");
    expect(page.body).not.toMatch(/agxc_|agxr_|[0-9a-f]{64}/);

    const at = new Date(Date.now()).toISOString();
    expect(h.db.get(signInIdentityKey(cloudId))).toMatchObject({ developerId: githubId, provider: "cloud", linkedAt: at, relinkedBy: githubId, relinkedAt: at, relinkedWith: "github" });
    expect(h.db.get(signInIdentityKey(cloudId))).not.toHaveProperty("unlinkedFrom");
    expect(h.db.get(developerIdentityKey(githubId, cloudId))).toMatchObject({ developerId: githubId, provider: "cloud" });
    expect((await h.deps.store.identitiesOf(githubId)).map((identity) => identity.provider).sort()).toEqual(["cloud", "github"]);
    expect(h.logs).toContainEqual({ event: "signin.identity_relinked", developerId: githubId, provider: "cloud" });

    // The same notice as any new method, to the account's address.
    expect(ses.sent).toHaveLength(2);
    expect(ses.sent[1]!.input.Destination).toEqual({ ToAddresses: ["priya@acme.dev"] });
    expect(ses.sent[1]!.input.Content!.Simple!.Body!.Text!.Data).toMatch(/^Email code account can now sign in to your Rovara account\. .*run agentx signin unlink cloud/);

    // It signs in as the account again, and that is an existing link: no further notice.
    advance(h, 1000);
    const again = await signIn(h, "cloud", priya.sub);
    expect(again.claims).toMatchObject({ sub: githubId, amr: "cloud" });
    expect(ses.sent).toHaveLength(2);
  });

  it("sessions of the re-added method from before it was removed stay ended; sessions from after are fine", async () => {
    const ses = fakeSes();
    const world = await twoMethods({ ses });
    const { h, github, cloud } = world;
    advance(h, 1000);
    expect((await brokerCall(h, "DELETE", "/v1/app/me/identities/cloud", github.token)).status).toBe(200);
    advance(h, 1000);
    const started = await startLink(h, github.token, "cloud");
    advance(h, 1000);
    expect((await finishLink(h, String(started.body.authorizeUrl), "cloud", priya.sub)).statusCode).toBe(200);
    advance(h, 1000);
    expect((await brokerCall(h, "GET", "/v1/app/me", cloud.token)).status).toBe(401);
    expect((await h.refresh(cloud.refresh)).status).toBe(400);
    // The unlink mark is gone and the cutoff is the link time.
    const developer = h.db.get(`DEVELOPER#${githubId}`, "META")!;
    expect(developer).not.toHaveProperty(`identityUnlinked#${cloudId}`);
    expect(developer[`sessionsEndedByIdentity#${cloudId}`]).toBe(h.db.get(signInIdentityKey(cloudId))!.linkedAt);
    const fresh = await signIn(h, "cloud", priya.sub);
    expect((await brokerCall(h, "GET", "/v1/app/me", fresh.token)).status).toBe(200);
    expect((await h.refresh(fresh.refresh)).status).toBe(200);
  });

  it("an unlinked identity that signs in on its own, with nobody linking it, still becomes its own developer", async () => {
    const { h, github } = await removedCloud();
    const alone = await signIn(h, "cloud", priya.sub);
    expect(alone.claims.sub).toBe(cloudId);
    expect(h.db.get(signInIdentityKey(cloudId))).toMatchObject({ developerId: cloudId, unlinkedFrom: githubId });
    expect(h.db.get(developerIdentityKey(githubId, cloudId))).toBeUndefined();
    // The account it left did not take it back.
    expect((await h.deps.store.identitiesOf(githubId)).map((identity) => identity.provider)).toEqual(["github"]);
    expect((await brokerCall(h, "GET", "/v1/app/me", github.token)).status).toBe(200);
  });

  it("refuses to add back an identity that has since started its own account, and leaves both accounts as they were", async () => {
    const { h, github } = await removedCloud();
    await signIn(h, "cloud", priya.sub);
    const before = structuredClone(h.db.get(signInIdentityKey(cloudId)));
    const started = await startLink(h, github.token, "cloud");
    expect(started.status).toBe(200);
    const page = await finishLink(h, String(started.body.authorizeUrl), "cloud", priya.sub);
    expect(page.statusCode).toBe(403);
    expect(page.body).toContain(sentence(RELINK_OWN_ACCOUNT));
    expect(h.db.get(signInIdentityKey(cloudId))).toEqual(before);
    expect(h.db.get(developerIdentityKey(githubId, cloudId))).toBeUndefined();
  });

  it("another developer can never claim it: a fresh session of someone else cannot link an identity that was removed from this account", async () => {
    const ses = fakeSes();
    const { h } = await removedCloud({ ses, extraUsers: [zed] });
    const other = await signIn(h, "cloud", zed.sub);
    expect(other.claims.sub).toBe(zedId);
    const before = structuredClone(h.db.get(signInIdentityKey(cloudId)));
    const emails = ses.sent.length;
    const started = await startLink(h, other.token, "cloud");
    expect(started.status).toBe(200);
    const page = await finishLink(h, String(started.body.authorizeUrl), "cloud", priya.sub);
    expect(page.statusCode).toBe(403);
    expect(page.body).toContain(sentence(RELINK_NOT_REMOVED));
    expect(h.db.get(signInIdentityKey(cloudId))).toEqual(before);
    expect(h.db.get(developerIdentityKey(zedId, cloudId))).toBeUndefined();
    expect((await h.deps.store.identitiesOf(zedId)).map((identity) => identity.provider)).toEqual(["cloud"]);
    expect(ses.sent).toHaveLength(emails);
  });

  it("refuses an identity that was never linked to this account (the link flow only adds back)", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [zed, priya], github: { users: [octo] } });
    const github = await signIn(h, "github", "4711");
    const started = await startLink(h, github.token, "cloud");
    const page = await finishLink(h, String(started.body.authorizeUrl), "cloud", zed.sub);
    expect(page.statusCode).toBe(403);
    expect(page.body).toContain(sentence(RELINK_NOT_REMOVED));
    expect(h.db.get(signInIdentityKey(zedId))).toBeUndefined();
    expect((await h.deps.store.identitiesOf(githubId)).map((identity) => identity.provider)).toEqual(["github"]);
  });

  it("refuses to add back an identity that is still linked", async () => {
    const { h, github } = await twoMethods();
    const started = await startLink(h, github.token, "cloud");
    const page = await finishLink(h, String(started.body.authorizeUrl), "cloud", priya.sub);
    expect(page.statusCode).toBe(403);
    expect(page.body).toContain(sentence(RELINK_ALREADY));
  });

  it("needs a fresh sign-in to start: a session of more than 10 minutes is told to sign in again, and no request is made", async () => {
    const { h, github } = await removedCloud();
    const requests = authRequests(h).length;
    advance(h, WINDOW_MS + 1000);
    const refused = await startLink(h, github.token, "cloud");
    expect(refused.status).toBe(403);
    expect(errorOf(refused)).toEqual({ code: "REAUTH_REQUIRED", message: REAUTH_TO_CHANGE_METHODS });
    expect(authRequests(h)).toHaveLength(requests);
  });

  it("needs the fresh sign-in at the end too: started fresh, finished after the session went stale, nothing is linked", async () => {
    const { h, github } = await removedCloud();
    // The session is six minutes into its ten when the link starts, and the person takes five more at the provider.
    advance(h, 6 * 60_000);
    const started = await startLink(h, github.token, "cloud");
    expect(started.status).toBe(200);
    advance(h, 5 * 60_000);
    const before = structuredClone(h.db.get(signInIdentityKey(cloudId)));
    const page = await finishLink(h, String(started.body.authorizeUrl), "cloud", priya.sub);
    expect(page.statusCode).toBe(403);
    expect(page.body).toContain("sign in again");
    expect(h.db.get(signInIdentityKey(cloudId))).toEqual(before);
    expect(h.db.get(developerIdentityKey(githubId, cloudId))).toBeUndefined();
  });

  it("a link request is for the one method it was made for", async () => {
    const { h, github } = await removedCloud();
    const started = await startLink(h, github.token, "cloud");
    const url = new URL(String(started.body.authorizeUrl));
    url.searchParams.set("method", "github");
    const refused = await h.http(httpEvent("GET", url.pathname + url.search));
    expect(refused.statusCode).toBe(400);
    // The request is untouched: the right method still works.
    const page = await finishLink(h, String(started.body.authorizeUrl), "cloud", priya.sub);
    expect(page.statusCode).toBe(200);
  });

  it("a link request is used once", async () => {
    const { h, github } = await removedCloud();
    const started = await startLink(h, github.token, "cloud");
    const url = new URL(String(started.body.authorizeUrl));
    const toProvider = await h.http(httpEvent("GET", url.pathname + url.search));
    const callback = h.oidc.approve(toProvider.headers.location!, priya.sub);
    expect((await h.http(httpEvent("GET", callback))).statusCode).toBe(200);
    const replay = await h.http(httpEvent("GET", callback));
    expect(replay.statusCode).toBe(400);
    expect(replay.body).toContain("already used");
  });

  it("a notice that cannot be sent never fails the re-add, and the failure is logged without the address", async () => {
    const ses = fakeSes(Object.assign(new Error("MessageRejected: priya@acme.dev"), { name: "MessageRejected" }));
    const { h, github } = await removedCloud({ ses });
    const started = await startLink(h, github.token, "cloud");
    const page = await finishLink(h, String(started.body.authorizeUrl), "cloud", priya.sub);
    expect(page.statusCode).toBe(200);
    expect(h.db.get(signInIdentityKey(cloudId))).toMatchObject({ developerId: githubId });
    expect(h.logs).toContainEqual({ event: "signin.identity_link_notice_failed", provider: "cloud", error: "MessageRejected" });
    expect(JSON.stringify(h.logs)).not.toContain("priya@acme.dev");
  });

  it("a person cancelling at the provider links nothing", async () => {
    const { h, github } = await removedCloud();
    const started = await startLink(h, github.token, "cloud");
    const url = new URL(String(started.body.authorizeUrl));
    const toProvider = await h.http(httpEvent("GET", url.pathname + url.search));
    const state = new URL(toProvider.headers.location!).searchParams.get("state")!;
    const page = await h.http(httpEvent("GET", `/v1/auth/callback/cloud?state=${state}&error=access_denied`));
    expect(page.statusCode).toBe(400);
    expect(h.db.get(signInIdentityKey(cloudId))).toMatchObject({ unlinkedFrom: githubId });
  });

  it("the route passes the verified token's developer and session, never a body value", async () => {
    const { h, github } = await removedCloud();
    const startIdentityLink = vi.fn(async (request: StartIdentityLinkRequest) => await h.handler(request) as never);
    const answer = await startLink(h, github.token, "cloud", { body: { developerId: "f".repeat(64), sessionId: "00000000-0000-4000-8000-000000000000", provider: "github" }, startIdentityLink });
    expect(answer.status).toBe(200);
    expect(startIdentityLink).toHaveBeenCalledWith({ kind: "start-identity-link", developerId: githubId, sessionId: String(github.claims.sid), provider: "cloud" });
  });

  it("the route refuses a method that cannot be added, answers not set up without the function, and reports an unfinished invoke as unavailable", async () => {
    const { h, github } = await removedCloud();
    const slack = await brokerCall(h, "POST", "/v1/app/me/identities/slack", github.token);
    expect(slack.status).toBe(400);
    expect(errorOf(slack).message).toContain("cloud or github");
    expect((await startLink(h, github.token, "cloud", { startIdentityLink: null })).status).toBe(404);
    expect((await startLink(h, github.token, "cloud", { startIdentityLink: async () => ({ ok: false, error: "unavailable" }) })).status).toBe(503);
    const refused = await startLink(h, github.token, "cloud", { startIdentityLink: async () => ({ ok: false, error: "refused", message: "that sign-in method is not available here" }) });
    expect(refused.status).toBe(400);
    expect(errorOf(refused).message).toBe("that sign-in method is not available here");
  });

  it("the sign-in function refuses a link request that is not one, and a method this environment does not offer", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [priya] });
    const cloud = await signIn(h, "cloud", priya.sub);
    const sessionId = String(cloud.claims.sid);
    const bad = [
      { kind: "start-identity-link", developerId: "nope", sessionId, provider: "cloud" },
      { kind: "start-identity-link", developerId: cloudId, sessionId, provider: "slack" },
      { kind: "start-identity-link", developerId: cloudId, provider: "cloud" },
      { kind: "start-identity-link", developerId: cloudId, sessionId: "not-a-session", provider: "cloud" },
      { kind: "start-identity-link", developerId: cloudId, sessionId, provider: "cloud", extra: 1 },
    ];
    for (const request of bad) expect(await h.handler(request as never)).toEqual({ ok: false, error: "invalid_request" });
    // GitHub sign-in is not set up in this environment.
    expect(await h.handler({ kind: "start-identity-link", developerId: cloudId, sessionId, provider: "github" })).toEqual({ ok: false, error: "refused", message: "that sign-in method is not available here" });
    expect(authRequests(h).filter((item) => item.linkDeveloperId !== undefined)).toEqual([]);
  });
});

describe("DeveloperSignInStore.relinkIdentity", () => {
  const body = (at: string) => ({ entityType: "IDENTITY_LINK", provider: "cloud" as const, issuer: OIDC_ISSUER, subject: priya.sub, linkedAt: at, lastSignInAt: at });
  function setup() {
    const db = new FakeDynamoDb();
    const store = new DeveloperSignInStore({ documentClient: db, tableName: "signin", now: () => T0 + 9000 });
    db.set({ pk: `DEVELOPER#${githubId}`, sk: "META", entityType: "DEVELOPER", developerId: githubId, provider: "github", issuer: GITHUB_ISSUER, subject: "4711", displayName: "Octo", firstSignInAt: "x", lastSignInAt: "x", revoked: false, [`sessionsEndedByIdentity#${cloudId}`]: new Date(T0 + 5000).toISOString(), [`identityUnlinked#${cloudId}`]: new Date(T0 + 5000).toISOString() });
    db.set({ ...signInIdentityKey(cloudId), ...body("2026-09-01T00:00:00.000Z"), developerId: githubId, unlinkedFrom: githubId, unlinkedAt: new Date(T0 + 5000).toISOString() });
    return { db, store };
  }
  const input = { identityKey: cloudId, developerId: githubId, provider: "cloud" as const, issuer: OIDC_ISSUER, subject: priya.sub, by: { method: "github" as const } };

  it("writes the link, the reverse item and the cutoff in one transaction", async () => {
    const { db, store } = setup();
    expect(await store.relinkIdentity(input)).toEqual({ developerId: githubId });
    const at = new Date(T0 + 9000).toISOString();
    expect(db.get(signInIdentityKey(cloudId))).toMatchObject({ developerId: githubId, linkedAt: at, relinkedBy: githubId, relinkedAt: at, relinkedWith: "github" });
    expect(db.get(signInIdentityKey(cloudId))).not.toHaveProperty("unlinkedFrom");
    expect(db.get(developerIdentityKey(githubId, cloudId))).toMatchObject({ developerId: githubId, relinkedBy: githubId });
    const developer = db.get(`DEVELOPER#${githubId}`, "META")!;
    expect(developer).not.toHaveProperty(`identityUnlinked#${cloudId}`);
    expect(developer).toHaveProperty(`sessionsEndedByIdentity#${cloudId}`, at);
  });

  it("refuses a tombstone for another developer, one that is gone, and a link that is not a tombstone", async () => {
    const { db, store } = setup();
    await expect(store.relinkIdentity({ ...input, developerId: zedId })).rejects.toThrow(RELINK_NOT_REMOVED);
    await expect(store.relinkIdentity({ ...input, identityKey: "e".repeat(64) })).rejects.toThrow(RELINK_NOT_REMOVED);
    db.set({ ...db.get(signInIdentityKey(cloudId))!, developerId: cloudId });
    await expect(store.relinkIdentity(input)).rejects.toThrow(RELINK_OWN_ACCOUNT);
    expect(db.get(developerIdentityKey(githubId, cloudId))).toBeUndefined();
  });

  it("a race: when the identity's link changed between the read and the transaction, nothing is written", async () => {
    const { db, store } = setup();
    let raced = false;
    db.injectFault({
      command: "TransactWriteCommand",
      match: () => {
        if (raced) return false;
        raced = true;
        // The identity signs in on its own first, and becomes its own developer.
        db.set({ ...db.get(signInIdentityKey(cloudId))!, developerId: cloudId });
        return false;
      },
      error: { name: "TransactionCanceledException" },
    });
    // The refusal names what happened: it is its own account now.
    await expect(store.relinkIdentity(input)).rejects.toThrow(RELINK_OWN_ACCOUNT);
    expect(db.get(signInIdentityKey(cloudId))).toMatchObject({ developerId: cloudId, unlinkedFrom: githubId });
    expect(db.get(developerIdentityKey(githubId, cloudId))).toBeUndefined();
    expect(db.get(`DEVELOPER#${githubId}`, "META")).toHaveProperty(`identityUnlinked#${cloudId}`);
  });

  it("a race that leaves the link as it was (the developer's record is gone) says the methods changed, and writes nothing", async () => {
    const { db, store } = setup();
    db.injectFault({
      command: "TransactWriteCommand",
      match: () => { db.delete(`DEVELOPER#${githubId}`, "META"); return false; },
      error: { name: "TransactionCanceledException" },
    });
    await expect(store.relinkIdentity(input)).rejects.toThrow("changed while this ran");
    expect(db.get(signInIdentityKey(cloudId))).toMatchObject({ developerId: githubId, unlinkedFrom: githubId });
    expect(db.get(developerIdentityKey(githubId, cloudId))).toBeUndefined();
  });
});

describe("what the sign-in function does to its table for these two flows", () => {
  it("the fresh-sign-in check and the re-add use only GetItem, PutItem and UpdateItem (no Query, DeleteItem, scan, batch or condition check)", async () => {
    const { h, github } = await removedCloud();
    const used = new Set<string>();
    const send = h.db.send;
    h.db.send = (async (command: { constructor: { name: string }; input: { TransactItems?: Array<Record<string, unknown>> } }) => {
      used.add(command.constructor.name);
      for (const item of command.input.TransactItems ?? []) for (const kind of Object.keys(item)) used.add(`Transact${kind}`);
      return send(command);
    });
    // The whole re-add (start, provider, callback), then a start refused for a stale session.
    advance(h, 1000);
    const started = await startLink(h, github.token, "cloud");
    const page = await finishLink(h, String(started.body.authorizeUrl), "cloud", priya.sub);
    expect(page.statusCode).toBe(200);
    advance(h, WINDOW_MS);
    expect(errorOf(await startLink(h, github.token, "cloud")).code).toBe("REAUTH_REQUIRED");
    expect([...used].sort()).toEqual(["GetCommand", "PutCommand", "TransactPut", "TransactUpdate", "TransactWriteCommand", "UpdateCommand"]);
  });
});
