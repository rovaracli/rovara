// Part of the broker (split out of ../broker.ts): write gate, model access (web and Slack), turn routing and budgets.

import { sessionPageUrl } from "../../decisions/open-path.js";
import { AgentXError, agentXError, type OperationRequester, SlackModelAccessRequestSchema, recipeDigest, type InvocationModelRoute, type ModelIdentifier, slackBindingPk, SLACK_BINDING_SK_PREFIX, type OrgId, chainRunKey, ROVARA_CODE_AGENT_ID, type AgentId, type Payer, type Place, DIAGNOSIS_LIGHT_BUDGET_USD, DIAGNOSIS_NO_PROVIDER_MESSAGE } from "@rovara-code/contracts";
import { type ProjectDefinition } from "@agentx/cloud-contracts";
import { PER_TASK_BUDGET_USD } from "@agentx/cloud-contracts";
import { queryAllItems } from "../admin-reads.js";
import { DynamoConnectorLedger, GITHUB_LEDGER, connectorLedgerKeys } from "../connector-ledger.js";
import { callConnector } from "../connector-routes.js";
import { DeveloperSignInStore } from "../../developer/store.js";
import { monthOf } from "../../org/trial.js";
import { TERMINAL, getItem, operationKey, requestCancellation, requireOperation, type CallbackClaims, type OperationRecord } from "../cancellation.js";
import { requireCreatorStillMember, requireOrgOpenFor, taskWorkStart } from "../../developer/creator-member.js";
import type { AgentRunHost } from "../../agents/run-engine.js";
import { requireRecipeAllowed } from "../../agents/roster.js";
import { developerTaskIdentity, effectiveTaskOwner, taskKey, taskPointerKey, tryEffectiveTaskOwner, type DeveloperTaskPointerRecord, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { developerIdForSlackUser } from "../admin-actions.js";
import { keyIdOf, mintKeyHealing } from "../../org/budget.js";
import { admitWork, mintOperationKey, type MintOperationKeyInput } from "../../spend/admission.js";
import { forgetKey, registerKey, type RegisterGuard } from "../../spend/ledger.js";
import { budgetScopesFor, keyMember, mintTagsFor, paymentOfTaskResolved, resolvePayer } from "../../spend/payer.js";
import { readProjectAi, readSpendPolicy } from "../../spend/settings.js";
import { followMerges } from "../../agents/access.js";
import type { AgentRouteDependencies } from "../../agents/routes.js";
import { readTaskRecipe } from "../../agents/runs.js";
import { agentGitHubConnector, approvalsNotWiredGate, attributionOf, classifyDependenciesOf, ownerGithubLoginOf, regrantAgentTool } from "../../agents/agent-tools-routes.js";
import type { WriteGateRuntime } from "../../agents/write-gate.js";
import { inGeography, stepForOperation } from "../../agents/dispatch.js";
import { DEFAULT_BEDROCK_MODELS } from "@agentx/model-runtime/config";
import { listPricesPerMillion } from "@agentx/model-runtime/catalog";
import { chooseDiagnosisRoute } from "../../model-sources/diagnosis-provider.js";
import { effectiveSources, routeOnWire, servableModels, servingRoutes, type ModelRoute, type RoutingDependencies } from "../../model-sources/routing.js";
import { json } from "../json-reply.js";
import { developerTaskRouteDependencies, type DeveloperCaller } from "../developer-routes.js";
import { readCompanyStagePolicy } from "../../model-selection/policy-store.js";
import { parseTurnModelPin } from "../../model-selection/turn-policy.js";
import { ProcessModelRefusal } from "../../model-selection/process-refusal.js";
import { canonicalModelName, forbiddenModelMatcher } from "@rovara-code/contracts";
import { readGuardrails } from "../../agents/guardrails.js";
import type { DeveloperTaskActions, TransactItems } from "../developer-task-actions.js";
import { ADMISSION_REFUSALS, agentStepNotes, systemTaskDispatchAccessFence, taskPageUrl } from "../developer-tasks.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { resolveTaskAccess } from "../../developer/task-access.js";
import { acceptTask } from "./acceptance.js";
import { parseBody, verifyCapability } from "./admin-and-helpers.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import { linkedPersonOf } from "../../developer/merged-owner.js";
import { signInReader } from "../../org/live-role.js";
import { orgStoreOf, requesterStandingGuard, slackRequesterStanding, slackTeamOrg, type RequesterStanding } from "./dependency-wiring.js";
import { putArtifact } from "./pull-request-reconcile.js";
import { requireProjectAuthority, requireWorkspace } from "./records.js";
import { creatorCheckOf, routingOf } from "./scope-helpers.js";
import { ledgerOf } from "./sweeps-and-readiness.js";
import { agentToolsBase, workspaceTask } from "./task-operations.js";
import { releaseIfFinished } from "./terminal-and-github-events.js";
import { askForPausedTask, blockEndedOperationKeys } from "./terminal-result.js";
import { getSlackBinding, parseSlackHeaders, requireSlackServiceRole, sharedThread, sharedThreadOpen, slackRequesterProjectAccess } from "./workspace-preparation.js";
import { viewerCannotStartTasksMessage } from "../../developer/project-roles.js";
import { AuditEventInputSchema, auditEventId } from "@agentx/cloud-contracts";
import { addDesignUsd, canonicalJson } from "@rovara-code/contracts";
import { TaskFundingProofSchema, actualCompanyFunding, fundingAuditItems, fundingRevisionCheck } from "../../org/task-stop-funding.js";
import { type TransactItem, failedIndexes, isTransactionConflict } from "../../agents/table-writes.js";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { agentRouteDependencies, developerTaskActions } from "./dependency-wiring.js";
import { auditPendingItem } from "../../audit/outbox.js";
import { nativeSnapshotConditions } from "../../org/native-snapshot-conditions.js";
import { ownerCallerOf } from "./feedback-and-codebuild.js";
import { SYSTEM_OWNER_REFUSAL, isSystemOwned } from "../../developer/system-owner.js";
import { requireTaskStopWindowContext, taskStopKeyActorChecks, withAdmittedTaskSource } from "../../org/task-stop-window.js";
import { taskAccessFence } from "../../developer/task-people.js";
import { taskRecipeKey } from "../../developer/task-records.js";
import { designReviewSlotOf, isSlotRefusal, logSlotKeyRefused, resolveSlotAsk } from "./design-review-slot-access.js";
import { plannerRunRoomUsd } from "../../design-review/resolve-budget.js";
import { ownerStopTarget, ownerWorkRefusal, recordWorkRefused } from "../../developer/work-refusal.js";

/**
 * Task 21's write gate runtime, built from Task 19's own pieces: what an approved write needs to be classified, re-granted and sent, long after the step's request
 * ended. It is on the request-time dependencies and, the same object, on the ones the settlement job hands `runApprovalSweep`, so a retry finds it.
 */
/**
 * S2 (any path, review M5): every step of an agent run is work started for the task's owner, so it meets the send-back's project access rule and the archive check at the step, not only at the run's start.
 * A refusal is PROJECT_ACCESS_DENIED with the plain reason; the engine ends the run (FAILED) with those words, and the refusal is audited (path `agent_step`). A task with no org of record, or an install with
 * no developer API, is left to the creator check.
 */
async function requireOwnerMayRunAgentStep(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord): Promise<void> {
  if (dependencies.developer === undefined || task.orgId === undefined) return;
  const route = developerTaskRouteDependencies({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer: dependencies.developer, now: Date.now,
    tasks: developerTaskActions(dependencies) }, await ownerCallerOf(dependencies, task, "agent-step-access"), undefined, null);
  const refusal = await ownerWorkRefusal(route, task);
  if (refusal === undefined) return;
  await recordWorkRefused(dependencies.audit, (entry) => console.log(JSON.stringify({ component: "broker", ...entry })), {
    orgId: task.orgId, taskId: task.taskId, path: "agent_step", reason: refusal.reason, occurrence: "agent_step", now: new Date().toISOString() },
    ownerStopTarget(dependencies, task));
  throw agentXError("PROJECT_ACCESS_DENIED", refusal.message);
}

/**
 * Plan 3, Task 22: what the agent-step engine needs of the broker. `startStep` is `acceptTask` with the step's payload (the engine's own update of the run
 * rides in the operation's transaction); the creator and recipe checks are the ones every other dispatch makes; ending a task blocks the keys of its
 * operations (Task 30) and gives its workspace back (`releaseFinishedTask`); a step's report is kept as `agent-step-<id>.md`.
 */
export function agentRunHostOf(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, routeDependencies: AgentRouteDependencies): AgentRunHost {
  const developer = dependencies.developer;
  return {
    startStep: async (input) => {
      const accepted = await acceptTask(dependencies, developerTaskIdentity(input.task, input.task.orgId as OrgId), input.task.workspaceId,
        { requestId: input.requestId, conversationId: input.task.conversationId, prompt: input.prompt }, (operation) => input.extra(operation.id),
        { operationId: input.operationId, programStepId: input.step.id, agentRun: { step: input.step, inputs: input.inputs, resultContract: input.resultContract, checkout: input.checkout } });
      return { operationId: accepted.operation.id, duplicate: accepted.duplicate };
    },
    requireCreator: async (task) => {
      await requireCreatorStillMember(creatorCheckOf(dependencies), task);
      await requireOwnerMayRunAgentStep(dependencies, task);
    },
    // Plan 5 Task 11b: the messages people sent to this run from its session, for the step about to be made.
    stepNotes: (task, requestId, redoFrom) => agentStepNotes(dependencies, task.taskId, requestId, redoFrom),
    requireRecipeAllowed: (task, recipe) => requireRecipeAllowed(routeDependencies, task.orgId as OrgId, task.project, task.agent?.name ?? "This agent", recipe),
    releaseWorkspace: (taskId) => releaseIfFinished(dependencies, taskId),
    blockKeys: async (task) => {
      for (const item of await queryAllItems(dependencies, `WORKSPACE#${task.workspaceId}`, "OPERATION#")) {
        if (item.entityType === "OPERATION" && item.kind === "task") await blockEndedOperationKeys(dependencies, item as unknown as OperationRecord);
      }
    },
    // A run that ends while its step runs asks the worker to stop it; a step that already ended, or is being stopped, is left alone (Task 22 review, I3).
    stopOperation: async (task, operationId) => {
      const operation = await getItem<OperationRecord>(dependencies, operationKey(task.workspaceId, operationId));
      if (operation === undefined || operation.kind !== "task" || TERMINAL.has(operation.status) || operation.status === "CANCEL_REQUESTED") return;
      const workspace = await requireWorkspace(dependencies, task.workspaceId);
      if (workspace.activeOperationId !== operationId) return;
      await requestCancellation(dependencies, workspace, operationId, {});
    },
    spentUsd: async (task) => {
      const keys = task.modelKeyIds ?? [];
      return dependencies.modelAccess === undefined || keys.length === 0 ? 0 : dependencies.modelAccess.access.keySpend(keys);
    },
    saveReport: async ({ task, operationId, stepId, text }) => {
      const name = `agent-step-${stepId}.md`;
      const kept = (await queryAllItems(dependencies, `WORKSPACE#${task.workspaceId}`, "ARTIFACT#")).find((item) => item.operationId === operationId && item.name === name);
      if (kept !== undefined) return String(kept.objectKey);
      const operation = await requireOperation(dependencies, task.workspaceId, operationId);
      const artifactId = await putArtifact(dependencies, operation, { name, mediaType: "text/markdown", content: text });
      return (await getItem<{ objectKey?: unknown }>(dependencies, { pk: `WORKSPACE#${task.workspaceId}`, sk: `ARTIFACT#${artifactId}` }))?.objectKey as string | undefined;
    },
    // The pause (and the request) a budget stop of this operation stands for, when none was written (the proxy's mid-step stop): the sweep asks again through here.
    askForPause: async (task, operationId) => {
      if (await askForPausedTask(dependencies, task.taskId, { id: operationId }) === "failed") throw agentXError("RUNTIME_UNAVAILABLE", "the pause could not be asked for");
    },
    ...(developer === undefined ? {} : { taskUrl: (taskId: string, sessionId?: string) => sessionPageUrl(developer.issuer, sessionId) ?? taskPageUrl(developer.issuer, taskId) }),
    ...(developer?.slackTeamId === undefined ? {} : {
      slackChannels: async (orgId: OrgId, project: string) => (await queryAllItems(dependencies, slackBindingPk(orgId, developer.slackTeamId!), SLACK_BINDING_SK_PREFIX))
        .filter((binding) => binding.projectName === project).map((binding) => String(binding.channelId)).sort(),
    }),
  };
}

export function writeGateRuntime(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, signInStore: Pick<DeveloperSignInStore, "getDeveloper">): WriteGateRuntime {
  // The stand-in gate is never used here: only the connectors, the ledger, the catalogs and the checks are.
  const tools = () => dependencies.agentTools?.configure?.(agentToolsBase(dependencies, approvalsNotWiredGate)) ?? agentToolsBase(dependencies, approvalsNotWiredGate);
  const taskOf = async (orgId: OrgId, taskId: string): Promise<DeveloperTaskRecord> => {
    const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
    // A task partition is global: the org is re-checked on the item.
    if (task === undefined || task.orgId !== orgId) throw agentXError("NOT_FOUND", "no agent task belongs to this approval");
    return task;
  };
  const ledgers = (workspaceId: string, connector: string) => [connectorLedgerKeys(connector), GITHUB_LEDGER].map((keys) => new DynamoConnectorLedger(dependencies.documentClient, dependencies.tableName, workspaceId, keys, connector));
  return {
    classify: classifyDependenciesOf(tools(), {}),
    regrant: async ({ record, definition }) => {
      const task = await taskOf(record.orgId, record.subject.taskId);
      const workspace = await requireWorkspace(dependencies, task.workspaceId);
      return regrantAgentTool(tools(), {
        orgId: record.orgId, task, workspace, stepId: record.subject.stepId, connector: record.connector, scope: record.scope, tool: record.tool, args: record.arguments,
        definition: definition as unknown as ProjectDefinition,
      });
    },
    requireRunAuthority: async ({ orgId, ownerKey, project, taskId }) => {
      await requireProjectAuthority(dependencies, orgId, ownerKey, project, { taskCreator: async () => effectiveTaskOwner(await taskOf(orgId, taskId)).developerId });
    },
    // Who can see an approval besides its approvers (Task 22): whoever the task page lets read the task, by the page's own access check, now.
    canViewTask: async (caller, { taskId, project }) => {
      const developer = dependencies.developer;
      if (developer === undefined) return false;
      try {
        const record = await signInStore.getDeveloper(caller.developerId);
        if (record === undefined || record.revoked) return false;
        const devCaller: DeveloperCaller = {
          developerId: caller.developerId, sessionId: "approval-view", amr: record.provider, name: record.displayName, orgId: caller.orgId, orgRole: caller.orgRole,
          ...(record.slackUserId === undefined ? {} : { slackUserId: record.slackUserId }),
        };
        const routeDeps = developerTaskRouteDependencies({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer, now: Date.now, tasks, orgs: orgStoreOf(dependencies) }, devCaller);
        return (await resolveTaskAccess(routeDeps, devCaller, taskId, "read")).task.project === project;
      } catch (error) {
        // Not allowed, or not readable now: either way not seen (fail closed). An outage is logged by its name.
        if (!(error instanceof AgentXError)) console.log(JSON.stringify({ component: "broker", event: "approval.view_access_unreadable", errorName: error instanceof Error ? error.name : "unknown" }));
        return false;
      }
    },
    // What the connector ledger recorded for the approval's request id, without calling the vendor: the same record `runConnector` replays from.
    recordedResult: async ({ workspaceId, connector, requestId }) => {
      for (const ledger of ledgers(workspaceId, connector)) {
        const found = await ledger.get(requestId);
        if (found !== undefined) return found.result;
      }
      return undefined;
    },
    // Never throws once the vendor may have been asked: a call whose outcome is in doubt is an UNKNOWN result, which the approval's retry settles from the ledger.
    runConnector: async (call) => {
      const t = tools();
      const task = await taskOf(call.orgId, call.taskId);
      const workspace = await requireWorkspace(dependencies, call.workspaceId);
      // The workspace comes from an org-checked task; the org is checked on it too.
      if (workspace.orgId !== call.orgId) throw agentXError("NOT_FOUND", "no agent task belongs to this approval");
      const definition = call.definition as unknown as ProjectDefinition;
      const connector = t.connectors({ orgId: call.orgId, definition }).find((entry) => entry.name === call.connector);
      // Before anything is sent, the same refusals `callConnector` makes first: these are fine to throw.
      if (connector === undefined) throw agentXError("NOT_FOUND", "connector not found");
      if (!connector.scopes.some((entry) => entry.alias === call.request.scope)) throw agentXError("NOT_FOUND", "connector scope not found");
      if (!connector.approvals.some((entry) => entry.name === call.request.tool)) throw agentXError("FORBIDDEN", `${connector.vendor} MCP tool is not approved for this project`);
      const executing = connector.type === "github" ? agentGitHubConnector(connector, t, { orgId: call.orgId, tool: call.request.tool }) : connector;
      try {
        return await callConnector({
          connector: executing, workspace, context: { orgId: call.orgId, workspaceId: call.workspaceId, ownerKey: call.ownerKey, settingsRevision: definition.revision },
          catalogs: t.catalogs, ledger: t.ledger(call.workspaceId, connector), request: call.request,
          // Every approved call is claimed and recorded in the ledger, whatever access the project gave the tool: a retry replays it instead of sending it again.
          durable: true,
          ...(connector.attribution ? { attribution: attributionOf(task, call.agentName, await ownerGithubLoginOf(t, task)) } : {}),
        });
      } catch (error) {
        console.log(JSON.stringify({ component: "broker", event: "approval.write_outcome_unknown", approvalRequest: call.request.requestId, errorName: error instanceof Error ? error.name : "unknown" }));
        return { requestId: call.request.requestId, status: "UNKNOWN", text: "Rovara could not confirm whether the connector carried this out.", truncated: false, replayed: false };
      }
    },
  };
}

/**
 * The commit-time check that a company sign-in (OIDC) task person is still the identity their proof named. The row is keyed by the person:
 * a sign-in writes no `developerId` attribute (store.ts getDeveloper), so only a row naming someone else fails it; a revoked or merged-away row fails too.
 */
export function oidcTaskPersonIdentityCheck(tableName: string, identity: { developerId: string; issuer: string; subject: string; slackUserId?: string; provider?: "oidc" | "saml" | "cloud" | "github" }) {
  // A person with no Slack account (neutral identity) is held to everything else; one stored with a Slack id is held to that id too.
  const slack = identity.slackUserId === undefined ? "" : " AND #identitySlack = :identitySlack";
  return { ConditionCheck: {
    TableName: tableName, Key: { pk: `DEVELOPER#${identity.developerId}`, sk: "META" },
    ConditionExpression: `(attribute_not_exists(#identityId) OR #identityId = :identityId) AND #identityProvider = :identityProvider AND #identityIssuer = :identityIssuer AND #identitySubject = :identitySubject${slack} AND #identityRevoked = :identityRevoked AND attribute_not_exists(#identityMerged)`,
    ExpressionAttributeNames: { "#identityId": "developerId", "#identityProvider": "provider", "#identityIssuer": "issuer", "#identitySubject": "subject", ...(identity.slackUserId === undefined ? {} : { "#identitySlack": "slackUserId" }), "#identityRevoked": "revoked", "#identityMerged": "mergedInto" },
    ExpressionAttributeValues: { ":identityId": identity.developerId, ":identityProvider": identity.provider ?? "oidc", ":identityIssuer": identity.issuer,
      ":identitySubject": identity.subject, ...(identity.slackUserId === undefined ? {} : { ":identitySlack": identity.slackUserId }), ":identityRevoked": false },
  } };
}

/**
 * Ruling R29: the key a running task's worker calls models with, minted for the task's org and developer and capped at the
 * task's budget. The capability is checked like a callback's (signature, expiry, scope, fence); a refused one is 401.
 * The proxy's own failures all answer MODEL_PROXY_UNAVAILABLE, without their detail. The key is never stored or logged.
 */
export async function handleModelAccess(dependencies: AwsBrokerDependencies, request: AdaptedHttpRequest) {
  const token = request.headers["x-agentx-callback-capability"];
  if (!token) throw agentXError("AUTH_REQUIRED", "callback capability is required");
  let claims: CallbackClaims;
  try { claims = verifyCapability(dependencies, token, "model-access"); }
  catch { throw agentXError("AUTH_REQUIRED", "invalid callback capability"); }
  const operation = await requireOperation(dependencies, claims.workspaceId, claims.operationId);
  if (operation.designReview === undefined) return answerModelAccess(dependencies, request, claims, operation);
  // DR-KEY-1: a design-review operation's key requests are all by slot; one that is refused, for whatever reason, is logged with its fixed code, so a refusal is never invisible.
  try { return await answerModelAccess(dependencies, request, claims, operation); }
  catch (error) { logSlotKeyRefused(operation.id, request.path, error); throw error; }
}

/** `handleModelAccess` once the capability is verified and its operation read. */
async function answerModelAccess(dependencies: AwsBrokerDependencies, request: AdaptedHttpRequest, claims: CallbackClaims, operation: OperationRecord) {
  if (operation.fence !== claims.fence || operation.id !== claims.operationId || operation.workspaceId !== claims.workspaceId || operation.entityType !== "OPERATION") throw agentXError("STALE_FENCE", "callback operation binding is stale");
  if (TERMINAL.has(operation.status)) throw agentXError("STALE_FENCE", "terminal operations cannot ask for model access");
  const modelAccess = dependencies.modelAccess;
  if (modelAccess === undefined) throw agentXError("MODEL_PROXY_UNAVAILABLE", "the model proxy is not set up in this deployment");
  // A developer task names its org, owner and budget, and the keys already minted for it. Work with no task record (a Slack
  // thread's) is minted for from the signed operation: its org, the operation as the reference and as the record that keeps its
  // keys, and the default per-task budget (ruling R31; its start was admitted in ensureThreadWorkspace). Read afresh each attempt.
  const unreadable = async <T>(what: string, read: () => Promise<T>): Promise<T> => read().catch((error: unknown) => {
    console.log(JSON.stringify({ component: "broker", event: `model_access.${what}_unreadable`, operationId: claims.operationId, errorName: error instanceof Error ? error.name : "unknown" }));
    throw agentXError("MODEL_PROXY_UNAVAILABLE", "the model proxy could not issue a key");
  });
  // Task 26: the route chosen when the operation was built, checked against the live sources now (once: a retry after a lost race keeps it). An operation built
  // before routing has none, and is keyed as it was.
  const merges = dependencies.developer === undefined ? undefined : new DeveloperSignInStore({ documentClient: dependencies.documentClient, tableName: dependencies.developer.signInTableName, now: Date.now });
  const resolveMember = (developerId: string): Promise<string> => (merges === undefined ? Promise.resolve(developerId) : followMerges(merges, developerId));
  const pinnedCompany=operation.orgId===undefined||operation.modelPolicy===undefined?undefined:operation.modelTurnPin!==undefined
    ?parseTurnModelPin(operation.modelTurnPin,operation.orgId,(await requireWorkspace(dependencies,operation.workspaceId)).projectName).pin.policy
    :operation.modelTaskId===undefined?undefined:(await readTaskRecipe(dependencies,operation.modelTaskId,operation.orgId))?.modelPolicyPin?.policy;
  if(operation.orgId!==undefined&&operation.modelPolicy!==undefined&&(pinnedCompany===undefined||pinnedCompany.revision!==operation.modelPolicy.companyRevision))throw agentXError("MODEL_NOT_ALLOWED","The task's pinned model authority could not be verified.");
  const companyPolicy=operation.orgId===undefined||operation.modelPolicy===undefined?undefined:await readCompanyStagePolicy(dependencies,operation.orgId,operation.modelPolicy.stage,pinnedCompany);
  const companyGoverned=companyPolicy?.applies===true;
  const routing = routingOf(dependencies,companyGoverned);
  if(companyGoverned&&operation.chatgptDeveloperId!==undefined&&operation.modelPolicy!==undefined) {
    if(companyPolicy.sourceOrder!==undefined&&!companyPolicy.sourceOrder.includes("personal-chatgpt"))throw new ProcessModelRefusal("MODEL_NOT_VERIFIED",operation.modelPolicy.stage,"/app/admin/models/sources");
    if(companyPolicy.locked&&companyPolicy.model!==undefined&&(operation.model===undefined||canonicalModelName(companyPolicy.model)!==canonicalModelName(operation.model)))throw new ProcessModelRefusal("MODEL_NOT_VERIFIED",operation.modelPolicy.stage,"/app/admin/how-we-work");
  }
  // DR7: a design-review operation (one with a stored binding) is keyed by slot only, with a key limited to that slot's model. Any other operation is untouched by this.
  const designSlot = designReviewSlotOf(operation, request.path);
  const slotAsk = designSlot === undefined ? undefined : await resolveSlotAsk(dependencies, operation, designSlot);
  const liveRoute = routing === undefined || operation.orgId === undefined || operation.modelRoute === undefined || slotAsk !== undefined ? undefined
    : await liveRouteOf(routing, operation, operation.orgId, (await requireWorkspace(dependencies, operation.workspaceId)).projectName);
  // SR-1: the key of a review that carries a second reviewer may also call the aliases the broker chose for it, and no others. An unscoped key (no route) stays unscoped.
  const route = slotAsk !== undefined ? slotAsk.route : liveRoute === undefined || (operation.secondReviewPlan?.aliases ?? []).length === 0 ? liveRoute : { ...liveRoute, extraAliases: operation.secondReviewPlan!.aliases };
  const loadScope = async (): Promise<ModelKeyScope | undefined> => {
    const current = await requireOperation(dependencies, claims.workspaceId, claims.operationId);
    if (current.fence !== claims.fence || TERMINAL.has(current.status) || current.id !== claims.operationId || current.workspaceId !== claims.workspaceId
      || current.entityType !== "OPERATION" || current.orgId !== operation.orgId || current.kind !== operation.kind
      || canonicalJson({ route: current.modelRoute }) !== canonicalJson({ route: operation.modelRoute })
      // DR7: the binding the slot was resolved from must still be the one stored.
      || canonicalJson({ designReview: current.designReview }) !== canonicalJson({ designReview: operation.designReview })) throw agentXError("STALE_FENCE", "The operation can no longer ask for model access.");
    const pointer = await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(current.workspaceId));
    const task = pointer === undefined ? undefined : await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
    if ((current.spendingTaskId !== undefined || current.spendingAdmission !== undefined) && (pointer === undefined || task === undefined)) throw agentXError("TASK_STOP_CONFIG_INVALID", "The admitted operation lost its task binding.");
    // Task 29: with agents set up a key says who pays and what ran, and carries a member's name only when a member pays. Without them
    // (an install that never had agents) the key is minted exactly as it always was.
    const withAgents = dependencies.agents !== undefined;
    if (task !== undefined) {
      if (task.orgId === undefined) return undefined;
      // A project's system owner (automatic runs) is given no model key, ever: its jobs run without a model, and nothing may act as it to ask for one.
      if (isSystemOwned(task)) throw agentXError("TASK_ACCESS_DENIED", SYSTEM_OWNER_REFUSAL);
      // A payer recorded before a merge counts against the member they are now (Task 21, M-3); a merge pointer that can't be read is the proxy's retryable answer.
      const payment = withAgents ? await unreadable("payer", () => paymentOfTaskResolved(task, resolveMember)) : undefined;
      // The org must be open and the task's owner (and the member whose budget pays) still in it, or no key is minted (Task 21, Re-check R-2).
      await requireOrgOpenFor(dependencies, task.orgId, [tryEffectiveTaskOwner(task)?.developerId, ...(payment?.payer.kind === "member" ? [payment.payer.developerId] : [])], () => taskWorkStart(dependencies, task.orgId!, task));
      if (current.spendingAdmission !== undefined || current.spendingTaskId !== undefined || task.spendingStop !== undefined || task.spendingAdmission !== undefined) {
        if (current.orgId !== task.orgId || task.workspaceId !== claims.workspaceId || current.spendingTaskId !== task.taskId || current.spendingAdmission === undefined || task.spendingStop === undefined || task.spendingAdmission === undefined
          || canonicalJson(current.spendingAdmission) !== canonicalJson(task.spendingAdmission)) throw agentXError("TASK_STOP_CONFIG_INVALID", "The operation spending window is unavailable or changed.");
      }
      await requireTaskStopWindowContext(dependencies, task);
      const pinnedFunding = task.agent === undefined ? undefined : (await readTaskRecipe(dependencies, task.taskId, task.orgId))?.fundingProof;
      const fundingRequired = task.fundingProof !== undefined || pinnedFunding !== undefined;
      const keyAuthority = task.spendingStop === undefined && !fundingRequired ? [] : await taskStopKeyActorChecks(dependencies, task, effectiveTaskOwner(task).developerId, payment?.payer.kind === "member" ? payment.payer.developerId : undefined, agentRouteDependencies(dependencies, developerTaskActions(dependencies)));
      if (task.spendingStop !== undefined || fundingRequired) {
        if (pointer === undefined || pointer.entityType !== "DEVELOPER_TASK_POINTER" || pointer.taskId !== task.taskId) throw agentXError("TASK_STOP_CONFIG_INVALID", "The task pointer could not be checked.");
        keyAuthority.push({ ConditionCheck: { TableName: dependencies.tableName, Key: taskPointerKey(current.workspaceId),
          ConditionExpression: "#pointerType = :pointerType AND taskId = :pointerTask AND developerId = :pointerDeveloper",
          ExpressionAttributeNames: { "#pointerType": "entityType" },
          ExpressionAttributeValues: { ":pointerType": pointer.entityType, ":pointerTask": pointer.taskId, ":pointerDeveloper": pointer.developerId } } });
        if (dependencies.developer === undefined) throw agentXError("TASK_ACCESS_DENIED", "Task work authority is unavailable.");
        const peopleDependencies = developerTaskRouteDependencies({ documentClient: dependencies.documentClient, tableName: dependencies.tableName,
          developer: dependencies.developer, now: Date.now, tasks: developerTaskActions(dependencies) },
        await ownerCallerOf(dependencies, task, "model-key-work-authority"), undefined, null);
        const checkPerson = peopleDependencies.checkTaskPerson;
        const oidcProofs = new Map<string, { developerId: string; issuer: string; subject: string; slackUserId?: string; provider: "oidc" | "saml" | "cloud" | "github" }>();
        const peopleFence = await systemTaskDispatchAccessFence({ ...peopleDependencies, checkTaskPerson: async (...input) => {
          if (checkPerson === undefined) throw agentXError("TASK_ACCESS_DENIED", "Task-person identity proof is unavailable.");
          const proof = await checkPerson(...input);
          if (proof.eligible && proof.channelMember && proof.projectViewer !== true && proof.identity.method !== "slack") {
            const identity = { developerId: proof.identity.developerId, issuer: proof.identity.issuer, subject: proof.identity.subject, ...(proof.identity.slackUserId === undefined ? {} : { slackUserId: proof.identity.slackUserId }), provider: proof.identity.method };
            const previous = oidcProofs.get(identity.developerId);
            if (previous !== undefined && canonicalJson(previous) !== canonicalJson(identity)) throw agentXError("TASK_ACCESS_DENIED", "Task-person identity changed during qualification.");
            oidcProofs.set(identity.developerId, identity);
          }
          return proof;
        } }, task);
        keyAuthority.push(peopleFence ?? taskAccessFence(dependencies.tableName, task.taskId));
        for (const identity of oidcProofs.values()) keyAuthority.push(oidcTaskPersonIdentityCheck(dependencies.developer.signInTableName, identity));
      }
      let funding: ReturnType<typeof TaskFundingProofSchema.parse> | undefined;
      if (fundingRequired) {
        const proof = TaskFundingProofSchema.parse(task.fundingProof ?? pinnedFunding);
        if (task.fundingProof !== undefined && pinnedFunding !== undefined && canonicalJson(task.fundingProof) === canonicalJson(pinnedFunding) && proof.orgId === task.orgId && proof.project === task.project && routing !== undefined && route !== undefined && current.modelRoute !== undefined && current.modelRoute !== null
          && current.fundingSourceId === route.sourceId && current.modelPolicy !== undefined && current.workflowMode !== "CHECKS" && payment !== undefined) {
          funding = await actualCompanyFunding({ ...dependencies, routing, now: () => dependencies.now?.() ?? Date.now(), chatgpt: dependencies.chatgpt }, proof, { sourceId: route.sourceId, model: current.modelRoute.model });
        }
        if (funding === undefined) {
          const event = AuditEventInputSchema.parse({ eventId: auditEventId("spending.stop_refused", `${current.id}:funding`), orgId: task.orgId, action: "spending.stop_refused", actor: { kind: "system", id: "rovara" }, target: { kind: "task", id: task.taskId }, occurredAt: new Date(dependencies.now?.() ?? Date.now()).toISOString(), facts: { outcomeCode: "TASK_STOP_CONFIG_MISSING", workKind: "funding-changed", admissionId: current.id, ...(route === undefined ? {} : { sourceId: route.sourceId }), ...(route?.sourceId === "rovara" ? { sourceKind: "rovara_catalog" } : proof.sources.find(source => source.sourceId === route?.sourceId) === undefined ? {} : { sourceKind: proof.sources.find(source => source.sourceId === route?.sourceId)!.kind, sourcesRevision: proof.sourcesRevision }) } });
          try { await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Put: { TableName: dependencies.tableName, Item: auditPendingItem(event, dependencies.now?.() ?? Date.now()), ConditionExpression: "attribute_not_exists(pk)" } }] })); }
          catch (error) { if (!failedIndexes(error)?.size) throw error; }
          throw agentXError("TASK_STOP_CONFIG_MISSING", "This operation no longer has verified own-source funding. Review Spending before continuing.");
        }
      }
      const fundingChecks: TransactItem[] = funding === undefined ? [] : [{ ConditionCheck: { TableName: dependencies.tableName, Key: taskRecipeKey(task.taskId), ConditionExpression: "orgId = :fundingOrg AND fundingProof = :fundingProof", ExpressionAttributeValues: { ":fundingOrg": task.orgId, ":fundingProof": pinnedFunding } } }, fundingRevisionCheck(dependencies.tableName, funding), ...fundingAuditItems(dependencies.tableName, funding, { taskId: task.taskId, occurrence: `${current.id}:${task.modelKeyIds?.length ?? 0}`, actor: { kind: "system", id: "rovara" }, at: dependencies.now?.() ?? Date.now() })];
      const taskOrg = task.orgId;
      const runLimitUsd = task.budgetUsd ?? PER_TASK_BUDGET_USD;
      const taskKeyIds = task.modelKeyIds ?? [];
      // What these reads cannot answer is the retryable answer of the proxy, as the payer's read is; nothing is minted.
      const testCapUsd = payment?.origin === "test_run" ? await unreadable("spend_policy", () => readSpendPolicy(dependencies, taskOrg)).then((policy) => policy.perTestCapUsd) : undefined;
      const stepBudgetUsd = payment === undefined ? undefined : await unreadable("step_budget", () => stepBudgetOf(dependencies, task, current));
      // Plan 4 Task 28: a chain step's key says which chain and which run it is for (its ledger lines carry both). The chain is the run's, read under the task's own org; a run that
      // cannot be read is the proxy's retryable answer, and a run that is not there leaves the key as any agent key is.
      const chainRun = payment === undefined || task.chain === undefined ? undefined
        : await unreadable("chain_run", () => getItem<{ chainId?: string }>(dependencies, chainRunKey(taskOrg, task.chain!.chainRunId, "META")));
      const chainTag = chainRun?.chainId === undefined || task.chain === undefined ? undefined : { chainId: chainRun.chainId, chainRunId: task.chain.chainRunId };
      // B2-M1: the planner's resolve run for a design review is held to what is left under the review's cap (its measured spend is added to the review's total when it ends). No room, no key.
      let plannerRoomUsd = plannerRunRoomUsd(task.workflow, current);
      // ON-10: ONE budget for the whole run, not one per key. A key minted again for the same run first closes the run's earlier keys (the proxy counts what it had admitted) and is given the room less what they measured,
      // so the keys together stay inside the cap. A meter or a block that cannot answer is the retryable answer: nothing is minted on a guess.
      if (plannerRoomUsd !== undefined && (current.modelKeyIds ?? []).length > 0) {
        const earlier = [...new Set(current.modelKeyIds)];
        const spentSoFar = await unreadable("planner_earlier_keys", async () => {
          for (const keyId of earlier) await modelAccess.access.blockKey(keyId);
          return modelAccess.access.keySpend(earlier);
        });
        plannerRoomUsd = Math.max(0, addDesignUsd(plannerRoomUsd, -spentSoFar));
      }
      if (plannerRoomUsd !== undefined && !(plannerRoomUsd > 0)) throw agentXError("BUDGET_EXCEEDED", "The design review has no budget left for the planner's answer.");
      return {
        orgId: task.orgId, developerId: payment === undefined ? task.developerId : payment.origin === "test_run" ? undefined : keyMember(payment.payer), refId: task.taskId,
        ...(route === undefined ? {} : { route }),
        ...(plannerRoomUsd === undefined ? {} : { budgetCeilingUsd: plannerRoomUsd }),
        ...(task.spendingStop === undefined ? {} : { guardRecord: items => [...guardModelKeyOperation(current, withAdmittedTaskSource(dependencies.tableName, task, items).items), ...keyAuthority] }),
        ...(funding === undefined ? {} : { taskStopExempt: true, guardRecord: (items: readonly TransactItem[]) => {
          const guarded = guardModelKeyOperation(current, [...items]), key = taskKey(task.taskId);
          const source = nativeSnapshotConditions(dependencies.tableName, [key], [Object.fromEntries(["pk", "sk", "orgId", "project", "developerId", "payer", "origin", "startedBy", "agent", "fundingProof", "budgetUsd", "maxPerRunUsd", "budgetBaselineUsd", "modelKeyIds", "budgetPause", "status", "releasedAt", "spendingStop", "spendingAdmission"].map(field => [field, (task as unknown as Record<string, unknown>)[field]]))], ["modelKeyIds"])[0]?.ConditionCheck;
          if (source === undefined) throw agentXError("TASK_STOP_CONFIG_INVALID", "The funding source is unavailable.");
          const index = guarded.findIndex(item => item.Update?.Key?.pk === key.pk && item.Update.Key.sk === key.sk), update = guarded[index]?.Update;
          if (update === undefined) throw agentXError("TASK_STOP_CONFIG_INVALID", "The funding task record is unavailable.");
          guarded[index] = { Update: { ...update, ConditionExpression: `(${update.ConditionExpression ?? "attribute_exists(pk)"}) AND (${source.ConditionExpression})`, ExpressionAttributeNames: { ...update.ExpressionAttributeNames, ...source.ExpressionAttributeNames }, ExpressionAttributeValues: { ...update.ExpressionAttributeValues, ...source.ExpressionAttributeValues } } };
          return [...guarded, ...fundingChecks, ...keyAuthority];
        } }),
        runLimitUsd, stopAtUsd: task.maxPerRunUsd === undefined ? runLimitUsd : Math.min(runLimitUsd, task.maxPerRunUsd),
        taskKeyIds, budgetBaselineUsd: task.budgetBaselineUsd ?? 0,
        // Task 31: with agents set up, the key is held on every budget the task counts against, recorded on the operation as well as the task, and a refusal
        // pauses the task with the scope that is full.
        ...(payment === undefined ? { recordOn: [{ key: taskKey(task.taskId), knownCount: taskKeyIds.length }] } : {
          agentName: task.agent?.name ?? ROVARA_CODE_NAME,
          tags: mintTagsFor({ ...payment, origin: payment.origin ?? "cli", taskId: task.taskId, operationId: current.id, stepId: current.programStepId, ...(chainTag === undefined ? {} : { chain: chainTag }) }),
          scopes: payment.scopes,
          operationKeyIds: current.modelKeyIds ?? [],
          // Understand spends from the planning limit too (a refusal while it runs pauses with the planning scope).
          // The plan check spends from the task's planning limit like planning does (the run limit is the planning limit until the plan is approved). It is advice: running out never pauses the task or asks for money
          // (the plan goes on to the person, "stopped at the planning limit"), so it is given no pause to write.
          planning: current.workflowMode === "PLAN" || current.workflowMode === "UNDERSTAND",
          ...(testCapUsd === undefined ? {} : { testCapUsd }),
          ...(stepBudgetUsd === undefined ? {} : { stepBudgetUsd }),
          ...(current.workflowMode === "PLAN_CRITIQUE" || current.planRevision === true ? {} : { pause: { taskId: task.taskId, key: taskKey(task.taskId), operationId: current.id } }),
          recordOn: [{ key: taskKey(task.taskId), knownCount: taskKeyIds.length }, { key: operationKey(current.workspaceId, current.id) }],
        }),
      };
    }
    if (current.orgId === undefined) return undefined;
    const project = withAgents ? (await requireWorkspace(dependencies, current.workspaceId)).projectName : undefined;
    // Who pays is read from the project's settings: a setting that can't be read is the proxy's retryable answer, and no key is minted.
    const slack = project === undefined ? undefined : await slackWorkPayment(dependencies, current.orgId, project, current.requestedBy).catch((error: unknown) => {
      console.log(JSON.stringify({ component: "broker", event: "model_access.payer_unreadable", operationId: current.id, errorName: error instanceof Error ? error.name : "unknown" }));
      throw agentXError("MODEL_PROXY_UNAVAILABLE", "the model proxy could not issue a key");
    });
    const taskKeyIds = current.modelKeyIds ?? [];
    const keyed = slack === undefined ? await linkedRequester(dependencies, current.orgId, current.requestedBy) : keyMember(slack.payer);
    // A thread's work has no task record: the org must still be open and the member the key is for still in it (Task 21, Re-check R-2).
    // Check the requester independently of the payer lookup: removing membership makes linkedRequester return undefined,
    // but must not downgrade previously attributable work to anonymous org-funded work (C1).
    const requestedBy = current.requestedBy;
    const requesterId = requestedBy === undefined ? undefined : await unreadable("requester", () => resolveMember(
      "kind" in requestedBy ? requestedBy.developerId : developerIdForSlackUser(requestedBy.userId),
    ));
    await requireOrgOpenFor(dependencies, current.orgId, [...(requesterId === undefined ? [] : [requesterId]), ...(keyed === undefined ? [] : [keyed])], current.createdAt);
    return {
      orgId: current.orgId, developerId: keyed, refId: current.id,
      ...(route === undefined ? {} : { route }),
      runLimitUsd: PER_TASK_BUDGET_USD, stopAtUsd: PER_TASK_BUDGET_USD, taskKeyIds, budgetBaselineUsd: 0,
      recordOn: [{ key: operationKey(current.workspaceId, current.id), knownCount: taskKeyIds.length }],
      ...(slack === undefined ? {} : {
        agentName: ROVARA_CODE_NAME,
        tags: mintTagsFor({ ...slack, origin: "slack", operationId: current.id, stepId: current.programStepId }),
        scopes: budgetScopesFor(slack.payer, slack.place, { agentId: slack.agentId }),
      }),
    };
  };
  const budgets = { documentClient: dependencies.documentClient, tableName: dependencies.tableName, access: modelAccess.access, cloud: dependencies.cloud === true, now: Date.now };
  const ledger = ledgerOf(dependencies);
  let scope = await loadScope();
  if (scope === undefined) throw agentXError("NOT_FOUND", "this operation belongs to no organisation");
  // DR7: a slot's key is ONE-SHOT: a slot that already has a key is refused (after every check above has run again), and fails closed.
  await slotAsk?.claim();
  try {
    // Two attempts: a mint that races another for the same task finds the record changed under it, gives its key back and
    // counts again with the other's key included, so concurrent mints cannot each take the task's whole remainder.
    // The slots of a round ask together and each records its key on the same task: a slot gets more tries than the one race an ordinary mint expects.
    for (let attempt = 0; attempt < (slotAsk === undefined ? 2 : 5); attempt += 1) {
      if (attempt > 0) scope = await loadScope();
      if (scope === undefined) throw new Error("the operation lost its organisation");
      // Ruling R30 and Task 31: the key's cap is the least of what the run's limits, the step, the member, the org and every budget the task counts against
      // have left; it is reserved before it is handed out, and recorded on the task and the operation.
      const minted = await mintOperationKey({ ...budgets, ledger }, { ...scope, ttlSeconds: MODEL_KEY_TTL_SECONDS, ...(attempt > 0 ? { keepEarlierKeys: true } : {}), ...(slotAsk === undefined ? {} : await slotAsk.mintInput(scope)) });
      if (minted.outcome === "minted") {
        const answer = slotAsk === undefined ? { apiKey: minted.key, expiresAt: minted.expiresAt } : await slotAsk.keep(minted);
        return json({ baseUrl: modelAccess.proxyUrl, apiKey: answer.apiKey, expiresAt: answer.expiresAt }, request.requestId);
      }
    }
    throw agentXError("MODEL_PROXY_UNAVAILABLE", "the model proxy could not issue a key");
  } catch (error) {
    // A spent budget is the member's to know about (402); every other failure is the proxy's, and says nothing of it.
    if (error instanceof AgentXError && ADMISSION_REFUSALS.has(error.code)) throw error;
    if (isSlotRefusal(error)) throw error;
    console.log(JSON.stringify({ component: "broker", event: "model_access.mint_failed", operationId: operation.id, errorName: error instanceof Error ? error.name : "unknown" }));
    throw agentXError("MODEL_PROXY_UNAVAILABLE", "the model proxy could not issue a key");
  }
}

/**
 * Task 26: the route a key is minted for. The operation recorded it when it was built; it is checked against the live sources each time a key is asked for (a
 * source taken out of the org's order, removed, or no longer usable stops serving), but a reorder that leaves the source in the order does not end a running
 * operation. Absent for an operation built before routing, whose key is unscoped as it was.
 */
async function liveRouteOf(routing: RoutingDependencies, operation: OperationRecord, orgId: OrgId, project: string): Promise<{ alias: string; sourceId: string } | undefined> {
  const recorded = operation.modelRoute;
  if (recorded === undefined) return undefined;
  if (recorded === null) throw agentXError("MODEL_NOT_ALLOWED", "This task's ChatGPT plan has no backup among your company's AI sources, so no company AI key can be issued for it.");
  const serving = await servingRoutes(routing, { orgId, project, model: recorded.model });
  if (!serving.some((route) => route.sourceId === recorded.sourceId && route.alias === recorded.alias)) {
    throw agentXError("MODEL_NOT_ALLOWED", "The AI source this step was running on is no longer available to your company. Ask an admin to check your AI sources, then continue the task.");
  }
  return { alias: recorded.alias, sourceId: recorded.sourceId };
}

/** Merge the accepted operation source into its existing key-list update. */
function guardModelKeyOperation(operation: OperationRecord, input: TransactItems): TransactItems {
  const Key = operationKey(operation.workspaceId, operation.id), items = [...input];
  const index = items.findIndex(item => item.Update?.Key?.pk === Key.pk && item.Update.Key.sk === Key.sk);
  const update = items[index]?.Update;
  if (update === undefined) throw agentXError("TASK_STOP_CONFIG_INVALID", "The operation key record is unavailable.");
  const names: Record<string, string> = {}, values: Record<string, unknown> = {};
  const conditions = ["entityType", "id", "workspaceId", "orgId", "kind", "status", "fence", "modelRoute", "workflowMode", "programStepId", "spendingTaskId", "spendingAdmission", "fundingSourceId", "modelPolicy"].map(field => {
    const name = `#admittedOp_${field}`, value = `:admittedOp_${field}`;
    if (update.ExpressionAttributeNames?.[name] !== undefined || update.ExpressionAttributeValues?.[value] !== undefined) throw agentXError("TASK_STOP_CONFIG_INVALID", "The operation source condition is ambiguous.");
    names[name] = field;
    const source = operation as unknown as Record<string, unknown>;
    if (source[field] === undefined) return `attribute_not_exists(${name})`;
    values[value] = source[field]; return `${name} = ${value}`;
  });
  items[index] = { Update: { ...update, ConditionExpression: `(${update.ConditionExpression ?? "attribute_exists(pk)"}) AND ${conditions.join(" AND ")}`,
    ExpressionAttributeNames: { ...update.ExpressionAttributeNames, ...names }, ExpressionAttributeValues: { ...update.ExpressionAttributeValues, ...values } } };
  return items;
}

/** What `handleModelAccess` knows of the work a key is for: the input of `mintOperationKey` less the key's lifetime. */
export type ModelKeyScope = Omit<MintOperationKeyInput, "ttlSeconds">;

/** The name an agent-less run is called in a budget message. */
export const ROVARA_CODE_NAME = "Rovara Code";

/**
 * Task 31: the budget of the recipe step an operation runs, when the task's frozen recipe sets one. A task whose snapshot is not there has none (the dispatch
 * refused to run it without one).
 */
async function stepBudgetOf(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord, operation: OperationRecord): Promise<number | undefined> {
  if (task.agent === undefined || task.orgId === undefined) return undefined;
  const frozen = await readTaskRecipe(dependencies, task.taskId, task.orgId);
  if (frozen === undefined) return undefined;
  // The digest is computed from the recipe itself, as the dispatch does: a snapshot that is not the one the task recorded sets no budget.
  if (recipeDigest(frozen.recipe) !== task.agent.digest) throw agentXError("RUNTIME_UNAVAILABLE", "the agent snapshot of this task can't be read");
  const step = stepForOperation(frozen.recipe, operation.workflowMode, operation.programStepId);
  const budget = step?.kind === "check" ? undefined : step?.settings.stepBudgetUsd;
  return typeof budget === "number" ? budget : undefined;
}

/**
 * Task 13 and ruling R32: the key the Slack orchestrator calls models with for one turn. The caller is the orchestrator role;
 * the team and channel come from the signed thread header and the member from the signed user header, never from the body.
 * The org is the one the team is bound to, and a body `orgId`, if sent, must equal it. A channel bound to no project in that
 * org gets no key. The key is minted in the member's name only if the org has them as a member, else for the org alone.
 * The proxy's failures all answer MODEL_PROXY_UNAVAILABLE, without detail; the key is never logged.
 */
export async function handleSlackModelAccess(dependencies: AwsBrokerDependencies, request: AdaptedHttpRequest) {
  requireSlackServiceRole(dependencies, request);
  const body = SlackModelAccessRequestSchema.safeParse(parseBody(request.body));
  if (!body.success) throw agentXError("CONFIG_INVALID", "model access needs a turnId and optionally the thread's orgId");
  const { thread, requester } = parseSlackHeaders(request.headers);
  const teamOrg = await slackTeamOrg(dependencies, thread.teamId);
  if (body.data.orgId !== undefined && body.data.orgId !== teamOrg) throw agentXError("FORBIDDEN", "this Slack workspace is not connected to that organization");
  const binding = await getSlackBinding(dependencies, teamOrg, thread.teamId, thread.channelId);
  if (!binding) throw agentXError("FORBIDDEN", "Slack channel is not bound to a project");
  const modelAccess = dependencies.modelAccess;
  if (modelAccess === undefined) throw agentXError("MODEL_PROXY_UNAVAILABLE", "the model proxy is not set up in this deployment");
  // The requester is checked here too, before anything is routed, admitted or minted: this route does not rely on a workspace having been made (and so checked) first. The Auditor, a
  // removed, banned or other-org person and a viewer get no key and reserve no money.
  // A project viewer or an Auditor may read: in a Slack-started task's own thread the channel's people ask questions about the task (task-answer mode, a read-only view with no tools), and that
  // turn needs a key. The thread decides this on the server (its shared task record, as `slackServiceIdentity` reads it), never the request, so the key cannot be widened to a working thread.
  // Everything else about the requester (removed, banned, another org, an unreadable role) is refused there as anywhere.
  const shared = await sharedThread(dependencies, thread);
  const taskAnswerThread = shared !== undefined && !sharedThreadOpen(shared, binding) && shared.workflowThread === true && shared.closedAt === undefined && binding.projectName === shared.project;
  // SY-7: what the check read is passed on and re-asserted in the write that records the key, so a removal or ban written after the check and before the key is recorded still refuses it.
  let standing: RequesterStanding;
  if (taskAnswerThread) standing = (await slackRequesterStanding(dependencies, requester.userId, teamOrg, { allowUnlinked: true, allowReadOnly: true })).standing;
  else {
    const access = await slackRequesterProjectAccess(dependencies, teamOrg, requester.userId, binding.projectName);
    if (access.role === "viewer") throw agentXError("PROJECT_ACCESS_DENIED", viewerCannotStartTasksMessage(binding.projectName));
    standing = access.standing;
  }
  return json(await mintChatTurnKey(dependencies, teamOrg, binding.projectName, requester, body.data, requesterStandingGuard(dependencies.tableName, standing)), request.requestId);
}

/**
 * The key for one chat turn of `project`, paid as a Slack turn is (`slackWorkPayment`: the project, or the linked member who asks), admitted like any chat work, routed to the org's assistant model,
 * and registered with the ledger. Shared by a Slack turn (`handleSlackModelAccess`) and an Ask about a task (`asks/model-access`), so both have one payer rule and one allow-list. The proxy's failures
 * all answer MODEL_PROXY_UNAVAILABLE without detail; the key is never logged.
 */
export async function mintChatTurnKey(
  dependencies: AwsBrokerDependencies, orgId: OrgId, project: string, requester: OperationRequester | undefined,
  body: { turnId: string; model?: ModelIdentifier | undefined; classifierModel?: ModelIdentifier | undefined },
  /** SY-7: conditions on the requester's standing, checked in the write that records the key (or, where no key is recorded, in one of their own right) and refused as REMOVED_FROM_ORG. */
  guard?: RegisterGuard,
  options: {
    /**
     * Live interaction F2 (a light diagnosis): the turn runs on the company's own AI provider and is paid like any chat turn of the project, in the requester's name (2026-11-03: Rovara pays for no diagnosis).
     * The route is chosen among the sources billed to the company (`chooseDiagnosisRoute`: its own, or Rovara's metered one), the key is capped at DIAGNOSIS_LIGHT_BUDGET_USD, and with no usable provider the turn is refused in fixed words. DG-3: `claimKey` is called
     * once, right before the key is minted, and answers false when this diagnosis already took its one key (a retry, an SQS redelivery: then none is minted, so one diagnosis is one turn of the company's money).
     */
    diagnosis?: {
      /** Called with the model and source the key is for (a retry records them again). */
      claimKey(chosen?: { model: ModelIdentifier; sourceId: string }): Promise<boolean>;
      /** QA6-14: the canonical name of a model the company's provider just refused for this diagnosis: the choice leaves it out. */
      avoid?: string | undefined;
    };
  } = {},
): Promise<{ baseUrl: string; apiKey: string; expiresAt: number | string; route?: unknown; classifierModel?: ModelIdentifier | null }> {
  const modelAccess = dependencies.modelAccess;
  if (modelAccess === undefined) throw agentXError("MODEL_PROXY_UNAVAILABLE", "the model proxy is not set up in this deployment");
  // Task 29: with agents set up the turn is the bound project's expense, paid by the linked member (or the project when it pays, or when no member is
  // known) and tagged so; without them it is minted as it always was.
  // Only an unreadable guardrails document (read below) is let through as CONFIG_INVALID; the proxy's own 4xx refusals arrive as CONFIG_INVALID too and keep being "the proxy could not issue a key".
  let guardrailsUnreadable = false;
  try {
    // RP-4: every model a turn may run is checked against the company's forbidden models, read now with the reader schema (an unreadable document is CONFIG_INVALID, a 400 like any other path's, and no key is made).
    // `body.model` is the Slack service's own configured orchestrator model, sent on every turn (no person names a model in Slack today), so a forbidden one is replaced like a forbidden assistant model (`routeTurn`).
    const forbidden = forbiddenModelMatcher(await readGuardrails(dependencies, orgId).then((guardrails) => guardrails.forbiddenModels, (error: unknown) => { guardrailsUnreadable = error instanceof AgentXError && error.code === "CONFIG_INVALID"; throw error; }));
    // Task 26: the turn's model is routed before anything is admitted or charged; a refusal here costs nothing.
    const routing = routingOf(dependencies);
    // With no routing nothing can name another model to the service, which would answer with the forbidden one it is configured with, and the key is not scoped to a list of models (an older service that ignores
    // `classifierModel` would call a forbidden classifier with it): a turn whose configured model or classifier is forbidden is refused.
    if (routing === undefined && (body.model !== undefined && forbidden(body.model) || body.classifierModel !== undefined && forbidden(body.classifierModel))) throw agentXError("MODEL_NOT_ALLOWED", TURN_MODEL_BLOCKED);
    // A diagnosis is routed to the company's own provider or not at all (fixed words, before anything is admitted or charged).
    const avoid = options.diagnosis?.avoid;
    const diagnosisRouted = options.diagnosis !== undefined ? await routeDiagnosisTurn(routing, orgId, project, body, avoid === undefined ? forbidden : (candidate) => forbidden(candidate) || canonicalModelName(candidate) === avoid, avoid !== undefined) : undefined;
    const routed = diagnosisRouted ?? (options.diagnosis !== undefined || routing === undefined ? undefined : await routeTurn(routing, orgId, project, body, forbidden));
    const classifierModel = routed?.classifierModel;
    const slack = dependencies.agents === undefined ? undefined : await slackWorkPayment(dependencies, orgId, project, requester);
    const developerId = slack === undefined ? await linkedRequester(dependencies, orgId, requester) : keyMember(slack.payer);
    // Ruling R50: a turn is admitted like any chat work (which also syncs the proxy, the lazy half of syncBudgets), and its key is
    // capped at what every budget it counts against has left, never above one turn's allowance. Nothing left is a 402, before any key.
    const admitted = await admitWork(
      { documentClient: dependencies.documentClient, tableName: dependencies.tableName, access: modelAccess.access, cloud: dependencies.cloud === true },
      { orgId: orgId, payer: slack?.payer ?? (developerId === undefined ? { kind: "project", project: project } : { kind: "member", developerId }),
        project: project, agentId: ROVARA_CODE_AGENT_ID, agentName: ROVARA_CODE_NAME, path: "CHAT" },
    );
    const maxBudgetUsd = Math.min(options.diagnosis === undefined ? PER_TURN_BUDGET_USD : DIAGNOSIS_LIGHT_BUDGET_USD, admitted.maxBudgetUsd);
    const tags = slack === undefined ? undefined : routed === undefined ? mintTagsFor({ ...slack, origin: "slack" }) : { ...mintTagsFor({ ...slack, origin: "slack" }), source: routed.route.sourceId };
    // DG-3: one key per diagnosis. A repeat of this call (a retry, a redelivery) finds the claim taken and mints nothing: fail closed, never a second key and a second turn of the company's money.
    if (options.diagnosis !== undefined && !(await options.diagnosis.claimKey(diagnosisRouted === undefined ? undefined : { model: diagnosisRouted.model, sourceId: diagnosisRouted.route.sourceId }))) throw agentXError("RUNTIME_UNAVAILABLE", "this diagnosis already has its model key");
    const minted = await mintKeyHealing(
      { documentClient: dependencies.documentClient, tableName: dependencies.tableName, access: modelAccess.access, cloud: dependencies.cloud === true },
      { orgId: orgId, ...(developerId === undefined ? {} : { developerId }), purpose: "turn", refId: body.turnId, maxBudgetUsd, ttlSeconds: TURN_KEY_TTL_SECONDS,
        ...(routed === undefined ? {} : { models: routed.models }), ...(tags === undefined ? {} : { tags }) },
    );
    // Task 30: a turn's key reserves nothing (R50) and settles into the counters; one that can't be recorded is given back.
    const ledger = tags === undefined || slack === undefined ? undefined : ledgerOf(dependencies);
    if (ledger !== undefined && tags !== undefined && slack !== undefined) {
      try {
        await registerKey(ledger, {
          orgId: orgId, month: monthOf(Date.now()), keyId: keyIdOf(minted.key), capUsd: maxBudgetUsd, tags, expiresAt: minted.expiresAt,
          scopes: budgetScopesFor(slack.payer, slack.place, { agentId: slack.agentId }).map((key) => ({ key })),
        }, guard);
      } catch (error) {
        await giveKeyBack(modelAccess.access, minted.key);
        await forgetKey(ledger, orgId, keyIdOf(minted.key)).catch(() => undefined);
        throw error;
      }
    } else if (guard !== undefined && guard.checks.length > 0) {
      // No key record is written here (an install without agents), so the same conditions are asserted in a write of their own before the key is handed out. A cancellation by a
      // concurrent write (no condition failed) is tried once more; a failed condition is a refusal.
      try {
        for (let attempt = 0; ; attempt += 1) {
          try { await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: guard.checks })); break; }
          catch (error) { if (attempt === 0 && isTransactionConflict(error)) continue; throw error; }
        }
      } catch (error) {
        await giveKeyBack(modelAccess.access, minted.key);
        if (failedIndexes(error)?.size) throw guard.refusal();
        throw error;
      }
    }
    return { baseUrl: modelAccess.proxyUrl, apiKey: minted.key, expiresAt: minted.expiresAt, ...(routed?.wire === undefined ? {} : { route: routed.wire }), ...(classifierModel === undefined ? {} : { classifierModel }) };
  } catch (error) {
    // A spent budget (or a locked trial) is the member's to know about; every other failure is the proxy's, and says nothing of it.
    if (error instanceof AgentXError && (ADMISSION_REFUSALS.has(error.code) || error.code === "MODEL_NOT_ALLOWED" || error.code === "REMOVED_FROM_ORG" || guardrailsUnreadable && error.code === "CONFIG_INVALID")) throw error;
    console.log(JSON.stringify({ component: "broker", event: "model_access.turn_mint_failed", errorName: error instanceof Error ? error.name : "unknown" }));
    throw agentXError("MODEL_PROXY_UNAVAILABLE", "the model proxy could not issue a key");
  }
}

/** Gives a minted key back to the proxy when it will not be handed out. A revoke that fails leaves a key nobody holds until it expires; it is logged by event name and error class only (never the key). */
async function giveKeyBack(access: { revokeKey(key: string): Promise<unknown> }, key: string): Promise<void> {
  try { await access.revokeKey(key); }
  catch (error) { console.log(JSON.stringify({ component: "broker", event: "model_access.turn_revoke_failed", errorName: error instanceof Error ? error.name : "unknown" })); }
}

/** What a member is told when the model or classifier the service is configured with is one the company forbids and there is no way to name another to it. */
const TURN_MODEL_BLOCKED = "That model is blocked for your company.";
/** What a member is told when the company forbids every model the turn could have answered with. */
const TURN_NO_MODEL_ALLOWED = "Your company blocks every model Slack could answer with. Ask an admin to allow one.";

/** What a model costs per million tokens, input and output together, from the catalog's list prices; a model the catalog does not price sorts after every priced one. */
function listPrice(model: ModelIdentifier): number {
  const price = listPricesPerMillion(model);
  return price === undefined ? Number.POSITIVE_INFINITY : price.input + price.output;
}

/** RP-4: `models` from the cheapest to the dearest by list price, the same price tied by canonical name, so a replacement is the same model every time and never an expensive one by accident of the list's order. */
function cheapestFirst(models: readonly ModelIdentifier[]): ModelIdentifier[] {
  return [...models].sort((left, right) => listPrice(left) - listPrice(right) || canonicalModelName(left).localeCompare(canonicalModelName(right)));
}

/**
 * RP-4: the first model of `candidates` (in order) that the company does not forbid and that `serves` accepts, with what `serves` returned for it. A forbidden model is
 * never offered, whatever the spelling of its name (`forbidden` matches by canonical name, so a region prefix or a version suffix does not hide it).
 */
async function firstAllowed<T>(candidates: readonly ModelIdentifier[], forbidden: (model: ModelIdentifier) => boolean, serves: (model: ModelIdentifier) => Promise<T | undefined>): Promise<{ model: ModelIdentifier; served: T } | undefined> {
  const seen = new Set<string>();
  for (const model of candidates) {
    const name = canonicalModelName(model);
    if (seen.has(name) || forbidden(model)) continue;
    seen.add(name);
    const served = await serves(model);
    if (served !== undefined) return { model, served };
  }
  return undefined;
}

/**
 * Task 26: where a Slack turn's model comes from. The org's assistant model when it set one, else the model the service is configured with (`body.model`, sent on every turn), else the install's
 * default (Rovara's own AI): an org that has neither Rovara in its order nor an assistant model has nothing to answer with and is told to set one. The key may call the
 * turn's route, and the gate classifier's and router's model when it is one of Rovara's catalog and Rovara is in the org's order (they share the turn's key).
 *
 * RP-4 (replaces the old "Slack turn models are not checked"): none of them may be a model the company forbids (`forbidden`). A forbidden assistant model or configured model is replaced by the model the service is configured with when that is
 * allowed and routable, else the install's default, else the cheapest model the company allows and a source serves (the web chat lists models without a default, so there is no default rule to follow); with none, the turn is refused. The replacement always travels on the
 * wire (`wire`), also when the assistant model stands but the service's configured one is forbidden, because the service would otherwise answer with the model it was configured with. A forbidden
 * classifier is replaced by the cheapest allowed model of Rovara's catalog (`classifierModel` names the one to use) or, with none allowed, skipped (`classifierModel: null`): the service then has no classifier, which it
 * treats as "ask a person" for the gate and as "show the three-choice card" for routing, never as "allow".
 */
async function routeTurn(routing: RoutingDependencies, orgId: OrgId, project: string, body: { model?: ModelIdentifier | undefined; classifierModel?: ModelIdentifier | undefined }, forbidden: (model: ModelIdentifier) => boolean): Promise<{ route: ModelRoute; models: string[]; wire?: InvocationModelRoute; classifierModel?: ModelIdentifier | null }> {
  const sources = await effectiveSources(routing, orgId, project);
  if (sources === undefined) throw agentXError("MODEL_PROXY_UNAVAILABLE", "the model proxy is not set up in this deployment");
  const assistant = sources.stored.assistantModel;
  const rovara = sources.order.includes("rovara");
  if (assistant === undefined && !rovara) {
    throw agentXError("MODEL_NOT_ALLOWED", "Your company's AI sources don't include Rovara's AI, so Slack has no model to answer with. Ask an admin to set an assistant model.");
  }
  const defaultOrchestrator: ModelIdentifier = { provider: "amazon-bedrock", modelId: inGeography(DEFAULT_BEDROCK_MODELS.orchestrator, routing.rovaraGeography) };
  const defaultClassifier: ModelIdentifier = { provider: "amazon-bedrock", modelId: inGeography(DEFAULT_BEDROCK_MODELS.classifier, routing.rovaraGeography) };
  let model: ModelIdentifier = assistant ?? body.model ?? defaultOrchestrator;
  let route: ModelRoute | undefined;
  // The service answers with its own configured model unless a route is sent, so when that model is forbidden the route is sent whatever model stands.
  let sendRoute = body.model !== undefined && forbidden(body.model);
  if (forbidden(model)) {
    // The model the service is configured with, then the install's default, keep Slack's answers at the expected quality; only when neither is allowed and routable does the cheapest allowed model answer.
    const next = await firstAllowed([...(body.model === undefined ? [] : [body.model]), defaultOrchestrator, ...cheapestFirst(await servableModels(routing, orgId, project))], forbidden, async (candidate) => (await servingRoutes(routing, { orgId, project, model: candidate })).find((served) => served.alias !== undefined));
    if (next === undefined) throw agentXError("MODEL_NOT_ALLOWED", TURN_NO_MODEL_ALLOWED);
    model = next.model;
    route = next.served;
    sendRoute = true;
  } else {
    [route] = await servingRoutes(routing, { orgId, project, model });
  }
  if (route?.alias === undefined) {
    throw agentXError("MODEL_NOT_ALLOWED", `Slack's model ${model.provider}/${model.modelId} isn't served by any AI source your company can use. Ask an admin to set another assistant model.`);
  }
  const classifier: ModelIdentifier = body.classifierModel ?? defaultClassifier;
  const onRovara = async (candidate: ModelIdentifier) => rovara ? (await servingRoutes(routing, { orgId, project, model: candidate })).find((served) => served.sourceId === "rovara") : undefined;
  let classifierModel: ModelIdentifier | null | undefined;
  let classifierRoute: ModelRoute | undefined;
  if (forbidden(classifier)) {
    const next = await firstAllowed(cheapestFirst(await servableModels(routing, orgId, project)), forbidden, onRovara);
    if (next?.served.alias === undefined) classifierModel = null;
    else {
      classifierRoute = next.served;
      classifierModel = { provider: "amazon-bedrock", modelId: next.served.alias };
    }
  } else classifierRoute = await onRovara(classifier);
  // `routeOnWire` leaves out a Rovara catalog model the worker reaches by its own name, but the service's own configured model is not that one when it was replaced or is forbidden.
  const wire = routeOnWire(route, model) ?? (sendRoute && route.api !== undefined ? { alias: route.alias, api: route.api, catalog: route.catalog } : undefined);
  return { route, models: [...new Set([route.alias, ...(classifierRoute?.alias === undefined ? [] : [classifierRoute.alias])])], ...(wire === undefined ? {} : { wire }), ...(classifierModel === undefined ? {} : { classifierModel }) };
}

/**
 * A diagnosis turn's model: chosen among the sources billed to the company (`chooseDiagnosisRoute`: its own, or Rovara's metered source, never a person's plan). The route always travels on the wire, because the chat service
 * would otherwise answer with the model it is configured with, which the key may not call. A diagnosis has no tools, so it has no classifier (`classifierModel: null`). No usable provider: MODEL_NOT_ALLOWED in the fixed words.
 */
async function routeDiagnosisTurn(
  routing: RoutingDependencies | undefined, orgId: OrgId, project: string, body: { model?: ModelIdentifier | undefined }, forbidden: (model: ModelIdentifier) => boolean, retry = false,
): Promise<{ model: ModelIdentifier; route: ModelRoute; models: string[]; wire: InvocationModelRoute; classifierModel: null }> {
  const chosen = routing === undefined ? undefined : await chooseDiagnosisRoute(routing, orgId, project, forbidden, [body.model]);
  // The retry has nothing else to try: the company's provider has no other model it can serve (the first, refused one is left out). Fixed words; the first refusal is the reason the person reads.
  if (retry && (chosen === undefined || chosen.route.api === undefined)) throw agentXError("MODEL_NOT_ALLOWED", DIAGNOSIS_NO_OTHER_MODEL_MESSAGE);
  if (chosen === undefined || chosen.route.api === undefined) throw agentXError("MODEL_NOT_ALLOWED", DIAGNOSIS_NO_PROVIDER_MESSAGE);
  return { model: chosen.model, route: chosen.route, models: [chosen.route.alias], wire: { alias: chosen.route.alias, api: chosen.route.api, catalog: chosen.route.catalog }, classifierModel: null };
}

const DIAGNOSIS_NO_OTHER_MODEL_MESSAGE = "Your company's AI provider has no other model Rovara can try for this diagnosis.";

/** What one Slack turn's key may spend, and how long it lasts (a turn holds a queue message for at most 15 minutes). */
const PER_TURN_BUDGET_USD = 2;
const TURN_KEY_TTL_SECONDS = 900;

/**
 * Task 29: who pays for Slack-thread work, which has no task record: the project its channel is bound to is the place, the member the Slack user
 * signs in as pays (a person starting from Slack), and the project pays instead when its settings say so or when no member is known. The agent is
 * Rovara Code, which a thread's workers run.
 */
export async function slackWorkPayment(dependencies: AwsBrokerDependencies, orgId: OrgId, project: string, requester: OperationRequester | undefined): Promise<{ payer: Payer; place: Place; agentId: AgentId }> {
  const linked = await linkedRequester(dependencies, orgId, requester);
  const projectPays = (await readProjectAi(dependencies, orgId, project)).projectPays;
  const payer: Payer = linked === undefined
    ? { kind: "project", project }
    : resolvePayer({ origin: "slack", project, projectPays, agentId: ROVARA_CODE_AGENT_ID, startedBy: { developerId: linked } });
  return { payer, place: { project }, agentId: ROVARA_CODE_AGENT_ID };
}

/**
 * The member who asked for an operation, when the org knows them: a developer requester, or the developer a Slack user
 * signs in as. Anyone the org has no member record for is unknown, so a key is not minted in a name the proxy lacks.
 */
export async function linkedRequester(dependencies: AwsBrokerDependencies, orgId: OrgId, requester: OperationRequester | undefined): Promise<string | undefined> {
  if (requester === undefined) return undefined;
  const developerId = "kind" in requester ? requester.developerId : await slackPersonOf(dependencies, requester.userId);
  if (developerId === undefined) return undefined;
  const membership = await orgStoreOf(dependencies).orgForDeveloper(developerId);
  return membership?.orgId === orgId ? developerId : undefined;
}

/**
 * 0.5.18x (R31, owner decision 183(d)): the person a Slack user's spend counts against: the web account the Slack account is merged into or linked to now (`linkedPersonOf`, read live), else the
 * Slack id itself. A path that cannot be followed names nobody (the project pays), never a guess.
 */
async function slackPersonOf(dependencies: AwsBrokerDependencies, userId: string): Promise<string | undefined> {
  const slackId = developerIdForSlackUser(userId);
  const table = dependencies.developer?.signInTableName;
  if (table === undefined) return slackId;
  const path = await linkedPersonOf(signInReader({ documentClient: dependencies.documentClient, signInTableName: table }), slackId, table);
  return "refused" in path ? undefined : path.survivor;
}

/** How long a task's model key lasts; the worker asks for a new one a minute before it ends. */
const MODEL_KEY_TTL_SECONDS = 3_600;

/** #341: the developer who owns the task a workspace runs now (the effective owner, Plan 5 Task 12a), or undefined for a workspace that runs no developer task. */
export async function workspaceTaskOwner(dependencies: AwsBrokerDependencies, workspaceId: string): Promise<string | undefined> {
  const task = await workspaceTask(dependencies, workspaceId);
  return task === undefined ? undefined : effectiveTaskOwner(task).developerId;
}

export async function gatedTaskWorkspace(dependencies: AwsBrokerDependencies, workspaceId: string): Promise<boolean> {
  const pointer = await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(workspaceId));
  if (pointer === undefined) return false;
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
  // A workflow task is gated, and so is a task with a PURPOSE (a setup draft or run, a diagnosis, a nightly run): no follow-up model turn may run in its workspace.
  return task !== undefined && (task.workflow !== undefined || task.purpose !== undefined);
}

