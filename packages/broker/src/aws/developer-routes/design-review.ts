// Design review stage, DR7 slice C: the routes and the decision cards of a design under review, and the ports the design review's handlers need. The logic is in `design-review/*` (the handlers decide EVERYTHING: who may,
// what the friction is, whether the card is still the card); this file only reads the broker's own records fresh for the request and commits what a handler decided, in one transaction.
//   POST /v1/app/tasks/{id}/design-review/first            {requestId}                       Design first (any project member who may start work; the lock and the switch are applied)
//   POST /v1/app/tasks/{id}/design-review/skip             {requestId}                       Skip (the skip rules for THIS caller: high risk needs the high-risk approver)
//   POST /v1/app/tasks/{id}/design-review/spend/{choice}   {requestId, shownDigest}          one choice on the cost card (lower-tier | raise-cap | run-unpriced | skip), `designSpendChoiceHandler`
//   POST /v1/app/tasks/{id}/design-review/answers          {requestId, answers}              the question card's answers, `designAnswersHandler`
//   POST /v1/app/tasks/{id}/design-review/retry            {requestId}                       the one-tap Retry of a review that did not run, `retryDesignReviewNotRun`
//   POST /v1/app/tasks/{id}/design-review/approve          {requestId, shownDigest, reason?} the confirmation page of a HIGH-risk design: a browser session, the same `designApproveHandler` as the card
// A task with no `designReview` answers as a missing task answers, so with the feature off none of these exists.
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  ModelSelectionSchema, WorkflowTransitionError, agentXError, enableDesignReview, retryDesignReviewNotRun, DESIGN_ACTIONS_NAME_MAX, plainOneLine, type DesignActionsView, type DesignReason, type ModelIdentifier, type OrgId, type WorkflowSnapshot,
} from "@agentx/contracts";
import { StatusReply } from "../status-reply.js";
import { effectiveTaskOwner, taskKey, tryEffectiveTaskOwner, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { listProjectMembers } from "../../org/project-members.js";
import { AgentSessionStore } from "../../agent-sessions/store.js";
import { DECISION_REFUSALS, type DecisionCaller } from "../../decisions/routes.js";
import { projectDecisionCards, type DecisionItem } from "../../decisions/project.js";
import { dynamoDecisionStore } from "../../decisions/store.js";
import { designAnswersCommitItems, designAnswersHandler, type DesignAnswersPorts } from "../../design-review/answers.js";
import { highRiskApprovers, maySkipDesignReview, type SkipRefusal } from "../../design-review/approval.js";
import { designApproveHandler, type DesignApprovePorts } from "../../design-review/approve-handler.js";
import { designApproveItem, designCardFactsOf, designQuestionsItem } from "../../design-review/card-source.js";
import { readDesignMeta } from "@agentx/contracts";
import { readEffectiveDesignReview } from "../../design-review/setting.js";
import { designSpendChoiceHandler, designSpendGateFor, designSpendItemFor, type DesignSpendChoiceName, type DesignSpendContext, type DesignSpendPorts } from "../../design-review/spend-choice.js";
import { designSpendCommitItems } from "../../design-review/spend-follow.js";
import { spendEstimatesOf } from "../../design-review/spend-estimates.js";
import { designReviewEnabledFor } from "../../design-review/switch.js";
import { freshSignInOf, readDesignDirectory, readDesignTouches, readLatestDesignText, type DesignFactsDeps } from "../../design-review/route-facts.js";
import { WORKFLOW_NO_CANDIDATE_DIGEST, isConditional, workflowDispatchItem } from "../broker-shared.js";
import { commitDesignApproval, membershipFenceItem } from "../developer-tasks/design-decision.js";
import { TASK_ID, get } from "../developer-tasks/common.js";
import type { DeveloperTaskRouteDependencies } from "../developer-tasks/types.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { developerTaskRouteDependencies } from "./dependencies.js";
import { jsonBody } from "./organization.js";
import { signInStoreOf } from "./common.js";
import { isInfraPath } from "../../decisions/risk-tier.js";
import { loadWorkflowDocument } from "../../developer/plan-artifacts.js";
import { projectMembersDepsOf } from "./project-list.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const DESIGN_REVIEW_ROUTE = /^\/v1\/app\/tasks\/([0-9a-f-]{36})\/design-review\/(first|skip|answers|retry|approve|spend\/(?:lower-tier|raise-cap|run-unpriced|skip))$/u;
export const isDesignReviewPath = (pathname: string): boolean => DESIGN_REVIEW_ROUTE.test(pathname);

const SPEND_CHOICES: Readonly<Record<string, DesignSpendChoiceName>> = { "lower-tier": "lower_tier", "raise-cap": "raise_cap", "run-unpriced": "run_unpriced", skip: "skip" };
const GONE = "This decision is no longer waiting for you.";
const Request = z.string().uuid();

interface Env {
  deps: DeveloperRouteDependencies;
  caller: DeveloperCaller;
  task: DeveloperTaskRouteDependencies;
  facts: DesignFactsDeps;
}

function envOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Env {
  return {
    deps, caller, task: developerTaskRouteDependencies(deps, caller),
    facts: { documentClient: deps.documentClient, tableName: deps.tableName, signInTableName: deps.developer.signInTableName, now: deps.now, edition: deps.editionPolicy, members: projectMembersDepsOf(deps) },
  };
}

interface Loaded { task: DeveloperTaskRecord; workflow: WorkflowSnapshot }

/** The task, only when it is this org's, open, and carries a design review. Anything else is "no longer waiting". */
async function loadDesignTask(env: Env, taskId: string): Promise<Loaded | undefined> {
  if (!TASK_ID.test(taskId)) return undefined;
  const task = await get<DeveloperTaskRecord>(env.task, taskKey(taskId));
  if (task === undefined || task.orgId !== env.caller.orgId || task.closedAt !== undefined || task.workflow === undefined || task.workflow.designReview === undefined) return undefined;
  return { task, workflow: task.workflow };
}

const read = (env: Env) => (objectKey: string, maxBytes: number): Promise<string | undefined> => env.task.actions.readArtifact(objectKey, maxBytes).catch(() => undefined);
const nowIso = (env: Env): string => new Date(env.deps.now()).toISOString();

async function sessionPathOf(env: Env, task: DeveloperTaskRecord): Promise<string> {
  const sessions = env.deps.agentSessions;
  if (sessions === undefined) return `/app/tasks/${task.taskId}`;
  try {
    const session = await new AgentSessionStore({ documentClient: env.deps.documentClient, tableName: env.deps.tableName } as never).getForTask(env.caller.orgId, task);
    return session === undefined ? `/app/tasks/${task.taskId}` : `/app/sessions/${session.sessionId}`;
  } catch { return `/app/tasks/${task.taskId}`; }
}

/** What the reviewing of this task read, shared by every handler. */
async function factsOf(env: Env, loaded: Loaded) {
  const { task, workflow } = loaded;
  const [effective, directory, touches] = await Promise.all([
    readEffectiveDesignReview(env.facts, env.caller.orgId, task.project), readDesignDirectory(env.facts, env.caller.orgId, task.project), readDesignTouches(workflow, read(env)),
  ]);
  return { setting: effective.setting, directory, touches, edition: env.facts.edition };
}

const decisionStoreOf = (env: Env) => dynamoDecisionStore({ documentClient: env.deps.documentClient, tableName: env.deps.tableName, now: env.deps.now });

// ---- the approve card

const waitingOnDesign = (workflow: WorkflowSnapshot): boolean => workflow.stage === "PLAN_REVIEW" && workflow.state === "WAITING" && workflow.reviewPhase === "DESIGN" && workflow.designReview !== undefined;

/** The paths the design names (its §6 repositories and services), for the card. The meta block is read from the design the person is deciding. */
async function filesOf(env: Env, workflow: WorkflowSnapshot): Promise<string[]> {
  const text = await readLatestDesignText(workflow, read(env));
  const meta = text === undefined ? undefined : readDesignMeta(text);
  return meta?.ok === true ? [...meta.meta.repositories, ...meta.meta.services] : [];
}

async function approveItemOf(env: Env, loaded: Loaded, touches: readonly DesignReason[]): Promise<DecisionItem | undefined> {
  const { task, workflow } = loaded;
  const design = workflow.artifacts.filter((artifact) => artifact.type === "design").at(-1);
  if (!waitingOnDesign(workflow) || design === undefined || workflow.designReview === undefined) return undefined;
  return designApproveItem({
    subjectId: task.taskId, taskId: task.taskId, project: task.project, title: task.title, createdAt: workflow.updatedAt ?? nowIso(env), openPath: await sessionPathOf(env, task),
    contentVersion: design.sha256, files: await filesOf(env, workflow), review: designCardFactsOf(workflow.designReview, touches),
  });
}

function approvePortsOf(env: Env): DesignApprovePorts<DeveloperCaller> {
  return {
    async context(caller, item) {
      const loaded = item.taskId === undefined ? undefined : await loadDesignTask(env, item.taskId);
      if (loaded === undefined || !waitingOnDesign(loaded.workflow)) return undefined;
      const facts = await factsOf(env, loaded);
      return { requesterId: loaded.task.developerId, setting: facts.setting, edition: facts.edition, directory: facts.directory, freshSignIn: await freshSignInOf(env.facts, caller) };
    },
    // Company locks on a card's tier are not stored anywhere yet: the tiers are the projector's own (as `decisionRouteDepsOf` says).
    locks: async () => ({}),
    store: decisionStoreOf(env),
    nowMs: () => env.deps.now(),
    confirmUrl: () => undefined,
    async commit(caller, write) {
      const loaded = write.taskId === undefined ? undefined : await loadDesignTask(env, write.taskId);
      if (loaded === undefined) return "stale";
      const owner = effectiveTaskOwner(loaded.task);
      const ownerCaller: DeveloperCaller = { ...caller, developerId: owner.developerId, name: owner.name };
      return commitDesignApproval(developerTaskRouteDependencies(env.deps, ownerCaller), ownerCaller, { developerId: caller.developerId, name: caller.name }, write);
    },
  };
}

/** The `approve_design` handler for the decision cards' performer. Registered only while the design review switch is on (the caller decides); a task with no design review is refused by the handler's own context. */
export const designApproveHandlerFor = (deps: DeveloperRouteDependencies, caller: DeveloperCaller) => designApproveHandler(approvePortsOf(envOf(deps, caller)));

// ---- the spend card

async function modelsOf(env: Env, task: DeveloperTaskRecord): Promise<{ reviewer: ModelIdentifier | undefined; planner: ModelIdentifier | undefined }> {
  const response = await env.deps.documentClient.send(new QueryCommand({
    TableName: env.deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": `WORKSPACE#${task.workspaceId}`, ":prefix": "OPERATION#" }, ConsistentRead: true,
  })).catch(() => ({ Items: [] })) as { Items?: Array<Record<string, unknown>> };
  const latest = (mode: string) => {
    const model = ModelSelectionSchema.safeParse((response.Items ?? []).filter((item) => item["workflowMode"] === mode).sort((left, right) => String(left["createdAt"]).localeCompare(String(right["createdAt"]))).at(-1)?.["model"]);
    return model.success ? { provider: model.data.provider, modelId: model.data.modelId } : undefined;
  };
  const planner = latest("PLAN");
  return { reviewer: latest("PLAN_CRITIQUE") ?? planner, planner };
}

async function spendContextOf(env: Env, caller: DecisionCaller, loaded: Loaded): Promise<DesignSpendContext | undefined> {
  const { task, workflow } = loaded;
  const review = workflow.designReview;
  const ports = env.task.designReview;
  if (review === undefined || ports === undefined || review.status !== "waiting_cost" || workflow.stage !== "PLAN_CRITIQUE" || workflow.state !== "WAITING") return undefined;
  const facts = await factsOf(env, loaded);
  const models = await modelsOf(env, task);
  const estimates = spendEstimatesOf({ review, reviewerModel: models.reviewer, plannerModel: models.planner, price: ports.price });
  return {
    taskId: task.taskId, requesterId: task.developerId, tier: review.tier, setting: facts.setting, taskCapUsd: review.capUsd ?? facts.setting.capUsdPerTask, spentUsd: review.spentUsd,
    capCeilingUsd: await ports.capCeilingUsd(caller.orgId), estimate: estimates.estimate, lowerTier: estimates.lowerTier, reasons: review.reasons, touches: facts.touches, directory: facts.directory, edition: facts.edition,
    freshSignIn: await freshSignInOf(env.facts, env.caller), revision: String(workflow.revision),
    card: { subjectId: task.taskId, project: task.project, title: task.title, createdAt: workflow.updatedAt ?? nowIso(env), openPath: await sessionPathOf(env, task), contentVersion: `hold-${String(workflow.revision)}` },
  };
}

function spendPortsOf(env: Env): DesignSpendPorts<DeveloperCaller> {
  return {
    async context(caller, taskId) {
      const loaded = await loadDesignTask(env, taskId);
      return loaded === undefined ? undefined : spendContextOf(env, caller, loaded);
    },
    locks: async () => ({}),
    store: decisionStoreOf(env),
    now: () => env.deps.now(),
    async commit(caller, write) {
      const loaded = await loadDesignTask(env, write.taskId);
      if (loaded === undefined || String(loaded.workflow.revision) !== write.revision) return "stale";
      const now = nowIso(env);
      let items;
      try { items = designSpendCommitItems({ tableName: env.deps.tableName, taskId: write.taskId, workflow: loaded.workflow, write: { actorId: write.actorId, applied: write.applied }, now }).items; } catch (error) {
        if (error instanceof WorkflowTransitionError) return "stale";
        throw error;
      }
      // The request's own record is in the SAME transaction: a repeat of this request finds it and is the same choice, and nothing is written twice.
      const marker = { pk: `DEVTASK#${write.taskId}`, sk: `DESIGN_SPEND#${write.requestId}` };
      try {
        await env.task.actions.transact([...items, { Put: { TableName: env.deps.tableName, Item: { ...marker, entityType: "DESIGN_SPEND_CHOICE", choice: write.applied.choice, actorId: write.actorId, at: now }, ConditionExpression: "attribute_not_exists(pk)" } }, membershipFenceItem(env.deps.tableName, caller.orgId, write.fence)] as never);
      } catch (error) {
        if (!isConditional(error) && (error as { name?: string }).name !== "TransactionCanceledException") throw error;
        const earlier = await get<{ choice?: string }>(env.task, marker);
        return earlier?.choice === write.applied.choice ? "done" : "stale";
      }
      return "done";
    },
  };
}

// ---- the question card

function answersPortsOf(env: Env): DesignAnswersPorts<DeveloperCaller> {
  return {
    async context(caller, taskId) {
      const loaded = await loadDesignTask(env, taskId);
      if (loaded === undefined) return undefined;
      const facts = await factsOf(env, loaded);
      return { taskId, requesterId: loaded.task.developerId, workflow: loaded.workflow, setting: facts.setting, touches: facts.touches, directory: facts.directory, edition: facts.edition };
    },
    now: () => env.deps.now(),
    async commit(caller, write) {
      const now = nowIso(env);
      const commit = (() => { try { return designAnswersCommitItems({ tableName: env.deps.tableName, taskId: write.taskId, workflow: write.workflow, answers: write.answers, actorId: write.actorId, now }); } catch { return undefined; } })();
      if (commit === undefined) return "stale";
      const marker = { pk: `DEVTASK#${write.taskId}`, sk: `DESIGN_ANSWERS#${write.requestId}` };
      try {
        await env.task.actions.transact([...commit.items, { Put: { TableName: env.deps.tableName, Item: { ...marker, entityType: "DESIGN_ANSWERS", actorId: write.actorId, at: now }, ConditionExpression: "attribute_not_exists(pk)" } }] as never);
      } catch (error) {
        if (!isConditional(error) && (error as { name?: string }).name !== "TransactionCanceledException") throw error;
        return (await get(env.task, marker)) !== undefined ? "done" : "stale";
      }
      return "done";
    },
  };
}

// ---- the decision cards: what the caller's own tasks put on the list

const ROWS_MAX = 50;

/** The design review's cards for the caller's own tasks: the design to approve, the cost question (built for THIS person: only the choices they may make) and the questions to answer. Empty while no task carries a design review. */
export async function designReviewItemsFor(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<DecisionItem[]> {
  const env = envOf(deps, caller);
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": `DEVELOPER#${caller.developerId}`, ":prefix": "TASK#" }, ScanIndexForward: false, Limit: ROWS_MAX, ConsistentRead: true,
  })) as { Items?: Array<{ taskId?: string; orgId?: string; status?: string }> };
  const found: DecisionItem[] = [];
  for (const row of response.Items ?? []) {
    if (row.orgId !== caller.orgId || row.status === "CLOSED" || typeof row.taskId !== "string") continue;
    try {
      const loaded = await loadDesignTask(env, row.taskId);
      if (loaded === undefined || tryEffectiveTaskOwner(loaded.task)?.developerId !== caller.developerId) continue;
      const { workflow } = loaded;
      const review = workflow.designReview!;
      if (waitingOnDesign(workflow)) {
        const item = await approveItemOf(env, loaded, (await factsOf(env, loaded)).touches);
        if (item !== undefined) found.push(item);
      } else if (review.status === "waiting_cost") {
        const context = await spendContextOf(env, caller, loaded);
        if (context === undefined) continue;
        const { gate } = designSpendGateFor(context, caller.developerId);
        if (gate.kind === "ask") found.push(designSpendItemFor(context, gate));
      } else if (review.status === "waiting_answers" && workflow.stage === "PLAN" && workflow.state === "WAITING") {
        const round = review.rounds.at(-1);
        const facts = await factsOf(env, loaded);
        const item = round?.questions === undefined ? undefined : designQuestionsItem({
          subjectId: loaded.task.taskId, taskId: loaded.task.taskId, project: loaded.task.project, title: loaded.task.title, createdAt: review.waiting?.since ?? workflow.updatedAt ?? nowIso(env), openPath: await sessionPathOf(env, loaded.task),
          contentVersion: `q-${String(workflow.revision)}`, designTitle: loaded.task.title, questions: round.questions,
          packetItems: round.reviewers.flatMap((run) => run.packet.map((entry) => ({ kind: entry.kind, ref: entry.ref, commitOrFetchedAt: entry.commitOrFetchedAt, digest: entry.digest }))),
        });
        // Only a person who may answer sees the card (the handler checks again on the press).
        if (item !== undefined && facts.directory.people.complete) found.push(item);
      }
    } catch { /* a task that cannot be read is not a card */ }
  }
  return found;
}

// ---- Design first, Skip, Retry

const SKIP_WORDS: Record<SkipRefusal, string> = {
  skip_not_allowed: "This project doesn't allow skipping design review.", not_a_member: "You can't decide this.", high_risk_approver_only: "Only the design approver can skip a high-risk design review.",
  eligibility_unavailable: "Who may skip can't be worked out right now.", group_not_available: "Who may skip can't be worked out right now.", no_high_risk_approver: "Who may skip can't be worked out right now.",
};

const memberOf = (directory: { projectMemberIds: readonly string[]; notApproverIds: readonly string[]; people: { eligibleIds: readonly string[] } }, id: string): boolean => {
  const lower = id.toLowerCase();
  const has = (list: readonly string[]): boolean => list.some((entry) => entry.toLowerCase() === lower);
  return (has(directory.projectMemberIds) || has(directory.people.eligibleIds)) && !has(directory.notApproverIds);
};

/** The assessment's reasons, as Understand read them (fixed codes). */
const reasonsOf = (workflow: WorkflowSnapshot): DesignReason[] => {
  const assessment = workflow.intent?.assessment;
  return assessment !== undefined && assessment.kind === "ready" ? [...(assessment.design?.reasons ?? [])] : [];
};

async function transactWorkflow(env: Env, loaded: Loaded, next: WorkflowSnapshot, extra: unknown[], expect: { stage: string; states: readonly string[] }): Promise<void> {
  const { task, workflow } = loaded;
  const now = nowIso(env);
  const states = expect.states.map((_, index) => `workflow.#state = :s${String(index)}`);
  try {
    await env.task.actions.transact([{ Update: {
      TableName: env.deps.tableName, Key: taskKey(task.taskId), UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ConditionExpression: `workflow.revision = :revision AND workflow.#stage = :stage AND (${states.join(" OR ")}) AND attribute_not_exists(closedAt)`,
      ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
      ExpressionAttributeValues: { ":workflow": next, ":now": now, ":revision": workflow.revision, ":stage": expect.stage, ...Object.fromEntries(expect.states.map((state, index) => [`:s${String(index)}`, state])) },
    } }, ...extra] as never);
  } catch (error) {
    if (isConditional(error) || (error as { name?: string }).name === "TransactionCanceledException") throw agentXError("CHANGE_STALE", "This changed since you loaded it. Reload to see the current version.");
    throw error;
  }
}

async function designFirst(env: Env, taskId: string): Promise<{ outcome: "done" }> {
  if (!TASK_ID.test(taskId)) throw agentXError("NOT_FOUND", GONE);
  const task = await get<DeveloperTaskRecord>(env.task, taskKey(taskId));
  if (task === undefined || task.orgId !== env.caller.orgId || task.closedAt !== undefined || task.workflow === undefined || !designReviewEnabledFor(task.project)) throw agentXError("NOT_FOUND", GONE);
  const loaded: Loaded = { task, workflow: task.workflow };
  const { workflow } = loaded;
  const effective = await readEffectiveDesignReview(env.facts, env.caller.orgId, task.project);
  const directory = await readDesignDirectory(env.facts, env.caller.orgId, task.project);
  if (!memberOf(directory, env.caller.developerId)) throw agentXError("NOT_FOUND", GONE);
  // A repeat of the same press: design first is already on, asked by this person.
  if (workflow.designReview?.decidedBy === "person" && workflow.designReview.startedBy?.actorId === env.caller.developerId) return { outcome: "done" };
  if (workflow.designReview !== undefined) throw agentXError("CONFIG_INVALID", "Design review is already on for this task.");
  const now = nowIso(env);
  let next: WorkflowSnapshot;
  try {
    next = enableDesignReview(workflow, { expectedRevision: workflow.revision, now, start: { decidedBy: "person", reasons: reasonsOf(workflow), tier: effective.setting.tier, capUsd: effective.setting.capUsdPerTask, by: { actorId: env.caller.developerId } } });
  } catch (error) {
    if (error instanceof WorkflowTransitionError) throw agentXError("CONFIG_INVALID", `Design first can't be added at this step: ${error.message}.`);
    throw error;
  }
  // The task goes back to planning on the Full path; the planner's turn is due at the new revision.
  const due = next.stage === "PLAN" && next.state === "READY" ? [workflowDispatchItem(env.deps.tableName, task.taskId, next.revision, "PLAN", WORKFLOW_NO_CANDIDATE_DIGEST, now)] : [];
  await transactWorkflow(env, loaded, next, due, workflow.stage === "PLAN_REVIEW" ? { stage: "PLAN_REVIEW", states: ["WAITING"] } : { stage: "PLAN", states: ["READY"] });
  return { outcome: "done" };
}

async function skip(env: Env, taskId: string, requestId: string): Promise<{ outcome: "done" }> {
  const loaded = await loadDesignTask(env, taskId);
  if (loaded === undefined) throw agentXError("NOT_FOUND", GONE);
  const { task, workflow } = loaded;
  const review = workflow.designReview!;
  if (review.decidedBy === "person_skip" && review.skippedBy?.actorId === env.caller.developerId) return { outcome: "done" };
  const facts = await factsOf(env, loaded);
  const verdict = maySkipDesignReview({ setting: facts.setting, reasons: review.reasons, touches: facts.touches, skipperId: env.caller.developerId, directory: facts.directory, edition: facts.edition });
  if (!verdict.ok) throw agentXError(verdict.code === "not_a_member" ? "NOT_FOUND" : "FORBIDDEN", verdict.code === "not_a_member" ? GONE : SKIP_WORDS[verdict.code]);
  let commit;
  try { commit = designSpendCommitItems({ tableName: env.deps.tableName, taskId, workflow, write: { actorId: env.caller.developerId, applied: { choice: "skip" } }, now: nowIso(env) }); } catch (error) {
    if (error instanceof WorkflowTransitionError) throw agentXError("CONFIG_INVALID", "Design review can't be skipped at this step.");
    throw error;
  }
  void task; void requestId;
  try { await env.task.actions.transact(commit.items as never); } catch (error) {
    if (isConditional(error) || (error as { name?: string }).name === "TransactionCanceledException") throw agentXError("CHANGE_STALE", "This changed since you loaded it. Reload to see the current version.");
    throw error;
  }
  return { outcome: "done" };
}

async function retryNotRun(env: Env, taskId: string): Promise<{ outcome: "done" }> {
  const loaded = await loadDesignTask(env, taskId);
  if (loaded === undefined) throw agentXError("NOT_FOUND", GONE);
  const { workflow } = loaded;
  const facts = await factsOf(env, loaded);
  if (!memberOf(facts.directory, env.caller.developerId)) throw agentXError("NOT_FOUND", GONE);
  const now = nowIso(env);
  let next: WorkflowSnapshot;
  try { next = retryDesignReviewNotRun(workflow, { expectedRevision: workflow.revision, by: { actorId: env.caller.developerId }, now }); } catch (error) {
    if (error instanceof WorkflowTransitionError) throw agentXError("CONFIG_INVALID", "Design review can't be retried at this step.");
    throw error;
  }
  const due = next.stage === "PLAN_CRITIQUE" && next.state === "READY" ? [workflowDispatchItem(env.deps.tableName, taskId, next.revision, "CRITIQUE", WORKFLOW_NO_CANDIDATE_DIGEST, now)] : [];
  await transactWorkflow(env, loaded, next, due, { stage: "PLAN_REVIEW", states: ["WAITING"] });
  return { outcome: "done" };
}

// ---- the high-risk confirmation page

async function approveOnPage(env: Env, taskId: string, body: { requestId: string; shownDigest: string; reason?: string | undefined }): Promise<StatusReply> {
  // The confirmation page is a browser's: a token (an AI tool) never decides a design on a click, as a token never merges one.
  if (env.caller.browserSession !== true) throw agentXError("FORBIDDEN", "Decide this in the Rovara app.");
  const loaded = await loadDesignTask(env, taskId);
  if (loaded === undefined) throw agentXError("NOT_FOUND", GONE);
  const facts = await factsOf(env, loaded);
  const item = await approveItemOf(env, loaded, facts.touches);
  if (item === undefined) throw agentXError("NOT_FOUND", GONE);
  const projection = projectDecisionCards([item], { locks: {}, pairFullCards: false });
  const card = projection.cards[0];
  const digest = projection.digests[card?.id ?? ""];
  if (card === undefined || digest === undefined) throw agentXError("NOT_FOUND", GONE);
  if (body.shownDigest !== digest) throw agentXError("CHANGE_STALE", DECISION_REFUSALS.stale.message);
  const outcome = await designApproveHandler(approvePortsOf(env)).approve(env.caller, { card, item, requestId: body.requestId, shown: { cardId: card.id, digest }, ...(body.reason === undefined ? {} : { reason: body.reason }) } as never);
  if (outcome.kind === "done") return new StatusReply(200, { cardId: card.id, outcome: "approved" });
  if (outcome.kind === "needs_confirmation") return new StatusReply(202, { cardId: card.id, outcome: "needs_confirmation", confirmUrl: outcome.confirmUrl });
  const refusal = DECISION_REFUSALS[outcome.reason];
  throw agentXError(refusal.code, refusal.message);
}

/** The confirmation page's read: the card as the server shows it now and its digest, for a project member only (anyone else gets "no longer waiting"). The press is `approveOnPage`. */
async function confirmationCard(env: Env, taskId: string): Promise<{ card: unknown; digest: string }> {
  const loaded = await loadDesignTask(env, taskId);
  if (loaded === undefined) throw agentXError("NOT_FOUND", GONE);
  const facts = await factsOf(env, loaded);
  if (!memberOf(facts.directory, env.caller.developerId)) throw agentXError("NOT_FOUND", GONE);
  const item = await approveItemOf(env, loaded, facts.touches);
  const projection = item === undefined ? undefined : projectDecisionCards([item], { locks: {}, pairFullCards: false });
  const card = projection?.cards[0];
  const digest = projection?.digests[card?.id ?? ""];
  if (projection === undefined || card === undefined || digest === undefined) throw agentXError("NOT_FOUND", GONE);
  return { card, digest };
}

// ---- the routes

function bodyOf<T extends z.ZodType>(schema: T, request: AdaptedHttpRequest): z.infer<T> {
  const parsed = schema.safeParse(jsonBody(request));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw agentXError("CONFIG_INVALID", `${issue?.path.map(String).join(".") || "body"}: ${issue?.code === "unrecognized_keys" ? "has a field this route does not take" : issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}

/** Routes `/v1/app/tasks/{id}/design-review/*`; undefined for any other path. Every handler checks the caller's authority itself. */
export async function routeDesignReview(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const match = DESIGN_REVIEW_ROUTE.exec(url.pathname);
  if (match === null || (request.method !== "POST" && !(request.method === "GET" && match[2] === "approve"))) return undefined;
  if (deps.tasks === undefined) throw agentXError("NOT_FOUND", "developer tasks are not set up in this deployment");
  const env = envOf(deps, caller);
  const taskId = match[1]!;
  const action = match[2]!;
  if (request.method === "GET") return confirmationCard(env, taskId);
  const plain = z.object({ requestId: Request }).strict();
  if (action === "first") { bodyOf(plain, request); return designFirst(env, taskId); }
  if (action === "skip") return skip(env, taskId, bodyOf(plain, request).requestId);
  if (action === "retry") { bodyOf(plain, request); return retryNotRun(env, taskId); }
  if (action === "approve") return approveOnPage(env, taskId, bodyOf(z.object({ requestId: Request, shownDigest: z.string().min(1).max(200), reason: z.string().max(500).optional() }).strict(), request));
  if (action === "answers") {
    const body = bodyOf(z.object({ requestId: Request, answers: z.array(z.unknown()).min(1).max(3) }).strict(), request);
    return designAnswersHandler(answersPortsOf(env))(caller, { taskId, requestId: body.requestId, answers: body.answers });
  }
  const choice = SPEND_CHOICES[action.slice("spend/".length)];
  if (choice === undefined) throw agentXError("NOT_FOUND", "route not found");
  const body = bodyOf(z.object({ requestId: Request, shownDigest: z.string().min(1).max(200) }).strict(), request);
  // A repeat of a choice that was made: the earlier answer, before anything is read again (once chosen, the card no longer asks).
  const earlier = await decisionStoreOf(env).findDecision({ orgId: caller.orgId, developerId: caller.developerId }, body.requestId);
  if (earlier !== undefined && earlier.cardId === `approve_spend:${taskId}` && earlier.reason === choice) return { outcome: "done", choice, replay: true };
  const result = await designSpendChoiceHandler(spendPortsOf(env))(caller, { taskId, choice, requestId: body.requestId, shownDigest: body.shownDigest });
  return { outcome: "done", choice: result.choice };
}

// ---- the task view's Design first and Skip

const MANIFEST = /(?:^|\/)(?:package\.json|requirements\.txt|pyproject\.toml|go\.mod|cargo\.toml|pom\.xml|gemfile|build\.gradle)$/u;

/** Whether a Quick plan names something that may need design: migrations, IAM or infrastructure paths, a package manifest, or more than one repository (Q4). Words in the plan are read as data; nothing starts by itself. */
async function planHint(env: Env, task: DeveloperTaskRecord, workflow: WorkflowSnapshot): Promise<boolean> {
  const artifact = workflow.artifacts.filter((entry) => entry.type === "plan").at(-1);
  if (artifact !== undefined) {
    const document = await loadWorkflowDocument(read(env), artifact, {}).catch(() => undefined);
    const tokens = document?.markdown.match(/[\w@./-]{2,200}/gu) ?? [];
    if (tokens.some((token) => isInfraPath(token) || MANIFEST.test(token.toLowerCase()))) return true;
  }
  const project = task.startingRevision === undefined ? undefined : await env.task.actions.projectRevision(env.caller.orgId, task.project, task.startingRevision).catch(() => undefined);
  return (project?.definition.repositories.length ?? 0) > 1;
}

/**
 * What the task view says about Design first and Skip for THIS caller (DR11): the broker works it out from the live setting and the caller's authority, and re-checks on every press. Undefined when the task
 * has no design review and the project does not run one: the view is then exactly what it was.
 */
export function designActionsFor(deps: DeveloperRouteDependencies, caller: DeveloperCaller): (task: DeveloperTaskRecord) => Promise<DesignActionsView | undefined> {
  return async (task) => {
    // Built per call, not up front: `envOf` builds the task dependencies, which carry this very function.
    const env = envOf(deps, caller);
    const workflow = task.workflow;
    if (workflow === undefined || task.closedAt !== undefined || task.orgId !== caller.orgId || workflow.definitionVersion !== "1.1.0") return undefined;
    const review = workflow.designReview;
    if (review === undefined && !designReviewEnabledFor(task.project)) return undefined;
    const [effective, directory] = await Promise.all([readEffectiveDesignReview(env.facts, caller.orgId, task.project), readDesignDirectory(env.facts, caller.orgId, task.project)]);
    if (!memberOf(directory, caller.developerId)) return undefined;
    const quickCard = workflow.path === "QUICK" && workflow.stage === "PLAN_REVIEW" && workflow.state === "WAITING";
    const beforeDesign = workflow.stage === "PLAN" && workflow.state === "READY";
    const designFirst = review === undefined && (quickCard || beforeDesign);
    let skip: DesignActionsView["skip"];
    const skippable = review !== undefined && ((workflow.stage === "PLAN_CRITIQUE" && workflow.state === "WAITING" && review.status === "waiting_cost") || (beforeDesign && !workflow.artifacts.some((entry) => entry.type === "design")));
    if (skippable) {
      const touches = await readDesignTouches(workflow, read(env));
      const verdict = maySkipDesignReview({ setting: effective.setting, reasons: review.reasons, touches, skipperId: caller.developerId, directory, edition: env.facts.edition });
      if (verdict.ok) skip = { allowed: true };
      else if (verdict.code === "skip_not_allowed") skip = { allowed: false, because: "skip_off" };
      else if (verdict.code === "high_risk_approver_only") {
        const approvers = highRiskApprovers(effective.setting, directory, env.facts.edition);
        const name = approvers.ok && approvers.ids[0] !== undefined ? (await signInStoreOf(deps).getDeveloper(approvers.ids[0]).catch(() => undefined))?.displayName : undefined;
        skip = { allowed: false, because: "needs_high_risk_approver", ...(name === undefined || name === "" ? {} : { approverName: plainOneLine(name, DESIGN_ACTIONS_NAME_MAX) }) };
      }
    }
    const hint = designFirst && quickCard && await planHint(env, task, workflow).catch(() => false);
    if (!designFirst && skip === undefined) return undefined;
    return { designFirst, ...(skip === undefined ? {} : { skip }), ...(hint ? { hint: true } : {}) };
  };
}

/**
 * The playbook routes' design review dependencies (DR8 wiring pending): the install's edition (a group can be the high-risk approver only in Enterprise) and who may be NAMED as the approver in a project: its
 * maintainers and contributors, never a viewer or an Auditor, case-normalised (the store compares folded ids).
 */
export function designPlaybookDeps(deps: DeveloperRouteDependencies) {
  return {
    edition: deps.editionPolicy,
    namedApproverCandidates: async (orgId: OrgId, project: string): Promise<string[]> =>
      (await listProjectMembers(projectMembersDepsOf(deps), orgId, project)).filter((row) => row.role !== "viewer").map((row) => row.developerId.normalize("NFC").trim().toLowerCase()),
  };
}
