// Track record (v1.2 slice 1): what the tracking pass does with the samples of a pull request: a person's first request for changes, a feedback round a person started, a pull
// request closed without merging. The pass reads GitHub as it always did; the samples change after its own write, and a failing outcome write never fails the pass.
import { describe, expect, it } from "vitest";
import type { WorkflowSnapshot } from "../../packages/contracts/src/index.js";
import { trackPullRequest } from "../../packages/broker/src/rovara-code/merge-tracking.js";
import { outcomeRoundOf, recordPublicationOutcomes } from "../../packages/broker/src/rovara-code/outcome-hooks.js";
import type { OutcomeDependencies } from "../../packages/broker/src/rovara-code/outcomes.js";
import { HEAD_A, HEAD_B, TASK_ID, status, world, type TrackingWorld } from "../support/rovara-code-tracking.js";
import { TEST_ORG } from "../support/orgs.js";

const CANDIDATE = "c".repeat(64);
const SECOND = "d".repeat(64);
const ROUND = outcomeRoundOf(CANDIDATE);
const SECOND_ROUND = outcomeRoundOf(SECOND);
const review = (state: "APPROVED" | "CHANGES_REQUESTED", login: string, id: string, submittedAt = "2026-10-25T11:30:00.000Z") => ({ githubUserId: id, login, userType: "User", state, commitId: "a".repeat(40), submittedAt });
const passing = [{ name: "test", status: "completed" as const, conclusion: "success" as const, required: false, url: "" }];
const reviewReport = (role: "CRITIC" | "SECURITY") => ({ operationId: "o", candidateDigest: CANDIDATE, role, provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: "2026-10-25T10:00:00.000Z" });

async function seededWorld(options: { failing?: boolean } = {}) {
  const logs: string[] = [];
  const metrics: string[] = [];
  const w = world();
  const outcomes: OutcomeDependencies = {
    ddb: options.failing === true ? { send: async () => { throw Object.assign(new Error("secret"), { name: "ProvisionedThroughputExceededException" }); } } : w.db,
    tableName: "state", log: (event) => logs.push(event), metric: (name) => metrics.push(name),
  };
  await recordPublicationOutcomes({ ddb: w.db, tableName: "state" }, { taskId: TASK_ID, orgId: TEST_ORG, project: "web", agent: { agentId: "rovara-code", version: 2, digest: "d".repeat(64) } }, {
    workflow: { candidate: { digest: CANDIDATE }, reviews: [reviewReport("CRITIC"), reviewReport("SECURITY")], risk: { level: "low", reasons: [], candidateDigest: CANDIDATE } } as unknown as WorkflowSnapshot,
    proof: { verdicts: ["proves_change"], candidateDigest: CANDIDATE }, now: "2026-10-25T10:00:00.000Z",
  });
  w.github.permissions.set("alice", "write");
  w.github.permissions.set("bob", "write");
  return { w, deps: { ...w.deps, outcomes }, logs, metrics };
}
const sampleOf = (w: TrackingWorld, claim: string, round = ROUND) => w.db.find((item) => item.entityType === "OUTCOME_SAMPLE" && item.claim === claim && item.round === round)[0]!;
const read = (w: TrackingWorld) => w.github.statuses.get(7)!;

describe("a person asks for changes", () => {
  it("the first sight moves the review and risk samples to not_held, and a later approval does not undo it", async () => {
    const { w, deps } = await seededWorld();
    w.github.statuses.set(7, status({ draft: false, checks: passing, reviews: [review("CHANGES_REQUESTED", "alice", "1")] }));
    await trackPullRequest(deps, TASK_ID);
    for (const claim of ["review_pass:CRITIC", "review_pass:SECURITY", "risk_low"]) expect(sampleOf(w, claim)).toMatchObject({ state: "not_held", reason: "changes_requested_by_person" });
    expect(sampleOf(w, "proves_change").state).toBe("pending");
    expect(read(w).reviews).toHaveLength(1);
    w.github.statuses.set(7, status({ draft: false, checks: passing, reviews: [review("CHANGES_REQUESTED", "alice", "1"), review("APPROVED", "alice", "1", "2026-10-25T11:45:00.000Z")] }));
    await trackPullRequest(deps, TASK_ID);
    expect(sampleOf(w, "review_pass:CRITIC")).toMatchObject({ state: "not_held", reason: "changes_requested_by_person", scoredAt: "2026-10-25T12:00:00.000Z" });
  });

  it("a review that only comments, or a bot's request for changes, changes nothing", async () => {
    const { w, deps } = await seededWorld();
    w.github.statuses.set(7, status({ draft: false, checks: passing, reviews: [{ ...review("CHANGES_REQUESTED", "alice", "1"), userType: "Bot" }] }));
    await trackPullRequest(deps, TASK_ID);
    expect(sampleOf(w, "review_pass:CRITIC").state).toBe("pending");
  });
});

describe("a feedback round", () => {
  const decision = (actorRole: "TASK_OWNER" | "ROVARA_AUTONOMY") => ({
    decision: "APPROVE", actorRole, candidates: [{ repositoryId: "payments", number: 7, headSha: "a".repeat(40), candidateDigest: CANDIDATE }],
  });

  it.each(["TASK_OWNER", "ROVARA_AUTONOMY"] as const)("a round of fixes from people's comments (decided by %s) moves the review and risk samples to not_held", async (actorRole) => {
    const { w, deps } = await seededWorld();
    w.setWorkflow({ feedbackDecisions: [decision(actorRole)] });
    w.github.statuses.set(7, status({ draft: false, checks: passing }));
    await trackPullRequest(deps, TASK_ID);
    expect(sampleOf(w, "review_pass:CRITIC")).toMatchObject({ state: "not_held", reason: "feedback_round_by_person" });
    expect(sampleOf(w, "risk_low")).toMatchObject({ state: "not_held", reason: "feedback_round_by_person" });
    expect(sampleOf(w, "proves_change").state).toBe("pending");
  });

  it("the round is about the candidate its comments were made on, not the current one", async () => {
    const { w, deps } = await seededWorld();
    w.setWorkflow({ feedbackDecisions: [{ ...decision("ROVARA_AUTONOMY"), candidates: [{ repositoryId: "payments", number: 7, headSha: "a".repeat(40), candidateDigest: SECOND }] }] });
    w.github.statuses.set(7, status({ draft: false, checks: passing }));
    await trackPullRequest(deps, TASK_ID);
    expect(sampleOf(w, "review_pass:CRITIC").state).toBe("pending");
  });
});

describe("which candidate a request for changes is about", () => {
  /** The candidate A held by head A has been replaced on the pull request by B (head B), and both have open samples (A's settlement did not run). */
  async function afterAFix() {
    const { w, deps } = await seededWorld();
    w.github.statuses.set(7, status({ draft: false, headSha: HEAD_A, checks: passing }));
    await trackPullRequest(deps, TASK_ID);
    await recordPublicationOutcomes({ ddb: w.db, tableName: "state" }, { taskId: TASK_ID, orgId: TEST_ORG, project: "web" }, {
      workflow: { candidate: { digest: SECOND }, reviews: [{ ...reviewReport("CRITIC"), candidateDigest: SECOND }], risk: { level: "low", reasons: [], candidateDigest: SECOND } } as unknown as WorkflowSnapshot,
      proof: { unavailable: "not_found" }, now: "2026-10-25T11:00:00.000Z",
    });
    const record = w.db.get(`DEVTASK#${TASK_ID}`, "META") as { workflow: { pullRequests: Array<Record<string, unknown>> } };
    w.setWorkflow({ pullRequests: record.workflow.pullRequests.map((pr) => ({ ...pr, candidateDigest: SECOND, headSha: HEAD_B })) });
    return { w, deps };
  }

  it("a request first seen after the fix was pushed is about the candidate whose head the review is on", async () => {
    const { w, deps } = await afterAFix();
    w.github.statuses.set(7, status({ draft: false, headSha: HEAD_B, checks: passing, reviews: [{ ...review("CHANGES_REQUESTED", "alice", "1"), commitId: HEAD_A }] }));
    await trackPullRequest(deps, TASK_ID);
    expect(sampleOf(w, "review_pass:CRITIC")).toMatchObject({ state: "not_held", reason: "changes_requested_by_person" });
    expect(sampleOf(w, "review_pass:CRITIC", SECOND_ROUND).state).toBe("pending");
  });

  it("a review on a head not known is about the candidate current when it was seen", async () => {
    const { w, deps } = await afterAFix();
    w.github.statuses.set(7, status({ draft: false, headSha: HEAD_B, checks: passing, reviews: [{ ...review("CHANGES_REQUESTED", "alice", "1"), commitId: "7".repeat(40) }] }));
    await trackPullRequest(deps, TASK_ID);
    expect(sampleOf(w, "review_pass:CRITIC").state).toBe("pending");
    expect(sampleOf(w, "review_pass:CRITIC", SECOND_ROUND)).toMatchObject({ state: "not_held", reason: "changes_requested_by_person" });
  });

  it("a request from someone without write access moves nothing", async () => {
    const { w, deps } = await seededWorld();
    w.github.statuses.set(7, status({ draft: false, checks: passing, reviews: [review("CHANGES_REQUESTED", "mallory", "5")] }));
    await trackPullRequest(deps, TASK_ID);
    expect(sampleOf(w, "review_pass:CRITIC").state).toBe("pending");
  });
});

describe("the checks on the head the candidate published", () => {
  it("failing checks on that head are the proof's own answer, scored when seen, so a later fix cannot hide them", async () => {
    const { w, deps } = await seededWorld();
    w.github.statuses.set(7, status({ draft: false, checks: [{ name: "test", status: "completed" as const, conclusion: "failure" as const, required: false, url: "" }] }));
    await trackPullRequest(deps, TASK_ID);
    expect(sampleOf(w, "proves_change")).toMatchObject({ state: "not_held", reason: "ci_failing" });
    expect(sampleOf(w, "review_pass:CRITIC").state).toBe("pending");
  });

  it("failing checks on a head that is not the candidate's (someone else pushed) are not its proof's answer", async () => {
    const { w, deps } = await seededWorld();
    w.github.statuses.set(7, status({ draft: false, headSha: HEAD_B, checks: [{ name: "test", status: "completed" as const, conclusion: "failure" as const, required: false, url: "" }] }));
    await trackPullRequest(deps, TASK_ID);
    expect(sampleOf(w, "proves_change").state).toBe("pending");
  });
});

describe("a pull request closed without merging", () => {
  it("is not scored at the close: it may be reopened", async () => {
    const { w, deps } = await seededWorld();
    w.github.statuses.set(7, status({ state: "closed", draft: false, checks: passing }));
    await trackPullRequest(deps, TASK_ID);
    for (const claim of ["review_pass:CRITIC", "review_pass:SECURITY", "risk_low", "proves_change"]) expect(sampleOf(w, claim).state).toBe("pending");
  });
});

describe("a failing outcome write", () => {
  it("never fails the pass: the tracking item is written, and the failure is counted", async () => {
    const { w, deps, metrics } = await seededWorld({ failing: true });
    w.github.statuses.set(7, status({ draft: false, checks: passing, reviews: [review("CHANGES_REQUESTED", "alice", "1")] }));
    await expect(trackPullRequest(deps, TASK_ID)).resolves.toBe("changed");
    expect(w.db.find((item) => item.entityType === "MERGE_TRACKING")).toHaveLength(1);
    expect(metrics).toContain("OutcomeWriteFailed");
    expect(sampleOf(w, "review_pass:CRITIC").state).toBe("pending");
  });
});
