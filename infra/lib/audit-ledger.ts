// The Audit Ledger's storage (Task 5 of the Audit Ledger plan): the intake queue, three tables, the vault key with an
// explicit key policy, and the Object Lock bucket with its policy; and (Task 6) the broker's side of the outbox: its
// grants, the drain schedule and the two alarms on its log. The appender, the anchor and their grants arrive in later
// tasks, each pinned in its own test. Named environments only (the caller gates on naming.env); every stateful resource
// is kept when the stack goes.
import { createHash } from "node:crypto";
import {
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
  type aws_lambda as lambda,
  aws_logs as logs,
  aws_s3 as s3,
  aws_scheduler as scheduler,
  aws_sqs as sqs,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { AUDIT_GOVERNANCE_RETENTION_DAYS, AUDIT_INTAKE_MAX_RECEIVES, AUDIT_RETENTION_DAYS_DEFAULT, canonicalJson } from "@agentx/contracts";
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
  /** The State table, where the pending items live. */
  readonly stateTable: dynamodb.Table;
  /** Notifies the operator (the alerts topic) when an audit alarm fires. */
  readonly notifyOperator: cloudwatch.IAlarmAction;
  /**
   * The appender function's role (Task 7 builds the function on it): may generate data keys and decrypt under the
   * encryption context. It is an input because the key policy names it, and it has no permissions of its own here.
   */
  readonly appenderRole: iam.IRole;
  /** The region the environment installs in; it is part of the ledger bucket's name, which S3 caps at 63 characters. */
  readonly deploymentRegion?: string;
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
  readonly ledgerBucket: s3.Bucket;
  readonly exportsBucket: s3.Bucket;
  /** The settings of each lock profile, and the one the `AuditLockProfile` parameter defaults to. */
  readonly lockProfiles: { readonly production: AuditLockProfileSettings; readonly trial: AuditLockProfileSettings; readonly default: AuditLockProfile };
  /** The stack parameter that chooses the lock profile (`production` or `trial`). */
  readonly lockProfileParameter: CfnParameter;
  /** True when `AuditLockProfile` is `trial`. */
  readonly trialCondition: CfnCondition;
  /**
   * SHA-256 (hex) of the canonical JSON of the bucket policy document with `{{partition}}`, `{{account}}` and `{{region}}`
   * in place of the deployment's values, for each lock profile: the policy differs between them (operator exceptions,
   * retention days), so there is one hash per profile.
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
      queueName: `${naming.resourcePrefix}-audit-intake.fifo`,
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
        ],
      }),
    });

    // The key policy lets nobody ScheduleKeyDeletion (and the alias cannot be deleted by anyone the policy allows), so a
    // rolled-back first create could not delete either and would leave the stack in ROLLBACK_FAILED. Both keep plain
    // Retain (the ActionLogsKey precedent in slack-orchestrator.ts).
    (this.vaultKey.node.defaultChild as kms.CfnKey).addMetadata(KEEP_ON_ROLLBACK_METADATA, true);
    // Later tasks MUST address the vault key by its ARN, never by this alias: kms:Update* and kms:CreateAlias in
    // AdminWithoutUse let an IAM administrator repoint the alias at a key they control.
    const vaultKeyAlias = new kms.Alias(this, "AuditVaultKeyAlias", { aliasName: `alias/agentx/${env}/audit-vault`, targetKey: this.vaultKey, removalPolicy: RemovalPolicy.RETAIN });
    (vaultKeyAlias.node.defaultChild as kms.CfnAlias).addMetadata(KEEP_ON_ROLLBACK_METADATA, true);

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
    // serialization CloudFormation receives, so the anchor can compare against what the bucket reports.
    const hashOf = (profile: AuditLockProfileSettings): string => createHash("sha256")
      .update(canonicalJson(stack.resolve(documentOf({ partition: "{{partition}}", account: "{{account}}", region: "{{region}}" }, profile).toJSON())))
      .digest("hex");
    this.bucketPolicySha256ByProfile = { production: hashOf(this.lockProfiles.production), trial: hashOf(this.lockProfiles.trial) };
    this.bucketPolicySha256 = Fn.conditionIf(this.trialCondition.logicalId, this.bucketPolicySha256ByProfile.trial, this.bucketPolicySha256ByProfile.production).toString() as TemplateTokenString;

    this.exportsBucket = new s3.Bucket(this, "AuditExportsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(7) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.addBrokerOutbox(props, brokerRole);

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
   * The broker's side of the outbox (Task 6). The outbox code runs inside the broker function, so every grant here goes
   * to the broker's role and to no other function:
   *  - `sqs:SendMessage` on the intake queue: the flush, the drain and the customer-read fallback call SendMessageBatch,
   *    which needs this one action. Nothing on the dead-letter queue, and no receive or delete.
   *  - `dynamodb:PutItem` (the staff-read put, and the pending item inside the action's transaction), `Query` (the drain),
   *    `UpdateItem` (the drain's attempt count and its once-only failure mark) and `DeleteItem` (the flush and the drain),
   *    on the State table with `dynamodb:LeadingKeys` restricted to `AUDIT_PENDING#*`. The pending code never reads a
   *    single item, so there is no `GetItem`. The ledger, seals and keys tables, the bucket and the key get nothing.
   * The broker already holds read and write on the State table (`grantReadWriteData`), so this statement narrows nothing
   * today; it states and pins what the outbox needs, and it is the grant that would remain if that broader one is
   * ever cut back. It is a separate policy so that it is easy to find and to take out of snapshots.
   */
  private addBrokerOutbox(props: AuditLedgerProps, brokerRole: iam.IRole): void {
    const { naming, broker } = props;
    broker.addEnvironment("AUDIT_INTAKE_QUEUE_URL", this.intakeQueue.queueUrl);
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
    const counted = (id: string, metricName: string, events: readonly string[]): cloudwatch.Metric => {
      new logs.MetricFilter(this, `${id}Metric`, {
        logGroup: broker.logGroup,
        filterPattern: logs.FilterPattern.any(...events.map((event) => logs.FilterPattern.stringValue("$.event", "=", event))),
        metricNamespace: naming.metricsNamespace,
        metricName,
        metricValue: "1",
      });
      return new cloudwatch.Metric({ namespace: naming.metricsNamespace, metricName, statistic: "Sum", period: Duration.minutes(5) });
    };
    const alarm = (id: string, suffix: string, description: string, metric: cloudwatch.Metric) => {
      new cloudwatch.Alarm(this, id, {
        alarmName: naming.alarmName(suffix),
        alarmDescription: description,
        metric,
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(props.notifyOperator);
    };
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
}
