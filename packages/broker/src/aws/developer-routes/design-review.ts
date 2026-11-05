// Design review stage, DR7 slice C: the routes and the decision cards of a design under review, and the ports the design review's handlers need. The logic is in `design-review/*` (the handlers decide EVERYTHING: who may,
// what the friction is, whether the card is still the card); this file only reads the broker's own records fresh for the request and commits what a handler decided, in one transaction.
//   POST /v1/app/tasks/{id}/design-review/first            {requestId}                       Design first (any project member who may start work; the lock and the switch are applied)
//   POST /v1/app/tasks/{id}/design-review/skip             {requestId}                       Skip (the skip rules for THIS caller: high risk needs the high-risk approver)
//   POST /v1/app/tasks/{id}/design-review/spend/{choice}   {requestId, shownDigest}          one choice on the cost card (lower-tier | raise-cap | run-unpriced | skip), `designSpendChoiceHandler`
//   POST /v1/app/tasks/{id}/design-review/answers          {requestId, answers}              the question card's answers, `designAnswersHandler`
//   POST /v1/app/tasks/{id}/design-review/retry            {requestId}                       the one-tap Retry of a review that did not run, `retryDesignReviewNotRun`
//   POST /v1/app/tasks/{id}/design-review/resume           {requestId}                       picks up a PARKED review from its card, `designResumeHandler`
//   POST /v1/app/tasks/{id}/design-review/approve          {requestId, shownDigest, reason?} the confirmation page of a HIGH-risk design: a browser session, the same `designApproveHandler` as the card
// A task with no `designReview` answers as a missing task answers, so with the feature off none of these exists.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  ModelSelectionSchema, WORKSPACE_PROJECT_INDEX, WorkflowTransitionError, isHighRiskDesign, workspaceProjectIndexValue, agentXError, enableDesignReview, retryDesignReviewNotRun, designReviewRetryOffer, DESIGN_ACTIONS_NAME_MAX, plainOneLine, type DesignActionsView, type DesignReason, type ModelIdentifier, type OrgId, type WorkflowSnapshot,
} from "@agentx/contracts";
import { StatusReply } from "../status-reply.js";
import { effectiveTaskOwner, taskKey, taskOwnerKey, taskPointerKey, tryEffectiveTaskOwner, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { listProjectMembers } from "../../org/project-members.js";
import { AgentSessionStore } from "../../agent-sessions/store.js";
import { DECISION_REFUSALS, type DecisionCaller } from "../../decisions/routes.js";
import { projectDecisionCards, type DecisionItem } from "../../decisions/project.js";
import { dynamoDecisionStore } from "../../decisions/store.js";
import { designResumeCommitItems, designResumeHandler, type DesignResumePorts } from "../../design-review/wait-resume.js";
import { secondPersonMembershipCondition } from "../../org/second-person-approval.js";
import { designAnswersCommitItems, designAnswersHandler, type DesignAnswersPorts } from "../../design-review/answers.js";
import { decideDesignApproval, designQuestionAudience, highRiskApprovers, maySkipDesignReview } from "../../design-review/approval.js";
import { designApproveHandler, type DesignApprovePorts } from "../../design-review/approve-handler.js";
import { designApproveItem, designCardFactsOf, designQuestionsItem } from "../../design-review/card-source.js";
import { readDesignMeta } from "@agentx/contracts";
import { readEffectiveDesignReview } from "../../design-review/setting.js";
import { designSpendChoiceHandler, mayChooseDesignSpend, skipRefusalWords, designSpendGateFor, designSpendItemFor, type DesignSpendChoiceName, type DesignSpendContext, type DesignSpendPorts } from "../../design-review/spend-choice.js";
import { designSpendCommitItems } from "../../design-review/spend-follow.js";
import { spendEstimatesOf } from "../../design-review/spend-estimates.js";
import { designReviewAvailableFor } from "../../design-review/switch.js";
import { planCheckModelTriesUsed } from "../../design-review/outcome.js";
import { freshSignInOf, readDesignDirectory, readDesignTouches, readLatestDesignText, type DesignFactsDeps } from "../../design-review/route-facts.js";
import { WORKFLOW_NO_CANDIDATE_DIGEST, isConditional, workflowDispatchItem } from "../broker-shared.js";
import { commitDesignApproval, membershipFenceItem } from "../developer-tasks/design-decision.js";
import { TASK_ID, get } from "../developer-tasks/common.js";
import type { DeveloperTaskRouteDependencies } from "../developer-tasks/types.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { agentRunStarterOf, developerTaskRouteDependencies } from "./dependencies.js";
import { jsonBody } from "./organization.js";
import { signInStoreOf } from "./common.js";
import { isInfraPath } from "../../decisions/risk-tier.js";
import { loadWorkflowDocument } from "../../developer/plan-artifacts.js";
import { projectMembersDepsOf, visibleProjectRoles } from "./project-list.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const DESIGN_REVIEW_ROUTE = /^\/v1\/app\/tasks\/([0-9a-f-]{36})\/design-review\/(first|skip|answers|retry|resume|approve|spend\/(?:lower-tier|raise-cap|run-unpriced|skip))$/u;
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
      // The owner's seat is the OWNER's own (their sign-in record and membership, read now), never the approver's role or session under the owner's id (ON-4). An owner who can no longer be seated (removed, revoked) leaves the
      // approval stale: nothing is committed on a guess. The decision and the record name the person who really pressed.
      const owner = effectiveTaskOwner(loaded.task);
      const ownerCaller = await agentRunStarterOf(env.deps)?.callerFor(caller.orgId, owner.developerId);
      if (ownerCaller === undefined) return "stale";
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
    freshSignIn: await freshSignInOf(env.facts, env.caller), browserSession: env.caller.browserSession === true, revision: String(workflow.revision),
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

// ---- the parked wait's Resume

function resumePortsOf(env: Env): DesignResumePorts<DeveloperCaller> {
  let membershipVersion = 0;
  return {
    async context(_caller, taskId) {
      const loaded = await loadDesignTask(env, taskId);
      if (loaded === undefined) return undefined;
      const facts = await factsOf(env, loaded);
      membershipVersion = facts.directory.people.membershipVersion;
      return { taskId, requesterId: loaded.task.developerId, workflow: loaded.workflow, setting: facts.setting, directory: facts.directory, edition: facts.edition, touches: facts.touches };
    },
    now: () => env.deps.now(),
    async commit(caller, write) {
      const now = nowIso(env);
      const commit = (() => { try { return designResumeCommitItems({ tableName: env.deps.tableName, taskId: write.taskId, workflow: write.workflow, actorId: write.actorId, now }); } catch { return undefined; } })();
      if (commit === undefined) return "stale";
      const marker = { pk: `DEVTASK#${write.taskId}`, sk: `DESIGN_RESUME#${write.requestId}` };
      try {
        await env.task.actions.transact([...commit.items, membershipFenceItem(env.deps.tableName, caller.orgId, secondPersonMembershipCondition(membershipVersion)),
          { Put: { TableName: env.deps.tableName, Item: { ...marker, entityType: "DESIGN_RESUME", actorId: write.actorId, at: now }, ConditionExpression: "attribute_not_exists(pk)" } }] as never);
      } catch (error) {
        if (!isConditional(error) && (error as { name?: string }).name !== "TransactionCanceledException") throw error;
        return (await get(env.task, marker)) !== undefined ? "done" : "stale";
      }
      return "done";
    },
  };
}

// ---- the question card

function answersPortsOf(env: Env): DesignAnswersPorts<DeveloperCaller> {
  // The membership generation the audience was read at: the commit is fenced with it, so a membership change in between cancels the answer (ON-6, as Resume and the spend choices are).
  let membershipVersion = 0;
  return {
    async context(caller, taskId) {
      const loaded = await loadDesignTask(env, taskId);
      if (loaded === undefined) return undefined;
      const facts = await factsOf(env, loaded);
      membershipVersion = facts.directory.people.membershipVersion;
      return { taskId, requesterId: loaded.task.developerId, workflow: loaded.workflow, setting: facts.setting, touches: facts.touches, directory: facts.directory, edition: facts.edition };
    },
    now: () => env.deps.now(),
    async commit(caller, write) {
      const now = nowIso(env);
      const commit = (() => { try { return designAnswersCommitItems({ tableName: env.deps.tableName, taskId: write.taskId, workflow: write.workflow, answers: write.answers, actorId: write.actorId, now }); } catch { return undefined; } })();
      if (commit === undefined) return "stale";
      const marker = { pk: `DEVTASK#${write.taskId}`, sk: `DESIGN_ANSWERS#${write.requestId}` };
      try {
        await env.task.actions.transact([...commit.items, membershipFenceItem(env.deps.tableName, caller.orgId, secondPersonMembershipCondition(membershipVersion)),
          { Put: { TableName: env.deps.tableName, Item: { ...marker, entityType: "DESIGN_ANSWERS", actorId: write.actorId, at: now }, ConditionExpression: "attribute_not_exists(pk)" } }] as never);
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
/** The newest workspaces of a project whose tasks are looked at for cards of people who did not ask for the task (a design waiting on its approver is recent). */
const PROJECT_TASKS_MAX = 25;

const sameId = (left: string, right: string): boolean => left.normalize("NFC").trim().toLowerCase() === right.normalize("NFC").trim().toLowerCase();

/** The caller's own tasks (they asked for them, or took them over): ids, newest first. */
async function ownTaskIds(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<string[]> {
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": `DEVELOPER#${caller.developerId}`, ":prefix": "TASK#" }, ScanIndexForward: false, Limit: ROWS_MAX, ConsistentRead: true,
  })) as { Items?: Array<{ taskId?: string; orgId?: string; status?: string }> };
  return (response.Items ?? []).filter((row) => row.orgId === caller.orgId && row.status !== "CLOSED" && typeof row.taskId === "string").map((row) => row.taskId!);
}

/**
 * The recent tasks of the projects the design review runs for and the caller belongs to, so a maintainer or the design approver finds the cards of tasks they did not ask for (ON-5). A bounded read: the newest workspaces
 * of each such project, then each one's task. Nothing here decides who may act: every card is then filtered by the same rules the handlers apply.
 */
async function projectTaskIds(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<string[]> {
  const roles = await visibleProjectRoles(deps, caller);
  const found: string[] = [];
  // The stage exists for the company or it does not (`dr` off reads nothing here); a project that is Off has no new reviews, and a person-asked one is still found.
  if (!(await designReviewAvailableFor(deps, caller.orgId))) return found;
  for (const project of [...roles.keys()].sort()) {
    const workspaces = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, IndexName: WORKSPACE_PROJECT_INDEX.name, KeyConditionExpression: "#project = :project", ExpressionAttributeNames: { "#project": WORKSPACE_PROJECT_INDEX.partitionKey },
      ExpressionAttributeValues: { ":project": workspaceProjectIndexValue(caller.orgId, project) }, ScanIndexForward: false, Limit: PROJECT_TASKS_MAX,
    })) as { Items?: Array<{ id?: unknown }> };
    for (const workspace of workspaces.Items ?? []) {
      if (typeof workspace.id !== "string") continue;
      const pointer = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskPointerKey(workspace.id), ConsistentRead: true }))) as { Item?: { taskId?: unknown } };
      if (typeof pointer.Item?.taskId === "string") found.push(pointer.Item.taskId);
    }
  }
  return found;
}

/**
 * The design review's cards for one task, for THIS caller: the design to approve (to the requester, who is told what is needed, and to everyone who may approve it), the cost question (built for this person: only the choices
 * they may make; to the requester and to anyone who can make one) and the questions to answer (to the people the audience rules name). The eligibility is the handlers' own, so a card is never shown to someone its press would
 * refuse as "not for you".
 */
async function cardsForTask(env: Env, caller: DeveloperCaller, loaded: Loaded): Promise<DecisionItem[]> {
  const { workflow, task } = loaded;
  const review = workflow.designReview!;
  const requester = sameId(task.developerId, caller.developerId) || tryEffectiveTaskOwner(task)?.developerId === caller.developerId;
  if (waitingOnDesign(workflow)) {
    const facts = await factsOf(env, loaded);
    const item = await approveItemOf(env, loaded, facts.touches);
    if (item === undefined || item.kind !== "approve_design") return [];
    if (!requester) {
      const tier = projectDecisionCards([item], { locks: {}, pairFullCards: false }).cards[0]?.risk;
      if (tier === undefined) return [];
      // Eligible exactly as `designApproveHandler` works it out (a sign-in and a reason are the press's to ask for, not the list's).
      const verdict = decideDesignApproval({
        tier, requesterId: task.developerId, approverId: caller.developerId, nowMs: env.deps.now(), setting: facts.setting, edition: facts.edition, directory: facts.directory,
        freshSignIn: true, openBlockers: item.review?.blockers.length ?? 0, blockerReason: "x",
      });
      if (!verdict.ok) return [];
    }
    return [item];
  }
  if (review.status === "waiting_cost") {
    const context = await spendContextOf(env, caller, loaded);
    if (context === undefined) return [];
    const { gate, skip } = designSpendGateFor(context, caller.developerId);
    if (gate.kind !== "ask") return [];
    if (!requester) {
      const mayChoose = gate.choices.some((choice) => choice.choice === "skip" ? skip.ok : mayChooseDesignSpend({
        choice: choice.choice, callerId: caller.developerId, requesterId: context.requesterId, newCapUsd: choice.choice === "raise_cap" ? choice.newCapUsd : undefined, ceilingUsd: context.capCeilingUsd, directory: context.directory,
      }).ok);
      if (!mayChoose) return [];
    }
    return [designSpendItemFor(context, gate)];
  }
  if (review.status === "waiting_answers" && workflow.stage === "PLAN" && workflow.state === "WAITING") {
    const round = review.rounds.at(-1);
    const facts = await factsOf(env, loaded);
    // Only a person who may answer sees the card (the handler checks again on the press).
    if (round?.questions === undefined || !facts.directory.people.complete) return [];
    const audience = designQuestionAudience({ requesterId: task.developerId, aboutHighRisk: isHighRiskDesign([...review.reasons, ...facts.touches]), setting: facts.setting, directory: facts.directory, edition: facts.edition });
    if (!requester && !audience.some((id) => sameId(id, caller.developerId))) return [];
    const item = designQuestionsItem({
      subjectId: task.taskId, taskId: task.taskId, project: task.project, title: task.title, createdAt: review.waiting?.since ?? workflow.updatedAt ?? nowIso(env), openPath: await sessionPathOf(env, task),
      contentVersion: `q-${String(workflow.revision)}`, designTitle: task.title, questions: round.questions,
      packetItems: round.reviewers.flatMap((run) => run.packet.map((entry) => ({ kind: entry.kind, ref: entry.ref, commitOrFetchedAt: entry.commitOrFetchedAt, digest: entry.digest }))),
    });
    return item === undefined ? [] : [item];
  }
  return [];
}

/**
 * The design review's cards for the caller: those of their own tasks, and those of the other tasks they may act on as an approver or a maintainer (ON-5). Each card is checked with the rules its handler uses. Empty while no task
 * carries a design review.
 */
export async function designReviewItemsFor(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<DecisionItem[]> {
  const env = envOf(deps, caller);
  const found: DecisionItem[] = [];
  const seen = new Set<string>();
  const ids = [...await ownTaskIds(deps, caller), ...await projectTaskIds(deps, caller).catch(() => [] as string[])];
  for (const taskId of ids) {
    if (seen.has(taskId)) continue;
    seen.add(taskId);
    try {
      const loaded = await loadDesignTask(env, taskId);
      if (loaded === undefined) continue;
      found.push(...await cardsForTask(env, caller, loaded));
    } catch { /* a task that cannot be read is not a card */ }
  }
  return found;
}

// ---- Design first, Skip, Retry

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

/** A request's record (kept by the transaction that did the work) when it is there: a repeat finds it and is the same request. */
type Marker = { pk: string; sk: string };
const markerOf = (taskId: string, kind: string, requestId: string): Marker => ({ pk: `DEVTASK#${taskId}`, sk: `${kind}#${requestId}` });
const REQUEST_REUSED = "requestId: this request ID was already used for a different request";

/**
 * A repeat of a request that already did its work (ON-13): the same person with the same request ID gets the first answer (before the state is read, which has moved on); another person with that ID is refused.
 * Undefined when the request is new.
 */
async function replayOf(env: Env, marker: Marker): Promise<"done" | undefined> {
  const earlier = await get<{ actorId?: string }>(env.task, marker);
  if (earlier === undefined) return undefined;
  if (earlier.actorId !== env.caller.developerId) throw agentXError("CONFIG_INVALID", REQUEST_REUSED);
  return "done";
}

async function transactWorkflow(env: Env, loaded: Loaded, next: WorkflowSnapshot, extra: unknown[], expect: { stage: string; states: readonly string[] }, request?: { marker: Marker; entityType: string; fence: ReturnType<typeof secondPersonMembershipCondition> }): Promise<void> {
  const { task, workflow } = loaded;
  const now = nowIso(env);
  const states = expect.states.map((_, index) => `workflow.#state = :s${String(index)}`);
  // The request's own record and the membership fence ride in the SAME transaction: a repeat finds the record, and a membership change since the people were read cancels the move.
  const own = request === undefined ? [] : [
    membershipFenceItem(env.deps.tableName, env.caller.orgId, request.fence),
    { Put: { TableName: env.deps.tableName, Item: { ...request.marker, entityType: request.entityType, actorId: env.caller.developerId, at: now }, ConditionExpression: "attribute_not_exists(pk)" } },
  ];
  try {
    await env.task.actions.transact([{ Update: {
      TableName: env.deps.tableName, Key: taskKey(task.taskId), UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ConditionExpression: `workflow.revision = :revision AND workflow.#stage = :stage AND (${states.join(" OR ")}) AND attribute_not_exists(closedAt)`,
      ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
      ExpressionAttributeValues: { ":workflow": next, ":now": now, ":revision": workflow.revision, ":stage": expect.stage, ...Object.fromEntries(expect.states.map((state, index) => [`:s${String(index)}`, state])) },
    } }, ...extra, ...own] as never);
  } catch (error) {
    if (isConditional(error) || (error as { name?: string }).name === "TransactionCanceledException") {
      // The transaction may have been the first of two taps of the same request: then the request is done.
      if (request !== undefined && await replayOf(env, request.marker).catch(() => undefined) === "done") return;
      throw agentXError("CHANGE_STALE", "This changed since you loaded it. Reload to see the current version.");
    }
    throw error;
  }
}

/**
 * Design first and Retry start paid work on a task, so they are the requester's or a project maintainer's (ON-11), not any member's. A member who is neither is told so; a person outside the project gets "no longer waiting".
 */
function mayDirectWork(directory: Parameters<typeof memberOf>[0], task: DeveloperTaskRecord, callerId: string): boolean {
  const requester = sameId(task.developerId, callerId) || tryEffectiveTaskOwner(task)?.developerId === callerId;
  return requester || directory.people.eligibleIds.some((id) => sameId(id, callerId));
}
const REQUESTER_OR_MAINTAINER = "Only the person who asked for this task, or a project maintainer, can do this.";

async function designFirst(env: Env, taskId: string, requestId: string): Promise<{ outcome: "done" }> {
  if (!TASK_ID.test(taskId)) throw agentXError("NOT_FOUND", GONE);
  const task = await get<DeveloperTaskRecord>(env.task, taskKey(taskId));
  if (task === undefined || task.orgId !== env.caller.orgId || task.closedAt !== undefined || task.workflow === undefined || !(await designReviewAvailableFor(env.facts, env.caller.orgId))) throw agentXError("NOT_FOUND", GONE);
  const loaded: Loaded = { task, workflow: task.workflow };
  const { workflow } = loaded;
  const marker = markerOf(taskId, "DESIGN_FIRST", requestId);
  const effective = await readEffectiveDesignReview(env.facts, env.caller.orgId, task.project);
  const directory = await readDesignDirectory(env.facts, env.caller.orgId, task.project);
  if (!memberOf(directory, env.caller.developerId)) throw agentXError("NOT_FOUND", GONE);
  // A repeat of the same press: the first answer, before the state (which has moved on) is looked at.
  if (await replayOf(env, marker) === "done") return { outcome: "done" };
  if (!mayDirectWork(directory, task, env.caller.developerId)) throw agentXError("FORBIDDEN", REQUESTER_OR_MAINTAINER);
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
  await transactWorkflow(env, loaded, next, due, workflow.stage === "PLAN_REVIEW" ? { stage: "PLAN_REVIEW", states: ["WAITING"] } : { stage: "PLAN", states: ["READY"] },
    { marker, entityType: "DESIGN_FIRST", fence: secondPersonMembershipCondition(directory.people.membershipVersion) });
  return { outcome: "done" };
}

/** One choice on the cost card, the same code whichever door it comes through (the card's own buttons and the task view's Skip): the handler re-works the gate for THIS caller and applies the friction of the card's tier. */
async function spendChoiceOf(env: Env, taskId: string, choice: DesignSpendChoiceName, requestId: string, shownDigest: string | undefined): Promise<{ outcome: "done"; choice: DesignSpendChoiceName; replay?: true }> {
  // A repeat of a choice that was made: the earlier answer, before anything is read again (once chosen, the card no longer asks).
  const earlier = await decisionStoreOf(env).findDecision({ orgId: env.caller.orgId, developerId: env.caller.developerId }, requestId);
  if (earlier !== undefined && earlier.cardId === `approve_spend:${taskId}` && earlier.reason === choice) return { outcome: "done", choice, replay: true };
  const result = await designSpendChoiceHandler(spendPortsOf(env))(env.caller, { taskId, choice, requestId, ...(shownDigest === undefined ? {} : { shownDigest }) });
  return { outcome: "done", choice: result.choice };
}

async function skip(env: Env, taskId: string, requestId: string, shownDigest: string | undefined): Promise<{ outcome: "done"; choice?: DesignSpendChoiceName; replay?: true }> {
  const loaded = await loadDesignTask(env, taskId);
  if (loaded === undefined) throw agentXError("NOT_FOUND", GONE);
  const { workflow } = loaded;
  const review = workflow.designReview!;
  const marker = markerOf(taskId, "DESIGN_SKIP", requestId);
  if (await replayOf(env, marker) === "done") return { outcome: "done" };
  if (review.decidedBy === "person_skip" && review.skippedBy?.actorId === env.caller.developerId) return { outcome: "done" };
  const facts = await factsOf(env, loaded);
  if (!memberOf(facts.directory, env.caller.developerId)) throw agentXError("NOT_FOUND", GONE);
  // At the cost hold this IS the spend card's Skip (ON-3): the same handler, with the digest, the evidence, the sign-in, the membership fence and the request record it applies.
  if (review.status === "waiting_cost" && workflow.stage === "PLAN_CRITIQUE" && workflow.state === "WAITING") return spendChoiceOf(env, taskId, "skip", requestId, shownDigest);
  const verdict = maySkipDesignReview({ setting: facts.setting, reasons: review.reasons, touches: facts.touches, skipperId: env.caller.developerId, directory: facts.directory, edition: facts.edition });
  if (!verdict.ok) throw agentXError("FORBIDDEN", skipRefusalWords(verdict.code, facts.setting));
  // Before the design is written, a skip of a design review with a high-risk area is a high decision: a live browser session and a fresh sign-in, never a token.
  if (isHighRiskDesign([...review.reasons, ...facts.touches])) {
    if (env.caller.browserSession !== true) throw agentXError("FORBIDDEN", "Decide this in the Rovara app.");
    if (!(await freshSignInOf(env.facts, env.caller))) throw agentXError("FORBIDDEN", "Sign in again to decide this.");
  }
  let commit;
  try { commit = designSpendCommitItems({ tableName: env.deps.tableName, taskId, workflow, write: { actorId: env.caller.developerId, applied: { choice: "skip" } }, now: nowIso(env) }); } catch (error) {
    if (error instanceof WorkflowTransitionError) throw agentXError("CONFIG_INVALID", "Design review can't be skipped at this step.");
    throw error;
  }
  const now = nowIso(env);
  try {
    await env.task.actions.transact([...commit.items, membershipFenceItem(env.deps.tableName, env.caller.orgId, secondPersonMembershipCondition(facts.directory.people.membershipVersion)),
      { Put: { TableName: env.deps.tableName, Item: { ...marker, entityType: "DESIGN_SKIP", actorId: env.caller.developerId, at: now }, ConditionExpression: "attribute_not_exists(pk)" } }] as never);
  } catch (error) {
    if (isConditional(error) || (error as { name?: string }).name === "TransactionCanceledException") {
      if (await replayOf(env, marker).catch(() => undefined) === "done") return { outcome: "done" };
      throw agentXError("CHANGE_STALE", "This changed since you loaded it. Reload to see the current version.");
    }
    throw error;
  }
  return { outcome: "done" };
}

async function retryNotRun(env: Env, taskId: string, requestId: string): Promise<{ outcome: "done" }> {
  const loaded = await loadDesignTask(env, taskId);
  if (loaded === undefined) throw agentXError("NOT_FOUND", GONE);
  const { workflow, task } = loaded;
  const marker = markerOf(taskId, "DESIGN_RETRY", requestId);
  if (await replayOf(env, marker) === "done") return { outcome: "done" };
  const facts = await factsOf(env, loaded);
  if (!memberOf(facts.directory, env.caller.developerId)) throw agentXError("NOT_FOUND", GONE);
  if (!mayDirectWork(facts.directory, task, env.caller.developerId)) throw agentXError("FORBIDDEN", REQUESTER_OR_MAINTAINER);
  const now = nowIso(env);
  let next: WorkflowSnapshot;
  try { next = retryDesignReviewNotRun(workflow, { expectedRevision: workflow.revision, by: { actorId: env.caller.developerId }, now }); } catch (error) {
    if (error instanceof WorkflowTransitionError) throw agentXError("CONFIG_INVALID", "Design review can't be retried at this step.");
    throw error;
  }
  const due = next.stage === "PLAN_CRITIQUE" && next.state === "READY" ? [workflowDispatchItem(env.deps.tableName, taskId, next.revision, "CRITIQUE", WORKFLOW_NO_CANDIDATE_DIGEST, now)] : [];
  await transactWorkflow(env, loaded, next, due, { stage: "PLAN_REVIEW", states: ["WAITING"] },
    { marker, entityType: "DESIGN_RETRY", fence: secondPersonMembershipCondition(facts.directory.people.membershipVersion) });
  return { outcome: "done" };
}

// ---- the high-risk confirmation page

async function approveOnPage(env: Env, taskId: string, body: { requestId: string; shownDigest: string; reason?: string | undefined }): Promise<StatusReply> {
  // The confirmation page is a browser's: a token (an AI tool) never decides a design on a click, as a token never merges one.
  if (env.caller.browserSession !== true) throw agentXError("FORBIDDEN", "Decide this in the Rovara app.");
  const loaded = await loadDesignTask(env, taskId);
  if (loaded === undefined) throw agentXError("NOT_FOUND", GONE);
  // A repeat of a press that approved (ON-13): the first answer. The design is approved, so no card is drawn any more; the decision on the record carries this request and the person who pressed.
  const approvedBy = loaded.workflow.decisions.find((decision) => decision.requestId === body.requestId);
  if (approvedBy !== undefined) {
    const pressed = approvedBy.actorId === env.caller.developerId || approvedBy.actorId === taskOwnerKey(env.caller.developerId, taskId);
    if (!pressed || approvedBy.decision !== "APPROVE") throw agentXError("CONFIG_INVALID", REQUEST_REUSED);
    return new StatusReply(200, { cardId: `approve_design:${taskId}`, outcome: "approved", replay: true });
  }
  const facts = await factsOf(env, loaded);
  const item = await approveItemOf(env, loaded, facts.touches);
  if (item === undefined) throw agentXError("NOT_FOUND", GONE);
  const projection = projectDecisionCards([item], { locks: {}, pairFullCards: false });
  const card = projection.cards[0];
  const digest = projection.digests[card?.id ?? ""];
  if (card === undefined || digest === undefined) throw agentXError("NOT_FOUND", GONE);
  if (body.shownDigest !== digest) throw agentXError("CHANGE_STALE", DECISION_REFUSALS.stale.message);
  const outcome = await designApproveHandler(approvePortsOf(env)).approve(env.caller, { card, item, requestId: body.requestId, shown: { cardId: card.id, digest }, ...(body.reason === undefined ? {} : { reason: body.reason }) });
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
  if (action === "first") return designFirst(env, taskId, bodyOf(plain, request).requestId);
  if (action === "skip") {
    const body = bodyOf(z.object({ requestId: Request, shownDigest: z.string().min(1).max(200).optional() }).strict(), request);
    return skip(env, taskId, body.requestId, body.shownDigest);
  }
  if (action === "retry") return retryNotRun(env, taskId, bodyOf(plain, request).requestId);
  if (action === "resume") {
    const { requestId } = bodyOf(plain, request);
    const task = await loadDesignTask(env, taskId);
    if (task !== undefined && await replayOf(env, markerOf(taskId, "DESIGN_RESUME", requestId)) === "done") return { kind: "done" };
    return designResumeHandler(resumePortsOf(env))(caller, { taskId, requestId });
  }
  if (action === "approve") return approveOnPage(env, taskId, bodyOf(z.object({ requestId: Request, shownDigest: z.string().min(1).max(200), reason: z.string().max(500).optional() }).strict(), request));
  if (action === "answers") {
    const body = bodyOf(z.object({ requestId: Request, answers: z.array(z.unknown()).min(1).max(3) }).strict(), request);
    if (await loadDesignTask(env, taskId) !== undefined && await replayOf(env, markerOf(taskId, "DESIGN_ANSWERS", body.requestId)) === "done") return { kind: "done" };
    return designAnswersHandler(answersPortsOf(env))(caller, { taskId, requestId: body.requestId, answers: body.answers });
  }
  const choice = SPEND_CHOICES[action.slice("spend/".length)];
  if (choice === undefined) throw agentXError("NOT_FOUND", "route not found");
  const body = bodyOf(z.object({ requestId: Request, shownDigest: z.string().min(1).max(200) }).strict(), request);
  return spendChoiceOf(env, taskId, choice, body.requestId, body.shownDigest);
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
    if (review === undefined && !(await designReviewAvailableFor(env.facts, caller.orgId))) return undefined;
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
    // DR-KEY-1 (D): "Retry review" by the route's own rules: the workflow's (`designReviewRetryOffer`) and who may press it (the requester or a maintainer).
    // Not offered when the plan check has used its model tries since the latest plan: the dispatch would refuse the retry (the same rule it applies).
    const offer = designReviewRetryOffer(workflow);
    const retry = offer === undefined || await planCheckModelTriesUsed(deps, task) ? undefined : { allowed: offer.allowed && mayDirectWork(directory, task, caller.developerId), retriesLeft: offer.retriesLeft };
    if (!designFirst && skip === undefined && retry === undefined) return undefined;
    return { designFirst, ...(skip === undefined ? {} : { skip }), ...(hint ? { hint: true } : {}), ...(retry === undefined ? {} : { retry }) };
  };
}

/**
 * The playbook routes' design review dependencies (DR8 wiring pending): who may be NAMED as the approver in a project: its maintainers and contributors, never a viewer or an Auditor, case-normalised (the store
 * compares folded ids). The install's edition is NOT passed: groups have no member store yet, so a group is refused as the high-risk approver everywhere (ON-12, fail closed) and the editor is not offered one.
 * The playbook routes use this only for a project the design review runs for.
 */
export function designPlaybookDeps(deps: DeveloperRouteDependencies) {
  return {
    namedApproverCandidates: async (orgId: OrgId, project: string): Promise<string[]> =>
      (await listProjectMembers(projectMembersDepsOf(deps), orgId, project)).filter((row) => row.role !== "viewer").map((row) => row.developerId.normalize("NFC").trim().toLowerCase()),
  };
}
