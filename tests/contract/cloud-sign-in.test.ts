// Task 6: the `cloud` sign-in method, with an org created on first sign-in (rules 1 to 4 of resolveOrgOnSignIn).
import { describe, expect, it } from "vitest";
import { agentXError, singleOrgIdForEnv } from "@rovara-code/contracts";
import { developerOrgKey, orgEmailKey, orgInviteKey, orgMetaKey } from "@agentx/cloud-contracts";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { developerIdentityConfigFromEnvironment, singleOrgIdFor } from "../../packages/broker/src/aws/developer-identity.js";
import { oidcSignInProvider } from "../../packages/broker/src/developer/providers.js";
import { membershipOrgResolver, orgResolverFromEnvironment } from "../../packages/broker/src/org/resolve.js";
import { ALREADY_SIGNED_UP_MESSAGE, resolveOrgOnSignIn } from "../../packages/broker/src/org/sign-in.js";
import { inviteTokenHash } from "../../packages/broker/src/org/invite-url.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { adminCall, adminIssuer, createAdminBroker } from "../support/admin-broker.js";
import { OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_ISSUER, httpEvent, identityHarness, type FakeOidcUser } from "../support/developer-fakes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { sha256Hex } from "../../packages/broker/src/developer/tokens.js";
import { TEST_ORG } from "../support/orgs.js";

const maya: FakeOidcUser = { sub: "maya-cloud-1", name: "Maya Chen", email: "maya@example.com", email_verified: true };
const mayaId = ownerKeyForSubject(OIDC_ISSUER, "maya-cloud-1");
const claimsOf = (accessToken: unknown) => JSON.parse(Buffer.from(String(accessToken).split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;

async function exchangedAfterSignIn(h: ReturnType<typeof identityHarness>, method: "cloud" | "oidc", sub: string) {
  const code = (await h.signIn(method, sub)).searchParams.get("code")!;
  const exchanged = await h.exchange(code);
  expect(exchanged.status).toBe(200);
  return exchanged.body;
}

const orgMetas = (state: FakeDynamoDb) => state.find((item) => item.entityType === "ORG" && item.sk === "META" && String(item.pk).startsWith("ORG#org_"));

describe("a cloud sign-in creates an org on first sign-in", () => {
  it("makes the caller the owner of a new org named for them, and the token carries it", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [maya] });
    const claims = claimsOf((await exchangedAfterSignIn(h, "cloud", maya.sub)).access_token);
    expect(claims).toMatchObject({ sub: mayaId, amr: "cloud", org_role: "owner" });
    const metas = orgMetas(h.state);
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({ orgId: claims.org, name: "Maya Chen's team", createdBy: mayaId, plan: "trial" });
    expect(h.state.get(developerOrgKey(mayaId))).toMatchObject({ orgId: claims.org, role: "owner" });
    expect(h.state.get(orgEmailKey("maya@example.com"))).toMatchObject({ developerId: mayaId, orgId: claims.org });
  });

  it("keeps the same org on the next sign-in", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [maya] });
    const first = claimsOf((await exchangedAfterSignIn(h, "cloud", maya.sub)).access_token);
    const second = claimsOf((await exchangedAfterSignIn(h, "cloud", maya.sub)).access_token);
    expect(second.org).toBe(first.org);
    expect(orgMetas(h.state)).toHaveLength(1);
  });

  it("tells the loser of a first sign-in race (another route holds the email, its company not yet visible) to sign in that way; no second company", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [maya] });
    const other = "f".repeat(64);
    // The other route's create wrote the email pointer; this sign-in finds no company for it, so rule 2 does not link and rule 3 hits the pointer.
    h.state.set({ ...orgEmailKey("maya@example.com"), entityType: "ORG_EMAIL", developerId: other, orgId: "org_otherroute000000000" });
    const refused = await h.signIn("cloud", maya.sub);
    expect(refused.searchParams.get("code")).toBeNull();
    expect(refused.searchParams.get("error")).toBe("access_denied");
    expect(refused.searchParams.get("error_description")).toBe(ALREADY_SIGNED_UP_MESSAGE);
    expect(orgMetas(h.state)).toHaveLength(0);
    expect(h.state.get(developerOrgKey(mayaId))).toBeUndefined();
  });

  it("lists the method in the configuration document", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [maya] });
    const document = JSON.parse((await h.http(httpEvent("GET", "/v1/auth/.well-known/agentx-configuration"))).body) as { methods: Record<string, unknown> };
    expect(document.methods).toEqual({ slack: true, oidc: null, cloud: { displayName: "Rovara" }, github: null });
    const without = identityHarness({});
    expect((JSON.parse((await without.http(httpEvent("GET", "/v1/auth/.well-known/agentx-configuration"))).body) as { methods: Record<string, unknown> }).methods)
      .toMatchObject({ cloud: null });
  });

  it("puts two sign-in routes of one person (same verified email) in one developer: the same member of the same org", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [maya, { ...maya, sub: "maya-cloud-2", name: "M. Chen" }] });
    const first = claimsOf((await exchangedAfterSignIn(h, "cloud", maya.sub)).access_token);
    const second = claimsOf((await exchangedAfterSignIn(h, "cloud", "maya-cloud-2")).access_token);
    expect(second).toMatchObject({ org: first.org, org_role: "owner", sub: first.sub });
    expect(orgMetas(h.state)).toHaveLength(1);
    expect(h.state.find((item) => String(item.sk).startsWith("MEMBER#"))).toHaveLength(1);
    // The email pointer still names the first route.
    expect(h.state.get(orgEmailKey("maya@example.com"))).toMatchObject({ developerId: mayaId });
  });

  it("gives the same email, unverified, an org of its own", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [maya, { ...maya, sub: "maya-cloud-2", email_verified: false }] });
    const first = claimsOf((await exchangedAfterSignIn(h, "cloud", maya.sub)).access_token);
    const second = claimsOf((await exchangedAfterSignIn(h, "cloud", "maya-cloud-2")).access_token);
    expect(second.org).not.toBe(first.org);
    expect(orgMetas(h.state)).toHaveLength(2);
    expect(h.state.get(orgEmailKey("maya@example.com"))).toMatchObject({ developerId: mayaId });
  });

  it("refuses to be chosen when the method is not configured", async () => {
    const h = identityHarness({ oidcUsers: [maya] });
    const refused = await h.http(httpEvent("GET", "/v1/auth/authorize?request=anything&method=cloud"));
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toContain("Sign-in method not available");
  });
});

describe("a company or Slack sign-in joins the install's single org", () => {
  it("joins as a member, with AGENTX's single org", async () => {
    const h = identityHarness({ oidc: {}, oidcUsers: [maya] });
    const claims = claimsOf((await exchangedAfterSignIn(h, "oidc", maya.sub)).access_token);
    expect(claims).toMatchObject({ org: TEST_ORG, org_role: "member", amr: "oidc" });
    expect(h.state.get(orgEmailKey("maya@example.com"))).toBeUndefined();
  });
});

describe("resolveOrgOnSignIn", () => {
  const now = () => Date.parse("2026-10-19T00:00:00.000Z");
  const dev = (letter: string) => letter.repeat(64);
  const setup = () => {
    const state = new FakeDynamoDb();
    return { state, orgs: new OrgStore({ documentClient: state, tableName: "state", now }) };
  };
  const cloudInput = (developerId: string, extra: { email?: string; emailVerified?: boolean; inviteTokenHash?: string } = {}) =>
    ({ method: "cloud" as const, developerId, displayName: "Maya", emailVerified: true, ...extra });
  const inviteAccepted = (state: FakeDynamoDb, token: string) => state.get(orgInviteKey(sha256Hex(token)))?.acceptedAt !== undefined;

  it("rule 1: an existing org wins, and an invite reports ALREADY_IN_ORG and stays unaccepted", async () => {
    const { state, orgs } = setup();
    const own = await orgs.createOrgWithOwner({ name: "A", developerId: dev("a") });
    const other = await orgs.createOrgWithOwner({ name: "B", developerId: dev("b") });
    const { token } = await orgs.createInvite({ orgId: other, createdBy: dev("b"), role: "member" });
    expect(await resolveOrgOnSignIn({ orgs }, cloudInput(dev("a"), { inviteTokenHash: inviteTokenHash(token) }))).toEqual({ orgId: own, role: "owner", inviteError: "ALREADY_IN_ORG" });
    expect(inviteAccepted(state, token)).toBe(false);
    expect(await resolveOrgOnSignIn({ orgs }, cloudInput(dev("a")))).toEqual({ orgId: own, role: "owner" });
  });

  it("rule 3: an unverified email gets an org of its own, and a Slack sign-in follows no email pointer (identities.ts links by email now)", async () => {
    const { orgs } = setup();
    const org = await orgs.createOrgWithOwner({ name: "A", developerId: dev("a"), email: "maya@example.com" });
    const unverified = await resolveOrgOnSignIn({ orgs }, cloudInput(dev("c"), { email: "maya@example.com", emailVerified: false }));
    expect(unverified.orgId).not.toBe(org);
    expect(unverified.role).toBe("owner");
    const { orgs: fresh } = setup();
    const single = await fresh.createOrgWithOwner({ name: "A", developerId: dev("a"), email: "maya@example.com" });
    const slack = await resolveOrgOnSignIn({ orgs: fresh, singleOrgId: TEST_ORG }, { method: "slack", developerId: dev("c"), displayName: "Maya", email: "maya@example.com", emailVerified: true });
    expect(slack).toEqual({ orgId: TEST_ORG, role: "member" });
    expect(slack.orgId).not.toBe(single);
  });

  it("rule 3: the loser of a two-route first sign-in race is refused (CHANGE_STALE, plain words), left with no company, the email pointer kept by the first, and a log line", async () => {
    const { state, orgs } = setup();
    const first = await orgs.createOrgWithOwner({ name: "A", developerId: dev("a"), email: "maya@example.com" });
    const logs: Array<Record<string, unknown>> = [];
    await expect(resolveOrgOnSignIn({ orgs, log: (entry) => logs.push(entry) }, cloudInput(dev("c"), { email: "maya@example.com" })))
      .rejects.toMatchObject({ code: "CHANGE_STALE", message: expect.stringContaining(ALREADY_SIGNED_UP_MESSAGE) as string });
    expect(await orgs.orgForDeveloper(dev("c"))).toBeUndefined();
    expect(orgMetas(state)).toHaveLength(1);
    expect(state.get(orgEmailKey("maya@example.com"))).toMatchObject({ developerId: dev("a"), orgId: first });
    expect(logs).toEqual([{ event: "signin.email_pointer_conflict", developerId: dev("c"), refused: true }]);
  });

  it("rule 3: a method removed on purpose (separatedFrom) is not refused: it owns a new company of its own, and the pointer and the first company stay as they were", async () => {
    const { state, orgs } = setup();
    const first = await orgs.createOrgWithOwner({ name: "A", developerId: dev("a"), email: "maya@example.com" });
    const logs: Array<Record<string, unknown>> = [];
    const result = await resolveOrgOnSignIn({ orgs, log: (entry) => logs.push(entry) }, { ...cloudInput(dev("c"), { email: "maya@example.com" }), separatedFrom: dev("a") });
    expect(logs).toEqual([{ event: "signin.email_pointer_conflict", developerId: dev("c"), refused: false, separated: true }]);
    expect(result.role).toBe("owner");
    expect(result.orgId).not.toBe(first);
    expect(state.get(orgEmailKey("maya@example.com"))).toMatchObject({ developerId: dev("a"), orgId: first });
    expect((await orgs.listMembers(first)).map((member) => member.developerId)).toEqual([dev("a")]);
    expect((await orgs.listMembers(result.orgId)).map((member) => member.developerId)).toEqual([dev("c")]);
  });

  it("rule 3: separatedFrom does not lift the invitation-only rule", async () => {
    const { orgs } = setup();
    await orgs.createOrgWithOwner({ name: "A", developerId: dev("a"), email: "maya@example.com" });
    await expect(resolveOrgOnSignIn({ orgs, newOrgsByInvitationOnly: true }, { ...cloudInput(dev("c"), { email: "maya@example.com" }), separatedFrom: dev("a") }))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await orgs.orgForDeveloper(dev("c"))).toBeUndefined();
  });

  it("rule 3: two concurrent first sign-ins with the same email make one company; the loser is refused and holds no company", async () => {
    const { state, orgs } = setup();
    const logs: Array<Record<string, unknown>> = [];
    const results = await Promise.allSettled([dev("a"), dev("c")].map((developerId) =>
      resolveOrgOnSignIn({ orgs, log: (entry) => logs.push(entry) }, cloudInput(developerId, { email: "maya@example.com" }))));
    const won = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const lost = results.flatMap((result) => result.status === "rejected" ? [result.reason as { code?: string; message?: string }] : []);
    expect(won).toHaveLength(1);
    expect(lost).toEqual([expect.objectContaining({ code: "CHANGE_STALE", message: expect.stringContaining(ALREADY_SIGNED_UP_MESSAGE) as string })]);
    expect(orgMetas(state)).toHaveLength(1);
    const pointer = state.get(orgEmailKey("maya@example.com"));
    expect(pointer).toMatchObject({ orgId: won[0]!.orgId });
    const loser = pointer?.developerId === dev("a") ? dev("c") : dev("a");
    expect(await orgs.orgForDeveloper(loser)).toBeUndefined();
    expect(state.get(developerOrgKey(loser))).toBeUndefined();
    expect(logs).toEqual([{ event: "signin.email_pointer_conflict", developerId: loser, refused: true }]);
  });

  it("rule 2: an invite written for kate@provider.dev is not satisfied by a verified address that only folds to it (U+212A KELVIN SIGN)", async () => {
    const { state, orgs } = setup();
    const org = await orgs.createOrgWithOwner({ name: "A", developerId: dev("a") });
    const { token } = await orgs.createInvite({ orgId: org, createdBy: dev("a"), role: "member", email: "kate@provider.dev" });
    const result = await resolveOrgOnSignIn({ orgs }, cloudInput(dev("k"), { email: "\u212Aate@provider.dev", inviteTokenHash: inviteTokenHash(token) }));
    expect(result).toMatchObject({ role: "owner", inviteError: "INVITE_WRONG_EMAIL" });
    expect(result.orgId).not.toBe(org);
    expect(inviteAccepted(state, token)).toBe(false);
    expect(await resolveOrgOnSignIn({ orgs }, cloudInput(dev("e"), { email: "Kate@Provider.dev", inviteTokenHash: inviteTokenHash(token) }))).toEqual({ orgId: org, role: "member" });
  });

  it("rule 2: an invite accepted while the email pointer is another developer's still joins, and the pointer stays", async () => {
    const { state, orgs } = setup();
    await orgs.createOrgWithOwner({ name: "A", developerId: dev("a"), email: "maya@example.com" });
    const org = await orgs.createOrgWithOwner({ name: "B", developerId: dev("b") });
    const { token } = await orgs.createInvite({ orgId: org, createdBy: dev("b"), role: "member" });
    expect(await resolveOrgOnSignIn({ orgs }, cloudInput(dev("c"), { email: "maya@example.com", inviteTokenHash: inviteTokenHash(token) }))).toEqual({ orgId: org, role: "member" });
    expect(state.get(orgEmailKey("maya@example.com"))).toMatchObject({ developerId: dev("a") });
  });

  it("rule 3: a non-ASCII address is never indexed", async () => {
    const { state, orgs } = setup();
    const result = await resolveOrgOnSignIn({ orgs }, cloudInput(dev("k"), { email: "\u212Aate@provider.dev" }));
    expect(result.role).toBe("owner");
    expect(state.find((item) => item.entityType === "ORG_EMAIL")).toHaveLength(0);
  });

  it("rule 2: accepts an invite, whatever the method, and indexes the email only for cloud", async () => {
    const { state, orgs } = setup();
    const org = await orgs.createOrgWithOwner({ name: "A", developerId: dev("a") });
    const cloud = await orgs.createInvite({ orgId: org, createdBy: dev("a"), role: "admin" });
    expect(await resolveOrgOnSignIn({ orgs }, cloudInput(dev("b"), { email: "bea@example.com", inviteTokenHash: inviteTokenHash(cloud.token) }))).toEqual({ orgId: org, role: "admin" });
    expect(state.get(orgEmailKey("bea@example.com"))).toMatchObject({ developerId: dev("b"), orgId: org });
    const slack = await orgs.createInvite({ orgId: org, createdBy: dev("a"), role: "member" });
    expect(await resolveOrgOnSignIn({ orgs }, { method: "slack", developerId: dev("c"), displayName: "Cy", email: "cy@example.com", emailVerified: true, inviteTokenHash: inviteTokenHash(slack.token) }))
      .toEqual({ orgId: org, role: "member" });
    expect(state.get(orgEmailKey("cy@example.com"))).toBeUndefined();
  });

  it("rule 2 (ruling R7): an invite written for an email is refused to another email, to an unverified one and to none, and stays usable", async () => {
    const { state, orgs } = setup();
    const org = await orgs.createOrgWithOwner({ name: "A", developerId: dev("a") });
    const { token } = await orgs.createInvite({ orgId: org, createdBy: dev("a"), role: "member", email: "Bea@Example.com" });
    for (const [developerId, extra] of [
      [dev("b"), { email: "mallory@example.com" }],
      [dev("c"), { email: "bea@example.com", emailVerified: false }],
      [dev("d"), {}],
    ] as const) {
      const result = await resolveOrgOnSignIn({ orgs }, cloudInput(developerId, { ...extra, inviteTokenHash: inviteTokenHash(token) }));
      // Falls through to rule 3: an org of their own.
      expect(result).toMatchObject({ role: "owner", inviteError: "INVITE_WRONG_EMAIL" });
      expect(result.orgId).not.toBe(org);
      expect(inviteAccepted(state, token)).toBe(false);
    }
    expect(await resolveOrgOnSignIn({ orgs }, cloudInput(dev("e"), { email: "BEA@example.com", inviteTokenHash: inviteTokenHash(token) }))).toEqual({ orgId: org, role: "member" });
    expect(inviteAccepted(state, token)).toBe(true);
  });

  it("rule 2: an unknown, used or expired invite is INVITE_INVALID and falls through", async () => {
    const { orgs } = setup();
    const org = await orgs.createOrgWithOwner({ name: "A", developerId: dev("a") });
    const unknown = await resolveOrgOnSignIn({ orgs }, cloudInput(dev("b"), { inviteTokenHash: inviteTokenHash("no-such-token") }));
    expect(unknown).toMatchObject({ role: "owner", inviteError: "INVITE_INVALID" });
    const { token } = await orgs.createInvite({ orgId: org, createdBy: dev("a"), role: "member" });
    await resolveOrgOnSignIn({ orgs }, cloudInput(dev("c"), { inviteTokenHash: inviteTokenHash(token) }));
    expect(await resolveOrgOnSignIn({ orgs, singleOrgId: TEST_ORG }, { method: "oidc", developerId: dev("d"), displayName: "Di", emailVerified: false, inviteTokenHash: inviteTokenHash(token) }))
      .toEqual({ orgId: TEST_ORG, role: "member", inviteError: "INVITE_INVALID" });
    const expired = await orgs.createInvite({ orgId: org, createdBy: dev("a"), role: "member", ttlSeconds: -1 });
    expect(await resolveOrgOnSignIn({ orgs }, cloudInput(dev("e"), { inviteTokenHash: inviteTokenHash(expired.token) }))).toMatchObject({ role: "owner", inviteError: "INVITE_INVALID" });
  });

  it("rule 3: creates an org named for the person, with them as owner and their verified email indexed", async () => {
    const { state, orgs } = setup();
    const result = await resolveOrgOnSignIn({ orgs }, { method: "cloud", developerId: dev("a"), displayName: "Maya Chen", email: "Maya@Example.com", emailVerified: true });
    expect(result.role).toBe("owner");
    expect(state.get(orgMetaKey(result.orgId))).toMatchObject({ name: "Maya Chen's team", createdBy: dev("a") });
    expect(state.get(orgEmailKey("maya@example.com"))).toMatchObject({ developerId: dev("a") });
    const noEmail = await resolveOrgOnSignIn({ orgs }, { method: "cloud", developerId: dev("b"), displayName: "Bea", emailVerified: true });
    expect(noEmail.role).toBe("owner");
    expect(state.find((item) => item.entityType === "ORG_EMAIL")).toHaveLength(1);
  });

  it("rule 3: two concurrent first sign-ins of one person end in one org", async () => {
    const { orgs } = setup();
    const results = await Promise.all([
      resolveOrgOnSignIn({ orgs }, cloudInput(dev("a"), { email: "maya@example.com" })),
      resolveOrgOnSignIn({ orgs }, cloudInput(dev("a"), { email: "maya@example.com" })),
    ].map((pending) => pending.catch((error: unknown) => error)));
    const settled = results.filter((result): result is { orgId: string; role: string } => !(result instanceof Error));
    expect(settled.length).toBeGreaterThanOrEqual(1);
    expect(new Set(settled.map((result) => result.orgId)).size).toBe(1);
    expect(await orgs.orgForDeveloper(dev("a"))).toMatchObject({ orgId: settled[0]!.orgId });
  });

  it("rule 4: a Slack or company sign-in joins the single org as a member, and refuses with CONFIG_INVALID without one", async () => {
    const { orgs } = setup();
    const input = { method: "oidc" as const, developerId: dev("a"), displayName: "Maya", emailVerified: true };
    expect(await resolveOrgOnSignIn({ orgs, singleOrgId: TEST_ORG, singleOrgName: "staging" }, input)).toEqual({ orgId: TEST_ORG, role: "member" });
    await expect(resolveOrgOnSignIn({ orgs }, { ...input, developerId: dev("b") })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("propagates an error that is not a lost race", async () => {
    const { orgs } = setup();
    const failing = Object.assign(Object.create(orgs) as OrgStore, { createOrgWithOwner: async () => { throw agentXError("CONFIG_INVALID", "boom"); } });
    await expect(resolveOrgOnSignIn({ orgs: failing }, cloudInput(dev("a")))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("the provider's verdict on the email", () => {
  async function complete(emailVerified: unknown, method: "cloud" | "oidc") {
    const h = identityHarness({ oidcUsers: [maya] });
    const provider = oidcSignInProvider({
      method, issuer: OIDC_ISSUER, clientId: OIDC_CLIENT_ID, clientSecret: async () => OIDC_CLIENT_SECRET, requiredValues: [],
      fetch: h.fetch, jwksFor: () => h.oidc.jwks, now: Date.now, // the minted token is stamped with the real clock
    });
    const authorize = new URL(await provider.authorizeUrl({ state: "s", nonce: "n", redirectUri: "https://api.example.test/cb" }));
    const claims = { nonce: "n", email: "maya@example.com", ...(emailVerified === undefined ? {} : { email_verified: emailVerified }), name: "Maya", sub: maya.sub };
    const idToken = await h.oidc.issue(claims);
    const approved = new URL(h.oidc.approve(authorize.toString(), maya.sub, { idToken }));
    return provider.complete({ code: approved.searchParams.get("code")!, nonce: "n", redirectUri: "https://api.example.test/cb" });
  }

  it.each([[true, true], ["true", true]])("takes email_verified %j as verified", async (claim, verified) => {
    const result = await complete(claim, "cloud");
    expect(result).toMatchObject({ ok: true, identity: { method: "cloud", email: "maya@example.com", emailVerified: verified } });
  });

  it.each([[false], ["false"], ["yes"], [1], [undefined]])("never takes email_verified %j as verified", async (claim) => {
    const result = await complete(claim, "oidc");
    expect(result).toMatchObject({ ok: true, identity: { method: "oidc" } });
    if (result.ok) {
      expect(result.identity.email).toBeUndefined();
      expect(result.identity.emailVerified).not.toBe(true);
    }
  });
});

describe("the Lambda's configuration from its environment", () => {
  const base = { AGENTX_ENV: "staging", DEVELOPER_TOKEN_ISSUER: "https://api.example.test/v1/auth" };

  it("has no cloud method unless DEVELOPER_CLOUD_ISSUER is set", () => {
    expect(developerIdentityConfigFromEnvironment(base)).not.toHaveProperty("cloud");
  });

  it("names the method Rovara by default, and from DEVELOPER_CLOUD_DISPLAY_NAME when set", () => {
    const env = { ...base, DEVELOPER_CLOUD_ISSUER: "https://cloud.example.test", DEVELOPER_CLOUD_CLIENT_ID: "client" };
    expect(developerIdentityConfigFromEnvironment(env)).toMatchObject({ cloud: { displayName: "Rovara" }, cloudSettings: { issuer: "https://cloud.example.test", clientId: "client" } });
    expect(developerIdentityConfigFromEnvironment({ ...env, DEVELOPER_CLOUD_DISPLAY_NAME: "Acme Cloud" })).toMatchObject({ cloud: { displayName: "Acme Cloud" } });
  });

  it("keeps the method but marks it unfinished without a client id", () => {
    const config = developerIdentityConfigFromEnvironment({ ...base, DEVELOPER_CLOUD_ISSUER: "https://cloud.example.test" });
    expect(config.cloud).toBeDefined();
    expect(config.cloudSettings).toBeUndefined();
    expect(config.cloudProblem).toMatch(/DEVELOPER_CLOUD_CLIENT_ID/);
  });
});

describe("ruling R51: a cloud install has no shared system org for Slack and company sign-ins", () => {
  const base = { AGENTX_ENV: "staging", DEVELOPER_TOKEN_ISSUER: "https://api.example.test/v1/auth" };
  const slackUser = { userId: "U0MAYA001", name: "Maya Chen", teamId: "T0TEAM1" };

  it("sets the single org only on an install without the cloud method", () => {
    expect(singleOrgIdFor(developerIdentityConfigFromEnvironment(base))).toBe(singleOrgIdForEnv("staging"));
    expect(singleOrgIdFor(developerIdentityConfigFromEnvironment({ ...base, DEVELOPER_CLOUD_ISSUER: "https://cloud.example.test", DEVELOPER_CLOUD_CLIENT_ID: "client" }))).toBeUndefined();
    // An install whose cloud settings are unfinished still has the cloud method configured: no system org either.
    expect(singleOrgIdFor(developerIdentityConfigFromEnvironment({ ...base, DEVELOPER_CLOUD_ISSUER: "https://cloud.example.test" }))).toBeUndefined();
  });

  it("refuses a Slack and a company sign-in, creating no org and no membership, while the cloud sign-in still works", async () => {
    const h = identityHarness({ cloud: {}, slackUsers: [slackUser], oidc: {}, oidcUsers: [maya], singleOrg: false });
    for (const [method, who] of [["slack", slackUser.userId], ["oidc", maya.sub]] as const) {
      const location = await h.signIn(method, who);
      expect(location.searchParams.get("code"), method).toBeNull();
      expect(location.searchParams.get("error"), method).toBeTruthy();
    }
    expect(orgMetas(h.state)).toEqual([]);
    expect(h.state.find((item) => String(item.pk).startsWith("DEVELOPER_ORG#"))).toEqual([]);
    const claims = claimsOf((await exchangedAfterSignIn(h, "cloud", maya.sub)).access_token);
    expect(claims).toMatchObject({ amr: "cloud", org_role: "owner" });
    expect(orgMetas(h.state)).toHaveLength(1);
  });

  it("says why: sign in with Rovara on this install", async () => {
    const orgs = new OrgStore({ documentClient: new FakeDynamoDb(), tableName: "state", now: () => 0 });
    for (const method of ["slack", "oidc"] as const) {
      await expect(resolveOrgOnSignIn({ orgs }, { method, developerId: "s".repeat(64), displayName: "Maya", emailVerified: false })).rejects.toMatchObject({
        code: "CONFIG_INVALID", message: expect.stringContaining("Sign in with Rovara on this install") as string,
      });
    }
  });
});

describe("ruling R6: with the cloud method configured, membership decides who has an org", () => {
  const definition = (name: string, revision: number) => ({
    name, revision,
    repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
    setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  });
  const runtimeBinding = {
    deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-0123456789abcdef0",
    subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" as const,
  };

  it("refuses an org-scoped admin route to an operator who is in no org, and serves a member", async () => {
    const holder: { table?: FakeDynamoDb } = {};
    const resolver = membershipOrgResolver({ orgForDeveloper: (developerId) => new OrgStore({ documentClient: holder.table!, tableName: "state", now: Date.now }).orgForDeveloper(developerId) });
    const { db, handler } = await createAdminBroker({ orgResolver: resolver });
    holder.table = db;
    const register = (subject: string) => adminCall(handler, { method: "POST", path: "/v1/admin/projects", subject, body: { definition: definition("web", 1), runtimeBinding } });

    const refused = await register("operator");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "FORBIDDEN" });

    const orgId = await new OrgStore({ documentClient: db, tableName: "state", now: Date.now }).createOrgWithOwner({ name: "Ada's team", developerId: ownerKeyForSubject(adminIssuer, "ada") });
    expect((await register("ada")).status).toBe(201);
    expect(db.find((item) => String(item.pk).startsWith(`ORG#${orgId}#PROJECT#`))).not.toHaveLength(0);
  });

  it("resolves by developer id, falling back to the owner key, and to no org for anyone else", async () => {
    const state = new FakeDynamoDb();
    const orgs = new OrgStore({ documentClient: state, tableName: "state", now: Date.now });
    const orgId = await orgs.createOrgWithOwner({ name: "A", developerId: "a".repeat(64) });
    const resolve = membershipOrgResolver(orgs);
    expect(await resolve({ developerId: "a".repeat(64) })).toBe(orgId);
    expect(await resolve({ ownerKey: "a".repeat(64) })).toBe(orgId);
    expect(await resolve({ ownerKey: "b".repeat(64) })).toBeUndefined();
    expect(await resolve({})).toBeUndefined();
  });

  it("is chosen by DEVELOPER_CLOUD_ISSUER, and not otherwise", () => {
    const orgs = new OrgStore({ documentClient: new FakeDynamoDb(), tableName: "state", now: Date.now });
    expect(orgResolverFromEnvironment({}, orgs)).toBeUndefined();
    expect(orgResolverFromEnvironment({ DEVELOPER_CLOUD_ISSUER: "" }, orgs)).toBeUndefined();
    expect(orgResolverFromEnvironment({ DEVELOPER_CLOUD_ISSUER: "https://cloud.example.test" }, orgs)).toBeTypeOf("function");
  });
});
