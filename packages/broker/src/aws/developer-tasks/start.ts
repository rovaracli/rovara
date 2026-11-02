import { randomUUID } from "node:crypto";
import {
  CHANNEL_PRIVACY_NOT_SET_UP,
  PRIVATE_CHANNEL_NOT_A_MEMBER,
  AgentXError,
  PER_TASK_BUDGET_USD,
  DEVELOPER_INSTRUCTIONS_MAX_BYTES,
  codingRequestText,
  DEVELOPER_EVENTS_DEFAULT,
  SlackChannelIdSchema,
  StartDeveloperTaskRequestSchema,
  agentXError,
  cleanClientName,
  sharedTaskKey,
  type DeveloperTaskView,
  createWorkflowSnapshot,
  ROVARA_CODE_AGENT_ID,
  ROVARA_CODE_V2_FOR_NEW_ORGS,
  newPrefixedId,
  sessionSurfaceKey,
  WORKFLOW_PATH_REQUIRED,
  type SessionBinding,
} from "@agentx/contracts";
import { decideShare, type BoundChannel, type ShareDecision } from "../../developer/share.js";
import type { SpendPath } from "../../org/budget.js";
import { admitWork } from "../../spend/admission.js";
import { estimateRun } from "../../spend/estimate.js";
import { planningLimit, readProjectAi } from "../../spend/settings.js";
import {
  chargeConflict,
  chargeItems,
  developerCharge,
  limitReached,
  readWorkspaceLimits,
  type ChargeConflict,
  type WorkspaceLimits,
} from "../../developer/limits.js";
import {
  aiToolTurn,
  developerTaskIdentity,
  SLACK_CLIENT_NAME,
  SLACK_WORKFLOW_SESSION_ID,
  startIdempotencyKey,
  taskIndexKey,
  taskKey,
  taskPointerKey,
  taskShare,
  type DeveloperTaskIndexRecord,
  type DeveloperTaskPointerRecord,
  type DeveloperTaskRecord,
  type TaskShare,
  type WorkspaceCharge,
} from "../../developer/task-records.js";
import { WORKFLOW_NO_CANDIDATE_DIGEST, hashJson, isConditional, workflowDispatchItem } from "../broker-shared.js";
import type { TransactItems } from "../developer-task-actions.js";
import type { DeveloperCaller } from "../developer-routes.js";
import { setupWatchKey } from "../stuck-setup.js";
import { setupNoteForStart, withFirstEvent } from "../../rovara-code/setup-status.js";
import { requireNewWorkAllowed } from "../../developer/project-roles.js";
import { setupDraftPointerItem } from "../../rovara-code/setup-draft.js";
import { setupAgentPointerItem } from "../../rovara-code/setup-agent.js";
import { prepareRun, readRunRequest, runLimitsOf, runStartItems, type AgentRunResult, type PreparedRun, type RunStartOptions } from "../../agents/runs.js";
import { bindingItems, threadBindingItems } from "../../agent-sessions/bindings.js";
import { createTaskSessionItems, sessionStarterFor } from "../../agent-sessions/create.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";
import {
  estimateDependencies,
  get,
  inertTaskTitle,
  iso,
  log,
  parse,
  partyOf,
  putNew,
  redactedTitle,
  storedRequestText,
  taskWorkflowCheckPolicy,
  turnTable,
} from "./common.js";
import { testEnvironmentForStart } from "../../test-env/usable.js";
import { loadOwnedTask, refuse } from "./access.js";
import { openTasksText, taskView } from "./task-view.js";
import { withTestingNotice } from "./health-notice.js";
import { runResultOf } from "./task-index.js";
import { releaseFinishedTasksOf } from "./release.js";
import { assertRepositoryHostsKnown } from "../../wiring/enterprise-identity.js";
import { type CapturedTaskStop, captureTaskStopAdmission } from "../../org/task-stop-admission.js";
import { type TaskFundingProofSchema, captureTaskFundingProof, fundingAuditItems, fundingRevisionCheck, taskFundingModelPool } from "../../org/task-stop-funding.js";
import { type TransactItem, failedIndexes } from "../../agents/table-writes.js";
import { budgetActorChecks, budgetActorRefused } from "../../agents/budget-authority.js";
import { isDeepStrictEqual } from "node:util";
import { requireAgentAccess } from "../../agents/access.js";
import { resolveAgentForAutonomousRun } from "../../agents/roster.js";
import { taskStartAgentAuthorityChecks } from "../../org/task-start-agent-authority.js";
import { taskStartProjectAuthorityChecks } from "../../org/task-start-project-authority.js";
import { taskStopWindowItems } from "../../org/task-stop-window.js";
import { usdToWholeMicrodollars } from "../../org/budget-amount.js";

export async function limitError(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, full: "member" | "organization", limits: WorkspaceLimits): Promise<AgentXError> {
  const open = await openTasksText(deps, caller.developerId);
  return full === "member"
    ? agentXError("WORKSPACE_LIMIT", `you have reached the limit of ${limits.member} open workspaces per person, counting Slack threads and AI-tool tasks; close a task with agentx_close_task.${open}`)
    : agentXError("WORKSPACE_LIMIT", `this AgentX has reached its limit of ${limits.organization} open workspaces; close a task with agentx_close_task, or ask an admin.${open}`);
}

/**
 * Which counter refused the start's transaction (chargeConflict), or undefined when the charge
 * items were not what failed. The charge items are the transaction's first two, the positions
 * chargeConflict reads.
 */
export async function chargeFailure(deps: DeveloperTaskRouteDependencies, charge: WorkspaceCharge, taskId: string, error: unknown): Promise<ChargeConflict | undefined> {
  try {
    return await chargeConflict(deps.documentClient, deps.tableName, charge, taskId, error);
  } catch (unmodeled) {
    if (unmodeled === error) return undefined;
    throw unmodeled;
  }
}

type ProjectAccess = Omit<Awaited<ReturnType<DeveloperTaskRouteDependencies["checkAccess"]>>, "role">;

/**
 * C3: where and how a task is shared, or undefined for a private one. Names are read only when a
 * share needs them, and shown only to a caller with a Slack link, as GET /v1/dev/projects does
 * (R10). Q10: privacy is read for every share, since a private channel needs its sharer's membership.
 */
export async function shareFor(
  deps: DeveloperTaskRouteDependencies,
  caller: DeveloperCaller,
  project: string,
  access: ProjectAccess,
  wanted: { shareToChannel: boolean; shareMode?: "view" | "continue" | undefined; channel?: string | undefined },
): Promise<ShareDecision | undefined> {
  if (!wanted.shareToChannel && access.policy.share !== "required") return undefined;
  const linked = caller.slackUserId !== undefined;
  const looked: BoundChannel[] = deps.boundChannels === undefined
    ? access.channelIds.map((channelId) => ({ channelId }))
    : await deps.boundChannels(access.channelIds);
  // R10: a caller with no Slack link keeps each channel's privacy, never its name.
  const bound: BoundChannel[] = linked ? looked : looked.map(({ channelId, isPrivate }) => (isPrivate === undefined ? { channelId } : { channelId, isPrivate }));
  let decision: ShareDecision | undefined;
  try {
    decision = decideShare({
      project, policy: access.policy, bound, shareToChannel: wanted.shareToChannel,
      ...(wanted.shareMode === undefined ? {} : { shareMode: wanted.shareMode }),
      ...(wanted.channel === undefined ? {} : { channel: wanted.channel }),
    });
  } catch (error) {
    // A channel named by name when Slack did not name every bound channel: the name may be right,
    // so say the names could not be read rather than blame it, and give the IDs to use (IDs only, R10).
    const byName = wanted.channel !== undefined && !SlackChannelIdSchema.safeParse(wanted.channel).success;
    if (linked && deps.boundChannels !== undefined && byName && error instanceof AgentXError && error.code === "CHANNEL_REQUIRED" && bound.some((channel) => channel.name === undefined)) {
      throw agentXError("CHANNEL_REQUIRED", `AgentX could not read the channel names from Slack; name the channel by its ID: ${bound.map((channel) => channel.channelId).sort().join(", ")}`);
    }
    throw error;
  }
  if (decision !== undefined) await confirmMayShareInto(deps, caller, bound.find((channel) => channel.channelId === decision.channelId) ?? { channelId: decision.channelId });
  return decision;
}

/** What admission refuses a start with (the trial, the month's machine time, a budget): each is a recorded refusal, not a failure. */
export const ADMISSION_REFUSALS: ReadonlySet<string> = new Set([
  "TRIAL_LOCKED", "MACHINE_TIME_EXCEEDED", "BUDGET_EXCEEDED", "ORG_BUDGET_EXCEEDED", "PROJECT_BUDGET_EXCEEDED", "AGENT_BUDGET_EXCEEDED", "AGENT_BUDGET_REQUIRED", "CHAIN_BUDGET_EXCEEDED", "CHAIN_BUDGET_REQUIRED", "TEST_ALLOWANCE_USED",
]);

/**
 * Plan 3, Task 34: the limit a task starts with. A workflow task's is the project's planning limit for its path (the run limit is set when the plan is
 * approved); a task with no workflow's is the TASK estimate's run limit, and an agent-step run's the AGENT estimate's.
 */
async function startingLimitUsd(
  deps: DeveloperTaskRouteDependencies,
  input: { project: string; asWorkflow: boolean; workflowPath: "QUICK" | "FULL"; prepared: PreparedRun | undefined },
): Promise<number> {
  const settings = estimateDependencies(deps);
  if (input.asWorkflow) return planningLimit(await readProjectAi(settings, deps.orgId, input.project), input.workflowPath);
  return (await estimateRun(settings, {
    orgId: deps.orgId, project: input.project, agentId: input.prepared?.ref.agentId ?? ROVARA_CODE_AGENT_ID,
    path: input.prepared?.runner === "agent_steps" ? "AGENT" : "TASK",
    ...(input.prepared?.maxPerRunUsd === undefined ? {} : { maxPerRunUsd: input.prepared.maxPerRunUsd }),
  })).runLimitUsd;
}

function admissionPath(input: { asWorkflow: boolean; workflowPath: "QUICK" | "FULL"; prepared: PreparedRun | undefined }): SpendPath {
  if (input.prepared?.runner === "agent_steps") return "AGENT";
  if (input.asWorkflow) return input.workflowPath === "FULL" ? "FULL" : "QUICK";
  return input.prepared === undefined ? "QUICK" : "TASK";
}

const NOT_A_MEMBER = PRIVATE_CHANNEL_NOT_A_MEMBER;
const PRIVACY_UNKNOWN = "Slack could not be reached to check whether that channel is private; try again shortly";
const PRIVACY_NOT_SET_UP = CHANNEL_PRIVACY_NOT_SET_UP;

/**
 * Q10 (owner answer, 2026-09-29): a private channel takes a share only from one of its members. A
 * public channel needs nothing. A channel whose privacy is unknown (Slack did not answer, or no
 * channel-info lookup is configured) is treated as private unless the caller is a member, and a
 * failed membership lookup refuses: nothing here lets a share through on doubt.
 */
async function confirmMayShareInto(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, channel: BoundChannel): Promise<void> {
  if (channel.isPrivate === false) return;
  const refusal = () => channel.isPrivate === true
    ? agentXError("CHANNEL_REQUIRED", NOT_A_MEMBER)
    : agentXError("SLACK_UNAVAILABLE", deps.boundChannels === undefined ? PRIVACY_NOT_SET_UP : PRIVACY_UNKNOWN);
  // A caller with no Slack link cannot be confirmed as a member.
  if (caller.slackUserId === undefined || deps.channelMember === undefined) throw refusal();
  if (!(await deps.channelMember(caller.slackUserId, channel.channelId))) throw refusal();
}

/** Whether a session already follows this surface in the org (the reverse item of a binding exists). */
async function surfaceIsBound(deps: DeveloperTaskRouteDependencies, binding: SessionBinding): Promise<boolean> {
  return await get(deps, sessionSurfaceKey(deps.orgId, binding)) !== undefined;
}

/**
 * Starts a task. `run` is passed by `startAgentRun` for a start that is not a person's own request (an event, a schedule, a chain step, the app route):
 * it names the origin, who started it and who pays, takes a run limit and a result contract, and makes the start write the run's request item; its
 * answer then carries the run's limits. The AI-tool route and the Slack start pass nothing.
 */
/**
 * Whether this person's start with this request ID was already made (R8): the first task is returned to a retry whatever changed since, so a gate that would
 * refuse or hold a new start (an older version that waits for the agent's owner) must let the retry through to be answered with it.
 */
export async function startAlreadyMade(deps: Pick<DeveloperTaskRouteDependencies, "documentClient" | "tableName">, caller: DeveloperCaller, requestId: string): Promise<boolean> {
  return await get<{ taskId: string }>(deps, startIdempotencyKey(caller.developerId, requestId)) !== undefined;
}

export async function startTask(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, value: unknown, run?: RunStartOptions): Promise<{ task: DeveloperTaskView; run?: AgentRunResult }> {
  const request = parse(StartDeveloperTaskRequestSchema, value, deps, "start");
  const turns = turnTable(deps);
  // Only the Slack workflow's own caller can say "slack": an AI tool that sends that name is still an AI tool.
  const client = caller.sessionId === SLACK_WORKFLOW_SESSION_ID && request.client?.trim().toLowerCase() === "slack" ? SLACK_CLIENT_NAME : cleanClientName(request.client);
  const payloadHash = hashJson({
    project: request.project, instructions: request.instructions, title: request.title ?? null,
    shareToChannel: request.shareToChannel ?? null, shareMode: request.shareMode ?? null, channel: request.channel ?? null,
    ...(request.workflow === true ? { workflow: true, ...(request.workflowPath === undefined ? {} : { workflowPath: request.workflowPath }) } : {}),
    ...(request.agent === undefined ? {} : { agent: request.agent }),
    ...(request.input === undefined ? {} : { input: request.input }),
  });
  const idempotencyKey = startIdempotencyKey(caller.developerId, request.requestId);
  // A start of a published older version that waited for the agent's owner was started, once approved, with `input` (the text again) and no title, so a client's
  // retry of the first request, which names the instructions alone or adds a title, is the same start (fix wave re-check, minor 2).
  const approvedFormHash = typeof request.agent?.version !== "number" ? undefined : hashJson({
    project: request.project, instructions: request.instructions, title: null, shareToChannel: null, shareMode: null, channel: null,
    agent: request.agent, input: request.input ?? { text: request.instructions },
  });
  // loadOwnedTask is the ownership check before taskView's reads. Access is not checked again: a
  // retry returns the first task whatever changed since (R8), as every read of a task does (R11).
  const returning = async (previous: { taskId: string; payloadHash: string }) => {
    if (previous.payloadHash !== payloadHash && previous.payloadHash !== approvedFormHash) throw agentXError("IDEMPOTENCY_CONFLICT", "this request_id was already used for another task; use a new request_id");
    const task = await loadOwnedTask(deps, caller, previous.taskId);
    return { task: await taskView(deps, task, { events: DEVELOPER_EVENTS_DEFAULT, details: false }), ...(run === undefined ? {} : { run: runResultOf(task) }) };
  };
  // R8: a retried call returns the first task, whatever changed since.
  const previous = await get<{ taskId: string; payloadHash: string }>(deps, idempotencyKey);
  if (previous !== undefined) return returning(previous);

  const taskId = randomUUID();
  const receivedAt = iso(deps);
  const party = partyOf(caller, taskId, client);
  const refused = (error: AgentXError) => refuse(deps, turns, party, request, receivedAt, error);
  // FR-018's project checks come before any DeveloperTaskActions call.
  let access: Awaited<ReturnType<DeveloperTaskRouteDependencies["checkAccess"]>>;
  try {
    access = await deps.checkAccess(request.project);
    // Plan 2, Task 11: an archived project, or a role that may not start tasks, refuses only here, where new work starts.
    await requireNewWorkAllowed(deps, deps.orgId, request.project, access.role, "task");
  } catch (error) {
    if (error instanceof AgentXError) return refused(error);
    throw error;
  }
  // FR-031, C4: decided here, in R8's place for sharing; a refusal is audited and writes nothing else.
  let decision: ShareDecision | undefined;
  try {
    decision = await shareFor(deps, caller, request.project, access, { shareToChannel: request.shareToChannel === true, shareMode: request.shareMode, channel: request.channel });
  } catch (error) {
    if (error instanceof AgentXError) return refused(error);
    throw error;
  }
  let share: TaskShare | undefined;
  if (decision !== undefined) {
    // Bindings exist only under a team ID, so this cannot happen; refuse rather than write a half share.
    if (deps.slackTeamId === undefined) return refused(agentXError("CHANNEL_REQUIRED", "this AgentX has no Slack workspace set, so tasks cannot be shared"));
    share = {
      ...taskShare(decision, deps.slackTeamId, receivedAt),
      ...(deps.initialSlackThread !== undefined && deps.initialSlackThread.teamId === deps.slackTeamId
        && deps.initialSlackThread.channelId === decision.channelId ? { threadTs: deps.initialSlackThread.threadTs } : {}),
    };
  }
  const project = await deps.actions.latestProject(deps.orgId, request.project);
  if (project === undefined) return refused(agentXError("PROJECT_NOT_FOUND", `project \`${request.project}\` doesn't exist in this AgentX`));
  // The policy checked must be the policy started: a revision registered between the two reads
  // could have turned tasks off or required sharing. Nothing was decided, so nothing is recorded.
  if (project.definition.revision !== access.revision) {
    log(deps, { event: "developer.task_start_revision_changed", checked: access.revision, latest: project.definition.revision });
    throw agentXError("WORKSPACE_BUSY", "the project changed while starting; try again with the same request_id");
  }
  // Plan 2, Task 15: the org's GitHub connection must still reach every repository of the project. Before the budget, the limits and any
  // write, so a task that cannot run costs nothing and leaves nothing behind.
  if (deps.requireRepositoriesConnected !== undefined) {
    try {
      await deps.requireRepositoriesConnected(deps.orgId, project.definition);
    } catch (error) {
      if (error instanceof AgentXError) return refused(error);
      throw error;
    }
  }
  // Enterprise foundations P7: every repository of the project must live on a code host this install has registered; a task on any other is refused here, before the budget, the limits and any write.
  if (deps.codeHost !== undefined) {
    try {
      assertRepositoryHostsKnown(project.definition.repositories, deps.codeHost);
    } catch (error) {
      if (error instanceof AgentXError) return refused(error);
      throw error;
    }
  }
  // Plan 3, Task 15 (PF23): the agent is resolved after the project checks above and before any budget or charge, so a refused agent
  // costs nothing and leaves nothing behind. The roster, archive state and guardrails are read as they stand now.
  let prepared: PreparedRun | undefined;
  if (deps.agentRuns !== undefined) {
    try {
      prepared = await prepareRun(deps.agentRuns, {
        orgId: deps.orgId, project: request.project, projectRevision: project.definition.revision, input: request.input ?? { text: request.instructions },
        ...(request.agent === undefined ? {} : { agent: { agentId: request.agent.agentId, ...(request.agent.version === undefined ? {} : { version: request.agent.version }) } }),
        origin: run?.origin ?? (client === SLACK_CLIENT_NAME ? "slack" : "cli"),
        ...(run?.autonomous === true ? {} : { caller, role: access.role }),
        ...(run === undefined ? { startedBy: { developerId: caller.developerId } } : run.startedBy === undefined ? {} : { startedBy: run.startedBy }),
        ...(run?.payer === undefined ? {} : { payer: run.payer }),
        ...(run?.payerFromRules === true ? { payerFromRules: true } : {}),
        ...(run?.payerFacts === undefined ? {} : { payerFacts: run.payerFacts }),
        ...(run?.chain === undefined ? {} : { chain: run.chain }),
        ...(run?.runLimitUsd === undefined ? {} : { runLimitUsd: run.runLimitUsd }),
        ...(run?.resultContract === undefined ? {} : { resultContract: run.resultContract }),
        ...(run?.versionApproved === true ? { versionApproved: true as const } : {}),
        ...(run?.codeIntent === undefined ? {} : { allowProcessLayer: true as const }),
        repositories: project.definition.repositories.map((repository) => ({ name: repository.name, url: repository.url, ...(repository.installationId === undefined ? {} : { installationId: repository.installationId }) })),
        ...(project.definition.models === undefined ? {} : { projectApproved: project.definition.models.approved }),
      });
      if (request.workflow === true && prepared.runner === "agent_steps") {
        throw agentXError("CONFIG_INVALID", `${prepared.ref.name} doesn't write code, so it can't run as a coding workflow`);
      }
    } catch (error) {
      if (error instanceof AgentXError) return refused(error);
      throw error;
    }
  } else if (request.agent !== undefined || request.input !== undefined) {
    return refused(agentXError("CONFIG_INVALID", "agents are not set up in this deployment"));
  }
  const paused = prepared?.paused === true;
  // Plan 6 Task 10: Rovara drafting the project's dev setup. A read-only look at the repositories with no workflow; paid, admitted and limited like a Quick plan.
  // Live interaction F3: a deep diagnosis is the same read-only look (the boundary, the start rules and the planning limit are a setup draft's); only its purpose, its result and its pointer differ.
  const settingUpDraft = run?.setupDraft !== undefined || run?.diagnosis !== undefined || run?.setupAgent !== undefined || run?.nightlyRun !== undefined;
  if (settingUpDraft && (prepared === undefined || prepared.runner !== "coding")) return refused(agentXError("CONFIG_INVALID", "a setup draft is a coding run of Rovara Code"));
  // Plan 6 Task 3: the binding a Rovara Code intent asks for. A Slack thread is bound only by the share this start makes
  // to that very thread, so a start that could not share to it is refused rather than left unbound.
  const codeBinding = run?.codeIntent?.binding;
  if (codeBinding?.kind === "slack_thread" && (share?.threadTs !== codeBinding.threadTs || share.teamId !== codeBinding.teamId)) {
    return refused(agentXError("CONFIG_INVALID", "this task can't be shared to that Slack thread"));
  }
  // Who started the run, kept on the record: a person's start is the caller; a run no person started has none.
  const startedBy = run === undefined ? { developerId: caller.developerId } : run.startedBy;
  // Plan 5, Task 2: every run is a session, created in this start transaction. A chain step's task is not (its chain run is the session), and a
  // run no person started and no trigger names has no starter to record, so it has none either.
  const sessionStartedBy = prepared === undefined ? undefined : sessionStarterFor({ trigger: run?.trigger, startedBy, chain: prepared.chain });
  const sessionId = sessionStartedBy === undefined ? undefined : newPrefixedId("ses");
  // When another member started the run on the owner's behalf, the session's first event names them; a name that can't be read is left out, never an error.
  const starterName = sessionStartedBy?.kind === "member" && sessionStartedBy.developerId !== caller.developerId
    ? await deps.agentRuns?.signInStore.getDeveloper(sessionStartedBy.developerId).then((developer) => developer?.displayName, () => undefined) : undefined;
  // A coding agent chosen by name is a workflow; a start that names none is a workflow only when it says so, as it always was.
  // (A setup draft names Rovara Code but is no workflow: it is a read-only look, answered with a draft.)
  const asWorkflow = !settingUpDraft && (request.workflow === true || (request.agent !== undefined && prepared?.runner === "coding"));
  // Plan 6: a recipe with a plan check step (Rovara Code version 2, or an agent built on it) makes a 1.1.0 workflow, which starts by understanding the intent. Every other task stays 1.0.0.
  const hasPlanCheck = asWorkflow && prepared?.recipe.steps.some((step) => step.kind === "plan_critic") === true;
  // It starts by understanding the intent only once Understand runs (Task 4); until then (`rovaraCodeV2Live`, off) a 1.1.0 task starts on the plan step as before, and needs an explicit path.
  const understandsFirst = hasPlanCheck && (deps.agentRuns?.rovaraCodeV2Live ?? ROVARA_CODE_V2_FOR_NEW_ORGS);
  // A workflow asked for with no Quick or Full path is Understand's to choose on version 2; anywhere else the explicit path is still required, in the words the request schema used to give.
  if (request.workflow === true && request.workflowPath === undefined && !understandsFirst) return refused(agentXError("CONFIG_INVALID", WORKFLOW_PATH_REQUIRED));
  const workflowPath = request.workflowPath ?? "QUICK";
  // Plan 6 Task 9: a version 2 task reads the project's setup status. A failed setup is refused here, before the budget, the limits and any write; an unchecked, outdated or
  // checking one adds a first event to the task's own new workspace below. Version 1 tasks never read it.
  let setupNote: string | undefined;
  if (hasPlanCheck) {
    try {
      setupNote = await setupNoteForStart(deps, deps.orgId, request.project, project.definition);
    } catch (error) {
      if (error instanceof AgentXError) return refused(error);
      throw error;
    }
  }
  // Plan 3, Task 34: with a model proxy a workflow task starts at its planning limit, a task with no workflow at the TASK estimate's run limit and an
  // agent-step run at the AGENT estimate's; a request can only lower it. Without a proxy nothing is limited, as before.
  // SH14: a setup run starts at its own budget (the setup limits, $4 by default), not at the Quick plan's planning limit.
  let startLimitUsd = deps.modelAccess === undefined ? undefined : run?.setupAgent !== undefined ? run.setupAgent.limits.budgetCents / 100 : await startingLimitUsd(deps, {
    project: request.project, asWorkflow: asWorkflow || settingUpDraft, workflowPath, prepared,
  });
  if (prepared !== undefined && startLimitUsd !== undefined) prepared = { ...prepared, ...runLimitsOf(startLimitUsd, run?.runLimitUsd, prepared.maxPerRunUsd) };
  let fundingProof: ReturnType<typeof TaskFundingProofSchema.parse> | undefined;
  let spendingStop: CapturedTaskStop | undefined;
  let spendingScopeChecks: TransactItem[] = [];
  // Every task captures once after its existing live principal checks and
  // before monthly admission, workspace creation or key effects.
  {
    const authorizeSpendingAgent = async (agentId: NonNullable<typeof prepared>["ref"]["agentId"]): Promise<void> => {
      if (deps.agentRuns === undefined) { if (run?.autonomous === true) throw budgetActorRefused(); return; }
      if (run?.autonomous === true) {
        if (prepared === undefined || prepared.ref.agentId !== agentId || typeof prepared.ref.version !== "number") throw budgetActorRefused();
        await resolveAgentForAutonomousRun(deps.agentRuns, { orgId: deps.orgId, project: request.project, agentId, version: prepared.ref.version });
      } else await requireAgentAccess(deps.agentRuns, caller, agentId, prepared?.ref.version === "draft" ? "edit" : "use");
    };
    try {
      fundingProof = prepared?.modelPolicyPin === undefined || deps.agentRuns?.modelRouting === undefined ? undefined : await captureTaskFundingProof({ documentClient: deps.documentClient, tableName: deps.tableName, routing: deps.agentRuns.modelRouting, chatgpt: deps.agentRuns.stageChatgpt, now: () => deps.now() }, {
    orgId: deps.orgId, project: request.project, models: taskFundingModelPool(prepared.modelPolicyPin, deps.agentRuns.modelRouting.rovaraGeography), ...(prepared.payer.kind === "member" ? { payerDeveloperId: prepared.payer.developerId } : {}),
  }).catch(() => { throw agentXError("TASK_STOP_CONFIG_MISSING", "The funding sources could not be read. Try again."); });
  if (fundingProof !== undefined && prepared !== undefined) {
    if (prepared.modelPolicyPin?.sourcesRevision !== fundingProof.sourcesRevision) return refused(agentXError("TASK_STOP_CONFIG_INVALID", "The funding sources changed during admission."));
    prepared = { ...prepared, fundingProof };
  }
      const pathLimitMicrousd = usdToWholeMicrodollars(startLimitUsd ?? prepared?.runLimitUsd ?? PER_TASK_BUDGET_USD);
      const requestedMicrousd = run?.runLimitUsd === undefined ? undefined : usdToWholeMicrodollars(run.runLimitUsd);
      const captured = fundingProof === undefined ? await captureTaskStopAdmission({ documentClient: deps.documentClient, tableName: deps.tableName, now: () => deps.now(),
        requireScopeAccess: async input => {
          const fresh = await deps.checkAccess(input.project);
          await requireNewWorkAllowed(deps, deps.orgId, input.project, fresh.role, "task");
          await authorizeSpendingAgent(input.agentId);
        },
      }, { orgId: deps.orgId, developerId: caller.developerId, role: caller.orgRole, project: request.project,
        agentId: prepared?.ref.agentId ?? ROVARA_CODE_AGENT_ID, pathLimitMicrousd: pathLimitMicrousd ?? null,
        ...(requestedMicrousd !== undefined ? { requestedMicrousd } : run?.runLimitUsd === undefined ? {} : { requestedMicrousd: null }),
      }) : { kind: "disabled" as const };
      if (captured.kind === "captured" || fundingProof !== undefined) {
        spendingScopeChecks = await taskStartProjectAuthorityChecks(deps, { orgId: deps.orgId, developerId: caller.developerId, role: caller.orgRole, project: request.project }, async () => {
          const fresh = await deps.checkAccess(request.project);
          await requireNewWorkAllowed(deps, deps.orgId, request.project, fresh.role, "task");
        });
        if (deps.agentRuns !== undefined && prepared !== undefined) {
          const agentId = prepared.ref.agentId, draft = prepared.ref.version === "draft";
          spendingScopeChecks.push(...await taskStartAgentAuthorityChecks(deps, { orgId: deps.orgId, project: request.project, agentId, draft, process: prepared.ref.process === true, developerId: caller.developerId, role: caller.orgRole, ...(prepared.ref.draftRevision === undefined ? {} : { expectedDraftRevision: prepared.ref.draftRevision }) }, async () => {
            if (deps.agentRuns === undefined) throw budgetActorRefused();
            await authorizeSpendingAgent(agentId);
          }, async () => {
            if (deps.agentRuns === undefined) throw budgetActorRefused();
            return deps.agentRuns.store.listShares(deps.orgId, agentId);
          }));
        }
        if (captured.kind === "captured") {
        const exactUsd = captured.effectiveStopMicrousd / 1_000_000;
        if (usdToWholeMicrodollars(exactUsd) !== captured.effectiveStopMicrousd) throw agentXError("TASK_STOP_CONFIG_INVALID", "The task stop can't be represented exactly. Ask an admin to review Spending.");
        if (exactUsd === 0 && !paused) return refused(agentXError("TASK_STOP_ZERO", "Work can't start: the effective spending stop is $0."));
        spendingStop = captured; startLimitUsd = exactUsd;
        if (prepared !== undefined) prepared = { ...prepared, ...runLimitsOf(exactUsd, undefined, prepared.maxPerRunUsd) };
        }
      }
    } catch (error) {
      if (error instanceof AgentXError) return refused(error);
      throw error;
    }
  }
  // What a coding run is asked: the text as sent, or the text with its context rendered and cut to the request limit (G3).
  const requestText = prepared?.runner === "coding" && request.input !== undefined ? codingRequestText(request.input, DEVELOPER_INSTRUCTIONS_MAX_BYTES) : request.instructions;
  // The budget comes first (ruling R23: soft caps, so this is a floor, not a promise): after the agent is resolved, before the limit's counters are read
  // and before any write. Every budget the run counts against is checked (Task 31): the payer's, the project's, the agent's when it pays, and a test run's
  // allowance. A proxy that cannot answer fails the start with nothing recorded; a refusal is audited like any other.
  let admitted: { maxBudgetUsd: number } | undefined;
  if (deps.modelAccess !== undefined) {
    try {
      admitted = await admitWork({ documentClient: deps.documentClient, tableName: deps.tableName, access: deps.modelAccess, now: () => deps.now(), cloud: deps.cloud === true }, {
        orgId: deps.orgId, project: request.project,
        // A run with no agent (an install without agents) is Rovara Code's and the caller's own.
        payer: prepared?.payer ?? { kind: "member", developerId: caller.developerId },
        agentId: prepared?.ref.agentId ?? ROVARA_CODE_AGENT_ID, agentName: prepared?.ref.name ?? "Rovara Code",
        path: admissionPath({ asWorkflow: asWorkflow || settingUpDraft, workflowPath, prepared }),
        // A draft agent's test run is counted on its starter's testing allowance, as `paymentOfTask` counts it afterwards.
        ...(prepared?.origin === "test_run" ? { testRunBy: startedBy?.developerId ?? caller.developerId } : {}),
      });
    } catch (error) {
      if (error instanceof AgentXError && ADMISSION_REFUSALS.has(error.code)) return refused(error);
      throw error;
    }
  }
  const limits = await readWorkspaceLimits(deps.documentClient, deps.tableName, deps.orgId, deps.actions.limitDefaults);
  const charge = developerCharge({ orgId: deps.orgId, teamId: deps.slackTeamId, slackUserId: caller.slackUserId, developerId: caller.developerId });
  // A run started paused (run limit 0) takes no workspace slot until its run limit is raised, so there is nothing to count.
  let full = paused ? undefined : await limitReached(deps.documentClient, deps.tableName, charge, limits);
  // Slots finished tasks kept (merged before releases ran on merge) are given back, then the limit is read once more.
  if (full !== undefined && await releaseFinishedTasksOf(deps, charge.member) > 0) full = await limitReached(deps.documentClient, deps.tableName, charge, limits);
  if (full !== undefined) return refused(await limitError(deps, caller, full, limits));

  // Test environment (wire-testenv): the project's approved environment, if a task may use it, decides the checks the task is held to, and its revision is pinned with the task. Nothing while the switch is off.
  const testEnv = asWorkflow ? await testEnvironmentForStart({ documentClient: deps.documentClient, tableName: deps.tableName, now: () => deps.now() }, { orgId: deps.orgId, project: request.project, taskId }) : {};
  const identity = developerTaskIdentity({ taskId, developerId: caller.developerId, provider: caller.amr, developerName: caller.name, client }, deps.orgId);
  // A setup draft's preparation clones and checks out only (no devcontainer, no setup command, no readiness command), as an agent-step run's does.
  const preparation = await deps.actions.preparation(identity, project, request.requestId, settingUpDraft ? { readOnly: true, setupDraft: true } : prepared?.runner !== "agent_steps" ? undefined : { ...(prepared.checkout.length === 0 ? {} : { checkout: prepared.checkout }), readOnly: true });
  const workspaceId = preparation.workspace.id;
  const conversationId = randomUUID();
  const revision = project.definition.revision;
  const title = redactedTitle(request);
  // The run limit is the task's budget. A task keeps one when the proxy admitted it or the run limit is not the usual one (a lower limit, or 0).
  const budgetUsd = prepared?.runLimitUsd ?? startLimitUsd ?? PER_TASK_BUDGET_USD;
  const keepsBudget = spendingStop !== undefined || admitted !== undefined || (prepared !== undefined && budgetUsd !== PER_TASK_BUDGET_USD);
  const task: DeveloperTaskRecord = {
    ...taskKey(taskId), entityType: "DEVELOPER_TASK", taskId, orgId: deps.orgId,
    ...(fundingProof === undefined ? {} : { fundingProof }),
    ...(spendingStop === undefined ? {} : { spendingStop, spendingAdmission: { requestId: request.requestId, actorId: caller.developerId, intentHash: payloadHash } }),
    ...(keepsBudget ? { budgetUsd } : {}), ...(run?.runLimitUsd === undefined || startLimitUsd === undefined ? {} : { requestedRunLimitUsd: run.runLimitUsd }), developerId: caller.developerId, provider: caller.amr, developerName: caller.name,
    ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
    client, project: request.project, title, workspaceId, ownerKey: identity.ownerKey, conversationId, startingRevision: revision,
    // A workflow task quotes the request in each plan's "why"; every start (Slack and AI tool) comes through here.
    ...(asWorkflow ? { requestText: storedRequestText(requestText) } : {}),
    ...(run?.codeIntent?.retryOf === undefined ? {} : { retryOfTaskId: run.codeIntent.retryOf }),
    // NH-1: a nightly test run is a task of its own purpose, with what it was started to run.
    ...(run?.nightlyRun === undefined ? {} : { purpose: "nightly_run" as const, nightlyRun: run.nightlyRun }),
    ...(settingUpDraft && run?.nightlyRun === undefined ? run?.diagnosis !== undefined ? { purpose: "diagnosis" as const, diagnosis: run.diagnosis } : run?.setupAgent !== undefined ? { purpose: "setup_agent" as const, setupAgentLimits: run.setupAgent.limits } : { purpose: "setup_draft" as const } : {}),
    charge, shared: share !== undefined, ...(share === undefined ? {} : { share, shareVersion: 1 }),
    createdAt: receivedAt, updatedAt: receivedAt,
    ...(asWorkflow ? { workflow: createWorkflowSnapshot({
      taskId, ownerId: identity.ownerKey, now: receivedAt, path: workflowPath, checkPolicy: taskWorkflowCheckPolicy(project.definition, testEnv.used?.environment),
      ...(prepared?.program === undefined ? {} : { program: prepared.program }),
      // A 1.1.0 workflow alone may hold the new stages: it starts at UNDERSTAND/READY, and says whether the request or Understand chose the path.
      ...(hasPlanCheck ? { definitionVersion: "1.1.0" as const } : {}),
      ...(understandsFirst ? { understand: true, pathFrom: request.workflowPath === undefined ? "understand" as const : "request" as const } : {}),
    }) } : {}),
    ...(prepared === undefined ? {} : {
      agent: prepared.ref, origin: prepared.origin, payer: prepared.payer, place: prepared.place,
      ...(startedBy === undefined ? {} : { startedBy }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(prepared.chain === undefined ? {} : { chain: prepared.chain }),
      ...(prepared.maxPerRunUsd === undefined ? {} : { maxPerRunUsd: prepared.maxPerRunUsd }),
      // The pull requests the held preparation checks out are kept with the pause: its dispatch is built again when the run limit is raised (Task 32).
      ...(paused ? { budgetPause: { scope: { kind: "task" as const, taskId }, at: receivedAt, firstDispatch: { operationId: preparation.operationId, ...(prepared.checkout.length === 0 ? {} : { checkout: [...prepared.checkout] }), ...(prepared.runner === "agent_steps" || settingUpDraft ? { readOnly: true as const } : {}) } } } : {}),
    }),
  };
  const index: DeveloperTaskIndexRecord = {
    ...taskIndexKey(caller.developerId, receivedAt, taskId), entityType: "DEVELOPER_TASK_INDEX", taskId, orgId: deps.orgId, project: request.project, title, client,
    status: "STARTING", shared: share !== undefined, startingRevision: revision, workspaceId, createdAt: receivedAt, updatedAt: receivedAt,
  };
  const pointer: DeveloperTaskPointerRecord = {
    ...taskPointerKey(workspaceId), entityType: "DEVELOPER_TASK_POINTER", taskId, developerId: caller.developerId,
    requester: { kind: "developer", developerId: caller.developerId, provider: caller.amr },
    // FR-019: the instructions exactly as the tool sent them; only the audit record is redacted.
    // An agent-step run queues no coding task: its first step is the engine's (Task 22), never Pi's task run.
    // A task that understands first queues no planning run: its first step is the engine's (like an agent-step run's), so no model is asked before Understand runs.
    conversationId, firstRequestId: randomUUID(), ...(prepared?.runner === "agent_steps" || understandsFirst ? {} : { pendingPrompt: requestText }),
    ...(asWorkflow && !understandsFirst ? { pendingWorkflowMode: "PLAN" as const } : settingUpDraft ? { pendingWorkflowMode: run?.nightlyRun !== undefined ? "CHECKS" as const : run?.setupAgent !== undefined ? "SETUP_AGENT" as const : "SETUP_DRAFT" as const } : {}),
  };
  const turn = aiToolTurn({
    party: { ...party, workspaceId, settingsRevision: revision }, turnId: randomUUID(), action: "start", phase: "accepted", outcome: "accepted",
    receivedAt, finishedAt: iso(deps), request: request.instructions, response: `Task ${taskId} is STARTING on ${request.project} revision ${revision}.`,
  });
  // A paused run is prepared but not dispatched: the workspace and its prepare operation are written, the outbox item that sends the prepare is not.
  const noted = setupNote === undefined ? preparation.items : withFirstEvent(preparation.items, deps.tableName, setupNote, receivedAt);
  const preparedItems = paused ? noted.filter((item) => (item.Put?.Item as { entityType?: unknown } | undefined)?.entityType !== "OUTBOX") : noted;
  const preparationItems = spendingStop === undefined ? preparedItems : preparedItems.map(item => item.Put?.Item?.entityType === "OPERATION"
    ? { Put: { ...item.Put, Item: { ...item.Put.Item, spendingTaskId: taskId, spendingAdmission: task.spendingAdmission } } } : item);
  const items: TransactItems = [
    // First, at positions 0 and 1: chargeConflict reads the cancellation reasons by position (a paused run takes no slot).
    ...(paused ? [] : chargeItems(deps.tableName, charge, limits, taskId)),
    ...preparationItems,
    ...(fundingProof === undefined ? [] : fundingAuditItems(deps.tableName, fundingProof, { taskId, occurrence: request.requestId, actor: { kind: "member", id: caller.developerId }, at: deps.now() })),
    putNew(deps.tableName, { ...task }),
    ...(spendingStop === undefined ? [] : taskStopWindowItems(deps.tableName, {
      orgId: deps.orgId, taskId, requestId: request.requestId, actorId: caller.developerId, intentHash: payloadHash,
      project: request.project, agentId: spendingStop.agentId,
    }, spendingStop, preparation.operationId, receivedAt, 0)),
    ...(testEnv.pin === undefined ? [] : [testEnv.pin]),
    ...(share?.threadTs === undefined ? [] : [putNew(deps.tableName, {
      ...sharedTaskKey({ teamId: share.teamId, channelId: share.channelId, threadTs: share.threadTs }),
      entityType: "SHARED_TASK", taskId, workspaceId, ownerKey: task.ownerKey, developerId: task.developerId,
      developerName: task.developerName, project: task.project, mode: share.mode, sharedAt: share.sharedAt,
      // Only a Slack-started task (startSlackWorkflow sets initialSlackThread) is driven from its thread.
      ...(deps.initialSlackThread !== undefined && asWorkflow ? { workflowThread: true } : {}),
    })]),
    putNew(deps.tableName, { ...index }),
    putNew(deps.tableName, { ...pointer }),
    // FR-055, C17: the stuck-setup sweep's watch on this prepare, keyed by the prepare's creation
    // (the task's start, Q5). Only developer-task starts write one (Q4); the sweep removes it.
    ...(paused ? [] : [putNew(deps.tableName, {
      ...setupWatchKey(preparation.workspace.createdAt, workspaceId), entityType: "SETUP_WATCH",
      workspaceId, operationId: preparation.operationId, taskId, createdAt: preparation.workspace.createdAt,
    })]),
    putNew(deps.tableName, { pk: `WORKSPACE#${workspaceId}`, sk: `CONVERSATION#${conversationId}`, entityType: "CONVERSATION", id: conversationId, workspaceId, createdAt: receivedAt, updatedAt: receivedAt }),
    putNew(deps.tableName, { ...idempotencyKey, entityType: "IDEMPOTENCY", taskId, payloadHash }),
    // Plan 6 Task 4: a version 2 task starts by understanding the request, as a dispatch row like every automatic step; it runs once the preparation has ended.
    ...(understandsFirst ? [workflowDispatchItem(deps.tableName, taskId, 1, "UNDERSTAND", WORKFLOW_NO_CANDIDATE_DIGEST, receivedAt)] : []),
    // R12: the accepted record commits with the start or not at all (ruling F15).
    putNew(turns, turn),
    // Plan 6 Task 10: the project's pointer to this draft, in this same transaction; it holds only while the pointer is the one the route read.
    ...(run?.setupDraft === undefined ? [] : [setupDraftPointerItem(deps.tableName, {
      orgId: deps.orgId, project: request.project, taskId, requestId: request.requestId, requestedBy: caller.developerId, basedOnRevision: revision, startedAt: receivedAt, seenTaskId: run.setupDraft.seenTaskId,
    })]),
    // SH14: the project's pointer to this setup run (one run per project), in this same transaction; it holds only while the pointer is the one the route read.
    ...(run?.setupAgent === undefined ? [] : [setupAgentPointerItem(deps.tableName, {
      orgId: deps.orgId, project: request.project, taskId, requestId: request.requestId, requestedBy: caller.developerId, basedOnRevision: revision, startedAt: receivedAt, limits: run.setupAgent.limits, seenTaskId: run.setupAgent.seenTaskId,
    })]),
    // Plan 3, Task 15: the frozen recipe, the agent's task index, an agent-step run's state and (for startAgentRun) the run's request item.
    ...(prepared === undefined ? [] : runStartItems({ documentClient: deps.documentClient, tableName: deps.tableName, now: () => deps.now() }, {
      orgId: deps.orgId, taskId, createdAt: receivedAt, project: request.project, developerId: caller.developerId, prepared,
      ...(spendingStop === undefined ? {} : { policySnapshotCaptured: true }),
      ...(run?.requestFingerprint === undefined ? {} : { request: { requestId: request.requestId, fingerprint: run.requestFingerprint } }),
      ...(sessionId === undefined ? {} : { sessionId }),
    })),
    // Plan 5, Task 2: the session, last, so the positions the charge conflict reads stay where they were. A task shared to a Slack thread in this
    // same transaction is bound to it here; a thread shared later is bound when the notifier records it (Task 20).
    ...(prepared === undefined || sessionId === undefined || sessionStartedBy === undefined ? [] : [
      ...createTaskSessionItems({ documentClient: deps.documentClient, tableName: deps.tableName, now: () => deps.now() }, {
        orgId: deps.orgId, sessionId, taskId, project: request.project, agent: { agentId: prepared.ref.agentId, name: prepared.ref.name, version: prepared.ref.version },
        title: inertTaskTitle(title), owner: { developerId: caller.developerId, name: caller.name }, startedBy: sessionStartedBy, ...(starterName === undefined ? {} : { startedByName: starterName }), origin: prepared.origin, payer: prepared.payer, now: receivedAt,
      }),
      ...threadBindingItems({ tableName: deps.tableName }, deps.orgId, sessionId, share, receivedAt),
      // Plan 6 Task 3: a Linear issue a Rovara Code intent came from is bound in this same transaction (a Slack thread is bound by the share above).
      ...(codeBinding === undefined || codeBinding.kind === "slack_thread" ? [] : bindingItems({ tableName: deps.tableName }, deps.orgId, sessionId, codeBinding, receivedAt)),
    ]),
  ];
  const spendingAuthorityIndexes = new Set<number>();
  if (spendingStop !== undefined || fundingProof !== undefined) for (const guard of [...(fundingProof === undefined ? [] : [fundingRevisionCheck(deps.tableName, fundingProof)]), ...budgetActorChecks(deps.tableName, deps.orgId, { developerId: caller.developerId, role: caller.orgRole }), ...spendingScopeChecks]) {
    const check = guard.ConditionCheck;
    if (check?.Key === undefined) throw budgetActorRefused();
    const checkKey = check.Key;
    const index = items.findIndex(item => {
      const action = item.Update ?? item.ConditionCheck;
      return action?.Key?.pk === checkKey.pk && action?.Key?.sk === checkKey.sk;
    });
    if (index < 0) { spendingAuthorityIndexes.add(items.length); items.push(guard); continue; }
    const item = items[index]!, action = item.Update ?? item.ConditionCheck!;
    for (const [name, value] of Object.entries(check.ExpressionAttributeNames ?? {})) if (action.ExpressionAttributeNames?.[name] !== undefined && action.ExpressionAttributeNames[name] !== value) throw budgetActorRefused();
    for (const [name, value] of Object.entries(check.ExpressionAttributeValues ?? {})) if (action.ExpressionAttributeValues?.[name] !== undefined && !isDeepStrictEqual(action.ExpressionAttributeValues[name], value)) throw budgetActorRefused();
    const names = { ...action.ExpressionAttributeNames, ...check.ExpressionAttributeNames }, values = { ...action.ExpressionAttributeValues, ...check.ExpressionAttributeValues };
    const combined = { ConditionExpression: action.ConditionExpression === undefined ? check.ConditionExpression : `(${action.ConditionExpression}) AND (${check.ConditionExpression})`, ...(Object.keys(names).length === 0 ? {} : { ExpressionAttributeNames: names }), ...(Object.keys(values).length === 0 ? {} : { ExpressionAttributeValues: values }) };
    items[index] = item.Update === undefined ? { ConditionCheck: { ...item.ConditionCheck!, ...combined } } : { Update: { ...item.Update, ...combined } };
    spendingAuthorityIndexes.add(index);
  }
  if(prepared?.modelPolicyPin!==undefined&&items.length>90) throw agentXError("CONFIG_INVALID","The model admission exceeds the transaction limit.");
  try {
    await deps.actions.transact(items);
  } catch (error) {
    if (!isConditional(error)) throw error;
    if (spendingStop !== undefined && [...(failedIndexes(error) ?? [])].some(index => spendingAuthorityIndexes.has(index))) return refused(budgetActorRefused());
    const conflict = paused ? undefined : await chargeFailure(deps, charge, taskId, error);
    // This task's own charge is there: the transaction committed and only its answer was lost.
    if (conflict === "already_charged") return returning({ taskId, payloadHash });
    // The same request, sent again, committed first.
    const concurrent = await get<{ taskId: string; payloadHash: string }>(deps, idempotencyKey);
    if (concurrent !== undefined) return returning(concurrent);
    // The same run request, sent again by another path or person, committed first: the same request is answered from it, another is refused.
    if (run?.requestFingerprint !== undefined) {
      const stored = await readRunRequest({ documentClient: deps.documentClient, tableName: deps.tableName, now: () => deps.now() }, deps.orgId, request.requestId);
      if (stored !== undefined) {
        if (stored.fingerprint !== run.requestFingerprint) throw agentXError("IDEMPOTENCY_CONFLICT", "this request_id was already used for another run; use a new request_id");
        return { task: await taskView(deps, await loadOwnedTask(deps, caller, stored.taskId), { events: DEVELOPER_EVENTS_DEFAULT, details: false }), run: stored.result };
      }
    }
    // A counter filled between the check and the transaction.
    if (conflict !== undefined) return refused(await limitError(deps, caller, conflict, limits));
    // The Linear issue already follows a session: the binding's own items refused the start, and nothing else was written.
    if (codeBinding?.kind === "linear_issue" && await surfaceIsBound(deps, codeBinding)) throw agentXError("CONFIG_INVALID", "This issue already follows another session.");
    // Meta repo lane F: the same for a ticket of any other tracker (one session per ticket, however it was asked for).
    if (codeBinding?.kind === "tracker_item" && await surfaceIsBound(deps, codeBinding)) throw agentXError("CONFIG_INVALID", "This ticket already follows another session.");
    throw agentXError("WORKSPACE_BUSY", "AgentX could not start the task just now; try again with the same request_id");
  }
  return {
    task: await withTestingNotice(deps, task, await taskView(deps, task, { events: 0, details: false })),
    ...(run === undefined || prepared === undefined ? {} : { run: { taskId, runLimitUsd: prepared.runLimitUsd, stopAtUsd: prepared.stopAtUsd, paused: prepared.paused } }),
  };
}
