// The websites a hosted (Public or Cloud) install's agent machines may resolve, built from Code's default list (DEFAULT-ALLOW-LIST-EXFIL, 0.5.15).
// ONE place: the install's DNS firewall (infra/lib/agent-dns-firewall.ts) and the broker's "already allowed" answers (setup-host-ask, project settings, the egress sync)
// both read it, so a name the broker calls "already allowed" is a name the firewall serves, and the other way round (tests/contract/hosted-allow-domains.test.ts).
//
// The firewall is one resolver for the whole VPC, so a task sandbox resolves exactly what the worker, the session Lambdas, the model proxy and the Slack orchestrator do.
// A name under which anyone can host an upload target (a bucket, an API, a repository, a gist) is therefore an exit for an injected agent.
import { DEFAULT_AGENT_ALLOW_DOMAINS, isAllowedDomain } from "@rovara-code/contracts";

/**
 * Entries the default list must never carry, whatever the pinned copy of Code's list says. Code's list drops them in its own lane; this filter keeps Cloud right at any pin
 * (a no-op once the pin carries Code's narrowed list).
 */
export const BROAD_DEFAULT_ALLOW_ENTRIES: readonly string[] = ["*.amazonaws.com", "*.aws", "*.github.com", "*.githubusercontent.com"];

/**
 * What the broad entries were there for, as exact names: the worker's git (`github.com`: clone, fetch and push run on the same resolver as the sandboxes, so it stays, a known exit
 * that only a per-task proxy closes), the blobs of a ghcr.io image (the model proxy image; `pkg-containers.githubusercontent.com` is the one host they come from) and GitHub's
 * read-only download hosts (dev container features, version managers, LFS, `github:` npm dependencies, benchmark files; uploads go through the api and uploads hosts, which stay blocked).
 */
export const NAMED_IN_PLACE_OF_BROAD_ENTRIES: readonly string[] = [
  "github.com", "pkg-containers.githubusercontent.com",
  "raw.githubusercontent.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "codeload.github.com",
];

/** Code's default list without the broad entries, with their exact replacements. */
export function narrowedDefaultAllowDomains(base: readonly string[] = DEFAULT_AGENT_ALLOW_DOMAINS): string[] {
  const kept = base.filter((entry) => !BROAD_DEFAULT_ALLOW_ENTRIES.includes(entry.toLowerCase()));
  for (const name of NAMED_IN_PLACE_OF_BROAD_ENTRIES) if (!kept.includes(name)) kept.push(name);
  return kept;
}

/**
 * Commercial AWS regions a company AI source (a Bedrock role in the company's own account) may name. The source schema (`ModelSourceInputSchema`, vendor Code's model-sources.ts)
 * accepts any name shaped like a region, so no list can be its exact twin; this is the commercial regions that exist (Bedrock is in most), pinned (the 34 regions of the AWS Regions page, 2026-11-11), and
 * tests/contract/hosted-allow-domains.test.ts proves each is accepted by that schema's region rule. GovCloud and China regions are not hosted here.
 */
export const BEDROCK_SOURCE_REGIONS: readonly string[] = [
  "us-east-1", "us-east-2", "us-west-1", "us-west-2", "ca-central-1", "ca-west-1", "sa-east-1", "mx-central-1",
  "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-central-2", "eu-north-1", "eu-south-1", "eu-south-2",
  "ap-east-1", "ap-east-2", "ap-northeast-1", "ap-northeast-2", "ap-northeast-3", "ap-south-1", "ap-south-2", "ap-southeast-1", "ap-southeast-2", "ap-southeast-3", "ap-southeast-4", "ap-southeast-5", "ap-southeast-6", "ap-southeast-7",
  "me-central-1", "me-south-1", "af-south-1", "il-central-1",
];

const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/u;

/**
 * The AWS hosts a hosted install's own machines resolve in the install's region, each with the reason. These replace `*.amazonaws.com` and `*.aws`.
 * The callers are the worker host and its containers, the session Lambdas in the private subnets (steps, reaper, reconciler, dispatcher), the model proxy and its Aurora
 * database, the model access function and the Slack orchestrator. Found by reading what each calls (the AWS clients the in-VPC handlers import, the boot scripts, the model proxy
 * construct); not yet proved against a live install's query log, so the staging deploy checks it before production.
 *
 * KNOWN RESIDUALS, each a name under which anyone in the region can host something, kept because the owning stack generates the name and the foundation (which owns the firewall)
 * is deployed before it, so the exact name is not knowable at synth time: `*.s3.<region>` (the artifact and thread buckets; the ECR layer bucket is in it too), `*.execute-api.<region>`
 * (the control plane's API id), `*.<region>.elb` (the model proxy's load balancer) and `*.<region>.rds` (its Aurora endpoint). Closing them needs the owning stacks to publish their
 * names to the firewall (a second rule group or an install-owned list; see the sandbox-egress-control design), or an S3 gateway endpoint policy for the bucket one.
 */
export const HOSTED_AWS_HOSTS: ReadonlyArray<{ host: (region: string, account?: string) => string | undefined; why: string }> = [
  { host: (r) => `dynamodb.${r}.amazonaws.com`, why: "state tables (session Lambdas, Slack orchestrator)" },
  { host: (r) => `sqs.${r}.amazonaws.com`, why: "queues (session Lambdas, Slack orchestrator)" },
  { host: (r) => `s3.${r}.amazonaws.com`, why: "S3 regional endpoint" },
  { host: (r) => `*.s3.${r}.amazonaws.com`, why: "the install's artifact and thread buckets (generated names, see KNOWN RESIDUALS) and the ECR layer bucket prod-<region>-starport-layer-bucket (image pulls)" },
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
  // An exact name, never a wildcard: AWS's own public, read-only price host (the Bedrock model price offer files, no account data and nothing to upload to). The model proxy's guard
  // reads it once a day to refresh prices; it is the only source allowed to LOWER a price, so a firewall that blocked it would leave the bundled prices in place for good.
  // The firewall is one resolver for the whole VPC, so naming it here lets every machine on it resolve it, which is harmless for a read-only public host.
  { host: () => "pricing.us-east-1.amazonaws.com", why: "AWS's public Price List host, read-only: the model proxy's daily price refresh (rovara-guard.ts), the only source that may lower a price" },
  { host: (r) => `monitoring.${r}.amazonaws.com`, why: "CloudWatch metrics (reconciler)" },
  { host: (r) => `logs.${r}.amazonaws.com`, why: "CloudWatch Logs: the worker's awslogs driver, ECS task logs, reconciler" },
  { host: (r) => `api.ecr.${r}.amazonaws.com`, why: "ECR login token for worker image pulls (boot.sh) and ECS image pulls" },
  { host: (r, account) => (account === undefined ? undefined : `${account}.dkr.ecr.${r}.amazonaws.com`), why: "this account's ECR registry: the worker, executor and sandbox images (exact; absent where the account is not known, as in the broker)" },
  { host: (r) => `bedrock-runtime.${r}.amazonaws.com`, why: "model calls by the model proxy and model access function" },
  { host: (r) => `bedrock.${r}.amazonaws.com`, why: "Bedrock model and profile discovery (model proxy, worker model check)" },
  { host: (r) => `servicequotas.${r}.amazonaws.com`, why: "Bedrock quota read by the worker's model check" },
  { host: (r) => `*.execute-api.${r}.amazonaws.com`, why: "the control plane's API: the worker's callbacks and the Slack orchestrator (see KNOWN RESIDUALS)" },
  { host: (r) => `*.${r}.elb.amazonaws.com`, why: "the model proxy's internal load balancer (a generated name, see KNOWN RESIDUALS)" },
  { host: (r) => `*.${r}.rds.amazonaws.com`, why: "the model proxy's Aurora database endpoint (a generated name, see KNOWN RESIDUALS)" },
];

/** Hosts a company's Bedrock source needs in a region other than the install's: the model proxy assumes the company's role and calls Bedrock there. */
export function bedrockSourceHosts(region: string): string[] {
  return [`bedrock-runtime.${region}.amazonaws.com`, `bedrock.${region}.amazonaws.com`, `sts.${region}.amazonaws.com`];
}

/** The exact AWS names of a hosted install in `region` (`account` pins its ECR registry), then the Bedrock and STS names of every region a company source can name. */
export function hostedAwsAllowDomains(region: string, account?: string): string[] {
  if (!REGION.test(region)) throw new Error(`hostedAwsAllowDomains needs an AWS region such as us-west-2, not ${JSON.stringify(region)}`);
  const own = HOSTED_AWS_HOSTS.map((entry) => entry.host(region, account)).filter((host): host is string => host !== undefined);
  return [...new Set([...own, ...BEDROCK_SOURCE_REGIONS.flatMap(bedrockSourceHosts)])];
}

/** The base allow-list of a hosted (non-Enterprise) install: Code's default without the broad entries, plus the install's own AWS hosts. */
export function hostedAgentAllowDomains(region: string, account?: string): string[] {
  return [...narrowedDefaultAllowDomains(), ...hostedAwsAllowDomains(region, account)];
}

/**
 * What the broker takes "already allowed" to mean: the hosted install's list when the region is a region name (a Lambda's AWS_REGION), else the default list alone.
 * The ECR registry host of the account is not in it (the broker does not know the account); nobody asks for it.
 */
export function installDefaultAllowDomains(region: string | undefined): string[] {
  return region !== undefined && REGION.test(region) ? hostedAgentAllowDomains(region) : narrowedDefaultAllowDomains();
}

const BROAD_WILDCARD_BASES = /(^|\.)(amazonaws\.com|amazonaws\.com\.cn|aws|github\.com|githubusercontent\.com)$/u;

/**
 * Whether a project (or anyone through the egress sync) may not ask for this name: the broad entries, and any wildcard over AWS or GitHub's domains. One project's approval
 * is cell-wide (the project list is one union for the VPC), so a wildcard that reopens what the default list closed would reopen it for every sandbox. An exact host is fine
 * (a company may need `dynamodb.eu-west-1.amazonaws.com`). Code's `isAllowedDomain` already refuses public suffixes and wildcards over them; this is the part it cannot know.
 */
export function isBroadAllowedDomain(domain: string): boolean {
  const name = domain.toLowerCase();
  if (BROAD_DEFAULT_ALLOW_ENTRIES.includes(name)) return true;
  return name.startsWith("*.") && BROAD_WILDCARD_BASES.test(name.slice(2));
}

/** The names the firewall may be asked to serve for a project: shaped like a name Code accepts, and not a broad one. */
export function isServableAllowedDomain(domain: string): boolean {
  return isAllowedDomain(domain) && !isBroadAllowedDomain(domain);
}

/** The message a refusal of a broad name carries (the value is not repeated: a refusal reaches logs and screens). */
export const BROAD_ALLOWED_DOMAIN_MESSAGE = "a wildcard over AWS or GitHub names cannot be allowed (it would let any account's bucket or repository through); name the exact host, such as dynamodb.eu-west-1.amazonaws.com";
