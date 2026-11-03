// cfn-lint does not resolve Fn::GetAtt <Role>.Arn, so it never sees an IAM path in a role ARN that a property's pattern refuses
// (staging, 2026-11-03: AWS::ECR::RepositoryCreationTemplate CustomRoleArn, "failed validation constraint for keyword [pattern]"). This test builds the ARN each such
// role would really have (arn:aws:iam::<account>:role + Path + RoleName) and checks it against that property's CloudFormation pattern, over every synthesized stack.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Json = Record<string, unknown>;
type Resource = { Type: string; Properties?: Json };

const ACCOUNT = "123456789012";

/**
 * The CloudFormation pattern of resource properties that take a role ARN, from the resource type's documentation. Add a property here when it is found to carry a pattern;
 * a property not listed is still collected and must at least be a valid role ARN (arn:aws...:iam::<12 digits>:role/<path and name>).
 */
const PROPERTY_PATTERNS: Record<string, Record<string, RegExp>> = {
  // ECR RepositoryCreationTemplate CustomRoleArn: no "/" after "role/", so no IAM path.
  "AWS::ECR::RepositoryCreationTemplate": { CustomRoleArn: /^arn:aws[-a-z0-9]*:iam::[0-9]{12}:role\/[A-Za-z0-9+=,\-.@_]*$/u },
};
const ANY_ROLE_ARN = /^arn:aws[-a-z0-9]*:iam::[0-9]{12}:role\/.+$/u;

/** A string value (an Fn::Join of strings and pseudo parameters included) as text, with the account filled in. */
function text(value: unknown): string {
  if (typeof value === "string") return value;
  const node = value as { "Fn::Join"?: [string, unknown[]]; Ref?: string };
  if (node["Fn::Join"] !== undefined) return node["Fn::Join"][1].map(text).join(node["Fn::Join"][0]);
  if (node.Ref === "AWS::Partition") return "aws";
  if (node.Ref === "AWS::AccountId") return ACCOUNT;
  if (node.Ref === "AWS::Region") return "us-west-2";
  return "\u0000";
}

interface RoleArnUse { stack: string; resource: string; type: string; property: string; arn: string }

/** Every top-level property whose value is Fn::GetAtt [<an IAM role>, "Arn"], with the ARN that role really has. */
function roleArnUses(app: ReturnType<typeof buildAgentXApp>): RoleArnUse[] {
  const uses: RoleArnUse[] = [];
  for (const stack of app.node.children.filter((child): child is Stack => Stack.isStack(child))) {
    const resources = Template.fromStack(stack).toJSON().Resources as Record<string, Resource>;
    for (const [id, resource] of Object.entries(resources)) {
      for (const [property, value] of Object.entries(resource.Properties ?? {})) {
        const getAtt = (value as { "Fn::GetAtt"?: [string, string] } | null)?.["Fn::GetAtt"];
        if (getAtt === undefined || getAtt[1] !== "Arn") continue;
        const role = resources[getAtt[0]];
        if (role?.Type !== "AWS::IAM::Role") continue;
        const path = role.Properties?.["Path"] === undefined ? "/" : text(role.Properties["Path"]);
        const name = role.Properties?.["RoleName"] === undefined ? "generated-name" : text(role.Properties["RoleName"]);
        uses.push({ stack: stack.node.id, resource: id, type: resource.Type, property, arn: `arn:aws:iam::${ACCOUNT}:role${path}${name}` });
      }
    }
  }
  return uses;
}

describe("a role ARN taken through Fn::GetAtt Role.Arn", () => {
  let uses: RoleArnUse[] = [];
  let stacks = 0;
  beforeAll(() => {
    const app = buildAgentXApp({ agentxEnv: "staging", agentxRegion: "us-west-2", agentxCloud: "true" });
    stacks = app.node.children.filter((child) => Stack.isStack(child)).length;
    uses = roleArnUses(app);
  }, 600_000);

  it("matches the property's CloudFormation pattern in every synthesized stack (ECR CustomRoleArn takes no IAM path)", () => {
    expect(stacks).toBe(6);
    const creation = uses.filter((use) => use.type === "AWS::ECR::RepositoryCreationTemplate" && use.property === "CustomRoleArn");
    expect(creation.length, "the creation template's CustomRoleArn is found").toBeGreaterThan(0);
    const wrong = uses.flatMap((use) => {
      const pattern = PROPERTY_PATTERNS[use.type]?.[use.property] ?? ANY_ROLE_ARN;
      return pattern.test(use.arn) ? [] : [`${use.stack}/${use.resource}.${use.property}: ${use.arn} does not match ${String(pattern)}`];
    });
    expect(wrong).toEqual([]);
  });
});
