// Enterprise foundations, task N1: the Enterprise edition's network, and proof that every other edition's network is the one it always was.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { environmentNaming } from "../../infra/lib/naming.js";
import { AGENTX_PRODUCTION_VPC_CIDR, ProductionFoundationStack, type ProductionFoundationStackProps } from "../../infra/lib/production-foundation.js";
import { ENTERPRISE_INTERFACE_ENDPOINT_SERVICES, MAX_ENTERPRISE_EGRESS_CIDRS, parseEditionContext, parseEnterpriseEgressCidrs, parseInternetEgress } from "../../infra/lib/vpc-endpoints.js";

type Resource = { Type: string; Properties: Record<string, unknown> };
type Egress = { CidrIp?: string; CidrIpv6?: string; FromPort?: number; ToPort?: number; IpProtocol?: string; DestinationSecurityGroupId?: unknown };

/** The foundation stack as the app builds it for a named environment (`env`), or the legacy deployment (no `env`). */
function foundation(options: Partial<ProductionFoundationStackProps> & { env?: string } = {}): Template {
  const { env, ...props } = options;
  return Template.fromStack(new ProductionFoundationStack(new App(), "TestFoundation", {
    deploymentRegion: "us-east-1", ...(env === undefined ? {} : { naming: environmentNaming(env) }), ...props,
  }));
}

const resourcesOf = (template: Template, type: string): Array<[string, Resource]> =>
  Object.entries(template.toJSON().Resources as Record<string, Resource>).filter(([, resource]) => resource.Type === type);

/** Every egress rule of every security group of the stack, by group name, from the groups' own rules and from standalone egress resources. */
function egressByGroup(template: Template): Map<string, Egress[]> {
  const groups = resourcesOf(template, "AWS::EC2::SecurityGroup");
  const byName = new Map<string, Egress[]>();
  const idToName = new Map<string, string>();
  for (const [id, group] of groups) {
    const name = String(group.Properties.GroupName);
    idToName.set(id, name);
    byName.set(name, [...((group.Properties.SecurityGroupEgress as Egress[] | undefined) ?? [])]);
  }
  for (const [, rule] of resourcesOf(template, "AWS::EC2::SecurityGroupEgress")) {
    const groupId = (rule.Properties.GroupId as { "Fn::GetAtt"?: [string, string] })["Fn::GetAtt"]?.[0];
    const name = groupId === undefined ? undefined : idToName.get(groupId);
    if (name !== undefined) byName.get(name)!.push(rule.Properties);
  }
  return byName;
}

const wholeInternet = (rule: Egress) => rule.CidrIp === "0.0.0.0/0" || rule.CidrIpv6 === "::/0";
const ENTERPRISE = { env: "ent", edition: "enterprise" } as const;

describe("the Enterprise edition's network", () => {
  const template = foundation(ENTERPRISE);
  const groups = egressByGroup(template);

  it("reaches AWS through an interface endpoint with private DNS for each service the install uses, S3 included", () => {
    const interfaces = resourcesOf(template, "AWS::EC2::VPCEndpoint").filter(([, endpoint]) => endpoint.Properties.VpcEndpointType === "Interface");
    const services = interfaces.map(([, endpoint]) => String(endpoint.Properties.ServiceName).replace("com.amazonaws.us-east-1.", "")).sort();
    expect(services).toEqual([...ENTERPRISE_INTERFACE_ENDPOINT_SERVICES, "s3"].sort());
    for (const [, endpoint] of interfaces) expect(endpoint.Properties.PrivateDnsEnabled).toBe(true);
    expect(services).toContain("bedrock-runtime");
    const gateways = resourcesOf(template, "AWS::EC2::VPCEndpoint").filter(([, endpoint]) => endpoint.Properties.VpcEndpointType === "Gateway");
    expect(gateways.map(([, endpoint]) => String(endpoint.Properties.ServiceName).replace("com.amazonaws.us-east-1.", "")).sort()).toEqual(["dynamodb", "s3"]);
  });

  it("puts the endpoints in the private subnets behind a group that takes HTTPS from the VPC only and starts nothing", () => {
    const endpointGroup = resourcesOf(template, "AWS::EC2::SecurityGroup").find(([, group]) => String(group.Properties.GroupName).endsWith("-vpc-endpoints"))!;
    expect(endpointGroup[1].Properties.SecurityGroupIngress).toEqual([expect.objectContaining({ CidrIp: AGENTX_PRODUCTION_VPC_CIDR, FromPort: 443, ToPort: 443, IpProtocol: "tcp" })]);
    const egress = endpointGroup[1].Properties.SecurityGroupEgress as Egress[];
    expect(egress).toHaveLength(1);
    expect(egress[0]!.CidrIp).toBe("255.255.255.255/32");
    for (const [, endpoint] of resourcesOf(template, "AWS::EC2::VPCEndpoint").filter(([, resource]) => resource.Properties.VpcEndpointType === "Interface")) {
      expect((endpoint.Properties.SubnetIds as unknown[]).length).toBe(2);
    }
  });

  it("lets no security group of the install send traffic to the whole internet", () => {
    expect(groups.size).toBeGreaterThanOrEqual(4);
    for (const [name, rules] of groups) {
      expect(rules.length, name).toBeGreaterThan(0);
      expect(rules.filter(wholeInternet), name).toEqual([]);
    }
  });

  it("lets the workers, the dispatcher and the session manager out over HTTPS to the VPC only (plus the dispatcher's own path to the workers)", () => {
    for (const [name, rules] of groups) {
      if (name.endsWith("-vpc-endpoints")) continue;
      const https = rules.filter((rule) => rule.IpProtocol === "tcp" && rule.FromPort === 443);
      expect(https.map((rule) => rule.CidrIp), name).toEqual([AGENTX_PRODUCTION_VPC_CIDR]);
      // Everything that is not HTTPS to the VPC is the one worker-port rule from a caller to the worker group.
      expect(rules.filter((rule) => !https.includes(rule)).every((rule) => rule.FromPort === 8080 && rule.DestinationSecurityGroupId !== undefined), name).toBe(true);
    }
  });

  it("turns the DNS firewall on, in allow-list mode, without the hosted-cloud setting", () => {
    expect(resourcesOf(template, "AWS::Route53Resolver::FirewallRuleGroup")).toHaveLength(1);
    const rules = (resourcesOf(template, "AWS::Route53Resolver::FirewallRuleGroup")[0]![1].Properties.FirewallRules as Array<{ Action: string; Priority: number }>).map((rule) => [rule.Priority, rule.Action]);
    expect(rules).toEqual([[100, "ALLOW"], [150, "ALLOW"], [200, "BLOCK"]]);
  });

  it("keeps the NAT gateways by default, and builds with no internet route at all when asked", () => {
    expect(resourcesOf(template, "AWS::EC2::NatGateway")).toHaveLength(2);
    const sealed = foundation({ ...ENTERPRISE, internetEgress: "none" });
    expect(resourcesOf(sealed, "AWS::EC2::NatGateway")).toHaveLength(0);
    expect(resourcesOf(sealed, "AWS::EC2::EIP")).toHaveLength(0);
    const routes = resourcesOf(sealed, "AWS::EC2::Route");
    // The only default routes left are the public subnets' routes to the internet gateway: no private subnet has a route out.
    expect(routes.every(([, route]) => route.Properties.NatGatewayId === undefined)).toBe(true);
    expect(routes.every(([id]) => id.startsWith("PublicDefaultRoute"))).toBe(true);
    expect(resourcesOf(sealed, "AWS::CloudWatch::Alarm").filter(([id]) => id.includes("Nat"))).toEqual([]);
    expect(resourcesOf(sealed, "AWS::EC2::VPCEndpoint").length).toBe(14);
  });

  it("allows the ranges the customer's network team approved, and only those", () => {
    const approved = foundation({ ...ENTERPRISE, enterpriseEgressCidrs: parseEnterpriseEgressCidrs("10.20.0.0/16, 172.16.5.0/24") });
    for (const [name, rules] of egressByGroup(approved)) {
      if (name.endsWith("-vpc-endpoints")) continue;
      const https = rules.filter((rule) => rule.IpProtocol === "tcp" && rule.FromPort === 443).map((rule) => rule.CidrIp);
      expect(https, name).toEqual([AGENTX_PRODUCTION_VPC_CIDR, "10.20.0.0/16", "172.16.5.0/24"]);
      expect(rules.filter(wholeInternet), name).toEqual([]);
    }
  });

  it("is refused, naming the setting, when the network settings are wrong", () => {
    // Even a range that got past the parser never reaches a security group.
    expect(() => foundation({ ...ENTERPRISE, enterpriseEgressCidrs: ["0.0.0.0/0"] })).toThrow(/whole internet/);
    expect(() => foundation({ edition: "enterprise" })).toThrow(/named environment/);
  });
});

describe("every other edition's network is unchanged", () => {
  it("is the same template with the edition set to public, for a hosted-cloud install and for the legacy deployment", () => {
    for (const base of [{ env: "staging", cloud: true }, { env: "staging" }, {}] as const) {
      const before = foundation(base).toJSON();
      const after = foundation({ ...base, edition: "public" }).toJSON();
      expect(after).toEqual(before);
    }
  });

  it("has no interface endpoint, a worker group that reaches the internet over HTTPS, and the NAT gateways", () => {
    const template = foundation({ env: "staging", cloud: true, edition: "public" });
    expect(resourcesOf(template, "AWS::EC2::VPCEndpoint")).toHaveLength(1);
    expect(resourcesOf(template, "AWS::EC2::NatGateway")).toHaveLength(2);
    const groups = egressByGroup(template);
    // The positive control for the Enterprise check above: this is what it would catch.
    expect([...groups.values()].some((rules) => rules.some(wholeInternet))).toBe(true);
  });

  it("runs the DNS firewall for the hosted cloud only (not for the legacy deployment, not for a plain named install)", () => {
    expect(resourcesOf(foundation({ env: "staging", edition: "public" }), "AWS::Route53Resolver::FirewallRuleGroup")).toHaveLength(0);
    expect(resourcesOf(foundation({ env: "staging", cloud: true, edition: "public" }), "AWS::Route53Resolver::FirewallRuleGroup")).toHaveLength(1);
  });

  it("refuses Enterprise network settings on any other edition, so a setting that would do nothing is never ignored", () => {
    expect(() => foundation({ env: "staging", edition: "public", enterpriseEgressCidrs: ["10.20.0.0/16"] })).toThrow(/Enterprise edition settings/);
    expect(() => foundation({ env: "staging", internetEgress: "none" })).toThrow(/Enterprise edition settings/);
  });
});

describe("the Enterprise network settings", () => {
  it("reads the edition from the CDK context exactly: enterprise or public, or nothing", () => {
    expect(parseEditionContext(undefined)).toBeUndefined();
    expect(parseEditionContext("enterprise")).toBe("enterprise");
    expect(parseEditionContext("public")).toBe("public");
    for (const bad of ["Enterprise", "cloud", "", " public", true, 1, null]) expect(() => parseEditionContext(bad), String(bad)).toThrow(/rovaraEdition/);
  });

  it("accepts specific ranges, trims and de-duplicates them", () => {
    expect(parseEnterpriseEgressCidrs(undefined)).toEqual([]);
    expect(parseEnterpriseEgressCidrs("")).toEqual([]);
    expect(parseEnterpriseEgressCidrs(" 10.20.0.0/16 ,172.16.5.0/24, 10.20.0.0/16")).toEqual(["10.20.0.0/16", "172.16.5.0/24"]);
    expect(parseEnterpriseEgressCidrs("10.0.0.0/8")).toEqual(["10.0.0.0/8"]);
  });

  it("refuses the whole internet, anything wider than a /8, a bad range, a non-string and too many", () => {
    for (const bad of ["0.0.0.0/0", "0.0.0.0/1", "10.0.0.0/7", "128.0.0.0/1", "300.1.1.1/16", "10.0.0.0/33", "10.0.0.0", "::/0", "10.0.0.0/16;drop", "example.com"]) {
      expect(() => parseEnterpriseEgressCidrs(bad), bad).toThrow(/rovaraEnterpriseEgressCidrs/);
    }
    expect(() => parseEnterpriseEgressCidrs(["10.0.0.0/16"])).toThrow(/rovaraEnterpriseEgressCidrs/);
    const many = Array.from({ length: MAX_ENTERPRISE_EGRESS_CIDRS + 1 }, (_, index) => `10.${String(index)}.0.0/16`).join(",");
    expect(() => parseEnterpriseEgressCidrs(many)).toThrow(/at most/);
  });

  it("reads the internet egress mode as nat unless it says none", () => {
    expect(parseInternetEgress(undefined)).toBe("nat");
    expect(parseInternetEgress("")).toBe("nat");
    expect(parseInternetEgress("none")).toBe("none");
    expect(() => parseInternetEgress("NONE")).toThrow(/rovaraEnterpriseInternetEgress/);
    expect(() => parseInternetEgress(false)).toThrow(/rovaraEnterpriseInternetEgress/);
  });
});
