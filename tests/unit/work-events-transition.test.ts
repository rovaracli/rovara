// Work events (U3): which events each change of a task's workflow makes. Real snapshots from the workflow's own transitions; one test per emit point.
import { describe, expect, it } from "vitest";
import { WORKFLOW_BLOCK_REASONS, WorkEventSchema, blockWorkflow, createWorkflowSnapshot, decideWorkflow, submitWorkflowArtifact, workEventId, type WorkEvent, type WorkflowSnapshot } from "@agentx/cloud-contracts";
import { BUDGET_EXHAUSTED_FAILURE_MESSAGE } from "@rovara-code/contracts";
import { stoppedStepReason } from "../../packages/broker/src/aws/workflow-cancel-reconcile.js";
import { waitingOf, workEventsOfTransition } from "../../packages/broker/src/work-events/transition.js";
import { costSettledEvent } from "../../packages/broker/src/work-events/cost.js";

const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const ownerId = "a".repeat(64);
const orgId = "org_aaaaaaaaaaaaaaaaaaaa" as const;
const project = "billing-service";
const T0 = "2026-11-10T09:00:00.000Z";
const T1 = "2026-11-10T09:05:00.000Z";
const T2 = "2026-11-10T09:10:00.000Z";
const plan = { id: "plan-v1", type: "plan" as const, version: 1, sha256: "b".repeat(64), producer: "agentx-planner", objectKey: `tasks/${taskId}/plan-v1.json`, createdAt: T0, format: "structured" as const };

const planning = (): WorkflowSnapshot => createWorkflowSnapshot({ taskId, ownerId, now: T0 });
const waiting = (): WorkflowSnapshot => { const p = planning(); return submitWorkflowArtifact(p, { expectedRevision: p.revision, artifact: plan, now: T1 }); };
/** The decision as the route stores it: `decideWorkflow` readies the coding step, and the route starts it (revision + 1, RUNNING) in the same write. */
const approved = (): WorkflowSnapshot => { const decided = decideWorkflow(waiting(), {
  requestId: "d532a6e0-3de1-44e3-a6d2-e8c635d77f2b", expectedRevision: waiting().revision, decision: "APPROVE", artifactDigest: plan.sha256, reason: "Looks right.", answers: [],
}, { actorId: ownerId, role: "TASK_OWNER" }, { now: T2, allowedSkipStages: [], via: "PAGE" }); return { ...decided, revision: decided.revision + 1, state: "RUNNING", updatedAt: T2 }; };
const events = (before: WorkflowSnapshot | undefined, after: WorkflowSnapshot, origin?: string): WorkEvent[] =>
  workEventsOfTransition({ orgId, project, before, after, ...(origin === undefined ? {} : { origin }) }).map((event) => WorkEventSchema.parse(event));
const kinds = (list: readonly WorkEvent[]): string[] => list.map((event) => event.kind);

describe("a task starts", () => {
  it("makes task_started with the owner as the person, and the step it begins with", () => {
    const list = events(undefined, planning(), "web");
    expect(kinds(list)).toEqual(["task_started", "step_started", "waiting_changed"]);
    expect(list[0]).toMatchObject({ kind: "task_started", at: T0, orgId, project, taskId, path: "QUICK", origin: "web", actor: { kind: "person", personId: ownerId } });
    expect(list[1]).toMatchObject({ kind: "step_started", step: "plan", actor: { kind: "agent" } });
    expect(list[2]).toMatchObject({ kind: "waiting_changed", waitingOn: "agent" });
    expect(list[2]).not.toHaveProperty("personIds");
  });
});

describe("a plan is ready, and then decided", () => {
  it("makes step_ended, decision_asked and waiting_changed to the owner when the plan reaches the gate", () => {
    const list = events(planning(), waiting());
    expect(kinds(list)).toEqual(["step_ended", "decision_asked", "waiting_changed"]);
    expect(list[0]).toMatchObject({ step: "plan", outcome: "done", at: T1 });
    expect(list[1]).toMatchObject({ decisionId: "r2", decision: "plan", actor: { kind: "system" } });
    expect(list[2]).toMatchObject({ waitingOn: "person", personIds: [ownerId], reason: "plan_review" });
  });

  it("makes decision_answered and plan_approved with the person's id, then the coding step and the wait for the agent", () => {
    const list = events(waiting(), approved());
    expect(kinds(list)).toEqual(["step_started", "decision_answered", "plan_approved", "waiting_changed"]);
    expect(list[1]).toMatchObject({ kind: "decision_answered", decisionId: "r2", decision: "plan", outcome: "approved", place: "web", actor: { kind: "person", personId: ownerId } });
    expect(list[2]).toMatchObject({ kind: "plan_approved", actor: { kind: "person", personId: ownerId } });
    expect(list[3]).toMatchObject({ waitingOn: "agent" });
    // The pair joins on decisionId: the question and its answer name the same revision.
    expect(events(planning(), waiting()).find((event) => event.kind === "decision_asked")).toMatchObject({ decisionId: "r2" });
  });

  it("makes a decision_answered but no plan_approved for a request for changes", () => {
    const changes = decideWorkflow(waiting(), {
      requestId: "d532a6e0-3de1-44e3-a6d2-e8c635d77f2b", expectedRevision: waiting().revision, decision: "REQUEST_CHANGES", artifactDigest: plan.sha256, reason: "Split it.", answers: [],
    }, { actorId: ownerId, role: "TASK_OWNER" }, { now: T2, allowedSkipStages: [] });
    const list = events(waiting(), changes);
    expect(kinds(list)).toContain("decision_answered");
    expect(kinds(list)).not.toContain("plan_approved");
    expect(list.find((event) => event.kind === "decision_answered")).toMatchObject({ outcome: "changes_requested" });
  });
});

describe("a task is blocked: a failure and a stop are different facts", () => {
  const blockedBy = (reason: string): WorkflowSnapshot => blockWorkflow(approved(), reason, "2026-11-10T10:00:00.000Z");

  it("records a real failure as step_ended failed with its cause, task_failed with the same cause, and a wait for the owner", () => {
    const list = events(approved(), blockedBy(WORKFLOW_BLOCK_REASONS.regressionFound));
    expect(kinds(list)).toEqual(["step_ended", "task_failed", "waiting_changed"]);
    expect(list[0]).toMatchObject({ outcome: "failed", cause: "checks_failed" });
    expect(list[1]).toMatchObject({ cause: "checks_failed", actor: { kind: "system" } });
    expect(list[2]).toMatchObject({ waitingOn: "person", personIds: [ownerId], reason: "blocked_checks_failed" });
  });

  it("records an owner stop or a cancel as step_ended stopped (cancelled) and NO task_failed", () => {
    const list = events(approved(), blockedBy(stoppedStepReason("IMPLEMENT", "CANCELLED")));
    expect(kinds(list)).toEqual(["step_ended", "waiting_changed"]);
    expect(list[0]).toMatchObject({ outcome: "stopped", cause: "cancelled" });
    expect(list[1]).toMatchObject({ reason: "blocked_cancelled" });
  });

  it("records a budget exhaustion, a budget pause and a pause for the run limit as stops", () => {
    for (const [reason, cause] of [[BUDGET_EXHAUSTED_FAILURE_MESSAGE, "budget_exhausted"], [WORKFLOW_BLOCK_REASONS.budgetPaused, "budget_paused"], ["This plan's run limit is $12.00, which needs your approval.", "budget_paused"]] as const) {
      const list = events(approved(), blockedBy(reason));
      expect(kinds(list), reason).toEqual(["step_ended", "waiting_changed"]);
      expect(list[0]).toMatchObject({ outcome: "stopped", cause });
    }
  });

  it("records a block it does not recognise as a failure with cause other, never with its words", () => {
    const list = events(approved(), blockedBy("Something nobody wrote a constant for: secret sk-test and bob@example.com"));
    expect(kinds(list)).toEqual(["step_ended", "task_failed", "waiting_changed"]);
    expect(list[1]).toMatchObject({ cause: "other" });
    expect(JSON.stringify(list)).not.toMatch(/nobody|sk-test|bob@example/u);
  });
});

describe("a task ends", () => {
  const ended = (outcome: NonNullable<WorkflowSnapshot["outcome"]>, stage: WorkflowSnapshot["stage"] = "CLOSED"): WorkflowSnapshot => ({ ...approved(), stage, state: "COMPLETE", outcome, revision: 9, updatedAt: "2026-11-10T12:00:00.000Z" });

  it("makes task_closed with a closed outcome for every way a task ends, once, at the workflow's own time", () => {
    for (const [outcome, word] of [["MERGED", "merged"], ["CLOSED", "closed_unmerged"], ["ANSWERED", "answered"], ["REJECTED", "plan_rejected"], ["PASSED", "passed"], ["SKIPPED", "skipped"], ["CHANGES_REQUESTED", "changes_requested"]] as const) {
      const list = events(approved(), ended(outcome)).filter((event) => event.kind === "task_closed");
      expect(list, outcome).toHaveLength(1);
      expect(list[0], outcome).toMatchObject({ outcome: word, at: "2026-11-10T12:00:00.000Z", actor: { kind: "system" } });
    }
    expect(kinds(events(approved(), ended("REJECTED")))).toContain("waiting_changed");
  });

  it("makes no second task_closed for a change that keeps a task ended", () => {
    expect(events(ended("MERGED"), { ...ended("MERGED"), revision: 10, updatedAt: "2026-11-10T13:00:00.000Z" })).toEqual([]);
  });
});

describe("pull requests", () => {
  const withPulls = (workflow: WorkflowSnapshot, pulls: Array<{ state: "OPEN" | "MERGED" | "CLOSED"; number: number }>, extra: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot => ({
    ...workflow, ...extra, pullRequests: pulls.map((pull) => ({ repositoryId: "acme/api", number: pull.number, url: `https://example.com/acme/api/pull/${String(pull.number)}`, candidateDigest: "c".repeat(64), required: true, state: pull.state })),
  });
  const open = withPulls({ ...approved(), stage: "WAIT_FOR_MERGE", state: "WAITING", revision: 9, updatedAt: T2 }, [{ state: "OPEN", number: 7 }]);

  it("makes pr_opened when a pull request first appears, and a wait on a person for the merge", () => {
    const list = events({ ...approved(), stage: "PULL_REQUEST", state: "RUNNING", revision: 8, updatedAt: T1 }, open);
    expect(kinds(list)).toContain("pr_opened");
    expect(list.find((event) => event.kind === "pr_opened")).toMatchObject({ repository: "acme/api", number: 7, actor: { kind: "agent" } });
    expect(list.find((event) => event.kind === "waiting_changed")).toMatchObject({ waitingOn: "person", reason: "merge" });
  });

  it("gives a pull request closed, reopened and closed again two different events", () => {
    const closedAt = (revision: number) => withPulls({ ...open, revision, updatedAt: `2026-11-10T1${String(revision - 9)}:00:00.000Z` }, [{ state: "CLOSED", number: 7 }]);
    const first = events(open, closedAt(10)).find((event) => event.kind === "pr_closed")!;
    const reopened = withPulls({ ...open, revision: 11, updatedAt: "2026-11-10T11:30:00.000Z" }, [{ state: "OPEN", number: 7 }]);
    const second = events(reopened, closedAt(12)).find((event) => event.kind === "pr_closed")!;
    expect(first.id).not.toBe(second.id);
  });

  it("makes pr_merged once, and the wait ends", () => {
    const merged = withPulls({ ...open, state: "COMPLETE", stage: "MERGED", outcome: "MERGED", revision: 10, updatedAt: "2026-11-10T11:00:00.000Z" }, [{ state: "MERGED", number: 7 }]);
    const list = events(open, merged);
    expect(list.filter((event) => event.kind === "pr_merged")).toHaveLength(1);
    expect(list.find((event) => event.kind === "pr_merged")).toMatchObject({ repository: "acme/api", number: 7, at: "2026-11-10T11:00:00.000Z", actor: { kind: "system" } });
    expect(kinds(list)).not.toContain("pr_opened");
    expect(list.find((event) => event.kind === "task_closed")).toMatchObject({ outcome: "merged" });
    expect(list.find((event) => event.kind === "waiting_changed")).toMatchObject({ waitingOn: "none" });
  });

  it("makes pr_closed for a pull request closed without a merge, and nothing for one already closed", () => {
    const closed = withPulls({ ...open, revision: 10, updatedAt: "2026-11-10T11:00:00.000Z" }, [{ state: "CLOSED", number: 7 }]);
    expect(kinds(events(open, closed))).toEqual(["pr_closed"]);
    expect(events(closed, { ...closed, revision: 11 })).toEqual([]);
  });
});

describe("what is never an event", () => {
  it("makes nothing for a change that moves nothing the events name", () => {
    expect(events(waiting(), { ...waiting(), updatedAt: T2 })).toEqual([]);
  });

  it("derives the same ids for the same change, so a repeat writes the same rows", () => {
    expect(events(waiting(), approved()).map((event) => event.id)).toEqual(events(waiting(), approved()).map((event) => event.id));
    expect(events(planning(), waiting())[1]!.id).toBe(workEventId({ kind: "decision_asked", taskId, source: "r2" }));
    // The first event is timed by the task's creation, whichever change the reader meets first.
    expect(events(undefined, planning())[0]).toMatchObject({ kind: "task_started", at: T0 });
    expect(events(undefined, { ...planning(), revision: 5, updatedAt: T2 })[0]).toMatchObject({ kind: "task_started", at: T0 });
  });

  it("holds no text a person or model wrote, whatever the snapshot carries", () => {
    const noisy = { ...approved(), blockReason: "Reviewer said: please rename the secretThing and email bob@example.com" } as WorkflowSnapshot;
    expect(JSON.stringify(events(waiting(), noisy))).not.toMatch(/secretThing|bob@example|rename/u);
  });
});

describe("who the work waits for", () => {
  it("maps every state", () => {
    expect(waitingOf({ ...planning(), state: "COMPLETE" })).toEqual({ waitingOn: "none" });
    expect(waitingOf(planning())).toEqual({ waitingOn: "agent" });
    expect(waitingOf(waiting())).toEqual({ waitingOn: "person", personIds: [ownerId], reason: "plan_review" });
    expect(waitingOf({ ...planning(), stage: "PLAN_CRITIQUE", state: "WAITING" })).toEqual({ waitingOn: "system", reason: "waiting_plan_critique" });
  });
});

describe("cost settled", () => {
  const input = { orgId, project, taskId, keyId: "key-1", sequence: 3, at: "2026-11-10T12:00:00.000Z", deltaUsd: 1.2345678, source: "model" };
  it("makes one event in whole micro-dollars, with the settlement's own id", () => {
    expect(costSettledEvent(input)).toMatchObject({ kind: "cost_settled", micros: 1_234_568, currency: "USD", source: "model", actor: { kind: "system" }, id: workEventId({ kind: "cost_settled", taskId, source: "key-1.3" }) });
  });
  it("makes none for spend that belongs to no task or project, or for nothing", () => {
    expect(costSettledEvent({ ...input, taskId: undefined })).toBeUndefined();
    expect(costSettledEvent({ ...input, project: undefined })).toBeUndefined();
    expect(costSettledEvent({ ...input, deltaUsd: 0 })).toBeUndefined();
  });
  it("replaces a source word that is not a short code with other", () => {
    expect(costSettledEvent({ ...input, source: "Slack turn for Priya" })).toMatchObject({ source: "other" });
  });
});
