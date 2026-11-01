// The two proof switches at deploy time: ProofEvidenceEnabled (`pe`) and DecisionCardsEnabled (`dk`). Each is a control-plane stack parameter, "0" (off) by default, that reaches the broker in its packed settings
// (AGENTX_SETTINGS), never as a Lambda variable of its own, and is on only when the broker reads exactly "1".
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { BROKER_SETTINGS, BROKER_SETTINGS_VARIABLE } from "@agentx/contracts";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { decisionCardsEnabled, proofEvidenceEnabled } from "../../packages/broker/src/proof/switch.js";
import { configKey } from "../../packages/cli/src/config/keys.js";
import { OPERATOR_PARAMETERS } from "../../packages/cli/src/deploy/parameters.js";
import { brokerSettingsIn } from "../support/broker-names-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const named = Template.fromStack(new ControlPlaneStack(new App(), "ProofSwitchControlPlane", { naming: environmentNaming("staging") }));
const legacy = Template.fromStack(new ControlPlaneStack(new App(), "ProofSwitchLegacyControlPlane"));
const brokerVariables = (template: Template): Record<string, unknown> => {
  const found = Object.entries(template.findResources("AWS::Lambda::Function") as Record<string, { Properties: { Environment?: { Variables?: Record<string, unknown> } } }>)
    .find(([id]) => /^Broker[0-9A-F]{8}$/.test(id));
  return found?.[1].Properties.Environment?.Variables ?? {};
};

const SWITCHES = [
  { name: "proof evidence", parameter: "ProofEvidenceEnabled", setting: "proofEvidence" as const, code: "pe", variable: "PROOF_EVIDENCE_ENABLED", key: "proofEvidence.enabled", on: proofEvidenceEnabled },
  { name: "decision cards", parameter: "DecisionCardsEnabled", setting: "decisionCards" as const, code: "dk", variable: "DECISION_CARDS_ENABLED", key: "decisionCards.enabled", on: decisionCardsEnabled },
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
