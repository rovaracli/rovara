// DG-3 at deploy time: the install-wide daily ceiling on Rovara-paid Fix with agent diagnoses. A control-plane stack parameter (LiveFixRovaraPaidDailyCents, in cents, 10000 by default, 0 pauses) reaches the broker in
// its packed settings (AGENTX_SETTINGS, code "fg"), never as a Lambda variable of its own (the broker's environment is near its 4 KB limit). The broker logs the day's spend as a share of the ceiling and a
// CloudWatch alarm fires at 80 percent. The released (legacy) template has none of it.
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  BROKER_SETTINGS, BROKER_SETTINGS_VARIABLE, DIAGNOSIS_ROVARA_PAID_GLOBAL_ALARM_PERCENT, DIAGNOSIS_ROVARA_PAID_GLOBAL_DEFAULT_CENTS, DIAGNOSIS_ROVARA_PAID_GLOBAL_MAX_CENTS, HEALTH_ALARM_SUFFIXES,
} from "@agentx/contracts";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { configKey } from "../../packages/cli/src/config/keys.js";
import { OPERATOR_PARAMETERS } from "../../packages/cli/src/deploy/parameters.js";
import { brokerSettingsIn } from "../support/broker-names-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const named = Template.fromStack(new ControlPlaneStack(new App(), "DiagSpendControlPlane", { naming: environmentNaming("staging") }));
const legacy = Template.fromStack(new ControlPlaneStack(new App(), "DiagSpendLegacyControlPlane"));
const brokerVariables = (template: Template): Record<string, unknown> => {
  const found = Object.entries(template.findResources("AWS::Lambda::Function") as Record<string, { Properties: { Environment?: { Variables?: Record<string, unknown> } } }>)
    .find(([id]) => /^Broker[0-9A-F]{8}$/.test(id));
  return found?.[1].Properties.Environment?.Variables ?? {};
};

describe("the install-wide ceiling in the control plane", () => {
  it("declares LiveFixRovaraPaidDailyCents as a number in a named environment: $100 by default, from 0 (paused) up to the largest the broker accepts", () => {
    expect((named.toJSON() as { Parameters: Record<string, unknown> }).Parameters.LiveFixRovaraPaidDailyCents).toMatchObject({
      Type: "Number", Default: DIAGNOSIS_ROVARA_PAID_GLOBAL_DEFAULT_CENTS, MinValue: 0, MaxValue: DIAGNOSIS_ROVARA_PAID_GLOBAL_MAX_CENTS,
    });
    expect(DIAGNOSIS_ROVARA_PAID_GLOBAL_DEFAULT_CENTS).toBe(10_000);
  });

  it("hands the broker the parameter in its packed settings (code fg) and adds no Lambda variable of its own", () => {
    expect(brokerSettingsIn(brokerVariables(named)).liveFixRovaraPaidCents).toEqual({ Ref: "LiveFixRovaraPaidDailyCents" });
    expect(brokerVariables(named)).not.toHaveProperty("LIVE_FIX_ROVARA_PAID_DAILY_CENTS");
    expect(BROKER_SETTINGS.liveFixRovaraPaidCents).toEqual({ code: "fg", variable: "LIVE_FIX_ROVARA_PAID_DAILY_CENTS" });
    const env: MutableEnvironment = { [BROKER_SETTINGS_VARIABLE]: "fd=1,fg=2500" };
    hydrateBrokerEnvironment(env);
    expect(env["LIVE_FIX_ROVARA_PAID_DAILY_CENTS"]).toBe("2500");
  });

  it("counts the share of the ceiling from the broker's own log line and alarms at 80 percent, telling the operator when it is quiet as not breaching", () => {
    named.hasResourceProperties("AWS::Logs::MetricFilter", {
      FilterPattern: Match.stringLikeRegexp("diagnosis\\.rovara_paid"),
      MetricTransformations: [Match.objectLike({ MetricName: "DiagnosisRovaraPaidGlobalPercent", MetricValue: "$.globalDayPercent" })],
    });
    named.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "agentx-staging-DiagnosisRovaraPaidGlobal80", MetricName: "DiagnosisRovaraPaidGlobalPercent", Statistic: "Maximum", Threshold: 80,
      ComparisonOperator: "GreaterThanOrEqualToThreshold", EvaluationPeriods: 1, TreatMissingData: "notBreaching", AlarmActions: Match.anyValue(),
    });
    expect(DIAGNOSIS_ROVARA_PAID_GLOBAL_ALARM_PERCENT).toBe(80);
    expect(HEALTH_ALARM_SUFFIXES).toContain("DiagnosisRovaraPaidGlobal80");
  });

  it("leaves the released (legacy) template without the parameter, the setting, the filter or the alarm", () => {
    const text = JSON.stringify(legacy.toJSON());
    for (const name of ["LiveFixRovaraPaidDailyCents", "LIVE_FIX_ROVARA_PAID_DAILY_CENTS", "DiagnosisRovaraPaidGlobal"]) expect(text, name).not.toContain(name);
  });

  it("is set with `agentx config set liveFix.rovaraPaidDailyCents <cents>`, and an upgrade keeps it", () => {
    const entry = configKey("liveFix.rovaraPaidDailyCents");
    expect(entry.target).toEqual({ kind: "stack-parameter", part: "control-plane", parameter: "LiveFixRovaraPaidDailyCents" });
    expect(entry.defaultValue).toBe("10000");
    expect(entry.parse("0")).toBe("0");
    expect(entry.parse("2500")).toBe("2500");
    for (const bad of ["-1", "1.5", "abc", String(DIAGNOSIS_ROVARA_PAID_GLOBAL_MAX_CENTS + 1)]) expect(() => entry.parse(bad), bad).toThrow();
    expect(OPERATOR_PARAMETERS["control-plane"]).toContain("LiveFixRovaraPaidDailyCents");
  });
});
