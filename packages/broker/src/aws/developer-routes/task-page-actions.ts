// OWNER DECISION 7: what the old review page (`/review/<task>/task`) could still press on a stopped task, now on the task page in Rovara, through the very functions that page and Slack call:
//   POST /v1/app/tasks/{id}/workflow/checks-retry   Retry the browser and API checks of a blocked round (`retryApplicationRoundOnPage`: the task's `retry` role, only a block a retry can fix, at the revision shown)
//   POST /v1/app/tasks/{id}/workflow/revise-plan    Revise the plan after coding stopped for the owner's live message (`reviseTaskWorkflowPlan`, as the Slack button and the `/v1/dev` route)
// A held spec's choices already have their route (`spec-routes.ts`). Each function re-reads the task and checks the caller's live access itself; nothing here decides who may.
import { agentXError } from "@agentx/contracts";
import { reviseTaskWorkflowPlan, retryApplicationRoundOnPage } from "../developer-tasks.js";
import { PageRetryInputSchema } from "../task-web-api.js";
import { developerTaskRouteDependencies } from "./dependencies.js";
import { StatusReply } from "../status-reply.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { jsonBody } from "./organization.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const TASK_PAGE_ACTION_ROUTE = /^\/v1\/app\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/workflow\/(checks-retry|revise-plan)$/u;

/** The two routes; undefined for any other path or method. Both answer the task's revision after the press. */
export async function routeTaskPageActions(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL): Promise<StatusReply | undefined> {
  const match = TASK_PAGE_ACTION_ROUTE.exec(url.pathname);
  if (match === null || request.method !== "POST") return undefined;
  if (deps.tasks === undefined) throw agentXError("NOT_FOUND", "developer tasks are not set up in this deployment");
  const tasks = developerTaskRouteDependencies(deps, caller);
  const taskId = match[1]!.toLowerCase();
  if (match[2] === "checks-retry") {
    // The same strict body the page sent: the request ID and the revision the person saw; nothing else rides along.
    const parsed = PageRetryInputSchema.safeParse(jsonBody(request));
    if (!parsed.success) throw agentXError("CONFIG_INVALID", "send the request ID and the task's revision");
    return new StatusReply(200, await retryApplicationRoundOnPage(tasks, caller, taskId, parsed.data));
  }
  return new StatusReply(200, await reviseTaskWorkflowPlan(tasks, caller, taskId, jsonBody(request)));
}
