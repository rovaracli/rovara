// A removal with a ban marks the developer the person was. An identity the person unlinked BEFORE the removal carries no mark of its own: it signs in as a new developer of its
// own (`separatedFrom`), which the ban did not name. On an install with a single org the ban must cover every identity whose link says it was unlinked from a banned developer,
// through any chain of unlinks, for the Slack, company, cloud and GitHub sign-ins; and never someone else's identity, a person who already belongs, or a multi-company install.
import { describe, expect, it } from "vitest";
import { SLACK_OIDC_ISSUER } from "@rovara-code/contracts";
import { editionPolicy, orgMetaKey } from "@agentx/cloud-contracts";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { DeveloperSignInStore, signInIdentityKey } from "../../packages/broker/src/developer/store.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { REMOVED_FROM_ORG_MESSAGE, resolveOrgOnSignIn } from "../../packages/broker/src/org/sign-in.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { OIDC_ISSUER, T0, authorizeQuery, httpEvent, identityHarness, type FakeGithubUser, type FakeOidcUser, type FakeSlackUser } from "../support/developer-fakes.js";
import { TEST_ORG } from "../support/orgs.js";

const GITHUB_ISSUER = "https://github.com";
const enterprise = editionPolicy("enterprise");
const USERS = "rovara-users";
const BY = "a".repeat(64);

const owner: FakeOidcUser = { sub: "owner-1", name: "Olga", email: "olga@example.test", email_verified: true, groups: [USERS] };
const dee: FakeOidcUser = { sub: "dee", name: "Dee", email: "dee@example.test", email_verified: true, groups: [USERS] };
const slackDee: FakeSlackUser = { userId: "U0DEE0001", name: "Dee" };
const slackEve: FakeSlackUser = { userId: "U0EVE0001", name: "Eve" };
const slackOther: FakeSlackUser = { userId: "U0OTHER01", name: "Other" };
const slackKid: FakeSlackUser = { userId: "U0KID0001", name: "Kid" };
const second: FakeOidcUser = { sub: "dee-second", name: "Dee", email: "dee-second@example.test", email_verified: true, groups: [USERS] };
const eve: FakeOidcUser = { sub: "eve", name: "Eve", email: "eve@example.test", email_verified: true, groups: [USERS] };
const cloudDee: FakeOidcUser = { sub: "dee-cloud", name: "Dee", email: "dee-cloud@example.test", email_verified: true };
const octo: FakeGithubUser = { id: 4711, login: "octo", name: "Dee D.", emails: [{ email: "octo@example.test", primary: true, verified: true }] };

const key = (issuer: string, subject: string) => ownerKeyForSubject(issuer, subject);
const deeId = key(OIDC_ISSUER, dee.sub);
const ownerId = key(OIDC_ISSUER, owner.sub);

async function world(options: { company?: boolean; singleOrg?: boolean } = {}) {
  const h = identityHarness({
    oidc: {}, cloud: {}, github: { users: [octo] }, oidcUsers: [owner, dee, second, eve, cloudDee], slackUsers: [slackDee, slackEve, slackOther, slackKid],
    ...(options.singleOrg === false ? { singleOrg: false } : {}),
    ...(options.company === true ? { editionPolicy: enterprise, sso: true } : {}),
  });
  await h.orgs.ensureOrg(TEST_ORG, "staging");
  await h.orgs.addMember({ orgId: TEST_ORG, developerId: ownerId, role: "owner" });
  h.db.set({ ...orgMetaKey(TEST_ORG) });
  if (options.company === true) {
    await h.deps.sso!.mappings.put(TEST_ORG, { claim: "groups", rules: [{ id: "users", group: USERS, orgRole: "member" as const, projectRoles: [] }], updatedAt: "2026-10-31T00:00:00Z", updatedBy: BY }, 0);
  }
  return h;
}
type World = Awaited<ReturnType<typeof world>>;

/** The sign-in as the CLI makes it. `redirect.error_description` is the refusal's words. */
async function signInWith(h: World, method: "slack" | "oidc" | "cloud" | "github", who: string): Promise<{ code: string | null; error: string | null; words: string | null; sub?: string }> {
  const location = method === "oidc" && h.deps.editionPolicy !== undefined ? await companySignIn(h, who) : await h.signIn(method, who);
  const code = location.searchParams.get("code");
  const sub = code === null ? undefined : (JSON.parse(Buffer.from(String((await h.exchange(code)).body.access_token).split(".")[1]!, "base64url").toString("utf8")) as { sub: string }).sub;
  return { code, error: location.searchParams.get("error"), words: location.searchParams.get("error_description"), ...(sub === undefined ? {} : { sub }) };
}
async function companySignIn(h: World, who: string): Promise<URL> {
  let started = await h.http(httpEvent("GET", authorizeQuery()));
  if (started.statusCode === 200) started = await h.http(httpEvent("GET", /href="([^"]*method=oidc)"/.exec(started.body)![1]!.replaceAll("&amp;", "&")));
  const back = await h.http(httpEvent("GET", h.oidc.approve(started.headers.location!, who)));
  return new URL(back.headers.location ?? "https://none.invalid/");
}

/** A person's developer `developerId` already holds `provider`'s identity `subject` (a link as the link flow writes it). */
async function link(h: World, developerId: string, provider: "slack" | "github" | "cloud", issuer: string, subject: string): Promise<string> {
  const identityKey = key(issuer, subject);
  expect(await h.deps.store.linkIdentity({ identityKey, developerId, provider, issuer, subject })).toEqual({ developerId, created: true });
  return identityKey;
}
/** The person unlinks `provider` from `developerId`, as the unlink route does (a fresh sign-in with another method). */
async function unlink(h: World, developerId: string, provider: "slack" | "github" | "cloud", amr: "oidc" | "slack" = "oidc"): Promise<void> {
  const { session } = await h.deps.store.createSession({ developerId, amr, authTime: new Date(h.now()).toISOString() });
  await h.deps.store.unlinkIdentity({ developerId, sessionId: session.sessionId, provider, now: h.now() });
}
const ban = (h: World, developerId: string) => h.orgs.removeMember({ orgId: TEST_ORG, developerId, emails: [], ban: true, by: { kind: "member", id: ownerId } });

/** Dee (a company member) holds her Slack account; she unlinks it, and is then removed with a ban. */
async function deeUnlinkedThenBanned(h: World, provider: "slack" | "github" | "cloud" = "slack") {
  expect((await signInWith(h, "oidc", dee.sub)).sub).toBe(deeId);
  const identity = provider === "slack" ? await link(h, deeId, "slack", SLACK_OIDC_ISSUER, slackDee.userId)
    : provider === "github" ? await link(h, deeId, "github", GITHUB_ISSUER, String(octo.id)) : await link(h, deeId, "cloud", OIDC_ISSUER, cloudDee.sub);
  await unlink(h, deeId, provider);
  expect(h.db.get(signInIdentityKey(identity))).toMatchObject({ developerId: deeId, unlinkedFrom: deeId });
  await ban(h, deeId);
  expect(await h.orgs.isBanned(TEST_ORG, deeId)).toBe(true);
  return identity;
}

const REFUSED = { code: null, error: "access_denied", words: REMOVED_FROM_ORG_MESSAGE };

describe("a ban covers the identities the person unlinked before the removal (single-org install)", () => {
  it("Slack sign-in: the unlinked Slack account is refused, and no company membership or developer is made for it", async () => {
    const h = await world();
    const slackId = await deeUnlinkedThenBanned(h, "slack");
    expect(await signInWith(h, "slack", slackDee.userId)).toMatchObject(REFUSED);
    expect(await h.orgs.orgForDeveloper(slackId)).toBeUndefined();
  });

  it("company sign-in (the install's sign-in, no edition): the unlinked company identity is refused", async () => {
    const h = await world();
    expect((await signInWith(h, "oidc", dee.sub)).sub).toBe(deeId);
    // The company identity of a second sign-in route of Dee's, linked to her and then unlinked.
    const secondId = await link(h, deeId, "cloud", OIDC_ISSUER, second.sub);
    await unlink(h, deeId, "cloud");
    await ban(h, deeId);
    expect(await h.orgs.orgForDeveloper(secondId)).toBeUndefined();
    expect(await signInWith(h, "oidc", second.sub)).toMatchObject(REFUSED);
    expect(await h.orgs.orgForDeveloper(secondId)).toBeUndefined();
  });

  it("company sign-in with the edition's group mapping (rule 4 and the early check): refused, with the refusal on record and nothing written for the identity", async () => {
    const h = await world({ company: true });
    expect((await signInWith(h, "oidc", dee.sub)).sub).toBe(deeId);
    const secondId = await link(h, deeId, "cloud", OIDC_ISSUER, second.sub);
    await unlink(h, deeId, "cloud");
    await ban(h, deeId);
    const before = h.state.find((item) => item.entityType === "ORG_MEMBER" || item.entityType === "MEMBER").length;
    expect(await signInWith(h, "oidc", second.sub)).toMatchObject(REFUSED);
    expect(await h.orgs.orgForDeveloper(secondId)).toBeUndefined();
    expect(h.state.find((item) => item.entityType === "ORG_MEMBER" || item.entityType === "MEMBER")).toHaveLength(before);
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "signin.refused", reason: "removed_from_org", developerId: secondId }));
    // Refused at the early check, before the person is written: no developer record, no session (the later check would have written the record first).
    expect(await h.deps.store.getDeveloper(secondId)).toBeUndefined();
  });

  it("cloud sign-in: the unlinked cloud identity is refused (it would start a company of its own)", async () => {
    const h = await world();
    const cloudId = await deeUnlinkedThenBanned(h, "cloud");
    expect(await signInWith(h, "cloud", cloudDee.sub)).toMatchObject(REFUSED);
    expect(await h.orgs.orgForDeveloper(cloudId)).toBeUndefined();
  });

  it("GitHub sign-in: the unlinked GitHub identity is refused (it would start a company of its own)", async () => {
    const h = await world();
    const githubId = await deeUnlinkedThenBanned(h, "github");
    expect(await signInWith(h, "github", String(octo.id))).toMatchObject(REFUSED);
    expect(await h.orgs.orgForDeveloper(githubId)).toBeUndefined();
  });

  it("a chain of two unlinks is still refused: the identity left an account that had itself left the banned one", async () => {
    const h = await world();
    expect((await signInWith(h, "oidc", dee.sub)).sub).toBe(deeId);
    // Slack account S1 leaves Dee, and signs in on its own: it is a member of its own (it was not banned then).
    const s1 = await link(h, deeId, "slack", SLACK_OIDC_ISSUER, slackEve.userId);
    await unlink(h, deeId, "slack");
    expect((await signInWith(h, "slack", slackEve.userId)).sub).toBe(s1);
    // GitHub T joins S1's account and leaves it.
    const t = await link(h, s1, "github", GITHUB_ISSUER, String(octo.id));
    await unlink(h, s1, "github", "slack");
    expect(h.db.get(signInIdentityKey(t))).toMatchObject({ unlinkedFrom: s1 });
    // Now Dee is removed with a ban.
    await ban(h, deeId);
    // The middle account is a member in its own right: not blocked. The identity two unlinks away is refused.
    expect((await signInWith(h, "slack", slackEve.userId)).sub).toBe(s1);
    expect(await signInWith(h, "github", String(octo.id))).toMatchObject(REFUSED);
    expect(await h.orgs.orgForDeveloper(t)).toBeUndefined();
    // And through the store: both ids, nearest first.
    expect(await h.deps.store.formerDevelopersOf(t)).toEqual([s1, deeId]);
  });

  it("an invite is still the way back: the unlinked identity joins with a valid invite", async () => {
    const h = await world();
    const slackId = await deeUnlinkedThenBanned(h, "slack");
    const { token } = await h.orgs.createInvite({ orgId: TEST_ORG, createdBy: ownerId, role: "member" });
    const location = await h.signIn("slack", slackDee.userId, { query: { invite: token } });
    expect(location.searchParams.get("code")).not.toBeNull();
    expect((await h.orgs.orgForDeveloper(slackId))?.role).toBe("member");
  });
});

describe("what the guard must not touch", () => {
  it("an unrelated Slack identity, and one unlinked from a developer who was NOT banned, sign in as before", async () => {
    const h = await world();
    await deeUnlinkedThenBanned(h, "slack");
    // Another member (Eve's company account) unlinks her Slack account; nobody bans her.
    const eveId = key(OIDC_ISSUER, eve.sub);
    expect((await signInWith(h, "oidc", eve.sub)).sub).toBe(eveId);
    const eveSlack = await link(h, eveId, "slack", SLACK_OIDC_ISSUER, slackEve.userId);
    await unlink(h, eveId, "slack");
    expect(await h.deps.store.formerDevelopersOf(eveSlack)).toEqual([eveId]);
    expect((await signInWith(h, "slack", slackEve.userId)).sub).toBe(eveSlack);
    expect((await signInWith(h, "slack", slackOther.userId)).sub).toBe(key(SLACK_OIDC_ISSUER, slackOther.userId));
  });

  it("an identity another, non-banned person owns (linked to their account, never unlinked) is not blocked by the banned person's ban", async () => {
    const h = await world();
    await deeUnlinkedThenBanned(h, "slack");
    expect((await signInWith(h, "oidc", owner.sub)).sub).toBe(ownerId);
    const kid = await link(h, ownerId, "slack", SLACK_OIDC_ISSUER, slackKid.userId);
    expect(await h.deps.store.formerDevelopersOf(kid)).toEqual([]);
    expect((await signInWith(h, "slack", slackKid.userId)).sub).toBe(ownerId);
  });

  it("a separated identity that already belongs to the company (it joined before the ban) keeps its way in", async () => {
    const h = await world();
    expect((await signInWith(h, "oidc", dee.sub)).sub).toBe(deeId);
    const slackId = await link(h, deeId, "slack", SLACK_OIDC_ISSUER, slackDee.userId);
    await unlink(h, deeId, "slack");
    expect((await signInWith(h, "slack", slackDee.userId)).sub).toBe(slackId);
    await ban(h, deeId);
    expect((await signInWith(h, "slack", slackDee.userId)).sub).toBe(slackId);
  });

  it("a multi-company install (no single org) is unchanged: a separated cloud identity starts its own company, whatever bans exist", async () => {
    const h = await world({ singleOrg: false });
    expect((await signInWith(h, "cloud", cloudDee.sub)).sub).toBe(key(OIDC_ISSUER, cloudDee.sub));
    // A ban row for the former developer under some org does not matter where there is no single org.
    const state = new FakeDynamoDb();
    const orgs = new OrgStore({ documentClient: state, tableName: "state", now: () => T0 });
    const former = "f".repeat(64);
    const separated = "c".repeat(64);
    state.set({ pk: `ORG#${TEST_ORG}`, sk: `BAN#${former}`, entityType: "ORG_BAN" });
    const result = await resolveOrgOnSignIn({ orgs }, { method: "cloud", developerId: separated, displayName: "Maya", emailVerified: false, separatedFrom: former, formerDeveloperIds: [former] });
    expect(result.role).toBe("owner");
    expect(await orgs.orgForDeveloper(separated)).toBeDefined();
  });

  it("the store refuses a chain it cannot finish (a loop is walked once; a very long chain fails closed)", async () => {
    const state = new FakeDynamoDb();
    const store = new DeveloperSignInStore({ documentClient: state, tableName: "signin", now: () => T0 });
    const tomb = (id: string, from: string) => state.set({ ...signInIdentityKey(id), entityType: "IDENTITY_LINK", developerId: from, provider: "slack", issuer: "i", subject: id, linkedAt: "x", lastSignInAt: "x", unlinkedFrom: from, unlinkedAt: "y" });
    tomb("a", "b");
    tomb("b", "a");
    expect(await store.formerDevelopersOf("a")).toEqual(["b", "a"]);
    for (let index = 0; index < 20; index += 1) tomb(`n${index}`, `n${index + 1}`);
    await expect(store.formerDevelopersOf("n0")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await store.formerDevelopersOf("never-unlinked")).toEqual([]);
  });
});
