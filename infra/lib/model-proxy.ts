import { INFERENCE_PATHS, MODEL_PROXY_INFERENCE_PORT, MODEL_PROXY_URL_PARAMETER, modelProxyTaskRoleName } from "@agentx/contracts";
import { ROVARA_GUARD_PY, litellmConfig } from "@agentx/model-proxy";
import {
  Duration,
  Fn,
  RemovalPolicy,
  SecretValue,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_logs as logs,
  aws_rds as rds,
  aws_secretsmanager as secretsmanager,
  aws_ssm as ssm,
  Stack,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { BUNDLE_IMAGE_NAMES, LITELLM_SOURCE_IMAGE, bundleImageRepositoryArn, bundleImageUri, imageDigestOf } from "./bundle-images.js";
import type { AgentXNaming } from "./naming.js";
import { enterpriseHttpsEgress } from "./vpc-endpoints.js";

/** LiteLLM, pinned by digest (spike: docs/learnings/model-proxy-spike.md). ghcr.io is public; a Public install's tasks pull it through the NAT. An Enterprise install pulls the same digest from its own ECR (`bundledImages`). */
export const LITELLM_IMAGE = LITELLM_SOURCE_IMAGE;
// Shared with the broker, which builds the proxy's URL from the load balancer's name and this port (derived-names.ts).
export const MODEL_PROXY_PORT = MODEL_PROXY_INFERENCE_PORT;
/**
 * The load balancer's second listener, for LiteLLM's management routes (teams, users, key minting, spend). Only the
 * ModelAccessFunction's group may reach it; the worker and orchestrator groups reach port 4000 alone, where only inference
 * paths are forwarded (ruling R48).
 */
export const MODEL_PROXY_MANAGEMENT_PORT = 4001;
/**
 * The only requests the inference listener forwards: POST to the exact paths Pi's three transports use (spike, question 2a). No
 * wildcard, so a pass-through or management route cannot be reached by a path that merely starts the same way; the health check
 * goes to the target group directly and needs no listener rule.
 */
export const INFERENCE_PATH_PATTERNS: readonly string[] = INFERENCE_PATHS.map((entry) => entry.path);
/**
 * LiteLLM's per-request timeout in seconds (its own default is 6000). At most the load balancer's idle timeout, so the proxy gives up
 * on a request before the load balancer cuts the connection under it.
 */
export const MODEL_PROXY_REQUEST_TIMEOUT_SECONDS = 900;
const DATABASE_NAME = "litellm";
const DATABASE_USER = "litellm";
/** LiteLLM's unauthenticated liveness route. */
const HEALTH_CHECK_PATH = "/health/liveliness";
/**
 * Writes the generated config and the guard module beside it (LiteLLM loads a callback module from the config's directory), then
 * replaces the shell with LiteLLM so it receives the stop signal.
 */
const START_COMMAND = `printf "%s" "$LITELLM_CONFIG_YAML" > /tmp/litellm.yaml && printf "%s" "$ROVARA_GUARD_PY" > /tmp/rovara_guard.py && exec litellm --config /tmp/litellm.yaml --port ${MODEL_PROXY_PORT}`;

/**
 * `sts:AssumeRole` into another AWS account's role, for a company's own Bedrock source: never a role in this account, and only with
 * an external id that starts `rovara-org_` (the account's trust policy must then require this org's exact id; the probe checks that).
 */
export function assumeOrgBedrockRoles(stack: Stack): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: "AssumeOrgBedrockRoles",
    actions: ["sts:AssumeRole"],
    resources: [`arn:${stack.partition}:iam::*:role/*`],
    conditions: {
      StringNotEquals: { "aws:ResourceAccount": stack.account },
      StringLike: { "sts:ExternalId": "rovara-org_*" },
    },
  });
}

export interface ModelProxyProps {
  naming: AgentXNaming;
  vpcId: string;
  /** The foundation's private subnets, which have NAT egress. */
  subnetIds: string[];
  /** Security groups whose members may call the proxy, in both directions: the worker group. (The Slack orchestrator's group has its own rules in its stack.) */
  clientSecurityGroupIds: string[];
  /** Bedrock model ids as Pi's catalog names them; the proxy serves exactly these (ruling R21). */
  models: ReadonlyArray<{ id: string }>;
  /** Enterprise installs: the ranges the proxy's tasks may reach over HTTPS (the VPC's endpoints and what the customer approved). Absent: HTTPS to the whole internet, as before. */
  privateEgressCidrs?: readonly string[];
  /**
   * Enterprise installs: run LiteLLM from the install's own ECR (loaded from the signed release bundle, same digest) instead of ghcr.io, and let
   * the execution role pull it from there. Absent: the public image, as before.
   */
  bundledImages?: boolean;
}

/**
 * The LiteLLM model proxy: the only holder of provider keys and Bedrock access (spec: model proxy).
 * Two Fargate tasks behind an internal load balancer, keyed and budgeted in an Aurora Serverless v2
 * PostgreSQL database. Follows the L1 ECS pattern of slack-orchestrator.ts.
 */
export class ModelProxy extends Construct {
  readonly taskRole: iam.Role;
  /** The inference listener (port 4000): what workers and the orchestrator call, and what a member's key is handed out with. */
  readonly url: string;
  /** The load balancer's name, the first label of its DNS name; the URL is `http://<name>.<region>.elb.amazonaws.com:<MODEL_PROXY_PORT>` (the broker builds it from this). */
  readonly loadBalancerName: string;
  /** The management listener (port 4001): every path, reachable only from the ModelAccessFunction. */
  readonly managementUrl: string;
  readonly masterKeySecret: secretsmanager.Secret;
  readonly loadBalancerSecurityGroup: ec2.CfnSecurityGroup;

  constructor(scope: Construct, id: string, props: ModelProxyProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const { naming } = props;
    const tags = [{ key: "Application", value: "AgentX" }, ...(naming.env === undefined ? [] : [{ key: "agentx:env", value: naming.env }])];
    const port = MODEL_PROXY_PORT;

    // Security groups: clients -> load balancer -> service -> database. Every rule between groups is a
    // separate resource, so no group's definition refers to a group that refers back.
    this.loadBalancerSecurityGroup = new ec2.CfnSecurityGroup(this, "LoadBalancerSecurityGroup", {
      groupDescription: `AgentX model proxy load balancer: port ${port} (inference) from registered clients, port ${MODEL_PROXY_MANAGEMENT_PORT} (management) from the model access function only`,
      vpcId: props.vpcId,
      tags,
    });
    const serviceSecurityGroup = new ec2.CfnSecurityGroup(this, "ServiceSecurityGroup", {
      groupDescription: `AgentX model proxy tasks: port ${port} from the load balancer only`,
      vpcId: props.vpcId,
      securityGroupEgress: props.privateEgressCidrs === undefined ? [{
        ipProtocol: "tcp", fromPort: 443, toPort: 443, cidrIp: "0.0.0.0/0",
        description: "HTTPS to Amazon Bedrock, Secrets Manager, CloudWatch Logs and the LiteLLM image registry",
      }] : enterpriseHttpsEgress(props.privateEgressCidrs, "HTTPS to the VPC endpoints"),
      tags,
    });
    const databaseSecurityGroup = new ec2.CfnSecurityGroup(this, "DatabaseSecurityGroup", {
      groupDescription: "AgentX model proxy database: PostgreSQL from the proxy tasks only",
      vpcId: props.vpcId,
      // An explicit loopback-only rule replaces the allow-all default egress.
      securityGroupEgress: [{ ipProtocol: "-1", cidrIp: "127.0.0.1/32", description: "No outbound traffic" }],
      tags,
    });
    props.clientSecurityGroupIds.forEach((clientGroup, index) => {
      new ec2.CfnSecurityGroupIngress(this, `ClientIngress${index}`, {
        groupId: this.loadBalancerSecurityGroup.attrGroupId,
        ipProtocol: "tcp", fromPort: port, toPort: port,
        sourceSecurityGroupId: clientGroup,
        description: `Model proxy port ${port} from a registered client`,
      });
      // The client's own group must also allow the port out (the worker group allows HTTPS only). A separate rule in
      // this stack rather than an inline one in the client's stack, so the client's stack needs no reference to this one.
      new ec2.CfnSecurityGroupEgress(this, `ClientEgress${index}`, {
        groupId: clientGroup,
        ipProtocol: "tcp", fromPort: port, toPort: port,
        destinationSecurityGroupId: this.loadBalancerSecurityGroup.attrGroupId,
        description: `Model proxy port ${port} on the proxy load balancer`,
      });
    });
    new ec2.CfnSecurityGroupEgress(this, "LoadBalancerToService", {
      groupId: this.loadBalancerSecurityGroup.attrGroupId,
      ipProtocol: "tcp", fromPort: port, toPort: port,
      destinationSecurityGroupId: serviceSecurityGroup.attrGroupId,
      description: `Model proxy port ${port} to the proxy tasks`,
    });
    new ec2.CfnSecurityGroupIngress(this, "ServiceFromLoadBalancer", {
      groupId: serviceSecurityGroup.attrGroupId,
      ipProtocol: "tcp", fromPort: port, toPort: port,
      sourceSecurityGroupId: this.loadBalancerSecurityGroup.attrGroupId,
      description: `Model proxy port ${port} from the load balancer`,
    });
    new ec2.CfnSecurityGroupEgress(this, "ServiceToDatabase", {
      groupId: serviceSecurityGroup.attrGroupId,
      ipProtocol: "tcp", fromPort: 5432, toPort: 5432,
      destinationSecurityGroupId: databaseSecurityGroup.attrGroupId,
      description: "PostgreSQL to the proxy database",
    });
    new ec2.CfnSecurityGroupIngress(this, "DatabaseFromService", {
      groupId: databaseSecurityGroup.attrGroupId,
      ipProtocol: "tcp", fromPort: 5432, toPort: 5432,
      sourceSecurityGroupId: serviceSecurityGroup.attrGroupId,
      description: "PostgreSQL from the proxy tasks",
    });

    // Secrets. Generated, never written in the template: the database URL and the master key are
    // composed from them with dynamic references, which CloudFormation resolves at deploy.
    const databaseSecret = new secretsmanager.Secret(this, "DatabaseSecret", {
      description: "Credentials of the AgentX model proxy database",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: DATABASE_USER }),
        generateStringKey: "password",
        excludePunctuation: true,
        passwordLength: 32,
      },
    });
    const databasePassword = databaseSecret.secretValueFromJson("password");
    const subnetGroup = new rds.CfnDBSubnetGroup(this, "DatabaseSubnetGroup", {
      dbSubnetGroupDescription: "AgentX model proxy database subnets",
      subnetIds: props.subnetIds,
      tags,
    });
    const cluster = new rds.CfnDBCluster(this, "Database", {
      engine: "aurora-postgresql",
      engineVersion: rds.AuroraPostgresEngineVersion.VER_16_13.auroraPostgresFullVersion,
      databaseName: DATABASE_NAME,
      masterUsername: DATABASE_USER,
      masterUserPassword: databasePassword.unsafeUnwrap(),
      dbSubnetGroupName: subnetGroup.ref,
      vpcSecurityGroupIds: [databaseSecurityGroup.attrGroupId],
      storageEncrypted: true,
      backupRetentionPeriod: 7,
      copyTagsToSnapshot: true,
      serverlessV2ScalingConfiguration: { minCapacity: 0.5, maxCapacity: 4 },
      tags,
    });
    cluster.applyRemovalPolicy(RemovalPolicy.SNAPSHOT);
    const databaseInstance = new rds.CfnDBInstance(this, "DatabaseInstance", {
      dbClusterIdentifier: cluster.ref,
      dbInstanceClass: "db.serverless",
      engine: "aurora-postgresql",
      publiclyAccessible: false,
      tags,
    });
    databaseInstance.addResourceDependency(cluster);
    const databaseUrl = new secretsmanager.Secret(this, "DatabaseUrl", {
      description: "DATABASE_URL of the AgentX model proxy",
      secretStringValue: SecretValue.unsafePlainText(
        `postgresql://${DATABASE_USER}:${databasePassword.unsafeUnwrap()}@${cluster.attrEndpointAddress}:5432/${DATABASE_NAME}`),
    });
    // LiteLLM refuses a master key that does not start with sk-, which a generated value cannot promise.
    const masterKeySeed = new secretsmanager.Secret(this, "GeneratedMasterKey", {
      description: "Random part of the AgentX model proxy master key",
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
    });
    this.masterKeySecret = new secretsmanager.Secret(this, "MasterKey", {
      description: "LITELLM_MASTER_KEY of the AgentX model proxy; the broker mints member keys with it",
      secretStringValue: SecretValue.unsafePlainText(`sk-${masterKeySeed.secretValue.unsafeUnwrap()}`),
    });

    // The key LiteLLM encrypts stored credentials with (company AI keys, written through its credentials API). Generated here, read only
    // by the proxy's execution role (ECS injects it), and kept when the stack goes: without it the stored keys cannot be read.
    // ROTATION: do not rotate or replace this value in place. LiteLLM encrypts each stored credential with it and has no re-encrypt step,
    // so a new value leaves every stored company key unreadable (calls through those sources fail until each key is sent again).
    // Likewise RETAIN keeps the secret when the stack is deleted; a re-created stack generates a new one that cannot decrypt a retained
    // database, so reuse the retained secret (import it) or clear the stored credentials. To rotate on purpose: (1) put the new value
    // in the secret, (2) redeploy so every proxy task restarts with it, (3) have each org's admin re-enter every source key (the broker's
    // upsertSource with an apiKey PATCHes the credential, now encrypted under the new salt), (4) check each source. Never run two salt
    // values at once: replicas must share one. The master key and the other secrets are unaffected.
    const saltKey = new secretsmanager.Secret(this, "SaltKey", {
      description: "LITELLM_SALT_KEY of the AgentX model proxy; encrypts the company AI keys stored in its database",
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Roles. The task role is the only principal in the environment that may call Bedrock for members
    // and read provider keys (the provider-key grants are attached to it by the control plane).
    const taskTrust = new iam.ServicePrincipal("ecs-tasks.amazonaws.com", { conditions: { StringEquals: { "aws:SourceAccount": stack.account } } });
    this.taskRole = new iam.Role(this, "TaskRole", {
      // A fixed name in a named environment, so the default boundary's AssumeOrgRoles statement can name this role as one of the three that may be granted a cross-account assume.
      ...(naming.env === undefined ? {} : { roleName: modelProxyTaskRoleName(naming.env) }),
      assumedBy: taskTrust,
      description: "AgentX model proxy: calls Amazon Bedrock and reads its own secrets",
    });
    this.taskRole.addToPolicy(new iam.PolicyStatement({
      sid: "InvokeClaudeOnBedrock",
      actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      resources: [
        `arn:${stack.partition}:bedrock:*::foundation-model/anthropic.*`,
        `arn:${stack.partition}:bedrock:${stack.region}:${stack.account}:inference-profile/*.anthropic.claude-*`,
      ],
    }));
    this.taskRole.addToPolicy(new iam.PolicyStatement({
      sid: "ReadProxySecrets",
      actions: ["secretsmanager:GetSecretValue"],
      resources: [this.masterKeySecret.secretArn, databaseSecret.secretArn],
    }));
    const executionRole = new iam.Role(this, "ExecutionRole", {
      assumedBy: taskTrust,
      description: "Starts the AgentX model proxy tasks, injects their secrets and writes their logs",
    });
    // ECS reads the injected secrets with the execution role, not the task role.
    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: "ReadInjectedSecrets",
      actions: ["secretsmanager:GetSecretValue"],
      resources: [this.masterKeySecret.secretArn, databaseUrl.secretArn, saltKey.secretArn],
    }));
    if (props.bundledImages === true) {
      // The execution role pulls the image: authorization is account-wide, the layers only from the bundle's repositories.
      executionRole.addToPolicy(new iam.PolicyStatement({ sid: "EcrAuthorization", actions: ["ecr:GetAuthorizationToken"], resources: ["*"] }));
      executionRole.addToPolicy(new iam.PolicyStatement({
        sid: "PullBundledImages",
        actions: ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
        resources: BUNDLE_IMAGE_NAMES.map((name) => bundleImageRepositoryArn(naming.env ?? "", name)),
      }));
    }
    // Company Bedrock sources: the task role assumes the customer's role in the customer's own account (never ours), and only with an
    // external id that names a Rovara org. The ModelAccessFunction has the same statement for its trust-policy probe.
    this.taskRole.addToPolicy(assumeOrgBedrockRoles(stack));
    const logGroup = new logs.LogGroup(this, "Logs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY });
    logGroup.grantWrite(executionRole);

    // Service.
    const ecsCluster = new ecs.CfnCluster(this, "Cluster", {
      clusterSettings: [{ name: "containerInsights", value: "disabled" }],
      tags,
    });
    const configYaml = litellmConfig({ region: stack.region, models: props.models });
    const taskDefinition = new ecs.CfnTaskDefinition(this, "TaskDefinition", {
      family: `${naming.taskFamily}-model-proxy`,
      requiresCompatibilities: ["FARGATE"],
      networkMode: "awsvpc",
      cpu: "1024",
      memory: "2048",
      runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" },
      executionRoleArn: executionRole.roleArn,
      taskRoleArn: this.taskRole.roleArn,
      containerDefinitions: [{
        name: "litellm",
        image: props.bundledImages === true ? bundleImageUri(naming.env ?? "", "litellm", imageDigestOf(LITELLM_IMAGE)) : LITELLM_IMAGE,
        essential: true,
        stopTimeout: 120,
        entryPoint: ["sh", "-c"],
        command: [START_COMMAND],
        portMappings: [{ containerPort: port, protocol: "tcp" }],
        environment: [
          { name: "LITELLM_CONFIG_YAML", value: configYaml },
          { name: "AWS_REGION", value: stack.region },
          // Company models are added and removed at run time through the management API, and every replica reads them from the database.
          { name: "STORE_MODEL_IN_DB", value: "True" },
          { name: "REQUEST_TIMEOUT", value: String(MODEL_PROXY_REQUEST_TIMEOUT_SECONDS) },
          { name: "ROVARA_GUARD_PY", value: ROVARA_GUARD_PY },
          // Prices come from the cost map shipped in the pinned image, never fetched at start: a proxy that cannot reach GitHub still starts.
          { name: "LITELLM_LOCAL_MODEL_COST_MAP", value: "True" },
        ],
        secrets: [
          { name: "LITELLM_MASTER_KEY", valueFrom: this.masterKeySecret.secretArn },
          { name: "DATABASE_URL", valueFrom: databaseUrl.secretArn },
          { name: "LITELLM_SALT_KEY", valueFrom: saltKey.secretArn },
        ],
        logConfiguration: {
          logDriver: "awslogs",
          options: { "awslogs-group": logGroup.logGroupName, "awslogs-region": stack.region, "awslogs-stream-prefix": "litellm" },
        },
      }],
      tags,
    });

    const loadBalancer = new elbv2.CfnLoadBalancer(this, "LoadBalancer", {
      scheme: "internal",
      type: "application",
      subnets: props.subnetIds,
      securityGroups: [this.loadBalancerSecurityGroup.attrGroupId],
      loadBalancerAttributes: [
        // Replies stream for as long as the model thinks, so the idle timeout is well above the 60 second default.
        { key: "idle_timeout.timeout_seconds", value: "900" },
        { key: "routing.http.drop_invalid_header_fields.enabled", value: "true" },
      ],
      tags,
    });
    const targetGroup = new elbv2.CfnTargetGroup(this, "TargetGroup", {
      vpcId: props.vpcId,
      protocol: "HTTP",
      port,
      targetType: "ip",
      healthCheckPath: HEALTH_CHECK_PATH,
      healthCheckProtocol: "HTTP",
      healthCheckIntervalSeconds: 30,
      healthCheckTimeoutSeconds: 10,
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
      matcher: { httpCode: "200" },
      targetGroupAttributes: [{ key: "deregistration_delay.timeout_seconds", value: "60" }],
      tags,
    });
    // Ruling R48: the inference listener forwards inference paths only; everything else (LiteLLM's management routes among
    // them, which a task key must never reach) gets a fixed 403 from the load balancer itself.
    const listener = new elbv2.CfnListener(this, "Listener", {
      loadBalancerArn: loadBalancer.ref,
      protocol: "HTTP",
      port,
      defaultActions: [{
        type: "fixed-response",
        fixedResponseConfig: { statusCode: "403", contentType: "application/json", messageBody: JSON.stringify({ error: { message: "this route is not available here", type: "forbidden" } }) },
      }],
    });
    new elbv2.CfnListenerRule(this, "InferenceRoutes", {
      listenerArn: listener.ref,
      priority: 10,
      conditions: [
        { field: "path-pattern", pathPatternConfig: { values: [...INFERENCE_PATH_PATTERNS] } },
        { field: "http-request-method", httpRequestMethodConfig: { values: ["POST"] } },
      ],
      actions: [{ type: "forward", targetGroupArn: targetGroup.ref }],
    });
    // Every path, on a port only the model access function's group may reach.
    const managementListener = new elbv2.CfnListener(this, "ManagementListener", {
      loadBalancerArn: loadBalancer.ref,
      protocol: "HTTP",
      port: MODEL_PROXY_MANAGEMENT_PORT,
      defaultActions: [{ type: "forward", targetGroupArn: targetGroup.ref }],
    });
    const service = new ecs.CfnService(this, "Service", {
      cluster: ecsCluster.ref,
      taskDefinition: taskDefinition.ref,
      launchType: "FARGATE",
      desiredCount: 2,
      enableExecuteCommand: false,
      // LiteLLM runs its database migrations before it listens.
      healthCheckGracePeriodSeconds: Duration.minutes(5).toSeconds(),
      deploymentConfiguration: {
        minimumHealthyPercent: 100,
        maximumPercent: 200,
        deploymentCircuitBreaker: { enable: true, rollback: true },
      },
      loadBalancers: [{ containerName: "litellm", containerPort: port, targetGroupArn: targetGroup.ref }],
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: props.subnetIds,
          securityGroups: [serviceSecurityGroup.attrGroupId],
          assignPublicIp: "DISABLED",
        },
      },
      tags,
    });
    service.addResourceDependency(listener);
    service.addResourceDependency(managementListener);
    service.addResourceDependency(databaseInstance);

    this.loadBalancerName = Fn.select(0, Fn.split(".", loadBalancer.attrDnsName));
    this.url = `http://${loadBalancer.attrDnsName}:${port}`;
    this.managementUrl = `http://${loadBalancer.attrDnsName}:${MODEL_PROXY_MANAGEMENT_PORT}`;
    new ssm.StringParameter(this, "UrlParameter", {
      parameterName: `${naming.ec2.workerSettingsPrefix}${MODEL_PROXY_URL_PARAMETER}`,
      description: "Internal URL of the AgentX model proxy",
      stringValue: this.url,
    });
  }
}
