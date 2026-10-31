import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_logs as logs,
  aws_route53 as route53,
  aws_secretsmanager as secretsmanager,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { enterpriseHttpsEgress } from "./vpc-endpoints.js";

/** NOT FOR PRODUCTION until the host is redesigned (lane E follow-up: stdio host redesign); not instantiated by the install yet. */
/** The port the service listens on, behind the load balancer. */
export const MCP_HOST_PORT = 8080;

export interface McpHostProps {
  vpcId: string;
  availabilityZones: string[];
  /** The foundation's private subnets. */
  subnetIds: string[];
  /** The image that holds the broker build (`node packages/broker/dist/mcp-host/main.js`); the release pipeline builds it. */
  image: ecs.ContainerImage;
  /** Security groups whose members may call the host (the broker's). */
  clientSecurityGroupIds: string[];
  /** The install's table; the host's role may read only the MCP server registry in it. */
  stateTableArn: string;
  stateTableName: string;
  /** The one org of an Enterprise install. */
  orgId: string;
  /** The ranges the host may reach over HTTPS: the VPC's endpoints, the customer's package registry. Never the whole internet. */
  privateEgressCidrs: readonly string[];
  /**
   * An ACM certificate for the load balancer's HTTPS listener. Required (review I6): the broker's bearer token never crosses the network in the clear, and the broker refuses
   * an http:// address for the host. The hop from the load balancer to the task stays inside the two security groups; mTLS between broker and host is the target and is listed
   * as deferred. Rotating the token: replace the secret's value and restart the task; the broker reads it afresh on its next cold start.
   */
  certificateArn: string;
  /**
   * The DNS name the certificate is for (review m4). The broker reaches the host by this name, so its TLS check passes: no certificate can name the load balancer's own
   * `*.elb.amazonaws.com` name, and nobody should have to turn the check off. An alias record for it is made in `hostedZoneId`.
   */
  hostName: string;
  hostedZoneId: string;
  /** The registry the host installs approved packages from (an internal mirror, in an install with no internet). */
  npmRegistry?: string;
}

/**
 * The MCP host (lane E, task E6): a small Fargate service in the customer's VPC that runs the stdio MCP servers an admin approved, and shows each to the broker as
 * Streamable HTTP on a private listener. It holds no secret but its own bearer token, reads only the MCP server registry, and has no route from the internet. Nothing
 * is deployed by this file: it is instantiated when an Enterprise install turns the host on.
 */
export class McpHost extends Construct {
  readonly url: string;
  readonly tokenSecret: secretsmanager.Secret;
  readonly taskRole: iam.Role;
  readonly loadBalancerSecurityGroup: ec2.SecurityGroup;
  readonly serviceSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: McpHostProps) {
    super(scope, id);
    if (props.certificateArn === undefined || props.certificateArn === "") throw new Error("the MCP host needs a certificate for its HTTPS listener: there is no plain-HTTP mode");
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/u.test(props.hostName ?? "") || /(?:^|\.)(?:amazonaws\.com|elb\.amazonaws\.com)$/u.test(props.hostName)) {
      throw new Error("the MCP host needs a DNS name of its own that the certificate is for (not the load balancer's amazonaws.com name)");
    }
    const stack = Stack.of(this);
    const vpc = ec2.Vpc.fromVpcAttributes(this, "Vpc", { vpcId: props.vpcId, availabilityZones: props.availabilityZones, privateSubnetIds: props.subnetIds });
    const subnets = { subnets: props.subnetIds.map((subnetId, index) => ec2.Subnet.fromSubnetId(this, `Subnet${index}`, subnetId)) };

    // Clients -> load balancer -> service. Nothing else reaches either.
    this.loadBalancerSecurityGroup = new ec2.SecurityGroup(this, "LoadBalancerSecurityGroup", { vpc, description: "MCP host load balancer: the broker only", allowAllOutbound: false });
    this.serviceSecurityGroup = new ec2.SecurityGroup(this, "ServiceSecurityGroup", { vpc, description: "MCP host tasks: the load balancer only", allowAllOutbound: false });
    const listenerPort = 443;
    props.clientSecurityGroupIds.forEach((clientGroup, index) => {
      this.loadBalancerSecurityGroup.addIngressRule(ec2.Peer.securityGroupId(clientGroup), ec2.Port.tcp(listenerPort), `MCP host from registered client ${index}`);
      // The client's own group must allow the port out; a separate rule here so the client's stack needs no reference to this one.
      new ec2.CfnSecurityGroupEgress(this, `ClientEgress${index}`, { groupId: clientGroup, ipProtocol: "tcp", fromPort: listenerPort, toPort: listenerPort, destinationSecurityGroupId: this.loadBalancerSecurityGroup.securityGroupId, description: "MCP host" });
    });
    this.loadBalancerSecurityGroup.addEgressRule(this.serviceSecurityGroup, ec2.Port.tcp(MCP_HOST_PORT), "MCP host tasks");
    this.serviceSecurityGroup.addIngressRule(this.loadBalancerSecurityGroup, ec2.Port.tcp(MCP_HOST_PORT), "MCP host from the load balancer");
    for (const rule of enterpriseHttpsEgress(props.privateEgressCidrs, "HTTPS to the package registry and the VPC endpoints")) {
      this.serviceSecurityGroup.addEgressRule(ec2.Peer.ipv4(rule.cidrIp!), ec2.Port.tcp(443), rule.description);
    }

    // The host's only secret: the token the broker presents. Generated here and read by the task (ECS injects it) and by the broker's role (the install grants that).
    this.tokenSecret = new secretsmanager.Secret(this, "Token", {
      description: "Bearer token of the Rovara MCP host; the broker presents it",
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
    });

    this.taskRole = new iam.Role(this, "TaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com", { conditions: { StringEquals: { "aws:SourceAccount": stack.account } } }),
      description: "Rovara MCP host: reads the registry of approved MCP servers",
    });
    // Read-only, and only the rows of the MCP server registry of this org (the partition key starts `ORG#<org>#MCPSRV`).
    this.taskRole.addToPolicy(new iam.PolicyStatement({
      sid: "ReadMcpServerRegistry",
      actions: ["dynamodb:GetItem", "dynamodb:Query"],
      resources: [props.stateTableArn],
      conditions: { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [`ORG#${props.orgId}#MCPSRV`] } },
    }));

    const logGroup = new logs.LogGroup(this, "Logs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.RETAIN });
    // The L2 types disagree with exactOptionalPropertyTypes about optional members; the objects are the ones CDK made.
    const cluster = new ecs.Cluster(this, "Cluster", { vpc }) as unknown as ecs.ICluster;
    const task = new ecs.FargateTaskDefinition(this, "Task", { cpu: 512, memoryLimitMiB: 1024, taskRole: this.taskRole, runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX } });
    // A read-only root file system; hosted servers get a scratch folder at /tmp (their private homes are made inside it).
    task.addVolume({ name: "scratch" });
    const hardened = new ecs.LinuxParameters(this, "Hardened", { initProcessEnabled: true });
    hardened.dropCapabilities(ecs.Capability.NET_RAW, ecs.Capability.MKNOD, ecs.Capability.AUDIT_WRITE, ecs.Capability.SETFCAP, ecs.Capability.SETPCAP, ecs.Capability.FSETID, ecs.Capability.SYS_CHROOT, ecs.Capability.DAC_OVERRIDE, ecs.Capability.FOWNER, ecs.Capability.NET_BIND_SERVICE);
    const container = task.addContainer("McpHost", {
      image: props.image,
      command: ["node", "packages/broker/dist/mcp-host/main.js"],
      readonlyRootFilesystem: true,
      // Root, so that the host can start each hosted server under its own uid (review I4); with the capabilities it does not need taken away. It listens on a high port and
      // runs no shell for people. Fargate allows dropping capabilities (it allows adding only SYS_PTRACE), so CHOWN, SETUID, SETGID and KILL are kept and the rest of the defaults go.
      user: "0",
      linuxParameters: hardened,
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "mcp-host" }),
      environment: { ROVARA_ORG_ID: props.orgId, STATE_TABLE_NAME: props.stateTableName, PORT: String(MCP_HOST_PORT), ...(props.npmRegistry === undefined ? {} : { npm_config_registry: props.npmRegistry }) },
      secrets: { MCP_HOST_TOKEN: ecs.Secret.fromSecretsManager(this.tokenSecret as unknown as secretsmanager.ISecret) },
      portMappings: [{ containerPort: MCP_HOST_PORT }],
      healthCheck: { command: ["CMD-SHELL", `node -e "fetch('http://127.0.0.1:${MCP_HOST_PORT}/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"`], interval: Duration.seconds(30), timeout: Duration.seconds(5), retries: 3 },
    });
    container.addMountPoints({ containerPath: "/tmp", sourceVolume: "scratch", readOnly: false });

    const service = new ecs.FargateService(this, "Service", {
      cluster, taskDefinition: task, desiredCount: 1, assignPublicIp: false, vpcSubnets: subnets, securityGroups: [this.serviceSecurityGroup],
      minHealthyPercent: 100, circuitBreaker: { rollback: true },
    });
    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, "LoadBalancer", { vpc, internetFacing: false, vpcSubnets: subnets, securityGroup: this.loadBalancerSecurityGroup, idleTimeout: Duration.seconds(120) });
    const listener = loadBalancer.addListener("Listener", { port: 443, protocol: elbv2.ApplicationProtocol.HTTPS, certificates: [elbv2.ListenerCertificate.fromArn(props.certificateArn)], open: false });
    listener.addTargets("Target", { port: MCP_HOST_PORT, protocol: elbv2.ApplicationProtocol.HTTP, targets: [service], healthCheck: { path: "/healthz", healthyHttpCodes: "200" }, deregistrationDelay: Duration.seconds(30) });

    new route53.CfnRecordSet(this, "HostName", {
      hostedZoneId: props.hostedZoneId, name: props.hostName, type: "A",
      aliasTarget: { dnsName: loadBalancer.loadBalancerDnsName, hostedZoneId: loadBalancer.loadBalancerCanonicalHostedZoneId, evaluateTargetHealth: true },
    });
    this.url = `https://${props.hostName}`;
    new CfnOutput(this, "McpHostUrl", { value: this.url, description: "The MCP host's private URL: the broker's MCP_HOST_URL" });
  }
}
