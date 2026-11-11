// The Audit Ledger's storage (Task 5 of the Audit Ledger plan): the intake queue, three tables, the vault key with an
// explicit key policy, and the Object Lock bucket with its policy; and (Task 6) the broker's side of the outbox: its
// grants, the drain schedule and the two alarms on its log. The appender, the anchor and their grants arrive in later
// tasks, each pinned in its own test. Named environments only (the caller gates on naming.env); every stateful resource
// is kept when the stack goes. Task 7 adds the appender (the only writer of the chain) with its event source, grants and
// two alarms.
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  ArnFormat,
  Aws,
  CfnCondition,
  CfnParameter,
  Duration,
  Fn,
  Lazy,
  RemovalPolicy,
  Stack,
  aws_cloudwatch as cloudwatch,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_kms as kms,
  aws_lambda as lambda,
  aws_lambda_event_sources as lambdaEventSources,
  aws_lambda_nodejs as lambdaNodejs,
  aws_logs as logs,
  aws_s3 as s3,
  aws_scheduler as scheduler,
  aws_sqs as sqs,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { AUDIT_EXPORT_FILE_LIFECYCLE_DAYS, AUDIT_EXPORT_MAX_EVENT_AGE_SECONDS, AUDIT_EXPORT_RETRY_ATTEMPTS, AUDIT_EXPORT_TIMEOUT_SECONDS, AUDIT_GOVERNANCE_RETENTION_DAYS, AUDIT_INTAKE_MAX_RECEIVES, AUDIT_RETENTION_DAYS_DEFAULT, AUDIT_SEAL_INTERVAL_MINUTES, AUDIT_TSA_SPACING_MS, AUDIT_TSA_TIMEOUT_MS, auditIntakeQueueName } from "@agentx/cloud-contracts";
import { canonicalJson } from "@rovara-code/contracts";
import { BrokerNames } from "./broker-names.js";
import type { AgentXNaming } from "./naming.js";
import {
  auditLockSettings,
  auditReplicaSettings,
  auditTsaSettings,
  type AuditLockMode,
  type AuditLockSettings,
  type AuditReplicaSettings,
  type AuditTsaSettings,
} from "./audit-settings.js";
import { markCodeContractsPureCommand } from "./code-contracts-bundling.js";

/** S3 bucket names are at most 63 characters. */
const BUCKET_NAME_MAX = 63;
/** An AWS account id is 12 digits. */
const ACCOUNT_ID_LENGTH = 12;

/** Read by the retention aspect: a table with deletion protection cannot be deleted by a rolled-back first create. */
const KEEP_ON_ROLLBACK_METADATA = "agentx:retain-on-create-rollback";

export interface AuditBucketPolicyInputs {
  readonly partition: string;
  readonly account: string;
  readonly region: string;
  readonly resourcePrefix: string;
  readonly cloudFormationRoleName: string;
  readonly operatorRoleName: string;
  readonly mode: AuditLockMode;
  readonly retentionDays: number;
}

interface PolicyStatementJson {
  readonly Sid: string;
  readonly Effect: "Deny";
  readonly Principal: { readonly AWS: "*" };
  readonly Action: string | string[];
  readonly Resource: string | string[];
  readonly Condition?: Record<string, Record<string, string | string[]>>;
}

/** `agentx-<env>-audit-ledger-<account>-<region>`. */
export function auditLedgerBucketName(inputs: Pick<AuditBucketPolicyInputs, "resourcePrefix" | "account" | "region">): string {
  return `${inputs.resourcePrefix}-audit-ledger-${inputs.account}-${inputs.region}`;
}

/**
 * The ledger bucket's policy as plain statements, a function of strings only, so the same code builds the real policy
 * (with CloudFormation pseudo parameters) and the document the anchor's drift check hashes (with placeholders).
 * Every statement is a Deny. The operator role is excepted only in governance settings; the CloudFormation role only
 * from the lock-change denial, because it sets the lock configuration when the bucket is created.
 */
export function auditBucketPolicyStatements(inputs: AuditBucketPolicyInputs): PolicyStatementJson[] {
  const bucket = `arn:${inputs.partition}:s3:::${auditLedgerBucketName(inputs)}`;
  const objects = `${bucket}/*`;
  const roleArn = (name: string) => `arn:${inputs.partition}:iam::${inputs.account}:role/${name}`;
  const governance = inputs.mode === "GOVERNANCE";
  const operator = roleArn(inputs.operatorRoleName);
  const cloudFormation = roleArn(inputs.cloudFormationRoleName);
  const anyone = { AWS: "*" } as const;
  return [
    {
      Sid: "DenyDeletes",
      Effect: "Deny",
      Principal: anyone,
      Action: ["s3:DeleteObject", "s3:DeleteObjectVersion"],
      Resource: objects,
      ...(governance ? { Condition: { ArnNotEquals: { "aws:PrincipalArn": operator } } } : {}),
    },
    {
      Sid: "DenyLockChanges",
      Effect: "Deny",
      Principal: anyone,
      Action: ["s3:PutBucketObjectLockConfiguration", "s3:PutObjectRetention", "s3:PutObjectLegalHold", "s3:BypassGovernanceRetention"],
      Resource: [bucket, objects],
      Condition: { ArnNotEquals: { "aws:PrincipalArn": governance ? [cloudFormation, operator] : cloudFormation } },
    },
    {
      // Every write is create-only: a second PutObject on a key that exists fails with 412.
      Sid: "RequireConditionalWrites",
      Effect: "Deny",
      Principal: anyone,
      Action: "s3:PutObject",
      Resource: objects,
      Condition: { Null: { "s3:if-none-match": "true" } },
    },
    {
      Sid: "DenyShortRetention",
      Effect: "Deny",
      Principal: anyone,
      Action: "s3:PutObject",
      Resource: objects,
      Condition: { NumericLessThan: { "s3:object-lock-remaining-retention-days": String(inputs.retentionDays) } },
    },
    // What enforceSSL adds to a bucket, written here so that it is part of the document the drift check hashes.
    {
      Sid: "AllowSSLRequestsOnly",
      Effect: "Deny",
      Principal: anyone,
      Action: "s3:*",
      Resource: [bucket, objects],
      Condition: { Bool: { "aws:SecureTransport": "false" } },
    },
  ];
}

/** The log events the outbox writes that need a person: an event that could not be recorded, or a pending item the drain cannot deliver. */
export const AUDIT_RECORD_FAILED_EVENTS = ["audit.record_failed", "audit.record_invalid"] as const;
/**
 * `audit.pending_stuck`: a pending item the drain has failed to deliver for 10 minutes. `audit.drain_failed`: the drain
 * could not even read the outbox, so nothing can be stuck-logged and undelivered items would otherwise reach their TTL unseen.
 */
export const AUDIT_PENDING_STUCK_EVENTS = ["audit.pending_stuck", "audit.drain_failed"] as const;

/**
 * The anchor's log events that mean an org cannot be sealed until a person looks: its records or sealed state do not fit
 * the locked seal, or a sealed key was tampered with (a delete marker, a second version, other bytes: `audit.version_drift`,
 * which the lock-drift alarm of Task 9 covers as well).
 */
export const AUDIT_CHAIN_MISMATCH_EVENTS = ["audit.chain_mismatch", "audit.version_drift"] as const;

/**
 * The anchor's log events that mean the bucket's Object Lock, versioning or policy is not what it should be, or a sealed key
 * was changed (Task 9: `audit.lock_config_mismatch` from the drift check and the object check, `audit.version_drift` from the
 * sweep and from the checks before a write; `audit.lock_sweep_failed` when the sweep itself could not run, which does not stop
 * the anchor but means the delete-marker and extra-version look was skipped).
 */
/** Task 15: the anchor's log events for a shred that did not finish, or a due item it cannot trust. */
export const AUDIT_SHRED_FAILED_EVENTS = ["audit.shred_failed", "audit.shred_item_invalid", "audit.shred_deferred"] as const;
export const AUDIT_LOCK_DRIFT_EVENTS = ["audit.lock_config_mismatch", "audit.version_drift", "audit.lock_sweep_failed"] as const;

/** The anchor's log event for a timestamp that was not obtained or not accepted (Task 10): the authority's label and the problem. */
export const AUDIT_TIMESTAMP_FAILED_EVENTS = ["audit.timestamp_failed"] as const;

/** A string that is a CDK token (a template value resolved at deploy time), not the text it will become. */
export type TemplateTokenString = string & { readonly __templateToken: true };

/** The two lock profiles an install chooses between with the `AuditLockProfile` stack parameter. */
export type AuditLockProfile = "production" | "trial";
export const AUDIT_LOCK_PROFILES: readonly AuditLockProfile[] = ["production", "trial"];

export interface AuditLockProfileSettings {
  readonly mode: AuditLockMode;
  readonly retentionDays: number;
}

/**
 * What each profile sets. `production` is compliance and `trial` is governance. The environment's own settings
 * (auditLockSettings: the name and the CDK context) fix the branch that matches them; the other branch takes the
 * profile's standard value (1,096 days compliance, 1 day governance). So a named environment built by CDK keeps its
 * behaviour under the parameter's default, and a published template (built for a placeholder name, which is a real
 * install's kind) offers production by default and trial on request.
 */
export function auditLockProfileSettings(lock: AuditLockSettings): { production: AuditLockProfileSettings; trial: AuditLockProfileSettings; default: AuditLockProfile } {
  return {
    production: { mode: "COMPLIANCE", retentionDays: lock.mode === "COMPLIANCE" ? lock.retentionDays : AUDIT_RETENTION_DAYS_DEFAULT },
    trial: { mode: "GOVERNANCE", retentionDays: lock.mode === "GOVERNANCE" ? lock.retentionDays : AUDIT_GOVERNANCE_RETENTION_DAYS },
    default: lock.mode === "COMPLIANCE" ? "production" : "trial",
  };
}

export interface AuditLedgerProps {
  readonly naming: AgentXNaming;
  /**
   * The broker function. Its role may read details back (Decrypt) under the encryption context, and nothing else on the
   * key. The outbox runs inside it (Task 6): the construct gives it the intake queue's URL and exactly the SQS and
   * DynamoDB actions the outbox performs, invokes it every minute to drain, and alarms on its log.
   */
  readonly broker: lambda.Function;
  /**
   * The developer sign-in function (Task 18), when this environment has one. It records a sign-in method linked or unlinked and an invite
   * accepted, each in the transaction that does it, so it gets the same three things the broker gets for the outbox and nothing else:
   * the intake queue's URL, `sqs:SendMessage` on that queue, and `PutItem` and `DeleteItem` on the State table under `AUDIT_PENDING#`.
   */
  readonly signInFunction?: lambda.Function;
  /** The State table, where the pending items live. */
  readonly stateTable: dynamodb.Table;
  /** Notifies the operator (the alerts topic) when an audit alarm fires. */
  readonly notifyOperator: cloudwatch.IAlarmAction;
  /**
   * The appender function's role (Task 7 builds the function on it): may generate data keys and decrypt under the
   * encryption context. It is an input because the key policy names it; its other grants are the construct's, pinned
   * in AuditAppenderPolicy and the event source's consume statement.
   */
  readonly appenderRole: iam.IRole;
  /** The region the environment installs in; it is part of the ledger bucket's name, which S3 caps at 63 characters. */
  readonly deploymentRegion?: string;
  /**
   * Whether the export and anchor functions reserve concurrency (default true). False sets no reservation, for an account whose
   * Lambda concurrency limit is Lambda's minimum, where any reservation fails the deploy; production keeps it on.
   */
  readonly reservedConcurrency?: boolean;
}

export class AuditLedger extends Construct {
  readonly lock: AuditLockSettings;
  readonly tsa: AuditTsaSettings;
  readonly replica: AuditReplicaSettings | undefined;
  readonly intakeQueue: sqs.Queue;
  readonly intakeDeadLetterQueue: sqs.Queue;
  readonly ledgerTable: dynamodb.Table;
  readonly sealsTable: dynamodb.Table;
  readonly keysTable: dynamodb.Table;
  readonly vaultKey: kms.Key;
  /** The appender (Task 7): the only function that writes the chain. */
  readonly appender: lambda.Function;
  /** The anchor (Task 8): seals each org's new records into the locked bucket every 15 minutes; the only writer of the seals table. */
  readonly anchor: lambda.Function;
  /** The export builder (Task 11): builds an org's export bundle in the background when the broker invokes it; its role holds the export grants. */
  readonly exportFunction: lambda.Function;
  readonly ledgerBucket: s3.Bucket;
  readonly exportsBucket: s3.Bucket;
  /** The settings of each lock profile, and the one the `AuditLockProfile` parameter defaults to. */
  readonly lockProfiles: { readonly production: AuditLockProfileSettings; readonly trial: AuditLockProfileSettings; readonly default: AuditLockProfile };
  /** The stack parameter that chooses the lock profile (`production` or `trial`). */
  readonly lockProfileParameter: CfnParameter;
  /** True when `AuditLockProfile` is `trial`. */
  readonly trialCondition: CfnCondition;
  /**
   * SHA-256 (hex) of the canonical JSON of the bucket policy document with `{{partition}}`, `{{account}}`, `{{region}}` and
   * `agentx-{{env}}-` in place of the deployment's values, for each lock profile: the policy differs between them (operator
   * exceptions, retention days), so there is one hash per profile. It does not depend on the environment's name.
   */
  readonly bucketPolicySha256ByProfile: Readonly<Record<AuditLockProfile, string>>;
  /**
   * The same hash as a template value that follows the chosen profile (`Fn::If` on `AuditLockProfile`): the anchor's
   * `AUDIT_BUCKET_POLICY_SHA256` environment variable (Task 9) takes this, so it always names the policy the stack deployed.
   * This is a CDK token string, NOT a hex digest: it resolves to the hash only at deploy time, so never compare it,
   * slice it or hash it in TypeScript. Read `bucketPolicySha256ByProfile` for the hex values.
   */
  readonly bucketPolicySha256: TemplateTokenString;

  constructor(scope: Construct, id: string, props: AuditLedgerProps) {
    super(scope, id);
    const { naming } = props;
    if (naming.env === undefined) throw new Error("audit ledger: the ledger exists for named environments only");
    const brokerRole = props.broker.role;
    if (brokerRole === undefined) throw new Error("audit ledger: the broker function needs a role");
    const env = naming.env;
    const stack = Stack.of(this);
    const context = (name: string): unknown => this.node.tryGetContext(name) as unknown;

    // The export function's role is made first because the vault key policy names it (as the appender's is).
    const exportRole = new iam.Role(this, "AuditExportRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "The Rovara audit ledger export builder: reads the ledger and writes export files",
    });

    this.lock = auditLockSettings(naming, { lockMode: context("agentxAuditLockMode"), retentionDays: context("agentxAuditRetentionDays") });
    this.tsa = auditTsaSettings({ tsa: context("agentxAuditTsa"), tsaUrls: context("agentxAuditTsaUrls"), tsaRootsParameter: context("agentxAuditTsaRootsParameter") });
    this.replica = auditReplicaSettings({ replicaBucketArn: context("agentxAuditReplicaBucketArn"), replicaLockConfirmed: context("agentxAuditReplicaLockConfirmed") });

    const region = props.deploymentRegion ?? "us-east-1";
    const longest = auditLedgerBucketName({ resourcePrefix: naming.resourcePrefix, account: "0".repeat(ACCOUNT_ID_LENGTH), region }).length;
    if (longest > BUCKET_NAME_MAX) {
      throw new Error(`audit ledger: the bucket name ${naming.resourcePrefix}-audit-ledger-<account>-${region} would be ${longest} characters; S3 allows ${BUCKET_NAME_MAX}. Use a shorter environment name.`);
    }

    // The intake queue. FIFO with the org id as message group: one appender at a time per org. 180 s of visibility is
    // six times the appender's 30 s timeout (Lambda's guidance for SQS sources).
    this.intakeDeadLetterQueue = new sqs.Queue(this, "AuditIntakeDeadLetterQueue", {
      queueName: `${naming.resourcePrefix}-audit-intake-dlq.fifo`,
      fifo: true,
      contentBasedDeduplication: false,
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.intakeQueue = new sqs.Queue(this, "AuditIntakeQueue", {
      // The module the broker derives the queue's URL from (derived-names.ts), so the name and the URL cannot drift.
      queueName: auditIntakeQueueName(env),
      fifo: true,
      contentBasedDeduplication: false,
      deduplicationScope: sqs.DeduplicationScope.MESSAGE_GROUP,
      fifoThroughputLimit: sqs.FifoThroughputLimit.PER_MESSAGE_GROUP_ID,
      visibilityTimeout: Duration.seconds(180),
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      deadLetterQueue: { queue: this.intakeDeadLetterQueue, maxReceiveCount: AUDIT_INTAKE_MAX_RECEIVES },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Three tables, all keyed pk/sk, on demand, with deletion protection. The keys table has no point-in-time
    // recovery on purpose (design decision 6): a deleted key must be gone at once.
    const table = (tableId: string, pointInTimeRecovery: boolean): dynamodb.Table => {
      const created = new dynamodb.Table(this, tableId, {
        partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
        sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        encryption: dynamodb.TableEncryption.AWS_MANAGED,
        deletionProtection: true,
        ...(pointInTimeRecovery ? { pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true } } : {}),
        removalPolicy: RemovalPolicy.RETAIN,
      });
      // A table with deletion protection cannot be deleted by a rolled-back first create, which would leave the stack
      // in ROLLBACK_FAILED; it keeps plain Retain (like the Cognito user pool in retention.ts).
      (created.node.defaultChild as dynamodb.CfnTable).addMetadata(KEEP_ON_ROLLBACK_METADATA, true);
      return created;
    };
    this.ledgerTable = table("AuditLedgerTable", true);
    this.sealsTable = table("AuditSealsTable", true);
    this.keysTable = table("AuditKeysTable", false);

    // The vault key. The key policy is explicit and is the only thing that grants use: the account root is an
    // administrator without Decrypt, Encrypt, GenerateDataKey or ReEncrypt, so an IAM policy cannot add use.
    const partition = Aws.PARTITION;
    const roleArn = (name: string) => `arn:${partition}:iam::${Aws.ACCOUNT_ID}:role/${name}`;
    const encryptionContext = {
      StringEquals: { "kms:EncryptionContext:rovara:purpose": "audit-details" },
      "ForAnyValue:StringEquals": { "kms:EncryptionContextKeys": ["rovara:org"] },
    };
    this.vaultKey = new kms.Key(this, "AuditVaultKey", {
      description: "Rovara audit ledger details, per org data keys",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            sid: "AdminWithoutUse",
            principals: [new iam.AccountRootPrincipal()],
            // kms:CreateAlias, not kms:Create*: the wildcard would include kms:CreateGrant.
            actions: [
              "kms:CreateAlias", "kms:Describe*", "kms:Enable*", "kms:List*", "kms:Put*", "kms:Update*", "kms:Revoke*", "kms:Get*",
              "kms:TagResource", "kms:UntagResource", "kms:CancelKeyDeletion",
            ],
            resources: ["*"],
          }),
          new iam.PolicyStatement({
            sid: "DenyDestroy",
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: ["kms:ScheduleKeyDeletion", "kms:DisableKey", "kms:PutKeyPolicy"],
            resources: ["*"],
            conditions: { ArnNotEquals: { "aws:PrincipalArn": roleArn(naming.cloudFormationRoleName) } },
          }),
          new iam.PolicyStatement({
            // No principal can grant itself use of the key (R1-4).
            sid: "DenyGrants",
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: ["kms:CreateGrant"],
            resources: ["*"],
          }),
          new iam.PolicyStatement({
            sid: "AppenderUse",
            principals: [new iam.ArnPrincipal(props.appenderRole.roleArn)],
            actions: ["kms:GenerateDataKey", "kms:Decrypt"],
            resources: ["*"],
            conditions: encryptionContext,
          }),
          new iam.PolicyStatement({
            sid: "BrokerUse",
            principals: [new iam.ArnPrincipal(brokerRole.roleArn)],
            actions: ["kms:Decrypt"],
            resources: ["*"],
            conditions: encryptionContext,
          }),
          new iam.PolicyStatement({
            // The export builder opens a person's details to put them in an export, under the same context as the broker's reads.
            sid: "ExportUse",
            principals: [new iam.ArnPrincipal(exportRole.roleArn)],
            actions: ["kms:Decrypt"],
            resources: ["*"],
            conditions: encryptionContext,
          }),
        ],
      }),
    });

    // The key policy lets nobody ScheduleKeyDeletion, so a rolled-back first create could not delete the key and would leave
    // the stack in ROLLBACK_FAILED. It keeps plain Retain (the ActionLogsKey precedent in slack-orchestrator.ts).
    (this.vaultKey.node.defaultChild as kms.CfnKey).addMetadata(KEEP_ON_ROLLBACK_METADATA, true);
    // There is no alias, on purpose (final review I1). Nothing reads one: the key is addressed by its ARN, never by an alias
    // (kms:Update* and kms:CreateAlias in AdminWithoutUse let an IAM administrator repoint an alias at a key they control).
    // And a fixed alias name that a rolled-back first create keeps (nobody the key policy allows can DeleteAlias) makes every
    // retry fail with AlreadyExistsException. The key's id and ARN are in the stack's resources.

    // The lock profile: one stack parameter chooses between the two sets of values. It sits at the stack's top level
    // so that its name is exactly AuditLockProfile, which the deploy CLI passes. Changing it only changes the default
    // retention for new objects (an update without interruption and without replacement), and the bucket policy.
    this.lockProfiles = auditLockProfileSettings(this.lock);
    this.lockProfileParameter = new CfnParameter(stack, "AuditLockProfile", {
      type: "String",
      default: this.lockProfiles.default,
      allowedValues: [...AUDIT_LOCK_PROFILES],
      description: "Lock profile of the audit ledger: production keeps records locked for 3 years and nobody can shorten that; trial keeps them for 1 day and an operator can remove them. An install can move from trial to production, never back.",
    });
    this.trialCondition = new CfnCondition(stack, "AuditLockIsTrial", { expression: Fn.conditionEquals(this.lockProfileParameter.valueAsString, "trial") });
    const trialOrProduction = <T>(trial: T, production: T): T => Fn.conditionIf(this.trialCondition.logicalId, trial, production) as unknown as T;

    // The ledger bucket. Object Lock needs versioning; the default retention stamps every object at creation.
    const policyInputs = (values: Pick<AuditBucketPolicyInputs, "partition" | "account" | "region">, profile: AuditLockProfileSettings): AuditBucketPolicyInputs => ({
      ...values,
      resourcePrefix: naming.resourcePrefix,
      cloudFormationRoleName: naming.cloudFormationRoleName,
      operatorRoleName: naming.operatorRoleName,
      mode: profile.mode,
      retentionDays: profile.retentionDays,
    });
    const real = (profile: AuditLockProfileSettings) => policyInputs({ partition: Aws.PARTITION, account: Aws.ACCOUNT_ID, region: Aws.REGION }, profile);
    this.ledgerBucket = new s3.Bucket(this, "AuditLedgerBucket", {
      bucketName: auditLedgerBucketName(real(this.lockProfiles.production)),
      objectLockEnabled: true,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // The default retention follows the profile. CloudFormation updates it in place: the property is "No interruption"
    // in the resource reference, and the bucket's logical id and name do not change. It applies to new objects only;
    // records written under the trial profile keep their one-day governance lock after a move to production. S3 itself
    // refuses to shorten or relax a compliance lock on an existing object version, so the deploy CLI's refusal of a move
    // from production back to trial states the intent and is not the only guard.
    // Raw CloudFormation property names: the value is a condition, which the typed property cannot express.
    const retentionOf = (profile: AuditLockProfileSettings) => ({ Mode: profile.mode, Days: profile.retentionDays });
    (this.ledgerBucket.node.defaultChild as s3.CfnBucket).objectLockConfiguration = {
      objectLockEnabled: "Enabled",
      rule: { defaultRetention: trialOrProduction<s3.CfnBucket.DefaultRetentionProperty>(retentionOf(this.lockProfiles.trial) as never, retentionOf(this.lockProfiles.production) as never) },
    };

    // The bucket policy: the statements that differ between the profiles are chosen by Fn::If on the statement, so each
    // profile's policy is exactly the one its own settings produce. Both are built by the same function as the documents the
    // anchor's drift check hashes.
    const documentOf = (values: Pick<AuditBucketPolicyInputs, "partition" | "account" | "region">, profile: AuditLockProfileSettings) =>
      new iam.PolicyDocument({ statements: auditBucketPolicyStatements(policyInputs(values, profile)).map((statement) => iam.PolicyStatement.fromJson(statement)) });
    const statementsOf = (profile: AuditLockProfileSettings): unknown[] => (stack.resolve(documentOf({ partition: Aws.PARTITION, account: Aws.ACCOUNT_ID, region: Aws.REGION }, profile).toJSON()) as { Statement: unknown[] }).Statement;
    const productionStatements = statementsOf(this.lockProfiles.production);
    const trialStatements = statementsOf(this.lockProfiles.trial);
    if (productionStatements.length !== trialStatements.length) throw new Error("audit ledger: the two lock profiles must have the same bucket policy statements");
    const profileStatements = productionStatements.map((statement, index) => (
      canonicalJson(statement) === canonicalJson(trialStatements[index]) ? statement : trialOrProduction<unknown>(trialStatements[index], statement)
    ));
    for (const statement of auditBucketPolicyStatements(real(this.lockProfiles.production))) this.ledgerBucket.addToResourcePolicy(iam.PolicyStatement.fromJson(statement));
    const bucketPolicy = this.ledgerBucket.policy!;
    // Statements added to the policy after this point (by a later task) are kept after the profile's own.
    (bucketPolicy.node.defaultChild as s3.CfnBucketPolicy).addPropertyOverride("PolicyDocument.Statement", Lazy.any({
      produce: () => {
        const resolved = (stack.resolve(bucketPolicy.document.toJSON()) as { Statement: unknown[] }).Statement;
        // The override takes the profile's own statements from the front and keeps the rest. That is only right while CDK
        // keeps the statements in the order they were added and does not merge or drop any; fail loudly at synth if not.
        if (!productionStatements.every((statement, index) => canonicalJson(resolved[index]) === canonicalJson(statement))) {
          throw new Error("audit ledger: CDK changed the order or the content of the bucket policy statements; the lock profile override depends on them");
        }
        return [...profileStatements, ...resolved.slice(profileStatements.length)];
      },
    }));

    // The same documents with placeholders where the deployment's values go; resolving them through CDK gives the
    // serialization CloudFormation receives, so the anchor can compare against what the bucket reports. The environment's
    // name is a placeholder too (`agentx-{{env}}-`): a published template is synthesized for a placeholder name and rendered
    // by text replacement, which cannot recompute a hash, so the hash must not depend on the name.
    const hashOf = (profile: AuditLockProfileSettings): string => createHash("sha256")
      .update(canonicalJson(stack.resolve(documentOf({ partition: "{{partition}}", account: "{{account}}", region: "{{region}}" }, profile).toJSON())).replaceAll(`agentx-${env}-`, "agentx-{{env}}-"))
      .digest("hex");
    this.bucketPolicySha256ByProfile = { production: hashOf(this.lockProfiles.production), trial: hashOf(this.lockProfiles.trial) };
    this.bucketPolicySha256 = Fn.conditionIf(this.trialCondition.logicalId, this.bucketPolicySha256ByProfile.trial, this.bucketPolicySha256ByProfile.production).toString() as TemplateTokenString;

    this.exportsBucket = new s3.Bucket(this, "AuditExportsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(AUDIT_EXPORT_FILE_LIFECYCLE_DAYS) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.exportFunction = this.addExport(props, exportRole);
    this.addBrokerOutbox(props, brokerRole);
    if (props.signInFunction !== undefined) this.addSignInOutbox(props, props.signInFunction);
    this.addBrokerReader(props, brokerRole);
    this.appender = this.addAppender(props);
    this.anchor = this.addAnchor(props);

    // The second copy, in a separate account: only with both context values (auditReplicaSettings throws on the ARN alone).
    if (this.replica !== undefined) {
      const destination = this.replica.bucketArn;
      const replicationRole = new iam.Role(this, "AuditReplicationRole", {
        assumedBy: new iam.ServicePrincipal("s3.amazonaws.com", { conditions: { StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID } } }),
        description: "Replicates the Rovara audit ledger bucket to its second copy",
      });
      replicationRole.addToPolicy(new iam.PolicyStatement({
        actions: ["s3:GetReplicationConfiguration", "s3:ListBucket"],
        resources: [this.ledgerBucket.bucketArn],
      }));
      replicationRole.addToPolicy(new iam.PolicyStatement({
        actions: ["s3:GetObjectVersionForReplication", "s3:GetObjectVersionAcl", "s3:GetObjectVersionTagging", "s3:GetObjectRetention", "s3:GetObjectLegalHold"],
        resources: [this.ledgerBucket.arnForObjects("*")],
      }));
      replicationRole.addToPolicy(new iam.PolicyStatement({
        actions: ["s3:ReplicateObject", "s3:ReplicateTags"],
        resources: [`${destination}/*`],
      }));
      (this.ledgerBucket.node.defaultChild as s3.CfnBucket).replicationConfiguration = {
        role: replicationRole.roleArn,
        rules: [{
          id: "AuditLedgerSecondCopy",
          status: "Enabled",
          priority: 1,
          filter: { prefix: "" },
          destination: { bucket: destination },
          // Deleting is denied on this bucket; a delete marker must never reach the second copy.
          deleteMarkerReplication: { status: "Disabled" },
        }],
      };
    }
  }

  /**
   * The sign-in function's side of the outbox (Task 18): its role is not the broker's, so it gets its own policy with the three things the
   * outbox code running in it performs. `sqs:SendMessage` on the intake queue (the flush); `dynamodb:PutItem` (the pending item inside the
   * action's transaction, which IAM authorizes as PutItem) and `dynamodb:DeleteItem` (the flush clears the item once the queue has it) on
   * the State table with `dynamodb:LeadingKeys` restricted to `AUDIT_PENDING#*`. No Query or UpdateItem: the drain runs in the broker.
   * Nothing on the dead-letter queue, the ledger, seals and keys tables, the buckets or the key.
   */
  private addSignInOutbox(props: AuditLedgerProps, signIn: lambda.Function): void {
    signIn.addEnvironment("AUDIT_INTAKE_QUEUE_URL", this.intakeQueue.queueUrl);
    new iam.Policy(this, "AuditSignInOutboxPolicy", {
      roles: [signIn.role!],
      statements: [
        new iam.PolicyStatement({
          sid: "SendAuditEvents",
          actions: ["sqs:SendMessage"],
          resources: [this.intakeQueue.queueArn],
        }),
        new iam.PolicyStatement({
          sid: "AuditPendingItems",
          actions: ["dynamodb:PutItem", "dynamodb:DeleteItem"],
          resources: [props.stateTable.tableArn],
          conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["AUDIT_PENDING#*"] } },
        }),
      ],
    });
    // The sign-in function logs `audit.record_invalid` when an event it built is dropped (the link or the join then commits with no event),
    // and nothing redelivers that one. Its log group feeds the same metric as the broker's, so the one alarm covers both emitters.
    this.countedLogEvents(props.naming, signIn.logGroup, "AuditSignInRecordFailed", "AuditRecordFailed", AUDIT_RECORD_FAILED_EVENTS);
  }

  /**
   * The broker's side of the outbox (Task 6). The outbox code runs inside the broker function, so every grant here goes
   * to the broker's role and to no other function:
   *  - `sqs:SendMessage` on the intake queue: the flush, the drain and the customer-read fallback call SendMessageBatch,
   *    which needs this one action. Nothing on the dead-letter queue, and no receive or delete.
   *  - `dynamodb:PutItem` (the staff-read put, and the pending item inside the action's transaction), `Query` (the drain),
   *    `UpdateItem` (the drain's attempt count and its once-only failure mark) and `DeleteItem` (the flush and the drain),
   *    on the State table with `dynamodb:LeadingKeys` restricted to `AUDIT_PENDING#*`. The pending code never reads a
   *    single item, so there is no `GetItem`. The ledger, seals and keys tables, the bucket and the key get nothing;
   *  - `dynamodb:PutItem` on the State table for `AUDIT_SHRED_DUE` alone (Task 15): the due item of a closed org's shred.
   * The broker already holds read and write on the State table (`grantReadWriteData`), so this statement narrows nothing
   * today; it states and pins what the outbox needs, and it is the grant that would remain if that broader one is
   * ever cut back. It is a separate policy so that it is easy to find and to take out of snapshots.
   */
  private addBrokerOutbox(props: AuditLedgerProps, brokerRole: iam.IRole): void {
    const { naming, broker } = props;
    // The queue's URL is not passed: its name is fixed (auditIntakeQueueName), so the broker builds the URL from AGENTX_ENV, the region and the account (DERIVED_BROKER_VARIABLES).
    new iam.Policy(this, "AuditBrokerOutboxPolicy", {
      roles: [brokerRole],
      statements: [
        new iam.PolicyStatement({
          sid: "SendAuditEvents",
          actions: ["sqs:SendMessage"],
          resources: [this.intakeQueue.queueArn],
        }),
        new iam.PolicyStatement({
          sid: "AuditPendingItems",
          actions: ["dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem", "dynamodb:DeleteItem"],
          resources: [props.stateTable.tableArn],
          conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["AUDIT_PENDING#*"] } },
        }),
        // Task 15: closing an org puts the shred's due item in the same transaction as the close (closeOrg, Task 18). Put only, and
        // only in this partition: the anchor reads and clears the due items, the broker never does.
        new iam.PolicyStatement({
          sid: "ScheduleShred",
          actions: ["dynamodb:PutItem"],
          resources: [props.stateTable.tableArn],
          conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["AUDIT_SHRED_DUE"] } },
        }),
      ],
    });

    // The drain: the broker, invoked every minute with { source: "agentx.audit-drain" }. A missed run is covered by the
    // next one (the drain is idempotent), so a failed invocation is not retried. The scheduler may assume the role only
    // for this account's schedules in the default group (confused-deputy guard, as the recovery schedules).
    const drainRole = new iam.Role(this, "AuditDrainSchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com", {
        conditions: {
          StringEquals: {
            "aws:SourceAccount": Aws.ACCOUNT_ID,
            "aws:SourceArn": `arn:${Aws.PARTITION}:scheduler:${Aws.REGION}:${Aws.ACCOUNT_ID}:schedule-group/default`,
          },
        },
      }),
      description: "Lets the EventBridge scheduler invoke the broker to drain the audit outbox",
      inlinePolicies: {
        InvokeBroker: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({ sid: "InvokeBroker", actions: ["lambda:InvokeFunction"], resources: [broker.functionArn] })],
        }),
      },
    });
    new scheduler.CfnSchedule(this, "AuditDrainSchedule", {
      description: "Sends the audit events the flush after a commit did not deliver",
      flexibleTimeWindow: { mode: "OFF" },
      scheduleExpression: "rate(1 minute)",
      state: "ENABLED",
      target: {
        arn: broker.functionArn,
        roleArn: drainRole.roleArn,
        input: JSON.stringify({ source: "agentx.audit-drain" }),
        retryPolicy: { maximumRetryAttempts: 0, maximumEventAgeInSeconds: 60 },
      },
    });

    // The two audit alarms, on the broker's log. Their names end in a suffix the health route lists
    // (HEALTH_ALARM_SUFFIXES), because the app refuses to synthesize an alarm the probe would not read.
    const counted = (id: string, metricName: string, events: readonly string[]): cloudwatch.Metric => this.countedLogEvents(naming, broker.logGroup, id, metricName, events);
    const alarm = (id: string, suffix: string, description: string, metric: cloudwatch.Metric) => { this.alarmOnAtLeastOne(naming, props.notifyOperator, id, suffix, description, metric); };
    alarm(
      "AuditRecordFailedAlarm",
      "AuditRecordFailed",
      "An audit event could not be recorded: it was invalid, or it was never delivered before its pending item was due to expire. The action it describes happened; its record is missing. Check the broker logs for audit.record_failed and audit.record_invalid.",
      counted("AuditRecordFailed", "AuditRecordFailed", AUDIT_RECORD_FAILED_EVENTS),
    );
    alarm(
      "AuditPendingStuckAlarm",
      "AuditPendingStuck",
      "An audit event has waited more than 10 minutes in the outbox, or the drain could not read the outbox at all: events are not being delivered. Check the intake queue, the State table and the broker logs for audit.pending_stuck and audit.drain_failed.",
      counted("AuditPendingStuck", "AuditPendingStuck", AUDIT_PENDING_STUCK_EVENTS),
    );
  }

  /**
   * The broker's side of reading the ledger and handing out exports (Task 11). It reads; it writes none of the ledger's tables or
   * its locked bucket, and it builds no export itself. Every grant goes to the broker's role in a policy of its own:
   *  - `dynamodb:GetItem` and `Query` on the ledger and seals tables, for any key (the code builds every key from the org
   *    it is asked about; the broker is not a writer there, so there is no leading-key restriction to pin);
   *  - `dynamodb:GetItem` on the keys table, to open a person's details (the KMS decrypt itself is allowed by the key policy
   *    alone, under the encryption context, so there is no KMS statement here);
   *  - `dynamodb:PutItem` on the keys table (Task 15): the tombstone that erases a person's details;
   *  - `s3:GetObject` on the exports bucket's objects: a presigned download is signed with this role, and the link can do no more
   *    than the role can (the export function writes the files);
   *  - `lambda:InvokeFunction` on the export function and nothing else: starting an export is an asynchronous invoke of it.
   * The policy is a separate resource so that its references to other resources are not cycles with the function's role.
   */
  private addBrokerReader(props: AuditLedgerProps, brokerRole: iam.IRole): void {
    const { broker } = props;
    // The ledger's names go in the broker's names (BrokerNames), not in variables of their own: the broker's environment is held to Lambda's
    // 4 KB, and seven variables of full names, a URL and an ARN came to 780 bytes of it. The key is named by its id (the broker builds its
    // ARN), never by its alias: kms:Update* and kms:CreateAlias let an administrator repoint an alias.
    const names = BrokerNames.of(broker);
    names.add("auditLedgerTable", this.ledgerTable.tableName);
    names.add("auditSealsTable", this.sealsTable.tableName);
    names.add("auditKeysTable", this.keysTable.tableName);
    names.add("auditExportsBucket", this.exportsBucket.bucketName);
    names.add("auditExportFunction", this.exportFunction.functionName);
    names.add("auditVaultKey", this.vaultKey.keyId);
    new iam.Policy(this, "AuditBrokerReadPolicy", {
      roles: [brokerRole],
      statements: [
        new iam.PolicyStatement({
          sid: "ReadLedgerAndSeals",
          actions: ["dynamodb:GetItem", "dynamodb:Query"],
          resources: [this.ledgerTable.tableArn, this.sealsTable.tableArn],
        }),
        new iam.PolicyStatement({
          sid: "ReadKeys",
          actions: ["dynamodb:GetItem"],
          resources: [this.keysTable.tableArn],
        }),
        // Task 15: erasing a person writes their tombstone over their key item (one PutItem, in a transaction with the audit event).
        // IAM cannot limit a PutItem to one sort key, so the grant is the whole table's PutItem and nothing else (no DeleteItem, no
        // UpdateItem): the code writes the tombstone only under `SUBJECT#<id>` and only where none exists, and a test pins that.
        new iam.PolicyStatement({
          sid: "EraseSubjects",
          actions: ["dynamodb:PutItem"],
          resources: [this.keysTable.tableArn],
        }),
        new iam.PolicyStatement({
          sid: "DownloadExports",
          actions: ["s3:GetObject"],
          resources: [this.exportsBucket.arnForObjects("*")],
        }),
        new iam.PolicyStatement({
          sid: "StartExports",
          actions: ["lambda:InvokeFunction"],
          resources: [this.exportFunction.functionArn],
        }),
      ],
    });
  }

  /**
   * The export builder (Task 11). The broker invokes it asynchronously with { source: "agentx.audit-export", orgId, exportId }; it
   * builds the bundle, checks it with the verifier, writes the file and marks the export ready in one transaction with its
   * audit.exported pending item. It has its own role (made in the constructor, because the vault key policy names it) with exactly:
   *  - the ledger and seals tables: GetItem and Query; the keys table: GetItem; the vault key through the key policy (ExportUse);
   *  - the ledger bucket's objects: GetObject, GetObjectVersion, GetObjectRetention (sealed objects are read by version id);
   *  - the exports bucket's objects: PutObject, GetObject, DeleteObject, and ListBucket on the bucket;
   *  - the State table, for the export's record and the pending audit item: GetItem and UpdateItem on `ORG#*#AUDIT_EXPORT#*` keys,
   *    PutItem and DeleteItem on `AUDIT_PENDING#*` keys (the transaction and the flush after it);
   *  - `sqs:SendMessage` on the intake queue (the flush), and its log group's write actions.
   * Fifteen minutes, 1,024 MB, and a reserved concurrency of 5, so a burst of exports cannot take the account's concurrency.
   */
  private addExport(props: AuditLedgerProps, role: iam.Role): lambda.Function {
    const logGroup = new logs.LogGroup(this, "AuditExportLogs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY });
    const fn = new lambdaNodejs.NodejsFunction(this, "AuditExport", {
      description: "Builds an organization's audit export, checks it with the verifier and stores the file",
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: resolve(process.cwd(), "packages/broker/src/audit/export-handler.ts"),
      handler: "handler",
      timeout: Duration.seconds(AUDIT_EXPORT_TIMEOUT_SECONDS),
      memorySize: 1024,
      ...(props.reservedConcurrency === false ? {} : { reservedConcurrentExecutions: 5 }),
      role,
      logGroup,
      environment: {
        STATE_TABLE_NAME: props.stateTable.tableName,
        AUDIT_LEDGER_TABLE_NAME: this.ledgerTable.tableName,
        AUDIT_SEALS_TABLE_NAME: this.sealsTable.tableName,
        AUDIT_KEYS_TABLE_NAME: this.keysTable.tableName,
        AUDIT_LEDGER_BUCKET_NAME: this.ledgerBucket.bucketName,
        AUDIT_EXPORTS_BUCKET_NAME: this.exportsBucket.bucketName,
        AUDIT_INTAKE_QUEUE_URL: this.intakeQueue.queueUrl,
        // The key's ARN, never the alias.
        AUDIT_VAULT_KEY_ARN: this.vaultKey.keyArn,
      },
      bundling: { externalModules: [], minify: true, sourceMap: true, target: "node22", commandHooks: { beforeBundling: (inputDir: string) => [markCodeContractsPureCommand(inputDir)], afterBundling: () => [], beforeInstall: () => [] } },
    });
    logGroup.grantWrite(role);
    // The platform's own limits on an export's start: one retry, and no attempt of an event older than 30 minutes. With the timeout,
    // they bound how long an export can be `running`; the worker refuses a late attempt, and the status view derives its own
    // "lost" point from the same constants (export.ts), so a failed export is final.
    fn.configureAsyncInvoke({ retryAttempts: AUDIT_EXPORT_RETRY_ATTEMPTS, maxEventAge: Duration.seconds(AUDIT_EXPORT_MAX_EVENT_AGE_SECONDS) });
    new iam.Policy(this, "AuditExportPolicy", {
      roles: [role],
      statements: [
        new iam.PolicyStatement({
          sid: "ReadLedgerAndSeals",
          actions: ["dynamodb:GetItem", "dynamodb:Query"],
          resources: [this.ledgerTable.tableArn, this.sealsTable.tableArn],
        }),
        new iam.PolicyStatement({
          sid: "ReadKeys",
          actions: ["dynamodb:GetItem"],
          resources: [this.keysTable.tableArn],
        }),
        new iam.PolicyStatement({
          sid: "ReadSealedObjects",
          actions: ["s3:GetObject", "s3:GetObjectVersion", "s3:GetObjectRetention"],
          resources: [this.ledgerBucket.arnForObjects("*")],
        }),
        new iam.PolicyStatement({
          sid: "ExportObjects",
          actions: ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
          resources: [this.exportsBucket.arnForObjects("*")],
        }),
        new iam.PolicyStatement({
          sid: "ListExports",
          actions: ["s3:ListBucket"],
          resources: [this.exportsBucket.bucketArn],
        }),
        new iam.PolicyStatement({
          sid: "ExportRecords",
          actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
          resources: [props.stateTable.tableArn],
          conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["ORG#*#AUDIT_EXPORT#*"] } },
        }),
        new iam.PolicyStatement({
          sid: "AuditPendingItems",
          actions: ["dynamodb:PutItem", "dynamodb:DeleteItem"],
          resources: [props.stateTable.tableArn],
          conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["AUDIT_PENDING#*"] } },
        }),
        new iam.PolicyStatement({
          sid: "SendAuditEvents",
          actions: ["sqs:SendMessage"],
          resources: [this.intakeQueue.queueArn],
        }),
      ],
    });
    return fn;
  }

  /** A metric that counts the log events whose `$.event` is one of `events`, in the group (one metric filter, `<id>Metric`). */
  private countedLogEvents(naming: AgentXNaming, logGroup: logs.ILogGroup, id: string, metricName: string, events: readonly string[]): cloudwatch.Metric {
    new logs.MetricFilter(this, `${id}Metric`, {
      logGroup,
      filterPattern: logs.FilterPattern.any(...events.map((event) => logs.FilterPattern.stringValue("$.event", "=", event))),
      metricNamespace: naming.metricsNamespace,
      metricName,
      metricValue: "1",
    });
    return new cloudwatch.Metric({ namespace: naming.metricsNamespace, metricName, statistic: "Sum", period: Duration.minutes(5) });
  }

  /** An alarm that fires on one or more of the metric in a 5-minute period, and notifies the operator. */
  private alarmOnAtLeastOne(naming: AgentXNaming, notifyOperator: cloudwatch.IAlarmAction, id: string, suffix: string, description: string, metric: cloudwatch.Metric): void {
    new cloudwatch.Alarm(this, id, {
      alarmName: naming.alarmName(suffix),
      alarmDescription: description,
      metric,
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(notifyOperator);
  }

  /**
   * The anchor (Task 8): every 15 minutes it seals each org's new records into create-only objects in the locked bucket and
   * chains the epoch to the one before it. It is the only writer of the seals table. Its role is made here (nothing else
   * names it) and holds exactly these statements, plus the log group's write actions:
   *  - the seals table: `GetItem`, `PutItem`, `UpdateItem` and `Query`, for the partitions it keeps (`EPOCH#`, `EPOCH_HEAD`,
   *    `SEALED#`, `SEALS#`, `BACKSTOP`, and since Task 9 `AUDIT_SWEEP`: the sweep's cursor). A transaction authorizes each
   *    item by its own action, so these four cover the finalize. No `DeleteItem` (it never deletes seal state), no
   *    `ConditionCheckItem`, no batch or scan action;
   *  - the lock ratchet (`AUDIT_LOCK`, Task 9) in a statement of its own: `GetItem` and `PutItem` only. No `UpdateItem`, no
   *    `DeleteItem`, no `Query`. IAM has no condition key for a condition expression, so that the put can only create the
   *    item is the code's rule (`attribute_not_exists`, pinned by a test); what IAM removes is every other way of changing or
   *    deleting it, and the code treats any existing item as the ratchet whatever it says;
   *  - the ledger table: `GetItem` and `Query` (the chain and the lists it reads), and `PutItem` and `DeleteItem` only for the
   *    dirty markers (`AUDIT_DIRTY`): the finalize deletes a marker, the hourly backstop puts one back. It cannot write a
   *    record, a head or a claim;
   *  - the ledger bucket: `PutObject` (create-only, by the bucket policy), `GetObject`, `GetObjectVersion` and
   *    `GetObjectRetention` on its objects, `ListBucketVersions` on the bucket (it lists a key's versions before it
   *    writes, and sweeps the sealed keys), and, on the bucket, the three reads of its own configuration that the drift check
   *    makes each run: `GetBucketObjectLockConfiguration`, `GetBucketVersioning` and `GetBucketPolicy`. Never a delete, `PutObjectRetention`, `PutObjectLegalHold`, `BypassGovernanceRetention`, a bucket-level write
   *    or anything of KMS (the bucket uses S3-managed encryption);
   *  - Task 15, the shred sweep it makes on every run: the keys table's `Query`, `PutItem` (the SHREDDED marker) and `DeleteItem`
   *    (it empties one company's partition); the State table's `Query` and `DeleteItem` for `AUDIT_SHRED_DUE` alone (the due
   *    items); and, on the exports bucket, `ListBucket` and `DeleteObject` (the company's folder). No `GetItem` or `UpdateItem` on the
   *    keys table, no write to the State table, and no read or write of an export file;
   *  - Task 10, on a `custom` install only: `ssm:GetParameter` on the one parameter that holds the timestamp authorities' roots.
   *    The function is outside any VPC, like the broker, so a public authority is reached over the internet with no NAT or
   *    endpoint of ours.
   * Reserved concurrency 1: two runs never overlap. The conditional writes in the code make an overlap harmless as well. Lambda's
   * own two retries of a failed asynchronous run stay at their defaults: a run is idempotent, so a retry only resumes.
   */
  private addAnchor(props: AuditLedgerProps): lambda.Function {
    const { naming } = props;
    const env = naming.env;
    if (env === undefined) throw new Error("audit ledger: the ledger exists for named environments only");
    const role = new iam.Role(this, "AuditAnchorRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "The Rovara audit ledger anchor: seals each org's records into the locked bucket and is the only writer of the seals table",
    });
    const logGroup = new logs.LogGroup(this, "AuditAnchorLogs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY });
    const anchor = new lambdaNodejs.NodejsFunction(this, "AuditAnchor", {
      description: "Seals each org's new audit records into create-only locked objects, one epoch every 15 minutes",
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: resolve(process.cwd(), "packages/broker/src/audit/anchor-handler.ts"),
      handler: "handler",
      timeout: Duration.seconds(300),
      memorySize: 512,
      ...(props.reservedConcurrency === false ? {} : { reservedConcurrentExecutions: 1 }),
      role,
      logGroup,
      environment: {
        AUDIT_LEDGER_TABLE_NAME: this.ledgerTable.tableName,
        AUDIT_SEALS_TABLE_NAME: this.sealsTable.tableName,
        AUDIT_LEDGER_BUCKET_NAME: this.ledgerBucket.bucketName,
        // Task 15: what the shred sweep works on (the keys table, the State table's due items, the exports bucket).
        AUDIT_KEYS_TABLE_NAME: this.keysTable.tableName,
        STATE_TABLE_NAME: props.stateTable.tableName,
        AUDIT_EXPORTS_BUCKET_NAME: this.exportsBucket.bucketName,
        // Task 9. The floor is in code (lockFloor): from the name, this profile and the ratchet. The mode and days are what the
        // stack deployed, which the drift check compares the bucket with; the hash is the synthesized policy's, per profile.
        AUDIT_ENV_NAME: env,
        AUDIT_LOCK_PROFILE: this.lockProfileParameter.valueAsString,
        AUDIT_LOCK_MODE: Fn.conditionIf(this.trialCondition.logicalId, this.lockProfiles.trial.mode, this.lockProfiles.production.mode).toString(),
        AUDIT_RETENTION_DAYS: Fn.conditionIf(this.trialCondition.logicalId, String(this.lockProfiles.trial.retentionDays), String(this.lockProfiles.production.retentionDays)).toString(),
        AUDIT_BUCKET_POLICY_SHA256: this.bucketPolicySha256,
        // What the bucket policy is normalized with before it is hashed: this deployment's own partition, account and region.
        AUDIT_PARTITION: Aws.PARTITION,
        AUDIT_ACCOUNT_ID: Aws.ACCOUNT_ID,
        // Task 10: which timestamp authorities, how long to wait for one and how far apart to ask it. `custom` adds the URLs and
        // the one SSM parameter that holds their roots (read at cold start); `public` and `off` name neither.
        AUDIT_TSA_KIND: this.tsa.kind,
        AUDIT_TSA_TIMEOUT_MS: String(AUDIT_TSA_TIMEOUT_MS),
        AUDIT_TSA_SPACING_MS: String(AUDIT_TSA_SPACING_MS),
        ...(this.tsa.kind === "custom" ? { AUDIT_TSA_URLS: this.tsa.urls.join(","), AUDIT_TSA_ROOTS_PARAMETER: this.tsa.rootsParameter } : {}),
      },
      bundling: { externalModules: [], minify: true, sourceMap: true, target: "node22", commandHooks: { beforeBundling: (inputDir: string) => [markCodeContractsPureCommand(inputDir)], afterBundling: () => [], beforeInstall: () => [] } },
    });
    // A function on a role of our own gets no log permission from CDK.
    logGroup.grantWrite(role);
    new iam.Policy(this, "AuditAnchorPolicy", {
      roles: [role],
      statements: [
        new iam.PolicyStatement({
          sid: "SealsTable",
          actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"],
          resources: [this.sealsTable.tableArn],
          conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["EPOCH#*", "EPOCH_HEAD", "SEALED#*", "SEALS#*", "BACKSTOP", "AUDIT_SWEEP"] } },
        }),
        new iam.PolicyStatement({
          sid: "LockRatchet",
          actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
          resources: [this.sealsTable.tableArn],
          conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["AUDIT_LOCK"] } },
        }),
        new iam.PolicyStatement({
          sid: "LedgerRead",
          actions: ["dynamodb:GetItem", "dynamodb:Query"],
          resources: [this.ledgerTable.tableArn],
        }),
        new iam.PolicyStatement({
          sid: "LedgerDirtyMarkers",
          actions: ["dynamodb:PutItem", "dynamodb:DeleteItem"],
          resources: [this.ledgerTable.tableArn],
          conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["AUDIT_DIRTY"] } },
        }),
        new iam.PolicyStatement({
          sid: "LedgerBucketObjects",
          actions: ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion", "s3:GetObjectRetention"],
          resources: [this.ledgerBucket.arnForObjects("*")],
        }),
        new iam.PolicyStatement({
          sid: "LedgerBucketVersions",
          actions: ["s3:ListBucketVersions"],
          resources: [this.ledgerBucket.bucketArn],
        }),
        // Task 9: the three reads of the bucket's own configuration that the drift check makes each run.
        new iam.PolicyStatement({
          sid: "LedgerBucketConfiguration",
          actions: ["s3:GetBucketObjectLockConfiguration", "s3:GetBucketVersioning", "s3:GetBucketPolicy"],
          resources: [this.ledgerBucket.bucketArn],
        }),
        // Task 15, the shred sweep (run every time the anchor runs): a closed company's keys partition is emptied (Query, then DeleteItem
        // for each item) after the SHREDDED marker is written (PutItem); the due items it reads and clears are the State table's
        // AUDIT_SHRED_DUE partition alone; and the company's folder of export files is listed and deleted. No GetItem or UpdateItem on the
        // keys table, no Put in the State table, and no read or write of an export file.
        new iam.PolicyStatement({
          sid: "ShredKeys",
          actions: ["dynamodb:Query", "dynamodb:PutItem", "dynamodb:DeleteItem"],
          resources: [this.keysTable.tableArn],
        }),
        new iam.PolicyStatement({
          sid: "ShredDueItems",
          actions: ["dynamodb:Query", "dynamodb:DeleteItem"],
          resources: [props.stateTable.tableArn],
          conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["AUDIT_SHRED_DUE"] } },
        }),
        new iam.PolicyStatement({
          sid: "ShredExportObjects",
          actions: ["s3:DeleteObject"],
          resources: [this.exportsBucket.arnForObjects("*")],
        }),
        new iam.PolicyStatement({
          sid: "ShredListExports",
          actions: ["s3:ListBucket"],
          resources: [this.exportsBucket.bucketArn],
        }),
        // Task 10, custom authorities only: the one parameter that holds their root certificates, read at cold start. A public or
        // `off` install has no SSM grant at all.
        ...(this.tsa.kind === "custom"
          ? [new iam.PolicyStatement({
            sid: "TimestampRoots",
            actions: ["ssm:GetParameter"],
            resources: [Stack.of(this).formatArn({ service: "ssm", resource: "parameter", resourceName: this.tsa.rootsParameter.replace(/^\//, ""), arnFormat: ArnFormat.SLASH_RESOURCE_NAME })],
          })]
          : []),
      ],
    });

    // The schedule: every 15 minutes, with { source: "agentx.audit-epoch" }. The scheduler may assume its role only for this
    // account's schedules in the default group (confused-deputy guard, as the drain schedule).
    const schedulerRole = new iam.Role(this, "AuditEpochSchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com", {
        conditions: {
          StringEquals: {
            "aws:SourceAccount": Aws.ACCOUNT_ID,
            "aws:SourceArn": `arn:${Aws.PARTITION}:scheduler:${Aws.REGION}:${Aws.ACCOUNT_ID}:schedule-group/default`,
          },
        },
      }),
      description: "Lets the EventBridge scheduler invoke the audit anchor every 15 minutes",
      inlinePolicies: {
        InvokeAnchor: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({ sid: "InvokeAnchor", actions: ["lambda:InvokeFunction"], resources: [anchor.functionArn] })],
        }),
      },
    });
    new scheduler.CfnSchedule(this, "AuditEpochSchedule", {
      description: "Seals the audit records written since the last epoch",
      flexibleTimeWindow: { mode: "OFF" },
      scheduleExpression: "rate(15 minutes)",
      state: "ENABLED",
      target: {
        arn: anchor.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ source: "agentx.audit-epoch" }),
        retryPolicy: { maximumRetryAttempts: 0, maximumEventAgeInSeconds: 60 },
      },
    });

    // Three alarms the health route reads (HEALTH_ALARM_SUFFIXES): the plan's audit-seal-overdue, audit-chain-mismatch and
    // audit-object-conflict in the house style. Every run that completes logs audit.epoch_sealed (an idle one too); a
    // stopped or failed run does not, so the overdue alarm fires on a stuck anchor and stays quiet on a quiet install.
    new logs.MetricFilter(this, "AuditEpochSealedMetric", {
      logGroup,
      filterPattern: logs.FilterPattern.stringValue("$.event", "=", "audit.epoch_sealed"),
      metricNamespace: naming.metricsNamespace,
      metricName: "AuditEpochSealed",
      metricValue: "1",
    });
    new cloudwatch.Alarm(this, "AuditSealOverdueAlarm", {
      alarmName: naming.alarmName("AuditSealOverdue"),
      alarmDescription: "No audit epoch has completed in 45 minutes: the anchor is stopped, failing, or not running, and records are not being sealed. Check the anchor's logs for audit.object_conflict, audit.lock_config_mismatch, audit.epoch_stopped and audit.epoch_failed.",
      metric: new cloudwatch.Metric({ namespace: naming.metricsNamespace, metricName: "AuditEpochSealed", statistic: "Sum", period: Duration.minutes(AUDIT_SEAL_INTERVAL_MINUTES) }),
      threshold: 1,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }).addAlarmAction(props.notifyOperator);
    this.alarmOnAtLeastOne(
      naming, props.notifyOperator, "AuditChainMismatchAlarm", "AuditChainMismatch",
      "An org's records or sealed state do not fit its locked seal, or a sealed key holds a delete marker, a second version or other bytes. That org is not being sealed and a person must look. See the anchor's logs for audit.chain_mismatch and audit.version_drift, and docs/runbooks/audit-object-conflict.md.",
      this.countedLogEvents(naming, logGroup, "AuditChainMismatch", "AuditChainMismatch", AUDIT_CHAIN_MISMATCH_EVENTS),
    );
    this.alarmOnAtLeastOne(
      naming, props.notifyOperator, "AuditObjectConflictAlarm", "AuditObjectConflict",
      "A create-only write found different bytes already at its key. That run stopped and the epoch stays open; the next run resumes it, skips the org whose key holds other bytes (audit.version_drift) and seals the others. A person must look: see docs/runbooks/audit-object-conflict.md.",
      this.countedLogEvents(naming, logGroup, "AuditObjectConflict", "AuditObjectConflict", ["audit.object_conflict"]),
    );
    this.alarmOnAtLeastOne(
      naming, props.notifyOperator, "AuditLockDriftAlarm", "AuditLockDrift",
      "The ledger bucket's Object Lock no longer meets the floor, or its versioning, its default retention or its policy differs from what was deployed, an object came back with a weaker lock than the floor, or a sealed key holds a delete marker, a second version or another version. Sealing stops (or the affected org is not finalized) until a person looks. See the anchor's logs for audit.lock_config_mismatch and audit.version_drift, and docs/runbooks/audit-object-conflict.md.",
      this.countedLogEvents(naming, logGroup, "AuditLockDrift", "AuditLockDrift", AUDIT_LOCK_DRIFT_EVENTS),
    );
    // Task 15: an erasure obligation that was not met. A shred that stopped on an error (its due item stays and the next run tries
    // again) or a due item that is damaged: one is enough, because a company's details are waiting to be erased.
    this.alarmOnAtLeastOne(
      naming, props.notifyOperator, "AuditShredFailedAlarm", "AuditShredFailed",
      "A closed company's audit details were due to be shredded and the shred did not finish, or a due item is damaged. The next run tries again; if this repeats, check the anchor's logs for audit.shred_failed (the org, the step and the error), audit.shred_deferred (the run ran out of time before it could finish) and audit.shred_item_invalid, and that the anchor's role can still list and delete in the keys table's partition and the exports bucket.",
      this.countedLogEvents(naming, logGroup, "AuditShredFailed", "AuditShredFailed", AUDIT_SHRED_FAILED_EVENTS),
    );
    // Task 10: a timestamp that was not obtained or not accepted. One miss is normal (an authority is slow); a miss in each of two
    // consecutive 15-minute periods means an authority has been failing for half an hour. Sealing is not held back; the epochs
    // wait and the next stamped epoch covers them.
    new cloudwatch.Alarm(this, "AuditTimestampFailedAlarm", {
      alarmName: naming.alarmName("AuditTimestampFailed"),
      alarmDescription: "A timestamp authority has failed to give the anchor a valid timestamp in each of two 15-minute periods. Sealing goes on and the epochs wait for their timestamp; the next epoch that is stamped covers them, so nothing is lost, but the independent time is late. Check the anchor's logs for audit.timestamp_failed (the label and the problem) and, on a private install, that the functions can reach the authority.",
      metric: this.countedLogEvents(naming, logGroup, "AuditTimestampFailed", "AuditTimestampFailed", AUDIT_TIMESTAMP_FAILED_EVENTS).with({ period: Duration.minutes(AUDIT_SEAL_INTERVAL_MINUTES) }),
      threshold: 1,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(props.notifyOperator);
    return anchor;
  }

  /**
   * The appender (Task 7): the only writer of the audit chain. It reads the FIFO intake queue (the org is the message group,
   * so one appender at a time per org), ten messages a batch, and reports a partial batch's failures so FIFO order holds.
   * Its grants are exactly these (nothing else is attached to the role):
   *  - the ledger table: `GetItem`, `PutItem`, `UpdateItem` and `ConditionCheckItem` (a transaction authorizes each item by its
   *    own action) and only for items whose partition key is `AUDIT#...`, `AUDIT_DIRTY` or `AUDIT_ORGS`, so the seals
   *    state (`AUDIT_EPOCH` and the rest) is out of reach even on this table;
   *  - the keys table: `GetItem` and `PutItem`, never `DeleteItem` or `UpdateItem`: a key is made once and removed only by erasure;
   *  - the intake queue's consume actions (from the event source) and its own log group;
   *  - KMS through the key policy only (AppenderUse), so a stolen role without the encryption context gets nothing.
   * Nothing on the seals table, either bucket, the dead-letter queue or the State table.
   */
  private addAppender(props: AuditLedgerProps): lambda.Function {
    const { naming, appenderRole } = props;
    const logGroup = new logs.LogGroup(this, "AuditAppenderLogs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY });
    const appender = new lambdaNodejs.NodejsFunction(this, "AuditAppender", {
      description: "Appends audit events to each org's hash chain, one writer per org, and seals their details",
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: resolve(process.cwd(), "packages/broker/src/audit/appender-handler.ts"),
      handler: "handler",
      // The queue's visibility timeout (180 s) is six times this, as Lambda's guidance for SQS sources asks.
      timeout: Duration.seconds(30),
      memorySize: 256,
      role: appenderRole,
      logGroup,
      environment: {
        AUDIT_LEDGER_TABLE_NAME: this.ledgerTable.tableName,
        AUDIT_KEYS_TABLE_NAME: this.keysTable.tableName,
        // The key's ARN, never the alias: kms:Update* and kms:CreateAlias let an administrator repoint the alias.
        AUDIT_VAULT_KEY_ARN: this.vaultKey.keyArn,
      },
      bundling: { externalModules: [], minify: true, sourceMap: true, target: "node22", commandHooks: { beforeBundling: (inputDir: string) => [markCodeContractsPureCommand(inputDir)], afterBundling: () => [], beforeInstall: () => [] } },
    });
    // A function on a role of our own gets no log permission from CDK.
    logGroup.grantWrite(appenderRole);
    new iam.Policy(this, "AuditAppenderPolicy", {
      roles: [appenderRole],
      statements: [
        new iam.PolicyStatement({
          sid: "LedgerTable",
          actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem"],
          resources: [this.ledgerTable.tableArn],
          conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["AUDIT#*", "AUDIT_DIRTY", "AUDIT_ORGS"] } },
        }),
        new iam.PolicyStatement({
          sid: "KeysTable",
          actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
          resources: [this.keysTable.tableArn],
        }),
      ],
    });
    appender.addEventSource(new lambdaEventSources.SqsEventSource(this.intakeQueue, { batchSize: 10, reportBatchItemFailures: true }));

    // Two alarms the health route reads (HEALTH_ALARM_SUFFIXES): a message that exhausted its receives, and a queue that is
    // not draining. The names are the plan's audit-intake-dead-letters and audit-intake-backlog in the house style.
    new cloudwatch.Alarm(this, "AuditIntakeDeadLettersAlarm", {
      alarmName: naming.alarmName("AuditIntakeDeadLetters"),
      alarmDescription: "An audit event reached the intake dead-letter queue: the appender could not record it after five receives. Check the appender logs for audit.append_failed and audit.record_invalid, fix the cause, then redrive the queue.",
      metric: this.intakeDeadLetterQueue.metricApproximateNumberOfMessagesVisible({ statistic: "Maximum", period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(props.notifyOperator);
    new cloudwatch.Alarm(this, "AuditIntakeBacklogAlarm", {
      alarmName: naming.alarmName("AuditIntakeBacklog"),
      alarmDescription: "The oldest audit event in the intake queue has waited more than 15 minutes for two periods: the appender is not keeping up or is failing. Check the appender logs and the queue.",
      metric: this.intakeQueue.metricApproximateAgeOfOldestMessage({ statistic: "Maximum", period: Duration.minutes(5) }),
      threshold: 900,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(props.notifyOperator);
    return appender;
  }
}
