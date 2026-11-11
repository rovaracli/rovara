// Track record (v1.2 slice 1), the hooks: what is recorded when a pull request is published, and how its samples are scored when a person asks for changes, the pull request merges
// or closes, and the task ends. Every hook is best effort: a failing write is counted and never reaches the caller.
import { describe, expect, it } from "vitest";
import type { WorkflowSnapshot } from "@agentx/cloud-contracts";
import type { ChangeRequestStatus } from "@rovara-code/contracts";
import type { OutcomeDependencies } from "../../packages/broker/src/rovara-code/outcomes.js";
import {
  observeCandidateCode, outcomeRoundOf, recordPlanOutcome, recordPublicationOutcomes, scoreChangesRequested, scoreMergedCandidate, settleSuperseded, settleTaskOutcomes,
  type EndedPullRequestReader, type OutcomeTask,
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

function status(overrides: Partial<ChangeRequestStatus> = {}): ChangeRequestStatus {
  return {
    id: "7", state: "merged", draft: false, headRevision: "a".repeat(40), targetBranch: "main", mergeableState: "clean", mergeable: true, behindBy: 0,
    checks: [{ name: "test", state: "completed", conclusion: "success", required: false, url: "https://example.test/1" }],
    requiredChecks: [], targetHasRequiredChecks: false, headDefinesChecks: true, requestedReviewers: 0, reviews: [], ...overrides,
  };
}
const person = (state: "APPROVED" | "CHANGES_REQUESTED", id = "1", accountType: "person" | "bot" | "other" = "person") => ({ reviewer: { login: `user${id}`, hostUserId: id }, accountType, state, revision: "a".repeat(40), submittedAt: T1 });
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

  it("a proof that could not be READ is a no_outcome sample, not a silent zero, and a repeat makes no second one", async () => {
    const w = world();
    await recordPublicationOutcomes(w.deps, task, { workflow: published({ reviews: [], risk: undefined }), proof: { unavailable: "read_failed" }, now: T0 });
    await recordPublicationOutcomes(w.deps, task, { workflow: published({ reviews: [], risk: undefined }), proof: { unavailable: "read_failed" }, now: T2 });
    expect(byClaim(w.db, "proves_change")).toHaveLength(1);
    expect(byClaim(w.db, "proves_change")[0]).toMatchObject({ state: "no_outcome", reason: "proof_unavailable" });
    expect(copies(w.db)).toHaveLength(1);
  });

  it("a proof that was never found is not a claim: no sample for it", async () => {
    const w = world();
    await recordPublicationOutcomes(w.deps, task, { workflow: published({ reviews: [], risk: undefined }), proof: { unavailable: "not_found" }, now: T0 });
    expect(samples(w.db)).toEqual([]);
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
  const asked = (w: ReturnType<typeof world>, rounds = [outcomeRoundOf(CANDIDATE)], reason: "changes_requested_by_person" | "feedback_round_approved" = "changes_requested_by_person", now = T1) =>
    scoreChangesRequested(w.deps, task, { rounds, reason, now });

  it("moves the review and risk samples of that candidate to not_held, and leaves the proof alone", async () => {
    const w = await seeded();
    await asked(w);
    expect(stateOf(w.db, "review_pass:CRITIC")).toBe("not_held");
    expect(stateOf(w.db, "review_pass:SECURITY")).toBe("not_held");
    expect(stateOf(w.db, "risk_low")).toBe("not_held");
    expect(stateOf(w.db, "proves_change")).toBe("pending");
    expect(byClaim(w.db, "risk_low")[0]).toMatchObject({ reason: "changes_requested_by_person", scoredAt: T1 });
  });

  it("first sight wins: a later merge with an approval does not undo it", async () => {
    const w = await seeded();
    await asked(w);
    await merge(w, { reviews: [person("APPROVED")] });
    expect(stateOf(w.db, "review_pass:CRITIC")).toBe("not_held");
    expect(stateOf(w.db, "risk_low")).toBe("not_held");
    expect(copies(w.db).filter((item) => item.claim === "review_pass:CRITIC")).toHaveLength(1);
    expect(stateOf(w.db, "proves_change")).toBe("held");
  });

  it("a stale whole-workflow write cannot lose the way to the samples: their pointer is not part of the workflow", async () => {
    const w = await seeded();
    w.db.set({ pk: `DEVTASK#${TASK_ID}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK_ID, workflow: { revision: 1, stale: true } });
    await asked(w);
    expect(stateOf(w.db, "review_pass:CRITIC")).toBe("not_held");
  });

  it("another candidate's samples are not touched", async () => {
    const w = await seeded();
    await asked(w, [outcomeRoundOf(SECOND_CANDIDATE)], "feedback_round_approved");
    expect(stateOf(w.db, "review_pass:CRITIC")).toBe("pending");
  });
});

/** GitHub's answer for each merged pull request of the candidate, by number (the same one for any not listed). */
function readerOf(statuses: Record<number, ChangeRequestStatus> = {}, fallback: ChangeRequestStatus = status(), writers: readonly string[] = ["user1", "user2", "user3"]) {
  const calls: number[] = [];
  const read: EndedPullRequestReader = async (_repositoryId, number) => {
    calls.push(number);
    return { status: statuses[number] ?? fallback, mergeCommit: MERGE_COMMIT, mergedAt: "2026-10-30T10:30:00Z", permission: async (login) => (writers.includes(login) ? "write" : "none") };
  };
  return { read, calls };
}
async function merge(w: ReturnType<typeof world>, overrides: Partial<ChangeRequestStatus> = {}, prs = [{ number: 7, state: "MERGED" }], options: { reader?: ReturnType<typeof readerOf> } = {}) {
  const reader = options.reader ?? readerOf({}, status(overrides));
  const result = await scoreMergedCandidate(w.deps, { ...task, workflow: workflowOf(prs) }, { candidateDigest: CANDIDATE, read: reader.read, now: T2 });
  return { result, reader };
}

describe("a pull request merges", () => {
  it("a host that gives no merge observation leaves the merge time and commit unset: the settle time is never taken for it", async () => {
    const w = await seeded();
    const bare: EndedPullRequestReader = async () => ({ status: status({ reviews: [person("APPROVED")] }), permission: async (login) => (login.startsWith("user") ? "write" : "none") });
    const result = await scoreMergedCandidate(w.deps, { ...task, workflow: workflowOf([{ number: 7, state: "MERGED" }]) }, { candidateDigest: CANDIDATE, read: bare, now: T2 });
    expect(result).toBe("scored");
    const scored = byClaim(w.db, "review_pass:CRITIC")[0]!;
    expect(scored).toMatchObject({ state: "held", reason: "merged_no_changes_requested", pr: { repositoryId: "web", number: 7 } });
    expect(scored["pr"]).not.toHaveProperty("mergedAt");
    expect(scored["pr"]).not.toHaveProperty("mergeCommit");
  });

  it("a reviewed merge holds the reviews and the risk, scores the proof by fresh CI, and keeps the merge commit and time", async () => {
    const w = await seeded();
    expect((await merge(w, { reviews: [person("APPROVED")] })).result).toBe("scored");
    expect(stateOf(w.db, "review_pass:CRITIC")).toBe("held");
    expect(byClaim(w.db, "review_pass:CRITIC")[0]).toMatchObject({ reason: "merged_no_changes_requested", pr: { repositoryId: "web", number: 7, mergeCommit: MERGE_COMMIT, mergedAt: "2026-10-30T10:30:00.000Z" } });
    expect(byClaim(w.db, "review_pass:CRITIC")[0]).not.toHaveProperty("unreviewedMerge");
    expect(byClaim(w.db, "risk_low")[0]).toMatchObject({ state: "held", reason: "merged_no_changes_requested" });
    expect(byClaim(w.db, "proves_change")[0]).toMatchObject({ state: "held", reason: "ci_passing" });
  });

  it("a merge nobody reviewed holds the reviews but marks them; a bot's review, and an outsider's approval, are not a person's", async () => {
    for (const reviews of [[person("APPROVED", "9", "bot")], [person("APPROVED", "8")], []]) {
      const w = await seeded();
      await merge(w, { reviews });
      expect(byClaim(w.db, "review_pass:CRITIC")[0]).toMatchObject({ state: "held", reason: "merged_without_person_review", unreviewedMerge: true });
      expect(byClaim(w.db, "review_pass:SECURITY")[0]).toMatchObject({ unreviewedMerge: true });
      expect(byClaim(w.db, "risk_low")[0]).toMatchObject({ state: "held" });
      expect(byClaim(w.db, "risk_low")[0]).not.toHaveProperty("unreviewedMerge");
    }
  });

  it("changes requested by a person with write access at the merge are not_held; an outsider's request changes nothing", async () => {
    const written = await seeded();
    await merge(written, { reviews: [person("CHANGES_REQUESTED")] });
    expect(stateOf(written.db, "review_pass:CRITIC")).toBe("not_held");
    expect(byClaim(written.db, "review_pass:CRITIC")[0]).toMatchObject({ reason: "changes_requested_by_person" });
    const outsider = await seeded();
    await merge(outsider, { reviews: [person("CHANGES_REQUESTED", "8"), person("APPROVED", "1")] });
    expect(byClaim(outsider.db, "review_pass:CRITIC")[0]).toMatchObject({ state: "held", reason: "merged_no_changes_requested" });
  });

  it("only reviews on the candidate's own head count for it: an old review on an earlier head affects nothing", async () => {
    const w = await seeded();
    await merge(w, { reviews: [{ ...person("CHANGES_REQUESTED"), revision: "9".repeat(40) }, { ...person("APPROVED", "2"), revision: "8".repeat(40) }] });
    expect(byClaim(w.db, "review_pass:CRITIC")[0]).toMatchObject({ state: "held", reason: "merged_without_person_review", unreviewedMerge: true });
  });

  it("fresh CI decides the proof: failing, pending, none and an unreadable check list each have their own result", async () => {
    const failing = [{ name: "test", state: "completed", conclusion: "failure", required: false, url: "https://example.test/1" }];
    const pending = [{ name: "test", state: "pending", required: false, url: "https://example.test/1" }];
    const cases: Array<[Partial<ChangeRequestStatus>, string, string]> = [
      [{ checks: failing } as never, "not_held", "ci_failing"], [{ checks: pending } as never, "no_outcome", "ci_pending"],
      [{ checks: [] }, "no_outcome", "ci_none"], [{ checksUnavailable: true }, "no_outcome", "ci_none"],
    ];
    for (const [overrides, state, reason] of cases) {
      const w = await seeded();
      await merge(w, overrides);
      expect(byClaim(w.db, "proves_change")[0]).toMatchObject({ state, reason });
    }
  });

  it("a candidate with two pull requests waits until both are over, and is aggregated: any failing CI or request for changes is not held", async () => {
    const failing = [{ name: "test", state: "completed", conclusion: "failure", required: false, url: "https://example.test/1" }];
    const both = (second: string) => [{ number: 7, state: "MERGED" }, { number: 8, state: second, repositoryId: "api" }];
    const waiting = await seeded();
    expect((await merge(waiting, {}, both("OPEN"))).result).toBe("nothing");
    expect(samples(waiting.db).every((item) => item.state === "pending")).toBe(true);

    const clean = await seeded();
    await merge(clean, {}, both("MERGED"), { reader: readerOf({}, status({ reviews: [person("APPROVED")] })) });
    expect(stateOf(clean.db, "proves_change")).toBe("held");
    expect(stateOf(clean.db, "review_pass:CRITIC")).toBe("held");

    const oneFailing = await seeded();
    await merge(oneFailing, {}, both("MERGED"), { reader: readerOf({ 8: status({ id: "8", checks: failing } as never) }, status({ reviews: [person("APPROVED")] })) });
    expect(byClaim(oneFailing.db, "proves_change")[0]).toMatchObject({ state: "not_held", reason: "ci_failing", pr: { repositoryId: "api", number: 8, mergeCommit: MERGE_COMMIT } });
    expect(stateOf(oneFailing.db, "review_pass:CRITIC")).toBe("held");

    const oneAsked = await seeded();
    await merge(oneAsked, {}, both("MERGED"), { reader: readerOf({ 8: status({ id: "8", reviews: [person("CHANGES_REQUESTED", "2")] }) }, status({ reviews: [person("APPROVED")] })) });
    expect(stateOf(oneAsked.db, "review_pass:CRITIC")).toBe("not_held");
    expect(stateOf(oneAsked.db, "risk_low")).toBe("not_held");

    const closedOne = await seeded();
    await merge(closedOne, { reviews: [person("APPROVED")] }, both("CLOSED"));
    expect(stateOf(closedOne.db, "review_pass:CRITIC")).toBe("held");
  });

  it("a pull request that only closed is not scored here: it may be reopened", async () => {
    const w = await seeded();
    expect((await merge(w, { state: "closed" }, [{ number: 7, state: "CLOSED" }])).result).toBe("nothing");
    expect(samples(w.db).every((item) => item.state === "pending")).toBe(true);
  });

  it("a closed pull request that is reopened and merged scores as merged", async () => {
    const w = await seeded();
    await merge(w, { state: "closed" }, [{ number: 7, state: "CLOSED" }]);
    await merge(w, { reviews: [person("APPROVED")] });
    expect(stateOf(w.db, "review_pass:CRITIC")).toBe("held");
  });

  it("nothing is read from GitHub once no sample of the candidate is open, and a repeat changes nothing", async () => {
    const w = await seeded();
    const first = await merge(w, { reviews: [person("APPROVED")] });
    expect(first.reader.calls).toEqual([7]);
    const before = JSON.stringify(samples(w.db).map((item) => [item.claim, item.state, item.scoredAt]).sort());
    const again = await merge(w, { reviews: [person("CHANGES_REQUESTED")], checks: [] });
    expect(again.result).toBe("nothing");
    expect(again.reader.calls).toEqual([]);
    expect(JSON.stringify(samples(w.db).map((item) => [item.claim, item.state, item.scoredAt]).sort())).toBe(before);
    expect(copies(w.db)).toHaveLength(4);
  });

  it("a read or write failure never reaches the caller, and says it failed", async () => {
    const w = await seeded();
    const failing = world({ failing: true });
    const noRead = async () => { throw new Error("secret github text"); };
    expect(await scoreMergedCandidate(failing.deps, { ...task, workflow: workflowOf([{ number: 7, state: "MERGED" }]) }, { candidateDigest: CANDIDATE, read: noRead, now: T2 })).toBe("failed");
    expect(failing.metrics).toContain("OutcomeWriteFailed");
    expect(await scoreMergedCandidate(w.deps, { ...task, workflow: workflowOf([{ number: 7, state: "MERGED" }]) }, { candidateDigest: CANDIDATE, read: noRead, now: T2 })).toBe("failed");
    expect(w.logs.join()).not.toContain("secret");
    expect(samples(w.db).every((item) => item.state === "pending")).toBe(true);
  });
});

describe("a fix replaces a candidate", () => {
  const second = () => published({ candidate: { digest: SECOND_CANDIDATE }, reviews: [review("CRITIC", "PASS", SECOND_CANDIDATE)], risk: { level: "low", reasons: [], candidateDigest: SECOND_CANDIDATE } });
  const observe = (w: ReturnType<typeof world>, ci: "failing" | "passing" | "pending" = "failing", digest = CANDIDATE) =>
    observeCandidateCode(w.deps, task, { candidateDigest: digest, head: "a".repeat(40), ci, ciIsOnHead: true, now: T1 });

  it("A fails CI, Rovara fixes it, B passes: A's proof is not held and B's is", async () => {
    const w = await seeded();
    await observe(w);
    expect(byClaim(w.db, "proves_change")[0]).toMatchObject({ state: "not_held", reason: "ci_failing", scoredAt: T1 });
    await settleSuperseded(w.deps, { ...task, workflow: workflowOf([{ number: 7, state: "OPEN", candidateDigest: SECOND_CANDIDATE }]) }, { candidateDigest: CANDIDATE, now: T1 });
    await recordPublicationOutcomes(w.deps, task, { workflow: second(), proof: PROVES_B(), now: T1 });
    await merge2(w, [{ number: 7, state: "MERGED", candidateDigest: SECOND_CANDIDATE }], SECOND_CANDIDATE, status({ reviews: [{ ...person("APPROVED"), revision: "a".repeat(40) }] }));
    expect(stateOf(w.db, "proves_change")).toBe("not_held");
    expect(stateOf(w.db, "proves_change", outcomeRoundOf(SECOND_CANDIDATE))).toBe("held");
    expect(stateOf(w.db, "review_pass:CRITIC")).toBe("no_outcome");
    expect(byClaim(w.db, "review_pass:CRITIC").find((item) => item.round === outcomeRoundOf(CANDIDATE))).toMatchObject({ reason: "superseded" });
    expect(stateOf(w.db, "review_pass:CRITIC", outcomeRoundOf(SECOND_CANDIDATE))).toBe("held");
  });

  it("checks seen passing on A's head hold its proof when it is replaced; never seen is no outcome", async () => {
    const passing = await seeded();
    await observe(passing, "passing");
    await settleSuperseded(passing.deps, { ...task, workflow: workflowOf([{ number: 7, state: "OPEN", candidateDigest: SECOND_CANDIDATE }]) }, { candidateDigest: CANDIDATE, now: T2 });
    expect(byClaim(passing.db, "proves_change")[0]).toMatchObject({ state: "held", reason: "ci_passing" });
    const unseen = await seeded();
    await settleSuperseded(unseen.deps, { ...task, workflow: workflowOf([{ number: 7, state: "OPEN", candidateDigest: SECOND_CANDIDATE }]) }, { candidateDigest: CANDIDATE, now: T2 });
    expect(byClaim(unseen.db, "proves_change")[0]).toMatchObject({ state: "no_outcome", reason: "superseded" });
    expect(stateOf(unseen.db, "risk_low")).toBe("no_outcome");
  });

  it("a round of fixes made from a person's comments on A makes A's reviews and risk not held, even when Rovara's autonomy decided it", async () => {
    const w = await seeded();
    const workflow = { ...workflowOf([{ number: 7, state: "OPEN", candidateDigest: SECOND_CANDIDATE }]), feedbackDecisions: [{ decision: "APPROVE", actorRole: "ROVARA_AUTONOMY", candidates: [{ repositoryId: "web", number: 7, candidateDigest: CANDIDATE }] }] } as unknown as WorkflowSnapshot;
    await settleSuperseded(w.deps, { ...task, workflow }, { candidateDigest: CANDIDATE, now: T2 });
    expect(byClaim(w.db, "review_pass:CRITIC")[0]).toMatchObject({ state: "not_held", reason: "feedback_round_approved" });
    expect(byClaim(w.db, "risk_low")[0]).toMatchObject({ state: "not_held" });
  });

  it("two observations at once lose neither head, and a head never undoes a passing check seen on another", async () => {
    const w = await seeded();
    const at = (head: string, ci: "passing" | "pending") => observeCandidateCode(w.deps, task, { candidateDigest: CANDIDATE, head, ci, ciIsOnHead: true, now: T1 });
    await Promise.all([at("1".repeat(40), "passing"), at("2".repeat(40), "pending"), at("3".repeat(40), "pending")]);
    const pointer = w.db.find((item) => item.entityType === "OUTCOME_KEYS")[0]!;
    expect([...(pointer.heads as string[])].sort()).toEqual(["1".repeat(40), "2".repeat(40), "3".repeat(40)]);
    expect(pointer.passingHeads).toEqual(["1".repeat(40)]);
  });

  it("passing checks count for the candidate only on its final head", async () => {
    const stale = await seeded();
    await observeCandidateCode(stale.deps, task, { candidateDigest: CANDIDATE, head: "1".repeat(40), ci: "passing", ciIsOnHead: true, now: T1 });
    await observeCandidateCode(stale.deps, task, { candidateDigest: CANDIDATE, head: "2".repeat(40), ci: "pending", ciIsOnHead: true, now: T1 });
    await settleSuperseded(stale.deps, { ...task, workflow: workflowOf([{ number: 7, state: "OPEN", candidateDigest: SECOND_CANDIDATE }]) }, { candidateDigest: CANDIDATE, now: T2 });
    expect(byClaim(stale.db, "proves_change")[0]).toMatchObject({ state: "no_outcome", reason: "superseded" });
    const final = await seeded();
    await observeCandidateCode(final.deps, task, { candidateDigest: CANDIDATE, head: "1".repeat(40), ci: "pending", ciIsOnHead: true, now: T1 });
    await observeCandidateCode(final.deps, task, { candidateDigest: CANDIDATE, head: "2".repeat(40), ci: "passing", ciIsOnHead: true, now: T1 });
    await settleSuperseded(final.deps, { ...task, workflow: workflowOf([{ number: 7, state: "OPEN", candidateDigest: SECOND_CANDIDATE }]) }, { candidateDigest: CANDIDATE, now: T2 });
    expect(byClaim(final.db, "proves_change")[0]).toMatchObject({ state: "held", reason: "ci_passing" });
  });

  function PROVES_B() { return { verdicts: ["proves_change" as const], candidateDigest: SECOND_CANDIDATE }; }
  async function merge2(w: ReturnType<typeof world>, prs: Array<{ number: number; state: string; candidateDigest?: string }>, digest: string, fresh: ChangeRequestStatus) {
    return scoreMergedCandidate(w.deps, { ...task, workflow: workflowOf(prs) }, { candidateDigest: digest, read: readerOf({}, fresh).read, now: T2 });
  }
});

describe("the task ends", () => {
  const withReader = (reader: EndedPullRequestReader | undefined, prs: Array<{ number: number; state: string; repositoryId?: string; candidateDigest?: string }>) => ({ ...task, workflow: workflowOf(prs), reader });

  it("open samples become no_outcome, and nothing stays pending: a candidate no pull request holds any more was superseded", async () => {
    const w = await seeded();
    await recordPublicationOutcomes(w.deps, task, {
      workflow: published({ candidate: { digest: SECOND_CANDIDATE }, reviews: [review("CRITIC", "PASS", SECOND_CANDIDATE)], risk: undefined }), proof: { verdicts: [], candidateDigest: SECOND_CANDIDATE }, now: T1,
    });
    const open = [{ number: 7, state: "OPEN", candidateDigest: SECOND_CANDIDATE }];
    await settleTaskOutcomes(w.deps, withReader(undefined, open), T2);
    expect(samples(w.db).filter((item) => item.state === "pending")).toEqual([]);
    expect(byClaim(w.db, "review_pass:CRITIC").find((item) => item.round === outcomeRoundOf(CANDIDATE))).toMatchObject({ state: "no_outcome", reason: "superseded" });
    expect(byClaim(w.db, "review_pass:CRITIC").find((item) => item.round === outcomeRoundOf(SECOND_CANDIDATE))).toMatchObject({ state: "no_outcome", reason: "task_closed" });
  });

  it("a candidate with a merged pull request that is still pending is scored from a fresh read; if it cannot be read it is code_host_unavailable", async () => {
    const read = await seeded();
    const reader = readerOf({}, status({ reviews: [person("APPROVED")] })).read;
    await settleTaskOutcomes(read.deps, withReader(reader, [{ number: 7, state: "MERGED" }]), T2, reader);
    expect(stateOf(read.db, "review_pass:CRITIC")).toBe("held");
    expect(stateOf(read.db, "proves_change")).toBe("held");

    const broken = await seeded();
    const failing: EndedPullRequestReader = async () => { throw new Error("secret github text"); };
    await settleTaskOutcomes(broken.deps, withReader(failing, [{ number: 7, state: "MERGED" }]), T2, failing);
    expect(samples(broken.db).filter((item) => item.state === "pending")).toEqual([]);
    expect(samples(broken.db).every((item) => item.reason === "code_host_unavailable" && item.state === "no_outcome")).toBe(true);

    const noReader = await seeded();
    await settleTaskOutcomes(noReader.deps, withReader(undefined, [{ number: 7, state: "MERGED" }]), T2);
    expect(samples(noReader.db).every((item) => item.reason === "code_host_unavailable")).toBe(true);
  });

  it("a closed pull request is scored closed_unmerged only if it is still closed now; reopened and merged scores as merged, reopened and open has no outcome", async () => {
    const closed = [{ number: 7, state: "CLOSED" }];
    const still = await seeded();
    const stillClosed = readerOf({}, status({ state: "closed" })).read;
    await settleTaskOutcomes(still.deps, withReader(stillClosed, closed), T2, stillClosed);
    expect(samples(still.db).every((item) => item.state === "closed_unmerged" && item.reason === "closed_unmerged")).toBe(true);

    const merged = await seeded();
    const reopenedAndMerged = readerOf({}, status({ reviews: [person("APPROVED")] })).read;
    await settleTaskOutcomes(merged.deps, withReader(reopenedAndMerged, closed), T2, reopenedAndMerged);
    expect(stateOf(merged.db, "review_pass:CRITIC")).toBe("held");

    const open = await seeded();
    const reopened = readerOf({}, status({ state: "open" })).read;
    await settleTaskOutcomes(open.deps, withReader(reopened, closed), T2, reopened);
    expect(samples(open.db).every((item) => item.state === "no_outcome" && item.reason === "task_closed")).toBe(true);

    const unread = await seeded();
    await settleTaskOutcomes(unread.deps, withReader(undefined, closed), T2);
    expect(samples(unread.db).every((item) => item.state === "closed_unmerged")).toBe(true);
  });

  it("every read of a settle shares one deadline: a GitHub that never answers costs the budget once, and the rest is code_host_unavailable", async () => {
    const w = await seeded();
    const hanging: EndedPullRequestReader = () => new Promise(() => undefined);
    const prs = [{ number: 7, state: "MERGED" }, { number: 8, state: "MERGED", repositoryId: "api" }];
    const started = Date.now();
    await settleTaskOutcomes(w.deps, withReader(hanging, prs), T2, hanging, 150);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(samples(w.db).every((item) => item.state === "no_outcome" && item.reason === "code_host_unavailable")).toBe(true);
  });

  it("a closed pull request whose fresh read cannot be made is code_host_unavailable, not guessed", async () => {
    const w = await seeded();
    const failing: EndedPullRequestReader = async () => { throw new Error("secret github text"); };
    await settleTaskOutcomes(w.deps, withReader(failing, [{ number: 7, state: "CLOSED" }]), T2, failing);
    expect(samples(w.db).every((item) => item.state === "no_outcome" && item.reason === "code_host_unavailable")).toBe(true);
  });

  it("a candidate whose other pull request is still open when the task ends is not left pending", async () => {
    const w = await seeded();
    const reader = readerOf({}, status({ reviews: [person("APPROVED")] })).read;
    await settleTaskOutcomes(w.deps, withReader(reader, [{ number: 7, state: "MERGED" }, { number: 8, state: "OPEN", repositoryId: "api" }]), T2, reader);
    expect(samples(w.db).filter((item) => item.state === "pending")).toEqual([]);
    expect(samples(w.db).every((item) => item.state === "no_outcome" && item.reason === "task_closed")).toBe(true);
  });

  it("a task reached with under two seconds of the pass left is skipped with no read, not settled on a few milliseconds", async () => {
    const w = await seeded();
    let reads = 0;
    const counting: EndedPullRequestReader = async (...args) => { reads += 1; return readerOf({}, status()).read(...args); };
    expect(await settleTaskOutcomes(w.deps, withReader(counting, [{ number: 7, state: "MERGED" }]), T2, counting, 8_000, Date.now() + 1_500)).toBe("skipped");
    expect(reads).toBe(0);
    expect(samples(w.db).every((item) => item.state === "pending")).toBe(true);
  });

  it("a settle never fails the close", async () => {
    const w = world({ failing: true });
    await expect(settleTaskOutcomes(w.deps, task, T2)).resolves.toBe("incomplete");
    expect(w.metrics).toContain("OutcomeWriteFailed");
  });
});
