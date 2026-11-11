// Work events (U3): which events each change of a task's workflow makes. Real snapshots from the workflow's own transitions; one test per emit point.
import { describe, expect, it } from "vitest";
import {
  WorkEventSchema, blockWorkflow, createWorkflowSnapshot, decideWorkflow, submitWorkflowArtifact, workEventId,
  type WorkEvent, type WorkflowSnapshot,
} from "@agentx/contracts";
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

describe("a task fails", () => {
  it("makes step_ended failed, task_failed and a wait for the owner, from a block", () => {
    const blocked = blockWorkflow(approved(), "The checks failed: tests/a.test.ts: expected 1, got 2 (secret sk-test)", "2026-11-10T10:00:00.000Z");
    const list = events(approved(), blocked);
    expect(kinds(list)).toEqual(["step_ended", "task_failed", "waiting_changed"]);
    expect(list[0]).toMatchObject({ outcome: "failed" });
    expect(list[1]).toMatchObject({ reason: "blocked_implement", actor: { kind: "system" } });
    expect(list[2]).toMatchObject({ waitingOn: "person", personIds: [ownerId], reason: "blocked" });
    // The block's own words are nowhere in an event.
    expect(JSON.stringify(list)).not.toMatch(/checks failed|expected 1|sk-test|a\.test/u);
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

  it("makes pr_merged once, and the wait ends", () => {
    const merged = withPulls({ ...open, state: "COMPLETE", stage: "MERGED", outcome: "MERGED", revision: 10, updatedAt: "2026-11-10T11:00:00.000Z" }, [{ state: "MERGED", number: 7 }]);
    const list = events(open, merged);
    expect(list.filter((event) => event.kind === "pr_merged")).toHaveLength(1);
    expect(list.find((event) => event.kind === "pr_merged")).toMatchObject({ repository: "acme/api", number: 7, at: "2026-11-10T11:00:00.000Z", actor: { kind: "system" } });
    expect(kinds(list)).not.toContain("pr_opened");
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
