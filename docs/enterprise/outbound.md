# Outbound hosts of the Rovara code

<!-- Generated from tests/egress/outbound-allowlist.ts by tests/egress/outbound-hosts.test.ts. Do not edit by hand: change the list, then run the test with UPDATE_OUTBOUND_DOC=1. -->

Every external host written into the code an install runs, found by reading the source (comments excluded), and what an Enterprise install does about each. The Enterprise edition sends nothing to Rovara by default: no host Rovara operates is called by any Enterprise code path.

Limits: A host built from parts at run time (for example a tenant's own subdomain) shows only its fixed tail, and a host read from a setting is not in this list at all. This list is the floor of what the code can reach, not the whole of it; the install's flow logs (task N10c) are the proof.

## Systems the customer connects

Enterprise: Reached only when an admin connects that system (or registers a GitHub repository). Each host must also be on the install's egress allow-list. Nothing here is reached by default.

- GitHub: the first code-host plug-in (clone, pull requests, webhooks, sign-in for Public) and the GitHub MCP gateway.
  `*.github.com`, `api.github.com`, `api.githubcopilot.com`, `github.com`
- Slack: the Slack app, webhooks and links.
  `*.slack.com`, `api.slack.com`, `app.slack.com`, `hooks.slack.com`, `slack-gov.com`, `slack.com`
- Trackers and work-management connectors (Linear, Jira, Asana).
  `*.atlassian.net`, `api.linear.app`, `app.asana.com`, `linear.app`, `mcp.asana.com`, `mcp.atlassian.com`, `mcp.linear.app`
- Observability and operations connectors (read-only): Sentry, Datadog (regional hosts), Grafana, PagerDuty, Vercel.
  `ap1.datadoghq.com`, `ap2.datadoghq.com`, `api.eu.pagerduty.com`, `api.pagerduty.com`, `api.vercel.com`, `datadoghq.com`, `datadoghq.eu`, `ddog-gov.com`, `sentry.io`, `uk1.datadoghq.com`, `us2.ddog-gov.com`, `us3.datadoghq.com`, `us5.datadoghq.com`, `vercel.com`

## Model providers

Enterprise: An Enterprise install calls the customer's own Bedrock through a VPC endpoint. These hosts are reached only if an admin adds that provider as a model source, and each needs an allow-list entry.

- Model providers an admin can add as a source: Anthropic, OpenAI and ChatGPT sign-in, OpenRouter.
  `api.anthropic.com`, `api.openai.com`, `auth.openai.com`, `chatgpt.com`, `openrouter.ai`

## Default allow-list for agent machines (public package and image hosts)

Enterprise: These names are in the default DNS firewall allow-list that agent machines use, which today is the same list on every install that runs the firewall. An Enterprise install should replace it with a list built from its own settings (registries, code host, build system); that is a follow-up (the list is not yet built from settings).

- The default list of package, image and OS mirror hosts agent machines may resolve. (only in `packages/contracts/src/default-allow-domains.ts`)
  `*.crates.io`, `*.data.mcr.microsoft.com`, `*.ghcr.io`, `*.githubusercontent.com`, `*.rubygems.org`, `archive.ubuntu.com`, `auth.docker.io`, `crates.io`, `deb.debian.org`, `dl-cdn.alpinelinux.org`, `docker-images-prod.6aa30f8b08e16409b46e0173d6de2f56.r2.cloudflarestorage.com`, `files.pythonhosted.org`, `ghcr.io`, `mcr.microsoft.com`, `ports.ubuntu.com`, `production.cloudflare.docker.com`, `production.cloudfront.docker.com`, `proxy.golang.org`, `pypi.org`, `registry-1.docker.io`, `registry.yarnpkg.com`, `repo1.maven.org`, `rubygems.org`, `security.debian.org`, `security.ubuntu.com`, `sum.golang.org`
- Maven Central: in the default list, and the usual wrapper download host the environment detector compares a repository's wrapper properties with. (only in `packages/contracts/src/default-allow-domains.ts`, `packages/worker/src/env-detect/java.ts`)
  `repo.maven.apache.org`
- The npm registry: in the default list, the setup draft's default allowed domain, and the registry an install uses for package-run MCP servers when it sets rovaraMcpPublicNpm and names none. (only in `packages/contracts/src/default-allow-domains.ts`, `packages/worker/src/setup-draft.ts`, `packages/contracts/src/e2e-native-recipes.ts`, `infra/lib/private-mcp.ts`)
  `registry.npmjs.org`

## AWS service principals in policies

Enterprise: Names that appear in IAM trust and resource policies. Nothing connects to them.

- Service principals named in IAM trust and resource policies and in the CDK stacks.
  `apigateway.amazonaws.com`, `cloudformation.amazonaws.com`, `codebuild.amazonaws.com`, `delivery.logs.amazonaws.com`, `ec2.amazonaws.com`, `ecs-tasks.amazonaws.com`, `ecs.amazonaws.com`, `elasticloadbalancing.amazonaws.com`, `email.cognito-idp.amazonaws.com`, `events.amazonaws.com`, `indexing.s3vectors.amazonaws.com`, `lambda.amazonaws.com`, `maintenance.s3tables.amazonaws.com`, `rds.amazonaws.com`, `route53resolver.amazonaws.com`, `s3.amazonaws.com`, `s3tables.amazonaws.com`, `s3vectors.amazonaws.com`, `scheduler.amazonaws.com`, `states.amazonaws.com`, `vpc-flow-logs.amazonaws.com`
- The CodeArtifact service name in the sts:AWSServiceName condition that scopes the broker role's registry token policy (a policy value, not a call). (only in `infra/lib/registry-access.ts`)
  `codeartifact.amazonaws.com`

## AWS endpoints and the AWS domain suffix

Enterprise: Reached in the customer's own account. An Enterprise install reaches AWS APIs through VPC interface endpoints (infra/lib/vpc-endpoints.ts); a connector that calls an AWS API not in that list needs its endpoint added.

- Wildcard for AWS API hosts in the default allow-list; the CloudWatch connector's host; the domain-suffix checks in the CLI.
  `*.amazonaws.com`, `amazonaws.com`, `amazonaws.com.cn`, `monitoring.amazonaws.com`
- The install's own regional endpoint names and the global STS name, in the Enterprise DNS allow-list; and, as the CloudTrail event source an alert rule matches (a pattern, not a call), in the operator-assumption alert. (only in `infra/lib/vpc-endpoints.ts`, `infra/lib/operator-access.ts`)
  `sts.amazonaws.com`

## Audit anchor timestamp authorities

Enterprise: The audit anchor asks these two public timestamp authorities by default (agentxAuditTsa=public). An Enterprise install must choose its own (agentxAuditTsa=custom, with its URLs and roots) or switch it off (agentxAuditTsa=off, the last resort); it must not leave the default. A deploy-time refusal of the default for Enterprise is task E2.

- The two public timestamp authorities the audit anchor asks by default. (only in `packages/contracts/src/audit.ts`, `packages/audit-verifier/src/trust-roots.ts`)
  `timestamp.digicert.com`, `timestamp.sectigo.com`

## Hosts Rovara operates

Enterprise: Used only to build a link shown to a person, never called by the install: the sign-in page link in an invite (ROVARA_WEB_ORIGIN) and the sender name of a sign-in email. An Enterprise install sets ROVARA_WEB_ORIGIN to its own address. No Enterprise code path calls a Rovara-operated host; the opt-in update check (not built) will be the only one, and it sends nothing.

- Rovara's sign-in forwarder and web origin: the default origin of an invite link, the CLI's trusted join page, and the sample sender of a sign-in email. (only in `packages/broker/src/org/invite-url.ts`, `packages/cli/src/developer/invite-link.ts`, `infra/lib/cloud-identity.ts`)
  `rovara.dev`

## Fetched when the install is built or deployed

Enterprise: Reached by the release pipeline, the installer or the CLI at build or deploy time, not by a running install. The release bundle (task N2) carries every image the install runs, so a sealed install pulls nothing from these at run time.

- Node for the CloudShell install, and the release pipeline's tools. (only in `infra/lib/release-pipeline.ts`, `packages/cli/src/node-version.ts`, `packages/contracts/src/default-allow-domains.ts`)
  `awscli.amazonaws.com`, `nodejs.org`
- The upstream registry of the image pull-through cache rule. (only in `infra/lib/access.ts`)
  `public.ecr.aws`

## Benchmark tooling

Enterprise: Used only by Rovara's own evaluation tooling. Never run in an install.

- Evaluation dataset downloads. (only in `packages/worker/src/swebench/`)
  `datasets-server.huggingface.co`, `huggingface.co`, `raw.githubusercontent.com`

## Provenance notes inside the audit trust roots

Enterprise: Text in a certificate bundle saying where each root came from. Never contacted.

- Where the pinned timestamp trust roots came from, written beside them. (only in `packages/audit-verifier/src/trust-roots.ts`)
  `cacerts.digicert.com`, `ccadb.my.salesforce-sites.com`, `crt.sectigo.com`, `knowledge.digicert.com`, `www.digicert.com`

## Hosts a repository scan compares against

Enterprise: Names the environment detector holds so it can tell a repository's usual download source from an unusual one. Compared with text read from a repository; never called by the install.

- The Gradle wrapper's usual download host, which the environment detector compares a repository's wrapper properties with (a host other than the usual ones is reported to the person). (only in `packages/worker/src/env-detect/java.ts`)
  `services.gradle.org`

## Links shown to people

Enterprise: Shown in help text and messages. Never called by the install.

- Documentation links in CLI messages. (only in `packages/cli/src/init/`)
  `docs.aws.amazon.com`

## Reserved, example and placeholder names

Enterprise: Names that cannot resolve (.invalid, .test, example domains) or that are not hosts at all. Never reached.

- Names that cannot resolve, example values in help text, test doubles' addresses, and a bundle id that looks like a host.
  `abc123.execute-api.us-west-2.amazonaws.com`, `acme.okta.com`, `agentx-mock.invalid`, `agentx.example.com`, `agentx.invalid`, `application.invalid`, `auth.test`, `builds.example.test`, `host.example.test`, `mock.invalid`, `nativeexport.app`, `none.invalid`, `probe.example.com`, `registry.corp.example.net`, `rovara.invalid`
- XML namespace, claim-type and algorithm identifiers the SAML sign-in compares with (W3C XML signature and encryption, WS-Federation claim types). They look like URLs but are names, never fetched. (only in `packages/broker/src/developer/saml.ts`, `packages/broker/src/developer/providers.ts`)
  `schemas.xmlsoap.org`, `www.w3.org`
