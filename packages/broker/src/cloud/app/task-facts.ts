// Switch blocker 10: what a task's session shows, for the core's session service (`createSessionService`'s `facts`). Code's own source for this is inside its laptop composition and is not exported
// (an upstream need, DEFERRED S3-SESSION-FACTS-UPSTREAM); this is Cloud's, over Cloud's own readers of the same task rows the core writes: the task record, its owner as a caller, and
// `taskView` (the run status and the failure Cloud's own task page shows). Nothing is computed here that a Cloud page does not already show.
//   - a task whose owner can no longer be found as a caller (removed, revoked) still has facts, from the record and its workflow: the run status reads as idle, and the session ends or waits as its workflow says;
//   - a task of another company, or that does not exist, has none (`undefined`).
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { SessionServiceOptions } from "@rovara-code/broker";
import { agentRunStarterOf, developerTaskRouteDependencies } from "../../aws/developer-routes/dependencies.js";
import type { DeveloperRouteDependencies } from "../../aws/developer-routes/types.js";
import { taskView } from "../../aws/developer-tasks/task-view.js";
import { viewCoreTaskRows } from "./core-task-rows.js";
import { taskKey, tryEffectiveTaskOwner, type DeveloperTaskRecord } from "../../developer/task-records.js";

type Facts = Awaited<ReturnType<SessionServiceOptions["facts"]["read"]>>;
type RunStatus = NonNullable<Facts>["runStatus"];

const RUN_STATUS: Readonly<Record<string, RunStatus>> = { STARTING: "STARTING", RUNNING: "RUNNING", SUCCEEDED: "SUCCEEDED", FAILED: "FAILED", CANCELLED: "CANCELLED", INTERRUPTED: "INTERRUPTED" };

/** The one line that says what step a workflow task is on, in the words the sessions show (Code's own, local/app/facts.ts `stepOf`). */
export function stepWords(stage: string, state: string): string | undefined {
  if (state === "BLOCKED") return "Needs your attention";
  switch (stage) {
    case "UNDERSTAND": return "Reading the request";
    case "PLAN": return "Writing the plan";
    case "PLAN_CRITIQUE": return "Checking the plan";
    case "PLAN_REVIEW": return state === "WAITING" ? "Waiting for your approval" : "Plan review";
    default: return undefined;
  }
}

export function cloudTaskFacts(routesOf: () => DeveloperRouteDependencies): SessionServiceOptions["facts"] {
  return {
    async read(companyId, taskId) {
      const routes = viewCoreTaskRows(routesOf());
      const task = ((await routes.documentClient.send(new GetCommand({ TableName: routes.tableName, Key: taskKey(taskId), ConsistentRead: true }))) as { Item?: DeveloperTaskRecord }).Item;
      if (task === undefined || (task.orgId ?? (task as { companyId?: string }).companyId) !== companyId) return undefined;
      const owner = tryEffectiveTaskOwner(task);
      if (owner === undefined) return undefined;
      const workflow = task.workflow;
      let runStatus: RunStatus = "IDLE";
      let failureCategory: string | undefined;
      const caller = await agentRunStarterOf(routes)?.callerFor(task.orgId ?? companyId, owner.developerId).catch(() => undefined);
      if (caller !== undefined) {
        const view = await taskView(developerTaskRouteDependencies(routes, caller), task, { events: 0, details: false }).catch(() => undefined);
        if (view !== undefined) {
          runStatus = RUN_STATUS[view.status] ?? "IDLE";
          failureCategory = view.failure?.category;
        }
      }
      const step = workflow === undefined ? undefined : stepWords(workflow.stage, workflow.state);
      return {
        companyId, taskId, project: task.project, ownerDeveloperId: owner.developerId,
        ...(task.closedAt === undefined ? {} : { closedAt: task.closedAt }),
        ...(workflow === undefined ? {} : { workflow: { stage: workflow.stage, state: workflow.state, ...(workflow.outcome === undefined ? {} : { outcome: workflow.outcome }), ...(workflow.blockReason === undefined ? {} : { blockReason: workflow.blockReason }) } }),
        runStatus,
        ...(failureCategory === undefined ? {} : { failureCategory }),
        ...(step === undefined ? {} : { step }),
        pendingApprovals: 0,
        ...(task.closedAt === undefined ? {} : { endedAt: task.closedAt }),
        updatedAt: (task as { updatedAt?: string }).updatedAt ?? task.createdAt,
      };
    },
  };
}
