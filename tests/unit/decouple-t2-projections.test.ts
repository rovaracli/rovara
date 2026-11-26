// DECOUPLE T2 (plan 9.10): the three server projections of Code's answers that were exact-shape (the merge risk, the People role, the session status) tolerate a value a newer Code adds.
// An unknown value never refuses the whole answer; it shows no action; the page keeps what it had.
import { describe, expect, it } from "vitest";
import { mergeReadinessAnswer } from "../../packages/cloud-server/src/merge-routes.js";
import { projectView } from "../../packages/cloud-server/src/people-routes.js";
import { WorkflowStateSchema } from "@agentx/contracts";
import { KNOWN_WORKFLOW_STATES, blockedReview, blockedStepRetry, liveTile, sessionRunning, sessionStatus, sessionView, type CodeTask } from "../../packages/cloud-server/src/session-view.js";
import { MergeReadinessReader } from "../../packages/ui/src/api/session-actions.js";
import { pressBound } from "../../packages/ui/src/screens/session/merge-facts.js";
import { SessionViewReaderSchema, SessionPeopleResponseReaderSchema, LiveTileReaderSchema } from "@agentx/contracts/web";
import { taskFixture, sessionPerson, SESSION_FIXTURE_ID } from "../web/support/session-fixture.js";

const HEAD = "a".repeat(40);
const readiness = (over: Record<string, unknown> = {}) => ({ mayMerge: true, ready: true, risk: "low", heads: [{ repositoryId: "acme/api", number: 7, headSha: HEAD }], pullRequests: [{ repositoryId: "acme/api", number: 7, url: "https://github.com/acme/api/pull/7" }], ...over });

describe("merge readiness: a risk word this Cloud does not know", () => {
  it("is read, with the risk left out, instead of refusing the whole answer", () => {
    const read = mergeReadinessAnswer(readiness({ risk: "critical", futureField: { any: "thing" } }));
    expect(read).toEqual({ mayMerge: true, ready: true, heads: [{ repositoryId: "acme/api", number: 7, headSha: HEAD }], pullRequests: [{ repositoryId: "acme/api", number: 7, url: "https://github.com/acme/api/pull/7" }] });
    expect("risk" in read).toBe(false);
  });
  it("keeps a known risk, and still refuses a risk that is not a word", () => {
    expect(mergeReadinessAnswer(readiness({ risk: "high" })).risk).toBe("high");
    for (const risk of [5, null, {}, "", "x".repeat(65)]) expect(() => mergeReadinessAnswer(readiness({ risk }))).toThrow();
  });
  it("offers no merge in the app without a known risk (the page falls back to GitHub), for an answer with no risk or one the page reads as unknown", () => {
    const without = MergeReadinessReader.parse(mergeReadinessAnswer(readiness({ risk: "critical" })));
    expect(pressBound(without)).toBe(false);
    const known = MergeReadinessReader.parse(mergeReadinessAnswer(readiness()));
    expect(pressBound(known)).toBe(true);
    // A newer Cloud server that sends a risk word and a field this page does not know: the reader keeps the field and reads the word as unknown; still no merge.
    const newer = MergeReadinessReader.parse(readiness({ risk: "critical", futureField: 1, pullRequests: [{ repositoryId: "acme/api", number: 7, extra: true }] }));
    expect(newer.risk).toBe("unknown");
    expect(pressBound(newer)).toBe(false);
    expect(newer["futureField"]).toBe(1);
  });
});

const PERSON = "11111111-1111-4111-8111-111111111111", OTHER = "22222222-2222-4222-8222-222222222222";
const peopleView = (people: unknown[]) => ({ revision: 3, orphaned: false, canManage: true, canTakeOwnership: false, addPeopleUrl: "https://slack.example/invite", people });

describe("People list: a role word this Cloud does not know", () => {
  it("is passed on as unknown (role and effective role), and the rest of the list reads", () => {
    const view = projectView(peopleView([
      { personId: PERSON, name: "Ada", role: "owner", you: true, effectiveRole: "owner", method: "github" },
      { personId: OTHER, name: "Cal", role: "auditor", you: false, effectiveRole: "auditor", method: "passkey", futureField: 1 },
    ]));
    expect(view?.people).toEqual([
      { personId: PERSON, name: "Ada", role: "owner", you: true, effectiveRole: "owner", method: "github" },
      { personId: OTHER, name: "Cal", role: "unknown", you: false, effectiveRole: "unknown" },
    ]);
  });
  it("never turns an unknown word into owner, and still refuses a role that is not a word", () => {
    const view = projectView(peopleView([{ personId: PERSON, name: "Ada", role: "owner-ish", you: true, effectiveRole: "owner-ish" }]));
    expect(view?.people[0]?.["role"]).toBe("unknown");
    for (const role of [5, null, undefined, {}, ""]) expect(projectView(peopleView([{ personId: PERSON, name: "Ada", role, you: true, effectiveRole: null }]))).toBeUndefined();
    expect(projectView(peopleView([{ personId: PERSON, name: "Ada", role: "owner", you: true }]))).toBeUndefined();
  });
  it("is read by the page's reader as unknown", () => {
    const view = projectView(peopleView([{ personId: OTHER, name: "Cal", role: "auditor", you: false, effectiveRole: "auditor" }]))!;
    const read = SessionPeopleResponseReaderSchema.parse({ people: view });
    expect(read.people.people[0]?.role).toBe("unknown");
    expect(read.people.people[0]?.effectiveRole).toBe("unknown");
  });
});

const sessionRecord = (taskId: string) => ({ sessionId: SESSION_FIXTURE_ID, taskId, project: "payments", owner: sessionPerson, startedBy: sessionPerson, createdAt: "2026-10-23T12:00:00.000Z", revision: 1 });
const taskWith = (status: string): CodeTask => ({ ...taskFixture(), status }) as unknown as CodeTask;

describe("session status: a Code task status this Cloud does not know", () => {
  it.each(["PAUSED", "constructor", "toString", "", "running"])("reads %j as unknown, never as running, failed or ended", (status) => {
    expect(sessionStatus(taskWith(status))).toBe("unknown");
  });
  it("keeps the known statuses as they were", () => {
    expect(["STARTING", "RUNNING", "SUCCEEDED", "FAILED", "INTERRUPTED", "CANCELLED", "CLOSED"].map((status) => sessionStatus(taskWith(status))))
      .toEqual(["starting", "running", "succeeded", "failed", "failed", "cancelled", "stopped"]);
  });
  it("gives a session view with the task and no new action: no Stop, no end time, no failure mark, and the page reads it", () => {
    const task = taskWith("PAUSED");
    const view = sessionView(sessionRecord(task.taskId), task, sessionPerson, "https://cell.example");
    expect(view.status).toBe("unknown");
    expect(view.you.actions).toEqual(["watch", "comment"]);
    expect("endedAt" in view).toBe(false);
    expect("lastRunFailed" in view).toBe(false);
    const read = SessionViewReaderSchema.parse(view);
    expect(read.status).toBe("unknown");
    expect(read.body.kind === "task" && read.body.task.taskId).toBe(task.taskId);
  });
  // Pre-review S2: an unknown status is not "running" (it stays off the project's Live board, which lists running work) and offers no Retry.
  it.each(["PAUSED", "constructor", ""])("%j is not running: it stays off the Live board", (status) => {
    expect(sessionRunning(taskWith(status))).toBe(false);
  });
  it("keeps the starting and running statuses on the Live board and the ended ones off it", () => {
    expect(["STARTING", "RUNNING", "SUCCEEDED", "FAILED", "INTERRUPTED", "CANCELLED", "CLOSED"].map((status) => sessionRunning(taskWith(status)))).toEqual([true, true, false, false, false, false, false]);
  });
  it("offers no Retry on an unknown status even when the workflow is blocked at a retryable step, and still offers it on a known one", () => {
    const blocked = { workflow: { stage: "PLAN", state: "BLOCKED", revision: 16 } };
    for (const status of ["PAUSED", "constructor", ""]) {
      const task = { ...taskWith(status), ...blocked } as unknown as CodeTask;
      expect(blockedStepRetry(task)).toBeUndefined();
      expect(blockedReview(task)?.retry).toBeUndefined();
      expect(sessionView(sessionRecord(task.taskId), task, sessionPerson, "https://cell.example").you.actions).not.toContain("retry");
    }
    const known = { ...taskWith("FAILED"), ...blocked } as unknown as CodeTask;
    expect(blockedStepRetry(known)).toEqual({ expectedRevision: 16 });
    expect(sessionView(sessionRecord(known.taskId), known, sessionPerson, "https://cell.example").you.actions).toContain("retry");
  });
  // Opus S5 (DEC 540): a WORKFLOW state this build does not know, on a task whose status is SUCCEEDED or RUNNING, is not "Running" (the old `state !== "COMPLETE"` read it so).
  it("keeps the known workflow states equal to Code's WorkflowStateSchema", () => {
    expect([...KNOWN_WORKFLOW_STATES].sort()).toEqual([...WorkflowStateSchema.options].sort());
  });
  it.each([["SUCCEEDED", "ON_HOLD_FUTURE"], ["RUNNING", "ON_HOLD_FUTURE"], ["SUCCEEDED", "constructor"], ["RUNNING", ""]])("a %s task whose workflow state is %j reads as unknown: not running, not on the Live board, no Stop, Close or Retry, plain words", (status, state) => {
    const task = { ...taskWith(status), workflow: { stage: "PLAN", state, revision: 16 } } as unknown as CodeTask;
    expect(sessionStatus(task)).toBe("unknown");
    expect(sessionRunning(task)).toBe(false);
    const actions = sessionView(sessionRecord(task.taskId), task, sessionPerson, "https://cell.example").you.actions;
    expect(actions).toEqual(["watch", "comment"]);
    const tile = liveTile(sessionRecord(task.taskId), task, sessionPerson, "https://cell.example");
    expect(tile.status).toBe("unknown"); expect(tile.statusWords).toBe("Status unavailable"); expect(tile.needsYou).toBe(false);
    expect(blockedStepRetry(task)).toBeUndefined();
  });
  it("keeps every known workflow state reading as before", () => {
    const read = (status: string, state: string) => sessionStatus({ ...taskWith(status), workflow: { stage: "PLAN", state, revision: 1 } });
    expect([["SUCCEEDED", "READY"], ["SUCCEEDED", "RUNNING"], ["SUCCEEDED", "WAITING"], ["SUCCEEDED", "BLOCKED"], ["SUCCEEDED", "COMPLETE"], ["RUNNING", "RUNNING"]].map(([status, state]) => read(status!, state!)))
      .toEqual(["running", "running", "needs_person", "needs_person", "succeeded", "running"]);
  });
  it("gives a Live tile with plain words and no needs-you mark", () => {
    const task = taskWith("PAUSED");
    const tile = liveTile(sessionRecord(task.taskId), task, sessionPerson, "https://cell.example");
    expect(tile.status).toBe("unknown");
    expect(tile.statusWords).toBe("Status unavailable");
    expect(tile.needsYou).toBe(false);
    expect(LiveTileReaderSchema.parse(tile).status).toBe("unknown");
  });
});
