// Release 0.4.17: an org owner or admin binds their own project to a Slack channel with the developer sign-in
// (`PUT|DELETE /v1/app/projects/{name}/slack-channel`). The admin bind (`PUT /v1/admin/slack/bindings/...`) keeps working as before.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  auditOperatorId, orgMetaKey, orgProjectCatalogKey, orgSlackTeamKey, projectMemberKey, projectMetaKey, projectRevisionKey, slackBindingKey, slackTeamOrgKey, developerOrgKey,
  type OrgId, type OrgRole, type ProjectRole,
} from "../../packages/contracts/src/index.js";
import { APP_CSRF_HEADER, appCsrfTokenFor } from "../../packages/broker/src/developer/app-csrf.js";
import { capturingAuditDeps, type AuditCapture } from "../support/audit-capture.js";
import { DEV_ISSUER, MAYA, OMAR, bindChannel, createDeveloperTaskBroker, seedMembership, unbindChannel, type Developer } from "../support/developer-task-broker.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, issuer as brokerIssuer, loadSlackBroker } from "../support/slack-broker.js";

beforeAll(loadSlackBroker, 60_000);

const OTHER_ORG: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const NEW_CHANNEL = "C0NEWCHAN01";
const KIT: Developer = { developerId: "4".repeat(64), name: "Kit Alvarez", provider: "oidc", sessionId: "s-kit" };
const BINDING = {
  deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0",
  subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3",
} as const;

type Harness = Awaited<ReturnType<typeof createDeveloperTaskBroker>>;
const bindRoute = (h: Harness, who: Developer, body: Record<string, unknown> = {}, project = "payments") =>
  h.dev(who, "PUT", `/v1/app/projects/${project}/slack-channel`, { requestId: randomUUID(), channelId: NEW_CHANNEL, ...body });
const unbindRoute = (h: Harness, who: Developer, body: Record<string, unknown> = {}, project = "payments") =>
  h.dev(who, "DELETE", `/v1/app/projects/${project}/slack-channel`, { requestId: randomUUID(), channelId: SLACK_CHANNEL, ...body });
const bindingOf = (h: Harness, channelId: string, orgId: OrgId = TEST_ORG) => h.db.get(slackBindingKey(orgId, SLACK_TEAM, channelId)) as Record<string, unknown> | undefined;
const sansRequestId = (body: Record<string, unknown>) => Object.fromEntries(Object.entries(body).filter(([key]) => key !== "requestId"));
const writes = (h: Harness) => h.db.commandNames().filter((name) => /Put|Update|Delete|TransactWrite/.test(name)).length;

function seedProject(db: FakeDynamoDb, name: string, orgId: OrgId = TEST_ORG) {
  db.set({
    ...projectRevisionKey(orgId, name, 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: BINDING,
    definition: { name, revision: 1, repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." },
  });
  db.set({ ...orgProjectCatalogKey(orgId, name), entityType: "PROJECT_CATALOG", name, latestRevision: 1, firstRegisteredAt: "2026-10-01T00:00:00.000Z" });
}

function addPerson(h: Harness, who: Developer, role: OrgRole, grant?: ProjectRole) {
  h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
  h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  seedMembership(h.db, who.developerId, { orgId: TEST_ORG, role });
  if (grant !== undefined) {
    h.db.set({ ...projectMemberKey(TEST_ORG, who.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: who.developerId, projectName: "payments", grantId: randomUUID(),
      role: grant === "viewer" ? "viewer" : "developer", projectRole: grant });
  }
}

async function world(options: { audit?: AuditCapture; slackTeamId?: string | null; cloud?: boolean } = {}) {
  const h = await createDeveloperTaskBroker({
    ...(options.audit === undefined ? {} : { audit: options.audit }),
    ...(options.slackTeamId === undefined ? {} : { slackTeamId: options.slackTeamId }),
    ...(options.cloud === true ? { brokerExtra: { cloud: true } } : {}),
  });
  seedProject(h.db, "billing");
  return h;
}

/** An org that has no Slack workspace connected: the state of a cloud org before an operator connects one (the harness's project registration bound the install's). */
function disconnectTeam(h: Harness) {
  h.db.delete(slackTeamOrgKey(SLACK_TEAM));
  h.db.delete(orgSlackTeamKey(TEST_ORG, SLACK_TEAM));
}

describe("the role table: who may bind and unbind a channel with a developer sign-in", () => {
  it("directs a company owner to browser approval and leaves the binding unchanged", async () => {
    const h = await world();seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });const before = writes(h);
    const answer = await bindRoute(h, OMAR);expect(answer.status).toBe(403);expect(answer.body.error).toMatchObject({ code: "FORBIDDEN", message: "Use the browser Slack approval flow to link a channel." });expect(writes(h)).toBe(before);expect(bindingOf(h, NEW_CHANNEL)).toBeUndefined();
  });

  it("refuses a company's admin bind but permits their named-workspace unbind", async () => {
    const h = await world();seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "admin" });
    expect((await bindRoute(h, OMAR, { teamId: SLACK_TEAM })).status).toBe(403);
    const removed = await unbindRoute(h, OMAR, { teamId: SLACK_TEAM });expect(removed.status).toBe(200);expect(removed.body).toMatchObject({ teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, removed: true });expect(bindingOf(h, SLACK_CHANNEL)).toBeUndefined();
  });

  it.each<[string, OrgRole, ProjectRole | undefined]>([
    ["a project maintainer who is only an org member", "member", "maintainer"],
    ["a project contributor", "member", "contributor"],
    ["a project viewer", "member", "viewer"],
  ])("refuses %s with 403 on both routes and writes nothing", async (_label, orgRole, grant) => {
    const h = await world();
    addPerson(h, KIT, orgRole, grant);
    const before = writes(h);
    for (const refused of [await bindRoute(h, KIT), await unbindRoute(h, KIT)]) {
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(refused.body.error).toMatchObject({ code: "FORBIDDEN", message: "only an organization owner or admin can bind a Slack channel to a project" });
    }
    expect(writes(h)).toBe(before);
    expect(bindingOf(h, NEW_CHANNEL)).toBeUndefined();
    expect(bindingOf(h, SLACK_CHANNEL)).toMatchObject({ projectName: "payments" });
  });

  it("refuses a plain org member who reaches the project only through its Slack channel (a contributor) with 403", async () => {
    const h = await world();
    const refused = await bindRoute(h, MAYA);
    expect(refused.status).toBe(403);
    expect(bindingOf(h, NEW_CHANNEL)).toBeUndefined();
  });

  it("answers 404 to a member who cannot see the project at all", async () => {
    const h = await world();
    addPerson(h, KIT, "member");
    const hidden = await bindRoute(h, KIT);
    expect(hidden.status).toBe(404);
    expect(hidden.body.error).toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("re-checks the role at write time: an owner who was demoted since their last call is refused with 403, not hidden by a 404", async () => {
    const h = await world();
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    await bindChannel(h.handler, NEW_CHANNEL);
    // Demoted to a member who still maintains the project through a grant: the project stays visible, so only the role check can refuse.
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "member" });
    h.db.set({ ...projectMemberKey(TEST_ORG, OMAR.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: OMAR.developerId, projectName: "payments", grantId: randomUUID(), role: "developer", projectRole: "maintainer" });
    for (const demoted of [await unbindRoute(h, OMAR, { channelId: NEW_CHANNEL }), await bindRoute(h, OMAR, { channelId: "C0ANOTHER01" })]) {
      expect(demoted.status, JSON.stringify(demoted.body)).toBe(403);
      expect(demoted.body.error).toMatchObject({ code: "FORBIDDEN" });
    }
    expect(bindingOf(h, NEW_CHANNEL)).toMatchObject({ projectName: "payments" });
    expect(bindingOf(h, "C0ANOTHER01")).toBeUndefined();
  });

  it("refuses an actor whose sign-in was revoked, or who left the org, with 401 and writes nothing", async () => {
    const h = await world();
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    const sessionKey = { pk: `SESSION#${OMAR.sessionId}`, sk: "META" };
    h.db.set({ ...h.db.get(sessionKey.pk, sessionKey.sk)!, revokedAt: new Date().toISOString() });
    const before = writes(h);
    expect((await bindRoute(h, OMAR)).status).toBe(401);
    h.db.set({ ...h.db.get(sessionKey.pk, sessionKey.sk)!, revokedAt: undefined });
    h.db.set({ ...h.db.get(`DEVELOPER#${OMAR.developerId}`, "META")!, revoked: true });
    expect((await bindRoute(h, OMAR)).status).toBe(401);
    h.db.set({ ...h.db.get(`DEVELOPER#${OMAR.developerId}`, "META")!, revoked: false });
    h.db.delete(developerOrgKey(OMAR.developerId));
    expect((await bindRoute(h, OMAR)).status).toBe(401);
    expect(writes(h)).toBe(before);
    expect(bindingOf(h, NEW_CHANNEL)).toBeUndefined();
  });

  it("never reaches another org's project of the same name: the second org's own payments is bound to nothing of the first org's", async () => {
    const h = await createDeveloperTaskBroker({ orgResolver: async ({ developerId }) => (developerId === OMAR.developerId ? OTHER_ORG : TEST_ORG) });
    seedMembership(h.db, OMAR.developerId, { orgId: OTHER_ORG, role: "owner" });
    // The second org has a project of the same name; it is visible to its owner, so a 404 cannot come from the name being unknown.
    seedProject(h.db, "payments", OTHER_ORG);
    expect((await h.dev(OMAR, "GET", "/v1/app/projects/payments")).status).toBe(200);
    // The install's Slack team belongs to the first org, so the second org's owner cannot bind a channel of it to their own payments.
    const crossed = await bindRoute(h, OMAR, { channelId: SLACK_CHANNEL });
    expect(crossed.status, JSON.stringify(crossed.body)).toBe(403);
    expect(crossed.body.error).toMatchObject({ code: "FORBIDDEN" });
    expect(h.db.get(orgSlackTeamKey(OTHER_ORG, SLACK_TEAM))).toBeUndefined();
    expect(bindingOf(h, SLACK_CHANNEL, TEST_ORG)).toMatchObject({ projectName: "payments" });
    expect(bindingOf(h, SLACK_CHANNEL, OTHER_ORG)).toBeUndefined();
    expect(h.db.get(slackTeamOrgKey(SLACK_TEAM))).toMatchObject({ orgId: TEST_ORG });
    // Nor can they unbind the first org's channel through their own project of that name.
    const unbound = await unbindRoute(h, OMAR, { channelId: SLACK_CHANNEL });
    expect(unbound.status).toBe(200);
    expect(unbound.body).toMatchObject({ removed: false });
    expect(bindingOf(h, SLACK_CHANNEL, TEST_ORG)).toMatchObject({ projectName: "payments" });
  });
});

describe("what the route checks about the Slack team and the channel", () => {
  it("refuses an unbind from an unconnected team before anything is written", async () => {
    const h = await world();
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    const before = writes(h);
    const wrong = await unbindRoute(h, OMAR, { teamId: "T0OTHERTEAM" });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toMatchObject({ code: "SLACK_TEAM_NOT_BOUND" });
    expect(writes(h)).toBe(before);
    expect(h.db.get(slackTeamOrgKey("T0OTHERTEAM"))).toBeUndefined();
  });

  it("refuses the install's Slack team when another org already holds it (SLACK_TEAM_TAKEN)", async () => {
    const h = await world();
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    h.db.set({ ...slackTeamOrgKey(SLACK_TEAM), entityType: "SLACK_TEAM_ORG", orgId: OTHER_ORG, boundAt: "x" });
    const taken = await bindRoute(h, OMAR);
    expect(taken.status).toBe(403);
    expect(taken.body.error).toMatchObject({ code: "FORBIDDEN" });
    expect(bindingOf(h, NEW_CHANNEL)).toBeUndefined();
  });

  it("says Slack is not connected when the org has no Slack team and the install names none", async () => {
    const h = await world({ slackTeamId: null });
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    disconnectTeam(h);
    const none = await unbindRoute(h, OMAR);
    expect(none.status).toBe(403);
    expect(none.body.error).toMatchObject({ code: "SLACK_TEAM_NOT_BOUND" });
  });

  it.each([
    ["a lowercase channel id", { channelId: "c0newchan01" }],
    ["a user id", { channelId: "U0123456789" }],
    ["a too-short channel id", { channelId: "C1" }],
    ["no channel", { channelId: undefined }],
    ["a bad team id", { teamId: "slack-team" }],
    ["an unknown field", { projectName: "billing" }],
    ["a request id that is not a uuid", { requestId: "not-a-uuid" }],
  ])("refuses %s with CONFIG_INVALID and writes nothing", async (_label, extra) => {
    const h = await world();
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    const before = writes(h);
    const bad = await unbindRoute(h, OMAR, extra);
    expect(bad.status, JSON.stringify(bad.body)).toBe(400);
    expect(bad.body.error).toMatchObject({ code: "CONFIG_INVALID" });
    expect(writes(h)).toBe(before);
  });

  it("refuses a channel that is bound to another project, names it, and leaves that binding as it was", async () => {
    const h = await world();
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    const taken = await bindRoute(h, OMAR, { channelId: SLACK_CHANNEL }, "billing");
    expect(taken.status).toBe(403);
    expect(taken.body.error).toMatchObject({ code: "FORBIDDEN" });
    expect(String((taken.body.error as { message: string }).message)).not.toContain("payments");
    expect(bindingOf(h, SLACK_CHANNEL)).toMatchObject({ projectName: "payments" });
    // Unbinding it from the wrong project is refused the same way.
    const wrongProject = await unbindRoute(h, OMAR, { channelId: SLACK_CHANNEL }, "billing");
    expect(wrongProject.status).toBe(400);
    expect(bindingOf(h, SLACK_CHANNEL)).toMatchObject({ projectName: "payments" });
  });

  it("treats binding a channel to the project it is already bound to as no change, and unbinding an unbound channel as nothing to remove", async () => {
    const h = await world();
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    const again = await bindRoute(h, OMAR, { channelId: SLACK_CHANNEL });
    expect(again.status).toBe(403);
    expect(again.body.error).toMatchObject({ code: "FORBIDDEN" });
    const nothing = await unbindRoute(h, OMAR, { channelId: NEW_CHANNEL });
    expect(nothing.status).toBe(200);
    expect(nothing.body).toMatchObject({ channelId: NEW_CHANNEL, removed: false });
  });
});

describe("which Slack workspace an org may bind from: the cloud guard", () => {
  const admin = { subject: "admin-subject", admin: true };
  const connect = (h: Harness, teamId: string, body: unknown, user: { subject: string; admin?: boolean } = admin) =>
    call(h.handler, { method: "PUT", path: `/v1/admin/slack/teams/${teamId}`, user, body });

  it("on a cloud install an org owner cannot take the install's own Slack workspace, named or not, and no org holds it afterwards", async () => {
    const h = await world({ cloud: true });
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    disconnectTeam(h);
    const before = writes(h);
    for (const refused of [await bindRoute(h, OMAR), await bindRoute(h, OMAR, { teamId: SLACK_TEAM })]) {
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(refused.body.error).toMatchObject({ code: "FORBIDDEN" });
    }
    expect(writes(h)).toBe(before);
    expect(h.db.get(slackTeamOrgKey(SLACK_TEAM))).toBeUndefined();
    expect(h.db.get(orgSlackTeamKey(TEST_ORG, SLACK_TEAM))).toBeUndefined();
    expect(bindingOf(h, NEW_CHANNEL)).toBeUndefined();
  });

  it("uses fixed browser-approval copy for named and unnamed disconnected workspaces", async () => {
    const h = await world({ cloud: true });seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });disconnectTeam(h);
    for (const body of [{}, { teamId: SLACK_TEAM }]) expect((await bindRoute(h, OMAR, body)).body.error).toEqual({ code: "FORBIDDEN", message: "Use the browser Slack approval flow to link a channel." });
  });

  it("a private-install bearer cannot claim the install's workspace through a project bind", async () => {
    const h = await world();seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });disconnectTeam(h);
    expect((await bindRoute(h, OMAR)).status).toBe(403);expect(h.db.get(slackTeamOrgKey(SLACK_TEAM))).toBeUndefined();
  });

  it("an operator connects the workspace to the org; then the owner binds on the cloud install, with or without naming the team", async () => {
    const h = await world({ cloud: true });
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    disconnectTeam(h);
    const connected = await connect(h, SLACK_TEAM, { orgId: TEST_ORG });
    expect(connected.status, JSON.stringify(connected.body)).toBe(200);
    expect(connected.body).toMatchObject({ teamId: SLACK_TEAM, orgId: TEST_ORG });
    expect(h.db.get(slackTeamOrgKey(SLACK_TEAM))).toMatchObject({ orgId: TEST_ORG });
    expect((await bindRoute(h, OMAR)).status).toBe(403);
    expect((await bindRoute(h, OMAR, { teamId: SLACK_TEAM, channelId: "C0NAMEDTEAM1" })).status).toBe(403);
    // Repeating it changes nothing.
    expect((await connect(h, SLACK_TEAM, { orgId: TEST_ORG })).status).toBe(200);
  });

  it("only an operator connects a workspace: an org owner's developer token, or a non-admin identity, is refused and nothing is written", async () => {
    const h = await world({ cloud: true });
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    disconnectTeam(h);
    const before = writes(h);
    expect((await connect(h, SLACK_TEAM, { orgId: TEST_ORG }, { subject: "someone" })).status).toBe(403);
    expect([401, 403]).toContain((await h.dev(OMAR, "PUT", `/v1/admin/slack/teams/${SLACK_TEAM}`, { orgId: TEST_ORG })).status);
    expect(writes(h)).toBe(before);
    expect(h.db.get(slackTeamOrgKey(SLACK_TEAM))).toBeUndefined();
  });

  it("refuses an unknown org, a bad id, and a workspace another org holds (SLACK_TEAM_TAKEN)", async () => {
    const h = await world({ cloud: true });
    disconnectTeam(h);
    expect((await connect(h, SLACK_TEAM, { orgId: OTHER_ORG })).status).toBe(404);
    expect((await connect(h, "bad", { orgId: TEST_ORG })).status).toBe(400);
    expect((await connect(h, SLACK_TEAM, { orgId: "nope" })).status).toBe(400);
    expect((await connect(h, SLACK_TEAM, {})).status).toBe(400);
    seedMembership(h.db, KIT.developerId, { orgId: OTHER_ORG, role: "owner" });
    h.db.set({ ...slackTeamOrgKey(SLACK_TEAM), entityType: "SLACK_TEAM_ORG", orgId: OTHER_ORG, boundAt: "x" });
    const taken = await connect(h, SLACK_TEAM, { orgId: TEST_ORG });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toMatchObject({ code: "SLACK_TEAM_TAKEN" });
    expect(h.db.get(slackTeamOrgKey(SLACK_TEAM))).toMatchObject({ orgId: OTHER_ORG });
  });
});

describe("the operator's connect and disconnect of a Slack workspace, and closed orgs", () => {
  const admin = { subject: "admin-subject", admin: true };
  const OPERATOR = auditOperatorId(brokerIssuer, admin.subject);
  const connect = (h: Harness, body: unknown = { orgId: TEST_ORG }, user: { subject: string; admin?: boolean } = admin) =>
    call(h.handler, { method: "PUT", path: `/v1/admin/slack/teams/${SLACK_TEAM}`, user, body });
  const disconnect = (h: Harness, user: { subject: string; admin?: boolean } = admin) =>
    call(h.handler, { method: "DELETE", path: `/v1/admin/slack/teams/${SLACK_TEAM}`, user });
  const setMeta = (h: Harness, fields: Record<string, unknown>) => h.db.set({ ...h.db.get(orgMetaKey(TEST_ORG).pk, orgMetaKey(TEST_ORG).sk)!, ...fields });

  it.each([["closed", { closedAt: "2026-10-27T00:00:00.000Z" }], ["closing", { closingAt: "2026-10-27T00:00:00.000Z" }]])("refuses to connect a workspace to an org that is %s, and writes no link", async (_label, fields) => {
    const h = await world({ cloud: true });
    disconnectTeam(h);
    setMeta(h, fields);
    const refused = await connect(h);
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(refused.body.error).toMatchObject({ code: "CONFIG_INVALID", message: "that organization has closed" });
    expect(h.db.get(slackTeamOrgKey(SLACK_TEAM))).toBeUndefined();
    expect(h.db.get(orgSlackTeamKey(TEST_ORG, SLACK_TEAM))).toBeUndefined();
  });

  it("refuses the owner's own bind from claiming the install's workspace for an org that is closing", async () => {
    const h = await world();
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    disconnectTeam(h);
    setMeta(h, { closingAt: "2026-10-27T00:00:00.000Z" });
    const refused = await bindRoute(h, OMAR);
    expect(refused.status).toBe(403);
    expect(h.db.get(slackTeamOrgKey(SLACK_TEAM))).toBeUndefined();
    expect(bindingOf(h, NEW_CHANNEL)).toBeUndefined();
  });

  it("audits a connection in the target org's ledger, naming the operator by a pseudonymous id, and records nothing for a repeat", async () => {
    const audit = capturingAuditDeps();
    const h = await world({ cloud: true, audit });
    disconnectTeam(h);
    expect((await connect(h)).status).toBe(200);
    expect((await connect(h)).status).toBe(200);
    expect(audit.recordedBy("slack_team.connected")).toEqual([expect.objectContaining({
      orgId: TEST_ORG, action: "slack_team.connected", actor: { kind: "operator", id: OPERATOR }, target: { kind: "org", id: TEST_ORG }, related: [SLACK_TEAM],
    })]);
    expect(JSON.stringify(audit.recordedBy("slack_team.connected"))).not.toContain(admin.subject);
    expect(audit.pending()).toEqual([]);
  });

  it("refuses to disconnect a workspace whose org still has channels bound, naming how to unbind them, and removes nothing", async () => {
    const h = await world({ cloud: true });
    const refused = await disconnect(h);
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(refused.body.error).toMatchObject({ code: "CONFIG_INVALID" });
    const message = (refused.body.error as { message: string }).message;
    expect(message).toContain(SLACK_CHANNEL);
    expect(message).toContain("slack unbind --channel");
    expect(h.db.get(slackTeamOrgKey(SLACK_TEAM))).toMatchObject({ orgId: TEST_ORG });
    expect(h.db.get(orgSlackTeamKey(TEST_ORG, SLACK_TEAM))).toBeDefined();
    expect(bindingOf(h, SLACK_CHANNEL)).toMatchObject({ projectName: "payments" });
  });

  it("disconnects a workspace with no channels bound, audits it, and the org can no longer bind from it on a cloud install", async () => {
    const audit = capturingAuditDeps();
    const h = await world({ cloud: true, audit });
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    expect((await unbindRoute(h, OMAR, { channelId: SLACK_CHANNEL })).body).toMatchObject({ removed: true });
    const done = await disconnect(h);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ teamId: SLACK_TEAM, orgId: TEST_ORG });
    expect(h.db.get(slackTeamOrgKey(SLACK_TEAM))).toBeUndefined();
    expect(h.db.get(orgSlackTeamKey(TEST_ORG, SLACK_TEAM))).toBeUndefined();
    expect(audit.recordedBy("slack_team.disconnected")).toEqual([expect.objectContaining({
      orgId: TEST_ORG, action: "slack_team.disconnected", actor: { kind: "operator", id: OPERATOR }, target: { kind: "org", id: TEST_ORG }, related: [SLACK_TEAM],
    })]);
    expect((await bindRoute(h, OMAR)).body.error).toMatchObject({ code: "FORBIDDEN" });
    // A second disconnect finds nothing to remove and records nothing.
    expect((await disconnect(h)).status).toBe(404);
    expect(audit.recordedBy("slack_team.disconnected")).toHaveLength(1);
  });

  it("only an operator disconnects, and the developer token of an org owner is refused", async () => {
    const h = await world({ cloud: true });
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    await unbindRoute(h, OMAR, { channelId: SLACK_CHANNEL });
    expect((await disconnect(h, { subject: "someone" })).status).toBe(403);
    expect([401, 403]).toContain((await h.dev(OMAR, "DELETE", `/v1/admin/slack/teams/${SLACK_TEAM}`)).status);
    expect(h.db.get(slackTeamOrgKey(SLACK_TEAM))).toMatchObject({ orgId: TEST_ORG });
  });
});

describe("an archived project", () => {
  it("takes no new channel, but its channels can still be unbound", async () => {
    const h = await world();
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    h.db.set({ ...projectMetaKey(TEST_ORG, "payments"), entityType: "PROJECT_META", name: "payments", status: "archived", createdAt: "x", createdBy: "y" });
    const refused = await bindRoute(h, OMAR);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "FORBIDDEN" });
    expect(bindingOf(h, NEW_CHANNEL)).toBeUndefined();
    expect((await unbindRoute(h, OMAR, { channelId: SLACK_CHANNEL })).body).toMatchObject({ removed: true });
  });
});

describe("CSRF and Origin on the browser path", () => {
  const SID = "11111111-1111-4111-8111-111111111111";
  const COOKIE = `__Host-agentx_review_session=${SID}`;
  const ORIGIN = new URL(DEV_ISSUER).origin;

  async function browserWorld() {
    const h = await world();
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    h.db.set({ pk: `SESSION#${SID}`, sk: "META", sessionId: SID, developerId: OMAR.developerId, amr: "oidc", startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 3600, reviewExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
    const call = async (method: string, headers: Record<string, string>, body: unknown = { requestId: randomUUID(), channelId: NEW_CHANNEL }) => {
      const response = await h.handler({
        version: "2.0", rawPath: "/v1/web/projects/payments/slack-channel", rawQueryString: "", routeKey: "ANY /v1/web/{proxy+}", headers,
        body: JSON.stringify(body), requestContext: { requestId: randomUUID(), http: { method } },
      });
      return { status: response.statusCode, body: JSON.parse(response.body) as { error?: { code: string; message: string } } };
    };
    return { h, call };
  }

  it("holds the legacy cookie route for missing, foreign and stale Origin/CSRF combinations", async () => {
    const { h, call } = await browserWorld();
    const csrf = appCsrfTokenFor(SID);
    for (const method of ["PUT", "DELETE"]) {
      const before = writes(h);
      for (const headers of [{}, { origin: ORIGIN }, { [APP_CSRF_HEADER]: csrf }, { origin: "null", [APP_CSRF_HEADER]: csrf }, { origin: "https://evil.example", [APP_CSRF_HEADER]: csrf }]) {
        const refused = await call(method, { cookie: COOKIE, ...headers });
        expect(refused.status, JSON.stringify(headers)).toBe(404);
        expect(refused.body.error?.code).toBe("NOT_FOUND");
      }
      const stale = await call(method, { cookie: COOKIE, origin: ORIGIN, [APP_CSRF_HEADER]: appCsrfTokenFor("old-session") });
      expect(stale.status).toBe(404);
      expect(stale.body.error?.code).toBe("NOT_FOUND");
      expect(writes(h)).toBe(before);
    }
    expect(bindingOf(h, NEW_CHANNEL)).toBeUndefined();
  });

  it("holds legacy cookie binding writes before reads even with valid Origin and CSRF", async () => {
    const { h, call } = await browserWorld();const before = structuredClone(h.db.find(() => true)), reads = h.db.commandNames().length;
    const headers = { cookie: COOKIE, origin: ORIGIN, [APP_CSRF_HEADER]: appCsrfTokenFor(SID) };
    for (const method of ["PUT", "DELETE"]) { const response = await call(method, headers);expect(response.status).toBe(404); }
    expect(h.db.find(() => true)).toEqual(before);expect(h.db.commandNames()).toHaveLength(reads);
  });
});

describe("the audit record", () => {
  type Tx = Array<{ Put?: { Item?: Record<string, unknown> }; Update?: { Key?: Record<string, unknown> }; Delete?: { Key?: Record<string, unknown> } }>;
  function recordTransactions(h: Harness): Tx[] {
    const seen: Tx[] = [];
    const original = h.db.send.bind(h.db) as (command: unknown) => Promise<unknown>;
    (h.db as unknown as { send: (command: unknown) => Promise<unknown> }).send = async (command: unknown) => {
      if ((command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") seen.push((command as { input: { TransactItems: Tx } }).input.TransactItems);
      return original(command);
    };
    return seen;
  }
  const isPending = (item: Tx[number]) => String(item.Put?.Item?.pk).startsWith("AUDIT_PENDING#");

  it("the operator writes the canonical binding and operator audit in one transaction", async () => {
    const audit = capturingAuditDeps(), h = await world({ audit }), seen = recordTransactions(h);
    await bindChannel(h.handler, NEW_CHANNEL);
    const audited = seen.filter(transaction => transaction.some(isPending));expect(audited).toHaveLength(2);
    expect(audited.filter(transaction => transaction.some(item => item.Put?.Item?.entityType === "TASK_STOP_SEED"))).toHaveLength(1);
    expect(audited.filter(transaction => transaction.some(item => item.Put?.Item?.entityType === "SLACK_BINDING"))).toHaveLength(1);
    expect(audit.recordedBy("slack_channel.bound").filter(event => event.related?.includes(NEW_CHANNEL))).toMatchObject([{ orgId: TEST_ORG, actor: { kind: "operator" }, target: { kind: "project", name: "payments" } }]);expect(audit.pending()).toEqual([]);
  });

  it("writes the direct unbind audit, and none for a refused bind or unbind no-op", async () => {
    const audit = capturingAuditDeps(), h = await world({ audit });seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "admin" });
    await bindChannel(h.handler, NEW_CHANNEL);const boundCount = audit.recordedBy("slack_channel.bound").length;
    expect((await bindRoute(h, OMAR)).status).toBe(403);await unbindRoute(h, OMAR, { channelId: "C0NEVERBOUND" });
    expect(audit.recordedBy("slack_channel.unbound")).toHaveLength(0);await unbindRoute(h, OMAR, { channelId: NEW_CHANNEL });
    expect(audit.recordedBy("slack_channel.bound")).toHaveLength(boundCount);expect(audit.recordedBy("slack_channel.unbound")).toMatchObject([{ actor: { kind: "member", id: OMAR.developerId }, related: [SLACK_TEAM, NEW_CHANNEL] }]);
  });

  it("carries no personal data in an event: the project is a name-keyed target and the Slack ids are related ids", async () => {
    const audit = capturingAuditDeps();
    const h = await world({ audit });
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    await bindChannel(h.handler, NEW_CHANNEL);
    const [event] = audit.recordedBy("slack_channel.bound");
    expect(event).toBeDefined();
    expect(event!.facts).toBeUndefined();
    expect(event!.details).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain(OMAR.name);
  });
});

describe("replay", () => {
  it("repeated legacy bind requests stay refused and cannot recreate an unlinked channel", async () => {
    const audit = capturingAuditDeps(), h = await world({ audit });seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    const requestId = randomUUID(), before = writes(h), count = audit.recordedBy("slack_channel.bound").length;
    for (let n = 0; n < 2; n++) expect((await bindRoute(h, OMAR, { requestId })).status).toBe(403);
    expect(bindingOf(h, NEW_CHANNEL)).toBeUndefined();expect(writes(h)).toBe(before);expect(audit.recordedBy("slack_channel.bound")).toHaveLength(count);
  });

  it("refuses an unbind UUID reused for another channel or person; bind stays forbidden", async () => {
    const h = await world();seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });addPerson(h, KIT, "admin");const requestId = randomUUID();
    expect((await unbindRoute(h, OMAR, { requestId })).status).toBe(200);
    for (const reused of [await unbindRoute(h, OMAR, { requestId, channelId: NEW_CHANNEL }), await unbindRoute(h, KIT, { requestId })]) expect(reused.body.error).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await bindRoute(h, OMAR, { requestId })).status).toBe(403);expect(bindingOf(h, NEW_CHANNEL)).toBeUndefined();
  });

  it("replays an unbind the same way", async () => {
    const audit = capturingAuditDeps();
    const h = await world({ audit });
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    await bindChannel(h.handler, NEW_CHANNEL);
    const requestId = randomUUID();
    const first = await unbindRoute(h, OMAR, { requestId, channelId: NEW_CHANNEL });
    const second = await unbindRoute(h, OMAR, { requestId, channelId: NEW_CHANNEL });
    expect(sansRequestId(second.body)).toEqual(sansRequestId(first.body));
    expect(first.body).toMatchObject({ removed: true });
    expect(audit.recordedBy("slack_channel.unbound")).toHaveLength(1);
  });
});

describe("the admin bind keeps working as before", () => {
  it("binds and unbinds with the admin sign-in, writes the same item, and the developer route sees it", async () => {
    const h = await world();
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    await bindChannel(h.handler, "C0ADMINBIND1", "payments");
    expect(bindingOf(h, "C0ADMINBIND1")).toMatchObject({ entityType: "SLACK_BINDING", teamId: SLACK_TEAM, channelId: "C0ADMINBIND1", projectName: "payments" });
    expect(bindingOf(h, "C0ADMINBIND1")!.updatedBy).toEqual(expect.any(String));
    // The developer route will not take a channel the admin bound to another project, and can unbind it from the project it belongs to.
    expect((await bindRoute(h, OMAR, { channelId: "C0ADMINBIND1" }, "billing")).status).toBe(403);
    expect((await unbindRoute(h, OMAR, { channelId: "C0ADMINBIND1" }, "billing")).status).toBe(400);
    expect((await unbindRoute(h, OMAR, { channelId: "C0ADMINBIND1" }, "payments")).status).toBe(200);
    expect(bindingOf(h, "C0ADMINBIND1")).toBeUndefined();
    await bindChannel(h.handler, "C0ADMINBIND2", "payments");
    await unbindChannel(h.handler, "C0ADMINBIND2");
    expect(bindingOf(h, "C0ADMINBIND2")).toBeUndefined();
  });
});
it("B34 owner release refuses company bearer bind but preserves direct unbind", async () => {
 const h = await world({ audit: capturingAuditDeps() });seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
 const before = bindingOf(h, NEW_CHANNEL);const linked = await bindRoute(h, OMAR);expect(linked.status).toBe(403);expect(linked.body.error).toMatchObject({ code: "FORBIDDEN", message: "Use the browser Slack approval flow to link a channel." });expect(bindingOf(h, NEW_CHANNEL)).toEqual(before);
 const unlinked = await unbindRoute(h, OMAR);expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(200);expect(bindingOf(h, SLACK_CHANNEL)).toBeUndefined();
});
it("B34 operator support bind and unbind are each audited as operator actions in the company", async () => {
 const audit = capturingAuditDeps(), h = await world({ audit });const user = { subject: "admin-subject", admin: true };
 const bound = await call(h.handler, { method: "PUT", path: `/v1/admin/slack/bindings/${SLACK_TEAM}/${NEW_CHANNEL}`, user, body: { projectName: "payments" } });expect(bound.status, JSON.stringify(bound.body)).toBe(200);
 expect(audit.recordedBy("slack_channel.bound").filter(event => event.related?.includes(NEW_CHANNEL))).toMatchObject([{ orgId: TEST_ORG, actor: { kind: "operator" }, target: { kind: "project", name: "payments" } }]);
 const removed = await call(h.handler, { method: "DELETE", path: `/v1/admin/slack/bindings/${SLACK_TEAM}/${NEW_CHANNEL}`, user });expect(removed.status).toBe(200);expect(audit.recordedBy("slack_channel.unbound")).toMatchObject([{ orgId: TEST_ORG, actor: { kind: "operator" } }]);
});
it("B34 operator mutations fail closed without an audit ledger and preserve historical bindings", async () => {
 const h = await world(), before = bindingOf(h, SLACK_CHANNEL), count = writes(h), user = { subject: "admin-subject", admin: true };
 const put = await call(h.handler, { method: "PUT", path: `/v1/admin/slack/bindings/${SLACK_TEAM}/${NEW_CHANNEL}`, user, body: { projectName: "payments" } });expect(put.body.error).toMatchObject({ code: "AUDIT_UNAVAILABLE" });
 const remove = await call(h.handler, { method: "DELETE", path: `/v1/admin/slack/bindings/${SLACK_TEAM}/${SLACK_CHANNEL}`, user });expect(remove.body.error).toMatchObject({ code: "AUDIT_UNAVAILABLE" });
 expect(bindingOf(h, NEW_CHANNEL)).toBeUndefined();expect(bindingOf(h, SLACK_CHANNEL)).toEqual(before);expect(writes(h)).toBe(count);
});
it("B34 operator bind and unbind audits reach the company's admin reader only", async () => {
 const audit = capturingAuditDeps(), h = await world({ audit }), user = { subject: "admin-subject", admin: true };
 expect((await call(h.handler, { method: "PUT", path: `/v1/admin/slack/bindings/${SLACK_TEAM}/${NEW_CHANNEL}`, user, body: { projectName: "payments" } })).status).toBe(200);
 expect((await call(h.handler, { method: "DELETE", path: `/v1/admin/slack/bindings/${SLACK_TEAM}/${NEW_CHANNEL}`, user })).status).toBe(200);
 const { bench } = await import("../support/audit-routes-bench.js"), { appendEvent } = await import("../../packages/broker/src/audit/appender.js"), { routeAuditRequest } = await import("../../packages/broker/src/audit/routes.js");
 const ledger = bench();ledger.h.clock.now = Date.now();
 for (const event of audit.recorded().filter(event => event.related?.includes(NEW_CHANNEL))) expect(await appendEvent(ledger.appender, event)).toMatchObject({ result: "appended" });
 const read = (orgId: string) => routeAuditRequest(ledger.deps, { orgId, developerId: OMAR.developerId, orgRole: "admin" }, { method: "GET", body: {}, requestId: randomUUID() }, new URL("https://test.invalid/v1/app/org/audit/records"));
 const own = await read(TEST_ORG);expect(own.status).toBe(200);expect((own.body as { records: Array<{ record: unknown }> }).records.map(row => row.record)).toMatchObject([{ orgId: TEST_ORG, action: "slack_channel.bound", actor: { kind: "operator" } }, { orgId: TEST_ORG, action: "slack_channel.unbound", actor: { kind: "operator" } }]);
 expect((await read(OTHER_ORG)).body).toMatchObject({ records: [] });
});
for (const method of ["PUT", "DELETE"] as const) it(`B34 operator ${method} observed-binding race rolls back its audit without retry`, async () => {
 const audit = capturingAuditDeps(), h = await world({ audit }), channel = method === "PUT" ? NEW_CHANNEL : SLACK_CHANNEL, before = audit.recorded().length, send = h.db.send.bind(h.db);let attempts = 0;
 h.db.send = async command => {
  const items = (command as { input?: { TransactItems?: Array<{ Put?: { Item?: Record<string, unknown> }; Delete?: { Key?: Record<string, unknown> } }> } }).input?.TransactItems;
  if (items?.some(item => item.Put?.Item?.entityType === "SLACK_BINDING" || item.Delete?.Key?.sk === `CHANNEL#${channel}`)) {
   attempts++;h.db.set({ ...slackBindingKey(TEST_ORG, SLACK_TEAM, channel), entityType: "SLACK_BINDING", teamId: SLACK_TEAM, channelId: channel, projectName: "billing", updatedAt: "2026-10-30T09:05:00Z" });
  }
  return send(command);
 };
 const reply = await call(h.handler, { method, path: `/v1/admin/slack/bindings/${SLACK_TEAM}/${channel}`, user: { subject: "admin-subject", admin: true }, ...(method === "PUT" ? { body: { projectName: "payments" } } : {}) });
 expect(reply.status).not.toBe(200);expect(attempts).toBe(1);expect(bindingOf(h, channel)).toMatchObject({ projectName: "billing" });expect(audit.recorded()).toHaveLength(before);expect(audit.pending()).toHaveLength(0);
});
