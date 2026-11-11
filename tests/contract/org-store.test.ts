import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { projectMetaKey, projectMemberKey } from "@rovara-code/contracts";
import { orgMemberKey } from "@agentx/cloud-contracts";
import { describe, expect, it } from "vitest";
import type { OrgId } from "@rovara-code/contracts";
import { orgInviteKey, orgMetaKey, slackTeamOrgKey } from "../../packages/cloud-contracts/src/org-node.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { inviteTokenHash } from "../../packages/broker/src/org/invite-url.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const START = Date.parse("2026-10-18T12:00:00.000Z");
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;

function setup() {
  const db = new FakeDynamoDb();
  const clock = { now: START };
  let counter = 0;
  const store = new OrgStore({
    documentClient: db,
    tableName: "T",
    now: () => clock.now,
    newOrgId: () => `org_${String(++counter).padStart(20, "0")}`,
  });
  const metas = () => db.find((item) => item.entityType === "ORG" && item.sk === "META" && typeof item.pk === "string" && item.pk.startsWith("ORG#"));
  return { db, clock, store, metas };
}

describe("OrgStore org creation", () => {
  it("makes the creator the owner", async () => {
    const { store } = setup();
    const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "dev-1" });
    expect(await store.orgForDeveloper("dev-1")).toEqual({ orgId, role: "owner" });
    expect(await store.getOrg(orgId)).toEqual({
      orgId, name: "Acme", createdAt: "2026-10-18T12:00:00.000Z", createdBy: "dev-1", plan: "trial",
    });
  });

  it("returns undefined for an unknown developer or org", async () => {
    const { store } = setup();
    expect(await store.orgForDeveloper("nobody")).toBeUndefined();
    expect(await store.getOrg(ORG_A)).toBeUndefined();
  });

  it("refuses a second org for the same developer and leaves no second META item", async () => {
    const { store, metas } = setup();
    await store.createOrgWithOwner({ name: "Acme", developerId: "dev-1" });
    await expect(store.createOrgWithOwner({ name: "Other", developerId: "dev-1" })).rejects.toMatchObject({ code: "ALREADY_IN_ORG" });
    expect(metas()).toHaveLength(1);
  });

  it("indexes the verified email when one is given", async () => {
    const { store } = setup();
    await store.createOrgWithOwner({ name: "Acme", developerId: "dev-1", email: "Dev@Example.com" });
    expect(await store.developerForVerifiedEmail("dev@example.com")).toBe("dev-1");
    expect(await store.developerForVerifiedEmail("other@example.com")).toBeUndefined();
  });

  it("ensureOrg is idempotent and keeps exactly one META item", async () => {
    const { store, db, metas } = setup();
    await store.ensureOrg(ORG_A, "staging");
    await expect(store.ensureOrg(ORG_A, "renamed")).resolves.toBeUndefined();
    expect(metas()).toHaveLength(1);
    expect(await store.getOrg(ORG_A)).toEqual({
      orgId: ORG_A, name: "staging", createdAt: "2026-10-18T12:00:00.000Z", createdBy: "system", plan: "team",
    });
    expect(db.get(orgMetaKey(ORG_A).pk, "META")).toBeDefined();
  });
});

describe("OrgStore membership and invites", () => {
  it("addMember adds a member and refuses a developer who already has an org", async () => {
    const { store } = setup();
    await store.addMember({ orgId: ORG_A, developerId: "dev-2", role: "admin" });
    expect(await store.orgForDeveloper("dev-2")).toEqual({ orgId: ORG_A, role: "admin" });
    await expect(store.addMember({ orgId: ORG_B, developerId: "dev-2", role: "member" })).rejects.toMatchObject({ code: "ALREADY_IN_ORG" });
    expect(await store.orgForDeveloper("dev-2")).toEqual({ orgId: ORG_A, role: "admin" });
  });

  it("acceptInvite returns the invite's role, makes the developer a member and burns the token", async () => {
    const { store } = setup();
    const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "owner" });
    const { token } = await store.createInvite({ orgId, createdBy: "owner", role: "admin" });
    expect(await store.acceptInvite({ tokenHash: inviteTokenHash(token), developerId: "dev-2", email: "dev2@example.com" })).toEqual({ orgId, role: "admin" });
    expect(await store.orgForDeveloper("dev-2")).toEqual({ orgId, role: "admin" });
    expect(await store.developerForVerifiedEmail("dev2@example.com")).toBe("dev-2");
    await expect(store.acceptInvite({ tokenHash: inviteTokenHash(token), developerId: "dev-3" })).rejects.toMatchObject({ code: "INVITE_INVALID" });
    expect(await store.orgForDeveloper("dev-3")).toBeUndefined();
  });

  it("rejects an unknown token", async () => {
    const { store } = setup();
    await expect(store.acceptInvite({ tokenHash: inviteTokenHash("nope"), developerId: "dev-2" })).rejects.toMatchObject({ code: "INVITE_INVALID" });
  });

  it("rejects an invite after seven days", async () => {
    const { store, clock } = setup();
    const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "owner" });
    const { token } = await store.createInvite({ orgId, createdBy: "owner", role: "member" });
    clock.now = START + WEEK_MS + 1000;
    await expect(store.acceptInvite({ tokenHash: inviteTokenHash(token), developerId: "dev-2" })).rejects.toMatchObject({ code: "INVITE_INVALID" });
    expect(await store.orgForDeveloper("dev-2")).toBeUndefined();
  });

  it("accepts an invite just inside its lifetime and honours ttlSeconds", async () => {
    const { store, clock } = setup();
    const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "owner" });
    const week = await store.createInvite({ orgId, createdBy: "owner", role: "member" });
    const short = await store.createInvite({ orgId, createdBy: "owner", role: "member", ttlSeconds: 60 });
    clock.now = START + 61_000;
    await expect(store.acceptInvite({ tokenHash: inviteTokenHash(short.token), developerId: "dev-3" })).rejects.toMatchObject({ code: "INVITE_INVALID" });
    clock.now = START + WEEK_MS - 1000;
    expect(await store.acceptInvite({ tokenHash: inviteTokenHash(week.token), developerId: "dev-2" })).toEqual({ orgId, role: "member" });
  });

  it("refuses a developer who already has an org and leaves the invite unaccepted", async () => {
    const { store, db } = setup();
    const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "owner" });
    await store.createOrgWithOwner({ name: "Mine", developerId: "dev-2" });
    const { token } = await store.createInvite({ orgId, createdBy: "owner", role: "member" });
    await expect(store.acceptInvite({ tokenHash: inviteTokenHash(token), developerId: "dev-2" })).rejects.toMatchObject({ code: "ALREADY_IN_ORG" });
    const invites = db.find((item) => typeof item.pk === "string" && item.pk.startsWith("ORG_INVITE#"));
    expect(invites).toHaveLength(1);
    expect(invites[0]).not.toHaveProperty("acceptedAt");
    expect(invites[0]).not.toHaveProperty("acceptedBy");
    // The invite is still usable by someone else.
    expect(await store.acceptInvite({ tokenHash: inviteTokenHash(token), developerId: "dev-3" })).toEqual({ orgId, role: "member" });
  });

  it("stores only a hash of the token, never the token", async () => {
    const { store, db } = setup();
    const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "owner" });
    const { token } = await store.createInvite({ orgId, createdBy: "owner", role: "member", email: "Dev2@Example.com" });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const invites = db.find((item) => typeof item.pk === "string" && item.pk.startsWith("ORG_INVITE#"));
    expect(invites).toHaveLength(1);
    const invite = invites[0]!;
    expect(Object.values(invite)).not.toContain(token);
    expect(JSON.stringify(db.items)).not.toContain(token);
    expect(invite).toMatchObject({ orgId, createdBy: "owner", role: "member", email: "dev2@example.com" });
    expect(invite.pk).toBe(orgInviteKey(invite.tokenHash as string).pk);
  });

  it("gives each invite a distinct token", async () => {
    const { store } = setup();
    const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "owner" });
    const a = await store.createInvite({ orgId, createdBy: "owner", role: "member" });
    const b = await store.createInvite({ orgId, createdBy: "owner", role: "member" });
    expect(a.token).not.toBe(b.token);
  });
});

describe("OrgStore Slack team binding", () => {
  it("binds a team once and refuses a different org", async () => {
    const { store, db } = setup();
    await store.bindSlackTeam({ orgId: ORG_A, teamId: "T1" });
    await expect(store.bindSlackTeam({ orgId: ORG_B, teamId: "T1" })).rejects.toMatchObject({ code: "SLACK_TEAM_TAKEN" });
    expect(await store.orgForSlackTeam("T1")).toBe(ORG_A);
    expect(db.get(slackTeamOrgKey("T1").pk, "ORG")).toBeDefined();
  });

  it("allows binding the same team to the same org again", async () => {
    const { store } = setup();
    await store.bindSlackTeam({ orgId: ORG_A, teamId: "T1" });
    await expect(store.bindSlackTeam({ orgId: ORG_A, teamId: "T1" })).resolves.toBeUndefined();
    expect(await store.orgForSlackTeam("T1")).toBe(ORG_A);
  });

  it("returns undefined for an unbound team", async () => {
    const { store } = setup();
    expect(await store.orgForSlackTeam("T9")).toBeUndefined();
  });
});


describe("B33 approval membership generation", () => {
  it("changes generation atomically on sign-in join and invite acceptance", async () => {
    const { store, db } = setup();
    const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "owner" });
    const version = () => db.get(orgMetaKey(orgId).pk, "META")?.approvalMembershipVersion;
    const initial = version();
    expect(initial).toBeTypeOf("number");
    await store.addMember({ orgId, developerId: "member", role: "member" });
    expect(version()).toBe(Number(initial) + 1);
    const { token } = await store.createInvite({ orgId, createdBy: "owner", role: "admin" });
    const beforeInvite = version();
    await store.acceptInvite({ tokenHash: inviteTokenHash(token), developerId: "admin" });
    expect(version()).toBe(Number(beforeInvite) + 1);
  });

  it("records eligible-role loss and moves generation on demotion", async () => {
    const { store, db, clock } = setup();
    const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "owner" });
    await store.addMember({ orgId, developerId: "admin", role: "admin" });
    const before = db.get(orgMetaKey(orgId).pk, "META")?.approvalMembershipVersion;
    clock.now += 1_000;
    await store.setRole({ orgId, developerId: "admin", role: "member" });
    const meta = db.get(orgMetaKey(orgId).pk, "META");
    expect(meta?.approvalMembershipVersion).toBe(Number(before) + 1);
    expect(meta?.approvalLastCompanyEligibleLossAt).toBe(new Date(clock.now).toISOString());
  });

  it("records removal before the person can use the sole-owner exception", async () => {
    const { store, db, clock } = setup();
    const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "owner" });
    await store.addMember({ orgId, developerId: "admin", role: "admin" });
    const before = db.get(orgMetaKey(orgId).pk, "META")?.approvalMembershipVersion;
    clock.now += 1_000;
    await store.removeMember({ orgId, developerId: "admin", emails: [], ban: false });
    const meta = db.get(orgMetaKey(orgId).pk, "META");
    expect(meta?.approvalMembershipVersion).toBe(Number(before) + 1);
    expect(meta?.approvalLastCompanyEligibleLossAt).toBe(new Date(clock.now).toISOString());
  });
});


describe("B33 membership removal grant-loss boundary", () => {
  const withGrant = async () => {
    const { store, db, clock } = setup();
    const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "owner" });
    await store.addMember({ orgId, developerId: "member", role: "member" });
    const grantKey = projectMemberKey(orgId, "member", "payments");
    db.set({ ...projectMetaKey(orgId, "payments"), entityType: "PROJECT_META", status: "active" });
    db.set({ ...grantKey, entityType: "MEMBERSHIP", role: "developer", projectRole: "maintainer", grantId: "grant1", projectName: "payments" });
    return { store, db, clock, orgId, grantKey };
  };

  it("deletes nothing when the removal stops before its transaction: the grants stay (G2) and no loss is recorded", async () => {
    const { store, db, clock, orgId, grantKey } = await withGrant();
    const before = db.get(orgMetaKey(orgId))?.approvalMembershipVersion;
    clock.now += 1_000;
    const send = db.send.bind(db);
    db.send = async command => {
      if (command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Delete?.Key?.pk === orgMemberKey(orgId, "member").pk && item.Delete?.Key?.sk === orgMemberKey(orgId, "member").sk)) throw new Error("stopped before final membership removal");
      return send(command);
    };
    await expect(store.removeMember({ orgId, developerId: "member", emails: [], ban: false })).rejects.toThrow("stopped");
    expect(db.get(grantKey)).toBeDefined();
    expect(db.get(orgMemberKey(orgId, "member"))).toBeDefined();
    expect(db.get(orgMetaKey(orgId))?.approvalMembershipVersion).toBe(before);
    expect(db.get(projectMetaKey(orgId, "payments"))?.approvalLastMaintainerLossAt).toBeUndefined();
  });

  it("bumps the generation with the membership and again, with the scoped maintainer loss, when the access step deletes the recorded grant", async () => {
    const { store, db, clock, orgId, grantKey } = await withGrant();
    const before = Number(db.get(orgMetaKey(orgId))?.approvalMembershipVersion);
    clock.now += 1_000;
    await store.removeMember({ orgId, developerId: "member", emails: [], ban: false });
    expect(db.get(grantKey)).toBeUndefined();
    expect(db.get(orgMetaKey(orgId))?.approvalMembershipVersion).toBe(before + 2);
    expect(db.get(projectMetaKey(orgId, "payments"))?.approvalLastMaintainerLossAt).toBe(new Date(clock.now).toISOString());
  });
});

it("never shortens company approver-loss cool-off under an older writer clock", async () => {
  const { store, db, clock } = setup();
  const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "owner" });
  await store.addMember({ orgId, developerId: "admin", role: "admin" });
  await store.setRole({ orgId, developerId: "admin", role: "member" });
  const loss = db.get(orgMetaKey(orgId))?.approvalLastCompanyEligibleLossAt;
  await store.setRole({ orgId, developerId: "admin", role: "admin" });
  clock.now -= 60_000;
  await store.setRole({ orgId, developerId: "admin", role: "member" });
  expect(Date.parse(String(db.get(orgMetaKey(orgId))?.approvalLastCompanyEligibleLossAt))).toBeGreaterThanOrEqual(Date.parse(String(loss)));
});

it("classifies a closing-company generation refusal as stale rather than last-owner", async () => {
 const { store, db } = setup();
 const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "owner" });
 await store.addMember({ orgId, developerId: "admin", role: "admin" });
 db.set({ ...db.get(orgMetaKey(orgId)), closingAt: "2026-10-29T21:00:00Z" });
 await expect(store.setRole({ orgId, developerId: "admin", role: "member" })).rejects.toMatchObject({ code: "CHANGE_STALE" });
 expect((await store.listMembers(orgId)).find(member => member.developerId === "admin")?.role).toBe("admin");
});

it("reports a closing-company join as stale without creating a membership", async () => {
 const { store, db } = setup();
 const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "owner" });
 db.set({ ...db.get(orgMetaKey(orgId)), closingAt: "2026-10-29T21:00:00Z" });
 await expect(store.addMember({ orgId, developerId: "new", role: "member" })).rejects.toMatchObject({ code: "CHANGE_STALE" });
 expect(await store.orgForDeveloper("new")).toBeUndefined();
});

it("refuses invite acceptance when company META disappeared without creating a stub", async () => {
 const { store, db } = setup();const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "owner" });
 const { token } = await store.createInvite({ orgId, createdBy: "owner", role: "admin" });db.delete(orgMetaKey(orgId));
 await expect(store.acceptInvite({ tokenHash: inviteTokenHash(token), developerId: "new-person" })).rejects.toMatchObject({ code: "INVITE_INVALID" });
 expect(db.get(orgMetaKey(orgId))).toBeUndefined();expect(await store.orgForDeveloper("new-person")).toBeUndefined();
 expect(db.get(orgInviteKey(inviteTokenHash(token)))?.acceptedAt).toBeUndefined();
});
