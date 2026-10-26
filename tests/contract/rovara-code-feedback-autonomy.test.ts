// Rovara Code (Plan 6 Task 16): fixing review comments under autonomy. The contract (Rovara's own decision, its rounds, the failing checks folded into the owner's card), the rule
// that says when a round may be fixed without asking (writers only, actionable, under the cap, autonomy prepare or run), and the feedback slot of merge tracking over a fake GitHub:
// a writer's actionable comment starts a counted round decided as Rovara's own; every other case leaves the round to the owner, and nothing a comment says can change that.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FEEDBACK_AUTONOMY_ACTOR_ID, FEEDBACK_AUTO_ROUNDS_MAX, FEEDBACK_CI_CHECKS_MAX, WorkflowFeedbackApprovalBindingSchema, WorkflowFeedbackDecisionSchema, WorkflowSnapshotSchema, WorkflowTransitionError,
  createCandidateManifest, createWorkflowSnapshot, decideWorkflowFeedbackFindings, feedbackCardCiFailures, feedbackCiFailuresDigest, feedbackDecidedByText, feedbackFixedReply,
  recordWorkflowFeedbackCiFailures, recordWorkflowPullRequestUpdate, requestWorkflowFeedbackReview, startWorkflowFix, workflowFixRoundsLeft,
  type WorkflowProgram, type WorkflowSnapshot,
} from "@agentx/contracts";

const at = "2026-10-26T12:00:00.000Z";
const OWNER = "a".repeat(64);
const TASK_ID = "00000000-0000-4000-8000-0000000000a1";
const REQUEST = "11111111-2222-4333-8444-555555555555";
const hash = (letter: string) => letter.repeat(64);
const HEAD = "a".repeat(40);
const PROGRAM: WorkflowProgram = { steps: [
  { id: "plan", kind: "plan" }, { id: "plan_critic", kind: "plan_critic" }, { id: "build", kind: "build" }, { id: "check", kind: "check" },
  { id: "review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "build", maxRounds: 3 } }, { id: "pull_request", kind: "pull_request" },
] };

interface CommentSpec { id: string; author: string; kind?: "REVIEW_COMMENT" | "DISCUSSION" | "REVIEW"; threadId?: string }
interface FindingSpec { id: string; commentIds: string[]; assessment?: "ACTIONABLE" | "STALE" | "TECHNICALLY_INCORRECT" | "NEEDS_OWNER_DECISION"; recommended?: boolean }

/** A version 2 task waiting for the merge, with a complete feedback review waiting for a decision. */
export function pendingCard(options: { comments?: CommentSpec[]; findings?: FindingSpec[]; extra?: Record<string, unknown>; version?: "1.0.0" | "1.1.0" } = {}): { workflow: WorkflowSnapshot; reviewDigest: string; proposalDigest: string; bundleDigest: string } {
  const version = options.version ?? "1.1.0";
  const comments = options.comments ?? [{ id: "review_comment:1", author: "maya", threadId: "thread-1" }];
  const findings = options.findings ?? [{ id: "f1", commentIds: comments.map((comment) => comment.id) }];
  const candidate = createCandidateManifest([{ repositoryId: "payments", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
  const bundleDigest = hash("e");
  const bundleRef = {
    schemaVersion: 1 as const, taskId: TASK_ID, repositoryId: "payments", number: 7, headSha: HEAD, headTreeSha: "b".repeat(40), candidateDigest: candidate.digest,
    commentSetDigest: hash("c"), sha256: bundleDigest, objectKey: `tasks/${TASK_ID}/feedback/${bundleDigest}.json`, producer: "agentx-github-reconciler", version: "1", recordedAt: at,
    comments: comments.map((comment, index) => ({
      id: comment.id, ...(comment.threadId === undefined ? {} : { threadId: comment.threadId }), kind: comment.kind ?? "REVIEW_COMMENT" as const,
      url: `https://github.com/acme/payments/pull/7#discussion_r${String(index + 1)}`, author: comment.author, updatedAt: at, bodyDigest: createHash("sha256").update(comment.id).digest("hex"), bodyBytes: 7,
    })),
  };
  const findingRefs = findings.map((finding) => ({
    id: finding.id, bundleDigest, commentIds: finding.commentIds, priority: "SHOULD_FIX" as const, assessment: finding.assessment ?? "ACTIONABLE" as const, recommended: finding.recommended ?? true,
  }));
  const reviewDigest = hash("b");
  const proposalDigest = hash("d");
  const reviewRef = {
    schemaVersion: 1 as const, taskId: TASK_ID, workflowRevision: 4, operationMode: "FEEDBACK_REVIEW" as const, qualification: "AI_GENERATED_ADVISORY" as const, sha256: reviewDigest,
    objectKey: `tasks/${TASK_ID}/reviews/${reviewDigest}.json`, proposalDigest, taskRequirementsDigest: hash("a"),
    candidateBindings: [{ repositoryId: "payments", number: 7, headSha: HEAD, candidateDigest: candidate.digest, commentSetDigest: hash("c"), bundleDigest }],
    operationId: REQUEST, provider: "scripted", version: "1", status: "COMPLETE" as const, bundleDigests: [bundleDigest], findingRefs, recordedAt: at,
  };
  const base = WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId: TASK_ID, ownerId: OWNER, now: at, definitionVersion: version, ...(version === "1.1.0" ? { program: PROGRAM } : {}) }),
    revision: 9, stage: "WAIT_FOR_MERGE", state: "WAITING", ...(version === "1.1.0" ? { programStepId: "pull_request" } : {}), candidate,
    verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: "test", recordedAt: at, results: [{ checkId: "unit", status: "PASS" }] },
    reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: REQUEST, candidateDigest: candidate.digest, role, provider: "scripted", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: at })),
    pullRequests: [{ repositoryId: "payments", number: 7, headSha: HEAD, candidateDigest: candidate.digest, required: true, state: "OPEN", url: "https://github.com/acme/payments/pull/7" }],
    ...options.extra,
  });
  const workflow = requestWorkflowFeedbackReview(base, { bundleRefs: [bundleRef], reviewRef }, at);
  return { workflow, reviewDigest, proposalDigest, bundleDigest };
}

const autonomy = { level: "prepare" as const, recipeDigest: hash("9") };
const rovara = { actorId: FEEDBACK_AUTONOMY_ACTOR_ID, role: "ROVARA_AUTONOMY" as const, autonomy };
const owner = { actorId: OWNER, role: "TASK_OWNER" as const };
const requestFor = (card: ReturnType<typeof pendingCard>, extra: Record<string, unknown> = {}) => ({
  requestId: REQUEST, expectedRevision: card.workflow.revision, reviewDigest: card.reviewDigest, proposalDigest: card.proposalDigest, bundleDigests: [card.bundleDigest],
  selectedFindingIds: card.workflow.feedbackReview!.reviewRef!.findingRefs.map((finding) => finding.id), decision: "APPROVE" as const, ...extra,
});

describe("Rovara's own decision", () => {
  it("approves the round as Rovara (never as the owner), counts it, marks the fix, and starts the review rounds from none", () => {
    const card = pendingCard({ extra: { programRounds: { review: 2 } } });
    const next = decideWorkflowFeedbackFindings(card.workflow, requestFor(card), rovara, at);
    expect(next).toMatchObject({ stage: "IMPLEMENT", state: "READY", fixSource: "feedback", fixRounds: { ci: 0, conflict: 0, feedbackAuto: 1 }, programStepId: "build", feedbackReview: { status: "APPROVED" } });
    expect(next.feedbackDecisions).toEqual([expect.objectContaining({ decision: "APPROVE", actorId: "rovara", actorRole: "ROVARA_AUTONOMY", autonomy, selectedFindingIds: ["f1"], selectedCommentIds: ["review_comment:1"] })]);
    expect(next.programRounds).toBeUndefined();
    expect(WorkflowSnapshotSchema.safeParse(next).success).toBe(true);
    expect(workflowFixRoundsLeft(next, "feedback")).toBe(FEEDBACK_AUTO_ROUNDS_MAX - 1);
  });

  it("a person's decision is never counted and sets no fix mark", () => {
    const card = pendingCard();
    const next = decideWorkflowFeedbackFindings(card.workflow, requestFor(card), owner, at);
    expect(next.fixRounds).toBeUndefined();
    expect(next.fixSource).toBeUndefined();
    expect(next.feedbackDecisions?.[0]).toMatchObject({ actorId: OWNER, actorRole: "TASK_OWNER" });
    expect(next.feedbackDecisions?.[0]?.autonomy).toBeUndefined();
  });

  it("refuses the fourth automatic round, whatever else holds", () => {
    const card = pendingCard({ extra: { fixRounds: { ci: 0, conflict: 0, feedbackAuto: FEEDBACK_AUTO_ROUNDS_MAX } } });
    expect(() => decideWorkflowFeedbackFindings(card.workflow, requestFor(card), rovara, at)).toThrow(WorkflowTransitionError);
    // The owner can still decide the same card.
    expect(decideWorkflowFeedbackFindings(card.workflow, requestFor(card), owner, at).stage).toBe("IMPLEMENT");
  });

  it("can only approve, with no note, as 'rovara' under prepare or run, on the revision it read", () => {
    const card = pendingCard();
    for (const decision of ["REQUEST_CHANGES", "DISMISS"] as const) {
      expect(() => decideWorkflowFeedbackFindings(card.workflow, requestFor(card, { decision, selectedFindingIds: [], ownerNote: "no" }), rovara, at)).toThrow(WorkflowTransitionError);
    }
    expect(() => decideWorkflowFeedbackFindings(card.workflow, requestFor(card, { ownerNote: "also do this" }), rovara, at)).toThrow(WorkflowTransitionError);
    expect(() => decideWorkflowFeedbackFindings(card.workflow, requestFor(card), { ...rovara, actorId: OWNER } as never, at)).toThrow(WorkflowTransitionError);
    expect(() => decideWorkflowFeedbackFindings(card.workflow, requestFor(card), { ...rovara, autonomy: { level: "suggest" } } as never, at)).toThrow(WorkflowTransitionError);
    expect(() => decideWorkflowFeedbackFindings(card.workflow, requestFor(card, { expectedRevision: card.workflow.revision - 1 }), rovara, at)).toThrow(WorkflowTransitionError);
    expect(() => decideWorkflowFeedbackFindings({ ...card.workflow, state: "RUNNING" }, requestFor(card), rovara, at)).toThrow(WorkflowTransitionError);
  });

  it("is the only way to record the role: a stored decision must be Rovara's own, with its autonomy, approving", () => {
    const card = pendingCard();
    const decided = decideWorkflowFeedbackFindings(card.workflow, requestFor(card), rovara, at).feedbackDecisions![0]!;
    expect(WorkflowFeedbackDecisionSchema.safeParse(decided).success).toBe(true);
    for (const forged of [
      { ...decided, actorId: OWNER },
      { ...decided, actorRole: "TASK_OWNER" },
      { ...decided, autonomy: undefined },
      { ...decided, decision: "DISMISS", ownerNote: "x", selectedFindingIds: [], selectedCommentIds: [], candidates: [] },
      { ...decided, actorRole: "TASK_OWNER", actorId: "rovara", autonomy: undefined },
      { ...decided, actorId: "rovara2" },
    ]) {
      expect(WorkflowFeedbackDecisionSchema.safeParse(forged).success).toBe(false);
    }
    const ownersWithAutonomy = decideWorkflowFeedbackFindings(card.workflow, requestFor(card), owner, at).feedbackDecisions![0]!;
    expect(WorkflowFeedbackDecisionSchema.safeParse({ ...ownersWithAutonomy, autonomy }).success).toBe(false);
  });

  it("is bound by an approval that names the autonomy", () => {
    const base = {
      taskId: TASK_ID, requestId: REQUEST, ownerId: OWNER, decisionWorkflowRevision: 9, activeWorkflowRevision: 11, reviewDigest: hash("b"), proposalDigest: hash("d"), bundleDigests: [hash("e")],
      candidateDigest: hash("f"), selectedFindingIds: ["f1"], selectedCommentIds: ["review_comment:1"],
    };
    expect(WorkflowFeedbackApprovalBindingSchema.safeParse(base).success).toBe(true);
    expect(WorkflowFeedbackApprovalBindingSchema.safeParse({ ...base, autonomy, ciFailuresDigest: hash("1") }).success).toBe(true);
    expect(WorkflowFeedbackApprovalBindingSchema.safeParse({ ...base, autonomy: { level: "suggest" } }).success).toBe(false);
    expect(WorkflowFeedbackApprovalBindingSchema.safeParse({ ...base, autonomy: { level: "run", extra: true } }).success).toBe(false);
  });

  it("the round is a fix like the others: a failed push or a landed push drops the mark and keeps the count", () => {
    const card = pendingCard();
    const next = decideWorkflowFeedbackFindings(card.workflow, requestFor(card), rovara, at);
    const fixed = createCandidateManifest([{ repositoryId: "payments", commitSha: "f".repeat(40), treeSha: "c".repeat(40), baseCommitSha: "e".repeat(40) }]);
    const pushing = WorkflowSnapshotSchema.parse({
      ...next, revision: 14, stage: "PULL_REQUEST", state: "RUNNING", candidate: fixed,
      verification: { candidateDigest: fixed.digest, producer: "broker", environmentId: "test", recordedAt: at, results: [{ checkId: "unit", status: "PASS" }] },
      reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: REQUEST, candidateDigest: fixed.digest, role, provider: "scripted", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: at })),
    });
    const landed = recordWorkflowPullRequestUpdate(pushing, { updates: [{ repositoryId: "payments", number: 7, headSha: "9".repeat(40), headTreeSha: "c".repeat(40) }], now: at });
    expect(landed).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", fixRounds: { feedbackAuto: 1 } });
    expect(landed.fixSource).toBeUndefined();
    expect(landed.feedbackDecisions).toHaveLength(1);
  });

  it("works on version 1 snapshots too (the after-PR fields are allowed there) and starts no round by startWorkflowFix while the card waits", () => {
    const card = pendingCard({ version: "1.0.0" });
    expect(decideWorkflowFeedbackFindings(card.workflow, requestFor(card), rovara, at)).toMatchObject({ definitionVersion: "1.0.0", fixRounds: { feedbackAuto: 1 } });
    expect(() => startWorkflowFix(pendingCard().workflow, { source: "ci", problems: ["test"], now: at })).toThrow(/card/);
  });
});

describe("the failing checks on the owner's card", () => {
  it("are added while the card waits, bump the revision, and are taken off when CI is green again", () => {
    const card = pendingCard();
    const added = recordWorkflowFeedbackCiFailures(card.workflow, { checks: ["test", "lint"], now: at });
    expect(added).toMatchObject({ revision: card.workflow.revision + 1, feedbackCiFailures: { checks: ["lint", "test"], digest: feedbackCiFailuresDigest(["test", "lint"]), evidenceRevision: card.workflow.revision + 1 } });
    expect(feedbackCardCiFailures(added)?.checks).toEqual(["lint", "test"]);
    expect(WorkflowSnapshotSchema.safeParse(added).success).toBe(true);
    // The same set again is no change; a different set is one; none takes them off.
    expect(() => recordWorkflowFeedbackCiFailures(added, { checks: ["lint", "test"], now: at })).toThrow(WorkflowTransitionError);
    expect(recordWorkflowFeedbackCiFailures(added, { checks: ["test"], now: at }).feedbackCiFailures?.checks).toEqual(["test"]);
    const cleared = recordWorkflowFeedbackCiFailures(added, { checks: [], now: at });
    expect(cleared.feedbackCiFailures).toBeUndefined();
    expect(cleared.revision).toBe(added.revision + 1);
    expect(() => recordWorkflowFeedbackCiFailures(cleared, { checks: [], now: at })).toThrow(WorkflowTransitionError);
  });

  it("are added only while a complete review waits for a decision, and never after it", () => {
    const card = pendingCard();
    expect(() => recordWorkflowFeedbackCiFailures({ ...card.workflow, state: "RUNNING" }, { checks: ["test"], now: at })).toThrow(WorkflowTransitionError);
    const decided = decideWorkflowFeedbackFindings(card.workflow, requestFor(card), owner, at);
    expect(() => recordWorkflowFeedbackCiFailures(decided, { checks: ["test"], now: at })).toThrow(WorkflowTransitionError);
    expect(() => recordWorkflowFeedbackCiFailures({ ...pendingCard().workflow, feedbackReview: undefined }, { checks: ["test"], now: at })).toThrow(WorkflowTransitionError);
    expect(() => recordWorkflowFeedbackCiFailures(card.workflow, { checks: Array.from({ length: FEEDBACK_CI_CHECKS_MAX + 1 }, (_, index) => `check ${String(index)}`), now: at })).toThrow(WorkflowTransitionError);
    expect(() => recordWorkflowFeedbackCiFailures(card.workflow, { checks: ["x".repeat(201)], now: at })).toThrow(WorkflowTransitionError);
  });

  it("are carried into the decision that follows (the owner's or Rovara's), so the approval is bound to what the card showed", () => {
    const withCi = recordWorkflowFeedbackCiFailures(pendingCard().workflow, { checks: ["test"], now: at });
    const card = { workflow: withCi, reviewDigest: hash("b"), proposalDigest: hash("d"), bundleDigest: hash("e") };
    for (const actor of [owner, rovara]) {
      const decided = decideWorkflowFeedbackFindings(withCi, requestFor(card), actor, at);
      expect(decided.feedbackDecisions?.[0]?.ciFailures).toEqual(withCi.feedbackCiFailures);
      expect(decided.feedbackCiFailures).toBeUndefined();
    }
    // A decision made against the card as it was before the failures were added is stale.
    const before = pendingCard();
    expect(() => decideWorkflowFeedbackFindings(withCi, requestFor(before), owner, at)).toThrow(WorkflowTransitionError);
    expect(() => decideWorkflowFeedbackFindings(withCi, requestFor(before), rovara, at)).toThrow(WorkflowTransitionError);
  });

  it("a card that is replaced by a new collection starts with none", () => {
    const withCi = recordWorkflowFeedbackCiFailures(pendingCard().workflow, { checks: ["test"], now: at });
    const refs = withCi.feedbackReview!.bundleRefs;
    expect(feedbackCardCiFailures({ ...withCi, feedbackReview: { status: "COLLECTING", bundleRefs: refs, threadObservations: [] } })).toBeUndefined();
  });
});

describe("what Rovara says", () => {
  it("is exact", () => {
    expect(feedbackDecidedByText("prepare")).toBe("Decided by Rovara (autonomy: prepare)");
    expect(feedbackDecidedByText("run")).toBe("Decided by Rovara (autonomy: run)");
    expect(feedbackFixedReply("0123456789abcdef0123456789abcdef01234567")).toBe("Fixed in 0123456.");
  });
});
