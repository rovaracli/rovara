// The Team record (learning v2, design 2026-10-30 section 4.2): one permission-aware log per workspace of what the team did and decided.
// This file holds only the shapes every lane shares: trust classes, audiences with their permission snapshot, record events, distilled
// facts, source settings, the learning mode and the consumer contracts (record queries, the proposal candidate). `workspaceId` is the org id.
// Keys live in org-scoped-keys.ts; the lesson shapes live in lessons.ts. Every object is strict: an unknown field is a refusal, never ignored.
import { z } from "zod";
import { OrgIdSchema } from "./browser-ids.js";

// ---------------------------------------------------------------------------------------------------------------------------
// Trust and audience

/**
 * Who a piece of text can be believed from, lowest first.
 * - `outsider`: Slack-only people, Slack Connect externals, non-member GitHub users, unknown MCP authors. Never read by a model.
 * - `system`: customer-system fields (CI log text, ticket metadata, bot text). Data, never advice.
 * - `member`: a company member with a live project role.
 * - `rovara`: Rovara's own structured signals (CI result, merge, revert, diff stats). No free text from people.
 */
export const TRUST_CLASSES = ["outsider", "system", "member", "rovara"] as const;
export const TrustClassSchema = z.enum(TRUST_CLASSES);
export type TrustClass = z.infer<typeof TrustClassSchema>;

export const TRUST_RANK: Readonly<Record<TrustClass, number>> = { outsider: 0, system: 1, member: 2, rovara: 3 };

/** The lowest trust of the given classes. Derivation never raises trust: a row built from several inputs carries this. An empty list is `outsider` (fail closed). */
export function minTrust(...classes: readonly TrustClass[]): TrustClass {
  let lowest: TrustClass | undefined;
  for (const trust of classes) if (lowest === undefined || TRUST_RANK[trust] < TRUST_RANK[lowest]) lowest = trust;
  return lowest ?? "outsider";
}

export const RECORD_SOURCES = ["slack", "github", "linear", "jira", "mcp", "rovara"] as const;
/**
 * Where a source keeps its ACL: `place` (a channel, a repository, a Rovara task: one list for everything recorded there) or `item` (a tracker issue or an MCP record carries its
 * OWN list inside one place). The record core files a row's access under the unit named here. A new source does not compile without a choice.
 */
export const RECORD_SOURCE_ACL_UNIT = { slack: "place", github: "place", linear: "item", jira: "item", mcp: "item", rovara: "place" } as const satisfies Record<(typeof RECORD_SOURCES)[number], "item" | "place">;
/** The ACL unit of any source system; a code host plug-in (`codehost:*`) is place-level. */
export const aclUnitOfSource = (source: string): "item" | "place" => (Object.hasOwn(RECORD_SOURCE_ACL_UNIT, source) ? RECORD_SOURCE_ACL_UNIT[source as keyof typeof RECORD_SOURCE_ACL_UNIT] : "place");
export const RecordSourceSchema = z.enum(RECORD_SOURCES);
export type RecordSource = z.infer<typeof RecordSourceSchema>;

/** A code host other than GitHub, through a W6 plug-in (`codehost:gitfarm`). Record ingest consumes plug-in events, not GitHub types. */
export const CodehostSourceSchema = z.string().regex(/^codehost:[a-z][a-z0-9-]{0,40}$/);
export const RecordSystemSchema = z.union([RecordSourceSchema, CodehostSourceSchema]);
export type RecordSystem = z.infer<typeof RecordSystemSchema>;

export const ACL_PRINCIPALS_MAX = 500;
/** The permission snapshot taken at capture. `principals` are source-native ids (Slack user ids, GitHub numeric ids) for private scopes. */
export const AclSnapshotSchema = z.object({
  source: RecordSystemSchema,
  scope: z.string().min(1).max(300),
  principals: z.array(z.string().min(1).max(100)).max(ACL_PRINCIPALS_MAX).optional(),
  groups: z.array(z.string().min(1).max(100)).max(50).optional(),
  capturedAt: z.string().datetime(),
  /** `on_read`: when shown to a person, re-check at the source (cached 15 minutes). */
  liveCheck: z.enum(["none", "on_read"]),
}).strict();
export type AclSnapshot = z.infer<typeof AclSnapshotSchema>;

/** A group id a permission filter reads as "the maintainers of this project": the fail-closed audience of a source whose admin has not said "visible to all project members". */
export const MAINTAINERS_GROUP = "project:maintainers";

/** Who may see a row: every project member, or only the principals the snapshot names. */
export const AudienceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project") }).strict(),
  z.object({ kind: z.literal("restricted"), acl: AclSnapshotSchema }).strict(),
]);
export type Audience = z.infer<typeof AudienceSchema>;

// ---------------------------------------------------------------------------------------------------------------------------
// Retention and learning mode

/** A live only, B process then drop, C raw text 30 days then distilled, D full history (hot 90 days, then the lake). */
export const RETENTION_MODES = ["A", "B", "C", "D"] as const;
export const RetentionModeSchema = z.enum(RETENTION_MODES);
export type RetentionMode = z.infer<typeof RetentionModeSchema>;

export const RECORD_TEXT_MAX_BYTES = 8_192;
export const RECORD_RAW_TEXT_DAYS_C = 30;
export const RECORD_HOT_DAYS = 90;
export const RECORD_FACT_TEXT_MAX = 400;

/** `off`: nothing captured or loaded. `collect`: the record fills, nothing loads. `suggest`: lessons are made, every one needs a person. `on`: tier-0 lessons go live. Pilot default: suggest. */
export const LEARNING_MODES = ["off", "collect", "suggest", "on"] as const;
export const LearningModeSchema = z.enum(LEARNING_MODES);
export type LearningMode = z.infer<typeof LearningModeSchema>;
export const LEARNING_MODE_DEFAULT: LearningMode = "suggest";

// ---------------------------------------------------------------------------------------------------------------------------
// Record events

export const RECORD_EVENT_KINDS = [
  "slack.message", "ticket.created", "ticket.updated", "ticket.comment", "github.pr", "github.review", "github.review_comment", "github.ci", "github.revert",
  "rovara.task", "rovara.plan", "rovara.send_back", "rovara.review", "rovara.human_edit", "rovara.merged", "rovara.closed", "rovara.remembered", "rovara.ask",
] as const;
export const RecordEventKindSchema = z.enum(RECORD_EVENT_KINDS);
export type RecordEventKind = z.infer<typeof RecordEventKindSchema>;

/** The sources a kind may come from. A row whose source does not fit its kind is refused. */
export function recordKindSources(kind: RecordEventKind): "slack" | "ticket" | "codehost" | "rovara" {
  if (kind.startsWith("slack.")) return "slack";
  if (kind.startsWith("ticket.")) return "ticket";
  if (kind.startsWith("github.")) return "codehost";
  return "rovara";
}

function sourceFitsKind(kind: RecordEventKind, source: RecordSystem): boolean {
  switch (recordKindSources(kind)) {
    case "slack": return source === "slack";
    case "ticket": return source === "linear" || source === "jira" || source === "mcp";
    case "codehost": return source === "github" || source.startsWith("codehost:");
    case "rovara": return source === "rovara";
  }
}

const Scalar = z.union([z.string().max(300), z.number().finite(), z.boolean()]);
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength;
const EpochSeconds = z.number().int().nonnegative();
/** A project name (the AgentX name pattern). */
export const RecordProjectSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const DeveloperIdSchema = z.string().min(1).max(100);

export const RecordSourceRefSchema = z.object({
  system: z.string().min(1).max(60),
  id: z.string().min(1).max(300),
  url: z.string().url().max(2_048).optional(),
  parentId: z.string().min(1).max(300).optional(),
  version: z.string().min(1).max(100).optional(),
  /** When this VERSION was made at the source (an edit's time). Versions are ordered by it, never by arrival. Absent: the row's `occurredAt`. */
  versionAt: z.string().datetime().optional(),
  /** The source's own id for the item, for asking the source again (the existence sweep). Absent: `id`. */
  nativeId: z.string().min(1).max(300).optional(),
}).strict();
export type RecordSourceRef = z.infer<typeof RecordSourceRefSchema>;

export const RecordTombstoneSchema = z.object({
  at: z.string().datetime(),
  cause: z.enum(["source_deleted", "person_erased", "project_archived", "excluded"]),
}).strict();
export type RecordTombstone = z.infer<typeof RecordTombstoneSchema>;

/**
 * One source item version (`REC#`). Times in `occurredAt` and `tombstone.at` are ISO instants; the three expiry fields are epoch seconds
 * (the table's TTL unit). Invariants checked here, so no writer can store a row that breaks them:
 * - text is absent under retention A and B, and absent on a `rovara` trust row (it has no free text from people);
 * - `trust` is never above the actor's trust;
 * - the source fits the kind.
 */
export const RecordEventSchema = z.object({
  id: z.string().uuid(),
  workspaceId: OrgIdSchema,
  project: RecordProjectSchema.optional(),
  repo: z.string().min(1).max(200).optional(),
  source: RecordSystemSchema,
  sourceRef: RecordSourceRefSchema,
  /**
   * The place the row came from (`slack:T1/C9`, `github:repo/123`, `rovara:project/web`). Required on every row: the lake erases by place (a deleted channel or
   * repository, a channel that turned private), and a row with no place could not be erased there. A restricted audience's snapshot names the same place.
   */
  scope: z.string().min(1).max(300),
  kind: RecordEventKindSchema,
  occurredAt: z.string().datetime(),
  actor: z.object({ sourceId: z.string().min(1).max(200), developerId: DeveloperIdSchema.optional(), trust: TrustClassSchema }).strict().optional(),
  trust: TrustClassSchema,
  audience: AudienceSchema,
  text: z.string().min(1).refine((value) => utf8Bytes(value) <= RECORD_TEXT_MAX_BYTES, `text exceeds ${String(RECORD_TEXT_MAX_BYTES)} UTF-8 bytes`).optional(),
  structured: z.record(z.string().min(1).max(60), Scalar).refine((value) => Object.keys(value).length <= 40, "at most 40 structured fields").optional(),
  links: z.array(z.string().url().max(2_048)).max(20),
  embeddingRef: z.string().min(1).max(200).optional(),
  embedPending: z.boolean().optional(),
  retention: RetentionModeSchema,
  textExpiresAt: EpochSeconds.optional(),
  hotExpiresAt: EpochSeconds,
  indexExpiresAt: EpochSeconds,
  tombstone: RecordTombstoneSchema.optional(),
}).strict().superRefine((event, context) => {
  if (!sourceFitsKind(event.kind, event.source)) context.addIssue({ code: "custom", path: ["source"], message: "the source does not fit the kind" });
  if (event.text !== undefined && (event.retention === "A" || event.retention === "B")) context.addIssue({ code: "custom", path: ["text"], message: "retention A and B store no text" });
  if (event.text !== undefined && event.trust === "rovara") context.addIssue({ code: "custom", path: ["text"], message: "a rovara-trust row has no free text from people" });
  if (event.text === undefined && event.textExpiresAt !== undefined) context.addIssue({ code: "custom", path: ["textExpiresAt"], message: "no text, no text expiry" });
  if (event.actor !== undefined && TRUST_RANK[event.trust] > TRUST_RANK[event.actor.trust]) context.addIssue({ code: "custom", path: ["trust"], message: "trust is never above the actor's" });
});
export type RecordEvent = z.infer<typeof RecordEventSchema>;

// ---------------------------------------------------------------------------------------------------------------------------
// Facts (the distilled long-term layer)

export const RecordFactSchema = z.object({
  id: z.string().uuid(),
  workspaceId: OrgIdSchema,
  project: RecordProjectSchema.optional(),
  kind: z.enum(["decision", "fact", "note", "open_question"]),
  text: z.string().min(1).max(RECORD_FACT_TEXT_MAX),
  links: z.array(z.string().url().max(2_048)).max(10),
  /** REC ids or source refs (`system:id`) the fact was distilled from. A delete at any of them re-distils or deletes the fact. */
  derivedFrom: z.array(z.string().min(1).max(400)).min(1).max(50),
  /** The lowest trust of the inputs. */
  trust: TrustClassSchema,
  /** The narrowest audience of the inputs. */
  audience: AudienceSchema,
  createdAt: z.string().datetime(),
  validUntil: z.string().datetime().optional(),
  embeddingRef: z.string().min(1).max(200).optional(),
  tombstone: RecordTombstoneSchema.optional(),
}).strict();
export type RecordFact = z.infer<typeof RecordFactSchema>;

// ---------------------------------------------------------------------------------------------------------------------------
// Source settings (`SOURCE#`)

export const SOURCE_HEALTH = ["unknown", "ok", "failing"] as const;
export const SourceConfigSchema = z.object({
  workspaceId: OrgIdSchema,
  project: RecordProjectSchema,
  source: RecordSystemSchema,
  scope: z.string().min(1).max(300),
  enabled: z.boolean(),
  retention: RetentionModeSchema,
  exclude: z.array(z.string().min(1).max(300)).max(200),
  /** Who may see rows from this source when the source gives no ACL. The fallback is maintainers only (fail closed). */
  audienceDefault: z.enum(["maintainers", "project"]),
  /** Public Slack only: the workspace chose to keep "notes with links" (retention B). Without it a Public Slack source reads live only (A). */
  notesOptIn: z.literal(true).optional(),
  lastCursor: z.string().max(500).optional(),
  health: z.enum(SOURCE_HEALTH),
  addedBy: DeveloperIdSchema,
  /** The approval that allowed a less-safe change (a private channel, DMs, or a longer retention) in Enterprise. */
  approval: z.object({ approvalId: z.string().min(1).max(100), by: DeveloperIdSchema, at: z.string().datetime() }).strict().optional(),
  updatedAt: z.string().datetime(),
}).strict();
export type SourceConfig = z.infer<typeof SourceConfigSchema>;

// ---------------------------------------------------------------------------------------------------------------------------
// Consumer contracts (task R9; Ask and proposals build on them)

export const RECORD_SEARCH_LIMIT_MAX = 20;
export const PAST_WORK_LIMIT_MAX = 10;
export const RECORD_FACTS_LIMIT_MAX = 50;
export const RECORD_SNIPPET_MAX = 300;
export const PAST_WORK_PLAN_SUMMARY_MAX = 500;

export const RecordSearchQuerySchema = z.object({
  query: z.string().min(1).max(500),
  kinds: z.array(RecordEventKindSchema).max(RECORD_EVENT_KINDS.length).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  sources: z.array(RecordSystemSchema).max(10).optional(),
  limit: z.number().int().min(1).max(RECORD_SEARCH_LIMIT_MAX).default(10),
}).strict();
export type RecordSearchQuery = z.infer<typeof RecordSearchQuerySchema>;

export const RecordSearchHitSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.union([RecordEventKindSchema, z.literal("fact")]),
  source: RecordSystemSchema,
  occurredAt: z.string().datetime(),
  title: z.string().max(200),
  snippet: z.string().max(RECORD_SNIPPET_MAX),
  link: z.string().url().max(2_048).optional(),
  trust: TrustClassSchema,
  audienceKind: z.enum(["project", "restricted"]),
}).strict();
export type RecordSearchHit = z.infer<typeof RecordSearchHitSchema>;

/**
 * `someHidden` says only that some results are hidden because the caller cannot see their source. It is never a count (a count lets a viewer probe how many private rows
 * match a word), it looks at the best matches only, and it is always false for a shared task.
 */
export const RecordSearchResponseSchema = z.object({ hits: z.array(RecordSearchHitSchema).max(RECORD_SEARCH_LIMIT_MAX), someHidden: z.boolean() }).strict();
export type RecordSearchResponse = z.infer<typeof RecordSearchResponseSchema>;

export const PastWorkQuerySchema = z.object({ query: z.string().min(1).max(500), limit: z.number().int().min(1).max(PAST_WORK_LIMIT_MAX).default(5) }).strict();
export type PastWorkQuery = z.infer<typeof PastWorkQuerySchema>;

/** The Plan 9 `past_work` result shape, extended with the outcome and what was learned. */
export const PastWorkItemSchema = z.object({
  taskId: z.string().min(1).max(100),
  title: z.string().max(200),
  status: z.string().min(1).max(40),
  link: z.string().url().max(2_048).optional(),
  pullRequests: z.array(z.string().url().max(2_048)).max(10),
  planSummary: z.string().max(PAST_WORK_PLAN_SUMMARY_MAX),
  /** The lowest trust of whoever wrote the title and summary. A model in Build is not shown an `outsider` item's words. */
  trust: TrustClassSchema,
  outcome: z.object({ merged: z.boolean(), sendBacks: z.number().int().nonnegative(), reverted: z.boolean() }).strict(),
  lessonsLearned: z.array(z.string().max(160)).max(10),
}).strict();
export type PastWorkItem = z.infer<typeof PastWorkItemSchema>;
export const PastWorkResponseSchema = z.object({ items: z.array(PastWorkItemSchema).max(PAST_WORK_LIMIT_MAX), someHidden: z.boolean() }).strict();
export type PastWorkResponse = z.infer<typeof PastWorkResponseSchema>;

export const RecordFactsQuerySchema = z.object({
  kinds: z.array(RecordFactSchema.shape.kind).max(4).optional(),
  since: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(RECORD_FACTS_LIMIT_MAX).default(20),
}).strict();
export type RecordFactsQuery = z.infer<typeof RecordFactsQuerySchema>;
export const RecordFactsResponseSchema = z.object({ facts: z.array(RecordFactSchema).max(RECORD_FACTS_LIMIT_MAX), someHidden: z.boolean() }).strict();
export type RecordFactsResponse = z.infer<typeof RecordFactsResponseSchema>;

/** The fixed statistics templates. Athena runs a template, never caller SQL; each binds the workspace and project in code. */
export const STATS_TEMPLATES = ["send_backs_by_stage", "tickets_by_component", "ci_failures_by_test", "rovara_merge_rate"] as const;
export const StatsTemplateSchema = z.enum(STATS_TEMPLATES);
export type StatsTemplate = z.infer<typeof StatsTemplateSchema>;

export const PROPOSAL_KINDS = ["bug_cluster", "flaky_test", "repeated_question", "stale_decision", "followup_from_review", "revert_followup"] as const;
/** A Home "offer" built from record patterns (task P1; the scanner is thin). Evidence is project-audience, system trust or better, at least two items. */
export const ProposalCandidateSchema = z.object({
  id: z.string().uuid(),
  workspaceId: OrgIdSchema,
  project: RecordProjectSchema,
  kind: z.enum(PROPOSAL_KINDS),
  title: z.string().min(1).max(100),
  why: z.string().min(1).max(400),
  evidence: z.array(z.string().min(1).max(100)).min(2).max(20),
  dedupeKey: z.string().min(1).max(200),
  existingTickets: z.array(z.string().min(1).max(300)).max(20),
  estimateUsd: z.number().nonnegative().max(10_000),
  valueNote: z.string().max(300).optional(),
  proposer: z.object({ agent: z.literal("rovara-scanner"), version: z.string().min(1).max(40) }).strict(),
  audience: z.literal("project"),
  expiresAt: z.string().datetime(),
}).strict();
export type ProposalCandidate = z.infer<typeof ProposalCandidateSchema>;
