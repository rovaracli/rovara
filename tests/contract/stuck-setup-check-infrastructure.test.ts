// Follow-up N4: a project setup check the reconciler's sweep cannot close (its compute will not delete, say) keeps its watch and holds a limit
// slot. The sweep logs it and counts it in ReconcilerStuckSetupChecksKept; this pins the StuckSetupChecks alarm on that metric, in named
// environments only. The legacy templates are proven unchanged by legacy-templates.test.ts.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { HEALTH_ALARM_SUFFIXES } from "../../packages/cloud-contracts/src/admin.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Alarm = { Properties: Record<string, unknown> };

const topicId = (template: Template) => Object.keys(template.findResources("AWS::SNS::Topic")).find((id) => id.startsWith("OperatorAlerts"))!;
const checkAlarms = (template: Template) => Object.entries(template.findResources("AWS::CloudWatch::Alarm") as Record<string, Alarm>)
  .filter(([, alarm]) => JSON.stringify(alarm.Properties).includes("StuckSetupChecks"));

describe("the stuck setup check alarm (follow-up N4)", () => {
  const named = Template.fromStack(new ControlPlaneStack(new App(), "StuckChecksControlPlane", { naming: environmentNaming("staging") }));
  const legacy = Template.fromStack(new ControlPlaneStack(new App(), "StuckChecksLegacyControlPlane"));

  it("alarms the operator when a setup check stays unclosed on two runs in a row", () => {
    const alarms = checkAlarms(named);
    expect(alarms).toHaveLength(1);
    const [id, alarm] = alarms[0]!;
    expect(id).toMatch(/^SessionsStuckSetupChecksAlarm[0-9A-F]{8}$/);
    expect(alarm.Properties).toStrictEqual({
      AlarmActions: [{ Ref: topicId(named) }],
      AlarmDescription: "The reconciler could not close a project setup check that is over 50 minutes old, on two runs in a row; the check still holds a workspace slot. Check the reconciler's logs for stuck_setup_check.close_failed and stuck_setup_check.kept events.",
      AlarmName: "agentx-staging-StuckSetupChecks",
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      EvaluationPeriods: 2,
      MetricName: "ReconcilerStuckSetupChecksKept",
      Namespace: "AgentX/staging",
      Period: 600,
      Statistic: "Maximum",
      Threshold: 1,
      TreatMissingData: "notBreaching",
    });
  });

  it("is listed among the alarms the admin health route reads", () => {
    expect(HEALTH_ALARM_SUFFIXES).toContain("StuckSetupChecks");
  });

  it("adds nothing to the legacy deployment", () => {
    expect(checkAlarms(legacy)).toEqual([]);
  });
});
