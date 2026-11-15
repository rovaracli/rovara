// A Cloud session as the app reads it (SessionViewSchema, `GET /v1/app/sessions/{id}`), built from Cloud's own session
// record and the Rovara Code task it points at. The task goes in as Code answered it: Cloud's task view is a subset of
// Code's, and the app reads it tolerantly. A plan waiting for the owner's review is the owner's approval. Someone the
// task is shared with (a reader in Code, spec 067) reads it at `view` and may only watch. Cost starts empty.
import { createHash } from "node:crypto";
import type { WorkSession } from "./work-sessions.js";

/** The parts of Code's task view (DeveloperTaskView) the session reads; the whole task is passed through as the body. */
export interface CodeTask {
  taskId: string;
  title: string;
  project: string;
  status: "STARTING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "INTERRUPTED" | "CLOSED";
  workflow?: {
    stage?: string; state?: string; revision?: number; artifacts?: Array<{ type?: string; version?: number; sha256?: string }>;
    /** The code the reviews look at, and the checks that ran on it (Code's workflow snapshot). */
    candidate?: { digest?: string };
    verification?: { candidateDigest?: string; reviewOnly?: boolean; results?: Array<{ status?: string }> };
    reviews?: Array<{ role?: string; status?: string; failureReason?: string; candidateDigest?: string; findings?: Array<{ advisory?: boolean; origin?: string; text?: string; file?: string; line?: number; severity?: string } | string> }>;
    /** Findings the owner accepted, per candidate (Code's acceptedFindings): they no longer block that code. */
    acceptedFindings?: Array<{ candidateDigest?: string; role?: string; fingerprint?: string }>;
  };
  pullRequests?: Array<{ repository?: string; number?: number; url?: string; state?: string }>;
  createdAt: string;
  updatedAt: string;
  [field: string]: unknown;
}

type SessionStatus = "starting" | "running" | "needs_person" | "stopped" | "succeeded" | "failed" | "cancelled";

/**
 * Whether the task's workflow is still going. Code's task `status` is its worker's LAST RUN (deriveTaskStatus), so between steps (a plan
 * waiting for review, a blocked review, a pull request waiting for merge, the next step queued) it reads SUCCEEDED although the task is not
 * done. While the workflow is not COMPLETE and the task is neither closed nor cancelled, the workflow decides.
 */
const workflowOpen = (task: CodeTask): boolean =>
  task.workflow !== undefined && task.workflow.state !== "COMPLETE" && (task.status === "RUNNING" || task.status === "SUCCEEDED");

/** Code's task status in Cloud's words: a workflow waiting on a person, or blocked, needs a person; one between its own steps is still running. */
export function sessionStatus(task: CodeTask): SessionStatus {
  if (workflowOpen(task)) return task.workflow!.state === "WAITING" || task.workflow!.state === "BLOCKED" ? "needs_person" : "running";
  const statuses: Record<CodeTask["status"], SessionStatus> = {
    STARTING: "starting", RUNNING: "running", SUCCEEDED: "succeeded", FAILED: "failed", INTERRUPTED: "failed", CANCELLED: "cancelled", CLOSED: "stopped",
  };
  return statuses[task.status];
}

/** The plan waiting for review on this task: the workflow's revision and the newest plan's digest. Undefined when no plan waits. */
export function waitingPlan(task: CodeTask): { revision: number; digest: string; version: number } | undefined {
  const workflow = task.workflow;
  if (!workflowOpen(task) || workflow?.stage !== "PLAN_REVIEW" || workflow.state !== "WAITING" || typeof workflow.revision !== "number") return undefined;
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
  const actions = ["watch", ...(owner && blockedReview(task)?.retry !== undefined ? ["retry"] : []), ...(owner && !ended ? ["stop"] : []), ...(owner && status !== "stopped" ? ["close"] : [])];
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

const STATUS_WORDS: Record<SessionStatus, string> = {
  starting: "Starting", running: "Running", needs_person: "Waiting for you", stopped: "Stopped", succeeded: "Done", failed: "Failed", cancelled: "Cancelled",
};
const STEP_WORDS: Record<string, string> = {
  PLAN: "Planning", PLAN_REVIEW: "Plan review", IMPLEMENT: "Coding", VERIFY: "Checking", REVIEW: "Reviewing", PULL_REQUEST: "Pull request",
};

/** Whether the session is still going: not stopped, done, failed or cancelled. */
export const sessionRunning = (task: CodeTask): boolean => !ENDED.has(sessionStatus(task));

/**
 * One session as a Live tile (LiveTileSchema), for the person reading it, from the same parts as the session page: Code's task,
 * Cloud's followers and who is viewing. Only the owner is told a plan waits on them, with the link to Cloud's approval page.
 */
export function liveTile(session: WorkSession, task: CodeTask, viewer: { developerId: string }, origin: string, people?: SessionPeople) {
  const view = sessionView(session, task, viewer, origin, people);
  const plan = view.you.owner && waitingPlan(task) !== undefined;
  const step = task.workflow?.stage === undefined ? undefined : STEP_WORDS[task.workflow.stage];
  return {
    contractVersion: view.contractVersion,
    sessionId: view.sessionId,
    kind: view.kind,
    title: view.title,
    project: view.project,
    owner: view.owner,
    where: view.where,
    status: view.status,
    statusWords: blockedReview(task)?.unfinished === true ? "Review couldn't finish" : STATUS_WORDS[view.status],
    ...(step === undefined ? {} : { step }),
    ...(view.status === "failed" ? { lastRunFailed: true as const } : {}),
    costUsd: 0,
    viewingNow: view.viewingNow.slice(0, 5),
    viewingNowCount: view.viewingNow.length,
    needsYou: view.you.owner && view.status === "needs_person",
    following: view.you.following,
    actions: view.you.actions,
    ...(plan ? { approvalUrl: approvalUrl(origin, session.sessionId) } : {}),
    updatedAt: view.updatedAt,
  };
}

/** Why one review didn't finish, in Code's words (workflow-messages.ts REVIEW_FAILURES), never the reviewer's own output. */
const REVIEW_FAILURES: Record<string, string> = {
  RESPONSE_MISSING: "the reviewer gave no answer", RESPONSE_TOO_LARGE: "its answer was too long", INVALID_JSON: "its answer wasn't in the expected format",
  INVALID_SHAPE: "its answer wasn't in the expected format", TIMEOUT: "it ran out of time", INTERRUPTED: "it was stopped",
  CANDIDATE_CHANGED: "the code changed during the review", SESSION_FAILED: "the reviewer couldn't start", USAGE_UNAVAILABLE: "its usage couldn't be recorded",
  BASE_UNAVAILABLE: "the task's starting point wasn't recorded", DIFF_UNAVAILABLE: "the change couldn't be compared with the task's starting point",
};
const REVIEW_REASON_MAX = 200;

/**
 * A task stopped at review (Code's REVIEW/BLOCKED): why, said as Code says it in Slack, and the fence for retrying the reviews on the same checked
 * code, present only when Code would take it (the checks on exactly that code passed). Undefined for any other task. PrepLabsAI/Rovara-cloud#15.
 */
export function blockedReview(task: CodeTask): { reason: string; unfinished: boolean; retry?: { expectedRevision: number; candidateDigest: string } } | undefined {
  const workflow = task.workflow;
  if (!workflowOpen(task) || workflow?.stage !== "REVIEW" || workflow.state !== "BLOCKED") return undefined;
  const digest = workflow.candidate?.digest;
  const reviews = (workflow.reviews ?? []).filter((review) => digest !== undefined && review.candidateDigest === digest);
  const unfinished = reviews.filter((review) => review.status === "UNKNOWN" || review.status === "FAILED" || review.status === "INTERRUPTED");
  const issues = reviews.reduce((total, review) => total + (review.findings ?? []).filter((finding) => typeof finding !== "string" && finding.advisory !== true && finding.origin === "INTRODUCED").length, 0);
  const reason = unfinished.length > 0
    ? `A review couldn't finish (${unfinished.map((review) => `${review.role === "SECURITY" ? "security" : "code"} review: ${(review.failureReason === undefined ? undefined : REVIEW_FAILURES[review.failureReason]) ?? "it gave no usable answer"}`).join("; ")}). Nothing was sent to GitHub.`
    : issues > 0 ? `Reviews found ${String(issues)} ${issues === 1 ? "issue" : "issues"} in this change. Nothing was sent to GitHub.` : "The reviews couldn't finish. Nothing was sent to GitHub.";
  const results = workflow.verification?.results ?? [];
  const checked = digest !== undefined && workflow.verification?.candidateDigest === digest && typeof workflow.revision === "number"
    && (results.length > 0 || workflow.verification.reviewOnly === true) && results.every((result) => result.status === "PASS");
  return {
    reason: reason.length > REVIEW_REASON_MAX ? `${reason.slice(0, REVIEW_REASON_MAX - 3).trimEnd()}...` : reason,
    unfinished: unfinished.length > 0,
    ...(checked ? { retry: { expectedRevision: workflow.revision!, candidateDigest: digest } } : {}),
  };
}

/** One blocking review finding of the current code, with Code's own ID for it (workflowFindingFingerprint). */
export interface OpenFinding { findingId: string; role: "CRITIC" | "SECURITY"; text: string; file?: string; line?: number; severity?: string }
/** Code's limit on findings answered in one go (WORKFLOW_RESOLVE_FINDINGS_MAX). */
export const RESOLVE_FINDINGS_MAX = 20;

/**
 * The current code's blocking review findings, by Code's rules (openReviewFindings): from the reviews of the current candidate, a finding the change
 * introduced that is not advisory (a security finding always blocks), not already accepted for this code, each once, with the ID Code matches it by.
 */
export function openFindings(task: CodeTask): OpenFinding[] {
  const workflow = task.workflow;
  const digest = workflow?.candidate?.digest;
  if (digest === undefined) return [];
  const accepted = workflow?.acceptedFindings ?? [];
  const open = new Map<string, OpenFinding>();
  for (const role of ["CRITIC", "SECURITY"] as const) {
    for (const review of (workflow?.reviews ?? []).filter((entry) => entry.role === role && entry.candidateDigest === digest)) {
      for (const raw of review.findings ?? []) {
        const finding = typeof raw === "string" ? { text: raw } : raw;
        if (typeof raw !== "string" && !(raw.origin === "INTRODUCED" && (raw.advisory !== true || role === "SECURITY"))) continue;
        const text = finding.text ?? "";
        const findingId = createHash("sha256").update(JSON.stringify([role, text, finding.file ?? "", finding.line ?? 0])).digest("hex");
        if (accepted.some((entry) => entry.candidateDigest === digest && entry.role === role && entry.fingerprint === findingId) || open.has(findingId)) continue;
        open.set(findingId, { findingId, role, text, ...(finding.file === undefined ? {} : { file: finding.file }), ...(finding.line === undefined ? {} : { line: finding.line }), ...("severity" in finding && finding.severity !== undefined ? { severity: finding.severity } : {}) });
      }
    }
  }
  return [...open.values()];
}

/**
 * What the owner of a task stopped by review findings can do besides retrying (Rovara-cloud#25): send it back to coding with a note, or accept the
 * findings and let the pull request open. Present only for a task stopped at review with 1 to RESOLVE_FINDINGS_MAX blocking findings.
 */
export function reviewChoices(task: CodeTask): { findings: OpenFinding[]; expectedRevision: number; candidateDigest: string } | undefined {
  if (blockedReview(task) === undefined || typeof task.workflow?.revision !== "number" || task.workflow.candidate?.digest === undefined) return undefined;
  const findings = openFindings(task);
  if (findings.length === 0 || findings.length > RESOLVE_FINDINGS_MAX) return undefined;
  return { findings, expectedRevision: task.workflow.revision, candidateDigest: task.workflow.candidate.digest };
}

