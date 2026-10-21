import { App, Stack, aws_iam as iam } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { mergeRoleStatements } from "../../infra/lib/merge-role-statements.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Statement = { Effect: string; Action?: string | string[]; Resource?: unknown; NotResource?: unknown; Condition?: unknown; Sid?: string };
type Resource = { Type: string; Properties: { PolicyDocument?: { Statement: Statement[] }; Roles?: unknown[] } };

const asList = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

function controlPlane(env: string, props: { mergeBrokerStatements?: boolean; cloud?: boolean } = {}): Record<string, Resource> {
  const stack = new ControlPlaneStack(new App(), `Deployable-${env}`, { env: { account: "944937319445", region: "us-east-1" }, naming: environmentNaming(env), ...props });
  return (Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource> }).Resources;
}

/** Every (effect, action, resource, condition) the stack's IAM policies grant, whatever statement or policy holds it. */
function grantedCombinations(resources: Record<string, Resource>): string[] {
  const combinations = new Set<string>();
  for (const resource of Object.values(resources)) {
    if (resource.Type !== "AWS::IAM::Policy" && resource.Type !== "AWS::IAM::ManagedPolicy") continue;
    const roles = JSON.stringify(resource.Properties.Roles ?? null);
    for (const statement of resource.Properties.PolicyDocument!.Statement) {
      const targets = asList(statement.Resource).map((target) => JSON.stringify(target));
      if (statement.NotResource !== undefined) targets.push(`NotResource:${JSON.stringify(statement.NotResource)}`);
      for (const action of asList(statement.Action)) {
        for (const target of targets) combinations.add(JSON.stringify([roles, statement.Effect, action, target, statement.Condition ?? null, statement.Sid ?? null]));
      }
    }
  }
  return [...combinations].sort();
}

describe("the merged control plane's broker policy stays deployable", () => {
  for (const [label, env, cloud] of [["staging", "staging", false], ["staging with the hosted cloud", "staging", true], ["a live-test environment", "agentxlivetest123", false]] as const) {
    it(`${label}: the broker role has no managed overflow policy, because the deploy's CloudFormation role cannot create one (R53)`, () => {
      const resources = controlPlane(env, { cloud });
      expect(Object.entries(resources).filter(([, resource]) => resource.Type === "AWS::IAM::ManagedPolicy").map(([id]) => id)).toEqual([]);
      expect(Object.keys(resources).filter((id) => id.startsWith("BrokerServiceRole") && id.includes("Overflow"))).toEqual([]);
    });

    it(`${label}: merging statements leaves every grant exactly as it was`, () => {
      const merged = grantedCombinations(controlPlane(env, { cloud }));
      const unmerged = controlPlane(env, { cloud, mergeBrokerStatements: false });
      // Unmerged, the overflow sits in a managed policy that names the role differently, so compare rows without the role.
      const withoutRoles = (rows: string[]) => rows.map((row) => JSON.stringify((JSON.parse(row) as unknown[]).slice(1))).sort();
      expect(new Set(withoutRoles(merged))).toEqual(new Set(withoutRoles(grantedCombinations(unmerged))));
      expect(merged.length).toBeGreaterThan(100);
    });
  }

  it("the unmerged broker policy does overflow, so the merge is what keeps it inline", () => {
    const unmerged = controlPlane("staging", { mergeBrokerStatements: false });
    expect(Object.entries(unmerged).some(([id, resource]) => id.startsWith("BrokerServiceRoleOverflowPolicy") && resource.Type === "AWS::IAM::ManagedPolicy")).toBe(true);
  });

  it("the legacy install keeps its recorded broker policy, statement for statement", () => {
    const stack = new ControlPlaneStack(new App(), "LegacyDeployable", { env: { account: "944937319445", region: "us-east-1" } });
    const resources = (Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource> }).Resources;
    expect(resources.BrokerServiceRoleDefaultPolicyDDFD9E7E!.Properties.PolicyDocument!.Statement).toHaveLength(13);
  });
});

describe("mergeRoleStatements", () => {
  function roleWith(add: (role: iam.Role) => void) {
    const stack = new Stack(new App(), "Unit");
    const role = new iam.Role(stack, "Role", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") });
    add(role);
    mergeRoleStatements(role);
    const policy = role.node.findChild("DefaultPolicy") as iam.Policy;
    return (stack.resolve(policy.document.toJSON()) as { Statement: Statement[] }).Statement;
  }
  const statement = (props: iam.PolicyStatementProps) => new iam.PolicyStatement(props);

  it("merges same actions and conditions into one resource list", () => {
    const merged = roleWith((role) => {
      role.addToPolicy(statement({ actions: ["sqs:SendMessage", "sqs:GetQueueUrl"], resources: ["arn:aws:sqs:us-east-1:1:a"] }));
      role.addToPolicy(statement({ actions: ["sqs:GetQueueUrl", "sqs:SendMessage"], resources: ["arn:aws:sqs:us-east-1:1:b", "arn:aws:sqs:us-east-1:1:a"] }));
    });
    expect(merged).toEqual([{ Action: ["sqs:SendMessage", "sqs:GetQueueUrl"], Effect: "Allow", Resource: ["arn:aws:sqs:us-east-1:1:a", "arn:aws:sqs:us-east-1:1:b"] }]);
  });

  it("merges same resources and conditions into one action list", () => {
    const merged = roleWith((role) => {
      role.addToPolicy(statement({ actions: ["s3:GetObject"], resources: ["arn:aws:s3:::b/*"] }));
      role.addToPolicy(statement({ actions: ["s3:PutObject"], resources: ["arn:aws:s3:::b/*"] }));
    });
    expect(merged).toEqual([{ Action: ["s3:GetObject", "s3:PutObject"], Effect: "Allow", Resource: "arn:aws:s3:::b/*" }]);
  });

  it("never merges across different conditions, effects, Sids or when both actions and resources differ", () => {
    const conditionA = { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["A#*"] } };
    const conditionB = { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["B#*"] } };
    const merged = roleWith((role) => {
      role.addToPolicy(statement({ actions: ["dynamodb:GetItem"], resources: ["arn:aws:dynamodb:us-east-1:1:table/t"], conditions: conditionA }));
      role.addToPolicy(statement({ actions: ["dynamodb:GetItem"], resources: ["arn:aws:dynamodb:us-east-1:1:table/u"], conditions: conditionB }));
      role.addToPolicy(statement({ actions: ["dynamodb:GetItem"], resources: ["arn:aws:dynamodb:us-east-1:1:table/u"] }));
      role.addToPolicy(statement({ effect: iam.Effect.DENY, actions: ["dynamodb:GetItem"], resources: ["arn:aws:dynamodb:us-east-1:1:table/u"] }));
      role.addToPolicy(statement({ sid: "Named", actions: ["dynamodb:GetItem"], resources: ["arn:aws:dynamodb:us-east-1:1:table/u"] }));
      role.addToPolicy(statement({ actions: ["dynamodb:Query"], resources: ["arn:aws:dynamodb:us-east-1:1:table/v"] }));
    });
    expect(merged).toHaveLength(6);
  });
});
