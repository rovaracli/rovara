// Enterprise foundations, task N1: the network of an Enterprise install. Workers and the control plane's callers reach AWS through interface endpoints in the
// install's own VPC, and their security groups let traffic out only to the VPC and to addresses the customer's network team approved: never to the whole internet.
import { type CfnTag, aws_ec2 as ec2 } from "aws-cdk-lib";
import { Construct } from "constructs";
import { EDITION_CONTEXT_KEY, EditionSchema, type Edition } from "@agentx/contracts";

/**
 * The AWS services an Enterprise install reaches through an interface endpoint with private DNS. The first eight are what the workers and the model proxy
 * need (Bedrock in the customer's own account, tokens, keys, logs, the image registry, secrets and parameters); the last three are what the dispatcher and the
 * session manager call. S3 is added separately (see `s3Interface`), and DynamoDB is a free gateway endpoint.
 */
export const ENTERPRISE_INTERFACE_ENDPOINT_SERVICES = [
  "bedrock-runtime", "sts", "kms", "logs", "ecr.api", "ecr.dkr", "secretsmanager", "ssm", "sqs", "states", "ec2",
] as const;
export type EnterpriseEndpointService = (typeof ENTERPRISE_INTERFACE_ENDPOINT_SERVICES)[number] | "s3";

/** The CDK context keys an Enterprise install's network settings arrive in. */
export const ENTERPRISE_INTERNET_EGRESS_CONTEXT_KEY = "rovaraEnterpriseInternetEgress";
export const ENTERPRISE_EGRESS_CIDRS_CONTEXT_KEY = "rovaraEnterpriseEgressCidrs";

/** The edition from the CDK context (`-c rovaraEdition=...`): exactly `enterprise` or `public`, or unset (today's network). Anything else is refused. */
export function parseEditionContext(value: unknown): Edition | undefined {
  if (value === undefined) return undefined;
  const parsed = EditionSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${EDITION_CONTEXT_KEY} must be "enterprise" or "public"`);
  return parsed.data;
}

export const MAX_ENTERPRISE_EGRESS_CIDRS = 20;
/** No approved range may be wider than a /8: a range that wide is the internet by another name. */
export const MIN_ENTERPRISE_EGRESS_PREFIX = 8;

/** Whether the install has a NAT gateway (and so an internet route) at all. `none` runs the install with no internet route. */
export type InternetEgress = "nat" | "none";

export function parseInternetEgress(value: unknown): InternetEgress {
  if (value === undefined || value === "") return "nat";
  if (value === "nat" || value === "none") return value;
  throw new Error(`${ENTERPRISE_INTERNET_EGRESS_CONTEXT_KEY} must be "nat" or "none"`);
}

/**
 * The address ranges the customer's network team approved for the workers to reach (an internal code host, build system, registry, the broker's own address), as
 * a comma-separated list of IPv4 CIDRs. Each must be well formed and no wider than a /8, so `0.0.0.0/0` and anything like it is refused; `inside` (the VPC's own
 * range) is always allowed and is not listed. At most 20.
 */
export function parseEnterpriseEgressCidrs(value: unknown): string[] {
  if (value === undefined || value === "") return [];
  if (typeof value !== "string") throw new Error(`${ENTERPRISE_EGRESS_CIDRS_CONTEXT_KEY} must be a comma-separated string of IPv4 CIDRs`);
  const entries = value.split(",").map((part) => part.trim()).filter((part) => part !== "");
  if (entries.length > MAX_ENTERPRISE_EGRESS_CIDRS) throw new Error(`${ENTERPRISE_EGRESS_CIDRS_CONTEXT_KEY} holds at most ${MAX_ENTERPRISE_EGRESS_CIDRS} ranges`);
  const seen = new Set<string>();
  for (const entry of entries) {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(entry);
    const octets = match === null ? [] : [match[1]!, match[2]!, match[3]!, match[4]!].map(Number);
    const prefix = match === null ? Number.NaN : Number(match[5]);
    if (match === null || octets.some((octet) => octet > 255) || prefix > 32) throw new Error(`${ENTERPRISE_EGRESS_CIDRS_CONTEXT_KEY} entry ${JSON.stringify(entry)} is not an IPv4 CIDR such as 10.20.0.0/16`);
    if (prefix < MIN_ENTERPRISE_EGRESS_PREFIX) throw new Error(`${ENTERPRISE_EGRESS_CIDRS_CONTEXT_KEY} entry ${JSON.stringify(entry)} is wider than a /${MIN_ENTERPRISE_EGRESS_PREFIX}; list the specific ranges`);
    seen.add(entry);
  }
  return [...seen];
}

export interface EnterpriseVpcEndpointsProps {
  vpcId: string;
  /** The VPC's own range: endpoints accept HTTPS from it and from nowhere else. */
  vpcCidr: string;
  region: string;
  privateSubnets: readonly ec2.CfnSubnet[];
  privateRouteTables: readonly ec2.CfnRouteTable[];
  /** The Name tag prefix, for example agentx-<env>. */
  resourcePrefix: string;
  tags: (name: string) => CfnTag[];
  /**
   * Reach S3 (image layers, artifacts) through an interface endpoint with private DNS, so a worker's security group needs only the VPC range. S3's gateway
   * endpoint stays too. Default true. [verify in the install proof: private DNS for an S3 interface endpoint next to a gateway endpoint]
   */
  s3Interface?: boolean;
}

export class EnterpriseVpcEndpoints extends Construct {
  readonly securityGroup: ec2.CfnSecurityGroup;
  readonly interfaceEndpoints: readonly ec2.CfnVPCEndpoint[];
  readonly services: readonly EnterpriseEndpointService[];

  constructor(scope: Construct, id: string, props: EnterpriseVpcEndpointsProps) {
    super(scope, id);
    // HTTPS from inside the VPC only. The endpoints never start a connection, so no egress is allowed (the "no egress" rule is the one CDK uses for allowAllOutbound: false).
    this.securityGroup = new ec2.CfnSecurityGroup(this, "EndpointSecurityGroup", {
      groupDescription: "AgentX Enterprise VPC endpoints: HTTPS from the VPC only, no egress",
      groupName: `${props.resourcePrefix}-vpc-endpoints`,
      securityGroupIngress: [{ ipProtocol: "tcp", fromPort: 443, toPort: 443, cidrIp: props.vpcCidr, description: "HTTPS from the VPC" }],
      securityGroupEgress: [{ ipProtocol: "icmp", fromPort: 252, toPort: 86, cidrIp: "255.255.255.255/32", description: "Disallow all traffic" }],
      tags: props.tags(`${props.resourcePrefix}-vpc-endpoints`),
      vpcId: props.vpcId,
    });
    const services: EnterpriseEndpointService[] = [...ENTERPRISE_INTERFACE_ENDPOINT_SERVICES, ...(props.s3Interface === false ? [] : ["s3" as const])];
    this.services = services;
    this.interfaceEndpoints = services.map((service) => new ec2.CfnVPCEndpoint(this, `Endpoint-${service.replace(/\./g, "-")}`, {
      serviceName: `com.amazonaws.${props.region}.${service}`,
      vpcEndpointType: "Interface",
      vpcId: props.vpcId,
      subnetIds: props.privateSubnets.map((subnet) => subnet.ref),
      securityGroupIds: [this.securityGroup.attrGroupId],
      privateDnsEnabled: true,
    }));
    // Workers and callers keep a private route to DynamoDB (free).
    new ec2.CfnVPCEndpoint(this, "DynamoDbGatewayEndpoint", {
      serviceName: `com.amazonaws.${props.region}.dynamodb`,
      vpcEndpointType: "Gateway",
      vpcId: props.vpcId,
      routeTableIds: props.privateRouteTables.map((table) => table.ref),
    });
  }
}
