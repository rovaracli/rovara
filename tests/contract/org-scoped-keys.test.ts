import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_GRANT_SK_PREFIX, memberGrantsPk, orgFailureIndexKey, orgLimitKey, orgProjectCatalogKey, orgProjectCatalogPk, orgUsageIndexKey, projectMemberKey, projectMetaKey, projectPk, projectRevisionKey, projectSelectionKey } from "@rovara-code/contracts";
import { orgSettingsKey } from "../../packages/cloud-contracts/src/org-scoped-keys.js";
import { singleOrgIdForEnv, type OrgId } from "@rovara-code/contracts";
import { checkProjectAccess, type DeveloperApiConfiguration, type DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { readWorkspaceLimits } from "../../packages/broker/src/developer/limits.js";
import { requireOrgId, singleOrgResolver, type OrgResolver } from "../../packages/broker/src/org/resolve.js";
import { adminCall, adminIssuer, createAdminBroker } from "../support/admin-broker.js";
import { MAYA, OMAR, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import { TEST_ENV } from "../support/orgs.js";

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;

beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => undefined); });
afterEach(() => vi.restoreAllMocks());

describe("org-scoped key builders", () => {
  it("prefix every collision-prone key with the org", () => {
    expect(projectRevisionKey(ORG_A, "web", 7)).toEqual({ pk: `ORG#${ORG_A}#PROJECT#web`, sk: "REV#000000000007" });
    expect(projectSelectionKey(ORG_A, "web")).toEqual({ pk: projectPk(ORG_A, "web"), sk: "SELECTION" });
    expect(projectMetaKey(ORG_A, "web")).toEqual({ pk: projectPk(ORG_A, "web"), sk: "META" });
    expect(projectMemberKey(ORG_A, "owner-1", "web")).toEqual({ pk: `ORG#${ORG_A}#MEMBER#owner-1`, sk: "PROJECT#web" });
    expect(memberGrantsPk(ORG_A, "owner-1")).toBe(projectMemberKey(ORG_A, "owner-1", "web").pk);
    expect(MEMBER_GRANT_SK_PREFIX).toBe("PROJECT#");
    expect(orgSettingsKey(ORG_A, "WORKSPACE_LIMITS")).toEqual({ pk: `ORG#${ORG_A}#SETTINGS`, sk: "WORKSPACE_LIMITS" });
    expect(orgSettingsKey(ORG_A, "BUDGET")).toEqual({ pk: `ORG#${ORG_A}#SETTINGS`, sk: "BUDGET" });
    expect(orgLimitKey(ORG_A)).toEqual({ pk: `ORG#${ORG_A}#DEVELOPER_LIMIT#ORGANIZATION`, sk: "ORGANIZATION" });
    expect(orgUsageIndexKey(ORG_A, "2026-09-30T08:15:00Z", "op-1")).toEqual({ pk: `ORG#${ORG_A}#USAGE#2026-09-30`, sk: "2026-09-30T08:15:00.000Z#op-1" });
    expect(orgFailureIndexKey(ORG_A, "2026-09-30T08:15:00Z", "op-1")).toEqual({ pk: `ORG#${ORG_A}#FAILURE#2026-09-30`, sk: "2026-09-30T08:15:00.000Z#op-1" });
    expect(orgProjectCatalogPk(ORG_A)).toBe(`ORG#${ORG_A}#PROJECT_CATALOG`);
    expect(orgProjectCatalogKey(ORG_A, "web")).toEqual({ pk: orgProjectCatalogPk(ORG_A), sk: "PROJECT#web" });
  });

  it("give the same name a different key in each org", () => {
    expect(projectRevisionKey(ORG_A, "web", 1)).not.toEqual(projectRevisionKey(ORG_B, "web", 1));
    expect(projectMemberKey(ORG_A, "owner-1", "web")).not.toEqual(projectMemberKey(ORG_B, "owner-1", "web"));
    expect(orgLimitKey(ORG_A)).not.toEqual(orgLimitKey(ORG_B));
    expect(orgUsageIndexKey(ORG_A, "2026-09-30T08:15:00Z", "op-1").pk).not.toBe(orgUsageIndexKey(ORG_B, "2026-09-30T08:15:00Z", "op-1").pk);
  });

  it("refuse an index time that is not ISO", () => {
    expect(() => orgUsageIndexKey(ORG_A, "yesterday", "op-1")).toThrow("an index key needs an ISO time");
    expect(() => orgFailureIndexKey(ORG_A, "yesterday", "op-1")).toThrow("an index key needs an ISO time");
  });
});

describe("org resolver", () => {
  it("serves one org to everyone in a single-org install", async () => {
    const resolve = singleOrgResolver("staging");
    expect(await resolve({ ownerKey: "a" })).toBe(singleOrgIdForEnv("staging"));
    expect(await resolve({ developerId: "b" })).toBe(singleOrgIdForEnv("staging"));
  });

  it("refuses a caller with no org", () => {
    expect(() => requireOrgId(undefined)).toThrowError(/FORBIDDEN/);
    expect(requireOrgId(ORG_A)).toBe(ORG_A);
  });
});

const definition = (name: string, revision: number) => ({
  name, revision,
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
  setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
});
const runtimeBinding = {
  deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-0123456789abcdef0",
  subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" as const,
};

describe("two orgs on one install", () => {
  const owners = new Map<string, OrgId>([
    [ownerKeyForSubject(adminIssuer, "admin-a"), ORG_A],
    [ownerKeyForSubject(adminIssuer, "admin-b"), ORG_B],
  ]);
  const orgResolver: OrgResolver = async (subject) => (subject.ownerKey === undefined ? undefined : owners.get(subject.ownerKey));
  const register = (handler: Parameters<typeof adminCall>[0], subject: string, revision: number) =>
    adminCall(handler, { method: "POST", path: "/v1/admin/projects", subject, body: { definition: definition("web", revision), runtimeBinding } });

  it("registers the same project name in both orgs and lists each org's own", async () => {
    const { handler, db } = await createAdminBroker({ orgResolver });
    expect((await register(handler, "admin-a", 1)).status).toBe(201);
    expect((await register(handler, "admin-a", 2)).status).toBe(201);
    expect((await register(handler, "admin-b", 1)).status).toBe(201);

    expect(db.get(projectPk(ORG_A, "web"), "REV#000000000002")).toBeDefined();
    expect(db.get(projectPk(ORG_B, "web"), "REV#000000000002")).toBeUndefined();
    expect(db.get(projectPk(ORG_B, "web"), "REV#000000000001")).toBeDefined();
    expect(db.get(orgProjectCatalogPk(ORG_A), "PROJECT#web")).toMatchObject({ latestRevision: 2 });
    expect(db.get(orgProjectCatalogPk(ORG_B), "PROJECT#web")).toMatchObject({ latestRevision: 1 });

    const asA = await adminCall(handler, { method: "GET", path: "/v1/admin/projects", subject: "admin-a" });
    expect((asA.body.projects as Array<{ name: string; latestRevision: number }>).map((p) => [p.name, p.latestRevision])).toEqual([["web", 2]]);
    const asB = await adminCall(handler, { method: "GET", path: "/v1/admin/projects", subject: "admin-b" });
    expect((asB.body.projects as Array<{ name: string; latestRevision: number }>).map((p) => [p.name, p.latestRevision])).toEqual([["web", 1]]);
  });

  it("creates the org record before the first org-scoped write of a single-org install", async () => {
    const { handler, db } = await createAdminBroker({});
    expect((await adminCall(handler, { method: "POST", path: "/v1/admin/projects", body: { definition: definition("web", 1), runtimeBinding } })).status).toBe(201);
    const orgId = singleOrgIdForEnv(TEST_ENV);
    expect(db.get(`ORG#${orgId}`, "META")).toMatchObject({ orgId, name: TEST_ENV });
    expect(db.get(projectPk(orgId, "web"), "REV#000000000001")).toBeDefined();
  });

  it("refuses an org-scoped route to a caller that belongs to no org", async () => {
    const { handler } = await createAdminBroker({ orgResolver: async () => undefined });
    const refused = await register(handler, "admin-a", 1);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("grants and limits stay in their org", () => {
  const developerId = "d".repeat(64);
  const config: DeveloperApiConfiguration = {
    issuer: "https://dev.example.test", env: "staging", methods: { slack: true, oidc: false }, signInTableName: "signin",
    channelMembers: async () => ({ ok: true as const, memberOf: [] }), verifyAccessToken: async () => undefined as never,
  };
  const caller = (orgId: OrgId): DeveloperCaller => ({ developerId, sessionId: "s", amr: "slack", name: "Maya", orgId, orgRole: "member" });

  it("does not grant access to another org's project of the same name", async () => {
    const db = new FakeDynamoDb();
    for (const orgId of [ORG_A, ORG_B]) {
      db.set({ ...projectRevisionKey(orgId, "web", 1), entityType: "PROJECT", definition: { name: "web", revision: 1 } });
    }
    db.set({ ...projectMemberKey(ORG_A, developerId, "web"), entityType: "MEMBERSHIP", ownerKey: developerId, projectName: "web", role: "developer" });
    const deps = { documentClient: db, tableName: "state", developer: config, now: () => 0 };
    await expect(checkProjectAccess(deps, caller(ORG_A), "web")).resolves.toMatchObject({ access: "granted", revision: 1 });
    await expect(checkProjectAccess(deps, caller(ORG_B), "web")).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
  });

  it("does not find a project registered only in another org", async () => {
    const db = new FakeDynamoDb();
    db.set({ ...projectRevisionKey(ORG_A, "web", 1), entityType: "PROJECT", definition: { name: "web", revision: 1 } });
    const deps = { documentClient: db, tableName: "state", developer: config, now: () => 0 };
    await expect(checkProjectAccess(deps, caller(ORG_B), "web")).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("reads each org's own workspace limits", async () => {
    const db = new FakeDynamoDb();
    const fallback = { member: 3, organization: 20 };
    db.set({ ...orgSettingsKey(ORG_B, "WORKSPACE_LIMITS"), perPerson: 7, perOrganization: 70 });
    expect(await readWorkspaceLimits(db, "state", ORG_A, fallback)).toEqual({ ...fallback, source: "parameters" });
    expect(await readWorkspaceLimits(db, "state", ORG_B, fallback)).toEqual({ member: 7, organization: 70, source: "setting" });
  });
});

describe("two orgs read their own activity and projects", () => {
  const owners = new Map<string, OrgId>([
    [ownerKeyForSubject(adminIssuer, "admin-a"), ORG_A],
    [ownerKeyForSubject(adminIssuer, "admin-b"), ORG_B],
  ]);
  const orgResolver: OrgResolver = async (subject) => (subject.ownerKey === undefined ? undefined : owners.get(subject.ownerKey));

  it("lists each org's failures and usage from its own index days", async () => {
    const { handler, db } = await createAdminBroker({ orgResolver });
    const at = new Date(Date.now() - 3_600_000).toISOString();
    const failure = (orgId: OrgId, operationId: string) => ({
      ...orgFailureIndexKey(orgId, at, operationId), entityType: "FAILURE_INDEX", operationId, workspaceId: "22222222-2222-4222-8222-222222222222",
      project: "web", origin: "slack", requester: { kind: "none" }, kind: "task", status: "FAILED", category: "task_failed", error: "boom", endedAt: at,
    });
    db.set(failure(ORG_A, "11111111-1111-4111-8111-111111111111"));
    db.set(failure(ORG_B, "33333333-3333-4333-8333-333333333333"));
    db.set({
      ...orgUsageIndexKey(ORG_B, at, "33333333-3333-4333-8333-333333333333"), entityType: "USAGE_INDEX", operationId: "33333333-3333-4333-8333-333333333333",
      workspaceId: "22222222-2222-4222-8222-222222222222", project: "web", origin: "slack", requester: { kind: "none" }, at, durationMs: 1000,
      inputTokens: 10, outputTokens: 5, costUsd: 1.5,
    });
    const failuresOf = async (subject: string) => ((await adminCall(handler, { method: "GET", path: "/v1/admin/failures", subject })).body.failures as Array<{ operationId: string }>).map((entry) => entry.operationId);
    expect(await failuresOf("admin-a")).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(await failuresOf("admin-b")).toEqual(["33333333-3333-4333-8333-333333333333"]);
    const usageOf = async (subject: string) => (await adminCall(handler, { method: "GET", path: "/v1/admin/usage?group_by=project", subject })).body;
    expect(JSON.stringify(await usageOf("admin-a"))).not.toContain("1.5");
    expect(JSON.stringify(await usageOf("admin-b"))).toContain("1.5");
  });

  it("answers a developer's project list from the org the developer belongs to", async () => {
    await loadSlackBroker();
    const developerOrgs = new Map<string, OrgId>([[MAYA.developerId, ORG_A], [OMAR.developerId, ORG_B]]);
    const harness = await createDeveloperTaskBroker({ register: false, orgResolver: async (subject) => (subject.developerId === undefined ? undefined : developerOrgs.get(subject.developerId)) });
    const { db } = harness;
    db.set({ ...projectRevisionKey(ORG_A, "web", 1), entityType: "PROJECT", definition: { name: "web", revision: 1 } });
    db.set({ ...projectRevisionKey(ORG_B, "web", 4), entityType: "PROJECT", definition: { name: "web", revision: 4 } });
    db.set({ ...projectRevisionKey(ORG_A, "only-a", 1), entityType: "PROJECT", definition: { name: "only-a", revision: 1 } });
    for (const [who, orgId] of [[MAYA, ORG_A], [OMAR, ORG_B]] as const) {
      db.set({ ...projectMemberKey(orgId, who.developerId, "web"), entityType: "MEMBERSHIP", ownerKey: who.developerId, projectName: "web", role: "developer" });
    }
    // A grant under org A's name for a project only org A has: org B's developer, holding it in A, still cannot see it.
    db.set({ ...projectMemberKey(ORG_A, OMAR.developerId, "only-a"), entityType: "MEMBERSHIP", ownerKey: OMAR.developerId, projectName: "only-a", role: "developer" });
    const list = async (who: typeof MAYA) => ((await harness.dev(who, "GET", "/v1/dev/projects")).body.projects as Array<{ name: string; latestRevision: number }>).map((project) => [project.name, project.latestRevision]);
    expect(await list(MAYA)).toEqual([["web", 1]]);
    expect(await list(OMAR)).toEqual([["web", 4]]);
  });
});

describe("background readers use the org a record names (Task 3 fix round 1)", () => {
  const binding = (volumeSizeGiB: number) => ({ deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0",
    subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB, volumeType: "gp3" });
  const workspace = (id: string, extra: Record<string, unknown>) => ({ pk: `WORKSPACE#${id}`, sk: "META", deploymentMode: "ec2-ebs", projectName: "web", projectRevision: 1, ...extra });

  it("reads a workspace's binding in the org on its record, and in the install's org when it names none", async () => {
    const { workspaceBinding } = await import("../../packages/broker/src/aws/sessions.js");
    const db = new FakeDynamoDb();
    db.set({ ...projectRevisionKey(ORG_A, "web", 1), entityType: "PROJECT", runtimeBinding: binding(20) });
    db.set({ ...projectRevisionKey(ORG_B, "web", 1), entityType: "PROJECT", runtimeBinding: binding(40) });
    db.set(workspace("11111111-1111-4111-8111-111111111111", { orgId: ORG_B }));
    db.set(workspace("22222222-2222-4222-8222-222222222222", {}));
    expect((await workspaceBinding(db, "state", ORG_A, "11111111-1111-4111-8111-111111111111"))?.volumeSizeGiB).toBe(40);
    expect((await workspaceBinding(db, "state", ORG_A, "22222222-2222-4222-8222-222222222222"))?.volumeSizeGiB).toBe(20);
  });
});
