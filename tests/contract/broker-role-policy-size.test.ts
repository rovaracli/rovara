// Final review M9. IAM refuses a role whose inline policies total more than 10,240 characters (whitespace not counted), and a deploy that hits it
// fails late and in the account. The broker's role is the one that grows with every plan, so its total is pinned here, under a bound with room to
// spare, and fails before IAM would. A new grant that does not fit goes in a separate `iam.Policy` only if the total still holds; otherwise the
// grants must be trimmed or the role split. (The access stack's service role cannot create managed policies, so moving statements into one is no way out.)
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Resource = { Type: string; Properties: Record<string, Json> };

/** IAM's own ceiling for the inline policies of one role. */
const IAM_INLINE_LIMIT = 10_240;
/** The bound this test holds the broker to: about 12% under IAM's, which covers the estimate below being rough. */
const SAFE_BOUND = 9_000;
/** What the pseudo parameters are in a real account and region (a longer region name than any in use). */
const PSEUDO: Record<string, string> = { "AWS::Partition": "aws", "AWS::Region": "ap-southeast-2", "AWS::AccountId": "123456789012", "AWS::URLSuffix": "amazonaws.com", "AWS::StackName": "agentx-staging-control-plane" };
/** A physical name or id CloudFormation fills in for a `Ref` to a resource or parameter (a table name with its suffix, a function name). */
const RESOLVED_NAME_LENGTH = 48;
/** A whole resource ARN, which an `Fn::GetAtt ... Arn` stands for: longer than any this stack builds. */
const RESOLVED_ARN_LENGTH = 110;

/** The policy document as IAM measures it: each CloudFormation intrinsic replaced by a value of the length it resolves to, a Join joined. */
function resolved(value: Json): Json {
  if (Array.isArray(value)) return value.map(resolved);
  if (value === null || typeof value !== "object") return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "Fn::Join") {
    const [separator, parts] = value["Fn::Join"] as [string, Json[]];
    return parts.map((part) => resolved(part)).map(String).join(separator);
  }
  if (keys.length === 1 && keys[0] === "Ref") return PSEUDO[value.Ref as string] ?? "x".repeat(RESOLVED_NAME_LENGTH);
  if (keys.length === 1 && keys[0] === "Fn::GetAtt") return "x".repeat((value["Fn::GetAtt"] as Json[])[1] === "Arn" ? RESOLVED_ARN_LENGTH : RESOLVED_NAME_LENGTH);
  if (keys.length === 1 && keys[0]!.startsWith("Fn::")) return "x".repeat(RESOLVED_ARN_LENGTH);
  return Object.fromEntries(keys.map((key) => [key, resolved(value[key] as Json)]));
}

function brokerInlinePolicies(resources: Record<string, Resource>): Array<{ name: string; characters: number }> {
  const broker = Object.values(resources).find((resource) => resource.Type === "AWS::Lambda::Function" && JSON.stringify(resource.Properties.Environment ?? {}).includes("STATE_TABLE_NAME")
    && JSON.stringify(resource.Properties.Environment ?? {}).includes("AGENT_PROJECT_ALLOW_LIST_ID"));
  expect(broker, "the broker function").toBeDefined();
  const roleId = (broker!.Properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
  const own = ((resources[roleId]!.Properties.Policies ?? []) as Array<{ PolicyName: string; PolicyDocument: Json }>).map((policy) => ({ name: policy.PolicyName, document: policy.PolicyDocument }));
  const attached = Object.entries(resources)
    .filter(([, resource]) => resource.Type === "AWS::IAM::Policy" && (resource.Properties.Roles as Array<{ Ref?: string }>).some((role) => role.Ref === roleId))
    .map(([id, resource]) => ({ name: id, document: resource.Properties.PolicyDocument as Json }));
  return [...own, ...attached].map(({ name, document }) => ({ name, characters: JSON.stringify(resolved(document)).replace(/\s/g, "").length }));
}

describe("the broker role's inline policies (final review M9)", () => {
  const app = buildAgentXApp({ agentxEnv: "staging", agentxCloud: true });
  const stack = app.node.children.filter((child): child is Stack => Stack.isStack(child)).find((candidate) => candidate.stackName === "agentx-staging-control-plane")!;
  const policies = brokerInlinePolicies(Template.fromStack(stack).toJSON().Resources as Record<string, Resource>);
  const total = policies.reduce((sum, policy) => sum + policy.characters, 0);

  it("finds the broker's policies, so the bound below is about something", () => {
    expect(policies.length).toBeGreaterThanOrEqual(2);
    expect(policies.some((policy) => policy.name.includes("BrokerProjectAllowListPolicy"))).toBe(true);
    expect(total).toBeGreaterThan(3_000);
  });

  it(`totals under ${String(SAFE_BOUND)} characters, well before IAM's ${String(IAM_INLINE_LIMIT)}`, () => {
    expect(SAFE_BOUND).toBeLessThan(IAM_INLINE_LIMIT);
    expect(total, `inline policy characters by policy: ${JSON.stringify(policies)}`).toBeLessThanOrEqual(SAFE_BOUND);
  });
});
