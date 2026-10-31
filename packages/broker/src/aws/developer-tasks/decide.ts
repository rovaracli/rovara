import { WORKFLOW_ACTIONABLE_REFUSALS, WORKFLOW_BREAKDOWN_REFUSALS } from "../../developer/workflow-actions.js";
import { createHash, randomUUID } from "node:crypto";
import {
  AgentXError,
  agentXError,
  redactText,
  type DeveloperTaskView,
  type WorkflowSnapshot,
  WorkflowSnapshotSchema,
  type TaskComment,
  type WorkflowStage,
  type WorkflowDecisionRequest,
  DECISION_COMMENTS_MAX,
  WorkflowDecisionDetailSchema,
  planDocumentMarkdown,
  sameIdSet,
  workflowSelectedChecks,
  WorkflowDecisionRequestSchema,
  E2EPolicySchema,
  e2ePolicyDigest,
  e2eScenarioBundleDigest,
  WorkflowTransitionError,
  decideWorkflow,
  canonicalJson,
  validateTaskGraph,
  taskGraphDigest,
  blockWorkflow,
  type E2EApplicationSelectionRecord,
  RUN_LIMIT_BLOCK_PREFIX,
  runLimitBlockText,
} from "@agentx/contracts";
import { workflowDependenciesAllowed } from "../../rovara-code/parallel-parts.js";
import { acceptRunLimit } from "../../spend/estimate.js";
import { cleanUsd } from "../../spend/top-ups.js";
import { aiToolTurn, developerTaskIdentity, effectiveTaskOwner, taskKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { planDocumentKindName } from "../broker-shared.js";
import { loadWorkflowDocument } from "../../developer/plan-artifacts.js";
import type { TransactItems } from "../developer-task-actions.js";
import type { DeveloperCaller } from "../developer-routes.js";
import { can, type resolveTaskAccess } from "../../developer/task-access.js";
import { commentKey, counterTouch, listTaskComments, openCommentsFor } from "../../developer/page-comments.js";
import {
  APPROVED_COMMENT_ANSWERS_INSTRUCTION,
  COMMENT_ANSWERS_INSTRUCTION,
  COMMENT_CHANGED_MESSAGE,
  REQUEST_CHANGES_NEEDS_INPUT,
  decisionDetailKey,
  pageCommentsPromptSection,
  planOwnerAnswers,
  promptComments,
  readDecisionDetail,
  refusalMessage,
} from "../../developer/owner-answers.js";
import { answeredMilestoneItems } from "../../rovara-code/answered.js";
import { withTestRule } from "../../rovara-code/verification-report.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";
import {
  OWNER_LABEL,
  TASK_PAGE_DOCUMENTS,
  estimateDependencies,
  iso,
  log,
  ownerLabel,
  parse,
  partyOfTaskActor,
  putNew,
  taskBaseOption,
  turnTable,
} from "./common.js";
import { type AuthorizedTask, accessFence, authorizeTaskAction, authorizeTaskActor } from "./access.js";
import { taskView } from "./task-view.js";
import { syncIndex } from "./task-index.js";
import { actionableWorkspace, busyOrClosing, capWindowBaseline } from "./task-window.js";
import {
  partsDecisionOf,
  previousMarkdownBlock,
  retiredClaimIdList,
  structuredWorkflowPrompt,
  workflowWithCurrentGraphOperation,
} from "./workflow-inputs.js";
import { fedThroughUpdate, promptTagId, withCurrentThreadNotes } from "./thread-notes.js";
import { finishedReleaseMarkItem, releaseFinishedTaskQuietly } from "./release.js";
import { specAfterPlanApproval } from "./spec-wiring.js";

/**
 * The task a caller may decide, through the one access rule (resolveTaskAccess and the role table). Anyone whose role may
 * not decide, and anyone who may not see the task at all, gets the answer a missing task gets, as before.
 */
async function decidableTask(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, historicalRequestId?: string): Promise<AuthorizedTask> {
  const notYours = () => agentXError("TASK_NOT_FOUND", "no task here that you can see");
  let access: Awaited<ReturnType<typeof resolveTaskAccess>>;
  try {
    access = await authorizeTaskAction(deps, caller, taskId, "decide");
  } catch (error) {
    if (error instanceof AgentXError && (error.code === "TASK_NOT_FOUND" || error.code === "TASK_ACCESS_DENIED")) {
      // A terminal task no longer accepts a new decision, but its exact recorded answer remains
      // readable to an actor who still has current decide authority. Payload and actor equality are
      // checked by the normal historical transition below; this path performs no write or reopening.
      if (historicalRequestId !== undefined) {
        try {
          const historical = await authorizeTaskActor(deps, caller, taskId, "decide");
          if (historical.task.workflow?.decisions.some((decision) => decision.requestId === historicalRequestId) === true) return historical;
        } catch {
          // Revoked or no-longer-authorized actors receive the same missing-task answer as before.
        }
      }
      throw notYours();
    }
    throw error;
  }
  if (!can(access.role, "decide")) throw notYours();
  return access as AuthorizedTask;
}

/**
 * The one transition for a plan decision, from Slack, MCP and the task page alike. A page decision (`via: "PAGE"`) carries
 * the owner's answer to every decision and the comments they chose to send; Slack and MCP send neither, so an approval
 * takes AgentX's answers and up to 25 open comments, oldest first, and a change request takes none (FR-036). The detail
 * (every answer, the comment IDs in order, the note) and a lock on each included comment are written in the same
 * transaction that moves the task, so a comment edited meanwhile cancels the whole decision. A replay of the same request
 * is the first decision, whatever comments arrived since.
 */
export async function decideTaskWorkflow(
  deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown,
  options: { via?: "PAGE"; note?: string } = {},
): Promise<{ task: DeveloperTaskView }> {
  const request = parse(WorkflowDecisionRequestSchema, value, deps, "workflow-decision");
  const access = await decidableTask(deps, caller, taskId, request.requestId);
  const { task } = access;
  if (task.workflow === undefined) throw agentXError("NOT_FOUND", "this task does not have a workflow record");
  const workflow = task.workflow;
  const prior = workflow.decisions.find((decision) => decision.requestId === request.requestId);
  const actor = { actorId: access.actorId, role: "TASK_OWNER" as const };
  const decideOptions = { now: iso(deps), allowedSkipStages: [] as WorkflowStage[], ...(options.via === undefined ? {} : { via: options.via }) };
  const refused = (current: WorkflowSnapshot) => {
    // Only the owner decides, so whoever is refused here is the owner: a task started in Slack keeps no name for them, but
    // their sign-in does, so they read their own name rather than "the task owner".
    const owner = effectiveTaskOwner(task);
    const ownerName = redactText(ownerLabel(ownerLabel(owner.name) === OWNER_LABEL ? caller.name : owner.name));
    const message = refusalMessage({
      workflow: current, ownerName, artifactSha256: request.artifactDigest ?? "", now: deps.now(),
      labelOf: (type) => TASK_PAGE_DOCUMENTS.find((item) => item.type === type)?.label ?? "The document",
    });
    const error = agentXError("IDEMPOTENCY_CONFLICT", message);
    // When the owner won the race, Slack can name them with a mention; the page and MCP keep the plain name.
    if (owner.slackUserId !== undefined && (message.startsWith(`Already approved by ${ownerName} `) || message.startsWith(`Changes were already requested by ${ownerName} `))) {
      Object.assign(error, { decidedBy: { name: ownerName, slackUserId: owner.slackUserId } });
    }
    return error;
  };
  // "Close as answered" reads the plan's own answer, from the document that passed its digest check (below); nothing in the request body can supply it.
  let noChangeNeeded: NonNullable<Parameters<typeof decideWorkflow>[3]["noChangeNeeded"]> | undefined;
  const transition = (decisionRequest: WorkflowDecisionRequest, decisions?: ReadonlyArray<{ id: string; optionIds: string[]; recommended: string }>, workBreakdownDigest?: string) => {
    try {
      return decideWorkflow(workflow, decisionRequest, actor, { ...decideOptions, authority: access.authority, ...(decisions === undefined ? {} : { decisions }), ...(workBreakdownDigest === undefined ? {} : { workBreakdownDigest }), ...(noChangeNeeded === undefined ? {} : { noChangeNeeded }) });
    } catch (error) {
      if (error instanceof WorkflowTransitionError) throw agentXError("CONFIG_INVALID", error.message);
      throw error;
    }
  };
  if (prior?.decision === "APPROVE" && prior.workBreakdownDigest !== undefined && (request.answers?.length ?? 0) === 0) {
    const detail = await readDecisionDetail(deps, taskId, request.requestId);
    const recordedComments = detail?.includedCommentIds ?? [];
    if (request.includedCommentIds !== undefined && !sameIdSet(request.includedCommentIds, recordedComments)) {
      throw agentXError("CONFIG_INVALID", "request ID was already used for a different workflow decision");
    }
    transition({ ...request, selectedOptionalCheckIds: request.selectedOptionalCheckIds ?? prior.selectedOptionalCheckIds ?? [],
      includedCommentIds: request.includedCommentIds ?? recordedComments }, undefined, prior.workBreakdownDigest);
    return { task: await taskView(deps, task, { events: 0, details: false }) };
  }
  // A decision on a document that is no longer waiting is refused before anything else is read: the page says who decided.
  if (prior === undefined && (workflow.revision !== request.expectedRevision || workflow.stage !== "PLAN_REVIEW" || workflow.state !== "WAITING")) {
    if (options.via === "PAGE") throw refused(workflow);
    transition(request);
  }
  const decided = workflow.artifacts.find((artifact) => artifact.sha256 === request.artifactDigest);
  const documentType = decided?.type === "requirements" || decided?.type === "design" || decided?.type === "plan" ? decided.type : undefined;
  const read = (objectKey: string, maxBytes: number) => deps.actions.readArtifact(objectKey, maxBytes);
  const answered = (request.answers?.length ?? 0) > 0;
  // The decided document, checked against its digest: its decisions check the answers, and the next step reads it.
  const loaded = decided !== undefined && (answered || request.closeAsAnswered === true || (prior === undefined && request.decision !== "REJECT")) ? await loadWorkflowDocument(read, decided, {}) : undefined;
  if (request.closeAsAnswered === true && loaded?.format === "structured" && loaded.plan.noChangeNeeded !== undefined) {
    noChangeNeeded = { ...loaded.plan.noChangeNeeded, restatement: loaded.plan.title };
  }
  const correction = task.e2ePlanCorrection;
  if (request.decision === "APPROVE" && documentType === "plan" && correction !== undefined) {
    if (workflow.candidate?.digest !== correction.candidateDigest) {
      throw agentXError("CONFIG_INVALID", WORKFLOW_ACTIONABLE_REFUSALS.correctionStale);
    }
    if (decided?.sha256 === correction.artifactSha256) {
      throw agentXError("CONFIG_INVALID", WORKFLOW_ACTIONABLE_REFUSALS.correctionUnchanged);
    }
    if (correction.requiredE2E && !(loaded?.format === "structured" && loaded.plan.e2e !== undefined)) {
      throw agentXError("CONFIG_INVALID", WORKFLOW_ACTIONABLE_REFUSALS.correctionLostIntent);
    }
  }
  const decisions = loaded?.format === "structured"
    ? loaded.plan.decisions.map((decision) => ({ id: decision.id, optionIds: decision.options.map((option) => option.id), recommended: decision.recommended }))
    : undefined;
  const planGraph = loaded?.format === "structured" ? loaded.plan.workBreakdown : undefined;
  let workBreakdownDigest: string | undefined;
  if (planGraph !== undefined && request.decision === "APPROVE") {
    if (prior === undefined && !workflowDependenciesAllowed(deps, workflow)) throw agentXError("CONFIG_INVALID", WORKFLOW_BREAKDOWN_REFUSALS.notEnabled);
    const pinnedProject = await deps.actions.projectRevision(deps.orgId, task.project, task.startingRevision);
    if (pinnedProject === undefined || pinnedProject.definition.repositories.length !== 1) {
      throw agentXError("CONFIG_INVALID", WORKFLOW_BREAKDOWN_REFUSALS.onePinnedRepository);
    }
    const validated = validateTaskGraph(planGraph, { taskId, repositoryId: pinnedProject.definition.repositories[0]!.name });
    if (!validated.ok) throw agentXError("CONFIG_INVALID", `the approved work breakdown is invalid: ${validated.errors.join("; ")}`);
    workBreakdownDigest = taskGraphDigest(validated.graph);
    if (request.decision === "APPROVE" && request.workBreakdownDigest === undefined) {
      throw agentXError("CONFIG_INVALID", WORKFLOW_BREAKDOWN_REFUSALS.digestMissing);
    }
    if (request.workBreakdownDigest !== undefined && request.workBreakdownDigest !== workBreakdownDigest) {
      throw agentXError("CONFIG_INVALID", WORKFLOW_BREAKDOWN_REFUSALS.digestChanged);
    }
  } else if (request.workBreakdownDigest !== undefined) {
    throw agentXError("CONFIG_INVALID", WORKFLOW_BREAKDOWN_REFUSALS.noBreakdown);
  }
  const boundDecisionRequest = request;

  if (prior !== undefined) {
    // A replay keeps its first comment set: the IDs recorded with it, never the comments open now.
    const detail = await readDecisionDetail(deps, taskId, request.requestId);
    const recorded = detail?.includedCommentIds ?? [];
    if (request.includedCommentIds !== undefined && !sameIdSet(request.includedCommentIds, recorded)) {
      throw agentXError("CONFIG_INVALID", "request ID was already used for a different workflow decision");
    }
    transition({ ...boundDecisionRequest, includedCommentIds: request.includedCommentIds ?? recorded }, decisions, workBreakdownDigest);
    return { task: await taskView(deps, task, { events: 0, details: false }) };
  }

  let included: TaskComment[] = [];
  if (request.decision === "REJECT" || request.decision === "SKIP") {
    if ((request.includedCommentIds?.length ?? 0) > 0) throw agentXError("CONFIG_INVALID", "only Approve and Request changes send comments");
  } else if (documentType !== undefined && decided !== undefined && (request.decision === "APPROVE" || request.includedCommentIds !== undefined)) {
    // Only an approval, or a decision that names its comments, reads them: a Slack Request changes sends none.
    const open = openCommentsFor(await listTaskComments(deps, taskId), documentType, decided.version);
    if (request.includedCommentIds !== undefined) {
      const byId = new Map(open.map((comment) => [comment.commentId, comment]));
      included = request.includedCommentIds.map((commentId) => {
        const comment = byId.get(commentId);
        if (comment === undefined) throw Object.assign(agentXError("IDEMPOTENCY_CONFLICT", COMMENT_CHANGED_MESSAGE), { pageReason: "comment_changed" });
        return comment;
      });
    } else if (request.decision === "APPROVE") {
      included = open.slice(0, DECISION_COMMENTS_MAX);
    }
  }
  if (options.via === "PAGE" && request.decision === "REQUEST_CHANGES" && included.length === 0 && (options.note ?? "").trim() === "") {
    throw agentXError("CONFIG_INVALID", REQUEST_CHANGES_NEEDS_INPUT);
  }
  const decisionRequest: WorkflowDecisionRequest = included.length === 0 && request.includedCommentIds === undefined
    ? boundDecisionRequest : { ...boundDecisionRequest, includedCommentIds: included.map((comment) => comment.commentId) };
  let next = transition(decisionRequest, decisions, workBreakdownDigest);
  if (request.decision === "APPROVE" && documentType === "plan" && !(loaded?.format === "structured" && loaded.plan.e2e !== undefined)) {
    const pinnedProject = await deps.actions.projectRevision(deps.orgId, task.project, task.startingRevision);
    if (pinnedProject === undefined) throw agentXError("CONFIG_INVALID", WORKFLOW_ACTIONABLE_REFUSALS.pinnedProjectUnavailable);
    if (pinnedProject.definition.e2e !== undefined && E2EPolicySchema.parse(pinnedProject.definition.e2e).baselineScenarioIds.length > 0) {
      throw agentXError("CONFIG_INVALID", WORKFLOW_ACTIONABLE_REFUSALS.baselineIntentMissing);
    }
  }
  // A required feature-E2E obligation begins only when the Owner approves the canonical plan bytes that contain it.
  // The digests below identify the approved intent and its policy/bundle; candidate-specific execution-plan identity is
  // bound later by the server-created CHECKS admission and round.
  let applicationConditions: TransactItems = [];
  /** M1.3 Task 3.7b: whether the project wants the baseline round, so the coding run is asked to export the unchanged code. */
  let baselineSource = false;
  if (request.decision === "APPROVE" && documentType === "plan" && loaded?.format === "structured" && loaded.plan.e2e !== undefined) {
    const pinnedProject = await deps.actions.projectRevision(deps.orgId, task.project, task.startingRevision);
    if (pinnedProject?.definition.e2e === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the approved feature E2E intent has no pinned project policy");
    const intent = loaded.plan.e2e;
    const policy = E2EPolicySchema.parse(pinnedProject.definition.e2e);
    // A v2 application intent is approved only after the broker derives its selection against the approved setup and the runtime rows READY now;
    // a refusal leaves the plan waiting (the owner can request changes), and a broker without the check never approves one.
    let applicationSelection: E2EApplicationSelectionRecord | undefined;
    if (intent.schemaVersion === 2) {
      if (deps.validateWorkflowE2EApplicationPlan === undefined) {
        throw agentXError("RUNTIME_UNAVAILABLE", WORKFLOW_ACTIONABLE_REFUSALS.applicationApprovalNotInstalled);
      }
      const validated = await deps.validateWorkflowE2EApplicationPlan({ task, intent, artifact: { id: decided!.id, sha256: decided!.sha256 } });
      applicationSelection = validated.selection;
      applicationConditions = validated.conditions;
      baselineSource = validated.baselineWanted === true;
    }
    const bundleBody = { schemaVersion: 1 as const, planDigest: decided!.sha256, templateVersion: "trusted-e2e/v1", scenarios: intent.scenarios, bundleDigest: "0".repeat(64) };
    const bundleDigest = e2eScenarioBundleDigest(bundleBody);
    const intentDigest = createHash("sha256").update(canonicalJson({ domain: "workflow-e2e-approved-intent/v1", artifactDigest: decided!.sha256, intent })).digest("hex");
    next = WorkflowSnapshotSchema.parse({ ...next, e2e: { contractDigest: decided!.sha256, policyDigest: e2ePolicyDigest(policy),
      bundleDigest, executionPlanDigest: intentDigest, required: true, currentGroupRunIds: [], resultRefs: [],
      ...(applicationSelection === undefined ? {} : { applicationSelection }) } });
  }
  const receivedAt = iso(deps);
  if (request.decision === "REJECT") {
    // Closed as answered: the answer's milestone and the task's release mark are written in the same commit as the end, so a stop right after loses neither.
    const answeredItems: TransactItems = next.outcome === "ANSWERED"
      ? [...answeredMilestoneItems({ tableName: deps.tableName }, { taskId, orgId: deps.orgId, ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }) }, next, receivedAt),
        finishedReleaseMarkItem(deps.tableName, taskId, receivedAt)]
      : [];
    await deps.actions.transact([{ Update: {
      TableName: deps.tableName, Key: taskKey(taskId),
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ConditionExpression: "workflow.revision = :revision AND workflow.#state = :waiting",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: { ":workflow": next, ":now": receivedAt, ":revision": workflow.revision, ":waiting": "WAITING" },
    } }, accessFence(deps, access), ...answeredItems]);
    // A rejected plan ends the task: it gives back its slot and its workspace now.
    await releaseFinishedTaskQuietly(deps, taskId);
    const fresh = (await authorizeTaskActor(deps, caller, taskId, "decide")).task;
    return { task: await taskView(deps, fresh, { events: 0, details: false }) };
  }
  await actionableWorkspace(deps, task);
  const currentArtifactType = workflow.path === "FULL" && workflow.reviewPhase === "REQUIREMENTS" ? "requirements"
    : workflow.path === "FULL" && workflow.reviewPhase === "DESIGN" ? "design" : "plan";
  const currentPlan = workflow.artifacts.filter((artifact) => artifact.type === currentArtifactType).at(-1);
  if (currentPlan === undefined) throw agentXError("WORKSPACE_NOT_READY", "the current approval document is missing");
  if (loaded === undefined) throw agentXError("WORKSPACE_NOT_READY", "the current approval document failed its digest check");
  const recordedDecision = next.decisions.at(-1)!;
  // The owner's answers and the comments they sent, as the next step reads them; AgentX's answers when neither was given.
  const ownerAnswers = request.answers === undefined && included.length === 0 ? "recommended" as const : planOwnerAnswers(request.answers ?? [], included);
  const commentsSection = pageCommentsPromptSection(promptComments(included), promptTagId(task, request.requestId));
  const plan = loaded.format === "structured"
    ? planDocumentMarkdown(loaded.plan, { kind: currentArtifactType, version: currentPlan.version, sha256: currentPlan.sha256, ...(request.decision === "APPROVE" ? { answers: ownerAnswers } : {}) })
    : loaded.markdown;
  const mode = request.decision === "REQUEST_CHANGES" || next.stage === "PLAN" ? "PLAN" as const : "IMPLEMENT" as const;
  const nextPhase = next.reviewPhase;
  const changed = (recordedDecision.answerOverrides?.length ?? 0) > 0;
  // The planner says what it did about each comment: after Request changes, and after an Approve that goes on to another
  // planning step. A coding run has no answers block to give; the page says those comments went to coding.
  const answerInstruction = request.decision === "REQUEST_CHANGES" ? COMMENT_ANSWERS_INSTRUCTION : request.decision === "APPROVE" && mode === "PLAN" ? APPROVED_COMMENT_ANSWERS_INSTRUCTION : "";
  const comments = commentsSection === "" ? "" : `\n\n${commentsSection}${answerInstruction === "" ? "" : `\n\n${answerInstruction}`}`;
  // A task that started before structured plans moves to them at its next planning step: the planning instructions around
  // this request are the only format instruction, and the old Markdown goes in as data.
  const basePrompt = loaded.format === "structured"
    ? structuredWorkflowPrompt({ ...loaded, markdown: plan }, request, mode, nextPhase, currentArtifactType, {
      chosen: ownerAnswers === "recommended" ? [] : ownerAnswers.chosen, changed, comments,
    })
    : request.decision === "REQUEST_CHANGES"
      ? `Revise the current ${planDocumentKindName(currentArtifactType)}. Requested changes: ${request.reason}\n\nReturn the complete revised document. Do not edit files.\n\n${previousMarkdownBlock(plan)}${comments}`
      : mode === "PLAN"
        ? `Prepare the next owner-review document for this request. The owner approved the ${planDocumentKindName(currentArtifactType)} (sha256 ${currentPlan.sha256}) below. Write the ${nextPhase === "DESIGN" ? "design" : "coding plan"} as the planning instructions describe, building on the approved document. Do not edit files.\n\n${previousMarkdownBlock(plan)}${comments}`
        : `Implement the human-approved plan below. Follow its ordered steps, run the listed checks, and report results and limitations. Do not push branches or create pull requests; AgentX handles publication after the required gates.\n\nApproved plan (sha256 ${currentPlan.sha256}):\n${plan}${comments}`;
  // The decision's own transition: after the last document, coding is ready. A run limit that is not accepted blocks this, and coding is not started.
  const decidedNext = next;
  next = { ...next, revision: next.revision + 1, state: "RUNNING", updatedAt: receivedAt };
  // A planning step is told which claim IDs earlier versions dropped, so it does not number a new claim with one.
  const retired = mode === "PLAN" ? await retiredClaimIdList(deps, workflow) : [];
  // Only a coding run checks its work: a planning run, here revising a plan the owner did not approve, gets no proposed command.
  const selectedReadiness = next.checkPolicy === undefined || mode !== "IMPLEMENT" ? undefined : workflowSelectedChecks(next.checkPolicy).map((check) => check.command);
  const firstParts = mode === "IMPLEMENT" && planGraph !== undefined && next.workflowDependenciesApproval !== undefined ? await partsDecisionOf(deps, task, next, planGraph) : undefined;
  const firstParallel = firstParts?.parallel;
  const workflowDependencies = mode === "IMPLEMENT" && planGraph !== undefined && next.workflowDependenciesApproval !== undefined
    ? { graph: planGraph, approval: next.workflowDependenciesApproval, peopleRevision: access.peopleRevision ?? 0, sequenceStart: 0, ...(firstParallel === undefined ? {} : { parallel: firstParallel }) } : undefined;
  // The decision's detail, beside the task (never inside it), when there is anything to keep beyond the decision itself.
  const detailItems = request.answers === undefined && included.length === 0 && options.note === undefined ? [] : [putNew(deps.tableName, {
    ...decisionDetailKey(taskId, request.requestId), entityType: "WORKFLOW_DECISION_DETAIL",
    ...WorkflowDecisionDetailSchema.parse({
      taskId, requestId: request.requestId, decision: request.decision, artifactSha256: currentPlan.sha256,
      answers: request.answers ?? [], includedCommentIds: included.map((comment) => comment.commentId),
      ...(options.note === undefined || options.note.trim() === "" ? {} : { note: options.note.trim() }), at: receivedAt,
    }),
  })];
  // Each included comment is locked at the revision that was checked: an edit or delete since cancels the decision.
  const lock = { requestId: request.requestId, decision: request.decision, at: receivedAt };
  const lockItems = included.map((comment) => ({ Update: {
    TableName: deps.tableName, Key: commentKey(taskId, comment.commentId),
    UpdateExpression: "SET lockedBy = :lock, #rev = #rev + :one",
    ConditionExpression: "#rev = :rev AND attribute_not_exists(lockedBy) AND attribute_not_exists(deletedAt)",
    ExpressionAttributeNames: { "#rev": "rev" },
    ExpressionAttributeValues: { ":lock": lock, ":one": 1, ":rev": comment.rev },
  } }));
  const lockOffset = 2 + detailItems.length;
  // Plan 3, Task 34: approving the coding plan accepts its run limit (what the plan under review carried, or works out now) when the approver's tier allows it.
  // Else the request is made first (a repeat of it is the same request) and the workflow blocks here with the decision recorded: its Retry coding, after the
  // limit is raised, starts what the approval would have started.
  const runLimit = request.decision === "APPROVE" && mode === "IMPLEMENT" && deps.modelAccess !== undefined ? await settleRunLimit(deps, caller, task, request.requestId) : undefined;
  // The corrected plan's approval ends the E2E correction fence, whether coding starts now or waits for the run limit.
  const correctedPlan = correction !== undefined && request.decision === "APPROVE" && documentType === "plan"
    && currentPlan.sha256 !== correction.artifactSha256 && workflow.candidate?.digest === correction.candidateDigest
    && loaded?.format === "structured" && loaded.plan.e2e !== undefined;
  if (runLimit !== undefined && !runLimit.accepted) {
    const blocked = blockWorkflow(decidedNext, runLimit.message, receivedAt);
    try {
      await deps.actions.transact([
        { Update: {
          TableName: deps.tableName, Key: taskKey(taskId),
          UpdateExpression: `SET workflow = :workflow, updatedAt = :now${correctedPlan ? " REMOVE e2ePlanCorrection" : ""}`,
          ConditionExpression: `workflow.revision = :revision AND workflow.#state = :waiting AND attribute_not_exists(closedAt)${correctedPlan ? " AND e2ePlanCorrection.artifactId = :correctionArtifact AND e2ePlanCorrection.artifactSha256 = :correctionSha AND e2ePlanCorrection.candidateDigest = :correctionCandidate" : ""}`,
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: { ":workflow": blocked, ":now": receivedAt, ":revision": workflow.revision, ":waiting": "WAITING",
            ...(correctedPlan ? { ":correctionArtifact": correction.artifactId, ":correctionSha": correction.artifactSha256, ":correctionCandidate": correction.candidateDigest } : {}) },
        } },
        putNew(turnTable(deps), aiToolTurn({
          party: partyOfTaskActor(task, caller), turnId: randomUUID(), action: "continue", phase: "accepted", outcome: "accepted", receivedAt, finishedAt: iso(deps),
          request: request.reason, response: `Workflow ${request.decision.toLowerCase().replaceAll("_", " ")} accepted; coding waits for the run limit to be approved.`,
        })),
        ...detailItems,
        ...lockItems,
        ...(included.length === 0 ? [] : [counterTouch(deps, taskId)]),
        accessFence(deps, access),
      ]);
    } catch (error) {
      const fresh = (await authorizeTaskAction(deps, caller, taskId, "decide")).task;
      if (fresh.workflow?.decisions.some((decision) => decision.requestId === request.requestId) === true) return { task: await taskView(deps, fresh, { events: 0, details: false }) };
      if (fresh.workflow !== undefined && fresh.workflow.revision !== workflow.revision) throw refused(fresh.workflow);
      const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons?.map((reason) => reason.Code ?? "None");
      if (reasons !== undefined && lockItems.some((_, index) => reasons[lockOffset + index] === "ConditionalCheckFailed")) {
        throw Object.assign(agentXError("IDEMPOTENCY_CONFLICT", COMMENT_CHANGED_MESSAGE), { pageReason: "comment_changed" });
      }
      return busyOrClosing(deps, task, error);
    }
    const fresh = (await authorizeTaskAction(deps, caller, taskId, "decide")).task;
    const view = await taskView(deps, fresh, { events: 0, details: false });
    await syncIndex(deps, fresh, view.status, view.updatedAt);
    return { task: view };
  }
  try {
    // Gap 2: replies posted in the task's thread and not yet given to a step go with this one, once.
    await withCurrentThreadNotes(deps, task, request.requestId, (current, notes) => {
      const fed = fedThroughUpdate(notes);
      return deps.actions.acceptTask(developerTaskIdentity(current, deps.orgId), current.workspaceId, { requestId: request.requestId, conversationId: current.conversationId, prompt: mode === "IMPLEMENT" ? withTestRule(basePrompt + notes.suffix, next) : basePrompt + notes.suffix }, (operation) => {
        const workflowToStore = workflowWithCurrentGraphOperation(next, workflowDependencies === undefined ? undefined : operation.id, workflowDependencies);
        return [
          { Update: {
            TableName: deps.tableName, Key: taskKey(taskId),
            UpdateExpression: `SET workflow = :workflow, updatedAt = :now${fed.clause}${runLimit === undefined ? "" : ", budgetUsd = :runLimit, budgetBaselineUsd = :runBaseline"}${correctedPlan ? " REMOVE e2ePlanCorrection" : ""}`,
            ConditionExpression: `workflow.revision = :revision AND workflow.#state = :waiting${fed.condition}${runLimit === undefined ? "" : task.budgetUsd === undefined ? " AND attribute_not_exists(budgetUsd)" : " AND budgetUsd = :seenBudget"}${correctedPlan ? " AND e2ePlanCorrection.artifactId = :correctionArtifact AND e2ePlanCorrection.artifactSha256 = :correctionSha AND e2ePlanCorrection.candidateDigest = :correctionCandidate" : ""}`,
            ExpressionAttributeNames: { "#state": "state" },
            ExpressionAttributeValues: { ":workflow": workflowToStore, ":now": receivedAt, ":revision": workflow.revision, ":waiting": "WAITING", ...fed.values,
              ...(runLimit === undefined || !runLimit.accepted ? {} : { ":runLimit": runLimit.runLimitUsd, ":runBaseline": runLimit.baselineUsd, ...(task.budgetUsd === undefined ? {} : { ":seenBudget": task.budgetUsd }) }),
              ...(correctedPlan ? { ":correctionArtifact": correction.artifactId, ":correctionSha": correction.artifactSha256,
                ":correctionCandidate": correction.candidateDigest } : {}) },
          } },
          putNew(turnTable(deps), aiToolTurn({
            party: partyOfTaskActor(task, caller), turnId: randomUUID(), action: "continue", phase: "accepted", outcome: "accepted", receivedAt, finishedAt: iso(deps),
            request: request.reason, response: `Workflow ${request.decision.toLowerCase().replaceAll("_", " ")} accepted as operation ${operation.id}.`, operationId: operation.id,
          })),
          ...detailItems,
          ...lockItems,
          ...(included.length === 0 ? [] : [counterTouch(deps, taskId)]),
          ...applicationConditions,
          accessFence(deps, access),
        ];
      }, { sharedTask: task.shared === true, workflowMode: mode, ...(retired.length === 0 ? {} : { retiredClaimIds: retired }), ...(mode === "PLAN" && nextPhase !== undefined ? { workflowPhase: nextPhase } : {}), ...(selectedReadiness === undefined ? {} : { readiness: selectedReadiness }), ...(mode === "IMPLEMENT" ? taskBaseOption(task, next) : {}), ...(mode === "IMPLEMENT" && next.programStepId !== undefined ? { programStepId: next.programStepId } : {}), ...(workflowDependencies === undefined ? {} : { workflowDependencies }),
        // M1.3 Task 3.7b (owner decision D2): the coding run also exports the unchanged code, for the approved application plan's baseline round.
        ...(mode === "IMPLEMENT" && baselineSource ? { workflowE2EBaselineSource: true as const } : {}),
        // Bug N: why the plan's parts run one after another, as the operation's first timeline line.
        ...(firstParts?.note === undefined ? {} : { firstEvent: firstParts.note }) });
    });
  } catch (error) {
    // Another decision got there first: the same request (a double press) is that decision; any other is refused with
    // who decided. That is checked before the comment locks: a decision that won with the same comment also fails its lock.
    const fresh = (await authorizeTaskAction(deps, caller, taskId, "decide")).task;
    if (fresh.workflow?.decisions.some((decision) => decision.requestId === request.requestId) === true) {
      return { task: await taskView(deps, fresh, { events: 0, details: false }) };
    }
    if (fresh.workflow !== undefined && fresh.workflow.revision !== workflow.revision) throw refused(fresh.workflow);
    const reasons = (error as { extraCancellation?: string[] }).extraCancellation;
    if (reasons !== undefined && lockItems.some((_, index) => reasons[lockOffset + index] === "ConditionalCheckFailed")) {
      throw Object.assign(agentXError("IDEMPOTENCY_CONFLICT", COMMENT_CHANGED_MESSAGE), { pageReason: "comment_changed" });
    }
    return busyOrClosing(deps, task, error);
  }
  const fresh = (await authorizeTaskAction(deps, caller, taskId, "decide")).task;
  // M1.3 Task 3.7 (owner decision D2): the approved application plan asks for its informational baseline round. Best effort and after the approval is committed: whatever
  // happens to the baseline, the approval and the checks stand exactly as they are.
  // Meta repo lane D: the approval makes a spec due when the project's spec target says so. Best effort and after the approval is committed; it records an obligation and runs nothing.
  if (request.decision === "APPROVE" && mode === "IMPLEMENT") await specAfterPlanApproval(deps, taskId);
  if (request.decision === "APPROVE" && mode === "IMPLEMENT") await deps.startWorkflowE2EBaseline?.({ task: fresh }).catch((error: unknown) => log(deps, { event: "developer.e2e_baseline_not_started", taskId, errorName: error instanceof Error ? error.name : "unknown" }));
  const view = await taskView(deps, fresh, { events: 0, details: false });
  await syncIndex(deps, fresh, view.status, view.updatedAt);
  return { task: view };
}

/** Plan 3, Task 34: what approving the coding plan did with its run limit. `baselineUsd` is what planning spent, where the run limit's window starts. */
type RunLimitOutcome = { accepted: true; runLimitUsd: number; baselineUsd: number } | { accepted: false; message: string };

/**
 * Approving the coding plan accepts the plan's run limit by the approver's tier (`acceptRunLimit`). Accepted: the new window starts at what planning has spent
 * (a proxy that can't say refuses the approval, as a Continue is). Not accepted: the `run_limit` request is made through Task 32's seam before anything is
 * written, so a workflow is never blocked on a request that was not made; without the seam (until Task 32 is wired) no request is made and the words are the same.
 */
async function settleRunLimit(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, task: DeveloperTaskRecord, requestId: string): Promise<RunLimitOutcome> {
  const decision = await acceptRunLimit(
    // The approver's project role is read now: from the project's people where agents are set up, else through the caller's own project access.
    { ...estimateDependencies(deps), projectMembers: deps.agentRuns?.projectMembers ?? { roleOf: async () => (await deps.checkAccess(task.project)).role } },
    { task, approver: { developerId: caller.developerId, orgRole: caller.orgRole } },
  );
  if (decision.accepted) return { accepted: true, runLimitUsd: decision.runLimitUsd, baselineUsd: await capWindowBaseline(deps, task) ?? 0 };
  const ask = deps.agentRuns?.requestRunLimit;
  let asked = false;
  if (ask !== undefined) {
    try {
      asked = await ask({
        kind: "run_limit", resume: "implement", orgId: deps.orgId, taskId: task.taskId, requestId, newLimitUsd: decision.runLimitUsd,
        amountUsd: Math.max(0, cleanUsd(decision.runLimitUsd - (task.budgetUsd ?? 0))), approverRole: decision.approverRole, requestedBy: { kind: "member", developerId: caller.developerId },
        reason: `Approving this plan sets a run limit of $${String(decision.runLimitUsd)}, which needs ${decision.needs === "maintainer" ? "a project maintainer's" : decision.needs === "agent_owner" ? "the agent owner's" : "an admin's"} approval.`,
      }) !== undefined;
    } catch (error) {
      if (error instanceof AgentXError) throw error;
      log(deps, { event: "developer.run_limit_request_failed", taskId: task.taskId, errorName: error instanceof Error ? error.name : "unknown" });
      throw agentXError("RUNTIME_UNAVAILABLE", "the run limit could not be asked for just now; try approving again");
    }
  }
  // "I've asked for it" only when a request exists.
  // Option E: when the project or an agent's owner pays, the wait is said as such, and the words are the same whether or not the seam made a request.
  return { accepted: false, message: decision.message.startsWith(RUN_LIMIT_BLOCK_PREFIX) ? runLimitBlockText(decision.runLimitUsd, decision.needs as "maintainer" | "admin", asked) : decision.message };
}
