// Track record (v1.2 slice 1): what the tracking pass does with the samples of a pull request: a person's first request for changes, a feedback round a person started, a pull
// request closed without merging. The pass reads GitHub as it always did; the samples change after its own write, and a failing outcome write never fails the pass.
import { describe, expect, it } from "vitest";
import type { WorkflowSnapshot } from "../../packages/contracts/src/index.js";
import { trackPullRequest } from "../../packages/broker/src/rovara-code/merge-tracking.js";
import { outcomeRoundOf, recordPublicationOutcomes } from "../../packages/broker/src/rovara-code/outcome-hooks.js";
import type { OutcomeDependencies } from "../../packages/broker/src/rovara-code/outcomes.js";
import { TASK_ID, status, world, type TrackingWorld } from "../support/rovara-code-tracking.js";
import { TEST_ORG } from "../support/orgs.js";

const CANDIDATE = "c".repeat(64);
const ROUND = outcomeRoundOf(CANDIDATE);
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
const sampleOf = (w: TrackingWorld, claim: string) => w.db.find((item) => item.entityType === "OUTCOME_SAMPLE" && item.claim === claim && item.round === ROUND)[0]!;
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

  it("a round a person started moves the review and risk samples to not_held", async () => {
    const { w, deps } = await seededWorld();
    w.setWorkflow({ feedbackDecisions: [decision("TASK_OWNER")] });
    w.github.statuses.set(7, status({ draft: false, checks: passing }));
    await trackPullRequest(deps, TASK_ID);
    expect(sampleOf(w, "review_pass:CRITIC")).toMatchObject({ state: "not_held", reason: "feedback_round_by_person" });
    expect(sampleOf(w, "risk_low")).toMatchObject({ state: "not_held", reason: "feedback_round_by_person" });
  });

  it("a round Rovara decided itself moves nothing", async () => {
    const { w, deps } = await seededWorld();
    w.setWorkflow({ feedbackDecisions: [decision("ROVARA_AUTONOMY")] });
    w.github.statuses.set(7, status({ draft: false, checks: passing }));
    await trackPullRequest(deps, TASK_ID);
    expect(sampleOf(w, "review_pass:CRITIC").state).toBe("pending");
  });
});

describe("a pull request closed without merging", () => {
  it("puts the candidate's samples in the closed-unmerged bucket", async () => {
    const { w, deps } = await seededWorld();
    w.github.statuses.set(7, status({ state: "closed", draft: false, checks: passing }));
    await trackPullRequest(deps, TASK_ID);
    for (const claim of ["review_pass:CRITIC", "review_pass:SECURITY", "risk_low", "proves_change"]) expect(sampleOf(w, claim)).toMatchObject({ state: "closed_unmerged", reason: "closed_unmerged" });
  });

  it("a pull request that merged is left to the merge, which also has the merge commit", async () => {
    const { w, deps } = await seededWorld();
    w.github.statuses.set(7, status({ state: "merged", draft: false, checks: passing }));
    await trackPullRequest(deps, TASK_ID);
    expect(sampleOf(w, "review_pass:CRITIC").state).toBe("pending");
  });
});

describe("a failing outcome write", () => {
  it("never fails the pass: the tracking item is written, and the failure is counted", async () => {
    const { w, deps, metrics } = await seededWorld({ failing: true });
    w.github.statuses.set(7, status({ state: "closed", draft: false, checks: passing, reviews: [review("CHANGES_REQUESTED", "alice", "1")] }));
    await expect(trackPullRequest(deps, TASK_ID)).resolves.toBe("changed");
    expect(w.db.find((item) => item.entityType === "MERGE_TRACKING")).toHaveLength(1);
    expect(metrics).toContain("OutcomeWriteFailed");
    expect(sampleOf(w, "review_pass:CRITIC").state).toBe("pending");
  });
});
