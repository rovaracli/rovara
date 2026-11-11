// OWNER DECISION 7: what the old review page (`/review/<task>/task`) could still press on a stopped task, now on the task page in Rovara, through the very functions that page and Slack call:
//   POST /v1/app/tasks/{id}/workflow/checks-retry   Retry the browser and API checks of a blocked round (`retryApplicationRoundOnPage`: the task's `retry` role, only a block a retry can fix, at the revision shown)
//   POST /v1/app/tasks/{id}/workflow/revise-plan    Revise the plan after coding stopped for the owner's live message (`reviseTaskWorkflowPlan`, as the Slack button and the `/v1/dev` route)
//   GET  /v1/app/tasks/{id}/comments                       the task's review comments with Remember state (`listPageComments`, the old page's own list and access rule)
//   POST /v1/app/tasks/{id}/comments/{commentId}/remember|forget   Remember and Forget on a comment (`rememberTaskComment`, `forgetTaskComment`, as the old page; a live browser session only, as every learning write)
//   GET  /v1/app/tasks/{id}/people, POST .../people/role, POST .../people/take-ownership   the task's People, through the `/v1/dev` route itself (the functions Slack and the MCP tool use); a role change
//        or a take-over is a pending change confirmed on its confirmation page, as from Slack
// A held spec's choices already have their route (`spec-routes.ts`). Each function re-reads the task and checks the caller's live access itself; nothing here decides who may.
import { agentXError } from "@rovara-code/contracts";
import { LearningTaskPageBodySchema } from "@rovara-code/contracts";
import { listPageComments, reviseTaskWorkflowPlan, retryApplicationRoundOnPage, routeDeveloperTaskRequest } from "../developer-tasks.js";
import { forgetTaskComment, rememberTaskComment } from "../../learning/capture-comment.js";
import { PageRetryInputSchema } from "../task-web-api.js";
import { developerTaskRouteDependencies } from "./dependencies.js";
import { StatusReply } from "../status-reply.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { jsonBody } from "./organization.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const TASK_COMMENTS_ROUTE = new RegExp(`^/v1/app/tasks/(${UUID})/comments(?:/(${UUID})/(remember|forget))?$`, "u");
export const TASK_PEOPLE_ROUTE = new RegExp(`^/v1/app/tasks/(${UUID})/people(?:/(role|take-ownership))?$`, "u");
/** Said to a caller without a live browser session (a token): Remember and Forget, like every learning write, are the browser's. */
export const TASK_COMMENT_LEARNING_BROWSER_MESSAGE = "Use a live browser session to remember or forget a comment.";

export const TASK_PAGE_ACTION_ROUTE = /^\/v1\/app\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/workflow\/(checks-retry|revise-plan)$/u;

/** The two routes; undefined for any other path or method. Both answer the task's revision after the press. */
export async function routeTaskPageActions(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL): Promise<StatusReply | undefined> {
  const comments = TASK_COMMENTS_ROUTE.exec(url.pathname);
  if (comments !== null) {
    if (deps.tasks === undefined) throw agentXError("NOT_FOUND", "developer tasks are not set up in this deployment");
    const tasks = developerTaskRouteDependencies(deps, caller);
    const taskId = comments[1]!.toLowerCase();
    if (comments[2] === undefined) return request.method === "GET" ? new StatusReply(200, await listPageComments(tasks, caller, taskId)) : undefined;
    if (request.method !== "POST") return undefined;
    if (caller.browserSession !== true) throw agentXError("FORBIDDEN", TASK_COMMENT_LEARNING_BROWSER_MESSAGE);
    // The body is empty and strict: standing, author and stage are never the caller's to say.
    if (!LearningTaskPageBodySchema.safeParse(jsonBody(request)).success) throw agentXError("CONFIG_INVALID", "send an empty body");
    const learn = comments[3] === "remember" ? rememberTaskComment : forgetTaskComment;
    return new StatusReply(200, await learn(tasks, caller, taskId, comments[2].toLowerCase(), { audit: deps.agents?.audit }));
  }
  const people = TASK_PEOPLE_ROUTE.exec(url.pathname);
  if (people !== null) {
    if ((people[2] === undefined) !== (request.method === "GET") || (request.method !== "GET" && request.method !== "POST")) return undefined;
    if (deps.tasks === undefined) throw agentXError("NOT_FOUND", "developer tasks are not set up in this deployment");
    // The very route Slack's flow and the MCP tool reach (`/v1/dev/tasks/{id}/people*`): its parse, authority and pending-change rules, unchanged.
    const devUrl = new URL(url.href.replace("/v1/app/tasks/", "/v1/dev/tasks/"));
    const answer = await routeDeveloperTaskRequest(developerTaskRouteDependencies(deps, caller), caller, { ...request, path: devUrl.pathname }, devUrl);
    return answer instanceof StatusReply ? answer : new StatusReply(200, answer as object);
  }
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
