// Rovara Code v2 is turned on per ENVIRONMENT (owner decision 2026-10-26): a control-plane stack parameter, RovaraCodeV2Enabled, off by default, that reaches the broker in its
// packed settings (AGENTX_SETTINGS, code "rv"), never as a Lambda variable of its own. Staging turns it on with `agentx --env staging config set rovaraCode.v2 true`.
// Production, the released (legacy) templates and the code default stay off, and the flag only decides what NEW tasks get: a task that exists keeps its version.
import { randomUUID } from "node:crypto";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BROKER_SETTINGS } from "@agentx/cloud-contracts";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { rovaraCodeV2LiveFromEnvironment } from "../../packages/broker/src/rovara-code/v2-switch.js";
import { hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { configKey } from "../../packages/cli/src/config/keys.js";
import { OPERATOR_PARAMETERS } from "../../packages/cli/src/deploy/parameters.js";
import { ROVARA_CODE_V2_FOR_NEW_ORGS } from "@rovara-code/contracts";
import { builtinSettingsKey } from "@rovara-code/contracts";
import { brokerSettingsIn } from "../support/broker-names-template.js";
import { MAYA, createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { loadSlackBroker } from "../support/slack-broker.js";

skipLambdaBundling();

describe("the switch, read from the broker's environment", () => {
  it("is off unless the setting is exactly true", () => {
    for (const value of [undefined, "", "false", "TRUE", "1", "yes", "enabled"]) expect(rovaraCodeV2LiveFromEnvironment({ AGENTX_ROVARA_CODE_V2_ENABLED: value }), String(value)).toBe(false);
    expect(rovaraCodeV2LiveFromEnvironment({})).toBe(false);
    expect(rovaraCodeV2LiveFromEnvironment({ AGENTX_ROVARA_CODE_V2_ENABLED: "true" })).toBe(true);
  });

  it("is a packed setting: AGENTX_SETTINGS code rv hydrates AGENTX_ROVARA_CODE_V2_ENABLED", () => {
    expect(BROKER_SETTINGS.rovaraCodeV2).toEqual({ code: "rv", variable: "AGENTX_ROVARA_CODE_V2_ENABLED" });
    const env: MutableEnvironment = { AWS_REGION: "us-west-2", AGENTX_ACCOUNT_ID: "123456789012", AGENTX_ENV: "staging", AGENTX_SETTINGS: "rv=true" };
    hydrateBrokerEnvironment(env);
    expect(env.AGENTX_ROVARA_CODE_V2_ENABLED).toBe("true");
  });

  it("keeps the code default off", () => {
    expect(ROVARA_CODE_V2_FOR_NEW_ORGS).toBe(false);
  });
});

describe("the stack parameter and the CLI key", () => {
  const named = Template.fromStack(new ControlPlaneStack(new App(), "SwitchControlPlane", { naming: environmentNaming("staging") }));
  const legacy = Template.fromStack(new ControlPlaneStack(new App(), "SwitchLegacyControlPlane"));
  const brokerVariables = (template: Template): Record<string, unknown> => {
    const found = Object.entries(template.findResources("AWS::Lambda::Function") as Record<string, { Properties: { Environment?: { Variables?: Record<string, unknown> } } }>).find(([id]) => /^Broker[0-9A-F]{8}$/.test(id));
    return found?.[1].Properties.Environment?.Variables ?? {};
  };

  it("declares RovaraCodeV2Enabled in a named environment, off by default", () => {
    expect((named.toJSON() as { Parameters: Record<string, unknown> }).Parameters.RovaraCodeV2Enabled).toMatchObject({ Type: "String", Default: "false", AllowedValues: ["true", "false"] });
  });

  it("hands the broker the parameter in its packed settings, and adds no Lambda variable", () => {
    expect(brokerSettingsIn(brokerVariables(named)).rovaraCodeV2).toEqual({ Ref: "RovaraCodeV2Enabled" });
    expect(brokerVariables(named)).not.toHaveProperty("AGENTX_ROVARA_CODE_V2_ENABLED");
  });

  it("leaves the released (legacy) template without the parameter or the setting", () => {
    expect(legacy.toJSON().Parameters).not.toHaveProperty("RovaraCodeV2Enabled");
    expect(JSON.stringify(legacy.toJSON())).not.toContain("RovaraCodeV2Enabled");
    expect(JSON.stringify(legacy.toJSON())).not.toContain("AGENTX_ROVARA_CODE_V2_ENABLED");
  });

  it("is set with `agentx config set rovaraCode.v2 true|false`, and an upgrade keeps it", () => {
    const entry = configKey("rovaraCode.v2");
    expect(entry.target).toEqual({ kind: "stack-parameter", part: "control-plane", parameter: "RovaraCodeV2Enabled" });
    expect(entry.defaultValue).toBe("false");
    expect(entry.parse("true")).toBe("true");
    expect(() => entry.parse("on")).toThrow("rovaraCode.v2 must be one of true, false; nothing changed");
    expect(OPERATOR_PARAMETERS["control-plane"]).toContain("RovaraCodeV2Enabled");
  });
});

describe("what the switch changes in a running broker", () => {
  beforeAll(async () => { await loadSlackBroker(); });
  afterEach(() => { vi.unstubAllEnvs(); });

  async function setup() {
    const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {} } });
    seedMembership(h.db, MAYA.developerId, { orgId: TEST_ORG, role: "owner" });
    const run = async () => {
      const reply = await h.dev(MAYA, "POST", "/v1/app/agents/rovara-code/runs", { requestId: randomUUID(), project: "payments", input: { text: "Fix the retry bug" } });
      expect(reply.status, JSON.stringify(reply.body)).toBe(202);
      const task = reply.body.task as { taskId: string };
      return { taskId: task.taskId, meta: h.db.get(`DEVTASK#${task.taskId}`, "META") as { workflow?: { definitionVersion: string; stage: string } } };
    };
    const adopt = () => h.dev(MAYA, "POST", "/v1/app/agents/rovara-code/adopt", { requestId: randomUUID(), version: 2 });
    return { ...h, run, adopt };
  }

  it("off (the default): an admin cannot adopt version 2 and tasks stay version 1", async () => {
    const t = await setup();
    const adopted = await t.adopt();
    expect(adopted.status).toBe(400);
    expect(adopted.body.error).toEqual({ code: "CONFIG_INVALID", message: "Version 2 of Rovara Code is not available yet." });
    expect((await t.run()).meta.workflow).toMatchObject({ definitionVersion: "1.0.0" });
  });

  it("off when the setting says false", async () => {
    vi.stubEnv("AGENTX_ROVARA_CODE_V2_ENABLED", "false");
    const t = await setup();
    expect((await t.adopt()).status).toBe(400);
  });

  it("on: an admin can adopt version 2, and the next task is 1.1.0; a task that existed keeps 1.0.0, and an org that has not adopted keeps version 1", async () => {
    vi.stubEnv("AGENTX_ROVARA_CODE_V2_ENABLED", "true");
    const t = await setup();
    // The switch alone moves no org: until an admin adopts version 2, a new task is still a 1.0.0 task.
    const before = await t.run();
    expect(before.meta.workflow).toMatchObject({ definitionVersion: "1.0.0", stage: "PLAN" });
    const adopted = await t.adopt();
    expect(adopted.status, JSON.stringify(adopted.body)).toBe(200);
    expect(t.db.get(builtinSettingsKey(TEST_ORG, "rovara-code").pk, builtinSettingsKey(TEST_ORG, "rovara-code").sk)).toMatchObject({ pinnedVersion: 2 });
    const after = await t.run();
    expect(after.meta.workflow).toMatchObject({ definitionVersion: "1.1.0" });
    // The task that was started before the adoption is untouched.
    expect((t.db.get(`DEVTASK#${before.taskId}`, "META") as { workflow?: { definitionVersion: string } }).workflow?.definitionVersion).toBe("1.0.0");
  });
});
