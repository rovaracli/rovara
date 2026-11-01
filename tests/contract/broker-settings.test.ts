// ENV-ROOM (owner decision 2026-10-24). The broker's environment is held to 4 KB; its settings are constrained values (a flag, a number, a Slack team id) that arrive in
// one JSON variable, AGENTX_SETTINGS, under two-letter codes, as its names do, and the broker puts each back under the variable its code has always read
// (BROKER_SETTINGS in @agentx/contracts). The names that were variables of their own (the State table, the artifact bucket, the launch template, the allow list, the
// model proxy) join AGENTX_NAMES. This pins the table, the hydration, and that the control plane wires each to the parameter or resource it came from.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { BROKER_NAMES, BROKER_NAMES_VARIABLE, BROKER_SETTINGS, BROKER_SETTINGS_VARIABLE, type BrokerSettingKey } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { brokerSettingsFromEnvironment, hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { brokerNamesIn, brokerSettingsIn } from "../support/broker-names-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const SCOPE = { AWS_REGION: "us-west-2", AGENTX_ACCOUNT_ID: "123456789012", AGENTX_ENV: "staging" };
const bag = (settings: Partial<Record<BrokerSettingKey, string>>) =>
  JSON.stringify(Object.fromEntries(Object.entries(settings).map(([key, value]) => [BROKER_SETTINGS[key as BrokerSettingKey].code, value])));
const hydrated = (env: MutableEnvironment): MutableEnvironment => { const copy = { ...env }; hydrateBrokerEnvironment(copy); return copy; };

describe("the table of settings", () => {
  it("has a distinct two-letter code and a distinct variable for each setting", () => {
    const specs = Object.values(BROKER_SETTINGS);
    expect(new Set(specs.map((spec) => spec.code)).size).toBe(specs.length);
    expect(new Set(specs.map((spec) => spec.variable)).size).toBe(specs.length);
    for (const spec of specs) expect(spec.code).toMatch(/^[a-z]{2}$/);
  });

  it("shares no variable with the names", () => {
    const names = new Set<string>(Object.values(BROKER_NAMES).map((spec) => spec.variable));
    for (const spec of Object.values(BROKER_SETTINGS)) expect(names.has(spec.variable), spec.variable).toBe(false);
  });
});

describe("hydrateBrokerEnvironment: the settings (AGENTX_SETTINGS)", () => {
  const ALL: Record<BrokerSettingKey, string> = {
    memberWorkspaceLimit: "3", organizationWorkspaceLimit: "20",
    taskPeopleChanges: "true", taskPeoplePublicInvitations: "false", taskPeoplePrivateInvitations: "true", workflowDependencies: "false",
    slackTeamId: "T0123456789", signInSlack: "enabled", signInSlackSince: "1761000000", oidcSince: "0", mcpConfirmElicitation: "disabled", rovaraCodeV2: "false", planSelfCheck: "true", autofix: "false", liveSteer: "1", liveRedirect: "1", liveAsk: "0", liveFix: "0", proofEvidence: "0", decisionCards: "1", testEnvironment: "0", learningSuggestionsDefault: "off",
  };

  it("puts every setting back under the variable the broker reads, to the text it was given", () => {
    const env = hydrated({ ...SCOPE, [BROKER_SETTINGS_VARIABLE]: bag(ALL) });
    for (const [key, spec] of Object.entries(BROKER_SETTINGS)) expect(env[spec.variable], spec.variable).toBe(ALL[key as BrokerSettingKey]);
  });

  it("needs no names, and sets an empty setting as empty (an install that leaves the Slack team out)", () => {
    const env = hydrated({ [BROKER_SETTINGS_VARIABLE]: bag({ slackTeamId: "" }) });
    expect(env.SLACK_TEAM_ID).toBe("");
    expect(Object.keys(env).sort()).toEqual([BROKER_SETTINGS_VARIABLE, "SLACK_TEAM_ID"].sort());
  });

  it("does not replace a variable that is set", () => {
    const env = hydrated({ ...SCOPE, [BROKER_SETTINGS_VARIABLE]: bag(ALL), SLACK_TEAM_ID: "given", MCP_CONFIRM_ELICITATION: "given" });
    expect(env.SLACK_TEAM_ID).toBe("given");
    expect(env.MCP_CONFIRM_ELICITATION).toBe("given");
    expect(env.AGENTX_WORKFLOW_DEPENDENCIES_ENABLED).toBe("false");
  });

  it("holds only the settings that were sent", () => {
    const env = hydrated({ [BROKER_SETTINGS_VARIABLE]: bag({ signInSlack: "enabled" }) });
    expect(env.DEVELOPER_SIGNIN_SLACK).toBe("enabled");
    expect(env.SLACK_TEAM_ID).toBeUndefined();
  });

  it.each([
    ["not JSON", "{"],
    ["not an object", JSON.stringify(["a"])],
    ["a value that is not text", JSON.stringify({ ml: 3 })],
    ["a value with a quote", JSON.stringify({ tm: 'T"1' })],
    ["a value with a slash", JSON.stringify({ tm: "a/b" })],
    ["a value with a space", JSON.stringify({ ss: "en abled" })],
    ["a value that is too long", JSON.stringify({ tm: "T".repeat(65) })],
  ])("refuses a list that is %s, so a broker that cannot read its settings does not start", (_label, value) => {
    expect(() => hydrated({ [BROKER_SETTINGS_VARIABLE]: value })).toThrow(/AGENTX_SETTINGS/);
    expect(() => brokerSettingsFromEnvironment({ [BROKER_SETTINGS_VARIABLE]: value })).toThrow(/AGENTX_SETTINGS/);
  });

  it("changes nothing where AGENTX_SETTINGS is absent or empty (the legacy install passes its variables whole)", () => {
    const before = { ...SCOPE, SLACK_MEMBER_WORKSPACE_LIMIT: "3" };
    expect(hydrated(before)).toEqual(before);
    expect(hydrated({ ...before, [BROKER_SETTINGS_VARIABLE]: "" })).toEqual({ ...before, [BROKER_SETTINGS_VARIABLE]: "" });
  });
});

describe("hydrateBrokerEnvironment: the names that were variables of their own", () => {
  const names = (value: Record<string, string>) => ({ ...SCOPE, [BROKER_NAMES_VARIABLE]: JSON.stringify(value) });

  it("puts the State table, the artifact bucket, the launch template and the allow list back under their variables, as they were", () => {
    const env = hydrated(names({ ts: "state-table", ar: "artifact-bucket", lt: "lt-0123456789abcdef0", pl: "rslvr-fdl-0123456789abcdef" }));
    expect(env).toMatchObject({ STATE_TABLE_NAME: "state-table", ARTIFACT_BUCKET_NAME: "artifact-bucket", EC2_WORKER_LAUNCH_TEMPLATE_ID: "lt-0123456789abcdef0", AGENT_PROJECT_ALLOW_LIST_ID: "rslvr-fdl-0123456789abcdef" });
  });

  it("builds the model proxy's URL from the load balancer's name: its host is <name>.<region>.elb.amazonaws.com, on the inference port", () => {
    expect(hydrated(names({ mp: "internal-agentx-proxy-1234567890" })).MODEL_PROXY_URL).toBe("http://internal-agentx-proxy-1234567890.us-west-2.elb.amazonaws.com:4000");
    expect(hydrated({ ...names({ mp: "internal-p-1" }), AWS_REGION: "cn-north-1" }).MODEL_PROXY_URL).toBe("http://internal-p-1.cn-north-1.elb.amazonaws.com.cn:4000");
  });
});

describe("the control plane wires each setting and name to what it came from", () => {
  const broker = (env: string, context: Record<string, unknown>): Record<string, unknown> => {
    const app = buildAgentXApp({ agentxEnv: env, ...context });
    for (const stack of app.node.children.filter((child): child is Stack => Stack.isStack(child))) {
      const found = Object.entries(Template.fromStack(stack).toJSON().Resources as Record<string, { Type: string; Properties: { Environment?: { Variables?: Record<string, unknown> } } }>)
        .find(([id, resource]) => resource.Type === "AWS::Lambda::Function" && /^Broker[0-9A-F]{8}$/.test(id));
      if (found !== undefined) return found[1].Properties.Environment!.Variables!;
    }
    throw new Error("no broker");
  };
  const cloud = broker("staging", { agentxCloud: true });

  it("gives each setting the parameter of that name, and no variable of its own", () => {
    expect(brokerSettingsIn(cloud)).toEqual({
      memberWorkspaceLimit: { Ref: "SlackMemberWorkspaceLimit" },
      organizationWorkspaceLimit: { Ref: "SlackOrganizationWorkspaceLimit" },
      taskPeopleChanges: { Ref: "TaskPeopleChangesEnabled" },
      taskPeoplePublicInvitations: { Ref: "TaskPeoplePublicInvitationsEnabled" },
      taskPeoplePrivateInvitations: { Ref: "TaskPeoplePrivateInvitationsEnabled" },
      workflowDependencies: { Ref: "WorkflowDependenciesEnabled" },
      slackTeamId: { Ref: "SlackTeamId" },
      signInSlack: { Ref: "DeveloperSignInSlack" },
      signInSlackSince: { Ref: "DeveloperSignInSlackSince" },
      oidcSince: { Ref: "DeveloperOidcSince" },
      mcpConfirmElicitation: { Ref: "McpConfirmElicitation" },
      rovaraCodeV2: { Ref: "RovaraCodeV2Enabled" },
      planSelfCheck: { Ref: "PlanSelfCheckEnabled" },
      autofix: { Ref: "AutofixEnabled" },
      liveSteer: { Ref: "LiveSteerEnabled" },
      liveRedirect: { Ref: "LiveRedirectEnabled" },
      liveAsk: { Ref: "LiveAskEnabled" },
      liveFix: { Ref: "LiveFixEnabled" },
      proofEvidence: { Ref: "ProofEvidenceEnabled" },
      decisionCards: { Ref: "DecisionCardsEnabled" },
      testEnvironment: { Ref: "TestEnvironmentEnabled" },
      learningSuggestionsDefault: { Ref: "LearningSuggestionsDefault" },
    });
    for (const spec of Object.values(BROKER_SETTINGS)) expect(cloud, spec.variable).not.toHaveProperty(spec.variable);
  });

  it("gives the names that were variables of their own the resources and parameters they were", () => {
    const found = brokerNamesIn(cloud);
    expect(found.launchTemplate).toEqual({ Ref: "Ec2WorkerLaunchTemplateId" });
    expect(found.projectAllowList).toEqual({ Ref: "ProjectAllowListId" });
    expect(found.stateTable).toEqual({ Ref: expect.stringMatching(/^State/) as string });
    expect(found.artifactBucket).toEqual({ Ref: expect.stringMatching(/^Artifacts/) as string });
    expect(found.modelProxy).toEqual({ "Fn::Select": [0, { "Fn::Split": [".", { "Fn::GetAtt": [expect.stringMatching(/^ModelProxy/), "DNSName"] }] }] });
    for (const variable of ["STATE_TABLE_NAME", "ARTIFACT_BUCKET_NAME", "EC2_WORKER_LAUNCH_TEMPLATE_ID", "AGENT_PROJECT_ALLOW_LIST_ID", "MODEL_PROXY_URL", "AUDIT_INTAKE_QUEUE_URL"]) expect(cloud, variable).not.toHaveProperty(variable);
  });
});
