import { RemovalPolicy, aws_logs as logs, aws_route53resolver as resolver } from "aws-cdk-lib";
import { Construct } from "constructs";
import { DEFAULT_AGENT_ALLOW_DOMAINS } from "@rovara-code/contracts";
import {
  BEDROCK_SOURCE_REGIONS, BROAD_ALLOWED_DOMAIN_MESSAGE, BROAD_DEFAULT_ALLOW_ENTRIES, HOSTED_AWS_HOSTS, NAMED_IN_PLACE_OF_BROAD_ENTRIES, hostedAgentAllowDomains, hostedAwsAllowDomains, isBroadAllowedDomain, narrowedDefaultAllowDomains,
} from "@agentx/cloud-contracts";

export { DEFAULT_AGENT_ALLOW_DOMAINS };

// The hosted install's list is built in @agentx/cloud-contracts (hosted-allow-domains.ts), where the broker reads it too; re-exported here for the stack and its tests.
export {
  BEDROCK_SOURCE_REGIONS, BROAD_DEFAULT_ALLOW_ENTRIES, HOSTED_AWS_HOSTS, NAMED_IN_PLACE_OF_BROAD_ENTRIES, hostedAgentAllowDomains, hostedAwsAllowDomains, narrowedDefaultAllowDomains,
};

/** The CDK context key holding extra allowed domains, comma separated (for example an internal package registry). */
export const EGRESS_ALLOW_DOMAINS_CONTEXT_KEY = "agentxEgressAllowDomains";

/**
 * The priority of the rule group's association with the VPC. This is a different scale from the rule
 * priorities inside the group (100, 150 and 200). Resolver rejects 100 and 9900 as reserved: "[RSLVR-02017]
 * The priority value you provided is reserved. Provide a number between "100" and "9900"", with both
 * bounds exclusive, so a valid association priority is 101..9899.
 */
export const DNS_FIREWALL_ASSOCIATION_PRIORITY = 101;

/** Resolver accepts a domain specification of 1-255 characters (documented in "Managing your own domain lists"). */
const MAX_DOMAIN_LENGTH = 255;

const DOMAIN_PATTERN = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/i;

/** The extra domains from a context value: trimmed, validated, without blanks or duplicates of `existing`. */
export function parseExtraAllowDomains(value: unknown, existing: readonly string[] = narrowedDefaultAllowDomains()): string[] {
  if (value === undefined || value === "") return [];
  if (typeof value !== "string") throw new Error(`${EGRESS_ALLOW_DOMAINS_CONTEXT_KEY} must be a comma-separated string of domain names`);
  const seen = new Set(existing.map((domain) => domain.toLowerCase()));
  const extra: string[] = [];
  for (const entry of value.split(",").map((part) => part.trim()).filter((part) => part !== "")) {
    if (entry.length > MAX_DOMAIN_LENGTH || !DOMAIN_PATTERN.test(entry)) {
      throw new Error(`${EGRESS_ALLOW_DOMAINS_CONTEXT_KEY} entry ${JSON.stringify(entry)} is not a domain name of at most ${MAX_DOMAIN_LENGTH} characters; use a name such as artifactory.example.com or *.example.com, without a scheme or path`);
    }
    // One operator entry is cell-wide too: a wildcard over AWS or GitHub names would reopen what the default list closed.
    if (isBroadAllowedDomain(entry)) throw new Error(`${EGRESS_ALLOW_DOMAINS_CONTEXT_KEY} entry ${JSON.stringify(entry)}: ${BROAD_ALLOWED_DOMAIN_MESSAGE}`);
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
  /** Allowed in addition to the base list. */
  extraAllowDomains?: readonly string[];
  /**
   * The base allow-list. Default: the default list without its broad entries (`narrowedDefaultAllowDomains`); a hosted install passes `hostedAgentAllowDomains(region)`, which adds its own AWS hosts. An Enterprise install
   * passes its own short list (infra/lib/vpc-endpoints.ts) and the public defaults are not on it.
   */
  baseAllowDomains?: readonly string[];
}

/**
 * A Route 53 Resolver DNS Firewall for the install VPC, so agent machines resolve only an allowlist of
 * websites. Rule group, in order: priority 100 ALLOW the default domain list, priority 150 ALLOW the
 * project list, priority 200 BLOCK `*` with NXDOMAIN. Every query is logged to
 * /agentx/<env>/dns-firewall (30 days).
 *
 * The project list holds the domains Rovara staff approved for projects (and, in Plan 3, model
 * sources): one cell-wide union, which the broker keeps equal to the approved egress items with
 * UpdateFirewallDomains (packages/broker/src/aws/egress-domains-sync.ts). It is declared with no
 * `domains` property on purpose: the template never owns its contents, so a stack update cannot
 * reset them to empty. Scoping each workspace to its own project's additions needs the per-project
 * egress proxy, which comes after launch.
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
  /** The id of the project list (rule priority 150), for the control plane's broker. */
  readonly projectAllowListId: string;
  readonly allowDomains: readonly string[];

  constructor(scope: Construct, id: string, props: AgentDnsFirewallProps) {
    super(scope, id);
    this.allowDomains = [...(props.baseAllowDomains ?? narrowedDefaultAllowDomains()), ...(props.extraAllowDomains ?? [])];

    const allowList = new resolver.CfnFirewallDomainList(this, "AllowList", {
      name: `agentx-${props.env}-allow`,
      domains: [...this.allowDomains],
    });
    // No `domains`: the broker owns the contents (see above).
    const projectAllowList = new resolver.CfnFirewallDomainList(this, "ProjectAllowList", {
      name: `agentx-${props.env}-project-allow`,
    });
    this.projectAllowListId = projectAllowList.attrId;
    const blockList = new resolver.CfnFirewallDomainList(this, "BlockAllList", {
      name: `agentx-${props.env}-block-all`,
      domains: ["*"],
    });
    this.ruleGroup = new resolver.CfnFirewallRuleGroup(this, "RuleGroup", {
      name: `agentx-${props.env}-agents`,
      firewallRules: [
        // An allowed name may CNAME to a CDN name not on the list (auth.docker.io -> *.cdn.cloudflare.net, found live
        // on staging); trust the chain only for names this rule already allowed. Everything else still meets BLOCK.
        { action: "ALLOW", priority: 100, firewallDomainListId: allowList.attrId, firewallDomainRedirectionAction: "TRUST_REDIRECTION_DOMAIN" },
        // The same trust for the names staff approved (ruling R59): an approved name may CNAME to a CDN name that is not on any list.
        { action: "ALLOW", priority: 150, firewallDomainListId: projectAllowList.attrId, firewallDomainRedirectionAction: "TRUST_REDIRECTION_DOMAIN" },
        { action: "BLOCK", blockResponse: "NXDOMAIN", priority: 200, firewallDomainListId: blockList.attrId },
      ],
    });
    new resolver.CfnFirewallRuleGroupAssociation(this, "Association", {
      firewallRuleGroupId: this.ruleGroup.attrId,
      vpcId: props.vpcId,
      priority: DNS_FIREWALL_ASSOCIATION_PRIORITY,
      name: `agentx-${props.env}-agents`,
    });

    this.logGroup = new logs.LogGroup(this, "QueryLogs", {
      logGroupName: `/agentx/${props.env}/dns-firewall`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const queryLogging = new resolver.CfnResolverQueryLoggingConfig(this, "QueryLogging", {
      name: `agentx-${props.env}-dns-firewall`,
      // The log group ARN with its trailing ":*" is the form the Resolver CreateResolverQueryLogConfig
      // documentation gives for a CloudWatch Logs destination, so it is passed as it comes.
      destinationArn: this.logGroup.logGroupArn,
    });
    new resolver.CfnResolverQueryLoggingConfigAssociation(this, "QueryLoggingAssociation", {
      resolverQueryLogConfigId: queryLogging.attrId,
      resourceId: props.vpcId,
    });
  }
}
