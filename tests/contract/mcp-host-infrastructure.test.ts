// Lane E, task E6: the MCP host's infrastructure, synthesized and read (nothing is deployed). It is reached only by the broker, reads only the MCP registry, holds no
// secret but its token, reaches the internet nowhere, and runs on a read-only root file system.
import { App, Stack, aws_ecs as ecs } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { McpHost } from "../../infra/lib/mcp-host.js";

type Resource = { Type: string; Properties: Record<string, unknown> };
/** A value inside parsed template JSON, by path. */
const at = (value: unknown, ...path: Array<string | number>): unknown => path.reduce<unknown>((current, key) => (current !== null && typeof current === "object" ? (current as Record<string | number, unknown>)[key] : undefined), value);

const CERTIFICATE = "arn:aws:acm:us-east-1:111111111111:certificate/abc";

function synth(over: { certificateArn?: string; cidrs?: string[]; hostName?: string } = {}) {
  const app = new App();
  const stack = new Stack(app, "Test", { env: { account: "111111111111", region: "us-east-1" } });
  const host = new McpHost(stack, "McpHost", {
    vpcId: "vpc-0123456789abcdef0", availabilityZones: ["us-east-1a", "us-east-1b"], subnetIds: ["subnet-0aaaaaaaaaaaaaaaa", "subnet-0bbbbbbbbbbbbbbbb"],
    image: ecs.ContainerImage.fromRegistry("111111111111.dkr.ecr.us-east-1.amazonaws.com/rovara-broker:1"), clientSecurityGroupIds: ["sg-0123456789abcdef0"],
    stateTableArn: "arn:aws:dynamodb:us-east-1:111111111111:table/state", stateTableName: "state", orgId: "org_aaaaaaaaaaaaaaaaaaaa",
    privateEgressCidrs: over.cidrs ?? ["10.0.0.0/16"], certificateArn: over.certificateArn ?? CERTIFICATE, hostName: over.hostName ?? "mcp-host.example.net", hostedZoneId: "Z0123456789ABCDEFGHIJ",
  });
  const json = Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource> };
  const of = (type: string): Array<Record<string, unknown>> => Object.entries(json.Resources).filter(([, resource]) => resource.Type === type).map(([id, resource]) => ({ id, ...resource.Properties }));
  return { host, json, of };
}

describe("the MCP host", () => {
  it("is an internal load balancer in front of one Fargate service on private subnets with no public address", () => {
    const { of } = synth();
    expect(at(of("AWS::ElasticLoadBalancingV2::LoadBalancer")[0], "Scheme")).toBe("internal");
    const service = of("AWS::ECS::Service")[0]!;
    expect(at(service, "NetworkConfiguration", "AwsvpcConfiguration", "AssignPublicIp")).toBe("DISABLED");
    expect(at(service, "NetworkConfiguration", "AwsvpcConfiguration", "Subnets")).toEqual(["subnet-0aaaaaaaaaaaaaaaa", "subnet-0bbbbbbbbbbbbbbbb"]);
  });
  it("lets only the broker's group reach the load balancer, and only the load balancer reach the tasks", () => {
    const { of } = synth();
    const groups = of("AWS::EC2::SecurityGroup");
    expect(groups).toHaveLength(2);
    const ingress = JSON.stringify([groups.map((group) => group.SecurityGroupIngress ?? []), of("AWS::EC2::SecurityGroupIngress")]);
    expect(ingress).toContain("sg-0123456789abcdef0");
    expect(ingress).not.toContain("0.0.0.0/0");
    expect(JSON.stringify(groups)).not.toContain("0.0.0.0/0");
  });
  it("sends the tasks' traffic out over HTTPS to the listed ranges only, and refuses to be built with the whole internet", () => {
    const { of } = synth({ cidrs: ["10.0.0.0/16", "10.9.0.0/24"] });
    const egress = of("AWS::EC2::SecurityGroup").flatMap((group) => (group.SecurityGroupEgress ?? []) as Array<{ CidrIp?: string; FromPort?: number }>).filter((rule) => rule.CidrIp !== undefined);
    expect(egress.map((rule) => [rule.CidrIp, rule.FromPort])).toEqual([["10.0.0.0/16", 443], ["10.9.0.0/24", 443]]);
    expect(() => synth({ cidrs: ["0.0.0.0/0"] })).toThrow(/whole internet/u);
    expect(() => synth({ cidrs: [] })).toThrow();
  });
  it("runs on a read-only root file system with a scratch folder, no secret in the template, and the token injected as a secret", () => {
    const { of, json } = synth();
    const container = (of("AWS::ECS::TaskDefinition")[0]!.ContainerDefinitions as Array<Record<string, unknown>>)[0]!;
    expect(container.ReadonlyRootFilesystem).toBe(true);
    expect(container.MountPoints).toEqual([{ ContainerPath: "/tmp", ReadOnly: false, SourceVolume: "scratch" }]);
    expect(container.Command).toEqual(["node", "packages/broker/dist/mcp-host/main.js"]);
    expect((container.Secrets as Array<{ Name: string }>).map((secret) => secret.Name)).toEqual(["MCP_HOST_TOKEN"]);
    expect(JSON.stringify(container.Environment)).not.toMatch(/TOKEN|SECRET|KEY/u);
    expect(JSON.stringify(json)).not.toMatch(/"SecretString"/u);
  });
  it("lets the task role read only the MCP registry rows of its org, and nothing else", () => {
    const { of } = synth();
    const statements = of("AWS::IAM::Policy").flatMap((policy) => at(policy, "PolicyDocument", "Statement") as Array<Record<string, unknown>>);
    const read = statements.find((statement) => statement.Sid === "ReadMcpServerRegistry")!;
    expect(read.Action).toEqual(["dynamodb:GetItem", "dynamodb:Query"]);
    expect(at(read, "Condition", "ForAllValues:StringEquals", "dynamodb:LeadingKeys")).toEqual(["ORG#org_aaaaaaaaaaaaaaaaaaaa#MCPSRV"]);
    const writes = statements.flatMap((statement) => (Array.isArray(statement.Action) ? statement.Action : [statement.Action]) as string[]).filter((action) => action.startsWith("dynamodb:") ? !["dynamodb:GetItem", "dynamodb:Query"].includes(action) : action.includes("*"));
    expect(writes).toEqual([]);
    // the only other grants are the execution role's own: its log stream, and reading the token it injects
    expect(statements.flatMap((statement) => (Array.isArray(statement.Action) ? statement.Action : [statement.Action]) as string[]).filter((action) => !action.startsWith("dynamodb:")).sort())
      .toEqual(["logs:CreateLogStream", "logs:PutLogEvents", "secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]);
  });
  it("serves HTTPS only: there is no plain-HTTP mode and no start without a certificate", () => {
    const { of, host } = synth();
    expect(of("AWS::ElasticLoadBalancingV2::Listener").map((listener) => [listener.Protocol, listener.Port])).toEqual([["HTTPS", 443]]);
    expect(host.url).toMatch(/^https:\/\//u);
    expect(() => synth({ certificateArn: "" })).toThrow(/certificate/u);
    expect(() => new McpHost(new Stack(new App(), "NoCert"), "H", { vpcId: "vpc-0123456789abcdef0", availabilityZones: ["us-east-1a"], subnetIds: ["subnet-0aaaaaaaaaaaaaaaa"], image: ecs.ContainerImage.fromRegistry("x"), clientSecurityGroupIds: [], stateTableArn: "arn:aws:dynamodb:us-east-1:111111111111:table/s", stateTableName: "s", orgId: "org_aaaaaaaaaaaaaaaaaaaa", privateEgressCidrs: ["10.0.0.0/16"], hostName: "h.example.net", hostedZoneId: "Z1" } as never)).toThrow(/certificate/u);
  });
  it("is reached by a DNS name the certificate is for, through an alias record to the load balancer (review m4)", () => {
    const { of, host } = synth({ hostName: "mcp-host.corp.example.net" });
    expect(host.url).toBe("https://mcp-host.corp.example.net");
    const record = of("AWS::Route53::RecordSet")[0]!;
    expect(record.Name).toBe("mcp-host.corp.example.net");
    expect(record.Type).toBe("A");
    expect(at(record, "AliasTarget", "EvaluateTargetHealth")).toBe(true);
    for (const bad of ["", "internal-x.us-east-1.elb.amazonaws.com", "localhost", "10.0.0.5"]) expect(() => synth({ hostName: bad }), bad).toThrow(/DNS name/u);
  });
  it("starts as root only to give each hosted server its own uid, and drops the capabilities it does not need", () => {
    const { of } = synth();
    const container = (of("AWS::ECS::TaskDefinition")[0]!.ContainerDefinitions as Array<Record<string, unknown>>)[0]!;
    expect(container.User).toBe("0");
    const dropped = at(container, "LinuxParameters", "Capabilities", "Drop") as string[];
    expect(dropped).toEqual(expect.arrayContaining(["NET_RAW", "MKNOD", "SETFCAP", "SETPCAP", "DAC_OVERRIDE", "SYS_CHROOT"]));
    expect(at(container, "LinuxParameters", "Capabilities", "Add")).toBeUndefined();
    expect(dropped).not.toEqual(expect.arrayContaining(["SETUID", "SETGID", "CHOWN", "KILL"]));
  });
});
