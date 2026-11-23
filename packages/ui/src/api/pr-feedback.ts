// PR feedback on the task page (CLOUD-HALF "Private app implementation", F1, F2). Everything here is read from Code's own answers through Cloud:
//   GET  /v1/app/sessions/{id}/feedback           -> Code GET  .../workflow/feedback           { review }
//   POST /v1/app/sessions/{id}/feedback-decision  -> Code POST .../workflow/feedback-decision  { session } (from Code's { task })
//   POST /v1/app/sessions/{id}/feedback-retry     -> Code POST .../workflow/feedback-retry     { session, started } (from Code's { task, started })
// and the full task read (the session read: Code's GET /v1/dev/tasks/{taskId}, task view 2), whose workflow carries the revision, the review and bundle
// references and every recorded feedback decision. No field is invented here: a fact Code does not serve is shown as unavailable or not shown.
import { SessionResponseReaderSchema, type SessionViewReaderSchema } from "@agentx/contracts/web";
import { z } from "zod";
import type { AppHost } from "../host.js";
import { createApiClient } from "./client.js";
import { ApiError } from "./errors.js";
import { beginSessionRead, finishSessionRead, readSessionIdentity, sessionScope, sessionWriteHost } from "./session-safety.js";

type ReadSession = ReturnType<typeof SessionViewReaderSchema.parse>;
const DIGEST = z.string().regex(/^[a-f0-9]{64}$/u);
const ID = z.string().min(1).max(160);
/** Code's request limit for one approval (WorkflowFeedbackFindingsDecisionRequestSchema: selectedFindingIds max 128). */
export const FIX_SELECTION_MAX = 128;
/** F1: the fixed note a failed (or any) review's Keep carries. */
export const KEEP_NOTE = "The owner kept the pull request as it is.";
/** The subject of this card's durable claim and read fence (one per session, scoped per company and person by `sessionScope`). */
export const prFeedbackSubject = (sessionId: string) => "pr-feedback:" + sessionId;

// ---- Code's feedback read (`{ review }`) ----
const CommentReader = z.looseObject({ author: z.string().min(1).max(100), url: z.string().url().max(2048), path: z.string().max(1024).optional(), line: z.number().int().positive().optional(), body: z.string().max(1_000_000) });
const Operation = z.enum(["MODIFY", "ADD"]);
const FindingReader = z.looseObject({
 id: ID, priority: z.enum(["MUST_FIX", "SHOULD_FIX", "OPTIONAL"]),
 assessment: z.enum(["ACTIONABLE", "ALREADY_ADDRESSED", "STALE", "TECHNICALLY_INCORRECT", "OUT_OF_SCOPE", "CONFLICTING", "NEEDS_OWNER_DECISION"]),
 recommended: z.boolean(), rationale: z.string().min(1).max(16_000),
 confidence: z.looseObject({ level: z.enum(["HIGH", "MEDIUM", "LOW", "UNKNOWN"]) }),
 fixProposal: z.looseObject({
  summary: z.string().min(1).max(2000),
  fileChanges: z.array(z.looseObject({ path: z.string().min(1).max(1000), operation: Operation, change: z.string().min(1).max(4000) })).max(32),
  tests: z.array(z.looseObject({ path: z.string().min(1).max(1000), operation: Operation, behavior: z.string().min(1).max(2000) })).max(32),
 }).optional(),
 checkChanges: z.looseObject({ obsolete: z.array(z.string().max(200)).max(32), added: z.array(z.looseObject({ label: z.string().max(200), command: z.string().max(4000) })).max(32) }),
 comments: z.array(CommentReader).min(1).max(128),
});
const ReviewBase = { taskId: z.string().uuid(), revision: z.number().int().positive(), reviewDigest: DIGEST, bundleDigests: z.array(DIGEST).min(1).max(32) };
const CompleteReviewReader = z.looseObject({
 ...ReviewBase, status: z.enum(["PENDING", "APPROVED", "CHANGES_REQUESTED", "DISMISSED"]), proposalDigest: DIGEST,
 candidates: z.array(z.looseObject({ repositoryId: z.string().min(1).max(200), number: z.number().int().positive(), headSha: z.string().regex(/^[a-f0-9]{40}$/u) })).min(1).max(32),
 findings: z.array(FindingReader).max(128),
});
// A review that failed, timed out or was interrupted: Code answers no proposal and no decision (F1). Its `nextAction` is never shown (owner Q4).
const IncompleteReviewReader = z.looseObject({ ...ReviewBase, status: z.literal("PENDING"), reportStatus: z.enum(["BLOCKED", "FAILED", "INTERRUPTED", "UNKNOWN"]) })
 .refine(review => !("proposalDigest" in review) && !("decision" in review), "a failed review has no proposal or decision");
export const FeedbackReviewReader = z.object({ review: z.union([IncompleteReviewReader, CompleteReviewReader]) }).strict();
export type FeedbackReview = z.infer<typeof FeedbackReviewReader>["review"];
export type FeedbackFinding = z.infer<typeof FindingReader>;
export const isCompleteReview = (review: FeedbackReview): review is z.infer<typeof CompleteReviewReader> => !("reportStatus" in review);

// ---- The full task read's workflow, the parts this card is bound to ----
const DecisionRecordReader = z.looseObject({
 requestId: z.string(), workflowRevision: z.number().int(), decision: z.string(),
 reviewDigest: z.string(), proposalDigest: z.string(), bundleDigests: z.array(z.string()), selectedFindingIds: z.array(z.string()), selectedCommentIds: z.array(z.string()).optional(), decidedByYou: z.boolean().optional(), ownerNote: z.string().optional(), at: z.string().optional(),
});
const FeedbackWorkflowReader = z.looseObject({
 revision: z.number().int().positive(), stage: z.string(), state: z.string(), blockReason: z.string().optional(), fixSource: z.string().optional(),
 feedbackReview: z.looseObject({
  status: z.string(), bundleRefs: z.array(z.looseObject({ sha256: DIGEST, comments: z.array(z.unknown()).max(128).optional() })).max(32),
  reviewRef: z.looseObject({ sha256: DIGEST, proposalDigest: DIGEST, status: z.string(), blockReason: z.string().optional() }).optional(),
 }).optional(),
 feedbackDecisions: z.array(DecisionRecordReader).max(100).optional(),
 // Earlier review reports (Code's WorkflowFeedbackReviewRefSchema): only the bundle digests they reviewed are read, to count review rounds.
 feedbackReviewHistory: z.array(z.looseObject({ bundleDigests: z.array(DIGEST).min(1).max(32) })).max(100).optional(),
});
export type FeedbackWorkflow = z.infer<typeof FeedbackWorkflowReader>;
/** The workflow of the session's task, when it reads; anything else is "not a feedback task" for this card. */
export function feedbackWorkflowOf(session: ReadSession | undefined): FeedbackWorkflow | undefined {
 if (session?.body.kind !== "task") return undefined;
 const parsed = FeedbackWorkflowReader.safeParse((session.body.task as { workflow?: unknown }).workflow);
 return parsed.success ? parsed.data : undefined;
}

export type FeedbackPhase = "collecting" | "reviewing" | "pending" | "failed" | "kept" | "fixing" | "fix_stopped" | "fix_finished";
const FIX_STAGES = new Set(["IMPLEMENT", "VERIFY", "REVIEW", "PULL_REQUEST"]);
/** Where the task's PR feedback is, from the latest full task read alone. Undefined: the card has nothing to show. */
export function feedbackPhase(workflow: FeedbackWorkflow | undefined): FeedbackPhase | undefined {
 const review = workflow?.feedbackReview;
 if (workflow === undefined || review === undefined) return undefined;
 if (review.status === "COLLECTING") return workflow.stage !== "WAIT_FOR_MERGE" ? undefined : workflow.state === "RUNNING" ? "reviewing" : "collecting";
 if (review.status === "PENDING") return review.reviewRef === undefined ? undefined : review.reviewRef.status === "COMPLETE" ? "pending" : "failed";
 if (review.status === "DISMISSED") return "kept";
 if (review.status !== "APPROVED") return undefined;
 if (workflow.fixSource === "feedback" && FIX_STAGES.has(workflow.stage)) return workflow.state === "BLOCKED" ? "fix_stopped" : "fixing";
 return workflow.stage === "WAIT_FOR_MERGE" ? "fix_finished" : undefined;
}

/** DEC 254zzz398 (1): the most review rounds Rovara starts on its own for one task (Code's WORKFLOW_FEEDBACK_AUTO_REVIEW_ROUNDS_MAX). */
export const FEEDBACK_REVIEW_ROUNDS_MAX = 3;
/**
 * The review rounds a task has used, counted as Code counts them (workflowFeedbackReviewRounds): one per DISTINCT set of bundle digests across the earlier
 * reports in feedbackReviewHistory and the current feedbackReview. A retry reviews the same bundles, so it is the same round. From the full task read alone
 * (Code's GET .../workflow/feedback is not asked: it answers 404 after a fix or while collecting).
 */
export function feedbackReviewRounds(workflow: FeedbackWorkflow | undefined): number {
 if (workflow === undefined) return 0;
 const sets = new Set<string>();
 for (const report of workflow.feedbackReviewHistory ?? []) sets.add([...report.bundleDigests].sort().join(","));
 if (workflow.feedbackReview !== undefined) sets.add(workflow.feedbackReview.bundleRefs.map(bundle => bundle.sha256).sort().join(","));
 return sets.size;
}
/** The review limit card (state l): a review that did not finish, on a task whose rounds are used up. Retry review and Keep are still Code's two choices. */
export const feedbackReviewLimitReached = (workflow: FeedbackWorkflow | undefined): boolean => feedbackPhase(workflow) === "failed" && feedbackReviewRounds(workflow) >= FEEDBACK_REVIEW_ROUNDS_MAX;

/** Controller ruling 2026-11-23: the same round count as state (l), but for the complete-phase Fix / Keep card, which also says new comments will not start another review. */
export const feedbackReviewNoteShown = (workflow: FeedbackWorkflow | undefined): boolean => feedbackReviewRounds(workflow) >= FEEDBACK_REVIEW_ROUNDS_MAX;

/** The served money says the next AI call has no room left under the task's limits (nothing is estimated). */
export const feedbackLimitReached = (session: ReadSession | undefined): boolean => {
 const room = session?.money?.stop.nextCallAvailableMicros;
 return room?.state === "available" && room.value === 0;
};
/** The page header's chip while the card shows, from the same read (and the card's own refusal answer). */
export function prFeedbackPageChip(session: ReadSession | undefined, refused = false): "running" | "stopped" | "blocked" | "waiting_for_merge" | "waiting_for_owner" | undefined {
 const phase = feedbackPhase(feedbackWorkflowOf(session));
 if (phase === undefined) return undefined;
 if (refused) return "blocked";
 if (phase === "collecting" || phase === "reviewing" || phase === "fixing") return "running";
 if (phase === "fix_stopped") return feedbackLimitReached(session) ? "blocked" : "stopped";
 if (phase === "kept" || phase === "fix_finished") return "waiting_for_merge";
 return prFeedbackWaitsForOwner(session) ? "waiting_for_owner" : undefined;
}
/** Whether the task page shows the PR feedback card for this read (the page mounts the card only then). */
export const hasPrFeedback = (session: ReadSession | undefined): boolean => feedbackPhase(feedbackWorkflowOf(session)) !== undefined;
const RAIL: Record<FeedbackPhase, { state: "running" | "needs_you"; detail: string }> = {
 collecting: { state: "running", detail: "Reading new pull request comments" }, reviewing: { state: "running", detail: "Reviewing the comments" },
 pending: { state: "needs_you", detail: "Choose which comments to fix" }, failed: { state: "needs_you", detail: "The comment review didn't finish" },
 kept: { state: "needs_you", detail: "Waiting for the merge on GitHub" }, fixing: { state: "running", detail: "Fixing the chosen findings" },
 fix_stopped: { state: "needs_you", detail: "The fix stopped" }, fix_finished: { state: "needs_you", detail: "Waiting for the merge on GitHub" },
};
/** The owner kept the pull request, or the fix is on it: the page says it waits for the merge, not for the person. */
export const prFeedbackWaitsForMerge = (session: ReadSession | undefined): boolean => { const phase = feedbackPhase(feedbackWorkflowOf(session));return phase === "kept" || phase === "fix_finished"; };
/** "Where this task is": the Merge step's line while the card is showing. */
/** With `unconfirmed`, a press on this card is still waiting for its answer (the card's durable record): nothing is checking until the person presses Check. */
export const prFeedbackRail = (session: ReadSession | undefined, unconfirmed = false, refused = false) => {
 const phase = feedbackPhase(feedbackWorkflowOf(session));
 if (phase === undefined || session === undefined) return undefined;
 if (unconfirmed) return { state: "needs_you" as const, detail: "Your choice is not confirmed" };
 if (refused && phase === "pending") return { state: "needs_you" as const, detail: "The fix didn't start" };
 if (feedbackReviewLimitReached(feedbackWorkflowOf(session)) && !prFeedbackWaitsForOwner(session)) return { state: "needs_you" as const, detail: "Review limit reached" };
 if (phase === "fix_stopped" && feedbackLimitReached(session)) return { state: "needs_you" as const, detail: "The fix stopped at the task limit" };
 return prFeedbackWaitsForOwner(session) ? { state: "needs_you" as const, detail: "Waiting for " + session.owner.name + " to choose" } : RAIL[phase];
};
/** Someone who may read the task but not choose (neither its owner nor an authorized co-owner) while the owner's choice waits. */
export const prFeedbackWaitsForOwner = (session: ReadSession | undefined): boolean => {
 const phase = feedbackPhase(feedbackWorkflowOf(session));
 return session !== undefined && (phase === "pending" || phase === "failed") && !session.you.owner && session.you.coOwner !== true;
};

// ---- Bindings (F1): only a matching feedback read and full task read bind a decision ----
export interface FeedbackBindings { expectedRevision: number; reviewDigest: string; proposalDigest: string; bundleDigests: string[] }
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && new Set(a).size === a.length && a.every(item => b.includes(item));
/**
 * The decision's bindings, taken from the full task read: workflow.revision, feedbackReview.reviewRef.sha256 and .proposalDigest, and every
 * feedbackReview.bundleRefs[*].sha256. The feedback read must say the same revision, PENDING, report digest and exact bundle set; a complete read must
 * also carry the same proposal digest. A failed read has none and is not asked for one. Anything missing or different: no binding, so no decision.
 */
export function feedbackBindings(workflow: FeedbackWorkflow | undefined, review: FeedbackReview | undefined): FeedbackBindings | undefined {
 const stored = workflow?.feedbackReview, ref = stored?.reviewRef;
 if (workflow === undefined || review === undefined || stored?.status !== "PENDING" || ref === undefined) return undefined;
 const bundles = stored.bundleRefs.map(bundle => bundle.sha256);
 if (review.status !== "PENDING" || review.revision !== workflow.revision || review.reviewDigest !== ref.sha256 || bundles.length === 0 || !sameSet(review.bundleDigests, bundles)) return undefined;
 if ((ref.status === "COMPLETE") !== isCompleteReview(review)) return undefined;
 if (isCompleteReview(review) && review.proposalDigest !== ref.proposalDigest) return undefined;
 return { expectedRevision: workflow.revision, reviewDigest: ref.sha256, proposalDigest: ref.proposalDigest, bundleDigests: [...bundles] };
}

/** F1's exact Keep body: DISMISS, nothing selected, the fixed note. */
export function keepBody(bindings: FeedbackBindings, requestId: string) {
 return { requestId, expectedRevision: bindings.expectedRevision, reviewDigest: bindings.reviewDigest, proposalDigest: bindings.proposalDigest, bundleDigests: [...bindings.bundleDigests], decision: "DISMISS" as const, selectedFindingIds: [] as string[], ownerNote: KEEP_NOTE };
}

/** Only a finding with a proposed code change can be fixed; one already done is shown for reading. */
export const fixableFinding = (finding: FeedbackFinding): boolean => finding.fixProposal !== undefined && finding.fixProposal.fileChanges.length > 0 && finding.assessment !== "ALREADY_ADDRESSED";
export type SelectionProblem = "empty" | "too_many" | "duplicate" | "not_fixable";
/** A selection has paid-start authority only when it is non-empty, within Code's limit, unique and made only of this read's fixable findings. */
export function selectionProblem(selected: readonly string[], review: FeedbackReview | undefined): SelectionProblem | undefined {
 if (selected.length === 0) return "empty";
 if (selected.length > FIX_SELECTION_MAX) return "too_many";
 if (new Set(selected).size !== selected.length) return "duplicate";
 const fixable = review !== undefined && isCompleteReview(review) ? new Set(review.findings.filter(fixableFinding).map(finding => finding.id)) : new Set<string>();
 return selected.every(id => fixable.has(id)) ? undefined : "not_fixable";
}
/** The Fix body: APPROVE with the selected findings, bound like Keep. Throws for a selection without paid-start authority. */
export function fixBody(bindings: FeedbackBindings, requestId: string, selected: readonly string[], review: FeedbackReview) {
 if (selectionProblem(selected, review) !== undefined) throw new ApiError(0, "SELECTION_INVALID", "Select at least one finding to fix.");
 return { requestId, expectedRevision: bindings.expectedRevision, reviewDigest: bindings.reviewDigest, proposalDigest: bindings.proposalDigest, bundleDigests: [...bindings.bundleDigests], decision: "APPROVE" as const, selectedFindingIds: [...selected] };
}

// ---- Resolving an unknown answer through reads only ----
type DecisionBody = ReturnType<typeof keepBody> | ReturnType<typeof fixBody>;
/**
 * The full task read proves the original decision only by a recorded entry with the original request id, the original workflow revision, the same
 * decision, digests, exact bundle set, selection and note (a Keep: DISMISS, no selected findings or comments, the fixed note). A later round being active
 * does not matter: the match proves it. Never by who acted: Code records a per-task SHA-256 owner key as the actor, not the person's id, and serves no
 * viewer-relative flag (P1-1), so the request id and bindings are the proof.
 */
export function decisionRecorded(workflow: FeedbackWorkflow | undefined, body: Record<string, unknown>): boolean {
 const sent = body as Partial<DecisionBody>;
 return (workflow?.feedbackDecisions ?? []).some(entry => entry.requestId === sent.requestId && entry.workflowRevision === sent.expectedRevision
  && entry.decision === sent.decision && entry.reviewDigest === sent.reviewDigest && entry.proposalDigest === sent.proposalDigest
  && Array.isArray(sent.bundleDigests) && sameSet(entry.bundleDigests, sent.bundleDigests) && Array.isArray(sent.selectedFindingIds) && sameSet(entry.selectedFindingIds, sent.selectedFindingIds)
  && (sent.decision === "DISMISS" ? entry.ownerNote === KEEP_NOTE && (entry.selectedCommentIds ?? []).length === 0 : entry.ownerNote === undefined));
}
/** A retry has no request id: it is proven only when the read no longer holds the original failed review waiting (a new round, or someone else's choice). */
export function retryResolved(workflow: FeedbackWorkflow | undefined, reviewDigest: unknown): boolean {
 const review = workflow?.feedbackReview;
 return workflow !== undefined && typeof reviewDigest === "string" && !(review?.status === "PENDING" && review.reviewRef?.sha256 === reviewDigest);
}
/** A blocked fix's retry is proven when the read moved past the revision it was pressed at. */
export const fixRetryResolved = (workflow: FeedbackWorkflow | undefined, expectedRevision: unknown): boolean => workflow !== undefined && typeof expectedRevision === "number" && workflow.revision > expectedRevision;

// ---- Requests ----
const SessionAnswerReader = { parse: (value: unknown) => SessionResponseReaderSchema.parse(value) };
const RetryAnswerReader = { parse: (value: unknown) => {
 const answer = z.object({ session: z.unknown(), started: z.boolean() }).strict().parse(value);
 return { session: SessionResponseReaderSchema.parse({ session: answer.session }).session, started: answer.started };
} };
const path = (sessionId: string) => "/v1/app/sessions/" + encodeURIComponent(sessionId);
export function createPrFeedbackApi(host: AppHost) {
 const reads = createApiClient(host), writes = createApiClient(sessionWriteHost(host));
 return {
  /**
   * The feedback read, ordered by issue on this card's shared fence (R6b, R6e): a read issued before a press can never answer after it, and a failed
   * read is kept as the subject's latest failure until a newer read succeeds.
   */
  async readReview(sessionId: string): Promise<FeedbackReview> {
   const identity = await readSessionIdentity(host), scope = sessionScope(identity, prFeedbackSubject(sessionId)), issue = beginSessionRead(host, scope);
   try { const { review } = await reads.get(path(sessionId) + "/feedback", FeedbackReviewReader, undefined, { retry: "never" });finishSessionRead(host, scope, issue);return review; }
   catch (error) { finishSessionRead(host, scope, issue, error);throw error; }
  },
  decide: (sessionId: string, body: DecisionBody) => writes.send("POST", path(sessionId) + "/feedback-decision", body, SessionAnswerReader, { retry: "never", pendingIsUnknown: true }),
  /** F2: exactly `{ reviewDigest }`; Code answers `{ task, started }` (as `{ session, started }` through Cloud). */
  retry: (sessionId: string, reviewDigest: string) => writes.send("POST", path(sessionId) + "/feedback-retry", { reviewDigest }, RetryAnswerReader, { retry: "never", pendingIsUnknown: true }),
 };
}
