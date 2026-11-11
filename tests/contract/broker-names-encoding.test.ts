// ENV-ROOM review fix. AGENTX_NAMES and AGENTX_SETTINGS are JSON joined from CloudFormation values without escaping, so a value that could carry a quote, a comma, a brace
// or a slash would break the broker's JSON (or add a code). A literal is refused when it is added; a parameter is refused at synthesis unless its AllowedPattern or
// AllowedValues keeps those characters out. ProjectAllowListId and Ec2WorkerLaunchTemplateId were unconstrained and became names; they now carry the pattern of the id
// AWS gives them (a Route 53 Resolver DNS Firewall domain list, an EC2 launch template).
import { App, CfnParameter, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { describe, expect, it } from "vitest";
import { BROKER_NAMES_VARIABLE, BROKER_SETTINGS_VARIABLE } from "@agentx/cloud-contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { BrokerNames, BrokerSettings } from "../../infra/lib/broker-names.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

/** What must never reach the JSON: it ends a string, a pair or the object, or escapes. */
const SEPARATORS = ['"', "\\", ",", "=", "{", "}", "/", " ", "\n"];
const probes = (valid: string): string[] => SEPARATORS.flatMap((separator) => [separator, `a${separator}b`, `${valid}${separator}`, `${separator}${valid}`, `${valid.slice(0, 3)}${separator}${valid.slice(3)}`]);

type Node = unknown;
interface Parameter { Type: string; AllowedPattern?: string; AllowedValues?: string[] }

function brokerVariables(template: { Resources: Record<string, { Type: string; Properties?: Record<string, unknown> }> }): Record<string, Node> | undefined {
  for (const resource of Object.values(template.Resources)) {
    if (resource.Type !== "AWS::Lambda::Function") continue;
    const variables = (resource.Properties?.Environment as { Variables?: Record<string, Node> } | undefined)?.Variables;
    if (variables?.[BROKER_NAMES_VARIABLE] !== undefined) return variables;
  }
  return undefined;
}

/** Every Ref to a parameter inside the node the variable is joined from. */
function parameterRefs(node: Node, parameters: Record<string, Parameter>, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) node.forEach((entry) => parameterRefs(entry, parameters, found));
  else if (node !== null && typeof node === "object") {
    const record = node as Record<string, Node>;
    if (typeof record.Ref === "string" && record.Ref in parameters) found.add(record.Ref);
    Object.values(record).forEach((entry) => parameterRefs(entry, parameters, found));
  }
  return found;
}

const controlPlane = (context: Record<string, unknown>) => {
  const app = buildAgentXApp({ agentxEnv: "staging", ...context });
  const stack = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane");
  expect(stack, "the app has a control plane").toBeDefined();
  return Template.fromStack(stack!).toJSON() as { Parameters: Record<string, Parameter>; Resources: Record<string, { Type: string; Properties?: Record<string, unknown> }> };
};

describe("the two ids that joined the broker's names", () => {
  const cloud = controlPlane({ agentxCloud: true });
  const REAL = [
    ["ProjectAllowListId", ["rslvr-fdl-0123456789abcdef", "rslvr-fdl-2c46f2ecfa5d4cf1"]],
    ["Ec2WorkerLaunchTemplateId", ["lt-0123456789abcdef0", "lt-0a1b2c3d4e5f60718"]],
  ] as const;

  for (const [name, ids] of REAL) {
    it(`${name} has an AllowedPattern that accepts the ids AWS gives and refuses a quote, a separator or a slash`, () => {
      const pattern = cloud.Parameters[name]?.AllowedPattern;
      expect(pattern, `${name} is constrained`).toBeDefined();
      const accepts = new RegExp(pattern!);
      for (const id of ids) expect(accepts.test(id), id).toBe(true);
      for (const probe of probes(ids[0])) expect(accepts.test(probe), JSON.stringify(probe)).toBe(false);
    });
  }

  it("Ec2WorkerLaunchTemplateId is constrained in a non-cloud named install too", () => {
    expect(controlPlane({}).Parameters.Ec2WorkerLaunchTemplateId?.AllowedPattern).toBeDefined();
  });
});

describe("every parameter in AGENTX_NAMES and AGENTX_SETTINGS keeps JSON-breaking characters out", () => {
  for (const [label, context] of [["cloud", { agentxCloud: true }], ["self-hosted", {}]] as const) {
    it(`${label}: each is a Number, or has an AllowedValues list or an AllowedPattern that refuses every separator`, () => {
      const template = controlPlane(context);
      const variables = brokerVariables(template);
      expect(variables, "the broker has AGENTX_NAMES").toBeDefined();
      const refs = new Set([...parameterRefs(variables![BROKER_NAMES_VARIABLE], template.Parameters), ...parameterRefs(variables![BROKER_SETTINGS_VARIABLE], template.Parameters)]);
      expect(refs.size).toBeGreaterThan(5);
      for (const name of refs) {
        const parameter = template.Parameters[name]!;
        if (parameter.Type === "Number") continue;
        if (parameter.AllowedValues !== undefined) {
          for (const value of parameter.AllowedValues) for (const separator of SEPARATORS) expect(value, `${name} allows ${JSON.stringify(value)}`).not.toContain(separator);
          continue;
        }
        expect(parameter.AllowedPattern, `${name} is packed into the broker's JSON, so it needs an AllowedPattern`).toBeDefined();
        const accepts = new RegExp(parameter.AllowedPattern!);
        for (const probe of probes("T0123456789")) expect(accepts.test(probe), `${name} accepts ${JSON.stringify(probe)}`).toBe(false);
      }
    });
  }
});

describe("BrokerNames and BrokerSettings refuse a value that could break the JSON", () => {
  const broker = (): { stack: Stack; fn: lambda.Function } => {
    const stack = new Stack(new App(), "S");
    const fn = new lambda.Function(stack, "Broker", { runtime: lambda.Runtime.NODEJS_22_X, handler: "index.handler", code: lambda.Code.fromInline("exports.handler = async () => {};") });
    return { stack, fn };
  };
  const parameter = (stack: Stack, props: Partial<ConstructorParameters<typeof CfnParameter>[2]>) => new CfnParameter(stack, "Id", { type: "String", ...props }).valueAsString;

  it("refuses a literal name with a quote, a comma, a slash or a space, when it is added", () => {
    for (const bad of ['a"b', "a,b", "a/b", "a b", "a}b", "a\\b", ""]) {
      const { fn } = broker();
      expect(() => BrokerNames.of(fn).add("launchTemplate", bad), JSON.stringify(bad)).toThrow(/launchTemplate/);
    }
    const { fn } = broker();
    expect(() => BrokerNames.of(fn).add("launchTemplate", "lt-0123456789abcdef0")).not.toThrow();
  });

  it("refuses a literal setting with a separator, when it is added", () => {
    const { fn } = broker();
    expect(() => BrokerSettings.of(fn).add("slackTeamId", 'T0"1')).toThrow(/slackTeamId/);
    expect(() => BrokerSettings.of(fn).add("signInSlack", "enabled")).not.toThrow();
  });

  it("refuses at synthesis a name from a parameter with no AllowedPattern", () => {
    const { stack, fn } = broker();
    BrokerNames.of(fn).add("launchTemplate", parameter(stack, {}));
    expect(() => Template.fromStack(stack)).toThrow(/Id.*launchTemplate|launchTemplate.*Id/s);
  });

  it("refuses at synthesis a name from a parameter whose pattern lets a quote or a slash through", () => {
    for (const allowedPattern of [".*", "^lt-.*$", "^[^ ]+$", "^[a-z0-9\"/-]+$"]) {
      const { stack, fn } = broker();
      BrokerNames.of(fn).add("launchTemplate", parameter(stack, { allowedPattern }));
      expect(() => Template.fromStack(stack), allowedPattern).toThrow(/launchTemplate/);
    }
  });

  it("refuses at synthesis a setting from a parameter with no constraint, or an allowed list with a quote", () => {
    for (const props of [{}, { allowedValues: ["on", 'of"f'] }]) {
      const { stack, fn } = broker();
      BrokerSettings.of(fn).add("signInSlack", parameter(stack, props));
      expect(() => Template.fromStack(stack)).toThrow(/signInSlack/);
    }
  });

  it("passes a real launch template id pattern, an allowed list, a Number and a derived token", () => {
    const { stack, fn } = broker();
    BrokerNames.of(fn).add("launchTemplate", parameter(stack, { allowedPattern: "^lt-[0-9a-f]{17}$" }));
    BrokerNames.of(fn).add("stateTable", `${stack.stackName}-table`);
    BrokerSettings.of(fn).add("signInSlack", new CfnParameter(stack, "Flag", { type: "String", allowedValues: ["enabled", "disabled"] }).valueAsString);
    BrokerSettings.of(fn).add("memberWorkspaceLimit", new CfnParameter(stack, "Limit", { type: "Number", default: 3 }).valueAsString);
    expect(() => Template.fromStack(stack)).not.toThrow();
  });
});
