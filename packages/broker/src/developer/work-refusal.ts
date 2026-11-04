// S2 (send-back gate completeness): the places that start agent work with no person pressing a button (a queued dispatch, a CI-fix, conflict or review-comment round) ask the same
// question the send-back gate asks a person (`requireProjectSendBackRole`), about the person the work runs as: the task's owner now. A refusal is final (nothing retries it), is written on
// the task by the caller, and is audited here with fixed words only (`task.work_refused`).
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, isSystemOwnerId, orgMemberKey, type OrgRole } from "@agentx/contracts";
import { auditTaskWorkRefused, auditOccurrence } from "../audit/events.js";
import { flushAuditEvents, recordAuditEventDurably } from "../audit/flush.js";
import type { AuditRuntime } from "../audit/outbox.js";
import type { DeveloperTaskRouteDependencies } from "../aws/developer-tasks.js";
import { viewerCannotStartTasksMessage } from "./project-roles.js";
import { requireProjectSendBackRole } from "./task-access.js";
import { effectiveTaskOwner, type DeveloperTaskRecord } from "./task-records.js";

/** Why work was refused, as a fixed word for the audit event. */
export type WorkRefusalReason = "owner_removed" | "no_project_access" | "viewer" | "project_archived" | "project_inactive" | "other_org";
/** Where it was refused, as a fixed word for the audit event. */
export type WorkRefusalPath = "ci_fix_round" | "feedback_round" | "conflict_round" | "program_step" | "feedback_review" | "queued_dispatch";

export interface WorkRefusal { reason: WorkRefusalReason; message: string }

/** What a task shows when a fix round was not started because its owner may no longer run work in the project. No names. */
export const FIX_NOT_RUN_NO_ACCESS = "Rovara didn't start this fix: the person this task runs as no longer has the project access starting a task needs, so nothing was run. Someone with access can take over on GitHub.";
export const FIX_NOT_RUN_ARCHIVED = "Rovara didn't start this fix: the project is archived, so nothing was run. Someone can take over on GitHub.";

/**
 * Whether the task's owner may still have Rovara start work for them: the same rule a person's send-back meets (a company owner or admin, or a role that may start tasks, in a project that is
 * not archived). Undefined when they may. A refusal answers for access and archive only; a read that fails or Slack being unreachable throws, and the caller's own retry (bounded) goes on.
 * `checkAccess` of `deps` is the owner's own project check.
 */
export async function ownerWorkRefusal(deps: Pick<DeveloperTaskRouteDependencies, "checkAccess" | "documentClient" | "tableName" | "orgId">, task: DeveloperTaskRecord): Promise<WorkRefusal | undefined> {
  const owner = effectiveTaskOwner(task);
  // A project's system owner is no person with a role: its standing is the creator check's (`systemOwnerStands`).
  if (isSystemOwnerId(owner.developerId) || task.orgId === undefined) return undefined;
  if (task.orgId !== deps.orgId) return { reason: "other_org", message: FIX_NOT_RUN_NO_ACCESS };
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgMemberKey(task.orgId, owner.developerId), ConsistentRead: true })) as { Item?: { role?: unknown } };
  const role = response.Item?.role;
  const orgRole: OrgRole = role === "owner" || role === "admin" || role === "auditor" ? role : "member";
  try {
    await requireProjectSendBackRole(deps, task, { developerId: owner.developerId, orgId: task.orgId, orgRole });
    return undefined;
  } catch (error) {
    if (!(error instanceof AgentXError)) throw error;
    if (error.code === "PROJECT_ARCHIVED") return { reason: "project_archived", message: FIX_NOT_RUN_ARCHIVED };
    if (error.code === "PROJECT_ACCESS_DENIED") return { reason: error.message === viewerCannotStartTasksMessage(task.project) ? "viewer" : "no_project_access", message: FIX_NOT_RUN_NO_ACCESS };
    throw error;
  }
}

/**
 * Records that work was refused, with fixed words. Best effort: a ledger that cannot be written is logged and the refusal still stands (stopping is the safe side). The event id comes from the
 * task and the step (`occurrence`), so the same refusal retried is one event.
 */
export async function recordWorkRefused(
  audit: AuditRuntime | undefined, log: (entry: Record<string, unknown>) => void,
  input: { orgId: string; taskId: string; path: WorkRefusalPath; reason: WorkRefusalReason; occurrence: string; now: string },
): Promise<void> {
  if (audit === undefined) return;
  try {
    const event = auditTaskWorkRefused({ orgId: input.orgId, actor: { kind: "system", id: "rovara" }, occurredAt: input.now, occurrence: auditOccurrence(input.taskId, input.occurrence), taskId: input.taskId, path: input.path, reason: input.reason });
    await recordAuditEventDurably({ audit }, event);
    await flushAuditEvents({ audit }, [event]);
  } catch (error) {
    log({ event: "task.work_refused_audit_failed", taskId: input.taskId, error: error instanceof Error ? error.name : "unknown" });
  }
}
