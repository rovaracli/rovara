// M1: the steps function reads the operator's TS-L self-test switch (SSM parameter `<worker settings prefix>tsl-selftest`). Only the STAGING install's role may read it, on exactly that one parameter; every other named
// environment's template, and the legacy one, carries no such grant (the function never asks there either, so no AccessDenied noise).
import { Stack } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { normalizedTemplate } from "../support/template-snapshot.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Properties: Record<string, unknown> };
type Statement = { Action?: string | string[]; Resource?: unknown };

function stepsStatements(context: Record<string, string>): Statement[] {
  const stack = buildAgentXApp(context).node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane")!;
  const resources = (normalizedTemplate(stack) as { Resources: Record<string, Resource> }).Resources;
  const steps = Object.entries(resources).find(([id, resource]) => id.startsWith("SessionsSteps") && resource.Type === "AWS::Lambda::Function")![1];
  const roleId = (steps.Properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
  return Object.values(resources).filter((resource) => resource.Type === "AWS::IAM::Policy" && (resource.Properties.Roles as Array<{ Ref?: string }>).some((role) => role.Ref === roleId))
    .flatMap((policy) => (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
}
const mentionsTsl = (statement: Statement) => JSON.stringify(statement.Resource).includes("tsl-selftest");

describe("the steps function's read of the TS-L self-test switch", () => {
  it("is one ssm:GetParameter on exactly /agentx/staging/tsl-selftest, in the staging template", () => {
    const grants = stepsStatements({ agentxEnv: "staging" }).filter(mentionsTsl);
    expect(grants).toHaveLength(1);
    expect(grants[0]!.Action).toBe("ssm:GetParameter");
    const resource = grants[0]!.Resource as { "Fn::Join": [string, unknown[]] };
    expect(resource["Fn::Join"][1].filter((part) => typeof part === "string").join("")).toBe("arn::ssm:::parameter/agentx/staging/tsl-selftest");
  }, 120_000);

  it("is in no other named environment's template, and not in the legacy one", () => {
    for (const context of [{ agentxEnv: "qa" }, { agentxEnv: "production" }, { agentxEnv: "staging-2" }, {}]) {
      expect(stepsStatements(context).filter(mentionsTsl), JSON.stringify(context)).toEqual([]);
    }
  }, 240_000);
});
