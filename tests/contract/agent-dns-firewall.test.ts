import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import {
  BEDROCK_SOURCE_REGIONS, BROAD_DEFAULT_ALLOW_ENTRIES, DEFAULT_AGENT_ALLOW_DOMAINS, DNS_FIREWALL_ASSOCIATION_PRIORITY, hostedAgentAllowDomains, hostedAwsAllowDomains, narrowedDefaultAllowDomains,
} from "../../infra/lib/agent-dns-firewall.js";
import { AGENTX_PRODUCTION_VPC_CIDR } from "../../infra/lib/production-foundation.js";
import { brokerNamesIn } from "../support/broker-names-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Properties: Record<string, unknown> };
type Rule = { Action: string; BlockResponse?: string; FirewallDomainListId: unknown; Priority: number; FirewallDomainRedirectionAction?: string };

function foundation(context: Record<string, unknown>): Template {
  const app = buildAgentXApp(context);
  const stack = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXProductionFoundation");
  return Template.fromStack(stack!);
}

const resourcesOf = (template: Template, type: string): Array<[string, Resource]> =>
  Object.entries(template.toJSON().Resources as Record<string, Resource>).filter(([, resource]) => resource.Type === type);
const firewallTypes = (template: Template): string[] =>
  Object.values(template.toJSON().Resources as Record<string, Resource>).map((resource) => resource.Type).filter((type) => type.startsWith("AWS::Route53Resolver::"));

/** A domain as the template holds it: a string, or this account's registry name (the account is a Ref, shown here as ACCOUNT). */
const ACCOUNT = "ACCOUNT";
function resolveDomain(domain: string | { "Fn::Join": [string, Array<string | { Ref: string }>] }): string {
  if (typeof domain === "string") return domain;
  return domain["Fn::Join"][1].map((part) => (typeof part === "string" ? part : (expect(part).toEqual({ Ref: "AWS::AccountId" }), ACCOUNT))).join(domain["Fn::Join"][0]);
}

const domainListOf = (template: Template, rule: Rule): [string, Resource] => {
  const list = resourcesOf(template, "AWS::Route53Resolver::FirewallDomainList").find(([id]) => JSON.stringify(rule.FirewallDomainListId).includes(id));
  expect(list).toBeDefined();
  return list!;
};

function ruleGroup(template: Template): { allow: Rule; project: Rule; block: Rule; allowDomains: string[]; blockDomains: string[] } {
  const groups = resourcesOf(template, "AWS::Route53Resolver::FirewallRuleGroup");
  expect(groups).toHaveLength(1);
  const rules = groups[0]![1].Properties.FirewallRules as Rule[];
  expect(rules.map((rule) => rule.Priority).sort()).toStrictEqual([100, 150, 200]);
  const allow = rules.find((rule) => rule.Priority === 100)!;
  const project = rules.find((rule) => rule.Priority === 150)!;
  const block = rules.find((rule) => rule.Priority === 200)!;
  const domainsOf = (rule: Rule): string[] => (domainListOf(template, rule)[1].Properties.Domains as Array<string | { "Fn::Join": [string, Array<string | { Ref: string }>] }>).map(resolveDomain);
  return { allow, project, block, allowDomains: domainsOf(allow), blockDomains: domainsOf(block) };
}

describe("agent DNS firewall (cloud installs)", () => {
  const template = foundation({ agentxEnv: "staging", agentxCloud: true });

  it("allows the default list at priority 100 and blocks everything else with NXDOMAIN at priority 200", () => {
    const { allow, block, allowDomains, blockDomains } = ruleGroup(template);
    expect(allow).toMatchObject({ Action: "ALLOW", Priority: 100 });
    expect(block).toMatchObject({ Action: "BLOCK", BlockResponse: "NXDOMAIN", Priority: 200 });
    // The default list without its broad entries, plus this install's own AWS hosts (the template's region is us-east-1).
    expect(allowDomains).toStrictEqual(hostedAgentAllowDomains("us-east-1", ACCOUNT));
    expect(blockDomains).toStrictEqual(["*"]);
  });

  it("keeps the binding default list, including what the model proxy and the Slack orchestrator in the same VPC need", () => {
    for (const domain of [
      "github.com", "ghcr.io", "*.ghcr.io", "pkg-containers.githubusercontent.com",
      "registry.npmjs.org", "registry.yarnpkg.com", "pypi.org", "files.pythonhosted.org", "crates.io", "*.crates.io",
      "proxy.golang.org", "sum.golang.org", "repo.maven.apache.org", "repo1.maven.org", "rubygems.org", "*.rubygems.org",
      "deb.debian.org", "security.debian.org", "archive.ubuntu.com", "ports.ubuntu.com", "security.ubuntu.com", "dl-cdn.alpinelinux.org",
      "registry-1.docker.io", "auth.docker.io", "production.cloudflare.docker.com", "production.cloudfront.docker.com",
      "docker-images-prod.6aa30f8b08e16409b46e0173d6de2f56.r2.cloudflarestorage.com",
      "mcr.microsoft.com", "*.data.mcr.microsoft.com", "nodejs.org",
      "api.anthropic.com", "api.openai.com", "chatgpt.com", "auth.openai.com", "openrouter.ai",
      "slack.com", "*.slack.com", "api.linear.app", "mcp.linear.app", "*.atlassian.net", "app.asana.com",
    ]) expect(narrowedDefaultAllowDomains()).toContain(domain);
    expect(DEFAULT_AGENT_ALLOW_DOMAINS).toHaveLength(new Set(DEFAULT_AGENT_ALLOW_DOMAINS).size);
  });

  it("follows CNAME chains only from allowed names (found live: Docker Hub's auth.docker.io CNAMEs to Cloudflare)", () => {
    const { allow, block } = ruleGroup(foundation({ agentxEnv: "staging", agentxCloud: true }));
    expect(allow.FirewallDomainRedirectionAction).toBe("TRUST_REDIRECTION_DOMAIN");
    expect(block.FirewallDomainRedirectionAction).toBeUndefined();
  });

  it("lets machines resolve their own VPC names and nothing wider (found live on staging: hostname lookups were blocked)", () => {
    for (const domain of ["*.compute.internal", "*.ec2.internal", "*.42.10.in-addr.arpa"]) expect(DEFAULT_AGENT_ALLOW_DOMAINS).toContain(domain);
    // A public reverse zone would let a query for <data>.<attacker IP>.in-addr.arpa reach the attacker's name server.
    expect(DEFAULT_AGENT_ALLOW_DOMAINS).not.toContain("*.in-addr.arpa");
    expect(DEFAULT_AGENT_ALLOW_DOMAINS).not.toContain("*.arpa");
    expect(narrowedDefaultAllowDomains()).not.toContain("*.r2.cloudflarestorage.com");
    expect(AGENTX_PRODUCTION_VPC_CIDR).toBe("10.42.0.0/16");
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
    expect(names).toHaveLength(6);
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

  it("serves the approved extra domains from a second ALLOW list at priority 150, between the defaults (100) and BLOCK (200), that CloudFormation never resets", () => {
    const { allow, project, block } = ruleGroup(template);
    expect(project).toMatchObject({ Action: "ALLOW", Priority: 150, FirewallDomainRedirectionAction: "TRUST_REDIRECTION_DOMAIN" });
    expect(project).not.toHaveProperty("BlockResponse");
    expect(project.Priority).toBeGreaterThan(allow.Priority);
    expect(project.Priority).toBeLessThan(block.Priority);
    const [listId, list] = domainListOf(template, project);
    // No Domains property at all: the broker owns the contents (UpdateFirewallDomains), and an update of this template cannot reset them.
    expect(list.Properties).not.toHaveProperty("Domains");
    expect(list.Properties).not.toHaveProperty("DomainFileUrl");
    expect(list.Properties.Name).toBe("agentx-staging-project-allow");
    expect(listId).not.toBe(domainListOf(template, allow)[0]);
    // The BLOCK rule is untouched.
    expect(block.FirewallDomainRedirectionAction).toBeUndefined();
  });

  it("outputs the project list's id for the control plane", () => {
    const [listId] = domainListOf(template, ruleGroup(template).project);
    const outputs = template.toJSON().Outputs as Record<string, { Value: unknown }>;
    expect(outputs.ProjectAllowListId).toStrictEqual({ Value: { "Fn::GetAtt": [listId, "Id"] } });
  });

  it("does not turn on fail-open, so a Resolver firewall fault fails closed", () => {
    expect(resourcesOf(template, "AWS::Route53Resolver::FirewallConfig")).toHaveLength(0);
  });

  it("adds the domains of the agentxEgressAllowDomains context to the allow list", () => {
    const extended = foundation({ agentxEnv: "staging", agentxCloud: true, agentxEgressAllowDomains: "artifactory.acme.dev, *.pkg.acme.dev,,github.com" });
    const { allowDomains } = ruleGroup(extended);
    expect(allowDomains).toStrictEqual([...hostedAgentAllowDomains("us-east-1", ACCOUNT), "artifactory.acme.dev", "*.pkg.acme.dev"]);
  });

  it("rejects an operator's extra wildcard over AWS or GitHub names, and takes an exact host of theirs", () => {
    for (const entry of ["*.amazonaws.com", "*.github.com", "*.githubusercontent.com", "*.aws", "*.GitHub.com"]) {
      expect(() => foundation({ agentxEnv: "staging", agentxCloud: true, agentxEgressAllowDomains: `artifactory.acme.dev, ${entry}` }), entry).toThrow(/agentxEgressAllowDomains entry/);
    }
    const { allowDomains } = ruleGroup(foundation({ agentxEnv: "staging", agentxCloud: true, agentxEgressAllowDomains: "dynamodb.eu-west-1.amazonaws.com, *.acme.dev" }));
    expect(allowDomains.slice(-2)).toStrictEqual(["dynamodb.eu-west-1.amazonaws.com", "*.acme.dev"]);
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
    expect(Object.keys((foundation({ agentxEnv: "staging" }).toJSON().Outputs ?? {}) as object)).not.toContain("ProjectAllowListId");
    expect(firewallTypes(foundation({}))).toStrictEqual([]);
    expect(firewallTypes(foundation({ agentxCloud: true }))).toStrictEqual([]);
    expect(firewallTypes(foundation({ agentxEnv: "staging", agentxEgressAllowDomains: "artifactory.acme.dev" }))).toStrictEqual([]);
  });
});


// Plan 2, Task 19: the control plane learns the project list's id from the foundation (the same way it learns the VPC, the subnets and the worker
// security group: a foundation stack output the deploy passes on as a control plane parameter) and lets the broker update that one list.
type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown };
type Schedule = { Properties: { ScheduleExpression: string; State: string; Target: { Arn: unknown; RoleArn: unknown; Input: string } } };

function controlPlane(context: Record<string, unknown>): Template {
  const app = buildAgentXApp(context);
  const stack = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane");
  return Template.fromStack(stack!);
}

const statementsOf = (template: Template): Array<[string, Statement]> =>
  [...resourcesOf(template, "AWS::IAM::Policy"), ...resourcesOf(template, "AWS::IAM::ManagedPolicy")]
    .flatMap(([id, resource]) => ((resource.Properties.PolicyDocument as { Statement: Statement[] }).Statement).map((statement): [string, Statement] => [id, statement]));
const actionsOf = (statement: Statement): string[] => (Array.isArray(statement.Action) ? statement.Action : [statement.Action]);
const resolverStatements = (template: Template) => statementsOf(template).filter(([, statement]) => actionsOf(statement).some((action) => action.startsWith("route53resolver:")));
const brokerEnvironment = (template: Template): Record<string, unknown> => {
  const broker = resourcesOf(template, "AWS::Lambda::Function").find(([id]) => id.startsWith("Broker") && !id.includes("ServiceRole"))!;
  return (broker[1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
};

describe("the project allow list in the control plane (cloud installs)", () => {
  const template = controlPlane({ agentxEnv: "staging", agentxCloud: true });

  it("takes the list's id as a parameter, which the broker receives", () => {
    const parameters = template.toJSON().Parameters as Record<string, { Type: string; Default?: unknown }>;
    expect(parameters.ProjectAllowListId).toMatchObject({ Type: "String" });
    expect(parameters.ProjectAllowListId).not.toHaveProperty("Default");
    // In the broker's names (its variables are held to Lambda's 4 KB); the broker puts it back as AGENT_PROJECT_ALLOW_LIST_ID.
    expect(brokerNamesIn(brokerEnvironment(template)).projectAllowList).toStrictEqual({ Ref: "ProjectAllowListId" });
    expect(brokerEnvironment(template)).not.toHaveProperty("AGENT_PROJECT_ALLOW_LIST_ID");
  });

  it("lets only the broker update and read that one list: exact actions, the list's ARN, no wildcard, and no other role", () => {
    const found = resolverStatements(template);
    expect(found).toHaveLength(1);
    const [policyId, statement] = found[0]!;
    expect(actionsOf(statement).sort()).toStrictEqual(["route53resolver:GetFirewallDomainList", "route53resolver:UpdateFirewallDomains"]);
    expect(statement.Effect).toBe("Allow");
    // arn:<partition>:route53resolver:<region>:<account>:firewall-domain-list/<the parameter>, and nothing wider.
    const resource = JSON.stringify(statement.Resource);
    expect(resource).toContain("firewall-domain-list/");
    expect(resource).toContain('{"Ref":"ProjectAllowListId"}');
    expect(typeof statement.Resource).toBe("object");
    expect(Array.isArray(statement.Resource)).toBe(false);
    expect(resource).not.toContain("*");
    // A broker grant like the others (ruling M2): it sits in the broker's "integrations" managed policy group, attached to the broker's role only.
    const policy = resourcesOf(template, "AWS::IAM::ManagedPolicy").find(([id]) => id === policyId)![1];
    expect(policy.Properties.ManagedPolicyName).toBe("agentx-staging-broker-integrations");
    const roles = policy.Properties.Roles as Array<{ Ref: string }>;
    expect(roles).toHaveLength(1);
    const brokerRole = resourcesOf(template, "AWS::Lambda::Function").find(([id]) => id.startsWith("Broker") && !id.includes("ServiceRole"))![1].Properties.Role as { "Fn::GetAtt": [string, string] };
    expect(roles[0]!.Ref).toBe(brokerRole["Fn::GetAtt"][0]);
    // And no inline policy of its own is left for it.
    expect(resourcesOf(template, "AWS::IAM::Policy").map(([id]) => id)).not.toContain("BrokerProjectAllowListPolicy");
  });

  it("runs the broker's egress-domains-sync every 5 minutes, through the same role as the other recovery schedules", () => {
    const schedules = resourcesOf(template, "AWS::Scheduler::Schedule") as unknown as Array<[string, Schedule]>;
    const sync = schedules.filter(([id]) => id.startsWith("EgressDomainsSyncSchedule"));
    expect(sync).toHaveLength(1);
    const [, schedule] = sync[0]!;
    expect(schedule.Properties).toMatchObject({ ScheduleExpression: "rate(5 minutes)", State: "ENABLED" });
    expect(JSON.parse(schedule.Properties.Target.Input)).toStrictEqual({ source: "agentx.egress-domains-sync" });
    const recovery = schedules.find(([id]) => id.startsWith("GithubWebhookRecoverySchedule"))![1];
    expect(schedule.Properties.Target.Arn).toStrictEqual(recovery.Properties.Target.Arn);
    expect(schedule.Properties.Target.RoleArn).toStrictEqual(recovery.Properties.Target.RoleArn);
  });

  it("has none of it without agentxCloud, in a named or legacy environment", () => {
    for (const context of [{ agentxEnv: "staging" }, {}, { agentxCloud: true }]) {
      const plain = controlPlane(context);
      expect(Object.keys(plain.toJSON().Parameters as object)).not.toContain("ProjectAllowListId");
      expect(brokerEnvironment(plain)).not.toHaveProperty("AGENT_PROJECT_ALLOW_LIST_ID");
      expect(brokerNamesIn(brokerEnvironment(plain))).not.toHaveProperty("projectAllowList");
      expect(resolverStatements(plain)).toStrictEqual([]);
      expect(resourcesOf(plain, "AWS::Scheduler::Schedule").map(([id]) => id).filter((id) => id.startsWith("EgressDomainsSync"))).toStrictEqual([]);
    }
  });
});

// DEFAULT-ALLOW-LIST-EXFIL (0.5.15): the allow-list a hosted install's DNS firewall carries lets no one's upload target through by name.
describe("the hosted install's allow-list does not carry an exit for an injected agent", () => {
  const region = "us-west-2";
  // Route 53 Resolver DNS Firewall reads a leading `*.` as any subdomain at any depth, and never the bare domain.
  const allowed = (host: string, list: readonly string[]): boolean => list.some((entry) => (entry.startsWith("*.") ? host.endsWith(entry.slice(1)) && host.length > entry.length - 1 : host === entry));

  it("pins the exact AWS hosts of an install in us-west-2 (this account's registry, and the company-source regions)", () => {
    const own = [
      "dynamodb.us-west-2.amazonaws.com", "sqs.us-west-2.amazonaws.com", "s3.us-west-2.amazonaws.com", "*.s3.us-west-2.amazonaws.com",
      "al2023-repos-us-west-2-de612dc2.s3.dualstack.us-west-2.amazonaws.com", "kms.us-west-2.amazonaws.com", "ssm.us-west-2.amazonaws.com", "ec2.us-west-2.amazonaws.com",
      "states.us-west-2.amazonaws.com", "lambda.us-west-2.amazonaws.com", "email.us-west-2.amazonaws.com", "secretsmanager.us-west-2.amazonaws.com", "scheduler.us-west-2.amazonaws.com",
      "sts.us-west-2.amazonaws.com", "sts.amazonaws.com", "monitoring.us-west-2.amazonaws.com", "logs.us-west-2.amazonaws.com", "api.ecr.us-west-2.amazonaws.com",
      "123456789012.dkr.ecr.us-west-2.amazonaws.com", "bedrock-runtime.us-west-2.amazonaws.com", "bedrock.us-west-2.amazonaws.com", "servicequotas.us-west-2.amazonaws.com",
      "*.execute-api.us-west-2.amazonaws.com", "*.us-west-2.elb.amazonaws.com", "*.us-west-2.rds.amazonaws.com",
    ];
    const list = hostedAwsAllowDomains(region, "123456789012");
    expect(list.slice(0, own.length)).toStrictEqual(own);
    // Then Bedrock and STS in every region a company source can name, each exact, and nothing else.
    expect(list.slice(own.length).every((host) => /^(bedrock-runtime|bedrock|sts)\.[a-z0-9-]+\.amazonaws\.com$/u.test(host))).toBe(true);
    // Three hosts for each region, less the install's own three already listed above.
    expect(list.slice(own.length)).toHaveLength(BEDROCK_SOURCE_REGIONS.length * 3 - 3);
    expect(list).not.toContain("ecs.us-west-2.amazonaws.com");
    expect(hostedAwsAllowDomains(region).some((host) => host.includes(".dkr.ecr."))).toBe(false);
  });

  it("serves Bedrock and STS in every region a company's AI source can name, by exact host", () => {
    const list = hostedAgentAllowDomains(region);
    for (const other of BEDROCK_SOURCE_REGIONS) for (const host of [`bedrock-runtime.${other}.amazonaws.com`, `bedrock.${other}.amazonaws.com`, `sts.${other}.amazonaws.com`]) expect(allowed(host, list), host).toBe(true);
    // Only those three services in another region: nothing else of AWS's there.
    for (const host of ["dynamodb.eu-west-1.amazonaws.com", "s3.eu-west-1.amazonaws.com", "x.s3.eu-west-1.amazonaws.com", "x.execute-api.eu-west-1.amazonaws.com", "ecr.eu-west-1.amazonaws.com", "x.dkr.ecr.eu-west-1.amazonaws.com"]) expect(allowed(host, list), host).toBe(false);
  });

  it("has no AWS or GitHub wildcard, even when the pinned copy of Code's list still carries them", () => {
    const old = ["*.amazonaws.com", "*.aws", "github.com", "*.github.com", "*.githubusercontent.com", "ghcr.io"];
    expect(narrowedDefaultAllowDomains(old)).toStrictEqual(["github.com", "ghcr.io", "pkg-containers.githubusercontent.com", "raw.githubusercontent.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "codeload.github.com"]);
    // Code's narrowed list (the pin after Code's lane) passes through unchanged.
    const narrowed = ["github.com", "ghcr.io", "*.ghcr.io", "pkg-containers.githubusercontent.com", "raw.githubusercontent.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "codeload.github.com"];
    expect(narrowedDefaultAllowDomains(narrowed)).toStrictEqual(narrowed);
    expect(BROAD_DEFAULT_ALLOW_ENTRIES).toStrictEqual(["*.amazonaws.com", "*.aws", "*.github.com", "*.githubusercontent.com"]);
    const list = hostedAgentAllowDomains(region);
    for (const entry of BROAD_DEFAULT_ALLOW_ENTRIES) expect(list, entry).not.toContain(entry);
    expect(list.filter((entry) => entry.includes("github"))).toStrictEqual(["github.com", "pkg-containers.githubusercontent.com", "raw.githubusercontent.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "codeload.github.com"]);
  });

  it("does not resolve an attacker's bucket by the global name or in another region, nor GitHub's API, gist, raw or release hosts", () => {
    const list = hostedAgentAllowDomains(region);
    for (const host of [
      "attacker-bucket.s3.amazonaws.com", "attacker-bucket.s3.eu-west-1.amazonaws.com", "s3.amazonaws.com", "s3.eu-west-1.amazonaws.com", "dynamodb.eu-west-1.amazonaws.com",
      "x.execute-api.eu-west-1.amazonaws.com", "x.lambda-url.us-west-2.on.aws", "x.api.aws", "999999999999.dkr.ecr.us-west-2.amazonaws.com",
      "api.github.com", "gist.github.com", "uploads.github.com", "gist.githubusercontent.com", "user-images.githubusercontent.com",
    ]) expect(allowed(host, list), host).toBe(false);
  });

  it("still resolves what the machines need: git, image pulls, the regional AWS names, the install's own load balancer and database", () => {
    const list = hostedAgentAllowDomains(region, "123456789012");
    for (const host of [
      "github.com", "ghcr.io", "pkg-containers.githubusercontent.com", "raw.githubusercontent.com", "codeload.github.com", "registry.npmjs.org", "bedrock-runtime.us-west-2.amazonaws.com", "dynamodb.us-west-2.amazonaws.com",
      "123456789012.dkr.ecr.us-west-2.amazonaws.com", "prod-us-west-2-starport-layer-bucket.s3.us-west-2.amazonaws.com", "al2023-repos-us-west-2-de612dc2.s3.dualstack.us-west-2.amazonaws.com",
      "abc123.execute-api.us-west-2.amazonaws.com", "internal-model-1.us-west-2.elb.amazonaws.com", "db.cluster-xyz.us-west-2.rds.amazonaws.com", "sts.amazonaws.com",
    ]) expect(allowed(host, list), host).toBe(true);
  });

  it("refuses a region that is not a region name (the list is built from it)", () => {
    for (const bad of ["", "us-west", "us-west-2.amazonaws.com", "*", "US-WEST-2"]) expect(() => hostedAwsAllowDomains(bad), bad).toThrow(/AWS region/);
  });

  it("writes the narrowed list into the template of a hosted install in another region", () => {
    const { allowDomains } = ruleGroup(foundation({ agentxEnv: "staging", agentxCloud: true, agentxRegion: region }));
    expect(allowDomains).toStrictEqual(hostedAgentAllowDomains(region, ACCOUNT));
    expect(allowDomains).not.toContain("*.amazonaws.com");
    expect(allowDomains).not.toContain("*.aws");
    expect(allowDomains).not.toContain("*.github.com");
    expect(allowDomains).not.toContain("*.githubusercontent.com");
    expect(allowDomains).toContain("bedrock-runtime.us-west-2.amazonaws.com");
    // The install's own region is not special for a company source: Bedrock in us-east-1 is served too, by exact host.
    expect(allowDomains).toContain("bedrock-runtime.us-east-1.amazonaws.com");
    expect(allowDomains).toContain(`${ACCOUNT}.dkr.ecr.us-west-2.amazonaws.com`);
    expect(allowDomains.filter((domain) => domain.includes(".dkr.ecr."))).toStrictEqual([`${ACCOUNT}.dkr.ecr.us-west-2.amazonaws.com`]);
  });
});
