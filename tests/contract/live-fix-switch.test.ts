// The Fix with agent switch (`fd`) at deploy time: a control-plane stack parameter, LiveFixEnabled, "0" (off) by default, that reaches the broker in its packed settings (AGENTX_SETTINGS, code "fd"), never
// as a Lambda variable of its own. The broker reads it back as LIVE_FIX_ENABLED, and the diagnosis routes exist only when it is exactly "1". It is hard-gated (live-interaction-deploy-gate.test.ts): this
// file may only exist because the person-erasure `diagnoses` step is wired.
import { randomUUID } from "node:crypto";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { BROKER_SETTINGS, BROKER_SETTINGS_VARIABLE, LIVE_INTERACTION_FLAGS } from "@agentx/contracts";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { diagnosisServiceDependenciesFor } from "../../packages/broker/src/aws/broker/diagnosis-service.js";
import { diagnosisEnabled } from "../../packages/broker/src/diagnosis/switch.js";
import { routeDiagnosisRequest } from "../../packages/broker/src/diagnosis/routes.js";
import { configKey } from "../../packages/cli/src/config/keys.js";
import { OPERATOR_PARAMETERS } from "../../packages/cli/src/deploy/parameters.js";
import { brokerSettingsIn } from "../support/broker-names-template.js";
import { ORG_A, PRIYA, diagnosisWorld } from "../support/diagnosis-world.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const named = Template.fromStack(new ControlPlaneStack(new App(), "LiveFixControlPlane", { naming: environmentNaming("staging") }));
const legacy = Template.fromStack(new ControlPlaneStack(new App(), "LiveFixLegacyControlPlane"));
const brokerVariables = (template: Template): Record<string, unknown> => {
  const found = Object.entries(template.findResources("AWS::Lambda::Function") as Record<string, { Properties: { Environment?: { Variables?: Record<string, unknown> } } }>)
    .find(([id]) => /^Broker[0-9A-F]{8}$/.test(id));
  return found?.[1].Properties.Environment?.Variables ?? {};
};

describe("the Fix with agent switch in the control plane", () => {
  it("declares LiveFixEnabled in a named environment, off by default, and only 0 or 1", () => {
    expect((named.toJSON() as { Parameters: Record<string, unknown> }).Parameters.LiveFixEnabled).toMatchObject({ Type: "String", Default: "0", AllowedValues: ["0", "1"] });
  });

  it("hands the broker the parameter in its packed settings and adds no Lambda variable of its own", () => {
    expect(brokerSettingsIn(brokerVariables(named)).liveFix).toEqual({ Ref: "LiveFixEnabled" });
    expect(brokerVariables(named)).not.toHaveProperty("LIVE_FIX_ENABLED");
    expect(BROKER_SETTINGS.liveFix).toEqual({ code: "fd", variable: "LIVE_FIX_ENABLED" });
    expect(BROKER_SETTINGS.liveFix).toEqual(LIVE_INTERACTION_FLAGS.fix);
  });

  it("reaches the broker's code as LIVE_FIX_ENABLED: unset, 0 or anything but exactly 1 builds nothing, 1 builds the service routes", () => {
    const hydrated = (value: string): MutableEnvironment => { const env: MutableEnvironment = { [BROKER_SETTINGS_VARIABLE]: `fd=${value}` }; hydrateBrokerEnvironment(env); return env; };
    expect(hydrated("0")["LIVE_FIX_ENABLED"]).toBe("0");
    const dependencies = { documentClient: {}, tableName: "state", callbackSigningKey: "k".repeat(48) } as never;
    for (const value of ["", "true", "yes", "on", " 1", "01", "0"]) {
      expect(diagnosisEnabled({ LIVE_FIX_ENABLED: value }), JSON.stringify(value)).toBe(false);
      expect(diagnosisServiceDependenciesFor(dependencies, {} as never, { LIVE_FIX_ENABLED: value }), JSON.stringify(value)).toBeUndefined();
    }
    expect(diagnosisEnabled({})).toBe(false);
    expect(diagnosisServiceDependenciesFor(dependencies, {} as never, hydrated("0"))).toBeUndefined();
    expect(diagnosisServiceDependenciesFor(dependencies, {} as never, hydrated("1"))).toMatchObject({ enabled: true });
  });

  it("leaves the released (legacy) template without the parameter or the setting", () => {
    expect(JSON.stringify(legacy.toJSON())).not.toContain("LiveFixEnabled");
    expect(JSON.stringify(legacy.toJSON())).not.toContain("LIVE_FIX_ENABLED");
  });

  it("is set with `agentx config set liveFix.enabled 0|1`, and an upgrade keeps it", () => {
    const entry = configKey("liveFix.enabled");
    expect(entry.target).toEqual({ kind: "stack-parameter", part: "control-plane", parameter: "LiveFixEnabled" });
    expect(entry.defaultValue).toBe("0");
    expect(entry.parse("1")).toBe("1");
    expect(() => entry.parse("true")).toThrow("liveFix.enabled must be one of 0, 1; nothing changed");
    expect(OPERATOR_PARAMETERS["control-plane"]).toContain("LiveFixEnabled");
  });
});

describe("the person's routes", () => {
  it("answer NOT_FOUND for every diagnosis path while the dependencies are absent, as if they did not exist, and ignore every other path", async () => {
    const w = diagnosisWorld({ enabled: false });
    const caller = { orgId: ORG_A, developerId: PRIYA };
    const id = `dgn_${"a".repeat(20)}`;
    for (const [method, path] of [["POST", "/v1/app/diagnoses"], ["GET", `/v1/app/diagnoses/${id}`], ["GET", "/v1/app/diagnoses"], ["POST", `/v1/app/diagnoses/${id}`]] as const) {
      await expect(routeDiagnosisRequest(undefined, caller, method, path, () => ({})), `${method} ${path}`).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(routeDiagnosisRequest(w.diagnosis, caller, method, path, () => ({})), `${method} ${path} (off)`).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await expect(routeDiagnosisRequest(undefined, caller, "GET", "/v1/app/sessions", () => ({}))).resolves.toBeUndefined();
  });

  it("with the switch on: POST starts one (202 queued), GET reads it, and a wrong method or an id of the wrong shape is NOT_FOUND", async () => {
    const w = diagnosisWorld();
    const caller = { orgId: ORG_A, developerId: PRIYA };
    const started = await routeDiagnosisRequest(w.diagnosis, caller, "POST", "/v1/app/diagnoses", () => ({ requestId: randomUUID(), errorRef: w.ref() })) as { statusCode: number; body: { diagnosisId: string; state: string } };
    expect(started.statusCode).toBe(202);
    expect(started.body.state).toBe("queued");
    const read = await routeDiagnosisRequest(w.diagnosis, caller, "GET", `/v1/app/diagnoses/${started.body.diagnosisId}`, () => ({})) as { diagnosisId: string };
    expect(read.diagnosisId).toBe(started.body.diagnosisId);
    await expect(routeDiagnosisRequest(w.diagnosis, caller, "DELETE", `/v1/app/diagnoses/${started.body.diagnosisId}`, () => ({}))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(routeDiagnosisRequest(w.diagnosis, caller, "GET", "/v1/app/diagnoses/not-an-id", () => ({}))).resolves.toBeUndefined();
  });
});
