// Part of the broker (split out of ../broker.ts): builds the dependency objects handed to the agent, chain, admin, plan and developer-task routes.

import { liveSteerFromEnvironment } from "../../agent-sessions/live-steer.js";
import { readServiceStatusEvidence } from "../service-status-runtime.js";
import { createWorkingBranchPageProvider, createWorkingBranchProvider } from "../../org/project-working-branch-provider.js";
import { createHmac, randomUUID } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { AgentXError, CHANNEL_TURN_REQUEST_MAX, type DeveloperTaskView, type CodeIntentResult, CONNECTOR_SECRET_PREFIX, ChannelTurnSchema, approvedToolCount, toolBudget, agentXError, type OperationStatus, type ChannelTurn, type ProjectDefinition, type TriggerEvent, redactAndCap, projectRevisionKey, type OrgId, type ChannelMembersRequest, type Payer } from "@agentx/contracts";
import { adminReader, queryAllItems, type AdminReadDependencies } from "../admin-reads.js";
import { outcomeMetric } from "../admin-change-audit.js";
import type { AdminChangeDependencies } from "../admin-changes.js";
import type { AdminChangeHandlers, PlanDependencies } from "../admin-change-plans.js";
import { ZodError } from "zod";
import { authorizeWorkspace } from "../../authorization.js";
import { CatalogCache } from "@agentx/gateway";
import type { ScopeDiscovery } from "../connector-routes.js";
import { resolveConnectors } from "../connector-types.js";
import { CredentialRegistry } from "../credentials.js";
import { readChosenName } from "../../developer/chosen-name.js";
import { DeveloperSignInStore } from "../../developer/store.js";
import { safeDisplayName } from "../../developer/person-name.js";
import { disconnectGithubInstallation, listGithubInstallations, listInstallationRepositories, requireRepositoriesConnected, startGithubConnect, type GithubConnectionDependencies, type RepositoryGateDependencies } from "../../org/github-connection.js";
import { cancelInstallRequest, listInstallRequests } from "../../org/github-install-requests.js";
import { sendGithubConnectedNotice, sendGithubRequestReminder } from "../../developer/identity-notice.js";
import { unlockTrial } from "../../org/trial.js";
import { rovaraCodeV2LiveFromEnvironment } from "../../rovara-code/v2-switch.js";
import { requireOrgId, resolveSlackOrgForInstall } from "../../org/resolve.js";
import { OrgStore, type MemberRemovalHook } from "../../org/store.js";
import { requireProject } from "../project-records.js";
import { TERMINAL, getItem, publicOperation, requireOperation, type OperationRecord } from "../cancellation.js";
import { developerIdForSlackUser } from "../admin-actions.js";
import { HookStore } from "../../triggers/hooks.js";
import { hookProviders } from "../../triggers/providers/index.js";
import { admitWork } from "../../spend/admission.js";
import { AgentStore } from "../../agents/store.js";
import { followMerges } from "../../agents/access.js";
import { runLimitRequester } from "../../spend/requests.js";
import type { AgentRouteDependencies } from "../../agents/routes.js";
import { ChainStore } from "../../chains/store.js";
import { TriggerStore } from "../../triggers/store.js";
import { dispatchTriggerEvent, type TriggerDispatchContext } from "../../triggers/dispatch.js";
import { ingestIntake, type IntakePorts } from "../../intake/engine.js";
import { writeIntakeNotice } from "../../intake/notices.js";
import { noteOwnWrite, registerOwnWriteRecorder } from "../../intake/own-writes.js";
import { intakePortsOf } from "../../intake/wiring.js";
import { listProjectMembers } from "../../org/project-members.js";
import type { IntakePollDependencies } from "../../triggers/poll-intake.js";
import { chainTriggerHooksFor, triggerHooksFor } from "../../triggers/lifecycle.js";
import { registerChainRunner } from "../../chains/index.js";
import { chainRunPortsFor, chainRunSpendReader, type ChainRunnerDependencies } from "../../chains/runner.js";
import type { ChainRouteDependencies } from "../../chains/routes.js";
import { chainOwnerMoverFor, chainReadAccessFor } from "../../chains/session-seam.js";
import { realtimeConfigFromEnvironment } from "../../realtime/sink.js";
import { startAgentRun, type AgentRunStarter } from "../../agents/runs.js";
import { servableModels } from "../../model-sources/routing.js";
import { mintConfirmUrl, requireDecideSession } from "../../developer/decide-session.js";
import { agentRunStarterOf, codeIntentDependenciesOf, projectMembersOf, type DeveloperCaller, type DeveloperRouteDependencies } from "../developer-routes.js";
import { projectMembersDepsOf } from "../developer-routes/project-list.js";
import type { DeveloperTaskActions } from "../developer-task-actions.js";
import { preflightConnectors, registrationWarnings } from "../registration-preflight.js";
import { TurnRecordExport, dynamoTurnRecordSource, workspaceProjectReader } from "../turns.js";
import { slackWorkflowCaller } from "../slack-workflow-caller.js";
import { startCodeIntent, type CodeIntentDependencies } from "../../rovara-code/intent.js";
import { acceptPullRequest, acceptPullRequestLifecycle, acceptTask, cancelRunningTask, cancelWorkspaceTask } from "./acceptance.js";
import { connectedAwsAccountsOf, hookMemoryOf, optional } from "./admin-and-helpers.js";
import type { AwsBrokerDependencies, AwsBrokerInput, RegisteredProjectRecord } from "./definitions.js";
import { agentRunHostOf, writeGateRuntime } from "./model-access.js";
import { ensureProjectCatalogPointer, parseRegistrationInput, registerProject, registerProjectFor, registrationChecks } from "./project-registration.js";
import { rewriteOpenLinearCloseLines } from "./pull-request-reconcile.js";
import { requireAdministrator, requireLatestProject, requireWorkspace } from "./records.js";
import { brokerEnvironmentName, decideRequestContext, egressDepsOf, githubScope, installOrgId, modelSourceStoreOf, orgConnectionStoreOf, orgOfRecord, orgResolverOf, routingOf } from "./scope-helpers.js";
import { codeMergeHostOf, operationEventsNewestFirst } from "./terminal-and-github-events.js";
import { deleteWorkspaceCompute, requesterOf, startTaskClose } from "./thread-workspaces.js";
import { deleteSlackBinding, heldPreparationDispatch, newWorkspacePreparation, spendRequestHostOf } from "./workspace-preparation.js";
import { connectorTypeContext } from "./workspace-routes.js";

export function agentRouteDependencies(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions): AgentRouteDependencies | undefined {
  const { agents, developer } = dependencies;
  if (agents === undefined || developer === undefined) return undefined;
  // PF6: the real project members (Plan 2 Task 21), built the way the project members routes build theirs, so both read one set of people.
  const projectMembers = agents.projectMembers ?? projectMembersOf({
    documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer, now: Date.now, tasks, orgs: orgStoreOf(dependencies),
  });
  const signInStore = new DeveloperSignInStore({ documentClient: dependencies.documentClient, tableName: developer.signInTableName, nameTableName: dependencies.tableName, now: Date.now });
  const connections = orgConnectionStoreOf(dependencies);
  const routing = routingOf(dependencies);
  const agentStore = new AgentStore({
      documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now,
      // A merged duplicate's agents count in the survivor's total of agent budgets (Task 28).
      resolveOwner: (_orgId, developerId) => followMerges(signInStore, developerId),
      ...(agents.newId === undefined ? {} : { newId: agents.newId }),
      ...(agents.builtins === undefined ? {} : { builtins: agents.builtins }),
      // Publishes, rollbacks, owner and budget changes and the guardrails record their events in their own transactions (Audit Task 19).
      ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }),
    });
  const routeDependencies: AgentRouteDependencies = {
    store: agentStore,
    // Plan 4 Task 4: chains are versioned, owned and shared beside agents, on the same store so the owner's monthly total holds both kinds of budget.
    chains: new ChainStore({
      documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now, agents: agentStore,
      ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }),
    }),
    // Plan 4 Task 18: the triggers of agents and chains, on the same table. The hooks that receive events (Task 19) and the scheduler (Task 26) are theirs to supply.
    triggers: agents.triggers ?? new TriggerStore({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now }),
    // Plan 4 Task 19: the hooks vendors post events to, and the routes that make them. A trigger's hook check reads the same store.
    ...(agents.eventHooks === undefined ? {} : (() => {
      const store = new HookStore({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now });
      const memory = hookMemoryOf(dependencies);
      return {
        eventHooks: { store, secrets: agents.eventHooks.secrets, providers: agents.eventHooks.providers ?? hookProviders(), origin: new URL(developer.issuer).origin, secretRotated: (hookId: string) => memory.remember(hookId, undefined), ...optional("awsAccounts", connectedAwsAccountsOf(dependencies)) },
        hooks: agents.hooks ?? store,
      };
    })()),
    ...(agents.hooks === undefined || agents.eventHooks !== undefined ? {} : { hooks: agents.hooks }),
    ...(agents.triggerSchedules === undefined ? {} : { triggerSchedules: agents.triggerSchedules }),
    ...(agents.chainTriggers === undefined ? {} : { chainTriggers: agents.chainTriggers }),
    // Plan 4 Task 6: what the spend requests ask of a chain run (the chain, and what the run had left when a step started), answered from the run's own records.
    chainRunBudgets: agents.chainRunBudgets ?? chainRunSpendReader({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now }),
    ...(agents.chainRuns === undefined ? {} : { chainRuns: agents.chainRuns }),
    projectMembers,
    documentClient: dependencies.documentClient,
    tableName: dependencies.tableName,
    signInStore,
    projectAiSignInTableName: developer.signInTableName,
    now: () => Date.now(),
    // The project AI settings and the spend policy are written by the routes themselves (Audit Task 19).
    ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }),
    // The confirmation page is served by the cell, at the origin its access tokens are issued from.
    confirmOrigin: new URL(developer.issuer).origin,
    ...(agents.resolveSkill === undefined ? {} : { resolveSkill: agents.resolveSkill }),
    // Rovara Code v2 is on per environment: the explicit dependency (tests) wins, else the packed setting (RovaraCodeV2Enabled, off by default). Only "true" turns it on.
    ...((agents.rovaraCodeV2Live ?? (rovaraCodeV2LiveFromEnvironment(process.env) ? true : undefined)) === undefined ? {} : { rovaraCodeV2Live: agents.rovaraCodeV2Live ?? true }),
    // Where the install runs the model proxy, the models a recipe may name and the order a project may reorder are the org's own sources' (Task 26).
    ...(routing === undefined ? {} : { modelRouting: routing }),
    ...(dependencies.chatgpt === undefined ? {} : { stageChatgpt: dependencies.chatgpt }),
    modelSignInTableName: developer.signInTableName,
    ...(agents.servableModels === undefined ? (routing === undefined ? {} : { servableModels: (orgId: OrgId) => servableModels(routing, orgId) }) : { servableModels: agents.servableModels }),
    ...(agents.orgSourceOrder === undefined ? (routing === undefined ? {} : { orgSourceOrder: async (orgId: OrgId) => (await modelSourceStoreOf(dependencies).read(orgId)).order }) : { orgSourceOrder: agents.orgSourceOrder }),
    // Company AI sources need the model proxy that registers their models; without it their routes say so (Task 24b).
    ...(dependencies.modelAccess === undefined ? {} : {
      modelSources: { store: modelSourceStoreOf(dependencies), access: dependencies.modelAccess.access, egress: egressDepsOf(dependencies), ...agents.modelSources },
    }),
    // A run that names a pull request of a project repository reads its head through the GitHub App, with an agent token (pull requests and contents,
    // read only) for the run's org (Task 15, PF16; Task 14b). Where the provider has no such read, nothing is read and the run fails closed.
    pullRequestHead: agents.pullRequestHead ?? (async ({ orgId, repositoryUrl, number, installationId }) => {
      const read = dependencies.githubPullRequests.getAgentPullRequestHead;
      if (read === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "reading pull requests is not set up in this deployment");
      return { headSha: (await read.call(dependencies.githubPullRequests, repositoryUrl, number, { orgId }, ...(installationId === undefined ? [] : [{ installationId }]))).headSha };
    }),
    // Task 34's seam to Task 32: the `run_limit` request a plan's approval makes when the approver's tier is too low. A test may inject its own; the broker's is wired below.
    ...(agents.requestRunLimit === undefined ? {} : { requestRunLimit: agents.requestRunLimit }),
    // Task 14b: the scan of a repository's workflows for the comment rule and the opt-out reads the default branch with the same kind of token.
    ...(dependencies.githubPullRequests.agentRepositoryReader === undefined ? {} : {
      repositoryReader: ({ orgId, repositoryUrl, installationId }: { orgId: OrgId; repositoryUrl: string; installationId?: number }) =>
        dependencies.githubPullRequests.agentRepositoryReader!(repositoryUrl, { orgId }, ...(installationId === undefined ? [] : [{ installationId }])),
    }),
    projectRepositories: async (orgId: OrgId, project: string) => {
      try {
        return (await requireLatestProject(dependencies, orgId, project)).definition.repositories.map((repository) => ({ name: repository.name, url: repository.url, ...(repository.installationId === undefined ? {} : { installationId: repository.installationId }) }));
      } catch (error) {
        if (error instanceof AgentXError && error.code === "NOT_FOUND") return undefined;
        throw error;
      }
    },
    // A trial org keeps the placeholder limits (R49) on the budgets the routes set.
    orgs: orgStoreOf(dependencies),
    // The spend routes show the placeholder limits a cloud org starts with (R47).
    ...(dependencies.cloud === true ? { cloud: true } : {}),
    // Task 12b: the org's connections, on the broker's own table and audit outbox. An MCP endpoint is checked at save and before every call.
    ...(connections === undefined ? {} : { connections }),
    ...(dependencies.brokerRoleArn === undefined ? {} : { brokerRoleArn: dependencies.brokerRoleArn }),
    // Task 21: what a write approval needs, so the routes and the settlement job's sweep both find it (Task 19's pieces).
    writeGate: writeGateRuntime(dependencies, tasks, signInStore),
    // Task 13: a project's connectors: the org's connections, the registration of each new revision (with the vendor preflight) and the live status of each connector.
    projectConnectors: {
      cloud: dependencies.cloud === true,
      ...(connections === undefined ? {} : { connections }),
      registerRevision: async (actor, input, extraItems) => {
        const { credentialsChecked, ...revision } = input;
        const registered = await registerProjectFor(dependencies, actor, { ...revision, preflight: true }, { creatorMembership: "none", extraItems, credentialsChecked });
        return { duplicate: registered.duplicate, ...(registered.preflight === undefined ? {} : { preflight: registered.preflight }) };
      },
      preflight: async (actor, definition) => {
        const project = definition as unknown as ProjectDefinition;
        const context = connectorTypeContext(dependencies, actor.orgId, async () => githubScope(dependencies, actor.orgId));
        return (await preflightConnectors(resolveConnectors(project, context, dependencies.connectorTypes), project, actor.ownerKey)).report.connectors;
      },
    },
  };
  // Plan 3, Task 22: what the agent-step engine needs of the broker, on the same dependencies (it reads the approvals through them).
  routeDependencies.agentRuns = agentRunHostOf(dependencies, tasks, routeDependencies);
  // Plan 4 Task 18: what the agent and chain routes, the confirmations and the member movers ask of the trigger code, over these same dependencies.
  routeDependencies.triggerHooks ??= triggerHooksFor(routeDependencies);
  routeDependencies.chainTriggers ??= chainTriggerHooksFor(routeDependencies);
  // Plan 5, Task 5: what session levels, shares and reads need, on the same table and project members. Plan 4's readers of a chain are injected through
  // `agents.sessions`; without them nobody reads a chain session through the project or the chain (only its owner, its shares and maintainers do): fail closed.
  routeDependencies.agentSessions = {
    documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: () => Date.now(), projectMembers, signInStore,
    // Seals the list cursor (review m-1): derived from the signing key under its own label, so no other use of the key can open or forge one.
    cursorKey: createHmac("sha256", dependencies.callbackSigningKey).update("agentx:session-list-cursor:v1").digest("hex"),
    // Plan 4's readers of a chain run (the starter, the run's owner, `view` on the chain and the project, org owners and admins); a deployment may bring its own. The chain reads of a
    // session body, a message, a stop and a retry are not here: they are made for each request, with the org of the person asking (developer-routes `sessionReadDependencies`).
    chainReadAccess: agents.sessions?.chainReadAccess ?? chainReadAccessFor(routeDependencies as ChainRouteDependencies),
    ...(agents.sessions?.chain === undefined ? {} : { chain: agents.sessions.chain }),
    // Plan 5 Task 12b: a take-over asks Plan 3's admission for the person who would pay from now on, tells the previous owner and the followers through the events API,
    // and moves a chain run's owner through Plan 4's mover when it is supplied.
    ...(dependencies.modelAccess === undefined ? {} : {
      admitPayer: async (input: { orgId: OrgId; project: string; payer: Payer; agentId: string; agentName: string; path: "TASK" | "AGENT" }) => {
        await admitWork(
          { documentClient: dependencies.documentClient, tableName: dependencies.tableName, access: dependencies.modelAccess!.access, now: () => Date.now(), cloud: dependencies.cloud === true },
          { orgId: input.orgId, payer: input.payer, project: input.project, agentId: input.agentId, agentName: input.agentName, path: input.path },
        );
      },
    }),
    ...(realtimeConfigFromEnvironment() === undefined ? {} : { realtimePublish: realtimeConfigFromEnvironment()! }),
    // Plan 4's move of a chain run's owner and payer to the person who took its session over.
    chainOwner: agents.sessions?.chainOwner ?? chainOwnerMoverFor(routeDependencies as ChainRouteDependencies),
    // Live steer: a message to a running step also reaches its session (agent-sessions/live-steer.ts).
    liveSteer: liveSteerFromEnvironment(dependencies.callbackSigningKey),
  };
  // Plan 6, Task 19: what pressing Merge and its confirmation need (GitHub's reads and the merge, the task and its repositories), on the same dependencies.
  const codeMerge = codeMergeHostOf(dependencies);
  if (codeMerge !== undefined) routeDependencies.codeMerge = codeMerge;
  // Plan 3, Task 32: what an approved spend request does with its task (the owner's resume, continue-as-task) and what a task's keys have spent.
  routeDependencies.spendRequests = spendRequestHostOf(dependencies, tasks, routeDependencies);
  // Plan 3, merge of Tasks 32 and 34: a plan approved at a run limit above the approver's tier makes a `run_limit` spend request, and that request's approval starts coding
  // (`resumeAfterRunLimitApproval`, through the host above). Without this a member's Full task would block with no request and no way to run.
  routeDependencies.requestRunLimit ??= runLimitRequester(routeDependencies);
  // Owner decision 2026-10-22: an owner's approval of an older, less safe version starts the run that asked for it, once, as the person who asked, through the same
  // start as any run (its request id makes a repeat answer the first start), with only the version check waived.
  routeDependencies.startApprovedRun = async (approved) => {
    const starter = agentRunStarterOf({
      documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer, now: Date.now, tasks, orgs: orgStoreOf(dependencies),
      ...(dependencies.modelAccess === undefined ? {} : { modelAccess: dependencies.modelAccess.access }),
      ...(dependencies.cloud === true ? { cloud: true } : {}),
      agents: routeDependencies,
      ...repositoriesGateRoute(dependencies),
    });
    if (starter === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "starting runs is not set up in this deployment");
    await startAgentRun(starter, {
      requestId: approved.requestId, orgId: approved.orgId, project: approved.project, agent: approved.agent, input: approved.input, origin: approved.origin,
      owner: { developerId: approved.developerId }, startedBy: { developerId: approved.developerId }, versionApproved: true,
    });
  };
  // Plan 3, Task 21a-wiring: decisions need a person present. The decide routes call this guard first (a token is sent to the page with a ticketed
  // confirmUrl), and `GET /v1/app/approvals/{id}` mints the same ticket for the person who may decide it. Both use the page's own context.
  if (dependencies.decide !== undefined) {
    const context = () => decideRequestContext(dependencies, routeDependencies);
    // The guard reads the approval from the request's own path, which is how the route found it.
    routeDependencies.requireDecide = async (request) => {
      const decide = context();
      if (decide === undefined) throw agentXError("NOT_FOUND", "that isn't available yet");
      return requireDecideSession(decide, { method: request.method, path: request.path, headers: request.headers, ...(request.body === undefined ? {} : { body: request.body }) });
    };
    routeDependencies.mintConfirmUrl = async (caller, approvalId) => {
      const decide = context();
      if (decide === undefined) throw agentXError("NOT_FOUND", "that isn't available yet");
      return mintConfirmUrl(decide, { developerId: caller.developerId, orgId: caller.orgId }, approvalId);
    };
  }
  return routeDependencies;
}

/**
 * Plan 2, Task 13: what connecting GitHub to an org needs. Undefined without developer sign-in, and where the GitHub App provider cannot
 * say its slug, OAuth client and installations (a test double without them). `cloud` is the install's own setting: whether an OAuth client
 * exists decides nothing about which flow an install uses.
 */
export function githubConnectionOf(dependencies: AwsBrokerDependencies): GithubConnectionDependencies | undefined {
  const app = dependencies.githubPullRequests;
  if (dependencies.developer === undefined || app.appSlug === undefined || app.oauthClient === undefined || app.installation === undefined) return undefined;
  const signIn = new DeveloperSignInStore({ documentClient: dependencies.documentClient, tableName: dependencies.developer.signInTableName, nameTableName: dependencies.tableName, now: Date.now });
  return {
    documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now, cloud: dependencies.cloud === true,
    origin: new URL(dependencies.developer.issuer).origin,
    app: {
      appSlug: () => app.appSlug!(), oauthClient: () => app.oauthClient!(), installation: (id) => app.installation!(id),
      ...(app.organizationMembership === undefined ? {} : { orgMembership: (installationId, org, login) => app.organizationMembership!(installationId, org, login, { system: "webhook" }) }),
      ...(app.listInstallationRepositories === undefined ? {} : { listInstallationRepositories: (installationId, scope) => app.listInstallationRepositories!(installationId, scope) }),
    },
    identities: signIn, orgs: orgStoreOf(dependencies),
    ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }),
    ...(dependencies.githubConnectedNotice === undefined ? {} : {
      notifyGithubConnected: async (notice) => { await sendGithubConnectedNotice(dependencies.githubConnectedNotice!, notice); },
      remindGithubRequester: async (reminder) => { await sendGithubRequestReminder(dependencies.githubConnectedNotice!, reminder); },
    }),
    unlockTrial: (input) => unlockTrial({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now }, input),
    ...(dependencies.githubFetch === undefined ? {} : { fetch: dependencies.githubFetch }),
  };
}

/** `POST /v1/app/github/connect`'s dependency for the developer routes; absent where there is no connection to offer. */
export function githubConnectRoute(dependencies: AwsBrokerDependencies): { githubConnect?: NonNullable<DeveloperRouteDependencies["githubConnect"]> } {
  const connection = githubConnectionOf(dependencies);
  return connection === undefined ? {} : {
    githubConnect: {
      start: (caller) => startGithubConnect(connection, caller),
      listRequests: (caller) => listInstallRequests(connection, caller.orgId),
      cancelRequest: (caller, githubUserId) => cancelInstallRequest(connection, caller, githubUserId),
      listInstallations: (caller) => listGithubInstallations(connection, caller.orgId),
      disconnect: (caller, installationId) => disconnectGithubInstallation(connection, caller, installationId),
      listRepositories: async (caller, installationId) => {
        // Private repositories' names are an owner's or admin's to see, as creating a project from one is.
        if (caller.orgRole !== "owner" && caller.orgRole !== "admin") throw agentXError("FORBIDDEN", "only an owner or admin can list the repositories GitHub gives Rovara");
        return listInstallationRepositories(connection, caller.orgId, installationId);
      },
    },
  };
}

/**
 * Plan 2, Task 15: what the repository checks need on a cloud install: the binding table and the App's own lookups. Undefined elsewhere (a
 * private install has no bindings, so nothing is checked) and where the provider cannot say which installation covers a repository (a test
 * double), as `githubConnectionOf` is for the connect flow.
 */
export function repositoryGateOf(dependencies: AwsBrokerDependencies): RepositoryGateDependencies | undefined {
  const app = dependencies.githubPullRequests;
  if (dependencies.cloud !== true || app.installationForRepository === undefined) return undefined;
  return {
    documentClient: dependencies.documentClient, tableName: dependencies.tableName, cloud: true,
    app: {
      installationForRepository: (owner, name, options) => app.installationForRepository!(owner, name, options),
      ...(app.getRepositoryIdentity === undefined ? {} : { repositoryIdentity: (url, scope) => app.getRepositoryIdentity!(url, scope) }),
    },
  };
}

/** Lane B: no legacy provider/private-install fallback for branch listing. */
export function workingBranchPagesRoute(dependencies: AwsBrokerDependencies): Pick<DeveloperRouteDependencies, "projectWorkingBranches"> {
  const app = dependencies.githubPullRequests;
  if (app.createWorkingBranchPreviewSession === undefined) return {};
  return { projectWorkingBranches: () => {
    const session = app.createWorkingBranchPreviewSession!();
    return { ...createWorkingBranchPageProvider(session), finish: () => session.finish("list") };
  } };
}

/** Lane B: exact previews require both pinned SDK methods; no legacy fallback. */
export function workingBranchPreviewRoute(dependencies: AwsBrokerDependencies): Pick<DeveloperRouteDependencies, "projectWorkingBranchPreview"> {
  const app = dependencies.githubPullRequests;
  if (app.createWorkingBranchPreviewSession === undefined) return {};
  return { projectWorkingBranchPreview: () => {
    const session = app.createWorkingBranchPreviewSession!();
    return { ...createWorkingBranchProvider(session), finish: () => session.finish("preview") };
  } };
}

/** `requireRepositoriesConnected` for the task routes, absent where there is no gate. */
export function repositoriesGateRoute(dependencies: AwsBrokerDependencies): { requireRepositoriesConnected?: NonNullable<DeveloperRouteDependencies["requireRepositoriesConnected"]> } {
  const gate = repositoryGateOf(dependencies);
  return gate === undefined ? {} : { requireRepositoriesConnected: (orgId, definition) => requireRepositoriesConnected(gate, orgId, definition) };
}

/** A person's name from their sign-in record, for the answer to an erasure (read before their details are erased). */
export async function developerDisplayName(dependencies: Pick<AwsBrokerDependencies, "documentClient" | "developer" | "tableName">, developerId: string): Promise<string | undefined> {
  const table = dependencies.developer?.signInTableName;
  if (table === undefined) return undefined;
  const [out, chosen] = await Promise.all([
    dependencies.documentClient.send(new GetCommand({ TableName: table, Key: { pk: `DEVELOPER#${developerId}`, sk: "META" } })) as Promise<{ Item?: { displayName?: unknown } }>,
    // Release 0.4.18: the name the person chose (State table) shows instead of the sign-in record's.
    readChosenName(dependencies.documentClient, dependencies.tableName, developerId),
  ]);
  return chosen ?? (typeof out.Item?.displayName === "string" ? safeDisplayName(out.Item.displayName, developerId) : undefined);
}

export function orgStoreOf(dependencies: Pick<AwsBrokerDependencies, "documentClient" | "tableName" | "audit">, memberRemoval?: MemberRemovalHook): OrgStore {
  return new OrgStore({
    documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now,
    ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }),
    // Plan 3, Task 11: a removed member's agents, skills and shares move on (the routes that remove people pass it).
    ...(memberRemoval === undefined ? {} : { memberRemoval }),
  });
}

/**
 * The org a Slack team is bound to; a team bound to none is refused with SLACK_TEAM_NOT_BOUND. A single-org
 * install (no injected org resolver) binds its own configured Slack team to its org the first time it is seen,
 * so that team needs no manual binding; an install with its own resolver binds teams through the admin path only.
 */
export async function slackTeamOrg(dependencies: AwsBrokerDependencies, teamId: string): Promise<OrgId> {
  return resolveSlackOrgForInstall(
    orgStoreOf(dependencies),
    teamId,
    dependencies.orgResolver !== undefined ? undefined : { orgId: installOrgId(dependencies), name: brokerEnvironmentName(dependencies), slackTeamId: dependencies.developer?.slackTeamId },
  );
}

/**
 * The workflow caller for a Slack user (ruling R1): the user's own org, which must be the org the Slack team is
 * bound to. A person of another org, or of none, cannot act through this team's channels.
 */
export async function slackCallerFor(dependencies: AwsBrokerDependencies, userId: string, teamId: string): Promise<DeveloperCaller> {
  const developerId = developerIdForSlackUser(userId);
  const teamOrg = await slackTeamOrg(dependencies, teamId);
  const orgId = requireOrgId(await orgResolverOf(dependencies)({ developerId }));
  if (orgId !== teamOrg) throw agentXError("FORBIDDEN", "this Slack member does not belong to the organization this Slack workspace is connected to");
  return slackWorkflowCaller(userId, orgId);
}

/** requireLatestProject for a record (a workspace) that belongs to a project. */
export async function requireRecordLatestProject(
  dependencies: AwsBrokerDependencies,
  record: { orgId?: unknown; ownerKey?: unknown; developerId?: unknown },
  projectName: string,
): Promise<RegisteredProjectRecord> {
  return requireLatestProject(dependencies, await orgOfRecord(dependencies, record), projectName);
}

/** requireProject for a record that pins a project revision (a workspace, a task or a setup execution). */
export async function requireRecordProject(
  dependencies: AwsBrokerDependencies,
  record: { orgId?: unknown; ownerKey?: unknown; developerId?: unknown },
  projectName: string,
  revision: number,
): Promise<RegisteredProjectRecord> {
  return requireProject(dependencies, await orgOfRecord(dependencies, record), projectName, revision);
}

/** The handler's dependencies from what callers supply (see AwsBrokerInput). */
export function brokerDependencies(input: AwsBrokerInput): AwsBrokerDependencies {
  // One cache per container: discovery per revision, connector and repository costs one vendor round trip.
  const { connectorCredentials, turnRecordsTableName, ...rest } = input;
  const credentialRegistry = input.credentialRegistry ?? (connectorCredentials
    ? new CredentialRegistry({ ...connectorCredentials, documentClient: input.documentClient, tableName: input.tableName })
    : undefined);
  const turnRecords = input.turnRecords ?? (turnRecordsTableName
    ? new TurnRecordExport({
        source: dynamoTurnRecordSource(input.documentClient, turnRecordsTableName),
        projectOf: workspaceProjectReader(input.documentClient, input.tableName),
      })
    : undefined);
  return {
    ...rest,
    catalogs: input.catalogs ?? new CatalogCache<ScopeDiscovery>({ ttlMs: 600_000, maxEntries: 256 }),
    ...(credentialRegistry ? { credentialRegistry } : {}),
    ...(turnRecords ? { turnRecords } : {}),
    ...(turnRecordsTableName ? { turnRecordsTableName } : {}),
  };
}

/** The broker actions developer task routes call (spec 025); tests and the route wiring use this factory. */
export function createDeveloperTaskActions(input: AwsBrokerInput): DeveloperTaskActions {
  return developerTaskActions(brokerDependencies(input));
}

/**
 * Plan 3, Tasks 19 and 21: the agent routes' dependencies as the broker builds them for a request and for the settlement job (the write gate included), for the
 * registrations Plan 3's later tasks make (Task 22's approval handlers) and for tests that decide an approval. Undefined where developer sign-in or agents are not set up.
 */
export function createAgentRouteDependencies(input: AwsBrokerInput): AgentRouteDependencies | undefined {
  const dependencies = brokerDependencies(input);
  return agentRouteDependencies(dependencies, developerTaskActions(dependencies));
}

/**
 * Plan 3, Task 15: what `startAgentRun` (H2) needs to start a run as a person, from the broker's own dependencies; the entry for the event, schedule
 * and chain starts of Plan 4 and for tests. Undefined where developer sign-in or agents are not set up.
 */
export function createAgentRunStarter(input: AwsBrokerInput): AgentRunStarter | undefined {
  const dependencies = brokerDependencies(input);
  const tasks = developerTaskActions(dependencies);
  return agentRunStarterFrom(dependencies, tasks, agentRouteDependencies(dependencies, tasks));
}

/** The developer API's dependencies for starting work as a person, from the broker's own: what the run starter and the code intent start are made from. */
function startRouteDependencies(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, agents: AgentRouteDependencies | undefined): DeveloperRouteDependencies | undefined {
  const developer = dependencies.developer;
  if (developer === undefined) return undefined;
  return {
    documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer, now: Date.now, tasks, orgs: orgStoreOf(dependencies),
    ...(dependencies.modelAccess === undefined ? {} : { modelAccess: dependencies.modelAccess.access }),
    ...(dependencies.cloud === true ? { cloud: true } : {}),
    ...(agents === undefined ? {} : { agents }),
    ...repositoriesGateRoute(dependencies),
  };
}

function agentRunStarterFrom(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, agents: AgentRouteDependencies | undefined): AgentRunStarter | undefined {
  const routeDependencies = startRouteDependencies(dependencies, tasks, agents);
  return routeDependencies === undefined ? undefined : agentRunStarterOf(routeDependencies);
}

/**
 * Plan 6 Task 3: what `startCodeIntent` needs for a caller that is already authenticated (the app route's session, the Slack workflow's own caller). Undefined where developer sign-in is
 * not set up. Plan 9 does not use this: it calls `createCodeIntentStarter`, which names the person and reads them again.
 */
export function createCodeIntentDependencies(input: AwsBrokerInput, caller: DeveloperCaller): CodeIntentDependencies | undefined {
  const dependencies = brokerDependencies(input);
  const tasks = developerTaskActions(dependencies);
  const routeDependencies = startRouteDependencies(dependencies, tasks, agentRouteDependencies(dependencies, tasks));
  return routeDependencies === undefined ? undefined : codeIntentDependenciesOf(routeDependencies, caller);
}

/**
 * Plan 6 Task 3: Rovara Code's one entry point for an intent, for Plan 9's Linear and offer starts. It takes the person as an org and a developer id and reads them again on every
 * call (sign-in, revocation, org membership and role), so a caller can't be built stale or with a role it doesn't hold. A person who is revoked, removed or in another org is
 * refused `FORBIDDEN`. `source: "slack"` is refused here: only the Slack workflow's own start builds the Slack caller. It needs agents to be set up.
 */
export function createCodeIntentStarter(input: AwsBrokerInput): ((orgId: OrgId, developerId: string, request: unknown) => Promise<CodeIntentResult<DeveloperTaskView>>) {
  const dependencies = brokerDependencies(input);
  const tasks = developerTaskActions(dependencies);
  const routeDependencies = startRouteDependencies(dependencies, tasks, agentRouteDependencies(dependencies, tasks));
  const starter = routeDependencies === undefined ? undefined : agentRunStarterOf(routeDependencies);
  return async (orgId, developerId, request) => {
    if (routeDependencies === undefined || starter === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "starting work is not set up in this deployment");
    const caller = await starter.callerFor(orgId, developerId);
    if (caller === undefined) throw agentXError("FORBIDDEN", "The person this run is for isn't a member of the organization.");
    return startCodeIntent(codeIntentDependenciesOf(routeDependencies, caller), caller, request);
  };
}

/** The latest broker's chain runner dependencies, which the one registration of the chain runner's end and pause handlers reads (Plan 4 Task 6). */
let chainRunnerDependencies: ChainRunnerDependencies | undefined;
let removeChainRunner: (() => void) | undefined;

/** Takes the chain runner's handlers off again (for the tests that install them; a deployed broker never does). */
export function uninstallChainRunner(): void {
  removeChainRunner?.();
  removeChainRunner = undefined;
  chainRunnerDependencies = undefined;
}

/**
 * Plan 4 Task 6, at broker start: a chain step is an ordinary task, so the runner hears that it ended or was paused through Plan 3's handlers. They are registered
 * once per process and read the dependencies of the latest broker built; they do nothing where there are no agents or chains, or where the broker is not asked
 * to (`agents.registerChainRunner`, which the deployed broker sets).
 */
export function installChainRunner(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, agents: AgentRouteDependencies | undefined): void {
  if (dependencies.agents?.registerChainRunner !== true) return;
  const built = chainRunnerDependenciesOf(dependencies, tasks, agents);
  if (built === undefined) return;
  chainRunnerDependencies = built;
  removeChainRunner ??= registerChainRunner(() => chainRunnerDependencies);
}

/**
 * What starts the work an event asks for: the broker's own `eventHooks.dispatch` when it was given one, else Task 20's `dispatchTriggerEvent` over the chain runner's dependencies (and the
 * GitHub App's slug, which the loop guard reads). Undefined where agents, chains or sign-in are not set up. Hooks' deliveries and GitHub's events start work through the same one.
 */
export function eventDispatchOf(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, agents: AgentRouteDependencies | undefined): ((orgId: OrgId, event: TriggerEvent, context?: TriggerDispatchContext) => Promise<unknown>) | undefined {
  const given = dependencies.agents?.eventHooks?.dispatch;
  if (given !== undefined) return given;
  const chainDependencies = chainRunnerDependenciesOf(dependencies, tasks, agents);
  const githubApp = dependencies.githubPullRequests;
  const intake = intakePortsFrom(dependencies, tasks, agents);
  return chainDependencies === undefined ? undefined : (orgId, event, context) => dispatchTriggerEvent({
    ...chainDependencies, ...(githubApp.appSlug === undefined ? {} : { githubAppSlug: () => githubApp.appSlug!() }),
    // Meta repo lane F: a label or an assignment on an issue asks Rovara Code for work through the intake engine.
    ...(intake === undefined ? {} : { intake: { ingest: (candidate, options) => ingestIntake(intake, candidate, options?.admit === undefined ? {} : { admit: options.admit }) } }),
  }, orgId, event, context);
}

/**
 * Meta repo lane F: the intake engine's ports from the broker's own dependencies (who a tracker account is, the role on the project, the start as that member). Undefined where developer
 * sign-in or agents are not set up (a start needs them).
 */
export function intakePortsFrom(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, agents: AgentRouteDependencies | undefined): IntakePorts | undefined {
  const routeDependencies = startRouteDependencies(dependencies, tasks, agents);
  const starter = routeDependencies === undefined ? undefined : agentRunStarterOf(routeDependencies);
  if (routeDependencies === undefined || starter === undefined) return undefined;
  return intakePortsOf({
    documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now, starter,
    intentDependenciesFor: (caller) => codeIntentDependenciesOf(routeDependencies, caller),
  });
}

/** Meta repo lane F (F2): what one tick of the intake poll works with: the engine's ports, and the notice to a project's maintainers. Undefined where intake is not set up. */
export function intakePollDependenciesFrom(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, agents: AgentRouteDependencies | undefined): IntakePollDependencies | undefined {
  const ports = intakePortsFrom(dependencies, tasks, agents);
  const routeDependencies = startRouteDependencies(dependencies, tasks, agents);
  if (ports === undefined || routeDependencies === undefined) return undefined;
  return {
    ports,
    notify: async (notice) => {
      const people = await listProjectMembers(projectMembersDepsOf(routeDependencies), notice.orgId, notice.project);
      await writeIntakeNotice(ports.table, people.filter((person) => person.role === "maintainer").map((person) => person.developerId), notice);
    },
  };
}

/** What the chain runner and its sweep work with: the agent routes' dependencies with the chain store and Plan 3's run starter. Undefined where agents, chains or developer sign-in are not set up. */
export function chainRunnerDependenciesOf(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, agents: AgentRouteDependencies | undefined): ChainRunnerDependencies | undefined {
  const starter = agentRunStarterFrom(dependencies, tasks, agents);
  if (agents?.chains === undefined || starter === undefined) return undefined;
  const admission = dependencies.modelAccess === undefined ? undefined
    : { documentClient: dependencies.documentClient, tableName: dependencies.tableName, access: dependencies.modelAccess.access, now: Date.now, cloud: dependencies.cloud === true };
  return { ...agents, chains: agents.chains, chainRuns: agents.chainRuns ?? chainRunPortsFor(starter, admission) };
}

/** Spec 025 phase 25d: what the admin read routes need, from the broker's own dependencies. */
export function adminReadDependencies(dependencies: AwsBrokerDependencies): AdminReadDependencies {
  const developer = dependencies.developer;
  return {
    documentClient: dependencies.documentClient,
    tableName: dependencies.tableName,
    ...(dependencies.turnRecordsTableName === undefined ? {} : { turnRecordsTableName: dependencies.turnRecordsTableName }),
    ...(dependencies.turnRecordsTableName === undefined ? {} : { turns: dynamoTurnRecordSource(dependencies.documentClient, dependencies.turnRecordsTableName) }),
    ...(developer?.slackTeamId === undefined ? {} : { slackTeamId: developer.slackTeamId }),
    ...(developer?.channelInfo === undefined ? {} : { channelInfo: developer.channelInfo }),
    ...(developer === undefined ? {} : { channelMembers: (request: ChannelMembersRequest) => developer.channelMembers(request) }),
    limitDefaults: { member: dependencies.slack?.memberWorkspaceLimit ?? 3, organization: dependencies.slack?.organizationWorkspaceLimit ?? 20 },
    now: Date.now,
    log: (entry) => console.log(JSON.stringify({ component: "broker", ...entry })),
    ...dependencies.adminReads,
  };
}

/** Spec 025 phase 25e: the existing admin handlers a confirmed change applies through (FR-040). */
function adminChangeHandlers(dependencies: AwsBrokerDependencies): AdminChangeHandlers {
  return {
    requireAdministrator: (identity, project) => requireAdministrator(dependencies, identity, project),
    bindChannel: async () => { throw agentXError("FORBIDDEN", "Use the browser Slack approval flow to link a channel."); },
    unbindChannel: async (identity, teamId, channelId) => deleteSlackBinding(dependencies, identity, teamId, channelId, "admin_change_plan"),
    checkRevision: async (identity, definitionValue, runtimeBindingValue, options) => {
      if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
      let definition: ProjectDefinition;
      try {
        ({ definition } = parseRegistrationInput({ definition: definitionValue, runtimeBinding: runtimeBindingValue }));
      } catch (error) {
        // registerProject answers a schema failure as the route does; a plan names the first problem.
        if (!(error instanceof ZodError)) throw error;
        const issue = error.issues[0];
        throw agentXError("CONFIG_INVALID", `the project definition is invalid: ${issue?.path.join(".") || "definition"}: ${issue?.message ?? "invalid"}; fix it and plan again`);
      }
      if (await getItem(dependencies, projectRevisionKey(requireOrgId(identity.orgId), definition.name, definition.revision)) !== undefined) {
        throw agentXError("CONFIG_INVALID", `revision ${definition.revision} of ${definition.name} is already registered; use a newer revision number`);
      }
      // C8: the vendor preflight runs here, at planning, and never again at apply: neither in the
      // apply's re-plan (preflight: false, final review M1) nor in its registration.
      const preflight = await registrationChecks(dependencies, { orgId: requireOrgId(identity.orgId), ownerKey: identity.ownerKey }, definition, options?.preflight !== false);
      return { definition, warnings: registrationWarnings(toolBudget(approvedToolCount(definition)).warning, preflight) };
    },
    registerRevision: async (identity, definition, runtimeBinding) => {
      // E6, FR-015: the applier must still administer the project; registerProject itself checks only the claim.
      await requireAdministrator(dependencies, identity, definition.name);
      return registerProject(dependencies, identity, { definition, runtimeBinding, preflight: false });
    },
    registerCredential: async (identity, registration) => {
      if (!dependencies.credentialRegistry) throw agentXError("RUNTIME_UNAVAILABLE", "connector credentials are not configured in this deployment; ask whoever deploys AgentX to set them up");
      return dependencies.credentialRegistry.register(identity, registration);
    },
    cancelWorkspaceTask: async (identity, workspaceId) => cancelWorkspaceTask(dependencies, identity, workspaceId),
  };
}

/** Spec 025 phase 25e: what change plans read and apply through; tests build it the same way. */
export function createPlanDependencies(input: AwsBrokerInput): PlanDependencies {
  return planDependencies(brokerDependencies(input));
}

function planDependencies(dependencies: AwsBrokerDependencies): PlanDependencies {
  const developer = dependencies.developer;
  const registry = dependencies.credentialRegistry;
  return {
    reads: adminReadDependencies(dependencies),
    actions: {
      documentClient: dependencies.documentClient, tableName: dependencies.tableName,
      ...(developer === undefined ? {} : { signInTableName: developer.signInTableName }),
      ...(developer?.slackTeamId === undefined ? {} : { slackTeamId: developer.slackTeamId }),
      limitDefaults: { member: dependencies.slack?.memberWorkspaceLimit ?? 3, organization: dependencies.slack?.organizationWorkspaceLimit ?? 20 },
      ...(developer?.endDeveloperSessions === undefined ? {} : { endDeveloperSessions: developer.endDeveloperSessions }),
      now: Date.now,
    },
    handlers: adminChangeHandlers(dependencies),
    ...(developer?.channelByName === undefined ? {} : { channelByName: developer.channelByName }),
    ...(registry === undefined ? {} : { credentials: registry, builtInCredentialRef: registry.builtInRef }),
    // C5: the prefix the registry itself enforces.
    connectorSecretPrefix: registry?.connectorSecretPrefix ?? CONNECTOR_SECRET_PREFIX,
  };
}

/** Spec 025 phase 25e: admin changes exist only with developer sign-in and a TurnRecords table (D14). */
export function adminChangeDependencies(dependencies: AwsBrokerDependencies, reads: AdminReadDependencies): AdminChangeDependencies | undefined {
  const developer = dependencies.developer;
  if (developer === undefined || dependencies.turnRecordsTableName === undefined) return undefined;
  const log = (entry: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...entry }));
  const reader = adminReader(reads);
  const now = dependencies.adminChanges?.now ?? Date.now;
  return {
    documentClient: dependencies.documentClient,
    tableName: dependencies.tableName,
    audit: {
      documentClient: dependencies.documentClient, tableName: dependencies.turnRecordsTableName, log,
      metric: dependencies.adminChanges?.metric ?? outcomeMetric(process.env.AGENTX_METRICS_NAMESPACE || "AgentX"),
    },
    plans: planDependencies(dependencies),
    ...(reader === undefined ? {} : { identity: reader }),
    ...(developer.slackTeamId === undefined ? {} : { slackTeamId: developer.slackTeamId }),
    // E16: the environment's pop-up switch. R5: Slack is a method wherever a Slack team is set up,
    // whatever Slack sign-in says; each change still needs the admin's own linked Slack user (FR-041).
    confirm: dependencies.adminChanges?.confirm ?? { elicitation: process.env.MCP_CONFIRM_ELICITATION !== "disabled", slack: developer.slackTeamId !== undefined },
    now,
    newId: randomUUID,
    log,
  };
}

export function developerTaskActions(dependencies: AwsBrokerDependencies): DeveloperTaskActions {
  /** Every page of a partition's items under a prefix (the admin reads' shared query loop). */
  const query = (pk: string, prefix: string) => queryAllItems(dependencies, pk, prefix);
  return {
    tableName: dependencies.tableName,
    ...(dependencies.turnRecordsTableName ? { turnRecordsTableName: dependencies.turnRecordsTableName } : {}),
    limitDefaults: {
      member: dependencies.slack?.memberWorkspaceLimit ?? 3,
      organization: dependencies.slack?.organizationWorkspaceLimit ?? 20,
    },
    latestProject: (orgId, name) => requireLatestProject(dependencies, orgId, name).catch((error: unknown) => {
      if (error instanceof AgentXError && error.code === "NOT_FOUND") return undefined;
      throw error;
    }),
    projectRevision: (orgId, name, revision) => requireProject(dependencies, orgId, name, revision).catch((error: unknown) => {
      if (error instanceof AgentXError && error.code === "NOT_FOUND") return undefined;
      throw error;
    }),
    ensureProjectCatalogPointer: (orgId, name) => ensureProjectCatalogPointer(dependencies, orgId, name),
    preparation: (identity, project, requestId, options) => newWorkspacePreparation(dependencies, identity, project, identity.ownerKey, requestId, options),
    preparationDispatch: (project, workspaceId, operationId, ownerKey, options) => heldPreparationDispatch(dependencies, project, workspaceId, operationId, ownerKey, options),
    workspace: (id) => requireWorkspace(dependencies, id),
    operations: async (workspaceId) => (await query(`WORKSPACE#${workspaceId}`, "OPERATION#"))
      .filter((item) => item.entityType === "OPERATION")
      .map((item) => publicOperation(item as unknown as OperationRecord)),
    workflowBinding: async (workspaceId, operationId) => (await requireOperation(dependencies, workspaceId, operationId)).workflowDependencies,
    workflowCandidateSourceExportDigest: async (workspaceId, operationId) => (await requireOperation(dependencies, workspaceId, operationId)).candidateSourceRef?.candidateDigest,
    eventsNewestFirst: (operationId, limit) => operationEventsNewestFirst(dependencies, operationId, limit),
    artifacts: async (workspaceId, operationId) => (await query(`WORKSPACE#${workspaceId}`, "ARTIFACT#"))
      .filter((item) => item.operationId === operationId)
      .map((item) => ({
        id: String(item.id), operationId: String(item.operationId), name: String(item.name), mediaType: String(item.mediaType), objectKey: String(item.objectKey),
        ...(typeof item.size === "number" ? { size: item.size } : {}),
      })),
    readArtifact: async (objectKey, maxBytes) => {
      const object = await dependencies.s3.send(new GetObjectCommand({ Bucket: dependencies.artifactBucketName, Key: objectKey, Range: `bytes=0-${maxBytes - 1}` }));
      return object.Body ? await object.Body.transformToString("utf8") : "";
    },
    rewriteLinearCloseLine: (task, key) => rewriteOpenLinearCloseLines(dependencies, task, key),
    pullRequests: async (workspaceId) => (await query(`WORKSPACE#${workspaceId}`, "PULL_REQUEST#"))
      .map((item) => ({ repository: String(item.repository), number: Number(item.number), url: String(item.url), state: item.state as "open" | "closed" | "merged" })),
    acceptTask: (identity, workspaceId, request, extra, options) => acceptTask(dependencies, identity, workspaceId, request, extra, options),
    acceptPullRequest: (identity, workspaceId, request, extra, options) => acceptPullRequest(dependencies, identity, workspaceId, request, extra, options),
    acceptPullRequestUpdate: (identity, workspaceId, request, extra, binding) => acceptPullRequestLifecycle(dependencies, identity, workspaceId, request, extra, "sync" in binding ? { workflowSync: binding.sync } : { workflowCandidate: binding }),
    failedPublications: async (workspaceId, candidate) => (await query(`WORKSPACE#${workspaceId}`, "OPERATION#"))
      .filter((item) => {
        const publication = item.publication as OperationRecord["publication"];
        return item.entityType === "OPERATION" && item.kind === "publish" && TERMINAL.has(item.status as OperationStatus) && item.status !== "SUCCEEDED"
          && publication?.repository === candidate.repositoryId && publication.candidateDigest === candidate.candidateDigest
          && publication.expectedTreeSha === candidate.treeSha;
      }).length,
    cancelRunning: async (identity, workspace, extra) => {
      authorizeWorkspace(identity, workspace);
      const result = await cancelRunningTask(dependencies, workspace, requesterOf(identity), extra);
      return result.outcome === "CANCEL_REQUESTED"
        ? { outcome: "CANCEL_REQUESTED", targetOperationId: result.targetOperationId, cancelOperationId: result.cancelOperationId }
        : { outcome: "NOTHING_RUNNING", ...(result.stopped === undefined ? {} : { stopped: result.stopped }) };
    },
    startClose: (identity, workspace, requestId, extra, discardUnpublished) => startTaskClose(dependencies, identity, workspace, requestId, extra, discardUnpublished),
    deleteCompute: (workspace) => deleteWorkspaceCompute(dependencies, workspace),
    canDeleteCompute: (workspace) => workspace.deploymentMode === "ec2-ebs" && dependencies.deleteEc2Session !== undefined,
    transact: async (items) => {
      await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    },
    channelActivity: async ({ taskId, operationId, threadSubject }) => {
      const marker = await getItem<{ slackUserId?: unknown; name?: unknown }>(dependencies, { pk: `DEVTASK#${taskId}`, sk: `CHANNEL_OPERATION#${operationId}` });
      let waiting = 0;
      if (marker !== undefined && dependencies.slackThreadsTableName !== undefined) {
        try {
          const thread = await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.slackThreadsTableName, Key: { pk: `THREAD#${threadSubject}`, sk: "META" } })) as { Item?: { pendingRequests?: unknown } };
          const pending = Number(thread.Item?.pendingRequests ?? 0);
          // F18: the running turn may still be one of the thread's pending requests, or may have
          // answered already while its operation runs on, so pending - 1 is a floor, not a count.
          waiting = Number.isFinite(pending) ? Math.max(0, pending - 1) : 0;
        } catch (error) {
          console.log(JSON.stringify({ component: "broker", event: "developer.channel_waiting_unread", taskId, error: error instanceof Error ? error.name : "unknown" }));
        }
      }
      return {
        ...(typeof marker?.slackUserId === "string" ? { driver: { slackUserId: marker.slackUserId, ...(typeof marker.name === "string" ? { name: marker.name } : {}) } } : {}),
        waiting,
      };
    },
    channelTurns: async (threadSubject, taskId, limit) => {
      const table = dependencies.turnRecordsTableName;
      if (table === undefined) return [];
      const found: Array<Record<string, unknown>> = [];
      let startKey: Record<string, unknown> | undefined;
      // A thread's records are few (the thread's rate limit caps them); five pages bound the read anyway.
      const MAX_PAGES = 5;
      let pages = 0;
      for (; pages < MAX_PAGES; pages += 1) {
        const response = await dependencies.documentClient.send(new QueryCommand({
          TableName: table,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": `THREAD#${threadSubject}`, ":prefix": "TURN#" },
          ScanIndexForward: false,
          Limit: 100,
          ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
        }));
        // A record whose time is not a timestamp cannot be shown (the view's `at` is one), so it is left out.
        found.push(...(response.Items ?? []).filter((item) => item.taskId === taskId && ChannelTurnSchema.shape.at.safeParse(item.receivedAt).success));
        startKey = response.LastEvaluatedKey;
        if (startKey === undefined || found.length >= limit) break;
      }
      if (pages === MAX_PAGES && startKey !== undefined) {
        // Counts only: the records hold teammates' text.
        console.log(JSON.stringify({ component: "broker", event: "developer.channel_turns_capped", pages, found: found.length }));
      }
      const text = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);
      return found.slice(0, limit).map((item): ChannelTurn => {
        const requester = item.requestedBy as { userId?: unknown } | undefined;
        return {
          // Only who spoke, when, the capped request and the outcome: never the reply or the channel's name (FR-036).
          author: { slackUserId: text(requester?.userId, "unknown"), ...(typeof item.requesterName === "string" ? { name: item.requesterName } : {}) },
          at: text(item.receivedAt, ""),
          // Stored redacted; redacted again here, so a record from an older writer cannot leak.
          request: redactAndCap(text(item.requestText, ""), CHANNEL_TURN_REQUEST_MAX).text,
          outcome: text(item.disposition, "unknown"),
        };
      });
    },
  };
}

/** Stored qualification status only; no probe or qualification service is exposed. */
export function serviceStatusRouteDependencies(dependencies: AwsBrokerDependencies): Pick<DeveloperRouteDependencies, "serviceStatus"> {
 const runtimeCatalogId = dependencies.e2eFeatureRuntimeCatalogId;if (runtimeCatalogId === undefined) return {};
 return { serviceStatus: { runtimeStatus: () => readServiceStatusEvidence({ runtimeCatalogId, read: key => getItem<Record<string, unknown>>(dependencies, key) }) } };
}

/**
 * Wire lane D (MF-4): what Rovara writes to a ticket through a connector is noted in the broker's table before it is sent, so the tracker's event for it is never taken for a member's act.
 * Registered once per handler; the note is the intake engine's to read (`intake/own-writes.ts`).
 */
export function installOwnWriteRecorder(dependencies: Pick<AwsBrokerDependencies, "documentClient" | "tableName">): void {
  registerOwnWriteRecorder((orgId, note) => noteOwnWrite({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now }, orgId, note, (event, fields) => console.log(JSON.stringify({ component: "broker", event, ...fields }))));
}
