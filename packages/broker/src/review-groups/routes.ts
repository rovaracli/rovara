// Review groups (owner decision 9): the routes, and their dependencies built from the developer routes' own. The rules are in `groups.ts` (a project's groups) and `claims.ts`
// (a task's claim). Every write is browser-only: the dispatcher refuses a token, the CLI and Slack before any read (`isReviewGroupsWrite`). The Auditor reaches none of these
// (they are not on its allow-list).
//   GET|PUT /v1/app/projects/{p}/review-groups
//   GET     /v1/app/tasks/{t}/review
//   POST    /v1/app/tasks/{t}/review/(claim|release|reassign)
import { REVIEW_GROUPS_PATH, REVIEW_GROUP_MESSAGES, TASK_REVIEW_ACTION_PATH, TASK_REVIEW_PATH, isWriterOrgRole, type ReviewClaimAction } from "@agentx/cloud-contracts";
import { agentXError, type OrgId } from "@rovara-code/contracts";
import { orgRoleOf, type OwnedAccessDeps } from "../agents/access.js";
import { safeDisplayName } from "../developer/person-name.js";
import { nameResolverOf, resolveStoredName } from "../developer/name-resolver.js";
import { githubLoginOf } from "../developer/requester-text.js";
import { resolveTaskAccess } from "../developer/task-access.js";
import { effectiveTaskOwner, type DeveloperTaskRecord } from "../developer/task-records.js";
import { loadTaskPeople } from "../developer/task-people.js";
import { readCodeSettings } from "../rovara-code/code-settings.js";
import { changeRequestRef } from "../rovara-code/host-port.js";
import { readMergeTracking } from "../rovara-code/merge-tracking.js";
import type { AdaptedHttpRequest } from "../aws/lambda.js";
import { signInStoreOf } from "../aws/developer-routes/common.js";
import { developerTaskRouteDependencies } from "../aws/developer-routes/dependencies.js";
import { jsonBody } from "../aws/developer-routes/organization.js";
import { projectMembersOf } from "../aws/developer-routes/project-list.js";
import { projectRoleForRoute } from "../aws/developer-routes/project-members.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes/types.js";
import { claimReview, getTaskReview, reassignReview, releaseReview, type ReviewClaimDeps } from "./claims.js";
import { getReviewGroups, putReviewGroups } from "./groups.js";

export const REVIEW_GROUPS_BROWSER_MESSAGE = REVIEW_GROUP_MESSAGES.browserOnly;

/** A task's real owners as member ids: its effective owner (a taker first) and every owner entry of its People list. Throws when the owner can't be read. */
export function realTaskOwners(record: DeveloperTaskRecord, people: { people: ReadonlyArray<{ developerId: string; role: string }> } | undefined): string[] {
  const entries = (people?.people ?? []).filter((person) => person.role === "owner").map((person) => person.developerId);
  return [...new Set([effectiveTaskOwner(record).developerId, ...entries])];
}

/** Whether a request writes review groups or a claim: the dispatcher sends anything but a live browser session away first. */
export function isReviewGroupsWrite(method: string, pathname: string): boolean {
  return (method === "PUT" && REVIEW_GROUPS_PATH.test(pathname)) || (method === "POST" && TASK_REVIEW_ACTION_PATH.test(pathname));
}

/** The dependencies of both modules, from the developer routes' own. Every role is read live. */
export function reviewClaimDepsOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller): ReviewClaimDeps {
  const table = { documentClient: deps.documentClient, tableName: deps.tableName };
  const members = projectMembersOf(deps);
  const store = signInStoreOf(deps);
  const access = { ...table, projectMembers: members, signInStore: store } as OwnedAccessDeps;
  /** The task records this request read (`taskFor`), for its owners. */
  const records = new Map<string, DeveloperTaskRecord>();
  return {
    ...table, now: () => deps.now(),
    ...(deps.audit === undefined ? {} : { audit: deps.audit }),
    projectFor: (who, rawName) => projectRoleForRoute(deps, who as DeveloperCaller, rawName),
    liveProjectRole: async (orgId, project, developerId) => {
      const orgRole = await orgRoleOf(access, orgId, developerId);
      // Not in the company, or the Auditor: no project role, so no reviewing.
      if (!isWriterOrgRole(orgRole)) return undefined;
      return members.roleOf(orgId, project, { developerId, orgRole });
    },
    nameOf: async (orgId: OrgId, developerId: string) => {
      try {
        const row = await store.getDeveloper(developerId);
        const stored = row === undefined ? "A former member" : safeDisplayName(row.displayName, developerId);
        return await resolveStoredName(nameResolverOf(deps, orgId), developerId, stored);
      } catch {
        return "A member";
      }
    },
    taskFor: async (who, taskId) => {
      const found = await resolveTaskAccess(developerTaskRouteDependencies(deps, caller), who as DeveloperCaller, taskId, "read");
      const task = found.task;
      if (task.orgId === undefined) throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
      records.set(task.taskId, task);
      return { task: { taskId: task.taskId, orgId: task.orgId, project: task.project, startingRevision: task.startingRevision, ...(task.closedAt === undefined ? {} : { closedAt: task.closedAt }), ...(task.workflow === undefined ? {} : { workflow: { stage: task.workflow.stage, state: task.workflow.state } }) } };
    },
    // The task's own owners, read from the task and its People list, never from the caller's access (a session-level reader is told none).
    ownersOf: async (task) => {
      const record = records.get(task.taskId);
      if (record === undefined) return "unknown";
      try {
        return realTaskOwners(record, await loadTaskPeople(table, task.taskId));
      } catch {
        return "unknown";
      }
    },
    // The target reads the task as any reader would: their own live company role, the task's People list and the project's access.
    canReadTask: async (task, developerId) => {
      try {
        const orgRole = await orgRoleOf(access, task.orgId, developerId);
        if (!isWriterOrgRole(orgRole)) return false;
        const target: DeveloperCaller = { developerId, orgId: task.orgId, orgRole, name: "A member", amr: caller.amr, sessionId: caller.sessionId };
        const found = await resolveTaskAccess(developerTaskRouteDependencies(deps, target), target, task.taskId, "read");
        return found.task.orgId === task.orgId;
      } catch {
        return false;
      }
    },
    readTracking: (taskId, orgId) => readMergeTracking(table, taskId, orgId),
    allowSelfApproval: async (orgId, project) => (await readCodeSettings(table, orgId, project)).allowSelfApproval,
    githubLoginOf: async (_orgId, developerId) => githubLoginOf(store, developerId),
    // The same port merge tracking asks reviewers through: the repository as the task's project pins it, and its code host.
    requestReviewer: async (task, pullRequest, login) => {
      const host = deps.agents?.codeMerge;
      if (host === undefined || task.startingRevision === undefined) return "unavailable";
      const home = await host.repository(task.project, task.startingRevision, pullRequest.repositoryId, task.orgId);
      const ask = home?.codeHost.requestReviewers?.bind(home.codeHost);
      if (home === undefined || ask === undefined) return "unavailable";
      return ask(changeRequestRef(home.url, pullRequest.number), [login], host.scope(task.orgId));
    },
  };
}

/** The review group and claim routes; undefined for any other path. */
export async function routeReviewGroups(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const groups = REVIEW_GROUPS_PATH.exec(url.pathname);
  if (groups !== null && (request.method === "GET" || request.method === "PUT")) {
    const reviewDeps = reviewClaimDepsOf(deps, caller);
    return request.method === "GET" ? getReviewGroups(reviewDeps, caller, groups[1]!) : putReviewGroups(reviewDeps, caller, groups[1]!, jsonBody(request));
  }
  const review = TASK_REVIEW_PATH.exec(url.pathname);
  if (review !== null && request.method === "GET") return getTaskReview(reviewClaimDepsOf(deps, caller), caller, review[1]!.toLowerCase());
  const action = TASK_REVIEW_ACTION_PATH.exec(url.pathname);
  if (action !== null && request.method === "POST") {
    const reviewDeps = reviewClaimDepsOf(deps, caller);
    const taskId = action[1]!.toLowerCase();
    const body = jsonBody(request);
    switch (action[2] as ReviewClaimAction) {
      case "claim": return claimReview(reviewDeps, caller, taskId, body);
      case "release": return releaseReview(reviewDeps, caller, taskId, body);
      case "reassign": return reassignReview(reviewDeps, caller, taskId, body);
    }
  }
  return undefined;
}
