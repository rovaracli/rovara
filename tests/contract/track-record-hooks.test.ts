// Track record (v1.2 slice 1), the hooks: what is recorded when a pull request is published, and how its samples are scored when a person asks for changes, the pull request merges
// or closes, and the task ends. Every hook is best effort: a failing write is counted and never reaches the caller.
import { describe, expect, it } from "vitest";
import type { WorkflowSnapshot } from "../../packages/contracts/src/index.js";
import type { PullRequestStatus } from "../../packages/broker/src/github-pull-status.js";
import type { OutcomeDependencies } from "../../packages/broker/src/rovara-code/outcomes.js";
import {
  outcomeRoundOf, recordPlanOutcome, recordPublicationOutcomes, scoreChangesRequested, scoreEndedPullRequest, settleTaskOutcomes, type OutcomeTask,
} from "../../packages/broker/src/rovara-code/outcome-hooks.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const CANDIDATE = "c".repeat(64);
const SECOND_CANDIDATE = "d".repeat(64);
const T0 = "2026-10-30T09:00:00.000Z";
const T1 = "2026-10-30T10:00:00.000Z";
const T2 = "2026-10-30T11:00:00.000Z";
const task: OutcomeTask = { taskId: TASK_ID, orgId: TEST_ORG, project: "payments", agent: { agentId: "rovara-code", version: 3, digest: "a".repeat(64) } };

function world(options: { failing?: boolean } = {}) {
  const db = new FakeDynamoDb();
  const logs: string[] = [];
  const metrics: string[] = [];
  const ddb = options.failing === true ? { send: async () => { throw Object.assign(new Error("secret table text"), { name: "ProvisionedThroughputExceededException" }); } } : db;
  const deps: OutcomeDependencies = { ddb, tableName: "State", log: (event) => logs.push(event), metric: (name) => metrics.push(name) };
  return { db, deps, logs, metrics };
}

const samples = (db: FakeDynamoDb) => db.find((item) => item.entityType === "OUTCOME_SAMPLE");
const copies = (db: FakeDynamoDb) => db.find((item) => item.entityType === "OUTCOME_SCORED");
const byClaim = (db: FakeDynamoDb, claim: string) => samples(db).filter((item) => item.claim === claim);
const stateOf = (db: FakeDynamoDb, claim: string, round = outcomeRoundOf(CANDIDATE)) => samples(db).find((item) => item.claim === claim && item.round === round)?.state;

const review = (role: "CRITIC" | "SECURITY", status = "PASS", candidateDigest = CANDIDATE) => ({ operationId: "o", candidateDigest, role, provider: "t", version: "1", status, findings: [], readOnly: true, recordedAt: T0 });
function published(extra: Record<string, unknown> = {}): WorkflowSnapshot {
  return {
    candidate: { digest: CANDIDATE }, reviews: [review("CRITIC"), review("SECURITY")], risk: { level: "low", reasons: [], candidateDigest: CANDIDATE }, ...extra,
  } as unknown as WorkflowSnapshot;
}
const PROVES = { verdicts: ["proves_change", "not_applicable"] as Array<"proves_change" | "not_applicable">, candidateDigest: CANDIDATE };

function status(overrides: Partial<PullRequestStatus> = {}): PullRequestStatus {
  return {
    number: 7, state: "merged", draft: false, headSha: "a".repeat(40), baseBranch: "main", mergeableState: "clean", mergeable: true, behindBy: 0,
    checks: [{ name: "test", status: "completed", conclusion: "success", required: false, url: "https://example.test/1" }],
    requiredChecks: [], baseHasRequiredChecks: false, headHasWorkflowFiles: true, requestedReviewers: 0, reviews: [], ...overrides,
  };
}
const person = (state: "APPROVED" | "CHANGES_REQUESTED", id = "1", userType = "User") => ({ githubUserId: id, login: `user${id}`, userType, state, commitId: "a".repeat(40), submittedAt: T1 });
const workflowOf = (prs: Array<{ number: number; state: string; repositoryId?: string; candidateDigest?: string }>) => ({
  pullRequests: prs.map((pr) => ({ repositoryId: pr.repositoryId ?? "web", number: pr.number, state: pr.state, candidateDigest: pr.candidateDigest ?? CANDIDATE })),
}) as unknown as WorkflowSnapshot;
const MERGE_COMMIT = "f".repeat(40);

async function seeded(options: Parameters<typeof world>[0] = {}) {
  const w = world(options);
  await recordPublicationOutcomes(w.deps, task, { workflow: published(), proof: PROVES, now: T0 });
  return w;
}

describe("publication", () => {
  it("records a pending sample for each passing review, the proof and the risk, keyed by the candidate", async () => {
    const { db } = await seeded();
    expect(samples(db).map((item) => `${String(item.claim)}:${String(item.state)}:${String(item.round)}`).sort()).toEqual([
      `proves_change:pending:${outcomeRoundOf(CANDIDATE)}`, `review_pass:CRITIC:pending:${outcomeRoundOf(CANDIDATE)}`,
      `review_pass:SECURITY:pending:${outcomeRoundOf(CANDIDATE)}`, `risk_low:pending:${outcomeRoundOf(CANDIDATE)}`,
    ]);
    expect(copies(db)).toEqual([]);
    expect(samples(db).every((item) => item.createdAt === T0 && item.taskId === TASK_ID && item.orgId === TEST_ORG)).toBe(true);
    expect(byClaim(db, "risk_low")[0]).toMatchObject({ stage: "risk", agent: { id: "rovara-code", version: "3", digest: "a".repeat(64) } });
  });

  it("makes no claim for a review with findings, a risk that is not low, a proof with nothing proved, or another candidate's reviews", async () => {
    const w = world();
    await recordPublicationOutcomes(w.deps, task, {
      workflow: published({ reviews: [review("CRITIC", "FINDINGS"), review("SECURITY", "PASS", SECOND_CANDIDATE)], risk: { level: "medium", reasons: [], candidateDigest: CANDIDATE } }),
      proof: { verdicts: ["does_not_prove"], candidateDigest: CANDIDATE }, now: T0,
    });
    expect(samples(w.db)).toEqual([]);
    expect(w.db.find((item) => String(item.sk).startsWith("OUTCOME_KEYS#"))).toEqual([]);
  });

  it("makes no risk claim for a low risk judged on other code", async () => {
    const w = world();
    await recordPublicationOutcomes(w.deps, task, { workflow: published({ reviews: [], risk: { level: "low", reasons: [], candidateDigest: SECOND_CANDIDATE } }), proof: { unavailable: "not_found" }, now: T0 });
    expect(byClaim(w.db, "risk_low")).toEqual([]);
  });

  it("a repeat or a retry later is the same samples: no second one, the first creation time stands", async () => {
    const w = await seeded();
    await recordPublicationOutcomes(w.deps, task, { workflow: published(), proof: PROVES, now: T2 });
    await recordPublicationOutcomes(w.deps, task, { workflow: published(), proof: PROVES, now: T2 });
    expect(samples(w.db)).toHaveLength(4);
    expect(samples(w.db).every((item) => item.createdAt === T0)).toBe(true);
  });

  it("a new candidate (a fix round) gives new samples beside the old ones", async () => {
    const w = await seeded();
    await recordPublicationOutcomes(w.deps, task, {
      workflow: published({ candidate: { digest: SECOND_CANDIDATE }, reviews: [review("CRITIC", "PASS", SECOND_CANDIDATE)], risk: { level: "low", reasons: [], candidateDigest: SECOND_CANDIDATE } }),
      proof: { unavailable: "not_found" }, now: T1,
    });
    expect(byClaim(w.db, "review_pass:CRITIC").map((item) => item.round).sort()).toEqual([outcomeRoundOf(CANDIDATE), outcomeRoundOf(SECOND_CANDIDATE)].sort());
  });

  it.each(["not_found", "read_failed"] as const)("a proof that could not be read (%s) is a no_outcome sample, not a silent zero", async (why) => {
    const w = world();
    await recordPublicationOutcomes(w.deps, task, { workflow: published({ reviews: [], risk: undefined }), proof: { unavailable: why }, now: T0 });
    await recordPublicationOutcomes(w.deps, task, { workflow: published({ reviews: [], risk: undefined }), proof: { unavailable: why }, now: T2 });
    expect(byClaim(w.db, "proves_change")).toHaveLength(1);
    expect(byClaim(w.db, "proves_change")[0]).toMatchObject({ state: "no_outcome", reason: "proof_unavailable" });
    expect(copies(w.db)).toHaveLength(1);
  });

  it("a write failure is logged and counted and never reaches the caller", async () => {
    const w = world({ failing: true });
    await expect(recordPublicationOutcomes(w.deps, task, { workflow: published(), proof: PROVES, now: T0 })).resolves.toBeUndefined();
    expect(w.metrics).toContain("OutcomeWriteFailed");
    expect(w.logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(w.logs)).not.toContain("secret");
  });
});

describe("the plan check's claim", () => {
  const critique = (verdict: "ok" | "revise" = "ok", status: "done" | "stopped_at_limit" = "done") => ({
    status, revisions: 0, critiques: [{ verdict, points: [], model: { provider: "anthropic", modelId: "claude-test", company: "anthropic" } }],
  }) as never;

  it.each([
    ["APPROVE", "held", "plan_approved"], ["SKIP", "held", "plan_skipped"], ["REQUEST_CHANGES", "not_held", "plan_changes_requested"], ["REJECT", "not_held", "plan_rejected"],
  ] as const)("a decision of %s is written already scored", async (decision, state, reason) => {
    const w = world();
    await recordPlanOutcome(w.deps, task, { critique: critique(), revision: 4, decision, at: T1 });
    expect(samples(w.db)).toHaveLength(1);
    expect(samples(w.db)[0]).toMatchObject({ claim: "plan_ready", stage: "plan_critic", round: "4", state, reason, createdAt: T1, scoredAt: T1, model: "anthropic/claude-test" });
    expect(copies(w.db)).toHaveLength(1);
  });

  it("several plan rounds each give one sample, and a repeat of one gives none", async () => {
    const w = world();
    await recordPlanOutcome(w.deps, task, { critique: critique(), revision: 4, decision: "REQUEST_CHANGES", at: T0 });
    await recordPlanOutcome(w.deps, task, { critique: critique(), revision: 7, decision: "APPROVE", at: T1 });
    await recordPlanOutcome(w.deps, task, { critique: critique(), revision: 7, decision: "APPROVE", at: T1 });
    expect(samples(w.db).map((item) => `${String(item.round)}:${String(item.state)}`).sort()).toEqual(["4:not_held", "7:held"]);
  });

  it.each([["a check that asked for a revision", critique("revise")], ["a check that stopped at its limit", critique("ok", "stopped_at_limit")], ["no check", undefined]])("%s is no claim", async (_name, value) => {
    const w = world();
    await recordPlanOutcome(w.deps, task, { critique: value, revision: 4, decision: "APPROVE", at: T1 });
    expect(samples(w.db)).toEqual([]);
  });
});

describe("a person asks for changes", () => {
  it("moves the review and risk samples of that candidate to not_held, and leaves the proof alone", async () => {
    const w = await seeded();
    await scoreChangesRequested(w.deps, task, { candidateDigest: CANDIDATE, reason: "changes_requested_by_person", now: T1 });
    expect(stateOf(w.db, "review_pass:CRITIC")).toBe("not_held");
    expect(stateOf(w.db, "review_pass:SECURITY")).toBe("not_held");
    expect(stateOf(w.db, "risk_low")).toBe("not_held");
    expect(stateOf(w.db, "proves_change")).toBe("pending");
    expect(byClaim(w.db, "risk_low")[0]).toMatchObject({ reason: "changes_requested_by_person", scoredAt: T1 });
  });

  it("first sight wins: a later merge with an approval does not undo it", async () => {
    const w = await seeded();
    await scoreChangesRequested(w.deps, task, { candidateDigest: CANDIDATE, reason: "changes_requested_by_person", now: T1 });
    await scoreEndedPullRequest(w.deps, { ...task, workflow: workflowOf([{ number: 7, state: "MERGED" }]) }, { repositoryId: "web", number: 7, status: status({ reviews: [person("APPROVED")] }), mergeCommit: MERGE_COMMIT, now: T2 });
    expect(stateOf(w.db, "review_pass:CRITIC")).toBe("not_held");
    expect(stateOf(w.db, "risk_low")).toBe("not_held");
    expect(copies(w.db).filter((item) => item.claim === "review_pass:CRITIC")).toHaveLength(1);
    expect(stateOf(w.db, "proves_change")).toBe("held");
  });

  it("a stale whole-workflow write cannot lose the way to the samples: their pointer is not part of the workflow", async () => {
    const w = await seeded();
    // Another writer replaces the task's workflow as a whole, from a snapshot read before the samples were made.
    w.db.set({ pk: `DEVTASK#${TASK_ID}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK_ID, workflow: { revision: 1, stale: true } });
    await scoreChangesRequested(w.deps, task, { candidateDigest: CANDIDATE, reason: "changes_requested_by_person", now: T1 });
    expect(stateOf(w.db, "review_pass:CRITIC")).toBe("not_held");
  });

  it("another candidate's samples are not touched", async () => {
    const w = await seeded();
    await scoreChangesRequested(w.deps, task, { candidateDigest: SECOND_CANDIDATE, reason: "feedback_round_by_person", now: T1 });
    expect(stateOf(w.db, "review_pass:CRITIC")).toBe("pending");
  });
});

describe("a pull request ends", () => {
  const merge = (w: ReturnType<typeof world>, overrides: Partial<PullRequestStatus> = {}, prs = [{ number: 7, state: "MERGED" }], extra: { mergedAt?: string } = {}) =>
    scoreEndedPullRequest(w.deps, { ...task, workflow: workflowOf(prs) }, { repositoryId: "web", number: 7, status: status(overrides), mergeCommit: MERGE_COMMIT, ...extra, now: T2 });

  it("a reviewed merge holds the reviews and the risk, scores the proof by CI, and keeps the merge commit and time", async () => {
    const w = await seeded();
    await merge(w, { reviews: [person("APPROVED")] }, undefined, { mergedAt: "2026-10-30T10:30:00Z" });
    expect(stateOf(w.db, "review_pass:CRITIC")).toBe("held");
    expect(byClaim(w.db, "review_pass:CRITIC")[0]).toMatchObject({ reason: "merged_no_changes_requested", pr: { repositoryId: "web", number: 7, mergeCommit: MERGE_COMMIT, mergedAt: "2026-10-30T10:30:00.000Z" } });
    expect(byClaim(w.db, "review_pass:CRITIC")[0]).not.toHaveProperty("unreviewedMerge");
    expect(byClaim(w.db, "risk_low")[0]).toMatchObject({ state: "held", reason: "merged_no_changes_requested" });
    expect(byClaim(w.db, "proves_change")[0]).toMatchObject({ state: "held", reason: "ci_passing" });
  });

  it("a merge nobody reviewed holds the reviews but marks them, and a bot's review is not a person's", async () => {
    const w = await seeded();
    await merge(w, { reviews: [person("APPROVED", "9", "Bot")] });
    expect(byClaim(w.db, "review_pass:CRITIC")[0]).toMatchObject({ state: "held", reason: "merged_without_person_review", unreviewedMerge: true });
    expect(byClaim(w.db, "review_pass:SECURITY")[0]).toMatchObject({ unreviewedMerge: true });
    expect(byClaim(w.db, "risk_low")[0]).toMatchObject({ state: "held" });
    expect(byClaim(w.db, "risk_low")[0]).not.toHaveProperty("unreviewedMerge");
  });

  it("changes requested by a person at the merge are not_held even when nothing saw them before", async () => {
    const w = await seeded();
    await merge(w, { reviews: [person("CHANGES_REQUESTED")] });
    expect(stateOf(w.db, "review_pass:CRITIC")).toBe("not_held");
    expect(byClaim(w.db, "review_pass:CRITIC")[0]).toMatchObject({ reason: "changes_requested_by_person" });
  });

  it("fresh CI decides the proof: failing, pending, none and an unreadable check list each have their own result", async () => {
    const failing = [{ name: "test", status: "completed", conclusion: "failure", required: false, url: "https://example.test/1" }];
    const pending = [{ name: "test", status: "in_progress", conclusion: null, required: false, url: "https://example.test/1" }];
    const cases: Array<[Partial<PullRequestStatus>, string, string]> = [
      [{ checks: failing } as never, "not_held", "ci_failing"], [{ checks: pending } as never, "no_outcome", "ci_pending"],
      [{ checks: [] }, "no_outcome", "ci_none"], [{ checksUnavailable: true }, "no_outcome", "ci_none"],
    ];
    for (const [overrides, state, reason] of cases) {
      const w = await seeded();
      await merge(w, overrides);
      expect(byClaim(w.db, "proves_change")[0]).toMatchObject({ state, reason });
    }
  });

  it("a pull request closed without merging puts every open sample in its own bucket", async () => {
    const w = await seeded();
    await scoreEndedPullRequest(w.deps, { ...task, workflow: workflowOf([{ number: 7, state: "CLOSED" }]) }, { repositoryId: "web", number: 7, status: status({ state: "closed" }), now: T2 });
    expect(samples(w.db).map((item) => item.state)).toEqual(["closed_unmerged", "closed_unmerged", "closed_unmerged", "closed_unmerged"]);
    expect(samples(w.db).every((item) => item.reason === "closed_unmerged")).toBe(true);
  });

  it("a pull request still open scores nothing", async () => {
    const w = await seeded();
    await scoreEndedPullRequest(w.deps, { ...task, workflow: workflowOf([{ number: 7, state: "OPEN" }]) }, { repositoryId: "web", number: 7, status: status({ state: "open" }), now: T2 });
    expect(samples(w.db).every((item) => item.state === "pending")).toBe(true);
  });

  it("a candidate with two pull requests is scored once both are over", async () => {
    const w = await seeded();
    const both = (second: string) => [{ number: 7, state: "MERGED" }, { number: 8, state: second, repositoryId: "api" }];
    await merge(w, { reviews: [person("APPROVED")] }, both("OPEN"));
    expect(samples(w.db).every((item) => item.state === "pending")).toBe(true);
    await merge(w, { reviews: [person("APPROVED")] }, both("CLOSED"));
    expect(stateOf(w.db, "review_pass:CRITIC")).toBe("held");
  });

  it("scoring again, by a retry or a second event, changes nothing and writes no second copy", async () => {
    const w = await seeded();
    await merge(w, { reviews: [person("APPROVED")] });
    const before = JSON.stringify(samples(w.db).map((item) => [item.claim, item.state, item.scoredAt]).sort());
    await merge(w, { reviews: [person("APPROVED")], checks: [] });
    await scoreEndedPullRequest(w.deps, { ...task, workflow: workflowOf([{ number: 7, state: "CLOSED" }]) }, { repositoryId: "web", number: 7, status: status({ state: "closed" }), now: "2026-10-31T00:00:00.000Z" });
    expect(JSON.stringify(samples(w.db).map((item) => [item.claim, item.state, item.scoredAt]).sort())).toBe(before);
    expect(copies(w.db)).toHaveLength(4);
  });

  it("a scoring failure never reaches the caller", async () => {
    const w = await seeded();
    const failing = world({ failing: true });
    await expect(scoreEndedPullRequest(failing.deps, { ...task, workflow: workflowOf([{ number: 7, state: "MERGED" }]) }, { repositoryId: "web", number: 7, status: status(), now: T2 })).resolves.toBeUndefined();
    expect(failing.metrics).toContain("OutcomeWriteFailed");
    expect(samples(w.db).every((item) => item.state === "pending")).toBe(true);
  });
});

describe("the task ends", () => {
  it("open samples become no_outcome, a merged pull request's candidate is left to its merge, and a closed one is closed unmerged", async () => {
    const w = await seeded();
    await recordPublicationOutcomes(w.deps, task, {
      workflow: published({ candidate: { digest: SECOND_CANDIDATE }, reviews: [review("CRITIC", "PASS", SECOND_CANDIDATE)], risk: undefined }), proof: { verdicts: [], candidateDigest: SECOND_CANDIDATE }, now: T1,
    });
    await settleTaskOutcomes(w.deps, { ...task, workflow: workflowOf([{ number: 7, state: "MERGED" }]) }, T2);
    expect(stateOf(w.db, "review_pass:CRITIC")).toBe("pending");
    expect(stateOf(w.db, "review_pass:CRITIC", outcomeRoundOf(SECOND_CANDIDATE))).toBe("no_outcome");
    expect(byClaim(w.db, "review_pass:CRITIC").find((item) => item.round === outcomeRoundOf(SECOND_CANDIDATE))).toMatchObject({ reason: "task_closed" });

    const closed = await seeded();
    await settleTaskOutcomes(closed.deps, { ...task, workflow: workflowOf([{ number: 7, state: "CLOSED" }]) }, T2);
    expect(stateOf(closed.db, "risk_low")).toBe("closed_unmerged");
    const none = await seeded();
    await settleTaskOutcomes(none.deps, { ...task, workflow: workflowOf([{ number: 7, state: "OPEN" }]) }, T2);
    expect(stateOf(none.db, "risk_low")).toBe("no_outcome");
  });

  it("a settle never fails the close", async () => {
    const w = world({ failing: true });
    await expect(settleTaskOutcomes(w.deps, task, T2)).resolves.toBeUndefined();
    expect(w.metrics).toContain("OutcomeWriteFailed");
  });
});
