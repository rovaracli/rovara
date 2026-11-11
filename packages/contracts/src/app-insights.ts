// Insights (srv/insights-reads): what the browser reads and sends for the Insights screen, `/v1/app/insights*` and `/v1/app/org/insights-access`. Strict shapes for what the server answers, and `forwardReader`
// readers (an enum value a newer server adds reads as "unknown" instead of failing the page) for what the app reads. Words, ids, counts and dollar figures; never a task's content on a row the reader cannot
// open: a metadata row carries no title, reason or link. The per-person spend list `byPerson` exists ONLY in an answer to an owner or admin: for everyone else the key is absent (not empty).
// Browser-safe: nothing here imports a Node module. Design: the Insights API brief (briefs/insights-api.md), owner decisions 12, 32, 33 and 91.
import { z } from "zod";
import { forwardReader } from "./forward-reader.js";

export const INSIGHTS_STUCK_LIMIT_MAX = 100;
export const INSIGHTS_STUCK_LIMIT_DEFAULT = 25;
export const INSIGHTS_SHIPPED_WEEKS_MAX = 26;
export const INSIGHTS_FLOW_DAYS = [7, 30, 90] as const;
/** How many months of work events the capture keeps for the aggregates (design section 3). */
export const INSIGHTS_RETENTION_MONTHS = 13;
/** Below this many items a flow figure comes with `enough: false`. */
export const INSIGHTS_FLOW_MIN_SAMPLES = 5;
/** The sources a stuck list does NOT read yet, in fixed words; the list shrinks as sources are added. */
export const INSIGHTS_STUCK_NOT_COVERED = ["change_approvals", "plan_reviews", "merge_readiness", "handoff_blockers"] as const;
export const INSIGHTS_STUCK_SOURCES = ["sessions", "spend_requests"] as const;
/** What a metadata row says in place of its content (design section 8). */
export const INSIGHTS_METADATA_ROW_WORDS = "You can see that it exists and its state, not its content.";

const Iso = z.string().datetime();
const Label = z.string().min(1).max(200);
const Count = z.number().int().nonnegative().max(1_000_000_000);
const Hours = z.number().finite().nonnegative().max(10_000_000);
const Usd = z.number().finite().nonnegative().max(1_000_000_000);
const DeveloperId = z.string().regex(/^[a-f0-9]{64}$/u);
const ItemId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u);
const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u);

/** A person: the display name is looked up live ("Unknown" when it cannot be read). */
export const InsightsPersonSchema = z.object({ id: DeveloperId, name: Label }).strict();

export const INSIGHTS_PANEL_STATUSES = ["ready", "collecting", "unavailable"] as const;
const PanelStatus = z.enum(INSIGHTS_PANEL_STATUSES);

/** What a list does NOT include, in fixed words, like the Waiting page's "Partial coverage" line. */
export const InsightsCoverageSchema = z.object({
  sources: z.array(z.enum(INSIGHTS_STUCK_SOURCES)).max(10),
  notCovered: z.array(z.enum(INSIGHTS_STUCK_NOT_COVERED)).max(10),
  /** True when a source failed this time (skipped and logged, never silent). */
  partial: z.boolean(),
  /** True when the live index cap was reached. */
  truncated: z.boolean(),
}).strict();

export const INSIGHTS_NEXT_ACTOR_KINDS = ["person", "group", "role", "rovara", "unknown"] as const;
export const INSIGHTS_NEXT_ACTOR_ROLES = ["approver", "reviewer", "owner", "maintainer", "admin", "collaborator"] as const;
/** Who the item waits on. `name` is a person's or a group's: shown on every row (decision 91), absent for a role, Rovara or unknown. */
export const InsightsNextActorSchema = z.object({
  kind: z.enum(INSIGHTS_NEXT_ACTOR_KINDS),
  name: Label.optional(),
  role: z.enum(INSIGHTS_NEXT_ACTOR_ROLES).optional(),
}).strict();

export const INSIGHTS_VIA = ["owner", "admin", "viewer_grant", "maintainer"] as const;
export const INSIGHTS_OVERVIEW_ROLES = ["owner", "admin", "member"] as const;
export const InsightsScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("company") }).strict(),
  z.object({ kind: z.literal("projects"), projects: z.array(Label).max(1000) }).strict(),
]);

export const InsightsOverviewSchema = z.object({
  enabled: z.boolean(),
  viewer: z.object({
    role: z.enum(INSIGHTS_OVERVIEW_ROLES),
    via: z.array(z.enum(INSIGHTS_VIA)).max(4),
    scope: InsightsScopeSchema,
    contentLevel: z.enum(["full_where_readable", "metadata_only_elsewhere"]),
    canSeePerPerson: z.boolean(),
  }).strict(),
  panels: z.object({
    stuck: z.object({ status: z.enum(["ready", "unavailable"]), coverage: InsightsCoverageSchema }).strict(),
    shipped: z.object({ status: PanelStatus, collectingSince: Iso.nullable() }).strict(),
    spend: z.object({ status: z.literal("ready"), outcomesStatus: PanelStatus }).strict(),
    flow: z.object({ status: PanelStatus, collectingSince: Iso.nullable() }).strict(),
  }).strict(),
  capture: z.object({ workEvents: z.enum(["on", "off"]), since: Iso.nullable(), retentionMonths: Count }).strict(),
  asOf: Iso,
}).strict();

export const INSIGHTS_BLOCKERS = ["decision", "approval", "spend", "review", "merge", "budget", "failure", "setup", "unknown"] as const;
const STATES = ["understanding", "planning", "reviewing_design", "building", "checking", "needs_you", "paused_budget", "ready_to_merge", "merged", "closed", "failed", "finished_run", "unknown"] as const;

export const InsightsStuckItemSchema = z.object({
  /**
   * On a row with `visibility: "full"`: the session id (`ses_...`, the same id every surface uses). On a METADATA row (the reader cannot open the work, and every budget request that belongs to no
   * session): an OPAQUE id (`itm_` and hex), stable and different in every company, that names nothing elsewhere. It only tells rows apart: never build a link, a lookup or a session id from it.
   */
  itemId: ItemId,
  /** The project's name, or `No project` for work that has none (not a valid project name, so it cannot be mistaken for one). */
  project: Label,
  blocker: z.enum(INSIGHTS_BLOCKERS),
  state: z.enum(STATES),
  /** Fixed words, never a raw code and never a reason sentence. */
  stateWords: Label,
  nextActor: InsightsNextActorSchema,
  /** Decision 91: who owns the work, shown on every row (metadata rows too). Absent when the work has no owner. */
  owner: InsightsPersonSchema.optional(),
  since: Iso,
  /** `last_update` until a state-entered time exists (E-61 stateSince). */
  sinceKind: z.enum(["state", "last_update"]),
  ageHours: Hours,
  visibility: z.enum(["full", "metadata"]),
  // Only when `visibility` is "full": a row the reader cannot open has none of these.
  title: z.string().min(1).max(500).optional(),
  reason: z.string().min(1).max(2000).optional(),
  link: z.string().max(2048).optional(),
}).strict();

const CountsByWord = z.record(z.string().min(1).max(40), Count);
export const InsightsStuckSchema = z.object({
  status: z.enum(["ready", "unavailable"]),
  asOf: Iso,
  coverage: InsightsCoverageSchema,
  summary: z.object({ total: Count, over24h: Count, over72h: Count, byNextActorKind: CountsByWord, byBlocker: CountsByWord }).strict(),
  items: z.array(InsightsStuckItemSchema).max(INSIGHTS_STUCK_LIMIT_MAX),
  next: z.string().min(1).max(500).optional(),
}).strict();

export const InsightsShippedSchema = z.object({
  status: PanelStatus,
  collectingSince: Iso.nullable(),
  weeks: z.array(z.object({
    weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    shipped: Count,
    byProject: z.array(z.object({
      project: Label,
      shipped: Count,
      items: z.array(z.object({
        itemId: ItemId,
        mergedAt: Iso,
        visibility: z.enum(["full", "metadata"]),
        title: z.string().min(1).max(500).optional(),
        prs: z.array(z.object({ repository: Label, number: z.number().int().positive(), url: z.string().max(2048) }).strict()).max(50).optional(),
        /** Linked tickets (a Linear or Jira key and, when known, its link). Only on a "full" item. */
        tickets: z.array(z.object({ key: Label, url: z.string().max(2048).optional() }).strict()).max(50).optional(),
      }).strict()).max(20),
    }).strict()).max(1000),
  }).strict()).max(INSIGHTS_SHIPPED_WEEKS_MAX),
}).strict();

export const InsightsSpendSchema = z.object({
  month: Month,
  status: z.literal("ready"),
  scope: z.enum(["company", "projects"]),
  /** Company scope only: absent for a maintainer. `committedUsd` includes `spentUsd`; held = committed - spent; available = limit - committed. */
  totals: z.object({ spentUsd: Usd, committedUsd: Usd, limitUsd: Usd.optional() }).strict().optional(),
  byProject: z.array(z.object({
    project: Label,
    spentUsd: Usd,
    committedUsd: Usd,
    limitUsd: Usd.optional(),
    /** Distinct payers in the month; null until the per-project rollup exists. */
    people: Count.nullable(),
    /** Null until work events exist. */
    shipped: Count.nullable(),
    costPerShippedUsd: Usd.nullable(),
  }).strict()).max(1000),
  /** OWNER OR ADMIN ONLY: the key is absent (not empty) for everyone else, so a client cannot draw a person column by mistake. */
  byPerson: z.array(z.object({ developerId: DeveloperId, name: Label, spentUsd: Usd, limitUsd: Usd.optional() }).strict()).max(10_000).optional(),
  outcomes: z.object({ status: PanelStatus }).strict(),
}).strict();

const FlowRange = z.object({ median: Hours, p90: Hours }).strict();
const FlowFigures = {
  items: Count,
  enough: z.boolean(),
  cycleTimeHours: FlowRange.optional(),
  reviewWaitHours: FlowRange.optional(),
  waitByNextActor: z.array(z.object({ kind: z.enum(INSIGHTS_NEXT_ACTOR_KINDS), medianHours: Hours }).strict()).max(20).optional(),
  failureRate: z.object({ failed: Count, of: Count }).strict().optional(),
  retryRate: z.object({ retried: Count, of: Count }).strict().optional(),
  sendBackRate: z.object({ sentBack: Count, of: Count }).strict().optional(),
};
export const InsightsFlowFiguresSchema = z.object(FlowFigures).strict();
export const InsightsFlowSchema = z.object({
  days: z.union([z.literal(7), z.literal(30), z.literal(90)]),
  status: PanelStatus,
  collectingSince: Iso.nullable(),
  minSamples: Count,
  /** Absent while the figures are not collected (status is not "ready"): never a block of zeros. */
  company: InsightsFlowFiguresSchema.optional(),
  byProject: z.array(z.object({ project: Label, ...FlowFigures }).strict()).max(1000),
}).strict();

export const InsightsAccessSchema = z.object({
  /** `grantedBy` comes from the audit ledger and is ABSENT when it cannot be read (the date is always there): a name is never guessed. */
  viewers: z.array(z.object({ person: InsightsPersonSchema, grantedBy: InsightsPersonSchema.optional(), grantedAt: Iso }).strict()).max(10_000),
  /** Members who could be given access: not an owner, an admin or an Auditor, and not already a viewer. */
  eligibleCount: Count,
}).strict();

/** The grant's POST body: strict JSON from a live browser session. `requestId` makes it repeatable; the same id with another body is refused. */
export const InsightsAccessBodySchema = z.object({
  action: z.enum(["grant", "revoke"]),
  requestId: z.string().uuid(),
  developerId: DeveloperId,
}).strict();
export type InsightsAccessBody = z.infer<typeof InsightsAccessBodySchema>;

export const InsightsOverviewReaderSchema = forwardReader(InsightsOverviewSchema);
export const InsightsStuckReaderSchema = forwardReader(InsightsStuckSchema);
export const InsightsShippedReaderSchema = forwardReader(InsightsShippedSchema);
export const InsightsSpendReaderSchema = forwardReader(InsightsSpendSchema);
export const InsightsFlowReaderSchema = forwardReader(InsightsFlowSchema);
export const InsightsAccessReaderSchema = forwardReader(InsightsAccessSchema);

export type InsightsOverview = z.infer<typeof InsightsOverviewSchema>;
export type InsightsStuck = z.infer<typeof InsightsStuckSchema>;
export type InsightsStuckItem = z.infer<typeof InsightsStuckItemSchema>;
export type InsightsShipped = z.infer<typeof InsightsShippedSchema>;
export type InsightsSpend = z.infer<typeof InsightsSpendSchema>;
export type InsightsFlow = z.infer<typeof InsightsFlowSchema>;
export type InsightsAccess = z.infer<typeof InsightsAccessSchema>;
export type InsightsCoverage = z.infer<typeof InsightsCoverageSchema>;
export type InsightsNextActor = z.infer<typeof InsightsNextActorSchema>;
