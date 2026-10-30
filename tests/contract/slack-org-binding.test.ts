// Task 4: a Slack team resolves to the org that bound it before any channel binding is read, and the
// binding, the limit counters and the project all stay inside that org.
import { createHmac, randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { slackBindingKey, slackBindingPk, slackLimitPk, slackOrganizationLimitKey, slackMemberLimitKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { slackTeamOrgKey, singleOrgIdForEnv, type OrgId } from "../../packages/contracts/src/org-node.js";
import { createSlackIngressHandler } from "../../packages/broker/src/aws/slack-ingress.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { resolveSlackOrg, resolveSlackOrgForInstall, type OrgResolver } from "../../packages/broker/src/org/resolve.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ENV, TEST_ORG } from "../support/orgs.js";
import {
  SLACK_CHANNEL, SLACK_TEAM, call, createAuditedSlackBroker as createBroker, ensureWorkspace, issuer, loadSlackBroker, registerSlackProject,
} from "../support/slack-broker.js";

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const PRATIK = "U0123456789";
const T1 = "T0TEAMAAAA1";
const T9 = "T0UNBOUND01";
const C1 = "C0000000001";
const C2 = "C0000000002";
const C3 = "C0000000003";

beforeAll(async () => { await loadSlackBroker(); });
beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => undefined); });
afterEach(() => vi.restoreAllMocks());

const store = (db: FakeDynamoDb) => new OrgStore({ documentClient: db, tableName: "state", now: () => 1_758_657_600_000 });
const binding = (teamId: string, channelId: string, projectName: string) =>
  ({ teamId, channelId, projectName, entityType: "SLACK_BINDING", updatedAt: "2026-09-23T21:00:00.000Z" });

describe("resolveSlackOrg", () => {
  it("answers the org that bound the team, and refuses an unbound team with SLACK_TEAM_NOT_BOUND", async () => {
    const db = new FakeDynamoDb();
    await store(db).bindSlackTeam({ orgId: ORG_A, teamId: "T1" });
    expect(await resolveSlackOrg(store(db), "T1")).toBe(ORG_A);
    await expect(resolveSlackOrg(store(db), "T9")).rejects.toMatchObject({ code: "SLACK_TEAM_NOT_BOUND" });
  });

  it("binds only a single-org install's own configured team, lazily, and creates the org", async () => {
    const db = new FakeDynamoDb();
    const install = { orgId: singleOrgIdForEnv("staging"), name: "staging", slackTeamId: "T1" };
    expect(await resolveSlackOrgForInstall(store(db), "T1", install)).toBe(install.orgId);
    expect(db.get(slackTeamOrgKey("T1").pk, "ORG")).toMatchObject({ orgId: install.orgId });
    expect(db.get(`ORG#${install.orgId}`, "META")).toMatchObject({ name: "staging" });
    await expect(resolveSlackOrgForInstall(store(db), "T9", install)).rejects.toMatchObject({ code: "SLACK_TEAM_NOT_BOUND" });
    expect(db.get(slackTeamOrgKey("T9").pk, "ORG")).toBeUndefined();
    // An install with its own resolver, or with no configured team, never binds lazily.
    await expect(resolveSlackOrgForInstall(store(db), "T2", undefined)).rejects.toMatchObject({ code: "SLACK_TEAM_NOT_BOUND" });
    await expect(resolveSlackOrgForInstall(store(db), "T2", { ...install, slackTeamId: undefined })).rejects.toMatchObject({ code: "SLACK_TEAM_NOT_BOUND" });
  });
});

describe("the Slack ingress", () => {
  const signingSecret = "8f742231b10e8888abcd99yyyzzz85a5";
  const nowSeconds = 1_758_657_600;
  const bot = "U0BOT000001";

  function wired() {
    const db = new FakeDynamoDb();
    const queue: unknown[] = [];
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const lookups: Array<{ orgId: OrgId; teamId: string; channelId: string }> = [];
    const handler = createSlackIngressHandler({
      secrets: async () => ({ signingSecret, botToken: "xoxb-test" }),
      // The same lookups the AWS wiring makes: the team's org first, then the binding inside that org.
      resolveOrg: (teamId) => resolveSlackOrg(store(db), teamId),
      getBinding: async (orgId, teamId, channelId) => {
        lookups.push({ orgId, teamId, channelId });
        const key = slackBindingKey(orgId, teamId, channelId);
        const item = db.get(key.pk, key.sk);
        return item === undefined ? undefined : { teamId, channelId, projectName: String(item.projectName), updatedAt: String(item.updatedAt) };
      },
      claimEvent: async () => true,
      releaseEvent: async () => undefined,
      changePending: async () => 1,
      enqueue: async (message) => { queue.push(message); },
      postMessage: async () => undefined,
      now: () => nowSeconds * 1_000,
      log: (event, fields) => logs.push({ event, fields }),
    });
    const send = async (teamId: string, channelId: string) => {
      const body = JSON.stringify({
        type: "event_callback", team_id: teamId, event_id: `Ev${randomUUID().slice(0, 8)}`,
        authorizations: [{ team_id: teamId, user_id: bot, is_bot: true }],
        event: { type: "app_mention", user: PRATIK, team: teamId, channel: channelId, ts: "1695500000.000001", text: `<@${bot}> fix the navigation bug` },
      });
      const signature = `v0=${createHmac("sha256", signingSecret).update(`v0:${nowSeconds}:${body}`).digest("hex")}`;
      return handler({
        version: "2.0", rawPath: "/v1/slack/events", body, isBase64Encoded: false,
        headers: { "X-Slack-Request-Timestamp": String(nowSeconds), "X-Slack-Signature": signature },
        requestContext: { requestId: "request", http: { method: "POST" } },
      });
    };
    return { db, queue, logs, lookups, send };
  }

  it("routes an event from a bound team to the channel's binding in that team's org", async () => {
    const { db, queue, lookups, send } = wired();
    await store(db).bindSlackTeam({ orgId: ORG_A, teamId: T1 });
    db.set({ ...slackBindingKey(ORG_A, T1, C1), ...binding(T1, C1, "web") });
    expect((await send(T1, C1)).statusCode).toBe(200);
    expect(queue).toHaveLength(1);
    expect(lookups).toEqual([{ orgId: ORG_A, teamId: T1, channelId: C1 }]);
  });

  it("drops an event from an unbound team with slack_team_not_bound, before any binding lookup", async () => {
    const { db, queue, logs, lookups, send } = wired();
    await store(db).bindSlackTeam({ orgId: ORG_A, teamId: T1 });
    // Even a binding sitting under that team's id in some org does not make the team bound.
    db.set({ ...slackBindingKey(ORG_B, T9, C1), ...binding(T9, C1, "web") });
    expect((await send(T9, C1)).statusCode).toBe(200);
    expect(queue).toHaveLength(0);
    expect(lookups).toEqual([]);
    expect(logs).toContainEqual({ event: "event.ignored", fields: { reason: "slack_team_not_bound", teamId: T9 } });
    expect(db.find((item) => item.entityType === "WORKSPACE")).toHaveLength(0);
  });

  it("does not read another org's binding for the same team and channel names", async () => {
    const { db, queue, logs, lookups, send } = wired();
    await store(db).bindSlackTeam({ orgId: ORG_A, teamId: T1 });
    db.set({ ...slackBindingKey(ORG_B, T1, C2), ...binding(T1, C2, "web") });
    expect((await send(T1, C2)).statusCode).toBe(200);
    expect(queue).toHaveLength(0);
    expect(lookups).toEqual([{ orgId: ORG_A, teamId: T1, channelId: C2 }]);
    expect(logs).toContainEqual({ event: "event.ignored", fields: { reason: "channel_not_bound", channelId: C2 } });
  });
});

describe("the broker's Slack routes in a two-org install", () => {
  const owners = new Map<string, OrgId>([
    [ownerKeyForSubject(issuer, "admin-a"), ORG_A],
    [ownerKeyForSubject(issuer, "admin-b"), ORG_B],
  ]);
  const orgResolver: OrgResolver = async (subject) => (subject.ownerKey === undefined ? undefined : owners.get(subject.ownerKey));
  const adminA = { subject: "admin-a", admin: true };
  const adminB = { subject: "admin-b", admin: true };
  const project = (name: string) => ({
    definition: {
      name, revision: 1,
      repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
      setup: [], readiness: [], orchestratorInstructions: `Delegate work in ${name}.`,
    },
    runtimeBinding: {
      deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-0123456789abcdef0",
      subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" as const,
    },
  });
  const register = async (handler: Parameters<typeof call>[0], user: typeof adminA, name: string) => {
    const registered = await call(handler, { method: "POST", path: "/v1/admin/projects", user, body: project(name) });
    expect(registered.status).toBe(201);
  };
  const bind = (handler: Parameters<typeof call>[0], user: typeof adminA, teamId: string, channelId: string, projectName: string) =>
    call(handler, { method: "PUT", path: `/v1/admin/slack/bindings/${teamId}/${channelId}`, user, body: { projectName } });
  const thread = (teamId: string, channelId: string) => `${teamId}/${channelId}/1695500000.000001`;

  it("binds the team to the admin's org first, then resolves the channel to that org's project", async () => {
    const { handler, db } = createBroker({ extra: { orgResolver } });
    await register(handler, adminA, "web");
    await register(handler, adminB, "web");
    expect((await bind(handler, adminA, T1, C1, "web")).status).toBe(200);
    expect(db.get(slackTeamOrgKey(T1).pk, "ORG")).toMatchObject({ orgId: ORG_A });
    expect(db.get(slackBindingPk(ORG_A, T1), `CHANNEL#${C1}`)).toMatchObject({ projectName: "web", teamId: T1 });
    expect(db.find((item) => item.entityType === "SLACK_BINDING")).toHaveLength(1);

    const created = await ensureWorkspace(handler, thread(T1, C1), PRATIK);
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ outcome: "WORKSPACE", orchestratorInstructions: "Delegate work in web." });
    const workspace = db.get(`WORKSPACE#${String(created.body.workspaceId)}`, "META");
    expect(workspace).toMatchObject({ projectName: "web", projectRevision: 1 });
    // The charge landed on org A's counters for the team, and the thread record names the org.
    expect(db.get(slackOrganizationLimitKey(ORG_A, T1).pk, "ORGANIZATION")).toMatchObject({ count: 1, entityType: "SLACK_LIMIT" });
    expect(db.get(slackMemberLimitKey(ORG_A, T1, PRATIK).pk, `MEMBER#${PRATIK}`)).toMatchObject({ count: 1 });
    expect(db.find((item) => item.entityType === "SLACK_THREAD")[0]).toMatchObject({ orgId: ORG_A });
    expect(db.find((item) => String(item.pk).includes("SLACK_LIMIT#") && !String(item.pk).startsWith(`ORG#${ORG_A}#`))).toHaveLength(0);
  });

  it("refuses an event from an unbound team and creates no workspace", async () => {
    const { handler, db } = createBroker({ extra: { orgResolver } });
    await register(handler, adminA, "web");
    expect((await bind(handler, adminA, T1, C1, "web")).status).toBe(200);
    const refused = await ensureWorkspace(handler, thread(T9, C1), PRATIK);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "SLACK_TEAM_NOT_BOUND" });
    expect(db.find((item) => item.entityType === "WORKSPACE")).toHaveLength(0);
    expect(db.get(slackTeamOrgKey(T9).pk, "ORG")).toBeUndefined();
  });

  it("does not resolve a channel bound only in another org, even for a team of the first", async () => {
    const { handler, db } = createBroker({ extra: { orgResolver } });
    await register(handler, adminA, "web");
    await register(handler, adminB, "web");
    expect((await bind(handler, adminA, T1, C1, "web")).status).toBe(200);
    // Seeded directly: org B's own binding for a channel of T1, which org A's team never serves.
    db.set({ ...slackBindingKey(ORG_B, T1, C2), ...binding(T1, C2, "web") });
    const refused = await ensureWorkspace(handler, thread(T1, C2), PRATIK);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "FORBIDDEN" });
    expect((refused.body.error as { message: string }).message).toContain("not bound");
    expect(db.find((item) => item.entityType === "WORKSPACE")).toHaveLength(0);
  });

  it("refuses to bind a team another org holds, and writes no binding", async () => {
    const { handler, db } = createBroker({ extra: { orgResolver } });
    await register(handler, adminA, "web");
    await register(handler, adminB, "web");
    expect((await bind(handler, adminA, T1, C1, "web")).status).toBe(200);
    const taken = await bind(handler, adminB, T1, C3, "web");
    expect(taken.status).toBe(409);
    expect(taken.body.error).toMatchObject({ code: "SLACK_TEAM_TAKEN" });
    expect(db.get(slackBindingPk(ORG_B, T1), `CHANNEL#${C3}`)).toBeUndefined();
    expect(db.get(slackTeamOrgKey(T1).pk, "ORG")).toMatchObject({ orgId: ORG_A });
  });

  it("unbinds a binding only inside the caller's org", async () => {
    const { handler, db } = createBroker({ extra: { orgResolver } });
    await register(handler, adminA, "web");
    await register(handler, adminB, "web");
    expect((await bind(handler, adminA, T1, C1, "web")).status).toBe(200);
    const unboundByB = await call(handler, { method: "DELETE", path: `/v1/admin/slack/bindings/${T1}/${C1}`, user: adminB });
    expect(unboundByB.status).toBe(404);
    expect(db.get(slackBindingPk(ORG_A, T1), `CHANNEL#${C1}`)).toBeDefined();
    const unboundByA = await call(handler, { method: "DELETE", path: `/v1/admin/slack/bindings/${T1}/${C1}`, user: adminA });
    expect(unboundByA.status).toBe(200);
    expect(db.get(slackBindingPk(ORG_A, T1), `CHANNEL#${C1}`)).toBeUndefined();
  });
});

describe("a single-org install's own Slack team", () => {
  it("needs no manual binding, and any other team is still refused", async () => {
    const { handler, db } = await createDeveloperTaskBroker({ register: false });
    await registerSlackProject(handler, { bind: false });
    // The binding row only: no SLACK_TEAM row, as an install that never ran the binding route has it.
    db.set({ ...slackBindingKey(TEST_ORG, SLACK_TEAM, SLACK_CHANNEL), ...binding(SLACK_TEAM, SLACK_CHANNEL, "payments") });
    expect(db.get(slackTeamOrgKey(SLACK_TEAM).pk, "ORG")).toBeUndefined();

    const created = await ensureWorkspace(handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`, PRATIK);
    expect(created.status).toBe(200);
    expect(db.get(slackTeamOrgKey(SLACK_TEAM).pk, "ORG")).toMatchObject({ orgId: TEST_ORG });
    expect(db.get(`ORG#${TEST_ORG}`, "META")).toMatchObject({ name: TEST_ENV });
    expect(db.get(slackLimitPk(TEST_ORG, SLACK_TEAM), "ORGANIZATION")).toMatchObject({ count: 1 });

    db.set({ ...slackBindingKey(TEST_ORG, "T0OTHERTEAM", SLACK_CHANNEL), ...binding("T0OTHERTEAM", SLACK_CHANNEL, "payments") });
    const refused = await ensureWorkspace(handler, `T0OTHERTEAM/${SLACK_CHANNEL}/1695500000.000001`, PRATIK);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "SLACK_TEAM_NOT_BOUND" });
    expect(db.get(slackTeamOrgKey("T0OTHERTEAM").pk, "ORG")).toBeUndefined();
  });

  it("binds the team to the org through the admin route as well", async () => {
    const { handler, db } = createBroker();
    await registerSlackProject(handler);
    expect(db.get(slackTeamOrgKey(SLACK_TEAM).pk, "ORG")).toMatchObject({ orgId: TEST_ORG });
  });
});
