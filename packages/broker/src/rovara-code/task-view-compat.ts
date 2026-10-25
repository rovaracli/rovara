// Rovara Code (Plan 6 Task 1): older CLI and MCP clients still parse a task with the version 1 schema (a fixed definition version, nine stages, six outcomes
// and a strict pull request). A client that sends `x-agentx-task-view: 2` reads the full view; any other client is served this projection of it.
import { TASK_VIEW_HEADER, TASK_VIEW_VERSION, type DeveloperTaskView } from "@agentx/contracts";

type Headers = Readonly<Record<string, string | undefined>>;

/** Whether the request asks for the full view: the header, in any case, with exactly the value `2`. */
export function readsTaskViewVersion2(headers: Headers): boolean {
  for (const [name, value] of Object.entries(headers)) if (name.toLowerCase() === TASK_VIEW_HEADER && value?.trim() === TASK_VIEW_VERSION) return true;
  return false;
}

/** What version 1 clients do not know and must not be sent: the new snapshot fields (all of them, on both versions) and a pull request's `syncedFrom`. */
const NEW_WORKFLOW_FIELDS = ["intent", "critique", "risk", "fixRounds", "fixSource"] as const;

/**
 * The task as a client that does not send `x-agentx-task-view: 2` may read it: UNDERSTAND and PLAN_CRITIQUE read as PLAN, the outcome ANSWERED as CLOSED, the
 * definition version as 1.0.0, and the fields version 1 did not have are left out. A view with no workflow is returned as it is.
 */
export function taskViewForClient(view: DeveloperTaskView, headers: Headers): DeveloperTaskView {
  const workflow = view.workflow;
  if (workflow === undefined || readsTaskViewVersion2(headers)) return view;
  const rest: Record<string, unknown> = { ...workflow };
  for (const field of NEW_WORKFLOW_FIELDS) delete rest[field];
  const pullRequests = workflow.pullRequests?.map(({ syncedFrom: _syncedFrom, ...pullRequest }) => pullRequest); // eslint-disable-line @typescript-eslint/no-unused-vars -- left out on purpose
  return {
    ...view,
    workflow: {
      ...rest,
      definitionVersion: "1.0.0",
      stage: workflow.stage === "UNDERSTAND" || workflow.stage === "PLAN_CRITIQUE" ? "PLAN" : workflow.stage,
      ...(workflow.outcome === "ANSWERED" ? { outcome: "CLOSED" as const } : {}),
      ...(pullRequests === undefined ? {} : { pullRequests }),
    } as NonNullable<DeveloperTaskView["workflow"]>,
  };
}

/** A route's answer with its `task` (if it has one) projected for the client; any other answer is returned as it is. */
export function taskResponseForClient(answer: unknown, headers: Headers): unknown {
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) return answer;
  const task = (answer as { task?: unknown }).task;
  if (task === null || typeof task !== "object" || (task as { workflow?: unknown }).workflow === undefined) return answer;
  return { ...answer, task: taskViewForClient(task as DeveloperTaskView, headers) };
}
