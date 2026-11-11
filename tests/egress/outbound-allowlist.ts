// Enterprise foundations, task N4: every external host the code can reach, and what an Enterprise install does about it. The test beside this file fails when a
// host appears in the code that is not listed here (or a listed host is no longer in the code), and docs/enterprise/outbound.md is generated from this list.
//
// A host belongs to exactly one rule. A rule may name `files` (path prefixes): the host may then appear only there, so a new call to it from elsewhere fails the
// test and is looked at. A rule with no `files` is a host the code legitimately names in many places.

export type OutboundCategory =
  | "customer-integration" | "model-provider" | "agent-egress-default" | "aws-service-principal" | "aws-endpoint" | "audit-timestamp" | "rovara-operated"
  | "deploy-supply-chain" | "company-image-registry" | "benchmark-tooling" | "provenance-text" | "detector-comparison" | "host-refusal-list" | "doc-link" | "reserved-example";

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
  "company-image-registry": {
    title: "Registries company-approved test images are copied from",
    enterprise: "The broker's lookup of an image tag contacts these registries (and a company's own extra registries, added by a company admin and kept per company) only when an admin names or approves an image, and only the host the allowlist names for each registry, after the name has resolved to public addresses only. A worker never contacts them. An install whose control plane cannot reach the public internet cannot use images from these registries.",
  },
  "benchmark-tooling": {
    title: "Benchmark tooling",
    enterprise: "Used only by Rovara's own evaluation tooling. Never run in an install.",
  },
  "provenance-text": {
    title: "Provenance notes inside the audit trust roots",
    enterprise: "Text in a certificate bundle saying where each root came from. Never contacted.",
  },
  "detector-comparison": {
    title: "Hosts a repository scan compares against",
    enterprise: "Names the environment detector holds so it can tell a repository's usual download source from an unusual one. Compared with text read from a repository; never called by the install.",
  },
  "host-refusal-list": {
    title: "Hosts a setup run is never allowed to ask for",
    enterprise: "Names the setup agent's website ask refuses without a card (paste and file-drop sites, link shorteners, tunnels, webhook collectors, open storage and hosting). Compared with names the setup sandbox failed to resolve; never called by the install, and never added to an allow-list.",
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

const DEFAULT_ALLOW = ["vendor/rovara-code/packages/contracts/src/default-allow-domains.ts"];

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
    category: "customer-integration", why: "Trackers and work-management connectors (Linear, Jira, Asana), and Atlassian's organization admin API (api.atlassian.com), read with a key the company supplies to tell which Jira accounts it manages.",
    hosts: ["linear.app", "api.linear.app", "mcp.linear.app", "mcp.atlassian.com", "api.atlassian.com", "*.atlassian.net", "mcp.asana.com", "app.asana.com"],
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
    category: "agent-egress-default", why: "The default list of package, image and OS mirror hosts agent machines may resolve. (Docker Hub's registry host is also named by the company image reader, which folds it into docker.io, and by the tag lookup that asks it.)", files: [...DEFAULT_ALLOW, "packages/broker/src/test-env/company-images.ts", "packages/broker/src/test-env/company-image-resolver.ts"],
    hosts: [
      "crates.io", "*.crates.io", "mcr.microsoft.com", "*.data.mcr.microsoft.com", "ghcr.io", "*.ghcr.io", "*.githubusercontent.com", "rubygems.org", "*.rubygems.org",
      "archive.ubuntu.com", "ports.ubuntu.com", "security.ubuntu.com", "deb.debian.org", "security.debian.org", "dl-cdn.alpinelinux.org", "auth.docker.io", "registry-1.docker.io",
      "production.cloudflare.docker.com", "production.cloudfront.docker.com", "docker-images-prod.6aa30f8b08e16409b46e0173d6de2f56.r2.cloudflarestorage.com",
      "files.pythonhosted.org", "pypi.org", "proxy.golang.org", "sum.golang.org", "registry.yarnpkg.com", "repo1.maven.org",
    ],
  },
  {
    category: "company-image-registry", why: "Docker Hub, the default registry of a company-approved test image (`postgres:18` is `docker.io/library/postgres:18`), and the other spelling of it the reader folds into `docker.io` (the admin screen shows it as Docker Hub).", files: ["packages/broker/src/test-env/company-images.ts", "packages/ui/src/screens/admin/how-we-work/CompanyImagesScreen.tsx"],
    hosts: ["docker.io", "index.docker.io"],
  },
  {
    category: "agent-egress-default", why: "Maven Central: in the default list, and the usual wrapper download host the environment detector compares a repository's wrapper properties with.", files: [...DEFAULT_ALLOW, "packages/worker/src/env-detect/java.ts"],
    hosts: ["repo.maven.apache.org"],
  },
  {
    category: "agent-egress-default", why: "The npm registry: in the default list, the setup draft's default allowed domain, and the registry an install uses for package-run MCP servers when it sets rovaraMcpPublicNpm and names none.", files: [...DEFAULT_ALLOW, "packages/worker/src/setup-draft.ts", "vendor/rovara-code/packages/contracts/src/e2e-native-recipes.ts", "infra/lib/private-mcp.ts"],
    hosts: ["registry.npmjs.org"],
  },
  {
    category: "aws-endpoint", why: "Wildcard for AWS API hosts in the default allow-list; the CloudWatch connector's host; the domain-suffix checks in the CLI.",
    hosts: ["*.amazonaws.com", "monitoring.amazonaws.com", "amazonaws.com", "amazonaws.com.cn"],
  },
  {
    category: "aws-endpoint", why: "The install's own regional endpoint names and the global STS name, in the Enterprise DNS allow-list; and, as the CloudTrail event source an alert rule matches (a pattern, not a call), in the operator-assumption alert; and, as the audience a GitHub Actions token must carry, in the release bundle-signing role's trust policy (a condition value, not a call; 2026-11-03: 0.5.2 batch).", files: ["infra/lib/vpc-endpoints.ts", "infra/lib/operator-access.ts", "infra/lib/bundle-signing.ts"],
    hosts: ["sts.amazonaws.com"],
  },
  {
    category: "aws-service-principal", why: "Service principals named in IAM trust and resource policies and in the CDK stacks.",
    hosts: [
      "apigateway.amazonaws.com", "cloudformation.amazonaws.com", "codebuild.amazonaws.com", "delivery.logs.amazonaws.com", "ec2.amazonaws.com", "ecs-tasks.amazonaws.com",
      "ecs.amazonaws.com", "elasticloadbalancing.amazonaws.com", "email.cognito-idp.amazonaws.com", "events.amazonaws.com", "lambda.amazonaws.com", "rds.amazonaws.com",
      "route53resolver.amazonaws.com", "s3.amazonaws.com", "scheduler.amazonaws.com", "states.amazonaws.com", "vpc-flow-logs.amazonaws.com",
      // Team record edition: the KMS key policy statements the install emits for the customer's key (infra/lib/team-record-edition.ts).
      "maintenance.s3tables.amazonaws.com", "s3tables.amazonaws.com", "indexing.s3vectors.amazonaws.com", "s3vectors.amazonaws.com",
    ],
  },
  {
    category: "aws-service-principal", why: "The ECR service principal in the trust policy of the role ECR assumes to create a saved-environment repository from the creation template (an IAM principal, not a call); and, as the iam:AWSServiceName condition on the deploy role's one service-linked-role statement for ECR's creation-template role (a policy value, not a call).", files: ["infra/lib/saved-env-images.ts", "packages/cloud-contracts/src/access-policies.ts"],
    hosts: ["ecr.amazonaws.com"],
  },
  {
    category: "aws-service-principal", why: "The CodeArtifact service name in the sts:AWSServiceName condition that scopes the broker role's registry token policy (a policy value, not a call).", files: ["infra/lib/registry-access.ts"],
    hosts: ["codeartifact.amazonaws.com"],
  },
  {
    category: "audit-timestamp", why: "The two public timestamp authorities the audit anchor asks by default.", files: ["packages/cloud-contracts/src/audit.ts", "packages/audit-verifier/src/trust-roots.ts"],
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
    category: "deploy-supply-chain", why: "GitHub Actions' OIDC issuer, named as the federated provider in the release bundle-signing role's trust policy (an issuer name in a condition key, not a call; 2026-11-03: 0.5.2 batch).", files: ["infra/lib/bundle-signing.ts"],
    hosts: ["token.actions.githubusercontent.com"],
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
    category: "detector-comparison", why: "The Gradle wrapper's usual download host, which the environment detector compares a repository's wrapper properties with (a host other than the usual ones is reported to the person).", files: ["packages/worker/src/env-detect/java.ts"],
    hosts: ["services.gradle.org"],
  },
  {
    category: "host-refusal-list", why: "The suffixes the setup agent's host ask refuses outright, so no card is made for them and a run cannot get them approved.", files: ["packages/broker/src/rovara-code/setup-host-ask.ts"],
    hosts: ["0bin.net", "anonfiles.com", "appspot.com", "azurestaticapps.net", "azurewebsites.net", "backblazeb2.com", "beeceptor.com", "bitbucket.io", "blob.core.windows.net", "burpcollaborator.net", "canarytokens.com", "ceye.io", "cloudfront.net", "ddns.net", "digitaloceanspaces.com", "dnslog.cn", "dpaste.com", "dpaste.org", "duckdns.org", "file.io", "firebaseapp.com", "firebasestorage.googleapis.com", "fly.dev", "github.io", "gitlab.io", "glitch.me", "gofile.io", "hastebin.com", "herokuapp.com", "hookbin.com", "hopto.org", "ipfs.io", "ix.io", "localtest.me", "localtunnel.me", "lvh.me", "mockbin.org", "myftp.org", "netlify.app", "ngrok-free.app", "ngrok-free.dev", "ngrok.app", "ngrok.com", "ngrok.dev", "ngrok.io", "nip.io", "no-ip.com", "no-ip.org", "oast.me", "oast.online", "oast.site", "oastify.com", "onrender.com", "pagekite.me", "pages.dev", "pastebin.com", "pinggy.io", "pipedream.net", "portmap.io", "r2.cloudflarestorage.com", "r2.dev", "rbndr.us", "rentry.co", "repl.co", "replit.dev", "requestbin.com", "requestbin.net", "requestcatcher.com", "requestrepo.com", "serveo.net", "sslip.io", "storage.googleapis.com", "sytes.net", "t.co", "termbin.com", "tinyurl.com", "traefik.me", "trycloudflare.com", "ts.net", "tunnelmole.net", "vcap.me", "vercel.app", "wasabisys.com", "web.app", "webhook.site", "wetransfer.com", "workers.dev", "xip.io", "zapto.org", "zrok.io"],
  },
  {
    category: "doc-link", why: "Documentation links in CLI messages.", files: ["packages/cli/src/init/"],
    hosts: ["docs.aws.amazon.com"],
  },
  {
    category: "reserved-example", why: "Names that cannot resolve, example values in help text, test doubles' addresses, and a bundle id that looks like a host.",
    hosts: [
      "agentx.invalid", "agentx-mock.invalid", "fixtures.invalid", "application.invalid", "none.invalid", "rovara.invalid", "auth.test", "agentx.example.com", "probe.example.com", "acme.okta.com",
      // The example Jira site in the Connections page's "Jira site" field hint (packages/ui/src/screens/admin/connections/RegistryItems.tsx, UX3). Text for a person to read; the page sends nothing to it.
      "acme.atlassian.net",
      // The example Grafana address in the Connections page's "Add monitoring" field hint (packages/ui/src/screens/admin/connections/AddMonitoring.tsx, P1 connections UX). Text for a person to read; the page sends nothing to it.
      "grafana.acme.dev",
      "abc123.execute-api.us-west-2.amazonaws.com", "host.example.test", "builds.example.test", "nativeexport.app",
      // The example registry address in the private-MCP install setting's error message (infra/lib/private-mcp.ts); example.net is reserved and cannot resolve.
      "registry.corp.example.net",
    ],
  },
  {
    category: "reserved-example", why: "XML namespace, claim-type and algorithm identifiers the SAML sign-in compares with (W3C XML signature and encryption, WS-Federation claim types). They look like URLs but are names, never fetched.", files: ["packages/broker/src/developer/saml.ts", "packages/broker/src/developer/providers.ts"],
    hosts: ["www.w3.org", "schemas.xmlsoap.org"],
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

/**
 * Names the code resolves through DNS that are not written in it: a name a customer gives (a connector's address, a domain a company claims). Hosts written in the code are
 * `HOST_RULES`; these are the places that LOOK UP a name, so a new lookup from anywhere else fails the test and is looked at.
 */
export interface DnsLookupRule {
  /** What is looked up and why. */
  why: string;
  /** The only files that may import Node's DNS. */
  files: readonly string[];
}

export const DNS_LOOKUP_RULES: readonly DnsLookupRule[] = [
  {
    why: "Company domain verification: the CNAME and TXT records of `_rovara-verify.<domain>` for a domain a company owner claims on the Company domains page, and the daily re-check of it. The broker's own resolver (on AWS, the VPC resolver); nothing else is asked, a record behind an alias is not followed, and each lookup is cancelled after 6 seconds.",
    files: ["packages/broker/src/org/company-domains/resolver.ts"],
  },
  {
    why: "Connector endpoints: the check that a company's MCP connector address resolves to public addresses only, before the broker saves it or calls it.",
    files: ["packages/broker/src/connections/endpoint-check.ts"],
  },
  {
    why: "The gateway's endpoint check: the same public-address test for the address a connector call goes to.",
    files: ["packages/gateway/src/endpoint.ts"],
  },
  {
    why: "Test accounts (switch `ta`, off by default): the test-account proxy of a sealed check round resolves the one name a CONNECT asks for, only if it is on that run's list of the customer's own test account hosts (at most 8), and refuses it when any answer is a private, loopback, link-local or metadata address. The proxy then connects to the address it checked, on port 443 only. Nothing else is asked, and nothing is sent to Rovara.",
    files: ["packages/worker/src/test-account-proxy.ts"],
  },
];

/** The text of docs/enterprise/outbound.md, from the rules. The test compares the file to this, so the document cannot drift from the list. */
export function renderOutboundDoc(rules: readonly HostRule[], lookups: readonly DnsLookupRule[] = DNS_LOOKUP_RULES): string {
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
  lines.push(
    "## Names looked up in DNS",
    "",
    "Enterprise: Not hosts written in the code but names a customer gives it. Each lookup goes to the install's own DNS resolver, only when a person uses the feature (or, for a claimed domain, once a day), and nothing is sent to Rovara. If the install's network blocks the lookup, the feature reports it as unavailable and changes nothing.",
    "",
  );
  for (const lookup of lookups) lines.push(`- ${lookup.why} (only in ${lookup.files.map((file) => `\`${file}\``).join(", ")})`);
  lines.push("");
  return `${lines.join("\n").trimEnd()}\n`;
}
