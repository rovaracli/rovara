// SIGNIN-COND-STYLE: the sign-in function's ConditionCheckItem grants limit the keys with ForAllValues:StringLike on dynamodb:LeadingKeys. ForAllValues is true when the key is absent, so each grant
// carries `Null: { "dynamodb:LeadingKeys": "false" }` as well (the style of the notifier's and the broker's), which makes an absent key a refusal rather than a match.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Statement = { Effect: string; Action: string | string[]; Resource: unknown; Condition?: Record<string, Record<string, unknown>> };
type Resource = { Type: string; Properties: Record<string, unknown> };

describe("the sign-in function's ConditionCheckItem grants", () => {
  const app = buildAgentXApp({ agentxEnv: "staging", agentxCloud: true });
  const control = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.stackName === "agentx-staging-control-plane")!;
  const resources = Template.fromStack(control).toJSON().Resources as Record<string, Resource>;
  const checks = Object.entries(resources)
    .filter(([id, resource]) => resource.Type === "AWS::IAM::Policy" && /^DeveloperSignIn/u.test(id))
    .flatMap(([, resource]) => (resource.Properties.PolicyDocument as { Statement: Statement[] }).Statement)
    .filter((statement) => [statement.Action].flat().includes("dynamodb:ConditionCheckItem"));

  it("exist: one on the developer records of the sign-in table and one on the org, developer-org and pointer keys of the state table", () => {
    expect(checks.map((statement) => (statement.Condition?.["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"] as unknown[]).length).sort()).toEqual([1, 2]);
  });

  it("each limits the leading keys and requires that the key is present", () => {
    for (const statement of checks) {
      expect(statement.Condition?.["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"]).toBeDefined();
      expect(statement.Condition?.Null).toEqual({ "dynamodb:LeadingKeys": "false" });
    }
  });
});
