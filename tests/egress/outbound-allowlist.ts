// Enterprise foundations, task N4: every external host the code can reach, and what an Enterprise install does about it. The test beside this file fails when a
// host appears in the code that is not listed here (or a listed host is no longer in the code), and docs/enterprise/outbound.md is generated from this list.
//
// A host belongs to exactly one rule. A rule may name `files` (path prefixes): the host may then appear only there, so a new call to it from elsewhere fails the
// test and is looked at. A rule with no `files` is a host the code legitimately names in many places.

export type OutboundCategory =
  | "customer-integration" | "model-provider" | "agent-egress-default" | "aws-service-principal" | "aws-endpoint" | "audit-timestamp" | "rovara-operated"
  | "deploy-supply-chain" | "benchmark-tooling" | "provenance-text" | "doc-link" | "reserved-example";

export interface HostRule {
  hosts: readonly string[];
  category: OutboundCategory;
  /** Why the code names these hosts. */
  why: string;
  files?: readonly string[];
}

export const CATEGORY_TITLES: Readonly<Record<OutboundCategory, { title: string; enterprise: string }>> = {
  "customer-integration": {
    title: "Systems the customer connects",
    enterprise: "Reached only when an admin connects that system (or registers a GitHub repository). Each host must also be on the install's egress allow-list. Nothing here is reached by default.",
  },
  "model-provider": {
    title: "Model providers",
    enterprise: "An Enterprise install calls the customer's own Bedrock through a VPC endpoint. These hosts are reached only if an admin adds that provider as a model source, and each needs an allow-list entry.",
  },
  "agent-egress-default": {
    title: "Default allow-list for agent machines (public package and image hosts)",
    enterprise: "These names are in the default DNS firewall allow-list that agent machines use, which today is the same list on every install that runs the firewall. An Enterprise install should replace it with a list built from its own settings (registries, code host, build system); that is a follow-up (the list is not yet built from settings).",
  },
  "aws-service-principal": {
    title: "AWS service principals in policies",
    enterprise: "Names that appear in IAM trust and resource policies. Nothing connects to them.",
  },
  "aws-endpoint": {
    title: "AWS endpoints and the AWS domain suffix",
    enterprise: "Reached in the customer's own account. An Enterprise install reaches AWS APIs through VPC interface endpoints (infra/lib/vpc-endpoints.ts); a connector that calls an AWS API not in that list needs its endpoint added.",
  },
  "audit-timestamp": {
    title: "Audit anchor timestamp authorities",
    enterprise: "The audit anchor asks these two public timestamp authorities by default (agentxAuditTsa=public). An Enterprise install must choose its own (agentxAuditTsa=custom, with its URLs and roots) or switch it off (agentxAuditTsa=off, the last resort); it must not leave the default. A deploy-time refusal of the default for Enterprise is task E2.",
  },
  "rovara-operated": {
    title: "Hosts Rovara operates",
    enterprise: "Used only to build a link shown to a person, never called by the install: the sign-in page link in an invite (ROVARA_WEB_ORIGIN) and the sender name of a sign-in email. An Enterprise install sets ROVARA_WEB_ORIGIN to its own address. No Enterprise code path calls a Rovara-operated host; the opt-in update check (not built) will be the only one, and it sends nothing.",
  },
  "deploy-supply-chain": {
    title: "Fetched when the install is built or deployed",
    enterprise: "Reached by the release pipeline, the installer or the CLI at build or deploy time, not by a running install. The release bundle (task N2) carries every image the install runs, so a sealed install pulls nothing from these at run time.",
  },
  "benchmark-tooling": {
    title: "Benchmark tooling",
    enterprise: "Used only by Rovara's own evaluation tooling. Never run in an install.",
  },
  "provenance-text": {
    title: "Provenance notes inside the audit trust roots",
    enterprise: "Text in a certificate bundle saying where each root came from. Never contacted.",
  },
  "doc-link": {
    title: "Links shown to people",
    enterprise: "Shown in help text and messages. Never called by the install.",
  },
  "reserved-example": {
    title: "Reserved, example and placeholder names",
    enterprise: "Names that cannot resolve (.invalid, .test, example domains) or that are not hosts at all. Never reached.",
  },
};

const DEFAULT_ALLOW = ["packages/contracts/src/default-allow-domains.ts"];

export const HOST_RULES: readonly HostRule[] = [
  {
    category: "customer-integration", why: "GitHub: the first code-host plug-in (clone, pull requests, webhooks, sign-in for Public) and the GitHub MCP gateway.",
    hosts: ["github.com", "api.github.com", "api.githubcopilot.com", "*.github.com"],
  },
  {
    category: "customer-integration", why: "Slack: the Slack app, webhooks and links.",
    hosts: ["slack.com", "api.slack.com", "app.slack.com", "hooks.slack.com", "slack-gov.com", "*.slack.com"],
  },
  {
    category: "customer-integration", why: "Trackers and work-management connectors (Linear, Jira, Asana).",
    hosts: ["linear.app", "api.linear.app", "mcp.linear.app", "mcp.atlassian.com", "*.atlassian.net", "mcp.asana.com", "app.asana.com"],
  },
  {
    category: "customer-integration", why: "Observability and operations connectors (read-only): Sentry, Datadog (regional hosts), Grafana, PagerDuty, Vercel.",
    hosts: [
      "sentry.io", "datadoghq.com", "ap1.datadoghq.com", "ap2.datadoghq.com", "datadoghq.eu", "us3.datadoghq.com", "us5.datadoghq.com", "uk1.datadoghq.com", "ddog-gov.com", "us2.ddog-gov.com",
      "api.pagerduty.com", "api.eu.pagerduty.com", "api.vercel.com", "vercel.com",
    ],
  },
  {
    category: "model-provider", why: "Model providers an admin can add as a source: Anthropic, OpenAI and ChatGPT sign-in, OpenRouter.",
    hosts: ["api.anthropic.com", "api.openai.com", "auth.openai.com", "chatgpt.com", "openrouter.ai"],
  },
  {
    category: "agent-egress-default", why: "The default list of package, image and OS mirror hosts agent machines may resolve.", files: DEFAULT_ALLOW,
    hosts: [
      "crates.io", "*.crates.io", "mcr.microsoft.com", "*.data.mcr.microsoft.com", "ghcr.io", "*.ghcr.io", "*.githubusercontent.com", "rubygems.org", "*.rubygems.org",
      "archive.ubuntu.com", "ports.ubuntu.com", "security.ubuntu.com", "deb.debian.org", "security.debian.org", "dl-cdn.alpinelinux.org", "auth.docker.io", "registry-1.docker.io",
      "production.cloudflare.docker.com", "production.cloudfront.docker.com", "docker-images-prod.6aa30f8b08e16409b46e0173d6de2f56.r2.cloudflarestorage.com",
      "files.pythonhosted.org", "pypi.org", "proxy.golang.org", "sum.golang.org", "registry.yarnpkg.com", "repo.maven.apache.org", "repo1.maven.org",
    ],
  },
  {
    category: "agent-egress-default", why: "The npm registry: in the default list, and the setup draft's default allowed domain.", files: [...DEFAULT_ALLOW, "packages/worker/src/setup-draft.ts", "packages/contracts/src/e2e-native-recipes.ts"],
    hosts: ["registry.npmjs.org"],
  },
  {
    category: "aws-endpoint", why: "Wildcard for AWS API hosts in the default allow-list; the CloudWatch connector's host; the domain-suffix checks in the CLI.",
    hosts: ["*.amazonaws.com", "monitoring.amazonaws.com", "amazonaws.com", "amazonaws.com.cn"],
  },
  {
    category: "aws-endpoint", why: "The install's own regional endpoint names and the global STS name, in the Enterprise DNS allow-list.", files: ["infra/lib/vpc-endpoints.ts"],
    hosts: ["sts.amazonaws.com"],
  },
  {
    category: "aws-service-principal", why: "Service principals named in IAM trust and resource policies and in the CDK stacks.",
    hosts: [
      "apigateway.amazonaws.com", "cloudformation.amazonaws.com", "codebuild.amazonaws.com", "delivery.logs.amazonaws.com", "ec2.amazonaws.com", "ecs-tasks.amazonaws.com",
      "ecs.amazonaws.com", "elasticloadbalancing.amazonaws.com", "email.cognito-idp.amazonaws.com", "events.amazonaws.com", "lambda.amazonaws.com", "rds.amazonaws.com",
      "route53resolver.amazonaws.com", "s3.amazonaws.com", "scheduler.amazonaws.com", "states.amazonaws.com", "vpc-flow-logs.amazonaws.com",
    ],
  },
  {
    category: "audit-timestamp", why: "The two public timestamp authorities the audit anchor asks by default.", files: ["packages/contracts/src/audit.ts", "packages/audit-verifier/src/trust-roots.ts"],
    hosts: ["timestamp.digicert.com", "timestamp.sectigo.com"],
  },
  {
    category: "provenance-text", why: "Where the pinned timestamp trust roots came from, written beside them.", files: ["packages/audit-verifier/src/trust-roots.ts"],
    hosts: ["cacerts.digicert.com", "ccadb.my.salesforce-sites.com", "crt.sectigo.com", "knowledge.digicert.com", "www.digicert.com"],
  },
  {
    category: "rovara-operated", why: "Rovara's sign-in forwarder and web origin: the default origin of an invite link, the CLI's trusted join page, and the sample sender of a sign-in email.",
    files: ["packages/broker/src/org/invite-url.ts", "packages/cli/src/developer/invite-link.ts", "infra/lib/cloud-identity.ts"],
    hosts: ["rovara.dev"],
  },
  {
    category: "deploy-supply-chain", why: "Node for the CloudShell install, and the release pipeline's tools.", files: ["infra/lib/release-pipeline.ts", "packages/cli/src/node-version.ts", ...DEFAULT_ALLOW],
    hosts: ["nodejs.org", "awscli.amazonaws.com"],
  },
  {
    category: "deploy-supply-chain", why: "The upstream registry of the image pull-through cache rule.", files: ["infra/lib/access.ts"],
    hosts: ["public.ecr.aws"],
  },
  {
    category: "benchmark-tooling", why: "Evaluation dataset downloads.", files: ["packages/worker/src/swebench/"],
    hosts: ["huggingface.co", "datasets-server.huggingface.co", "raw.githubusercontent.com"],
  },
  {
    category: "doc-link", why: "Documentation links in CLI messages.", files: ["packages/cli/src/init/"],
    hosts: ["docs.aws.amazon.com"],
  },
  {
    category: "reserved-example", why: "Names that cannot resolve, example values in help text, test doubles' addresses, and a bundle id that looks like a host.",
    hosts: [
      "agentx.invalid", "agentx-mock.invalid", "application.invalid", "none.invalid", "rovara.invalid", "auth.test", "agentx.example.com", "probe.example.com", "acme.okta.com",
      "abc123.execute-api.us-west-2.amazonaws.com", "host.example.test", "builds.example.test", "nativeexport.app",
    ],
  },
];

export interface Occurrence { host: string; file: string; line: number }

export interface RuleCheck {
  /** Occurrences of a host no rule lists. */
  unlisted: Occurrence[];
  /** Occurrences of a listed host in a file its rule does not allow. */
  misplaced: Occurrence[];
  /** Listed hosts the code no longer names. */
  stale: string[];
  /** Hosts listed by more than one rule. */
  duplicated: string[];
}

/** Compares what the scan found with the rules. Pure: the test feeds it the real scan, and a planted one to prove it can fail. */
export function checkAgainstRules(found: readonly Occurrence[], rules: readonly HostRule[]): RuleCheck {
  const owner = new Map<string, HostRule>();
  const duplicated: string[] = [];
  for (const rule of rules) {
    for (const host of rule.hosts) {
      if (owner.has(host)) duplicated.push(host);
      else owner.set(host, rule);
    }
  }
  const unlisted: Occurrence[] = [];
  const misplaced: Occurrence[] = [];
  const seen = new Set<string>();
  for (const occurrence of found) {
    seen.add(occurrence.host);
    const rule = owner.get(occurrence.host);
    if (rule === undefined) unlisted.push(occurrence);
    else if (rule.files !== undefined && !rule.files.some((prefix) => occurrence.file.startsWith(prefix))) misplaced.push(occurrence);
  }
  return { unlisted, misplaced, stale: [...owner.keys()].filter((host) => !seen.has(host)).sort(), duplicated: duplicated.sort() };
}

const TERMS_NOTE = "A host built from parts at run time (for example a tenant's own subdomain) shows only its fixed tail, and a host read from a setting is not in this list at all. This list is the floor of what the code can reach, not the whole of it; the install's flow logs (task N10c) are the proof.";

/** The text of docs/enterprise/outbound.md, from the rules. The test compares the file to this, so the document cannot drift from the list. */
export function renderOutboundDoc(rules: readonly HostRule[]): string {
  const lines: string[] = [
    "# Outbound hosts of the Rovara code",
    "",
    "<!-- Generated from tests/egress/outbound-allowlist.ts by tests/egress/outbound-hosts.test.ts. Do not edit by hand: change the list, then run the test with UPDATE_OUTBOUND_DOC=1. -->",
    "",
    "Every external host written into the code an install runs, found by reading the source (comments excluded), and what an Enterprise install does about each. The Enterprise edition sends nothing to Rovara by default: no host Rovara operates is called by any Enterprise code path.",
    "",
    `Limits: ${TERMS_NOTE}`,
    "",
  ];
  for (const category of Object.keys(CATEGORY_TITLES) as OutboundCategory[]) {
    const inCategory = rules.filter((rule) => rule.category === category);
    if (inCategory.length === 0) continue;
    const { title, enterprise } = CATEGORY_TITLES[category];
    lines.push(`## ${title}`, "", `Enterprise: ${enterprise}`, "");
    for (const rule of inCategory) {
      lines.push(`- ${rule.why}${rule.files === undefined ? "" : ` (only in ${rule.files.map((file) => `\`${file}\``).join(", ")})`}`);
      lines.push(`  ${[...rule.hosts].sort().map((host) => `\`${host}\``).join(", ")}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
