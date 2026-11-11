import {
  Aws,
  CfnDeletionPolicy,
  CfnOutput,
  type CfnTag,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_ec2 as ec2,
  aws_iam as iam,
  aws_kms as kms,
  aws_logs as logs,
  aws_ssm as ssm,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { Edition } from "@rovara-code/contracts";
import { AgentDnsFirewall, EGRESS_ALLOW_DOMAINS_CONTEXT_KEY, hostedAgentAllowDomains, parseExtraAllowDomains } from "./agent-dns-firewall.js";
import { EgressAlarms, alertsTopicFromName } from "./egress-alarms.js";
import { Ec2WorkerFoundation } from "./ec2-workers.js";
import { EnterpriseVpcEndpoints, endpointPolicyDocument, enterpriseAllowDomains, workerDockerRangeOf, type InternetEgress } from "./vpc-endpoints.js";
import { type AgentXNaming, legacyNaming } from "./naming.js";

export const AGENTX_PRODUCTION_DEPLOYMENT_MODE = "ec2-ebs";
export const AGENTX_PRODUCTION_VPC_CIDR = "10.42.0.0/16";
export const AGENTX_PRODUCTION_INSTANCE_TYPE = "m6g.large";

const DEFAULT_AZ_IDS: Readonly<Record<string, readonly [string, string]>> = {
  "us-east-1": ["use1-az1", "use1-az2"],
  "us-west-2": ["usw2-az1", "usw2-az2"],
};

/**
 * The regions a release covers: exactly the regions with verified availability-zone IDs above. Adding a region means adding its verified zone IDs to
 * `DEFAULT_AZ_IDS`; nothing else changes.
 */
export const SUPPORTED_REGIONS: readonly string[] = Object.keys(DEFAULT_AZ_IDS).sort();

export interface ProductionFoundationConfiguration {
  region: string;
  availabilityZoneIds: readonly [string, string];
  instanceType: string;
}

export interface ProductionFoundationStackProps extends StackProps {
  deploymentRegion: string;
  configuration?: Partial<Omit<ProductionFoundationConfiguration, "region">>;
  naming?: AgentXNaming;
  /** The hosted Rovara cloud (agentxCloud context, named environments only): adds the DNS firewall that limits which websites agent machines can resolve. */
  cloud?: boolean;
  /**
   * The edition of this install (task N1). Absent: today's network, unchanged. `enterprise` (named environments only): the install's own interface endpoints,
   * worker and caller security groups with no route to the whole internet, and the DNS firewall in allow-list mode. `public`: today's network, unchanged.
   */
  edition?: Edition;
  /**
   * Enterprise only. Default `none`: the install is built with no internet route at all (nothing leaves unless the customer approves a path); `nat` keeps the NAT
   * gateways. `none` needs at least one approved range (`enterpriseEgressCidrs`), because workers must reach the control plane. Refused on any other edition.
   */
  internetEgress?: InternetEgress;
  /**
   * Enterprise only: IPv4 ranges (each no wider than a /8) that workers and callers may reach over HTTPS besides the VPC itself, approved by the customer's
   * network team (for example the broker's address, an internal code host). Refused on any other edition.
   */
  enterpriseEgressCidrs?: readonly string[];
  /**
   * Enterprise only (review M6): the names an install with package-run MCP servers must let through its DNS firewall, from `mcpHostAllowDomains` (the controller's private name, the package registry's
   * host and the ECS API). Plain host names only. Absent: the plain Enterprise list, which has none of them.
   */
  stdioMcpAllowDomains?: readonly string[];
}

export function defaultProductionAvailabilityZoneIds(
  region: string,
): readonly [string, string] {
  const availabilityZoneIds = DEFAULT_AZ_IDS[region];
  if (!availabilityZoneIds) {
    throw new Error(
      `no verified availability-zone IDs are configured for ${region}`,
    );
  }
  return availabilityZoneIds;
}

export function validateProductionFoundationConfiguration(
  configuration: ProductionFoundationConfiguration,
): ProductionFoundationConfiguration {
  if (
    configuration.availabilityZoneIds.length !== 2 ||
    new Set(configuration.availabilityZoneIds).size !== 2 ||
    configuration.availabilityZoneIds.some((value) => !/^[a-z0-9-]+-az[0-9]+$/.test(value))
  ) {
    throw new Error("production requires two distinct availability-zone IDs");
  }
  if (!/^[a-z][a-z0-9-]*\.[a-z0-9]+$/.test(configuration.instanceType)) {
    throw new Error("instance type is invalid");
  }
  return configuration;
}

export class ProductionFoundationStack extends Stack {
  constructor(scope: Construct, id: string, props: ProductionFoundationStackProps) {
    super(scope, id, props);
    const naming = props.naming ?? legacyNaming();
    const enterprise = props.edition === "enterprise";
    // A network setting that would do nothing on this edition is refused, never ignored.
    if (props.stdioMcpAllowDomains !== undefined) {
      if (!enterprise) throw new Error("stdioMcpAllowDomains is an Enterprise edition setting");
      for (const name of props.stdioMcpAllowDomains) if (!/^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/u.test(name)) throw new Error("a package-run MCP DNS name must be a plain host name");
    }
    if (!enterprise && (props.internetEgress !== undefined || props.enterpriseEgressCidrs !== undefined)) {
      throw new Error("internetEgress and enterpriseEgressCidrs are Enterprise edition settings");
    }
    if (enterprise && naming.env === undefined) throw new Error("the Enterprise edition needs a named environment");
    for (const entry of props.enterpriseEgressCidrs ?? []) {
      const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/u.exec(entry);
      const reserved = match === null ? undefined : workerDockerRangeOf([match[1]!, match[2]!, match[3]!, match[4]!].map(Number), Number(match[5]));
      if (reserved !== undefined) throw new Error(`enterpriseEgressCidrs entry ${JSON.stringify(entry)} lies inside ${reserved}, which the workers' Docker uses for its own networks`);
    }
    const noNat = enterprise && props.internetEgress !== "nat";
    if (noNat && (props.enterpriseEgressCidrs ?? []).length === 0) {
      throw new Error("an Enterprise install with no internet route needs at least one approved range (rovaraEnterpriseEgressCidrs): the workers must reach the control plane, which is public until the private control-plane path exists");
    }
    const configuration = validateProductionFoundationConfiguration({
      region: props.deploymentRegion,
      availabilityZoneIds:
        props.configuration?.availabilityZoneIds ??
        defaultProductionAvailabilityZoneIds(props.deploymentRegion),
      instanceType: props.configuration?.instanceType ?? AGENTX_PRODUCTION_INSTANCE_TYPE,
    });

    const vpc = new ec2.CfnVPC(this, "Vpc", {
      cidrBlock: AGENTX_PRODUCTION_VPC_CIDR,
      enableDnsHostnames: true,
      enableDnsSupport: true,
      instanceTenancy: "default",
      tags: resourceTags(naming.resourcePrefix, naming),
    });
    const internetGateway = new ec2.CfnInternetGateway(this, "InternetGateway", {
      tags: resourceTags(`${naming.resourcePrefix}-igw`, naming),
    });
    const gatewayAttachment = new ec2.CfnVPCGatewayAttachment(this, "InternetGatewayAttachment", {
      internetGatewayId: internetGateway.ref,
      vpcId: vpc.ref,
    });

    const publicCidrs = ["10.42.0.0/20", "10.42.16.0/20"] as const;
    const privateCidrs = ["10.42.128.0/20", "10.42.144.0/20"] as const;
    const privateSubnets: ec2.CfnSubnet[] = [];
    const privateRouteTables: ec2.CfnRouteTable[] = [];
    const privateRoutes: ec2.CfnRoute[] = [];
    const natGateways: Array<{ az: string; natGateway: ec2.CfnNatGateway }> = [];

    for (const index of [0, 1] as const) {
      const suffix = index + 1;
      const publicSubnet = new ec2.CfnSubnet(this, `PublicSubnet${suffix}`, {
        availabilityZoneId: configuration.availabilityZoneIds[index],
        cidrBlock: publicCidrs[index],
        mapPublicIpOnLaunch: false,
        vpcId: vpc.ref,
        tags: resourceTags(`${naming.resourcePrefix}-public-${suffix}`, naming),
      });
      const publicRouteTable = new ec2.CfnRouteTable(this, `PublicRouteTable${suffix}`, {
        vpcId: vpc.ref,
        tags: resourceTags(`${naming.resourcePrefix}-public-${suffix}`, naming),
      });
      new ec2.CfnSubnetRouteTableAssociation(this, `PublicAssociation${suffix}`, {
        routeTableId: publicRouteTable.ref,
        subnetId: publicSubnet.ref,
      });
      const publicRoute = new ec2.CfnRoute(this, `PublicDefaultRoute${suffix}`, {
        destinationCidrBlock: "0.0.0.0/0",
        gatewayId: internetGateway.ref,
        routeTableId: publicRouteTable.ref,
      });
      publicRoute.addResourceDependency(gatewayAttachment);

      let natGateway: ec2.CfnNatGateway | undefined;
      if (!noNat) {
        const eip = new ec2.CfnEIP(this, `NatEip${suffix}`, { domain: "vpc" });
        eip.addResourceDependency(gatewayAttachment);
        natGateway = new ec2.CfnNatGateway(this, `NatGateway${suffix}`, {
          allocationId: eip.attrAllocationId,
          connectivityType: "public",
          subnetId: publicSubnet.ref,
          tags: resourceTags(`${naming.resourcePrefix}-nat-${suffix}`, naming),
        });
        natGateway.addResourceDependency(publicRoute);
        natGateways.push({ az: configuration.availabilityZoneIds[index], natGateway });
      }

      const privateSubnet = new ec2.CfnSubnet(this, `PrivateSubnet${suffix}`, {
        availabilityZoneId: configuration.availabilityZoneIds[index],
        cidrBlock: privateCidrs[index],
        mapPublicIpOnLaunch: false,
        vpcId: vpc.ref,
        tags: resourceTags(`${naming.resourcePrefix}-private-${suffix}`, naming),
      });
      const privateRouteTable = new ec2.CfnRouteTable(this, `PrivateRouteTable${suffix}`, {
        vpcId: vpc.ref,
        tags: resourceTags(`${naming.resourcePrefix}-private-${suffix}`, naming),
      });
      new ec2.CfnSubnetRouteTableAssociation(this, `PrivateAssociation${suffix}`, {
        routeTableId: privateRouteTable.ref,
        subnetId: privateSubnet.ref,
      });
      if (natGateway !== undefined) {
        const privateRoute = new ec2.CfnRoute(this, `PrivateDefaultRoute${suffix}`, {
          destinationCidrBlock: "0.0.0.0/0",
          natGatewayId: natGateway.ref,
          routeTableId: privateRouteTable.ref,
        });
        privateRoute.addResourceDependency(natGateway);
        privateRoutes.push(privateRoute);
      }
      privateSubnets.push(privateSubnet);
      privateRouteTables.push(privateRouteTable);
    }

    new ec2.CfnVPCEndpoint(this, "S3GatewayEndpoint", {
      serviceName: `com.amazonaws.${props.deploymentRegion}.s3`,
      vpcEndpointType: "Gateway",
      vpcId: vpc.ref,
      routeTableIds: privateRouteTables.map((routeTable) => routeTable.ref),
      ...(enterprise ? { policyDocument: endpointPolicyDocument("s3", props.deploymentRegion) } : {}),
    });

    const flowLogGroup = new logs.LogGroup(this, "VpcFlowLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      // Retained: flow logs are audit data that must outlive a stack deletion.
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const flowLogRole = new iam.Role(this, "VpcFlowLogRole", {
      assumedBy: new iam.ServicePrincipal("vpc-flow-logs.amazonaws.com"),
      description: "Delivers AgentX production VPC flow logs to CloudWatch Logs",
    });
    flowLogGroup.grantWrite(flowLogRole);
    new ec2.CfnFlowLog(this, "VpcFlowLog", {
      deliverLogsPermissionArn: flowLogRole.roleArn,
      logDestinationType: "cloud-watch-logs",
      logGroupName: flowLogGroup.logGroupName,
      maxAggregationInterval: 60,
      resourceId: vpc.ref,
      resourceType: "VPC",
      trafficType: "ALL",
    });

    const workspaceKey = new kms.Key(this, "WorkspaceKey", {
      alias: naming.workspaceKeyAlias,
      description: `Encrypts AgentX ${naming.environmentTagValue} root and per-session workspace EBS volumes`,
      enableKeyRotation: true,
      // Retained: retained workspace volumes and snapshots stay unreadable without this key.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Enterprise: AWS is reached through the install's own endpoints, and the security groups below let traffic out only to the VPC and the ranges the customer approved.
    if (enterprise) {
      new EnterpriseVpcEndpoints(this, "EnterpriseEndpoints", {
        vpcId: vpc.ref,
        vpcCidr: AGENTX_PRODUCTION_VPC_CIDR,
        ingressCidrs: privateCidrs,
        region: props.deploymentRegion,
        privateSubnets,
        privateRouteTables,
        resourcePrefix: naming.resourcePrefix,
        tags: (name) => resourceTags(name, naming),
      });
    }

    // The edition is recorded: an install's edition is set once, and `rovara deploy` refuses a redeploy that asks for another (`rovara deploy` will read this and call assertEditionUnchanged once wired).
    if (enterprise) {
      // Retained: deleting this stack, or a synth that no longer names the edition, must not delete the record. The broker and the sign-in server refuse to serve an install
      // whose stamp is missing or differs from it (review I-2).
      const record = new ssm.CfnParameter(this, "EditionRecord", { name: `/agentx/${naming.env!}/edition`, type: "String", value: "enterprise", description: "The edition this install was deployed as. It never changes." });
      record.cfnOptions.deletionPolicy = CfnDeletionPolicy.RETAIN;
      record.cfnOptions.updateReplacePolicy = CfnDeletionPolicy.RETAIN;
    }

    // EC2 worker launch template, role and security groups.
    new Ec2WorkerFoundation(this, "Ec2Workers", {
      naming,
      vpcId: vpc.ref,
      privateSubnets,
      workspaceKey,
      instanceType: configuration.instanceType,
      ...(enterprise ? { privateEgressCidrs: [AGENTX_PRODUCTION_VPC_CIDR, ...(props.enterpriseEgressCidrs ?? [])] } : {}),
    });

    // Cloud and Enterprise installs: agent machines (and the proxy, orchestrator and other tasks in this VPC) resolve only an allowlist.
    if ((props.cloud === true || enterprise) && naming.env !== undefined) {
      const dnsFirewall = new AgentDnsFirewall(this, "AgentDnsFirewall", {
        env: naming.env,
        vpcId: vpc.ref,
        // An Enterprise install starts from its own endpoint names; the public defaults are not on its list.
        // A Public install starts from the default list without its broad entries plus its own regional AWS hosts (DEFAULT-ALLOW-LIST-EXFIL, 0.5.15).
        baseAllowDomains: enterprise ? enterpriseAllowDomains(props.deploymentRegion, { stdioMcp: props.stdioMcpAllowDomains !== undefined }) : hostedAgentAllowDomains(props.deploymentRegion, Aws.ACCOUNT_ID),
        extraAllowDomains: [
          // The names an install with package-run servers needs (the ECS name is already in its base list).
          ...(enterprise ? (props.stdioMcpAllowDomains ?? []).filter((name) => !enterpriseAllowDomains(props.deploymentRegion, { stdioMcp: true }).includes(name)) : []),
          ...parseExtraAllowDomains(this.node.tryGetContext(EGRESS_ALLOW_DOMAINS_CONTEXT_KEY), enterprise ? enterpriseAllowDomains(props.deploymentRegion, { stdioMcp: props.stdioMcpAllowDomains !== undefined }) : hostedAgentAllowDomains(props.deploymentRegion, Aws.ACCOUNT_ID)),
        ],
      });
      // The control plane's broker keeps this list equal to the approved egress domains (it takes the id as a parameter, like the VPC's).
      new CfnOutput(this, "ProjectAllowListId", { value: dnsFirewall.projectAllowListId });
      new EgressAlarms(this, "EgressAlarms", {
        env: naming.env,
        resourcePrefix: naming.resourcePrefix,
        dnsFirewallLogGroup: dnsFirewall.logGroup,
        natGateways,
        alertsTopic: alertsTopicFromName(this, "OperatorAlerts", naming.alertsTopicName),
      });
    }

    new CfnOutput(this, "VpcId", { value: vpc.ref });
    new CfnOutput(this, "PrivateSubnetIds", {
      value: privateSubnets.map((subnet) => subnet.ref).join(","),
    });
    new CfnOutput(this, "WorkspaceKmsKeyArn", { value: workspaceKey.keyArn });
    new CfnOutput(this, "DeploymentMode", { value: AGENTX_PRODUCTION_DEPLOYMENT_MODE });
  }
}

function resourceTags(name: string, naming: AgentXNaming): CfnTag[] {
  return [
    { key: "Name", value: name },
    { key: "Application", value: "AgentX" },
    { key: "Environment", value: naming.environmentTagValue },
  ];
}
