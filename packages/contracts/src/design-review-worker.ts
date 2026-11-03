// Design review stage, DR5 (design-review-stage.md 3.2, 3.4 and 3.10): what the worker's design-review operation uploads, in one artifact. The broker reads it as DATA: it re-reads every reviewer's
// answer itself (readDesignReview), re-applies the citation check and the merge checks to the packets it built, and verifies each report (broker/src/design-review/verify.ts). The `findings` the worker
// computed are early feedback only and are never believed.
import { z } from "zod";
import { DESIGN_REVIEW_FINDINGS_MAX, DESIGN_REVIEW_REVIEWERS_MAX, DesignFindingSchema, DesignCitationSchema, DesignSectionSchema, ReviewerRoleSchema } from "./design-review.js";
import { CITATION_DROP_REASONS } from "./design-review-citations.js";

/** The artifact the broker reads the design review's result from (beside `plan-critique.md` of the plan check). */
export const DESIGN_REVIEW_ARTIFACT = "design-review.json";
/** One reviewer's time (3.2). */
export const DESIGN_REVIEW_REVIEWER_TIMEOUT_MS = 15 * 60_000;
/** The whole operation's time (3.2). A reviewer still running when it passes ends with what it has, which is nothing: the others count. */
export const DESIGN_REVIEW_STAGE_TIMEOUT_MS = 40 * 60_000;
/** The most bytes of one answer that are uploaded; an over-long answer keeps its end, where the block is. */
export const DESIGN_REVIEW_ANSWER_MAX_BYTES = 65_536;

/** Why a reviewer (or the merge step) gave no result. Fixed codes; nothing the model or a provider wrote. */
export const DESIGN_REVIEW_RUN_FAILURES = [
  /** The answer had no readable block, even after the one retry. */
  "unreadable",
  /** The reviewer's own 15 minutes ran out. */
  "timeout",
  /** The stage's 40 minutes ran out. */
  "stage_timeout",
  /** The operation was cancelled. */
  "cancelled",
  /** The model call failed. */
  "model_failed",
  "budget_exhausted",
  "model_not_allowed",
  /** The packet the worker fetched does not hash to the digest the broker built, so nothing was sent. */
  "packet_changed",
  /** The session was not sent exactly the rendered packet, so its digest cannot vouch for it. */
  "sent_mismatch",
  /** The session could not be opened. */
  "session_failed",
] as const;
export type DesignReviewRunFailure = (typeof DESIGN_REVIEW_RUN_FAILURES)[number];

/** What a reviewer session reports for fresh-context verification. The same fields as `WorkerReportSchema` in broker/src/design-review/verify.ts (a test holds them together). */
export const DesignReviewerReportSchema = z.object({
  sessionId: z.string().min(1).max(200),
  packetDigest: z.string().regex(/^[a-f0-9]{64}$/),
  firstRequestMessages: z.number().int().min(0).max(1_000),
  filesRead: z.array(z.string().min(1).max(500)).max(200),
  tools: z.array(z.string().min(1).max(64)).max(32),
  modelKeyId: z.string().min(1).max(200).optional(),
}).strict();
export type DesignReviewerReport = z.infer<typeof DesignReviewerReportSchema>;

const Tokens = z.number().int().min(0);
const Usd = z.number().min(0).max(10_000);
const Instant = z.string().datetime({ offset: true });

export const DesignReviewerOutcomeSchema = z.object({
  role: ReviewerRoleSchema,
  keySlot: z.string().min(1).max(32),
  /** "answered": the last answer holds a block the worker could read. "no_result": it did not (see `failure`). The broker decides for itself either way. */
  status: z.enum(["answered", "no_result"]),
  failure: z.enum(DESIGN_REVIEW_RUN_FAILURES).optional(),
  /** True when the reviewer was asked once more in the same session because its first block could not be read. */
  retried: z.boolean(),
  report: DesignReviewerReportSchema.optional(),
  /** The last answer, bounded. The broker reads the block from it again. */
  answer: z.string().max(DESIGN_REVIEW_ANSWER_MAX_BYTES * 4).optional(),
  tokensIn: Tokens,
  tokensOut: Tokens,
  /** The session's own estimate; the model proxy's spend ledger is the authority. */
  costUsd: Usd,
  startedAt: Instant,
  endedAt: Instant,
}).strict();
export type DesignReviewerOutcome = z.infer<typeof DesignReviewerOutcomeSchema>;

export const DesignReviewMergeOutcomeSchema = z.object({
  status: z.enum(["answered", "skipped", "no_result"]),
  failure: z.enum(DESIGN_REVIEW_RUN_FAILURES).optional(),
  answer: z.string().max(DESIGN_REVIEW_ANSWER_MAX_BYTES * 4).optional(),
  tokensIn: Tokens,
  tokensOut: Tokens,
  costUsd: Usd,
}).strict();

export const DesignReviewWorkerResultSchema = z.object({
  version: z.literal(1),
  round: z.union([z.literal(1), z.literal(2)]),
  reviewers: z.array(DesignReviewerOutcomeSchema).max(DESIGN_REVIEW_REVIEWERS_MAX),
  merge: DesignReviewMergeOutcomeSchema,
  /** The worker's own merged findings (after its citation check and merge checks): early feedback, never believed. */
  findings: z.array(DesignFindingSchema).max(DESIGN_REVIEW_FINDINGS_MAX),
  mergeSource: z.enum(["model", "code"]),
  /** Why the merge model's grouping was not used, as a fixed code. */
  mergeFallback: z.string().min(1).max(40).optional(),
  omitted: Tokens,
  droppedCitations: z.array(z.object({ rawId: z.string().max(80), role: ReviewerRoleSchema, reason: z.enum(CITATION_DROP_REASONS), citation: DesignCitationSchema }).strict()).max(500),
  droppedFindings: z.array(z.object({ rawId: z.string().max(80), role: ReviewerRoleSchema, severity: z.enum(["blocker", "major", "nit"]), section: DesignSectionSchema, reason: z.literal("no_valid_citation") }).strict()).max(500),
  /** True when the 40-minute stage limit ended the operation before every reviewer had finished. */
  stageTimedOut: z.boolean(),
}).strict();
export type DesignReviewWorkerResult = z.infer<typeof DesignReviewWorkerResultSchema>;
