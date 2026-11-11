// UX3-LATER (p1-ux-connections): `GET /v1/app/connection-usage` says which projects use each AI provider and each tracker or monitoring connection, so the Connections
// page's "used by" is exact. Only the projects the caller may see are named, another company's projects never are, and a project that can't be read makes the answer incomplete.
import { randomUUID } from "node:crypto";
import { describe, expect, it, beforeAll, vi } from "vitest";
import { orgScoped } from "@rovara-code/contracts";
import { CONNECTION_USAGE_MAX_PROJECTS } from "../../packages/broker/src/aws/developer-routes/connection-usage.js";
import { intakeSourceKey, orgProjectCatalogKey, projectRevisionKey, projectMetaKey, projectMemberKey } from "@rovara-code/contracts";
import { projectAiKey } from "../../packages/cloud-contracts/src/org-scoped-keys.js";
import type { OrgId } from "@rovara-code/contracts";
import type { OrgRole } from "../../packages/cloud-contracts/src/org-node.js";
import { mcpEndpointGuard } from "../../packages/broker/src/connections/pinned-endpoint.js";
import { OrgSecrets } from "../../packages/broker/src/connections/org-secrets.js";
import { MAYA, OMAR, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { FAKE_CONNECTOR_ROLE_ARN, FakeOrgSecrets } from "../support/fake-org-secrets.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import type { OrgResolver } from "../../packages/broker/src/org/resolve.js";

const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const ENV = "staging";
const person = (digit: string, name: string): Developer => ({ developerId: digit.repeat(64), name, provider: "oidc", sessionId: `s-${name.toLowerCase()}` });
const DANA = person("1", "Dana"); // admin
const MAX = person("3", "Max"); // member with a grant on "web" only
const orgResolver: OrgResolver = async (subject) => (subject.developerId === OMAR.developerId ? ORG_B : TEST_ORG);
beforeAll(async () => { await loadSlackBroker(); }, 60_000);

const BINDING = { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-west-2a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" } as const;
function seedProject(db: FakeDynamoDb, orgId: OrgId, name: string, connectors: unknown[] = [], status?: "archived"): void {
  db.set({
    ...projectRevisionKey(orgId, name, 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: BINDING,
    definition: {
      name, revision: 1, repositories: [{ name: "web", url: `https://github.com/acme/${name}.git`, path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }],
      setup: [], readiness: [], orchestratorInstructions: "Delegate work.", ...(connectors.length === 0 ? {} : { integrations: { connectors } }),
    },
  });
  db.set({ ...orgProjectCatalogKey(orgId, name), entityType: "PROJECT_CATALOG", name, latestRevision: 1, firstRegisteredAt: "2026-10-01T00:00:00.000Z" });
  if (status !== undefined) db.set({ ...projectMetaKey(orgId, name), entityType: "PROJECT_META", name, status, createdAt: "2026-10-02T00:00:00.000Z", createdBy: MAYA.developerId });
}
const ownOrder = (db: FakeDynamoDb, project: string, sourceOrder: string[]) =>
  db.set({ ...projectAiKey(TEST_ORG, project), entityType: "PROJECT_AI", projectPays: false, sourceOrder, revision: 1 });
const watch = (db: FakeDynamoDb, project: string, ref: Record<string, unknown>, sourceId: string) =>
  db.set({ ...intakeSourceKey(TEST_ORG, project, sourceId), entityType: "INTAKE_SOURCE", orgId: TEST_ORG, project, sourceId, ref, setBy: "x", createdAt: "x", updatedAt: "x", nextPollAt: 0, failures: 0 });

async function setup(orgOrder: string[] = ["rovara", "src_aaaaaaaaaaaaaaaaaaaa"]) {
  const fake = new FakeOrgSecrets({ env: ENV, now: Date.now });
  const secrets = new OrgSecrets({ env: ENV, roleArn: FAKE_CONNECTOR_ROLE_ARN, sts: fake.sts, secretsFor: fake.secretsFor, now: Date.now });
  const holder: { db?: { send(command: unknown): Promise<unknown> } } = {};
  const h = await createDeveloperTaskBroker({
    orgResolver, register: false,
    brokerExtra: {
      agents: { projectMembers: new FakeProjectMembers(), orgSourceOrder: async () => orgOrder },
      orgConnections: { documentClient: { send: (command: unknown) => holder.db!.send(command) }, tableName: "state", env: ENV, secrets, now: Date.now },
      connectionChecks: { checkEndpoint: vi.fn(), listMcpTools: vi.fn(), fetch: vi.fn(), endpointGuard: mcpEndpointGuard({ resolveHost: async () => ["52.1.2.3"] }) },
    },
  });
  holder.db = h.db;
  const enroll = async (who: Developer, role: OrgRole, orgId: OrgId = TEST_ORG) => {
    h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    await h.orgOf(who);
    seedMembership(h.db, who.developerId, { orgId, role });
  };
  await enroll(DANA, "admin");await enroll(MAX, "member");await enroll(OMAR, "admin", ORG_B);
  const create = async (connection: Record<string, unknown>, secret?: Record<string, unknown>) => {
    const reply = await h.dev(DANA, "POST", "/v1/app/connections", { requestId: randomUUID(), connection, ...(secret === undefined ? {} : { secret }) });
    expect(reply.status).toBe(201);
    return (reply.body.connection as { connectionId: string }).connectionId;
  };
  const usage = async (who: Developer) => { const reply = await h.dev(who, "GET", "/v1/app/connection-usage"); return { status: reply.status, body: reply.body as { complete: boolean; connections: Array<{ connectionId: string; projects: string[] }>; sources: Array<{ sourceId: string; projects: string[] }> } }; };
  return { h, create, usage };
}
const of = <K extends string>(list: Array<Record<string, unknown> & { projects: string[] }>, key: K, id: string) => list.find(entry => entry[key] === id)?.projects;

describe("GET /v1/app/connection-usage", () => {
  it("names the projects that attach a connection, that watch through it, and that have an AI provider in their effective order", async () => {
    const { h, create, usage } = await setup();
    const sentry = await create({ type: "sentry", label: "Errors", access: "read", region: "us", orgSlug: "acme" }, { authToken: ["sn", "tok", "abc"].join("_") });
    const linear = await create({ type: "linear", label: "Team Linear", access: "read" }, { apiKey: ["lin", "api", "abcdefgh"].join("_") });
    const jira = await create({ type: "jira", label: "Our Jira", access: "read", siteUrl: "https://acme.atlassian.net" }, { email: "a@acme.dev", apiToken: ["jr", "tok", "abcdefgh"].join("_") });
    const idle = await create({ type: "linear", label: "Idle", access: "read" }, { apiKey: ["lin", "api", "zzzzzzzz"].join("_") });
    seedProject(h.db, TEST_ORG, "api", [{ name: "errors", type: "sentry", credentialRef: sentry, scopes: [{ alias: "web", projectSlug: "web-app" }], tools: [{ name: "list_issues", access: "read" }] }]);
    seedProject(h.db, TEST_ORG, "web");
    seedProject(h.db, TEST_ORG, "old", [{ name: "errors", type: "sentry", credentialRef: sentry, scopes: [{ alias: "web", projectSlug: "web-app" }], tools: [{ name: "list_issues", access: "read" }] }], "archived");
    // web watches Jira without naming a connection (only one Jira holds a key) and Linear by label; api has no sources.
    watch(h.db, "web", { channel: "jira", when: { label: "rovara" } }, "a".repeat(24));
    watch(h.db, "web", { channel: "tracker", system: "linear", connection: "Team Linear", when: { label: "rovara" } }, "b".repeat(24));
    ownOrder(h.db, "api", ["src_bbbbbbbbbbbbbbbbbbbb"]);
    const answer = await usage(DANA);
    expect(answer.status).toBe(200);
    expect(answer.body.complete).toBe(true);
    expect(of(answer.body.connections, "connectionId", sentry)).toEqual(["api"]);
    expect(of(answer.body.connections, "connectionId", jira)).toEqual(["web"]);
    expect(of(answer.body.connections, "connectionId", linear)).toEqual(["web"]);
    expect(of(answer.body.connections, "connectionId", idle)).toEqual([]);
    // web follows the company's order; api has its own.
    expect(of(answer.body.sources, "sourceId", "rovara")).toEqual(["web"]);
    expect(of(answer.body.sources, "sourceId", "src_aaaaaaaaaaaaaaaaaaaa")).toEqual(["web"]);
    expect(of(answer.body.sources, "sourceId", "src_bbbbbbbbbbbbbbbbbbbb")).toEqual(["api"]);
    expect(JSON.stringify(answer.body)).not.toContain("old");
  });

  it("does not guess a watched source's connection when two of its type could serve it", async () => {
    const { h, create, usage } = await setup();
    await create({ type: "jira", label: "Jira one", access: "read", siteUrl: "https://one.atlassian.net" }, { email: "a@acme.dev", apiToken: ["jr", "tok", "abcdefgh"].join("_") });
    await create({ type: "jira", label: "Jira two", access: "read", siteUrl: "https://two.atlassian.net" }, { email: "a@acme.dev", apiToken: ["jr", "tok", "ijklmnop"].join("_") });
    seedProject(h.db, TEST_ORG, "web");
    watch(h.db, "web", { channel: "jira", when: { label: "rovara" } }, "a".repeat(24));
    const { body } = await usage(DANA);
    expect(body.connections.every(entry => entry.projects.length === 0)).toBe(true);
  });

  it("names only the projects the caller may see, and never another company's", async () => {
    const { h, create, usage } = await setup();
    const sentry = await create({ type: "sentry", label: "Errors", access: "read", region: "us", orgSlug: "acme" }, { authToken: ["sn", "tok", "abc"].join("_") });
    const connector = [{ name: "errors", type: "sentry", credentialRef: sentry, scopes: [{ alias: "web", projectSlug: "web-app" }], tools: [{ name: "list_issues", access: "read" }] }];
    seedProject(h.db, TEST_ORG, "api", connector);
    seedProject(h.db, TEST_ORG, "web", connector);
    seedProject(h.db, ORG_B, "elsewhere", connector);
    h.db.set({ ...projectMemberKey(TEST_ORG, MAX.developerId, "web"), entityType: "MEMBERSHIP", ownerKey: MAX.developerId, projectName: "web", role: "developer" });
    const admin = await usage(DANA), member = await usage(MAX), other = await usage(OMAR);
    expect(of(admin.body.connections, "connectionId", sentry)).toEqual(["api", "web"]);
    // the member sees the connection listed (any member may read connections) but only the project they may see; the other company sees none of this company's connections.
    expect(of(member.body.connections, "connectionId", sentry)).toEqual(["web"]);
    expect(JSON.stringify(member.body)).not.toContain("api");
    expect(JSON.stringify(admin.body)).not.toContain("elsewhere");
    expect(JSON.stringify(other.body)).not.toMatch(/"(api|web)"/);
    expect(other.body.connections).toEqual([]);
  });

  it("says it is not complete when a project's settings can't be read, instead of guessing", async () => {
    const { h, usage } = await setup();
    seedProject(h.db, TEST_ORG, "web");
    h.db.set({ ...projectAiKey(TEST_ORG, "web"), entityType: "PROJECT_AI", projectPays: "not a boolean", revision: 1 });
    const { status, body } = await usage(DANA);
    expect(status).toBe(200);
    expect(body.complete).toBe(false);
    expect(body.sources).toEqual([]);
  });

  it("counts an MCP connection a project uses as a context source, and says it is not complete when a project's context sources can't be read", async () => {
    const { h, create, usage } = await setup();
    const mcp = await create({ type: "mcp", label: "Docs MCP", access: "read", endpoint: "https://mcp.acme.dev/mcp", vendor: "Docs" }, { token: ["mcp", "tok", "abcdefgh"].join("_") });
    const unused = await create({ type: "mcp", label: "Idle MCP", access: "read", endpoint: "https://mcp2.acme.dev/mcp", vendor: "Idle" }, { token: ["mcp", "tok", "ijklmnop"].join("_") });
    seedProject(h.db, TEST_ORG, "web");
    seedProject(h.db, TEST_ORG, "api");
    const source = { sourceId: "docs", label: "Docs", server: { kind: "connection", connectionId: mcp }, tools: [{ upstreamName: "search_docs", role: "search", schemaHash: "a".repeat(64) }], stages: ["PLAN"], quotes: "project_members", retention: "live_only", limits: { callsPerStage: 5, bytesPerResult: 4096, bytesPerStage: 16384 }, liveFacts: [], sendCodeSnippets: false };
    h.db.set({ pk: orgScoped(TEST_ORG, "CTXSRC#web"), sk: "DOC", revision: 1, sources: [source] });
    const answer = await usage(DANA);
    expect(answer.body.complete).toBe(true);
    expect(of(answer.body.connections, "connectionId", mcp)).toEqual(["web"]);
    expect(of(answer.body.connections, "connectionId", unused)).toEqual([]);
    // A project whose context sources can't be read is never guessed at.
    const send = h.db.send;
    h.db.send = async (command: { input?: { Key?: { pk?: string } } }) => { if (command.input?.Key?.pk === orgScoped(TEST_ORG, "CTXSRC#api")) throw new Error("boom"); return send(command as never); };
    const broken = await usage(DANA);
    expect(broken.status).toBe(200);
    expect(broken.body.complete).toBe(false);
    h.db.send = send;
  });

  it("skips a catalog entry with no readable revision, as the project list does", async () => {
    const { h, usage } = await setup();
    seedProject(h.db, TEST_ORG, "web");
    h.db.set({ ...orgProjectCatalogKey(TEST_ORG, "ghost"), entityType: "PROJECT_CATALOG", name: "ghost", latestRevision: 1, firstRegisteredAt: "2026-10-01T00:00:00.000Z" });
    const { body } = await usage(DANA);
    expect(body.complete).toBe(true);
    expect(JSON.stringify(body)).not.toContain("ghost");
    expect(of(body.sources, "sourceId", "rovara")).toEqual(["web"]);
  });

  it("says it is not complete past the project cap, and complete at the cap", async () => {
    const { h, usage } = await setup();
    const row = (index: number) => { const name = `p${String(index).padStart(3, "0")}`;h.db.set({ ...orgProjectCatalogKey(TEST_ORG, name), entityType: "PROJECT_CATALOG", name, latestRevision: 1, firstRegisteredAt: "2026-10-01T00:00:00.000Z" }); };
    for (let index = 0; index < CONNECTION_USAGE_MAX_PROJECTS; index += 1) row(index);
    expect((await usage(DANA)).body.complete).toBe(true);
    row(CONNECTION_USAGE_MAX_PROJECTS);
    expect((await usage(DANA)).body.complete).toBe(false);
  });
});
