// Live steer: the owner's "Revise the plan with this change" (agent-sessions/live-steer-revise.ts holds the press); the task helpers it needs are handed in here and nothing else is decided here.
import { randomUUID } from "node:crypto";
import { reviseTaskPlan, type RevisePlanHost } from "../../agent-sessions/live-steer-revise.js";
import type { DeveloperCaller } from "../developer-routes.js";
import type { DeveloperTaskView } from "@agentx/cloud-contracts";
import { requireNewWorkAllowed } from "../../developer/project-roles.js";
import { requireProjectSendBackRole } from "../../developer/task-access.js";
import { coreTaskRoutes } from "../../rovara-code/task-routes.js";
import { accessFence, authorizeTaskAction, authorizeTaskActor, type AuthorizedTask } from "./access.js";
import { partyOfTaskActor, putNew, turnTable } from "./common.js";
import { aiToolTurn } from "../../developer/task-records.js";
import { syncIndex } from "./task-index.js";
import { fedThroughUpdate, withCurrentThreadNotes } from "./thread-notes.js";
import { actionableWorkspace, busyOrClosing, capWindowBaseline, capWindowUpdate, requireMayGoOn } from "./task-window.js";
import { taskView } from "./task-view.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";
import { previousMarkdownBlock, retiredClaimIdList, structuredWorkflowPrompt } from "./workflow-inputs.js";

/** The task helpers the revised-plan start needs; Stop & redirect's "this changes the plan" starts the same planning run through them. */
export const revisePlanHost: RevisePlanHost<AuthorizedTask> = {
  authorize: (d, c, id) => authorizeTaskAction(d, c, id, "work"), requireMayGoOn,
  withNotes: (d, task, requestId, accept, skipMessageIds) => withCurrentThreadNotes(d, task, requestId, (current, notes) => accept(current, { suffix: notes.suffix, fed: fedThroughUpdate(notes) }), skipMessageIds), actionableWorkspace, refuse: busyOrClosing, markdownBlock: previousMarkdownBlock, retiredClaimIds: retiredClaimIdList,
  capWindow: async (d, task) => capWindowUpdate(await capWindowBaseline(d, task), task),
  structuredPrompt: (loaded, reason, phase, comments) => structuredWorkflowPrompt(loaded, { decision: "REQUEST_CHANGES", reason }, "PLAN", phase, "plan", { chosen: [], changed: false, comments }),
  acceptItems: (d, c, access, turn) => [putNew(turnTable(d), aiToolTurn({ party: partyOfTaskActor(access.task, c), turnId: randomUUID(), action: "continue", phase: "accepted", outcome: "accepted", receivedAt: turn.at, finishedAt: turn.at,
    request: turn.request, response: turn.response, operationId: turn.operationId })), accessFence(d, access)],
  view: async (d, c, id) => { const fresh = (await authorizeTaskAction(d, c, id, "work")).task; const view = await taskView(d, fresh, { events: 0, details: false }); await syncIndex(d, fresh, view.status, view.updatedAt); return { task: view }; },
};

/**
 * The task route's "Revise the plan". S3 (0.5.19 pin): a task the core engine runs is revised by the core (Code's `revisePlanWithLiveMessage`, the effective owner only), after the checks Cloud's own press
 * makes before it starts planning again: the `work` action, an archived project, and the send-back's project access rule.
 */
export async function reviseTaskWorkflowPlan(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown): Promise<{ task: DeveloperTaskView }> {
  const core = coreTaskRoutes();
  if (core !== undefined && await core.owns(caller, taskId)) {
    return await core.revisePlan({
      caller, taskId, value,
      authorize: async () => {
        const access = await authorizeTaskAction(deps, caller, taskId, "work");
        await requireNewWorkAllowed(deps, caller.orgId, access.task.project, "contributor", "task");
        await requireProjectSendBackRole(deps, access.task, caller);
      },
      view: async () => await taskView(deps, (await authorizeTaskActor(deps, caller, taskId, "work")).task, { events: 0, details: false }),
    });
  }
  return await reviseTaskPlan(deps, caller, taskId, value, revisePlanHost);
}
