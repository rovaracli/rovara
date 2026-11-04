// Design review stage, DR7 slice B2: the owner's Retry of a planner run that BLOCKED while it was answering a design review's findings (a rule file that could not be verified, a leftover program, a run that failed). The plain
// planning Retry would start the planner from scratch on an old prompt; this resumes the review where it stood (`resumeBlockedDesignReview`: PLAN/BLOCKED "resolving" becomes PLAN/READY "resolving", spend kept) and makes the
// resolve run due again with its CRITIC_REPLAN row, in one transaction conditional on the revision the owner saw. Nothing here approves, answers or spends anything.
import type { z } from "zod";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, resumeBlockedDesignReview, workflowIsDesignReviewing, type ContinueDeveloperTaskRequestSchema, type DeveloperTaskView, type WorkflowSnapshot } from "@agentx/contracts";
import { taskKey } from "../../developer/task-records.js";
import { WORKFLOW_DISPATCH_PK, WORKFLOW_NO_CANDIDATE_DIGEST, isConditional, workflowDispatchItem } from "../broker-shared.js";
import type { DeveloperCaller } from "../developer-routes.js";
import { type AuthorizedTask, accessFence, authorizeTaskAction } from "./access.js";
import { iso, putNew } from "./common.js";
import { syncIndex } from "./task-index.js";
import { actionableWorkspace, busyOrClosing, requireMayGoOn } from "./task-window.js";
import { taskView } from "./task-view.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";
import { startTaskWorkflowCriticRevisionFromSystem } from "./workflow-starts.js";

/** Whether a blocked workflow is a design review's planner run (PLAN/BLOCKED with the review "resolving"). */
export const designResolveBlocked = (workflow: WorkflowSnapshot | undefined): boolean =>
  workflow !== undefined && workflowIsDesignReviewing(workflow) && workflow.stage === "PLAN" && workflow.state === "BLOCKED" && workflow.designReview?.status === "resolving";

/** The record that a design resolve retry took, under its request ID, so a repeat of it is the same retry. */
export const designResolveRetryKey = (taskId: string, requestId: string) => ({ pk: `DEVTASK#${taskId}`, sk: `WORKFLOW_DESIGN_RESOLVE_RETRY#${requestId}` });

export async function retryDesignResolve(
  deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, access: AuthorizedTask, request: z.infer<typeof ContinueDeveloperTaskRequestSchema>,
): Promise<{ task: DeveloperTaskView }> {
  const { task } = access;
  const workflow = task.workflow!;
  if (request.expectedRevision !== undefined && request.expectedRevision !== workflow.revision) throw agentXError("IDEMPOTENCY_CONFLICT", "this retry is out of date; refresh the task and try again");
  await requireMayGoOn(deps, caller, task);
  await actionableWorkspace(deps, task);
  const receivedAt = iso(deps);
  const next = resumeBlockedDesignReview(workflow, { expectedRevision: workflow.revision, now: receivedAt });
  try {
    await deps.actions.transact([{ Update: {
      TableName: deps.tableName, Key: taskKey(task.taskId),
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :plan AND workflow.#state = :blocked AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
      ExpressionAttributeValues: { ":workflow": next, ":now": receivedAt, ":revision": workflow.revision, ":plan": "PLAN", ":blocked": "BLOCKED" },
    } }, workflowDispatchItem(deps.tableName, task.taskId, next.revision, "CRITIC_REPLAN", WORKFLOW_NO_CANDIDATE_DIGEST, receivedAt),
    putNew(deps.tableName, { ...designResolveRetryKey(task.taskId, request.requestId), entityType: "WORKFLOW_DESIGN_RESOLVE_RETRY", actorId: access.actorId, at: receivedAt }), accessFence(deps, access)]);
  } catch (error) {
    if (isConditional(error)) {
      const fresh = (await authorizeTaskAction(deps, caller, task.taskId, "retry")).task;
      // A repeat of the same retry: the run is already under way.
      if (fresh.workflow !== undefined && fresh.workflow.revision > workflow.revision) return { task: await taskView(deps, fresh, { events: 0, details: false }) };
      throw agentXError("IDEMPOTENCY_CONFLICT", "this retry is out of date; refresh the task and try again");
    }
    return busyOrClosing(deps, task, error);
  }
  // Started at once as the dispatch row would start it; a start that cannot be made now leaves the row for the sweep.
  try {
    await startTaskWorkflowCriticRevisionFromSystem(deps, task.taskId, { workflowRevision: next.revision });
    await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: { pk: WORKFLOW_DISPATCH_PK, sk: `${task.taskId}#${next.revision}` } }));
  } catch { /* the row stays; the sweep starts it */ }
  const fresh = (await authorizeTaskAction(deps, caller, task.taskId, "retry")).task;
  const view = await taskView(deps, fresh, { events: 0, details: false });
  await syncIndex(deps, fresh, view.status, view.updatedAt);
  return { task: view };
}
