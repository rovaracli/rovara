// N9 (INTG2): the broker's access to the CodeArtifact domains a project's registries may name. Read from CDK context (`rovaraCodeArtifactDomains`), checked at synth, and off by
// default: with no domain given nothing is granted, the broker setting `projectRegistries` is absent (OFF), and the templates are unchanged.
//
// Least privilege, from the AWS docs (https://docs.aws.amazon.com/codeartifact/latest/ug/security_iam_id-based-policy-examples.html and
// auth-and-access-control-permissions-reference.html):
//   - `codeartifact:GetAuthorizationToken` on the named domain ARN(s) only. A domain of another account, or another region, is not reachable.
//   - `sts:GetServiceBearerToken` is required beside it. The docs give it `Resource: "*"` and scope it with `sts:AWSServiceName = codeartifact.amazonaws.com`; it takes no
//     resource ARN, so the DOMAIN is named on the statement above. Here it is also held to `sts:DurationSeconds` between 900 and 3600, so IAM itself refuses a token the broker's
//     code should never ask for (the 12-hour default, or 0 = the role session's lifetime). 3600 is REGISTRY_TOKEN_SECONDS.
//   - `codeartifact:ReadFromRepository` on the named domain's repositories: a token carries the permissions of the identity that minted it, so read is what the token can do.
//     Nothing else is allowed, so publish, delete and every other write is refused by the absence of an Allow. [verify in the test environment: a minted token can read and cannot publish]
import { Token } from "aws-cdk-lib";
import { REGISTRY_TOKEN_SECONDS } from "@agentx/contracts";

export const CODEARTIFACT_DOMAINS_CONTEXT_KEY = "rovaraCodeArtifactDomains";
export interface RegistryDomain { readonly name: string; readonly owner: string; readonly region: string }

const NAME = /^[a-z][a-z0-9-]{0,48}[a-z0-9]$/;
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
const MAX_DOMAINS = 8;

/** `domain:account:region`, comma separated (or an array of those). Anything else, a duplicate or more than 8 stops the synth. Absent or empty: none. */
export function parseCodeArtifactDomains(value: unknown): readonly RegistryDomain[] | undefined {
  if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) return undefined;
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : undefined;
  if (items === undefined) throw new Error(`${CODEARTIFACT_DOMAINS_CONTEXT_KEY} must be a list of domain:account:region`);
  const domains = items.map((item): RegistryDomain => {
    const parts = typeof item === "string" ? item.trim().split(":") : [];
    const [name, owner, region] = parts;
    if (parts.length !== 3 || name === undefined || owner === undefined || region === undefined || !NAME.test(name) || !/^\d{12}$/.test(owner) || !REGION.test(region)) {
      throw new Error(`${CODEARTIFACT_DOMAINS_CONTEXT_KEY}: each entry must be domain:account:region (a 12-digit account and a region such as us-west-2)`);
    }
    return { name, owner, region };
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
    { Sid: "RegistryRead", Effect: "Allow", Action: "codeartifact:ReadFromRepository", Resource: domains.map((domain) => arn(domain, `repository/${domain.name}/*`)) },
  ];
}
