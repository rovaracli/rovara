// Stdio MCP host redesign (T8): the infrastructure of the MCP controller and the runner network, synthesized and read (nothing is deployed). Every guard that the design's section 14
// names is pinned here: the controller is not root, no task has a task role, no rule is the whole internet, the runner route table holds no way out, IAM is scoped to `rovara-mcp-*`,
// one cluster, one execution role and tagged security groups, the bundle bucket is encrypted with its own key, and the controller is one instance.
import { App, Stack, aws_ecs as ecs } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { McpHost, mcpHostAllowDomains, type McpHostProps } from "../../infra/lib/mcp-host.js";
import { enterpriseAllowDomains } from "../../infra/lib/vpc-endpoints.js";

type Resource = { Type: string; Properties: Record<string, unknown> };
type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource?: unknown; Condition?: Record<string, unknown> };
/** A value inside parsed template JSON, by path. */
const at = (value: unknown, ...path: Array<string | number>): unknown => path.reduce<unknown>((current, key) => (current !== null && typeof current === "object" ? (current as Record<string | number, unknown>)[key] : undefined), value);

const CERTIFICATE = "arn:aws:acm:us-east-1:111111111111:certificate/abc";
const ORG = "org_aaaaaaaaaaaaaaaaaaaa";
const RUNNER_IMAGE = `111111111111.dkr.ecr.us-east-1.amazonaws.com/rovara/mcp-runner@sha256:${"a".repeat(64)}`;
const TLS_SECRET = "arn:aws:secretsmanager:us-east-1:111111111111:secret:agentx/ent/mcp-controller-tls-AbCdEf";

function props(over: Partial<McpHostProps> = {}): McpHostProps {
  return {
    vpcId: "vpc-0123456789abcdef0", vpcCidr: "10.42.0.0/16", availabilityZones: ["us-east-1a", "us-east-1b"], subnetIds: ["subnet-0aaaaaaaaaaaaaaaa", "subnet-0bbbbbbbbbbbbbbbb"],
    runnerSubnetCidrs: ["10.42.160.0/22", "10.42.164.0/22"], region: "us-east-1", image: ecs.ContainerImage.fromRegistry("111111111111.dkr.ecr.us-east-1.amazonaws.com/rovara-broker:1"), runnerImage: RUNNER_IMAGE,
    clientSecurityGroupIds: ["sg-0123456789abcdef0"], endpointSecurityGroupId: "sg-0endpoints000000000", stateTableArn: "arn:aws:dynamodb:us-east-1:111111111111:table/state", stateTableName: "state",
    orgId: ORG, agentxEnv: "ent", registryEgressCidrs: ["10.60.0.0/24"], npmRegistry: "https://registry.corp.example.net/npm/", privateMcpCidrs: ["10.60.0.0/16"], vpcCidrs: ["10.42.0.0/16"],
    certificateArn: CERTIFICATE, hostName: "mcp-host.example.net", hostedZoneId: "Z0123456789ABCDEFGHIJ", controllerTlsSecretArn: TLS_SECRET, controllerDnsNamespace: "mcp.rovara.internal",
    ...over,
  };
}

function synth(over: Partial<McpHostProps> = {}) {
  const app = new App();
  const stack = new Stack(app, "Test", { env: { account: "111111111111", region: "us-east-1" } });
  const host = new McpHost(stack, "McpHost", props(over));
  const json = Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource> };
  const of = (type: string): Array<Record<string, unknown>> => Object.entries(json.Resources).filter(([, resource]) => resource.Type === type).map(([id, resource]) => ({ id, ...resource.Properties }));
  const policies = (): Array<{ roleRef: string; statements: Statement[] }> => of("AWS::IAM::Policy").map((policy) => ({ roleRef: JSON.stringify(policy.Roles), statements: at(policy, "PolicyDocument", "Statement") as Statement[] }));
  /** The statements attached to the role whose logical id starts with `prefix`. */
  const statementsOf = (prefix: string): Statement[] => policies().filter((policy) => policy.roleRef.includes(`"Ref":"${host.node.id}${prefix}`) || policy.roleRef.includes(prefix)).flatMap((policy) => policy.statements);
  const actionsOf = (statement: Statement): string[] => (Array.isArray(statement.Action) ? statement.Action : [statement.Action]);
  return { host, json, of, statementsOf, actionsOf };
}
const controllerContainer = (of: ReturnType<typeof synth>["of"]) => (of("AWS::ECS::TaskDefinition").find((task) => at(task, "Family") === undefined || (task.ContainerDefinitions as Array<{ Name: string }>)[0]!.Name === "Controller")!.ContainerDefinitions as Array<Record<string, unknown>>)[0]!;
const groupsText = (of: ReturnType<typeof synth>["of"]) => JSON.stringify([of("AWS::EC2::SecurityGroup"), of("AWS::EC2::SecurityGroupIngress"), of("AWS::EC2::SecurityGroupEgress")]);

describe("the controller", () => {
  it("is not root, drops every capability, has a read-only root and an init process (design section 3)", () => {
    const container = controllerContainer(synth().of);
    expect(container.User).toBe("10001");
    expect(container.ReadonlyRootFilesystem).toBe(true);
    expect(at(container, "LinuxParameters", "Capabilities", "Drop")).toEqual(["ALL"]);
    expect(at(container, "LinuxParameters", "Capabilities", "Add")).toBeUndefined();
    expect(at(container, "LinuxParameters", "InitProcessEnabled")).toBe(true);
    expect(container.Privileged).toBeUndefined();
    expect(container.MountPoints).toEqual([{ ContainerPath: "/tmp", ReadOnly: false, SourceVolume: "scratch" }]);
    expect(container.Command).toEqual(["node", "packages/broker/dist/mcp-host/main.js"]);
  });
  it("runs as exactly one instance that is replaced stop-then-start (tokens live in one process)", () => {
    const service = synth().of("AWS::ECS::Service")[0]!;
    expect(service.DesiredCount).toBe(1);
    expect(at(service, "DeploymentConfiguration", "MinimumHealthyPercent")).toBe(0);
    expect(at(service, "DeploymentConfiguration", "MaximumPercent")).toBe(100);
    expect(at(service, "NetworkConfiguration", "AwsvpcConfiguration", "AssignPublicIp")).toBe("DISABLED");
    expect(at(service, "NetworkConfiguration", "AwsvpcConfiguration", "Subnets")).toEqual(["subnet-0aaaaaaaaaaaaaaaa", "subnet-0bbbbbbbbbbbbbbbb"]);
  });
  it("is reached by the broker through an internal HTTPS-only load balancer and a DNS name the certificate is for", () => {
    const { of, host } = synth({ hostName: "mcp-host.corp.example.net" });
    expect(at(of("AWS::ElasticLoadBalancingV2::LoadBalancer")[0], "Scheme")).toBe("internal");
    expect(of("AWS::ElasticLoadBalancingV2::Listener").map((listener) => [listener.Protocol, listener.Port])).toEqual([["HTTPS", 443]]);
    expect(host.url).toBe("https://mcp-host.corp.example.net");
    expect(of("AWS::Route53::RecordSet")[0]!.Name).toBe("mcp-host.corp.example.net");
    for (const bad of ["", "internal-x.us-east-1.elb.amazonaws.com", "localhost", "10.0.0.5"]) expect(() => synth({ hostName: bad }), bad).toThrow(/DNS name/u);
    expect(() => synth({ certificateArn: "" })).toThrow(/certificate/u);
    expect(() => synth({ certificateArn: "arn:aws:iam::111111111111:server-certificate/x" })).toThrow(/ACM certificate/u);
  });
  it("is reached by the runner tasks DIRECTLY at a Cloud Map name, on a TLS port, with its certificate read from a secret (never in the template)", () => {
    const { of, host, json } = synth({ controllerCaPem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n" });
    expect(host.controllerUrl).toBe("https://controller.mcp.rovara.internal:8443");
    const env = Object.fromEntries((controllerContainer(of).Environment as Array<{ Name: string; Value: unknown }>).map((entry) => [entry.Name, entry.Value]));
    expect(env.MCP_CONTROLLER_URL).toBe("https://controller.mcp.rovara.internal:8443");
    expect(String(env.ROVARA_MCP_CONTROLLER_CA)).toContain("BEGIN CERTIFICATE");
    const secrets = (controllerContainer(of).Secrets as Array<{ Name: string; ValueFrom: unknown }>);
    expect(secrets.map((secret) => secret.Name).sort()).toEqual(["MCP_CONTROLLER_TLS_CERT", "MCP_CONTROLLER_TLS_KEY", "MCP_HOST_TOKEN"]);
    expect(JSON.stringify(secrets.filter((secret) => secret.Name.startsWith("MCP_CONTROLLER_TLS")).map((secret) => secret.ValueFrom))).toContain(TLS_SECRET);
    const registrations = of("AWS::ServiceDiscovery::Service");
    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.Name).toBe("controller");
    expect(JSON.stringify(json)).not.toMatch(/"SecretString"|PRIVATE KEY/u);
    for (const bad of ["not-an-arn", "arn:aws:iam::111111111111:role/x", ""]) expect(() => synth({ controllerTlsSecretArn: bad }), bad).toThrow(/Secrets Manager/u);
    expect(() => synth({ controllerCaPem: "not a certificate" })).toThrow(/PEM/u);
  });
  it("gets every setting the controller's start-up reads, and no secret in its plain environment", () => {
    const { of } = synth();
    const container = controllerContainer(of);
    const names = (container.Environment as Array<{ Name: string }>).map((entry) => entry.Name).sort();
    expect(names).toEqual([
      "AGENTX_ENV", "AWS_REGION", "MCP_BUNDLE_BUCKET", "MCP_CONTROLLER_SECURITY_GROUP", "MCP_CONTROLLER_URL", "MCP_ECS_CLUSTER", "MCP_ENDPOINT_SECURITY_GROUPS", "MCP_EXECUTION_ROLE_ARN",
      "MCP_INSTALL_SECURITY_GROUP", "MCP_RUNNER_IMAGE", "MCP_RUNNER_LOG_GROUP", "MCP_RUNNER_PORT", "MCP_RUNNER_SUBNETS", "MCP_S3_PREFIX_LIST", "MCP_VPC_ID", "PORT", "ROVARA_MCP_NPM_REGISTRY",
      "ROVARA_ORG_ID", "ROVARA_PRIVATE_MCP_CIDRS", "ROVARA_VPC_CIDRS", "STATE_TABLE_NAME",
    ]);
    expect(JSON.stringify(container.Environment)).not.toMatch(/TOKEN|SECRET|PRIVATE_KEY/u);
    const env = Object.fromEntries((container.Environment as Array<{ Name: string; Value: unknown }>).map((entry) => [entry.Name, entry.Value]));
    expect(env.MCP_RUNNER_IMAGE).toBe(RUNNER_IMAGE);
    expect(env.ROVARA_MCP_NPM_REGISTRY).toBe("https://registry.corp.example.net/npm/");
    expect(env.ROVARA_PRIVATE_MCP_CIDRS).toBe("10.60.0.0/16");
  });
});

describe("the runner network", () => {
  it("is dedicated subnets in the VPC's range with a route table that has NO route: no NAT, no internet gateway, no IPv6", () => {
    const { of, json } = synth();
    const subnets = of("AWS::EC2::Subnet");
    expect(subnets.map((subnet) => [subnet.CidrBlock, subnet.AvailabilityZone, subnet.MapPublicIpOnLaunch])).toEqual([["10.42.160.0/22", "us-east-1a", false], ["10.42.164.0/22", "us-east-1b", false]]);
    expect(subnets.some((subnet) => subnet.Ipv6CidrBlock !== undefined || subnet.AssignIpv6AddressOnCreation === true)).toBe(false);
    expect(of("AWS::EC2::RouteTable")).toHaveLength(1);
    expect(of("AWS::EC2::Route")).toEqual([]);
    expect(of("AWS::EC2::NatGateway")).toEqual([]);
    expect(of("AWS::EC2::InternetGateway")).toEqual([]);
    const associations = of("AWS::EC2::SubnetRouteTableAssociation");
    expect(associations).toHaveLength(2);
    expect(JSON.stringify(json)).not.toMatch(/"::\/0"|DestinationIpv6CidrBlock|GatewayId|NatGatewayId|EgressOnlyInternetGatewayId/u);
  });
  it("reaches S3 through a gateway endpoint on that table (image layers) with the install's own policy, and the ECS API through an interface endpoint", () => {
    const { of } = synth();
    const endpoints = of("AWS::EC2::VPCEndpoint");
    const s3 = endpoints.find((endpoint) => endpoint.VpcEndpointType === "Gateway")!;
    expect(s3.ServiceName).toBe("com.amazonaws.us-east-1.s3");
    expect(JSON.stringify(s3.RouteTableIds)).toContain("RunnerRouteTable");
    expect(JSON.stringify(s3.PolicyDocument)).toContain("aws:ResourceAccount");
    const api = endpoints.find((endpoint) => endpoint.VpcEndpointType === "Interface")!;
    expect(api.ServiceName).toBe("com.amazonaws.us-east-1.ecs");
    expect(api.PrivateDnsEnabled).toBe(true);
    expect(api.SecurityGroupIds).toEqual(["sg-0endpoints000000000"]);
    expect(JSON.stringify(api.PolicyDocument)).toContain("aws:PrincipalAccount");
  });
  it("lets the endpoints' group take HTTPS from the runner subnets, one rule each", () => {
    const rules = synth().of("AWS::EC2::SecurityGroupIngress").filter((rule) => rule.GroupId === "sg-0endpoints000000000");
    expect(rules.map((rule) => [rule.CidrIp, rule.FromPort, rule.ToPort, rule.IpProtocol])).toEqual([["10.42.160.0/22", 443, 443, "tcp"], ["10.42.164.0/22", 443, 443, "tcp"]]);
  });
  it("refuses a runner range that is not inside the VPC, overlaps another, or is not an IPv4 range of a sensible size", () => {
    for (const cidr of ["10.43.0.0/22", "192.168.0.0/24", "10.42.160.0/8", "10.42.160.0/27", "nonsense", "0.0.0.0/0"]) expect(() => synth({ runnerSubnetCidrs: [cidr] }), cidr).toThrow(/runner subnet range/u);
    expect(() => synth({ runnerSubnetCidrs: ["10.42.160.0/22", "10.42.162.0/23"] })).toThrow(/overlap/u);
    expect(() => synth({ runnerSubnetCidrs: [] })).toThrow(/one subnet range/u);
    expect(() => synth({ runnerSubnetCidrs: ["10.42.160.0/22", "10.42.164.0/22", "10.42.168.0/22"] })).toThrow(/one subnet range/u);
  });
});

describe("security groups", () => {
  it("never hold the whole internet, in any rule of any group", () => {
    const text = groupsText(synth().of);
    expect(text).not.toContain("0.0.0.0/0");
    expect(text).not.toContain("::/0");
    expect(() => synth({ registryEgressCidrs: ["0.0.0.0/0"] })).toThrow(/whole internet/u);
    expect(() => synth({ registryEgressCidrs: ["10.0.0.0/0"] })).toThrow(/whole internet/u);
    expect(() => synth({ registryEgressCidrs: [] })).toThrow(/whole internet/u);
    expect(() => synth({ privateMcpCidrs: ["10.0.0.0/0"] })).toThrow(/whole internet/u);
  });
  it("let only the broker's group reach the load balancer, only the load balancer reach the controller on the broker port, and only the runner subnets on the runner port", () => {
    const { of } = synth();
    const text = groupsText(of);
    expect(text).toContain("sg-0123456789abcdef0");
    const controller = of("AWS::EC2::SecurityGroup").find((group) => String(group.GroupDescription).startsWith("MCP controller tasks"))!;
    const inline = (controller.SecurityGroupIngress ?? []) as Array<Record<string, unknown>>;
    const separate = of("AWS::EC2::SecurityGroupIngress").filter((rule) => JSON.stringify(rule.GroupId).includes(String(controller.id)));
    expect([...inline, ...separate].map((rule) => [rule.FromPort, rule.CidrIp ?? (rule.SourceSecurityGroupId === undefined ? "?" : "load balancer")]).sort())
      .toEqual([[8080, "load balancer"], [8443, "10.42.160.0/22"], [8443, "10.42.164.0/22"]]);
  });
  it("hold, for the install task, only the endpoints, S3, the registry's ranges and the controller; for the controller, the endpoints, S3, DynamoDB and the runner subnets", () => {
    const { of } = synth();
    const groups = of("AWS::EC2::SecurityGroup");
    const egressOf = (name: string) => {
      const group = groups.find((item) => String(item.GroupDescription).startsWith(name))!;
      const inline = (group.SecurityGroupEgress ?? []) as Array<Record<string, unknown>>;
      const separate = of("AWS::EC2::SecurityGroupEgress").filter((rule) => JSON.stringify(rule.GroupId).includes(String(group.id)));
      return [...inline, ...separate].filter((rule) => rule.IpProtocol !== "icmp").map((rule) => `${String(rule.FromPort)}:${typeof rule.CidrIp === "string" ? rule.CidrIp : (rule.DestinationSecurityGroupId === undefined ? "?" : "group")}${rule.DestinationPrefixListId === undefined ? "" : "/prefix-list"}`).sort();
    };
    expect(egressOf("MCP install task")).toEqual(["443:10.60.0.0/24", "443:group", "443:?/prefix-list", "8443:group"].sort());
    expect(egressOf("MCP controller tasks")).toEqual(["443:group", "443:?/prefix-list", "443:?/prefix-list", "8080:10.42.160.0/22", "8080:10.42.164.0/22"].sort());
  });
  it("give the install task no ingress at all", () => {
    const { of } = synth();
    const install = of("AWS::EC2::SecurityGroup").find((item) => String(item.GroupDescription).startsWith("MCP install task"))!;
    expect(install.SecurityGroupIngress).toBeUndefined();
    expect(of("AWS::EC2::SecurityGroupIngress").filter((rule) => JSON.stringify(rule.GroupId).includes(String(install.id)))).toEqual([]);
  });
});

describe("no task has a task role, and the install task is a static, locked-down definition", () => {
  it("the install family is `rovara-mcp-install` with no task role, a non-root user, a read-only root, every capability dropped and the execution role", () => {
    const { of } = synth();
    const install = of("AWS::ECS::TaskDefinition").find((task) => task.Family === "rovara-mcp-install")!;
    expect(install.TaskRoleArn).toBeUndefined();
    expect(JSON.stringify(install.ExecutionRoleArn)).toContain("RunnerExecutionRole");
    expect(install.RequiresCompatibilities).toEqual(["FARGATE"]);
    const container = (install.ContainerDefinitions as Array<Record<string, unknown>>)[0]!;
    expect(container.User).toBe("10002:10002");
    expect(container.ReadonlyRootFilesystem).toBe(true);
    expect(at(container, "LinuxParameters", "Capabilities", "Drop")).toEqual(["ALL"]);
    expect(container.Privileged).toBeUndefined();
    expect(container.Image).toBe(RUNNER_IMAGE);
    expect(container.Command).toEqual(["/usr/local/bin/node", "/opt/mcp-runner/install.mjs"]);
    expect(container.Environment).toBeUndefined();
    expect(container.Secrets).toBeUndefined();
    expect(container.MountPoints).toEqual([{ ContainerPath: "/work", ReadOnly: false, SourceVolume: "work" }, { ContainerPath: "/tmp", ReadOnly: false, SourceVolume: "tmp" }]);
  });
  it("the infrastructure holds exactly three groups (load balancer, controller, install): every server's own group is made by the controller", () => {
    const { of } = synth();
    expect(of("AWS::EC2::SecurityGroup")).toHaveLength(3);
  });
  it("refuses a runner image that is not this account's ECR image pinned by digest, or is in another region", () => {
    for (const image of ["", "node:22", `111111111111.dkr.ecr.us-east-1.amazonaws.com/rovara/mcp-runner:latest`, `docker.io/library/node@sha256:${"a".repeat(64)}`, `111111111111.dkr.ecr.eu-west-1.amazonaws.com/x@sha256:${"a".repeat(64)}`]) {
      expect(() => synth({ runnerImage: image }), image).toThrow(/runner image/u);
    }
  });
});

describe("the runner execution role", () => {
  it("is assumed by ECS tasks of this account only and reads only this org's `mcp*` secrets that carry the org's tag, pulls only the runner repository, and writes only the runner log group", () => {
    const { json, statementsOf, actionsOf } = synth();
    const role = Object.values(json.Resources).find((resource) => resource.Type === "AWS::IAM::Role" && JSON.stringify(resource.Properties).includes("RunnerExecution") === false && String(at(resource.Properties, "Description")).startsWith("Rovara MCP runner tasks"))!;
    expect(at(role.Properties, "AssumeRolePolicyDocument", "Statement", 0, "Principal", "Service")).toBe("ecs-tasks.amazonaws.com");
    expect(at(role.Properties, "AssumeRolePolicyDocument", "Statement", 0, "Condition", "StringEquals", "aws:SourceAccount")).toBe("111111111111");
    const statements = statementsOf("RunnerExecutionRole");
    const secrets = statements.find((statement) => statement.Sid === "ReadApprovedServerSecrets")!;
    expect(actionsOf(secrets)).toEqual(["secretsmanager:GetSecretValue"]);
    expect(JSON.stringify(secrets.Resource)).toContain(`secret:agentx/ent/org-connectors/${ORG}/mcp*`);
    expect(at(secrets, "Condition", "StringEquals", "secretsmanager:ResourceTag/rovara:org")).toBe(ORG);
    const pull = statements.find((statement) => statement.Sid === "PullTheRunnerImage")!;
    expect(JSON.stringify(pull.Resource)).toContain("repository/rovara/mcp-runner");
    expect(JSON.stringify(pull.Resource)).not.toContain("*");
    const logsStatement = statements.find((statement) => statement.Sid === "RunnerLogs")!;
    expect(actionsOf(logsStatement)).toEqual(["logs:CreateLogStream", "logs:PutLogEvents"]);
    expect(JSON.stringify(logsStatement.Resource)).toContain("RunnerLogs");
    // nothing else: no wildcard action, nothing on the state table, the bundle bucket, KMS or ECS
    const allActions = statements.flatMap(actionsOf).sort();
    expect(allActions).toEqual(["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetAuthorizationToken", "ecr:GetDownloadUrlForLayer", "logs:CreateLogStream", "logs:PutLogEvents", "secretsmanager:GetSecretValue"]);
  });
});

describe("the controller's task role is scoped to what the controller makes", () => {
  const find = (statements: Statement[], sid: string): Statement => statements.find((statement) => statement.Sid === sid)!;
  it("starts, stops and describes tasks only of `rovara-mcp-*` families in its one cluster", () => {
    const { statementsOf, actionsOf } = synth();
    const statements = statementsOf("ControllerTaskRole");
    const run = find(statements, "RunMcpTasks");
    expect(actionsOf(run)).toEqual(["ecs:RunTask"]);
    expect(JSON.stringify(run.Resource)).toContain("task-definition/rovara-mcp-*:*");
    expect(JSON.stringify(at(run, "Condition", "ArnEquals", "ecs:cluster"))).toContain("Cluster");
    // RunTask may not turn on ECS Exec. It takes no ecs:subnet or ecs:auto-assign-public-ip condition (those are CreateService and UpdateService keys: a condition on them would deny every RunTask).
    expect(at(run, "Condition", "StringEqualsIfExists", "ecs:enable-execute-command")).toBe("false");
    expect(JSON.stringify(run.Condition)).not.toMatch(/ecs:subnet|ecs:auto-assign-public-ip/u);
    const stop = find(statements, "StopAndDescribeMcpTasks");
    expect(actionsOf(stop)).toEqual(["ecs:StopTask", "ecs:DescribeTasks"]);
    expect(JSON.stringify(at(stop, "Condition", "ArnEquals", "ecs:cluster"))).toContain("Cluster");
    expect(JSON.stringify(stop.Resource)).toContain(":task/");
    const list = find(statements, "ListTasksInTheCluster");
    expect(JSON.stringify(at(list, "Condition", "ArnEquals", "ecs:cluster"))).toContain("Cluster");
  });
  it("registers task definitions only in `rovara-mcp-*` families and only tagged as managed; the actions IAM cannot scope are listed, and they cannot run or pass anything", () => {
    const { statementsOf, actionsOf } = synth();
    const statements = statementsOf("ControllerTaskRole");
    const register = find(statements, "RegisterMcpTaskDefinitions");
    expect(JSON.stringify(register.Resource)).toContain("task-definition/rovara-mcp-*:*");
    expect(at(register, "Condition", "StringEquals", "aws:RequestTag/rovara:managed")).toBe("rovara-mcp");
    expect(actionsOf(find(statements, "ReadAndRetireTaskDefinitions")).sort()).toEqual(["ecs:DeregisterTaskDefinition", "ecs:DescribeTaskDefinition", "ecs:ListTaskDefinitionFamilies", "ecs:ListTaskDefinitions"]);
    const tagging = find(statements, "TagOnCreateOnly");
    expect(at(tagging, "Condition", "StringEquals", "ecs:CreateAction")).toEqual(["RunTask", "RegisterTaskDefinition"]);
  });
  it("may pass the runner execution role and no other, and only to ECS tasks", () => {
    const { statementsOf } = synth();
    const statements = statementsOf("ControllerTaskRole");
    const pass = find(statements, "PassTheRunnerExecutionRoleOnly");
    expect(JSON.stringify(pass.Resource)).toContain("RunnerExecutionRole");
    expect(Array.isArray(pass.Resource)).toBe(false);
    expect(at(pass, "Condition", "StringEquals", "iam:PassedToService")).toBe("ecs-tasks.amazonaws.com");
    expect(statements.flatMap((statement) => (Array.isArray(statement.Action) ? statement.Action : [statement.Action])).filter((action) => action.startsWith("iam:") || action === "*" || action.endsWith(":*"))).toEqual(["iam:PassRole"]);
  });
  it("creates security groups only in its VPC and only tagged managed, changes and deletes only groups tagged managed, and never writes a rule outside a group", () => {
    const { statementsOf, actionsOf } = synth();
    const statements = statementsOf("ControllerTaskRole");
    expect(JSON.stringify(find(statements, "CreateSecurityGroupsInTheVpc").Resource)).toContain("vpc/vpc-0123456789abcdef0");
    expect(at(find(statements, "CreateManagedSecurityGroups"), "Condition", "StringEquals", "aws:RequestTag/rovara:managed")).toBe("rovara-mcp");
    const tags = find(statements, "TagSecurityGroupsAtCreation");
    expect(at(tags, "Condition", "StringEquals", "ec2:CreateAction")).toBe("CreateSecurityGroup");
    expect(at(tags, "Condition", "StringEquals", "aws:RequestTag/rovara:managed")).toBe("rovara-mcp");
    const change = find(statements, "ChangeManagedSecurityGroups");
    expect(actionsOf(change).sort()).toEqual(["ec2:AuthorizeSecurityGroupEgress", "ec2:AuthorizeSecurityGroupIngress", "ec2:DeleteSecurityGroup", "ec2:RevokeSecurityGroupEgress", "ec2:RevokeSecurityGroupIngress"]);
    expect(at(change, "Condition", "StringEquals", "aws:ResourceTag/rovara:managed")).toBe("rovara-mcp");
    expect(JSON.stringify(change.Resource)).toContain("security-group/*");
    // nothing on subnets, route tables, gateways, endpoints, network interfaces
    const ec2Actions = statements.flatMap((statement) => (Array.isArray(statement.Action) ? statement.Action : [statement.Action])).filter((action) => action.startsWith("ec2:")).sort();
    expect(ec2Actions).toEqual(["ec2:AuthorizeSecurityGroupEgress", "ec2:AuthorizeSecurityGroupIngress", "ec2:CreateSecurityGroup", "ec2:CreateSecurityGroup", "ec2:CreateTags", "ec2:DeleteSecurityGroup", "ec2:DescribeSecurityGroups", "ec2:RevokeSecurityGroupEgress", "ec2:RevokeSecurityGroupIngress"]);
  });
  it("reads only the registry, and writes only the probe slots, instance leases and its own events, each by the org's partition key", () => {
    const { statementsOf, actionsOf } = synth();
    const statements = statementsOf("ControllerTaskRole");
    const keys = (statement: Statement) => at(statement, "Condition", "ForAllValues:StringEquals", "dynamodb:LeadingKeys");
    const read = find(statements, "ReadMcpServerRegistry");
    expect(actionsOf(read)).toEqual(["dynamodb:GetItem", "dynamodb:Query"]);
    expect(keys(read)).toEqual([`ORG#${ORG}#MCPSRV`]);
    const slots = find(statements, "ProbeSlotsAndInstanceLeases");
    expect(actionsOf(slots)).toEqual(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]);
    expect(keys(slots)).toEqual([`ORG#${ORG}#MCPSLOT`]);
    const events = find(statements, "WriteControllerEvents");
    expect(actionsOf(events)).toEqual(["dynamodb:PutItem"]);
    expect(keys(events)).toEqual([`ORG#${ORG}#MCPEVT`]);
    for (const statement of [read, slots, events]) expect(at(statement, "Condition", "Null", "dynamodb:LeadingKeys")).toBe("false");
    // no write to the registry partition, and no other DynamoDB action anywhere
    expect(statements.flatMap(actionsOf).filter((action) => action.startsWith("dynamodb:")).sort()).toEqual(["dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:PutItem", "dynamodb:Query"]);
  });
  it("reaches Secrets Manager only to find the ARN of this org's `mcp*` secrets, never to read one", () => {
    const { statementsOf, actionsOf } = synth();
    const statements = statementsOf("ControllerTaskRole");
    const describe = find(statements, "ResolveServerSecretArns");
    expect(actionsOf(describe)).toEqual(["secretsmanager:DescribeSecret"]);
    expect(JSON.stringify(describe.Resource)).toContain(`org-connectors/${ORG}/mcp*`);
    expect(statements.flatMap(actionsOf).filter((action) => action.startsWith("secretsmanager:") && action !== "secretsmanager:DescribeSecret")).toEqual([]);
  });
  it("reads and writes only the `bundles/` objects of the bundle bucket, lists that bucket, and uses only its own key", () => {
    const { statementsOf, actionsOf } = synth();
    const statements = statementsOf("ControllerTaskRole");
    const objects = find(statements, "ReadAndWriteBundles");
    expect(actionsOf(objects)).toEqual(["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload"]);
    expect(JSON.stringify(objects.Resource)).toContain("/bundles/*");
    expect(JSON.stringify(objects.Resource)).toContain("Bundles");
    expect(actionsOf(find(statements, "SeeWhichBundlesExist"))).toEqual(["s3:ListBucket"]);
    expect(statements.flatMap(actionsOf).filter((action) => action.startsWith("s3:")).sort()).toEqual(["s3:AbortMultipartUpload", "s3:GetObject", "s3:ListBucket", "s3:PutObject"]);
    const key = find(statements, "UseTheBundleKey");
    expect(actionsOf(key)).toEqual(["kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"]);
    expect(JSON.stringify(key.Resource)).toContain("BundleKey");
    expect(statements.flatMap(actionsOf).filter((action) => action.startsWith("kms:"))).toEqual(["kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"]);
  });
});

describe("the bundle bucket", () => {
  it("is encrypted with its own rotating key, private, TLS-only, versioned and retained, with a lifecycle that clears failed uploads and replaced versions", () => {
    const { of, json } = synth();
    const bucket = of("AWS::S3::Bucket")[0]!;
    expect(at(bucket, "BucketEncryption", "ServerSideEncryptionConfiguration", 0, "ServerSideEncryptionByDefault", "SSEAlgorithm")).toBe("aws:kms");
    expect(JSON.stringify(at(bucket, "BucketEncryption", "ServerSideEncryptionConfiguration", 0, "ServerSideEncryptionByDefault", "KMSMasterKeyID"))).toContain("BundleKey");
    expect(at(bucket, "PublicAccessBlockConfiguration")).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
    expect(at(bucket, "VersioningConfiguration", "Status")).toBe("Enabled");
    const rules = at(bucket, "LifecycleConfiguration", "Rules") as Array<Record<string, unknown>>;
    expect(rules.map((rule) => [rule.Id, at(rule, "AbortIncompleteMultipartUpload", "DaysAfterInitiation"), at(rule, "NoncurrentVersionExpiration", "NoncurrentDays")])).toEqual([["abort-incomplete-uploads", 1, undefined], ["expire-replaced-versions", undefined, 30]]);
    expect(rules.some((rule) => rule.ExpirationInDays !== undefined)).toBe(false);
    expect(json.Resources[String(bucket.id)]).toMatchObject({ DeletionPolicy: "Retain" });
    expect(JSON.stringify(of("AWS::S3::BucketPolicy"))).toContain("aws:SecureTransport");
    const key = of("AWS::KMS::Key")[0]!;
    expect(key.EnableKeyRotation).toBe(true);
    expect(json.Resources[String(key.id)]).toMatchObject({ DeletionPolicy: "Retain" });
  });
});

describe("the names the install's DNS firewall must let through", () => {
  it("are the controller's Cloud Map name, the registry host and the ECS API, and the default allow-list is unchanged", () => {
    expect(mcpHostAllowDomains({ controllerDnsNamespace: "mcp.rovara.internal", npmRegistry: "https://registry.corp.example.net/npm/", region: "us-east-1" })).toEqual(["controller.mcp.rovara.internal", "ecs.us-east-1.amazonaws.com", "registry.corp.example.net"]);
    expect(enterpriseAllowDomains("us-east-1")).not.toContain("ecs.us-east-1.amazonaws.com");
    expect(enterpriseAllowDomains("us-east-1", { stdioMcp: true })).toContain("ecs.us-east-1.amazonaws.com");
    expect(enterpriseAllowDomains("us-east-1", { stdioMcp: true }).filter((name) => name !== "ecs.us-east-1.amazonaws.com")).toEqual(enterpriseAllowDomains("us-east-1"));
  });
  it("refuses a registry that is not an https address without credentials", () => {
    for (const registry of ["http://registry.corp.example.net/", "https://user:pw@registry.corp.example.net/", "not a url", "https://registry.corp.example.net/?token=x"]) expect(() => synth({ npmRegistry: registry }), registry).toThrow(/registry/u);
  });
});
