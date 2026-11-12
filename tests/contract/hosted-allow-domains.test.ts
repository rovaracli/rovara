// DEFAULT-ALLOW-LIST-EXFIL (0.5.15), the parts that live outside the firewall template: the one list the firewall and the broker share, the Bedrock regions a company source
// can name, and the broad names a project's approval may never reopen (one approval is cell-wide).
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { UpdateFirewallDomainsCommand } from "@aws-sdk/client-route53resolver";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BEDROCK_SOURCE_REGIONS, hostedAgentAllowDomains, installDefaultAllowDomains, isBroadAllowedDomain, isServableAllowedDomain, narrowedDefaultAllowDomains } from "@agentx/cloud-contracts";
import { EGRESS_SYNC_KEY, ModelSourceInputSchema, egressDomainsKey, isAllowedDomain, type EgressOwner } from "@rovara-code/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";
import { hostAlreadyAllowed } from "../../packages/broker/src/rovara-code/setup-host-ask.js";
import { installDefaultDomains } from "../../packages/broker/src/org/install-default-allow-domains.js";
import { planProjectEgressChange } from "../../packages/broker/src/org/project-egress-plan.js";
import { putEgressDomains, type EgressDomainsDependencies } from "../../packages/broker/src/org/egress-domains.js";
import { syncCellAllowList } from "../../packages/broker/src/aws/egress-domains-sync.js";

skipLambdaBundling();

const REGION = "us-west-2";
const allowed = (host: string, list: readonly string[]): boolean => list.some((entry) => (entry.startsWith("*.") ? host.endsWith(entry.slice(1)) && host.length > entry.length - 1 : host === entry));

let saved: string | undefined;
beforeEach(() => { saved = process.env.AWS_REGION; process.env.AWS_REGION = REGION; vi.spyOn(console, "log").mockImplementation(() => undefined); });
afterEach(() => { if (saved === undefined) delete process.env.AWS_REGION; else process.env.AWS_REGION = saved; vi.restoreAllMocks(); });

function firewallAllowList(): string[] {
  const app = buildAgentXApp({ agentxEnv: "staging", agentxCloud: true, agentxRegion: REGION });
  const stack = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXProductionFoundation")!;
  const resources = Template.fromStack(stack).toJSON().Resources as Record<string, { Type: string; Properties: { Name?: string; Domains?: unknown[] } }>;
  const list = Object.values(resources).find((resource) => resource.Type === "AWS::Route53Resolver::FirewallDomainList" && resource.Properties.Name === "agentx-staging-allow")!;
  // This account's registry is a Ref in the template; the broker does not know the account, so that one name is left out of the comparison.
  return (list.Properties.Domains as unknown[]).filter((domain): domain is string => typeof domain === "string");
}

describe("the broker's 'already allowed' agrees with the firewall's list", () => {
  it("is the same set of names (the firewall's, less this account's registry host, which the broker cannot know)", () => {
    const firewall = firewallAllowList();
    expect([...installDefaultDomains()].sort()).toStrictEqual([...firewall].sort());
    expect([...installDefaultDomains()].sort()).toStrictEqual([...hostedAgentAllowDomains(REGION)].sort());
  });

  it("answers a host the way the firewall would resolve it", () => {
    const firewall = firewallAllowList();
    const hosts = [
      "api.github.com", "gist.github.com", "uploads.github.com", "github.com", "codeload.github.com", "raw.githubusercontent.com", "gist.githubusercontent.com", "ghcr.io",
      "x.s3.amazonaws.com", "x.s3.eu-west-1.amazonaws.com", "x.s3.us-west-2.amazonaws.com", "dynamodb.us-west-2.amazonaws.com", "dynamodb.eu-west-1.amazonaws.com",
      "bedrock-runtime.eu-west-1.amazonaws.com", "x.api.aws", "registry.npmjs.org", "pypi.org", "api.anthropic.com", "artifactory.acme.dev",
    ];
    for (const host of hosts) expect(hostAlreadyAllowed(host, []), host).toBe(allowed(host, firewall));
    // The two that matter: a name that only the old wildcards served is no longer 'already allowed', so a project that needs it asks.
    expect(hostAlreadyAllowed("api.github.com", [])).toBe(false);
    expect(hostAlreadyAllowed("x.s3.eu-west-1.amazonaws.com", [])).toBe(false);
  });

  it("makes a project's ask for a name the old wildcards covered a real request, not a silent 'already allowed'", async () => {
    const db = { send: async () => ({}) };
    const plan = await planProjectEgressChange({ documentClient: db, tableName: "state", cloud: true, now: () => new Date("2026-11-11T10:00:00.000Z") }, { orgId: TEST_ORG, project: "web", actorId: "dev-1", domains: ["api.github.com", "codeload.github.com", "dynamodb.us-west-2.amazonaws.com"] });
    expect(plan.pending).toEqual(["api.github.com"]);
  });

  it("falls back to the default list without regional AWS names when the region is not a region", () => {
    expect(installDefaultAllowDomains(undefined)).toStrictEqual(narrowedDefaultAllowDomains());
    expect(installDefaultAllowDomains("nowhere")).toStrictEqual(narrowedDefaultAllowDomains());
    expect(installDefaultAllowDomains(REGION)).toStrictEqual(hostedAgentAllowDomains(REGION));
  });
});

describe("the Bedrock regions of the firewall and the company AI sources agree", () => {
  const source = (region: string) => ModelSourceInputSchema.safeParse({ kind: "bedrock", label: "Company Bedrock", roleArn: "arn:aws:iam::123456789012:role/rovara-bedrock", region, models: [] });
  const regionIssues = (region: string) => (source(region).error?.issues ?? []).filter((issue) => issue.path[0] === "region");

  it("accepts every pinned region as a source's region (the schema's own rule), with no duplicate", () => {
    for (const region of BEDROCK_SOURCE_REGIONS) expect(regionIssues(region), region).toHaveLength(0);
    expect(new Set(BEDROCK_SOURCE_REGIONS).size).toBe(BEDROCK_SOURCE_REGIONS.length);
  });

  it("is a control: the schema does refuse something that is not a region", () => {
    for (const bad of ["", "us-east", "US-EAST-1", "us-east-1.amazonaws.com"]) expect(regionIssues(bad).length, bad).toBeGreaterThan(0);
  });

  it("serves a company's Bedrock source in a region other than the install's", () => {
    const list = hostedAgentAllowDomains(REGION);
    for (const region of BEDROCK_SOURCE_REGIONS) for (const service of ["bedrock-runtime", "bedrock", "sts"]) expect(allowed(`${service}.${region}.amazonaws.com`, list), `${service}.${region}`).toBe(true);
  });
});

describe("broad names are never asked for, stored or sent to the firewall", () => {
  const BROAD = ["*.amazonaws.com", "*.aws", "*.github.com", "*.githubusercontent.com", "*.s3.amazonaws.com", "*.execute-api.us-west-2.amazonaws.com", "*.on.aws", "*.cn-north-1.amazonaws.com.cn"];
  const EXACT = ["dynamodb.eu-west-1.amazonaws.com", "api.github.com", "raw.githubusercontent.com", "artifacts.acme.dev", "*.acme.dev", "*.mygithub.com", "notgithub.com"];

  it("tells a broad name from an exact host and from another company's wildcard", () => {
    for (const domain of BROAD) expect(isBroadAllowedDomain(domain), domain).toBe(true);
    for (const domain of EXACT) expect(isBroadAllowedDomain(domain), domain).toBe(false);
    expect(isBroadAllowedDomain("*.GitHub.com")).toBe(true);
    expect(isServableAllowedDomain("dynamodb.eu-west-1.amazonaws.com")).toBe(true);
    expect(isServableAllowedDomain("*.amazonaws.com")).toBe(false);
    expect(isServableAllowedDomain("*")).toBe(false);
  });

  const db = { send: async () => ({}) };
  const deps = { documentClient: db, tableName: "state", cloud: true, now: () => new Date("2026-11-11T10:00:00.000Z") };

  // Code's own check (`isAllowedDomain`, the Public Suffix List) already refuses some of them (`*.githubusercontent.com`, `*.s3.amazonaws.com`, a bare TLD); these two pass it, which is the gap.
  const PASS_CODES_CHECK = ["*.amazonaws.com", "*.github.com"];

  it("is a gap Code's check leaves: these wildcards are shaped like names it accepts", () => {
    for (const domain of PASS_CODES_CHECK) expect(isAllowedDomain(domain), domain).toBe(true);
  });

  it("refuses a project's request for one (the plan, so a settings save and a proposal stop there)", async () => {
    for (const domain of BROAD) {
      const asked = planProjectEgressChange(deps, { orgId: TEST_ORG, project: "web", actorId: "dev-1", domains: ["ok.acme.dev", domain] });
      if (PASS_CODES_CHECK.includes(domain)) await expect(asked, domain).rejects.toThrow(/wildcard over AWS or GitHub/);
      else await expect(asked, domain).rejects.toThrow();
    }
    await expect(planProjectEgressChange(deps, { orgId: TEST_ORG, project: "web", actorId: "dev-1", domains: ["dynamodb.eu-west-1.amazonaws.com", "*.acme.dev"] })).resolves.toMatchObject({ pending: ["*.acme.dev", "dynamodb.eu-west-1.amazonaws.com"] });
  });

  it("refuses to store one for any owner, whoever asks", async () => {
    const table = new FakeDynamoDb();
    const putDeps: EgressDomainsDependencies = { documentClient: table, tableName: "state", cloud: false, now: () => new Date("2026-11-11T10:00:00.000Z"), sync: async () => ({ ok: true }) };
    for (const domain of PASS_CODES_CHECK) {
      await expect(putEgressDomains(putDeps, TEST_ORG, { kind: "project", project: "web" }, ["ok.acme.dev", domain], { developerId: "dev-1" }), domain).rejects.toThrow(/wildcard over AWS or GitHub/);
    }
    expect(table.get(egressDomainsKey(TEST_ORG, { kind: "project", project: "web" }))).toBeUndefined();
  });

  it("drops one already stored and approved before it reaches the firewall (the sync's last line, and why one approval cannot reopen the cell)", async () => {
    const table = new FakeDynamoDb();
    const WEB: EgressOwner = { kind: "project", project: "web" };
    const entries = [...BROAD, "ok.acme.dev", "dynamodb.eu-west-1.amazonaws.com"].map((domain) => ({ domain, status: "approved", requestedAt: "2026-10-01T00:00:00.000Z", requestedBy: "dev-1" }));
    table.set({ ...egressDomainsKey(TEST_ORG, WEB), entityType: "EGRESS_DOMAINS", orgId: TEST_ORG, owner: WEB, active: true, domains: entries, updatedAt: "2026-10-01T00:00:00.000Z" });
    table.set({ ...EGRESS_SYNC_KEY, entityType: "EGRESS_SYNC", dirtyAt: "2026-10-01T00:00:00.000Z", dirtySeq: 1 });
    const sent: Array<{ Domains: string[] }> = [];
    const resolver = { send: vi.fn(async (command: { constructor: { name: string }; input: { Domains: string[] } }) => {
      if (command.constructor.name === UpdateFirewallDomainsCommand.name) { sent.push(command.input); return { Id: "l", Status: "UPDATING" }; }
      return { FirewallDomainList: { Id: "l", Status: "COMPLETE" } };
    }) };
    const result = await syncCellAllowList({ documentClient: table, tableName: "state", resolver: resolver as never, listId: "rslvr-fdl-0123456789abcdef", now: () => new Date("2026-11-11T10:00:00.000Z"), sleep: async () => undefined });
    expect(result).toEqual({ ok: true, domains: 2 });
    expect(sent.at(-1)!.Domains).toEqual(["dynamodb.eu-west-1.amazonaws.com", "ok.acme.dev"]);
  });
});
