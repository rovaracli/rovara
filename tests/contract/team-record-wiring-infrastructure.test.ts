// wire-team-record: the Team record in the real control plane, behind ONE switch (`agentxTeamRecord=enabled`) that is OFF by default.
//  - OFF: the control plane template has no record resource, no schedule, no broker setting, no new IAM statement, and the Slack ingress has no new variable. The off template is compared
//    with a template built with the switch spelled `off`, and the resources are listed by type, so a resource added outside the switch fails here.
//  - ON (Public cloud and Enterprise): the table, the vector bucket, the lake and the schedules exist, named from the environment; the broker is given the switch and the two install
//    parameters in its packed settings, and the role it assumes for vectors in its packed names; the Slack ingress is told to hand events to the broker.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { BROKER_NAMES, BROKER_SETTINGS, LESSONS_WORKER_RESERVED_CONCURRENCY, TEAM_RECORD_OPS_MAX_RECEIVES, HEALTH_ALARM_CONDITIONAL_SUFFIXES, HEALTH_ALARM_SUFFIXES, teamRecordTableName } from "@agentx/cloud-contracts";
import { LESSONS_BROKER_MODEL_WAIT_SECONDS, LESSONS_REFLECT_MAX_RECEIVES, LESSONS_REFLECT_VISIBILITY_SECONDS, LESSONS_WORKER_TIMEOUT_SECONDS } from "@rovara-code/contracts";
import { LESSONS_WORKER_STATE_WRITE_KEY_PATTERNS } from "../../infra/lib/team-record-wiring.js";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { defaultProductionAvailabilityZoneIds } from "../../infra/lib/production-foundation.js";
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
    for (const key of ["teamRecord", "teamRecordActive", "teamRecordLake"] as const) expect(Object.keys(settings), key).not.toContain(key);
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

  // Lessons in production: the ModelAccessFunction makes the one model call of a learning reflection (`learningCompletion`, with a key the broker minted and reserved), which takes longer than its other operations. Only with the
  // switch on: the timeout is 120 s (its only step is the 100 s call) and the environment switch that lets the handler accept the operation is set (L3). Off, both are what they were.
  it("the model access function waits longer (120 s) and accepts the learning call only with the switch on; off, its timeout is what it was (30 s) and it has no learning switch", () => {
    const functionOf = (template: Template) => {
      const found = Object.entries(resourcesOf(template)).filter(([id, resource]) => resource.Type === "AWS::Lambda::Function" && id.startsWith("ModelAccessFunction"));
      expect(found).toHaveLength(1);
      return found[0]![1].Properties as { Timeout: number; Environment?: { Variables?: Record<string, string> } };
    };
    const off = functionOf(plain);
    expect(off.Timeout).toBe(30);
    expect(off.Environment?.Variables?.LEARNING_COMPLETION_ENABLED).toBeUndefined();
    const on = functionOf(controlPlane({ ...PUBLIC, agentxTeamRecord: "enabled" }));
    expect(on.Timeout).toBe(120);
    expect(on.Environment?.Variables?.LEARNING_COMPLETION_ENABLED).toBe("1");
  }, 360_000);

  it("lessons in production: off, there is no reflection queue and no worker", () => {
    expect(Object.keys(resourcesOf(plain)).filter((id) => /Lessons(Worker|Reflect)/.test(id))).toStrictEqual([]);
    expect(JSON.stringify(plain.toJSON())).not.toMatch(/lessons-reflect|lessonsWorkerHandler/u);
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
    // UX-4b review fix 1: the record stays on for the broker (erasure, removals, Slack deletes and expiry keep running); TeamRecordEnabled (default 1) is the pause, as TEAM_RECORD_ACTIVE.
    expect(settings.teamRecord).toBe("1");
    expect(settings.teamRecordActive).toEqual({ Ref: "TeamRecordEnabled" });
    expect((on.toJSON() as { Parameters?: Record<string, unknown> }).Parameters?.TeamRecordEnabled).toMatchObject({ Type: "String", Default: "1", AllowedValues: ["0", "1"] });
    // ENV-ROOM: there is no embedding model setting any more (the self-hosted embedder is fixed; its function name is derived), and the record's dead-letter queue has a fixed name the broker derives.
    expect(Object.keys(BROKER_SETTINGS)).not.toContain("teamRecordEmbeddingModel");
    expect(variables).not.toHaveProperty("EMBEDDER_FUNCTION_NAME");
    expect(settings.teamRecordLake).toBe("1");
    expect(brokerNamesIn(variables).teamRecordVectorsRole).toStrictEqual({ Ref: expect.stringMatching(/^TeamRecordVectorsDataRole/) as string });
    expect(Object.keys(BROKER_NAMES)).not.toContain("teamRecordDeadLetters");
    for (const spec of [BROKER_SETTINGS.teamRecord, BROKER_SETTINGS.teamRecordLake, BROKER_NAMES.teamRecordVectorsRole]) expect(variables).not.toHaveProperty(spec.variable);
  }, 180_000);

  it("refuses the retired embedding model option instead of ignoring it", () => {
    expect(() => controlPlane({ ...PUBLIC, agentxTeamRecord: "enabled", agentxTeamRecordEmbeddingModelId: "cohere.embed-english-v3" })).toThrow(/embeddingModelId .*is retired/);
  }, 180_000);

  it("creates the self-hosted embedder: a container-image Lambda named from the environment, from an image digest that is required, invoked by the broker alone, in a network with no way out, with no Bedrock right", () => {
    const template = on.toJSON() as { Parameters?: Record<string, { Default?: string; AllowedPattern?: string }>; Rules?: Record<string, { Assertions: Array<{ Assert: unknown; AssertDescription: string }> }>; Conditions?: Record<string, unknown> };
    const parameter = template.Parameters?.EmbedderImageUri;
    expect(parameter?.Default).toBe("none");
    const pattern = new RegExp(parameter!.AllowedPattern!);
    expect(pattern.test("none")).toBe(true);
    expect(pattern.test(`111122223333.dkr.ecr.us-west-2.amazonaws.com/rovara/embedder@sha256:${"a".repeat(64)}`)).toBe(true);
    for (const bad of ["", "embedder:latest", `111122223333.dkr.ecr.us-west-2.amazonaws.com/rovara/embedder:v1`, `ghcr.io/x/embedder@sha256:${"a".repeat(64)}`, `docker.io/library/x@sha256:${"a".repeat(64)}`]) expect(pattern.test(bad), bad).toBe(false);
    // No keyword-only interim (decision 27): a stack with the Team record and no image is refused by a rule, with a message that says what to do. There is no condition that skips the function.
    const rule = template.Rules?.TeamRecordNeedsEmbedderImage;
    expect(rule?.Assertions).toHaveLength(1);
    expect(JSON.stringify(rule!.Assertions[0]!.Assert)).toBe(JSON.stringify({ "Fn::Not": [{ "Fn::Equals": [{ Ref: "EmbedderImageUri" }, "none"] }] }));
    expect(rule!.Assertions[0]!.AssertDescription).toMatch(/needs the embedder image.*agentx upgrade/s);
    expect(template.Conditions ?? {}).not.toHaveProperty("HasEmbedderImage");
    const embedder = Object.entries(resources).filter(([, resource]) => resource.Type === "AWS::Lambda::Function" && resource.Properties.FunctionName === "agentx-staging-embedder");
    expect(embedder).toHaveLength(1);
    const properties = embedder[0]![1].Properties;
    expect(properties).toMatchObject({ PackageType: "Image", Architectures: ["arm64"], MemorySize: 3008, Timeout: 180, ReservedConcurrentExecutions: 4, Code: { ImageUri: { Ref: "EmbedderImageUri" } } });
    expect(properties).not.toHaveProperty("Environment");
    expect((embedder[0]![1] as unknown as { Condition?: string }).Condition).toBeUndefined();
    // NO NETWORK: the function sits in two subnets of a VPC of its own with no gateway, no endpoint and no route but the local one, behind a security group with no egress rule (review H3).
    const byType = (type: string) => Object.entries(resources).filter(([, resource]) => resource.Type === type);
    expect(byType("AWS::EC2::VPC")).toHaveLength(1);
    expect(byType("AWS::EC2::Subnet")).toHaveLength(2);
    // R1: DNS is off in the VPC (the Amazon-provided resolver is not filtered by a security group and recurses to the internet: it would be an egress channel for a text).
    expect(byType("AWS::EC2::VPC")[0]![1].Properties).toMatchObject({ EnableDnsSupport: false, EnableDnsHostnames: false });
    // R5: the subnets sit in the foundation's verified zone IDs (a zone name is a different physical zone in each account), not in zones picked by name.
    const zoneIds = byType("AWS::EC2::Subnet").map(([, resource]) => resource.Properties.AvailabilityZoneId);
    expect(zoneIds).toStrictEqual([...defaultProductionAvailabilityZoneIds("us-east-1")]);
    for (const [, subnet] of byType("AWS::EC2::Subnet")) expect(subnet.Properties).not.toHaveProperty("AvailabilityZone");
    for (const type of ["AWS::EC2::InternetGateway", "AWS::EC2::NatGateway", "AWS::EC2::VPCEndpoint", "AWS::EC2::Route", "AWS::EC2::EIP", "AWS::EC2::VPCGatewayAttachment"]) {
      const mine = byType(type).filter(([id]) => /^Embedder/.test(id));
      expect(mine, type).toStrictEqual([]);
    }
    const vpcConfig = properties.VpcConfig as { SecurityGroupIds: unknown[]; SubnetIds: unknown[] };
    expect(vpcConfig.SubnetIds).toHaveLength(2);
    expect(vpcConfig.SecurityGroupIds).toHaveLength(1);
    const group = byType("AWS::EC2::SecurityGroup").find(([id]) => /^EmbedderSecurityGroup/.test(id))![1];
    expect(group.Properties).not.toHaveProperty("SecurityGroupIngress");
    expect(group.Properties.SecurityGroupEgress).toStrictEqual([{ IpProtocol: "icmp", CidrIp: "255.255.255.255/32", FromPort: 252, ToPort: 86, Description: "Disallow all traffic" }]);
    // The broker may invoke this one function; the function's own role holds log writes to its own group and the network-interface rights Lambda needs for a VPC, and nothing else; nobody holds a Bedrock embedding right for the record any more.
    const statements = Object.values(resources).flatMap((resource) => (resource.Type === "AWS::IAM::Policy" || resource.Type === "AWS::IAM::ManagedPolicy" ? ((resource.Properties.PolicyDocument as { Statement: Array<{ Sid?: string; Action: string | string[]; Resource: unknown }> }).Statement) : []))
    const invoke = statements.filter((statement) => statement.Sid === "InvokeEmbedder");
    expect(invoke).toHaveLength(1);
    expect(invoke[0]!.Action).toBe("lambda:InvokeFunction");
    expect(JSON.stringify(invoke[0]!.Resource)).toContain("function:agentx-staging-embedder");
    expect(statements.filter((statement) => statement.Sid === "TeamRecordEmbeddings")).toStrictEqual([]);
    const role = Object.entries(resources).find(([id, resource]) => resource.Type === "AWS::IAM::Role" && /^EmbedderRole/.test(id))![1];
    expect(JSON.stringify(role.Properties)).not.toMatch(/ManagedPolicyArns/);
    const rolePolicies = Object.entries(resources).filter(([id, resource]) => resource.Type === "AWS::IAM::Policy" && /^EmbedderRole/.test(id));
    const roleStatements = rolePolicies.flatMap(([, resource]) => (resource.Properties.PolicyDocument as { Statement: Array<{ Sid?: string; Action: string | string[]; Resource: unknown }> }).Statement);
    const allowed = roleStatements.filter((statement) => (statement as { Effect?: string }).Effect !== "Deny");
    const denied = roleStatements.filter((statement) => (statement as { Effect?: string }).Effect === "Deny");
    const roleActions = allowed.flatMap((statement) => [statement.Action].flat()).sort();
    expect(roleActions).toStrictEqual(["ec2:AssignPrivateIpAddresses", "ec2:CreateNetworkInterface", "ec2:DeleteNetworkInterface", "ec2:DescribeNetworkInterfaces", "ec2:DescribeSubnets", "ec2:UnassignPrivateIpAddresses", "logs:CreateLogStream", "logs:PutLogEvents"]);
    // The 0.5.13 switch-on failed at CreateFunction ("The provided execution role does not have permissions to call DeleteNetworkInterface on EC2") because these actions were scoped to network-interface/*. Lambda checks them when it
    // creates the function and the AWS Lambda documentation ("Required IAM permissions", configuration-vpc) says to allow all six on "Resource": "*": a template diff, cfn-lint and a change set cannot see the difference, so this
    // test is the guard. Every one of the six must sit in a statement whose Resource is exactly "*".
    const onStar = (action: string) => allowed.some((statement) => [statement.Action].flat().includes(action) && JSON.stringify(statement.Resource) === '"*"');
    for (const action of ["ec2:CreateNetworkInterface", "ec2:DescribeNetworkInterfaces", "ec2:DescribeSubnets", "ec2:DeleteNetworkInterface", "ec2:AssignPrivateIpAddresses", "ec2:UnassignPrivateIpAddresses"]) expect(onStar(action), action).toBe(true);
    // And no log right is on "*" (the AWS-managed VPC policy would give that): only the one network statement takes "*", and nothing allowed names a network-interface ARN any more.
    expect(allowed.filter((statement) => JSON.stringify(statement.Resource) === '"*"').map((statement) => statement.Sid).sort()).toStrictEqual(["LambdaManagesVpcNetworkInterfaces"]);
    expect(allowed.filter((statement) => /logs:/.test(JSON.stringify(statement.Action))).every((statement) => JSON.stringify(statement.Resource) !== '"*"')).toBe(true);
    // Least privilege kept: "*" is safe only because the function's own code is denied every one of them. lambda:SourceFunctionArn is present only on calls made by the function's code (the Lambda service's own calls to
    // manage the interfaces do not carry it), the condition names the one function by its UNQUALIFIED arn (the key supports no versions or aliases), and the ARN is a plain string built from the function's name, not a Ref or
    // GetAtt of the function (the function depends on this role: a reference would be a circular dependency, which synth would also refuse).
    expect(denied).toHaveLength(1);
    const deny = denied[0] as unknown as { Sid: string; Effect: string; Action: string[]; Resource: unknown; Condition: Record<string, Record<string, unknown>> };
    expect(deny.Sid).toBe("DenyNetworkInterfacesToOwnCode");
    expect(deny.Resource).toBe("*");
    for (const action of ["ec2:CreateNetworkInterface", "ec2:DeleteNetworkInterface", "ec2:DescribeNetworkInterfaces", "ec2:DescribeSubnets", "ec2:DetachNetworkInterface", "ec2:AssignPrivateIpAddresses", "ec2:UnassignPrivateIpAddresses"]) expect(deny.Action, action).toContain(action);
    // Everything the allow statements grant on ec2 is denied to the code. (DescribeSecurityGroups and DescribeVpcs are not granted: Lambda checks them with the deploying principal's credentials.)
    for (const action of roleActions.filter((name) => name.startsWith("ec2:"))) expect(deny.Action, action).toContain(action);
    expect(Object.keys(deny.Condition)).toStrictEqual(["ArnEquals"]);
    expect(Object.keys(deny.Condition.ArnEquals!)).toStrictEqual(["lambda:SourceFunctionArn"]);
    const sourceArn = deny.Condition.ArnEquals!["lambda:SourceFunctionArn"] as unknown[];
    expect(sourceArn).toHaveLength(1);
    // Lambda checks the rights at CreateFunction, so the function must wait for the policy that holds them (not only for the role).
    expect((embedder[0]![1] as unknown as { DependsOn?: string[] }).DependsOn ?? []).toEqual(expect.arrayContaining([expect.stringMatching(/^EmbedderRoleDefaultPolicy[0-9A-F]{8}$/)]));
    expect(JSON.stringify(sourceArn[0])).toContain(':function:agentx-staging-embedder"');
    expect(JSON.stringify(sourceArn[0])).not.toMatch(/"Fn::GetAtt"|"Ref":"Embedder[0-9A-F]{8}"|function:agentx-staging-embedder:/);
    // The Deny holds no wildcard action and no `ec2:*`.
    expect(deny.Action.some((name) => name.includes("*"))).toBe(false);
  }, 180_000);

  it("places the embedder's subnets by the zone IDs of the region it is deployed to", () => {
    const west = resourcesOf(controlPlane({ ...PUBLIC, agentxTeamRecord: "enabled", agentxRegion: "us-west-2" }));
    const ids = Object.entries(west).filter(([id, resource]) => resource.Type === "AWS::EC2::Subnet" && /^EmbedderSubnet/.test(id)).map(([, resource]) => resource.Properties.AvailabilityZoneId);
    expect(ids).toStrictEqual([...defaultProductionAvailabilityZoneIds("us-west-2")]);
  }, 360_000);

  it("drops the embedder's reserved concurrency where the account cannot take one (agentxReservedConcurrency=false), and an Enterprise install gets the same function", () => {
    const noReservation = resourcesOf(controlPlane({ ...PUBLIC, agentxTeamRecord: "enabled", agentxReservedConcurrency: false }));
    const noResFn = Object.values(noReservation).find((resource) => resource.Type === "AWS::Lambda::Function" && resource.Properties.FunctionName === "agentx-staging-embedder");
    expect(noResFn).toBeDefined();
    expect(noResFn!.Properties).not.toHaveProperty("ReservedConcurrentExecutions");
    const enterprise = resourcesOf(controlPlane({ ...ENTERPRISE, agentxTeamRecord: "enabled", agentxTeamRecordKmsKeyArn: KMS, agentxTeamRecordEnterpriseWorkspaceId: "org_aaaaaaaaaaaaaaaaaaaa" }));
    expect(Object.values(enterprise).filter((resource) => resource.Type === "AWS::Lambda::Function" && resource.Properties.FunctionName === "agentx-ent-embedder")).toHaveLength(1);
    // The same network-interface rights in an Enterprise install (Lambda checks them at CreateFunction): the six on "*" for Lambda and the Deny for the function's own code, by the function's own unqualified arn.
    const entStatements = Object.entries(enterprise).filter(([id, resource]) => resource.Type === "AWS::IAM::Policy" && /^EmbedderRole/.test(id)).flatMap(([, resource]) => (resource.Properties.PolicyDocument as { Statement: Array<{ Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: unknown }> }).Statement);
    const entAllow = entStatements.find((statement) => statement.Sid === "LambdaManagesVpcNetworkInterfaces");
    expect(entAllow?.Resource).toBe("*");
    expect([entAllow!.Action].flat().sort()).toStrictEqual(["ec2:AssignPrivateIpAddresses", "ec2:CreateNetworkInterface", "ec2:DeleteNetworkInterface", "ec2:DescribeNetworkInterfaces", "ec2:DescribeSubnets", "ec2:UnassignPrivateIpAddresses"]);
    const entDeny = entStatements.find((statement) => statement.Effect === "Deny");
    expect(entDeny?.Sid).toBe("DenyNetworkInterfacesToOwnCode");
    expect(JSON.stringify(entDeny?.Condition)).toContain('"lambda:SourceFunctionArn"');
    expect(JSON.stringify(entDeny?.Condition)).toContain(":function:agentx-ent-embedder");
  }, 360_000);

  it("schedules the hourly, the nightly and the re-embed job through the recovery role, with no retries, and nothing else", () => {
    const schedules = Object.entries(resources).filter(([id, resource]) => resource.Type === "AWS::Scheduler::Schedule" && id.startsWith("TeamRecord"));
    expect(schedules.map(([id]) => id.replace(/[0-9A-F]{8}$/, "")).sort()).toStrictEqual(["TeamRecordHourlySchedule", "TeamRecordNightlySchedule", "TeamRecordReembedSchedule"]);
    const inputs = schedules.map(([, resource]) => JSON.parse((resource.Properties.Target as { Input: string }).Input) as unknown).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    expect(inputs).toStrictEqual([{ source: TEAM_RECORD_JOB_SOURCE, job: "hourly" }, { source: TEAM_RECORD_JOB_SOURCE, job: "nightly" }, { source: TEAM_RECORD_JOB_SOURCE, job: "reembed" }]);
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
    // TR-SWITCH (0.5.11): the table only, no index. Every read of the dispatcher's delivery path is by pk and sk on the base table, and the indexes project the recorded text (the key condition the plan asked
    // for cannot separate lesson rows from record rows: they share a partition, see TeamRecordTable.dispatcherStatements).
    expect(JSON.stringify(reads[0]!.Resource)).not.toMatch(/index/);
    expect(reads[0]).not.toHaveProperty("Condition");
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
    // Lambda checks the consumer's role at CreateEventSourceMapping (sqs:ReceiveMessage, sqs:DeleteMessage, sqs:GetQueueAttributes on the queue): a missing one fails the stack at create, where a template diff cannot see it.
    const policyStatements = Object.values(resources).flatMap((resource) => (resource.Type === "AWS::IAM::Policy" || resource.Type === "AWS::IAM::ManagedPolicy" ? ((resource.Properties.PolicyDocument as { Statement: Array<{ Action: string | string[]; Resource: unknown }> }).Statement) : []));
    // (CDK merges the queue and its dead-letter queue into one statement: match the queue's own ARN, not the dead-letter queue's.)
    const onOps = policyStatements.filter((statement) => /"TeamRecordOps[0-9A-F]{8}","Arn"/.test(JSON.stringify(statement.Resource)));
    const opsActions = new Set(onOps.flatMap((statement) => [statement.Action].flat()));
    for (const action of ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]) expect(opsActions.has(action), action).toBe(true);
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
    expect(trust).toContain("aws:RequestTag/rovara-retired-index");
    expect(trust).toContain("ws-*");
    const policies = Object.entries(resources).filter(([id, resource]) => resource.Type === "AWS::IAM::Policy" && /^TeamRecordVectorsDataRole/.test(id));
    expect(policies).toHaveLength(1);
    const text = JSON.stringify(policies[0]![1].Properties.PolicyDocument);
    expect(text).toContain("${aws:PrincipalTag/rovara-index}");
    expect(text).not.toContain("/index/*");
    for (const statement of (policies[0]![1].Properties.PolicyDocument as { Statement: Array<{ Sid?: string; Action: string | string[]; Resource: unknown }> }).Statement) {
      if ([statement.Action].flat().some((action) => action.startsWith("s3vectors:"))) expect(JSON.stringify(statement.Resource)).toContain(statement.Sid === "TeamRecordVectorsRetireOldIndex" ? "${aws:PrincipalTag/rovara-retired-index}" : "${aws:PrincipalTag/rovara-index}");
    }
    // The one extra right is deleting the workspace's retired index (the retire step; an erase starts with it), named by its own session tag.
    const retire = (policies[0]![1].Properties.PolicyDocument as { Statement: Array<{ Sid?: string; Action: string | string[] }> }).Statement.filter((statement) => [statement.Action].flat().includes("s3vectors:DeleteIndex"));
    expect(retire.map((statement) => [statement.Sid, statement.Action])).toStrictEqual([["TeamRecordVectorsRetireOldIndex", "s3vectors:DeleteIndex"]]);
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

// Lessons in production, lane 2 (WB-4): the reflection queue and the LessonsWorker, behind the same switch.
describe("the lessons worker (switch on)", () => {
  const on = controlPlane({ ...PUBLIC, agentxTeamRecord: "enabled" });
  const resources = resourcesOf(on);
  const byId = (pattern: RegExp, type: string) => Object.entries(resources).filter(([id, resource]) => resource.Type === type && pattern.test(id));
  const worker = () => { const found = byId(/^LessonsWorker[0-9A-F]{8}$/, "AWS::Lambda::Function"); expect(found).toHaveLength(1); return found[0]![1].Properties as Record<string, unknown> & { Timeout: number; Handler: string; ReservedConcurrentExecutions?: number; VpcConfig?: unknown; Environment?: { Variables: Record<string, unknown> } }; };
  const queue = (id: RegExp) => { const found = byId(id, "AWS::SQS::Queue"); expect(found).toHaveLength(1); return found[0]![1].Properties; };
  const statementsOf = (rolePattern: RegExp): Array<{ Sid?: string; Action: string | string[]; Resource: unknown; Condition?: unknown }> => Object.entries(resources)
    .filter(([id, resource]) => (resource.Type === "AWS::IAM::Policy" || resource.Type === "AWS::IAM::ManagedPolicy") && rolePattern.test(id))
    .flatMap(([, resource]) => (resource.Properties.PolicyDocument as { Statement: Array<{ Sid?: string; Action: string | string[]; Resource: unknown; Condition?: unknown }> }).Statement);

  it("the queue holds ids for four days, encrypted, with a dead-letter queue after five receives (the attempts are capped at three, so the queue reaches it only after them); its visibility timeout is above the worker's timeout, and the worker outlives the broker's 130 s model wait (R5)", () => {
    const main = queue(/^LessonsReflect[0-9A-F]{8}$/);
    expect(main).toMatchObject({ QueueName: "agentx-staging-lessons-reflect", MessageRetentionPeriod: 345600, SqsManagedSseEnabled: true, RedrivePolicy: { maxReceiveCount: LESSONS_REFLECT_MAX_RECEIVES } });
    expect(JSON.stringify((main.RedrivePolicy as { deadLetterTargetArn: unknown }).deadLetterTargetArn)).toContain("LessonsReflectDeadLetters");
    expect(LESSONS_REFLECT_MAX_RECEIVES).toBe(5);
    const dead = queue(/^LessonsReflectDeadLetters[0-9A-F]{8}$/);
    expect(dead).toMatchObject({ QueueName: "agentx-staging-lessons-reflect-dead", SqsManagedSseEnabled: true });
    // The numbers, pinned from the template itself: timeout 300 s, visibility 1800 s, the model wait 130 s.
    expect(worker().Timeout).toBe(300);
    expect(main["VisibilityTimeout"]).toBe(1800);
    expect(worker().Timeout).toBeGreaterThan(LESSONS_BROKER_MODEL_WAIT_SECONDS + 60);
    expect(main["VisibilityTimeout"] as number).toBeGreaterThan(worker().Timeout);
    expect(worker().Timeout).toBe(LESSONS_WORKER_TIMEOUT_SECONDS);
    expect(main["VisibilityTimeout"]).toBe(LESSONS_REFLECT_VISIBILITY_SECONDS);
  }, 360_000);

  it("owner decision 47: the worker obeys the same lessons switch as the broker (the LearnedLessonsEnabled parameter, packed), so a switched-off install makes no reflection call from the worker either", () => {
    const settings = brokerSettingsIn(worker().Environment?.Variables);
    expect(JSON.stringify(settings["learnedLessons"])).toContain("LearnedLessonsEnabled");
    expect(JSON.stringify(brokerSettingsIn(functionVariables(on, /^Broker[0-9A-F]{8}$/))["learnedLessons"])).toBe(JSON.stringify(settings["learnedLessons"]));
  }, 360_000);

  it("the worker is its own entry, outside the VPC, reserved to two, fed one message at a time with partial-batch answers (M6)", () => {
    const fn = worker();
    expect(fn.Handler).toBe("index.lessonsWorkerHandler");
    expect(fn.ReservedConcurrentExecutions).toBe(LESSONS_WORKER_RESERVED_CONCURRENCY);
    expect(fn.VpcConfig).toBeUndefined();
    const mapping = Object.values(resources).find((resource) => resource.Type === "AWS::Lambda::EventSourceMapping" && JSON.stringify(resource.Properties).includes("LessonsWorker"));
    expect(mapping?.Properties).toMatchObject({ FunctionResponseTypes: ["ReportBatchItemFailures"], BatchSize: 1, ScalingConfig: { MaximumConcurrency: LESSONS_WORKER_RESERVED_CONCURRENCY } });
    expect(JSON.stringify(mapping?.Properties)).toContain("LessonsReflect");
  }, 360_000);

  it("M6: the worker has an explicit, small environment: no callback signing key, no OIDC or admin settings, nothing the broker holds that learning does not read; its names and settings are only those the entry reads", () => {
    const variables = worker().Environment?.Variables ?? {};
    const broker = functionVariables(on, /^Broker[0-9A-F]{8}$/);
    // The broker has the signing key (a secret passed in plain text); the worker is never given it, or any variable the broker has that the worker's entry does not read.
    expect(broker).toHaveProperty("CALLBACK_SIGNING_KEY");
    for (const forbidden of ["CALLBACK_SIGNING_KEY", "OIDC_ISSUER", "ADMIN_CLAIM", "ADMIN_VALUES", "CHATGPT_CONNECTION_KEY_ARN", "AUDIT_INTAKE_QUEUE_URL", "SLACK_REQUEST_QUEUE_URL"]) expect(variables, forbidden).not.toHaveProperty(forbidden);
    expect(JSON.stringify(variables)).not.toMatch(/CallbackSigningKey/u);
    expect(Object.keys(variables).sort()).toEqual(["AGENTX_ACCOUNT_ID", "AGENTX_ENV", "AGENTX_NAMES", "AGENTX_SETTINGS", "GITHUB_APP_PRIVATE_KEY_SECRET_ARN", "ROVARA_EDITION"]);
    // The packed names are the State table, the artifacts bucket, the sign-in table and the model function (codes in BROKER_NAMES), and the packed settings are the Team record's two, the GitHub App's two and the lessons switch (owner decision 47: the worker makes no model call while it is off).
    const codesOf = (value: unknown): string[] => [...JSON.stringify(value).matchAll(/"?,?([a-z]{2})=/gu)].map((match) => match[1]!);
    const nameCodes = codesOf(variables["AGENTX_NAMES"]);
    expect(nameCodes.sort()).toEqual([BROKER_NAMES.signInTable.code, BROKER_NAMES.stateTable.code, BROKER_NAMES.artifactBucket.code, BROKER_NAMES.modelAccessFunction.code].sort());
    expect(codesOf(variables["AGENTX_SETTINGS"]).sort()).toEqual([BROKER_SETTINGS.teamRecord.code, BROKER_SETTINGS.teamRecordActive.code, BROKER_SETTINGS.githubAppCredentialRef.code, BROKER_SETTINGS.githubAppId.code, BROKER_SETTINGS.learnedLessons.code].sort());
    // Its own entry: the broker module (and so a second broker) is not loaded; the sizes are far inside Lambda's 4 KB.
    expect(JSON.stringify(variables).length).toBeLessThan(2000);
  }, 360_000);

  it("the worker's role holds only what a reflection touches: the tables, the plan documents, the model function, the queue and the GitHub key; the broker may send to the queue and not receive", () => {
    const statements = statementsOf(/^LessonsWorkerServiceRole/);
    const actions = new Set(statements.flatMap((statement) => [statement.Action].flat()));
    for (const forbidden of ["ec2:", "bedrock:", "scheduler:", "iam:", "lambda:InvokeAsync", "sqs:SendMessage", "s3:Put", "s3:Delete", "dynamodb:Scan", "dynamodb:DeleteTable", "secretsmanager:Put"]) {
      expect([...actions].filter((action) => action.startsWith(forbidden)), forbidden).toEqual([]);
    }
    // Lambda: invoke, on the model access function and on the self-hosted embedder (lesson similarity) alone.
    const invokes = statements.filter((statement) => [statement.Action].flat().some((action) => action.startsWith("lambda:")));
    expect(invokes).toHaveLength(2);
    for (const invoke of invokes) expect([invoke.Action].flat()).toEqual(["lambda:InvokeFunction"]);
    const model = invokes.filter((invoke) => JSON.stringify(invoke.Resource).includes("ModelAccessFunction"));
    expect(model).toHaveLength(1);
    expect(JSON.stringify(model[0]!.Resource)).not.toContain("Broker");
    const embedder = invokes.filter((invoke) => invoke.Sid === "LessonsInvokeEmbedder");
    expect(embedder).toHaveLength(1);
    // The one function by its derived name, exactly as the broker's InvokeEmbedder names it: no wildcard, no other function.
    expect(JSON.stringify(embedder[0]!.Resource)).toContain("function:agentx-staging-embedder");
    expect(JSON.stringify(embedder[0]!.Resource)).not.toContain("*");
    // The queue: consume only, on the one queue.
    const consume = statements.filter((statement) => [statement.Action].flat().includes("sqs:ReceiveMessage"));
    expect(consume).toHaveLength(1);
    expect(JSON.stringify(consume[0]!.Resource)).toContain("LessonsReflect");
    expect(JSON.stringify(consume[0]!.Resource)).not.toContain("DeadLetters");
    // The record table and the State table, named; the secret by its exact ARN; the artifacts by prefix.
    expect(statements.some((statement) => statement.Sid === "TeamRecordTable")).toBe(true);
    const secret = statements.find((statement) => statement.Sid === "ReadGithubAppKey")!;
    expect([secret.Action].flat()).toEqual(["secretsmanager:GetSecretValue"]);
    expect(JSON.stringify(secret.Resource)).not.toContain("*");
    const s3Reads = statements.filter((statement) => [statement.Action].flat().some((action) => action.startsWith("s3:GetObject")));
    expect(JSON.stringify(s3Reads.map((statement) => statement.Resource))).toContain("/private/*");
    // Wildcard resources: only the generated ones (X-Ray, which CDK gives every traced function) and the table indexes.
    const open = statements.filter((statement) => JSON.stringify(statement.Resource) === '"*"');
    expect(open.flatMap((statement) => [statement.Action].flat()).sort()).toEqual(["xray:PutTelemetryRecords", "xray:PutTraceSegments"]);
    // The broker: send to the queue, and nothing that takes a message out.
    const brokerStatements = Object.entries(resources).filter(([id, resource]) => /Broker/.test(id) && (resource.Type === "AWS::IAM::Policy" || resource.Type === "AWS::IAM::ManagedPolicy"))
      .flatMap(([, resource]) => (resource.Properties.PolicyDocument as { Statement: Array<{ Action: string | string[]; Resource: unknown }> }).Statement);
    const toQueue = brokerStatements.filter((statement) => JSON.stringify(statement.Resource).includes("LessonsReflect[0-9A-F]") || /"LessonsReflect[0-9A-F]{8}"/.test(JSON.stringify(statement.Resource)));
    expect(toQueue.flatMap((statement) => [statement.Action].flat())).toContain("sqs:SendMessage");
    expect(toQueue.flatMap((statement) => [statement.Action].flat()).filter((action) => /Receive|Delete/.test(action))).toEqual([]);
  }, 360_000);

  it("M7: the State table is READ anywhere but WRITTEN only under the key prefixes the worker uses (its lease, the spend ledger's records, pending audit items); no write action is allowed without that condition", () => {
    const statements = statementsOf(/^LessonsWorkerServiceRole/);
    const writeActions = /^dynamodb:(PutItem|UpdateItem|DeleteItem|ConditionCheckItem|BatchWriteItem)$/u;
    const writers = statements.filter((statement) => [statement.Action].flat().some((action) => writeActions.test(action)));
    // The Team record table's own statement (the lessons' store) is the broker's, by name; every other statement that writes is the State table's and carries the key condition.
    const stateWriters = writers.filter((statement) => statement.Sid !== "TeamRecordTable");
    expect(stateWriters.map((statement) => statement.Sid)).toEqual(["LessonsStateTableWrites"]);
    const condition = stateWriters[0]!.Condition as Record<string, Record<string, string[]>>;
    // R6: ForAllValues passes when the key is absent, so the condition also requires that the key is present (a Null test), which protects an action added later.
    expect(Object.keys(condition).sort()).toEqual(["ForAllValues:StringLike", "Null"]);
    expect(condition["Null"]).toEqual({ "dynamodb:LeadingKeys": "false" });
    const patterns = condition["ForAllValues:StringLike"]!["dynamodb:LeadingKeys"]!;
    expect([...patterns].sort()).toEqual([...LESSONS_WORKER_STATE_WRITE_KEY_PATTERNS].sort());
    // A task, a session, a sign-in name, a key or a billing record is not under any of them.
    const matches = (key: string) => patterns.some((pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*")}$`, "u").test(key));
    for (const key of ["LEARN#org_aaaaaaaaaaaaaaaaaaaa#task-1#merged", "ORG#org_aaaaaaaaaaaaaaaaaaaa#SPEND#2026-11", `ORG#org_aaaaaaaaaaaaaaaaaaaa#MODEL_KEY#${"a".repeat(64)}`, "OPEN_MODEL_KEYS", "AUDIT_PENDING#3"]) expect(matches(key), key).toBe(true);
    for (const key of ["DEVTASK#t1", "TASK#t1", "SESSION#s1", "ORG#org_aaaaaaaaaaaaaaaaaaaa#PROJECT#web", "ORG#org_aaaaaaaaaaaaaaaaaaaa", "ORG#org_aaaaaaaaaaaaaaaaaaaa#BILLING#x", "ORG#org_aaaaaaaaaaaaaaaaaaaa#MEMBER_KEY#k", "KEYS#x"]) expect(matches(key), key).toBe(false);
    // The reads are a statement of their own, with no write action in it.
    const reads = statements.find((statement) => statement.Sid === "LessonsStateTableReads")!;
    expect([reads.Action].flat().sort()).toEqual(["dynamodb:BatchGetItem", "dynamodb:GetItem", "dynamodb:Query"]);
    expect(reads.Condition).toBeUndefined();
  }, 360_000);

  it("M5: the dead-letter queue and the worker's errors and throttles alarm the operator; the broker may read the dead-letter queue's depth (and nothing else on it) for the Health page", () => {
    const alarms = Object.entries(resources).filter(([, resource]) => resource.Type === "AWS::CloudWatch::Alarm").map(([id, resource]): Record<string, unknown> => ({ id, ...resource.Properties }));
    const named = (suffix: string) => alarms.find((alarm) => alarm["AlarmName"] === `agentx-staging-${suffix}`) as Record<string, unknown>;
    const dead = named("LessonsReflectDeadLetters");
    expect(dead).toMatchObject({ MetricName: "ApproximateNumberOfMessagesVisible", Namespace: "AWS/SQS", Threshold: 1, ComparisonOperator: "GreaterThanOrEqualToThreshold", TreatMissingData: "notBreaching" });
    expect(JSON.stringify(dead["Dimensions"])).toContain("LessonsReflectDeadLetters");
    // F2: the dead-letter queue holds reflections and human edits; the alarm text says so and where to tell them apart.
    expect(String(dead["AlarmDescription"])).toMatch(/human edit/);
    expect(String(dead["AlarmDescription"])).toMatch(/kind field says reflection or human_edit/);
    const errors = named("LessonsWorkerErrors");
    expect(errors).toMatchObject({ MetricName: "Errors", Namespace: "AWS/Lambda", Period: 900, Threshold: 1 });
    expect(JSON.stringify(errors["Dimensions"])).toContain("LessonsWorker");
    expect(named("LessonsWorkerThrottles")).toMatchObject({ MetricName: "Throttles", Period: 900 });
    for (const alarm of [dead, errors, named("LessonsWorkerThrottles")]) expect(JSON.stringify(alarm["AlarmActions"]), String(alarm["AlarmName"])).toContain("OperatorAlerts");
    // The broker reads the queue's depth: GetQueueAttributes on the dead-letter queue, no receive, no delete.
    const brokerStatements = Object.entries(resources).filter(([id, resource]) => /Broker/.test(id) && (resource.Type === "AWS::IAM::Policy" || resource.Type === "AWS::IAM::ManagedPolicy"))
      .flatMap(([, resource]) => (resource.Properties.PolicyDocument as { Statement: Array<{ Action: string | string[]; Resource: unknown }> }).Statement);
    const toDead = brokerStatements.filter((statement) => /"LessonsReflectDeadLetters[0-9A-F]{8}"/.test(JSON.stringify(statement.Resource)));
    expect(toDead.flatMap((statement) => [statement.Action].flat())).toContain("sqs:GetQueueAttributes");
    expect(toDead.flatMap((statement) => [statement.Action].flat()).filter((action) => /Receive|Delete|Send|Purge/.test(action))).toEqual([]);
    expect(HEALTH_ALARM_SUFFIXES).toEqual(expect.arrayContaining(["LessonsReflectDeadLetters", "LessonsWorkerErrors", "LessonsWorkerThrottles"]));
  }, 360_000);

  it("M6: the worker holds no right to the audit intake queue, to itself or to any queue but its own, and L8 is noted: the vectors and embedder grants are not there yet because similarity is stubbed", () => {
    const statements = statementsOf(/^LessonsWorkerServiceRole/);
    const actions = [...new Set(statements.flatMap((statement) => [statement.Action].flat()))];
    // Queues: only what consuming its own queue takes; never a send.
    expect(actions.filter((action) => action.startsWith("sqs:")).sort()).toEqual(["sqs:ChangeMessageVisibility", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:ReceiveMessage"]);
    expect(JSON.stringify(statements.filter((statement) => [statement.Action].flat().some((action) => action.startsWith("sqs:"))).map((statement) => statement.Resource))).not.toMatch(/Audit|Broker|TeamRecordOps/u);
    // L8 (noted): similarity is NOT wired (lessonSimilarityFor answers no embedder and no vectors), so the worker has no vectors role, no Bedrock and no S3 Vectors right. When DECISIONS 23/27 land the embedder and the vectors this
    // test must change on purpose: the worker's role then needs the vectors data role (assume only), the embedding model's InvokeModel, and in Enterprise the customer's key for S3 Vectors.
    expect(actions.filter((action) => /^(bedrock|s3vectors|sts):/.test(action))).toEqual([]);
  }, 360_000);

  it("Enterprise: the worker may use the customer's table key through DynamoDB only", () => {
    const enterprise = resourcesOf(controlPlane({ ...ENTERPRISE, agentxTeamRecord: "enabled", agentxTeamRecordKmsKeyArn: KMS, agentxTeamRecordEnterpriseWorkspaceId: "org_aaaaaaaaaaaaaaaaaaaa" }));
    const statements = Object.entries(enterprise).filter(([id, resource]) => /^LessonsWorkerServiceRole/.test(id) && resource.Type === "AWS::IAM::Policy")
      .flatMap(([, resource]) => (resource.Properties.PolicyDocument as { Statement: Array<{ Sid?: string; Action: string | string[]; Resource: unknown; Condition?: unknown }> }).Statement);
    const key = statements.find((statement) => statement.Sid === "TeamRecordTableKms");
    expect(key).toBeDefined();
    expect(key!.Resource).toBe(KMS);
    expect(JSON.stringify(key!.Condition)).toContain("kms:ViaService");
    // Public has no customer key, so no key statement.
    expect(statementsOf(/^LessonsWorkerServiceRole/).some((statement) => statement.Sid === "TeamRecordTableKms")).toBe(false);
  }, 360_000);
});

// SRL-5 round 2 (3), round 3 and R7, SRL-6: the hourly job's GitHub sweeps and the delete paths log a fixed line when they fail; each line is counted by a metric filter on the BROKER's log group (the
// hourly job runs in the broker; its lines are JSON with `event`) and pages the operator. Behind the Team record switch like everything else here.
describe("the team record sweep alarms (switch on)", () => {
  const SWEEP_ALARMS = [
    { suffix: "TeamRecordSweepProblem", event: "record.github_sweep_problem", metric: "TeamRecordGithubSweepProblem" },
    { suffix: "TeamRecordRepoCheckRefused", event: "record.github_repo_check_refused", metric: "TeamRecordGithubRepoCheckRefused" },
    { suffix: "TeamRecordRedeliveryStateConflict", event: "record.github_redelivery_state_conflict", metric: "TeamRecordGithubRedeliveryStateConflict" },
    { suffix: "TeamRecordEraseSweepFailed", event: "record.erase_sweep_failed", metric: "TeamRecordEraseSweepFailed" },
    { suffix: "TeamRecordTombstoneFailed", event: "record.tombstone_failed", metric: "TeamRecordTombstoneFailed" },
    { suffix: "TeamRecordRepoCheckNoTime", event: "record.github_repo_check_no_time", metric: "TeamRecordGithubRepoCheckNoTime" },
  ] as const;
  const on = controlPlane({ ...PUBLIC, agentxTeamRecord: "enabled" });
  const resources = resourcesOf(on);
  const filters = Object.entries(resources).filter(([, resource]) => resource.Type === "AWS::Logs::MetricFilter");
  const alarms = Object.values(resources).filter((resource) => resource.Type === "AWS::CloudWatch::Alarm").map((resource) => resource.Properties);
  const brokerLogGroupId = Object.entries(resources).find(([id, resource]) => resource.Type === "AWS::Logs::LogGroup" && /^BrokerLogs[0-9A-F]{8}$/.test(id))![0];

  it.each(SWEEP_ALARMS)("$event is counted on the broker's log group by its JSON event field, exactly", ({ event, metric }) => {
    const found = filters.filter(([, resource]) => resource.Properties["FilterPattern"] === `{ $.event = "${event}" }`);
    expect(found).toHaveLength(1);
    const [id, filter] = found[0]!;
    expect(id).toMatch(/^BrokerLogs/);
    expect(filter.Properties["LogGroupName"]).toStrictEqual({ Ref: brokerLogGroupId });
    expect(filter.Properties["MetricTransformations"]).toStrictEqual([{ MetricName: metric, MetricNamespace: "AgentX/staging", MetricValue: "1" }]);
  }, 360_000);

  it.each(SWEEP_ALARMS.filter(({ suffix }) => suffix !== "TeamRecordRepoCheckNoTime"))("$suffix pages the operator on one line in an hour, and missing data is not a breach", ({ suffix, metric }) => {
    const alarm = alarms.find((candidate) => candidate["AlarmName"] === `agentx-staging-${suffix}`);
    expect(alarm).toMatchObject({ Namespace: "AgentX/staging", MetricName: metric, Statistic: "Sum", Period: 3600, EvaluationPeriods: 1, Threshold: 1, ComparisonOperator: "GreaterThanOrEqualToThreshold", TreatMissingData: "notBreaching" });
    expect(JSON.stringify(alarm!["AlarmActions"])).toContain("OperatorAlerts");
    expect(String(alarm!["AlarmDescription"])).toContain("record.");
  }, 360_000);

  it("the out-of-time repository check pages only when it repeats: three hourly runs in a row", () => {
    const alarm = alarms.find((candidate) => candidate["AlarmName"] === "agentx-staging-TeamRecordRepoCheckNoTime");
    expect(alarm).toMatchObject({ Namespace: "AgentX/staging", MetricName: "TeamRecordGithubRepoCheckNoTime", Statistic: "Sum", Period: 3600, EvaluationPeriods: 3, DatapointsToAlarm: 3, Threshold: 1, TreatMissingData: "notBreaching" });
    expect(JSON.stringify(alarm!["AlarmActions"])).toContain("OperatorAlerts");
  }, 360_000);

  // The alarms are only as good as the event names: a rename in the broker would leave the filter counting nothing, so each name must still be written by the broker's source as a string literal.
  it.each(SWEEP_ALARMS)("$event is still emitted by the broker's team record source", ({ event }) => {
    const files = execFileSync("grep", ["-rlF", `"${event}"`, "packages/broker/src/team-record"], { encoding: "utf8" }).trim().split("\n").filter((line) => line !== "");
    expect(files.length, event).toBeGreaterThan(0);
  });

  it("a lost redelivery pages once: it is counted inside the sweep-problem line, and its own line has no filter or alarm", () => {
    expect(filters.filter(([, resource]) => resource.Properties["FilterPattern"] === '{ $.event = "record.github_redelivery_gone" }')).toHaveLength(0);
    expect(alarms.filter((candidate) => String(candidate["AlarmName"]).includes("RedeliveryGone"))).toHaveLength(0);
    expect(HEALTH_ALARM_SUFFIXES as readonly string[]).not.toContain("TeamRecordRedeliveryGone");
  }, 360_000);

  it("the six alarms are listed for the Health page, as alarms that exist only with the switch on, and there is no other record.* filter", () => {
    for (const { suffix } of SWEEP_ALARMS) {
      expect(HEALTH_ALARM_SUFFIXES, suffix).toContain(suffix);
      expect(HEALTH_ALARM_CONDITIONAL_SUFFIXES as readonly string[], suffix).toContain(suffix);
    }
    expect(filters.filter(([, resource]) => String(resource.Properties["FilterPattern"]).includes('$.event = "record.'))).toHaveLength(SWEEP_ALARMS.length);
  }, 360_000);
});
