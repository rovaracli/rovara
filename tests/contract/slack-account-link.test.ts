// A signed-in web user links their Slack account (owner decision, 2026-11-05). The link is a verified identity link of the sign-in table (the same items sign-in and
// the duplicate merge use), made by Sign in with Slack in link mode, bound to the web session that started it. A Slack mention then resolves to the web account's membership.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgId } from "@rovara-code/contracts";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { startAppIdentityLink, unlinkAppIdentity } from "../../packages/broker/src/aws/developer-routes/organization.js";
import { webRouteAllowed } from "../../packages/broker/src/aws/web-auth.js";
import { slackCallerFor } from "../../packages/broker/src/aws/broker/dependency-wiring.js";
import { SLACK_LINKED_ATTRIBUTE, SLACK_LINK_HAS_ONE, SLACK_LINK_TAKEN, SLACK_NO_WORKSPACE_MESSAGE, developerIdentityKey, signInIdentityKey } from "../../packages/broker/src/developer/store.js";
import { membershipOrgResolver } from "../../packages/broker/src/org/resolve.js";
import { T0, TEAM, httpEvent, identityHarness, type FakeSlackUser } from "../support/developer-fakes.js";
import { capturingAuditDeps } from "../support/audit-capture.js";

const SLACK_ISSUER = "https://slack.com";
const priya = { sub: "priya-cloud-1", name: "Priya Rao", email: "priya@acme.dev", email_verified: true };
const zed = { sub: "zed-cloud-1", name: "Zed Ito", email: "zed@other.dev", email_verified: true };
const OWNER_SLACK = "U0OWNER0001";
const OTHER_SLACK = "U0OTHER0001";
const ownerSlack: FakeSlackUser = { userId: OWNER_SLACK, name: "Priya Rao", email: "priya@acme.dev", emailVerified: true };
const otherSlack: FakeSlackUser = { userId: OTHER_SLACK, name: "Pat Other", email: "pat@acme.dev", emailVerified: true };
const slackKey = (userId: string) => ownerKeyForSubject(SLACK_ISSUER, userId);
const SESSION_COOKIE = "__Host-agentx_review_session";
const claimsOf = (accessToken: unknown) => JSON.parse(Buffer.from(String(accessToken).split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;

beforeEach(() => { vi.useFakeTimers({ now: T0, toFake: ["Date"] }); });
afterEach(() => { vi.useRealTimers(); });

type Harness = ReturnType<typeof identityHarness>;

/** A company with Priya in it (her account is the one her email-code sign-in made), the Slack team bound to it, and Slack accounts that have not been linked to anyone. */
async function world(options: { slackUsers?: FakeSlackUser[]; audit?: ReturnType<typeof capturingAuditDeps> } = {}) {
  const audit = options.audit ?? capturingAuditDeps();
  const h = identityHarness({ cloud: {}, oidcUsers: [priya, zed], slackUsers: options.slackUsers ?? [ownerSlack, otherSlack], singleOrg: false, sharedTable: true, audit, storeAudit: true });
  const signedIn = async (who: string) => {
    const location = await h.signIn("cloud", who);
    const exchanged = await h.exchange(location.searchParams.get("code")!);
    expect(exchanged.status).toBe(200);
    return { token: String(exchanged.body.access_token), sessionId: String(claimsOf(exchanged.body.access_token).sid), developerId: String(claimsOf(exchanged.body.access_token).sub) };
  };
  const priyaSession = await signedIn(priya.sub);
  const orgId = (await h.orgs.orgForDeveloper(priyaSession.developerId))!.orgId;
  await h.orgs.bindSlackTeam({ orgId, teamId: TEAM });
  return { h, audit, orgId, account: priyaSession.developerId, session: priyaSession, signedIn };
}

type Started = { ok: true; authorizeUrl: string } | { ok: false; error: string; message?: string };
const start = async (h: Harness, account: string, sessionId: string, extra: Record<string, unknown> = { browser: true }): Promise<Started> =>
  (await h.handler({ kind: "start-identity-link", developerId: account, sessionId, provider: "slack", ...extra } as never)) as Started;

/** The browser: the authorize URL, Slack, the callback (with the web session cookie unless `cookie` says otherwise). */
async function finish(h: Harness, authorizeUrl: string, slackUser: string, options: { cookie?: string | null; sessionId: string; overrides?: { teamId?: string } }) {
  const url = new URL(authorizeUrl);
  const toSlack = await h.http(httpEvent("GET", url.pathname + url.search));
  expect(toSlack.statusCode).toBe(302);
  const callback = h.slack.approve(toSlack.headers.location!, slackUser, options.overrides ?? {});
  const cookie = options.cookie === undefined ? `${SESSION_COOKIE}=${options.sessionId}` : options.cookie;
  return h.http(httpEvent("GET", callback, undefined, cookie === null ? {} : { cookie }));
}
const outcomeOf = (page: { statusCode: number; headers: Record<string, string> }) => {
  expect(page.statusCode).toBe(302);
  return new URL(page.headers.location!, "https://x.test").searchParams.get("slack_link");
};

async function link(w: Awaited<ReturnType<typeof world>>, slackUser = OWNER_SLACK) {
  const started = await start(w.h, w.account, w.session.sessionId) as { ok: true; authorizeUrl: string };
  expect(started.ok).toBe(true);
  return finish(w.h, started.authorizeUrl, slackUser, { sessionId: w.session.sessionId });
}

describe("starting the link", () => {
  it("is for the web only: the sign-in function refuses it without the browser flag, and a CLI cannot make one", async () => {
    const { h, account, session } = await world();
    expect(await start(h, account, session.sessionId, {})).toMatchObject({ ok: false, error: "refused" });
    expect(await start(h, account, session.sessionId, {})).toHaveProperty("message", "link your Slack account from the Rovara web app");
    expect(h.db.find((item) => item.entityType === "AUTH_REQUEST" && item.linkMethod === "slack")).toEqual([]);
  });

  it("makes one short-lived request bound to this account and this session, with a state and a nonce of its own, and links nothing yet", async () => {
    const { h, account, session } = await world();
    const started = await start(h, account, session.sessionId) as { ok: true; authorizeUrl: string };
    expect(started.authorizeUrl).toMatch(/\/v1\/auth\/authorize\?request=[A-Za-z0-9_-]{43}&method=slack$/);
    const [request] = h.db.find((item) => item.entityType === "AUTH_REQUEST" && item.linkMethod === "slack");
    expect(request).toMatchObject({ linkDeveloperId: account, linkSessionId: session.sessionId, linkMethod: "slack", linkBrowser: true });
    expect(String(request!.nonce)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Number(request!.expiresAt) - Math.floor(T0 / 1000)).toBeLessThanOrEqual(600);
    expect(h.db.get(signInIdentityKey(slackKey(OWNER_SLACK)))).toBeUndefined();
  });

  it("needs a fresh sign-in, and refuses when a Slack account is already linked", async () => {
    const w = await world();
    h_tick(w.h, 11 * 60 * 1000);
    expect(await start(w.h, w.account, w.session.sessionId)).toMatchObject({ ok: false, error: "reauth" });
    const again = await w.signedIn(priya.sub);
    expect(outcomeOf(await link({ ...w, session: again }))).toBe("linked");
    const second = await start(w.h, w.account, again.sessionId);
    expect(second).toEqual({ ok: false, error: "refused", message: SLACK_LINK_HAS_ONE });
  });
});
const h_tick = (h: Harness, ms: number) => { h.tick(ms); vi.setSystemTime(Date.now() + ms); };

describe("finishing the link", () => {
  it("links the Slack account to the web account: the link, the reverse item, the old Slack developer merged in, audited", async () => {
    const w = await world();
    // The Slack account signed in on its own before (it has a developer of its own, with no company).
    await w.h.signIn("slack", OWNER_SLACK);
    expect(w.h.db.get(`DEVELOPER#${slackKey(OWNER_SLACK)}`, "META")).toBeDefined();
    expect(outcomeOf(await link(w))).toBe("linked");
    expect(w.h.db.get(signInIdentityKey(slackKey(OWNER_SLACK)))).toMatchObject({ developerId: w.account, provider: "slack", issuer: SLACK_ISSUER, subject: OWNER_SLACK });
    expect(w.h.db.get(developerIdentityKey(w.account, slackKey(OWNER_SLACK)))).toMatchObject({ developerId: w.account, provider: "slack" });
    expect(w.h.db.get(`DEVELOPER#${slackKey(OWNER_SLACK)}`, "META")).toMatchObject({ mergedInto: w.account });
    expect((await w.h.deps.store.identitiesOf(w.account)).map((identity) => identity.provider).sort()).toEqual(["cloud", "slack"]);
    expect(await w.h.deps.store.developerOfSlackUser(OWNER_SLACK)).toBe(w.account);
    // Audited as the account's own act, naming the method and no Slack ID.
    const events = w.audit.recordedBy("identity.linked").filter((event) => event.actor.id === w.account);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ orgId: w.orgId, actor: { kind: "member", id: w.account }, facts: { provider: "slack" } });
    expect(JSON.stringify(events)).not.toContain(OWNER_SLACK);
    expect(w.h.logs).toContainEqual({ event: "signin.slack_linked", developerId: w.account });
  });

  it("links a Slack account that never signed in on its own (no developer of its own to merge)", async () => {
    const w = await world();
    expect(w.h.db.get(`DEVELOPER#${slackKey(OWNER_SLACK)}`, "META")).toBeUndefined();
    expect(outcomeOf(await link(w))).toBe("linked");
    expect(w.h.db.get(signInIdentityKey(slackKey(OWNER_SLACK)))).toMatchObject({ developerId: w.account });
    expect(w.h.db.get(`DEVELOPER#${slackKey(OWNER_SLACK)}`, "META")).toBeUndefined();
  });

  it("never links from the email lookup alone: a Slack account with the account's own verified email but no sign-in at Slack for this request is not linked", async () => {
    const w = await world();
    // Priya's Slack account shares her verified email, but the request is finished by another Slack person: only the person who signs in at Slack is linked.
    expect(outcomeOf(await link(w, OTHER_SLACK))).toBe("linked");
    expect(w.h.db.get(signInIdentityKey(slackKey(OWNER_SLACK)))).toBeUndefined();
    expect(w.h.db.get(signInIdentityKey(slackKey(OTHER_SLACK)))).toMatchObject({ developerId: w.account });
    // Signing in at Slack as the email's owner on a bare sign-in (no link request) does not attach anything to the account either.
    const w2 = await world();
    await w2.h.signIn("slack", OWNER_SLACK);
    expect(w2.h.db.get(signInIdentityKey(slackKey(OWNER_SLACK)))?.developerId).toBe(slackKey(OWNER_SLACK));
  });

  it("refuses a state that was never issued, a state used before, and an expired one, and links nothing", async () => {
    const w = await world();
    const started = await start(w.h, w.account, w.session.sessionId) as { ok: true; authorizeUrl: string };
    const url = new URL(started.authorizeUrl);
    const toSlack = await w.h.http(httpEvent("GET", url.pathname + url.search));
    const callback = w.h.slack.approve(toSlack.headers.location!, OWNER_SLACK);
    const cookie = { cookie: `${SESSION_COOKIE}=${w.session.sessionId}` };
    // A forged state: the CSRF case.
    const forged = await w.h.http(httpEvent("GET", callback.replace(/state=[^&]*/, "state=forged-state-value"), undefined, cookie));
    expect(forged.statusCode).toBe(400);
    expect(w.h.db.get(signInIdentityKey(slackKey(OWNER_SLACK)))).toBeUndefined();
    // The real one works once.
    expect(outcomeOf(await w.h.http(httpEvent("GET", callback, undefined, cookie)))).toBe("linked");
    // And not again: the state is spent.
    const replay = await w.h.http(httpEvent("GET", callback, undefined, cookie));
    expect(replay.statusCode).toBe(400);
    // Expired.
    const w2 = await world();
    const s2 = await start(w2.h, w2.account, w2.session.sessionId) as { ok: true; authorizeUrl: string };
    const u2 = new URL(s2.authorizeUrl);
    const to2 = await w2.h.http(httpEvent("GET", u2.pathname + u2.search));
    const cb2 = w2.h.slack.approve(to2.headers.location!, OWNER_SLACK);
    h_tick(w2.h, 20 * 60 * 1000);
    expect((await w2.h.http(httpEvent("GET", cb2, undefined, { cookie: `${SESSION_COOKIE}=${w2.session.sessionId}` }))).statusCode).toBe(400);
    expect(w2.h.db.get(signInIdentityKey(slackKey(OWNER_SLACK)))).toBeUndefined();
  });

  it("refuses to finish in a browser that does not hold the session that started it (no cookie, or another session's), and links nothing", async () => {
    const w = await world();
    const other = await w.signedIn(zed.sub);
    for (const cookie of [null, `${SESSION_COOKIE}=${other.sessionId}`, `${SESSION_COOKIE}=`, "unrelated=1"]) {
      const started = await start(w.h, w.account, w.session.sessionId) as { ok: true; authorizeUrl: string };
      const page = await finish(w.h, started.authorizeUrl, OWNER_SLACK, { cookie, sessionId: w.session.sessionId });
      expect(outcomeOf(page), String(cookie)).toBe("wrong_browser");
      expect(w.h.db.get(signInIdentityKey(slackKey(OWNER_SLACK)))).toBeUndefined();
    }
    expect(w.audit.recordedBy("identity.linked")).toEqual([]);
  });

  it("refuses when the session that started it has ended or is no longer fresh by the time Slack answers", async () => {
    const w = await world();
    const started = await start(w.h, w.account, w.session.sessionId) as { ok: true; authorizeUrl: string };
    await w.h.deps.store.revokeSession(w.session.sessionId, "signed_out");
    expect(outcomeOf(await finish(w.h, started.authorizeUrl, OWNER_SLACK, { sessionId: w.session.sessionId }))).toBe("reauth");
    expect(w.h.db.get(signInIdentityKey(slackKey(OWNER_SLACK)))).toBeUndefined();
  });

  it("refuses a Slack account that already belongs to another Rovara account, and changes neither", async () => {
    const w = await world();
    const zedSession = await w.signedIn(zed.sub);
    expect(zedSession.developerId).not.toBe(w.account);
    // Zed's account holds the Slack identity (an active link, as a link made by Zed's own web session leaves it).
    const at = "2026-09-27T11:00:00.000Z";
    const body = { entityType: "IDENTITY_LINK", developerId: zedSession.developerId, provider: "slack", issuer: SLACK_ISSUER, subject: OWNER_SLACK, linkedAt: at, lastSignInAt: at };
    w.h.db.set({ ...signInIdentityKey(slackKey(OWNER_SLACK)), ...body });
    w.h.db.set({ ...developerIdentityKey(zedSession.developerId, slackKey(OWNER_SLACK)), ...body });
    const before = structuredClone(w.h.db.get(signInIdentityKey(slackKey(OWNER_SLACK))));
    expect(outcomeOf(await link(w))).toBe("taken");
    expect(w.h.db.get(signInIdentityKey(slackKey(OWNER_SLACK)))).toEqual(before);
    expect(w.h.db.get(developerIdentityKey(w.account, slackKey(OWNER_SLACK)))).toBeUndefined();
    expect(w.audit.recordedBy("identity.linked").filter((event) => event.actor.id === w.account)).toEqual([]);
    expect(SLACK_LINK_TAKEN).toMatch(/another/);
  });

  it("refuses a Slack account that was unlinked from another account (it can only go back to that one)", async () => {
    const w = await world();
    const zedSession = await w.signedIn(zed.sub);
    const at = "2026-09-27T11:00:00.000Z";
    w.h.db.set({ ...signInIdentityKey(slackKey(OWNER_SLACK)), entityType: "IDENTITY_LINK", developerId: zedSession.developerId, unlinkedFrom: zedSession.developerId, unlinkedAt: at, provider: "slack", issuer: SLACK_ISSUER, subject: OWNER_SLACK, linkedAt: at, lastSignInAt: at });
    expect(outcomeOf(await link(w))).toBe("taken");
    expect(w.h.db.get(developerIdentityKey(w.account, slackKey(OWNER_SLACK)))).toBeUndefined();
  });

  it("refuses a Slack account whose own developer already belongs to a company (it joined with its Slack sign-in), and merges nothing", async () => {
    const w = await world();
    await w.h.orgs.addMember({ orgId: w.orgId, developerId: slackKey(OWNER_SLACK), role: "member" });
    await w.h.signIn("slack", OWNER_SLACK);
    expect(outcomeOf(await link(w))).toBe("taken");
    expect(w.h.db.get(`DEVELOPER#${slackKey(OWNER_SLACK)}`, "META")).not.toHaveProperty("mergedInto");
    expect(w.h.db.get(developerIdentityKey(w.account, slackKey(OWNER_SLACK)))).toBeUndefined();
    expect(w.audit.recordedBy("identity.linked").filter((event) => event.actor.id === w.account)).toEqual([]);
  });

  it("refuses the wrong Slack workspace: one the sign-in does not serve, and one that is not the company's bound team", async () => {
    const w = await world();
    const started = await start(w.h, w.account, w.session.sessionId) as { ok: true; authorizeUrl: string };
    const page = await finish(w.h, started.authorizeUrl, OWNER_SLACK, { sessionId: w.session.sessionId, overrides: { teamId: "T0OTHERTEAM" } });
    expect(outcomeOf(page)).toBe("wrong_team");
    expect(w.h.db.get(signInIdentityKey(slackKey(OWNER_SLACK)))).toBeUndefined();
    // The right workspace for the sign-in, but the company's bound Slack team is another one.
    const w2 = await world();
    await w2.h.orgs.unbindSlackTeam({ orgId: w2.orgId, teamId: TEAM });
    await w2.h.orgs.bindSlackTeam({ orgId: w2.orgId, teamId: "T0BOUNDELSE" });
    expect(outcomeOf(await link(w2))).toBe("wrong_team");
    expect(w2.h.db.get(signInIdentityKey(slackKey(OWNER_SLACK)))).toBeUndefined();
    // UX1: a company with no Slack workspace at all is told that, not "wrong workspace": refused before Slack, and at the callback if it was unbound meanwhile.
    const w3 = await world();
    await w3.h.orgs.unbindSlackTeam({ orgId: w3.orgId, teamId: TEAM });
    expect(await start(w3.h, w3.account, w3.session.sessionId)).toEqual({ ok: false, error: "refused", message: SLACK_NO_WORKSPACE_MESSAGE });
    expect(w3.h.db.find((item) => item.entityType === "AUTH_REQUEST" && item.linkMethod === "slack")).toEqual([]);
    const w4 = await world();
    const begun = await start(w4.h, w4.account, w4.session.sessionId) as { ok: true; authorizeUrl: string };
    await w4.h.orgs.unbindSlackTeam({ orgId: w4.orgId, teamId: TEAM });
    expect(outcomeOf(await finish(w4.h, begun.authorizeUrl, OWNER_SLACK, { sessionId: w4.session.sessionId }))).toBe("no_workspace");
    expect(w4.h.db.get(signInIdentityKey(slackKey(OWNER_SLACK)))).toBeUndefined();
  });

  it("a person cancelling at Slack links nothing", async () => {
    const w = await world();
    const started = await start(w.h, w.account, w.session.sessionId) as { ok: true; authorizeUrl: string };
    const url = new URL(started.authorizeUrl);
    const toSlack = await w.h.http(httpEvent("GET", url.pathname + url.search));
    const state = new URL(toSlack.headers.location!).searchParams.get("state")!;
    const page = await w.h.http(httpEvent("GET", `/v1/auth/callback/slack?state=${state}&error=access_denied`, undefined, { cookie: `${SESSION_COOKIE}=${w.session.sessionId}` }));
    expect(outcomeOf(page)).toBe("cancelled");
    expect(w.h.db.get(signInIdentityKey(slackKey(OWNER_SLACK)))).toBeUndefined();
  });
});

describe("unlinking", () => {
  const unlink = (w: Awaited<ReturnType<typeof world>>, sessionId = w.session.sessionId) => w.h.handler({ kind: "unlink-identity", developerId: w.account, sessionId, provider: "slack" } as never);

  it("removes the link, leaves a tombstone, ends the merge, and audits it", async () => {
    const w = await world();
    await w.h.signIn("slack", OWNER_SLACK);
    expect(outcomeOf(await link(w))).toBe("linked");
    h_tick(w.h, 1000);
    expect(await unlink(w)).toEqual({ ok: true });
    expect((await w.h.deps.store.identitiesOf(w.account)).map((identity) => identity.provider)).toEqual(["cloud"]);
    expect(w.h.db.get(signInIdentityKey(slackKey(OWNER_SLACK)))).toMatchObject({ unlinkedFrom: w.account });
    expect(w.h.db.get(`DEVELOPER#${slackKey(OWNER_SLACK)}`, "META")).not.toHaveProperty("mergedInto");
    expect(await w.h.deps.store.developerOfSlackUser(OWNER_SLACK)).toBeUndefined();
    expect(w.audit.recordedBy("identity.unlinked")).toHaveLength(1);
    expect(w.audit.recordedBy("identity.unlinked")[0]).toMatchObject({ facts: { provider: "slack" }, actor: { kind: "member", id: w.account } });
  });

  it("can be linked again by the same account, and not by another one (the account it was removed from only)", async () => {
    const w = await world();
    expect(outcomeOf(await link(w))).toBe("linked");
    h_tick(w.h, 1000);
    expect(await unlink(w)).toEqual({ ok: true });
    h_tick(w.h, 1000);
    expect(outcomeOf(await link(w))).toBe("linked");
    expect(w.h.db.get(signInIdentityKey(slackKey(OWNER_SLACK)))).toMatchObject({ developerId: w.account });
    expect(w.h.db.get(signInIdentityKey(slackKey(OWNER_SLACK)))).not.toHaveProperty("unlinkedFrom");
  });
});

describe("a Slack mention after the link", () => {
  async function mentionWorld() {
    const w = await world();
    const dependencies = {
      documentClient: w.h.state, tableName: "state", environmentName: "staging",
      developer: { slackTeamId: TEAM, signInTableName: "signin" }, orgResolver: membershipOrgResolver(w.h.orgs),
    } as never;
    return { ...w, dependencies };
  }
  const refusal = (run: () => Promise<unknown>) => run().then(() => undefined, (error: { code?: string }) => error.code);

  it("is refused as not linked before the link, resolves to the web account's membership after it, and is refused again after the unlink", async () => {
    const w = await mentionWorld();
    expect(await refusal(() => slackCallerFor(w.dependencies, OWNER_SLACK, TEAM))).toBe("SLACK_ACCOUNT_NOT_LINKED");
    expect(outcomeOf(await link(w))).toBe("linked");
    const caller = await slackCallerFor(w.dependencies, OWNER_SLACK, TEAM);
    expect(caller).toMatchObject({ orgId: w.orgId, orgRole: "owner" });
    // Someone else's Slack account is still not recognised.
    expect(await refusal(() => slackCallerFor(w.dependencies, OTHER_SLACK, TEAM))).toBe("SLACK_ACCOUNT_NOT_LINKED");
    h_tick(w.h, 1000);
    expect(await w.h.handler({ kind: "unlink-identity", developerId: w.account, sessionId: w.session.sessionId, provider: "slack" } as never)).toEqual({ ok: true });
    expect(await refusal(() => slackCallerFor(w.dependencies, OWNER_SLACK, TEAM))).toBe("SLACK_ACCOUNT_NOT_LINKED");
  });

  it("does not let a linked Slack account act in a company other than the account's", async () => {
    const w = await mentionWorld();
    expect(outcomeOf(await link(w))).toBe("linked");
    const otherOrg = "org_zzzzzzzzzzzzzzzzzzzz" as OrgId;
    w.h.state.set({ pk: "SLACK_TEAM#T0OTHER", sk: "ORG", orgId: otherOrg });
    expect(await refusal(() => slackCallerFor(w.dependencies, OWNER_SLACK, "T0OTHER"))).toBe("FORBIDDEN");
  });
});

describe("the web app's routes for the link", () => {
  it("lets a browser start and remove the Slack link and no other sign-in method change", () => {
    expect(webRouteAllowed("POST", "/v1/web/me/identities/slack")).toBe(true);
    expect(webRouteAllowed("DELETE", "/v1/web/me/identities/slack")).toBe(true);
    for (const [method, path] of [["POST", "/v1/web/me/identities/cloud"], ["DELETE", "/v1/web/me/identities/github"], ["PUT", "/v1/web/me/identities/slack"], ["POST", "/v1/web/me/identities/slack/extra"], ["POST", "/v1/web/me/identities"]] as const) {
      expect(webRouteAllowed(method, path), `${method} ${path}`).toBe(false);
    }
    expect(webRouteAllowed("GET", "/v1/web/me")).toBe(true);
  });

  const caller = (browserSession: boolean) => ({ developerId: "a".repeat(64), sessionId: "00000000-0000-4000-8000-000000000001", ...(browserSession ? { browserSession: true as const } : {}) });
  const deps = (calls: unknown[]) => ({ developer: { startIdentityLink: async (request: unknown) => { calls.push(request); return { ok: true as const, authorizeUrl: "https://x.test/v1/auth/authorize?request=r&method=slack" }; } } }) as never;

  it("starts the link for a live browser session with its own developer and session, flagged as a browser start", async () => {
    const calls: unknown[] = [];
    expect(await startAppIdentityLink(deps(calls), caller(true) as never, "slack")).toEqual({ authorizeUrl: "https://x.test/v1/auth/authorize?request=r&method=slack" });
    expect(calls).toEqual([{ kind: "start-identity-link", developerId: "a".repeat(64), sessionId: "00000000-0000-4000-8000-000000000001", provider: "slack", browser: true }]);
  });

  it("refuses a token (the CLI) before asking the sign-in function, and never flags the other methods as browser starts", async () => {
    const calls: unknown[] = [];
    await expect(startAppIdentityLink(deps(calls), caller(false) as never, "slack")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(calls).toEqual([]);
    await startAppIdentityLink(deps(calls), caller(false) as never, "cloud");
    expect(calls).toEqual([{ kind: "start-identity-link", developerId: "a".repeat(64), sessionId: "00000000-0000-4000-8000-000000000001", provider: "cloud" }]);
  });
});

describe("the callback's remaining guards", () => {
  const cookieOf = (sessionId: string) => ({ cookie: `${SESSION_COOKIE}=${sessionId}` });

  it("refuses a code made under another request's nonce, and links nothing", async () => {
    const w = await world();
    const startedA = await start(w.h, w.account, w.session.sessionId) as { ok: true; authorizeUrl: string };
    const startedB = await start(w.h, w.account, w.session.sessionId) as { ok: true; authorizeUrl: string };
    const toSlack = async (authorizeUrl: string) => { const url = new URL(authorizeUrl); return (await w.h.http(httpEvent("GET", url.pathname + url.search))).headers.location!; };
    const slackA = await toSlack(startedA.authorizeUrl);
    const slackB = await toSlack(startedB.authorizeUrl);
    // Slack answers request A's authorization (A's nonce is in the ID token) but the callback names request B's state.
    const callback = w.h.slack.approve(slackA, OWNER_SLACK).replace(/state=[^&]*/, `state=${new URL(slackB).searchParams.get("state")!}`);
    expect(outcomeOf(await w.h.http(httpEvent("GET", callback, undefined, cookieOf(w.session.sessionId))))).toBe("refused");
    expect(w.h.db.get(signInIdentityKey(slackKey(OWNER_SLACK)))).toBeUndefined();
    expect(w.audit.recordedBy("identity.linked").filter((event) => event.actor.id === w.account)).toEqual([]);
  });

  it("refuses when the account belongs to no company, so there is no bound team to match", async () => {
    const w = await world();
    // UX1: the start itself refuses an account with no company (there is no workspace to link to); one that lost its company after starting is refused at the callback.
    const begun = await start(w.h, w.account, w.session.sessionId) as { ok: true; authorizeUrl: string };
    w.h.state.delete(`DEVELOPER_ORG#${w.account}`, "ORG");
    expect(await start(w.h, w.account, w.session.sessionId)).toEqual({ ok: false, error: "refused", message: SLACK_NO_WORKSPACE_MESSAGE });
    expect(outcomeOf(await finish(w.h, begun.authorizeUrl, OWNER_SLACK, { sessionId: w.session.sessionId }))).toBe("wrong_team");
    expect(w.h.db.get(signInIdentityKey(slackKey(OWNER_SLACK)))).toBeUndefined();
  });

  it("two simultaneous links of two Slack accounts leave one link on the account, and the loser is told so", async () => {
    const w = await world();
    const a = await start(w.h, w.account, w.session.sessionId) as { ok: true; authorizeUrl: string };
    const b = await start(w.h, w.account, w.session.sessionId) as { ok: true; authorizeUrl: string };
    const outcomes = (await Promise.all([
      finish(w.h, a.authorizeUrl, OWNER_SLACK, { sessionId: w.session.sessionId }),
      finish(w.h, b.authorizeUrl, OTHER_SLACK, { sessionId: w.session.sessionId }),
    ])).map(outcomeOf).sort();
    expect(outcomes).toEqual(["has_one", "linked"]);
    expect((await w.h.deps.store.slackUserIdsOf(w.account))).toHaveLength(1);
  });

  it("the write itself refuses a second Slack link when both passed the earlier check (the marker in the transaction)", async () => {
    const w = await world();
    const input = (userId: string) => ({ developerId: w.account, identityKey: slackKey(userId), subject: userId, issuer: SLACK_ISSUER, by: { method: "cloud" as const }, belongsToCompany: false });
    const results = await Promise.all([w.h.deps.store.linkSlackIdentity(input(OWNER_SLACK)), w.h.deps.store.linkSlackIdentity(input(OTHER_SLACK))]);
    expect(results.map((result) => (result.ok ? "linked" : result.reason)).sort()).toEqual(["has_one", "linked"]);
    expect(await w.h.deps.store.slackUserIdsOf(w.account)).toHaveLength(1);
    // The loser wrote nothing at all.
    const winner = results[0].ok ? OWNER_SLACK : OTHER_SLACK, loser = winner === OWNER_SLACK ? OTHER_SLACK : OWNER_SLACK;
    expect(w.h.db.get(signInIdentityKey(slackKey(loser)))).toBeUndefined();
    expect(w.h.db.get(developerIdentityKey(w.account, slackKey(loser)))).toBeUndefined();
  });

  it("keeps the one-link marker with the link: set by the link, gone after the unlink, back with a re-link", async () => {
    const w = await world();
    const marker = () => w.h.db.get(`DEVELOPER#${w.account}`, "META")?.[SLACK_LINKED_ATTRIBUTE];
    expect(marker()).toBeUndefined();
    expect(outcomeOf(await link(w))).toBe("linked");
    expect(marker()).toBe(slackKey(OWNER_SLACK));
    h_tick(w.h, 1000);
    expect(await w.h.handler({ kind: "unlink-identity", developerId: w.account, sessionId: w.session.sessionId, provider: "slack" } as never)).toEqual({ ok: true });
    expect(marker()).toBeUndefined();
    h_tick(w.h, 1000);
    expect(outcomeOf(await link(w))).toBe("linked");
    expect(marker()).toBe(slackKey(OWNER_SLACK));
    // A different Slack account cannot be linked while this one is.
    const second = await start(w.h, w.account, w.session.sessionId);
    expect(second).toEqual({ ok: false, error: "refused", message: SLACK_LINK_HAS_ONE });
  });

  it("the app route removes a Slack link for a live browser session only", async () => {
    const calls: unknown[] = [];
    const deps = { developer: { unlinkIdentity: async (request: unknown) => { calls.push(request); return { ok: true as const }; } }, signInTableName: "signin", documentClient: { send: async () => ({}) }, tableName: "state" } as never;
    const caller = { developerId: "a".repeat(64), sessionId: "00000000-0000-4000-8000-000000000001" };
    await expect(unlinkAppIdentity(deps, caller as never, "slack")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(calls).toEqual([]);
    await unlinkAppIdentity(deps, { ...caller, browserSession: true } as never, "slack").catch(() => undefined);
    expect(calls).toEqual([{ kind: "unlink-identity", developerId: "a".repeat(64), sessionId: "00000000-0000-4000-8000-000000000001", provider: "slack" }]);
  });
});

// SLACK-LINK-1: the "already holds a company" check and the link are one atomic write. The link reads the Slack developer's company first (in the State table) and
// writes the sign-in table after; a sign-in of the same Slack account that creates or joins a company in between must not leave both. Both orders are covered.
describe("the link and a company for the same Slack account (SLACK-LINK-1)", () => {
  const ownerDeveloper = slackKey(OWNER_SLACK);
  const companyOf = (w: Awaited<ReturnType<typeof world>>) => w.h.state.get(`DEVELOPER_ORG#${ownerDeveloper}`, "ORG");

  it("join, then link: a company that appears after the callback read it (but before the write) refuses the link as 'taken', and nothing is merged or written", async () => {
    const w = await world();
    await w.h.signIn("slack", OWNER_SLACK);
    const real = w.h.orgs.orgForDeveloper.bind(w.h.orgs);
    let raced = false;
    // The callback's read of the Slack developer's company answers "none"; the other tab's sign-in then joins the company, before the link is written.
    vi.spyOn(w.h.orgs, "orgForDeveloper").mockImplementation(async (developerId: string) => {
      const answer = await real(developerId);
      if (developerId === ownerDeveloper && !raced) {
        raced = true;
        await w.h.orgs.addMember({ orgId: w.orgId, developerId: ownerDeveloper, role: "member" });
      }
      return answer;
    });
    expect(outcomeOf(await link(w))).toBe("taken");
    expect(raced).toBe(true);
    expect(companyOf(w)).toMatchObject({ orgId: w.orgId });
    expect(w.h.db.get(`DEVELOPER#${ownerDeveloper}`, "META")).not.toHaveProperty("mergedInto");
    expect(w.h.db.get(signInIdentityKey(ownerDeveloper))).toMatchObject({ developerId: ownerDeveloper });
    expect(w.h.db.get(developerIdentityKey(w.account, ownerDeveloper))).toBeUndefined();
    expect(w.h.db.get(`DEVELOPER#${w.account}`, "META")).not.toHaveProperty(SLACK_LINKED_ATTRIBUTE);
    expect(w.audit.recordedBy("identity.linked").filter((event) => event.actor.id === w.account)).toEqual([]);
  });

  it("the link write itself refuses a Slack developer that holds a company, whatever the caller read before (a stale 'no company')", async () => {
    const w = await world();
    await w.h.signIn("slack", OWNER_SLACK);
    await w.h.orgs.addMember({ orgId: w.orgId, developerId: ownerDeveloper, role: "member" });
    const result = await w.h.deps.store.linkSlackIdentity({ developerId: w.account, identityKey: ownerDeveloper, subject: OWNER_SLACK, issuer: SLACK_ISSUER, by: { method: "cloud" }, belongsToCompany: false });
    expect(result).toEqual({ ok: false, reason: "taken" });
    expect(w.h.db.get(`DEVELOPER#${ownerDeveloper}`, "META")).not.toHaveProperty("mergedInto");
  });

  it("link, then join: once the link has landed, the Slack developer can no longer create or join a company (create, add and accept an invite all refuse), and no company is written", async () => {
    const w = await world();
    await w.h.signIn("slack", OWNER_SLACK);
    expect(outcomeOf(await link(w))).toBe("linked");
    // The other tab's sign-in had already decided "this Slack developer has no company" and now writes it.
    await expect(w.h.orgs.createOrgWithOwner({ name: "Late team", developerId: ownerDeveloper })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    await expect(w.h.orgs.addMember({ orgId: w.orgId, developerId: ownerDeveloper, role: "member" })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    const { token } = await w.h.orgs.createInvite({ orgId: w.orgId, createdBy: w.account, role: "member" });
    const { inviteTokenHash } = await import("../../packages/broker/src/org/invite-url.js");
    await expect(w.h.orgs.acceptInvite({ tokenHash: inviteTokenHash(token), developerId: ownerDeveloper })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(companyOf(w)).toBeUndefined();
    expect(w.h.state.get(`ORG#${w.orgId}#MEMBER#${ownerDeveloper}`, "META")).toBeUndefined();
    // The web account is unaffected and the Slack mention still resolves to its company.
    expect(await w.h.deps.store.developerOfSlackUser(OWNER_SLACK)).toBe(w.account);
  });

  it("two tabs at once: a Slack sign-in joining a company and the link race; exactly one of them wins, never both", async () => {
    for (let round = 0; round < 6; round += 1) {
      const w = await world();
      await w.h.signIn("slack", OWNER_SLACK);
      const started = await start(w.h, w.account, w.session.sessionId) as { ok: true; authorizeUrl: string };
      const [outcome, joined] = await Promise.all([
        finish(w.h, started.authorizeUrl, OWNER_SLACK, { sessionId: w.session.sessionId }).then(outcomeOf),
        w.h.orgs.addMember({ orgId: w.orgId, developerId: ownerDeveloper, role: "member" }).then(() => true, () => false),
      ]);
      const merged = w.h.db.get(`DEVELOPER#${ownerDeveloper}`, "META")?.mergedInto === w.account;
      expect(merged && companyOf(w) !== undefined).toBe(false);
      expect(joined ? "taken" : "linked").toBe(outcome);
      expect(merged).toBe(outcome === "linked");
    }
  });

  it("a browser sign-in that loses the join race to a link is told to sign in again (the signed-out page), gets no session, and no company is written", async () => {
    const w = await world();
    const real = w.h.orgs.createOrgWithOwner.bind(w.h.orgs);
    let linked = false;
    // The link (another tab) lands on the signing-in developer between the sign-in's decision and its company write.
    vi.spyOn(w.h.orgs, "createOrgWithOwner").mockImplementation(async (input) => {
      if (!linked) {
        linked = true;
        const developers = w.h.db.find((item) => String(item.pk).startsWith("DEVELOPER#") && item.sk === "META" && item.subject === zed.sub);
        expect(developers).toHaveLength(1);
        w.h.db.set({ ...developers[0]!, mergedInto: w.account });
      }
      return real(input);
    });
    const chooser = await w.h.http(httpEvent("GET", "/v1/auth/browser/authorize?return_to=%2Fapp%2Fwelcome&intent=create"));
    const cookie = chooser.cookies!.find((value) => value.startsWith("__Host-agentx_review_pkce="))!.split(";")[0]!;
    const cloudLink = /href="([^"]*method=cloud)"/.exec(chooser.body)![1]!.replaceAll("&amp;", "&");
    const toProvider = await w.h.http({ ...httpEvent("GET", cloudLink), headers: { cookie } });
    const done = await w.h.http({ ...httpEvent("GET", w.h.oidc.approve(toProvider.headers.location!, zed.sub)), headers: { cookie } });
    expect(linked).toBe(true);
    expect(done.statusCode).toBe(302);
    expect(done.headers.location).toBe("/app/signed-out?reason=ended");
    expect(done.cookies?.some((value) => value.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
    expect(w.h.state.find((item) => String(item.pk).startsWith("DEVELOPER_ORG#") && !String(item.pk).endsWith(w.account))).toHaveLength(0);
  });
});
