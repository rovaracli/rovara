// Plan 2, Task 4: org members. Listing, roles, removal and leaving, and what a removal stops (ruling R60): a removed person's token,
// their grants and email pointer, their running tasks at the next dispatch or publication, and the ban a private install puts on them.
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  developerOrgKey, githubInstallationKey, orgBanKey, orgEmailKey, orgGithubInstallationKey, orgMemberKey, orgMetaKey, orgRemovedKey, orgSettingsKey, orgSlackTeamKey,
  slackTeamOrgKey, trialGithubKey, type OrgRole,
} from "@agentx/contracts";
import { createCandidateManifest } from "../../packages/contracts/src/task-workflow-node.js";
import { projectMemberKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { routeDeveloperTaskRequest, startTaskWorkflowPublicationFromSystem, startTaskWorkflowReviewFromSystem } from "../../packages/broker/src/aws/developer-tasks.js";
import { requireCreatorStillMember, requireWorkspaceCreatorStillMember } from "../../packages/broker/src/developer/creator-member.js";
import { developerTaskIdentity, type DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { resolveOrgOnSignIn } from "../../packages/broker/src/org/sign-in.js";
import { inviteTokenHash } from "../../packages/broker/src/org/invite-url.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import type { createDeveloperTaskBroker} from "../support/developer-task-broker.js";
import { MAYA, OMAR, createSingleAnswerPlanBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { OIDC_ISSUER, identityHarness, type FakeOidcUser } from "../support/developer-fakes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { readSplitSource } from "../support/split-source.js";
import { finishPlanningWithMarkdown } from "../support/plan-documents.js";
import { TEST_ENV, TEST_ORG } from "../support/orgs.js";
import { readBrokerSource } from "../support/broker-source.js";

type Harness = Awaited<ReturnType<typeof createDeveloperTaskBroker>>;
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const REQUIRED_CHECK = { id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } };
const passingChecks = () => ({ status: "verified", source: "project", preambleVersion: "1", preambleSha256: "c".repeat(64), checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 12 }], extraTry: "not_needed", agentClaim: "success" });
const operations = (harness: Harness, workspaceId: string) => harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
const REMOVED_REASON = (name: string) => `${name} is no longer a member of ${TEST_ENV}, so Rovara stopped this task.`;
const errorOf = (answer: { body: Record<string, unknown> }) => answer.body.error as { code: string; message: string } | undefined;

/** The broker with Omar an owner and Maya a member of the install's org; sessions end through a spy. */
async function org(options: Parameters<typeof createDeveloperTaskBroker>[0] = {}) {
  const endDeveloperSessions = vi.fn(async () => ({ ok: true as const }));
  const harness = await createSingleAnswerPlanBroker({ ...options, developerExtra: { endDeveloperSessions, ...options.developerExtra } });
  seedMembership(harness.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
  const remove = (by: Developer, who: Developer) => harness.dev(by, "DELETE", `/v1/app/org/members/${who.developerId}`);
  return { ...harness, endDeveloperSessions, remove };
}

/** Another person in the install's org: a session, a sign-in record with an email, the membership and the email pointer. */
function person(harness: Harness, name: string, role: OrgRole, email = `${name.toLowerCase()}@example.com`): Developer {
  const developerId = createHash("sha256").update(name).digest("hex");
  const who: Developer = { developerId, name, provider: "oidc", sessionId: `s-${name}` };
  harness.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId, amr: "oidc", startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
  harness.db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, provider: "oidc", displayName: name, email, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  seedMembership(harness.db, developerId, { orgId: TEST_ORG, role });
  harness.db.set({ ...orgEmailKey(email), entityType: "ORG_EMAIL", developerId, orgId: TEST_ORG, createdAt: "x" });
  return who;
}

const roleOf = (harness: Harness, who: Developer) => (harness.db.get(orgMemberKey(TEST_ORG, who.developerId)) as { role?: string } | undefined)?.role;

describe("GET /v1/app/org/members", () => {
  it("lists every member for any member, by name and role; an owner or admin also sees emails, join dates and sign-in methods (a linked person lists cloud and github)", async () => {
    const harness = await org();
    const { dev, db } = harness;
    const bea = person(harness, "Bea", "admin", "bea@example.com");
    const link = (provider: string, key: string, linkedAt: string) => db.set({
      pk: `DEVELOPER#${bea.developerId}`, sk: `IDENTITY#${key}`, developerId: bea.developerId, provider, issuer: `https://${provider}.example`, subject: key, email: "bea@example.com", linkedAt, lastSignInAt: linkedAt,
    });
    link("cloud", "k1", "2026-10-01T00:00:00.000Z");
    link("github", "k2", "2026-10-02T00:00:00.000Z");

    // Release 0.4.16 (owner decision "option A"): a plain member is shown names and roles, nothing more.
    const listed = await dev(MAYA, "GET", "/v1/app/org/members");
    expect(listed.status).toBe(200);
    const seenByMember = listed.body.members as Array<Record<string, unknown>>;
    expect(seenByMember.map((member) => member.name).sort()).toEqual(["Bea", "Maya Chen", "Omar Diaz"]);
    expect(seenByMember.find((member) => member.name === "Bea")).toEqual({ developerId: bea.developerId, name: "Bea", role: "admin" });
    expect(JSON.stringify(seenByMember)).not.toMatch(/@|joinedAt|identities/);

    const forOwner = await dev(OMAR, "GET", "/v1/app/org/members");
    expect(forOwner.status).toBe(200);
    const members = forOwner.body.members as Array<Record<string, unknown>>;
    expect(members.map((member) => member.name).sort()).toEqual(["Bea", "Maya Chen", "Omar Diaz"]);
    expect(members.find((member) => member.name === "Bea")).toMatchObject({ developerId: bea.developerId, email: "bea@example.com", role: "admin", identities: ["cloud", "github"] });
    expect(members.find((member) => member.developerId === OMAR.developerId)).toMatchObject({ name: "Omar Diaz", role: "owner", identities: ["oidc"] });
    expect(members.every((member) => typeof member.joinedAt === "string")).toBe(true);
    expect(JSON.stringify(members)).not.toMatch(/issuer|subject|https:\/\/github\.example/);
  });

  it("is also served at GET /v1/app/org and POST /v1/app/org/invites, as the /v1/dev/org routes", async () => {
    const { dev } = await org();
    expect((await dev(OMAR, "GET", "/v1/app/org")).body).toMatchObject({ org: { orgId: TEST_ORG }, role: "owner" });
    const invite = await dev(OMAR, "POST", "/v1/app/org/invites", { requestId: randomUUID(), role: "member" });
    expect(invite.status).toBe(200);
    expect(String(invite.body.inviteUrl)).toMatch(/\/join\?invite=/);
  });
});

describe("PUT /v1/app/org/members/{developerId}/role", () => {
  it("lets an owner change a role, in the member record and the developer pointer together", async () => {
    const { dev, db } = await org();
    const changed = await dev(OMAR, "PUT", `/v1/app/org/members/${MAYA.developerId}/role`, { requestId: randomUUID(), role: "admin" });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ developerId: MAYA.developerId, role: "admin" });
    expect(db.get(orgMemberKey(TEST_ORG, MAYA.developerId))).toMatchObject({ role: "admin" });
    expect(db.get(developerOrgKey(MAYA.developerId))).toMatchObject({ role: "admin", orgId: TEST_ORG });
  });

  it("refuses anyone but an owner with 403 FORBIDDEN, and a person who is not a member with 404", async () => {
    const harness = await org();
    const carl = person(harness, "Carl", "admin");
    const refused = await harness.dev(carl, "PUT", `/v1/app/org/members/${MAYA.developerId}/role`, { requestId: randomUUID(), role: "owner" });
    expect(refused.status).toBe(403);
    expect(errorOf(refused)).toMatchObject({ code: "FORBIDDEN" });
    expect(roleOf(harness, MAYA)).toBe("member");
    const unknown = await harness.dev(OMAR, "PUT", `/v1/app/org/members/${"f".repeat(64)}/role`, { requestId: randomUUID(), role: "admin" });
    expect(unknown.status).toBe(404);
    expect((await harness.dev(OMAR, "PUT", `/v1/app/org/members/${MAYA.developerId}/role`, { role: "admin" })).status).toBe(400);
  });

  it("refuses the only owner demoting themselves with 409 LAST_OWNER, and lets one of two owners step down", async () => {
    const harness = await org();
    const demote = () => harness.dev(OMAR, "PUT", `/v1/app/org/members/${OMAR.developerId}/role`, { requestId: randomUUID(), role: "member" });
    const refused = await demote();
    expect(refused.status).toBe(409);
    expect(errorOf(refused)).toMatchObject({ code: "LAST_OWNER" });
    expect(errorOf(refused)!.message).toContain("An organization needs at least one owner. Make someone else an owner first.");
    expect(roleOf(harness, OMAR)).toBe("owner");
    expect(harness.db.get(developerOrgKey(OMAR.developerId))).toMatchObject({ role: "owner" });

    expect((await harness.dev(OMAR, "PUT", `/v1/app/org/members/${MAYA.developerId}/role`, { requestId: randomUUID(), role: "owner" })).status).toBe(200);
    expect((await demote()).status).toBe(200);
    expect(roleOf(harness, OMAR)).toBe("member");
  });
});

describe("DELETE /v1/app/org/members/{developerId}", () => {
  it("refuses an admin removing an owner or another admin with 403 FORBIDDEN, and lets the admin remove a member", async () => {
    const harness = await org();
    const carl = person(harness, "Carl", "admin");
    const dana = person(harness, "Dana", "admin");
    for (const target of [OMAR, dana]) {
      const refused = await harness.remove(carl, target);
      expect(refused.status, target.name).toBe(403);
      expect(errorOf(refused)).toMatchObject({ code: "FORBIDDEN" });
      expect(roleOf(harness, target)).toBeDefined();
    }
    const removed = await harness.remove(carl, MAYA);
    expect(removed.status).toBe(200);
    expect(roleOf(harness, MAYA)).toBeUndefined();
  });

  it("lets an owner remove an owner while another owner remains, and refuses a member removing anyone", async () => {
    const harness = await org();
    const eve = person(harness, "Eve", "owner");
    expect((await harness.remove(MAYA, OMAR)).status).toBe(403);
    expect((await harness.remove(OMAR, eve)).status).toBe(200);
    expect(roleOf(harness, eve)).toBeUndefined();
    expect(roleOf(harness, OMAR)).toBe("owner");
  });

  it("refuses removing yourself, pointing at agentx org leave", async () => {
    const { remove } = await org();
    const refused = await remove(OMAR, OMAR);
    expect(refused.status).toBe(403);
    expect(errorOf(refused)).toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("use agentx org leave to leave") as string });
  });

  it("answers 404 for a person who is not a member", async () => {
    const harness = await org();
    const stranger = { ...MAYA, developerId: "9".repeat(64) };
    expect((await harness.remove(OMAR, stranger)).status).toBe(404);
  });

  it("removes the member's grants, monthly limit, email pointer and org pointer, ends their sessions and says their tasks will stop", async () => {
    const harness = await org();
    const bea = person(harness, "Bea", "member", "bea@example.com");
    for (const project of ["payments", "ledger"]) harness.db.set({ ...projectMemberKey(TEST_ORG, bea.developerId, project), entityType: "MEMBERSHIP", ownerKey: bea.developerId, projectName: project, role: "developer" });
    harness.db.set({ ...projectMemberKey(TEST_ORG, OMAR.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: OMAR.developerId, projectName: "payments", role: "developer" });
    harness.db.set({ ...orgSettingsKey(TEST_ORG, "BUDGET"), entityType: "SETTING", memberOverrides: { [bea.developerId]: 5, [OMAR.developerId]: 9 } });

    const removed = await harness.remove(OMAR, bea);
    expect(removed.status).toBe(200);
    expect(removed.body.message).toBe("Bea's running tasks will stop after their current step. None of them will open a pull request.");
    expect(harness.db.find((item) => String(item.pk).includes(`#MEMBER#${bea.developerId}`))).toEqual([]);
    expect(harness.db.get(projectMemberKey(TEST_ORG, OMAR.developerId, "payments"))).toBeDefined();
    expect(harness.db.get(orgEmailKey("bea@example.com"))).toBeUndefined();
    expect(harness.db.get(orgMemberKey(TEST_ORG, bea.developerId))).toBeUndefined();
    expect(harness.db.get(developerOrgKey(bea.developerId))).toBeUndefined();
    expect(harness.db.get(orgSettingsKey(TEST_ORG, "BUDGET"))).toMatchObject({ memberOverrides: { [OMAR.developerId]: 9 } });
    expect((harness.db.get(orgSettingsKey(TEST_ORG, "BUDGET")) as { memberOverrides: object }).memberOverrides).not.toHaveProperty(bea.developerId);
    expect(harness.endDeveloperSessions).toHaveBeenCalledWith(expect.objectContaining({ kind: "end-developer-sessions", developerId: bea.developerId }));
  });

  // ERASE-NAME-1: a removed (not erased) person's chosen name goes with their membership; what shows then is the name their sign-in record holds.
  it("replaces the name the removed person chose with a removal marker, on an install with no movers, and leaves everyone else's", async () => {
    const harness = await org();
    const bea = person(harness, "Bea", "member", "bea@example.com");
    const nameItem = (developerId: string, name: string) => ({ pk: `DEVELOPER_NAME#${developerId}`, sk: "NAME", entityType: "DEVELOPER_NAME", developerId, name, chosenAt: "2020-01-01T00:00:00.000Z" });
    harness.db.set(nameItem(bea.developerId, "Bea Chosen"));
    harness.db.set(nameItem(OMAR.developerId, "Omar Chosen"));
    expect((await harness.remove(OMAR, bea)).status).toBe(200);
    expect(harness.db.get(`DEVELOPER_NAME#${bea.developerId}`, "NAME")).toMatchObject({ removed: true });
    expect(harness.db.get(`DEVELOPER_NAME#${bea.developerId}`, "NAME")).not.toHaveProperty("name");
    expect(harness.db.get(`DEVELOPER_NAME#${OMAR.developerId}`, "NAME")).toMatchObject({ name: "Omar Chosen" });
  });

  it("refuses the removed person's still-valid token with AUTH_REQUIRED on the next call", async () => {
    const harness = await org();
    const bea = person(harness, "Bea", "member");
    expect((await harness.dev(bea, "GET", "/v1/dev/org")).status).toBe(200);
    expect((await harness.remove(OMAR, bea)).status).toBe(200);
    const next = await harness.dev(bea, "GET", "/v1/dev/org");
    expect(next.status).toBe(401);
    expect(errorOf(next)).toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("bans the person on a private install and not on a cloud install", async () => {
    const privateInstall = await org();
    const bea = person(privateInstall, "Bea", "member");
    await privateInstall.remove(OMAR, bea);
    expect(privateInstall.db.get(orgBanKey(TEST_ORG, bea.developerId))).toMatchObject({ developerId: bea.developerId });

    const cloud = await org({ brokerExtra: { cloud: true } });
    const cal = person(cloud, "Cal", "member");
    await cloud.remove(OMAR, cal);
    expect(cloud.db.get(orgBanKey(TEST_ORG, cal.developerId))).toBeUndefined();
    expect(cloud.db.get(orgMemberKey(TEST_ORG, cal.developerId))).toBeUndefined();
  });

  it("does not fail the removal when the sessions cannot be ended (the membership is already gone)", async () => {
    const harness = await org({ developerExtra: { endDeveloperSessions: async () => ({ ok: false as const, error: "unavailable" as const }) } });
    expect((await harness.remove(OMAR, MAYA)).status).toBe(200);
    expect(roleOf(harness, MAYA)).toBeUndefined();
  });
});

describe("POST /v1/app/org/leave", () => {
  const leave = (harness: Harness, who: Developer) => harness.dev(who, "POST", "/v1/app/org/leave", {});

  it("lets a member and an admin leave, without a ban", async () => {
    const harness = await org();
    const carl = person(harness, "Carl", "admin");
    for (const who of [MAYA, carl]) {
      const left = await leave(harness, who);
      expect(left.status, who.name).toBe(200);
      expect(left.body).toMatchObject({ left: true, orgClosed: false });
      expect(harness.db.get(orgMemberKey(TEST_ORG, who.developerId))).toBeUndefined();
      expect(harness.db.get(developerOrgKey(who.developerId))).toBeUndefined();
      expect(harness.db.get(orgBanKey(TEST_ORG, who.developerId))).toBeUndefined();
      expect((await harness.dev(who, "GET", "/v1/dev/org")).status).toBe(401);
    }
    expect(harness.endDeveloperSessions).toHaveBeenCalledTimes(2);
  });

  it("accepts an optional request id and ignores it (plan text, N1), and still refuses any other key", async () => {
    const harness = await org();
    const bea = person(harness, "Bea", "member");
    const unknown = await harness.dev(bea, "POST", "/v1/app/org/leave", { requestId: randomUUID(), extra: true });
    expect(unknown.status).toBe(400);
    expect(errorOf(unknown)).toMatchObject({ code: "CONFIG_INVALID" });
    const malformed = await harness.dev(bea, "POST", "/v1/app/org/leave", { requestId: "not-a-uuid" });
    expect(malformed.status).toBe(400);
    expect(roleOf(harness, bea)).toBe("member");
    const left = await harness.dev(bea, "POST", "/v1/app/org/leave", { requestId: randomUUID() });
    expect(left.status).toBe(200);
    expect(left.body).toMatchObject({ left: true, orgClosed: false });
    expect(roleOf(harness, bea)).toBeUndefined();
  });

  it("refuses the only owner leaving while others remain with 409 LAST_OWNER, and lets an owner leave when another owner exists", async () => {
    const harness = await org();
    const refused = await leave(harness, OMAR);
    expect(refused.status).toBe(409);
    expect(errorOf(refused)).toMatchObject({ code: "LAST_OWNER", message: "An organization needs at least one owner. Make someone else an owner first." });
    expect(roleOf(harness, OMAR)).toBe("owner");
    expect(harness.db.get(orgMetaKey(TEST_ORG))?.closedAt).toBeUndefined();

    await harness.dev(OMAR, "PUT", `/v1/app/org/members/${MAYA.developerId}/role`, { requestId: randomUUID(), role: "owner" });
    const left = await leave(harness, OMAR);
    expect(left.status).toBe(200);
    expect(left.body).toMatchObject({ left: true, orgClosed: false });
    expect(roleOf(harness, OMAR)).toBeUndefined();
    expect(roleOf(harness, MAYA)).toBe("owner");
  });

  it("closes the org of a sole owner: closedAt, GitHub and Slack bindings released, both keys, and the claim on the trial kept", async () => {
    const orgA = `org_${"a".repeat(20)}`;
    const orgB = `org_${"b".repeat(20)}`;
    const zed: Developer = { developerId: createHash("sha256").update("zed").digest("hex"), name: "Zed Yu", provider: "oidc", sessionId: "s-zed" };
    const harness = await createSingleAnswerPlanBroker({
      brokerExtra: { cloud: true },
      orgResolver: async ({ developerId }) => (developerId === zed.developerId ? orgA : TEST_ORG),
      developerExtra: { endDeveloperSessions: async () => ({ ok: true as const }) },
    });
    harness.db.set({ pk: `SESSION#${zed.sessionId}`, sk: "META", sessionId: zed.sessionId, developerId: zed.developerId, amr: "oidc", startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    harness.db.set({ pk: `DEVELOPER#${zed.developerId}`, sk: "META", developerId: zed.developerId, provider: "oidc", displayName: zed.name, email: "zed@example.com", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    await harness.orgOf(zed);
    seedMembership(harness.db, zed.developerId, { orgId: orgA, role: "owner" });
    harness.db.set({ ...orgEmailKey("zed@example.com"), entityType: "ORG_EMAIL", developerId: zed.developerId, orgId: orgA, createdAt: "x" });
    const store = new OrgStore({ documentClient: harness.db, tableName: "state", now: Date.now });
    await store.bindSlackTeam({ orgId: orgA, teamId: "T0TEAM" });
    harness.db.set({ ...githubInstallationKey(55), entityType: "GITHUB_INSTALLATION", installationId: 55, orgId: orgA, status: "active" });
    harness.db.set({ ...orgGithubInstallationKey(orgA, 55), entityType: "GITHUB_INSTALLATION", installationId: 55, orgId: orgA, status: "active" });
    harness.db.set({ ...trialGithubKey("gh-1"), entityType: "TRIAL_GITHUB", orgId: orgA });
    expect(harness.db.get(orgSlackTeamKey(orgA, "T0TEAM"))).toBeDefined();
    await expect(new OrgStore({ documentClient: harness.db, tableName: "state", now: Date.now }).bindSlackTeam({ orgId: orgB, teamId: "T0TEAM" })).rejects.toMatchObject({ code: "SLACK_TEAM_TAKEN" });

    const left = await leave(harness, zed);
    expect(left.status).toBe(200);
    expect(left.body).toMatchObject({ left: true, orgClosed: true });
    expect(typeof harness.db.get(orgMetaKey(orgA))?.closedAt).toBe("string");
    for (const key of [githubInstallationKey(55), orgGithubInstallationKey(orgA, 55), slackTeamOrgKey("T0TEAM"), orgSlackTeamKey(orgA, "T0TEAM"), orgMemberKey(orgA, zed.developerId), developerOrgKey(zed.developerId), orgEmailKey("zed@example.com")]) {
      expect(harness.db.get(key), JSON.stringify(key)).toBeUndefined();
    }
    expect(harness.db.get(trialGithubKey("gh-1"))).toMatchObject({ orgId: orgA });
    // Another org can now bind the Slack team.
    await new OrgStore({ documentClient: harness.db, tableName: "state", now: Date.now }).bindSlackTeam({ orgId: orgB, teamId: "T0TEAM" });
    expect(await store.orgForSlackTeam("T0TEAM")).toBe(orgB);
  });
});

describe("POST /v1/app/org/leave on a private install (ruling, Task 4 Minor 6)", () => {
  it("answers LAST_OWNER, make someone else an owner first, when the sole owner and only member leaves a non-cloud install; the org stays open", async () => {
    const harness = await org();
    harness.db.delete(orgMemberKey(TEST_ORG, MAYA.developerId));
    harness.db.delete(developerOrgKey(MAYA.developerId));
    const refused = await harness.dev(OMAR, "POST", "/v1/app/org/leave", {});
    expect(refused.status).toBe(409);
    expect(errorOf(refused)).toMatchObject({ code: "LAST_OWNER", message: "An organization needs at least one owner. Make someone else an owner first." });
    expect(harness.db.get(orgMetaKey(TEST_ORG))?.closedAt).toBeUndefined();
    expect(roleOf(harness, OMAR)).toBe("owner");
    expect(harness.endDeveloperSessions).not.toHaveBeenCalled();
  });
});

describe("OrgStore.closeOrg and removeMember", () => {
  const T0 = Date.parse("2026-10-21T00:00:00.000Z");
  const setup = () => {
    const db = new FakeDynamoDb();
    return { db, store: new OrgStore({ documentClient: db, tableName: "state", now: () => T0 }) };
  };

  it("runs archiveProjects and clearEgress after releasing the bindings and before it closes the org", async () => {
    const { db, store } = setup();
    const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "owner", email: "owner@example.com" });
    await store.bindSlackTeam({ orgId, teamId: "T1" });
    const order: string[] = [];
    await store.closeOrg(orgId, {
      archiveProjects: async () => { order.push(`archive:${String(db.get(slackTeamOrgKey("T1")) !== undefined)}:${String(db.get(orgMetaKey(orgId))?.closedAt)}`); },
      clearEgress: async () => { order.push(`egress:${String(db.get(orgMemberKey(orgId, "owner")) !== undefined)}`); },
      emails: ["owner@example.com"],
    });
    expect(order).toEqual(["archive:false:undefined", "egress:true"]);
    expect(db.get(orgMetaKey(orgId))?.closedAt).toBe("2026-10-21T00:00:00.000Z");
    expect(db.get(orgMemberKey(orgId, "owner"))).toBeUndefined();
    expect(db.get(orgEmailKey("owner@example.com"))).toBeUndefined();
  });

  it("clears the org's connections after its egress and before it closes the org, and stops the close, ready to run again, when that fails", async () => {
    const { db, store } = setup();
    const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "owner" });
    const order: string[] = [];
    const hooks = {
      archiveProjects: async () => { order.push("archive"); },
      clearEgress: async () => { order.push("egress"); },
    };
    await expect(store.closeOrg(orgId, { ...hooks, clearConnections: async () => { order.push("connections-fail"); throw new Error("secrets are down"); } })).rejects.toThrow("secrets are down");
    expect(db.get(orgMetaKey(orgId))?.closedAt).toBeUndefined();
    expect(db.get(orgMemberKey(orgId, "owner"))).toBeDefined();
    await store.closeOrg(orgId, { ...hooks, clearConnections: async (cleared) => { order.push(`connections:${cleared}:${String(db.get(orgMetaKey(orgId))?.closedAt)}`); } });
    expect(order).toEqual(["archive", "egress", "connections-fail", "archive", "egress", `connections:${orgId}:undefined`]);
    expect(db.get(orgMetaKey(orgId))?.closedAt).toBe("2026-10-21T00:00:00.000Z");
  });

  it("refuses to close an org that has other members with LAST_OWNER, and changes nothing", async () => {
    const { db, store } = setup();
    const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "owner" });
    await store.addMember({ orgId, developerId: "dev-2", role: "member" });
    await store.bindSlackTeam({ orgId, teamId: "T1" });
    await expect(store.closeOrg(orgId, { archiveProjects: async () => undefined, clearEgress: async () => undefined })).rejects.toMatchObject({ code: "LAST_OWNER" });
    expect(db.get(slackTeamOrgKey("T1"))).toBeDefined();
    expect(db.get(orgMetaKey(orgId))?.closedAt).toBeUndefined();
  });

  it("deletes a global binding only while it still names the closing org, and can be run again after a stop part-way", async () => {
    const { db, store } = setup();
    const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "owner" });
    await store.bindSlackTeam({ orgId, teamId: "T1" });
    // A stale reverse item whose global item now belongs to another org.
    db.set({ ...slackTeamOrgKey("T1"), entityType: "SLACK_TEAM_ORG", orgId: `org_${"c".repeat(20)}` });
    db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("closedAt"), error: { name: "InternalServerError" } });
    await expect(store.closeOrg(orgId, { archiveProjects: async () => undefined, clearEgress: async () => undefined })).rejects.toMatchObject({ name: "InternalServerError" });
    expect(db.get(slackTeamOrgKey("T1"))).toMatchObject({ orgId: `org_${"c".repeat(20)}` });
    expect(db.get(orgSlackTeamKey(orgId, "T1"))).toBeUndefined();
    await store.closeOrg(orgId, { archiveProjects: async () => undefined, clearEgress: async () => undefined });
    expect(db.get(orgMetaKey(orgId))?.closedAt).toBeDefined();
    await store.closeOrg(orgId, { archiveProjects: async () => undefined, clearEgress: async () => undefined });
  });

  it("refuses removing the last owner with LAST_OWNER before it deletes the grants", async () => {
    const { db, store } = setup();
    const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "owner" });
    await store.addMember({ orgId, developerId: "dev-2", role: "member" });
    db.set({ ...projectMemberKey(orgId, "owner", "payments"), entityType: "MEMBERSHIP", ownerKey: "owner", projectName: "payments", role: "developer" });
    await expect(store.removeMember({ orgId, developerId: "owner", emails: [], ban: false })).rejects.toMatchObject({ code: "LAST_OWNER" });
    expect(db.get(projectMemberKey(orgId, "owner", "payments"))).toBeDefined();
    expect(db.get(orgMemberKey(orgId, "owner"))).toBeDefined();
  });

  it("leaves an email pointer that names someone else alone", async () => {
    const { db, store } = setup();
    const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "owner" });
    await store.addMember({ orgId, developerId: "dev-2", role: "member" });
    db.set({ ...orgEmailKey("shared@example.com"), entityType: "ORG_EMAIL", developerId: "owner", orgId, createdAt: "x" });
    await store.removeMember({ orgId, developerId: "dev-2", emails: ["shared@example.com", "nobody@example.com"], ban: false });
    expect(db.get(orgEmailKey("shared@example.com"))).toMatchObject({ developerId: "owner" });
  });

  it("refuses a demotion when the only other owner is demoted between the read and the transaction (the guard fails it)", async () => {
    const { db, store } = setup();
    const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "owner" });
    await store.addMember({ orgId, developerId: "dev-2", role: "owner" });
    // After setRole read dev-2 as the other owner, dev-2 is demoted; the transaction must refuse.
    let armed = true;
    const realSend = db.send;
    db.send = async (command) => {
      if (armed && command.constructor.name === "TransactWriteCommand") {
        armed = false;
        db.set({ ...db.get(orgMemberKey(orgId, "dev-2"))!, role: "member" });
      }
      return realSend(command);
    };
    await expect(store.setRole({ orgId, developerId: "owner", role: "member" })).rejects.toMatchObject({ code: "LAST_OWNER" });
    expect(db.get(orgMemberKey(orgId, "owner"))).toMatchObject({ role: "owner" });
  });

  it("checks that the removal is still allowed after everything it reads, so a demotion during those reads leaves the grants alone", async () => {
    const { db, store } = setup();
    const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "owner" });
    await store.addMember({ orgId, developerId: "dev-2", role: "owner" });
    db.set({ ...projectMemberKey(orgId, "owner", "payments"), entityType: "MEMBERSHIP", ownerKey: "owner", projectName: "payments", role: "developer" });
    // While the email pointers are read, the only other owner is demoted: the check that follows sees it.
    const realSend = db.send;
    db.send = async (command) => {
      const result = await realSend(command);
      if (command.constructor.name === "GetCommand" && JSON.stringify((command as { input: unknown }).input).includes("ORG_EMAIL")) {
        db.set({ ...db.get(orgMemberKey(orgId, "dev-2"))!, role: "member" });
      }
      return result;
    };
    await expect(store.removeMember({ orgId, developerId: "owner", emails: ["owner@example.com"], ban: false })).rejects.toMatchObject({ code: "LAST_OWNER" });
    expect(db.get(projectMemberKey(orgId, "owner", "payments"))).toBeDefined();
    expect(db.get(orgMemberKey(orgId, "owner"))).toBeDefined();
  });

  it("deletes the member only while their role is the one the caller saw (Minor 4): a promotion in between is CHANGE_STALE and nothing is removed", async () => {
    const { db, store } = setup();
    const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "owner" });
    await store.addMember({ orgId, developerId: "dev-2", role: "member" });
    await expect(store.removeMember({ orgId, developerId: "dev-2", emails: [], ban: false, expectedRole: "admin" })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(db.get(orgMemberKey(orgId, "dev-2"))).toBeDefined();
    // The promotion lands after the store read the member and before its transaction.
    const realSend = db.send;
    db.send = async (command) => {
      if (command.constructor.name === "TransactWriteCommand") db.set({ ...db.get(orgMemberKey(orgId, "dev-2"))!, role: "admin" });
      return realSend(command);
    };
    await expect(store.removeMember({ orgId, developerId: "dev-2", emails: [], ban: false, expectedRole: "member" })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(db.get(orgMemberKey(orgId, "dev-2"))).toMatchObject({ role: "admin" });
    expect(db.get(orgRemovedKey(orgId, "dev-2"))).toBeUndefined();
  });

  it("refuses an invite into a closed org without burning the invite (Minor 5)", async () => {
    const { db, store } = setup();
    const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "owner" });
    const { token } = await store.createInvite({ orgId, createdBy: "owner", role: "member" });
    await store.closeOrg(orgId, { archiveProjects: async () => undefined, clearEgress: async () => undefined });
    await expect(store.acceptInvite({ tokenHash: inviteTokenHash(token), developerId: "late" })).rejects.toMatchObject({ code: "INVITE_INVALID" });
    expect(db.get(orgMemberKey(orgId, "late"))).toBeUndefined();
    expect(db.get(developerOrgKey("late"))).toBeUndefined();
    expect(db.find((item) => item.entityType === "ORG_INVITE")[0]).not.toHaveProperty("acceptedAt");
  });

  it("does not close an org that gained a member after closeOrg read it: LAST_OWNER, bindings kept, joins allowed again (Minor 5)", async () => {
    const { db, store } = setup();
    const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "owner" });
    await store.bindSlackTeam({ orgId, teamId: "T1" });
    const { token } = await store.createInvite({ orgId, createdBy: "owner", role: "member" });
    // The invite is accepted right after closeOrg's first read of the members.
    let armed = true;
    const realSend = db.send;
    db.send = async (command) => {
      const result = await realSend(command);
      if (armed && command.constructor.name === "QueryCommand" && JSON.stringify((command as { input: unknown }).input).includes("MEMBER#")) {
        armed = false;
        await store.acceptInvite({ tokenHash: inviteTokenHash(token), developerId: "joiner" });
      }
      return result;
    };
    await expect(store.closeOrg(orgId, { archiveProjects: async () => undefined, clearEgress: async () => undefined })).rejects.toMatchObject({ code: "LAST_OWNER" });
    expect(db.get(slackTeamOrgKey("T1"))).toBeDefined();
    expect(db.get(orgMemberKey(orgId, "owner"))).toBeDefined();
    expect(db.get(orgMetaKey(orgId))?.closedAt).toBeUndefined();
    expect(db.get(orgMetaKey(orgId))?.closingAt).toBeUndefined();
    const second = await store.createInvite({ orgId, createdBy: "owner", role: "member" });
    await expect(store.acceptInvite({ tokenHash: inviteTokenHash(second.token), developerId: "other" })).resolves.toMatchObject({ orgId });
  });

  it("blocks joins from the moment closeOrg has checked the members (Minor 5): an invite accepted while it archives is refused", async () => {
    const { db, store } = setup();
    const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "owner" });
    const { token } = await store.createInvite({ orgId, createdBy: "owner", role: "member" });
    let refused: unknown;
    await store.closeOrg(orgId, {
      archiveProjects: async () => { refused = await store.acceptInvite({ tokenHash: inviteTokenHash(token), developerId: "joiner" }).catch((error: unknown) => error); },
      clearEgress: async () => undefined,
    });
    expect(refused).toMatchObject({ code: "INVITE_INVALID" });
    expect(db.get(orgMemberKey(orgId, "joiner"))).toBeUndefined();
    expect(db.get(orgMetaKey(orgId))?.closedAt).toBeDefined();
  });
});

describe("a ban on a single-org install", () => {
  const input = (developerId: string) => ({ method: "oidc" as const, developerId, displayName: "Maya", emailVerified: true });
  const setup = () => {
    const db = new FakeDynamoDb();
    return { db, orgs: new OrgStore({ documentClient: db, tableName: "state", now: () => Date.parse("2026-10-21T00:00:00.000Z") }) };
  };

  it("refuses a removed member's oidc sign-in with REMOVED_FROM_ORG, and an invite lets them back in and clears the ban", async () => {
    const { db, orgs } = setup();
    const maya = "a".repeat(64);
    await orgs.ensureOrg(TEST_ORG, TEST_ENV);
    await orgs.createOrgWithOwner({ name: "x", developerId: "other" });
    await orgs.addMember({ orgId: TEST_ORG, developerId: maya, role: "member" });
    await orgs.removeMember({ orgId: TEST_ORG, developerId: maya, emails: [], ban: true });
    expect(db.get(orgBanKey(TEST_ORG, maya))).toBeDefined();

    const deps = { orgs, singleOrgId: TEST_ORG, singleOrgName: TEST_ENV };
    const refused = await resolveOrgOnSignIn(deps, input(maya)).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "REMOVED_FROM_ORG", message: expect.stringContaining("You were removed from this organization. Ask an admin to invite you again.") as string });
    expect(await orgs.orgForDeveloper(maya)).toBeUndefined();

    await orgs.addMember({ orgId: TEST_ORG, developerId: "valid-inviter", role: "admin" });
    const { token } = await orgs.createInvite({ orgId: TEST_ORG, createdBy: "valid-inviter", role: "member" });
    expect(await resolveOrgOnSignIn(deps, { ...input(maya), inviteTokenHash: inviteTokenHash(token) })).toEqual({ orgId: TEST_ORG, role: "member" });
    expect(db.get(orgBanKey(TEST_ORG, maya))).toBeUndefined();
    expect(await orgs.orgForDeveloper(maya)).toEqual({ orgId: TEST_ORG, role: "member" });
    // Signing in again later is an ordinary sign-in.
    expect(await resolveOrgOnSignIn(deps, input(maya))).toEqual({ orgId: TEST_ORG, role: "member" });
  });

  it("is answered by the sign-in itself as access_denied with the same words", async () => {
    const user: FakeOidcUser = { sub: "maya-oidc-1", name: "Maya Chen", email: "maya@example.com", email_verified: true };
    const h = identityHarness({ oidc: {}, oidcUsers: [user] });
    const mayaId = ownerKeyForSubject(OIDC_ISSUER, user.sub);
    await h.orgs.ensureOrg(TEST_ORG, TEST_ENV);
    h.state.set({ ...orgBanKey(TEST_ORG, mayaId), entityType: "ORG_BAN", orgId: TEST_ORG, developerId: mayaId, bannedAt: "x" });
    const back = await h.signIn("oidc", user.sub);
    expect(back.searchParams.get("code")).toBeNull();
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("error_description")).toBe("You were removed from this organization. Ask an admin to invite you again.");
  });

  it("does not ban a cloud sign-in: the removed person gets a new org of their own (rule 3)", async () => {
    const bea: FakeOidcUser = { sub: "bea-cloud-1", name: "Bea Ortiz", email: "bea@example.com", email_verified: true };
    const harness = await org({ brokerExtra: { cloud: true } });
    // A cloud install's link carries the token in the fragment.
    const token = new URLSearchParams(new URL(String((await harness.dev(OMAR, "POST", "/v1/app/org/invites", { requestId: randomUUID(), role: "member" })).body.inviteUrl)).hash.slice(1)).get("invite")!;
    const h = identityHarness({ cloud: {}, oidcUsers: [bea], state: harness.db });
    const joined = await h.exchange((await h.signIn("cloud", bea.sub, { query: { invite: token } })).searchParams.get("code")!);
    const claims = JSON.parse(Buffer.from(String(joined.body.access_token).split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(claims).toMatchObject({ org: TEST_ORG, org_role: "member" });
    const beaId = ownerKeyForSubject(OIDC_ISSUER, bea.sub);
    expect(harness.db.get(orgEmailKey("bea@example.com"))).toMatchObject({ developerId: beaId });

    // Bea's person record for the broker's routes; Omar removes her.
    const asBea: Developer = { developerId: beaId, name: bea.name ?? "Bea Ortiz", provider: "oidc", sessionId: "s-bea" };
    harness.db.set({ pk: `SESSION#${asBea.sessionId}`, sk: "META", sessionId: asBea.sessionId, developerId: beaId, amr: "oidc", startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    harness.db.set({ pk: `DEVELOPER#${beaId}`, sk: "META", developerId: beaId, provider: "oidc", displayName: bea.name, email: bea.email, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    seedMembership(harness.db, beaId, { orgId: TEST_ORG, role: "member" });
    expect((await harness.remove(OMAR, asBea)).status).toBe(200);
    expect(harness.db.get(orgEmailKey("bea@example.com"))).toBeUndefined();

    const again = await h.exchange((await h.signIn("cloud", bea.sub)).searchParams.get("code")!);
    expect(again.status).toBe(200);
    const next = JSON.parse(Buffer.from(String(again.body.access_token).split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(next.org).not.toBe(TEST_ORG);
    expect(next).toMatchObject({ org_role: "owner" });
  });
});

describe("a removed creator's work stops (ruling R60)", () => {
  /** A Quick workflow task of `maker`, taken to the point where its IMPLEMENT step is running. */
  async function implementing(harness: Harness, maker: Developer) {
    const started = await harness.dev(maker, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
    expect(started.status).toBe(200);
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const record = harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workspaceId: string; workflow: Record<string, unknown> };
    const workspaceId = record.workspaceId;
    harness.db.set({ ...record, workflow: { ...record.workflow, checkPolicy: { required: [REQUIRED_CHECK], optional: [], selectedOptionalIds: [] } } });
    await harness.finish(workspaceId, String(operations(harness, workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", PREPARED);
    const planning = operations(harness, workspaceId).find((item) => item.workflowMode === "PLAN")!;
    const plan = "# Plan\n\n1. Fix retry handling.\n2. Add a regression test.\n";
    await finishPlanningWithMarkdown(harness, workspaceId, String(planning.id), plan);
    const digest = createHash("sha256").update(plan).digest("hex");
    const revision = (harness.db.get(`DEVTASK#${taskId}`, "META") as { workflow: { revision: number } }).workflow.revision;
    const approved = await harness.dev(maker, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: revision, decision: "APPROVE", reason: "Approved", artifactDigest: digest });
    expect(approved.status).toBe(200);
    const implementation = operations(harness, workspaceId).find((item) => item.workflowMode === "IMPLEMENT")!;
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
    const finishImplementation = () => harness.finish(workspaceId, String(implementation.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories, workflowCheckCandidateRepositories: candidate.repositories, checks: passingChecks() } });
    return { taskId, workspaceId, candidate, finishImplementation };
  }

  const taskRecord = (harness: Harness, taskId: string) => harness.db.get(`DEVTASK#${taskId}`, "META") as unknown as DeveloperTaskRecord & { workflow: NonNullable<DeveloperTaskRecord["workflow"]> };
  /** What a route needs when a background path (a Slack press, the dispatcher) acts for the task's creator. */
  const routeDeps = (harness: Harness) => ({
    documentClient: harness.db, tableName: "state", actions: harness.actions, now: Date.now, orgId: TEST_ORG,
    checkAccess: async () => ({ revision: 1, policy: {} as never, access: "granted" as const, channelIds: [], role: "contributor" as const }), projectChannelIds: async () => [],
  });
  const asCreator = (who: Developer) => ({ developerId: who.developerId, sessionId: "workflow-dispatch", amr: who.provider, name: who.name, orgId: TEST_ORG, orgRole: "member" as const });
  const gateway = () => ({
    reconcilePullRequest: vi.fn(async () => ({ number: 42, url: "https://github.com/example/demo/pull/42", reconciled: false })),
    getCommitTree: vi.fn(async () => "b".repeat(40)), getBranchHead: vi.fn(async () => "d".repeat(40)), getCommitParents: vi.fn(async () => ["e".repeat(40)]),
    getPullRequest: vi.fn(), updatePullRequest: vi.fn(), verifyWebhookRepository: vi.fn(async () => true),
  });

  it("refuses the REVIEW dispatch of a task whose IMPLEMENT step was running at the removal: creator_removed, the exact reason, no REVIEW operation", async () => {
    const harness = await org();
    const { taskId, workspaceId, candidate, finishImplementation } = await implementing(harness, MAYA);
    expect((await harness.remove(OMAR, MAYA)).status).toBe(200);
    // The running step finishes; the next dispatch is the one that is refused.
    await finishImplementation();
    expect(operations(harness, workspaceId).filter((operation) => operation.workflowMode === "REVIEW")).toEqual([]);
    const task = taskRecord(harness, taskId);
    expect(task.workflow).toMatchObject({ stage: "REVIEW", state: "WAITING", candidate: { digest: candidate.digest } });
    expect(task).toMatchObject({ outcome: "creator_removed", outcomeReason: REMOVED_REASON("Maya Chen") });

    await expect(startTaskWorkflowReviewFromSystem(routeDeps(harness) as never, taskId, { workflowRevision: task.workflow.revision, candidateDigest: candidate.digest }))
      .rejects.toMatchObject({ code: "TASK_ACCESS_DENIED", message: expect.stringContaining(REMOVED_REASON("Maya Chen")) as string });
    expect(operations(harness, workspaceId).filter((operation) => operation.workflowMode === "REVIEW")).toEqual([]);
    // MR-3 (this replaces parking the row): the dispatcher ended the row when it saw the owner gone, so nothing is parked or retried, and a sweep starts nothing.
    expect(harness.db.find((item) => item.pk === "WORKFLOW_DISPATCH")).toEqual([]);
    await harness.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(operations(harness, workspaceId).filter((operation) => operation.workflowMode === "REVIEW")).toEqual([]);
  });

  it("after a take-over the removal that stops the task is the taker's: the creator's removal changes nothing (Plan 5 Task 12a)", async () => {
    const harness = await org();
    const bea = person(harness, "Bea", "member");
    // The taker starts the next step for themselves, so they hold a project grant (the send-back's project access rule, S2).
    harness.db.set({ ...projectMemberKey(TEST_ORG, bea.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: bea.developerId, projectName: "payments", role: "developer" });
    const { taskId, workspaceId, finishImplementation } = await implementing(harness, MAYA);
    const taken = taskRecord(harness, taskId);
    harness.db.set({ ...taken, currentOwner: { developerId: bea.developerId, name: "Bea", provider: "oidc", since: new Date().toISOString() } });
    expect((await harness.remove(OMAR, MAYA)).status).toBe(200);
    await finishImplementation();
    // The next dispatch runs: the task's owner is Bea, who is still a member.
    expect(operations(harness, workspaceId).filter((operation) => operation.workflowMode === "REVIEW")).toHaveLength(1);
    expect(taskRecord(harness, taskId).outcome).toBeUndefined();
  });

  it("after a take-over the taker's removal ends the task as creator_removed, naming the taker, and the next dispatch is refused", async () => {
    const harness = await org();
    const bea = person(harness, "Bea", "member");
    const { taskId, workspaceId, candidate, finishImplementation } = await implementing(harness, MAYA);
    harness.db.set({ ...taskRecord(harness, taskId), currentOwner: { developerId: bea.developerId, name: "Bea", provider: "oidc", since: new Date().toISOString() } });
    expect((await harness.remove(OMAR, bea)).status).toBe(200);
    await finishImplementation();
    expect(operations(harness, workspaceId).filter((operation) => operation.workflowMode === "REVIEW")).toEqual([]);
    const task = taskRecord(harness, taskId);
    expect(task).toMatchObject({ outcome: "creator_removed", outcomeReason: REMOVED_REASON("Bea") });
    await expect(startTaskWorkflowReviewFromSystem(routeDeps(harness) as never, taskId, { workflowRevision: task.workflow.revision, candidateDigest: candidate.digest }))
      .rejects.toMatchObject({ code: "TASK_ACCESS_DENIED", message: expect.stringContaining(REMOVED_REASON("Bea")) as string });
  });

  it("leaves a task whose creator is still a member dispatching as before", async () => {
    const harness = await org();
    const { workspaceId, finishImplementation } = await implementing(harness, MAYA);
    await finishImplementation();
    expect(operations(harness, workspaceId).filter((operation) => operation.workflowMode === "REVIEW")).toHaveLength(1);
  });

  it("answers a continue on the removed creator's idle task with TASK_ACCESS_DENIED and R60's reason, never 'project not found'", async () => {
    const harness = await org();
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "claude-code" });
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const task = taskRecord(harness, taskId);
    const active = () => String((harness.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
    await harness.finish(task.workspaceId, active(), "SUCCEEDED");
    await harness.finish(task.workspaceId, active(), "SUCCEEDED");
    expect((await harness.remove(OMAR, MAYA)).status).toBe(200);

    // Their own token is refused outright.
    const own = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/continue`, { requestId: randomUUID(), instructions: "more" });
    expect(own.status).toBe(401);
    // A Slack press or other background path acts as the creator without a session: it reaches the route and is refused there.
    const path = `/v1/dev/tasks/${taskId}/continue`;
    await expect(routeDeveloperTaskRequest(routeDeps(harness) as never, asCreator(MAYA), { method: "POST", path, headers: {}, requestId: randomUUID(), body: JSON.stringify({ requestId: randomUUID(), instructions: "more" }) }, new URL(path, "https://agentx.invalid")))
      .rejects.toMatchObject({ code: "TASK_ACCESS_DENIED", message: expect.stringContaining(REMOVED_REASON("Maya Chen")) as string });
    expect(taskRecord(harness, taskId)).toMatchObject({ outcome: "creator_removed", outcomeReason: REMOVED_REASON("Maya Chen") });
    expect(operations(harness, task.workspaceId).filter((operation) => operation.kind === "task")).toHaveLength(1);
    // The broker's own acceptTask for the task owner's identity says the same, before its project checks.
    await expect(harness.actions.acceptTask(developerTaskIdentity(taskRecord(harness, taskId), TEST_ORG), task.workspaceId, { requestId: randomUUID(), conversationId: String((harness.db.get(`DEVTASK#${taskId}`, "META") as { conversationId: string }).conversationId), prompt: "more" }, () => []))
      .rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
  });

  it("shows the refused task as ended in its view and its list row: status CANCELLED, outcome creator_removed with R60's reason, no longer REVIEW and waiting", async () => {
    const harness = await org();
    const { taskId, finishImplementation } = await implementing(harness, MAYA);
    expect((await harness.remove(OMAR, MAYA)).status).toBe(200);
    await finishImplementation();
    const task = taskRecord(harness, taskId);
    expect(task.workflow).toMatchObject({ stage: "REVIEW", state: "WAITING" });
    const path = `/v1/dev/tasks/${taskId}`;
    const read = async (route: string) => routeDeveloperTaskRequest(routeDeps(harness), asCreator(MAYA), { method: "GET", path: route, headers: {}, requestId: randomUUID() }, new URL(route, "https://agentx.invalid")) as Promise<Record<string, unknown>>;
    const { task: view } = await read(path) as { task: { status: string; outcome?: string; outcomeReason?: string; workflow?: { state: string; blockReason?: string } } };
    expect(view).toMatchObject({ status: "CANCELLED", outcome: "creator_removed", outcomeReason: REMOVED_REASON("Maya Chen") });
    expect(view.workflow).toMatchObject({ state: "BLOCKED", blockReason: REMOVED_REASON("Maya Chen") });
    const { tasks } = await read("/v1/dev/tasks") as unknown as { tasks: Array<{ taskId: string; status: string }> };
    expect(tasks.find((row) => row.taskId === taskId)).toMatchObject({ status: "CANCELLED" });
  });

  it("keeps a very long name from breaking the view: the workflow's blockReason is cut to 500 characters, the full reason stays in outcomeReason", async () => {
    const harness = await org();
    const { taskId, finishImplementation } = await implementing(harness, MAYA);
    harness.db.set({ ...harness.db.get(orgMetaKey(TEST_ORG))!, name: "Long ".repeat(200) });
    expect((await harness.remove(OMAR, MAYA)).status).toBe(200);
    await finishImplementation();
    const path = `/v1/dev/tasks/${taskId}`;
    const { task: view } = await routeDeveloperTaskRequest(routeDeps(harness), asCreator(MAYA), { method: "GET", path, headers: {}, requestId: randomUUID() }, new URL(path, "https://agentx.invalid")) as { task: { outcomeReason: string; workflow: { blockReason: string } } };
    expect(view.outcomeReason.length).toBeGreaterThan(500);
    expect(view.workflow.blockReason).toHaveLength(500);
    expect(view.workflow.blockReason.startsWith("Maya Chen is no longer a member of Long")).toBe(true);
  });

  it("tells a removed person whose task was still being set up why it stopped: the view carries R60's reason, not a generic setup failure (Minor 9)", async () => {
    const harness = await org();
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "claude-code" });
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const task = taskRecord(harness, taskId);
    expect((await harness.remove(OMAR, MAYA)).status).toBe(200);
    // The prepare finishes after the removal: the first task cannot be queued (the backstop refuses it).
    await harness.finish(task.workspaceId, String(operations(harness, task.workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", PREPARED);
    expect(operations(harness, task.workspaceId).filter((operation) => operation.kind === "task")).toEqual([]);
    const path = `/v1/dev/tasks/${taskId}`;
    const { task: view } = await routeDeveloperTaskRequest(routeDeps(harness), asCreator(MAYA), { method: "GET", path, headers: {}, requestId: randomUUID() }, new URL(path, "https://agentx.invalid")) as { task: { status: string; outcome?: string; outcomeReason?: string } };
    expect(view).toMatchObject({ status: "CANCELLED", outcome: "creator_removed", outcomeReason: REMOVED_REASON("Maya Chen") });
  });

  it("answers a continue on a removed creator's busy task with R60's reason, not a busy or setup error (Minor 1)", async () => {
    const harness = await org();
    const { taskId } = await implementing(harness, MAYA);
    expect((await harness.remove(OMAR, MAYA)).status).toBe(200);
    // The IMPLEMENT step is still running, so the workspace is busy: the removal's reason comes first.
    const path = `/v1/dev/tasks/${taskId}/continue`;
    await expect(routeDeveloperTaskRequest(routeDeps(harness) as never, asCreator(MAYA), { method: "POST", path, headers: {}, requestId: randomUUID(), body: JSON.stringify({ requestId: randomUUID(), instructions: "more" }) }, new URL(path, "https://agentx.invalid")))
      .rejects.toMatchObject({ code: "TASK_ACCESS_DENIED", message: expect.stringContaining(REMOVED_REASON("Maya Chen")) as string });
  });

  it("answers a pull request follow-up and an update for the removed creator's workspace with TASK_ACCESS_DENIED", async () => {
    const harness = await org();
    const { taskId, workspaceId } = await implementing(harness, MAYA);
    expect((await harness.remove(OMAR, MAYA)).status).toBe(200);
    const identity = developerTaskIdentity(taskRecord(harness, taskId), TEST_ORG);
    await expect(harness.actions.acceptPullRequest(identity, workspaceId, { requestId: randomUUID(), repository: "demo", title: "Fix it", draft: true }, () => []))
      .rejects.toMatchObject({ code: "TASK_ACCESS_DENIED", message: expect.stringContaining(REMOVED_REASON("Maya Chen")) as string });
    await expect(harness.actions.acceptPullRequestUpdate(identity, workspaceId, { requestId: randomUUID(), repository: "demo", pullRequestNumber: 42, action: "append" }, () => [],
      { candidateDigest: "a".repeat(64), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40), expectedHeadCommit: "d".repeat(40) }))
      .rejects.toMatchObject({ code: "TASK_ACCESS_DENIED", message: expect.stringContaining(REMOVED_REASON("Maya Chen")) as string });
    expect(taskRecord(harness, taskId)).toMatchObject({ outcome: "creator_removed" });
    expect(operations(harness, workspaceId).filter((operation) => operation.kind === "publish")).toEqual([]);
    // A workspace with no developer task skips the check.
    await expect(requireWorkspaceCreatorStillMember({ documentClient: harness.db, tableName: "state" }, "no-such-workspace")).resolves.toBeUndefined();
  });

  it("opens no pull request for a removed creator: the publication start is refused before any access check, and no publish operation or GitHub call follows", async () => {
    const github = gateway();
    const harness = await org({ brokerExtra: { githubPullRequests: github } });
    const { taskId, workspaceId, candidate, finishImplementation } = await implementing(harness, MAYA);
    await finishImplementation();
    expect((await harness.remove(OMAR, MAYA)).status).toBe(200);
    // The reviews were running; they finish and the workflow moves on to its publication step.
    const review = operations(harness, workspaceId).find((item) => item.workflowMode === "REVIEW")!;
    const now = new Date().toISOString();
    await harness.finish(workspaceId, String(review.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories,
      workflowReviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: String(review.id), candidateDigest: candidate.digest, role, provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now })) } });
    const task = taskRecord(harness, taskId);
    expect(task.workflow).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
    expect(operations(harness, workspaceId).filter((operation) => operation.kind === "publish")).toEqual([]);
    await expect(startTaskWorkflowPublicationFromSystem(routeDeps(harness) as never, taskId, { workflowRevision: task.workflow.revision, candidateDigest: candidate.digest }, {}))
      .rejects.toMatchObject({ code: "TASK_ACCESS_DENIED", message: expect.stringContaining(REMOVED_REASON("Maya Chen")) as string });
    expect(operations(harness, workspaceId).filter((operation) => operation.kind === "publish")).toEqual([]);
    expect(github.reconcilePullRequest).not.toHaveBeenCalled();
    expect(taskRecord(harness, taskId)).toMatchObject({ outcome: "creator_removed", outcomeReason: REMOVED_REASON("Maya Chen") });
  });

  it("mints no installation token for a publish operation accepted before the removal", async () => {
    const github = gateway();
    const harness = await org({ brokerExtra: { githubPullRequests: github } });
    const { workspaceId, candidate, finishImplementation } = await implementing(harness, MAYA);
    await finishImplementation();
    const review = operations(harness, workspaceId).find((item) => item.workflowMode === "REVIEW")!;
    const now = new Date().toISOString();
    await harness.finish(workspaceId, String(review.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories,
      workflowReviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: String(review.id), candidateDigest: candidate.digest, role, provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now })) } });
    const publish = operations(harness, workspaceId).find((item) => item.kind === "publish") as { id: string };
    expect(publish).toBeDefined();
    const invocation = harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === publish.id)[0]!.invocation as { payload: { repositoryGrant: string } };
    const exchange = vi.spyOn(harness.brokerInput.repositoryGrants, "exchange");
    expect((await harness.remove(OMAR, MAYA)).status).toBe(200);

    const push = (access: "push" | "clone") => harness.handler({ version: "2.0", rawPath: `/v1/internal/workspaces/${workspaceId}/operations/${publish.id}/repository-credentials`, rawQueryString: "",
      headers: { "x-agentx-repository-grant": invocation.payload.repositoryGrant },
      body: JSON.stringify({ credentialRef: "github-app", repositoryUrl: "https://github.com/example/demo.git", access }),
      requestContext: { requestId: randomUUID(), http: { method: "POST" } } });
    const refused = await push("push");
    expect(refused.statusCode).toBe(403);
    expect(JSON.parse(refused.body)).toMatchObject({ error: { code: "TASK_ACCESS_DENIED", message: expect.stringContaining(REMOVED_REASON("Maya Chen")) as string } });
    expect(exchange).not.toHaveBeenCalled();

    // The worker's own pull request and update callbacks are refused as well: no installation token is minted and no PR is opened or updated.
    const mint = vi.spyOn(harness.brokerInput.repositoryGrants, "exchange");
    for (const action of ["pull-request", "pull-request-update"]) {
      await expect(harness.callback(workspaceId, publish.id, action, { requestId: randomUUID(), repository: "demo", title: "Fix it", draft: true, pullRequestNumber: 42 }), action).rejects.toThrow(/TASK_ACCESS_DENIED/);
    }
    expect(github.reconcilePullRequest).not.toHaveBeenCalled();
    expect(github.updatePullRequest).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
  });
});

describe("every task launch checks that the creator is still a member (ruling R60)", () => {
  // developer-tasks.ts is where tasks are launched, so a call site added later must meet the same rule: the check comes before the
  // acceptTask or pull request call, or the call goes through withCurrentThreadNotes (which checks first).
  const source = readSplitSource(join(import.meta.dirname, "../../packages/broker/src/aws/developer-tasks.ts"));
  const functions = source.split(/^(?=(?:export )?(?:async )?function )/m);
  // Only reached from startTaskWorkflowPublicationFromSystem, which checks first.
  // startAutomaticFeedbackRound (Plan 6 Task 16) is reached only from startTaskWorkflowImplementationFromSystem, which runs creatorGuard before it.
  const CHECKED_BY_CALLER = ["startTaskWorkflowPullRequestUpdate", "startAutomaticFeedbackRound", "taskStopGuardedPaidDispatch"];

  it("finds the twenty-five acceptTask call sites and the pull request call sites, and every one is checked first", () => {
    const launching = functions.filter((chunk) => /deps\.actions\.(acceptTask|acceptPullRequest|acceptPullRequestUpdate)\(/.test(chunk));
    expect(launching.length).toBeGreaterThanOrEqual(9);
    // The eleventh is Plan 3 Task 32's system Continue after a spend approval (`resumeTaskAfterSpendApproval`); the twelfth is Task 34's start of a plan whose run
    // limit was approved (`resumeAfterRunLimitApproval`), which checks the creator first.
    // Plan 6 adds four, each checked first like the rest: the Understand step and the plan step after it (Task 4), the plan check and the plan's one revision (Task 8).
    // The nineteenth is Task 16's automatic feedback round (`startAutomaticFeedbackRound`), checked by its only caller.
    // Mainline #408 adds two, both checked first: the grounding of the plan against the current app (`startTaskWorkflowE2EGroundingFromSystem`) and the planner's one revision after the plan self-check (`startTaskWorkflowPlanRevisionFromSystem`).
    // Meta repo lane D adds one: the spec write (`startWrite` in spec-wiring.ts), reached from the publication and review gates and from an owner's choice on a held spec. It checks the creator at the launch itself.
    // Wiring D adds one: Re-plan after a spec change (`replanForSpecChange` in spec-replan.ts), checked through withCurrentThreadNotes before its launch.
    const recovery = functions.find(chunk => /function resumeTaskAfterSpendApproval\(/.test(chunk))!;
    expect(recovery.indexOf("creatorGuard(")).toBeGreaterThanOrEqual(0);
    expect(recovery.indexOf("creatorGuard(")).toBeLessThan(recovery.indexOf("taskStopGuardedPaidDispatch("));
    // Stop & redirect adds one: the planning restart (`restartPlanningForRedirect` in redirect-restart.ts), which launches inside withCurrentThreadNotes (that runs creatorGuard before every attempt).
    // M47 adds one forwarding seam that merges admitted source guards; its workflow callers retain creatorGuard.
    expect(source.match(/deps\.actions\.acceptTask\(/g)).toHaveLength(25);
    for (const chunk of launching) {
      const name = /function (\w+)/.exec(chunk)?.[1] ?? "?";
      if (CHECKED_BY_CALLER.includes(name)) continue;
      const guard = Math.min(...["creatorGuard(", "withCurrentThreadNotes("].map((marker) => (chunk.indexOf(marker) === -1 ? Infinity : chunk.indexOf(marker))));
      const launch = chunk.search(/deps\.actions\.(acceptTask|acceptPullRequest|acceptPullRequestUpdate)\(/);
      expect(guard, name).toBeLessThan(launch);
    }
  });

  it("pins the broker's own sites: acceptPullRequest, acceptPullRequestLifecycle, taskOperationParts, the credential exchange and both worker pull request callbacks (Minor 7)", () => {
    const broker = readBrokerSource();
    const guard = /requireWorkspaceCreatorStillMember\(|requireCreatorStillMember\(/;
    const section = (start: RegExp, end: RegExp) => {
      const from = broker.search(start);
      expect(from, String(start)).toBeGreaterThanOrEqual(0);
      const rest = broker.slice(from + 1);
      const length = rest.search(end);
      return broker.slice(from, length === -1 ? undefined : from + 1 + length);
    };
    const firstOf = (text: string, pattern: RegExp) => text.search(pattern);
    const functionOf = (name: string) => section(new RegExp(`^(?:export )?async function ${name}\\(`, "m"), /^(?:export )?(?:async )?function /m);
    const before = (text: string, later: RegExp, name: string) => {
      const checked = firstOf(text, guard);
      expect(checked, `${name} checks`).toBeGreaterThanOrEqual(0);
      expect(checked, `${name} checks before ${String(later)}`).toBeLessThan(firstOf(text, later));
    };
    before(functionOf("acceptPullRequest"), /requireOwnedWorkspace\(/, "acceptPullRequest");
    before(functionOf("acceptPullRequestLifecycle"), /requireOwnedWorkspace\(/, "acceptPullRequestLifecycle");
    before(functionOf("taskOperationParts"), /requireLatestProject\(/, "taskOperationParts");
    before(functionOf("exchangeRepositoryCredential"), /repositoryGrants\.exchange\(/, "exchangeRepositoryCredential");
    for (const action of ["pull-request", "pull-request-update"]) {
      const branch = section(new RegExp(`if \\(action === "${action}"\\) \\{`), /^ {2}if \(action === /m);
      before(branch, /reconcilePullRequest(Update)?\(/, `${action} callback`);
    }
  });
});

describe("requireCreatorStillMember", () => {
  const task = { taskId: "t1", developerId: "dev-1", developerName: "Dee Vee" } as never;
  const setup = () => {
    const db = new FakeDynamoDb();
    const store = new OrgStore({ documentClient: db, tableName: "state", now: () => Date.parse("2026-10-21T00:00:00.000Z") });
    return { db, store, deps: { documentClient: db, tableName: "state", orgId: TEST_ORG } };
  };

  it("lets a member's task through, and a person who never had a member record (a Slack user who has not signed in) too", async () => {
    const { db, store, deps } = setup();
    const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "owner" });
    await expect(requireCreatorStillMember({ ...deps, orgId }, task)).resolves.toBeUndefined();
    await store.addMember({ orgId, developerId: "dev-1", role: "member" });
    await expect(requireCreatorStillMember({ ...deps, orgId }, task)).resolves.toBeUndefined();
    expect(db.get(`DEVTASK#t1`, "META")).toBeUndefined();
  });

  it("refuses a removed member's task, then lets it through once an invite brings them back", async () => {
    const { store, deps } = setup();
    const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "owner" });
    await store.addMember({ orgId, developerId: "dev-1", role: "member" });
    await store.removeMember({ orgId, developerId: "dev-1", emails: [], ban: false });
    await expect(requireCreatorStillMember({ ...deps, orgId }, task)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED", message: expect.stringContaining("Dee Vee is no longer a member of Acme, so Rovara stopped this task.") as string });
    const { token } = await store.createInvite({ orgId, createdBy: "owner", role: "member" });
    await store.acceptInvite({ tokenHash: inviteTokenHash(token), developerId: "dev-1" });
    await expect(requireCreatorStillMember({ ...deps, orgId }, task)).resolves.toBeUndefined();
  });

  it("does nothing for a legacy task with no org and no org to read it in", async () => {
    const { db } = setup();
    await expect(requireCreatorStillMember({ documentClient: db, tableName: "state" }, task)).resolves.toBeUndefined();
  });
});
