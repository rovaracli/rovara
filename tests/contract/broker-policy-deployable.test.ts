import { App, Stack, aws_iam as iam } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { mergeRoleStatements, mergeRoleStatementsOnSynth } from "../../infra/lib/merge-role-statements.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Statement = { Effect: string; Action?: string | string[]; Resource?: unknown; NotResource?: unknown; Condition?: unknown; Sid?: string };
type Resource = { Type: string; Properties: { PolicyDocument?: { Statement: Statement[] }; Roles?: unknown[] } };

const asList = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

function controlPlaneStack(env: string, props: { mergeBrokerStatements?: boolean; cloud?: boolean } = {}): Stack {
  return new ControlPlaneStack(new App(), `Deployable-${env}`, { env: { account: "944937319445", region: "us-east-1" }, naming: environmentNaming(env), ...props });
}

function controlPlane(env: string, props: { mergeBrokerStatements?: boolean; cloud?: boolean } = {}): Record<string, Resource> {
  return (Template.fromStack(controlPlaneStack(env, props)).toJSON() as { Resources: Record<string, Resource> }).Resources;
}

/** The role logical IDs a policy resource attaches to, sorted: an overflow managed policy counts as the role's own. */
function attachedRoles(roles: unknown[] | undefined): string {
  return JSON.stringify((roles ?? []).map((role) => (role as { Ref?: string }).Ref ?? JSON.stringify(role)).sort());
}

/** Every (effect, action, resource, condition) the stack's IAM policies grant, whatever statement or policy holds it. */
function grantedCombinations(resources: Record<string, Resource>): string[] {
  const combinations = new Set<string>();
  for (const resource of Object.values(resources)) {
    if (resource.Type !== "AWS::IAM::Policy" && resource.Type !== "AWS::IAM::ManagedPolicy") continue;
    const roles = attachedRoles(resource.Properties.Roles);
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
    it(`${label}: the broker's grants live in the named agentx-<env>-broker-<group> managed policies the deploy may create (ruling M2)`, () => {
      const resources = controlPlane(env, { cloud });
      const managed = Object.entries(resources).filter(([, resource]) => resource.Type === "AWS::IAM::ManagedPolicy");
      const names = managed.map(([, resource]) => (resource.Properties as { ManagedPolicyName?: string }).ManagedPolicyName).sort();
      expect(names).toEqual([`agentx-${env}-broker-integrations`, `agentx-${env}-broker-orchestration`, `agentx-${env}-broker-state`]);
      for (const [, resource] of managed) expect(attachedRoles(resource.Properties.Roles)).toContain("BrokerServiceRole");
      // No unnamed overflow policy (CDK's own split), and no broker inline default policy left behind.
      expect(Object.keys(resources).filter((id) => id.startsWith("BrokerServiceRole") && id.includes("Overflow"))).toEqual([]);
      expect(Object.keys(resources).filter((id) => id.startsWith("BrokerServiceRoleDefaultPolicy"))).toEqual([]);
    });

    it(`${label}: merging statements leaves every grant exactly as it was`, () => {
      const merged = grantedCombinations(controlPlane(env, { cloud }));
      const unmerged = controlPlane(env, { cloud, mergeBrokerStatements: false });
      // The role is part of each row (the overflow managed policy's rows count as the role it is attached to), so a pair
      // the merge created cannot hide behind the identical grant of another role in the stack.
      expect(new Set(merged)).toEqual(new Set(grantedCombinations(unmerged)));
      expect(new Set(merged.map((row) => (JSON.parse(row) as string[])[0])).size).toBeGreaterThan(3);
      expect(merged.length).toBeGreaterThan(100);
    });
  }

  for (const [label, env, cloud] of [["staging", "staging", false], ["staging with the hosted cloud", "staging", true], ["a live-test environment", "agentxlivetest123", false]] as const) {
    it(`${label}: each broker managed policy keeps headroom under IAM's 6,144-character managed policy limit`, () => {
      const stack = controlPlaneStack(env, { cloud });
      Template.fromStack(stack); // synthesizes, so the merge-and-move Aspect has run
      const policies = stack.node.findAll().filter((node): node is iam.ManagedPolicy => node instanceof iam.ManagedPolicy && /^agentx-.+-broker-/.test(String((node.node.defaultChild as iam.CfnManagedPolicy).managedPolicyName)));
      expect(policies).toHaveLength(3);
      for (const policy of policies) {
        const name = String((policy.node.defaultChild as iam.CfnManagedPolicy).managedPolicyName);
        // PolicyStatement._estimateSize is an internal API (pinned with aws-cdk-lib): 20 characters per action and 150 per unresolved token.
        const estimate = (policy.document as unknown as { statements: Array<{ _estimateSize(options: { actionEstimate: number; arnEstimate: number }): number }> }).statements
          .reduce((total, statement) => total + statement._estimateSize({ actionEstimate: 20, arnEstimate: 150 }), 0);
        expect(
          estimate,
          `${name} is estimated at ${estimate} characters; the guard allows 5,500 (IAM caps a managed policy at 6,144). ` +
            "Move a service into another group in infra/lib/merge-role-statements.ts (BROKER_POLICY_GROUPS) or add a new group. Do not raise the limit.",
        ).toBeLessThanOrEqual(5500);
      }
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

  it("reaches a fixed point through a chain of merges: A on R1 and R2, then B on both, while C on R1 alone stays separate", () => {
    const merged = roleWith((role) => {
      role.addToPolicy(statement({ actions: ["s3:GetObject"], resources: ["arn:aws:s3:::r1/*"] }));
      role.addToPolicy(statement({ actions: ["s3:GetObject"], resources: ["arn:aws:s3:::r2/*"] }));
      role.addToPolicy(statement({ actions: ["s3:PutObject"], resources: ["arn:aws:s3:::r1/*", "arn:aws:s3:::r2/*"] }));
      role.addToPolicy(statement({ actions: ["s3:DeleteObject"], resources: ["arn:aws:s3:::r1/*"] }));
    });
    expect(merged).toEqual([
      { Action: ["s3:GetObject", "s3:PutObject"], Effect: "Allow", Resource: ["arn:aws:s3:::r1/*", "arn:aws:s3:::r2/*"] },
      { Action: "s3:DeleteObject", Effect: "Allow", Resource: "arn:aws:s3:::r1/*" },
    ]);
  });

  it("never turns (A1,A2) on R1 plus A1 on R2 into a cross product that grants A2 on R2", () => {
    const merged = roleWith((role) => {
      role.addToPolicy(statement({ actions: ["s3:GetObject", "s3:PutObject"], resources: ["arn:aws:s3:::r1/*"] }));
      role.addToPolicy(statement({ actions: ["s3:GetObject"], resources: ["arn:aws:s3:::r2/*"] }));
    });
    expect(merged).toEqual([
      { Action: ["s3:GetObject", "s3:PutObject"], Effect: "Allow", Resource: "arn:aws:s3:::r1/*" },
      { Action: "s3:GetObject", Effect: "Allow", Resource: "arn:aws:s3:::r2/*" },
    ]);
  });

  it("does not merge conditions that differ only by operator, only by key, or only by value order", () => {
    const resource = ["arn:aws:dynamodb:us-east-1:1:table/t"];
    const merged = roleWith((role) => {
      role.addToPolicy(statement({ actions: ["dynamodb:GetItem"], resources: resource, conditions: { StringLike: { "dynamodb:LeadingKeys": ["A#*"] } } }));
      role.addToPolicy(statement({ actions: ["dynamodb:Query"], resources: resource, conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["A#*"] } } }));
      role.addToPolicy(statement({ actions: ["dynamodb:PutItem"], resources: resource, conditions: { StringLike: { "dynamodb:Select": ["A#*"] } } }));
      role.addToPolicy(statement({ actions: ["dynamodb:DeleteItem"], resources: resource, conditions: { StringLike: { "dynamodb:LeadingKeys": ["A#*", "B#*"] } } }));
      role.addToPolicy(statement({ actions: ["dynamodb:UpdateItem"], resources: resource, conditions: { StringLike: { "dynamodb:LeadingKeys": ["B#*", "A#*"] } } }));
    });
    expect(merged).toHaveLength(5);
  });

  it("merges statements whose identical conditions were written with their keys in a different order", () => {
    const merged = roleWith((role) => {
      role.addToPolicy(statement({ actions: ["dynamodb:GetItem"], resources: ["arn:aws:dynamodb:us-east-1:1:table/t"], conditions: { StringLike: { "a:b": "x", "c:d": "y" } } }));
      role.addToPolicy(statement({ actions: ["dynamodb:GetItem"], resources: ["arn:aws:dynamodb:us-east-1:1:table/u"], conditions: { StringLike: { "c:d": "y", "a:b": "x" } } }));
    });
    expect(merged).toHaveLength(1);
  });

  it("leaves statements with a Sid untouched, even beside an otherwise identical one", () => {
    const merged = roleWith((role) => {
      role.addToPolicy(statement({ sid: "One", actions: ["s3:GetObject"], resources: ["arn:aws:s3:::a/*"] }));
      role.addToPolicy(statement({ sid: "Two", actions: ["s3:GetObject"], resources: ["arn:aws:s3:::b/*"] }));
      role.addToPolicy(statement({ actions: ["s3:GetObject"], resources: ["arn:aws:s3:::c/*"] }));
    });
    expect(merged).toEqual([
      { Action: "s3:GetObject", Effect: "Allow", Resource: "arn:aws:s3:::a/*", Sid: "One" },
      { Action: "s3:GetObject", Effect: "Allow", Resource: "arn:aws:s3:::b/*", Sid: "Two" },
      { Action: "s3:GetObject", Effect: "Allow", Resource: "arn:aws:s3:::c/*" },
    ]);
  });

  it("leaves NotAction and NotResource statements untouched", () => {
    const merged = roleWith((role) => {
      role.addToPolicy(statement({ notActions: ["iam:*"], resources: ["*"] }));
      role.addToPolicy(statement({ notActions: ["iam:*"], resources: ["arn:aws:s3:::a/*"] }));
      role.addToPolicy(statement({ actions: ["s3:GetObject"], notResources: ["arn:aws:s3:::a/*"] }));
      role.addToPolicy(statement({ actions: ["s3:GetObject"], notResources: ["arn:aws:s3:::b/*"] }));
    });
    expect(merged).toHaveLength(4);
  });

  it("runs on synthesis, after every grant, through the Aspect", () => {
    const stack = new Stack(new App(), "UnitAspect");
    const role = new iam.Role(stack, "Role", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") });
    mergeRoleStatementsOnSynth(role);
    role.addToPolicy(statement({ actions: ["s3:GetObject"], resources: ["arn:aws:s3:::a/*"] }));
    role.addToPolicy(statement({ actions: ["s3:GetObject"], resources: ["arn:aws:s3:::b/*"] }));
    const policies = Object.values((Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource> }).Resources).filter((resource) => resource.Type === "AWS::IAM::Policy");
    expect(policies.map((policy) => policy.Properties.PolicyDocument!.Statement)).toEqual([[{ Action: "s3:GetObject", Effect: "Allow", Resource: ["arn:aws:s3:::a/*", "arn:aws:s3:::b/*"] }]]);
  });
});
