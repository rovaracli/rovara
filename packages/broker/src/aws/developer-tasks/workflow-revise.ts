// Live steer: the owner's "Revise the plan with this change" (agent-sessions/live-steer-revise.ts holds the press); the task helpers it needs are handed in here and nothing else is decided here.
import { randomUUID } from "node:crypto";
import { reviseTaskPlan } from "../../agent-sessions/live-steer-revise.js";
import type { DeveloperCaller } from "../developer-routes.js";
import { accessFence, authorizeTaskAction } from "./access.js";
import { partyOfTaskActor, putNew, turnTable } from "./common.js";
import { aiToolTurn } from "../../developer/task-records.js";
import { syncIndex } from "./task-index.js";
import { fedThroughUpdate, withCurrentThreadNotes } from "./thread-notes.js";
import { actionableWorkspace, busyOrClosing, capWindowBaseline, capWindowUpdate, requireMayGoOn } from "./task-window.js";
import { taskView } from "./task-view.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";
import { previousMarkdownBlock, retiredClaimIdList, structuredWorkflowPrompt } from "./workflow-inputs.js";

export const reviseTaskWorkflowPlan = (deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown) => reviseTaskPlan(deps, caller, taskId, value, {
  authorize: (d, c, id) => authorizeTaskAction(d, c, id, "work"), requireMayGoOn,
  withNotes: (d, task, requestId, accept) => withCurrentThreadNotes(d, task, requestId, (current, notes) => accept(current, { suffix: notes.suffix, fed: fedThroughUpdate(notes) })), actionableWorkspace, refuse: busyOrClosing, markdownBlock: previousMarkdownBlock, retiredClaimIds: retiredClaimIdList,
  capWindow: async (d, task) => capWindowUpdate(await capWindowBaseline(d, task), task),
  structuredPrompt: (loaded, reason, phase, comments) => structuredWorkflowPrompt(loaded, { decision: "REQUEST_CHANGES", reason }, "PLAN", phase, "plan", { chosen: [], changed: false, comments }),
  acceptItems: (d, c, access, turn) => [putNew(turnTable(d), aiToolTurn({ party: partyOfTaskActor(access.task, c), turnId: randomUUID(), action: "continue", phase: "accepted", outcome: "accepted", receivedAt: turn.at, finishedAt: turn.at,
    request: turn.request, response: turn.response, operationId: turn.operationId })), accessFence(d, access)],
  view: async (d, c, id) => { const fresh = (await authorizeTaskAction(d, c, id, "work")).task; const view = await taskView(d, fresh, { events: 0, details: false }); await syncIndex(d, fresh, view.status, view.updatedAt); return { task: view }; },
});
