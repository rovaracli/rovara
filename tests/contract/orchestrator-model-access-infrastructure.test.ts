// Task 13: the Slack orchestrator reaches the model proxy: its address in the task's environment, and the one network
// path (the proxy port) between the orchestrator's security group and the proxy load balancer's. Named environments only.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { SlackOrchestratorStack } from "../../infra/lib/slack-orchestrator.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Properties = Record<string, unknown> & { GroupId?: unknown; SourceSecurityGroupId?: unknown; DestinationSecurityGroupId?: unknown; FromPort?: number; ToPort?: number; IpProtocol?: string; CidrIp?: string };
const named = Template.fromStack(new SlackOrchestratorStack(new App(), "ProxySlack", { naming: environmentNaming("staging") }));
const json = named.toJSON() as { Parameters: Record<string, unknown>; Resources: Record<string, unknown> };
const resources = (template: Template, type: string) => Object.entries(template.findResources(type)) as Array<[string, { Properties: Properties }]>;

describe("the Slack orchestrator stack with a model proxy (environment naming)", () => {
  const [[groupId]] = resources(named, "AWS::EC2::SecurityGroup") as [[string, unknown]];

  it("takes the proxy's address and its load balancer's security group as parameters", () => {
    expect(json.Parameters.ModelProxyUrl).toMatchObject({ Type: "String" });
    expect(json.Parameters.ModelProxySecurityGroupId).toMatchObject({ Type: "AWS::EC2::SecurityGroup::Id" });
  });

  it("passes the address to the orchestrator task as AGENTX_MODEL_PROXY_URL", () => {
    const [[, task]] = resources(named, "AWS::ECS::TaskDefinition") as [[string, { Properties: { ContainerDefinitions: Array<{ Environment: Array<{ Name: string; Value: unknown }> }> } }]];
    const variables = Object.fromEntries(task.Properties.ContainerDefinitions[0]!.Environment.map((entry) => [entry.Name, entry.Value]));
    expect(variables.AGENTX_MODEL_PROXY_URL).toEqual({ Ref: "ModelProxyUrl" });
  });

  it("lets the orchestrator reach the proxy load balancer on port 4000, and nothing else new", () => {
    const egress = resources(named, "AWS::EC2::SecurityGroupEgress");
    expect(egress.map(([, rule]) => rule.Properties)).toEqual([expect.objectContaining({
      GroupId: { "Fn::GetAtt": [groupId, "GroupId"] }, DestinationSecurityGroupId: { Ref: "ModelProxySecurityGroupId" }, IpProtocol: "tcp", FromPort: 4000, ToPort: 4000,
    })]);
    const ingress = resources(named, "AWS::EC2::SecurityGroupIngress");
    expect(ingress.map(([, rule]) => rule.Properties)).toEqual([expect.objectContaining({
      GroupId: { Ref: "ModelProxySecurityGroupId" }, SourceSecurityGroupId: { "Fn::GetAtt": [groupId, "GroupId"] }, IpProtocol: "tcp", FromPort: 4000, ToPort: 4000,
    })]);
    // The orchestrator's own group still has no ingress and its HTTPS-only inline egress.
    const group = (json.Resources[groupId] as { Properties: { SecurityGroupIngress?: unknown; SecurityGroupEgress: Array<{ FromPort: number; CidrIp: string }> } }).Properties;
    expect(group.SecurityGroupIngress).toBeUndefined();
    expect(group.SecurityGroupEgress).toEqual([expect.objectContaining({ FromPort: 443, CidrIp: "0.0.0.0/0" })]);
  });

  it("passes the orchestrator no provider-key variables (Task 14)", () => {
    const [[, task]] = resources(named, "AWS::ECS::TaskDefinition") as [[string, { Properties: { ContainerDefinitions: Array<{ Environment: Array<{ Name: string }> }> } }]];
    const names = task.Properties.ContainerDefinitions[0]!.Environment.map((entry) => entry.Name);
    expect(names).not.toContain("AGENTX_ANTHROPIC_SECRET_ARN");
    expect(names).not.toContain("AGENTX_OPENROUTER_SECRET_ARN");
    expect(names).not.toContain("AGENTX_OPENAI_SECRET_ARN");
  });

  it("is told the proxy load balancer's group by an output of the control plane", () => {
    const control = Template.fromStack(new ControlPlaneStack(new App(), "ProxyControlPlane", { naming: environmentNaming("staging") }));
    expect((control.toJSON() as { Outputs: Record<string, unknown> }).Outputs.ModelProxySecurityGroupId).toBeDefined();
  });
});

describe("the legacy Slack orchestrator stack", () => {
  it("has no proxy parameter, variable or security group rule", () => {
    const legacy = Template.fromStack(new SlackOrchestratorStack(new App(), "LegacyProxySlack"));
    expect(Object.keys((legacy.toJSON() as { Parameters?: Record<string, unknown> }).Parameters ?? {}).filter((name) => name.startsWith("ModelProxy"))).toEqual([]);
    expect(JSON.stringify(legacy.toJSON())).not.toContain("AGENTX_MODEL_PROXY_URL");
    expect(resources(legacy, "AWS::EC2::SecurityGroupEgress")).toEqual([]);
    expect(resources(legacy, "AWS::EC2::SecurityGroupIngress")).toEqual([]);
  });
});
