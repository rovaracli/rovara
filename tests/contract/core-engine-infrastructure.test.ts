// The core engine switch's deployment half (0.5.19; DEFERRED S0-CC-INFRA-UNWIRED, A4-SWITCH-ON-PRECONDITIONS M2, S3-ENTRY-NEEDS; DEC 176 for the repositories), on the synthesised templates.
// What must hold:
//   1. the `cc` setting: a stack parameter CoreEngine, off by default, plain text only, packed into the broker's settings, a plain variable on the Slack ingress (which does not unpack settings), kept by an upgrade;
//   2. the core dispatch queue: its own queue and dead letters, a redrive limit of at least 21 (the core retries 20 times), Cloud's own dispatch queue unchanged at 5, and nobody but the broker granted;
//   3. the job schedules: one per scheduled row of the core's job table, enabled only while `cc` is not off, through a role that can invoke the broker and nothing else;
//   4. the four revision 7 catalog repositories: immutable tags, scan on push, KMS, a lifecycle policy, retained;
//   5. no new deploy-role action: everything CloudFormation needs for these resource types is already allowed by the deploy role AND by its permissions boundary.
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { BROKER_SETTINGS, BROKER_SETTINGS_VARIABLE, CORE_DISPATCH_ATTEMPTS_MAX, CORE_DISPATCH_MAX_RECEIVES, CORE_ENGINE_PARAMETER_PATTERN, CORE_JOB_EVENT_SOURCE, CORE_JOB_SCHEDULES, DERIVED_BROKER_VARIABLES, coreDispatchDeadLetterName, coreDispatchQueueName } from "@agentx/cloud-contracts";
import { SERVICE_CATALOG_REPOSITORIES, catalogRepositories, catalogRepositoryName } from "@rovara-code/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { REVISION_7_CATALOG_REPOSITORIES, installCatalogRepositories, serviceCatalogLifecyclePolicy } from "../../infra/lib/service-catalog-images.js";
import { defaultBoundaryArn, deployRoleBoundaryStatements, serviceRoleStatements, defaultBoundaryStatements } from "../../infra/lib/access-policies.js";
import { hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { CORE_JOBS } from "../../packages/broker/src/cloud/app/jobs.js";
import { parseCoreSwitch, readCoreEngineFlags } from "../../packages/broker/src/cloud/app/flags.js";
import { configKey } from "../../packages/cli/src/config/keys.js";
import { OPERATOR_PARAMETERS } from "../../packages/cli/src/deploy/parameters.js";
import { shippedCatalog } from "../support/catalog-pinning.js";
import { simulateIam, type IamStatement } from "../support/iam-simulate.js";
import { brokerSettingsIn } from "../support/broker-names-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Condition?: string; DeletionPolicy?: string; UpdateReplacePolicy?: string; Properties: Record<string, unknown> };
type Json = { Parameters: Record<string, { Default?: string; AllowedPattern?: string; MaxLength?: number }>; Conditions?: Record<string, unknown>; Resources: Record<string, Resource> };

const named = Template.fromStack(new ControlPlaneStack(new App(), "CoreEngineControlPlane", { naming: environmentNaming("staging") }));
const legacy = Template.fromStack(new ControlPlaneStack(new App(), "CoreEngineLegacyControlPlane"));
const json = named.toJSON() as Json;
// The role path, the permissions boundary and the retention policies are put on by the app's aspects, so those facts are read from the app's own control plane stack.
const appControlPlane = (): Json => {
  const app = buildAgentXApp({ agentxEnv: "staging", agentxCloud: true });
  const stack = app.node.children.filter((child): child is Stack => Stack.isStack(child)).find((candidate) => /control-plane/iu.test(candidate.stackName))!;
  return Template.fromStack(stack).toJSON() as Json;
};
const inApp = appControlPlane();
const resources = (template: Template, type: string): Array<[string, Resource]> => Object.entries((template.toJSON() as Json).Resources).filter(([, resource]) => resource.Type === type);
const functionVariables = (template: Template, idPattern: RegExp): Record<string, unknown> =>
  (resources(template, "AWS::Lambda::Function").find(([id]) => idPattern.test(id))?.[1].Properties.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables ?? {};
const brokerVariables = (template: Template): Record<string, unknown> => functionVariables(template, /^Broker[0-9A-F]{8}$/);
const ingressVariables = (template: Template): Record<string, unknown> => functionVariables(template, /^SlackIngress[0-9A-F]{8}$/);

const ORG_A = `org_${"a1".repeat(10)}`;
const ORG_B = `org_${"z9".repeat(10)}`;

describe("the cc setting (stack parameter CoreEngine)", () => {
  const parameter = json.Parameters.CoreEngine!;

  it("is a stack parameter in a named environment: off by default, at most 64 characters", () => {
    expect(parameter).toMatchObject({ Default: "off", MaxLength: 64, AllowedPattern: CORE_ENGINE_PARAMETER_PATTERN });
  });

  it("takes off, on, or one or two company ids, and nothing that could carry a separator", () => {
    const allowed = new RegExp(parameter.AllowedPattern!);
    for (const value of ["off", "on", `on:${ORG_A}`, `on:${ORG_A}:${ORG_B}`]) expect(allowed.test(value), value).toBe(true);
    for (const value of ["", "OFF", "On", "0", "1", "true", "on:", "on:org_x", `on:${ORG_A}:`, `on:${ORG_A}:${ORG_B}:${ORG_A}`, `on:${ORG_A},${ORG_B}`, `on:${ORG_A}=1`, `on: ${ORG_A}`, `on:${ORG_A.toUpperCase()}`, `on:${ORG_A}/x`, `off\n`, `on:${ORG_A}"`, "on:org_" + "a".repeat(21)]) {
      expect(allowed.test(value), JSON.stringify(value)).toBe(false);
    }
    // The longest value still fits a packed setting (64 characters, BROKER_SETTING_VALUE).
    expect(`on:${ORG_A}:${ORG_B}`.length).toBeLessThanOrEqual(64);
  });

  it("is read by the broker's own parser as the value it names: every value the parameter takes is a clean switch, never a reported problem", () => {
    for (const value of ["off", "on", `on:${ORG_A}`, `on:${ORG_A}:${ORG_B}`]) {
      const hydrated: MutableEnvironment = { [BROKER_SETTINGS_VARIABLE]: `cc=${value}` };
      hydrateBrokerEnvironment(hydrated);
      expect(hydrated.CLOUD_CORE_ENGINE).toBe(value);
      expect(parseCoreSwitch(value).problem, value).toBeUndefined();
      expect(readCoreEngineFlags(hydrated).problems).toEqual([]);
    }
    expect(readCoreEngineFlags({ CLOUD_CORE_ENGINE: "on" }).combined).toEqual({ mode: "on" });
    expect(readCoreEngineFlags({ CLOUD_CORE_ENGINE: `on:${ORG_A}:${ORG_B}` }).combined).toEqual({ mode: "on-for", companies: [ORG_A, ORG_B] });
  });

  it("reaches the broker in its packed settings and adds no Lambda variable of its own to the broker", () => {
    expect(brokerSettingsIn(brokerVariables(named)).coreEngine).toEqual({ Ref: "CoreEngine" });
    expect(brokerVariables(named)).not.toHaveProperty("CLOUD_CORE_ENGINE");
    expect(BROKER_SETTINGS.coreEngine).toEqual({ code: "cc", variable: "CLOUD_CORE_ENGINE" });
  });

  it("reaches the Slack ingress as a plain variable (the ingress reads it itself and does not unpack settings)", () => {
    expect(ingressVariables(named).CLOUD_CORE_ENGINE).toEqual({ Ref: "CoreEngine" });
    expect(ingressVariables(named)).not.toHaveProperty(BROKER_SETTINGS_VARIABLE);
  });

  it("is missing from the released (legacy) template, which has no parameter, queue, schedule or repository for it", () => {
    const text = JSON.stringify(legacy.toJSON());
    for (const word of ["CoreEngine", "CLOUD_CORE_ENGINE", "core-dispatch", CORE_JOB_EVENT_SOURCE, "rovara-catalog"]) expect(text, word).not.toContain(word);
  });

  it("is set with `agentx config set coreEngine.switch`, refused before anything changes when it is not a clean value, and an upgrade keeps it", () => {
    const entry = configKey("coreEngine.switch");
    expect(entry.target).toEqual({ kind: "stack-parameter", part: "control-plane", parameter: "CoreEngine" });
    expect(entry.defaultValue).toBe("off");
    for (const value of ["off", "on", `on:${ORG_A}`, `on:${ORG_A}:${ORG_B}`]) expect(entry.parse(value)).toBe(value);
    expect(entry.parse(" on ")).toBe("on");
    for (const value of ["", "1", "true", "on:", `on:${ORG_A},${ORG_B}`, `on:${ORG_A}:${ORG_B}:${ORG_A}`]) expect(() => entry.parse(value), value).toThrow("coreEngine.switch must be off, on, or on:<company id>");
    expect(OPERATOR_PARAMETERS["control-plane"]).toContain("CoreEngine");
  });
});

describe("the core dispatch queue", () => {
  const queues = resources(named, "AWS::SQS::Queue");
  const byName = (name: string) => queues.find(([, resource]) => resource.Properties.QueueName === name);
  const queue = byName(coreDispatchQueueName("staging"));
  const deadLetters = byName(coreDispatchDeadLetterName("staging"));

  it("is a queue of its own with fixed names the broker derives, plus dead letters", () => {
    expect(queue).toBeDefined();
    expect(deadLetters).toBeDefined();
    expect(coreDispatchQueueName("staging")).toBe("agentx-staging-core-dispatch");
    expect(coreDispatchDeadLetterName("staging")).toBe("agentx-staging-core-dispatch-dead");
    expect(queues.filter(([, resource]) => /core-dispatch/u.test(String(resource.Properties.QueueName)))).toHaveLength(2);
  });

  it("redrives to its dead letters only after at least 21 receives: above the core's 20 attempts", () => {
    expect(CORE_DISPATCH_ATTEMPTS_MAX).toBe(20);
    expect(CORE_DISPATCH_MAX_RECEIVES).toBeGreaterThanOrEqual(CORE_DISPATCH_ATTEMPTS_MAX + 1);
    const policy = queue![1].Properties.RedrivePolicy as { maxReceiveCount: number; deadLetterTargetArn: { "Fn::GetAtt": [string, string] } };
    expect(policy.maxReceiveCount).toBe(CORE_DISPATCH_MAX_RECEIVES);
    expect(policy.maxReceiveCount).toBeGreaterThanOrEqual(21);
    expect(policy.deadLetterTargetArn["Fn::GetAtt"]).toEqual([deadLetters![0], "Arn"]);
    expect(deadLetters![1].Properties).not.toHaveProperty("RedrivePolicy");
  });

  it("is encrypted with SQS-managed keys, holds a message two minutes while a step starts, and keeps dead letters 14 days", () => {
    expect(queue![1].Properties).toMatchObject({ SqsManagedSseEnabled: true, VisibilityTimeout: 120 });
    expect(deadLetters![1].Properties).toMatchObject({ SqsManagedSseEnabled: true, MessageRetentionPeriod: 14 * 24 * 60 * 60 });
  });

  it("leaves Cloud's own dispatch queue as it was: five receives, its own dead letters (positive control: this one is the one with the lower limit)", () => {
    const cloud = queues.find(([id]) => id.startsWith("DispatchQueue"));
    expect((cloud![1].Properties.RedrivePolicy as { maxReceiveCount: number }).maxReceiveCount).toBe(5);
    expect(cloud![0]).not.toBe(queue![0]);
  });

  it("is built by the broker from the environment's name: both URLs are derived, none is passed", () => {
    const derived = DERIVED_BROKER_VARIABLES.filter((entry) => entry.variable.startsWith("CORE_DISPATCH_"));
    expect(derived.map((entry) => entry.variable).sort()).toEqual(["CORE_DISPATCH_DEAD_LETTER_URL", "CORE_DISPATCH_QUEUE_URL"]);
    const hydrated: MutableEnvironment = { AGENTX_ENV: "staging", AGENTX_NAMES: "{}", AWS_REGION: "us-west-2", AGENTX_ACCOUNT_ID: "123456789012" };
    hydrateBrokerEnvironment(hydrated);
    expect(hydrated.CORE_DISPATCH_QUEUE_URL).toBe("https://sqs.us-west-2.amazonaws.com/123456789012/agentx-staging-core-dispatch");
    expect(hydrated.CORE_DISPATCH_DEAD_LETTER_URL).toBe("https://sqs.us-west-2.amazonaws.com/123456789012/agentx-staging-core-dispatch-dead");
    expect(brokerVariables(named)).not.toHaveProperty("CORE_DISPATCH_QUEUE_URL");
  });

  it("is used by the broker alone, on exactly these two queues; no event source mapping reads it (the dispatcher's core host is not wired yet)", () => {
    const grants = policyStatements(json).filter((statement) => list(statement.Action).includes("sqs:ChangeMessageVisibility") && JSON.stringify(statement.Resource).includes(queue![0]));
    expect(grants).toHaveLength(1);
    expect(list(grants[0]!.Action).sort()).toEqual(["sqs:ChangeMessageVisibility", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ReceiveMessage", "sqs:SendMessage"]);
    expect(grants[0]!.Resource).toEqual([{ "Fn::GetAtt": [queue![0], "Arn"] }, { "Fn::GetAtt": [deadLetters![0], "Arn"] }]);
    // Nothing else names either queue: not the dispatcher, not the publisher, no event source mapping.
    const naming = (statement: IamStatement) => JSON.stringify(statement.Resource).includes(queue![0]) || JSON.stringify(statement.Resource).includes(deadLetters![0]);
    expect(policyStatements(json).filter(naming)).toHaveLength(1);
    for (const [, mapping] of resources(named, "AWS::Lambda::EventSourceMapping")) {
      expect(JSON.stringify(mapping.Properties.EventSourceArn)).not.toContain(queue![0]);
      expect(JSON.stringify(mapping.Properties.EventSourceArn)).not.toContain(deadLetters![0]);
    }
  });

  it("has an alarm on its dead letters, which tells the operator", () => {
    const alarm = resources(named, "AWS::CloudWatch::Alarm").find(([id]) => id.includes("CoreEngine") && id.includes("DeadLettersAlarm"));
    expect(alarm).toBeDefined();
    expect(alarm![1].Properties).toMatchObject({ MetricName: "ApproximateNumberOfMessagesVisible", Namespace: "AWS/SQS", Threshold: 1, ComparisonOperator: "GreaterThanOrEqualToThreshold", TreatMissingData: "notBreaching" });
    expect(JSON.stringify(alarm![1].Properties.Dimensions)).toContain(deadLetters![0]);
    expect(JSON.stringify(alarm![1].Properties.AlarmName)).toContain("CoreDispatchDeadLetters");
    expect(list(alarm![1].Properties.AlarmActions)).toHaveLength(1);
  });
});

describe("the core job schedules", () => {
  const schedules = resources(named, "AWS::Scheduler::Schedule").filter(([id]) => id.includes("CoreEngine"));
  const group = resources(named, "AWS::Scheduler::ScheduleGroup").find(([id]) => id.includes("CoreEngine"));
  const role = resources(named, "AWS::IAM::Role").find(([id]) => id.includes("CoreEngine") && id.includes("InvokeRole"));
  const broker = resources(named, "AWS::Lambda::Function").find(([id]) => /^Broker[0-9A-F]{8}$/.test(id))!;

  it("are one per scheduled row of the core's job table, with its rate, and the stream row has none", () => {
    expect(CORE_JOB_SCHEDULES.length).toBe(CORE_JOBS.filter((job) => job.trigger.kind === "schedule").length);
    for (const job of CORE_JOBS) {
      const scheduled = CORE_JOB_SCHEDULES.find((entry) => entry.job === job.name);
      if (job.trigger.kind === "schedule") expect(scheduled, job.name).toEqual({ job: job.name, rate: job.trigger.rate });
      else expect(scheduled, job.name).toBeUndefined();
    }
    expect(schedules).toHaveLength(CORE_JOB_SCHEDULES.length);
    expect(schedules.map(([, resource]) => (JSON.parse(String((resource.Properties.Target as { Input: string }).Input)) as { job: string }).job).sort()).toEqual(CORE_JOB_SCHEDULES.map((entry) => entry.job).sort());
  });

  it("send the event the broker's job entry reads: `{ source: agentx.core-job, job }`, to the broker, through the schedules' role", () => {
    expect(CORE_JOB_EVENT_SOURCE).toBe("agentx.core-job");
    for (const [, schedule] of schedules) {
      const target = schedule.Properties.Target as { Arn: unknown; RoleArn: unknown; Input: string; RetryPolicy: Record<string, number> };
      const event = JSON.parse(target.Input) as { source: string; job: string };
      expect(event.source).toBe("agentx.core-job");
      expect(Object.keys(event).sort()).toEqual(["job", "source"]);
      expect(CORE_JOB_SCHEDULES.some((entry) => entry.job === event.job && entry.rate === schedule.Properties.ScheduleExpression)).toBe(true);
      expect(target.Arn).toEqual({ "Fn::GetAtt": [broker[0], "Arn"] });
      expect(target.RoleArn).toEqual({ "Fn::GetAtt": [role![0], "Arn"] });
      expect(schedule.Properties.FlexibleTimeWindow).toEqual({ Mode: "OFF" });
      expect(schedule.Properties.GroupName).toEqual({ Ref: group![0] });
      expect(target.RetryPolicy).toEqual({ MaximumRetryAttempts: 1, MaximumEventAgeInSeconds: 120 });
    }
  });

  it("run only while cc is not off: the state is a condition on the parameter, and the resources are always there", () => {
    const conditions = json.Conditions as Record<string, unknown>;
    const conditionId = Object.keys(conditions).find((id) => id.includes("CoreEngineIsOn"))!;
    expect(conditions[conditionId]).toEqual({ "Fn::Not": [{ "Fn::Equals": [{ Ref: "CoreEngine" }, "off"] }] });
    for (const [id, schedule] of schedules) {
      expect(schedule.Properties.State, id).toEqual({ "Fn::If": [conditionId, "ENABLED", "DISABLED"] });
      expect(schedule.Condition, id).toBeUndefined();
    }
    expect(group![1].Condition).toBeUndefined();
  });

  it("use a role that only the scheduler can assume, for this group, that can invoke the broker and nothing else", () => {
    const trust = (role![1].Properties.AssumeRolePolicyDocument as { Statement: Array<{ Principal: { Service: string }; Condition: { StringEquals: Record<string, unknown> } }> }).Statement;
    expect(trust).toHaveLength(1);
    expect(trust[0]!.Principal).toEqual({ Service: "scheduler.amazonaws.com" });
    expect(trust[0]!.Condition.StringEquals["aws:SourceArn"]).toEqual({ "Fn::GetAtt": [group![0], "Arn"] });
    expect(trust[0]!.Condition.StringEquals).toHaveProperty("aws:SourceAccount");
    const policies = resources(named, "AWS::IAM::Policy").filter(([, policy]) => ((policy.Properties.Roles ?? []) as unknown[]).some((ref) => (ref as { Ref?: string }).Ref === role![0]));
    const statements = policies.flatMap(([, policy]) => (policy.Properties.PolicyDocument as { Statement: IamStatement[] }).Statement);
    expect(statements).toEqual([{ Effect: "Allow", Action: "lambda:InvokeFunction", Resource: { "Fn::GetAtt": [broker[0], "Arn"] } }]);
  });

  it("make a role with a generated name under the environment's path and a permissions boundary: no fixed-name role, so no new line in either boundary", () => {
    const inAppRole = Object.entries(inApp.Resources).find(([id, resource]) => resource.Type === "AWS::IAM::Role" && id.includes("CoreEngineJobs") && id.includes("InvokeRole"))![1];
    expect(inAppRole.Properties).not.toHaveProperty("RoleName");
    expect(inAppRole.Properties.Path).toBe("/agentx/staging/");
    expect(inAppRole.Properties.PermissionsBoundary).toBeDefined();
    expect(group![1].Properties ?? {}).not.toHaveProperty("Name");
  });
});

describe("the revision 7 catalog repositories (DEC 176)", () => {
  const FOUR = ["svc/function-agent", "svc/lambda-nodejs", "svc/lambda-python", "svc/model-stand-in"];
  const repositories = resources(named, "AWS::ECR::Repository");
  const nameOf = (resource: Resource) => String(resource.Properties.RepositoryName);

  it("are four, named rovara-catalog/<env>/svc/<name>, and none of the vendored list's nine is lost", () => {
    expect(REVISION_7_CATALOG_REPOSITORIES).toEqual(FOUR);
    expect(installCatalogRepositories()).toEqual([...new Set([...SERVICE_CATALOG_REPOSITORIES, ...FOUR])].sort());
    expect(repositories).toHaveLength(SERVICE_CATALOG_REPOSITORIES.length + 4);
    for (const name of FOUR) expect(repositories.map(([, resource]) => nameOf(resource))).toContain(catalogRepositoryName("staging", name));
    for (const name of SERVICE_CATALOG_REPOSITORIES) expect(repositories.map(([, resource]) => nameOf(resource))).toContain(catalogRepositoryName("staging", name));
    expect(FOUR.filter((name) => SERVICE_CATALOG_REPOSITORIES.includes(name))).toEqual([]);
  });

  it("are the repositories the revision 7 catalog's images name, once it is the shipped catalog (and cover the shipped one now)", () => {
    const shipped = shippedCatalog();
    expect(installCatalogRepositories()).toEqual(expect.arrayContaining(catalogRepositories(shipped)));
    // The revision 7 input (branch feat/0519-catalog-rev7): model-stand-in@r1, function-agent@r1, lambda-python@3.12 and 3.13, lambda-nodejs@22 and 24. A family shares one repository.
    if (shipped.revision >= 7) expect(installCatalogRepositories()).toEqual(catalogRepositories(shipped));
  });

  it("have immutable tags, scan on push, KMS encryption with the one catalog key, and the catalog lifecycle policy", () => {
    const keys = resources(named, "AWS::KMS::Key").filter(([id]) => id.includes("ServiceCatalogImages"));
    expect(keys).toHaveLength(1);
    for (const name of FOUR) {
      const [, repository] = repositories.find(([, resource]) => nameOf(resource) === catalogRepositoryName("staging", name))!;
      expect(repository.Properties).toMatchObject({ ImageTagMutability: "IMMUTABLE", ImageScanningConfiguration: { ScanOnPush: true }, EncryptionConfiguration: { EncryptionType: "KMS", KmsKey: { "Fn::GetAtt": [keys[0]![0], "Arn"] } } });
      expect(JSON.parse((repository.Properties.LifecyclePolicy as { LifecyclePolicyText: string }).LifecyclePolicyText)).toEqual(serviceCatalogLifecyclePolicy());
      expect(repository.Condition, name).toBeUndefined();
      const inAppRepository = Object.values(inApp.Resources).find((resource) => resource.Type === "AWS::ECR::Repository" && resource.Properties.RepositoryName === repository.Properties.RepositoryName)!;
      expect(inAppRepository.DeletionPolicy).toBe("RetainExceptOnCreate");
      expect(inAppRepository.UpdateReplacePolicy).toBe("Retain");
    }
  });

  it("grant no role anything: a worker's pull grant comes with the wiring that uses them (nothing on rovara-catalog in any policy)", () => {
    expect(JSON.stringify(policyStatements(json))).not.toContain("rovara-catalog");
  });
});

describe("no new deploy-role action: the deploy role and its permissions boundary already allow all that these resources need", () => {
  const scope = { env: "staging", partition: "aws", account: "123456789012", region: "us-west-2" };
  const service = serviceRoleStatements(scope as never) as IamStatement[];
  const boundary = deployRoleBoundaryStatements(scope as never) as IamStatement[];
  const repository = (name: string) => `arn:aws:ecr:us-west-2:123456789012:repository/${catalogRepositoryName("staging", name)}`;
  const queue = (name: string) => `arn:aws:sqs:us-west-2:123456789012:${name}`;
  const NEEDED: Array<{ action: string; resource: string; context?: Record<string, string> }> = [
    // AWS::ECR::Repository, the four new repositories (create with a lifecycle policy, scan on push, KMS; update; delete; tag).
    ...REVISION_7_CATALOG_REPOSITORIES.flatMap((name) => ["ecr:CreateRepository", "ecr:PutLifecyclePolicy", "ecr:GetLifecyclePolicy", "ecr:DeleteLifecyclePolicy", "ecr:PutImageScanningConfiguration", "ecr:PutImageTagMutability", "ecr:DescribeRepositories", "ecr:TagResource", "ecr:UntagResource", "ecr:ListTagsForResource", "ecr:DeleteRepository"].map((action) => ({ action, resource: repository(name) }))),
    // AWS::SQS::Queue, the core dispatch queue and its dead letters.
    ...[coreDispatchQueueName("staging"), coreDispatchDeadLetterName("staging")].flatMap((name) => ["sqs:CreateQueue", "sqs:SetQueueAttributes", "sqs:GetQueueAttributes", "sqs:TagQueue", "sqs:UntagQueue", "sqs:ListQueueTags", "sqs:DeleteQueue"].map((action) => ({ action, resource: queue(name) }))),
    // AWS::Scheduler::ScheduleGroup and AWS::Scheduler::Schedule.
    ...["scheduler:CreateScheduleGroup", "scheduler:GetScheduleGroup", "scheduler:DeleteScheduleGroup", "scheduler:TagResource", "scheduler:CreateSchedule", "scheduler:GetSchedule", "scheduler:UpdateSchedule", "scheduler:DeleteSchedule"].map((action) => ({ action, resource: "arn:aws:scheduler:us-west-2:123456789012:schedule/group/schedule" })),
    // AWS::CloudWatch::Alarm.
    ...["cloudwatch:PutMetricAlarm", "cloudwatch:DescribeAlarms", "cloudwatch:DeleteAlarms", "cloudwatch:TagResource"].map((action) => ({ action, resource: "arn:aws:cloudwatch:us-west-2:123456789012:alarm:agentx-staging-CoreDispatchDeadLetters" })),
    // AWS::IAM::Role under the environment's path (the schedules' role), its policy, and passing it to the scheduler.
    ...["iam:CreateRole", "iam:PutRolePolicy", "iam:GetRole", "iam:DeleteRolePolicy", "iam:DeleteRole", "iam:TagRole"].map((action) => ({ action, resource: "arn:aws:iam::123456789012:role/agentx/staging/CoreEngineInvokeRole-ABC", context: { "iam:PermissionsBoundary": defaultBoundaryArn(scope) } })),
    { action: "iam:PassRole", resource: "arn:aws:iam::123456789012:role/agentx/staging/CoreEngineInvokeRole-ABC", context: { "iam:PassedToService": "scheduler.amazonaws.com" } },
    // The catalog key is the one that exists; the repositories' creation asks KMS through ECR, as for the nine existing repositories.
    { action: "kms:CreateGrant", resource: "arn:aws:kms:us-west-2:123456789012:key/11111111-2222-3333-4444-555555555555", context: { "kms:ViaService": "ecr.us-west-2.amazonaws.com", "kms:GrantIsForAWSResource": "true" } },
    { action: "kms:DescribeKey", resource: "arn:aws:kms:us-west-2:123456789012:key/11111111-2222-3333-4444-555555555555", context: { "kms:ViaService": "ecr.us-west-2.amazonaws.com" } },
  ];

  it("the deploy role allows each action CloudFormation needs for the new resource types", () => {
    const refused = NEEDED.filter((request) => !simulateIam(service, request).allowed).map((request) => `${request.action} on ${request.resource}`);
    expect(refused).toEqual([]);
  });

  it("the deploy role's permissions boundary allows each of them too (a grant the boundary does not allow is an implicit deny at install)", () => {
    const refused = NEEDED.filter((request) => !simulateIam(boundary, request).allowed).map((request) => `${request.action} on ${request.resource}`);
    expect(refused).toEqual([]);
  });

  it("the default boundary, the ceiling of the schedules' role, allows what that role does (invoke the broker) and not more than the role holds", () => {
    const ceiling = defaultBoundaryStatements(scope as never) as IamStatement[];
    expect(simulateIam(ceiling, { action: "lambda:InvokeFunction", resource: "arn:aws:lambda:us-west-2:123456789012:function:agentx-staging-Broker" }).allowed).toBe(true);
  });

  it("positive control: the check refuses an action outside both (a new user, a certificate) so a pass above means something", () => {
    for (const request of [{ action: "iam:CreateUser", resource: "arn:aws:iam::123456789012:user/x" }, { action: "ecr:CreateRepository", resource: repository("svc/model-stand-in"), context: {} }]) {
      expect(simulateIam([], request).allowed).toBe(false);
    }
    expect(simulateIam(boundary, { action: "iam:CreateUser", resource: "arn:aws:iam::123456789012:user/x" }).allowed).toBe(false);
    expect(simulateIam(service, { action: "iam:CreateUser", resource: "arn:aws:iam::123456789012:user/x" }).allowed).toBe(false);
  });
});

describe("the named template as a whole", () => {
  it("carries no em dash in any name or description", () => {
    expect(JSON.stringify(json)).not.toContain("—");
  });
});

function list(value: unknown): string[] {
  return value === undefined ? [] : [value].flat().map(String);
}

/** Every statement of every IAM policy and managed policy in the template. */
function policyStatements(template: Json): IamStatement[] {
  return Object.values(template.Resources)
    .filter((resource) => resource.Type === "AWS::IAM::Policy" || resource.Type === "AWS::IAM::ManagedPolicy")
    .flatMap((resource) => ((resource.Properties.PolicyDocument as { Statement: IamStatement[] }).Statement));
}
