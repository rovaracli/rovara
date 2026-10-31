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
import { Aws, CfnCondition, CfnOutput, CfnParameter, Duration, Fn, RemovalPolicy, aws_events as events, aws_events_targets as targets, aws_iam as iam, aws_lambda as lambda, aws_lambda_nodejs as lambdaNodejs, aws_logs as logs, aws_s3 as s3, aws_sns as sns, aws_ssm as ssm } from "aws-cdk-lib";
import { resolve } from "node:path";
import { Construct } from "constructs";
import {
  APPROVED_BUNDLE_PREFIX,
  OPERATOR_ACCESS_CONTEXT_KEY,
  OPERATOR_ACCESS_STATES,
  OPERATOR_APPROVERS_CONTEXT_KEY,
  OPERATOR_SIGNING_KEYS_CONTEXT_KEY,
  OPERATOR_EXTERNAL_ID_CONTEXT_KEY,
  OPERATOR_LOG_GROUPS_CONTEXT_KEY,
  OPERATOR_PRINCIPAL_CONTEXT_KEY,
  APPROVAL_PREFIX,
  DEPLOYER_PARTS,
  DEPLOYING_PREFIX,
  bundleDeployerFunctionName,
  bundleDeployerRoleName,
  bundleTrustParameter,
  deployProgressParameter,
  environmentSettingsPrefix,
  environmentStackName,
  installedBundleParameter,
  parseBundlePublicKey,
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
  /** PEM public keys the deployer trusts to sign bundles (written to the install's trust parameter). Empty: every bundle is refused. */
  signingKeys: readonly string[];
  /** ARNs (wildcards allowed) of the principals that may place approvals; empty means the bucket bars only the roles this module creates. */
  approverArns: readonly string[];
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
  const others = [OPERATOR_PRINCIPAL_CONTEXT_KEY, OPERATOR_EXTERNAL_ID_CONTEXT_KEY, OPERATOR_LOG_GROUPS_CONTEXT_KEY, OPERATOR_SIGNING_KEYS_CONTEXT_KEY, OPERATOR_APPROVERS_CONTEXT_KEY];
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
  const keysRaw = input.get(OPERATOR_SIGNING_KEYS_CONTEXT_KEY);
  let signingKeys: string[] = [];
  if (keysRaw !== undefined && keysRaw !== "") {
    try {
      const parsed: unknown = typeof keysRaw === "string" ? JSON.parse(keysRaw) : keysRaw;
      if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) throw new Error("not a list of strings");
      signingKeys = parsed as string[];
      for (const pem of signingKeys) parseBundlePublicKey(pem);
    } catch {
      throw new Error(`${OPERATOR_SIGNING_KEYS_CONTEXT_KEY} must be a JSON array of PEM public keys (ECDSA P-256), nothing else`);
    }
  }
  const approversRaw = input.get(OPERATOR_APPROVERS_CONTEXT_KEY);
  const approverArns = approversRaw === undefined || approversRaw === "" ? [] : typeof approversRaw === "string" ? approversRaw.split(",").map((arn) => arn.trim()) : (() => { throw new Error(`${OPERATOR_APPROVERS_CONTEXT_KEY} must be a comma-separated list of ARNs`); })();
  for (const arn of approverArns) if (!/^arn:aws[a-z-]*:iam::\d{12}:(role|user)\/[A-Za-z0-9+=,.@_/*-]{1,512}$/.test(arn) || arn.endsWith(":role/*") || arn.endsWith(":user/*")) throw new Error(`${OPERATOR_APPROVERS_CONTEXT_KEY} names roles or users; ${JSON.stringify(arn)} is not specific enough`);
  return { state: raw, principalArn: principal, externalId, logGroups: groups, signingKeys, approverArns };
}

type Statement = Record<string, unknown>;

export interface OperatorAccessProps {
  naming: AgentXNaming;
  settings: OperatorAccessSettings;
}

/**
 * The operator role, the customer-owned bundle deployer, the approval bucket, the alert on every use, and the suspend switch. Built inside the access stack:
 * the stack neither the operator nor the deployer can deploy (administrator credentials only), so neither can change its own role.
 *
 * What the operator holds is one thing: permission to invoke the deployer, with a bundle id. The deployer (customer account, customer logs, code in this
 * repository) reads the customer's approval, re-verifies the signed bundle, and deploys a FIXED list of stacks with parameters that are either kept as they
 * are or pinned in the approval. The operator calls no CloudFormation, S3, SSM or ECR write itself.
 */
export class OperatorAccess extends Construct {
  readonly approvedBundles: s3.Bucket;
  readonly role: iam.CfnRole;
  readonly deployer: lambdaNodejs.NodejsFunction;
  readonly alertTopic: sns.Topic;
  /** Added to the customer's CloudFormation deploy role: it reads the approved packages (Lambda code), and nothing else is added. */
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
    const deployerRoleArn = `arn:${partition}:iam::${Aws.ACCOUNT_ID}:role/${bundleDeployerRoleName(env)}`;

    // The customer's switch. Changing it is a deploy of this stack with the customer's own admin credentials; the customer may also deny the role directly (docs).
    const state = new CfnParameter(this, "OperatorAccessState", {
      type: "String",
      allowedValues: [...OPERATOR_ACCESS_STATES],
      default: settings.state,
      description: "enabled lets the Rovara operator role start the deployer for bundles you approved; suspended denies it everything, at once, including open sessions",
    });
    // The name the customer types in the console or on the command line.
    state.overrideLogicalId("OperatorAccessState");
    const isSuspended = new CfnCondition(this, "OperatorAccessSuspended", { expression: Fn.conditionEquals(state.valueAsString, "suspended") });

    // The approval record: a bucket only the customer writes to. A bundle is "approved" when the customer, having checked its id, places its files under approved/<id>/
    // and writes approvals/<id>.json (which pins the object versions and the parameters). Deleting that record withdraws the approval.
    this.approvedBundles = new s3.Bucket(this, "ApprovedBundles", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      // The deployer's verified copies are short-lived. Approved files keep their versions, because the approval pins them.
      lifecycleRules: [{ id: "ExpireDeployerCopies", prefix: DEPLOYING_PREFIX, expiration: Duration.days(14), noncurrentVersionExpiration: Duration.days(1) }],
    });
    const bucketArn = this.approvedBundles.bucketArn;
    const bucketName = this.approvedBundles.bucketName;
    const writes = ["s3:PutObject*", "s3:DeleteObject*", "s3:PutBucket*", "s3:DeleteBucket*", "s3:PutLifecycleConfiguration", "s3:PutReplicationConfiguration", "s3:BypassGovernanceRetention"];
    this.approvedBundles.addToResourcePolicy(new iam.PolicyStatement({
      sid: "OperatorAndDeployRoleNeverWrite",
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: writes,
      resources: [bucketArn, `${bucketArn}/*`],
      conditions: { ArnEquals: { "aws:PrincipalArn": [roleArn, deployRoleArn] } },
    }));
    // The deployer writes its verified copies and nothing else: it cannot place or change an approval.
    this.approvedBundles.addToResourcePolicy(new iam.PolicyStatement({
      sid: "DeployerWritesOnlyItsCopies",
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: writes,
      notResources: [`${bucketArn}/${DEPLOYING_PREFIX}*`],
      conditions: { ArnEquals: { "aws:PrincipalArn": [deployerRoleArn] } },
    }));
    if (settings.approverArns.length > 0) {
      // Only the customer's named approvers place or withdraw approvals (every other principal of the account is barred, administrators included unless named).
      this.approvedBundles.addToResourcePolicy(new iam.PolicyStatement({
        sid: "OnlyNamedApproversApprove",
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["s3:PutObject*", "s3:DeleteObject*", "s3:PutBucket*", "s3:DeleteBucket*"],
        resources: [`${bucketArn}/${APPROVED_BUNDLE_PREFIX}*`, `${bucketArn}/${APPROVAL_PREFIX}*`],
        conditions: { ArnNotLike: { "aws:PrincipalArn": [...settings.approverArns] } },
      }));
    }

    const stackArn = (name: string) => `arn:${partition}:cloudformation:${Aws.REGION}:${Aws.ACCOUNT_ID}:stack/${name}/*`;
    // Exact names, never a wildcard: an environment called "prod" must not reach "prod-eu".
    const deployableStacks = DEPLOYER_PARTS.map((part) => stackArn(environmentStackName(env, part)));
    const allStacks = [...deployableStacks, stackArn(environmentStackName(env, "access"))];
    const parameterArn = (path: string) => `arn:${partition}:ssm:${Aws.REGION}:${Aws.ACCOUNT_ID}:parameter${path}`;
    const prefix = environmentSettingsPrefix(env);
    const approvedObjects = `${bucketArn}/${APPROVED_BUNDLE_PREFIX}*`;
    const approvalObjects = `${bucketArn}/${APPROVAL_PREFIX}*`;
    const deployingObjects = `${bucketArn}/${DEPLOYING_PREFIX}*`;

    // The trusted signing keys live here, written by this stack (administrators), read by the deployer. Never passed on a command line to the operator's path.
    new ssm.StringParameter(this, "BundleTrustedKeys", { parameterName: bundleTrustParameter(env), stringValue: JSON.stringify(settings.signingKeys), description: "PEM public keys that may sign the bundles the deployer accepts; empty refuses every bundle" });

    // ---- The deployer: customer account, customer role, customer logs.
    const deployerName = bundleDeployerFunctionName(env);
    const deployerLogs = new logs.LogGroup(this, "BundleDeployerLogs", { logGroupName: `/aws/lambda/${deployerName}`, retention: logs.RetentionDays.ONE_YEAR, removalPolicy: RemovalPolicy.RETAIN });
    const deployerRole = new iam.Role(this, "BundleDeployerRole", {
      roleName: bundleDeployerRoleName(env),
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: `Rovara bundle deployer for ${env}: deploys the stacks of a bundle you approved, nothing else`,
    });
    const deployerPolicy: Statement[] = [
      { Sid: "ReadApprovals", Effect: "Allow", Action: ["s3:GetObject", "s3:GetObjectVersion"], Resource: [approvedObjects, approvalObjects] },
      { Sid: "WriteVerifiedCopies", Effect: "Allow", Action: ["s3:PutObject", "s3:GetObject"], Resource: deployingObjects },
      { Sid: "ReadInstallRecords", Effect: "Allow", Action: ["ssm:GetParameter"], Resource: [`${prefix}settings`, `${prefix}bundle`, bundleTrustParameter(env), deployProgressParameter(env)].map(parameterArn) },
      { Sid: "WriteUpgradeRecords", Effect: "Allow", Action: ["ssm:PutParameter"], Resource: [`${prefix}settings`, installedBundleParameter(env), `${prefix}restore-points/*`, deployProgressParameter(env)].map(parameterArn) },
      { Sid: "CloseProgress", Effect: "Allow", Action: ["ssm:DeleteParameter"], Resource: parameterArn(deployProgressParameter(env)) },
      { Sid: "ReadStacks", Effect: "Allow", Action: ["cloudformation:DescribeStacks", "cloudformation:GetTemplate"], Resource: allStacks },
      { Sid: "CreateChangeSetsThroughTheDeployRole", Effect: "Allow", Action: ["cloudformation:CreateChangeSet"], Resource: deployableStacks, Condition: { StringEquals: { "cloudformation:RoleArn": deployRoleArn }, StringLike: { "cloudformation:TemplateUrl": [`https://${bucketName}.s3.${Aws.REGION}.${Aws.URL_SUFFIX}/${DEPLOYING_PREFIX}*`] } } },
      { Sid: "RunChangeSets", Effect: "Allow", Action: ["cloudformation:ExecuteChangeSet", "cloudformation:DescribeChangeSet", "cloudformation:DeleteChangeSet"], Resource: deployableStacks },
      { Sid: "PassTheDeployRoleOnly", Effect: "Allow", Action: ["iam:PassRole"], Resource: deployRoleArn, Condition: { StringEquals: { "iam:PassedToService": "cloudformation.amazonaws.com" } } },
      { Sid: "OwnLogs", Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: `${deployerLogs.logGroupArn}:*` },
    ];
    deployerRole.attachInlinePolicy(new iam.Policy(this, "BundleDeployerPolicy", { document: iam.PolicyDocument.fromJson({ Version: "2012-10-17", Statement: deployerPolicy }) }));
    this.deployer = new lambdaNodejs.NodejsFunction(this, "BundleDeployer", {
      functionName: deployerName,
      description: "Deploys the stacks of a Rovara bundle your team approved. The only input is a bundle id.",
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: resolve(process.cwd(), "packages/broker/src/bundle-deployer/handler.ts"),
      handler: "handler",
      role: deployerRole,
      timeout: Duration.minutes(15),
      memorySize: 2048,
      logGroup: deployerLogs,
      environment: { ROVARA_ENV: env, APPROVAL_BUCKET: bucketName, DEPLOY_ROLE_ARN: deployRoleArn },
      bundling: { externalModules: [], minify: true, sourceMap: true, target: "node22" },
    });
    const deployerArn = this.deployer.functionArn;

    // ---- The operator role: it can start the deployer and look at health. Nothing else.
    const allow: Statement[] = [
      { Sid: "StartTheDeployer", Effect: "Allow", Action: ["lambda:InvokeFunction"], Resource: deployerArn },
      { Sid: "ReadStacks", Effect: "Allow", Action: ["cloudformation:DescribeStacks", "cloudformation:DescribeStackEvents", "cloudformation:DescribeStackResources", "cloudformation:ListStackResources"], Resource: allStacks },
      { Sid: "ListStacks", Effect: "Allow", Action: ["cloudformation:ListStacks"], Resource: "*" },
      { Sid: "CallerIdentity", Effect: "Allow", Action: ["sts:GetCallerIdentity"], Resource: "*" },
      { Sid: "ReadHealth", Effect: "Allow", Action: ["cloudwatch:DescribeAlarms", "cloudwatch:DescribeAlarmHistory", "cloudwatch:GetMetricData", "cloudwatch:GetMetricStatistics", "cloudwatch:ListMetrics"], Resource: "*" },
    ];
    // The deployer's own log group holds bundle ids and fixed words only; the named groups are the customer's list.
    const readableLogGroups = [deployerLogs.logGroupArn, ...settings.logGroups.map((name) => `arn:${partition}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:${name}`)];
    const readableLogResources = readableLogGroups.flatMap((arn) => [arn, `${arn}:*`]);
    allow.push({ Sid: "ReadContentFreeLogs", Effect: "Allow", Action: ["logs:DescribeLogStreams", "logs:FilterLogEvents", "logs:GetLogEvents"], Resource: readableLogResources });

    const logReads = ["logs:GetLogEvents", "logs:FilterLogEvents", "logs:StartQuery", "logs:StartLiveTail", "logs:GetQueryResults", "logs:GetLogRecord", "logs:GetLogGroupFields", "logs:Unmask"];
    const deny: Statement[] = [
      // No IAM change of any kind, no passing of any role, no role chaining or federation: the role cannot make itself or anything else more powerful.
      { Sid: "DenyIamChanges", Effect: "Deny", Action: ["iam:Create*", "iam:Put*", "iam:Attach*", "iam:Update*", "iam:Delete*", "iam:Detach*", "iam:Add*", "iam:Remove*", "iam:Tag*", "iam:Untag*", "iam:Set*", "iam:Upload*", "iam:Enable*", "iam:Disable*", "iam:Reset*", "iam:Resync*", "iam:PassRole"], Resource: "*" },
      { Sid: "DenyChainingAndFederation", Effect: "Deny", Action: ["sts:AssumeRole", "sts:AssumeRoleWithSAML", "sts:AssumeRoleWithWebIdentity", "sts:GetFederationToken", "sts:GetSessionToken", "sts:TagSession"], Resource: "*" },
      // No shell on, or copy of, a worker.
      { Sid: "DenyWorkerAccess", Effect: "Deny", Action: ["ssm:StartSession", "ssm:ResumeSession", "ssm:SendCommand", "ssm:StartAutomationExecution", "ec2-instance-connect:*", "ec2:GetConsoleOutput", "ec2:GetConsoleScreenshot", "ec2:GetPasswordData", "ec2:CreateSnapshot", "ec2:CreateSnapshots", "ec2:CreateImage", "ec2:CopySnapshot", "ec2:ModifySnapshotAttribute", "ec2:ModifyImageAttribute", "ebs:*"], Resource: "*" },
      // The deployer is the only function it may invoke; no function's code or configuration is read or replaced.
      { Sid: "DenyFunctionReadsAndEdits", Effect: "Deny", Action: ["lambda:GetFunction*", "lambda:GetLayerVersion*", "lambda:UpdateFunction*", "lambda:PublishLayerVersion", "lambda:PublishVersion", "lambda:AddPermission", "lambda:CreateFunction*", "lambda:DeleteFunction*", "lambda:PutFunction*", "lambda:UpdateAlias", "lambda:CreateAlias"], Resource: "*" },
      { Sid: "DenyInvokingAnythingElse", Effect: "Deny", Action: ["lambda:InvokeFunction*", "lambda:InvokeAsync"], NotResource: [deployerArn, `${deployerArn}:*`] },
      { Sid: "DenySecretValues", Effect: "Deny", Action: ["secretsmanager:*"], Resource: "*" },
      { Sid: "DenyKeyUse", Effect: "Deny", Action: ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey*", "kms:GenerateMac", "kms:ReEncrypt*", "kms:Sign", "kms:DeriveSharedSecret", "kms:CreateGrant", "kms:PutKeyPolicy", "kms:ScheduleKeyDeletion", "kms:DisableKey"], Resource: "*" },
      // Data-plane reads of the stores that hold code, tasks, plans, conversations and the Team record.
      { Sid: "DenyDatabaseReads", Effect: "Deny", Action: ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:PartiQL*", "dynamodb:ExecuteStatement", "dynamodb:BatchExecuteStatement", "dynamodb:ExecuteTransaction", "dynamodb:TransactGetItems", "dynamodb:TransactWriteItems", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:Export*", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem", "dynamodb:Restore*"], Resource: "*" },
      { Sid: "DenyStoreAndQueueReads", Effect: "Deny", Action: ["sqs:ReceiveMessage", "sqs:SendMessage*", "states:GetExecutionHistory", "states:DescribeExecution", "states:StartExecution", "states:StartSyncExecution", "states:SendTask*", "bedrock:Invoke*", "bedrock:Converse*", "athena:Start*", "athena:GetQueryResults", "s3vectors:Get*", "s3vectors:Query*", "s3vectors:List*", "s3vectors:Put*", "s3vectors:Delete*", "rds-data:*"], Resource: "*" },
      // The operator needs no bucket, parameter or registry: the deployer reads the approvals and writes the records.
      { Sid: "DenyAllS3", Effect: "Deny", Action: ["s3:*"], Resource: "*" },
      { Sid: "DenyRecordWrites", Effect: "Deny", Action: ["ssm:PutParameter", "ssm:DeleteParameter", "ssm:DeleteParameters", "ssm:LabelParameterVersion", "ssm:AddTagsToResource", "ssm:RemoveTagsFromResource"], Resource: "*" },
      { Sid: "DenyRegistryWrites", Effect: "Deny", Action: ["ecr:Put*", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:BatchDeleteImage", "ecr:DeleteRepository", "ecr:SetRepositoryPolicy", "ecr:CreateRepository"], Resource: "*" },
      // Log lines can carry task text: only the deployer's own group and the groups the customer named.
      { Sid: "DenyLogContent", Effect: "Deny", Action: logReads, NotResource: readableLogResources },
      // Deployment is the deployer's job alone: the operator makes no CloudFormation change of any kind.
      { Sid: "DenyAllStackChanges", Effect: "Deny", Action: ["cloudformation:CreateStack", "cloudformation:UpdateStack", "cloudformation:DeleteStack", "cloudformation:SetStackPolicy", "cloudformation:UpdateTerminationProtection", "cloudformation:CancelUpdateStack", "cloudformation:ContinueUpdateRollback", "cloudformation:RollbackStack", "cloudformation:SignalResource", "cloudformation:CreateStackSet", "cloudformation:*StackInstances", "cloudformation:CreateGeneratedTemplate", "cloudformation:CreateChangeSet", "cloudformation:ExecuteChangeSet", "cloudformation:DeleteChangeSet", "cloudformation:ExecuteStackRefactor", "cloudformation:CreateStackRefactor", "cloudformation:ImportStacksToStackSet"], Resource: "*" },
    ];

    const suspend = Fn.conditionIf(isSuspended.logicalId, { Sid: "SuspendedByCustomer", Effect: "Deny", Action: "*", Resource: "*" }, Aws.NO_VALUE);
    this.role = new iam.CfnRole(this, "Role", {
      roleName,
      description: `Rovara operator role for ${env}: starts the deployer for bundles you approved, nothing else`,
      maxSessionDuration: 3600,
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { AWS: settings.principalArn },
          // sts:SetSourceIdentity is what makes the name of the person travel with every call (and through role chaining) into the customer's CloudTrail.
          Action: ["sts:AssumeRole", "sts:SetSourceIdentity"],
          Condition: {
            StringEquals: { "sts:ExternalId": settings.externalId, "aws:RequestedRegion": Aws.REGION },
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
        Statement: [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: approvedObjects }],
      },
    };

    // Every assumption of the role goes to the customer's alert topic, with the name of the person (the event carries the source identity). The trust policy lets
    // the role be assumed through this region's endpoint only, so the assumption is always recorded where this rule listens. The topic holds no content.
    this.alertTopic = new sns.Topic(this, "UseAlerts", { topicName: `agentx-${env}-rovara-operator-use`, displayName: "Rovara operator role was assumed" });
    new events.Rule(this, "AssumptionRule", {
      ruleName: `agentx-${env}-rovara-operator-assumed`,
      description: "Every assumption of the Rovara operator role",
      eventPattern: { source: ["aws.sts"], detailType: ["AWS API Call via CloudTrail"], detail: { eventSource: ["sts.amazonaws.com"], eventName: ["AssumeRole"], requestParameters: { roleArn: [roleArn] } } },
      targets: [new targets.SnsTopic(this.alertTopic)],
    });
    // Every deployer start, from any caller, also reaches the topic: the deployer's invocations are API calls in the customer's CloudTrail.
    new events.Rule(this, "DeployerInvocationRule", {
      ruleName: `agentx-${env}-bundle-deployer-invoked`,
      description: "Every call to the bundle deployer",
      eventPattern: { source: ["aws.lambda"], detailType: ["AWS API Call via CloudTrail"], detail: { eventSource: ["lambda.amazonaws.com"], eventName: ["Invoke", "InvokeFunction", "InvokeAsync"], requestParameters: { functionName: [deployerName, this.deployer.functionArn] } } },
      targets: [new targets.SnsTopic(this.alertTopic)],
    });

    new CfnOutput(this, "RovaraOperatorRoleArn", { value: this.role.attrArn, description: "The Rovara operator role; suspend it with the OperatorAccessState parameter" });
    new CfnOutput(this, "ApprovedBundlesBucketName", { value: bucketName, description: "Place a bundle under approved/<bundle id>/ and write approvals/<bundle id>.json only after you approved its id" });
    new CfnOutput(this, "BundleDeployerFunctionName", { value: this.deployer.functionName });
    new CfnOutput(this, "RovaraOperatorAlertTopicArn", { value: this.alertTopic.topicArn });
  }
}
