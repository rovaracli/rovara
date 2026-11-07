// UX2 slice 2 item 3: review findings are decided on the task page in Rovara, with the same authority as Slack and the MCP tools. `POST /v1/app/tasks/{id}/workflow/review-findings` (Resolve findings: fix or
// accept each blocking finding) and `POST /v1/app/tasks/{id}/workflow/send-back` (Send back to coding) call the very functions the `/v1/dev` routes and the Slack buttons call; each re-reads the task and
// checks the caller's live access itself (`authorizeTaskAction`, the send-back's project role, the revision and candidate fences). Nothing here decides who may.
import { resolveTaskWorkflowFindings, sendTaskWorkflowBackToCoding } from "../developer-tasks.js";
import { developerTaskRouteDependencies } from "./dependencies.js";
import { StatusReply } from "../status-reply.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { jsonBody } from "./organization.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const TASK_FINDINGS_ROUTE = /^\/v1\/app\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/workflow\/(review-findings|send-back)$/u;

/** The two routes; undefined for any other path or method. */
export async function routeTaskFindings(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL): Promise<StatusReply | undefined> {
  const match = TASK_FINDINGS_ROUTE.exec(url.pathname);
  if (match === null || request.method !== "POST") return undefined;
  const tasks = developerTaskRouteDependencies(deps, caller);
  const answer = match[2] === "review-findings"
    ? await resolveTaskWorkflowFindings(tasks, caller, match[1]!, jsonBody(request))
    : await sendTaskWorkflowBackToCoding(tasks, caller, match[1]!, jsonBody(request));
  return new StatusReply(200, answer);
}
