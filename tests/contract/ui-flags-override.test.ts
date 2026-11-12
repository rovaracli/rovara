// The operator's UI flag override at deploy time (lane U5): UiFlagsForceOff (`uo`). A control-plane stack parameter, `none` by default, that reaches the broker in its packed settings
// (AGENTX_SETTINGS), never as a Lambda variable of its own, and that the broker reads as UI_FLAGS_FORCE_OFF (contracts `uiFlagsForcedOff`: `all`, or screen names joined by a hyphen).
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { BROKER_SETTINGS, BROKER_SETTINGS_VARIABLE, UI_FLAG_NAMES } from "@agentx/cloud-contracts";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { operatorForcedOff } from "../../packages/broker/src/org/ui-flags/store.js";
import { configKey } from "../../packages/cli/src/config/keys.js";
import { OPERATOR_PARAMETERS } from "../../packages/cli/src/deploy/parameters.js";
import { brokerSettingsIn } from "../support/broker-names-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const named = Template.fromStack(new ControlPlaneStack(new App(), "UiFlagsOverrideControlPlane", { naming: environmentNaming("staging") }));
const legacy = Template.fromStack(new ControlPlaneStack(new App(), "UiFlagsOverrideLegacyControlPlane"));
const brokerVariables = (template: Template): Record<string, unknown> => {
  const found = Object.entries(template.findResources("AWS::Lambda::Function") as Record<string, { Properties: { Environment?: { Variables?: Record<string, unknown> } } }>)
    .find(([id]) => /^Broker[0-9A-F]{8}$/.test(id));
  return found?.[1].Properties.Environment?.Variables ?? {};
};

describe("the UI flag override", () => {
  it("is a stack parameter in a named environment: none by default, plain text only", () => {
    const parameter = (named.toJSON() as { Parameters: Record<string, { Default: string; AllowedPattern: string; MaxLength: number }> }).Parameters.UiFlagsForceOff!;
    expect(parameter).toMatchObject({ Default: "none", MaxLength: 64 });
    const allowed = new RegExp(parameter.AllowedPattern);
    // The stack's pattern is letters only; it still takes a pre-0.5.15 value naming a removed screen (the broker skips it), so an upgrade keeps an existing value.
    for (const value of ["none", "all", "look", "look-nav", "health", UI_FLAG_NAMES.slice(0, 5).join("-")]) expect(allowed.test(value), value).toBe(true);
    for (const value of ["", "look nav", "look,nav", "look-", "-look", "look--nav", "look=nav", "look\"nav"]) expect(allowed.test(value), value).toBe(false);
  });

  it("reaches the broker in its packed settings and adds no Lambda variable of its own", () => {
    expect(brokerSettingsIn(brokerVariables(named)).uiFlagsForceOff).toEqual({ Ref: "UiFlagsForceOff" });
    expect(brokerVariables(named)).not.toHaveProperty("UI_FLAGS_FORCE_OFF");
    expect(BROKER_SETTINGS.uiFlagsForceOff).toEqual({ code: "uo", variable: "UI_FLAGS_FORCE_OFF" });
  });

  it("is read by the broker as the hydrated variable, and every value but a clean list of known names holds everything back", () => {
    const hydrated = (value: string): MutableEnvironment => { const env: MutableEnvironment = { [BROKER_SETTINGS_VARIABLE]: `uo=${value}` }; hydrateBrokerEnvironment(env); return env; };
    expect(operatorForcedOff(hydrated("none")).size).toBe(0);
    expect([...operatorForcedOff(hydrated("health-setup"))]).toEqual(["health", "setup"]);
    // Decision 125: a removed name is ignored, never read as unknown; any other unknown name fails closed.
    expect([...operatorForcedOff(hydrated("look-home"))]).toEqual([]);
    expect([...operatorForcedOff(hydrated("look-billing"))]).toEqual(["billing"]);
    expect(operatorForcedOff(hydrated("look-lok")).size).toBe(UI_FLAG_NAMES.length);
    expect(operatorForcedOff(hydrated("all")).size).toBe(UI_FLAG_NAMES.length);
    expect(operatorForcedOff(hydrated("lok")).size).toBe(UI_FLAG_NAMES.length);
    expect(operatorForcedOff({}).size).toBe(0);
  });

  it("is missing from the released (legacy) template", () => {
    expect(JSON.stringify(legacy.toJSON())).not.toContain("UiFlagsForceOff");
    expect(JSON.stringify(legacy.toJSON())).not.toContain("UI_FLAGS_FORCE_OFF");
  });

  it("is set with `agentx config set ui.forceOff`, refused before anything changes when it is not a clean value, and an upgrade keeps it", () => {
    const entry = configKey("ui.forceOff");
    expect(entry.target).toEqual({ kind: "stack-parameter", part: "control-plane", parameter: "UiFlagsForceOff" });
    expect(entry.defaultValue).toBe("none");
    for (const value of ["none", "all", "health", " health-setup ", UI_FLAG_NAMES.join("-")]) expect(entry.parse(value)).toBe(value.trim());
    for (const value of ["", "lok", "health-", "health setup", "Health", "health,setup", "x".repeat(65)]) expect(() => entry.parse(value), value).toThrow(/ui\.forceOff must be none, all, or screen names/u);
    // A finished screen's former name (decision 125) is refused with its reason: setting it would change nothing.
    for (const value of ["look", "look-nav", "health-insights", "continue"]) expect(() => entry.parse(value), value).toThrow(/can no longer be turned off/u);
    expect(entry.description).toContain("can no longer be turned off");
    expect(entry.description).toContain("joined by a hyphen (health, setup, publish, billing, agreement, companies)");
    expect(OPERATOR_PARAMETERS["control-plane"]).toContain("UiFlagsForceOff");
  });
});
