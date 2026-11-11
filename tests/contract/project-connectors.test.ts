// Plan 3 Task 13: a project's maintainers attach the org's connections to it as connectors, from the app
// (`GET /v1/app/projects/{p}/connectors`, `PUT` and `DELETE …/connectors/{name}`). Each change is a new project revision written through
// `registerProjectFor`; a tool newly approved to write waits for a person on the confirmation page (R9-3, R69). The broker is the real one,
// with a fake Linear MCP server behind the Linear connector type and a fake Secrets Manager behind the org's connections.
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditProof, OrgRole } from "@agentx/cloud-contracts";
import type { OrgId } from "@rovara-code/contracts";
import { AgentConnectorTypeSchema, ConnectorConfigSchema, ConnectorsSchema, RegistrationPreflightSchema, SlackThreadWorkspaceResultSchema, StoredConnectorsSchema, toolGrantProblems } from "@rovara-code/contracts";
import { orgMemberKey } from "@agentx/cloud-contracts";
import { orgProjectCatalogKey, projectMemberKey, projectMetaKey, projectRevisionKey } from "@rovara-code/contracts";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { approvalKey } from "@rovara-code/contracts";
import { getApproval, getApprovalSubjectHandler, getApproverRule, type ApprovalDependencies, type ApprovalRecord, type ConnectorWidenSubject } from "../../packages/broker/src/agents/approvals.js";
import { checkEndpointUrl } from "../../packages/broker/src/connections/endpoint-check.js";
import { OrgConnectionStore } from "../../packages/broker/src/connections/store.js";
import { OrgSecrets } from "../../packages/broker/src/connections/org-secrets.js";
import { PROJECT_CONNECTOR_TOOLS, registerProjectConnectorApprovals, widenings } from "../../packages/broker/src/connections/project-connectors.js";
import { resolveToolGrants, toolFactsFor } from "../../packages/broker/src/agents/tool-grants.js";
import { createProjectMembers } from "../../packages/broker/src/org/project-members.js";
import { githubConnectorType, type ConnectorType } from "../../packages/broker/src/aws/connector-types.js";
import { jiraConnectorType } from "../../packages/broker/src/aws/jira-connector-type.js";
import { mcpConnectorType } from "../../packages/broker/src/aws/connector-presets.js";
import { connectMcp } from "@agentx/gateway";
import { DECIDE_COOKIE, DecideStore, csrfTokenFor, requireDecideSession, type DecideRequestContext } from "../../packages/broker/src/developer/decide-session.js";
import type { DecideKind } from "../../packages/broker/src/developer/decide-kinds.js";
import { approvalDecideKind } from "../../packages/broker/src/agents/approval-decide-kind.js";
import { routeDecidePage } from "../../packages/broker/src/aws/decide-web.js";
import { OMAR, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FAKE_CONNECTOR_ROLE_ARN, FakeOrgSecrets } from "../support/fake-org-secrets.js";
import { CHARTERARC_TEAM_ID, linearViaFake, startFakeLinearMcp } from "../support/fake-linear-mcp.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import type { OrgResolver } from "../../packages/broker/src/org/resolve.js";
import type { AgentCaller } from "../../packages/broker/src/agents/access.js";

const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const ENV = "staging";
const BINDING = {
  deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0",
  subnets: [{ availabilityZone: "us-west-2a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3",
} as const;
const STALE = "someone changed this project's settings; reload and try again";
const PRIVATE = "ask an administrator to change this project's connectors with agentx admin project register";
const LINEAR_KEY = "lin_api_PROJECTCONNECTORKEY0123456789";

const person = (digit: string, name: string): Developer => ({ developerId: digit.repeat(64), name, provider: "oidc", sessionId: `s-${name.toLowerCase()}` });
const DANA = person("1", "Dana"); // org admin
const MIA = person("2", "Mia"); // maintainer of web by a grant
const CARL = person("3", "Carl"); // contributor of web
const VERA = person("4", "Vera"); // viewer of web
const NOEL = person("5", "Noel"); // org member with no access to web
const PETE = person("6", "Pete"); // a second maintainer of web
const orgResolver: OrgResolver = async (subject) => (subject.developerId === OMAR.developerId ? ORG_B : TEST_ORG);

// Loading the Slack broker can take over 10 s on a loaded CI runner (CI run 42549353164).
beforeAll(async () => { await loadSlackBroker(); }, 60_000);
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const READ_TOOLS = [{ name: "list_issues", access: "read" }, { name: "get_issue", access: "read" }];
const WRITE_TOOLS = [{ name: "list_issues", access: "read" }, { name: "get_issue", access: "read" }, { name: "save_issue", access: "write" }];
const linear = (credentialRef: string, tools: unknown[] = READ_TOOLS, extra: Record<string, unknown> = {}) => ({
  name: "linear", type: "linear", credentialRef, scopes: [{ alias: "charterarc", teamId: CHARTERARC_TEAM_ID }], tools, ...extra,
});

interface Reply { status: number; body: Record<string, unknown> & { error?: { code: string; message: string }; connector?: Record<string, unknown>; connectors?: Array<Record<string, unknown>>; revision?: number } }

/** A project as registration writes it: revision 1 with one repository, a setup and a test command, its catalog entry and META. */
function seedProject(db: FakeDynamoDb, orgId: OrgId, name = "web", extra: Record<string, unknown> = {}): void {
  const command = (executable: string, args: string[], timeoutSeconds: number) => ({ cwd: "repo/web", executable, args, timeoutSeconds });
  db.set({
    ...projectRevisionKey(orgId, name, 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: BINDING,
    definition: {
      name, revision: 1,
      repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }],
      setup: [command("npm", ["ci"], 900)], readiness: [command("npm", ["test"], 1800)],
      orchestratorInstructions: "Delegate work.", ...extra,
    },
  });
  db.set({ ...orgProjectCatalogKey(orgId, name), entityType: "PROJECT_CATALOG", name, latestRevision: 1, firstRegisteredAt: "2026-10-01T00:00:00.000Z" });
  db.set({ ...projectMetaKey(orgId, name), entityType: "PROJECT_META", name, status: "active", createdAt: "2026-10-02T00:00:00.000Z", createdBy: DANA.developerId });
}

async function install(options: { cloud?: boolean; people?: Array<[Developer, OrgRole, OrgId?]>; fetchLinear?: boolean } = {}) {
  const fakeLinear = await startFakeLinearMcp();
  const { type: linearType } = linearViaFake(fakeLinear);
  /** A connector type whose vendor is the fake server, so no test reaches a real vendor. */
  const viaFake = (real: ConnectorType): ConnectorType => ({
    type: real.type,
    resolve: (config, project, context) => real.resolve(config, project, { ...context, connect: ((input: Parameters<typeof connectMcp>[0]) => connectMcp({ ...input, endpoint: fakeLinear.url })) }),
  });
  const secretsFake = new FakeOrgSecrets({ env: ENV, now: Date.now });
  const secrets = new OrgSecrets({ env: ENV, roleArn: FAKE_CONNECTOR_ROLE_ARN, sts: secretsFake.sts, secretsFor: secretsFake.secretsFor, now: Date.now });
  const audit = capturingAuditDeps();
  const holder: { db?: { send(command: unknown): Promise<unknown> } } = {};
  const checkEndpoint = vi.fn(async (url: string) => { await checkEndpointUrl(url, async () => ["52.1.2.3"]); });
  const h = await createDeveloperTaskBroker({
    orgResolver, register: false, audit,
    brokerExtra: {
      ...(options.cloud === false ? {} : { cloud: true }),
      cloudProjects: { runtimeBinding: BINDING, githubCredentialRef: "github-app" },
      checkRepositoryAccess: vi.fn(async () => undefined),
      agents: {},
      connectorTypes: { github: githubConnectorType, linear: linearType, jira: viaFake(jiraConnectorType), mcp: viaFake(mcpConnectorType) },
      orgConnections: { documentClient: { send: (command: unknown) => holder.db!.send(command) }, tableName: "state", env: ENV, secrets, now: Date.now },
      connectionChecks: {
        checkEndpoint, listMcpTools: vi.fn(async () => [{ name: "a" }]),
        fetch: vi.fn(async () => new Response(JSON.stringify({ data: { viewer: { id: "lin-user-1" } } }), { status: 200 })),
      },
    },
  });
  holder.db = h.db;
  const enroll = async (who: Developer, role: OrgRole, orgId: OrgId = TEST_ORG) => {
    h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    await h.orgOf(who);
    seedMembership(h.db, who.developerId, { orgId, role });
  };
  const people: Array<[Developer, OrgRole, OrgId?]> = options.people ?? [[DANA, "admin"], [MIA, "member"], [CARL, "member"], [VERA, "member"], [NOEL, "member"], [PETE, "member"], [OMAR, "admin", ORG_B]];
  for (const [who, role, orgId] of people) await enroll(who, role, orgId);
  const grant = (who: Developer, projectRole: "maintainer" | "contributor" | "viewer", project = "web") =>
    h.db.set({ ...projectMemberKey(TEST_ORG, who.developerId, project), entityType: "MEMBERSHIP", ownerKey: who.developerId, projectName: project, grantId: randomUUID(), role: projectRole === "viewer" ? "viewer" : "developer", projectRole, grantedAt: "2026-10-01T00:00:00.000Z" });
  seedProject(h.db, TEST_ORG);
  seedProject(h.db, ORG_B);
  seedProject(h.db, TEST_ORG, "api", { repositories: [{ name: "api", url: "https://github.com/acme/api.git", path: "repo/api", defaultBranch: "main", credentialRef: "github-app" }] });
  grant(MIA, "maintainer"); grant(PETE, "maintainer"); grant(CARL, "contributor"); grant(VERA, "viewer");

  const call = async (who: Developer, method: string, path: string, body?: Record<string, unknown>, requestId: string = randomUUID()): Promise<Reply> => {
    const reply = await h.dev(who, method, path, body === undefined ? undefined : { requestId, ...body });
    const { requestId: _requestId, ...rest } = reply.body; // eslint-disable-line @typescript-eslint/no-unused-vars -- the envelope's id is not part of an answer
    return { status: reply.status, body: rest };
  };
  /** Creates an org connection as an org admin; `secret: null` saves it without a key. */
  const connection = async (connectionBody: Record<string, unknown>, secret: Record<string, unknown> | null = { apiKey: LINEAR_KEY }, who: Developer = DANA): Promise<string> => {
    const created = await call(who, "POST", "/v1/app/connections", { connection: connectionBody, ...(secret === null ? {} : { secret }) });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return (created.body["connection"] as { connectionId: string }).connectionId;
  };
  const put = (who: Developer, name: string, connector: unknown, extra: Record<string, unknown> = {}, requestId?: string, project = "web") =>
    call(who, "PUT", `/v1/app/projects/${project}/connectors/${name}`, { expectedRevision: 1, connector, ...extra }, requestId);
  /** A DELETE names the revision the person saw; by default the newest one. */
  const del = (who: Developer, name: string, extra: Record<string, unknown> = {}, requestId?: string, project = "web") =>
    call(who, "DELETE", `/v1/app/projects/${project}/connectors/${name}`, { expectedRevision: h.db.find((item) => item.entityType === "PROJECT" && item.pk === projectRevisionKey(TEST_ORG, project, 1).pk).length, ...extra }, requestId);
  const list = (who: Developer, project = "web") => call(who, "GET", `/v1/app/projects/${project}/connectors`);
  const revisions = (project = "web", orgId: OrgId = TEST_ORG) => h.db.find((item) => item.entityType === "PROJECT" && item.pk === projectRevisionKey(orgId, project, 1).pk)
    .sort((left, right) => (left.definition as { revision: number }).revision - (right.definition as { revision: number }).revision);
  const revision = (n: number, project = "web", orgId: OrgId = TEST_ORG) => h.db.get(projectRevisionKey(orgId, project, n)) as { definition: Record<string, unknown>; runtimeBinding: unknown; registeredBy: string } | undefined;
  const approvals = () => h.db.find((item) => item.entityType === "APPROVAL");
  /** The request items of project connector changes (the connections' own are not counted). */
  const requestItems = () => h.db.find((item) => item.entityType === "AGENT_REQUEST" && (item.result as { connector?: unknown; removed?: unknown } | null)?.connector !== undefined || (item.result as { removed?: unknown } | null)?.removed !== undefined);
  const connectionStore = new OrgConnectionStore({ documentClient: { send: (command: unknown) => holder.db!.send(command) }, tableName: "state", env: ENV, secrets, now: Date.now, checkEndpoint });
  return { h, audit, call, connection, put, del, list, revisions, revision, approvals, requestItems, fakeLinear, grant, connectionStore, secrets, secretsFake, enroll };
}
type Install = Awaited<ReturnType<typeof install>>;

describe("who may read and change a project's connectors", () => {
  it("lets any role on the project read them, and answers 404 to a member with no access", async () => {
    const s = await install();
    const id = await s.connection({ type: "linear", label: "Team Linear", access: "read" });
    expect((await s.put(MIA, "linear", linear(id))).status).toBe(200);
    for (const who of [MIA, DANA, CARL, VERA]) {
      const read = await s.list(who);
      expect(read.status, who.name).toBe(200);
      expect(read.body.connectors, who.name).toHaveLength(1);
    }
    const hidden = await s.list(NOEL);
    expect(hidden.status).toBe(404);
    expect(hidden.body.error).toMatchObject({ code: "PROJECT_NOT_FOUND" });
    // A project that is not in the caller's org is as missing as one that does not exist.
    const theirs = await s.list(OMAR);
    const absent = await s.list(OMAR, "nothing");
    expect(theirs.status).toBe(200); // OMAR administers org B's own project of that name, which has no connectors
    expect(theirs.body.connectors).toEqual([]);
    expect(absent.status).toBe(404);
  });

  it("lets a maintainer and an org admin change them, and refuses a contributor and a viewer with 403 and a non-member with 404, writing nothing", async () => {
    const s = await install();
    const id = await s.connection({ type: "linear", label: "Team Linear", access: "read" });
    for (const who of [CARL, VERA]) {
      const refused = await s.put(who, "linear", linear(id));
      expect(refused.status, who.name).toBe(403);
      expect(refused.body.error).toMatchObject({ code: "FORBIDDEN", message: "Only a maintainer of web can change its connectors." });
      expect((await s.del(who, "linear")).status, `${who.name} delete`).toBe(403);
    }
    const hidden = await s.put(NOEL, "linear", linear(id));
    expect(hidden.status).toBe(404);
    expect(hidden.body.error).toMatchObject({ code: "PROJECT_NOT_FOUND" });
    expect(s.revisions()).toHaveLength(1);
    expect(s.requestItems()).toHaveLength(0);
    expect((await s.put(MIA, "linear", linear(id))).status).toBe(200);
    expect((await s.del(DANA, "linear", { expectedRevision: 2 })).status).toBe(200);
    expect(s.revisions()).toHaveLength(3);
  });

  it("answers FORBIDDEN with the administrator's command on an install that is not Rovara Cloud, and writes nothing", async () => {
    const s = await install({ cloud: false });
    const id = "con_aaaaaaaaaaaaaaaaaaaa";
    for (const reply of [await s.put(MIA, "linear", linear(id)), await s.del(MIA, "linear"), await s.list(MIA)]) {
      expect(reply.status).toBe(403);
      expect(reply.body.error).toMatchObject({ code: "FORBIDDEN", message: PRIVATE });
    }
    // A contributor is refused for her role first, and a stranger still learns nothing.
    expect((await s.put(CARL, "linear", linear(id))).body.error).toMatchObject({ message: "Only a maintainer of web can change its connectors." });
    expect((await s.put(NOEL, "linear", linear(id))).status).toBe(404);
    expect(s.revisions()).toHaveLength(1);
  });
});

describe("attaching a connection", () => {
  it("adds a Linear connector that names the org's connection, keeps every other field, and reports it connected", async () => {
    const s = await install();
    const id = await s.connection({ type: "linear", label: "Team Linear", access: "read" });
    const saved = await s.put(MIA, "linear", linear(id));
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({
      revision: 2,
      connector: { name: "linear", type: "linear", connectionId: id, status: "connected", tools: [{ name: "list_issues", access: "read" }, { name: "get_issue", access: "read" }] },
    });
    expect(JSON.stringify(saved.body)).not.toContain(LINEAR_KEY);
    const stored = s.revision(2)!;
    expect(stored).toMatchObject({ registeredBy: MIA.developerId, runtimeBinding: BINDING });
    const first = s.revision(1)!.definition;
    expect(stored.definition).toEqual({ ...first, revision: 2, integrations: { connectors: [linear(id)] } });
    expect(s.h.db.get(orgProjectCatalogKey(TEST_ORG, "web"))).toMatchObject({ latestRevision: 2 });
    // The earlier revision is untouched, and a read shows the connector as it is now.
    expect(s.revision(1)!.definition).toEqual(first);
    const read = await s.list(CARL);
    expect(read.body).toMatchObject({ revision: 2, connectors: [{ name: "linear", type: "linear", connectionId: id, status: "connected", scopes: [{ alias: "charterarc", teamId: CHARTERARC_TEAM_ID }] }] });
    // The vendor was asked with the connection's own key.
    expect(s.fakeLinear.calls.length + s.fakeLinear.headers.length).toBeGreaterThan(0);
    await s.fakeLinear.close();
  });

  it("shows a connector whose connection was removed as not connected, from the live registry and not from the stored revision", async () => {
    const s = await install();
    const id = await s.connection({ type: "linear", label: "Team Linear", access: "read" });
    expect((await s.put(MIA, "linear", linear(id))).status).toBe(200);
    expect((await s.call(DANA, "DELETE", `/v1/app/connections/${id}`, {})).status).toBe(200);
    const read = await s.list(MIA);
    expect(read.body.connectors).toMatchObject([{ name: "linear", status: "not_connected" }]);
    expect(String(read.body.connectors![0]!["problem"])).toMatch(/not registered/);
    await s.fakeLinear.close();
  });

  it("refuses org B naming org A's connection with the exact text, the same as for an id nobody has, and writes no revision", async () => {
    const s = await install();
    const idInA = await s.connection({ type: "linear", label: "Team Linear", access: "read" });
    const missing = "con_zzzzzzzzzzzzzzzzzzzz";
    const theirs = await s.put(OMAR, "linear", linear(idInA));
    const absent = await s.put(OMAR, "linear", linear(missing));
    expect(theirs.status).toBe(400);
    expect(theirs.body.error).toEqual({ code: "CONFIG_INVALID", message: `credentialRef: no linear connection called ${idInA} in your organization` });
    expect(absent.body.error).toEqual({ code: "CONFIG_INVALID", message: `credentialRef: no linear connection called ${missing} in your organization` });
    expect(s.revisions("web", ORG_B)).toHaveLength(1);
    // The connection in A is still usable by A.
    expect((await s.put(MIA, "linear", linear(idInA))).status).toBe(200);
    expect(s.revisions("web", ORG_B)).toHaveLength(1);
    await s.fakeLinear.close();
  });

  it("refuses a registry name where a connection id belongs, and a connection of another type, with the same text", async () => {
    const s = await install();
    const jira = await s.connection({ type: "jira", label: "Our Jira", access: "read", siteUrl: "https://acme.atlassian.net" }, { email: "a@acme.dev", apiToken: "jira-token-1234567890" });
    const named = await s.put(MIA, "linear", linear("my-linear"));
    expect(named.status).toBe(400);
    expect(named.body.error).toMatchObject({ code: "CONFIG_INVALID", message: "credentialRef: no linear connection called my-linear in your organization" });
    const wrongType = await s.put(MIA, "linear", linear(jira));
    expect(wrongType.body.error).toMatchObject({ code: "CONFIG_INVALID", message: `credentialRef: no linear connection called ${jira} in your organization` });
    expect(s.revisions()).toHaveLength(1);
    await s.fakeLinear.close();
  });

  it("refuses a connection that has no key saved yet", async () => {
    const s = await install();
    const id = await s.connection({ type: "linear", label: "Empty one", access: "read" }, null);
    const refused = await s.put(MIA, "linear", linear(id));
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatchObject({ code: "CONFIG_INVALID", message: "credentialRef: Empty one has no key saved yet; add one to the connection first" });
    expect(s.revisions()).toHaveLength(1);
    await s.fakeLinear.close();
  });

  it("refuses a tool approved to write on a read-only connection, naming the tool's place and the connection", async () => {
    const s = await install();
    const id = await s.connection({ type: "linear", label: "Team Linear", access: "read" });
    const refused = await s.put(MIA, "linear", linear(id, WRITE_TOOLS));
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatchObject({ code: "CONFIG_INVALID", message: "tools.2: Team Linear is read-only" });
    expect(s.revisions()).toHaveLength(1);
    expect(s.approvals()).toHaveLength(0);
    await s.fakeLinear.close();
  });

  it("refuses a bad shape without repeating a field name or a value: an unknown field, another type, a name that is not the path's", async () => {
    const s = await install();
    const id = await s.connection({ type: "linear", label: "Team Linear", access: "read" });
    const extra = await s.put(MIA, "linear", { ...linear(id), "apiKeyLin_SECRET_FIELD": "x" });
    expect(extra.body.error?.code).toBe("CONFIG_INVALID");
    expect(JSON.stringify(extra.body)).not.toContain("SECRET_FIELD");
    const asana = await s.put(MIA, "asana", { name: "asana", type: "asana", credentialRef: "x" });
    expect(asana.body.error).toMatchObject({ code: "CONFIG_INVALID", message: "type: a project connector is one of github, linear, jira, mcp, sentry, datadog, cloudwatch, github-actions, grafana, vercel, pagerduty" });
    // B-M2 (review): the refusal names every type PUT accepts, so a misspelt one is told what it could have been.
    const typo = await s.put(MIA, "sentyr", { name: "sentyr", type: "sentyr", credentialRef: "x" });
    expect(typo.body.error).toMatchObject({ code: "CONFIG_INVALID", message: "type: a project connector is one of github, linear, jira, mcp, sentry, datadog, cloudwatch, github-actions, grafana, vercel, pagerduty" });
    const named = await s.put(MIA, "other", linear(id));
    expect(named.body.error).toMatchObject({ code: "CONFIG_INVALID", message: "name: must be the name in the path" });
    expect((await s.put(MIA, "linear", "nope")).body.error).toMatchObject({ code: "CONFIG_INVALID", message: "connector: must be an object" });
    expect((await s.put(MIA, "Bad_Name", linear(id))).status).toBe(404);
    expect((await s.call(MIA, "PUT", "/v1/app/projects/web/connectors/linear", { expectedRevision: 1 })).body.error?.code).toBe("CONFIG_INVALID");
    expect(s.revisions()).toHaveLength(1);
    await s.fakeLinear.close();
  });

  it("refuses a request that names no revision, a stale one and one ahead, with PROJECT_REVISION_MISMATCH, writing nothing", async () => {
    const s = await install();
    const id = await s.connection({ type: "linear", label: "Team Linear", access: "read" });
    expect((await s.put(MIA, "linear", linear(id))).status).toBe(200);
    const stale = await s.put(MIA, "linear", linear(id, WRITE_TOOLS.slice(0, 2), { attribution: false }));
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: "PROJECT_REVISION_MISMATCH", message: STALE });
    const ahead = await s.put(MIA, "linear", linear(id, READ_TOOLS, { attribution: false }), { expectedRevision: 9 });
    expect(ahead.body.error).toMatchObject({ code: "PROJECT_REVISION_MISMATCH", message: STALE });
    const unnamed = await s.call(MIA, "PUT", "/v1/app/projects/web/connectors/linear", { connector: linear(id) });
    expect(unnamed.body.error).toMatchObject({ code: "CONFIG_INVALID" });
    expect(s.revisions()).toHaveLength(2);
    // The delete holds to a revision when it names one.
    expect((await s.del(MIA, "linear", { expectedRevision: 1 })).body.error).toMatchObject({ code: "PROJECT_REVISION_MISMATCH", message: STALE });
    expect(s.revisions()).toHaveLength(2);
    expect((await s.put(MIA, "linear", linear(id, READ_TOOLS, { attribution: false }), { expectedRevision: 2 })).status).toBe(200);
    await s.fakeLinear.close();
  });

  it("lets only one of two maintainers who save at once win, and the loser leaves no request item and no audit event", async () => {
    const s = await install();
    const id = await s.connection({ type: "linear", label: "Team Linear", access: "read" });
    const answers = await Promise.all([s.put(MIA, "linear", linear(id)), s.put(PETE, "linear", linear(id, READ_TOOLS, { attribution: false }))]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
    expect(answers.find((answer) => answer.status === 409)!.body.error).toMatchObject({ code: "PROJECT_REVISION_MISMATCH", message: STALE });
    expect(s.revisions()).toHaveLength(2);
    expect(s.requestItems()).toHaveLength(1);
    expect(s.audit.recordedBy("project_connector.changed")).toHaveLength(1);
    await s.fakeLinear.close();
  });

  it("does not believe a revision another request made first: two maintainers who save the very same connector at once, one wins and the other is told to reload", async () => {
    const s = await install();
    const id = await s.connection({ type: "linear", label: "Team Linear", access: "read" });
    const answers = await Promise.all([s.put(MIA, "linear", linear(id)), s.put(PETE, "linear", linear(id))]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
    expect(answers.find((answer) => answer.status === 409)!.body.error).toMatchObject({ code: "PROJECT_REVISION_MISMATCH", message: STALE });
    expect(s.revisions()).toHaveLength(2);
    expect(s.requestItems()).toHaveLength(1);
    expect(s.audit.recordedBy("project_connector.changed")).toHaveLength(1);
    await s.fakeLinear.close();
  });

  // Plan 4 Task 12 raised the most connectors a project holds from eight to twelve, to make room for the seven new types.
  it("holds a project to twelve connectors", async () => {
    const s = await install();
    const id = await s.connection({ type: "linear", label: "Team Linear", access: "read" });
    let revision = 1;
    for (const name of ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10", "a11", "a12"]) {
      const saved = await s.put(MIA, name, linear(id, READ_TOOLS, { name }), { expectedRevision: revision });
      expect(saved.status, name).toBe(200);
      revision += 1;
    }
    const thirteenth = await s.put(MIA, "a13", linear(id, READ_TOOLS, { name: "a13" }), { expectedRevision: revision });
    expect(thirteenth.status).toBe(400);
    expect(thirteenth.body.error?.code).toBe("CONFIG_INVALID");
    expect(s.revisions()).toHaveLength(revision);
    await s.fakeLinear.close();
  });
});

describe("a project that cannot be changed from the app", () => {
  it("refuses an archived project with PROJECT_ARCHIVED, on a change and on confirming a widening, and writes nothing", async () => {
    const s = await install();
    const id = await s.connection({ type: "linear", label: "Team Linear", access: "read" });
    s.h.db.set({ ...projectMetaKey(TEST_ORG, "web"), entityType: "PROJECT_META", name: "web", status: "archived", createdAt: "x", createdBy: "x" });
    const put = await s.put(MIA, "linear", linear(id));
    expect(put.status).toBe(409);
    expect(put.body.error).toMatchObject({ code: "PROJECT_ARCHIVED", message: "Project `web` is archived. Ask a project maintainer to restore it." });
    expect((await s.del(MIA, "linear")).body.error).toMatchObject({ code: "PROJECT_ARCHIVED" });
    // Reading is allowed: the connectors are as they were when it was archived.
    expect((await s.list(MIA)).status).toBe(200);
    expect(s.revisions()).toHaveLength(1);
    await s.fakeLinear.close();
  });

  it("refuses a revision that carries a setup approval, the way the settings route does, because only an administrator can register it", async () => {
    const s = await install();
    const id = await s.connection({ type: "linear", label: "Team Linear", access: "read" });
    s.h.db.set({ ...(s.h.db.get(projectRevisionKey(TEST_ORG, "web", 1)) as Record<string, unknown>), setupApproval: { proposalRef: "x", proposalSha256: "a".repeat(64), candidateDigest: "b", decision: "decline" } });
    const refused = await s.put(MIA, "linear", linear(id));
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("only an administrator can change") as string });
    expect(s.revisions()).toHaveLength(1);
    await s.fakeLinear.close();
  });
});

describe("Jira and MCP connections", () => {
  const CLOUD_ID = "5f2c1a9e-3b7d-4c6a-9e11-0a1b2c3d4e5f";
  const jira = (credentialRef: string, tools: unknown[] = [{ name: "getJiraIssue", access: "read" }]) => ({
    name: "jira", type: "jira", credentialRef, scopes: [{ alias: "acme", cloudId: CLOUD_ID }], tools,
  });
  const mcp = (credentialRef: string, extra: Record<string, unknown> = {}) => ({
    name: "sentry", type: "mcp", endpoint: "https://mcp.acme.dev/mcp", label: "Sentry issues", vendor: "Sentry", credentialRef,
    scopes: [{ alias: "main", values: { project: "p1" } }], scoping: { mode: "credential" }, tools: [{ name: "list_issues", access: "read" }], ...extra,
  });
  const JIRA_SECRET = { email: "admin@acme.dev", apiToken: "jira-token-0123456789" };

  it("attaches a Jira connection to a Jira connector, and refuses a write tool on a read-only one with the tool's place", async () => {
    const s = await install();
    const id = await s.connection({ type: "jira", label: "Our Jira", access: "read", siteUrl: "https://acme.atlassian.net" }, JIRA_SECRET);
    const saved = await s.put(MIA, "jira", jira(id));
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.connector).toMatchObject({ name: "jira", type: "jira", connectionId: id });
    const refused = await s.put(MIA, "jira", jira(id, [{ name: "getJiraIssue", access: "read" }, { name: "createJiraIssue", access: "write" }]), { expectedRevision: 2 });
    expect(refused.body.error).toMatchObject({ code: "CONFIG_INVALID", message: "tools.1: Our Jira is read-only" });
    expect(s.revisions()).toHaveLength(2);
    await s.fakeLinear.close();
  });

  it("attaches an MCP connection to an MCP connector for the same host, and refuses one for another host without writing a revision", async () => {
    const s = await install();
    const id = await s.connection({ type: "mcp", label: "Sentry", access: "read", endpoint: "https://mcp.acme.dev/mcp", vendor: "Sentry" }, { token: "sentry-token-0123456789" });
    const saved = await s.put(MIA, "sentry", mcp(id));
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.connector).toMatchObject({ name: "sentry", type: "mcp", connectionId: id, scopes: [{ alias: "main", values: { project: "p1" } }] });
    const elsewhere = await s.put(MIA, "sentry", mcp(id, { endpoint: "https://mcp.evil.example/mcp" }), { expectedRevision: 2 });
    expect(elsewhere.status).toBe(400);
    expect(elsewhere.body.error).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("pinned to mcp.acme.dev, not mcp.evil.example") as string });
    expect(JSON.stringify(elsewhere.body)).not.toContain("sentry-token");
    expect(s.revisions()).toHaveLength(2);
    await s.fakeLinear.close();
  });
});

describe("the GitHub connector", () => {
  const github = (scopes: unknown, extra: Record<string, unknown> = {}) => ({ name: "github", type: "github", scopes, tools: [{ name: "get_issue", access: "read" }], ...extra });

  it("takes the project's own repositories, with no credentialRef", async () => {
    const s = await install();
    const saved = await s.put(MIA, "github", github(["web"]));
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.connector).toMatchObject({ name: "github", type: "github", scopes: ["web"] });
    expect(saved.body.connector).not.toHaveProperty("connectionId");
    expect(s.revision(2)!.definition).toMatchObject({ revision: 2, integrations: { connectors: [github(["web"])] } });
    const all = await s.put(MIA, "github", github("all-repositories", { tools: [{ name: "get_issue", access: "read" }, { name: "list_issues", access: "read" }] }), { expectedRevision: 2 });
    expect(all.status).toBe(200);
    await s.fakeLinear.close();
  });

  it("refuses a scope that is a repository of another project, and a credentialRef, naming the scope's place and no field", async () => {
    const s = await install();
    const other = await s.put(MIA, "github", github(["api"]));
    expect(other.status).toBe(400);
    expect(other.body.error).toMatchObject({ code: "CONFIG_INVALID", message: "scopes.0: is not a repository of this project" });
    const mixed = await s.put(MIA, "github", github(["web", "api"]));
    expect(mixed.body.error).toMatchObject({ message: "scopes.1: is not a repository of this project" });
    const withRef = await s.put(MIA, "github", github(["web"], { credentialRef: "con_aaaaaaaaaaaaaaaaaaaa" }));
    expect(withRef.status).toBe(400);
    expect(JSON.stringify(withRef.body)).not.toContain("credentialRef");
    expect(s.revisions()).toHaveLength(1);
    await s.fakeLinear.close();
  });
});

describe("a tool newly approved to write waits for a person on the page (R9-3, R69)", () => {
  async function withReadConnector() {
    const s = await install();
    const id = await s.connection({ type: "linear", label: "Team Linear", access: "read_write" });
    const tools = [{ name: "list_issues", access: "read" }, { name: "save_issue", access: "read" }];
    expect((await s.put(MIA, "linear", linear(id, tools))).status).toBe(200);
    return { s, id, tools };
  }

  it("answers 202 with the page's address and the words for changing save_issue from read to write, and writes no revision", async () => {
    const { s, id } = await withReadConnector();
    const wide = [{ name: "list_issues", access: "read" }, { name: "save_issue", access: "write" }];
    const asked = await s.put(MIA, "linear", linear(id, wide), { expectedRevision: 2 });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body).toMatchObject({ status: "NEEDS_CONFIRMATION", confirmUrl: expect.stringMatching(/\/v1\/app\/approve\/apr_[0-9a-z]{20}$/) as string, changes: ["On web, lets the linear connector's save_issue tool make changes (it could only read before)"] });
    expect(s.revisions()).toHaveLength(2);
    expect(s.revision(2)!.definition).toMatchObject({ integrations: { connectors: [linear(id, [{ name: "list_issues", access: "read" }, { name: "save_issue", access: "read" }])] } });
    const [record] = s.approvals() as unknown as Array<ApprovalRecord & { subject: { kind: string; project: string; name: string; expectedRevision: number; connector: unknown } }>;
    expect(s.approvals()).toHaveLength(1);
    expect(record).toMatchObject({
      kind: "change", status: "PENDING", requestedBy: MIA.developerId,
      subject: { kind: "connector_widen", project: "web", name: "linear", expectedRevision: 2, connector: linear(id, wide) },
      approvers: { kind: "rule", rule: "project_settings" },
    });
    // The maintainers and the org admin are listed; the contributor and the viewer are not.
    const listed = (record!.approvers as unknown as { candidates: string[] }).candidates;
    expect(listed).toEqual(expect.arrayContaining([MIA.developerId, PETE.developerId, DANA.developerId]));
    expect(listed).not.toContain(CARL.developerId);
    expect(listed).not.toContain(VERA.developerId);
    await s.fakeLinear.close();
  });

  it("applies a new write tool on a new connector the same way, and a new connector with only reads at once", async () => {
    const s = await install();
    const id = await s.connection({ type: "linear", label: "Team Linear", access: "read_write" });
    const asked = await s.put(MIA, "linear", linear(id, WRITE_TOOLS));
    expect(asked.status).toBe(202);
    expect(asked.body["changes"]).toEqual(["On web, lets the linear connector's save_issue tool make changes"]);
    expect(s.revisions()).toHaveLength(1);
    expect((await s.put(MIA, "linear", linear(id, READ_TOOLS))).status).toBe(200);
    await s.fakeLinear.close();
  });

  it("applies at once: removing a write tool, turning write into read, adding read tools, and removing the connector", async () => {
    const s = await install();
    const id = await s.connection({ type: "linear", label: "Team Linear", access: "read_write" });
    // Seed a revision that already holds the write tool, as an administrator's registration would have written it.
    const wide = linear(id, WRITE_TOOLS);
    const first = s.revision(1)!;
    s.h.db.set({ ...projectRevisionKey(TEST_ORG, "web", 2), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-03T00:00:00.000Z", runtimeBinding: BINDING, definition: { ...first.definition, revision: 2, integrations: { connectors: [wide] } } });
    s.h.db.set({ ...orgProjectCatalogKey(TEST_ORG, "web"), entityType: "PROJECT_CATALOG", name: "web", latestRevision: 2, firstRegisteredAt: "2026-10-01T00:00:00.000Z" });
    // The same write tool stays write: nothing is newly approved, so it applies at once (and changes only a description).
    const same = await s.put(MIA, "linear", linear(id, [{ name: "list_issues", access: "read", description: "Lists issues" }, ...WRITE_TOOLS.slice(1)]), { expectedRevision: 2 });
    expect(same.status).toBe(200);
    expect(s.approvals()).toHaveLength(0);
    const removed = await s.put(MIA, "linear", linear(id, READ_TOOLS, { attribution: false }), { expectedRevision: 3 });
    expect(removed.status).toBe(200);
    expect(s.revision(4)!.definition).toMatchObject({ integrations: { connectors: [linear(id, READ_TOOLS, { attribution: false })] } });
    const narrowed = await s.put(MIA, "linear", linear(id, [{ name: "list_issues", access: "read" }, { name: "get_issue", access: "read" }, { name: "save_issue", access: "read" }], { attribution: false }), { expectedRevision: 4 });
    expect(narrowed.status).toBe(200);
    expect((await s.del(MIA, "linear", { expectedRevision: 5 })).status).toBe(200);
    expect(s.approvals()).toHaveLength(0);
    expect(s.revision(6)!.definition).not.toHaveProperty("integrations");
    await s.fakeLinear.close();
  });

  it("answers a repeat of the waiting request with the same page and record, and the same id for another change with CONFIG_INVALID", async () => {
    const { s, id } = await withReadConnector();
    const wide = [{ name: "list_issues", access: "read" }, { name: "save_issue", access: "write" }];
    const requestId = randomUUID();
    const first = await s.put(MIA, "linear", linear(id, wide), { expectedRevision: 2 }, requestId);
    const again = await s.put(MIA, "linear", linear(id, wide), { expectedRevision: 2 }, requestId);
    expect(again.status).toBe(202);
    expect(again.body).toEqual(first.body);
    expect(s.approvals()).toHaveLength(1);
    // The same id for a different connector, whether it would wait or apply at once, is a mistake.
    for (const other of [linear(id, wide, { attribution: false }), linear(id, [{ name: "list_issues", access: "read" }])]) {
      const reused = await s.put(MIA, "linear", other, { expectedRevision: 2 }, requestId);
      expect(reused.status).toBe(400);
      expect(reused.body.error).toMatchObject({ code: "CONFIG_INVALID", message: "requestId: this request ID was already used for a different request" });
    }
    expect(s.revisions()).toHaveLength(2);
    expect(s.approvals()).toHaveLength(1);
    // The repeat still finds its record after the project moved on, and after the record was decided it is closed, not asked again.
    expect((await s.put(PETE, "linear", linear(id, [{ name: "list_issues", access: "read" }, { name: "save_issue", access: "read" }], { attribution: false }), { expectedRevision: 2 })).status).toBe(200);
    expect((await s.put(MIA, "linear", linear(id, wide), { expectedRevision: 2 }, requestId)).body).toEqual(first.body);
    const record = s.approvals()[0]!;
    s.h.db.set({ ...record, status: "APPROVED_DONE" });
    const closed = await s.put(MIA, "linear", linear(id, wide), { expectedRevision: 2 }, requestId);
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ revision: 3, connector: { name: "linear" } });
    await s.fakeLinear.close();
  });

  it("does not wait for a person when the stored revision is not the one shown: a stale request is refused first", async () => {
    const { s, id } = await withReadConnector();
    const wide = [{ name: "list_issues", access: "read" }, { name: "save_issue", access: "write" }];
    const stale = await s.put(MIA, "linear", linear(id, wide), { expectedRevision: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: "PROJECT_REVISION_MISMATCH", message: STALE });
    expect(s.approvals()).toHaveLength(0);
    await s.fakeLinear.close();
  });

  it("refuses to ask about a change nobody could apply: a write tool on a read-only connection, and a connection of another org", async () => {
    const s = await install();
    const readOnly = await s.connection({ type: "linear", label: "Team Linear", access: "read" });
    expect((await s.put(MIA, "linear", linear(readOnly, WRITE_TOOLS))).body.error?.message).toBe("tools.2: Team Linear is read-only");
    expect((await s.put(OMAR, "linear", linear(readOnly, WRITE_TOOLS))).body.error?.message).toBe(`credentialRef: no linear connection called ${readOnly} in your organization`);
    expect(s.approvals()).toHaveLength(0);
    await s.fakeLinear.close();
  });
});

/** The deps the decide side runs on, built as the broker builds them (Tasks 7 and 8 call their handlers this way). */
function decideSide(s: Install) {
  const documentClient = { send: (command: unknown) => s.h.db.send(command as never) };
  const members = createProjectMembers({ documentClient, tableName: "state" });
  const registered: string[] = [];
  const deps: ApprovalDependencies = {
    store: new AgentStore({ documentClient, tableName: "state", now: Date.now }),
    projectMembers: members,
    documentClient, tableName: "state", signInStore: { getDeveloper: async () => undefined },
    now: Date.now, confirmOrigin: "https://cell.example", audit: s.audit.audit,
    projectConnectors: {
      cloud: true,
      connections: s.connectionStore,
      registerRevision: async (actor, input, extraItems) => {
        registered.push(`${actor.ownerKey}@${input.definition.revision}`);
        const { credentialsChecked, ...revision } = input;
        const { registerProjectFor } = await import("../../packages/broker/src/aws/broker.js");
        const result = await registerProjectFor(s.h.brokerInput as never, actor, { ...revision, preflight: true }, { creatorMembership: "none", extraItems, credentialsChecked });
        return { duplicate: result.duplicate, ...(result.preflight === undefined ? {} : { preflight: result.preflight }) };
      },
      preflight: async () => [],
    },
  };
  return { deps, registered };
}
const callerOf = (who: Developer, orgRole: OrgRole, orgId: OrgId = TEST_ORG): AgentCaller => ({ orgId, developerId: who.developerId, orgRole });

async function waitingWidening(s: Install) {
  const id = await s.connection({ type: "linear", label: "Team Linear", access: "read_write" });
  const tools = [{ name: "list_issues", access: "read" }, { name: "save_issue", access: "read" }];
  expect((await s.put(MIA, "linear", linear(id, tools))).status).toBe(200);
  const wide = linear(id, [{ name: "list_issues", access: "read" }, { name: "save_issue", access: "write" }]);
  const asked = await s.put(MIA, "linear", wide, { expectedRevision: 2 });
  expect(asked.status).toBe(202);
  const approvalId = String(asked.body["confirmUrl"]).split("/").pop()!;
  const record = (await getApproval({ documentClient: { send: (command: unknown) => s.h.db.send(command as never) }, tableName: "state" }, TEST_ORG, approvalId))!;
  return { id, wide, approvalId, record };
}

describe("who may confirm a widening, read now (R68)", () => {
  it("lets a maintainer of the project and an org owner or admin, and no contributor, viewer, outsider or person of another org", async () => {
    const s = await install();
    registerProjectConnectorApprovals();
    const { record } = await waitingWidening(s);
    const { deps } = decideSide(s);
    const rule = getApproverRule("project_settings")!;
    expect(await rule(deps, record, callerOf(MIA, "member"))).toBe(true);
    expect(await rule(deps, record, callerOf(PETE, "member"))).toBe(true);
    expect(await rule(deps, record, callerOf(DANA, "admin"))).toBe(true);
    expect(await rule(deps, record, callerOf(CARL, "member"))).toBe(false);
    expect(await rule(deps, record, callerOf(VERA, "member"))).toBe(false);
    expect(await rule(deps, record, callerOf(NOEL, "member"))).toBe(false);
    // A person of another org is no one here, whatever role they claim.
    expect(await rule(deps, record, callerOf(OMAR, "admin", ORG_B))).toBe(false);
    expect(await rule(deps, record, callerOf(OMAR, "admin", TEST_ORG))).toBe(false);
    // A person who is a member of the record's org, but whose session is in another org, is not asked here.
    expect(await rule(deps, record, callerOf(DANA, "admin", ORG_B))).toBe(false);
    expect(await rule(deps, record, callerOf(MIA, "member", ORG_B))).toBe(false);
    await s.fakeLinear.close();
  });

  it("reads the role again each time: a maintainer demoted since, or removed from the org, may not, while the stored candidates still list them", async () => {
    const s = await install();
    registerProjectConnectorApprovals();
    const { record } = await waitingWidening(s);
    const { deps } = decideSide(s);
    const rule = getApproverRule("project_settings")!;
    expect((record.approvers as unknown as { candidates: string[] }).candidates).toContain(MIA.developerId);
    expect(await rule(deps, record, callerOf(MIA, "member"))).toBe(true);
    s.grant(MIA, "contributor");
    expect(await rule(deps, record, callerOf(MIA, "member"))).toBe(false);
    s.grant(MIA, "maintainer");
    expect(await rule(deps, record, callerOf(MIA, "member"))).toBe(true);
    // Removed from the org: no membership row, so no role at all.
    s.h.db.delete(orgMemberKey(TEST_ORG, MIA.developerId));
    expect(await rule(deps, record, callerOf(MIA, "member"))).toBe(false);
    // An admin demoted to member is a maintainer only through a grant.
    s.h.db.set({ ...orgMemberKey(TEST_ORG, DANA.developerId), entityType: "ORG_MEMBER", orgId: TEST_ORG, developerId: DANA.developerId, role: "member", joinedAt: "x" });
    expect(await rule(deps, record, callerOf(DANA, "admin"))).toBe(false);
    await s.fakeLinear.close();
  });
});

describe("confirming a widening applies exactly the stored connector", () => {
  it("writes the next revision from the stored connector, keeps the other fields, and records the confirmer, the approval and the proof", async () => {
    const s = await install();
    registerProjectConnectorApprovals();
    const { wide, record, approvalId } = await waitingWidening(s);
    const { deps } = decideSide(s);
    const handler = getApprovalSubjectHandler("connector_widen")!;
    const proof: AuditProof = { kind: "fresh_sign_in", method: "email_code", authTime: "2026-10-22T10:00:00.000Z", sessionRef: "a".repeat(64) };
    await handler(deps, { ...record, status: "EXECUTING", decidedBy: PETE.developerId }, { proof });
    expect(s.revisions()).toHaveLength(3);
    const written = s.revision(3)!;
    expect(written.registeredBy).toBe(PETE.developerId);
    expect(written.definition).toEqual({ ...(s.revision(2)!.definition), revision: 3, integrations: { connectors: [wide] } });
    expect(s.h.db.get(orgProjectCatalogKey(TEST_ORG, "web"))).toMatchObject({ latestRevision: 3 });
    const event = s.audit.recordedBy("project_connector.changed").at(-1)!;
    expect(event).toMatchObject({
      actor: { kind: "member", id: PETE.developerId }, target: { kind: "connector" }, related: [approvalId], proof,
      facts: { connectorType: "linear", revision: 3, change: "widened" },
    });
    // The project's name is in details, never in a fact or an id.
    expect(JSON.stringify({ facts: event.facts, target: event.target })).not.toContain("web");
    expect(event.details).toEqual([{ subject: "org", fields: { project: "web", connector: "linear" } }]);
    await s.fakeLinear.close();
  });

  it("is done when applied again after it was applied (a decision re-driven), and writes no second revision or event", async () => {
    const s = await install();
    registerProjectConnectorApprovals();
    const { record, wide } = await waitingWidening(s);
    const { deps } = decideSide(s);
    const handler = getApprovalSubjectHandler("connector_widen")!;
    const decided = { ...record, status: "EXECUTING" as const, decidedBy: MIA.developerId };
    await handler(deps, decided);
    await expect(handler(deps, decided)).resolves.toBeUndefined();
    expect(s.revisions()).toHaveLength(3);
    expect(s.audit.recordedBy("project_connector.changed").filter((event) => event.facts?.["change"] === "widened")).toHaveLength(1);
    // Past the revision with the connector changed again, it is not applied again: the change is no longer there.
    expect((await s.put(PETE, "linear", { ...wide, tools: READ_TOOLS }, { expectedRevision: 3 })).status).toBe(200);
    await expect(handler(deps, decided)).rejects.toMatchObject({ code: "PROJECT_REVISION_MISMATCH" });
    expect(s.revisions()).toHaveLength(4);
    await s.fakeLinear.close();
  });

  it("applies nothing for a record whose connector or project cannot be what the route stored", async () => {
    const s = await install();
    registerProjectConnectorApprovals();
    const { record } = await waitingWidening(s);
    const { deps } = decideSide(s);
    const handler = getApprovalSubjectHandler("connector_widen")!;
    const subject = record.subject as ConnectorWidenSubject;
    for (const forged of [{ ...subject, name: "other" }, { ...subject, project: "../api" }]) {
      await expect(handler(deps, { ...record, subject: forged, decidedBy: MIA.developerId })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(s.revisions()).toHaveLength(2);
    await s.fakeLinear.close();
  });

  it("fails with the stale-settings text when the project moved on, and writes nothing", async () => {
    const s = await install();
    registerProjectConnectorApprovals();
    const { id, record } = await waitingWidening(s);
    expect((await s.put(PETE, "linear", linear(id, [{ name: "list_issues", access: "read" }, { name: "save_issue", access: "read" }], { attribution: false }), { expectedRevision: 2 })).status).toBe(200);
    const { deps } = decideSide(s);
    const refused = await getApprovalSubjectHandler("connector_widen")!(deps, { ...record, decidedBy: MIA.developerId }).then(() => undefined, (error: { code: string; message: string }) => error);
    expect(refused).toMatchObject({ code: "PROJECT_REVISION_MISMATCH" });
    expect(refused!.message).toContain(STALE);
    expect(s.revisions()).toHaveLength(3);
    await s.fakeLinear.close();
  });

  it("checks the connection again: one lowered to read-only, or removed, since the request is not written", async () => {
    const s = await install();
    registerProjectConnectorApprovals();
    const { id, record } = await waitingWidening(s);
    const { deps } = decideSide(s);
    const handler = getApprovalSubjectHandler("connector_widen")!;
    expect((await s.call(DANA, "PUT", `/v1/app/connections/${id}`, { connection: { type: "linear", label: "Team Linear", access: "read" } })).status).toBe(200);
    await expect(handler(deps, { ...record, decidedBy: MIA.developerId })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("tools.1: Team Linear is read-only") as string });
    expect((await s.call(DANA, "DELETE", `/v1/app/connections/${id}`, {})).status).toBe(200);
    await expect(handler(deps, { ...record, decidedBy: MIA.developerId })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining(`no linear connection called ${id}`) as string });
    expect(s.revisions()).toHaveLength(2);
    await s.fakeLinear.close();
  });

  it("applies nothing for a record nobody has decided, on an install that is not Rovara Cloud, or in an archived project", async () => {
    const s = await install();
    registerProjectConnectorApprovals();
    const { record } = await waitingWidening(s);
    const { deps } = decideSide(s);
    const handler = getApprovalSubjectHandler("connector_widen")!;
    await expect(handler(deps, record)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(handler({ ...deps, projectConnectors: { ...deps.projectConnectors!, cloud: false } }, { ...record, decidedBy: MIA.developerId })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining(PRIVATE) as string });
    const { projectConnectors: _unset, ...withoutConnectors } = deps; // eslint-disable-line @typescript-eslint/no-unused-vars -- the deployment has none
    await expect(handler(withoutConnectors, { ...record, decidedBy: MIA.developerId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    s.h.db.set({ ...projectMetaKey(TEST_ORG, "web"), entityType: "PROJECT_META", name: "web", status: "archived", createdAt: "x", createdBy: "x" });
    await expect(handler(deps, { ...record, decidedBy: MIA.developerId })).rejects.toMatchObject({ code: "PROJECT_ARCHIVED" });
    expect(s.revisions()).toHaveLength(2);
    await s.fakeLinear.close();
  });
});

describe("confirming on the page (Task 21a: the real apr kind)", () => {
  const CELL = "https://cell.example";
  function pageContext(s: Install, kind: DecideKind): { context: DecideRequestContext; store: DecideStore } {
    const store = new DecideStore({ documentClient: s.h.db, tableName: "signin", now: Date.now });
    const tokens = new Map([["Bearer mia", MIA], ["Bearer carl", CARL], ["Bearer dana", DANA]]);
    return {
      store,
      context: {
        store, now: Date.now, cellOrigin: CELL, kinds: { apr: kind },
        authenticateBearer: async (authorization) => {
          const who = tokens.get(authorization ?? "");
          if (who === undefined) throw Object.assign(new Error("AUTH_REQUIRED: bad token"), { code: "AUTH_REQUIRED" });
          return { developerId: who.developerId, orgId: TEST_ORG };
        },
      },
    };
  }
  const refusal = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; statusCode?: number; message: string }) => ({ code: error.code, status: error.statusCode }));

  it("sends a CLI or MCP token to the page (REAUTH_REQUIRED) and writes nothing; a contributor's token is refused with 403", async () => {
    const s = await install();
    registerProjectConnectorApprovals();
    const { approvalId } = await waitingWidening(s);
    const { context } = pageContext(s, approvalDecideKind(decideSide(s).deps));
    const request = (authorization: string) => ({ method: "POST", path: `/v1/app/approvals/${approvalId}/decide`, headers: { authorization }, body: "{}" });
    expect(await refusal(requireDecideSession(context, request("Bearer mia")))).toMatchObject({ code: "REAUTH_REQUIRED", status: 401 });
    expect(await refusal(requireDecideSession(context, request("Bearer dana")))).toMatchObject({ code: "REAUTH_REQUIRED", status: 401 });
    expect(await refusal(requireDecideSession(context, request("Bearer carl")))).toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(s.revisions()).toHaveLength(2);
    await s.fakeLinear.close();
  });

  it("lets a maintainer's fresh sign-in confirm: the page writes exactly that revision with the session's proof, and a contributor's session is refused", async () => {
    const s = await install();
    registerProjectConnectorApprovals();
    const { approvalId, wide } = await waitingWidening(s);
    const { context, store } = pageContext(s, approvalDecideKind(decideSide(s).deps));
    const sha = async (value: string) => (await import("node:crypto")).createHash("sha256").update(value).digest("hex");
    const open = async (who: Developer) => {
      const cookie = `cookie-${who.name}-${"x".repeat(40)}`;
      const signedInAt = Math.floor(Date.now() / 1000) - 30;
      await store.putSession(cookie, { orgId: TEST_ORG, developerId: who.developerId, approvalId, signedInAt, method: "email_code", csrfHash: await sha(csrfTokenFor(cookie)), expiresAt: signedInAt + 600 });
      return cookie;
    };
    const page = (cookie: string, fields: Record<string, string>) => routeDecidePage(context, {
      method: "POST", path: `/v1/app/approve/${approvalId}`, requestId: "r",
      headers: { origin: CELL, "content-type": "application/x-www-form-urlencoded", cookie: `${DECIDE_COOKIE}=${cookie}` },
      body: new URLSearchParams(fields).toString(),
    }, new URL(`${CELL}/v1/app/approve/${approvalId}`));
    const carl = await open(CARL);
    const refused = await page(carl, { csrf: csrfTokenFor(carl), decision: "approve" });
    expect(refused.statusCode).toBe(403);
    expect(s.revisions()).toHaveLength(2);
    const mia = await open(MIA);
    const done = await page(mia, { csrf: csrfTokenFor(mia), decision: "approve" });
    expect(done.statusCode, done.body).toBe(200);
    expect(s.revisions()).toHaveLength(3);
    expect(s.revision(3)!.definition).toMatchObject({ revision: 3, integrations: { connectors: [wide] } });
    expect(s.audit.recordedBy("project_connector.changed").at(-1)).toMatchObject({
      actor: { kind: "member", id: MIA.developerId }, proof: { kind: "fresh_sign_in", method: "email_code" }, facts: { change: "widened", revision: 3 },
    });
    expect(await getApproval({ documentClient: { send: (command: unknown) => s.h.db.send(command as never) }, tableName: "state" }, TEST_ORG, approvalId)).toMatchObject({ status: "APPROVED_DONE", decidedBy: MIA.developerId });
    await s.fakeLinear.close();
  });
});

describe("confirming a widening end to end (Task 13 m5)", () => {
  const CELL = "https://cell.example";
  /** Opens the confirmation page for `who` and posts `decision` with its own CSRF token, through the real `apr` kind. */
  async function decideOnPage(s: Install, approvalId: string, who: Developer, decision: "approve" | "decline") {
    const store = new DecideStore({ documentClient: s.h.db, tableName: "signin", now: Date.now });
    const context: DecideRequestContext = { store, now: Date.now, cellOrigin: CELL, kinds: { apr: approvalDecideKind(decideSide(s).deps) } };
    const cookie = `cookie-${who.name}-${decision}-${"x".repeat(30)}`;
    const sha = (await import("node:crypto")).createHash("sha256");
    const signedInAt = Math.floor(Date.now() / 1000) - 30;
    await store.putSession(cookie, { orgId: TEST_ORG, developerId: who.developerId, approvalId, signedInAt, method: "email_code", csrfHash: sha.update(csrfTokenFor(cookie)).digest("hex"), expiresAt: signedInAt + 600 });
    const response = await routeDecidePage(context, {
      method: "POST", path: `/v1/app/approve/${approvalId}`, requestId: "r",
      headers: { origin: CELL, "content-type": "application/x-www-form-urlencoded", cookie: `${DECIDE_COOKIE}=${cookie}` },
      body: new URLSearchParams({ csrf: csrfTokenFor(cookie), decision }).toString(),
    }, new URL(`${CELL}/v1/app/approve/${approvalId}`));
    return response;
  }
  const recordOf = (s: Install, approvalId: string) => getApproval({ documentClient: { send: (command: unknown) => s.h.db.send(command as never) }, tableName: "state" }, TEST_ORG, approvalId);

  it("ends APPROVED_FAILED with the stale-settings words when the project moved on before the confirm, and writes no revision", async () => {
    const s = await install();
    registerProjectConnectorApprovals();
    const { id, approvalId } = await waitingWidening(s);
    // Someone else changes the project's settings after the widening was asked for.
    expect((await s.put(PETE, "linear", linear(id, [{ name: "list_issues", access: "read" }, { name: "save_issue", access: "read" }], { attribution: false }), { expectedRevision: 2 })).status).toBe(200);
    expect(s.revisions()).toHaveLength(3);
    const page = await decideOnPage(s, approvalId, MIA, "approve");
    expect(page.body).toContain(STALE.replace("'", "&#39;"));
    expect(page.body).toContain("did not go through");
    expect(await recordOf(s, approvalId)).toMatchObject({ status: "APPROVED_FAILED", decidedBy: MIA.developerId });
    expect(String((await recordOf(s, approvalId))?.failure)).toContain(STALE);
    expect(s.revisions()).toHaveLength(3);
    await s.fakeLinear.close();
  });

  it("writes nothing when a maintainer declines", async () => {
    const s = await install();
    registerProjectConnectorApprovals();
    const { approvalId } = await waitingWidening(s);
    const page = await decideOnPage(s, approvalId, MIA, "decline");
    expect(page.statusCode, page.body).toBe(200);
    expect(page.body).toContain("Declined");
    expect(await recordOf(s, approvalId)).toMatchObject({ status: "DECLINED", decidedBy: MIA.developerId });
    expect(s.revisions()).toHaveLength(2);
    expect(s.audit.recordedBy("project_connector.changed").filter((event) => (event.facts as { change?: string }).change === "widened")).toHaveLength(0);
    await s.fakeLinear.close();
  });
});

describe("a repeated request (R18)", () => {
  it("answers the stored outcome and writes nothing for a PUT sent twice, and CONFIG_INVALID for the same id with another connector", async () => {
    const s = await install();
    const id = await s.connection({ type: "linear", label: "Team Linear", access: "read" });
    const requestId = randomUUID();
    const first = await s.put(MIA, "linear", linear(id), {}, requestId);
    expect(first.status).toBe(200);
    const again = await s.put(MIA, "linear", linear(id), {}, requestId);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ revision: 2, connector: { name: "linear", connectionId: id, status: "connected" } });
    expect(s.revisions()).toHaveLength(2);
    expect(s.audit.recordedBy("project_connector.changed")).toHaveLength(1);
    const reused = await s.put(MIA, "linear", linear(id, READ_TOOLS, { attribution: false }), {}, requestId);
    expect(reused.status).toBe(400);
    expect(reused.body.error).toMatchObject({ code: "CONFIG_INVALID", message: "requestId: this request ID was already used for a different request" });
    // The same id for another project or another connector is another request too.
    expect((await s.put(MIA, "other", linear(id, READ_TOOLS, { name: "other" }), {}, requestId)).body.error).toMatchObject({ code: "CONFIG_INVALID" });
    expect(s.revisions()).toHaveLength(2);
    await s.fakeLinear.close();
  });

  it("leaves a late repeat of a PUT unchanged after the connector was removed: it answers what it did and writes nothing", async () => {
    const s = await install();
    const id = await s.connection({ type: "linear", label: "Team Linear", access: "read" });
    const requestId = randomUUID();
    expect((await s.put(MIA, "linear", linear(id), {}, requestId)).status).toBe(200);
    expect((await s.del(MIA, "linear", { expectedRevision: 2 })).status).toBe(200);
    expect(s.revisions()).toHaveLength(3);
    const late = await s.put(MIA, "linear", linear(id), {}, requestId);
    expect(late.status).toBe(200);
    expect(late.body).toMatchObject({ revision: 2, connector: { name: "linear", status: "unavailable" } });
    expect(s.revisions()).toHaveLength(3);
    expect(s.revision(3)!.definition).not.toHaveProperty("integrations");
    await s.fakeLinear.close();
  });

  it("answers a DELETE sent twice from the stored outcome, and a repeat after the same name was added again changes nothing", async () => {
    const s = await install();
    const id = await s.connection({ type: "linear", label: "Team Linear", access: "read" });
    expect((await s.put(MIA, "linear", linear(id))).status).toBe(200);
    const requestId = randomUUID();
    const first = await s.del(MIA, "linear", { expectedRevision: 2 }, requestId);
    expect(first.body).toEqual({ removed: { name: "linear" }, revision: 3 });
    expect((await s.put(MIA, "linear", linear(id), { expectedRevision: 3 })).status).toBe(200);
    const again = await s.del(MIA, "linear", { expectedRevision: 2 }, requestId);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(s.revisions()).toHaveLength(4);
    expect(s.revision(4)!.definition).toMatchObject({ integrations: { connectors: [linear(id)] } });
    await s.fakeLinear.close();
  });

  it("writes the request item with an expiry, in the same transaction as the revision and its audit item, and when that transaction fails none of them lands", async () => {
    const s = await install();
    const id = await s.connection({ type: "linear", label: "Team Linear", access: "read" });
    const sent = vi.spyOn(s.h.db, "send");
    const requestId = randomUUID();
    expect((await s.put(MIA, "linear", linear(id), {}, requestId)).status).toBe(200);
    const items = s.requestItems().filter((item) => String(item.sk).endsWith(requestId));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) as string, result: { revision: 2, connector: linear(id) } });
    expect(typeof items[0]!["indexExpiresAt"]).toBe("number");
    type Written = { Put?: { Item?: { entityType?: string; pk?: string } }; Update?: { Key?: { pk?: string; sk?: string } } };
    const calls = sent.mock.calls as unknown as Array<[{ constructor: { name: string }; input: { TransactItems?: Written[] } }]>;
    const transactions = calls.map(([command]) => command)
      .filter((command) => command.constructor.name === "TransactWriteCommand").map((command) => command.input.TransactItems ?? [])
      .filter((written) => written.some((item) => item.Put?.Item?.entityType === "PROJECT"));
    expect(transactions).toHaveLength(1);
    const [one] = transactions;
    expect(one!.map((item) => item.Put?.Item?.entityType ?? "update")).toEqual(expect.arrayContaining(["PROJECT", "AGENT_REQUEST"]));
    expect(one!.some((item) => item.Put?.Item?.pk?.startsWith("AUDIT_PENDING#") === true)).toBe(true);
    expect(one!.some((item) => item.Update?.Key?.sk === "CATALOG" || item.Update?.Key?.pk?.includes("CATALOG") === true)).toBe(true);
    expect(one!.length).toBeLessThanOrEqual(10);
    sent.mockRestore();
    // The same change when the transaction fails: no revision, no request item, no audit item.
    const before = { revisions: s.revisions().length, requests: s.requestItems().length, events: s.audit.pendingItems().length };
    s.h.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("PROJECT"), error: { name: "InternalServerError" } });
    const failed = await s.put(MIA, "linear", linear(id, READ_TOOLS, { attribution: false }), { expectedRevision: 2 });
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect({ revisions: s.revisions().length, requests: s.requestItems().length, events: s.audit.pendingItems().length }).toEqual(before);
    await s.fakeLinear.close();
  });

  it("records a change that leaves the connectors as they are as a request item alone, without a revision or an event", async () => {
    const s = await install();
    const id = await s.connection({ type: "linear", label: "Team Linear", access: "read" });
    expect((await s.put(MIA, "linear", linear(id))).status).toBe(200);
    const events = s.audit.recordedBy("project_connector.changed").length;
    const requestId = randomUUID();
    const same = await s.put(MIA, "linear", linear(id), { expectedRevision: 2 }, requestId);
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ revision: 2, connector: { status: "connected" } });
    expect(s.revisions()).toHaveLength(2);
    expect(s.audit.recordedBy("project_connector.changed")).toHaveLength(events);
    expect(s.requestItems().filter((item) => String(item.sk).endsWith(requestId))).toHaveLength(1);
    // And its repeat finds that item.
    expect((await s.put(MIA, "linear", linear(id), { expectedRevision: 2 }, requestId)).status).toBe(200);
    await s.fakeLinear.close();
  });

  it("answers DELETE of a connector that is not there with 404 and leaves nothing", async () => {
    const s = await install();
    const gone = await s.del(MIA, "linear");
    expect(gone.status).toBe(404);
    expect(gone.body.error).toMatchObject({ code: "NOT_FOUND", message: "no connector has that name" });
    expect(s.revisions()).toHaveLength(1);
    expect(s.requestItems()).toHaveLength(0);
    await s.fakeLinear.close();
  });
});

describe("what the chain records", () => {
  it("records added, updated and removed with the revision as the occurrence, the person as the actor, and no secret or name in a fact", async () => {
    const s = await install();
    const id = await s.connection({ type: "linear", label: "Team Linear", access: "read" });
    expect((await s.put(MIA, "linear", linear(id))).status).toBe(200);
    expect((await s.put(PETE, "linear", linear(id, READ_TOOLS, { attribution: false }), { expectedRevision: 2 })).status).toBe(200);
    expect((await s.del(DANA, "linear", { expectedRevision: 3 })).status).toBe(200);
    const events = s.audit.recordedBy("project_connector.changed");
    expect(events.map((event) => ({ actor: event.actor.id, facts: event.facts }))).toEqual([
      { actor: MIA.developerId, facts: { connectorType: "linear", revision: 2, change: "added" } },
      { actor: PETE.developerId, facts: { connectorType: "linear", revision: 3, change: "updated" } },
      { actor: DANA.developerId, facts: { connectorType: "linear", revision: 4, change: "removed" } },
    ]);
    expect(new Set(events.map((event) => event.eventId)).size).toBe(3);
    expect(new Set(events.map((event) => JSON.stringify(event.target))).size).toBe(1);
    expect(JSON.stringify(events)).not.toContain(LINEAR_KEY);
    expect(events[0]!.target).toEqual({ kind: "connector", id: expect.stringMatching(/^cnr_[0-9a-f]{24}$/) as string });
    await s.fakeLinear.close();
  });

  it("records nothing for a refused change or a change that waits", async () => {
    const s = await install();
    const id = await s.connection({ type: "linear", label: "Team Linear", access: "read_write" });
    await s.put(CARL, "linear", linear(id));
    await s.put(MIA, "linear", linear("con_zzzzzzzzzzzzzzzzzzzz"));
    expect((await s.put(MIA, "linear", linear(id, WRITE_TOOLS))).status).toBe(202);
    expect(s.audit.recordedBy("project_connector.changed")).toEqual([]);
    await s.fakeLinear.close();
  });
});

describe("route precedence (PF24)", () => {
  it("answers …/connectors/github/comment-triggers with Task 14b's route, not as the connector named github", async () => {
    const s = await install();
    const admins = [DANA, OMAR];
    for (const who of [MIA, DANA, CARL, NOEL, OMAR]) {
      for (const [method, body] of [["GET", undefined], ["PUT", { enabled: true }], ["DELETE", {}]] as const) {
        const reply = await s.call(who, method, "/v1/app/projects/web/connectors/github/comment-triggers", body);
        const label = `${who.name} ${method}`;
        if (method === "DELETE") {
          // Task 14b's route reads and sets an opt-out; it has no DELETE, and the connector named github is not touched.
          expect(reply.status, label).toBe(404);
          expect(reply.body.error?.message, label).toBe("route not found");
        } else if (admins.includes(who)) {
          // Only an org owner or admin reaches the opt-out itself (this install has no repository reader, and the PUT names no repository).
          expect(reply.status, label).toBe(method === "GET" ? 404 : 400);
          expect(reply.body.error?.code, label).toBe(method === "GET" ? "NOT_FOUND" : "CONFIG_INVALID");
          if (method === "GET") expect(reply.body.error?.message, label).toMatch(/comment-triggered workflows/);
        } else {
          expect(reply.status, label).toBe(403);
          expect(reply.body.error?.code, label).toBe("FORBIDDEN");
          expect(reply.body.error?.message, label).toMatch(/comment-triggered workflow rule/);
        }
      }
    }
    expect(s.revisions()).toHaveLength(1);
    expect(s.approvals()).toHaveLength(0);
    // The connector named github is still reachable on its own path.
    const saved = await s.put(MIA, "github", { name: "github", type: "github", scopes: ["web"], tools: [{ name: "get_issue", access: "read" }] });
    expect(saved.status).toBe(200);
    expect((await s.list(MIA)).body.connectors).toMatchObject([{ name: "github" }]);
    await s.fakeLinear.close();
  });

  it("answers any deeper path and any other method under connectors as not found", async () => {
    const s = await install();
    for (const [method, path] of [["GET", "/v1/app/projects/web/connectors/linear/extra"], ["POST", "/v1/app/projects/web/connectors"], ["GET", "/v1/app/projects/web/connectors/linear"], ["POST", "/v1/app/projects/web/connectors/linear"], ["GET", "/v1/app/projects/web/connectors/"]] as const) {
      const reply = await s.call(MIA, method, path, method === "POST" ? {} : undefined);
      expect(reply.status, `${method} ${path}`).toBe(404);
    }
    await s.fakeLinear.close();
  });
});

/** Writes the next revision as an administrator's registration would have, holding `connectors` (so a write tool that was confirmed earlier is already there). */
function seedConnectors(s: Install, connectors: unknown[]): number {
  const latest = s.revisions().length;
  const previous = s.revision(latest)!;
  const next = latest + 1;
  s.h.db.set({ ...projectRevisionKey(TEST_ORG, "web", next), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-03T00:00:00.000Z", runtimeBinding: BINDING, definition: { ...previous.definition, revision: next, integrations: { connectors } } });
  s.h.db.set({ ...orgProjectCatalogKey(TEST_ORG, "web"), entityType: "PROJECT_CATALOG", name: "web", latestRevision: next, firstRegisteredAt: "2026-10-01T00:00:00.000Z" });
  return next;
}
const sentry = (credentialRef: string, extra: Record<string, unknown> = {}) => ({
  name: "sentry", type: "mcp", endpoint: "https://mcp.acme.dev/mcp", label: "Sentry issues", vendor: "Sentry", credentialRef,
  scopes: [{ alias: "main", values: { project: "p1" } }], scoping: { mode: "credential", acknowledgeUnscopedWrites: true }, tools: [{ name: "save_issue", access: "write" }], ...extra,
});
const OTHER_TEAM = "0b6f3f7e-5d1a-4c1e-9a53-2f0f5a8f1c11";

describe("a confirmed write tool does not move without the page (C1)", () => {
  async function confirmed() {
    const s = await install();
    const a = await s.connection({ type: "linear", label: "Team A", access: "read_write" });
    const b = await s.connection({ type: "linear", label: "Team B", access: "read_write" });
    const mcpId = await s.connection({ type: "mcp", label: "Sentry", access: "read_write", endpoint: "https://mcp.acme.dev/mcp", vendor: "Sentry" }, { token: "sentry-token-0123456789" });
    const revision = seedConnectors(s, [linear(a, WRITE_TOOLS)]);
    return { s, a, b, mcpId, revision };
  }

  it("asks for the page when the connector moves to another connection, and not when it keeps only read tools", async () => {
    const { s, b, revision } = await confirmed();
    const asked = await s.put(MIA, "linear", linear(b, WRITE_TOOLS), { expectedRevision: revision });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body["changes"]).toEqual([`On web, lets the linear connector's save_issue tool make changes (now on connection ${b})`]);
    expect(s.revisions()).toHaveLength(revision);
    expect(s.approvals()).toHaveLength(1);
    // Read tools only: the new connection gets no write reach, so the change applies at once.
    const narrowed = await s.put(MIA, "linear", linear(b, READ_TOOLS), { expectedRevision: revision });
    expect(narrowed.status).toBe(200);
    expect(s.revisions()).toHaveLength(revision + 1);
    await s.fakeLinear.close();
  });

  it("asks for the page when the connector becomes another type", async () => {
    const { s, mcpId, revision } = await confirmed();
    const asked = await s.put(MIA, "linear", { ...sentry(mcpId), name: "linear", tools: [{ name: "save_issue", access: "write" }] }, { expectedRevision: revision });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body["changes"]).toEqual(["On web, lets the linear connector's save_issue tool make changes (now an mcp connector)"]);
    expect(s.revisions()).toHaveLength(revision);
    await s.fakeLinear.close();
  });

  it("asks for the page when an MCP connector's endpoint or bind moves, and applies the same connector at once", async () => {
    const { s, mcpId, revision } = await confirmed();
    const first = await s.put(MIA, "sentry", sentry(mcpId), { expectedRevision: revision });
    expect(first.status).toBe(202); // a new connector with a write tool
    const at = seedConnectors(s, [sentry(mcpId)]);
    expect((await s.put(MIA, "sentry", sentry(mcpId, { label: "Renamed" }), { expectedRevision: at })).status).toBe(200);
    const moved = await s.put(MIA, "sentry", sentry(mcpId, { endpoint: "https://mcp.acme.dev/other" }), { expectedRevision: at + 1 });
    expect(moved.status).toBe(202);
    expect(moved.body["changes"]).toEqual(["On web, lets the sentry connector's save_issue tool make changes (now at another address)"]);
    const bound = await s.put(MIA, "sentry", sentry(mcpId, { bind: { required: { project: "project" } } }), { expectedRevision: at + 1 });
    expect(bound.status).toBe(202);
    expect(s.revisions()).toHaveLength(at + 1);
    await s.fakeLinear.close();
  });
});

describe("a scope added to a connector that writes waits for the page (I3)", () => {
  it("asks for the page for a new team or alias on a Linear connector with a write tool, and not for a narrower or read-only one", async () => {
    const s = await install();
    const id = await s.connection({ type: "linear", label: "Team Linear", access: "read_write" });
    const revision = seedConnectors(s, [linear(id, WRITE_TOOLS)]);
    const two = { scopes: [{ alias: "charterarc", teamId: CHARTERARC_TEAM_ID }, { alias: "other", teamId: OTHER_TEAM }] };
    const asked = await s.put(MIA, "linear", linear(id, WRITE_TOOLS, two), { expectedRevision: revision });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body["changes"]).toEqual(["On web, lets the linear connector's write tools reach one more scope (other)"]);
    expect(s.revisions()).toHaveLength(revision);
    // The same scopes with only read tools are not a widening.
    expect((await s.put(MIA, "linear", linear(id, READ_TOOLS, two), { expectedRevision: revision })).status).toBe(200);
    // And going back to one team, with the write tool kept, is a narrowing.
    const wide = seedConnectors(s, [linear(id, WRITE_TOOLS, two)]);
    expect((await s.put(MIA, "linear", linear(id, WRITE_TOOLS), { expectedRevision: wide })).status).toBe(200);
    await s.fakeLinear.close();
  });

  it("asks for the page for all repositories on a GitHub connector with a write tool", async () => {
    const s = await install();
    const github = (scopes: unknown) => ({ name: "github", type: "github", scopes, tools: [{ name: "create_issue", access: "write" }] });
    const revision = seedConnectors(s, [github(["web"])]);
    const asked = await s.put(MIA, "github", github("all-repositories"), { expectedRevision: revision });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body["changes"]).toEqual(["On web, lets the github connector's write tools reach all repositories"]);
    expect(s.revisions()).toHaveLength(revision);
    await s.fakeLinear.close();
  });
});

describe("a removed connection does not block the other connectors (I1)", () => {
  async function broken() {
    const s = await install();
    const gone = await s.connection({ type: "linear", label: "Gone Linear", access: "read_write" });
    const alive = await s.connection({ type: "linear", label: "Live Linear", access: "read_write" });
    const revision = seedConnectors(s, [linear(gone, WRITE_TOOLS), linear(alive, WRITE_TOOLS, { name: "other" })]);
    expect((await s.call(DANA, "DELETE", `/v1/app/connections/${gone}`, {})).status).toBe(200);
    return { s, gone, alive, revision };
  }

  it("lets another connector be added, narrowed and changed, and the broken one be removed", async () => {
    const { s, alive, revision } = await broken();
    const added = await s.put(MIA, "third", linear(alive, READ_TOOLS, { name: "third" }), { expectedRevision: revision });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    const narrowed = await s.put(MIA, "other", linear(alive, READ_TOOLS, { name: "other" }), { expectedRevision: revision + 1 });
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
    // The broken one shows as not connected, and a narrowing or removal of it itself goes through.
    const read = await s.list(MIA);
    expect(read.body.connectors).toEqual(expect.arrayContaining([expect.objectContaining({ name: "linear", status: "not_connected" })]));
    const narrowedBroken = await s.put(MIA, "linear", linear(String(read.body.connectors!.find((c) => c["name"] === "linear")!["connectionId"]), READ_TOOLS), { expectedRevision: revision + 2 });
    expect(narrowedBroken.status, JSON.stringify(narrowedBroken.body)).toBe(200);
    expect((await s.del(MIA, "linear")).status).toBe(200);
    await s.fakeLinear.close();
  });

  it("still refuses to give the broken connector new write reach, or to move it to a connection that is not there, in the plan's words", async () => {
    const { s, gone, revision } = await broken();
    const more = await s.put(MIA, "linear", linear(gone, [...WRITE_TOOLS, { name: "save_comment", access: "write" }]), { expectedRevision: revision });
    expect(more.status).toBe(400);
    expect(more.body.error).toMatchObject({ code: "CONFIG_INVALID", message: `credentialRef: no linear connection called ${gone} in your organization` });
    expect(s.revisions()).toHaveLength(revision);
    await s.fakeLinear.close();
  });

  it("words a registration refusal for a missing connection for a cloud user, naming the connector and what to do", async () => {
    const { credentialRefusals } = await import("../../packages/broker/src/aws/registration-preflight.js");
    const connector = { name: "linear", vendor: "Linear", credential: { ref: "con_aaaaaaaaaaaaaaaaaaaa", accepts: ["static-secret"] } } as never;
    const registry = { typeOf: async () => undefined, registration: async () => undefined } as never;
    expect(await credentialRefusals([connector], registry)).toEqual(["linear: its connection was removed; remove this connector or pick another connection first"]);
    const legacy = { name: "linear", vendor: "Linear", credential: { ref: "my-linear", accepts: ["static-secret"] } } as never;
    expect((await credentialRefusals([legacy], registry))[0]).toContain("is not registered; run");
  });
});

describe("what a viewer is told of a connector's status (I2)", () => {
  it("gives the status and a fixed sentence to a viewer and the vendor's text only to a maintainer", async () => {
    const s = await install();
    const id = await s.connection({ type: "linear", label: "Team Linear", access: "read" });
    expect((await s.put(MIA, "linear", linear(id))).status).toBe(200);
    expect((await s.call(DANA, "DELETE", `/v1/app/connections/${id}`, {})).status).toBe(200);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 120_000 });
    const viewer = (await s.list(VERA)).body.connectors![0]!;
    expect(viewer).toMatchObject({ name: "linear", status: "not_connected", problem: "ask a maintainer of this project why it is not connected" });
    expect(String(viewer["problem"])).not.toContain("con_");
    const maintainer = (await s.list(MIA)).body.connectors![0]!;
    expect(String(maintainer["problem"])).toContain(`credential ${id} is not registered`);
    // A connected connector has no problem for anyone.
    await s.fakeLinear.close();
  });

  it("asks the vendors once in a minute for the same revision, and again after that", async () => {
    const s = await install();
    const id = await s.connection({ type: "linear", label: "Team Linear", access: "read" });
    expect((await s.put(MIA, "linear", linear(id))).status).toBe(200);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 120_000 });
    const asked = () => s.fakeLinear.headers.length;
    const first = await s.list(CARL);
    expect(first.body.connectors).toMatchObject([{ status: "connected" }]);
    const afterFirst = asked();
    expect(afterFirst).toBeGreaterThan(0);
    for (const who of [CARL, VERA, MIA, DANA]) expect((await s.list(who)).body.connectors).toMatchObject([{ status: "connected" }]);
    expect(asked()).toBe(afterFirst);
    vi.setSystemTime(Date.now() + 61_000);
    await s.list(CARL);
    expect(asked()).toBeGreaterThan(afterFirst);
    // Another revision is another key: the page for a changed project is checked at once, not from the old revision's answer.
    await s.list(CARL);
    expect((await s.put(MIA, "linear", linear(id, READ_TOOLS, { attribution: false }), { expectedRevision: 2 })).status).toBe(200);
    const before = asked();
    await s.list(CARL);
    expect(asked()).toBeGreaterThan(before);
    await s.fakeLinear.close();
  });
});

describe("DELETE holds to the revision and to its request id (m1, m2)", () => {
  it("requires expectedRevision and refuses a stale one, so a connector added again under the name is not removed by an old click", async () => {
    const s = await install();
    const id = await s.connection({ type: "linear", label: "Team Linear", access: "read" });
    expect((await s.put(MIA, "linear", linear(id))).status).toBe(200);
    const unnamed = await s.call(MIA, "DELETE", "/v1/app/projects/web/connectors/linear", {});
    expect(unnamed.status).toBe(400);
    expect(unnamed.body.error).toMatchObject({ code: "CONFIG_INVALID", message: "expectedRevision: Invalid input: expected number, received undefined" });
    expect((await s.del(MIA, "linear", { expectedRevision: 1 })).body.error).toMatchObject({ code: "PROJECT_REVISION_MISMATCH", message: STALE });
    expect(s.revisions()).toHaveLength(2);
    await s.fakeLinear.close();
  });

  it("does not let a request id that made a waiting widening be used for a DELETE, and the PUT's repeat still finds its page", async () => {
    const s = await install();
    const id = await s.connection({ type: "linear", label: "Team Linear", access: "read_write" });
    const revision = seedConnectors(s, [linear(id, [{ name: "list_issues", access: "read" }, { name: "save_issue", access: "read" }])]);
    const requestId = randomUUID();
    const first = await s.put(MIA, "linear", linear(id, WRITE_TOOLS), { expectedRevision: revision }, requestId);
    expect(first.status).toBe(202);
    const reused = await s.del(MIA, "linear", { expectedRevision: revision }, requestId);
    expect(reused.status).toBe(400);
    expect(reused.body.error).toMatchObject({ code: "CONFIG_INVALID", message: "requestId: this request ID was already used for a different request" });
    expect(s.revisions()).toHaveLength(revision);
    expect(s.requestItems()).toHaveLength(0);
    expect((await s.put(MIA, "linear", linear(id, WRITE_TOOLS), { expectedRevision: revision }, requestId)).body).toEqual(first.body);
    await s.fakeLinear.close();
  });
});

describe("a repeat of a widening after it was decided answers what happened (m3)", () => {
  it("answers the current revision and the connector for a widening that was applied, and the outcome for the others", async () => {
    const s = await install();
    registerProjectConnectorApprovals();
    const id = await s.connection({ type: "linear", label: "Team Linear", access: "read_write" });
    const revision = seedConnectors(s, [linear(id, [{ name: "list_issues", access: "read" }, { name: "save_issue", access: "read" }])]);
    const requestId = randomUUID();
    const body = linear(id, WRITE_TOOLS);
    const first = await s.put(MIA, "linear", body, { expectedRevision: revision }, requestId);
    expect(first.status).toBe(202);
    const approvalId = String(first.body["confirmUrl"]).split("/").pop()!;
    const { deps } = decideSide(s);
    const record = (await getApproval({ documentClient: { send: (command: unknown) => s.h.db.send(command as never) }, tableName: "state" }, TEST_ORG, approvalId))!;
    await getApprovalSubjectHandler("connector_widen")!(deps, { ...record, status: "EXECUTING", decidedBy: PETE.developerId });
    const stored = s.h.db.get(approvalKey(TEST_ORG, approvalId))!;
    s.h.db.set({ ...stored, status: "APPROVED_DONE", decidedBy: PETE.developerId });
    const done = await s.put(MIA, "linear", body, { expectedRevision: revision }, requestId);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ revision: revision + 1, connector: { name: "linear", status: "connected", tools: [{ name: "list_issues" }, { name: "get_issue" }, { name: "save_issue", access: "write" }] } });
    expect(s.revisions()).toHaveLength(revision + 1);
    for (const [status, extra] of [["DECLINED", {}], ["EXPIRED", {}], ["APPROVED_FAILED", { failure: "PROJECT_REVISION_MISMATCH: someone changed this project's settings; reload and try again" }]] as const) {
      s.h.db.set({ ...stored, status, ...extra });
      const outcome = await s.put(MIA, "linear", body, { expectedRevision: revision }, requestId);
      expect(outcome.status, status).toBe(200);
      expect(outcome.body, status).toEqual({ status, ...extra });
    }
    s.h.db.set({ ...stored, status: "EXECUTING" });
    const running = await s.put(MIA, "linear", body, { expectedRevision: revision }, requestId);
    expect(running.status).toBe(202);
    expect(running.body).toEqual({ status: "EXECUTING" });
    await s.fakeLinear.close();
  });
});

describe("a loosened limit on a confirmed write tool waits for the page (GAP-1)", () => {
  const limited = (id: string, extra: Record<string, unknown> = {}, scopes?: unknown) => linear(id, [
    { name: "list_issues", access: "read" }, { name: "save_issue", access: "write", argumentValues: { stateId: ["s-todo"] }, allowedArguments: ["title", "stateId"], ...extra },
  ], scopes === undefined ? {} : { scopes });

  it("answers 202 for dropping the limits on a stored write tool, and applies a tightening at once", async () => {
    const s = await install();
    const id = await s.connection({ type: "linear", label: "Team Linear", access: "read_write" });
    const revision = seedConnectors(s, [limited(id)]);
    const loosened = await s.put(MIA, "linear", linear(id, [{ name: "list_issues", access: "read" }, { name: "save_issue", access: "write" }]), { expectedRevision: revision });
    expect(loosened.status, JSON.stringify(loosened.body)).toBe(202);
    expect(loosened.body["changes"]).toEqual(["On web, lets the linear connector's save_issue tool make changes (fewer argument limits)"]);
    expect(s.revisions()).toHaveLength(revision);
    const tightened = await s.put(MIA, "linear", limited(id, { allowedArguments: ["title"], argumentValues: { stateId: ["s-todo"] } }), { expectedRevision: revision });
    expect(tightened.status, JSON.stringify(tightened.body)).toBe(200);
    await s.fakeLinear.close();
  });

  it("refuses a loosening on a connector whose connection is read-only or removed, instead of writing it as a change that holds what was confirmed", async () => {
    const s = await install();
    const id = await s.connection({ type: "linear", label: "Team Linear", access: "read_write" });
    const revision = seedConnectors(s, [limited(id)]);
    const loose = linear(id, [{ name: "list_issues", access: "read" }, { name: "save_issue", access: "write" }]);
    expect((await s.call(DANA, "PUT", `/v1/app/connections/${id}`, { connection: { type: "linear", label: "Team Linear", access: "read" } })).status).toBe(200);
    const readOnly = await s.put(MIA, "linear", loose, { expectedRevision: revision });
    expect(readOnly.status).toBe(400);
    expect(readOnly.body.error).toMatchObject({ code: "CONFIG_INVALID", message: "tools.1: Team Linear is read-only" });
    expect((await s.call(DANA, "DELETE", `/v1/app/connections/${id}`, {})).status).toBe(200);
    const removed = await s.put(MIA, "linear", loose, { expectedRevision: revision });
    expect(removed.status).toBe(400);
    expect(removed.body.error).toMatchObject({ code: "CONFIG_INVALID", message: `credentialRef: no linear connection called ${id} in your organization` });
    expect(s.revisions()).toHaveLength(revision);
    expect(s.approvals()).toHaveLength(0);
    // Tightening the same connector is still let through.
    expect((await s.put(MIA, "linear", limited(id, { allowedArguments: ["title"] }), { expectedRevision: revision })).status).toBe(200);
    await s.fakeLinear.close();
  });

  it("answers 202 for dropping the ownership rule's entry of a write tool named like a wording field", async () => {
    const s = await install();
    const id = await s.connection({ type: "mcp", label: "Sentry", access: "read_write", endpoint: "https://mcp.acme.dev/mcp", vendor: "Sentry" }, { token: "sentry-token-0123456789" });
    const rule = (references: Record<string, string[]>) => ({ mode: "ownership", itemNoun: "issue", references, lookup: { tool: "get_issue", argument: "id" }, field: "project", equals: "project" });
    const owned = (references: Record<string, string[]>) => sentry(id, { scoping: rule(references), tools: [{ name: "message", access: "write" }] });
    const revision = seedConnectors(s, [owned({ message: ["issueId"], save_issue: ["id"] })]);
    const asked = await s.put(MIA, "sentry", owned({ save_issue: ["id"] }), { expectedRevision: revision });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body["changes"]).toEqual(["On web, lets the sentry connector's write tools act under different scope rules"]);
    expect(s.revisions()).toHaveLength(revision);
    await s.fakeLinear.close();
  });

  it("answers 202 for turning the requester footer off on a connector with a write tool", async () => {
    const s = await install();
    const id = await s.connection({ type: "linear", label: "Team Linear", access: "read_write" });
    const revision = seedConnectors(s, [linear(id, WRITE_TOOLS)]);
    const asked = await s.put(MIA, "linear", linear(id, WRITE_TOOLS, { attribution: false }), { expectedRevision: revision });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body["changes"]).toEqual(["On web, lets the linear connector's write tools write without the requester footer"]);
    expect(s.revisions()).toHaveLength(revision);
    await s.fakeLinear.close();
  });

  it("answers 202 for loosening an MCP ownership rule on a stored write connector", async () => {
    const s = await install();
    const id = await s.connection({ type: "mcp", label: "Sentry", access: "read_write", endpoint: "https://mcp.acme.dev/mcp", vendor: "Sentry" }, { token: "sentry-token-0123456789" });
    const rule = (extra: Record<string, unknown> = {}) => ({
      mode: "ownership", itemNoun: "issue", references: { save_issue: ["issueId"] }, lookup: { tool: "get_issue", argument: "id" }, field: "project", equals: "project", ...extra,
    });
    const owned = (scoping: unknown) => sentry(id, { scoping });
    const revision = seedConnectors(s, [owned(rule({ refuse: [{ tools: ["save_issue"], arguments: ["parentId"], message: "no parents" }] }))]);
    const asked = await s.put(MIA, "sentry", owned(rule()), { expectedRevision: revision });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body["changes"]).toEqual(["On web, lets the sentry connector's write tools act under different scope rules"]);
    expect(s.revisions()).toHaveLength(revision);
    await s.fakeLinear.close();
  });
});

describe("widenings", () => {
  const link = (extra: Record<string, unknown> = {}) => ({ name: "linear", type: "linear", credentialRef: "con_aaaaaaaaaaaaaaaaaaaa", scopes: [{ alias: "a", teamId: CHARTERARC_TEAM_ID }], tools: [{ name: "a", access: "write" }], ...extra }) as never;
  it("lists the tools newly approved to write, with what they were", () => {
    const previous = link({ tools: [{ name: "a", access: "read" }, { name: "b", access: "write" }] });
    expect(widenings(previous, link({ tools: [{ name: "a", access: "write" }, { name: "b", access: "write" }, { name: "c", access: "write" }, { name: "d", access: "read" }] }), "web"))
      .toEqual([
        "On web, lets the linear connector's a tool make changes (it could only read before)",
        "On web, lets the linear connector's c tool make changes",
      ]);
    expect(widenings(undefined, link(), "web")).toEqual(["On web, lets the linear connector's a tool make changes"]);
    expect(widenings(previous, link({ tools: [{ name: "a", access: "read" }] }), "web")).toEqual([]);
  });

  it("counts a stored write tool as approved only for the same type, connection and (for MCP) endpoint and bind", () => {
    const stored = link();
    expect(widenings(stored, link({ credentialRef: "con_bbbbbbbbbbbbbbbbbbbb" }), "web")).toEqual(["On web, lets the linear connector's a tool make changes (now on connection con_bbbbbbbbbbbbbbbbbbbb)"]);
    expect(widenings(stored, { name: "linear", type: "mcp", credentialRef: "con_aaaaaaaaaaaaaaaaaaaa", endpoint: "https://mcp.acme.dev/mcp", scopes: [], tools: [{ name: "a", access: "write" }] } as never, "web"))
      .toEqual(["On web, lets the linear connector's a tool make changes (now an mcp connector)"]);
    const mcpStored = { name: "s", type: "mcp", credentialRef: "con_aaaaaaaaaaaaaaaaaaaa", endpoint: "https://mcp.acme.dev/mcp", bind: { required: { project: "project" } }, scopes: [{ alias: "m", values: { project: "p" } }], scoping: { mode: "credential", acknowledgeUnscopedWrites: true }, tools: [{ name: "a", access: "write" }] };
    expect(widenings(mcpStored as never, { ...mcpStored } as never, "web")).toEqual([]);
    expect(widenings(mcpStored as never, { ...mcpStored, endpoint: "https://mcp.acme.dev/other" } as never, "web")).toHaveLength(1);
    expect(widenings(mcpStored as never, { ...mcpStored, bind: { required: { project: "other" } } } as never, "web")).toHaveLength(1);
    // Nothing writes in the new connector: nothing is widened, whatever moved.
    expect(widenings(stored, link({ credentialRef: "con_bbbbbbbbbbbbbbbbbbbb", tools: [{ name: "a", access: "read" }] }), "web")).toEqual([]);
  });

  it("counts a scope added to a connector that writes as a widening, and a narrower scope as none", () => {
    const stored = link({ scopes: [{ alias: "a", teamId: CHARTERARC_TEAM_ID }] });
    const other = "0b6f3f7e-5d1a-4c1e-9a53-2f0f5a8f1c11";
    expect(widenings(stored, link({ scopes: [{ alias: "a", teamId: CHARTERARC_TEAM_ID }, { alias: "b", teamId: other }] }), "web")).toEqual(["On web, lets the linear connector's write tools reach one more scope (b)"]);
    expect(widenings(stored, link({ scopes: [{ alias: "a", teamId: other }] }), "web")).toHaveLength(1);
    expect(widenings(stored, link({ scopes: [{ alias: "renamed", teamId: CHARTERARC_TEAM_ID }] }), "web")).toHaveLength(1);
    expect(widenings(link({ scopes: [{ alias: "a", teamId: CHARTERARC_TEAM_ID }, { alias: "b", teamId: other }] }), stored, "web")).toEqual([]);
    expect(widenings(stored, link({ scopes: [{ alias: "a", teamId: CHARTERARC_TEAM_ID }, { alias: "b", teamId: other }], tools: [{ name: "a", access: "read" }] }), "web")).toEqual([]);
    const gh = (scopes: unknown) => ({ name: "github", type: "github", scopes, tools: [{ name: "x", access: "write" }] }) as never;
    expect(widenings(gh(["web"]), gh("all-repositories"), "web")).toEqual(["On web, lets the github connector's write tools reach all repositories"]);
    expect(widenings(gh("all-repositories"), gh(["web"]), "web")).toEqual([]);
    expect(widenings(gh(["web"]), gh(["web", "api"]), "web")).toEqual(["On web, lets the github connector's write tools reach one more scope (api)"]);
    const jira = (scopes: unknown) => ({ name: "jira", type: "jira", credentialRef: "con_aaaaaaaaaaaaaaaaaaaa", scopes, tools: [{ name: "x", access: "write" }] }) as never;
    const site = "5f2c1a9e-3b7d-4c6a-9e11-0a1b2c3d4e5f";
    expect(widenings(jira([{ alias: "a", cloudId: site, projectKey: "AB" }]), jira([{ alias: "a", cloudId: site }]), "web")).toHaveLength(1);
    expect(widenings(jira([{ alias: "a", cloudId: site }]), jira([{ alias: "a", cloudId: site, projectKey: "AB" }]), "web")).toEqual([]);
    const sentry = (scoping: unknown) => ({ name: "s", type: "mcp", credentialRef: "con_aaaaaaaaaaaaaaaaaaaa", endpoint: "https://mcp.acme.dev/mcp", scopes: [{ alias: "m", values: { project: "p" } }], scoping, tools: [{ name: "x", access: "write" }] }) as never;
    expect(widenings(sentry({ mode: "ownership", itemNoun: "issue", references: {}, lookup: {}, field: "p", equals: "project" }), sentry({ mode: "credential", acknowledgeUnscopedWrites: true }), "web"))
      .toEqual(["On web, lets the s connector's write tools act without a scope check"]);
  });

  describe("limits on a confirmed write tool (GAP-1)", () => {
    const tool = (extra: Record<string, unknown>) => [{ name: "save_issue", access: "write", ...extra }];
    const withTool = (extra: Record<string, unknown>) => link({ tools: tool(extra) });
    const fewer = ["On web, lets the linear connector's save_issue tool make changes (fewer argument limits)"];
    const looser = ["On web, lets the linear connector's save_issue tool make changes (looser argument limits)"];

    it("counts removing or growing allowedArguments as a widening, and keeping or shrinking it as none", () => {
      const stored = withTool({ allowedArguments: ["title", "stateId"] });
      expect(widenings(stored, withTool({}), "web")).toEqual(fewer);
      expect(widenings(stored, withTool({ allowedArguments: ["title", "stateId", "assigneeId"] }), "web")).toEqual(looser);
      expect(widenings(stored, withTool({ allowedArguments: ["title", "teamId"] }), "web")).toEqual(looser);
      expect(widenings(stored, withTool({ allowedArguments: ["stateId", "title"] }), "web")).toEqual([]);
      expect(widenings(stored, withTool({ allowedArguments: ["title"] }), "web")).toEqual([]);
      // A tool with no list had no limit: adding one only narrows.
      expect(widenings(withTool({}), stored, "web")).toEqual([]);
    });

    it("counts a dropped argument limit or a longer list of allowed values as a widening, and a shorter one as none", () => {
      const stored = withTool({ argumentValues: { stateId: ["s-todo", "s-doing"], priority: [1] } });
      expect(widenings(stored, withTool({}), "web")).toEqual(fewer);
      expect(widenings(stored, withTool({ argumentValues: { stateId: ["s-todo", "s-doing"] } }), "web")).toEqual(fewer);
      expect(widenings(stored, withTool({ argumentValues: { stateId: ["s-todo", "s-doing", "s-done"], priority: [1] } }), "web")).toEqual(looser);
      expect(widenings(stored, withTool({ argumentValues: { stateId: ["s-todo", "s-other"], priority: [1] } }), "web")).toEqual(looser);
      expect(widenings(stored, withTool({ argumentValues: { stateId: ["s-doing"], priority: [1] } }), "web")).toEqual([]);
      expect(widenings(stored, withTool({ argumentValues: { stateId: ["s-doing", "s-todo"], priority: [1], extra: ["x"] } }), "web")).toEqual([]);
      expect(widenings(withTool({}), stored, "web")).toEqual([]);
    });

    it("does not count wording, or a loosening of a tool that only reads", () => {
      expect(widenings(withTool({ description: "old words" }), withTool({ description: "new words", examples: [{ title: "x" }] }), "web")).toEqual([]);
      const reads = (extra: Record<string, unknown>) => link({ tools: [{ name: "get_issue", access: "read", ...extra }] });
      expect(widenings(reads({ allowedArguments: ["id"] }), reads({}), "web")).toEqual([]);
    });

    const ownership = (extra: Record<string, unknown> = {}) => ({
      mode: "ownership", itemNoun: "issue", itemNounPlural: "issues", references: { save_issue: ["issueId"], other: ["id"] },
      lookup: { tool: "get_issue", argument: "id" }, field: "project", equals: "project", caseInsensitive: false, maxLookups: 3,
      refuse: [{ tools: ["save_issue"], arguments: ["parentId"], message: "no parents" }], require: [{ tools: ["save_issue"], argument: "issueId", message: "name the issue" }],
      ...extra,
    });
    const mcp = (extra: Record<string, unknown>) => ({
      name: "s", type: "mcp", credentialRef: "con_aaaaaaaaaaaaaaaaaaaa", endpoint: "https://mcp.acme.dev/mcp", scopes: [{ alias: "m", values: { project: "p" } }],
      scoping: ownership(), tools: [{ name: "save_issue", access: "write" }], ...extra,
    }) as never;

    it("counts any change to an MCP ownership rule as a widening while a tool writes, except its wording", () => {
      const stored = mcp({});
      const rules = "On web, lets the s connector's write tools act under different scope rules";
      expect(widenings(stored, mcp({}), "web")).toEqual([]);
      expect(widenings(stored, mcp({ scoping: ownership({ itemNoun: "ticket", itemNounPlural: "tickets", refuse: [{ tools: ["save_issue"], arguments: ["parentId"], message: "other words" }], require: [{ tools: ["save_issue"], argument: "issueId", message: "other words" }] }) }), "web")).toEqual([]);
      for (const changed of [
        { field: "org" }, { equals: "org" }, { caseInsensitive: true }, { parent: { field: "parent", maxDepth: 3 } }, { maxLookups: 9 },
        { refuse: [] }, { refuse: undefined }, { references: { save_issue: ["issueId"] } }, { references: { save_issue: ["issueId", "other"], other: ["id"] } },
        { require: [] }, { lookup: { tool: "get_other", argument: "id" } }, { lookup: { tool: "get_issue", argument: "id", arguments: { x: 1 } } },
        { refuse: [{ tools: ["save_issue"], arguments: ["parentId"], equals: "x", message: "no parents" }] },
      ]) {
        expect(widenings(stored, mcp({ scoping: ownership(changed) }), "web"), JSON.stringify(changed)).toEqual([rules]);
      }
      // A rule on a connector with no write tool is not a widening.
      expect(widenings(mcp({ tools: [{ name: "get_issue", access: "read" }] }), mcp({ tools: [{ name: "get_issue", access: "read" }], scoping: ownership({ field: "org" }) }), "web")).toEqual([]);
    });

    it("counts any change to an MCP connector's item arguments or attribution keys as a widening while a tool writes", () => {
      const stored = mcp({ itemArguments: ["issueId"], attributionKeys: ["requestedBy"] });
      expect(widenings(stored, mcp({ itemArguments: ["issueId"], attributionKeys: ["requestedBy"] }), "web")).toEqual([]);
      expect(widenings(stored, mcp({ itemArguments: ["issueId", "other"], attributionKeys: ["requestedBy"] }), "web")).toEqual(["On web, lets the s connector's write tools use other item arguments"]);
      expect(widenings(stored, mcp({ attributionKeys: ["requestedBy"] }), "web")).toEqual(["On web, lets the s connector's write tools use other item arguments"]);
      expect(widenings(stored, mcp({ itemArguments: ["issueId"] }), "web")).toEqual(["On web, lets the s connector's write tools use other attribution keys"]);
    });

    it("compares tool and argument names in an ownership rule even when they are spelled like a wording field", () => {
      const rule = (extra: Record<string, unknown>) => ownership({ references: { message: ["issueId"], save_issue: ["id"] }, lookup: { tool: "get_issue", argument: "id", arguments: { message: "x" } }, ...extra });
      const writes = (scoping: unknown) => mcp({ scoping, tools: [{ name: "message", access: "write" }] });
      const stored = writes(rule({}));
      const rules = "On web, lets the s connector's write tools act under different scope rules";
      expect(widenings(stored, writes(rule({})), "web")).toEqual([]);
      expect(widenings(stored, writes(rule({ references: { save_issue: ["id"] } })), "web")).toEqual([rules]);
      expect(widenings(stored, writes(rule({ lookup: { tool: "get_issue", argument: "id", arguments: { message: "y" } } })), "web")).toEqual([rules]);
      expect(widenings(stored, writes(rule({ lookup: { tool: "get_issue", argument: "id" } })), "web")).toEqual([rules]);
      expect(widenings(stored, writes(rule({ itemNoun: "ticket", itemNounPlural: "tickets" })), "web")).toEqual([]);
    });

    it("counts turning the requester footer off on a connector that writes as a widening, and nothing else about it", () => {
      const footer = "On web, lets the linear connector's write tools write without the requester footer";
      expect(widenings(link({ attribution: true }), link({ attribution: false }), "web")).toEqual([footer]);
      expect(widenings(link(), link({ attribution: false }), "web")).toEqual([footer]);
      expect(widenings(link({ attribution: false }), link({ attribution: false }), "web")).toEqual([]);
      expect(widenings(link({ attribution: false }), link({ attribution: true }), "web")).toEqual([]);
      expect(widenings(link({ attribution: false }), link(), "web")).toEqual([]);
      expect(widenings(link(), link({ attribution: false, tools: [{ name: "a", access: "read" }] }), "web")).toEqual([]);
    });
  });
});


// ---------------------------------------------------------------------------------------------------------------------------------------------
// Plan 4 Task 12: the seven new connector types (sentry, datadog, cloudwatch, github-actions, grafana, vercel, pagerduty) join this module. They are
// read-only: a tool outside PROJECT_CONNECTOR_TOOLS[type] and any `write` approval are refused, and Plan 3's rules for the connection apply unchanged.
// ---------------------------------------------------------------------------------------------------------------------------------------------

const NEW_TYPES = ["sentry", "datadog", "cloudwatch", "github-actions", "grafana", "vercel", "pagerduty"] as const;
type NewType = (typeof NEW_TYPES)[number];
const CON = "con_aaaaaaaaaaaaaaaaaaaa";
const THINGS = [{ name: "list_things", access: "read" }];

/** One valid connector of each new type, named as its type (`github-actions` is `gha`: a name is 20 characters at most). */
const sample = (type: NewType, extra: Record<string, unknown> = {}): Record<string, unknown> => {
  const base: Record<NewType, Record<string, unknown>> = {
    sentry: { name: "sentry", type, credentialRef: CON, scopes: [{ alias: "web", projectSlug: "web-app" }], tools: THINGS },
    datadog: { name: "datadog", type, credentialRef: CON, scopes: [{ alias: "pay", tags: ["service:payments", "env:prod"] }], tools: THINGS },
    cloudwatch: { name: "cloudwatch", type, credentialRef: CON, scopes: [{ alias: "prod", region: "us-east-1", logGroupPrefixes: ["/aws/lambda/pay"], alarmNamePrefix: "pay-" }], tools: THINGS },
    "github-actions": { name: "gha", type, scopes: ["web"], tools: THINGS },
    grafana: { name: "grafana", type, credentialRef: CON, scopes: [{ alias: "main", folderUids: ["fold1"], datasourceUid: "prom1" }], tools: THINGS },
    vercel: { name: "vercel", type, credentialRef: CON, scopes: [{ alias: "site", projectId: "prj_abc123" }], tools: THINGS },
    pagerduty: { name: "pagerduty", type, credentialRef: CON, scopes: [{ alias: "oncall", serviceIds: ["PABC123"] }], tools: THINGS },
  };
  return { ...base[type], ...extra };
};

describe("Plan 4 Task 12: the schemas of the seven new types", () => {
  it.each(NEW_TYPES)("%s parses, and refuses a field it does not take", (type) => {
    expect(ConnectorConfigSchema.safeParse(sample(type)).success).toBe(true);
    const extra = ConnectorConfigSchema.safeParse(sample(type, { somethingElse: 1 }));
    expect(extra.success).toBe(false);
    if (!extra.success) expect(extra.error.issues[0]).toMatchObject({ code: "unrecognized_keys" });
  });

  it.each(NEW_TYPES.filter((type) => type !== "github-actions"))("%s refuses a field it does not take inside a scope too (review B-M3)", (type) => {
    const scope = (sample(type)["scopes"] as Array<Record<string, unknown>>)[0]!;
    const extra = ConnectorConfigSchema.safeParse(sample(type, { scopes: [{ ...scope, somethingElse: 1 }] }));
    expect(extra.success).toBe(false);
    if (!extra.success) expect(extra.error.issues[0]).toMatchObject({ code: "unrecognized_keys", path: ["scopes", 0] });
  });

  it("holds a project to one github-actions connector, as it does one github connector (review B-M4)", () => {
    const two = [sample("github-actions"), sample("github-actions", { name: "gha-two" })];
    const refused = ConnectorsSchema.safeParse(two);
    expect(refused.success).toBe(false);
    if (!refused.success) expect(refused.error.issues.map((issue) => issue.message)).toContain("at most one github-actions connector is supported");
    expect(StoredConnectorsSchema.safeParse(two).success).toBe(false);
    // One of each is fine, and two of any other native type are too (each names its own project or service set).
    expect(ConnectorsSchema.safeParse([sample("github-actions"), { name: "github", type: "github", scopes: "all-repositories", tools: THINGS }]).success).toBe(true);
    expect(ConnectorsSchema.safeParse([sample("sentry"), sample("sentry", { name: "sentry-two" })]).success).toBe(true);
  });

  it("keeps the schema's options in the order the types landed", () => {
    expect(ConnectorConfigSchema.options.map((option) => option.shape.type.value)).toEqual(["github", "linear", "jira", "asana", "mcp", ...NEW_TYPES]);
  });

  it("gives six types a connection, and github-actions none, as github has none", () => {
    for (const type of NEW_TYPES.filter((entry) => entry !== "github-actions")) {
      const { credentialRef: _ref, ...without } = sample(type); // eslint-disable-line @typescript-eslint/no-unused-vars -- left out on purpose
      expect(ConnectorConfigSchema.safeParse(without).success, `${type} without a connection`).toBe(false);
      expect(ConnectorConfigSchema.safeParse(sample(type, { credentialRef: "my-sentry" })).success, `${type} named by a registry name`).toBe(false);
    }
    expect(ConnectorConfigSchema.safeParse(sample("github-actions", { credentialRef: CON })).success).toBe(false);
    expect(ConnectorConfigSchema.safeParse(sample("github-actions", { scopes: "all-repositories" })).success).toBe(true);
    expect(ConnectorConfigSchema.safeParse(sample("github-actions", { scopes: [] })).success).toBe(false);
    expect(ConnectorConfigSchema.safeParse(sample("github-actions", { scopes: ["web", "web"] })).success).toBe(false);
  });

  it.each(NEW_TYPES)("%s refuses a tool approved to write, at the tool's own place, with the plan's words", (type) => {
    const parsed = ConnectorConfigSchema.safeParse(sample(type, { tools: [...THINGS, { name: "do_things", access: "write" }] }));
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues).toEqual([expect.objectContaining({ path: ["tools", 1], message: `${type} connectors are read-only` })]);
  });

  it.each(NEW_TYPES)("%s needs a scope and names each alias once", (type) => {
    expect(ConnectorConfigSchema.safeParse(sample(type, { scopes: [] })).success).toBe(false);
    const scope = (sample(type)["scopes"] as unknown[])[0];
    if (typeof scope === "object") expect(ConnectorConfigSchema.safeParse(sample(type, { scopes: [scope, scope] })).success, "the same alias twice").toBe(false);
  });

  it("holds each type's scope to its vendor's names", () => {
    const refused = (type: NewType, scope: unknown) => ConnectorConfigSchema.safeParse(sample(type, { scopes: [scope] })).success === false;
    expect(refused("sentry", { alias: "web", projectSlug: "Web App" })).toBe(true);
    expect(refused("sentry", { alias: "web" })).toBe(true);
    // A Datadog tag is key:value and goes into a query, so it carries nothing that could change the query.
    for (const tags of [[], ["nocolon"], ["service:pay ments"], ["service:a) OR (env:b"], ["a:b", "a:b"], ["a:1", "a:2", "a:3", "a:4", "a:5", "a:6"], ["Service:x"]]) {
      expect(refused("datadog", { alias: "pay", tags }), JSON.stringify(tags)).toBe(true);
    }
    expect(refused("cloudwatch", { alias: "prod", region: "nowhere" })).toBe(true);
    expect(refused("cloudwatch", { alias: "prod", region: "us-east-1", logGroupPrefixes: ["a", "b", "c", "d", "e", "f"] })).toBe(true);
    expect(refused("cloudwatch", { alias: "prod", region: "us-east-1", alarmNamePrefix: "" })).toBe(true);
    expect(refused("cloudwatch", { alias: "prod", region: "us-east-1", alarmNamePrefix: "bad\nprefix" })).toBe(true);
    expect(refused("cloudwatch", { alias: "prod", region: "us-east-1" })).toBe(false);
    expect(refused("grafana", { alias: "main", folderUids: ["a/b"] })).toBe(true);
    expect(refused("grafana", { alias: "main", folderUids: [] })).toBe(true);
    expect(refused("grafana", { alias: "main", datasourceUid: "x y" })).toBe(true);
    expect(refused("grafana", { alias: "main" })).toBe(false);
    expect(refused("vercel", { alias: "site", projectId: "abc" })).toBe(true);
    expect(refused("pagerduty", { alias: "oncall", serviceIds: [] })).toBe(true);
    expect(refused("pagerduty", { alias: "oncall", serviceIds: ["p123"] })).toBe(true);
    expect(refused("pagerduty", { alias: "oncall", serviceIds: Array.from({ length: 11 }, (_, index) => `PABC${String(100 + index)}`) })).toBe(true);
  });

  it("raises the most connectors a project holds from 8 to 12 in all three places, and no further", () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => sample("sentry", { name: `s${String(index)}` }));
    for (const schema of [ConnectorsSchema, StoredConnectorsSchema]) {
      expect(schema.safeParse(many(12)).success).toBe(true);
      expect(schema.safeParse(many(13)).success).toBe(false);
    }
    const entry = (index: number) => ({ name: `s${String(index)}`, status: "connected", offered: [], skipped: [] });
    expect(RegistrationPreflightSchema.safeParse({ connectors: Array.from({ length: 12 }, (_, index) => entry(index)) }).success).toBe(true);
    expect(RegistrationPreflightSchema.safeParse({ connectors: Array.from({ length: 13 }, (_, index) => entry(index)) }).success).toBe(false);
  });

  it("lets the Slack thread answer list as many connectors as a project may hold", () => {
    const thread = (count: number) => ({
      outcome: "WORKSPACE", workspaceId: randomUUID(), status: "READY", operationId: null, created: false, orchestratorInstructions: "x",
      connectors: Array.from({ length: count }, (_, index) => ({ name: `c${String(index)}`, type: "sentry", label: "Sentry", scopes: ["a"], connected: true })),
    });
    expect(SlackThreadWorkspaceResultSchema.safeParse(thread(12)).success).toBe(true);
    expect(SlackThreadWorkspaceResultSchema.safeParse(thread(13)).success).toBe(false);
  });

  it("keeps a stored connector of an unknown type passing through, and a malformed one of a new type failing as itself", () => {
    expect(StoredConnectorsSchema.safeParse([{ name: "later", type: "newvendor", anything: [1] }]).success).toBe(true);
    for (const type of NEW_TYPES) expect(StoredConnectorsSchema.safeParse([{ name: "bad", type }]).success, type).toBe(false);
    expect(StoredConnectorsSchema.safeParse([sample("pagerduty")]).success).toBe(true);
  });

  it("lets agents be granted tools on each new type, and still refuses a connector called slack", () => {
    for (const type of NEW_TYPES) expect(AgentConnectorTypeSchema.parse(type)).toBe(type);
    expect(AgentConnectorTypeSchema.safeParse("newvendor").success).toBe(false);
    expect(toolGrantProblems([{ connector: { name: "slack" }, access: "read" }])).toHaveLength(1);
    expect(toolGrantProblems([{ connector: { type: "sentry" }, access: "read" }, { connector: { name: "errors" }, access: "read" }])).toEqual([]);
  });
});

describe("Plan 4 Task 12: agent tool grants on the new types", () => {
  const catalogOf = (name: string, tools: string[]) => ({
    connector: name,
    tools: tools.map((upstreamName) => ({
      name: `${name}__${upstreamName}`, upstreamName, description: upstreamName, inputSchema: { type: "object", properties: {} }, access: "read" as const,
      scopes: [{ alias: "web", schemaHash: "a".repeat(64) }],
    })),
    skipped: [],
  });

  it("keeps the project's approvals as the ceiling: a read_write grant on a read-only connector gives read tools only", () => {
    const connector = { name: "errors", type: "sentry", approvals: [{ name: "list_issues", access: "read" as const }, { name: "get_issue", access: "read" as const }] };
    const granted = resolveToolGrants({ grants: [{ connector: { type: "sentry" }, access: "read_write" }], connectors: [connector], catalogs: [catalogOf("errors", ["list_issues", "get_issue", "resolve_issue"])] });
    // `resolve_issue` is not approved, so it is not granted however much the grant allows.
    expect(granted.map((entry) => `${entry.connector}.${entry.upstreamName}:${entry.access}`)).toEqual(["errors.list_issues:read", "errors.get_issue:read"]);
    expect(granted.every((entry) => entry.type === "sentry")).toBe(true);
  });

  it.each(NEW_TYPES)("a %s type selector and a name selector both reach its connector", (type) => {
    const connector = { name: "thing", type, approvals: [{ name: "list_things", access: "read" as const }] };
    for (const selector of [{ type }, { name: "thing" }] as const) {
      expect(resolveToolGrants({ grants: [{ connector: selector, access: "read" }], connectors: [connector], catalogs: [catalogOf("thing", ["list_things"])] })).toHaveLength(1);
    }
  });

  it.each(NEW_TYPES)("%s declares no facts of its own: the catalog's alone", (type) => {
    const [tool] = catalogOf("thing", ["list_things"]).tools;
    const facts = toolFactsFor({ name: "thing", type }, tool!, "read");
    expect(facts).toEqual({ connector: "thing", upstreamName: "list_things", access: "read" });
  });
});

describe("Plan 4 Task 12: what a widening is for the new types", () => {
  // The routes refuse a write tool on these types, so nothing of this reaches the confirmation page today; `widenings` is still complete for them, so
  // the day a type is allowed to write (or a stored write tool exists from another path) a scope addition is confirmed like any other.
  const withWrite = (type: NewType, extra: Record<string, unknown> = {}) => sample(type, { tools: [...THINGS, { name: "do_things", access: "write" }], ...extra }) as never;
  const scopeKey = (type: NewType) => (type === "github-actions" ? undefined : (sample(type)["scopes"] as Array<Record<string, unknown>>)[0]!);
  const more = (type: NewType, scope: Record<string, unknown>) => withWrite(type, { scopes: [scopeKey(type), scope] });
  const swapped = (type: NewType, change: Record<string, unknown>) => withWrite(type, { scopes: [{ ...scopeKey(type), ...change }] });
  const added = (alias: string) => [`On web, lets the x connector's write tools reach one more scope (${alias})`];
  /** The connector as `widenings` reads it, called x so the sentences are the same for every type. */
  const as = (value: unknown): never => ({ ...(value as Record<string, unknown>), name: "x" }) as never;

  it("asks for a write tool the connector did not have, and for none once it was confirmed for the same target", () => {
    for (const type of NEW_TYPES) {
      expect(widenings(undefined, as(withWrite(type)), "web"), type).toEqual(["On web, lets the x connector's do_things tool make changes"]);
      expect(widenings(as(withWrite(type)), as(withWrite(type)), "web"), type).toEqual([]);
    }
  });

  it("asks for a scope that was added, by what each type's scope names", () => {
    const stored = (type: NewType) => as(withWrite(type));
    expect(widenings(stored("sentry"), as(more("sentry", { alias: "api", projectSlug: "api" })), "web")).toEqual(added("api"));
    expect(widenings(stored("sentry"), as(swapped("sentry", { projectSlug: "other-app" })), "web")).toEqual(added("web"));
    expect(widenings(stored("vercel"), as(swapped("vercel", { projectId: "prj_other" })), "web")).toEqual(added("site"));
    expect(widenings(stored("pagerduty"), as(swapped("pagerduty", { serviceIds: ["PABC123", "PXYZ789"] })), "web")).toEqual(added("oncall"));
    // A scope with fewer tags matches more (a tag only narrows a query), so it widens; one with more tags narrows.
    expect(widenings(stored("datadog"), as(swapped("datadog", { tags: ["service:payments"] })), "web")).toEqual(added("pay"));
    expect(widenings(stored("datadog"), as(swapped("datadog", { tags: ["service:other", "env:prod"] })), "web")).toEqual(added("pay"));
    expect(widenings(stored("cloudwatch"), as(swapped("cloudwatch", { region: "eu-west-1" })), "web")).toEqual(added("prod"));
    expect(widenings(stored("cloudwatch"), as(swapped("cloudwatch", { logGroupPrefixes: ["/aws/lambda/pay", "/aws/lambda/other"] })), "web")).toEqual(added("prod"));
    expect(widenings(stored("cloudwatch"), as(swapped("cloudwatch", { logGroupPrefixes: ["/aws/lambda"] })), "web")).toEqual(added("prod"));
    expect(widenings(stored("cloudwatch"), as(swapped("cloudwatch", { alarmNamePrefix: undefined })), "web")).toEqual(added("prod"));
    expect(widenings(stored("cloudwatch"), as(swapped("cloudwatch", { alarmNamePrefix: "p" })), "web")).toEqual(added("prod"));
    expect(widenings(stored("grafana"), as(swapped("grafana", { folderUids: ["fold1", "fold2"] })), "web")).toEqual(added("main"));
    expect(widenings(stored("grafana"), as(swapped("grafana", { folderUids: undefined })), "web")).toEqual(added("main"));
    expect(widenings(stored("grafana"), as(swapped("grafana", { datasourceUid: "prom2" })), "web")).toEqual(added("main"));
    expect(widenings(as(swapped("grafana", { datasourceUid: undefined })), as(swapped("grafana", { datasourceUid: "prom1" })), "web")).toEqual(added("main"));
    expect(widenings(stored("github-actions"), as(withWrite("github-actions", { scopes: ["web", "api"] })), "web")).toEqual(["On web, lets the x connector's write tools reach one more scope (api)"]);
    expect(widenings(stored("github-actions"), as(withWrite("github-actions", { scopes: "all-repositories" })), "web")).toEqual(["On web, lets the x connector's write tools reach all repositories"]);
  });

  it("does not ask for a narrower scope, and does not count a connector that cannot write", () => {
    const stored = (type: NewType) => as(withWrite(type));
    expect(widenings(as(swapped("pagerduty", { serviceIds: ["PABC123", "PXYZ789"] })), stored("pagerduty"), "web")).toEqual([]);
    expect(widenings(stored("datadog"), as(swapped("datadog", { tags: ["service:payments", "env:prod", "team:core"] })), "web")).toEqual([]);
    expect(widenings(as(withWrite("github-actions", { scopes: ["web", "api"] })), stored("github-actions"), "web")).toEqual([]);
    expect(widenings(as(withWrite("github-actions", { scopes: "all-repositories" })), stored("github-actions"), "web")).toEqual([]);
    expect(widenings(stored("cloudwatch"), as(swapped("cloudwatch", { logGroupPrefixes: ["/aws/lambda/pay-api"], alarmNamePrefix: "pay-api-" })), "web")).toEqual([]);
    expect(widenings(as(swapped("grafana", { folderUids: undefined })), stored("grafana"), "web")).toEqual([]);
    expect(widenings(as(swapped("grafana", { datasourceUid: "prom1" })), as(swapped("grafana", { datasourceUid: undefined })), "web")).toEqual([]);
    for (const type of NEW_TYPES) {
      const reads = (extra: Record<string, unknown>) => as(sample(type, extra));
      const other = type === "github-actions" ? { scopes: "all-repositories" } : { scopes: [...(sample(type)["scopes"] as unknown[]), { ...(scopeKey(type) as object), alias: "more" }] };
      expect(widenings(reads({}), reads(other), "web"), `${type} reads only`).toEqual([]);
    }
  });

  it("moves a connector's write tools to the newly confirmed state when its connection changes", () => {
    const next = as(withWrite("sentry", { credentialRef: "con_bbbbbbbbbbbbbbbbbbbb" }));
    expect(widenings(as(withWrite("sentry")), next, "web")).toEqual(["On web, lets the x connector's do_things tool make changes (now on connection con_bbbbbbbbbbbbbbbbbbbb)"]);
  });
});

describe("Plan 4 Task 12: PUT accepts the seven new types", () => {
  const QUIET = () => vi.spyOn(console, "log").mockImplementation(() => undefined);
  const CONNECTIONS: Record<Exclude<NewType, "github-actions">, [Record<string, unknown>, Record<string, unknown> | null]> = {
    sentry: [{ type: "sentry", label: "Sentry", access: "read", region: "us", orgSlug: "acme" }, { authToken: "sntrys_PROJECTCONNECTORTOKEN0123" }],
    datadog: [{ type: "datadog", label: "Datadog", access: "read", site: "datadoghq.eu" }, { apiKey: "dd-api-key-0123456789", appKey: "dd-app-key-0123456789" }],
    cloudwatch: [{ type: "cloudwatch", label: "CloudWatch", access: "read", roleArn: "arn:aws:iam::123456789012:role/rovara-read", regions: ["us-east-1"] }, null],
    grafana: [{ type: "grafana", label: "Grafana", access: "read", baseUrl: "https://grafana.acme.dev" }, { serviceAccountToken: "glsa_SECRET0123456789" }],
    vercel: [{ type: "vercel", label: "Vercel", access: "read" }, { token: "vercel-token-0123456789" }],
    pagerduty: [{ type: "pagerduty", label: "PagerDuty", access: "read", region: "eu" }, { apiKey: "pd-api-key-0123456789" }],
  };
  /** The tool lists Tasks 13 to 17 fill, stood in for here: a stub per type, restored after each test. */
  const STUB_TOOLS: Record<NewType, string[]> = {
    sentry: ["list_things", "get_thing"], datadog: ["list_things"], cloudwatch: ["list_things"], "github-actions": ["list_things"], grafana: ["list_things"], vercel: ["list_things"], pagerduty: ["list_things"],
  };
  // Each test starts with every new type's list empty and puts back what Tasks 13 to 17 filled in; a test stands in the lists it needs.
  const filled = { ...PROJECT_CONNECTOR_TOOLS };
  const stub = (types: readonly NewType[] = NEW_TYPES) => { for (const type of types) PROJECT_CONNECTOR_TOOLS[type] = STUB_TOOLS[type]; };
  beforeEach(() => { for (const type of NEW_TYPES) PROJECT_CONNECTOR_TOOLS[type] = []; });
  afterEach(() => { Object.assign(PROJECT_CONNECTOR_TOOLS, filled); });

  const connectionOf = async (s: Install, type: Exclude<NewType, "github-actions">, who: Developer = DANA) => {
    const [body, secret] = CONNECTIONS[type];
    return s.connection(body, secret, who);
  };
  const connectorOf = (type: NewType, id?: string): Record<string, unknown> => (type === "github-actions" ? sample(type) : { ...sample(type), credentialRef: id });

  it("accepts no tool of a type whose list is empty, so a type is usable only once its task lists its tools", async () => {
    QUIET();
    const s = await install();
    const id = await connectionOf(s, "sentry");
    const refused = await s.put(MIA, "sentry", connectorOf("sentry", id));
    expect(refused.status).toBe(400);
    expect(refused.body.error).toEqual({ code: "CONFIG_INVALID", message: "tools.0: list_things is not a sentry tool" });
    expect(s.revisions()).toHaveLength(1);
    await s.fakeLinear.close();
  });

  it.each(NEW_TYPES)("adds a %s connector that lists only tools of its type, keeps every other field, and writes one revision", async (type) => {
    const log = QUIET();
    stub();
    const s = await install();
    const id = type === "github-actions" ? undefined : await connectionOf(s, type);
    const body = connectorOf(type, id);
    const saved = await s.put(MIA, body["name"] as string, body);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ revision: 2, connector: { name: body["name"], type, tools: [{ name: "list_things", access: "read" }], ...(id === undefined ? {} : { connectionId: id }) } });
    expect(s.revision(2)!.definition).toEqual({ ...s.revision(1)!.definition, revision: 2, integrations: { connectors: [body] } });
    const read = await s.list(CARL);
    expect(read.body).toMatchObject({ revision: 2, connectors: [{ name: body["name"], type }] });
    expect(JSON.stringify(read.body)).not.toMatch(/sntrys_|dd-api-key|glsa_|vercel-token|pd-api-key/);
    // No vendor connector exists for the type yet, which the log says by name and which shows as a status the person can read.
    expect(log.mock.calls.every(([line]) => String(line).includes("connector.type_unknown"))).toBe(true);
    await s.fakeLinear.close();
  });

  it("refuses a tool outside its type's list with the plan's words, at the tool's place, and writes no revision", async () => {
    QUIET();
    stub(["sentry"]);
    const s = await install();
    const id = await connectionOf(s, "sentry");
    const refused = await s.put(MIA, "sentry", { ...connectorOf("sentry", id), tools: [...THINGS, { name: "resolve_issue", access: "read" }] });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toEqual({ code: "CONFIG_INVALID", message: "tools.1: resolve_issue is not a sentry tool" });
    // A tool of another new type's list is not this type's.
    stub(["vercel"]);
    PROJECT_CONNECTOR_TOOLS["vercel"] = ["deploy_things"];
    expect((await s.put(MIA, "sentry", { ...connectorOf("sentry", id), tools: [{ name: "deploy_things", access: "read" }] })).body.error)
      .toMatchObject({ code: "CONFIG_INVALID", message: "tools.0: deploy_things is not a sentry tool" });
    expect(s.revisions()).toHaveLength(1);
    expect(s.requestItems()).toHaveLength(0);
    expect(s.approvals()).toHaveLength(0);
    await s.fakeLinear.close();
  });

  it("holds a connector that changes nothing it was confirmed for to the list as it stands, so a narrowing cannot keep a tool the type no longer offers", async () => {
    QUIET();
    stub(["sentry"]);
    const s = await install();
    const id = await connectionOf(s, "sentry");
    const two = { ...connectorOf("sentry", id), tools: [{ name: "list_things", access: "read" }, { name: "get_thing", access: "read" }] };
    expect((await s.put(MIA, "sentry", two)).status).toBe(200);
    PROJECT_CONNECTOR_TOOLS["sentry"] = ["list_things"];
    // The same target with fewer tools holds what was confirmed, and needs no connection; its tools are still the type's.
    const kept = await s.put(MIA, "sentry", { ...two, tools: [{ name: "get_thing", access: "read" }] }, { expectedRevision: 2 });
    expect(kept.body.error).toEqual({ code: "CONFIG_INVALID", message: "tools.0: get_thing is not a sentry tool" });
    expect((await s.put(MIA, "sentry", { ...two, tools: [{ name: "list_things", access: "read" }] }, { expectedRevision: 2 })).status).toBe(200);
    expect(s.revisions()).toHaveLength(3);
    await s.fakeLinear.close();
  });

  it.each(NEW_TYPES)("refuses a %s tool approved to write outright, never to the confirmation page, writing nothing", async (type) => {
    QUIET();
    stub();
    const s = await install();
    const id = type === "github-actions" ? undefined : await connectionOf(s, type);
    const body: Record<string, unknown> = { ...connectorOf(type, id), tools: [...THINGS, { name: "list_things_again", access: "write" }] };
    PROJECT_CONNECTOR_TOOLS[type] = ["list_things", "list_things_again"];
    const refused = await s.put(MIA, body["name"] as string, body);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toEqual({ code: "CONFIG_INVALID", message: `tools.1: ${type} connectors are read-only` });
    expect(s.revisions()).toHaveLength(1);
    expect(s.approvals()).toHaveLength(0);
    expect(s.requestItems()).toHaveLength(0);
    await s.fakeLinear.close();
  });

  it("refuses a write tool that is also outside the list as read-only, since the shape is judged before the list", async () => {
    QUIET();
    stub(["sentry"]);
    const s = await install();
    const id = await connectionOf(s, "sentry");
    const refused = await s.put(MIA, "sentry", { ...connectorOf("sentry", id), tools: [{ name: "resolve_issue", access: "write" }] });
    expect(refused.body.error).toEqual({ code: "CONFIG_INVALID", message: "tools.0: sentry connectors are read-only" });
    await s.fakeLinear.close();
  });

  it("gives org B naming org A's connection Plan 3's 400 for a new type, the same as an id nobody has, and writes no revision", async () => {
    QUIET();
    stub();
    const s = await install();
    const idInA = await connectionOf(s, "sentry");
    const missing = "con_zzzzzzzzzzzzzzzzzzzz";
    const theirs = await s.put(OMAR, "sentry", connectorOf("sentry", idInA));
    const absent = await s.put(OMAR, "sentry", connectorOf("sentry", missing));
    expect(theirs.status).toBe(400);
    expect(theirs.body.error).toEqual({ code: "CONFIG_INVALID", message: `credentialRef: no sentry connection called ${idInA} in your organization` });
    expect(absent.body.error).toEqual({ code: "CONFIG_INVALID", message: `credentialRef: no sentry connection called ${missing} in your organization` });
    expect(s.revisions("web", ORG_B)).toHaveLength(1);
    expect(s.requestItems()).toHaveLength(0);
    // The connection is still org A's to use.
    expect((await s.put(MIA, "sentry", connectorOf("sentry", idInA))).status).toBe(200);
    expect(s.revisions("web", ORG_B)).toHaveLength(1);
    await s.fakeLinear.close();
  });

  it("refuses a connection of another type with the same text, whichever new type it is", async () => {
    QUIET();
    stub();
    const s = await install();
    const linearId = await s.connection({ type: "linear", label: "Team Linear", access: "read" });
    const vercelId = await connectionOf(s, "vercel");
    for (const [type, id] of [["sentry", linearId], ["sentry", vercelId], ["pagerduty", vercelId]] as const) {
      const refused = await s.put(MIA, type, connectorOf(type, id));
      expect(refused.body.error, `${type} on ${id}`).toEqual({ code: "CONFIG_INVALID", message: `credentialRef: no ${type} connection called ${id} in your organization` });
    }
    expect(s.revisions()).toHaveLength(1);
    await s.fakeLinear.close();
  });

  it("asks a connection that takes a key for one, and asks CloudWatch for none, since a role stands in for it", async () => {
    QUIET();
    stub();
    const s = await install();
    const [sentryBody] = CONNECTIONS.sentry;
    const empty = await s.connection(sentryBody, null);
    const refused = await s.put(MIA, "sentry", connectorOf("sentry", empty));
    expect(refused.body.error).toEqual({ code: "CONFIG_INVALID", message: "credentialRef: Sentry has no key saved yet; add one to the connection first" });
    expect(s.revisions()).toHaveLength(1);
    const role = await connectionOf(s, "cloudwatch");
    const saved = await s.put(MIA, "cloudwatch", connectorOf("cloudwatch", role));
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    await s.fakeLinear.close();
  });

  it("keeps the rules a connection brings: a removed connection refuses the save, and a narrowing still goes through", async () => {
    QUIET();
    stub();
    const s = await install();
    const id = await connectionOf(s, "sentry");
    const two = { ...connectorOf("sentry", id), scopes: [{ alias: "web", projectSlug: "web-app" }, { alias: "api", projectSlug: "api-app" }] };
    expect((await s.put(MIA, "sentry", two)).status).toBe(200);
    expect((await s.call(DANA, "DELETE", `/v1/app/connections/${id}`, {})).status).toBe(200);
    expect((await s.put(MIA, "sentry", connectorOf("sentry", id), { expectedRevision: 2 })).status).toBe(200);
    const again = await s.put(MIA, "other", { ...connectorOf("sentry", id), name: "other" }, { expectedRevision: 3 });
    expect(again.body.error).toMatchObject({ code: "CONFIG_INVALID", message: `credentialRef: no sentry connection called ${id} in your organization` });
    await s.fakeLinear.close();
  });

  it("applies a scope added to a read-only connector at once, with no confirmation, and records the change as an update", async () => {
    QUIET();
    stub();
    const s = await install();
    const id = await connectionOf(s, "sentry");
    expect((await s.put(MIA, "sentry", connectorOf("sentry", id))).status).toBe(200);
    const wider = { ...connectorOf("sentry", id), scopes: [{ alias: "web", projectSlug: "web-app" }, { alias: "api", projectSlug: "api-app" }] };
    const saved = await s.put(MIA, "sentry", wider, { expectedRevision: 2 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.revision).toBe(3);
    expect(s.approvals()).toHaveLength(0);
    expect(s.audit.recordedBy("project_connector.changed").at(-1)?.facts?.["change"]).toBe("updated");
    await s.fakeLinear.close();
  });

  it("takes a github-actions connector with no connection, held to this project's repositories as github is", async () => {
    QUIET();
    stub();
    const s = await install();
    const outside = await s.put(MIA, "gha", sample("github-actions", { scopes: ["web", "elsewhere"] }));
    expect(outside.status).toBe(400);
    expect(outside.body.error).toEqual({ code: "CONFIG_INVALID", message: "scopes.1: is not a repository of this project" });
    const withRef = await s.put(MIA, "gha", sample("github-actions", { credentialRef: CON, secretValue: "x" }));
    expect(withRef.status).toBe(400);
    expect(JSON.stringify(withRef.body)).not.toContain("secretValue");
    expect(s.revisions()).toHaveLength(1);
    const all = await s.put(MIA, "gha", sample("github-actions", { scopes: "all-repositories" }));
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(all.body.connector).toMatchObject({ type: "github-actions", scopes: "all-repositories" });
    expect(all.body.connector).not.toHaveProperty("connectionId");
    await s.fakeLinear.close();
  });

  it("repeats a request without a second revision, and removes a new-type connector", async () => {
    QUIET();
    stub();
    const s = await install();
    const id = await connectionOf(s, "pagerduty");
    const requestId = randomUUID();
    const first = await s.put(MIA, "pagerduty", connectorOf("pagerduty", id), {}, requestId);
    const second = await s.put(MIA, "pagerduty", connectorOf("pagerduty", id), {}, requestId);
    expect(first.status).toBe(200);
    expect(second.body).toMatchObject({ revision: 2, connector: { name: "pagerduty" } });
    expect(s.revisions()).toHaveLength(2);
    const removed = await s.del(MIA, "pagerduty", { expectedRevision: 2 });
    expect(removed.body).toEqual({ removed: { name: "pagerduty" }, revision: 3 });
    expect(s.revision(3)!.definition).not.toHaveProperty("integrations");
    await s.fakeLinear.close();
  });

  it("holds a project to twelve connectors: the twelfth is written, the thirteenth refused with no revision", async () => {
    QUIET();
    stub(["sentry"]);
    const s = await install();
    const id = await connectionOf(s, "sentry");
    for (let index = 1; index <= 12; index += 1) {
      const saved = await s.put(MIA, `s${String(index)}`, { ...connectorOf("sentry", id), name: `s${String(index)}` }, { expectedRevision: index });
      expect(saved.status, `connector ${String(index)}: ${JSON.stringify(saved.body)}`).toBe(200);
    }
    const thirteenth = await s.put(MIA, "s13", { ...connectorOf("sentry", id), name: "s13" }, { expectedRevision: 13 });
    expect(thirteenth.status).toBe(400);
    expect(thirteenth.body.error?.code).toBe("CONFIG_INVALID");
    expect(s.revisions()).toHaveLength(13);
    await s.fakeLinear.close();
  });
});


describe("Plan 4 Task 13: sentry on the project connectors", () => {
  const sentryOf = (id: string, tools: unknown[]) => ({ name: "errors", type: "sentry", credentialRef: id, scopes: [{ alias: "web", projectSlug: "web-app" }], tools });

  it("lists the four tools Sentry's connector offers, all reads", () => {
    expect(PROJECT_CONNECTOR_TOOLS.sentry).toEqual(["list_issues", "get_issue", "get_latest_event", "list_releases"]);
  });

  it("accepts a sentry connector approving list_issues, and refuses resolve_issue with Task 12's text, writing no revision", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const s = await install();
    const id = await s.connection({ type: "sentry", label: "Sentry", access: "read", region: "us", orgSlug: "acme" }, { authToken: "sntrys_PROJECTCONNECTORTOKEN0123" });
    const refused = await s.put(MIA, "errors", sentryOf(id, [{ name: "list_issues", access: "read" }, { name: "resolve_issue", access: "read" }]));
    expect(refused.status).toBe(400);
    expect(refused.body.error).toEqual({ code: "CONFIG_INVALID", message: "tools.1: resolve_issue is not a sentry tool" });
    expect(s.revisions()).toHaveLength(1);
    const saved = await s.put(MIA, "errors", sentryOf(id, [{ name: "list_issues", access: "read" }]));
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ revision: 2, connector: { name: "errors", type: "sentry", connectionId: id } });
    await s.fakeLinear.close();
  });
});

describe("Plan 4 Task 14: datadog and grafana on the project connectors", () => {
  it("lists each type's tools, all reads", () => {
    expect(PROJECT_CONNECTOR_TOOLS.datadog).toEqual(["search_monitors", "get_monitor", "query_metrics", "search_logs"]);
    expect(PROJECT_CONNECTOR_TOOLS.grafana).toEqual(["list_firing_alerts", "get_alert_rule", "get_dashboard", "query_prometheus"]);
  });

  it("accepts a datadog and a grafana connector approving their tools, and refuses an unlisted one with Task 12's text, writing no revision", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const s = await install();
    const dd = await s.connection({ type: "datadog", label: "Datadog", access: "read", site: "datadoghq.eu" }, { apiKey: "dd-api-key-0123456789", appKey: "dd-app-key-0123456789" });
    const gf = await s.connection({ type: "grafana", label: "Grafana", access: "read", baseUrl: "https://grafana.acme.dev" }, { serviceAccountToken: "glsa_SECRET0123456789" });
    const datadog = (tools: unknown[]) => ({ name: "metrics", type: "datadog", credentialRef: dd, scopes: [{ alias: "pay", tags: ["service:payments"] }], tools });
    const grafana = (tools: unknown[]) => ({ name: "dash", type: "grafana", credentialRef: gf, scopes: [{ alias: "all" }], tools });
    const refusedDd = await s.put(MIA, "metrics", datadog([{ name: "search_logs", access: "read" }, { name: "mute_monitor", access: "read" }]));
    expect(refusedDd.body.error).toEqual({ code: "CONFIG_INVALID", message: "tools.1: mute_monitor is not a datadog tool" });
    const refusedGf = await s.put(MIA, "dash", grafana([{ name: "silence_alert", access: "read" }]));
    expect(refusedGf.body.error).toEqual({ code: "CONFIG_INVALID", message: "tools.0: silence_alert is not a grafana tool" });
    expect(s.revisions()).toHaveLength(1);
    expect((await s.put(MIA, "metrics", datadog([{ name: "search_logs", access: "read" }]))).status).toBe(200);
    expect((await s.put(MIA, "dash", grafana([{ name: "list_firing_alerts", access: "read" }]), { expectedRevision: 2 })).status).toBe(200);
    await s.fakeLinear.close();
  });
});


describe("Plan 4 Task 16: cloudwatch on the project connectors", () => {
  it("lists the four tools CloudWatch's connector offers, all reads", () => {
    expect(PROJECT_CONNECTOR_TOOLS.cloudwatch).toEqual(["list_alarms", "get_alarm_history", "get_metric_data", "query_logs"]);
  });

  it("accepts a cloudwatch connector (a connection with no key) approving its tools, and refuses an unlisted one with Task 12's text, writing no revision", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const s = await install();
    const cw = await s.connection({ type: "cloudwatch", label: "CloudWatch", access: "read", roleArn: "arn:aws:iam::123456789012:role/rovara-read", regions: ["us-east-1"] }, null);
    const cloudwatch = (tools: unknown[]) => ({ name: "aws", type: "cloudwatch", credentialRef: cw, scopes: [{ alias: "prod", region: "us-east-1", logGroupPrefixes: ["/aws/lambda/pay"], alarmNamePrefix: "pay-" }], tools });
    expect((await s.put(MIA, "aws", cloudwatch([{ name: "put_metric_alarm", access: "read" }]))).body.error).toEqual({ code: "CONFIG_INVALID", message: "tools.0: put_metric_alarm is not a cloudwatch tool" });
    expect(s.revisions()).toHaveLength(1);
    expect((await s.put(MIA, "aws", cloudwatch([{ name: "list_alarms", access: "read" }, { name: "query_logs", access: "read" }]))).status).toBe(200);
    await s.fakeLinear.close();
  });
});

describe("Plan 4 Task 17: github-actions on the project connectors", () => {
  const TOOLS = ["list_workflow_runs", "get_workflow_execution", "list_execution_jobs", "get_job_log", "list_deployments", "list_deployment_statuses"];
  const gha = (tools: unknown[]) => ({ name: "gha", type: "github-actions", scopes: ["web"], tools });

  it("lists the six tools GitHub Actions' connector offers, all reads", () => {
    expect(PROJECT_CONNECTOR_TOOLS["github-actions"]).toEqual(TOOLS);
  });

  it("accepts a github-actions connector approving list_workflow_runs, and refuses cancel_workflow_run and any other unlisted tool with Task 12's text, writing no revision", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const s = await install();
    for (const name of ["cancel_workflow_run", "rerun_workflow", "run_workflow", "create_deployment", "get_secret", "list_secrets"]) {
      const refused = await s.put(MIA, "gha", gha([{ name: "list_workflow_runs", access: "read" }, { name, access: "read" }]));
      expect(refused.status, name).toBe(400);
      expect(refused.body.error, name).toEqual({ code: "CONFIG_INVALID", message: `tools.1: ${name} is not a github-actions tool` });
    }
    expect(s.revisions()).toHaveLength(1);
    expect(s.approvals()).toHaveLength(0);
    const saved = await s.put(MIA, "gha", gha([{ name: "list_workflow_runs", access: "read" }, { name: "get_job_log", access: "read" }]));
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ revision: 2, connector: { name: "gha", type: "github-actions", scopes: ["web"] } });
    await s.fakeLinear.close();
  });

  it("refuses a github-actions tool approved to write, and keeps the connector read-only", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const s = await install();
    const refused = await s.put(MIA, "gha", gha([{ name: "list_workflow_runs", access: "write" }]));
    expect(refused.status).toBe(400);
    expect(refused.body.error).toEqual({ code: "CONFIG_INVALID", message: "tools.0: github-actions connectors are read-only" });
    expect(s.revisions()).toHaveLength(1);
    await s.fakeLinear.close();
  });
});

describe("Plan 4 Task 15: pagerduty and vercel on the project connectors", () => {
  it("lists each type's tools, all reads", () => {
    expect(PROJECT_CONNECTOR_TOOLS.pagerduty).toEqual(["list_incidents", "get_incident", "list_incident_log_entries", "list_oncalls"]);
    expect(PROJECT_CONNECTOR_TOOLS.vercel).toEqual(["list_deployments", "get_deployment", "get_deployment_events"]);
  });

  it("accepts a pagerduty and a vercel connector approving their tools, and refuses an unlisted one with Task 12's text, writing no revision", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const s = await install();
    const pd = await s.connection({ type: "pagerduty", label: "PagerDuty", access: "read", region: "eu" }, { apiKey: "pd-api-key-0123456789" });
    const vc = await s.connection({ type: "vercel", label: "Vercel", access: "read" }, { token: "vercel-token-0123456789" });
    const pagerduty = (tools: unknown[]) => ({ name: "oncall", type: "pagerduty", credentialRef: pd, scopes: [{ alias: "pay", serviceIds: ["PSVC001"] }], tools });
    const vercel = (tools: unknown[]) => ({ name: "deploys", type: "vercel", credentialRef: vc, scopes: [{ alias: "site", projectId: "prj_web1" }], tools });
    expect((await s.put(MIA, "oncall", pagerduty([{ name: "resolve_incident", access: "read" }]))).body.error).toEqual({ code: "CONFIG_INVALID", message: "tools.0: resolve_incident is not a pagerduty tool" });
    expect((await s.put(MIA, "deploys", vercel([{ name: "promote_deployment", access: "read" }]))).body.error).toEqual({ code: "CONFIG_INVALID", message: "tools.0: promote_deployment is not a vercel tool" });
    expect(s.revisions()).toHaveLength(1);
    expect((await s.put(MIA, "oncall", pagerduty([{ name: "list_incidents", access: "read" }]))).status).toBe(200);
    expect((await s.put(MIA, "deploys", vercel([{ name: "list_deployments", access: "read" }]), { expectedRevision: 2 })).status).toBe(200);
    await s.fakeLinear.close();
  });
});

it("refuses the connectors registerRevision path with a fixed409 when latest has working branch selections",async()=>{const s=await install(),id=await s.connection({type:"linear",label:"Team Linear",access:"read"}),key=projectRevisionKey(TEST_ORG,"web",1),before=s.h.db.get(key)!;s.h.db.set({...before,workingBranchSelections:{web:{branch:"release/current"}}});const result=await s.put(MIA,"linear",linear(id));expect(result.status,JSON.stringify(result.body)).toBe(409);expect(result.body.error).toMatchObject({code:"PROJECT_REVISION_MISMATCH",message:STALE});expect(s.revision(2)).toBeUndefined();expect(s.h.db.get(key)?.workingBranchSelections).toEqual({web:{branch:"release/current"}});});
it("B33 connector requests refuse client website widening and approval capability fields", async () => {
 const s = await install(), id = await s.connection({ type: "linear", label: "Team Linear", access: "read" });
 const before = structuredClone(s.revision(1));
 for (const extra of [{ allowedDomains: ["bypass.acme.dev"] }, { network: { allowedDomains: ["bypass.acme.dev"] } }, { appliedDomainProposal: { proposalId: randomUUID(), baseRevision: 1, afterDigest: "a".repeat(64) } }]) {
  const reply = await s.put(MIA, "linear", linear(id), extra);expect(reply.status, JSON.stringify(reply.body)).toBe(400);expect(reply.body.error?.code).toBe("CONFIG_INVALID");
  expect(s.revision(1)).toEqual(before);expect(s.revision(2)).toBeUndefined();
 }
});
