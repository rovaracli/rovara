import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { litellmConfig } from "../../packages/model-proxy/src/litellm-config.js";
import { DEFAULT_BEDROCK_MODELS } from "../../packages/model-runtime/src/config.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const LITELLM_IMAGE = "ghcr.io/berriai/litellm-database:v1.105.1@sha256:2bcadb9905b692a5ca4dadd51bccaaa23a95dc8a0f9322d9c9787f0ac2aeb50e";

type Ref = { Ref?: string; "Fn::GetAtt"?: [string, string]; "Fn::Join"?: [string, unknown[]] };
type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown };
type Properties = {
  PolicyName?: string; Roles?: Ref[]; PolicyDocument?: { Statement: Statement[] };
  GroupId?: Ref; SourceSecurityGroupId?: unknown; CidrIp?: unknown; CidrIpv6?: unknown; SecurityGroupIngress?: unknown;
  Name?: string; SecretString?: Ref; GenerateSecretString?: Record<string, unknown>; DBInstanceClass?: string;
  ContainerDefinitions?: ContainerDefinition[]; TaskRoleArn?: Ref; ExecutionRoleArn?: Ref; LoadBalancers?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};
type Resource = { Type: string; Properties: Properties };
type Resources = Record<string, Resource>;
type ContainerDefinition = {
  Name: string; Image: string; EntryPoint: string[]; Command: string[];
  Environment: Array<{ Name: string; Value: unknown }>; Secrets: Array<{ Name: string; ValueFrom: Ref }>;
};

function controlPlane(context: Record<string, unknown>): Template {
  const app = buildAgentXApp(context);
  const stack = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane");
  return Template.fromStack(stack!);
}

const ofType = (resources: Resources, type: string) => Object.entries(resources).filter(([, resource]) => resource.Type === type);
const idOf = (resources: Resources, type: string, prefix: string) => {
  const found = ofType(resources, type).filter(([id]) => id.startsWith(prefix));
  expect(found.map(([id]) => id), `${type} ${prefix}`).toHaveLength(1);
  return found[0]![0];
};

describe("model proxy infrastructure (named environments)", () => {
  let template: Template;
  let resources: Resources;
  let outputs: Record<string, { Value: unknown }>;

  beforeAll(() => {
    template = controlPlane({ agentxEnv: "staging" });
    resources = template.toJSON().Resources as Resources;
    outputs = template.toJSON().Outputs as typeof outputs;
  }, 240_000);

  const proxyService = () => {
    const services = ofType(resources, "AWS::ECS::Service");
    expect(services).toHaveLength(1);
    return services[0]![1];
  };
  const taskDefinition = () => {
    const [, definition] = ofType(resources, "AWS::ECS::TaskDefinition")[0]!;
    return definition;
  };
  const container = () => (taskDefinition().Properties.ContainerDefinitions as ContainerDefinition[])[0]!;
  const roleId = (reference: Ref) => reference["Fn::GetAtt"]?.[0] ?? reference.Ref!;
  const statementsOf = (id: string) => ofType(resources, "AWS::IAM::Policy")
    .filter(([, policy]) => (policy.Properties.Roles ?? []).some((role) => role.Ref === id))
    .flatMap(([, policy]) => policy.Properties.PolicyDocument!.Statement);

  it("runs one ARM64 Fargate service of two tasks in the private subnets, with no public address", () => {
    const service = proxyService();
    expect(service.Properties).toMatchObject({
      LaunchType: "FARGATE",
      DesiredCount: 2,
      NetworkConfiguration: { AwsvpcConfiguration: { AssignPublicIp: "DISABLED", Subnets: { "Fn::Split": [",", { Ref: "PrivateSubnetIds" }] } } },
    });
    expect(taskDefinition().Properties).toMatchObject({
      RequiresCompatibilities: ["FARGATE"],
      RuntimePlatform: { CpuArchitecture: "ARM64", OperatingSystemFamily: "LINUX" },
    });
  });

  it("runs the pinned LiteLLM image with the generated config written to a file before it starts", () => {
    const definition = container();
    expect(definition.Image).toBe(LITELLM_IMAGE);
    expect(definition.EntryPoint).toEqual(["sh", "-c"]);
    expect(definition.Command).toEqual(['printf "%s" "$LITELLM_CONFIG_YAML" > /tmp/litellm.yaml && exec litellm --config /tmp/litellm.yaml --port 4000']);
    const yaml = definition.Environment.find((variable) => variable.Name === "LITELLM_CONFIG_YAML")!.Value as Ref;
    // The region is the one deploy-time value in the text.
    const text = yaml["Fn::Join"]![1].map((part) => (typeof part === "string" ? part : (part as Ref).Ref === "AWS::Region" ? "us-east-1" : "?")).join("");
    expect(text).toContain("model_name: \"us.anthropic.claude-sonnet-4-6\"");
    expect(text).not.toContain("?");
    for (const id of new Set(Object.values(DEFAULT_BEDROCK_MODELS))) expect(text).toContain(`model_name: ${JSON.stringify(id)}`);
    const served = [...text.matchAll(/model_name: "([^"]+)"/g)].map((match) => ({ id: match[1]! }));
    expect(text).toBe(litellmConfig({ region: "us-east-1", models: served }));
    expect(served.every(({ id }) => id.startsWith("us.anthropic.claude-"))).toBe(true);
  });

  it("reads LiteLLM's prices from the cost map in the pinned image instead of fetching them at start", () => {
    expect(container().Environment).toContainEqual({ Name: "LITELLM_LOCAL_MODEL_COST_MAP", Value: "True" });
  });

  it("takes the master key and the database URL from Secrets Manager, never as plain environment", () => {
    const definition = container();
    expect(definition.Environment.map((variable) => variable.Name)).not.toEqual(expect.arrayContaining(["LITELLM_MASTER_KEY"]));
    expect(definition.Environment.map((variable) => variable.Name)).not.toContain("DATABASE_URL");
    expect(JSON.stringify(definition.Environment)).not.toMatch(/resolve:secretsmanager/);
    const secrets = Object.fromEntries(definition.Secrets.map((secret) => [secret.Name, secret.ValueFrom]));
    expect(Object.keys(secrets).sort()).toEqual(["DATABASE_URL", "LITELLM_MASTER_KEY"]);
    expect(secrets.LITELLM_MASTER_KEY).toEqual({ Ref: idOf(resources, "AWS::SecretsManager::Secret", "ModelProxyMasterKey") });
    expect(secrets.DATABASE_URL).toEqual({ Ref: idOf(resources, "AWS::SecretsManager::Secret", "ModelProxyDatabaseUrl") });
  });

  it("builds a LiteLLM master key (it must start with sk-) and a database URL from generated secrets, with no value in the template", () => {
    const masterKey = resources[idOf(resources, "AWS::SecretsManager::Secret", "ModelProxyMasterKey")]!;
    const parts = (masterKey.Properties.SecretString as Ref)["Fn::Join"]![1];
    expect(parts[0]).toBe("sk-{{resolve:secretsmanager:");
    const databaseUrl = resources[idOf(resources, "AWS::SecretsManager::Secret", "ModelProxyDatabaseUrl")]!;
    const urlParts = (databaseUrl.Properties.SecretString as Ref)["Fn::Join"]![1];
    expect(String(urlParts[0])).toMatch(/^postgresql:\/\/litellm:\{\{resolve:secretsmanager:$/);
    expect(JSON.stringify(urlParts)).toContain(":5432/litellm");
    for (const [, secret] of ofType(resources, "AWS::SecretsManager::Secret")) {
      const generated = secret.Properties.GenerateSecretString;
      if (generated !== undefined) expect(generated.ExcludePunctuation).toBe(true);
    }
  });

  it("keeps the proxy task on an Aurora Serverless v2 PostgreSQL cluster of at least 0.5 ACU, encrypted, reachable only from the proxy tasks", () => {
    const clusters = ofType(resources, "AWS::RDS::DBCluster");
    expect(clusters).toHaveLength(1);
    expect(clusters[0]![1].Properties).toMatchObject({
      Engine: "aurora-postgresql",
      StorageEncrypted: true,
      DatabaseName: "litellm",
      ServerlessV2ScalingConfiguration: { MinCapacity: 0.5 },
    });
    expect(String(JSON.stringify(clusters[0]![1].Properties.MasterUserPassword))).toContain("resolve:secretsmanager");
    expect(ofType(resources, "AWS::RDS::DBInstance")[0]![1].Properties.DBInstanceClass).toBe("db.serverless");
    const databaseGroup = idOf(resources, "AWS::EC2::SecurityGroup", "ModelProxyDatabaseSecurityGroup");
    const serviceGroup = idOf(resources, "AWS::EC2::SecurityGroup", "ModelProxyServiceSecurityGroup");
    const ingress = ofType(resources, "AWS::EC2::SecurityGroupIngress").filter(([, rule]) => (rule.Properties.GroupId as Ref)["Fn::GetAtt"]?.[0] === databaseGroup);
    expect(ingress.map(([, rule]) => rule.Properties)).toEqual([expect.objectContaining({
      IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, SourceSecurityGroupId: { "Fn::GetAtt": [serviceGroup, "GroupId"] },
    })]);
  });

  it("puts the service behind an internal load balancer on HTTP 4000 that checks LiteLLM's liveness path", () => {
    const [, balancer] = ofType(resources, "AWS::ElasticLoadBalancingV2::LoadBalancer")[0]!;
    expect(balancer.Properties).toMatchObject({ Scheme: "internal", Type: "application", Subnets: { "Fn::Split": [",", { Ref: "PrivateSubnetIds" }] } });
    const listeners = ofType(resources, "AWS::ElasticLoadBalancingV2::Listener").map(([, listener]) => listener.Properties.Port).sort();
    expect(listeners).toEqual([4000, 4001]);
    const [, group] = ofType(resources, "AWS::ElasticLoadBalancingV2::TargetGroup")[0]!;
    expect(group.Properties).toMatchObject({ Port: 4000, Protocol: "HTTP", TargetType: "ip", HealthCheckPath: "/health/liveliness", Matcher: { HttpCode: "200" } });
    const targets = proxyService().Properties.LoadBalancers as Array<Record<string, unknown>>;
    expect(targets).toEqual([expect.objectContaining({ ContainerName: "litellm", ContainerPort: 4000 })]);
  });

  it("forwards only inference paths on port 4000 and answers everything else with a fixed 403 (ruling R48)", () => {
    const listeners = ofType(resources, "AWS::ElasticLoadBalancingV2::Listener");
    const inference = listeners.find(([, listener]) => listener.Properties.Port === 4000)!;
    const [, group] = ofType(resources, "AWS::ElasticLoadBalancingV2::TargetGroup")[0]!;
    const groupId = ofType(resources, "AWS::ElasticLoadBalancingV2::TargetGroup")[0]![0];
    expect(inference[1].Properties.DefaultActions).toEqual([expect.objectContaining({ Type: "fixed-response", FixedResponseConfig: expect.objectContaining({ StatusCode: "403" }) as unknown })]);
    expect(JSON.stringify(inference[1].Properties.DefaultActions)).not.toContain("forward");
    const rules = ofType(resources, "AWS::ElasticLoadBalancingV2::ListenerRule");
    expect(rules).toHaveLength(1);
    expect(rules[0]![1].Properties).toMatchObject({
      ListenerArn: { Ref: inference[0] },
      Conditions: [{ Field: "path-pattern", PathPatternConfig: { Values: ["/v1/messages*", "/health/*"] } }],
      Actions: [{ Type: "forward", TargetGroupArn: { Ref: groupId } }],
    });
    expect(group.Properties.Port).toBe(4000);
  });

  it("forwards every path on port 4001, the management listener", () => {
    const listeners = ofType(resources, "AWS::ElasticLoadBalancingV2::Listener");
    const management = listeners.find(([, listener]) => listener.Properties.Port === 4001)!;
    expect(management[1].Properties.DefaultActions).toEqual([expect.objectContaining({ Type: "forward" })]);
    // Nothing narrows it by rule: the group that may reach it is the narrowing.
    expect(ofType(resources, "AWS::ElasticLoadBalancingV2::ListenerRule").filter(([, rule]) => (rule.Properties.ListenerArn as Ref).Ref === management[0])).toEqual([]);
  });

  it("admits the load balancer's clients only by security group, never from 0.0.0.0/0, and the management port to the model access function alone", () => {
    const balancerGroup = idOf(resources, "AWS::EC2::SecurityGroup", "ModelProxyLoadBalancerSecurityGroup");
    const group = resources[balancerGroup]!;
    expect(group.Properties.SecurityGroupIngress).toBeUndefined();
    const rules = ofType(resources, "AWS::EC2::SecurityGroupIngress").filter(([, rule]) => (rule.Properties.GroupId as Ref)["Fn::GetAtt"]?.[0] === balancerGroup);
    expect(rules.length).toBeGreaterThan(0);
    for (const [, rule] of rules) {
      expect(rule.Properties.CidrIp).toBeUndefined();
      expect(rule.Properties.CidrIpv6).toBeUndefined();
      expect(rule.Properties.SourceSecurityGroupId).toBeDefined();
    }
    const onPort = (port: number) => rules.filter(([, rule]) => rule.Properties.FromPort === port && rule.Properties.ToPort === port && rule.Properties.IpProtocol === "tcp");
    expect(onPort(4000).length + onPort(4001).length).toBe(rules.length);
    // Port 4001 (LiteLLM's management routes): the model access function's group, and no other.
    const accessGroup = idOf(resources, "AWS::EC2::SecurityGroup", "ModelAccessSecurityGroup");
    expect(onPort(4001).map(([, rule]) => rule.Properties.SourceSecurityGroupId)).toEqual([{ "Fn::GetAtt": [accessGroup, "GroupId"] }]);
    // Port 4000 (inference): the worker group, never the model access function's.
    expect(onPort(4000).map(([, rule]) => rule.Properties.SourceSecurityGroupId)).toContainEqual({ Ref: "Ec2WorkerSecurityGroupId" });
    expect(onPort(4000).map(([, rule]) => rule.Properties.SourceSecurityGroupId)).not.toContainEqual({ "Fn::GetAtt": [accessGroup, "GroupId"] });
    // The worker group's own egress to the proxy is the inference port only.
    const workerEgress = ofType(resources, "AWS::EC2::SecurityGroupEgress").filter(([, rule]) => (rule.Properties.GroupId as Ref).Ref === "Ec2WorkerSecurityGroupId" && JSON.stringify(rule.Properties.DestinationSecurityGroupId).includes(balancerGroup));
    expect(workerEgress.map(([, rule]) => [rule.Properties.FromPort, rule.Properties.ToPort])).toEqual([[4000, 4000]]);
    // Nothing inline admits anyone to any proxy group; the only open rule is the tasks' outbound HTTPS.
    for (const [id, other] of ofType(resources, "AWS::EC2::SecurityGroup").filter(([name]) => name.startsWith("ModelProxy"))) {
      expect(other.Properties.SecurityGroupIngress, id).toBeUndefined();
    }
    expect(ofType(resources, "AWS::EC2::SecurityGroupIngress").filter(([id]) => id.startsWith("ModelProxy")).map(([, rule]) => JSON.stringify(rule.Properties)).join()).not.toContain("0.0.0.0/0");
    // Only the service itself may reach the service, and only from the balancer.
    const serviceGroup = idOf(resources, "AWS::EC2::SecurityGroup", "ModelProxyServiceSecurityGroup");
    const intoService = ofType(resources, "AWS::EC2::SecurityGroupIngress").filter(([, rule]) => (rule.Properties.GroupId as Ref)["Fn::GetAtt"]?.[0] === serviceGroup);
    expect(intoService.map(([, rule]) => rule.Properties.SourceSecurityGroupId)).toEqual([{ "Fn::GetAtt": [balancerGroup, "GroupId"] }]);
  });

  it("gives the provider-key secrets to the proxy task role and to no other role", () => {
    const taskRole = roleId(taskDefinition().Properties.TaskRoleArn as Ref);
    const policies = ofType(resources, "AWS::IAM::Policy").filter(([, policy]) => /(OpenRouter|Anthropic|OpenAI)SecretRead$/.test(policy.Properties.PolicyName ?? ""));
    expect(policies.map(([, policy]) => policy.Properties.PolicyName).sort()).toEqual(["AnthropicSecretRead", "OpenAISecretRead", "OpenRouterSecretRead"]);
    for (const [, policy] of policies) expect(policy.Properties.Roles).toEqual([{ Ref: taskRole }]);
  });

  it("lets the proxy task role invoke Bedrock and read the master key and the database secret, and nothing broader", () => {
    const taskRole = roleId(taskDefinition().Properties.TaskRoleArn as Ref);
    const statements = statementsOf(taskRole);
    const bedrock = statements.find((statement) => [statement.Action].flat().includes("bedrock:InvokeModel"))!;
    expect([bedrock.Action].flat().sort()).toEqual(["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]);
    const reads = statements.find((statement) => statement.Sid === "ReadProxySecrets")!;
    expect([reads.Action].flat()).toEqual(["secretsmanager:GetSecretValue"]);
    expect([reads.Resource].flat().map((resource) => (resource as Ref).Ref).sort()).toEqual([
      idOf(resources, "AWS::SecretsManager::Secret", "ModelProxyDatabaseSecret"),
      idOf(resources, "AWS::SecretsManager::Secret", "ModelProxyMasterKey"),
    ]);
    // Besides those, only the three optional provider-key reads the control plane attaches.
    const others = statements.filter((statement) => !["ReadProxySecrets", "InvokeClaudeOnBedrock"].includes(statement.Sid ?? ""));
    expect(others).toHaveLength(3);
    for (const statement of others) expect(statement).toMatchObject({ Effect: "Allow", Action: "secretsmanager:GetSecretValue" });
    expect(JSON.stringify(bedrock.Resource)).not.toMatch(/foundation-model\/\*"/);
  });

  it("lets the execution role read exactly the two secrets ECS injects", () => {
    const executionRole = roleId(taskDefinition().Properties.ExecutionRoleArn as Ref);
    const reads = statementsOf(executionRole).filter((statement) => [statement.Action].flat().includes("secretsmanager:GetSecretValue"));
    expect(reads).toHaveLength(1);
    const arns = [reads[0]!.Resource].flat().map((resource) => (resource as Ref).Ref);
    expect(arns.sort()).toEqual([
      idOf(resources, "AWS::SecretsManager::Secret", "ModelProxyDatabaseUrl"),
      idOf(resources, "AWS::SecretsManager::Secret", "ModelProxyMasterKey"),
    ]);
  });

  it("publishes the proxy URL as an output and as the environment's model-proxy-url parameter, and the master key secret ARN as an output", () => {
    const balancer = idOf(resources, "AWS::ElasticLoadBalancingV2::LoadBalancer", "ModelProxyLoadBalancer");
    const url = { "Fn::Join": ["", ["http://", { "Fn::GetAtt": [balancer, "DNSName"] }, ":4000"]] };
    expect(outputs.ModelProxyUrl!.Value).toEqual(url);
    expect(outputs.ModelProxyMasterKeySecretArn!.Value).toEqual({ Ref: idOf(resources, "AWS::SecretsManager::Secret", "ModelProxyMasterKey") });
    const parameter = ofType(resources, "AWS::SSM::Parameter").find(([, resource]) => resource.Properties.Name === "/agentx/staging/model-proxy-url")!;
    expect(parameter[1].Properties).toMatchObject({ Type: "String", Value: url });
  });

  it("takes the VPC and the worker security group as parameters that the foundation's outputs fill", () => {
    const parameters = template.toJSON().Parameters as Record<string, unknown>;
    expect(Object.keys(parameters)).toEqual(expect.arrayContaining(["VpcId", "Ec2WorkerSecurityGroupId"]));
  });

  it("names nothing with an em dash or the word gateway, in any proxy resource id, name or description", () => {
    const proxyEntries = Object.entries(resources).filter(([id]) => id.startsWith("ModelProxy"));
    expect(proxyEntries.length).toBeGreaterThan(10);
    for (const [id, resource] of proxyEntries) {
      expect(id).not.toMatch(/gateway/i);
      expect(JSON.stringify(resource.Properties)).not.toContain("—");
      expect(JSON.stringify(resource.Properties)).not.toMatch(/gateway/i);
    }
    expect(JSON.stringify(template.toJSON().Outputs)).not.toContain("—");
  });
});

describe("model proxy infrastructure (legacy)", () => {
  it("adds no proxy to the deployment that predates environments", () => {
    const legacy = controlPlane({});
    const json = JSON.stringify(legacy.toJSON());
    expect(Object.keys(legacy.toJSON().Resources as Resources)).not.toContainEqual(expect.stringMatching(/^ModelProxy/));
    expect(Object.keys(legacy.toJSON().Parameters as Record<string, unknown>)).not.toContain("VpcId");
    expect(json).not.toContain("litellm");
    expect(legacy.findResources("AWS::ECS::Service")).toEqual({});
    expect(legacy.findResources("AWS::RDS::DBCluster")).toEqual({});
    // The legacy roles keep reading the provider keys.
    const reads = (Object.values(legacy.findResources("AWS::IAM::Policy")) as Resource[]).filter((policy) => /SecretRead$/.test(policy.Properties.PolicyName ?? ""));
    expect(reads).toHaveLength(3);
    for (const policy of reads) expect(policy.Properties.Roles).toHaveLength(2);
  }, 240_000);
});
