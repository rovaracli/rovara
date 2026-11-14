// Plan 4 Task 26 (Review Focus 9): the infrastructure of schedule triggers. A schedule group of its own; a role the scheduler assumes only for that group (EventBridge Scheduler sets
// aws:SourceArn to the group's ARN, so a `schedule/` pattern would never match, and a schedule of another group is refused); the role may invoke the broker function and write the
// dead-letter queue, and nothing else; the queue is encrypted with SQS-managed keys (no KMS permission is needed); the broker may manage the schedules of the group, pass that one
// role to the scheduler, and read and delete the dead letters. A named environment only: the legacy templates gain nothing.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { HEALTH_ALARM_SUFFIXES, chainScheduleQueueName, chainScheduleRoleName } from "@agentx/cloud-contracts";
import { chainScheduleGroupName } from "@rovara-code/contracts";
import { brokerNamesIn } from "../support/broker-names-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource?: unknown; Condition?: unknown; Principal?: unknown };
type Policy = { Properties: { ManagedPolicyName?: string; PolicyDocument: { Statement: Statement[] }; Roles?: Array<{ Ref?: string }> } };
type Resource = { Type: string; Properties: Record<string, unknown> };

const build = (id: string, over: { cloud?: boolean; env?: string | null } = {}) => Template.fromStack(new ControlPlaneStack(new App(), id, {
  ...(over.env === null ? {} : { naming: environmentNaming(over.env ?? "staging") }), ...(over.cloud === true ? { cloud: true } : {}),
}));
const named = build("SchedNamed");
const GROUP = "agentx-staging-chain-triggers";
const resources = (template: Template) => template.toJSON().Resources as Record<string, Resource>;
const byType = (template: Template, type: string) => Object.entries(resources(template)).filter(([, resource]) => resource.Type === type);
const brokerId = Object.keys(named.findResources("AWS::Lambda::Function")).find((id) => /^Broker[0-9A-F]{8}$/.test(id))!;
const joined = (...parts: unknown[]) => ({ "Fn::Join": ["", parts] });
const ARN = (resource: string) => joined("arn:", { Ref: "AWS::Partition" }, ":scheduler:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, `:${resource}`);

const brokerStatements = (template: Template): Array<{ policy: string; statement: Statement }> =>
  (Object.values({ ...template.findResources("AWS::IAM::ManagedPolicy"), ...template.findResources("AWS::IAM::Policy") }) as Policy[])
    .filter((policy) => (policy.Properties.Roles ?? []).some((role) => role.Ref?.startsWith("BrokerServiceRole")))
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement.map((statement) => ({ policy: policy.Properties.ManagedPolicyName ?? "inline", statement })));

describe("the schedule group", () => {
  it("is named by the environment, and is the only group this stack makes", () => {
    expect(chainScheduleGroupName("staging")).toBe(GROUP);
    // The core engine's job schedules have a group of their own (infra/lib/core-engine.ts, held by core-engine-infrastructure.test.ts); this is the chain triggers' one.
    const groups = byType(named, "AWS::Scheduler::ScheduleGroup").filter(([id]) => !id.startsWith("CoreEngineJobs"));
    expect(groups).toHaveLength(1);
    expect(groups[0]![1].Properties).toMatchObject({ Name: GROUP });
    expect(GROUP).not.toMatch(/[—–]/u);
  });

  it("is in a cloud and a self-hosted named environment, and in no legacy template", () => {
    expect(byType(build("SchedCloud", { cloud: true }), "AWS::Scheduler::ScheduleGroup").filter(([id]) => !id.startsWith("CoreEngineJobs"))).toHaveLength(1);
    const legacy = build("SchedLegacy", { env: null });
    for (const type of ["AWS::Scheduler::ScheduleGroup"]) expect(byType(legacy, type)).toEqual([]);
    expect(JSON.stringify(legacy.toJSON())).not.toContain("ChainSchedule");
    expect(JSON.stringify(legacy.toJSON())).not.toContain("chain-triggers");
  });
});

describe("ChainScheduleInvokeRole", () => {
  const [roleId, role] = byType(named, "AWS::IAM::Role").find(([id]) => id.startsWith("ChainScheduleInvokeRole"))!;

  it("is assumed only by the scheduler, for this account and for this group's ARN (not a schedule's)", () => {
    const trust = (role.Properties["AssumeRolePolicyDocument"] as { Statement: Statement[] }).Statement;
    expect(trust).toEqual([{
      Effect: "Allow", Action: "sts:AssumeRole", Principal: { Service: "scheduler.amazonaws.com" },
      Condition: { StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" }, "aws:SourceArn": ARN(`schedule-group/${GROUP}`) } },
    }]);
    expect(JSON.stringify(trust)).not.toContain("schedule/");
    expect(JSON.stringify(trust)).not.toContain("*");
  });

  it("may invoke the broker function and write the dead-letter queue, and nothing else", () => {
    const policies = byType(named, "AWS::IAM::Policy").filter(([, policy]) => ((policy.Properties["Roles"] as Array<{ Ref?: string }>) ?? []).some((entry) => entry.Ref === roleId));
    expect(policies).toHaveLength(1);
    const statements = (policies[0]![1].Properties["PolicyDocument"] as { Statement: Statement[] }).Statement;
    expect(statements).toHaveLength(2);
    const invoke = statements.find((statement) => statement.Action === "lambda:InvokeFunction")!;
    expect(invoke).toEqual({ Effect: "Allow", Action: "lambda:InvokeFunction", Resource: { "Fn::GetAtt": [brokerId, "Arn"] } });
    const send = statements.find((statement) => statement.Action === "sqs:SendMessage")!;
    const queueId = byType(named, "AWS::SQS::Queue").find(([id]) => id.startsWith("ChainScheduleDeadLetters"))![0];
    expect(send).toEqual({ Effect: "Allow", Action: "sqs:SendMessage", Resource: { "Fn::GetAtt": [queueId, "Arn"] } });
    expect(role.Properties["ManagedPolicyArns"]).toBeUndefined();
    expect(role.Properties["Policies"]).toBeUndefined();
    expect(JSON.stringify(statements)).not.toContain("*");
  });
});

describe("ChainScheduleDeadLetters", () => {
  it("keeps messages 14 days and is encrypted with SQS-managed keys, with no KMS key", () => {
    const queues = byType(named, "AWS::SQS::Queue").filter(([id]) => id.startsWith("ChainScheduleDeadLetters"));
    expect(queues).toHaveLength(1);
    expect(queues[0]![1].Properties).toMatchObject({ SqsManagedSseEnabled: true, MessageRetentionPeriod: 14 * 86_400 });
    expect(queues[0]![1].Properties["KmsMasterKeyId"]).toBeUndefined();
  });
});

describe("the broker's grants", () => {
  const statements = brokerStatements(named);
  const sid = (name: string) => statements.filter((entry) => entry.statement.Sid === name);
  const roleId = byType(named, "AWS::IAM::Role").find(([id]) => id.startsWith("ChainScheduleInvokeRole"))![0];
  const queueId = byType(named, "AWS::SQS::Queue").find(([id]) => id.startsWith("ChainScheduleDeadLetters"))![0];

  it("manages the schedules of the group and no other: the four actions on the group's schedules", () => {
    const found = sid("ManageChainSchedules");
    expect(found).toHaveLength(1);
    expect(found[0]!.statement).toEqual({
      Sid: "ManageChainSchedules", Effect: "Allow", Action: ["scheduler:CreateSchedule", "scheduler:UpdateSchedule", "scheduler:DeleteSchedule", "scheduler:GetSchedule"],
      Resource: ARN(`schedule/${GROUP}/*`),
    });
  });

  it("passes the invoke role to the scheduler only", () => {
    const found = sid("PassChainScheduleRole");
    expect(found).toHaveLength(1);
    expect(found[0]!.statement).toEqual({
      Sid: "PassChainScheduleRole", Effect: "Allow", Action: "iam:PassRole", Resource: { "Fn::GetAtt": [roleId, "Arn"] },
      Condition: { StringEquals: { "iam:PassedToService": "scheduler.amazonaws.com" } },
    });
  });

  it("reads, deletes and parks the dead letters of the queue, and records a failed fire in it (Review I-1, M-4): one statement, that one queue", () => {
    const found = sid("UseChainScheduleDeadLetters");
    expect(found).toHaveLength(1);
    expect(found[0]!.statement).toEqual({
      Sid: "UseChainScheduleDeadLetters", Effect: "Allow", Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:SendMessage"], Resource: { "Fn::GetAtt": [queueId, "Arn"] },
    });
    expect(sid("DrainChainScheduleDeadLetters")).toEqual([]);
    const sends = statements.filter((entry) => [entry.statement.Action].flat().includes("sqs:SendMessage") && JSON.stringify(entry.statement.Resource).includes(queueId));
    expect(sends).toHaveLength(1);
  });

  it("alarms the operator when any message has sat in the queue for three periods (Task 27 review I-1): visible plus in-flight, because the age metric stops counting a message received three times", () => {
    const alarms = Object.entries(named.findResources("AWS::CloudWatch::Alarm")).filter(([id]) => id.startsWith("ChainScheduleDeadLettersAlarm"));
    expect(alarms).toHaveLength(1);
    const alarm = alarms[0]![1] as { Properties: Record<string, unknown> };
    expect(alarm.Properties).toMatchObject({
      AlarmName: "agentx-staging-ChainScheduleDeadLetters", Threshold: 0, EvaluationPeriods: 3, DatapointsToAlarm: 3, ComparisonOperator: "GreaterThanThreshold", TreatMissingData: "notBreaching",
    });
    expect(alarm.Properties["MetricName"]).toBeUndefined();
    const metrics = alarm.Properties["Metrics"] as Array<{ Id: string; Expression?: string; ReturnData?: boolean; MetricStat?: { Period: number; Stat: string; Metric: { MetricName: string; Namespace: string; Dimensions: unknown } } }>;
    const stats = metrics.filter((entry) => entry.MetricStat !== undefined);
    expect(stats.map((entry) => entry.MetricStat!.Metric.MetricName).sort()).toEqual(["ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesVisible"]);
    for (const entry of stats) {
      expect(entry.MetricStat).toMatchObject({ Period: 300, Stat: "Maximum", Metric: { Namespace: "AWS/SQS", Dimensions: [{ Name: "QueueName", Value: { "Fn::GetAtt": [queueId, "QueueName"] } }] } });
      expect(entry.ReturnData).toBe(false);
    }
    const expression = metrics.filter((entry) => entry.Expression !== undefined);
    expect(expression).toHaveLength(1);
    for (const entry of stats) expect(expression[0]!.Expression).toContain(entry.Id);
    expect(expression[0]!.Expression).toMatch(/^FILL\(\w+, 0\) \+ FILL\(\w+, 0\)$/);
    expect(JSON.stringify(alarm.Properties)).not.toContain("ApproximateAgeOfOldestMessage");
    expect(alarm.Properties["AlarmActions"]).toHaveLength(1);
    expect(HEALTH_ALARM_SUFFIXES).toContain("ChainScheduleDeadLetters");
    expect(byType(build("SchedLegacy2", { env: null }), "AWS::CloudWatch::Alarm").filter(([id]) => id.startsWith("ChainScheduleDeadLettersAlarm"))).toEqual([]);
  });

  it("grants no other scheduler action, and no PassRole of any other role through these statements", () => {
    const scheduler = statements.filter((entry) => [entry.statement.Action].flat().some((action) => action.startsWith("scheduler:")));
    expect(scheduler.map((entry) => entry.statement.Sid)).toEqual(["ManageChainSchedules"]);
    const pass = statements.filter((entry) => [entry.statement.Action].flat().includes("iam:PassRole"));
    expect(pass.map((entry) => entry.statement.Sid)).toContain("PassChainScheduleRole");
    for (const entry of sid("PassChainScheduleRole")) expect(JSON.stringify(entry.statement.Resource)).not.toContain("*");
  });

  it("falls in the integrations managed policy (the orchestration one has no room), the drain of the queue beside the other sqs grants, and every broker policy stays under the 5,500 characters the M2 guard allows", () => {
    expect(sid("ManageChainSchedules")[0]!.policy).toBe("agentx-staging-broker-integrations");
    expect(sid("PassChainScheduleRole")[0]!.policy).toBe("agentx-staging-broker-integrations");
    expect(sid("UseChainScheduleDeadLetters")[0]!.policy).toBe("agentx-staging-broker-orchestration");
    for (const policy of Object.values(named.findResources("AWS::IAM::ManagedPolicy")) as Policy[]) {
      if (!(policy.Properties.ManagedPolicyName ?? "").startsWith("agentx-staging-broker-")) continue;
      expect(JSON.stringify(policy.Properties.PolicyDocument).length, policy.Properties.ManagedPolicyName).toBeLessThan(5500);
    }
  });
});

describe("what the broker is told", () => {
  const broker = (named.findResources("AWS::Lambda::Function") as Record<string, { Properties: { Environment?: { Variables?: Record<string, unknown> } } }>)[brokerId]!;

  it("gets nothing: the role and the queue have fixed names the broker builds from the environment, so its environment (Lambda's 4 KB) does not grow", () => {
    expect(chainScheduleRoleName("staging")).toBe("agentx-staging-chain-schedule");
    expect(chainScheduleQueueName("staging")).toBe("agentx-staging-chain-schedule-dead-letters");
    const [, role] = byType(named, "AWS::IAM::Role").find(([id]) => id.startsWith("ChainScheduleInvokeRole"))!;
    expect(role.Properties["RoleName"]).toBe("agentx-staging-chain-schedule");
    const [, queue] = byType(named, "AWS::SQS::Queue").find(([id]) => id.startsWith("ChainScheduleDeadLetters"))!;
    expect(queue.Properties["QueueName"]).toBe("agentx-staging-chain-schedule-dead-letters");
    const names = brokerNamesIn(broker.Properties.Environment?.Variables);
    expect(Object.keys(names).filter((key) => key.toLowerCase().includes("chainschedule"))).toEqual([]);
    const variables = broker.Properties.Environment?.Variables ?? {};
    for (const variable of ["CHAIN_SCHEDULE_ROLE_ARN", "CHAIN_SCHEDULE_QUEUE_URL", "CHAIN_SCHEDULE_GROUP"]) expect(variables[variable]).toBeUndefined();
  });

  it("names are the longest an environment of 20 characters can make, and stay within the limits of a role (64) and a queue (80)", () => {
    const longest = "a1234567890123456789";
    expect(chainScheduleRoleName(longest).length).toBeLessThanOrEqual(64);
    expect(chainScheduleQueueName(longest).length).toBeLessThanOrEqual(80);
    expect(chainScheduleGroupName(longest).length).toBeLessThanOrEqual(64);
  });
});
