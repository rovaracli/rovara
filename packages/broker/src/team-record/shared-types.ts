// Stand-ins for the shared Team-record contracts (design learning-v2-team-record.md section 4.2).
// The record lane (task R1) owns packages/contracts/src/team-record.ts. Until it lands, the storage lane codes against
// these structural copies. They use the design's names and shapes on purpose, so switching to the contract is an
// import change only. Nothing here is the source of truth: when R1 lands, delete this file and import from contracts.

export type TrustClass = "member" | "rovara" | "system" | "outsider";

export type RetentionMode = "A" | "B" | "C" | "D";

export interface AclSnapshot {
  /** A source system: `slack`, `github`, `linear`, `jira`, `mcp`, `rovara`, or `codehost:<plug-in>` (the contract's `RecordSystem`). */
  source: string;
  scope: string;
  principals?: string[] | undefined;
  groups?: string[] | undefined;
  capturedAt: string;
  liveCheck: "none" | "on_read";
}

export type Audience = { kind: "project" } | { kind: "restricted"; acl: AclSnapshot };

export type FactKind = "decision" | "fact" | "note" | "open_question";

export interface RecordFactLike {
  id: string;
  workspaceId: string;
  project?: string | undefined;
  kind: FactKind;
  text: string;
  links: string[];
  derivedFrom: string[];
  trust: TrustClass;
  audience: Audience;
  createdAt: string;
  validUntil?: string | undefined;
}

/** The subset of a RecordEvent (design 4.2) the storage lane reads. */
export interface RecordEventLike {
  id: string;
  workspaceId: string;
  project?: string | undefined;
  repo?: string | undefined;
  source: string;
  sourceRef: { system: string; id: string; url?: string | undefined; parentId?: string | undefined; version?: string | undefined };
  kind: string;
  /** The source place of the event (slack:T1/C9, github:repo/123, rovara:<project>). R1/R2 must set it on every row: the lake erases by it. */
  scope?: string | undefined;
  occurredAt: string;
  actor?: { sourceId: string; developerId?: string | undefined; trust: TrustClass } | undefined;
  trust: TrustClass;
  audience: Audience;
  text?: string | undefined;
  structured?: Record<string, string | number | boolean | null> | undefined;
  links: string[];
  embeddingRef?: string | undefined;
  retention: RetentionMode;
  tombstone?: { at: string; cause: "source_deleted" | "person_erased" | "project_archived" | "excluded" } | undefined;
}

/** Ids that come from our own systems (workspace, project, developer, record ids), never from people's text. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

export function assertSafeId(value: unknown, what: string): string {
  if (!isSafeId(value)) throw new Error(`team-record: ${what} is not a safe id`);
  return value;
}
