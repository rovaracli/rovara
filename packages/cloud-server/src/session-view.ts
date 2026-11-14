// A Cloud session as the app reads it (SessionViewSchema, `GET /v1/app/sessions/{id}`), built from Cloud's own session
// record and the Rovara Code task it points at. The task goes in as Code answered it: Cloud's task view is a subset of
// Code's, and the app reads it tolerantly. A plan waiting for the owner's review is the owner's approval. Someone the
// task is shared with (a reader in Code, spec 067) reads it at `view` and may only watch. Cost starts empty.
import type { WorkSession } from "./work-sessions.js";

/** The parts of Code's task view (DeveloperTaskView) the session reads; the whole task is passed through as the body. */
export interface CodeTask {
  taskId: string;
  title: string;
  project: string;
  status: "STARTING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "INTERRUPTED" | "CLOSED";
  workflow?: { stage?: string; state?: string; revision?: number; artifacts?: Array<{ type?: string; version?: number; sha256?: string }> };
  pullRequests?: Array<{ repository?: string; number?: number; url?: string; state?: string }>;
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

/** The plan waiting for review on this task: the workflow's revision and the newest plan's digest. Undefined when no plan waits. */
export function waitingPlan(task: CodeTask): { revision: number; digest: string; version: number } | undefined {
  const workflow = task.workflow;
  if (task.status !== "RUNNING" || workflow?.stage !== "PLAN_REVIEW" || workflow.state !== "WAITING" || typeof workflow.revision !== "number") return undefined;
  let newest: { version: number; sha256: string } | undefined;
  for (const artifact of workflow.artifacts ?? []) {
    if (artifact.type === "plan" && typeof artifact.sha256 === "string" && typeof artifact.version === "number" && (newest === undefined || artifact.version > newest.version)) {
      newest = { version: artifact.version, sha256: artifact.sha256 };
    }
  }
  return newest === undefined ? undefined : { revision: workflow.revision, digest: newest.sha256, version: newest.version };
}

/** The confirmation page for a session's plan (approve.ts); its id fits the app's confirm-link rule. */
export const approvalUrl = (origin: string, sessionId: string) => `${origin.replace(/\/+$/u, "")}/v1/app/approve/plan-${sessionId}`;

const ENDED: ReadonlySet<SessionStatus> = new Set(["stopped", "succeeded", "failed", "cancelled"]);

/** Who follows the session and who is looking at it now, for one viewer. */
export interface SessionPeople { followers: number; following: boolean; viewingNow: Array<{ developerId: string; name: string }> }

/** Follow state from the session record: the owner always follows. */
export function followState(session: WorkSession, developerId: string): { followers: number; following: boolean } {
  const followers = session.followers ?? [];
  return { followers: followers.length, following: developerId === session.owner.developerId || followers.some((person) => person.developerId === developerId) };
}

export function sessionView(session: WorkSession, task: CodeTask, viewer: { developerId: string }, origin: string, people?: SessionPeople) {
  const status = sessionStatus(task);
  const owner = viewer.developerId === session.owner.developerId;
  const ended = ENDED.has(status);
  // What the viewer may do from the page; Code checks each again when it is pressed. Someone it is shared with only watches:
  // Code lets a task's readers read it and nothing else (take-over works only for tasks shared in Slack).
  const actions = ["watch", ...(owner && !ended ? ["stop"] : []), ...(owner && status !== "stopped" ? ["close"] : [])];
  const follow = people ?? { ...followState(session, viewer.developerId), viewingNow: [] };
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
    // Only the task's owner decides a plan in Code, so only the owner is shown it.
    approvals: owner && waitingPlan(task) !== undefined ? [{ approvalId: `plan-${session.sessionId}`, title: "Review the plan", confirmUrl: approvalUrl(origin, session.sessionId) }] : [],
    followers: follow.followers,
    viewingNow: follow.viewingNow,
    you: { level: owner ? "edit" : "view", owner, following: follow.following, actions },
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
