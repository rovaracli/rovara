// Final review M9, reconciled with Plan 3. IAM refuses a role whose inline policies total more than 10,240 characters (whitespace not counted), and a
// deploy that hits it fails late and in the account. Plan 2 pinned the broker's inline total under 9,000. Plan 3 then moved the broker's grants into
// three named managed policies (infra/lib/merge-role-statements.ts), so what stays inline is small; this test still pins that inline total, and
// also measures each managed policy against IAM's 6,144 limit (broker-policy-deployable.test.ts holds the same managed policies to an estimate).
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

/** The broker's policies, measured as IAM measures them: inline (the role's own and `AWS::IAM::Policy` resources) and the managed policies Plan 3 moved the grants into. */
function brokerPolicies(resources: Record<string, Resource>): { inline: Array<{ name: string; characters: number }>; managed: Array<{ name: string; characters: number }> } {
  const broker = Object.values(resources).find((resource) => resource.Type === "AWS::Lambda::Function" && JSON.stringify(resource.Properties.Environment ?? {}).includes("AGENTX_NAMES")
    && JSON.stringify(resource.Properties.Environment ?? {}).includes("ProjectAllowListId"));
  expect(broker, "the broker function").toBeDefined();
  const roleId = (broker!.Properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
  const measure = (name: string, document: Json) => ({ name, characters: JSON.stringify(resolved(document)).replace(/\s/g, "").length });
  const own = ((resources[roleId]!.Properties.Policies ?? []) as Array<{ PolicyName: string; PolicyDocument: Json }>).map((policy) => measure(policy.PolicyName, policy.PolicyDocument));
  const attachedTo = (type: string) => Object.entries(resources)
    .filter(([, resource]) => resource.Type === type && ((resource.Properties.Roles ?? []) as Array<{ Ref?: string }>).some((role) => role.Ref === roleId))
    .map(([id, resource]) => measure(id, resource.Properties.PolicyDocument as Json));
  return { inline: [...own, ...attachedTo("AWS::IAM::Policy")], managed: attachedTo("AWS::IAM::ManagedPolicy") };
}

/** IAM caps one managed policy at 6,144 characters; this test holds the broker's three to the same 5,500 that broker-policy-deployable.test.ts allows. */
const MANAGED_SAFE_BOUND = 5_500;

describe("the broker role's policies (final review M9, reconciled with Plan 3's managed policies)", () => {
  const app = buildAgentXApp({ agentxEnv: "staging", agentxCloud: true });
  const stack = app.node.children.filter((child): child is Stack => Stack.isStack(child)).find((candidate) => candidate.stackName === "agentx-staging-control-plane")!;
  const { inline, managed } = brokerPolicies(Template.fromStack(stack).toJSON().Resources as Record<string, Resource>);
  const total = inline.reduce((sum, policy) => sum + policy.characters, 0);

  it("finds the broker's policies, so the bounds below are about something", () => {
    expect(inline.length).toBeGreaterThanOrEqual(1);
    expect(managed.map((policy) => /(State|Orchestration|Integrations)Policy/.exec(policy.name)?.[1]).sort()).toEqual(["Integrations", "Orchestration", "State"]);
    expect(managed).toHaveLength(3);
    expect(managed.reduce((sum, policy) => sum + policy.characters, 0)).toBeGreaterThan(3_000);
  });

  it(`keeps the role's inline policies under ${String(SAFE_BOUND)} characters, well before IAM's ${String(IAM_INLINE_LIMIT)}`, () => {
    expect(SAFE_BOUND).toBeLessThan(IAM_INLINE_LIMIT);
    expect(total, `inline policy characters by policy: ${JSON.stringify(inline)}`).toBeLessThanOrEqual(SAFE_BOUND);
  });

  it(`keeps each of the broker's managed policies under ${String(MANAGED_SAFE_BOUND)} characters (IAM allows 6,144)`, () => {
    for (const policy of managed) expect(policy.characters, `managed policy characters: ${JSON.stringify(managed)}`).toBeLessThanOrEqual(MANAGED_SAFE_BOUND);
  });
});
