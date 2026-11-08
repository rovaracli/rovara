// The self-hosted embedder (lane self-hosted-embeddings; DECISIONS 23 and 27): the Team record's embedding model (Qwen3-Embedding-0.6B, 1,024-d) and the lessons' (bge-small,
// 384-d) in ONE container-image Lambda, on our own compute, in both editions. Part of the Team record switch (`agentxTeamRecord=enabled`): with the switch off, nothing here exists
// and the synthesised templates are what they were (tests/contract/team-record-wiring-infrastructure.test.ts pins that).
//
// The image is built by environments/embedder (weights baked in at build time from pinned Hugging Face revisions, every file checked by sha256; every Python package installed by hash;
// no network at run time) and is named to the stack as a private-ECR image PINNED BY DIGEST: the stack parameter `EmbedderImageUri`. The release names the image (release.json
// `images.embedder`); the CLI passes it (packages/cli/src/deploy/parameters.ts): from the pull-through cache in a Public install, from the install's own `rovara-bundle/<env>/embedder`
// repository in an Enterprise one (loaded from the signed bundle). A Team record with no embedder image is refused (decision 27: no keyword-only interim): the template carries a rule that
// fails the stack operation with a message, and the CLI refuses earlier.
//
// NO NETWORK, ENFORCED: the function runs in a small VPC of its own (below) whose subnets have no route out (no internet gateway, no NAT, no endpoint), a security group with no
// egress rule, and DNS turned OFF for the VPC (the Amazon-provided resolver is not filtered by security groups and recurses to the internet, so it would carry a text out as a query name),
// so even a compromised dependency has nowhere to send a text. Lambda needs none of that to be invoked (the broker calls the Lambda API, not the VPC) or to write logs.
// Only the broker may invoke it (its role gets `lambda:InvokeFunction` on this one function); the function itself can reach no AWS service: its role holds log writes and the network-interface
// rights Lambda needs for a VPC, and it has no environment variable.
//
// [verify] on the first Enterprise deploy: a KMS-encrypted ECR repository (the bundle repositories use ECR's default encryption today) may need the deploying role or Lambda to be allowed
// kms:Decrypt on the key; the image pull by CreateFunction was not tested against a customer-managed key (needs a staging run with an image in such a repository).
import { ArnFormat, CfnParameter, CfnRule, Duration, Fn, RemovalPolicy, type Stack, aws_ec2 as ec2, aws_iam as iam, aws_lambda as lambda, aws_logs as logs } from "aws-cdk-lib";
import { embedderFunctionName } from "@agentx/contracts";
import { defaultProductionAvailabilityZoneIds } from "./production-foundation.js";

/**
 * The most Lambda gives (10 GB, about 5.8 vCPUs): the models run in fp32 (the Qwen weights are 2.4 GB on disk and in memory), and a long text is real compute (the record model reads up
 * to 2,048 tokens). Nothing is billed while idle. Not measured on a real arm64 Lambda yet (see the lane report): the memory is the one knob that buys speed.
 */
export const EMBEDDER_MEMORY_MB = 10240;
/** A cold start loads the model (seconds); one text of 2,048 tokens takes seconds more; a batch is at most 16 texts. The broker waits for less (EMBEDDER_WAIT_MS), and the function carries on and warms. */
export const EMBEDDER_TIMEOUT_SECONDS = 180;
/** Modest on purpose: a burst of ingest cannot take the account's concurrency. The broker retries the rows it could not embed. */
export const EMBEDDER_RESERVED_CONCURRENCY = 4;

/** A private ECR image reference pinned by digest, or `none` (the default, which the template's rule refuses: the Team record has no keyword-only mode). */
export const EMBEDDER_IMAGE_PATTERN = "^(none|[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com(\\.cn)?/[a-z0-9][a-z0-9._/-]{1,255}@sha256:[a-f0-9]{64})$";

/** The message CloudFormation shows when the Team record is asked for with no embedder image. */
export const EMBEDDER_IMAGE_REQUIRED_MESSAGE = "The Team record needs the embedder image: name an image pinned by digest in EmbedderImageUri (agentx upgrade passes the release's own embedder image; agentx config set teamRecord.embedderImage <image> names one by hand). There is no search without it.";

/** The embedder's own network: two subnets with no route to anywhere, in a VPC with no gateway and with DNS off. */
const NETWORK_CIDR = "10.251.0.0/24";
const SUBNET_CIDRS = ["10.251.0.0/26", "10.251.0.64/26"] as const;

export interface EmbedderProps {
  readonly env: string;
  /** The region the install deploys to: the subnets are placed by its verified availability-zone IDs (review R5). */
  readonly region: string;
  /** The only principal allowed to invoke the function. */
  readonly broker: lambda.Function;
  /** False where the account's Lambda concurrency quota cannot take a reservation (the agentxReservedConcurrency context). */
  readonly reservedConcurrency?: boolean;
}

export interface EmbedderResources {
  readonly imageUri: CfnParameter;
  readonly role: iam.Role;
  readonly logGroup: logs.LogGroup;
  readonly function: lambda.CfnFunction;
  readonly vpc: ec2.CfnVPC;
  readonly securityGroup: ec2.CfnSecurityGroup;
  readonly subnets: readonly ec2.CfnSubnet[];
}

export function attachEmbedder(stack: Stack, props: EmbedderProps): EmbedderResources {
  const functionName = embedderFunctionName(props.env);
  const imageUri = new CfnParameter(stack, "EmbedderImageUri", {
    type: "String",
    default: "none",
    allowedPattern: EMBEDDER_IMAGE_PATTERN,
    description: "Immutable private ECR linux/arm64 image of the self-hosted embedder (environments/embedder) pinned by digest, in this account and region. The release names it and agentx upgrade passes it; it is required while the Team record exists",
  });
  new CfnRule(stack, "TeamRecordNeedsEmbedderImage", { assertions: [{ assert: Fn.conditionNot(Fn.conditionEquals(imageUri.valueAsString, "none")), assertDescription: EMBEDDER_IMAGE_REQUIRED_MESSAGE }] });

  // The function's own network. No internet gateway, no NAT gateway, no endpoint, and the subnets use the VPC's main route table (the local route only); the security group has no egress rule.
  // DNS is OFF (review R1): traffic to the Amazon-provided resolver is not filtered by security groups or network ACLs, and the resolver recurses to the internet, so with DNS on a compromised
  // package could send text out as query names. The function resolves nothing: the Lambda service invokes it and takes its logs from outside the VPC.
  const vpc = new ec2.CfnVPC(stack, "EmbedderNetwork", { cidrBlock: NETWORK_CIDR, enableDnsSupport: false, enableDnsHostnames: false, tags: [{ key: "Name", value: `${functionName}-no-egress` }] });
  // The subnets are placed by the foundation's verified availability-zone IDs (review R5), not by zone names: a zone NAME is a different physical zone in each account, and in us-east-1 one
  // zone ID (use1-az3) does not take Lambda VPC networking. An unsupported region fails at synth, as the foundation does.
  const zoneIds = defaultProductionAvailabilityZoneIds(props.region);
  const subnets = SUBNET_CIDRS.map((cidrBlock, index) => new ec2.CfnSubnet(stack, `EmbedderSubnet${index + 1}`, {
    vpcId: vpc.ref, cidrBlock, availabilityZoneId: zoneIds[index] as string, mapPublicIpOnLaunch: false, tags: [{ key: "Name", value: `${functionName}-no-egress-${index + 1}` }],
  }));
  const securityGroup = new ec2.CfnSecurityGroup(stack, "EmbedderSecurityGroup", {
    vpcId: vpc.ref,
    groupDescription: "Rovara embedder: no inbound and no outbound traffic",
    // CloudFormation adds an allow-all egress rule when none is given; this one is the documented way to say "none" (no packet can match it).
    securityGroupEgress: [{ ipProtocol: "icmp", cidrIp: "255.255.255.255/32", fromPort: 252, toPort: 86, description: "Disallow all traffic" }],
  });

  const logGroup = new logs.LogGroup(stack, "EmbedderLogs", { logGroupName: `/aws/lambda/${functionName}`, retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY });
  const role = new iam.Role(stack, "EmbedderRole", {
    assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    description: "The Rovara embedder function: writes its own logs and manages its own network interfaces, nothing else",
  });
  logGroup.grantWrite(role);
  // What Lambda needs to put a function in a VPC (the AWS-managed policy for it also grants logging on every group, which this role must not have): create the network interface in these two
  // subnets with this security group, and manage the interfaces of this account and region.
  const networkInterfaces = stack.formatArn({ service: "ec2", resource: "network-interface", resourceName: "*", arnFormat: ArnFormat.SLASH_RESOURCE_NAME });
  role.addToPolicy(new iam.PolicyStatement({
    sid: "CreateOwnNetworkInterface",
    actions: ["ec2:CreateNetworkInterface"],
    resources: [networkInterfaces, ...subnets.map((subnet) => stack.formatArn({ service: "ec2", resource: "subnet", resourceName: subnet.ref, arnFormat: ArnFormat.SLASH_RESOURCE_NAME })), stack.formatArn({ service: "ec2", resource: "security-group", resourceName: securityGroup.attrGroupId, arnFormat: ArnFormat.SLASH_RESOURCE_NAME })],
  }));
  role.addToPolicy(new iam.PolicyStatement({ sid: "ManageOwnNetworkInterfaces", actions: ["ec2:DeleteNetworkInterface", "ec2:AssignPrivateIpAddresses", "ec2:UnassignPrivateIpAddresses"], resources: [networkInterfaces] }));
  // Describe calls take no resource.
  role.addToPolicy(new iam.PolicyStatement({ sid: "DescribeNetwork", actions: ["ec2:DescribeNetworkInterfaces", "ec2:DescribeSubnets", "ec2:DescribeSecurityGroups", "ec2:DescribeVpcs"], resources: ["*"] }));

  const fn = new lambda.CfnFunction(stack, "Embedder", {
    functionName,
    description: "Rovara self-hosted embedder: Qwen3-Embedding-0.6B for the Team record and bge-small for lessons, on CPU, no network",
    packageType: "Image",
    code: { imageUri: imageUri.valueAsString },
    architectures: ["arm64"],
    memorySize: EMBEDDER_MEMORY_MB,
    timeout: Duration.seconds(EMBEDDER_TIMEOUT_SECONDS).toSeconds(),
    role: role.roleArn,
    vpcConfig: { securityGroupIds: [securityGroup.attrGroupId], subnetIds: subnets.map((subnet) => subnet.ref) },
    ...(props.reservedConcurrency === false ? {} : { reservedConcurrentExecutions: EMBEDDER_RESERVED_CONCURRENCY }),
    loggingConfig: { logGroup: logGroup.logGroupName },
  });
  fn.node.addDependency(logGroup);
  // The role's policy (the network-interface rights) must exist before the function is created.
  fn.node.addDependency(role);

  // The broker, and only the broker, calls the function: one action on one function.
  props.broker.addToRolePolicy(new iam.PolicyStatement({
    sid: "InvokeEmbedder",
    actions: ["lambda:InvokeFunction"],
    resources: [stack.formatArn({ service: "lambda", resource: "function", resourceName: functionName, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
  }));
  return { imageUri, role, logGroup, function: fn, vpc, securityGroup, subnets };
}
