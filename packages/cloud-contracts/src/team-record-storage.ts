// Storage constants of the Team record that both the infrastructure (infra/lib/team-record-*.ts) and the broker
// (packages/broker/src/team-record) must agree on. Task R3/R4 of design learning-v2-team-record.md.
// Kept apart from team-record.ts (task R1, record lane) so the two lanes do not edit one file.
import { createHash } from "node:crypto";

/** The dimension of the Team record's vector index, fixed when an index is created. The self-hosted record embedder (bge-small-en-v1.5, since DECISIONS 140; Qwen3-Embedding-0.6B before it, 1,024) produces exactly this many. */
export const VECTOR_DIMENSION_DEFAULT = 384;

/** The only non-filterable metadata key of a Team-record vector: the id of the record it stands for. */
export const NON_FILTERABLE_VECTOR_KEYS = ["ref"] as const;

/**
 * The self-hosted embedder (environments/embedder, DECISIONS 23 and 27): one container-image Lambda with two baked-in models, no Bedrock and no third-party model call.
 * `spec` is the hash `embedder_core.spec_id` computes from the model, its pinned Hugging Face revision, the quantization, the pooling, the truncation and the wrapper tokens
 * (environments/embedder/models.lock.json holds the same value, and tests/unit/embedder/spec.test.ts keeps the two equal). It decides which vectors may sit together.
 */
export interface EmbedderModelSpec {
  readonly model: "record" | "lesson";
  /** The Hugging Face repository the weights come from. */
  readonly modelId: string;
  /** The pinned Hugging Face commit. */
  readonly revision: string;
  readonly spec: string;
  readonly dimension: number;
}

/**
 * The Team record's embedder: bge-small-en-v1.5 (384 dimensions, texts cut at 512 tokens), the same model as the lessons' (DECISIONS 140, 2026-11-12). Replaces Qwen3-Embedding-0.6B (1,024
 * dimensions, spec 0b0a5b868995d4ee), which took more than 190 s to read its 2.4 GB of weights on a cold Lambda start, and before that Amazon Titan Text Embeddings V2 (Bedrock). The same
 * model means the same spec as `LESSON_EMBEDDER`; the two never meet, because the Team record's vectors are in S3 Vectors (an index per workspace and spec) and the lessons' in DynamoDB.
 */
export const TEAM_RECORD_EMBEDDER: EmbedderModelSpec = { model: "record", modelId: "BAAI/bge-small-en-v1.5", revision: "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a", spec: "9ae98ff9968d4905", dimension: VECTOR_DIMENSION_DEFAULT };
/** The lessons' embedder (lane lessons-prod; bge-small, 384 dimensions). Its vectors are kept with the lessons and never go into the Team record's index. */
export const LESSON_EMBEDDER: EmbedderModelSpec = { model: "lesson", modelId: "BAAI/bge-small-en-v1.5", revision: "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a", spec: "9ae98ff9968d4905", dimension: 384 };

const SAFE_WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * One index per workspace AND embedding spec: `ws-` plus 32 hex characters of a hash, so the name is valid for S3 Vectors and reveals nothing. The spec is in the hash, so
 * vectors of two different models can never share an index: a model change names a new, empty index (the old one is left alone until it is re-embedded and removed), and the
 * stack, the session policy and the broker all get the new name from this one function.
 */
export function teamRecordVectorIndexName(workspaceId: string, spec: string = TEAM_RECORD_EMBEDDER.spec): string {
  if (!SAFE_WORKSPACE_ID.test(workspaceId)) throw new Error("team-record: workspace id is not a safe id");
  if (!/^[0-9a-f]{16}$/.test(spec)) throw new Error("team-record: embedding spec is not valid");
  return `ws-${createHash("sha256").update(`team-record-vectors\u0000${workspaceId}\u0000${spec}`).digest("hex").slice(0, 32)}`;
}

/**
 * The index name of the embedding generation BEFORE the self-hosted embedder: `ws-` plus the hash of the workspace alone (no spec), the name every Team record used while it embedded with
 * Amazon Titan. Its vectors are in another model's space and can never be searched with a Qwen query. It is deleted for every workspace as soon as the current index exists (the broker does it
 * the first time it opens a workspace's index, team-record/runtime.ts), and a person, project or workspace erase deletes it first: erasure must not leave a person's vectors behind in an
 * index nobody addresses. When the spec changes again, point this at the then-current spec's name (`teamRecordVectorIndexName(workspaceId, <that spec>)`) and the same retire step applies.
 * (DECISIONS 140, the Qwen3 to bge-small change, did NOT repoint it: no install ever stored a Qwen3 vector or created its 1,024-d index, because the embedder never answered on staging, and the release step
 * before the next switch-on shows the vector bucket and the table are empty. If an install is found with a 1,024-d index, delete it by hand before switching on; the code would not find it for an erase.)
 */
export function retiredTeamRecordVectorIndexName(workspaceId: string): string {
  if (!SAFE_WORKSPACE_ID.test(workspaceId)) throw new Error("team-record: workspace id is not a safe id");
  return `ws-${createHash("sha256").update(`team-record-vectors\u0000${workspaceId}`).digest("hex").slice(0, 32)}`;
}

// The Iceberg schema of the Team-record lake (design learning-v2-team-record.md 4.9.1).
// One definition, read by the CDK stack and by the broker SQL (tests/unit/team-record/lake-sql.test.ts checks every column the SQL names).
// All names are lowercase: S3 Tables tables with capitals are invisible to Athena (AWS S3 Tables Athena page).
// Field ids are fixed so the partition spec can name its source columns, and so a later column gets the next free id.

export interface LakeColumn {
  readonly id: number;
  readonly name: string;
  /** Iceberg primitive type. `timestamp` is UTC by convention (Athena maps it to timestamp(6)). */
  readonly type: "string" | "int" | "long" | "boolean" | "timestamp";
  readonly required?: boolean;
}

export interface LakeTable {
  readonly name: "events" | "facts" | "outcomes" | "lessons_history";
  readonly columns: readonly LakeColumn[];
  /** The timestamp column of `month(...)` in the partition spec. */
  readonly timeColumn: string;
}

export const LAKE_NAMESPACE = "record";

const c = (id: number, name: string, type: LakeColumn["type"], required = false): LakeColumn => ({ id, name, type, ...(required ? { required: true } : {}) });

export const LAKE_TABLES: readonly LakeTable[] = [
  {
    name: "events",
    timeColumn: "occurred_at",
    columns: [
      c(1, "workspace_id", "string", true),
      c(2, "occurred_at", "timestamp", true),
      c(3, "id", "string", true),
      c(4, "project", "string"),
      c(5, "repo", "string"),
      c(6, "source", "string", true),
      c(7, "source_system", "string", true),
      // sha256 of "<system>\0<source id>": delete-by-source needs no free text in SQL (Athena cannot parameterise DELETE).
      c(8, "source_hash", "string", true),
      c(9, "source_version", "string"),
      c(10, "kind", "string", true),
      c(11, "actor_developer_id", "string"),
      c(12, "trust", "string", true),
      c(13, "audience_kind", "string", true),
      c(14, "audience_scope", "string"),
      c(15, "acl_json", "string"),
      // Present only under retention D. Under C the lake keeps structured metadata only (design 4.3).
      c(16, "text", "string"),
      c(17, "structured_json", "string"),
      c(18, "links_json", "string"),
      c(19, "retention", "string", true),
      c(20, "archived_at", "timestamp", true),
      // sha256 of the actor's source-native id: a person erase must reach people with no developer id (outsiders, unmapped Slack users).
      c(21, "actor_source_hash", "string"),
      // sha256 of the source place (channel, repo, tracker project), set on every row: channel_deleted, repo deleted/transferred and
      // channel_convert_to_private erase by it. Project-wide rows have no ACL scope, so audience_scope cannot do this.
      c(22, "scope_hash", "string", true),
    ],
  },
  {
    name: "facts",
    timeColumn: "created_at",
    columns: [
      c(1, "workspace_id", "string", true),
      c(2, "created_at", "timestamp", true),
      c(3, "id", "string", true),
      c(4, "project", "string"),
      c(5, "kind", "string", true),
      c(6, "text", "string", true),
      c(7, "links_json", "string"),
      c(8, "derived_from_json", "string"),
      c(9, "trust", "string", true),
      c(10, "audience_kind", "string", true),
      c(11, "audience_scope", "string"),
      c(12, "acl_json", "string"),
      c(13, "valid_until", "timestamp"),
      // The scope hash of the sources the note came from, when they share one place; a note from several places is erased by its id.
      c(14, "scope_hash", "string"),
    ],
  },
  {
    name: "outcomes",
    timeColumn: "occurred_at",
    columns: [
      c(1, "workspace_id", "string", true),
      c(2, "occurred_at", "timestamp", true),
      c(3, "id", "string", true),
      c(4, "project", "string"),
      c(5, "task_id", "string", true),
      c(6, "outcome", "string", true),
      c(7, "send_backs", "int"),
      c(8, "merged", "boolean"),
      c(9, "reverted", "boolean"),
      c(10, "files_touched", "int"),
      c(11, "ci_status", "string"),
      c(12, "actor_developer_id", "string"),
    ],
  },
  {
    name: "lessons_history",
    timeColumn: "changed_at",
    columns: [
      c(1, "workspace_id", "string", true),
      c(2, "changed_at", "timestamp", true),
      c(3, "lesson_id", "string", true),
      c(4, "version", "int", true),
      c(5, "project", "string"),
      c(6, "action", "string", true),
      c(7, "status", "string", true),
      c(8, "risk_tier", "int"),
      c(9, "type", "string"),
      c(10, "loaded", "int"),
      c(11, "helpful", "int"),
      c(12, "harmful", "int"),
      c(13, "changed_by", "string"),
    ],
  },
];

export function lakeTable(name: LakeTable["name"]): LakeTable {
  const found = LAKE_TABLES.find((table) => table.name === name);
  if (found === undefined) throw new Error(`team-record lake: unknown table ${name}`);
  return found;
}
