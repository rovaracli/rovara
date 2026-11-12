import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEST_ACCESS_SERVICES,
  IAM_MANAGED_POLICY_MAX_CHARS,
  RUN_NAME_PATTERN,
  RUN_RESOURCES,
  UNFENCEABLE_SERVICES,
  buildTestAccessPolicies,
  buildTrustPolicy,
  cloudFormationPolicy,
  dropSubsumed,
  policySize,
  renderPolicyTokens,
  runNamePatterns,
  terraformPolicyTemplate,
  type PolicyDocument,
  type PolicyStatement,
} from "../../packages/cloud-contracts/src/test-access-policy.js";
import { nameArnPatternsOf } from "../../packages/cloud-contracts/src/test-access-scoping.js";

const ACCOUNT = "123456789012";
const RUN = "a1b2c3d4";
const OTHER_RUN = "ffffffff";
const BOUNDARY_ARN = `arn:aws:iam::${ACCOUNT}:policy/rovara-test-boundary-rovara-org_aaaaaaaaaaaaaaaaaaaa-conn_bbbbbbbbbbbbbbbbbbbb`;
const rendered = (document: PolicyDocument, region = "us-west-2"): PolicyDocument => renderPolicyTokens(document, { Partition: "aws", Region: region, AccountId: ACCOUNT, BoundaryArn: BOUNDARY_ARN });
const policies = buildTestAccessPolicies();

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// A small evaluator of IAM identity and boundary policies, enough for the conditions the boundary uses. It answers what real IAM would for the cases the review raised: the test role, and a role a run creates.
// Missing condition keys: a positive operator does not match, a negated one does (IAM's rule). A policy variable with no value matches nothing.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
interface Request {
  readonly action: string;
  readonly resource: string;
  readonly session: "test" | "created" | "cleanup" | "untagged";
  readonly region?: string;
  readonly resourceTags?: Record<string, string>;
  readonly requestTags?: Record<string, string>;
  /** The tag keys the call sets or removes (aws:TagKeys); defaults to the keys of requestTags. */
  readonly tagKeys?: string[];
  readonly keys?: Record<string, string>;
}

const glob = (pattern: string, value: string, caseInsensitive = false): boolean => {
  const source = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*").replace(/\?/gu, ".");
  return new RegExp(`^${source}$`, caseInsensitive ? "iu" : "u").test(value);
};

function principal(session: Request["session"]): { arn: string; tags: Record<string, string> } {
  if (session === "created") return { arn: `arn:aws:sts::${ACCOUNT}:assumed-role/rv-${RUN}-fn/session`, tags: { "rovara-run": RUN } };
  if (session === "untagged") return { arn: `arn:aws:sts::${ACCOUNT}:assumed-role/Rovara-test-access-RovaraTestRole-ABC/rovara-x`, tags: {} };
  return { arn: `arn:aws:sts::${ACCOUNT}:assumed-role/Rovara-test-access-RovaraTestRole-ABC/rovara-x`, tags: { "rovara-run": RUN } };
}

function evaluateStatement(statement: PolicyStatement, request: Request): boolean {
  const who = principal(request.session);
  const substitute = (text: string): string | undefined => {
    let missing = false;
    const out = text.replace(/\$\{aws:PrincipalTag\/([^}]+)\}/gu, (_all, key: string) => {
      const value = who.tags[key];
      if (value === undefined) missing = true;
      return value ?? "";
    });
    return missing ? undefined : out;
  };
  const matchResource = (pattern: string): boolean => {
    const value = substitute(pattern);
    return value !== undefined && glob(value, request.resource);
  };
  const actionMatches = (patterns: readonly string[]): boolean => patterns.some((pattern) => glob(pattern, request.action, true));
  if (statement.Action !== undefined && !actionMatches(statement.Action)) return false;
  if (statement.NotAction !== undefined && actionMatches(statement.NotAction)) return false;
  const resources = typeof statement.Resource === "string" ? [statement.Resource] : statement.Resource;
  if (resources !== undefined && !resources.some(matchResource)) return false;
  if (statement.NotResource !== undefined && statement.NotResource.some(matchResource)) return false;
  const requestKeys = request.tagKeys ?? Object.keys(request.requestTags ?? {});
  const keyValue = (key: string): string | undefined => {
    if (key.startsWith("aws:PrincipalTag/")) return who.tags[key.slice("aws:PrincipalTag/".length)];
    if (key.startsWith("aws:ResourceTag/")) return request.resourceTags?.[key.slice("aws:ResourceTag/".length)];
    if (key.startsWith("aws:RequestTag/")) return request.requestTags?.[key.slice("aws:RequestTag/".length)];
    if (key === "aws:RequestedRegion") return request.region ?? "us-west-2";
    if (key === "aws:PrincipalArn") return who.arn;
    return request.keys?.[key];
  };
  for (const [operator, entries] of Object.entries(statement.Condition ?? {})) {
    for (const [key, wanted] of Object.entries(entries)) {
      const values = (Array.isArray(wanted) ? wanted : [wanted]) as string[];
      const actual = keyValue(key);
      if (operator === "Null") {
        if ((values[0] === "true") !== (key === "aws:TagKeys" ? requestKeys.length === 0 : actual === undefined)) return false;
        continue;
      }
      const resolved = values.map(substitute);
      const usable = resolved.filter((value): value is string => value !== undefined);
      if (operator === "ForAnyValue:StringEquals") {
        if (key !== "aws:TagKeys" || !requestKeys.some((tagKey) => usable.includes(tagKey))) return false;
      } else if (operator === "StringEquals") {
        if (actual === undefined || !usable.includes(actual)) return false;
      } else if (operator === "StringNotEquals") {
        if (actual !== undefined && usable.includes(actual)) return false;
      } else if (operator === "ArnNotLike") {
        if (actual !== undefined && usable.some((pattern) => glob(pattern, actual))) return false;
      } else {
        throw new Error(`the test evaluator does not know ${operator}`);
      }
    }
  }
  return true;
}

const concrete = { boundary: rendered(policies.boundary), access: rendered(policies.access), cleanup: rendered(policies.cleanup) };

/** Real IAM's rule: an explicit deny in any policy wins; otherwise the identity policy and the boundary must both allow. */
function allowed(request: Request): boolean {
  const identity = request.session === "cleanup" ? concrete.cleanup : concrete.access;
  const asRequest: Request = request.session === "cleanup" ? { ...request, session: "test" } : request;
  const matching = (document: PolicyDocument, effect: "Allow" | "Deny") => document.Statement.some((statement) => statement.Effect === effect && evaluateStatement(statement, asRequest));
  if (matching(concrete.boundary, "Deny") || matching(identity, "Deny")) return false;
  return matching(identity, "Allow") && matching(concrete.boundary, "Allow");
}

const queue = (name: string): string => `arn:aws:sqs:us-west-2:${ACCOUNT}:${name}`;
const ownQueue = queue(`rv-${RUN}-orders`);
const sessions = ["test", "created"] as const;

describe("sizes", () => {
  it("keeps every policy under IAM's limit as IAM counts it: after the tokens are filled, with the longest Region and name", () => {
    for (const document of [policies.boundary, policies.access, policies.cleanup]) {
      expect(policySize(rendered(document, "ap-southeast-2"))).toBeLessThanOrEqual(IAM_MANAGED_POLICY_MAX_CHARS);
      expect(policySize(document)).toBeLessThanOrEqual(IAM_MANAGED_POLICY_MAX_CHARS);
    }
  });
  it("leaves the boundary room to grow", () => {
    expect(policySize(rendered(policies.boundary, "ap-southeast-2"))).toBeLessThan(IAM_MANAGED_POLICY_MAX_CHARS - 150);
  });
});

describe("which services the fence supports", () => {
  it("fences every default service by a resource with a caller-chosen name that AWS's reference lists, so a rename there is caught", () => {
    for (const service of DEFAULT_TEST_ACCESS_SERVICES) {
      expect(runNamePatterns(service).length, service).toBeGreaterThan(0);
      const listed = nameArnPatternsOf(service).map((pattern) => pattern.split(":").slice(5).join(":"));
      for (const resource of RUN_RESOURCES[service] ?? []) {
        // The reference gives these with a name that is not simply "Name" (IAM's role has a path, a secret an id with a suffix, an SSM parameter a path) or a naming Lambda adds: checked by the live proof, not here.
        if (service === "iam" || service === "secretsmanager" || resource.startsWith("parameter/") || resource.startsWith("log-group:/aws/lambda/")) continue;
        expect(listed.some((entry) => entry === resource || entry.startsWith(`${resource}:`) || entry.startsWith(`${resource}/`)), `${service}: ${resource}`).toBe(true);
      }
    }
  });
  it("refuses a service IAM cannot fence to one run, and one it knows nothing of", () => {
    for (const service of Object.keys(UNFENCEABLE_SERVICES)) expect(() => buildTestAccessPolicies([...DEFAULT_TEST_ACCESS_SERVICES, service]), service).toThrow(/cannot be in a test account policy/u);
    expect(() => buildTestAccessPolicies(["sqs", "no-such-service"])).toThrow(/no resource with a caller-chosen name/u);
    expect(DEFAULT_TEST_ACCESS_SERVICES.some((service) => service in UNFENCEABLE_SERVICES)).toBe(false);
  });
  it("drops a pattern another one already covers", () => {
    expect(dropSubsumed(["a:rv-*", "a:rv-*/x/*", "b:rv-*", "a:rv-*"])).toEqual(["a:rv-*", "b:rv-*"]);
  });
  it("names the run's resources with the run's variable, never a fixed name", () => {
    for (const service of DEFAULT_TEST_ACCESS_SERVICES) for (const pattern of runNamePatterns(service)) expect(pattern).toContain(RUN_NAME_PATTERN);
  });
});

describe("a run changes only what it owns, as Rovara's role and as a role the run creates (the shared-account fence is in the boundary)", () => {
  it.each(sessions)("%s: may use resources named for the run (control: the fence lets the run work)", (session) => {
    const cases: [string, string, Record<string, string>?][] = [
      ["sqs:CreateQueue", ownQueue],
      ["sqs:SendMessage", ownQueue],
      ["sqs:ReceiveMessage", ownQueue],
      ["sqs:DeleteQueue", ownQueue],
      ["sns:Publish", `arn:aws:sns:us-west-2:${ACCOUNT}:rv-${RUN}-topic`],
      ["dynamodb:PutItem", `arn:aws:dynamodb:us-west-2:${ACCOUNT}:table/rv-${RUN}-t`],
      ["dynamodb:DeleteTable", `arn:aws:dynamodb:us-west-2:${ACCOUNT}:table/rv-${RUN}-t`],
      ["lambda:CreateFunction", `arn:aws:lambda:us-west-2:${ACCOUNT}:function:rv-${RUN}-f`],
      ["lambda:InvokeFunction", `arn:aws:lambda:us-west-2:${ACCOUNT}:function:rv-${RUN}-f:live`],
      ["logs:CreateLogGroup", `arn:aws:logs:us-west-2:${ACCOUNT}:log-group:/aws/lambda/rv-${RUN}-f`],
      ["logs:PutLogEvents", `arn:aws:logs:us-west-2:${ACCOUNT}:log-group:rv-${RUN}-g:log-stream:s`],
      ["states:StartExecution", `arn:aws:states:us-west-2:${ACCOUNT}:stateMachine:rv-${RUN}-m`],
      ["kinesis:UpdateShardCount", `arn:aws:kinesis:us-west-2:${ACCOUNT}:stream/rv-${RUN}-s`],
      ["secretsmanager:CreateSecret", `arn:aws:secretsmanager:us-west-2:${ACCOUNT}:secret:rv-${RUN}-s-AbCdEf`],
      ["secretsmanager:GetSecretValue", `arn:aws:secretsmanager:us-west-2:${ACCOUNT}:secret:rv-${RUN}-s-AbCdEf`],
      ["ssm:PutParameter", `arn:aws:ssm:us-west-2:${ACCOUNT}:parameter/rv-${RUN}-p`],
      ["ssm:GetParameter", `arn:aws:ssm:us-west-2:${ACCOUNT}:parameter/rv-${RUN}-p`],
      ["events:PutRule", `arn:aws:events:us-west-2:${ACCOUNT}:rule/rv-${RUN}-r`],
    ];
    for (const [action, resource, resourceTags] of cases) expect(allowed({ session, action, resource, ...(resourceTags === undefined ? {} : { resourceTags }) }), `${action} ${resource}`).toBe(true);
    expect(allowed({ session, action: "s3:PutObject", resource: `arn:aws:s3:::rv-${RUN}-b/key`, keys: { "s3:ResourceAccount": ACCOUNT } })).toBe(true);
    expect(allowed({ session, action: "s3:CreateBucket", resource: `arn:aws:s3:::rv-${RUN}-b`, keys: { "s3:ResourceAccount": ACCOUNT } })).toBe(true);
  });

  it.each(sessions)("%s: may use a resource that already carries the run tag, and not one with another run's", (session) => {
    const legacy = `arn:aws:lambda:us-west-2:${ACCOUNT}:function:legacy`;
    expect(allowed({ session, action: "lambda:InvokeFunction", resource: legacy, resourceTags: { "rovara-run": RUN } })).toBe(true);
    expect(allowed({ session, action: "lambda:InvokeFunction", resource: legacy, resourceTags: { "rovara-run": OTHER_RUN } })).toBe(false);
    expect(allowed({ session, action: "lambda:InvokeFunction", resource: legacy })).toBe(false);
  });

  it.each(sessions)("%s: C1, cannot touch a shared resource, another run's, or another account's bucket", (session) => {
    const shared: [string, string][] = [
      ["dynamodb:DeleteTable", `arn:aws:dynamodb:us-west-2:${ACCOUNT}:table/orders`],
      ["dynamodb:PutItem", `arn:aws:dynamodb:us-west-2:${ACCOUNT}:table/orders`],
      ["s3:DeleteBucket", "arn:aws:s3:::shared-data"],
      ["s3:PutObject", "arn:aws:s3:::shared-data/key"],
      ["sqs:DeleteQueue", queue("shared")],
      ["sqs:SendMessage", queue(`rv-${OTHER_RUN}-orders`)],
      ["sqs:ReceiveMessage", queue("shared")],
      ["sns:Publish", `arn:aws:sns:us-west-2:${ACCOUNT}:shared`],
      ["lambda:InvokeFunction", `arn:aws:lambda:us-west-2:${ACCOUNT}:function:shared`],
      ["lambda:DeleteFunction", `arn:aws:lambda:us-west-2:${ACCOUNT}:function:shared`],
      ["secretsmanager:DeleteSecret", `arn:aws:secretsmanager:us-west-2:${ACCOUNT}:secret:prod-db-AbCdEf`],
      ["ssm:DeleteParameter", `arn:aws:ssm:us-west-2:${ACCOUNT}:parameter/prod/db`],
      ["logs:DeleteLogGroup", `arn:aws:logs:us-west-2:${ACCOUNT}:log-group:shared`],
      ["logs:PutLogEvents", `arn:aws:logs:us-west-2:${ACCOUNT}:log-group:shared:log-stream:s`],
      ["states:DeleteStateMachine", `arn:aws:states:us-west-2:${ACCOUNT}:stateMachine:shared`],
      ["kinesis:DeleteStream", `arn:aws:kinesis:us-west-2:${ACCOUNT}:stream/shared`],
    ];
    for (const [action, resource] of shared) expect(allowed({ session, action, resource }), `${action} ${resource}`).toBe(false);
    // S3 bucket names are global: a bucket with the run's name in another account is not the run's
    expect(allowed({ session, action: "s3:PutObject", resource: `arn:aws:s3:::rv-${RUN}-b/key`, keys: { "s3:ResourceAccount": "999999999999" } })).toBe(false);
    expect(allowed({ session, action: "s3:PutObject", resource: `arn:aws:s3:::rv-${RUN}-b/key` })).toBe(false);
  });

  it.each(sessions)("%s: H1, cannot tag a shared resource to make it its own (control: tagging its own resource works, also at create time)", (session) => {
    const claim = { "rovara-run": RUN };
    const claims: [string, string][] = [
      ["sqs:TagQueue", queue("shared")],
      ["lambda:TagResource", `arn:aws:lambda:us-west-2:${ACCOUNT}:function:shared`],
      ["ssm:AddTagsToResource", `arn:aws:ssm:us-west-2:${ACCOUNT}:parameter/shared`],
      ["events:TagResource", `arn:aws:events:us-west-2:${ACCOUNT}:rule/shared`],
      ["logs:TagResource", `arn:aws:logs:us-west-2:${ACCOUNT}:log-group:shared`],
      ["kinesis:AddTagsToStream", `arn:aws:kinesis:us-west-2:${ACCOUNT}:stream/shared`],
      ["secretsmanager:TagResource", `arn:aws:secretsmanager:us-west-2:${ACCOUNT}:secret:shared-AbCdEf`],
      ["dynamodb:TagResource", `arn:aws:dynamodb:us-west-2:${ACCOUNT}:table/shared`],
      ["sns:TagResource", `arn:aws:sns:us-west-2:${ACCOUNT}:shared`],
      ["states:TagResource", `arn:aws:states:us-west-2:${ACCOUNT}:stateMachine:shared`],
    ];
    for (const [action, resource] of claims) {
      expect(allowed({ session, action, resource, requestTags: claim }), `${action} ${resource}`).toBe(false);
      // and a follow-up write on the claimed resource is still refused, because the tag was never set
      expect(allowed({ session, action: "sqs:DeleteQueue", resource: queue("shared") })).toBe(false);
    }
    expect(allowed({ session, action: "sqs:TagQueue", resource: ownQueue, requestTags: claim })).toBe(true);
    expect(allowed({ session, action: "sqs:CreateQueue", resource: ownQueue, requestTags: claim })).toBe(true);
    // the run tag key cannot be set to another value or taken off, anywhere
    expect(allowed({ session, action: "sqs:TagQueue", resource: ownQueue, requestTags: { "rovara-run": OTHER_RUN } })).toBe(false);
    expect(allowed({ session, action: "sqs:UntagQueue", resource: ownQueue, tagKeys: ["rovara-run"] })).toBe(false);
    expect(allowed({ session, action: "sqs:UntagQueue", resource: ownQueue, tagKeys: ["team"] })).toBe(true);
  });

  it.each(sessions)("%s: H2, an account-wide or unscoped action is refused (control: the scoped version of a refused action works)", (session) => {
    const star = "*";
    const refused: [string, string][] = [
      ["ssm:SendCommand", `arn:aws:ec2:us-west-2:${ACCOUNT}:instance/i-0123456789abcdef0`],
      ["ssm:SendCommand", `arn:aws:ssm:us-west-2::document/AWS-RunShellScript`],
      ["ssm:UpdateServiceSetting", star],
      ["s3:PutAccountPublicAccessBlock", star],
      ["events:PutPermission", `arn:aws:events:us-west-2:${ACCOUNT}:event-bus/default`],
      ["logs:PutResourcePolicy", star],
      ["logs:PutAccountPolicy", star],
      ["logs:DeleteAccountPolicy", star],
      ["dynamodb:PurchaseReservedCapacityOfferings", star],
      ["kinesis:UpdateShardCount", `arn:aws:kinesis:us-west-2:${ACCOUNT}:stream/shared`],
      ["states:SendTaskSuccess", star],
      ["kms:CreateAlias", `arn:aws:kms:us-west-2:${ACCOUNT}:alias/shared`],
      ["kms:Decrypt", `arn:aws:kms:us-west-2:${ACCOUNT}:key/00000000-0000-0000-0000-000000000000`],
      ["apigateway:DELETE", "arn:aws:apigateway:us-west-2::/restapis/abc123"],
      ["ec2:RunInstances", star],
      ["sts:AssumeRole", `arn:aws:iam::${ACCOUNT}:role/admin`],
      ["organizations:CloseAccount", star],
    ];
    for (const [action, resource] of refused) expect(allowed({ session, action, resource }), `${action} ${resource}`).toBe(false);
    expect(allowed({ session, action: "kinesis:UpdateShardCount", resource: `arn:aws:kinesis:us-west-2:${ACCOUNT}:stream/rv-${RUN}-s` })).toBe(true);
  });

  it.each(sessions)("%s: reads of secrets and configuration are refused outside the run, even where other reads are open", (session) => {
    const secrets: [string, string][] = [
      ["secretsmanager:GetSecretValue", `arn:aws:secretsmanager:us-west-2:${ACCOUNT}:secret:prod-db-AbCdEf`],
      ["secretsmanager:BatchGetSecretValue", "*"],
      ["ssm:GetParameter", `arn:aws:ssm:us-west-2:${ACCOUNT}:parameter/prod/db`],
      ["ssm:GetParameters", `arn:aws:ssm:us-west-2:${ACCOUNT}:parameter/prod/db`],
      ["ssm:GetParametersByPath", `arn:aws:ssm:us-west-2:${ACCOUNT}:parameter/prod`],
      ["lambda:GetFunction", `arn:aws:lambda:us-west-2:${ACCOUNT}:function:shared`],
      ["lambda:GetFunctionConfiguration", `arn:aws:lambda:us-west-2:${ACCOUNT}:function:shared`],
      ["lambda:ListFunctions", "*"],
      ["states:DescribeExecution", `arn:aws:states:us-west-2:${ACCOUNT}:execution:shared:run1`],
      ["states:GetActivityTask", `arn:aws:states:us-west-2:${ACCOUNT}:activity:shared`],
    ];
    for (const [action, resource] of secrets) expect(allowed({ session, action, resource }), `${action} ${resource}`).toBe(false);
  });

  it("C1: a role the run creates reads nothing outside its run, while Rovara's test role keeps its open reads (control)", () => {
    const reads: [string, string, Record<string, string>?][] = [
      ["s3:GetObject", "arn:aws:s3:::shared-data/key"],
      ["s3:ListBucket", "arn:aws:s3:::shared-data"],
      ["dynamodb:GetItem", `arn:aws:dynamodb:us-west-2:${ACCOUNT}:table/orders`],
      ["dynamodb:Query", `arn:aws:dynamodb:us-west-2:${ACCOUNT}:table/orders`],
      ["sqs:GetQueueAttributes", queue("shared")],
      ["logs:FilterLogEvents", `arn:aws:logs:us-west-2:${ACCOUNT}:log-group:shared`],
      ["iam:GetRole", `arn:aws:iam::${ACCOUNT}:role/admin`],
      ["sts:GetCallerIdentity", "*"],
    ];
    for (const [action, resource] of reads) {
      expect(allowed({ session: "test", action, resource }), `test ${action}`).toBe(true);
      expect(allowed({ session: "cleanup", action, resource }), `cleanup ${action}`).toBe(true);
      expect(allowed({ session: "created", action, resource }), `created ${action}`).toBe(false);
    }
    expect(allowed({ session: "created", action: "dynamodb:GetItem", resource: `arn:aws:dynamodb:us-west-2:${ACCOUNT}:table/rv-${RUN}-t` })).toBe(true);
  });

  it.each(sessions)("%s: refuses another Region, and a session with no run tag can do nothing (control: the same request works in the Region with the tag)", (session) => {
    const own = { action: "sqs:SendMessage", resource: ownQueue };
    expect(allowed({ session, ...own })).toBe(true);
    expect(allowed({ session, ...own, region: "us-east-1" })).toBe(false);
  });

  it("refuses everything for a session with no run tag, reads and sts included", () => {
    for (const [action, resource] of [["sqs:SendMessage", ownQueue], ["s3:GetObject", "arn:aws:s3:::shared-data/key"], ["dynamodb:GetItem", `arn:aws:dynamodb:us-west-2:${ACCOUNT}:table/orders`]] as const) {
      expect(allowed({ session: "untagged", action, resource })).toBe(false);
    }
    // the one exemption: who am I (it tells nothing, and a session that lost its tag can still say so)
    expect(allowed({ session: "untagged", action: "sts:GetCallerIdentity", resource: "*" })).toBe(true);
  });

  it("creates an event source mapping only with the run tag, and never tags an existing one into its own", () => {
    const mapping = `arn:aws:lambda:us-west-2:${ACCOUNT}:event-source-mapping:11111111-2222-3333-4444-555555555555`;
    for (const session of sessions) {
      expect(allowed({ session, action: "lambda:CreateEventSourceMapping", resource: "*", requestTags: { "rovara-run": RUN } })).toBe(true);
      expect(allowed({ session, action: "lambda:CreateEventSourceMapping", resource: "*" })).toBe(false);
      expect(allowed({ session, action: "lambda:CreateEventSourceMapping", resource: "*", requestTags: { "rovara-run": OTHER_RUN } })).toBe(false);
      expect(allowed({ session, action: "lambda:UpdateEventSourceMapping", resource: mapping, resourceTags: { "rovara-run": RUN } })).toBe(true);
      expect(allowed({ session, action: "lambda:UpdateEventSourceMapping", resource: mapping })).toBe(false);
      expect(allowed({ session, action: "lambda:TagResource", resource: mapping, requestTags: { "rovara-run": RUN } })).toBe(false);
    }
  });
});

describe("the roles a run creates (the abuse in review item C1)", () => {
  const boundaryKeys = { "iam:PermissionsBoundary": BOUNDARY_ARN };
  const roleArn = `arn:aws:iam::${ACCOUNT}:role/rv-${RUN}-fn`;
  const create = (over: Partial<Request> = {}): boolean => allowed({ session: "test", action: "iam:CreateRole", resource: roleArn, requestTags: { "rovara-run": RUN }, keys: boundaryKeys, ...over });

  it("makes a role only with this boundary, the run's tag and a run name", () => {
    expect(create()).toBe(true);
    expect(allowed({ session: "created", action: "iam:CreateRole", resource: roleArn, requestTags: { "rovara-run": RUN }, keys: boundaryKeys })).toBe(true);
    expect(create({ keys: {} })).toBe(false);
    expect(create({ keys: { "iam:PermissionsBoundary": `arn:aws:iam::${ACCOUNT}:policy/other` } })).toBe(false);
    expect(create({ requestTags: {} })).toBe(false);
    expect(create({ requestTags: { "rovara-run": OTHER_RUN } })).toBe(false);
    expect(create({ resource: `arn:aws:iam::${ACCOUNT}:role/admin-role` })).toBe(false);
    expect(create({ resource: `arn:aws:iam::${ACCOUNT}:role/rv-${OTHER_RUN}-fn` })).toBe(false);
    expect(create({ resource: `arn:aws:iam::${ACCOUNT}:role/path/rv-${RUN}-fn` })).toBe(false);
  });

  it("gives the role policies only on run-named roles, and never touches the connection's own roles, policies or boundary", () => {
    for (const action of ["iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:DeleteRole", "iam:TagRole", "iam:GetRole"]) expect(allowed({ session: "test", action, resource: roleArn }), action).toBe(true);
    const own = [`arn:aws:iam::${ACCOUNT}:role/Rovara-test-access-RovaraTestRole-ABC`, `arn:aws:iam::${ACCOUNT}:role/Rovara-test-access-RovaraTestCleanupRole-DEF`, BOUNDARY_ARN];
    for (const resource of own) for (const action of ["iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:DeleteRole", "iam:CreatePolicyVersion", "iam:DeletePolicy", "iam:UpdateAssumeRolePolicy", "iam:TagRole"]) {
      for (const session of sessions) expect(allowed({ session, action, resource }), `${session} ${action} ${resource}`).toBe(false);
    }
  });

  it("fixes the trust policy when the role is made: it cannot be rewritten to name another principal", () => {
    for (const session of sessions) expect(allowed({ session, action: "iam:UpdateAssumeRolePolicy", resource: roleArn })).toBe(false);
  });

  it("passes a role only to the services tests use, and only a run's role", () => {
    for (const service of ["lambda.amazonaws.com", "states.amazonaws.com", "events.amazonaws.com", "scheduler.amazonaws.com"]) {
      expect(allowed({ session: "test", action: "iam:PassRole", resource: roleArn, keys: { "iam:PassedToService": service } }), service).toBe(true);
    }
    for (const service of ["ec2.amazonaws.com", "ssm.amazonaws.com", "cloudformation.amazonaws.com", "glue.amazonaws.com"]) {
      expect(allowed({ session: "test", action: "iam:PassRole", resource: roleArn, keys: { "iam:PassedToService": service } }), service).toBe(false);
    }
    expect(allowed({ session: "test", action: "iam:PassRole", resource: roleArn })).toBe(false);
    expect(allowed({ session: "test", action: "iam:PassRole", resource: `arn:aws:iam::${ACCOUNT}:role/admin`, keys: { "iam:PassedToService": "lambda.amazonaws.com" } })).toBe(false);
  });

  it("cannot take the boundary off, make users or keys, or assume another role", () => {
    for (const session of sessions) {
      expect(allowed({ session, action: "iam:DeleteRolePermissionsBoundary", resource: roleArn })).toBe(false);
      expect(allowed({ session, action: "iam:PutRolePermissionsBoundary", resource: roleArn, keys: { "iam:PermissionsBoundary": `arn:aws:iam::${ACCOUNT}:policy/other` } })).toBe(false);
      expect(allowed({ session, action: "iam:CreateUser", resource: `arn:aws:iam::${ACCOUNT}:user/rv-${RUN}-u` })).toBe(false);
      expect(allowed({ session, action: "iam:CreateAccessKey", resource: `arn:aws:iam::${ACCOUNT}:user/rv-${RUN}-u` })).toBe(false);
      expect(allowed({ session, action: "sts:AssumeRole", resource: roleArn })).toBe(false);
    }
  });

  it("a role the run creates cannot reach what the abuse in the review reached: shared tables, buckets, secrets, commands", () => {
    // PutRolePolicy "*" on the new role changes nothing: the role is still inside the boundary
    for (const [action, resource] of [
      ["dynamodb:DeleteTable", `arn:aws:dynamodb:us-west-2:${ACCOUNT}:table/orders`],
      ["s3:DeleteBucket", "arn:aws:s3:::shared-data"],
      ["secretsmanager:GetSecretValue", `arn:aws:secretsmanager:us-west-2:${ACCOUNT}:secret:prod-db-AbCdEf`],
      ["kms:Decrypt", `arn:aws:kms:us-west-2:${ACCOUNT}:key/00000000-0000-0000-0000-000000000000`],
      ["ssm:SendCommand", `arn:aws:ec2:us-west-2:${ACCOUNT}:instance/i-0123456789abcdef0`],
      ["ssm:GetParameter", `arn:aws:ssm:us-west-2:${ACCOUNT}:parameter/prod/db`],
    ] as const) expect(allowed({ session: "created", action, resource }), `${action}`).toBe(false);
  });
});

describe("the cleanup role", () => {
  it("reads, and deletes what the run owns, and nothing else (control: the delete works on the run's own)", () => {
    expect(allowed({ session: "cleanup", action: "sqs:DeleteQueue", resource: ownQueue })).toBe(true);
    expect(allowed({ session: "cleanup", action: "dynamodb:DeleteTable", resource: `arn:aws:dynamodb:us-west-2:${ACCOUNT}:table/rv-${RUN}-t` })).toBe(true);
    expect(allowed({ session: "cleanup", action: "s3:DeleteBucket", resource: `arn:aws:s3:::rv-${RUN}-b`, keys: { "s3:ResourceAccount": ACCOUNT } })).toBe(true);
    expect(allowed({ session: "cleanup", action: "sqs:DeleteQueue", resource: queue("shared") })).toBe(false);
    expect(allowed({ session: "cleanup", action: "s3:DeleteBucket", resource: "arn:aws:s3:::shared-data", keys: { "s3:ResourceAccount": ACCOUNT } })).toBe(false);
    expect(allowed({ session: "cleanup", action: "sqs:CreateQueue", resource: ownQueue })).toBe(false);
    expect(allowed({ session: "cleanup", action: "sqs:SendMessage", resource: ownQueue })).toBe(false);
    expect(allowed({ session: "cleanup", action: "secretsmanager:GetSecretValue", resource: `arn:aws:secretsmanager:us-west-2:${ACCOUNT}:secret:prod-db-AbCdEf` })).toBe(false);
    expect(allowed({ session: "cleanup", action: "ssm:DeleteParameter", resource: `arn:aws:ssm:us-west-2:${ACCOUNT}:parameter/prod/db` })).toBe(false);
  });
});

describe("the boundary's shape", () => {
  const sids = policies.boundary.Statement.map((statement) => statement.Sid);
  it("is an allow list: no allow names a service on every resource without a condition, and no read allow is open to a role a run creates", () => {
    for (const statement of policies.boundary.Statement.filter((entry) => entry.Effect === "Allow")) {
      if (statement.Sid === "AllowReads") {
        expect(statement.Condition).toEqual({ ArnNotLike: { "aws:PrincipalArn": ["arn:{{Partition}}:iam::{{AccountId}}:role/rv-*", "arn:{{Partition}}:sts::{{AccountId}}:assumed-role/rv-*/*"] } });
      } else {
        expect(statement.Condition !== undefined || (Array.isArray(statement.Resource) && !statement.Resource.includes("*")), statement.Sid).toBe(true);
      }
    }
    expect(sids).toEqual(expect.arrayContaining(["AllowReads", "AllowRunNamed", "AllowRunNamedS3", "AllowRunNamedIam", "AllowRunTagged", "AllowCreateWithRunTag", "DenyWithoutRunTag", "DenyOtherRegions", "DenyRunTagChange", "DenySecretReadsOutsideRun", "DenyRoleWithoutBoundary", "DenyRoleWithoutRunTag", "DenyPassRoleToOtherServices", "DenyBoundaryRemovalAndKeys"]));
  });
  it("allows tagging by request tag nowhere but the creation of an event source mapping", () => {
    const byRequestTag = policies.boundary.Statement.filter((entry) => entry.Effect === "Allow" && JSON.stringify(entry.Condition ?? {}).includes("aws:RequestTag"));
    expect(byRequestTag.map((entry) => [entry.Sid, entry.Action])).toEqual([["AllowCreateWithRunTag", ["lambda:CreateEventSourceMapping"]]]);
  });
  it("has no list of services refused as expensive (owner decision 121)", () => {
    expect(JSON.stringify(policies.boundary)).not.toMatch(/sagemaker|redshift|emr|"ec2:RunInstances"/u);
  });
  it("has no IAM statements when IAM is not a service of the connection, and an S3 fence only with S3", () => {
    const without = buildTestAccessPolicies(["sqs"]).boundary.Statement.map((entry) => entry.Sid);
    expect(without).not.toEqual(expect.arrayContaining(["AllowRunNamedIam"]));
    expect(without).not.toEqual(expect.arrayContaining(["DenyRoleWithoutBoundary"]));
    expect(without).not.toEqual(expect.arrayContaining(["AllowRunNamedS3"]));
    expect(without).not.toEqual(expect.arrayContaining(["DenySecretReadsOutsideRun"]));
  });
});

describe("rendering", () => {
  it("writes a CloudFormation policy: a string with a token is an Fn::Sub, and IAM's own variables are escaped", () => {
    const text = JSON.stringify(cloudFormationPolicy(policies.boundary));
    expect(text).toContain('{"Fn::Sub":"${AWS::Region}"}');
    expect(text).toContain("${!aws:PrincipalTag/rovara-run}");
    expect(text).toContain("arn:${AWS::Partition}:iam::${AWS::AccountId}:policy/rovara-test-boundary-${ExternalId}");
    expect(text).not.toMatch(/\{\{[A-Za-z]+\}\}/u);
    expect(JSON.stringify(cloudFormationPolicy(policies.access))).not.toContain("Fn::Sub");
  });
  it("writes a Terraform template: tokens become variables, IAM's variables are escaped with a second dollar", () => {
    const text = terraformPolicyTemplate(policies.boundary);
    expect(text).toContain('"${region}"');
    expect(text).toContain("$${aws:PrincipalTag/rovara-run}");
    expect(text).not.toMatch(/(?<!\$)\$\{aws:/u);
    expect(text).toContain("rovara-test-boundary-${external_id}");
    expect(text).not.toMatch(/\{\{[A-Za-z]+\}\}/u);
  });
  it("fills the tokens for the copy-paste text and keeps IAM's variables", () => {
    const text = JSON.stringify(rendered(policies.boundary, "us-west-2"));
    expect(text).toContain('"aws:RequestedRegion":"us-west-2"');
    expect(text).toContain(`arn:aws:iam::${ACCOUNT}:role/rv-\${aws:PrincipalTag/rovara-run}-*`);
    expect(text).not.toMatch(/\{\{[A-Za-z]+\}\}/u);
  });
});

describe("the trust policy", () => {
  const trust = buildTrustPolicy({ principalArn: "arn:aws:iam::111111111111:role/rovara-broker", externalId: "rovara-org_aaaaaaaaaaaaaaaaaaaa-conn_bbbbbbbbbbbbbbbbbbbb" });
  it("trusts one named role, and only with the external id", () => {
    const assume = trust.Statement.find((entry) => entry.Action === "sts:AssumeRole");
    expect(assume).toMatchObject({ Principal: { AWS: "arn:aws:iam::111111111111:role/rovara-broker" }, Condition: { StringEquals: { "sts:ExternalId": "rovara-org_aaaaaaaaaaaaaaaaaaaa-conn_bbbbbbbbbbbbbbbbbbbb" } } });
    expect(JSON.stringify(trust)).not.toContain('"*"');
  });
  it("lets the session carry the run tag (8 characters) and no other tag", () => {
    const tag = trust.Statement.find((entry) => entry.Action === "sts:TagSession");
    expect(tag?.Condition).toEqual({ "ForAllValues:StringEquals": { "aws:TagKeys": ["rovara-run"] }, StringLike: { "aws:RequestTag/rovara-run": "????????" } });
  });
});
