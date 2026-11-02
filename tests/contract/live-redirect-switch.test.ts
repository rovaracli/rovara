// The Stop & redirect kill switch (switch `rd`) at deploy time: a control-plane stack parameter, LiveRedirectEnabled, "0" (off) by default, that reaches the broker in its packed settings
// (AGENTX_SETTINGS, code "rd"), never as a Lambda variable of its own. The broker reads it back as LIVE_REDIRECT_ENABLED, and the redirect route exists only when it is exactly "1".
// Deploy order: the dispatcher and the worker image carrying task.ownerRedirect.v1 first, then the broker with the flag off, then the flag on.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it, vi } from "vitest";
import { BROKER_SETTINGS, BROKER_SETTINGS_VARIABLE, LIVE_INTERACTION_FLAGS, OWNER_REDIRECT_FEATURE, workspaceSessionKey } from "@agentx/contracts";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { redirectFromEnvironment, workspaceWorkerFeatures } from "../../packages/broker/src/aws/broker/redirect-runtime.js";
import { configKey } from "../../packages/cli/src/config/keys.js";
import { OPERATOR_PARAMETERS } from "../../packages/cli/src/deploy/parameters.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { brokerSettingsIn } from "../support/broker-names-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const named = Template.fromStack(new ControlPlaneStack(new App(), "LiveRedirectControlPlane", { naming: environmentNaming("staging") }));
const legacy = Template.fromStack(new ControlPlaneStack(new App(), "LiveRedirectLegacyControlPlane"));
const brokerVariables = (template: Template): Record<string, unknown> => {
  const found = Object.entries(template.findResources("AWS::Lambda::Function") as Record<string, { Properties: { Environment?: { Variables?: Record<string, unknown> } } }>)
    .find(([id]) => /^Broker[0-9A-F]{8}$/.test(id));
  return found?.[1].Properties.Environment?.Variables ?? {};
};

describe("the Stop & redirect switch in the control plane", () => {
  it("declares LiveRedirectEnabled in a named environment, off by default, and only 0 or 1", () => {
    expect((named.toJSON() as { Parameters: Record<string, unknown> }).Parameters.LiveRedirectEnabled).toMatchObject({ Type: "String", Default: "0", AllowedValues: ["0", "1"] });
  });

  it("hands the broker the parameter in its packed settings and adds no Lambda variable of its own", () => {
    expect(brokerSettingsIn(brokerVariables(named)).liveRedirect).toEqual({ Ref: "LiveRedirectEnabled" });
    expect(brokerVariables(named)).not.toHaveProperty("LIVE_REDIRECT_ENABLED");
    expect(BROKER_SETTINGS.liveRedirect).toEqual(LIVE_INTERACTION_FLAGS.redirect.code === "rd" ? { code: "rd", variable: LIVE_INTERACTION_FLAGS.redirect.variable } : undefined);
    expect(BROKER_SETTINGS.liveRedirect.variable).toBe("LIVE_REDIRECT_ENABLED");
  });

  it("reaches the broker's code as LIVE_REDIRECT_ENABLED: unset, 0 or anything but exactly 1 is off", () => {
    const hydrated = (value: string): MutableEnvironment => { const env: MutableEnvironment = { [BROKER_SETTINGS_VARIABLE]: `rd=${value}` }; hydrateBrokerEnvironment(env); return env; };
    expect(hydrated("0")["LIVE_REDIRECT_ENABLED"]).toBe("0");
    const deps = { documentClient: new FakeDynamoDb(), tableName: "state" } as never;
    expect(redirectFromEnvironment(deps, hydrated("0"))).toBeUndefined();
    for (const value of ["", "true", "yes", "on", " 1", "01"]) expect(redirectFromEnvironment(deps, { LIVE_REDIRECT_ENABLED: value }), JSON.stringify(value)).toBeUndefined();
    expect(redirectFromEnvironment(deps, {})).toBeUndefined();
    expect(redirectFromEnvironment(deps, hydrated("1"))).toHaveProperty("workerFeatures");
  });

  it("leaves the released (legacy) template without the parameter or the setting", () => {
    expect(JSON.stringify(legacy.toJSON())).not.toContain("LiveRedirectEnabled");
    expect(JSON.stringify(legacy.toJSON())).not.toContain("LIVE_REDIRECT_ENABLED");
  });

  it("is set with `agentx config set liveRedirect.enabled 0|1`, and an upgrade keeps it", () => {
    const entry = configKey("liveRedirect.enabled");
    expect(entry.target).toEqual({ kind: "stack-parameter", part: "control-plane", parameter: "LiveRedirectEnabled" });
    expect(entry.defaultValue).toBe("0");
    expect(entry.parse("1")).toBe("1");
    expect(() => entry.parse("true")).toThrow("liveRedirect.enabled must be one of 0, 1; nothing changed");
    expect(OPERATOR_PARAMETERS["control-plane"]).toContain("LiveRedirectEnabled");
  });
});

describe("reading what a task's worker supports (LR-1: the session manager records it; the broker never reaches the worker)", () => {
  const seed = (session: Record<string, unknown> | undefined) => {
    const db = new FakeDynamoDb();
    if (session !== undefined) db.set({ ...workspaceSessionKey("ws-1"), ...session });
    return { documentClient: db, tableName: "state" } as never;
  };

  it("lists the features the ready session recorded, and reaches no network", async () => {
    const fetched = vi.fn(async () => { throw new Error("test: the broker must not call the worker"); });
    vi.stubGlobal("fetch", fetched);
    try {
      expect(await workspaceWorkerFeatures(seed({ state: "READY", privateIp: "10.0.1.7", workerFeatures: [OWNER_REDIRECT_FEATURE, "task.liveSteer.v1"] }), { workspaceId: "ws-1" })).toEqual([OWNER_REDIRECT_FEATURE, "task.liveSteer.v1"]);
      expect(await workspaceWorkerFeatures(seed({ state: "READY", privateIp: "10.0.1.7", workerFeatures: [] }), { workspaceId: "ws-1" })).toEqual([]);
      expect(fetched).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("is unknown (fail closed) for a workspace with no ready session, a session recorded without a list, or a damaged list", async () => {
    expect(await workspaceWorkerFeatures(seed(undefined), { workspaceId: "ws-1" })).toBeUndefined();
    expect(await workspaceWorkerFeatures(seed({ state: "STOPPED", workerFeatures: [OWNER_REDIRECT_FEATURE] }), { workspaceId: "ws-1" })).toBeUndefined();
    expect(await workspaceWorkerFeatures(seed({ state: "PROVISIONING", workerFeatures: [OWNER_REDIRECT_FEATURE] }), { workspaceId: "ws-1" })).toBeUndefined();
    expect(await workspaceWorkerFeatures(seed({ state: "READY", privateIp: "10.0.1.7" }), { workspaceId: "ws-1" })).toBeUndefined();
    expect(await workspaceWorkerFeatures(seed({ state: "READY", workerFeatures: [OWNER_REDIRECT_FEATURE, 4] }), { workspaceId: "ws-1" })).toBeUndefined();
    expect(await workspaceWorkerFeatures(seed({ state: "READY", workerFeatures: OWNER_REDIRECT_FEATURE }), { workspaceId: "ws-1" })).toBeUndefined();
  });
});
