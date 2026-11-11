// Plan 4 Task 16: the AWS CloudWatch connector. Rovara assumes the customer's role (never holds a key), with the external id of the CALLER's org, and reads
// alarms, metrics and Logs Insights through a session that a policy of its own holds to nine read actions. Every test runs against a fake AWS
// (tests/support/fake-cloudwatch-aws.ts); no test reaches AWS, and the global fetch fails the test if anything uses it.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverTools, executeTool, type ConnectorDefinition, type Ledger } from "@agentx/gateway";
import { type GrantedTool, type OrgId } from "@rovara-code/contracts";
import { ProjectDefinitionSchema } from "@agentx/cloud-contracts";
import { AWS_REGIONS, cloudwatchExternalId } from "@rovara-code/contracts";
import { BUILT_IN_CONNECTOR_TYPES, resolveConnectors, type ResolvedConnector } from "../../packages/broker/src/aws/connector-types.js";
import { awsCloudWatchAccess, cloudwatchConnectionCheck, cloudwatchConnectorType } from "../../packages/broker/src/aws/cloudwatch-connector-type.js";
import {
  CLOUDWATCH_SESSION_ACTIONS,
  CLOUDWATCH_TOOLS,
  CLOUDWATCH_TOOL_NAMES,
  cloudwatchTrustPolicy,
  type CloudWatchAws,
} from "../../packages/broker/src/connectors/native/cloudwatch.js";
import { PROJECT_CONNECTOR_TOOLS } from "../../packages/broker/src/connections/project-connectors.js";
import { orgCredentialRegistry } from "../../packages/broker/src/connections/registry.js";
import { routeConnectionRequest } from "../../packages/broker/src/connections/routes.js";
import { OrgConnectionStore } from "../../packages/broker/src/connections/store.js";
import { OrgSecrets } from "../../packages/broker/src/connections/org-secrets.js";
import { classifyWrite } from "../../packages/broker/src/agents/write-class.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { FAKE_CONNECTOR_ROLE_ARN, FakeOrgSecrets } from "../support/fake-org-secrets.js";
import { CUSTOMER_ACCOUNT, CUSTOMER_ROLE, OWN_ACCOUNT, START_MS, awsError, fakeCloudWatchAws, type FakeCloudWatchOptions } from "../support/fake-cloudwatch-aws.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import { createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { TEST_ORG } from "../support/orgs.js";

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const ENV = "staging";
const CON = "con_aaaaaaaaaaaaaaaaaaaa";
const ALICE = "a".repeat(64);
const BROKER_ROLE = `arn:aws:iam::${OWN_ACCOUNT}:role/agentx/staging/BrokerServiceRole`;
const TOOLS = ["list_alarms", "get_alarm_history", "get_metric_data", "query_logs"] as const;
const PROD = { alias: "prod", region: "us-east-1", logGroupPrefixes: ["/aws/lambda/pay", "/ecs/pay"], alarmNamePrefix: "pay-" };
const BARE = { alias: "bare", region: "eu-west-1" };
const FAR = { alias: "far", region: "ap-south-1", logGroupPrefixes: ["/aws/lambda/pay"] };
const ROLES = (org: OrgId = ORG_A) => ({ [CUSTOMER_ROLE]: { externalId: cloudwatchExternalId(org) } });

// Nothing here may reach AWS or the web: the global fetch fails the test.
beforeEach(() => { vi.stubGlobal("fetch", () => { throw new Error("test: the global fetch was used; the CloudWatch connector and its check use only the AWS port they are given"); }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function setup() {
  const fake = new FakeOrgSecrets({ env: ENV, now: () => Date.now() });
  const db = new FakeDynamoDb();
  const secrets = new OrgSecrets({ env: ENV, roleArn: FAKE_CONNECTOR_ROLE_ARN, sts: fake.sts, secretsFor: fake.secretsFor, now: () => Date.now() });
  const deps = { documentClient: db, tableName: "T", env: ENV, secrets, now: () => START_MS, ownAccountId: OWN_ACCOUNT };
  return { db, deps, registry: orgCredentialRegistry(deps, ORG_A) };
}

const CONNECTION = { connectionId: CON, type: "cloudwatch", label: "AWS prod", access: "read", roleArn: CUSTOMER_ROLE, regions: ["us-east-1", "eu-west-1"] } as const;

async function connected(options: { checks?: ConstructorParameters<typeof OrgConnectionStore>[0]["checks"]; connection?: Record<string, unknown> } = {}) {
  const s = setup();
  const store = new OrgConnectionStore({ ...s.deps, checkEndpoint: async () => undefined, ...(options.checks === undefined ? {} : { checks: options.checks }) });
  await store.put({ orgId: ORG_A, connection: { ...CONNECTION, ...options.connection }, by: ALICE });
  return { ...s, store };
}

const connectorConfig = (over: Record<string, unknown> = {}) => ({
  name: "aws", type: "cloudwatch", credentialRef: CON, scopes: [PROD, BARE, FAR], tools: TOOLS.map((name) => ({ name, access: "read" })), ...over,
});
const project = (connectors: unknown[]) => ProjectDefinitionSchema.parse({
  name: "payments", revision: 1,
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
  setup: [], readiness: [], orchestratorInstructions: "x", integrations: { connectors },
});

type Scope = { alias: string };

async function open(options: { aws?: FakeCloudWatchOptions; orgId?: OrgId | undefined; connection?: Record<string, unknown>; tamper?: string; access?: CloudWatchAws | undefined; config?: Record<string, unknown> } = {}) {
  const s = await connected(options.connection === undefined ? {} : { connection: options.connection });
  if (options.tamper !== undefined) {
    // A stored record that names another external id: the connector must never read it.
    for (const item of s.db.items.values()) if (item["entityType"] === "ORG_CONNECTION") item["externalId"] = options.tamper;
  }
  const fake = fakeCloudWatchAws({ roles: ROLES(), ...options.aws });
  const orgId = "orgId" in options ? options.orgId : ORG_A;
  const aws = "access" in options ? options.access : fake.aws;
  const [connector] = resolveConnectors(project([connectorConfig(options.config)]), {
    credentialRegistry: s.registry, ...(orgId === undefined ? {} : { orgId }), ...(aws === undefined ? {} : { cloudwatchAws: aws }),
  }, { cloudwatch: cloudwatchConnectorType });
  return { ...s, fake, connector: connector!, async definition(): Promise<ConnectorDefinition<unknown> | { notConnected: string }> { return connector!.definition(); } };
}

async function ready(options: Parameters<typeof open>[0] = {}) {
  const o = await open(options);
  const definition = await o.definition();
  if ("notConnected" in definition) throw new Error(`not connected: ${definition.notConnected}`);
  return { ...o, definition };
}

const scopeOf = (connector: ResolvedConnector<unknown>, alias: string) => connector.scopes.find((entry) => entry.alias === alias)!.scope as Scope;
const context = (connector: ResolvedConnector<unknown>, alias = "prod") => ({
  workspaceId: "ws", ownerKey: "owner", scopeAlias: alias, scope: scopeOf(connector, alias), settingsRevision: 1,
  policy: { tools: TOOLS.map((name) => ({ name, access: "read" as const })) },
});
const ledger: Ledger = { claim: async () => true, get: async () => undefined, finish: async () => undefined };
const textOf = (result: { text: string }) => result.text;

async function run(tool: string, args: Record<string, unknown>, options: Parameters<typeof open>[0] = {}, alias = "prod") {
  const r = await ready(options);
  const ctx = context(r.connector, alias);
  const discovered = (await discoverTools(r.definition, ctx, { connect: r.connector.connect! })).tools.find((entry) => entry.name === tool)!;
  const result = await executeTool(
    { requestId: "11111111-1111-4111-8111-111111111111", scope: alias, tool, schemaHash: discovered.schemaHash, arguments: args },
    r.definition, ctx, { connect: r.connector.connect!, ledger },
  );
  return { ...r, result };
}

const failureOf = async (action: Promise<unknown>) => action.then(() => undefined, (error: { code?: string; name?: string; message: string }) => ({ code: error.code, name: error.name, message: error.message }));

describe("the CloudWatch connector type", () => {
  it("is built in, named cloudwatch, and resolves its label, vendor, scope noun, scopes and ledger; it names no registry credential (it holds no key)", async () => {
    expect(BUILT_IN_CONNECTOR_TYPES["cloudwatch"]).toBe(cloudwatchConnectorType);
    const { connector } = await open();
    expect(connector).toMatchObject({
      name: "aws", type: "cloudwatch", label: "CloudWatch", vendor: "CloudWatch", scopeNoun: "region", attribution: false,
      ledger: { prefix: "CONNECTOR#aws#", entityType: "CONNECTOR_INVOCATION" },
    });
    expect(connector.scopes.map((entry) => entry.alias)).toEqual(["prod", "bare", "far"]);
    // A token registered for a vendor host does not exist here: nothing is pinned or looked up in the credential registry.
    expect(connector.credential).toBeUndefined();
  });

  it("lists exactly the four tools a project may approve, no item argument, no label argument", async () => {
    expect(PROJECT_CONNECTOR_TOOLS.cloudwatch).toEqual([...TOOLS]);
    expect(CLOUDWATCH_TOOL_NAMES).toEqual([...TOOLS]);
    const { definition } = await ready();
    expect(definition.itemArguments).toEqual([]);
    expect(definition).not.toHaveProperty("labelArgument");
  });

  it("treats a malformed stored entry as unusable and never throws", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stored = { ...project([connectorConfig()]), integrations: { connectors: [connectorConfig({ scopes: [{ alias: "prod", region: "nowhere" }] })] } } as never;
    expect(resolveConnectors(stored, { credentialRegistry: setup().registry, orgId: ORG_A }, { cloudwatch: cloudwatchConnectorType })).toEqual([]);
    expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as { reason?: string }).find((line) => line.reason !== undefined)?.reason).toBe("invalid cloudwatch connector configuration: scopes");
  });

  it("is not connected, with its reason, when the deployment has no AWS access, no org, no registry, or the connection is not CloudWatch's or is gone", async () => {
    expect(await (await open({ access: undefined })).definition()).toEqual({ notConnected: "AWS access is not configured in this deployment" });
    expect(await (await open({ orgId: undefined })).definition()).toEqual({ notConnected: "CloudWatch connectors need an organization" });
    const bare = resolveConnectors(project([connectorConfig()]), { cloudwatchAws: fakeCloudWatchAws().aws, orgId: ORG_A }, { cloudwatch: cloudwatchConnectorType })[0]!;
    expect(await bare.definition()).toEqual({ notConnected: "connector credentials are not configured in this deployment" });
    // Another org's connection id reads exactly as one nobody has.
    const s = await connected();
    const other = resolveConnectors(project([connectorConfig()]), { credentialRegistry: orgCredentialRegistry(s.deps, ORG_B), orgId: ORG_B, cloudwatchAws: fakeCloudWatchAws().aws }, { cloudwatch: cloudwatchConnectorType })[0]!;
    expect(await other.definition()).toEqual({ notConnected: `connection ${CON} is not a CloudWatch connection` });
    expect(await other.configured()).toBe(false);
    // A connection of another type is not CloudWatch's.
    const mismatch = await connected();
    await mismatch.store.put({ orgId: ORG_A, connection: { connectionId: "con_bbbbbbbbbbbbbbbbbbbb", type: "vercel", label: "Vercel", access: "read" }, secret: { token: "vercel-token-0123456789" }, by: ALICE });
    const wrong = resolveConnectors(project([connectorConfig({ credentialRef: "con_bbbbbbbbbbbbbbbbbbbb" })]), { credentialRegistry: orgCredentialRegistry(mismatch.deps, ORG_A), orgId: ORG_A, cloudwatchAws: fakeCloudWatchAws().aws }, { cloudwatch: cloudwatchConnectorType })[0]!;
    expect(await wrong.definition()).toEqual({ notConnected: "connection con_bbbbbbbbbbbbbbbbbbbb is not a CloudWatch connection" });
  });
});

describe("assuming the customer's role (confused deputy)", () => {
  it("sends the caller org's external id, the session name, 900 seconds and a session policy of exactly the nine read actions", async () => {
    const { fake } = await run("list_alarms", {});
    expect(fake.assumed).toHaveLength(1);
    const call = fake.assumed[0]!;
    expect(call).toMatchObject({ RoleArn: CUSTOMER_ROLE, ExternalId: `rovara-${ORG_A}`, RoleSessionName: `rovara-${CON}`, DurationSeconds: 900 });
    expect(Object.keys(call).sort()).toEqual(["DurationSeconds", "ExternalId", "Policy", "RoleArn", "RoleSessionName"]);
    expect(CLOUDWATCH_SESSION_ACTIONS).toEqual([
      "cloudwatch:DescribeAlarms", "cloudwatch:DescribeAlarmHistory", "cloudwatch:GetMetricData", "cloudwatch:ListMetrics",
      "logs:DescribeLogGroups", "logs:FilterLogEvents", "logs:StartQuery", "logs:GetQueryResults", "logs:StopQuery",
    ]);
    expect(JSON.parse(call.Policy!)).toEqual({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: [...CLOUDWATCH_SESSION_ACTIONS], Resource: "*" }] });
    // Every action is a read: none writes, deletes, puts, tags or changes anything.
    for (const action of CLOUDWATCH_SESSION_ACTIONS) expect(action, action).toMatch(/^(cloudwatch|logs):(Describe|Get|List|Filter|Start|Stop)/u);
    expect(call.Policy!.length).toBeLessThan(2048);
  });

  it("ignores a stored record that names another external id: the call carries the caller org's own", async () => {
    const { fake, db } = await run("list_alarms", {}, { tamper: "rovara-org_cccccccccccccccccccc" });
    expect([...db.items.values()].some((item) => item["externalId"] === "rovara-org_cccccccccccccccccccc")).toBe(true);
    expect(fake.assumed.map((call) => call.ExternalId)).toEqual([`rovara-${ORG_A}`]);
    expect(fake.names()).toContain("DescribeAlarmsCommand");
  });

  it("sends ExternalId on every AssumeRole call: discovery, a tool call and the check, and the fake refuses a call without the caller's id", async () => {
    const r = await ready();
    await discoverTools(r.definition, context(r.connector), { connect: r.connector.connect! });
    const check = cloudwatchConnectionCheck(r.fake.aws);
    const connection = (await r.store.get(ORG_A, CON))!;
    await check({ orgId: ORG_A, connection: connection as never, secret: undefined, fetch: fetch });
    expect(r.fake.assumed.length).toBeGreaterThanOrEqual(2);
    // The check's own second attempt, with a wrong id on purpose (review I-1), is the one call that does not carry the caller's id.
    const wrong = r.fake.assumed.filter((call) => call.ExternalId !== `rovara-${ORG_A}`);
    expect(wrong).toHaveLength(1);
    expect(wrong[0]).toBe(r.fake.assumed.at(-1));
    for (const call of r.fake.assumed.slice(0, -1)) expect(call.ExternalId).toBe(`rovara-${ORG_A}`);
    // The fake's role requires its id: one asked without it, or with another org's, is refused.
    await expect(r.fake.aws.assumeRole({ RoleArn: CUSTOMER_ROLE, RoleSessionName: "x" })).rejects.toMatchObject({ name: "AccessDenied" });
    await expect(r.fake.aws.assumeRole({ RoleArn: CUSTOMER_ROLE, RoleSessionName: "x", ExternalId: `rovara-${ORG_B}` })).rejects.toMatchObject({ name: "AccessDenied" });
  });

  it("uses the org of the context for the external id: org B's own connection is assumed with org B's id, never org A's", async () => {
    const s = setup();
    const store = new OrgConnectionStore({ ...s.deps, checkEndpoint: async () => undefined });
    await store.put({ orgId: ORG_B, connection: CONNECTION, by: "b".repeat(64) });
    const fake = fakeCloudWatchAws({ roles: ROLES(ORG_B) });
    const [connector] = resolveConnectors(project([connectorConfig()]), { credentialRegistry: orgCredentialRegistry(s.deps, ORG_B), orgId: ORG_B, cloudwatchAws: fake.aws }, { cloudwatch: cloudwatchConnectorType });
    const definition = await connector!.definition() as ConnectorDefinition<unknown>;
    await definition.credentials.issue(scopeOf(connector!, "prod"), "read");
    expect(fake.assumed.map((call) => call.ExternalId)).toEqual([`rovara-${ORG_B}`]);
    // A role whose trust policy names org A's id is not assumable by org B's session.
    const strict = fakeCloudWatchAws({ roles: ROLES(ORG_A) });
    const [other] = resolveConnectors(project([connectorConfig()]), { credentialRegistry: orgCredentialRegistry(s.deps, ORG_B), orgId: ORG_B, cloudwatchAws: strict.aws }, { cloudwatch: cloudwatchConnectorType });
    const refused = await failureOf(((await other!.definition()) as ConnectorDefinition<unknown>).credentials.issue(scopeOf(other!, "prod"), "read"));
    expect(refused?.name).toBe("CredentialUnavailable");
  });

  it("refuses a region the connection does not cover, a write, and a role in the deployment's own account, each before any AssumeRole", async () => {
    const r = await ready();
    const issue = (alias: string, access: "read" | "write" = "read") => failureOf(r.definition.credentials.issue(scopeOf(r.connector, alias), access));
    expect((await issue("far"))).toMatchObject({ name: "CredentialUnavailable", message: "this connection is not set up for ap-south-1; add the region to the connection" });
    expect((await issue("prod", "write"))).toMatchObject({ name: "CredentialUnavailable", message: "CloudWatch connections are read-only" });
    expect(r.fake.assumed).toEqual([]);
    const own = await ready({ connection: {} });
    // The record is changed behind the store's back, as an older record could be: the connector refuses it too.
    for (const item of own.db.items.values()) if (item["entityType"] === "ORG_CONNECTION") item["roleArn"] = `arn:aws:iam::${OWN_ACCOUNT}:role/anything`;
    expect(await failureOf(own.definition.credentials.issue(scopeOf(own.connector, "prod"), "read"))).toMatchObject({ name: "CredentialUnavailable", message: "the role must be in your own AWS account, not Rovara's" });
    expect(own.fake.assumed).toEqual([]);
  });

  it("answers a refused AssumeRole in fixed words with nothing the AWS message said", async () => {
    const r = await ready({ aws: { roles: {} } });
    const failure = await failureOf(r.definition.credentials.issue(scopeOf(r.connector, "prod"), "read"));
    expect(failure).toMatchObject({ name: "CredentialUnavailable", message: "AWS refused to let Rovara assume the role; check the role's ARN, its trust policy and its external id" });
    expect(failure?.message).not.toContain("vendor's own message");
    const other = await ready({ aws: { roles: ROLES(), fail: {} } });
    other.fake.aws.assumeRole = async () => { throw awsError("ThrottlingException", "secret detail 0123456789"); };
    const throttled = await failureOf(other.definition.credentials.issue(scopeOf(other.connector, "prod"), "read"));
    expect(throttled).toMatchObject({ name: "CredentialUnavailable", message: "AWS could not be reached to assume the role; try again" });
  });

  it("reuses a session while it has more than a minute left, and assumes again after that, for another role, or once the engine says the credential failed", async () => {
    const r = await ready();
    const issue = () => r.definition.credentials.issue(scopeOf(r.connector, "prod"), "read");
    const first = await issue();
    expect(await issue()).toEqual(first);
    expect(r.fake.assumed).toHaveLength(1);
    // 14 minutes later (a minute left of 15): assumed again.
    await r.fake.aws.sleep(14 * 60_000 + 1);
    const later = await issue();
    expect(later).not.toEqual(first);
    expect(r.fake.assumed).toHaveLength(2);
    // The new session is reused in turn, until the engine says it failed.
    await r.fake.aws.sleep(60_000);
    expect(await issue()).toEqual(later);
    expect(r.fake.assumed).toHaveLength(2);
    await r.definition.credentials.invalidate?.(scopeOf(r.connector, "prod"));
    expect(await issue()).not.toEqual(later);
    expect(r.fake.assumed).toHaveLength(3);
    // A role edited since is a new session: the key holds the role.
    for (const item of r.db.items.values()) if (item["entityType"] === "ORG_CONNECTION") item["roleArn"] = "arn:aws:iam::123456789012:role/rovara-read-2";
    r.fake.aws.assumeRole = async (input) => { r.fake.assumed.push(input); return { accessKeyId: "ASIAOTHER", secretAccessKey: "other-secret-0123456789", sessionToken: "other-token-0123456789", expiration: new Date(START_MS + 99_999_999_999) }; };
    expect(JSON.parse((await issue()).token)).toMatchObject({ a: "ASIAOTHER" });
    expect(r.fake.assumed[3]!.RoleArn).toBe("arn:aws:iam::123456789012:role/rovara-read-2");
  });

  it("never lets the session's keys reach the model, even if an alarm's text quotes them", async () => {
    const r = await run("list_alarms", {}, { aws: { alarms: [{ name: "pay-errors", state: "ALARM" }], reasonOverride: (c) => `see ${c.sessionToken} and ${c.secretAccessKey}` } });
    const text = textOf(r.result);
    expect(text).toContain("pay-errors");
    expect(r.fake.issued.length).toBeGreaterThan(0);
    for (const issued of r.fake.issued) for (const value of [issued.sessionToken, issued.secretAccessKey]) expect(text).not.toContain(value);
    expect(text).toContain("[REDACTED]");
  });
});

describe("what the model is offered", () => {
  it("marks every tool read with the read-only hints, and shows no region, alias, prefix or account", async () => {
    const { definition, connector } = await ready();
    const { tools, skipped } = await discoverTools(definition, context(connector), { connect: connector.connect! });
    expect(skipped).toEqual([]);
    expect(tools.map((tool) => tool.name)).toEqual([...TOOLS]);
    for (const tool of tools) {
      expect(tool.access, tool.name).toBe("read");
      expect(tool.hints, tool.name).toEqual({ readOnlyHint: true, destructiveHint: false });
      const names = Object.keys(tool.inputSchema["properties"] as object);
      for (const hidden of ["region", "scopeAlias", "logGroupPrefixes", "alarmNamePrefix", "roleArn", "externalId"]) expect(names, tool.name).not.toContain(hidden);
    }
  });

  it("does not offer query_logs to a scope with no log group prefixes, and says why", async () => {
    const { definition, connector } = await ready();
    const { tools, skipped } = await discoverTools(definition, context(connector, "bare"), { connect: connector.connect! });
    expect(tools.map((tool) => tool.name)).toEqual(["list_alarms", "get_alarm_history", "get_metric_data"]);
    expect(skipped).toEqual([{ tool: "query_logs", reason: "this scope names no log group prefixes, so it has no log search" }]);
  });

  it("classifies every tool as a read in Plan 3's write gate", async () => {
    const { definition, connector } = await ready();
    const { tools } = await discoverTools(definition, context(connector), { connect: connector.connect! });
    for (const tool of tools) {
      const granted: GrantedTool = {
        connector: "aws", type: "cloudwatch", upstreamName: tool.name, presentedName: `aws__${tool.name}`, access: tool.access,
        facts: { connector: "aws", upstreamName: tool.name, access: tool.access, ...(tool.hints === undefined ? {} : { hints: tool.hints }) },
      };
      expect(classifyWrite({ tool: granted, args: { alarmName: "pay-a" }, rules: { alwaysAsk: [] }, autonomy: "run", allowMentions: false, ownItems: new Set<string>() }).class, tool.name).toBe("read");
    }
  });
});

describe("list_alarms", () => {
  const ALARMS = [
    { name: "pay-latency", state: "ALARM" as const }, { name: "pay-errors", state: "OK" as const }, { name: "pay-queue", state: "INSUFFICIENT_DATA" as const },
    { name: "other-team-alarm", state: "ALARM" as const },
  ];

  it("binds the scope's alarm prefix and region on every call and lists only alarms of the prefix, even if AWS answers more", async () => {
    const r = await run("list_alarms", {}, { aws: { alarms: ALARMS, leakAlarms: true } });
    const call = r.fake.callsOf("DescribeAlarmsCommand")[0]!;
    expect(call.input["AlarmNamePrefix"]).toBe("pay-");
    expect(call.region).toBe("us-east-1");
    expect(call.accessKeyId).toBe(r.fake.issued[0]!.accessKeyId);
    const text = textOf(r.result);
    expect(r.result.status).toBe("SUCCEEDED");
    expect(text).toContain("pay-latency");
    expect(text).not.toContain("other-team-alarm");
  });

  it("keeps only the alarms in the asked state, even if AWS answers alarms in other states", async () => {
    const r = await run("list_alarms", { state: "OK" }, { aws: { alarms: ALARMS, leakAlarms: true } });
    expect(r.fake.callsOf("DescribeAlarmsCommand")[0]!.input["StateValue"]).toBe("OK");
    const text = textOf(r.result);
    expect(text).toContain("pay-errors");
    for (const other of ["pay-latency", "pay-queue", "other-team-alarm"]) expect(text, other).not.toContain(other);
  });

  it("filters by state, and a scope with no prefix reads the region's alarms with no prefix sent", async () => {
    const stateful = await run("list_alarms", { state: "OK" }, { aws: { alarms: ALARMS } });
    expect(stateful.fake.callsOf("DescribeAlarmsCommand")[0]!.input["StateValue"]).toBe("OK");
    expect(textOf(stateful.result)).toContain("pay-errors");
    expect(textOf(stateful.result)).not.toContain("pay-latency");
    const bare = await run("list_alarms", {}, { aws: { alarms: ALARMS } }, "bare");
    expect(bare.fake.callsOf("DescribeAlarmsCommand")[0]!.input).not.toHaveProperty("AlarmNamePrefix");
    expect(bare.fake.callsOf("DescribeAlarmsCommand")[0]!.region).toBe("eu-west-1");
    expect(textOf(bare.result)).toContain("other-team-alarm");
  });

  it("refuses a state outside the three, and any argument the schema does not name, before AWS is called", async () => {
    const bad = await run("list_alarms", { state: "BROKEN" }, { aws: { alarms: ALARMS } });
    expect(bad.result.status).toBe("FAILED");
    expect(bad.fake.calls).toEqual([]);
    // A routing value (the region, the alias, a prefix) is the server's: a model that names one is refused by the engine, and AWS is not called.
    for (const name of ["region", "scopeAlias", "logGroupPrefixes", "alarmNamePrefix"]) {
      await expect(run("list_alarms", { [name]: "eu-west-1" }, { aws: { alarms: ALARMS } }), name).rejects.toThrow("routing arguments are server controlled");
    }
    const extra = await run("list_alarms", { account: "999999999999" }, { aws: { alarms: ALARMS } });
    expect(extra.result.status).toBe("FAILED");
    expect(extra.fake.calls).toEqual([]);
  });
});

describe("get_alarm_history", () => {
  const HISTORY = [{ alarm: "pay-latency", type: "StateUpdate", summary: "Alarm updated from OK to ALARM", at: "2026-10-22T10:00:00.000Z" }];

  it("reads the history of an alarm that starts with the prefix, with a window of hoursAgo (24 by default)", async () => {
    const r = await run("get_alarm_history", { alarmName: "pay-latency" }, { aws: { history: HISTORY } });
    expect(r.result.status).toBe("SUCCEEDED");
    const call = r.fake.callsOf("DescribeAlarmHistoryCommand")[0]!;
    expect(call.input["AlarmName"]).toBe("pay-latency");
    expect((call.input["EndDate"] as Date).getTime() - (call.input["StartDate"] as Date).getTime()).toBe(24 * 3_600_000);
    expect(textOf(r.result)).toContain("Alarm updated from OK to ALARM");
    const short = await run("get_alarm_history", { alarmName: "pay-latency", hoursAgo: 3 }, { aws: { history: HISTORY } });
    const shortCall = short.fake.callsOf("DescribeAlarmHistoryCommand")[0]!;
    expect((shortCall.input["EndDate"] as Date).getTime() - (shortCall.input["StartDate"] as Date).getTime()).toBe(3 * 3_600_000);
  });

  it("shows only the history of the alarm asked for, even if AWS answers the history of others", async () => {
    const others = [...HISTORY, { alarm: "pay-errors", type: "StateUpdate", summary: "Alarm updated from ALARM to OK", at: "2026-10-22T09:00:00.000Z" }, { alarm: "other-team-alarm", type: "StateUpdate", summary: "another team's change", at: "2026-10-22T08:00:00.000Z" }];
    const r = await run("get_alarm_history", { alarmName: "pay-latency" }, { aws: { history: others, leakHistory: true } });
    const text = textOf(r.result);
    expect(text).toContain("1 history item for pay-latency");
    expect(text).toContain("Alarm updated from OK to ALARM");
    expect(text).not.toContain("ALARM to OK");
    expect(text).not.toContain("another team's change");
  });

  it("refuses an alarm outside the prefix before AWS is called, and one that merely contains the prefix", async () => {
    for (const name of ["other-team-alarm", "x-pay-latency", "PAY-latency", "pay"]) {
      const r = await run("get_alarm_history", { alarmName: name }, { aws: { history: HISTORY } });
      expect(r.result.status, name).toBe("FAILED");
      expect(textOf(r.result), name).toBe("that alarm is not in prod");
      expect(r.fake.callsOf("DescribeAlarmHistoryCommand"), name).toEqual([]);
    }
  });

  it("holds hoursAgo to 1 to 72 and refuses a name with characters an alarm name cannot hold", async () => {
    for (const args of [{ alarmName: "pay-a", hoursAgo: 0 }, { alarmName: "pay-a", hoursAgo: 73 }, { alarmName: "pay-a", hoursAgo: 1.5 }, { alarmName: "pay-\n" }, { alarmName: "" }, { hoursAgo: 2 }]) {
      const r = await run("get_alarm_history", args, { aws: { history: HISTORY } });
      expect(r.result.status, JSON.stringify(args)).toBe("FAILED");
      expect(r.fake.calls, JSON.stringify(args)).toEqual([]);
    }
  });
});

describe("get_metric_data", () => {
  const query = (over: Record<string, unknown> = {}) => ({ namespace: "AWS/Lambda", metricName: "Errors", dimensions: { FunctionName: "pay-handler" }, stat: "Sum", ...over });

  it("asks for each query as a metric stat over the window and period, and shows the series", async () => {
    const r = await run("get_metric_data", { queries: [query(), query({ metricName: "Duration", stat: "p99", dimensions: undefined })], fromMinutesAgo: 60, periodSeconds: 300 }, { aws: { series: [{ label: "Errors", values: [["2026-10-22T11:00:00.000Z", 2], ["2026-10-22T11:05:00.000Z", 9]] }] } });
    expect(r.result.status).toBe("SUCCEEDED");
    const call = r.fake.callsOf("GetMetricDataCommand")[0]!;
    const queries = call.input["MetricDataQueries"] as Array<Record<string, unknown>>;
    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatchObject({ Id: "q0", ReturnData: true, MetricStat: { Period: 300, Stat: "Sum", Metric: { Namespace: "AWS/Lambda", MetricName: "Errors", Dimensions: [{ Name: "FunctionName", Value: "pay-handler" }] } } });
    expect(queries[1]).toMatchObject({ Id: "q1", MetricStat: { Stat: "p99", Metric: { MetricName: "Duration", Dimensions: [] } } });
    expect((call.input["EndTime"] as Date).getTime() - (call.input["StartTime"] as Date).getTime()).toBe(60 * 60_000);
    expect(call.region).toBe("us-east-1");
    const text = textOf(r.result);
    expect(text).toContain("Errors");
    expect(text).toContain("9");
  });

  it("holds the arguments to the plan's bounds, refusing each before AWS is called", async () => {
    const six = Array.from({ length: 6 }, () => query());
    const cases: Array<[string, Record<string, unknown>]> = [
      ["six queries", { queries: six, fromMinutesAgo: 60, periodSeconds: 60 }],
      ["no query", { queries: [], fromMinutesAgo: 60, periodSeconds: 60 }],
      ["4 minutes", { queries: [query()], fromMinutesAgo: 4, periodSeconds: 60 }],
      ["1441 minutes", { queries: [query()], fromMinutesAgo: 1441, periodSeconds: 60 }],
      ["59 seconds", { queries: [query()], fromMinutesAgo: 60, periodSeconds: 59 }],
      ["3601 seconds", { queries: [query()], fromMinutesAgo: 60, periodSeconds: 3601 }],
      ["a period that is not a multiple of 60", { queries: [query()], fromMinutesAgo: 60, periodSeconds: 90 }],
      ["a stat outside the six", { queries: [query({ stat: "p95" })], fromMinutesAgo: 60, periodSeconds: 60 }],
      ["a dimension value that is not text", { queries: [query({ dimensions: { A: 1 } })], fromMinutesAgo: 60, periodSeconds: 60 }],
      ["eleven dimensions", { queries: [query({ dimensions: Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`D${String(index)}`, "v"])) })], fromMinutesAgo: 60, periodSeconds: 60 }],
      ["an unknown query field", { queries: [query({ accountId: "999999999999" })], fromMinutesAgo: 60, periodSeconds: 60 }],
      ["a missing period", { queries: [query()], fromMinutesAgo: 60 }],
    ];
    for (const [label, args] of cases) {
      const r = await run("get_metric_data", args);
      expect(r.result.status, label).toBe("FAILED");
      expect(r.fake.calls, label).toEqual([]);
    }
    for (const stat of ["Average", "Sum", "Maximum", "Minimum", "p90", "p99"]) {
      const ok = await run("get_metric_data", { queries: [query({ stat })], fromMinutesAgo: 5, periodSeconds: 3600 });
      expect(ok.result.status, stat).toBe("SUCCEEDED");
    }
  });
});

describe("get_metric_data, checks the tool makes itself", () => {
  const query = (dimensions: Record<string, string>) => ({ namespace: "AWS/Lambda", metricName: "Errors", dimensions, stat: "Sum" });

  it("refuses a dimension name with a character a dimension cannot hold, or longer than 255, before AWS is called, and accepts every character it may hold", async () => {
    for (const name of ["bad name", "a\"b", "x;y", "d$", "a".repeat(256), ""]) {
      const r = await run("get_metric_data", { queries: [query({ [name]: "v" })], fromMinutesAgo: 60, periodSeconds: 60 });
      expect(r.result.status, JSON.stringify(name)).toBe("FAILED");
      expect(textOf(r.result), JSON.stringify(name)).toBe("a dimension name may hold only letters, digits and _ . : / @ # = + -");
      expect(r.fake.calls, JSON.stringify(name)).toEqual([]);
    }
    const allowed = "AZaz09_.:/@#=+-";
    const ok = await run("get_metric_data", { queries: [query({ [allowed]: "v", ["a".repeat(255)]: "w" })], fromMinutesAgo: 60, periodSeconds: 60 });
    expect(ok.result.status).toBe("SUCCEEDED");
    const sent = (ok.fake.callsOf("GetMetricDataCommand")[0]!.input["MetricDataQueries"] as Array<{ MetricStat: { Metric: { Dimensions: Array<{ Name: string }> } } }>)[0]!.MetricStat.Metric.Dimensions;
    expect(sent.map((dimension) => dimension.Name)).toEqual([allowed, "a".repeat(255)]);
  });

  it("offers a period of 60 to 3600 seconds in its schema, so no multiple of 60 above 3600 is ever sent", async () => {
    const { definition, connector } = await ready();
    const { tools } = await discoverTools(definition, context(connector), { connect: connector.connect! });
    const period = (tools.find((tool) => tool.name === "get_metric_data")!.inputSchema["properties"] as Record<string, Record<string, unknown>>)["periodSeconds"]!;
    expect(period).toMatchObject({ type: "integer", minimum: 60, maximum: 3600 });
    const r = await run("get_metric_data", { queries: [{ namespace: "AWS/Lambda", metricName: "Errors", stat: "Sum" }], fromMinutesAgo: 60, periodSeconds: 3660 });
    expect(r.result.status).toBe("FAILED");
    expect(r.fake.calls).toEqual([]);
  });
});

describe("query_logs", () => {
  const GROUPS = ["/aws/lambda/pay-handler", "/aws/lambda/pay-worker", "/ecs/pay-web", "/aws/lambda/billing", "/ecs/other"];

  it("sends only the log groups that match the scope's prefixes, even if AWS lists others, with the query and a window in seconds", async () => {
    const r = await run("query_logs", { query: "fields @timestamp, @message | filter @message like /ERROR/ | limit 20", fromMinutesAgo: 30 }, { aws: { logGroups: GROUPS, leakLogGroups: true } });
    expect(r.result.status, textOf(r.result)).toBe("SUCCEEDED");
    const start = r.fake.callsOf("StartQueryCommand");
    expect(start).toHaveLength(1);
    expect([...(start[0]!.input["logGroupNames"] as string[])].sort()).toEqual(["/aws/lambda/pay-handler", "/aws/lambda/pay-worker", "/ecs/pay-web"]);
    expect(start[0]!.input["queryString"]).toBe("fields @timestamp, @message | filter @message like /ERROR/ | limit 20");
    expect((start[0]!.input["endTime"] as number) - (start[0]!.input["startTime"] as number)).toBe(30 * 60);
    // Rows are capped at 100 on AWS's side as well as ours.
    expect(start[0]!.input["limit"]).toBe(100);
    expect(r.fake.callsOf("DescribeLogGroupsCommand").map((call) => call.input["limit"])).toEqual([50, 50]);
    expect(start[0]!.region).toBe("us-east-1");
    // The listing asked for each prefix.
    expect(r.fake.callsOf("DescribeLogGroupsCommand").map((call) => call.input["logGroupNamePrefix"])).toEqual(["/aws/lambda/pay", "/ecs/pay"]);
    const text = textOf(r.result);
    expect(text).toContain("ERROR timeout calling payments");
    expect(text).not.toContain("ptr-1");
    // A query that finished is not stopped.
    expect(r.fake.callsOf("StopQueryCommand")).toEqual([]);
  });

  it("refuses, before any query starts, when no log group matches the prefixes", async () => {
    const r = await run("query_logs", { query: "fields @message", fromMinutesAgo: 30 }, { aws: { logGroups: ["/ecs/other"] } });
    expect(r.result.status).toBe("FAILED");
    expect(textOf(r.result)).toBe("no log group matches this scope's prefixes");
    expect(r.fake.callsOf("StartQueryCommand")).toEqual([]);
  });

  it("polls a running query once a second for up to 20 seconds, then stops it and says so", async () => {
    const r = await run("query_logs", { query: "fields @message", fromMinutesAgo: 30 }, { aws: { logGroups: GROUPS, queryStatuses: ["Running"] } });
    expect(r.result.status).toBe("FAILED");
    expect(textOf(r.result)).toBe("the log query did not finish in 20 seconds and was stopped; narrow the time range or the query");
    expect(r.fake.callsOf("StopQueryCommand")).toHaveLength(1);
    expect(r.fake.callsOf("StopQueryCommand")[0]!.input["queryId"]).toBe("query-0001");
    expect(r.fake.elapsedMs()).toBeGreaterThanOrEqual(20_000);
    expect(r.fake.elapsedMs()).toBeLessThan(22_000);
    const polls = r.fake.callsOf("GetQueryResultsCommand").length;
    expect(polls).toBeGreaterThanOrEqual(20);
    expect(polls).toBeLessThanOrEqual(21);
  });

  it("answers a query that completes after a few polls, and refuses one that failed, in fixed words", async () => {
    const slow = await run("query_logs", { query: "fields @message", fromMinutesAgo: 30 }, { aws: { logGroups: GROUPS, queryStatuses: ["Scheduled", "Running", "Complete"] } });
    expect(slow.result.status).toBe("SUCCEEDED");
    expect(slow.fake.callsOf("GetQueryResultsCommand")).toHaveLength(3);
    expect(slow.fake.callsOf("StopQueryCommand")).toEqual([]);
    const failed = await run("query_logs", { query: "fields @message", fromMinutesAgo: 30 }, { aws: { logGroups: GROUPS, queryStatuses: ["Failed"] } });
    expect(failed.result.status).toBe("FAILED");
    expect(textOf(failed.result)).toBe("the log query ended as Failed");
  });

  it("stops the query when reading its results fails, and shows only fixed words", async () => {
    const r = await run("query_logs", { query: "fields @message", fromMinutesAgo: 30 }, { aws: { logGroups: GROUPS, fail: { GetQueryResultsCommand: awsError("ThrottlingException", "Rate exceeded for account 123456789012 secret-detail") } } });
    expect(r.result.status).toBe("FAILED");
    expect(textOf(r.result)).toBe("AWS is limiting requests; try again later");
    expect(textOf(r.result)).not.toContain("secret-detail");
    expect(r.fake.callsOf("StopQueryCommand")).toHaveLength(1);
  });

  it("holds the arguments to the plan's bounds and refuses a query that names its own log groups, before AWS is called", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["1001 characters", { query: "x".repeat(1001), fromMinutesAgo: 30 }],
      ["empty", { query: "", fromMinutesAgo: 30 }],
      ["4 minutes", { query: "fields @message", fromMinutesAgo: 4 }],
      ["1441 minutes", { query: "fields @message", fromMinutesAgo: 1441 }],
      ["a log group argument", { query: "fields @message", fromMinutesAgo: 30, logGroupNames: ["/ecs/other"] }],
      ["SOURCE first", { query: "SOURCE logGroups(namePrefix: ['/ecs/other']) | fields @message", fromMinutesAgo: 30 }],
      ["source after a pipe", { query: "fields @message | source logGroups(namePrefix: ['/ecs/other'])", fromMinutesAgo: 30 }],
      ["source on a new line", { query: "fields @message\n  SOURCE logGroups(namePrefix: ['/ecs/other'])", fromMinutesAgo: 30 }],
      // Any line break, or none at all, review M-1: a comment may end at a carriage return or a Unicode line break, and the command may follow anything.
      ["source after a comment ended by a carriage return", { query: "# c\rSOURCE logGroups(namePrefix: ['/ecs/other']) | fields @message", fromMinutesAgo: 30 }],
      ["source after U+2028", { query: "# c\u2028SOURCE logGroups(namePrefix: ['/ecs/other']) | fields @message", fromMinutesAgo: 30 }],
      ["source after U+2029", { query: "# c\u2029SOURCE logGroups(namePrefix: ['/ecs/other']) | fields @message", fromMinutesAgo: 30 }],
      ["source after U+0085", { query: "# c\u0085SOURCE logGroups(namePrefix: ['/ecs/other']) | fields @message", fromMinutesAgo: 30 }],
      ["source in the middle of a line", { query: "x SOURCE logGroups(namePrefix: ['/ecs/other'])", fromMinutesAgo: 30 }],
      ["source and logGroups split by a line break", { query: "fields @message | SOURCE\r\n\u2028logGroups (namePrefix: ['/ecs/other'])", fromMinutesAgo: 30 }],
      ["source command after each line break, whatever follows", { query: "# c\rSOURCE '/ecs/other'", fromMinutesAgo: 30 }],
      ["source command after U+2028, whatever follows", { query: "# c\u2028SOURCE '/ecs/other'", fromMinutesAgo: 30 }],
      ["source command after U+2029, whatever follows", { query: "# c\u2029SOURCE '/ecs/other'", fromMinutesAgo: 30 }],
      ["source command after U+0085, whatever follows", { query: "# c\u0085SOURCE '/ecs/other'", fromMinutesAgo: 30 }],
      ["a zero-width character between the words", { query: "fields @message | x source\u200blogGroups(namePrefix: ['/ecs/other'])", fromMinutesAgo: 30 }],
      ["a control character between the words", { query: "x source\u0001logGroups(namePrefix: ['/ecs/other'])", fromMinutesAgo: 30 }],
      ["mixed case", { query: "x SoUrCe LOGGROUPS(namePrefix: ['/ecs/other'])", fromMinutesAgo: 30 }],
    ];
    for (const [label, args] of cases) {
      const r = await run("query_logs", args, { aws: { logGroups: GROUPS } });
      expect(r.result.status, label).toBe("FAILED");
      expect(r.fake.calls, label).toEqual([]);
    }
    // The word in an ordinary filter is fine.
    const fine = await run("query_logs", { query: "fields @message | filter @message like /source/", fromMinutesAgo: 30 }, { aws: { logGroups: GROUPS } });
    expect(fine.result.status).toBe("SUCCEEDED");
    for (const query of ["fields @source | filter @message like /source/", "fields @message | filter @message like /source logGroups/", "stats count(*) by source", "filter @message like /resource logGroups(/", "filter @message like /source logGroups/"]) {
      const ok = await run("query_logs", { query, fromMinutesAgo: 30 }, { aws: { logGroups: GROUPS } });
      expect(ok.result.status, query).toBe("SUCCEEDED");
    }
  });

  it("is refused as an unavailable tool on a scope with no prefixes", async () => {
    const r = await run("query_logs", { query: "fields @message", fromMinutesAgo: 30 }, { aws: { logGroups: GROUPS } }, "bare").catch((error: Error) => ({ error }));
    // The tool is not in the scope's catalog, so there is nothing to discover and run.
    expect(r).toHaveProperty("error");
  });
});

describe("query_logs, checks the tool makes itself", () => {
  it("refuses a scope with no log group prefixes before AWS is asked, even when the engine would have offered it", async () => {
    const fake = fakeCloudWatchAws({ logGroups: ["/ecs/other", "/aws/lambda/pay-handler"], leakLogGroups: true });
    const credentials = { accessKeyId: "ASIADIRECT", secretAccessKey: "secret", sessionToken: "token", expiration: new Date(START_MS + 900_000) };
    const clients = fake.aws.clientsFor(credentials, "eu-west-1");
    const queryLogs = CLOUDWATCH_TOOLS.find((tool) => tool.name === "query_logs")!;
    const scope = { alias: "bare", region: "eu-west-1", logGroupPrefixes: [], alarmNamePrefix: "", aws: { monitoring: clients.monitoring, logs: clients.logs, now: () => fake.aws.now(), sleep: (ms: number) => fake.aws.sleep(ms) } };
    await expect(queryLogs.run({ query: "fields @message", fromMinutesAgo: 30 }, { scope, credential: { token: "t", bindings: {} }, fetch: () => { throw new Error("no fetch"); } }))
      .rejects.toMatchObject({ name: "NativeToolRefusal", message: "this scope names no log group prefixes, so it has no log search" });
    expect(fake.calls).toEqual([]);
  });
});

describe("what AWS says never reaches the model", () => {
  it("answers an AWS failure in fixed words by its class, never its message", async () => {
    const secret = "AKIAIOSFODNN7EXAMPLE arn:aws:iam::123456789012:role/rovara-read is not authorized to perform logs:StartQuery";
    const cases: Array<[string, string]> = [
      ["AccessDeniedException", "AWS refused the request; check that the role allows CloudWatch reads"],
      ["ThrottlingException", "AWS is limiting requests; try again later"],
      ["ResourceNotFoundException", "AWS has no such resource in this region"],
      ["InternalFailure", "AWS could not answer the request"],
    ];
    for (const [name, words] of cases) {
      const r = await run("list_alarms", {}, { aws: { alarms: [{ name: "pay-a", state: "OK" }], fail: { DescribeAlarmsCommand: awsError(name, secret) } } });
      expect(r.result.status, name).toBe("FAILED");
      expect(textOf(r.result), name).toBe(words);
      expect(JSON.stringify(r.result), name).not.toContain("AKIA");
    }
  });
});

describe("the connection check", () => {
  const check = async (options: FakeCloudWatchOptions = {}, connection: Record<string, unknown> = {}) => {
    const fake = fakeCloudWatchAws({ roles: ROLES(), alarms: [{ name: "pay-a", state: "OK" }], ...options });
    const s = await connected({ connection });
    const record = (await s.store.get(ORG_A, CON))!;
    const result = await cloudwatchConnectionCheck(fake.aws)({ orgId: ORG_A, connection: record as never, secret: undefined, fetch: fetch });
    return { fake, result };
  };

  it("assumes the role with the caller's external id, asks who it is with the assumed credentials, then reads one alarm", async () => {
    const { fake, result } = await check();
    expect(result).toEqual({ ok: true });
    expect(fake.assumed.map((call) => call.ExternalId)[0]).toBe(`rovara-${ORG_A}`);
    expect(fake.names()).toEqual(["GetCallerIdentityCommand", "DescribeAlarmsCommand"]);
    expect(fake.callsOf("DescribeAlarmsCommand")[0]!.input["MaxRecords"]).toBe(1);
    for (const call of fake.calls) expect(call.accessKeyId).toBe(fake.issued[0]!.accessKeyId);
    expect(fake.calls[0]!.region).toBe("us-east-1");
  });

  it("is not fooled by a stored external id: the record's is never read", async () => {
    const fake = fakeCloudWatchAws({ roles: ROLES(), alarms: [] });
    const s = await connected();
    const record = { ...(await s.store.get(ORG_A, CON))!, externalId: "rovara-org_cccccccccccccccccccc" };
    const result = await cloudwatchConnectionCheck(fake.aws)({ orgId: ORG_A, connection: record as never, secret: undefined, fetch: fetch });
    expect(result).toEqual({ ok: true });
    expect(fake.assumed.map((call) => call.ExternalId)[0]).toBe(`rovara-${ORG_A}`);
  });

  it("fails with a message to act on when the role cannot be assumed, and when it cannot read alarms, quoting nothing AWS said", async () => {
    const refused = await check({ roles: {} });
    expect(refused.result).toEqual({ ok: false, message: "AWS refused to let Rovara assume the role; check the role's ARN, its trust policy and its external id" });
    expect(refused.fake.callsOf("GetCallerIdentityCommand")).toEqual([]);
    const denied = await check({ fail: { DescribeAlarmsCommand: awsError("AccessDenied", "User: arn:aws:sts::1:assumed-role/x is not authorized (secret detail)") } });
    expect(denied.result).toEqual({ ok: false, message: "Rovara assumed the role but it cannot read CloudWatch alarms; give it cloudwatch:DescribeAlarms (for example the CloudWatchReadOnlyAccess policy)" });
  });

  it("throws a retryable RUNTIME_UNAVAILABLE for anything else, so nothing is recorded", async () => {
    const down = await failureOf(check({ fail: { GetCallerIdentityCommand: awsError("TimeoutError", "connect ETIMEDOUT 52.1.2.3") } }));
    expect(down?.code).toBe("RUNTIME_UNAVAILABLE");
    expect(down?.message).not.toContain("52.1.2.3");
  });

  it("tries the role once more with a random wrong external id, with the same role, session policy and duration, and passes when AWS refuses it (review I-1)", async () => {
    const { fake, result } = await check();
    expect(result).toEqual({ ok: true });
    expect(fake.assumed).toHaveLength(2);
    const [real, probe] = fake.assumed as [typeof fake.assumed[number], typeof fake.assumed[number]];
    expect(real.ExternalId).toBe(`rovara-${ORG_A}`);
    expect(probe.ExternalId).toMatch(/^rovara-org_[a-z0-9]{10,}$/u);
    expect(probe.ExternalId).not.toBe(real.ExternalId);
    expect({ ...probe, ExternalId: undefined }).toEqual({ ...real, ExternalId: undefined });
    expect(probe).toMatchObject({ RoleArn: CUSTOMER_ROLE, DurationSeconds: 900 });
    expect(probe.Policy).toBe(real.Policy);
    // The probe's session is never used: every call goes out with the first session.
    for (const call of fake.calls) expect(call.accessKeyId).toBe(fake.issued[0]!.accessKeyId);
    // A fresh random id each time, from the deployment's source when it gives one.
    const again = await check();
    expect(again.fake.assumed[1]!.ExternalId).not.toBe(probe.ExternalId);
    const fixed = fakeCloudWatchAws({ roles: ROLES(), alarms: [] });
    fixed.aws.random = () => "fixedprobe0123456789";
    const s = await connected();
    await cloudwatchConnectionCheck(fixed.aws)({ orgId: ORG_A, connection: (await s.store.get(ORG_A, CON))! as never, secret: undefined, fetch: fetch });
    expect(fixed.assumed[1]!.ExternalId).toBe("rovara-org_fixedprobe0123456789");
  });

  it("fails the check, in fixed words, when the role's trust policy accepts a wrong external id, and uses nothing of that session (review I-1)", async () => {
    const { fake, result } = await check({ anyExternalId: [CUSTOMER_ROLE] });
    expect(result).toEqual({ ok: false, message: `this role's trust policy must require the external id rovara-${ORG_A}` });
    expect(fake.assumed).toHaveLength(2);
    expect(fake.calls).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/ASIA|fakeSecret|FwoG/u);
  });

  it("throws a retryable RUNTIME_UNAVAILABLE, recording nothing, when the second attempt fails for any reason but a refusal (review I-1)", async () => {
    for (const name of ["ThrottlingException", "TimeoutError", "ServiceUnavailable"]) {
      const fake = fakeCloudWatchAws({ roles: ROLES(), alarms: [] });
      const real = fake.aws.assumeRole.bind(fake.aws);
      let count = 0;
      fake.aws.assumeRole = async (input) => { count += 1; if (count === 2) throw awsError(name, "secret detail 0123456789"); return real(input); };
      const s = await connected();
      const failure = await failureOf(cloudwatchConnectionCheck(fake.aws)({ orgId: ORG_A, connection: (await s.store.get(ORG_A, CON))! as never, secret: undefined, fetch: fetch }));
      expect(failure?.code, name).toBe("RUNTIME_UNAVAILABLE");
      expect(failure?.message, name).not.toContain("secret detail");
    }
  });

  it("refuses a role in the deployment's own account without calling AWS", async () => {
    const fake = fakeCloudWatchAws({ roles: ROLES() });
    const s = await connected();
    const record = { ...(await s.store.get(ORG_A, CON))!, roleArn: `arn:aws:iam::${OWN_ACCOUNT}:role/x` };
    const result = await cloudwatchConnectionCheck(fake.aws)({ orgId: ORG_A, connection: record as never, secret: undefined, fetch: fetch });
    expect(result).toEqual({ ok: false, message: "the role must be in your own AWS account, not Rovara's" });
    expect(fake.calls).toEqual([]);
    expect(fake.assumed).toEqual([]);
  });

  it("is what the store runs for a CloudWatch connection, and records it", async () => {
    const fake = fakeCloudWatchAws({ roles: ROLES(), alarms: [] });
    const s = await connected({ checks: { cloudwatch: cloudwatchConnectionCheck(fake.aws) } });
    expect(await s.store.check(ORG_A, CON)).toEqual({ ok: true });
    expect((await s.store.get(ORG_A, CON))?.lastCheck?.ok).toBe(true);
    expect(fake.assumed.map((call) => call.ExternalId)[0]).toBe(`rovara-${ORG_A}`);
  });
});

describe("the real AWS access", () => {
  it("assumes through the STS client it was given, and maps the credentials; a missing credential is an error", async () => {
    const sent: unknown[] = [];
    const expiration = new Date(START_MS + 900_000);
    const access = awsCloudWatchAccess({
      ownAccountId: OWN_ACCOUNT,
      sts: { send: async (command: unknown) => { sent.push(command); return { Credentials: { AccessKeyId: "ASIAX", SecretAccessKey: "secretX", SessionToken: "tokenX", Expiration: expiration } }; } },
    });
    expect(access.ownAccountId).toBe(OWN_ACCOUNT);
    const credentials = await access.assumeRole({ RoleArn: CUSTOMER_ROLE, RoleSessionName: "rovara-x", ExternalId: "rovara-org_a", DurationSeconds: 900 });
    expect(credentials).toEqual({ accessKeyId: "ASIAX", secretAccessKey: "secretX", sessionToken: "tokenX", expiration });
    expect((sent[0] as { input: unknown }).input).toEqual({ RoleArn: CUSTOMER_ROLE, RoleSessionName: "rovara-x", ExternalId: "rovara-org_a", DurationSeconds: 900 });
    const empty = awsCloudWatchAccess({ ownAccountId: undefined, sts: { send: async () => ({}) } });
    await expect(empty.assumeRole({ RoleArn: CUSTOMER_ROLE, RoleSessionName: "rovara-x", ExternalId: "e" })).rejects.toMatchObject({ name: "CredentialUnavailable" });
    const clients = access.clientsFor({ accessKeyId: "A", secretAccessKey: "S", sessionToken: "T", expiration }, "us-east-1");
    expect(Object.keys(clients).sort()).toEqual(["logs", "monitoring", "sts"]);
  });
});

describe("saving a CloudWatch connection", () => {
  const save = (connection: Record<string, unknown>) => connected().then((s) => failureOf(s.store.put({ orgId: ORG_A, connection: { ...CONNECTION, connectionId: "con_cccccccccccccccccccc", ...connection }, by: ALICE })).then((failure) => ({ failure, s })));

  it("refuses a role in Rovara's own account with the exact text and writes nothing, in any partition", async () => {
    for (const roleArn of [`arn:aws:iam::${OWN_ACCOUNT}:role/rovara-read`, `arn:aws-us-gov:iam::${OWN_ACCOUNT}:role/path/to/role`]) {
      const { failure, s } = await save({ roleArn });
      expect(failure, roleArn).toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: roleArn: use a role in your own AWS account" });
      expect(await s.store.get(ORG_A, "con_cccccccccccccccccccc")).toBeUndefined();
    }
    const fine = await connected();
    await expect(fine.store.put({ orgId: ORG_A, connection: { ...CONNECTION, connectionId: "con_cccccccccccccccccccc", roleArn: `arn:aws:iam::${CUSTOMER_ACCOUNT}:role/rovara-read` }, by: ALICE })).resolves.toMatchObject({ type: "cloudwatch" });
  });

  it("holds regions to the AWS region list", async () => {
    expect(AWS_REGIONS).toEqual(expect.arrayContaining(["us-east-1", "us-east-2", "us-west-1", "us-west-2", "eu-west-1", "eu-central-2", "ap-southeast-7", "ap-southeast-6", "ap-east-2", "il-central-1", "mx-central-1", "me-central-1", "sa-east-1", "ca-west-1", "us-gov-west-1", "us-gov-east-1", "cn-north-1", "cn-northwest-1"]));
    expect(new Set(AWS_REGIONS).size).toBe(AWS_REGIONS.length);
    for (const regions of [["us-east-9"], ["xx-nowhere-1"], ["us-east-1", "mars-north-1"]]) {
      const { failure } = await save({ regions });
      expect(failure, JSON.stringify(regions)).toMatchObject({ code: "CONFIG_INVALID" });
    }
    const ok = await connected();
    await expect(ok.store.put({ orgId: ORG_A, connection: { ...CONNECTION, connectionId: "con_cccccccccccccccccccc", regions: ["il-central-1", "ap-southeast-7"] }, by: ALICE })).resolves.toMatchObject({ regions: ["il-central-1", "ap-southeast-7"] });
  });

  it("holds a scope's region to the same list", () => {
    const parsed = (region: string) => ProjectDefinitionSchema.safeParse({
      name: "payments", revision: 1,
      repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
      setup: [], readiness: [], orchestratorInstructions: "x", integrations: { connectors: [connectorConfig({ scopes: [{ alias: "prod", region }] })] },
    }).success;
    expect(parsed("us-east-1")).toBe(true);
    expect(parsed("us-east-9")).toBe(false);
  });

  it("stores the server's external id and refuses a body that names one, as an unknown field that is not echoed", async () => {
    const s = await connected();
    expect(await s.store.get(ORG_A, CON)).toMatchObject({ externalId: `rovara-${ORG_A}` });
    const failure = await failureOf(s.store.put({ orgId: ORG_A, connection: { ...CONNECTION, externalId: "rovara-org_cccccccccccccccccccc" }, by: ALICE }));
    expect(failure).toMatchObject({ code: "CONFIG_INVALID" });
    expect(failure?.message).not.toContain("externalId");
    expect(failure?.message).not.toContain("org_cccc");
  });
});

describe("the org's connection registry", () => {
  it("serves a connection that takes no secret, and one that takes a secret only once it has one; another org's is never served", async () => {
    const s = await connected();
    const VERCEL = { connectionId: "con_dddddddddddddddddddd", type: "vercel", label: "Vercel", access: "read" } as const;
    await s.store.put({ orgId: ORG_A, connection: VERCEL, by: ALICE });
    // A connection that takes a secret and has none is not served; the settings of a connector whose key was never saved are not a credential's.
    expect(await s.registry.connection!(VERCEL.connectionId)).toBeUndefined();
    expect(await s.registry.connection!(CON)).toMatchObject({ connectionId: CON, type: "cloudwatch", roleArn: CUSTOMER_ROLE });
    await s.store.put({ orgId: ORG_A, connection: VERCEL, secret: { token: "vercel-token-0123456789" }, by: ALICE });
    expect(await s.registry.connection!(VERCEL.connectionId)).toMatchObject({ connectionId: VERCEL.connectionId, type: "vercel" });
    const other = orgCredentialRegistry(s.deps, ORG_B);
    expect(await other.connection!(CON)).toBeUndefined();
    expect(await other.connection!(VERCEL.connectionId)).toBeUndefined();
  });
});

describe("the setup a customer pastes", () => {
  const admin = { developerId: ALICE, orgId: ORG_A, orgRole: "admin" } as const;
  const request = (method: string, path: string) => ({ method, path, headers: {}, requestId: "req-1" });

  async function route(method: string, path: string, options: { brokerRoleArn?: string | undefined; caller?: typeof admin | { developerId: string; orgId: OrgId; orgRole: "admin" }; tamper?: string } = {}) {
    const s = await connected();
    await s.store.put({ orgId: ORG_A, connection: { connectionId: "con_dddddddddddddddddddd", type: "vercel", label: "Vercel", access: "read" }, secret: { token: "vercel-token-0123456789" }, by: ALICE });
    if (options.tamper !== undefined) for (const item of s.db.items.values()) if (item["entityType"] === "ORG_CONNECTION") item["externalId"] = options.tamper;
    return routeConnectionRequest({ store: s.store, documentClient: s.db, tableName: "T", now: () => START_MS, ...("brokerRoleArn" in options ? (options.brokerRoleArn === undefined ? {} : { brokerRoleArn: options.brokerRoleArn }) : { brokerRoleArn: BROKER_ROLE }) },
      options.caller ?? admin, request(method, path), new URL(`https://broker.example${path}`)) as Promise<Record<string, unknown>>;
  }

  it("builds the trust policy: the broker role as principal, sts:AssumeRole, and a StringEquals on the caller org's external id", () => {
    expect(cloudwatchTrustPolicy({ brokerRoleArn: BROKER_ROLE, externalId: `rovara-${ORG_A}` })).toEqual({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Principal: { AWS: BROKER_ROLE }, Action: "sts:AssumeRole", Condition: { StringEquals: { "sts:ExternalId": `rovara-${ORG_A}` } } }],
    });
  });

  it("adds setup { externalId, trustPolicy } to a CloudWatch connection's own page, built from the caller's org even if the record says otherwise", async () => {
    const answer = await route("GET", `/v1/app/connections/${CON}`, { tamper: "rovara-org_cccccccccccccccccccc" });
    const connection = answer["connection"] as Record<string, unknown>;
    expect(connection["setup"]).toEqual({
      externalId: `rovara-${ORG_A}`,
      trustPolicy: cloudwatchTrustPolicy({ brokerRoleArn: BROKER_ROLE, externalId: `rovara-${ORG_A}` }),
    });
    expect(JSON.stringify(connection["setup"])).not.toContain("org_cccc");
  });

  it("adds nothing to other types, to the list, or when the deployment does not know the broker's role", async () => {
    const vercel = (await route("GET", "/v1/app/connections/con_dddddddddddddddddddd"))["connection"] as Record<string, unknown>;
    expect(vercel).not.toHaveProperty("setup");
    const list = (await route("GET", "/v1/app/connections"))["connections"] as Array<Record<string, unknown>>;
    expect(list.length).toBe(2);
    for (const entry of list) expect(entry).not.toHaveProperty("setup");
    const unknown = (await route("GET", `/v1/app/connections/${CON}`, { brokerRoleArn: undefined }))["connection"] as Record<string, unknown>;
    expect(unknown).not.toHaveProperty("setup");
  });

  it("answers org B's read of org A's CloudWatch connection as a missing connection", async () => {
    const failure = await failureOf(route("GET", `/v1/app/connections/${CON}`, { caller: { developerId: "b".repeat(64), orgId: ORG_B, orgRole: "admin" } }));
    expect(failure).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("the connector context", () => {
  it("carries the caller's org and the deployment's AWS access, and no registry beyond the org's own", async () => {
    await loadSlackBroker();
    const broker = await import("../../packages/broker/src/aws/broker.js") as unknown as {
      connectorTypeContext: (dependencies: Record<string, unknown>, orgId: OrgId | undefined, scope: () => Promise<unknown>) => { orgId?: OrgId; cloudwatchAws?: unknown };
    };
    const { aws } = fakeCloudWatchAws();
    const noToken = () => Promise.reject(new Error("no token"));
    const context = broker.connectorTypeContext({ cloudwatchConnector: aws }, ORG_A, noToken);
    expect(context.orgId).toBe(ORG_A);
    expect(context.cloudwatchAws).toBe(aws);
    expect(broker.connectorTypeContext({}, undefined, noToken).orgId).toBeUndefined();
    expect(broker.connectorTypeContext({}, ORG_A, noToken).cloudwatchAws).toBeUndefined();
    expect(CUSTOMER_ACCOUNT).not.toBe(OWN_ACCOUNT);
  });
});

describe("the deployed broker's connection check", () => {
  const person = (digit: string, name: string): Developer => ({ developerId: digit.repeat(64), name, provider: "oidc", sessionId: `s-${name.toLowerCase()}` });
  const DANA = person("1", "Dana");

  it("runs the CloudWatch check when the broker is given AWS access: a check from the route assumes the role with the org's external id, and says when the role is refused", async () => {
    const fake = new FakeOrgSecrets({ env: ENV, now: Date.now });
    const secrets = new OrgSecrets({ env: ENV, roleArn: FAKE_CONNECTOR_ROLE_ARN, sts: fake.sts, secretsFor: fake.secretsFor, now: Date.now });
    const aws = fakeCloudWatchAws({ roles: ROLES(TEST_ORG), alarms: [{ name: "pay-a", state: "OK" }] });
    const holder: { db?: { send(command: unknown): Promise<unknown> } } = {};
    const h = await createDeveloperTaskBroker({
      register: false, audit: capturingAuditDeps(),
      brokerExtra: {
        agents: {},
        orgConnections: { documentClient: { send: (command: unknown) => holder.db!.send(command) }, tableName: "state", env: ENV, secrets, now: Date.now, ownAccountId: OWN_ACCOUNT },
        cloudwatchConnector: aws.aws,
      },
    });
    holder.db = h.db;
    h.db.set({ pk: `SESSION#${DANA.sessionId}`, sk: "META", sessionId: DANA.sessionId, developerId: DANA.developerId, amr: DANA.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${DANA.developerId}`, sk: "META", developerId: DANA.developerId, provider: DANA.provider, displayName: DANA.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    await h.orgOf(DANA);
    seedMembership(h.db, DANA.developerId, { orgId: TEST_ORG, role: "admin" });
    const call = async (method: string, path: string, body?: Record<string, unknown>) => {
      const reply = await h.dev(DANA, method, path, body === undefined ? undefined : { requestId: randomUUID(), ...body });
      return { status: reply.status, body: reply.body };
    };
    const created = await call("POST", "/v1/app/connections", { connection: { type: "cloudwatch", label: "AWS prod", access: "read", roleArn: CUSTOMER_ROLE, regions: ["us-east-1"] } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = (created.body["connection"] as { connectionId: string }).connectionId;
    const checked = await call("POST", `/v1/app/connections/${id}/check`, {});
    expect(checked.body, JSON.stringify(checked.body)).toMatchObject({ ok: true });
    expect(aws.assumed.map((input) => input.ExternalId)[0]).toBe(cloudwatchExternalId(TEST_ORG));
    expect(aws.assumed).toHaveLength(2);
    expect(aws.names()).toEqual(["GetCallerIdentityCommand", "DescribeAlarmsCommand"]);
  });
});
