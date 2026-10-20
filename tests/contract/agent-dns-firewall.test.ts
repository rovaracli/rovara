import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { DEFAULT_AGENT_ALLOW_DOMAINS, DNS_FIREWALL_ASSOCIATION_PRIORITY } from "../../infra/lib/agent-dns-firewall.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Properties: Record<string, unknown> };
type Rule = { Action: string; BlockResponse?: string; FirewallDomainListId: unknown; Priority: number };

function foundation(context: Record<string, unknown>): Template {
  const app = buildAgentXApp(context);
  const stack = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXProductionFoundation");
  return Template.fromStack(stack!);
}

const resourcesOf = (template: Template, type: string): Array<[string, Resource]> =>
  Object.entries(template.toJSON().Resources as Record<string, Resource>).filter(([, resource]) => resource.Type === type);
const firewallTypes = (template: Template): string[] =>
  Object.values(template.toJSON().Resources as Record<string, Resource>).map((resource) => resource.Type).filter((type) => type.startsWith("AWS::Route53Resolver::"));

function ruleGroup(template: Template): { allow: Rule; block: Rule; allowDomains: string[]; blockDomains: string[] } {
  const groups = resourcesOf(template, "AWS::Route53Resolver::FirewallRuleGroup");
  expect(groups).toHaveLength(1);
  const rules = groups[0]![1].Properties.FirewallRules as Rule[];
  expect(rules).toHaveLength(2);
  const allow = rules.find((rule) => rule.Priority === 100)!;
  const block = rules.find((rule) => rule.Priority === 200)!;
  const domainsOf = (rule: Rule): string[] => {
    const list = resourcesOf(template, "AWS::Route53Resolver::FirewallDomainList").find(([id]) => JSON.stringify(rule.FirewallDomainListId).includes(id));
    expect(list).toBeDefined();
    return list![1].Properties.Domains as string[];
  };
  return { allow, block, allowDomains: domainsOf(allow), blockDomains: domainsOf(block) };
}

describe("agent DNS firewall (cloud installs)", () => {
  const template = foundation({ agentxEnv: "staging", agentxCloud: true });

  it("allows the default list at priority 100 and blocks everything else with NXDOMAIN at priority 200", () => {
    const { allow, block, allowDomains, blockDomains } = ruleGroup(template);
    expect(allow).toMatchObject({ Action: "ALLOW", Priority: 100 });
    expect(block).toMatchObject({ Action: "BLOCK", BlockResponse: "NXDOMAIN", Priority: 200 });
    expect(allowDomains).toStrictEqual([...DEFAULT_AGENT_ALLOW_DOMAINS]);
    expect(blockDomains).toStrictEqual(["*"]);
  });

  it("keeps the binding default list, including what the model proxy and the Slack orchestrator in the same VPC need", () => {
    for (const domain of [
      "*.amazonaws.com", "*.aws", "github.com", "*.github.com", "*.githubusercontent.com", "ghcr.io", "*.ghcr.io",
      "registry.npmjs.org", "registry.yarnpkg.com", "pypi.org", "files.pythonhosted.org", "crates.io", "*.crates.io",
      "proxy.golang.org", "sum.golang.org", "repo.maven.apache.org", "repo1.maven.org", "rubygems.org", "*.rubygems.org",
      "deb.debian.org", "security.debian.org", "archive.ubuntu.com", "ports.ubuntu.com", "security.ubuntu.com", "dl-cdn.alpinelinux.org",
      "registry-1.docker.io", "auth.docker.io", "production.cloudflare.docker.com",
      "mcr.microsoft.com", "*.data.mcr.microsoft.com", "nodejs.org",
      "api.anthropic.com", "api.openai.com", "chatgpt.com", "auth.openai.com", "openrouter.ai",
      "slack.com", "*.slack.com", "api.linear.app", "mcp.linear.app", "*.atlassian.net", "app.asana.com",
    ]) expect(DEFAULT_AGENT_ALLOW_DOMAINS).toContain(domain);
    expect(DEFAULT_AGENT_ALLOW_DOMAINS).toHaveLength(new Set(DEFAULT_AGENT_ALLOW_DOMAINS).size);
  });

  it("associates the rule group with the install VPC", () => {
    const groups = resourcesOf(template, "AWS::Route53Resolver::FirewallRuleGroup");
    const associations = resourcesOf(template, "AWS::Route53Resolver::FirewallRuleGroupAssociation");
    expect(associations).toHaveLength(1);
    expect(associations[0]![1].Properties).toMatchObject({
      FirewallRuleGroupId: { "Fn::GetAtt": [groups[0]![0], "Id"] },
      VpcId: { Ref: resourcesOf(template, "AWS::EC2::VPC")[0]![0] },
    });
  });

  it("associates at a priority Resolver accepts: strictly between 100 and 9900 (RSLVR-02017), exactly 101", () => {
    const associations = resourcesOf(template, "AWS::Route53Resolver::FirewallRuleGroupAssociation");
    expect(associations).toHaveLength(1);
    const priority = associations[0]![1].Properties.Priority as number;
    expect(priority).toBe(101);
    expect(priority).toBeGreaterThan(100);
    expect(priority).toBeLessThan(9900);
    expect(DNS_FIREWALL_ASSOCIATION_PRIORITY).toBe(101);
  });

  it("gives the rules unique priorities, and only the BLOCK rule a BlockResponse", () => {
    const { allow, block } = ruleGroup(template);
    expect(allow.Priority).not.toBe(block.Priority);
    expect(allow).not.toHaveProperty("BlockResponse");
    expect(allow).not.toHaveProperty("BlockOverrideDomain");
    expect(allow).not.toHaveProperty("BlockOverrideDnsType");
    expect(allow).not.toHaveProperty("BlockOverrideTtl");
    expect(block).not.toHaveProperty("BlockOverrideDomain");
  });

  it("only writes domain specifications Resolver accepts: 1-255 characters, optional leading *, then letters, digits, hyphens and periods", () => {
    const { allowDomains, blockDomains } = ruleGroup(template);
    for (const domain of [...allowDomains, ...blockDomains]) {
      expect(domain.length).toBeGreaterThanOrEqual(1);
      expect(domain.length).toBeLessThanOrEqual(255);
      expect(domain).toMatch(/^\*?[A-Za-z0-9.-]*$/);
    }
    expect(new Set(allowDomains.map((domain) => domain.toLowerCase())).size).toBe(allowDomains.length);
  });

  it("keeps every Resolver name within 64 characters and the allowed characters for the longest environment name", () => {
    const longest = foundation({ agentxEnv: "staging-0123456789a", agentxCloud: true });
    const names = [
      ...resourcesOf(longest, "AWS::Route53Resolver::FirewallDomainList"),
      ...resourcesOf(longest, "AWS::Route53Resolver::FirewallRuleGroup"),
      ...resourcesOf(longest, "AWS::Route53Resolver::FirewallRuleGroupAssociation"),
      ...resourcesOf(longest, "AWS::Route53Resolver::ResolverQueryLoggingConfig"),
    ].map(([, resource]) => resource.Properties.Name as string);
    expect(names).toHaveLength(5);
    for (const name of names) {
      expect(name.length).toBeLessThanOrEqual(64);
      expect(name).toMatch(/^(?!^[0-9]+$)[a-zA-Z0-9\-_ ']+$/);
    }
  });

  it("logs every query to /agentx/<env>/dns-firewall, kept 30 days, and attaches the logging to the VPC", () => {
    const groups = resourcesOf(template, "AWS::Logs::LogGroup").filter(([, resource]) => resource.Properties.LogGroupName === "/agentx/staging/dns-firewall");
    expect(groups).toHaveLength(1);
    expect(groups[0]![1].Properties.RetentionInDays).toBe(30);
    const configs = resourcesOf(template, "AWS::Route53Resolver::ResolverQueryLoggingConfig");
    expect(configs).toHaveLength(1);
    expect(configs[0]![1].Properties.DestinationArn).toStrictEqual({ "Fn::GetAtt": [groups[0]![0], "Arn"] });
    const associations = resourcesOf(template, "AWS::Route53Resolver::ResolverQueryLoggingConfigAssociation");
    expect(associations).toHaveLength(1);
    expect(associations[0]![1].Properties).toMatchObject({
      ResolverQueryLogConfigId: { "Fn::GetAtt": [configs[0]![0], "Id"] },
      ResourceId: { Ref: resourcesOf(template, "AWS::EC2::VPC")[0]![0] },
    });
  });

  it("does not turn on fail-open, so a Resolver firewall fault fails closed", () => {
    expect(resourcesOf(template, "AWS::Route53Resolver::FirewallConfig")).toHaveLength(0);
  });

  it("adds the domains of the agentxEgressAllowDomains context to the allow list", () => {
    const extended = foundation({ agentxEnv: "staging", agentxCloud: true, agentxEgressAllowDomains: "artifactory.acme.dev, *.pkg.acme.dev,,github.com" });
    const { allowDomains } = ruleGroup(extended);
    expect(allowDomains).toStrictEqual([...DEFAULT_AGENT_ALLOW_DOMAINS, "artifactory.acme.dev", "*.pkg.acme.dev"]);
  });

  it("rejects an extra domain that is not a domain name", () => {
    expect(() => foundation({ agentxEnv: "staging", agentxCloud: true, agentxEgressAllowDomains: "https://artifactory.acme.dev/path" })).toThrow(/agentxEgressAllowDomains/);
  });

  it("rejects an extra domain longer than the 255 characters Resolver accepts", () => {
    const tooLong = `${Array.from({ length: 5 }, () => "a".repeat(60)).join(".")}.example.com`;
    expect(tooLong.length).toBeGreaterThan(255);
    expect(() => foundation({ agentxEnv: "staging", agentxCloud: true, agentxEgressAllowDomains: tooLong })).toThrow(/agentxEgressAllowDomains/);
  });

  it("creates no firewall resources without agentxCloud, in a named or legacy environment", () => {
    expect(firewallTypes(foundation({ agentxEnv: "staging" }))).toStrictEqual([]);
    expect(firewallTypes(foundation({}))).toStrictEqual([]);
    expect(firewallTypes(foundation({ agentxCloud: true }))).toStrictEqual([]);
    expect(firewallTypes(foundation({ agentxEnv: "staging", agentxEgressAllowDomains: "artifactory.acme.dev" }))).toStrictEqual([]);
  });
});
