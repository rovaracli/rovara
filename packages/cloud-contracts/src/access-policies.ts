// The two access-stack policy documents as pure functions: no CDK imports, so they can be unit
// tested with plain strings and printed as JSON (the access stack passes CDK tokens instead).
import { defaultBoundaryName, environmentRolePath, environmentStackName, savedEnvCreateRoleName, savedEnvManageRoleName, savedEnvPullRoleName, savedEnvPushRoleName, savedEnvRolePrefix, STACK_PARTS } from "@rovara-code/contracts";
import { REALTIME_NAMESPACE } from "./realtime.js";

export interface PolicyScope {
  env: string;
  partition: string;
  region: string;
  account: string;
  artifactBucketArn: string;
  pullThroughPrefix: string;
  cloudFormationRoleName: string;
  permissionsBoundaryArn?: string;
  /**
   * The id of Rovara's own AWS Organization (`o-` and 10 to 32 lowercase letters or digits), from configuration, never from source. When set, the default
   * boundary's AssumeOrgRoles statement excludes every account of that organization, not only this one; when not, it excludes this account alone.
   */
  rovaraOrganizationId?: string;
  /**
   * 0.5.7, hosted cloud installs with a custom domain (infra/lib/custom-domain.ts): the name and the Route 53 hosted zone that holds its DNS. The service role then
   * (and only then) may request a certificate for that name, manage its certificates, and change records in that one zone. Absent: none of it is granted.
   * The values may be CDK tokens (the access stack passes its parameters).
   */
  customDomain?: { domainName: string; hostedZoneId: string };
}

export interface PolicyStatementJson {
  Sid: string;
  Effect: "Allow" | "Deny";
  Action: string[];
  Resource?: string | string[];
  /** Only a Deny names it: every resource except these (ruling M2's carve-out for the environment's broker managed policies). */
  NotResource?: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
}

/** The tag the custom domain's certificate carries (set by the stack, infra/lib/custom-domain.ts) and the deploy role's certificate grants are limited to. */
export const CUSTOM_DOMAIN_TAG = "agentx:env";
// A later change of stack-level tags (CDK tags the stack's resources) makes CloudFormation call AddTagsToCertificate with tags that may lack agentx:env; the grant below refuses
// such a call. If stack tags are ever added, include agentx:env=<env> in them, or the next update of the certificate fails with AccessDenied.

/**
 * The deploy (service) role's grants for the optional custom domain, and nothing else in Certificate Manager or Route 53:
 *  - RequestCertificate takes no resource (the certificate does not exist yet), so it is on "*", limited to this region, to the one domain name (and it must name one:
 *    ForAllValues is true for a request with no names, so a Null guard comes with it) and to a request that tags the certificate as this environment's;
 *  - the certificate's life after that (describe while it validates, remove tags, delete, list tags) is limited to certificates carrying this environment's tag, and
 *    tagging is limited to a request that sets that tag, so the role can touch no other certificate in the account;
 *  - the records: ChangeResourceRecordSets in the one hosted zone is limited to the domain's own name and the `_<hash>.<domain>` name of the DNS validation record,
 *    A, AAAA and CNAME only, so the zone's apex and every other record stay out of reach (route53:ChangeResourceRecordSetsNormalizedRecordNames is the lower-case name
 *    without the trailing dot, and an underscore is not escaped); the reads CloudFormation's record handler makes (GetHostedZone, ListResourceRecordSets) are on that zone,
 *    and ListHostedZones takes no resource;
 *  - GetChange waits for a change to reach the name servers; it names a change id, which cannot be known in advance.
 * Not in the permissions boundary: no role CloudFormation creates ever calls these.
 */
const customDomainStatements = (scope: Pick<PolicyScope, "env" | "partition" | "region" | "account" | "customDomain">): PolicyStatementJson[] => {
  const domain = scope.customDomain;
  if (domain === undefined) return [];
  const certificates = `arn:${scope.partition}:acm:${scope.region}:${scope.account}:certificate/*`;
  const zone = `arn:${scope.partition}:route53:::hostedzone/${domain.hostedZoneId}`;
  return [
    {
      Sid: "CustomDomainCertificateRequest", Effect: "Allow", Action: ["acm:RequestCertificate"], Resource: "*",
      Condition: {
        StringEquals: { "aws:RequestedRegion": scope.region, [`aws:RequestTag/${CUSTOM_DOMAIN_TAG}`]: scope.env },
        "ForAllValues:StringEquals": { "acm:DomainNames": [domain.domainName] },
        Null: { "acm:DomainNames": "false" },
      },
    },
    // Both tags: the request sets this environment's tag AND the certificate already has it (CloudFormation tags a certificate when it creates it), so the role cannot tag a certificate that is not its own and then delete it.
    { Sid: "CustomDomainCertificateTag", Effect: "Allow", Action: ["acm:AddTagsToCertificate"], Resource: certificates, Condition: { StringEquals: { [`aws:RequestTag/${CUSTOM_DOMAIN_TAG}`]: scope.env, [`aws:ResourceTag/${CUSTOM_DOMAIN_TAG}`]: scope.env } } },
    {
      Sid: "CustomDomainCertificates", Effect: "Allow", Action: ["acm:DescribeCertificate", "acm:DeleteCertificate", "acm:RemoveTagsFromCertificate", "acm:ListTagsForCertificate"], Resource: certificates,
      Condition: { StringEquals: { [`aws:ResourceTag/${CUSTOM_DOMAIN_TAG}`]: scope.env } },
    },
    {
      Sid: "CustomDomainRecords", Effect: "Allow", Action: ["route53:ChangeResourceRecordSets"], Resource: zone,
      Condition: {
        "ForAllValues:StringLike": { "route53:ChangeResourceRecordSetsNormalizedRecordNames": [domain.domainName, `_*.${domain.domainName}`] },
        "ForAllValues:StringEquals": { "route53:ChangeResourceRecordSetsRecordTypes": ["A", "AAAA", "CNAME"] },
        Null: { "route53:ChangeResourceRecordSetsNormalizedRecordNames": "false", "route53:ChangeResourceRecordSetsRecordTypes": "false" },
      },
    },
    { Sid: "CustomDomainZoneReads", Effect: "Allow", Action: ["route53:GetHostedZone", "route53:ListResourceRecordSets"], Resource: zone },
    { Sid: "CustomDomainZoneList", Effect: "Allow", Action: ["route53:ListHostedZones"], Resource: "*" },
    { Sid: "CustomDomainChanges", Effect: "Allow", Action: ["route53:GetChange"], Resource: `arn:${scope.partition}:route53:::change/*` },
  ];
};

/** Only this environment's uniquely named ECS deployment-failure rule. */
function ecsFailureRuleArn(scope: Pick<PolicyScope, "env" | "partition" | "region" | "account">): string {
  return `arn:${scope.partition}:events:${scope.region}:${scope.account}:rule/agentx-${scope.env}-*-service-failures`;
}

/** Services the service role may use with any resource; IAM is handled separately and name-scoped. CloudFront is not here: its actions are named below (`cloudFrontStatements`). */
export const SERVICE_ROLE_SERVICES: readonly string[] = [
  "apigateway",
  "cloudformation",
  "cloudwatch",
  "cognito-idp",
  "dynamodb",
  "ec2",
  "ecr",
  "ecs",
  "elasticloadbalancing",
  "kms",
  "lambda",
  "logs",
  "rds",
  // Route 53 Resolver: the cloud install's DNS firewall (domain lists, rule group, VPC association)
  // and its query logging config. The query log destination is a CloudWatch Logs group, so
  // CloudFormation also calls the logs delivery actions (CreateLogDelivery, PutResourcePolicy and
  // the rest), which "logs" already covers.
  "route53resolver",
  "s3",
  "scheduler",
  "secretsmanager",
  "sns",
  "sqs",
  "ssm",
  "states",
];

/**
 * The Team record's storage services (TR-SWITCH-B1/B2). NOT in SERVICE_ROLE_SERVICES: the service role gets named actions on this environment's own resources (teamRecordDeployStatements), never a wildcard.
 * They are in the boundary as wildcards, as a ceiling, because the boundary has no room to name the resources (see BOUNDARY_SERVICES).
 */
export const TEAM_RECORD_BOUNDARY_SERVICES: readonly string[] = ["athena", "s3tables", "s3vectors"];
/** The boundary's Deny on sharing the record's stores (see DenyRecordStoreSharing): policy and replication writes on S3 Tables and S3 Vectors. */
export const TEAM_RECORD_BOUNDARY_DENIED_ACTIONS: readonly string[] = ["s3tables:Put*Policy", "s3tables:Put*Replication", "s3vectors:Put*Policy"];

/**
 * Services the default permission boundary allows by wildcard: the service role's own, plus what
 * the environment's roles call (Bedrock models, X-Ray, CodeBuild and API Gateway invoke). STS and
 * Service Quotas are not here: sts:* would let a bounded role assume any same-account role that
 * trusts the account, escaping the boundary, and servicequotas:* would let it read every quota in
 * the account instead of only the two EC2 quotas prerequisites checks; the boundary names
 * sts:GetCallerIdentity, servicequotas:GetServiceQuota and, for the one ConnectorSecretsRole,
 * sts:AssumeRole and sts:TagSession (see defaultBoundaryStatements).
 * Budgets is a wildcard here only as a ceiling (phase 15d2, FR-047). AWS's service reference for
 * Budgets confirms that ModifyBudget, ViewBudget, TagResource, UntagResource and
 * ListTagsForResource take the budget/${BudgetName} resource, so the service and operator roles'
 * own statements name the one monthly budget; the boundary only bounds them and grants nothing by
 * itself. The generated test in access-stack.test.ts keeps this list complete and free of unused
 * services.
 * The Team record's three storage services (TEAM_RECORD_BOUNDARY_SERVICES) are wildcards here for the same reason, and for size: naming this environment's bucket, table bucket and workgroup in the boundary costs about 560
 * characters on top of the 560 it has free (a worst case of 6,461 against IAM's 6,144 limit, measured 2026-11-08). The deploy role's grants and the broker's and vector role's own policies name them; the boundary is only their ceiling.
 */
export const BOUNDARY_SERVICES: readonly string[] = [...SERVICE_ROLE_SERVICES, "bedrock", "budgets", "codebuild", "execute-api", "xray", ...TEAM_RECORD_BOUNDARY_SERVICES];


/**
 * The reads the boundary names on "*" in its Services statement: not the whole services (sts:*, servicequotas:*, glue:*, lakeformation:*), see the note above.
 * The Team record adds the Glue reads Athena's federated S3 Tables catalog makes (the catalog, databases and tables; the broker's own grant names this lake's) and lakeformation:GetDataAccess (no resource type, TRW-1 R3).
 */
export const BOUNDARY_NAMED_READS: readonly string[] = ["sts:GetCallerIdentity", "servicequotas:GetServiceQuota", "lakeformation:GetDataAccess", "glue:GetCatalog", "glue:GetDatabase*", "glue:GetTable*"];

/**
 * Service-linked roles the service role may create while deploying. route53resolver: associating
 * the DNS firewall's query logging config makes Resolver create AWSServiceRoleForRoute53Resolver
 * for the caller on first use in an account.
 */
export const SERVICE_LINKED_ROLE_SERVICES: readonly string[] = ["ecs.amazonaws.com", "elasticloadbalancing.amazonaws.com", "rds.amazonaws.com", "route53resolver.amazonaws.com"];

/**
 * Cognito's email service-linked role (Task 7). A user pool that sends with Amazon SES (EmailSendingAccount DEVELOPER) makes Cognito
 * create AWSServiceRoleForAmazonCognitoIdpEmailService on first use, and the caller must hold iam:CreateServiceLinkedRole
 * (https://docs.aws.amazon.com/cognito/latest/developerguide/using-service-linked-roles.html). Named exactly, apart from the wider
 * SERVICE_LINKED_ROLE_SERVICES statement, so nothing else under aws-service-role/ comes with it.
 */
const COGNITO_EMAIL_SERVICE = "email.cognito-idp.amazonaws.com";
const cognitoEmailServiceLinkedRole = (partition: string, account: string): PolicyStatementJson => ({
  Sid: "CognitoEmailServiceLinkedRole",
  Effect: "Allow",
  Action: ["iam:CreateServiceLinkedRole"],
  Resource: `arn:${partition}:iam::${account}:role/aws-service-role/${COGNITO_EMAIL_SERVICE}/AWSServiceRoleForAmazonCognitoIdpEmailService`,
  Condition: { StringEquals: { "iam:AWSServiceName": COGNITO_EMAIL_SERVICE } },
});

/**
 * ECR's repository creation template service-linked role (0.5.1 staging upgrade failure, 2026-11-03). An AWS::ECR::RepositoryCreationTemplate makes ECR
 * create AWSServiceRoleForECRTemplate on first use in an account, even when the template names a CustomRoleArn, and the caller must hold
 * iam:CreateServiceLinkedRole (https://docs.aws.amazon.com/AmazonECR/latest/userguide/slr-rct.html: the role trusts ecr.amazonaws.com). Named exactly, apart from the
 * wider SERVICE_LINKED_ROLE_SERVICES statement, like the Cognito one. Only the deploy (service) role needs it: no bounded role ever creates a repository creation template,
 * so the default boundary does not carry it (the boundary is at its size limit).
 */
const ECR_TEMPLATE_SERVICE = "ecr.amazonaws.com";
const ecrTemplateServiceLinkedRole = (partition: string, account: string): PolicyStatementJson => ({
  Sid: "EcrTemplateServiceLinkedRole",
  Effect: "Allow",
  Action: ["iam:CreateServiceLinkedRole"],
  Resource: `arn:${partition}:iam::${account}:role/aws-service-role/${ECR_TEMPLATE_SERVICE}/AWSServiceRoleForECRTemplate`,
  Condition: { StringEquals: { "iam:AWSServiceName": ECR_TEMPLATE_SERVICE } },
});

/**
 * What `agentx signin cloud --email-from` reads from Amazon SES (SESv2 GetEmailIdentity and GetAccount): the sending domain is verified,
 * and whether the account is out of the sandbox. Reads only; no send. GetAccount supports no resource, so "*" with the region condition.
 */
const sesChecks = (scope: Pick<PolicyScope, "partition" | "region" | "account">): PolicyStatementJson[] => [
  { Sid: "SesIdentityCheck", Effect: "Allow", Action: ["ses:GetEmailIdentity"], Resource: `arn:${scope.partition}:ses:${scope.region}:${scope.account}:identity/*` },
  { Sid: "SesAccountCheck", Effect: "Allow", Action: ["ses:GetAccount"], Resource: "*", Condition: { StringEquals: { "aws:RequestedRegion": scope.region } } },
];

/**
 * AppSync Events (Plan 5 Task 8): what CloudFormation's AWS::AppSync::Api (an Events API) and AWS::AppSync::ChannelNamespace handlers call to read, update, delete
 * and tag them, and no other AppSync action (no GraphQL, no publishing). Allowed by name, on this account's and region's APIs and their namespaces, in the service role and
 * (as a ceiling) in the boundary; the service role's `lambda:*` already covers the `lambda:AddPermission` and `lambda:RemovePermission` the authorizer's invoke permission needs.
 * `appsync:CreateApi` and `appsync:ListApis` are not here: they take no resource type (the API does not exist yet), so an ARN never matches them (`APPSYNC_EVENTS_UNSCOPED_ACTIONS`).
 */
export const APPSYNC_EVENTS_ACTIONS: readonly string[] = [
  "appsync:GetApi",
  "appsync:UpdateApi",
  "appsync:DeleteApi",
  "appsync:CreateChannelNamespace",
  "appsync:GetChannelNamespace",
  "appsync:UpdateChannelNamespace",
  "appsync:DeleteChannelNamespace",
  "appsync:TagResource",
  "appsync:UntagResource",
  "appsync:ListTagsForResource",
];
/** The two AppSync actions that take no resource type, so they need `Resource: "*"`, held to the deploy region by `aws:RequestedRegion`. */
export const APPSYNC_EVENTS_UNSCOPED_ACTIONS: readonly string[] = ["appsync:CreateApi", "appsync:ListApis"];
const appsyncEvents = (scope: Pick<PolicyScope, "partition" | "region" | "account">): PolicyStatementJson[] => [
  { Sid: "AppSyncEvents", Effect: "Allow", Action: [...APPSYNC_EVENTS_ACTIONS], Resource: `arn:${scope.partition}:appsync:${scope.region}:${scope.account}:apis/*` },
  { Sid: "AppSyncEventsCreate", Effect: "Allow", Action: [...APPSYNC_EVENTS_UNSCOPED_ACTIONS], Resource: "*", Condition: { StringEquals: { "aws:RequestedRegion": scope.region } } },
];


/**
 * CloudFront (the web app's asset distribution, its origin access control and its response headers policy), by name and by ARN instead of `cloudfront:*` on "*". Checked against AWS's
 * service authorization reference (servicereference.us-east-1.amazonaws.com/v1/cloudfront/cloudfront.json, 2026-10-26); CloudFront ARNs carry no region.
 *  This is the service role's list; the boundary's ceiling (CLOUDFRONT_BOUNDARY_ACTIONS) is coarser, see there.
 *  - Distributions take the environment tag (`agentx:env`, which Tags.of(app) puts on the distribution): CreateDistribution (what CloudFormation's create-with-tags call is authorized as,
 *    together with TagResource) only when the request carries this environment's tag; TagResource on "*" (the resource the create-time tag call is authorized against is not known, so it is not
 *    pinned to distribution ARNs) only with that request tag; and every other action, TagResource included (a later update that changes only other tags sends no agentx:env), only on a distribution
 *    that carries the tag, so one environment's role cannot create, change or delete another's. Two Denies keep it so: no TagResource on a distribution tagged for another environment, and none
 *    that sets another environment's value. CreateDistribution takes no resource type (the distribution does not exist yet), so it needs "*", held by the request tag.
 *  - Origin access controls and response headers policies support no tags and no condition keys. Their get, update and delete are scoped to this account's ARNs, but not to one environment (the id
 *    is generated), and their create actions take no resource type, so they need "*". The environment is only in their names.
 *  - Read-only hedges on "*": GetCachePolicy (attaching the managed CachingOptimized policy; it is not known whether CloudFront authorizes that read against the managed policy's ARN, which carries no
 *    environment either way) and the four List calls (ListDistributions, ListOriginAccessControls, ListResponseHeadersPolicies, ListCachePolicies take no resource type). Drop them once a
 *    deploy proves CloudFormation does not call them.
 */
export const CLOUDFRONT_ENV_TAG = "agentx:env";
export const CLOUDFRONT_DISTRIBUTION_CREATE_ACTIONS: readonly string[] = ["cloudfront:CreateDistribution"];
export const CLOUDFRONT_DISTRIBUTION_TAG_ACTIONS: readonly string[] = ["cloudfront:TagResource"];
export const CLOUDFRONT_DISTRIBUTION_ACTIONS: readonly string[] = [
  "cloudfront:TagResource",
  "cloudfront:GetDistribution",
  "cloudfront:GetDistributionConfig",
  "cloudfront:UpdateDistribution",
  "cloudfront:DeleteDistribution",
  "cloudfront:ListTagsForResource",
  "cloudfront:UntagResource",
];
export const CLOUDFRONT_ORIGIN_ACCESS_CONTROL_ACTIONS: readonly string[] = ["cloudfront:GetOriginAccessControl", "cloudfront:GetOriginAccessControlConfig", "cloudfront:UpdateOriginAccessControl", "cloudfront:DeleteOriginAccessControl"];
export const CLOUDFRONT_RESPONSE_HEADERS_POLICY_ACTIONS: readonly string[] = ["cloudfront:GetResponseHeadersPolicy", "cloudfront:GetResponseHeadersPolicyConfig", "cloudfront:UpdateResponseHeadersPolicy", "cloudfront:DeleteResponseHeadersPolicy"];
/** The actions that need Resource "*": two creates that take no resource type, and the read-only hedges described above. */
export const CLOUDFRONT_UNSCOPED_ACTIONS: readonly string[] = [
  "cloudfront:CreateOriginAccessControl",
  "cloudfront:CreateResponseHeadersPolicy",
  "cloudfront:GetCachePolicy",
  "cloudfront:ListCachePolicies",
  "cloudfront:ListDistributions",
  "cloudfront:ListOriginAccessControls",
  "cloudfront:ListResponseHeadersPolicies",
];
/**
 * The boundary's CloudFront ceiling: action families, not `cloudfront:*`, on "*", appended to the boundary's one `Services` statement. The service role holds the exact actions, ARNs and
 * tag conditions above, and a role's effective permission is the intersection of its policy and the boundary, so the boundary only has to exclude the rest of CloudFront (functions,
 * key-value stores, public keys, field-level encryption, invalidations and so on). It is this coarse because the boundary is an IAM managed policy, capped at 6,144 characters, and the
 * boundary without CloudFront is already within 150 characters of that cap for the longest environment name, so every extra character counts (the size test in access-policies.test.ts holds the line).
 * `*Polic*` is the cache and response headers policy actions (and, being a ceiling, the other CloudFront policy kinds); `*Tag*` is TagResource, UntagResource and ListTagsForResource.
 */
export const CLOUDFRONT_BOUNDARY_ACTIONS: readonly string[] = [
  "cloudfront:*Distribution*",
  "cloudfront:*OriginAccessControl*",
  "cloudfront:*Polic*",
  "cloudfront:*Tag*",
];
const cloudFrontStatements = (scope: Pick<PolicyScope, "env" | "partition" | "account">): PolicyStatementJson[] => {
  const arn = (type: string) => `arn:${scope.partition}:cloudfront::${scope.account}:${type}/*`;
  return [
    { Sid: "CloudFrontDistributionCreate", Effect: "Allow", Action: [...CLOUDFRONT_DISTRIBUTION_CREATE_ACTIONS], Resource: "*", Condition: { StringEquals: { [`aws:RequestTag/${CLOUDFRONT_ENV_TAG}`]: scope.env } } },
    { Sid: "CloudFrontDistributionTag", Effect: "Allow", Action: [...CLOUDFRONT_DISTRIBUTION_TAG_ACTIONS], Resource: "*", Condition: { StringEquals: { [`aws:RequestTag/${CLOUDFRONT_ENV_TAG}`]: scope.env } } },
    { Sid: "CloudFrontDistributions", Effect: "Allow", Action: [...CLOUDFRONT_DISTRIBUTION_ACTIONS], Resource: arn("distribution"), Condition: { StringEquals: { [`aws:ResourceTag/${CLOUDFRONT_ENV_TAG}`]: scope.env } } },
    { Sid: "CloudFrontPolicies", Effect: "Allow", Action: [...CLOUDFRONT_ORIGIN_ACCESS_CONTROL_ACTIONS, ...CLOUDFRONT_RESPONSE_HEADERS_POLICY_ACTIONS], Resource: [arn("origin-access-control"), arn("response-headers-policy")] },
    { Sid: "CloudFrontUnscoped", Effect: "Allow", Action: [...CLOUDFRONT_UNSCOPED_ACTIONS], Resource: "*" },
    // TagResource on "*" with this environment's request tag (the create path, whichever resource CloudFront authorizes it against) cannot also require the resource's current tag (a new distribution has none yet),
    // so without the first Deny a role could re-tag another environment's distribution as its own; the second never lets a role set another environment's value. A distribution with no tag is not matched by the first.
    { Sid: "CloudFrontKeepEnvironmentTag", Effect: "Deny", Action: [...CLOUDFRONT_DISTRIBUTION_TAG_ACTIONS], Resource: arn("distribution"), Condition: { Null: { [`aws:ResourceTag/${CLOUDFRONT_ENV_TAG}`]: "false" }, StringNotEquals: { [`aws:ResourceTag/${CLOUDFRONT_ENV_TAG}`]: scope.env } } },
    { Sid: "CloudFrontOnlyOwnEnvironmentTag", Effect: "Deny", Action: [...CLOUDFRONT_DISTRIBUTION_TAG_ACTIONS], Resource: "*", Condition: { Null: { [`aws:RequestTag/${CLOUDFRONT_ENV_TAG}`]: "false" }, StringNotEquals: { [`aws:RequestTag/${CLOUDFRONT_ENV_TAG}`]: scope.env } } },
  ];
};

/** Role management the service role needs on this environment's roles. */
const ROLE_ACTIONS = [
  "iam:CreateRole",
  "iam:DeleteRole",
  "iam:GetRole",
  "iam:UpdateRole",
  "iam:UpdateRoleDescription",
  "iam:TagRole",
  "iam:UntagRole",
  "iam:PutRolePolicy",
  "iam:DeleteRolePolicy",
  "iam:GetRolePolicy",
  "iam:AttachRolePolicy",
  "iam:DetachRolePolicy",
  "iam:UpdateAssumeRolePolicy",
  "iam:PutRolePermissionsBoundary",
  "iam:ListRolePolicies",
  "iam:ListAttachedRolePolicies",
];

/**
 * Managed-policy management (Plan 3, ruling M2): the broker's grants live in named customer-managed policies (agentx-<env>-broker-<group>)
 * because IAM caps a role's inline policies at 10,240 characters in total. These are exactly the actions CloudFormation's
 * AWS::IAM::ManagedPolicy handlers use (create, read, update, delete), no SetDefaultPolicyVersion (CreatePolicyVersion sets the default)
 * and no Attach/Detach (ROLE_ACTIONS has them, on roles). Allowed only on this environment's policy/agentx/<env>/agentx-<env>-broker-*, in the service role and the boundary.
 */
export const MANAGED_POLICY_ACTIONS: readonly string[] = [
  "iam:CreatePolicy",
  "iam:DeletePolicy",
  "iam:CreatePolicyVersion",
  "iam:DeletePolicyVersion",
  "iam:GetPolicy",
  "iam:GetPolicyVersion",
  "iam:ListPolicyVersions",
  "iam:TagPolicy",
  "iam:UntagPolicy",
  "iam:ListEntitiesForPolicy",
];

/** The path the broker's managed grant policies live under (the environment's role path, ruling M2). */
export function brokerManagedPolicyPath(env: string): string {
  return environmentRolePath(env);
}

/** The broker's managed grant policies' name prefix, agentx-<env>-broker (ruling M2). */
export function brokerManagedPolicyPrefix(env: string): string {
  return `agentx-${env}-broker`;
}

/**
 * The managed policies this environment's deploy may manage (ruling M2, owner-approved 2026-10-21): only its own broker grant
 * policies, under its own path, so one environment's deploy cannot touch another's policies, the default boundary
 * (agentx-<env>-boundary, which this prefix never matches) or any other agentx-named policy in the account.
 */
function agentxManagedPolicies(scope: Pick<PolicyScope, "env" | "partition" | "account">): string {
  return `arn:${scope.partition}:iam::${scope.account}:policy${brokerManagedPolicyPath(scope.env)}${brokerManagedPolicyPrefix(scope.env)}-*`;
}

/** Instance profile management the service role needs for the EC2 workers' instance profile. */
const INSTANCE_PROFILE_ACTIONS = [
  "iam:CreateInstanceProfile",
  "iam:DeleteInstanceProfile",
  "iam:GetInstanceProfile",
  "iam:AddRoleToInstanceProfile",
  "iam:RemoveRoleFromInstanceProfile",
  "iam:TagInstanceProfile",
  "iam:UntagInstanceProfile",
];

/**
 * What AWS::Budgets::Budget needs to create, update, delete and tag the monthly budget (phase
 * 15d2, FR-047). AWS Budgets has no separate Create/Update/Delete action: ModifyBudget covers all
 * three, and ViewBudget covers every read. No BudgetsAction permission: this is a plain budget with
 * notifications, not the separate AWS::Budgets::BudgetsAction resource.
 */
const BUDGET_ACTIONS = ["budgets:ModifyBudget", "budgets:ViewBudget", "budgets:TagResource", "budgets:UntagResource", "budgets:ListTagsForResource"];

/**
 * The Team record (TR-SWITCH-B1/B2, 0.5.11): what CloudFormation's handlers call to create, update and delete the record's three storage resources, taken from the handler permissions the public
 * CloudFormation registry publishes for each type (read 2026-11-08, pinned in tests/fixtures/cfn-handler-permissions-team-record-2026-11-08.json and checked by tests/contract/team-record-iam-coverage.test.ts), and nothing else
 * of S3 Vectors, S3 Tables or Athena. Each is on this environment's own resource names (`agentx-<env>-record-vectors|record-lake|record`), never on another bucket or workgroup of the account.
 * The `kms:*` and `s3:*` the handlers also call are already in the service role's Services statement, and the Athena results bucket is an ordinary S3 bucket.
 * Not granted, on purpose (the record sets none of these properties, so the handlers do not call them): `iam:PassRole` and `iam:CreateServiceLinkedRole` that the table bucket and workgroup handlers list (the record passes
 * no role to either), and `s3tables:PutTableBucketReplication` (it would let a deploy copy the lake to another bucket). `s3tables:DeleteTableBucketReplication` IS granted (IAM review F1): removing a
 * replication cannot copy data anywhere, and the TableBucket update and delete handlers may call it unconditionally, so withholding it could fail an update or the rollback of a failed switch-on.
 *
 * The service role's inline policy is capped at 10,240 characters, so the actions are IAM name patterns, each chosen to match exactly the handler actions and no other action of the service (the coverage test checks the
 * match set against AWS's full action list for each service, pinned in tests/fixtures/team-record-service-actions-2026-11-08.json): `*VectorBucket` is Create/Get/DeleteVectorBucket and not the *Policy actions, `*Tag*` is
 * TagResource, UntagResource and ListTagsForResource, `*Namespace*` is the four namespace actions, `*WorkGroup` is Create/Get/Update/DeleteWorkGroup and not ListWorkGroups, and so on.
 */
export const TEAM_RECORD_VECTORS_DEPLOY_ACTIONS: readonly string[] = ["s3vectors:*VectorBucket", "s3vectors:*Index", "s3vectors:ListIndexes", "s3vectors:*Tag*"];
export const TEAM_RECORD_LAKE_DEPLOY_ACTIONS: readonly string[] = [
  // the table bucket: create/get/delete, its encryption, its maintenance and metrics configuration, its storage class, a read of its replication and the removal of one (explicit, on the lake table bucket; see below)
  "s3tables:*TableBucket", "s3tables:*TableBucketEncryption", "s3tables:*TableBucket*Configuration", "s3tables:*Table*StorageClass", "s3tables:GetTableBucketReplication", "s3tables:DeleteTableBucketReplication",
  // the namespace and the tables: create, list, get, rename, delete, the data write CreateTable makes, a table's maintenance configuration
  "s3tables:*Namespace*", "s3tables:CreateTable", "s3tables:ListTables", "s3tables:GetTable", "s3tables:DeleteTable", "s3tables:RenameTable", "s3tables:PutTableData", "s3tables:*TableMaintenanceConfiguration",
  "s3tables:*Tag*",
];
export const TEAM_RECORD_WORK_GROUP_DEPLOY_ACTIONS: readonly string[] = ["athena:*WorkGroup", "athena:*Tag*"];
/**
 * The three List calls the handlers' list operations make. They take no resource type, so they can only be on "*" (the same reason as CreateApi above); they return names and ARNs only, no data. CloudFormation's own
 * create, update and delete do not need them as far as is known, so this statement is the first to drop if a staging deploy proves it unused ([verify on staging]).
 */
export const TEAM_RECORD_LIST_ACTIONS: readonly string[] = ["s3vectors:ListVectorBuckets", "s3tables:ListTableBuckets", "athena:ListWorkGroups"];

/** The ARNs of the record's storage in this environment. A vector bucket and a table bucket carry no region in their names, so the ARNs name the deploy region and account. */
function teamRecordArns(scope: Pick<PolicyScope, "env" | "partition" | "region" | "account">) {
  const names = recordStorageNames(scope.env);
  const at = (service: string) => `arn:${scope.partition}:${service}:${scope.region}:${scope.account}:`;
  return {
    vectorBucket: `${at("s3vectors")}bucket/${names.vectorBucket}`,
    tableBucket: `${at("s3tables")}bucket/${names.tableBucket}`,
    workGroup: `${at("athena")}workgroup/${names.workGroup}`,
  };
}

/**
 * The service role's grants for the Team record's storage (see TEAM_RECORD_VECTORS_DEPLOY_ACTIONS). They exist whether or not the record is switched on: the access stack is deployed before the control plane that creates the
 * resources, and a switch-on must not need a second access deploy. One statement for the three services (an action only ever applies to an ARN of its own service), and the List calls on "*".
 */
function teamRecordDeployStatements(scope: Pick<PolicyScope, "env" | "partition" | "region" | "account">): PolicyStatementJson[] {
  const arn = teamRecordArns(scope);
  return [
    {
      Sid: "TeamRecordStorage", Effect: "Allow",
      Action: [...TEAM_RECORD_VECTORS_DEPLOY_ACTIONS, ...TEAM_RECORD_LAKE_DEPLOY_ACTIONS, ...TEAM_RECORD_WORK_GROUP_DEPLOY_ACTIONS],
      Resource: [arn.vectorBucket, `${arn.vectorBucket}/index/*`, arn.tableBucket, `${arn.tableBucket}/table/*`, arn.workGroup],
    },
    { Sid: "TeamRecordLists", Effect: "Allow", Action: [...TEAM_RECORD_LIST_ACTIONS], Resource: "*" },
  ];
}

/**
 * The control plane's ConnectorSecretsRole (Plan 3, ruling R62): the broker assumes it, tagged with an org, to reach that
 * org's connection and hook secrets. Fixed so the default boundary can name it as the one role a bounded role may assume.
 */
export function connectorSecretsRoleName(env: string): string {
  return `agentx-${env}-connector-secrets`;
}

/**
 * The control plane's TestAccountSecretsRole (test services TS26): the broker assumes it, tagged with an org and a purpose (`store` or `resolve`), to keep and hand out a customer test account's secret
 * (agentx/<env>/org-test-accounts/<org>/...). It starts with the ConnectorSecretsRole's name on purpose: the default boundary names the two with one `connector-secrets*` ARN, because the deployed
 * boundary has no room for another ARN (its size test keeps 150 characters free). The boundary is only a ceiling; the role's own policies and the broker's exact grant are what allow anything.
 */
export function testAccountSecretsRoleName(env: string): string {
  return `${connectorSecretsRoleName(env)}-test-accounts`;
}

/**
 * The role EventBridge Scheduler assumes to invoke the broker for a schedule trigger (Plan 4 Task 26), and the queue that keeps the invocations that failed. Fixed names, so the broker
 * builds the role's ARN and the queue's URL from the environment (like the connector secrets role) and its environment, held to 4 KB, carries neither. The role is created under the
 * environment's path like every other, so a fixed-name role needs its path-less ARN in the deploy role's lookup grant where that list exists.
 */
export function chainScheduleRoleName(env: string): string {
  return `agentx-${env}-chain-schedule`;
}

export function chainScheduleQueueName(env: string): string {
  return `agentx-${env}-chain-schedule-dead-letters`;
}

/**
 * The three roles that hold an `sts:AssumeRole` grant into another AWS account's role, with fixed names so the default boundary's AssumeOrgRoles statement can name
 * them exactly (CloudFormation's generated names are cut short and carry a hash, which no ArnLike can name). Longest, for a 20-character environment: 46 characters.
 */
export function brokerRoleName(env: string): string {
  return `agentx-${env}-broker-role`;
}

/** The model proxy's ECS task role: its Bedrock sources assume a company's role (Plan 3). */
export function modelProxyTaskRoleName(env: string): string {
  return `agentx-${env}-model-proxy-task`;
}

/** The model access function's role, which runs the Bedrock source probe (Plan 3). */
export function modelAccessProbeRoleName(env: string): string {
  return `agentx-${env}-model-access-probe`;
}

/** An AWS Organizations id: `o-` and 10 to 32 lowercase letters or digits. */
export const ORGANIZATION_ID_PATTERN = /^o-[a-z0-9]{10,32}$/;

/**
 * The one environment where the control plane builds the Task Person proof role (infra/lib/task-person-proof.ts), by a fixed name.
 * Named here so the deploy role can name the role too.
 */
export const TASK_PERSON_PROOF_ENV = "agentxlivetest123";

/** The Task Person proof role's fixed name (see TASK_PERSON_PROOF_ENV). */
export function taskPersonProofRoleName(env: string): string {
  return `${env}-task-person-proof`;
}

/**
 * The Team record's vector data role (infra/lib/team-record-vectors.ts): the broker assumes it, tagged with a workspace's index name, to reach one workspace's vector index. Fixed (it was a CloudFormation-generated name, which no
 * boundary ARN can name, TR-SWITCH-B2) so the default boundary can name it as a role a bounded role may assume, and the deploy role and the boundary can answer the path-less lookup of a role that does not exist yet.
 * The role is only created while the record is switched on (agentxTeamRecord=enabled), and nothing was deployed with the old generated name (the record has never been switched on), so the rename moves no live role.
 */
export function teamRecordVectorsRoleName(env: string): string {
  return `agentx-${env}-record-vectors-data`;
}

/**
 * The names the Team record gives its storage, `agentx-<env>-record-vectors|record-lake|record`. They are the same strings as teamRecordVectorBucketName, teamRecordTableBucketName and teamRecordWorkGroupName in derived-names.ts, which
 * imports this file and so cannot be imported here; tests/contract/team-record-iam-coverage.test.ts pins the two to each other.
 */
const recordStorageNames = (env: string) => ({ vectorBucket: `agentx-${env}-record-vectors`, tableBucket: `agentx-${env}-record-lake`, workGroup: `agentx-${env}-record` });

/**
 * Every role the environment's stacks create under a fixed RoleName (the access stack's two roles are not among them: they are
 * created at the root by the operator). Each one needs the path-less grant of fixedNameRoleLookupStatement, so keep this list
 * complete: tests/contract/role-paths.test.ts compares it with the synthesized templates.
 */
export function fixedNameEnvironmentRoleNames(env: string): string[] {
  return [
    connectorSecretsRoleName(env), testAccountSecretsRoleName(env), brokerRoleName(env), modelProxyTaskRoleName(env), modelAccessProbeRoleName(env), chainScheduleRoleName(env),
    savedEnvPushRoleName(env), savedEnvPullRoleName(env), savedEnvManageRoleName(env), savedEnvCreateRoleName(env),
    teamRecordVectorsRoleName(env),
    ...(env === TASK_PERSON_PROOF_ENV ? [taskPersonProofRoleName(env)] : []),
  ];
}

/**
 * Reads and deletes that IAM authorizes against a role's path-less ARN while the role does not exist: CloudFormation looks a
 * fixed-name role up by name before creating it (iam:GetRole), and cleans it up by name when a create rolls back, and IAM,
 * which cannot know the path of a missing role, checks role/<name>, not role/agentx/<env>/<name>. No create or change action
 * is here, so a role at the root path can never be made; the real role is created under the environment path, where the
 * ordinary IamRoles statement applies.
 */
const FIXED_NAME_ROLE_LOOKUP_ACTIONS = [
  "iam:GetRole",
  "iam:GetRolePolicy",
  "iam:ListRolePolicies",
  "iam:ListAttachedRolePolicies",
  "iam:DeleteRolePolicy",
  "iam:DetachRolePolicy",
  "iam:DeleteRole",
];

/**
 * `forBoundary`: the boundary (a ceiling, 6,144 characters with no room left) names the ConnectorSecretsRole and the TestAccountSecretsRole, whose names share a prefix, with the one ARN
 * `...connector-secrets*`. The service role's own statement, which is what actually allows the lookups, still names each role exactly.
 */
function fixedNameRoleLookupStatement(scope: Pick<PolicyScope, "env" | "partition" | "account">, forBoundary = false): PolicyStatementJson {
  const shared = connectorSecretsRoleName(scope.env);
  const names = fixedNameEnvironmentRoleNames(scope.env);
  const listed = forBoundary ? [...names.filter((name) => !name.startsWith(shared)), `${shared}*`] : names;
  return {
    Sid: "IamFixedNameRolesNotYetCreated",
    Effect: "Allow",
    Action: [...FIXED_NAME_ROLE_LOOKUP_ACTIONS],
    // Not the root-path roles: IamRoles names those in full (the same ARN), and the deployed boundary has little room.
    Resource: listed.map((name) => `arn:${scope.partition}:iam::${scope.account}:role/${name}`).filter((arn) => !rootPathRoles(scope).includes(arn)),
  };
}

/**
 * The default boundary's ARN. Deterministic (fixed name and path), so every other environment stack
 * can name it without a cross-stack import.
 */
export function defaultBoundaryArn(scope: Pick<PolicyScope, "env" | "partition" | "account">): string {
  return `arn:${scope.partition}:iam::${scope.account}:policy${environmentRolePath(scope.env)}${defaultBoundaryName(scope.env)}`;
}

/**
 * Role ARNs this environment's stacks may create and manage: every role under the environment's
 * IAM path. A path, not a name prefix, because CloudFormation truncates generated role names (a
 * long environment name loses the agentx-<env>- prefix) and agentx-prod-* would also match the
 * roles of an environment named prod-eu.
 */
function environmentRoles(scope: Pick<PolicyScope, "env" | "partition" | "account">): string {
  return `arn:${scope.partition}:iam::${scope.account}:role${environmentRolePath(scope.env)}*`;
}

/**
 * Roles of this environment that must sit at the root path: ECR's CustomRoleArn pattern (^arn:aws[-a-z0-9]*:iam::[0-9]{12}:role/[A-Za-z0-9+=,-.@_]*$)
 * has no room for a path, so the saved environment images' creation role (named in the creation template) cannot live under /agentx/<env>/.
 * Each is granted the same role actions as the roles under the path, on its one exact ARN, with the boundary required as for the rest.
 */
function rootPathRoles(scope: Pick<PolicyScope, "env" | "partition" | "account">): string[] {
  return [`arn:${scope.partition}:iam::${scope.account}:role/${savedEnvCreateRoleName(scope.env)}`];
}

/** The boundary's one action pattern for INSTANCE_PROFILE_ACTIONS (see defaultBoundaryStatements): the same seven actions, checked against AWS's service authorization reference. */
export const BOUNDARY_INSTANCE_PROFILE_ACTIONS = "iam:*InstanceProfile";

/** Instance profiles under the environment's IAM path, like its roles. */
function environmentInstanceProfiles(scope: Pick<PolicyScope, "env" | "partition" | "account">): string {
  return `arn:${scope.partition}:iam::${scope.account}:instance-profile${environmentRolePath(scope.env)}*`;
}

/**
 * The inline policy of the role CloudFormation assumes to deploy this environment's stacks. The
 * boundary Deny statements name `permissionsBoundaryArn` when given, else the default boundary.
 */
export function serviceRoleStatements(scope: PolicyScope): PolicyStatementJson[] {
  const roles = environmentRoles(scope);
  const withRootRoles = [roles, ...rootPathRoles(scope)];
  const boundary = scope.permissionsBoundaryArn ?? defaultBoundaryArn(scope);
  return [
    { Sid: "Services", Effect: "Allow", Action: SERVICE_ROLE_SERVICES.map((s) => `${s}:*`), Resource: "*" },
    // Keep the resource exact to this environment's rule. EventBridge actions that do not
    // support rule resources remain unavailable with this resource constraint.
    { Sid: "EcsFailureEventsRule", Effect: "Allow", Action: ["events:*"], Resource: ecsFailureRuleArn(scope) },
    ...appsyncEvents(scope),
    ...cloudFrontStatements(scope),
    ...customDomainStatements(scope),
    // iam:PassRole is here (it was a statement of its own, PassRoles, on the same two resources with the same Effect and no Condition): the same allowance in less room, as in the boundary's IamRoles.
    { Sid: "IamRoles", Effect: "Allow", Action: [...ROLE_ACTIONS, "iam:PassRole"], Resource: withRootRoles },
    fixedNameRoleLookupStatement(scope),
    { Sid: "IamInstanceProfiles", Effect: "Allow", Action: [...INSTANCE_PROFILE_ACTIONS], Resource: environmentInstanceProfiles(scope) },
    { Sid: "IamManagedPolicies", Effect: "Allow", Action: [...MANAGED_POLICY_ACTIONS], Resource: agentxManagedPolicies(scope) },
    {
      // Only actions that carry the iam:PermissionsBoundary key: CreateRole and
      // PutRolePermissionsBoundary as the boundary being set, the role policy actions as the
      // role's current boundary. For any other action the key is absent, StringNotEquals
      // evaluates true, and the Deny would block it outright.
      Sid: "IamRequireBoundary",
      Effect: "Deny",
      Action: [
        "iam:CreateRole",
        "iam:PutRolePermissionsBoundary",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
      ],
      Resource: withRootRoles,
      Condition: { StringNotEquals: { "iam:PermissionsBoundary": boundary } },
    },
    { Sid: "IamKeepBoundary", Effect: "Deny", Action: ["iam:DeleteRolePermissionsBoundary"], Resource: withRootRoles },
    // The boundary in force (a company's own, or the default) is never edited, versioned, tagged or deleted by the deploy (ruling M2
    // review): a new default version of the boundary would lift the ceiling for every role.
    { Sid: "IamKeepBoundaryPolicy", Effect: "Deny", Action: ["iam:CreatePolicyVersion", "iam:DeletePolicyVersion", "iam:SetDefaultPolicyVersion", "iam:DeletePolicy", "iam:TagPolicy", "iam:UntagPolicy"], Resource: boundary },
    {
      Sid: "ServiceLinkedRoles",
      Effect: "Allow",
      Action: ["iam:CreateServiceLinkedRole"],
      Resource: `arn:${scope.partition}:iam::${scope.account}:role/aws-service-role/*`,
      Condition: { StringLike: { "iam:AWSServiceName": [...SERVICE_LINKED_ROLE_SERVICES] } },
    },
    cognitoEmailServiceLinkedRole(scope.partition, scope.account),
    ecrTemplateServiceLinkedRole(scope.partition, scope.account),
    // FR-047: the control-plane stack's monthly budget, and only that one, never budgets:* on *.
    { Sid: "Budget", Effect: "Allow", Action: [...BUDGET_ACTIONS], Resource: `arn:${scope.partition}:budgets::${scope.account}:budget/agentx-${scope.env}-monthly` },
    ...teamRecordDeployStatements(scope),
  ];
}

/**
 * The statements without their Sids, for the DEPLOYED boundary: Sids are optional, and an IAM managed policy is capped at 6,144 characters (non-whitespace) of which the Sids are several hundred.
 * Tests find statements by Sid in `defaultBoundaryStatements`, so the Sids stay there and only the deployed copy drops them.
 */
export function withoutSids<T extends { Sid?: string }>(statements: readonly T[]): Array<Omit<T, "Sid">> {
  return statements.map((statement) => {
    const rest: Partial<T> = { ...statement };
    delete rest.Sid;
    return rest as Omit<T, "Sid">;
  });
}

/** The exact ARNs of the three roles the default boundary's AssumeOrgRoles statement raises the ceiling for. */
function assumeOrgRolePrincipals(scope: Pick<PolicyScope, "env" | "partition" | "account">): string[] {
  const prefix = `arn:${scope.partition}:iam::${scope.account}:role${environmentRolePath(scope.env)}`;
  return [brokerRoleName(scope.env), modelProxyTaskRoleName(scope.env), modelAccessProbeRoleName(scope.env)].map((name) => `${prefix}${name}`);
}

/**
 * The default permission boundary: the most any AgentX role (the service and operator roles
 * included) can ever do, whatever its own policy says. It allows the services AgentX uses, role
 * management only on this environment's roles, and nothing for users, groups or managed policies.
 * The Deny statements hold even if a later change widens an Allow.
 */
export function defaultBoundaryStatements(scope: Pick<PolicyScope, "env" | "partition" | "region" | "account" | "cloudFormationRoleName" | "rovaraOrganizationId">): PolicyStatementJson[] {
  const { partition, account, rovaraOrganizationId } = scope;
  if (rovaraOrganizationId !== undefined && !ORGANIZATION_ID_PATTERN.test(rovaraOrganizationId)) {
    throw new Error(`the Rovara organization id must be an AWS Organizations id (o- and 10 to 32 lowercase letters or digits), got ${JSON.stringify(rovaraOrganizationId)}`);
  }
  const roles = environmentRoles(scope);
  const withRootRoles = [roles, ...rootPathRoles(scope)];
  return [
    // 2026-11-03 (boundary tightened for room, no new permission): the two unconditional "*" reads that were statements of their own (CallerIdentity, Quotas) sit here, with the same Effect and Resource.
    // sts:GetCallerIdentity is the operator's identity check. servicequotas:GetServiceQuota is the operator's EC2 quota read (prerequisites on a resume); named, not scoped further, since the scoped ARNs in
    // the operator's identity policy already limit it to two quotas.
    { Sid: "Services", Effect: "Allow", Action: [...BOUNDARY_SERVICES.map((s) => `${s}:*`), ...CLOUDFRONT_BOUNDARY_ACTIONS, ...BOUNDARY_NAMED_READS], Resource: "*" },
    { Sid: "EcsFailureEventsRule", Effect: "Allow", Action: ["events:*"], Resource: ecsFailureRuleArn(scope) },
    ...appsyncEvents(scope),
    // The broker and the outbox publisher publish change notices to the realtime events API's one namespace (Plan 5 Task 8): the boundary allows that action on that namespace only.
    { Sid: "AppSyncEventsPublish", Effect: "Allow", Action: ["appsync:EventPublish"], Resource: `arn:${scope.partition}:appsync:${scope.region}:${scope.account}:apis/*/channelNamespace/${REALTIME_NAMESPACE}` },
    // The sign-in function's notice of a newly linked sign-in method (Plan 2, Task 8) sends from a verified SES identity: ses:SendEmail
    // by name, on this account's identities only. The region is any, since it sends in the region of the sender's identity ARN. Named, not
    // ses:*, so a bounded role cannot reach SES's other actions.
    // The boundary is only a ceiling: the sign-in function's own role policy pins the exact identity ARN (developer-signin.ts), and the
    // effective permission is the intersection of the two. Do not narrow this to one identity here; the boundary cannot know the ARN.
    { Sid: "SesSendNotice", Effect: "Allow", Action: ["ses:SendEmail"], Resource: `arn:${partition}:ses:*:${account}:identity/*` },
    // The broker assumes the ConnectorSecretsRole, with an org session tag, and no other role (sts:* would let a bounded role
    // assume any same-account role that trusts the account, escaping the boundary).
    {
      Sid: "ConnectorSecretsRole",
      Effect: "Allow",
      Action: ["sts:AssumeRole", "sts:TagSession"],
      // Setup and test health SH22: the same two actions, for the saved-environment push, pull and manage roles (the broker assumes them with a one-repository session policy). One wildcard
      // ARN rather than three names, since the deployed boundary has a 6,144 character limit and little room; the broker's own policy names the three exactly, and the boundary is only a ceiling.
      Resource: [
        // Test services TS26: and the TestAccountSecretsRole, which shares the ConnectorSecretsRole's name as a prefix (one ARN with a trailing wildcard; the boundary has no room for another).
        `arn:${partition}:iam::${account}:role${environmentRolePath(scope.env)}${connectorSecretsRoleName(scope.env)}*`,
        `arn:${partition}:iam::${account}:role${environmentRolePath(scope.env)}${savedEnvRolePrefix(scope.env)}*`,
        // TR-SWITCH-B2: and the Team record's vector data role, which the broker assumes with a workspace's index name as the session tag (a fixed name, so this can name it; it was generated).
        `arn:${partition}:iam::${account}:role${environmentRolePath(scope.env)}${teamRecordVectorsRoleName(scope.env)}`,
      ],
    },
    // A bounded role may be granted `sts:AssumeRole` into a customer's role in ANOTHER account, with an external id that names a Rovara org (the broker's CloudWatch
    // connector, Plan 4 Task 16, and the model proxy's Bedrock sources, Plan 3): a boundary only caps, so without this the grants could never take effect.
    // Owner decision A narrows it twice. The ceiling is raised for the three roles that hold such a grant and no other principal (ArnLike on aws:PrincipalArn), so a
    // future broad sts:AssumeRole on some other role gains no cross-account reach. And the resource is never a role of this account, nor of any account of Rovara's own
    // AWS Organization when its id is configured (aws:ResourceOrgID; a customer account outside any organization has no such key, and a negated condition passes when
    // the key is missing). With no organization id configured, only this account is excluded: the fallback, as before. The external id condition is the grants' own.
    {
      Sid: "AssumeOrgRoles",
      Effect: "Allow",
      Action: ["sts:AssumeRole"],
      Resource: `arn:${partition}:iam::*:role/*`,
      Condition: {
        ArnLike: { "aws:PrincipalArn": assumeOrgRolePrincipals(scope) },
        StringNotEquals: { "aws:ResourceAccount": account, ...(rovaraOrganizationId === undefined ? {} : { "aws:ResourceOrgID": rovaraOrganizationId }) },
        StringLike: { "sts:ExternalId": "rovara-org_*" },
      },
    },
    // iam:PassRole joins the role actions (the operator passes the service role to CloudFormation; CloudFormation passes the environment's roles to Lambda, ECS, EC2 and the rest): the same actions on the same
    // two ARNs as before, in one statement instead of two. The service role (a root-path role) is passed by the separate PassServiceRole statement below.
    { Sid: "IamRoles", Effect: "Allow", Action: [...ROLE_ACTIONS, "iam:PassRole"], Resource: withRootRoles },
    // The service role carries this boundary, so the path-less lookups it is granted (see fixedNameRoleLookupStatement) are named here too.
    fixedNameRoleLookupStatement(scope, true),
    // 2026-11-03: `iam:*InstanceProfile` is exactly the seven INSTANCE_PROFILE_ACTIONS: against AWS's service authorization reference for IAM, no other action name ends in InstanceProfile (the list and tag
    // calls end in Profiles, ProfilesForRole and ProfileTags). tests/contract/access-policies.test.ts keeps that pinned.
    { Sid: "IamInstanceProfiles", Effect: "Allow", Action: [BOUNDARY_INSTANCE_PROFILE_ACTIONS], Resource: environmentInstanceProfiles(scope) },
    // The service role creates the broker's named managed policies (ruling M2); the boundary is a ceiling, so it names the same actions on the same ARNs.
    { Sid: "IamManagedPolicies", Effect: "Allow", Action: [...MANAGED_POLICY_ACTIONS], Resource: agentxManagedPolicies(scope) },
    // The operator passes the service role (root path) to CloudFormation. The environment's roles and the saved environment images' creation role are passed by IamRoles above.
    { Sid: "PassServiceRole", Effect: "Allow", Action: ["iam:PassRole"], Resource: `arn:${partition}:iam::${account}:role/${scope.cloudFormationRoleName}` },
    {
      Sid: "ServiceLinkedRoles",
      Effect: "Allow",
      Action: ["iam:CreateServiceLinkedRole"],
      Resource: `arn:${partition}:iam::${account}:role/aws-service-role/*`,
      Condition: { StringLike: { "iam:AWSServiceName": [...SERVICE_LINKED_ROLE_SERVICES] } },
    },
    cognitoEmailServiceLinkedRole(partition, account),
    ...sesChecks(scope),
    // Account and organization changes, and IAM users and groups: two Denies with the same Effect and Resource, one statement since 2026-11-03.
    { Sid: "DenyAccountUsersAndGroups", Effect: "Deny", Action: ["organizations:*", "account:*", "iam:*User*", "iam:*Group*"], Resource: "*" },
    {
      Sid: "DenyPolicyManagement",
      Effect: "Deny",
      // iam:SetDefaultPolicyVersion is matched by iam:*PolicyVersion*, so it is not listed twice (2026-11-03).
      Action: ["iam:CreatePolicy*", "iam:*PolicyVersion*", "iam:DeletePolicy"],
      // Everywhere except this environment's broker grant policies (ruling M2). NotResource, so a policy that is not named
      // (the default boundary and every other agentx-named policy included) stays denied; DenyBoundaryChanges below still covers the boundary.
      NotResource: agentxManagedPolicies(scope),
    },
    { Sid: "DenyBoundaryChanges", Effect: "Deny", Action: ["iam:*Policy*"], Resource: defaultBoundaryArn(scope) },
    // TR-SWITCH review F3: no bounded role may set a resource policy on, or a replication of, the Team record's stores (or any vector bucket or table bucket), whatever a later grant says: that is how a lake or its vectors
    // would be opened or copied to another account. Nothing in the record needs it (the deploy role withholds all three; the broker and the vector role never held them). tests/contract/team-record-iam-coverage.test.ts pins the match set.
    { Sid: "DenyRecordStoreSharing", Effect: "Deny", Action: [...TEAM_RECORD_BOUNDARY_DENIED_ACTIONS], Resource: "*" },
  ];
}

/** The inline policy of the role an operator assumes to run `agentx` against this environment. */
export function operatorRoleStatements(scope: PolicyScope): PolicyStatementJson[] {
  const { partition, region, account, env } = scope;
  // Exact stack names, never a wildcard prefix: agentx-<env>-* would also match another
  // environment's stacks (agentx-prod-* matches prod-eu) and the access stack itself.
  const stackArn = (part: (typeof STACK_PARTS)[number]) =>
    `arn:${partition}:cloudformation:${region}:${account}:stack/${environmentStackName(env, part)}/*`;
  // The operator may read the access stack but never change it: it holds the roles, so changing it
  // is the platform team's job.
  const deployedParts = STACK_PARTS.filter((part) => part !== "access");
  return [
    {
      Sid: "Stacks",
      Effect: "Allow",
      Action: [
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStackResources",
        "cloudformation:GetTemplate",
        "cloudformation:GetTemplateSummary",
        "cloudformation:ListStackResources",
      ],
      Resource: STACK_PARTS.map(stackArn),
    },
    {
      Sid: "ChangeSets",
      Effect: "Allow",
      Action: [
        "cloudformation:CreateChangeSet",
        "cloudformation:DescribeChangeSet",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:DeleteChangeSet",
        "cloudformation:ListChangeSets",
        // The templates engine turns termination protection on right after a new stack's first deploy.
        "cloudformation:UpdateTerminationProtection",
      ],
      Resource: deployedParts.map(stackArn),
    },
    // ListStacks and ValidateTemplate support no resource-level scoping; both are read-only.
    { Sid: "StackList", Effect: "Allow", Action: ["cloudformation:ListStacks"], Resource: "*" },
    { Sid: "Templates", Effect: "Allow", Action: ["cloudformation:ValidateTemplate"], Resource: "*" },
    {
      Sid: "PassServiceRole",
      Effect: "Allow",
      Action: ["iam:PassRole"],
      Resource: `arn:${partition}:iam::${account}:role/${scope.cloudFormationRoleName}`,
      Condition: { StringEquals: { "iam:PassedToService": "cloudformation.amazonaws.com" } },
    },
    {
      Sid: "Artifacts",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
      Resource: [scope.artifactBucketArn, `${scope.artifactBucketArn}/*`],
    },
    {
      Sid: "Settings",
      Effect: "Allow",
      Action: ["ssm:GetParameter", "ssm:PutParameter", "ssm:DeleteParameter", "ssm:GetParametersByPath"],
      Resource: [
        `arn:${partition}:ssm:${region}:${account}:parameter/agentx/${env}`,
        `arn:${partition}:ssm:${region}:${account}:parameter/agentx/${env}/*`,
      ],
    },
    {
      Sid: "Secrets",
      Effect: "Allow",
      Action: [
        "secretsmanager:CreateSecret",
        "secretsmanager:PutSecretValue",
        "secretsmanager:DescribeSecret",
        "secretsmanager:GetSecretValue",
        "secretsmanager:TagResource",
      ],
      Resource: `arn:${partition}:secretsmanager:${region}:${account}:secret:agentx/${env}/*`,
    },
    {
      Sid: "Images",
      Effect: "Allow",
      Action: ["ecr:DescribeRepositories", "ecr:DescribeImages"],
      Resource: `arn:${partition}:ecr:${region}:${account}:repository/${scope.pullThroughPrefix}/*`,
    },
    {
      Sid: "ModelChecks",
      Effect: "Allow",
      // The Converse API is authorized by bedrock:InvokeModel; there is no separate action.
      Action: ["bedrock:InvokeModel"],
      Resource: [
        `arn:${partition}:bedrock:*::foundation-model/*`,
        `arn:${partition}:bedrock:${region}:${account}:inference-profile/*`,
      ],
    },
    {
      // FR-018 step 7: the admin user. The identity stack's user pool carries agentx:env (15a's
      // Tags.of(app)); an exact tag value cannot match another environment. AdminListGroupsForUser
      // tells whether an existing user is already an administrator before init promotes it.
      Sid: "AdminUser",
      Effect: "Allow",
      Action: ["cognito-idp:AdminGetUser", "cognito-idp:AdminCreateUser", "cognito-idp:AdminAddUserToGroup", "cognito-idp:AdminListGroupsForUser"],
      Resource: `arn:${partition}:cognito-idp:${region}:${account}:userpool/*`,
      Condition: { StringEquals: { "aws:ResourceTag/agentx:env": env } },
    },
    {
      // FR-045: read the alert topic. No Publish: the test alarm goes through CloudWatch.
      Sid: "Alerts",
      Effect: "Allow",
      Action: ["sns:ListSubscriptionsByTopic"],
      Resource: `arn:${partition}:sns:${region}:${account}:agentx-${env}-alerts`,
    },
    {
      // FR-045: subscribe the alert address, but only email (the operator) or https (the alert
      // webhook): sqs, lambda and sms would let a compromised operator session re-route alerts
      // somewhere the platform team can't see. A separate statement because sns:Protocol is a
      // Subscribe-only context key; on Alerts above it would be absent and the condition would
      // deny those two read actions outright.
      Sid: "AlertsSubscribe",
      Effect: "Allow",
      Action: ["sns:Subscribe"],
      Resource: `arn:${partition}:sns:${region}:${account}:agentx-${env}-alerts`,
      Condition: { StringEquals: { "sns:Protocol": ["email", "https"] } },
    },
    {
      // FR-046: agentx alerts test flips this one alarm, named exactly.
      Sid: "TestAlarm",
      Effect: "Allow",
      Action: ["cloudwatch:SetAlarmState", "cloudwatch:DescribeAlarmHistory"],
      Resource: `arn:${partition}:cloudwatch:${region}:${account}:alarm:agentx-${env}-TestAlarm`,
    },
    // FR-047: the alerts step checks the budget CloudFormation made; it never changes it.
    { Sid: "Budget", Effect: "Allow", Action: ["budgets:ViewBudget"], Resource: `arn:${partition}:budgets::${account}:budget/agentx-${env}-monthly` },
    // prerequisites.ts checks two EC2 quotas on an operator resume: standard vCPUs (ServiceCode
    // "ec2", QuotaCode "L-1216C47A") and EC2-VPC Elastic IPs ("L-0263D0A3"). The servicequotas
    // "quota" resource type's ARN format is
    // arn:partition:servicequotas:region:account:serviceCode/quotaCode, so this scopes to exactly
    // those two quotas rather than every quota in the account.
    {
      Sid: "Quotas",
      Effect: "Allow",
      Action: ["servicequotas:GetServiceQuota"],
      Resource: [
        `arn:${partition}:servicequotas:${region}:${account}:ec2/L-1216C47A`,
        `arn:${partition}:servicequotas:${region}:${account}:ec2/L-0263D0A3`,
      ],
    },
    // The Elastic IP check counts the region's allocated addresses. ec2:DescribeAddresses has no
    // resource-level permissions, so "*" is its only Resource; it reads, and changes nothing.
    { Sid: "Addresses", Effect: "Allow", Action: ["ec2:DescribeAddresses"], Resource: "*", Condition: { StringEquals: { "aws:RequestedRegion": region } } },
    ...sesChecks(scope),
    { Sid: "Identity", Effect: "Allow", Action: ["sts:GetCallerIdentity"], Resource: "*" },
    {
      Sid: "Logs",
      Effect: "Allow",
      Action: ["logs:FilterLogEvents", "logs:StartQuery"],
      // CloudFormation names the stacks' log groups <stack name>-<logical id>-<suffix>; each stack's
      // exact name is the prefix, so no other environment's log groups match.
      Resource: deployedParts.map((part) => `arn:${partition}:logs:${region}:${account}:log-group:${environmentStackName(env, part)}-*`),
    },
    // GetQueryResults takes a query id and supports no resource type; DescribeLogGroups is a list
    // call that is authorized against every log group, so neither can be scoped by log group name.
    { Sid: "LogQueries", Effect: "Allow", Action: ["logs:GetQueryResults", "logs:DescribeLogGroups"], Resource: "*" },
  ];
}
