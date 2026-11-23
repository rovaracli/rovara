// PR feedback fixtures: a task waiting for merge whose workflow carries Code's own feedback records (parsed by the real DeveloperTaskViewSchema through
// workspaceFixture), and Code's GET .../workflow/feedback bodies in both shapes (complete report; failed report with no proposal and no decision).
import { SessionResponseReaderSchema, type SessionView } from "@agentx/contracts/web";
import { workspaceFixture, workspaceWorkflow } from "./workspace-fixture.js";
import { sessionPerson } from "./session-fixture.js";
import { createHash } from "node:crypto";

// Real-shaped SHA-256 actor keys, built at runtime so no key-shaped literal is stored (secret scanners and push protection).
const fakeActorKey = (who: string): string => createHash("sha256").update(`pr-feedback fixture ${who}`).digest("hex");

export const PRF = {
 taskId: "11111111-1111-4111-8111-111111111111", sessionId: "ses_aaaaaaaaaaaaaaaaaaaa", owner: sessionPerson.developerId, coOwner: "b".repeat(64),
 // The actor keys Code records on a decision (taskOwnerKey: a SHA-256 of the issuer and developerId/taskId), never a person id. Real-shaped so a card that compares them to the person fails.
 ownerKey: fakeActorKey("owner"), coOwnerKey: fakeActorKey("co-owner"),
 review: "1".repeat(64), proposal: "2".repeat(64), bundleA: "3".repeat(64), bundleB: "4".repeat(64), nextReview: "5".repeat(64),
 operation: "66666666-6666-4666-8666-666666666666", revision: 7,
};
const at = "2026-10-23T12:00:00.000Z";
/** createCandidateManifest([{ repositoryId: "payments", commitSha: c×40, treeSha: d×40, baseCommitSha: e×40 }]), as a literal so browser captures can use this fixture (pinned by a test). */
export const FIXTURE_CANDIDATE = { schemaVersion: 1, repositories: [{ repositoryId: "payments", commitSha: "c".repeat(40), treeSha: "d".repeat(40), baseCommitSha: "e".repeat(40) }], digest: "8cfbeaccfee73b6754c16b89ce2aefa09de9941cb7f719c0893c405fd598862e" };
const candidate = FIXTURE_CANDIDATE;
const comment = (id: string, author: string) => ({ id, kind: "REVIEW_COMMENT", url: `https://github.com/acme/payments/pull/42#discussion_r${id}`, author, updatedAt: at, bodyDigest: "7".repeat(64), bodyBytes: 40 });
const bundleRef = (sha256: string, number: number) => ({ schemaVersion: 1, taskId: PRF.taskId, repositoryId: number === 42 ? "payments" : "payments-web", number, headSha: "c".repeat(40), candidateDigest: candidate.digest,
 commentSetDigest: "8".repeat(64), producer: "collector", version: "1", recordedAt: at, comments: [comment("1101", "sam-k"), comment("1107", "dana")], sha256, objectKey: `private/o/w/feedback/${sha256}.json` });
export interface ReviewRefOptions { status?: "COMPLETE" | "FAILED" | "BLOCKED" | "INTERRUPTED" | "UNKNOWN"; sha256?: string; blockReason?: string; bundles?: string[] }
const reviewRef = (options: ReviewRefOptions = {}) => {
 const bundles = options.bundles ?? [PRF.bundleA], status = options.status ?? "COMPLETE", sha256 = options.sha256 ?? PRF.review;
 return { schemaVersion: 1, taskId: PRF.taskId, workflowRevision: PRF.revision - 1, operationMode: "FEEDBACK_REVIEW", qualification: "AI_GENERATED_ADVISORY", proposalDigest: PRF.proposal, taskRequirementsDigest: "9".repeat(64),
  candidateBindings: bundles.map((digest, index) => ({ repositoryId: index === 0 ? "payments" : "payments-web", number: 42 + index, headSha: "c".repeat(40), candidateDigest: candidate.digest, commentSetDigest: "8".repeat(64), bundleDigest: digest })),
  operationId: PRF.operation, provider: "fixture", version: "1", status, ...(status === "COMPLETE" ? {} : { blockReason: options.blockReason ?? "The AI review timed out." }),
  bundleDigests: bundles, findingRefs: status === "COMPLETE" ? bundles.map((digest, index) => ({ id: "f" + String(index + 1), bundleDigest: digest, commentIds: ["1101", "1107"], priority: "MUST_FIX", assessment: "ACTIONABLE", recommended: true })) : [], recordedAt: at, sha256, objectKey: `private/o/w/feedback-reviews/${sha256}.json` };
};
export type FeedbackKind = "collecting" | "reviewing" | "pending" | "failed" | "kept" | "fixing" | "fix_stopped" | "fix_finished";
export interface FeedbackSessionOptions { history?: string[][]; revision?: number; ref?: ReviewRefOptions; decisions?: unknown[]; you?: Record<string, unknown>; money?: unknown; blockReason?: string; stage?: string; owner?: { developerId: string; name: string } }
/** A decision record as Code stores it (WorkflowFeedbackDecisionSchema). */
export const decisionRecord = (overrides: Record<string, unknown> = {}) => ({ schemaVersion: 1, requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", workflowRevision: PRF.revision, decision: "DISMISS", actorId: PRF.ownerKey, actorRole: "TASK_OWNER",
 reviewDigest: PRF.review, proposalDigest: PRF.proposal, bundleDigests: [PRF.bundleA], selectedFindingIds: [], selectedCommentIds: [], candidates: [], ownerNote: "The owner kept the pull request as it is.", at, ...overrides } as Record<string, unknown>);

/** An APPROVE record as Code stores it: the selected findings, their comments and the bound candidates. */
export const approveRecord = (overrides: Record<string, unknown> = {}) => decisionRecord({ decision: "APPROVE", selectedFindingIds: ["f1", "f2"], selectedCommentIds: ["1101", "1107"], ownerNote: undefined,
 candidates: [{ repositoryId: "payments", number: 42, headSha: "c".repeat(40), candidateDigest: candidate.digest, commentSetDigest: "8".repeat(64), bundleDigest: PRF.bundleA }], ...overrides });
export function feedbackSession(kind: FeedbackKind, options: FeedbackSessionOptions = {}): SessionView {
 const revision = options.revision ?? PRF.revision, bundles = options.ref?.bundles ?? [PRF.bundleA];
 const status = { collecting: "COLLECTING", reviewing: "COLLECTING", pending: "PENDING", failed: "PENDING", kept: "DISMISSED", fixing: "APPROVED", fix_stopped: "APPROVED", fix_finished: "APPROVED" }[kind];
 const refStatus = kind === "failed" ? options.ref?.status ?? "FAILED" : "COMPLETE";
 const feedbackReview = status === "COLLECTING" ? { status, bundleRefs: bundles.map((digest, index) => bundleRef(digest, 42 + index)), threadObservations: [] }
  : { status, bundleRefs: bundles.map((digest, index) => bundleRef(digest, 42 + index)), reviewRef: reviewRef({ ...options.ref, status: refStatus }) };
 const stage = options.stage ?? (kind === "fixing" ? "IMPLEMENT" : kind === "fix_stopped" ? "VERIFY" : "WAIT_FOR_MERGE");
 const state = kind === "reviewing" || kind === "fixing" ? "RUNNING" : kind === "fix_stopped" ? "BLOCKED" : "WAITING";
 const fixing = kind === "fixing" || kind === "fix_stopped";
 const workflow = {
  ...workspaceWorkflow(), revision, stage, state, candidate,
  verification: { candidateDigest: candidate.digest, producer: "check-runner", environmentId: "fixture-worker", recordedAt: at, results: [{ checkId: "unit", status: "PASS" }] },
  reviews: (["CRITIC", "SECURITY"] as const).map((role, index) => ({ operationId: `7777777${String(index)}-7777-4777-8777-777777777777`, candidateDigest: candidate.digest, role, provider: "fixture", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: at })),
  pullRequests: [{ repositoryId: "payments", number: 42, url: "https://github.com/acme/payments/pull/42", headSha: "c".repeat(40), candidateDigest: candidate.digest, required: true, state: "OPEN" }], pullRequestUpdatedAt: at,
  feedbackReview, ...(options.history === undefined ? {} : { feedbackReviewHistory: options.history.map((bundles, index) => reviewRef({ bundles, sha256: (0xa0 + index).toString(16).repeat(32) })) }),
  ...(options.decisions === undefined ? {} : { feedbackDecisions: options.decisions }),
  ...(fixing ? { fixSource: "feedback" } : {}), ...(kind === "fix_stopped" ? { blockReason: options.blockReason ?? "You stopped it." } : {}),
 };
 // Cloud's sessionView names the member who started the task as its payer (session-view.ts cost.payer).
 const session = workspaceFixture({ status: kind === "fixing" || kind === "reviewing" ? "running" : "waiting", step: "Merge", title: "Add refunds endpoint", cost: { spentUsd: 2.4, runLimitUsd: 6, payer: { kind: "member", name: "Priya" } }, ...(options.owner === undefined ? {} : { owner: options.owner }), ...(options.money === undefined ? {} : { money: options.money as SessionView["money"] }) },
  { status: "SUCCEEDED", workflow, pullRequests: [{ repository: "acme/payments", number: 42, url: "https://github.com/acme/payments/pull/42", state: "open" }] });
 // The actions Cloud's sessionView serves: Stop and Close for the owner; Retry for the owner or a co-owner on a blocked step (session-view.ts).
 const owner = options.you?.["owner"] !== false, coOwner = options.you?.["coOwner"] === true;
 const actions = ["watch", "comment", ...((owner || coOwner) && kind === "fix_stopped" ? ["retry"] : []), ...(owner ? ["stop", "close"] : [])];
 const you = { ...session.you, level: "edit", owner: true, actions, ...options.you };
 // The response reader the app uses parses every fixture again.
 return SessionResponseReaderSchema.parse({ session: { ...session, you } }).session as SessionView;
}

/** Code's GET .../workflow/feedback for a complete report: four findings over five comments (the approved mock's). */
export function completeReview(overrides: Record<string, unknown> = {}) {
 const gh = "https://github.com/acme/payments/pull/42#discussion_r";
 const finding = (id: string, priority: string, assessment: string, recommended: boolean, summary: string | undefined, comments: Array<[string, string, string?, number?]>, extra: Record<string, unknown> = {}) => ({
  id, bundleDigest: PRF.bundleA, commentIds: comments.map((_, index) => id + "-c" + String(index)), priority, assessment, recommended,
  evidence: [{ source: "comment", reference: id }], rationale: "Why " + id + ": the handler doesn't check for an earlier refund.", confidence: { level: recommended ? "HIGH" : "LOW", reason: "fixture" },
  proposedDisposition: summary === undefined ? "SKIP" : "IMPLEMENT",
  ...(summary === undefined ? {} : { fixProposal: { summary, fileChanges: [{ repositoryId: "payments", path: "src/refunds/handlers.py", operation: "MODIFY", change: "Refuse a second refund." }], tests: [{ repositoryId: "payments", path: "tests/refunds/test_handlers.py", operation: "MODIFY", behavior: "A second refund is refused." }] } }),
  checkChanges: { obsolete: [], added: [] },
  comments: comments.map(([body, author, path, line], index) => ({ id: id + "-c" + String(index), kind: "REVIEW_COMMENT", url: gh + id + String(index), author, updatedAt: at, bodyDigest: "7".repeat(64), bodyBytes: body.length, body, ...(path === undefined ? {} : { path }), ...(line === undefined ? {} : { line }) })),
  ...extra,
 });
 return { review: {
  taskId: PRF.taskId, title: "Fix duplicate refunds", revision: PRF.revision, status: "PENDING", workflowStatus: "WAITING", workflowStage: "WAIT_FOR_MERGE", nextAction: "Review this proposal and choose the next action.",
  qualification: "AI_GENERATED_ADVISORY", reviewDigest: PRF.review, proposalDigest: PRF.proposal, bundleDigests: [PRF.bundleA],
  candidates: [{ repositoryId: "payments", number: 42, headSha: "c".repeat(40) }],
  findings: [
   finding("f1", "MUST_FIX", "ACTIONABLE", true, "Refuse a second refund for the same payment", [["A second refund request for the same payment goes through.", "sam-k", "src/refunds/handlers.py", 41], ["+1, we saw a double refund in staging.", "dana"]]),
   finding("f2", "SHOULD_FIX", "ACTIONABLE", true, "Say why a refund was refused", [["The error just says 'Bad request'.", "dana"]], { checkChanges: { obsolete: ["Refund error text"], added: [{ label: "Refund refusals name the reason", command: "pytest tests/refunds -k reason" }] } }),
   finding("f3", "SHOULD_FIX", "NEEDS_OWNER_DECISION", false, "Limit partial refunds to 3 per payment?", [["Should partial refunds be capped?", "sam-k", "src/refunds/handlers.py", 58]]),
   finding("f4", "OPTIONAL", "ALREADY_ADDRESSED", false, undefined, [["Please add a test for the full refund.", "dana"]]),
  ],
  reportOrder: ["f1", "f2", "f3", "f4"], recommendedFindingIds: ["f1", "f2"], checks: ["unit"], recommendedCheckChanges: [],
  ...overrides,
 } };
}
/** Code's GET .../workflow/feedback for a review that failed: no proposal and no decision, by design (F1). */
export function failedReview(overrides: Record<string, unknown> = {}) {
 return { review: { taskId: PRF.taskId, title: "Fix duplicate refunds", revision: PRF.revision, status: "PENDING", reportStatus: "FAILED", workflowStatus: "WAITING", workflowStage: "WAIT_FOR_MERGE",
  reviewDigest: PRF.review, bundleDigests: [PRF.bundleA], candidates: [], findings: [], recommendedFindingIds: [], checks: [],
  nextAction: "The feedback review did not finish. Choose Retry review to run it again, or Keep the pull request as it is.", ...overrides } };
}
/** A served TaskMoneyV1 for the owner: Priya pays, $2.40 spent of a $6.00 limit. */
export function ownerMoney(spentMicros = 2_400_000, limitMicros = 6_000_000) {
 const avail = <T,>(value: T) => ({ state: "available" as const, value });
 return { version: 1, taskId: PRF.taskId, currency: "USD", revision: 9, asOf: "2026-11-22T14:50:00.000Z", state: "current",
  spentMicros: avail(spentMicros), finalMicros: avail(spentMicros), estimatedMicros: avail(0), heldMicros: avail(0), unpricedCalls: avail(0), awaitingUsageCalls: avail(0), awaitingUsageMicros: avail(0),
  payer: avail({ kind: "member", id: PRF.owner, name: "Priya" }), allocations: [],
  coverage: { expectedCalls: avail(6), finalCalls: 6, estimatedCalls: 0, awaitingUsageCalls: 0, incompatibleCurrencyCalls: 0 },
  stop: { taskMaximumMicros: avail(limitMicros), nextCallAvailableMicros: avail(Math.max(0, limitMicros - spentMicros)), limits: [], coverage: "complete", bindingScope: avail("project_task") },
  terminal: false, finality: "provisional" };
}
