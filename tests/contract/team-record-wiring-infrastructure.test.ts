// wire-team-record: the Team record in the real control plane, behind ONE switch (`agentxTeamRecord=enabled`) that is OFF by default.
//  - OFF: the control plane template has no record resource, no schedule, no broker setting, no new IAM statement, and the Slack ingress has no new variable. The off template is compared
//    with a template built with the switch spelled `off`, and the resources are listed by type, so a resource added outside the switch fails here.
//  - ON (Public cloud and Enterprise): the table, the vector bucket, the lake and the schedules exist, named from the environment; the broker is given the switch and the two install
//    parameters in its packed settings, and the role it assumes for vectors in its packed names; the Slack ingress is told to hand events to the broker.
import { readFileSync, writeFileSync } from "node:fs";
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { BROKER_NAMES, BROKER_SETTINGS, TEAM_RECORD_OPS_MAX_RECEIVES, teamRecordTableName } from "@agentx/contracts";
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
const synthesised = new Map<string, Template>();
const controlPlane = (context: Record<string, unknown>): Template => {
  const key = JSON.stringify(context);
  const hit = synthesised.get(key);
  if (hit !== undefined) return hit;
  const stack = buildAgentXApp(context).node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane");
  const template = Template.fromStack(stack!);
  synthesised.set(key, template);
  return template;
};
const resourcesOf = (template: Template): Record<string, Resource> => template.toJSON().Resources as Record<string, Resource>;
const typesOf = (template: Template): string[] => Object.values(resourcesOf(template)).map((resource) => resource.Type).sort();
const functionVariables = (template: Template, pattern: RegExp): Record<string, unknown> => {
  const found = Object.entries(resourcesOf(template)).find(([id, resource]) => resource.Type === "AWS::Lambda::Function" && pattern.test(id));
  return (found![1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
};
const RECORD_TYPES = ["AWS::S3Vectors::VectorBucket", "AWS::S3Tables::TableBucket", "AWS::Athena::WorkGroup"];
/** Every statement of the Team record's own rights (a Sid starting `TeamRecord`) in the template's policies. */
const recordStatements = (template: Template): Array<{ Sid: string; Action: string | string[]; Resource: unknown }> => Object.values(resourcesOf(template))
  .flatMap((resource) => (resource.Type === "AWS::IAM::Policy" || resource.Type === "AWS::IAM::ManagedPolicy") ? ((resource.Properties.PolicyDocument as { Statement: Array<{ Sid?: string; Action: string | string[]; Resource: unknown }> }).Statement) : [])
  .filter((statement): statement is { Sid: string; Action: string | string[]; Resource: unknown } => typeof statement.Sid === "string" && statement.Sid.startsWith("TeamRecord"));

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
    for (const key of ["teamRecord", "teamRecordActive", "teamRecordEmbeddingModel", "teamRecordLake"] as const) expect(Object.keys(settings), key).not.toContain(key);
    expect(Object.keys(brokerNamesIn(functionVariables(plain, /^Broker[0-9A-F]{8}$/)))).not.toContain("teamRecordVectorsRole");
    expect(functionVariables(plain, /^SlackIngress[0-9A-F]{8}$/)).not.toHaveProperty("TEAM_RECORD_ENABLED");
    expect((plain.toJSON() as { Parameters?: Record<string, unknown> }).Parameters).not.toHaveProperty("TeamRecordEnabled");
    expect(JSON.stringify(plain.toJSON())).not.toMatch(/s3vectors|s3tables|team-record/i);
  }, 180_000);

  // TRW-2 S6: "the switch adds nothing when off" was only proved against the same branch's own template. This pins, in a committed file, the exact resources the switch adds. The off template must hold
  // none of them, and the file must equal what the switch adds now: a resource added to the record fails here until the file is changed on purpose (UPDATE_FIXTURES=1), and a record resource that
  // leaks out of the switch fails whatever else changed in the stack.
  it("the resources the switch adds are exactly the committed list, and none of them is in the off template", () => {
    const off = resourcesOf(plain);
    const on = resourcesOf(controlPlane({ ...PUBLIC, agentxTeamRecord: "enabled" }));
    const pairs: Array<[string, string]> = Object.entries(on).filter(([id]) => !(id in off)).map(([id, resource]): [string, string] => [id, resource.Type]).sort(([a], [b]) => a.localeCompare(b));
    const added: Record<string, string> = Object.fromEntries(pairs);
    const file = new URL("../fixtures/team-record-switch-resources.json", import.meta.url);
    if (process.env.UPDATE_FIXTURES === "1") writeFileSync(file, `${JSON.stringify(added, null, 2)}\n`);
    const committed = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    expect(added).toStrictEqual(committed);
    expect(Object.keys(committed).length).toBeGreaterThan(10);
    for (const [id, type] of Object.entries(committed)) expect(off[id]?.Type ?? "absent", id).not.toBe(type);
    for (const id of Object.keys(committed)) expect(id in off, id).toBe(false);
  }, 360_000);

  // Lessons in production: the ModelAccessFunction makes the one model call of a learning reflection (`learningCompletion`), which takes longer than its other operations. Only with the switch on.
  it("the model access function waits longer (180 s) only with the switch on; off, its timeout is what it was (30 s)", () => {
    const timeoutOf = (template: Template): number => {
      const found = Object.entries(resourcesOf(template)).filter(([id, resource]) => resource.Type === "AWS::Lambda::Function" && id.startsWith("ModelAccessFunction"));
      expect(found).toHaveLength(1);
      return found[0]![1].Properties.Timeout as number;
    };
    expect(timeoutOf(plain)).toBe(30);
    expect(timeoutOf(controlPlane({ ...PUBLIC, agentxTeamRecord: "enabled" }))).toBe(180);
  }, 360_000);

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
    // UX-4b review fix 1: the record stays on for the broker (erasure, removals, Slack deletes and expiry keep running); TeamRecordEnabled (default 1) is the pause, as TEAM_RECORD_ACTIVE.
    expect(settings.teamRecord).toBe("1");
    expect(settings.teamRecordActive).toEqual({ Ref: "TeamRecordEnabled" });
    expect((on.toJSON() as { Parameters?: Record<string, unknown> }).Parameters?.TeamRecordEnabled).toMatchObject({ Type: "String", Default: "1", AllowedValues: ["0", "1"] });
    // ENV-ROOM: the default embedding model is not passed (the broker reads an unset model as the default), and the record's dead-letter queue has a fixed name the broker derives.
    expect(settings).not.toHaveProperty("teamRecordEmbeddingModel");
    expect(settings.teamRecordLake).toBe("1");
    expect(brokerNamesIn(variables).teamRecordVectorsRole).toStrictEqual({ Ref: expect.stringMatching(/^TeamRecordVectorsDataRole/) as string });
    expect(Object.keys(BROKER_NAMES)).not.toContain("teamRecordDeadLetters");
    for (const spec of [BROKER_SETTINGS.teamRecord, BROKER_SETTINGS.teamRecordEmbeddingModel, BROKER_SETTINGS.teamRecordLake, BROKER_NAMES.teamRecordVectorsRole]) expect(variables).not.toHaveProperty(spec.variable);
  }, 180_000);

  it("passes the embedding model in the packed settings when the install chooses another one", () => {
    const other = controlPlane({ ...PUBLIC, agentxTeamRecord: "enabled", agentxTeamRecordEmbeddingModelId: "cohere.embed-english-v3" });
    expect(brokerSettingsIn(functionVariables(other, /^Broker[0-9A-F]{8}$/)).teamRecordEmbeddingModel).toBe("cohere.embed-english-v3");
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

  it("WL-6: the dispatcher builds a stage's lessons at delivery, so it is told the record's table and may only READ the lesson rows (no write, no scan)", () => {
    expect(functionVariables(on, /^Dispatcher[0-9A-F]{8}$/)).toMatchObject({ TEAM_RECORD_TABLE_NAME: teamRecordTableName("staging") });
    expect(functionVariables(controlPlane(PUBLIC), /^Dispatcher[0-9A-F]{8}$/)).not.toHaveProperty("TEAM_RECORD_TABLE_NAME");
    // S1: the dispatcher honours the install switch for lessons reaching an agent (the same stack parameter the broker's packed setting takes), so turning it off stops lessons for queued stages too.
    expect(functionVariables(on, /^Dispatcher[0-9A-F]{8}$/)).toMatchObject({ [BROKER_SETTINGS.learnedLessons.variable]: { Ref: "LearnedLessonsEnabled" } });
    type Statement = { Sid?: string; Action: string | string[]; Resource: unknown };
    const statements = Object.entries(resources).filter(([id, resource]) => resource.Type === "AWS::IAM::Policy" && /^Dispatcher/.test(id))
      .flatMap(([, resource]) => (resource.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
    const reads = statements.filter((statement) => statement.Sid === "TeamRecordLessonReads");
    expect(reads).toHaveLength(1);
    expect([reads[0]!.Action].flat().sort()).toStrictEqual(["dynamodb:BatchGetItem", "dynamodb:GetItem", "dynamodb:Query"]);
    expect(JSON.stringify(reads[0]!.Resource)).toMatch(/TeamRecordTable/);
    // Nothing else of the record is the dispatcher's: no write action on the record table, and no vector, lake or queue right.
    const recordRelated = statements.filter((statement) => /TeamRecord/.test(JSON.stringify(statement.Resource)));
    expect(recordRelated.map((statement) => statement.Sid)).toStrictEqual(["TeamRecordLessonReads"]);
  }, 180_000);

  it("creates the durable queue with a dead-letter queue (five tries), a visibility timeout above the broker's, and drains it with partial-batch answers", () => {
    const queues = Object.entries(resources).filter(([, resource]) => resource.Type === "AWS::SQS::Queue" && /^TeamRecordOps/.test(String(Object.keys(resources).find((id) => resources[id] === resource))));
    const ops = queues.find(([id]) => /^TeamRecordOps[0-9A-F]{8}$/.test(id))![1].Properties;
    expect(ops).toMatchObject({ QueueName: "agentx-staging-team-record-ops", MessageRetentionPeriod: 345600, VisibilityTimeout: 180, RedrivePolicy: { maxReceiveCount: TEAM_RECORD_OPS_MAX_RECEIVES } });
    // The consumer drops a text-carrying put at THIS delivery, so the dead-letter queue never holds its text (TRW-3 R4): the two numbers are one constant.
    expect(TEAM_RECORD_OPS_MAX_RECEIVES).toBe(5);
    const mapping = Object.values(resources).find((resource) => resource.Type === "AWS::Lambda::EventSourceMapping" && JSON.stringify(resource.Properties).includes("TeamRecordOps"));
    expect(mapping?.Properties).toMatchObject({ FunctionResponseTypes: ["ReportBatchItemFailures"], BatchSize: 10 });
  }, 180_000);

  // TRW-5: the broker reads the dead-letter queue only to delete text out of it, may send a delete to itself as an Event, and every asynchronous invoke it cannot run lands in the failure queue that alarms.
  it("the broker may receive from and delete in the dead-letter queue, invoke itself, and its asynchronous failures go to a queue", () => {
    const statements = Object.values(resources).flatMap((resource) => (resource.Type === "AWS::IAM::Policy" || resource.Type === "AWS::IAM::ManagedPolicy" ? ((resource.Properties.PolicyDocument as { Statement: Array<{ Action: string | string[]; Resource: unknown }> }).Statement) : []));
    const dlq = statements.filter((statement) => JSON.stringify(statement.Resource).includes("TeamRecordOpsDeadLetters") && [statement.Action].flat().includes("sqs:ReceiveMessage"));
    expect(dlq.length, JSON.stringify(statements.filter((statement) => JSON.stringify(statement).includes("DeadLetters")))).toBeGreaterThan(0);
    expect([dlq[0]!.Action].flat()).toContain("sqs:DeleteMessage");
    const selfInvoke = Object.entries(resources).filter(([id, resource]) => resource.Type === "AWS::IAM::Policy" && /^TeamRecordBrokerSelfInvoke/.test(id));
    expect(selfInvoke).toHaveLength(1);
    expect(JSON.stringify(selfInvoke[0]![1].Properties)).toMatch(/lambda:InvokeFunction/);
    const configs = Object.values(resources).filter((resource) => resource.Type === "AWS::Lambda::EventInvokeConfig" && JSON.stringify(resource.Properties.FunctionName).includes("Broker"));
    expect(configs.some((config) => JSON.stringify((config.Properties.DestinationConfig as { OnFailure?: unknown } | undefined)?.OnFailure).includes("SlackHandOffFailureQueue"))).toBe(true);
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

  it("DV-1 (c): with the lake on, the ONLY record right on every resource is lakeformation:GetDataAccess; Athena stays on the one workgroup, S3 Tables on the one table bucket, results under results/", () => {
    const statements = recordStatements(on);
    const wide = statements.filter((statement) => JSON.stringify(statement.Resource) === "\"*\"" || [statement.Resource].flat().includes("*")).map((statement) => [statement.Sid, [statement.Action].flat()]);
    expect(wide).toStrictEqual([["TeamRecordLakeFormationData", ["lakeformation:GetDataAccess"]]]);
    const byId = Object.fromEntries(statements.map((statement) => [statement.Sid, JSON.stringify(statement.Resource)]));
    expect(byId.TeamRecordAthena).toContain("workgroup/agentx-staging-record");
    expect(byId.TeamRecordAthena).not.toContain("workgroup/*");
    expect(byId.TeamRecordLakeTables).toContain("TableBucket");
    expect(byId.TeamRecordAthenaResults).toContain("/results/*");
    // No right to create, delete or change the lake's shape or the workgroup.
    const actions = statements.flatMap((statement) => [statement.Action].flat());
    for (const action of ["athena:CreateWorkGroup", "athena:UpdateWorkGroup", "athena:DeleteWorkGroup", "s3tables:DeleteTable", "s3tables:DeleteTableBucket", "s3tables:DeleteNamespace", "s3tables:CreateTable", "glue:CreateTable", "glue:DeleteTable", "glue:CreateDatabase", "lakeformation:GrantPermissions"]) expect(actions, action).not.toContain(action);
  }, 180_000);

  it("DV-1 (c): the first staging switch-on shape, the lake OFF (agentxTeamRecordLake=false): no lake resource and no Athena, S3 Tables, Glue or Lake Formation right anywhere in the template", () => {
    const off = controlPlane({ ...PUBLIC, agentxTeamRecord: "enabled", agentxTeamRecordLake: "false" });
    const types = typesOf(off);
    expect(types).toContain("AWS::S3Vectors::VectorBucket");
    expect(types).toContain("AWS::DynamoDB::Table");
    for (const type of ["AWS::S3Tables::TableBucket", "AWS::S3Tables::Namespace", "AWS::S3Tables::Table", "AWS::Athena::WorkGroup"]) expect(types, type).not.toContain(type);
    const text = JSON.stringify(off.toJSON());
    for (const prefix of ["athena:", "s3tables:", "glue:", "lakeformation:"]) expect(text.includes(`"${prefix}`), prefix).toBe(false);
    expect(brokerSettingsIn(functionVariables(off, /^Broker[0-9A-F]{8}$/)).teamRecordLake).toBe("0");
    // The vector data role still names its index by the session tag, lake or no lake.
    expect(text).toContain("aws:PrincipalTag/rovara-index");
  }, 240_000);

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
    // WL-6: the dispatcher's lesson reads include the customer's key (decrypt only).
    const kms = Object.entries(resourcesOf(on)).filter(([id, resource]) => resource.Type === "AWS::IAM::Policy" && /^Dispatcher/.test(id))
      .flatMap(([, resource]) => (resource.Properties.PolicyDocument as { Statement: Array<{ Sid?: string; Action: string | string[]; Resource: unknown }> }).Statement).filter((statement) => statement.Sid === "TeamRecordLessonReadsKms");
    expect(kms).toHaveLength(1);
    expect([kms[0]!.Action].flat().sort()).toStrictEqual(["kms:DescribeKey", "kms:Decrypt"].sort());
    expect(kms[0]!.Resource).toBe(KMS);
    // N1: only through DynamoDB, so the dispatcher cannot decrypt anything else sealed under the customer's key.
    expect((kms[0] as unknown as { Condition: unknown }).Condition).toMatchObject({ StringEquals: { "kms:ViaService": expect.anything() as unknown } });
    expect(JSON.stringify((kms[0] as unknown as { Condition: unknown }).Condition)).toMatch(/dynamodb\..*\.amazonaws\.com/);
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
