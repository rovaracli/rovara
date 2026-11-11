// Live interaction A2 (peek, for Ask), infrastructure (LA-1): the broker may invoke the dispatcher, and only the dispatcher, to read a running task's working tree; it is told which function by name
// in its one variable of names, and builds DISPATCHER_FUNCTION_ARN from it. Named environments only (live interaction is). Nothing is deployed by this: it is the synthesized template.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { BROKER_NAMES, BROKER_NAMES_VARIABLE } from "@agentx/cloud-contracts";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { brokerNamesIn } from "../support/broker-names-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown };
type Policy = { Properties: { PolicyDocument: { Statement: Statement[] }; Roles: Array<{ Ref?: string }> } };
type LambdaFunction = { Properties: { Role: { "Fn::GetAtt": [string, string] }; Environment?: { Variables?: Record<string, unknown> } } };

const named = Template.fromStack(new ControlPlaneStack(new App(), "PeekControlPlane", { naming: environmentNaming("staging") }));
const legacy = Template.fromStack(new ControlPlaneStack(new App(), "PeekLegacyControlPlane"));
const functionNamed = (template: Template, prefix: string) => Object.entries(template.findResources("AWS::Lambda::Function") as Record<string, LambdaFunction>).find(([id]) => id.startsWith(prefix))!;
const policies = (template: Template) => [...Object.values(template.findResources("AWS::IAM::Policy")), ...Object.values(template.findResources("AWS::IAM::ManagedPolicy"))] as Policy[];
const actionsOf = (statement: Statement) => [statement.Action].flat();
const invokes = (template: Template) => policies(template).flatMap((policy) => policy.Properties.PolicyDocument.Statement.filter((statement) => actionsOf(statement).includes("lambda:InvokeFunction")).map((statement) => ({ policy, statement })));

describe("the broker may invoke the dispatcher to peek (LA-1)", () => {
  const dispatcher = functionNamed(named, "Dispatcher");
  const broker = functionNamed(named, "Broker");
  const brokerRole = broker[1].Properties.Role["Fn::GetAtt"][0];

  it("grants lambda:InvokeFunction on the dispatcher function's own ARN, to the broker's role alone, with no wildcard over functions", () => {
    const grants = invokes(named).filter(({ statement }) => JSON.stringify(statement.Resource).includes(dispatcher[0]));
    expect(grants.length).toBeGreaterThan(0);
    for (const { policy, statement } of grants) {
      expect(statement.Effect).toBe("Allow");
      expect(actionsOf(statement)).toEqual(["lambda:InvokeFunction"]);
      expect(policy.Properties.Roles).toEqual([{ Ref: brokerRole }]);
      // The broker's other invoke grants share this statement (the template merges same-shaped ones); every resource in it is one function's own ARN, or that ARN's versions and aliases.
      for (const resource of [statement.Resource].flat()) {
        const text = JSON.stringify(resource);
        expect(text, text).toMatch(/^\{"Fn::GetAtt":\["[A-Za-z0-9]+","Arn"\]\}$|^\{"Fn::Join":\["",\[\{"Fn::GetAtt":\["[A-Za-z0-9]+","Arn"\]\},":\*"\]\]\}$/u);
      }
    }
    // The dispatcher itself is named, once as its ARN and once with its versions and aliases.
    const resources = grants.flatMap(({ statement }) => [statement.Resource].flat().map((resource) => JSON.stringify(resource)));
    expect(resources.filter((resource) => resource.includes(dispatcher[0]))).toHaveLength(2);
    // No other role in the stack may invoke the dispatcher.
    expect(new Set(grants.flatMap(({ policy }) => policy.Properties.Roles.map((role) => role.Ref)))).toEqual(new Set([brokerRole]));
  });

  it("tells the broker the dispatcher's name in its names (not a variable of its own), and the broker builds DISPATCHER_FUNCTION_ARN from it", () => {
    expect(BROKER_NAMES.dispatcherFunction).toEqual({ code: "dp", variable: "DISPATCHER_FUNCTION_ARN", kind: "lambdaFunctionArn" });
    expect(broker[1].Properties.Environment?.Variables).not.toHaveProperty("DISPATCHER_FUNCTION_ARN");
    expect(brokerNamesIn(broker[1].Properties.Environment?.Variables).dispatcherFunction).toEqual({ Ref: dispatcher[0] });
    const env: MutableEnvironment = { [BROKER_NAMES_VARIABLE]: "dp=agentx-staging-Dispatcher-AbCd1234", AWS_REGION: "us-west-2", AGENTX_ACCOUNT_ID: "944937319445", AGENTX_ENV: "staging" };
    hydrateBrokerEnvironment(env);
    expect(env["DISPATCHER_FUNCTION_ARN"]).toBe("arn:aws:lambda:us-west-2:944937319445:function:agentx-staging-Dispatcher-AbCd1234");
  });

  it("tells the dispatcher its dispatch queue's ARN, so it takes a batch only from that queue (S2)", () => {
    for (const template of [named, legacy]) {
      const variables = functionNamed(template, "Dispatcher")[1].Properties.Environment?.Variables ?? {};
      expect(variables["DISPATCH_QUEUE_ARN"]).toEqual({ "Fn::GetAtt": [expect.stringMatching(/^DispatchQueue/u), "Arn"] });
    }
  });

  it("adds nothing to the released (legacy) template: no name, no variable, no invoke grant on the dispatcher", () => {
    const legacyDispatcher = functionNamed(legacy, "Dispatcher");
    expect(JSON.stringify(legacy.toJSON())).not.toContain("DISPATCHER_FUNCTION_ARN");
    expect(invokes(legacy).filter(({ statement }) => JSON.stringify(statement.Resource).includes(legacyDispatcher[0]))).toEqual([]);
    expect(brokerNamesIn(functionNamed(legacy, "Broker")[1].Properties.Environment?.Variables).dispatcherFunction).toBeUndefined();
  });
});
