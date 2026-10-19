import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { DEFAULT_AGENT_ALLOW_DOMAINS } from "../../infra/lib/agent-dns-firewall.js";
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

  it("creates no firewall resources without agentxCloud, in a named or legacy environment", () => {
    expect(firewallTypes(foundation({ agentxEnv: "staging" }))).toStrictEqual([]);
    expect(firewallTypes(foundation({}))).toStrictEqual([]);
    expect(firewallTypes(foundation({ agentxCloud: true }))).toStrictEqual([]);
    expect(firewallTypes(foundation({ agentxEnv: "staging", agentxEgressAllowDomains: "artifactory.acme.dev" }))).toStrictEqual([]);
  });
});
