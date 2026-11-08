// E1: the install parameters of the Team-record storage (design learning-v2-team-record.md 4.9.2), read from CDK context and checked at synth.
// Pure functions with no CDK imports, so a test can feed them any value. W6's edition switch is not built yet: `edition` is a context value
// (`agentxTeamRecordEdition`), and Public is the default.
import { VECTOR_DIMENSION_DEFAULT } from "@agentx/contracts";

export type TeamRecordEditionName = "enterprise" | "public";

const KMS_KEY_ARN = /^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:key\/[0-9a-f-]{36}$/;
const ROLE_ARN = /^arn:aws[a-z-]*:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/;
const MAX_ATHENA_USERS = 20;

/**
 * The key-policy statements the customer's KMS key needs so S3 Tables maintenance (compaction, snapshot expiry, unreferenced-file removal)
 * and S3 Vectors indexing can use it (review I-6). The key is imported by ARN, so CDK cannot add them: the install emits them (stack output
 * `KmsKeyPolicyStatements`) for the customer to add to the key policy. Without them maintenance fails quietly, which also breaks the
 * deletion promise. [verify] the exact service principal names, the actions and the aws:SourceAccount condition against the S3 Tables and
 * S3 Vectors encryption pages, then run the post-deploy check (table maintenance status healthy) in the test environment.
 */
export function kmsKeyPolicyStatements(account: string): Array<Record<string, unknown>> {
  const condition = { StringEquals: { "aws:SourceAccount": account } };
  return [
    {
      Sid: "TeamRecordS3TablesMaintenance",
      Effect: "Allow",
      Principal: { Service: ["maintenance.s3tables.amazonaws.com", "s3tables.amazonaws.com"] },
      Action: ["kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"],
      Resource: "*",
      Condition: condition,
    },
    {
      Sid: "TeamRecordS3VectorsIndexing",
      Effect: "Allow",
      Principal: { Service: ["indexing.s3vectors.amazonaws.com", "s3vectors.amazonaws.com"] },
      Action: ["kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"],
      Resource: "*",
      Condition: condition,
    },
  ];
}

export interface TeamRecordParameters {
  readonly edition: TeamRecordEditionName;
  /** The index dimension. The embedder (environments/embedder, Qwen3-Embedding-0.6B) is fixed; there is no embedding model to choose. */
  readonly dimension: number;
  /** Enterprise: required. Public: the cell's key, optional. */
  readonly kmsKeyArn: string | undefined;
  /** Default true. Under retention C the lake holds facts, outcomes and structured metadata only (owner decision Q3). */
  readonly lakeEnabled: boolean;
  /** Enterprise only: IAM roles of the customer's own admins who may query the workgroup. */
  readonly athenaUsers: readonly string[];
  /** Enterprise only: the one workspace of the install. */
  readonly enterpriseWorkspaceId: string | undefined;
}

function bool(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`team record: ${name} must be true or false, not ${JSON.stringify(value)}`);
}

function text(value: unknown, name: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`team record: ${name} must be a string`);
  return value;
}

function list(value: unknown, name: string): string[] {
  if (value === undefined || value === "") return [];
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",").map((item) => item.trim()) : undefined;
  if (items === undefined || items.some((item) => typeof item !== "string" || item === "")) throw new Error(`team record: ${name} must be a list of strings`);
  return items as string[];
}

export interface TeamRecordContext {
  edition?: unknown;
  /** Retired (DECISIONS 27): the embedder is the self-hosted one in both editions. Any value is refused. */
  embeddingModelId?: unknown;
  kmsKeyArn?: unknown;
  lakeEnabled?: unknown;
  athenaUsers?: unknown;
  enterpriseWorkspaceId?: unknown;
}

export function teamRecordParameters(context: TeamRecordContext): TeamRecordParameters {
  const editionValue = context.edition ?? "public";
  if (editionValue !== "enterprise" && editionValue !== "public") throw new Error(`team record: edition must be enterprise or public, not ${JSON.stringify(editionValue)}`);
  const edition: TeamRecordEditionName = editionValue;

  // Bedrock embedding models (Titan, Cohere) are gone: the Team record embeds with the self-hosted embedder in both editions (DECISIONS 27). A leftover value must not be ignored in silence.
  if (text(context.embeddingModelId, "embeddingModelId") !== undefined) throw new Error("team record: embeddingModelId is retired; the Team record uses the built-in self-hosted embedder (remove the option: agentx config set teamRecord.options default)");

  const kmsKeyArn = text(context.kmsKeyArn, "kmsKeyArn");
  if (kmsKeyArn !== undefined && !KMS_KEY_ARN.test(kmsKeyArn)) throw new Error("team record: kmsKeyArn must be a KMS key ARN (a key id, not an alias)");
  if (edition === "enterprise" && kmsKeyArn === undefined) throw new Error("team record: an Enterprise install needs kmsKeyArn (their key, not an S3-managed default)");

  const athenaUsers = list(context.athenaUsers, "athenaUsers");
  if (athenaUsers.length > 0 && edition !== "enterprise") throw new Error("team record: athenaUsers is for Enterprise only; Public runs templated queries and no customer SQL");
  if (athenaUsers.length > MAX_ATHENA_USERS) throw new Error(`team record: athenaUsers lists at most ${MAX_ATHENA_USERS} roles`);
  for (const arn of athenaUsers) if (!ROLE_ARN.test(arn)) throw new Error("team record: athenaUsers must be IAM role ARNs");

  const lakeEnabled = bool(context.lakeEnabled, "lakeEnabled", true);
  if (athenaUsers.length > 0 && !lakeEnabled) throw new Error("team record: athenaUsers needs the lake (lakeEnabled)");

  const workspace = text(context.enterpriseWorkspaceId, "enterpriseWorkspaceId");
  if (edition === "enterprise" && workspace === undefined) throw new Error("team record: an Enterprise install needs enterpriseWorkspaceId");
  if (edition === "public" && workspace !== undefined) throw new Error("team record: enterpriseWorkspaceId is for Enterprise only");

  return { edition, dimension: VECTOR_DIMENSION_DEFAULT, kmsKeyArn, lakeEnabled, athenaUsers, enterpriseWorkspaceId: workspace };
}
