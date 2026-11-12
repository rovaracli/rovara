// Spec 025 C7, C8: the notices a shared task's thread hears about, from the state table's stream.
// Pure: whether the task is shared is decided when a notice is delivered (Task 7).
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { isEvalRunMark } from "../lessons/eval-run.js";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { WORKFLOW_BLOCK_REASONS, WorkflowSnapshotSchema, type WorkflowSnapshot } from "@agentx/cloud-contracts";

export interface StreamRecord {
  eventID?: string;
  eventName?: string;
  dynamodb?: { ApproximateCreationDateTime?: number; NewImage?: Record<string, AttributeValue>; OldImage?: Record<string, AttributeValue> };
}
export type NoticeKind = "start" | "mode" | "closed" | "cancelled" | "ready" | "setup_failed" | "ended" | "pull_request" | "workflow" | "github_feedback" | "canvas_closeout" | "admin_change_dm" | "admin_change_outcome" | "admin_change_expiry" | "workflow_refusal" | "comment_nudge" | "people_dm" | "chatgpt_fallback" | "agent_report" | "spec_changed" | "spec_hold" | "settings_proof" | "design_wait" | "owner_stopped_dm" | "attention_dm";
export interface Notice {
  /** Fixed per change, so a repeated delivery posts once (C9). */
  id: string;
  kind: NoticeKind;
  /** When the change committed; changes before a task was shared are not posted. */
  at: string;
  taskId?: string;
  workspaceId?: string;
  operationId?: string;
  mode?: "view" | "continue";
  /** Spec 025 E13: the admin change a direct message is about. */
  changeId?: string;
  /** #217: the queue holds the notice until this time (at most 15 minutes); set only on a notice the notifier schedules itself. */
  notBefore?: string;
  /** Active immutable PR-feedback report announced by this notice. */
  feedbackReviewDigest?: string;
  /** Immutable closeout snapshot that an owner-authorized retry is allowed to resume. */
  manifestDigest?: string;
  /** Workflow snapshot revision to resume when verification failed before a manifest existed. */
  expectedWorkflowRevision?: number;
  peopleRequestId?: string;
  /** UX2 slice 2, an `attention_dm` notice: the sort key of the TASK_ATTENTION_DM row (one per person per batch) the notifier reads and posts; the notice holds no text. */
  attentionKey?: string;
  /** S2, an `owner_stopped_dm` notice: the sort key of the pending row (one per stop and per person) the notifier reads; the notice holds no text. */
  ownerStopKey?: string;
  /**
   * TE-4: a project's settings-proof notice carries everything the message says, taken from the stream's new image, so the notifier never reads or writes the project's partition: the check it is
   * about, the project's name, the person to tell (a Slack user id) and the check's reason (already a redacted one-liner, at most 400 characters). The notifier's own once-marker is under NOTIFY_SETTINGS_PROOF#.
   */
  proofCheckId?: string;
  proofProject?: string;
  proofSlackUserId?: string;
  proofReason?: string;
  /** Which part of the item the notice is about: a browser save that failed, or a change an API key sent that was not saved. */
  proofPart?: "saved" | "held";
  /** A workflow notice's revision: delivered only while the task is still at it, so a stale step is never said. */
  workflowRevision?: number;
  /** DR10, a `design_wait` notice: which step of the wait it is (a reminder at 24 h or 72 h, the park, the close). The notifier reads the NOTIFY row of the task at `workflowRevision` and this step; the notice holds no text. */
  designWaitStep?: "24h" | "72h" | "parked" | "closed";
  /** A workflow notice for the step a closed required pull request's reopening started: AgentX follows it again. */
  pullRequestReopened?: true;
  /** With `pullRequestReopened`: the pull requests that were reopened, by repository and number. */
  reopenedPullRequests?: Array<{ repositoryId: string; number: number }>;
}

/** Stable key shared by notice production and the owner-decision latency measurement. */
export const feedbackReviewNoticeId = (taskId: string, reviewDigest: string, workflowRevision: number): string =>
  `${taskId}:feedback_review:${reviewDigest}:${workflowRevision}`;

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"]);
/** Spec 025 E2: the statuses an admin change ends in. */
const ENDED_CHANGE = new Set(["applied", "declined", "expired", "failed"]);
const text = (value: unknown) => (typeof value === "string" ? value : "");
const record = (value: unknown) => (value && typeof value === "object" ? (value as Record<string, unknown>) : undefined);

export function noticesOf(previous: Record<string, unknown> | undefined, next: Record<string, unknown>, at: string, eventId: string): Notice[] {
  switch (next.entityType) {
    case "DEVELOPER_TASK": {
      const taskId = text(next.taskId);
      const before = record(previous?.share);
      const after = record(next.share);
      const notices: Notice[] = [];
      const beforeWorkflow = record(previous?.workflow);
      const afterWorkflow = record(next.workflow);
      const beforeReview = record(beforeWorkflow?.feedbackReview);
      const afterReview = record(afterWorkflow?.feedbackReview);
      const beforeReviewRef = record(beforeReview?.reviewRef);
      const afterReviewRef = record(afterReview?.reviewRef);
      const oldNotes = Array.isArray(beforeWorkflow?.feedbackNotes) ? beforeWorkflow.feedbackNotes.length : 0;
      const newNotes = Array.isArray(afterWorkflow?.feedbackNotes) ? afterWorkflow.feedbackNotes.length : 0;
      // A complete report is said again after a new note; any other (failed, timed out, interrupted: said with Retry
      // review) once, by its report.
      // The failing checks added to (or taken off) a waiting card change what the owner decides on, so the card is said again (Plan 6 Task 16).
      const ciChanged = beforeReview?.status === "PENDING" && record(afterWorkflow?.feedbackCiFailures)?.digest !== record(beforeWorkflow?.feedbackCiFailures)?.digest;
      if (afterReview?.status === "PENDING" && typeof afterReviewRef?.sha256 === "string"
        && ((afterReviewRef.status === "COMPLETE" && (afterReviewRef.sha256 !== beforeReviewRef?.sha256 || newNotes !== oldNotes || ciChanged))
          || (afterReviewRef.status !== "COMPLETE" && afterReviewRef.sha256 !== beforeReviewRef?.sha256))) {
        notices.push({ id: feedbackReviewNoticeId(taskId, afterReviewRef.sha256, Number(afterWorkflow?.revision)), kind: "github_feedback", taskId, at,
          feedbackReviewDigest: afterReviewRef.sha256 });
      } else if (afterWorkflow !== undefined && beforeWorkflow !== undefined && afterWorkflow.revision !== beforeWorkflow.revision && eventId !== "") {
        // Gap 5: every step change, keyed by its revision; the notifier words it, or says nothing, when it is delivered.
        // The task's first step is not one: the start message (or Slack's Quick or Full answer) already says it.
        const reopened = beforeWorkflow.state === "BLOCKED" && beforeWorkflow.blockReason === WORKFLOW_BLOCK_REASONS.pullRequestClosed
          && afterWorkflow.stage === "WAIT_FOR_MERGE" && afterWorkflow.state === "WAITING";
        // Which of the task's pull requests were closed before and are open now.
        const pullRequests = (value: Record<string, unknown> | undefined) => (Array.isArray(value?.pullRequests) ? value.pullRequests as Array<Record<string, unknown>> : []);
        const reopenedNumbers = reopened ? pullRequests(afterWorkflow).filter((pr) => pr.state === "OPEN" && pullRequests(beforeWorkflow)
          .some((earlier) => earlier.repositoryId === pr.repositoryId && earlier.number === pr.number && earlier.state === "CLOSED")).map((pr) => ({ repositoryId: String(pr.repositoryId), number: Number(pr.number) })) : [];
        notices.push({ id: `${taskId}:workflow:${String(afterWorkflow.revision)}`, kind: "workflow", taskId, at, workflowRevision: Number(afterWorkflow.revision),
          ...(reopened ? { pullRequestReopened: true as const, reopenedPullRequests: reopenedNumbers } : {}) });
      }
      // AUTOFIX: Rovara wrote why it asks for the blocked step after the step's own card; the card (or a post of its own) carries it.
      const afterAsk = record(next.autofixAsk);
      const beforeAsk = record(previous?.autofixAsk);
      if (afterAsk !== undefined && eventId !== "" && typeof afterAsk.workflowRevision === "number" && afterAsk.workflowRevision === afterWorkflow?.revision
        && (beforeAsk === undefined || beforeAsk.workflowRevision !== afterAsk.workflowRevision || beforeAsk.at !== afterAsk.at)) {
        notices.push({ id: `${taskId}:autofix:${afterAsk.workflowRevision}`, kind: "workflow", taskId, at, workflowRevision: afterAsk.workflowRevision });
      }
      if (after !== undefined && before === undefined) notices.push({ id: `${taskId}:start`, kind: "start", taskId, at });
      // A mode notice is named by its stream event; without one, two changes would collapse into one ID.
      else if (after !== undefined && before !== undefined && after.mode !== before.mode && eventId !== ""
        && !(afterWorkflow?.definitionId === "agentx-task-to-pr" && after.mode === "view")) {
        notices.push({ id: `${taskId}:mode:${eventId}`, kind: "mode", taskId, at, mode: after.mode === "continue" ? "continue" : "view" });
      }
      // A stored NULL counts as unset.
      if (next.closedAt != null && previous?.closedAt == null) notices.push({ id: `${taskId}:closed`, kind: "closed", taskId, at });
      const terminalWorkflow = (value: Record<string, unknown> | undefined): boolean => value?.state === "COMPLETE"
        && ((value.stage === "MERGED" && value.outcome === "MERGED") || value.stage === "CLOSED");
      if ((terminalWorkflow(afterWorkflow) && !terminalWorkflow(beforeWorkflow)) || (next.closedAt != null && previous?.closedAt == null)) {
        const revision = afterWorkflow?.revision;
        const closeoutId = next.closedAt != null && previous?.closedAt == null ? "closed" : typeof revision === "number" ? String(revision) : "terminal";
        notices.push({ id: `${taskId}:canvas_closeout:${closeoutId}`, kind: "canvas_closeout", taskId, at });
      }
      const beforeRetry = record(previous?.canvasCloseoutRetry);
      const afterRetry = record(next.canvasCloseoutRetry);
      const dispatchAttempt = typeof afterRetry?.dispatchAttempt === "number" && Number.isInteger(afterRetry.dispatchAttempt)
        ? afterRetry.dispatchAttempt : 1;
      if (afterRetry?.requestId !== undefined && typeof afterRetry.workflowRevision === "number"
        && (afterRetry.requestId !== beforeRetry?.requestId || afterRetry.dispatchAttempt !== beforeRetry?.dispatchAttempt)) {
        notices.push({ id: `${taskId}:canvas_closeout_retry:${text(afterRetry.requestId)}:${dispatchAttempt}`, kind: "canvas_closeout", taskId, at,
          expectedWorkflowRevision: afterRetry.workflowRevision,
          ...(typeof afterRetry.manifestDigest === "string" ? { manifestDigest: afterRetry.manifestDigest } : {}) });
      }
      return notices;
    }
    // DR10: a design review that waits on people has a reminder, its park or its close to say. Once, when the row is written; the row holds the people and the codes, and the notifier words it.
    case "DESIGN_WAIT_NOTIFY": {
      const taskId = text(next.taskId);
      const step = text(next.step);
      if (previous !== undefined || taskId === "" || next.status !== "PENDING" || typeof next.workflowRevision !== "number" || !Number.isSafeInteger(next.workflowRevision) || next.workflowRevision < 1) return [];
      if (step !== "24h" && step !== "72h" && step !== "parked" && step !== "closed") return [];
      return [{ id: `${taskId}:design_wait:${next.workflowRevision}:${step}`, kind: "design_wait", taskId, at, workflowRevision: next.workflowRevision, designWaitStep: step }];
    }
    case "DEVELOPER_TASK_POINTER":
      return next.cancelledAt != null && previous?.cancelledAt == null
        ? [{ id: `${text(next.taskId)}:cancelled`, kind: "cancelled", taskId: text(next.taskId), at }]
        : [];
    case "OPERATION": {
      if (!TERMINAL.has(text(next.status)) || TERMINAL.has(text(previous?.status))) return [];
      const base = { workspaceId: text(next.workspaceId), operationId: text(next.id), at };
      // #342: a task that left its owner's ChatGPT plan says so in its thread when it ends, whoever asked for it.
      const fallback = typeof next.chatgptFallback === "string" ? [{ ...base, id: `${base.operationId}:chatgpt_fallback`, kind: "chatgpt_fallback" as const }] : [];
      // Only the developer's own operations: the Slack service answers a teammate's (C8).
      if (record(next.requestedBy)?.kind !== "developer") return fallback;
      return [...fallback, ...developerOperationNotices(next, base)];
    }
    // Task 19: a Slack press the broker refused, told privately to whoever pressed. Once, when it is written.
    case "WORKFLOW_ACTION_REFUSAL": {
      const taskId = text(next.taskId);
      const sk = text(next.sk);
      if (previous !== undefined || taskId === "" || !sk.startsWith("REFUSAL#")) return [];
      return [{ id: `${taskId}:refusal:${sk}`, kind: "workflow_refusal", taskId, at }];
    }
    // Spec 061 FR-044: a commenter's nudge window opened; the notifier posts one batched nudge when it is due.
    case "TASK_COMMENT_NUDGE": {
      const taskId = text(next.taskId);
      const nudgeId = text(next.nudgeId);
      const dueAt = text(next.dueAt);
      if (taskId === "" || nudgeId === "" || dueAt === "" || Number.isNaN(Date.parse(dueAt)) || previous?.nudgeId === nudgeId) return [];
      // Stamped with the window's own start, to the millisecond, so it compares exactly with the share's time.
      const windowStart = text(next.windowStart);
      return [{ id: `${taskId}:nudge:${nudgeId}`, kind: "comment_nudge", taskId, at: Number.isNaN(Date.parse(windowStart)) ? at : windowStart, notBefore: dueAt }];
    }
    // S2: Rovara stopped a step because the task's owner lost their place; each person who could take the task over hears once (one row per stop and person).
    case "TASK_OWNER_STOPPED_NOTIFICATION": {
      const taskId = text(next.taskId);
      const sk = text(next.sk);
      if (previous !== undefined || taskId === "" || !sk.startsWith("OWNER_STOP_NOTIFY#") || next.status !== "PENDING") return [];
      return [{ id: `${taskId}:owner_stopped:${sk.slice("OWNER_STOP_NOTIFY#".length)}`, kind: "owner_stopped_dm", taskId, ownerStopKey: sk, at }];
    }
    // UX2 slice 2 item 5: a batch of task notifications for one person, worded by the broker's sweep, waits to be sent as a Slack direct message. Once, when it is written.
    case "TASK_ATTENTION_DM": {
      const sk = text(next.sk);
      if (previous !== undefined || next.pk !== "NOTIFY_DM" || sk === "" || sk.length > 300 || next.status !== "PENDING") return [];
      return [{ id: `attention_dm:${sk}`, kind: "attention_dm", at, attentionKey: sk }];
    }
    case "TASK_PEOPLE_NOTIFICATION": {
      const taskId = text(next.taskId);
      const requestId = text(next.requestId);
      if (previous !== undefined || taskId === "" || requestId === "" || next.status !== "PENDING") return [];
      return [{ id: `${taskId}:people:${requestId}`, kind: "people_dm", taskId, peopleRequestId: requestId, at }];
    }
    // Plan 3, Task 22 (R4-2): an agent-step run's final report, prepared for a project's channel, waits to be posted. Once, when it is written.
    case "AGENT_REPORT_POST": {
      const taskId = text(next.taskId);
      if (previous !== undefined || taskId === "" || next.status !== "PENDING") return [];
      return [{ id: `${taskId}:agent_report`, kind: "agent_report", taskId, at }];
    }
    // Wire lane D (MD-1): the owner hears when people changed the spec pull request ("Re-plan or keep?"), and when the spec could not be made and the code pull requests are on hold. Once per change.
    case "SPEC_STATE": {
      const taskId = text(next.taskId);
      if (taskId === "") return [];
      const edit = record(next.editPrompt);
      const earlier = record(previous?.editPrompt);
      if (edit?.status === "open" && typeof edit.headSha === "string" && earlier?.headSha !== edit.headSha) return [{ id: `${taskId}:spec_changed:${edit.headSha}`, kind: "spec_changed", taskId, at }];
      if (next.status === "failed" && previous?.status !== "failed") return [{ id: `${taskId}:spec_hold:${String(next.revision)}`, kind: "spec_hold", taskId, at }];
      return [];
    }
    // TE-4: commands a person saved in a browser failed their check, or a change they sent with an API key ended without being saved; the person hears once, per check.
    case "PROJECT_SETTINGS_PROOF": {
      const notices: Notice[] = [];
      for (const part of ["saved", "held"] as const) {
        const now = record(next[part]);
        const earlier = record(previous?.[part]);
        const checkId = text(now?.checkRequestId);
        const ended = part === "saved" ? now?.status === "failed" : now?.status === "failed" || now?.status === "stale" || now?.status === "refused" || now?.status === "not_started";
        if (!ended || checkId === "" || typeof now?.noticeAt !== "string" || typeof now.slackUserId !== "string") continue;
        if (earlier?.checkRequestId === checkId && typeof earlier.noticeAt === "string") continue;
        const project = text(next.project);
        if (next.entityType !== "PROJECT_SETTINGS_PROOF" || project === "") continue;
        const reason = typeof now.reason === "string" ? now.reason.slice(0, 400) : undefined;
        notices.push({ id: `${text(next.pk)}:settings_proof:${part}:${checkId}`, kind: "settings_proof", proofCheckId: checkId, proofProject: project, proofSlackUserId: now.slackUserId, ...(reason === undefined ? {} : { proofReason: reason }), proofPart: part, at });
      }
      return notices;
    }
    case "ADMIN_CHANGE": {
      // Spec 025 E13: the Slack step started, or a change with a message ended. Only stored
      // statuses count: a press that left the change pending (Task 7's `unavailable`) keeps the
      // buttons. A TTL removal has no new image and never reaches here.
      const changeId = text(next.changeId);
      if (changeId === "") return [];
      if (next.status === "pending" && next.slackRequestedAt != null && previous?.slackRequestedAt == null) return [{ id: `${changeId}:dm`, kind: "admin_change_dm", changeId, at }];
      // A message recorded after the change ended (the change was answered while it posted) is edited too.
      const ended = ENDED_CHANGE.has(text(next.status));
      if (ended && next.dm != null && (previous?.status !== next.status || previous?.dm == null)) return [{ id: `${changeId}:outcome`, kind: "admin_change_outcome", changeId, at }];
      return [];
    }
    default:
      return [];
  }
}

const isTime = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));

/**
 * Ruling F7: when the change committed, to the millisecond, from the new image's own time (task
 * and operation records carry `updatedAt`; a cancel stamps the pointer's `cancelledAt`), so it
 * compares exactly with a share's `sharedAt`. The stream's time has whole seconds and can come
 * before `sharedAt`, so it is only the fallback.
 */
function changedAt(next: Record<string, unknown>, approximate: number | undefined): string {
  if (isTime(next.updatedAt)) return new Date(next.updatedAt).toISOString();
  if (next.entityType === "DEVELOPER_TASK_POINTER" && isTime(next.cancelledAt)) return new Date(next.cancelledAt).toISOString();
  const seconds = typeof approximate === "number" && Number.isFinite(approximate) ? approximate : Date.now() / 1000;
  return new Date(seconds * 1000).toISOString();
}

/** A stream record that could not be read: its event name and ID only, never an error message. */
export interface SkippedRecord { eventID?: string; eventName?: string }

/** The notices of a batch. A malformed record is skipped and named, so one bad record never loses the batch. */
/** A developer's own operation that ended: its setup, pull request or task notice. */
function developerOperationNotices(next: Record<string, unknown>, base: { workspaceId: string; operationId: string; at: string }): Notice[] {
  if (next.kind === "prepare") {
    // A cancelled setup has no notice of its own: the cancel notice covers it.
    const kind = next.status === "SUCCEEDED" ? "ready" : next.status === "FAILED" || next.status === "INTERRUPTED" ? "setup_failed" : undefined;
    return kind === undefined ? [] : [{ ...base, id: `${base.operationId}:${kind}`, kind }];
  }
  if (next.kind === "publish" && next.status === "SUCCEEDED") return [{ ...base, id: `${base.operationId}:pull_request`, kind: "pull_request" }];
  if (next.kind === "task" || next.kind === "publish") return [{ ...base, id: `${base.operationId}:ended`, kind: "ended" }];
  return [];
}

export function readStream(records: readonly StreamRecord[]): { notices: Notice[]; skipped: SkippedRecord[] } {
  const notices: Notice[] = [];
  const skipped: SkippedRecord[] = [];
  for (const entry of records) {
    const image = entry.dynamodb?.NewImage;
    if (image === undefined) continue;
    try {
      const next = unmarshall(image) as Record<string, unknown>;
      // Lane 7: a replay copy of a past task is never announced (no Slack message, no DM, no card).
      if (isEvalRunMark(next.evalRun)) continue;
      const previous = entry.dynamodb?.OldImage === undefined ? undefined : unmarshall(entry.dynamodb.OldImage) as Record<string, unknown>;
      notices.push(...noticesOf(previous, next, changedAt(next, entry.dynamodb?.ApproximateCreationDateTime), entry.eventID ?? ""));
    } catch {
      skipped.push({ ...(entry.eventID === undefined ? {} : { eventID: entry.eventID }), ...(entry.eventName === undefined ? {} : { eventName: entry.eventName }) });
    }
  }
  return { notices, skipped };
}

/** DR10: the tasks in a stream batch whose workflow is waiting on people, for the notifier to arm their wait rows. Only the newest image of a task matters (the write is conditional on the revision), so a batch costs one write for each. */
export function designWaitArms(records: readonly StreamRecord[]): Array<{ taskId: string; orgId?: string; workflow: WorkflowSnapshot }> {
  const latest = new Map<string, { taskId: string; orgId?: string; workflow: WorkflowSnapshot }>();
  for (const entry of records) {
    const image = entry.dynamodb?.NewImage;
    if (image === undefined) continue;
    try {
      const next = unmarshall(image) as Record<string, unknown>;
      const workflow = record(next.workflow);
      // Cheap first: only a task that has a design review at all is parsed.
      if (next.entityType !== "DEVELOPER_TASK" || workflow?.designReview === undefined || typeof next.taskId !== "string" || isEvalRunMark(next.evalRun)) continue;
      const parsed = WorkflowSnapshotSchema.safeParse(workflow);
      if (!parsed.success) continue;
      const previous = latest.get(next.taskId);
      if (previous === undefined || previous.workflow.revision <= parsed.data.revision) latest.set(next.taskId, { taskId: next.taskId, ...(typeof next.orgId === "string" ? { orgId: next.orgId } : {}), workflow: parsed.data });
    } catch {
      // A record that cannot be read is skipped here; `readStream` names it.
    }
  }
  return [...latest.values()];
}

export function noticesFromStream(records: readonly StreamRecord[]): Notice[] {
  return readStream(records).notices;
}
