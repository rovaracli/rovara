// Design review stage, DR6 (designs-2026-10-30/design-review-stage.md 3.2, 3.7, 3.13): the workflow's transitions. Bounds, settled findings, oscillation stop, cap stop, not-run paths,
// and the guarantee that with design review OFF nothing changed (the plan check's own tests live in rovara-code-critic.test.ts and stay green).
import { describe, expect, it } from "vitest";
import {
  DESIGN_REVIEW_ROUNDS_MAX, DESIGN_REVIEW_EARLIER_MAX, DESIGN_REVIEW_EARLIER_MAX_BYTES, DESIGN_REVIEW_REARMS_MAX, WorkflowSnapshotSchema, blockWorkflow, closeParkedDesignReview, designReviewCapRoom,
  lowerDesignReviewTier, parkDesignReview, skipDesignReview, raiseDesignReviewCap, rearmedDesignReview, resumeBlockedDesignReview, resumeParkedDesignReview, retryDesignReviewNotRun, answerDesignQuestions, askDesignQuestions, closeDesignReview, closePlanCritique, createWorkflowSnapshot, decideWorkflow, designFindingFingerprint,
  designReviewDisagreements, designReviewRevisionsUsed, enableDesignReview, holdDesignReviewForCost, resolveDesignReview, retryDesignReview, startDesignReview, submitDesignReview, submitPlanCritique,
  submitWorkflowArtifact, workflowIsDesignReviewing, type WorkflowProgram, type WorkflowSnapshot,
} from "../../packages/contracts/src/index.js";
import { gateDesignReviewCost, type DesignReviewEstimate } from "../../packages/broker/src/design-review/estimate.js";
import { applyDesignSpendChoice } from "../../packages/broker/src/design-review/spend-choice.js";
import * as web from "../../packages/contracts/src/web.js";
import { taskViewForClient } from "../../packages/broker/src/rovara-code/task-view-compat.js";

const NOW = "2026-11-03T12:00:00.000Z";
const APPROVED = { by: { actorId: "c".repeat(64) } };
const LATER = "2026-11-03T12:05:00.000Z";
const TASK_ID = "11111111-1111-4111-8111-111111111111";
const OWNER = "a".repeat(64);
const PERSON = "b".repeat(64);
const hex = (n: number): string => n.toString(16).padStart(64, "0");

const PROGRAM: WorkflowProgram = { steps: [
  { id: "plan", kind: "plan" }, { id: "plan_critic", kind: "plan_critic" }, { id: "build", kind: "build" }, { id: "check", kind: "check" },
  { id: "review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "build", maxRounds: 3 } }, { id: "pull_request", kind: "pull_request" },
] };
const NO_CRITIC: WorkflowProgram = { steps: PROGRAM.steps.filter((step) => step.kind !== "plan_critic") };
const DIGEST = { requirements: 1, design: 2, plan: 3 } as const;
const artifact = (type: "requirements" | "design" | "plan", version = 1) => ({
  id: `artifact-${type}-${version}`, type, version, sha256: hex(DIGEST[type] * 1000 + version), producer: "agentx-worker-untrusted" as const, objectKey: `k/${type}-${version}.json`, createdAt: NOW, format: "structured" as const,
});
const START = { decidedBy: "auto" as const, reasons: ["new_api" as const], note: "Adds a public API.", tier: "standard" as const, capUsd: 10 };
const running = (workflow: WorkflowSnapshot): WorkflowSnapshot => ({ ...workflow, revision: workflow.revision + 1, state: "RUNNING" });
const planReady = (extra: { program?: WorkflowProgram; definitionVersion?: "1.0.0" | "1.1.0"; path?: "QUICK" | "FULL" } = {}): WorkflowSnapshot => {
  const workflow = createWorkflowSnapshot({ taskId: TASK_ID, ownerId: OWNER, now: NOW, path: extra.path ?? "QUICK", definitionVersion: extra.definitionVersion ?? "1.1.0", program: extra.program ?? PROGRAM });
  return { ...workflow, state: "READY" };
};
const on = (workflow: WorkflowSnapshot, start: Partial<typeof START> = {}): WorkflowSnapshot => enableDesignReview(workflow, { expectedRevision: workflow.revision, start: { ...START, ...start }, now: NOW });
const decide = (workflow: WorkflowSnapshot, decision: "APPROVE" | "REQUEST_CHANGES", digest: string, requestId = "22222222-2222-4222-8222-222222222222"): WorkflowSnapshot =>
  decideWorkflow(workflow, { requestId, expectedRevision: workflow.revision, decision, reason: "ok", artifactDigest: digest }, { actorId: OWNER, role: "TASK_OWNER" }, { now: LATER, allowedSkipStages: [] });

/** A Full task whose requirements were approved and whose first design was just submitted: PLAN_CRITIQUE/READY, review "estimating". */
function designSubmitted(start: Partial<typeof START> = {}): WorkflowSnapshot {
  let workflow = on(planReady(), start);
  workflow = submitWorkflowArtifact(running(workflow), { expectedRevision: workflow.revision + 1, artifact: artifact("requirements"), now: NOW });
  workflow = decide(workflow, "APPROVE", artifact("requirements").sha256);
  return submitWorkflowArtifact(running(workflow), { expectedRevision: workflow.revision + 1, artifact: artifact("design"), now: NOW });
}
const started = (workflow: WorkflowSnapshot, extra: { estimateUsd?: number } = {}): WorkflowSnapshot => startDesignReview(workflow, { expectedRevision: workflow.revision, estimateUsd: 1, ...extra, now: NOW });

const MODEL = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-opus-5-5-v1" };
const reviewerRun = (role: "comprehension" | "critic" | "codebase" | "zoom_out" | "critic_b", extra: Record<string, unknown> = {}) => ({
  role, promptId: `design-${role}`, promptVersion: 1, promptDigest: hex(7), model: MODEL, sourceId: "src_1", sessionId: `ses_${role}`, modelKeyId: `key_${role}`, packetDigest: hex(8),
  packet: [{ kind: "design", ref: "design.md", commitOrFetchedAt: "a".repeat(40), digest: hex(9), bytes: 1200 }], filesRead: [], verified: true, inputProof: "digest_only", tokensIn: 1000, tokensOut: 200, costUsd: 0.1,
  startedAt: NOW, endedAt: LATER, ...extra,
});
const failedRun = (role: "critic" | "codebase", failure: string) => reviewerRun(role, { verified: false, verifyFailure: failure, inputProof: undefined });
const finding = (id: string, severity: "blocker" | "major" | "nit", text: string, from: Array<"comprehension" | "critic" | "codebase" | "zoom_out" | "critic_b"> = ["critic"], section: "§1" | "§3" | "§4" = "§3") => ({
  id, severity, section, text, citations: [{ kind: "design", section }], fromReviewers: from, rawIds: from.map((role) => `${role}-${id}`), fingerprint: hex(1),
});
const designOf = (workflow: WorkflowSnapshot): string => workflow.artifacts.filter((entry) => entry.type === "design").at(-1)!.sha256;
const submitRound = (workflow: WorkflowSnapshot, findings: unknown[], extra: Record<string, unknown> = {}, reviewers: unknown[] = [reviewerRun("critic"), reviewerRun("codebase")]): WorkflowSnapshot =>
  submitDesignReview(workflow, { expectedRevision: workflow.revision, designDigest: designOf(workflow), reviewers, findings, now: LATER, ...extra });
const planner = (workflow: WorkflowSnapshot): WorkflowSnapshot => running(workflow);
const evidence = [{ kind: "design", section: "§4" }];
const fixed = (findingId: string) => ({ findingId, action: "fixed", note: "Changed §3.", settled: false });
const contested = (findingId: string) => ({ findingId, action: "contested", evidence, note: "§4 already bounds it.", settled: true });
const resolve = (workflow: WorkflowSnapshot, resolutions: unknown[], design?: ReturnType<typeof artifact>): WorkflowSnapshot =>
  resolveDesignReview(workflow, { expectedRevision: workflow.revision, resolutions, ...(design === undefined ? {} : { artifact: design }), now: LATER });
const question = (id: "q1" | "q2" | "q3") => ({ id, unclear: "Which queue?", evidence: [], options: [{ id: "a", label: "SQS", consequence: "Managed." }, { id: "b", label: "Own table", consequence: "More code." }], recommended: "a", why: "Fewer parts." });

/** Round 1 found a blocker; the planner fixed it with design v2, which now waits for round 2 (PLAN_CRITIQUE/READY, "estimating"). */
function atRound2(): WorkflowSnapshot {
  const round1 = submitRound(started(designSubmitted()), [finding("f1", "blocker", "Retries have no limit.")]);
  return resolve(planner(round1), [fixed("f1")], artifact("design", 2));
}

describe("old snapshots and the OFF switch", () => {
  it("parses a stored snapshot with no designReview, and one with it", () => {
    const old = planReady();
    expect("designReview" in old).toBe(false);
    expect(WorkflowSnapshotSchema.parse(JSON.parse(JSON.stringify(old))).designReview).toBeUndefined();
    const withReview = designSubmitted();
    expect(WorkflowSnapshotSchema.parse(JSON.parse(JSON.stringify(withReview))).designReview).toMatchObject({ status: "estimating", rounds: [] });
  });

  it("refuses designReview on a version 1.0.0 workflow and on a Quick one", () => {
    const review = designSubmitted().designReview;
    expect(WorkflowSnapshotSchema.safeParse({ ...planReady({ definitionVersion: "1.0.0", program: NO_CRITIC, path: "FULL" }), designReview: review }).success).toBe(false);
    expect(WorkflowSnapshotSchema.safeParse({ ...planReady(), designReview: review }).success).toBe(false);
  });

  it("with it OFF a Full task's design goes straight to the person, as before", () => {
    let workflow = planReady({ path: "FULL" });
    workflow = submitWorkflowArtifact(running(workflow), { expectedRevision: workflow.revision + 1, artifact: artifact("requirements"), now: NOW });
    workflow = decide(workflow, "APPROVE", artifact("requirements").sha256);
    const next = submitWorkflowArtifact(running(workflow), { expectedRevision: workflow.revision + 1, artifact: artifact("design"), now: NOW });
    expect(next).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    expect("designReview" in next).toBe(false);
  });

  it("with it ON a coding plan is still checked by the plan check, not the design review", () => {
    const next = submitWorkflowArtifact(running(planReady({ path: "QUICK" })), { expectedRevision: 2, artifact: artifact("plan"), now: NOW });
    expect(next).toMatchObject({ stage: "PLAN_CRITIQUE", state: "READY" });
    expect(workflowIsDesignReviewing(next)).toBe(false);
  });

  it("is browser-safe: the web entry reads the review the same way", () => {
    expect(web.designReviewDisagreements).toBeTypeOf("function");
  });

  it("hides designReview from a client that does not read task view 2", () => {
    const task = { taskId: TASK_ID, workflow: designSubmitted() } as unknown as Parameters<typeof taskViewForClient>[0];
    expect(taskViewForClient(task, {}).workflow).not.toHaveProperty("designReview");
    expect(taskViewForClient(task, { "x-agentx-task-view": "2" }).workflow).toHaveProperty("designReview");
  });
});

describe("enableDesignReview", () => {
  it("forces the Full path from a Quick task, starting at the requirements, and records the reading", () => {
    const next = on(planReady());
    expect(next).toMatchObject({ path: "FULL", reviewPhase: "REQUIREMENTS", stage: "PLAN", state: "READY", designReview: { decidedBy: "auto", status: "estimating", spentUsd: 0, rounds: [], tier: "standard" } });
  });

  it("keeps the phase of a Full task that is already past its requirements", () => {
    let workflow = on(planReady());
    workflow = submitWorkflowArtifact(running(workflow), { expectedRevision: workflow.revision + 1, artifact: artifact("requirements"), now: NOW });
    expect(decide(workflow, "APPROVE", artifact("requirements").sha256)).toMatchObject({ reviewPhase: "DESIGN", designReview: { status: "estimating" } });
  });

  it("refuses with no plan check step, on version 1, twice, after a design exists, or when not ready to plan", () => {
    expect(() => on(planReady({ program: NO_CRITIC }))).toThrow(/plan check step/);
    expect(() => on(planReady({ definitionVersion: "1.0.0", program: NO_CRITIC }))).toThrow(/ready to plan/);
    expect(() => on(on(planReady()))).toThrow(/already on/);
    expect(() => on(designSubmitted())).toThrow(/already on|ready to plan/);
    const planning = planReady();
    expect(() => on({ ...planning, state: "RUNNING" })).toThrow(/ready to plan/);
    expect(() => enableDesignReview(planning, { expectedRevision: planning.revision + 1, start: START, now: NOW })).toThrow(/stale/);
  });

  it("refuses a decision that is not an ON decision and a note with control characters", () => {
    const workflow = planReady();
    expect(() => enableDesignReview(workflow, { expectedRevision: workflow.revision, start: { ...START, decidedBy: "never" as never }, now: NOW })).toThrow(/invalid/);
    expect(() => enableDesignReview(workflow, { expectedRevision: workflow.revision, start: { ...START, note: "ok‮evil" }, now: NOW })).toThrow(/invalid/);
  });
});

describe("a design goes to the review", () => {
  it("admits the first design to PLAN_CRITIQUE when ON, with the review still waiting to start", () => {
    const next = designSubmitted();
    expect(next).toMatchObject({ stage: "PLAN_CRITIQUE", state: "READY", reviewPhase: "DESIGN", designReview: { status: "estimating", rounds: [] } });
    expect(workflowIsDesignReviewing(next)).toBe(true);
    expect(next.critique).toBeUndefined();
  });

  it("refuses a revised design submitted the ordinary way while the review waits for the planner's resolution", () => {
    const resolving = submitRound(started(designSubmitted()), [finding("f1", "blocker", "x")]);
    expect(resolving).toMatchObject({ stage: "PLAN", state: "READY", designReview: { status: "resolving" } });
    expect(() => submitWorkflowArtifact(running(resolving), { expectedRevision: resolving.revision + 1, artifact: artifact("design", 2), now: NOW })).toThrow(/resolves its findings/);
  });

  it("keeps the plan check's moves off a design review", () => {
    const ready = designSubmitted();
    const live = started(ready);
    expect(() => submitPlanCritique(live, { expectedRevision: live.revision, critique: { verdict: "ok", points: [], model: { provider: "p", modelId: "m", company: "anthropic" } }, now: LATER })).toThrow(/design review/);
    expect(() => closePlanCritique(ready, { expectedRevision: ready.revision, status: "done", now: LATER })).toThrow(/design review/);
  });
});

describe("before the reviewers run", () => {
  it("starts from READY, and holds for the cost until a person approves it", () => {
    const ready = designSubmitted();
    const held = holdDesignReviewForCost(ready, { expectedRevision: ready.revision, estimateUsd: 7, now: NOW });
    expect(held).toMatchObject({ stage: "PLAN_CRITIQUE", state: "WAITING", designReview: { status: "waiting_cost", estimateUsd: 7 } });
    expect(() => startDesignReview(held, { expectedRevision: held.revision, now: NOW })).toThrow(/spend/);
    expect(startDesignReview(held, { expectedRevision: held.revision, costApproved: APPROVED, now: NOW })).toMatchObject({ state: "RUNNING", designReview: { status: "running" } });
    expect(started(ready, { estimateUsd: 3 })).toMatchObject({ state: "RUNNING", designReview: { status: "running", estimateUsd: 3 } });
  });

  it("goes back to READY when the model can't be used, and refuses a start at the wrong state", () => {
    const live = started(designSubmitted());
    expect(retryDesignReview(live, { expectedRevision: live.revision, now: NOW })).toMatchObject({ state: "READY", designReview: { status: "estimating" } });
    expect(() => started(live)).toThrow(/not at that step/);
    expect(() => startDesignReview(live, { expectedRevision: live.revision - 1, estimateUsd: 1, now: NOW })).toThrow(/stale/);
  });

  it("never starts a third round", () => {
    const round2 = started(atRound2());
    const done = submitRound(round2, []);
    expect(done.designReview!.rounds).toHaveLength(DESIGN_REVIEW_ROUNDS_MAX);
    expect(() => startDesignReview({ ...done, stage: "PLAN_CRITIQUE", state: "READY", designReview: { ...done.designReview!, status: "estimating" } }, { expectedRevision: done.revision, estimateUsd: 1, now: NOW })).toThrow(/rounds/);
  });
});

describe("submitDesignReview", () => {
  it("refuses a third round even from a stored record that claims to be running", () => {
    const done = submitRound(started(atRound2()), []);
    const forged: WorkflowSnapshot = { ...done, stage: "PLAN_CRITIQUE", state: "RUNNING", designReview: { ...done.designReview!, status: "running" } };
    expect(() => submitRound(forged, [])).toThrow(/used its rounds/);
  });

  it("records the round, adds up what it cost, and sends the findings to the planner", () => {
    const next = submitRound(started(designSubmitted()), [finding("f1", "blocker", "Retries have no limit.")], { mergeCostUsd: 0.05 });
    expect(next).toMatchObject({ stage: "PLAN", state: "READY", designReview: { status: "resolving", spentUsd: 0.25 } });
    expect(next.designReview!.rounds[0]).toMatchObject({ round: 1, designDigest: designOf(next), resolutions: [] });
    expect(next.decisions).toHaveLength(1);
    expect(next.outcome).toBeUndefined();
  });

  it("computes the fingerprint itself: a forged one is replaced, and the same words fingerprint alike", () => {
    const next = submitRound(started(designSubmitted()), [{ ...finding("f1", "blocker", "Retries have no limit."), fingerprint: hex(99) }]);
    const stored = next.designReview!.rounds[0]!.findings[0]!;
    expect(stored.fingerprint).not.toBe(hex(99));
    expect(stored.fingerprint).toBe(designFindingFingerprint({ section: "§3", text: "  retries HAVE no limit!! " }));
    expect(stored.fingerprint).not.toBe(designFindingFingerprint({ section: "§4", text: "Retries have no limit." }));
  });

  it("goes to the person when there is nothing to resolve", () => {
    const next = submitRound(started(designSubmitted()), []);
    expect(next).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "done" } });
    expect(designReviewDisagreements(next.designReview)).toEqual([]);
  });

  it("counts only verified reviewers: a finding from one that failed is refused", () => {
    const reviewers = [reviewerRun("critic"), failedRun("codebase", "session_reused")];
    expect(() => submitRound(started(designSubmitted()), [finding("f1", "major", "x", ["codebase"])], {}, reviewers)).toThrow(/does not count/);
    const next = submitRound(started(designSubmitted()), [finding("f1", "major", "x", ["critic"])], {}, reviewers);
    expect(next.designReview!.rounds[0]!.reviewers.map((run) => run.verified)).toEqual([true, false]);
    expect(next.designReview!.status).toBe("resolving");
  });

  it("refuses the wrong design, a stale revision, a repeated role, two findings with one id, a raw finding merged twice, and a state that is not running", () => {
    const live = started(designSubmitted());
    const base = { expectedRevision: live.revision, designDigest: designOf(live), reviewers: [reviewerRun("critic")], findings: [], now: LATER };
    expect(() => submitDesignReview(live, { ...base, designDigest: hex(5) })).toThrow(/current design/);
    expect(() => submitDesignReview(live, { ...base, expectedRevision: live.revision - 1 })).toThrow(/stale/);
    expect(() => submitDesignReview(live, { ...base, reviewers: [reviewerRun("critic"), reviewerRun("critic")] })).toThrow(/ran twice/);
    expect(() => submitRound(live, [finding("f1", "nit", "a"), finding("f1", "nit", "b")])).toThrow(/share an id/);
    expect(() => submitRound(live, [finding("f1", "nit", "a"), { ...finding("f2", "nit", "b"), rawIds: ["critic-f1"] }])).toThrow(/two findings/);
    expect(() => submitDesignReview(designSubmitted(), { ...base, expectedRevision: designSubmitted().revision })).toThrow(/not at that step/);
  });

  it("is not run when no reviewer gave a result, with the reason: integrity, then timeout, then the worker", () => {
    const none = (runs: unknown[]) => submitRound(started(designSubmitted()), [], {}, runs);
    expect(none([failedRun("critic", "packet_digest_mismatch"), failedRun("codebase", "timeout")]).designReview).toMatchObject({ status: "not_run", notRunReason: "inputs_unverified" });
    expect(none([failedRun("critic", "timeout"), failedRun("codebase", "unreadable_output")]).designReview).toMatchObject({ status: "not_run", notRunReason: "timeout" });
    expect(none([failedRun("critic", "unreadable_output")]).designReview).toMatchObject({ status: "not_run", notRunReason: "worker_failed" });
    const empty = none([]);
    expect(empty).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "not_run", notRunReason: "worker_failed" } });
    expect(empty.decisions).toHaveLength(1);
  });

  it("a second round that gave no result leaves the review done, with the reason, and the earlier fix unchecked", () => {
    const round2 = started(atRound2());
    const next = submitRound(round2, [], {}, [failedRun("critic", "timeout")]);
    expect(next).toMatchObject({ stage: "PLAN_REVIEW", designReview: { status: "done", notRunReason: "timeout" } });
    expect(designReviewDisagreements(next.designReview)).toEqual([{ round: 1, findingId: "f1", severity: "blocker", kind: "unchecked_fix", raisedAgain: false }]);
  });

  it("stops at the cost cap: when the worker says so, or when the round overspent the cap; the findings go to the person unresolved", () => {
    const flagged = submitRound(started(designSubmitted()), [finding("f1", "blocker", "x")], { stoppedAtCap: true });
    expect(flagged).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "stopped_at_cap" } });
    expect(designReviewDisagreements(flagged.designReview)).toEqual([{ round: 1, findingId: "f1", severity: "blocker", kind: "unresolved", raisedAgain: false }]);
    const dear = [reviewerRun("critic", { costUsd: 0.3 }), reviewerRun("codebase", { costUsd: 0.3 })];
    expect(submitRound(started(designSubmitted({ capUsd: 0.5 }), { estimateUsd: 0.1 }), [finding("f1", "blocker", "x")], {}, dear).designReview!.status).toBe("stopped_at_cap");
    expect(submitRound(started(designSubmitted({ capUsd: 0.6 }), { estimateUsd: 0.1 }), [finding("f1", "blocker", "x")], {}, dear).designReview!.status).toBe("resolving");
  });

  it("refuses a record that is too large to keep, rather than trimming evidence", () => {
    const heavy = reviewerRun("critic", { filesRead: Array.from({ length: 200 }, (_, index) => `${"p".repeat(480)}${index}`), packet: Array.from({ length: 40 }, (_, index) => ({ kind: "repo_file", ref: `${"r".repeat(480)}${index}`, commitOrFetchedAt: "a".repeat(40), digest: hex(9), bytes: 10 })) });
    const reviewers = [heavy, { ...heavy, role: "codebase" }, { ...heavy, role: "zoom_out" }];
    expect(() => submitRound(started(designSubmitted()), [], {}, reviewers)).toThrow(/too large/);
  });
});

describe("the planner's resolution", () => {
  const roundOne = (findings: unknown[]): WorkflowSnapshot => planner(submitRound(started(designSubmitted()), findings, {}, [reviewerRun("comprehension"), reviewerRun("critic"), reviewerRun("codebase")]));

  it("needs exactly one resolution for each open finding", () => {
    const workflow = roundOne([finding("f1", "blocker", "a"), finding("f2", "major", "b")]);
    expect(() => resolve(workflow, [contested("f1")])).toThrow(/every open finding/);
    expect(() => resolve(workflow, [contested("f1"), contested("f1")])).toThrow(/every open finding/);
    expect(() => resolve(workflow, [contested("f1"), contested("f3")])).toThrow(/every open finding/);
    expect(() => resolve(workflow, [contested("f1"), { ...contested("f2"), evidence: [] }])).toThrow(/invalid/);
  });

  it("settles contested and declined findings itself, and a fix stays open whatever the planner says", () => {
    const workflow = roundOne([finding("f1", "blocker", "a"), finding("f2", "nit", "b"), finding("f3", "major", "c")]);
    const next = resolve(workflow, [{ ...fixed("f1"), settled: true }, { findingId: "f2", action: "declined", note: "Style.", settled: false }, { ...contested("f3"), settled: false }], artifact("design", 2));
    expect(next.designReview!.rounds[0]!.resolutions.map((resolution) => [resolution.findingId, resolution.settled])).toEqual([["f1", false], ["f2", true], ["f3", true]]);
  });

  it("refuses to contest a comprehension finding, or to decline anything but a nit", () => {
    const comprehension = roundOne([finding("f1", "major", "I could not tell what the cache holds.", ["comprehension", "critic"])]);
    expect(() => resolve(comprehension, [contested("f1")])).toThrow(/not understood/);
    expect(() => resolve(comprehension, [{ findingId: "f1", action: "declined", note: "n", settled: true }])).toThrow(/declined/);
    const major = roundOne([finding("f1", "major", "x")]);
    expect(() => resolve(major, [{ findingId: "f1", action: "declined", note: "n", settled: true }])).toThrow(/declined/);
    const nit = roundOne([finding("f1", "nit", "x", ["comprehension"])]);
    expect(() => resolve(nit, [{ findingId: "f1", action: "declined", note: "n", settled: true }])).toThrow(/declined/);
  });

  it("a fix needs a changed design document", () => {
    const workflow = roundOne([finding("f1", "blocker", "a")]);
    expect(() => resolve(workflow, [fixed("f1")])).toThrow(/changed design/);
    expect(() => resolve(workflow, [fixed("f1")], artifact("design", 1))).toThrow(/changed design/);
    expect(() => resolve(workflow, [fixed("f1")], { ...artifact("design", 2), type: "plan" as never })).toThrow(/changed design/);
  });

  it("a fixed blocker sends the revised design to round 2; nothing else does", () => {
    const fixedBlocker = resolve(roundOne([finding("f1", "blocker", "a")]), [fixed("f1")], artifact("design", 2));
    expect(fixedBlocker).toMatchObject({ stage: "PLAN_CRITIQUE", state: "READY", designReview: { status: "estimating" } });
    expect(designOf(fixedBlocker)).toBe(artifact("design", 2).sha256);

    const fixedNit = resolve(roundOne([finding("f1", "nit", "a")]), [fixed("f1")], artifact("design", 2));
    expect(fixedNit).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "done" } });

    const contestedBlocker = resolve(roundOne([finding("f1", "blocker", "a")]), [contested("f1")]);
    expect(contestedBlocker).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "done" } });
    expect(contestedBlocker.artifacts).toHaveLength(2);
    expect(designReviewDisagreements(contestedBlocker.designReview)).toEqual([{ round: 1, findingId: "f1", severity: "blocker", kind: "contested", raisedAgain: false }]);
    expect(contestedBlocker.decisions).toHaveLength(1);
  });

  it("a contested major is settled; a contested blocker is a disagreement; nits never are", () => {
    const next = resolve(roundOne([finding("f1", "major", "a"), finding("f2", "blocker", "b"), finding("f3", "nit", "c")]), [contested("f1"), contested("f2"), contested("f3")]);
    expect(designReviewDisagreements(next.designReview).map((entry) => [entry.findingId, entry.kind])).toEqual([["f2", "contested"]]);
  });

  it("refuses to resolve twice, out of turn, or at a stale revision", () => {
    const workflow = roundOne([finding("f1", "blocker", "a")]);
    const next = resolve(workflow, [contested("f1")]);
    expect(() => resolve({ ...next, stage: "PLAN", state: "RUNNING" }, [contested("f1")])).toThrow(/not at that step/);
    expect(() => resolveDesignReview(workflow, { expectedRevision: workflow.revision - 1, resolutions: [contested("f1")], now: LATER })).toThrow(/stale/);
    expect(() => resolve(submitRound(started(designSubmitted()), [finding("f1", "blocker", "a")]), [contested("f1")])).toThrow(/not at that step/);
  });
});

describe("questions", () => {
  const asking = (): WorkflowSnapshot => planner(submitRound(started(designSubmitted()), [finding("f1", "blocker", "Which queue do we use?"), finding("f2", "major", "b")]));
  const asked = (): WorkflowSnapshot => askDesignQuestions(asking(), { expectedRevision: asking().revision, questions: [question("q1"), question("q2")], now: LATER });
  const answers = [{ questionId: "q1", optionId: "a" }, { questionId: "q2", text: "Use the existing one." }];
  const answered = (): WorkflowSnapshot => answerDesignQuestions(asked(), { expectedRevision: asked().revision, answers, by: { actorId: PERSON }, now: LATER });
  const askedResolution = { findingId: "f1", action: "asked", questionId: "q1", note: "Asked.", settled: true };

  it("waits for the person: one card, with the questions kept on the round and nothing spent", () => {
    const next = asked();
    expect(next).toMatchObject({ stage: "PLAN", state: "WAITING", designReview: { status: "waiting_answers", spentUsd: 0.2 } });
    expect(next.designReview!.rounds[0]!.questions).toHaveLength(2);
  });

  it("allows at most 3 questions on one card, one card per round, and none in the last round", () => {
    const workflow = asking();
    const ask = (questions: unknown[]) => askDesignQuestions(workflow, { expectedRevision: workflow.revision, questions, now: LATER });
    expect(() => ask([])).toThrow(/invalid/);
    expect(() => ask([question("q1"), question("q2"), question("q3"), { ...question("q3"), id: "q4" }])).toThrow(/invalid/);
    expect(() => ask([question("q1"), question("q1")])).toThrow(/invalid/);
    expect(ask([question("q1"), question("q2"), question("q3")]).designReview!.rounds[0]!.questions).toHaveLength(3);
    const waiting = asked();
    const { waiting: _wait, ...withoutWait } = waiting.designReview!;
    void _wait;
    expect(() => askDesignQuestions({ ...waiting, state: "RUNNING", designReview: { ...withoutWait, status: "resolving" } }, { expectedRevision: waiting.revision, questions: [question("q1")], now: LATER })).toThrow(/one question card/);
    const round2 = planner(submitRound(started(atRound2()), [finding("f9", "major", "again")]));
    expect(() => askDesignQuestions(round2, { expectedRevision: round2.revision, questions: [question("q1")], now: LATER })).toThrow(/last round/);
  });

  it("needs an answer to every question, from the options or in words, cleaned, from a person the broker named", () => {
    const waiting = asked();
    const answer = (list: unknown[], by = PERSON) => answerDesignQuestions(waiting, { expectedRevision: waiting.revision, answers: list, by: { actorId: by }, now: LATER });
    expect(() => answer([{ questionId: "q1", optionId: "a" }])).toThrow(/every question/);
    expect(() => answer([{ questionId: "q1", optionId: "a" }, { questionId: "q1", optionId: "b" }])).toThrow(/every question/);
    expect(() => answer([{ questionId: "q1", optionId: "a" }, { questionId: "q3", optionId: "a" }])).toThrow(/every question/);
    expect(() => answer([{ questionId: "q1", optionId: "z" }, { questionId: "q2", optionId: "a" }])).toThrow(/options/);
    expect(() => answer([{ questionId: "q1", optionId: "a" }, { questionId: "q2", text: " \u0007 " }])).toThrow(/picks an option/);
    expect(() => answer(answers, "nobody")).toThrow(/invalid/);
    const done = answer([{ questionId: "q2", text: "Use ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8\u0007 please" }, { questionId: "q1", optionId: "b" }]);
    expect(done).toMatchObject({ stage: "PLAN", state: "READY", designReview: { status: "resolving" } });
    const stored = done.designReview!.rounds[0]!.answers!;
    expect(stored.by).toEqual({ actorId: PERSON });
    expect(stored.answers.map((entry) => entry.questionId)).toEqual(["q1", "q2"]);
    expect(JSON.stringify(stored)).not.toContain("ghp_A1b2");
    expect(stored.answers[1]!.text).not.toContain(String.fromCharCode(7));
  });

  it("refuses an answer when nothing was asked, and a second answer", () => {
    const first = answered();
    expect(() => answerDesignQuestions(first, { expectedRevision: first.revision, answers, by: { actorId: PERSON }, now: LATER })).toThrow(/not at that step/);
    const none = asking();
    expect(() => answerDesignQuestions(none, { expectedRevision: none.revision, answers, by: { actorId: PERSON }, now: LATER })).toThrow(/not at that step/);
  });

  it("resolves an asked finding only after its question was answered, naming a question of the round", () => {
    const unanswered = asking();
    expect(() => resolve(running(unanswered), [askedResolution, fixed("f2")], artifact("design", 2))).toThrow(/answered/);
    const ready = running(answered());
    expect(() => resolve(ready, [{ ...askedResolution, questionId: "q3" }, fixed("f2")], artifact("design", 2))).toThrow(/question of this round/);
    expect(() => resolve(ready, [{ findingId: "f1", action: "fixed", questionId: "q1", note: "n", settled: false }, fixed("f2")], artifact("design", 2))).toThrow(/only an asked/);
    const next = resolve(ready, [askedResolution, fixed("f2")], artifact("design", 2));
    expect(next).toMatchObject({ stage: "PLAN_CRITIQUE", state: "READY", designReview: { status: "estimating" } });
    expect(next.designReview!.rounds[0]!.resolutions.map((resolution) => resolution.settled)).toEqual([true, false]);
  });

  it("no answer, no approval: the review can't be ended while it waits for the person", () => {
    const waiting = asked();
    expect(() => closeDesignReview(waiting, { expectedRevision: waiting.revision, outcome: "finished", now: LATER })).toThrow(/can end/);
    expect(() => closeDesignReview(waiting, { expectedRevision: waiting.revision, outcome: "not_run", notRunReason: "timeout", now: LATER })).toThrow(/can end/);
    expect(waiting.decisions).toHaveLength(1);
    expect(waiting.outcome).toBeUndefined();
  });
});

describe("settled findings across rounds", () => {
  it("a contested finding stays settled when round 2 raises it again, and the planner is not asked about it again", () => {
    const round1 = submitRound(started(designSubmitted()), [finding("f1", "blocker", "Retries have no limit."), finding("f2", "major", "Naming is unclear.")]);
    const resolved = resolve(planner(round1), [contested("f1"), fixed("f2")], artifact("design", 2));
    const round2 = submitRound(started(resolved), [{ ...finding("g1", "blocker", "retries have NO limit"), fingerprint: hex(42) }, finding("g2", "major", "A new gap in the schema.", ["critic"], "§4")]);
    const stored = round2.designReview!.rounds[1]!;
    expect(stored.resolutions).toEqual([expect.objectContaining({ findingId: "g1", action: "contested", settled: true, evidence })]);
    expect(round2).toMatchObject({ stage: "PLAN", state: "READY", designReview: { status: "resolving" } });
    expect(() => resolve(planner(round2), [contested("g1"), contested("g2")])).toThrow(/every open finding/);
    const final = resolve(planner(round2), [contested("g2")]);
    expect(final).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "done" } });
    expect(designReviewDisagreements(final.designReview).map((entry) => [entry.findingId, entry.kind, entry.raisedAgain])).toEqual([["g1", "contested", true]]);
  });

  it("when every finding of round 2 is already settled, nobody is asked and the review is done", () => {
    const round1 = submitRound(started(designSubmitted()), [finding("f1", "blocker", "Retries have no limit."), finding("f2", "major", "Naming is unclear.")]);
    const resolved = resolve(planner(round1), [contested("f1"), fixed("f2")], artifact("design", 2));
    const round2 = submitRound(started(resolved), [finding("g1", "blocker", "Retries have no limit.")]);
    expect(round2).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "done" } });
  });

  it("a declined nit stays settled too; a fixed finding that comes back does not", () => {
    const round1 = submitRound(started(designSubmitted()), [finding("f1", "nit", "Typo."), finding("f2", "blocker", "Retries have no limit.")]);
    const resolved = resolve(planner(round1), [{ findingId: "f1", action: "declined", note: "Cosmetic.", settled: true }, fixed("f2")], artifact("design", 2));
    const round2 = submitRound(started(resolved), [finding("g1", "nit", "typo"), finding("g2", "blocker", "Retries have no limit.")]);
    expect(round2.designReview!.rounds[1]!.resolutions.map((resolution) => [resolution.findingId, resolution.action])).toEqual([["g1", "declined"]]);
    const final = resolve(planner(round2), [fixed("g2")], artifact("design", 3));
    expect(designReviewDisagreements(final.designReview)).toEqual([{ round: 2, findingId: "g2", severity: "blocker", kind: "unchecked_fix", raisedAgain: true }]);
  });
});

describe("the last round and the bounds", () => {
  it("the second resolution is fix or contest only, and ends at the person with no third round", () => {
    const round2 = planner(submitRound(started(atRound2()), [finding("g1", "major", "Another gap.", ["critic"], "§4"), finding("g2", "nit", "Style.", ["critic"], "§1")]));
    expect(() => resolve(round2, [contested("g1"), { findingId: "g2", action: "declined", note: "n", settled: true }])).toThrow(/fixed or contested only/);
    const final = resolve(round2, [fixed("g1"), contested("g2")], artifact("design", 3));
    expect(final).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "done" } });
    expect(final.designReview!.rounds).toHaveLength(DESIGN_REVIEW_ROUNDS_MAX);
    expect(designReviewRevisionsUsed(final.designReview!)).toBe(2);
    expect(designReviewDisagreements(final.designReview)).toEqual([{ round: 2, findingId: "g1", severity: "major", kind: "unchecked_fix", raisedAgain: false }]);
    expect(() => submitRound(final, [])).toThrow(/not at that step/);
    expect(() => startDesignReview(final, { expectedRevision: final.revision, estimateUsd: 1, now: NOW })).toThrow(/not at that step/);
    expect(final.decisions).toHaveLength(1);
  });

  it("an unresolved blocker of the last round, with nothing from the planner, is a disagreement", () => {
    const round2 = planner(submitRound(started(atRound2()), [finding("g1", "blocker", "Another gap.", ["critic"], "§4")]));
    const failed = closeDesignReview(round2, { expectedRevision: round2.revision, outcome: "finished", now: LATER });
    expect(failed).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "done" } });
    expect(designReviewDisagreements(failed.designReview)).toEqual([{ round: 2, findingId: "g1", severity: "blocker", kind: "unresolved", raisedAgain: false }]);
  });
});

describe("the oscillation stop", () => {
  it("a round 2 finding that would undo an earlier fix ends the loop: no more revisions, the person decides", () => {
    const round2 = submitRound(started(atRound2()), [finding("g1", "blocker", "Remove the retry limit.", ["critic"], "§3"), finding("g2", "major", "Add an index.", ["critic"], "§4")], { undoesEarlierFix: [{ findingId: "g1", earlierFindingId: "f1" }] });
    expect(round2).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "done" } });
    expect(round2.designReview!.rounds[1]!.oscillation).toEqual(["g1"]);
    expect(designReviewDisagreements(round2.designReview).map((entry) => [entry.findingId, entry.kind])).toEqual([["g1", "oscillation"], ["g2", "unresolved"]]);
    expect(round2.decisions).toHaveLength(1);
  });

  it("can't be claimed in round 1, or for a finding that isn't there", () => {
    expect(() => submitRound(started(designSubmitted()), [finding("f1", "blocker", "x")], { undoesEarlierFix: [{ findingId: "f1", earlierFindingId: "f1" }] })).toThrow(/later round/);
    expect(() => submitRound(started(atRound2()), [finding("g1", "blocker", "x")], { undoesEarlierFix: [{ findingId: "zzz", earlierFindingId: "f1" }] })).toThrow(/later round/);
  });
});

describe("closeDesignReview", () => {
  it("not run: with no round the review is not_run with its reason; with a round it stays done and says the later round did not run", () => {
    const ready = designSubmitted();
    expect(closeDesignReview(ready, { expectedRevision: ready.revision, outcome: "not_run", notRunReason: "no_model_source", now: LATER })).toMatchObject({
      stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "not_run", notRunReason: "no_model_source" },
    });
    const held = holdDesignReviewForCost(ready, { expectedRevision: ready.revision, estimateUsd: 40, now: NOW });
    expect(closeDesignReview(held, { expectedRevision: held.revision, outcome: "not_run", notRunReason: "cost_declined", now: LATER }).designReview).toMatchObject({ status: "not_run", notRunReason: "cost_declined" });
    const later = atRound2();
    expect(closeDesignReview(later, { expectedRevision: later.revision, outcome: "not_run", notRunReason: "no_verified_model", now: LATER }).designReview).toMatchObject({ status: "done", notRunReason: "no_verified_model" });
  });

  it("every not-run reason is a fixed code, and only a not-run end carries one", () => {
    const ready = designSubmitted();
    const close = (extra: Record<string, unknown>) => closeDesignReview(ready, { expectedRevision: ready.revision, now: LATER, ...extra } as never);
    expect(() => close({ outcome: "not_run" })).toThrow(/says why/);
    expect(() => close({ outcome: "not_run", notRunReason: "because" })).toThrow(/says why/);
    expect(() => close({ outcome: "stopped_at_cap", notRunReason: "timeout" })).toThrow(/says why/);
    for (const reason of ["no_model_source", "no_verified_model", "cost_declined", "timeout", "worker_failed", "inputs_unverified"]) {
      expect(close({ outcome: "not_run", notRunReason: reason }).designReview!.notRunReason).toBe(reason);
    }
  });

  it("a review with no round did not finish; the cost cap can stop it before the first round", () => {
    const ready = designSubmitted();
    expect(() => closeDesignReview(ready, { expectedRevision: ready.revision, outcome: "finished", now: LATER })).toThrow();
    expect(closeDesignReview(ready, { expectedRevision: ready.revision, outcome: "stopped_at_cap", now: LATER })).toMatchObject({ stage: "PLAN_REVIEW", designReview: { status: "stopped_at_cap" } });
  });

  it("the planner's failed revision sends the design as reviewed, findings unresolved", () => {
    const resolving = planner(submitRound(started(designSubmitted()), [finding("f1", "blocker", "x")]));
    const next = closeDesignReview(resolving, { expectedRevision: resolving.revision, outcome: "finished", now: LATER });
    expect(next).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "done" } });
    expect(designReviewDisagreements(next.designReview).map((entry) => entry.kind)).toEqual(["unresolved"]);
  });

  it("refuses at the wrong stage, from a workflow with no review, and at a stale revision", () => {
    const ready = designSubmitted();
    expect(() => closeDesignReview(ready, { expectedRevision: ready.revision - 1, outcome: "stopped_at_cap", now: LATER })).toThrow(/stale/);
    expect(() => closeDesignReview(planReady(), { expectedRevision: 1, outcome: "stopped_at_cap", now: LATER })).toThrow(/can end/);
    const closed = closeDesignReview(ready, { expectedRevision: ready.revision, outcome: "stopped_at_cap", now: LATER });
    expect(() => closeDesignReview(closed, { expectedRevision: closed.revision, outcome: "stopped_at_cap", now: LATER })).toThrow(/can end/);
    const awaiting = on(planReady());
    expect(() => closeDesignReview(awaiting, { expectedRevision: awaiting.revision, outcome: "stopped_at_cap", now: LATER })).toThrow(/can end/);
  });
});

describe("the person's decision", () => {
  const closedAfterReview = (): WorkflowSnapshot => resolve(planner(submitRound(started(designSubmitted()), [finding("f1", "blocker", "a")])), [contested("f1")]);

  it("approving the design goes on to the coding plan and keeps the review for the record; open blockers don't stop it", () => {
    const waiting = closedAfterReview();
    const next = decide(waiting, "APPROVE", designOf(waiting), "33333333-3333-4333-8333-333333333333");
    expect(next).toMatchObject({ stage: "PLAN", state: "READY", reviewPhase: "IMPLEMENTATION_PLAN", designReview: { status: "done" } });
    expect(next.decisions).toHaveLength(2);
  });

  it("nothing in the review moved the workflow past PLAN_REVIEW: only decideWorkflow did", () => {
    for (const workflow of [closedAfterReview(), submitRound(started(designSubmitted()), []), closeDesignReview(designSubmitted(), { expectedRevision: designSubmitted().revision, outcome: "not_run", notRunReason: "timeout", now: LATER })]) {
      expect(workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
      expect(workflow.outcome).toBeUndefined();
      expect(workflow.decisions).toHaveLength(1);
    }
  });

  it("asking for changes to the design reviews the new design afresh, with the earlier spend still counted", () => {
    const waiting = closedAfterReview();
    const back = decide(waiting, "REQUEST_CHANGES", designOf(waiting), "33333333-3333-4333-8333-333333333333");
    expect(back).toMatchObject({ stage: "PLAN", state: "READY", reviewPhase: "DESIGN", designReview: { status: "estimating", rounds: [], spentUsd: 0.2 } });
    const again = submitWorkflowArtifact(running(back), { expectedRevision: back.revision + 1, artifact: artifact("design", 5), now: NOW });
    expect(again).toMatchObject({ stage: "PLAN_CRITIQUE", state: "READY", designReview: { status: "estimating", rounds: [] } });
  });
});

// ---- DR6 fix round (Opus review of DR6): B1, B2, M1-M4, the waiting-for-answers transitions and the minors.

const ACTOR = { actorId: "d".repeat(64) };
const after = (ms: number): string => new Date(Date.parse(LATER) + ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const resubmit = (back: WorkflowSnapshot, version: number): WorkflowSnapshot => submitWorkflowArtifact(running(back), { expectedRevision: back.revision + 1, artifact: artifact("design", version), now: NOW });
const declinedNit = (findingId: string) => ({ findingId, action: "declined", note: "Cosmetic.", settled: true });
const withComprehension = [reviewerRun("comprehension"), reviewerRun("critic"), reviewerRun("codebase")];

describe("B1: a settled resolution carries over only to a finding it may settle", () => {
  /** Round 1: blocker f1 fixed (so there is a round 2), and `settled` resolved as given. */
  const afterRound1 = (extra: unknown[], resolutions: unknown[], reviewers: unknown[] = withComprehension): WorkflowSnapshot => {
    const round1 = submitRound(started(designSubmitted()), [finding("f1", "blocker", "Retries have no limit."), ...extra], {}, reviewers);
    return resolve(planner(round1), [fixed("f1"), ...resolutions], artifact("design", 2));
  };

  it("a declined nit does not settle a blocker with the same words: the blocker is open and reaches the approver", () => {
    const resolved = afterRound1([finding("n1", "nit", "Queue name is unclear.")], [declinedNit("n1")]);
    const round2 = submitRound(started(resolved), [finding("g1", "blocker", "Queue name is unclear!")]);
    expect(round2).toMatchObject({ stage: "PLAN", state: "READY", designReview: { status: "resolving" } });
    expect(round2.designReview!.rounds[1]!.resolutions).toEqual([]);
    const ended = closeDesignReview(planner(round2), { expectedRevision: planner(round2).revision, outcome: "finished", now: LATER });
    expect(designReviewDisagreements(ended.designReview)).toEqual([{ round: 2, findingId: "g1", severity: "blocker", kind: "unresolved", raisedAgain: true }]);
  });

  it("the planner must answer that blocker in the last round: fixed or contested", () => {
    const resolved = afterRound1([finding("n1", "nit", "Queue name is unclear.")], [declinedNit("n1")]);
    const round2 = planner(submitRound(started(resolved), [finding("g1", "blocker", "Queue name is unclear!")]));
    const final = resolve(round2, [contested("g1")]);
    expect(designReviewDisagreements(final.designReview)).toEqual([{ round: 2, findingId: "g1", severity: "blocker", kind: "contested", raisedAgain: true }]);
  });

  it("a contest does not settle a comprehension finding that comes back", () => {
    const resolved = afterRound1([finding("f2", "major", "The cache holds what?", ["critic"])], [contested("f2")]);
    const round2 = submitRound(started(resolved), [finding("g1", "major", "The cache holds what", ["comprehension"])], {}, withComprehension);
    expect(round2).toMatchObject({ stage: "PLAN", designReview: { status: "resolving" } });
    expect(round2.designReview!.rounds[1]!.resolutions).toEqual([]);
    expect(() => resolve(planner(round2), [contested("g1")])).toThrow(/not understood/);
  });

  it("a contested major does not settle the same words as a blocker", () => {
    const resolved = afterRound1([finding("f2", "major", "Naming is unclear.")], [contested("f2")]);
    const round2 = submitRound(started(resolved), [finding("g1", "blocker", "Naming is unclear.")]);
    expect(round2.designReview!.rounds[1]!.resolutions).toEqual([]);
    expect(round2.designReview!.status).toBe("resolving");
  });

  it("a settled blocker still carries over as a lesser finding, and as the same severity (no over-restriction)", () => {
    const resolved = afterRound1([finding("f2", "blocker", "Naming is unclear.")], [contested("f2")]);
    const round2 = submitRound(started(resolved), [finding("g1", "major", "Naming is unclear."), finding("g2", "blocker", "Retries have no limit.")]);
    expect(round2.designReview!.rounds[1]!.resolutions.map((resolution) => [resolution.findingId, resolution.action])).toEqual([["g1", "contested"]]);
    const same = submitRound(started(resolved), [finding("g1", "blocker", "Naming is unclear.")]);
    expect(same).toMatchObject({ stage: "PLAN_REVIEW", designReview: { status: "done" } });
  });
});

describe("B2: the cost cap is enforced in the contract", () => {
  it("is stored when the review is switched on, within the setting's limits", () => {
    expect(on(planReady(), { capUsd: 4 }).designReview).toMatchObject({ capUsd: 4 });
    expect(() => on(planReady(), { capUsd: undefined as never })).toThrow(/invalid/);
    expect(() => on(planReady(), { capUsd: 0.1 })).toThrow(/invalid/);
    expect(() => on(planReady(), { capUsd: 1000 })).toThrow(/invalid/);
  });

  it("refuses to start a round whose estimate is over what is left under the cap, whoever asks", () => {
    const ready = designSubmitted({ capUsd: 2 });
    expect(() => started(ready, { estimateUsd: 2.5 })).toThrow(/over the cost cap/);
    expect(started(ready, { estimateUsd: 2 }).designReview).toMatchObject({ status: "running", capUsd: 2 });
    expect(designReviewCapRoom(ready.designReview!, 2.5)).toMatchObject({ kind: "over_cap" });
    // a spend approval does not lift the cap
    expect(() => startDesignReview(ready, { expectedRevision: ready.revision, estimateUsd: 2.5, costApproved: APPROVED, now: NOW })).toThrow(/over the cost cap/);
  });

  it("counts the spend so far: round 2 must fit in what round 1 left, and a review at its cap starts nothing", () => {
    const dear = [reviewerRun("critic", { costUsd: 0.5 }), reviewerRun("codebase", { costUsd: 0.5 })];
    const round1 = submitRound(started(designSubmitted({ capUsd: 3 })), [finding("f1", "blocker", "Retries have no limit.")], {}, dear);
    const revised = resolve(planner(round1), [fixed("f1")], artifact("design", 2));
    expect(() => started(revised, { estimateUsd: 2.5 })).toThrow(/over the cost cap/);
    expect(started(revised, { estimateUsd: 2 }).state).toBe("RUNNING");
    const full = { ...revised, designReview: { ...revised.designReview!, spentUsd: 3 } };
    expect(() => started(full, { estimateUsd: 0 })).toThrow(/at its cost cap/);
  });

  it("with no price, a person's one tap is needed, is recorded with who, and the cap still holds", () => {
    const ready = designSubmitted();
    expect(() => startDesignReview(ready, { expectedRevision: ready.revision, now: NOW })).toThrow(/no price/);
    const next = startDesignReview(ready, { expectedRevision: ready.revision, costApproved: { by: ACTOR, approvedUsd: 4 }, now: NOW });
    expect(next.designReview!.approvals).toEqual([{ kind: "spend", by: ACTOR, at: NOW, approvedUsd: 4 }]);
    expect(designReviewCapRoom(ready.designReview!)).toMatchObject({ kind: "no_price" });
    expect(() => startDesignReview(ready, { expectedRevision: ready.revision, costApproved: { by: { actorId: "" } }, now: NOW })).toThrow(/person is invalid/);
    expect(() => startDesignReview(ready, { expectedRevision: ready.revision, estimateUsd: 5, costApproved: { by: ACTOR, approvedUsd: 1 }, now: NOW })).toThrow(/less than the estimate/);
  });

  it("the cost hold: an over-cap estimate is released only by raising the cap or lowering the tier, each recorded", () => {
    const ready = designSubmitted();
    const held = holdDesignReviewForCost(ready, { expectedRevision: ready.revision, estimateUsd: 12, now: NOW });
    expect(() => startDesignReview(held, { expectedRevision: held.revision, costApproved: APPROVED, now: NOW })).toThrow(/over the cost cap/);
    expect(() => raiseDesignReviewCap(held, { expectedRevision: held.revision, capUsd: 10, by: ACTOR, now: LATER })).toThrow(/higher/);
    const raised = raiseDesignReviewCap(held, { expectedRevision: held.revision, capUsd: 15, by: ACTOR, now: LATER });
    expect(raised).toMatchObject({ stage: "PLAN_CRITIQUE", state: "READY", designReview: { status: "estimating", capUsd: 15, approvals: [{ kind: "raise_cap", by: ACTOR, at: LATER, fromUsd: 10, capUsd: 15 }] } });
    expect(started(raised, { estimateUsd: 12 }).state).toBe("RUNNING");
    expect(() => lowerDesignReviewTier(held, { expectedRevision: held.revision, tier: "thorough", by: ACTOR, now: LATER })).toThrow(/lower/);
    const lowered = lowerDesignReviewTier(held, { expectedRevision: held.revision, tier: "light", by: ACTOR, estimateUsd: 4, now: LATER });
    expect(lowered.designReview).toMatchObject({ tier: "light", status: "estimating", estimateUsd: 4, approvals: [{ kind: "lower_tier", by: ACTOR, from: "standard", tier: "light" }] });
    expect(started(lowered).state).toBe("RUNNING");
    expect(() => raiseDesignReviewCap(ready, { expectedRevision: ready.revision, capUsd: 20, by: ACTOR, now: LATER })).toThrow(/cannot be run again/);
  });

  it("spend only goes up: a negative amount is refused, and no step lowers the total", () => {
    const live = started(designSubmitted());
    expect(() => retryDesignReview(live, { expectedRevision: live.revision, addedSpendUsd: -0.1, now: NOW })).toThrow(/invalid/);
    const round1 = submitRound(live, [finding("f1", "blocker", "x")]);
    const steps: WorkflowSnapshot[] = [live, round1, closeDesignReview(planner(round1), { expectedRevision: planner(round1).revision, outcome: "finished", addedSpendUsd: 0.05, now: LATER })];
    const totals = steps.map((step) => step.designReview!.spentUsd);
    expect(totals).toEqual([...totals].sort((a, b) => a - b));
    expect(totals.at(-1)).toBeCloseTo(0.25);
  });

  it("a cost stop survives a person's REQUEST_CHANGES: the design goes unreviewed until the cap is raised, and who raised it is recorded", () => {
    const dear = [reviewerRun("critic", { costUsd: 0.3 }), reviewerRun("codebase", { costUsd: 0.3 })];
    const stopped = submitRound(started(designSubmitted({ capUsd: 0.5 }), { estimateUsd: 0.1 }), [finding("f1", "blocker", "x")], {}, dear);
    expect(stopped.designReview).toMatchObject({ status: "stopped_at_cap", spentUsd: 0.6 });
    const back = decide(stopped, "REQUEST_CHANGES", designOf(stopped), uuid(1));
    expect(back.designReview).toMatchObject({ status: "stopped_at_cap", spentUsd: 0.6, rounds: [], capUsd: 0.5 });
    const next = resubmit(back, 5);
    expect(next).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "stopped_at_cap", spentUsd: 0.6 } });
    expect(() => startDesignReview(next, { expectedRevision: next.revision, estimateUsd: 0.1, now: NOW })).toThrow();
    const raised = raiseDesignReviewCap(next, { expectedRevision: next.revision, capUsd: 5, by: ACTOR, now: LATER });
    expect(raised).toMatchObject({ stage: "PLAN_CRITIQUE", state: "READY", designReview: { status: "estimating", capUsd: 5, spentUsd: 0.6, approvals: [expect.objectContaining({ kind: "raise_cap", by: ACTOR })] } });
    expect(started(raised, { estimateUsd: 1 }).state).toBe("RUNNING");
  });

  it("a cost stop that is re-armed while the planner redraws can be opened from PLAN/READY too", () => {
    const dear = [reviewerRun("critic", { costUsd: 0.3 }), reviewerRun("codebase", { costUsd: 0.3 })];
    const stopped = submitRound(started(designSubmitted({ capUsd: 0.5 }), { estimateUsd: 0.1 }), [finding("f1", "blocker", "x")], {}, dear);
    const back = decide(stopped, "REQUEST_CHANGES", designOf(stopped), uuid(1));
    const raised = raiseDesignReviewCap(back, { expectedRevision: back.revision, capUsd: 5, by: ACTOR, now: LATER });
    expect(raised).toMatchObject({ stage: "PLAN", state: "READY", designReview: { status: "estimating", rounds: [] } });
    expect(resubmit(raised, 5)).toMatchObject({ stage: "PLAN_CRITIQUE", state: "READY" });
  });
});

describe("re-arming on REQUEST_CHANGES keeps the evidence and the spend, and is bounded", () => {
  const twoRounds = (): WorkflowSnapshot => {
    const round1 = submitRound(started(designSubmitted()), [finding("f1", "blocker", "Retries have no limit.")]);
    const revised = resolve(planner(round1), [fixed("f1")], artifact("design", 2));
    return resolve(planner(submitRound(started(revised), [finding("g1", "nit", "Typo.")])), [contested("g1")]);
  };

  it("archives the paid rounds (reviewers, costs, findings and what was done), keeps the spend, and says who sent it back", () => {
    const waiting = twoRounds();
    const back = decide(waiting, "REQUEST_CHANGES", designOf(waiting), uuid(2));
    const review = back.designReview!;
    expect(review).toMatchObject({ status: "estimating", rounds: [], spentUsd: waiting.designReview!.spentUsd, rearms: 1 });
    expect(review.earlierReviews).toHaveLength(1);
    const earlier = review.earlierReviews![0]!;
    expect(earlier).toMatchObject({ sentBackBy: { actorId: OWNER }, spentUsd: waiting.designReview!.spentUsd });
    expect(earlier.rounds.map((round) => round.round)).toEqual([1, 2]);
    expect(earlier.rounds[0]!.reviewers.map((run) => [run.role, run.costUsd, run.sessionId])).toEqual([["critic", 0.1, "ses_critic"], ["codebase", 0.1, "ses_codebase"]]);
    expect(earlier.rounds[0]!.findings).toEqual([expect.objectContaining({ id: "f1", severity: "blocker", action: "fixed", settled: false })]);
    expect(earlier.rounds.flatMap((round) => round.reviewers).reduce((sum, run) => sum + run.costUsd, 0)).toBeCloseTo(0.4);
    // a citation, a packet and the files read are not kept
    expect(JSON.stringify(earlier)).not.toContain("filesRead");
    expect(JSON.stringify(earlier)).not.toContain("citations");
  });

  it("after the allowed re-reviews, a person must raise the cap or lower the tier; then it reviews again", () => {
    let workflow = designSubmitted();
    let version = 1;
    const reviewClean = (ready: WorkflowSnapshot): WorkflowSnapshot => submitRound(started(ready), []);
    for (let n = 1; n <= DESIGN_REVIEW_REARMS_MAX; n += 1) {
      workflow = reviewClean(workflow.stage === "PLAN_CRITIQUE" ? workflow : resubmit(workflow, version += 1));
      workflow = decide(workflow, "REQUEST_CHANGES", designOf(workflow), uuid(10 + n));
      expect(workflow.designReview).toMatchObject({ status: "estimating", rearms: n });
    }
    workflow = reviewClean(resubmit(workflow, version += 1));
    const last = decide(workflow, "REQUEST_CHANGES", designOf(workflow), uuid(20));
    expect(last.designReview).toMatchObject({ status: "not_run", notRunReason: "rearm_limit", spentUsd: workflow.designReview!.spentUsd });
    const unreviewed = resubmit(last, version + 1);
    expect(unreviewed).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "not_run", notRunReason: "rearm_limit" } });
    expect(() => retryDesignReviewNotRun(unreviewed, { expectedRevision: unreviewed.revision, by: ACTOR, now: LATER })).toThrow(/only a design review that did not run/);
    const lowered = lowerDesignReviewTier(unreviewed, { expectedRevision: unreviewed.revision, tier: "light", by: ACTOR, now: LATER });
    expect(lowered).toMatchObject({ stage: "PLAN_CRITIQUE", state: "READY", designReview: { status: "estimating", rearms: 0, tier: "light" } });
    expect(lowered.designReview!.earlierReviews!.length).toBe(DESIGN_REVIEW_REARMS_MAX + 1);
  });

  it("the archive is bounded in count and in bytes", () => {
    const waiting = twoRounds();
    let review = waiting.designReview!;
    for (let n = 0; n < DESIGN_REVIEW_EARLIER_MAX + 3; n += 1) review = { ...rearmedDesignReview(review, { at: LATER, by: ACTOR }), rounds: waiting.designReview!.rounds };
    expect(review.earlierReviews!.length).toBe(DESIGN_REVIEW_EARLIER_MAX);
    const bulky = { ...waiting.designReview!, rounds: waiting.designReview!.rounds.map((round) => ({
      ...round, findings: Array.from({ length: 30 }, (_, index) => ({ ...finding(`b${index}`, "major", `${"w".repeat(480)}${index}`), fingerprint: hex(500 + index) })), resolutions: [],
    })) } as unknown as NonNullable<WorkflowSnapshot["designReview"]>;
    let heavy = bulky;
    for (let n = 0; n < 4; n += 1) heavy = { ...rearmedDesignReview(heavy, { at: LATER, by: ACTOR }), rounds: bulky.rounds };
    expect(new TextEncoder().encode(JSON.stringify(heavy.earlierReviews)).length).toBeLessThanOrEqual(DESIGN_REVIEW_EARLIER_MAX_BYTES);
    expect(WorkflowSnapshotSchema.safeParse({ ...waiting, designReview: heavy }).success).toBe(true);
  });

  it("re-arms only a review that was asked for (auto, always, person), never a skipped one", () => {
    const review = twoRounds().designReview!;
    expect(rearmedDesignReview({ ...review, decidedBy: "person_skip" }, { at: LATER, by: ACTOR })).toEqual({ ...review, decidedBy: "person_skip" });
    expect(rearmedDesignReview({ ...review, decidedBy: "never" }, { at: LATER, by: ACTOR }).rounds).toHaveLength(2);
    expect(rearmedDesignReview({ ...review, decidedBy: "person" }, { at: LATER, by: ACTOR }).status).toBe("estimating");
  });
});

describe("M1: BLOCKED in the design phase has a way out", () => {
  it("a blocked plan-check step can end at the person, or be resumed like the plan check's Retry", () => {
    const live = started(designSubmitted());
    const blocked = blockWorkflow(live, "The rule files could not be verified.", LATER);
    expect(blocked).toMatchObject({ stage: "PLAN_CRITIQUE", state: "BLOCKED", designReview: { status: "running" } });
    const closed = closeDesignReview(blocked, { expectedRevision: blocked.revision, outcome: "not_run", notRunReason: "worker_failed", addedSpendUsd: 0.2, now: LATER });
    expect(closed).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "not_run", spentUsd: 0.2 } });
    expect(closed.blockReason).toBeUndefined();
    const resumed = resumeBlockedDesignReview(blocked, { expectedRevision: blocked.revision, now: LATER });
    expect(resumed).toMatchObject({ stage: "PLAN_CRITIQUE", state: "READY", designReview: { status: "estimating" } });
    expect(resumed.blockReason).toBeUndefined();
    expect(started(resumed).state).toBe("RUNNING");
  });

  it("a blocked planner step resumes to resolving, and one that waited for answers goes back to waiting (and still can't be ended)", () => {
    const resolving = planner(submitRound(started(designSubmitted()), [finding("f1", "blocker", "Which queue do we use?")]));
    const blocked = blockWorkflow(resolving, "The planner ran out of budget.", LATER);
    expect(resumeBlockedDesignReview(blocked, { expectedRevision: blocked.revision, now: LATER })).toMatchObject({ stage: "PLAN", state: "READY", designReview: { status: "resolving" } });
    expect(closeDesignReview(blocked, { expectedRevision: blocked.revision, outcome: "finished", now: LATER })).toMatchObject({ stage: "PLAN_REVIEW", designReview: { status: "done" } });
    const asked = askDesignQuestions(resolving, { expectedRevision: resolving.revision, questions: [question("q1")], now: LATER });
    const stuck = blockWorkflow(asked, "x", LATER);
    expect(resumeBlockedDesignReview(stuck, { expectedRevision: stuck.revision, now: LATER })).toMatchObject({ stage: "PLAN", state: "WAITING", designReview: { status: "waiting_answers" } });
    expect(() => closeDesignReview(stuck, { expectedRevision: stuck.revision, outcome: "finished", now: LATER })).toThrow(/can end/);
  });

  it("refuses to resume a review that is not blocked", () => {
    const live = started(designSubmitted());
    expect(() => resumeBlockedDesignReview(live, { expectedRevision: live.revision, now: LATER })).toThrow(/not blocked/);
  });
});

describe("M2: Retry review after a review that did not run", () => {
  const notRun = (): WorkflowSnapshot => submitRound(started(designSubmitted()), [], {}, [failedRun("critic", "timeout"), failedRun("codebase", "timeout")]);

  it("goes back to the same design, keeps the spend, runs under the cap check, and is bounded", () => {
    let workflow = notRun();
    expect(workflow.designReview).toMatchObject({ status: "not_run", spentUsd: 0.2 });
    const first = retryDesignReviewNotRun(workflow, { expectedRevision: workflow.revision, by: ACTOR, now: LATER });
    expect(first).toMatchObject({ stage: "PLAN_CRITIQUE", state: "READY", designReview: { status: "estimating", spentUsd: 0.2, retries: 1, rounds: [] } });
    expect(designOf(first)).toBe(designOf(workflow));
    expect(first.decisions).toHaveLength(1);
    expect(() => started(first, { estimateUsd: 50 })).toThrow(/over the cost cap/);
    for (let n = 2; n <= 2; n += 1) {
      workflow = submitRound(started(first), [], {}, [failedRun("critic", "timeout")]);
      const again = retryDesignReviewNotRun(workflow, { expectedRevision: workflow.revision, by: ACTOR, now: LATER });
      expect(again.designReview!.retries).toBe(n);
      workflow = submitRound(started(again), [], {}, [failedRun("critic", "timeout")]);
    }
    expect(() => retryDesignReviewNotRun(workflow, { expectedRevision: workflow.revision, by: ACTOR, now: LATER })).toThrow(/retried as often/);
    const raised = raiseDesignReviewCap(workflow, { expectedRevision: workflow.revision, capUsd: 20, by: ACTOR, now: LATER });
    expect(raised.designReview).toMatchObject({ retries: 0, status: "estimating" });
  });

  it("works for a later round that did not run, keeping round 1, and refuses a review that finished or stopped at the cap", () => {
    const round2 = submitRound(started(atRound2()), [], {}, [failedRun("critic", "timeout")]);
    expect(round2.designReview).toMatchObject({ status: "done", notRunReason: "timeout" });
    const retried = retryDesignReviewNotRun(round2, { expectedRevision: round2.revision, by: ACTOR, now: LATER });
    expect(retried.designReview!.rounds.map((round) => round.round)).toEqual([1]);
    expect(started(retried, { estimateUsd: 1 }).state).toBe("RUNNING");
    const finished = submitRound(started(designSubmitted()), []);
    expect(() => retryDesignReviewNotRun(finished, { expectedRevision: finished.revision, by: ACTOR, now: LATER })).toThrow(/did not run/);
    const stopped = closeDesignReview(designSubmitted(), { expectedRevision: designSubmitted().revision, outcome: "stopped_at_cap", now: LATER });
    expect(() => retryDesignReviewNotRun(stopped, { expectedRevision: stopped.revision, by: ACTOR, now: LATER })).toThrow(/did not run/);
  });
});

describe("M3: Design first on a Quick plan's card", () => {
  const quickCard = (): WorkflowSnapshot => {
    const ready = planReady({ path: "QUICK" });
    const planned = submitWorkflowArtifact(running(ready), { expectedRevision: ready.revision + 1, artifact: artifact("plan"), now: NOW });
    return closePlanCritique(planned, { expectedRevision: planned.revision, status: "done", now: NOW });
  };

  it("moves a Quick task at its plan card to the Full path at the requirements, recorded as a person's choice, keeping the plan as history", () => {
    const card = quickCard();
    expect(card).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", path: "QUICK" });
    const next = enableDesignReview(card, { expectedRevision: card.revision, start: { ...START, decidedBy: "person", by: ACTOR }, now: LATER });
    expect(next).toMatchObject({ stage: "PLAN", state: "READY", path: "FULL", reviewPhase: "REQUIREMENTS", designReview: { decidedBy: "person", startedBy: ACTOR, fromQuick: true, status: "estimating", spentUsd: 0, capUsd: 10 } });
    expect(next.artifacts.map((entry) => entry.type)).toEqual(["plan"]);
    expect(next.critique).toBeUndefined();
    expect(next.decisions).toHaveLength(0);
    expect(next.outcome).toBeUndefined();
    const requirements = submitWorkflowArtifact(running(next), { expectedRevision: next.revision + 1, artifact: artifact("requirements"), now: NOW });
    expect(requirements).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", reviewPhase: "REQUIREMENTS" });
  });

  it("is a person's choice only: the setting or Understand can't do it from a card, a person must be named, and there is no design yet", () => {
    const card = quickCard();
    expect(() => enableDesignReview(card, { expectedRevision: card.revision, start: START, now: LATER })).toThrow(/person's choice/);
    expect(() => enableDesignReview(card, { expectedRevision: card.revision, start: { ...START, decidedBy: "person" }, now: LATER })).toThrow(/invalid/);
    const withDesign = { ...card, artifacts: [...card.artifacts, artifact("design")] };
    expect(() => enableDesignReview(withDesign, { expectedRevision: card.revision, start: { ...START, decidedBy: "person", by: ACTOR }, now: LATER })).toThrow(/before any design/);
  });
});

describe("Ruling 5: park, resume and close a wait for answers (3.7 / Q5)", () => {
  const asking = (): WorkflowSnapshot => planner(submitRound(started(designSubmitted()), [finding("f1", "blocker", "Which queue do we use?")]));
  const waiting = (): WorkflowSnapshot => askDesignQuestions(asking(), { expectedRevision: asking().revision, questions: [question("q1")], now: LATER });
  const answers = [{ questionId: "q1", optionId: "a" }];

  it("parks only after 7 days of waiting, changes no stage, and releases nothing it shouldn't: no decision, no outcome, no answer", () => {
    const wait = waiting();
    expect(wait.designReview!.waiting).toEqual({ since: LATER });
    expect(() => parkDesignReview(wait, { expectedRevision: wait.revision, now: after(7 * DAY - 1000) })).toThrow(/long enough/);
    const parked = parkDesignReview(wait, { expectedRevision: wait.revision, now: after(7 * DAY) });
    expect(parked).toMatchObject({ stage: "PLAN", state: "WAITING", designReview: { status: "waiting_answers", waiting: { since: LATER, parkedAt: after(7 * DAY) } } });
    expect(parked.decisions).toHaveLength(1);
    expect(parked.outcome).toBeUndefined();
    expect(parked.designReview!.rounds[0]!.answers).toBeUndefined();
    expect(() => parkDesignReview(parked, { expectedRevision: parked.revision, now: after(9 * DAY) })).toThrow(/already parked/);
    expect(() => parkDesignReview(asking(), { expectedRevision: asking().revision, now: after(8 * DAY) })).toThrow(/not at that step/);
  });

  it("an answer resumes a parked review: resolving again, the wait record gone", () => {
    const wait = waiting();
    const parked = parkDesignReview(wait, { expectedRevision: wait.revision, now: after(7 * DAY) });
    const answered = answerDesignQuestions(parked, { expectedRevision: parked.revision, answers, by: { actorId: PERSON }, now: after(8 * DAY) });
    expect(answered).toMatchObject({ stage: "PLAN", state: "READY", designReview: { status: "resolving" } });
    expect(answered.designReview!.waiting).toBeUndefined();
    expect(answered.designReview!.rounds[0]!.answers!.by).toEqual({ actorId: PERSON });
  });

  it("a person can resume a parked review without answering: it waits again and the 7 days start over, who resumed it is recorded", () => {
    const wait = waiting();
    const parked = parkDesignReview(wait, { expectedRevision: wait.revision, now: after(7 * DAY) });
    expect(() => resumeParkedDesignReview(wait, { expectedRevision: wait.revision, by: ACTOR, now: after(8 * DAY) })).toThrow(/not parked/);
    const resumed = resumeParkedDesignReview(parked, { expectedRevision: parked.revision, by: ACTOR, now: after(8 * DAY) });
    expect(resumed.designReview!.waiting).toEqual({ since: after(8 * DAY), resumedBy: ACTOR });
    expect(() => parkDesignReview(resumed, { expectedRevision: resumed.revision, now: after(10 * DAY) })).toThrow(/long enough/);
    expect(parkDesignReview(resumed, { expectedRevision: resumed.revision, now: after(15 * DAY) }).designReview!.waiting!.parkedAt).toBe(after(15 * DAY));
  });

  it("closes as not decided after 30 days parked: the task ends CLOSED, the design, findings and questions stay, nothing is approved or answered", () => {
    const wait = waiting();
    expect(() => closeParkedDesignReview(wait, { expectedRevision: wait.revision, now: after(60 * DAY) })).toThrow(/not parked/);
    const parked = parkDesignReview(wait, { expectedRevision: wait.revision, now: after(7 * DAY) });
    expect(() => closeParkedDesignReview(parked, { expectedRevision: parked.revision, now: after(7 * DAY + 30 * DAY - 1000) })).toThrow(/long enough/);
    const closed = closeParkedDesignReview(parked, { expectedRevision: parked.revision, now: after(37 * DAY) });
    expect(closed).toMatchObject({ stage: "CLOSED", state: "COMPLETE", outcome: "CLOSED", blockReason: "Closed: nobody decided the design." });
    expect(closed.decisions).toHaveLength(1);
    expect(closed.designReview!.rounds[0]!.questions).toHaveLength(1);
    expect(closed.designReview!.rounds[0]!.answers).toBeUndefined();
    expect(closed.designReview!.rounds[0]!.findings).toHaveLength(1);
    expect(closed.designReview!.waiting!.closedAt).toBe(after(37 * DAY));
    expect(WorkflowSnapshotSchema.safeParse(JSON.parse(JSON.stringify(closed))).success).toBe(true);
    expect(() => answerDesignQuestions(closed, { expectedRevision: closed.revision, answers, by: { actorId: PERSON }, now: after(38 * DAY) })).toThrow(/not at that step/);
  });

  it("closeDesignReview still refuses a parked wait: it is never ended into the approve card", () => {
    const wait = waiting();
    const parked = parkDesignReview(wait, { expectedRevision: wait.revision, now: after(7 * DAY) });
    expect(() => closeDesignReview(parked, { expectedRevision: parked.revision, outcome: "finished", now: after(8 * DAY) })).toThrow(/can end/);
  });
});

describe("minors", () => {
  it("m1: a killed round's spend is added by retry and close, never negative", () => {
    const live = started(designSubmitted());
    expect(retryDesignReview(live, { expectedRevision: live.revision, addedSpendUsd: 0.3, now: NOW }).designReview!.spentUsd).toBe(0.3);
    expect(closeDesignReview(live, { expectedRevision: live.revision, outcome: "stopped_at_cap", addedSpendUsd: 0.45, now: LATER }).designReview!.spentUsd).toBe(0.45);
    expect(() => closeDesignReview(live, { expectedRevision: live.revision, outcome: "stopped_at_cap", addedSpendUsd: Number.NaN, now: LATER })).toThrow(/invalid/);
  });

  it("m2: two findings of one round with the same fingerprint are refused", () => {
    const live = started(designSubmitted());
    expect(() => submitRound(live, [finding("f1", "major", "Retries have no limit."), finding("f2", "major", "retries have NO limit!")])).toThrow(/share a fingerprint/);
    expect(() => submitRound(live, [finding("f1", "major", "Retries have no limit."), { ...finding("f2", "major", "Retries have no limit."), section: "§4", citations: [{ kind: "design", section: "§4" }] }])).not.toThrow();
  });

  it("m3: an oscillation names a round-1 finding that was fixed; a contested or unknown one is refused, as is a bare id", () => {
    const round1 = submitRound(started(designSubmitted()), [finding("f1", "blocker", "Retries have no limit."), finding("f2", "major", "Naming is unclear.")]);
    const revised = resolve(planner(round1), [fixed("f1"), contested("f2")], artifact("design", 2));
    const round2 = (undoes: unknown) => submitRound(started(revised), [finding("g1", "blocker", "Remove the retry limit.")], { undoesEarlierFix: undoes });
    expect(round2([{ findingId: "g1", earlierFindingId: "f1" }]).designReview!.rounds[1]!.oscillation).toEqual(["g1"]);
    expect(() => round2([{ findingId: "g1", earlierFindingId: "f2" }])).toThrow(/fix must be one round 1 made/);
    expect(() => round2([{ findingId: "g1", earlierFindingId: "nope" }])).toThrow(/fix must be one round 1 made/);
    expect(() => round2(["g1"])).toThrow(/invalid/);
  });

  it("m4: an answered question needs no cosmetic edit, and round 2 runs only when the document changed", () => {
    const base = planner(submitRound(started(designSubmitted()), [finding("f1", "blocker", "Which queue do we use?")]));
    const waitingAnswers = askDesignQuestions(base, { expectedRevision: base.revision, questions: [question("q1")], now: LATER });
    const answered = running(answerDesignQuestions(waitingAnswers, { expectedRevision: waitingAnswers.revision, answers: [{ questionId: "q1", optionId: "a" }], by: { actorId: PERSON }, now: LATER }));
    const asked = { findingId: "f1", action: "asked", questionId: "q1", note: "Asked.", settled: true };
    const unchanged = resolve(answered, [asked]);
    expect(unchanged).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "done" } });
    expect(unchanged.artifacts).toHaveLength(answered.artifacts.length);
    const changed = resolve(answered, [asked], artifact("design", 2));
    expect(changed).toMatchObject({ stage: "PLAN_CRITIQUE", state: "READY", designReview: { status: "estimating" } });
    expect(() => resolve(answered, [asked], artifact("design", 1))).toThrow(/invalid/);
    expect(() => resolve(planner(submitRound(started(designSubmitted()), [finding("f1", "blocker", "a")])), [fixed("f1")])).toThrow(/changed design/);
  });

  it("m4b: round 2 is priced afresh: the estimate for both rounds is not reused", () => {
    const round1 = submitRound(started(designSubmitted(), { estimateUsd: 6 }), [finding("f1", "blocker", "Retries have no limit.")]);
    const revised = resolve(planner(round1), [fixed("f1")], artifact("design", 2));
    expect(revised.designReview!.estimateUsd).toBeUndefined();
    expect(() => startDesignReview(revised, { expectedRevision: revised.revision, now: NOW })).toThrow(/no price/);
  });

  it("m6: a Full task in the implementation-plan phase can't switch design review on", () => {
    const stuck = { ...planReady({ path: "FULL" }), reviewPhase: "IMPLEMENTATION_PLAN" as const };
    expect(() => on(stuck)).toThrow(/ready to plan/);
    expect(on(planReady({ path: "FULL" })).designReview).toBeDefined();
    expect(on({ ...planReady({ path: "FULL" }), reviewPhase: "DESIGN" as const }).designReview).toBeDefined();
  });
});

describe("money fix round 2: skip, spend on resume, a round that found nothing", () => {
  const ACTOR2 = { actorId: PERSON };
  const held = (): WorkflowSnapshot => holdDesignReviewForCost(designSubmitted(), { expectedRevision: designSubmitted().revision, estimateUsd: 40, now: NOW });

  it("N4/m7: skipDesignReview from the cost hold records person_skip with who and ends at the card; nothing can bring the review back", () => {
    const hold = held();
    expect(hold.designReview!.status).toBe("waiting_cost");
    const skipped = skipDesignReview(hold, { expectedRevision: hold.revision, by: ACTOR2, now: LATER });
    expect(skipped).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { decidedBy: "person_skip", skippedBy: ACTOR2, status: "not_run", notRunReason: "skipped" } });
    expect(skipped.designReview!.estimateUsd).toBeUndefined();
    // the skip stands: Retry review, a raised cap, a lower tier and a re-arm all leave it alone
    expect(() => retryDesignReviewNotRun(skipped, { expectedRevision: skipped.revision, by: ACTOR2, now: LATER })).toThrow(/did not run/);
    expect(() => raiseDesignReviewCap(skipped, { expectedRevision: skipped.revision, capUsd: 20, by: ACTOR2, now: LATER })).toThrow(/skipped/);
    expect(() => lowerDesignReviewTier(skipped, { expectedRevision: skipped.revision, tier: "light", by: ACTOR2, now: LATER })).toThrow(/skipped/);
    expect(rearmedDesignReview(skipped.designReview!, { at: LATER, by: ACTOR2 })).toEqual(skipped.designReview);
    // control: the same review sent to the same place by close (cost_declined) CAN be retried, which is the hole this closes
    const declined = closeDesignReview(hold, { expectedRevision: hold.revision, outcome: "not_run", notRunReason: "cost_declined", now: LATER });
    expect(retryDesignReviewNotRun(declined, { expectedRevision: declined.revision, by: ACTOR2, now: LATER })).toMatchObject({ stage: "PLAN_CRITIQUE", state: "READY" });
  });

  it("N4: a skip before any design exists leaves the task to go on to its design with the review off", () => {
    const enabled = on(planReady());
    const skipped = skipDesignReview(enabled, { expectedRevision: enabled.revision, by: ACTOR2, now: LATER });
    expect(skipped).toMatchObject({ stage: "PLAN", state: "READY", designReview: { decidedBy: "person_skip", status: "not_run", notRunReason: "skipped" } });
    let workflow = submitWorkflowArtifact(running(skipped), { expectedRevision: skipped.revision + 1, artifact: artifact("requirements"), now: NOW });
    workflow = decide(workflow, "APPROVE", artifact("requirements").sha256);
    const next = submitWorkflowArtifact(running(workflow), { expectedRevision: workflow.revision + 1, artifact: artifact("design"), now: NOW });
    expect(next).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
  });

  it("N4: a skip is refused while the review runs, with a stale revision, and for a bad actor; a person_skip record must name who", () => {
    const live = started(designSubmitted());
    expect(() => skipDesignReview(live, { expectedRevision: live.revision, by: ACTOR2, now: LATER })).toThrow(/cannot be skipped/);
    const hold = held();
    expect(() => skipDesignReview(hold, { expectedRevision: hold.revision - 1, by: ACTOR2, now: LATER })).toThrow(/stale/);
    expect(() => skipDesignReview(hold, { expectedRevision: hold.revision, by: { actorId: "" }, now: LATER })).toThrow(/invalid/);
    expect(WorkflowSnapshotSchema.safeParse({ ...hold, designReview: { ...hold.designReview, decidedBy: "person_skip" } }).success).toBe(false);
  });

  it("N6: resuming a blocked round adds what its reviewers already cost; the total only goes up", () => {
    const blocked = blockWorkflow(started(designSubmitted()), "The rule files could not be verified.", LATER);
    const before = blocked.designReview!.spentUsd;
    const resumed = resumeBlockedDesignReview(blocked, { expectedRevision: blocked.revision, addedSpendUsd: 0.35, now: LATER });
    expect(resumed.designReview!.spentUsd).toBeCloseTo(before + 0.35, 6);
    expect(resumeBlockedDesignReview(blocked, { expectedRevision: blocked.revision, now: LATER }).designReview!.spentUsd).toBe(before);
    for (const bad of [-1, Number.NaN, 20_000]) expect(() => resumeBlockedDesignReview(blocked, { expectedRevision: blocked.revision, addedSpendUsd: bad, now: LATER })).toThrow(/invalid/);
  });

  it("N9: a round that found nothing is finished even when it took the total over the cap, and cannot be paid for again", () => {
    const dear = [reviewerRun("critic", { costUsd: 0.3 }), reviewerRun("codebase", { costUsd: 0.3 })];
    const clean = submitRound(started(designSubmitted({ capUsd: 0.5 }), { estimateUsd: 0.1 }), [], {}, dear);
    expect(clean).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "done", spentUsd: 0.6 } });
    expect(() => raiseDesignReviewCap(clean, { expectedRevision: clean.revision, capUsd: 5, by: ACTOR2, now: LATER })).toThrow(/cannot be run again/);
    // control: with a finding the same overspend still stops at the cap
    expect(submitRound(started(designSubmitted({ capUsd: 0.5 }), { estimateUsd: 0.1 }), [finding("f1", "blocker", "x")], {}, dear).designReview!.status).toBe("stopped_at_cap");
  });

  it("N9: a stopped review whose last result read the design that is still the latest is not reopened by a raise", () => {
    const stopped = submitRound(started(designSubmitted({ capUsd: 0.5 }), { estimateUsd: 0.1 }), [finding("f1", "blocker", "x")], { stoppedAtCap: true });
    // the person settled the one finding, so every round is resolved and a raise would otherwise buy a second read of the same design
    const review = stopped.designReview!;
    const resolvedRound = { ...review.rounds[0]!, resolutions: [{ findingId: "f1", action: "contested" as const, evidence: [{ kind: "design" as const, section: "§4" as const }], note: "x", settled: true }] };
    const crafted = { ...stopped, designReview: { ...review, rounds: [resolvedRound] } };
    expect(() => raiseDesignReviewCap(crafted, { expectedRevision: crafted.revision, capUsd: 5, by: ACTOR2, now: LATER })).toThrow(/already reviewed/);
    // control: with a changed design (a new latest artifact) the raise opens it again
    const changed = { ...crafted, artifacts: [...crafted.artifacts, artifact("design", 2)] };
    expect(raiseDesignReviewCap(changed, { expectedRevision: changed.revision, capUsd: 5, by: ACTOR2, now: LATER })).toMatchObject({ stage: "PLAN_CRITIQUE", state: "READY" });
  });
});

describe("money N1: the spend gate and the workflow agree on what fits", () => {
  const priced = (usd: number): DesignReviewEstimate => ({ kind: "priced", usd, breakdown: { reviewersUsd: usd, mergeUsd: 0, plannerUsd: 0 }, tier: "standard", reviewers: 3, rounds: 2 });
  const withSpend = (capUsd: number, spentUsd: number): WorkflowSnapshot => {
    const base = designSubmitted();
    return { ...base, designReview: { ...base.designReview!, capUsd, spentUsd } };
  };
  const startsOk = (workflow: WorkflowSnapshot, estimateUsd: number): boolean => {
    try { startDesignReview(workflow, { expectedRevision: workflow.revision, estimateUsd, now: NOW }); return true; } catch { return false; }
  };

  it("for many cap, spend and estimate combinations the gate says go exactly when startDesignReview accepts, and a raise it offers makes the start accept", () => {
    let asked = 0;
    let raised = 0;
    for (const capUsd of [5, 10, 20]) for (const spentUsd of [0, 0.1, 3.3333333, 4.99, 5, 6.4, 9.99, 10, 12.5, 19.5]) for (const estimateUsd of [0.1, 1, 2.5, 4.9, 5, 6.67, 9.99, 10, 10.01, 25, 40]) {
      const workflow = withSpend(capUsd, spentUsd);
      const gate = gateDesignReviewCost({ tier: "standard", capUsd, spentUsd, estimate: priced(estimateUsd), canSkip: true });
      const label = `cap ${String(capUsd)} spent ${String(spentUsd)} estimate ${String(estimateUsd)}`;
      expect(gate.kind === "go", label).toBe(startsOk(workflow, estimateUsd));
      if (gate.kind === "go") continue;
      asked += 1;
      const raise = gate.choices.find((choice) => choice.choice === "raise_cap");
      if (raise?.choice !== "raise_cap") continue;
      raised += 1;
      // a raise goes to spent + estimate (rounded up to a cent), and with it the very same start is accepted
      expect(raise.newCapUsd, label).toBeGreaterThanOrEqual(spentUsd + estimateUsd - 1e-9);
      expect(startsOk(withSpend(raise.newCapUsd, spentUsd), estimateUsd), label).toBe(true);
      // the old gate (cap only) would have offered a raise to the estimate, which still leaves the start refused when anything was spent
      if (spentUsd > 0.5) expect(raise.newCapUsd, label).toBeGreaterThan(estimateUsd);
    }
    expect(asked).toBeGreaterThan(40);
    expect(raised).toBeGreaterThan(20);
  });

  it("the example from the re-check: cap 10, spent 6, estimate 5 is NOT go (room is 4), and the raise is to 11, not 5", () => {
    const gate = gateDesignReviewCost({ tier: "standard", capUsd: 10, spentUsd: 6, estimate: priced(5), canSkip: false });
    expect(gate).toMatchObject({ kind: "ask", why: "over_cap" });
    expect(gate.kind === "ask" ? gate.choices : []).toEqual([{ choice: "raise_cap", newCapUsd: 11 }]);
  });

  it("a lower tier is offered only if it fits what is LEFT", () => {
    const gate = gateDesignReviewCost({ tier: "standard", capUsd: 10, spentUsd: 7, estimate: priced(8), lowerTier: { tier: "light", estimate: priced(4) }, canSkip: false });
    expect(gate.kind === "ask" ? gate.choices.map((choice) => choice.choice) : []).toEqual(["raise_cap"]);
    const fits = gateDesignReviewCost({ tier: "standard", capUsd: 10, spentUsd: 7, estimate: priced(8), lowerTier: { tier: "light", estimate: priced(2.5) }, canSkip: false });
    expect(fits.kind === "ask" ? fits.choices.map((choice) => choice.choice) : []).toEqual(["lower_tier", "raise_cap"]);
  });

  it("N4: the spend handler's skip maps to skipDesignReview; the other choices map to their moves", () => {
    const hold = holdDesignReviewForCost(designSubmitted(), { expectedRevision: designSubmitted().revision, estimateUsd: 40, now: NOW });
    const skip = applyDesignSpendChoice(hold, { actorId: PERSON, applied: { choice: "skip" } }, { expectedRevision: hold.revision, now: LATER });
    expect(skip.designReview).toMatchObject({ decidedBy: "person_skip", skippedBy: { actorId: PERSON }, notRunReason: "skipped" });
    const raise = applyDesignSpendChoice(hold, { actorId: PERSON, applied: { choice: "raise_cap", newCapUsd: 45 } }, { expectedRevision: hold.revision, estimateUsd: 40, now: LATER });
    expect(raise.designReview).toMatchObject({ capUsd: 45, status: "estimating", estimateUsd: 40, approvals: [{ kind: "raise_cap", by: { actorId: PERSON } }] });
    const lower = applyDesignSpendChoice(hold, { actorId: PERSON, applied: { choice: "lower_tier", tier: "light" } }, { expectedRevision: hold.revision, estimateUsd: 4, now: LATER });
    expect(lower.designReview).toMatchObject({ tier: "light", approvals: [{ kind: "lower_tier" }] });
    const noPrice = holdDesignReviewForCost(designSubmitted(), { expectedRevision: designSubmitted().revision, now: NOW });
    // B2-m5: the pure `run_unpriced` move is unusable on its own: it would put the task at RUNNING with no operation. It throws; the commit port goes through `designSpendCommitItems` (e2e), and the contract's own start still holds the approval.
    expect(() => applyDesignSpendChoice(noPrice, { actorId: PERSON, applied: { choice: "run_unpriced", stopAtMeasuredUsd: 10 } }, { expectedRevision: noPrice.revision, now: LATER })).toThrow(/designSpendCommitItems/);
    const unpriced = startDesignReview(noPrice, { expectedRevision: noPrice.revision, costApproved: { by: { actorId: PERSON } }, now: LATER });
    expect(unpriced).toMatchObject({ state: "RUNNING", designReview: { status: "running", approvals: [{ kind: "spend", by: { actorId: PERSON } }] } });
    expect(() => applyDesignSpendChoice(hold, { actorId: PERSON, applied: { choice: "skip" } }, { expectedRevision: hold.revision - 1, now: LATER })).toThrow(/stale/);
  });
});
