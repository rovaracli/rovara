// Team record ingest (lane "ingest", tasks R5 to R7): the narrow ports the source taps use.
//
// STUB BOUNDARY. The record core (R1 contracts, R2 hot store and pipeline), storage (R3, R4) and learning (L1, L2) lanes build the real
// pieces in parallel. Each source tap here talks only to the interfaces below, and the types mirror design section 4.2 so that, when R1
// lands, this file shrinks to `export type { ... } from "@agentx/contracts"` plus the port interfaces. Nothing in this folder imports from
// another lane's files.
//
// Generic by design (owner rule, 2026-10-30): a tap turns one kind of source event into a `RecordDraft`; it knows nothing about a
// particular customer, code host, tracker or MCP server beyond the small adapters named in each file.

export type TrustClass = "member" | "rovara" | "system" | "outsider";

/** Lowest first: an outsider's words are never raised by anyone who later touched the item. */
const TRUST_RANK: Record<TrustClass, number> = { outsider: 0, system: 1, rovara: 2, member: 3 };
export function lowestTrust(...classes: TrustClass[]): TrustClass {
  return classes.reduce<TrustClass>((lowest, next) => (TRUST_RANK[next] < TRUST_RANK[lowest] ? next : lowest), "member");
}

export type SourceSystem = "slack" | "github" | "linear" | "jira" | "mcp" | "rovara" | `codehost:${string}`;

export interface AclSnapshot {
  source: SourceSystem;
  /** For example `slack:T1/C9`, `github:repo/123`, `mcp:sim/abc`. */
  scope: string;
  /** At most 500 source-native ids, for private scopes. */
  principals?: string[];
  groups?: string[];
  capturedAt: string;
  liveCheck: "none" | "on_read";
}

export type Audience = { kind: "project" } | { kind: "restricted"; acl: AclSnapshot };

/**
 * A group id the permission filter (R2 `canSee`) must read as "maintainers of this project". Used as the fail-closed audience of an MCP or
 * ticket source whose admin has not yet said "visible to all project members" (design 4.4.1, tickets).
 */
export const MAINTAINERS_GROUP = "project:maintainers";

export type RecordKind =
  | "slack.message" | "ticket.created" | "ticket.updated" | "ticket.comment"
  | "github.pr" | "github.review" | "github.review_comment" | "github.ci" | "github.revert"
  | "rovara.task" | "rovara.plan" | "rovara.send_back" | "rovara.review" | "rovara.human_edit"
  | "rovara.merged" | "rovara.closed" | "rovara.remembered" | "rovara.ask";

export type Retention = "A" | "B" | "C" | "D";

export type Scalar = string | number | boolean;

export interface RecordDraft {
  workspaceId: string;
  project?: string;
  repo?: string;
  source: SourceSystem;
  /** `system` names the source instance (a Slack team, a repo host, an MCP server id); `id` and `version` make the write idempotent. */
  sourceRef: { system: string; id: string; url?: string; parentId?: string; version: string; /** The source's own id, for asking the source again (existence sweep). Absent: the same as `id`. */ nativeId?: string };
  kind: RecordKind;
  occurredAt: string;
  actor?: { sourceId: string; developerId?: string; trust: TrustClass };
  /** The lowest trust of everything in the row. */
  trust: TrustClass;
  audience: Audience;
  /** Raw-ish text from a person or system. Already control-stripped and redacted by the tap; the pipeline (R2) redacts again. At most 8 KB. Absent under retention A. */
  text?: string;
  structured?: Record<string, Scalar>;
  /** Permalinks only. */
  links: string[];
  retention: Retention;
}

export type IngestOutcome = { status: "stored" | "duplicate" | "queued" } | { status: "refused"; reason: string };

export type TombstoneCause = "source_deleted" | "person_erased" | "project_archived" | "excluded";

/**
 * R2 owns the real sink (idempotent write, retention routing, ACL snapshot rules).
 *
 * CONTRACT the taps rely on (R2 must implement it, and `FakeSink` in the tests does):
 *  - `put` is idempotent on (workspace, source, system, id, version);
 *  - a `put` of a NEW version of an item that already exists replaces the earlier versions' text, vectors and derived facts: text a person edited
 *    away is not kept (design 4.4.3, "a delete at the source deletes everywhere" covers an edit's removed words);
 *  - a tombstone hides at once, and a tombstone for an item that was never stored (retention B) still hides the facts derived from it.
 *
 * In production the taps are given `createQueuedSink` (queue.ts): every call is a durable, retried queue message, so a record outage never loses a delete.
 */
export interface RecordSinkPort {
  put(draft: RecordDraft): Promise<IngestOutcome>;
  /**
   * Hides at once and queues the delete of rows, vectors and derived facts. `sourceIds` limits it to those items; `scope` takes everything in that scope
   * (a deleted channel or repository). A scope matches itself and every scope under it: `slack:T1` covers `slack:T1/C9`.
   */
  tombstone(input: { workspaceId: string; system: string; sourceIds?: readonly string[]; scope?: string; cause: TombstoneCause }): Promise<{ hidden: number }>;
  /** Join and leave events for a private scope: only the principals change. */
  changePrincipals(input: { workspaceId: string; scope: string; add?: readonly string[]; remove?: readonly string[]; at: string }): Promise<void>;
  /** A channel that became private or public: every row of the scope takes the new audience. */
  replaceScopeAudience(input: { workspaceId: string; scope: string; audience: Audience; at: string }): Promise<void>;
}

/** Retention B: the text is held in memory for the distiller only (R8); the pipeline stores no raw text. */
export interface TransientDistillerPort {
  distillTransient(draft: RecordDraft & { text: string }): Promise<{ accepted: boolean }>;
}

export interface SourceConfig {
  enabled: boolean;
  retention: Retention;
  /** Source-native ids (user ids, logins, labels, project keys) whose items are never recorded. */
  exclude: readonly string[];
  /** `project`: the admin said every project member may see it. `maintainers`: the fail-closed default for ticket and MCP sources. */
  audienceDefault: "project" | "maintainers";
  project?: string;
}

/** `SOURCE#` rows (R2). `undefined` means no row: the tap records nothing (fail closed). */
export interface SourceConfigPort {
  get(workspaceId: string, source: SourceSystem, scope: string): Promise<SourceConfig | undefined>;
}

/** The mode switch (Off, Collect, Suggest, On) and the company lock. Off means every tap returns at once. */
export interface CaptureModePort {
  captureOn(workspaceId: string, project: string | undefined): Promise<boolean>;
}

/**
 * Maps a source identity to a developer and a trust class (`developer/identities.ts`, `readStandingChecked`). An identity that is not mapped
 * to a company member with a live project role is `outsider`; it never matches a private ACL.
 */
export interface ActorResolverPort {
  resolve(input: { workspaceId: string; project: string | undefined; system: string; sourceId: string; isBot?: boolean }): Promise<{ developerId?: string; trust: TrustClass }>;
  resolveDeveloper(input: { workspaceId: string; project: string | undefined; developerId: string }): Promise<{ trust: TrustClass }>;
}

export type TapLog = (event: string, fields: Readonly<Record<string, string | number | boolean>>) => void;

export type Edition = "enterprise" | "public";

/** An action that must happen at most once however often a delivery is repeated (a redelivery, or two deliveries of the same revert). R2 backs it with a conditional write. */
export interface OnceClaimPort {
  claim(key: string): Promise<boolean>;
  /** Gives the claim back after a failure so a retry can do the work. */
  release(key: string): Promise<void>;
}

/** The nightly distiller and the reflector (learning lane) are told a task ended. Optional everywhere: nothing here depends on it being set. */
export interface ReflectorTriggerPort {
  taskEnded(input: { workspaceId: string; project: string; taskId: string; outcome: string }): Promise<void>;
}

/** Track record (TR3): a reverted Rovara PR's samples are re-scored `not_held`. */
export interface TrackRecordPort {
  markNotHeld(input: { workspaceId: string; project: string; taskId: string; reason: "reverted"; revertRef: string }): Promise<void>;
}

/**
 * Lets the code-host taps find Rovara's own pull requests. Comes from the task records (workflow.pullRequests, `findLinkedGithubWorkflowPullRequest`).
 * Only a pull request this returns is a Rovara PR: a branch name alone proves nothing.
 */
export interface RovaraPullRequestIndexPort {
  byNumber(input: { workspaceId: string; host: string; repo: string; number: number }): Promise<RovaraPullRequest | undefined>;
  byMergeCommit(input: { workspaceId: string; host: string; repo: string; sha: string }): Promise<RovaraPullRequest | undefined>;
}

export interface RovaraPullRequest {
  taskId: string;
  project: string;
  number: number;
  url: string;
  /** The last commit Rovara itself pushed to the pull request's branch. */
  candidateHeadSha: string;
  mergeCommitSha?: string;
}

/** The dedupe key for a write: the source item and its version. */
export function idempotencyKey(draft: Pick<RecordDraft, "workspaceId" | "source" | "sourceRef">): string {
  return `${draft.workspaceId}|${draft.source}|${draft.sourceRef.system}|${draft.sourceRef.id}|${draft.sourceRef.version}`;
}
