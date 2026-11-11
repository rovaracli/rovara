// Rovara Code (Plan 6 Task 16): fixing review comments under autonomy. The contract (Rovara's own decision, its rounds, the failing checks folded into the owner's card), the rule
// that says when a round may be fixed without asking (writers only, actionable, under the cap, autonomy prepare or run), and the feedback slot of merge tracking over a fake GitHub:
// a writer's actionable comment starts a counted round decided as Rovara's own; every other case leaves the round to the owner, and nothing a comment says can change that.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CI_OUTPUT_BLOCK_HEADER, FEEDBACK_AUTONOMY_ACTOR_ID, FEEDBACK_AUTO_ROUNDS_MAX, FEEDBACK_CI_CHECKS_MAX, WorkflowFeedbackApprovalBindingSchema, WorkflowFeedbackDecisionSchema, WorkflowTransitionError, createCandidateManifest, feedbackCiFailuresDigest, feedbackDecidedByText, feedbackFixedReply, type WorkflowFeedbackActor, type WorkflowProgram } from "@rovara-code/contracts";
import { WorkflowSnapshotSchema, createWorkflowSnapshot, decideWorkflowFeedbackFindings, feedbackCardCiFailures, recordWorkflowFeedbackCiFailures, recordWorkflowPullRequestUpdate, requestWorkflowFeedbackReview, startWorkflowFix, workflowFixRoundsLeft, type WorkflowSnapshot } from "@agentx/cloud-contracts";
import { GithubMergeRateLimitError } from "../../packages/broker/src/github-app.js";
import { PERMISSION_LOOKUPS_MAX, TrackingRequestCapError, trackPullRequest } from "../../packages/broker/src/rovara-code/merge-tracking.js";
import { readCiEvidence, taskAutonomy, taskAutonomyBinding, uninstallCiFixDecider, installCiFixDecider } from "../../packages/broker/src/rovara-code/ci-fix.js";
import { FEEDBACK_REPLY_ATTEMPTS_MAX, autoFixableRound, standingKey, autonomyStillHolds, feedbackApprovalMatchesDecision, feedbackReplyItems, installFeedbackDecider, sendFeedbackReplies, uninstallFeedbackDecider } from "../../packages/broker/src/rovara-code/feedback-autonomy.js";
import { githubCodeHost } from "../../packages/broker/src/plugins/code-host/github/index.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import type { GithubMergeReadBudget } from "../../packages/broker/src/aws/workflow-merge-recovery.js";
import { FakeGithub, SESSION_ID, status, world, type TrackingWorld } from "../support/rovara-code-tracking.js";
import { TEST_ORG } from "../support/orgs.js";

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

interface CommentSpec { id: string; author: string; kind?: "REVIEW_COMMENT" | "DISCUSSION" | "REVIEW"; threadId?: string; repositoryId?: "payments" | "web" }
interface FindingSpec { id: string; commentIds: string[]; assessment?: "ACTIONABLE" | "STALE" | "TECHNICALLY_INCORRECT" | "NEEDS_OWNER_DECISION"; recommended?: boolean }

const REPOSITORIES = { payments: { number: 7, tree: "b".repeat(40), commit: "d".repeat(40), bundle: hash("e"), set: hash("c") }, web: { number: 8, tree: "9".repeat(40), commit: "8".repeat(40), bundle: hash("f"), set: hash("7") } } as const;

/** A version 2 task waiting for the merge, with a complete feedback review waiting for a decision. Comments are on `payments` (pull request 7) unless a spec says `web` (pull request 8). */
export function pendingCard(options: { comments?: CommentSpec[]; findings?: FindingSpec[]; extra?: Record<string, unknown>; version?: "1.0.0" | "1.1.0" } = {}): { workflow: WorkflowSnapshot; reviewDigest: string; proposalDigest: string; bundleDigest: string; bundleDigests: string[] } {
  const version = options.version ?? "1.1.0";
  const comments = options.comments ?? [{ id: "review_comment:1", author: "maya", threadId: "thread-1" }];
  const findings = options.findings ?? [{ id: "f1", commentIds: comments.map((comment) => comment.id) }];
  const repositories = (["payments", "web"] as const).filter((name) => comments.some((comment) => (comment.repositoryId ?? "payments") === name));
  const candidate = createCandidateManifest(repositories.map((name) => ({ repositoryId: name, commitSha: REPOSITORIES[name].commit, treeSha: REPOSITORIES[name].tree, baseCommitSha: "e".repeat(40) })));
  const headOf = (name: "payments" | "web") => (name === "payments" ? HEAD : "c".repeat(40));
  const bundleRefs = repositories.map((name) => ({
    schemaVersion: 1 as const, taskId: TASK_ID, repositoryId: name, number: REPOSITORIES[name].number, headSha: headOf(name), headTreeSha: REPOSITORIES[name].tree, candidateDigest: candidate.digest,
    commentSetDigest: REPOSITORIES[name].set, sha256: REPOSITORIES[name].bundle, objectKey: `tasks/${TASK_ID}/feedback/${REPOSITORIES[name].bundle}.json`, producer: "agentx-github-reconciler", version: "1", recordedAt: at,
    comments: comments.filter((comment) => (comment.repositoryId ?? "payments") === name).map((comment, index) => ({
      id: comment.id, ...(comment.threadId === undefined ? {} : { threadId: comment.threadId }), kind: comment.kind ?? "REVIEW_COMMENT" as const,
      url: `https://github.com/acme/${name}/pull/${String(REPOSITORIES[name].number)}#discussion_r${String(index + 1)}`, author: comment.author, updatedAt: at, bodyDigest: createHash("sha256").update(comment.id).digest("hex"), bodyBytes: 7,
    })),
  }));
  const bundleOfComment = (id: string) => REPOSITORIES[comments.find((comment) => comment.id === id)?.repositoryId ?? "payments"].bundle;
  const findingRefs = findings.map((finding) => ({
    id: finding.id, bundleDigest: bundleOfComment(finding.commentIds[0]!), commentIds: finding.commentIds, priority: "SHOULD_FIX" as const, assessment: finding.assessment ?? "ACTIONABLE" as const, recommended: finding.recommended ?? true,
  }));
  const reviewDigest = hash("b");
  const proposalDigest = hash("d");
  const reviewRef = {
    schemaVersion: 1 as const, taskId: TASK_ID, workflowRevision: 4, operationMode: "FEEDBACK_REVIEW" as const, qualification: "AI_GENERATED_ADVISORY" as const, sha256: reviewDigest,
    objectKey: `tasks/${TASK_ID}/reviews/${reviewDigest}.json`, proposalDigest, taskRequirementsDigest: hash("a"),
    candidateBindings: repositories.map((name) => ({ repositoryId: name, number: REPOSITORIES[name].number, headSha: headOf(name), candidateDigest: candidate.digest, commentSetDigest: REPOSITORIES[name].set, bundleDigest: REPOSITORIES[name].bundle })),
    operationId: REQUEST, provider: "scripted", version: "1", status: "COMPLETE" as const, bundleDigests: repositories.map((name) => REPOSITORIES[name].bundle), findingRefs, recordedAt: at,
  };
  const base = WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId: TASK_ID, ownerId: OWNER, now: at, definitionVersion: version, ...(version === "1.1.0" ? { program: PROGRAM } : {}) }),
    revision: 9, stage: "WAIT_FOR_MERGE", state: "WAITING", ...(version === "1.1.0" ? { programStepId: "pull_request" } : {}), candidate,
    verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: "test", recordedAt: at, results: [{ checkId: "unit", status: "PASS" }] },
    reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: REQUEST, candidateDigest: candidate.digest, role, provider: "scripted", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: at })),
    pullRequests: repositories.map((name) => ({ repositoryId: name, number: REPOSITORIES[name].number, headSha: headOf(name), candidateDigest: candidate.digest, required: true, state: "OPEN", url: `https://github.com/acme/${name}/pull/${String(REPOSITORIES[name].number)}` })),
    ...options.extra,
  });
  const workflow = requestWorkflowFeedbackReview(base, { bundleRefs, reviewRef }, at);
  return { workflow, reviewDigest, proposalDigest, bundleDigest: REPOSITORIES[repositories[0]!].bundle, bundleDigests: reviewRef.bundleDigests };
}

const autonomy = { level: "prepare" as const, recipeDigest: hash("9") };
const rovara: WorkflowFeedbackActor = { actorId: FEEDBACK_AUTONOMY_ACTOR_ID, role: "ROVARA_AUTONOMY", autonomy };
const owner: WorkflowFeedbackActor = { actorId: OWNER, role: "TASK_OWNER" };
const requestFor = (card: ReturnType<typeof pendingCard>, extra: Record<string, unknown> = {}) => ({
  requestId: REQUEST, expectedRevision: card.workflow.revision, reviewDigest: card.reviewDigest, proposalDigest: card.proposalDigest, bundleDigests: card.bundleDigests,
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
    const card = { workflow: withCi, reviewDigest: hash("b"), proposalDigest: hash("d"), bundleDigest: hash("e"), bundleDigests: [hash("e")] };
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

// ---- when a round may be fixed without asking

const standing = (permission: "admin" | "write" | "read" | "none", userType?: string) => ({ permission, ...(userType === undefined ? {} : { userType }) });
const standings = (entries: Record<string, ReturnType<typeof standing>>) => new Map(Object.entries(entries).map(([login, value]) => [standingKey("payments", login), value]));
const roundOf = (comments: Array<{ id: string; author: string; repositoryId?: string }>, findings: Array<{ assessment?: string; recommended?: boolean }> = [{}]) =>
  ({ comments: comments.map((comment) => ({ repositoryId: "payments", ...comment })), findings: findings.map((finding) => ({ assessment: finding.assessment ?? "ACTIONABLE", recommended: finding.recommended ?? true })) });
const NO_ROUNDS = { ci: 0, conflict: 0, feedbackAuto: 0 };

describe("autoFixableRound", () => {
  const maya = [{ id: "c1", author: "maya" }];
  it("is true only for a writer's actionable comments, under prepare or run, with rounds left", () => {
    for (const level of ["prepare", "run"] as const) {
      expect(autoFixableRound(roundOf(maya), standings({ maya: standing("write") }), level, NO_ROUNDS)).toBe(true);
      expect(autoFixableRound(roundOf(maya), standings({ maya: standing("admin", "User") }), level, NO_ROUNDS)).toBe(true);
    }
    expect(autoFixableRound(roundOf(maya), standings({ maya: standing("write") }), "prepare", { ...NO_ROUNDS, feedbackAuto: FEEDBACK_AUTO_ROUNDS_MAX - 1 })).toBe(true);
  });

  it("suggest waits for everything", () => {
    expect(autoFixableRound(roundOf(maya), standings({ maya: standing("admin") }), "suggest", NO_ROUNDS)).toBe(false);
  });

  it("the fourth automatic round waits", () => {
    expect(autoFixableRound(roundOf(maya), standings({ maya: standing("write") }), "run", { ...NO_ROUNDS, feedbackAuto: FEEDBACK_AUTO_ROUNDS_MAX })).toBe(false);
    // Rounds of other kinds do not count against it.
    expect(autoFixableRound(roundOf(maya), standings({ maya: standing("write") }), "run", { ci: 3, conflict: 2, feedbackAuto: 0 })).toBe(true);
  });

  it("a read-only member, a triager and a stranger wait", () => {
    for (const permission of ["read", "none"] as const) expect(autoFixableRound(roundOf(maya), standings({ maya: standing(permission) }), "prepare", NO_ROUNDS)).toBe(false);
  });

  it("one comment from someone without write access beside a writer's sends the whole round to the owner, however the findings cite them", () => {
    const set = [{ id: "c1", author: "maya" }, { id: "c2", author: "stranger" }];
    expect(autoFixableRound(roundOf(set), standings({ maya: standing("write"), stranger: standing("none") }), "prepare", NO_ROUNDS)).toBe(false);
    // A person nobody looked up counts as unknown, and unknown is not a writer.
    expect(autoFixableRound(roundOf(set), standings({ maya: standing("write") }), "prepare", NO_ROUNDS)).toBe(false);
    expect(autoFixableRound(roundOf(set), standings({ maya: standing("write"), stranger: standing("write") }), "prepare", NO_ROUNDS)).toBe(true);
  });

  it("a bot never counts, by its name or by what GitHub says it is, whatever its permission", () => {
    expect(autoFixableRound(roundOf([{ id: "c1", author: "dependabot[bot]" }]), standings({ "dependabot[bot]": standing("write") }), "prepare", NO_ROUNDS)).toBe(false);
    expect(autoFixableRound(roundOf([{ id: "c1", author: "reviewbot" }]), standings({ reviewbot: standing("write", "Bot") }), "prepare", NO_ROUNDS)).toBe(false);
    expect(autoFixableRound(roundOf([{ id: "c1", author: "acme-org" }]), standings({ "acme-org": standing("admin", "Organization") }), "prepare", NO_ROUNDS)).toBe(false);
  });

  it("every finding must be actionable and recommended (a fix to make); any other assessment sends the round to the owner", () => {
    for (const assessment of ["ALREADY_ADDRESSED", "STALE", "TECHNICALLY_INCORRECT", "OUT_OF_SCOPE", "CONFLICTING", "NEEDS_OWNER_DECISION"]) {
      expect(autoFixableRound(roundOf(maya, [{}, { assessment }]), standings({ maya: standing("write") }), "prepare", NO_ROUNDS), assessment).toBe(false);
    }
    expect(autoFixableRound(roundOf(maya, [{ recommended: false }]), standings({ maya: standing("write") }), "prepare", NO_ROUNDS)).toBe(false);
  });

  it("an empty round (no comments, or no findings) is not fixed on its own", () => {
    expect(autoFixableRound(roundOf([]), standings({}), "prepare", NO_ROUNDS)).toBe(false);
    expect(autoFixableRound({ comments: maya.map((comment) => ({ ...comment, repositoryId: "payments" })), findings: [] }, standings({ maya: standing("write") }), "prepare", NO_ROUNDS)).toBe(false);
  });

  it("logins are compared without regard to case, as GitHub does", () => {
    expect(autoFixableRound(roundOf([{ id: "c1", author: "Maya" }]), standings({ maya: standing("write") }), "prepare", NO_ROUNDS)).toBe(true);
  });
});

// ---- the feedback slot of merge tracking

const TRACKED_APPROVAL = hash("9");
const GHP = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`;
const redCheck = (overrides: Record<string, unknown> = {}) => ({ name: "test", status: "completed" as const, conclusion: "failure" as const, required: false, url: "https://github.com/acme/payments/actions/runs/1/job/4242", jobId: "4242", appId: 15_368, ...overrides });

class FeedbackGithub extends FakeGithub {
  readonly types = new Map<string, string>();
  readonly logs = new Map<string, string>([["4242", `2026-10-26T11:00:00.0000000Z Error: boom\n2026-10-26T11:00:01.0000000Z leaked ${GHP}\n`]]);
  throwFor: string | undefined;
  override async getRepositoryPermission(url: string, login: string, scope: unknown, budget?: GithubMergeReadBudget) {
    if (login === this.throwFor) { this.calls.push(`permission:${login}`); throw new Error("GitHub is down"); }
    const own = this.permissions.get(`${url}|${login}`);
    if (own !== undefined) {
      this.calls.push(`permission:${login}@${url.split("/").at(-1)!}`);
      budget?.beforeRequest();
      return own;
    }
    return super.getRepositoryPermission(url, login, scope, budget);
  }
  async getRepositoryStanding(url: string, login: string, scope: unknown, budget?: GithubMergeReadBudget) {
    const permission = await this.getRepositoryPermission(url, login, scope, budget);
    const userType = this.types.get(login);
    return { permission, ...(userType === undefined ? {} : { userType }) };
  }
  async getJobLogTail(_url: string, jobId: string): Promise<string | undefined> { this.calls.push(`log:${jobId}`); return this.logs.get(jobId); }
}

function feedbackWorld(options: { pullRequests?: Array<{ repositoryId: string; number: number }>; card?: ReturnType<typeof pendingCard>; autonomy?: "suggest" | "prepare" | "run"; red?: boolean; roundCheck?: boolean | (() => Promise<boolean>) } = {}) {
  const github = new FeedbackGithub();
  const w = world({ sessionId: SESSION_ID, ...(options.pullRequests === undefined ? {} : { pullRequests: options.pullRequests.map((pr) => ({ ...pr, headSha: pr.repositoryId === "web" ? "c".repeat(40) : HEAD })) }) });
  const fixture = Object.assign(w, { github });
  (fixture.deps as { github: unknown }).github = github;
  for (const pr of options.pullRequests ?? [{ repositoryId: "payments", number: 7 }]) github.statuses.set(pr.number, status({ number: pr.number, headSha: pr.repositoryId === "web" ? "c".repeat(40) : HEAD, draft: false, ...(options.red === true && pr.number === 7 ? { checks: [redCheck()] } : {}) }));
  fixture.setTask({ workflow: (options.card ?? pendingCard()).workflow });
  (fixture.deps as { autonomyBinding?: unknown }).autonomyBinding = async () => ({ autonomy: options.autonomy ?? "prepare", recipeDigest: TRACKED_APPROVAL });
  const check = options.roundCheck;
  (fixture.deps as { feedbackRoundCheck?: unknown }).feedbackRoundCheck = check === undefined ? async () => true : typeof check === "boolean" ? async () => check : check;
  github.permissions.set("maya", "write");
  return fixture;
}
const storedWorkflow = (w: TrackingWorld): WorkflowSnapshot => WorkflowSnapshotSchema.parse(w.task().workflow);
const dispatchRows = (w: TrackingWorld) => w.db.find((item) => item.pk === "WORKFLOW_DISPATCH");
const milestonesOf = (w: TrackingWorld, kind: string) => w.db.find((item) => item.entityType === "CODE_MILESTONE" && item.kind === kind);
const lookups = (w: { github: FakeGithub }) => w.github.calls.filter((call) => call.startsWith("permission:"));

describe("the feedback slot of merge tracking", () => {
  beforeEach(() => installFeedbackDecider());
  afterEach(() => {
    uninstallFeedbackDecider();
    uninstallCiFixDecider();
  });

  it("a writer's actionable comment is fixed on Rovara's own decision: a counted round, decided as Rovara's, with the run's dispatch row and its milestone", async () => {
    const w = feedbackWorld();
    expect(await trackPullRequest(w.deps, TASK_ID)).toBe("changed");
    const next = storedWorkflow(w);
    expect(next).toMatchObject({ revision: 11, stage: "IMPLEMENT", state: "READY", fixSource: "feedback", fixRounds: { ci: 0, conflict: 0, feedbackAuto: 1 }, programStepId: "build", feedbackReview: { status: "APPROVED" } });
    expect(next.feedbackDecisions).toEqual([expect.objectContaining({
      actorId: "rovara", actorRole: "ROVARA_AUTONOMY", decision: "APPROVE", autonomy: { level: "prepare", recipeDigest: TRACKED_APPROVAL }, selectedFindingIds: ["f1"], selectedCommentIds: ["review_comment:1"],
    })]);
    expect(dispatchRows(w)).toEqual([expect.objectContaining({ sk: `${TASK_ID}#11`, kind: "IMPLEMENT", workflowRevision: 11, attempts: 0 })]);
    expect(milestonesOf(w, "fixing")).toEqual([expect.objectContaining({ text: "Rovara is fixing the review comments on its own (round 1 of 3).", pullRequests: [expect.objectContaining({ number: 7 })] })]);
    expect(lookups(w)).toEqual(["permission:maya"]);
    // Another pass finds the task busy and does nothing more.
    w.setNow(w.now() + 120_000);
    expect(await trackPullRequest(w.deps, TASK_ID)).toBe("unchanged");
    expect(storedWorkflow(w).revision).toBe(11);
    expect(dispatchRows(w)).toHaveLength(1);
  });

  it("autonomy run decides the same way, under its own name", async () => {
    const w = feedbackWorld({ autonomy: "run" });
    await trackPullRequest(w.deps, TASK_ID);
    expect(storedWorkflow(w).feedbackDecisions?.[0]?.autonomy?.level).toBe("run");
  });

  it("a read-only member's comment waits for the owner: nothing is decided, started or paid for", async () => {
    const w = feedbackWorld();
    w.github.permissions.set("maya", "read");
    await trackPullRequest(w.deps, TASK_ID);
    expect(storedWorkflow(w)).toMatchObject({ revision: 10, stage: "WAIT_FOR_MERGE", state: "WAITING", feedbackReview: { status: "PENDING" } });
    expect(dispatchRows(w)).toEqual([]);
    expect(milestonesOf(w, "fixing")).toEqual([]);
    expect(lookups(w)).toEqual(["permission:maya"]);
  });

  it("a non-collaborator's comment beside a collaborator's '+1' (cited alone by the model) sends the whole round to the owner", async () => {
    const card = pendingCard({
      comments: [{ id: "discussion:2", author: "maya", kind: "DISCUSSION" }, { id: "review_comment:1", author: "stranger", threadId: "t1" }],
      findings: [{ id: "f1", commentIds: ["discussion:2"] }, { id: "f2", commentIds: ["review_comment:1"] }],
    });
    const w = feedbackWorld({ card });
    await trackPullRequest(w.deps, TASK_ID);
    expect(storedWorkflow(w)).toMatchObject({ revision: 10, feedbackReview: { status: "PENDING" } });
    expect(dispatchRows(w)).toEqual([]);
    expect(lookups(w).sort()).toEqual(["permission:maya", "permission:stranger"]);
  });

  it("on a task with two repositories each author is looked up on the repository of their own comment: a writer on one and a reader on the other waits for the owner", async () => {
    const card = pendingCard({
      comments: [{ id: "review_comment:1", author: "bob", threadId: "t1", repositoryId: "payments" }, { id: "review_comment:2", author: "bob", threadId: "t2", repositoryId: "web" }],
      findings: [{ id: "f1", commentIds: ["review_comment:1"] }, { id: "f2", commentIds: ["review_comment:2"] }],
    });
    const w = feedbackWorld({ card, pullRequests: [{ repositoryId: "payments", number: 7 }, { repositoryId: "web", number: 8 }] });
    w.github.permissions.set("https://github.com/acme/payments|bob", "write");
    w.github.permissions.set("https://github.com/acme/web|bob", "read");
    await trackPullRequest(w.deps, TASK_ID);
    expect(storedWorkflow(w)).toMatchObject({ revision: 10, feedbackReview: { status: "PENDING" } });
    expect(dispatchRows(w)).toEqual([]);
    expect(w.github.calls.filter((call) => call.startsWith("permission:")).sort()).toEqual(["permission:bob@payments", "permission:bob@web"]);
    // Writer on both: decided.
    const both = feedbackWorld({ card, pullRequests: [{ repositoryId: "payments", number: 7 }, { repositoryId: "web", number: 8 }] });
    both.github.permissions.set("https://github.com/acme/payments|bob", "write");
    both.github.permissions.set("https://github.com/acme/web|bob", "write");
    await trackPullRequest(both.deps, TASK_ID);
    expect(storedWorkflow(both)).toMatchObject({ stage: "IMPLEMENT", state: "READY", fixSource: "feedback" });
  });

  it("the fourth automatic round waits for the owner, and a person's decision on it still works", async () => {
    const card = pendingCard({ extra: { fixRounds: { ci: 0, conflict: 0, feedbackAuto: FEEDBACK_AUTO_ROUNDS_MAX } } });
    const w = feedbackWorld({ card });
    await trackPullRequest(w.deps, TASK_ID);
    expect(storedWorkflow(w)).toMatchObject({ revision: 10, feedbackReview: { status: "PENDING" } });
    expect(lookups(w)).toEqual([]);
    expect(dispatchRows(w)).toEqual([]);
  });

  it("suggest waits for everything, and asks GitHub about nobody", async () => {
    const w = feedbackWorld({ autonomy: "suggest" });
    await trackPullRequest(w.deps, TASK_ID);
    expect(storedWorkflow(w)).toMatchObject({ revision: 10, feedbackReview: { status: "PENDING" } });
    expect(lookups(w)).toEqual([]);
    expect(dispatchRows(w)).toEqual([]);
  });

  it("a finding that is not actionable sends the round to the owner before anyone is looked up", async () => {
    const w = feedbackWorld({ card: pendingCard({ findings: [{ id: "f1", commentIds: ["review_comment:1"], assessment: "TECHNICALLY_INCORRECT", recommended: false }] }) });
    await trackPullRequest(w.deps, TASK_ID);
    expect(storedWorkflow(w).revision).toBe(10);
    expect(lookups(w)).toEqual([]);
  });

  it("a bot (by name, or as GitHub types it) waits for the owner", async () => {
    for (const [author, type] of [["renovate[bot]", undefined], ["reviewbot", "Bot"]] as const) {
      const w = feedbackWorld({ card: pendingCard({ comments: [{ id: "review_comment:1", author, threadId: "t1" }] }) });
      w.github.permissions.set(author, "write");
      if (type !== undefined) w.github.types.set(author, type);
      await trackPullRequest(w.deps, TASK_ID);
      expect(storedWorkflow(w), author).toMatchObject({ revision: 10, feedbackReview: { status: "PENDING" } });
      // A bot known by its name is not looked up at all (GitHub would refuse such a login).
      if (type === undefined) expect(lookups(w), author).toEqual([]);
    }
  });

  it("a task with an approved work plan of ordered parts is the owner's", async () => {
    const w = feedbackWorld();
    w.setWorkflow({ workflowDependenciesApproval: { artifactDigest: "a".repeat(64), graphDigest: "b".repeat(64), workflowRevision: 5, actorId: OWNER, runId: "11111111-2222-4333-8444-555555555555" } });
    await trackPullRequest(w.deps, TASK_ID);
    // (The stored record is read raw: the approval needs its whole-plan decision to parse, which this fixture has no need of.)
    expect((w.task().workflow as { revision: number; stage: string }).revision).toBe(10);
    expect(lookups(w)).toEqual([]);
  });

  it("more different people than a pass looks up wait for the owner", async () => {
    const comments = Array.from({ length: PERMISSION_LOOKUPS_MAX + 1 }, (_, index) => ({ id: `review_comment:${String(index + 1)}`, author: `person${String(index)}`, threadId: `t${String(index)}` }));
    const w = feedbackWorld({ card: pendingCard({ comments, findings: [{ id: "f1", commentIds: comments.map((comment) => comment.id) }] }) });
    for (const comment of comments) w.github.permissions.set(comment.author, "write");
    await trackPullRequest(w.deps, TASK_ID);
    expect(storedWorkflow(w).revision).toBe(10);
    expect(lookups(w)).toEqual([]);
  });

  it("a report or comments that cannot be read and checked wait for the owner; so does a lookup that fails (fail closed, and the pass goes on)", async () => {
    const unreadable = feedbackWorld({ roundCheck: false });
    await trackPullRequest(unreadable.deps, TASK_ID);
    expect(storedWorkflow(unreadable).revision).toBe(10);
    const throwing = feedbackWorld({ roundCheck: async () => { throw new Error("S3 is down"); } });
    await trackPullRequest(throwing.deps, TASK_ID);
    expect(storedWorkflow(throwing).revision).toBe(10);
    const failed = feedbackWorld();
    failed.github.throwFor = "maya";
    await trackPullRequest(failed.deps, TASK_ID);
    expect(storedWorkflow(failed)).toMatchObject({ revision: 10, feedbackReview: { status: "PENDING" } });
    expect(dispatchRows(failed)).toEqual([]);
  });

  it("a round that cannot be checked logs only the kind of error: never the message, which may carry a comment's text or a token a writer pasted", async () => {
    class CommentError extends Error { constructor(message: string) { super(message); this.name = "CommentError"; } }
    const logged: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const secret = `Use ${GHP} to call the API`;
    const w = feedbackWorld({ roundCheck: async () => { throw new CommentError(secret); } });
    (w.deps as { log?: unknown }).log = (event: string, fields: Record<string, unknown>) => { logged.push({ event, fields }); };
    await trackPullRequest(w.deps, TASK_ID);
    expect(storedWorkflow(w).revision).toBe(10);
    const unchecked = logged.filter((entry) => entry.event === "feedback_autonomy.round_unchecked");
    expect(unchecked).toEqual([{ event: "feedback_autonomy.round_unchecked", fields: { taskId: TASK_ID, error: "CommentError" } }]);
    expect(JSON.stringify(logged)).not.toContain(GHP);
    expect(JSON.stringify(logged)).not.toContain("call the API");
  });

  it("GitHub's rate limit and the pass's own allowance are not swallowed: the pass is tried again", async () => {
    const limited = feedbackWorld();
    limited.github.throwFor = "maya";
    limited.github.getRepositoryPermission = async () => { throw new GithubMergeRateLimitError(Date.now() + 60_000); };
    await expect(trackPullRequest(limited.deps, TASK_ID)).rejects.toBeInstanceOf(GithubMergeRateLimitError);
    const capped = feedbackWorld({ roundCheck: async () => { throw new TrackingRequestCapError(); } });
    await expect(trackPullRequest(capped.deps, TASK_ID)).rejects.toBeInstanceOf(TrackingRequestCapError);
  });

  it("the rule reads who wrote the comments and what the review made of them, never what they say: the round is an ordinary one that merges nothing (the injection text itself is in e2e 15.1)", async () => {
    // The comment text is not even in the record the rule reads.
    const w = feedbackWorld();
    await trackPullRequest(w.deps, TASK_ID);
    const next = storedWorkflow(w);
    expect(next.pullRequests?.every((pullRequest) => pullRequest.state === "OPEN")).toBe(true);
    expect(w.github.calls.filter((call) => !call.startsWith("status") && !call.startsWith("permission"))).toEqual([]);
    expect(next.stage).toBe("IMPLEMENT");
  });

  it("only a card that waits for a decision is acted on: nothing is decided while the review is being prepared or failed", async () => {
    const card = pendingCard();
    const collecting = feedbackWorld();
    collecting.setWorkflow({ feedbackReview: { status: "COLLECTING", bundleRefs: card.workflow.feedbackReview!.bundleRefs, threadObservations: [] } });
    await trackPullRequest(collecting.deps, TASK_ID);
    expect(storedWorkflow(collecting).revision).toBe(10);
    expect(lookups(collecting)).toEqual([]);
    const failed = feedbackWorld();
    failed.setWorkflow({ feedbackReview: { ...card.workflow.feedbackReview!, reviewRef: { ...card.workflow.feedbackReview!.reviewRef!, status: "FAILED", blockReason: "review timed out" } } });
    await trackPullRequest(failed.deps, TASK_ID);
    expect(storedWorkflow(failed).revision).toBe(10);
    expect(lookups(failed)).toEqual([]);
  });

  it("someone else's push stops it: nothing is decided on a head that is not Rovara's", async () => {
    const w = feedbackWorld();
    w.github.statuses.set(7, status({ draft: false, headSha: "7".repeat(40) }));
    await trackPullRequest(w.deps, TASK_ID);
    expect(storedWorkflow(w).revision).toBe(10);
    expect(lookups(w)).toEqual([]);
  });

  it("a task of version 1 is not tracked, so it is never decided", async () => {
    const w = feedbackWorld({ card: pendingCard({ version: "1.0.0" }) });
    expect(await trackPullRequest(w.deps, TASK_ID)).toBe("gone");
    expect(storedWorkflow(w).revision).toBe(10);
  });
});

describe("failing CI while the owner's card waits", () => {
  beforeEach(() => { installFeedbackDecider(); installCiFixDecider(); });
  afterEach(() => { uninstallFeedbackDecider(); uninstallCiFixDecider(); });

  it("starts no CI round; the failing check is added to the card (and what CI said is kept for the decision), once", async () => {
    const w = feedbackWorld({ autonomy: "suggest", red: true });
    await trackPullRequest(w.deps, TASK_ID);
    const next = storedWorkflow(w);
    expect(next).toMatchObject({ revision: 11, stage: "WAIT_FOR_MERGE", state: "WAITING", feedbackReview: { status: "PENDING" }, feedbackCiFailures: { checks: ["test"], digest: feedbackCiFailuresDigest(["test"]), evidenceRevision: 11 } });
    expect(next.fixSource).toBeUndefined();
    expect(dispatchRows(w)).toEqual([]);
    const block = await readCiEvidence(w.deps, TASK_ID, TEST_ORG, 11);
    expect(block?.startsWith(`${CI_OUTPUT_BLOCK_HEADER}\n`)).toBe(true);
    expect(block).toContain("Error: boom");
    expect(block).not.toContain(GHP);
    // The same failure again changes nothing; CI going green takes it off the card.
    w.setNow(w.now() + 120_000);
    await trackPullRequest(w.deps, TASK_ID);
    expect(storedWorkflow(w).revision).toBe(11);
    w.github.statuses.set(7, status({ draft: false }));
    w.setNow(w.now() + 120_000);
    await trackPullRequest(w.deps, TASK_ID);
    expect(storedWorkflow(w)).toMatchObject({ revision: 12 });
    expect(storedWorkflow(w).feedbackCiFailures).toBeUndefined();
  });

  it("a round Rovara decides takes the failing check into the same round and starts no CI round of its own", async () => {
    const w = feedbackWorld({ red: true });
    await trackPullRequest(w.deps, TASK_ID);
    const next = storedWorkflow(w);
    expect(next).toMatchObject({ revision: 12, stage: "IMPLEMENT", state: "READY", fixSource: "feedback", fixRounds: { ci: 0, feedbackAuto: 1 } });
    expect(next.feedbackDecisions?.[0]?.ciFailures).toMatchObject({ checks: ["test"], evidenceRevision: 11 });
    expect(await readCiEvidence(w.deps, TASK_ID, TEST_ORG, 11)).toContain("Error: boom");
    expect(dispatchRows(w)).toEqual([expect.objectContaining({ sk: `${TASK_ID}#12`, kind: "IMPLEMENT" })]);
  });

  it("nothing is added to a card that was decided", async () => {
    const w = feedbackWorld({ autonomy: "suggest" });
    const card = pendingCard();
    const decided = decideWorkflowFeedbackFindings(card.workflow, requestFor(card), owner, at);
    w.setTask({ workflow: decided });
    w.github.statuses.set(7, status({ draft: false, checks: [redCheck()] }));
    await trackPullRequest(w.deps, TASK_ID);
    expect(storedWorkflow(w).feedbackCiFailures).toBeUndefined();
  });
});

// ---- the one reply on each fixed thread

const SHA = "0123456789abcdef0123456789abcdef01234567";

/** A round Rovara decided itself and a push that landed: the workflow as the landing's transaction sees it (the review approved, the decision recorded). */
function decidedRound(options: { comments?: CommentSpec[]; by?: "rovara" | "owner" } = {}): WorkflowSnapshot {
  const card = pendingCard({ comments: options.comments ?? [{ id: "review_comment:11", author: "maya", threadId: "thread-1" }, { id: "review_comment:12", author: "maya", threadId: "thread-1" }, { id: "review_comment:21", author: "maya", threadId: "thread-2" }, { id: "discussion:31", author: "maya", kind: "DISCUSSION" }] });
  return decideWorkflowFeedbackFindings(card.workflow, requestFor(card), options.by === "owner" ? owner : rovara, at);
}

describe("feedbackReplyItems", () => {
  const items = (workflow: WorkflowSnapshot, number = 7) => feedbackReplyItems({ tableName: "state", orgId: TEST_ORG, workflow, repositoryId: "payments", number, head: SHA, now: at });

  it("leaves one item for the round: the first fixed comment of each review thread, never a discussion or a review body", () => {
    const [put] = items(decidedRound()) as Array<{ Put: { Item: Record<string, unknown>; ConditionExpression?: string } }>;
    expect(put?.Put.Item).toMatchObject({
      pk: `DEVTASK#${TASK_ID}`, entityType: "FEEDBACK_REPLY", orgId: TEST_ORG, taskId: TASK_ID, repositoryId: "payments", number: 7, head: SHA, commentIds: ["11", "21"], repliedIds: [], state: "pending", attempts: 0,
    });
    expect(String(put?.Put.Item["sk"])).toMatch(/^FEEDBACK_REPLY#[0-9a-f-]{36}#payments#7$/u);
    expect(put?.Put.ConditionExpression).toBe("attribute_not_exists(pk)");
    expect(put?.Put.Item["indexExpiresAt"]).toBeTypeOf("number");
  });

  it("a round a person decided leaves none, and so does a pull request the round was not for, or a round with no thread", () => {
    expect(items(decidedRound({ by: "owner" }))).toEqual([]);
    expect(items(decidedRound(), 8)).toEqual([]);
    expect(items(decidedRound({ comments: [{ id: "discussion:31", author: "maya", kind: "DISCUSSION" }] }))).toEqual([]);
    expect(items(pendingCard().workflow)).toEqual([]);
  });
});

describe("sendFeedbackReplies", () => {
  function repliesWorld(options: { fail?: (commentId: string, attempt: number) => Error | undefined } = {}) {
    const db = new FakeDynamoDb();
    const sent: Array<{ number: number; commentId: string; body: string }> = [];
    const calls: string[] = [];
    let attempts = 0;
    // The reply goes through the GitHub CodeHost adapter over a GitHub-shaped provider, as the broker wires it.
    const provider = { replyToReviewThread: async (_url: string, number: number, commentId: string, body: string) => {
      attempts += 1;
      calls.push(commentId);
      const failure = options.fail?.(commentId, attempts);
      if (failure !== undefined) throw failure;
      sent.push({ number, commentId, body });
      return "replied" as const;
    } };
    const deps = {
      documentClient: db, tableName: "state", now: () => Date.parse(at),
      scope: (orgId: string) => ({ orgId }) as never,
      repository: async () => ({ url: "https://github.com/acme/payments", codeHost: githubCodeHost(provider as never, { credentialRef: "github" }) }),
    };
    const [put] = feedbackReplyItems({ tableName: "state", orgId: TEST_ORG, workflow: decidedRound(), repositoryId: "payments", number: 7, head: SHA, now: at }) as Array<{ Put: { Item: Record<string, unknown> } }>;
    db.set(put!.Put.Item);
    const task = { taskId: TASK_ID, orgId: TEST_ORG, project: "payments", startingRevision: 1 };
    return { db, deps, sent, calls, task, item: () => db.find((entry) => entry.entityType === "FEEDBACK_REPLY")[0]! };
  }

  it("replies once on each thread, with Rovara's fixed text naming the commit, and writes each down", async () => {
    const w = repliesWorld();
    expect(await sendFeedbackReplies(w.deps, w.task)).toBe(2);
    expect(w.sent).toEqual([{ number: 7, commentId: "11", body: "Fixed in 0123456." }, { number: 7, commentId: "21", body: "Fixed in 0123456." }]);
    expect(w.item()).toMatchObject({ state: "done", repliedIds: ["11", "21"], attempts: 1 });
    // Again: nothing is sent twice.
    expect(await sendFeedbackReplies(w.deps, w.task)).toBe(0);
    expect(w.sent).toHaveLength(2);
  });

  it("a failure leaves the rest for the next pass, and a reply that went is never sent again; the item is given up after its attempts", async () => {
    let failing = true;
    const w = repliesWorld({ fail: (commentId) => (commentId === "21" && failing ? new Error("GitHub is down") : undefined) });
    expect(await sendFeedbackReplies(w.deps, w.task)).toBe(1);
    expect(w.item()).toMatchObject({ state: "pending", repliedIds: ["11"], attempts: 1 });
    failing = false;
    expect(await sendFeedbackReplies(w.deps, w.task)).toBe(1);
    expect(w.sent.map((entry) => entry.commentId)).toEqual(["11", "21"]);
    expect(w.item()).toMatchObject({ state: "done", repliedIds: ["11", "21"] });
    // An item that never works is tried FEEDBACK_REPLY_ATTEMPTS_MAX times and then left.
    const stuck = repliesWorld({ fail: () => new Error("GitHub is down") });
    for (let pass = 0; pass < FEEDBACK_REPLY_ATTEMPTS_MAX + 2; pass += 1) await sendFeedbackReplies(stuck.deps, stuck.task);
    expect(stuck.calls).toHaveLength(FEEDBACK_REPLY_ATTEMPTS_MAX);
    expect(stuck.item()).toMatchObject({ state: "pending", attempts: FEEDBACK_REPLY_ATTEMPTS_MAX });
  });

  it("GitHub's rate limit goes up to the sweep; a thread that is gone is just done", async () => {
    const limited = repliesWorld({ fail: () => new GithubMergeRateLimitError(Date.now() + 60_000) });
    await expect(sendFeedbackReplies(limited.deps, limited.task)).rejects.toBeInstanceOf(GithubMergeRateLimitError);
  });

  it("sends nothing for another task's or another org's item", async () => {
    const w = repliesWorld();
    expect(await sendFeedbackReplies(w.deps, { ...w.task, orgId: `org_${"b".repeat(24)}` as never })).toBe(0);
    expect(await sendFeedbackReplies(w.deps, { ...w.task, taskId: "00000000-0000-4000-8000-0000000000b2" })).toBe(0);
    expect(w.sent).toEqual([]);
  });

  it("two passes at once send each reply once: the one that lost the claim does nothing", async () => {
    const w = repliesWorld();
    const [first, second] = await Promise.all([sendFeedbackReplies(w.deps, w.task), sendFeedbackReplies(w.deps, w.task)]);
    expect(first + second).toBe(2);
    expect(w.sent).toHaveLength(2);
  });
});

describe("the tracking pass sends the replies a landed push left", () => {
  beforeEach(() => installFeedbackDecider());
  afterEach(() => uninstallFeedbackDecider());

  it("at the end of a pass, best effort: a failure there never fails the pass", async () => {
    const w = feedbackWorld({ autonomy: "suggest" });
    const calls: string[] = [];
    (w.deps as { sendFeedbackReplies?: unknown }).sendFeedbackReplies = async () => { calls.push("sent"); };
    await trackPullRequest(w.deps, TASK_ID);
    expect(calls).toEqual(["sent"]);
    (w.deps as { sendFeedbackReplies?: unknown }).sendFeedbackReplies = async () => { throw new Error("the queue is down"); };
    w.setNow(w.now() + 120_000);
    await expect(trackPullRequest(w.deps, TASK_ID)).resolves.toBeDefined();
    (w.deps as { sendFeedbackReplies?: unknown }).sendFeedbackReplies = async () => { throw new GithubMergeRateLimitError(Date.now() + 60_000); };
    w.setNow(w.now() + 120_000);
    await expect(trackPullRequest(w.deps, TASK_ID)).rejects.toBeInstanceOf(GithubMergeRateLimitError);
  });
});

describe("what was stored before this change still reads and still works", () => {
  it("a review decided by a person, with the approval the worker presents, parses exactly as the earlier release wrote it (no autonomy, no failing checks)", () => {
    const card = pendingCard();
    const decided = decideWorkflowFeedbackFindings(card.workflow, requestFor(card), owner, at);
    const stored = JSON.parse(JSON.stringify(decided)) as WorkflowSnapshot;
    expect(stored.feedbackDecisions?.[0]).not.toHaveProperty("autonomy");
    expect(stored.feedbackDecisions?.[0]).not.toHaveProperty("ciFailures");
    expect(WorkflowSnapshotSchema.safeParse(stored).success).toBe(true);
    // The earlier release's decision record, field for field.
    const earlier = { ...stored.feedbackDecisions![0]! } as Record<string, unknown>;
    delete earlier["autonomy"];
    delete earlier["ciFailures"];
    expect(WorkflowFeedbackDecisionSchema.safeParse(earlier).success).toBe(true);
    const binding = { taskId: TASK_ID, requestId: REQUEST, ownerId: OWNER, decisionWorkflowRevision: 9, activeWorkflowRevision: 11, reviewDigest: hash("b"), proposalDigest: hash("d"),
      bundleDigests: [hash("e")], candidateDigest: hash("f"), selectedFindingIds: ["f1"], selectedCommentIds: ["c1"] };
    expect(JSON.stringify(WorkflowFeedbackApprovalBindingSchema.parse(binding))).toBe(JSON.stringify(binding));
  });
});

describe("what still has to hold when the worker starts", () => {
  const task = () => ({ workflow: pendingCard({ comments: [{ id: "review_comment:1", author: "maya", threadId: "t1" }, { id: "review_comment:2", author: "omar", threadId: "t2" }, { id: "review_comment:3", author: "maya", threadId: "t3" }] }).workflow });
  /** A code host that tells a person's standing by the GitHub adapter's words (account type), from what the test says of each person. */
  const standingHost = (standing: (url: string, login: string) => Promise<{ permission: "admin" | "write" | "read" | "none"; userType?: string }>) => githubCodeHost(
    { getRepositoryStanding: (url: string, login: string) => standing(url, login) } as never, { credentialRef: "github" },
  );
  const holds = (overrides: Partial<Parameters<typeof autonomyStillHolds>[0]> = {}, people: Record<string, { permission: "admin" | "write" | "read" | "none"; userType?: string }> = { maya: { permission: "write" }, omar: { permission: "admin", userType: "User" } }) => {
    const asked: string[] = [];
    const deps = {
      autonomy: async () => ({ autonomy: "prepare" as const }), scope: { orgId: TEST_ORG } as never,
      repository: async () => ({ url: "https://github.com/acme/payments", codeHost: standingHost(async (_url, login) => { asked.push(login); const found = people[login]; if (found === undefined) throw new Error("GitHub is down"); return found; }) }),
      ...overrides,
    };
    return { deps, asked };
  };
  const binding = (digest?: string) => ({ autonomy: { level: "prepare", ...(digest === undefined ? {} : { recipeDigest: digest }) } });
  const live = (autonomy: "suggest" | "prepare" | "run", recipeDigest?: string) => async () => ({ autonomy, ...(recipeDigest === undefined ? {} : { recipeDigest }) });

  it("holds while the autonomy is prepare or run, the frozen recipe is the one it was bound to, and every writer of the round is still a person who can write", async () => {
    const w = holds({ autonomy: live("prepare", hash("9")) });
    expect(await autonomyStillHolds(w.deps, task(), binding(hash("9")))).toBe(true);
    expect(w.asked).toEqual(["maya", "omar"]);
    expect(await autonomyStillHolds(holds({ autonomy: live("run") }).deps, task(), binding())).toBe(true);
  });

  it("does not hold for a decision with no autonomy bound, or when nothing can be asked", async () => {
    expect(await autonomyStillHolds(holds().deps, task(), {})).toBe(false);
    // A task whose repository the project does not hold: nothing can be asked, so nothing holds.
    expect(await autonomyStillHolds(holds({ repository: async () => undefined }).deps, task(), binding())).toBe(false);
  });

  it("does not hold when the frozen recipe is not the one the decision was bound to (either way round)", async () => {
    expect(await autonomyStillHolds(holds({ autonomy: live("prepare", hash("8")) }).deps, task(), binding(hash("9")))).toBe(false);
    expect(await autonomyStillHolds(holds({ autonomy: live("prepare", hash("9")) }).deps, task(), binding())).toBe(false);
    expect(await autonomyStillHolds(holds({ autonomy: live("prepare") }).deps, task(), binding(hash("9")))).toBe(false);
  });

  it("does not hold once the autonomy read now is suggest: the task's own, or the company's limit lowered, or an unreadable recipe or limit", async () => {
    expect(await autonomyStillHolds(holds({ autonomy: live("suggest") }).deps, task(), binding())).toBe(false);
  });

  it("does not hold once a writer lost write access, is not a person, is a bot, or cannot be looked up; and asks nobody once it is known not to hold", async () => {
    expect(await autonomyStillHolds(holds({}, { maya: { permission: "write" }, omar: { permission: "read" } }).deps, task(), binding())).toBe(false);
    expect(await autonomyStillHolds(holds({}, { maya: { permission: "write" }, omar: { permission: "write", userType: "Bot" } }).deps, task(), binding())).toBe(false);
    expect(await autonomyStillHolds(holds({}, { maya: { permission: "write" } }).deps, task(), binding())).toBe(false);
    const gone = holds({ repository: async () => undefined });
    expect(await autonomyStillHolds(gone.deps, task(), binding())).toBe(false);
    expect(gone.asked).toEqual([]);
    const bot = { workflow: pendingCard({ comments: [{ id: "review_comment:1", author: "renovate[bot]", threadId: "t1" }] }).workflow };
    const botWorld = holds();
    expect(await autonomyStillHolds(botWorld.deps, bot, binding())).toBe(false);
    expect(botWorld.asked).toEqual([]);
  });

  it("asks about each writer on the repository of their own comment", async () => {
    const two = { workflow: pendingCard({ comments: [{ id: "review_comment:1", author: "bob", threadId: "t1", repositoryId: "payments" }, { id: "review_comment:2", author: "bob", threadId: "t2", repositoryId: "web" }], findings: [{ id: "f1", commentIds: ["review_comment:1"] }, { id: "f2", commentIds: ["review_comment:2"] }] }).workflow };
    const seen: string[] = [];
    const deps = {
      autonomy: live("prepare"), scope: { orgId: TEST_ORG } as never,
      repository: async (repositoryId: string) => ({ url: `https://github.com/acme/${repositoryId}`, codeHost: standingHost(async (url) => { seen.push(url); return { permission: url.endsWith("/web") ? "read" as const : "write" as const }; }) }),
    };
    expect(await autonomyStillHolds(deps, two, binding())).toBe(false);
    expect(seen).toEqual(["https://github.com/acme/payments", "https://github.com/acme/web"]);
  });
});

describe("how far Rovara may go on its own with a task", () => {
  const frozen = (autonomy: "suggest" | "prepare" | "run", digest = hash("9")) => async () => ({ recipe: { autonomy }, digest });
  it("is the stricter of the frozen recipe and the company's limit read now, with the frozen recipe's digest", async () => {
    expect(await taskAutonomyBinding(frozen("run"), undefined, async () => "run")).toEqual({ autonomy: "run", recipeDigest: hash("9") });
    expect(await taskAutonomyBinding(frozen("run"), undefined, async () => "prepare")).toEqual({ autonomy: "prepare", recipeDigest: hash("9") });
    expect(await taskAutonomyBinding(frozen("prepare"), undefined, async () => "suggest")).toEqual({ autonomy: "suggest", recipeDigest: hash("9") });
    expect(await taskAutonomyBinding(frozen("suggest"), undefined, async () => "run")).toEqual({ autonomy: "suggest", recipeDigest: hash("9") });
    // A task with no recipe is prepare, and the limit still applies to it.
    expect(await taskAutonomyBinding(async () => undefined, undefined, async () => "run")).toEqual({ autonomy: "prepare" });
    expect(await taskAutonomyBinding(async () => undefined, undefined, async () => "suggest")).toEqual({ autonomy: "suggest" });
  });

  it("asks first (suggest) when the recipe or the limit cannot be read", async () => {
    const logged: string[] = [];
    expect(await taskAutonomyBinding(frozen("run"), (event) => { logged.push(event); }, async () => { throw new Error("throttled"); })).toEqual({ autonomy: "suggest" });
    expect(await taskAutonomyBinding(async () => { throw new Error("throttled"); }, (event) => { logged.push(event); }, async () => "run")).toEqual({ autonomy: "suggest" });
    expect(logged).toEqual(["ci_fix.autonomy_limit_unreadable", "ci_fix.autonomy_unreadable"]);
    expect(await taskAutonomy(frozen("run"), undefined, async () => "prepare")).toBe("prepare");
  });
});

describe("feedbackApprovalMatchesDecision", () => {
  it("a person's decision is presented with no autonomy and a Rovara decision with exactly its own", () => {
    expect(feedbackApprovalMatchesDecision({ actorRole: "TASK_OWNER" }, {})).toBe(true);
    expect(feedbackApprovalMatchesDecision({ actorRole: "TASK_OWNER" }, { autonomy: { level: "prepare" } })).toBe(false);
    expect(feedbackApprovalMatchesDecision({ actorRole: "ROVARA_AUTONOMY", autonomy: { level: "prepare" } }, { autonomy: { level: "prepare" } })).toBe(true);
    expect(feedbackApprovalMatchesDecision({ actorRole: "ROVARA_AUTONOMY", autonomy: { level: "prepare" } }, {})).toBe(false);
    expect(feedbackApprovalMatchesDecision({ actorRole: "ROVARA_AUTONOMY", autonomy: { level: "prepare" } }, { autonomy: { level: "run" } })).toBe(false);
    expect(feedbackApprovalMatchesDecision({ actorRole: "ROVARA_AUTONOMY" }, { autonomy: { level: "run" } })).toBe(false);
  });

  it("the autonomy is compared field by field: a stored map comes back in any key order", () => {
    const stored = { level: "prepare", recipeDigest: hash("9") };
    const reordered = JSON.parse(JSON.stringify({ recipeDigest: hash("9"), level: "prepare" })) as typeof stored;
    expect(feedbackApprovalMatchesDecision({ actorRole: "ROVARA_AUTONOMY", autonomy: reordered }, { autonomy: stored })).toBe(true);
    expect(feedbackApprovalMatchesDecision({ actorRole: "ROVARA_AUTONOMY", autonomy: reordered }, { autonomy: { ...stored, recipeDigest: hash("8") } })).toBe(false);
  });

  it("both name the same failing checks, or none", () => {
    expect(feedbackApprovalMatchesDecision({ actorRole: "TASK_OWNER", ciFailures: { digest: hash("1") } }, { ciFailuresDigest: hash("1") })).toBe(true);
    expect(feedbackApprovalMatchesDecision({ actorRole: "TASK_OWNER", ciFailures: { digest: hash("1") } }, { ciFailuresDigest: hash("2") })).toBe(false);
    expect(feedbackApprovalMatchesDecision({ actorRole: "TASK_OWNER", ciFailures: { digest: hash("1") } }, {})).toBe(false);
    expect(feedbackApprovalMatchesDecision({ actorRole: "TASK_OWNER" }, { ciFailuresDigest: hash("1") })).toBe(false);
  });
});

describe("failing checks join a card only while it waits", () => {
  it("a review that was decided, though the task waits again, takes none", () => {
    const card = pendingCard();
    const decided = decideWorkflowFeedbackFindings(card.workflow, requestFor(card), owner, at);
    const waitingAgain = WorkflowSnapshotSchema.parse({ ...decided, stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(waitingAgain.feedbackReview?.status).toBe("APPROVED");
    expect(() => recordWorkflowFeedbackCiFailures(waitingAgain, { checks: ["test"], now: at })).toThrow(WorkflowTransitionError);
  });
});

describe("on the fake code host (P5b)", () => {
  const URL = "https://github.com/acme/payments";
  function fakeHost() {
    const model = new FakeHostModel({ url: URL, id: "42", fullName: "acme/payments", webBase: "https://github.com" });
    // Pull request 7 is the seventh change request of the repository.
    for (let n = 1; n <= 7; n += 1) { model.commit(`agentx/b${String(n)}`, { [`f${String(n)}.ts`]: "x\n" }); model.reconcile({ sourceBranch: `agentx/b${String(n)}`, targetBranch: "main", title: `t${String(n)}` }); }
    return { model, host: new FakeCodeHost(model), crId: "7" };
  }

  it("replies on each review thread through the host's port, once, with Rovara's fixed text", async () => {
    const { model, host, crId } = fakeHost();
    const first = model.addReviewComment(crId, "maya", "please rename", "src/a.ts", 1);
    const second = model.addReviewComment(crId, "maya", "and this", "src/a.ts", 2);
    const db = new FakeDynamoDb();
    const [put] = feedbackReplyItems({ tableName: "state", orgId: TEST_ORG, workflow: decidedRound(), repositoryId: "payments", number: Number(crId), head: SHA, now: at }) as Array<{ Put: { Item: Record<string, unknown> } }>;
    db.set({ ...put!.Put.Item, commentIds: [first.id, second.id] });
    const deps = { documentClient: db, tableName: "state", now: () => Date.parse(at), scope: (orgId: string) => ({ orgId }) as never, repository: async () => ({ url: URL, codeHost: host }) };
    const task = { taskId: TASK_ID, orgId: TEST_ORG, project: "payments", startingRevision: 1 };
    expect(await sendFeedbackReplies(deps, task)).toBe(2);
    const replies = model.getChangeRequest(crId).comments.filter((comment) => comment.author === "rovara-app[bot]");
    expect(replies.map((comment) => comment.body)).toEqual(["Fixed in 0123456.", "Fixed in 0123456."]);
    expect(new Set(replies.map((comment) => comment.threadId))).toEqual(new Set([first.threadId, second.threadId]));
    expect(await sendFeedbackReplies(deps, task)).toBe(0);
  });

  it("every reply spends the pass's request allowance, on the fake host and through the GitHub adapter's provider call", async () => {
    const { model, host, crId } = fakeHost();
    const first = model.addReviewComment(crId, "maya", "please rename", "src/a.ts", 1);
    const second = model.addReviewComment(crId, "maya", "and this", "src/a.ts", 2);
    const seed = (db: FakeDynamoDb) => {
      const [put] = feedbackReplyItems({ tableName: "state", orgId: TEST_ORG, workflow: decidedRound(), repositoryId: "payments", number: Number(crId), head: SHA, now: at }) as Array<{ Put: { Item: Record<string, unknown> } }>;
      db.set({ ...put!.Put.Item, commentIds: [first.id, second.id] });
    };
    const task = { taskId: TASK_ID, orgId: TEST_ORG, project: "payments", startingRevision: 1 };
    const spent: number[] = [];
    const budget = { signal: new AbortController().signal, beforeRequest: () => { spent.push(1); } };
    const db = new FakeDynamoDb();
    seed(db);
    const deps = { documentClient: db, tableName: "state", now: () => Date.parse(at), scope: (orgId: string) => ({ orgId }) as never, repository: async () => ({ url: URL, codeHost: host }) };
    expect(await sendFeedbackReplies(deps, task, budget)).toBe(2);
    expect(spent).toHaveLength(2);
    // Through the GitHub adapter the same budget reaches the provider's call.
    const seen: unknown[] = [];
    const provider = { replyToReviewThread: async (...args: unknown[]) => { seen.push(args[5]); return "replied" as const; } };
    const githubDb = new FakeDynamoDb();
    seed(githubDb);
    const githubDeps = { ...deps, documentClient: githubDb, repository: async () => ({ url: URL, codeHost: githubCodeHost(provider as never, { credentialRef: "github" }) }) };
    // The ids in the stored item are the fake model's; the adapter takes digits only.
    expect(await sendFeedbackReplies(githubDeps, task, budget)).toBe(2);
    expect(seen).toEqual([budget, budget]);
  });

  it("holds only while every writer of the round is still a person who can write on the host (read live), and a bot account never counts", async () => {
    const { model, host } = fakeHost();
    model.setAccount("maya", "write");
    model.setAccount("omar", "admin");
    const repository = async () => ({ url: URL, codeHost: host });
    const deps = { autonomy: async () => ({ autonomy: "prepare" as const }), repository, scope: { orgId: TEST_ORG } as never };
    const round = { workflow: pendingCard({ comments: [{ id: "review_comment:1", author: "maya", threadId: "t1" }, { id: "review_comment:2", author: "omar", threadId: "t2" }] }).workflow };
    const binding = { autonomy: { level: "prepare" } };
    expect(await autonomyStillHolds(deps, round, binding)).toBe(true);
    model.setAccount("omar", "read");
    expect(await autonomyStillHolds(deps, round, binding)).toBe(false);
    model.setAccount("omar", "admin", "Bot");
    expect(await autonomyStillHolds(deps, round, binding)).toBe(false);
  });
});
