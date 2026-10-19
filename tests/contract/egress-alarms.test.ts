import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { BLOCKED_DNS_ALARM_THRESHOLD, NAT_EGRESS_ALARM_BYTES_PER_HOUR } from "../../infra/lib/egress-alarms.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Properties: Record<string, unknown> };

function foundation(context: Record<string, unknown>): Template {
  const app = buildAgentXApp(context);
  const stack = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXProductionFoundation");
  return Template.fromStack(stack!);
}

const resourcesOf = (template: Template, type: string): Array<[string, Resource]> =>
  Object.entries(template.toJSON().Resources as Record<string, Resource>).filter(([, resource]) => resource.Type === type);

describe("egress alarms (cloud installs)", () => {
  const template = foundation({ agentxEnv: "staging", agentxCloud: true });
  const alarms = resourcesOf(template, "AWS::CloudWatch::Alarm");
  const alarmNamed = (name: string) => alarms.filter(([, alarm]) => alarm.Properties.AlarmName === name);

  it("keeps the binding thresholds", () => {
    expect(BLOCKED_DNS_ALARM_THRESHOLD).toBe(200);
    expect(NAT_EGRESS_ALARM_BYTES_PER_HOUR).toBe(20 * 1024 ** 3);
    expect(NAT_EGRESS_ALARM_BYTES_PER_HOUR).toBe(21474836480);
  });

  it("counts blocked DNS firewall queries from the query log into AgentX/<env>/BlockedDnsQueries", () => {
    const logGroups = resourcesOf(template, "AWS::Logs::LogGroup").filter(([, resource]) => resource.Properties.LogGroupName === "/agentx/staging/dns-firewall");
    expect(logGroups).toHaveLength(1);
    const filters = resourcesOf(template, "AWS::Logs::MetricFilter");
    expect(filters).toHaveLength(1);
    expect(filters[0]![1].Properties).toMatchObject({
      LogGroupName: { Ref: logGroups[0]![0] },
      FilterPattern: '{ $.firewall_rule_action = "BLOCK" }',
      MetricTransformations: [{ MetricNamespace: "AgentX/staging", MetricName: "BlockedDnsQueries", MetricValue: "1", DefaultValue: 0 }],
    });
  });

  it("alarms when blocked lookups reach 200 in 5 minutes", () => {
    const found = alarmNamed("agentx-staging-blocked-dns-spike");
    expect(found).toHaveLength(1);
    expect(found[0]![1].Properties).toMatchObject({
      Namespace: "AgentX/staging",
      MetricName: "BlockedDnsQueries",
      Statistic: "Sum",
      Threshold: 200,
      Period: 300,
      EvaluationPeriods: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      TreatMissingData: "notBreaching",
    });
  });

  it("has one NAT alarm per NAT gateway, at 20 GiB an hour", () => {
    const gateways = resourcesOf(template, "AWS::EC2::NatGateway");
    expect(gateways).toHaveLength(2);
    const natAlarms = alarms.filter(([, alarm]) => alarm.Properties.MetricName === "BytesOutToDestination");
    expect(natAlarms).toHaveLength(gateways.length);
    expect(natAlarms.map(([, alarm]) => alarm.Properties.AlarmName as string).sort()).toStrictEqual([
      "agentx-staging-nat-egress-spike-use1-az1",
      "agentx-staging-nat-egress-spike-use1-az2",
    ]);
    for (const [id] of gateways) {
      const forGateway = natAlarms.filter(([, alarm]) => JSON.stringify(alarm.Properties.Dimensions) === JSON.stringify([{ Name: "NatGatewayId", Value: { Ref: id } }]));
      expect(forGateway).toHaveLength(1);
    }
    for (const [, alarm] of natAlarms) {
      expect(alarm.Properties).toMatchObject({
        Namespace: "AWS/NATGateway",
        Statistic: "Sum",
        Threshold: 21474836480,
        Period: 3600,
        EvaluationPeriods: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        TreatMissingData: "notBreaching",
      });
    }
  });

  it("notifies the install's alerts topic from every alarm", () => {
    expect(alarms).toHaveLength(3);
    for (const [, alarm] of alarms) {
      const actions = JSON.stringify(alarm.Properties.AlarmActions);
      expect(alarm.Properties.AlarmActions).toHaveLength(1);
      expect(actions).toContain(":sns:");
      expect(actions).toContain("agentx-staging-alerts");
    }
  });

  it("describes what to check, without em dashes", () => {
    for (const [, alarm] of alarms) expect(alarm.Properties.AlarmDescription).not.toContain("—");
    expect(alarmNamed("agentx-staging-blocked-dns-spike")[0]![1].Properties.AlarmDescription).toContain("/agentx/staging/dns-firewall");
    for (const [, alarm] of alarms.filter(([, a]) => a.Properties.MetricName === "BytesOutToDestination")) {
      expect(alarm.Properties.AlarmDescription).toMatch(/workspaces were running/);
      expect(alarm.Properties.AlarmDescription).toContain("/agentx/staging/dns-firewall");
    }
  });

  it("adds no alarms or metric filters without agentxCloud, in a named or legacy environment", () => {
    for (const context of [{ agentxEnv: "staging" }, {}]) {
      const plain = foundation(context);
      expect(resourcesOf(plain, "AWS::CloudWatch::Alarm")).toHaveLength(0);
      expect(resourcesOf(plain, "AWS::Logs::MetricFilter")).toHaveLength(0);
    }
  });
});
