// wire-team-record: the scheduler's events and the broker's handler agree. The infrastructure sends `{ source, job }` on an hourly and a nightly schedule through the recovery schedules' role; the
// broker recognises exactly those, runs the named job on the runtime (and does nothing where the record is off), and a run's budget fits inside the broker function's timeout.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { TEAM_RECORD_JOBS, TEAM_RECORD_JOB_SOURCE } from "../../infra/lib/team-record-wiring.js";
import { TEAM_RECORD_JOB_SOURCE as BROKER_SOURCE, isTeamRecordJobEvent, runTeamRecordJob } from "../../packages/broker/src/aws/broker/team-record-wiring.js";
import { JOB_BUDGET_MS } from "../../packages/broker/src/team-record/runtime.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Properties: Record<string, unknown> };
const template = (context: Record<string, unknown>): Template => Template.fromStack(buildAgentXApp(context).node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane")!);

describe("the record's schedules and the broker's handler agree", () => {
  it("uses one event source on both sides, and the broker recognises every job the infrastructure schedules", () => {
    expect(TEAM_RECORD_JOB_SOURCE).toBe(BROKER_SOURCE);
    for (const { job } of TEAM_RECORD_JOBS) expect(isTeamRecordJobEvent({ source: TEAM_RECORD_JOB_SOURCE, job }), job).toBe(true);
  });

  it("runs the named job on the runtime, and answers off without touching anything where the record is off", async () => {
    const ran: string[] = [];
    const teamRecord = { jobs: { run: async (job: string) => { ran.push(job); return { orgs: 1, skippedOrgs: 0, details: {} }; } } };
    for (const { job } of TEAM_RECORD_JOBS) expect(await runTeamRecordJob({ teamRecord: teamRecord as never }, { job })).toMatchObject({ job, summary: { orgs: 1 } });
    expect(ran).toStrictEqual(TEAM_RECORD_JOBS.map(({ job }) => job));
    expect(await runTeamRecordJob({ teamRecord: undefined }, { job: "hourly" })).toStrictEqual({ skipped: true, reason: "off" });
  });

  it("sends each schedule through the same role as the other recovery schedules, to the broker, with a run budget inside the broker's timeout", () => {
    const on = template({ agentxEnv: "staging", agentxCloud: true, agentxTeamRecord: "enabled" });
    const resources = on.toJSON().Resources as Record<string, Resource>;
    const recovery = Object.entries(resources).find(([id, resource]) => id.startsWith("WorkflowMergeRecoverySchedule") && resource.Type === "AWS::Scheduler::Schedule")![1].Properties.Target as { Arn: { "Fn::GetAtt": [string, string] }; RoleArn: unknown };
    const ours = Object.entries(resources).filter(([id, resource]) => id.startsWith("TeamRecord") && resource.Type === "AWS::Scheduler::Schedule");
    expect(ours).toHaveLength(TEAM_RECORD_JOBS.length);
    for (const [, resource] of ours) {
      const target = resource.Properties.Target as { Arn: unknown; RoleArn: unknown };
      expect(target.Arn).toStrictEqual(recovery.Arn);
      expect(target.RoleArn).toStrictEqual(recovery.RoleArn);
    }
    const timeout = resources[recovery.Arn["Fn::GetAtt"][0]]!.Properties.Timeout as number;
    expect(JOB_BUDGET_MS).toBeLessThan(timeout * 1000);
  }, 180_000);
});
