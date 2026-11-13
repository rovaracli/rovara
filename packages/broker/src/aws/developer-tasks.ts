// Spec 025 FR-016 to FR-021: the developer task routes. Every task has its own workspace, reached
// through the existing handlers (DeveloperTaskActions) with the task's owner key. Nothing here
// reads the deployment mode (FR-024).
// The code now lives in ./developer-tasks/ (split by scripts/split/split-developer.ts); this file composes it and keeps the original export list.
import "../agents/roster.js";
import "../org/task-stop-window.js";
import "../org/task-start-agent-authority.js";
import "../org/task-start-project-authority.js";
import "../org/task-stop-admission.js";
import "../org/budget-amount.js";
import "../agents/budget-authority.js";
import "../agents/access.js";
import "../agents/table-writes.js";
// The file's own imports, first and in their old order, so every dependency loads exactly as it did before the split.
import "../org/task-stop-funding.js";
import "../developer/requester-text.js";
import "../developer/workflow-actions.js";
import "@agentx/cloud-contracts";
import "../developer/share.js";
import "../developer/pull-request-feedback-section.js";
import "../org/budget.js";
import "../spend/admission.js";
import "../rovara-code/parallel-parts.js";
import "../spend/estimate.js";
import "../rovara-code/critic.js";
import "../rovara-code/duration.js";
import "../spend/settings.js";
import "../spend/top-ups.js";
import "../developer/limits.js";
import "../developer/task-records.js";
import "./workflow-cancel-reconcile.js";
import "./broker-shared.js";
import "../developer/plan-evidence-jobs.js";
import "../developer/plan-artifacts.js";
import "./stuck-setup.js";
import "./operation-events.js";
import "../rovara-code/setup-status.js";
import "../rovara-code/early-risk-signal.js";
import "./cancellation.js";
import "./task-dispatch-access.js";
import "../developer/notifications.js";
import "../developer/feedback-review-measures.js";
import "../developer/workflow-messages.js";
import "./task-plan-document.js";
import "./plan-page/comments.js";
import "../developer/plan-self-check.js";
import "../developer/task-access.js";
import "../learning/capture-decision.js";
import "../learning/comment-flags.js";
import "../developer/task-people.js";
import "../developer/task-people-effects.js";
import "../developer/prompt-text.js";
import "../e2e/owner-sentences.js";
import "../e2e/requalify-hold.js";
import "../developer/autofix-messages.js";
import "../developer/page-comments.js";
import "../developer/owner-answers.js";
import "../developer/creator-member.js";
import "../developer/project-roles.js";
import "../rovara-code/setup-draft.js";
import "../agents/runs.js";
import "../agent-sessions/bindings.js";
import "../agent-sessions/events.js";
import "../agent-sessions/create.js";
import "../agent-sessions/access.js";
import "../rovara-code/sharing.js";
import "../agent-sessions/take-over.js";
import "./status-reply.js";
import "../agents/run-engine.js";
import "../agents/task-end.js";
import "./task-end-row.js";
import "../rovara-code/understand.js";
import "../rovara-code/question-answers.js";
import "../rovara-code/answered.js";
import "../rovara-code/verification-report.js";
import "../rovara-code/merge-tracking.js";
import "../rovara-code/ci-fix.js";
import "../rovara-code/branch-sync.js";
import "./workflow-merge-recovery.js";
import "../rovara-code/changed-files.js";
import "../rovara-code/inert-text.js";
import "../rovara-code/review-model-lines.js";
import "../rovara-code/pull-request-body.js";
import "../rovara-code/proof-inputs.js";
import "../rovara-code/proof-view.js";
import "../rovara-code/linear-close.js";
import "../rovara-code/outcome-hooks.js";
import "../developer/test-proof-lines.js";
import { agentXError, WorkflowFeedbackFindingsDecisionRequestSchema, WorkflowFeedbackReviewRetryRequestSchema, TaskPeopleRoleRequestSchema, TaskPeopleTakeOwnershipRequestSchema } from "@rovara-code/contracts";
import { type DeveloperTaskView } from "@agentx/cloud-contracts";
import type { DeveloperCaller } from "./developer-routes.js";
import type { AdaptedHttpRequest } from "./lambda.js";
import { proposeTaskOwnership, proposeTaskPeopleRole } from "../developer/task-people-effects.js";
import { StatusReply } from "./status-reply.js";
import { CORE_TASK_ANSWERED_ACTIONS, coreActionWords, CORE_TASK_CLOUD_ACTIONS, coreTaskRoutes } from "../rovara-code/task-routes.js";
import type { DeveloperTaskRouteDependencies } from "./developer-tasks/types.js";
import { body, parse } from "./developer-tasks/common.js";
import { e2ePublicationContext } from "./developer-tasks/publication-context.js";
import { codeOwnershipConfirmation, getTaskPeople, getTaskPeopleProposal, taskPeopleEffectsDependencies } from "./developer-tasks/task-people.js";
import { getWorkflowFeedbackReview, submitWorkflowFeedbackDecision } from "./developer-tasks/feedback-review.js";
import { startTask } from "./developer-tasks/start.js";
import { getTaskPlan, listTasks, readTask, taskEvents } from "./developer-tasks/task-reads.js";
import { continueTask } from "./developer-tasks/continue.js";
import { decideTaskWorkflow } from "./developer-tasks/decide.js";
import { retryTaskWorkflow } from "./developer-tasks/workflow-retry.js";
import { resolveTaskWorkflowFindings, retryTaskCanvasCloseout, sendTaskWorkflowBackToCoding } from "./developer-tasks/workflow-coding.js";
import { reviseTaskWorkflowPlan } from "./developer-tasks/workflow-revise.js";
import { startTaskWorkflowReview } from "./developer-tasks/workflow-review.js";
import { keepTaskWorkflowPullRequests, retryTaskWorkflowPublication } from "./developer-tasks/publication.js";
import { retryTaskWorkflowFeedbackReview } from "./developer-tasks/feedback-capture.js";
import { cancelTask } from "./developer-tasks/cancel.js";
import { closeTask, openPullRequest } from "./developer-tasks/close.js";
import { safeDecode, shareTask } from "./developer-tasks/share.js";
export { type DeveloperTaskRouteDependencies } from "./developer-tasks/types.js";
export {
  CLOSED_TASK,
  inertTaskTitle,
  ownerLabel,
  storedRequestText,
  taskPageUrl,
} from "./developer-tasks/common.js";
export {
  confirmTaskPeopleProposal,
  getTaskPeople,
  getTaskPeopleCapabilities,
  getTaskPeopleForPage,
  getTaskPeopleProposal,
  getTaskPeopleProposalMetadata,
  getTaskPersonPresentationName,
  proposeTaskOwnershipForPage,
  proposeTaskPeopleRoleForPage,
  submitSlackTaskOwnership,
  submitSlackTaskPeopleRole,
} from "./developer-tasks/task-people.js";
export { loadOwnedTask, systemTaskDispatchAccessFence } from "./developer-tasks/access.js";
export {
  type AutomaticFeedbackRound,
  FEEDBACK_CHANGED_SINCE_CARD,
  feedbackFixPrompt,
  getWorkflowFeedbackReview,
  planAutomaticFeedbackRound,
  submitWorkflowFeedbackDecision,
} from "./developer-tasks/feedback-review.js";
export { candidateChangedFiles, monthSlots, taskView } from "./developer-tasks/task-view.js";
export { ADMISSION_REFUSALS, startAlreadyMade, startTask } from "./developer-tasks/start.js";
export { ownerIndexRowOf, syncIndex } from "./developer-tasks/task-index.js";
export { RESUMED_WITH_ORIGINAL_INSTRUCTIONS } from "./developer-tasks/task-window.js";
export { type SpendResumeInput, continueAsTask, prepareTaskApprovalAdmission, resumeTaskAfterSpendApproval } from "./developer-tasks/continue.js";
export { decideTaskWorkflow } from "./developer-tasks/decide.js";
export { startTaskWorkflowPlanRevisionFromSystem } from "./developer-tasks/workflow-retry.js";
export { planUnreadablePrompt, publicWorkflowDecision } from "./developer-tasks/workflow-inputs.js";
export { SLACK_SEND_BACK_INSTRUCTIONS, resolveTaskWorkflowFindings, resumeAfterRunLimitApproval, sendTaskWorkflowBackToCoding } from "./developer-tasks/workflow-coding.js";
export { laterProgramBuild, startTaskWorkflowImplementationFromSystem, startTaskWorkflowReviewFromSystem, understandWatchdogDueAt } from "./developer-tasks/workflow-review.js";
export {
  type AutomaticRetry,
  autoRetryChecksFromSystem,
  autoRetryReviewsFromSystem,
  autoSendBackToCodingFromSystem,
  automaticCaller,
  startTaskWorkflowCriticRevisionFromSystem,
  startTaskWorkflowE2EBaselineFromSystem,
  startTaskWorkflowE2EChecksFromSystem,
  startTaskWorkflowE2EGroundingFromSystem,
  startTaskWorkflowE2EReplayFromSystem,
  startTaskWorkflowPlanCritiqueFromSystem,
  startTaskWorkflowPlanFromSystem,
  startTaskWorkflowUnderstandFromSystem,
} from "./developer-tasks/workflow-starts.js";
export {
  type PageSuggestionListing,
  createPageComment,
  decideOnPage,
  deletePageComment,
  editPageComment,
  getTaskDocumentView,
  getTaskFreshness,
  getTaskPageState,
  listPageComments,
  retryApplicationRoundOnPage,
  setPageSuggestion,
  taskPageStage,
  taskPageStep,
} from "./developer-tasks/task-page.js";
export { reviseTaskWorkflowPlan } from "./developer-tasks/workflow-revise.js";
export {
  type WorkflowPublicationAuthority,
  approvedPlanForPullRequest,
  proofContextOfTask,
  workflowPullRequestBody,
  workflowPullRequestStatusLines,
} from "./developer-tasks/pull-request-body.js";
export { currentWorkflowPublicationAuthorityForTask, currentWorkflowPublicationModeForTask, startTaskWorkflowBranchSyncFromSystem, startTaskWorkflowPublicationFromSystem } from "./developer-tasks/publication.js";
export {
  FEEDBACK_REVIEW_RETRY_BUSY,
  FEEDBACK_REVIEW_RETRY_CHANGED,
  captureWorkflowFeedbackNote,
  retryTaskWorkflowFeedbackReview,
  startTaskWorkflowFeedbackReviewFromWebhook,
} from "./developer-tasks/feedback-capture.js";
export {
  type SessionNoteInput,
  type SessionNoteRefusal,
  agentStepNotes,
  markWorkflowThreadNoteAnswered,
  planWhyEntries,
  promptTagId,
  readWorkflowThreadNotes,
  recordSessionNote,
  recordWorkflowThreadNote,
  sendBackProblemsPromptSection,
  sessionNoteItems,
  threadNotesPromptSection,
} from "./developer-tasks/thread-notes.js";
export { taskCommentSection, taskOwnsThread, workflowTaskAnswerContext } from "./developer-tasks/task-answer-context.js";
export { type TaskActor, cancelTask, cancelTaskFor, retryTaskWorkflowFor } from "./developer-tasks/cancel.js";
export {
  type EndTold,
  closeTask,
  finishTaskClose,
  noteTaskEnded,
  noteTaskPaused,
  resumeClose,
  workflowEndOutcome,
  workflowTaskFinished,
} from "./developer-tasks/close.js";
export {
  FINISHED_RELEASE_PK,
  type FinishedTaskRelease,
  type ReleaseDeps,
  enqueueFinishedTaskRelease,
  finishedReleaseMarkItem,
  recordFinishedRunCost,
  releaseFinishedTask,
  releaseFinishedTaskQuietly,
  releaseFinishedTasksOf,
  releasePendingFinishedTasks,
} from "./developer-tasks/release.js";
export { type ShareAdmin, type ShareModeDependencies, adminShareMode } from "./developer-tasks/share.js";

/**
 * An AI tool's decision on the pending PR feedback proposal: the same owner-only transition, GitHub refresh and fences as
 * the Slack buttons and the feedback page, then the task as it now stands.
 */
async function decideTaskWorkflowFeedback(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, input: unknown): Promise<{ task: DeveloperTaskView }> {
  const parsed = WorkflowFeedbackFindingsDecisionRequestSchema.safeParse(input);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", parsed.error.issues[0]?.message ?? "the PR feedback decision is invalid");
  await submitWorkflowFeedbackDecision(deps, caller, taskId, parsed.data);
  return readTask(deps, caller, taskId, new URL(`/v1/dev/tasks/${encodeURIComponent(taskId)}`, "https://agentx.invalid"));
}

/** An AI tool's Retry review of a PR feedback review that could not finish: the same transition as the Slack button. */
async function retryTaskWorkflowFeedback(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, input: unknown): Promise<{ task: DeveloperTaskView; started: boolean }> {
  const parsed = WorkflowFeedbackReviewRetryRequestSchema.safeParse(input);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "name the review to retry by its review digest");
  const retried = await retryTaskWorkflowFeedbackReview(deps, caller, taskId, parsed.data);
  const read = await readTask(deps, caller, taskId, new URL(`/v1/dev/tasks/${encodeURIComponent(taskId)}`, "https://agentx.invalid"));
  return { ...read, started: retried.started };
}

/** Every developer task route answers 200 with its body; errors are AgentXErrors. */
const bearerOf = (header: string | undefined): string | undefined => /^Bearer (.+)$/iu.exec(header ?? "")?.[1];

export async function routeDeveloperTaskRequest(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  if (request.method === "POST" && url.pathname === "/v1/dev/tasks") return startTask(deps, caller, body(request));
  if (request.method === "GET" && url.pathname === "/v1/dev/tasks") return listTasks(deps, caller, url);
  // S3 item 7: a Cloud workflow action on a task the core runs is refused (decide, close and cancel answer for themselves, in their own functions); a People change and sharing stay Cloud's.
  const core = coreTaskRoutes();
  const taskPost = core === undefined || request.method !== "POST" ? null : /^\/v1\/dev\/tasks\/([^/]+)\/(.+)$/.exec(url.pathname);
  if (core !== undefined && taskPost !== null && taskPost[2] !== "cancel" && !CORE_TASK_ANSWERED_ACTIONS.has(taskPost[2]!) && !CORE_TASK_CLOUD_ACTIONS.has(taskPost[2]!) && await core.owns(caller, safeDecode(taskPost[1]!))) {
    throw agentXError("CONFIG_INVALID", coreActionWords(taskPost[2]!));
  }
  const publicationContextRoute = /^\/v1\/dev\/tasks\/([^/]+)\/e2e-publication-context$/.exec(url.pathname);
  if (publicationContextRoute !== null && request.method === "POST") {
    return e2ePublicationContext(deps, caller, safeDecode(publicationContextRoute[1]!), body(request));
  }
  const proposalRoute = /^\/v1\/dev\/tasks\/([^/]+)\/people\/requests\/([^/]+)$/.exec(url.pathname);
  if (proposalRoute !== null && request.method === "GET") {
    const taskId = safeDecode(proposalRoute[1]!);
    const requestId = safeDecode(proposalRoute[2]!);
    return { change: await getTaskPeopleProposal(deps, caller, taskId, requestId) };
  }
  const route = /^\/v1\/dev\/tasks\/([^/]+)(?:\/(events|continue|cancel|close|pull-requests|share|people|people\/role|people\/take-ownership|workflow\/decision|workflow\/retry|workflow\/review|workflow\/publish-retry|workflow\/keep-pull-requests|workflow\/send-back|workflow\/revise-plan|workflow\/review-findings|workflow\/feedback|workflow\/feedback-decision|workflow\/feedback-retry|canvas-closeout\/retry|plan))?$/.exec(url.pathname);
  const taskId = route?.[1] === undefined ? undefined : safeDecode(route[1]);
  if (taskId !== undefined && request.method === "GET" && route?.[2] === undefined) return readTask(deps, caller, taskId, url);
  if (taskId !== undefined && request.method === "GET" && route?.[2] === "events") return taskEvents(deps, caller, taskId, url);
  if (taskId !== undefined && request.method === "GET" && route?.[2] === "plan") return getTaskPlan(deps, caller, taskId, url);
  if (taskId !== undefined && request.method === "GET" && route?.[2] === "people") return { view: await getTaskPeople(deps, caller, taskId) };
  if (taskId !== undefined && request.method === "POST" && route?.[2] === "people/role") {
    const input = parse(TaskPeopleRoleRequestSchema, body(request), deps, "people/role");
    return { change: await proposeTaskPeopleRole(taskPeopleEffectsDependencies(deps), caller, taskId, input) };
  }
  if (taskId !== undefined && request.method === "POST" && route?.[2] === "people/take-ownership") {
    const input = parse(TaskPeopleTakeOwnershipRequestSchema, body(request), deps, "people/take-ownership");
    const code = await codeOwnershipConfirmation(deps, caller, taskId, input);
    if (code !== undefined) return new StatusReply(code.reply.status, code.reply.body);
    return { change: await proposeTaskOwnership(taskPeopleEffectsDependencies(deps), caller, taskId, input) };
  }
  if (taskId !== undefined && request.method === "POST" && route?.[2] === "continue") return continueTask(deps, caller, taskId, body(request));
  if (taskId !== undefined && request.method === "POST" && route?.[2] === "workflow/decision") return decideTaskWorkflow(core === undefined ? deps : { ...deps, coreBearer: bearerOf(request.headers.authorization) }, caller, taskId, body(request));
  if (taskId !== undefined && request.method === "POST" && route?.[2] === "workflow/retry") return retryTaskWorkflow(deps, caller, taskId, body(request));
  if (taskId !== undefined && request.method === "POST" && route?.[2] === "canvas-closeout/retry") return retryTaskCanvasCloseout(deps, caller, taskId, body(request));
  if (taskId !== undefined && request.method === "POST" && route?.[2] === "workflow/review") return startTaskWorkflowReview(deps, caller, taskId, body(request));
  if (taskId !== undefined && request.method === "POST" && route?.[2] === "workflow/publish-retry") return retryTaskWorkflowPublication(deps, caller, taskId, body(request));
  if (taskId !== undefined && request.method === "POST" && route?.[2] === "workflow/keep-pull-requests") return keepTaskWorkflowPullRequests(deps, caller, taskId, body(request));
  if (taskId !== undefined && request.method === "POST" && route?.[2] === "workflow/send-back") return sendTaskWorkflowBackToCoding(deps, caller, taskId, body(request));
  if (taskId !== undefined && request.method === "POST" && route?.[2] === "workflow/revise-plan") return reviseTaskWorkflowPlan(deps, caller, taskId, body(request));
  if (taskId !== undefined && request.method === "POST" && route?.[2] === "workflow/review-findings") return resolveTaskWorkflowFindings(deps, caller, taskId, body(request));
  if (taskId !== undefined && request.method === "GET" && route?.[2] === "workflow/feedback") return { review: await getWorkflowFeedbackReview(deps, caller, taskId) };
  if (taskId !== undefined && request.method === "POST" && route?.[2] === "workflow/feedback-decision") return decideTaskWorkflowFeedback(deps, caller, taskId, body(request));
  if (taskId !== undefined && request.method === "POST" && route?.[2] === "workflow/feedback-retry") return retryTaskWorkflowFeedback(deps, caller, taskId, body(request));
  if (taskId !== undefined && request.method === "POST" && route?.[2] === "cancel") return cancelTask(deps, caller, taskId, body(request));
  if (taskId !== undefined && request.method === "POST" && route?.[2] === "close") return closeTask(deps, caller, taskId, body(request));
  if (taskId !== undefined && request.method === "POST" && route?.[2] === "pull-requests") return openPullRequest(deps, caller, taskId, body(request));
  if (taskId !== undefined && request.method === "POST" && route?.[2] === "share") return shareTask(deps, caller, taskId, body(request));
  throw agentXError("NOT_FOUND", "route not found");
}
