// Part of the broker (split out of ../broker.ts): agent steps, the task operation parts, application selection, agent skills and tools.

import { readTurnActorChecks } from "../../model-selection/turn-authority.js";
import { turnStagesForMode, prepareTurnModelPolicy } from "../../model-selection/turn-policy.js";
import { reviewFailures, criticFailures } from "../../model-selection/task-failures.js";
import { taskStageReferenceChecks, taskStageReferences, scopedTaskOperations, taskStageReferenceOperation } from "../../model-selection/task-references.js";
import { prepareTurnModelFallback, prepareTaskModelFallback } from "../../model-selection/fallback-record.js";
import type { StageModelResult } from "../../model-selection/resolver.js";
import { loadPinnedTaskStage } from "../../model-selection/task-live.js";
import { type TaskModelPolicyBinding, STAGE_OPERATION_MAPPING, sharedTaskKey, type SharedTaskRecord } from "@agentx/contracts";
import { TurnAdmissionLimitError } from "../../model-selection/turn-admission.js";
import { createHash, randomUUID } from "node:crypto";
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { E2ESetupProposalSchema, E2EPolicySchema, WEB_API_RUNTIME_PROFILE_ID, verifyE2ESetupProposal, canonicalJson, OPERATION_PROMPT_MAX_BYTES, agentXError, type OperationRequester, type ProjectCommand, type WorkflowFeedbackApprovalBinding, type WorkflowFixPayload, type WorkflowDependencyInvocation, type WorkflowReviewBase, type WorkflowReviewChecks, type WorkflowReviewPlan, type WorkflowReviewFeedback, type WorkflowReviewNote, type SlackThread, type WorkerInvocation, type WorkspaceInstance, ModelSelectionSchema, recipeDigest, recipeRunner, type ModelIdentifier, type ModelSelection, type ResolvedRecipe, type ResolvedStep, type AgentGuardrails, type OrgId, sameJsonContent, type E2ESourceSnapshot, type E2EWorkflowAdmissionRef, type E2ESetupProposal, type E2EPolicy, type PlanApprovalRef, type E2EApplicationPlanIntent, type E2EApplicationSelectionRecord, type E2ERuntimeAccountRef, type E2EApplicationAccountDefinition, readE2EApplicationProjectContract, e2eSyntheticAccountContractDigest, type E2ERegisteredRuntime, ResolvedRecipeSchema } from "@agentx/contracts";
import { projectE2EBaselineWanted, readWorkflowE2EBaselineRecord } from "../workflow-e2e-baseline.js";
import type { AuthenticatedIdentity } from "../../auth.js";
import { queryAllItems } from "../admin-reads.js";
import type { AgentTokenOptions } from "../../github-app.js";
import { DynamoConnectorLedger } from "../connector-ledger.js";
import { resolveConnectors } from "../connector-types.js";
import { DeveloperSignInStore } from "../../developer/store.js";
import { readObjectText as readStoredText } from "../../developer/plan-artifacts.js";
import { workflowDependenciesAllowed } from "../../rovara-code/parallel-parts.js";
import { requireOrgId } from "../../org/resolve.js";
import { requireProject } from "../project-records.js";
import { applicationRuntimeRowFences, readExpiredE2ERuntimes, readProjectAdmittedE2ERuntimes, readProjectReadyE2ERuntimes, type ReadyE2ERuntime } from "../e2e-runtime-readiness.js";
import { accountRegistryFences, readAccountRegistryEntries } from "../e2e-account-registry.js";
import { E2EAccountRegistryError, unreadableAccountMessage, type E2EAccountRegistryEntry } from "../../e2e/application-account-registry.js";
import { TERMINAL, getItem, issueCapability, operationKey, operationOrg, operationRecord, outboxRecord, requireOperation, type CallbackClaims, type OperationRecord } from "../cancellation.js";
import { requireCreatorStillMember, requireWorkspaceCreatorStillMember } from "../../developer/creator-member.js";
import { effectiveTaskOwner, taskKey, taskPointerKey, taskRecipeKey, type DeveloperTaskPointerRecord, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { hashJson, isConditional, PLAN_PHASE_LIMITS, WORKFLOW_PREAMBLE, planChecksInstructions, planDocumentInstructions, workerPrompt } from "../broker-shared.js";
import { buildFeatureE2EPlanningContext, isExactFeatureE2ESourceSnapshot } from "../../e2e/feature-plan-planning-context.js";
import { offersApplicationE2EPlan } from "../../e2e/feature-plan-executable-kinds.js";
import { evaluateApplicationPlanApproval, type ApplicationAccountsInput, type ApplicationRefusalScope } from "../../e2e/application-plan-approval.js";
import { canonicalModelName, metaRepositoryOf } from "@agentx/contracts";
import type { SpecReviewInput, SpecWriteBinding } from "@agentx/contracts";
import { checkE2EAgentRouteCurrent } from "../../e2e/model-route-registry.js";
import { developerIdForSlackUser } from "../admin-actions.js";
import { chatGptOwner, chatGptTaskSelection } from "../../chatgpt/task-model.js";
import type { ModelSourceStore } from "../../model-sources/store.js";
import { AgentStore } from "../../agents/store.js";
import { SkillStore, servedSkills } from "../../agents/skills.js";
import { followMerges } from "../../agents/access.js";
import type { AgentRouteDependencies } from "../../agents/routes.js";
import { readTaskRecipe } from "../../agents/runs.js";
import { approvalsNotWiredGate, approvalsWriteGate, callAgentTool, listAgentTools, type AgentToolsDependencies, type AgentToolsRun } from "../../agents/agent-tools-routes.js";
import { answerForHeldCall } from "../../agents/write-gate.js";
import { taskRunCache } from "../../agents/run-cache.js";
import { CRITIC_MODEL_ATTEMPTS_MAX, PlanCheckUnavailableError, criticModelFor } from "../../rovara-code/critic.js";
import { reviewerModelFor } from "../../rovara-code/reviewer-model.js";
import { applyAgentStep, crossCompanyTargets, defaultWorkerModel, givesAgentTools, priorStepIds, routeStep, stepForOperation, stepName as stepNameOf, type AgentRunStepInput, type AppliedAgentStep, type DispatchMode } from "../../agents/dispatch.js";
import { servableModels } from "../../model-sources/routing.js";
import { readGuardrails } from "../../agents/guardrails.js";
import { json } from "../json-reply.js";
import type { TransactItems } from "../developer-task-actions.js";
import { planQualityContextOf } from "../../developer/plan-self-check.js";
import { publicWorkspace } from "../../workspaces.js";
import { parseRuntimeBinding, type AdaptedHttpRequest } from "../lambda.js";
import { SETUP_DRAFT_PREAMBLE } from "../../rovara-code/setup-draft.js";
import { object, parseBody, verifyCapability } from "./admin-and-helpers.js";
import { stageHasContextSources } from "../../context-sources/enabled.js";
import { MAX_SETUP_PROPOSAL_BYTES, type AwsBrokerDependencies, type RegisteredProjectRecord } from "./definitions.js";
import { requireRecordProject } from "./dependency-wiring.js";
import { ROVARA_CODE_NAME } from "./model-access.js";
import { getDefaultWorkspace, requireLatestProject, requireMembership, requireOwnedWorkspace, requireProjectAuthority, requireWorkspace, resolveProjectModel } from "./records.js";
import { creatorCheckOf, githubScope, githubScopeOf, modelSourceStoreOf, orgOfRecord, routingOf } from "./scope-helpers.js";
import { githubLoginOfDeveloper } from "./thread-workspaces.js";
import { connectorTypeContext } from "./workspace-routes.js";

export async function resolveWorkspace(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  projectName: string,
  revision: number,
) {
  if (!Number.isInteger(revision) || revision < 1) throw agentXError("CONFIG_INVALID", "revision is required");
  const orgId = requireOrgId(identity.orgId);
  await requireMembership(dependencies, orgId, identity.ownerKey, projectName);
  await requireProject(dependencies, orgId, projectName, revision);
  const workspace = await getDefaultWorkspace(dependencies, orgId, identity.ownerKey, projectName);
  if (!workspace) throw agentXError("WORKSPACE_NOT_READY", "workspace has not been prepared by an administrator");
  if (workspace.projectRevision !== revision) {
    throw agentXError("PROJECT_REVISION_MISMATCH", "workspace is pinned to another project revision");
  }
  return publicWorkspace(workspace);
}

export async function createConversation(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
) {
  const workspace = await requireOwnedWorkspace(dependencies, identity, workspaceId);
  await requireMembership(dependencies, requireOrgId(identity.orgId), identity.ownerKey, workspace.projectName);
  const now = new Date().toISOString();
  const conversation = { id: randomUUID(), workspaceId, createdAt: now, updatedAt: now };
  await dependencies.documentClient.send(new PutCommand({
    TableName: dependencies.tableName,
    Item: { pk: `WORKSPACE#${workspaceId}`, sk: `CONVERSATION#${conversation.id}`, entityType: "CONVERSATION", ...conversation },
    ConditionExpression: "attribute_not_exists(pk)",
  }));
  return conversation;
}

/** The developer task a workspace runs, or undefined for work that has none (a Slack thread operation). */
export async function workspaceTask(dependencies: AwsBrokerDependencies, workspaceId: string): Promise<DeveloperTaskRecord | undefined> {
  const pointer = await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(workspaceId));
  return pointer === undefined ? undefined : getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
}

/**
 * Plan 3, Task 16: applies the task's frozen recipe to one coding operation. Undefined for work with no agent (nothing changes). The snapshot
 * is read with the task's org and must be the one the task recorded; the guardrails are read now (a model forbidden since the start refuses
 * the next step), and the earlier operations only when this step must differ in company from them.
 */
async function dispatchAgentStep(
  dependencies: AwsBrokerDependencies,
  orgId: OrgId,
  workspace: WorkspaceInstance,
  task: DeveloperTaskRecord | undefined,
  input: { workflowMode?: DispatchMode; programStepId?: string; agentRun?: AgentRunStepInput },
  settings: RegisteredProjectRecord,
  projectModel: ModelSelection | undefined,
  chatgptModel: ModelSelection | undefined,
  frozen: Awaited<ReturnType<typeof readTaskRecipe>>,
): Promise<(AppliedAgentStep & { stepName: string; criticSameModel?: true; reviewSameModel?: true;modelDecision?:Extract<StageModelResult,{kind:"resolved"}>;modelCompanyRevision?:number;modelPolicy?:TaskModelPolicyBinding }) | undefined> {
  if (task?.agent === undefined) return undefined;
  // The digest is computed from the recipe itself, never taken from the item's own field: the content is what must be the one the task recorded.
  if (frozen === undefined || recipeDigest(frozen.recipe) !== task.agent.digest) throw agentXError("RUNTIME_UNAVAILABLE", "the agent snapshot of this task can't be read");
  // A run of agent steps is driven by the engine alone: any other task operation (a legacy turn from whichever route) would run a full coding session in its workspace.
  if (input.agentRun === undefined && recipeRunner(frozen.recipe) === "agent_steps") throw agentXError("CONFIG_INVALID", "an agent run takes no follow-up; start a new run instead");
  const guardrails = await readGuardrails(dependencies, orgId);
  if(frozen.modelPolicyPin!==undefined&&input.agentRun===undefined&&recipeRunner(frozen.recipe)==="coding") {
    const mode=input.workflowMode??"IMPLEMENT",stages=STAGE_OPERATION_MAPPING[mode].stages;
    if(stages.length>0) {
      const operations=scopedTaskOperations(await queryAllItems(dependencies,`WORKSPACE#${workspace.id}`,"OPERATION#"),{orgId,workspaceId:workspace.id,conversationId:task.conversationId,taskId:task.taskId});
      const latest=(mode:string)=>operations.filter(item=>item.entityType==="OPERATION"&&item.kind==="task"&&item.workflowMode===mode).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)))[0];
      const priorModels=taskStageReferences(operations,{orgId,workspaceId:workspace.id,conversationId:task.conversationId,taskId:task.taskId});
      const history=mode==="PLAN_CRITIQUE"?criticFailures(operations,latest("PLAN")):mode==="REVIEW"?reviewFailures(operations,taskStageReferenceOperation(operations,{orgId,workspaceId:workspace.id,conversationId:task.conversationId,taskId:task.taskId},"build")):undefined;
      if(mode==="PLAN_CRITIQUE"&&history!==undefined&&"sinceLatestPlan" in history&&history.sinceLatestPlan>=CRITIC_MODEL_ATTEMPTS_MAX)throw new PlanCheckUnavailableError();
      const decisions=await Promise.all(stages.map(stage=>loadPinnedTaskStage({...dependencies,routing:routingOf(dependencies)??{},chatgpt:dependencies.chatgpt,now:Date.now},{orgId,project:workspace.projectName,agentId:task.agent!.agentId,recipe:frozen.recipe,digest:frozen.digest,pin:frozen.modelPolicyPin,stage,priorModels,...(chatgptModel===undefined?{}:{defaultPreferred:chatgptModel}),deniedModels:history?.models??[],defaultLastAttempt:history!==undefined&&("sinceLatestPlan" in history?history.sinceLatestPlan:history.sinceLatestBuild)+1>=CRITIC_MODEL_ATTEMPTS_MAX,...(task.payer?.kind==="member"?{payerDeveloperId:task.payer.developerId}:{})})));
      const decision=decisions[0];
      if(decision===undefined||decision.kind==="refusal"||decisions.some(other=>other.kind!=="resolved"||canonicalModelName(other.model)!==canonicalModelName(decision.model)||other.sourceId!==decision.sourceId||other.thinkingLevel!==decision.thinkingLevel))throw agentXError("MODEL_NOT_ALLOWED","The task's pinned stage model is unavailable. Check How we work.");
      const model:ModelSelection={...decision.model,...(decision.thinkingLevel===null?{}:{thinkingLevel:decision.thinkingLevel})};
      const step=stepForOperation(frozen.recipe,mode,input.programStepId);
      const recipe=ResolvedRecipeSchema.parse({...frozen.recipe,steps:frozen.recipe.steps.map(candidate=>candidate.id===step?.id?{...candidate,settings:{...candidate.settings,model,thinkingLevel:decision.thinkingLevel}}:candidate)});
      const stepIds=priorStepIds({recipe,mode,programStepId:input.programStepId,guardrails});
      const priorOperations=stepIds.length===0?[]:await priorStepModels(dependencies,workspace.id,recipe,stepIds);
      const applied=applyAgentStep({recipe,ref:task.agent,mode,programStepId:input.programStepId,guardrails,project:workspace.projectName,projectModel:model,projectApproved:frozen.modelPolicyPin.frozenInputs?.projectModels?.approved,chatgptModel:decision.sourceId==="personal-chatgpt"?model:undefined,priorOperations});
      return {...applied,model,ranModel:model,...(decision.fallback?.reasonCode==="DEFAULT_MODEL_UNAVAILABLE"&&(mode==="PLAN_CRITIQUE"?priorModels.plan!==undefined&&canonicalModelName(model)===canonicalModelName(priorModels.plan):mode==="REVIEW"&&priorModels.build!==undefined&&canonicalModelName(model)===canonicalModelName(priorModels.build))?(mode==="PLAN_CRITIQUE"?{criticSameModel:true as const}:mode==="REVIEW"?{reviewSameModel:true as const}:{}):{}),dropChatgpt:decision.sourceId!=="personal-chatgpt",stepName:stepNameOf(recipe,mode,input.programStepId),modelDecision:decision,modelCompanyRevision:frozen.modelPolicyPin.policy.revision,modelPolicy:{version:1,stage:stages[0]!,companyRevision:frozen.modelPolicyPin.policy.revision,recipeDigest:frozen.digest}};
    }
  }
  // Plan 6 Task 8: the plan check is an ordinary step. The model the company set on it stands; with none set, Rovara recommends one the project may use (a different one from the planner's by default).
  const critic = input.workflowMode === "PLAN_CRITIQUE" && input.agentRun === undefined
    ? await criticModelOfStep(dependencies, orgId, workspace, task, frozen.recipe, input.programStepId, guardrails, settings.definition.models?.approved, projectModel) : undefined;
  // Trust fix A2: the reviews of a version 2 task default to a different model from the build's, chosen like the plan check's; a model the company set on the step stands.
  const reviewer = input.workflowMode === "REVIEW" && input.agentRun === undefined && task.workflow?.definitionVersion === "1.1.0"
    ? await reviewerModelOfStep(dependencies, orgId, workspace, task, frozen.recipe, input.programStepId, guardrails, settings.definition.models?.approved, projectModel) : undefined;
  const recipe = critic?.recipe ?? reviewer?.recipe ?? frozen.recipe;
  const stepIds = priorStepIds({ recipe, mode: input.workflowMode, programStepId: input.programStepId, guardrails, agentRun: input.agentRun });
  const priorOperations = stepIds.length === 0 ? [] : await priorStepModels(dependencies, workspace.id, recipe, stepIds);
  const applied = applyAgentStep({
    recipe, ref: task.agent, mode: input.workflowMode, programStepId: input.programStepId, guardrails, project: workspace.projectName,
    projectModel, projectApproved: settings.definition.models?.approved, chatgptModel, priorOperations, agentRun: input.agentRun,
  });
  return { ...applied, stepName: input.agentRun?.step.name ?? stepNameOf(recipe, input.workflowMode, input.programStepId), ...(critic?.sameModelAsPlanner === true ? { criticSameModel: true as const } : {}), ...(reviewer?.sameModelAsBuilder === true ? { reviewSameModel: true as const } : {}) };
}

/**
 * Trust fix A2: the recipe the reviews run under. With no model set on the review step, `reviewerModelFor` chooses one for this one operation (a different model from the build's by default, only another
 * company's when the company requires it), set as the step's model so the step's ordinary checks and routing apply to it. A choice that can't be made leaves the recipe as it was, so the dispatch checks decide
 * exactly as before (the cross-company refusal included). The build's model is the one its latest operation recorded, else the project's; the models earlier reviews of this task found unusable are left out.
 */
async function reviewerModelOfStep(
  dependencies: AwsBrokerDependencies, orgId: OrgId, workspace: WorkspaceInstance, task: DeveloperTaskRecord, recipe: ResolvedRecipe, programStepId: string | undefined,
  guardrails: AgentGuardrails, approved: ReadonlyArray<ModelIdentifier> | undefined, projectModel: ModelSelection | undefined,
): Promise<{ recipe: ResolvedRecipe; sameModelAsBuilder: boolean }> {
  const step = stepForOperation(recipe, "REVIEW", programStepId);
  if (step === undefined) return { recipe, sameModelAsBuilder: false };
  const operations = (await queryAllItems(dependencies, `WORKSPACE#${workspace.id}`, "OPERATION#")).filter((item) => item.entityType === "OPERATION" && item.kind === "task");
  // The code under review is the latest build that finished; a later build that failed or was stopped left none.
  const builds = operations
    .filter((item) => item.workflowMode === "IMPLEMENT" && item.conversationId === task.conversationId)
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  const builder = builds.filter((item) => item.status === "SUCCEEDED").at(-1) ?? builds.at(-1);
  const recorded = ModelSelectionSchema.safeParse(builder?.model);
  const routing = routingOf(dependencies);
  // When nothing is chosen the step runs on the project's model (the dispatch's own fallback); when that is the build's model, the review says so.
  const fallback = projectModel ?? defaultWorkerModel(routing?.rovaraGeography);
  const own = (step.settings ?? {}) as { model?: unknown; fallbackModel?: unknown };
  const unchanged = { recipe, sameModelAsBuilder: own.model == null && own.fallbackModel == null && recorded.success && canonicalModelName(recorded.data) === canonicalModelName(fallback) };
  const history = reviewFailures(operations, builder);
  if (history.sinceLatestBuild >= CRITIC_MODEL_ATTEMPTS_MAX) return unchanged;
  // The models of the steps this review must differ in company from; one that recorded none can't be shown to differ, so nothing is chosen and the dispatch's own check decides.
  const targets = crossCompanyTargets(recipe, step, guardrails);
  const priors = targets.length === 0 ? [] : await priorStepModels(dependencies, workspace.id, recipe, targets);
  if (priors.some((prior) => prior.model === undefined)) return unchanged;
  const chosen = reviewerModelFor({
    step, builderModel: recorded.success ? recorded.data : fallback,
    project: { approved }, guardrails, differentCompanyFrom: priors.flatMap((prior) => (prior.model === undefined ? [] : [prior.model])),
    sources: routing === undefined ? [] : await servableModels(routing, orgId, workspace.projectName),
    unusable: history.models, lastAttempt: history.sinceLatestBuild + 1 >= CRITIC_MODEL_ATTEMPTS_MAX,
  });
  // The company's own model stands and says nothing; a choice that couldn't be made leaves the project's model, which may be the build's.
  if (chosen?.chosenBy === "company") return { recipe, sameModelAsBuilder: false };
  if (chosen === undefined) return unchanged;
  return {
    recipe: { ...recipe, steps: recipe.steps.map((candidate) => (candidate.id === step.id ? { ...candidate, settings: { ...candidate.settings, model: chosen.model } } as ResolvedStep : candidate)) },
    sameModelAsBuilder: chosen.sameModelAsBuilder,
  };
}

/**
 * The reviews of one workspace whose model could not serve this account (`criticModelUnusable`): the models they ran on, and how many came after the latest build. A review fails this way in two shapes:
 * its operation ended FAILED with the refusal (the operation's own session was refused first), or the operation SUCCEEDED and a reviewer's report says its model call failed (`modelFailure`, a fixed sentence
 * the worker wrote from the model-call monitor's note, on the report's own provider and version). Each operation counts once.
 */


/**
 * Plan 6 Task 8: the recipe the plan check runs under. The company's own choice for the step is left as it is (the step's ordinary checks apply to it in `applyAgentStep`); with none,
 * Rovara's recommendation (`criticModelFor`) is set as the step's model for this one operation, so it is checked and routed like any model a step names. The planner's model is the one the
 * latest planning operation recorded, else the project's. The sources are the ones this org's project walks, so a model of another org's is never offered. A refusal is thrown (Plan 3's words).
 */
async function criticModelOfStep(
  dependencies: AwsBrokerDependencies, orgId: OrgId, workspace: WorkspaceInstance, task: DeveloperTaskRecord, recipe: ResolvedRecipe, programStepId: string | undefined,
  guardrails: AgentGuardrails, approved: ReadonlyArray<ModelIdentifier> | undefined, projectModel: ModelSelection | undefined,
): Promise<{ recipe: ResolvedRecipe; sameModelAsPlanner: boolean }> {
  const step = stepForOperation(recipe, "PLAN_CRITIQUE", programStepId);
  const operations = (await queryAllItems(dependencies, `WORKSPACE#${workspace.id}`, "OPERATION#")).filter((item) => item.entityType === "OPERATION" && item.kind === "task");
  const planner = operations
    .filter((item) => item.workflowMode === "PLAN" && item.conversationId === task.conversationId)
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt))).at(-1);
  const recorded = ModelSelectionSchema.safeParse(planner?.model);
  // Staging 0.4.10: Bedrock answered 403 for the strongest model, which this account had not enabled. The checks that failed that way already named the models to leave out, and only so many are tried.
  const history = criticFailures(operations, planner);
  if (history.sinceLatestPlan >= CRITIC_MODEL_ATTEMPTS_MAX) throw new PlanCheckUnavailableError();
  const routing = routingOf(dependencies);
  const chosen = criticModelFor({
    step, agentName: task.agent?.name ?? ROVARA_CODE_NAME, planModel: recorded.success ? recorded.data : projectModel ?? defaultWorkerModel(routing?.rovaraGeography),
    project: { name: workspace.projectName, approved }, guardrails,
    sources: routing === undefined ? [] : await servableModels(routing, orgId, workspace.projectName),
    unusable: history.models,
    lastAttempt: history.sinceLatestPlan + 1 >= CRITIC_MODEL_ATTEMPTS_MAX,
  });
  if ("refuse" in chosen) throw chosen.refuse;
  if ("unavailable" in chosen) throw new PlanCheckUnavailableError();
  if (step === undefined || chosen.chosenBy === "company" || chosen.model === undefined) return { recipe, sameModelAsPlanner: chosen.sameModelAsPlanner };
  return {
    recipe: { ...recipe, steps: recipe.steps.map((candidate) => (candidate.id === step.id ? { ...candidate, settings: { ...candidate.settings, model: chosen.model } } as ResolvedStep : candidate)) },
    sameModelAsPlanner: chosen.sameModelAsPlanner,
  };
}

/**
 * The plan checks of one workspace that failed because their model could not serve this account (`criticModelUnusable`): the models they ran on, to leave out of the next choice, and how many
 * of them came after the latest planning run (a revised plan is checked again, with the earlier refusals remembered but the tries counted afresh). A failed check that recorded no usable model counts as a try.
 */


/** The models the workspace's earlier coding operations ran on, by the recipe step each was; one that recorded none has no model. */
async function priorStepModels(dependencies: AwsBrokerDependencies, workspaceId: string, recipe: ResolvedRecipe, stepIds: readonly string[]): Promise<Array<{ stepId: string; model?: ModelSelection }>> {
  const found: Array<{ stepId: string; model?: ModelSelection }> = [];
  for (const item of await queryAllItems(dependencies, `WORKSPACE#${workspaceId}`, "OPERATION#")) {
    if (item.entityType !== "OPERATION" || item.kind !== "task") continue;
    // An agent-step run's operation names its recipe step itself (it has no coding mode); a coding operation is the step its mode and program step say.
    if (item.workflowMode === undefined && typeof item.programStepId !== "string") continue;
    const model = ModelSelectionSchema.safeParse(item.model);
    const stepId = item.workflowMode === undefined ? item.programStepId as string
      : stepForOperation(recipe, item.workflowMode as DispatchMode, typeof item.programStepId === "string" ? item.programStepId : undefined)?.id;
    // An operation that recorded no model ran on one nobody knows (the worker's default): it is kept, so the comparison fails closed instead of passing.
    if (stepId !== undefined && stepIds.includes(stepId)) found.push({ stepId, ...(model.success ? { model: model.data } : {}) });
  }
  return found;
}

/**
 * #341 with the org's say (Task 24b): where the install runs the model proxy, the org's source order decides whether ChatGPT is used at all. An org
 * whose sources cannot be read cannot verify either the plan or a replacement route.
 */
async function chatGptSelectionForOrg(dependencies: AwsBrokerDependencies, orgId: OrgId, owner: string | undefined): ReturnType<typeof chatGptTaskSelection> {
  if (dependencies.modelAccess === undefined) return chatGptTaskSelection(dependencies.chatgpt, owner);
  let orgSources: Awaited<ReturnType<ModelSourceStore["orgSources"]>>;
  try {
    orgSources = await modelSourceStoreOf(dependencies).orgSources(orgId);
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "model_sources.unreadable", errorName: error instanceof Error ? error.name : "unknown" }));
    throw agentXError("RUNTIME_UNAVAILABLE","The model sources could not be verified. Reload and try again.");
  }
  return chatGptTaskSelection(dependencies.chatgpt, owner, Date.now(), orgSources);
}

/** A task operation, its worker invocation and outbox item: acceptTask's and the first developer task's (R3). */
export async function taskOperationParts(
  dependencies: AwsBrokerDependencies,
  workspace: WorkspaceInstance,
  input: { requestId: string; conversationId: string; prompt: string; conversationStarted: boolean; requester: { requestedBy?: OperationRequester }; orgId?: OrgId; operationId?: string; shared?: boolean; planRevision?: true; legacyTask?: boolean; workflowMode?: "UNDERSTAND" | "PLAN" | "PLAN_CRITIQUE" | "IMPLEMENT" | "REVIEW" | "CHECKS" | "FEEDBACK_REVIEW" | "SETUP_DRAFT" | "SPEC_WRITE"; specWrite?: SpecWriteBinding; workflowReviewSpec?: SpecReviewInput; workflowPhase?: "REQUIREMENTS" | "DESIGN" | "IMPLEMENTATION_PLAN"; readiness?: ProjectCommand[]; workflowFeedbackReview?: { taskId: string; workflowRevision: number; candidateDigest: string }; workflowFeedbackApproval?: WorkflowFeedbackApprovalBinding; workflowE2EAdmission?: E2EWorkflowAdmissionRef; workflowE2EBaselineSource?: true; workflowDependencies?: WorkflowDependencyInvocation; workflowBase?: WorkflowReviewBase; workflowReviewChecks?: WorkflowReviewChecks; workflowReviewPlan?: WorkflowReviewPlan; workflowReviewFeedback?: WorkflowReviewFeedback; workflowReviewNote?: WorkflowReviewNote; programStepId?: string; workflowReviewers?: ReadonlyArray<"CRITIC" | "SECURITY">; workflowReviewRisk?: true; workflowFix?: WorkflowFixPayload; retiredClaimIds?: readonly string[]; slackThread?: SlackThread; agentRun?: AgentRunStepInput },
  now: string,
): Promise<{ operation: OperationRecord; outbox: ReturnType<typeof outboxRecord>; fence: number;modelChecks?:TransactItems;turnAudit?:ReturnType<typeof prepareTurnModelFallback>;fallback?:Awaited<ReturnType<typeof prepareTaskModelFallback>> }> {
  // Ruling R60, as a backstop for any launch path that did not check first: a task whose creator was removed starts nothing.
  await requireWorkspaceCreatorStillMember(creatorCheckOf(dependencies), workspace.id);
  // The caller's org when there is one (a Slack thread's is its team's); a background writer reads it from the record.
  const orgId = input.orgId ?? await orgOfRecord(dependencies, workspace);
  const settings = await requireLatestProject(dependencies, orgId, workspace.projectName);
  const resolvedModel:Awaited<ReturnType<typeof resolveProjectModel>> = input.workflowMode === "CHECKS" ? {} : await resolveProjectModel(dependencies, orgId, settings);
  const task = await workspaceTask(dependencies, workspace.id);
  // #341: a task whose owner connected a working ChatGPT plan runs on it; `model` stays the default it falls back to.
  const frozen=task?.agent===undefined?undefined:await readTaskRecipe(dependencies,task.taskId,orgId);
  const governed=frozen?.modelPolicyPin!==undefined&&recipeRunner(frozen.recipe)==="coding"&&input.agentRun===undefined;
  const planOwner = governed||task?.payer!==undefined?(task?.payer?.kind==="member"?task.payer.developerId:undefined):chatGptOwner(task?.developerId, input.requester.requestedBy, developerIdForSlackUser);
  const planSelection = dependencies.chatgpt === undefined || input.workflowMode === "CHECKS" || input.agentRun !== undefined ? undefined
    : await chatGptSelectionForOrg(dependencies, orgId, planOwner);
  const turnMapping=!governed&&input.agentRun===undefined&&input.workflowMode!=="CHECKS"?turnStagesForMode(input.workflowMode??"IMPLEMENT"):undefined;
  // Plan 3, Task 16: the recipe the task froze at its start (never the live agent) decides this step's model, instructions and worker settings.
  let applied = await dispatchAgentStep(dependencies, orgId, workspace, task, input, settings, resolvedModel.model, planSelection?.model,frozen);
  const turnActor=task===undefined?chatGptOwner(undefined,input.requester.requestedBy,developerIdForSlackUser):effectiveTaskOwner(task).developerId;
  let turnPolicy:Awaited<ReturnType<typeof prepareTurnModelPolicy>>|undefined;
  if(!governed&&input.agentRun===undefined&&input.workflowMode!=="CHECKS") {
    const signInTableName=dependencies.developer?.signInTableName;
    const signInStore=signInTableName===undefined?undefined:new DeveloperSignInStore({documentClient:dependencies.documentClient,tableName:signInTableName,nameTableName:dependencies.tableName,now:Date.now});
    let slackBasis: {slackUserId:string;slackTask?:{taskId:string;threadTs:string};threadChannel:{teamId:string;channelId:string}}|undefined;
    if(task===undefined&&input.slackThread!==undefined&&input.requester.requestedBy!==undefined&&!("kind" in input.requester.requestedBy))slackBasis={slackUserId:input.requester.requestedBy.userId,threadChannel:{teamId:input.slackThread.teamId,channelId:input.slackThread.channelId}};
    else if(task?.provider==="slack"&&task.slackUserId!==undefined&&task.share?.threadTs!==undefined&&(signInStore===undefined||await signInStore.getDeveloper(turnActor??"")===undefined)) {
      const shared=await getItem<SharedTaskRecord>(dependencies,sharedTaskKey({teamId:task.share.teamId,channelId:task.share.channelId,threadTs:task.share.threadTs}));
      if(shared?.workflowThread===true&&shared.taskId===task.taskId&&shared.workspaceId===workspace.id&&shared.developerId===task.developerId)slackBasis={slackUserId:task.slackUserId,slackTask:{taskId:task.taskId,threadTs:task.share.threadTs},threadChannel:{teamId:task.share.teamId,channelId:task.share.channelId}};
    }
    if(turnActor===undefined||signInStore===undefined&&slackBasis===undefined)throw agentXError("RUNTIME_UNAVAILABLE","The turn's model authority is unavailable.");
    const actorDeveloperId=signInStore===undefined?turnActor:await followMerges(signInStore,turnActor);
    const payerDeveloperId=planOwner===undefined?undefined:signInStore===undefined?planOwner:await followMerges(signInStore,planOwner);
    const referenceScope={orgId,workspaceId:workspace.id,conversationId:input.conversationId,taskId:task?.taskId??workspace.id};
    const turnOperations=turnMapping?.stages.some(stage=>stage==="code_review"||stage==="security_review"||stage==="plan_check")?await queryAllItems(dependencies,`WORKSPACE#${workspace.id}`,"OPERATION#"):[];
    turnPolicy=await prepareTurnModelPolicy({...dependencies,store:new AgentStore({documentClient:dependencies.documentClient,tableName:dependencies.tableName,now:Date.now,...(dependencies.agents?.builtins===undefined?{}:{builtins:dependencies.agents.builtins})}),routing:routingOf(dependencies,true)??{},now:Date.now},{orgId,project:workspace.projectName,actorDeveloperId,...(slackBasis??{}),workflowMode:input.workflowMode??"IMPLEMENT",priorModels:taskStageReferences(turnOperations,referenceScope),...(payerDeveloperId===undefined?{}:{payerDeveloperId}),...(planSelection===undefined?{}:{defaultPreferred:planSelection.model})});
    const actorChecks=await readTurnActorChecks({...dependencies,allowImplicitSlack:dependencies.orgResolver===undefined,...(signInStore===undefined?{}:{signInStore}),...(signInTableName===undefined?{}:{modelSignInTableName:signInTableName})},{orgId,project:workspace.projectName,developerId:actorDeveloperId,...(task===undefined?{}:{task}),projectRevision:turnPolicy.projectRevision,...(turnPolicy.frozen.slackUserId===undefined?{}:{slackUserId:turnPolicy.frozen.slackUserId}),...(turnPolicy.frozen.threadChannel===undefined?{}:{threadChannel:turnPolicy.frozen.threadChannel})});
    if(slackBasis?.slackTask!==undefined)turnPolicy.checks.push({ConditionCheck:{TableName:dependencies.tableName,Key:sharedTaskKey({...slackBasis.threadChannel,threadTs:slackBasis.slackTask.threadTs}),ConditionExpression:"taskId = :slackTask AND workspaceId = :slackWorkspace AND developerId = :slackActor AND workflowThread = :workflow",ExpressionAttributeValues:{":slackTask":slackBasis.slackTask.taskId,":slackWorkspace":workspace.id,":slackActor":task!.developerId,":workflow":true}}});
    turnPolicy.checks.push(...actorChecks,...taskStageReferenceChecks(dependencies.tableName,turnOperations,referenceScope,turnPolicy.binding.stage));
  }
  if(!governed&&input.agentRun===undefined&&input.workflowMode!=="CHECKS"&&turnPolicy===undefined)throw agentXError("RUNTIME_UNAVAILABLE","The turn's model authority is unavailable.");
  if(turnPolicy!==undefined) {
    applied={...applied,model:turnPolicy.model,ranModel:turnPolicy.model,stepName:turnPolicy.stepName,dropChatgpt:turnPolicy.decision.sourceId!=="personal-chatgpt",modelDecision:turnPolicy.decision,modelCompanyRevision:turnPolicy.binding.companyRevision,modelPolicy:turnPolicy.binding};
  }
  // Governed stages resolve the pinned precedence themselves; an ungoverned coding choice cannot silently become the default.
  if(resolvedModel.selectionUnavailable===true&&(applied?.modelDecision===undefined||applied.modelDecision.reason==="PROJECT_SELECTION")&&input.workflowMode!=="CHECKS"&&input.agentRun===undefined)throw agentXError("MODEL_NOT_ALLOWED","The project model selection is unavailable. Check How we work.");
  // A step that picks a model of its own which the person's plan does not serve runs on the model proxy, not on the plan. An agent step of a run never
  // uses a person's ChatGPT plan: the run is the agent's work (it may be started by an event or paid for by a project), not the person's own coding turn.
  let chatgpt = applied?.dropChatgpt === true || input.agentRun !== undefined ? undefined : planSelection;
  // Governed personal plans execute the exact verified resolver tuple, never the connection's preferred model.
  if(applied?.modelDecision?.sourceId==="personal-chatgpt") {
    if((turnPolicy===undefined&&task?.payer?.kind!=="member")||applied.model===undefined)throw agentXError("RUNTIME_UNAVAILABLE","The task's verified personal model is unavailable.");
    chatgpt={developerId:turnPolicy?.frozen.payerDeveloperId??(task!.payer as {developerId:string}).developerId,model:applied.model};
  }
  // Task 26: the order of the company's AI sources decides where the model comes from. The plan is kept only if no source listed before it serves its model; the
  // key the worker is later given is scoped to the route chosen here, and the route is recorded on the operation so the key can be checked again when asked for.
  const routing = routingOf(dependencies,true);
  const routed = routing === undefined || input.workflowMode === "CHECKS" ? undefined : await routeStep(routing, {
    orgId, project: workspace.projectName, agent: task?.agent?.name ?? ROVARA_CODE_NAME, step: applied?.stepName ?? stepNameOf(undefined, input.workflowMode),
    model: applied?.model ?? resolvedModel.model,
    expectedSourceId: applied?.modelDecision?.sourceId,
    ...(chatgpt === undefined ? {} : { plan: { developerId: chatgpt.developerId, model: chatgpt.model } }),
  });
  const payloadModel: ModelSelection | undefined = applied?.model ?? resolvedModel.model ?? (routed?.route == null ? undefined : routed.requested);
  const leftThePlan = chatgpt !== undefined && routed?.keepChatgpt === false;
  if (leftThePlan) chatgpt = undefined;
  const operationId = input.operationId ?? randomUUID();
  const fence = workspace.fence + 1;
  const operation = operationRecord({
    ...operationOrg(workspace),
    id: operationId,
    workspaceId: workspace.id,
    conversationId: input.conversationId,
    kind: "task",
    ...(input.workflowMode === undefined ? {} : { workflowMode: input.workflowMode }),
    ...(input.workflowFeedbackReview === undefined ? {} : { workflowFeedbackReview: input.workflowFeedbackReview }),
    ...(input.workflowFeedbackApproval === undefined ? {} : { workflowFeedbackApproval: input.workflowFeedbackApproval }),
    ...(input.workflowE2EAdmission === undefined ? {} : { workflowE2EAdmission: input.workflowE2EAdmission }),
    ...(input.workflowDependencies === undefined ? {} : { workflowDependencies: input.workflowDependencies }),
    // The step of the workflow program this operation runs, for the per-step settings the dispatch applies.
    ...(input.programStepId === undefined ? {} : { programStepId: input.programStepId }),
    requestId: input.requestId,
    payloadHash: hashJson({ conversationId: input.conversationId, prompt: input.prompt,
      ...(input.workflowReviewNote === undefined ? {} : { workflowReviewNote: input.workflowReviewNote }),
      ...(input.workflowReviewers === undefined ? {} : { workflowReviewers: input.workflowReviewers }),
      ...(input.workflowReviewRisk === true ? { workflowReviewRisk: true as const } : {}),
      ...(input.workflowFix === undefined ? {} : { workflowFix: input.workflowFix }),
      ...(input.workflowDependencies === undefined ? {} : { workflowDependencies: input.workflowDependencies }),
      ...(input.workflowE2EAdmission === undefined ? {} : { workflowE2EAdmission: input.workflowE2EAdmission }) }),
    status: "ACCEPTED",
    fence,
    createdAt: now,
    updatedAt: now,
    ...input.requester,
  });
  operation.settingsRevision = settings.definition.revision;
  // Plan 6 Task 8: the project allows only one model, so the same model that wrote the plan checks it; the plan view says so.
  if (applied?.criticSameModel === true) operation.criticSameModel = true;
  // Trust fix A2: only the build's own model was usable for the reviews; their reports say so.
  if (applied?.reviewSameModel === true) operation.reviewSameModel = true;
  // Plan 6 Task 8: the one revision a plan check asked for. No person asked for it, so it may never pause the task or ask for money (see handleModelAccess and the budget-stop paths).
  if (input.planRevision === true) operation.planRevision = true;
  // The model this operation runs on, kept so a later step that must differ in company from this one can be compared with it.
  const ranModel = leftThePlan ? applied?.model : applied?.ranModel;
  if (ranModel !== undefined) operation.model = ranModel;
  if(applied?.modelPolicy!==undefined&&task!==undefined){operation.modelPolicy=applied.modelPolicy;operation.modelTaskId=task.taskId;}
  if(turnPolicy!==undefined){operation.modelPolicy=turnPolicy.binding;operation.modelTurnPin=turnPolicy.frozen;delete operation.modelTaskId;}
  const turnAudit=turnPolicy?.decision.fallback===undefined?undefined:prepareTurnModelFallback({...dependencies,now:Date.now},{orgId,taskId:operationId,project:workspace.projectName,operationId,occurredAt:now,companyRevision:turnPolicy.binding.companyRevision,decision:turnPolicy.decision});
  if(turnAudit!==undefined)Object.assign(operation,turnAudit.fields);
  if (routed !== undefined) {
    operation.modelRoute = routed.route?.alias === undefined ? null : { sourceId: routed.route.sourceId, alias: routed.route.alias, model: routed.requested };
  }
  if (chatgpt !== undefined) {
    operation.chatgptDeveloperId = chatgpt.developerId;
    // #342: where a fallback is told when the task ends.
    if (input.slackThread !== undefined) operation.chatgptThread = { teamId: input.slackThread.teamId, channelId: input.slackThread.channelId, threadTs: input.slackThread.threadTs };
  }
  // A PR feedback review this release starts is given only the owner's notes for its round; its answer is checked against that alone.
  if (input.workflowFeedbackReview !== undefined) operation.feedbackNotesScoped = true;
  // 25c note 1: the hash above is the request's own; only the worker's copy gets the re-read line.
  // Spec 061: every planning step answers with a structured plan document; a Quick plan (no phase) is a whole coding plan.
  const planKind = input.workflowPhase === "REQUIREMENTS" ? "requirements" as const : input.workflowPhase === "DESIGN" ? "design" as const : "plan" as const;
  // Only a coding plan (a Quick plan, or a Full implementation plan) proposes checks; requirements and design do not.
  const codingPlan = input.workflowPhase === undefined || input.workflowPhase === "IMPLEMENTATION_PLAN";
  const workBreakdownContext = codingPlan && input.workflowMode === "PLAN" && input.legacyTask !== true
    ? await codingPlanWorkBreakdownContext(dependencies, workspace.id)
    : undefined;
  const e2ePlanningContext = codingPlan && input.workflowMode === "PLAN" && input.legacyTask !== true
    ? await codingPlanFeatureE2EContext(dependencies, workspace.id)
    : undefined;
  // Recorded so the broker can refuse a v2 plan from a run that was never asked for one (Ruling AW).
  if (input.workflowMode === "PLAN" && offersApplicationE2EPlan(e2ePlanningContext)) operation.workflowE2EPlanVersion = 2;
  // The part of the context the plan self-check reads is kept on the run, so the check at its result sees exactly what the planner was told.
  const qualityContext = planQualityContextOf(e2ePlanningContext);
  if (input.workflowMode === "PLAN" && codingPlan && qualityContext !== undefined) operation.planQualityContext = qualityContext;
  // The prompt below carries the plan quality guidance; delivery clears this for a worker that cannot read the members it names (see createPlanQualityNegotiationRecorder).
  if (input.workflowMode === "PLAN" && codingPlan) operation.planQualityAsked = true;
  const requiredParts = codingPlan && input.workflowMode === "PLAN" && input.legacyTask !== true && await codingPlanRequiresParts(dependencies, workspace.id);
  const documentInstructions = planDocumentInstructions({ kind: planKind, path: input.workflowPhase === undefined ? "QUICK" : "FULL", anchors: true, planQuality: true,
    // Rovara Code version 2 only: a plan may say that no code change is needed (version 1's prompt, and so its recorded behaviour, is unchanged).
    ...(task?.workflow?.definitionVersion === "1.1.0" ? { noChangeOption: true } : {}),
    ...(requiredParts ? { requiredParts: true } : {}),
    ...(workBreakdownContext === undefined ? {} : { workBreakdownContext }),
    ...(e2ePlanningContext === undefined ? {} : { e2ePlanningContext }),
    ...(input.retiredClaimIds === undefined ? {} : { retired: input.retiredClaimIds }) });
  const planChecks = codingPlan && input.workflowMode === "PLAN" ? await codingPlanChecksInstructions(dependencies, workspace.id) : "";
  const checksInstructions = planChecks === "" ? "" : `\n\n${planChecks}`;
  // A task started without the workflow still runs its first turn in IMPLEMENT mode; its prompt is unchanged.
  const gated = input.workflowMode !== undefined && input.legacyTask !== true;
  // The agent's instructions come after Rovara's own rules and the phase text, in a block that says it adds to them (Plan 3, Task 16).
  const agentSection = applied?.promptSection === undefined ? "" : `\n\n${applied.promptSection}`;
  const selectedPrompt = input.workflowMode === "SETUP_DRAFT"
    ? `${SETUP_DRAFT_PREAMBLE}${agentSection}\n\nRequest:\n${input.prompt}`
    // Meta repo lane D: the spec write sees the approved plan (the prompt) and nothing else the thread said; no agent section, no thread notes.
    : input.workflowMode === "SPEC_WRITE"
    ? `${WORKFLOW_PREAMBLE}\n\nSpec writing phase only. Do not edit, write, or create files or run commands that change anything.\n\n${input.prompt}`
    : input.workflowMode === "PLAN"
    ? `${WORKFLOW_PREAMBLE}\n\nPlanning phase only. Do not edit, write, or create files. Inspect the request and repository. ${PLAN_PHASE_LIMITS} Avoid filler and include only material risks or genuine unanswered questions. This linked detail is shown to the owner for approval before the next phase or code changes.\n\n${documentInstructions}${checksInstructions}${agentSection}\n\nRequest:\n${input.prompt}`
    : input.workflowMode === "REVIEW"
      ? `${WORKFLOW_PREAMBLE}\n\nReview the current code read-only for the current task. Do not edit files or run commands that modify the workspace. Return concise critic and security review findings. The broker will bind your reports to this operation and candidate.${agentSection}\n\n${input.prompt}`
      : gated ? `${WORKFLOW_PREAMBLE}${agentSection}\n\n${input.prompt}` : `${applied?.promptSection === undefined ? "" : `${applied.promptSection}\n\n`}${input.prompt}`;
  const prompt = workerPrompt(selectedPrompt, input.shared === true);
  // The preamble and phase text are added to the approved document after the request was size-checked.
  if (gated && Buffer.byteLength(prompt, "utf8") > OPERATION_PROMPT_MAX_BYTES) {
    throw agentXError("CONFIG_INVALID", "the approved document is too long to send to the worker");
  }
  if (input.shared === true && prompt === selectedPrompt) {
    console.log(JSON.stringify({ component: "broker", event: "developer.shared_reread_omitted", operationId }));
  }
  // M1.3 Task 3.7b: the coding run exports the unchanged code when approval asked for it, and again on any later coding run (a retry) while the baseline is still only requested.
  // T7b: a coding plan run that negotiates the application plan is asked for the unchanged code too, so the plan's must-not-change scenarios can be tried on the current app before the
  // owner is asked. The worker exports only when the plan it wrote has such scenarios; delivery withholds the request from a worker that cannot (see withoutGroundingSource). A project that
  // switched the baseline off gets no grounding either.
  const askGroundingSource = input.workflowMode === "PLAN" && codingPlan && input.legacyTask !== true && offersApplicationE2EPlan(e2ePlanningContext) && projectE2EBaselineWanted(settings);
  if (askGroundingSource) operation.groundingSourceAsked = true;
  const askBaselineSource = input.workflowE2EBaselineSource === true || (input.workflowMode === "IMPLEMENT" && await baselineSourceStillRequested(dependencies, workspace.id));
  // Lane E: the project's MCP context sources, in the four stages that may read them and never in Build (stageHasContextSources).
  const contextToolsOn = await stageHasContextSources({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now, contextSourcesConfigured: dependencies.contextSources !== undefined }, orgId, workspace.projectName, input.workflowMode);
  const invocation: WorkerInvocation = {
    protocolVersion: 1,
    kind: "task",
    operationId,
    workspaceId: workspace.id,
    fence,
    projectRevision: workspace.projectRevision,
    callbackCapability: issueCapability(dependencies, workspace.id, operationId, fence, {
      modelPolicy:applied?.modelPolicy,
      feedbackBundles: input.workflowMode === "FEEDBACK_REVIEW", feedbackApproval: input.workflowFeedbackApproval !== undefined, chatGptToken: chatgpt !== undefined,
      candidateExport: input.workflowMode === "IMPLEMENT", groundingSource: askGroundingSource, workflowE2E: input.workflowE2EAdmission !== undefined, modelAccess: dependencies.modelAccess !== undefined && (input.workflowMode !== "CHECKS" || input.agentRun !== undefined),
      // The AI browser-test agent's model budget (M1.4): only a round that has agent steps may ask for it.
      e2eModelBudget: input.workflowE2EAdmission?.agentSteps === true,
      // The worker reads the step's skills through the broker, which serves only the snapshot's, so the capability is granted only when the step has some.
      agentSkills: (applied?.agentStep?.skills?.length ?? 0) > 0,
      // The connector tools of an agent step whose recipe grants some (Task 19); the broker serves only the granted ones.
      agentTools: givesAgentTools(applied),
      contextTools: contextToolsOn,
    }),
    payload: {
      conversationId: input.conversationId,
      prompt,
      conversationStarted: input.conversationStarted,
      ...(input.workflowMode === undefined ? {} : { workflowMode: input.workflowMode }),
      // Meta repo lane B: a setup proposal run is told which repository is the project's meta repository, so it looks there for the team's rules, specs and runbooks.
      ...(input.workflowMode === "SETUP_DRAFT" && metaRepositoryOf(settings.definition) !== undefined ? { setupMetaRepo: metaRepositoryOf(settings.definition)!.name } : {}),
      // The worker reads a planning answer as this kind of document (a Quick plan has no phase and is a coding plan).
      ...(input.workflowMode === "PLAN" && input.workflowPhase !== undefined ? { workflowPhase: input.workflowPhase } : {}),
      // Every planning step asks for a structured plan, so the worker checks the answer and asks once more when it is unreadable.
      ...(input.workflowMode === "PLAN" ? { planFormat: "structured" as const } : {}),
      // The prompt asks for the v2 application intent exactly when the context offers executable kinds; the worker is asked to parse it only then.
      ...(input.workflowMode === "PLAN" && offersApplicationE2EPlan(e2ePlanningContext) ? { workflowE2EPlanVersion: 2 as const } : {}),
      ...(input.workflowFeedbackReview === undefined ? {} : { workflowFeedbackReview: input.workflowFeedbackReview }),
      ...(input.workflowFeedbackApproval === undefined ? {} : { workflowFeedbackApproval: input.workflowFeedbackApproval }),
      ...(input.workflowE2EAdmission === undefined ? {} : { workflowE2EAdmission: input.workflowE2EAdmission }),
      ...(askBaselineSource ? { workflowE2EBaselineSource: true as const } : {}),
      ...(askGroundingSource ? { workflowE2EGroundingSource: true as const } : {}),
      ...(input.workflowDependencies === undefined ? {} : { workflowDependencies: input.workflowDependencies }),
      ...(input.workflowBase === undefined ? {} : { workflowBase: input.workflowBase }),
      ...(input.workflowReviewChecks === undefined ? {} : { workflowReviewChecks: input.workflowReviewChecks }),
      ...(input.workflowReviewPlan === undefined ? {} : { workflowReviewPlan: input.workflowReviewPlan }),
      ...(input.workflowReviewFeedback === undefined ? {} : { workflowReviewFeedback: input.workflowReviewFeedback }),
      ...(input.workflowReviewNote === undefined ? {} : { workflowReviewNote: input.workflowReviewNote }),
      ...(input.workflowReviewers === undefined ? {} : { workflowReviewers: [...input.workflowReviewers] }),
      ...(input.workflowReviewRisk === true ? { workflowReviewRisk: true as const } : {}),
      // Plan 6 Task 15: the run fixes a pull request that is already open; a worker without "task.workflowFix" is refused the run at delivery, never sent it without the field.
      ...(input.workflowFix === undefined ? {} : { workflowFix: input.workflowFix }),
      // Meta repo lane D: the spec write's binding; a worker without "task.specWrite.v1" is refused the run at delivery, never sent it without the field.
      ...(input.specWrite === undefined ? {} : { specWrite: input.specWrite }),
      // Meta repo lane D (D3): the spec's requirements for the code review; a worker without "task.workflowReviewSpec.v1" is refused the review at delivery, never sent it without them.
      ...(input.workflowReviewSpec === undefined ? {} : { workflowReviewSpec: input.workflowReviewSpec }),
      // Lane E: a worker without "task.contextSources.v1" is refused the stage at delivery, never sent it without the field.
      ...(contextToolsOn ? { contextSources: true as const } : {}),
      // Task 26 (review I1): when a route was chosen the worker is told the model it was chosen for, never left to its install setting, which the key may not allow.
      ...(payloadModel === undefined ? {} : { model: payloadModel }),
      ...(applied?.modelPolicy===undefined?{}:{modelPolicy:applied.modelPolicy}),
      ...(chatgpt === undefined ? {} : { chatgpt: { model: chatgpt.model } }),
      ...(routed?.wire === undefined ? {} : { modelRoute: routed.wire }),
      ...(applied?.agentStep === undefined ? {} : { agentStep: applied.agentStep }),
      // Spec 051 (P-1): the checks the worker reruns when the agent finishes. The latest revision's readiness, as
      // publicationProject merges it, since that is what publication gates on. None when the project has none.
      ...(input.agentRun !== undefined || input.workflowMode === "SETUP_DRAFT" || input.workflowMode === "SPEC_WRITE" || (input.readiness ?? settings.definition.readiness).length === 0 ? {} : { readiness: input.readiness ?? settings.definition.readiness }),
    },
  };
  const fallback=turnPolicy!==undefined||applied?.modelDecision?.fallback===undefined?undefined:await prepareTaskModelFallback({...dependencies,now:Date.now},{orgId,taskId:task!.taskId,project:workspace.projectName,operationId,occurredAt:now,companyRevision:applied.modelCompanyRevision!,decision:applied.modelDecision});
  if(fallback?.replayed===true)throw agentXError("IDEMPOTENCY_CONFLICT","The fallback operation has already been recorded.");
  const modelChecks=turnPolicy===undefined?undefined:[...turnPolicy.checks,...(turnAudit?.items??[])];
  if(modelChecks!==undefined&&modelChecks.length>25)throw new TurnAdmissionLimitError(modelChecks.length,25);
  return { operation, outbox: outboxRecord(workspace, invocation), fence,...(modelChecks===undefined?{}:{modelChecks}),...(turnAudit===undefined?{}:{turnAudit}),...(fallback===undefined?{}:{fallback}) };
}

/** Whether the workspace's task has a baseline round that is requested and not yet started, so a coding run is to export the unchanged code. Never throws: a baseline never stops the coding. */
async function baselineSourceStillRequested(dependencies: AwsBrokerDependencies, workspaceId: string): Promise<boolean> {
  try {
    const pointer = await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(workspaceId));
    const task = pointer === undefined ? undefined : await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
    if (task === undefined) return false;
    return (await readWorkflowE2EBaselineRecord({ documentClient: dependencies.documentClient, tableName: dependencies.tableName }, task))?.state === "REQUESTED";
  } catch { return false; }
}

/**
 * The coding plan's checks instructions for the workspace's task: the repository paths of the task's starting project
 * revision (the one the plan's proposal is checked against) and the project checks its policy always runs. None for a
 * task stored without a check policy: it runs the project's checks, and a proposal would be ignored.
 */
async function codingPlanChecksInstructions(dependencies: AwsBrokerDependencies, workspaceId: string): Promise<string> {
  const pointer = await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(workspaceId));
  const task = pointer === undefined ? undefined : await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
  if (task === undefined) throw agentXError("CONFIG_INVALID", "the task for this planning step is missing");
  if (task.workflow?.checkPolicy === undefined) return "";
  const project = await requireRecordProject(dependencies, task, task.project, task.startingRevision);
  return planChecksInstructions(project.definition.repositories.map((repository) => repository.path), task.workflow?.checkPolicy?.required ?? []);
}

/** Plan 6 Task 7: whether the workspace's task is a Rovara Code version 2 task, whose coding plan must name what changes, which files and how it is tested. */
async function codingPlanRequiresParts(dependencies: AwsBrokerDependencies, workspaceId: string): Promise<boolean> {
  const pointer = await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(workspaceId));
  const task = pointer === undefined ? undefined : await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
  return task?.workflow?.definitionVersion === "1.1.0";
}

/** Bind planner guidance to the task's starting project revision; never consult the latest project here. */
async function codingPlanWorkBreakdownContext(dependencies: AwsBrokerDependencies, workspaceId: string): Promise<{ taskId: string; repositoryId: string } | undefined> {
  const pointer = await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(workspaceId));
  const task = pointer === undefined ? undefined : await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
  // A version 1 task needs the install's switch; a Rovara Code v2 task always plans in ordered, independent parts.
  if (!workflowDependenciesAllowed({ workflowDependenciesEnabled: dependencies.developer?.workflowDependenciesEnabled }, task?.workflow)) return undefined;
  if (task === undefined) throw agentXError("CONFIG_INVALID", "the task for this planning step is missing");
  const project = await requireRecordProject(dependencies, task, task.project, task.startingRevision);
  if (project.definition.repositories.length !== 1) return undefined;
  return { taskId: task.taskId, repositoryId: project.definition.repositories[0]!.name };
}

/**
 * The approved setup's source snapshot and proposal, decoded from the stored proposal artifact and independently verified against the registered
 * project, repository, policy and approval digests. Never the prepared checkout, and never trusted beyond what verification re-derives; a stored
 * proposal that cannot be verified is a reason, not a snapshot.
 */
export async function readApprovedSetupSource(dependencies: AwsBrokerDependencies, project: RegisteredProjectRecord, policy: E2EPolicy,
  repository: { url: string; name: string }, expectedRepositoryId: string | undefined):
  Promise<{ ok: true; snapshot: E2ESourceSnapshot; setupProposal: E2ESetupProposal; setupApproval: PlanApprovalRef } | { ok: false; reason: string }> {
  const setupApproval = project.setupApproval;
  if (setupApproval?.decision !== "approve") return { ok: false, reason: "the pinned project has no approved setup" };
  try {
    const stored = await readStoredText(dependencies.s3, dependencies.artifactBucketName, setupApproval.proposalRef, MAX_SETUP_PROPOSAL_BYTES);
    if (stored === undefined || createHash("sha256").update(stored, "utf8").digest("hex") !== setupApproval.proposalSha256) {
      return { ok: false, reason: "the approved setup proposal is missing or does not match its approval digest" };
    }
    const artifact: unknown = JSON.parse(stored);
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return { ok: false, reason: "the approved setup proposal is not an object" };
    const record = artifact as Record<string, unknown>;
    const rawSnapshot = record.snapshot;
    if (!(record.schemaVersion === "project-setup-source-proposal/v1" && record.issuerOwnerKey === project.registeredBy
      && record.repositoryUrl === repository.url && sameJsonContent(record.policy, policy)
      && record.identityMapping && typeof record.identityMapping === "object" && !Array.isArray(record.identityMapping)
      && (record.identityMapping as Record<string, unknown>).registeredRepositoryId === repository.name
      && rawSnapshot && typeof rawSnapshot === "object" && !Array.isArray(rawSnapshot))) {
      return { ok: false, reason: "the approved setup proposal does not belong to this project, repository and policy" };
    }
    const sourceRecord = rawSnapshot as Record<string, unknown>;
    const rawSources = sourceRecord.sources;
    if (!Array.isArray(rawSources)) return { ok: false, reason: "the approved setup proposal holds no source snapshot" };
    const sources = rawSources.map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid stored source record");
      const source = raw as Record<string, unknown>;
      if (typeof source.path !== "string" || typeof source.sha256 !== "string" || typeof source.bytesBase64 !== "string" || source.kind !== "blob") {
        throw new Error("invalid stored source record");
      }
      return { path: source.path, sha256: source.sha256, bytes: Buffer.from(source.bytesBase64, "base64"), kind: "blob" as const };
    });
    const decoded = { ...sourceRecord, sources } as unknown as E2ESourceSnapshot;
    const setupProposal = verifyE2ESetupProposal(E2ESetupProposalSchema.parse(record.proposal), decoded, decoded.candidate);
    if (!(expectedRepositoryId !== undefined && isExactFeatureE2ESourceSnapshot(decoded, expectedRepositoryId, decoded.commitSha)
      && decoded.candidate.digest === setupApproval.candidateDigest && setupProposal.candidateDigest === setupApproval.candidateDigest)) {
      return { ok: false, reason: "the approved setup snapshot does not match the registered repository and its approved candidate" };
    }
    return { ok: true, snapshot: decoded, setupProposal,
      setupApproval: { artifactId: `setup-proposal-${setupApproval.proposalSha256}`, digest: createHash("sha256").update(canonicalJson(E2ESetupProposalSchema.parse(setupProposal)), "utf8").digest("hex") } };
  } catch {
    // A stored setup snapshot that cannot be independently verified is not planner context and not approval authority.
    return { ok: false, reason: "the approved setup snapshot could not be read and verified" };
  }
}

/** Whether an account's latest definition was registered for another contract than the snapshot's: a project revision with an older setup then reads the older revisions too. */
function accountDefinitionIsForOtherContract(snapshot: E2ESourceSnapshot): (definition: E2EApplicationAccountDefinition) => boolean {
  return (definition) => {
    try {
      const contract = readE2EApplicationProjectContract(snapshot, definition.applicationId);
      return contract === null || e2eSyntheticAccountContractDigest(contract, definition.profileId) !== definition.contractDigest;
    } catch { return false; }
  };
}

/** What deriving a task's application selection against the approved setup and the runtime rows READY right now came to. */
export type ApplicationSelectionNow =
  | { ok: true; selection: E2EApplicationSelectionRecord; conditions: TransactItems;
    /** What the derivation read, for a caller that builds the admission from the same facts: the pinned policy, the approved setup and the READY rows. */
    inputs: { policy: E2EPolicy; setup: { snapshot: E2ESourceSnapshot; setupProposal: E2ESetupProposal; setupApproval: PlanApprovalRef }; rows: E2ERegisteredRuntime[];
      runtimeCatalogId: string; runtimeBinding: ReturnType<typeof parseRuntimeBinding>;
      /** The registry rows of the plan's test accounts, as read for this derivation. */
      accountEntries: E2EAccountRegistryEntry[] } }
  /** `unevaluable`: something it needs could not be read (try again later). `refused`: it read everything and the plan cannot run as approved. */
  | { ok: false; kind: "unevaluable" | "refused"; reason: string; scope?: ApplicationRefusalScope };

/**
 * Derives the selection of a schema-v2 application intent against the task's pinned project (its own revision and runtime binding, never the latest),
 * the approved setup snapshot, and the runtime rows READY right now (Ruling AL; not cached from planning). The conditions keep each row as read until
 * the transaction that uses the derivation commits. Plan approval records the result; dispatch derives it again and compares it with what was recorded.
 */
export async function evaluateWorkflowE2EApplicationSelectionNow(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord, intent: E2EApplicationPlanIntent,
  artifact: { id: string; sha256: string }, accounts: { mode: ApplicationAccountsInput["mode"]; pinned: readonly E2ERuntimeAccountRef[] }): Promise<ApplicationSelectionNow> {
  const unevaluable = (reason: string): ApplicationSelectionNow => ({ ok: false, kind: "unevaluable", reason });
  const catalogId = dependencies.e2eFeatureRuntimeCatalogId;
  if (catalogId === undefined) return unevaluable("no runtime catalog is configured");
  let project: RegisteredProjectRecord;
  try { project = await requireRecordProject(dependencies, task, task.project, task.startingRevision); }
  catch { return unevaluable("the pinned project revision is unavailable"); }
  const policy = E2EPolicySchema.safeParse(project.definition.e2e);
  if (!policy.success) return unevaluable("the pinned project has no valid E2E policy");
  if (project.definition.repositories.length !== 1) return unevaluable("application planning needs exactly one pinned repository");
  const repository = project.definition.repositories[0]!;
  const repositoryParts = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(repository.url);
  const setup = await readApprovedSetupSource(dependencies, project, policy.data, repository,
    repositoryParts?.[1] && repositoryParts[2] ? `${repositoryParts[1]}/${repositoryParts[2]}` : undefined);
  if (!setup.ok) return unevaluable(setup.reason);
  const now = Date.now();
  let rows: E2ERegisteredRuntime[];
  try {
    rows = await readProjectAdmittedE2ERuntimes({ runtimeCatalogId: catalogId, profileId: WEB_API_RUNTIME_PROFILE_ID, binding: parseRuntimeBinding(project.runtimeBinding), now,
      read: (key) => getItem<Record<string, unknown>>(dependencies, key) });
  } catch { return unevaluable("the runtime catalog could not be read"); }
  // A kind with no READY row but an expired one is refused as `runtime-expired`, with when it expired, not as "no runtime is READY" (RUN-3). Only read when a kind is missing; it
  // can only change the wording of a refusal, never let a round run.
  const expiredRuntimes = rows.length >= 2 ? [] : await readExpiredE2ERuntimes({ runtimeCatalogId: catalogId, profileId: WEB_API_RUNTIME_PROFILE_ID,
    binding: parseRuntimeBinding(project.runtimeBinding), now, read: (key) => getItem<Record<string, unknown>>(dependencies, key) });
  // The test accounts the plan's executable targets run as: the registry's rows for exactly those (application, account profile) pairs (Task 3.1).
  const projectId = project.definition.name;
  const orgId = await orgOfRecord(dependencies, task);
  let accountEntries: E2EAccountRegistryEntry[];
  try {
    const read = await readAccountRegistryEntries(dependencies, orgId, projectId, intent.applicationRuntimeRefs.map((ref) => ({ applicationId: ref.applicationId, profileId: ref.accountProfileId })),
      { earlierFor: accountDefinitionIsForOtherContract(setup.snapshot) });
    // An account whose rows cannot be read refuses only the plans that run as it, and says which account to repair (registering the project's setup again does).
    if (read.corrupt.length > 0) return { ok: false, kind: "refused", reason: unreadableAccountMessage(read.corrupt[0]!.applicationId, read.corrupt[0]!.profileId), scope: "accounts" };
    accountEntries = read.entries;
  } catch (error) {
    if (error instanceof E2EAccountRegistryError) return { ok: false, kind: "refused", reason: error.message, scope: "accounts" };
    return unevaluable("the test account registry could not be read");
  }
  const evaluation = evaluateApplicationPlanApproval({ intent, taskId: task.taskId, artifact, snapshot: setup.snapshot, setupProposal: setup.setupProposal,
    setupApproval: setup.setupApproval, policy: policy.data, registeredRuntimes: rows, runtimeCatalogId: catalogId,
    runtimeBinding: parseRuntimeBinding(project.runtimeBinding), now, expiredRuntimes, accounts: { entries: accountEntries, mode: accounts.mode, pinned: accounts.pinned } });
  if (!evaluation.ok) return { ok: false, kind: "refused", reason: evaluation.reason, ...(evaluation.scope === undefined ? {} : { scope: evaluation.scope }) };
  // The rows and account pointers this derivation was made from must still be exactly those when the transaction commits.
  const conditions: TransactItems = [...applicationRuntimeRowFences({ tableName: dependencies.tableName, rows, selected: evaluation.selection.runtimeRows }),
    ...accountRegistryFences({ orgId, tableName: dependencies.tableName, projectId, refs: evaluation.accountRefs, entries: accountEntries })];
  return { ok: true, selection: evaluation.selection, conditions, inputs: { policy: policy.data,
    setup: { snapshot: setup.snapshot, setupProposal: setup.setupProposal, setupApproval: setup.setupApproval }, rows, runtimeCatalogId: catalogId, runtimeBinding: parseRuntimeBinding(project.runtimeBinding),
    accountEntries } };
}

/**
 * Plan approval for a schema-v2 application intent: the selection to record and conditions that keep each row as read until the approval commits, or
 * a throw: CONFIG_INVALID when the plan cannot be approved, RUNTIME_UNAVAILABLE when it cannot be evaluated (a missing snapshot or an unreadable row).
 * Either way nothing is approved.
 */
export async function validateWorkflowE2EApplicationPlan(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord, intent: E2EApplicationPlanIntent,
  artifact: { id: string; sha256: string }, options: { reapproval?: boolean } = {}): Promise<{ selection: E2EApplicationSelectionRecord; conditions: TransactItems; baselineWanted: boolean }> {
  // A first approval holds the plan's account refs to the registry's latest; a retry that approves the same plan again pins the latest instead (the plan keeps its refs).
  const derived = await evaluateWorkflowE2EApplicationSelectionNow(dependencies, task, intent, artifact, { mode: options.reapproval === true ? "reapprove" : "approve", pinned: [] });
  if (derived.ok) {
    // M1.3 Task 3.7b (owner decision D2): whether this project wants the informational baseline round; the coding run is then asked to export the unchanged code.
    const baselineWanted = projectE2EBaselineWanted(await requireRecordProject(dependencies, task, task.project, task.startingRevision));
    return { selection: derived.selection, conditions: derived.conditions, baselineWanted };
  }
  if (derived.kind === "unevaluable") {
    throw agentXError("RUNTIME_UNAVAILABLE",
      `the application E2E plan could not be checked for approval (${derived.reason}); nothing was approved. Keep this plan and approve it again once it can be checked, or request changes`);
  }
  if (derived.scope === "accounts") {
    throw agentXError("CONFIG_INVALID", `the application E2E plan cannot be approved: ${derived.reason}. Request changes so the plan is written against the test accounts registered now, or ask an administrator to approve the project's setup again`);
  }
  throw agentXError("CONFIG_INVALID", `the application E2E plan cannot be approved: ${derived.reason}. Request changes to correct the plan, or approve it again once the runtime is ready`);
}

/**
 * Whether `agent` steps are offered to the planner: only while the route the policy pinned is the one the installation would use now (Task 4.2); a registry or settings read that
 * fails offers none. Never on a cloud install: AI navigation is not available to a Cloud org until its model calls are charged through the cloud spend ledger
 * (`AI_NAVIGATION_NOT_ON_CLOUD`), so the planner is not told it may write them.
 */
export async function agentStepsOfferedToPlanner(dependencies: Pick<AwsBrokerDependencies, "cloud" | "documentClient" | "tableName" | "e2eAgentInstallation">, modelRouteRevision: string | null): Promise<boolean> {
  if (dependencies.cloud === true || modelRouteRevision === null || dependencies.e2eAgentInstallation === undefined) return false;
  try {
    return (await checkE2EAgentRouteCurrent({ documentClient: dependencies.documentClient, tableName: dependencies.tableName }, await dependencies.e2eAgentInstallation(), modelRouteRevision)).ok;
  } catch { return false; }
}

/** Supplies source-backed feature-plan references only from the task's pinned project and immutable prepared commit. */
async function codingPlanFeatureE2EContext(dependencies: AwsBrokerDependencies, workspaceId: string) {
  const pointer = await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(workspaceId));
  const task = pointer === undefined ? undefined : await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
  if (task === undefined) throw agentXError("CONFIG_INVALID", "the task for this planning step is missing");
  const project = await requireRecordProject(dependencies, task, task.project, task.startingRevision);
  if (project.definition.e2e === undefined) return undefined;
  const parsedPolicy = E2EPolicySchema.safeParse(project.definition.e2e);
  if (!parsedPolicy.success) return { status: "unknown" as const, reason: "the task's pinned E2E policy could not be validated" };
  const repositories = project.definition.repositories;
  if (repositories.length !== 1) return { status: "unknown" as const, reason: "source-backed planning currently requires one pinned repository" };
  const repository = repositories[0]!;
  const repositoryParts = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(repository.url);
  const expectedRepositoryId = repositoryParts?.[1] && repositoryParts[2] ? `${repositoryParts[1]}/${repositoryParts[2]}` : undefined;
  const prepared = (task.workflow?.reviewBase ?? task.preparedBase)?.find((item) => item.repositoryId === repository.name);

  let snapshot: E2ESourceSnapshot | undefined;
  let sourceOrigin: "prepared-commit" | "approved-setup" = "prepared-commit";
  // The approved setup's verified snapshot is planner context only when it is the prepared commit (or there is no prepared commit yet).
  const approvedSetup = await readApprovedSetupSource(dependencies, project, parsedPolicy.data, repository, expectedRepositoryId);
  if (approvedSetup.ok && (prepared === undefined || approvedSetup.snapshot.commitSha === prepared.baseCommitSha)) {
    snapshot = approvedSetup.snapshot;
    if (prepared === undefined) sourceOrigin = "approved-setup";
  }

  if (snapshot === undefined) {
    if (prepared === undefined) return { status: "unknown" as const, reason: "prepared commit is unavailable and no approved immutable setup snapshot could be verified" };
    if (!dependencies.projectSetupSource) return { status: "unknown" as const, reason: "trusted source capture for the exact prepared commit is unavailable" };
    if (expectedRepositoryId === undefined) return { status: "unknown" as const, reason: "the registered repository has no supported immutable source identity" };
    try {
      const captured = await dependencies.projectSetupSource.capture({ repositoryUrl: repository.url, ref: prepared.baseCommitSha }, await githubScopeOf(dependencies, task));
      if (!isExactFeatureE2ESourceSnapshot(captured, expectedRepositoryId, prepared.baseCommitSha)) {
        return { status: "unknown" as const, reason: "trusted capture did not match the task's prepared repository commit" };
      }
      snapshot = captured;
    } catch {
      return { status: "unknown" as const, reason: "trusted source capture for the exact prepared commit failed" };
    }
  }
  // Web/API runtimes are re-checked against the project's own runtime binding now, one catalog row per kind (Ruling AL).
  let readyRuntimes: ReadyE2ERuntime[] = [];
  if (dependencies.e2eFeatureRuntimeCatalogId !== undefined) {
    try {
      readyRuntimes = await readProjectReadyE2ERuntimes({ runtimeCatalogId: dependencies.e2eFeatureRuntimeCatalogId, profileId: WEB_API_RUNTIME_PROFILE_ID,
        binding: parseRuntimeBinding(project.runtimeBinding), now: Date.now(), read: (key) => getItem<Record<string, unknown>>(dependencies, key) });
    } catch { readyRuntimes = []; }
  }
  // The planner is shown each target's account as the registry holds it now (Task 3.1). A registry that cannot be read leaves the targets without an account, so they are
  // listed as unavailable rather than offered with a ref that approval would then refuse.
  let accountRegistry: E2EAccountRegistryEntry[];
  try {
    // An account whose rows cannot be read is left out, so only its own targets are listed as unavailable.
    accountRegistry = (await readAccountRegistryEntries(dependencies, await orgOfRecord(dependencies, task), project.definition.name,
      parsedPolicy.data.targets.map((target) => ({ applicationId: target.applicationId, profileId: target.accountProfileId })),
      { earlierFor: accountDefinitionIsForOtherContract(snapshot) })).entries;
  } catch { accountRegistry = []; }
  const agentRouteApproved = await agentStepsOfferedToPlanner(dependencies, parsedPolicy.data.modelRouteRevision);
  return buildFeatureE2EPlanningContext(parsedPolicy.data, snapshot, { origin: sourceOrigin,
    preparedCommitSha: prepared?.baseCommitSha ?? null, readyRuntimes, accountRegistry, agentRouteApproved });
}

/** Whether the workspace belongs to a developer task with the gated workflow. */
/**
 * #341: a running ChatGPT task's owner's current access token, for the worker's next model requests. The refresh token
 * never leaves the control plane, and only the task the owner's plan was chosen for gets it.
 */
export async function chatGptTaskToken(dependencies: AwsBrokerDependencies, operation: OperationRecord): Promise<{ accessToken: string; expiresAt: string }> {
  if (operation.kind !== "task" || operation.chatgptDeveloperId === undefined || dependencies.chatgpt === undefined) {
    throw agentXError("CALLBACK_FORBIDDEN", "this operation does not run on a ChatGPT plan");
  }
  const token = await dependencies.chatgpt.accessToken(operation.chatgptDeveloperId);
  return { accessToken: token.access, expiresAt: new Date(token.expiresAt).toISOString() };
}

/**
 * #342: a ChatGPT task's worker stopped using the plan. The connection learns why, so the owner's next tasks start
 * right: a plan at its limit waits an hour, a refused connection is revoked, a model list is read again. The task
 * keeps the reason, once, for the warning its thread is shown.
 */
export async function recordChatGptFallback(dependencies: AwsBrokerDependencies, operation: OperationRecord, value: unknown): Promise<{ recorded: boolean }> {
  const reason = object(value, "ChatGPT status").reason;
  if (reason !== "limit" && reason !== "revoked" && reason !== "model") throw agentXError("CONFIG_INVALID", "reason must be limit, revoked or model");
  if (operation.kind !== "task" || operation.chatgptDeveloperId === undefined || dependencies.chatgpt === undefined) {
    throw agentXError("CALLBACK_FORBIDDEN", "this operation does not run on a ChatGPT plan");
  }
  const developerId = operation.chatgptDeveloperId;
  try {
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName, Key: operationKey(operation.workspaceId, operation.id),
      UpdateExpression: "SET chatgptFallback = :reason", ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(chatgptFallback)",
      ExpressionAttributeValues: { ":reason": reason },
    }));
  } catch (error) {
    // Told already (a retried callback): the connection was marked the first time.
    if (isConditional(error)) return { recorded: false };
    throw error;
  }
  if (reason === "limit") await dependencies.chatgpt.markStatus(developerId, "limit-reached");
  else if (reason === "revoked") await dependencies.chatgpt.markStatus(developerId, "revoked");
  else {
    // Best effort: a list that cannot be read now is read at the next model refusal.
    await dependencies.chatgpt.refreshModels(developerId).catch((error: unknown) => {
      console.log(JSON.stringify({ component: "broker", event: "chatgpt.models_refresh_failed", operationId: operation.id, errorName: error instanceof Error ? error.name : "unknown" }));
    });
  }
  console.log(JSON.stringify({ component: "broker", event: "chatgpt.fallback", operationId: operation.id, reason }));
  return { recorded: true };
}

/**
 * Plan 3 Task 9: the skills a running step reads. The capability is checked like a callback's (signature, expiry, scope, fence, a task
 * not yet finished); a refused one is 401. The skills are those of the snapshot recipe frozen on the operation's task, each at the digest
 * it was published with, read under the task's org: a snapshot recorded for another org, or naming a skill the org lacks, serves nothing.
 * A task with no snapshot (an older task, a Slack thread's) has no skills.
 */
export async function handleAgentSkills(dependencies: AwsBrokerDependencies, request: AdaptedHttpRequest) {
  const token = request.headers["x-agentx-callback-capability"];
  if (!token) throw agentXError("AUTH_REQUIRED", "callback capability is required");
  let claims: CallbackClaims;
  try { claims = verifyCapability(dependencies, token, "agent-skills"); }
  catch { throw agentXError("AUTH_REQUIRED", "invalid callback capability"); }
  const operation = await requireOperation(dependencies, claims.workspaceId, claims.operationId);
  if (operation.fence !== claims.fence) throw agentXError("STALE_FENCE", "callback fence is stale");
  // Like the tool routes: a finished or stopping step reads nothing, and neither does one the workspace has moved on from.
  if (TERMINAL.has(operation.status) || operation.status === "CANCEL_REQUESTED") throw agentXError("STALE_FENCE", "a finished or stopped step cannot read agent skills");
  const workspace = await requireWorkspace(dependencies, operation.workspaceId);
  if (workspace.activeOperationId !== operation.id) throw agentXError("STALE_FENCE", "operation no longer owns the workspace");
  const pointer = await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(operation.workspaceId));
  const task = pointer === undefined ? undefined : await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
  // Read under the operation's org, and only for a task of that same org: any disagreement serves nothing.
  const orgId = operation.orgId;
  if (orgId === undefined) throw agentXError("NOT_FOUND", "this operation belongs to no organisation");
  if (task !== undefined && task.orgId !== orgId) throw agentXError("NOT_FOUND", "no agent snapshot belongs to this operation");
  // Task 15 writes the snapshot beside the task: `{ orgId, recipe, digest }` at `RECIPE`.
  const snapshot = task === undefined ? undefined : await getItem<{ orgId?: string; recipe?: { skills?: unknown } }>(dependencies, taskRecipeKey(task.taskId));
  if (snapshot?.recipe === undefined) return json({ skills: [] }, request.requestId);
  if (snapshot.orgId !== orgId) throw agentXError("NOT_FOUND", "no agent snapshot belongs to this operation");
  const pinned = ResolvedRecipeSchema.shape.skills.safeParse(snapshot.recipe.skills);
  if (!pinned.success) throw agentXError("RUNTIME_UNAVAILABLE", "the agent snapshot of this task can't be read");
  const store = new SkillStore({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now });
  return json({ skills: await servedSkills(store, orgId, pinned.data) }, request.requestId);
}

/**
 * Plan 3 Task 19: the connector tools of an agent step (`GET /v1/internal/agent-tools`, `POST /v1/internal/agent-tools/call`). The capability is checked like a
 * callback's (signature, expiry, scope, fence); a refused one is 401. The operation must be the workspace's active one and not finished or being cancelled (a
 * call is never begun after a stop), and its task must belong to the same org: any disagreement serves nothing. What a step may use, and every check before a
 * vendor is asked, is `agents/agent-tools-routes.ts`.
 */
export async function handleAgentTools(dependencies: AwsBrokerDependencies, agents: AgentRouteDependencies | undefined, request: AdaptedHttpRequest, kind: "list" | "call") {
  const token = request.headers["x-agentx-callback-capability"];
  if (!token) throw agentXError("AUTH_REQUIRED", "callback capability is required");
  let claims: CallbackClaims;
  try { claims = verifyCapability(dependencies, token, "agent-tools"); }
  catch { throw agentXError("AUTH_REQUIRED", "invalid callback capability"); }
  const operation = await requireOperation(dependencies, claims.workspaceId, claims.operationId);
  if (operation.fence !== claims.fence) throw agentXError("STALE_FENCE", "callback fence is stale");
  if (TERMINAL.has(operation.status) || operation.status === "CANCEL_REQUESTED") throw agentXError("STALE_FENCE", "a finished or stopped step cannot use agent tools");
  const workspace = await requireWorkspace(dependencies, operation.workspaceId);
  if (workspace.activeOperationId !== operation.id) throw agentXError("STALE_FENCE", "operation no longer owns the workspace");
  const task = await workspaceTask(dependencies, workspace.id);
  const orgId = operation.orgId;
  if (orgId === undefined || task === undefined || task.orgId !== orgId || task.workspaceId !== workspace.id || (workspace.orgId !== undefined && workspace.orgId !== orgId)) {
    throw agentXError("NOT_FOUND", "no agent task belongs to this operation");
  }
  const stepId = (operation as { programStepId?: unknown }).programStepId;
  const run: AgentToolsRun = { orgId, task, workspace, operation: { id: operation.id, ...(typeof stepId === "string" ? { programStepId: stepId } : {}) } };
  const tools = agentToolsDependencies(dependencies, agents);
  return kind === "list" ? listAgentTools(tools, run) : callAgentTool(tools, run, parseBody(request.body));
}

/**
 * What the agent tool routes run on, built from the broker's own tables and checks; `agentTools.configure` may change any of it. Writes are decided by Task 21's
 * `decideWrite` (`approvalsWriteGate` on the agent routes' dependencies); where agents have no approvals set up, the stand-in gate runs reads and safe writes and
 * refuses everything else.
 */
function agentToolsDependencies(dependencies: AwsBrokerDependencies, agents: AgentRouteDependencies | undefined): AgentToolsDependencies {
  const base = agentToolsBase(dependencies, agents === undefined ? approvalsNotWiredGate : approvalsWriteGate(agents), agents);
  return dependencies.agentTools?.configure?.(base) ?? base;
}

/** The agent tool routes' dependencies before `agentTools.configure`, with `gate` as the write gate. */
export function agentToolsBase(dependencies: AwsBrokerDependencies, gate: AgentToolsDependencies["gate"], approvals?: AgentRouteDependencies): AgentToolsDependencies {
  const github = dependencies.githubPullRequests;
  const table = { documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now };
  const base: AgentToolsDependencies = {
    ...table,
    ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }),
    requireCreatorStillMember: (task) => requireCreatorStillMember(creatorCheckOf(dependencies), task),
    requireProjectAuthority: (orgId, ownerKey, project, options) => requireProjectAuthority(dependencies, orgId, ownerKey, project, options),
    latestProject: (orgId, project) => requireLatestProject(dependencies, orgId, project),
    readSnapshot: async (task, orgId) => {
      if (task.agent === undefined) return undefined;
      const frozen = await readTaskRecipe(dependencies, task.taskId, orgId);
      // The digest is computed from the recipe itself, as the dispatch does: a snapshot that is missing, or is not the one the task recorded, serves nothing.
      if (frozen === undefined || recipeDigest(frozen.recipe) !== task.agent.digest) throw agentXError("RUNTIME_UNAVAILABLE", "the agent snapshot of this task can't be read");
      return frozen.recipe;
    },
    connectors: ({ orgId, definition }) => resolveConnectors(definition, connectorTypeContext(dependencies, orgId, async () => githubScope(dependencies, orgId)), dependencies.connectorTypes),
    catalogs: dependencies.catalogs,
    ledger: (workspaceId, connector) => new DynamoConnectorLedger(dependencies.documentClient, dependencies.tableName, workspaceId, connector.ledger, connector.name),
    // A held call claims its request id with the approval, in the same transaction (see `AgentWriteGateInput.claimRequest`), and a repeat of the id reads the approval.
    ...(approvals === undefined ? {} : {
      holdItem: ({ workspaceId, connector, record, approvalId }: Parameters<NonNullable<AgentToolsDependencies["holdItem"]>>[0]) => new DynamoConnectorLedger(dependencies.documentClient, dependencies.tableName, workspaceId, connector.ledger, connector.name).holdItem(record, approvalId),
      heldCall: (orgId: OrgId, approvalId: string) => answerForHeldCall(approvals, orgId, approvalId),
    }),
    guardrails: async (orgId) => {
      const guardrails = await readGuardrails(dependencies, orgId);
      return { extraCommandWords: guardrails.extraCommandWords, extraTriggerLabels: guardrails.extraTriggerLabels };
    },
    runCache: (scope) => taskRunCache(table, scope),
    ...(github.createAgentInstallationToken === undefined || github.getAgentPullRequestHead === undefined ? {} : {
      github: {
        createAgentInstallationToken: (repository, permissions, scope, options) => github.createAgentInstallationToken!(repository, permissions, scope, options),
        getAgentPullRequestHead: (url, number, scope, options) => github.getAgentPullRequestHead!(url, number, scope, options),
        ...(github.listAgentRepositoryLabels === undefined ? {} : { listAgentRepositoryLabels: (url: string, scope: { orgId: OrgId }, options?: AgentTokenOptions) => github.listAgentRepositoryLabels!(url, scope, options) }),
      },
    }),
    ...(github.agentRepositoryReader === undefined ? {} : {
      repositoryReader: ({ orgId, repositoryUrl, installationId }: { orgId: OrgId; repositoryUrl: string; installationId?: number }) =>
        github.agentRepositoryReader!(repositoryUrl, { orgId }, ...(installationId === undefined ? [] : [{ installationId }])),
    }),
    gate,
    githubLoginOf: (developerId) => githubLoginOfDeveloper(dependencies, developerId),
  };
  return base;
}
