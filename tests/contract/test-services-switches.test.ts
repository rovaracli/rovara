// The three test-services switches at deploy time (TS37): TestServicesEnabled (`tx`), TestAccountsEnabled (`ta`) and ProjectImagesEnabled (`pj`). Each is a control-plane stack parameter, "0" (off) by default, that reaches the broker in its packed settings
// (AGENTX_SETTINGS), never as a Lambda variable of its own, and is on only when the broker reads exactly "1".
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { BROKER_SETTINGS, BROKER_SETTINGS_VARIABLE } from "@agentx/contracts";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { projectImagesEnabled, testAccountsEnabled, testServicesEnabled } from "../../packages/broker/src/test-env/test-services-switch.js";
import { configKey } from "../../packages/cli/src/config/keys.js";
import { OPERATOR_PARAMETERS } from "../../packages/cli/src/deploy/parameters.js";
import { brokerSettingsIn } from "../support/broker-names-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const named = Template.fromStack(new ControlPlaneStack(new App(), "TestServicesSwitchesControlPlane", { naming: environmentNaming("staging") }));
const legacy = Template.fromStack(new ControlPlaneStack(new App(), "TestServicesSwitchesLegacyControlPlane"));
const brokerVariables = (template: Template): Record<string, unknown> => {
  const found = Object.entries(template.findResources("AWS::Lambda::Function") as Record<string, { Properties: { Environment?: { Variables?: Record<string, unknown> } } }>)
    .find(([id]) => /^Broker[0-9A-F]{8}$/.test(id));
  return found?.[1].Properties.Environment?.Variables ?? {};
};

const SWITCHES = [
  { name: "test services", parameter: "TestServicesEnabled", setting: "testServices" as const, code: "tx", variable: "TEST_SERVICES_ENABLED", key: "testServices.enabled", on: testServicesEnabled },
  { name: "test accounts", parameter: "TestAccountsEnabled", setting: "testAccounts" as const, code: "ta", variable: "TEST_ACCOUNTS_ENABLED", key: "testAccounts.enabled", on: testAccountsEnabled },
  { name: "project images", parameter: "ProjectImagesEnabled", setting: "projectImages" as const, code: "pj", variable: "PROJECT_IMAGES_ENABLED", key: "projectImages.enabled", on: projectImagesEnabled },
];

describe.each(SWITCHES)("the $name switch", ({ parameter, setting, code, variable, key, on }) => {
  it("is a stack parameter in a named environment, off by default, only 0 or 1", () => {
    expect((named.toJSON() as { Parameters: Record<string, unknown> }).Parameters[parameter]).toMatchObject({ Type: "String", Default: "0", AllowedValues: ["0", "1"] });
  });

  it("reaches the broker in its packed settings and adds no Lambda variable of its own", () => {
    expect(brokerSettingsIn(brokerVariables(named))[setting]).toEqual({ Ref: parameter });
    expect(brokerVariables(named)).not.toHaveProperty(variable);
    expect(BROKER_SETTINGS[setting]).toEqual({ code, variable });
  });

  it("is on only for exactly 1: unset, 0 and every look-alike are off", () => {
    const hydrated = (value: string): MutableEnvironment => { const env: MutableEnvironment = { [BROKER_SETTINGS_VARIABLE]: `${code}=${value}` }; hydrateBrokerEnvironment(env); return env; };
    expect(hydrated("0")[variable]).toBe("0");
    for (const value of ["", "true", "yes", "on", " 1", "01", "0"]) expect(on({ [variable]: value }), JSON.stringify(value)).toBe(false);
    expect(on({})).toBe(false);
    expect(on(hydrated("0"))).toBe(false);
    expect(on(hydrated("1"))).toBe(true);
  });

  it("is missing from the released (legacy) template, which has neither the parameter nor the setting", () => {
    expect(JSON.stringify(legacy.toJSON())).not.toContain(parameter);
    expect(JSON.stringify(legacy.toJSON())).not.toContain(variable);
  });

  it("is set with `agentx config set`, and an upgrade keeps it", () => {
    const entry = configKey(key);
    expect(entry.target).toEqual({ kind: "stack-parameter", part: "control-plane", parameter });
    expect(entry.defaultValue).toBe("0");
    expect(entry.parse("1")).toBe("1");
    expect(() => entry.parse("true")).toThrow(`${key} must be one of 0, 1; nothing changed`);
    expect(OPERATOR_PARAMETERS["control-plane"]).toContain(parameter);
  });
});

describe("the launch tells a worker's boot whether test services are on", () => {
  const stepsVariables = (template: Template): Record<string, unknown> => {
    const found = Object.entries(template.findResources("AWS::Lambda::Function") as Record<string, { Properties: { Environment?: { Variables?: Record<string, unknown> } } }>)
      .find(([id]) => /^SessionsSteps[0-9A-F]{8}$/.test(id));
    return found?.[1].Properties.Environment?.Variables ?? {};
  };
  it("hands the session steps function the TestServicesEnabled parameter in a named environment (the boot pre-pulls only when it is 1), and the legacy template has no such variable", () => {
    expect(stepsVariables(named)).toMatchObject({ MODEL_PROXY_REQUIRED: "true", TEST_SERVICES_ENABLED: { Ref: "TestServicesEnabled" } });
    expect(stepsVariables(legacy)).not.toHaveProperty("TEST_SERVICES_ENABLED");
  });
});
