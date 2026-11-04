// The design review switch at deploy time: DesignReviewEnabled (`dr`), the environment's master switch, and the retired project list DesignReviewProjects (`dp`, kept one more release, decides nothing). It is a control-plane stack parameter, "0" (off) by default, that reaches the broker in its packed settings
// (AGENTX_SETTINGS), never as a Lambda variable of its own, and is on only when the broker reads exactly "1".
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { BROKER_SETTINGS, BROKER_SETTINGS_VARIABLE } from "@agentx/contracts";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { designReviewEnabled } from "../../packages/broker/src/design-review/switch.js";
import { configKey } from "../../packages/cli/src/config/keys.js";
import { OPERATOR_PARAMETERS } from "../../packages/cli/src/deploy/parameters.js";
import { brokerSettingsIn } from "../support/broker-names-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const named = Template.fromStack(new ControlPlaneStack(new App(), "SavedEnvSwitchControlPlane", { naming: environmentNaming("staging") }));
const legacy = Template.fromStack(new ControlPlaneStack(new App(), "SavedEnvSwitchLegacyControlPlane"));
const brokerVariables = (template: Template): Record<string, unknown> => {
  const found = Object.entries(template.findResources("AWS::Lambda::Function") as Record<string, { Properties: { Environment?: { Variables?: Record<string, unknown> } } }>)
    .find(([id]) => /^Broker[0-9A-F]{8}$/.test(id));
  return found?.[1].Properties.Environment?.Variables ?? {};
};

const SWITCHES = [
  { name: "design review", parameter: "DesignReviewEnabled", setting: "designReview" as const, code: "dr", variable: "DESIGN_REVIEW_ENABLED", key: "designReview.enabled", on: designReviewEnabled },
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

describe("the retired design review project list (`dp`): kept for one release, decides nothing", () => {
  it("is still a plain-text stack parameter, empty by default, that reaches the broker in its packed settings with no Lambda variable of its own (so an upgrade keeps working)", () => {
    expect((named.toJSON() as { Parameters: Record<string, unknown> }).Parameters.DesignReviewProjects).toMatchObject({ Type: "String", Default: "", MaxLength: 20 });
    expect((named.toJSON() as { Parameters: Record<string, { Description?: string }> }).Parameters.DesignReviewProjects!.Description).toMatch(/^Retired:/);
    expect(brokerSettingsIn(brokerVariables(named)).designReviewProjects).toEqual({ Ref: "DesignReviewProjects" });
    expect(brokerVariables(named)).not.toHaveProperty("DESIGN_REVIEW_PROJECTS");
    expect(BROKER_SETTINGS.designReviewProjects).toEqual({ code: "dp", variable: "DESIGN_REVIEW_PROJECTS" });
    expect(JSON.stringify(legacy.toJSON())).not.toContain("DesignReviewProjects");
  });

  it("`agentx config set designReview.projects` is refused with a pointer to How we work, whatever the value", () => {
    const entry = configKey("designReview.projects");
    expect(entry.target).toEqual({ kind: "stack-parameter", part: "control-plane", parameter: "DesignReviewProjects" });
    for (const value of ["payments:web", "", "payments", "Bad Value"]) expect(() => entry.parse(value), value).toThrow("Design review is now turned on per project in How we work.");
    expect(entry.description).toMatch(/^Retired:/);
  });

  it("an upgrade still carries a value set before (the parameter stays in OPERATOR_PARAMETERS this release); 0.5.6 removes it from the template and from OPERATOR_PARAMETERS, and the upgrade then reports it as dropped", () => {
    expect(OPERATOR_PARAMETERS["control-plane"]).toEqual(expect.arrayContaining(["DesignReviewProjects"]));
  });

  it("reaches the broker through hydration as a plain variable that nothing in the switch reads", () => {
    const env: MutableEnvironment = { [BROKER_SETTINGS_VARIABLE]: "dr=1,dp=payments" };
    hydrateBrokerEnvironment(env);
    expect(env["DESIGN_REVIEW_PROJECTS"]).toBe("payments");
    expect(designReviewEnabled(env)).toBe(true);
  });
});
