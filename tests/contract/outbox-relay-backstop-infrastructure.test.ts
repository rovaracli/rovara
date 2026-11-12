// Convergence A2 (no traffic): the outbox relay's backstop schedule exists in a named environment but is DISABLED, on the recovery role, with its exact input;
// the legacy template has none; and the broker answers its event with "not wired" until a composition root installs the relay.
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import "../support/skip-bundling.js";
import { createDeveloperTaskBroker } from "../support/developer-task-broker.js";

type Schedule = { Properties: { State: string; ScheduleExpression: string; FlexibleTimeWindow: unknown; Target: { Input: string; RoleArn: unknown; Arn: unknown; RetryPolicy: unknown } } };
const schedules = (stack: Stack): Schedule[] => Object.values(Template.fromStack(stack).findResources("AWS::Scheduler::Schedule") as Record<string, Schedule>);
const backstops = (stack: Stack) => schedules(stack).filter((schedule) => JSON.stringify(schedule.Properties.Target).includes("agentx.outbox-relay-backstop"));

describe("the outbox relay backstop schedule", () => {
  it("is one DISABLED schedule of a named environment, every minute, on the same role as the dispatch recovery schedule", () => {
    const stack = buildAgentXApp({ agentxEnv: "staging" }).node.children.filter((child): child is Stack => Stack.isStack(child)).find((candidate) => candidate.stackName === "agentx-staging-control-plane")!;
    const [backstop, ...rest] = backstops(stack);
    expect(rest).toHaveLength(0);
    expect(backstop!.Properties).toMatchObject({
      FlexibleTimeWindow: { Mode: "OFF" }, ScheduleExpression: "rate(1 minute)", State: "DISABLED",
      Target: { Input: JSON.stringify({ source: "agentx.outbox-relay-backstop" }), RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 300 } },
    });
    const recovery = schedules(stack).find((schedule) => JSON.stringify(schedule.Properties.Target).includes("agentx.workflow-dispatch-recovery"))!;
    expect(backstop!.Properties.Target.RoleArn).toEqual(recovery.Properties.Target.RoleArn);
    expect(backstop!.Properties.Target.Arn).toEqual(recovery.Properties.Target.Arn);
    // Every other schedule keeps its state: this lane turned nothing on or off.
    expect(schedules(stack).filter((schedule) => schedule !== backstop).every((schedule) => schedule.Properties.State === "ENABLED")).toBe(true);
  }, 240_000);

  it("is not in a legacy (unnamed) environment's template", () => {
    expect(backstops(new ControlPlaneStack(new App(), "LegacyBackstopControlPlane"))).toHaveLength(0);
  });
});

describe("the broker's answer to the backstop event", () => {
  it("is 200 not_wired with no relay installed, and touches nothing in the table", async () => {
    const harness = await createDeveloperTaskBroker();
    let writes = 0;
    const stop = harness.db.onWrite(() => { writes += 1; });
    const response = await harness.handler({ source: "agentx.outbox-relay-backstop" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ skipped: "not_wired" });
    stop();
    expect(writes).toBe(0);
  });
});
