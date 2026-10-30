import { agentXError, type TaskPeopleRoleRequestSchema, type TaskPeopleTakeOwnershipRequestSchema } from "@agentx/contracts";
import type { z } from "zod";
import { taskKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import type { DeveloperCaller } from "../developer-routes.js";
import { resolveTaskAccess } from "../../developer/task-access.js";
import { getTaskPeoplePresentation } from "../../developer/task-people.js";
import { getTaskPeople as readTaskPeople, getTaskPeopleCapabilities as readTaskPeopleCapabilities } from "../../developer/task-people.js";
import {
  confirmTaskPeopleProposal as confirmPeopleProposal,
  getTaskPeopleProposal as readPeopleProposal,
  getTaskPeopleProposalMetadata as readPeopleProposalMetadata,
  proposeTaskOwnership,
  proposeTaskPeopleRole,
  submitSlackTaskOwnership as commitSlackTaskOwnership,
  submitSlackTaskPeopleRole as commitSlackTaskPeopleRole,
} from "../../developer/task-people-effects.js";
import { ensureTaskSession, lazyTaskSessionRecord } from "../../agent-sessions/create.js";
import { askTakeOver, requireTakeOverOfNewSession } from "../../agent-sessions/take-over.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";
import { get, inertTaskTitle } from "./common.js";

export function taskPeopleEffectsDependencies(deps: DeveloperTaskRouteDependencies) {
  if (deps.issuer === undefined || deps.issuer === "") throw agentXError("RUNTIME_UNAVAILABLE", "Task People confirmation is unavailable in this deployment");
  return { ...deps, issuer: deps.issuer };
}

export const getTaskPeople = (deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string) =>
  readTaskPeople(deps, caller, taskId);
export const getTaskPeopleCapabilities = (deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string) =>
  readTaskPeopleCapabilities(deps, caller, taskId);

/**
 * The People list for the task page: what `getTaskPeople` answers, except that a reader who holds the task only through a session level (Plan 5)
 * gets nothing (undefined) where the list would refuse them. They read the task, not who may act on it.
 */
export async function getTaskPeopleForPage(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string): Promise<Awaited<ReturnType<typeof readTaskPeople>> | undefined> {
  try {
    return await readTaskPeople(deps, caller, taskId);
  } catch (error) {
    const viaSession = await resolveTaskAccess(deps, caller, taskId, "peopleRead").then((access) => access.source === "session", () => false);
    if (viaSession) return undefined;
    throw error;
  }
}
export const getTaskPeopleProposal = (deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, requestId: string) =>
  readPeopleProposal(taskPeopleEffectsDependencies(deps), caller, taskId, requestId);
export const getTaskPeopleProposalMetadata = (deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, requestId: string) =>
  readPeopleProposalMetadata(taskPeopleEffectsDependencies(deps), caller, taskId, requestId);
export const confirmTaskPeopleProposal = (deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, requestId: string) =>
  confirmPeopleProposal(taskPeopleEffectsDependencies(deps), caller, taskId, requestId);
export const proposeTaskPeopleRoleForPage = (deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string,
  input: z.infer<typeof TaskPeopleRoleRequestSchema>) => proposeTaskPeopleRole(taskPeopleEffectsDependencies(deps), caller, taskId, input);
export const proposeTaskOwnershipForPage = async (deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string,
  input: z.infer<typeof TaskPeopleTakeOwnershipRequestSchema>) => (await codeOwnershipConfirmation(deps, caller, taskId, input))?.pending ?? proposeTaskOwnership(taskPeopleEffectsDependencies(deps), caller, taskId, input);

export async function getTaskPersonPresentationName(deps: DeveloperTaskRouteDependencies, taskId: string, personId: string): Promise<string | undefined> {
  return (await getTaskPeoplePresentation(deps, taskId)).find((person) => person.personId === personId)?.name;
}
export const submitSlackTaskPeopleRole = (deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string,
  input: { requestId: string; expectedPeopleRevision: number; slackUserId: string; role: "owner" | "commenter" | "viewer" | "denied"; teamId: string; channelId: string }) =>
  commitSlackTaskPeopleRole(taskPeopleEffectsDependencies(deps), caller, taskId, input);
export const submitSlackTaskOwnership = async (deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string,
  input: { requestId: string; expectedPeopleRevision: number }) => (await codeOwnershipConfirmation(deps, caller, taskId, input))?.pending ?? commitSlackTaskOwnership(taskPeopleEffectsDependencies(deps), caller, taskId, input);

/** All legacy Code ownership surfaces use the same live session confirmation. */
export async function codeOwnershipConfirmation(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, input: { requestId: string }) {
  const task = await get<DeveloperTaskRecord>(deps, taskKey(taskId));
  if (task === undefined || task.orgId !== caller.orgId) throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
  if (task.workflow?.definitionId !== "agentx-task-to-pr") return undefined;
  const sessions = deps.agentRuns?.agentSessions;
  if (sessions === undefined) {
    // Without the session machinery nothing can be asked, but a person the task's own rules never let take it over is told that, not "unavailable" (as before Task 23).
    await resolveTaskAccess(deps, caller, taskId, "takeOwnership");
    throw agentXError("RUNTIME_UNAVAILABLE", "Taking a session over isn't available right now.");
  }
  // Authority first (Task 23 re-check N2): the take-over rules are run over the session the task would get, and only a caller who passes them causes the missing row to be made.
  if (task.sessionId === undefined) {
    const pending = lazyTaskSessionRecord(task, { ownerName: task.developerName, title: inertTaskTitle(task.title) });
    if (pending === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "This task's session cannot be created right now.");
    await requireTakeOverOfNewSession(sessions, caller, pending);
  }
  const sessionId = task.sessionId ?? await ensureTaskSession({ documentClient: deps.documentClient, tableName: deps.tableName, now: () => deps.now() }, task, { ownerName: task.developerName, title: inertTaskTitle(task.title) });
  if (sessionId === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "This task's session cannot be created right now.");
  const reply = await askTakeOver(sessions, caller, sessionId, { requestId: input.requestId }, deps.agentRuns);
  return { reply, pending: { status: "PENDING" as const, requestId: input.requestId, confirmationUrl: reply.body.confirmUrl, expiresAt: reply.expiresAt } };
}
