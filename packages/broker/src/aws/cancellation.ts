import type { SecondReviewOperationPlan } from "../rovara-code/second-review-store.js";
import type {TurnModelPin} from "../model-selection/turn-policy.js";
// The operation records and the cancel path shared by the broker and, for issue 173, the session
// reconciler's backstop: moved here unchanged from broker.ts, so both cancel through the same code.
// No module-level state and no environment reads, so the reconciler can load it without the broker's.
import { createHmac, randomUUID } from "node:crypto";
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { StoredBaselineSource } from "./baseline-source.js";
import type { StoredCandidateBuildSource } from "./candidate-build-source.js";
import {
  OperationSchema,
  TaskModelPolicyBindingSchema,
  agentXError,
  unhandledDeploymentMode,
  type CodeBuildGateDefinition,
  type ModelIdentifier,
  type TaskModelPolicyBinding,
  type ModelSelection,
  type Operation,
  type OperationRequester,
  type OrgId,
  type OperationStatus,
  type SpendingAdmissionReference,
  type WorkerInvocation,
  type WorkspaceInstance,
} from "@agentx/contracts";
import { hashJson, isConditional } from "./broker-shared.js";
import type { WorkflowE2EReadinessMarker } from "./broker-shared.js";
import type { ExtraItems } from "./developer-task-actions.js";
import type { DurableOutboxRecord, RuntimeBinding } from "./lambda.js";
import { taskAgentRunKey, taskPointerKey } from "../developer/task-records.js";
import type { PlanQualityContext } from "../developer/plan-quality.js";

/** The State table, as the broker and the reconciler reach it. */
export interface StateTable {
  documentClient: Pick<DynamoDBDocumentClient, "send">;
  tableName: string;
}

export interface CancellationDependencies extends StateTable {
  callbackSigningKey: string;
}

export const TERMINAL = new Set<OperationStatus>(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"]);

export interface OperationRecord extends Operation {
  fundingSourceId?: string;
  /** Frozen developer task identity for governed fallback callbacks. */
  modelTaskId?: string;
  modelTurnPin?: TurnModelPin;
  modelFallbackReceipts?: unknown;
  modelFallbackRevision?: number;
  modelPolicy?: TaskModelPolicyBinding;
  pk: string;
  sk: string;
  entityType: "OPERATION";
  eventSequence: number;
  /** Broker-only immutable spending window accepted with this operation. */
  spendingTaskId?: string;
  spendingAdmission?: SpendingAdmissionReference;
  /** Broker-internal purpose binding for a resume used only to warm feature-E2E compute. */
  workflowE2EReadiness?: WorkflowE2EReadinessMarker & { outboxId: string; readyGeneration?: number };
  targetOperationId?: string;
  /** Meta repo lane A: the meta repository's default-branch head the BROKER read and sent in this prepare invocation; the task keeps it only when the worker reports the same one. */
  knowledgeCommit?: string;
  /** The model proxy keys minted for this operation's worker by key id (a hash), when no task record keeps them (Slack work, ruling R31). */
  modelKeyIds?: string[];
  /** The project revision whose non-disk settings applied, which may be newer than the workspace's. */
  settingsRevision?: number;
  /** Plan 3, Task 16: the model a task operation of an agent ran on (the person's ChatGPT plan model when it did), kept for the cross-company check of a later step. */
  model?: ModelSelection;
  /**
   * Task 26: where the model this operation runs on comes from, chosen when the operation was built: the source, the proxy alias its key may call, and the model
   * the route was chosen for (so it can be checked against the live sources again each time the key is asked for). Null: nothing could serve the model (a ChatGPT
   * plan's backup), so no company AI key is issued. Absent: the operation was built before routing, or on an install that does not route; its key is unscoped.
   */
  modelRoute?: { sourceId: string; alias: string; model: ModelIdentifier } | null;
  /** Plan 6 Task 8: a plan check run on the same model that wrote the plan, because the project allows only one (absent: it ran on a different model). */
  criticSameModel?: true;
  /** Trust fix A2: the reviews ran on the same model that wrote the code, because it was the only one usable; their reports say so (absent: another model reviewed). */
  reviewSameModel?: true;
  /** SR-1 (switch `cr`): this REVIEW operation carries a second reviewer (another AI company's model, inside the same operation), or records why it could not: the candidate it is about and the plan (or the fixed reason it did not run). The one REVIEW end reads it (`secondOpinionFromReviewResult`); no other lookup does. */
  secondReviewPlan?: SecondReviewOperationPlan;
  /** SH30: the company recipes (id and revision) the broker offered this SETUP_DRAFT run when it dispatched it. The run's reported recipe sources are intersected with this (`offeredRecipesNamedBy`). */
  setupRecipeOffers?: Array<{ recipeId: string; revision: number }>;
  /** Plan 6 Task 8: this planning run is the one automatic revision a plan check asked for (no person asked for it: it never pauses the task or asks for money). */
  planRevision?: true;
  /** A prepare recorded FAILED because the task's first operation was refused (a model not allowed); its `error` is the refusal's words. */
  startRefused?: true;
  /** #341: the developer whose ChatGPT plan this task runs on; its chatgpt-token callback answers only their token. */
  chatgptDeveloperId?: string;
  /** #342: why this task stopped using its owner's ChatGPT plan, as its worker said; set once. */
  chatgptFallback?: "limit" | "revoked" | "model";
  /** #342: the Slack thread a ChatGPT task was asked from, where a fallback is told; absent for a developer task (its own thread). */
  chatgptThread?: { teamId: string; channelId: string; threadTs: string };
  workflowMode?: "UNDERSTAND" | "PLAN" | "PLAN_CRITIQUE" | "IMPLEMENT" | "REVIEW" | "CHECKS" | "FEEDBACK_REVIEW" | "SETUP_DRAFT" | "SETUP_AGENT" | "SPEC_WRITE" | undefined;
  candidateSourceRef?: { key: string; sha256: string; byteLength: number; candidateDigest: string };
  /** The build source manifest the worker exported for that candidate, or why there is none (see StoredCandidateBuildSourceSchema); absent when the worker sent nothing. */
  candidateBuildSource?: StoredCandidateBuildSource;
  /** M1.3 Task 3.7b: the unchanged code (the task's base commit) the worker exported beside the candidate for the baseline round, or why there is none; absent when the worker sent nothing. */
  baselineSource?: StoredBaselineSource;
  /** T7b: a planning run that was asked to export the unchanged code so its plan's must-not-change scenarios can be tried on the current app (absent: it was not). It may upload that one export, under its own operation key. */
  groundingSourceAsked?: true;
  workflowFeedbackReview?: { taskId: string; workflowRevision: number; candidateDigest: string } | undefined;
  /** A PR feedback review started by a broker that gives the critic only the owner's notes for its round (absent: an earlier release's run). */
  feedbackNotesScoped?: true;
  /** A planning run that was asked for the schema-v2 application plan (absent: it was not, so a v2 plan from it is refused). */
  workflowE2EPlanVersion?: 2;
  /** A planning run: the part of the planning context its planner was given that the plan self-check reads (absent: it was given none). */
  planQualityContext?: PlanQualityContext;
  /** A planning run whose prompt asked the planner for the plan quality members (absent: it was not, or delivery dropped the guidance for an older worker). */
  planQualityAsked?: true;
  /** Learning v2: the stage manifest the lessons chosen for this operation were recorded under; the worker's load report is applied to that manifest only. */
  learnedLoad?: { taskId: string; project: string; stage: "UNDERSTAND" | "PLAN" | "IMPLEMENT" | "PLAN_CRITIQUE" | "REVIEW"; round: number };
  publication?: {
    repository: string;
    repositoryUrl: string;
    headBranch: string;
    baseBranch: string;
    title: string;
    body?: string;
    /** Spec 025 FR-023: a developer's pull request opens as a draft unless they ask otherwise. */
    draft?: boolean;
    /**
     * A workflow publication: the tree the task's checks and reviews passed on. The broker opens the pull request only
     * when GitHub says the pushed commit has this tree, and always as a draft.
     */
    expectedTreeSha?: string;
    expectedCommitSha?: string;
    /** Server-selected workflow publication protocol, signed into the worker invocation. */
    publicationMode?: "COMMITTED_HEAD" | "CHECKED_TREE";
    /** Digest of the exact immutable publication invocation tuple. */
    publicationContextDigest?: string;
    /** Current project authority snapshot admitted with this publication; reloaded before credentials and callback. */
    admittedPinnedRevision?: number;
    admittedLatestRevision?: number;
    admittedMaterialDigest?: string;
    admittedWorkflowRevision?: number;
    admittedPlanArtifact?: { id: string; type: string; version: number; objectKey: string; sha256: string; format: "markdown" | "structured" };
    admittedOwnerApproval?: { requestId: string; workflowRevision: number; actorId: string; actorRole: "TASK_OWNER" | "PROJECT_ADMIN"; artifactDigest: string; workBreakdownDigest: string | null; at: string };
    admittedWorkflowAuthorityDigest?: string;
    /** I3: the full ids of the people the change request names (requester, approver), for the `pull_request.opened` event's `related`: the link from the host's change request to the Rovara people. */
    relatedIds?: string[];
    /** I3: the outbox item that carries this publication to the worker (its payload holds the description and the attribution), so an erasure of a person can find it. */
    outboxId?: string;
    /** The checked candidate the tree belongs to (a workflow publication only). */
    candidateDigest?: string;
    /** The base commit the broker pinned for the task: the pushed commit's only parent (a workflow publication only). */
    expectedBaseCommit?: string;
    mode?: "create" | "replace" | "revert";
    targetPullRequestNumber?: number;
    revertCommit?: string;
    codeBuildGates: CodeBuildGateDefinition[];
  };
  maintenance?: {
    action: "append" | "sync";
    repository: string;
    repositoryUrl: string;
    pullRequestNumber: number;
    headBranch: string;
    baseBranch: string;
    expectedHeadCommit: string;
    codeBuildGates: CodeBuildGateDefinition[];
    /** A workflow task's push of its reviewed fix: the candidate, its reviewed tree and the task's pinned base. */
    workflowCandidate?: { candidateDigest: string; treeSha: string; baseCommitSha: string; /** A conflict round's fix is pushed as a merge commit with this commit of the base as its second parent. */ mergeBaseCommit?: string };
    /** Plan 6 Task 17: a workflow task's merge of the base branch into its pull request's branch: the base commit merged and the head it is for. */
    workflowSync?: { baseCommit: string; expectedHeadCommit: string };
  };
  candidateCommit?: string;
  closePreviousStatus?: "READY" | "STOPPED";
}

export interface CallbackClaims {
  modelPolicy?: TaskModelPolicyBinding;
  workspaceId: string;
  operationId: string;
  fence: number;
  actions: Array<"events" | "artifacts" | "result" | "candidate-export" | "candidate-build-source" | "baseline-source" | "e2e-admission" | "e2e-evidence" | "e2e-model-budget" | "feedback-bundles" | "feedback-approval" | "pull-request" | "pull-request-update" | "codebuild" | "chatgpt-token" | "chatgpt-status" | "model-fallback" | "model-access" | "agent-skills" | "agent-tools" | "context-tools" | "setup-agent">;
  expiresAt: number;
}

export async function getItem<T>(dependencies: StateTable, key: { pk: string; sk: string }): Promise<T | undefined> {
  const response = await dependencies.documentClient.send(new GetCommand({
    TableName: dependencies.tableName,
    Key: key,
    ConsistentRead: true,
  }));
  return response.Item as T | undefined;
}

export async function requireOperation(
  dependencies: StateTable,
  workspaceId: string,
  operationId: string,
): Promise<OperationRecord> {
  const operation = await getItem<OperationRecord>(dependencies, operationKey(workspaceId, operationId));
  if (!operation) throw agentXError("NOT_FOUND", "operation not found");
  return operation;
}

export function operationKey(workspaceId: string, operationId: string) {
  return { pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}` };
}

/** The `orgId` an operation of this workspace is written with: the workspace's own org. */
export function operationOrg(workspace: { orgId?: OrgId | undefined }): { orgId?: OrgId } {
  return workspace.orgId === undefined ? {} : { orgId: workspace.orgId };
}

export function operationRecord(operation: Operation, targetOperationId?: string): OperationRecord {
  const parsed = OperationSchema.parse(operation);
  return {
    pk: `WORKSPACE#${parsed.workspaceId}`,
    sk: `OPERATION#${parsed.id}`,
    entityType: "OPERATION",
    eventSequence: 0,
    ...parsed,
    ...(targetOperationId === undefined ? {} : { targetOperationId }),
  };
}

export function publicOperation(record: OperationRecord): Operation {
  return OperationSchema.parse({
    id: record.id,
    workspaceId: record.workspaceId,
    kind: record.kind,
    ...(record.modelFallbacks===undefined?{}:{modelFallbacks:record.modelFallbacks}),
    ...(record.discardUnpublished === true ? { discardUnpublished: true } : {}),
    ...(record.workflowMode === undefined ? {} : { workflowMode: record.workflowMode }),
    ...(record.workflowFeedbackReview === undefined ? {} : { workflowFeedbackReview: record.workflowFeedbackReview }),
    requestId: record.requestId,
    payloadHash: record.payloadHash,
    status: record.status,
    fence: record.fence,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.conversationId === undefined ? {} : { conversationId: record.conversationId }),
    ...(record.heartbeatAt === undefined ? {} : { heartbeatAt: record.heartbeatAt }),
    ...(record.result === undefined ? {} : { result: record.result }),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
    ...(record.requestedBy === undefined ? {} : { requestedBy: record.requestedBy }),
  });
}

/** Routes to the workspace's own runtime unless a project binding is given. */
export function outboxRecord(
  workspace: WorkspaceInstance,
  invocation: WorkerInvocation,
  routing: RuntimeBinding | WorkspaceInstance = workspace,
): DurableOutboxRecord & { pk: string; sk: string; createdAt: string } {
  const id = randomUUID();
  const key = { pk: `OUTBOX#${id}`, sk: "OUTBOX" };
  const common = {
    id,
    entityType: "OUTBOX",
    status: "PENDING",
    operationId: invocation.operationId,
    workspaceId: workspace.id,
  } as const;
  const mismatch = () => agentXError(
    "CONFIG_INVALID",
    `a ${workspace.deploymentMode} workspace cannot be routed to a ${routing.deploymentMode} runtime`,
  );
  switch (workspace.deploymentMode) {
    case "instances-ebs":
    case "demo-microvm":
      throw agentXError("RUNTIME_UNAVAILABLE", "retired workspace cannot execute work");
    case "ec2-ebs":
      if (routing.deploymentMode !== "ec2-ebs") throw mismatch();
      return { ...key, ...common, deploymentMode: "ec2-ebs", invocation, createdAt: new Date().toISOString() };
    default:
      return unhandledDeploymentMode(workspace);
  }
}

/**
 * What a callback capability may do beyond the three every operation has (events, artifacts, result). Each flag adds its own actions;
 * a flag left out, or false, adds none.
 */
export interface CapabilityOptions {
  /** Server-owned frozen task stage binding; never inferred from model access or ChatGPT permissions. */
  modelPolicy?: unknown;
  /** Open or update the task's pull request and run its CodeBuild checks. */
  pullRequest?: boolean;
  feedbackBundles?: boolean;
  feedbackApproval?: boolean;
  /** #341, #342: only a task that runs on its owner's ChatGPT plan may ask for the owner's access token, and say why it stopped using that plan. */
  chatGptToken?: boolean;
  candidateExport?: boolean;
  /** T7b (mainline #408): a planning run asked for the unchanged code may send that one export (the "baseline-source" action) and nothing else of the implementation run's. */
  groundingSource?: boolean;
  workflowE2E?: boolean;
  /** M1.4 Task 4.3a: charge the project's day budget for AI navigation steps (`POST .../e2e-model-budget`); granted only to a round whose admission has such steps. */
  e2eModelBudget?: boolean;
  /** Ruling R29: ask for the key the operation calls models with, where the deployment has a model proxy. */
  modelAccess?: boolean;
  /** Plan 3 Task 9: read the skills of the operation's task snapshot (`GET /v1/internal/agent-skills`). */
  agentSkills?: boolean;
  /** Plan 3 Task 19: list the connector tools the step's agent is granted and call them (`/v1/internal/agent-tools`); granted to an agent step whose recipe has tool grants. */
  agentTools?: boolean;
  /** Lane E: list the project's MCP context sources and call them (`/v1/internal/context-tools`); granted to an Understand, Plan, Plan-check or Review operation of a project that has sources, never to Build. */
  contextTools?: boolean;
  /** SH14: a setup run (switch `su`) reports its journal, asks for websites and takes a person's commands through one action (`POST .../setup-agent`); granted only to a SETUP_AGENT operation. */
  setupAgent?: boolean;
}

export function issueCapability(
  dependencies: { callbackSigningKey: string },
  workspaceId: string,
  operationId: string,
  fence: number,
  options: CapabilityOptions = {},
): string {
  const modelPolicy=options.modelPolicy===undefined?undefined:TaskModelPolicyBindingSchema.parse(options.modelPolicy);
  const claims: CallbackClaims = {
    ...(modelPolicy===undefined?{}:{modelPolicy}),
    workspaceId,
    operationId,
    fence,
    actions: [
      "artifacts",
      "events",
      "result",
      ...(modelPolicy===undefined?[]:["model-fallback" as const]),
      ...(options.candidateExport === true ? ["candidate-export" as const, "candidate-build-source" as const, "baseline-source" as const] : options.groundingSource === true ? ["baseline-source" as const] : []),
      ...(options.workflowE2E === true ? ["e2e-admission" as const, "e2e-evidence" as const] : []),
      // M1.4 Task 4.3a: only a round whose admission has AI navigation steps charges the project's day budget.
      ...(options.e2eModelBudget === true ? ["e2e-model-budget" as const] : []),
      ...(options.feedbackBundles === true ? ["feedback-bundles" as const] : []),
      ...(options.feedbackApproval === true ? ["feedback-approval" as const] : []),
      // #341: only a task that runs on its owner's ChatGPT plan may ask for the owner's access token.
      // #342: and tell the control plane why it stopped using that plan.
      ...(options.chatGptToken === true ? ["chatgpt-token" as const, "chatgpt-status" as const] : []),
      ...(options.modelAccess === true ? ["model-access" as const] : []),
      ...(options.pullRequest === true
        ? ["pull-request" as const, "pull-request-update" as const, "codebuild" as const]
        : []),
      ...(options.agentSkills === true ? ["agent-skills" as const] : []),
      ...(options.agentTools === true ? ["agent-tools" as const] : []),
      ...(options.contextTools === true ? ["context-tools" as const] : []),
      ...(options.setupAgent === true ? ["setup-agent" as const] : []),
    ],
    expiresAt: Math.floor(Date.now() / 1_000) + 32_400,
  };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${createHmac("sha256", dependencies.callbackSigningKey).update(body).digest("base64url")}`;
}

/**
 * Plan 3, Task 22 (review C1): a cancel of a step of an agent-step run is recorded on the run itself, in the cancel's own transaction. The step may still
 * finish successfully before the stop lands; the run has to know it was cancelled so it ends instead of going on to the next step or a continuation. The
 * write also raises the run's `revision`, so no write the engine read before it can land. Empty for any other operation, and for a run that is over.
 */
async function agentRunCancelIntent(
  dependencies: StateTable, workspace: WorkspaceInstance, target: Operation, now: string,
): Promise<NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>> {
  const step = target as { kind: string; workflowMode?: unknown; programStepId?: unknown };
  if (step.kind !== "task" || step.workflowMode !== undefined || typeof step.programStepId !== "string") return [];
  const pointer = await getItem<{ taskId?: unknown }>(dependencies, taskPointerKey(workspace.id));
  if (typeof pointer?.taskId !== "string") return [];
  const run = await getItem<{ orgId?: unknown; state?: unknown }>(dependencies, taskAgentRunKey(pointer.taskId));
  if (run === undefined || typeof run.orgId !== "string" || ["COMPLETE", "FAILED", "CANCELLED"].includes(String(run.state))) return [];
  return [{ Update: {
    TableName: dependencies.tableName, Key: taskAgentRunKey(pointer.taskId),
    UpdateExpression: "SET cancelRequestedAt = if_not_exists(cancelRequestedAt, :at), #revision = #revision + :one",
    ConditionExpression: "attribute_exists(pk) AND #org = :org", ExpressionAttributeNames: { "#revision": "revision", "#org": "orgId" },
    ExpressionAttributeValues: { ":at": now, ":one": 1, ":org": run.orgId },
  } }];
}

/**
 * Asks the worker to cancel an operation: the target moves to CANCEL_REQUESTED and a cancel
 * operation is queued for the worker. Callers authorize first (the workspace's owner, an
 * administrator, or a member of the workspace's Slack thread).
 */
export async function requestCancellation(
  dependencies: CancellationDependencies,
  workspace: WorkspaceInstance,
  targetOperationId: string,
  requester: { requestedBy?: OperationRequester },
  extra: ExtraItems = () => [],
  options: { onlyLive?: false; eventSequence?: never } | { onlyLive: true; eventSequence?: number } = {},
): Promise<{ operation: Operation; duplicate: boolean; alreadyCancelling?: true; activeAgain?: true }> {
  const workspaceId = workspace.id;
  const target = await requireOperation(dependencies, workspaceId, targetOperationId);
  if (TERMINAL.has(target.status)) return { operation: publicOperation(target), duplicate: true };
  if (workspace.activeOperationId !== targetOperationId) throw agentXError("STALE_FENCE", "operation no longer owns the workspace");
  const now = new Date().toISOString();
  const operationId = randomUUID();
  const intent = await agentRunCancelIntent(dependencies, workspace, target, now);
  const operation = operationRecord({
    ...operationOrg(workspace),
    id: operationId,
    workspaceId,
    kind: "cancel",
    requestId: randomUUID(),
    payloadHash: hashJson({ targetOperationId }),
    status: "ACCEPTED",
    fence: workspace.fence,
    createdAt: now,
    updatedAt: now,
    ...requester,
  }, targetOperationId);
  const invocation: WorkerInvocation = {
    protocolVersion: 1,
    kind: "cancel",
    operationId,
    workspaceId,
    fence: workspace.fence,
    projectRevision: workspace.projectRevision,
    callbackCapability: issueCapability(dependencies, workspaceId, operationId, workspace.fence),
    payload: { targetOperationId },
  };
  const outbox = outboxRecord(workspace, invocation);
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: dependencies.tableName,
        Key: operationKey(workspaceId, targetOperationId),
        UpdateExpression: "SET #status = :cancel, updatedAt = :now",
        // Issue 196: only a target not yet finished, so a result that lands between the read above
        // and this write keeps its final status. By default CANCEL_REQUESTED is still running: a
        // repeated cancel queues again, so a cancel whose dispatch was lost can be sent again.
        // Issue 173: the backstop (onlyLive) leaves out CANCEL_REQUESTED, so a member's stop that
        // lands first wins (one cancel, no note). With eventSequence, also only while no new worker
        // event landed since it was read (every operation record is written with an eventSequence, from 0).
        ConditionExpression: options.onlyLive
          ? `fence = :fence AND (#status = :accepted OR #status = :dispatching OR #status = :running)${options.eventSequence === undefined ? "" : " AND eventSequence = :sequence"}`
          : "fence = :fence AND (#status = :accepted OR #status = :dispatching OR #status = :running OR #status = :cancel)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":cancel": "CANCEL_REQUESTED", ":now": now, ":fence": workspace.fence,
          // Unconditional: both conditions use them.
          ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING", ":running": "RUNNING",
          ...(options.onlyLive && options.eventSequence !== undefined ? { ":sequence": options.eventSequence } : {}),
        },
      } },
      { Put: { TableName: dependencies.tableName, Item: operation } },
      { Put: { TableName: dependencies.tableName, Item: outbox } },
      ...extra(publicOperation(operation)),
      // After the caller's items, so their positions in the transaction (which some callers read the cancellation reasons by) do not move.
      ...intent,
    ] }));
  } catch (error) {
    if (!isConditional(error)) throw error;
    // The target finished while the cancel was being written: answer as for a finished target.
    const current = await requireOperation(dependencies, workspaceId, targetOperationId);
    if (TERMINAL.has(current.status)) return { operation: publicOperation(current), duplicate: true };
    // Only an onlyLive cancel can fail these ways: another cancel was recorded first, or the task
    // showed new activity since it was judged idle.
    if (options.onlyLive && current.status === "CANCEL_REQUESTED") return { operation: publicOperation(current), duplicate: true, alreadyCancelling: true };
    if (options.onlyLive && options.eventSequence !== undefined && current.eventSequence !== options.eventSequence) {
      return { operation: publicOperation(current), duplicate: true, activeAgain: true };
    }
    throw agentXError("WORKSPACE_BUSY", "the workspace changed while the cancel was being recorded; try again");
  }
  return { operation: publicOperation(operation), duplicate: false };
}
