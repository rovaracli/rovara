// The Slack explicit membership switch at deploy time (0.5.14): SlackExplicitMembers (`sm`). A control-plane stack parameter, "1" (on) by default, 0, 1 or warn, that reaches the broker in its
// packed settings (AGENTX_SETTINGS), never as a Lambda variable of its own. The broker's reading of the value is tested in slack-explicit-members.test.ts.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { BROKER_SETTINGS, BROKER_SETTINGS_VARIABLE } from "@agentx/cloud-contracts";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { slackMemberRule } from "../../packages/broker/src/org/slack-explicit-members.js";
import { configKey } from "../../packages/cli/src/config/keys.js";
import { OPERATOR_PARAMETERS } from "../../packages/cli/src/deploy/parameters.js";
import { brokerSettingsIn } from "../support/broker-names-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const named = Template.fromStack(new ControlPlaneStack(new App(), "SlackMembersSwitchControlPlane", { naming: environmentNaming("staging") }));
const legacy = Template.fromStack(new ControlPlaneStack(new App(), "SlackMembersSwitchLegacyControlPlane"));
const brokerVariables = (template: Template): Record<string, unknown> => {
  const found = Object.entries(template.findResources("AWS::Lambda::Function") as Record<string, { Properties: { Environment?: { Variables?: Record<string, unknown> } } }>)
    .find(([id]) => /^Broker[0-9A-F]{8}$/.test(id));
  return found?.[1].Properties.Environment?.Variables ?? {};
};

describe("the Slack explicit membership switch", () => {
  it("is a stack parameter in a named environment, on by default, only 0, 1 or warn", () => {
    expect((named.toJSON() as { Parameters: Record<string, unknown> }).Parameters.SlackExplicitMembers).toMatchObject({ Type: "String", Default: "1", AllowedValues: ["0", "1", "warn"] });
  });

  it("reaches the broker in its packed settings and adds no Lambda variable of its own", () => {
    expect(brokerSettingsIn(brokerVariables(named)).slackExplicitMembers).toEqual({ Ref: "SlackExplicitMembers" });
    expect(brokerVariables(named)).not.toHaveProperty("SLACK_EXPLICIT_MEMBERS");
    expect(BROKER_SETTINGS.slackExplicitMembers).toEqual({ code: "sm", variable: "SLACK_EXPLICIT_MEMBERS" });
  });

  it("is read from the packed settings as the broker's rule", () => {
    const rule = (value: string) => { const env: MutableEnvironment = { [BROKER_SETTINGS_VARIABLE]: `sm=${value}` }; hydrateBrokerEnvironment(env); return slackMemberRule(env); };
    expect(rule("1")).toBe("require");
    expect(rule("warn")).toBe("warn");
    expect(rule("0")).toBe("off");
    expect(slackMemberRule({})).toBe("require");
  });

  it("is missing from the released (legacy) template, which has neither the parameter nor the setting", () => {
    expect(JSON.stringify(legacy.toJSON())).not.toContain("SlackExplicitMembers");
    expect(JSON.stringify(legacy.toJSON())).not.toContain("SLACK_EXPLICIT_MEMBERS");
  });

  it("is set with `agentx config set`, and an upgrade keeps it", () => {
    const entry = configKey("slack.explicitMembers");
    expect(entry.target).toEqual({ kind: "stack-parameter", part: "control-plane", parameter: "SlackExplicitMembers" });
    expect(entry.defaultValue).toBe("1");
    expect(entry.parse("warn")).toBe("warn");
    expect(() => entry.parse("true")).toThrow("slack.explicitMembers must be one of 0, 1, warn; nothing changed");
    expect(OPERATOR_PARAMETERS["control-plane"]).toContain("SlackExplicitMembers");
  });
});
