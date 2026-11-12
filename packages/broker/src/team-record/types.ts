// The record core's own types and ports (tasks R2, R9, D1). The shapes of rows are the contracts in `contracts/src/team-record.ts`; this file holds what the
// broker modules of the record lane share: the draft a source tap hands the pipeline, the table handle, the caller, and the ports other lanes provide.
// Every port is a narrow interface so a lane that has not landed (vectors, the distiller, the identity link) is a stub, never a dependency.
import type { OrgId, ProjectRole, TrustClass } from "@rovara-code/contracts";
import type { AclSnapshot, Audience } from "@agentx/cloud-contracts";
import type { RecordEventKind, RecordSystem, RetentionMode } from "@agentx/cloud-contracts";

/** The State-table style handle: a document client and the table's name. The TeamRecord table is its own table (design 4.2). */
export interface TeamRecordTable {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
}

export type Scalar = string | number | boolean;

/**
 * What a source tap hands the pipeline for one item version. Structurally the same as the ingest lane's `RecordDraft`, plus an optional `scope`
 * (the scope the row belongs to when its audience is the whole project; a restricted audience carries its own scope in the snapshot).
 * `workspaceId` is the org id; anything else is refused.
 */
export interface RecordDraft {
  workspaceId: string;
  project?: string;
  repo?: string;
  source: RecordSystem;
  /** `system` names the source instance (a Slack team, a code host, an MCP server id); `id` and `version` make the write idempotent. */
  sourceRef: { system: string; id: string; url?: string; parentId?: string; version: string; versionAt?: string; nativeId?: string; order?: number };
  kind: RecordEventKind;
  occurredAt: string;
  actor?: { sourceId: string; developerId?: string; trust: TrustClass };
  trust: TrustClass;
  audience: Audience;
  text?: string;
  structured?: Record<string, Scalar>;
  links: string[];
  retention: RetentionMode;
  scope?: string;
  /**
   * Where the words came from when they are not the row's own source: a Rovara row made from a Slack message (`ask:`, a remembered thread comment) says `slack`, so
   * the Slack rules (Public: no text kept) follow the text into the Rovara row.
   */
  origin?: "slack";
  /** The trust of every author whose own words are in the text (a ticket's creator and its last editor). The row takes the lowest. */
  pieceTrusts?: TrustClass[];
  /** The trust of every quoted or forwarded author the tap could identify. Without it, quoted text, forwarded text or attachments count as an outsider's. */
  quotedTrusts?: TrustClass[];
  /** The message carries attachments or shared messages from other authors. Without `quotedTrusts` they count as an outsider's. */
  hasAttachments?: boolean;
}

export type IngestOutcome = { status: "stored" | "duplicate" } | { status: "refused"; reason: string };

export type TombstoneCause = "source_deleted" | "person_erased" | "project_archived" | "excluded";

export type Edition = "enterprise" | "public";

/** A fixed-vocabulary log line; never text from a person or an error. */
export type RecordLog = (event: string, fields: Readonly<Record<string, string | number | boolean>>) => void;

/** Metadata a vector carries (the filterable cut, design 4.4.2). Mirrors the storage lane's `VectorMetadata`. */
export interface RecordVectorMetadata {
  audience_kind: "project" | "restricted";
  scope: string;
  project: string;
  trust: TrustClass;
  tier: "hot" | "lake";
  kind: string;
  lesson_tier?: 0 | 1 | 2;
  ref: string;
}
export interface RecordVectorItem { key: string; vector: number[]; metadata: RecordVectorMetadata }
export interface RecordVectorBatchResult { done: number; failed: string[] }
/** The vector index the record lane writes to and deletes from (the storage lane's `VectorIndex` satisfies it). */
export interface RecordVectorPort {
  readonly dimension: number;
  put(items: RecordVectorItem[]): Promise<RecordVectorBatchResult>;
  delete(keys: string[]): Promise<RecordVectorBatchResult>;
}
/** The embedding client (the storage lane's `Embedder`). Throws when it cannot embed; the row is then stored with `embedPending`. */
export interface RecordEmbedder {
  embed(text: string, purpose?: "document" | "query"): Promise<number[]>;
  /** The embedding spec the vectors are made with (contracts `TEAM_RECORD_EMBEDDER.spec`); recorded on every row embedded, so a row with a vector of another spec is found and embedded again. */
  readonly spec?: string;
  /** Like `embed`, saying whether the text was cut to fit the model. Optional so a test double need not have it; a row embedded without it is recorded as not cut. */
  embedWithInfo?(text: string, purpose?: "document" | "query", call?: { deadline?: number }): Promise<{ vector: number[]; truncated: boolean }>;
  /** Several texts in one call to the embedder (the re-embed job batches up to 16). Optional so a test double need not have it; without it the job embeds one row per call. */
  embedManyWithInfo?(texts: readonly string[], purpose?: "document" | "query", call?: { deadline?: number }): Promise<Array<{ vector: number[]; truncated: boolean }>>;
}

/** The identities a person has at each source: source-native ids and the groups they belong to, per source kind. An unmapped person has none, and matches nothing. */
export interface CallerIdentities {
  ids: Readonly<Record<string, readonly string[]>>;
  groups: Readonly<Record<string, readonly string[]>>;
}

/** A person (or a private task's owner) as the permission filter sees them. `projectRole` comes from `effectiveProjectRole`; undefined means no access at all. */
export interface RecordCaller {
  orgId: OrgId;
  developerId: string;
  projectRole: ProjectRole | undefined;
  identities: CallerIdentities;
}

/**
 * Whose view a read answers. `shared`: the model context of a shared task, which sees only project-wide rows. `caller`: a person, or the owner of a private task
 * (what the owner sees).
 */
export type ReadAudience = { kind: "shared"; orgId: OrgId; projectRole?: undefined } | { kind: "caller"; caller: RecordCaller };

/** Re-checks at the source that the person may still see a scope (an `on_read` snapshot). Throws or returns false: the row stays hidden. */
export type LiveAclCheck = (input: { caller: RecordCaller; acl: AclSnapshot }) => Promise<boolean>;

export type { AclSnapshot };

/** What reads must hide while queued work is unfinished: whole places, and individual source items (`teamRecordSourceHash(system, sourceId)`). */
export interface PendingHides {
  scopes: ReadonlySet<string>;
  sourceHashes: ReadonlySet<string>;
}
