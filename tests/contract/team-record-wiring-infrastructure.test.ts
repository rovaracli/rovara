// wire-team-record: the Team record in the real control plane, behind ONE switch (`agentxTeamRecord=enabled`) that is OFF by default.
//  - OFF: the control plane template has no record resource, no schedule, no broker setting, no new IAM statement, and the Slack ingress has no new variable. The off template is compared
//    with a template built with the switch spelled `off`, and the resources are listed by type, so a resource added outside the switch fails here.
//  - ON (Public cloud and Enterprise): the table, the vector bucket, the lake and the schedules exist, named from the environment; the broker is given the switch and the two install
//    parameters in its packed settings, and the role it assumes for vectors in its packed names; the Slack ingress is told to hand events to the broker.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { BROKER_NAMES, BROKER_SETTINGS, teamRecordTableName } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { parseTeamRecordSwitch, TEAM_RECORD_JOB_SOURCE } from "../../infra/lib/team-record-wiring.js";
import { brokerNamesIn, brokerSettingsIn } from "../support/broker-names-template.js";
import { DEPLOY_PARAMETER_VALUES, lambdaEnvironments, type Template as ResolvableTemplate } from "../support/lambda-environment-size.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const KMS = "arn:aws:kms:us-west-2:111122223333:key/11111111-2222-3333-4444-555555555555";
const ENTERPRISE = { agentxEnv: "ent", rovaraEdition: "enterprise", rovaraEnterpriseEgressCidrs: "10.99.0.0/16", agentxAuditTsa: "off" } as const;
const PUBLIC = { agentxEnv: "staging", agentxCloud: true } as const;

type Resource = { Type: string; Properties: Record<string, unknown> };
const controlPlane = (context: Record<string, unknown>): Template => {
  const stack = buildAgentXApp(context).node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane");
  return Template.fromStack(stack!);
};
const resourcesOf = (template: Template): Record<string, Resource> => template.toJSON().Resources as Record<string, Resource>;
const typesOf = (template: Template): string[] => Object.values(resourcesOf(template)).map((resource) => resource.Type).sort();
const functionVariables = (template: Template, pattern: RegExp): Record<string, unknown> => {
  const found = Object.entries(resourcesOf(template)).find(([id, resource]) => resource.Type === "AWS::Lambda::Function" && pattern.test(id));
  return (found![1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
};
const RECORD_TYPES = ["AWS::S3Vectors::VectorBucket", "AWS::S3Tables::TableBucket", "AWS::Athena::WorkGroup"];

describe("the switch is off by default and changes nothing", () => {
  const plain = controlPlane(PUBLIC);

  it.each([[{}], [{ agentxTeamRecord: "off" }], [{ agentxTeamRecord: "" }], [{ agentxTeamRecord: false }]])("synthesises the same template with %j as without the key", (extra) => {
    expect(controlPlane({ ...PUBLIC, ...extra }).toJSON()).toStrictEqual(plain.toJSON());
  }, 180_000);

  it("creates no record resource, no schedule of the record, no record setting and no new variable on the Slack ingress", () => {
    const types = typesOf(plain);
    for (const type of RECORD_TYPES) expect(types, type).not.toContain(type);
    const resources = resourcesOf(plain);
    expect(Object.keys(resources).filter((id) => /TeamRecord/.test(id))).toStrictEqual([]);
    expect(Object.values(resources).filter((resource) => resource.Type === "AWS::DynamoDB::Table" && String(JSON.stringify(resource.Properties)).includes("team-record"))).toStrictEqual([]);
    const settings = brokerSettingsIn(functionVariables(plain, /^Broker[0-9A-F]{8}$/));
    for (const key of ["teamRecord", "teamRecordEmbeddingModel", "teamRecordLake"] as const) expect(Object.keys(settings), key).not.toContain(key);
    expect(Object.keys(brokerNamesIn(functionVariables(plain, /^Broker[0-9A-F]{8}$/)))).not.toContain("teamRecordVectorsRole");
    expect(functionVariables(plain, /^SlackIngress[0-9A-F]{8}$/)).not.toHaveProperty("TEAM_RECORD_ENABLED");
    expect(JSON.stringify(plain.toJSON())).not.toMatch(/s3vectors|s3tables|team-record/i);
  }, 180_000);

  it("is off in the legacy install and in a self-hosted install with no edition, and a wrong value stops the synth", () => {
    expect(JSON.stringify(controlPlane({}).toJSON())).not.toMatch(/s3vectors|s3tables|team-record/i);
    expect(() => controlPlane({ ...PUBLIC, agentxTeamRecord: "yes" })).toThrow(/must be "enabled" or "off"/);
    expect(() => controlPlane({ agentxTeamRecord: "enabled" })).toThrow(/named environment/);
    expect(() => controlPlane({ agentxEnv: "staging", agentxTeamRecord: "enabled" })).toThrow(/needs an edition/);
  }, 180_000);
});

describe("parseTeamRecordSwitch", () => {
  const get = (context: Record<string, unknown>) => (key: string) => context[key];
  it("reads off for nothing, off, false and an empty value", () => {
    for (const value of [undefined, "off", "", false, "false"]) expect(parseTeamRecordSwitch({ get: get({ agentxTeamRecord: value }), env: "staging", edition: undefined, cloud: true })).toBeUndefined();
  });
  it("on needs a named environment and an edition; the hosted cloud is Public", () => {
    expect(parseTeamRecordSwitch({ get: get({ agentxTeamRecord: "enabled" }), env: "staging", edition: undefined, cloud: true })).toMatchObject({ edition: "public" });
    expect(() => parseTeamRecordSwitch({ get: get({ agentxTeamRecord: "enabled" }), env: "staging", edition: "public", cloud: false })).toThrow(/hosted cloud/);
    expect(parseTeamRecordSwitch({ get: get({ agentxTeamRecord: "enabled", agentxTeamRecordKmsKeyArn: KMS, agentxTeamRecordEnterpriseWorkspaceId: "org_aaaaaaaaaaaaaaaaaaaa" }), env: "ent", edition: "enterprise", cloud: false }))
      .toMatchObject({ edition: "enterprise", kmsKeyArn: KMS, enterpriseWorkspaceId: "org_aaaaaaaaaaaaaaaaaaaa" });
  });
});

describe("the switch on: Public cloud", () => {
  const on = controlPlane({ ...PUBLIC, agentxTeamRecord: "enabled" });
  const resources = resourcesOf(on);

  it("creates the table (named from the environment, retained, point-in-time recovery), the vector bucket, the lake and the workgroup", () => {
    const table = Object.values(resources).find((resource) => resource.Type === "AWS::DynamoDB::Table" && resource.Properties.TableName === teamRecordTableName("staging"));
    expect(table?.Properties).toMatchObject({ BillingMode: "PAY_PER_REQUEST", DeletionProtectionEnabled: true, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } });
    const types = typesOf(on);
    for (const type of RECORD_TYPES) expect(types, type).toContain(type);
  }, 180_000);

  it("gives the broker the switch and the install parameters in its packed settings, and the vector role in its packed names, and no variable of its own", () => {
    const variables = functionVariables(on, /^Broker[0-9A-F]{8}$/);
    const settings = brokerSettingsIn(variables);
    expect(settings.teamRecord).toBe("1");
    expect(settings.teamRecordEmbeddingModel).toBe("amazon.titan-embed-text-v2:0");
    expect(settings.teamRecordLake).toBe("1");
    expect(brokerNamesIn(variables).teamRecordVectorsRole).toStrictEqual({ Ref: expect.stringMatching(/^TeamRecordVectorsDataRole/) as string });
    for (const spec of [BROKER_SETTINGS.teamRecord, BROKER_SETTINGS.teamRecordEmbeddingModel, BROKER_SETTINGS.teamRecordLake, BROKER_NAMES.teamRecordVectorsRole]) expect(variables).not.toHaveProperty(spec.variable);
  }, 180_000);

  it("schedules the hourly and the nightly job through the recovery role, with no retries, and nothing else", () => {
    const schedules = Object.entries(resources).filter(([id, resource]) => resource.Type === "AWS::Scheduler::Schedule" && id.startsWith("TeamRecord"));
    expect(schedules.map(([id]) => id.replace(/[0-9A-F]{8}$/, "")).sort()).toStrictEqual(["TeamRecordHourlySchedule", "TeamRecordNightlySchedule"]);
    const inputs = schedules.map(([, resource]) => JSON.parse((resource.Properties.Target as { Input: string }).Input) as unknown).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    expect(inputs).toStrictEqual([{ source: TEAM_RECORD_JOB_SOURCE, job: "hourly" }, { source: TEAM_RECORD_JOB_SOURCE, job: "nightly" }]);
    for (const [, resource] of schedules) expect((resource.Properties.Target as { RetryPolicy: unknown }).RetryPolicy).toStrictEqual({ MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 600 });
  }, 180_000);

  it("tells the Slack ingress to hand events to the broker and where the durable queue is, and gives it exactly one new right: to send to that queue (no table, no storage)", () => {
    expect(functionVariables(on, /^SlackIngress[0-9A-F]{8}$/)).toMatchObject({ TEAM_RECORD_ENABLED: "1", TEAM_RECORD_OPS_QUEUE_URL: expect.anything() as unknown });
    const off = controlPlane(PUBLIC);
    type Statement = { Action: string | string[]; Resource: unknown };
    const statementsOf = (template: Template): string[] => Object.entries(resourcesOf(template)).filter(([id, resource]) => resource.Type === "AWS::IAM::Policy" && /^SlackIngress/.test(id))
      .flatMap(([, resource]) => (resource.Properties.PolicyDocument as { Statement: Statement[] }).Statement.map((statement) => JSON.stringify(statement)));
    const before = new Set(statementsOf(off));
    const added = statementsOf(on).filter((statement) => !before.has(statement));
    expect(added).toHaveLength(1);
    const statement = JSON.parse(added[0]!) as Statement;
    expect([statement.Action].flat().sort()).toStrictEqual(["sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:SendMessage"]);
    expect(JSON.stringify(statement.Resource)).toMatch(/TeamRecordOps[0-9A-F]{8}/);
    expect(statementsOf(off).every((existing) => statementsOf(on).includes(existing))).toBe(true);
  }, 180_000);

  it("creates the durable queue with a dead-letter queue (five tries), a visibility timeout above the broker's, and drains it with partial-batch answers", () => {
    const queues = Object.entries(resources).filter(([, resource]) => resource.Type === "AWS::SQS::Queue" && /^TeamRecordOps/.test(String(Object.keys(resources).find((id) => resources[id] === resource))));
    const ops = queues.find(([id]) => /^TeamRecordOps[0-9A-F]{8}$/.test(id))![1].Properties;
    expect(ops).toMatchObject({ QueueName: "agentx-staging-team-record-ops", MessageRetentionPeriod: 345600, VisibilityTimeout: 180, RedrivePolicy: { maxReceiveCount: 5 } });
    const mapping = Object.values(resources).find((resource) => resource.Type === "AWS::Lambda::EventSourceMapping" && JSON.stringify(resource.Properties).includes("TeamRecordOps"));
    expect(mapping?.Properties).toMatchObject({ FunctionResponseTypes: ["ReportBatchItemFailures"], BatchSize: 10 });
  }, 180_000);

  it("S2: the vector data role names its indexes by the session TAG, never `index/*`, and only lets the broker tag a session with an index name", () => {
    const role = Object.entries(resources).find(([id, resource]) => resource.Type === "AWS::IAM::Role" && /^TeamRecordVectorsDataRole/.test(id))![1];
    const trust = JSON.stringify(role.Properties.AssumeRolePolicyDocument);
    expect(trust).toContain("sts:TagSession");
    expect(trust).toContain("aws:RequestTag/rovara-index");
    expect(trust).toContain("ws-*");
    const policies = Object.entries(resources).filter(([id, resource]) => resource.Type === "AWS::IAM::Policy" && /^TeamRecordVectorsDataRole/.test(id));
    expect(policies).toHaveLength(1);
    const text = JSON.stringify(policies[0]![1].Properties.PolicyDocument);
    expect(text).toContain("${aws:PrincipalTag/rovara-index}");
    expect(text).not.toContain("/index/*");
    for (const statement of (policies[0]![1].Properties.PolicyDocument as { Statement: Array<{ Action: string | string[]; Resource: unknown }> }).Statement) {
      if ([statement.Action].flat().some((action) => action.startsWith("s3vectors:"))) expect(JSON.stringify(statement.Resource)).toContain("${aws:PrincipalTag/rovara-index}");
    }
    expect(JSON.stringify(on.toJSON())).toMatch(/"sts:AssumeRole","sts:TagSession"/);
  }, 180_000);

  it("S3: the Glue rights name the record's own database and tables, not every database and table of the account", () => {
    const statements = Object.values(resourcesOf(on)).flatMap((resource) => (resource.Type === "AWS::IAM::Policy" || resource.Type === "AWS::IAM::ManagedPolicy")
      ? ((resource.Properties.PolicyDocument as { Statement: Array<{ Sid?: string; Resource: unknown }> }).Statement) : []);
    const glue = statements.find((statement) => statement.Sid === "TeamRecordGlueCatalog");
    expect(glue).toBeDefined();
    const text = JSON.stringify(glue!.Resource);
    expect(text).toContain("s3tablescatalog/agentx-staging-record-lake/record");
    expect(text).not.toMatch(/:database\/\*"|:table\/\*"|"database\/\*"|"table\/\*"/);
    expect(text).not.toMatch(/"(?:database|table)\/\*/);
  }, 180_000);

  it("gives the broker rights on the table and its indexes only (no scan), and to assume the vector role", () => {
    const text = JSON.stringify(on.toJSON());
    expect(text).toContain("sts:AssumeRole");
    const statements = Object.values(resourcesOf(on)).flatMap((resource) => (resource.Type === "AWS::IAM::Policy" || resource.Type === "AWS::IAM::ManagedPolicy") ? ((resource.Properties.PolicyDocument as { Statement: Array<{ Action: string | string[]; Resource: unknown }> }).Statement) : []);
    const tableStatements = statements.filter((statement) => JSON.stringify(statement.Resource).includes("TeamRecordTable"));
    expect(tableStatements.length).toBeGreaterThan(0);
    for (const statement of tableStatements) expect([statement.Action].flat()).not.toContain("dynamodb:Scan");
  }, 180_000);
});

describe("the switch on: Enterprise", () => {
  it("needs their key and workspace; with them the table uses their key, the index is made in the stack, and the lake follows lakeEnabled", () => {
    expect(() => controlPlane({ ...ENTERPRISE, agentxTeamRecord: "enabled" })).toThrow(/needs kmsKeyArn/);
    const on = controlPlane({ ...ENTERPRISE, agentxTeamRecord: "enabled", agentxTeamRecordKmsKeyArn: KMS, agentxTeamRecordEnterpriseWorkspaceId: "org_aaaaaaaaaaaaaaaaaaaa", agentxTeamRecordLake: "false" });
    const types = typesOf(on);
    expect(types).toContain("AWS::S3Vectors::VectorBucket");
    expect(types).toContain("AWS::S3Vectors::Index");
    for (const type of ["AWS::S3Tables::TableBucket", "AWS::Athena::WorkGroup"]) expect(types, type).not.toContain(type);
    const table = Object.values(resourcesOf(on)).find((resource) => resource.Type === "AWS::DynamoDB::Table" && resource.Properties.TableName === teamRecordTableName("ent"));
    expect(table?.Properties.SSESpecification).toMatchObject({ SSEEnabled: true, SSEType: "KMS", KMSMasterKeyId: KMS });
    expect(brokerSettingsIn(functionVariables(on, /^Broker[0-9A-F]{8}$/)).teamRecordLake).toBe("0");
  }, 240_000);
});

describe("the broker's environment still fits Lambda's 4 KB with the record on", () => {
  // The same ceiling and headroom as tests/contract/lambda-environment-size.test.ts, for an install with the switch ON (that test measures the default, switch-off installs).
  const CEILING = 3800;
  const HEADROOM = 400;
  it.each([["staging"], ["a1234567890123456789"]])("environment %s: the broker keeps its headroom and the Slack ingress stays small", (env) => {
    const stack = buildAgentXApp({ agentxEnv: env, agentxCloud: true, agentxTeamRecord: "enabled" }).node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane")!;
    const found = lambdaEnvironments(Template.fromStack(stack).toJSON() as ResolvableTemplate, { env, stackName: stack.stackName, parameterValues: DEPLOY_PARAMETER_VALUES });
    const broker = found.find((entry) => /^Broker[0-9A-F]{8}$/.test(entry.logicalId))!;
    expect(CEILING - broker.bytes, `the broker's environment is ${broker.bytes} bytes`).toBeGreaterThanOrEqual(HEADROOM);
    for (const entry of found) expect(entry.bytes, entry.logicalId).toBeLessThan(CEILING);
  }, 240_000);
});
