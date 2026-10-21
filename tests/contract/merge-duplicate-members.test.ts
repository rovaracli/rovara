// Plan 2, Task 3: one person who signed in two ways before identity links is two members of the same org. The duplicate's next
// sign-in merges it into the member the verified email names: grants, budget override and role move over, and the duplicate retires.
import { describe, expect, it } from "vitest";
import { developerOrgKey, memberGrantsPk, orgEmailKey, orgMemberKey, orgPk, orgSettingsKey, projectMemberKey, type OrgId, type OrgRole } from "@agentx/contracts";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { resolveSignInDeveloper, type ResolveSignInDeveloperDependencies } from "../../packages/broker/src/developer/identities.js";
import type { ProviderIdentity } from "../../packages/broker/src/developer/providers.js";
import { DeveloperSignInStore, endedByAdmin, signInIdentityKey } from "../../packages/broker/src/developer/store.js";
import { mergeDuplicateMember } from "../../packages/broker/src/org/merge-members.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { identityHarness, type FakeGithubUser, type FakeOidcUser } from "../support/developer-fakes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const GITHUB_ISSUER = "https://github.com";
const OIDC_ISSUER = "https://idp.example.test";
const T0 = Date.parse("2026-10-20T12:00:00.000Z");
const D1 = ownerKeyForSubject(OIDC_ISSUER, "priya-cloud-1");
const D2 = ownerKeyForSubject(GITHUB_ISSUER, "4711");
const EMAIL = "priya@acme.dev";
const githubIdentity: ProviderIdentity = { method: "github", issuer: GITHUB_ISSUER, subject: "4711", displayName: "Priya R.", email: EMAIL, emailVerified: true, login: "priya-dev" };

const developerRecord = (developerId: string, provider: "cloud" | "github", issuer: string, subject: string) =>
  ({ pk: `DEVELOPER#${developerId}`, sk: "META", entityType: "DEVELOPER", developerId, provider, issuer, subject, displayName: "Priya", email: EMAIL, firstSignInAt: "2026-09-01T00:00:00.000Z", lastSignInAt: "2026-09-02T00:00:00.000Z", revoked: false });

/** The staging shape: D1 (email code) created the org and holds the email pointer; D2 (GitHub) was added by a sign-in from before identity links. */
async function seed(db: FakeDynamoDb, orgs: OrgStore, options: { survivorRole?: OrgRole; duplicateRole?: OrgRole } = {}): Promise<OrgId> {
  db.set(developerRecord(D1, "cloud", OIDC_ISSUER, "priya-cloud-1"));
  db.set(developerRecord(D2, "github", GITHUB_ISSUER, "4711"));
  const orgId = await orgs.createOrgWithOwner({ name: "Priya's team", developerId: D1, email: EMAIL });
  await orgs.addMember({ orgId, developerId: D2, role: options.duplicateRole ?? "member" });
  const survivorRole = options.survivorRole ?? "member";
  db.set({ ...db.get(orgMemberKey(orgId, D1))!, role: survivorRole });
  db.set({ ...db.get(developerOrgKey(D1))!, role: survivorRole });
  return orgId;
}

/** One table plays both the State table and the sign-in table (their keys never collide), so the merge's one transaction is visible whole. */
async function world(options: { survivorRole?: OrgRole; duplicateRole?: OrgRole } = {}) {
  let clock = T0;
  const db = new FakeDynamoDb();
  const logs: Array<Record<string, unknown>> = [];
  const store = new DeveloperSignInStore({ documentClient: db, tableName: "signin", now: () => clock });
  const orgs = new OrgStore({ documentClient: db, tableName: "state", now: () => clock });
  const merge = (orgId: OrgId, survivorId = D1, duplicateId = D2) => mergeDuplicateMember({ documentClient: db, tableName: "state", signInStore: store, now: () => clock }, { orgId, survivorId, duplicateId, duplicateIdentityKey: duplicateId });
  const deps: ResolveSignInDeveloperDependencies = {
    store, orgs, log: (entry) => logs.push(entry),
    mergeDuplicate: (input) => mergeDuplicateMember({ documentClient: db, tableName: "state", signInStore: store, now: () => clock }, input),
  };
  const orgId = await seed(db, orgs, options);
  return { db, store, orgs, logs, merge, deps, orgId, tick: (ms: number) => { clock += ms; } };
}

const grant = (orgId: OrgId, developerId: string, project: string, grantId: string) =>
  ({ ...projectMemberKey(orgId, developerId, project), entityType: "MEMBERSHIP", ownerKey: developerId, projectName: project, role: "developer", grantId });
const memberItems = (db: FakeDynamoDb, orgId: OrgId) => db.find((item) => item.pk === orgPk(orgId) && String(item.sk).startsWith("MEMBER#"));
const grantsOf = (db: FakeDynamoDb, orgId: OrgId, developerId: string) => db.find((item) => item.pk === memberGrantsPk(orgId, developerId));
const WRITES = new Set(["PutCommand", "UpdateCommand", "DeleteCommand", "TransactWriteCommand"]);
const snapshot = (db: FakeDynamoDb) => structuredClone([...db.items.entries()]);

describe("mergeDuplicateMember", () => {
  it("moves the grants (with the survivor's ownerKey), the member and pointer, and retires the duplicate", async () => {
    const w = await world();
    const { orgId } = w;
    w.db.set(grant(orgId, D2, "api", "grant-api"));
    w.db.set(grant(orgId, D1, "web", "grant-web"));
    const session = await w.store.createSession({ developerId: D2, amr: "github", identityKey: D2 });
    w.tick(60_000);

    const result = await w.merge(orgId);

    expect(result).toEqual({ grantsMoved: 1, overrideMoved: false, role: "member" });
    // The moved grant keeps its grantId and is the survivor's own, so the direct-membership proof (ownerKey === developerId) holds (C7).
    expect(grantsOf(w.db, orgId, D1).map((item) => [item.sk, item.ownerKey, item.grantId]).sort()).toEqual([["PROJECT#api", D1, "grant-api"], ["PROJECT#web", D1, "grant-web"]]);
    expect(grantsOf(w.db, orgId, D2)).toEqual([]);
    expect(memberItems(w.db, orgId).map((item) => item.developerId)).toEqual([D1]);
    expect(w.db.get(developerOrgKey(D2))).toBeUndefined();
    expect(w.db.get(developerOrgKey(D1))).toMatchObject({ orgId, role: "member" });
    // The duplicate's sign-in identity is now the survivor's, and the duplicate's record says where it went.
    expect(await w.store.getIdentityLink(D2)).toMatchObject({ developerId: D1, provider: "github", issuer: GITHUB_ISSUER, subject: "4711" });
    expect(await w.store.developerForIdentity(D2)).toBe(D1);
    expect((await w.store.identitiesOf(D1)).map((identity) => identity.provider)).toEqual(["github"]);
    const retired = await w.store.getDeveloper(D2);
    expect(retired).toMatchObject({ mergedInto: D1 });
    expect(retired?.sessionsEndedAt).toBeDefined();
    expect(endedByAdmin(session.session.startedAt, retired?.sessionsEndedAt)).toBe(true);
  });

  it("gives the survivor the higher role on the member record and the pointer, and moves the duplicate's budget override", async () => {
    const w = await world({ survivorRole: "member", duplicateRole: "owner" });
    const { orgId } = w;
    w.db.set({ ...orgSettingsKey(orgId, "BUDGET"), entityType: "ORG_BUDGET", orgMonthlyUsd: 500, memberOverrides: { [D2]: 50, other: 7 }, updatedBy: "admin", updatedAt: "2026-10-01T00:00:00.000Z" });

    expect(await w.merge(orgId)).toEqual({ grantsMoved: 0, overrideMoved: true, role: "owner" });

    expect(w.db.get(orgMemberKey(orgId, D1))).toMatchObject({ role: "owner" });
    expect(w.db.get(developerOrgKey(D1))).toMatchObject({ role: "owner" });
    const budget = w.db.get(orgSettingsKey(orgId, "BUDGET"))!;
    expect(budget).toMatchObject({ orgMonthlyUsd: 500, memberOverrides: { [D1]: 50, other: 7 }, updatedBy: "admin" });
    expect(Object.keys(budget.memberOverrides as object)).not.toContain(D2);
  });

  it("keeps the survivor's own override and higher role, and drops the duplicate's", async () => {
    const w = await world({ survivorRole: "admin", duplicateRole: "member" });
    const { orgId } = w;
    w.db.set({ ...orgSettingsKey(orgId, "BUDGET"), entityType: "ORG_BUDGET", memberOverrides: { [D1]: 20, [D2]: 50 } });
    expect(await w.merge(orgId)).toEqual({ grantsMoved: 0, overrideMoved: false, role: "admin" });
    expect(w.db.get(orgSettingsKey(orgId, "BUDGET"))!.memberOverrides).toEqual({ [D1]: 20 });
    expect(w.db.get(orgMemberKey(orgId, D1))).toMatchObject({ role: "admin" });
  });

  it("keeps the survivor's grant when both have one on a project, and drops the duplicate's", async () => {
    const w = await world();
    const { orgId } = w;
    w.db.set(grant(orgId, D1, "web", "survivor-grant"));
    w.db.set(grant(orgId, D2, "web", "duplicate-grant"));
    expect((await w.merge(orgId)).grantsMoved).toBe(0);
    expect(grantsOf(w.db, orgId, D1).map((item) => item.grantId)).toEqual(["survivor-grant"]);
    expect(grantsOf(w.db, orgId, D2)).toEqual([]);
  });

  it("is a no-op the second time: only reads", async () => {
    const w = await world();
    const { orgId } = w;
    w.db.set(grant(orgId, D2, "api", "grant-api"));
    w.tick(1000);
    await w.merge(orgId);
    const before = snapshot(w.db);
    const commandsBefore = w.db.commandNames().length;

    expect(await w.merge(orgId)).toEqual({ grantsMoved: 0, overrideMoved: false, role: "member" });

    const after = w.db.commandNames().slice(commandsBefore);
    expect(after.length).toBeGreaterThan(0);
    expect(after.filter((name) => WRITES.has(name))).toEqual([]);
    expect(snapshot(w.db)).toEqual(before);
  });

  it("finishes the job after a failed transaction: the grants and override already moved, the rest follows", async () => {
    const w = await world();
    const { orgId } = w;
    w.db.set(grant(orgId, D2, "api", "grant-api"));
    w.db.set({ ...orgSettingsKey(orgId, "BUDGET"), entityType: "ORG_BUDGET", memberOverrides: { [D2]: 50 } });
    w.db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" } });

    await expect(w.merge(orgId)).rejects.toThrow();
    expect(grantsOf(w.db, orgId, D1).map((item) => item.grantId)).toEqual(["grant-api"]);
    expect(memberItems(w.db, orgId)).toHaveLength(2);

    expect(await w.merge(orgId)).toMatchObject({ role: "member" });
    expect(memberItems(w.db, orgId).map((item) => item.developerId)).toEqual([D1]);
    expect(grantsOf(w.db, orgId, D1).map((item) => item.ownerKey)).toEqual([D1]);
    expect(w.db.get(orgSettingsKey(orgId, "BUDGET"))!.memberOverrides).toEqual({ [D1]: 50 });
    expect(await w.store.getDeveloper(D2)).toMatchObject({ mergedInto: D1 });
  });

  it("ends the duplicate's sessions on a re-run when the first run stopped after the transaction", async () => {
    const w = await world();
    const { orgId } = w;
    const session = await w.store.createSession({ developerId: D2, amr: "github", identityKey: D2 });
    w.tick(1000);
    // endSessions is the only UpdateCommand on the duplicate's record outside the transaction.
    w.db.injectFault({ command: "UpdateCommand", match: (input) => (input.Key as { pk?: string }).pk === `DEVELOPER#${D2}`, error: { name: "InternalServerError" } });
    await expect(w.merge(orgId)).rejects.toThrow();
    expect(await w.store.getDeveloper(D2)).toMatchObject({ mergedInto: D1 });
    expect((await w.store.getDeveloper(D2))?.sessionsEndedAt).toBeUndefined();

    w.tick(1000);
    await w.merge(orgId);
    expect(endedByAdmin(session.session.startedAt, (await w.store.getDeveloper(D2))?.sessionsEndedAt)).toBe(true);
  });

  it("refuses, writing nothing, unless both are members of the org", async () => {
    const w = await world();
    const { orgId } = w;
    const other = await w.orgs.createOrgWithOwner({ name: "Elsewhere", developerId: "d_elsewhere" });
    for (const [org, survivor, duplicate] of [[other, D1, D2], [orgId, D1, "d_nobody"], [orgId, "d_nobody", D2], [orgId, D1, D1]] as const) {
      const commandsBefore = w.db.commandNames().length;
      const before = snapshot(w.db);
      await expect(w.merge(org, survivor, duplicate)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect(w.db.commandNames().slice(commandsBefore).filter((name) => WRITES.has(name))).toEqual([]);
      expect(snapshot(w.db)).toEqual(before);
    }
  });

  it("leaves tasks and workspaces owned by the duplicate as they were", async () => {
    const w = await world();
    const { orgId } = w;
    const task = { pk: "DEVTASK#task-1", sk: "META", entityType: "DEVELOPER_TASK", developerId: D2, ownerKey: D2, project: "api", status: "completed" };
    const workspace = { pk: "WORKSPACE#ws-1", sk: "META", entityType: "WORKSPACE", ownerKey: D2, orgId, projectName: "api" };
    w.db.set(structuredClone(task));
    w.db.set(structuredClone(workspace));
    await w.merge(orgId);
    expect(w.db.get(task.pk, task.sk)).toEqual(task);
    expect(w.db.get(workspace.pk, workspace.sk)).toEqual(workspace);
  });
});

describe("rule 1b of resolveSignInDeveloper", () => {
  it("heals the staging shape on the duplicate's next sign-in: it resolves to the email's member, as new-linked", async () => {
    const w = await world();
    const { orgId } = w;
    w.db.set(grant(orgId, D2, "api", "grant-api"));
    w.db.set(grant(orgId, D1, "web", "grant-web"));
    expect(w.db.get(signInIdentityKey(D2))).toBeUndefined();

    expect(await resolveSignInDeveloper(w.deps, { method: "github", identity: githubIdentity })).toEqual({ developerId: D1, identityKey: D2, link: "new-linked" });

    expect(grantsOf(w.db, orgId, D1).map((item) => item.projectName).sort()).toEqual(["api", "web"]);
    expect(memberItems(w.db, orgId)).toHaveLength(1);
    expect(await w.store.getDeveloper(D2)).toMatchObject({ mergedInto: D1 });
    // The login the sign-in carries is kept on the link.
    expect(await w.store.getIdentityLink(D2)).toMatchObject({ developerId: D1, login: "priya-dev", email: EMAIL });
    // The next sign-in is an ordinary linked one.
    expect(await resolveSignInDeveloper(w.deps, { method: "github", identity: githubIdentity })).toEqual({ developerId: D1, identityKey: D2, link: "existing" });
  });

  it("does not merge a duplicate whose org is another org than the email's member's, and says so (I1)", async () => {
    const w = await world();
    const { orgId } = w;
    // The first-sign-in race of Task 2 leaves a person here: D2 owns an org of its own, and the email pointer stayed with D1.
    w.db.delete(orgMemberKey(orgId, D2));
    w.db.delete(developerOrgKey(D2));
    const elsewhere = await w.orgs.createOrgWithOwner({ name: "Priya R.'s team", developerId: D2 });

    expect(await resolveSignInDeveloper(w.deps, { method: "github", identity: githubIdentity })).toEqual({ developerId: D2, identityKey: D2, link: "new-self" });

    expect(w.logs).toContainEqual({ event: "signin.duplicate_other_org", developerId: D2, orgId: elsewhere, otherDeveloperId: D1, otherOrgId: orgId });
    expect(w.db.get(developerOrgKey(D2))).toMatchObject({ orgId: elsewhere });
    expect(w.db.get(developerOrgKey(D1))).toMatchObject({ orgId });
    expect(memberItems(w.db, orgId).map((item) => item.developerId)).toEqual([D1]);
    expect(await w.store.getDeveloper(D2)).not.toHaveProperty("mergedInto");
  });

  it("does not merge for a method that does not link by email, an unverified email, or a duplicate an admin revoked", async () => {
    for (const [method, identity, revoked] of [
      ["oidc", githubIdentity, false],
      ["github", { ...githubIdentity, emailVerified: false }, false],
      ["github", githubIdentity, true],
    ] as const) {
      const w = await world();
      if (revoked) w.db.set({ ...w.db.get(`DEVELOPER#${D2}`, "META")!, revoked: true });
      expect(await resolveSignInDeveloper(w.deps, { method, identity })).toMatchObject({ developerId: D2, link: "new-self" });
      expect(memberItems(w.db, w.orgId)).toHaveLength(2);
    }
  });

  it("does nothing when the email names no one else", async () => {
    const w = await world();
    w.db.delete(orgEmailKey(EMAIL));
    expect(await resolveSignInDeveloper(w.deps, { method: "github", identity: githubIdentity })).toMatchObject({ developerId: D2, link: "new-self" });
    expect(memberItems(w.db, w.orgId)).toHaveLength(2);
    w.db.set({ ...orgEmailKey(EMAIL), entityType: "ORG_EMAIL", developerId: D2, orgId: w.orgId });
    expect((await resolveSignInDeveloper(w.deps, { method: "github", identity: githubIdentity })).developerId).toBe(D2);
  });

  it("is off where the merge is not wired", async () => {
    const w = await world();
    const { store, orgs } = w.deps;
    expect(await resolveSignInDeveloper({ store, orgs }, { method: "github", identity: githubIdentity })).toMatchObject({ developerId: D2, link: "new-self" });
    expect(memberItems(w.db, w.orgId)).toHaveLength(2);
  });
});

describe("the duplicate's real GitHub sign-in", () => {
  const priya: FakeOidcUser = { sub: "priya-cloud-1", name: "Priya Rao", email: EMAIL, email_verified: true };
  const priyaGithub: FakeGithubUser = { id: 4711, login: "priya-dev", name: "Priya R.", emails: [{ email: EMAIL, primary: true, verified: true }] };
  const claimsOf = (accessToken: unknown) => JSON.parse(Buffer.from(String(accessToken).split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;

  it("signs in as the email's member, with one member item left and the duplicate retired", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [priya], github: { users: [priyaGithub] }, sharedTable: true });
    const orgId = await seed(h.db, h.orgs);
    h.db.set(grant(orgId, D2, "api", "grant-api"));
    h.db.set(grant(orgId, D1, "web", "grant-web"));

    const location = await h.signIn("github", "4711");
    const exchanged = await h.exchange(location.searchParams.get("code")!);
    expect(exchanged.status).toBe(200);
    expect(claimsOf(exchanged.body.access_token)).toMatchObject({ sub: D1, org: orgId, amr: "github" });
    expect(memberItems(h.db, orgId).map((item) => item.developerId)).toEqual([D1]);
    expect(grantsOf(h.db, orgId, D1).map((item) => item.ownerKey)).toEqual([D1, D1]);
    expect(h.db.get(`DEVELOPER#${D2}`, "META")).toMatchObject({ mergedInto: D1 });
    expect(h.db.find((item) => item.entityType === "SESSION").map((session) => session.developerId)).toEqual([D1]);
  });
});
