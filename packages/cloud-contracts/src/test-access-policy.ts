// The IAM policies of the customer test account (lane TA1): the permission boundary, the test role's access policy and the delete-only cleanup role's policy, built from one source so that
// the CloudFormation template, the Terraform module and the copy-paste policy text cannot drift apart. Pure functions; the per-action facts come from the generated scoping table (`test-access-scoping.ts`).
//
// The model (customer-test-account.md, section 2). Every identity a run can obtain is fenced the same way: Rovara's test role AND every role the run creates carry the boundary, so the whole fence is IN the boundary.
//   - Rovara assumes the role with the session tag `rovara-run=<run8>` (8 characters). A session with no run tag can do nothing. A created role carries the same tag (CreateRole must set it), so it resolves to the same run.
//   - The boundary is an allow list, so what it does not name is refused, including every action that has no scope and every action added to AWS tomorrow:
//       reads (Get*, List*, Describe*)  Rovara's roles only; a role the run creates (named rv-<run8>-*) reads nothing but its run's own resources
//       everything else                 only on resources named `rv-<run8>-*` (the ARN carries the name), or already carrying the run tag, or (lambda:CreateEventSourceMapping only) created with the run tag
//     Nothing allows tagging a resource that is neither run-named nor already run-tagged, so a run cannot claim a shared resource by tagging it. Account-wide actions (resource `*`) are not allowed at all.
//   - Explicit denies on top: no run tag, another Region, any change of the run tag key, secret-class reads (Secrets Manager values, SSM parameters, Lambda configuration with its environment) of anything the run does not own,
//     roles without the boundary or the run tag, passing a role to a service tests do not use, taking the boundary off, long-lived keys, rewriting a trust policy.
//   - There is no list of services to refuse because they are expensive (owner decision 121). Services whose resources have no caller-chosen name (API Gateway, KMS) cannot be fenced by IAM, so they are not in the default list and
//     `buildTestAccessPolicies` refuses them: tests on them stay on the emulator until an admin opts in with the signer as the only guard.
//   - What IAM cannot see and the account signer (TA4) must guard: the contents of a trust policy a run writes for a role it creates (IAM has no condition for it; an outside principal could assume the role, but only to reach the run's own
//     resources), and the open reads of Rovara's roles (the signer holds the read allow-list).
//
// The policies hold tokens for the pieces only the deploy knows: `{{Partition}}`, `{{Region}}`, `{{AccountId}}` and `{{BoundaryArn}}`. IAM's own policy variable `${aws:PrincipalTag/rovara-run}` is written as IAM reads it.
// `renderPolicyTokens`, `cloudFormationPolicy` and `terraformPolicyTemplate` turn them into a concrete policy, a CloudFormation `Fn::Sub` and a Terraform template.
//
// AWS facts checked for this lane (2026-11-12, from the documentation only; no AWS call is made):
//   - A custom resource's ServiceToken (an SNS topic ARN or a Lambda ARN) "must be from the same Region as the stack": https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cloudformation-customresource.html,
//     repeated at https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/crpg-ref.html. So there is one topic per Region (infra/lib/test-access-callback.ts).
//   - SNS delivers a topic's messages to a Lambda function in another Region; an opt-in Region's topic needs the function policy to name `sns.<region>.amazonaws.com`: https://docs.aws.amazon.com/sns/latest/dg/sns-cross-region-delivery.html
//   - Which actions take aws:RequestTag, aws:ResourceTag or have a named ARN: the Service Authorization Reference (https://docs.aws.amazon.com/service-authorization/latest/reference/reference.html, machine-readable at
//     https://servicereference.us-east-1.amazonaws.com/), read by scripts/test-access/gen-action-scoping.ts into generated/test-access-scoping.ts. Services support the tag keys unevenly (the "ABAC" column of
//     https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_aws-services-that-work-with-iam.html: Yes only when all three keys work for every resource type, Partial otherwise), so the table is per action.
//   - S3: tag conditions on a general purpose bucket apply only after ABAC is enabled on that bucket (`s3:PutBucketAbac`, off by default), so S3 is scoped by the bucket name: https://docs.aws.amazon.com/AmazonS3/latest/userguide/buckets-tagging-enable-abac.html
//   - IAM action patterns take a wildcard in the action name only (`s3:Get*`), not in the service part, so the boundary names every service it allows.
//
// What is NOT verified (nothing here was run against AWS): (1) that IAM accepts the policy variable `${aws:PrincipalTag/...}` in NotResource, and how it evaluates the Null checks on session tags; (2) whose credentials CloudFormation uses to publish
// to a custom resource's SNS topic (the topic policy therefore allows any principal to publish, over TLS, and the handler decides); (3) that `sts:TagSession` is granted by a trust statement without the external id condition (the trust policy
// is written so that it works either way). The internal live proof (TA11) checks all three.
import { scopedActionsOf } from "./test-access-scoping.js";

/** The session tag every run carries; also the tag key of the resources a run creates. */
export const RUN_TAG_KEY = "rovara-run";
/** The length of a run id (`<run8>`): the tag value and the middle of every name a run gives its resources. */
export const RUN_ID_LENGTH = 8;
/** A run's resources are named `rv-<run8>-...`. */
export const RUN_NAME_PREFIX = "rv-";
/** The IAM policy variable that is the run id of the calling session (or of a role that carries the same tag). */
export const RUN_TAG_VARIABLE = "${aws:PrincipalTag/rovara-run}";
export const RUN_NAME_PATTERN = `${RUN_NAME_PREFIX}${RUN_TAG_VARIABLE}-*`;

/**
 * The services a connection allows by default: the ones tests most often need, all with caller-chosen names that an IAM Resource pattern can fence. A service outside the list is refused by the boundary (a template version with a
 * longer list is a new version, shown before it is used). `sts` is not a service here: only `sts:GetCallerIdentity` is allowed, so a run cannot assume another role of the account.
 */
export const DEFAULT_TEST_ACCESS_SERVICES: readonly string[] = ["dynamodb", "events", "iam", "kinesis", "lambda", "logs", "s3", "secretsmanager", "sns", "sqs", "ssm", "states"];

/** Services IAM cannot fence to one run, with why. `buildTestAccessPolicies` refuses them. */
export const UNFENCEABLE_SERVICES: Readonly<Record<string, string>> = {
  apigateway: "REST and HTTP APIs have generated ids in their ARNs and no caller-chosen name, and tagging an existing API by its ARN cannot be told from tagging at create time",
  kms: "keys have generated ids and no caller-chosen name, and kms:TagResource is needed at create time, so a run could claim a shared key by tagging it and then decrypt with it",
};

/** Actions of services that are not Regional: the Region condition leaves them alone. */
const GLOBAL_ACTIONS: readonly string[] = ["iam:*", "s3:GetBucketLocation", "s3:ListAllMyBuckets", "sts:GetCallerIdentity"];

/**
 * Actions that make long-lived credentials or rewrite who may use a role. Most are refused anyway (no allow names a user), so this is a second line: Rovara never accepts long-lived keys, and a run never mints them. A role's trust
 * policy is fixed when the role is made: IAM cannot read what a trust policy names, so the signer (TA4) reads it in the CreateRole request.
 */
const FORBIDDEN_IAM_ACTIONS: readonly string[] = ["iam:CreateAccessKey", "iam:CreateLoginProfile", "iam:CreateUser", "iam:DeleteRolePermissionsBoundary", "iam:UpdateAssumeRolePolicy"];

/** Services a run may hand a role to: the ones tests use to run code. */
export const PASSABLE_SERVICES: readonly string[] = ["events.amazonaws.com", "lambda.amazonaws.com", "scheduler.amazonaws.com", "states.amazonaws.com"];

/** Reads that are not named Get, List or Describe. */
const EXTRA_READS: readonly string[] = ["dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:Scan", "logs:FilterLogEvents"];

/**
 * Reads that hand out secrets or configuration with secrets in it, and the one read that takes something (a Step Functions worker's GetActivityTask takes a task). Allowed only on what the run owns: a run's own secret, parameter, function and execution. `lambda:GetFunction` and `GetFunctionConfiguration`
 * return a function's environment variables; ListFunctions returns them for every function and has no resource to fence, so it is refused outright.
 */
const SECRET_READS: readonly string[] = [
  "lambda:GetFunction",
  "lambda:GetFunctionConfiguration",
  "lambda:ListFunctions",
  "secretsmanager:BatchGetSecretValue",
  "secretsmanager:GetSecretValue",
  "ssm:GetParameter*",
  "ssm:GetParametersByPath",
  "states:DescribeExecution",
  "states:GetActivityTask",
  "states:GetExecutionHistory",
];

/** Created with the run tag, because the resource has no name of its own (an event source mapping is an id). Nothing tags an existing resource, so this cannot claim one. */
const CREATE_BY_TAG: readonly string[] = ["lambda:CreateEventSourceMapping"];

/**
 * The resource types of each default service that tests create and use, as the part of the ARN after the account. `{{Name}}` is where the caller's name goes: the run's name `rv-<run8>-*`. A pattern ending in the name also covers the
 * resource's children (`table/rv-x-*` covers its indexes, a Lambda function covers its versions and aliases, a bucket its objects). Each must be a resource type the Service Authorization Reference lists with a leading name
 * (tests/unit/test-access-policy.test.ts checks), so a rename in AWS's data is caught. IAM is fenced to the run's roles, policies and instance profiles, never users, groups or providers.
 */
export const RUN_RESOURCES: Readonly<Record<string, readonly string[]>> = {
  dynamodb: ["table/{{Name}}", "global-table/{{Name}}"],
  events: ["archive/{{Name}}", "event-bus/{{Name}}", "rule/{{Name}}"],
  iam: ["instance-profile/{{Name}}", "policy/{{Name}}", "role/{{Name}}"],
  kinesis: ["stream/{{Name}}"],
  lambda: ["function:{{Name}}", "layer:{{Name}}"],
  logs: ["log-group:/aws/lambda/{{Name}}", "log-group:{{Name}}"],
  s3: ["{{Name}}"],
  secretsmanager: ["secret:{{Name}}"],
  sns: ["{{Name}}"],
  sqs: ["{{Name}}"],
  ssm: ["document/{{Name}}", "parameter/{{Name}}"],
  states: ["activity:{{Name}}", "execution:{{Name}}", "stateMachine:{{Name}}"],
};

export interface PolicyStatement {
  readonly Sid: string;
  readonly Effect: "Allow" | "Deny";
  readonly Action?: readonly string[];
  readonly NotAction?: readonly string[];
  readonly Resource?: readonly string[] | string;
  readonly NotResource?: readonly string[];
  readonly Condition?: Readonly<Record<string, Readonly<Record<string, readonly string[] | string>>>>;
}

export interface PolicyDocument {
  readonly Version: "2012-10-17";
  readonly Statement: readonly PolicyStatement[];
}

/** The most non-whitespace characters IAM accepts in one managed policy, and in a permissions boundary. */
export const IAM_MANAGED_POLICY_MAX_CHARS = 6144;

/** IAM counts every character of the policy except white space. */
export function policySize(document: PolicyDocument): number {
  return JSON.stringify(document).replace(/\s/gu, "").length;
}

/** A pattern is dropped when an earlier one ending in `*` already matches everything it does (a table pattern ending in a star covers the same pattern followed by an index path). */
export function dropSubsumed(patterns: readonly string[]): string[] {
  const unique = [...new Set(patterns)].sort();
  return unique.filter((pattern) => !unique.some((other) => other !== pattern && other.endsWith("*") && pattern.startsWith(other.slice(0, -1))));
}

/** The resource patterns of a service's own resources named for the run, in the policy's tokens. Region is `*` (another Region is refused on its own), the name is the run's. S3 ARNs have no Region or account. */
export function runNamePatterns(service: string): string[] {
  const reason = UNFENCEABLE_SERVICES[service];
  if (reason !== undefined) throw new Error(`${service} cannot be in a test account policy: ${reason}`);
  const resources = RUN_RESOURCES[service];
  if (resources === undefined) throw new Error(`${service} has no resource with a caller-chosen name that the policy knows, so IAM cannot confine it to a run`);
  const head = service === "s3" ? "arn:{{Partition}}:s3:::" : service === "iam" ? "arn:{{Partition}}:iam::{{AccountId}}:" : `arn:{{Partition}}:${service}:*:{{AccountId}}:`;
  return dropSubsumed(resources.map((resource) => `${head}${resource.replace("{{Name}}", RUN_NAME_PATTERN)}`));
}

export interface TestAccessPolicies {
  /**
   * The permissions boundary of the test role, the cleanup role and every role a run creates. It holds the whole fence (see the model above) in under IAM's limit of 6,144 characters.
   */
  readonly boundary: PolicyDocument;
  /** What the test role may do (inside the boundary): the services, nothing else. */
  readonly access: PolicyDocument;
  /** What the delete-only cleanup role may do (inside the boundary): reads, and the delete actions of the services. */
  readonly cleanup: PolicyDocument;
}

const NOT_A_RUN_ROLE: readonly string[] = ["arn:{{Partition}}:iam::{{AccountId}}:role/rv-*", "arn:{{Partition}}:sts::{{AccountId}}:assumed-role/rv-*/*"];

export function buildTestAccessPolicies(services: readonly string[] = DEFAULT_TEST_ACCESS_SERVICES): TestAccessPolicies {
  const sorted = [...new Set(services)].sort();
  const patternsOf = (list: readonly string[]): string[] => dropSubsumed(list.flatMap((service) => runNamePatterns(service)));
  const withoutSpecial = sorted.filter((service) => service !== "s3" && service !== "iam");
  const serviceAllow = sorted.map((service) => `${service}:*`);
  const baseline = ["sts:GetCallerIdentity", "tag:GetResources", "tag:GetTagKeys", "tag:GetTagValues"];
  const reads = [...sorted.flatMap((service) => [`${service}:Describe*`, `${service}:Get*`, `${service}:List*`]), ...EXTRA_READS.filter((action) => sorted.includes(action.split(":")[0] as string)), "sts:GetCallerIdentity", "tag:Get*"];
  const secretNames = patternsOf(["lambda", "secretsmanager", "ssm", "states"].filter((service) => sorted.includes(service))).filter((pattern) => /:(function:|secret:|parameter\/|execution:)/u.test(pattern));
  const allow: PolicyStatement = { Sid: "AllowTestServices", Effect: "Allow", Action: [...serviceAllow, ...baseline], Resource: "*" };
  const statements: PolicyStatement[] = [
    // Reads are Rovara's own roles' only: a role the run creates reads nothing outside its run, so an outside principal that gets to assume it reaches no more than the run's own resources.
    { Sid: "AllowReads", Effect: "Allow", Action: reads, Resource: "*", Condition: { ArnNotLike: { "aws:PrincipalArn": NOT_A_RUN_ROLE } } },
    { Sid: "AllowRunNamed", Effect: "Allow", Action: withoutSpecial.map((service) => `${service}:*`), Resource: patternsOf(withoutSpecial) },
  ];
  if (sorted.includes("s3")) {
    // S3 bucket names are global: a bucket named like the run's but in another account is not the run's, so the account is checked too.
    statements.push({ Sid: "AllowRunNamedS3", Effect: "Allow", Action: ["s3:*"], Resource: patternsOf(["s3"]), Condition: { StringEquals: { "s3:ResourceAccount": "{{AccountId}}" } } });
  }
  if (sorted.includes("iam")) statements.push({ Sid: "AllowRunNamedIam", Effect: "Allow", Action: ["iam:*"], Resource: patternsOf(["iam"]) });
  statements.push({ Sid: "AllowRunTagged", Effect: "Allow", Action: withoutSpecial.map((service) => `${service}:*`), Resource: "*", Condition: { StringEquals: { [`aws:ResourceTag/${RUN_TAG_KEY}`]: RUN_TAG_VARIABLE } } });
  const createByTag = CREATE_BY_TAG.filter((action) => sorted.includes(action.split(":")[0] as string));
  if (createByTag.length > 0) {
    statements.push({ Sid: "AllowCreateWithRunTag", Effect: "Allow", Action: createByTag, Resource: "*", Condition: { StringEquals: { [`aws:RequestTag/${RUN_TAG_KEY}`]: RUN_TAG_VARIABLE } } });
  }
  statements.push(
    // The one session tag every run carries. Without it every other check has nothing to compare, so nothing at all is allowed.
    { Sid: "DenyWithoutRunTag", Effect: "Deny", NotAction: ["sts:GetCallerIdentity"], Resource: "*", Condition: { Null: { [`aws:PrincipalTag/${RUN_TAG_KEY}`]: "true" } } },
    { Sid: "DenyOtherRegions", Effect: "Deny", NotAction: GLOBAL_ACTIONS, Resource: "*", Condition: { StringNotEquals: { "aws:RequestedRegion": "{{Region}}" } } },
    // A request that carries the run tag key must carry this run's value, and a request that removes the key is refused.
    {
      Sid: "DenyRunTagChange",
      Effect: "Deny",
      Action: ["*"],
      Resource: "*",
      Condition: { "ForAnyValue:StringEquals": { "aws:TagKeys": RUN_TAG_KEY }, StringNotEquals: { [`aws:RequestTag/${RUN_TAG_KEY}`]: RUN_TAG_VARIABLE } },
    },
  );
  if (secretNames.length > 0) {
    statements.push({ Sid: "DenySecretReadsOutsideRun", Effect: "Deny", Action: SECRET_READS.filter((action) => sorted.includes(action.split(":")[0] as string)), NotResource: secretNames });
  }
  if (sorted.includes("iam")) {
    statements.push(
      { Sid: "DenyRoleWithoutBoundary", Effect: "Deny", Action: ["iam:CreateRole", "iam:PutRolePermissionsBoundary"], Resource: "*", Condition: { StringNotEquals: { "iam:PermissionsBoundary": "{{BoundaryArn}}" } } },
      { Sid: "DenyRoleWithoutRunTag", Effect: "Deny", Action: ["iam:CreateRole"], Resource: "*", Condition: { StringNotEquals: { [`aws:RequestTag/${RUN_TAG_KEY}`]: RUN_TAG_VARIABLE } } },
      { Sid: "DenyPassRoleToOtherServices", Effect: "Deny", Action: ["iam:PassRole"], Resource: "*", Condition: { StringNotEquals: { "iam:PassedToService": [...PASSABLE_SERVICES] } } },
      { Sid: "DenyBoundaryRemovalAndKeys", Effect: "Deny", Action: [...FORBIDDEN_IAM_ACTIONS], Resource: "*" },
    );
  }
  const boundary: PolicyDocument = { Version: "2012-10-17", Statement: statements };
  const access: PolicyDocument = { Version: "2012-10-17", Statement: [allow] };
  const deletes = sorted.flatMap((service) => scopedDeleteActions(service));
  const cleanup: PolicyDocument = {
    Version: "2012-10-17",
    Statement: [{ Sid: "AllowReadAndDelete", Effect: "Allow", Action: [...reads, ...deletes], Resource: "*" }],
  };
  return { boundary, access, cleanup };
}

/** The delete actions of a service as patterns: exact names, kept to the actions the table knows are deletes. */
function scopedDeleteActions(service: string): string[] {
  return scopedActionsOf(service).filter((action) => action.kind === "delete").map((action) => `${service}:${action.action}`).sort();
}

export interface PolicyTokenValues {
  readonly Partition: string;
  readonly Region: string;
  readonly AccountId: string;
  readonly BoundaryArn: string;
}

/** The policy with every token replaced: the copy-paste text. IAM's own `${aws:...}` variables stay. */
export function renderPolicyTokens(document: PolicyDocument, values: PolicyTokenValues): PolicyDocument {
  const text = JSON.stringify(document).replace(/\{\{(Partition|Region|AccountId|BoundaryArn)\}\}/gu, (_match, name: keyof PolicyTokenValues) => values[name]);
  return JSON.parse(text) as PolicyDocument;
}

const CFN_TOKENS: Readonly<Record<string, string>> = {
  Partition: "${AWS::Partition}",
  Region: "${AWS::Region}",
  AccountId: "${AWS::AccountId}",
  BoundaryArn: "arn:${AWS::Partition}:iam::${AWS::AccountId}:policy/rovara-test-boundary-${ExternalId}",
};
const TERRAFORM_TOKENS: Readonly<Record<string, string>> = {
  Partition: "${partition}",
  Region: "${region}",
  AccountId: "${account_id}",
  BoundaryArn: "arn:${partition}:iam::${account_id}:policy/rovara-test-boundary-${external_id}",
};

const hasToken = (value: string): boolean => /\{\{[A-Za-z]+\}\}/u.test(value);

/** A policy for a CloudFormation template: a string that holds a token becomes `Fn::Sub`, with IAM's own `${aws:...}` variables escaped (`${!aws:...}`). */
export function cloudFormationPolicy(document: PolicyDocument): unknown {
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (!hasToken(value)) return value;
      const escaped = value.replace(/\$\{(aws:[^}]+)\}/gu, "${!$1}");
      return { "Fn::Sub": escaped.replace(/\{\{([A-Za-z]+)\}\}/gu, (_match, name: string) => CFN_TOKENS[name] ?? name) };
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, walk(inner)]));
    return value;
  };
  return walk(document);
}

/** A policy as a Terraform `templatefile` input (`terraform/policies/*.json.tftpl`): tokens become `${partition}` and friends, IAM's own variables are escaped (`$${aws:...}`). */
export function terraformPolicyTemplate(document: PolicyDocument): string {
  const text = JSON.stringify(document, null, 2);
  return `${text.replace(/\$\{(aws:[^}]+)\}/gu, (_match, variable: string) => "$$" + `{${variable}}`).replace(/\{\{([A-Za-z]+)\}\}/gu, (_match, name: string) => TERRAFORM_TOKENS[name] ?? name)}\n`;
}

export interface TrustStatement {
  readonly Sid: string;
  readonly Effect: "Allow";
  readonly Principal: { readonly AWS: string };
  readonly Action: string;
  readonly Condition: Readonly<Record<string, Readonly<Record<string, readonly string[] | string>>>>;
}

/**
 * The trust policy of the test role and the cleanup role: only Rovara's role, and only with the external id (a confused-deputy guard). The session must carry the run tag and no other: `sts:TagSession` is a second
 * statement without the external id, because it grants nothing on its own; the call still needs `sts:AssumeRole`, which does.
 */
export function buildTrustPolicy(input: { readonly principalArn: string; readonly externalId: string }): { readonly Version: "2012-10-17"; readonly Statement: readonly TrustStatement[] } {
  return {
    Version: "2012-10-17",
    Statement: [
      { Sid: "RovaraAssumesWithExternalId", Effect: "Allow", Principal: { AWS: input.principalArn }, Action: "sts:AssumeRole", Condition: { StringEquals: { "sts:ExternalId": input.externalId } } },
      {
        Sid: "RovaraTagsTheSession",
        Effect: "Allow",
        Principal: { AWS: input.principalArn },
        Action: "sts:TagSession",
        Condition: { "ForAllValues:StringEquals": { "aws:TagKeys": [RUN_TAG_KEY] }, StringLike: { [`aws:RequestTag/${RUN_TAG_KEY}`]: "?".repeat(RUN_ID_LENGTH) } },
      },
    ],
  };
}
