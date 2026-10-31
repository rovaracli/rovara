// Meta repo lane F (F2): the intake poll's tick. Every minute, in a named environment only, through the recovery schedules' role, with the event the broker answers.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { isIntakePollEvent } from "../../packages/broker/src/aws/broker/sweeps-and-readiness.js";

type Schedule = { Type: string; Properties: { ScheduleExpression: string; State: string; FlexibleTimeWindow: unknown; Target: { Arn: unknown; RoleArn: unknown; Input: string; RetryPolicy: unknown } } };
const schedules = (context: Record<string, unknown>): Array<[string, Schedule]> => {
  const stack = buildAgentXApp(context).node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane");
  return Object.entries(Template.fromStack(stack!).toJSON().Resources as Record<string, Schedule>).filter(([, resource]) => resource.Type === "AWS::Scheduler::Schedule");
};

describe("the intake poll schedule", () => {
  it("runs every minute in a named environment, through the recovery schedules' role, with no retries", () => {
    const found = schedules({ agentxEnv: "staging" });
    const poll = found.filter(([id]) => id.startsWith("IntakePollSchedule"));
    expect(poll).toHaveLength(1);
    const [, schedule] = poll[0]!;
    expect(schedule.Properties).toMatchObject({ ScheduleExpression: "rate(1 minute)", State: "ENABLED", FlexibleTimeWindow: { Mode: "OFF" } });
    expect(JSON.parse(schedule.Properties.Target.Input)).toStrictEqual({ source: "agentx.intake-poll" });
    expect(schedule.Properties.Target.RetryPolicy).toStrictEqual({ MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 60 });
    const recovery = found.find(([id]) => id.startsWith("WorkflowMergeRecoverySchedule"))![1];
    expect(schedule.Properties.Target.Arn).toStrictEqual(recovery.Properties.Target.Arn);
    expect(schedule.Properties.Target.RoleArn).toStrictEqual(recovery.Properties.Target.RoleArn);
  }, 120_000);

  it("is not in the legacy template", () => {
    expect(schedules({}).map(([id]) => id).filter((id) => id.startsWith("IntakePoll"))).toStrictEqual([]);
  }, 120_000);

  it("is the event the broker answers, and an API request can never pass for it", () => {
    expect(isIntakePollEvent({ source: "agentx.intake-poll" })).toBe(true);
    expect(isIntakePollEvent({ source: "agentx.intake-poll", requestContext: { http: { method: "POST" } } })).toBe(false);
    expect(isIntakePollEvent({ source: "agentx.chain-sweep" })).toBe(false);
    expect(isIntakePollEvent(null)).toBe(false);
  });
});
