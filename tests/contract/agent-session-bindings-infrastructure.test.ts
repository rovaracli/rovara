// Plan 5 Task 20: the notifier binds a task's thread to its session in the transaction that records the thread, so its role gets exactly two more grants,
// by key: put the session's BINDING item and the reverse SESSION_SURFACE item, and check the session's own record. Nothing is read, updated or deleted.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Statement = { Effect: string; Action: string | string[]; Resource: unknown; Condition?: Record<string, Record<string, unknown>> };
type Policy = { Properties: { PolicyDocument: { Statement: Statement[] }; Roles: Array<{ Ref?: string }> } };
const statementsOf = (template: Template, rolePrefix: string) => ([...Object.values(template.findResources("AWS::IAM::Policy")), ...Object.values(template.findResources("AWS::IAM::ManagedPolicy"))] as Policy[])
  .filter((policy) => policy.Properties.Roles.some((role) => role.Ref?.startsWith(rolePrefix)))
  .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
const leading = (statement: Statement) => statement.Condition?.["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"] as string[] | undefined;
const stateTable = (template: Template) => {
  const [id] = Object.keys(template.findResources("AWS::DynamoDB::Table")).filter((logicalId) => logicalId.replace(/[0-9A-F]{8}$/, "") === "State");
  return { "Fn::GetAtt": [id, "Arn"] };
};

describe("the notifier's grants for binding a thread to a session", () => {
  const named = Template.fromStack(new ControlPlaneStack(new App(), "BindingsControlPlane", { naming: environmentNaming("live20") }));
  const notifier = () => statementsOf(named, "DeveloperTaskNotifierFunctionServiceRole");
  const aboutSessions = () => notifier().filter((statement) => JSON.stringify(leading(statement) ?? []).includes("AGENT_SESSION") || JSON.stringify(leading(statement) ?? []).includes("SESSION_SURFACE"));

  it("may put the session's binding and the surface item, in an org's own keys, and nothing else under sessions", () => {
    const puts = aboutSessions().filter((statement) => [statement.Action].flat().includes("dynamodb:PutItem"));
    expect(puts).toEqual([{
      Effect: "Allow", Action: "dynamodb:PutItem", Resource: stateTable(named),
      Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["ORG#org_????????????????????#AGENT_SESSION#*", "ORG#org_????????????????????#SESSION_SURFACE"] } },
    }]);
  });

  it("may check the session's own record, with a leading key it must present", () => {
    const checks = aboutSessions().filter((statement) => [statement.Action].flat().includes("dynamodb:ConditionCheckItem"));
    expect(checks).toEqual([{
      Effect: "Allow", Action: "dynamodb:ConditionCheckItem", Resource: stateTable(named),
      Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["ORG#org_????????????????????#AGENT_SESSION#*"] }, Null: { "dynamodb:LeadingKeys": "false" } },
    }]);
  });

  it("grants no read, update or delete on sessions", () => {
    const actions = aboutSessions().flatMap((statement) => [statement.Action].flat());
    expect(actions.sort()).toEqual(["dynamodb:ConditionCheckItem", "dynamodb:PutItem"]);
  });
});
