import { RemovalPolicy, aws_logs as logs, aws_route53resolver as resolver } from "aws-cdk-lib";
import { Construct } from "constructs";
import { DEFAULT_AGENT_ALLOW_DOMAINS } from "@rovara-code/contracts";

export { DEFAULT_AGENT_ALLOW_DOMAINS };

/**
 * Names that must never be on an install's default allow-list, whatever the pinned copy of Code's list says (DEFAULT-ALLOW-LIST-EXFIL, 0.5.15). The firewall is one resolver for the
 * whole VPC, so a task sandbox resolves exactly what the worker beside it does: a name under which anyone can host an upload target (a bucket, an API, a repository, a gist) is an
 * exit for an injected agent. Code's list drops these in its own lane; this filter keeps Cloud right at any pin, and the contract test pins that it removes them.
 */
export const BROAD_DEFAULT_ALLOW_ENTRIES: readonly string[] = ["*.amazonaws.com", "*.aws", "*.github.com", "*.githubusercontent.com"];

/**
 * What the broad entries were there for, as exact names: the worker's git (`github.com`: clone, fetch and push run on the same resolver as the sandboxes, so it stays, a known exit that
 * only a per-task proxy closes) and the blobs of a ghcr.io image (the model proxy image; `pkg-containers.githubusercontent.com` is the one host they come from).
 */
export const NAMED_IN_PLACE_OF_BROAD_ENTRIES: readonly string[] = ["github.com", "pkg-containers.githubusercontent.com"];

/** Code's default list without the broad entries, with their exact replacements (no change once the pin carries Code's narrowed list). */
export function narrowedDefaultAllowDomains(base: readonly string[] = DEFAULT_AGENT_ALLOW_DOMAINS): string[] {
  const kept = base.filter((entry) => !BROAD_DEFAULT_ALLOW_ENTRIES.includes(entry.toLowerCase()));
  for (const name of NAMED_IN_PLACE_OF_BROAD_ENTRIES) if (!kept.includes(name)) kept.push(name);
  return kept;
}

/**
 * The AWS hosts a hosted (Public or Cloud) install's own machines resolve, in the install's region and nowhere else, each with the reason. These replace `*.amazonaws.com` and `*.aws`.
 * The firewall is VPC-wide, so the callers are the worker host and its containers, the session Lambdas in the private subnets (steps, reaper, reconciler, dispatcher), the model
 * proxy and its Aurora database, the model access function and the Slack orchestrator. Found by reading what each calls (the AWS clients the in-VPC handlers import, the boot scripts, the
 * model proxy construct); not yet proved against a live install's query log, so the staging deploy checks it before production (the sandbox-egress-control follow-up design).
 */
export const HOSTED_AWS_HOSTS: ReadonlyArray<{ host: (region: string) => string; why: string }> = [
  { host: (r) => `dynamodb.${r}.amazonaws.com`, why: "state tables (session Lambdas, Slack orchestrator)" },
  { host: (r) => `sqs.${r}.amazonaws.com`, why: "queues (session Lambdas, Slack orchestrator)" },
  { host: (r) => `s3.${r}.amazonaws.com`, why: "S3 regional endpoint" },
  { host: (r) => `*.s3.${r}.amazonaws.com`, why: "the install's artifact and thread buckets (names are generated in another stack, so not pinned yet), the ECR layer bucket prod-<region>-starport-layer-bucket (image pulls). KNOWN RESIDUAL: a bucket of anyone's in this region; closed by an S3 gateway endpoint policy (the sandbox-egress-control follow-up design)" },
  { host: (r) => `al2023-repos-${r}-de612dc2.s3.dualstack.${r}.amazonaws.com`, why: "Amazon Linux 2023 package repository: boot.sh runs `dnf install docker` on a worker (exact bucket host)" },
  { host: (r) => `kms.${r}.amazonaws.com`, why: "session Lambdas sign and verify with the invoke key" },
  { host: (r) => `ssm.${r}.amazonaws.com`, why: "settings parameters (session Lambdas); ECS parameter secrets for the model proxy" },
  { host: (r) => `ec2.${r}.amazonaws.com`, why: "worker instances (reaper, reconciler)" },
  { host: (r) => `states.${r}.amazonaws.com`, why: "Step Functions (provisioner, deleter, dispatcher)" },
  { host: (r) => `lambda.${r}.amazonaws.com`, why: "Lambda API (dispatcher, reconciler)" },
  { host: (r) => `email.${r}.amazonaws.com`, why: "SES v2 (reconciler's operator mail)" },
  { host: (r) => `secretsmanager.${r}.amazonaws.com`, why: "model proxy and Slack orchestrator secrets (ECS injects them through the task's network)" },
  { host: (r) => `scheduler.${r}.amazonaws.com`, why: "EventBridge Scheduler (reconciler)" },
  { host: (r) => `sts.${r}.amazonaws.com`, why: "role sessions (reconciler, model access, org Bedrock roles)" },
  { host: () => "sts.amazonaws.com", why: "the global STS name some SDKs and the AWS CLI still use" },
  { host: (r) => `monitoring.${r}.amazonaws.com`, why: "CloudWatch metrics (reconciler)" },
  { host: (r) => `logs.${r}.amazonaws.com`, why: "CloudWatch Logs: the worker's awslogs driver, ECS task logs, reconciler" },
  { host: (r) => `api.ecr.${r}.amazonaws.com`, why: "ECR login token for worker image pulls (boot.sh) and ECS image pulls" },
  { host: (r) => `*.dkr.ecr.${r}.amazonaws.com`, why: "ECR registry the worker, executor and sandbox images are pulled from" },
  { host: (r) => `bedrock-runtime.${r}.amazonaws.com`, why: "model calls by the model proxy and model access function" },
  { host: (r) => `bedrock.${r}.amazonaws.com`, why: "Bedrock model and profile discovery (model proxy, worker model check)" },
  { host: (r) => `servicequotas.${r}.amazonaws.com`, why: "Bedrock quota read by the worker's model check" },
  { host: (r) => `ecs.${r}.amazonaws.com`, why: "package-run MCP servers: the controller's RunTask and StopTask" },
  { host: (r) => `*.execute-api.${r}.amazonaws.com`, why: "the control plane's API: the worker's callbacks and the Slack orchestrator (the id is generated in the control-plane stack, so not pinned yet; closed by pinning it, the sandbox-egress-control follow-up design)" },
  { host: (r) => `*.${r}.elb.amazonaws.com`, why: "the model proxy's internal load balancer (a generated name)" },
  { host: (r) => `*.${r}.rds.amazonaws.com`, why: "the model proxy's Aurora database endpoint (a generated name)" },
];

/** The exact AWS names of a hosted install in `region`. */
export function hostedAwsAllowDomains(region: string): string[] {
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/u.test(region)) throw new Error(`hostedAwsAllowDomains needs an AWS region such as us-west-2, not ${JSON.stringify(region)}`);
  return [...new Set(HOSTED_AWS_HOSTS.map((entry) => entry.host(region)))];
}

/** The base allow-list of a hosted (non-Enterprise) install: Code's default without the broad entries, plus the install's own AWS hosts. */
export function hostedAgentAllowDomains(region: string): string[] {
  return [...narrowedDefaultAllowDomains(), ...hostedAwsAllowDomains(region)];
}

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
