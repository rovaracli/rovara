// E1: the whole Team-record storage of one install or cell: vector buckets (R3), the lake (R4) and the rights the broker needs.
// The hot DynamoDB table (task R2, record lane) is not part of this construct. The controller adds `brokerStatements()` to the broker role
// and `environment` to the broker environment when the stack is wired (see report.md, "Wiring pending").
import { CfnOutput, Stack, aws_iam as iam } from "aws-cdk-lib";
import { Construct } from "constructs";
import { teamRecordEmbeddingFamily } from "@agentx/contracts";
import { TeamRecordLake } from "./team-record-lake.js";
import { kmsKeyPolicyStatements, teamRecordParameters, type TeamRecordContext, type TeamRecordParameters } from "./team-record-edition.js";
import { TeamRecordVectors } from "./team-record-vectors.js";

export interface TeamRecordStorageProps {
  /** Resource-name prefix, for example `rovara-staging`. Lowercase letters, digits and hyphens. */
  readonly namePrefix: string;
  readonly context: TeamRecordContext;
  /** Only 1 is allowed until each workspace stores its assigned vector bucket (review I-7). */
  readonly publicVectorBucketCount?: number;
  /** The broker role or principal. Vector access goes through a data role with per-workspace session policies (review I-8). */
  readonly brokerPrincipal?: iam.IPrincipal;
  /** Tests only: see TeamRecordVectors. */
  readonly unsafeTenantWideBrokerAccess?: boolean;
  readonly bytesScannedCutoffPerQuery?: number;
}

export class TeamRecordStorage extends Construct {
  readonly parameters: TeamRecordParameters;
  readonly vectors: TeamRecordVectors;
  readonly lake: TeamRecordLake | undefined;

  constructor(scope: Construct, id: string, props: TeamRecordStorageProps) {
    super(scope, id);
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(props.namePrefix)) throw new Error("team record: namePrefix must be lowercase letters, digits and hyphens");
    this.parameters = teamRecordParameters(props.context);
    const params = this.parameters;
    const count = params.edition === "enterprise" ? 1 : (props.publicVectorBucketCount ?? 1);
    if (count !== 1) throw new Error("team record: publicVectorBucketCount must be 1 until each workspace stores its assigned vector bucket");

    this.vectors = new TeamRecordVectors(this, "Vectors", {
      bucketNames: Array.from({ length: count }, (_, i) => `${props.namePrefix}-record-vectors${count === 1 ? "" : `-${i + 1}`}`),
      ...(params.kmsKeyArn === undefined ? {} : { kmsKeyArn: params.kmsKeyArn }),
      dimension: params.dimension,
      ...(props.brokerPrincipal === undefined ? {} : { brokerPrincipal: props.brokerPrincipal }),
      ...(props.unsafeTenantWideBrokerAccess === true ? { unsafeTenantWideBrokerAccess: true } : {}),
      ...(params.enterpriseWorkspaceId === undefined ? {} : { enterpriseWorkspaceId: params.enterpriseWorkspaceId }),
    });

    this.lake = params.lakeEnabled
      ? new TeamRecordLake(this, "Lake", {
          tableBucketName: `${props.namePrefix}-record-lake`,
          workGroupName: `${props.namePrefix}-record`,
          ...(params.kmsKeyArn === undefined ? {} : { kmsKeyArn: params.kmsKeyArn }),
          ...(props.bytesScannedCutoffPerQuery === undefined ? {} : { bytesScannedCutoffPerQuery: props.bytesScannedCutoffPerQuery }),
        })
      : undefined;

    // The customer's key policy must name the S3 Tables and S3 Vectors service principals (review I-6). The install prints the statements.
    if (params.kmsKeyArn !== undefined) {
      new CfnOutput(this, "KmsKeyPolicyStatements", {
        description: "Add these statements to the KMS key policy of the Team-record key (S3 Tables maintenance, S3 Vectors indexing). [verify] in the test environment.",
        value: Stack.of(this).toJsonString(kmsKeyPolicyStatements(Stack.of(this).account)),
      });
    }

    // Enterprise: the customer's own admins get read-only SQL on their workgroup. Public has none.
    if (this.lake !== undefined && params.athenaUsers.length > 0) {
      const policy = new iam.Policy(this, "AnalystRead", { statements: this.lake.analystStatements() });
      params.athenaUsers.forEach((arn, i) => policy.attachToRole(iam.Role.fromRoleArn(this, `Analyst${i}`, arn, { mutable: true })));
    }
  }

  /** Bedrock rights for the embedding model only. A region-prefixed model id is an inference profile: it needs the profile and the base model. */
  embeddingStatements(): iam.PolicyStatement[] {
    const stack = Stack.of(this);
    const modelId = this.parameters.embeddingModelId;
    teamRecordEmbeddingFamily(modelId);
    const prefixed = /^[a-z]{2}\./.test(modelId);
    const base = prefixed ? modelId.slice(3) : modelId;
    return [
      new iam.PolicyStatement({
        sid: "TeamRecordEmbeddings",
        actions: ["bedrock:InvokeModel"],
        resources: prefixed
          ? [stack.formatArn({ service: "bedrock", resource: "inference-profile", resourceName: modelId }), `arn:${stack.partition}:bedrock:*::foundation-model/${base}`]
          : [`arn:${stack.partition}:bedrock:${stack.region}::foundation-model/${base}`],
      }),
    ];
  }

  /** Everything the broker role needs for the Team-record storage. Public cells also create workspace indexes at run time. */
  brokerStatements(): iam.PolicyStatement[] {
    return [
      ...this.vectors.brokerStatements(),
      ...(this.parameters.edition === "public" ? this.vectors.brokerIndexCreationStatements() : []),
      ...this.embeddingStatements(),
      ...(this.lake === undefined ? [] : this.lake.brokerStatements()),
      ...this.kmsStatements(),
    ];
  }

  /** The vector buckets use the key for server-side encryption of vectors written by the broker. With a data role the role holds this right, not the broker. */
  private kmsStatements(): iam.PolicyStatement[] {
    const arn = this.parameters.kmsKeyArn;
    return arn === undefined || this.vectors.dataRole !== undefined ? [] : [new iam.PolicyStatement({ sid: "TeamRecordVectorsKms", actions: ["kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"], resources: [arn] })];
  }

  /** Names for the broker environment. These are not secrets. */
  get environment(): Record<string, string> {
    return {
      ROVARA_EDITION: this.parameters.edition,
      TEAM_RECORD_VECTOR_BUCKETS: this.vectors.bucketNames.join(","),
      TEAM_RECORD_EMBEDDING_MODEL_ID: this.parameters.embeddingModelId,
      TEAM_RECORD_EMBEDDING_DIMENSION: String(this.parameters.dimension),
      TEAM_RECORD_LAKE_ENABLED: String(this.lake !== undefined),
      // The role the broker assumes, with a per-workspace session policy, for every vector call.
      ...(this.vectors.dataRole === undefined ? {} : { TEAM_RECORD_VECTORS_ROLE_ARN: this.vectors.dataRole.roleArn }),
      ...(this.parameters.kmsKeyArn === undefined ? {} : { TEAM_RECORD_KMS_KEY_ARN: this.parameters.kmsKeyArn }),
      ...(this.lake === undefined ? {} : { TEAM_RECORD_TABLE_BUCKET: this.lake.tableBucketName, TEAM_RECORD_ATHENA_WORKGROUP: this.lake.workGroupName }),
    };
  }
}
