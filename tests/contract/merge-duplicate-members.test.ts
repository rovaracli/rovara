import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
// Plan 2, Task 3: one person who signed in two ways before identity links is two members of the same org. The duplicate's next
// sign-in merges it into the member the verified email names: grants, budget override and role move over, and the duplicate retires.
import { describe, expect, it } from "vitest";
import { developerOrgKey, orgEmailKey, orgMemberKey, orgMetaKey, orgSettingsKey, trialGithubKey, type OrgRole } from "@agentx/cloud-contracts";
import { memberGrantsPk, orgPk, orgProjectCatalogKey, projectMemberKey, type OrgId } from "@rovara-code/contracts";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { CROSS_COMPANY_REASON, resolveSignInDeveloper, type ResolveSignInDeveloperDependencies } from "../../packages/broker/src/developer/identities.js";
import type { ProviderIdentity } from "../../packages/broker/src/developer/providers.js";
import { DeveloperSignInStore, endedByAdmin, endedByUnlink, signInIdentityKey } from "../../packages/broker/src/developer/store.js";
import { duplicateMerger, mergeDuplicateMember } from "../../packages/broker/src/org/merge-members.js";
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
  const mergeDeps = { documentClient: db, tableName: "state", signInStore: store, now: () => clock };
  const merge = (orgId: OrgId, survivorId = D1, duplicateId = D2) => mergeDuplicateMember(mergeDeps, { orgId, survivorId, duplicateId, duplicateIdentityKey: duplicateId });
  const deps: ResolveSignInDeveloperDependencies = { store, orgs, log: (entry) => logs.push(entry), ...duplicateMerger(mergeDeps) };
  const orgId = await seed(db, orgs, options);
  return { db, store, orgs, logs, merge, deps, orgId, mergeDeps, tick: (ms: number) => { clock += ms; } };
}

/** The Task 2 first-sign-in race: D2 lost the email pointer and got an org of its own (trial, one member), where D1 holds the pointer in `orgId`. */
async function raceWorld() {
  const w = await world();
  w.db.delete(orgMemberKey(w.orgId, D2));
  w.db.delete(developerOrgKey(D2));
  const raceOrg = await w.orgs.createOrgWithOwner({ name: "Priya R.'s team", developerId: D2 });
  return { ...w, raceOrg };
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
    expect(budget).toMatchObject({ orgMonthlyUsd: 500, memberOverrides: { [D1]: 50, other: 7 }, updatedBy: "system", revision: 1 });
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
    w.db.injectFault({ command: "TransactWriteCommand", match: input => {
      const items = input.TransactItems as Array<{ Delete?: { Key?: { pk?: string; sk?: string } } }>;
      const key = orgMemberKey(orgId, D2);
      return items.some(item => item.Delete?.Key?.pk === key.pk && item.Delete?.Key?.sk === key.sk);
    }, error: { name: "InternalServerError" } });

    await expect(w.merge(orgId)).rejects.toThrow();
    expect(grantsOf(w.db, orgId, D1).map((item) => item.grantId)).toEqual(["grant-api"]);
    expect(memberItems(w.db, orgId)).toHaveLength(2);

    expect(await w.merge(orgId)).toMatchObject({ role: "member" });
    expect(memberItems(w.db, orgId).map((item) => item.developerId)).toEqual([D1]);
    expect(grantsOf(w.db, orgId, D1).map((item) => item.ownerKey)).toEqual([D1]);
    expect(w.db.get(orgSettingsKey(orgId, "BUDGET"))!.memberOverrides).toEqual({ [D1]: 50 });
    expect(await w.store.getDeveloper(D2)).toMatchObject({ mergedInto: D1 });
  });

  it("ends the duplicate's sessions inside the transaction: no later step can leave them alive", async () => {
    const w = await world();
    const { orgId } = w;
    const session = await w.store.createSession({ developerId: D2, amr: "github", identityKey: D2 });
    w.tick(1000);
    // Any write outside the transaction to the duplicate's record would fail; the merge needs none.
    w.db.injectFault({ command: "UpdateCommand", match: (input) => (input.Key as { pk?: string }).pk === `DEVELOPER#${D2}`, error: { name: "InternalServerError" } });
    const commandsBefore = w.db.commandNames().length;
    await w.merge(orgId);
    expect(w.db.commandNames().slice(commandsBefore)).not.toContain("UpdateCommand");
    expect(endedByAdmin(session.session.startedAt, (await w.store.getDeveloper(D2))?.sessionsEndedAt)).toBe(true);
  });

  it("keeps the duplicate's sessions alive if the transaction fails, and ends them once it commits", async () => {
    const w = await world();
    const session = await w.store.createSession({ developerId: D2, amr: "github", identityKey: D2 });
    w.tick(1000);
    w.db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" } });
    await expect(w.merge(w.orgId)).rejects.toThrow();
    expect(endedByAdmin(session.session.startedAt, (await w.store.getDeveloper(D2))?.sessionsEndedAt)).toBe(false);
    await w.merge(w.orgId);
    expect(endedByAdmin(session.session.startedAt, (await w.store.getDeveloper(D2))?.sessionsEndedAt)).toBe(true);
  });

  it("refuses a survivor an admin revoked or that was merged away, writing nothing", async () => {
    for (const change of [{ revoked: true }, { mergedInto: "d_someone" }]) {
      const w = await world();
      const { orgId } = w;
      w.db.set(grant(orgId, D2, "api", "grant-api"));
      w.db.set({ ...w.db.get(`DEVELOPER#${D1}`, "META")!, ...change });
      const commandsBefore = w.db.commandNames().length;
      const before = snapshot(w.db);
      await expect(w.merge(orgId)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect(w.db.commandNames().slice(commandsBefore).filter((name) => WRITES.has(name))).toEqual([]);
      expect(snapshot(w.db)).toEqual(before);
    }
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

  it("heals a duplicate that already has a link to itself (it signed in after identity links), in the same org", async () => {
    const w = await world();
    const { orgId } = w;
    w.db.set(grant(orgId, D2, "api", "grant-api"));
    await w.store.linkIdentity({ identityKey: D2, developerId: D2, provider: "github", issuer: GITHUB_ISSUER, subject: "4711", login: "priya-dev" });
    expect(await resolveSignInDeveloper(w.deps, { method: "github", identity: githubIdentity })).toEqual({ developerId: D1, identityKey: D2, link: "new-linked" });
    expect(await w.store.getIdentityLink(D2)).toMatchObject({ developerId: D1, login: "priya-dev" });
    expect((await w.store.identitiesOf(D2)).length).toBe(0);
    expect((await w.store.identitiesOf(D1)).map((identity) => identity.provider)).toEqual(["github"]);
    expect(memberItems(w.db, orgId).map((item) => item.developerId)).toEqual([D1]);
    expect(grantsOf(w.db, orgId, D1).map((item) => item.ownerKey)).toEqual([D1]);
    expect(await resolveSignInDeveloper(w.deps, { method: "github", identity: githubIdentity })).toMatchObject({ developerId: D1, link: "existing" });
  });

  it("does not heal an identity the person unlinked", async () => {
    const w = await world();
    w.db.set({ ...signInIdentityKey(D2), entityType: "IDENTITY_LINK", developerId: D2, provider: "github", issuer: GITHUB_ISSUER, subject: "4711", linkedAt: "x", lastSignInAt: "x", unlinkedFrom: D1, unlinkedAt: "y" });
    expect(await resolveSignInDeveloper(w.deps, { method: "github", identity: githubIdentity })).toMatchObject({ developerId: D2, link: "existing" });
    expect(memberItems(w.db, w.orgId)).toHaveLength(2);
  });

  it("unlinking a merged-in identity starts its own developer again: the merged-away record stops saying it went into the survivor", async () => {
    const w = await world();
    w.db.set(grant(w.orgId, D2, "api", "grant-api"));
    await w.store.linkIdentity({ identityKey: D1, developerId: D1, provider: "cloud", issuer: OIDC_ISSUER, subject: "priya-cloud-1" });
    const session = await w.store.createSession({ developerId: D1, amr: "github", identityKey: D2 });
    w.tick(1000);
    expect(await resolveSignInDeveloper(w.deps, { method: "github", identity: githubIdentity })).toEqual({ developerId: D1, identityKey: D2, link: "new-linked" });
    expect(await w.store.getDeveloper(D2)).toMatchObject({ mergedInto: D1 });

    w.tick(1000);
    // The survivor removes it with a fresh cloud sign-in, a method that stays on the account.
    const fresh = await w.store.createSession({ developerId: D1, amr: "cloud", identityKey: D1, authTime: new Date(T0 + 2000).toISOString() });
    expect(await w.store.unlinkIdentity({ developerId: D1, sessionId: fresh.session.sessionId, provider: "github" })).toEqual({ identityKey: D2 });

    // The survivor lost the identity and ends its sessions; the merged-away developer is a plain developer again.
    expect((await w.store.identitiesOf(D1)).map((identity) => identity.provider)).toEqual(["cloud"]);
    expect(endedByUnlink(session.session, (await w.store.getDeveloper(D1))!)).toBe(true);
    const restored = await w.store.getDeveloper(D2);
    expect(restored).toBeDefined();
    expect(restored).not.toHaveProperty("mergedInto");
    expect(restored).not.toHaveProperty("mergedAt");
    expect(restored?.sessionsEndedAt).toBeDefined();
    expect(await w.store.getIdentityLink(D2)).toMatchObject({ developerId: D1, unlinkedFrom: D1 });

    // Its next sign-in is its own developer's, never merged back, and the record is a valid survivor/duplicate again.
    w.tick(1000);
    expect(await resolveSignInDeveloper(w.deps, { method: "github", identity: githubIdentity })).toEqual({ developerId: D2, identityKey: D2, link: "new-self", separatedFrom: D1 });
    expect(await w.store.identitiesOf(D1)).toHaveLength(1);
    expect(await w.store.getDeveloper(D2)).not.toHaveProperty("mergedInto");
  });

  // IDENTITY-HEALING-CROSS-ORG (0.5.15): healing only ever acts within one company. Even the old "disposable race org" is a company
  // that may legitimately be the person's second one (programme T), so it is never merged into another company or closed.
  it("never merges across companies, even a lone trial org with nothing in it: no merge, no org closed, a log line (with or without self-links)", async () => {
    for (const selfLinked of [false, true]) {
      const w = await raceWorld();
      if (selfLinked) {
        await w.store.linkIdentity({ identityKey: D1, developerId: D1, provider: "cloud", issuer: OIDC_ISSUER, subject: "priya-cloud-1" });
        await w.store.linkIdentity({ identityKey: D2, developerId: D2, provider: "github", issuer: GITHUB_ISSUER, subject: "4711", login: "priya-dev" });
      }
      const session = await w.store.createSession({ developerId: D2, amr: "github", identityKey: D2 });
      const before = snapshot(w.db).filter(([key]) => !key.includes("IDENTITY#"));
      w.tick(1000);

      expect(await resolveSignInDeveloper(w.deps, { method: "github", identity: githubIdentity })).toMatchObject({ developerId: D2, identityKey: D2 });

      expect(w.db.get(developerOrgKey(D2))).toMatchObject({ orgId: w.raceOrg });
      expect(w.db.get(orgMemberKey(w.raceOrg, D2))).toBeDefined();
      expect(w.db.get(orgMetaKey(w.raceOrg))).not.toHaveProperty("closedAt");
      expect(w.db.get(orgMetaKey(w.raceOrg))).not.toHaveProperty("mergedIntoOrg");
      expect(memberItems(w.db, w.orgId).map((item) => item.developerId)).toEqual([D1]);
      expect(await w.store.getDeveloper(D2)).not.toHaveProperty("mergedInto");
      expect(endedByAdmin(session.session.startedAt, (await w.store.getDeveloper(D2))?.sessionsEndedAt)).toBe(false);
      expect(w.db.find((item) => item.entityType === "MEMBER_MERGE")).toEqual([]);
      // Nothing in either company changed: only the sign-in's own identity link may have been touched.
      expect(snapshot(w.db).filter(([key]) => !key.includes("IDENTITY#"))).toEqual(before);
      expect(w.logs).toEqual([{ event: "signin.duplicate_other_org", developerId: D2, orgId: w.raceOrg, otherDeveloperId: D1, otherOrgId: w.orgId, reason: CROSS_COMPANY_REASON }]);
    }
  });

  it("leaves a GitHub-unlocked trial where it is when the person is in two companies", async () => {
    const w = await raceWorld();
    w.db.set({ ...w.db.get(orgMetaKey(w.raceOrg))!, trialUnlockedAt: T0 - 5000, trialGithubUserId: "4711" });
    w.db.set({ ...trialGithubKey("4711"), entityType: "TRIAL_GITHUB", orgId: w.raceOrg, claimedAt: T0 - 5000 });
    await resolveSignInDeveloper(w.deps, { method: "github", identity: githubIdentity });
    expect(w.db.get(trialGithubKey("4711"))).toMatchObject({ orgId: w.raceOrg });
    expect(w.db.get(orgMetaKey(w.orgId))).not.toHaveProperty("trialUnlockedAt");
    expect(w.db.get(orgMetaKey(w.raceOrg))).not.toHaveProperty("closedAt");
  });

  it("never merges across companies whatever the other company holds: projects, grants, other members, budgets", async () => {
    const cases: Array<[string, (w: Awaited<ReturnType<typeof raceWorld>>) => void]> = [
      ["projects", (w) => w.db.set({ ...orgProjectCatalogKey(w.raceOrg, "api"), entityType: "PROJECT_CATALOG" })],
      ["project grants", (w) => w.db.set(grant(w.raceOrg, D2, "api", "g"))],
      ["other members", (w) => w.db.set({ ...orgMemberKey(w.raceOrg, "d_other"), entityType: "ORG_MEMBER", orgId: w.raceOrg, developerId: "d_other", role: "member" })],
      ["budgets", (w) => w.db.set({ ...orgSettingsKey(w.raceOrg, "BUDGET"), entityType: "ORG_BUDGET", memberOverrides: {} })],
    ];
    for (const [label, change] of cases) {
      const w = await raceWorld();
      change(w);
      expect(await resolveSignInDeveloper(w.deps, { method: "github", identity: githubIdentity }), label).toMatchObject({ developerId: D2, link: "new-self" });
      expect(w.logs, label).toContainEqual(expect.objectContaining({ event: "signin.duplicate_other_org", reason: CROSS_COMPANY_REASON }));
      expect(w.db.get(developerOrgKey(D2)), label).toMatchObject({ orgId: w.raceOrg });
      expect(w.db.get(orgMetaKey(w.raceOrg)), label).not.toHaveProperty("closedAt");
      expect(await w.store.getDeveloper(D2), label).not.toHaveProperty("mergedInto");
    }
  });

  it("mergeDuplicateMember refuses a duplicate whose membership is in another company, writing nothing (also when a stale caller names its org)", async () => {
    const w = await raceWorld();
    for (const extra of [{}, { duplicateOrgId: w.raceOrg }]) {
      const commandsBefore = w.db.commandNames().length;
      const before = snapshot(w.db);
      await expect(mergeDuplicateMember(w.mergeDeps, { orgId: w.orgId, survivorId: D1, duplicateId: D2, duplicateIdentityKey: D2, ...extra })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect(w.db.commandNames().slice(commandsBefore).filter((name) => WRITES.has(name))).toEqual([]);
      expect(snapshot(w.db)).toEqual(before);
    }
  });

  it("healing the person's duplicate in company A leaves their membership and records in company B as they were", async () => {
    const w = await world();
    // The same person (same verified email) also holds company B through a third sign-in route, with a grant and a monthly limit there.
    const D3 = ownerKeyForSubject(OIDC_ISSUER, "priya-cloud-b");
    w.db.set(developerRecord(D3, "cloud", OIDC_ISSUER, "priya-cloud-b"));
    const orgB = await w.orgs.createOrgWithOwner({ name: "Priya's other company", developerId: D3 });
    w.db.set(grant(orgB, D3, "billing", "grant-b"));
    w.db.set({ ...orgSettingsKey(orgB, "BUDGET"), entityType: "ORG_BUDGET", memberOverrides: { [D3]: 40 }, revision: 1 });
    w.db.set(grant(w.orgId, D2, "api", "grant-api"));
    const companyB = () => snapshot(w.db).filter(([, item]) => JSON.stringify(item).includes(orgB) || JSON.stringify(item).includes(D3));
    const before = companyB();

    // D2's sign-in heals within company A.
    expect(await resolveSignInDeveloper(w.deps, { method: "github", identity: githubIdentity })).toMatchObject({ developerId: D1, link: "new-linked" });
    expect(memberItems(w.db, w.orgId).map((item) => item.developerId)).toEqual([D1]);
    expect(companyB()).toEqual(before);

    // D3's own sign-in (its email names D1, in company A) is not healed into A, and company B stays open with D3 in it.
    w.logs.length = 0;
    expect(await resolveSignInDeveloper(w.deps, { method: "cloud", identity: { method: "cloud", issuer: OIDC_ISSUER, subject: "priya-cloud-b", displayName: "Priya", email: EMAIL, emailVerified: true } })).toMatchObject({ developerId: D3 });
    expect(w.db.get(developerOrgKey(D3))).toMatchObject({ orgId: orgB });
    expect(w.db.get(orgMetaKey(orgB))).not.toHaveProperty("closedAt");
    expect(await w.store.getDeveloper(D3)).not.toHaveProperty("mergedInto");
    expect(companyB().filter(([key]) => !key.includes("IDENTITY#"))).toEqual(before.filter(([key]) => !key.includes("IDENTITY#")));
    expect(w.logs).toEqual([{ event: "signin.duplicate_other_org", developerId: D3, orgId: orgB, otherDeveloperId: D1, otherOrgId: w.orgId, reason: CROSS_COMPANY_REASON }]);
  });

  it("still refuses merge loops: a survivor merged back into the duplicate is never merged into", async () => {
    const w = await world();
    w.db.set({ ...w.db.get(`DEVELOPER#${D1}`, "META")!, mergedInto: D2 });
    expect(await resolveSignInDeveloper(w.deps, { method: "github", identity: githubIdentity })).toMatchObject({ developerId: D2 });
    expect(memberItems(w.db, w.orgId)).toHaveLength(2);
    expect(await w.store.getDeveloper(D2)).not.toHaveProperty("mergedInto");
    await expect(w.merge(w.orgId)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(w.merge(w.orgId, D1, D1)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("does not merge into a survivor an admin revoked or that was merged away; the sign-in goes on as itself", async () => {
    for (const change of [{ revoked: true }, { mergedInto: "d_someone" }]) {
      const w = await world();
      w.db.set({ ...w.db.get(`DEVELOPER#${D1}`, "META")!, ...change });
      expect(await resolveSignInDeveloper(w.deps, { method: "github", identity: githubIdentity })).toMatchObject({ developerId: D2 });
      expect(memberItems(w.db, w.orgId)).toHaveLength(2);
    }
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

  it("a person in two companies signs in with GitHub into the GitHub route's own company; neither company is closed", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [priya], github: { users: [priyaGithub] }, sharedTable: true });
    const orgId = await seed(h.db, h.orgs);
    h.db.delete(orgMemberKey(orgId, D2));
    h.db.delete(developerOrgKey(D2));
    const otherOrg = await h.orgs.createOrgWithOwner({ name: "Priya R.'s team", developerId: D2 });

    const location = await h.signIn("github", "4711");
    const exchanged = await h.exchange(location.searchParams.get("code")!);
    expect(exchanged.status).toBe(200);
    expect(claimsOf(exchanged.body.access_token)).toMatchObject({ sub: D2, org: otherOrg, amr: "github" });
    expect(memberItems(h.db, orgId).map((item) => item.developerId)).toEqual([D1]);
    expect(h.db.get(orgMetaKey(otherOrg))).not.toHaveProperty("closedAt");
    expect(h.db.get(orgMetaKey(orgId))).not.toHaveProperty("closedAt");
    expect(h.db.get(developerOrgKey(D2))).toMatchObject({ orgId: otherOrg });
    expect(h.db.get(`DEVELOPER#${D2}`, "META")).not.toHaveProperty("mergedInto");
  });
});

describe("B33 identity merge approval invalidation", () => {
  it("invalidates the survivor company's approval generation when duplicate membership retires", async () => {
    const w = await world();
    const before = w.db.get(orgMetaKey(w.orgId))?.approvalMembershipVersion;
    await w.merge(w.orgId);
    expect(w.db.get(orgMetaKey(w.orgId))?.approvalMembershipVersion).toBe(Number(before) + 1);
  });

  it("fences maintainer grant movement before the duplicate identity is retired", async () => {
    const w = await world();
    w.db.set({ ...grant(w.orgId, D2, "api", "grant-api"), projectRole: "maintainer" });
    w.db.set({ pk: `ORG#${w.orgId}#PROJECT#api`, sk: "META", entityType: "PROJECT_META", status: "active" });
    const before = w.db.get(orgMetaKey(w.orgId))?.approvalMembershipVersion;
    await w.merge(w.orgId);
    expect(w.db.get(orgMetaKey(w.orgId))?.approvalMembershipVersion).toBeGreaterThan(Number(before) + 1);
    expect(w.db.get({ pk: `ORG#${w.orgId}#PROJECT#api`, sk: "META" })?.approvalLastMaintainerLossAt).toBe(new Date(T0).toISOString());
    expect(grantsOf(w.db, w.orgId, D2)).toEqual([]);
  });
});


it("B33 never copies a stale maintainer grant after its source was demoted", async () => {
 const w = await world();
 const source = { ...grant(w.orgId, D2, "api", "grant-api"), projectRole: "maintainer" };
 w.db.set(source);
 const send = w.db.send.bind(w.db);let race = true;
 w.db.send = async command => {
  if (race && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.ownerKey === D1 && item.Put?.Item?.projectName === "api")) {
   race = false;w.db.set({ ...source, projectRole: "contributor" });
  }
  return send(command);
 };
 await expect(w.merge(w.orgId)).rejects.toThrow();
 expect(grantsOf(w.db, w.orgId, D1)).toEqual([]);
 expect(w.db.get(projectMemberKey(w.orgId, D2, "api"))?.projectRole).toBe("contributor");
});
