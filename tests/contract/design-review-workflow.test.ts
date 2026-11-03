// Design review stage, DR6 (designs-2026-10-30/design-review-stage.md 3.2, 3.7, 3.13): the workflow's transitions. Bounds, settled findings, oscillation stop, cap stop, not-run paths,
// and the guarantee that with design review OFF nothing changed (the plan check's own tests live in rovara-code-critic.test.ts and stay green).
import { describe, expect, it } from "vitest";
import {
  DESIGN_REVIEW_ROUNDS_MAX, WorkflowSnapshotSchema, answerDesignQuestions, askDesignQuestions, closeDesignReview, closePlanCritique, createWorkflowSnapshot, decideWorkflow, designFindingFingerprint,
  designReviewDisagreements, designReviewRevisionsUsed, enableDesignReview, holdDesignReviewForCost, resolveDesignReview, retryDesignReview, startDesignReview, submitDesignReview, submitPlanCritique,
  submitWorkflowArtifact, workflowIsDesignReviewing, type WorkflowProgram, type WorkflowSnapshot,
} from "../../packages/contracts/src/index.js";
import * as web from "../../packages/contracts/src/web.js";
import { taskViewForClient } from "../../packages/broker/src/rovara-code/task-view-compat.js";

const NOW = "2026-11-03T12:00:00.000Z";
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
const START = { decidedBy: "auto" as const, reasons: ["new_api" as const], note: "Adds a public API.", tier: "standard" as const };
const running = (workflow: WorkflowSnapshot): WorkflowSnapshot => ({ ...workflow, revision: workflow.revision + 1, state: "RUNNING" });
const planReady = (extra: { program?: WorkflowProgram; definitionVersion?: "1.0.0" | "1.1.0"; path?: "QUICK" | "FULL" } = {}): WorkflowSnapshot => {
  const workflow = createWorkflowSnapshot({ taskId: TASK_ID, ownerId: OWNER, now: NOW, path: extra.path ?? "QUICK", definitionVersion: extra.definitionVersion ?? "1.1.0", program: extra.program ?? PROGRAM });
  return { ...workflow, state: "READY" };
};
const on = (workflow: WorkflowSnapshot): WorkflowSnapshot => enableDesignReview(workflow, { expectedRevision: workflow.revision, start: START, now: NOW });
const decide = (workflow: WorkflowSnapshot, decision: "APPROVE" | "REQUEST_CHANGES", digest: string, requestId = "22222222-2222-4222-8222-222222222222"): WorkflowSnapshot =>
  decideWorkflow(workflow, { requestId, expectedRevision: workflow.revision, decision, reason: "ok", artifactDigest: digest }, { actorId: OWNER, role: "TASK_OWNER" }, { now: LATER, allowedSkipStages: [] });

/** A Full task whose requirements were approved and whose first design was just submitted: PLAN_CRITIQUE/READY, review "estimating". */
function designSubmitted(): WorkflowSnapshot {
  let workflow = on(planReady());
  workflow = submitWorkflowArtifact(running(workflow), { expectedRevision: workflow.revision + 1, artifact: artifact("requirements"), now: NOW });
  workflow = decide(workflow, "APPROVE", artifact("requirements").sha256);
  return submitWorkflowArtifact(running(workflow), { expectedRevision: workflow.revision + 1, artifact: artifact("design"), now: NOW });
}
const started = (workflow: WorkflowSnapshot, extra: { estimateUsd?: number } = {}): WorkflowSnapshot => startDesignReview(workflow, { expectedRevision: workflow.revision, ...extra, now: NOW });

const MODEL = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-opus-5-5-v1" };
const reviewerRun = (role: "comprehension" | "critic" | "codebase" | "zoom_out" | "critic_b", extra: Record<string, unknown> = {}) => ({
  role, promptId: `design-${role}`, promptVersion: 1, promptDigest: hex(7), model: MODEL, sourceId: "src_1", sessionId: `ses_${role}`, modelKeyId: `key_${role}`, packetDigest: hex(8),
  packet: [{ kind: "design", ref: "design.md", commitOrFetchedAt: "a".repeat(40), digest: hex(9), bytes: 1200 }], filesRead: [], verified: true, tokensIn: 1000, tokensOut: 200, costUsd: 0.1,
  startedAt: NOW, endedAt: LATER, ...extra,
});
const failedRun = (role: "critic" | "codebase", failure: string) => reviewerRun(role, { verified: false, verifyFailure: failure });
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
    const held = holdDesignReviewForCost(ready, { expectedRevision: ready.revision, estimateUsd: 12, now: NOW });
    expect(held).toMatchObject({ stage: "PLAN_CRITIQUE", state: "WAITING", designReview: { status: "waiting_cost", estimateUsd: 12 } });
    expect(() => startDesignReview(held, { expectedRevision: held.revision, now: NOW })).toThrow(/spend/);
    expect(startDesignReview(held, { expectedRevision: held.revision, costApproved: true, now: NOW })).toMatchObject({ state: "RUNNING", designReview: { status: "running" } });
    expect(started(ready, { estimateUsd: 3 })).toMatchObject({ state: "RUNNING", designReview: { status: "running", estimateUsd: 3 } });
  });

  it("goes back to READY when the model can't be used, and refuses a start at the wrong state", () => {
    const live = started(designSubmitted());
    expect(retryDesignReview(live, { expectedRevision: live.revision, now: NOW })).toMatchObject({ state: "READY", designReview: { status: "estimating" } });
    expect(() => started(live)).toThrow(/not at that step/);
    expect(() => startDesignReview(live, { expectedRevision: live.revision - 1, now: NOW })).toThrow(/stale/);
  });

  it("never starts a third round", () => {
    const round2 = started(atRound2());
    const done = submitRound(round2, []);
    expect(done.designReview!.rounds).toHaveLength(DESIGN_REVIEW_ROUNDS_MAX);
    expect(() => startDesignReview({ ...done, stage: "PLAN_CRITIQUE", state: "READY", designReview: { ...done.designReview!, status: "estimating" } }, { expectedRevision: done.revision, now: NOW })).toThrow(/rounds/);
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
    expect(submitRound(started(designSubmitted()), [finding("f1", "blocker", "x")], { capUsd: 0.19 }).designReview!.status).toBe("stopped_at_cap");
    expect(submitRound(started(designSubmitted()), [finding("f1", "blocker", "x")], { capUsd: 0.2 }).designReview!.status).toBe("resolving");
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
    expect(() => askDesignQuestions({ ...waiting, state: "RUNNING", designReview: { ...waiting.designReview!, status: "resolving" } }, { expectedRevision: waiting.revision, questions: [question("q1")], now: LATER })).toThrow(/one question card/);
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
    expect(() => startDesignReview(final, { expectedRevision: final.revision, now: NOW })).toThrow(/not at that step/);
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
    const round2 = submitRound(started(atRound2()), [finding("g1", "blocker", "Remove the retry limit.", ["critic"], "§3"), finding("g2", "major", "Add an index.", ["critic"], "§4")], { undoesEarlierFix: ["g1"] });
    expect(round2).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "done" } });
    expect(round2.designReview!.rounds[1]!.oscillation).toEqual(["g1"]);
    expect(designReviewDisagreements(round2.designReview).map((entry) => [entry.findingId, entry.kind])).toEqual([["g1", "oscillation"], ["g2", "unresolved"]]);
    expect(round2.decisions).toHaveLength(1);
  });

  it("can't be claimed in round 1, or for a finding that isn't there", () => {
    expect(() => submitRound(started(designSubmitted()), [finding("f1", "blocker", "x")], { undoesEarlierFix: ["f1"] })).toThrow(/later round/);
    expect(() => submitRound(started(atRound2()), [finding("g1", "blocker", "x")], { undoesEarlierFix: ["zzz"] })).toThrow(/later round/);
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
