// R3: the S3 Vectors part of the Team-record storage (design learning-v2-team-record.md 4.9.1, owner decision Q1: S3 Vectors for
// hot and lake). It creates the vector bucket(s). Per-workspace indexes are created at run time by the broker
// (S3VectorsIndex.ensureIndex), because the Public edition has one index per workspace. The Enterprise edition has one workspace,
// so it may pin its index here with `enterpriseWorkspaceId`.
import { type CfnTag, Duration, RemovalPolicy, aws_iam as iam } from "aws-cdk-lib";
import { CfnIndex, CfnVectorBucket } from "aws-cdk-lib/aws-s3vectors";
import { Construct } from "constructs";
import { NON_FILTERABLE_VECTOR_KEYS, RETIRED_INDEX_TAG_KEYS, VECTOR_DIMENSION_DEFAULT, teamRecordVectorIndexName, teamRecordVectorsRoleName } from "@agentx/cloud-contracts";

/** The IAM policy variable that holds the session's index name. The broker tags every AssumeRole with `rovara-index` = the workspace's index name (team-record/vector-access.ts). */
export const SESSION_INDEX_VARIABLE = "${aws:PrincipalTag/rovara-index}";
/** The session's further tags: the names of the workspace's indexes of the embedding generations before the current one (Titan, then Qwen3), which the only extra right (DeleteIndex) names. */
export const SESSION_RETIRED_INDEX_VARIABLES: readonly string[] = RETIRED_INDEX_TAG_KEYS.map((key) => `\${aws:PrincipalTag/${key}}`);
const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export interface TeamRecordVectorsProps {
  /** Vector bucket names, 3 to 63 characters of lowercase letters, digits and hyphens. A new one per 8,000 workspaces. */
  readonly bucketNames: readonly string[];
  /** The customer's key (Enterprise) or the cell's key (Public). Without it the buckets use S3-managed keys. */
  readonly kmsKeyArn?: string;
  /**
   * The environment the data role is named for (`agentx-<env>-record-vectors-data`, teamRecordVectorsRoleName). A fixed name, so the default boundary can let the broker assume it and the deploy role can look it up
   * (TR-SWITCH-B2). Without it CloudFormation names the role, which is only for a construct tested alone.
   */
  readonly env?: string;
  readonly dimension?: number;
  /** Enterprise: the one workspace of the install. Its index is created here and not at run time. */
  readonly enterpriseWorkspaceId?: string;
  readonly tags?: readonly CfnTag[];
  /**
   * The broker's principal. REQUIRED: the data rights live on a role the broker assumes with a per-workspace SESSION POLICY (review I-8),
   * so each session reaches only `index/ws-<hash>` of one workspace. The broker role itself never holds `index/*`.
   */
  readonly brokerPrincipal?: iam.IPrincipal;
  /** Tests only: give the broker role `index/*` on every workspace directly. Synth refuses a stack with neither this nor `brokerPrincipal`. */
  readonly unsafeTenantWideBrokerAccess?: boolean;
}

export class TeamRecordVectors extends Construct {
  readonly buckets: readonly CfnVectorBucket[];
  readonly indexes: readonly CfnIndex[];
  readonly dimension: number;
  readonly bucketNames: readonly string[];
  /** The role the broker assumes with a session policy (only when `brokerPrincipal` was given). */
  readonly dataRole: iam.Role | undefined;

  constructor(scope: Construct, id: string, props: TeamRecordVectorsProps) {
    super(scope, id);
    if (props.bucketNames.length === 0) throw new Error("team-record vectors: at least one vector bucket name is needed");
    for (const name of props.bucketNames) if (!BUCKET_NAME.test(name)) throw new Error(`team-record vectors: ${name} is not a valid vector bucket name`);
    if (new Set(props.bucketNames).size !== props.bucketNames.length) throw new Error("team-record vectors: vector bucket names must differ");
    // Review I-7: the broker finds a workspace's bucket by a hash of the bucket list today. More than one bucket would orphan vectors the day
    // the list changes. Until each workspace stores its assigned bucket, exactly one bucket is allowed.
    if (props.bucketNames.length !== 1) throw new Error("team-record vectors: exactly one vector bucket is supported until each workspace stores its assigned bucket");
    this.dimension = props.dimension ?? VECTOR_DIMENSION_DEFAULT;
    this.bucketNames = props.bucketNames;
    const tags = props.tags === undefined ? undefined : [...props.tags];

    this.buckets = props.bucketNames.map((name, i) => {
      const bucket = new CfnVectorBucket(this, `Bucket${i}`, {
        vectorBucketName: name,
        encryptionConfiguration: props.kmsKeyArn === undefined ? { sseType: "AES256" } : { sseType: "aws:kms", kmsKeyArn: props.kmsKeyArn },
        ...(tags === undefined ? {} : { tags }),
      });
      // The Team record outlives the stack that made it (deletion promises are about records, not about stack deletes).
      bucket.applyRemovalPolicy(RemovalPolicy.RETAIN);
      return bucket;
    });

    this.indexes = [];
    if (props.enterpriseWorkspaceId !== undefined) {
      const index = new CfnIndex(this, "EnterpriseIndex", {
        vectorBucketName: props.bucketNames[0]!,
        indexName: teamRecordVectorIndexName(props.enterpriseWorkspaceId),
        dataType: "float32",
        dimension: this.dimension,
        distanceMetric: "cosine",
        metadataConfiguration: { nonFilterableMetadataKeys: [...NON_FILTERABLE_VECTOR_KEYS] },
        ...(props.kmsKeyArn === undefined ? {} : { encryptionConfiguration: { sseType: "aws:kms", kmsKeyArn: props.kmsKeyArn } }),
        ...(tags === undefined ? {} : { tags }),
      });
      index.addDependency(this.buckets[0]!);
      index.applyRemovalPolicy(RemovalPolicy.RETAIN);
      this.indexes = [index];
    }

    if (props.brokerPrincipal === undefined && props.unsafeTenantWideBrokerAccess !== true) {
      throw new Error("team-record vectors: brokerPrincipal is required (vector access is scoped to one workspace per session)");
    }
    if (props.brokerPrincipal !== undefined) {
      this.dataRole = new iam.Role(this, "DataRole", {
        assumedBy: props.brokerPrincipal,
        description: "Rovara Team record: vector data access, assumed by the broker with a per-workspace session policy",
        maxSessionDuration: Duration.hours(1),
        ...(props.env === undefined ? {} : { roleName: teamRecordVectorsRoleName(props.env) }),
      });
      // Fix round 1, S2: the role's own rights name the index through the session TAG, `index/${aws:PrincipalTag/rovara-index}`. A session that was not tagged has no value for the variable and matches
      // no resource (IAM: "a resource that includes a policy variable with no value will not match any resource"), so an AssumeRole made without the per-workspace policy and tag reaches nothing. The
      // session policy stays too: the two layers are independent. The trust policy lets the broker role tag a session only with an index name (`ws-...`).
      for (const statement of [...this.dataStatements(true), ...this.retireStatements(), ...(props.enterpriseWorkspaceId === undefined ? this.creationStatements(true) : [])]) this.dataRole.addToPolicy(statement);
      this.dataRole.assumeRolePolicy?.addStatements(new iam.PolicyStatement({
        sid: "TagSessionWithTheIndex", actions: ["sts:TagSession"], principals: [props.brokerPrincipal],
        conditions: {
          StringLike: { "aws:RequestTag/rovara-index": "ws-*" },
          StringLikeIfExists: Object.fromEntries(RETIRED_INDEX_TAG_KEYS.map((key) => [`aws:RequestTag/${key}`, "ws-*"])),
          "ForAllValues:StringEquals": { "aws:TagKeys": ["rovara-index", ...RETIRED_INDEX_TAG_KEYS] },
        },
      }));
      if (props.kmsKeyArn !== undefined) {
        this.dataRole.addToPolicy(new iam.PolicyStatement({ sid: "TeamRecordVectorsKms", actions: ["kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"], resources: [props.kmsKeyArn] }));
      }
    } else {
      this.dataRole = undefined;
    }
  }

  /**
   * What the broker needs: put, query, get and delete on the indexes, and create-index for Public. Query with a filter needs GetVectors
   * too (AWS QueryVectors page). No list or delete-bucket rights.
   */
  brokerStatements(): iam.PolicyStatement[] {
    // With a data role the broker holds only the right to assume it; the session policy then narrows it to one workspace.
    if (this.dataRole !== undefined) return [new iam.PolicyStatement({ sid: "TeamRecordVectorsAssume", actions: ["sts:AssumeRole", "sts:TagSession"], resources: [this.dataRole.roleArn] })];
    return this.dataStatements(false);
  }

  /** `forRole`: the data role's rights, which name the index by the session tag. Not for the role: every index of the bucket (the test-only tenant-wide broker access). */
  private dataStatements(forRole: boolean): iam.PolicyStatement[] {
    const statements = [
      new iam.PolicyStatement({
        sid: "TeamRecordVectorsData",
        actions: ["s3vectors:PutVectors", "s3vectors:QueryVectors", "s3vectors:GetVectors", "s3vectors:DeleteVectors", "s3vectors:GetIndex"],
        resources: this.buckets.map((bucket) => `${bucket.attrVectorBucketArn}/index/${forRole ? SESSION_INDEX_VARIABLE : "*"}`),
      }),
    ];
    return statements;
  }

  /**
   * The one extra right of the data role: delete the workspace's indexes of the embedding generations before the current one, each named by a session tag (an untagged session has no value for the
   * variable and matches nothing). Deleting an index deletes every vector in it, so this is also how an erase reaches vectors left in the old index.
   */
  private retireStatements(): iam.PolicyStatement[] {
    return [new iam.PolicyStatement({
      sid: "TeamRecordVectorsRetireOldIndex",
      actions: ["s3vectors:DeleteIndex"],
      resources: this.buckets.flatMap((bucket) => SESSION_RETIRED_INDEX_VARIABLES.map((variable) => `${bucket.attrVectorBucketArn}/index/${variable}`)),
    })];
  }

  /** Public cells create one index per workspace at run time. Enterprise creates it in the stack, so it does not get this right. */
  brokerIndexCreationStatements(): iam.PolicyStatement[] {
    return this.dataRole === undefined ? this.creationStatements(false) : [];
  }

  private creationStatements(forRole: boolean): iam.PolicyStatement[] {
    return [
      new iam.PolicyStatement({
        sid: "TeamRecordVectorsCreateIndex",
        actions: ["s3vectors:CreateIndex"],
        resources: this.buckets.map((bucket) => `${bucket.attrVectorBucketArn}/index/${forRole ? SESSION_INDEX_VARIABLE : "*"}`),
      }),
    ];
  }
}
