// The Audit Ledger's storage (Task 5 of the Audit Ledger plan): the intake queue, three tables, the vault key with an
// explicit key policy, and the Object Lock bucket with its policy. The appender, the anchor and their grants arrive in
// later tasks, each pinned in its own test. Named environments only (the caller gates on naming.env); every stateful
// resource is kept when the stack goes.
import { createHash } from "node:crypto";
import {
  Aws,
  Duration,
  RemovalPolicy,
  Stack,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_kms as kms,
  aws_s3 as s3,
  aws_sqs as sqs,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { AUDIT_INTAKE_MAX_RECEIVES, canonicalJson } from "@agentx/contracts";
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

export interface AuditLedgerProps {
  readonly naming: AgentXNaming;
  /** The broker function's role: may read details back (Decrypt) under the encryption context, and nothing else on the key. */
  readonly brokerRole: iam.IRole;
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
  /** SHA-256 (hex) of the canonical JSON of the bucket policy document with `{{partition}}`, `{{account}}` and `{{region}}` in place of the deployment's values. */
  readonly bucketPolicySha256: string;

  constructor(scope: Construct, id: string, props: AuditLedgerProps) {
    super(scope, id);
    const { naming } = props;
    if (naming.env === undefined) throw new Error("audit ledger: the ledger exists for named environments only");
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
            principals: [new iam.ArnPrincipal(props.brokerRole.roleArn)],
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

    // The ledger bucket. Object Lock needs versioning; the default retention stamps every object at creation.
    const policyInputs = (values: Pick<AuditBucketPolicyInputs, "partition" | "account" | "region">): AuditBucketPolicyInputs => ({
      ...values,
      resourcePrefix: naming.resourcePrefix,
      cloudFormationRoleName: naming.cloudFormationRoleName,
      operatorRoleName: naming.operatorRoleName,
      mode: this.lock.mode,
      retentionDays: this.lock.retentionDays,
    });
    const real = policyInputs({ partition: Aws.PARTITION, account: Aws.ACCOUNT_ID, region: Aws.REGION });
    const retention = this.lock.mode === "COMPLIANCE"
      ? s3.ObjectLockRetention.compliance(Duration.days(this.lock.retentionDays))
      : s3.ObjectLockRetention.governance(Duration.days(this.lock.retentionDays));
    this.ledgerBucket = new s3.Bucket(this, "AuditLedgerBucket", {
      bucketName: auditLedgerBucketName(real),
      objectLockEnabled: true,
      objectLockDefaultRetention: retention,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    for (const statement of auditBucketPolicyStatements(real)) this.ledgerBucket.addToResourcePolicy(iam.PolicyStatement.fromJson(statement));

    // The same document with placeholders where the deployment's values go; resolving it through CDK gives the
    // serialization CloudFormation receives, so the anchor can compare against what the bucket reports.
    const hashed = new iam.PolicyDocument({
      statements: auditBucketPolicyStatements(policyInputs({ partition: "{{partition}}", account: "{{account}}", region: "{{region}}" })).map((statement) => iam.PolicyStatement.fromJson(statement)),
    });
    this.bucketPolicySha256 = createHash("sha256").update(canonicalJson(stack.resolve(hashed.toJSON()))).digest("hex");

    this.exportsBucket = new s3.Bucket(this, "AuditExportsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(7) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

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
}
