// The IAM policies of the customer test account (lane TA1): the permission boundary, the test role's access policy and the delete-only cleanup role's policy, built from one source so that
// the CloudFormation template, the Terraform module and the copy-paste policy text cannot drift apart. Pure functions; the per-action facts come from the generated scoping table (`test-access-scoping.ts`).
//
// The model (customer-test-account.md, section 2):
//   - Rovara assumes the role with the session tag `rovara-run=<run8>` (8 characters). A session with no run tag can do nothing.
//   - A run changes only what it created. IAM confines an action by the run tag (create: aws:RequestTag, write and delete: aws:ResourceTag) or by the resource name (`rv-<run8>-...`) where the action has neither;
//     an action IAM cannot confine at all is limited to the service and the Region, and the account signer's creation record guards it (TA4).
//   - Reads are open inside the connection's Region. There is no list of services to refuse: an expensive service may be what a test needs (owner decision 121).
//   - Roles a run creates carry the same boundary, so a run cannot make a role stronger than itself. Long-lived keys cannot be made.
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
import { nameArnPatternsOf, scopedActionsOf, type ScopedAction } from "./test-access-scoping.js";

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
 * The services a connection allows by default: the ones tests most often need. A service outside the list is refused by the boundary (a template version with a longer list is a new version, shown before it is used).
 * `sts` is not a service here: only `sts:GetCallerIdentity` is allowed, so a run cannot assume another role of the account.
 */
export const DEFAULT_TEST_ACCESS_SERVICES: readonly string[] = ["apigateway", "dynamodb", "events", "iam", "kinesis", "kms", "lambda", "logs", "s3", "secretsmanager", "sns", "sqs", "ssm", "states"];

/** Actions of services that are not Regional: the Region condition leaves them alone. */
const GLOBAL_ACTIONS: readonly string[] = ["iam:*", "s3:GetBucketLocation", "s3:ListAllMyBuckets", "sts:GetCallerIdentity"];

/** Actions that make long-lived credentials: Rovara never accepts them, and a run must never mint them. */
const LONG_LIVED_KEY_ACTIONS: readonly string[] = [
  "iam:CreateAccessKey",
  "iam:CreateLoginProfile",
  "iam:CreateServiceSpecificCredential",
  "iam:CreateUser",
  "iam:UpdateLoginProfile",
  "iam:UploadSSHPublicKey",
];

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

const SAFE_VERBS: ReadonlySet<string> = new Set(["Add", "Associate", "Attach", "Create", "Delete", "Deregister", "Detach", "Disable", "Disassociate", "Enable", "Modify", "Put", "Register", "Remove", "Set", "Tag", "Terminate", "Untag", "Update"]);

/**
 * `names` of one service as action patterns. A verb followed by `*` replaces three or more names that start with the same safe write verb, when no changing action of the service outside `names` starts with that verb
 * (reads never do). Reads are not in the scoping table, so this relies on the verbs: none of them starts a read action.
 */
export function compressActions(service: string, names: readonly string[], universe: readonly string[]): readonly string[] {
  const chosen = new Set(names);
  const byVerb = new Map<string, string[]>();
  for (const name of names) {
    const verb = /^[A-Z][a-z0-9]*/u.exec(name)?.[0] ?? name;
    byVerb.set(verb, [...(byVerb.get(verb) ?? []), name]);
  }
  const out: string[] = [];
  for (const [verb, group] of byVerb) {
    const foreign = universe.some((other) => other.startsWith(verb) && !chosen.has(other));
    if (SAFE_VERBS.has(verb) && group.length >= 3 && !foreign) out.push(`${service}:${verb}*`);
    else out.push(...group.map((name) => `${service}:${name}`));
  }
  return out;
}

function actionsOf(services: readonly string[], keep: (action: ScopedAction) => boolean): string[] {
  const out: string[] = [];
  for (const service of services) {
    const all = scopedActionsOf(service);
    const chosen = all.filter(keep).map((action) => action.action);
    if (chosen.length > 0) out.push(...compressActions(service, chosen, all.map((action) => action.action)));
  }
  return out.sort();
}

function namePatterns(services: readonly string[], keepService: (service: string) => boolean = () => true): string[] {
  const out = new Set<string>();
  for (const service of services) {
    if (!keepService(service)) continue;
    for (const pattern of nameArnPatternsOf(service)) out.add(pattern.replace("{{Name}}", RUN_NAME_PATTERN));
  }
  return [...out].sort();
}

const IAM_RUN_ARNS: readonly string[] = [
  `arn:{{Partition}}:iam::{{AccountId}}:instance-profile/${RUN_NAME_PATTERN}`,
  `arn:{{Partition}}:iam::{{AccountId}}:policy/${RUN_NAME_PATTERN}`,
  `arn:{{Partition}}:iam::{{AccountId}}:role/${RUN_NAME_PATTERN}`,
];

export interface TestAccessPolicies {
  /**
   * The permissions boundary of the test role, the cleanup role and every role a run creates. It must stay small (IAM's limit is 6,144 characters), so it holds the allow list of services and the
   * checks that need no per-action list: the run tag is required, one Region, the run tag cannot be changed, and the IAM rules (run-named roles only, the boundary on every role, no long-lived keys).
   */
  readonly boundary: PolicyDocument;
  /** What the test role may do (inside the boundary): the services, nothing else. */
  readonly access: PolicyDocument;
  /**
   * The per-action checks of the test role, as managed policies of at most IAM's size: create only with the run tag, change and delete only what carries it, act only on run-named resources where the action has no tag.
   * Explicit denies, so they hold wherever the role's allows come from. The test role has these attached next to `access`.
   */
  readonly guards: readonly PolicyDocument[];
  /** What the delete-only cleanup role may do (inside the boundary): reads, and the delete actions of the services. */
  readonly cleanup: PolicyDocument;
  /** The cleanup role's per-action checks: the same two delete-side guards. */
  readonly cleanupGuards: readonly PolicyDocument[];
}

/** Room left under IAM's limit for the policy's own framing. */
const CHUNK_BUDGET = IAM_MANAGED_POLICY_MAX_CHARS - 200;

/** Splits statements that carry long action lists into policies that each fit one managed policy. A statement's other parts (condition, NotResource) are repeated in each. */
export function chunkStatements(statements: readonly PolicyStatement[], budget: number = CHUNK_BUDGET): PolicyDocument[] {
  const documents: PolicyStatement[][] = [[]];
  const sizeOf = (list: readonly PolicyStatement[]): number => policySize({ Version: "2012-10-17", Statement: list });
  for (const statement of statements) {
    const actions = statement.Action ?? [];
    if (actions.length === 0) continue;
    let rest = [...actions];
    let part = 0;
    while (rest.length > 0) {
      const current = documents[documents.length - 1] as PolicyStatement[];
      const take: string[] = [];
      for (const action of rest) {
        const candidate: PolicyStatement = { ...statement, Sid: `${statement.Sid}${part + 1}`, Action: [...take, action] };
        if (sizeOf([...current, candidate]) > budget) break;
        take.push(action);
      }
      if (take.length === 0) {
        if (current.length === 0) throw new Error(`one action of ${statement.Sid} does not fit an empty policy`);
        documents.push([]);
        continue;
      }
      current.push({ ...statement, Sid: `${statement.Sid}${part + 1}`, Action: take });
      rest = rest.slice(take.length);
      part += 1;
    }
  }
  return documents.filter((list) => list.length > 0).map((list) => ({ Version: "2012-10-17", Statement: list }));
}

export function buildTestAccessPolicies(services: readonly string[] = DEFAULT_TEST_ACCESS_SERVICES): TestAccessPolicies {
  const sorted = [...new Set(services)].sort();
  const serviceAllow = sorted.map((service) => `${service}:*`);
  const baseline = ["sts:GetCallerIdentity", "tag:GetResources", "tag:GetTagKeys", "tag:GetTagValues"];
  const tagGuarded = (action: ScopedAction): boolean => action.guard === "tag";
  const allow: PolicyStatement = { Sid: "AllowTestServices", Effect: "Allow", Action: [...serviceAllow, ...baseline], Resource: "*" };
  const boundaryStatements: PolicyStatement[] = [
    allow,
    // The one session tag every run carries. Without it every other check has nothing to compare, so nothing at all is allowed.
    { Sid: "DenyWithoutRunTag", Effect: "Deny", NotAction: ["sts:GetCallerIdentity"], Resource: "*", Condition: { Null: { [`aws:PrincipalTag/${RUN_TAG_KEY}`]: "true" } } },
    { Sid: "DenyOtherRegions", Effect: "Deny", NotAction: GLOBAL_ACTIONS, Resource: "*", Condition: { StringNotEquals: { "aws:RequestedRegion": "{{Region}}" } } },
    // A request that carries the run tag key must carry this run's value, and a request that removes the key is refused: no action sets, changes or removes the tag on a resource it does not belong to, or on its own.
    {
      Sid: "DenyRunTagChange",
      Effect: "Deny",
      Action: ["*"],
      Resource: "*",
      Condition: { "ForAnyValue:StringEquals": { "aws:TagKeys": RUN_TAG_KEY }, StringNotEquals: { [`aws:RequestTag/${RUN_TAG_KEY}`]: RUN_TAG_VARIABLE } },
    },
  ];
  if (sorted.includes("iam")) {
    boundaryStatements.push(
      // IAM writes only on run-named roles, policies and instance profiles: the roles a run creates, never the connection's own roles, boundary or policies.
      { Sid: "DenyIamOutsideRunNames", Effect: "Deny", Action: actionsOf(["iam"], () => true), NotResource: IAM_RUN_ARNS },
      // A role a run creates carries this boundary, and the boundary cannot be taken off.
      { Sid: "DenyRoleWithoutBoundary", Effect: "Deny", Action: ["iam:CreateRole", "iam:PutRolePermissionsBoundary"], Resource: "*", Condition: { StringNotEquals: { "iam:PermissionsBoundary": "{{BoundaryArn}}" } } },
      { Sid: "DenyBoundaryRemoval", Effect: "Deny", Action: ["iam:DeleteRolePermissionsBoundary", "iam:DeleteUserPermissionsBoundary", "iam:PutUserPermissionsBoundary"], Resource: "*" },
      { Sid: "DenyLongLivedKeys", Effect: "Deny", Action: [...LONG_LIVED_KEY_ACTIONS], Resource: "*" },
    );
  }
  const guardStatements = (kinds: ReadonlySet<ScopedAction["kind"]>): PolicyStatement[] => {
    const guards: PolicyStatement[] = [];
    const create = actionsOf(sorted, (action) => kinds.has("create") && action.kind === "create" && tagGuarded(action));
    if (create.length > 0) guards.push({ Sid: "DenyCreateWithoutRunTag", Effect: "Deny", Action: create, Resource: "*", Condition: { StringNotEquals: { [`aws:RequestTag/${RUN_TAG_KEY}`]: RUN_TAG_VARIABLE } } });
    const change = actionsOf(sorted, (action) => (action.kind === "write" || action.kind === "delete" || action.kind === "permissions") && kinds.has(action.kind) && tagGuarded(action));
    if (change.length > 0) guards.push({ Sid: "DenyChangesToOtherResources", Effect: "Deny", Action: change, Resource: "*", Condition: { StringNotEquals: { [`aws:ResourceTag/${RUN_TAG_KEY}`]: RUN_TAG_VARIABLE } } });
    const named = sorted.filter((service) => service !== "iam");
    const byName = actionsOf(named, (action) => action.guard === "name" && kinds.has(action.kind));
    if (byName.length > 0) guards.push({ Sid: "DenyChangesOutsideRunNames", Effect: "Deny", Action: byName, NotResource: namePatterns(named) });
    const tagging = actionsOf(sorted, (action) => action.kind === "tagging" && kinds.has("tagging"));
    if (tagging.length > 0) {
      guards.push({
        Sid: "DenyTaggingOtherRuns",
        Effect: "Deny",
        Action: tagging,
        Resource: "*",
        Condition: { Null: { [`aws:ResourceTag/${RUN_TAG_KEY}`]: "false" }, StringNotEquals: { [`aws:ResourceTag/${RUN_TAG_KEY}`]: RUN_TAG_VARIABLE } },
      });
    }
    if (!kinds.has("write")) {
      // The cleanup role reads by verb pattern (Get*, List*, Describe*). A few changing actions are named like reads (a Step Functions worker's GetActivityTask takes a task): they are refused outright.
      const readNamed = actionsOf(sorted, (action) => action.kind !== "delete" && /^(Get|List|Describe)/u.test(action.action));
      if (readNamed.length > 0) guards.push({ Sid: "DenyChangesNamedLikeReads", Effect: "Deny", Action: readNamed, Resource: "*" });
    }
    return guards;
  };
  const readPatterns = sorted.flatMap((service) => [`${service}:Describe*`, `${service}:Get*`, `${service}:List*`]);
  return {
    boundary: { Version: "2012-10-17", Statement: boundaryStatements },
    access: { Version: "2012-10-17", Statement: [allow] },
    guards: chunkStatements(guardStatements(new Set(["create", "write", "delete", "permissions", "tagging"]))),
    cleanup: { Version: "2012-10-17", Statement: [{ Sid: "AllowReadAndDelete", Effect: "Allow", Action: [...readPatterns, ...baseline, ...actionsOf(sorted, (action) => action.kind === "delete")], Resource: "*" }] },
    cleanupGuards: chunkStatements(guardStatements(new Set(["delete"]))),
  };
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
