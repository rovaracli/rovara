// Stdio MCP host redesign (T8), design sections 2, 3, 6, 7, 8 and 16. The infrastructure of the MCP CONTROLLER and of the runner tasks it starts. Nothing is deployed by this file and
// nothing instantiates it yet: package-run servers are off (register ME-14) until the turn-on checklist is done.
//
//   - the CONTROLLER: one Fargate service, uid 10001, every capability dropped, read-only root, behind an internal HTTPS load balancer for the broker, and reached DIRECTLY by the
//     runner tasks on a TLS port (Cloud Map name, no load balancer: the bootstrap checks the task's own address);
//   - the RUNNER NETWORK: dedicated private subnets with their own route table. The table holds no route at all but the VPC's own and the S3 gateway endpoint: no NAT, no internet
//     gateway, no IPv6. The security groups of the individual servers are made by the controller at approval (infra holds only the install task's);
//   - the INSTALL task definition `rovara-mcp-install` (static, no task role); serve and probe definitions are registered by the controller from `buildRunnerTaskDefinition`;
//   - two roles of consequence: the runner EXECUTION role (image pull, logs, and the `mcp*` secrets of this org only) and the controller's TASK role (ECS limited to `rovara-mcp-*`
//     families and the cluster, PassRole of that one execution role, security groups by tag, the bundle bucket, and three partitions of the state table);
//   - the BUNDLE bucket: its own KMS key, TLS only, no public access, versioned.
// No rule here is 0.0.0.0/0 and no task has a task role.
import {
  Aws, CfnOutput, Duration, RemovalPolicy, Stack, aws_ec2 as ec2, aws_ecs as ecs, aws_elasticloadbalancingv2 as elbv2, aws_iam as iam, aws_kms as kms, aws_logs as logs,
  aws_route53 as route53, aws_s3 as s3, aws_secretsmanager as secretsmanager, aws_servicediscovery as servicediscovery, custom_resources as cr,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { endpointPolicyDocument, enterpriseHttpsEgress } from "./vpc-endpoints.js";

/** The port the broker's listener has, behind the load balancer (the hop stays inside two security groups). */
export const MCP_HOST_PORT = 8080;
/** The port the runner tasks reach the controller on (TLS, direct). */
export const MCP_RUNNER_PORT = 8443;
/** The static install task family. The controller runs it by this name; serve and probe families are `rovara-mcp-serve-<id>` and `rovara-mcp-probe-<id>`. */
export const MCP_INSTALL_FAMILY = "rovara-mcp-install";
export const MCP_FAMILY_PREFIX = "rovara-mcp-";
/** The tag the controller puts on everything it makes; the controller's security group permissions are scoped by it. */
export const MCP_MANAGED_TAG = { key: "rovara:managed", value: "rovara-mcp" } as const;
export const MCP_CONTROLLER_UID = "10001";
const NODE = "/usr/local/bin/node";

export interface McpHostProps {
  vpcId: string;
  /** The VPC's own range. Runner subnets must lie inside it. */
  vpcCidr: string;
  availabilityZones: string[];
  /** The foundation's private subnets: where the controller runs. */
  subnetIds: string[];
  /** One range per runner subnet (one per availability zone, in the order of `availabilityZones`), for example 10.42.160.0/22. Size them for 16 serve tasks plus probes (one address each). */
  runnerSubnetCidrs: string[];
  region: string;
  /** The image that holds the broker build (`node packages/broker/dist/mcp-host/main.js`), run as uid 10001 with a `VOLUME ["/tmp"]` owned by that uid. */
  image: ecs.ContainerImage;
  /** The runner image: in this account's ECR, pinned by digest (the release pipeline builds it from environments/mcp-runner). */
  runnerImage: string;
  /** Security groups whose members may call the host (the broker's). */
  clientSecurityGroupIds: string[];
  /** The security group of the VPC interface endpoints (EnterpriseVpcEndpoints): runner subnets are allowed to reach it, and so is the controller. */
  endpointSecurityGroupId: string;
  /** The install's table; the controller's role reaches only the three MCP partitions in it. */
  stateTableArn: string;
  stateTableName: string;
  /** The one org of an Enterprise install, and the install's environment name (its secrets are `agentx/<env>/org-connectors/<org>/mcp*`). */
  orgId: string;
  agentxEnv: string;
  /** The ranges the INSTALL task may reach over HTTPS besides the endpoints: the customer's package registry. Never the whole internet. */
  registryEgressCidrs: readonly string[];
  /** The registry the install task uses (https). Required: package-run servers need the customer's mirror (public npm only when it is named here). */
  npmRegistry: string;
  /** The install's private MCP ranges and Rovara's own network, as the broker gets them (`ROVARA_PRIVATE_MCP_CIDRS`, `ROVARA_VPC_CIDRS`). */
  privateMcpCidrs: readonly string[];
  vpcCidrs: readonly string[];
  /** An ACM certificate for the load balancer's HTTPS listener (the broker's bearer token never crosses the network in the clear), the name it is for, and the zone for the alias record. */
  certificateArn: string;
  hostName: string;
  hostedZoneId: string;
  /** A Secrets Manager secret holding `{"cert": "<PEM>", "key": "<PEM>"}` for the controller's runner listener, issued for `controller.<controllerDnsNamespace>`. */
  controllerTlsSecretArn: string;
  /** The private DNS namespace the controller registers in, for example `mcp.rovara.internal`. */
  controllerDnsNamespace: string;
  /** The CA certificate (PEM, public) of the controller's certificate when it is a private authority. The tasks trust it for the controller and for nothing else. */
  controllerCaPem?: string;
}

const ACM_ARN = /^arn:aws(?:-[a-z]+)*:acm:[a-z]{2}(?:-[a-z]+)+-\d:\d{12}:certificate\/[0-9A-Za-z-]+$/u;
const SECRET_ARN = /^arn:aws(?:-[a-z]+)*:secretsmanager:[a-z]{2}(?:-[a-z]+)+-\d:\d{12}:secret:[A-Za-z0-9/_+=.@-]{1,512}$/u;
const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/u;
const ECR_IMAGE_BY_DIGEST = /^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\/([a-z0-9][a-z0-9._/-]{0,255})@sha256:[0-9a-f]{64}$/u;
const ENV_NAME = /^[a-z][a-z0-9-]{0,30}$/u;
const ORG_ID = /^org_[A-Za-z0-9]{20}$/u;
const IPV4_CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/u;

function parseCidr(cidr: string): { first: number; last: number } | undefined {
  const match = IPV4_CIDR.exec(cidr);
  if (match === null) return undefined;
  const octets = [match[1]!, match[2]!, match[3]!, match[4]!].map(Number);
  const prefix = Number(match[5]);
  if (octets.some((octet) => octet > 255) || prefix > 32) return undefined;
  const address = (((octets[0]! << 24) >>> 0) + (octets[1]! << 16) + (octets[2]! << 8) + octets[3]!) >>> 0;
  const size = 2 ** (32 - prefix);
  const first = Math.floor(address / size) * size;
  return { first, last: first + size - 1 };
}

/** The names the install's DNS firewall must let through for the controller and the install task (add them to `agentxEgressAllowDomains`). */
export function mcpHostAllowDomains(input: { controllerDnsNamespace: string; npmRegistry: string; region: string }): string[] {
  return [`controller.${input.controllerDnsNamespace}`, new URL(input.npmRegistry).hostname, `ecs.${input.region}.amazonaws.com`].sort();
}

/** The id of an AWS-managed prefix list (for example the S3 or DynamoDB gateway endpoint's), looked up when the stack deploys. */
function managedPrefixListId(scope: Construct, id: string, service: "s3" | "dynamodb", region: string): string {
  const lookup = new cr.AwsCustomResource(scope, id, {
    onUpdate: {
      service: "EC2", action: "describePrefixLists",
      parameters: { Filters: [{ Name: "prefix-list-name", Values: [`com.amazonaws.${region}.${service}`] }] },
      physicalResourceId: cr.PhysicalResourceId.of(`prefix-list-${service}`),
    },
    policy: cr.AwsCustomResourcePolicy.fromStatements([new iam.PolicyStatement({ actions: ["ec2:DescribePrefixLists"], resources: ["*"] })]),
    // No internet at deploy time in an Enterprise install: the SDK the function ships with is the one used.
    installLatestAwsSdk: false,
  });
  return lookup.getResponseField("PrefixLists.0.PrefixListId");
}

export class McpHost extends Construct {
  readonly url: string;
  readonly controllerUrl: string;
  readonly tokenSecret: secretsmanager.Secret;
  readonly controllerTaskRole: iam.Role;
  readonly runnerExecutionRole: iam.Role;
  readonly loadBalancerSecurityGroup: ec2.SecurityGroup;
  readonly controllerSecurityGroup: ec2.SecurityGroup;
  readonly installSecurityGroup: ec2.SecurityGroup;
  readonly bundleBucket: s3.Bucket;
  readonly bundleKey: kms.Key;
  readonly runnerSubnets: readonly ec2.CfnSubnet[];
  readonly runnerRouteTable: ec2.CfnRouteTable;
  readonly installTaskDefinition: ecs.CfnTaskDefinition;

  constructor(scope: Construct, id: string, props: McpHostProps) {
    super(scope, id);
    // ---- what the install must give, checked before anything is made ---------------------------------------------------------------------------------------------------------
    if (props.certificateArn === undefined || props.certificateArn === "") throw new Error("the MCP host needs a certificate for its HTTPS listener: there is no plain-HTTP mode");
    if (!ACM_ARN.test(props.certificateArn)) throw new Error("the MCP host's certificate must be an ACM certificate ARN (rovaraMcpHostCertificateArn)");
    if (!DNS_NAME.test(props.hostName ?? "") || /(?:^|\.)(?:amazonaws\.com|elb\.amazonaws\.com)$/u.test(props.hostName)) {
      throw new Error("the MCP host needs a DNS name of its own that the certificate is for (not the load balancer's amazonaws.com name)");
    }
    const imageParts = ECR_IMAGE_BY_DIGEST.exec(props.runnerImage ?? "");
    if (imageParts === null) throw new Error("the runner image must be in this account's ECR and pinned by digest (<account>.dkr.ecr.<region>.amazonaws.com/<repository>@sha256:<digest>)");
    if (imageParts[2] !== props.region) throw new Error("the runner image must be in the install's own region");
    if (!ENV_NAME.test(props.agentxEnv ?? "")) throw new Error("the install's environment name is not valid");
    if (!ORG_ID.test(props.orgId ?? "")) throw new Error("the org id is not valid");
    let registry: URL;
    try { registry = new URL(props.npmRegistry); } catch { throw new Error("the package registry (rovaraMcpNpmRegistry) must be an https address"); }
    if (registry.protocol !== "https:" || registry.username !== "" || registry.password !== "" || registry.search !== "" || registry.hash !== "") throw new Error("the package registry (rovaraMcpNpmRegistry) must be an https address without credentials");
    if (!SECRET_ARN.test(props.controllerTlsSecretArn ?? "")) throw new Error("the controller's certificate must come from a Secrets Manager secret (rovaraMcpControllerTlsSecretArn)");
    if (!DNS_NAME.test(props.controllerDnsNamespace ?? "")) throw new Error("the controller's DNS namespace is not a valid name");
    if (props.controllerCaPem !== undefined && (!props.controllerCaPem.startsWith("-----BEGIN CERTIFICATE-----") || Buffer.byteLength(props.controllerCaPem) > 7_000)) throw new Error("the controller's CA must be one PEM certificate chain of at most 7000 bytes");
    const vpcRange = parseCidr(props.vpcCidr);
    if (vpcRange === undefined) throw new Error("the VPC range is not an IPv4 range");
    if (props.runnerSubnetCidrs.length < 1 || props.runnerSubnetCidrs.length > props.availabilityZones.length) throw new Error("the runner network needs one subnet range per availability zone it uses");
    props.runnerSubnetCidrs.forEach((cidr, index) => {
      const range = parseCidr(cidr);
      const prefix = Number(cidr.split("/")[1]);
      if (range === undefined || prefix < 16 || prefix > 26) throw new Error(`runner subnet range ${JSON.stringify(cidr)} is not an IPv4 range between /16 and /26`);
      if (range.first < vpcRange.first || range.last > vpcRange.last) throw new Error(`runner subnet range ${JSON.stringify(cidr)} is not inside the VPC's range`);
      props.runnerSubnetCidrs.slice(0, index).forEach((other) => {
        const o = parseCidr(other)!;
        if (range.first <= o.last && o.first <= range.last) throw new Error(`runner subnet ranges ${JSON.stringify(other)} and ${JSON.stringify(cidr)} overlap`);
      });
    });
    // The install task's registry egress; refuses the whole internet by name.
    const registryRules = enterpriseHttpsEgress(props.registryEgressCidrs, "HTTPS to the package registry");
    if (props.privateMcpCidrs.some((cidr) => cidr.endsWith("/0")) || props.vpcCidrs.some((cidr) => cidr.endsWith("/0"))) throw new Error("the private MCP ranges never include the whole internet");

    const stack = Stack.of(this);
    const region = props.region;
    const vpc = ec2.Vpc.fromVpcAttributes(this, "Vpc", { vpcId: props.vpcId, availabilityZones: props.availabilityZones, privateSubnetIds: props.subnetIds });
    const controllerSubnets = { subnets: props.subnetIds.map((subnetId, index) => ec2.Subnet.fromSubnetId(this, `Subnet${index}`, subnetId)) };
    const nameTag = (name: string) => [{ key: "Name", value: name }, { key: MCP_MANAGED_TAG.key, value: MCP_MANAGED_TAG.value }];

    // ---- the runner network: own subnets, own route table, no way out -------------------------------------------------------------------------------------------------------
    this.runnerSubnets = props.runnerSubnetCidrs.map((cidrBlock, index) => new ec2.CfnSubnet(this, `RunnerSubnet${index}`, {
      vpcId: props.vpcId, cidrBlock, availabilityZone: props.availabilityZones[index]!, mapPublicIpOnLaunch: false, tags: nameTag(`rovara-mcp-runner-${index + 1}`),
    }));
    // A route table with NO routes of its own: the VPC's local route is implicit, and the S3 gateway endpoint below adds the S3 prefix list. No NAT, no internet gateway, no IPv6.
    this.runnerRouteTable = new ec2.CfnRouteTable(this, "RunnerRouteTable", { vpcId: props.vpcId, tags: nameTag("rovara-mcp-runner") });
    this.runnerSubnets.forEach((subnet, index) => new ec2.CfnSubnetRouteTableAssociation(this, `RunnerAssociation${index}`, { routeTableId: this.runnerRouteTable.ref, subnetId: subnet.ref }));
    // Image layers come from S3 (ECR keeps them there), so Fargate in these subnets needs the S3 gateway endpoint (AWS docs: Amazon ECR interface VPC endpoints). The policy is the install's own.
    new ec2.CfnVPCEndpoint(this, "RunnerS3Endpoint", {
      serviceName: `com.amazonaws.${region}.s3`, vpcEndpointType: "Gateway", vpcId: props.vpcId, routeTableIds: [this.runnerRouteTable.ref], policyDocument: endpointPolicyDocument("s3", region),
    });
    // The controller calls the ECS API (RunTask, StopTask, ...) from private subnets with no internet route, so it needs the ECS interface endpoint. Tasks themselves do not (AWS docs).
    new ec2.CfnVPCEndpoint(this, "EcsEndpoint", {
      serviceName: `com.amazonaws.${region}.ecs`, vpcEndpointType: "Interface", vpcId: props.vpcId, subnetIds: props.subnetIds, securityGroupIds: [props.endpointSecurityGroupId],
      privateDnsEnabled: true, policyDocument: endpointPolicyDocument("ecs", region),
    });
    // The endpoints accept HTTPS from the private subnets; the runner subnets are added, one rule each (the endpoints' own group is the foundation's).
    props.runnerSubnetCidrs.forEach((cidr, index) => new ec2.CfnSecurityGroupIngress(this, `EndpointsFromRunner${index}`, {
      groupId: props.endpointSecurityGroupId, ipProtocol: "tcp", fromPort: 443, toPort: 443, cidrIp: cidr, description: "HTTPS from the MCP runner subnets",
    }));
    const s3PrefixList = managedPrefixListId(this, "S3PrefixList", "s3", region);
    const dynamoPrefixList = managedPrefixListId(this, "DynamoDbPrefixList", "dynamodb", region);

    // ---- security groups ---------------------------------------------------------------------------------------------------------------------------------------------------
    const endpointGroup = ec2.SecurityGroup.fromSecurityGroupId(this, "EndpointGroup", props.endpointSecurityGroupId);
    this.loadBalancerSecurityGroup = new ec2.SecurityGroup(this, "LoadBalancerSecurityGroup", { vpc, description: "MCP host load balancer: the broker only", allowAllOutbound: false });
    this.controllerSecurityGroup = new ec2.SecurityGroup(this, "ControllerSecurityGroup", { vpc, description: "MCP controller tasks: the load balancer and the runner subnets only", allowAllOutbound: false });
    this.installSecurityGroup = new ec2.SecurityGroup(this, "InstallSecurityGroup", { vpc, description: "MCP install task: the endpoints, the package registry and the controller only", allowAllOutbound: false });
    props.clientSecurityGroupIds.forEach((clientGroup, index) => {
      this.loadBalancerSecurityGroup.addIngressRule(ec2.Peer.securityGroupId(clientGroup), ec2.Port.tcp(443), `MCP host from registered client ${index}`);
      new ec2.CfnSecurityGroupEgress(this, `ClientEgress${index}`, { groupId: clientGroup, ipProtocol: "tcp", fromPort: 443, toPort: 443, destinationSecurityGroupId: this.loadBalancerSecurityGroup.securityGroupId, description: "MCP host" });
    });
    this.loadBalancerSecurityGroup.addEgressRule(this.controllerSecurityGroup, ec2.Port.tcp(MCP_HOST_PORT), "MCP controller tasks");
    this.controllerSecurityGroup.addIngressRule(this.loadBalancerSecurityGroup, ec2.Port.tcp(MCP_HOST_PORT), "MCP controller from the load balancer");
    for (const cidr of props.runnerSubnetCidrs) {
      // Both ends are narrowed: this rule names the runner subnets, and each server's own group (made by the controller) allows only the controller on these ports.
      this.controllerSecurityGroup.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(MCP_RUNNER_PORT), "bundles, results and bootstrap from the runner subnets");
      this.controllerSecurityGroup.addEgressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(MCP_HOST_PORT), "MCP calls to the runner tasks");
    }
    this.controllerSecurityGroup.addEgressRule(endpointGroup, ec2.Port.tcp(443), "the VPC interface endpoints (ECS, EC2, Secrets Manager, KMS, logs, ECR)");
    this.controllerSecurityGroup.addEgressRule(ec2.Peer.prefixList(s3PrefixList), ec2.Port.tcp(443), "the S3 gateway endpoint (bundles)");
    this.controllerSecurityGroup.addEgressRule(ec2.Peer.prefixList(dynamoPrefixList), ec2.Port.tcp(443), "the DynamoDB gateway endpoint (the state table)");
    this.installSecurityGroup.addEgressRule(endpointGroup, ec2.Port.tcp(443), "the VPC interface endpoints (ECR, logs)");
    this.installSecurityGroup.addEgressRule(ec2.Peer.prefixList(s3PrefixList), ec2.Port.tcp(443), "the S3 gateway endpoint (image layers)");
    this.installSecurityGroup.addEgressRule(this.controllerSecurityGroup, ec2.Port.tcp(MCP_RUNNER_PORT), "the controller: bundle, result, bootstrap");
    for (const rule of registryRules) this.installSecurityGroup.addEgressRule(ec2.Peer.ipv4(rule.cidrIp!), ec2.Port.tcp(443), rule.description);

    // ---- bundles -------------------------------------------------------------------------------------------------------------------------------------------------------------
    this.bundleKey = new kms.Key(this, "BundleKey", { description: "Encrypts the approved MCP server bundles", enableKeyRotation: true, removalPolicy: RemovalPolicy.RETAIN });
    this.bundleBucket = new s3.Bucket(this, "Bundles", {
      encryption: s3.BucketEncryption.KMS, encryptionKey: this.bundleKey, bucketKeyEnabled: true, blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, enforceSSL: true, versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED, removalPolicy: RemovalPolicy.RETAIN,
      // A bundle is an approved artefact and stays as long as its entry does. Replaced versions go after 30 days, and a failed upload leaves nothing behind.
      lifecycleRules: [{ id: "abort-incomplete-uploads", abortIncompleteMultipartUploadAfter: Duration.days(1) }, { id: "expire-replaced-versions", noncurrentVersionExpiration: Duration.days(30) }],
    });

    // ---- logs and the load-balancer token -------------------------------------------------------------------------------------------------------------------------------
    const controllerLogs = new logs.LogGroup(this, "ControllerLogs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.RETAIN });
    const runnerLogs = new logs.LogGroup(this, "RunnerLogs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.RETAIN });
    this.tokenSecret = new secretsmanager.Secret(this, "Token", {
      description: "Bearer token of the Rovara MCP controller; the broker presents it",
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
    });

    // ---- the runner execution role: image pull, logs, this org's `mcp*` secrets, nothing else ---------------------------------------------------------------------------
    this.runnerExecutionRole = new iam.Role(this, "RunnerExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com", { conditions: { StringEquals: { "aws:SourceAccount": stack.account } } }),
      description: "Rovara MCP runner tasks: pulls the runner image, writes logs, reads the secrets of approved servers. Containers cannot use it.",
    });
    const repositoryArn = `arn:${Aws.PARTITION}:ecr:${imageParts[2]}:${imageParts[1]}:repository/${imageParts[3]}`;
    this.runnerExecutionRole.addToPolicy(new iam.PolicyStatement({ sid: "EcrToken", actions: ["ecr:GetAuthorizationToken"], resources: ["*"] }));
    this.runnerExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: "PullTheRunnerImage", actions: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"], resources: [repositoryArn],
    }));
    this.runnerExecutionRole.addToPolicy(new iam.PolicyStatement({ sid: "RunnerLogs", actions: ["logs:CreateLogStream", "logs:PutLogEvents"], resources: [runnerLogs.logGroupArn] }));
    const secretPrefix = `arn:${Aws.PARTITION}:secretsmanager:${region}:${stack.account}:secret:agentx/${props.agentxEnv}/org-connectors/${props.orgId}/mcp`;
    this.runnerExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: "ReadApprovedServerSecrets", actions: ["secretsmanager:GetSecretValue"], resources: [`${secretPrefix}*`],
      conditions: { StringEquals: { "secretsmanager:ResourceTag/rovara:org": props.orgId } },
    }));

    // ---- the static install task definition ---------------------------------------------------------------------------------------------------------------------------
    // No task role. `fetch`'s uid (10002) installs; the root file system is read-only; /work and /tmp are volumes the image declares (so they are owned by that uid).
    const runnerLogging = (prefix: string) => ({ logDriver: "awslogs", options: { "awslogs-group": runnerLogs.logGroupName, "awslogs-region": region, "awslogs-stream-prefix": prefix } });
    this.installTaskDefinition = new ecs.CfnTaskDefinition(this, "InstallTask", {
      family: MCP_INSTALL_FAMILY, cpu: "512", memory: "1024", networkMode: "awsvpc", requiresCompatibilities: ["FARGATE"], executionRoleArn: this.runnerExecutionRole.roleArn,
      runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" },
      volumes: [{ name: "work" }, { name: "tmp" }],
      containerDefinitions: [{
        name: "install", image: props.runnerImage, essential: true, user: "10002:10002", command: [NODE, "/opt/mcp-runner/install.mjs"], readonlyRootFilesystem: true,
        linuxParameters: { capabilities: { drop: ["ALL"] }, initProcessEnabled: true },
        mountPoints: [{ sourceVolume: "work", containerPath: "/work", readOnly: false }, { sourceVolume: "tmp", containerPath: "/tmp", readOnly: false }],
        logConfiguration: runnerLogging("install"),
      }],
      tags: [{ key: MCP_MANAGED_TAG.key, value: MCP_MANAGED_TAG.value }],
    });

    // ---- the controller's task role -----------------------------------------------------------------------------------------------------------------------------------
    // It starts and stops other tasks and makes security groups, so every grant is scoped to what it makes: `rovara-mcp-*` families, one cluster, one execution role, tagged groups.
    this.controllerTaskRole = new iam.Role(this, "ControllerTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com", { conditions: { StringEquals: { "aws:SourceAccount": stack.account } } }),
      description: "Rovara MCP controller: starts and stops MCP runner tasks and keeps their security groups",
    });
    // The L2 types disagree with exactOptionalPropertyTypes about optional members; the objects are the ones CDK made.
    const cluster = new ecs.Cluster(this, "Cluster", { vpc }) as unknown as ecs.ICluster;
    const ecsArn = (resource: string, name: string): string => `arn:${Aws.PARTITION}:ecs:${region}:${stack.account}:${resource}/${name}`;
    const families = ecsArn("task-definition", `${MCP_FAMILY_PREFIX}*:*`);
    const clusterOnly = { ArnEquals: { "ecs:cluster": cluster.clusterArn } };
    const policy = (statement: iam.PolicyStatementProps) => this.controllerTaskRole.addToPolicy(new iam.PolicyStatement(statement));
    policy({ sid: "RunMcpTasks", actions: ["ecs:RunTask"], resources: [families], conditions: clusterOnly });
    policy({ sid: "StopAndDescribeMcpTasks", actions: ["ecs:StopTask", "ecs:DescribeTasks"], resources: [ecsArn("task", `${cluster.clusterName}/*`)], conditions: clusterOnly });
    policy({ sid: "ListTasksInTheCluster", actions: ["ecs:ListTasks"], resources: ["*"], conditions: clusterOnly });
    // RegisterTaskDefinition takes the task-definition resource (the family's ARN) and the request's tags (AWS Service Authorization Reference, Amazon ECS): only `rovara-mcp-*` families, only tagged as managed.
    policy({ sid: "RegisterMcpTaskDefinitions", actions: ["ecs:RegisterTaskDefinition"], resources: [families], conditions: { StringEquals: { [`aws:RequestTag/${MCP_MANAGED_TAG.key}`]: MCP_MANAGED_TAG.value } } });
    // These four take no resource type, so "*" is all IAM allows; they read or remove definitions by name and the controller only names its own families (a code rule, tested in the gateway).
    policy({ sid: "ReadAndRetireTaskDefinitions", actions: ["ecs:DescribeTaskDefinition", "ecs:ListTaskDefinitions", "ecs:ListTaskDefinitionFamilies", "ecs:DeregisterTaskDefinition"], resources: ["*"] });
    // RunTask and RegisterTaskDefinition carry tags; the action that checks them is TagResource, here only as part of those two creations.
    policy({
      sid: "TagOnCreateOnly", actions: ["ecs:TagResource"], resources: [families, ecsArn("task", `${cluster.clusterName}/*`)],
      conditions: { StringEquals: { "ecs:CreateAction": ["RunTask", "RegisterTaskDefinition"] } },
    });
    policy({
      sid: "PassTheRunnerExecutionRoleOnly", actions: ["iam:PassRole"], resources: [this.runnerExecutionRole.roleArn], conditions: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } },
    });
    const ec2Arn = (resource: string, name: string): string => `arn:${Aws.PARTITION}:ec2:${region}:${stack.account}:${resource}/${name}`;
    const managedGroups = { StringEquals: { [`aws:ResourceTag/${MCP_MANAGED_TAG.key}`]: MCP_MANAGED_TAG.value } };
    policy({ sid: "CreateSecurityGroupsInTheVpc", actions: ["ec2:CreateSecurityGroup"], resources: [ec2Arn("vpc", props.vpcId)] });
    policy({
      sid: "CreateManagedSecurityGroups", actions: ["ec2:CreateSecurityGroup"], resources: [ec2Arn("security-group", "*")],
      conditions: { StringEquals: { [`aws:RequestTag/${MCP_MANAGED_TAG.key}`]: MCP_MANAGED_TAG.value } },
    });
    policy({
      sid: "TagSecurityGroupsAtCreation", actions: ["ec2:CreateTags"], resources: [ec2Arn("security-group", "*")],
      conditions: { StringEquals: { "ec2:CreateAction": "CreateSecurityGroup", [`aws:RequestTag/${MCP_MANAGED_TAG.key}`]: MCP_MANAGED_TAG.value } },
    });
    policy({
      sid: "ChangeManagedSecurityGroups",
      actions: ["ec2:AuthorizeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress", "ec2:RevokeSecurityGroupIngress", "ec2:RevokeSecurityGroupEgress", "ec2:DeleteSecurityGroup"],
      resources: [ec2Arn("security-group", "*")], conditions: managedGroups,
    });
    policy({ sid: "FindSecurityGroups", actions: ["ec2:DescribeSecurityGroups"], resources: ["*"] });
    policy({
      sid: "ResolveServerSecretArns", actions: ["secretsmanager:DescribeSecret"], resources: [`${secretPrefix}*`],
    });
    // Exactly the calls the bundle store makes (get, put, head), on the `bundles/` prefix. With `s3:ListBucket` on the bucket a HEAD of a missing key answers 404 (without it S3 answers 403, which the
    // store would take for a real refusal): https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html . ListBucket is not given an `s3:prefix` condition because a HEAD carries no prefix, so
    // the condition would fail it; the bucket holds nothing but bundles.
    policy({ sid: "ReadAndWriteBundles", actions: ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload"], resources: [this.bundleBucket.arnForObjects("bundles/*")] });
    policy({ sid: "SeeWhichBundlesExist", actions: ["s3:ListBucket"], resources: [this.bundleBucket.bucketArn] });
    policy({ sid: "UseTheBundleKey", actions: ["kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"], resources: [this.bundleKey.keyArn] });
    const tableKeys = (partition: string) => ({ "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [`ORG#${props.orgId}#${partition}`] }, Null: { "dynamodb:LeadingKeys": "false" } });
    policy({ sid: "ReadMcpServerRegistry", actions: ["dynamodb:GetItem", "dynamodb:Query"], resources: [props.stateTableArn], conditions: tableKeys("MCPSRV") });
    policy({ sid: "ProbeSlotsAndInstanceLeases", actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"], resources: [props.stateTableArn], conditions: tableKeys("MCPSLOT") });
    policy({ sid: "WriteControllerEvents", actions: ["dynamodb:PutItem"], resources: [props.stateTableArn], conditions: tableKeys("MCPEVT") });

    // ---- the controller service ---------------------------------------------------------------------------------------------------------------------------------------
    const namespace = new servicediscovery.PrivateDnsNamespace(this, "Namespace", { name: props.controllerDnsNamespace, vpc, description: "Rovara MCP controller address for the runner tasks" });
    const task = new ecs.FargateTaskDefinition(this, "Task", { cpu: 512, memoryLimitMiB: 1024, taskRole: this.controllerTaskRole, runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX } });
    // A writable /tmp (bundle staging), owned by the controller's uid through the image's own VOLUME directive.
    task.addVolume({ name: "scratch" });
    const hardened = new ecs.LinuxParameters(this, "Hardened", { initProcessEnabled: true });
    hardened.dropCapabilities(ecs.Capability.ALL);
    const tlsSecret = secretsmanager.Secret.fromSecretCompleteArn(this, "ControllerTls", props.controllerTlsSecretArn);
    this.controllerUrl = `https://controller.${props.controllerDnsNamespace}:${MCP_RUNNER_PORT}`;
    const container = task.addContainer("Controller", {
      image: props.image,
      command: ["node", "packages/broker/dist/mcp-host/main.js"],
      readonlyRootFilesystem: true,
      // Never root: the controller runs no customer code, and refuses to start as uid 0 (packages/broker/src/mcp-host/main.ts).
      user: MCP_CONTROLLER_UID,
      linuxParameters: hardened,
      logging: ecs.LogDrivers.awsLogs({ logGroup: controllerLogs, streamPrefix: "mcp-controller" }),
      environment: {
        ROVARA_ORG_ID: props.orgId, AGENTX_ENV: props.agentxEnv, STATE_TABLE_NAME: props.stateTableName, AWS_REGION: region, PORT: String(MCP_HOST_PORT), MCP_RUNNER_PORT: String(MCP_RUNNER_PORT),
        MCP_ECS_CLUSTER: cluster.clusterName, MCP_RUNNER_SUBNETS: this.runnerSubnets.map((subnet) => subnet.ref).join(","), MCP_INSTALL_SECURITY_GROUP: this.installSecurityGroup.securityGroupId,
        MCP_CONTROLLER_SECURITY_GROUP: this.controllerSecurityGroup.securityGroupId, MCP_ENDPOINT_SECURITY_GROUPS: props.endpointSecurityGroupId, MCP_S3_PREFIX_LIST: s3PrefixList,
        MCP_VPC_ID: props.vpcId, MCP_RUNNER_IMAGE: props.runnerImage, MCP_EXECUTION_ROLE_ARN: this.runnerExecutionRole.roleArn, MCP_RUNNER_LOG_GROUP: runnerLogs.logGroupName,
        MCP_BUNDLE_BUCKET: this.bundleBucket.bucketName, MCP_CONTROLLER_URL: this.controllerUrl, ROVARA_MCP_NPM_REGISTRY: registry.href,
        ROVARA_PRIVATE_MCP_CIDRS: props.privateMcpCidrs.join(","), ROVARA_VPC_CIDRS: props.vpcCidrs.join(","),
        ...(props.controllerCaPem === undefined ? {} : { ROVARA_MCP_CONTROLLER_CA: props.controllerCaPem }),
      },
      secrets: {
        MCP_HOST_TOKEN: ecs.Secret.fromSecretsManager(this.tokenSecret as unknown as secretsmanager.ISecret),
        MCP_CONTROLLER_TLS_CERT: ecs.Secret.fromSecretsManager(tlsSecret, "cert"),
        MCP_CONTROLLER_TLS_KEY: ecs.Secret.fromSecretsManager(tlsSecret, "key"),
      },
      portMappings: [{ containerPort: MCP_HOST_PORT }, { containerPort: MCP_RUNNER_PORT }],
      healthCheck: { command: ["CMD", "node", "-e", `fetch('http://127.0.0.1:${MCP_HOST_PORT}/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))`], interval: Duration.seconds(30), timeout: Duration.seconds(5), retries: 3 },
    });
    container.addMountPoints({ containerPath: "/tmp", sourceVolume: "scratch", readOnly: false });

    // ONE instance: tokens live in one process, and a runner's calls must reach the instance that holds its token. A deploy stops the old task before the new one starts (minimumHealthyPercent 0).
    const service = new ecs.FargateService(this, "Service", {
      cluster, taskDefinition: task, desiredCount: 1, assignPublicIp: false, vpcSubnets: controllerSubnets, securityGroups: [this.controllerSecurityGroup],
      minHealthyPercent: 0, maxHealthyPercent: 100, circuitBreaker: { rollback: true },
      cloudMapOptions: { name: "controller", cloudMapNamespace: namespace, dnsRecordType: servicediscovery.DnsRecordType.A, dnsTtl: Duration.seconds(10), container, containerPort: MCP_RUNNER_PORT },
    });
    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, "LoadBalancer", { vpc, internetFacing: false, vpcSubnets: controllerSubnets, securityGroup: this.loadBalancerSecurityGroup, idleTimeout: Duration.seconds(120) });
    const listener = loadBalancer.addListener("Listener", { port: 443, protocol: elbv2.ApplicationProtocol.HTTPS, certificates: [elbv2.ListenerCertificate.fromArn(props.certificateArn)], open: false });
    listener.addTargets("Target", {
      port: MCP_HOST_PORT, protocol: elbv2.ApplicationProtocol.HTTP, targets: [service.loadBalancerTarget({ containerName: "Controller", containerPort: MCP_HOST_PORT })],
      healthCheck: { path: "/healthz", healthyHttpCodes: "200" }, deregistrationDelay: Duration.seconds(30),
    });
    new route53.CfnRecordSet(this, "HostName", {
      hostedZoneId: props.hostedZoneId, name: props.hostName, type: "A",
      aliasTarget: { dnsName: loadBalancer.loadBalancerDnsName, hostedZoneId: loadBalancer.loadBalancerCanonicalHostedZoneId, evaluateTargetHealth: true },
    });
    this.url = `https://${props.hostName}`;
    new CfnOutput(this, "McpHostUrl", { value: this.url, description: "The MCP controller's private URL: the broker's MCP_HOST_URL" });
  }
}
