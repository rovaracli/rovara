// Owner decision 2026-11-03: Rovara pays for no diagnosis; the company pays, on its own AI provider. This REPLACES DG-3's Rovara-paid design, and these tests pin the removal at deploy time: no stack parameter
// (LiveFixRovaraPaidDailyCents), no packed setting (code `fg`), no metric filter or alarm (DiagnosisRovaraPaidGlobal80), no config key (liveFix.rovaraPaidDailyCents), and an upgrade of a stack that still holds the parameter
// (one deployed from an interim build) sends nothing for it.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it, vi } from "vitest";
import { BROKER_SETTINGS, BROKER_SETTINGS_VARIABLE, HEALTH_ALARM_SUFFIXES } from "@agentx/contracts";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { CONFIG_KEYS, configKey } from "../../packages/cli/src/config/keys.js";
import { keptOperatorParameters } from "../../packages/cli/src/deploy/deploy-environment.js";
import { OPERATOR_PARAMETERS } from "../../packages/cli/src/deploy/parameters.js";
import { brokerSettingsIn } from "../support/broker-names-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const named = Template.fromStack(new ControlPlaneStack(new App(), "DiagCustomerPaysControlPlane", { naming: environmentNaming("staging") }));
const legacy = Template.fromStack(new ControlPlaneStack(new App(), "DiagCustomerPaysLegacyControlPlane"));
const brokerVariables = (template: Template): Record<string, unknown> => {
  const found = Object.entries(template.findResources("AWS::Lambda::Function") as Record<string, { Properties: { Environment?: { Variables?: Record<string, unknown> } } }>)
    .find(([id]) => /^Broker[0-9A-F]{8}$/.test(id));
  return found?.[1].Properties.Environment?.Variables ?? {};
};
const GONE = ["LiveFixRovaraPaidDailyCents", "LIVE_FIX_ROVARA_PAID_DAILY_CENTS", "DiagnosisRovaraPaid", "diagnosis.rovara_paid", "liveFixRovaraPaidCents"];

describe("the Rovara-paid diagnosis ceiling is gone from the control plane", () => {
  it("a named environment declares no LiveFixRovaraPaidDailyCents parameter, no filter or alarm on it, and no mention of it anywhere in the template; the Fix with agent switch is still there", () => {
    const json = named.toJSON() as { Parameters: Record<string, unknown> };
    expect(json.Parameters).not.toHaveProperty("LiveFixRovaraPaidDailyCents");
    expect(json.Parameters).toHaveProperty("LiveFixEnabled");
    const text = JSON.stringify(json);
    for (const name of GONE) expect(text, name).not.toContain(name);
    expect(Object.keys(named.findResources("AWS::CloudWatch::Alarm")).filter((id) => id.startsWith("DiagnosisRovaraPaid"))).toEqual([]);
    expect(Object.keys(named.findResources("AWS::Logs::MetricFilter")).filter((id) => id.includes("DiagnosisRovaraPaid"))).toEqual([]);
  });

  it("hands the broker no packed setting for it (code fg is retired and never reused), and adds no Lambda variable of its own", () => {
    expect(brokerSettingsIn(brokerVariables(named))).not.toHaveProperty("liveFixRovaraPaidCents");
    expect(Object.keys(brokerSettingsIn(brokerVariables(named)))).toContain("liveFix");
    expect(brokerVariables(named)).not.toHaveProperty("LIVE_FIX_ROVARA_PAID_DAILY_CENTS");
    expect(BROKER_SETTINGS).not.toHaveProperty("liveFixRovaraPaidCents");
    expect(Object.values(BROKER_SETTINGS).map((spec) => spec.code)).not.toContain("fg");
    expect(Object.values(BROKER_SETTINGS).map((spec) => spec.variable)).not.toContain("LIVE_FIX_ROVARA_PAID_DAILY_CENTS");
  });

  it("a broker that meets the retired `fg` code in an older stack's settings ignores it: it sets no variable and does not refuse to start", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const env: MutableEnvironment = { [BROKER_SETTINGS_VARIABLE]: "fd=1,fg=2500" };
      expect(() => hydrateBrokerEnvironment(env)).not.toThrow();
      expect(env["LIVE_FIX_ENABLED"]).toBe("1");
      expect(env["LIVE_FIX_ROVARA_PAID_DAILY_CENTS"]).toBeUndefined();
    } finally {
      log.mockRestore();
    }
  });

  it("the health list has no DiagnosisRovaraPaidGlobal80 alarm", () => {
    expect(HEALTH_ALARM_SUFFIXES).not.toContain("DiagnosisRovaraPaidGlobal80");
  });

  it("the released (legacy) template never had any of it", () => {
    const text = JSON.stringify(legacy.toJSON());
    for (const name of GONE) expect(text, name).not.toContain(name);
  });
});

describe("the CLI no longer has the setting, and an upgrade of a stack that still holds the parameter is safe", () => {
  it("`agentx config` has no liveFix.rovaraPaidDailyCents key; the Fix with agent switch stays", () => {
    expect(CONFIG_KEYS.map((entry) => entry.key)).not.toContain("liveFix.rovaraPaidDailyCents");
    expect(() => configKey("liveFix.rovaraPaidDailyCents")).toThrow("unknown config key");
    expect(configKey("liveFix.enabled").target).toEqual({ kind: "stack-parameter", part: "control-plane", parameter: "LiveFixEnabled" });
  });

  it("the parameter is in no operator list, so an upgrade neither keeps nor reports it, and the new template is never sent a parameter it does not declare", () => {
    for (const part of Object.keys(OPERATOR_PARAMETERS) as Array<keyof typeof OPERATOR_PARAMETERS>) expect(OPERATOR_PARAMETERS[part], part).not.toContain("LiveFixRovaraPaidDailyCents");
    // A stack deployed from an interim build holds it; the release's template does not declare it.
    const declared = new Set(["LiveFixEnabled", "BudgetMonthlyUsd"]);
    expect(keptOperatorParameters({ part: "control-plane", computed: {}, deployed: { LiveFixRovaraPaidDailyCents: "5000", LiveFixEnabled: "1", BudgetMonthlyUsd: "250" }, declared }))
      .toEqual({ kept: { LiveFixEnabled: "1", BudgetMonthlyUsd: "250" }, dropped: [] });
    // The cdk engine has no template to read (declared undefined): the parameter is still not among the candidates, so it is not sent either.
    expect(keptOperatorParameters({ part: "control-plane", computed: {}, deployed: { LiveFixRovaraPaidDailyCents: "5000" }, declared: undefined })).toEqual({ kept: {}, dropped: [] });
  });
});
