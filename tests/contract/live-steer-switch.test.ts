// The live steer kill switch at deploy time: a control-plane stack parameter, LiveSteerEnabled, "0" (off) by default, that reaches the broker in its packed settings (AGENTX_SETTINGS,
// code "ls"), never as a Lambda variable of its own (the broker's variables are held to Lambda's 4 KB). The broker reads it back as LIVE_STEER_ENABLED, and live steer is on only when
// it is exactly "1". Deploy order: dispatcher, publisher and broker with the flag off, then the worker image carrying task.liveSteer.v1, then the flag on.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { BROKER_SETTINGS, BROKER_SETTINGS_VARIABLE } from "@agentx/contracts";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { liveSteerFromEnvironment } from "../../packages/broker/src/agent-sessions/live-steer.js";
import { configKey } from "../../packages/cli/src/config/keys.js";
import { OPERATOR_PARAMETERS } from "../../packages/cli/src/deploy/parameters.js";
import { brokerSettingsIn } from "../support/broker-names-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const named = Template.fromStack(new ControlPlaneStack(new App(), "LiveSteerControlPlane", { naming: environmentNaming("staging") }));
const legacy = Template.fromStack(new ControlPlaneStack(new App(), "LiveSteerLegacyControlPlane"));
const brokerVariables = (template: Template): Record<string, unknown> => {
  const found = Object.entries(template.findResources("AWS::Lambda::Function") as Record<string, { Properties: { Environment?: { Variables?: Record<string, unknown> } } }>)
    .find(([id]) => /^Broker[0-9A-F]{8}$/.test(id));
  return found?.[1].Properties.Environment?.Variables ?? {};
};

describe("the live steer switch in the control plane", () => {
  it("declares LiveSteerEnabled in a named environment, off by default, and only 0 or 1", () => {
    expect((named.toJSON() as { Parameters: Record<string, unknown> }).Parameters.LiveSteerEnabled).toMatchObject({ Type: "String", Default: "0", AllowedValues: ["0", "1"] });
  });

  it("hands the broker the parameter in its packed settings and adds no Lambda variable of its own", () => {
    expect(brokerSettingsIn(brokerVariables(named)).liveSteer).toEqual({ Ref: "LiveSteerEnabled" });
    expect(brokerVariables(named)).not.toHaveProperty("LIVE_STEER_ENABLED");
    expect(BROKER_SETTINGS.liveSteer.variable).toBe("LIVE_STEER_ENABLED");
    // Two letters and one value: the packed setting costs a handful of bytes, not a variable name.
    expect(BROKER_SETTINGS.liveSteer.code).toHaveLength(2);
  });

  it("reaches the broker's code as LIVE_STEER_ENABLED: unset or 0 is off, 1 is on", () => {
    const hydrated = (value: string): MutableEnvironment => { const env: MutableEnvironment = { [BROKER_SETTINGS_VARIABLE]: `ls=${value}` }; hydrateBrokerEnvironment(env); return env; };
    expect(hydrated("0")["LIVE_STEER_ENABLED"]).toBe("0");
    expect(liveSteerFromEnvironment("k".repeat(48), hydrated("0"))).toBeUndefined();
    expect(liveSteerFromEnvironment("k".repeat(48), hydrated("1"))).toEqual({ callbackSigningKey: "k".repeat(48) });
  });

  it("leaves the released (legacy) template without the parameter or the setting", () => {
    expect(JSON.stringify(legacy.toJSON())).not.toContain("LiveSteerEnabled");
    expect(JSON.stringify(legacy.toJSON())).not.toContain("LIVE_STEER_ENABLED");
  });

  it("is set with `agentx config set liveSteer.enabled 0|1`, and an upgrade keeps it", () => {
    const entry = configKey("liveSteer.enabled");
    expect(entry.target).toEqual({ kind: "stack-parameter", part: "control-plane", parameter: "LiveSteerEnabled" });
    expect(entry.defaultValue).toBe("0");
    expect(entry.parse("1")).toBe("1");
    expect(() => entry.parse("true")).toThrow("liveSteer.enabled must be one of 0, 1; nothing changed");
    expect(OPERATOR_PARAMETERS["control-plane"]).toContain("LiveSteerEnabled");
  });
});
