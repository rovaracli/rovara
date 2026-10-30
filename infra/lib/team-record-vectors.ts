// R3: the S3 Vectors part of the Team-record storage (design learning-v2-team-record.md 4.9.1, owner decision Q1: S3 Vectors for
// hot and lake). It creates the vector bucket(s). Per-workspace indexes are created at run time by the broker
// (S3VectorsIndex.ensureIndex), because the Public edition has one index per workspace. The Enterprise edition has one workspace,
// so it may pin its index here with `enterpriseWorkspaceId`.
import { type CfnTag, RemovalPolicy, aws_iam as iam } from "aws-cdk-lib";
import { CfnIndex, CfnVectorBucket } from "aws-cdk-lib/aws-s3vectors";
import { Construct } from "constructs";
import { NON_FILTERABLE_VECTOR_KEYS, VECTOR_DIMENSION_DEFAULT, teamRecordVectorIndexName } from "@agentx/contracts";

const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export interface TeamRecordVectorsProps {
  /** Vector bucket names, 3 to 63 characters of lowercase letters, digits and hyphens. A new one per 8,000 workspaces. */
  readonly bucketNames: readonly string[];
  /** The customer's key (Enterprise) or the cell's key (Public). Without it the buckets use S3-managed keys. */
  readonly kmsKeyArn?: string;
  readonly dimension?: number;
  /** Enterprise: the one workspace of the install. Its index is created here and not at run time. */
  readonly enterpriseWorkspaceId?: string;
  readonly tags?: readonly CfnTag[];
}

export class TeamRecordVectors extends Construct {
  readonly buckets: readonly CfnVectorBucket[];
  readonly indexes: readonly CfnIndex[];
  readonly dimension: number;
  readonly bucketNames: readonly string[];

  constructor(scope: Construct, id: string, props: TeamRecordVectorsProps) {
    super(scope, id);
    if (props.bucketNames.length === 0) throw new Error("team-record vectors: at least one vector bucket name is needed");
    for (const name of props.bucketNames) if (!BUCKET_NAME.test(name)) throw new Error(`team-record vectors: ${name} is not a valid vector bucket name`);
    if (new Set(props.bucketNames).size !== props.bucketNames.length) throw new Error("team-record vectors: vector bucket names must differ");
    if (props.enterpriseWorkspaceId !== undefined && props.bucketNames.length !== 1) throw new Error("team-record vectors: an Enterprise install has exactly one vector bucket");
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
  }

  /**
   * What the broker needs: put, query, get and delete on the indexes, and create-index for Public. Query with a filter needs GetVectors
   * too (AWS QueryVectors page). No list or delete-bucket rights.
   */
  brokerStatements(): iam.PolicyStatement[] {
    const statements = [
      new iam.PolicyStatement({
        sid: "TeamRecordVectorsData",
        actions: ["s3vectors:PutVectors", "s3vectors:QueryVectors", "s3vectors:GetVectors", "s3vectors:DeleteVectors", "s3vectors:GetIndex"],
        resources: this.buckets.map((bucket) => `${bucket.attrVectorBucketArn}/index/*`),
      }),
    ];
    return statements;
  }

  /** Public cells create one index per workspace at run time. Enterprise creates it in the stack, so it does not get this right. */
  brokerIndexCreationStatements(): iam.PolicyStatement[] {
    return [
      new iam.PolicyStatement({
        sid: "TeamRecordVectorsCreateIndex",
        actions: ["s3vectors:CreateIndex"],
        resources: this.buckets.map((bucket) => `${bucket.attrVectorBucketArn}/index/*`),
      }),
    ];
  }
}
