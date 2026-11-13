// Switch blocker 4: the decider's LIVE standing on a task, for A6's approvers adapter (`CloudApproversDependencies.deciderRole`). Nothing here is a new rule: it asks the functions Cloud's own
// decision route asks (`aws/developer-tasks/decide.ts`), as the person, now:
//   owner / co-owner  `authorizeTaskAction(..., "decide")`: the task's owner and the owners of its People list, in their company, with the task open.
//   maintainer        `resolveTaskApprover`: a project maintainer (a company owner or admin counts as one) of a task that is not theirs, with the decision cards on, the task open and, when its People list
//                     narrowed it, the person on it. v2's seat for a coding plan only.
//   otherwise         the person's project role now (contributor, viewer), or `none`.
// Anything that cannot be read, a person who is no member now, and a subject that is not a task are `none` (fail closed): a lenient answer here decides who may approve.
import type { ApprovalDeciderRole } from "@agentx/cloud-contracts";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { authorizeTaskAction } from "../../aws/developer-tasks/access.js";
import { agentRunStarterOf, developerTaskRouteDependencies } from "../../aws/developer-routes/dependencies.js";
import type { DeveloperRouteDependencies } from "../../aws/developer-routes/types.js";
import { resolveTaskApprover } from "../../developer/task-access.js";
import { isTaskOwner, taskKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import type { CloudApproversDependencies } from "../adapters/people/index.js";

const TASK_ID = /^[0-9a-f-]{36}$/iu;

export function cloudDeciderRole(routesOf: () => DeveloperRouteDependencies): CloudApproversDependencies["deciderRole"] {
  return async (request, decider): Promise<ApprovalDeciderRole> => {
    if (request.subject.type !== "task" || !TASK_ID.test(request.subject.id) || decider.orgId !== request.companyId) return "none";
    const routes = routesOf();
    // The person as they are now: a person removed, revoked or moved to another company is not found, so they stand nowhere.
    const caller = await agentRunStarterOf(routes)?.callerFor(decider.orgId, decider.developerId);
    if (caller === undefined || caller.orgId !== request.companyId) return "none";
    const deps = developerTaskRouteDependencies(routes, caller);
    try {
      const access = await authorizeTaskAction(deps, caller, request.subject.id, "decide");
      return await isTaskOwner(access.task, caller.developerId) ? "owner" : "co-owner";
    } catch {
      // Not the owner or a co-owner: the maintainer's seat, then the project role.
    }
    if (await resolveTaskApprover(deps, caller, request.subject.id) !== undefined) return "maintainer";
    try {
      const task = ((await routes.documentClient.send(new GetCommand({ TableName: routes.tableName, Key: taskKey(request.subject.id), ConsistentRead: true }))) as { Item?: DeveloperTaskRecord }).Item;
      if (task === undefined || task.orgId !== request.companyId) return "none";
      const access = await deps.checkAccess(task.project);
      return access.role === "maintainer" ? "none" : access.role;
    } catch {
      return "none";
    }
  };
}
