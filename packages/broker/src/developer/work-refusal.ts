// S2 (send-back gate completeness): the places that start agent work with no person pressing a button (a queued dispatch, a CI-fix, conflict or review-comment round) ask the same
// question the send-back gate asks a person (`requireProjectSendBackRole`), about the person the work runs as: the task's owner now. A refusal is final (nothing retries it), is written on
// the task by the caller, and is audited here with fixed words only (`task.work_refused`).
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, WORKFLOW_NOT_RUN_PREFIX, isSystemOwnerId, orgMemberKey, type OrgRole } from "@agentx/contracts";
import { auditTaskWorkRefused, auditOccurrence } from "../audit/events.js";
import { flushAuditEvents, recordAuditEventDurably } from "../audit/flush.js";
import type { AuditRuntime } from "../audit/outbox.js";
import type { DeveloperTaskRouteDependencies } from "../aws/developer-tasks.js";
import { viewerCannotStartTasksMessage } from "./project-roles.js";
import { requireProjectSendBackRole } from "./task-access.js";
import { effectiveTaskOwner, tryEffectiveTaskOwner, type DeveloperTaskRecord } from "./task-records.js";

/** Why work was refused, as a fixed word for the audit event. */
export type WorkRefusalReason = "owner_removed" | "no_project_access" | "viewer" | "project_archived" | "project_inactive" | "other_org" | "slack_unavailable";
/** Where it was refused, as a fixed word for the audit event. */
export type WorkRefusalPath = "ci_fix_round" | "feedback_round" | "conflict_round" | "program_step" | "feedback_review" | "queued_dispatch" | "direct_start" | "agent_step" | "spend_resume" | "autofix";

export interface WorkRefusal { reason: WorkRefusalReason; message: string }

/** What a task shows when a step was not started because its owner may no longer run work in the project. No names. */
export const FIX_NOT_RUN_NO_ACCESS = `${WORKFLOW_NOT_RUN_PREFIX} this step: the person this task runs as no longer has the project access starting a task needs, so nothing was run. To continue, someone with project access can take the task over, or the owner's access can be restored and Retry pressed.`;
export const FIX_NOT_RUN_ARCHIVED = `${WORKFLOW_NOT_RUN_PREFIX} this step: the project is archived, so nothing was run. Restore the project, then press Retry.`;
/** What a queued step says when Slack could not be reached to check access for too long (the cap is `SLACK_WAIT_CAP_MS`). */
export const STEP_NOT_RUN_SLACK = `${WORKFLOW_NOT_RUN_PREFIX} this step: Rovara could not reach Slack to check who may start work, for 30 minutes, so nothing was run. Press Retry to try again.`;
/** How long a queued step waits for Slack to answer the access check before it stops with `STEP_NOT_RUN_SLACK`. */
export const SLACK_WAIT_CAP_MS = 30 * 60_000;

/**
 * Whether the task's owner may still have Rovara start work for them: the same rule a person's send-back meets (a company owner or admin, or a role that may start tasks, in a project that is
 * not archived). Undefined when they may. A refusal answers for access and archive only; a read that fails or Slack being unreachable throws, and the caller's own retry (bounded) goes on.
 * `checkAccess` of `deps` is the owner's own project check.
 */
export async function ownerWorkRefusal(deps: Pick<DeveloperTaskRouteDependencies, "checkAccess" | "ownerCheckAccess" | "documentClient" | "tableName" | "orgId">, task: DeveloperTaskRecord): Promise<WorkRefusal | undefined> {
  const owner = effectiveTaskOwner(task);
  // A project's system owner is no person with a role: its standing is the creator check's (`systemOwnerStands`).
  if (isSystemOwnerId(owner.developerId) || task.orgId === undefined) return undefined;
  if (task.orgId !== deps.orgId) return { reason: "other_org", message: FIX_NOT_RUN_NO_ACCESS };
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgMemberKey(task.orgId, owner.developerId), ConsistentRead: true })) as { Item?: { role?: unknown } };
  const role = response.Item?.role;
  const orgRole: OrgRole = role === "owner" || role === "admin" || role === "auditor" ? role : "member";
  try {
    // The OWNER's own project access: `ownerCheckAccess` when the dependencies know how to ask as the owner (a person pressing a button is not the owner), else the call's own check (dispatch dependencies are the owner's already).
    const asOwner = deps.ownerCheckAccess === undefined ? deps : { ...deps, checkAccess: deps.ownerCheckAccess(task) };
    await requireProjectSendBackRole(asOwner, task, { developerId: owner.developerId, orgId: task.orgId, orgRole });
    return undefined;
  } catch (error) {
    if (!(error instanceof AgentXError)) throw error;
    if (error.code === "PROJECT_ARCHIVED") return { reason: "project_archived", message: FIX_NOT_RUN_ARCHIVED };
    if (error.code === "PROJECT_ACCESS_DENIED") return { reason: error.message === viewerCannotStartTasksMessage(task.project) ? "viewer" : "no_project_access", message: FIX_NOT_RUN_NO_ACCESS };
    throw error;
  }
}

/**
 * Tells the others on the task who could take it over, once per stop and per person (S2 owner decision): a pending row each for the co-owners and commenters of the task's PEOPLE list, other than the
 * effective owner, who have a Slack user. A conditional put, so the same stop recorded again (a retried refusal) adds nothing. The notifier reads the row and sends one direct message; it names nobody.
 * Returns how many rows were written.
 */
export async function notifyOthersOfStop(
  table: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }, task: DeveloperTaskRecord, stopId: string, now: string,
): Promise<number> {
  const response = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: { pk: `DEVTASK#${task.taskId}`, sk: "PEOPLE" }, ConsistentRead: true })) as { Item?: { people?: unknown } };
  const people = response.Item?.people;
  if (!Array.isArray(people)) return 0;
  const owner = tryEffectiveTaskOwner(task)?.developerId;
  let written = 0;
  for (const person of people as Array<{ developerId?: unknown; slackUserId?: unknown; role?: unknown }>) {
    if (typeof person.developerId !== "string" || person.developerId === owner || (person.role !== "owner" && person.role !== "commenter")
      || typeof person.slackUserId !== "string" || person.slackUserId === "") continue;
    try {
      await table.documentClient.send(new PutCommand({ TableName: table.tableName, ConditionExpression: "attribute_not_exists(pk)", Item: {
        pk: `DEVTASK#${task.taskId}`, sk: `OWNER_STOP_NOTIFY#${stopId}#${person.developerId}`, entityType: "TASK_OWNER_STOPPED_NOTIFICATION", schemaVersion: 1,
        taskId: task.taskId, stopId, targetDeveloperId: person.developerId, slackUserId: person.slackUserId, status: "PENDING", attempts: 0, createdAt: now } }));
      written += 1;
    } catch (error) {
      if ((error instanceof Error ? error.name : "") !== "ConditionalCheckFailedException") throw error;
    }
  }
  return written;
}

/**
 * Records that work was refused, with fixed words: the audit event, and the notice to the others who can take the task over (`notify`, given where the owner lost their place). Best effort: a ledger or a notice that
 * cannot be written is logged and the refusal still stands (stopping is the safe side). The event id and the notice come from the task and the step (`occurrence`), so the same refusal retried is one event and one notice.
 */
export async function recordWorkRefused(
  audit: AuditRuntime | undefined, log: (entry: Record<string, unknown>) => void,
  input: { orgId: string; taskId: string; path: WorkRefusalPath; reason: WorkRefusalReason; occurrence: string; now: string },
  notify?: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; task: DeveloperTaskRecord },
): Promise<void> {
  if (audit !== undefined) {
    try {
      const event = auditTaskWorkRefused({ orgId: input.orgId, actor: { kind: "system", id: "rovara" }, occurredAt: input.now, occurrence: auditOccurrence(input.taskId, input.occurrence), taskId: input.taskId, path: input.path, reason: input.reason });
      await recordAuditEventDurably({ audit }, event);
      await flushAuditEvents({ audit }, [event]);
    } catch (error) {
      log({ event: "task.work_refused_audit_failed", taskId: input.taskId, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  // Only a loss of the owner's own place tells the others (someone else can take the task over); an archived project, a Slack outage or a lost company are nobody's to take over.
  if (notify !== undefined && (input.reason === "owner_removed" || input.reason === "no_project_access" || input.reason === "viewer")) {
    try {
      await notifyOthersOfStop(notify, notify.task, `${input.path}#${input.occurrence}`, input.now);
    } catch (error) {
      log({ event: "task.work_refused_notify_failed", taskId: input.taskId, error: error instanceof Error ? error.name : "unknown" });
    }
  }
}
