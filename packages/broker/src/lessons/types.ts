// Learning v2 lessons: the broker-side data model (design §4.2). The record-core lane (R1) owns the shared contract file for the Team record; this
// file holds what the learning lane needs so it can build against the design now. Names follow the design, so R1 can replace the schemas in place.
// All schemas are strict: a field this build does not know (a tool, a grant, a budget) is refused, which is control C6.
import { z } from "zod";
import { LessonStageSchema, LessonTypeSchema, CodeCitationSchema, type LessonStage, type LessonType } from "@agentx/contracts";

export type { LessonStage, LessonType };

export const TRUST_CLASSES = ["member", "rovara", "system", "outsider"] as const;
export type TrustClass = (typeof TRUST_CLASSES)[number];
/** Higher is more trusted. `outsider` is the floor, and the answer for anything unknown. */
const TRUST_RANK: Record<TrustClass, number> = { outsider: 0, system: 1, rovara: 2, member: 3 };
export const TrustClassSchema = z.enum(TRUST_CLASSES);

/** The lowest trust of the inputs. An empty list is `outsider`: derivation never raises trust, and nothing is trusted by default. */
export function minTrust(list: readonly TrustClass[]): TrustClass {
  let lowest: TrustClass | undefined;
  for (const trust of list) if (lowest === undefined || TRUST_RANK[trust] < TRUST_RANK[lowest]) lowest = trust;
  return lowest ?? "outsider";
}
export const trustAtLeast = (trust: TrustClass, floor: TrustClass): boolean => TRUST_RANK[trust] >= TRUST_RANK[floor];

export const AclSnapshotSchema = z.object({
  source: z.enum(["slack", "github", "linear", "jira", "mcp", "rovara"]), scope: z.string().min(1).max(300),
  principals: z.array(z.string().max(100)).max(500).optional(), groups: z.array(z.string().max(100)).max(100).optional(),
  capturedAt: z.string().max(40), liveCheck: z.enum(["none", "on_read"]),
}).strict();
export type AclSnapshot = z.infer<typeof AclSnapshotSchema>;
export const AudienceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project") }).strict(),
  z.object({ kind: z.literal("restricted"), acl: AclSnapshotSchema }).strict(),
]);
export type Audience = z.infer<typeof AudienceSchema>;

/**
 * The narrowest audience of the inputs: any restricted input makes the result restricted. Two different restricted sources give an ACL that holds only
 * what both allow (principals and groups intersect; the scope names both). An empty list is the project audience.
 */
export function narrowestAudience(list: readonly Audience[]): Audience {
  const restricted = list.flatMap((a) => (a.kind === "restricted" ? [a.acl] : []));
  const first = restricted[0];
  if (first === undefined) return { kind: "project" };
  const intersect = (lists: Array<readonly string[] | undefined>): string[] | undefined => {
    const present = lists.filter((l): l is readonly string[] => l !== undefined);
    if (present.length === 0) return undefined;
    // A source with no list constrains nothing the others do not; a source with an empty list allows nobody.
    return present.reduce<string[]>((acc, l, i) => (i === 0 ? [...new Set(l)] : acc.filter((x) => l.includes(x))), []);
  };
  const scopes = [...new Set(restricted.map((a) => a.scope))].sort();
  const principals = intersect(restricted.map((a) => a.principals));
  const groups = intersect(restricted.map((a) => a.groups));
  return {
    kind: "restricted",
    acl: {
      source: first.source, scope: scopes.join("+").slice(0, 300), ...(principals === undefined ? {} : { principals }), ...(groups === undefined ? {} : { groups }),
      capturedAt: restricted.map((a) => a.capturedAt).sort()[0] ?? first.capturedAt,
      liveCheck: restricted.some((a) => a.liveCheck === "on_read") ? "on_read" : "none",
    },
  };
}

/** The asker's linked identities, for ACL checks. An unmapped identity is simply absent, and matches nothing (fail closed). */
export interface IdentitySet { principals: readonly string[]; groups: readonly string[] }
/** Whether an identity set satisfies a restricted ACL. An ACL with no principals and no groups is satisfied by nobody. */
export function satisfiesAcl(identity: IdentitySet, acl: AclSnapshot): boolean {
  const byPrincipal = (acl.principals ?? []).some((p) => identity.principals.includes(p));
  const byGroup = (acl.groups ?? []).some((g) => identity.groups.includes(g));
  return byPrincipal || byGroup;
}

export const LESSON_STATUSES = ["candidate", "pending", "active", "stale", "retired", "rejected", "expired", "withdrawn"] as const;
export type LessonStatus = (typeof LESSON_STATUSES)[number];
export type Tier = 0 | 1 | 2;

export const SPAN_KINDS = ["intent", "plan", "send_back", "review_finding", "ci_failure", "human_edit", "outcome", "loaded_lesson", "remembered", "close_reason", "fact"] as const;
export type SpanKind = (typeof SPAN_KINDS)[number];

const PrCitationSchema = z.object({ kind: z.literal("pr"), url: z.string().url().max(300).refine((u) => u.startsWith("https://"), "https only") }).strict();
const RecordCitationSchema = z.object({ kind: z.literal("record"), eventId: z.string().min(1).max(100) }).strict();
const TaskCitationSchema = z.object({ kind: z.literal("task"), taskId: z.string().min(1).max(100) }).strict();
export const LessonCitationSchema = z.discriminatedUnion("kind", [CodeCitationSchema, PrCitationSchema, RecordCitationSchema, TaskCitationSchema]);
export type LessonCitation = z.infer<typeof LessonCitationSchema>;
export type CodeCitationValue = z.infer<typeof CodeCitationSchema>;

export const LessonScopeSchema = z.object({
  repos: z.array(z.string().min(1).max(200)).max(10).optional(),
  paths: z.array(z.string().min(1).max(200)).max(20).optional(),
  languages: z.array(z.string().min(1).max(40)).max(10).optional(),
}).strict();
export type LessonScope = z.infer<typeof LessonScopeSchema>;

/** The text fields the reflector writes; also what a person may edit. */
export const LessonTextSchema = z.object({
  title: z.string().min(1).max(80), description: z.string().max(160), body: z.string().min(1).max(600),
}).strict();

/** What the reflector may propose. Strict: there is no field for tools, grants, commands, domains, models, budgets or approvals. */
export const LessonCandidateSchema = z.object({
  type: LessonTypeSchema, ...LessonTextSchema.shape, scope: LessonScopeSchema,
  stages: z.array(LessonStageSchema).min(1).max(5),
  citations: z.array(LessonCitationSchema).max(6),
  evidenceSpanIds: z.array(z.string().regex(/^S\d{1,4}$/u)).min(1).max(12),
}).strict();
export type LessonCandidate = z.infer<typeof LessonCandidateSchema>;
export const ReflectorOutputSchema = z.object({ candidates: z.array(z.unknown()).max(20) }).strict();

export const LessonProvenanceSchema = z.object({
  sourceEvents: z.array(z.string().max(100)).max(50), sourceKinds: z.array(z.enum(SPAN_KINDS)).max(20),
  /** Developer ids of the members whose words or edits the lesson comes from. */
  authors: z.array(z.string().max(100)).max(20),
  /**
   * People who rewrote the text with "Edit and approve". Not authors: the author rule (who may approve alone) is about the evidence, so a one-tap edit keeps working. Erasure counts an editor as a writer
   * of the lesson (it is hard-deleted). Absent on a lesson edited before this field: read as none.
   */
  editors: z.array(z.string().max(100)).max(20).optional(),
  /** Independent tasks that support the lesson (one id per task). */
  supportTasks: z.array(z.string().max(100)).max(50),
  /** Where the evidence came from, for per-source spike detection: `member:<id>`, `slack:<channel>`, `ci`, or a span kind. */
  sources: z.array(z.string().max(120)).max(20),
  /** Every source present in the reflector's input (not only the cited ones), for spike detection and holds. Never used for corroboration. */
  inputSources: z.array(z.string().max(120)).max(100),
  /** Set by code, from structured facts of the task (a member send-back with its reason, a revert, a CI failure recorded by Rovara), never from what the model cited. */
  measured: z.boolean(),
  minTrust: TrustClassSchema, audience: AudienceSchema, reflectorRun: z.string().max(100), model: z.string().max(100),
  /** Set when a person asked for the lesson with "remember this" or a member's edit made it (a strong signal). */
  memberSignal: z.boolean(),
  /**
   * The places (a channel, a repository, an issue) the evidence came from, restricted or not, as the Team record names them. They are what the access records are asked about when the
   * lesson is read, so a person removed from a channel stops getting its lessons. Absent on a lesson learned before this field: its restricted places are read from the audience's scope.
   */
  sourceScopes: z.array(z.string().max(300)).max(50).optional(),
}).strict();
export type LessonProvenance = z.infer<typeof LessonProvenanceSchema>;

export const LessonSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/u), version: z.number().int().min(1), workspaceId: z.string().min(1).max(100), project: z.string().min(1).max(100),
  scope: LessonScopeSchema, type: LessonTypeSchema, stages: z.array(LessonStageSchema).min(1).max(5),
  ...LessonTextSchema.shape,
  citations: z.array(LessonCitationSchema).max(6),
  /** Result of the broker's last check of each code citation against a base commit, by position in `citations`. Absent: never verified (so never tier 0). */
  citationChecks: z.array(z.object({ index: z.number().int().min(0).max(5), result: z.enum(["valid", "moved", "stale"]), at: z.number() }).strict()).max(6).optional(),
  provenance: LessonProvenanceSchema,
  tier: z.union([z.literal(0), z.literal(1), z.literal(2)]), tierReasons: z.array(z.string().max(80)).max(12),
  status: z.enum(LESSON_STATUSES),
  counters: z.object({ loaded: z.number().int().min(0), helpful: z.number().int().min(0), harmful: z.number().int().min(0), citationStale: z.number().int().min(0) }).strict(),
  /** Times (ms) of recent stale citation results, for the "3 in 14 days" rule. */
  staleAt: z.array(z.number()).max(20),
  lastValidatedAt: z.number().optional(), lastHelpfulAt: z.number().optional(),
  expiresAt: z.number(),
  /** Pending lessons that nobody decided expire at this time. */
  pendingExpiresAt: z.number().optional(),
  approvals: z.array(z.object({ approvalId: z.string().max(100), by: z.string().max(100), at: z.number(), mode: z.enum(["one", "second_person", "sole_owner_exception", "auto"]) }).strict()).max(10),
  supersedes: z.string().max(64).optional(),
  /** People who asked for this lesson to become a How we work rule; a tier-2 lesson needs two before it is published. */
  promotionApprovals: z.array(z.object({ by: z.string().max(100), at: z.number() }).strict()).max(5).optional(),
  promotedRuleId: z.string().max(100).optional(),
  /** Set when a paused source was resumed: a person decides this lesson; it is never applied automatically, however it is merged later. */
  reviewRequired: z.boolean().optional(),
  /** The lesson this one contradicts, when both go to a person on one card. */
  contradictsWith: z.string().max(64).optional(),
  /** Set when harmful marks call for a retire and a person has to decide (tier 1 and 2 lessons). */
  retireProposedAt: z.number().optional(),
  rejectedReason: z.string().max(200).optional(),
  createdAt: z.number(), updatedAt: z.number(),
}).strict();
export type Lesson = z.infer<typeof LessonSchema>;

/** The parts of a lesson that change without a new version: counters and expiry bookkeeping. */
export const VOLATILE_FIELDS = ["counters", "staleAt", "lastValidatedAt", "lastHelpfulAt", "expiresAt", "retireProposedAt"] as const;

/**
 * The places a lesson was learned from, for the read-time access check: every source place it names, the restricted ones among them (the audience's scope is the sources joined by
 * `+`), and the time of its snapshot. A lesson with no place at all (a project-wide lesson with no recorded sources) is for project members only: nothing to ask the records.
 */
export function lessonPlaces(lesson: Pick<Lesson, "provenance">): { scopes: string[]; restrictedScopes: string[]; capturedAt?: string } {
  const audience = lesson.provenance.audience;
  const restrictedScopes = audience.kind === "restricted" ? audience.acl.scope.split("+").filter((scope) => scope.length > 0) : [];
  return { scopes: [...new Set([...(lesson.provenance.sourceScopes ?? []), ...restrictedScopes])], restrictedScopes, ...(audience.kind === "restricted" ? { capturedAt: audience.acl.capturedAt } : {}) };
}

export const isRestricted = (lesson: Pick<Lesson, "provenance">): boolean => lesson.provenance.audience.kind === "restricted";

export const LESSON_AUDIT_ACTIONS = [
  "lesson.candidate_created", "lesson.merged", "lesson.updated", "lesson.pending", "lesson.auto_applied", "lesson.approved", "lesson.activated",
  "lesson.rejected", "lesson.retired", "lesson.auto_retired", "lesson.retire_proposed", "lesson.refused", "lesson.stale", "lesson.expired",
  "lesson.rolled_back", "lesson.promoted", "lesson.wrong_here", "lesson.helpful", "lesson.source_paused", "lesson.source_resumed", "lesson.volume_spike",
  "lesson.sole_owner_exception", "lesson.citation_moved", "lesson.contradiction", "lesson.withdrawn", "lesson.promote_failed", "lesson.held_source_paused",
  "lesson.tier0_setting_proposed", "lesson.tier0_setting_changed", "lesson.tier0_setting_cancelled", "lesson.tier0_setting_refused_retryable",
  "lesson.sole_owner_switch_proposed", "lesson.sole_owner_switch_changed",
] as const;
export type LessonAuditAction = (typeof LESSON_AUDIT_ACTIONS)[number];

/** Marks that stand for a removed person in stored text; they are not people. */
export const ERASED_MARK = "erased";
/** Every person a version names: its authors, `member:` source keys, and anyone who approved or asked to promote it. System and erased marks are not people. */
export const peopleOf = (l: Pick<Lesson, "provenance" | "approvals" | "promotionApprovals">): string[] => [
  ...l.provenance.authors, ...(l.provenance.editors ?? []), ...[...l.provenance.sources, ...l.provenance.inputSources].flatMap((s) => { const member = memberOfSource(s); return member === undefined ? [] : [member]; }),
  ...l.approvals.map((a) => a.by), ...(l.promotionApprovals ?? []).map((a) => a.by),
].filter((p) => p !== ERASED_MARK && !p.startsWith("system:"));
/** Every record row a version rests on: its source events and the record citations. */
export const recordIdsOf = (l: Pick<Lesson, "provenance" | "citations">): string[] =>
  [...l.provenance.sourceEvents, ...l.citations.flatMap((c) => (c.kind === "record" ? [c.eventId] : []))];

/** THE id normaliser: ids are compared trimmed and without case, everywhere (the fence, erasure, forget, measured outcomes, corroboration, the author rule, eligibility). */
// (NFC first: a canonical developer id is 64 lowercase hex characters, so no two real ids differ only by case or composition; the schemas still admit any 1 to 100 character string,
// and an accented name typed two ways must be one person.)
export const normId = (id: string): string => id.normalize("NFC").trim().toLowerCase();
export const sameId = (a: string, b: string): boolean => normId(a) === normId(b);
export const idIn = (list: readonly string[], id: string): boolean => list.some((x) => sameId(x, id));
/**
 * THE source-key normaliser (LR-L1). A person's source key is `member:<id>`: its prefix and the id compare without case and spaces (the id by `normId`), so erasing `mallory`
 * also reaches `member:Mallory`. Any other key (a channel, `ci`, a span kind) is only trimmed: those ids are exact. Counters, pauses, holds, forgetting and the digest all go
 * through this, so no site can spell the same source two ways.
 */
const MEMBER_PREFIX = /^\s*member:/iu;
export const memberOfSource = (source: string): string | undefined => (MEMBER_PREFIX.test(source) ? normId(source.replace(MEMBER_PREFIX, "")) : undefined);
export const normSource = (source: string): string => { const member = memberOfSource(source); return member === undefined ? source.trim() : `member:${member}`; };
export const sameSource = (a: string, b: string): boolean => normSource(a) === normSource(b);

/** Distinct ids (by `normId`), keeping the first spelling. */
export const distinctIds = (ids: readonly string[]): string[] => { const seen = new Set<string>(); return ids.filter((i) => { const n = normId(i); if (seen.has(n)) return false; seen.add(n); return true; }); };
