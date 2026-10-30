import { createHash, randomUUID } from "node:crypto";
import {
  UNDERSTAND_TIMEOUT_MINUTES,
  UNDERSTAND_WATCHDOG_GRACE_MINUTES,
  AgentXError,
  ContinueDeveloperTaskRequestSchema,
  agentXError,
  type DeveloperTaskView,
  type Operation,
  type WorkflowSnapshot,
  workflowIsReviewOnly,
  workflowSelectedChecks,
  type ProjectCommand,
  type WorkflowReviewChecks,
  type WorkflowReviewPlan,
  type WorkflowReviewFeedback,
  type WorkflowFeedbackReviewReport,
  WorkflowReviewFeedbackSchema,
  WORKFLOW_REVIEW_FEEDBACK_MAX,
  WorkflowFeedbackReviewReportSchema,
  WorkflowTransitionError,
  type WorkflowFeedbackApprovalBinding,
  applyWorkflowFeedbackCheckChanges,
  WORKFLOW_PLAN_MAX_BYTES,
  workflowRequestId,
  type WorkflowDecision,
  sendBackProblems,
  type WorkflowDependencyInvocation,
  workflowReviewRoles,
  abandonWorkflowFix,
} from "@agentx/contracts";
import { workflowDependenciesAllowed } from "../../rovara-code/parallel-parts.js";
import { aiToolTurn, developerTaskIdentity, partyOfTask, taskKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { isConditional } from "../broker-shared.js";
import { shortenMarkdown } from "../../developer/plan-artifacts.js";
import type { DeveloperCaller } from "../developer-routes.js";
import type { TaskAccess } from "../../developer/task-access.js";
import { withTestRule } from "../../rovara-code/verification-report.js";
import { ciFixPrompt, ciFixPromptWithoutOutput, readCiEvidence } from "../../rovara-code/ci-fix.js";
import { conflictFixPrompt } from "../../rovara-code/branch-sync.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";
import {
  creatorGuard,
  FEEDBACK_REPORT_MAX_BYTES,
  get,
  iso,
  parse,
  partyOfTaskActor,
  putNew,
  stoppedByLoweredAutonomy,
  taskBaseOption,
  turnTable,
} from "./common.js";
import { accessFence, authorizeTaskAction, systemTaskAccess } from "./access.js";
import { resumeParkedTaskDispatch } from "./access-resume.js";
import { feedbackCiBlock, feedbackFixPrompt, planAutomaticFeedbackRound } from "./feedback-review.js";
import { taskView } from "./task-view.js";
import { syncIndex } from "./task-index.js";
import { actionableWorkspace, busyOrClosing } from "./task-window.js";
import {
  approvedCodingPlan,
  approvedWorkflowDependencies,
  NO_PUBLISH_NOTE,
  selectedCheckCommands,
  workflowWithCurrentGraphOperation,
} from "./workflow-inputs.js";
import { promptTagId, sendBackProblemsPromptSection } from "./thread-notes.js";

export async function startTaskWorkflowReview(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown): Promise<{ task: DeveloperTaskView }> {
  const request = parse(ContinueDeveloperTaskRequestSchema, value, deps, "workflow-review");
  const access = await authorizeTaskAction(deps, caller, taskId, "retry");
  const resumed = await resumeParkedTaskDispatch(deps, caller, access, request);
  if (resumed !== undefined) return resumed;
  const { task } = access;
  const workflow = task.workflow;
  // Task 16: a blocked review may be retried on the same checked code whatever stopped it, findings included.
  const retrying = workflow?.stage === "REVIEW" && workflow.state === "BLOCKED";
  if (workflow === undefined || workflow.stage !== "REVIEW" || !(workflow.state === "WAITING" || retrying)
    || workflow.candidate === undefined || workflow.verification?.candidateDigest !== workflow.candidate.digest
    || workflow.verification.results.some((result) => result.status !== "PASS")) {
    throw agentXError("CONFIG_INVALID", "review can start or retry only when the exact candidate's checks passed and the review is waiting or blocked");
  }
  if (retrying && (request.expectedRevision !== workflow.revision || request.candidateDigest !== workflow.candidate.digest)) {
    throw agentXError("IDEMPOTENCY_CONFLICT", "the review retry is stale; refresh the task and use its current candidate and revision");
  }
  if (!retrying && request.expectedRevision !== undefined && request.expectedRevision !== workflow.revision) {
    throw agentXError("IDEMPOTENCY_CONFLICT", "the review request is stale; refresh the task and try again");
  }
  await actionableWorkspace(deps, task);
  try {
    await queueWorkflowReview(deps, task, { ...workflow, candidate: workflow.candidate }, request.requestId, request.instructions, access, caller);
  } catch (error) {
    if (isConditional(error)) await authorizeTaskAction(deps, caller, taskId, "retry");
    return busyOrClosing(deps, task, error);
  }
  const fresh = (await authorizeTaskAction(deps, caller, taskId, "retry")).task;
  const view = await taskView(deps, fresh, { events: 0, details: false });
  await syncIndex(deps, fresh, view.status, view.updatedAt);
  return { task: view };
}

/** The note an automatic review start carries, fixed per candidate so a retried dispatch sends the same request. */
const AUTOMATIC_REVIEW_NOTE = "Started automatically after the selected checks passed.";
const AUTOMATIC_REVIEW_ONLY_NOTE = "Started automatically: no automated check applied to this change.";

/** A check's command as reviewers read it: the program and its arguments, and the folder it ran in. */
function reviewCheckCommand(command: ProjectCommand): string {
  const text = `${[command.executable, ...command.args].join(" ")} (in ${command.cwd})`;
  return text.length <= 1_024 ? text : `${text.slice(0, 1_023)}\u2026`;
}

/**
 * What the reviewers are told about the checks on the candidate: the selected checks its passing verification recorded,
 * or that it is review only with the plan's reason. Nothing when verification recorded neither.
 */
function workflowReviewRiskOption(workflow: WorkflowSnapshot): { workflowReviewRisk?: true } {
  // Rovara Code version 2: the code review also states a risk level. A version 1 review is exactly as before.
  return workflow.definitionVersion === "1.1.0" ? { workflowReviewRisk: true } : {};
}

function workflowReviewChecksOption(workflow: WorkflowSnapshot): { workflowReviewChecks?: WorkflowReviewChecks } {
  const verification = workflow.verification;
  if (verification === undefined) return {};
  if (verification.reviewOnly === true) {
    const noneReason = workflow.checkPolicy?.noneReason;
    return { workflowReviewChecks: { reviewOnly: true, checks: [], ...(noneReason === undefined ? {} : { noneReason }) } };
  }
  const byId = new Map(workflowSelectedChecks(workflow.checkPolicy).map((check) => [check.id, check]));
  const checks = verification.results.flatMap((result) => {
    const check = byId.get(result.checkId);
    return check === undefined ? [] : [{ label: check.label, command: reviewCheckCommand(check.command) }];
  });
  return checks.length === 0 ? {} : { workflowReviewChecks: { reviewOnly: false, checks } };
}

/**
 * What the reviewers are shown of the plan the owner approved: its Markdown copy, cut to the plan limit, and the
 * approved artifact's digest. A plan that is missing or no longer matches its digest is not shown (the reviewers
 * then judge the change as they did before plans were shown) rather than holding the reviews back.
 */
async function workflowReviewPlanOption(deps: DeveloperTaskRouteDependencies, workflow: WorkflowSnapshot): Promise<{ workflowReviewPlan?: WorkflowReviewPlan }> {
  let approved: Awaited<ReturnType<typeof approvedCodingPlan>>;
  try {
    approved = await approvedCodingPlan(deps, workflow);
  } catch (error) {
    if (error instanceof AgentXError && error.code === "WORKSPACE_NOT_READY") return {};
    throw error;
  }
  return { workflowReviewPlan: {
    markdown: shortenMarkdown(approved.text, WORKFLOW_PLAN_MAX_BYTES), sha256: approved.sha256,
    ...(approved.e2eIntent === undefined ? {} : { e2eIntent: approved.e2eIntent }),
  } };
}

/**
 * What the reviewers are shown of the fixes the owner approved from pull request feedback since the plan: for each
 * approved decision, oldest first, each selected finding's proposed fix (summary and file changes) and the owner's note.
 * Each report is read through its recorded key and its digest checked; one that cannot be read is left out (the
 * reviewers then judge against the plan, as before) rather than holding the reviews back. Older entries give way first
 * when the whole would not fit the reviewers' limit.
 */
async function workflowReviewFeedbackOption(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, workflow: WorkflowSnapshot): Promise<{ workflowReviewFeedback?: WorkflowReviewFeedback }> {
  const approvals = (workflow.feedbackDecisions ?? []).filter(decision => decision.decision === "APPROVE");
  if (approvals.length === 0) return {};
  const refs = [...(workflow.feedbackReviewHistory ?? []), ...(workflow.feedbackReview?.reviewRef === undefined ? [] : [workflow.feedbackReview.reviewRef])];
  const prefix = `private/${task.ownerKey}/${task.workspaceId}/feedback-reviews/`;
  const cut = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max - 1)}\u2026`;
  const entries: WorkflowReviewFeedback = [];
  for (const decision of approvals) {
    const ref = refs.find(candidate => candidate.sha256 === decision.reviewDigest);
    if (ref === undefined || ref.objectKey !== `${prefix}${ref.sha256}.json`) continue;
    let report: WorkflowFeedbackReviewReport;
    try {
      const bytes = await deps.actions.readArtifact(ref.objectKey, FEEDBACK_REPORT_MAX_BYTES);
      if (createHash("sha256").update(bytes, "utf8").digest("hex") !== ref.sha256) continue;
      const parsed = WorkflowFeedbackReviewReportSchema.safeParse(JSON.parse(bytes));
      if (!parsed.success || parsed.data.taskId !== task.taskId) continue;
      report = parsed.data;
    } catch {
      continue;
    }
    for (const finding of report.findings.filter(item => decision.selectedFindingIds.includes(item.id))) {
      entries.push({
        summary: cut(finding.fixProposal?.summary ?? finding.rationale, 1_000),
        fileChanges: (finding.fixProposal?.fileChanges ?? []).map(change => ({ repositoryId: change.repositoryId, path: change.path, change: cut(change.change, 500) })),
        ...(decision.ownerNote === undefined ? {} : { ownerNote: cut(decision.ownerNote, 500) }),
      });
    }
  }
  let shown = entries.slice(-WORKFLOW_REVIEW_FEEDBACK_MAX);
  while (shown.length > 0 && !WorkflowReviewFeedbackSchema.safeParse(shown).success) shown = shown.slice(1);
  return shown.length === 0 ? {} : { workflowReviewFeedback: shown };
}

/**
 * Queue the read-only code and security reviews of the task's current candidate, moving the workflow from its
 * current REVIEW state (WAITING, or BLOCKED for a retry) to RUNNING in the same transaction. The prompt depends
 * on the candidate and note bound to the dispatch identity, so a repeated request ID with changed context conflicts.
 */
export async function queueWorkflowReview(
  deps: DeveloperTaskRouteDependencies,
  task: DeveloperTaskRecord,
  workflow: WorkflowSnapshot & { candidate: NonNullable<WorkflowSnapshot["candidate"]> },
  requestId: string,
  note: string,
  access?: TaskAccess,
  actor?: DeveloperCaller,
  /** AUTOFIX: Rovara's own retry of blocked reviews records its decision in the same write. */
  autoDecision?: WorkflowDecision,
): Promise<{ operation: Operation; duplicate: boolean }> {
  const receivedAt = iso(deps);
  const candidateDigest = workflow.candidate.digest;
  const { blockReason: _blockReason, reviews: _oldReviews, ...retryBase } = workflow;
  void _blockReason; void _oldReviews;
  // The reviews this step asks for run again; a program's earlier reviews of the other role (same code) stand.
  const reviewRoles = workflowReviewRoles(workflow);
  const keptReviews = (workflow.reviews ?? []).filter((review) => !reviewRoles.includes(review.role));
  const next: WorkflowSnapshot = { ...retryBase, ...(keptReviews.length === 0 ? {} : { reviews: keptReviews }), revision: workflow.revision + 1, state: "RUNNING",
    ...(autoDecision === undefined ? {} : { decisions: [...workflow.decisions, autoDecision] }), updatedAt: receivedAt };
  // A custom sequence's review step may ask for one review only; the wording follows what it asks.
  const asked = reviewRoles.length === 2 ? "critic and security reviews" : reviewRoles[0] === "SECURITY" ? "security review" : "critic review";
  const prompt = `Perform the required read-only ${asked} for the task. The current verified candidate digest is ${candidateDigest}. Do not edit files. Reviewer findings must be concise and refer to code evidence. The owner retry note is carried separately as untrusted reviewer context.`;
  const reviewPlan = await workflowReviewPlanOption(deps, workflow);
  const reviewFeedback = await workflowReviewFeedbackOption(deps, task, workflow);
  await creatorGuard(deps, task);
  return deps.actions.acceptTask(developerTaskIdentity(task, deps.orgId), task.workspaceId, { requestId, conversationId: task.conversationId, prompt }, (operation) => [
    { Update: {
      TableName: deps.tableName, Key: taskKey(task.taskId),
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :review AND workflow.#state = :state AND workflow.candidate.digest = :candidate AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
      ExpressionAttributeValues: { ":workflow": next, ":now": receivedAt, ":revision": workflow.revision, ":review": "REVIEW", ":state": workflow.state, ":candidate": candidateDigest },
    } },
    putNew(turnTable(deps), aiToolTurn({
      party: actor === undefined ? partyOfTask(task) : partyOfTaskActor(task, actor), turnId: randomUUID(), action: "continue", phase: "accepted", outcome: "accepted", receivedAt, finishedAt: iso(deps),
      request: "Run independent candidate reviews", response: `Independent ${reviewRoles.length === 2 ? "code and security reviews" : reviewRoles[0] === "SECURITY" ? "security review" : "code review"} started as operation ${operation.id}.`, operationId: operation.id,
    })),
    ...(access === undefined ? [] : [accessFence(deps, access)]),
  ], { sharedTask: task.shared === true, workflowMode: "REVIEW", workflowReviewNote: note, ...taskBaseOption(task, next), ...workflowReviewChecksOption(workflow), ...workflowReviewRiskOption(workflow), ...reviewPlan, ...reviewFeedback,
    // A custom sequence's review step: which step it is, and (when it asks for fewer than both) which reviews to run.
    ...(workflow.programStepId === undefined ? {} : { programStepId: workflow.programStepId }), ...(reviewRoles.length === 2 ? {} : { workflowReviewers: reviewRoles }) });
}

/**
 * Gap 6: start the reviews of exactly the candidate whose selected checks passed, with no one asking. Answers
 * STALE (nothing to do) unless the task is open and still waiting for review at the expected revision with that
 * candidate's passing checks. The request ID is derived from the task, revision and candidate, so a recovered or
 * repeated dispatch is the broker's duplicate of the first. WORKSPACE_BUSY and WORKSPACE_NOT_READY propagate so
 * the dispatcher tries again later.
 */
export async function startTaskWorkflowReviewFromSystem(
  deps: DeveloperTaskRouteDependencies,
  taskId: string,
  expected: { workflowRevision: number; candidateDigest: string },
  actor?: DeveloperCaller,
): Promise<"STARTED" | "DUPLICATE" | "STALE"> {
  const task = await get<DeveloperTaskRecord>(deps, taskKey(taskId));
  const workflow = task?.workflow;
  if (task === undefined || task.closedAt !== undefined || workflow === undefined
    || workflow.revision !== expected.workflowRevision || workflow.stage !== "REVIEW" || workflow.state !== "WAITING"
    || workflow.candidate === undefined || workflow.candidate.digest !== expected.candidateDigest
    || workflow.verification?.candidateDigest !== expected.candidateDigest
    || (workflow.verification.results.length === 0 && !(workflow.verification.reviewOnly === true && workflowIsReviewOnly(workflow.checkPolicy)))
    || workflow.verification.results.some((result) => result.status !== "PASS")) return "STALE";
  await creatorGuard(deps, task);
  // Plan 6 Task 16: a review of a round Rovara decided itself is paid work, so the autonomy is read again first.
  if (await stoppedByLoweredAutonomy(deps, task, workflow)) return "STALE";
  const dispatchAccess = await systemTaskAccess(deps, task);
  const workspace = await deps.actions.workspace(task.workspaceId);
  if (workspace.status === "CLOSED" || workspace.status === "PREPARATION_FAILED") return "STALE";
  const requestId = workflowRequestId("agentx-auto-review", taskId, expected.workflowRevision, expected.candidateDigest);
  const note = workflow.verification.reviewOnly === true ? AUTOMATIC_REVIEW_ONLY_NOTE : AUTOMATIC_REVIEW_NOTE;
  const accepted = await queueWorkflowReview(deps, task, { ...workflow, candidate: workflow.candidate }, requestId, note, dispatchAccess, actor);
  return accepted.duplicate ? "DUPLICATE" : "STARTED";
}

/**
 * A custom coding sequence's next coding step, started with no one asking: another build after a build, or the build
 * a review's findings go back to. Answers STALE (nothing to do) unless the task is open and still ready for coding at the
 * expected revision. The request ID comes from the task, revision and step, so a recovered or repeated dispatch is the
 * broker's duplicate of the first. Problems the reviews or checks found go to the coder as a send-back does. The task's
 * cap window is not renewed: only a person restarts that.
 */
export async function startTaskWorkflowImplementationFromSystem(
  deps: DeveloperTaskRouteDependencies,
  taskId: string,
  expected: { workflowRevision: number },
  actor?: DeveloperCaller,
): Promise<"STARTED" | "DUPLICATE" | "STALE"> {
  const task = await get<DeveloperTaskRecord>(deps, taskKey(taskId));
  const workflow = task?.workflow;
  if (task === undefined || task.closedAt !== undefined || workflow === undefined || workflow.program === undefined || workflow.programStepId === undefined
    || workflow.revision !== expected.workflowRevision || workflow.stage !== "IMPLEMENT" || workflow.state !== "READY") return "STALE";
  await creatorGuard(deps, task);
  const dispatchAccess = await systemTaskAccess(deps, task);
  const workspace = await deps.actions.workspace(task.workspaceId);
  if (workspace.status === "CLOSED" || workspace.status === "PREPARATION_FAILED") return "STALE";
  // Plan 6 Task 15: a fix is made for the head Rovara pushed. If a person pushed meanwhile, the round stops here, before any model run is paid for: the task waits for the merge again (tracking
  // says someone else pushed, and stops fixing), and nothing of theirs is ever overwritten.
  if (workflow.fixSource !== undefined && deps.currentPullRequestHead !== undefined) {
    for (const pullRequest of (workflow.pullRequests ?? []).filter((entry) => (entry.state === "OPEN" || entry.state === "UNKNOWN") && entry.headSha !== undefined)) {
      const head = await deps.currentPullRequestHead(task, pullRequest);
      if (head === pullRequest.headSha) continue;
      const stoppedAt = iso(deps);
      try {
        await deps.actions.transact([{ Update: {
          TableName: deps.tableName, Key: taskKey(task.taskId), UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
          ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :implement AND workflow.#state = :ready AND attribute_not_exists(closedAt)",
          ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
          ExpressionAttributeValues: { ":workflow": abandonWorkflowFix(workflow, stoppedAt), ":now": stoppedAt, ":revision": workflow.revision, ":implement": "IMPLEMENT", ":ready": "READY" },
        } }]);
      } catch (error) {
        if (!isConditional(error)) throw error;
      }
      return "STALE";
    }
  }
  // Plan 6 Task 16: before a paid run of a round Rovara decided itself (its first run or a send-back), how far Rovara may go on its own is read again.
  if (await stoppedByLoweredAutonomy(deps, task, workflow)) return "STALE";
  // Plan 6 Task 16: a round Rovara decided itself (the review comments of people with write access) is the owner's approval path, run with Rovara's own decision.
  // Only the round's first run: once it has run, the approval is on the workflow, and a run that follows (the round's own reviews or checks sent the work back) is an ordinary send-back, told what they found.
  if (workflow.fixSource === "feedback" && workflow.feedbackDispatchApproval === undefined) return startAutomaticFeedbackRound(deps, task, workflow, dispatchAccess, actor);
  const receivedAt = iso(deps);
  const requestId = workflowRequestId("agentx-program-implement", taskId, workflow.revision, workflow.programStepId);
  const next: WorkflowSnapshot = { ...workflow, revision: workflow.revision + 1, state: "RUNNING", updatedAt: receivedAt };
  // A step sent back by its reviews or checks is given what they found; a step that simply follows another is given the plan.
  const found = sendBackProblems(workflow);
  // Plan 6 Task 15: the first run of a fix for failing CI is told what CI said (kept when the round started), not the plan again: the coder has the plan in its conversation. What the fix's own
  // reviews and checks find goes back to the coder as any send-back does, with the CI fix's mark still on the run.
  let prompt: string;
  if (workflow.fixSource === "ci" && found.length === 0) {
    const block = await readCiEvidence(deps, taskId, task.orgId, workflow.revision);
    prompt = withTestRule(block === undefined ? ciFixPromptWithoutOutput({ names: workflow.fixProblems ?? [], notes: NO_PUBLISH_NOTE }) : ciFixPrompt({ block, notes: NO_PUBLISH_NOTE }), next);
  } else if (workflow.fixSource === "conflict" && found.length === 0) {
    // Plan 6 Task 17: the workspace is in the state the conflicting merge left; the run is told which files, and the plan stays in its conversation.
    prompt = withTestRule(conflictFixPrompt({ paths: workflow.fixProblems ?? [], notes: NO_PUBLISH_NOTE }), next);
  } else if (workflow.fixSource === "feedback" && found.length > 0) {
    // A send-back inside a round fixing review comments: what the reviews or checks found, and the findings it was given; the plan is not the scope.
    prompt = withTestRule(`Address the problems below in the code. They were found in your fix for the review comments you were given: keep to those findings and change nothing else. ${NO_PUBLISH_NOTE}\n\n${sendBackProblemsPromptSection(found, promptTagId(task, requestId))}`, next);
  } else {
    const plan = await approvedCodingPlan(deps, workflow);
    const problems = found.length === 0 ? "" : `${sendBackProblemsPromptSection(found, promptTagId(task, requestId))}\n\n`;
    prompt = withTestRule(found.length === 0
      ? `Implement the human-approved plan below, one coding step of a longer sequence: the previous step's work is in the code now. Follow its ordered steps, run the listed checks, and report results and limitations. ${NO_PUBLISH_NOTE}\n\nApproved plan (sha256 ${plan.sha256}):\n${plan.text}`
      : `Address the problems below in the code, keeping to the approved plan. ${NO_PUBLISH_NOTE}\n\n${problems}Approved plan (sha256 ${plan.sha256}):\n${plan.text}`, next);
  }
  // 0.4.17: a findings round sent back to the first build step runs the task's approved work breakdown again, as the owner's Send back and AUTOFIX's send-back do. Without the binding the
  // finished run has nothing to show it built the approved plan, and VERIFY blocked a task whose code and tests were fine. A CI, conflict or feedback fix cannot carry one (the worker protocol
  // forbids a fix to open pull requests to combine with a work breakdown), and a later build of a custom sequence carries none by design; neither is given a binding here.
  let workflowDependencies: WorkflowDependencyInvocation | undefined;
  if (workflow.workflowDependenciesApproval !== undefined && workflow.fixSource === undefined && found.length > 0 && !laterProgramBuild(workflow)) {
    const approved = await approvedWorkflowDependencies(deps, task, dispatchAccess?.peopleRevision);
    if (approved !== undefined) {
      if (!workflowDependenciesAllowed(deps, workflow)) {
        throw agentXError("CONFIG_INVALID", "the approved ordered work plan is retained, but this broker is not enabled to continue it");
      }
      // The reviewed code is what the workspace holds, so the run starts from its tree (as the owner's answer to a review finding does); the checkpoints already acknowledged stay in the history.
      workflowDependencies = {
        ...approved,
        resumeTreeSha: workflow.candidate?.repositories.length === 1 ? workflow.candidate.repositories[0]!.treeSha : approved.resumeTreeSha,
        sequenceStart: workflow.workflowDependenciesProgress?.at(-1)?.sequence ?? approved.sequenceStart ?? 0,
        resumeProgress: [],
      };
    }
  }
  const accepted = await deps.actions.acceptTask(developerTaskIdentity(task, deps.orgId), task.workspaceId, { requestId, conversationId: task.conversationId, prompt }, (operation) => [
    { Update: {
      TableName: deps.tableName, Key: taskKey(task.taskId),
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :implement AND workflow.#state = :ready AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
      // The run that carries the graph is the one the workflow names, written in this same transaction (a run with no binding leaves the earlier name as it was).
      ExpressionAttributeValues: { ":workflow": workflowDependencies === undefined ? next : workflowWithCurrentGraphOperation(next, operation.id, workflowDependencies), ":now": receivedAt, ":revision": workflow.revision, ":implement": "IMPLEMENT", ":ready": "READY" },
    } },
    putNew(turnTable(deps), aiToolTurn({
      party: actor === undefined ? partyOfTask(task) : partyOfTaskActor(task, actor), turnId: randomUUID(), action: "continue", phase: "accepted", outcome: "accepted", receivedAt, finishedAt: iso(deps),
      request: "Run the next coding step", response: `The next coding step of the sequence started as operation ${operation.id}.`, operationId: operation.id,
    })),
    ...(dispatchAccess === undefined ? [] : [accessFence(deps, dispatchAccess)]),
  ], { sharedTask: task.shared === true, workflowMode: "IMPLEMENT", ...selectedCheckCommands(next), ...taskBaseOption(task, next), programStepId: workflow.programStepId,
    ...(workflowDependencies === undefined ? {} : { workflowDependencies }),
    // A CI or feedback fix starts from the head the pull request has (Plan 6 Task 17), so an abandoned conflict round's files are not what it begins on.
    ...(workflow.fixSource === undefined ? {} : { workflowFix: { source: workflow.fixSource, ...(fixStartHead(workflow) === undefined ? {} : { startFrom: fixStartHead(workflow)! }) } }) });
  return accepted.duplicate ? "DUPLICATE" : "STARTED";
}

/** Whether the workflow program is past its first build step: a work breakdown the plan approved belongs to that first build. */
export function laterProgramBuild(workflow: WorkflowSnapshot): boolean {
  const first = workflow.program?.steps.find((step) => step.kind === "build");
  return first !== undefined && workflow.programStepId !== undefined && workflow.programStepId !== first.id;
}

/** The head a CI or feedback fix starts from: the one open pull request's recorded head (none for a conflict round, which works on the merge's files, or for several pull requests). */
function fixStartHead(workflow: WorkflowSnapshot): string | undefined {
  if (workflow.fixSource === undefined || workflow.fixSource === "conflict") return undefined;
  const open = (workflow.pullRequests ?? []).filter((entry) => entry.state === "OPEN" || entry.state === "UNKNOWN");
  return open.length === 1 ? open[0]!.headSha : undefined;
}

/**
 * Plan 6 Task 16: the coding run of a round Rovara decided itself on review comments. It is the owner's approval path with one difference: the approval it carries (and the worker presents to the
 * broker at start) is bound to Rovara's own decision and the autonomy it was made under, which the broker checks again when the worker starts. The run is accepted like any coding run, so its model key,
 * payer, step budget and limits are those of the task. The stored report and comments are read again, and a round that is not sound (any more) is not started: the dispatch is retried, never run.
 */
async function startAutomaticFeedbackRound(
  deps: DeveloperTaskRouteDependencies,
  task: DeveloperTaskRecord,
  workflow: WorkflowSnapshot,
  dispatchAccess: TaskAccess | undefined,
  actor: DeveloperCaller | undefined,
): Promise<"STARTED" | "DUPLICATE" | "STALE"> {
  const decision = workflow.feedbackDecisions?.at(-1);
  const review = workflow.feedbackReview;
  if (decision?.actorRole !== "ROVARA_AUTONOMY" || decision.autonomy === undefined || decision.decision !== "APPROVE" || review?.status !== "APPROVED"
    || review.reviewRef.sha256 !== decision.reviewDigest || workflow.candidate === undefined || workflow.programStepId === undefined) return "STALE";
  const plan = await planAutomaticFeedbackRound(deps, task);
  if (plan === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the review comments Rovara decided to fix can't be read as they were");
  const receivedAt = iso(deps);
  const approval: WorkflowFeedbackApprovalBinding = {
    taskId: task.taskId, requestId: decision.requestId, ownerId: task.ownerKey, decisionWorkflowRevision: decision.workflowRevision, activeWorkflowRevision: workflow.revision + 1,
    reviewDigest: decision.reviewDigest, proposalDigest: decision.proposalDigest, bundleDigests: decision.bundleDigests, candidateDigest: workflow.candidate.digest,
    selectedFindingIds: decision.selectedFindingIds, selectedCommentIds: decision.selectedCommentIds, autonomy: decision.autonomy,
    ...(decision.ciFailures === undefined ? {} : { ciFailuresDigest: decision.ciFailures.digest }),
  };
  // The check changes the findings propose are Rovara's to apply here exactly as they are when an owner approves, and they stand for this fix and every later step.
  let base: WorkflowSnapshot;
  try {
    base = applyWorkflowFeedbackCheckChanges(workflow, plan.checkChanges);
  } catch (error) {
    if (error instanceof WorkflowTransitionError) throw agentXError("CONFIG_INVALID", error.message);
    throw error;
  }
  const next: WorkflowSnapshot = { ...base, revision: workflow.revision + 1, state: "RUNNING", feedbackDispatchApproval: approval, updatedAt: receivedAt };
  const ciBlock = await feedbackCiBlock(deps, task, decision.ciFailures);
  const prompt = withTestRule(feedbackFixPrompt({ requestId: decision.requestId, reviewDigest: decision.reviewDigest, proposalDigest: decision.proposalDigest, selected: plan.selected,
    byRovara: true, ...(ciBlock === undefined ? {} : { ciBlock }) }), next);
  const accepted = await deps.actions.acceptTask(developerTaskIdentity(task, deps.orgId), task.workspaceId, { requestId: decision.requestId, conversationId: task.conversationId, prompt }, (operation) => [
    { Update: {
      TableName: deps.tableName, Key: taskKey(task.taskId),
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :implement AND workflow.#state = :ready AND workflow.feedbackReview.#reviewStatus = :approved AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#stage": "stage", "#state": "state", "#reviewStatus": "status" },
      ExpressionAttributeValues: { ":workflow": next, ":now": receivedAt, ":revision": workflow.revision, ":implement": "IMPLEMENT", ":ready": "READY", ":approved": "APPROVED" },
    } },
    putNew(turnTable(deps), aiToolTurn({
      party: actor === undefined ? partyOfTask(task) : partyOfTaskActor(task, actor), turnId: randomUUID(), action: "continue", phase: "accepted", outcome: "accepted", receivedAt, finishedAt: iso(deps),
      request: "Fix review comments", response: `Rovara started fixing the review comments on its own as operation ${operation.id}.`, operationId: operation.id,
    })),
    ...(dispatchAccess === undefined ? [] : [accessFence(deps, dispatchAccess)]),
  ], { sharedTask: task.shared === true, workflowMode: "IMPLEMENT", ...selectedCheckCommands(next), ...taskBaseOption(task, next), programStepId: workflow.programStepId,
    workflowFix: { source: "feedback" }, workflowFeedbackApproval: approval });
  return accepted.duplicate ? "DUPLICATE" : "STARTED";
}

/** When the watchdog row of an Understand that started at `startedAt` is due: its time limit and a short grace for the result to arrive. */
export function understandWatchdogDueAt(startedAt: string): string {
  return new Date(Date.parse(startedAt) + (UNDERSTAND_TIMEOUT_MINUTES + UNDERSTAND_WATCHDOG_GRACE_MINUTES) * 60_000).toISOString();
}
