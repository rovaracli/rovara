// Rovara Code (Plan 6 Task 1): older CLI and MCP clients still parse a task with the version 1 schema (a fixed definition version, nine stages, six outcomes
// and a strict pull request). A client that sends `x-agentx-task-view: 2` reads the full view; any other client is served this projection of it.
import { TASK_VIEW_HEADER, TASK_VIEW_VERSION } from "@rovara-code/contracts";
import { type DeveloperTaskView } from "@agentx/cloud-contracts";

type Headers = Readonly<Record<string, string | undefined>>;

/** Whether the request asks for the full view: the header, in any case, with exactly the value `2`. */
export function readsTaskViewVersion2(headers: Headers): boolean {
  for (const [name, value] of Object.entries(headers)) if (name.toLowerCase() === TASK_VIEW_HEADER && value?.trim() === TASK_VIEW_VERSION) return true;
  return false;
}

/** What version 1 clients do not know and must not be sent: the new snapshot fields (all of them, on both versions) and a pull request's `syncedFrom`. */
const NEW_WORKFLOW_FIELDS = ["intent", "critique", "designReview", "risk", "fixRounds", "fixSource", "branchSync", "conflictBase"] as const;

/** The run estimate without the time range (Plan 6 Task 7), which version 1 clients' strict estimate does not know. A view with no time range is returned as it is. */
function withoutRunMinutes(view: DeveloperTaskView): DeveloperTaskView {
  if (view.runEstimate?.minutes === undefined) return view;
  const { minutes: _minutes, ...estimate } = view.runEstimate; // eslint-disable-line @typescript-eslint/no-unused-vars -- left out on purpose
  return { ...view, runEstimate: estimate };
}

/**
 * The task as a client that does not send `x-agentx-task-view: 2` may read it: UNDERSTAND and PLAN_CRITIQUE read as PLAN, the outcome ANSWERED as CLOSED, the
 * definition version as 1.0.0, and the fields version 1 did not have are left out. The version 2 fields of the view (`verificationReport`, `proofTable`, `evidence`, `reviewModelLines`, `reviewRound`, `mergeTracking`, `merge`, `earlyRiskSignal`, `continueLoop`) are left out too, and the estimate's time range. A view with no workflow and none of those fields is returned as it is.
 */
export function taskViewForClient(input: DeveloperTaskView, headers: Headers): DeveloperTaskView {
  if (readsTaskViewVersion2(headers)) return input;
  const view = withoutRunMinutes(input);
  // Version 2 fields of the view itself (Task 12): an older client's strict view has no place for them, so they are left out whether or not a workflow is there.
  const { verificationReport: _verificationReport, proofTable: _proofTable, evidence: _evidence, reviewModelLines: _reviewModelLines, reviewRound: _reviewRound, mergeTracking: _mergeTracking, merge: _merge, earlyRiskSignal: _earlyRiskSignal, continueLoop: _continueLoop, ...withoutNewFields } = view; // eslint-disable-line @typescript-eslint/no-unused-vars -- left out on purpose
  const workflow = withoutNewFields.workflow;
  if (workflow === undefined) return "verificationReport" in view || "proofTable" in view || "evidence" in view || "reviewModelLines" in view || "reviewRound" in view || "mergeTracking" in view || "merge" in view || "earlyRiskSignal" in view || "continueLoop" in view ? withoutNewFields : view;
  const rest: Record<string, unknown> = { ...workflow };
  for (const field of NEW_WORKFLOW_FIELDS) delete rest[field];
  // A cause of a failed push that version 1 clients do not know reads as the one they do (Plan 6 Task 17).
  const failure = rest["pullRequestUpdateFailure"] as { cause?: string } | undefined;
  if (failure?.cause === "BASE_CHANGES_DROPPED") rest["pullRequestUpdateFailure"] = { ...failure, cause: "PUSH_REFUSED" };
  const pullRequests = workflow.pullRequests?.map(({ syncedFrom: _syncedFrom, ...pullRequest }) => pullRequest); // eslint-disable-line @typescript-eslint/no-unused-vars -- left out on purpose
  return {
    ...withoutNewFields,
    workflow: {
      ...rest,
      definitionVersion: "1.0.0",
      stage: workflow.stage === "UNDERSTAND" || workflow.stage === "PLAN_CRITIQUE" ? "PLAN" : workflow.stage,
      ...(workflow.outcome === "ANSWERED" ? { outcome: "CLOSED" as const } : {}),
      ...(pullRequests === undefined ? {} : { pullRequests }),
    } as NonNullable<DeveloperTaskView["workflow"]>,
  };
}

/** Whether a task in a route's answer has anything the version 1 projection changes: a workflow, or a version 2 field of the view. */
function projectable(task: unknown): boolean {
  if (task === null || typeof task !== "object") return false;
  const view = task as Record<string, unknown>;
  return view.workflow !== undefined || "verificationReport" in view || "proofTable" in view || "evidence" in view || "reviewModelLines" in view || "reviewRound" in view || "mergeTracking" in view || "merge" in view || "earlyRiskSignal" in view || "continueLoop" in view;
}

/** A route's answer with its `task` (if it has one) projected for the client; any other answer is returned as it is. */
export function taskResponseForClient<T>(answer: T, headers: Headers): T {
  if (readsTaskViewVersion2(headers) || answer === null || typeof answer !== "object" || Array.isArray(answer)) return answer;
  const task = (answer as { task?: unknown }).task;
  if (!projectable(task)) return answer;
  return { ...answer, task: taskViewForClient(task as DeveloperTaskView, headers) };
}

/** A session route's answer (`{ session }`) with the task of a task session's body projected for the client; a chain or local body, and any other answer, is returned as it is. */
export function sessionResponseForClient<T>(answer: T, headers: Headers): T {
  if (readsTaskViewVersion2(headers) || answer === null || typeof answer !== "object" || Array.isArray(answer)) return answer;
  const session = (answer as { session?: unknown }).session;
  if (session === null || typeof session !== "object") return answer;
  const body = (session as { body?: unknown }).body;
  if (body === null || typeof body !== "object" || (body as { kind?: unknown }).kind !== "task") return answer;
  const task = (body as { task?: unknown }).task;
  if (!projectable(task)) return answer;
  return { ...answer, session: { ...session, body: { ...body, task: taskViewForClient(task as DeveloperTaskView, headers) } } };
}
