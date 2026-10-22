// Spec 061 slice 2: who may do what on a task page. Every check goes through resolveTaskAccess and the one role-to-action
// table below, so roles (slice 3) change only these two places; callers never decide roles themselves.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, projectAllows, projectMemberKey, type OrgId, type OrgRole, type ProjectRole } from "@agentx/contracts";
import { effectiveProjectRole, viewerCannotStartTasksMessage } from "./project-roles.js";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import type { DeveloperTaskRouteDependencies } from "../aws/developer-tasks.js";
import { resolveTaskPeopleAccess, type TaskRole } from "./task-people.js";
import { taskKey, taskOwnerKey, type DeveloperTaskRecord } from "./task-records.js";

export type { TaskRole } from "./task-people.js";
export type TaskAction = "read" | "peopleRead" | "comment" | "suggest" | "decide" | "ask" | "peopleManage" | "takeOwnership" | "retry" | "publish" | "feedback" | "close" | "control" | "work";

export const TASK_ACTION_ROLES: Record<TaskAction, readonly TaskRole[]> = {
  read: ["owner", "commenter", "viewer"],
  peopleRead: ["owner", "commenter", "viewer"],
  comment: ["owner", "commenter"],
  suggest: ["commenter"],
  decide: ["owner"],
  ask: ["owner", "commenter"],
  peopleManage: ["owner"],
  takeOwnership: ["owner", "commenter", "viewer"],
  retry: ["owner"],
  publish: ["owner"],
  feedback: ["owner"],
  close: ["owner"],
  control: ["owner"],
  // Continue, send back, share: the owner's actions that start agent work or put the task in front of others. Stopping stays `control`.
  work: ["owner"],
};

/**
 * Every action that changes a task or starts agent work (Plan 2, Task 21, round 3). Each goes through `requireProjectWorkRole` inside
 * `resolveTaskAccess`, the one place every surface (dev routes, the task page, Slack, MCP) resolves an action. `close` and `control` (stop)
 * are left out on purpose: a viewer who owns a task may still cancel it.
 */
export const WORK_ACTIONS: readonly TaskAction[] = ["decide", "retry", "publish", "feedback", "ask", "work"];

/**
 * The one gate for "viewers only view". An actor who holds a project grant that cannot start tasks (a viewer) is refused with the viewer
 * message; an actor with no grant (the share design), a maintainer, a contributor and an org owner or admin pass. `deps.checkAccess` is the
 * actor's own, read live. When it throws (the project turned off tasks from AI tools, Slack could not be asked, a read failed) the gate does
 * not fail open: it reads the actor's own grant row and org role directly (`effectiveProjectRole`, no channel) and judges by that; if that
 * read fails too it refuses with a retryable RUNTIME_UNAVAILABLE. People with no grant, and contributors on a project with AI tasks turned
 * off, keep today's behaviour either way.
 */
export async function requireProjectWorkRole(
  deps: Pick<AccessDependencies, "checkAccess" | "documentClient" | "tableName">,
  task: { project: string },
  actor: { developerId: string; orgId: OrgId; orgRole: OrgRole },
): Promise<void> {
  let role: ProjectRole | undefined;
  let granted: boolean;
  try {
    const result = await deps.checkAccess(task.project);
    role = result.role;
    granted = result.access === "granted";
  } catch {
    try {
      const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: projectMemberKey(actor.orgId, actor.developerId, task.project), ConsistentRead: true })) as { Item?: Record<string, unknown> };
      role = effectiveProjectRole(actor, response.Item, false);
      granted = true;
    } catch {
      throw agentXError("RUNTIME_UNAVAILABLE", "your role in this project could not be checked; try again in a moment");
    }
  }
  if (granted && role !== undefined && !projectAllows(role, "start_tasks")) {
    throw agentXError("PROJECT_ACCESS_DENIED", viewerCannotStartTasksMessage(task.project));
  }
}

/** Whether the actor may start or change work on the task now: false for a project viewer (or when that cannot be told). For the page's controls. */
export async function projectWorkAllowed(
  deps: Pick<AccessDependencies, "checkAccess" | "documentClient" | "tableName">,
  task: { project: string },
  actor: { developerId: string; orgId: OrgId; orgRole: OrgRole },
): Promise<boolean> {
  try {
    await requireProjectWorkRole(deps, task, actor);
    return true;
  } catch {
    return false;
  }
}

export function can(role: TaskRole, action: TaskAction): boolean {
  return TASK_ACTION_ROLES[action].includes(role);
}

/** A reader's access to one task, including the exact PEOPLE revision later writes must fence. */
export interface TaskAccess {
  task: DeveloperTaskRecord;
  role: TaskRole;
  peopleRevision?: number;
  ownerActorIds: readonly string[];
}

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type AccessDependencies = Pick<DeveloperTaskRouteDependencies,
  "documentClient" | "tableName" | "checkAccess" | "channelMember" | "slackTeamId" | "log" | "now" | "taskPeopleConfiguration" | "checkTaskPerson">;

const log = (deps: Pick<DeveloperTaskRouteDependencies, "log">, entry: Record<string, unknown>) =>
  (deps.log ?? ((line) => console.log(JSON.stringify({ component: "broker", ...line }))))(entry);

/**
 * The task a task-page reader may see, and their role. Not theirs and no such task both read as TASK_NOT_FOUND; only an
 * eligible teammate on the task's own Slack workspace who is not in the task's channel gets TASK_ACCESS_DENIED, with the
 * owner's name (FR-029). Whatever fails on the way (the project check, the membership lookup) reads as not found too,
 * because an answer that differed would confirm the task exists. With `action`, a reader whose possible roles could
 * not take it is refused as not found before any project or channel lookup.
 */
export async function resolveTaskAccess(deps: AccessDependencies, caller: DeveloperCaller, taskId: string, action?: TaskAction): Promise<TaskAccess> {
  const access = await resolveTaskRole(deps, caller, taskId, action);
  if (action !== undefined && WORK_ACTIONS.includes(action)) await requireProjectWorkRole(deps, access.task, caller);
  return access;
}

async function resolveTaskRole(deps: AccessDependencies, caller: DeveloperCaller, taskId: string, action?: TaskAction): Promise<TaskAccess> {
  const notFound = () => agentXError("TASK_NOT_FOUND", "no task here that you can see");
  if (!TASK_ID.test(taskId)) throw notFound();
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(taskId), ConsistentRead: true })) as { Item?: DeveloperTaskRecord };
  const task = response.Item;
  // Another org's task reads exactly as no task: never FORBIDDEN, which would confirm it exists.
  if (task === undefined || task.orgId !== caller.orgId) throw notFound();
  try {
    const people = await resolveTaskPeopleAccess(deps, task, caller.developerId);
    if (people !== undefined) {
      if (action !== undefined) {
        const read = action === "read" || action === "peopleRead";
        if ((!read && !taskOpen(task)) || !can(people.role, action)
          || (action === "takeOwnership" && !people.canTakeOwnership)
          || ((action === "peopleManage" || action === "takeOwnership") && deps.taskPeopleConfiguration?.peopleChangesEnabled !== true)) throw notFound();
      }
      return { task, role: people.role, peopleRevision: people.peopleRevision, ownerActorIds: people.ownerActorIds };
    }
  } catch {
    throw notFound();
  }
  const legacyOwners = [taskOwnerKey(task.developerId, task.taskId)];
  const legacyPeopleAction = action === "peopleManage" || action === "takeOwnership";
  if (task.developerId === caller.developerId) {
    if (legacyPeopleAction || (action !== undefined && action !== "read" && action !== "peopleRead" && !taskOpen(task))) throw notFound();
    return { task, role: "owner", ownerActorIds: legacyOwners };
  }
  // An action only owners may take needs no project or channel lookup for anyone else: they read as not found.
  if (action !== undefined && TASK_ACTION_ROLES[action].every((role) => role === "owner")) throw notFound();
  let usesProject = false;
  let projectRole: ProjectRole | undefined;
  try {
    projectRole = (await deps.checkAccess(task.project)).role;
    usesProject = true;
  } catch (error) {
    log(deps, { event: "developer.task_page_project_access_refused", taskId, errorName: error instanceof Error ? error.name : "unknown" });
  }
  const share = task.share;
  if (!usesProject || share === undefined || caller.slackUserId === undefined || deps.channelMember === undefined) throw notFound();
  let member: boolean;
  try {
    member = await deps.channelMember(caller.slackUserId, share.channelId);
  } catch (error) {
    log(deps, { event: "developer.task_page_membership_unavailable", taskId, errorName: error instanceof Error ? error.name : "unknown" });
    throw notFound();
  }
  if (!member) {
    // Only someone on the task's own Slack workspace who may use the project is told whom to ask.
    if (deps.slackTeamId === undefined || share.teamId !== deps.slackTeamId) throw notFound();
    throw Object.assign(agentXError("TASK_ACCESS_DENIED", "you can't open this task yet"), { owners: [ownerNameForReaders(task.developerName)] });
  }
  // A project viewer may look at a task in the channel but not take part: only a role that can start tasks comments, suggests or asks.
  const role: TaskRole = projectRole !== undefined && !projectAllows(projectRole, "start_tasks") ? "viewer" : "commenter";
  if (legacyPeopleAction || (action !== undefined && (!can(role, action)
    || (action !== "read" && action !== "peopleRead" && !taskOpen(task))))) throw notFound();
  return { task, role, ownerActorIds: legacyOwners };
}

/**
 * The owner's name as a reader outside the channel is told it. A task started in Slack knows its owner only by Slack
 * user ID ("Slack user U0…"), which is no name a person recognises, so the reader is told to ask the task owner.
 */
export function ownerNameForReaders(developerName: string): string {
  return /^Slack user [UW][A-Z0-9]{2,31}$/.test(developerName) ? "the task owner" : developerName;
}

/** Whether the task still takes comments, suggestions and decisions: not closed and not finished. */
export function taskOpen(task: DeveloperTaskRecord): boolean {
  return task.closedAt === undefined && task.workflow?.stage !== "CLOSED" && task.workflow?.stage !== "MERGED";
}

/** What a reader may do on the page now, for the page view. */
export function pageAccess(access: TaskAccess, workAllowed = true): { role: TaskRole; canComment: boolean; canSuggest: boolean; canDecide: boolean; canAsk: boolean } {
  const open = taskOpen(access.task);
  return {
    role: access.role,
    canComment: open && can(access.role, "comment"),
    canSuggest: open && can(access.role, "suggest"),
    // Deciding and asking are work: a project viewer (an owner lowered to viewer included) is not offered them.
    canDecide: open && workAllowed && can(access.role, "decide"),
    canAsk: open && workAllowed && can(access.role, "ask"),
  };
}
