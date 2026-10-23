import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { brokerNamesIn } from "../support/broker-names-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Ref = { Ref?: string; "Fn::GetAtt"?: [string, string] };
type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown };
type Properties = {
  PolicyName?: string; Roles?: Ref[]; PolicyDocument?: { Statement: Statement[] };
  GroupId?: Ref; SourceSecurityGroupId?: Ref; DestinationSecurityGroupId?: Ref; CidrIp?: string;
  Environment?: { Variables?: Record<string, unknown> }; VpcConfig?: { SubnetIds?: unknown; SecurityGroupIds?: unknown[] };
  Role?: Ref; ManagedPolicyArns?: unknown[]; Handler?: string; Timeout?: number;
  [key: string]: unknown;
};
type Resource = { Type: string; Properties: Properties };
type Resources = Record<string, Resource>;

function controlPlane(context: Record<string, unknown>): Template {
  const app = buildAgentXApp(context);
  const stack = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane");
  return Template.fromStack(stack!);
}

const ofType = (resources: Resources, type: string) => Object.entries(resources).filter(([, resource]) => resource.Type === type);
const only = (resources: Resources, type: string, prefix: string) => {
  const found = ofType(resources, type).filter(([id]) => id.startsWith(prefix));
  expect(found.map(([id]) => id), `${type} ${prefix}`).toHaveLength(1);
  return found[0]!;
};
const roleOf = (reference: Ref) => reference["Fn::GetAtt"]?.[0] ?? reference.Ref!;

describe("model access function infrastructure (named environments)", () => {
  let resources: Resources;
  let functionId: string;
  let accessFunction: Resource;
  let masterKeyId: string;

  beforeAll(() => {
    resources = controlPlane({ agentxEnv: "staging" }).toJSON().Resources as Resources;
    [functionId, accessFunction] = only(resources, "AWS::Lambda::Function", "ModelAccessFunction");
    masterKeyId = only(resources, "AWS::SecretsManager::Secret", "ModelProxyMasterKey")[0];
  }, 240_000);

  const statementsOf = (roleId: string) => [...ofType(resources, "AWS::IAM::Policy"), ...ofType(resources, "AWS::IAM::ManagedPolicy")]
    .filter(([, policy]) => (policy.Properties.Roles ?? []).some((role) => role.Ref === roleId))
    .flatMap(([, policy]) => policy.Properties.PolicyDocument!.Statement);
  const mentions = (value: unknown, id: string) => JSON.stringify(value).includes(`"${id}"`);

  it("runs in the foundation's private subnets with its own security group", () => {
    const group = only(resources, "AWS::EC2::SecurityGroup", "ModelAccessSecurityGroup")[0];
    expect(accessFunction.Properties.VpcConfig).toEqual({
      SubnetIds: { "Fn::Split": [",", { Ref: "PrivateSubnetIds" }] },
      SecurityGroupIds: [{ "Fn::GetAtt": [group, "GroupId"] }],
    });
    expect(accessFunction.Properties.Handler).toBeDefined();
    // The VPC's network interface permissions come with the managed policy, as for the other VPC functions.
    const role = resources[roleOf(accessFunction.Properties.Role!)]!;
    expect(JSON.stringify(role.Properties.ManagedPolicyArns)).toContain("AWSLambdaVPCAccessExecutionRole");
  });

  it("is the only function of the control plane in a security group that the proxy admits, and that group is its own", () => {
    const group = only(resources, "AWS::EC2::SecurityGroup", "ModelAccessSecurityGroup");
    const balancer = only(resources, "AWS::EC2::SecurityGroup", "ModelProxyLoadBalancerSecurityGroup")[0];
    expect(group[1].Properties.SecurityGroupIngress).toBeUndefined();
    // Outbound: HTTPS inline, and the management port 4001 to the proxy's load balancer only (ruling R48).
    expect(group[1].Properties.SecurityGroupEgress).toEqual([expect.objectContaining({ IpProtocol: "tcp", FromPort: 443, ToPort: 443 })]);
    const egress = ofType(resources, "AWS::EC2::SecurityGroupEgress").filter(([, rule]) => rule.Properties.GroupId?.["Fn::GetAtt"]?.[0] === group[0]);
    expect(egress.map(([, rule]) => rule.Properties)).toEqual([expect.objectContaining({
      IpProtocol: "tcp", FromPort: 4001, ToPort: 4001, DestinationSecurityGroupId: { "Fn::GetAtt": [balancer, "GroupId"] },
    })]);
    // Inbound on the load balancer from this group, port 4001, by group (no CIDR).
    const ingress = ofType(resources, "AWS::EC2::SecurityGroupIngress").filter(([, rule]) =>
      rule.Properties.GroupId?.["Fn::GetAtt"]?.[0] === balancer && rule.Properties.SourceSecurityGroupId?.["Fn::GetAtt"]?.[0] === group[0]);
    expect(ingress.map(([, rule]) => rule.Properties)).toEqual([expect.objectContaining({ IpProtocol: "tcp", FromPort: 4001, ToPort: 4001 })]);
    expect(ingress[0]![1].Properties.CidrIp).toBeUndefined();
    // Nothing admits anyone to the function's group.
    expect(ofType(resources, "AWS::EC2::SecurityGroupIngress").filter(([, rule]) => rule.Properties.GroupId?.["Fn::GetAtt"]?.[0] === group[0])).toEqual([]);
  });

  it("is told the proxy's URL and the master key's secret ARN, and nothing else", () => {
    const balancer = only(resources, "AWS::ElasticLoadBalancingV2::LoadBalancer", "ModelProxyLoadBalancer")[0];
    expect(accessFunction.Properties.Environment!.Variables).toEqual({
      MODEL_PROXY_URL: { "Fn::Join": ["", ["http://", { "Fn::GetAtt": [balancer, "DNSName"] }, ":4001"]] },
      MODEL_PROXY_MASTER_KEY_SECRET_ARN: { Ref: masterKeyId },
    });
  });

  it("is the single reader of the master key besides the proxy's own task and execution roles", () => {
    const readers = new Set<string>();
    for (const [, policy] of [...ofType(resources, "AWS::IAM::Policy"), ...ofType(resources, "AWS::IAM::ManagedPolicy")]) {
      for (const statement of policy.Properties.PolicyDocument!.Statement) {
        if (!mentions(statement.Resource, masterKeyId)) continue;
        for (const role of policy.Properties.Roles ?? []) readers.add(role.Ref!);
      }
    }
    const taskDefinition = ofType(resources, "AWS::ECS::TaskDefinition")[0]![1];
    const proxyRoles = [roleOf(taskDefinition.Properties.TaskRoleArn as Ref), roleOf(taskDefinition.Properties.ExecutionRoleArn as Ref)];
    expect([...readers].sort()).toEqual([...proxyRoles, roleOf(accessFunction.Properties.Role!)].sort());
    // Its own grant is the one read action on that one secret.
    const own = statementsOf(roleOf(accessFunction.Properties.Role!)).filter((statement) => mentions(statement.Resource, masterKeyId));
    expect(own).toEqual([{ Sid: "ReadMasterKey", Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: { Ref: masterKeyId } }]);
  });

  it("may assume roles in other AWS accounts for the Bedrock probe, with the external id condition, and manage no secret", () => {
    const own = statementsOf(roleOf(accessFunction.Properties.Role!));
    const assumes = own.filter((statement) => [statement.Action].flat().includes("sts:AssumeRole"));
    expect(assumes).toEqual([{
      Sid: "AssumeOrgBedrockRoles",
      Effect: "Allow",
      Action: "sts:AssumeRole",
      Resource: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::*:role/*"]] },
      Condition: {
        StringNotEquals: { "aws:ResourceAccount": { Ref: "AWS::AccountId" } },
        StringLike: { "sts:ExternalId": "rovara-org_*" },
      },
    }]);
    // Company keys live in the proxy's own store, so the function can create, change or delete no secret.
    expect(own.flatMap((statement) => [statement.Action].flat()).filter((action) => /^secretsmanager:/.test(action))).toEqual(["secretsmanager:GetSecretValue"]);
    expect(JSON.stringify(own)).not.toContain("org-sources");
  });

  it("gives the broker nothing for sources: no STS assume, no secret grant, no new environment", () => {
    const [, broker] = only(resources, "AWS::Lambda::Function", "Broker");
    expect(statementsOf(roleOf(broker.Properties.Role!)).filter((statement) => [statement.Action].flat().includes("sts:AssumeRole") && JSON.stringify(statement).includes("rovara-org_"))).toEqual([]);
    expect(JSON.stringify(broker.Properties.Environment)).not.toMatch(/SALT|LITELLM|org-sources/);
  });

  it("is invoked by the broker through a grant on this function's ARN alone, and the broker is told its name", () => {
    const [brokerId, broker] = only(resources, "AWS::Lambda::Function", "Broker");
    // The name is in the broker's one variable of names (its variables are held to Lambda's 4 KB), and the broker puts it back as MODEL_ACCESS_FUNCTION_NAME.
    expect(broker.Properties.Environment!.Variables!.MODEL_ACCESS_FUNCTION_NAME).toBeUndefined();
    expect(brokerNamesIn(broker.Properties.Environment!.Variables).modelAccessFunction).toEqual({ Ref: functionId });
    const brokerRole = roleOf(broker.Properties.Role!);
    const invokes = statementsOf(brokerRole).filter((statement) => [statement.Action].flat().includes("lambda:InvokeFunction") && mentions(statement.Resource, functionId));
    // The broker's statements that share an action are merged into one resource list (the policy must stay under CDK's inline limit),
    // so that statement also names the broker's other functions; this function's part of it is checked below.
    expect(invokes).toHaveLength(1);
    expect(invokes[0]!.Action).toBe("lambda:InvokeFunction");
    // The function's ARN, and its versions and aliases (ARN:*): never a wildcard that reaches another function.
    const arn = { "Fn::GetAtt": [functionId, "Arn"] };
    const resourcesOfInvokes = [invokes[0]!.Resource].flat();
    expect(resourcesOfInvokes.filter((resource) => mentions(resource, functionId))).toEqual([arn, { "Fn::Join": ["", [arn, ":*"]] }]);
    expect(resourcesOfInvokes.every((resource) => typeof resource === "object" && resource !== null)).toBe(true);
    // No other role may invoke it, and no other function is given its name.
    for (const [, policy] of [...ofType(resources, "AWS::IAM::Policy"), ...ofType(resources, "AWS::IAM::ManagedPolicy")]) {
      if ((policy.Properties.Roles ?? []).some((role) => role.Ref === brokerRole)) continue;
      expect(JSON.stringify(policy.Properties.PolicyDocument)).not.toContain(`"${functionId}"`);
    }
    for (const [id, other] of ofType(resources, "AWS::Lambda::Function")) {
      if (id === brokerId) continue;
      expect(JSON.stringify(other.Properties.Environment ?? {}), id).not.toContain("MODEL_ACCESS_FUNCTION_NAME");
    }
  });

  it("tells the broker where the proxy is (ruling R29) but gives it no read of the master key", () => {
    const [, broker] = only(resources, "AWS::Lambda::Function", "Broker");
    // The address only: the broker hands it to a task's worker with the task's key.
    expect(JSON.stringify(broker.Properties.Environment!.Variables!.MODEL_PROXY_URL)).toContain("LoadBalancer");
    expect(JSON.stringify(broker.Properties.Environment)).not.toContain("LITELLM");
    expect(statementsOf(roleOf(broker.Properties.Role!)).some((statement) => mentions(statement.Resource, masterKeyId))).toBe(false);
  });

  it("serves a task's key request on one unauthorized GET, which the broker verifies by capability", () => {
    const routes = ofType(resources, "AWS::ApiGatewayV2::Route").map(([, route]) => route.Properties as { RouteKey?: string; AuthorizationType?: string });
    expect(routes.filter((route) => route.RouteKey === "GET /v1/internal/model-access")).toEqual([expect.objectContaining({ AuthorizationType: "NONE" })]);
  });

  it("names nothing with an em dash", () => {
    const entries = Object.entries(resources).filter(([id]) => id.startsWith("ModelAccess"));
    expect(entries.length).toBeGreaterThan(3);
    for (const [, resource] of entries) expect(JSON.stringify(resource.Properties)).not.toContain("—");
  });
});

describe("model access function infrastructure (legacy)", () => {
  it("adds nothing to the deployment that predates environments", () => {
    const legacy = controlPlane({});
    const resources = legacy.toJSON().Resources as Resources;
    expect(Object.keys(resources)).not.toContainEqual(expect.stringMatching(/^ModelAccess/));
    expect(JSON.stringify(legacy.toJSON())).not.toMatch(/MODEL_ACCESS_FUNCTION_NAME|MODEL_PROXY|model-access/);
  }, 240_000);
});
