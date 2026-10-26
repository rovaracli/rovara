// Rovara Code (Plan 6 Task 1): the shapes of Understand, the plan critic, risk, merge tracking, code settings, reports, setup drafts and milestones, and the limits
// that bound them. Browser-safe on purpose: the web app reads these, so nothing here imports a Node module. What needs `node:crypto` (the tracking item's
// digest) lives in `rovara-code-node.ts`.
import { z } from "zod";
import { OrgIdSchema, SessionBindingSchema, SessionIdSchema } from "./browser-ids.js";
import { ModelIdentifierSchema } from "./models.js";

// ---- limits (placeholder values, exact names)

export const INTENT_QUESTIONS_MAX = 3;
export const UNDERSTAND_ROUNDS_MAX = 2;
export const UNDERSTAND_TIMEOUT_MINUTES = 10;
export const INTENT_ANSWER_MAX_CHARS = 2000;
export const INTENT_RESTATEMENT_MAX = 500;
export const INTENT_ANSWER_TEXT_MAX = 4000;

export const PLAN_CRITIC_REVISIONS_MAX = 1;
export const PLAN_CRITIC_POINTS_MAX = 10;
export const DEFAULT_RUN_MINUTES = { QUICK: { low: 20, high: 45 }, FULL: { low: 60, high: 180 } } as const;
export const DURATION_HISTORY_SIZE = 20;
export const DURATION_MIN_SAMPLES = 5;

export const PARALLEL_PARTS_MAX = 3;

export const CI_FIX_ROUNDS_MAX = 3;
export const CONFLICT_ROUNDS_MAX = 2;
export const FEEDBACK_AUTO_ROUNDS_MAX = 3;
export const BRANCH_SYNCS_PER_DAY_MAX = 4;
export const CI_FAILED_JOBS_MAX = 5;
export const CI_LOG_TAIL_LINES = 200;
export const CI_LOG_BYTES_MAX = 32_768;

export const REVIEW_NUDGE_FIRST_HOURS = 24;
export const REVIEW_NUDGE_REPEAT_HOURS = 48;
export const REVIEW_NUDGES_MAX = 3;
export const CODE_REVIEWERS_MAX = 10;
export const TRACKING_COALESCE_SECONDS = 30;
export const TRACKING_GATE_SECONDS = 60;
export const TRACKING_MAX_ROWS = 25;
export const TRACKING_REQUESTS_BASE = 12;
export const TRACKING_REQUESTS_PER_EXTRA_PR = 6;
export const TRACKING_HEARTBEAT_MINUTES = 15;
export const MERGE_CLAIM_SECONDS = 120;

export const RISK_LARGE_CHANGE_LINES = 400;

export const TRASH_DAYS = 7;
export const TRASH_BUNDLE_MAX_BYTES = 104_857_600;
export const TRASH_FALLBACK_PARTS_MAX = 20;
export const SETUP_DRAFT_SECRETS_MAX = 20;

/** The file names a push or a trash bundle never adds (`.gitignore` is honoured as well). */
export const SECRET_FILE_PATTERNS = [".env", ".env.*", "*.pem", "*.key", "id_rsa*", "id_ed25519*", "*.p12", "credentials*.json"] as const;

/** Clients that read the Rovara Code task view send this header with this value; others are served the version 1 projection. */
export const TASK_VIEW_HEADER = "x-agentx-task-view";
export const TASK_VIEW_VERSION = "2";

// ---- small pieces

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const GitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const InstantSchema = z.string().datetime();
const QuestionIdSchema = z.string().regex(/^q[1-3]$/);
const OptionIdSchema = z.string().regex(/^[a-d]$/);
const CountSchema = z.number().int().min(0);
/** The path a task takes (the same two words as the workflow's `WorkflowPathSchema`; a test pins them together). */
const IntentPathSchema = z.enum(["QUICK", "FULL"]);

// ---- Understand

export const IntentQuestionSchema = z
  .object({
    id: QuestionIdSchema,
    text: z.string().min(1).max(300),
    options: z.array(z.object({ id: OptionIdSchema, label: z.string().min(1).max(80) }).strict()).min(2).max(4).optional(),
    recommended: OptionIdSchema.optional(),
  })
  .strict()
  .superRefine((question, context) => {
    if (question.recommended !== undefined && !(question.options ?? []).some((option) => option.id === question.recommended)) {
      context.addIssue({ code: "custom", path: ["recommended"], message: "the recommended answer must be one of the options" });
    }
  });
export type IntentQuestion = z.infer<typeof IntentQuestionSchema>;

export const IntentAssessmentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ready"),
    path: IntentPathSchema,
    restatement: z.string().min(1).max(INTENT_RESTATEMENT_MAX),
    assumptions: z.array(z.string().min(1).max(300)).max(5),
  }).strict(),
  z.object({
    kind: z.literal("questions"),
    restatement: z.string().min(1).max(INTENT_RESTATEMENT_MAX),
    questions: z.array(IntentQuestionSchema).min(1).max(INTENT_QUESTIONS_MAX),
  }).strict(),
  z.object({
    kind: z.literal("answer"),
    restatement: z.string().min(1).max(INTENT_RESTATEMENT_MAX),
    answer: z.string().min(1).max(INTENT_ANSWER_TEXT_MAX),
    sources: z.array(z.object({ repository: z.string().min(1).max(200), path: z.string().min(1).max(500), line: z.number().int().positive().optional() }).strict()).max(10),
  }).strict(),
]);
export type IntentAssessment = z.infer<typeof IntentAssessmentSchema>;

export const IntentAnswerSchema = z
  .object({ questionId: QuestionIdSchema, optionId: OptionIdSchema.optional(), text: z.string().min(1).max(INTENT_ANSWER_MAX_CHARS).optional() })
  .strict()
  .refine((answer) => answer.optionId !== undefined || answer.text !== undefined, { message: "an answer picks an option or says something" });
export type IntentAnswer = z.infer<typeof IntentAnswerSchema>;

/** Where an answer came from. */
export const INTENT_ANSWER_SOURCES = ["app", "slack", "linear", "cli", "mcp"] as const;

export const WorkflowIntentSchema = z
  .object({
    rounds: z.number().int().min(0).max(UNDERSTAND_ROUNDS_MAX),
    pathFrom: z.enum(["request", "understand", "handoff"]),
    assessment: IntentAssessmentSchema.optional(),
    answers: z
      .array(
        z.object({
          round: z.number().int().min(1).max(UNDERSTAND_ROUNDS_MAX),
          by: z.object({ actorId: Sha256Schema, name: z.string().min(1).max(200) }).strict(),
          source: z.enum(INTENT_ANSWER_SOURCES),
          answers: z.array(IntentAnswerSchema).min(1).max(INTENT_QUESTIONS_MAX),
          at: InstantSchema,
        }).strict(),
      )
      .max(UNDERSTAND_ROUNDS_MAX * 10),
  })
  .strict();
export type WorkflowIntent = z.infer<typeof WorkflowIntentSchema>;

// ---- the plan critic

export const PlanCritiqueSchema = z
  .object({
    verdict: z.enum(["ok", "revise"]),
    points: z
      .array(z.object({ id: z.string().min(1).max(32), severity: z.enum(["blocking", "note"]), text: z.string().min(1).max(500), claimId: z.string().min(1).max(64).optional() }).strict())
      .max(PLAN_CRITIC_POINTS_MAX),
    model: ModelIdentifierSchema.extend({ company: z.enum(["anthropic", "openai", "google", "other"]) }).strict(),
  })
  .strict();
export type PlanCritique = z.infer<typeof PlanCritiqueSchema>;

export const WorkflowCritiqueSchema = z
  .object({
    status: z.enum(["done", "stopped_at_limit"]),
    sameModelAsPlanner: z.literal(true).optional(),
    critiques: z.array(PlanCritiqueSchema).max(PLAN_CRITIC_REVISIONS_MAX + 1),
    revisions: z.number().int().min(0).max(PLAN_CRITIC_REVISIONS_MAX),
  })
  .strict();
export type WorkflowCritique = z.infer<typeof WorkflowCritiqueSchema>;

// ---- risk and fixes

export const RiskAssessmentSchema = z
  .object({ level: z.enum(["low", "medium", "high"]), reasons: z.array(z.string().min(1).max(200)).max(8), candidateDigest: Sha256Schema })
  .strict();
export type RiskAssessment = z.infer<typeof RiskAssessmentSchema>;

export const FixSourceSchema = z.enum(["feedback", "ci", "conflict"]);
export type FixSource = z.infer<typeof FixSourceSchema>;

export const WorkflowFixRoundsSchema = z
  .object({ ci: CountSchema.max(CI_FIX_ROUNDS_MAX), conflict: CountSchema.max(CONFLICT_ROUNDS_MAX), feedbackAuto: CountSchema.max(FEEDBACK_AUTO_ROUNDS_MAX) })
  .strict();
export type WorkflowFixRounds = z.infer<typeof WorkflowFixRoundsSchema>;

// ---- merge tracking

/** The separate item that holds what GitHub says about one pull request of a task (`DEVTASK#<taskId>` / `MERGE_TRACKING#<repositoryId>#<number>`). `decisionDigest` hashes every field but `observedAt`, `version` and itself. */
export const MergeTrackingItemSchema = z
  .object({
    orgId: OrgIdSchema,
    taskId: z.string().uuid(),
    repositoryId: z.string().min(1).max(200),
    number: z.number().int().positive(),
    version: CountSchema,
    headSha: GitShaSchema,
    draft: z.boolean(),
    state: z.enum(["open", "closed", "merged"]),
    baseBranch: z.string().min(1).max(255),
    ci: z.enum(["none", "pending", "passing", "failing"]),
    ciBasis: z.enum(["required", "all_checks"]),
    checksEverSeen: z.boolean(),
    failingChecks: z.array(z.string().min(1).max(200)).max(10),
    review: z.enum(["not_requested", "requested", "changes_requested", "approved"]),
    approval: z.object({ githubUserId: z.string().min(1).max(40), login: z.string().min(1).max(100), commitId: GitShaSchema }).strict().optional(),
    branch: z.enum(["up_to_date", "behind", "conflicted", "unknown"]),
    headByRovara: z.boolean(),
    lastRovaraPushAt: InstantSchema.optional(),
    readyAt: InstantSchema.optional(),
    reviewersRequestedAt: InstantSchema.optional(),
    nudges: z.object({ count: CountSchema.max(REVIEW_NUDGES_MAX), lastAt: InstantSchema.optional() }).strict(),
    syncs: z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), count: CountSchema.max(BRANCH_SYNCS_PER_DAY_MAX) }).strict(),
    mergeClaim: z.object({ headSha: GitShaSchema, by: z.string().min(1).max(200), at: InstantSchema }).strict().optional(),
    decisionDigest: Sha256Schema,
    observedAt: InstantSchema,
  })
  .strict();
export type MergeTrackingItem = z.infer<typeof MergeTrackingItemSchema>;

// ---- code settings

const ReviewerNameSchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9_.-]{1,100})?$/);

export const CodeSettingsSchema = z
  .object({
    allowSelfApproval: z.boolean(),
    mergeMethod: z.enum(["squash", "merge"]),
    codeReviewers: z.array(ReviewerNameSchema).max(CODE_REVIEWERS_MAX),
    revision: CountSchema,
  })
  .strict();
export type CodeSettings = z.infer<typeof CodeSettingsSchema>;

export const DEFAULT_CODE_SETTINGS: CodeSettings = { allowSelfApproval: false, mergeMethod: "squash", codeReviewers: [], revision: 0 };

// ---- reports and drafts

export const VerificationReportSchema = z
  .object({
    reviewOnly: z.boolean(),
    ciBasis: z.enum(["required", "all_checks"]).optional(),
    passed: z.array(z.object({ label: z.string().min(1).max(200) }).strict()).max(100),
    failed: z.array(z.object({ label: z.string().min(1).max(200), summary: z.string().max(300) }).strict()).max(100),
    notChecked: z.array(z.object({ label: z.string().min(1).max(200), reason: z.string().max(200) }).strict()).max(100),
    testsAdded: z.array(z.object({ repository: z.string().min(1).max(200), path: z.string().min(1).max(500) }).strict()).max(50),
  })
  .strict();
export type VerificationReport = z.infer<typeof VerificationReportSchema>;

export const SetupDraftSchema = z
  .object({
    basedOnRevision: CountSchema,
    setupCommands: z.array(z.string().min(1).max(1024)).max(20),
    testCommands: z.array(z.string().min(1).max(1024)).max(20),
    devcontainer: z
      .object({ repository: z.string().min(1).max(200), configPath: z.string().min(1).max(500), exists: z.boolean(), proposedContent: z.string().max(32_768).optional() })
      .strict()
      .optional(),
    allowedDomains: z.array(z.string().min(1).max(253)).max(100),
    secretsNeeded: z.array(z.object({ name: z.string().min(1).max(200), why: z.string().max(300), foundIn: z.string().max(500) }).strict()).max(SETUP_DRAFT_SECRETS_MAX),
    flaggedCommands: z.array(z.object({ command: z.string().min(1).max(1024), reason: z.string().min(1).max(300) }).strict()).max(40),
    notes: z.string().max(2000),
  })
  .strict();
export type SetupDraft = z.infer<typeof SetupDraftSchema>;

// ---- milestones

export const CODE_MILESTONE_KINDS = ["questions", "answered", "plan_ready", "pr_ready", "review_nudge", "fixing", "stuck", "approved", "merged"] as const;
export const CodeMilestoneKindSchema = z.enum(CODE_MILESTONE_KINDS);
export type CodeMilestoneKind = z.infer<typeof CodeMilestoneKindSchema>;
/** The milestones that come before the pull request: written only for 1.1.0 tasks, so version 1 records stay as they were. */
export const CODE_MILESTONES_BEFORE_PR: readonly CodeMilestoneKind[] = ["questions", "answered", "plan_ready"];

export const CodeMilestoneSchema = z
  .object({
    kind: CodeMilestoneKindSchema,
    orgId: OrgIdSchema,
    taskId: z.string().uuid(),
    sessionId: SessionIdSchema.optional(),
    at: InstantSchema,
    text: z.string().min(1).max(500),
    pullRequests: z.array(z.object({ repository: z.string().min(1).max(200), number: z.number().int().positive(), url: z.string().url().max(2048) }).strict()).max(32).optional(),
    bindings: z.array(SessionBindingSchema).max(2).optional(),
    to: z.array(z.string().min(1).max(200)).max(50).optional(),
  })
  .strict();
export type CodeMilestone = z.infer<typeof CodeMilestoneSchema>;

// ---- time

/**
 * A time range for a person, with an en dash: `about 20–45 minutes` while the high end is below 90 minutes, else hours (`about 1–3 hours`). A low end below an hour stays in minutes
 * (`about 5 minutes to 2 hours`), and equal ends are one value (`about 20 minutes`, `about 2 hours`), never `20–20`.
 */
export function formatMinutes(low: number, high: number): string {
  const lo = Math.round(low);
  const hi = Math.round(high);
  if (hi < 90) return lo === hi ? `about ${String(lo)} minutes` : `about ${String(lo)}–${String(hi)} minutes`;
  const hours = (minutes: number): number => Math.max(1, Math.round(minutes / 60));
  // From here the high end is 90 minutes or more, so it is always two hours or more.
  if (lo < 60) return `about ${String(lo)} minutes to ${String(hours(hi))} hours`;
  return hours(lo) === hours(hi) ? `about ${String(hours(hi))} hours` : `about ${String(hours(lo))}–${String(hours(hi))} hours`;
}
