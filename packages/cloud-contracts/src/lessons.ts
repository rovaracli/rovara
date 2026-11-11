// Lessons (learning v2, design 2026-10-30 section 4.2, 4.5-4.7, 4.13): short, typed, scoped advice with code citations, learned from outcomes.
// A lesson is advice in a labelled block. It has NO field that can grant a tool, change a check, an approval, a model or a budget (control C6):
// every object here is strict, so a field of that kind is a refusal, not an ignored extra. The schema also enforces the hard parts of the tier
// rules (section 4.5.3) as a second guard behind the classifier: an outsider's text is never a lesson, tier 0 is only cited facts from trusted
// sources for the build stages, and anything for a reviewer stage or a check is tier 2.
import { z } from "zod";
import { LESSON_BODY_MAX, LESSON_BUILD_STAGES, LESSON_CANDIDATES_PER_TASK_MAX, LESSON_CITATIONS_MAX, LESSON_DESCRIPTION_MAX, LESSON_REVIEWER_STAGES, LESSON_STAGES, LESSON_TITLE_MAX, LessonApprovalSchema, LessonCitationSchema, LessonCountersSchema, LessonScopeSchema, LessonStageSchema, LessonStatusSchema, LessonTierSchema, LessonTypeSchema, OrgIdSchema, RecordProjectSchema, TRUST_RANK, type TrustClass, TrustClassSchema } from "@rovara-code/contracts";
import { AudienceSchema } from "./team-record.js";


// The stage and type enums live in learned-context.ts (the learning lane's definition of what a worker receives); lessons use the same ones.

export const LessonProvenanceSchema = z.object({
  sourceEvents: z.array(z.string().min(1).max(100)).max(50),
  /** The lowest trust of the sources. `outsider` is refused: an outsider's text is never part of a lesson. */
  minTrust: TrustClassSchema,
  /** The narrowest audience of the sources. */
  audience: AudienceSchema,
  reflectorRun: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
}).strict();
export type LessonProvenance = z.infer<typeof LessonProvenanceSchema>;

const LessonIdSchema = z.string().regex(/^les_[0-9a-f]{20}$/);
export { LessonIdSchema };

const trustedForTierZero = (trust: TrustClass): boolean => TRUST_RANK[trust] >= TRUST_RANK.member;

/** The fields every lesson version carries, before the cross-field rules. */
const LessonBaseSchema = z.object({
  id: LessonIdSchema,
  version: z.number().int().min(1),
  workspaceId: OrgIdSchema,
  project: RecordProjectSchema,
  scope: LessonScopeSchema,
  type: LessonTypeSchema,
  stages: z.array(LessonStageSchema).min(1).max(LESSON_STAGES.length).refine((stages) => new Set(stages).size === stages.length, "stages are unique"),
  title: z.string().min(1).max(LESSON_TITLE_MAX),
  description: z.string().min(1).max(LESSON_DESCRIPTION_MAX),
  body: z.string().min(1).max(LESSON_BODY_MAX),
  citations: z.array(LessonCitationSchema).max(LESSON_CITATIONS_MAX),
  provenance: LessonProvenanceSchema,
  tier: LessonTierSchema,
  tierReasons: z.array(z.string().min(1).max(200)).max(10),
  status: LessonStatusSchema,
  counters: LessonCountersSchema,
  lastValidatedAt: z.string().datetime().optional(),
  lastHelpfulAt: z.string().datetime().optional(),
  /** Epoch seconds. When the lesson fades: its trial period plus N days (90 by default) without helping; a validated helpful use resets it. */
  expiresAt: z.number().int().nonnegative(),
  approvals: z.array(LessonApprovalSchema).max(10),
  /** Set when a sole owner approved a tier-2 lesson alone (audited): one approval is then enough. */
  soleOwnerException: z.literal(true).optional(),
  supersedes: z.string().min(1).max(100).optional(),
  promotedRuleId: z.string().min(1).max(100).optional(),
}).strict();

export const LessonSchema = LessonBaseSchema.superRefine((lesson, context) => {
  const issue = (path: string, message: string) => context.addIssue({ code: "custom", path: [path], message });
  if (lesson.provenance.minTrust === "outsider") issue("provenance", "an outsider's text is never a lesson");
  const reviewer = lesson.stages.some((stage) => LESSON_REVIEWER_STAGES.includes(stage)) || lesson.type === "review_check";
  if (reviewer && lesson.tier !== 2) issue("tier", "a lesson for a reviewer stage or a review check needs two people (tier 2)");
  if (lesson.tier === 0) {
    if (lesson.type !== "fact") issue("tier", "tier 0 is for facts only");
    if (!trustedForTierZero(lesson.provenance.minTrust)) issue("tier", "tier 0 needs member or rovara trust");
    if (lesson.provenance.audience.kind !== "project") issue("tier", "tier 0 needs the project audience");
    if (!lesson.stages.every((stage) => LESSON_BUILD_STAGES.includes(stage))) issue("tier", "tier 0 reaches build stages only");
    if ((lesson.scope.repos?.length ?? 0) > 1) issue("tier", "tier 0 is scoped to one repository");
    if (lesson.citations.length === 0 || !lesson.citations.every((citation) => citation.kind === "code")) issue("tier", "tier 0 needs code citations only");
  }
  const needed = lesson.soleOwnerException === true && lesson.tier === 2 ? 1 : lesson.tier;
  if (lesson.status === "active" && lesson.approvals.length < needed) issue("approvals", "an active lesson has the approvals its tier needs");
  if (lesson.soleOwnerException === true && lesson.tier !== 2) issue("soleOwnerException", "the sole-owner exception is for tier 2");
});
export type Lesson = z.infer<typeof LessonSchema>;

/** What the reflector may propose: no id, no tier, no status. Code fills those after it has checked the evidence spans. */
export const LessonCandidateSchema = z.object({
  type: LessonTypeSchema,
  title: z.string().min(1).max(LESSON_TITLE_MAX),
  description: z.string().min(1).max(LESSON_DESCRIPTION_MAX),
  body: z.string().min(1).max(LESSON_BODY_MAX),
  scope: LessonScopeSchema,
  stages: LessonBaseSchema.shape.stages,
  citations: z.array(LessonCitationSchema).max(LESSON_CITATIONS_MAX),
  /** The input spans the lesson rests on. Code checks each exists and is not `outsider`. */
  evidenceSpanIds: z.array(z.string().min(1).max(100)).min(1).max(20),
}).strict();
export type LessonCandidate = z.infer<typeof LessonCandidateSchema>;
export const ReflectorOutputSchema = z.object({ candidates: z.array(LessonCandidateSchema).max(LESSON_CANDIDATES_PER_TASK_MAX) }).strict();
export type ReflectorOutput = z.infer<typeof ReflectorOutputSchema>;
