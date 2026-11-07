// UX1 (platform UX "one connected experience", slice 1 "First day"): the broker and web-server halves of joining, signing up, linking GitHub, emailing an
// invite, sign-in failure reasons and the Slack link's "no workspace" answer. Each security rule has a negative case: invites stay single-use and
// emailed only to their own address, a GitHub link needs this account's live browser session AND GitHub's proof, and an identity that is someone
// else's is refused.
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentXError, FRESH_SIGN_IN_SECONDS, ReviewedInviteCreateBodySchema, developerOrgKey, orgMemberKey, orgMetaKey } from "@agentx/contracts";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { createReviewedOrganizationInvite, inviteCreateBodyHash } from "../../packages/broker/src/org/invite-creation.js";
import { INVITE_EMAILS_PER_INSTALL_PER_DAY, INVITE_EMAILS_PER_ORG_PER_DAY, inviteEmailText, sendInviteEmail } from "../../packages/broker/src/org/invite-email.js";
import { listOrganizationInvites } from "../../packages/broker/src/org/invite-directory.js";
import { createDeveloperIdentityHandler, type HttpResult } from "../../packages/broker/src/developer/server.js";
import { GITHUB_LINK_HAS_ONE, signInIdentityKey } from "../../packages/broker/src/developer/store.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { webRouteAllowed } from "../../packages/broker/src/aws/web-auth.js";
import { startAppIdentityLink, getAppMe } from "../../packages/broker/src/aws/developer-routes/organization.js";
import { createAppHandler } from "../../packages/web/src/server/handler.js";
import { JOIN_TOKEN_PATTERN } from "../../packages/web/src/server/join.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { API, ISSUER, OIDC_ISSUER, T0, httpEvent, identityHarness, type FakeGithubUser, type FakeOidcUser } from "../support/developer-fakes.js";

/** The same dependencies with no notice sender at all (exactOptionalPropertyTypes: the key is absent, not undefined). */
function withoutOwnerNotice(deps: DeveloperRouteDependencies): DeveloperRouteDependencies {
  const copy = { ...deps };
  delete copy.ownerNotice;
  return copy;
}


const token43 = () => randomUUID().replaceAll("-", "").padEnd(43, "x").slice(0, 43);
const GITHUB_ISSUER = "https://github.com";
const SESSION_COOKIE = "__Host-agentx_review_session";

describe("the app's own origin answers an invite link (/join)", () => {
  let directory: string;
  beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), "rovara-ux1-join-"));await writeFile(join(directory, "index.html"), "<!doctype html><html><head></head><body></body></html>"); });
  afterAll(async () => { if (directory !== undefined) await rm(directory, { recursive: true, force: true }); });
  const app = (canonicalOrigin = "") => createAppHandler({ appDirectory: directory, assetOrigin: "", realtimeHttpHost: "", realtimeWsHost: "", canonicalOrigin });
  const event = (rawPath: string, rawQueryString = "", headers: Record<string, string> = {}) => ({ rawPath, rawQueryString, headers, requestContext: { http: { method: "GET" } } });

  it("serves a script page for the fragment form that forwards only a well-formed token to the same origin's invite page, and stores nothing", async () => {
    const page = await app()(event("/join"));
    expect(page.statusCode).toBe(200);
    const nonce = /<script nonce="([A-Za-z0-9_-]+)">/.exec(page.body)?.[1];
    expect(nonce).toBeTruthy();
    expect(page.headers["content-security-policy"]).toBe(`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'`);
    expect(page.headers).toMatchObject({ "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY" });
    expect(page.body).toContain('"/v1/auth/join?invite="');
    expect(page.body).toContain("/^#invite=([A-Za-z0-9_-]{43})$/");
    expect(page.body).toContain('href="/app/signup"');
    expect(page.body).not.toContain("agentx");
  });

  it("moves the query form straight to the invite page, and never forwards a malformed token", async () => {
    const token = token43();
    expect(JOIN_TOKEN_PATTERN.test(token)).toBe(true);
    const moved = await app()(event("/join", `invite=${token}`));
    expect([moved.statusCode, moved.headers.location]).toEqual([302, `/v1/auth/join?invite=${token}`]);
    for (const bad of ["short", `${token}x`, "a/b".padEnd(43, "c"), "%2F".padEnd(43, "d")]) {
      const response = await app()(event("/join", `invite=${encodeURIComponent(bad)}`));
      expect(response.statusCode, bad).toBe(200);
      expect(response.headers.location).toBeUndefined();
    }
  });

  it("sends /join on the API's own address to the custom domain first (the fragment rides along), so the join's cookie is the app host's", async () => {
    const moved = await app("https://staging.rovara.dev")(event("/join", "", { host: "abc123.execute-api.us-east-1.amazonaws.com" }));
    expect([moved.statusCode, moved.headers.location]).toEqual([307, "https://staging.rovara.dev/join"]);
    expect((await app("https://staging.rovara.dev")(event("/join", "", { host: "staging.rovara.dev" }))).statusCode).toBe(200);
  });

  it("still answers 404 for paths it does not own", async () => {
    for (const path of ["/joinx", "/join/start", "/v1/auth/join"]) expect((await app()(event(path))).statusCode, path).toBe(404);
  });
});

describe("the sign-in server moves an invite opened on the API's own address to the custom domain", () => {
  const CUSTOM = "https://staging.rovara.dev";
  it("redirects the browser join pages, and leaves the CLI's JSON form and other pages on the old host", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [], singleOrg: false });
    const handler = createDeveloperIdentityHandler({ ...h.deps, config: { ...h.deps.config, issuer: `${CUSTOM}/v1/auth`, legacyIssuer: ISSUER } });
    const onLegacy = (path: string, headers: Record<string, string> = {}) => handler({ ...httpEvent("GET", path), headers: { host: new URL(API).host, ...headers } }) as Promise<HttpResult>;
    const token = token43();
    for (const path of [`/v1/auth/join?invite=${token}`, `/v1/auth/join/start?invite=${token}`]) {
      const moved = await onLegacy(path, { accept: "text/html" });
      expect([moved.statusCode, moved.headers.location], path).toEqual([302, `${CUSTOM}${path}`]);
    }
    // An empty query moves without a stray "?", and only GET moves: HEAD and POST stay on the old host's own server.
    const bare = await onLegacy("/v1/auth/join", { accept: "text/html" });
    expect([bare.statusCode, bare.headers.location]).toEqual([302, `${CUSTOM}/v1/auth/join`]);
    for (const method of ["HEAD", "POST"]) {
      const base = httpEvent("GET", `/v1/auth/join?invite=${token}`, undefined, { host: new URL(API).host, accept: "text/html" });
      const context = base.requestContext;
      if (context === undefined) throw new Error("httpEvent built no requestContext");
      const kept = await handler({ ...base, requestContext: { ...context, http: { ...context.http, method } } }) as HttpResult;
      expect(kept.headers.location ?? "", method).not.toContain(CUSTOM);
    }
    const json = await onLegacy(`/v1/auth/join?invite=${token}`, { accept: "application/json" });
    expect(json.statusCode).toBe(404);
    expect(JSON.parse(json.body)).toEqual({ state: "unknown" });
  });
});

describe("invites can be emailed through the existing notice sender only", () => {
  const A = "org_aaaaaaaaaaaaaaaaaaaa", who = "a".repeat(64);
  function fixture(notice?: { fail?: boolean; from?: string }, shared?: FakeDynamoDb) {
    const db = shared ?? new FakeDynamoDb();let nowMs = Date.parse("2026-11-07T12:00:00Z");const now = () => nowMs;
    db.set({ ...orgMemberKey(A, who), orgId: A, developerId: who, role: "owner" });db.set({ ...developerOrgKey(who), orgId: A, role: "owner" });db.set({ ...orgMetaKey(A), orgId: A, name: "Acme", plan: "team" });
    const capture = capturingAuditDeps({ db, now }), store = new OrgStore({ documentClient: db, tableName: "state", now, audit: capture.audit });
    const send = vi.fn(async () => { if (notice?.fail === true) throw Object.assign(new Error("refused"), { name: "MessageRejected" });return {}; });
    const logs: Array<Record<string, unknown>> = [];
    const deps = { documentClient: db, tableName: "state", now, orgs: store, audit: capture.audit, cloud: true,
      developer: { issuer: "https://cell.example/v1/auth", env: "test", signInTableName: "signin", methods: { cloud: true, slack: false, oidc: false }, verifyAccessToken: async () => ({}), channelMembers: async () => ({ ok: true, memberOf: [] }) },
      ...(notice === undefined ? {} : { ownerNotice: { ses: { send } as never, from: notice.from ?? "Rovara <notices@cell.example>", log: (entry: Record<string, unknown>) => logs.push(entry) } }) } as unknown as DeveloperRouteDependencies;
    const caller = { orgId: A, developerId: who, orgRole: "owner", name: "Maya Chen", amr: "cloud", sessionId: "fixture" } as DeveloperCaller;
    return { db, deps, caller, send, logs, advance: (ms: number) => { nowMs += ms; } };
  }

  it("emails the link once, to the invite's own address, from the configured notice sender, and still returns the link", async () => {
    const f = fixture({}), body = { requestId: randomUUID(), role: "member", email: "Bea@Example.test", sendEmail: true };
    const result = await createReviewedOrganizationInvite(f.deps, f.caller, body) as { inviteUrl: string; email: string };
    expect(result.email).toBe("sent");
    expect(result.inviteUrl).toMatch(/^https:\/\/cell\.example\/join#invite=[A-Za-z0-9_-]{43}$/);
    expect(f.send).toHaveBeenCalledTimes(1);
    const input = (f.send.mock.calls[0] as unknown as [{ input: { FromEmailAddress: string; Destination: { ToAddresses: string[] }; Content: { Simple: { Subject: { Data: string }; Body: { Text: { Data: string } } } } } }])[0].input;
    expect(input.FromEmailAddress).toBe("Rovara <notices@cell.example>");
    expect(input.Destination.ToAddresses).toEqual(["bea@example.test"]);
    // UX1 review I2: a fixed subject; the company's chosen names appear only in the body, in quotes.
    expect(input.Content.Simple.Subject.Data).toBe("You're invited to join a company on Rovara");
    expect(input.Content.Simple.Body.Text.Data).toMatch(/^"Maya Chen" invited you to join the company "Acme" on Rovara as a member\./);
    expect(input.Content.Simple.Body.Text.Data).toContain(result.inviteUrl);
    // No address, name or link in the logs.
    expect(JSON.stringify(f.logs)).not.toMatch(/bea@|Maya|invite=/i);
    // A replay of the same request never mints, returns or emails the bearer again.
    const replay = await createReviewedOrganizationInvite(f.deps, f.caller, body) as { inviteUrl?: string; email?: string };
    expect(replay.inviteUrl).toBeUndefined();expect(replay.email).toBeUndefined();expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("stays copy-only where no sender is configured, and a failed send never loses the link", async () => {
    const none = fixture();
    const noSender = await createReviewedOrganizationInvite(withoutOwnerNotice(none.deps), none.caller, { requestId: randomUUID(), role: "member", email: "bea@example.test", sendEmail: true }) as { inviteUrl: string; email: string };
    expect(noSender.email).toBe("not_set_up");expect(noSender.inviteUrl).toContain("/join#invite=");
    const emptyFrom = fixture({ from: "" });
    expect((await createReviewedOrganizationInvite(emptyFrom.deps, emptyFrom.caller, { requestId: randomUUID(), role: "member", email: "bea@example.test", sendEmail: true }) as { email: string }).email).toBe("not_set_up");
    expect(emptyFrom.send).not.toHaveBeenCalled();
    const failing = fixture({ fail: true });
    const failed = await createReviewedOrganizationInvite(failing.deps, failing.caller, { requestId: randomUUID(), role: "member", email: "bea@example.test", sendEmail: true }) as { inviteUrl: string; email: string };
    expect(failed.email).toBe("failed");expect(failed.inviteUrl).toContain("/join#invite=");
    expect(failing.logs).toEqual([{ event: "org.invite_email_failed", error: "MessageRejected" }]);
  });

  it("sends nothing unless asked, refuses an emailed link-only invite, and keeps the stored intent hash unchanged", async () => {
    const f = fixture();
    const plain = await createReviewedOrganizationInvite(f.deps, f.caller, { requestId: randomUUID(), role: "member", email: "bea@example.test" }) as { email?: string };
    expect(plain.email).toBeUndefined();expect(f.send).not.toHaveBeenCalled();
    expect(ReviewedInviteCreateBodySchema.safeParse({ requestId: randomUUID(), role: "member", sendEmail: true }).success).toBe(false);
    await expect(createReviewedOrganizationInvite(f.deps, f.caller, { requestId: randomUUID(), role: "member", sendEmail: true })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(f.send).not.toHaveBeenCalled();
    // The digest receipts stored before UX1 were written with: sha256 of {"action","role","email"}.
    const legacy = createHash("sha256").update(JSON.stringify({ action: "org.invite_created", role: "member", email: "bea@example.test" })).digest("hex");
    expect(inviteCreateBodyHash({ role: "member", email: "bea@example.test" })).toBe(legacy);
    expect(inviteCreateBodyHash({ role: "member", email: "bea@example.test", sendEmail: true } as never)).toBe(legacy);
  });

  it("refuses a member, and an email to a different address than the invite's is impossible by construction", async () => {
    const f = fixture();
    await expect(createReviewedOrganizationInvite(f.deps, { ...f.caller, developerId: "c".repeat(64) }, { requestId: randomUUID(), role: "member", email: "bea@example.test", sendEmail: true })).rejects.toBeInstanceOf(AgentXError);
    expect(f.send).not.toHaveBeenCalled();
    expect(inviteEmailText({ to: "x", orgName: "Acme\nBcc: evil", inviterName: "Maya\r\n", role: "admin", inviteUrl: "https://cell.example/join#invite=t", expiresAt: "2026-11-14T12:00:00Z" })).toMatch(/^"Maya" invited you to join the company "Acme Bcc: evil" on Rovara as an admin\./);
    expect(await sendInviteEmail(undefined, { to: "x@example.test", orgName: "A", inviterName: "B", role: "member", inviteUrl: "u", expiresAt: "2026-11-14T12:00:00Z" })).toBe("not_set_up");
  });

  it("caps invite email: once per address per day, and at most 50 a day per company; past either the link is still returned and nothing is sent", async () => {
    const f = fixture({});
    // Four seconds apart, so the creation rate limit (20 a minute) never answers first; all inside one UTC day.
    const make = (email: string) => { f.advance(4_000);return createReviewedOrganizationInvite(f.deps, f.caller, { requestId: randomUUID(), role: "member", email, sendEmail: true }) as Promise<{ inviteUrl: string; email: string }>; };
    expect((await make("bea@example.test")).email).toBe("sent");
    const again = await make("BEA@example.test");
    expect(again.email).toBe("limited");expect(again.inviteUrl).toContain("/join#invite=");
    expect(f.send).toHaveBeenCalledTimes(1);
    // The repeat above used one of the company's 50 (only the address's own slot is protected from denials), so 48 more fill the day.
    for (let index = 1; index < INVITE_EMAILS_PER_ORG_PER_DAY - 1; index += 1) expect((await make(`person${index}@example.test`)).email).toBe("sent");
    expect(f.send).toHaveBeenCalledTimes(INVITE_EMAILS_PER_ORG_PER_DAY - 1);
    const over = await make("one-more@example.test");
    expect(over.email).toBe("limited");expect(over.inviteUrl).toContain("/join#invite=");
    expect(f.send).toHaveBeenCalledTimes(INVITE_EMAILS_PER_ORG_PER_DAY - 1);
    // The next UTC day the address may be emailed again.
    f.advance(86_400_000);
    expect((await make("bea@example.test")).email).toBe("sent");
    // The counters never hold an address.
    expect(JSON.stringify(f.db.find((row) => String(row.pk).includes("INVITE_EMAIL")))).not.toContain("bea@");
    expect(JSON.stringify(f.db.find((row) => String(row.pk).includes("INVITE_EMAIL")))).not.toContain("@example.test");
  });

  it("emails an address once a day across every company: a second company's invite to it the same day is limited", async () => {
    const db = new FakeDynamoDb(), first = fixture({}, db), second = fixture({}, db);
    const B = "org_bbbbbbbbbbbbbbbbbbbb", other = "d".repeat(64);
    db.set({ ...orgMemberKey(B, other), orgId: B, developerId: other, role: "owner" });db.set({ ...developerOrgKey(other), orgId: B, role: "owner" });db.set({ ...orgMetaKey(B), orgId: B, name: "Other Co", plan: "team" });
    const make = (f: ReturnType<typeof fixture>, caller: DeveloperCaller) => createReviewedOrganizationInvite(f.deps, caller, { requestId: randomUUID(), role: "member", email: "bea@example.test", sendEmail: true }) as Promise<{ inviteUrl: string; email: string }>;
    expect((await make(first, first.caller)).email).toBe("sent");
    const fromB = await make(second, { ...second.caller, orgId: B, developerId: other });
    expect(fromB.email).toBe("limited");expect(fromB.inviteUrl).toContain("/join#invite=");
    expect(first.send.mock.calls.length + second.send.mock.calls.length).toBe(1);
  });

  it("stops at the install-wide daily ceiling, and a company or install denial does not spend the address's slot", async () => {
    const f = fixture({});
    const make = (email: string) => { f.advance(4_000);return createReviewedOrganizationInvite(f.deps, f.caller, { requestId: randomUUID(), role: "member", email, sendEmail: true }) as Promise<{ inviteUrl: string; email: string }>; };
    // The install has sent all but one of today's emails; this company has sent all of its own.
    const window = Math.floor(Date.parse("2026-11-07T12:00:00Z") / 86_400_000) * 86_400_000;
    const counter = (pk: string, sk: string, count: number) => f.db.set({ pk, sk, windowStart: window, count, expiresAt: Math.floor(window / 1000) + 172_800 });
    counter(`ORG#${A}#INVITE_EMAIL_DAY`, "company", INVITE_EMAILS_PER_ORG_PER_DAY);
    expect((await make("fresh@example.test")).email).toBe("limited");
    expect(f.send).not.toHaveBeenCalled();
    // The company denial left the address's slot unspent: with room again, the same address is emailed.
    counter(`ORG#${A}#INVITE_EMAIL_DAY`, "company", 0);
    counter("INVITE_EMAIL_INSTALL_DAY", "install", INVITE_EMAILS_PER_INSTALL_PER_DAY);
    expect((await make("fresh@example.test")).email).toBe("limited");
    counter("INVITE_EMAIL_INSTALL_DAY", "install", INVITE_EMAILS_PER_INSTALL_PER_DAY - 1);
    expect((await make("fresh@example.test")).email).toBe("sent");
    expect((await make("another@example.test")).email).toBe("limited");
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("keeps a company name that carries a link in quotes in the body and out of the subject", async () => {
    const f = fixture({});
    f.db.set({ ...orgMetaKey(A), orgId: A, name: "Acme Payroll - verify your account at evil.example", plan: "team" });
    await createReviewedOrganizationInvite(f.deps, f.caller, { requestId: randomUUID(), role: "member", email: "bea@example.test", sendEmail: true });
    const input = (f.send.mock.calls[0] as unknown as [{ input: { Content: { Simple: { Subject: { Data: string }; Body: { Text: { Data: string } } } } } }])[0].input;
    expect(input.Content.Simple.Subject.Data).not.toContain("evil.example");
    expect(input.Content.Simple.Body.Text.Data).toContain('the company "Acme Payroll - verify your account at evil.example" on Rovara');
  });

  it("tells the invites screen whether email is set up here", async () => {
    for (const [notice, expected] of [[undefined, false], [{}, true]] as const) {
      const f = fixture(notice);
      const listed = await listOrganizationInvites(notice === undefined ? withoutOwnerNotice(f.deps) : f.deps, f.caller, new URL("https://cell.example/v1/app/org/invites?limit=25"));
      expect(listed.emailDelivery).toBe(expected);
    }
  });
});

describe("sign-up never creates a company silently (OWNER DECISION 5)", () => {
  beforeEach(() => { vi.useFakeTimers({ now: T0, toFake: ["Date"] }); });
  afterEach(() => { vi.useRealTimers(); });
  const bea: FakeOidcUser = { sub: "bea-ux1", name: "Bea Ortiz", email: "bea@example.test", email_verified: true };
  async function browserSignIn(h: ReturnType<typeof identityHarness>, user: string, query = "") {
    const start = await h.http(httpEvent("GET", `/v1/auth/browser/authorize?return_to=%2Fapp%2Fwelcome${query}`));
    expect(start.statusCode).toBe(302);
    const cookie = start.cookies!.find((value) => value.startsWith("__Host-agentx_review_pkce="))!.split(";")[0]!;
    return h.http({ ...httpEvent("GET", h.oidc.approve(start.headers.location!, user)), headers: { cookie } });
  }

  it("a new person without 'Create a company' gets no company, no session, and the no_account reason", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [bea], slack: false, singleOrg: false });
    const done = await browserSignIn(h, bea.sub);
    expect(done.headers.location).toBe("/app/signed-out?reason=no_account");
    expect(done.cookies?.some((value) => value.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
    expect(await h.orgs.orgForDeveloper(ownerKeyForSubject(OIDC_ISSUER, bea.sub))).toBeUndefined();
    expect(h.state.find((item) => item.entityType === "ORG")).toHaveLength(0);
    expect(h.db.find((item) => String(item.pk).startsWith("SESSION#"))).toHaveLength(0);
  });

  it("'Create a company' creates one, with the person as owner and a session", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [bea], slack: false, singleOrg: false });
    expect((await browserSignIn(h, bea.sub)).headers.location).toBe("/app/signed-out?reason=no_account");
    const done = await browserSignIn(h, bea.sub, "&intent=create");
    expect(done.headers.location).toBe("/app/welcome");
    expect(done.cookies?.some((value) => value.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
    expect(await h.orgs.orgForDeveloper(ownerKeyForSubject(OIDC_ISSUER, bea.sub))).toMatchObject({ role: "owner" });
  });

  it("someone who already has a company signs in without the intent as always, and the CLI sign-in is unchanged", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [bea], slack: false, singleOrg: false });
    const orgId = await h.orgs.createOrgWithOwner({ name: "Bea's team", developerId: ownerKeyForSubject(OIDC_ISSUER, bea.sub) });
    const done = await browserSignIn(h, bea.sub);
    expect(done.headers.location).toBe("/app/welcome");
    expect(await h.orgs.orgForDeveloper(ownerKeyForSubject(OIDC_ISSUER, bea.sub))).toEqual({ orgId, role: "owner" });
    const fresh = identityHarness({ cloud: {}, oidcUsers: [bea], slack: false, singleOrg: false });
    expect((await fresh.signIn("cloud", bea.sub)).searchParams.get("code")).toBeTruthy();
  });
});

describe("the Cloud sign-in page offers only methods that can work there", () => {
  // OWNER DECISION 13 (SLACK-SIGNIN-KEEP): Slack stays on the Cloud page, because it signs in anyone whose Slack account is linked; company sign-in goes.
  it("keeps Slack on the Cloud browser page and leaves company sign-in off it", async () => {
    const cloud = identityHarness({ cloud: {}, oidcUsers: [], singleOrg: false });
    const chooser = await cloud.http(httpEvent("GET", "/v1/auth/browser/authorize?return_to=%2Fapp"));
    expect(chooser.statusCode).toBe(200);
    expect(chooser.body).toContain("Sign in with Slack");
    expect(chooser.body).not.toContain("method=oidc");
  });

  it("signs a person in by Slack on Cloud when that Slack account is linked to their account, and says method_unavailable otherwise", async () => {
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
    try {
      const priya: FakeOidcUser = { sub: "priya-slack-ux1", name: "Priya", email: "priya@acme.dev", email_verified: true };
      const h = identityHarness({ cloud: {}, oidcUsers: [priya], slackUsers: [{ userId: "U0LINKED001", name: "Priya", email: "priya@acme.dev", emailVerified: true }, { userId: "U0STRANGER1", name: "Sam", email: "sam@else.dev", emailVerified: true }], singleOrg: false, sharedTable: true });
      const account = ownerKeyForSubject(OIDC_ISSUER, priya.sub);
      await h.deps.store.upsertDeveloper({ developerId: account, provider: "cloud", issuer: OIDC_ISSUER, subject: priya.sub, displayName: "Priya" });
      const orgId = await h.orgs.createOrgWithOwner({ name: "Acme", developerId: account });
      const linked = await h.deps.store.linkSlackIdentity({ developerId: account, identityKey: ownerKeyForSubject("https://slack.com", "U0LINKED001"), subject: "U0LINKED001", issuer: "https://slack.com", by: { method: "cloud" }, belongsToCompany: false });
      expect(linked).toMatchObject({ ok: true });
      const viaSlack = async (userId: string) => {
        const chooser = await h.http(httpEvent("GET", "/v1/auth/browser/authorize?return_to=%2Fapp"));
        const pkce = chooser.cookies!.find((value) => value.startsWith("__Host-agentx_review_pkce="))!.split(";")[0]!;
        const link = /href="([^"]*method=slack)"/.exec(chooser.body)![1]!.replaceAll("&amp;", "&");
        const toSlack = await h.http({ ...httpEvent("GET", link), headers: { cookie: pkce } });
        return h.http({ ...httpEvent("GET", h.slack.approve(toSlack.headers.location!, userId)), headers: { cookie: pkce } });
      };
      const done = await viaSlack("U0LINKED001");
      expect(done.headers.location).toBe("/app");
      expect(done.cookies?.some((value) => value.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
      expect(await h.orgs.orgForDeveloper(account)).toEqual({ orgId, role: "owner" });
      const stranger = await viaSlack("U0STRANGER1");
      expect(stranger.headers.location).toBe("/app/signed-out?reason=method_unavailable");
      expect(stranger.cookies?.some((value) => value.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});

describe("linking a GitHub account from the web app, for any sign-in method", () => {
  beforeEach(() => { vi.useFakeTimers({ now: T0, toFake: ["Date"] }); });
  afterEach(() => { vi.useRealTimers(); });
  const priya: FakeOidcUser = { sub: "priya-ux1", name: "Priya Rao", email: "priya@acme.dev", email_verified: true };
  const octo: FakeGithubUser = { id: 9001, login: "priya-gh", name: "Priya", emails: [{ email: "priya@personal.dev", primary: true, verified: true }] };
  const other: FakeGithubUser = { id: 9002, login: "someone-else", name: "Someone", emails: [{ email: "someone@else.dev", primary: true, verified: true }] };

  /** Priya, signed in by email code in the browser, with a company of her own (made by "Create a company"). */
  async function world() {
    const h = identityHarness({ cloud: {}, oidcUsers: [priya], github: { users: [octo, other] }, slack: false, singleOrg: false });
    const start = await h.http(httpEvent("GET", "/v1/auth/browser/authorize?return_to=%2Fapp&intent=create"));
    const chooserLink = /href="([^"]*method=cloud)"/.exec(start.body)?.[1]?.replaceAll("&amp;", "&");
    const pkce = start.cookies!.find((value) => value.startsWith("__Host-agentx_review_pkce="))!.split(";")[0]!;
    const toProvider = await h.http({ ...httpEvent("GET", chooserLink!), headers: { cookie: pkce } });
    const done = await h.http({ ...httpEvent("GET", h.oidc.approve(toProvider.headers.location!, priya.sub)), headers: { cookie: pkce } });
    const sessionId = done.cookies!.find((value) => value.startsWith(`${SESSION_COOKIE}=`))!.split(";")[0]!.split("=")[1]!;
    const account = ownerKeyForSubject(OIDC_ISSUER, priya.sub);
    const orgId = (await h.orgs.orgForDeveloper(account))!.orgId;
    return { h, sessionId, account, orgId };
  }
  const start = (w: Awaited<ReturnType<typeof world>>, extra: Record<string, unknown> = { browser: true, returnTo: "/app/onboard" }) =>
    w.h.handler({ kind: "start-identity-link", developerId: w.account, sessionId: w.sessionId, provider: "github", ...extra } as never) as Promise<{ ok: boolean; authorizeUrl?: string; error?: string; message?: string }>;
  async function finish(w: Awaited<ReturnType<typeof world>>, authorizeUrl: string, githubId: number, cookie: string | null = `${SESSION_COOKIE}=${w.sessionId}`) {
    const url = new URL(authorizeUrl);
    const toGithub = await w.h.http(httpEvent("GET", url.pathname + url.search));
    expect(toGithub.statusCode).toBe(302);
    const callback = w.h.github.approve(toGithub.headers.location!, githubId);
    return w.h.http(httpEvent("GET", callback, undefined, cookie === null ? {} : { cookie }));
  }
  const outcome = (page: HttpResult) => { expect(page.statusCode).toBe(302);const url = new URL(page.headers.location!);return { path: url.pathname, value: url.searchParams.get("github_link") }; };

  it("links GitHub to THIS account: no second company, trial or session, and the GitHub login is shown back", async () => {
    const w = await world();
    const orgsBefore = w.h.state.find((item) => item.entityType === "ORG").length;
    const started = await start(w);
    expect(started.ok).toBe(true);
    expect(outcome(await finish(w, started.authorizeUrl!, 9001))).toEqual({ path: "/app/onboard", value: "linked" });
    const key = ownerKeyForSubject(GITHUB_ISSUER, "9001");
    expect(w.h.db.get(signInIdentityKey(key))).toMatchObject({ developerId: w.account, provider: "github", login: "priya-gh" });
    expect(await w.h.deps.store.githubUserIdOf(w.account)).toBe("9001");
    expect(await w.h.orgs.orgForDeveloper(key)).toBeUndefined();
    expect(await w.h.orgs.orgForDeveloper(w.account)).toMatchObject({ orgId: w.orgId, role: "owner" });
    expect(w.h.state.find((item) => item.entityType === "ORG")).toHaveLength(orgsBefore);
    expect(w.h.db.find((item) => String(item.pk).startsWith("SESSION#"))).toHaveLength(1);
    // A second link is refused at the start.
    expect(await start(w)).toEqual({ ok: false, error: "refused", message: GITHUB_LINK_HAS_ONE });
  });

  it("is refused from a browser that does not hold the session that started it, and links nothing", async () => {
    const w = await world();
    const started = await start(w);
    for (const cookie of [null, `${SESSION_COOKIE}=11111111-1111-4111-8111-111111111111`]) {
      const again = await start(w);
      expect(outcome(await finish(w, again.authorizeUrl!, 9001, cookie)).value).toBe("wrong_browser");
    }
    expect(w.h.db.get(signInIdentityKey(ownerKeyForSubject(GITHUB_ISSUER, "9001")))).toBeUndefined();
    expect(started.ok).toBe(true);
  });

  it("refuses a GitHub account that already belongs to another account with a company (no account takeover)", async () => {
    const w = await world();
    // Someone signed in with that GitHub account on their own and made a company.
    const code = (await w.h.signIn("github", "9002")).searchParams.get("code");
    expect(code).toBeTruthy();
    const theirs = ownerKeyForSubject(GITHUB_ISSUER, "9002");
    expect(await w.h.orgs.orgForDeveloper(theirs)).toBeDefined();
    const started = await start(w);
    expect(outcome(await finish(w, started.authorizeUrl!, 9002)).value).toBe("taken");
    expect(w.h.db.get(signInIdentityKey(theirs))).toMatchObject({ developerId: theirs });
    expect(await w.h.deps.store.githubUserIdOf(w.account)).toBeUndefined();
  });

  it("needs a fresh sign-in at the callback, and the CLI's add-back path is unchanged (no browser flag, no returnTo)", async () => {
    const w = await world();
    const started = await start(w);
    // The session's sign-in is older than the fresh window (the link request itself is still alive).
    const session = w.h.db.get(`SESSION#${w.sessionId}`, "META")!;
    w.h.db.set({ ...session, authTime: new Date(Date.now() - (FRESH_SIGN_IN_SECONDS + 5) * 1000).toISOString() });
    expect(outcome(await finish(w, started.authorizeUrl!, 9001)).value).toBe("reauth");
    expect(w.h.db.get(signInIdentityKey(ownerKeyForSubject(GITHUB_ISSUER, "9001")))).toBeUndefined();
    const cli = await start(w, {});
    expect(cli).toMatchObject({ ok: false, error: "reauth" });
  });

  // UX1 review M2: a GitHub account removed earlier comes back with the one-per-account marker, so a second link racing it loses with has_one.
  it("relinks a removed GitHub account with its marker, and a second GitHub account then loses with has_one", async () => {
    const w = await world();
    const first = await start(w);
    expect(outcome(await finish(w, first.authorizeUrl!, 9001)).value).toBe("linked");
    const key = ownerKeyForSubject(GITHUB_ISSUER, "9001");
    await w.h.deps.store.unlinkIdentity({ developerId: w.account, sessionId: w.sessionId, provider: "github" });
    expect(w.h.db.get(signInIdentityKey(key))?.unlinkedFrom).toBe(w.account);
    expect(w.h.db.get(`DEVELOPER#${w.account}`, "META")?.githubLinkedIdentity).toBeUndefined();
    const again = await start(w);
    expect(outcome(await finish(w, again.authorizeUrl!, 9001)).value).toBe("linked");
    expect(w.h.db.get(`DEVELOPER#${w.account}`, "META")?.githubLinkedIdentity).toBe(key);
    const other = ownerKeyForSubject(GITHUB_ISSUER, "9002");
    expect(await w.h.deps.store.linkGithubIdentity({ developerId: w.account, identityKey: other, subject: "9002", issuer: GITHUB_ISSUER, by: { method: "cloud" }, belongsToCompany: false })).toEqual({ ok: false, reason: "has_one" });
  });

  it("refuses a GitHub account that was unlinked from a different account, and changes nothing", async () => {
    const w = await world();
    const zed = "e".repeat(64), key = ownerKeyForSubject(GITHUB_ISSUER, "9002"), at = new Date(T0).toISOString();
    const tombstone = { ...signInIdentityKey(key), entityType: "IDENTITY_LINK", developerId: zed, provider: "github", issuer: GITHUB_ISSUER, subject: "9002", linkedAt: at, lastSignInAt: at, unlinkedFrom: zed, unlinkedAt: at };
    w.h.db.set(tombstone);
    const started = await start(w);
    expect(outcome(await finish(w, started.authorizeUrl!, 9002)).value).toBe("taken");
    expect(w.h.db.get(signInIdentityKey(key))).toEqual(tombstone);
    expect(await w.h.deps.store.githubUserIdOf(w.account)).toBeUndefined();
    expect(w.h.db.get(`DEVELOPER#${w.account}`, "META")?.githubLinkedIdentity).toBeUndefined();
  });

  it("returns to the account menu by default, and accepts only the two fixed return paths", async () => {
    const w = await world();
    const started = await start(w, { browser: true });
    expect(outcome(await finish(w, started.authorizeUrl!, 9001)).path).toBe("/app");
    expect(await w.h.handler({ kind: "start-identity-link", developerId: w.account, sessionId: w.sessionId, provider: "github", browser: true, returnTo: "https://evil.example" } as never)).toEqual({ ok: false, error: "invalid_request" });
  });
});

describe("the broker side of linking from the web", () => {
  it("lets a browser POST (only) its own GitHub link, and passes the browser flag and return path only for a live browser session", async () => {
    expect(webRouteAllowed("POST", "/v1/web/me/identities/github")).toBe(true);
    expect(webRouteAllowed("DELETE", "/v1/web/me/identities/github")).toBe(false);
    expect(webRouteAllowed("POST", "/v1/web/me/identities/cloud")).toBe(false);
    const startIdentityLink = vi.fn(async () => ({ ok: true as const, authorizeUrl: "https://cell.example/v1/auth/authorize?request=r&method=github" }));
    const deps = { developer: { startIdentityLink } } as unknown as DeveloperRouteDependencies;
    const caller = { developerId: "a".repeat(64), sessionId: "11111111-1111-4111-8111-111111111111" } as DeveloperCaller;
    await startAppIdentityLink(deps, { ...caller, browserSession: true }, "github", { returnTo: "/app/onboard" });
    await startAppIdentityLink(deps, { ...caller, browserSession: true }, "github", { returnTo: "https://evil.example" });
    await startAppIdentityLink(deps, caller, "github", { returnTo: "/app/onboard" });
    expect(startIdentityLink.mock.calls.map((call) => (call as unknown as [Record<string, unknown>])[0])).toEqual([
      expect.objectContaining({ provider: "github", browser: true, returnTo: "/app/onboard" }),
      expect.objectContaining({ provider: "github", browser: true, returnTo: "/app" }),
      expect.not.objectContaining({ browser: true }),
    ]);
  });

  it("offers no link of a method the edition does not allow (the same check the link start applies)", async () => {
    const A = "org_aaaaaaaaaaaaaaaaaaaa";
    const deps = { orgs: { getOrg: async () => ({ orgId: A, name: "Acme", plan: "team", createdBy: "x" }) }, documentClient: new FakeDynamoDb(), tableName: "state", now: () => T0,
      editionPolicy: { features: { publicSignInMethods: false, sso: true } },
      developer: { signInTableName: "signin", methods: { slack: true, oidc: true, cloud: true, github: true } } } as unknown as DeveloperRouteDependencies;
    const me = await getAppMe(deps, { orgId: A, developerId: "a".repeat(64), orgRole: "owner", name: "Maya" } as DeveloperCaller);
    expect(me.linkable).toEqual({ slack: false, github: false });
  });

  it("says on /me which methods can be linked here", async () => {
    const A = "org_aaaaaaaaaaaaaaaaaaaa";
    const deps = { orgs: { getOrg: async () => ({ orgId: A, name: "Acme", plan: "team", createdBy: "x" }) }, documentClient: new FakeDynamoDb(), tableName: "state", now: () => T0,
      developer: { signInTableName: "signin", methods: { slack: false, oidc: false, cloud: true, github: true } } } as unknown as DeveloperRouteDependencies;
    const me = await getAppMe(deps, { orgId: A, developerId: "a".repeat(64), orgRole: "owner", name: "Maya" } as DeveloperCaller);
    expect(me.linkable).toEqual({ slack: false, github: true });
  });
});
