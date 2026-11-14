// Design review stage, DR7 slice C (money W2): the COMMIT PORT of `designApproveHandler`. The handler decided who may approve and in what capacity; this makes the approval real through the task's own design-phase decision
// (`decideTaskWorkflow`, the one transition every surface uses), adding to its transaction, and to nothing else:
//   - the approval RECORD under the design's digest (approver, tier, open blockers, the cleaned reason and the Proof-line words), which the pull request's Proof section reads (`design-review/proof-ports.ts`);
//   - the FENCE: the company's membership generation the eligibility was read at, so a membership change in between cancels the approval;
//   - the `task.design_sole_owner_exception` audit event, when the approval was the sole-owner exception.
// The commit is conditional on the design digest the person was shown: the latest design must be exactly that document, and the decision names it. A task that moved, a design that changed or a fence that no longer
// holds is "stale". The workflow engine knows one decider, the task's owner; an approver who is not the owner (a maintainer, the high-risk approver) is authorised by the handler's own checks and decides for the owner's
// seat, but the decision the engine records, the approval record and the audit all name the person who really pressed (ON-4), and the owner's seat is built from the OWNER's own record, never from the approver's role or session.
import { agentXError } from "@rovara-code/contracts";
import { auditEventId, orgMetaKey, type AuditEventInput } from "@agentx/cloud-contracts";
import { flushAuditEvents } from "../../audit/flush.js";
import { auditPending } from "../../audit/outbox.js";
import { effectiveTaskOwner, taskKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import type { DesignApprovalWrite } from "../../design-review/approve-handler.js";
import type { TransactItems } from "../developer-task-actions.js";
import type { DeveloperCaller } from "../developer-routes.js";
import { TASK_ID, get, iso, log } from "./common.js";
import { decideTaskWorkflow } from "./decide.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";

/** The fixed words of the decision the engine records. The approver's own words never go here: they are in the approval record, as data. */
export const DESIGN_APPROVAL_DECISION_REASON = "Approved the reviewed design.";

/** Where the approval of one design (by its digest) is kept. */
export const designApprovalKey = (taskId: string, digest: string): { pk: string; sk: string } => ({ pk: `DEVTASK#${taskId}`, sk: `DESIGN_APPROVAL#${digest}` });

/** The design digest a card's content version starts with (the version is `<digest>:b<blockers>:<facts>`). */
export const designDigestOfVersion = (contentVersion: string): string => contentVersion.split(":")[0] ?? "";

/** The condition that pins the company's membership generation. A company with no counter yet has none to pin (version 0, attribute absent), exactly as the roster read treats it. */
export function membershipFenceItem(tableName: string, orgId: Parameters<typeof orgMetaKey>[0], fence: DesignApprovalWrite["fence"]): TransactItems[number] {
  const version = fence.ExpressionAttributeValues[":approvalMembershipVersion"];
  if (version === 0) return { ConditionCheck: { TableName: tableName, Key: orgMetaKey(orgId), ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(closedAt) AND attribute_not_exists(closingAt) AND attribute_not_exists(approvalMembershipVersion)" } };
  return { ConditionCheck: { TableName: tableName, Key: orgMetaKey(orgId), ConditionExpression: fence.ConditionExpression, ExpressionAttributeValues: fence.ExpressionAttributeValues } };
}

export interface DesignApprovalItems { items: TransactItems; auditEvent: AuditEventInput | undefined }

/** The items added to the decision's transaction. Pure over its inputs (the audit item is the ledger's own, when there is a ledger). */
export function designApprovalItems(
  deps: Pick<DeveloperTaskRouteDependencies, "tableName" | "orgId" | "learningAudit">,
  input: { taskId: string; digest: string; write: DesignApprovalWrite; approver: { developerId: string; name: string }; now: string },
): DesignApprovalItems {
  const { write, approver } = input;
  const auditEvent: AuditEventInput | undefined = write.auditSoleOwnerException ? {
    eventId: auditEventId("task.design_sole_owner_exception", input.taskId, write.requestId), orgId: deps.orgId, action: "task.design_sole_owner_exception", actor: { kind: "member", id: approver.developerId },
    target: { kind: "task", id: input.taskId }, occurredAt: input.now, facts: { tier: write.tier, openBlockers: write.openBlockers },
  } : undefined;
  const audit = auditEvent === undefined || deps.learningAudit === undefined ? [] : auditPending({ audit: deps.learningAudit }, auditEvent);
  return {
    auditEvent: audit.length === 0 ? undefined : auditEvent,
    items: [
      { Put: { TableName: deps.tableName, Item: {
        ...designApprovalKey(input.taskId, input.digest), entityType: "DESIGN_APPROVAL", taskId: input.taskId, designDigest: input.digest, approverId: approver.developerId, approverLabel: approver.name,
        requesterId: write.requesterId, tier: write.tier, mode: write.mode, openBlockers: write.openBlockers, requestId: write.requestId, at: input.now,
        ...(write.proofReason === undefined ? {} : { proofReason: write.proofReason }), ...(write.proofLine === undefined ? {} : { proofLine: write.proofLine }),
      } } },
      membershipFenceItem(deps.tableName, deps.orgId, write.fence),
      ...audit,
    ],
  };
}

/**
 * Commits an approved design. `deps` are the task dependencies for the TASK OWNER's seat (the engine's only decider), built from the owner's own record; `approver` is the person who pressed. "stale": the task is not waiting on this design any more, the design
 * is not the one shown, or the fence no longer holds.
 */
export async function commitDesignApproval(
  deps: DeveloperTaskRouteDependencies, ownerCaller: DeveloperCaller, approver: { developerId: string; name: string }, write: DesignApprovalWrite,
): Promise<"done" | "stale"> {
  // Every "stale" is logged with its reason code first (counts and codes only, never a name or an id), so a person told "this changed" can be traced.
  const stale = (reason: string): "stale" => {
    log(deps, { event: "design.approve_stale", reason });
    return "stale";
  };
  if (write.taskId === undefined || !TASK_ID.test(write.taskId)) return stale("task_id_invalid");
  const digest = designDigestOfVersion(write.contentVersion);
  const task = await get<DeveloperTaskRecord>(deps, taskKey(write.taskId));
  const workflow = task?.workflow;
  if (task === undefined || task.orgId !== deps.orgId) return stale("task_not_found");
  if (workflow === undefined || workflow.designReview === undefined || workflow.stage !== "PLAN_REVIEW" || workflow.state !== "WAITING" || workflow.reviewPhase !== "DESIGN") return stale("not_waiting_on_design");
  // The design the person was shown must be the design waiting now.
  if (workflow.artifacts.filter((artifact) => artifact.type === "design").at(-1)?.sha256 !== digest) return stale("design_changed");
  if (effectiveTaskOwner(task).developerId !== ownerCaller.developerId) return stale("owner_changed");
  const now = iso(deps);
  const extra = designApprovalItems(deps, { taskId: task.taskId, digest, write, approver, now });
  try {
    await decideTaskWorkflow(deps, ownerCaller, task.taskId, {
      requestId: write.requestId, expectedRevision: workflow.revision, decision: "APPROVE", reason: DESIGN_APPROVAL_DECISION_REASON, artifactDigest: digest,
    }, { designApproval: { items: extra.items, approverId: approver.developerId } });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "IDEMPOTENCY_CONFLICT" || code === "CHANGE_STALE" || code === "TASK_NOT_FOUND") return stale(code.toLowerCase());
    throw error;
  }
  if (extra.auditEvent !== undefined && deps.learningAudit !== undefined) await flushAuditEvents({ audit: deps.learningAudit }, [extra.auditEvent]).catch(() => undefined);
  return "done";
}

/** The refusal a route gives for a design approval that cannot go on. */
export const designApprovalGone = (): Error => agentXError("NOT_FOUND", "This decision is no longer waiting for you.");
