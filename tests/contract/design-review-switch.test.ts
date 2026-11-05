// The design review switch at deploy time: DesignReviewEnabled (`dr`), the environment's master switch (the old project list `dp`, DesignReviewProjects, was removed in 0.5.7). It is a control-plane stack parameter, "0" (off) by default, that reaches the broker in its packed settings
// (AGENTX_SETTINGS), never as a Lambda variable of its own, and is on only when the broker reads exactly "1".
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { BROKER_SETTINGS, BROKER_SETTINGS_VARIABLE, environmentStackName } from "@agentx/contracts";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { designReviewEnabled } from "../../packages/broker/src/design-review/switch.js";
import { CONFIG_KEYS, configKey } from "../../packages/cli/src/config/keys.js";
import { keptOperatorParameters } from "../../packages/cli/src/deploy/deploy-environment.js";
import { OPERATOR_PARAMETERS, RETIRED_OPERATOR_PARAMETERS } from "../../packages/cli/src/deploy/parameters.js";
import { droppedConfigKeys } from "../../packages/cli/src/upgrade/run.js";
import type { StackReader } from "../../packages/cli/src/environments/adopt.js";
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

describe("the retired design review project list (`dp`, DesignReviewProjects) is gone (0.5.7)", () => {
  it("is not a stack parameter of the named or the released template, is not in the broker's packed settings, and has no Lambda variable", () => {
    expect((named.toJSON() as { Parameters: Record<string, unknown> }).Parameters).not.toHaveProperty("DesignReviewProjects");
    expect(brokerSettingsIn(brokerVariables(named))).not.toHaveProperty("designReviewProjects");
    expect(brokerVariables(named)).not.toHaveProperty("DESIGN_REVIEW_PROJECTS");
    expect(JSON.stringify(named.toJSON())).not.toContain("DesignReviewProjects");
    expect(JSON.stringify(legacy.toJSON())).not.toContain("DesignReviewProjects");
    expect(BROKER_SETTINGS).not.toHaveProperty("designReviewProjects");
  });

  it("`designReview.projects` is not a config key any more: it is unknown, like any other", () => {
    expect(() => configKey("designReview.projects")).toThrow(/unknown config key designReview\.projects/);
    expect(CONFIG_KEYS.map((entry) => entry.key)).not.toContain("designReview.projects");
    expect(CONFIG_KEYS.some((entry) => entry.target.kind === "stack-parameter" && entry.target.parameter === "DesignReviewProjects")).toBe(false);
  });

  it("an upgrade still FINDS a value deployed before (the name stays in OPERATOR_PARAMETERS for this one release, as a retired parameter) so it can report it dropped; the next release deletes the name", () => {
    expect(RETIRED_OPERATOR_PARAMETERS["control-plane"]).toEqual(["DesignReviewProjects"]);
    expect(OPERATOR_PARAMETERS["control-plane"]).toContain("DesignReviewProjects");
  });

  it("an upgrade from a stack holding DesignReviewProjects to a template without it drops it: it is reported and never sent (CloudFormation refuses an unknown parameter)", async () => {
    const declared = new Set(Object.keys((named.toJSON() as { Parameters: Record<string, unknown> }).Parameters));
    expect(declared.has("DesignReviewProjects")).toBe(false);
    expect(declared.has("DesignReviewEnabled")).toBe(true);
    const deployed = { DesignReviewProjects: "demo-tasklog", DesignReviewEnabled: "1" };
    const result = keptOperatorParameters({ part: "control-plane", computed: {}, deployed, declared });
    expect(result.dropped).toEqual([{ parameter: "DesignReviewProjects", value: "demo-tasklog" }]);
    expect(result.kept).toEqual({ DesignReviewEnabled: "1" });
    expect(result.kept).not.toHaveProperty("DesignReviewProjects");
    const stacks = { describe: async (name: string) => (name === environmentStackName("staging", "control-plane") ? { parameters: deployed } : undefined) } as unknown as StackReader;
    expect(await droppedConfigKeys({ declared: (part) => (part === "control-plane" ? declared : undefined), env: "staging", parts: ["control-plane"], stacks })).toEqual([{ key: "designReview.projects", value: "demo-tasklog", instead: "allow design review in company How we work and set each of these projects to Auto" }]);
    // With the release's parameters unknown (a cdk-only release), a retired parameter is still dropped, never sent.
    const unknown = keptOperatorParameters({ part: "control-plane", computed: {}, deployed, declared: undefined });
    expect(unknown.dropped).toEqual([{ parameter: "DesignReviewProjects", value: "demo-tasklog" }]);
    expect(unknown.kept).toEqual({ DesignReviewEnabled: "1" });
  });

  it("an old packed `dp=` entry is ignored by hydration, and `dr` is unaffected", () => {
    // A broker of this release started while the stack still packs the old list (a rolling deploy): `dp` is not a setting any more. It is not
    // read as the dispatcher function (whose code is also `dp`, but in AGENTX_NAMES, not here), and it does not make hydration throw.
    const env: MutableEnvironment = { [BROKER_SETTINGS_VARIABLE]: "dr=1,dp=demo-tasklog" };
    expect(() => hydrateBrokerEnvironment(env)).not.toThrow();
    expect(env["DESIGN_REVIEW_PROJECTS"]).toBeUndefined();
    expect(env["DISPATCHER_FUNCTION_ARN"]).toBeUndefined();
    expect(designReviewEnabled(env)).toBe(true);
  });
});
