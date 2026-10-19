import { litellmConfig } from "@agentx/model-proxy";
import {
  Duration,
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
import type { AgentXNaming } from "./naming.js";

/** LiteLLM, pinned by digest (spike: docs/learnings/model-proxy-spike.md). ghcr.io is public; the tasks pull it through the NAT. */
export const LITELLM_IMAGE = "ghcr.io/berriai/litellm-database:v1.105.1@sha256:2bcadb9905b692a5ca4dadd51bccaaa23a95dc8a0f9322d9c9787f0ac2aeb50e";
export const MODEL_PROXY_PORT = 4000;
const DATABASE_NAME = "litellm";
const DATABASE_USER = "litellm";
/** LiteLLM's unauthenticated liveness route. */
const HEALTH_CHECK_PATH = "/health/liveliness";
/** Writes the generated config to a file, then replaces the shell with LiteLLM so it receives the stop signal. */
const START_COMMAND = `printf "%s" "$LITELLM_CONFIG_YAML" > /tmp/litellm.yaml && exec litellm --config /tmp/litellm.yaml --port ${MODEL_PROXY_PORT}`;

export interface ModelProxyProps {
  naming: AgentXNaming;
  vpcId: string;
  /** The foundation's private subnets, which have NAT egress. */
  subnetIds: string[];
  /** Security groups whose members may call the proxy: the worker group today; the Slack orchestrator and broker join in task 14. */
  clientSecurityGroupIds: string[];
  /** Bedrock model ids as Pi's catalog names them; the proxy serves exactly these (ruling R21). */
  models: ReadonlyArray<{ id: string }>;
}

/**
 * The LiteLLM model proxy: the only holder of provider keys and Bedrock access (spec: model proxy).
 * Two Fargate tasks behind an internal load balancer, keyed and budgeted in an Aurora Serverless v2
 * PostgreSQL database. Follows the L1 ECS pattern of slack-orchestrator.ts.
 */
export class ModelProxy extends Construct {
  readonly taskRole: iam.Role;
  readonly url: string;
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
      groupDescription: `AgentX model proxy load balancer: port ${port} from registered clients only`,
      vpcId: props.vpcId,
      tags,
    });
    const serviceSecurityGroup = new ec2.CfnSecurityGroup(this, "ServiceSecurityGroup", {
      groupDescription: `AgentX model proxy tasks: port ${port} from the load balancer only`,
      vpcId: props.vpcId,
      securityGroupEgress: [{
        ipProtocol: "tcp", fromPort: 443, toPort: 443, cidrIp: "0.0.0.0/0",
        description: "HTTPS to Amazon Bedrock, Secrets Manager, CloudWatch Logs and the LiteLLM image registry",
      }],
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

    // Roles. The task role is the only principal in the environment that may call Bedrock for members
    // and read provider keys (the provider-key grants are attached to it by the control plane).
    const taskTrust = new iam.ServicePrincipal("ecs-tasks.amazonaws.com", { conditions: { StringEquals: { "aws:SourceAccount": stack.account } } });
    this.taskRole = new iam.Role(this, "TaskRole", {
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
      resources: [this.masterKeySecret.secretArn, databaseUrl.secretArn],
    }));
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
        image: LITELLM_IMAGE,
        essential: true,
        stopTimeout: 120,
        entryPoint: ["sh", "-c"],
        command: [START_COMMAND],
        portMappings: [{ containerPort: port, protocol: "tcp" }],
        environment: [
          { name: "LITELLM_CONFIG_YAML", value: configYaml },
          { name: "AWS_REGION", value: stack.region },
          { name: "STORE_MODEL_IN_DB", value: "False" },
        ],
        secrets: [
          { name: "LITELLM_MASTER_KEY", valueFrom: this.masterKeySecret.secretArn },
          { name: "DATABASE_URL", valueFrom: databaseUrl.secretArn },
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
    const listener = new elbv2.CfnListener(this, "Listener", {
      loadBalancerArn: loadBalancer.ref,
      protocol: "HTTP",
      port,
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
    service.addResourceDependency(databaseInstance);

    this.url = `http://${loadBalancer.attrDnsName}:${port}`;
    new ssm.StringParameter(this, "UrlParameter", {
      parameterName: `${naming.ec2.workerSettingsPrefix}model-proxy-url`,
      description: "Internal URL of the AgentX model proxy",
      stringValue: this.url,
    });
  }
}
