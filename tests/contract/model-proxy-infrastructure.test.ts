import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { INFERENCE_PATHS } from "@agentx/contracts";
import { litellmConfig } from "../../packages/model-proxy/src/litellm-config.js";
import { ROVARA_GUARD_PY } from "../../packages/model-proxy/src/rovara-guard.js";
import { ROVARA_GUARD_PACKED, ROVARA_GUARD_SHA256 } from "../../packages/model-proxy/src/rovara-guard-packed.js";
import { litellmStartCommand } from "../../packages/model-proxy/src/start-command.js";
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
    // The guard module is unpacked next to the config, where LiteLLM loads callbacks from (spike, question 8), and checked against its pinned SHA-256 before LiteLLM starts.
    expect(definition.Command).toEqual([litellmStartCommand(4000)]);
    const [command] = definition.Command;
    expect(command).toMatch(/^printf "%s" "\$LITELLM_CONFIG_YAML" > \/tmp\/litellm\.yaml && python -I -c '[^']+' && exec litellm --config \/tmp\/litellm\.yaml --port 4000$/);
    // the check comes before LiteLLM, names the hash of the spike's file, and stops the container (sys.exit) rather than carrying on with a guard that does not match
    expect(command!.indexOf(ROVARA_GUARD_SHA256)).toBeGreaterThan(-1);
    expect(command!.indexOf(ROVARA_GUARD_SHA256)).toBeLessThan(command!.indexOf("exec litellm"));
    expect(command).toContain("or sys.exit(");
    expect(ROVARA_GUARD_SHA256).toBe(createHash("sha256").update(readFileSync(new URL("../../docs/learnings/model-sources-spike/rovara_guard.py", import.meta.url))).digest("hex"));
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

  it("loads the Rovara guard as a callback, caches keys for 10 seconds, and enables no client-side credential or header forwarding", () => {
    const definition = container();
    const yaml = definition.Environment.find((variable) => variable.Name === "LITELLM_CONFIG_YAML")!.Value as Ref;
    const text = yaml["Fn::Join"]![1].map((part) => (typeof part === "string" ? part : "us-east-1")).join("");
    expect(text).toContain("litellm_settings:\n  callbacks: rovara_guard.proxy_handler_instance\n");
    expect(text).toContain("  user_api_key_cache_ttl: 10\n");
    // the guard holds each call's worst case in a ledger every replica shares; LiteLLM's own per-replica reservation is off (it 422s on holds alone)
    expect(text).toContain("  disable_budget_reservation: true\n");
    // the router does not retry under the call id the guard holds for once
    expect(text).toContain("router_settings:\n  num_retries: 0\n");
    expect(text).not.toMatch(/configurable_clientside_auth_params|allow_client_side_credentials|forward_client_headers_to_llm_api|forward_traceparent/);
    // The module written next to the config is the one the spike verified: the task definition carries it packed, and unpacked it is the same bytes (and the text the package holds).
    expect(definition.Environment).toContainEqual({ Name: "ROVARA_GUARD_Z", Value: ROVARA_GUARD_PACKED });
    const unpacked = inflateSync(Buffer.from(ROVARA_GUARD_PACKED, "base64"));
    expect(unpacked.equals(readFileSync(new URL("../../docs/learnings/model-sources-spike/rovara_guard.py", import.meta.url)))).toBe(true);
    expect(unpacked.toString("utf8")).toBe(ROVARA_GUARD_PY);
    expect(createHash("sha256").update(unpacked).digest("hex")).toBe(ROVARA_GUARD_SHA256);
  });

  it("keeps the task definition well inside ECS's 64 KiB limit: the guard travels packed, not as its 40 KB text", () => {
    // ECS refuses a task definition over 64 KiB. The guard text alone was 40 KB of 46.9 KB used; packed it is about 16 KB, so the container definitions take about 20.8 KB (synth, staging) and leave room for
    // the guard to double. The region token stands in for the deploy-time value. The ceiling is 32 KiB (half the limit); a guard that no longer packs under it needs a derived image.
    const size = Buffer.byteLength(JSON.stringify(taskDefinition().Properties.ContainerDefinitions));
    expect(size).toBeLessThan(32 * 1024);
    expect(size).toBeLessThan(Buffer.byteLength(ROVARA_GUARD_PY));
    expect(JSON.stringify(taskDefinition().Properties.ContainerDefinitions)).not.toContain("proxy_handler_instance = RovaraGuard()");
  });

  it("keeps models in the database, bounds a request's time at the load balancer's idle timeout, and puts no provider or AWS credential in the environment", () => {
    const environment = container().Environment;
    expect(environment).toContainEqual({ Name: "STORE_MODEL_IN_DB", Value: "True" });
    const timeout = environment.find((variable) => variable.Name === "REQUEST_TIMEOUT");
    expect(timeout).toBeDefined();
    expect(Number(timeout!.Value)).toBeGreaterThan(0);
    expect(Number(timeout!.Value)).toBeLessThanOrEqual(900);
    // The /anthropic/... and /bedrock/... pass-through routes would use any credential found here (spike notes for Task 25).
    expect(environment.map((variable) => variable.Name).sort()).toEqual([
      "AWS_REGION", "LITELLM_CONFIG_YAML", "LITELLM_LOCAL_MODEL_COST_MAP", "REQUEST_TIMEOUT", "ROVARA_GUARD_Z", "STORE_MODEL_IN_DB",
    ]);
    expect(JSON.stringify(container().Secrets)).not.toMatch(/Anthropic|OpenAI|OpenRouter/);
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
    // The salt key encrypts the company keys the proxy stores in its database (Plan 3 Task 25); every replica needs the same one.
    expect(Object.keys(secrets).sort()).toEqual(["DATABASE_URL", "LITELLM_MASTER_KEY", "LITELLM_SALT_KEY"]);
    expect(secrets.LITELLM_SALT_KEY).toEqual({ Ref: idOf(resources, "AWS::SecretsManager::Secret", "ModelProxySaltKey") });
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

  it("generates the salt key, keeps it when the stack goes, and lets only the proxy's execution role read it", () => {
    const saltId = idOf(resources, "AWS::SecretsManager::Secret", "ModelProxySaltKey");
    const salt = resources[saltId]! as Resource & { DeletionPolicy?: string };
    expect(salt.Properties.GenerateSecretString).toMatchObject({ ExcludePunctuation: true });
    expect(Number((salt.Properties.GenerateSecretString as { PasswordLength: number }).PasswordLength)).toBeGreaterThanOrEqual(32);
    expect(salt.Properties.SecretString).toBeUndefined();
    // Losing the salt key would leave every stored company key unreadable.
    expect(salt.DeletionPolicy).toMatch(/^Retain/);
    const readers = new Set<string>();
    for (const [, policy] of ofType(resources, "AWS::IAM::Policy")) {
      if (!policy.Properties.PolicyDocument!.Statement.some((statement) => JSON.stringify(statement.Resource).includes(`"${saltId}"`))) continue;
      for (const role of policy.Properties.Roles ?? []) readers.add(role.Ref!);
    }
    expect([...readers]).toEqual([roleId(taskDefinition().Properties.ExecutionRoleArn as Ref)]);
    // Nothing else names it: not a function's environment, not a parameter, not an output.
    for (const [id, other] of Object.entries(resources)) {
      if (id === saltId || id.startsWith("ModelProxyTaskDefinition") || other.Type === "AWS::IAM::Policy") continue;
      expect(JSON.stringify(other.Properties), id).not.toContain(`"${saltId}"`);
    }
    expect(JSON.stringify(outputs)).not.toContain(saltId);
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
      // Exact paths and POST only (spike, question 2a): no wildcard reaches a pass-through or management route.
      Conditions: [
        { Field: "path-pattern", PathPatternConfig: { Values: ["/v1/messages", "/v1/responses", "/chat/completions"] } },
        { Field: "http-request-method", HttpRequestMethodConfig: { Values: ["POST"] } },
      ],
      Actions: [{ Type: "forward", TargetGroupArn: { Ref: groupId } }],
    });
    expect(group.Properties.Port).toBe(4000);
    // The list is the contract's, one path per verified transport, and none has a wildcard.
    const pattern = (rules[0]![1].Properties.Conditions as Array<{ PathPatternConfig?: { Values: string[] } }>)[0]!.PathPatternConfig!.Values;
    expect(pattern).toEqual(INFERENCE_PATHS.map((entry) => entry.path));
    for (const value of pattern) expect(value).not.toMatch(/[*?]/);
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
    // Besides those (and the cross-account assume tested below), only the three optional provider-key reads the control plane attaches.
    const others = statements.filter((statement) => !["ReadProxySecrets", "InvokeClaudeOnBedrock", "AssumeOrgBedrockRoles"].includes(statement.Sid ?? ""));
    expect(others).toHaveLength(3);
    for (const statement of others) expect(statement).toMatchObject({ Effect: "Allow", Action: "secretsmanager:GetSecretValue" });
    expect(JSON.stringify(bedrock.Resource)).not.toMatch(/foundation-model\/\*"/);
  });

  it("lets the execution role read exactly the three secrets ECS injects", () => {
    const executionRole = roleId(taskDefinition().Properties.ExecutionRoleArn as Ref);
    const reads = statementsOf(executionRole).filter((statement) => [statement.Action].flat().includes("secretsmanager:GetSecretValue"));
    expect(reads).toHaveLength(1);
    const arns = [reads[0]!.Resource].flat().map((resource) => (resource as Ref).Ref);
    expect(arns.sort()).toEqual([
      idOf(resources, "AWS::SecretsManager::Secret", "ModelProxyDatabaseUrl"),
      idOf(resources, "AWS::SecretsManager::Secret", "ModelProxyMasterKey"),
      idOf(resources, "AWS::SecretsManager::Secret", "ModelProxySaltKey"),
    ].sort());
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

  it("lets the proxy task role assume roles in other AWS accounts only, and only with an external id that names a Rovara org", () => {
    const taskRole = roleId(taskDefinition().Properties.TaskRoleArn as Ref);
    const assumes = statementsOf(taskRole).filter((statement) => [statement.Action].flat().includes("sts:AssumeRole"));
    expect(assumes).toHaveLength(1);
    expect(assumes[0]).toEqual({
      Sid: "AssumeOrgBedrockRoles",
      Effect: "Allow",
      Action: "sts:AssumeRole",
      Resource: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::*:role/*"]] },
      Condition: {
        StringNotEquals: { "aws:ResourceAccount": { Ref: "AWS::AccountId" } },
        StringLike: { "sts:ExternalId": "rovara-org_*" },
      },
    });
  });

  it("stores no company key in Secrets Manager: no org-sources secret path, and no create, put, tag or delete of a secret on any role", () => {
    expect(JSON.stringify(resources)).not.toContain("org-sources");
    const mutating = /^secretsmanager:(CreateSecret|PutSecretValue|TagResource|DeleteSecret|UpdateSecret)$/;
    for (const [id, policy] of ofType(resources, "AWS::IAM::Policy")) {
      for (const statement of policy.Properties.PolicyDocument!.Statement) {
        const actions = [statement.Action].flat();
        if (!/^(ModelProxy|ModelAccess)/.test(id) && !(policy.Properties.Roles ?? []).some((role) => /^(ModelProxy|ModelAccess)/.test(role.Ref ?? ""))) continue;
        expect(actions.filter((action) => mutating.test(action)), id).toEqual([]);
      }
    }
  });

  it("changes no network path: the tasks reach HTTPS and the database alone, and the database reaches nothing", () => {
    const service = resources[idOf(resources, "AWS::EC2::SecurityGroup", "ModelProxyServiceSecurityGroup")]!;
    expect(service.Properties.SecurityGroupEgress).toEqual([expect.objectContaining({ IpProtocol: "tcp", FromPort: 443, ToPort: 443, CidrIp: "0.0.0.0/0" })]);
    const serviceId = idOf(resources, "AWS::EC2::SecurityGroup", "ModelProxyServiceSecurityGroup");
    const extra = ofType(resources, "AWS::EC2::SecurityGroupEgress").filter(([, rule]) => (rule.Properties.GroupId as Ref)["Fn::GetAtt"]?.[0] === serviceId);
    expect(extra.map(([, rule]) => [rule.Properties.FromPort, rule.Properties.ToPort])).toEqual([[5432, 5432]]);
    const database = resources[idOf(resources, "AWS::EC2::SecurityGroup", "ModelProxyDatabaseSecurityGroup")]!;
    expect(database.Properties.SecurityGroupEgress).toEqual([expect.objectContaining({ IpProtocol: "-1", CidrIp: "127.0.0.1/32" })]);
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
