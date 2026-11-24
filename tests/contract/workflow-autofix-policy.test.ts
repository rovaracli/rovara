import { describe, expect, it } from "vitest";
import { WORKFLOW_AGENTX_ACTOR_ID, WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX, WORKFLOW_APPLICATION_EVIDENCE_INCOMPLETE_PREFIX, WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX, WORKFLOW_BLOCK_REASONS, WORKFLOW_HISTORY_REWRITTEN_MESSAGE, WorkflowDecisionRecordSchema, WorkflowSnapshotSchema, WorkflowTransitionError, createCandidateManifest, createWorkflowSnapshot, decideWorkflow, returnWorkflowToImplementation, returnWorkflowToImplementationAutomatically, submitWorkflowArtifact, workflowAutoActionRequestId, workflowAutomaticRetryDecision, wholeTaskSpendUsd, type WorkflowAutoSpend, type WorkflowDecision, type WorkflowSnapshot } from "@agentx/contracts";

const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const ownerId = "a".repeat(64);
const NOW = "2026-10-25T12:00:00.000Z";
const candidate = createCandidateManifest([{ repositoryId: "app", commitSha: "1".repeat(40), treeSha: "2".repeat(40), baseCommitSha: "3".repeat(40) }]);
const roundId = "11111111-1111-4111-8111-111111111111";
const groupRunId = "22222222-2222-4222-8222-222222222222";
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hex = (char: string): string => char.repeat(64);
const incomplete = (...entries: string[]): string => `${WORKFLOW_APPLICATION_EVIDENCE_INCOMPLETE_PREFIX} (${entries.join("; ")})`;

const SPEND: WorkflowAutoSpend = { spentUsd: wholeTaskSpendUsd(2), roundEstimateUsd: 2, capUsd: 15 };

const approval = (n: number, at = NOW): WorkflowDecision => WorkflowDecisionRecordSchema.parse({
  requestId: uuid(n), workflowRevision: 2, decision: "APPROVE", actorId: ownerId, actorRole: "TASK_OWNER", reason: "approved", artifactDigest: hex("b"), at,
});
const ownerSendBack = (n: number): WorkflowDecision => WorkflowDecisionRecordSchema.parse({
  requestId: uuid(n), workflowRevision: 5, decision: "REQUEST_CHANGES", actorId: ownerId, actorRole: "TASK_OWNER", reason: "fix it", source: "SEND_BACK", at: NOW,
});
const automatic = (n: number, source: "AUTO_FIX" | "AUTO_RETRY", stage: "VERIFY" | "REVIEW" = "VERIFY", candidateDigest: string | undefined = candidate.digest): WorkflowDecision => WorkflowDecisionRecordSchema.parse({
  requestId: uuid(n), workflowRevision: 5, decision: "REQUEST_CHANGES", actorId: WORKFLOW_AGENTX_ACTOR_ID, actorRole: "AGENTX", reason: "automatic", source, at: NOW,
  auto: { stage, ...(candidateDigest === undefined ? {} : { candidateDigest }) },
});

type Over = Record<string, unknown>;
/** A workflow stored as the previous code stored it: one plan approval, coding done, then blocked. */
function blocked(stage: "VERIFY" | "REVIEW", blockReason: string | undefined, over: Over = {}): WorkflowSnapshot {
  return WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId, ownerId, now: NOW }), revision: 7, stage, state: "BLOCKED", ...(blockReason === undefined ? {} : { blockReason }),
    candidate, decisions: [approval(1)], ...over,
  });
}
const e2eProgress = (over: Over = {}): Over => ({
  contractDigest: hex("c"), policyDigest: hex("d"), bundleDigest: hex("e"), executionPlanDigest: hex("f"), required: true, currentRoundId: roundId, currentGroupRunIds: [groupRunId], resultRefs: [], ...over,
});
const verify = (reason: string, over: Over = {}): WorkflowSnapshot => blocked("VERIFY", reason, { e2e: e2eProgress(), ...over });
const review = (role: "CRITIC" | "SECURITY", status: string, findings: Over[] = [], over: Over = {}): Over => ({
  operationId: uuid(role === "CRITIC" ? 90 : 91), candidateDigest: candidate.digest, role, provider: "p", version: "1", status, findings, readOnly: true, recordedAt: NOW, ...over,
});
const finding = (text: string, over: Over = {}): Over => ({ text, origin: "INTRODUCED", ...over });

describe("AUTOFIX policy: the money and counts are required inputs", () => {

  it("is held by the guard functions too for a block only a person can resolve: the programs earlier work left running could not be stopped", () => {
    const stuck = blocked("VERIFY", WORKFLOW_BLOCK_REASONS.leftoverProcesses);
    expect(() => returnWorkflowToImplementationAutomatically(stuck, { expectedRevision: 7, reason: "r", spend: SPEND, now: NOW })).toThrow(/new code does not fix it/);
    expect(() => workflowAutomaticRetryDecision(stuck, { expectedRevision: 7, stage: "VERIFY", reason: "r", spend: SPEND, now: NOW })).toThrow(/a retry does not fix it/);
  });

  it("is held by the guard functions too: over the cap, unreadable or missing spend is refused there", () => {
    const base = verify(incomplete("g1: build-failed"));
    const retryBase = verify(incomplete("g1: executor-failed"));
    const over = { spentUsd: wholeTaskSpendUsd(14), roundEstimateUsd: 2, capUsd: 15 };
    expect(() => returnWorkflowToImplementationAutomatically(base, { expectedRevision: 7, reason: "r", spend: over, now: NOW })).toThrow(/spend/);
    expect(() => workflowAutomaticRetryDecision(retryBase, { expectedRevision: 7, stage: "VERIFY", reason: "r", spend: over, now: NOW })).toThrow(/spend/);
    for (const spend of [undefined, { ...SPEND, spentUsd: Number.NaN }, { ...SPEND, capUsd: Number.POSITIVE_INFINITY }, { ...SPEND, roundEstimateUsd: -1 }, { spentUsd: 1 }]) {
      expect(() => returnWorkflowToImplementationAutomatically(base, { expectedRevision: 7, reason: "r", spend: spend as never, now: NOW })).toThrow(/spend/);
      expect(() => workflowAutomaticRetryDecision(retryBase, { expectedRevision: 7, stage: "VERIFY", reason: "r", spend: spend as never, now: NOW })).toThrow(/spend/);
    }
    // Exactly at the cap is allowed, as in the policy.
    const exact = { spentUsd: wholeTaskSpendUsd(13), roundEstimateUsd: 2, capUsd: 15 };
    expect(returnWorkflowToImplementationAutomatically(base, { expectedRevision: 7, reason: "r", spend: exact, now: NOW }).stage).toBe("IMPLEMENT");
  });
});

describe("AUTOFIX: the AGENTX actor", () => {
  const blockedForSendBack = (over: Over = {}): WorkflowSnapshot => verify(incomplete("g1: build-failed"), over);

  it("sends blocked work back as AGENTX with a derived request ID, and clears the block like the owner's Send back", () => {
    const before = blockedForSendBack();
    const after = returnWorkflowToImplementationAutomatically(before, { expectedRevision: 7, reason: "The app did not build.", spend: SPEND, now: NOW });
    expect(after).toMatchObject({ stage: "IMPLEMENT", state: "READY", revision: 8 });
    expect(after.blockReason).toBeUndefined();
    const added = after.decisions.at(-1)!;
    expect(added).toMatchObject({
      requestId: workflowAutoActionRequestId(taskId, 7, "AUTO_FIX"), workflowRevision: 7, decision: "REQUEST_CHANGES", actorId: WORKFLOW_AGENTX_ACTOR_ID, actorRole: "AGENTX",
      source: "AUTO_FIX", auto: { stage: "VERIFY", candidateDigest: candidate.digest },
    });
    // The same move by the owner leaves the same snapshot except for the decision.
    const byOwner = returnWorkflowToImplementation(before, { requestId: uuid(500), actorId: ownerId, reason: "x", now: NOW });
    expect({ ...after, decisions: [] }).toEqual({ ...byOwner, decisions: [] });
  });

  it("is idempotent for the same revision, and only one of two writers on a revision wins", () => {
    const before = blockedForSendBack();
    const once = returnWorkflowToImplementationAutomatically(before, { expectedRevision: 7, reason: "r", spend: SPEND, now: NOW });
    expect(returnWorkflowToImplementationAutomatically(once, { expectedRevision: 7, reason: "r", spend: SPEND, now: NOW })).toEqual(once);
    expect(once.decisions.filter((decision) => decision.source === "AUTO_FIX")).toHaveLength(1);
    // The owner pressed Send back first: the automatic one is out of date.
    const ownerFirst = returnWorkflowToImplementation(before, { requestId: uuid(501), actorId: ownerId, reason: "x", now: NOW });
    expect(() => returnWorkflowToImplementationAutomatically(ownerFirst, { expectedRevision: 7, reason: "r", spend: SPEND, now: NOW })).toThrow(/out of date/);
    // And the other way round: the owner presses after the automatic one, and finds the work no longer blocked.
    expect(() => returnWorkflowToImplementation(once, { requestId: uuid(502), actorId: ownerId, reason: "x", now: NOW })).toThrow(WorkflowTransitionError);
    expect(() => returnWorkflowToImplementationAutomatically(before, { expectedRevision: 6, reason: "r", spend: SPEND, now: NOW })).toThrow(/out of date/);
  });

  it("works from a blocked REVIEW too, naming that stage", () => {
    const reviewBlocked = blocked("REVIEW", undefined, { reviews: [review("CRITIC", "FINDINGS", [finding("bug")]), review("SECURITY", "PASS")] });
    const after = returnWorkflowToImplementationAutomatically(reviewBlocked, { expectedRevision: 7, reason: "findings", spend: SPEND, now: NOW });
    expect(after.decisions.at(-1)).toMatchObject({ source: "AUTO_FIX", auto: { stage: "REVIEW" } });
  });

  it("refuses everywhere except a blocked VERIFY or REVIEW", () => {
    const base = blockedForSendBack();
    const tryIt = (workflow: unknown) => () => returnWorkflowToImplementationAutomatically(workflow, { expectedRevision: (workflow as WorkflowSnapshot).revision, reason: "r", spend: SPEND, now: NOW });
    expect(tryIt(WorkflowSnapshotSchema.parse({ ...base, stage: "IMPLEMENT" }))).toThrow(WorkflowTransitionError);
    expect(tryIt(WorkflowSnapshotSchema.parse({ ...base, state: "RUNNING", blockReason: undefined }))).toThrow(WorkflowTransitionError);
    // A plan waiting for its owner's approval.
    const planReview = submitWorkflowArtifact(createWorkflowSnapshot({ taskId, ownerId, now: NOW }), {
      expectedRevision: 1, now: NOW,
      artifact: { id: "plan-v1", type: "plan", version: 1, sha256: hex("b"), producer: "agentx-planner", objectKey: `tasks/${taskId}/plan-v1.md`, createdAt: NOW },
    });
    expect(planReview.stage).toBe("PLAN_REVIEW");
    expect(tryIt(planReview)).toThrow(WorkflowTransitionError);
    // A pull request is open.
    const withPullRequest = { ...base, pullRequests: [{ repositoryId: "app", number: 4, url: "https://github.com/o/r/pull/4", required: true, candidateDigest: candidate.digest, state: "OPEN", headSha: "6".repeat(40), observedAt: NOW }] };
    expect(tryIt(WorkflowSnapshotSchema.parse(withPullRequest))).toThrow(/pull request/);
    // The change is ready to publish.
    expect(tryIt({ ...base, stage: "PULL_REQUEST", state: "READY" })).toThrow();
  });

  it("refuses blocks only a person fixes, whatever the caller decided", () => {
    for (const reason of [WORKFLOW_HISTORY_REWRITTEN_MESSAGE, `${WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX}x`, `${WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX}x`]) {
      expect(() => returnWorkflowToImplementationAutomatically(verify(reason), { expectedRevision: 7, reason: "r", spend: SPEND, now: NOW })).toThrow(/needs a person/);
    }
  });

  it("holds the limits itself: 2 automatic send backs per plan, 6 automatic actions, a full history", () => {
    const two = blockedForSendBack({ decisions: [approval(1), automatic(2, "AUTO_FIX"), automatic(3, "AUTO_FIX")] });
    expect(() => returnWorkflowToImplementationAutomatically(two, { expectedRevision: 7, reason: "r", spend: SPEND, now: NOW })).toThrow(/limit/);
    const newPlan = blockedForSendBack({ decisions: [approval(1), automatic(2, "AUTO_FIX"), automatic(3, "AUTO_FIX"), approval(4)] });
    expect(returnWorkflowToImplementationAutomatically(newPlan, { expectedRevision: 7, reason: "r", spend: SPEND, now: NOW }).stage).toBe("IMPLEMENT");
    const six = blockedForSendBack({ decisions: [approval(1), automatic(2, "AUTO_FIX"), automatic(3, "AUTO_FIX"), approval(4), automatic(5, "AUTO_FIX"), automatic(6, "AUTO_FIX"), approval(7),
      automatic(8, "AUTO_RETRY", "REVIEW", hex("9")), automatic(9, "AUTO_RETRY", "REVIEW", hex("a"))] });
    expect(() => returnWorkflowToImplementationAutomatically(six, { expectedRevision: 7, reason: "r", spend: SPEND, now: NOW })).toThrow(/limit/);
    const full = blockedForSendBack({ decisions: [approval(1), ...Array.from({ length: 99 }, (_, index) => ownerSendBack(index + 100))] });
    expect(() => returnWorkflowToImplementationAutomatically(full, { expectedRevision: 7, reason: "r", spend: SPEND, now: NOW })).toThrow(/history is full/);
  });

  it("records an automatic retry once per stage and candidate, and not for another stage or a stale revision", () => {
    const base = verify(incomplete("g1: executor-failed"));
    const decision = workflowAutomaticRetryDecision(base, { expectedRevision: 7, stage: "VERIFY", reason: "retry", spend: SPEND, now: NOW });
    expect(decision).toMatchObject({ requestId: workflowAutoActionRequestId(taskId, 7, "AUTO_RETRY"), actorRole: "AGENTX", source: "AUTO_RETRY", auto: { stage: "VERIFY", candidateDigest: candidate.digest } });
    const recorded = WorkflowSnapshotSchema.parse({ ...base, decisions: [...base.decisions, decision] });
    expect(workflowAutomaticRetryDecision(recorded, { expectedRevision: 7, stage: "VERIFY", reason: "retry", spend: SPEND, now: NOW })).toEqual(decision);
    const next = WorkflowSnapshotSchema.parse({ ...recorded, revision: 9 });
    expect(() => workflowAutomaticRetryDecision(next, { expectedRevision: 9, stage: "VERIFY", reason: "retry", spend: SPEND, now: NOW })).toThrow(/already retried/);
    expect(() => workflowAutomaticRetryDecision(base, { expectedRevision: 7, stage: "REVIEW", reason: "retry", spend: SPEND, now: NOW })).toThrow(/blocked stage/);
    expect(() => workflowAutomaticRetryDecision(base, { expectedRevision: 6, stage: "VERIFY", reason: "retry", spend: SPEND, now: NOW })).toThrow(/out of date/);
    expect(() => workflowAutomaticRetryDecision(verify(WORKFLOW_HISTORY_REWRITTEN_MESSAGE), { expectedRevision: 7, stage: "VERIFY", reason: "r", spend: SPEND, now: NOW })).toThrow(/needs a person/);
  });

  it("can never approve, skip, reject, publish or carry an approval's fields", () => {
    const automaticFields = { requestId: uuid(700), workflowRevision: 3, actorId: WORKFLOW_AGENTX_ACTOR_ID, actorRole: "AGENTX", reason: "r", source: "AUTO_FIX", auto: { stage: "VERIFY" }, at: NOW };
    expect(WorkflowDecisionRecordSchema.safeParse({ ...automaticFields, decision: "REQUEST_CHANGES" }).success).toBe(true);
    for (const decision of ["APPROVE", "SKIP", "REJECT"]) expect(WorkflowDecisionRecordSchema.safeParse({ ...automaticFields, decision }).success).toBe(false);
    const request = { ...automaticFields, decision: "REQUEST_CHANGES" };
    for (const extra of [{ artifactDigest: hex("b") }, { workBreakdownDigest: hex("b") }, { selectedOptionalCheckIds: ["a"] }, { commentsIncluded: 1 }, { via: "PAGE" }, { answerOverrides: [{ decisionId: "d1", optionId: "x" }] }]) {
      expect(WorkflowDecisionRecordSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    }
    // The AGENTX role is for the AGENTX identity and automatic sources only, and an automatic source is for the AGENTX role only.
    expect(WorkflowDecisionRecordSchema.safeParse({ ...request, actorId: ownerId }).success).toBe(false);
    expect(WorkflowDecisionRecordSchema.safeParse({ ...request, actorRole: "TASK_OWNER" }).success).toBe(false);
    expect(WorkflowDecisionRecordSchema.safeParse({ ...request, actorId: ownerId, actorRole: "PROJECT_ADMIN" }).success).toBe(false);
    expect(WorkflowDecisionRecordSchema.safeParse({ ...request, source: "SEND_BACK" }).success).toBe(false);
    expect(WorkflowDecisionRecordSchema.safeParse({ ...request, auto: undefined }).success).toBe(false);
    expect(WorkflowDecisionRecordSchema.safeParse({ ...request, actorRole: "TASK_OWNER", actorId: ownerId, source: "SEND_BACK" }).success).toBe(false);
    // `auto` belongs to automatic decisions only.
    expect(WorkflowDecisionRecordSchema.safeParse({ ...request, actorRole: "TASK_OWNER", actorId: ownerId, source: "SEND_BACK", auto: { stage: "VERIFY" } }).success).toBe(false);
  });

  it("is not an owner: it cannot approve a plan through the owner's gate", () => {
    const planReview = submitWorkflowArtifact(createWorkflowSnapshot({ taskId, ownerId, now: NOW }), {
      expectedRevision: 1, now: NOW,
      artifact: { id: "plan-v1", type: "plan", version: 1, sha256: hex("b"), producer: "agentx-planner", objectKey: `tasks/${taskId}/plan-v1.md`, createdAt: NOW },
    });
    const approve = { requestId: uuid(800), expectedRevision: planReview.revision, decision: "APPROVE", artifactDigest: hex("b"), reason: "ok" };
    expect(() => decideWorkflow(planReview, approve, { actorId: WORKFLOW_AGENTX_ACTOR_ID, role: "AGENTX" as never }, { now: NOW, allowedSkipStages: [] })).toThrow();
    expect(() => decideWorkflow(planReview, approve, { actorId: WORKFLOW_AGENTX_ACTOR_ID, role: "TASK_OWNER" }, { now: NOW, allowedSkipStages: [] })).toThrow(WorkflowTransitionError);
    expect(() => decideWorkflow(planReview, approve, { actorId: WORKFLOW_AGENTX_ACTOR_ID, role: "TASK_OWNER" }, { now: NOW, allowedSkipStages: [], authority: { actorId: WORKFLOW_AGENTX_ACTOR_ID, ownerIds: [ownerId] } }))
      .toThrow(WorkflowTransitionError);
  });
});
