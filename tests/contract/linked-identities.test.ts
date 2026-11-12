// Plan 2, Task 2: one developer per person. A second sign-in route for the same verified email is linked to the first route's
// developer, never added as a second member, and `GET /v1/app/me` lists the linked methods.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppMeResponseSchema, developerOrgKey, orgEmailKey, orgMemberKey } from "@agentx/cloud-contracts";
import { normalizeEmail, orgPk, projectMemberKey, projectRevisionKey, type OrgId } from "@rovara-code/contracts";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { resolveSignInDeveloper } from "../../packages/broker/src/developer/identities.js";
import { developerTokenVerifier } from "../../packages/broker/src/developer/verify-token.js";
import { DeveloperSignInStore, developerIdentityKey, signInIdentityKey } from "../../packages/broker/src/developer/store.js";
import type { DeveloperApiConfiguration } from "../../packages/broker/src/aws/developer-routes.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { createAdminBroker } from "../support/admin-broker.js";
import { ISSUER, identityHarness, type FakeGithubUser, type FakeOidcUser } from "../support/developer-fakes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const GITHUB_ISSUER = "https://github.com";
const OIDC_ISSUER = "https://idp.example.test";
const T0 = Date.parse("2026-09-27T12:00:00.000Z");
const priya: FakeOidcUser = { sub: "priya-cloud-1", name: "Priya Rao", email: "priya@acme.dev", email_verified: true };
const priyaGithub = (verified = true): FakeGithubUser => ({ id: 4711, login: "priya-dev", name: "Priya R.", emails: [{ email: "priya@acme.dev", primary: true, verified }] });
const cloudId = ownerKeyForSubject(OIDC_ISSUER, priya.sub);
const githubId = ownerKeyForSubject(GITHUB_ISSUER, "4711");

type Harness = ReturnType<typeof identityHarness>;
const claimsOf = (accessToken: unknown) => JSON.parse(Buffer.from(String(accessToken).split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;

async function signIn(h: Harness, method: "cloud" | "github" | "oidc", who: string): Promise<{ claims: Record<string, unknown>; token: string; location: URL }> {
  const location = await h.signIn(method, who);
  const code = location.searchParams.get("code");
  if (code === null) return { claims: {}, token: "", location };
  const exchanged = await h.exchange(code);
  expect(exchanged.status).toBe(200);
  return { claims: claimsOf(exchanged.body.access_token), token: String(exchanged.body.access_token), location };
}
const members = (h: Harness, orgId: unknown) => h.state.find((item) => item.pk === orgPk(orgId as OrgId) && String(item.sk).startsWith("MEMBER#"));
const orgsMade = (h: Harness) => h.state.find((item) => item.entityType === "ORG" && item.sk === "META" && String(item.pk).startsWith("ORG#org_"));

beforeEach(() => { vi.useFakeTimers({ now: T0, toFake: ["Date"] }); });
afterEach(() => { vi.useRealTimers(); });

/** The broker over a copy of the harness's tables (org rows and sign-in rows), answering as API Gateway would route it. */
async function brokerCall(h: Harness, method: string, path: string, token: string, routeKey?: string): Promise<{ status: number; body: unknown }> {
  const config: DeveloperApiConfiguration = {
    issuer: ISSUER, env: "staging", methods: { slack: true, oidc: true, cloud: true, github: true }, signInTableName: "signin",
    channelMembers: async () => ({ ok: true as const, memberOf: [] }),
    verifyAccessToken: developerTokenVerifier({ issuer: ISSUER, keys: async () => [await h.signer.publicJwk()], now: () => Date.now() }),
  };
  const { db, handler } = await createAdminBroker({ developer: config });
  for (const source of [h.db, h.state]) for (const item of source.items.values()) db.set(structuredClone(item));
  const response = await handler({
    rawPath: path, headers: { authorization: `Bearer ${token}` },
    ...(routeKey === undefined ? {} : { routeKey }),
    requestContext: { requestId: "r", http: { method } },
  });
  return { status: response.statusCode, body: JSON.parse(response.body) as unknown };
}

describe("normalizeEmail", () => {
  it("applies NFC, trims, lower-cases, and says whether the address is plain ASCII", () => {
    expect(normalizeEmail("  Priya@Acme.DEV ")).toEqual({ email: "priya@acme.dev", ascii: true });
    // "é" typed as e + combining acute becomes the one composed character.
    expect(normalizeEmail("josé@acme.dev")).toEqual({ email: "josé@acme.dev", ascii: false });
  });

  it("does not call an address ASCII when Unicode case folding made it so (U+212A KELVIN SIGN lower-cases to k)", () => {
    expect(normalizeEmail("Kate@provider.dev")).toEqual({ email: "kate@provider.dev", ascii: false });
  });

  it("keys the verified-email pointer", () => {
    expect(orgEmailKey(" Priya@Acme.COM ")).toEqual({ pk: "ORG_EMAIL#priya@acme.com", sk: "DEVELOPER" });
  });
});

describe("one member per verified email", () => {
  it("email first, then GitHub: the GitHub sign-in is the same developer, in the same org, with the same projects", async () => {
    const state = new FakeDynamoDb();
    const h = identityHarness({ cloud: {}, oidcUsers: [priya], github: { users: [priyaGithub()] }, state });
    const first = await signIn(h, "cloud", priya.sub);
    expect(first.claims).toMatchObject({ sub: cloudId, org_role: "owner", amr: "cloud" });
    // The org's owner grants the developer a project.
    state.set({ ...projectRevisionKey(first.claims.org as OrgId, "web", 1), entityType: "PROJECT", definition: { name: "web", revision: 1 } });
    state.set({ ...projectMemberKey(first.claims.org as OrgId, cloudId, "web"), entityType: "MEMBERSHIP", ownerKey: cloudId, projectName: "web", role: "developer" });

    const second = await signIn(h, "github", "4711");
    expect(second.claims).toMatchObject({ sub: cloudId, org: first.claims.org, org_role: "owner", amr: "github" });
    expect(members(h, first.claims.org)).toHaveLength(1);
    expect(orgsMade(h)).toHaveLength(1);
    expect(h.db.get(`DEVELOPER#${cloudId}`, "META")).toMatchObject({ provider: "cloud", issuer: OIDC_ISSUER, subject: priya.sub });
    expect(h.db.get(`DEVELOPER#${githubId}`, "META")).toBeUndefined();
    expect(h.state.get(developerOrgKey(githubId))).toBeUndefined();

    // The GitHub session lists the project the cloud developer was granted.
    const projects = await brokerCall(h, "GET", "/v1/dev/projects", second.token);
    expect(projects.status).toBe(200);
    expect((projects.body as { projects: Array<{ name: string; access: string }> }).projects.map((project) => [project.name, project.access])).toEqual([["web", "granted"]]);
  });

  it("GitHub first, then email: the same result the other way round", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [priya], github: { users: [priyaGithub()] } });
    const first = await signIn(h, "github", "4711");
    expect(first.claims).toMatchObject({ sub: githubId, org_role: "owner" });
    const second = await signIn(h, "cloud", priya.sub);
    expect(second.claims).toMatchObject({ sub: githubId, org: first.claims.org, org_role: "owner", amr: "cloud" });
    expect(members(h, first.claims.org)).toHaveLength(1);
    expect(orgsMade(h)).toHaveLength(1);
    expect(h.db.get(`DEVELOPER#${githubId}`, "META")).toMatchObject({ provider: "github", issuer: GITHUB_ISSUER, subject: "4711" });
    expect(h.db.get(`DEVELOPER#${cloudId}`, "META")).toBeUndefined();
  });

  it("an unverified GitHub email links nothing: a second developer and a second org", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [priya], github: { users: [priyaGithub(false)] } });
    const first = await signIn(h, "cloud", priya.sub);
    const second = await signIn(h, "github", "4711");
    expect(second.claims.sub).toBe(githubId);
    expect(second.claims.sub).not.toBe(first.claims.sub);
    expect(second.claims.org).not.toBe(first.claims.org);
    expect(orgsMade(h)).toHaveLength(2);
  });

  it("a person who already owns an org keeps it (I1): a pre-link GitHub developer signing in with an email that names another org", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [priya], github: { users: [priyaGithub()] } });
    // D1 is the cloud developer in org Y, whose ORG_EMAIL names the shared address.
    const y = await signIn(h, "cloud", priya.sub);
    // D2 is a GitHub developer from before identity links: a developer record, an org X it owns, no link item.
    h.db.set({ pk: `DEVELOPER#${githubId}`, sk: "META", entityType: "DEVELOPER", developerId: githubId, provider: "github", issuer: GITHUB_ISSUER, subject: "4711", displayName: "Priya R.", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    const x = await h.orgs.createOrgWithOwner({ name: "Priya R.'s team", developerId: githubId });
    expect(h.db.get(signInIdentityKey(githubId))).toBeUndefined();

    const d2 = await signIn(h, "github", "4711");
    expect(d2.claims).toMatchObject({ sub: githubId, org: x, org_role: "owner" });
    expect(h.state.get(orgMemberKey(x, githubId))).toMatchObject({ role: "owner" });
    expect(members(h, x)).toHaveLength(1);
    expect(members(h, y.claims.org)).toHaveLength(1);
    expect(h.db.get(signInIdentityKey(githubId))).toMatchObject({ developerId: githubId });
  });

  it("does not link by an address that only looks ASCII after Unicode folding (U+212A KELVIN SIGN)", async () => {
    const kate: FakeOidcUser = { sub: "kate-1", name: "Kate", email: "kate@provider.dev", email_verified: true };
    const kelvin: FakeGithubUser = { id: 4712, login: "kate-k", name: "Kate K.", emails: [{ email: "Kate@provider.dev", primary: true, verified: true }] };
    const h = identityHarness({ cloud: {}, oidcUsers: [kate], github: { users: [kelvin] } });
    const first = await signIn(h, "cloud", kate.sub);
    const second = await signIn(h, "github", "4712");
    expect(second.location.searchParams.get("error")).toBeNull();
    expect(second.claims.sub).toBe(ownerKeyForSubject(GITHUB_ISSUER, "4712"));
    expect(second.claims.sub).not.toBe(first.claims.sub);
    expect(second.claims.org).not.toBe(first.claims.org);
    // The address pointer still names the first developer.
    expect(h.state.get(orgEmailKey("kate@provider.dev"))).toMatchObject({ developerId: first.claims.sub });
  });

  it("an oidc sign-in on a single-org install with the same email is not linked (rule 2 is for the cloud methods)", async () => {
    const company: FakeOidcUser = { sub: "priya-company", name: "Priya", email: "priya@acme.dev", email_verified: true };
    const h = identityHarness({ cloud: {}, oidc: {}, oidcUsers: [priya, company] });
    const first = await signIn(h, "cloud", priya.sub);
    const second = await signIn(h, "oidc", company.sub);
    expect(second.claims.sub).toBe(ownerKeyForSubject(OIDC_ISSUER, company.sub));
    expect(second.claims.sub).not.toBe(first.claims.sub);
    expect(h.db.get(signInIdentityKey(ownerKeyForSubject(OIDC_ISSUER, company.sub)))).toMatchObject({ developerId: second.claims.sub });
  });

  it("a third sign-in resolves through the link alone, after the email pointer is gone", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [priya], github: { users: [priyaGithub()] } });
    const first = await signIn(h, "cloud", priya.sub);
    expect((await signIn(h, "github", "4711")).claims.sub).toBe(first.claims.sub);
    h.state.delete(orgEmailKey("priya@acme.dev"));
    const third = await signIn(h, "github", "4711");
    expect(third.claims).toMatchObject({ sub: first.claims.sub, org: first.claims.org });
    expect(orgsMade(h)).toHaveLength(1);
  });

  it("refuses the linked identity's sign-in when the first developer is revoked", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [priya], github: { users: [priyaGithub()] } });
    await signIn(h, "cloud", priya.sub);
    h.db.set({ ...h.db.get(`DEVELOPER#${cloudId}`, "META")!, revoked: true });
    const refused = await signIn(h, "github", "4711");
    expect(refused.location.searchParams.get("code")).toBeNull();
    expect(refused.location.searchParams.get("error")).toBe("access_denied");
    expect(refused.location.searchParams.get("error_description")).toBe("your AgentX sign-in was turned off by an admin; contact an admin");
  });

  it("records the identity used on the session, and leaves the developer's issuer and subject alone", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [priya], github: { users: [priyaGithub()] } });
    await signIn(h, "cloud", priya.sub);
    await signIn(h, "github", "4711");
    const sessions = h.db.find((item) => item.entityType === "SESSION");
    expect(sessions.map((session) => [session.amr, session.developerId, session.identityKey]).sort()).toEqual([
      ["cloud", cloudId, cloudId],
      ["github", cloudId, githubId],
    ]);
    expect(h.db.get(signInIdentityKey(githubId))).toMatchObject({ developerId: cloudId, provider: "github", issuer: GITHUB_ISSUER, subject: "4711", email: "priya@acme.dev", login: "priya-dev" });
    expect(h.db.get(developerIdentityKey(cloudId, githubId))).toMatchObject({ developerId: cloudId, provider: "github" });
  });
});

describe("resolveSignInDeveloper", () => {
  function setup() {
    const db = new FakeDynamoDb();
    const state = new FakeDynamoDb();
    const store = new DeveloperSignInStore({ documentClient: db, tableName: "signin", now: () => T0 });
    const orgs = new OrgStore({ documentClient: state, tableName: "state", now: () => T0 });
    return { db, state, store, orgs };
  }
  const githubIdentity = { method: "github" as const, issuer: GITHUB_ISSUER, subject: "4711", displayName: "Priya", email: "priya@acme.dev", emailVerified: true };

  it("reports new-self, then existing, then new-linked for the second route", async () => {
    const { store, orgs } = setup();
    const cloudIdentity = { method: "cloud" as const, issuer: OIDC_ISSUER, subject: priya.sub, displayName: "Priya", email: "priya@acme.dev", emailVerified: true };
    expect(await resolveSignInDeveloper({ store, orgs }, { method: "cloud", identity: cloudIdentity })).toEqual({ developerId: cloudId, identityKey: cloudId, link: "new-self" });
    await orgs.createOrgWithOwner({ name: "Priya's team", developerId: cloudId, email: "priya@acme.dev" });
    expect(await resolveSignInDeveloper({ store, orgs }, { method: "cloud", identity: cloudIdentity })).toEqual({ developerId: cloudId, identityKey: cloudId, link: "existing" });
    expect(await resolveSignInDeveloper({ store, orgs }, { method: "github", identity: githubIdentity })).toEqual({ developerId: cloudId, identityKey: githubId, link: "new-linked" });
    expect(await resolveSignInDeveloper({ store, orgs }, { method: "github", identity: githubIdentity })).toEqual({ developerId: cloudId, identityKey: githubId, link: "existing" });
  });

  it("rule 1 reads only an explicit link item: a pre-link developer with no org still joins the email's developer (C4)", async () => {
    const { db, store, orgs } = setup();
    await orgs.createOrgWithOwner({ name: "Priya's team", developerId: cloudId, email: "priya@acme.dev" });
    db.set({ pk: `DEVELOPER#${githubId}`, sk: "META", entityType: "DEVELOPER", developerId: githubId, provider: "github", issuer: GITHUB_ISSUER, subject: "4711", displayName: "Priya", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    // The fallback says this identity is its own developer, yet sign-in resolves it through rule 2.
    expect(await store.developerForIdentity(githubId)).toBe(githubId);
    expect((await resolveSignInDeveloper({ store, orgs }, { method: "github", identity: githubIdentity })).link).toBe("new-linked");
  });

  it("never links an identity that was unlinked: it starts its own developer (rule 3) and keeps unlinkedFrom (C5)", async () => {
    const { db, store, orgs } = setup();
    await orgs.createOrgWithOwner({ name: "Priya's team", developerId: cloudId, email: "priya@acme.dev" });
    db.set({ ...signInIdentityKey(githubId), entityType: "IDENTITY_LINK", developerId: cloudId, provider: "github", issuer: GITHUB_ISSUER, subject: "4711", linkedAt: "2026-09-01T00:00:00.000Z", lastSignInAt: "2026-09-01T00:00:00.000Z", unlinkedFrom: cloudId, unlinkedAt: "2026-09-02T00:00:00.000Z" });
    expect(await store.developerForIdentity(githubId)).toBeUndefined();
    expect(await resolveSignInDeveloper({ store, orgs }, { method: "github", identity: githubIdentity })).toEqual({ developerId: githubId, identityKey: githubId, link: "new-self", separatedFrom: cloudId });
    expect(db.get(signInIdentityKey(githubId))).toMatchObject({ developerId: githubId, unlinkedFrom: cloudId, unlinkedAt: "2026-09-02T00:00:00.000Z" });
    expect(await store.developerForIdentity(githubId)).toBe(githubId);
    // A later sign-in is an ordinary existing link, still separated from the developer it left (so starting its own company is not refused as a race).
    expect(await resolveSignInDeveloper({ store, orgs }, { method: "github", identity: githubIdentity })).toEqual({ developerId: githubId, identityKey: githubId, link: "existing", separatedFrom: cloudId });
  });
});

describe("DeveloperSignInStore identity links", () => {
  const input = (overrides: Partial<Parameters<DeveloperSignInStore["linkIdentity"]>[0]> = {}) =>
    ({ identityKey: githubId, developerId: cloudId, provider: "github" as const, issuer: GITHUB_ISSUER, subject: "4711", email: "priya@acme.dev", login: "priya-dev", ...overrides });
  function setup() {
    let clock = T0;
    const db = new FakeDynamoDb();
    const store = new DeveloperSignInStore({ documentClient: db, tableName: "signin", now: () => clock });
    return { db, store, tick: (ms: number) => { clock += ms; } };
  }
  const identityRows = (db: FakeDynamoDb) => db.find((item) => String(item.sk).startsWith("IDENTITY#"));

  it("developerForIdentity: a link item wins; before any link, a developer of the identity's own issuer and subject is its own", async () => {
    const { db, store } = setup();
    expect(await store.developerForIdentity(githubId)).toBeUndefined();
    db.set({ pk: `DEVELOPER#${githubId}`, sk: "META", developerId: githubId, provider: "github", issuer: GITHUB_ISSUER, subject: "4711", displayName: "Priya", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    expect(await store.developerForIdentity(githubId)).toBe(githubId);
    // A record under that key for some other issuer and subject does not count.
    db.set({ pk: `DEVELOPER#${cloudId}`, sk: "META", developerId: cloudId, provider: "github", issuer: GITHUB_ISSUER, subject: "9999", displayName: "X", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    expect(await store.developerForIdentity(cloudId)).toBeUndefined();
    await store.linkIdentity(input());
    expect(await store.developerForIdentity(githubId)).toBe(cloudId);
  });

  it("linkIdentity writes both items once and reports created only the first time", async () => {
    const { db, store } = setup();
    expect(await store.linkIdentity(input())).toEqual({ developerId: cloudId, created: true });
    expect(await store.linkIdentity(input())).toEqual({ developerId: cloudId, created: false });
    expect(db.get(signInIdentityKey(githubId))).toMatchObject({ developerId: cloudId, provider: "github", issuer: GITHUB_ISSUER, subject: "4711", email: "priya@acme.dev", login: "priya-dev", linkedAt: new Date(T0).toISOString(), lastSignInAt: new Date(T0).toISOString() });
    expect(db.get(developerIdentityKey(cloudId, githubId))).toMatchObject({ developerId: cloudId, provider: "github" });
  });

  it("linkIdentity returns the developer that won when another is already linked, and writes nothing", async () => {
    const { db, store } = setup();
    await store.linkIdentity(input());
    const before = JSON.stringify([...db.items.entries()]);
    expect(await store.linkIdentity(input({ developerId: githubId }))).toEqual({ developerId: cloudId, created: false });
    expect(JSON.stringify([...db.items.entries()])).toBe(before);
  });

  it("two links racing for one identity: the loser's conditional write fails and it returns the winner's developer (D4)", async () => {
    const { db, store } = setup();
    const writes: unknown[] = [];
    db.onWrite((change) => writes.push(change));
    // Just before the loser's transaction runs, the other sign-in's link lands: the same two items its own transaction writes.
    let raced = false;
    db.injectFault({
      command: "TransactWriteCommand",
      match: () => {
        if (raced) return false;
        raced = true;
        const at = new Date(T0).toISOString();
        const body = { entityType: "IDENTITY_LINK", developerId: githubId, provider: "github", issuer: GITHUB_ISSUER, subject: "4711", linkedAt: at, lastSignInAt: at };
        db.set({ ...signInIdentityKey(githubId), ...body });
        db.set({ ...developerIdentityKey(githubId, githubId), ...body });
        return false;
      },
      error: { name: "TransactionCanceledException" },
    });
    expect(await store.linkIdentity(input())).toEqual({ developerId: githubId, created: false });
    expect(raced).toBe(true);
    // The loser's own transaction ran against the winner's item and committed nothing.
    expect(writes).toEqual([]);
    expect(db.get(signInIdentityKey(githubId))).toMatchObject({ developerId: githubId });
    expect(identityRows(db)).toHaveLength(1);
    expect(db.get(developerIdentityKey(cloudId, githubId))).toBeUndefined();
  });

  it("two concurrent link calls for one identity to different developers both return the same developer", async () => {
    const { db, store } = setup();
    const results = await Promise.all([store.linkIdentity(input()), store.linkIdentity(input({ developerId: githubId }))]);
    expect(results[0].developerId).toBe(results[1].developerId);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(identityRows(db)).toHaveLength(1);
  });

  it("refuses to link an unlinked identity to anyone but its own developer", async () => {
    const { db, store } = setup();
    db.set({ ...signInIdentityKey(githubId), developerId: cloudId, provider: "github", issuer: GITHUB_ISSUER, subject: "4711", linkedAt: "x", lastSignInAt: "x", unlinkedFrom: cloudId, unlinkedAt: "y" });
    await expect(store.linkIdentity(input())).rejects.toThrow("unlinked");
  });

  it("identitiesOf lists a developer's linked methods, oldest first, with no issuer or subject", async () => {
    const { store, tick } = setup();
    await store.linkIdentity(input({ identityKey: cloudId, developerId: cloudId, provider: "cloud", issuer: OIDC_ISSUER, subject: priya.sub }));
    tick(60_000);
    await store.linkIdentity(input());
    await store.linkIdentity(input({ identityKey: "f".repeat(64), developerId: "e".repeat(64), provider: "slack", issuer: "https://slack.com", subject: "U1" }));
    const identities = await store.identitiesOf(cloudId);
    expect(identities.map((identity) => identity.provider)).toEqual(["cloud", "github"]);
    expect(identities[1]).toEqual({ provider: "github", email: "priya@acme.dev", login: "priya-dev", linkedAt: new Date(T0 + 60_000).toISOString(), lastSignInAt: new Date(T0 + 60_000).toISOString() });
    expect(JSON.stringify(identities)).not.toMatch(/issuer|subject/);
  });

  it("touchIdentity sets lastSignInAt on both items, and does nothing for an identity with no link", async () => {
    const { db, store, tick } = setup();
    await store.touchIdentity(githubId);
    expect(db.items.size).toBe(0);
    await store.linkIdentity(input());
    tick(5_000);
    await store.touchIdentity(githubId);
    const touched = new Date(T0 + 5_000).toISOString();
    expect(db.get(signInIdentityKey(githubId))).toMatchObject({ linkedAt: new Date(T0).toISOString(), lastSignInAt: touched });
    expect(db.get(developerIdentityKey(cloudId, githubId))).toMatchObject({ lastSignInAt: touched });
  });

  it("M2 (approval place): touchIdentity keeps the provider's auth_time beside lastSignInAt, never later than the sign-in, and a sign-in without one keeps the last good one", async () => {
    const { db, store, tick } = setup();
    await store.linkIdentity(input({ provider: "oidc", issuer: OIDC_ISSUER, subject: "sso-1", identityKey: ownerKeyForSubject(OIDC_ISSUER, "sso-1") }));
    const id = ownerKeyForSubject(OIDC_ISSUER, "sso-1");
    expect(db.get(signInIdentityKey(id))).not.toHaveProperty("lastAuthTime");
    // A silent renewal 5 seconds later: the provider says the person authenticated at T0 - 1 hour.
    tick(5_000);
    await store.touchIdentity(id, (T0 - 3_600_000) / 1000);
    for (const row of [db.get(signInIdentityKey(id)), db.get(developerIdentityKey(cloudId, id))]) {
      expect(row).toMatchObject({ lastSignInAt: new Date(T0 + 5_000).toISOString(), lastAuthTime: new Date(T0 - 3_600_000).toISOString() });
    }
    // A sign-in with no auth_time moves lastSignInAt and leaves the last good auth time alone.
    tick(5_000);
    await store.touchIdentity(id);
    expect(db.get(signInIdentityKey(id))).toMatchObject({ lastSignInAt: new Date(T0 + 10_000).toISOString(), lastAuthTime: new Date(T0 - 3_600_000).toISOString() });
    // An auth_time ahead of the clock is clamped to the sign-in; one that is not a plain positive number is none.
    tick(5_000);
    await store.touchIdentity(id, (T0 + 99_000_000) / 1000);
    expect(db.get(signInIdentityKey(id))).toMatchObject({ lastAuthTime: new Date(T0 + 15_000).toISOString() });
    for (const bad of [Number.NaN, -5, 0, Number.POSITIVE_INFINITY]) {
      tick(1_000);
      await store.touchIdentity(id, bad);
      expect(db.get(signInIdentityKey(id)), String(bad)).toMatchObject({ lastAuthTime: new Date(T0 + 15_000).toISOString() });
    }
  });

  it("M2: lastInteractiveSignInAt reads lastAuthTime for a company sign-in (none counts when the provider sent none) and lastSignInAt for an email code; an unlinked identity does not count", async () => {
    const { db, store, tick } = setup();
    const sso = ownerKeyForSubject(OIDC_ISSUER, "sso-2");
    await store.linkIdentity(input({ provider: "oidc", issuer: OIDC_ISSUER, subject: "sso-2", identityKey: sso }));
    tick(60_000);
    // A recent sign-in with no auth_time is not a recent sign-in.
    expect(await store.lastInteractiveSignInAt(cloudId, ["oidc", "saml"])).toBeUndefined();
    await store.touchIdentity(sso, (T0 - 7_200_000) / 1000);
    expect(await store.lastInteractiveSignInAt(cloudId, ["oidc", "saml"])).toBe(new Date(T0 - 7_200_000).toISOString());
    // An email code counts by the time of the sign-in itself; the newest counting one wins; a method not in the list never counts.
    const code = ownerKeyForSubject("https://cognito.example.test", "code-1");
    await store.linkIdentity(input({ provider: "cloud", issuer: "https://cognito.example.test", subject: "code-1", identityKey: code }));
    expect(await store.lastInteractiveSignInAt(cloudId, ["cloud", "oidc"])).toBe(new Date(T0 + 60_000).toISOString());
    expect(await store.lastInteractiveSignInAt(cloudId, ["github"])).toBeUndefined();
    expect(await store.lastInteractiveSignInAt(cloudId, ["oidc"])).toBe(new Date(T0 - 7_200_000).toISOString());
    // Unlinked: gone from the answer.
    const forward = db.get(signInIdentityKey(code)) as Record<string, unknown>;
    db.set({ ...forward, unlinkedFrom: cloudId, unlinkedAt: new Date(T0 + 70_000).toISOString() });
    db.delete(developerIdentityKey(cloudId, code));
    expect(await store.lastInteractiveSignInAt(cloudId, ["cloud"])).toBeUndefined();
  });
});

describe("GET /v1/app/me", () => {
  it("lists the linked cloud and GitHub methods, never an issuer or subject", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [priya], github: { users: [priyaGithub()] } });
    const first = await signIn(h, "cloud", priya.sub);
    const second = await signIn(h, "github", "4711");
    const me = await brokerCall(h, "GET", "/v1/app/me", second.token, "ANY /v1/app/{proxy+}");
    expect(me.status).toBe(200);
    const parsed = AppMeResponseSchema.parse(me.body);
    expect(parsed.developer).toEqual({ id: cloudId, name: "Priya Rao", email: "priya@acme.dev", orgRole: "owner", nameChosen: false });
    expect(parsed.org).toMatchObject({ orgId: first.claims.org, name: "Priya Rao's team", plan: "trial" });
    expect(parsed.identities.map((identity) => identity.provider)).toEqual(["cloud", "github"]);
    expect(parsed.identities[1]).toMatchObject({ email: "priya@acme.dev", login: "priya-dev" });
    const text = JSON.stringify(me.body);
    expect(text).not.toContain("subject");
    expect(text).not.toContain("issuer");
    expect(text).not.toContain(priya.sub);
  });

  it("answers only the app route key's own paths, and needs a signed-in developer", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [priya] });
    const { token } = await signIn(h, "cloud", priya.sub);
    expect((await brokerCall(h, "GET", "/v1/dev/org", token, "ANY /v1/app/{proxy+}")).status).toBe(404);
    expect((await brokerCall(h, "GET", "/v1/app/me", "not-a-token", "ANY /v1/app/{proxy+}")).status).toBe(401);
    expect((await brokerCall(h, "GET", "/v1/app/other", token, "ANY /v1/app/{proxy+}")).status).toBe(404);
  });
});

describe("M2 (approval place): a completed sign-in keeps the provider's auth_time on its identity link", () => {
  it("records the ID token's auth_time beside lastSignInAt, for the first sign-in and for later ones", async () => {
    const authenticated = T0 / 1000 - 7_200;
    const h = identityHarness({ cloud: {}, oidcUsers: [{ ...priya, auth_time: authenticated }] });
    await signIn(h, "cloud", priya.sub);
    expect(h.db.get(signInIdentityKey(cloudId))).toMatchObject({ lastAuthTime: new Date(authenticated * 1000).toISOString(), lastSignInAt: new Date(T0).toISOString() });
    expect(h.db.get(developerIdentityKey(cloudId, cloudId))).toMatchObject({ lastAuthTime: new Date(authenticated * 1000).toISOString() });
    // A silent renewal later: the provider still says the person authenticated at the same old time.
    await signIn(h, "cloud", priya.sub);
    expect(h.db.get(signInIdentityKey(cloudId))).toMatchObject({ lastAuthTime: new Date(authenticated * 1000).toISOString() });
  });

  it("a provider that sends no auth_time leaves none, so its sign-in is not counted as recent", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [priya] });
    await signIn(h, "cloud", priya.sub);
    await signIn(h, "cloud", priya.sub);
    expect(h.db.get(signInIdentityKey(cloudId))).not.toHaveProperty("lastAuthTime");
  });
});
