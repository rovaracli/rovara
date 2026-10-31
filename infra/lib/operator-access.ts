// Enterprise foundations, task N6: the standing Rovara operator role (owner decision 2026-10-31, evening; security pack appendix A).
//
// What this is: a role in the customer's account that Rovara's operators assume to RUN UPGRADES, and nothing else. It can start the deployment of
// templates that sit under `approved/` in a bucket the customer owns and fills only after approving a bundle's id, and only through the customer's own
// CloudFormation deploy role. Everything outside that is denied by explicit Deny statements that no Allow can override.
//
// What it is not: a promise that Rovara cannot read your content. Approved code runs under the application's own roles. The promise rests on three things
// together (docs/enterprise/operator-role.md): only an approved, signed bundle is deployed; the customer's deploy role does the work; and this role is narrow
// with the customer's switches above it.
//
// Enterprise only. Absent in Public: nothing here is created unless the install says `rovaraOperatorAccess=enabled|suspended` in its CDK context.
import { Aws, CfnCondition, CfnOutput, CfnParameter, Fn, RemovalPolicy, aws_events as events, aws_events_targets as targets, aws_iam as iam, aws_s3 as s3, aws_sns as sns } from "aws-cdk-lib";
import { Construct } from "constructs";
import {
  APPROVED_BUNDLE_PREFIX,
  BUNDLE_IMAGE_REPOSITORY_PREFIX,
  OPERATOR_ACCESS_CONTEXT_KEY,
  OPERATOR_ACCESS_STATES,
  OPERATOR_EXTERNAL_ID_CONTEXT_KEY,
  OPERATOR_LOG_GROUPS_CONTEXT_KEY,
  OPERATOR_PRINCIPAL_CONTEXT_KEY,
  environmentSettingsPrefix,
  rovaraOperatorRoleName,
  type OperatorAccessState,
} from "@agentx/contracts";
import type { AgentXNaming } from "./naming.js";

export interface OperatorAccessSettings {
  state: OperatorAccessState;
  /** The one role in Rovara's account that may assume the operator role. */
  principalArn: string;
  externalId: string;
  /** Log groups the operator may read: groups that hold no content. */
  logGroups: readonly string[];
}

const PRINCIPAL_PATTERN = /^arn:aws[a-z-]*:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/;
const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9+=,.@:/_-]{16,1224}$/;
const LOG_GROUP_PATTERN = /^[A-Za-z0-9_./#-]{1,512}$/;

/**
 * Reads the install's operator-access settings. Returns undefined when the install does not ask for the role. Anything wrong stops the synth: a role that is
 * enabled with a missing or malformed principal or external id never gets built, and nothing but Enterprise may ask for it.
 */
export function parseOperatorAccessContext(input: { edition: string | undefined; env: string | undefined; workerLogGroup: string; get(key: string): unknown }): OperatorAccessSettings | undefined {
  const raw = input.get(OPERATOR_ACCESS_CONTEXT_KEY);
  const others = [OPERATOR_PRINCIPAL_CONTEXT_KEY, OPERATOR_EXTERNAL_ID_CONTEXT_KEY, OPERATOR_LOG_GROUPS_CONTEXT_KEY];
  if (raw === undefined || raw === "" || raw === "disabled") {
    const stray = others.find((key) => input.get(key) !== undefined && input.get(key) !== "");
    if (stray !== undefined) throw new Error(`${stray} is set but ${OPERATOR_ACCESS_CONTEXT_KEY} is not enabled; set ${OPERATOR_ACCESS_CONTEXT_KEY}=enabled or remove it`);
    return undefined;
  }
  if (raw !== "enabled" && raw !== "suspended") throw new Error(`${OPERATOR_ACCESS_CONTEXT_KEY} must be disabled, enabled or suspended, got ${JSON.stringify(raw)}`);
  if (input.edition !== "enterprise") throw new Error(`${OPERATOR_ACCESS_CONTEXT_KEY} is an Enterprise setting; this install is not an Enterprise install`);
  if (input.env === undefined) throw new Error(`${OPERATOR_ACCESS_CONTEXT_KEY} needs a named environment`);
  const principal = input.get(OPERATOR_PRINCIPAL_CONTEXT_KEY);
  if (typeof principal !== "string" || !PRINCIPAL_PATTERN.test(principal)) {
    throw new Error(`${OPERATOR_PRINCIPAL_CONTEXT_KEY} must be the ARN of one IAM role (arn:aws:iam::<account>:role/<name>); the account root, a user or a wildcard is refused`);
  }
  const externalId = input.get(OPERATOR_EXTERNAL_ID_CONTEXT_KEY);
  if (typeof externalId !== "string" || !EXTERNAL_ID_PATTERN.test(externalId)) throw new Error(`${OPERATOR_EXTERNAL_ID_CONTEXT_KEY} must be an external id of 16 to 1224 characters that your team holds`);
  const groupsRaw = input.get(OPERATOR_LOG_GROUPS_CONTEXT_KEY);
  const groups = groupsRaw === undefined || groupsRaw === "" ? [] : typeof groupsRaw === "string" ? groupsRaw.split(",").map((name) => name.trim()) : (() => { throw new Error(`${OPERATOR_LOG_GROUPS_CONTEXT_KEY} must be a comma-separated list of log group names`); })();
  for (const name of groups) {
    if (!LOG_GROUP_PATTERN.test(name) || name.includes("*")) throw new Error(`${OPERATOR_LOG_GROUPS_CONTEXT_KEY} names exact log groups; ${JSON.stringify(name)} is not one`);
    if (name === input.workerLogGroup || name.startsWith(`${input.workerLogGroup}/`) || name.startsWith("/aws/bedrock")) {
      throw new Error(`${OPERATOR_LOG_GROUPS_CONTEXT_KEY} may not name ${name}: it holds task content`);
    }
  }
  return { state: raw, principalArn: principal, externalId, logGroups: groups };
}

type Statement = Record<string, unknown>;

/** Every region-specific form CloudFormation accepts for a template URL in a bucket. */
function approvedTemplateUrls(bucketName: string): string[] {
  return [
    `https://${bucketName}.s3.${Aws.REGION}.${Aws.URL_SUFFIX}/${APPROVED_BUNDLE_PREFIX}*`,
    `https://${bucketName}.s3.${Aws.URL_SUFFIX}/${APPROVED_BUNDLE_PREFIX}*`,
    `https://s3.${Aws.REGION}.${Aws.URL_SUFFIX}/${bucketName}/${APPROVED_BUNDLE_PREFIX}*`,
  ];
}

export interface OperatorAccessProps {
  naming: AgentXNaming;
  settings: OperatorAccessSettings;
}

/**
 * The operator role, the customer-owned approval bucket, the alert on every use, and the suspend switch. Built inside the access stack: the stack the
 * operator can never deploy (admin credentials only), so the operator cannot change its own role.
 */
export class OperatorAccess extends Construct {
  readonly approvedBundles: s3.Bucket;
  readonly role: iam.CfnRole;
  readonly alertTopic: sns.Topic;
  /** Added to the customer's CloudFormation deploy role: it reads the approved templates and packages, and nothing else is added. */
  readonly deployRoleReadPolicy: iam.CfnRole.PolicyProperty;

  constructor(scope: Construct, id: string, props: OperatorAccessProps) {
    super(scope, id);
    const { naming, settings } = props;
    const env = naming.env;
    if (env === undefined) throw new Error("the operator role exists only for named environments");
    const roleName = rovaraOperatorRoleName(env);
    const partition = Aws.PARTITION;
    const roleArn = `arn:${partition}:iam::${Aws.ACCOUNT_ID}:role/${roleName}`;
    const deployRoleArn = `arn:${partition}:iam::${Aws.ACCOUNT_ID}:role/${naming.cloudFormationRoleName}`;

    // The customer's switch. Changing it is a deploy of this stack with the customer's own admin credentials; the customer may also deny the role directly (docs).
    const state = new CfnParameter(this, "OperatorAccessState", {
      type: "String",
      allowedValues: [...OPERATOR_ACCESS_STATES],
      default: settings.state,
      description: "enabled lets the Rovara operator role deploy bundles you approved; suspended denies it everything, at once, including open sessions",
    });
    // The name the customer types in the console or on the command line.
    state.overrideLogicalId("OperatorAccessState");
    const isSuspended = new CfnCondition(this, "OperatorAccessSuspended", { expression: Fn.conditionEquals(state.valueAsString, "suspended") });

    // The approval record: a bucket only the customer writes to. A bundle is "approved" when the customer, having checked its id, places it under approved/<id>/.
    this.approvedBundles = new s3.Bucket(this, "ApprovedBundles", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const bucketArn = this.approvedBundles.bucketArn;
    const bucketName = this.approvedBundles.bucketName;
    const approvedObjects = `${bucketArn}/${APPROVED_BUNDLE_PREFIX}*`;
    this.approvedBundles.addToResourcePolicy(new iam.PolicyStatement({
      sid: "OnlyTheCustomerWritesApprovals",
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ["s3:PutObject*", "s3:DeleteObject*", "s3:PutBucket*", "s3:DeleteBucket*", "s3:PutLifecycleConfiguration", "s3:PutReplicationConfiguration", "s3:BypassGovernanceRetention"],
      resources: [bucketArn, `${bucketArn}/*`],
      conditions: { ArnEquals: { "aws:PrincipalArn": [roleArn, deployRoleArn] } },
    }));

    const stackArn = (name: string) => `arn:${partition}:cloudformation:${Aws.REGION}:${Aws.ACCOUNT_ID}:stack/${name}/*`;
    const environmentStacks = stackArn(`agentx-${env}-*`);
    const accessStack = stackArn(`agentx-${env}-access`);
    const parameterArn = (path: string) => `arn:${partition}:ssm:${Aws.REGION}:${Aws.ACCOUNT_ID}:parameter${path}`;
    const prefix = environmentSettingsPrefix(env);
    const bundleRepositories = `arn:${partition}:ecr:${Aws.REGION}:${Aws.ACCOUNT_ID}:repository/${BUNDLE_IMAGE_REPOSITORY_PREFIX}/${env}/*`;
    const templateUrls = approvedTemplateUrls(bucketName);
    const logGroupArns = settings.logGroups.map((name) => `arn:${partition}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:${name}:*`);

    const allow: Statement[] = [
      {
        Sid: "CreateChangeSetFromApprovedTemplates",
        Effect: "Allow",
        Action: ["cloudformation:CreateChangeSet"],
        Resource: environmentStacks,
        Condition: { StringEquals: { "cloudformation:RoleArn": deployRoleArn }, StringLike: { "cloudformation:TemplateUrl": templateUrls } },
      },
      { Sid: "RunAndInspectChangeSets", Effect: "Allow", Action: ["cloudformation:ExecuteChangeSet", "cloudformation:DescribeChangeSet", "cloudformation:DeleteChangeSet", "cloudformation:ListChangeSets"], Resource: environmentStacks },
      {
        Sid: "ReadStacks",
        Effect: "Allow",
        Action: ["cloudformation:DescribeStacks", "cloudformation:DescribeStackEvents", "cloudformation:DescribeStackResource", "cloudformation:DescribeStackResources", "cloudformation:ListStackResources", "cloudformation:GetTemplate", "cloudformation:GetTemplateSummary"],
        Resource: environmentStacks,
      },
      { Sid: "ListStacks", Effect: "Allow", Action: ["cloudformation:ListStacks"], Resource: "*" },
      { Sid: "PassTheDeployRoleOnly", Effect: "Allow", Action: ["iam:PassRole"], Resource: deployRoleArn, Condition: { StringEquals: { "iam:PassedToService": "cloudformation.amazonaws.com" } } },
      { Sid: "ReadApprovedBundles", Effect: "Allow", Action: ["s3:GetObject", "s3:GetObjectVersion"], Resource: approvedObjects },
      { Sid: "ListApprovedBundles", Effect: "Allow", Action: ["s3:ListBucket"], Resource: bucketArn, Condition: { StringLike: { "s3:prefix": `${APPROVED_BUNDLE_PREFIX}*` } } },
      { Sid: "ReadInstallRecords", Effect: "Allow", Action: ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"], Resource: parameterArn(`${prefix}*`) },
      {
        Sid: "WriteUpgradeRecords",
        Effect: "Allow",
        Action: ["ssm:PutParameter", "ssm:DeleteParameter"],
        Resource: [`${prefix}settings`, `${prefix}lock`, `${prefix}bundle`, `${prefix}restore-points/*`].map(parameterArn),
      },
      { Sid: "RegistryLogin", Effect: "Allow", Action: ["ecr:GetAuthorizationToken"], Resource: "*" },
      {
        Sid: "LoadBundleImages",
        Effect: "Allow",
        Action: ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:DescribeImages", "ecr:GetDownloadUrlForLayer", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage"],
        Resource: bundleRepositories,
      },
      { Sid: "CallerIdentity", Effect: "Allow", Action: ["sts:GetCallerIdentity"], Resource: "*" },
      { Sid: "ReadHealth", Effect: "Allow", Action: ["cloudwatch:DescribeAlarms", "cloudwatch:DescribeAlarmHistory", "cloudwatch:GetMetricData", "cloudwatch:GetMetricStatistics", "cloudwatch:ListMetrics"], Resource: "*" },
      ...(logGroupArns.length === 0 ? [] : [{ Sid: "ReadContentFreeLogs", Effect: "Allow", Action: ["logs:DescribeLogStreams", "logs:FilterLogEvents", "logs:GetLogEvents"], Resource: logGroupArns }]),
    ];

    const logReads = ["logs:GetLogEvents", "logs:FilterLogEvents", "logs:StartQuery", "logs:StartLiveTail", "logs:GetQueryResults", "logs:GetLogRecord", "logs:GetLogGroupFields", "logs:Unmask"];
    const deny: Statement[] = [
      // No IAM change of any kind, no passing of any role but the deploy role, no role chaining or federation: the role cannot make itself or anything else more powerful.
      { Sid: "DenyIamChanges", Effect: "Deny", Action: ["iam:Create*", "iam:Put*", "iam:Attach*", "iam:Update*", "iam:Delete*", "iam:Detach*", "iam:Add*", "iam:Remove*", "iam:Tag*", "iam:Untag*", "iam:Set*", "iam:Upload*", "iam:Enable*", "iam:Disable*", "iam:Reset*", "iam:Resync*"], Resource: "*" },
      { Sid: "DenyPassingOtherRoles", Effect: "Deny", Action: ["iam:PassRole"], NotResource: deployRoleArn },
      { Sid: "DenyChainingAndFederation", Effect: "Deny", Action: ["sts:AssumeRole", "sts:AssumeRoleWithSAML", "sts:AssumeRoleWithWebIdentity", "sts:GetFederationToken", "sts:GetSessionToken", "sts:TagSession"], Resource: "*" },
      // No shell on, or copy of, a worker.
      { Sid: "DenyWorkerAccess", Effect: "Deny", Action: ["ssm:StartSession", "ssm:ResumeSession", "ssm:SendCommand", "ssm:StartAutomationExecution", "ec2-instance-connect:*", "ec2:GetConsoleOutput", "ec2:GetConsoleScreenshot", "ec2:GetPasswordData", "ec2:CreateSnapshot", "ec2:CreateSnapshots", "ec2:CreateImage", "ec2:CopySnapshot", "ec2:ModifySnapshotAttribute", "ec2:ModifyImageAttribute", "ebs:*"], Resource: "*" },
      // Function code and configuration can hold content; the operator neither reads nor replaces them outside an approved deployment.
      { Sid: "DenyFunctionReadsAndEdits", Effect: "Deny", Action: ["lambda:GetFunction*", "lambda:GetLayerVersion*", "lambda:UpdateFunctionCode*", "lambda:UpdateFunctionConfiguration", "lambda:InvokeFunction*", "lambda:PublishLayerVersion", "lambda:PublishVersion", "lambda:AddPermission", "lambda:CreateFunction*"], Resource: "*" },
      { Sid: "DenySecretValues", Effect: "Deny", Action: ["secretsmanager:*"], Resource: "*" },
      { Sid: "DenyKeyUse", Effect: "Deny", Action: ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey*", "kms:GenerateMac", "kms:ReEncrypt*", "kms:Sign", "kms:CreateGrant", "kms:PutKeyPolicy", "kms:ScheduleKeyDeletion", "kms:DisableKey"], Resource: "*" },
      // Data-plane reads of the stores that hold code, tasks, plans, conversations and the Team record.
      { Sid: "DenyDatabaseReads", Effect: "Deny", Action: ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:PartiQL*", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:Export*", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem", "dynamodb:Restore*"], Resource: "*" },
      { Sid: "DenyStoreAndQueueReads", Effect: "Deny", Action: ["sqs:ReceiveMessage", "sqs:SendMessage*", "states:GetExecutionHistory", "states:DescribeExecution", "states:StartExecution", "states:StartSyncExecution", "states:SendTask*", "bedrock:Invoke*", "bedrock:Converse*", "athena:Start*", "athena:GetQueryResults", "s3vectors:Get*", "s3vectors:Query*", "s3vectors:List*", "s3vectors:Put*", "s3vectors:Delete*", "rds-data:*"], Resource: "*" },
      { Sid: "DenyReadsOutsideApprovedBundles", Effect: "Deny", Action: ["s3:GetObject*", "s3:ListBucketVersions"], NotResource: approvedObjects },
      { Sid: "DenyBucketListingOutsideApprovals", Effect: "Deny", Action: ["s3:ListBucket"], NotResource: bucketArn },
      { Sid: "DenyAllS3Writes", Effect: "Deny", Action: ["s3:PutObject*", "s3:DeleteObject*", "s3:PutBucket*", "s3:DeleteBucket*", "s3:PutLifecycleConfiguration", "s3:PutReplicationConfiguration", "s3:BypassGovernanceRetention"], Resource: "*" },
      // Log lines can carry task text: only the named, content-free groups.
      logGroupArns.length === 0
        ? { Sid: "DenyLogContent", Effect: "Deny", Action: logReads, Resource: "*" }
        : { Sid: "DenyLogContent", Effect: "Deny", Action: logReads, NotResource: logGroupArns },
      // Deployment goes through approved change sets only: no direct stack calls, never the access stack (which holds this role), never another deploy role, never another template.
      { Sid: "DenyDirectStackChanges", Effect: "Deny", Action: ["cloudformation:CreateStack", "cloudformation:UpdateStack", "cloudformation:DeleteStack", "cloudformation:SetStackPolicy", "cloudformation:UpdateTerminationProtection", "cloudformation:CancelUpdateStack", "cloudformation:ContinueUpdateRollback", "cloudformation:RollbackStack", "cloudformation:SignalResource", "cloudformation:CreateStackSet", "cloudformation:*StackInstances", "cloudformation:CreateGeneratedTemplate"], Resource: "*" },
      { Sid: "DenyAccessStackChanges", Effect: "Deny", Action: ["cloudformation:CreateChangeSet", "cloudformation:ExecuteChangeSet", "cloudformation:DeleteChangeSet"], Resource: accessStack },
      { Sid: "DenyOtherDeployRoles", Effect: "Deny", Action: ["cloudformation:CreateChangeSet"], Resource: "*", Condition: { StringNotEquals: { "cloudformation:RoleArn": deployRoleArn } } },
      { Sid: "DenyUnapprovedTemplates", Effect: "Deny", Action: ["cloudformation:CreateChangeSet"], Resource: "*", Condition: { StringNotLike: { "cloudformation:TemplateUrl": templateUrls } } },
    ];

    const suspend = Fn.conditionIf(isSuspended.logicalId, { Sid: "SuspendedByCustomer", Effect: "Deny", Action: "*", Resource: "*" }, Aws.NO_VALUE);
    this.role = new iam.CfnRole(this, "Role", {
      roleName,
      description: `Rovara operator role for ${env}: starts the deployment of bundles you approved, nothing else`,
      maxSessionDuration: 3600,
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { AWS: settings.principalArn },
          // sts:SetSourceIdentity is what makes the name of the person travel with every call (and through role chaining) into the customer's CloudTrail.
          Action: ["sts:AssumeRole", "sts:SetSourceIdentity"],
          Condition: {
            StringEquals: { "sts:ExternalId": settings.externalId },
            Bool: { "aws:MultiFactorAuthPresent": "true" },
            Null: { "sts:SourceIdentity": "false" },
            StringLike: { "sts:SourceIdentity": "?*" },
          },
        }],
      },
      policies: [{ policyName: "operate", policyDocument: { Version: "2012-10-17", Statement: [...allow, ...deny, suspend] } }],
    });

    this.deployRoleReadPolicy = {
      policyName: "read-approved-bundles",
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Action: ["s3:GetObject", "s3:GetObjectVersion"], Resource: approvedObjects },
          { Effect: "Allow", Action: ["s3:ListBucket"], Resource: bucketArn, Condition: { StringLike: { "s3:prefix": `${APPROVED_BUNDLE_PREFIX}*` } } },
        ],
      },
    };

    // Every assumption of the role goes to the customer's alert topic, with the name of the person (the event carries the source identity). The topic holds no content.
    this.alertTopic = new sns.Topic(this, "UseAlerts", { topicName: `agentx-${env}-rovara-operator-use`, displayName: "Rovara operator role was assumed" });
    new events.Rule(this, "AssumptionRule", {
      ruleName: `agentx-${env}-rovara-operator-assumed`,
      description: "Every assumption of the Rovara operator role",
      eventPattern: { source: ["aws.sts"], detailType: ["AWS API Call via CloudTrail"], detail: { eventSource: ["sts.amazonaws.com"], eventName: ["AssumeRole"], requestParameters: { roleArn: [roleArn] } } },
      targets: [new targets.SnsTopic(this.alertTopic)],
    });

    new CfnOutput(this, "RovaraOperatorRoleArn", { value: this.role.attrArn, description: "The Rovara operator role; suspend it with the OperatorAccessState parameter" });
    new CfnOutput(this, "ApprovedBundlesBucketName", { value: bucketName, description: "Place a bundle under approved/<bundle id>/ only after you approved its id" });
    new CfnOutput(this, "RovaraOperatorAlertTopicArn", { value: this.alertTopic.topicArn });
  }
}
