// M1: the steps function reads the operator's TS-L self-test switch (SSM parameter `<worker settings prefix>tsl-selftest`). A published template is the placeholder environment's with the name replaced (template-rendering.test.ts), so a
// resource that only staging has cannot be left out of it by name in the CDK code: it is one separate policy on the steps role behind a CloudFormation condition (SessionsTslSelftestIsStaging...) (Fn::Equals [<environment name>, "staging"]).
// The condition is true for the environment named exactly `staging` and false for every other, so no other environment gets the permission (nor the function the wish to ask: it wires the read only for the staging prefix). The legacy
// template has none of it.
import { Stack } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { normalizedTemplate } from "../support/template-snapshot.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Condition?: string; Properties: Record<string, unknown> };
type Statement = { Action?: string | string[]; Effect?: string; Resource?: unknown };
type Template = { Conditions?: Record<string, unknown>; Resources: Record<string, Resource> };

const controlPlane = (context: Record<string, string>): Template => {
  const stack = buildAgentXApp(context).node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane")!;
  return normalizedTemplate(stack) as Template;
};
const mentionsTsl = (value: unknown) => JSON.stringify(value).includes("tsl-selftest");
/** The policies of the template that name the parameter, with the role they attach to. */
const tslPolicies = (template: Template) => Object.entries(template.Resources).filter(([, resource]) => resource.Type === "AWS::IAM::Policy" && mentionsTsl(resource.Properties));
const arnText = (resource: unknown) => (resource as { "Fn::Join": [string, unknown[]] })["Fn::Join"][1].filter((part) => typeof part === "string").join("");

describe("the steps function's read of the TS-L self-test switch", () => {
  it("is one separate policy of one ssm:GetParameter on exactly <prefix>tsl-selftest, behind the staging condition, on the steps function's role", () => {
    for (const env of ["staging", "qa", "production", "staging-2"]) {
      const template = controlPlane({ agentxEnv: env });
      const found = tslPolicies(template);
      expect(found, env).toHaveLength(1);
      const [, policy] = found[0]!;
      expect(policy.Condition, env).toMatch(/^SessionsTslSelftestIsStaging[0-9A-F]{8}$/u);
      expect(template.Conditions?.[policy.Condition!], env).toEqual({ "Fn::Equals": [env, "staging"] });
      const statements = (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement;
      expect(statements, env).toHaveLength(1);
      expect(statements[0]!.Action, env).toBe("ssm:GetParameter");
      expect(statements[0]!.Effect, env).toBe("Allow");
      expect(arnText(statements[0]!.Resource), env).toBe(`arn::ssm:::parameter/agentx/${env}/tsl-selftest`);
      // It is attached to the steps function's role, and to no other.
      const roles = policy.Properties.Roles as Array<{ Ref: string }>;
      expect(roles, env).toHaveLength(1);
      const steps = Object.values(template.Resources).find((resource) => resource.Type === "AWS::Lambda::Function" && JSON.stringify(resource.Properties).includes("WORKER_SETTINGS_PREFIX") && JSON.stringify(resource.Properties).includes("INVOKE_SIGNING_KEY_ARN"))!;
      expect((steps.Properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0], env).toBe(roles[0]!.Ref);
    }
  }, 600_000);

  it("is named by no other resource of the template: only that one conditional policy (the function's own settings do not carry it)", () => {
    const template = controlPlane({ agentxEnv: "qa" });
    const [policyId] = tslPolicies(template)[0]!;
    expect(Object.entries(template.Resources).filter(([id, resource]) => id !== policyId && mentionsTsl(resource.Properties)).map(([id]) => id)).toEqual([]);
  }, 300_000);

  it("is not in the legacy template", () => {
    expect(tslPolicies(controlPlane({}))).toEqual([]);
    expect(Object.keys(controlPlane({}).Conditions ?? {}).filter((id) => id.includes("TslSelftest"))).toEqual([]);
  }, 300_000);
});
