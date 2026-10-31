import { randomUUID } from "node:crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { type AgentXError, agentXError, type StartDeveloperTaskRequest } from "@agentx/contracts";
import { aiToolTurn, taskKey, taskOwnerKey, isTaskOwner, type DeveloperTaskRecord, type TurnParty } from "../../developer/task-records.js";
import type { TransactItems } from "../developer-task-actions.js";
import type { DeveloperCaller } from "../developer-routes.js";
import { WORK_ACTIONS, can, requireProjectWorkRole, resolveTaskAccess, taskOpen, type TaskAccess, type TaskAction } from "../../developer/task-access.js";
import { loadTaskPeople, resolveTaskDispatchPeople, taskAccessFence } from "../../developer/task-people.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";
import { CLOSED_TASK, TASK_ID, get, iso, turnRecordFailed } from "./common.js";

/**
 * R12: the refused start's audit record, its own PutItem under the task ID the start would have
 * used (no workspace exists, so there is no action transaction to join; ruling F15). A failed
 * write is counted and logged, and never hides the refusal.
 */
export async function refuse(deps: DeveloperTaskRouteDependencies, turns: string, party: TurnParty, request: StartDeveloperTaskRequest, receivedAt: string, error: AgentXError): Promise<never> {
  try {
    const record = aiToolTurn({
      party, turnId: randomUUID(), action: "start", phase: "refused", outcome: "refused", receivedAt, finishedAt: iso(deps),
      request: request.instructions, response: error.message, errorCode: error.code,
    });
    await deps.documentClient.send(new PutCommand({ TableName: turns, Item: record, ConditionExpression: "attribute_not_exists(pk)" }));
  } catch (writeError) {
    turnRecordFailed(deps, writeError);
  }
  throw error;
}

/** The developer's own task (the owner now: whoever took it over, else its creator), or TASK_NOT_FOUND for anyone else and for a malformed ID (FR-036). */
export async function loadOwnedTask(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string): Promise<DeveloperTaskRecord> {
  const task = TASK_ID.test(taskId) ? await get<DeveloperTaskRecord>(deps, taskKey(taskId)) : undefined;
  if (task === undefined || !await isTaskOwner(task, caller.developerId, deps.resolveMember) || task.orgId !== caller.orgId) {
    // A malformed ID is never echoed back: it could be long or carry markup.
    throw agentXError("TASK_NOT_FOUND", TASK_ID.test(taskId) ? `no task ${taskId} of yours` : "that is not a task ID of yours");
  }
  return task;
}

export interface AuthorizedTask extends TaskAccess {
  shareSession?: { sessionId: string; revision: number };
  actorId: string;
  authority: { actorId: string; ownerIds: readonly string[] };
}

/**
 * Whether this is the session actor of `cancelTaskFor` or `retryTaskWorkflowFor` asking for an action it was given: stop (`control`), retry, and `work`, which a retry asks for
 * when it restarts coding (`queueWorkflowCoding`). Only those two functions set `sessionActor`, so `work` is reached only through a retry.
 */
function isSessionActor(deps: Pick<DeveloperTaskRouteDependencies, "sessionActor">, caller: DeveloperCaller, action: TaskAction): action is "retry" | "control" | "work" {
  return deps.sessionActor !== undefined && deps.sessionActor.developerId === caller.developerId && (action === "retry" || action === "control" || action === "work");
}

/**
 * The access of the session actor on a task: owner-like for stop and retry, because the session route already checked their level on the session. A retry needs their project
 * role to start work (the same gate the owner's retry passes). The writes are fenced on the People revision read here, so a change of the task's people in between refuses them.
 */
async function sessionActorAccess(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, action: "retry" | "control" | "work"): Promise<AuthorizedTask> {
  const notFound = () => agentXError("TASK_NOT_FOUND", "no task here that you can see");
  if (!TASK_ID.test(taskId)) throw notFound();
  const task = await get<DeveloperTaskRecord>(deps, taskKey(taskId));
  if (task === undefined || task.orgId !== caller.orgId) throw notFound();
  if (action === "retry" || action === "work") {
    if (!taskOpen(task)) throw notFound();
    await requireProjectWorkRole(deps, task, caller);
  }
  const people = await loadTaskPeople(deps, taskId);
  const actorId = taskOwnerKey(caller.developerId, taskId);
  return { task, role: "owner", ...(people === undefined ? {} : { peopleRevision: people.revision }), ownerActorIds: [], actorId, authority: { actorId, ownerIds: [] } };
}

/** Current human authority plus the exact PEOPLE revision every write must retain. */
export async function authorizeTaskAction(
  deps: DeveloperTaskRouteDependencies,
  caller: DeveloperCaller,
  taskId: string,
  action: TaskAction,
): Promise<AuthorizedTask> {
  if (isSessionActor(deps, caller, action)) return sessionActorAccess(deps, caller, taskId, action);
  const access = await resolveTaskAccess(deps, caller, taskId, action);
  const actorId = taskOwnerKey(caller.developerId, taskId);
  return { ...access, actorId, authority: { actorId, ownerIds: access.ownerActorIds } };
}

/** Rechecks current role for a historical/terminal answer without requiring the task to remain open. */
export async function authorizeTaskActor(
  deps: DeveloperTaskRouteDependencies,
  caller: DeveloperCaller,
  taskId: string,
  action: TaskAction,
  options: { readOnly?: boolean } = {},
): Promise<AuthorizedTask> {
  if (isSessionActor(deps, caller, action)) return sessionActorAccess(deps, caller, taskId, action);
  const access = await authorizeTaskAction(deps, caller, taskId, "read");
  if (!can(access.role, action, access.source)) throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
  // The same gate resolveTaskAccess applies to its work actions: an answer that only reads a record (the feedback review page) is exempt.
  if (options.readOnly !== true && WORK_ACTIONS.includes(action)) await requireProjectWorkRole(deps, access.task, caller);
  return access;
}

/** Current read+role admission for legacy actions that must retain their truthful terminal refusal. */
export async function authorizeLegacyTaskAction(
  deps: DeveloperTaskRouteDependencies,
  caller: DeveloperCaller,
  taskId: string,
  action: TaskAction,
): Promise<AuthorizedTask> {
  const access = await authorizeTaskActor(deps, caller, taskId, action);
  if (access.task.closedAt !== undefined || access.task.workflow?.stage === "CLOSED" || access.task.workflow?.stage === "MERGED") {
    throw agentXError("CONFIG_INVALID", CLOSED_TASK);
  }
  return access;
}

export async function systemTaskAccess(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord): Promise<TaskAccess | undefined> {
  const access = await resolveTaskDispatchPeople(deps, task);
  if (access === undefined) return undefined;
  if (access.status !== "ALLOWED") throw agentXError("TASK_ACCESS_DENIED", "task access could not be verified");
  return { task, role: "owner", peopleRevision: access.peopleRevision, ownerActorIds: access.ownerActorIds };
}

export const accessFence = (deps: Pick<DeveloperTaskRouteDependencies, "tableName">, access: TaskAccess) =>
  taskAccessFence(deps.tableName, access.task.taskId, access.peopleRevision);

/** A durable workflow dispatch uses the same fresh task-people proof and transactional fence as an accepted task. */
export async function systemTaskDispatchAccessFence(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord): Promise<TransactItems[number] | undefined> {
  const access = await systemTaskAccess(deps, task);
  return access === undefined ? undefined : accessFence(deps, access);
}
