// N9 (INTG2): the broker's IAM for CodeArtifact is least privilege and OFF by default.
//  - The statements are plain IAM JSON; a small evaluator reads exactly that text, so the tests prove what the policy allows, not what its author hoped.
//  - The switch (`rovaraCodeArtifactDomains`) is off by default: the template is unchanged and the broker setting is absent.
// AWS docs: https://docs.aws.amazon.com/codeartifact/latest/ug/security_iam_id-based-policy-examples.html , auth-and-access-control-permissions-reference.html
import { readFileSync } from "node:fs";
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { BOUND_REGISTRY_DOMAINS_VARIABLE, REGISTRY_TOKEN_SECONDS, parseBoundRegistryDomains } from "@rovara-code/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { parseCodeArtifactDomains, registryTokenStatements, type PolicyStatementJson } from "../../infra/lib/registry-access.js";
import { brokerSettingsIn } from "../support/broker-names-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const ORG = "org_abcdefghijklmnopqrst" as never;
const DOMAIN = { name: "acme", owner: "123456789012", region: "us-west-2", orgId: ORG, repositories: ["shared"] } as const;
const ENT = { edition: "enterprise", cloud: false, env: "ent" } as const;
const ENTERPRISE = { agentxEnv: "ent", rovaraEdition: "enterprise", rovaraEnterpriseEgressCidrs: "10.99.0.0/16", agentxAuditTsa: "off" } as const;
const PUBLIC = { agentxEnv: "staging", agentxCloud: true } as const;

/** A request, as IAM sees it. */
interface Request { action: string; resource: string; context?: Record<string, string | number> }
const globMatch = (pattern: string, value: string): boolean => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(value);
function conditionHolds(condition: PolicyStatementJson["Condition"], context: Record<string, string | number>): boolean {
  return Object.entries(condition ?? {}).every(([operator, keys]) => Object.entries(keys).every(([key, expected]) => {
    const actual = context[key];
    if (actual === undefined) return false;
    if (operator === "StringEquals") return actual === expected;
    if (operator === "NumericLessThanEquals") return Number(actual) <= Number(expected);
    if (operator === "NumericGreaterThanEquals") return Number(actual) >= Number(expected);
    throw new Error(`the evaluator does not know ${operator}`);
  }));
}
const allows = (statements: readonly PolicyStatementJson[], request: Request): boolean => statements.some((statement) =>
  [statement.Action].flat().some((action) => globMatch(action, request.action))
  && [statement.Resource].flat().some((resource) => globMatch(resource, request.resource))
  && conditionHolds(statement.Condition, request.context ?? {}));

const statements = registryTokenStatements([DOMAIN]);
const domainArn = "arn:aws:codeartifact:us-west-2:123456789012:domain/acme";
const mint = (over: Partial<Request> = {}): Request => ({ action: "codeartifact:GetAuthorizationToken", resource: domainArn, ...over });
const bearer = (context: Record<string, string | number>): Request => ({ action: "sts:GetServiceBearerToken", resource: "*", context });

describe("the policy text", () => {
  it("allows a token for the named domain, with the one-hour duration and the CodeArtifact service name", () => {
    expect(allows(statements, mint())).toBe(true);
    expect(allows(statements, bearer({ "sts:AWSServiceName": "codeartifact.amazonaws.com", "sts:DurationSeconds": REGISTRY_TOKEN_SECONDS }))).toBe(true);
    expect(allows(statements, { action: "codeartifact:ReadFromRepository", resource: "arn:aws:codeartifact:us-west-2:123456789012:repository/acme/shared" })).toBe(true);
  });

  it("refuses a token for another domain, another account's domain or another region", () => {
    expect(allows(statements, mint({ resource: "arn:aws:codeartifact:us-west-2:123456789012:domain/other" }))).toBe(false);
    expect(allows(statements, mint({ resource: "arn:aws:codeartifact:us-west-2:999999999999:domain/acme" }))).toBe(false);
    expect(allows(statements, mint({ resource: "arn:aws:codeartifact:us-east-1:123456789012:domain/acme" }))).toBe(false);
    expect(allows(statements, mint({ resource: "*" }))).toBe(false);
    expect(allows(statements, { action: "codeartifact:ReadFromRepository", resource: "arn:aws:codeartifact:us-west-2:123456789012:repository/other/shared" })).toBe(false);
    // S3: only the NAMED repositories of the domain, not its other repositories.
    expect(allows(statements, { action: "codeartifact:ReadFromRepository", resource: "arn:aws:codeartifact:us-west-2:123456789012:repository/acme/secret-team" })).toBe(false);
    expect(allows(statements, { action: "codeartifact:ReadFromRepository", resource: "arn:aws:codeartifact:us-west-2:123456789012:repository/acme/*" })).toBe(false);
  });

  it("refuses the bearer token for another service, for the 12-hour default, for 0 (the role session's lifetime) and when the duration is not stated", () => {
    expect(allows(statements, bearer({ "sts:AWSServiceName": "s3.amazonaws.com", "sts:DurationSeconds": 3600 }))).toBe(false);
    expect(allows(statements, bearer({ "sts:AWSServiceName": "codeartifact.amazonaws.com", "sts:DurationSeconds": 43_200 }))).toBe(false);
    expect(allows(statements, bearer({ "sts:AWSServiceName": "codeartifact.amazonaws.com", "sts:DurationSeconds": 0 }))).toBe(false);
    expect(allows(statements, bearer({ "sts:AWSServiceName": "codeartifact.amazonaws.com" }))).toBe(false);
  });

  it("allows no write: no publish, delete, copy, tag, policy or repository management, and no wildcard action", () => {
    for (const action of ["PublishPackageVersion", "PutPackageMetadata", "DeletePackage", "DeletePackageVersions", "CopyPackageVersions", "DisposePackageVersions", "UpdatePackageVersionsStatus", "PutPackageOriginConfiguration", "CreateRepository", "DeleteRepository", "CreateDomain", "DeleteDomain", "PutDomainPermissionsPolicy", "TagResource", "ListRepositories", "GetRepositoryEndpoint"]) {
      for (const resource of [domainArn, "arn:aws:codeartifact:us-west-2:123456789012:repository/acme/shared", "arn:aws:codeartifact:us-west-2:123456789012:package/acme/shared/npm//left-pad", "*"]) {
        expect(allows(statements, { action: `codeartifact:${action}`, resource }), `${action} on ${resource}`).toBe(false);
      }
    }
    const actions = statements.flatMap((statement) => [statement.Action].flat());
    expect(actions.sort()).toEqual(["codeartifact:GetAuthorizationToken", "codeartifact:ReadFromRepository", "sts:GetServiceBearerToken"]);
    expect(actions.some((action) => action.includes("*"))).toBe(false);
    expect(statements.every((statement) => statement.Effect === "Allow")).toBe(true);
  });

  it("lists each domain separately and uses the install's partition", () => {
    const two = registryTokenStatements([DOMAIN, { name: "beta", owner: "210987654321", region: "eu-west-1", orgId: ORG, repositories: ["a", "b"] }], "aws-us-gov");
    expect(two[0]!.Resource).toEqual(["arn:aws-us-gov:codeartifact:us-west-2:123456789012:domain/acme", "arn:aws-us-gov:codeartifact:eu-west-1:210987654321:domain/beta"]);
    expect(() => registryTokenStatements([DOMAIN], "aws/../x")).toThrow(/partition/);
  });
});

describe("the known limit is written down for the admin (S3)", () => {
  it("day-two.md says the token is install-wide over the listed repositories, not per project, and how to cut tokens off", () => {
    const guide = readFileSync("docs/day-two.md", "utf8");
    const section = guide.slice(guide.indexOf("## Private package registries"));
    expect(section).toContain("rovaraCodeArtifactDomains");
    expect(section).toMatch(/install-wide, not per project/);
    expect(section).toMatch(/GetAuthorizationToken. takes only a domain, an owner and a duration/);
    expect(section).toMatch(/Cutting off outstanding tokens/);
    expect(section).toMatch(/Public edition/);
  });
});

describe("the install setting", () => {
  it("reads domain:account:region:org:repositories for an Enterprise install, as a list or a comma string, and nothing set means none", () => {
    expect(parseCodeArtifactDomains(undefined, ENT)).toBeUndefined();
    expect(parseCodeArtifactDomains("", ENT)).toBeUndefined();
    expect(parseCodeArtifactDomains([], ENT)).toBeUndefined();
    expect(parseCodeArtifactDomains("acme:123456789012:us-west-2:org_abcdefghijklmnopqrst:shared", ENT)).toEqual([DOMAIN]);
    expect(parseCodeArtifactDomains(["acme:123456789012:us-west-2:org_abcdefghijklmnopqrst:shared+tools", "beta:210987654321:eu-west-1:org_abcdefghijklmnopqrst:x1"], ENT)).toHaveLength(2);
  });
  it("`install` means the install's own org", () => {
    const [domain] = parseCodeArtifactDomains("acme:123456789012:us-west-2:install:shared", ENT)!;
    expect(domain!.orgId).toMatch(/^org_[0-9a-z]{20}$/);
    expect(() => parseCodeArtifactDomains("acme:123456789012:us-west-2:install:shared", { ...ENT, env: undefined })).toThrow(/rovaraCodeArtifactDomains/);
  });
  it.each([["a wildcard", "*:123456789012:us-west-2:install:shared"], ["no repositories", "acme:123456789012:us-west-2:install"], ["a wildcard repository", "acme:123456789012:us-west-2:install:*"], ["no org", "acme:123456789012:us-west-2::shared"], ["a bad org", "acme:123456789012:us-west-2:org_short:shared"], ["a short account", "acme:12345:us-west-2:install:shared"], ["a duplicate domain", "acme:123456789012:us-west-2:install:shared,acme:123456789012:us-west-2:install:tools"], ["a repeated repository", "acme:123456789012:us-west-2:install:shared+shared"], ["a number", 5], ["five domains", Array.from({ length: 5 }, (_, i) => `d${String(i)}x:123456789012:us-west-2:install:shared`)]])("refuses %s", (_name, value) => {
    expect(() => parseCodeArtifactDomains(value, ENT)).toThrow(/rovaraCodeArtifactDomains/);
  });
  it("is refused at synth for Public, the hosted cloud and an install with no edition: a shared install cannot hold a domain for one org (B1)", () => {
    const value = "acme:123456789012:us-west-2:install:shared";
    expect(() => parseCodeArtifactDomains(value, { edition: "public", cloud: true, env: "staging" })).toThrow(/Enterprise install only|applies only to an Enterprise/);
    expect(() => parseCodeArtifactDomains(value, { edition: "public", cloud: false, env: "staging" })).toThrow(/Enterprise/);
    expect(() => parseCodeArtifactDomains(value, { edition: undefined, cloud: false, env: "staging" })).toThrow(/Enterprise/);
    expect(() => parseCodeArtifactDomains(value, { edition: "enterprise", cloud: true, env: "ent" })).toThrow(/Enterprise/);
  });
});

type Resource = { Type: string; Properties: Record<string, unknown> };
const controlPlane = (context: Record<string, unknown>): Template => {
  const stack = buildAgentXApp(context).node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane");
  return Template.fromStack(stack!);
};
const resourcesOf = (template: Template): Record<string, Resource> => template.toJSON().Resources as Record<string, Resource>;
const brokerVariables = (template: Template): Record<string, unknown> => {
  const found = Object.entries(resourcesOf(template)).find(([id, resource]) => resource.Type === "AWS::Lambda::Function" && /^Broker[0-9A-F]{8}$/.test(id));
  return (found![1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
};
/** Every IAM statement in the template, wherever the synth put it (a role's inline policy, a policy resource). */
const policyStatements = (template: Template): Array<Record<string, unknown>> => {
  const found: Array<Record<string, unknown>> = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record.Effect === "string" && record.Action !== undefined) found.push(record);
    Object.values(record).forEach(walk);
  };
  walk(template.toJSON());
  return found;
};

describe("the control plane", () => {
  it("is unchanged with the key absent or empty, on Public and on Enterprise: no statement, no setting, no variable", () => {
    for (const base of [PUBLIC, ENTERPRISE]) {
      const plain = controlPlane(base);
      expect(controlPlane({ ...base, rovaraCodeArtifactDomains: "" }).toJSON()).toStrictEqual(plain.toJSON());
      expect(JSON.stringify(plain.toJSON())).not.toMatch(/codeartifact|GetServiceBearerToken|PROJECT_REGISTRY_DOMAINS/);
      expect(Object.keys(brokerSettingsIn(brokerVariables(plain)))).not.toContain("projectRegistries");
    }
  }, 240_000);

  it("refuses the key on Public (B1): the hosted cloud shares one install between companies", () => {
    expect(() => controlPlane({ ...PUBLIC, rovaraCodeArtifactDomains: "acme:123456789012:us-west-2:install:shared" })).toThrow(/Enterprise/);
  }, 240_000);

  it("Enterprise with a domain named: the broker role gets the three statements on the named repositories only, the switch is on, and the bindings travel in one variable", () => {
    const template = controlPlane({ ...ENTERPRISE, rovaraCodeArtifactDomains: "acme:123456789012:us-west-2:install:shared+tools" });
    // The synth merges a role's statements (the Sids may go), so they are found by what they allow.
    const mine = policyStatements(template).filter((statement) => /codeartifact:|GetServiceBearerToken/.test(JSON.stringify(statement.Action)));
    const flatten = (value: unknown): string[] => [value].flat() as string[];
    const mint = mine.find((statement) => flatten(statement.Action).includes("codeartifact:GetAuthorizationToken"))!;
    expect(flatten(mint.Action)).toEqual(["codeartifact:GetAuthorizationToken"]);
    expect(JSON.stringify(mint.Resource)).toContain("codeartifact:us-west-2:123456789012:domain/acme");
    expect(JSON.stringify(mint.Resource)).not.toContain("*");
    const read = mine.find((statement) => flatten(statement.Action).includes("codeartifact:ReadFromRepository"))!;
    expect(flatten(read.Action)).toEqual(["codeartifact:ReadFromRepository"]);
    expect(JSON.stringify(read.Resource)).toContain("repository/acme/shared");
    expect(JSON.stringify(read.Resource)).toContain("repository/acme/tools");
    expect(JSON.stringify(read.Resource)).not.toContain("*");
    const bearerStatement = mine.find((statement) => flatten(statement.Action).includes("sts:GetServiceBearerToken"))!;
    expect(bearerStatement.Resource).toBe("*");
    expect(bearerStatement.Condition).toEqual({
      StringEquals: { "sts:AWSServiceName": "codeartifact.amazonaws.com" },
      NumericLessThanEquals: { "sts:DurationSeconds": REGISTRY_TOKEN_SECONDS },
      NumericGreaterThanEquals: { "sts:DurationSeconds": 900 },
    });
    const text = JSON.stringify(policyStatements(template));
    expect([...text.matchAll(/"codeartifact:[A-Za-z*]+"/g)].map((match) => match[0].slice(1, -1)).sort()).toEqual(["codeartifact:GetAuthorizationToken", "codeartifact:ReadFromRepository"]);
    expect(text.match(/sts:GetServiceBearerToken/g)).toHaveLength(1);
    expect(brokerSettingsIn(brokerVariables(template)).projectRegistries).toBe("1");
    const bound = parseBoundRegistryDomains(brokerVariables(template)[BOUND_REGISTRY_DOMAINS_VARIABLE] as string);
    expect(bound).toHaveLength(1);
    expect(bound[0]).toMatchObject({ name: "acme", repositories: ["shared", "tools"] });
  }, 240_000);
});
