// UX2 slice 2 item 1: ONE status model. Every stage and block reason maps to one state with words a person reads (no raw codes), a reason sentence for "Needs you" and "Failed", and a next
// step; a closed task reads Closed whatever its last run did; a budget pause says who can raise it.
import { describe, expect, it } from "vitest";
import { createWorkflowSnapshot, type WorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { NO_CODE_CHANGED_REASON } from "../../packages/contracts/src/no-change-findings.js";
import { WORKFLOW_BLOCK_REASONS } from "../../packages/contracts/src/index.js";
import {
  TASK_STATUS_STATES, TaskStatusSchema, budgetPauseNext, budgetRaisers, sessionTaskStatus, taskStatusFromSession, taskStatusNext, taskStatusText,
} from "../../packages/contracts/src/task-status.js";
import { taskStatusOf } from "../../packages/broker/src/agent-sessions/task-status.js";
import { sessionActionsFor } from "../../packages/broker/src/agent-sessions/access.js";

const taskId = "11111111-1111-4111-8111-111111111111";
const now = "2026-11-07T12:00:00.000Z";
const wf = (extra: Partial<WorkflowSnapshot>): WorkflowSnapshot => ({ ...createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now }), revision: 3, ...extra });
const RAW = /\b(STARTING|RUNNING|CLOSED|BLOCKED|WAITING|task_failed|setup_failed|PLAN_REVIEW|PLAN_CRITIQUE|needs_person)\b/u;

function said(status: ReturnType<typeof taskStatusOf>): string {
  TaskStatusSchema.parse(status);
  const text = `${taskStatusText(status)} ${status.next ?? ""} ${status.nextOthers ?? ""}`;
  expect(text).not.toMatch(RAW);
  return taskStatusText(status);
}

describe("the one status model", () => {
  it("names every stage with one of the owner's words", () => {
    expect(said(taskStatusOf({ workflow: wf({ stage: "UNDERSTAND", state: "RUNNING" }), closed: false }))).toBe("Understanding the request");
    expect(said(taskStatusOf({ workflow: wf({ stage: "PLAN", state: "RUNNING" }), closed: false }))).toBe("Planning");
    // The automated plan check is planning, never "no stage".
    expect(said(taskStatusOf({ workflow: wf({ stage: "PLAN_CRITIQUE", state: "RUNNING" }), closed: false }))).toBe("Planning");
    expect(said(taskStatusOf({ workflow: wf({ stage: "PLAN", state: "RUNNING", path: "FULL", reviewPhase: "DESIGN" }), closed: false }))).toBe("Reviewing the design");
    expect(said(taskStatusOf({ workflow: wf({ stage: "IMPLEMENT", state: "RUNNING" }), closed: false }))).toBe("Building");
    // Checks and reviews between runs need nobody: Checking, not "Waiting for a decision".
    expect(said(taskStatusOf({ workflow: wf({ stage: "VERIFY", state: "WAITING" }), closed: false }))).toBe("Checking");
    expect(said(taskStatusOf({ workflow: wf({ stage: "REVIEW", state: "WAITING" }), closed: false }))).toBe("Checking");
    expect(said(taskStatusOf({ workflow: wf({ stage: "WAIT_FOR_MERGE", state: "WAITING" }), closed: false }))).toBe("Ready to merge");
    expect(said(taskStatusOf({ workflow: wf({ stage: "MERGED", state: "COMPLETE" }), closed: true }))).toBe("Merged");
  });

  it("says why a blocked task stopped and what to do next, for every block reason", () => {
    const cases: Array<[Partial<WorkflowSnapshot>, RegExp]> = [
      [{ stage: "PLAN", state: "BLOCKED" }, /^Needs you: stopped while writing the coding plan$/u],
      [{ stage: "IMPLEMENT", state: "BLOCKED", blockReason: NO_CODE_CHANGED_REASON }, /^Needs you: no code changes were needed$/u],
      [{ stage: "IMPLEMENT", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.fixChangedNothing }, /didn't change any code/u],
      [{ stage: "VERIFY", state: "BLOCKED" }, /^Needs you: the checks didn't pass or couldn't run$/u],
      [{ stage: "REVIEW", state: "BLOCKED" }, /^Needs you: the reviews found problems or couldn't finish$/u],
      [{ stage: "PULL_REQUEST", state: "BLOCKED" }, /draft pull request didn't open/u],
      [{ stage: "WAIT_FOR_MERGE", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.pullRequestChanged }, /stopped following the pull request/u],
    ];
    for (const [shape, words] of cases) {
      const status = taskStatusOf({ workflow: wf(shape), closed: false });
      expect(status.state).toBe("needs_you");
      expect(said(status)).toMatch(words);
      expect(status.next, JSON.stringify(shape)).toBeDefined();
      // The app is where the actions are: the next step never sends a person to Slack.
      expect(status.next).not.toMatch(/Slack thread/u);
    }
    const checks = taskStatusOf({ workflow: wf({ stage: "VERIFY", state: "BLOCKED" }), closed: false });
    expect(checks.next).toBe("Send it back to coding, retry the checks, or close the task in Rovara.");
  });

  it("gives the owner and a teammate different next steps where they differ", () => {
    const review = taskStatusOf({ workflow: wf({ stage: "PLAN_REVIEW", state: "WAITING" }), closed: false });
    expect(said(review)).toBe("Needs you: the coding plan is waiting for approval");
    expect(taskStatusNext(review, true)).toBe("Approve or request changes in Rovara.");
    expect(taskStatusNext(review, false)).toBe("The task owner approves or requests changes in Rovara.");
  });

  it("reads Closed for a task its owner closed, whatever its last run did", () => {
    expect(said(taskStatusOf({ workflow: wf({ stage: "VERIFY", state: "BLOCKED" }), closed: true }))).toBe("Closed");
    // A plain task whose last run failed and that was then closed: Closed, not Failed or Cancelled.
    expect(said(taskStatusOf({ workflow: undefined, closed: true, sessionStatus: "failed", failureCategory: "task_failed" }))).toBe("Closed");
    expect(said(taskStatusOf({ workflow: wf({ stage: "CLOSED", state: "COMPLETE" }), closed: true }))).toBe("Closed");
  });

  it("says a failure's cause in words, never the category", () => {
    const failed = taskStatusOf({ workflow: undefined, closed: false, sessionStatus: "waiting", lastRunFailed: true, failureCategory: "setup_failed" });
    expect(said(failed)).toBe("Failed: the workspace could not be set up");
    expect(said(taskStatusOf({ workflow: undefined, closed: false, sessionStatus: "waiting", lastRunFailed: true, failureCategory: "something_new" }))).toBe("Failed: the run stopped with an error");
    expect(said(taskStatusOf({ workflow: wf({ stage: "PLAN", state: "RUNNING" }), closed: false, failedPrepare: true }))).toMatch(/^Failed: /u);
  });

  it("says a budget pause and who can raise the limit", () => {
    expect(said(taskStatusOf({ workflow: wf({ stage: "IMPLEMENT", state: "RUNNING" }), closed: false, budgetPaused: true }))).toBe("Paused: needs more budget");
    expect(budgetRaisers("project")).toBe("a project maintainer or an org admin");
    expect(budgetRaisers("org")).toBe("an org admin");
    expect(budgetRaisers("anything_else")).toBe("an org admin");
    expect(budgetPauseNext("task", false, true)).toBe("Rovara asked a project maintainer or an org admin to raise the limit; the work goes on once they do.");
    expect(budgetPauseNext("task", true, true)).toMatch(/^You can raise the limit/u);
  });

  it("maps every plain session status to a state, and reads an older summary through it", () => {
    for (const status of ["starting", "running", "needs_person", "paused", "waiting", "stopped", "succeeded", "failed", "cancelled", "unheard_of"]) {
      const mapped = taskStatusFromSession({ status });
      expect(TASK_STATUS_STATES).toContain(mapped.state);
      expect(taskStatusText(mapped)).not.toMatch(RAW);
    }
    expect(taskStatusText(sessionTaskStatus({ status: "cancelled" }))).toBe("Closed");
    expect(taskStatusText(sessionTaskStatus({ status: "running", display: { state: "checking" } }))).toBe("Checking");
    // A display a newer server wrote that this build can't read falls back to the plain status.
    expect(taskStatusText(sessionTaskStatus({ status: "running", display: { state: "teleporting" } }))).toBe("Building");
    expect(taskStatusText({ state: "teleporting" })).toBe("Status unavailable");
  });
});

describe("Stop and Retry are offered only where they apply (item 6)", () => {
  const editor = { level: "edit" as const, owner: true, orgAdmin: false };
  it("offers no Stop, Retry or steering on a merged or closed task", () => {
    for (const display of [{ state: "merged" }, { state: "closed" }]) {
      const actions = sessionActionsFor(editor, { status: "succeeded", display });
      expect(actions).not.toContain("stop");
      expect(actions).not.toContain("retry");
      expect(actions).not.toContain("steer");
      expect(actions).toContain("watch");
    }
    // Review I5: a run that ended cancelled reads Closed (never "Needs you"), and can still be retried.
    const cancelled = taskStatusOf({ workflow: undefined, closed: false, sessionStatus: "cancelled" });
    expect(cancelled).toMatchObject({ state: "closed", retryable: true });
    expect(sessionActionsFor(editor, { status: "cancelled", display: cancelled })).toContain("retry");
    // Positive control: a blocked workflow still offers Stop and Retry.
    expect(sessionActionsFor(editor, { status: "needs_person", workflowBlocked: true, display: { state: "needs_you", reason: "x" } })).toEqual(expect.arrayContaining(["stop", "retry"]));
  });
});

describe("review fixes: nothing that waits on nobody reads Needs you (I4, I5)", () => {
  it("reads a plain task whose run finished as Finished its run, not Needs you", () => {
    const finished = taskStatusOf({ workflow: undefined, closed: false, sessionStatus: "waiting" });
    expect(finished.state).toBe("finished_run");
    expect(said(finished)).toBe("Finished its run");
    expect(taskStatusFromSession({ status: "waiting" }).state).toBe("finished_run");
  });

  it("reads an ended session (every step ran, or a cancelled run) as Closed, never Needs you", () => {
    const passed = taskStatusOf({ workflow: wf({ stage: "CLOSED", state: "COMPLETE", outcome: "PASSED" }), closed: false, sessionStatus: "cancelled" });
    expect(passed.state).toBe("closed");
    expect(passed.next).toBe("Close the task when you are done with the changes.");
    expect(taskStatusOf({ workflow: undefined, closed: false, sessionStatus: "cancelled" }).state).toBe("closed");
    // A task its owner closed is never retryable.
    expect(taskStatusOf({ workflow: undefined, closed: true, sessionStatus: "cancelled" }).retryable).toBeUndefined();
  });
});
