// ENV-ROOM review fix, the room the broker keeps. Lambda counts a function's variables as the JSON of the map, so every quote inside AGENTX_NAMES or AGENTX_SETTINGS costs two
// bytes (`\"`), and each entry of the inner JSON carried four of them. The two variables are now `code=value` pairs joined by commas (`ts=name,ar=name`): the values are
// already refused unless they hold no quote, comma, brace, slash, space or equals sign (infra/lib/broker-names.ts), so nothing is escaped or quoted. The decoders still accept
// the JSON form (the earlier revision's environment) for one release, so a rollout in either direction starts.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { BROKER_NAMES_VARIABLE, BROKER_SETTINGS_VARIABLE } from "@agentx/cloud-contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { brokerNamesFromEnvironment, brokerSettingsFromEnvironment, hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { lambdaEnvironments, DEPLOY_PARAMETER_VALUES, type Template as ResolvableTemplate } from "../support/lambda-environment-size.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const SCOPE = { AWS_REGION: "us-west-2", AGENTX_ACCOUNT_ID: "123456789012", AGENTX_ENV: "staging" };
/** Hydrated, without the list variable itself (which differs in form between the two). */
const hydrated = (env: MutableEnvironment): MutableEnvironment => { const copy = { ...env }; hydrateBrokerEnvironment(copy); delete copy[BROKER_NAMES_VARIABLE]; delete copy[BROKER_SETTINGS_VARIABLE]; return copy; };

describe("the compact form (code=value, joined by commas)", () => {
  it("reads names, to the same variables as the JSON form did", () => {
    const compact = hydrated({ ...SCOPE, [BROKER_NAMES_VARIABLE]: "ts=state-table,ar=artifact-bucket,lt=lt-0123456789abcdef0,sq=slack-q.fifo" });
    const json = hydrated({ ...SCOPE, [BROKER_NAMES_VARIABLE]: JSON.stringify({ ts: "state-table", ar: "artifact-bucket", lt: "lt-0123456789abcdef0", sq: "slack-q.fifo" }) });
    expect(compact).toEqual(json);
    expect(compact.STATE_TABLE_NAME).toBe("state-table");
    expect(compact.SLACK_REQUEST_QUEUE_URL).toBe("https://sqs.us-west-2.amazonaws.com/123456789012/slack-q.fifo");
  });

  it("reads settings, an empty one too, to the same variables as the JSON form did", () => {
    const compact = hydrated({ [BROKER_SETTINGS_VARIABLE]: "ml=3,tm=,ss=enabled,os=1761000000" });
    expect(compact.SLACK_MEMBER_WORKSPACE_LIMIT).toBe("3");
    expect(compact.SLACK_TEAM_ID).toBe("");
    expect(compact.DEVELOPER_SIGNIN_SLACK).toBe("enabled");
    expect(compact).toEqual(hydrated({ [BROKER_SETTINGS_VARIABLE]: JSON.stringify({ ml: "3", tm: "", ss: "enabled", os: "1761000000" }) }));
  });

  it("still reads the JSON form (the earlier revision's environment), names and settings", () => {
    expect(brokerNamesFromEnvironment({ [BROKER_NAMES_VARIABLE]: '{"ts":"t"}' }).map((entry) => entry.value)).toEqual(["t"]);
    expect(brokerSettingsFromEnvironment({ [BROKER_SETTINGS_VARIABLE]: '{"ss":"enabled"}' }).map((entry) => entry.value)).toEqual(["enabled"]);
  });

  it("ignores an unknown code, as the JSON form does", () => {
    expect(brokerNamesFromEnvironment({ [BROKER_NAMES_VARIABLE]: "ts=t,zz=x" }).map((entry) => entry.spec.code)).toEqual(["ts"]);
    expect(brokerSettingsFromEnvironment({ [BROKER_SETTINGS_VARIABLE]: "ss=enabled,zz=1" }).map((entry) => entry.spec.code)).toEqual(["ss"]);
  });

  it.each([
    ["a code with no value", "ts"],
    ["an empty pair", "ts=t,,ar=b"],
    ["a trailing comma", "ts=t,"],
    ["a value with another equals sign", "ts=a=b"],
    ["a code that is not two lowercase letters", "TS=t"],
    ["a code given twice", "ts=a,ts=b"],
    ["a value with a slash", "ts=a/b"],
    ["a value with a quote", 'ts=a"b'],
    ["a value with a space", "ts=a b"],
    ["an empty name", "ts="],
  ])("refuses %s", (_label, value) => {
    expect(() => brokerNamesFromEnvironment({ [BROKER_NAMES_VARIABLE]: value })).toThrow(/AGENTX_NAMES/);
  });

  it.each([
    ["a value with a slash", "tm=a/b"],
    ["a value with a quote", 'tm=a"b'],
    ["a value that is too long", `tm=${"T".repeat(65)}`],
    ["a code given twice", "ss=enabled,ss=disabled"],
    ["a pair with no equals sign", "ss"],
  ])("refuses a setting with %s", (_label, value) => {
    expect(() => brokerSettingsFromEnvironment({ [BROKER_SETTINGS_VARIABLE]: value })).toThrow(/AGENTX_SETTINGS/);
  });
});

describe("the control plane writes the compact form", () => {
  const broker = (): Record<string, string> => {
    const app = buildAgentXApp({ agentxEnv: "staging", agentxCloud: true });
    const stack = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane")!;
    const found = lambdaEnvironments(Template.fromStack(stack).toJSON() as ResolvableTemplate, { env: "staging", stackName: stack.stackName, parameterValues: DEPLOY_PARAMETER_VALUES })
      .find((entry) => /^Broker[0-9A-F]{8}$/.test(entry.logicalId));
    return found!.variables;
  };

  it("has no quote, brace or space in AGENTX_NAMES or AGENTX_SETTINGS, and the broker reads every entry back", () => {
    const variables = broker();
    for (const name of [BROKER_NAMES_VARIABLE, BROKER_SETTINGS_VARIABLE]) {
      expect(variables[name], name).toMatch(/^[a-z]{2}=[A-Za-z0-9._:-]*(,[a-z]{2}=[A-Za-z0-9._:-]*)*$/);
    }
    const names = brokerNamesFromEnvironment(variables);
    expect(names.length).toBe(variables[BROKER_NAMES_VARIABLE]!.split(",").length);
    const settings = brokerSettingsFromEnvironment(variables);
    expect(settings.length).toBe(variables[BROKER_SETTINGS_VARIABLE]!.split(",").length);
  });
});
