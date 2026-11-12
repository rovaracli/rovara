// "Continue in your own tool" (decision 4, owner Q13): the two actions of the task page's Continue panel, both for the task's owner (or a co-owner) in a live browser session:
//   POST /v1/app/tasks/{id}/continue/publish-branch   make the task's working branch (`agentx/<taskId>`) in one repository, at the commit Rovara prepared the task on; opens no pull request (E-28)
//   POST /v1/app/tasks/{id}/continue/recheck          ask Rovara to re-check a pull request head that changed outside Rovara (owner Q13: manual, never automatic)
// What the panel reads (the branch names, "Changed outside Rovara · checks needed", who pushed) is `continueLoop` on the task view. Each action re-reads the task and checks the caller's live access itself.
import { agentXError } from "@rovara-code/contracts";
import { StatusReply } from "../status-reply.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { publishWorkingBranchAction, recheckAction } from "../developer-tasks/continue-loop.js";
import { developerTaskRouteDependencies } from "./dependencies.js";
import { jsonBody } from "./organization.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const CONTINUE_LOOP_ROUTE = /^\/v1\/app\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/continue\/(publish-branch|recheck)$/u;
/** Said to a caller without a live browser session (a token): both actions start with a person in front of the task page. */
export const CONTINUE_LOOP_BROWSER_MESSAGE = "Use a live browser session to publish a working branch or ask for a re-check.";

/** The two routes; undefined for any other path or method. */
export async function routeContinueLoop(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL): Promise<StatusReply | undefined> {
  const match = CONTINUE_LOOP_ROUTE.exec(url.pathname);
  if (match === null || request.method !== "POST") return undefined;
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", CONTINUE_LOOP_BROWSER_MESSAGE);
  if (deps.tasks === undefined) throw agentXError("NOT_FOUND", "developer tasks are not set up in this deployment");
  const tasks = developerTaskRouteDependencies(deps, caller);
  const taskId = match[1]!.toLowerCase();
  if (match[2] === "publish-branch") return new StatusReply(200, await publishWorkingBranchAction(tasks, caller, taskId, jsonBody(request)));
  return new StatusReply(200, await recheckAction(tasks, caller, taskId, jsonBody(request)));
}
