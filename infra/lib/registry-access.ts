// N9 (INTG2): the broker's access to the CodeArtifact domains a project's registries may name. Read from CDK context (`rovaraCodeArtifactDomains`), checked at synth, and off by
// default: with no domain given nothing is granted, the broker setting `projectRegistries` is absent (OFF), and the templates are unchanged.
//
// Least privilege, from the AWS docs (https://docs.aws.amazon.com/codeartifact/latest/ug/security_iam_id-based-policy-examples.html and
// auth-and-access-control-permissions-reference.html):
//   - `codeartifact:GetAuthorizationToken` on the named domain ARN(s) only. A domain of another account, or another region, is not reachable.
//   - `sts:GetServiceBearerToken` is required beside it. The docs give it `Resource: "*"` and scope it with `sts:AWSServiceName = codeartifact.amazonaws.com`; it takes no
//     resource ARN, so the DOMAIN is named on the statement above. Here it is also held to `sts:DurationSeconds` between 900 and 3600, so IAM itself refuses a token the broker's
//     code should never ask for (the 12-hour default, or 0 = the role session's lifetime). 3600 is REGISTRY_TOKEN_SECONDS.
//   - `codeartifact:ReadFromRepository` on the NAMED repositories only: a token carries the permissions of the identity that minted it, so it can read those repositories and no other of the
//     domain. GetAuthorizationToken takes no scope-down parameter (the API has only domain, owner and duration), so this is the narrowest scope CodeArtifact offers: per install, not per run.
//     Nothing else is allowed, so publish, delete and every other write is refused by the absence of an Allow. [verify in the test environment: a minted token can read and cannot publish]
import { Token } from "aws-cdk-lib";
import { OrgIdSchema, REGISTRY_TOKEN_SECONDS, singleOrgIdForEnv, type BoundRegistryDomain } from "@rovara-code/contracts";

export const CODEARTIFACT_DOMAINS_CONTEXT_KEY = "rovaraCodeArtifactDomains";
/** One domain, the org that may use it, and the repositories of it that org's projects may read. */
export type RegistryDomain = BoundRegistryDomain;

const NAME = /^[a-z][a-z0-9-]{0,48}[a-z0-9]$/;
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/;
// The Lambda environment is held to 4 KB (ENV-ROOM): the bindings travel in one variable, so only a few fit.
const MAX_DOMAINS = 4;
const MAX_REPOSITORIES = 8;

/**
 * `domain:account:region:org:repo+repo`, comma separated (or an array of those). `org` is an org id (`org_` and 20 characters) or the word `install`, the install's one org (Enterprise
 * is one company per install). Repositories are named, never a wildcard: the broker's ReadFromRepository grant is exactly these, and so is everything a token can read.
 *
 * Install-wide domains are for an Enterprise install only. The Public edition is shared by many companies and a role's permissions are install-wide, so any domain listed there could
 * be named by any org: the key is refused at synth for Public and for the hosted cloud, and for an install with no edition.
 * Absent or empty: none.
 */
export function parseCodeArtifactDomains(value: unknown, install: { edition: string | undefined; cloud: boolean; env: string | undefined }): readonly RegistryDomain[] | undefined {
  if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) return undefined;
  if (install.cloud || install.edition !== "enterprise") {
    throw new Error(`${CODEARTIFACT_DOMAINS_CONTEXT_KEY} applies only to an Enterprise install (rovaraEdition=enterprise): a shared install cannot hold a CodeArtifact domain for one org`);
  }
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : undefined;
  if (items === undefined) throw new Error(`${CODEARTIFACT_DOMAINS_CONTEXT_KEY} must be a list of domain:account:region:org:repositories`);
  const domains = items.map((item): RegistryDomain => {
    const parts = typeof item === "string" ? item.trim().split(":") : [];
    const [name, owner, region, org, repositories] = parts;
    const orgId = org === "install" ? (install.env === undefined ? undefined : singleOrgIdForEnv(install.env)) : OrgIdSchema.safeParse(org).data;
    const repos = (repositories ?? "").split("+");
    if (parts.length !== 5 || name === undefined || owner === undefined || region === undefined || orgId === undefined || !NAME.test(name) || !/^\d{12}$/.test(owner) || !REGION.test(region)
      || repos.length === 0 || repos.length > MAX_REPOSITORIES || repos.some((repo) => !REPOSITORY.test(repo)) || new Set(repos).size !== repos.length) {
      throw new Error(`${CODEARTIFACT_DOMAINS_CONTEXT_KEY}: each entry must be domain:account:region:org:repo+repo (a 12-digit account, a region such as us-west-2, an org id or "install" in a named environment, and named repositories)`);
    }
    return { name, owner, region, orgId, repositories: repos };
  });
  if (domains.length > MAX_DOMAINS) throw new Error(`${CODEARTIFACT_DOMAINS_CONTEXT_KEY}: at most ${String(MAX_DOMAINS)} domains`);
  if (new Set(domains.map((domain) => `${domain.name}:${domain.owner}:${domain.region}`)).size !== domains.length) throw new Error(`${CODEARTIFACT_DOMAINS_CONTEXT_KEY}: a domain is listed twice`);
  return domains;
}

export interface PolicyStatementJson {
  Sid: string;
  Effect: "Allow";
  Action: string | string[];
  Resource: string | string[];
  Condition?: Record<string, Record<string, string | number | string[]>>;
}

/** The broker role's three statements, as plain IAM JSON (a test reads exactly this text). `partition` is `aws` (or a token in a stack). */
export function registryTokenStatements(domains: readonly RegistryDomain[], partition = "aws"): PolicyStatementJson[] {
  if (!Token.isUnresolved(partition) && !/^aws(?:-[a-z]+)*$/.test(partition)) throw new Error("registry access: the partition is not an AWS partition");
  const arn = (domain: RegistryDomain, resource: string): string => `arn:${partition}:codeartifact:${domain.region}:${domain.owner}:${resource}`;
  return [
    { Sid: "RegistryTokenMint", Effect: "Allow", Action: "codeartifact:GetAuthorizationToken", Resource: domains.map((domain) => arn(domain, `domain/${domain.name}`)) },
    {
      Sid: "RegistryTokenBearer", Effect: "Allow", Action: "sts:GetServiceBearerToken", Resource: "*",
      Condition: {
        StringEquals: { "sts:AWSServiceName": "codeartifact.amazonaws.com" },
        NumericLessThanEquals: { "sts:DurationSeconds": REGISTRY_TOKEN_SECONDS },
        NumericGreaterThanEquals: { "sts:DurationSeconds": 900 },
      },
    },
    { Sid: "RegistryRead", Effect: "Allow", Action: "codeartifact:ReadFromRepository", Resource: domains.flatMap((domain) => domain.repositories.map((repository) => arn(domain, `repository/${domain.name}/${repository}`))) },
  ];
}
