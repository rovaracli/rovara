// Rovara Code (Plan 6 Task 17): keeping a pull request's branch up to date. The contract moves (a merge of the base is queued, runs, ends or stops; its result is recorded; a conflict starts a
// round), the two slots of merge tracking (conflict, sync) over a fake GitHub (merge only when needed, at most four a day, never over a person's push), and the plan of what a finished merge
// is (clean, conflicted, refused for workflow files, lost) from what GitHub shows. Nothing here rebases or force-pushes, and nothing a person did not leave to Rovara is overwritten.
import { afterEach, describe, expect, it } from "vitest";
import {
  BRANCH_SYNC_UNSURE_MESSAGE, SYNC_BACKOFF_MINUTES, SYNC_FAILURES_MAX, branchSyncGiveUpMessage, isBranchSyncGiveUpReason,
  branchConflictAskMessage, isBranchConflictAskReason, retryWorkflowBranchSync,
  BRANCH_SYNCS_PER_DAY_MAX, BRANCH_WORKFLOW_FILES_MESSAGE, CONFLICT_ROUNDS_MAX, WorkflowSnapshotSchema, WorkflowTransitionError, blockWorkflowBranchSync, branchConflictStopMessage, createCandidateManifest,
  createWorkflowSnapshot, endWorkflowBranchSync, isBranchSyncBlockReason, observeWorkflowPullRequest, recordWorkflowBranchSync, recordWorkflowPullRequestUpdate, recordWorkflowSyncConflict,
  recordWorkflowVerification, startWorkflowBranchSync, startWorkflowBranchSyncRun, startWorkflowFix, workflowFollowsOnlyMerge, type WorkflowProgram, type WorkflowSnapshot,
} from "@agentx/contracts";
import { mergeTrackingKey } from "../../packages/contracts/src/org-scoped-keys.js";
import type { MergeTrackingItem } from "../../packages/contracts/src/rovara-code.js";
import { trackPullRequest } from "../../packages/broker/src/rovara-code/merge-tracking.js";
import {
  branchSyncRequestId, bumpSyncs, classifySyncFailure, conflictDecider, decideBranchSync, decideConflict, installBranchSyncDeciders, isWorkflowFilesRefusal, planBranchSyncOutcome, syncDecider, syncsToday,
  uninstallBranchSyncDeciders, utcDay,
} from "../../packages/broker/src/rovara-code/branch-sync.js";
import { workflowMessage } from "../../packages/broker/src/developer/workflow-messages.js";
import { taskViewForClient } from "../../packages/broker/src/rovara-code/task-view-compat.js";
import { blockWorkflowPullRequestUpdate } from "@agentx/contracts";
import { installCiFixDecider, uninstallCiFixDecider } from "../../packages/broker/src/rovara-code/ci-fix.js";
import { HEAD_A, HEAD_B, NOW, SESSION_ID, TASK_ID, status, world, type TrackingWorld } from "../support/rovara-code-tracking.js";

const at = "2026-10-25T12:00:00.000Z";
const OWNER = "a".repeat(64);
const BASE_OLD = "e".repeat(40);
const BASE_NEW = "f".repeat(40);
const MERGE = "9".repeat(40);
const MERGED_TREE = "c".repeat(40);

const PROGRAM: WorkflowProgram = { steps: [
  { id: "plan", kind: "plan" }, { id: "plan_critic", kind: "plan_critic" }, { id: "build", kind: "build" }, { id: "check", kind: "check" },
  { id: "review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "build", maxRounds: 3 } }, { id: "pull_request", kind: "pull_request" },
] };
const candidate = createCandidateManifest([{ repositoryId: "payments", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: BASE_OLD }]);
const PULL_REQUEST = { repositoryId: "payments", number: 7, headSha: HEAD_A, headTreeSha: "b".repeat(40), candidateDigest: candidate.digest, required: true, state: "OPEN" as const, url: "https://github.com/acme/payments/pull/7" };
const reviewOf = (role: "CRITIC" | "SECURITY", digest: string) => ({ operationId: "11111111-1111-4111-8111-111111111111", candidateDigest: digest, role, provider: "scripted", version: "1", status: "PASS" as const, findings: [], readOnly: true as const, recordedAt: at });

/** A task waiting for the merge of its one open pull request, as the schema takes it (version 2 with its program). */
function waiting(extra: Record<string, unknown> = {}, options: { version?: "1.0.0" | "1.1.0" } = {}): WorkflowSnapshot {
  const version = options.version ?? "1.1.0";
  return WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId: TASK_ID, ownerId: OWNER, now: at, definitionVersion: version, ...(version === "1.1.0" ? { program: PROGRAM } : {}) }),
    revision: 9, stage: "WAIT_FOR_MERGE", state: "WAITING", ...(version === "1.1.0" ? { programStepId: "pull_request" } : {}), candidate,
    reviewBase: [{ repositoryId: "payments", baseCommitSha: BASE_OLD }],
    verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: "test", recordedAt: at, results: [{ checkId: "unit", status: "PASS" }] },
    reviews: [reviewOf("CRITIC", candidate.digest), reviewOf("SECURITY", candidate.digest)],
    pullRequests: [PULL_REQUEST], ...extra,
  });
}
/** The same task while the merge of the base runs. */
const syncing = (extra: Record<string, unknown> = {}, reason: "behind" | "conflict" = "behind"): WorkflowSnapshot =>
  startWorkflowBranchSyncRun(startWorkflowBranchSync(waiting(extra), { repositoryId: "payments", number: 7, reason, now: at }), at);
const clean = { repositoryId: "payments", number: 7, headSha: MERGE, headTreeSha: MERGED_TREE, baseCommitSha: BASE_NEW, previousHeadSha: HEAD_A, now: at };

describe("a merge of the base branch, as the workflow moves", () => {
  it("queues for the pull request's recorded head, runs, and ends back at the wait for the merge", () => {
    const queued = startWorkflowBranchSync(waiting(), { repositoryId: "payments", number: 7, reason: "behind", now: at });
    expect(queued).toMatchObject({ revision: 10, stage: "WAIT_FOR_MERGE", state: "READY", branchSync: { repositoryId: "payments", number: 7, expectedHeadCommit: HEAD_A, reason: "behind" } });
    const running = startWorkflowBranchSyncRun(queued, at);
    expect(running).toMatchObject({ revision: 11, state: "RUNNING", branchSync: { expectedHeadCommit: HEAD_A } });
    for (const snapshot of [queued, running]) {
      const ended = endWorkflowBranchSync(snapshot, at);
      expect(ended).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
      expect(ended.branchSync).toBeUndefined();
      expect(WorkflowSnapshotSchema.safeParse(ended).success).toBe(true);
    }
    expect(() => endWorkflowBranchSync(waiting(), at)).toThrow(WorkflowTransitionError);
    expect(() => startWorkflowBranchSyncRun(waiting(), at)).toThrow(WorkflowTransitionError);
  });

  it("starts nothing while the owner's card waits, a fix or another merge is under way, or the pull request is not open or has no recorded head", () => {
    const start = (workflow: WorkflowSnapshot) => startWorkflowBranchSync(workflow, { repositoryId: "payments", number: 7, reason: "behind", now: at });
    const hash = (letter: string) => letter.repeat(64);
    const bundle = { schemaVersion: 1 as const, taskId: TASK_ID, repositoryId: "payments", number: 7, headSha: HEAD_A, headTreeSha: "b".repeat(40), candidateDigest: candidate.digest,
      commentSetDigest: hash("c"), sha256: hash("e"), objectKey: `tasks/${TASK_ID}/feedback/${hash("e")}.json`, producer: "github-reconciler", version: "1", recordedAt: at,
      comments: [{ id: "c1", threadId: "t1", kind: "REVIEW_COMMENT" as const, url: "https://github.com/acme/payments/pull/7#c1", author: "reviewer", updatedAt: at, bodyDigest: hash("d"), bodyBytes: 7 }] };
    expect(() => start(waiting({ feedbackReview: { status: "COLLECTING", bundleRefs: [bundle], threadObservations: [] } }))).toThrow(/card/);
    expect(() => start(startWorkflowFix(waiting(), { source: "ci", problems: ["test"], now: at }))).toThrow(WorkflowTransitionError);
    expect(() => start(startWorkflowBranchSync(waiting(), { repositoryId: "payments", number: 7, reason: "behind", now: at }))).toThrow(WorkflowTransitionError);
    expect(() => start(waiting({ pullRequests: [{ ...PULL_REQUEST, state: "CLOSED" }] }))).toThrow(WorkflowTransitionError);
    expect(() => start(waiting({ pullRequests: [{ ...PULL_REQUEST, headSha: undefined }] }))).toThrow(WorkflowTransitionError);
    expect(() => startWorkflowBranchSync(waiting(), { repositoryId: "payments", number: 8, reason: "behind", now: at })).toThrow(WorkflowTransitionError);
  });

  it("a marker needs the wait for the merge", () => {
    expect(WorkflowSnapshotSchema.safeParse({ ...waiting(), branchSync: { repositoryId: "payments", number: 7, expectedHeadCommit: HEAD_A, reason: "behind" } }).success).toBe(false);
  });

  it("follows only the merge while a merge of the base is queued or running, and while a person is to update the branch; an ordinary wait does not", () => {
    expect(workflowFollowsOnlyMerge(waiting())).toBe(false);
    expect(workflowFollowsOnlyMerge(startWorkflowBranchSync(waiting(), { repositoryId: "payments", number: 7, reason: "behind", now: at }))).toBe(true);
    expect(workflowFollowsOnlyMerge(syncing())).toBe(true);
    const stopped = blockWorkflowBranchSync(syncing(), { reason: BRANCH_WORKFLOW_FILES_MESSAGE, now: at });
    expect(workflowFollowsOnlyMerge(stopped)).toBe(true);
    // An observation of the open pull request leaves the stop as it is; a merge still completes the task.
    const observed = observeWorkflowPullRequest(stopped, { repositoryId: "payments", number: 7, candidateDigest: candidate.digest, state: "OPEN", source: "GITHUB_API", observedAt: at }, at);
    expect(observed).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "BLOCKED", blockReason: BRANCH_WORKFLOW_FILES_MESSAGE });
    const merged = observeWorkflowPullRequest(stopped, { repositoryId: "payments", number: 7, candidateDigest: candidate.digest, state: "MERGED", source: "GITHUB_API", observedAt: at }, at);
    expect(merged).toMatchObject({ stage: "MERGED", state: "COMPLETE", outcome: "MERGED" });
  });
});

describe("the two stops, in the exact words", () => {
  it("says the branch still conflicts after the conflict rounds, naming the base, and that Rovara can't push workflow files", () => {
    expect(CONFLICT_ROUNDS_MAX).toBe(2);
    expect(branchConflictStopMessage("main")).toBe("The branch still conflicts with main after 2 tries. Resolve it on GitHub or close the task.");
    expect(BRANCH_WORKFLOW_FILES_MESSAGE).toBe("The base branch changed CI workflow files, which Rovara can't push. Update the branch on GitHub.");
    expect(isBranchSyncBlockReason(branchConflictStopMessage("develop"))).toBe(true);
    expect(isBranchSyncBlockReason(BRANCH_WORKFLOW_FILES_MESSAGE)).toBe(true);
    expect(isBranchSyncBlockReason("The pull request changed on GitHub.")).toBe(false);
    expect(isBranchSyncBlockReason(undefined)).toBe(false);
  });

  it("blocks the wait for the merge with the text, drops the marker, and refuses any other reason", () => {
    const stopped = blockWorkflowBranchSync(syncing(), { reason: BRANCH_WORKFLOW_FILES_MESSAGE, now: at });
    expect(stopped).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "BLOCKED", blockReason: BRANCH_WORKFLOW_FILES_MESSAGE });
    expect(stopped.branchSync).toBeUndefined();
    expect(blockWorkflowBranchSync(waiting(), { reason: branchConflictStopMessage("main"), now: at }).blockReason).toBe(branchConflictStopMessage("main"));
    expect(() => blockWorkflowBranchSync(waiting(), { reason: "Some other reason", now: at })).toThrow(WorkflowTransitionError);
    expect(() => blockWorkflowBranchSync({ ...waiting(), stage: "IMPLEMENT", state: "READY" }, { reason: BRANCH_WORKFLOW_FILES_MESSAGE, now: at })).toThrow(WorkflowTransitionError);
  });

  it("a base branch name from GitHub is one short redacted line in the text", () => {
    const text = branchConflictStopMessage(`main\n‮ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"} ${"x".repeat(300)}`);
    expect(text).not.toMatch(/[\n‮]/u);
    expect(text).not.toContain("A1b2C3d4E5f6");
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text.endsWith(" after 2 tries. Resolve it on GitHub or close the task.")).toBe(true);
  });
});

describe("a clean merge of the base, recorded", () => {
  it("moves the candidate to the merge on the new base, keeps the checks and reviews for it, and records the head before the merge", () => {
    const next = recordWorkflowBranchSync(syncing(), clean);
    expect(next).toMatchObject({ revision: 12, stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(next.branchSync).toBeUndefined();
    expect(next.candidate?.digest).not.toBe(candidate.digest);
    expect(next.candidate?.repositories).toEqual([{ repositoryId: "payments", commitSha: MERGE, treeSha: MERGED_TREE, baseCommitSha: BASE_NEW }]);
    // The next review diffs only Rovara's change.
    expect(next.reviewBase).toEqual([{ repositoryId: "payments", baseCommitSha: BASE_NEW }]);
    expect(next.pullRequests?.[0]).toMatchObject({ headSha: MERGE, headTreeSha: MERGED_TREE, candidateDigest: next.candidate?.digest, syncedFrom: HEAD_A, state: "OPEN" });
    expect(next.verification?.candidateDigest).toBe(next.candidate?.digest);
    expect(next.reviews?.map((review) => review.candidateDigest)).toEqual([next.candidate?.digest, next.candidate?.digest]);
    expect(next.pullRequestUpdatedAt).toBe(at);
    expect(WorkflowSnapshotSchema.safeParse(next).success).toBe(true);
  });

  it("keeps the risk, the accepted findings and a second pull request with the new candidate", () => {
    const two = createCandidateManifest([{ repositoryId: "payments", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: BASE_OLD }, { repositoryId: "billing", commitSha: "1".repeat(40), treeSha: "2".repeat(40), baseCommitSha: BASE_OLD }]);
    const risk = { level: "medium" as const, reasons: ["Changes 500 lines, more than 400."], candidateDigest: two.digest };
    const accepted = { candidateDigest: two.digest, role: "CRITIC" as const, fingerprint: "a".repeat(64), text: "A thing", reason: "fine", actorId: OWNER, at };
    const other = { ...PULL_REQUEST, repositoryId: "billing", number: 8, url: "https://github.com/acme/billing/pull/8" };
    const workflow = waiting({ candidate: two, risk, acceptedFindings: [accepted], pullRequests: [{ ...PULL_REQUEST, candidateDigest: two.digest }, { ...other, candidateDigest: two.digest }],
      reviewBase: [{ repositoryId: "payments", baseCommitSha: BASE_OLD }, { repositoryId: "billing", baseCommitSha: BASE_OLD }],
      verification: { candidateDigest: two.digest, producer: "broker", environmentId: "test", recordedAt: at, results: [{ checkId: "unit", status: "PASS" }] },
      reviews: [reviewOf("CRITIC", two.digest), reviewOf("SECURITY", two.digest)] });
    const next = recordWorkflowBranchSync(startWorkflowBranchSyncRun(startWorkflowBranchSync(workflow, { repositoryId: "payments", number: 7, reason: "behind", now: at }), at), clean);
    const digest = next.candidate!.digest;
    expect(next.risk?.candidateDigest).toBe(digest);
    expect(next.acceptedFindings?.[0]?.candidateDigest).toBe(digest);
    // The other repository's entry and base are untouched; its pull request holds the same code under the new candidate.
    expect(next.candidate?.repositories.find((entry) => entry.repositoryId === "billing")).toMatchObject({ commitSha: "1".repeat(40), baseCommitSha: BASE_OLD });
    expect(next.reviewBase).toEqual([{ repositoryId: "billing", baseCommitSha: BASE_OLD }, { repositoryId: "payments", baseCommitSha: BASE_NEW }]);
    expect(next.pullRequests?.find((entry) => entry.number === 8)).toMatchObject({ candidateDigest: digest, headSha: HEAD_A });
    expect(next.pullRequests?.find((entry) => entry.number === 8)?.syncedFrom).toBeUndefined();
  });

  it("a second clean merge keeps the head from before the run of merges, so an approval of it can carry", () => {
    const first = recordWorkflowBranchSync(syncing(), clean);
    const second = recordWorkflowBranchSync(startWorkflowBranchSyncRun(startWorkflowBranchSync(first, { repositoryId: "payments", number: 7, reason: "behind", now: at }), at),
      { ...clean, headSha: "8".repeat(40), headTreeSha: "d".repeat(40), baseCommitSha: "7".repeat(40), previousHeadSha: MERGE });
    expect(second.pullRequests?.[0]).toMatchObject({ headSha: "8".repeat(40), syncedFrom: HEAD_A });
  });

  it("a fix pushed after a clean merge forgets it: what a person approved before the merge is not what the pull request holds", () => {
    const merged = recordWorkflowBranchSync(syncing(), clean);
    expect(merged.pullRequests?.[0]?.syncedFrom).toBe(HEAD_A);
    const started = startWorkflowFix(merged, { source: "ci", problems: ["test"], now: at });
    const fixed = createCandidateManifest([{ repositoryId: "payments", commitSha: "5".repeat(40), treeSha: "4".repeat(40), baseCommitSha: BASE_NEW }]);
    const pushing = WorkflowSnapshotSchema.parse({
      ...started, revision: 30, stage: "PULL_REQUEST", state: "RUNNING", candidate: fixed,
      verification: { candidateDigest: fixed.digest, producer: "broker", environmentId: "test", recordedAt: at, results: [{ checkId: "unit", status: "PASS" }] },
      reviews: [reviewOf("CRITIC", fixed.digest), reviewOf("SECURITY", fixed.digest)],
    });
    const landed = recordWorkflowPullRequestUpdate(pushing, { updates: [{ repositoryId: "payments", number: 7, headSha: "6".repeat(40), headTreeSha: "4".repeat(40) }], now: at });
    expect(landed.pullRequests?.[0]?.headSha).toBe("6".repeat(40));
    expect(landed.pullRequests?.[0]?.syncedFrom).toBeUndefined();
  });

  it("is refused for a head the workflow did not record, when no merge is running, for a pull request that is not open, and for a bad commit", () => {
    expect(() => recordWorkflowBranchSync(syncing(), { ...clean, previousHeadSha: HEAD_B })).toThrow(WorkflowTransitionError);
    expect(() => recordWorkflowBranchSync(syncing(), { ...clean, previousHeadSha: undefined } as never)).toThrow(WorkflowTransitionError);
    expect(() => recordWorkflowBranchSync(syncing(), { ...clean, headSha: HEAD_A })).toThrow(WorkflowTransitionError);
    expect(() => recordWorkflowBranchSync(waiting(), clean)).toThrow(WorkflowTransitionError);
    expect(() => recordWorkflowBranchSync(syncing({ pullRequests: [{ ...PULL_REQUEST, state: "MERGED" }] }), clean)).toThrow(WorkflowTransitionError);
    expect(() => recordWorkflowBranchSync(syncing(), { ...clean, headSha: "zz" })).toThrow(WorkflowTransitionError);
    expect(() => recordWorkflowBranchSync(syncing(), { ...clean, number: 8 })).toThrow(WorkflowTransitionError);
    // A merge for another head than the one the marker names.
    const marked = { ...syncing(), branchSync: { repositoryId: "payments", number: 7, expectedHeadCommit: HEAD_B, reason: "behind" as const } };
    expect(() => recordWorkflowBranchSync(marked, clean)).toThrow(WorkflowTransitionError);
  });

  it("a CI fix after a clean merge is reviewed against the new base only (Finding 8); the old base is refused", () => {
    const merged = recordWorkflowBranchSync(syncing(), clean);
    const started = startWorkflowFix(merged, { source: "ci", problems: ["test"], now: at });
    const fixAt = (base: string) => createCandidateManifest([{ repositoryId: "payments", commitSha: "5".repeat(40), treeSha: "4".repeat(40), baseCommitSha: base }]);
    const verifying = (workflow: WorkflowSnapshot) => ({ ...workflow, stage: "VERIFY" as const, state: "WAITING" as const });
    const checks = (digest: string) => ({ candidateDigest: digest, producer: "broker", environmentId: "test", recordedAt: at, results: [{ checkId: "unit", status: "PASS" as const }] });
    const good = fixAt(BASE_NEW);
    expect(recordWorkflowVerification(verifying(started), { candidate: good, checks: checks(good.digest), now: at }).reviewBase).toEqual([{ repositoryId: "payments", baseCommitSha: BASE_NEW }]);
    const bad = fixAt(BASE_OLD);
    expect(() => recordWorkflowVerification(verifying(started), { candidate: bad, checks: checks(bad.digest), now: at })).toThrow(/base commit changed/);
  });
});

describe("a conflict, recorded", () => {
  const conflicted = (paths: readonly string[], extra: Record<string, unknown> = {}) => recordWorkflowSyncConflict(syncing(extra, "conflict"), { paths, baseCommit: BASE_NEW, now: at });

  it("starts a conflict round: back at coding, counted, with the first conflicting files by name", () => {
    const next = conflicted(["src/a.ts", "src/b.ts"]);
    expect(next).toMatchObject({ stage: "IMPLEMENT", state: "READY", fixSource: "conflict", fixProblems: ["src/a.ts", "src/b.ts"], fixRounds: { ci: 0, conflict: 1, feedbackAuto: 0 }, programStepId: "build", conflictBase: BASE_NEW });
    expect(next.branchSync).toBeUndefined();
    expect(WorkflowSnapshotSchema.safeParse(next).success).toBe(true);
  });

  it("pins the round's review base to the base commit whose merge conflicted, so the reviewers' diff shows a base change the fix took back", () => {
    const next = conflicted(["src/a.ts"]);
    expect(next.reviewBase).toEqual([{ repositoryId: "payments", baseCommitSha: BASE_NEW }]);
    // The candidate the round makes is on that base; the one on the pull request stays on the old base until the fix lands.
    expect(next.candidate?.repositories[0]?.baseCommitSha).toBe(BASE_OLD);
  });

  it("names at most five files, one clean line each, and counts rounds of its own kind", () => {
    const many = Array.from({ length: 30 }, (_, index) => `src/file-${String(index)}.ts`);
    expect(conflicted(many).fixProblems).toEqual(many.slice(0, 5));
    expect(conflicted([`src/\n‮evil ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}.ts`]).fixProblems?.[0]).not.toMatch(/[\n‮]|A1b2C3d4E5f6/u);
    expect(conflicted(["a"], { fixRounds: { ci: 3, conflict: 0, feedbackAuto: 2 } }).fixRounds).toEqual({ ci: 3, conflict: 1, feedbackAuto: 2 });
  });

  it("keeps the base commit of the conflict only for a conflict round", () => {
    expect(WorkflowSnapshotSchema.safeParse({ ...waiting(), conflictBase: BASE_NEW }).success).toBe(false);
    expect(WorkflowSnapshotSchema.safeParse({ ...conflicted(["a"]), conflictBase: BASE_NEW }).success).toBe(true);
    expect(() => recordWorkflowSyncConflict(syncing({}, "conflict"), { paths: ["a"], baseCommit: "short", now: at })).toThrow(WorkflowTransitionError);
  });

  it("is refused once the conflict rounds are used up, and when no merge is running", () => {
    expect(() => conflicted(["a"], { fixRounds: { ci: 0, conflict: CONFLICT_ROUNDS_MAX, feedbackAuto: 0 } })).toThrow(WorkflowTransitionError);
    expect(() => recordWorkflowSyncConflict(waiting(), { paths: ["a"], baseCommit: BASE_NEW, now: at })).toThrow(WorkflowTransitionError);
  });

  it("the fix pushed as a merge commit is recorded on the new base, with no head to carry an approval from", () => {
    const started = conflicted(["src/a.ts"]);
    const fixed = createCandidateManifest([{ repositoryId: "payments", commitSha: "5".repeat(40), treeSha: "4".repeat(40), baseCommitSha: BASE_OLD }]);
    const pushing = WorkflowSnapshotSchema.parse({
      ...started, revision: 30, stage: "PULL_REQUEST", state: "RUNNING", candidate: fixed,
      verification: { candidateDigest: fixed.digest, producer: "broker", environmentId: "test", recordedAt: at, results: [{ checkId: "unit", status: "PASS" }] },
      reviews: [reviewOf("CRITIC", fixed.digest), reviewOf("SECURITY", fixed.digest)],
    });
    const landed = recordWorkflowPullRequestUpdate(pushing, { updates: [{ repositoryId: "payments", number: 7, headSha: MERGE, headTreeSha: "4".repeat(40) }], now: at });
    const next = recordWorkflowBranchSync(landed, { repositoryId: "payments", number: 7, headSha: MERGE, headTreeSha: "4".repeat(40), baseCommitSha: BASE_NEW, now: at });
    expect(next).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", fixRounds: { conflict: 1 } });
    // The base commit of the conflict is kept only while the round runs.
    expect(landed.conflictBase).toBeUndefined();
    expect(next.candidate?.repositories).toEqual([{ repositoryId: "payments", commitSha: MERGE, treeSha: "4".repeat(40), baseCommitSha: BASE_NEW }]);
    expect(next.reviewBase).toEqual([{ repositoryId: "payments", baseCommitSha: BASE_NEW }]);
    expect(next.pullRequests?.[0]).toMatchObject({ headSha: MERGE, candidateDigest: next.candidate?.digest });
    // Code Rovara wrote carries no approval over.
    expect(next.pullRequests?.[0]?.syncedFrom).toBeUndefined();
    expect(next.reviews?.every((review) => review.candidateDigest === next.candidate?.digest)).toBe(true);
    // The pull request must hold the fix: another head or tree is refused.
    expect(() => recordWorkflowBranchSync(landed, { repositoryId: "payments", number: 7, headSha: HEAD_B, headTreeSha: "4".repeat(40), baseCommitSha: BASE_NEW, now: at })).toThrow(WorkflowTransitionError);
    expect(() => recordWorkflowBranchSync(landed, { repositoryId: "payments", number: 7, headSha: MERGE, headTreeSha: "3".repeat(40), baseCommitSha: BASE_NEW, now: at })).toThrow(WorkflowTransitionError);
  });
});

// ---- the day, the count, the decisions

const itemOf = (overrides: Partial<MergeTrackingItem> = {}): Pick<MergeTrackingItem, "branch" | "review" | "approval" | "syncs" | "headByRovara" | "headSha"> => ({
  headSha: HEAD_A, branch: "behind", review: "approved", approval: { githubUserId: "1", login: "maint", commitId: HEAD_A }, syncs: { day: "2026-10-25", count: 0 }, headByRovara: true, ...overrides,
});
const DAY = Date.parse("2026-10-25T12:00:00.000Z");

describe("the day's count of merges", () => {
  it("is the UTC day, and a count of another day is no count", () => {
    expect(utcDay(Date.parse("2026-10-25T23:59:59.999Z"))).toBe("2026-10-25");
    expect(utcDay(Date.parse("2026-10-26T00:00:00.000Z"))).toBe("2026-10-26");
    expect(syncsToday({ day: "2026-10-25", count: 3 }, DAY)).toBe(3);
    expect(syncsToday({ day: "2026-10-24", count: 4 }, DAY)).toBe(0);
    expect(bumpSyncs({ day: "2026-10-25", count: 3 }, DAY)).toEqual({ day: "2026-10-25", count: 4 });
    expect(bumpSyncs({ day: "2026-10-24", count: 4 }, DAY)).toEqual({ day: "2026-10-25", count: 1 });
  });

  it("is capped: the fifth of a day is not counted past the schema's bound", () => {
    expect(BRANCH_SYNCS_PER_DAY_MAX).toBe(4);
    expect(() => bumpSyncs({ day: "2026-10-25", count: 4 }, DAY)).toThrow(/day/);
  });
});

describe("when to merge the base", () => {
  it("only when behind, GitHub says the base requires it, a counted approval is there and the day's merges are not used up", () => {
    const decide = (item: ReturnType<typeof itemOf>, behindRequired = true, now = DAY) => decideBranchSync({ item, behindRequired, now });
    expect(decide(itemOf())).toBe("sync");
    // No approval: nobody needs the branch up to date yet.
    expect(decide(itemOf({ review: "requested", approval: undefined }))).toBe("none");
    expect(decide(itemOf({ review: "approved", approval: undefined }))).toBe("none");
    expect(decide(itemOf({ review: "changes_requested" }))).toBe("none");
    // Behind by a commit count alone, with a base that does not require it: not needed.
    expect(decide(itemOf(), false)).toBe("none");
    for (const branch of ["up_to_date", "conflicted", "unknown"] as const) expect(decide(itemOf({ branch }))).toBe("none");
    expect(decide(itemOf({ syncs: { day: "2026-10-25", count: 3 } }))).toBe("sync");
    expect(decide(itemOf({ syncs: { day: "2026-10-25", count: 4 } }))).toBe("none");
    // Yesterday's four do not count today.
    expect(decide(itemOf({ syncs: { day: "2026-10-24", count: 4 } }))).toBe("sync");
    expect(decide(itemOf({ syncs: { day: "2026-10-25", count: 4 } }), true, Date.parse("2026-10-26T00:00:00.000Z"))).toBe("sync");
  });

  it("a conflict is a merge to try, until the conflict rounds are used up; then the stop; with the day's merges used up it waits", () => {
    const decide = (item: ReturnType<typeof itemOf>, conflict = 0, autonomy: "suggest" | "prepare" | "run" = "prepare", approved?: string[]) =>
      decideConflict({ item, workflow: { fixRounds: { ci: 0, conflict, feedbackAuto: 0 }, ...(approved === undefined ? {} : { conflictApproved: approved }) }, autonomy, now: DAY });
    expect(decide(itemOf({ branch: "conflicted", review: "requested", approval: undefined }))).toBe("sync");
    expect(decide(itemOf({ branch: "conflicted" }), 1)).toBe("sync");
    expect(decide(itemOf({ branch: "conflicted" }), CONFLICT_ROUNDS_MAX)).toBe("stop");
    expect(decide(itemOf({ branch: "conflicted", syncs: { day: "2026-10-25", count: 4 } }), 0)).toBe("none");
    // The stop does not wait for the day: it needs no machine.
    expect(decide(itemOf({ branch: "conflicted", syncs: { day: "2026-10-25", count: 4 } }), CONFLICT_ROUNDS_MAX)).toBe("stop");
    for (const branch of ["behind", "up_to_date", "unknown"] as const) expect(decide(itemOf({ branch }))).toBe("none");
    expect(decideConflict({ item: itemOf({ branch: "conflicted" }), workflow: {}, autonomy: "run", now: DAY })).toBe("sync");
    // With the agent set to suggest a conflict is asked about, never left silent (even when the day's merges are used up: asking needs no machine); a go-ahead for this head lets it go on.
    const conflicted = itemOf({ branch: "conflicted" });
    expect(decide(conflicted, 0, "suggest")).toBe("ask");
    expect(decide(itemOf({ branch: "conflicted", syncs: { day: "2026-10-25", count: 4 } }), 0, "suggest")).toBe("ask");
    expect(decide(conflicted, 1, "suggest")).toBe("ask");
    expect(decide(conflicted, 0, "suggest", [HEAD_A])).toBe("sync");
    expect(decide(conflicted, 0, "suggest", [HEAD_B])).toBe("ask");
    expect(decide(conflicted, CONFLICT_ROUNDS_MAX, "suggest", [HEAD_A])).toBe("stop");
  });
});

// ---- the slots over a fake GitHub

const approved = (headSha = HEAD_A) => [{ githubUserId: "1", login: "maint", userType: "User", state: "APPROVED" as const, commitId: headSha, submittedAt: "2026-10-25T09:00:00.000Z" }];

function syncWorld(options: { workflow?: WorkflowSnapshot; overrides?: Parameters<typeof status>[0]; approved?: boolean } = {}): TrackingWorld {
  const w = world({ sessionId: SESSION_ID });
  w.github.statuses.set(7, status({ draft: false, mergeableState: "behind", mergeable: true, behindBy: 3, reviews: options.approved === false ? [] : approved(), ...options.overrides }));
  w.github.permissions.set("maint", "write");
  w.setTask({ workflow: options.workflow ?? waiting() });
  return w;
}
const workflowOf = (w: TrackingWorld): WorkflowSnapshot => WorkflowSnapshotSchema.parse(w.task().workflow);
const dispatchRows = (w: TrackingWorld) => w.db.find((item) => item.pk === "WORKFLOW_DISPATCH");
const milestones = (w: TrackingWorld, kind: string) => w.db.find((item) => item.entityType === "CODE_MILESTONE" && item.kind === kind);
const trackingOf = (w: TrackingWorld) => w.db.get(mergeTrackingKey(TASK_ID, "payments", 7)) as unknown as MergeTrackingItem;

afterEach(() => {
  uninstallBranchSyncDeciders();
  uninstallCiFixDecider();
});

describe("the sync slot of merge tracking", () => {
  it("merges the base into a behind branch that has a counted approval: the workflow queues the merge, with its dispatch row, and the day's count is kept on the tracking item", async () => {
    installBranchSyncDeciders();
    const w = syncWorld();
    expect(await trackPullRequest(w.deps, TASK_ID)).toBe("changed");
    expect(workflowOf(w)).toMatchObject({ revision: 10, stage: "WAIT_FOR_MERGE", state: "READY", branchSync: { repositoryId: "payments", number: 7, expectedHeadCommit: HEAD_A, reason: "behind" } });
    expect(dispatchRows(w)).toEqual([expect.objectContaining({ sk: `${TASK_ID}#10`, kind: "SYNC", workflowRevision: 10, candidateDigest: candidate.digest, attempts: 0 })]);
    expect(trackingOf(w).syncs).toEqual({ day: "2026-10-25", count: 1 });
    expect(trackingOf(w)).toMatchObject({ branch: "behind", review: "approved", headByRovara: true });
  });

  it("does not merge a behind branch with no approval, or one GitHub does not say the base requires", async () => {
    installBranchSyncDeciders();
    const noApproval = syncWorld({ approved: false });
    await trackPullRequest(noApproval.deps, TASK_ID);
    expect(workflowOf(noApproval)).toMatchObject({ revision: 9, state: "WAITING" });
    expect(dispatchRows(noApproval)).toEqual([]);
    const notRequired = syncWorld({ overrides: { mergeableState: "clean", behindBy: 3 } });
    await trackPullRequest(notRequired.deps, TASK_ID);
    expect(dispatchRows(notRequired)).toEqual([]);
    expect(workflowOf(notRequired).state).toBe("WAITING");
  });

  it("never merges into a head a person pushed", async () => {
    installBranchSyncDeciders();
    const w = syncWorld({ overrides: { headSha: HEAD_B } });
    await trackPullRequest(w.deps, TASK_ID);
    expect(trackingOf(w).headByRovara).toBe(false);
    expect(workflowOf(w)).toMatchObject({ revision: 9, state: "WAITING" });
    expect(dispatchRows(w)).toEqual([]);
    expect(trackingOf(w).syncs.count).toBe(0);
  });

  it("waits when the head GitHub shows is one the pull request record has but the workflow has not recorded yet: no merge of the day is used on it", async () => {
    installBranchSyncDeciders();
    const w = syncWorld({ overrides: { headSha: HEAD_B } });
    (w.deps as { recordedHead?: unknown }).recordedHead = async () => HEAD_B;
    await trackPullRequest(w.deps, TASK_ID);
    expect(trackingOf(w)).toMatchObject({ headByRovara: true, syncs: { count: 0 } });
    expect(workflowOf(w)).toMatchObject({ revision: 9, state: "WAITING" });
    expect(dispatchRows(w)).toEqual([]);
  });

  it("does nothing while the owner's card waits, while a fix is under way, or for a pull request that is not open", async () => {
    installBranchSyncDeciders();
    const fixing = syncWorld({ workflow: startWorkflowFix(waiting(), { source: "ci", problems: ["test"], now: at }) });
    await trackPullRequest(fixing.deps, TASK_ID);
    expect(dispatchRows(fixing)).toEqual([]);
    const closed = syncWorld({ overrides: { state: "closed" } });
    await trackPullRequest(closed.deps, TASK_ID);
    expect(dispatchRows(closed)).toEqual([]);
  });

  it("a base that moves every five minutes for a day gives at most four merges a UTC day, and the next day four more", async () => {
    installBranchSyncDeciders();
    const w = syncWorld();
    const FIVE_MINUTES = 5 * 60_000;
    const start = Date.parse("2026-10-25T00:00:00.000Z");
    const rowsByDay = new Map<string, number>();
    for (let step = 0; step < (48 * 60) / 5; step += 1) {
      w.setNow(start + step * FIVE_MINUTES);
      await trackPullRequest(w.deps, TASK_ID);
      const queued = workflowOf(w);
      if (queued.branchSync === undefined) continue;
      // The merge ran and pushed nothing that changed the picture: the base is still ahead (it moved again), and the task waits again.
      const day = utcDay(w.now());
      rowsByDay.set(day, (rowsByDay.get(day) ?? 0) + 1);
      w.setTask({ workflow: endWorkflowBranchSync(queued, new Date(w.now()).toISOString()) });
    }
    expect([...rowsByDay.entries()]).toEqual([["2026-10-25", 4], ["2026-10-26", 4]]);
    expect(dispatchRows(w)).toHaveLength(8);
    expect(trackingOf(w).syncs).toEqual({ day: "2026-10-26", count: 4 });
  });
});

describe("a head the workflow has not recorded yet", () => {
  it("starts no fix round on it: failing CI on a head the pull request record has and the workflow does not (a merge whose result was lost) waits for the workflow to learn it", async () => {
    installCiFixDecider();
    installBranchSyncDeciders();
    const w = syncWorld({ overrides: { headSha: HEAD_B, checks: [{ name: "test", status: "completed", conclusion: "failure", required: false, url: "https://example.test/1" }] } });
    (w.deps as { recordedHead?: unknown }).recordedHead = async () => HEAD_B;
    await trackPullRequest(w.deps, TASK_ID);
    expect(trackingOf(w)).toMatchObject({ headByRovara: true, ci: "failing" });
    expect(workflowOf(w)).toMatchObject({ revision: 9, stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(dispatchRows(w)).toEqual([]);
    expect(milestones(w, "fixing")).toEqual([]);
    expect(workflowOf(w).fixRounds).toBeUndefined();
  });
});

describe("the agent's autonomy", () => {
  it("with suggest, Rovara merges nothing behind a base on its own, and a conflict is asked about: a block with the owner's text and a stuck milestone, no machine, no count", async () => {
    installBranchSyncDeciders();
    const behind = syncWorld();
    (behind.deps as { autonomy?: unknown }).autonomy = () => "suggest";
    await trackPullRequest(behind.deps, TASK_ID);
    expect(workflowOf(behind)).toMatchObject({ revision: 9, state: "WAITING" });
    expect(dispatchRows(behind)).toEqual([]);

    const w = syncWorld({ overrides: { mergeable: false, mergeableState: "dirty" } });
    (w.deps as { autonomy?: unknown }).autonomy = () => "suggest";
    await trackPullRequest(w.deps, TASK_ID);
    const asked = "The branch conflicts with main. Rovara is set to suggest, so it won't change the branch on its own. Retry to let it resolve the conflict, or update the branch on GitHub.";
    expect(branchConflictAskMessage("main")).toBe(asked);
    expect(workflowOf(w)).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "BLOCKED", blockReason: asked });
    expect(dispatchRows(w)).toEqual([]);
    expect(trackingOf(w).syncs.count).toBe(0);
    expect(milestones(w, "stuck")).toEqual([expect.objectContaining({ text: asked })]);
    // Asked once: the blocked task is not decided about again.
    await trackPullRequest(w.deps, TASK_ID);
    expect(milestones(w, "stuck")).toHaveLength(1);

    // The owner's Retry is one go-ahead for this head; the next pass starts the merge, marked as approved, and the go-ahead is used up.
    w.setTask({ workflow: retryWorkflowBranchSync(workflowOf(w), at) });
    expect(workflowOf(w)).toMatchObject({ state: "WAITING", conflictApproved: [HEAD_A] });
    await trackPullRequest(w.deps, TASK_ID);
    expect(workflowOf(w)).toMatchObject({ state: "READY", branchSync: { reason: "conflict", approved: true } });
    expect(workflowOf(w).conflictApproved).toBeUndefined();
    expect(dispatchRows(w)).toEqual([expect.objectContaining({ kind: "SYNC" })]);

    const used = syncWorld({ workflow: waiting({ fixRounds: { ci: 0, conflict: CONFLICT_ROUNDS_MAX, feedbackAuto: 0 } }), overrides: { mergeable: false, mergeableState: "dirty" } });
    (used.deps as { autonomy?: unknown }).autonomy = () => "suggest";
    await trackPullRequest(used.deps, TASK_ID);
    expect(workflowOf(used)).toMatchObject({ state: "BLOCKED", blockReason: branchConflictStopMessage("main") });
    for (const autonomy of ["prepare", "run"] as const) {
      const other = syncWorld();
      (other.deps as { autonomy?: unknown }).autonomy = () => autonomy;
      await trackPullRequest(other.deps, TASK_ID);
      expect(workflowOf(other)).toMatchObject({ state: "READY" });
    }
  });

  it("Retry is for the ask only, and keeps the rounds counted", () => {
    const asked = blockWorkflowBranchSync(waiting({ fixRounds: { ci: 0, conflict: 1, feedbackAuto: 0 } }), { reason: branchConflictAskMessage("main"), now: at });
    expect(isBranchConflictAskReason(asked.blockReason)).toBe(true);
    expect(isBranchSyncBlockReason(asked.blockReason)).toBe(true);
    expect(isBranchConflictAskReason(branchConflictStopMessage("main"))).toBe(false);
    const retried = retryWorkflowBranchSync(asked, at);
    expect(retried).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", conflictApproved: [HEAD_A], fixRounds: { conflict: 1 } });
    expect(retried.blockReason).toBeUndefined();
    expect(workflowFollowsOnlyMerge(asked)).toBe(true);
    for (const other of [waiting(), blockWorkflowBranchSync(waiting(), { reason: branchConflictStopMessage("main"), now: at }), blockWorkflowBranchSync(waiting(), { reason: BRANCH_WORKFLOW_FILES_MESSAGE, now: at })]) {
      expect(() => retryWorkflowBranchSync(other, at)).toThrow(WorkflowTransitionError);
    }
    expect(() => retryWorkflowBranchSync(blockWorkflowBranchSync(waiting({ pullRequests: [{ ...PULL_REQUEST, headSha: undefined }] }), { reason: branchConflictAskMessage("main"), now: at }), at)).toThrow(WorkflowTransitionError);
    // A go-ahead is used by the merge it starts.
    const started = startWorkflowBranchSync(retried, { repositoryId: "payments", number: 7, reason: "conflict", now: at });
    expect(started.conflictApproved).toBeUndefined();
    expect(started.branchSync?.approved).toBe(true);
    expect(startWorkflowBranchSync(waiting(), { repositoryId: "payments", number: 7, reason: "conflict", now: at }).branchSync?.approved).toBeUndefined();
  });
});

describe("the conflict slot of merge tracking", () => {
  const conflictedStatus = { mergeable: false, mergeableState: "dirty" as const };

  it("tries the merge on a conflicted branch whether or not it is approved: the workflow queues it for a conflict", async () => {
    installBranchSyncDeciders();
    const w = syncWorld({ approved: false, overrides: conflictedStatus });
    await trackPullRequest(w.deps, TASK_ID);
    expect(workflowOf(w)).toMatchObject({ state: "READY", branchSync: { reason: "conflict", expectedHeadCommit: HEAD_A } });
    expect(dispatchRows(w)).toEqual([expect.objectContaining({ kind: "SYNC" })]);
    expect(trackingOf(w).syncs.count).toBe(1);
  });

  it("two conflict rounds that did not help stop with the exact text and a stuck milestone, and start no machine", async () => {
    installBranchSyncDeciders();
    const w = syncWorld({ workflow: waiting({ fixRounds: { ci: 0, conflict: CONFLICT_ROUNDS_MAX, feedbackAuto: 0 } }), overrides: conflictedStatus });
    await trackPullRequest(w.deps, TASK_ID);
    expect(workflowOf(w)).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "BLOCKED", blockReason: "The branch still conflicts with main after 2 tries. Resolve it on GitHub or close the task." });
    expect(dispatchRows(w)).toEqual([]);
    expect(milestones(w, "stuck")).toEqual([expect.objectContaining({ text: "The branch still conflicts with main after 2 tries. Resolve it on GitHub or close the task.", pullRequests: [{ repository: "payments", number: 7, url: PULL_REQUEST.url }] })]);
    expect(trackingOf(w).syncs.count).toBe(0);
  });

  it("a conflicted branch waits when the day's merges are used up, and is not stopped for it", async () => {
    installBranchSyncDeciders();
    const w = syncWorld({ overrides: conflictedStatus });
    // Four merges already today (the tracking item keeps the count).
    await trackPullRequest(w.deps, TASK_ID);
    w.setTask({ workflow: endWorkflowBranchSync(workflowOf(w), at) });
    for (let again = 0; again < 3; again += 1) {
      await trackPullRequest(w.deps, TASK_ID);
      w.setTask({ workflow: endWorkflowBranchSync(workflowOf(w), at) });
    }
    expect(trackingOf(w).syncs.count).toBe(4);
    const rows = dispatchRows(w).length;
    await trackPullRequest(w.deps, TASK_ID);
    expect(dispatchRows(w)).toHaveLength(rows);
    expect(workflowOf(w)).toMatchObject({ state: "WAITING" });
    expect(milestones(w, "stuck")).toEqual([]);
  });

  it("a conflict comes before failing CI, and CI before a sync", async () => {
    installCiFixDecider();
    installBranchSyncDeciders();
    const both = syncWorld({ overrides: { mergeable: false, mergeableState: "dirty", checks: [{ name: "test", status: "completed", conclusion: "failure", required: false, url: "https://example.test/1" }] } });
    await trackPullRequest(both.deps, TASK_ID);
    expect(workflowOf(both)).toMatchObject({ state: "READY", branchSync: { reason: "conflict" } });
    const ciAndBehind = syncWorld({ overrides: { checks: [{ name: "test", status: "completed", conclusion: "failure", required: false, url: "https://example.test/1" }] } });
    await trackPullRequest(ciAndBehind.deps, TASK_ID);
    expect(workflowOf(ciAndBehind)).toMatchObject({ stage: "IMPLEMENT", fixSource: "ci" });
    expect(dispatchRows(ciAndBehind).map((row) => row.kind)).toEqual(["IMPLEMENT"]);
  });
});

describe("the deciders are the slots'", () => {
  it("fill the conflict and sync slots once, and give them back", async () => {
    installBranchSyncDeciders();
    installBranchSyncDeciders();
    const w = syncWorld();
    expect(conflictDecider({ item: { ...trackingBase(), branch: "behind" }, workflow: waiting(), settings: { allowSelfApproval: false, mergeMethod: "squash", codeReviewers: [], revision: 0 }, autonomy: "prepare", now: NOW })).toBeUndefined();
    expect(syncDecider({ item: { ...trackingBase(), branch: "behind" }, workflow: waiting(), settings: { allowSelfApproval: false, mergeMethod: "squash", codeReviewers: [], revision: 0 }, autonomy: "prepare", now: NOW })).toBeUndefined();
    expect(w).toBeDefined();
  });
});

function trackingBase(): MergeTrackingItem {
  return {
    orgId: "org_aaaaaaaaaaaaaaaaaaaa", taskId: TASK_ID, repositoryId: "payments", number: 7, version: 1, headSha: HEAD_A, draft: false, state: "open", baseBranch: "main", ci: "passing", ciBasis: "all_checks",
    checksEverSeen: true, failingChecks: [], review: "approved", approval: { githubUserId: "1", login: "maint", commitId: HEAD_A }, branch: "behind", headByRovara: true, nudges: { count: 0 },
    syncs: { day: "2026-10-25", count: 0 }, decisionDigest: "d".repeat(64), observedAt: at,
  };
}

// ---- what a finished merge is

describe("what a finished merge of the base is", () => {
  const binding = { repositoryId: "payments", number: 7, baseCommit: BASE_NEW, expectedHeadCommit: HEAD_A };
  const result = (overrides: Record<string, unknown> = {}) => ({
    action: "sync" as const, repository: "payments", number: 7, url: PULL_REQUEST.url, state: "open" as const, headBranch: "agentx/00000000-0000-4000-8000-000000000001", baseBranch: "main",
    previousCommit: HEAD_A, commit: MERGE, treeSha: MERGED_TREE, checks: [], codeBuildChecks: [], reconciled: false, ...overrides,
  });
  const github = (overrides: Record<string, unknown> = {}) => ({ state: "open" as const, headBranch: "agentx/00000000-0000-4000-8000-000000000001", headCommit: MERGE, headTreeSha: MERGED_TREE, parents: [HEAD_A, BASE_NEW], ...overrides });
  const plan = (input: { askFirst?: boolean; workflow?: WorkflowSnapshot; status?: "SUCCEEDED" | "FAILED"; error?: string; result?: Record<string, unknown> | undefined; github?: ReturnType<typeof github> | undefined; baseBranch?: string }) =>
    planBranchSyncOutcome({
      workflow: input.workflow ?? syncing(), binding, terminalStatus: input.status ?? "SUCCEEDED", ...(input.error === undefined ? {} : { terminalError: input.error }),
      result: "result" in input ? input.result as never : result(), github: "github" in input ? input.github : github(), baseBranch: input.baseBranch ?? "main",
      recordedBranch: "agentx/00000000-0000-4000-8000-000000000001", now: at, ...(input.askFirst === undefined ? {} : { askFirst: input.askFirst }),
    });

  it("is a clean merge when GitHub shows the merge commit on the recorded head and the base, with the tree the worker said", () => {
    const outcome = plan({});
    expect(outcome.kind).toBe("synced");
    if (outcome.kind !== "synced") return;
    expect(outcome.workflow).toMatchObject({ state: "WAITING", pullRequests: [expect.objectContaining({ headSha: MERGE, syncedFrom: HEAD_A })] });
    expect(outcome).toMatchObject({ headSha: MERGE, headTreeSha: MERGED_TREE, previousHeadSha: HEAD_A, baseCommitSha: BASE_NEW });
  });

  it("is a merge even when the worker's result was lost, if GitHub shows it: but Rovara's checks are unproven then, so no head is kept for an approval to carry from", () => {
    const outcome = plan({ status: "FAILED", error: "RUNTIME_UNAVAILABLE: compute lost", result: undefined });
    expect(outcome.kind).toBe("synced");
    if (outcome.kind !== "synced") return;
    expect(outcome.workflow.pullRequests?.[0]).toMatchObject({ headSha: MERGE });
    expect(outcome.workflow.pullRequests?.[0]?.syncedFrom).toBeUndefined();
    expect(outcome.workflow.candidate?.repositories[0]).toMatchObject({ commitSha: MERGE, baseCommitSha: BASE_NEW });
    // The same merge with its result in hand is one Rovara's checks passed on.
    const verified = plan({});
    expect(verified.kind === "synced" && verified.workflow.pullRequests?.[0]?.syncedFrom).toBe(HEAD_A);
  });

  it("is refused when the merge commit's second parent is not the base commit, or its first is not the recorded head, or the tree is not the one reported", () => {
    for (const bad of [{ parents: [HEAD_A, "1".repeat(40)] }, { parents: [HEAD_B, BASE_NEW] }, { parents: [BASE_NEW, HEAD_A] }, { parents: [HEAD_A] }, { parents: [HEAD_A, BASE_NEW, MERGE] }, { parents: undefined }]) {
      expect(plan({ github: github(bad) }).kind, JSON.stringify(bad)).toBe("unchanged");
    }
    expect(plan({ github: github({ headTreeSha: "3".repeat(40) }) }).kind).toBe("unchanged");
    expect(plan({ github: github({ headCommit: "1".repeat(40) }) }).kind).toBe("unchanged");
    expect(plan({ github: github({ headBranch: "agentx/other" }) }).kind).toBe("unchanged");
    expect(plan({ github: github({ state: "closed" }) }).kind).toBe("unchanged");
    expect(plan({ github: undefined }).kind).toBe("unchanged");
  });

  it("is not a conflict round when the head moved meanwhile (a person pushed): nothing is started over their push", () => {
    const outcome = plan({ result: result({ commit: HEAD_A, treeSha: undefined, reconciled: true, conflicts: ["a"] }), github: github({ headCommit: HEAD_B, parents: [HEAD_A] }) });
    expect(outcome.kind).toBe("unchanged");
  });

  it("is nothing to record when the branch already had the base, or when GitHub shows a head that is not the merge (a person pushed)", () => {
    const upToDate = plan({ result: result({ commit: HEAD_A, reconciled: true }), github: github({ headCommit: HEAD_A, headTreeSha: "b".repeat(40), parents: [BASE_OLD] }) });
    expect(upToDate.kind).toBe("unchanged");
    if (upToDate.kind === "unchanged") expect(upToDate.workflow).toMatchObject({ state: "WAITING" });
    expect(plan({ github: github({ headCommit: HEAD_B, parents: [HEAD_A] }) }).kind).toBe("unchanged");
  });

  it("is a conflict round when the merge conflicted, naming the files; the workflow starts the fix", () => {
    const outcome = plan({ result: result({ commit: HEAD_A, previousCommit: HEAD_A, treeSha: undefined, reconciled: true, conflicts: ["src/a.ts", "src/b.ts"] }), github: github({ headCommit: HEAD_A, headTreeSha: "b".repeat(40), parents: [BASE_OLD] }) });
    expect(outcome.kind).toBe("conflict");
    if (outcome.kind !== "conflict") return;
    expect(outcome.paths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(outcome.workflow).toMatchObject({ stage: "IMPLEMENT", state: "READY", fixSource: "conflict", fixProblems: ["src/a.ts", "src/b.ts"], fixRounds: { conflict: 1 } });
  });

  it("asks instead of starting the round when the agent is set to suggest by now and the merge was not approved (autonomy is read again at the paid step)", () => {
    const outcome = plan({ result: result({ commit: HEAD_A, treeSha: undefined, reconciled: true, conflicts: ["a"] }), github: github({ headCommit: HEAD_A, parents: [BASE_OLD] }), askFirst: true });
    expect(outcome).toMatchObject({ kind: "asked", message: branchConflictAskMessage("main") });
    if (outcome.kind === "asked") expect(outcome.workflow).toMatchObject({ state: "BLOCKED", blockReason: outcome.message });
    expect(plan({ result: result({ commit: HEAD_A, treeSha: undefined, reconciled: true, conflicts: ["a"] }), github: github({ headCommit: HEAD_A, parents: [BASE_OLD] }), askFirst: false }).kind).toBe("conflict");
  });

  it("stops with the exact text when it conflicts after the conflict rounds, naming the pull request's base branch", () => {
    const used = syncing({ fixRounds: { ci: 0, conflict: CONFLICT_ROUNDS_MAX, feedbackAuto: 0 } }, "conflict");
    const outcome = plan({ workflow: used, baseBranch: "develop", result: result({ commit: HEAD_A, treeSha: undefined, reconciled: true, conflicts: ["a"] }), github: github({ headCommit: HEAD_A, parents: [BASE_OLD] }) });
    expect(outcome).toMatchObject({ kind: "stopped", message: "The branch still conflicts with develop after 2 tries. Resolve it on GitHub or close the task." });
    if (outcome.kind === "stopped") expect(outcome.workflow).toMatchObject({ state: "BLOCKED", blockReason: outcome.message });
  });

  it("stops with the exact text when GitHub refused the push of workflow files, and not as a conflict round", () => {
    const refused = "RUNTIME_UNAVAILABLE: ! [remote rejected] HEAD -> agentx/x (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)";
    expect(isWorkflowFilesRefusal(refused)).toBe(true);
    const outcome = plan({ status: "FAILED", error: refused, result: undefined, github: github({ headCommit: HEAD_A, parents: [BASE_OLD] }) });
    expect(outcome).toMatchObject({ kind: "stopped", message: "The base branch changed CI workflow files, which Rovara can't push. Update the branch on GitHub." });
    if (outcome.kind === "stopped") expect(outcome.workflow.fixRounds).toBeUndefined();
  });

  it("is told from other failures: a failed check, a moved head, a lost machine end the merge with nothing recorded", () => {
    for (const error of ["CONFIG_INVALID: one or more registered readiness checks failed", "STALE_FENCE: pull request head changed since AgentX last observed it", "RUNTIME_UNAVAILABLE: compute lost", "CONFIG_INVALID: pull request branch conflicts with the latest base"]) {
      expect(isWorkflowFilesRefusal(error), error).toBe(false);
      const outcome = plan({ status: "FAILED", error, result: undefined, github: github({ headCommit: HEAD_A, parents: [BASE_OLD] }) });
      expect(outcome.kind, error).toBe("unchanged");
      if (outcome.kind === "unchanged") expect(outcome.workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    }
    expect(isWorkflowFilesRefusal(undefined)).toBe(false);
  });
});

describe("the request of a merge", () => {
  it("is the same for the same attempt and another for another base commit or revision", () => {
    expect(branchSyncRequestId(TASK_ID, 10, BASE_NEW)).toBe(branchSyncRequestId(TASK_ID, 10, BASE_NEW));
    expect(branchSyncRequestId(TASK_ID, 10, BASE_NEW)).not.toBe(branchSyncRequestId(TASK_ID, 10, BASE_OLD));
    expect(branchSyncRequestId(TASK_ID, 10, BASE_NEW)).not.toBe(branchSyncRequestId(TASK_ID, 12, BASE_NEW));
    expect(branchSyncRequestId(TASK_ID, 10, BASE_NEW)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("a conflict fix that would drop what the base brought", () => {
  const blocked = (): WorkflowSnapshot => blockWorkflowPullRequestUpdate(WorkflowSnapshotSchema.parse({ ...waiting(), stage: "PULL_REQUEST", state: "RUNNING" }), { numbers: [7], cause: "BASE_CHANGES_DROPPED", now: at });

  it("is told to the owner in its own words, and reads as a refused push to a client that does not know the cause", () => {
    const text = JSON.stringify(workflowMessage({ taskId: TASK_ID, workflow: blocked() })?.blocks);
    expect(text).toContain("the fix would have dropped changes the base branch made, so I didn't push it");
    const view = { workflow: blocked() } as never;
    const projected = taskViewForClient(view, {}) as { workflow: { pullRequestUpdateFailure: { cause: string } } };
    expect(projected.workflow.pullRequestUpdateFailure.cause).toBe("PUSH_REFUSED");
  });
});

describe("a merge that keeps failing", () => {
  const binding = { repositoryId: "payments", number: 7, baseCommit: BASE_NEW, expectedHeadCommit: HEAD_A };
  const failed = (workflow: WorkflowSnapshot, error: string | undefined) => planBranchSyncOutcome({
    workflow, binding, terminalStatus: "FAILED", ...(error === undefined ? {} : { terminalError: error }), result: undefined,
    github: { state: "open", headBranch: "agentx/00000000-0000-4000-8000-000000000001", headCommit: HEAD_A, headTreeSha: "b".repeat(40), parents: [BASE_OLD] },
    baseBranch: "main", recordedBranch: "agentx/00000000-0000-4000-8000-000000000001", now: at,
  });
  const CHECKS = "CONFIG_INVALID: one or more registered readiness checks failed";
  const again = (workflow: WorkflowSnapshot, reason: "behind" | "conflict" = "behind") => startWorkflowBranchSyncRun(startWorkflowBranchSync(workflow, { repositoryId: "payments", number: 7, reason, now: at }), at);

  it("a behind merge that really failed twice on the same head gives up without blocking the task: it stays behind and says so, once", () => {
    expect(SYNC_FAILURES_MAX).toBe(2);
    const first = failed(syncing(), CHECKS);
    expect(first.kind).toBe("unchanged");
    if (first.kind !== "unchanged") return;
    expect(first.workflow).toMatchObject({ state: "WAITING", syncFailures: { headSha: HEAD_A, count: 1 } });
    const second = failed(again(first.workflow), CHECKS);
    const text = "Rovara couldn't bring the branch up to date: the project's checks fail once the base is merged in. Update it on GitHub.";
    expect(second).toMatchObject({ kind: "gave_up", message: text });
    if (second.kind !== "gave_up") return;
    // Not blocked: CI fixes, feedback and conflict rounds go on; this head is simply not tried again.
    expect(second.workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", syncFailures: { headSha: HEAD_A, count: SYNC_FAILURES_MAX } });
    expect(second.workflow.blockReason).toBeUndefined();
    expect(branchSyncGiveUpMessage("other")).toBe("Rovara couldn't bring the branch up to date: the merge did not go through. Update it on GitHub.");
    expect(isBranchSyncGiveUpReason(text)).toBe(true);
    expect(isBranchSyncBlockReason(branchSyncGiveUpMessage("other"))).toBe(true);
  });

  it("a conflict merge that really failed twice blocks the task (a conflict has to be dealt with), and its Retry is one more try", () => {
    const first = failed(syncing({}, "conflict"), CHECKS);
    if (first.kind !== "unchanged") throw new Error("expected unchanged");
    const second = failed(again(first.workflow, "conflict"), CHECKS);
    expect(second.kind).toBe("stopped");
    if (second.kind !== "stopped") return;
    expect(second.workflow).toMatchObject({ state: "BLOCKED", blockReason: second.message });
    const retried = retryWorkflowBranchSync(second.workflow, at);
    expect(retried).toMatchObject({ state: "WAITING", syncFailures: { headSha: HEAD_A, count: SYNC_FAILURES_MAX - 1 } });
    expect(retried.blockReason).toBeUndefined();
    // One more try, and a failure of it stops again.
    const third = failed(again(retried, "conflict"), CHECKS);
    expect(third.kind).toBe("stopped");
  });

  it("only a real merge failure counts: GitHub errors, a lost machine and a stale fence retry with a growing delay and never stop", () => {
    let workflow = syncing();
    for (const [index, error] of ["RUNTIME_UNAVAILABLE: GitHub answered 503", undefined, "OPERATION_INTERRUPTED: spot reclaimed", "RUNTIME_UNAVAILABLE: rate limited"].entries()) {
      const outcome = failed(workflow, error);
      expect(outcome.kind, String(error)).toBe("unchanged");
      if (outcome.kind !== "unchanged") return;
      expect(outcome.workflow.syncFailures).toMatchObject({ headSha: HEAD_A, count: 0, transient: index + 1 });
      const wait = Date.parse(outcome.workflow.syncFailures!.retryAfter!) - Date.parse(at);
      expect(wait).toBe(Math.min(SYNC_BACKOFF_MINUTES.max, SYNC_BACKOFF_MINUTES.first * 2 ** index) * 60_000);
      workflow = again(outcome.workflow);
    }
    // A moved head is a person's push: nothing is counted.
    const moved = failed(syncing(), "STALE_FENCE: pull request head changed since AgentX last observed it");
    expect(moved.kind === "unchanged" && moved.workflow.syncFailures).toBeFalsy();
  });

  it("a merge is not started before its delay is over, nor on a head it gave up on, and a new head starts from none", async () => {
    installBranchSyncDeciders();
    const waitingUntil = (iso: string, count = 0) => waiting({ syncFailures: { headSha: HEAD_A, count, transient: 1, retryAfter: iso } });
    const soon = syncWorld({ workflow: waitingUntil(new Date(NOW + 10 * 60_000).toISOString()) });
    await trackPullRequest(soon.deps, TASK_ID);
    expect(dispatchRows(soon)).toEqual([]);
    const over = syncWorld({ workflow: waitingUntil(new Date(NOW - 60_000).toISOString()) });
    await trackPullRequest(over.deps, TASK_ID);
    expect(workflowOf(over)).toMatchObject({ state: "READY" });
    const gaveUp = syncWorld({ workflow: waiting({ syncFailures: { headSha: HEAD_A, count: SYNC_FAILURES_MAX } }) });
    await trackPullRequest(gaveUp.deps, TASK_ID);
    expect(dispatchRows(gaveUp)).toEqual([]);
    expect(trackingOf(gaveUp).syncs.count).toBe(0);
    const otherHead = syncWorld({ workflow: waiting({ syncFailures: { headSha: HEAD_B, count: SYNC_FAILURES_MAX } }) });
    await trackPullRequest(otherHead.deps, TASK_ID);
    expect(workflowOf(otherHead)).toMatchObject({ state: "READY" });
  });

  it("a head the merge gave up on does not stop a CI fix", async () => {
    installCiFixDecider();
    installBranchSyncDeciders();
    const w = syncWorld({ workflow: waiting({ syncFailures: { headSha: HEAD_A, count: SYNC_FAILURES_MAX } }),
      overrides: { checks: [{ name: "test", status: "completed", conclusion: "failure", required: false, url: "https://example.test/1" }] } });
    await trackPullRequest(w.deps, TASK_ID);
    expect(workflowOf(w)).toMatchObject({ stage: "IMPLEMENT", fixSource: "ci" });
  });

  it("names the failure in fixed words: the project's checks, or the merge not going through, never the worker's own text", () => {
    expect(classifySyncFailure(CHECKS)).toBe("checks");
    expect(classifySyncFailure("CONFIG_INVALID: Git could not read the repository's files")).toBe("other");
    expect(classifySyncFailure(`CONFIG_INVALID: ${"ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"} boom`)).toBe("other");
    expect(classifySyncFailure(undefined)).toBe("other");
  });

  it("a success clears the count", () => {
    expect(recordWorkflowBranchSync(syncing({ syncFailures: { headSha: HEAD_A, count: 1 } }), clean).syncFailures).toBeUndefined();
  });
});

describe("when GitHub cannot be read for a lost merge through the whole retry budget", () => {
  it("says so: the task stops with a plain text, and the text is a branch-sync stop", () => {
    expect(BRANCH_SYNC_UNSURE_MESSAGE).toBe("Rovara couldn't tell whether the merge of the base branch went through, because GitHub couldn't be read. Check the pull request on GitHub.");
    expect(isBranchSyncBlockReason(BRANCH_SYNC_UNSURE_MESSAGE)).toBe(true);
    const stopped = blockWorkflowBranchSync(syncing(), { reason: BRANCH_SYNC_UNSURE_MESSAGE, now: at });
    expect(stopped).toMatchObject({ state: "BLOCKED", blockReason: BRANCH_SYNC_UNSURE_MESSAGE });
    expect(stopped.branchSync).toBeUndefined();
  });
});
