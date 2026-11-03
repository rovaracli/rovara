import { logDeveloperEvent } from "../../developer/log.js";
import { randomUUID } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  AgentXError,
  agentXError,
  forbiddenModelMatcher,
  isSystemOwnerId,
  MEMBER_GRANT_SK_PREFIX,
  memberGrantsPk,
  orgMemberKey,
  type AgentId,
  type DeveloperTaskView,
  type RunInput,
  StartDeveloperTaskRequestSchema,
  workflowAnswer,
  type MergeTrackingItem,
} from "@agentx/contracts";
import { chooseDiagnosisRoute } from "../../model-sources/diagnosis-provider.js";
import { latestRevision } from "../../org/project-settings.js";
import { cutText } from "../developer-tasks/common.js";
import { readProjectMeta, requireNewWorkAllowed } from "../../developer/project-roles.js";
import { survivorOf } from "../../org/project-members.js";
import { evaluateProjectAuthority } from "../../developer/task-project-access.js";
import {
  checkTaskPersonIdentity,
  registerTaskChannelPeople,
  resolveTaskPickerPersonWithId,
  type TaskPersonIdentityDependencies,
} from "../../developer/task-person-identity.js";
import { taskPeopleDisplayAdmission, type TaskPeopleDisplayAdmission } from "../../developer/task-people-display-budget.js";
import { safeDisplayName } from "../../developer/person-name.js";
import { readChosenName } from "../../developer/chosen-name.js";
import { META, type DeveloperRecord } from "../../developer/store.js";
import type { DeveloperTaskRecord } from "../../developer/task-records.js";
import {
  CLOSED_TASK,
  cancelTask,
  cancelTaskFor,
  decideTaskWorkflow,
  loadOwnedTask,
  retryTaskWorkflowFor,
  startAlreadyMade,
  startTask,
  startTaskWorkflowUnderstandFromSystem,
  taskView,
  type DeveloperTaskRouteDependencies,
} from "../developer-tasks.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { StatusReply } from "../status-reply.js";
import type { ChainRouteDependencies } from "../../chains/routes.js";
import { chainRunPortsFor, type ChainRunPorts, type ChainRunnerDependencies } from "../../chains/runner.js";
import { chainControlFor, chainSessionReads, chainSteerReadsFor } from "../../chains/session-seam.js";
import { chainViewPortsFor } from "../../chains/view-ports.js";
import { realtimeConfigFromEnvironment } from "../../realtime/sink.js";
import type { SessionRouteDependencies } from "../../agent-sessions/routes.js";
import { requireSessionLevel } from "../../agent-sessions/access.js";
import type { SessionTakeOverDependencies } from "../../agent-sessions/take-over.js";
import { startAgentRun, type AgentRunStarter } from "../../agents/runs.js";
import type { CodeIntentRouteDependencies } from "../../rovara-code/routes.js";
import { projectProcessOf } from "../../playbook/project-process.js";
import { mergeViewOf } from "../../rovara-code/merge.js";
import type { SetupDraftDependencies } from "../../rovara-code/setup-draft.js";
import { startCodeIntent } from "../../rovara-code/intent.js";
import { NEEDS_OWNER_APPROVAL, gateRunVersion } from "../../agents/run-version-gate.js";
import { pausedTaskGate, requestForPausedTask, withdrawTaskSpendRequests } from "../../spend/requests.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";
import { errorName } from "./identity-lambda.js";
import { getSignIn } from "./authentication.js";
import {
  appProjectSummary,
  setupCheckDepsOf,
  bindingsOf,
  channelNames,
  latestDefinition,
  latestProjectRecord,
  projectMembersDepsOf,
  projectMembersOf,
  queryAll,
  safeChannelMembers,
} from "./project-list.js";
import { getAppProject, startListsCandidateSetupCheck, startProjectSetupCheck } from "./project-archive-setup.js";
import { candidateStateOf } from "./test-environment-candidate.js";
import { adoptCandidateAsProjectCheck, setupCheckReplay } from "../../org/project-setup-check.js";
import { projectRoleForRoute } from "./project-members.js";
import { putProjectSettings } from "./project-settings.js";
import { checkProjectAccess } from "./project-access.js";
import { putCodeSettings, readCodeSettings } from "../../rovara-code/code-settings.js";
import { requireGithubRecord } from "../../plugins/code-host/github-only.js";
import { diagnosisEnabled, diagnosisTagKeyOf } from "../../diagnosis/switch.js";
import type { DiagnosisRouteDependencies } from "../../diagnosis/routes.js";
import { putProjectSettingsChecked } from "./settings-proof.js";

/** What the setup-draft routes (Plan 6 Task 10) need, from the developer API's dependencies and for one caller. */
export function setupDraftDepsOf(deps: DeveloperRouteDependencies): SetupDraftDependencies {
  return {
    documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now,
    starter: agentRunStarterOf(deps),
    projectFor: (who, rawName) => projectRoleForRoute(deps, who, rawName),
    requireNewWork: (who, project, role) => requireNewWorkAllowed(deps, who.orgId, project, role, "task"),
    latest: async (orgId, project) => {
      const latest = await latestRevision({ documentClient: deps.documentClient, tableName: deps.tableName }, orgId, project);
      return latest === undefined ? undefined : { revision: latest.definition.revision, allowedDomains: latest.definition.network?.allowedDomains ?? [], definition: latest.definition };
    },
    updateSettings: (who, project, body, options) => putProjectSettings(deps, who, encodeURIComponent(project), body, options),
    startSetupCheck: async (who, project, requestId) => { await startProjectSetupCheck(deps, who, encodeURIComponent(project), { requestId }); },
    startPullRequest: async (who, request) => {
      const started = await startCodeIntent(codeIntentDependenciesOf(deps, who), who, { requestId: request.requestId, project: request.project, input: { text: request.text }, path: "QUICK", source: "app" });
      const taskId = (started.task as { taskId: string }).taskId;
      return { taskId, ...(started.sessionId === undefined ? {} : { sessionId: started.sessionId }), ...(started.sessionUrl === undefined ? {} : { sessionUrl: started.sessionUrl }) };
    },
    readProject: (who, project) => getAppProject(deps, who, project),
    // TE-3: a draft's setup and test commands are run on a fresh workspace (a candidate check) before they are saved. Where setup checks are not set up the apply saves no commands.
    ...(deps.tasks === undefined ? {} : {
      candidate: {
        read: (who, project, digest, definition) => candidateStateOf(deps, who.orgId, project, digest, definition),
        started: (who, project, requestId) => setupCheckReplay(setupCheckDepsOf(deps), who.orgId, project, requestId, who.developerId),
        start: async (who, project, input) => { await startListsCandidateSetupCheck(deps, who, encodeURIComponent(project), input); },
        adopt: (who, project, input) => adoptCandidateAsProjectCheck(setupCheckDepsOf(deps), { orgId: who.orgId, project, actorId: who.developerId, ...input }),
      },
    }),
    // Meta repo lane B: a risky item of the setup agent's proposal gets its own approval card, and its citations are re-read from GitHub.
    ...(deps.agents === undefined ? {} : { approvals: deps.agents }),
    ...(deps.setupCitationReader === undefined ? {} : { readFile: deps.setupCitationReader }),
  };
}

/**
 * Live interaction F2: what the Fix with agent routes need, built for one caller. Undefined while the `fd` switch is off (every route is then NOT_FOUND), and where sessions or tasks are not set up
 * (a diagnosis reads the task through its session and the person's level on it, so without them nothing is offered: fail closed).
 */
export function diagnosisRouteDepsOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller): DiagnosisRouteDependencies | undefined {
  if (!diagnosisEnabled()) return undefined;
  const sessions = sessionDependenciesOf(deps);
  if (sessions === undefined || deps.tasks === undefined || sessions.cursorKey === undefined) return undefined;
  const access = sessionReadDependencies(deps, caller);
  const taskDeps = developerTaskRouteDependencies(deps, caller);
  const table = { documentClient: deps.documentClient, tableName: deps.tableName };
  return {
    ...table, now: deps.now, enabled: true, edition: deps.editionPolicy?.edition ?? "public", queue: deps.developer.slackRequestQueue,
    // 2026-11-03: a diagnosis runs on the company's own AI provider (Rovara pays for none); with no usable one it is not offered. Absent routing (no model proxy, no agents): not offered.
    providerUsable: async (orgId, project) => {
      const routing = deps.agents?.modelRouting;
      if (routing === undefined) return false;
      const forbidden = forbiddenModelMatcher(routing.forbiddenModels === undefined ? [] : await routing.forbiddenModels(orgId));
      return await chooseDiagnosisRoute(routing, orgId, project, forbidden) !== undefined;
    },
    authority: { ...table, access },
    audit: { ...table, ...(deps.audit === undefined ? {} : { audit: deps.audit }) },
    log: (entry) => console.log(JSON.stringify({ component: "broker", ...entry })),
    // The deep tier starts a read-only task as the person (the ordinary start: their role, their payer, the allowed models, the budget floor and the planning limit).
    deep: (() => { const starter = agentRunStarterOf(deps); return starter === undefined ? undefined : { starter }; })(),
    // "Apply this change" goes through the ordinary settings routes, as the person: the project's code settings and its settings save. A citation is read again with the setup draft's file reader.
    propose: {
      project: async (orgId, project) => {
        const latest = await latestRevision(table, orgId, project);
        return latest === undefined ? undefined : { revision: latest.definition.revision, devcontainer: latest.definition.devcontainer, repositories: latest.definition.repositories.map((repository) => ({ name: repository.name, url: repository.url })) };
      },
      codeSettings: (orgId, project) => readCodeSettings(table, orgId, project),
      putCodeSettings: (who, project, body) => putCodeSettings({ ...table, now: deps.now, projectFor: (person, rawName) => projectRoleForRoute(deps, person, rawName) }, who, project, body, deps.agents),
      // TE-4: "Apply this change" saves commands through the same proof as the settings route (a browser saves at once and is checked; a token is held).
      updateSettings: (who, project, body, options) => putProjectSettingsChecked(deps, who, encodeURIComponent(project), body, options),
      ...(deps.setupCitationReader === undefined ? {} : { readFile: deps.setupCitationReader }),
      ...(deps.defaultBranchFileReader === undefined ? {} : { readDefaultBranchFile: deps.defaultBranchFileReader }),
    },
    context: {
      ...table, edition: deps.editionPolicy?.edition ?? "public", tagKey: diagnosisTagKeyOf(sessions.cursorKey),
      // The person's own view of the task: its error reference, failure and events, as the app shows them. `details: false` reads nothing the diagnosis does not use and writes nothing.
      taskView: (task) => taskView(taskDeps, task, { events: 80, details: false, actor: "viewer" }),
      projectDefinition: async (orgId, project) => {
        const latest = await latestRevision(table, orgId, project);
        return latest === undefined ? undefined : {
          devcontainer: latest.definition.devcontainer, repositories: latest.definition.repositories.map((repository) => repository.name),
          allowedWebsites: latest.definition.network?.allowedDomains?.length ?? 0,
        };
      },
      setupState: async (who, project) => {
        const [record, meta] = await Promise.all([latestProjectRecord(deps, who.orgId, project), readProjectMeta(deps, who.orgId, project)]);
        if (record === undefined) return undefined;
        const summary = await appProjectSummary(deps, project, "maintainer", record, meta);
        return { status: summary.setup.status, ...(summary.setup.failedStep === undefined ? {} : { failedStep: summary.setup.failedStep }), ...(summary.setup.errorRef === undefined ? {} : { errorRef: summary.setup.errorRef }) };
      },
    },
  };
}

/**
 * Plan 3, Task 15: what `startAgentRun` needs from the developer API: the person a run acts as (their sign-in record and org membership now),
 * and the task start for that person. Undefined where agents are not set up.
 */
export function agentRunStarterOf(deps: DeveloperRouteDependencies): AgentRunStarter | undefined {
  if (deps.agents === undefined) return undefined;
  return {
    ...deps.agents,
    callerFor: async (orgId, developerId) => {
      // A project's system owner is no person to act as: it has no sign-in record, and is refused here before one is looked for.
      if (isSystemOwnerId(developerId)) return undefined;
      const [developer, chosenName] = await Promise.all([
        getSignIn<Pick<DeveloperRecord, "provider" | "displayName" | "slackUserId" | "email" | "revoked">>(deps, `DEVELOPER#${developerId}`),
        readChosenName(deps.documentClient, deps.tableName, developerId),
      ]);
      const membership = await deps.orgs?.orgForDeveloper(developerId);
      if (developer === undefined || developer.revoked || membership === undefined || membership.orgId !== orgId) return undefined;
      return {
        developerId, sessionId: "agent-run", amr: developer.provider, name: chosenName ?? safeDisplayName(developer.displayName, developerId), orgId, orgRole: membership.role,
        ...(developer.slackUserId === undefined ? {} : { slackUserId: developer.slackUserId }),
        ...(developer.email === undefined ? {} : { email: developer.email }),
      };
    },
    startTask: async (caller, body, run) => {
      // Plan 6 Task 3: a Rovara Code intent from a Slack thread is started shared to that thread, as the Slack workflow always was.
      const binding = run.codeIntent?.binding;
      const thread = binding?.kind === "slack_thread" ? { teamId: binding.teamId, channelId: binding.channelId, threadTs: binding.threadTs } : undefined;
      const answer = await startTask(developerTaskRouteDependencies(deps, caller, thread), caller, body, run);
      if (answer.run === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the run did not report its limits");
      // Plan 3, Task 32 (PF17): a run started with a run limit of 0 waits for its limit: the run_limit request asks for it. The start stands either way; a
      // request that can't be made now is asked for again by the next pause, or by a repeat of the start (the request is once per task).
      if (answer.run.paused && deps.agents !== undefined) {
        await requestForPausedTask(deps.agents, answer.task.taskId).catch((error: unknown) => {
          logDeveloperEvent({ event: "spend_request.not_asked", error: errorName(error) });
        });
      }
      return { task: answer.task, run: answer.run };
    },
    // Plan 4 Task 9: a chain stops a step's task through the owner's own cancel (the same path as their cancel button), so the workspace, the keys and the end are Plan 3's.
    cancelTask: async (caller, taskId, requestId) => {
      try {
        await cancelTask(developerTaskRouteDependencies(deps, caller), caller, taskId, { requestId });
      } catch (error) {
        // A task that was closed is over: there is nothing left to stop.
        if (error instanceof AgentXError && error.message.endsWith(CLOSED_TASK)) return;
        throw error;
      }
    },
  };
}

/**
 * Plan 6 Task 3: what `startCodeIntent` needs for one caller, from the developer API's dependencies: Plan 3's run start where agents are set up, the plain task start where they are
 * not, the person's own task view, and the origin session links are made from. The routes and the broker's Slack start and `createCodeIntentStarter` all build it here.
 */
export function codeIntentDependenciesOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller): CodeIntentRouteDependencies {
  const taskDeps = developerTaskRouteDependencies(deps, caller);
  return {
    starter: agentRunStarterOf(deps),
    startPlainTask: (who, body, thread) => startTask(developerTaskRouteDependencies(deps, who, thread), who, body),
    ownedTask: async (who, taskId) => taskView(taskDeps, await loadOwnedTask(taskDeps, who, taskId), { events: 0, details: false }),
    projectProcess: (orgId, project) => projectProcessOf({ documentClient: deps.documentClient, tableName: deps.tableName, store: deps.agents?.store }, orgId, project),
    origin: new URL(deps.developer.issuer).origin,
    visibleProject: async (who, rawName) => (await projectRoleForRoute(deps, who, rawName)).name,
    // A follow-up may follow only a task of the caller's own org, whose session they can see, that ended Answered (read now, never trusted from the request).
    retryable: async (who, taskId) => {
      const sessions = sessionDependenciesOf(deps);
      if (sessions === undefined) return false;
      const item = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk: `DEVTASK#${taskId}`, sk: "META" }, ConsistentRead: true }))) as { Item?: DeveloperTaskRecord };
      const task = item.Item;
      if (task === undefined || task.orgId !== who.orgId || task.sessionId === undefined || task.workflow === undefined || workflowAnswer(task.workflow) === undefined) return false;
      // Seen by the caller now (a person who cannot see the session reads it as missing): any refusal is a plain "no".
      try {
        await requireSessionLevel(sessions, who, task.sessionId, "view", "follow it up");
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * The start of an agent at a published version through `POST /v1/dev/tasks` (the CLI's and the AI tools' start): the same gate as the app route's. Only a plain
 * start is gated (no sharing or workflow options, which a run started after approval would not carry); any other start of a less safe older version is refused
 * by the start itself. Undefined when the start goes on as it is.
 */
export async function gateDeveloperStart(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest): Promise<StatusReply | undefined> {
  if (deps.agents === undefined) return undefined;
  let value: unknown;
  try { value = request.body === undefined || request.body === "" ? undefined : JSON.parse(request.body) as unknown; } catch { return undefined; }
  const parsed = StartDeveloperTaskRequestSchema.safeParse(value);
  if (!parsed.success || parsed.data.agent === undefined || typeof parsed.data.agent.version !== "number") return undefined;
  const start = parsed.data;
  if (start.shareToChannel !== undefined || start.shareMode !== undefined || start.channel !== undefined || start.workflow !== undefined || start.workflowPath !== undefined) return undefined;
  // R8 first: a retry of a start already made is answered with the first task whatever the agent's versions are now, so it is never held for the owner or refused.
  if (await startAlreadyMade(developerTaskRouteDependencies(deps, caller), caller, start.requestId)) return undefined;
  const waiting = await gateRunVersion(deps.agents, caller, {
    requestId: start.requestId, project: start.project, agent: { agentId: start.agent!.agentId, version: start.agent!.version! }, input: start.input ?? { text: start.instructions }, origin: "cli",
  });
  return waiting === undefined ? undefined : new StatusReply(202, { status: NEEDS_OWNER_APPROVAL, confirmUrl: waiting.confirmUrl, changes: waiting.changes });
}

/** The app route that starts a run (`POST /v1/app/agents/{id}/runs`): the person's own request, from their own session, through the run start. */
export async function startAppRun(
  deps: DeveloperRouteDependencies,
  caller: DeveloperCaller,
  input: { requestId: string; project: string; agent: { agentId: AgentId; version?: number | "draft" }; input: RunInput },
): Promise<{ task: DeveloperTaskView }> {
  const starter = agentRunStarterOf(deps);
  if (starter === undefined) throw agentXError("NOT_FOUND", "agents are not set up in this deployment");
  const started = await startAgentRun(starter, {
    requestId: input.requestId, orgId: caller.orgId, project: input.project, agent: input.agent, input: input.input, origin: "app",
    owner: { developerId: caller.developerId }, startedBy: { developerId: caller.developerId }, caller,
  });
  const taskDeps = developerTaskRouteDependencies(deps, caller);
  return { task: await taskView(taskDeps, await loadOwnedTask(taskDeps, caller, started.taskId), { events: 0, details: false }) };
}

/**
 * Plan 4's chain dependencies for one caller: the agent routes' own, the chain store, the run view's ports (built over the task layer for this caller, so the task's own rules apply
 * inside a run's view) and, where Plan 3's run start is held, the runner's ports. The chain routes and the chain reads of a session are made from this, once per request: a chain read
 * is bound to the org of the request, never to one fixed when the broker was built. Undefined where chains are not set up.
 */
export function chainRouteDependenciesFor(deps: DeveloperRouteDependencies, caller: DeveloperCaller): (ChainRouteDependencies & { chainRuns?: ChainRunPorts }) | undefined {
  if (deps.agents?.chains === undefined) return undefined;
  // The chain runner starts each step through Plan 3's run start, which this API holds (the task start); a test may bring its own.
  const starter = deps.agents.chainRuns === undefined ? agentRunStarterOf(deps) : undefined;
  const admission = deps.modelAccess === undefined ? undefined : { documentClient: deps.documentClient, tableName: deps.tableName, access: deps.modelAccess, now: deps.now, cloud: deps.cloud === true };
  const agentDeps = deps.agents;
  const chainView = agentDeps.chainView ?? chainViewPortsFor({
    approvals: agentDeps, keySpend: deps.modelAccess === undefined ? undefined : (keyIds) => deps.modelAccess!.keySpend(keyIds),
    taskView: (task) => taskView(developerTaskRouteDependencies(deps, caller), task, { events: 20, details: true, actor: "viewer" }),
  });
  return { ...agentDeps, chains: deps.agents.chains, chainView, ...(starter === undefined ? {} : { chainRuns: chainRunPortsFor(starter, admission) }) };
}

/** What session levels and reads need, from the route dependencies: the broker's own, or those it gave the agent routes. */
export function sessionDependenciesOf(deps: DeveloperRouteDependencies): SessionTakeOverDependencies | undefined {
  return deps.agentSessions ?? deps.agents?.agentSessions;
}

/** The session routes' dependencies for one caller: the task view is built with that caller's task dependencies, so the task's own rules apply inside the session. */
export function sessionReadDependencies(deps: DeveloperRouteDependencies, caller: DeveloperCaller): SessionRouteDependencies {
  const sessions = sessionDependenciesOf(deps), tasks = deps.tasks;
  if (sessions === undefined || tasks === undefined) throw agentXError("NOT_FOUND", "sessions are not set up in this deployment");
  const taskDeps = developerTaskRouteDependencies(deps, caller);
  const mint = deps.developer.realtimeToken;
  // Plan 4's chain reads, messages, stop and retry, made for this request: the reads need the org of the person asking, which the broker doesn't have when it is built.
  const chainDeps = chainRouteDependenciesFor(deps, caller);
  return {
    ...sessions, origin: new URL(deps.developer.issuer).origin,
    ...(deps.handoff === undefined ? {} : { handoff: deps.handoff }),
    ...(deps.sessionDiffFiles === undefined ? {} : { diff: {
      files: deps.sessionDiffFiles,
      pullRequests: workspaceId => taskDeps.actions.pullRequests(workspaceId),
      repository: async (orgId, project, revision, repository) => {
        const registered = await tasks.projectRevision(orgId, project, revision);
        const record = registered?.definition.repositories.find(item => item.name === repository);
        // P5e: the change list is read with GitHub's pull request files (`sessionDiffFiles`), which the code host port does not carry as GitHub shapes them (left for P6). A repository on another
        // host is refused here with a clear sentence, and one whose host this install has not registered with the router's fixed sentence; neither is ever asked of GitHub.
        if (record !== undefined) requireGithubRecord(record, deps.codeHost);
        return record?.url;
      },
    } satisfies NonNullable<SessionRouteDependencies["diff"]> }),
    ...(taskDeps.actions.turnRecordsTableName === undefined ? {} : { turnRecordsTableName: taskDeps.actions.turnRecordsTableName }),
    ...(chainDeps === undefined ? {} : {
      chain: chainSessionReads(chainDeps, caller.orgId),
      chainSteer: chainSteerReadsFor(chainDeps),
      ...(chainDeps.chainRuns === undefined ? {} : { chainControl: chainControlFor(chainDeps as ChainRunnerDependencies) }),
    }),
    // Plan 5 Task 13: Plan 3's cancel, workflow retry and run start, bound to this person. They are called only after the session routes read the person's level on the session.
    control: {
      cancelTask: async (task, requestId) => { const { nothingRunning } = await cancelTaskFor(taskDeps, task, { requestId, actor: { kind: "session", caller } }); return { nothingRunning }; },
      retryWorkflow: async (task, requestId) => { await retryTaskWorkflowFor(taskDeps, task, { requestId, actor: { kind: "session", caller } }); },
      // Stop & redirect while the plan waits for approval: the caller's own request for changes, through the task's decision (their authority as a task owner is checked there).
      requestPlanChanges: async (task, input) => {
        // The decision keeps its own bound (500 characters); the planner is told the whole instruction (LR-2).
        await decideTaskWorkflow(taskDeps, caller, task.taskId, { requestId: input.requestId, expectedRevision: input.expectedRevision, decision: "REQUEST_CHANGES", reason: cutText(input.reason, 500), artifactDigest: input.artifactDigest }, { changeText: input.reason });
      },
      // Plan 6 Task 5: Understand starts again as soon as people answered. A failed start is the answer's dispatch row's to redo, so it is logged by name and not raised.
      startUnderstanding: async (task, workflowRevision) => {
        try {
          await startTaskWorkflowUnderstandFromSystem(taskDeps, task.taskId, { workflowRevision });
        } catch (error) {
          console.log(JSON.stringify({ component: "broker", event: "rovara_code.understand_start_deferred", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" }));
        }
      },
      // Plan 6 Task 20: the open pull request's Fixes line follows a link, an unlink or a replace of the session's Linear issue at once.
      ...(taskDeps.actions.rewriteLinearCloseLine === undefined ? {} : { rewritePullRequestLinearLine: (task: DeveloperTaskRecord, key: string | undefined) => taskDeps.actions.rewriteLinearCloseLine!(task, key) }),
      startAgentRun: async (request) => {
        const starter = agentRunStarterOf(deps);
        if (starter === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "starting runs is not set up in this deployment");
        return startAgentRun(starter, { ...request, caller });
      },
      // Plan 6 Task 6: the "make a change anyway" start, as the caller (they pay), through the one entry point.
      startCodeIntent: (request) => startCodeIntent(codeIntentDependenciesOf(deps, caller), caller, request),
    },
    ...(deps.audit === undefined ? {} : { audit: deps.audit }),
    taskView: (task, options) => taskView(taskDeps, task, options),
    ...(deps.agents === undefined ? {} : { approvals: deps.agents }),
    // Plan 5 Task 16: the project's card, read after the page has checked the person's role in the project.
    projectPage: async (who, name) => {
      const [record, meta] = await Promise.all([latestProjectRecord(deps, who.orgId, name), readProjectMeta(deps, who.orgId, name)]);
      if (record === undefined) return undefined;
      const summary = await appProjectSummary(deps, name, "viewer", record, meta);
      const channels = (await bindingsOf(deps, who.orgId, "project_page.bindings_truncated")).filter((binding) => binding.projectName === name).map((binding) => binding.channelId);
      return {
        name, ...(summary.description === undefined ? {} : { description: summary.description }), status: summary.status, latestRevision: summary.latestRevision, repositories: summary.repositories,
        setup: summary.setup, channels: [...new Set(channels)].slice(0, 20),
      };
    },
    // Plan 5 Task 9: a person arriving on a session is told to its channel through the same API the sink publishes to.
    realtimePublish: realtimeConfigFromEnvironment(),
    // Plan 5 Task 8: the realtime token. Without the sign-in function's signing, or without an events API, the route says live updates are unavailable.
    realtime: {
      endpoint: deps.developer.realtimeEndpoint,
      projectsOf: async (caller) => (await projectMembersOf(deps).projectsOf(caller.orgId, { developerId: caller.developerId, orgRole: caller.orgRole })).map((entry) => entry.project),
      mint: async (request) => {
        const answer = mint === undefined ? undefined : await mint(request);
        if (answer === undefined || !answer.ok) throw agentXError("RUNTIME_UNAVAILABLE", "Live updates aren't available right now.");
        return { token: answer.token, expiresAt: answer.expiresAt };
      },
    },
  };
}

export function developerTaskRouteDependencies(
  deps: DeveloperRouteDependencies,
  caller: DeveloperCaller,
  initialSlackThread?: { teamId: string; channelId: string; threadTs: string },
  trustedCaller: DeveloperCaller | null = caller,
): DeveloperTaskRouteDependencies {
  const projectChannelIds = async (project: string) => (await bindingsOf(deps, caller.orgId))
    .filter((binding) => binding.projectName === project)
    .map((binding) => binding.channelId)
    .sort();
  const identityDependencies = (admission?: TaskPeopleDisplayAdmission): TaskPersonIdentityDependencies => {
    const slackTeamId = deps.developer.slackTeamId;
    const taskPersonProof = admission?.proof.bind(admission) ?? deps.developer.taskPersonProof;
    if (slackTeamId === undefined || taskPersonProof === undefined) throw agentXError("SLACK_UNAVAILABLE", "task person identity proof is unavailable");
    return {
      documentClient: deps.documentClient, tableName: deps.tableName, slackTeamId, now: deps.now, uuid: randomUUID, taskPersonProof,
      developerRecord: async (targetDeveloperId) => {
        const response = await deps.documentClient.send(new GetCommand({ TableName: deps.developer.signInTableName, Key: { pk: `DEVELOPER#${targetDeveloperId}`, sk: META }, ConsistentRead: true })) as { Item?: DeveloperRecord };
        // The row is keyed by the person: a sign-in writes no `developerId` attribute (store.ts getDeveloper). A row naming someone else keeps its id, and is refused.
        return response.Item === undefined ? undefined : { ...response.Item, developerId: response.Item.developerId ?? targetDeveloperId };
      },
      projectChannelIds,
      targetProjectAccess: async (subject, project, freshMemberOf) => {
        const revision = await latestDefinition(deps, caller.orgId, project);
        if (revision === undefined) throw agentXError("PROJECT_NOT_FOUND", `project \`${project}\` doesn't exist in this AgentX`);
        const [memberships, allBindings, subjectOrg] = await Promise.all([
          queryAll<{ projectName: string; role?: string }>(deps, memberGrantsPk(caller.orgId, subject.developerId), MEMBER_GRANT_SK_PREFIX),
          bindingsOf(deps, caller.orgId),
          deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgMemberKey(caller.orgId, subject.developerId), ConsistentRead: true })) as Promise<{ Item?: { role?: string } }>,
        ]);
        // An org owner or admin is a maintainer of every project in the org with no grant, as `checkProjectAccess` counts them (final review I1).
        const orgMember = subjectOrg.Item === undefined ? undefined : { ...orgMemberKey(caller.orgId, subject.developerId), ...(subjectOrg.Item.role === undefined ? {} : { role: subjectOrg.Item.role }) };
        const result = evaluateProjectAuthority({
          orgId: caller.orgId, developerId: subject.developerId,
          project,
          revision: { revision: revision.revision, definition: { developerTasks: revision.developerTasks } },
          memberships,
          bindings: allBindings,
          ...(orgMember === undefined ? {} : { orgMember }),
          freshMemberOf,
          ...(subject.slackUserId === undefined ? {} : { slackUserId: subject.slackUserId }),
        });
        if (result.kind === "allowed") return;
        if (result.kind === "denied" && result.reason === "project-viewer") return "viewer";
        if (result.kind === "unavailable" || result.kind === "needs-membership") {
          throw agentXError("SLACK_UNAVAILABLE", "task person identity proof is unavailable");
        }
        if (result.kind === "not-found") throw agentXError("PROJECT_NOT_FOUND", `project \`${project}\` doesn't exist in this AgentX`);
        if (result.kind === "denied" && result.reason === "tasks-disabled") {
          throw agentXError("PROJECT_TASKS_DISABLED", `tasks from AI tools are turned off for \`${project}\`; use the project's Slack channel, or ask an admin`);
        }
        // System qualification has no channel-name lookup or human-facing error decoration.
        throw agentXError("PROJECT_ACCESS_DENIED", "task person identity could not be verified");
      },
      ...(trustedCaller === null ? {} : { trustedCaller }),
    };
  };
  const agents = deps.agents;
  const ledger = agents?.audit ?? deps.audit;
  const agentSessions = sessionDependenciesOf(deps);
  return {
    documentClient: deps.documentClient,
    tableName: deps.tableName,
    orgId: caller.orgId,
    ...(agentSessions === undefined ? {} : { agentSessions }),
    // A taker who was merged into another member since is the owner as the member they became (Plan 5 Task 12a review, M-3).
    resolveMember: (developerId) => survivorOf(projectMembersDepsOf(deps), developerId),
    ...(deps.developer.slackTeamId === undefined ? {} : { slackTeamId: deps.developer.slackTeamId }),
    issuer: deps.developer.issuer,
    actions: deps.tasks!,
    ...(deps.modelAccess === undefined ? {} : { modelAccess: deps.modelAccess }),
    ...(deps.cloud === true ? { cloud: true } : {}),
    ...(deps.workflowE2EPresentation === undefined ? {} : { workflowE2EPresentation: deps.workflowE2EPresentation }),
    ...(deps.workflowE2EPublicationChecks === undefined ? {} : { workflowE2EPublicationChecks: deps.workflowE2EPublicationChecks }),
    ...(deps.currentPullRequestHead === undefined ? {} : { currentPullRequestHead: deps.currentPullRequestHead }),
    ...(deps.readMetaFile === undefined ? {} : { readMetaFile: deps.readMetaFile }),
    ...(deps.readSpecPullRequest === undefined ? {} : { readSpecPullRequest: deps.readSpecPullRequest }),
    ...(deps.publishSpecFiles === undefined ? {} : { publishSpecFiles: deps.publishSpecFiles }),
    ...(deps.currentBaseCommit === undefined ? {} : { currentBaseCommit: deps.currentBaseCommit }),
    ...(deps.taskAutonomyNow === undefined ? {} : { taskAutonomyNow: deps.taskAutonomyNow }),
    ...(deps.workflowE2EScenarioResults === undefined ? {} : { workflowE2EScenarioResults: deps.workflowE2EScenarioResults }),
    ...(deps.workflowE2EArtifact === undefined ? {} : { workflowE2EArtifact: deps.workflowE2EArtifact }),
    ...(deps.evidence === undefined ? {} : { evidence: deps.evidence }),
    ...(deps.startWorkflowE2EBaseline === undefined ? {} : { startWorkflowE2EBaseline: deps.startWorkflowE2EBaseline }),
    ...(deps.validateWorkflowE2EApplicationPlan === undefined ? {} : { validateWorkflowE2EApplicationPlan: deps.validateWorkflowE2EApplicationPlan }),
    ...(deps.registeredRepositoryIdentity === undefined ? {} : { registeredRepositoryIdentity: deps.registeredRepositoryIdentity }),
    ...(deps.requireRepositoriesConnected === undefined ? {} : { requireRepositoriesConnected: deps.requireRepositoriesConnected }),
    ...(deps.codeHost === undefined ? {} : { codeHost: deps.codeHost }),
    signInTableName: deps.developer.signInTableName,
    ...(agents?.codeMerge !== undefined ? { mergeView: (task: DeveloperTaskRecord, items: MergeTrackingItem[]) => mergeViewOf(agents, task, items, caller.developerId) }
      : deps.codeMergeView === undefined ? {} : { mergeView: (task: DeveloperTaskRecord, items: MergeTrackingItem[]) => deps.codeMergeView!(task, items, caller.developerId) }),
    ...(agents === undefined ? {} : { agentRuns: agents, agentEngine: agents, withdrawSpendRequests: (task: DeveloperTaskRecord) => withdrawTaskSpendRequests(agents, task), pausedTaskGate: (who, task: DeveloperTaskRecord) => pausedTaskGate(agents, who, task) }),
    // v1.2 learning loop: the ledger a send-back's `rule.suggested` goes to (learning/capture-decision.ts).
    ...(ledger === undefined ? {} : { learningAudit: ledger }),
    ...(deps.developer.taskPeopleConfiguration === undefined ? {} : { taskPeopleConfiguration: deps.developer.taskPeopleConfiguration }),
    ...(deps.developer.workflowDependenciesEnabled === undefined ? {} : { workflowDependenciesEnabled: deps.developer.workflowDependenciesEnabled }),
    checkTaskPerson: async (task, developerId, admission) => {
      return checkTaskPersonIdentity(identityDependencies(admission), task, developerId);
    },
    resolveTaskPickerPerson: async (taskId, slackUserId) => {
      const dependencies = identityDependencies();
      const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk: `DEVTASK#${taskId}`, sk: "META" }, ConsistentRead: true })) as { Item?: DeveloperTaskRecord };
      if (response.Item === undefined) throw agentXError("PROJECT_ACCESS_DENIED", "task person identity could not be verified");
      const task = response.Item;
      const resolved = await resolveTaskPickerPersonWithId(dependencies, task, slackUserId);
      const proof = await checkTaskPersonIdentity(dependencies, task, resolved.identity.developerId);
      if (!proof.eligible || proof.identity.developerId !== resolved.identity.developerId || proof.identity.slackUserId !== resolved.identity.slackUserId) {
        throw agentXError("PROJECT_ACCESS_DENIED", "task person identity could not be verified");
      }
      return { personId: resolved.personId, developerId: resolved.identity.developerId, slackUserId: resolved.identity.slackUserId, channelMember: proof.channelMember };
    },
    taskPeopleChannel: async (taskId) => {
      const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk: `DEVTASK#${taskId}`, sk: "META" }, ConsistentRead: true })) as { Item?: DeveloperTaskRecord };
      const share = response.Item?.share;
      if (share === undefined || typeof share.teamId !== "string" || typeof share.channelId !== "string" || typeof share.threadTs !== "string") {
        throw agentXError("PROJECT_ACCESS_DENIED", "task channel could not be verified");
      }
      return { teamId: share.teamId, channelId: share.channelId, threadTs: share.threadTs };
    },
    ...(deps.developer.inviteTaskPerson === undefined ? {} : { inviteTaskPerson: deps.developer.inviteTaskPerson }),
    ...(deps.developer.taskPeopleDisplayRead === undefined ? {} : {
      createTaskPeopleDisplayAdmission: () => taskPeopleDisplayAdmission({ now: deps.now, read: deps.developer.taskPeopleDisplayRead! }),
      listTaskPeople: async (task: DeveloperTaskRecord, admission: TaskPeopleDisplayAdmission) => {
      const channels = [...new Set([...(await projectChannelIds(task.project)), ...(task.share === undefined ? [] : [task.share.channelId])])].sort();
      admission.assertOpen();
      const answer = await admission.directory({ kind: "task-channel-people", channelIds: channels });
      if (!answer.ok) throw agentXError("SLACK_UNAVAILABLE", "the complete task People directory is unavailable");
      admission.assertOpen();
      const identities = await registerTaskChannelPeople(identityDependencies(admission), task, answer.users, () => admission.assertOpen());
      admission.assertOpen();
      const bySlack = new Map(answer.users.map((user) => [user.id, user]));
      return identities.map((identity) => {
        const user = bySlack.get(identity.slackUserId);
        if (user === undefined) throw agentXError("SLACK_UNAVAILABLE", "the complete task People directory is unavailable");
        return { subject: { developerId: identity.developerId, slackUserId: identity.slackUserId }, identity, eligible: true,
          channelMember: task.share === undefined || user.memberOf.includes(task.share.channelId) };
      });
      },
    }),
    ...(deps.refreshTaskFeedback === undefined ? {} : { refreshTaskFeedback: deps.refreshTaskFeedback.bind(deps) }),
    ...(initialSlackThread === undefined ? {} : { initialSlackThread }),
    checkAccess: (project, options) => checkProjectAccess(deps, caller, project, undefined, options),
    channelMember: async (slackUserId, channelId) => {
      const answer = await safeChannelMembers(deps)({ kind: "channel-members", slackUserId, channelIds: [channelId] });
      if (!answer.ok) throw agentXError("SLACK_UNAVAILABLE", "Slack could not be reached to check your membership of that channel; try again shortly");
      return answer.memberOf.includes(channelId);
    },
    projectChannelIds,
    ...(deps.developer.slackRequestQueue === undefined ? {} : { slackRequestQueue: deps.developer.slackRequestQueue }),
    ...(deps.developer.channelInfo === undefined ? {} : {
      boundChannels: async (channelIds: readonly string[]) => {
        const known = await channelNames(deps, channelIds);
        return channelIds.map((channelId) => {
          const channel = known.get(channelId);
          return channel === undefined ? { channelId } : { channelId, name: channel.name, isPrivate: channel.isPrivate };
        });
      },
    }),
    now: deps.now,
  };
}
