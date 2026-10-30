// Storage constants of the Team record that both the infrastructure (infra/lib/team-record-*.ts) and the broker
// (packages/broker/src/team-record) must agree on. Task R3/R4 of design learning-v2-team-record.md.
// Kept apart from team-record.ts (task R1, record lane) so the two lanes do not edit one file.
import { createHash } from "node:crypto";

/** Titan Text Embeddings V2 default (design 4.5.2). The index dimension is fixed when the index is created. */
export const VECTOR_DIMENSION_DEFAULT = 1024;

/** The only non-filterable metadata key of a Team-record vector: the id of the record it stands for. */
export const NON_FILTERABLE_VECTOR_KEYS = ["ref"] as const;

export type EmbeddingFamily = "titan-v2" | "cohere";

/** Only models the design allows are accepted: Titan Text Embeddings V2 and Cohere Embed (design 4.9.1), with or without a region prefix. */
export function teamRecordEmbeddingFamily(modelId: string): EmbeddingFamily {
  if (/^(?:[a-z]{2}\.)?amazon\.titan-embed-text-v2(?::\d+)?$/.test(modelId)) return "titan-v2";
  if (/^(?:[a-z]{2}\.)?cohere\.embed-[a-z0-9.-]+(?::\d+)?$/.test(modelId)) return "cohere";
  throw new Error("team-record: embedding model is not supported");
}

const SAFE_WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** One index per workspace: `ws-` plus 32 hex characters of a hash, so the name is valid for S3 Vectors and reveals nothing. */
export function teamRecordVectorIndexName(workspaceId: string): string {
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
