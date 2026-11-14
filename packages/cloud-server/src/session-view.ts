// A Cloud session as the app reads it (SessionViewSchema, `GET /v1/app/sessions/{id}`), built from Cloud's own session
// record and the Rovara Code task it points at. The task goes in as Code answered it: Cloud's task view is a subset of
// Code's, and the app reads it tolerantly. What Cloud doesn't track yet (followers, viewers, shares, approvals, cost)
// starts empty.
import type { WorkSession } from "./work-sessions.js";

/** The parts of Code's task view (DeveloperTaskView) the session reads; the whole task is passed through as the body. */
export interface CodeTask {
  taskId: string;
  title: string;
  project: string;
  status: "STARTING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "INTERRUPTED" | "CLOSED";
  workflow?: { state?: string };
  createdAt: string;
  updatedAt: string;
  [field: string]: unknown;
}

type SessionStatus = "starting" | "running" | "needs_person" | "stopped" | "succeeded" | "failed" | "cancelled";

/** Code's task status in Cloud's words: a workflow waiting on a person, or blocked, needs a person. */
export function sessionStatus(task: CodeTask): SessionStatus {
  if (task.status === "RUNNING" && (task.workflow?.state === "WAITING" || task.workflow?.state === "BLOCKED")) return "needs_person";
  const statuses: Record<CodeTask["status"], SessionStatus> = {
    STARTING: "starting", RUNNING: "running", SUCCEEDED: "succeeded", FAILED: "failed", INTERRUPTED: "failed", CANCELLED: "cancelled", CLOSED: "stopped",
  };
  return statuses[task.status];
}

const ENDED: ReadonlySet<SessionStatus> = new Set(["stopped", "succeeded", "failed", "cancelled"]);

export function sessionView(session: WorkSession, task: CodeTask, viewer: { developerId: string }, origin: string) {
  const status = sessionStatus(task);
  const owner = viewer.developerId === session.owner.developerId;
  const ended = ENDED.has(status);
  // What the viewer may do from the page; Code checks each again when it is pressed.
  const actions = ["watch", ...(ended ? [] : owner ? ["stop"] : ["take_over"]), ...(owner && status !== "stopped" ? ["close"] : [])];
  return {
    contractVersion: 1,
    sessionId: session.sessionId,
    kind: "task",
    mode: "delegate",
    title: task.title.trim() === "" ? "Task" : task.title,
    project: task.project,
    owner: session.owner,
    startedBy: { kind: "member", developerId: session.startedBy.developerId },
    where: { kind: "cloud" },
    status,
    ...(status === "failed" ? { lastRunFailed: true } : {}),
    cost: { spentUsd: 0, payer: { kind: "member", name: session.startedBy.name } },
    approvals: [],
    followers: 0,
    viewingNow: [],
    you: { level: owner ? "edit" : "view", owner, following: false, actions },
    link: `${origin.replace(/\/+$/u, "")}/s/${session.sessionId}`,
    bindings: [],
    legs: [],
    revision: session.revision,
    createdAt: session.createdAt,
    updatedAt: task.updatedAt,
    ...(ended ? { endedAt: task.updatedAt } : {}),
    body: { kind: "task", task },
  };
}
