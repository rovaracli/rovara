// The IAM policies of the customer test account (lane TA1): the permission boundary, the test role's access policy and the delete-only cleanup role's policy, built from one source so that
// the CloudFormation template, the Terraform module and the copy-paste policy text cannot drift apart. Pure functions; the per-action facts come from the generated scoping table (`test-access-scoping.ts`).
//
// The model (customer-test-account.md, section 2). Every identity a run can obtain is fenced the same way: Rovara's test role AND every role the run creates carry the boundary, so the whole fence is IN the boundary.
//   - Rovara assumes the role with the session tag `rovara-run=<run8>` (8 characters). A session with no run tag can do nothing. A created role carries the same tag (CreateRole must set it), so it resolves to the same run.
//   - The boundary is an allow list, so what it does not name is refused, including every action that has no scope and every action added to AWS tomorrow:
//       reads (Get*, List*, Describe*)  Rovara's roles only; a role the run creates (named rv-<run8>-*) reads nothing but its run's own resources
//       everything else                 only on resources named `rv-<run8>-*` (the ARN carries the name), or already carrying the run tag, or (lambda:CreateEventSourceMapping only) created with the run tag
//     Nothing allows tagging a resource that is neither run-named nor already run-tagged, so a run cannot claim a shared resource by tagging it. Account-wide actions (resource `*`) are not allowed at all.
//   - Explicit denies on top: no run tag, another Region, any change of the run tag key, a session whose tag disagrees with its role's name (a session tag overrides a role's tag, so an outsider who assumes a run's role could
//     name another run), secret-class reads (Secrets Manager values, SSM parameters, Lambda configuration with its environment) of anything the run does not own, an EventBridge rule's targets that are not the run's own, the account's
//     concurrency pool and Object Lock, roles without the boundary or with a path, passing a role to a service tests do not use, taking the boundary off, rewriting a trust policy. A role a run creates is also denied ALL of IAM and every
//     action that opens a resource to a principal: it runs code the signer never sees, so only Rovara's test role (whose calls the signer reads) makes roles and sets resource policies.
//   - There is no list of services to refuse because they are expensive (owner decision 121). Services whose resources have no caller-chosen name (API Gateway, KMS) cannot be fenced by IAM, so they are not in the default list and
//     `buildTestAccessPolicies` refuses them: tests on them stay on the emulator until an admin opts in with the signer as the only guard.
//   - What IAM cannot see and the account signer (TA4) and cleanup (TA6) must handle is listed in environments/test-access/TA11-live-proof.md, with what TA11 proves live.
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
 * Actions that take the boundary off a role or rewrite who may use it. Only Rovara's test role can call IAM at all (a role a run creates is denied every IAM action), and its calls are gated by the signer, which also reads the
 * trust policy of every CreateRole: IAM cannot, so the signer allows only AWS service principals for the PassRole services, never an account or `*`.
 */
const FORBIDDEN_IAM_ACTIONS: readonly string[] = ["iam:DeleteRolePermissionsBoundary", "iam:UpdateAssumeRolePolicy"];

/** Services a run may hand a role to: the ones tests use to run code. */
export const PASSABLE_SERVICES: readonly string[] = ["events.amazonaws.com", "lambda.amazonaws.com", "states.amazonaws.com"];

/** The first words of the read actions each default service has (from the Service Authorization Reference), so the allow lists only verbs that exist. Plus the reads that are not named Get, List or Describe. */
const READ_VERBS: Readonly<Record<string, readonly string[]>> = {
  dynamodb: ["Describe", "Get", "List"],
  events: ["Describe", "Get", "List"],
  iam: ["Get", "List"],
  kinesis: ["Describe", "Get", "List"],
  lambda: ["Get", "List"],
  logs: ["Describe", "Get", "List"],
  s3: ["Get", "List"],
  secretsmanager: ["Describe", "Get", "List"],
  sns: ["Get", "List"],
  sqs: ["Get", "List"],
  ssm: ["Describe", "Get", "List"],
  states: ["Describe", "Get", "List"],
};
const EXTRA_READS: readonly string[] = ["dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:Scan", "logs:FilterLogEvents"];

/**
 * Reads that hand out secrets or configuration with secrets in it, and the one read that takes something (a Step Functions worker's GetActivityTask takes a task; `states:Get*` is that and GetExecutionHistory). Allowed only on what the run owns: a run's own secret, parameter,
 * function and execution. A Lambda function's configuration carries its environment variables, in GetFunction, GetFunctionConfiguration, ListVersionsByFunction and, for every function, ListFunctions (no resource to fence, so refused outright); a layer version's GetLayerVersion hands out other teams' code, and layers are not fenced to a run, so it is refused for every run.
 */
const SECRET_READS: readonly string[] = [
  "lambda:GetFunction*",
  "lambda:GetLayerVersion*",
  "lambda:ListFunctions",
  "lambda:ListVersionsByFunction",
  "secretsmanager:*GetSecretValue",
  "ssm:GetParameter*",
  "states:DescribeExecution",
  "states:Get*",
];

/**
 * Actions a role the run creates never gets. It runs code the signer never sees, so it may use what the run built but not build or open anything: all of IAM; every creation of a queue, topic, table, stream, bus, function, secret,
 * state machine or bucket (the signer counts creates and caps sizes, and a created resource could carry a policy that opens it); capacity changes; and every action that opens a resource to a principal (queue, topic, bucket, event bus,
 * function, layer, document, table, stream and secret policies; a function URL). Rovara's test role keeps them and the signer reads what it sets. (CreateMultipartUpload is an upload, not a creation, so S3 is by name.)
 */
const RUN_ROLE_DENIED: readonly string[] = [
  "dynamodb:Create*",
  "dynamodb:PutResourcePolicy",
  "dynamodb:UpdateTable",
  "events:Create*",
  "events:PutPermission",
  "iam:*",
  "kinesis:Create*",
  "kinesis:PutResourcePolicy",
  "kinesis:Update*",
  "lambda:*Permission",
  "lambda:Create*",
  "lambda:*FunctionUrlConfig",
  "s3:CreateBucket",
  "s3:PutBucket*",
  "secretsmanager:Create*",
  "secretsmanager:PutResourcePolicy",
  "sns:AddPermission",
  "sns:Create*",
  "sns:SetTopicAttributes",
  "sqs:AddPermission",
  "sqs:Create*",
  "sqs:SetQueueAttributes",
  "ssm:Create*",
  "ssm:*Permission",
  "ssm:PutResourcePolicy",
  "states:Create*",
];

/**
 * Actions refused for every principal: the account's concurrency pool and Object Lock (nothing can be undone), replication to another Region that the Region deny cannot see (a DynamoDB replica, a global table, a secret replica),
 * and running commands on or attaching a document to instances, which are not the run's (SSM is for parameters). The signer guards what IAM cannot see: S3 Object Lock at CreateBucket, DynamoDB deletion protection.
 */
const ACCOUNT_POOL_ACTIONS: readonly string[] = [
  "dynamodb:CreateTableReplica",
  "dynamodb:UpdateGlobalTable*",
  "lambda:PutFunctionConcurrency",
  "lambda:PutProvisionedConcurrencyConfig",
  "s3:PutBucketObjectLockConfiguration",
  "s3:PutObjectLegalHold",
  "s3:PutObjectRetention",
  "secretsmanager:ReplicateSecretToRegions",
  "ssm:CreateAssociation",
  "ssm:SendCommand",
];

/** What the cleanup role may do beyond the delete actions: take a role apart before deleting it, and clear a table's deletion protection (UpdateTable) so it can be deleted. Inside the boundary, so only the run's own. */
const CLEANUP_EXTRAS: readonly string[] = [
  "dynamodb:UpdateTable",
  "iam:DeletePolicy",
  "iam:DeletePolicyVersion",
  "iam:DeleteRolePolicy",
  "iam:DetachRolePolicy",
  "iam:RemoveRoleFromInstanceProfile",
];

/** Created with the run tag, because the resource has no name of its own (an event source mapping is an id), and only for a run function. Nothing tags an existing resource, so this cannot claim one. */
const CREATE_BY_TAG: readonly string[] = ["lambda:CreateEventSourceMapping"];

/**
 * The resource types of each default service that tests create and use, as the part of the ARN after the account. `{{Name}}` is where the caller's name goes: the run's name `rv-<run8>-*`. A pattern ending in the name also covers the
 * resource's children (`table/rv-x-*` covers its indexes, a Lambda function covers its versions and aliases, a bucket its objects). Each must be a resource type the Service Authorization Reference lists with a leading name
 * (tests/unit/test-access-policy.test.ts checks), so a rename in AWS's data is caught. IAM is fenced to the run's roles, policies and instance profiles, never users, groups or providers.
 */
export const RUN_RESOURCES: Readonly<Record<string, readonly string[]>> = {
  dynamodb: ["table/{{Name}}"],
  // rules only on a run-named bus (rule/<bus>/<rule>): a rule on the default bus can match every event of the account
  events: ["event-bus/{{Name}}", "rule/{{Name}}/*"],
  iam: ["instance-profile/{{Name}}", "policy/{{Name}}", "role/{{Name}}"],
  kinesis: ["stream/{{Name}}"],
  lambda: ["function:{{Name}}"],
  logs: ["log-group:/aws/lambda/{{Name}}", "log-group:{{Name}}"],
  s3: ["{{Name}}"],
  secretsmanager: ["secret:{{Name}}"],
  sns: ["{{Name}}"],
  sqs: ["{{Name}}"],
  ssm: ["parameter/{{Name}}"],
  states: ["execution:{{Name}}", "stateMachine:{{Name}}"],
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
  // Partition, Region and account are `*` (the policy is at its size limit): a resource named for the run is the run's wherever it is. A bucket name is global, so S3 adds a condition on the account.
  const head = service === "s3" ? "arn:*:s3:::" : service === "iam" ? "arn:*:iam::*:" : `arn:*:${service}:*:*:`;
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

/** The resources a rule or a subscription may point at, one pattern per type: this account and Region (a token each), the run's name, anchored on the type. */
const TARGET_RESOURCES: Readonly<Record<string, string>> = { lambda: "function:{{Name}}", sqs: "{{Name}}", sns: "{{Name}}", states: "stateMachine:{{Name}}" };
function targetPatterns(services: readonly string[]): string[] {
  // A queue and a topic have the same shape (the name follows the account), so one pattern covers both.
  const shapes = new Set(services.filter((service) => TARGET_RESOURCES[service] !== undefined).map((service) => (service === "sqs" || service === "sns" ? "*" : service)));
  return [...shapes].sort().map((service) => (service === "*" ? `arn:*:*:{{Region}}:{{AccountId}}:${RUN_NAME_PATTERN}` : `arn:*:${service}:{{Region}}:{{AccountId}}:${(TARGET_RESOURCES[service] as string).replace("{{Name}}", RUN_NAME_PATTERN)}`));
}

/**
 * The roles a run creates, as `aws:PrincipalArn` shows a role's session: the ROLE's ARN (path included), not the assumed-role session ARN (AWS's documentation of the key; TA11 checks it). A principal of the policy is always of this
 * account and partition, so both are `*` (the policy is at its size limit). Rovara's own roles are named otherwise, and a role a run creates cannot have a path (CreateRole is refused one).
 */
const RUN_ROLES: readonly string[] = ["arn:*:iam::*:role/rv-*"];
const OWN_RUN_ROLES: readonly string[] = ["arn:*:iam::*:role/rv-${aws:PrincipalTag/rovara-run}-*"];

export function buildTestAccessPolicies(services: readonly string[] = DEFAULT_TEST_ACCESS_SERVICES): TestAccessPolicies {
  const sorted = [...new Set(services)].sort();
  const has = (service: string): boolean => sorted.includes(service);
  const onlyHeld = (actions: readonly string[]): string[] => actions.filter((action) => has(action.split(":")[0] as string));
  const patternsOf = (list: readonly string[]): string[] => dropSubsumed(list.flatMap((service) => runNamePatterns(service)));
  const withoutSpecial = sorted.filter((service) => service !== "s3" && service !== "iam");
  const baseline = ["sts:GetCallerIdentity", "tag:GetResources", "tag:GetTagKeys", "tag:GetTagValues"];
  const reads = [
    ...sorted.flatMap((service) => (READ_VERBS[service] ?? ["Describe", "Get", "List"]).map((verb) => `${service}:${verb}*`)),
    ...onlyHeld(EXTRA_READS),
    "sts:GetCallerIdentity",
    "tag:Get*",
  ];
  const secretNames = patternsOf(["lambda", "secretsmanager", "ssm", "states"].filter(has)).filter((pattern) => /:(function:|secret:|parameter\/|execution:)/u.test(pattern));
  const statements: PolicyStatement[] = [
    // Reads are Rovara's own roles' only: a role the run creates reads nothing outside its run, so an outside principal that gets to assume it reaches no more than the run's own resources.
    { Sid: "Reads", Effect: "Allow", Action: reads, Resource: "*", Condition: { ArnNotLike: { "aws:PrincipalArn": RUN_ROLES } } },
    // The account is checked too: a resource named for the run in another account is not the run's.
    { Sid: "Named", Effect: "Allow", Action: withoutSpecial.map((service) => `${service}:*`), Resource: patternsOf(withoutSpecial), Condition: { StringEquals: { "aws:ResourceAccount": "{{AccountId}}" } } },
  ];
  // S3 bucket names are global: a bucket named like the run's but in another account is not the run's, so the account is checked too.
  if (has("s3")) statements.push({ Sid: "NamedS3", Effect: "Allow", Action: ["s3:*"], Resource: patternsOf(["s3"]), Condition: { StringEquals: { "s3:ResourceAccount": "{{AccountId}}" } } });
  if (has("iam")) statements.push({ Sid: "NamedIam", Effect: "Allow", Action: ["iam:*"], Resource: patternsOf(["iam"]) });
  // What is tagged but not named: an event source mapping, which has an id. Taken apart by tag; made only for a run's own function (lambda:FunctionArn is a key of its create call).
  if (has("lambda")) {
    statements.push(
      { Sid: "Tagged", Effect: "Allow", Action: ["lambda:DeleteEventSourceMapping", "lambda:GetEventSourceMapping"], Resource: "*", Condition: { StringEquals: { [`aws:ResourceTag/${RUN_TAG_KEY}`]: RUN_TAG_VARIABLE } } },
      {
        Sid: "CreateByTag",
        Effect: "Allow",
        Action: onlyHeld(CREATE_BY_TAG),
        Resource: "*",
        Condition: { StringEquals: { [`aws:RequestTag/${RUN_TAG_KEY}`]: RUN_TAG_VARIABLE }, ArnLike: { "lambda:FunctionArn": "arn:*:lambda:*:*:function:rv-${aws:PrincipalTag/rovara-run}-*" } },
      },
    );
  }
  statements.push(
    // The one session tag every run carries. Without it every other check has nothing to compare, so nothing at all is allowed.
    { Sid: "NoTag", Effect: "Deny", NotAction: ["sts:GetCallerIdentity"], Resource: "*", Condition: { Null: { [`aws:PrincipalTag/${RUN_TAG_KEY}`]: "true" } } },
    // A session tag overrides a role's tag, so whoever assumes a run's role could name another run. A run's role is named for its run, and the tag must agree with the name.
    { Sid: "Forged", Effect: "Deny", Action: ["*"], Resource: "*", Condition: { ArnLike: { "aws:PrincipalArn": RUN_ROLES }, ArnNotLike: { "aws:PrincipalArn": OWN_RUN_ROLES } } },
    { Sid: "Region", Effect: "Deny", NotAction: GLOBAL_ACTIONS, Resource: "*", Condition: { StringNotEquals: { "aws:RequestedRegion": "{{Region}}" } } },
    // A request that carries the run tag key must carry this run's value, and a request that removes the key is refused.
    { Sid: "TagKey", Effect: "Deny", Action: ["*"], Resource: "*", Condition: { "ForAnyValue:StringEquals": { "aws:TagKeys": RUN_TAG_KEY }, StringNotEquals: { [`aws:RequestTag/${RUN_TAG_KEY}`]: RUN_TAG_VARIABLE } } },
    { Sid: "Pool", Effect: "Deny", Action: onlyHeld(ACCOUNT_POOL_ACTIONS), Resource: "*" },
    { Sid: "RunRoles", Effect: "Deny", Action: onlyHeld(RUN_ROLE_DENIED), Resource: "*", Condition: { ArnLike: { "aws:PrincipalArn": RUN_ROLES } } },
  );
  if (secretNames.length > 0) statements.push({ Sid: "Secrets", Effect: "Deny", Action: onlyHeld(SECRET_READS), NotResource: secretNames });
  if (has("events")) {
    // A rule's targets are the run's own, in this account and Region: a function, queue, topic or state machine named for it. TargetArn can hold several values, so one that is not the run's refuses the call, and a call with none is refused.
    statements.push(
      { Sid: "Targets", Effect: "Deny", Action: ["events:PutTargets"], Resource: "*", Condition: { "ForAnyValue:ArnNotLike": { "events:TargetArn": targetPatterns(sorted) } } },
      { Sid: "NoTarget", Effect: "Deny", Action: ["events:PutTargets"], Resource: "*", Condition: { Null: { "events:TargetArn": "true" } } },
    );
  }
  if (has("sns")) {
    // A subscription goes to a queue or function of the run only: no SMS, email or HTTP(S) endpoint, and nothing outside the run.
    statements.push({ Sid: "Subscribe", Effect: "Deny", Action: ["sns:Subscribe"], Resource: "*", Condition: { ArnNotLike: { "sns:Endpoint": targetPatterns(sorted.filter((service) => service === "sqs" || service === "lambda")) } } });
  }
  // The test role's own denies. Only it can call IAM (a role a run creates is denied all of it), so the rules about making roles are here and not in the boundary, which is full.
  const accessStatements: PolicyStatement[] = [{ Sid: "AllowTestServices", Effect: "Allow", Action: [...sorted.map((service) => `${service}:*`), ...baseline], Resource: "*" }];
  if (has("iam")) {
    accessStatements.push(
      { Sid: "Boundary", Effect: "Deny", Action: ["iam:CreateRole", "iam:PutRolePermissionsBoundary"], Resource: "*", Condition: { StringNotEquals: { "iam:PermissionsBoundary": "{{BoundaryArn}}" } } },
      // A role a run creates has no path, so the role ARN in a session is the run's name.
      { Sid: "NoPath", Effect: "Deny", Action: ["iam:CreateRole"], Resource: ["arn:*:iam::*:role/*/*"] },
      { Sid: "Pass", Effect: "Deny", Action: ["iam:PassRole"], Resource: "*", Condition: { StringNotEquals: { "iam:PassedToService": [...PASSABLE_SERVICES] } } },
      { Sid: "KeepBoundary", Effect: "Deny", Action: [...FORBIDDEN_IAM_ACTIONS], Resource: "*" },
    );
  }
  const access: PolicyDocument = { Version: "2012-10-17", Statement: accessStatements };
  const deletes = [...sorted.flatMap((service) => scopedDeleteActions(service)), ...onlyHeld(CLEANUP_EXTRAS)];
  const cleanup: PolicyDocument = { Version: "2012-10-17", Statement: [{ Sid: "AllowReadAndDelete", Effect: "Allow", Action: [...reads, ...deletes], Resource: "*" }] };
  return { boundary: { Version: "2012-10-17", Statement: statements }, access, cleanup };
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
