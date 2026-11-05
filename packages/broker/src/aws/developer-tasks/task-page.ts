import { WORKFLOW_BREAKDOWN_REFUSALS } from "../../developer/workflow-actions.js";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  workflowPullRequestUpdateDue,
  agentXError,
  redactText,
  sharedTaskKey,
  type Operation,
  type WorkflowSnapshot,
  type TaskComment,
  type TaskSuggestion,
  commentIdInAuthor,
  plannerReplyCommentId,
  commentRefInAuthor,
  workflowSelectedChecks,
  type WorkflowReviewFinding,
  WORKFLOW_PLAN_MAX_BYTES,
  WORKFLOW_BLOCK_REASONS,
  isNoCodeChangedReason,
  noChangeFindingsFrom,
  noChangeHasThread,
  NO_CHANGE_CHOICES_NO_THREAD,
  NO_CHANGE_CHOICES_PAGE,
  WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX,
  WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX,
  WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX,
  workflowApplicationRetryOffered,
  workflowReviseOffered,
  canonicalJson,
  type PlanClaim,
  type PlanDocument,
  workflowKeepPullRequestsOffered,
  type E2EScenarioResults,
  blockingFindings,
  workflowReviewRoles,
  isRunLimitBlockReason,
  isCiFixBlockReason,
  isBranchConflictAskReason,
  isBranchSyncGiveUpReason,
  isBranchSyncBlockReason,
} from "@agentx/contracts";
import { isE2EPlanCorrectionBlockReason, ownerNameOfActor, taskKey, taskOwnerKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { planEvidencePointerKey, type PlanEvidencePointer } from "../../developer/plan-evidence-jobs.js";
import { loadPlanEvidence, loadWorkflowDocument } from "../../developer/plan-artifacts.js";
import type { DeveloperCaller } from "../developer-routes.js";
import { isFeedbackReviewFailure, workflowDocumentName } from "../../developer/workflow-messages.js";
import type { TaskDocumentKind, TaskDocumentView, TaskFreshness } from "../task-web.js";
import type { PageCommentInput, PageDecisionInput, PageRetryInput, PageSuggestionInput, TaskPageState } from "../task-web-api.js";
import { pageCommentViews, type CommentViewContext, type PageCommentView } from "../plan-page/comments.js";
import { loadPlanSelfCheck } from "../../developer/plan-self-check.js";
import type { PlanAnchor } from "../plan-page/render-plan.js";
import { can, pageAccess, projectWorkAllowed, requireProjectWorkRole, resolveTaskAccess, type TaskAccess } from "../../developer/task-access.js";
import { designReviewEnabled } from "../../design-review/switch.js";
import { getTaskPeoplePresentation } from "../../developer/task-people.js";
import { getTaskPeopleCapabilities as readTaskPeopleCapabilities } from "../../developer/task-people.js";
import { isRuntimeRenewedBlock } from "../../e2e/requalify-hold.js";
import { AutoFixAskSchema, autoFixCardLines, fixSetupWording } from "../../developer/autofix-messages.js";
import {
  commentCounterKey,
  createTaskComment,
  deleteTaskComment,
  editTaskComment,
  listSuggestions,
  listTaskComments,
  currentStepDocument,
  queueCommentAnswer,
  setSuggestion,
  suggestionsFor,
  type PageActor,
} from "../../developer/page-comments.js";
import { readDecisionDetail } from "../../developer/owner-answers.js";
import type { MergeView } from "@agentx/contracts";
import { readMergeTracking } from "../../rovara-code/merge-tracking.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";
import { OWNER_LABEL, TASK_PAGE_DOCUMENTS, get, log, ownerLabel, removedReasonOf } from "./common.js";
import { taskView, workspaceReads } from "./task-view.js";
import { DESIGN_CARD_ONLY_MESSAGE, decideTaskWorkflow } from "./decide.js";
import { retryTaskWorkflow } from "./workflow-retry.js";
import { specHoldOf } from "./spec-wiring.js";
import { commentLearningFlags } from "../../learning/comment-flags.js";

/**
 * Whether Merge may be pressed now, for the words a page or message uses about a Rovara Code (version 2) task that waits for its merge; undefined for any other task, for one with nothing
 * tracked yet, and when it cannot be read (the words then stay as they were). Advisory, like the task view's `merge`: the press reads GitHub again.
 */
async function mergeViewForWords(deps: Pick<DeveloperTaskRouteDependencies, "documentClient" | "tableName" | "mergeView">, task: DeveloperTaskRecord): Promise<MergeView | undefined> {
  const workflow = task.workflow;
  if (deps.mergeView === undefined || task.orgId === undefined || task.closedAt !== undefined || workflow?.stage !== "WAIT_FOR_MERGE" || workflow.definitionVersion !== "1.1.0") return undefined;
  try {
    const items = await readMergeTracking(deps, task.taskId, task.orgId);
    return items.length === 0 ? undefined : await deps.mergeView(task, items);
  } catch {
    return undefined;
  }
}

/** Where a workflow task stands and what happens next, in the words the task page shows. */
export function taskPageStage(
  workflow: WorkflowSnapshot | undefined, closed: boolean, owner: boolean, publication: "failed" | "retrying" | undefined = undefined, removedReason: string | undefined = undefined,
  /** Rovara Code version 2 (staging 0.4.11, Bug G): whether Merge may be pressed now, from merge tracking; absent for a task that is not tracked, which merges on GitHub. */
  merge: MergeView | undefined = undefined,
  /** Whether the task has a Slack thread to reply in; a task without one is told to start a new request for a change. */
  hasThread = true,
): { status: string; nextStep: string } {
  // A custom sequence with no pull request step ran every step; its changes wait, unpublished, until the owner closes the task.
  if (!closed && workflow?.stage === "CLOSED" && workflow.state === "COMPLETE" && workflow.outcome === "PASSED") {
    return { status: "Finished every step", nextStep: "The changes are kept in this task's workspace until you close the task." };
  }
  // A question that needed no code change: the answer was given, and nothing else is coming.
  if (workflow?.outcome === "ANSWERED") return { status: "Answered", nextStep: "Nothing; no code change was needed." };
  if (closed || workflow?.stage === "CLOSED") return { status: "Closed", nextStep: "Nothing; this task is closed." };
  // Ruling R60: the creator was removed from the org, so the task ended; no step is waiting.
  if (removedReason !== undefined && workflow?.stage !== "MERGED") return { status: removedReason, nextStep: "Nothing; this task has ended." };
  if (workflow === undefined) return { status: "In progress", nextStep: "Follow the task where it was started." };
  // S2: a queued step waits for Slack to answer the access check (an outage); the dispatcher sets the note and tries again, and stops it after 30 minutes with a Retry.
  if (workflow.accessCheckWaitSince?.revision === workflow.revision && (workflow.state === "READY" || workflow.state === "WAITING")) {
    return { status: "Waiting for Slack", nextStep: "Rovara could not reach Slack to check who may start work, and tries again by itself. After 30 minutes it stops and offers Retry." };
  }
  const name = workflowDocumentName(workflow);
  // A task started on the web has no Slack thread: its choices are made in Rovara (QA6-03: the page told a web-started task to go to Slack).
  const inSlack = hasThread ? "in the task's Slack thread" : "in Rovara";
  // After approved PR feedback the pull requests are already open: the fix is pushed to them.
  if (workflow.stage === "PULL_REQUEST" && (workflow.state === "READY" || workflow.state === "RUNNING") && workflowPullRequestUpdateDue(workflow)) {
    return { status: "Pushing the fix to the pull request", nextStep: "Review and merge it on GitHub once the fix is pushed." };
  }
  switch (`${workflow.stage}/${workflow.state}`) {
    case "PLAN/READY": case "PLAN/RUNNING": return { status: `Writing the ${name}`, nextStep: `It will be posted ${inSlack} for approval; no code changes until it's approved.` };
    case "PLAN/BLOCKED": return { status: `Stopped while writing the ${name}`, nextStep: `Retry planning or close the task ${inSlack}.` };
    // A teammate reading the page is not the one who approves.
    case "PLAN_REVIEW/WAITING":
      if (isE2EPlanCorrectionBlockReason(workflow.blockReason)) return owner
        ? { status: "The E2E plan needs correction", nextStep: `Request changes to submit a corrected E2E plan, or close the task ${inSlack}.` }
        : { status: "The E2E plan needs correction", nextStep: `The task owner must request changes and submit a corrected E2E plan, or close the task ${inSlack}.` };
      return owner
        ? { status: "Waiting for your approval", nextStep: `Approve or request changes ${inSlack}.` }
        : { status: "Waiting for the owner's approval", nextStep: `The task owner approves or requests changes ${inSlack}.` };
    case "PLAN_REVIEW/BLOCKED": return { status: `Stopped before approval of the ${name}`, nextStep: `Close the task ${inSlack} and start again.` };
    case "IMPLEMENT/READY": case "IMPLEMENT/RUNNING": return { status: "Writing the code", nextStep: "The checks and reviews run when coding finishes." };
    case "IMPLEMENT/BLOCKED": if (isRunLimitBlockReason(workflow.blockReason)) {
      return { status: "Waiting for the run limit to be approved", nextStep: owner ? `Coding starts once a project maintainer or an admin approves it, or close the task ${inSlack}.` : "Coding starts once a project maintainer or an admin approves the run limit." };
    }
      return workflow.blockReason === WORKFLOW_BLOCK_REASONS.fixChangedNothing
      ? { status: "The approved fix didn't change any code", nextStep: workflowKeepPullRequestsOffered(workflow)
        ? `Retry coding, keep the pull request as it is, or close the task ${inSlack}.` : `Retry coding or close the task ${inSlack}.` }
      : workflow.blockReason === WORKFLOW_BLOCK_REASONS.liveSteerReapprovalRevise
        // Live steer: the owner's live message asked for a change outside the approved plan and the plan can take it in: Revise the plan (here or in Slack), or retry the approved plan without it.
        ? { status: "Coding stopped for a change outside the plan", nextStep: owner
          ? `Press Revise the plan here (or in the task's Slack thread) to plan again with that change; you approve the revised plan before coding continues. Or retry coding to build the approved plan without it, or close the task ${inSlack}.`
          : "The task owner decides: revise the plan with that change (the owner approves the revised plan before coding continues), retry coding to build the approved plan without it, or close the task." }
      : workflow.blockReason === WORKFLOW_BLOCK_REASONS.liveSteerReapprovalCoding
        // Live steer: the owner's live message asked for a change outside the approved plan, and the plan cannot take it in (a custom sequence, an open pull request or a fix round). The ways on: retry the approved plan without it, or a new task that asks for it.
        ? { status: "Coding stopped for a change outside the plan", nextStep: owner
          ? `Retry coding to build the approved plan without that change, or close the task ${inSlack} and start a new task that asks for it.`
          : "The task owner decides: retry coding to build the approved plan without that change, or close the task and start a new task that asks for it." }
      : isNoCodeChangedReason(workflow.blockReason)
        // No change was needed: what the agent found is on the page and in the thread; nothing was checked or opened as a pull request.
        ? { status: "No code changes were needed", nextStep: hasThread ? NO_CHANGE_CHOICES_PAGE : NO_CHANGE_CHOICES_NO_THREAD }
        : { status: "Coding stopped before it finished", nextStep: `Retry coding or close the task ${inSlack}.` };
    case "VERIFY/WAITING": return workflow.e2e?.required === true && workflow.e2e.currentRoundId === undefined
      ? { status: "Preparing the checks", nextStep: "The checks start when workspace compute is ready." }
      : { status: "Preparing the checks", nextStep: "The approved checks start shortly." };
    case "VERIFY/READY": case "VERIFY/RUNNING": return { status: "Running the checks", nextStep: "The code and security reviews start when the checks pass." };
    case "VERIFY/BLOCKED": {
      // A block of a browser and API round names its own way on: new code does not fix a runtime that needs qualifying or a selection that needs approving again.
      if (workflow.blockReason?.startsWith(WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX) === true) {
        return { status: "The browser and API checks can't run on the runtime as it is now", nextStep: `An administrator must qualify the runtime again; then retry the checks, or close the task ${inSlack}.` };
      }
      if (isRuntimeRenewedBlock(workflow.blockReason)) {
        return { status: "The test machine was renewed; the approved browser and API checks need approving again", nextStep: `Retry the checks to approve the plan again against the renewed machine, or close the task ${inSlack}.` };
      }
      if (workflow.blockReason?.startsWith(WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX) === true) {
        return { status: "The approved browser and API checks no longer match the test accounts", nextStep: `The test accounts changed; approve the checks again by retrying them, or close the task ${inSlack}.` };
      }
      if (workflow.blockReason?.startsWith(WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX) === true) {
        return { status: "The approved browser and API checks no longer match the runtime", nextStep: `Retry the checks to approve the plan again against what is ready now, or close the task ${inSlack}.` };
      }
      return { status: "The checks didn't pass or couldn't run", nextStep: `Send it back to coding, retry the checks, or close the task ${inSlack}.` };
    }
    case "REVIEW/READY": case "REVIEW/WAITING": case "REVIEW/RUNNING": return workflow.program === undefined
      ? { status: "Code and security reviews are running", nextStep: "A draft pull request opens when both pass." }
      // A custom sequence's review step may ask for one review, and what follows it is the sequence's next step.
      : { status: workflowReviewRoles(workflow).length === 2 ? "Code and security reviews are running" : workflowReviewRoles(workflow)[0] === "SECURITY" ? "The security review is running" : "The code review is running",
        nextStep: "The next step of the sequence starts when the review passes." };
    case "REVIEW/BLOCKED": return { status: "The reviews found problems or couldn't finish", nextStep: `Send it back to coding, retry the reviews, or close the task ${inSlack}.` };
    // The last try to open it failed: said until the next try's result, so the page never says "opening" over a failure.
    case "PULL_REQUEST/READY": return publication === "failed"
      ? { status: "The draft pull request didn't open", nextStep: `Retry opening the pull request or close the task ${inSlack}.` }
      : publication === "retrying"
        ? { status: "Trying again to open the draft pull request; the last try didn't open it", nextStep: "Review and merge it on GitHub once it's open." }
        : { status: "Opening a draft pull request", nextStep: "Review and merge it on GitHub once it's open." };
    case "PULL_REQUEST/BLOCKED": return { status: "The draft pull request didn't open", nextStep: `Retry opening the pull request or close the task ${inSlack}.` };
    case "WAIT_FOR_MERGE/WAITING":
      if (merge?.ready === true) return { status: "Waiting for the pull request to be merged", nextStep: "Press Merge in Rovara; the task finishes when it's merged." };
      if (merge !== undefined) return { status: "Waiting for the pull request to be merged", nextStep: `${merge.message ?? "It is not ready to merge yet."} Then press Merge in Rovara; the task finishes when it's merged.` };
      return { status: "Waiting for the pull request to be merged", nextStep: "Review and merge it on GitHub; the task finishes when it's merged." };
    // Only a changed pull request stops the following; after a failed feedback review or push, the merge is still tracked.
    case "WAIT_FOR_MERGE/BLOCKED":
      if (workflow.blockReason === WORKFLOW_BLOCK_REASONS.pullRequestChanged) return { status: "Stopped following the pull request", nextStep: `Close the task ${inSlack}.` };
      // The pull request changed on GitHub while the fix was pushed: its merge is no longer followed.
      if (workflow.blockReason === WORKFLOW_BLOCK_REASONS.pullRequestUpdateFailed && workflow.pullRequestUpdateFailure?.cause === "HEAD_MOVED") {
        return { status: "Stopped following the pull request", nextStep: `Merge or close it on GitHub, then close the task ${inSlack}.` };
      }
      if (workflow.blockReason === WORKFLOW_BLOCK_REASONS.pullRequestUpdateFailed) return { status: "Couldn't push the fix", nextStep: `Merge or update it on GitHub, or close the task ${inSlack}.` };
      if (isCiFixBlockReason(workflow.blockReason)) return { status: "CI is failing and needs you", nextStep: "Retry the fix, take over on GitHub, or close the task." };
      if (isBranchSyncGiveUpReason(workflow.blockReason)) return { status: "The branch couldn't be updated", nextStep: "Retry once more, update the branch on GitHub, or close the task." };
      if (isBranchConflictAskReason(workflow.blockReason)) return { status: "The branch conflicts and needs you", nextStep: "Retry to let Rovara resolve it, update the branch on GitHub, or close the task." };
      if (isBranchSyncBlockReason(workflow.blockReason)) return { status: "The branch needs updating on GitHub", nextStep: "Update the branch on GitHub, or close the task." };
      return { status: isFeedbackReviewFailure(workflow.blockReason) ? "Couldn't review the pull request feedback" : "Something went wrong; still watching the pull request",
        nextStep: "Merge it on GitHub and the task finishes, or close the task in Slack." };
    case "MERGED/COMPLETE": return { status: "Merged", nextStep: "Nothing; this task is complete." };
    default: return { status: "In progress", nextStep: `Follow the task ${inSlack}.` };
  }
}

/**
 * Item 4 (final review): while the task is ready to publish, how its draft pull request's tries stand: "failed" when the
 * latest try ended without opening it, "retrying" when a later try runs after one that failed, else undefined.
 */
export async function publicationAttempts(deps: Pick<DeveloperTaskRouteDependencies, "actions">, task: DeveloperTaskRecord): Promise<"failed" | "retrying" | undefined> {
  if (task.workflow?.stage !== "PULL_REQUEST" || task.workflow.state !== "READY") return undefined;
  const publications = (await deps.actions.operations(task.workspaceId)).filter((operation) => operation.kind === "publish")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const ended = (operation: Operation) => ["FAILED", "INTERRUPTED", "CANCELLED"].includes(operation.status);
  const latest = publications.at(-1);
  if (latest === undefined) return undefined;
  if (ended(latest)) return "failed";
  return latest.status !== "SUCCEEDED" && publications.slice(0, -1).some(ended) ? "retrying" : undefined;
}

const HISTORY_REASON_MAX_CHARS = 200;

/** The progress strip's current step, spelled as the page spells it; `Complete` once merged (every step done); empty when no step is current. */
export function taskPageStep(workflow: WorkflowSnapshot | undefined, closed: boolean): string {
  if (workflow?.stage === "MERGED") return "Complete";
  if (workflow?.outcome === "ANSWERED") return "Answered";
  if (closed || workflow === undefined) return "";
  switch (workflow.stage) {
    // Understand has no step of its own on the page's strip: it reads as the plan's, as older clients read the stage (the document is the Requirements on the Full path). The plan check is the plan's too.
    case "UNDERSTAND": case "PLAN": case "PLAN_CRITIQUE": case "PLAN_REVIEW": {
      const name = workflowDocumentName(workflow);
      return name === "coding plan" ? "Coding plan" : name === "design" ? "Design" : "Requirements";
    }
    case "IMPLEMENT": return "Coding";
    case "VERIFY": return "Checks";
    case "REVIEW": return "Reviews";
    case "PULL_REQUEST": case "WAIT_FOR_MERGE": return "Pull request";
    default: return "";
  }
}

/** " · 1 answer changed · 2 comments included" for a decision that changed answers or sent comments; "" otherwise (SC-003). */
function decisionExtras(decision: WorkflowSnapshot["decisions"][number]): string {
  const changed = decision.answerOverrides?.length ?? 0;
  const comments = decision.commentsIncluded ?? 0;
  return `${changed === 0 ? "" : ` · ${changed} ${changed === 1 ? "answer" : "answers"} changed`}${comments === 0 ? "" : ` · ${comments} ${comments === 1 ? "comment" : "comments"} included`}`;
}

const cutReason = (reason: string): string => {
  const characters = Array.from(redactText(reason).replace(/\s+/gu, " ").trim());
  return characters.length <= HISTORY_REASON_MAX_CHARS ? characters.join("") : `${characters.slice(0, HISTORY_REASON_MAX_CHARS - 1).join("")}…`;
};

/** The page's poll (spec 061 slice 2): where the task stands, with no names and no text; the full access check runs each time. */
export async function getTaskPageState(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string): Promise<TaskPageState> {
  const { access, capabilities } = await coherentPageAccess(deps, caller, taskId);
  const { task } = access;
  const taskViewRecord = task.workflow?.e2e?.required === true
    ? await taskView(deps, task, { events: 0, details: true, actor: "viewer" })
    : undefined;
  const workflow = task.workflow;
  const documents = TASK_PAGE_DOCUMENTS.flatMap(({ type, anchor }) => {
    const latest = (workflow?.artifacts ?? []).filter((artifact) => artifact.type === type).reduce((most, artifact) => Math.max(most, artifact.version), 0);
    return latest === 0 ? [] : [{ anchor: anchor as PlanAnchor, version: latest }];
  });
  const counter = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: commentCounterKey(taskId), ConsistentRead: true })) as { Item?: { seq?: unknown } };
  const permissions = pageAccess(access, await projectWorkAllowed(deps, task, caller));
  // v1.2 learning loop: only for a person with standing in the project; absent for everyone else, and when it can't be worked out in time.
  const flags = await commentLearningFlags(deps, { caller, access }, taskId, []);
  return {
    revision: workflow?.revision ?? 0, waiting: workflow?.stage === "PLAN_REVIEW" && workflow.state === "WAITING" && task.closedAt === undefined,
    stage: taskPageStep(workflow, task.closedAt !== undefined), documents, commentSeq: typeof counter.Item?.seq === "number" ? counter.Item.seq : 0,
    ...(capabilities.peopleRevision === undefined ? {} : { peopleRevision: capabilities.peopleRevision }), canRead: true,
    canComment: permissions.canComment, canSuggest: permissions.canSuggest, canDecide: permissions.canDecide,
    canAsk: permissions.canAsk && await commentAnswersAvailable(deps, task),
    canManagePeople: capabilities.canManagePeople, canTakeOwnership: capabilities.canTakeOwnership,
    ...(flags === undefined ? {} : { canRemember: flags.canRemember }),
    ...(taskViewRecord?.e2ePresentation === undefined ? {} : { e2ePresentation: taskViewRecord.e2ePresentation }),
  };
}

/** A signed-in reader acting on the task page: their access, checked again for every request. */
async function pageActor(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string): Promise<PageActor> {
  return { ...await resolveTaskAccess(deps, caller, taskId), caller };
}

const commentViewContext = (deps: DeveloperTaskRouteDependencies, actor: PageActor) =>
  ({ readerId: actor.caller.developerId, now: deps.now(), artifacts: actor.task.workflow?.artifacts ?? [] });

/**
 * The task's comments as the page's script reads them, and the suggestions that still apply to each document's current
 * version (names and "you" only), so an open page can refresh both. Suggestions that cannot be worked out are left out
 * (logged); comments still answer.
 */
export async function listPageComments(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string): Promise<{ comments: PageCommentView[]; suggestions: PageSuggestionListing[]; canRemember?: boolean }> {
  const actor = await pageActor(deps, caller, taskId);
  const stored = await listTaskComments(deps, taskId);
  const views = pageCommentViews(stored, { ...commentViewContext(deps, actor), ...await replyLookups(deps, actor.task, stored) });
  // v1.2 learning loop: which comments are remembered, for a person with standing only. A read that fails leaves `learning` off and the page is served.
  const flags = await commentLearningFlags(deps, { caller, access: actor }, taskId, stored.filter((comment) => comment.author.kind === "person").map((comment) => comment.commentId));
  const comments = flags?.learning === undefined ? views : views.map((view) => {
    const learning = flags.learning!.get(view.id);
    return learning === undefined ? view : { ...view, learning };
  });
  let suggestions: PageSuggestionListing[] = [];
  try {
    suggestions = (await currentSuggestions(deps, actor.task)).map((suggestion) => ({
      document: suggestion.document, decisionId: suggestion.decisionId, optionId: suggestion.optionId, name: suggestion.name, you: suggestion.developerId === caller.developerId,
    }));
  } catch (error) {
    log(deps, { event: "developer.task_page_suggestions_unavailable", taskId, errorName: error instanceof Error ? error.name : "unknown" });
  }
  return { comments, suggestions, ...(flags === undefined ? {} : { canRemember: flags.canRemember }) };
}

/** What is worked out from one stored document for a planner's reply: which claim cites each comment, and its claim IDs. */
interface ReplyLookup { citations: Map<string, string>; claimIds: Set<string> }
/** By task and the document's digest: a stored document never changes, so what is read from it is kept for the next poll. */
const replyLookupCache = new Map<string, ReplyLookup>();
const REPLY_LOOKUP_CACHE_MAX = 200;

/**
 * What a planner's reply needs to link a claim, for the documents the task's replies point at (the ones that handled a
 * comment sent with a decision), and only those: which claim of each cites each comment, and its claim IDs. Read from the
 * task's own storage in parallel, once per digest; a task with no planner reply reads nothing. A document that cannot be
 * read leaves its replies without links.
 */
async function replyLookups(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, comments: readonly TaskComment[]): Promise<Pick<CommentViewContext, "citations" | "claimIds">> {
  const replies = comments.filter((comment) => comment.author.kind === "agentx" && comment.author.source === "planner");
  const workflow = task.workflow;
  if (replies.length === 0 || workflow === undefined) return {};
  const privatePrefix = `private/${task.ownerKey}/${task.workspaceId}/`;
  const shown = workflow.artifacts.filter((item) => TASK_PAGE_DOCUMENTS.some((entry) => entry.type === item.type) && item.objectKey.startsWith(privatePrefix));
  // The documents a reply was written for: the one whose ID made the reply's ID, else the one it names by version.
  const replyIds = new Set(replies.map((reply) => reply.commentId));
  const needed = new Map<string, (typeof shown)[number]>();
  for (const comment of comments) {
    if (comment.author.kind !== "person" || comment.lockedBy === undefined) continue;
    for (const artifact of shown) if (replyIds.has(plannerReplyCommentId(comment.commentId, artifact.id))) needed.set(artifact.id, artifact);
  }
  for (const reply of replies) {
    const forVersion = reply.author.kind === "agentx" ? reply.author.forVersion : undefined;
    const named = shown.find((artifact) => artifact.type === reply.document && artifact.version === (forVersion ?? reply.version));
    if (named !== undefined) needed.set(named.id, named);
  }
  const read = async (objectKey: string, maxBytes: number): Promise<string | undefined> => {
    try { return await deps.actions.readArtifact(objectKey, maxBytes); } catch { return undefined; }
  };
  const lookups = await Promise.all([...needed.values()].map(async (artifact): Promise<[string, ReplyLookup] | undefined> => {
    const key = `${task.taskId}:${artifact.sha256}`;
    const kept = replyLookupCache.get(key);
    if (kept !== undefined) return [artifact.id, kept];
    const loaded = await loadWorkflowDocument(read, artifact, {});
    if (loaded?.format !== "structured") return undefined;
    // A plan stored before quotes named comments by ID credits one by ref, as the served page reads it.
    const refs = await legacyQuoteCommentRefs(deps, task, workflow, artifact, loaded.plan).catch(() => undefined);
    const lookup = { citations: claimsCitingComments(loaded.plan, refs), claimIds: planClaimIds(loaded.plan) };
    if (replyLookupCache.size >= REPLY_LOOKUP_CACHE_MAX) replyLookupCache.delete(replyLookupCache.keys().next().value!);
    replyLookupCache.set(key, lookup);
    return [artifact.id, lookup];
  }));
  const found = lookups.flatMap((entry) => entry === undefined ? [] : [entry]);
  return { citations: new Map(found.map(([id, lookup]) => [id, lookup.citations])), claimIds: new Map(found.map(([id, lookup]) => [id, lookup.claimIds])) };
}

export interface PageSuggestionListing { document: "requirements" | "design" | "plan"; decisionId: string; optionId: string; name: string; you: boolean }

/**
 * The stored suggestions that still apply to each document's latest version. Only the versions they name are read (the
 * latest, and any earlier one a suggestion was made on), and only from the task's own storage.
 */
async function currentSuggestions(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord): Promise<TaskSuggestion[]> {
  const stored = await listSuggestions(deps, task.taskId);
  if (stored.length === 0) return [];
  const privatePrefix = `private/${task.ownerKey}/${task.workspaceId}/`;
  const read = (objectKey: string, maxBytes: number) => deps.actions.readArtifact(objectKey, maxBytes);
  const out: TaskSuggestion[] = [];
  for (const { type } of TASK_PAGE_DOCUMENTS) {
    const mine = stored.filter((suggestion) => suggestion.document === type);
    if (mine.length === 0) continue;
    const artifacts = (task.workflow?.artifacts ?? []).filter((artifact) => artifact.type === type && artifact.objectKey.startsWith(privatePrefix));
    const latest = artifacts.reduce<(typeof artifacts)[number] | undefined>((most, artifact) => most === undefined || artifact.version > most.version ? artifact : most, undefined);
    if (latest === undefined) continue;
    const plans = new Map<number, PlanDocument>();
    for (const version of new Set([latest.version, ...mine.map((suggestion) => suggestion.version)])) {
      const artifact = artifacts.find((item) => item.version === version);
      const loaded = artifact === undefined ? undefined : await loadWorkflowDocument(read, artifact, {});
      if (loaded?.format === "structured") plans.set(version, loaded.plan);
    }
    const plan = plans.get(latest.version);
    if (plan !== undefined) out.push(...suggestionsFor(mine, { document: type, version: latest.version, plan, plans }));
  }
  return out;
}

/**
 * Posts a comment or a reply from the page, and with `ask` queues it for AgentX to answer (queueCommentAnswer). A resent
 * post is the same comment and queues nothing again. A limited ask answers `askRefused: "limited"`; the comment stands.
 */
export async function createPageComment(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, input: PageCommentInput): Promise<{ comment: PageCommentView; duplicate: boolean; askRefused?: "limited" }> {
  const actor = await pageActor(deps, caller, taskId);
  // Asking AgentX is agent work: refused to a viewer (an owner lowered to viewer included) before the comment is posted.
  if (input.ask && can(actor.role, "ask")) await requireProjectWorkRole(deps, actor.task, caller);
  const { parentId, ...rest } = input;
  const created = await createTaskComment(deps, actor, { ...rest, ...(parentId === undefined ? {} : { parentId }) });
  let comment = created.comment;
  let askRefused: "limited" | undefined;
  if (input.ask && !created.duplicate && can(actor.role, "ask")) {
    const asked = await queueCommentAnswer(deps, { task: actor.task, comment, caller, access: actor });
    comment = asked.comment;
    if (asked.outcome === "limited") askRefused = "limited";
  }
  return { comment: pageCommentViews([comment], commentViewContext(deps, actor))[0]!, duplicate: created.duplicate, ...(askRefused === undefined ? {} : { askRefused }) };
}

export async function editPageComment(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, input: { commentId: string; rev: number; text: string }): Promise<{ comment: PageCommentView }> {
  const actor = await pageActor(deps, caller, taskId);
  return { comment: pageCommentViews([await editTaskComment(deps, actor, input)], commentViewContext(deps, actor))[0]! };
}

export async function deletePageComment(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, input: { commentId: string; rev: number }): Promise<{ comment: PageCommentView }> {
  const actor = await pageActor(deps, caller, taskId);
  return { comment: pageCommentViews([await deleteTaskComment(deps, actor, input)], commentViewContext(deps, actor))[0]! };
}

export async function setPageSuggestion(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, input: PageSuggestionInput): Promise<void> {
  await setSuggestion(deps, await pageActor(deps, caller, taskId), input);
}

/** What the page says for each refusal of a work breakdown approval (the core's own sentences are written for Slack and AI tools). Any other error passes through. */
const PAGE_BREAKDOWN_REFUSALS: ReadonlyMap<string, { pageReason: "changed" | "refused"; message: string }> = new Map([
  // A design under review is approved from its decision card, not from here (ON-1): the page says so in the refusal's own words.
  [DESIGN_CARD_ONLY_MESSAGE, { pageReason: "refused", message: DESIGN_CARD_ONLY_MESSAGE }],
  [WORKFLOW_BREAKDOWN_REFUSALS.digestMissing, { pageReason: "changed", message: "This coding plan has a work breakdown. Refresh the page, look it over, and approve again." }],
  [WORKFLOW_BREAKDOWN_REFUSALS.digestChanged, { pageReason: "changed", message: "The work breakdown changed since this page loaded. Refresh the page and look it over before approving." }],
  [WORKFLOW_BREAKDOWN_REFUSALS.noBreakdown, { pageReason: "changed", message: "This plan has no work breakdown now. Refresh the page and approve again." }],
  [WORKFLOW_BREAKDOWN_REFUSALS.notEnabled, { pageReason: "refused", message: "This plan has an ordered work breakdown, and this AgentX isn't set up to start those yet. Ask an AgentX admin." }],
  [WORKFLOW_BREAKDOWN_REFUSALS.onePinnedRepository, { pageReason: "refused", message: "An ordered work breakdown needs a task pinned to exactly one repository." }],
]);
function pageBreakdownRefusal(error: unknown): unknown {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  if (code !== "CONFIG_INVALID" || typeof message !== "string") return error;
  const said = PAGE_BREAKDOWN_REFUSALS.get(message.startsWith("CONFIG_INVALID: ") ? message.slice("CONFIG_INVALID: ".length) : message);
  return said === undefined ? error : Object.assign(agentXError("CONFIG_INVALID", said.message), { pageReason: said.pageReason });
}

/**
 * A decision from the page: only someone whose role may decide reaches the one transition, which Slack and MCP use too.
 * The note becomes the decision's reason; without one, the reason says where the decision was made.
 */
export async function decideOnPage(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, input: PageDecisionInput): Promise<{ revision: number }> {
  const access = await resolveTaskAccess(deps, caller, taskId);
  if (!can(access.role, "decide")) throw Object.assign(agentXError("FORBIDDEN", "Only owners decide."), { pageReason: "owners_only" });
  try {
    await decideTaskWorkflow(deps, caller, taskId, {
      requestId: input.requestId, expectedRevision: input.expectedRevision, decision: input.decision, artifactDigest: input.artifactDigest,
      reason: input.note ?? (input.decision === "APPROVE" ? "Approved on the task page." : "See the included comments."),
      answers: input.answers, includedCommentIds: input.includedCommentIds,
      ...(input.selectedOptionalCheckIds === undefined ? {} : { selectedOptionalCheckIds: input.selectedOptionalCheckIds }),
      // The work breakdown's digest binds the approval to the exact ordered plan the owner saw; decideTaskWorkflow checks it, as for Slack and MCP.
      ...(input.workBreakdownDigest === undefined ? {} : { workBreakdownDigest: input.workBreakdownDigest }),
    }, { via: "PAGE", ...(input.note === undefined ? {} : { note: input.note }) });
  } catch (error) {
    throw pageBreakdownRefusal(error);
  }
  const stored = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(taskId), ConsistentRead: true })) as { Item?: DeveloperTaskRecord };
  return { revision: stored.Item?.workflow?.revision ?? input.expectedRevision };
}

/**
 * The owner's retry of a blocked browser and API round, from the page: the very retry the Slack button makes (the plan is approved again against what is ready now, and
 * the old and new selections are recorded). Only a block of an approved round that a retry can fix is retried here; any other block is the checks' own retry, in Slack.
 * The same request again, once it was taken, answers as it did.
 */
export async function retryApplicationRoundOnPage(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, input: PageRetryInput): Promise<{ revision: number }> {
  const access = await resolveTaskAccess(deps, caller, taskId);
  if (!can(access.role, "retry")) throw Object.assign(agentXError("FORBIDDEN", "Only owners retry."), { pageReason: "owners_only" });
  const workflow = access.task.workflow;
  const taken = workflow?.verificationRetries?.some((retry) => retry.requestId === input.requestId) === true;
  if (!taken && (workflow === undefined || access.task.closedAt !== undefined || !workflowApplicationRetryOffered(workflow) || workflow.revision !== input.expectedRevision)) {
    throw agentXError("IDEMPOTENCY_CONFLICT", "This task changed. Refresh the page and try again.");
  }
  await retryTaskWorkflow(deps, caller, taskId, { requestId: input.requestId, expectedRevision: input.expectedRevision, instructions: "Retried the browser and API checks from the task page." });
  const stored = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(taskId), ConsistentRead: true })) as { Item?: DeveloperTaskRecord };
  return { revision: stored.Item?.workflow?.revision ?? input.expectedRevision };
}

/** Where the task stands now, for the open task page's "moved on" check: the same access rule as the page, two values only. */
export async function getTaskFreshness(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string): Promise<TaskFreshness> {
  const { task } = await resolveTaskAccess(deps, caller, taskId);
  return { revision: task.workflow?.revision ?? 0, stage: taskPageStep(task.workflow, task.closedAt !== undefined) };
}

async function coherentPageAccess(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string): Promise<{
  access: TaskAccess;
  capabilities: { peopleRevision?: number; canManagePeople: boolean; canTakeOwnership: boolean };
}> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const access = await resolveTaskAccess(deps, caller, taskId);
    // A reader who holds the task only through a session level reads it; they have no Task People entry to ask about and nothing to manage.
    if (access.source === "session") return { access, capabilities: { canManagePeople: false, canTakeOwnership: false } };
    const capabilities = await readTaskPeopleCapabilities(deps, caller, taskId);
    if (access.peopleRevision === capabilities.peopleRevision) return { access, capabilities };
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "Task People changed while the page was loading");
}

/**
 * Task 18: what the read-only task page shows. The task's owner may read it, and so may a member of the Slack channel
 * the task is shared into (they see its thread already) who can also use the task's project (FR-048). Anyone else is
 * refused: a reader on this Slack workspace who can use the project (FR-047) is told whose approval to ask for, and
 * everyone else, including a reader whose checks failed, gets the answer a missing task gets. Each document is read
 * through its recorded key and shown only when its digest matches; review findings are the current code's.
 */
export async function getTaskDocumentView(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string): Promise<TaskDocumentView> {
  const { access, capabilities } = await coherentPageAccess(deps, caller, taskId);
  const { task } = access;
  const owner = access.role === "owner";
  const workflow = task.workflow;
  const documents: TaskDocumentView["documents"] = [];
  const unverified: TaskDocumentKind[] = [];
  const privatePrefix = `private/${task.ownerKey}/${task.workspaceId}/`;
  const approvedDigests = new Set((workflow?.decisions ?? []).filter((decision) => decision.decision === "APPROVE" && decision.artifactDigest !== undefined).map((decision) => decision.artifactDigest));
  for (const { type, kind } of TASK_PAGE_DOCUMENTS) {
    const versions = (workflow?.artifacts ?? []).filter((item) => item.type === type).sort((left, right) => left.version - right.version);
    const latest = versions.at(-1);
    if (latest === undefined) continue;
    const loaded: TaskDocumentView["documents"] = [];
    let currentFailed = false;
    for (const artifact of versions) {
      const dropped = (reason: string, errorName?: string) => {
        log(deps, { event: "developer.task_page_document_unverified", taskId, documentType: type, reason, ...(errorName === undefined ? {} : { errorName }) });
        // An older version that can't be shown is left out; when the current one can't, the page names the document.
        if (artifact === latest) currentFailed = true;
      };
      // Only this task's own private storage is read; a document recorded anywhere else is never shown.
      if (!artifact.objectKey.startsWith(privatePrefix)) { dropped("outside_task_storage"); continue; }
      let readError: unknown;
      const read = async (objectKey: string, maxBytes: number): Promise<string | undefined> => {
        try {
          return await deps.actions.readArtifact(objectKey, maxBytes);
        } catch (error) {
          // One unreadable document never hides the rest of the page.
          readError = error;
          return undefined;
        }
      };
      const document = await loadWorkflowDocument(read, artifact, {});
      if (readError !== undefined) { dropped("read_failed", readError instanceof Error ? readError.name : "unknown"); continue; }
      if (document === undefined || (document.format === "markdown" && Buffer.byteLength(document.markdown, "utf8") > WORKFLOW_PLAN_MAX_BYTES)) { dropped("integrity_check_failed"); continue; }
      const entry = { kind, version: artifact.version, approved: approvedDigests.has(artifact.sha256), current: artifact === latest };
      if (document.format === "markdown") { loaded.push({ ...entry, format: "markdown", markdown: redactText(document.markdown) }); continue; }
      // Cited code is read for the current version only, and only from this task's own storage.
      // A bundle that cannot be used is logged (no model text), so a broken bundle can be told from GitHub trouble.
      const evidenceUnverified = (reason: "digest" | "prefix" | "missing") => log(deps, { component: "task-page", event: "evidence_unverified", taskId, reason });
      // The bundle's place: on the artifact for a plan stored with its evidence, else the item the evidence job wrote later
      // (it counts only for this artifact and digest). A pointer that cannot be read leaves the code out and never hides the page.
      let recorded = artifact.evidence;
      if (artifact === latest && recorded === undefined) {
        const pointer = await get<Partial<PlanEvidencePointer>>(deps, planEvidencePointerKey(taskId, artifact.id)).catch(() => undefined);
        if (pointer?.artifactId === artifact.id && pointer.artifactSha256 === artifact.sha256 && typeof pointer.objectKey === "string" && typeof pointer.sha256 === "string") {
          recorded = { objectKey: pointer.objectKey, sha256: pointer.sha256 };
        }
      }
      if (artifact === latest && recorded !== undefined && !recorded.objectKey.startsWith(privatePrefix)) evidenceUnverified("prefix");
      const evidence = artifact === latest && recorded?.objectKey.startsWith(privatePrefix) === true ? await loadPlanEvidence(read, { ...artifact, evidence: recorded }, evidenceUnverified) : undefined;
      // Still loading only while nothing is recorded: a recorded bundle that cannot be used is a failure, not a wait.
      // What the plan self-check stored beside a coding plan (a fixed "not checked" when there is no usable record); the other documents are not judged.
      const selfCheck = kind === "coding plan" ? await loadPlanSelfCheck(async (key) => read(key, 70_000), artifact) : undefined;
      loaded.push({ ...entry, format: "structured", plan: document.plan, ...(recorded === undefined ? { createdAt: artifact.createdAt } : {}), ...(evidence === undefined ? {} : { evidence }), ...(selfCheck === undefined ? {} : { selfCheck }) });
    }
    if (currentFailed) unverified.push(kind);
    else documents.push(...loaded);
  }
  const checkPolicy = workflow?.checkPolicy;
  const current = workflow?.candidate?.digest;
  const results = current !== undefined && workflow?.verification?.candidateDigest === current ? workflow.verification.results : [];
  const proposedIds = new Set((checkPolicy?.proposed ?? []).map((check) => check.id));
  const currentPlan = documents.find((document) => document.kind === "coding plan" && document.current);
  const proves = currentPlan?.format === "structured" ? currentPlan.plan.checks?.proves : undefined;
  const checks = workflowSelectedChecks(checkPolicy)
    .map((check) => {
      const status = results.find((result) => result.checkId === check.id)?.status;
      return { id: check.id, label: check.label, passed: status === "PASS" ? true : status === "FAILED" ? false : undefined, ...(status === "UNKNOWN" ? { unclear: true as const } : {}),
        ...(proposedIds.has(check.id) ? { proposed: true as const } : {}), ...(proves?.[check.id] === undefined ? {} : { proves: proves[check.id]! }) };
    });
  // Model-written: the page escapes it. Review only is said once a coding plan exists to have proposed nothing.
  const hasPlan = (workflow?.artifacts ?? []).some((artifact) => artifact.type === "plan");
  const checksNote = checkPolicy?.proposalNote !== undefined ? `${checkPolicy.proposalNote}.`
    : checkPolicy !== undefined && hasPlan && checks.length === 0
      ? checkPolicy.noneReason === undefined ? "No automated checks apply. Review only." : `No automated checks apply: ${redactText(checkPolicy.noneReason).replace(/[.\s]+$/u, "")}. Review only.`
      : undefined;
  // The latest review of each kind for the current code: a retried review replaces the one before it.
  const latestReviews = new Map<string, NonNullable<WorkflowSnapshot["reviews"]>[number]>();
  for (const review of (workflow?.reviews ?? []).filter((item) => current === undefined || item.candidateDigest === current)) {
    const seen = latestReviews.get(review.role);
    if (seen === undefined || review.recordedAt >= seen.recordedAt) latestReviews.set(review.role, review);
  }
  // A finding the owner accepted is listed on its own, not as open. The contracts decide what blocks: an advisory finding
  // never does, and a security finding is never advisory, whatever the reviewer marked.
  const findings = [...latestReviews.values()]
    .flatMap((review) => {
      const blocking = new Set<unknown>(blockingFindings(review));
      const open = new Set<unknown>(blockingFindings(review, workflow?.acceptedFindings));
      return ((review.findings ?? []) as ReadonlyArray<WorkflowReviewFinding | string>).flatMap((finding) => {
        if (blocking.has(finding) && !open.has(finding)) return [];
        // Reports stored before structured findings hold plain strings; they read as caused by this change.
        const entry: WorkflowReviewFinding = typeof finding === "string" ? { text: finding, origin: "INTRODUCED" } : finding;
        return [{
          role: review.role === "SECURITY" ? "security" as const : "code" as const,
          text: redactText(entry.text), origin: entry.origin,
          ...(entry.file === undefined ? {} : { file: entry.file }),
          ...(entry.line === undefined ? {} : { line: entry.line }),
          ...(entry.origin === "INTRODUCED" && !blocking.has(finding) ? { advisory: true as const } : {}),
        }];
      });
    });
  let presentation: Awaited<ReturnType<typeof getTaskPeoplePresentation>> = [];
  try { presentation = await getTaskPeoplePresentation(deps, taskId); }
  catch { /* Historical labels are presentation only; a malformed immutable pair falls back to generic actors. */ }
  const actorNames = new Map(presentation.map((person) => [taskOwnerKey(person.developerId, taskId), redactText(person.name)]));
  // A decision reads under the name of the owner it was made by: the creator's for the creator's actor id, the taker's for theirs (Plan 5 Task 12a).
  const personName = (actorId: string | undefined): string => {
    const named = actorId === undefined ? undefined : ownerNameOfActor(task, actorId);
    if (named !== undefined) {
      const label = redactText(ownerLabel(named));
      return label === OWNER_LABEL ? "The task owner" : label;
    }
    return actorId === undefined ? "A task owner" : actorNames.get(actorId) ?? "A task owner";
  };
  const acceptedFindings = [...new Map((workflow?.acceptedFindings ?? []).filter((accepted) => accepted.candidateDigest === current)
    .map((accepted) => [`${accepted.role}:${accepted.fingerprint}`, accepted] as const)).values()]
    .map((accepted) => ({ role: accepted.role === "SECURITY" ? "security" as const : "code" as const, text: redactText(accepted.text), reason: redactText(accepted.reason), owner: personName(accepted.actorId), at: accepted.at }));
  // What happened to the documents, newest first. A decision names the owner (or a project admin) and the version decided on.
  const documentOf = (artifact: { type: string; version: number }) => {
    const found = TASK_PAGE_DOCUMENTS.find((item) => item.type === artifact.type);
    return found === undefined ? undefined : { name: `${found.label} v${artifact.version}`, link: `#${found.anchor}-v${artifact.version}` };
  };
  const history: TaskDocumentView["history"] = [];
  for (const artifact of workflow?.artifacts ?? []) {
    const found = documentOf(artifact);
    if (found !== undefined) history.push({ at: artifact.createdAt, text: `${found.name} was written`, link: found.link });
  }
  for (const decision of workflow?.decisions ?? []) {
    const who = decision.actorRole === "AGENTX" ? "Rovara" : decision.actorRole === "PROJECT_ADMIN" ? "A project admin" : personName(decision.actorId);
    const artifact = decision.artifactDigest === undefined ? undefined : workflow?.artifacts.find((item) => item.sha256 === decision.artifactDigest);
    const found = artifact === undefined ? undefined : documentOf(artifact);
    const name = found?.name ?? "the document";
    const reason = `: ${cutReason(decision.reason)}`;
    let text: string;
    if (decision.source === "AUTO_FIX") text = `${who} sent the task back to coding by itself${reason}`;
    else if (decision.source === "AUTO_RETRY") text = `${who} retried the ${decision.auto?.stage === "REVIEW" ? "reviews" : "checks"} by itself${reason}`;
    else if (decision.source === "SEND_BACK") text = `${who} sent the task back to coding${reason}`;
    else if (decision.source === "FINDINGS") text = `${who} resolved the review findings${reason}`;
    else if (decision.decision === "APPROVE") text = `${who} approved ${name}${decisionExtras(decision)}`;
    else if (decision.decision === "REQUEST_CHANGES") text = `${who} asked for changes to ${name}${decisionExtras(decision)}${reason}`;
    else if (decision.decision === "REJECT") text = `${who} rejected ${name}${reason}`;
    else text = `${who} skipped ${name}`;
    history.push({ at: decision.at, text, ...(found === undefined ? {} : { link: found.link }) });
  }
  let start: Record<string, unknown> | undefined;
  do {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :event)",
      ExpressionAttributeValues: { ":pk": `DEVTASK#${taskId}`, ":event": "PEOPLE_EVENT#" }, ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: unknown[]; LastEvaluatedKey?: Record<string, unknown> };
    if (!Array.isArray(response.Items)) throw agentXError("RUNTIME_UNAVAILABLE", "Task People history could not be read");
    for (const value of response.Items) {
      const event = value as Record<string, unknown>;
      const roles = new Set(["owner", "commenter", "viewer", "denied"]);
      if (event.entityType !== "TASK_PEOPLE_EVENT" || event.schemaVersion !== 1 || typeof event.actorDeveloperId !== "string"
        || typeof event.targetDeveloperId !== "string" || typeof event.createdAt !== "string" || !Number.isFinite(Date.parse(event.createdAt))
        || typeof event.afterRole !== "string" || !roles.has(event.afterRole)) throw agentXError("RUNTIME_UNAVAILABLE", "Task People history is invalid");
      const actor = personName(taskOwnerKey(event.actorDeveloperId, taskId));
      const target = personName(taskOwnerKey(event.targetDeveloperId, taskId));
      const label = event.afterRole === "denied" ? "removed access for" : `made ${target} ${event.afterRole}`;
      history.push({ at: event.createdAt, text: event.afterRole === "denied" ? `${actor} ${label} ${target}` : `${actor} ${label}` });
    }
    start = response.LastEvaluatedKey;
  } while (start !== undefined);
  history.sort((left, right) => right.at.localeCompare(left.at));
  // Comments and suggestions never hide the page: when they cannot be read, the documents still show.
  let comments: TaskComment[] = [];
  let suggestions: TaskSuggestion[] = [];
  try {
    [comments, suggestions] = await Promise.all([listTaskComments(deps, taskId), listSuggestions(deps, taskId)]);
  } catch (error) {
    log(deps, { event: "developer.task_page_comments_unavailable", taskId, errorName: error instanceof Error ? error.name : "unknown" });
  }
  // A plan stored before quotes named comments by ID credits one as "comment c1": the refs that step's planner was given.
  for (const [index, document] of documents.entries()) {
    if (document.format !== "structured") continue;
    const artifact = workflow?.artifacts.find((item) => item.type === TASK_PAGE_DOCUMENTS.find((entry) => entry.kind === document.kind)?.type && item.version === document.version);
    const refs = artifact === undefined || workflow === undefined ? undefined : await legacyQuoteCommentRefs(deps, task, workflow, artifact, document.plan);
    if (refs !== undefined) documents[index] = { ...document, commentRefs: refs };
  }
  // Which claim of each document cites which comment, for the link in the planner's reply under the comment.
  const citations = new Map<string, Map<string, string>>();
  // And the claim IDs each document has, so a claim number in a planner's reply links only to a claim that is there.
  const claimIds = new Map<string, Set<string>>();
  for (const document of documents) {
    if (document.format !== "structured") continue;
    const type = TASK_PAGE_DOCUMENTS.find((entry) => entry.kind === document.kind)?.type;
    const artifact = workflow?.artifacts.find((item) => item.type === type && item.version === document.version);
    if (artifact !== undefined) {
      citations.set(artifact.id, claimsCitingComments(document.plan, document.commentRefs));
      claimIds.set(artifact.id, planClaimIds(document.plan));
    }
  }
  // A suggestion shows on the version it was made on, or on a later one where its decision did not change.
  const shownSuggestions = TASK_PAGE_DOCUMENTS.flatMap(({ type, kind }) => {
    const versions = documents.filter((document) => document.kind === kind && document.format === "structured");
    const latest = versions.find((document) => document.current);
    if (latest?.format !== "structured") return [];
    const plans = new Map(versions.flatMap((document) => document.format === "structured" ? [[document.version, document.plan] as const] : []));
    return suggestionsFor(suggestions, { document: type, version: latest.version, plan: latest.plan, plans });
  });
  let visibleWorkflowDependenciesProgress = workflow?.workflowDependenciesProgress;
  const graphOperationId = workflow?.workflowDependenciesOperationId;
  if (workflow !== undefined && graphOperationId !== undefined) {
    const binding = await deps.actions.workflowBinding(task.workspaceId, graphOperationId);
    if (binding === undefined) {
      visibleWorkflowDependenciesProgress = [];
    } else {
      const storedProgress = workflow.workflowDependenciesProgress ?? [];
      const visibleBySequence = new Map<number, (typeof storedProgress)[number]>();
      for (const retained of binding.resumeProgress ?? []) {
        const recorded = storedProgress.find((entry) => entry.sequence === retained.sequence && canonicalJson(entry) === canonicalJson(retained));
        if (recorded !== undefined) visibleBySequence.set(recorded.sequence, recorded);
      }
      const sequenceStart = binding.sequenceStart ?? 0;
      for (const entry of storedProgress) {
        if (entry.operationId === graphOperationId && entry.sequence > sequenceStart) visibleBySequence.set(entry.sequence, entry);
      }
      visibleWorkflowDependenciesProgress = [...visibleBySequence.values()].sort((left, right) => left.sequence - right.sequence);
    }
  }
  // M1.3 Task 3.7: the rows of the task's browser and API round, from the broker's own verification of its stored evidence. A round that cannot be read never hides the page.
  let e2eResults: E2EScenarioResults | undefined;
  if (task.workflow?.e2e?.required === true && deps.workflowE2EScenarioResults !== undefined) {
    try { e2eResults = await deps.workflowE2EScenarioResults({ task, operations: (await workspaceReads(deps, task)).operations, actor: owner ? "owner" : "viewer" }); }
    catch (error) { log(deps, { event: "developer.task_e2e_results_unavailable", taskId, errorName: error instanceof Error ? error.name : "unknown" }); }
  }
  // AUTOFIX: what Rovara did by itself and, while the step is blocked, why it asks (the stored ask, read as data).
  const autofixAsk = AutoFixAskSchema.safeParse(task.autofixAsk);
  // Wire lane D (MD-1): a spec on hold, for the owner's choices; read-only here, and a failure to read it only hides the card (the gates still hold the code).
  const specHold = await specHoldOf(deps, task, can(access.role, "publish") && await projectWorkAllowed(deps, task, caller)).catch(() => undefined);
  const autofixLines = workflow === undefined ? [] : autoFixCardLines(workflow, workflow.state === "BLOCKED" && autofixAsk.success ? autofixAsk.data : undefined, { plain: true, ...fixSetupWording(workflow) });
  // A coding run that needed no code change: the page says so and shows what the agent found (rebuilt, redacted and bounded again). Only while the step is blocked with that stop.
  const noChangeFound = workflow !== undefined && workflow.state === "BLOCKED" && task.closedAt === undefined && isNoCodeChangedReason(workflow.blockReason) ? noChangeFindingsFrom(workflow.noChangeFindings) : undefined;
  const noChangeView = workflow !== undefined && workflow.state === "BLOCKED" && task.closedAt === undefined && isNoCodeChangedReason(workflow.blockReason)
    ? { ...(noChangeFound === undefined ? {} : { findings: noChangeFound }) } : undefined;
  const deciding = await pageDecidingView(deps, { task, caller, comments, suggestions: shownSuggestions, citations, claimIds });
  // QA6-03: while a design is under review its approval is only on its decision card (`DESIGN_CARD_ONLY_MESSAGE`; the same condition as the guard in `decideTaskWorkflow`), so the page points to the card instead of offering a button the server refuses.
  const designCardOnly = owner && deciding.waiting?.kind === "design" && workflow?.designReview !== undefined && workflow.reviewPhase === "DESIGN" && designReviewEnabled();
  const stage = taskPageStage(workflow, task.closedAt !== undefined, owner, await publicationAttempts(deps, task), removedReasonOf(task), await mergeViewForWords(deps, task), noChangeHasThread(task.share));
  const stageWords = designCardOnly ? { status: stage.status, nextStep: "Approve the design on its decision card in Rovara, or request changes here." } : stage;
  return {
    taskId, ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }), now: deps.now(), title: task.title, ...stageWords,
    ...(e2eResults === undefined ? {} : { e2eResults }),
    path: workflow?.path ?? "QUICK", revision: workflow?.revision ?? 0, stage: taskPageStep(workflow, task.closedAt !== undefined), role: owner ? "owner" : "reader",
    documents, ...(unverified.length === 0 ? {} : { unverified }), checks, checksRan: results.length > 0, ...(checksNote === undefined ? {} : { checksNote }), findings,
    ...(acceptedFindings.length === 0 ? {} : { acceptedFindings }),
    ...(visibleWorkflowDependenciesProgress === undefined ? {} : { workflowDependenciesProgress: visibleWorkflowDependenciesProgress }),
    pullRequests: (workflow?.pullRequests ?? []).map((pullRequest) => ({ url: pullRequest.url, number: pullRequest.number, state: pullRequest.state })),
    ...(workflow !== undefined && task.closedAt === undefined && workflowApplicationRetryOffered(workflow) ? { applicationRetry: { canRetry: can(access.role, "retry") } } : {}),
    ...(workflow !== undefined && task.closedAt === undefined && workflowReviseOffered(workflow) ? { reviseOffer: { canRevise: can(access.role, "retry") } } : {}),
    ...(specHold === undefined ? {} : { specHold }),
    ...(autofixLines.length === 0 ? {} : { autofix: { lines: autofixLines } }),
    ...(noChangeView === undefined ? {} : { noChange: noChangeView }),
    history, access: pageAccess(access, await projectWorkAllowed(deps, task, caller)), ...(capabilities.peopleRevision === undefined ? {} : { peopleRevision: capabilities.peopleRevision }), canManagePeople: capabilities.canManagePeople,
    canTakeOwnership: capabilities.canTakeOwnership, comments, suggestions: shownSuggestions, askAvailable: await commentAnswersAvailable(deps, task),
    ...deciding,
    ...(designCardOnly ? { designCardOnly: { href: "/app" } } : {}),
  };
}

/** Every claim ID of a document, at every level. */
function planClaimIds(plan: PlanDocument): Set<string> {
  const ids = new Set<string>();
  const walk = (claims: readonly PlanClaim[]) => { for (const claim of claims) { ids.add(claim.id); walk(claim.children ?? []); } };
  walk(plan.claims);
  return ids;
}

/**
 * The first claim (in document order) whose evidence quotes each comment, by comment ID (a quote's author `comment:<ID>`, or,
 * for a plan stored before that, its ref ("comment c1") through `refs`).
 */
function claimsCitingComments(plan: PlanDocument, refs?: Readonly<Record<string, string>>): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (claims: readonly PlanClaim[]) => {
    for (const claim of claims) {
      for (const evidence of claim.evidence ?? []) {
        const ref = evidence.kind === "quote" ? commentRefInAuthor(evidence.author) : undefined;
        const id = evidence.kind === "quote" ? commentIdInAuthor(evidence.author) ?? (ref === undefined ? undefined : refs?.[ref]) : undefined;
        if (id !== undefined && !found.has(id)) found.set(id, claim.id);
      }
      walk(claim.children ?? []);
    }
  };
  walk(plan.claims);
  return found;
}

const DOCUMENT_TYPES: readonly string[] = ["requirements", "design", "plan"];

/**
 * For a plan stored before quotes named comments by ID: the comments its quotes credit by ref ("comment c1"), as ref to
 * comment ID. A ref means the comments the document's own step was given: the Request changes on the version before it,
 * or, for a first version, the Approve of the document type before it (found by type, not by where it sits in the list).
 * Undefined when no quote names a ref or the decision's record cannot be read. The page also checks the quoted words
 * against that comment, so a ref that has since come to mean another comment is never credited to its author.
 */
async function legacyQuoteCommentRefs(
  deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, workflow: WorkflowSnapshot, artifact: WorkflowSnapshot["artifacts"][number], plan: PlanDocument,
): Promise<Record<string, string> | undefined> {
  const named = new Set<string>();
  const walk = (claims: readonly PlanClaim[]) => {
    for (const claim of claims) {
      for (const evidence of claim.evidence ?? []) {
        const ref = evidence.kind === "quote" ? commentRefInAuthor(evidence.author) : undefined;
        if (ref !== undefined) named.add(ref);
      }
      walk(claim.children ?? []);
    }
  };
  walk(plan.claims);
  if (named.size === 0) return undefined;
  const sameEarlier = workflow.artifacts.find((item) => item.type === artifact.type && item.version === artifact.version - 1);
  const before = DOCUMENT_TYPES[DOCUMENT_TYPES.indexOf(artifact.type) - 1];
  const digests = new Set((sameEarlier === undefined ? workflow.artifacts.filter((item) => before !== undefined && item.type === before) : [sameEarlier]).map((item) => item.sha256));
  const decision = [...workflow.decisions].reverse().find((item) => (item.source ?? "GATE") === "GATE" && item.artifactDigest !== undefined && digests.has(item.artifactDigest));
  if (decision === undefined || (decision.commentsIncluded ?? 0) === 0) return undefined;
  try {
    const detail = await readDecisionDetail(deps, task.taskId, decision.requestId);
    const ids = detail?.includedCommentIds ?? [];
    const refs = Object.fromEntries([...named].flatMap((ref) => {
      const id = ids[Number(ref.slice(1)) - 1];
      return id === undefined ? [] : [[ref, id] as const];
    }));
    return Object.keys(refs).length === 0 ? undefined : refs;
  } catch {
    return undefined;
  }
}

/** Whether AgentX can answer this task's page comments: the Slack service's queue is set up and the task was started in its own Slack thread. */
async function commentAnswersAvailable(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord): Promise<boolean> {
  const share = task.share;
  if (deps.slackRequestQueue === undefined || share?.threadTs === undefined || task.closedAt !== undefined) return false;
  try {
    const shared = await get<{ taskId?: string; workflowThread?: unknown; closedAt?: unknown }>(deps, sharedTaskKey({ teamId: share.teamId, channelId: share.channelId, threadTs: share.threadTs }));
    return shared?.taskId === task.taskId && shared.workflowThread === true && shared.closedAt === undefined;
  } catch {
    return false;
  }
}

/**
 * Spec 061 slice 2, what the page needs to answer, comment and decide: the comments and suggestions as this reader sees
 * them, the document waiting for its owner (if any), the comment counter, and the coding plan's optional checks. A
 * counter that cannot be read is 0; the page's poll catches up.
 */
async function pageDecidingView(
  deps: DeveloperTaskRouteDependencies,
  input: { task: DeveloperTaskRecord; caller: DeveloperCaller; comments: readonly TaskComment[]; suggestions: readonly TaskSuggestion[]; citations: ReadonlyMap<string, ReadonlyMap<string, string>>; claimIds: ReadonlyMap<string, ReadonlySet<string>> },
): Promise<Pick<TaskDocumentView, "pageComments" | "pageSuggestions" | "waiting" | "commentSeq" | "optionalChecks">> {
  const { task, caller } = input;
  const workflow = task.workflow;
  const stepDocument = currentStepDocument(workflow);
  const waitingArtifact = workflow?.stage === "PLAN_REVIEW" && workflow.state === "WAITING" && task.closedAt === undefined && stepDocument !== undefined
    ? workflow.artifacts.filter((artifact) => artifact.type === stepDocument).sort((left, right) => right.version - left.version)[0] : undefined;
  const kind = waitingArtifact === undefined ? undefined : TASK_PAGE_DOCUMENTS.find((item) => item.type === waitingArtifact.type)?.kind;
  let commentSeq = 0;
  try {
    const counter = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: commentCounterKey(task.taskId), ConsistentRead: true })) as { Item?: { seq?: unknown } };
    if (typeof counter.Item?.seq === "number") commentSeq = counter.Item.seq;
  } catch (error) {
    log(deps, { event: "developer.task_page_comment_counter_unavailable", taskId: task.taskId, errorName: error instanceof Error ? error.name : "unknown" });
  }
  const policy = workflow?.checkPolicy;
  return {
    pageComments: pageCommentViews(input.comments, { readerId: caller.developerId, now: deps.now(), artifacts: workflow?.artifacts ?? [], citations: input.citations, claimIds: input.claimIds }),
    pageSuggestions: input.suggestions.map((suggestion) => ({
      document: suggestion.document, decisionId: suggestion.decisionId, optionId: suggestion.optionId, name: suggestion.name, you: suggestion.developerId === caller.developerId,
    })),
    ...(waitingArtifact === undefined || kind === undefined ? {} : { waiting: { kind, version: waitingArtifact.version, artifactDigest: waitingArtifact.sha256 } }),
    commentSeq,
    optionalChecks: (policy?.optional ?? []).map((check) => ({ id: check.id, label: check.label, selected: (policy?.selectedOptionalIds ?? []).includes(check.id) })),
  };
}
