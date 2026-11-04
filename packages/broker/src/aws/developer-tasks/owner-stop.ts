// S2 (send-back gate completeness): the one place a step Rovara is about to start on its own (a fix round, a custom sequence's next coding step, a PR-feedback critic) is refused because the
// task's owner may no longer have work started for them. The refusal is written on the task (one conditional write: a plain reason, nothing run or paid for) and audited with fixed words.
import { stopWorkflowStepNotRun, type WorkflowSnapshot } from "@agentx/contracts";
import { taskKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { ownerWorkRefusal, recordWorkRefused, type WorkRefusalPath } from "../../developer/work-refusal.js";
import { isConditional } from "../broker-shared.js";
import { iso, log } from "./common.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";

/**
 * Asks whether the task's owner may still have Rovara start work for them (`ownerWorkRefusal`: the send-back's project access rule and the archive check, read live; `checkAccess` of `deps` is
 * the owner's own). When not, the task is blocked where it stands with the reason, the refusal is audited, and the answer is true (do not start). A lost race leaves the task to whoever moved
 * it. A read that fails throws, and the caller's own bounded retry goes on. `workflow` is the snapshot the caller read: the write is conditional on its revision, stage and state.
 */
export async function stopIfOwnerRefused(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, workflow: WorkflowSnapshot, path: WorkRefusalPath): Promise<boolean> {
  const refusal = await ownerWorkRefusal(deps, task);
  if (refusal === undefined) return false;
  const at = iso(deps);
  await recordWorkRefused(deps.learningAudit, (entry) => log(deps, entry), { orgId: String(task.orgId), taskId: task.taskId, path, reason: refusal.reason, occurrence: `${path}#${String(workflow.revision)}`, now: at });
  try {
    await deps.actions.transact([{ Update: {
      TableName: deps.tableName, Key: taskKey(task.taskId), UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :stage AND workflow.#state = :state AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
      ExpressionAttributeValues: { ":workflow": stopWorkflowStepNotRun(workflow, refusal.message, at), ":now": at, ":revision": workflow.revision, ":stage": workflow.stage, ":state": workflow.state },
    } }]);
  } catch (error) {
    if (!isConditional(error)) throw error;
  }
  return true;
}
