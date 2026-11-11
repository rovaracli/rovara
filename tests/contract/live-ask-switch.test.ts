// The Ask switch at deploy time: a control-plane stack parameter, LiveAskEnabled, "0" (off) by default, that reaches the broker in its packed settings (AGENTX_SETTINGS, code "ak"), never as
// a Lambda variable of its own. The broker reads it back as LIVE_ASK_ENABLED, and Ask is on only when it is exactly "1". It is hard-gated (live-interaction-deploy-gate.test.ts): this file may
// only exist because the person-erasure Asks step and the daily upkeep that deletes Asks past their 30 days are wired.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { BROKER_SETTINGS, BROKER_SETTINGS_VARIABLE } from "@agentx/cloud-contracts";
import { LIVE_INTERACTION_FLAGS } from "@rovara-code/contracts";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { askDependenciesFor } from "../../packages/broker/src/aws/broker/ask-service.js";
import { configKey } from "../../packages/cli/src/config/keys.js";
import { OPERATOR_PARAMETERS } from "../../packages/cli/src/deploy/parameters.js";
import { brokerSettingsIn } from "../support/broker-names-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const named = Template.fromStack(new ControlPlaneStack(new App(), "LiveAskControlPlane", { naming: environmentNaming("staging") }));
const legacy = Template.fromStack(new ControlPlaneStack(new App(), "LiveAskLegacyControlPlane"));
const brokerVariables = (template: Template): Record<string, unknown> => {
  const found = Object.entries(template.findResources("AWS::Lambda::Function") as Record<string, { Properties: { Environment?: { Variables?: Record<string, unknown> } } }>)
    .find(([id]) => /^Broker[0-9A-F]{8}$/.test(id));
  return found?.[1].Properties.Environment?.Variables ?? {};
};

describe("the Ask switch in the control plane", () => {
  it("declares LiveAskEnabled in a named environment, off by default, and only 0 or 1", () => {
    expect((named.toJSON() as { Parameters: Record<string, unknown> }).Parameters.LiveAskEnabled).toMatchObject({ Type: "String", Default: "0", AllowedValues: ["0", "1"] });
  });

  it("hands the broker the parameter in its packed settings and adds no Lambda variable of its own", () => {
    expect(brokerSettingsIn(brokerVariables(named)).liveAsk).toEqual({ Ref: "LiveAskEnabled" });
    expect(brokerVariables(named)).not.toHaveProperty("LIVE_ASK_ENABLED");
    expect(BROKER_SETTINGS.liveAsk).toEqual({ code: "ak", variable: "LIVE_ASK_ENABLED" });
    expect(BROKER_SETTINGS.liveAsk).toEqual(LIVE_INTERACTION_FLAGS.ask);
  });

  it("reaches the broker's code as LIVE_ASK_ENABLED: unset or 0 builds nothing, 1 builds Ask", () => {
    const hydrated = (value: string): MutableEnvironment => { const env: MutableEnvironment = { [BROKER_SETTINGS_VARIABLE]: `ak=${value}` }; hydrateBrokerEnvironment(env); return env; };
    expect(hydrated("0")["LIVE_ASK_ENABLED"]).toBe("0");
    const dependencies = { documentClient: {}, tableName: "state", callbackSigningKey: "k".repeat(48), githubPullRequests: {}, editionPolicy: { edition: "enterprise" } } as never;
    expect(askDependenciesFor(dependencies, {} as never, {} as never, hydrated("0"))).toBeUndefined();
    expect(askDependenciesFor(dependencies, {} as never, {} as never, hydrated("1"))).toMatchObject({ enabled: true });
  });

  it("leaves the released (legacy) template without the parameter or the setting", () => {
    expect(JSON.stringify(legacy.toJSON())).not.toContain("LiveAskEnabled");
    expect(JSON.stringify(legacy.toJSON())).not.toContain("LIVE_ASK_ENABLED");
  });

  it("is set with `agentx config set liveAsk.enabled 0|1`, and an upgrade keeps it", () => {
    const entry = configKey("liveAsk.enabled");
    expect(entry.target).toEqual({ kind: "stack-parameter", part: "control-plane", parameter: "LiveAskEnabled" });
    expect(entry.defaultValue).toBe("0");
    expect(entry.parse("1")).toBe("1");
    expect(() => entry.parse("true")).toThrow("liveAsk.enabled must be one of 0, 1; nothing changed");
    expect(OPERATOR_PARAMETERS["control-plane"]).toContain("LiveAskEnabled");
  });
});
