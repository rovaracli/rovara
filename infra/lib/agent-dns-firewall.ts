import { RemovalPolicy, aws_logs as logs, aws_route53resolver as resolver } from "aws-cdk-lib";
import { Construct } from "constructs";

/**
 * The websites the machines in a cloud install may resolve by default: AWS, GitHub, package
 * registries, OS package mirrors, Docker registries, the AI providers, and Slack and the connector
 * hosts. Everything else gets NXDOMAIN. A wildcard entry matches subdomains only, not the bare domain.
 */
export const DEFAULT_AGENT_ALLOW_DOMAINS: readonly string[] = [
  // AWS services
  "*.amazonaws.com", "*.aws",
  // GitHub (the model proxy image comes from ghcr.io, whose blobs come from *.githubusercontent.com)
  "github.com", "*.github.com", "*.githubusercontent.com", "ghcr.io", "*.ghcr.io",
  // Package registries: npm and Yarn, Python, Rust, Go, Java, Ruby
  "registry.npmjs.org", "registry.yarnpkg.com",
  "pypi.org", "files.pythonhosted.org",
  "crates.io", "*.crates.io",
  "proxy.golang.org", "sum.golang.org",
  "repo.maven.apache.org", "repo1.maven.org",
  "rubygems.org", "*.rubygems.org",
  // OS package mirrors: Debian, Ubuntu, Alpine
  "deb.debian.org", "security.debian.org",
  "archive.ubuntu.com", "ports.ubuntu.com", "security.ubuntu.com",
  "dl-cdn.alpinelinux.org",
  // Docker images
  "registry-1.docker.io", "auth.docker.io", "production.cloudflare.docker.com",
  // AI providers (model proxy, ChatGPT plans)
  "api.anthropic.com", "api.openai.com", "chatgpt.com", "auth.openai.com", "openrouter.ai",
  // Slack and connectors
  "slack.com", "*.slack.com", "api.linear.app", "mcp.linear.app", "*.atlassian.net", "app.asana.com",
];

/** The CDK context key holding extra allowed domains, comma separated (for example an internal package registry). */
export const EGRESS_ALLOW_DOMAINS_CONTEXT_KEY = "agentxEgressAllowDomains";

const DOMAIN_PATTERN = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/i;

/** The extra domains from a context value: trimmed, validated, without blanks or duplicates of `existing`. */
export function parseExtraAllowDomains(value: unknown, existing: readonly string[] = DEFAULT_AGENT_ALLOW_DOMAINS): string[] {
  if (value === undefined || value === "") return [];
  if (typeof value !== "string") throw new Error(`${EGRESS_ALLOW_DOMAINS_CONTEXT_KEY} must be a comma-separated string of domain names`);
  const seen = new Set(existing.map((domain) => domain.toLowerCase()));
  const extra: string[] = [];
  for (const entry of value.split(",").map((part) => part.trim()).filter((part) => part !== "")) {
    if (!DOMAIN_PATTERN.test(entry)) {
      throw new Error(`${EGRESS_ALLOW_DOMAINS_CONTEXT_KEY} entry ${JSON.stringify(entry)} is not a domain name; use a name such as artifactory.example.com or *.example.com, without a scheme or path`);
    }
    if (seen.has(entry.toLowerCase())) continue;
    seen.add(entry.toLowerCase());
    extra.push(entry);
  }
  return extra;
}

export interface AgentDnsFirewallProps {
  /** The install, for the query log group name /agentx/<env>/dns-firewall. */
  env: string;
  vpcId: string;
  /** Allowed in addition to DEFAULT_AGENT_ALLOW_DOMAINS. */
  extraAllowDomains?: readonly string[];
}

/**
 * A Route 53 Resolver DNS Firewall for the install VPC, so agent machines resolve only an allowlist of
 * websites. Rule group, in order: priority 100 ALLOW the domain list, priority 200 BLOCK `*` with
 * NXDOMAIN. Every query is logged to /agentx/<env>/dns-firewall (30 days).
 *
 * It governs the whole VPC, not only the workers: the model proxy, the ModelAccessFunction and the
 * Slack orchestrator resolve through it too, so a host any of them needs must be on the allowlist.
 *
 * Fail closed: no FirewallConfig is created, so FirewallFailOpen keeps the AWS default, DISABLED. If
 * the firewall cannot evaluate a query, the query fails instead of being let through. That favours
 * containment over availability.
 *
 * Known limit: DNS filtering does not stop a connection made straight to an IP address. The
 * per-project egress proxy that closes this comes after launch (spec 002, Network boundary).
 */
export class AgentDnsFirewall extends Construct {
  /** The query log group; Task 18 builds a metric filter on it. */
  readonly logGroup: logs.LogGroup;
  readonly ruleGroup: resolver.CfnFirewallRuleGroup;
  readonly allowDomains: readonly string[];

  constructor(scope: Construct, id: string, props: AgentDnsFirewallProps) {
    super(scope, id);
    this.allowDomains = [...DEFAULT_AGENT_ALLOW_DOMAINS, ...(props.extraAllowDomains ?? [])];

    const allowList = new resolver.CfnFirewallDomainList(this, "AllowList", {
      name: `agentx-${props.env}-allow`,
      domains: [...this.allowDomains],
    });
    const blockList = new resolver.CfnFirewallDomainList(this, "BlockAllList", {
      name: `agentx-${props.env}-block-all`,
      domains: ["*"],
    });
    this.ruleGroup = new resolver.CfnFirewallRuleGroup(this, "RuleGroup", {
      name: `agentx-${props.env}-agents`,
      firewallRules: [
        { action: "ALLOW", priority: 100, firewallDomainListId: allowList.attrId },
        { action: "BLOCK", blockResponse: "NXDOMAIN", priority: 200, firewallDomainListId: blockList.attrId },
      ],
    });
    new resolver.CfnFirewallRuleGroupAssociation(this, "Association", {
      firewallRuleGroupId: this.ruleGroup.attrId,
      vpcId: props.vpcId,
      priority: 100,
      name: `agentx-${props.env}-agents`,
    });

    this.logGroup = new logs.LogGroup(this, "QueryLogs", {
      logGroupName: `/agentx/${props.env}/dns-firewall`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const queryLogging = new resolver.CfnResolverQueryLoggingConfig(this, "QueryLogging", {
      name: `agentx-${props.env}-dns-firewall`,
      destinationArn: this.logGroup.logGroupArn,
    });
    new resolver.CfnResolverQueryLoggingConfigAssociation(this, "QueryLoggingAssociation", {
      resolverQueryLogConfigId: queryLogging.attrId,
      resourceId: props.vpcId,
    });
  }
}
