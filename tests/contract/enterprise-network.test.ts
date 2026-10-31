// Enterprise foundations, task N1: the Enterprise edition's network, and proof that every other edition's network is the one it always was.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { App, Aspects } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { requireEnterpriseAuditTsa } from "../../infra/lib/audit-settings.js";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { EditionEnvironment } from "../../infra/lib/edition-env.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { SlackOrchestratorStack } from "../../infra/lib/slack-orchestrator.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { AGENTX_PRODUCTION_VPC_CIDR, ProductionFoundationStack, type ProductionFoundationStackProps } from "../../infra/lib/production-foundation.js";
import { DEFAULT_AGENT_ALLOW_DOMAINS } from "../../infra/lib/agent-dns-firewall.js";
import { ENTERPRISE_INTERFACE_ENDPOINT_SERVICES, MAX_ENTERPRISE_EGRESS_CIDRS, enterpriseAllowDomains, parseEditionContext, parseEnterpriseEgressCidrs, parseInternetEgress } from "../../infra/lib/vpc-endpoints.js";

skipLambdaBundling();
// A named control plane packages the web app's built assets. These tests read the template only, so when no web build is present an empty folder stands in
// (the folder is build output and ignored by git).
if (!existsSync("packages/web/dist/app/assets")) mkdirSync("packages/web/dist/app/assets", { recursive: true });
const VPC = AGENTX_PRODUCTION_VPC_CIDR;
const APPROVED = "10.99.0.0/16";
const BASE_TEMPLATES = JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", "enterprise-foundation-base-templates.json"), "utf8")) as Record<string, unknown>;

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
const ENTERPRISE = { env: "ent", edition: "enterprise", enterpriseEgressCidrs: [APPROVED] } as const;

describe("the Enterprise edition's network", () => {
  const template = foundation(ENTERPRISE);
  const groups = egressByGroup(template);

  it("reaches AWS through an interface endpoint with private DNS for each service the install uses, S3 included", () => {
    const interfaces = resourcesOf(template, "AWS::EC2::VPCEndpoint").filter(([, endpoint]) => endpoint.Properties.VpcEndpointType === "Interface");
    const services = interfaces.map(([, endpoint]) => String(endpoint.Properties.ServiceName).replace("com.amazonaws.us-east-1.", "")).sort();
    expect(services).toEqual([...ENTERPRISE_INTERFACE_ENDPOINT_SERVICES, "s3"].sort());
    for (const [, endpoint] of interfaces) expect(endpoint.Properties.PrivateDnsEnabled).toBe(true);
    expect(services).toEqual(expect.arrayContaining(["bedrock-runtime", "bedrock", "monitoring"]));
    const gateways = resourcesOf(template, "AWS::EC2::VPCEndpoint").filter(([, endpoint]) => endpoint.Properties.VpcEndpointType === "Gateway");
    expect(gateways.map(([, endpoint]) => String(endpoint.Properties.ServiceName).replace("com.amazonaws.us-east-1.", "")).sort()).toEqual(["dynamodb", "s3"]);
  });

  it("puts the endpoints in the private subnets behind a group that takes HTTPS from the private subnets only (not the whole VPC) and starts nothing", () => {
    const endpointGroup = resourcesOf(template, "AWS::EC2::SecurityGroup").find(([, group]) => String(group.Properties.GroupName).endsWith("-vpc-endpoints"))!;
    const ingress = endpointGroup[1].Properties.SecurityGroupIngress as Array<{ CidrIp: string; FromPort: number; ToPort: number; IpProtocol: string }>;
    expect(ingress.map((rule) => rule.CidrIp).sort()).toEqual(["10.42.128.0/20", "10.42.144.0/20"]);
    for (const rule of ingress) expect(rule).toMatchObject({ FromPort: 443, ToPort: 443, IpProtocol: "tcp" });
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

  it("lets the workers, the dispatcher and the session manager out over HTTPS to the VPC and the approved range only (plus the dispatcher's own path to the workers)", () => {
    for (const [name, rules] of groups) {
      if (name.endsWith("-vpc-endpoints")) continue;
      const https = rules.filter((rule) => rule.IpProtocol === "tcp" && rule.FromPort === 443);
      expect(https.map((rule) => rule.CidrIp), name).toEqual([VPC, APPROVED]);
      // Everything that is not HTTPS to the VPC is the one worker-port rule from a caller to the worker group.
      expect(rules.filter((rule) => !https.includes(rule)).every((rule) => rule.FromPort === 8080 && rule.DestinationSecurityGroupId !== undefined), name).toBe(true);
    }
  });

  it("turns the DNS firewall on, in allow-list mode, without the hosted-cloud setting", () => {
    expect(resourcesOf(template, "AWS::Route53Resolver::FirewallRuleGroup")).toHaveLength(1);
    const rules = (resourcesOf(template, "AWS::Route53Resolver::FirewallRuleGroup")[0]![1].Properties.FirewallRules as Array<{ Action: string; Priority: number }>).map((rule) => [rule.Priority, rule.Action]);
    expect(rules).toEqual([[100, "ALLOW"], [150, "ALLOW"], [200, "BLOCK"]]);
  });

  it("starts the allow-list from the install's own endpoint names: none of the public defaults is on it", () => {
    const lists = resourcesOf(template, "AWS::Route53Resolver::FirewallDomainList").map(([, list]) => list.Properties as { Name: string; Domains?: string[] });
    const allow = lists.find((list) => list.Name.endsWith("-allow"))!;
    expect(allow.Domains).toEqual(enterpriseAllowDomains("us-east-1"));
    for (const domain of DEFAULT_AGENT_ALLOW_DOMAINS) expect(allow.Domains, domain).not.toContain(domain);
    for (const forbidden of ["*.amazonaws.com", "github.com", "registry.npmjs.org", "pypi.org", "api.anthropic.com", "api.openai.com", "openrouter.ai", "slack.com", "*.atlassian.net", "nodejs.org"]) {
      expect(allow.Domains, forbidden).not.toContain(forbidden);
    }
    expect(allow.Domains).toEqual(expect.arrayContaining(["bedrock-runtime.us-east-1.amazonaws.com", "api.ecr.us-east-1.amazonaws.com", "*.dkr.ecr.us-east-1.amazonaws.com", "s3.us-east-1.amazonaws.com", "*.elb.us-east-1.amazonaws.com"]));
    // The positive control: a hosted install still gets the public defaults.
    const cloud = foundation({ env: "staging", cloud: true });
    const cloudAllow = resourcesOf(cloud, "AWS::Route53Resolver::FirewallDomainList").map(([, list]) => list.Properties as { Name: string; Domains?: string[] }).find((list) => list.Name.endsWith("-allow"))!;
    expect(cloudAllow.Domains).toContain("github.com");
  });

  it("builds with no internet route by default, and keeps the NAT gateways only when asked", () => {
    expect(resourcesOf(template, "AWS::EC2::NatGateway")).toHaveLength(0);
    expect(resourcesOf(template, "AWS::EC2::EIP")).toHaveLength(0);
    const routes = resourcesOf(template, "AWS::EC2::Route");
    // The only default routes left are the public subnets' routes to the internet gateway: no private subnet has a route out.
    expect(routes.every(([, route]) => route.Properties.NatGatewayId === undefined)).toBe(true);
    expect(routes.every(([id]) => id.startsWith("PublicDefaultRoute"))).toBe(true);
    expect(resourcesOf(template, "AWS::CloudWatch::Alarm").filter(([id]) => id.includes("Nat"))).toEqual([]);
    const withNat = foundation({ ...ENTERPRISE, internetEgress: "nat" });
    expect(resourcesOf(withNat, "AWS::EC2::NatGateway")).toHaveLength(2);
  });

  it("refuses an install with no internet route and no approved range, because the workers could not reach the control plane", () => {
    expect(() => foundation({ env: "ent", edition: "enterprise" })).toThrow(/at least one approved range/);
    expect(() => foundation({ env: "ent", edition: "enterprise", internetEgress: "none" })).toThrow(/at least one approved range/);
    expect(() => foundation({ env: "ent", edition: "enterprise", internetEgress: "nat" })).not.toThrow();
  });

  it("gives every endpoint a policy that admits only this account's principals, and S3 and DynamoDB only this account's resources", () => {
    const endpoints = resourcesOf(template, "AWS::EC2::VPCEndpoint");
    expect(endpoints).toHaveLength(ENTERPRISE_INTERFACE_ENDPOINT_SERVICES.length + 3);
    for (const [id, endpoint] of endpoints) {
      const policy = endpoint.Properties.PolicyDocument as { Statement: Array<{ Effect: string; Principal: string; Condition: { StringEquals: Record<string, unknown> } }> };
      expect(policy, id).toBeDefined();
      const account = { Ref: "AWS::AccountId" };
      const first = policy.Statement[0]!;
      expect(first.Effect).toBe("Allow");
      expect(first.Condition.StringEquals["aws:PrincipalAccount"], id).toEqual(account);
      const service = String(endpoint.Properties.ServiceName).replace("com.amazonaws.us-east-1.", "");
      if (service === "s3" || service === "dynamodb") expect(first.Condition.StringEquals["aws:ResourceAccount"], id).toEqual(account);
      // Every other statement is bound to this account's principals too, and the only one that names another account's bucket is the S3 read of image layers and packages.
      for (const statement of policy.Statement) expect(statement.Condition.StringEquals["aws:PrincipalAccount"], id).toEqual(account);
      if (service === "s3") expect(JSON.stringify(policy.Statement[1])).toMatch(/starport-layer-bucket[\s\S]*al2023-repos/);
      else expect(policy.Statement, id).toHaveLength(1);
    }
    // The existing S3 gateway endpoint of the foundation carries the policy too in Enterprise.
    const gateway = endpoints.filter(([, endpoint]) => endpoint.Properties.VpcEndpointType === "Gateway");
    expect(gateway).toHaveLength(2);
    // The positive control: the hosted install's S3 gateway endpoint has no policy.
    const hosted = resourcesOf(foundation({ env: "staging", cloud: true }), "AWS::EC2::VPCEndpoint");
    expect(hosted[0]![1].Properties.PolicyDocument).toBeUndefined();
  });

  it("records the edition, so a redeploy as another edition can be refused", () => {
    const parameter = resourcesOf(template, "AWS::SSM::Parameter");
    expect(parameter.map(([, resource]) => [resource.Properties.Name, resource.Properties.Value])).toEqual([["/agentx/ent/edition", "enterprise"]]);
    expect(resourcesOf(foundation({ env: "staging", cloud: true }), "AWS::SSM::Parameter")).toEqual([]);
  });

  it("has no IPv6 egress rule anywhere in the foundation's groups", () => {
    for (const [name, rules] of groups) expect(rules.filter((rule) => rule.CidrIpv6 !== undefined), name).toEqual([]);
  });

  it("allows the ranges the customer's network team approved, and only those", () => {
    const approved = foundation({ ...ENTERPRISE, enterpriseEgressCidrs: parseEnterpriseEgressCidrs("10.20.0.0/16, 172.16.5.0/24") });
    for (const [name, rules] of egressByGroup(approved)) {
      if (name.endsWith("-vpc-endpoints")) continue;
      const https = rules.filter((rule) => rule.IpProtocol === "tcp" && rule.FromPort === 443).map((rule) => rule.CidrIp);
      expect(https, name).toEqual([VPC, "10.20.0.0/16", "172.16.5.0/24"]);
      expect(rules.filter(wholeInternet), name).toEqual([]);
    }
  });

  it("is refused, naming the setting, when the network settings are wrong", () => {
    // Even a range that got past the parser never reaches a security group.
    expect(() => foundation({ ...ENTERPRISE, enterpriseEgressCidrs: ["0.0.0.0/0"] })).toThrow(/whole internet/);
    expect(() => foundation({ edition: "enterprise", enterpriseEgressCidrs: [APPROVED] })).toThrow(/named environment/);
  });
});

describe("every other edition's network is unchanged", () => {
  it("is the template the base commit fd7cd3c35 produced, for a hosted-cloud install, a named install and the legacy deployment, with or without the edition set to public", () => {
    for (const [name, base] of [["cloud", { env: "staging", cloud: true }], ["named", { env: "staging" }], ["legacy", {}]] as const) {
      expect(foundation(base).toJSON(), name).toEqual(BASE_TEMPLATES[name]);
      expect(foundation({ ...base, edition: "public" }).toJSON(), `${name} (public)`).toEqual(BASE_TEMPLATES[name]);
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

describe("every stack of an Enterprise install", () => {
  const cidrs = [VPC, APPROVED];
  const stacks = () => {
    const app = new App();
    const naming = environmentNaming("ent");
    const control = new ControlPlaneStack(app, "ControlPlane", { naming, privateEgressCidrs: cidrs });
    const slack = new SlackOrchestratorStack(app, "Slack", { naming, privateEgressCidrs: cidrs });
    return { app, control: Template.fromStack(control), slack: Template.fromStack(slack) };
  };
  const { control, slack } = stacks();

  it("has no security group, in the control plane (model proxy, model access) or the Slack orchestrator, that sends traffic to the whole internet", () => {
    for (const [stackName, template] of [["control plane", control], ["slack", slack]] as const) {
      const groups = egressByGroup(template);
      expect(groups.size, stackName).toBeGreaterThan(0);
      for (const [, rules] of groups) expect(rules.filter(wholeInternet), stackName).toEqual([]);
      expect(JSON.stringify(template.toJSON())).not.toContain('"CidrIp":"0.0.0.0/0"');
    }
  });

  it("is open without the setting (positive control), so the check above can tell", () => {
    const app = new App();
    const open = Template.fromStack(new ControlPlaneStack(app, "OpenControlPlane", { naming: environmentNaming("ent") }));
    expect(JSON.stringify(open.toJSON())).toContain('"CidrIp":"0.0.0.0/0"');
  });

  it("records the known gap: the broker's own Lambda functions are not in the VPC, so no security group, DNS firewall or flow log applies to them (follow-up in the fix-round report)", () => {
    const functions = Object.entries(control.findResources("AWS::Lambda::Function")) as Array<[string, { Properties: { VpcConfig?: unknown } }]>;
    // The model access function is the one VPC-attached hop. When the broker moves in, this changes and the test is updated with the design.
    expect(functions.filter(([id]) => /^ModelAccess/.test(id)).every(([, fn]) => fn.Properties.VpcConfig !== undefined)).toBe(true);
    const broker = functions.filter(([id]) => /^Broker/.test(id));
    expect(broker.length).toBeGreaterThan(0);
    expect(broker.every(([, fn]) => fn.Properties.VpcConfig === undefined)).toBe(true);
  });

  it("carries ROVARA_EDITION on every application function and every container of every task, set by one aspect and never guessed at run time", () => {
    const app = new App();
    const naming = environmentNaming("ent");
    const controlStack = new ControlPlaneStack(app, "ControlPlane", { naming, privateEgressCidrs: cidrs });
    const slackStack = new SlackOrchestratorStack(app, "Slack", { naming, privateEgressCidrs: cidrs });
    Aspects.of(app).add(new EditionEnvironment("enterprise"));
    for (const [name, stack] of [["control plane", controlStack], ["slack", slackStack]] as const) {
      const template = Template.fromStack(stack);
      const functions = Object.entries(template.findResources("AWS::Lambda::Function")) as Array<[string, { Properties: { Environment?: { Variables?: Record<string, unknown> } } }]>;
      for (const [id, fn] of functions) expect(fn.Properties.Environment?.Variables?.ROVARA_EDITION, `${name} ${id}`).toBe("enterprise");
      const tasks = Object.entries(template.findResources("AWS::ECS::TaskDefinition")) as Array<[string, { Properties: { ContainerDefinitions: Array<{ Environment?: Array<{ Name: string; Value: string }> }> } }]>;
      for (const [id, task] of tasks) for (const container of task.Properties.ContainerDefinitions) expect(container.Environment?.find((entry) => entry.Name === "ROVARA_EDITION")?.Value, `${name} ${id}`).toBe("enterprise");
      if (name === "control plane") expect(tasks.length).toBeGreaterThan(0);
    }
    // The broker's variables are held to Lambda's 4 KB: the edition must not push them over.
    const broker = Object.values(Template.fromStack(controlStack).findResources("AWS::Lambda::Function")) as Array<{ Properties: { Environment?: { Variables?: Record<string, unknown> } } }>;
    for (const fn of broker) expect(Buffer.byteLength(JSON.stringify(fn.Properties.Environment?.Variables ?? {}))).toBeLessThan(4_096);
  });
});

describe("the audit anchor of an Enterprise install", () => {
  it("is refused on the public timestamp authorities, unset or explicit; custom and off are accepted", () => {
    expect(() => requireEnterpriseAuditTsa(undefined)).toThrow(/public timestamp authorities/);
    expect(() => requireEnterpriseAuditTsa("public")).toThrow(/agentxAuditTsa/);
    expect(() => requireEnterpriseAuditTsa("")).toThrow();
    expect(() => requireEnterpriseAuditTsa("custom")).not.toThrow();
    expect(() => requireEnterpriseAuditTsa("off")).not.toThrow();
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
    expect(parseEnterpriseEgressCidrs("172.16.0.0/12, 192.168.4.0/24, 100.64.0.0/10")).toEqual(["172.16.0.0/12", "192.168.4.0/24", "100.64.0.0/10"]);
  });

  it("requires a private range, unless a public one is asked for in so many words", () => {
    for (const publicRange of ["52.0.0.0/8", "3.120.0.0/14", "172.32.0.0/16", "11.0.0.0/8", "192.169.0.0/16", "100.128.0.0/10", "8.8.8.8/32"]) {
      expect(() => parseEnterpriseEgressCidrs(publicRange), publicRange).toThrow(/not a private range/);
      expect(parseEnterpriseEgressCidrs(publicRange, { allowPublicRanges: true })).toEqual([publicRange]);
    }
    // A range that only starts in private space but reaches out of it is not private: 10.0.0.0/7 is also refused as too wide.
    expect(() => parseEnterpriseEgressCidrs("172.16.0.0/11")).toThrow();
  });

  it("refuses the whole internet, anything wider than a /8, a bad range, a non-string and too many", () => {
    for (const bad of ["0.0.0.0/0", "0.0.0.0/1", "10.0.0.0/7", "128.0.0.0/1", "300.1.1.1/16", "10.0.0.0/33", "10.0.0.0", "::/0", "10.0.0.0/16;drop", "example.com"]) {
      expect(() => parseEnterpriseEgressCidrs(bad), bad).toThrow(/rovaraEnterpriseEgressCidrs/);
      expect(() => parseEnterpriseEgressCidrs(bad, { allowPublicRanges: true }), `${bad} (public allowed)`).toThrow(/rovaraEnterpriseEgressCidrs/);
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
