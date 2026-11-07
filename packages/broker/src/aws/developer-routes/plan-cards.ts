// Decision journey slice 2: the requirements and the coding plan as decision cards, decided on the card (Approve, Request changes) through the ONE workflow decision Slack, MCP and the task page use
// (`decideTaskWorkflow`), so the authority, the replay rule, the work breakdown binding and the run limit are its own. Nothing here decides who may act.
//   source   the caller's own tasks waiting on their requirements or their coding plan (PLAN_REVIEW/WAITING), one card each. A design waits on the design review's card (`design-review.ts`); a plan
//            held for an E2E correction has no card (its Approve is refused until the plan is corrected; the task page says why).
//   approve  low and medium through the card route; HIGH on the card on the task page, where the handler asks for a browser session and a recent sign-in itself (REAUTH_REQUIRED otherwise).
//            The coding plan's card carries the run limit approving sets: a raise is ticked on the card and sent as `acknowledgedRunLimitUsd` (the workflow decision refuses a raise without it).
//   request changes   the workflow decision's REQUEST_CHANGES with the person's reason, for requirements, a coding plan and a design alike (a design's Approve stays the design review's).
// The requirements and design pair card (project.ts `pairCards`) forms only when both documents wait at once; today's Full flow asks for them one after the other, so this source never yields both.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { DECISION_APPROVE_TAKES, DECISION_PLAN_COMMENTS_MAX, DECISION_PLAN_QUESTIONS_MAX, PER_TASK_BUDGET_USD, agentXError, planClaimCount, redactText, taskGraphDigest, taskGraphOrder, type DecisionPlanChoices, type PlanDocument, type WorkflowArtifact, type WorkflowSnapshot } from "@agentx/contracts";
import { listSuggestions, listTaskComments, openCommentsFor } from "../../developer/page-comments.js";
import { isE2EPlanCorrectionBlockReason, taskKey, tryEffectiveTaskOwner, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { planFactsOf } from "../../decisions/plan-risk.js";
import { AgentSessionStore } from "../../agent-sessions/store.js";
import { taskOpenPath } from "../../decisions/open-path.js";
import type { DecisionItem } from "../../decisions/project.js";
import { perform, type KindHandler } from "../../decisions/performer.js";
import type { PerformInput, PerformOutcome } from "../../decisions/routes.js";
import { withCardDecideGrade } from "./card-decide-grade.js";
import { loadWorkflowDocument } from "../../developer/plan-artifacts.js";
import { planRunLimit } from "../../spend/estimate.js";
import { estimateDependencies } from "../developer-tasks/common.js";
import { decideTaskWorkflow } from "../developer-tasks/decide.js";
import { developerTaskRouteDependencies } from "./dependencies.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

const OWN_TASKS_MAX = 50;
type DocumentType = "requirements" | "plan" | "design";

/** Said on the card about what an Approve here takes (as Slack's Approve does): the plan's recommended answers and the open comments. */
const TAKES = DECISION_APPROVE_TAKES;

/** The document a task waits on, by the workflow's own fields. */
export function waitingDocument(workflow: Pick<WorkflowSnapshot, "stage" | "state" | "path" | "reviewPhase">): DocumentType | undefined {
  if (workflow.stage !== "PLAN_REVIEW" || workflow.state !== "WAITING") return undefined;
  if (workflow.path !== "FULL") return "plan";
  return workflow.reviewPhase === "REQUIREMENTS" ? "requirements" : workflow.reviewPhase === "DESIGN" ? "design" : "plan";
}

const latestOf = (workflow: WorkflowSnapshot, type: DocumentType): WorkflowArtifact | undefined => workflow.artifacts.filter((artifact) => artifact.type === type).at(-1);

async function ownTaskIds(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<string[]> {
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": `DEVELOPER#${caller.developerId}`, ":prefix": "TASK#" }, ScanIndexForward: false, Limit: OWN_TASKS_MAX, ConsistentRead: true,
  })) as { Items?: Array<{ taskId?: string; orgId?: string; status?: string }> };
  return (response.Items ?? []).filter((row) => row.orgId === caller.orgId && row.status !== "CLOSED" && typeof row.taskId === "string").map((row) => row.taskId!);
}

async function loadTask(deps: DeveloperRouteDependencies, taskId: string): Promise<DeveloperTaskRecord | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(taskId), ConsistentRead: true }))) as { Item?: DeveloperTaskRecord }).Item;
}

/** The task's page: its own session when the record has it, a chain step's through the store, else its project. */
export async function taskPagePathOf(deps: DeveloperRouteDependencies, orgId: string, task: DeveloperTaskRecord): Promise<string> {
  if (task.sessionId !== undefined || deps.agentSessions === undefined) return taskOpenPath(task);
  try {
    const session = await new AgentSessionStore({ documentClient: deps.documentClient, tableName: deps.tableName } as never).getForTask(orgId, task);
    return taskOpenPath({ project: task.project, ...(session === undefined ? {} : { sessionId: session.sessionId }) });
  } catch { return taskOpenPath(task); }
}

const reader = (deps: DeveloperRouteDependencies, caller: DeveloperCaller) => {
  const actions = developerTaskRouteDependencies(deps, caller).actions;
  return (objectKey: string, maxBytes: number) => actions.readArtifact(objectKey, maxBytes).catch(() => undefined);
};

/** The card item for one task, or undefined when it waits on nothing a card here decides. */
async function itemOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller, task: DeveloperTaskRecord): Promise<DecisionItem | undefined> {
  const workflow = task.workflow;
  // The task's owner now (after a take-over, the taker, whose own task index lists it): the workflow decision is theirs.
  if (workflow === undefined || task.orgId !== caller.orgId || task.closedAt !== undefined || tryEffectiveTaskOwner(task)?.developerId !== caller.developerId) return undefined;
  const type = waitingDocument(workflow);
  // A design under design review waits on that review's card (design-review.ts); a design without one is decided here (OWNER DECISION 7: the old review page was its browser place).
  if (type === undefined || (type === "design" && workflow.designReview !== undefined) || isE2EPlanCorrectionBlockReason(workflow.blockReason)) return undefined;
  const artifact = latestOf(workflow, type);
  if (artifact === undefined) return undefined;
  const loaded = await loadWorkflowDocument(reader(deps, caller), artifact, {}).catch(() => undefined);
  const claims = loaded?.format === "structured" ? planClaimCount(loaded.plan) : 0;
  const choices = await choicesOf(deps, task, type, artifact, loaded?.format === "structured" ? loaded.plan : undefined);
  const base = {
    subjectId: task.taskId, taskId: task.taskId, project: task.project, title: task.title, createdAt: workflow.updatedAt ?? new Date(deps.now()).toISOString(),
    openPath: await taskPagePathOf(deps, caller.orgId, task), contentVersion: artifact.sha256,
  };
  if (type === "requirements") return { ...base, kind: "approve_requirements", claims, ...(choices === undefined ? {} : { choices }) };
  if (type === "design") return { ...base, kind: "approve_design", files: planFactsOf(loaded, workflow).files, ...(choices === undefined ? {} : { choices }) };
  const estimate = task.runEstimate;
  let proposedUsd: number | undefined;
  try { proposedUsd = await planRunLimit(estimateDependencies(developerTaskRouteDependencies(deps, caller)), task); } catch { proposedUsd = estimate?.runLimitUsd; }
  // What the plan changes and how it is proved, read from the plan itself (`planFactsOf`): the tier the card shows is the one the workflow decision enforces. Unreadable: no chips, at least medium.
  const facts = planFactsOf(loaded, workflow);
  const breakdown = loaded?.format === "structured" ? workBreakdownLines(loaded.plan) : [];
  return {
    ...base, kind: "approve_plan", ...(choices === undefined ? {} : { choices }), path: workflow.path === "FULL" ? "full" : "quick", files: facts.files, claims, untestedClaims: facts.untestedClaims, ...(facts.unread ? { unread: true } : {}),
    ...(estimate === undefined ? {} : { cost: { lowUsd: estimate.lowUsd, highUsd: estimate.highUsd, ...(estimate.minutes === undefined ? {} : { minutes: estimate.minutes }) } }),
    // A task with no limit of its own runs on the per-task default: that is its current limit.
    ...(proposedUsd === undefined ? {} : { runLimit: { proposedUsd, currentUsd: task.budgetUsd ?? PER_TASK_BUDGET_USD } }),
    // OWNER DECISION 7 item 5: the work breakdown Approve binds to (its digest is worked out from this same document when the card is pressed), named part by part.
    details: [{ title: "What Approve takes", lines: [TAKES] }, ...(breakdown.length === 0 ? [] : [{ title: "Work breakdown", lines: breakdown }])],
  };
}

/** One plain line of at most `max` characters, redacted: model and person text on a card. */
const plain = (text: string, max: number): string => {
  const flat = redactText(text).replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  const characters = Array.from(flat);
  return characters.length <= max ? flat : `${characters.slice(0, max - 1).join("")}…`;
};

/** The work breakdown's parts in their order, as the plan names them (at most 20 lines). */
function workBreakdownLines(plan: PlanDocument): string[] {
  const graph = plan.workBreakdown;
  if (graph === undefined) return [];
  try {
    const byId = new Map(graph.items.map((item) => [item.id, item] as const));
    return taskGraphOrder(graph).slice(0, 20).map((id, index) => plain(`${String(index + 1)}. ${byId.get(id)?.title ?? id}`, 200)).filter((line) => line !== "");
  } catch { return []; }
}

/**
 * OWNER DECISION 7 items 1, 3 and 9: what the card offers beside Approve: the document's questions (with the suggestions people made on this version), the coding plan's optional checks, and the person comments
 * still open on the document (what the old review page offered). Read-only: the workflow decision checks every answer, check and comment again when the card is pressed. Undefined when nothing can be read.
 */
async function choicesOf(deps: DeveloperRouteDependencies, task: DeveloperTaskRecord, type: DocumentType, artifact: WorkflowArtifact, plan: PlanDocument | undefined): Promise<DecisionPlanChoices | undefined> {
  try {
    const [comments, suggestions] = await Promise.all([listTaskComments(deps, task.taskId), plan === undefined ? Promise.resolve([]) : listSuggestions(deps, task.taskId)]);
    const questions = (plan?.decisions ?? []).slice(0, DECISION_PLAN_QUESTIONS_MAX).map((decision) => {
      const suggested = suggestions.filter((suggestion) => suggestion.document === type && suggestion.version === artifact.version && suggestion.decisionId === decision.id && decision.options.some((option) => option.id === suggestion.optionId))
        .slice(0, 10).map((suggestion) => ({ optionId: suggestion.optionId, name: plain(suggestion.name, 80) || "Someone" }));
      return {
        id: decision.id, question: plain(decision.question, 500) || "A question", recommended: decision.recommended,
        options: decision.options.slice(0, 12).map((option) => ({ id: option.id, label: plain(option.label, 300) || option.id })), ...(suggested.length === 0 ? {} : { suggested }),
      };
    });
    const policy = task.workflow?.checkPolicy;
    const optionalChecks = type !== "plan" ? [] : (policy?.optional ?? []).slice(0, 20).map((check) => ({ id: check.id, label: plain(check.label, 200) || check.id, selected: (policy?.selectedOptionalIds ?? []).includes(check.id) }));
    const openComments = openCommentsFor(comments, type, artifact.version).slice(0, DECISION_PLAN_COMMENTS_MAX).map((comment) => ({ id: comment.commentId, excerpt: plain(comment.text, 200) || "A comment" }));
    return { questions, optionalChecks, openComments };
  } catch { return undefined; }
}

/** The requirements and coding plan cards of the caller's own tasks. A task that cannot be read is left out. */
export async function planCardItemsFor(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<DecisionItem[]> {
  const found: DecisionItem[] = [];
  for (const taskId of await ownTaskIds(deps, caller)) {
    try {
      const task = await loadTask(deps, taskId);
      const item = task === undefined ? undefined : await itemOf(deps, caller, task);
      if (item !== undefined) found.push(item);
    } catch { /* a task that cannot be read is not a card */ }
  }
  return found;
}

const TYPE_OF: Partial<Record<DecisionItem["kind"], DocumentType>> = { approve_requirements: "requirements", approve_plan: "plan", approve_design: "design" };

/** The task and the document the card was drawn from, as they are now; "stale" when the document moved on (a new version, a decision made elsewhere). */
async function current(deps: DeveloperRouteDependencies, caller: DeveloperCaller, input: PerformInput): Promise<{ task: DeveloperTaskRecord; workflow: WorkflowSnapshot; artifact: WorkflowArtifact } | "stale"> {
  const type = TYPE_OF[input.item.kind];
  const taskId = input.item.taskId;
  if (type === undefined || taskId === undefined) return "stale";
  const task = await loadTask(deps, taskId);
  const workflow = task?.workflow;
  if (task === undefined || workflow === undefined || task.orgId !== caller.orgId || waitingDocument(workflow) !== type) return "stale";
  const artifact = latestOf(workflow, type);
  // The card's content version starts with the document's digest (a design's adds what its review found, after a colon).
  if (artifact === undefined || !(input.item.contentVersion === artifact.sha256 || input.item.contentVersion.startsWith(`${artifact.sha256}:`))) return "stale";
  return { task, workflow, artifact };
}

/**
 * Approve and Request changes of a requirements or coding plan card. A HIGH card is approved on its card on the task page under the decide-grade sign-in (`withCardDecideGrade`: an email code from a clean
 * sign-in, as the member's own pool user, for this card, unused, within 10 minutes; security review 2026-11-06, which replaces the web session's freshness here), never by a token.
 */
export function planCardHandler(deps: DeveloperRouteDependencies, caller: DeveloperCaller, decideCookie?: string): KindHandler<DeveloperCaller> {
  return {
    approve: (who, input) => perform(async () => {
      const now = await current(deps, who, input);
      if (now === "stale") return { kind: "refused", reason: "stale" };
      if (input.card.risk !== "high") return approvePlan(deps, caller, who, input, now);
      if (who.browserSession !== true) throw agentXError("FORBIDDEN", "Decide this in the Rovara app.");
      return withCardDecideGrade(deps, who, decideCookie, { cardId: input.card.id, taskId: now.task.taskId, contentVersion: input.item.contentVersion, openPath: input.item.openPath },
        async () => ({ applied: true, result: await approvePlan(deps, caller, who, input, now, true) }));
    }),
    requestChanges: (who, input) => requestChanges(deps, who, input),
  };
}

async function approvePlan(deps: DeveloperRouteDependencies, caller: DeveloperCaller, who: DeveloperCaller, input: PerformInput, now: { task: DeveloperTaskRecord; workflow: WorkflowSnapshot; artifact: WorkflowArtifact }, decideGrade = false): Promise<PerformOutcome> {
      // The work breakdown the approval binds to is the one in the document the card was drawn from (the workflow decision checks it again).
      const loaded = now.artifact.type === "plan" ? await loadWorkflowDocument(reader(deps, caller), now.artifact, {}).catch(() => undefined) : undefined;
      const breakdown = loaded?.format === "structured" && loaded.plan.workBreakdown !== undefined ? taskGraphDigest(loaded.plan.workBreakdown) : undefined;
      // OWNER DECISION 7: the answers, optional checks, comments and note the person chose on the card go to the same workflow decision the old review page used, which checks each one.
      const plan = input.plan;
      await decideTaskWorkflow(developerTaskRouteDependencies(deps, who), who, now.task.taskId, {
        requestId: input.requestId, expectedRevision: now.workflow.revision, decision: "APPROVE", artifactDigest: now.artifact.sha256, reason: plan?.note ?? "Approved on its card in Rovara.",
        ...(breakdown === undefined ? {} : { workBreakdownDigest: breakdown }),
        ...(input.acknowledgedRunLimitUsd === undefined ? {} : { acknowledgedRunLimitUsd: input.acknowledgedRunLimitUsd }),
        ...(plan?.answers === undefined ? {} : { answers: plan.answers }),
        ...(plan?.selectedOptionalCheckIds === undefined ? {} : { selectedOptionalCheckIds: plan.selectedOptionalCheckIds }),
        ...(plan?.includedCommentIds === undefined ? {} : { includedCommentIds: plan.includedCommentIds }),
      }, { ...(decideGrade ? { decideGrade: true as const } : {}), ...(plan?.note === undefined ? {} : { note: plan.note }) });
      return { kind: "done" };
}

/** Request changes for any document card (requirements, coding plan, design): the workflow decision's REQUEST_CHANGES with the person's reason, as Slack and the task page send it. */
export function requestChanges(deps: DeveloperRouteDependencies, who: DeveloperCaller, input: PerformInput & { reason: string }) {
  return perform(async () => {
    const now = await current(deps, who, input);
    if (now === "stale") return { kind: "refused", reason: "stale" };
    await decideTaskWorkflow(developerTaskRouteDependencies(deps, who), who, now.task.taskId, {
      requestId: input.requestId, expectedRevision: now.workflow.revision, decision: "REQUEST_CHANGES", artifactDigest: now.artifact.sha256, reason: input.reason,
      // OWNER DECISION 7: the review comments the person sent back with the reason (the workflow decision checks each is still open on this document).
      ...(input.plan?.includedCommentIds === undefined ? {} : { includedCommentIds: input.plan.includedCommentIds }),
    }, { note: input.reason });
    return { kind: "done" };
  });
}
